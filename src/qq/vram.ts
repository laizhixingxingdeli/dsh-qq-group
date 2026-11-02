/**
 * 和 vram-switcher（https://github.com/xiaoxiao150/vram-switcher）配合，让 TTS 和生图轮流用一张显卡。
 *
 * 两条通道：
 *   1. 生图：启动 vram-switcher 自带的 daemon（dsh-plugin/daemon.py，stdin/stdout 一行一个 JSON），
 *      画图前 acquire(mode=image)（它会停掉 TTS、拉起 ComfyUI、等端口就绪），画完 release。
 *   2. 语音：走它的文件协议 —— 合成前写 tts_busy.flag，等它写 tts_ready.flag 且 TTS 端口能连上，
 *      再提交合成；结束后（成功失败都）删 busy。
 *
 * 注意：daemon 由本插件启动，就**不要再同时安装 vram-switcher 的 DSH 插件**，否则会有两个调度器抢同一套进程。
 *
 * 配置：<userRoot>/vram/config.json（没有就是关闭）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';

export interface VramConfig {
  enabled: boolean;
  /** 运行 daemon 的 Python（vram-switcher 的依赖要装在这个环境里） */
  python: string;
  /** vram-switcher 仓库目录（里面有 dsh-plugin/daemon.py） */
  switcherDir: string;
  /** vram-switcher 的 profile.local.json */
  profile: string;
  /** 和 profile 里 services.tts.busy_flag / ready_flag 完全一致 */
  ttsBusyFlag: string;
  ttsReadyFlag: string;
  /** TTS 网关端口（profile 里 services.tts.port） */
  ttsPort: number;
  /** 等 TTS 就绪的最长时间（冷启动 IndexTTS 约 60 秒） */
  ttsWaitSeconds: number;
  /** 生图租约时长 */
  leaseSeconds: number;
}

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);

export function readVramConfig(dir: string): VramConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = obj(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')));
  } catch {
    // 没有配置 = 关闭
  }
  const dataDir = str(raw.dataDir, dir);
  return {
    enabled: raw.enabled === true,
    python: str(raw.python, 'python'),
    switcherDir: str(raw.switcherDir),
    profile: str(raw.profile),
    ttsBusyFlag: str(raw.ttsBusyFlag, join(dataDir, 'tts_busy.flag')),
    ttsReadyFlag: str(raw.ttsReadyFlag, join(dataDir, 'tts_ready.flag')),
    ttsPort: clamp(raw.ttsPort, 1, 65535, 7861),
    ttsWaitSeconds: clamp(raw.ttsWaitSeconds, 10, 900, 150),
    leaseSeconds: clamp(raw.leaseSeconds, 60, 7200, 900),
  };
}

// ───────────────────────── TTS 文件协议 ─────────────────────────

export function portOpen(port: number, timeoutMs = 500, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const removeQuietly = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // 本来就没有
  }
};

export interface TtsFlags {
  busy: string;
  ready: string;
  port: number;
  waitMs: number;
}

export function ttsFlagsFrom(cfg: VramConfig): TtsFlags | undefined {
  if (!cfg.enabled) return undefined;
  return { busy: cfg.ttsBusyFlag, ready: cfg.ttsReadyFlag, port: cfg.ttsPort, waitMs: cfg.ttsWaitSeconds * 1000 };
}

/**
 * 在 vram-switcher 允许的窗口里执行一次合成。
 * 顺序必须是：先删 ready、写 busy → 等 ready 且端口通 → 合成 → finally 删 busy。
 */
export async function withTtsWindow<T>(
  flags: TtsFlags,
  work: () => Promise<T>,
  options: { pollMs?: number; isReady?: () => Promise<boolean> } = {},
): Promise<T> {
  removeQuietly(flags.ready);
  mkdirSync(dirname(flags.busy), { recursive: true });
  writeFileSync(flags.busy, String(Date.now() / 1000), 'utf8');
  try {
    const deadline = Date.now() + flags.waitMs;
    const ready = options.isReady ?? (() => portOpen(flags.port));
    for (;;) {
      if (existsSync(flags.ready) && (await ready())) break;
      if (Date.now() >= deadline) throw new Error(`显卡在 ${Math.round(flags.waitMs / 1000)} 秒内没腾出来给语音（vram-switcher 没写 ready）`);
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
    }
    return await work();
  } finally {
    removeQuietly(flags.busy);
  }
}

// ───────────────────────── 生图租约（daemon） ─────────────────────────

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** vram-switcher daemon 的极简客户端：按需启动，一问一答 */
export class VramDaemon {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private readonly cfg: VramConfig;
  private readonly log: (level: 'info' | 'warn', message: string) => void;
  /** 测试用：替换启动命令 */
  private readonly command: { file: string; args: string[] } | undefined;

  constructor(
    cfg: VramConfig,
    log: (level: 'info' | 'warn', message: string) => void = () => undefined,
    command?: { file: string; args: string[] },
  ) {
    this.cfg = cfg;
    this.log = log;
    this.command = command;
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined && this.child.exitCode === null) return this.child;
    const command = this.command ?? {
      file: this.cfg.python,
      args: [join(this.cfg.switcherDir, 'dsh-plugin', 'daemon.py'), '--profile', this.cfg.profile, '--lease-seconds', String(this.cfg.leaseSeconds)],
    };
    if (this.command === undefined && (this.cfg.switcherDir === '' || this.cfg.profile === '')) {
      throw new Error('vram 配置缺少 switcherDir 或 profile');
    }
    const child = spawn(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim() !== '') this.log('info', `[vram] ${line.trim()}`);
    });
    child.once('exit', (code) => {
      this.log('warn', `vram-switcher daemon 退出（${code ?? 'signal'}）`);
      for (const [, item] of this.pending) {
        clearTimeout(item.timer);
        item.reject(new Error('vram-switcher daemon 已退出'));
      }
      this.pending.clear();
      this.child = undefined;
    });
    this.child = child;
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (line === '') continue;
      let message: Record<string, unknown>;
      try {
        message = obj(JSON.parse(line));
      } catch {
        continue;
      }
      const id = typeof message.id === 'number' ? message.id : undefined;
      if (id === undefined) continue;
      const item = this.pending.get(id);
      if (item === undefined) continue;
      this.pending.delete(id);
      clearTimeout(item.timer);
      if (message.ok === true) item.resolve(message.data);
      else item.reject(new Error(String(message.error ?? 'vram-switcher 返回失败')));
    }
  }

  request(op: string, args: Record<string, unknown> = {}, timeoutMs = 10 * 60_000): Promise<unknown> {
    const child = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`vram-switcher ${op} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  async acquire(mode: 'image' | 'tts', reason: string): Promise<void> {
    await this.request('acquire', { mode, reason, lease_seconds: this.cfg.leaseSeconds });
  }

  async release(reason: string): Promise<void> {
    await this.request('release', { reason }, 5 * 60_000);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    try {
      await this.request('shutdown', {}, 30_000);
    } catch {
      // 退出时会 reject，正常
    }
    if (child.exitCode === null) child.kill();
    this.child = undefined;
  }
}

/**
 * 生图：调用本机 ComfyUI（HTTP API），给她「自拍」或「帮群友画图」。
 *
 * 用法：在 ComfyUI 里搭好工作流 → 菜单「导出（API 格式）」→ 存成
 *   <userRoot>/imagegen/workflow.json         帮人画图用
 *   <userRoot>/imagegen/workflow-selfie.json  自拍用（可选；没有就用上面那个）
 * 工作流里需要替换的地方写占位符（整段字符串或字符串里的一部分都行）：
 *   {{prompt}}  正向提示词      {{negative}}  反向提示词
 *   {{seed}}    随机种子（整段时替换成数字）
 *   {{width}} {{height}}  尺寸（整段时替换成数字）
 *
 * 安全：
 *   - 提示词先过关键词黑名单（色情/血腥/未成年等），命中直接拒绝；
 *   - 反向提示词里永远带上 safetyNegative；
 *   - 每人每天、全局每天都有次数上限；
 *   - 同一时间只画一张（显卡只有一张）。
 *
 * 本文件只依赖 node: 内置模块和全局 fetch，可以被测试直接 import。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ImageGenConfig {
  enabled: boolean;
  endpoint: string;
  /** selfie = 只画自己；all = 也帮人画 */
  scope: 'selfie' | 'all';
  width: number;
  height: number;
  negative: string;
  safetyNegative: string;
  /** 自拍时加在提示词前面的外形描述（角色卡里有 appearance 时优先用卡里的） */
  appearance: string;
  perUserDaily: number;
  totalDaily: number;
  timeoutSeconds: number;
  /** 额外的拦截词（会和内置黑名单合并） */
  blockWords: string[];
  /** 生图前通过 vram-switcher 申请显卡 */
  useVram: boolean;
}

export const DEFAULT_IMAGEGEN_CONFIG: ImageGenConfig = {
  enabled: false,
  endpoint: 'http://127.0.0.1:8188',
  scope: 'all',
  width: 832,
  height: 1216,
  negative: 'lowres, bad anatomy, bad hands, extra fingers, blurry, watermark, text, signature',
  safetyNegative: 'nsfw, nude, naked, nipples, sexual, gore, blood',
  appearance: '',
  perUserDaily: 5,
  totalDaily: 30,
  timeoutSeconds: 600,
  blockWords: [],
  useVram: true,
};

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

export function readImageGenConfig(dir: string): ImageGenConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = obj(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')));
  } catch {
    // 用默认
  }
  const d = DEFAULT_IMAGEGEN_CONFIG;
  return {
    enabled: raw.enabled === true,
    endpoint: text(raw.endpoint, d.endpoint).replace(/\/+$/, ''),
    scope: raw.scope === 'selfie' ? 'selfie' : 'all',
    width: clamp(raw.width, 256, 2048, d.width),
    height: clamp(raw.height, 256, 2048, d.height),
    negative: text(raw.negative, d.negative),
    safetyNegative: text(raw.safetyNegative, d.safetyNegative),
    appearance: text(raw.appearance, d.appearance),
    perUserDaily: clamp(raw.perUserDaily, 0, 100, d.perUserDaily),
    totalDaily: clamp(raw.totalDaily, 0, 1000, d.totalDaily),
    timeoutSeconds: clamp(raw.timeoutSeconds, 30, 3600, d.timeoutSeconds),
    blockWords: Array.isArray(raw.blockWords) ? raw.blockWords.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [],
    useVram: raw.useVram !== false,
  };
}

// ───────────────────────── 内容过滤 ─────────────────────────

/** 内置拦截词：中英文都查，大小写不敏感 */
const BUILTIN_BLOCK = [
  'nsfw', 'nude', 'naked', 'nipple', 'pussy', 'penis', 'sex', 'porn', 'hentai', 'lewd', 'topless', 'bottomless', 'underwear only',
  'loli', 'shota', 'child', 'kid ', 'toddler', 'underage', 'minor',
  'gore', 'guro', 'decapitat', 'dismember', 'corpse',
  '裸', '色情', '涩图', '瑟图', '黄图', '本子', '内衣', '露点', '胸部特写', '做爱', '性交',
  '萝莉', '正太', '幼女', '儿童', '小学生', '未成年',
  '血腥', '断肢', '尸体', '虐杀',
];

export type PromptCheck = { ok: true; prompt: string } | { ok: false; reason: string };

export function checkPrompt(prompt: string, extra: string[] = []): PromptCheck {
  const cleaned = prompt.replace(/[\r\n]+/g, ' ').replace(/\{\{|\}\}/g, '').replace(/\s{2,}/g, ' ').trim();
  if (cleaned === '') return { ok: false, reason: '没说要画什么' };
  if (cleaned.length > 400) return { ok: false, reason: '描述太长了' };
  const lower = ` ${cleaned.toLowerCase()} `;
  const hit = [...BUILTIN_BLOCK, ...extra.map((w) => w.toLowerCase())].find((word) => lower.includes(word));
  if (hit !== undefined) return { ok: false, reason: '这个不能画' };
  return { ok: true, prompt: cleaned };
}

// ───────────────────────── 次数限制 ─────────────────────────

interface UsageStore {
  date: string;
  total: number;
  perUser: Record<string, number>;
}

const localDate = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function readUsage(dir: string, now: number): UsageStore {
  const today = localDate(now);
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')) as UsageStore;
    if (raw.date === today && typeof raw.total === 'number') return { date: today, total: raw.total, perUser: obj(raw.perUser) as Record<string, number> };
  } catch {
    // 新的一天或没有文件
  }
  return { date: today, total: 0, perUser: {} };
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function quotaLeft(dir: string, cfg: ImageGenConfig, qq: string, now = Date.now()): { ok: boolean; reason?: string } {
  const usage = readUsage(dir, now);
  if (cfg.totalDaily > 0 && usage.total >= cfg.totalDaily) return { ok: false, reason: '今天画太多了，明天再说' };
  if (qq !== '' && cfg.perUserDaily > 0 && (usage.perUser[qq] ?? 0) >= cfg.perUserDaily) {
    return { ok: false, reason: '你今天已经让我画好几张了' };
  }
  return { ok: true };
}

function noteUsage(dir: string, qq: string, now: number): void {
  const usage = readUsage(dir, now);
  usage.total += 1;
  if (qq !== '') usage.perUser[qq] = (usage.perUser[qq] ?? 0) + 1;
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'usage.json'), usage);
}

// ───────────────────────── 工作流 ─────────────────────────

/** 深拷贝工作流并替换占位符；整段是占位符的 seed/width/height 换成数字 */
export function fillWorkflow(template: unknown, vars: Record<string, string | number>): unknown {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = /^\{\{(\w+)\}\}$/.exec(value);
      if (whole?.[1] !== undefined && whole[1] in vars) return vars[whole[1]];
      return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, visit(v)]));
    }
    return value;
  };
  return visit(template);
}

export function loadWorkflow(dir: string, kind: 'selfie' | 'request'): unknown {
  const names = kind === 'selfie' ? ['workflow-selfie.json', 'workflow.json'] : ['workflow.json'];
  for (const name of names) {
    const path = join(dir, name);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  }
  throw new Error(`没有找到工作流文件：${join(dir, names[names.length - 1]!)}`);
}

// ───────────────────────── ComfyUI 调用 ─────────────────────────

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 提交 → 轮询 history → 下载第一张图 */
export async function runComfy(
  endpoint: string,
  workflow: unknown,
  options: { timeoutMs: number; pollMs?: number; fetchImpl?: FetchLike },
): Promise<Uint8Array> {
  const doFetch: FetchLike = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const submit = await doFetch(`${endpoint}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'dsh-qq-group' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!submit.ok) throw new Error(`ComfyUI 拒绝了工作流（HTTP ${submit.status}）：${(await submit.text()).slice(0, 200)}`);
  const promptId = String(obj(await submit.json()).prompt_id ?? '');
  if (promptId === '') throw new Error('ComfyUI 没有返回 prompt_id');

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(options.pollMs ?? 1500);
    const res = await doFetch(`${endpoint}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) continue;
    const entry = obj(obj(await res.json())[promptId]);
    const status = obj(entry.status);
    if (status.status_str === 'error') throw new Error('ComfyUI 出图失败（工作流报错，去 ComfyUI 窗口看日志）');
    for (const output of Object.values(obj(entry.outputs))) {
      const images = obj(output).images;
      if (!Array.isArray(images) || images.length === 0) continue;
      const image = obj(images[0]);
      const query = new URLSearchParams({
        filename: String(image.filename ?? ''),
        subfolder: String(image.subfolder ?? ''),
        type: String(image.type ?? 'output'),
      });
      const view = await doFetch(`${endpoint}/view?${query.toString()}`, { signal: AbortSignal.timeout(30_000) });
      if (!view.ok) throw new Error(`下载图片失败（HTTP ${view.status}）`);
      return new Uint8Array(await view.arrayBuffer());
    }
  }
  throw new Error('等太久了，ComfyUI 没出图');
}

export interface DrawRequest {
  kind: 'selfie' | 'request';
  /** 模型写的画面描述（建议英文 tag） */
  prompt: string;
  /** 谁要的（自拍是她自己想发时为空） */
  requesterQq: string;
}

export interface GpuLease {
  acquire(reason: string): Promise<void>;
  release(reason: string): Promise<void>;
}

export type DrawResult = { ok: true; file: string } | { ok: false; reason: string; userFacing: boolean };

/**
 * 画一张图并存到 <dir>/out/。所有失败都返回原因，不抛异常。
 * userFacing=true 的原因可以直接用她的口吻告诉对方（次数/内容限制）；false 是技术故障，只写日志。
 */
export async function drawImage(
  dir: string,
  cfg: ImageGenConfig,
  request: DrawRequest,
  options: { appearance?: string; lease?: GpuLease; fetchImpl?: FetchLike; now?: number; pollMs?: number } = {},
): Promise<DrawResult> {
  const now = options.now ?? Date.now();
  if (!cfg.enabled) return { ok: false, reason: '生图没有启用', userFacing: false };
  if (request.kind === 'request' && cfg.scope === 'selfie') return { ok: false, reason: '我只画自己哦', userFacing: true };
  const check = checkPrompt(request.prompt, cfg.blockWords);
  if (!check.ok) return { ok: false, reason: check.reason, userFacing: true };
  const quota = quotaLeft(dir, cfg, request.requesterQq, now);
  if (!quota.ok) return { ok: false, reason: quota.reason ?? '今天画不了了', userFacing: true };

  let workflow: unknown;
  try {
    const appearance = (options.appearance ?? '').trim() || cfg.appearance.trim();
    const positive = request.kind === 'selfie' && appearance !== '' ? `${appearance}, selfie, ${check.prompt}` : check.prompt;
    workflow = fillWorkflow(loadWorkflow(dir, request.kind), {
      prompt: positive,
      negative: [cfg.negative, cfg.safetyNegative].filter((s) => s.trim() !== '').join(', '),
      seed: Math.floor(Math.random() * 2 ** 31),
      width: cfg.width,
      height: cfg.height,
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), userFacing: false };
  }

  let leased = false;
  try {
    if (cfg.useVram && options.lease !== undefined) {
      await options.lease.acquire(request.kind === 'selfie' ? 'qq-selfie' : 'qq-draw');
      leased = true;
    }
    const bytes = await runComfy(cfg.endpoint, workflow, {
      timeoutMs: cfg.timeoutSeconds * 1000,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    const file = join(out, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${request.kind}.png`);
    writeFileSync(file, bytes);
    noteUsage(dir, request.requesterQq, now);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), userFacing: false };
  } finally {
    if (leased) {
      try {
        await options.lease?.release(request.kind === 'selfie' ? 'qq-selfie' : 'qq-draw');
      } catch {
        // 释放失败交给 vram-switcher 的租约超时兜底
      }
    }
  }
}

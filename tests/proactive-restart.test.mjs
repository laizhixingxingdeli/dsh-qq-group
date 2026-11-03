import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bridge imports use extensionless TS paths, unlike the standalone helper tests.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
}`), import.meta.url);

const { QqBridge } = await import('../src/qq/bridge.ts');
const { normalizeConfig } = await import('../src/qq/config.ts');
const { readMemoryFile } = await import('../src/qq/memory.ts');

const HOUR = 3600_000;
const MINUTE = 60_000;
const userId = '10001';
const key = `p:${userId}`;
// 和真实配置一样：这个私聊每天最多主动 1 次、两次至少隔 6 小时、不是试运行；
// 关掉安静时段，测试不受时区影响
const config = normalizeConfig({
  privates: {
    [userId]: {
      enabled: true,
      cooldownMs: 0,
      proactive: {
        enabled: true, mode: 'dice', trial: false, intervalMs: 6 * HOUR, cooldownMs: 6 * HOUR, maxPerDay: 1,
        minIdleMs: 5 * MINUTE, quietStart: 0, quietEnd: 0,
      },
    },
  },
});

const realNow = Date.now;
const realRandom = Math.random;
const t0 = new Date(2026, 10, 3, 12, 0, 0).getTime(); // 本地中午，避开跨天
let clock = t0;
Date.now = () => clock;
Math.random = () => 0; // 骰子必中

const root = mkdtempSync(join(tmpdir(), 'qq-proactive-restart-'));
const memoryPath = join(root, 'qq-memory.json');
const fakeLlm = { chat: async () => { throw new Error('test: no model'); } };
const deps = { config, userRoot: root, persona: () => '', log: () => undefined, llm: fakeLlm };

/** 像 start() 一样从磁盘读记忆（不连 QQ） */
function load() {
  const bridge = new QqBridge(deps);
  bridge.memoryPath = memoryPath;
  bridge.memory = readMemoryFile(memoryPath).memory;
  return bridge;
}

/** 启动：恢复状态，并把生成/发送换成只记录「这轮有没有去主动开口」 */
function boot() {
  const bridge = load();
  bridge.running = true;
  bridge.seedGroupStates();
  bridge.proactiveCalls = [];
  bridge.replyTo = async (groupId, _policy, _message, mode) => {
    bridge.proactiveCalls.push(`${groupId}:${mode}`);
  };
  return bridge;
}

/** 跑一轮定时巡检，然后把它排的下一次定时器清掉 */
function tick(bridge) {
  bridge.scheduleTick();
  clearTimeout(bridge.timer);
  bridge.timer = undefined;
}

/** 冷场 7 小时：最后一句是对方 7 小时前说的 */
function seedSilence() {
  rmSync(memoryPath, { force: true });
  load().appendMemoryTurn(key, { role: 'user', name: '小王', text: '晚安', ts: t0 - 7 * HOUR }, userId);
}

const failures = [];
async function scenario(name, run) {
  clock = t0;
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}：${e instanceof Error ? e.message : String(e)}`);
  }
}

try {
  await scenario('刚主动开口过，重启后不该马上又开口', async () => {
    seedSilence();
    const before = load();
    before.sendSegments = async () => ({ ok: true });
    // 走真实的发送路径写下她这条主动开口
    const sent = await before.deliver(key, before.policyOf(key), { messages: ['在干嘛'], action: 'text' }, t0, 'proactive');
    assert.equal(sent, 1);

    clock = t0 + 22 * MINUTE; // 22 分钟后 DSH 重启
    const after = boot();
    tick(after);
    assert.deepEqual(after.proactiveCalls, [], '重启后 22 分钟又主动开口了（每天 1 次、间隔 6 小时都没生效）');
  });

  await scenario('主动开口生成失败，30 秒后不该再试', async () => {
    seedSilence();
    const bridge = boot();
    tick(bridge);
    assert.deepEqual(bridge.proactiveCalls, [`${key}:proactive`], '冷场 7 小时，这一轮应该去主动开口');
    // 替换后的 replyTo 什么都没发出去 = 生成失败
    clock = t0 + 30_000;
    tick(bridge);
    assert.deepEqual(bridge.proactiveCalls, [`${key}:proactive`], '生成失败后 30 秒又去试了一次');
  });
} finally {
  Date.now = realNow;
  Math.random = realRandom;
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`proactive restart tests failed: ${failures.length}`);
  process.exitCode = 1;
} else {
  console.log('proactive restart tests passed');
}

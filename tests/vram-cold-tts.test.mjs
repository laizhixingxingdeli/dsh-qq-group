import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { withTtsWindow } = await import('../src/qq/vram.ts');
const root = mkdtempSync(join(tmpdir(), 'qq-cold-tts-'));
const bridge = Object.create(QqBridge.prototype);
bridge.config = { tts: { provider: 'gpt-sovits' } };
bridge.deps = { userRoot: root, log: () => undefined };
try {
  const vram = join(root, 'vram');
  const daemonDir = join(root, 'dsh-plugin');
  mkdirSync(vram);
  mkdirSync(daemonDir);
  const busy = join(vram, 'tts_busy.flag');
  const ready = join(vram, 'tts_ready.flag');
  const started = join(root, 'daemon-started');
  const ops = join(root, 'daemon-ops');
  writeFileSync(join(daemonDir, 'daemon.py'), `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, 'started');
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(busy)})) fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    }, 10);
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      fs.appendFileSync(${JSON.stringify(ops)}, m.op + '\\n');
      process.stdout.write(JSON.stringify({ id: m.id, ok: true, data: { op: m.op } }) + '\\n');
      if (m.op === 'shutdown') process.exit(0);
    });
  `);
  writeFileSync(join(vram, 'config.json'), JSON.stringify({
    enabled: true, python: process.execPath, switcherDir: root,
    profile: join(root, 'profile.json'), dataDir: vram,
  }));
  const first = bridge.ttsVram();
  assert.ok(first.vram);
  const result = await withTtsWindow({ ...first.vram, waitMs: 1500 }, async () => {
    assert.ok(existsSync(started), 'daemon must start before the first voice request');
    return 'synthesized';
  }, { pollMs: 10, isReady: async () => true });
  assert.equal(result, 'synthesized');
  const daemon = bridge.vramDaemon;
  bridge.ttsVram();
  assert.equal(bridge.vramDaemon, daemon, 'reuse the same daemon');
  assert.ok(!existsSync(busy), 'voice request releases its busy flag');

  // 启动就预热：CosyVoice 冷启动要几十秒到几分钟，不能等第一句语音才开始拉
  const readOps = () => (existsSync(ops) ? readFileSync(ops, 'utf8').split('\n') : []);
  const warm = Object.create(QqBridge.prototype);
  warm.config = { tts: { provider: 'gpt-sovits' } };
  warm.deps = { userRoot: root, log: () => undefined };
  try {
    warm.warmUpTts();
    const deadline = Date.now() + 5000;
    while (!readOps().includes('ensure_tts') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(readOps().includes('ensure_tts'), 'start-up must ask the switcher to bring TTS up');
  } finally {
    await warm.stop();
  }
  const edge = Object.create(QqBridge.prototype);
  edge.config = { tts: { provider: 'edge' } };
  edge.deps = { userRoot: root, log: () => undefined };
  edge.warmUpTts();
  assert.equal(edge.vramDaemon, undefined, 'Edge voice has nothing to warm up');
  console.log('cold TTS daemon regression passed');
} finally {
  await bridge.stop();
  rmSync(root, { recursive: true, force: true });
}

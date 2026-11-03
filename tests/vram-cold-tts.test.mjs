import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(daemonDir, 'daemon.py'), `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, 'started');
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(busy)})) fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    }, 10);
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
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
  console.log('cold TTS daemon regression passed');
} finally {
  await bridge.stop();
  rmSync(root, { recursive: true, force: true });
}

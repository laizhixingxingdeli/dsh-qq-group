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

const userId = '10001';
const key = `p:${userId}`;
// 和线上私聊一样：被要语音必发（requestedVoiceChance 1），平时不随机发语音；能要自拍
const config = normalizeConfig({
  privates: {
    [userId]: { enabled: true, cooldownMs: 0, voiceChance: 0, requestedVoiceChance: 1, selfieEnabled: true, selfieOnRequest: true },
  },
});
const root = mkdtempSync(join(tmpdir(), 'qq-voice-request-'));
const llm = { label: 'fake', chat: async () => ({ ok: true, text: '{"messages":["听好了哦，本鲸今天心情好才勉强发一句的！"],"action":"text"}' }) };
const stickers = { list: () => [], select: () => join(root, '大肥鱼-偷看.jpg'), markUsed: () => undefined };

/** 走真实的 replyTo：模型只回文字，看最后发出去的是语音还是图 */
async function ask(text) {
  const bridge = new QqBridge({ config, userRoot: root, persona: () => '', log: () => undefined, llm, stickers });
  const sent = [];
  const spoken = [];
  bridge.running = true;
  bridge.sendSegments = async (_key, segments) => { sent.push(...segments); return { ok: true }; };
  bridge.speakInGroup = async (_key, said) => { spoken.push(said); return true; };
  bridge.generateThought = async () => '测试';
  bridge.maybeExtractMemoryV3 = async () => undefined;
  bridge.judgeMood = async () => undefined;
  const message = {
    groupId: key, userId, name: '主人', role: 'member', text,
    atSelf: false, callSelf: false, atAll: false, at: Date.now(), messageId: `m-${text}`, hasImage: false, images: [],
  };
  await bridge.replyTo(key, bridge.policyOf(key), message, 'at', Date.now());
  return { spoken, images: sent.filter((segment) => segment.type === 'image') };
}

try {
  // 实测：「你发句语音」被当成要自拍（「你」+「发」），先甩了张表情包，语音也被这个判断挡掉了
  for (const text of ['你发句语音', '你发条语音给我听听', '发条语音']) {
    const { spoken, images } = await ask(text);
    assert.equal(spoken.length, 1, `「${text}」应该发语音`);
    assert.equal(images.length, 0, `「${text}」要的是语音，不该先发自拍`);
  }
  // 「你来…」「你发…」不等于要看她
  assert.equal((await ask('你发什么呆')).images.length, 0, '「你发什么呆」不是要自拍');
  // 真要自拍照发
  assert.equal((await ask('发张自拍看看')).images.length, 1, '要自拍时照发');
  assert.equal((await ask('让我看看你')).images.length, 1, '「看看你」照发');
  console.log('voice request tests passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

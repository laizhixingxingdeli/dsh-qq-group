import assert from 'node:assert/strict';
import { asksForVoice, asksForSong, asksForSelfie, songTitleFrom } from '../src/qq/policy.ts';

assert.equal(asksForVoice('发个语音听听'), true);
assert.equal(asksForVoice('说句话呗'), true);
assert.equal(asksForVoice('用语音回复我'), true);
assert.equal(asksForVoice('说语音给我听听，这是测试'), true);
assert.equal(asksForVoice('今天天气不错'), false);
assert.equal(asksForVoice('语音概率怎么调'), false);
// 量词不止「个/条/段/一句」：实测「你发句语音」没认出来
for (const text of ['你发句语音', '发一条语音', '来两句语音', '发一下语音']) assert.equal(asksForVoice(text), true, text);

// 自拍：要听的不算；「你」只配明确的「看/露/展示/拍」
const keywords = ['尾巴', '自拍', '长什么样'];
for (const text of ['你发句语音', '你来唱首歌', '你发什么呆', '你来干嘛']) assert.equal(asksForSelfie(text, keywords), false, text);
for (const text of ['发张自拍', '让我看看你', '露一下尾巴', '你拍一张给我看', '唱首歌再发张自拍']) assert.equal(asksForSelfie(text, keywords), true, text);

assert.equal(asksForSong('唱首歌'), true);
assert.equal(asksForSong('你唱首歌来听听'), true);
assert.equal(asksForSong('唱首小星星'), true);
assert.equal(asksForSong('点歌'), true);
assert.equal(asksForSong('来一首小星星'), true);
assert.equal(asksForSong('今天吃什么'), false);
assert.equal(songTitleFrom('你唱首歌来听听'), undefined);
assert.equal(songTitleFrom('唱首小星星'), '小星星');
assert.equal(songTitleFrom('来一首晴天'), '晴天');
console.log('voice-trigger: all assertions passed');

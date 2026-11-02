import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  parseCardJson,
  parseCardFile,
  extractPngCard,
  selectLore,
  characterBlockFor,
  effectiveAffinity,
  tierFor,
  formatCharacterPersona,
  importCharacter,
  loadCharacter,
  revealedFor,
  DEFAULT_CHARACTER_CONFIG,
} from '../src/qq/character.ts';
import { parseReplyPlan } from '../src/qq/llm.ts';

const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '大肥鱼',
    description: '{{char}} 是一只嘴硬的蓝色鲸鱼娘，正在和 {{user}} 聊天。',
    personality: '傲娇、嘴硬心软',
    scenario: '住在 QQ 群里',
    mes_example: '<START>\n{{user}}: 大肥鱼\n{{char}}: 谁是大肥鱼',
    first_mes: '干嘛',
    extensions: {
      dafeiyu: {
        groupMaxAffinity: 50,
        newRevealTurns: 2,
        appearance: '1girl, blue hair, whale tail',
        tiers: [
          { min: -100, name: '讨厌', tone: '冷淡' },
          { min: 0, name: '路人', tone: '普通' },
          { min: 40, name: '朋友', tone: '放松' },
          { min: 70, name: '心腹', tone: '撒娇' },
        ],
      },
    },
    character_book: {
      entries: [
        { id: 1, name: '爱吃', keys: ['吃', '饭'], content: '最爱吃虾米', insertion_order: 1 },
        { id: 2, name: '怕黑', keys: [], constant: true, content: '其实怕黑', extensions: { dafeiyu: { minAffinity: 40, lockedHint: '不承认自己怕黑' } } },
        { id: 3, name: '身世', keys: ['家人', '妈妈'], content: '她是从深海逃出来的', extensions: { dafeiyu: { minAffinity: 70, privateOnly: true, lockedHint: '被问到家人就岔开话题' } } },
        { id: 4, name: '停用', keys: ['吃'], content: '不该出现', enabled: false },
      ],
    },
  },
};

const ctx = (over) => ({ isPrivate: false, speakerQq: '20002', speakerName: '小王', affinity: 0, recentText: '', ...over });

// 1. 解析 V2：字段、世界书、档位、扩展
{
  const c = parseCardJson(card);
  assert.equal(c.name, '大肥鱼');
  assert.equal(c.lore.length, 4);
  assert.equal(c.lore[1].minAffinity, 40);
  assert.equal(c.lore[2].privateOnly, true);
  assert.equal(c.groupMaxAffinity, 50);
  assert.equal(tierFor(c, 55).name, '朋友');
  assert.equal(tierFor(c, -50).name, '讨厌');
  assert.equal(c.appearance, '1girl, blue hair, whale tail');
  const persona = formatCharacterPersona(c, '小王');
  assert.ok(persona.includes('大肥鱼 是一只嘴硬') && persona.includes('和 小王 聊天'), '{{char}}/{{user}} 要替换');
  // V1 也能读
  assert.equal(parseCardJson({ name: 'V1卡', description: 'x' }).name, 'V1卡');
  assert.throws(() => parseCardJson({ description: '没名字' }));
}

// 2. 门槛：好感不够看不到正文，只给 lockedHint；私密条目群里永远看不到
{
  const c = parseCardJson(card);
  const low = selectLore(c, ctx({ affinity: 10, recentText: '你怕黑吗，你家人呢' }));
  assert.ok(!low.open.some((e) => e.content.includes('怕黑')), '好感 10 不能说怕黑');
  assert.ok(low.locked.some((e) => e.lockedHint === '不承认自己怕黑'));
  assert.ok(!low.open.some((e) => e.content.includes('深海')));

  const groupHigh = selectLore(c, ctx({ affinity: 90, recentText: '你家人呢' }));
  assert.ok(groupHigh.open.some((e) => e.name === '怕黑'), '群里好感够就能说怕黑');
  assert.ok(!groupHigh.open.some((e) => e.name === '身世'), '私密条目群里不能说');
  assert.equal(effectiveAffinity(c, ctx({ affinity: 90 })), 50, '群里有效好感被封顶');

  const privHigh = selectLore(c, ctx({ isPrivate: true, affinity: 90, recentText: '随便聊聊' }));
  assert.ok(privHigh.open.some((e) => e.name === '身世'), '私聊好感 90 解锁身世（有门槛的解锁后常驻）');

  const keyword = selectLore(c, ctx({ recentText: '今天吃什么' }));
  assert.ok(keyword.open.some((e) => e.name === '爱吃'), '无门槛条目按关键词触发');
  assert.ok(!keyword.open.some((e) => e.name === '停用'), '停用的条目不出现');
  assert.ok(!selectLore(c, ctx({ recentText: '在吗' })).open.some((e) => e.name === '爱吃'), '没提到关键词就不带');

  const proactive = selectLore(c, ctx({ speakerQq: '', affinity: 90 }));
  assert.ok(!proactive.open.some((e) => e.minAffinity !== undefined), '主动开口（没有对象）不说有门槛的事');
}

// 3. 披露按人记录：新解锁先提示 N 次，之后转为已知；别人仍然是秘密
{
  const dir = mkdtempSync(join(tmpdir(), 'char-'));
  try {
    const c = parseCardJson(card);
    const cfg = DEFAULT_CHARACTER_CONFIG;
    const b1 = characterBlockFor(dir, c, cfg, ctx({ isPrivate: true, affinity: 45 }), 1000);
    assert.ok(b1.includes('最近更信任小王') && b1.includes('其实怕黑'), '第一次解锁要提示找机会说');
    characterBlockFor(dir, c, cfg, ctx({ isPrivate: true, affinity: 45 }), 2000);
    const b3 = characterBlockFor(dir, c, cfg, ctx({ isPrivate: true, affinity: 45 }), 3000);
    assert.ok(!b3.includes('最近更信任') && b3.includes('其实怕黑'), '提示 2 次之后转成已知设定');
    assert.deepEqual(revealedFor(dir, '20002'), ['2']);
    assert.deepEqual(revealedFor(dir, '30003'), [], '阿杰没解锁过');
    const other = characterBlockFor(dir, c, cfg, ctx({ isPrivate: true, speakerQq: '30003', speakerName: '阿杰', affinity: 5, recentText: '怕黑吗' }), 4000);
    assert.ok(!other.includes('其实怕黑') && other.includes('不承认自己怕黑'), '对阿杰仍然是秘密');
    assert.ok(!other.includes('深海'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4. PNG 卡：tEXt(chara, base64) 和 iTXt(ccv3, 压缩) 都能读
{
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
    return out;
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const iend = chunk('IEND', Buffer.alloc(0));
  const text = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(card)).toString('base64'), 'latin1')]);
  const png = Buffer.concat([sig, ihdr, chunk('tEXt', text), iend]);
  assert.equal(parseCardFile(new Uint8Array(png)).name, '大肥鱼');

  const v3 = { spec: 'chara_card_v3', data: { ...card.data, name: '大肥鱼V3' } };
  const itxt = Buffer.concat([Buffer.from('ccv3\0', 'latin1'), Buffer.from([1, 0]), Buffer.from('\0\0', 'latin1'), deflateSync(Buffer.from(JSON.stringify(v3)))]);
  const png3 = Buffer.concat([sig, ihdr, chunk('tEXt', text), chunk('iTXt', itxt), iend]);
  assert.equal(parseCardJson(extractPngCard(new Uint8Array(png3))).name, '大肥鱼V3', 'ccv3 优先于 chara');
  assert.throws(() => extractPngCard(new Uint8Array(Buffer.concat([sig, ihdr, iend]))));

  const dir = mkdtempSync(join(tmpdir(), 'char-'));
  try {
    importCharacter(dir, new Uint8Array(png));
    assert.equal(loadCharacter(dir)?.name, '大肥鱼', '导入后统一存成 card.json');
    assert.ok(JSON.parse(readFileSync(join(dir, 'card.json'), 'utf8')).spec === 'chara_card_v2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5. 回复计划里的 draw 字段
{
  const plan = parseReplyPlan(JSON.stringify({ thought: 'x', messages: ['等我画一下'], action: 'text', draw: { kind: 'selfie', prompt: 'waving, park' } }));
  assert.deepEqual(plan.draw, { kind: 'selfie', prompt: 'waving, park' });
  const other = parseReplyPlan(JSON.stringify({ messages: ['好'], action: 'text', draw: { kind: 'xx', prompt: 'a cat' } }));
  assert.equal(other.draw?.kind, 'request', '未知 kind 当成帮人画');
  assert.equal(parseReplyPlan(JSON.stringify({ messages: ['好'], action: 'text', draw: { prompt: '' } })).draw, undefined);
}

console.log('character tests passed');

/**
 * 酒馆（SillyTavern）角色卡 + 按好感度逐步「披露」设定。
 *
 * 支持的卡：
 *   - V1：顶层 name/description/personality/scenario/first_mes/mes_example
 *   - V2：{ spec: "chara_card_v2", data: {...} }（含 character_book 世界书）
 *   - V3：{ spec: "chara_card_v3", data: {...} }（按 V2 字段读取，多出来的字段忽略）
 *   - PNG 卡：tEXt/iTXt 里的 `chara`（V2，base64 JSON）或 `ccv3`（V3）
 *
 * 好感度披露（本项目的扩展，写在卡的 extensions.dafeiyu 和世界书条目的 extensions.dafeiyu 里，
 * 酒馆本身会忽略这些字段，所以同一张卡在酒馆里也能正常用）：
 *
 *   卡级 data.extensions.dafeiyu:
 *     tiers:        [{ min: -100, name: "疏远", tone: "…" }, { min: 0, … }, …]  好感档位与语气（覆盖插件内置五档）
 *     groupMaxAffinity: 60   群聊里按「发言人好感」解锁时的上限（防止在一群人面前说出最私密的事）
 *     newRevealTurns:   3    新解锁的设定，接下来几次回复里提示她「找机会自然地说出来」
 *     appearance:       "…"  外形描述（英文 tag），给自拍生图用
 *
 *   世界书条目 entry.extensions.dafeiyu:
 *     minAffinity:  40     对这个人的好感 ≥ 40 才能说
 *     privateOnly:  true   只在私聊里说
 *     lockedHint:   "…"    还没解锁时给她的提示（例如「被问到家人会岔开话题」）
 *
 * 披露是按人记录的：对小王说过的秘密，小王以后再聊就是「已经告诉过 TA 了」；
 * 对阿杰没说过，就仍然是秘密。记录在 <userRoot>/character/revealed.json。
 *
 * 本文件只依赖 node: 内置模块，可以被测试直接 import。
 */
import { inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ───────────────────────── 数据结构 ─────────────────────────

export interface AffinityTier {
  min: number;
  name: string;
  tone: string;
}

export interface LoreEntry {
  id: string;
  name: string;
  keys: string[];
  secondaryKeys: string[];
  selective: boolean;
  constant: boolean;
  caseSensitive: boolean;
  content: string;
  order: number;
  enabled: boolean;
  /** 好感门槛（undefined = 不设门槛） */
  minAffinity?: number;
  privateOnly: boolean;
  lockedHint?: string;
}

export interface CharacterCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  examples: string;
  systemPrompt: string;
  postHistory: string;
  creatorNotes: string;
  tags: string[];
  lore: LoreEntry[];
  tiers: AffinityTier[];
  groupMaxAffinity: number;
  newRevealTurns: number;
  appearance: string;
  /** 卡原文（导出/重新导入时保持原样） */
  raw: unknown;
}

export const DEFAULT_TIERS: AffinityTier[] = [
  { min: -100, name: '反感', tone: '回复冷淡、简短，不主动帮忙、不撒娇；但不要辱骂或阴阳。' },
  { min: -29, name: '疏远', tone: '客气、克制，少开玩笑。' },
  { min: 0, name: '普通', tone: '正常交流，不额外热情。' },
  { min: 30, name: '朋友', tone: '温和、愿意接话、适度关心，可以开玩笑。' },
  { min: 60, name: '亲近', tone: '明显更耐心、更关心，可以撒娇、吐槽、有一点偏爱，但不要无脑讨好。' },
];

// ───────────────────────── 解析 ─────────────────────────

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '') : [];
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function parseTiers(value: unknown): AffinityTier[] {
  if (!Array.isArray(value)) return DEFAULT_TIERS;
  const tiers = value
    .map((item) => obj(item))
    .filter((item) => typeof item.min === 'number' && str(item.tone).trim() !== '')
    .map((item) => ({
      min: Math.max(-100, Math.min(100, num(item.min, 0))),
      name: str(item.name).trim().slice(0, 12) || '未命名',
      tone: str(item.tone).trim().slice(0, 300),
    }))
    .sort((a, b) => a.min - b.min);
  return tiers.length === 0 ? DEFAULT_TIERS : tiers;
}

function parseLore(book: unknown): LoreEntry[] {
  const entries = obj(book).entries;
  const list = Array.isArray(entries) ? entries : Object.values(obj(entries)); // 有的卡把 entries 存成对象
  return list
    .map((value, index): LoreEntry | undefined => {
      const item = obj(value);
      const content = str(item.content).trim();
      if (content === '') return undefined;
      const ext = obj(obj(item.extensions).dafeiyu);
      const minAffinity = typeof ext.minAffinity === 'number' ? Math.max(-100, Math.min(100, ext.minAffinity)) : undefined;
      const rawId = item.id ?? item.uid ?? index;
      return {
        id: String(rawId).replace(/[^\w.-]/g, '').slice(0, 40) || String(index),
        name: (str(item.name) || str(item.comment)).trim().slice(0, 40) || `条目${index + 1}`,
        keys: strList(item.keys ?? item.key),
        secondaryKeys: strList(item.secondary_keys ?? item.keysecondary),
        selective: item.selective === true,
        constant: item.constant === true,
        caseSensitive: item.case_sensitive === true,
        content: content.slice(0, 2000),
        order: num(item.insertion_order ?? item.order, 100),
        enabled: item.enabled !== false && item.disable !== true,
        ...(minAffinity === undefined ? {} : { minAffinity }),
        privateOnly: ext.privateOnly === true,
        ...(str(ext.lockedHint).trim() === '' ? {} : { lockedHint: str(ext.lockedHint).trim().slice(0, 200) }),
      };
    })
    .filter((entry): entry is LoreEntry => entry !== undefined);
}

/** 解析 JSON 形式的角色卡（V1/V2/V3） */
export function parseCardJson(input: unknown): CharacterCard {
  const root = obj(input);
  const spec = str(root.spec);
  const data = spec === 'chara_card_v2' || spec === 'chara_card_v3' ? obj(root.data) : root;
  const name = str(data.name).trim();
  if (name === '') throw new Error('角色卡没有 name 字段');
  const ext = obj(obj(data.extensions).dafeiyu);
  return {
    name: name.slice(0, 40),
    description: str(data.description).trim(),
    personality: str(data.personality).trim(),
    scenario: str(data.scenario).trim(),
    firstMessage: str(data.first_mes).trim(),
    examples: str(data.mes_example).trim(),
    systemPrompt: str(data.system_prompt).trim(),
    postHistory: str(data.post_history_instructions).trim(),
    creatorNotes: str(data.creator_notes).trim(),
    tags: strList(data.tags),
    lore: parseLore(data.character_book),
    tiers: parseTiers(ext.tiers),
    groupMaxAffinity: Math.max(-100, Math.min(100, num(ext.groupMaxAffinity, 60))),
    newRevealTurns: Math.max(0, Math.min(20, Math.round(num(ext.newRevealTurns, 3)))),
    appearance: str(ext.appearance).trim().slice(0, 600),
    raw: input,
  };
}

/** 从 PNG 的文本块里取出角色卡 JSON（优先 ccv3，其次 chara） */
export function extractPngCard(bytes: Uint8Array): unknown {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || sig.some((b, i) => bytes[i] !== b)) throw new Error('不是 PNG 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Record<string, string> = {};
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) break;
    const body = bytes.subarray(start, end);
    if (type === 'tEXt') {
      const zero = body.indexOf(0);
      if (zero > 0) found[new TextDecoder('latin1').decode(body.subarray(0, zero))] = new TextDecoder('latin1').decode(body.subarray(zero + 1));
    } else if (type === 'iTXt') {
      // keyword\0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
      const zero = body.indexOf(0);
      if (zero > 0) {
        const keyword = new TextDecoder('latin1').decode(body.subarray(0, zero));
        const compressed = body[zero + 1] === 1;
        let cursor = zero + 3;
        cursor = body.indexOf(0, cursor) + 1; // languageTag
        cursor = body.indexOf(0, cursor) + 1; // translatedKeyword
        if (cursor > 0) {
          const raw = body.subarray(cursor);
          found[keyword] = new TextDecoder('utf-8').decode(compressed ? inflateSync(raw) : raw);
        }
      }
    }
    if (type === 'IEND') break;
    offset = end + 4; // 跳过 CRC
  }
  const payload = found.ccv3 ?? found.chara;
  if (payload === undefined) throw new Error('PNG 里没有角色卡数据（找不到 chara / ccv3 文本块）');
  const text = /^[A-Za-z0-9+/=\s]+$/.test(payload) ? Buffer.from(payload, 'base64').toString('utf8') : payload;
  return JSON.parse(text) as unknown;
}

/** 按文件内容解析（PNG 或 JSON） */
export function parseCardFile(bytes: Uint8Array): CharacterCard {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return parseCardJson(extractPngCard(bytes));
  return parseCardJson(JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown);
}

// ───────────────────────── 存储 ─────────────────────────

export interface CharacterConfig {
  enabled: boolean;
  /** true = 用角色卡代替插件里的人设卡；false = 角色卡追加在人设卡后面 */
  replacePersona: boolean;
  /** 世界书每轮最多注入多少字 */
  loreChars: number;
  /** 扫描最近几条消息来匹配世界书关键词 */
  scanTurns: number;
}

export const DEFAULT_CHARACTER_CONFIG: CharacterConfig = {
  enabled: true,
  replacePersona: true,
  loreChars: 2500,
  scanTurns: 8,
};

export function readCharacterConfig(dir: string): CharacterConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = obj(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')));
  } catch {
    // 用默认
  }
  return {
    enabled: raw.enabled !== false,
    replacePersona: raw.replacePersona !== false,
    loreChars: Math.max(200, Math.min(20_000, Math.round(num(raw.loreChars, DEFAULT_CHARACTER_CONFIG.loreChars)))),
    scanTurns: Math.max(1, Math.min(50, Math.round(num(raw.scanTurns, DEFAULT_CHARACTER_CONFIG.scanTurns)))),
  };
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/** 读当前角色卡：<dir>/card.json 或 <dir>/card.png；没有返回 undefined */
export function loadCharacter(dir: string): CharacterCard | undefined {
  for (const name of ['card.json', 'card.png']) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    return parseCardFile(new Uint8Array(readFileSync(path)));
  }
  return undefined;
}

/** 导入一张卡：校验能解析后，统一存成 card.json（原卡内容不改） */
export function importCharacter(dir: string, bytes: Uint8Array): CharacterCard {
  const card = parseCardFile(bytes);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, 'card.json'), `${JSON.stringify(card.raw, null, 2)}\n`);
  return card;
}

// ───────────────────────── 披露记录 ─────────────────────────

/** qq → 条目 id → 记录 */
type RevealStore = Record<string, Record<string, { unlockedAt: number; nudges: number }>>;

function readReveals(dir: string): RevealStore {
  try {
    const raw = obj(JSON.parse(readFileSync(join(dir, 'revealed.json'), 'utf8')));
    return raw as RevealStore;
  } catch {
    return {};
  }
}

function writeReveals(dir: string, store: RevealStore): void {
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, 'revealed.json'), `${JSON.stringify(store, null, 2)}\n`);
}

// ───────────────────────── 每轮注入 ─────────────────────────

export function tierFor(card: CharacterCard | undefined, affinity: number): AffinityTier {
  const tiers = card?.tiers ?? DEFAULT_TIERS;
  let current = tiers[0] ?? DEFAULT_TIERS[0]!;
  for (const tier of tiers) if (affinity >= tier.min) current = tier;
  return current;
}

const fill = (text: string, charName: string, userName: string): string =>
  text.replace(/\{\{char\}\}|<BOT>/gi, charName).replace(/\{\{user\}\}|<USER>/gi, userName);

/** 角色卡主体（代替/追加人设）：描述、性格、场景、示范对话、系统提示 */
export function formatCharacterPersona(card: CharacterCard, userName: string): string {
  const parts: string[] = [];
  if (card.systemPrompt !== '') parts.push(fill(card.systemPrompt, card.name, userName));
  parts.push(`【你扮演的角色：${card.name}】`);
  if (card.description !== '') parts.push(fill(card.description, card.name, userName));
  if (card.personality !== '') parts.push(`【性格】\n${fill(card.personality, card.name, userName)}`);
  if (card.scenario !== '') parts.push(`【背景】\n${fill(card.scenario, card.name, userName)}`);
  if (card.examples !== '') {
    parts.push(
      `【说话示范（照这个感觉说，不要照抄）】\n${fill(card.examples.replace(/<START>/gi, '———'), card.name, userName)}`,
    );
  }
  if (card.postHistory !== '') parts.push(fill(card.postHistory, card.name, userName));
  return parts.join('\n\n');
}

export interface LoreContext {
  /** 会话是不是私聊 */
  isPrivate: boolean;
  /** 当前发言人 QQ（没有就是空串） */
  speakerQq: string;
  speakerName: string;
  /** 发言人对她的好感 */
  affinity: number;
  /** 用来匹配关键词的近期文本（最近几条消息 + 正在说的话） */
  recentText: string;
}

function keyHit(entry: LoreEntry, text: string): boolean {
  const hay = entry.caseSensitive ? text : text.toLowerCase();
  const has = (key: string): boolean => hay.includes(entry.caseSensitive ? key : key.toLowerCase());
  if (!entry.keys.some(has)) return false;
  if (entry.selective && entry.secondaryKeys.length > 0) return entry.secondaryKeys.some(has);
  return true;
}

/** 这个场合下的「有效好感」：群里不超过 groupMaxAffinity，没人说话（主动开口）按 0 算 */
export function effectiveAffinity(card: CharacterCard, ctx: LoreContext): number {
  if (ctx.speakerQq === '') return Math.min(0, ctx.affinity);
  return ctx.isPrivate ? ctx.affinity : Math.min(ctx.affinity, card.groupMaxAffinity);
}

export interface LoreSelection {
  /** 可以说的条目 */
  open: LoreEntry[];
  /** 这次刚解锁、要提示她找机会说的 */
  fresh: LoreEntry[];
  /** 被关键词触发、但还没解锁的（只给 lockedHint） */
  locked: LoreEntry[];
}

/**
 * 选世界书条目。门槛判断只看「有效好感」和场合，模型看不到没解锁的正文，
 * 所以不可能提前说漏。
 */
export function selectLore(card: CharacterCard, ctx: LoreContext): LoreSelection {
  const affinity = effectiveAffinity(card, ctx);
  const result: LoreSelection = { open: [], fresh: [], locked: [] };
  for (const entry of [...card.lore].sort((a, b) => a.order - b.order)) {
    if (!entry.enabled) continue;
    const triggered = entry.constant || keyHit(entry, ctx.recentText);
    const gated = entry.minAffinity !== undefined || entry.privateOnly;
    const allowed = (entry.minAffinity === undefined || affinity >= entry.minAffinity) && (!entry.privateOnly || ctx.isPrivate);
    if (allowed) {
      // 有门槛的条目：一旦解锁就常驻（她知道自己可以对 TA 说了）；无门槛条目按关键词触发
      if (gated || triggered) result.open.push(entry);
    } else if (triggered && entry.lockedHint !== undefined) {
      result.locked.push(entry);
    }
  }
  return result;
}

/**
 * 生成角色卡相关的整段注入（世界书 + 好感档位 + 披露提示），并更新披露记录。
 * 返回空串表示没有角色卡或未启用。
 */
export function characterBlockFor(
  dir: string,
  card: CharacterCard,
  cfg: CharacterConfig,
  ctx: LoreContext,
  now = Date.now(),
): string {
  const selection = selectLore(card, ctx);
  const reveals = readReveals(dir);
  const mine = ctx.speakerQq === '' ? undefined : (reveals[ctx.speakerQq] ??= {});
  let changed = false;
  for (const entry of selection.open) {
    const gated = entry.minAffinity !== undefined || entry.privateOnly;
    if (!gated || mine === undefined) continue;
    const record = mine[entry.id];
    if (record === undefined) {
      mine[entry.id] = { unlockedAt: now, nudges: 0 };
      changed = true;
    }
    const current = mine[entry.id]!;
    if (current.nudges < card.newRevealTurns) {
      selection.fresh.push(entry);
      current.nudges += 1;
      changed = true;
    }
  }
  if (changed) writeReveals(dir, reveals);

  const user = ctx.speakerName || '对方';
  const lines: string[] = [];
  let budget = cfg.loreChars;
  const push = (text: string): boolean => {
    if (text.length > budget) return false;
    lines.push(text);
    budget -= text.length;
    return true;
  };
  const known = selection.open.filter((entry) => !selection.fresh.includes(entry));
  if (known.length > 0) {
    push('【你的设定（可以自然流露；有门槛的是你已经愿意对 TA 说的事）】');
    for (const entry of known) if (!push(`- ${entry.name}：${fill(entry.content, card.name, user)}`)) break;
  }
  if (selection.fresh.length > 0) {
    push(`【你最近更信任${user}了：下面这些以前没说过，可以找个自然的时机慢慢说出来，一次别全说完，也可以只露一点】`);
    for (const entry of selection.fresh) if (!push(`- ${entry.name}：${fill(entry.content, card.name, user)}`)) break;
  }
  if (selection.locked.length > 0) {
    push('【还没到能说的关系：被问到也别说，按下面的方式应对】');
    for (const entry of selection.locked) push(`- ${entry.lockedHint ?? '岔开话题'}`);
  }
  return lines.length === 0 ? '' : `\n${lines.join('\n')}`;
}

/** 某人已解锁的条目（给管理/调试用） */
export function revealedFor(dir: string, qq: string): string[] {
  return Object.keys(readReveals(dir)[qq] ?? {});
}

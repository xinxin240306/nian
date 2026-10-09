/** 系统内联小黄豆（微信风格 [微笑]）— 后端提示词与校验 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const MANIFEST_PATH = path.join(__dirname, '..', 'assets', 'inline-emoji', 'out', 'manifest.json');

let _codes = null;
let _codeSet = null;

function loadBeanCodes() {
  if (_codes) return _codes;
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    _codes = (Array.isArray(raw?.emojis) ? raw.emojis : [])
      .map((e) => String(e?.code || '').trim())
      .filter(Boolean);
  } catch (e) {
    console.warn('[inline-emoji] manifest load failed', e.message);
    _codes = [];
  }
  _codeSet = new Set();
  for (const c of _codes) {
    _codeSet.add(c);
    _codeSet.add(c.toLowerCase());
  }
  return _codes;
}

function isKnownBean(code) {
  loadBeanCodes();
  const key = String(code || '').trim();
  if (!key) return false;
  return _codeSet.has(key) || _codeSet.has(key.toLowerCase());
}

function extractBeanCodes(text) {
  const found = [];
  String(text || '').replace(/\[([^\[\]\n]{1,20})\]/g, (_, code) => {
    if (isKnownBean(code)) found.push(String(code).trim());
    return _;
  });
  return found;
}

function textHasBean(text) {
  return extractBeanCodes(text).length > 0;
}

/** 系统指令类方括号，勿当小黄豆处理 */
function isDirectiveBracket(code) {
  const c = String(code || '').trim();
  if (!c) return true;
  if (c.includes('|')) return true;
  // 位置开闭标签必须保留，否则会变成只剩「[/位置]」的文字气泡
  if (/^(?:\/?\s*(?:发送\s*)?位置)$/i.test(c)) return true;
  if (/^(表情|表情包|发送表情包|引用|撤回|撤回上一条|文字|语音|配图|图片|场景状态)/.test(c)) return true;
  if (/^https?:/i.test(c)) return true;
  return false;
}

function latestUserMessageHasBean(characterId) {
  if (!characterId) return false;
  const row = db.prepare(
    `SELECT content, type FROM messages WHERE character_id=? AND role='user' AND COALESCE(is_dream,0)=0 ORDER BY id DESC LIMIT 1`
  ).get(characterId);
  if (!row || row.type === 'emoji' || row.type === 'image' || row.type === 'video') return false;
  return textHasBean(row.content);
}

/** @deprecated 隔轮冷却已废弃；保留导出以免旧引用报错 */
function lastAiTurnHadBean() {
  return false;
}

function normalizeBeanCode(code) {
  const key = String(code || '').trim();
  if (!key) return '';
  const hit = (_codes || []).find((c) => c === key || c.toLowerCase() === key.toLowerCase());
  return hit || key;
}

/** 正文里是否出现「同一小黄豆连续 ≥3 个」（强情绪三连） */
function hasSameBeanTriple(text) {
  const codes = extractBeanCodes(text).map(normalizeBeanCode);
  for (let i = 0; i <= codes.length - 3; i++) {
    if (codes[i] && codes[i] === codes[i + 1] && codes[i + 1] === codes[i + 2]) return true;
  }
  return false;
}

/** 去掉小黄豆标记后的纯文字，用于判断语气 */
function plainTextWithoutBeans(text) {
  loadBeanCodes();
  return String(text || '')
    .replace(/\[([^\[\]\n]{1,20})\]/g, (full, code) => {
      if (isDirectiveBracket(code)) return full;
      if (isKnownBean(code)) return '';
      return full;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 平淡接话 / 短确认：通常不该夹小黄豆 */
function isFlatBeanProse(plain) {
  const t = String(plain || '').trim();
  if (!t) return true;
  if (t.length <= 14 && /^(嗯+|恩+|好的?|好哒?|哦+|噢+|喔+|行|收到|明白|知道了?|在|在的?|ok|OK|Okay|嗯嗯|那行|可以|没事|没问题)[!！。.~～…]*$/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * 从人设推断小黄豆表达倾向。
 * reserved=高冷/内敛极少用；expressive=活泼外向可多用；mixed=傲娇等；neutral=默认。
 */
function beanPersonaTone(char) {
  const blob = [
    char?.personality,
    char?.emotion_style,
    char?.behavior,
    char?.language_style,
    char?.background,
    char?.intro,
  ].map((s) => String(s || '')).join('\n');
  if (!blob.trim()) return 'neutral';
  const reserved = /高冷|冷淡|冷漠|淡漠|内敛|话少|寡言|克制|含蓄|慢热|沉稳|深沉|阴郁|理性|冷静|佛系|钝感|不苟言笑|面瘫|禁欲|清冷|疏离|少言|惜字|闷骚|口是心非|不善表达|不爱直说/.test(blob);
  const expressive = /活泼|开朗|外向|话多|粘人|黏人|碎嘴|热情|撒娇|软萌|戏精|逗比|搞笑|乐子|元气|话痨|外放|大大咧咧|爽朗|爱笑|打趣|俏皮|甜|粘糊|温柔|柔和|体贴/.test(blob);
  if (reserved && !expressive) return 'reserved';
  if (expressive && !reserved) return 'expressive';
  if (reserved && expressive) return 'mixed';
  return 'neutral';
}

function resolveBeanChar(characterId, charHint) {
  if (charHint && (charHint.personality || charHint.emotion_style || charHint.behavior
    || charHint.language_style || charHint.background || charHint.intro)) {
    return charHint;
  }
  if (!characterId) return charHint || null;
  try {
    return db.prepare(
      `SELECT personality, emotion_style, behavior, language_style, background, intro FROM characters WHERE id=?`
    ).get(characterId) || charHint || null;
  } catch {
    return charHint || null;
  }
}

/**
 * 本句语气强度：0 无 / 1 轻 / 2 中 / 3 强。
 * 人设门控用这个，而不是一刀切隔轮。
 */
function beanCueStrength(text) {
  const plain = plainTextWithoutBeans(text);
  if (!plain || isFlatBeanProse(plain)) return 0;

  let strength = 0;
  // 强：连写标点 / 破防口语
  if (/[！?]{2,}|[!]{2,}|[?]{2,}/.test(plain)) strength = Math.max(strength, 3);
  if (/卧槽|我操|我靠|崩溃|绝了|气死|笑死|哭死|救命|真的假的|不是吧|天哪|天啊|过分了?|离谱/.test(plain)) {
    strength = Math.max(strength, 3);
  }
  // 中：笑声哭腔、明确情绪词
  if (/(哈){2,}|(呵){2,}|(呜){2,}|(哼){2,}|(嘿){2,}|(嘻){2,}|(噗)+/.test(plain)) {
    strength = Math.max(strength, 2);
  }
  if (/好看|好笑|搞笑|可爱|喜欢|爱你|想你|讨厌|烦死|无语|服了|震惊|惊喜|委屈|难过|开心|高兴|激动|害羞|尴尬|紧张|害怕|心疼|感动|羡慕|嫉妒|吃醋|撒娇|求求|拜托|好家伙|太好了|太棒|抱抱|亲亲|么么|比心|唉|哎/.test(plain)) {
    strength = Math.max(strength, 2);
  }
  if (/[～~…]{2,}/.test(plain)) strength = Math.max(strength, 2);
  // 轻：短句语气助词
  if (plain.length <= 16 && /[啊呀吧呢嘛啦噢哦喔诶欸][！？!?～~.。…]*$/.test(plain)) {
    strength = Math.max(strength, 1);
  }
  return strength;
}

function textWarrantsBean(text, char = null) {
  const need = beanMinStrengthForPersona(beanPersonaTone(char));
  return beanCueStrength(text) >= need;
}

/** 该人设至少要多强的语气才允许夹豆 */
function beanMinStrengthForPersona(tone) {
  if (tone === 'reserved') return 3;
  if (tone === 'mixed') return 2;
  if (tone === 'expressive') return 1;
  return 2; // neutral：比纯外向略严，避免人人都像戏精
}

function personaBeanPromptLine(tone, surface) {
  if (surface !== 'chat' && surface !== 'memo' && surface !== 'moments') {
    return '有明确语气再夹。';
  }
  if (tone === 'reserved') {
    return '你人设偏克制/高冷/内敛：小黄豆极少用。日常接话、陈述、轻玩笑都不要夹；只有明显破防、被戳到、强情绪时才偶尔夹 1 个。禁止习惯性带豆，也禁止三连刷屏（除非极度崩溃）。';
  }
  if (tone === 'expressive') {
    return '你人设偏外放/活泼：可按语气自然夹小黄豆，有情绪、玩笑、撒娇时用；平淡确认、干巴陈述仍不要发。不要句句都带。';
  }
  if (tone === 'mixed') {
    return '你人设口是心非/别扭：小黄豆少用、点到为止；真动气或难得软下来时才夹，不要甜腻刷屏。';
  }
  return '只看这句话本身的语气：有情绪、玩笑、撒娇、吐槽、惊讶等才夹；平淡确认、陈述不要发。频率跟性格走，不要隔一轮习惯性带豆。';
}

/**
 * 校验并收敛 AI 正文里的小黄豆：
 * - 未知名称去掉
 * - 默认一条最多 2 个；情绪强烈时允许同一小黄豆连写最多 3 个
 * - 聊天：按「本句语气强度 × 人设」决定是否保留；用户本轮发了豆可跟；强情绪同码三连保留
 */
function sanitizeInlineBeans(text, {
  characterId = null,
  char = null,
  forceStrip = false,
  skipCooldown = false,
  allowSameTriple = true,
  maxBeans = 2,
} = {}) {
  let t = String(text || '');
  if (!t) return t;
  loadBeanCodes();

  const profile = resolveBeanChar(characterId, char);
  const tone = beanPersonaTone(profile);
  const baseMax = Number.isFinite(maxBeans) && maxBeans > 0 ? Math.floor(maxBeans) : 2;
  // 高冷默认一条最多 1 个
  const personaMax = tone === 'reserved' ? Math.min(baseMax, 1)
    : tone === 'expressive' ? baseMax
      : Math.min(baseMax, 2);
  const hardMax = allowSameTriple ? Math.max(personaMax, 3) : personaMax;
  const sameTriple = allowSameTriple && hasSameBeanTriple(t);
  // 高冷禁止三连，除非强度已经拉满且同码三连——仍允许但 personaMax 限制日常；三连走 hardMax
  const allowTripleNow = allowSameTriple && sameTriple && tone !== 'reserved';

  let stripAll = !!forceStrip;
  // skipCooldown：随手记/朋友圈等仍做人设门控，只是不额外加压
  if (!stripAll && !allowTripleNow) {
    if (sameTriple && tone === 'reserved') {
      // 高冷：三连降成最多保留 1 个（后面 kept 逻辑用 personaMax）
    }
    const userEcho = characterId && latestUserMessageHasBean(characterId);
    if (!userEcho) {
      const need = skipCooldown
        ? Math.min(beanMinStrengthForPersona(tone), 2)
        : beanMinStrengthForPersona(tone);
      if (beanCueStrength(t) < need) stripAll = true;
    }
  }

  const keptNorms = [];
  const keepCap = (sameTriple && tone !== 'reserved') ? hardMax : personaMax;
  t = t.replace(/\[([^\[\]\n]{1,20})\]/g, (full, code) => {
    if (isDirectiveBracket(code)) return full;
    if (!isKnownBean(code)) {
      // 短中文/英文词当成瞎编的表情名去掉；其它方括号保留
      if (/^[\u4e00-\u9fffA-Za-z0-9_]{1,12}$/.test(code)) return '';
      return full;
    }
    if (stripAll) return '';
    const norm = normalizeBeanCode(code);
    if (keptNorms.length >= keepCap) return '';
    if (keptNorms.length >= personaMax) {
      // 第 personaMax+1 个起：仅允许与已有全部相同的强情绪三连（高冷除外）
      if (tone === 'reserved' || !allowSameTriple || !keptNorms.every((c) => c === norm)) return '';
    }
    keptNorms.push(norm);
    return `[${norm}]`;
  });

  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}

/**
 * @param {{ surface?: 'chat'|'memo'|'moments', char?: object }} [opts]
 */
function buildInlineBeanPromptSection(opts = {}) {
  const codes = loadBeanCodes();
  if (!codes.length) return '';
  const list = codes.join('、');
  const surface = opts.surface || 'chat';
  const tone = beanPersonaTone(opts.char || null);
  const toneLine = personaBeanPromptLine(tone, surface);
  const tripleLine = tone === 'reserved'
    ? '【强情绪】你极少用小黄豆。真震惊、急了可以用「？？？」「！！！」，不要三连刷豆，也不要用连写标点撑平常话。'
    : '【强情绪】震惊、崩溃、难以置信、气炸、狂喜时，可用「？？？」「！！！」或同一小黄豆三连，写在那句最冲的话后面。日常闲聊禁止三连，也不要用连写标点撑场面。';
  return `【小黄豆】句子里可夹 [名称]，如「好啊[微笑]」。必须用下列名称，禁止编造：${list}
夹在字里当语气，不要单独一条只发豆。日常一条最多 ${tone === 'reserved' ? '1 个' : '1～2 个'}。${toneLine}
${tripleLine}
这与表情包不同：表情包写 [表情]库内描述[/表情]。`;
}

module.exports = {
  loadBeanCodes,
  isKnownBean,
  extractBeanCodes,
  textHasBean,
  hasSameBeanTriple,
  plainTextWithoutBeans,
  isFlatBeanProse,
  beanCueStrength,
  beanPersonaTone,
  beanMinStrengthForPersona,
  textWarrantsBean,
  latestUserMessageHasBean,
  lastAiTurnHadBean,
  sanitizeInlineBeans,
  buildInlineBeanPromptSection,
};

/**
 * 画像 / 自我认知：按大类收卡片。
 * 相关联的观察收进同一张卡，称呼统一，重复意义只留一条。角色本名写成 TA。
 */
const db = require('./db');
const {
  normalizeNicknames,
  primaryOf,
  inferLastAddressToUser,
} = require('./nickname-helper');

const MAX_FACTS_PER_CARD = 6;
const MAX_CARDS_PER_MAJOR = 12;
const NOTE_MAX = 36;

const IMP_SUBCATS = {
  性格: ['脾气', '气质', '相处时'],
  情绪: ['生气时', '难过时', '压力下'],
  想法: ['在意', '思维方式', '自我评价'],
  喜好: ['饮食', '兴趣', '审美', '厌恶'],
  习惯: ['作息', '相处', '生活'],
  不擅长: ['技能', '场面', '情绪'],
  人际关系: ['家人', '朋友', '亲密'],
  样子: ['外形', '穿搭'],
  其他: ['其他'],
};

const SELF_SUBCATS = {
  性格: ['脾气', '气质', '相处时'],
  行为习惯: ['作息', '相处', '生活'],
  喜好: ['饮食', '兴趣', '审美', '厌恶'],
  经历: ['相处变化', '自我看法', '往事'],
  变化: ['相处变化', '自我看法'],
};

const SUBCAT_RE = {
  饮食: /吃|喝|酒|茶|咖啡|菜|辣|甜|口味|美食|饮料|饭|餐|零食|青梅/,
  兴趣: /看|玩|听|游戏|剧|电影|书|歌|音乐|运动|画画|摄影|番/,
  审美: /好看|漂亮|颜|风格|设计|颜色|审美|搭配/,
  厌恶: /讨厌|不喜欢|受不了|忌|恶心|不好喝|不好吃|嫌/,
  作息: /熬夜|早起|睡|作息|夜猫|失眠|晚睡/,
  相处: /回消息|撒娇|冷战|先开口|粘|距离|聊天|约会/,
  生活: /收拾|做饭|出门|宅|打扫|迟到/,
  技能: /不会|不擅长|搞不定|学不会|苦手/,
  场面: /人多|社交场合|演讲|打电话/,
  情绪: /想太多|内耗|玻璃心|情绪/,
  脾气: /脾气|急|火|别扭|嘴硬|好强/,
  气质: /内向|外向|慢热|高冷|温柔|感性|理性/,
  相处时: /对人|熟了|不熟|黏人|独立/,
  生气时: /生气|发火|发脾气|吼|摔/,
  难过时: /难过|委屈|哭|低落/,
  压力下: /压力|焦虑|紧张|崩溃/,
  在意: /在意|介意|放不下|怕被/,
  思维方式: /想很多|想太多|胡思乱想|钻牛角尖|想不通/,
  自我评价: /觉得自己|总觉得|老觉得|不够/,
  家人: /爸|妈|家里|家人|父母/,
  朋友: /朋友|闺蜜|兄弟|同事|同学/,
  亲密: /对象|前任|恋爱|喜欢的人/,
  外形: /头发|发型|眼镜|身高|身材|脸/,
  穿搭: /穿|衣服|黑|打扮|妆/,
  相处变化: /变得|开始会|更愿意|认识后|在一起后/,
  自我看法: /觉得自己|我是|我其实/,
  往事: /以前|从前|那时候|小时候/,
  其他: /./,
};

const TOPIC_FAMILIES = [
  { key: '酒', re: /酒|青梅酒|啤酒|红酒|白酒|威士忌|清酒|梅子酒/ },
  { key: '茶', re: /茶|奶茶|咖啡|拿铁|美式|手冲|美式咖啡/ },
  { key: '辣', re: /辣|麻辣|火锅|川菜|香锅|辣椒/ },
  { key: '甜', re: /甜|甜食|蛋糕|奶茶|糖|甜点|巧克力/ },
  { key: '饭', re: /吃|饿|外卖|晚饭|午饭|早饭|干饭|点餐|炒菜|做饭|下厨|牛腩|番茄/ },
  { key: '猫', re: /猫|喵|橘猫|饭团/ },
  { key: '狗', re: /狗|汪|小狗/ },
  { key: '游戏', re: /游戏|打游戏|开黑|手游|开黑|氪金/ },
  { key: '剧', re: /剧|电影|番|追剧|小说|综艺/ },
  { key: '睡', re: /睡|熬夜|早起|失眠|作息|夜猫|困/ },
  { key: '雨', re: /雨|下雨|雨天|阴天/ },
  { key: '考', re: /考试|备考|N2|听力|单词|刷题/ },
  { key: '搬', re: /搬家|新公寓|电梯|搬家公司/ },
  { key: '画', re: /画|画画|绘画|素描|水彩/ },
  { key: '海', re: /海|海边|潜水|游泳/ },
];

function topicFamilyKeys(text) {
  const t = String(text || '');
  return TOPIC_FAMILIES.filter((f) => f.re.test(t)).map((f) => f.key);
}

function familiesOverlap(a, b, { forMerge = false } = {}) {
  // 「饭」太宽，吃饭相关的两句都会命中；合并去重只用细族（辣/酒/猫…）
  const skip = forMerge ? new Set(['饭']) : new Set();
  const kb = new Set(topicFamilyKeys(b).filter((k) => !skip.has(k)));
  return topicFamilyKeys(a).some((k) => !skip.has(k) && kb.has(k));
}

/** 喜好极性：同向才算重复句，反向（喜欢酒 / 觉得酒不好喝）收进同一张卡但不合并成一句 */
function factPolarity(text) {
  const t = String(text || '');
  if (/不喜欢|不爱|讨厌|受不了|忌|怕|不会|不擅长|搞不定|不好喝|不好吃|不吃|不喝|苦手/.test(t)) return 'neg';
  if (/(喜欢|爱吃|爱喝|爱看|爱玩|爱听|擅长|会)/.test(t) && !/不(喜欢|爱|会|擅长)/.test(t)) return 'pos';
  return 'other';
}

function looksLikeEventFact(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.length > 28) return true;
  if (/(因为|所以|然后|后来|那天|有一次|某天|提到|说起|聊了|讨论了|答应了|约定了|想起了)/.test(s)) return true;
  if (/\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日/.test(s)) return true;
  if (/(今天|昨天|刚才|这会儿|刚刚).{0,6}(说|做|去|来|哭|吵|加班)/.test(s)) return true;
  return false;
}

function ensureClusterColumns() {
  const alters = [
    `ALTER TABLE char_impressions ADD COLUMN subcategory TEXT DEFAULT ''`,
    `ALTER TABLE char_impressions ADD COLUMN related_facts TEXT DEFAULT '[]'`,
    `ALTER TABLE char_impressions ADD COLUMN note TEXT DEFAULT ''`,
    `ALTER TABLE char_impressions ADD COLUMN topic_key TEXT DEFAULT ''`,
    `ALTER TABLE char_self_views ADD COLUMN subcategory TEXT DEFAULT ''`,
    `ALTER TABLE char_self_views ADD COLUMN related_facts TEXT DEFAULT '[]'`,
    `ALTER TABLE char_self_views ADD COLUMN note TEXT DEFAULT ''`,
    `ALTER TABLE char_self_views ADD COLUMN topic_key TEXT DEFAULT ''`,
  ];
  for (const sql of alters) {
    try { db.run(sql); } catch { /* exists */ }
  }
}

function parseJsonArr(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  try {
    const p = JSON.parse(raw || '[]');
    return Array.isArray(p) ? p.map((x) => String(x || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function collapseCharRuns(text) {
  return String(text || '').replace(/(.)\1{3,}/g, '$1$1');
}

function collapseCallStutter(text, call) {
  let s = collapseCharRuns(text);
  const c = String(call || '').trim();
  if (!c || c.length < 2) return s;
  let prev;
  do {
    prev = s;
    s = s.split(c + c).join(c);
    for (let i = 1; i < c.length; i++) {
      const prefix = c.slice(0, i);
      if (prefix && s.includes(prefix + c)) s = s.split(prefix + c).join(c);
    }
  } while (s !== prev);
  return s;
}

function stripFactCore(text) {
  return String(text || '')
    .replace(/\s/g, '')
    .replace(/（\?）$/, '')
    .replace(/\(\?\)$/, '')
    .replace(/[的了呢吗啊呀吧]/g, '')
    .replace(/^(用户|对方|TA|他|她|我|你)/, '')
    .replace(/^[\u4e00-\u9fff]{2,8}(?=喜欢|爱|讨厌|不|觉得|认为|习惯|总是|经常|容易)/, '')
    .replace(/^(其实|也|会)/, '')
    .replace(/^(不)?(喜欢|爱吃|爱喝|爱看|爱玩|爱听|爱|讨厌|不爱|觉得|认为|习惯于?|总是|经常|容易)/, '')
    .replace(/^(很|比较|有点|特别|超级)/, '')
    .replace(/的人$/, '');
}

function factQuality(text) {
  const t = String(text || '');
  let score = 20 - Math.min(16, t.length);
  if (!/(.)\1{3,}/.test(t)) score += 8;
  if (!/用户|旅人|对方/.test(t)) score += 2;
  return score;
}

function factsSimilar(a, b) {
  const x0 = collapseCharRuns(String(a || '').replace(/\s/g, '').replace(/（\?）$/, '').replace(/[的了呢吗啊呀吧]/g, ''));
  const y0 = collapseCharRuns(String(b || '').replace(/\s/g, '').replace(/（\?）$/, '').replace(/[的了呢吗啊呀吧]/g, ''));
  if (!x0 || !y0) return false;
  if (x0 === y0) return true;
  if (x0.length >= 4 && y0.length >= 4 && (x0.includes(y0) || y0.includes(x0))) return true;
  const x = stripFactCore(x0);
  const y = stripFactCore(y0);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return true;
  // 同话题族 + 同极性 = 同一观察换了说法（喜欢吃辣 / 爱吃火锅）
  const pa = factPolarity(a);
  const pb = factPolarity(b);
  if (pa !== 'other' && pa === pb && familiesOverlap(a, b, { forMerge: true })) return true;
  const ka = topicKeyOf(a);
  const kb = topicKeyOf(b);
  if (ka && kb && ka === kb && pa === pb && pa !== 'other') return true;
  return false;
}

function uniqueFacts(list) {
  const out = [];
  for (const raw of list || []) {
    const s = collapseCharRuns(String(raw || '').replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim());
    if (s.length < 2) continue;
    if (looksLikeEventFact(s) && s.length > 22) continue;
    const idx = out.findIndex((x) => factsSimilar(x, s));
    if (idx >= 0) {
      if (factQuality(s) > factQuality(out[idx])) out[idx] = s;
      continue;
    }
    out.push(s);
  }
  return out.slice(0, MAX_FACTS_PER_CARD);
}

function cardFacts(row) {
  return uniqueFacts([row?.content, ...parseJsonArr(row?.related_facts)]);
}

function guessSubcategory() {
  return '';
}

function topicKeyOf(text) {
  const t = String(text || '');
  for (const fam of TOPIC_FAMILIES) {
    if (fam.re.test(t)) return fam.key;
  }
  const core = t
    .replace(/（\?）\s*$/, '')
    .replace(/^(用户|对方|TA|他|她|我|你|[^\s]{1,6})(其实|也|会|不)?/, '')
    .replace(/^(不)?(喜欢|爱吃|爱喝|爱看|爱玩|爱听|爱|讨厌|不爱|觉得|认为|习惯于?|总是|经常|容易)/, '')
    .replace(/^(很|比较|有点|特别|超级)/, '')
    .replace(/的人$/, '')
    .trim();
  if (core.length >= 2 && core.length <= 8) return core.slice(0, 8);
  const m = t.match(/[\u4e00-\u9fff]{2,6}/);
  return m ? m[0].slice(0, 8) : '';
}

function loadRecentAssistant(charId) {
  try {
    return db.prepare(
      `SELECT role, content FROM messages WHERE character_id=? AND role='assistant'
       AND is_dream=0 AND recalled=0 ORDER BY id DESC LIMIT 16`
    ).all(charId);
  } catch {
    return [];
  }
}

function unifiedUserCall(char, settings = {}, recentHistory = []) {
  const userName = String(settings.username || '').trim();
  const charName = String(char?.name || '').trim();
  const stored = primaryOf(normalizeNicknames(char?.nicknames).toUser);
  const settled = inferLastAddressToUser(recentHistory, { userName, charName });
  if (stored && stored !== charName) return stored;
  if (settled && settled !== charName) return settled;
  if (userName) return userName;
  return '你';
}

function userAliases(char, settings, primary) {
  const set = new Set(['用户', '对方', '旅人']);
  const userName = String(settings.username || '').trim();
  if (userName && userName !== primary) set.add(userName);
  for (const i of normalizeNicknames(char?.nicknames).toUser) {
    if (i.text && i.text !== primary) set.add(i.text);
  }
  return [...set].filter((a) => a && a.length >= 2).sort((a, b) => b.length - a.length);
}

function charNameList(ctx = {}) {
  return [ctx.charName, ctx.charDisplayName]
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 2)
    .sort((a, b) => b.length - a.length)
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

function replaceProtected(text, find, repl, protect) {
  if (!find || find === repl) return text;
  const token = '\u0000P\u0000';
  let s = String(text || '');
  if (protect) s = s.split(protect).join(token);
  s = s.split(find).join(repl);
  if (protect) s = s.split(token).join(protect);
  return s;
}

function escapeReg(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteVoice(text, ctx = {}) {
  const { voice, userCall, aliases = [] } = ctx;
  let s = collapseCallStutter(String(text || '').trim(), userCall);
  if (!s) return '';
  for (const name of charNameList(ctx)) {
    s = s.split(name).join('TA');
  }
  for (const a of aliases) {
    if (!a || a === userCall) continue;
    s = replaceProtected(s, a, userCall, userCall);
  }
  s = collapseCallStutter(s, userCall);
  if (voice === 'user-portrait') {
    s = s.replace(/^(我自己|我|你|他|她|用户|对方|旅人)(?![的么们])/, userCall || '');
    s = collapseCallStutter(s, userCall);
    if (userCall && !s.includes(userCall) && !/^TA/.test(s)) {
      const overlap = [...userCall].some((_, i) => i > 0 && s.startsWith(userCall.slice(i)));
      if (!overlap) s = `${userCall}${s}`;
    }
    s = collapseCallStutter(s, userCall);
  } else {
    s = s.replace(/^TA(?![的么们])/, '我');
    s = s.replace(/^(自己|角色)(?=[\u4e00-\u9fff]|$)/, '我');
    if (!/^我/.test(s) && !(userCall && s.includes(userCall))) {
      s = `我${s}`;
    }
  }
  return collapseCallStutter(s.replace(/\s{2,}/g, ' ').trim(), userCall);
}

function rewriteNote(note, ctxOrVoice) {
  const ctx = typeof ctxOrVoice === 'object' && ctxOrVoice ? ctxOrVoice : { voice: ctxOrVoice };
  let s = String(note || '').replace(/^(TA|我)\s*[：:]\s*/, '').trim().slice(0, NOTE_MAX);
  if (!s) return '';
  for (const name of charNameList(ctx)) {
    s = s.split(name).join('TA');
  }
  s = s.replace(/^(我)(?![的么们])/, 'TA');
  return collapseCallStutter(s, ctx.userCall).slice(0, NOTE_MAX);
}

function cardsRelated(a, b) {
  if (!a || !b) return false;
  const ka = String(a.topic_key || topicKeyOf(a.content || '')).trim();
  const kb = String(b.topic_key || topicKeyOf(b.content || '')).trim();
  if (ka && kb && ka === kb) return true;
  const fa = cardFacts(a);
  const fb = cardFacts(b);
  for (const x of fa) {
    for (const y of fb) {
      if (factsSimilar(x, y)) return true;
      if (topicKeyOf(x) && topicKeyOf(x) === topicKeyOf(y)) return true;
    }
  }
  let kwsA = [];
  let kwsB = [];
  try { kwsA = JSON.parse(a.keywords || '[]'); } catch { kwsA = []; }
  try { kwsB = JSON.parse(b.keywords || '[]'); } catch { kwsB = []; }
  const GENERIC = /^(喜欢|讨厌|习惯|经常|总是|觉得|认为|用户|对方|自己)$/;
  const setB = new Set((kwsB || []).map((k) => String(k).toLowerCase()));
  if ((kwsA || []).some((k) => {
    const s = String(k || '').trim();
    return s.length >= 2 && !GENERIC.test(s) && setB.has(s.toLowerCase());
  })) return true;
  return false;
}

function factFitsCard(card, fact) {
  const probe = { content: fact, related_facts: '[]', topic_key: topicKeyOf(fact), keywords: '[]' };
  return cardsRelated(card, probe);
}

function writeCardFacts(table, id, facts, extra = {}) {
  const uniq = uniqueFacts(facts);
  if (!uniq.length) return;
  const content = uniq[0];
  const related = JSON.stringify(uniq.slice(1));
  const note = extra.note != null ? String(extra.note).slice(0, NOTE_MAX) : undefined;
  const sub = extra.subcategory != null ? extra.subcategory : undefined;
  const topic = extra.topic_key != null ? extra.topic_key : topicKeyOf(uniq.join('、'));
  const kws = extra.keywords != null ? JSON.stringify(extra.keywords) : undefined;
  if (table === 'char_self_views') {
    db.prepare(
      `UPDATE char_self_views SET content=?, related_facts=?, topic_key=?, subcategory=COALESCE(?, subcategory), note=COALESCE(?, note), keywords=COALESCE(?, keywords), updated_at=datetime('now') WHERE id=?`
    ).run(content, related, topic, sub ?? null, note ?? null, kws ?? null, id);
  } else {
    db.prepare(
      `UPDATE char_impressions SET content=?, related_facts=?, topic_key=?, subcategory=COALESCE(?, subcategory), note=COALESCE(?, note), keywords=COALESCE(?, keywords) WHERE id=?`
    ).run(content, related, topic, sub ?? null, note ?? null, kws ?? null, id);
  }
}

function listCards(table, charId) {
  ensureClusterColumns();
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE character_id=? ORDER BY id ASC`).all(charId);
  } catch {
    return [];
  }
}

function voiceForTable(table) {
  return table === 'char_self_views' ? 'self' : 'user-portrait';
}

function wouldAbsorb(table, charId, major, fact) {
  const ctx = getVoiceCtx(charId);
  ctx.voice = voiceForTable(table);
  const rewritten = rewriteVoice(fact, ctx);
  const cards = listCards(table, charId).filter((r) => String(r.category || '') === major);
  return cards.some((c) => cardFacts(c).some((f) => factsSimilar(f, rewritten)) || factFitsCard(c, rewritten));
}

function getVoiceCtx(charId) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  const hist = loadRecentAssistant(charId);
  const userCall = unifiedUserCall(char, settings, hist);
  const aliases = userAliases(char, settings, userCall);
  return {
    char,
    settings,
    userCall,
    aliases,
    charName: String(char?.name || '').trim(),
    charDisplayName: String(char?.display_name || '').trim(),
    voice: null,
  };
}

function upsertPortraitCard({
  table,
  charId,
  major,
  subcategory,
  fact,
  facts,
  note = '',
  keywords = [],
  confirmed = 1,
  extra = {},
}) {
  ensureClusterColumns();
  const ctx = getVoiceCtx(charId);
  ctx.voice = voiceForTable(table);
  const incoming = uniqueFacts((Array.isArray(facts) && facts.length ? facts : [fact]).map((f) => rewriteVoice(f, ctx)))
    .filter((f) => f.length >= 2 && !looksBrokenFact(f));
  if (!incoming.length) return 'skip';
  const rewritten = incoming[0];
  const sub = '';
  const topic = topicKeyOf(incoming.join('、')) || topicKeyOf(rewritten);
  const cards = listCards(table, charId).filter((r) => String(r.category || '') === major);
  const already = cards.find((c) => incoming.every((f) => cardFacts(c).some((x) => factsSimilar(x, f))));
  const noteText = rewriteNote(note, ctx);
  if (already) {
    if (noteText && !String(already.note || '').trim()) {
      writeCardFacts(table, already.id, cardFacts(already), {
        note: noteText,
        subcategory: already.subcategory || sub,
        topic_key: already.topic_key || topic,
      });
    }
    return 'dup';
  }
  const host = extra.forceBundle
    ? cards.find((c) => incoming.some((f) => factFitsCard(c, f) || cardFacts(c).some((x) => factsSimilar(x, f)))) || null
    : cards.find((c) => incoming.some((f) => factFitsCard(c, f)));
  if (host) {
    const prevLen = cardFacts(host).length;
    const next = uniqueFacts([...cardFacts(host), ...incoming]);
    writeCardFacts(table, host.id, next, {
      subcategory: host.subcategory || sub,
      topic_key: host.topic_key || topic,
      note: noteText || host.note || '',
      keywords: keywords.length ? keywords : undefined,
    });
    return next.length === prevLen ? 'dup' : 'appended';
  }
  const related = JSON.stringify(incoming.slice(1));
  const kws = JSON.stringify(Array.isArray(keywords) ? keywords.slice(0, 8) : []);
  if (table === 'char_self_views') {
    const source = extra.source || 'lived';
    const strength = extra.strength != null ? extra.strength : 0.45;
    db.prepare(
      `INSERT INTO char_self_views (character_id, content, category, subcategory, keywords, source, auto_generated, confirmed, strength, evidence_ids, related_facts, note, topic_key, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
    ).run(
      charId, rewritten, major, sub, kws, source,
      extra.auto_generated ? 1 : 0, confirmed ? 1 : 0, strength,
      JSON.stringify(extra.evidence_ids || []),
      related, noteText, topic
    );
  } else {
    const strength = extra.strength != null ? extra.strength : (confirmed ? 0.65 : 0.45);
    db.prepare(
      `INSERT INTO char_impressions (character_id, content, keywords, category, subcategory, auto_generated, confirmed, strength, evidence_ids, related_facts, note, topic_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      charId, rewritten, kws, major, sub, extra.auto_generated != null ? (extra.auto_generated ? 1 : 0) : 1,
      confirmed ? 1 : 0, strength, JSON.stringify(extra.evidence_ids || []),
      related, noteText, topic
    );
  }
  const ids = db.prepare(`SELECT id FROM ${table} WHERE character_id=? AND category=? ORDER BY id DESC`).all(charId, major);
  if (ids.length > MAX_CARDS_PER_MAJOR) {
    const drop = ids.slice(MAX_CARDS_PER_MAJOR).map((r) => r.id);
    db.prepare(`DELETE FROM ${table} WHERE id IN (${drop.map(() => '?').join(',')})`).run(...drop);
  }
  return 'inserted';
}

function compactPortraitCards(charId, table) {
  ensureClusterColumns();
  const ctx = getVoiceCtx(charId);
  ctx.voice = voiceForTable(table);
  const rows = listCards(table, charId);
  const used = new Set();
  for (const row of rows) {
    if (used.has(row.id)) continue;
    const group = [row];
    used.add(row.id);
    for (const other of rows) {
      if (used.has(other.id)) continue;
      if (String(row.category || '') !== String(other.category || '')) continue;
      if (!cardsRelated(row, other)) continue;
      group.push(other);
      used.add(other.id);
    }
    const facts = uniqueFacts(group.flatMap(cardFacts).map((f) => rewriteVoice(f, ctx)));
    const note = group.map((g) => rewriteNote(g.note, ctx)).find(Boolean) || '';
    const topic = group.map((g) => g.topic_key).find(Boolean) || topicKeyOf(facts[0] || '');
    writeCardFacts(table, row.id, facts, { subcategory: '', topic_key: topic, note });
    for (const extra of group.slice(1)) {
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(extra.id);
    }
  }
}

function looksBrokenFact(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/(.)\1{3,}/.test(s)) return true;
  if (/^[，,。.!！？、\s]+|[，,。.!！？、\s]+$/.test(s) && s.length < 8) return true;
  if (/[的地得与和是在了着过]$/.test(s) && s.length <= 10) return true;
  if (/^(喜欢|讨厌|习惯|经常|总是|觉得|是个|比较)$/.test(s)) return true;
  if (/…$|\.{2,}$|——$|-$/.test(s)) return true;
  if (looksLikeEventFact(s)) return true;
  return false;
}

function normalizeTidyCategory(table, cat) {
  const c = String(cat || '').trim().slice(0, 12);
  if (table === 'char_self_views') {
    if (['性格', '行为习惯', '喜好', '经历', '变化'].includes(c)) return c;
    if (c === '习惯') return '行为习惯';
    return '';
  }
  const allowed = ['性格', '情绪', '想法', '喜好', '习惯', '不擅长', '人际关系', '样子', '其他'];
  if (allowed.includes(c)) return c;
  if (c === '情绪反应') return '情绪';
  if (c === '爱好') return '喜好';
  if (c === '在意') return '想法';
  return '';
}

function factGroundedInSources(fact, sources) {
  const f = String(fact || '').trim();
  if (!f) return false;
  for (const src of sources || []) {
    if (factsSimilar(f, src)) return true;
    const a = stripFactCore(f);
    const b = stripFactCore(src);
    if (a && b && (a.includes(b) || b.includes(a))) return true;
  }
  return false;
}

function polishFactsAgainstSources(proposed, sources, ctx) {
  const out = [];
  for (const raw of proposed || []) {
    const rewritten = rewriteVoice(raw, ctx);
    if (!rewritten || rewritten.length < 2) continue;
    if (factGroundedInSources(rewritten, sources)) {
      out.push(rewritten.slice(0, 36));
      continue;
    }
    // 改写飘了：从同源里挑一条质量更好的补上
    const hit = (sources || []).find((s) => factsSimilar(rewritten, s) || stripFactCore(s).includes(stripFactCore(rewritten)));
    if (hit) out.push(rewriteVoice(hit, ctx).slice(0, 36));
  }
  // 若模型没给出可用句，至少保留源句（并修口吃）
  if (!out.length) {
    for (const s of sources || []) {
      const r = rewriteVoice(s, ctx);
      if (r.length >= 2) out.push(r.slice(0, 36));
    }
  }
  return uniqueFacts(out);
}

function applyLocalVoicePolish(charId, table) {
  const ctx = getVoiceCtx(charId);
  ctx.voice = voiceForTable(table);
  let polished = 0;
  let dropped = 0;
  for (const row of listCards(table, charId)) {
    const facts = uniqueFacts(cardFacts(row).map((f) => rewriteVoice(f, ctx)).filter((f) => f.length >= 2 && !looksBrokenFact(f)));
    if (!facts.length) {
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
      dropped += 1;
      continue;
    }
    const note = rewriteNote(row.note, ctx);
    const prev = cardFacts(row).join('\n');
    const next = facts.join('\n');
    if (prev !== next || String(row.note || '') !== note) polished += 1;
    writeCardFacts(table, row.id, facts, {
      subcategory: '',
      topic_key: topicKeyOf(facts[0] || ''),
      note,
    });
  }
  return { polished, dropped };
}

function parseTidyOps(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    if (!o || !Array.isArray(o.ops)) return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * 打扫画像 / 自我：先规则压重，再让模型合并语义重复、修好断句。
 * callChatAPIComplete(settings, system, user, kind) 由调用方注入。
 */
async function tidyPortraitWithAI(charId, table, { callChatAPIComplete, settings } = {}) {
  if (table !== 'char_impressions' && table !== 'char_self_views') {
    throw new Error('unsupported table');
  }
  ensureClusterColumns();
  const before = listCards(table, charId).length;
  if (!before) {
    return { ok: true, before: 0, after: 0, edited: 0, deleted: 0, merged: 0, summary: '没有可整理的卡片' };
  }

  compactPortraitCards(charId, table);
  const local = applyLocalVoicePolish(charId, table);

  let rows = listCards(table, charId);
  const afterLocal = rows.length;
  const needsAi = rows.length >= 2
    || rows.some((r) => cardFacts(r).some(looksBrokenFact))
    || rows.some((r) => cardFacts(r).length > 4);

  if (!callChatAPIComplete || !settings || !needsAi) {
    return {
      ok: true,
      before,
      after: afterLocal,
      edited: local.polished,
      deleted: before - afterLocal + local.dropped,
      merged: Math.max(0, before - afterLocal),
      summary: needsAi ? '已做规则去重与口吻统一' : '卡片较少，已做规则整理',
      ai: false,
    };
  }

  const ctx = getVoiceCtx(charId);
  ctx.voice = voiceForTable(table);
  const isSelf = table === 'char_self_views';
  const catsHint = isSelf ? '性格、行为习惯、喜好、经历、变化' : '性格、情绪、想法、喜好、习惯、不擅长、人际关系、样子、其他';
  const voiceRule = isSelf
    ? `第一人称「我」记自己；提到用户只用「${ctx.userCall}」；角色本名一律写 TA`
    : `称呼用户只用「${ctx.userCall}」；称自己为 TA；禁止用户/你/他/她/旅人混用；角色本名一律写 TA`;

  const cardLines = rows.map((r) => {
    const facts = cardFacts(r);
    const broken = facts.filter(looksBrokenFact).length;
    return `#${r.id} 【${r.category || '?'}】confirmed=${r.confirmed === 0 ? 0 : 1}${broken ? ` broken=${broken}` : ''}\n- ${facts.join('\n- ')}${r.note ? `\nTA：${r.note}` : ''}`;
  }).join('\n\n');

  const systemPrompt = isSelf
    ? `你在打扫角色「${ctx.charName || ''}」的自我认知卡片。只输出 JSON，不要扮演聊天。`
    : `你在打扫「${ctx.charName || ''}」对用户的印象画像卡片。只输出 JSON，不要扮演聊天。`;

  const userMsg = `请整理下列卡片：合并语义重复、修好断句/口吃/残缺短句、统一口吻。禁止编造未出现的新事实。

口吻：${voiceRule}
可用大类：${catsHint}
每条 fact 6～24 字；同一张卡最多 6 条相关观察；意思重复只留一条。

输出 JSON（不要 markdown）：
{
  "summary": "一两句说明改了什么",
  "ops": [
    {"action":"keep","id":数字,"merge_ids":[可空],"category":"大类","facts":["短句"],"note":"可空","confirmed":0或1},
    {"action":"delete","id":数字}
  ]
}
规则：
· 每张现有卡的 id 必须出现在某个 keep 的 id / merge_ids，或单独 delete
· keep 的 facts 只能改写该组已有观察；相关观察可收进同一张卡
· 「喜欢吃辣」和「爱吃火锅」是同一观察，只留更具体的那条
· 「喜欢酒」和「觉得某种酒不好喝」是相关观察，收同一张卡，不要删成一句
· 断句要补成完整短句；口吃重复字压掉
· 空泛、时段残渣、具体事件（那天/因为/聊了/提到）、对话元描述 → delete
· 不要把性格形容词写成故事；不要新建没有 id 的卡

现有卡片：
${cardLines}`;

  let parsed = null;
  try {
    let raw = await callChatAPIComplete(settings, systemPrompt, userMsg, 'memory');
    if (!raw) raw = await callChatAPIComplete(settings, systemPrompt, userMsg, 'chat');
    parsed = parseTidyOps(raw);
  } catch (e) {
    console.warn('[portrait-tidy] ai', e.message);
  }

  if (!parsed?.ops?.length) {
    compactPortraitCards(charId, table);
    const after = listCards(table, charId).length;
    return {
      ok: true,
      before,
      after,
      edited: local.polished,
      deleted: Math.max(0, before - after),
      merged: Math.max(0, before - after),
      summary: '模型未给出有效整理方案，已保留规则去重结果',
      ai: false,
    };
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const claimed = new Set();
  let edited = 0;
  let deleted = 0;
  let merged = 0;

  for (const op of parsed.ops) {
    const action = String(op?.action || '').toLowerCase();
    if (action === 'delete') {
      const id = Number(op.id);
      if (!byId.has(id) || claimed.has(id)) continue;
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      claimed.add(id);
      deleted += 1;
      continue;
    }
    if (action !== 'keep') continue;
    const id = Number(op.id);
    const keep = byId.get(id);
    if (!keep || claimed.has(id)) continue;
    const mergeIds = [...new Set((Array.isArray(op.merge_ids) ? op.merge_ids : []).map(Number).filter((x) => byId.has(x) && x !== id && !claimed.has(x)))];
    const sourceFacts = [
      ...cardFacts(keep),
      ...mergeIds.flatMap((mid) => cardFacts(byId.get(mid))),
    ];
    const proposed = Array.isArray(op.facts) ? op.facts : [op.content].filter(Boolean);
    const facts = polishFactsAgainstSources(proposed, sourceFacts, ctx);
    if (!facts.length) continue;

    const cat = normalizeTidyCategory(table, op.category) || String(keep.category || '').trim() || (isSelf ? '喜好' : '性格');
    const note = rewriteNote(op.note != null ? op.note : keep.note, ctx);
    const confirmed = op.confirmed === 0 || op.confirmed === '0'
      ? 0
      : (mergeIds.some((mid) => byId.get(mid)?.confirmed === 0) && keep.confirmed === 0 ? 0 : (op.confirmed != null ? 1 : (keep.confirmed === 0 ? 0 : 1)));

    writeCardFacts(table, id, facts, {
      subcategory: '',
      topic_key: topicKeyOf(facts[0] || ''),
      note,
    });
    if (table === 'char_self_views') {
      db.prepare(`UPDATE char_self_views SET category=?, confirmed=?, updated_at=datetime('now') WHERE id=?`)
        .run(cat, confirmed ? 1 : 0, id);
    } else {
      db.prepare(`UPDATE char_impressions SET category=?, confirmed=? WHERE id=?`)
        .run(cat, confirmed ? 1 : 0, id);
    }
    claimed.add(id);
    edited += 1;
    for (const mid of mergeIds) {
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(mid);
      claimed.add(mid);
      merged += 1;
      deleted += 1;
    }
  }

  // 未被点名的卡：再扫一遍口吻即可，不强删
  compactPortraitCards(charId, table);
  applyLocalVoicePolish(charId, table);
  const after = listCards(table, charId).length;

  return {
    ok: true,
    before,
    after,
    edited: edited + local.polished,
    deleted: deleted + local.dropped + Math.max(0, before - after - deleted),
    merged,
    summary: String(parsed.summary || '').trim().slice(0, 120) || `整理完成：${before} → ${after}`,
    ai: true,
  };
}

function decorateCardRow(row, table) {
  const facts = cardFacts(row);
  return {
    ...row,
    related_facts: parseJsonArr(row.related_facts),
    facts,
    subcategory: '',
    topic_key: row.topic_key || topicKeyOf(facts[0] || row.content || ''),
    note: String(row.note || '').trim(),
  };
}

module.exports = {
  IMP_SUBCATS,
  SELF_SUBCATS,
  MAX_FACTS_PER_CARD,
  TOPIC_FAMILIES,
  ensureClusterColumns,
  parseJsonArr,
  cardFacts,
  uniqueFacts,
  factsSimilar,
  guessSubcategory,
  topicKeyOf,
  topicFamilyKeys,
  familiesOverlap,
  factPolarity,
  looksLikeEventFact,
  looksBrokenFact,
  unifiedUserCall,
  rewriteVoice,
  rewriteNote,
  cardsRelated,
  upsertPortraitCard,
  compactPortraitCards,
  tidyPortraitWithAI,
  decorateCardRow,
  getVoiceCtx,
  wouldAbsorb,
};

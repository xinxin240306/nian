/**
 * 感情线：角色对用户的感情态度随相处衍变。
 * 与 emotion-helper（此刻心情起伏）不同——这里管的是「我们处到哪了」，
 * 避免关系已确认却永远停在刚在一起那天（称呼震惊、怕对方跑、每次表白不许反悔）。
 */
const db = require('./db');

const INTIMATE_NICK_RE = /老公|老婆|丈夫|妻子|先生|太太|亲爱的|宝贝|宝宝|达令|darling|honey|babe|老公酱|老婆酱/i;
const LOVE_SAY_RE = /我爱你|爱你啊|好爱你|超爱你|爱死你|喜欢你|我喜欢你|love\s*you|iloveyou/i;
const NSFW_TALK_RE = /做爱|上床|想要你|抱我|吻我|亲我|性爱|口交|手淫|插进来|射了|射出|内射|后入|内裤|胸部|下面|湿了|硬了|调情|色色|想做|想睡你/i;
const COMMIT_RE = /结婚|嫁给|娶你|一辈子|永远爱|不分手|在一起吧|求你别走|以后都/i;
const CONFESS_RE = /表白|做我的|当我男|当我女|在一起好不好|我喜欢你很久|正式交往|确认关系/i;
/** 分手/降级：含「分开做朋友」等常见说法，不只认「分手」二字 */
const BREAK_RE = /分手|不爱了|结束吧|我们完了|不要你了|删了你|分开(?:吧|了)?|我们分开|想分开|要分开|分开做朋友|分手做朋友|只做朋友|就做朋友|退回朋友|当回朋友|做回朋友|不当(?:男女)?朋友了|不当恋人|不要做恋人|结束恋爱|解除恋爱|断绝关系|我们结束|不想在一起|不想谈了|不想继续了|冷静一下|冷静期|换回朋友/i;
const HARSH_INSULT_RE = /滚|去死|恶心|废物|恨你|拉黑你|把你拉黑|再也不想见到你|滚出我的/i;
const EXTRACT_NICK_RE = /老公|老婆|亲爱的|宝贝|宝宝|达令|honey|babe|darling/gi;

/** 从消息正文抽出可匹配的纯文本（语音 JSON 取 transcript） */
function extractAffectionPlainText(content) {
  const raw = String(content || '').replace(/^【自动回复】/, '').trim();
  if (!raw) return '';
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const t = String(j?.transcript || j?.text || '').trim();
      if (t) return t;
    } catch { /* ignore */ }
    // 无转写的语音气泡：关键词匹配不到，交给上层跳过
    return '';
  }
  const voice = raw.match(/^\[用户语音\]\s*(.*)$/);
  if (voice) return String(voice[1] || '').trim();
  if (raw === '[用户发来一段语音]' || raw === '[用户语音]') return '';
  return raw;
}

const ROMANTIC_STAGE_LABELS = {
  new: '刚确认',
  warming: '热恋初期',
  settling: '磨合成习',
  settled: '稳定相处',
  deep: '深处默契',
  strained: '紧绷别扭',
  cooling: '降温疏远',
};

const PLATONIC_STAGE_LABELS = {
  distant: '还有距离',
  familiar: '已经熟了',
  close: '很亲近',
  bonded: '自己人',
  strained: '别扭',
};

const ALL_STAGE_LABELS = { ...ROMANTIC_STAGE_LABELS, ...PLATONIC_STAGE_LABELS };

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function getSettings() {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function getLocalDateStr(date, tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date || new Date());
}

function daysBetweenYmd(a, b) {
  const pa = String(a || '').slice(0, 10);
  const pb = String(b || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pa) || !/^\d{4}-\d{2}-\d{2}$/.test(pb)) return 0;
  const da = Date.UTC(+pa.slice(0, 4), +pa.slice(5, 7) - 1, +pa.slice(8, 10));
  const db = Date.UTC(+pb.slice(0, 4), +pb.slice(5, 7) - 1, +pb.slice(8, 10));
  return Math.max(0, Math.round((db - da) / 86400000));
}

function parseJson(raw, fallback) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(raw || '');
    return o && typeof o === 'object' ? o : fallback;
  } catch {
    return fallback;
  }
}

function uniqueShort(list, max = 12) {
  const seen = new Set();
  const out = [];
  for (const x of list || []) {
    const s = String(x || '').trim().slice(0, 12);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function charBlob(char = {}) {
  return [
    char.relationship, char.relationship_custom, char.personality, char.emotion_style,
    char.behavior, char.intro, char.background, char.description,
  ].map((x) => String(x || '')).join(' ');
}

function isRomanticBond(char = {}) {
  const rel = String(char.relationship || '').trim();
  if (rel === 'lover') return true;
  const blob = charBlob(char);
  return /恋人|爱人|伴侣|男朋友|女朋友|男友|女友|老公|老婆|丈夫|妻子|情侣|对象|配偶|未婚|夫妻|暗恋|暧昧|心上人|crush|lover|darling|boyfriend|girlfriend|husband|wife/i.test(blob);
}

function readSavedNicks(char = {}) {
  try {
    const { normalizeNicknames } = require('./nickname-helper');
    const n = normalizeNicknames(char.nicknames);
    return uniqueShort([
      ...(n.toChar || []).map((i) => i.text),
      ...(n.toUser || []).map((i) => i.text),
    ]);
  } catch {
    return [];
  }
}

/** 人设如何「过日子」：熟悉化速度 vs 安全感底线是两件事 */
function deriveBondTemperament(char = {}) {
  const blob = `${char.personality || ''} ${char.emotion_style || ''} ${char.behavior || ''} ${char.background || ''}`;
  const has = (re) => re.test(blob);
  const romantic = isRomanticBond(char);

  let settleSpeed = 1;
  let securityFloor = romantic ? 48 : 40;
  let residualInsecurity = 0.25;
  let tsundere = false;
  let clingy = false;
  let cool = false;
  let thinBond = false;
  /** 专一/深情：好感难动，失望先积，分手极难 */
  let loyaltyHigh = false;
  let attachmentFloor = romantic ? 32 : 18;
  let disappointmentGain = 1;
  let disappointmentDecay = 1;
  let breakTalkHardness = 1; // 越高越不当真一句分手

  if (has(/缺爱|安全感差|容易不安|恋爱脑|粘人|黏人|依恋|玻璃心|敏感|怕被抛弃|怕走/)) {
    settleSpeed -= 0.12;
    securityFloor -= 16;
    residualInsecurity += 0.45;
    clingy = true;
    disappointmentGain += 0.2;
  }
  if (has(/深情|专一|认真|重感情|念旧|一心一意|非你不可|只爱你|绝不会劈腿|不会移情/)) {
    settleSpeed += 0.08;
    securityFloor += 6;
    loyaltyHigh = true;
    attachmentFloor = romantic ? 48 : 28;
    disappointmentGain += 0.15; // 在乎才容易寒心，但…
    disappointmentDecay -= 0.25; // …失望掉得慢
    breakTalkHardness += 0.85; // 一句分手更不当真
  }
  if (has(/自信|直球|脸皮厚|大大咧咧|乐天|开朗|爽朗/)) {
    settleSpeed += 0.35;
    securityFloor += 18;
    residualInsecurity -= 0.2;
    breakTalkHardness -= 0.15;
  }
  if (has(/傲娇|别扭|嘴硬|要面子|外冷内热|口是心非/)) {
    tsundere = true;
    settleSpeed -= 0.05;
  }
  if (has(/淡漠|高冷|冷静|理性|佛系|钝感|冷淡/)) {
    cool = true;
    settleSpeed += 0.1;
    residualInsecurity -= 0.15;
    disappointmentGain -= 0.2;
    breakTalkHardness += 0.25;
  }
  if (has(/薄情|花心|渣|玩世|无情/)) {
    thinBond = true;
    securityFloor -= 8;
    residualInsecurity -= 0.1;
    attachmentFloor = Math.min(attachmentFloor, 22);
    breakTalkHardness -= 0.35;
    disappointmentDecay += 0.35;
  }
  if (has(/占有欲|吃醋|善妒/)) {
    residualInsecurity += 0.12;
    disappointmentGain += 0.1;
  }

  return {
    romantic,
    settleSpeed: clamp(settleSpeed, 0.55, 1.7),
    securityFloor: clamp(securityFloor, 22, 78),
    residualInsecurity: clamp(residualInsecurity, 0, 0.85),
    tsundere,
    clingy,
    cool,
    thinBond,
    loyaltyHigh,
    attachmentFloor: clamp(attachmentFloor, 12, 72),
    disappointmentGain: clamp(disappointmentGain, 0.35, 1.8),
    disappointmentDecay: clamp(disappointmentDecay, 0.35, 1.6),
    breakTalkHardness: clamp(breakTalkHardness, 0.4, 2.2),
  };
}

function defaultState(char = {}) {
  const romantic = isRomanticBond(char);
  const temper = deriveBondTemperament(char);
  return {
    v: 1,
    kind: romantic ? 'romantic' : 'platonic',
    stage: romantic ? 'warming' : 'familiar',
    peakStage: romantic ? 'warming' : 'familiar',
    togetherSince: String(char.anniversary || '').slice(0, 10) || '',
    knownSince: '',
    daysTogether: 0,
    daysKnown: 0,
    chatRounds: 0,
    security: temper.securityFloor + 8,
    attachment: romantic ? 55 : 35,
    disappointment: 0,
    breakTalkStreak: 0,
    habits: { nickname: 0, love: 0, nsfw: 0, commit: 0 },
    settledNicks: readSavedNicks(char),
    flags: {
      nickOrdinary: false,
      loveOrdinary: false,
      nsfwOrdinary: false,
      commitTalked: false,
      justConfessed: false,
      breakLandmineTold: false,
      coolingThought: false,
    },
    stance: '',
    stillTender: [],
    guardTowardUser: 50,
    history: [],
    bootstrapped: false,
    updatedAt: null,
    lastMsgAt: null,
  };
}

function normalizeState(raw, char) {
  const base = defaultState(char);
  if (!raw || typeof raw !== 'object') return base;
  const habits = raw.habits && typeof raw.habits === 'object' ? raw.habits : {};
  const flags = raw.flags && typeof raw.flags === 'object' ? raw.flags : {};
  const kind = raw.kind === 'platonic' || raw.kind === 'romantic'
    ? raw.kind
    : (isRomanticBond(char) ? 'romantic' : 'platonic');
  const stage = ALL_STAGE_LABELS[raw.stage] ? raw.stage : base.stage;
  return {
    ...base,
    ...raw,
    kind,
    stage,
    peakStage: ALL_STAGE_LABELS[raw.peakStage] ? raw.peakStage : stage,
    togetherSince: String(raw.togetherSince || base.togetherSince).slice(0, 10),
    knownSince: String(raw.knownSince || '').slice(0, 10),
    daysTogether: clamp(parseInt(raw.daysTogether, 10) || 0, 0, 20000),
    daysKnown: clamp(parseInt(raw.daysKnown, 10) || 0, 0, 20000),
    chatRounds: clamp(parseInt(raw.chatRounds, 10) || 0, 0, 1e7),
    security: clamp(Number(raw.security) || base.security, 0, 100),
    attachment: clamp(Number(raw.attachment) || base.attachment, 0, 100),
    disappointment: clamp(Number(raw.disappointment) || 0, 0, 100),
    breakTalkStreak: clamp(parseInt(raw.breakTalkStreak, 10) || 0, 0, 20),
    habits: {
      nickname: clamp(Number(habits.nickname) || 0, 0, 100),
      love: clamp(Number(habits.love) || 0, 0, 100),
      nsfw: clamp(Number(habits.nsfw) || 0, 0, 100),
      commit: clamp(Number(habits.commit) || 0, 0, 100),
    },
    settledNicks: uniqueShort([...(base.settledNicks || []), ...(raw.settledNicks || [])]),
    flags: {
      nickOrdinary: !!flags.nickOrdinary,
      loveOrdinary: !!flags.loveOrdinary,
      nsfwOrdinary: !!flags.nsfwOrdinary,
      commitTalked: !!flags.commitTalked,
      justConfessed: !!flags.justConfessed,
      breakLandmineTold: !!flags.breakLandmineTold,
      coolingThought: !!flags.coolingThought,
    },
    stance: String(raw.stance || '').slice(0, 280),
    stillTender: Array.isArray(raw.stillTender) ? raw.stillTender.map((s) => String(s).slice(0, 80)).slice(0, 4) : [],
    guardTowardUser: clamp(Number(raw.guardTowardUser) || 50, 15, 85),
    history: Array.isArray(raw.history) ? raw.history.slice(-24) : [],
    bootstrapped: !!raw.bootstrapped,
    updatedAt: raw.updatedAt || null,
    lastMsgAt: raw.lastMsgAt || null,
  };
}

function loadState(char) {
  return normalizeState(parseJson(char?.affection_state, null), char);
}

function saveState(charId, state) {
  if (!charId) return;
  db.prepare('UPDATE characters SET affection_state=? WHERE id=?').run(JSON.stringify(state), charId);
}

function pushHistory(state, text) {
  const line = String(text || '').trim().slice(0, 80);
  if (!line) return;
  const last = state.history[state.history.length - 1];
  if (last && last.text === line) return;
  state.history.push({ at: getLocalDateStr(new Date()), text: line });
  if (state.history.length > 24) state.history = state.history.slice(-24);
}

function extractNicksFromText(text) {
  const found = [];
  const t = String(text || '');
  for (const m of t.matchAll(EXTRACT_NICK_RE)) found.push(m[0]);
  return uniqueShort(found);
}

function bumpHabit(cur, amount, firstBoost = 8) {
  const add = cur < 18 ? amount + firstBoost : amount;
  return clamp(cur + add, 0, 100);
}

function loadChar(charId) {
  return db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
}

function firstChatDate(charId, tz) {
  const row = db.prepare(
    `SELECT timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0
     ORDER BY id ASC LIMIT 1`
  ).get(charId);
  if (!row?.timestamp) return '';
  const d = new Date(row.timestamp);
  if (!Number.isFinite(d.getTime())) return String(row.timestamp).slice(0, 10);
  return getLocalDateStr(d, tz);
}

function countUserRounds(charId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='user'
     AND (type IS NULL OR type != 'system')`
  ).get(charId)?.n || 0;
}

function scanHistorySignals(charId) {
  const msgs = db.prepare(
    `SELECT role, content FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0
     AND (type IS NULL OR type != 'system')
     ORDER BY id DESC LIMIT 280`
  ).all(charId);
  let nick = 0;
  let love = 0;
  let nsfw = 0;
  let commit = 0;
  let confess = 0;
  let breakHits = 0;
  let harshHits = 0;
  const nicks = [];
  for (const m of msgs) {
    const t = extractAffectionPlainText(m.content);
    if (!t) continue;
    if (INTIMATE_NICK_RE.test(t)) {
      nick += 1;
      nicks.push(...extractNicksFromText(t));
    }
    if (LOVE_SAY_RE.test(t)) love += 1;
    if (NSFW_TALK_RE.test(t)) nsfw += 1;
    if (COMMIT_RE.test(t)) commit += 1;
    if (CONFESS_RE.test(t)) confess += 1;
    if (m.role === 'user' && BREAK_RE.test(t)) breakHits += 1;
    if (m.role === 'user' && HARSH_INSULT_RE.test(t)) harshHits += 1;
  }
  const mems = db.prepare(
    `SELECT content FROM memories
     WHERE character_id=? AND category IN ('情感状态','重要时刻')
     AND COALESCE(archived,0)=0
     ORDER BY id DESC LIMIT 40`
  ).all(charId);
  for (const m of mems) {
    const t = String(m.content || '');
    if (INTIMATE_NICK_RE.test(t)) nicks.push(...extractNicksFromText(t));
    if (LOVE_SAY_RE.test(t) || /表白|告白|说爱/.test(t)) love += 1;
    if (NSFW_TALK_RE.test(t) || /亲密|床第|情事/.test(t)) nsfw += 1;
    if (COMMIT_RE.test(t) || /确认关系|在一起/.test(t)) commit += 1;
    if (BREAK_RE.test(t) || /冷战|吵架|分开/.test(t)) breakHits += 1;
  }
  return {
    nickCount: nick,
    loveCount: love,
    nsfwCount: nsfw,
    commitCount: commit,
    confessCount: confess,
    breakHits,
    harshHits,
    nicks: uniqueShort(nicks),
  };
}

function recomputeFlags(state, char, temper) {
  const savedIntimate = (state.settledNicks || []).some((n) => INTIMATE_NICK_RE.test(n));
  const days = Math.max(state.daysTogether, Math.floor(state.daysKnown * 0.55));
  const speed = temper.settleSpeed;

  state.flags.nickOrdinary = savedIntimate
    || state.habits.nickname >= Math.round(16 / speed)
    || (temper.romantic && days >= 10 && state.habits.nickname >= 8);

  state.flags.loveOrdinary = state.habits.love >= Math.round(18 / speed)
    || (temper.romantic && days >= 21 && state.habits.love >= 6)
    || (temper.romantic && days >= 45);

  state.flags.nsfwOrdinary = state.habits.nsfw >= Math.round(20 / speed)
    || (temper.romantic && (state.stage === 'settled' || state.stage === 'deep') && state.habits.nsfw >= 8)
    || (temper.romantic && days >= 60);

  state.flags.commitTalked = state.habits.commit >= 12 || days >= 90;
}

/** 角色是否明确告知过「别随口提分手」类雷区（记忆约定 / 已落旗标） */
function hasBreakLandmineTold(charId, state) {
  if (state?.flags?.breakLandmineTold) return true;
  if (!charId) return false;
  try {
    const rows = db.prepare(
      `SELECT content FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0
         AND category IN ('约定','重要时刻','情感状态')
       ORDER BY id DESC LIMIT 60`
    ).all(charId);
    const re = /别.*(分手)|不要.*(分手)|禁止.*(分手)|(分手).*(雷|玩笑|随便|气话|嘴上)|讨厌.*(开玩笑|随口).*(分手)|(说过|告诉过|说过了).*(分手)/;
    return rows.some((r) => re.test(String(r.content || '')));
  } catch {
    return false;
  }
}

function markBreakLandmineFromText(state, text, role) {
  if (role !== 'assistant') return false;
  const t = String(text || '');
  if (!/(分手).{0,24}(别|不要|讨厌|雷|玩笑|随便|气话)|(别|不要|讨厌).{0,12}(随便|开玩笑|嘴上).{0,8}(分手)/.test(t)) {
    return false;
  }
  if (!state.flags.breakLandmineTold) {
    state.flags.breakLandmineTold = true;
    pushHistory(state, '已告知：随口提分手是雷区');
  }
  return true;
}

/**
 * 失望先积；过高才拖累好感(attachment)。专一：失望难涨、好感更难动。
 */
function applyDisappointment(state, temper, amount, reason = '') {
  const raw = Number(amount) || 0;
  if (raw <= 0) return state;
  const gain = raw * (temper.disappointmentGain || 1) / Math.max(0.85, temper.breakTalkHardness || 1);
  const before = state.disappointment || 0;
  state.disappointment = clamp(before + gain, 0, 100);
  cascadeDisappointmentToAttachment(state, temper);
  if (reason && state.disappointment - before >= 2) {
    pushHistory(state, reason.slice(0, 48));
  }
  return state;
}

function cascadeDisappointmentToAttachment(state, temper) {
  const d = state.disappointment || 0;
  const floor = temper.attachmentFloor || 32;
  // 失望够高才开始啃好感；专一阈值更高、啃得更慢
  const gate = temper.loyaltyHigh ? 52 : 38;
  if (d < gate) {
    state.flags.coolingThought = false;
    return state;
  }
  const over = d - gate;
  const rate = temper.loyaltyHigh ? 0.08 : 0.14;
  const targetPull = over * rate;
  state.attachment = clamp(state.attachment - targetPull * 0.15, floor, 100);
  // 临界：出现分开/冷静念头（仍不自动改关系类型）
  const crit = temper.loyaltyHigh ? 42 : 28;
  state.flags.coolingThought = state.attachment <= crit && d >= gate + 8;
  if (state.flags.coolingThought && state.stage !== 'cooling' && state.kind === 'romantic') {
    if (state.attachment <= crit - 6 && d >= (temper.loyaltyHigh ? 72 : 58)) {
      state.stage = 'strained';
    }
  }
  return state;
}

function softenBreakTalk(state, temper, { landmine = false, confirmed = false } = {}) {
  // 默认气话：小失望；雷区或连续确认才加重
  let amt = temper.loyaltyHigh ? 3.5 : 6;
  if (landmine) amt = temper.loyaltyHigh ? 9 : 14;
  if (confirmed) amt += temper.loyaltyHigh ? 6 : 10;
  applyDisappointment(
    state,
    temper,
    amt,
    landmine ? '踩到「分手」雷区' : (confirmed ? '分手话被当真了一截' : '分手气话，心里凉了一点'),
  );
  // 专一：几乎不动好感；非专一：小幅
  if (!temper.loyaltyHigh) {
    state.attachment = clamp(state.attachment - (confirmed ? 5 : 2), temper.attachmentFloor, 100);
    state.security = clamp(state.security - (confirmed ? 8 : 3), 8, 100);
  } else {
    state.security = clamp(state.security - (landmine || confirmed ? 4 : 1.5), temper.securityFloor * 0.5, 100);
  }
  if (confirmed && !temper.loyaltyHigh) {
    state.stage = 'strained';
  } else if (confirmed && temper.loyaltyHigh && (state.disappointment || 0) >= 70) {
    state.stage = 'strained';
  }
  return state;
}

const ROMANTIC_RANK = {
  new: 1, warming: 2, settling: 3, settled: 4, deep: 5, strained: 0, cooling: 0,
};
const PLATONIC_RANK = {
  distant: 1, familiar: 2, close: 3, bonded: 4, strained: 0,
};

const STAGE_MIN_DAYS = 3;

const ROMANTIC_STAGE_ORDER = ['new', 'warming', 'settling', 'settled', 'deep'];
const PLATONIC_STAGE_ORDER = ['distant', 'familiar', 'close', 'bonded'];

function capStageByMinDays(next, days, romantic) {
  if (days >= STAGE_MIN_DAYS) return next;
  const order = romantic ? ROMANTIC_STAGE_ORDER : PLATONIC_STAGE_ORDER;
  const cap = romantic ? 'warming' : 'familiar';
  const ni = order.indexOf(next);
  const ci = order.indexOf(cap);
  if (ni === -1 || ci === -1 || ni <= ci) return next;
  return cap;
}

function pickRomanticStage(state, temper) {
  // 失望/好感临界才进入紧绷；专一更难
  if (state.flags.coolingThought && (state.attachment || 0) < (temper.attachmentFloor || 40) + 4) {
    if ((state.disappointment || 0) >= (temper.loyaltyHigh ? 75 : 55)) return 'cooling';
  }
  if (state.stage === 'cooling' && state.attachment < 28 && (state.disappointment || 0) > 40) return 'cooling';
  if (state.stage === 'strained' && (state.security < 38 || (state.disappointment || 0) >= 45)) return 'strained';

  const days = Math.max(state.daysTogether, Math.floor(state.daysKnown * 0.5));
  const rounds = state.chatRounds || 0;
  let next = 'warming';

  if (state.flags.justConfessed && days < 8 && rounds < 40) next = 'new';
  else if (days >= 150 && state.flags.nickOrdinary && state.security >= 58) next = 'deep';
  else if (days >= 50 || (days >= 21 && state.flags.nickOrdinary && state.flags.loveOrdinary) || rounds >= 160) next = 'settled';
  else if (days >= 12 || state.flags.nickOrdinary || rounds >= 50) next = 'settling';
  else next = 'warming';

  // 角色卡已标恋人：空状态不要从「刚确认」起跳
  if (next === 'new' && !state.flags.justConfessed) next = 'warming';
  if (temper.settleSpeed >= 1.25 && next === 'warming' && days >= 5) next = 'settling';
  if (temper.settleSpeed <= 0.7 && next === 'deep' && days < 200) next = 'settled';

  // 已有明显失望时，不要用天数把阶段强行推回甜蜜高峰
  if ((state.disappointment || 0) >= 40 && (next === 'deep' || next === 'settled')) {
    if (state.stage === 'strained' || state.stage === 'cooling') return state.stage;
    if ((state.disappointment || 0) >= 55) next = state.stage === 'settling' ? 'settling' : 'settling';
  }
  return capStageByMinDays(next, days, true);
}

function pickPlatonicStage(state) {
  if (state.stage === 'strained' && state.security < 36) return 'strained';
  const days = state.daysKnown || 0;
  const rounds = state.chatRounds || 0;
  let next = 'distant';
  if (days >= 90 || rounds >= 180) next = 'bonded';
  else if (days >= 21 || rounds >= 50) next = 'close';
  else if (days >= 3 || rounds >= 8) next = 'familiar';
  return capStageByMinDays(next, days, false);
}

function composeStillTender(state, temper) {
  const lines = [];
  if (state.kind !== 'romantic') {
    if (temper.cool) lines.push('亲近也保持分寸，不突然变成恋人腔');
    return lines.slice(0, 2);
  }
  if (state.stage === 'strained') {
    lines.push('眼下别扭可以带进语气，但不要装作从没在一起过');
    return lines;
  }
  const settledDeep = state.stage === 'settled' || state.stage === 'deep';
  // 已磨合/深处：不要再点名「没底/怕跑」，点名会被演成每轮收尾
  if (temper.clingy && state.security < 58 && !settledDeep && (state.disappointment || 0) < 35) {
    lines.push('黏可以体现在接话与语气，不是每轮收尾再确认关系');
  }
  if (temper.tsundere) {
    lines.push('嘴硬别扭是说话方式，不代表感情还停在刚确认那天');
  }
  if (temper.thinBond) {
    lines.push('你不必演深情黏人，但也不要演第一次被叫亲密称呼的纯情');
  }
  if (state.stage === 'new' || state.stage === 'warming') {
    if (!temper.cool) lines.push('新鲜感可以有，但已发生过的事不要再装第一次');
  }
  return lines.slice(0, 3);
}

function composeStance(state, temper) {
  if (state.kind !== 'romantic') {
    if (state.stage === 'bonded') return '把对方当自己人，熟到不必客套，也不是恋人式黏糊';
    if (state.stage === 'close') return '已经很熟了，接话轻松，不要装刚认识';
    if (state.stage === 'familiar') return '处过一阵了，不必每句都重新自我介绍式客气';
    if (state.stage === 'strained') return '眼下有点别扭，但仍是认识的人，不是路人';
    return '还在相互认识，亲疏按人设来';
  }
  const d = state.disappointment || 0;
  const bits = [];
  if (state.flags.coolingThought) {
    bits.push('心里冒过冷静/分开/不合适的念头，但还没把关系一笔勾销；怎么说看出走还是留下，按人设');
  } else if (d >= 55 && temper.loyaltyHigh) {
    bits.push('仍是恋人，但是深爱里的寒心：可以少黏、话变少、自我怀疑，不要演成立刻不爱了');
  } else if (d >= 40) {
    bits.push('对对方有点失望，黏度下来一点，仍按已确认的关系相处');
  } else if (state.stage === 'deep') bits.push('把对方当已经过了很久的自己人，亲密是日子里的事，不是事件');
  else if (state.stage === 'settled') bits.push('把对方当已经确认过、正在过日子的伴侣');
  else if (state.stage === 'settling') bits.push('已经在一起一阵，亲密称呼和日常正在变成习惯');
  else if (state.stage === 'warming') bits.push('热恋里会亲近，但已经不是刚开口那一晚');
  else if (state.stage === 'new') bits.push('刚确认关系，新鲜、还会有点不确定');
  else if (state.stage === 'strained') bits.push('眼下紧绷别扭，但不是退回陌生人，也不是假装从没在一起过');
  else if (state.stage === 'cooling') bits.push('心里在降温，态度按人设来，不要突然变回刚认识');

  if (temper.tsundere) bits.push('嘴硬是你的口吻，不是感情还停在起点');
  // settled/deep 不再注入「没安全感」类提示，避免每轮关系确认收尾
  if (
    temper.clingy
    && state.security < 55
    && d < 35
    && state.stage !== 'settled'
    && state.stage !== 'deep'
  ) {
    bits.push('黏在接话里，不要每轮用挽留/负责类句子收尾');
  }
  if (temper.cool) bits.push('淡或高冷是性格，不代表还不熟');
  if (temper.loyaltyHigh && d < 30) bits.push('专一不代表永远甜蜜：可以有情绪，但关系类型别轻易撕掉');
  return bits.join('。').slice(0, 240);
}

function applyTimeAndStage(state, char, { today, tz, advanceStage = true } = {}) {
  const before = JSON.stringify({
    stage: state.stage,
    flags: state.flags,
    habits: state.habits,
    daysTogether: state.daysTogether,
    daysKnown: state.daysKnown,
    stance: state.stance,
    security: Math.round(state.security),
    attachment: Math.round(state.attachment),
    guardTowardUser: Math.round(state.guardTowardUser || 50),
  });
  const temper = deriveBondTemperament(char);
  const day = today || getLocalDateStr(new Date(), tz || getSettings().timezone || 'Asia/Shanghai');
  const known = state.knownSince || '';
  const together = state.togetherSince || String(char.anniversary || '').slice(0, 10);
  if (together) state.togetherSince = together;
  if (known) state.daysKnown = daysBetweenYmd(known, day);
  state.daysTogether = together
    ? daysBetweenYmd(together, day)
    : Math.max(state.daysTogether || 0, Math.floor((state.daysKnown || 0) * (temper.romantic ? 0.7 : 0.4)));

  if (temper.romantic && !state.togetherSince && (char.relationship === 'lover' || state.flags.nickOrdinary)) {
    if (state.knownSince) state.togetherSince = state.knownSince;
  }

  recomputeFlags(state, char, temper);

  if (advanceStage) {
    let effectiveTemper = temper;
    try {
      const moodMod = require('./emotion-helper').getMoodTrendMod(char.id);
      effectiveTemper = { ...temper, settleSpeed: clamp(temper.settleSpeed * (1 + moodMod), 0.4, 2) };
    } catch { /* ignore */ }

    const prevStage = state.stage;
    const next = temper.romantic ? pickRomanticStage(state, effectiveTemper) : pickPlatonicStage(state);
    if (next !== prevStage) {
      const rank = temper.romantic ? ROMANTIC_RANK : PLATONIC_RANK;
      if ((rank[next] || 0) >= (rank[state.peakStage] || 0)) state.peakStage = next;
      state.stage = next;
      pushHistory(state, `阶段 → ${ALL_STAGE_LABELS[next] || next}`);
    } else {
      state.stage = next;
    }
    if (state.stage !== 'new') state.flags.justConfessed = false;

    const targetSec = clamp(
      temper.securityFloor
        + Math.min(32, state.daysTogether * 0.12 * effectiveTemper.settleSpeed)
        + (state.flags.nickOrdinary ? 8 : 0)
        + (state.flags.loveOrdinary ? 6 : 0)
        - Math.min(18, (state.disappointment || 0) * 0.15),
      temper.securityFloor * 0.55,
      92,
    );
    state.security = round1(state.security * 0.82 + targetSec * 0.18);

    // 失望缓慢回落；专一更慢。好感有地板，失望高时减弱「随日子自动回暖」
    const dDecay = 0.55 * (temper.disappointmentDecay || 1);
    state.disappointment = clamp((state.disappointment || 0) - dDecay, 0, 100);
    cascadeDisappointmentToAttachment(state, temper);

    const floor = temper.attachmentFloor || 32;
    let targetAtt = temper.romantic
      ? clamp(48 + Math.min(40, state.daysTogether * 0.1) + (temper.thinBond ? -12 : 0), floor, 96)
      : clamp(30 + Math.min(40, state.daysKnown * 0.08), Math.min(floor, 18), 88);
    if ((state.disappointment || 0) >= 40) {
      targetAtt = Math.min(targetAtt, state.attachment + 1); // 寒心时别被天数强行拉回甜蜜
    }
    const blend = (state.disappointment || 0) >= 50 ? 0.06 : 0.15;
    state.attachment = round1(clamp(
      state.attachment * (1 - blend) + targetAtt * blend,
      floor,
      100,
    ));

    // 对用户的戒备值：长期正向互动略降，紧绷/失望时略升
    let guard = clamp(Number(state.guardTowardUser) || 50, 15, 85);
    if (state.stage === 'strained' || state.stage === 'cooling' || (state.disappointment || 0) >= 45) {
      guard = clamp(guard + 1.2, 15, 85);
    } else if (state.flags.loveOrdinary || state.flags.nickOrdinary) guard = clamp(guard - 0.8, 15, 85);
    else if ((state.daysTogether || 0) > 14) guard = clamp(guard - 0.3, 15, 85);
    state.guardTowardUser = round1(guard);
  }

  state.stillTender = composeStillTender(state, temper);
  state.stance = composeStance(state, temper);
  const after = JSON.stringify({
    stage: state.stage,
    flags: state.flags,
    habits: state.habits,
    daysTogether: state.daysTogether,
    daysKnown: state.daysKnown,
    stance: state.stance,
    security: Math.round(state.security),
    attachment: Math.round(state.attachment),
    guardTowardUser: Math.round(state.guardTowardUser || 50),
  });
  if (after !== before) state.updatedAt = new Date().toISOString();
  return state;
}

function bootstrapState(char, { force = false } = {}) {
  let state = loadState(char);
  if (state.bootstrapped && !force) return state;
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const signals = scanHistorySignals(char.id);
  const known = firstChatDate(char.id, tz);
  const rounds = countUserRounds(char.id);

  state.knownSince = known || state.knownSince;
  state.togetherSince = String(char.anniversary || '').slice(0, 10) || state.togetherSince;
  state.chatRounds = rounds;
  state.settledNicks = uniqueShort([
    ...(state.settledNicks || []),
    ...signals.nicks,
    ...readSavedNicks(char),
    ...extractNicksFromText(charBlob(char)),
  ]);
  state.habits.nickname = Math.max(state.habits.nickname, clamp(signals.nickCount * 7, 0, 100));
  state.habits.love = Math.max(state.habits.love, clamp(signals.loveCount * 9, 0, 100));
  state.habits.nsfw = Math.max(state.habits.nsfw, clamp(signals.nsfwCount * 8, 0, 100));
  state.habits.commit = Math.max(state.habits.commit, clamp(signals.commitCount * 10, 0, 100));
  state.flags.justConfessed = signals.confessCount > 0
    && daysBetweenYmd(known, today) < 10
    && rounds < 36
    && String(char.relationship || '') !== 'lover';

  const temper = deriveBondTemperament(char);
  if (temper.romantic && !state.togetherSince && known) {
    state.togetherSince = known;
  }
  // 历史里已说过分开/做朋友等：重建时补上失望，避免「说过了感情线却没动」
  if (temper.romantic && (signals.breakHits > 0 || signals.harshHits > 0)) {
    const confirmed = signals.breakHits >= (temper.loyaltyHigh ? 2 : 1);
    if (signals.breakHits > 0) {
      softenBreakTalk(state, temper, { landmine: false, confirmed });
      if (signals.breakHits >= 2) {
        applyDisappointment(state, temper, temper.loyaltyHigh ? 5 : 9, '聊天里提过分开/降级');
      }
    }
    if (signals.harshHits > 0) {
      applyDisappointment(
        state,
        temper,
        (temper.loyaltyHigh ? 3 : 5) * Math.min(3, signals.harshHits),
        '聊天里有很刺的话',
      );
    }
  }
  state.bootstrapped = true;
  applyTimeAndStage(state, char, { today, tz });
  if (!state.history.length) {
    pushHistory(state, `感情线起步：${ALL_STAGE_LABELS[state.stage] || state.stage}`);
  }
  return state;
}

function applyMessageToState(state, char, { role, content } = {}) {
  const t = extractAffectionPlainText(content);
  if (!t || t.length < 2) return state;
  const temper = deriveBondTemperament(char);
  let hit = false;

  markBreakLandmineFromText(state, t, role);
  if (hasBreakLandmineTold(char.id, state)) state.flags.breakLandmineTold = true;

  if (INTIMATE_NICK_RE.test(t)) {
    state.settledNicks = uniqueShort([...(state.settledNicks || []), ...extractNicksFromText(t)]);
    state.habits.nickname = bumpHabit(state.habits.nickname, 6, 10);
    hit = true;
  }
  if (LOVE_SAY_RE.test(t)) {
    state.habits.love = bumpHabit(state.habits.love, 7, 10);
    if ((state.disappointment || 0) > 0) {
      state.disappointment = clamp(state.disappointment - (temper.loyaltyHigh ? 2 : 4), 0, 100);
    }
    hit = true;
  }
  if (NSFW_TALK_RE.test(t)) {
    state.habits.nsfw = bumpHabit(state.habits.nsfw, 7, 8);
    hit = true;
  }
  if (COMMIT_RE.test(t)) {
    state.habits.commit = bumpHabit(state.habits.commit, 8, 6);
    state.flags.commitTalked = true;
    hit = true;
  }
  if (CONFESS_RE.test(t) && role === 'user' && (state.daysTogether || 0) < 10 && (state.chatRounds || 0) < 40) {
    state.flags.justConfessed = true;
    hit = true;
  }

  // 分手/降级话：默认气话；雷区加重；连续提或「做朋友」类更当真。专一几乎不动好感。
  if (BREAK_RE.test(t) && role === 'user') {
    const landmine = !!state.flags.breakLandmineTold || hasBreakLandmineTold(char.id, state);
    state.breakTalkStreak = (state.breakTalkStreak || 0) + 1;
    const confirmed = state.breakTalkStreak >= (temper.loyaltyHigh ? 3 : 2)
      || /认真|真的要|不是开玩笑|就这样结束|我们结束吧|做朋友|只做朋友|不当恋人|退回朋友/.test(t);
    softenBreakTalk(state, temper, { landmine, confirmed });
    hit = true;
  } else if (role === 'user' && t.length >= 4) {
    // 正常对话：分手连击清零；轻微愈合失望（专一更慢）
    if (state.breakTalkStreak) state.breakTalkStreak = 0;
    if ((state.disappointment || 0) > 0 && !/滚|烦|讨厌你|不理你/.test(t)) {
      state.disappointment = clamp(
        state.disappointment - (temper.loyaltyHigh ? 0.35 : 0.8),
        0,
        100,
      );
    }
  }

  // 厌恶区轻踩：用户明显冲人设雷（仅当话够冲），给小失望——单次话题不猛调
  if (role === 'user' && temper.romantic && HARSH_INSULT_RE.test(t)) {
    applyDisappointment(state, temper, temper.loyaltyHigh ? 4 : 7, '被很刺的话扎到');
    hit = true;
  }

  if (role === 'user') state.chatRounds = (state.chatRounds || 0) + 1;
  state.lastMsgAt = new Date().toISOString();
  if (hit && temper.clingy && LOVE_SAY_RE.test(t)) {
    state.security = clamp(state.security + 3, 0, 100);
  }
  cascadeDisappointmentToAttachment(state, temper);
  return state;
}

function ensureState(char, opts = {}) {
  if (!char?.id) return defaultState(char);
  let state = loadState(char);
  if (!state.bootstrapped || opts.rebuild) {
    state = bootstrapState(char, { force: !!opts.rebuild });
    saveState(char.id, state);
  } else {
    const settings = getSettings();
    const tz = settings.timezone || 'Asia/Shanghai';
    applyTimeAndStage(state, char, { tz, advanceStage: !!opts.advanceStage });
    const prev = String(char.affection_state || '');
    const next = JSON.stringify(state);
    if (prev !== next) saveState(char.id, state);
  }
  return state;
}

function touchAffectionFromMessage(charId, { role, content } = {}) {
  if (!charId) return null;
  const char = loadChar(charId);
  if (!char) return null;
  let state = loadState(char);
  const wasBootstrapped = state.bootstrapped;
  if (!wasBootstrapped) {
    state = bootstrapState(char);
  } else {
    applyMessageToState(state, char, { role, content });
    const temper = deriveBondTemperament(char);
    recomputeFlags(state, char, temper);
    state.stillTender = composeStillTender(state, temper);
    state.stance = composeStance(state, temper);
  }
  saveState(charId, state);
  return state;
}

/** 重要时刻记忆写入后轻量 bump（D19） */
function bumpFromImportantMoment(charId) {
  if (!charId) return null;
  const char = loadChar(charId);
  if (!char) return null;
  let state = loadState(char);
  if (!state.bootstrapped) state = bootstrapState(char);
  state.habits.love = bumpHabit(state.habits.love, 4, 4);
  state.habits.commit = bumpHabit(state.habits.commit, 3, 3);
  const temper = deriveBondTemperament(char);
  recomputeFlags(state, char, temper);
  saveState(charId, state);
  return state;
}

function rebuildAffection(charId) {
  const char = loadChar(charId);
  if (!char) return null;
  const state = bootstrapState(char, { force: true });
  saveState(charId, state);
  return publicView(state, char);
}

function tickAllAffections() {
  const chars = db.prepare(
    'SELECT id, affection_state, relationship, relationship_custom, personality, emotion_style, behavior, intro, background, description, anniversary, nicknames, nsfw_enabled FROM characters'
  ).all();
  let n = 0;
  for (const char of chars) {
    try {
      const prev = String(char.affection_state || '');
      const state = ensureState(char, { advanceStage: true });
      if (JSON.stringify(state) !== prev) n += 1;
    } catch (e) {
      console.warn('[affection] tick', char.id, e.message);
    }
  }
  return { updated: n };
}

function settledFactLines(state) {
  const lines = [];
  if (state.kind !== 'romantic') return lines;
  if (state.flags.nickOrdinary) {
    const nicks = (state.settledNicks || []).filter((n) => INTIMATE_NICK_RE.test(n));
    lines.push(nicks.length
      ? `用户会喊「${nicks.slice(0, 4).join('、')}」已是日常，不必震惊、不必问「怎么这样叫」`
      : '亲密称呼已是日常，不必每次都当第一次听到');
  }
  if (state.flags.loveOrdinary) {
    lines.push('双方说过喜欢/爱，表达爱意是相处方式，不是刚表白');
  }
  if (state.flags.nsfwOrdinary) {
    lines.push('亲密/情色话题已经聊过，不是第一次越界');
  }
  if (state.flags.commitTalked || (state.daysTogether || 0) >= 60) {
    lines.push('关系已经确认过，不必反复求对方「以后不许反悔」');
  }
  if ((state.daysTogether || 0) >= 14 || state.stage === 'settled' || state.stage === 'deep') {
    lines.push('相处已稳：闲聊收尾不要再做关系确认/挽留（负责、别跑、退货、不许反悔）或陪伴安抚（陪着你、哪也不去、守着你、我就这儿及其换皮同义）');
  }
  return lines;
}

/** 情绪/爱意怎么说：跟人设 + 感情进度，直球不硬绕，长处不装第一次 */
function buildEmotionExpressionHint(char, state) {
  const s = state || (char?.id ? loadState(char) : null);
  if (!s) return '';
  const blob = `${char?.personality || ''} ${char?.emotion_style || ''} ${char?.behavior || ''} ${char?.language_style || ''}`;
  const reserved = /沉|深沉|复杂|别扭|拧|内敛|话少|寡言|冷淡|高冷|克制|含蓄|慢热|嘴硬|傲娇|阴郁|多思|心思重|不善表达|不爱直说|口是心非/.test(blob);
  const blunt = /直球|直率|直接|外放|外向|话多|粘人|黏人|碎嘴|开朗|热情|坦率|不会拐弯|大大咧咧|爽朗|脸皮厚/.test(blob);
  const stage = s.stage || '';
  const days = Number(s.daysTogether) || 0;
  const longTogether = s.kind === 'romantic' && (
    s.flags.loveOrdinary
    || stage === 'settled'
    || stage === 'deep'
    || days >= 30
  );
  const earlyLove = s.kind === 'romantic' && (stage === 'new' || stage === 'warming') && days < 21;

  const lines = [
    '【情绪怎么说】怎么表达只跟【性格】与感情进度，不要另演一套说话技巧，也不要文艺旁白。',
  ];
  if (blunt && !reserved) {
    lines.push('直球/外放：喜欢、不爽、想你都可以直说。');
  }
  if (s.kind === 'romantic') {
    if (longTogether && stage !== 'strained' && stage !== 'cooling') {
      lines.push('已相处很久、爱意已日常：平淡一句即可。禁止每次都像第一次表白。');
    } else if (earlyLove) {
      lines.push('刚确认/热恋早期：可以新鲜、试探；直不直看【性格】。');
    }
  }
  lines.push('触景联想到对方时：可贴题轻带半句（语气/玩笑）；禁止为证明记得而硬扯；禁止「我忽然想起」「你说过」「看到X就像你因为Y」念稿句。');
  return lines.join('\n');
}

function buildAffectionPromptBlock(char) {
  if (!char?.id) return '';
  const state = ensureState(char);
  const temper = deriveBondTemperament(char);
  const stage = state.stage || 'warming';
  const ordinary = [];
  if (state.flags.nickOrdinary) ordinary.push('nick');
  if (state.flags.loveOrdinary) ordinary.push('love');
  if (state.flags.nsfwOrdinary) ordinary.push('nsfw');
  const d = Math.round(state.disappointment || 0);
  const fav = Math.round(state.attachment || 0);
  const lines = [
    `【bond】${state.kind || 'romantic'}/${stage}`
      + (ordinary.length ? ` · 已日常=${ordinary.join(',')}` : '')
      + (temper.loyaltyHigh ? ' · 很忠' : '')
      + ` · 亲近=${fav} · 失落=${d}`,
  ];
  if (state.stance) lines.push(`相处：${state.stance.slice(0, 120)}`);
  for (const fact of settledFactLines(state)) {
    if (fact) lines.push(`已知：${fact}`);
  }
  if (state.flags.coolingThought) {
    lines.push('有冷静/分开念头，但仍是这段关系；走不走看【性格】。');
  } else if (d >= 40) {
    lines.push('有点失落：可以少话、冷一点，不要突然变成第一天刚认识。');
  }
  if (temper.romantic && (stage === 'settling' || stage === 'settled' || stage === 'deep') && d < 50) {
    lines.push('硬性：已知称呼不要再震惊；不要每轮用「你不许反悔/别跑/要对你负责」「陪着你/哪也不去/守着你」这类收尾。');
  }
  const expr = buildEmotionExpressionHint(char, state);
  if (expr) lines.push(expr);
  return lines.join('\n');
}

function buildNsfwAffectionOverlay(char) {
  if (!char?.id) return '';
  const state = loadState(char);
  if (state.kind !== 'romantic') return '';
  if (state.stage === 'new') return '';
  const settled = state.flags.nsfwOrdinary || state.stage === 'settled' || state.stage === 'deep';
  if (settled) {
    return `【感情线·亲密已熟】你们不是第一次聊到亲密。禁止再演「怕对方会躲会跑」「第一次好紧张」「你不会后悔吧」。心态是已经熟悉彼此的人；节奏仍可按意愿快慢，但不要退回刚越界那天。`;
  }
  if (state.stage === 'settling' || state.stage === 'warming') {
    return `【感情线·亲密】你们已经是确认过的关系。即使用户把话题带向亲密，也不要默认对方会害羞逃走；紧张与否看【性格】，不是统一纯情。`;
  }
  return '';
}

function publicView(state, char) {
  const s = state || loadState(char);
  const temper = deriveBondTemperament(char || {});
  const facts = [];
  if (s.flags.nickOrdinary) {
    const nicks = (s.settledNicks || []).filter((n) => INTIMATE_NICK_RE.test(n));
    facts.push(nicks.length ? `称呼：${nicks.slice(0, 4).join('、')}` : '亲密称呼已日常');
  }
  if (s.flags.loveOrdinary) facts.push('说过爱');
  if (s.flags.nsfwOrdinary) facts.push('亲密话题已熟');
  if (s.flags.commitTalked) facts.push('谈过以后');
  if (s.flags.breakLandmineTold) facts.push('分手气话是雷区');
  if (s.flags.coolingThought) facts.push('有冷静/分开念头');
  return {
    kind: s.kind,
    stage: s.stage,
    stageLabel: ALL_STAGE_LABELS[s.stage] || s.stage,
    daysTogether: s.daysTogether || 0,
    daysKnown: s.daysKnown || 0,
    togetherSince: s.togetherSince || '',
    stance: s.stance || '',
    stillTender: s.stillTender || [],
    settled: facts,
    settledNicks: s.settledNicks || [],
    security: Math.round(s.security || 0),
    attachment: Math.round(s.attachment || 0),
    favor: Math.round(s.attachment || 0),
    disappointment: Math.round(s.disappointment || 0),
    loyaltyHigh: !!temper.loyaltyHigh,
    coolingThought: !!s.flags.coolingThought,
    breakLandmineTold: !!s.flags.breakLandmineTold,
    habits: {
      nickname: Math.round(s.habits?.nickname || 0),
      love: Math.round(s.habits?.love || 0),
      nsfw: Math.round(s.habits?.nsfw || 0),
    },
    history: (s.history || []).slice(-8),
    bootstrapped: !!s.bootstrapped,
    updatedAt: s.updatedAt,
  };
}

function getBrainAffection(charId) {
  const char = loadChar(charId);
  if (!char) return null;
  const state = ensureState(char);
  return publicView(state, char);
}

module.exports = {
  isRomanticBond,
  deriveBondTemperament,
  loadState,
  ensureState,
  touchAffectionFromMessage,
  rebuildAffection,
  tickAllAffections,
  bumpFromImportantMoment,
  buildAffectionPromptBlock,
  buildNsfwAffectionOverlay,
  getBrainAffection,
  publicView,
  hasBreakLandmineTold,
  applyDisappointment,
};

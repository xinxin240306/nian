/**
 * TA 双方使用时长：用户侧真实上报；角色侧按日程+性格虚构，忙时几乎不涨。
 */
const db = require('./db');

const CACHE_KEY = 'ta_char_usage_cache_v2';

const BUSY_RE = /上班|加班|开会|会议|工作|办公|值班|上课|学习|考试|面试|手术|培训|睡觉|入睡|过夜|午睡|小憩|通勤|开车|赶车|出差|外勤|健身|跑步|锻炼|洗澡|淋浴|洗漱/;
const PHONE_OK_RE = /刷手机|玩手机|刷短视频|刷抖音|摸鱼|躺平|休息|发呆|闲逛|刷剧|追剧|看剧|游戏|打游戏|聊天|回消息|摸鱼|宅|午睡完|醒着|没事/;
const COMMUTE_RE = /通勤|路上|地铁|公交|等车/;

/** 角色虚构使用时长的 App 池。「念」必出：你们就是靠它聊天的。 */
const APP_POOL = [
  { app: '念', weight: 4 },
  { app: '微信', weight: 3 },
  { app: '抖音', weight: 2 },
  { app: '网易云音乐', weight: 2 },
  { app: '微博', weight: 1 },
  { app: 'B站', weight: 2 },
  { app: '浏览器', weight: 1 },
  { app: '相册', weight: 1 },
  { app: '短信', weight: 1 },
  { app: '电话', weight: 1 },
  { app: '地图', weight: 1 },
];

function getSettingsMap() {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
}

function getLocalDateStr(date = new Date(), tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function getLocalMinutes(date = new Date(), tz = 'Asia/Shanghai') {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
    }).formatToParts(date);
    let h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
    if (h === 24) h = 0;
    return h * 60 + m;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

function timeToMinutes(t) {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

function parseItems(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function loadChar(charId) {
  return db.prepare(
    'SELECT id, name, timezone, personality, behavior, relationship FROM characters WHERE id=?'
  ).get(charId);
}

function loadScheduleItems(charId, dateStr) {
  const row = db.prepare(
    `SELECT items FROM schedules WHERE character_id=? AND role='ai' AND date=?`
  ).get(charId, dateStr);
  return parseItems(row?.items);
}

function slotPhoneFactor(activity) {
  const a = String(activity || '');
  if (!a) return 0.35;
  if (BUSY_RE.test(a) && !PHONE_OK_RE.test(a)) {
    if (/睡觉|入睡|过夜|午睡/.test(a)) return 0.02;
    if (/开会|上课|考试|手术/.test(a)) return 0.05;
    if (/上班|工作|加班|办公|值班/.test(a)) return 0.12;
    if (/健身|洗澡|洗漱/.test(a)) return 0.08;
    return 0.1;
  }
  if (PHONE_OK_RE.test(a)) return 0.85;
  if (COMMUTE_RE.test(a)) return 0.55;
  if (/吃饭|用餐|早餐|午餐|晚餐|咖啡|下午茶/.test(a)) return 0.4;
  return 0.3;
}

function personaPhoneAffinity(char) {
  const blob = `${char?.personality || ''} ${char?.behavior || ''}`;
  let m = 1;
  if (/社恐|宅|懒|刷手机|网瘾|熬夜|短视频|游戏/.test(blob)) m += 0.35;
  if (/勤奋|自律|戒手机|少玩|运动狂|工作狂/.test(blob)) m -= 0.25;
  if (String(char?.relationship || '') === 'lover') m += 0.08;
  return Math.max(0.45, Math.min(1.55, m));
}

function hashSeed(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function next() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function estimateDuration(activity, nextMins, startMins) {
  const a = String(activity || '');
  let dur = 40;
  if (/睡|入睡|过夜/.test(a) && !/午|小憩/.test(a)) dur = 480;
  else if (/午休|小憩|午睡/.test(a)) dur = 50;
  else if (/上班|工作|加班|办公|值班|上课/.test(a)) dur = 180;
  else if (/开会|会议/.test(a)) dur = 70;
  else if (/通勤|路上|地铁/.test(a)) dur = 50;
  else if (/健身|跑步/.test(a)) dur = 75;
  else if (/刷手机|玩手机|游戏|追剧/.test(a)) dur = 60;
  if (nextMins != null && nextMins > startMins) {
    dur = Math.min(dur, nextMins - startMins);
  }
  return Math.max(10, dur);
}

function buildDayApps(charId, dateStr, untilMinutes, rng, affinity) {
  const items = loadScheduleItems(charId, dateStr)
    .map((it) => ({
      mins: timeToMinutes(it.time),
      activity: String(it.activity || it.title || '').trim(),
    }))
    .filter((it) => it.activity && it.mins != null)
    .sort((a, b) => a.mins - b.mins);

  let phoneMinutes = 0;
  const endCap = Math.max(0, Math.min(24 * 60, untilMinutes));

  if (!items.length) {
    // 无日程：白天空闲里少量刷，夜里几乎不涨
    const wake = 8 * 60;
    const sleep = 23 * 60;
    const free = Math.max(0, Math.min(endCap, sleep) - wake);
    phoneMinutes = Math.round(free * 0.12 * affinity * (0.7 + rng() * 0.5));
  } else {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.mins >= endCap) break;
      const nextMins = i + 1 < items.length ? items[i + 1].mins : 24 * 60;
      const dur = estimateDuration(it.activity, nextMins, it.mins);
      const slotEnd = Math.min(endCap, it.mins + dur, nextMins);
      const span = Math.max(0, slotEnd - it.mins);
      if (span <= 0) continue;
      const factor = slotPhoneFactor(it.activity);
      phoneMinutes += span * factor * 0.22 * affinity * (0.75 + rng() * 0.4);

      // 两项之间的空闲：可以刷一会儿
      const gapStart = Math.min(endCap, it.mins + dur);
      const gapEnd = Math.min(endCap, nextMins);
      const gap = Math.max(0, gapEnd - gapStart);
      if (gap > 5) {
        phoneMinutes += gap * 0.28 * affinity * (0.6 + rng() * 0.5);
      }
    }
  }

  phoneMinutes = Math.round(Math.max(0, Math.min(10 * 60, phoneMinutes)));

  // 忙日总时长硬顶：若大半天 busy，总分钟压低
  let busySpan = 0;
  let covered = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.mins >= endCap) break;
    const nextMins = i + 1 < items.length ? items[i + 1].mins : endCap;
    const dur = estimateDuration(it.activity, nextMins, it.mins);
    const span = Math.max(0, Math.min(endCap, it.mins + dur) - it.mins);
    covered += span;
    if (slotPhoneFactor(it.activity) <= 0.15) busySpan += span;
  }
  if (covered > 0 && busySpan / covered >= 0.55) {
    phoneMinutes = Math.min(phoneMinutes, Math.round(45 + 40 * affinity));
  }

  const apps = distributeApps(phoneMinutes, rng);
  return { totalMinutes: phoneMinutes, apps };
}

function distributeApps(total, rng) {
  if (total <= 0) return [];
  const picks = [];
  let remain = total;
  const nian = APP_POOL.find((c) => c.app === '念') || { app: '念', weight: 4 };
  const others = APP_POOL.filter((c) => c.app !== '念').sort(() => rng() - 0.5);
  // 念固定进榜；其余再随机抽 2～5 个，避免「天天聊却看不到念」
  const n = 2 + Math.floor(rng() * 4);
  const chosen = [nian, ...others.slice(0, n)];
  const weights = chosen.map((c) => c.weight * (0.6 + rng()));
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < chosen.length; i++) {
    let mins = Math.round((total * weights[i]) / sumW);
    if (i === chosen.length - 1) mins = remain;
    mins = Math.max(0, Math.min(remain, mins));
    remain -= mins;
    if (mins > 0) picks.push({ app: chosen[i].app, minutes: mins });
  }
  if (remain > 0 && picks.length) picks[0].minutes += remain;
  // 有总时长时保证念至少有几分钟，别被四舍五入挤没
  if (total >= 8 && !picks.some((p) => p.app === '念')) {
    const floor = Math.min(remain || Math.max(5, Math.round(total * 0.12)), total);
    const donor = picks[0];
    if (donor && donor.minutes > floor) {
      donor.minutes -= floor;
      picks.push({ app: '念', minutes: floor });
    } else if (!picks.length) {
      picks.push({ app: '念', minutes: total });
    }
  }
  return picks.sort((a, b) => b.minutes - a.minutes);
}

function formatMinutes(n) {
  const m = Math.max(0, Math.round(Number(n) || 0));
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}小时${r}分钟` : `${h}小时`;
}

function ensureCharDayCache(charId) {
  const char = loadChar(charId);
  if (!char) return null;
  const tz = char.timezone || getSettingsMap().timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const nowMins = getLocalMinutes(new Date(), tz);
  let cache = {};
  try { cache = JSON.parse(getSettingsMap()[CACHE_KEY] || '{}') || {}; } catch { cache = {}; }
  const key = `${charId}:${today}`;
  const affinity = personaPhoneAffinity(char);
  const seed = hashSeed(`${key}:${String(char.personality || '').slice(0, 40)}`);
  const rng = mulberry32(seed);

  // 每小时可小幅刷新到「此刻」为止的累计，但同一天种子固定
  const hourBucket = Math.floor(nowMins / 60);
  const bucketKey = `${key}:h${hourBucket}`;
  if (cache[bucketKey]) return cache[bucketKey];

  const todayPack = buildDayApps(charId, today, nowMins, rng, affinity);

  // 昨天整日
  const yDate = new Date();
  yDate.setDate(yDate.getDate() - 1);
  const yesterday = getLocalDateStr(yDate, tz);
  const rngY = mulberry32(hashSeed(`${charId}:${yesterday}`));
  const yPack = buildDayApps(charId, yesterday, 24 * 60, rngY, affinity);

  const pack = {
    date: today,
    characterId: charId,
    todayMinutes: todayPack.totalMinutes,
    today: todayPack.apps,
    yesterdayMinutes: yPack.totalMinutes,
    yesterday: yPack.apps,
    updatedAt: new Date().toISOString(),
  };

  // 清旧桶，只留今天相关
  const next = {};
  for (const [k, v] of Object.entries(cache)) {
    if (String(k).startsWith(`${charId}:${today}`)) next[k] = v;
  }
  next[bucketKey] = pack;
  next[key] = pack;
  setSetting(CACHE_KEY, JSON.stringify(next));
  return pack;
}

function charUsageResult(charId, opts = {}) {
  const pack = ensureCharDayCache(charId);
  if (!pack) {
    return { ok: false, available: false, error: 'no_char', note: '没有角色使用时长。' };
  }
  const range = String(opts.range || 'today').toLowerCase();
  const key = range === 'yesterday' || range === '昨天' ? 'yesterday' : 'today';
  const apps = (pack[key] || []).slice();
  const total = key === 'yesterday' ? pack.yesterdayMinutes : pack.todayMinutes;
  const q = String(opts.query || '').trim().toLowerCase();
  let filtered = apps;
  if (q) filtered = apps.filter((a) => String(a.app).toLowerCase().includes(q));
  const limit = Math.min(15, Math.max(1, parseInt(opts.limit, 10) || 8));
  return {
    ok: true,
    available: true,
    side: 'character',
    range: key,
    totalMinutes: total,
    totalLabel: formatMinutes(total),
    apps: filtered.slice(0, limit).map((a) => ({
      app: a.app,
      minutes: a.minutes,
      label: formatMinutes(a.minutes),
    })),
    note: '这是对方（角色）那边手机的使用时长，按日程推的；忙的时候几乎不涨。不要当成精确监控。',
  };
}

function userUsageResult(opts = {}) {
  try {
    return require('./phone-state-helper').usageResult(opts);
  } catch (e) {
    return { ok: false, available: false, error: e.message };
  }
}

function getMutualUsage(charId) {
  return {
    ok: true,
    user: userUsageResult({ range: 'today', limit: 10 }),
    character: charUsageResult(charId, { range: 'today', limit: 10 }),
  };
}

/** 角色工具：双方或单侧 */
function toolUsage(characterId, args = {}) {
  const ta = require('./ta-helper');
  if (!ta.isBoundCharacter(characterId) || !ta.shareUsageOn()) {
    return {
      ok: false,
      available: false,
      error: 'usage_off',
      note: '对方没在 TA 里打开「互相看使用时长」，看不到。不要编造。',
    };
  }
  const side = String(args.side || 'user').toLowerCase();
  if (side === 'me' || side === 'character' || side === 'self') {
    return charUsageResult(characterId, args);
  }
  if (side === 'both' || side === 'mutual') {
    return getMutualUsage(characterId);
  }
  return userUsageResult(args);
}

module.exports = {
  ensureCharDayCache,
  charUsageResult,
  userUsageResult,
  getMutualUsage,
  toolUsage,
  formatMinutes,
};

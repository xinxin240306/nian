/**
 * 当天相处点：闲聊 / 深度 / 吵架 / 亲密 / 电话
 * 规则分类、按上午下午串成一条线，给角色「今天和对方干过什么」而不是只有近窗。
 */
const db = require('./db');

const FIGHT_RE = /分手|决裂|冷战|吵架|争吵|大吵|滚出去|给我滚|你滚|滚开|滚蛋|滚吧|恨你|讨厌你|再也不理|别来找我|你怎么这样|过分|不想理你|爱咋咋|随便你/;
const INTIMACY_RE = /亲亲|抱抱|摸摸|想你了|想做|做爱|接吻|吻我|舔|高潮|想要你|在床上|滚床单|色色|发情|抱紧/;
const DEEP_RE = /以前|小时候|童年|家里|我妈|我爸|工作|加班|压力|未来|怎么办|认真|害怕|委屈|喜欢你|爱你|我们之间|为什么对我们|在一起|结婚|抑郁|焦虑|不想瞒|跟你说一件|其实我/;
const CALL_RE = /通话结束|语音通话|视频通话/;
const KINDS = ['吵架', '电话', '亲密', '深度', '闲聊'];

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_chat_dots (
      character_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      dots TEXT DEFAULT '[]',
      last_msg_id INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (character_id, date)
    )
  `);
}

function getSettings() {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function localDateStr(date, tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date || new Date());
}

function parseMsgTime(ts) {
  if (!ts) return NaN;
  if (ts instanceof Date) return ts.getTime();
  const s = String(ts);
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : NaN;
}

function hourInTz(ms, tz) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return 12;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'hour')?.value) || 0;
}

function slotOfHour(h) {
  if (h < 5) return '夜里';
  if (h < 11) return '上午';
  if (h < 13) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚上';
  return '夜里';
}

function classifyBlob(text, type) {
  const t = String(text || '').replace(/\s+/g, '');
  const ty = String(type || '');
  if (CALL_RE.test(t) || /call/i.test(ty)) return '电话';
  if (FIGHT_RE.test(t)) return '吵架';
  if (INTIMACY_RE.test(t)) return '亲密';
  if (t.length >= 36 && DEEP_RE.test(t)) return '深度';
  if (t.length >= 80) return '深度';
  return '闲聊';
}

function compressDots(raw) {
  const out = [];
  for (const d of raw) {
    const last = out[out.length - 1];
    if (last && last.slot === d.slot && last.kind === d.kind) {
      last.n = (last.n || 1) + 1;
      continue;
    }
    out.push({ slot: d.slot, kind: d.kind, n: 1 });
  }
  return out.slice(-12);
}

function rebuild(charId, { tz, dateStr } = {}) {
  ensureTable();
  const cid = Number(charId);
  if (!cid) return [];
  const zone = tz || getSettings().timezone || 'Asia/Shanghai';
  const day = String(dateStr || localDateStr(new Date(), zone)).slice(0, 10);
  const rows = db.prepare(
    `SELECT id, role, content, type, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0
     ORDER BY id DESC LIMIT 400`
  ).all(cid);

  const ofDay = [];
  let maxId = 0;
  for (const m of rows) {
    const ms = parseMsgTime(m.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (localDateStr(new Date(ms), zone) !== day) continue;
    if (m.id > maxId) maxId = m.id;
    const ty = String(m.type || '');
    const body = String(m.content || '').trim();
    if (!body) continue;
    if (ty === 'system' && !CALL_RE.test(body)) continue;
    ofDay.push({
      id: m.id,
      slot: slotOfHour(hourInTz(ms, zone)),
      kind: classifyBlob(body, ty),
    });
  }
  ofDay.sort((a, b) => a.id - b.id);
  const dots = compressDots(ofDay);
  db.prepare(
    `INSERT INTO day_chat_dots (character_id, date, dots, last_msg_id, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(character_id, date) DO UPDATE SET
       dots=excluded.dots, last_msg_id=excluded.last_msg_id, updated_at=excluded.updated_at`
  ).run(cid, day, JSON.stringify(dots), maxId);
  return dots;
}

function loadDots(charId, dateStr) {
  ensureTable();
  const cid = Number(charId);
  if (!cid) return [];
  const zone = getSettings().timezone || 'Asia/Shanghai';
  const day = String(dateStr || localDateStr(new Date(), zone)).slice(0, 10);
  const lastId = db.prepare(
    `SELECT id FROM messages WHERE character_id=? AND is_dream=0 ORDER BY id DESC LIMIT 1`
  ).get(cid)?.id || 0;
  const row = db.prepare(
    `SELECT dots, last_msg_id FROM day_chat_dots WHERE character_id=? AND date=?`
  ).get(cid, day);
  if (row && Number(row.last_msg_id) === Number(lastId)) {
    try { return JSON.parse(row.dots || '[]'); } catch { return []; }
  }
  return rebuild(cid, { tz: zone, dateStr: day });
}

function formatForPrompt(charId) {
  const dots = loadDots(charId);
  if (!dots.length) return '';
  const line = dots.map((d) => `${d.slot}${d.kind}`).join(' → ');
  const kinds = [...new Set(dots.map((d) => d.kind))];
  const extra = kinds.includes('吵架')
    ? '今天吵过就记得吵过；别没事翻出来念，除非对方这轮在提。'
    : kinds.includes('深度')
      ? '今天深聊过就心里有数，接话时别当成一天只剩眼前这几句。'
      : '今天主要是闲聊也算过了一天，不是空白。';
  return `【今天和对方】${line}
这是你们今天相处过的点（闲聊/深度/吵架/亲密/电话），近窗只是眼前这一截。${extra}不要按点点名复盘。`;
}

module.exports = {
  KINDS,
  rebuild,
  loadDots,
  formatForPrompt,
  ensureTable,
};

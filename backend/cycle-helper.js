/**
 * 例假提醒：对方说「今天来了」就记下开始日。
 * 按周期在下一次快到的前几天，让角色提一句。提过这一轮就不再追。
 * 不报公式，也不每天盘问。
 */
const db = require('./db');

const DEFAULT_CYCLE_DAYS = 28;
const DEFAULT_LEAD_DAYS = 3;
const MIN_CYCLE_DAYS = 21;
const MAX_CYCLE_DAYS = 45;
const SAME_PERIOD_DAYS = 15;

const CYCLE_WORD_RE = /例假|姨妈|大姨妈|月经|生理期|经期|痛经/;
const START_RE = /(?:来了(?:例假|姨妈|大姨妈|月经|生理期|经期)|来(?:例假|姨妈|大姨妈|月经|生理期|经期)了|(?:例假|姨妈|大姨妈|月经|生理期|经期)(?:来了|到了|开始了)|(?:例假|姨妈|大姨妈|月经|生理期|经期)第[一1]天)/;
const STOP_RE = /(?:别|不要|不用|先别).{0,8}提醒.{0,12}(?:例假|姨妈|大姨妈|月经|生理期|经期)|(?:例假|姨妈|大姨妈|月经|生理期|经期).{0,10}(?:别|不要|不用).{0,4}提醒/;

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_cycle (
      character_id INTEGER PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      last_start TEXT DEFAULT '',
      cycle_days INTEGER DEFAULT 28,
      lead_days INTEGER DEFAULT 3,
      reminded_for TEXT DEFAULT '',
      offered_on TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function timezone() {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key='timezone'`).get();
    if (row?.value) return row.value;
  } catch { /* ignore */ }
  return 'Asia/Shanghai';
}

function localToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone(), year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d + Number(days || 0))).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const a = String(from || '').slice(0, 10);
  const b = String(to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return 0;
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const db_ = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((db_ - da) / 86400000);
}

function plainText(raw) {
  let t = String(raw || '').trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      t = String(j?.transcript || j?.text || '').trim() || t;
    } catch { /* keep */ }
  }
  return t;
}

function cnNum(token) {
  const d = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const s = String(token || '');
  if (d[s]) return d[s];
  if (s === '二十') return 20;
  if (s === '三十') return 30;
  if (s === '四十') return 40;
  if (/^二十[一二三四五六七八九]$/.test(s)) return 20 + d[s[2]];
  if (/^三十[一二三四五六七八九]$/.test(s)) return 30 + d[s[2]];
  if (/^四十[一二三四五]$/.test(s)) return 40 + d[s[2]];
  return 0;
}

function clampCycle(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < MIN_CYCLE_DAYS || x > MAX_CYCLE_DAYS) return 0;
  return Math.round(x);
}

function clampLead(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 1 || x > 7) return 0;
  return Math.round(x);
}

function clampInterval(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 15 || x > 60) return 0;
  return Math.round(x);
}

function clampPeriod(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 1 || x > 14) return 0;
  return Math.round(x);
}

function clampPain(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 1 || x > 10) return 0;
  return Math.round(x);
}

function profilePrefs() {
  const keys = ['user_cycle_interval', 'user_period_days', 'user_cramps', 'user_cramp_days'];
  const raw = {};
  try {
    const rows = db.prepare(
      `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
    ).all(...keys);
    for (const r of rows) raw[r.key] = String(r.value ?? '').trim();
  } catch { /* ignore */ }
  return {
    cycleDays: clampInterval(raw.user_cycle_interval),
    periodDays: clampPeriod(raw.user_period_days),
    cramps: raw.user_cramps === '1',
    crampDays: clampPain(raw.user_cramp_days),
  };
}

function writeSetting(key, value) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, String(value ?? ''));
}

function cycleDaysFor(row) {
  return profilePrefs().cycleDays || clampCycle(row?.cycle_days) || clampInterval(row?.cycle_days) || DEFAULT_CYCLE_DAYS;
}

function parseCycleUtterance(raw) {
  const text = plainText(raw);
  const out = { text, stop: false, start: false, cycleDays: 0, leadDays: 0 };
  if (!text) return out;
  out.stop = STOP_RE.test(text);

  const digitCycle = text.match(/(?:周期|一次|每隔|隔|大概|一般|通常|都是).{0,8}(\d{2})\s*天/);
  if (digitCycle) out.cycleDays = clampCycle(digitCycle[1]);
  if (!out.cycleDays) {
    const cnCycle = text.match(/(?:周期|一次|每隔|隔|大概|一般|通常|都是).{0,8}(四十[一二三四五]|三十[一二三四五六七八九]?|二十[一二三四五六七八九]?)\s*天/);
    if (cnCycle) out.cycleDays = clampCycle(cnNum(cnCycle[1]));
  }

  const digitLead = text.match(/提前\s*([1-7])\s*天/);
  if (digitLead) out.leadDays = clampLead(digitLead[1]);
  if (!out.leadDays) {
    const cnLead = text.match(/提前\s*([一二两三四五六七])\s*天/);
    if (cnLead) out.leadDays = clampLead(cnNum(cnLead[1]));
  }

  if (out.stop && !START_RE.test(text)) return out;
  if (/还没|没有来|没来|不会来|别来|不想来/.test(text)) return out;
  if (/(?:快要来|快来|要来了|要来|预感|估计要来|好像要来)/.test(text) && !/(?:今天|刚|刚刚).{0,8}来/.test(text)) return out;
  if (/(?:还记得|记不记得|你记得|忘了吗|上次|之前)/.test(text) && !/(?:今天|刚|刚刚)/.test(text)) return out;
  if (/(?:走了|结束了|干净了|停了)/.test(text) && !START_RE.test(text)) return out;
  out.start = START_RE.test(text);
  return out;
}

function getRow(charId) {
  ensureTable();
  return db.prepare('SELECT * FROM user_cycle WHERE character_id=?').get(Number(charId)) || null;
}

function saveRow(charId, patch) {
  ensureTable();
  const prev = getRow(charId) || {};
  const next = {
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : (prev.enabled == null ? 1 : prev.enabled),
    last_start: patch.last_start != null ? patch.last_start : (prev.last_start || ''),
    cycle_days: patch.cycle_days || prev.cycle_days || DEFAULT_CYCLE_DAYS,
    lead_days: patch.lead_days || prev.lead_days || DEFAULT_LEAD_DAYS,
    reminded_for: patch.reminded_for != null ? patch.reminded_for : (prev.reminded_for || ''),
    offered_on: patch.offered_on != null ? patch.offered_on : (prev.offered_on || ''),
  };
  db.prepare(
    `INSERT INTO user_cycle (character_id, enabled, last_start, cycle_days, lead_days, reminded_for, offered_on, updated_at)
     VALUES (?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(character_id) DO UPDATE SET
       enabled=excluded.enabled,
       last_start=excluded.last_start,
       cycle_days=excluded.cycle_days,
       lead_days=excluded.lead_days,
       reminded_for=excluded.reminded_for,
       offered_on=excluded.offered_on,
       updated_at=datetime('now')`
  ).run(
    Number(charId),
    next.enabled ? 1 : 0,
    next.last_start,
    next.cycle_days,
    next.lead_days,
    next.reminded_for,
    next.offered_on,
  );
}

function noteUserMessage(charId, raw) {
  const id = Number(charId);
  if (!id) return null;
  const parsed = parseCycleUtterance(raw);
  if (!parsed.stop && !parsed.start && !parsed.cycleDays && !parsed.leadDays) return null;
  const today = localToday();
  const prev = getRow(id);
  const patch = {};
  if (parsed.cycleDays) patch.cycle_days = parsed.cycleDays;
  if (parsed.leadDays) patch.lead_days = parsed.leadDays;
  if (parsed.cycleDays && !profilePrefs().cycleDays) {
    try { writeSetting('user_cycle_interval', String(parsed.cycleDays)); } catch { /* ignore */ }
  }

  if (parsed.stop && !parsed.start) {
    patch.enabled = 0;
    saveRow(id, patch);
    console.log(`[cycle] char#${id} reminders off`);
    return { action: 'stop' };
  }

  if (parsed.start) {
    patch.enabled = 1;
    let startDate = today;
    if (/前天/.test(parsed.text)) startDate = addDays(today, -2) || today;
    else if (/昨天|昨晚/.test(parsed.text)) startDate = addDays(today, -1) || today;
    const gap = prev?.last_start ? daysBetween(prev.last_start, startDate) : 999;
    if (!prev?.last_start || gap >= SAME_PERIOD_DAYS) {
      patch.last_start = startDate;
      patch.reminded_for = '';
      patch.offered_on = '';
      if (!parsed.cycleDays && !profilePrefs().cycleDays && gap >= MIN_CYCLE_DAYS && gap <= MAX_CYCLE_DAYS) {
        patch.cycle_days = gap;
      }
    }
    saveRow(id, patch);
    console.log(`[cycle] char#${id} start ${patch.last_start || prev?.last_start || startDate} every ${patch.cycle_days || prev?.cycle_days || DEFAULT_CYCLE_DAYS}d`);
    return { action: 'start', last_start: patch.last_start || prev?.last_start || startDate };
  }

  if (parsed.cycleDays || parsed.leadDays) {
    saveRow(id, patch);
    return { action: 'prefs' };
  }
  return null;
}

function peekDue(charId, today) {
  const row = getRow(charId);
  if (!row || !Number(row.enabled) || !row.last_start) return null;
  const cycleDays = cycleDaysFor(row);
  const leadDays = clampLead(row.lead_days) || DEFAULT_LEAD_DAYS;
  const nextStart = addDays(row.last_start, cycleDays);
  if (!nextStart || row.reminded_for === nextStart) return null;
  const windowStart = addDays(nextStart, -leadDays);
  if (!windowStart || today < windowStart || today > nextStart) return null;
  return {
    nextStart,
    windowStart,
    daysUntil: daysBetween(today, nextStart),
    lastStart: row.last_start,
    cycleDays,
    leadDays,
    offeredOn: row.offered_on || '',
  };
}

function mentionedSince(charId, sinceDate) {
  if (!sinceDate) return false;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT content FROM messages
       WHERE character_id=? AND role='assistant' AND COALESCE(is_dream,0)=0 AND COALESCE(recalled,0)=0
         AND substr(COALESCE(timestamp,''),1,10) >= ?
       ORDER BY id DESC LIMIT 40`
    ).all(Number(charId), sinceDate);
  } catch {
    return false;
  }
  return rows.some((r) => CYCLE_WORD_RE.test(plainText(r.content)));
}

function markReminded(charId, nextStart) {
  const id = Number(charId);
  const row = getRow(id);
  if (!row) return false;
  const next = nextStart || addDays(row.last_start, cycleDaysFor(row));
  if (!next) return false;
  if (row.reminded_for === next) return true;
  db.prepare(
    `UPDATE user_cycle SET reminded_for=?, updated_at=datetime('now') WHERE character_id=?`
  ).run(next, id);
  return true;
}

/** 到了该提的日子才有内容。已经提过、或这轮窗口里角色说过例假，就空。 */
function dueReminder(charId, todayStr) {
  const today = todayStr || localToday();
  const due = peekDue(charId, today);
  if (!due) return null;
  if (mentionedSince(charId, due.windowStart)) {
    markReminded(charId, due.nextStart);
    return null;
  }
  return due;
}

function monthDay(dateStr) {
  const [, m, d] = String(dateStr || '').split('-');
  if (!m || !d) return '';
  return `${Number(m)}月${Number(d)}日`;
}

function periodFacts() {
  const prefs = profilePrefs();
  const bits = [];
  if (prefs.periodDays) bits.push(`一次大概来${prefs.periodDays}天`);
  if (prefs.cramps && prefs.crampDays) bits.push(`会痛经，开头${prefs.crampDays}天比较疼`);
  else if (prefs.cramps) bits.push('会痛经');
  else if (prefs.periodDays) bits.push('一般不痛经');
  return bits.join('。');
}

function activePeriod(charId, todayStr) {
  const row = getRow(charId);
  if (!row || !Number(row.enabled) || !row.last_start) return null;
  const prefs = profilePrefs();
  if (!prefs.periodDays) return null;
  const today = todayStr || localToday();
  const dayIndex = daysBetween(row.last_start, today) + 1;
  if (dayIndex < 1 || dayIndex > prefs.periodDays) return null;
  return {
    lastStart: row.last_start,
    dayIndex,
    periodDays: prefs.periodDays,
    hurting: !!(prefs.cramps && prefs.crampDays && dayIndex <= prefs.crampDays),
    crampDays: prefs.crampDays,
  };
}

function promptBlock(charId, opts = {}) {
  const due = dueReminder(charId);
  const today = localToday();
  if (due) {
    if (!opts.force && due.offeredOn === today) return '';
    const row = getRow(charId);
    if (row && row.offered_on !== today) {
      db.prepare(`UPDATE user_cycle SET offered_on=?, updated_at=datetime('now') WHERE character_id=?`).run(today, Number(charId));
    }
    const when = due.daysUntil <= 0 ? '大概就是这几天' : `大概还有${due.daysUntil}天`;
    const from = monthDay(due.lastStart);
    const facts = periodFacts();
    return `【例假·快到了】你记得对方${from}来过例假。按对方自己定的间隔，下一次${when}。${facts ? `${facts}。` : ''}用你自己的口气提一句就好，别像闹钟，别说你在算周期，别追问痛不痛。这轮已经提过就不要再提。`;
  }
  if (opts.force) return '';
  const active = activePeriod(charId, today);
  if (!active) return '';
  const from = monthDay(active.lastStart);
  const pain = active.hurting
    ? `今天还在痛经那几天（开头${active.crampDays}天会疼）。`
    : (active.crampDays ? '痛经那几天已经过了。' : '');
  return `【例假·这几天】对方这轮从${from}开始，一般来${active.periodDays}天，今天是第${active.dayIndex}天。${pain}这是你心里有数的事：对方没提就别反复问，对方说不舒服时自然照应，别报进度。`;
}

module.exports = {
  DEFAULT_CYCLE_DAYS,
  DEFAULT_LEAD_DAYS,
  parseCycleUtterance,
  addDays,
  daysBetween,
  noteUserMessage,
  dueReminder,
  markReminded,
  promptBlock,
};

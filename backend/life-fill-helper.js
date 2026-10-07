/**
 * 日程只是骨架。出日程时把「这一天怎么过」补进 items[].lived，
 * 不把还没到的时段标成已结束。深刻的才进自己的生活记忆。
 * 熟人/常去处只在重复出现后沉淀，不强制社交。
 * 说过的明天去向锁住，避免第二天日程打脸。
 */
const db = require('./db');

const CITY_RE = /北京|上海|广州|深圳|杭州|南京|苏州|成都|重庆|武汉|西安|天津|长沙|郑州|青岛|大连|厦门|福州|合肥|济南|沈阳|哈尔滨|长春|昆明|南昌|太原|石家庄|贵阳|南宁|海口|三亚|兰州|银川|西宁|乌鲁木齐|拉萨|呼和浩特|香港|澳门|台北|宁波|无锡|佛山|东莞|珠海|中山|温州|嘉兴|金华|绍兴|台州|扬州|南通|常州|徐州|烟台|威海|洛阳|桂林|丽江|大理|黄山/;
const FIXED_RE = /宴会|晚宴|出席|典礼|婚礼|发布会|演出|考试|上班|开会|会议|汇报|面试|航班|登机|典礼/;

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS char_life_cast (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      kind TEXT DEFAULT 'person',
      name TEXT NOT NULL,
      note TEXT DEFAULT '',
      seen INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS char_future_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      place TEXT NOT NULL,
      reason TEXT DEFAULT '',
      source TEXT DEFAULT 'chat',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  try { db.exec(`ALTER TABLE schedules ADD COLUMN day_note TEXT DEFAULT ''`); } catch { /* 已有 */ }
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function localDateStr(date = new Date(), tz = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseItems(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const p = JSON.parse(raw || '[]');
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function parseJson(raw) {
  const text = String(raw || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

function cityIn(text) {
  const m = String(text || '').match(CITY_RE);
  return m ? m[0] : '';
}

function isHighSalience(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'high' || s === '深刻' || s === '是') return true;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0.65;
}

function scheduleRow(charId, dateStr) {
  ensureTables();
  return db.prepare(
    `SELECT * FROM schedules WHERE character_id=? AND role='ai' AND date=?`
  ).get(Number(charId), dateStr);
}

function getDayNote(charId, dateStr) {
  try {
    ensureTables();
    const row = scheduleRow(charId, dateStr);
    return String(row?.day_note || '').trim();
  } catch {
    return '';
  }
}

function saveDayNote(charId, dateStr, note) {
  ensureTables();
  const row = scheduleRow(charId, dateStr);
  if (!row) return;
  db.prepare(`UPDATE schedules SET day_note=?, updated_at=datetime('now') WHERE id=?`)
    .run(String(note || '').trim().slice(0, 200), row.id);
}

function listCast(charId, { minSeen = 2 } = {}) {
  ensureTables();
  return db.prepare(
    `SELECT kind, name, note, seen FROM char_life_cast
     WHERE character_id=? AND seen>=? ORDER BY seen DESC, id DESC LIMIT 8`
  ).all(Number(charId), minSeen);
}

function bumpCast(charId, kind, name, note) {
  const n = String(name || '').trim().slice(0, 16);
  if (!n || n.length < 2) return;
  if (/用户|对方|旅人|手机|自己/.test(n)) return;
  ensureTables();
  const kindOk = kind === 'place' ? 'place' : 'person';
  const hit = db.prepare(
    `SELECT id, seen FROM char_life_cast WHERE character_id=? AND name=? LIMIT 1`
  ).get(Number(charId), n);
  if (hit) {
    db.prepare(`UPDATE char_life_cast SET seen=?, note=?, kind=?, updated_at=datetime('now') WHERE id=?`)
      .run((hit.seen || 1) + 1, String(note || '').slice(0, 40), kindOk, hit.id);
  } else {
    db.prepare(
      `INSERT INTO char_life_cast (character_id, kind, name, note, seen) VALUES (?,?,?,?,1)`
    ).run(Number(charId), kindOk, n, String(note || '').slice(0, 40));
  }
}

function lockPlan(charId, dateStr, place, reason, source = 'chat') {
  const p = cityIn(place) || String(place || '').trim().slice(0, 12);
  if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  ensureTables();
  const cid = Number(charId);
  const hit = db.prepare(
    `SELECT id FROM char_future_plans WHERE character_id=? AND date=? LIMIT 1`
  ).get(cid, dateStr);
  const why = String(reason || '').trim().slice(0, 60);
  if (hit) {
    db.prepare(`UPDATE char_future_plans SET place=?, reason=?, source=? WHERE id=?`)
      .run(p, why, source, hit.id);
  } else {
    db.prepare(
      `INSERT INTO char_future_plans (character_id, date, place, reason, source) VALUES (?,?,?,?,?)`
    ).run(cid, dateStr, p, why, source);
  }
  try { alignWeekPlan(cid, dateStr, p); } catch { /* ignore */ }
  return { date: dateStr, place: p };
}

function alignWeekPlan(charId, dateStr, place) {
  const row = db.prepare('SELECT schedule_week_plan FROM characters WHERE id=?').get(Number(charId));
  if (!row?.schedule_week_plan) return;
  let plan;
  try { plan = JSON.parse(row.schedule_week_plan); } catch { return; }
  const day = (plan?.days || []).find((d) => String(d.date) === String(dateStr));
  if (!day) return;
  if (String(day.place || '') === place) return;
  day.place = place;
  if (day.note && !String(day.note).includes(place)) {
    day.note = `${place}。${String(day.note)}`.slice(0, 80);
  }
  db.prepare('UPDATE characters SET schedule_week_plan=? WHERE id=?')
    .run(JSON.stringify(plan), Number(charId));
}

function plansAround(charId, today) {
  ensureTables();
  const end = shiftDate(today, 2);
  return db.prepare(
    `SELECT date, place, reason, source FROM char_future_plans
     WHERE character_id=? AND date>=? AND date<=? ORDER BY date ASC`
  ).all(Number(charId), today, end);
}

function lockedPlaceForDate(charId, dateStr) {
  ensureTables();
  const row = db.prepare(
    `SELECT place FROM char_future_plans WHERE character_id=? AND date=? LIMIT 1`
  ).get(Number(charId), dateStr);
  return cityIn(row?.place) || String(row?.place || '').trim();
}

function promptLockLine(charId, today) {
  const rows = plansAround(charId, today);
  if (!rows.length) return '';
  const tomorrow = shiftDate(today, 1);
  const after = shiftDate(today, 2);
  const bits = rows.map((r) => {
    const label = r.date === today ? '今天' : (r.date === tomorrow ? '明天' : (r.date === after ? '后天' : r.date));
    return `${label}已定在${r.place}${r.reason ? `（${r.reason}）` : ''}`;
  });
  return `${bits.join('；')}。问到去哪只能按这个说；没写明的日子说还没定，禁止另编城市。`;
}

function applyLockedPlace(items, place) {
  if (!place) return items;
  return items.map((it) => {
    const act = String(it.activity || '');
    if (/回家|返程|到家|在家/.test(act)) return it;
    return { ...it, place };
  });
}

function captureTomorrowFromItems(charId, today, items) {
  for (const it of items || []) {
    const act = `${it.activity || ''} ${it.place || ''}`;
    if (!/明天|明日/.test(act)) continue;
    const city = cityIn(act);
    if (!city) continue;
    lockPlan(charId, shiftDate(today, 1), city, String(it.activity || '').slice(0, 40), 'schedule');
  }
}

function maybeLockPlansFromTurn(charId, options = {}) {
  if (!charId) return;
  const tz = getSettings().timezone || 'Asia/Shanghai';
  const today = localDateStr(new Date(), tz);
  let assistant = '';
  let user = '';
  try {
    if (options.assistantMsgId) {
      assistant = db.prepare('SELECT content FROM messages WHERE id=?').get(options.assistantMsgId)?.content || '';
    }
    if (options.userMsgId) {
      user = db.prepare('SELECT content FROM messages WHERE id=?').get(options.userMsgId)?.content || '';
    }
  } catch { /* ignore */ }
  const blob = `${user}\n${assistant}`;
  let dayOff = 0;
  if (/后天/.test(blob)) dayOff = 2;
  else if (/明天|明日/.test(blob)) dayOff = 1;
  if (!dayOff) return;
  const city = cityIn(assistant) || cityIn(blob);
  if (!city) return;
  if (!/去|出发|飞|旅游|旅行|出差|玩|到|抵达|在/.test(blob)) return;
  lockPlan(charId, shiftDate(today, dayOff), city, assistant.slice(0, 48) || user.slice(0, 48), 'chat');
}

function yesterdayBits(charId, today) {
  const yest = shiftDate(today, -1);
  const row = scheduleRow(charId, yest);
  const items = parseItems(row?.items);
  const lines = items.slice(-4).map((it) => {
    const story = String(it.lived || it.thought || '').trim();
    return `${it.time || ''} ${it.activity || ''}${story ? `：${story.slice(0, 80)}` : ''}`.trim();
  }).filter(Boolean);
  const bits = [];
  if (row?.day_note) bits.push(`昨天的底色：${String(row.day_note).slice(0, 80)}`);
  if (lines.length) bits.push(`昨天末段：${lines.join('；').slice(0, 280)}`);
  return bits;
}

function conflictBit(charId) {
  try {
    const rows = db.prepare(
      `SELECT role, content FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0
       AND (type IS NULL OR type != 'system')
       ORDER BY id DESC LIMIT 40`
    ).all(Number(charId));
    const text = rows.map((r) => r.content || '').join('\n');
    const fought = /吵架|冷战|别烦我|滚|讨厌你|不想理/.test(text);
    const madeUp = /和好|没事了|算了|不气了|原谅/.test(text.slice(0, 400));
    if (fought && !madeUp) return '和对方可能还没说开（聊天里吵过，后面没看到和好）。这只影响今天的状态，不要把吵架写成今天的活动。';
  } catch { /* ignore */ }
  return '';
}

function moodBit(charId) {
  try {
    const raw = db.prepare('SELECT emotion_state FROM characters WHERE id=?').get(Number(charId))?.emotion_state;
    const es = JSON.parse(raw || '{}');
    const v = Number(es.valence);
    if (!Number.isFinite(v)) return '';
    const anger = Number(es.fuel?.anger) || 0;
    const hurt = Number(es.fuel?.hurt) || 0;
    let tone = '平';
    if (v <= -25 || anger >= 40 || hurt >= 40) tone = '压着、提不起劲';
    else if (v >= 30) tone = '松一点';
    return `醒来时的情绪大致是${tone}`;
  } catch {
    return '';
  }
}

function carryoverForSchedule(char, today) {
  if (!char?.id) return '';
  const bits = [
    ...yesterdayBits(char.id, today),
    conflictBit(char.id),
    moodBit(char.id),
  ].filter(Boolean);
  try {
    const promiseLock = require('./char-promise-helper').formatForSchedule(char.id);
    if (promiseLock) bits.push(promiseLock);
  } catch { /* ignore */ }
  if (!bits.length) return '';
  return `【昨天留下的，只影响今天的状态】\n${bits.join('\n')}\n不可推脱的事（宴会/出席/上班/考试/已定行程）必须留在表上，只影响心情和发挥。能动的时段才可以晚起、取消社交、改成独处。不要把昨天的事写成今天的活动标题。`;
}

function castHint(charId) {
  const rows = listCast(charId, { minSeen: 2 });
  if (!rows.length) return '';
  return `【偶尔会再出现的人和地方·不是必须用】\n${rows.map((r) => `- ${r.name}${r.note ? `：${r.note}` : ''}`).join('\n')}\n只有这段生活自然用到他们时才出现，保持跟以前一致。不爱社交就一个人过，禁止为了热闹硬塞人。`;
}

async function callJson(settings, sys, user) {
  const { callChatAPIComplete } = require('./api-helper');
  let raw = '';
  try {
    raw = await callChatAPIComplete(settings, sys, user, 'memory', [], {
      maxTokens: 1400, temperature: 0.7, timeout: 90000, noContinue: true,
    });
  } catch { /* fallback */ }
  if (!raw) {
    raw = await callChatAPIComplete(settings, sys, user, 'diary', [], {
      maxTokens: 1400, temperature: 0.7, timeout: 90000, noContinue: true,
    });
  }
  return parseJson(raw);
}

async function fillDayLife(charId, dateStr, opts = {}) {
  ensureTables();
  const row = scheduleRow(charId, dateStr);
  if (!row) return { ok: false, reason: 'no_schedule' };
  const items = parseItems(row.items);
  if (!items.length) return { ok: false, reason: 'empty' };
  if (opts.onlyIfEmpty && items.some((it) => String(it.lived || '').trim().length > 8)) {
    return { ok: true, skipped: true };
  }
  const char = opts.char || db.prepare('SELECT * FROM characters WHERE id=?').get(Number(charId));
  if (!char) return { ok: false, reason: 'no_char' };
  const settings = opts.settings || getSettings();
  const skeleton = items.map((it) => {
    const fixed = FIXED_RE.test(`${it.activity || ''}`);
    return `${it.time || '—'} ${it.activity || ''}${it.place ? `（${it.place}）` : ''}${fixed ? '【推不掉】' : ''}`;
  }).join('\n');
  const carry = carryoverForSchedule(char, dateStr);
  const cast = castHint(charId);
  const lock = promptLockLine(charId, dateStr);
  const sys = `你在补「${char.name}」这一天自己的生活，不是写小说，也不是写和用户的聊天记录。
他在过自己的日子，手机只是缝隙，像异地恋：有空才回，禁止写成守着手机等消息，禁止一天都在想用户。
按性格和处事方式写他怎么度过。不爱社交就一个人过：具体动作、走神、别扭、小事。禁止为了热闹硬塞饭局和路人。
不可推脱的时段照样去做，昨天的事只影响心情和发挥（走神、强撑、提前走、心不在焉）。
每段 1～2 句。一天里最多 2 段 salience 为 high，其余 low。多数日子平淡。
只输出 JSON：
{"day_note":"今天的底色，一句","slots":[{"time":"与输入一致","lived":"这段怎么过的","salience":"low|high"}],"cast":[{"kind":"person|place","name":"","note":"一句"}]}
cast 只填正文里真的出现过的人名或常去处；没有就空数组。禁止虚构完整对话和一串陌生人。`;
  const user = `${carry || '（昨天没有特别留下的事）'}

${lock || ''}
${cast || ''}

【性格】${String(char.personality || '').slice(0, 240)}
【处事】${String(char.behavior || '').slice(0, 160)}

【今天 ${dateStr} 的骨架】
${skeleton}`;
  const parsed = await callJson(settings, sys, user);
  if (!parsed || !Array.isArray(parsed.slots)) return { ok: false, reason: 'parse' };

  const byTime = new Map();
  for (const s of parsed.slots) {
    const t = String(s.time || '').trim();
    if (t) byTime.set(t, s);
  }
  let high = 0;
  const next = items.map((it, i) => {
    const hit = byTime.get(String(it.time || '').trim()) || parsed.slots[i] || {};
    let sal = isHighSalience(hit.salience) ? 'high' : 'low';
    if (sal === 'high') {
      high += 1;
      if (high > 2) sal = 'low';
    }
    const lived = String(hit.lived || '').trim().slice(0, 180);
    return {
      ...it,
      lived: lived || String(it.lived || ''),
      salience: lived ? sal : (it.salience || ''),
    };
  });
  db.prepare(`UPDATE schedules SET items=?, day_note=?, updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(next), String(parsed.day_note || '').trim().slice(0, 200), row.id);

  const blob = next.map((it) => it.lived || '').join('\n');
  for (const c of (Array.isArray(parsed.cast) ? parsed.cast : [])) {
    const name = String(c.name || '').trim();
    if (!name || !blob.includes(name)) continue;
    bumpCast(charId, c.kind, name, c.note);
  }
  const saved = writeSalientLife(charId, dateStr, next);
  return { ok: true, high: saved };
}

function writeSalientLife(charId, dateStr, items) {
  const brain = require('./memory-brain-helper');
  let n = 0;
  for (const it of items || []) {
    if (String(it.salience) !== 'high') continue;
    const lived = String(it.lived || '').trim();
    if (!lived) continue;
    const time = String(it.time || '').trim();
    const ir = brain.insertMemory({
      characterId: Number(charId),
      category: '日常点滴',
      content: `${dateStr} ${time}，自己的日子：${it.activity || ''}。${lived}`.slice(0, 400),
      weight: 0.74,
      date: dateStr,
      source: 'life',
      factKey: `life:${charId}:${dateStr}:${time || it.activity}`,
      keywords: [String(it.activity || '').slice(0, 12)].filter(Boolean),
    });
    if (ir?.id && !ir.duplicate) n += 1;
  }
  return n;
}

function leafIdleChat(charId, beforeDate) {
  if (!beforeDate) return 0;
  const cutoff = shiftDate(beforeDate, -1);
  const r = db.prepare(
    `UPDATE memories SET status='historical', weight=MIN(weight, 0.2)
     WHERE character_id=? AND COALESCE(status,'current')='current'
     AND COALESCE(archived,0)=0
     AND date!='' AND date<=?
     AND weight<=0.28
     AND content LIKE '%【闲聊】%'
     AND COALESCE(source,'') NOT IN ('life','schedule','schedule_day')`
  ).run(Number(charId), cutoff);
  return r.changes || 0;
}

async function digestCognition(charId, dateStr, settings) {
  const char = db.prepare('SELECT id, name, personality, mindset FROM characters WHERE id=?').get(Number(charId));
  if (!char) return { ok: false, reason: 'no_char' };
  const row = scheduleRow(charId, dateStr);
  const lifeLines = parseItems(row?.items)
    .filter((it) => String(it.lived || '').trim())
    .map((it) => `${it.time || ''} ${it.activity || ''}：${String(it.lived).slice(0, 100)}${it.salience === 'high' ? '（深刻）' : ''}`);
  const chats = db.prepare(
    `SELECT category, content FROM memories
     WHERE character_id=? AND date=? AND COALESCE(archived,0)=0
     AND COALESCE(source,'') NOT IN ('life','schedule','schedule_day')
     ORDER BY id DESC LIMIT 12`
  ).all(Number(charId), dateStr);
  if (!lifeLines.length && !chats.length) return { ok: false, reason: 'nothing' };
  const sys = `你在帮「${char.name}」把这一天收成「怎么看」：角色视角的一句事实。只输出 JSON。
{"user":[{"category":"性格|情绪|想法|喜好|习惯|不擅长|人际关系|样子|其他","content":"对对方的一句稳定事实，6-20字"}],"self":[{"category":"性格|行为习惯|喜好|经历|变化|其他","content":"对自己的一句，第一人称"}]}
硬性规则：
· user = 从聊天里看出来的对方；必须是站得住的短句事实，不是事件复述、不是半截话、不是提问、不是「我觉得对方好像…」式脑补
· 性格=脾气气质；情绪=一生气/难过时会怎样；想法=在意点/思维方式（想很多、不喜欢被冷落）；喜好=具体物偏好；习惯=作息处事
· 禁止把性格丢进习惯；禁止把想法丢进喜好
· self=从自己这一天的反应里认识的自己；变化用「以前我会…现在我会…」
· 一次性小事、流水账、无依据 → 不要写。没有就空数组。禁止编造。`;
  const user = `【性格底色】${String(char.personality || '').slice(0, 160)}
【心智】${String(char.mindset || '').slice(0, 240) || '（无）'}

【自己的生活 ${dateStr}】
${lifeLines.join('\n') || '（没有留下经过）'}

【和对方的事】
${chats.map((m) => `- ${m.content}`).join('\n') || '（没有）'}`;
  const parsed = await callJson(settings || getSettings(), sys, user);
  if (!parsed) return { ok: false, reason: 'parse' };
  const cron = require('./cron');
  const userItems = (Array.isArray(parsed.user) ? parsed.user : []).map((it) => {
    const content = String(it.content || '').trim().slice(0, 28);
    if (!content || (typeof cron.isJunkImpressionFact === 'function' && cron.isJunkImpressionFact(content))) return null;
    const category = mapUserCat(it.category, content);
    if (!category) return null;
    return {
      category,
      content,
      confirmed: category === '其他' ? 0 : 1,
    };
  }).filter(Boolean);
  const selfItems = (Array.isArray(parsed.self) ? parsed.self : []).map((it) => ({
    category: mapSelfCat(it.category),
    content: String(it.content || '').trim().slice(0, 28),
    source: 'lived',
    confirmed: 0,
  })).filter((it) => it.category && it.content);
  let userN = 0;
  let selfN = 0;
  if (userItems.length) {
    try { userN = cron.mergeImpressionItems(charId, userItems) || 0; } catch (e) {
      console.warn('[life] impression', e.message);
    }
  }
  if (selfItems.length) {
    try {
      selfN = require('./char-self-helper').mergeSelfViewItems(charId, selfItems, { source: 'lived', mode: 'seed' }) || 0;
    } catch (e) {
      console.warn('[life] self', e.message);
    }
  }
  return { ok: true, user: userN, self: selfN };
}

function mapUserCat(cat, content = '') {
  const c = String(cat || '').trim();
  try {
    const cron = require('./cron');
    if (typeof cron.resolveImpressionCategory === 'function') {
      const resolved = cron.resolveImpressionCategory(c, content);
      if (resolved) return resolved;
    }
  } catch { /* ignore */ }
  if (c === '爱好' || c === '喜好') return '喜好';
  if (c === '性格') return '性格';
  if (c === '情绪' || c === '情绪反应') return '情绪';
  if (c === '想法' || c === '在意') return '想法';
  if (c === '习惯') return '习惯';
  if (c === '不擅长') return '不擅长';
  if (c === '人际关系') return '人际关系';
  if (c === '样子') return '样子';
  if (c === '其他') return '其他';
  return '';
}

function mapSelfCat(cat) {
  const c = String(cat || '').trim();
  if (c === '爱好' || c === '喜好') return '喜好';
  if (c === '性格') return '性格';
  if (c === '习惯' || c === '行为习惯') return '行为习惯';
  if (c === '变化') return '变化';
  if (c === '经历') return '经历';
  if (c === '其他') return '其他';
  return '';
}

function listCognition(charId) {
  const user = [];
  const self = [];
  try {
    user.push(...db.prepare(
      `SELECT category, content FROM char_impressions WHERE character_id=? ORDER BY id DESC LIMIT 40`
    ).all(Number(charId)));
  } catch { /* ignore */ }
  try {
    self.push(...db.prepare(
      `SELECT category, content FROM char_self_views WHERE character_id=? ORDER BY id DESC LIMIT 40`
    ).all(Number(charId)));
  } catch { /* ignore */ }
  return {
    user: user.map((r) => ({ category: r.category || '其他', content: r.content })),
    self: self.map((r) => ({ category: r.category || '其他', content: r.content })),
  };
}

module.exports = {
  ensureTables,
  getDayNote,
  carryoverForSchedule,
  promptLockLine,
  lockedPlaceForDate,
  applyLockedPlace,
  captureTomorrowFromItems,
  maybeLockPlansFromTurn,
  fillDayLife,
  leafIdleChat,
  digestCognition,
  listCognition,
  listCast,
};

/**
 * 角色眼里的用户（画像）：分「近况」和「本人事实」两块，一条一条的判断，点开才是当时为什么这么总结。
 * 来源是当天和用户的聊天总结（按顺序排好、去掉衔接重复后整体消化），不是角色自己的日程。
 * about='self' 是角色对自己的判断，仍由日子消化。
 */
const db = require('./db');

function formatPortraitApiError(err) {
  const msg = String(err?.message || err || '');
  if (!msg) return '';
  try {
    const formatted = require('./api-helper').formatApiBillingError(msg, { label: '画像消化' });
    if (formatted) return formatted;
  } catch { /* ignore */ }
  if (/quota|余额|积分|billing|pre_consume|token remain/i.test(msg)) {
    return '画像消化失败：API 额度不足，请充值或换模型后再试';
  }
  if (/API error\s*403/i.test(msg)) return '画像消化失败：API 拒绝（403），请检查额度或密钥';
  if (/API error\s*401/i.test(msg)) return '画像消化失败：API 密钥无效';
  return msg.length > 160 ? `画像消化失败：${msg.slice(0, 160)}…` : `画像消化失败：${msg}`;
}

const FACT_CATEGORIES = ['性格', '喜恶', '行为习惯', '情绪反应', '人际关系', '其他'];
const RECENT_CATEGORIES = ['在忙', '计划', '烦心事', '状态', '其他'];
const SELF_CATEGORIES = ['性格', '行为', '喜好', '习惯', '变化'];
const CATEGORIES = FACT_CATEGORIES;
const JUDGMENT_MAX = 48;
const REASON_MAX = 180;
const REACT_JUDGMENT_MAX = 56;
const REACT_REASON_MAX = 220;

function judgmentCap(category) {
  return category === '情绪反应' ? REACT_JUDGMENT_MAX : JUDGMENT_MAX;
}
function reasonCap(category) {
  return category === '情绪反应' ? REACT_REASON_MAX : REASON_MAX;
}
const PER_CAT = 8;
const PER_RECENT_CAT = 6;
const RECENT_TTL_DAYS = 14;
const WHY_RE = /为什么觉得|为什么会觉得|为什么说我|怎么看出来|怎么会觉得|凭什么|凭啥|你怎么知道我|凭什么觉得|凭啥觉得/;
const NEG_RE = /难过|伤心|想哭|哭了|在哭|委屈|烦死|好烦|烦躁|心烦|生气|气死|火大|崩溃|焦虑|害怕|失眠|睡不着|累死|好累|心累|压力好大|压力大|郁闷|低落|不开心|难受|好丧|emo|绝望|孤独|寂寞|烦不烦|无语|服了|😭|😢|😡|😞|💔/i;
const PUSHBACK_RE = /知道了|晓得了|又来了|别念|别说了|别管|啰嗦|唠叨|烦不烦|管我|老说|每次都|说过了|行了行了|够了/;
const COOLDOWN_DAYS = [3, 7, 14];
const NAG_COOLDOWN_DAYS = 30;
const OFFER_CHANCE = 1 / 3;
const BAD_HABIT_CHANCE = 0.5;
const KNOW_MAX = 6;
const KEY_RULES = `每条都要带：
- triggers 联想词：对方说到哪些词时，你会想起这条。2～6 个短词，要想到生活里的联想，不只是原句里的字。例如「头发老吹半干」→ 洗澡、洗头、吹头发、睡前、头疼。
- marks 标记词：你真的提起这条时，话里一定会出现的词。1～4 个。例如「头发老吹半干」→ 吹干、半干、头发。
- bad_habit（只有 facts 要）：这是不是对身体或生活不好的习惯，比如熬夜、头发不吹干、不吃早饭、久坐。是就 true，否则 false。
- upset_signs（只有 facts 里的情绪反应、性格要，其余空数组）：对方不高兴时会说出口的原话或短回，0～6 个，每个不超过 6 个字。例如 没事、随便、随便你、嗯、晚安、你忙吧、我睡了。要的是能在聊天里直接对上的字，不是描述。`;

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS char_user_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT '性格',
      judgment TEXT NOT NULL,
      reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_char_user_reads_char ON char_user_reads(character_id)`);
  try { db.exec(`ALTER TABLE char_user_reads ADD COLUMN about TEXT DEFAULT 'user'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE char_user_reads ADD COLUMN source TEXT DEFAULT 'manual'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE char_user_reads ADD COLUMN section TEXT DEFAULT 'fact'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE char_user_reads ADD COLUMN last_seen TEXT DEFAULT ''`); } catch { /* exists */ }
  for (const col of [
    `triggers TEXT DEFAULT '[]'`,
    `marks TEXT DEFAULT '[]'`,
    `bad_habit INTEGER DEFAULT 0`,
    `mention_count INTEGER DEFAULT 0`,
    `last_mentioned TEXT DEFAULT ''`,
    `last_said TEXT DEFAULT ''`,
    `nag_until TEXT DEFAULT ''`,
    `upset_signs TEXT DEFAULT ''`,
  ]) {
    try { db.exec(`ALTER TABLE char_user_reads ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

function parseArr(s) {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a.map((x) => String(x || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function cleanKeys(arr, max = 8) {
  return [...new Set((Array.isArray(arr) ? arr : [])
    .map((x) => String(x || '').trim())
    .filter((x) => x.length >= 1 && x.length <= 8))].slice(0, max);
}

/** 联想词 / 标记词 / 不良习惯：只在给了值时才写 */
function setKeys(id, item = {}) {
  const triggers = cleanKeys(item.triggers);
  const marks = cleanKeys(item.marks, 5);
  if (triggers.length) db.prepare('UPDATE char_user_reads SET triggers=? WHERE id=?').run(JSON.stringify(triggers), id);
  if (marks.length) db.prepare('UPDATE char_user_reads SET marks=? WHERE id=?').run(JSON.stringify(marks), id);
  if (item.bad_habit === true || item.bad_habit === false || item.bad_habit === 1 || item.bad_habit === 0) {
    db.prepare('UPDATE char_user_reads SET bad_habit=? WHERE id=?').run(item.bad_habit ? 1 : 0, id);
  }
  // 空数组也写，表示已经判过没有信号
  if (Array.isArray(item.upset_signs)) {
    const signs = [...new Set(item.upset_signs.map((x) => String(x || '').trim()).filter((x) => x.length >= 1 && x.length <= 6))].slice(0, 6);
    db.prepare('UPDATE char_user_reads SET upset_signs=? WHERE id=?').run(JSON.stringify(signs), id);
  }
}

function normSection(section) {
  return section === 'recent' ? 'recent' : 'fact';
}

function normalizeSelfCategory(cat) {
  const s = String(cat || '').trim();
  if (SELF_CATEGORIES.includes(s)) return s;
  if (/变化|变了|改变/.test(s)) return '变化';
  if (/喜|爱|好|讨厌/.test(s)) return '喜好';
  if (/习惯|作息/.test(s)) return '习惯';
  if (/行为|做事|处事/.test(s)) return '行为';
  return '性格';
}

function normalizeFactCategory(cat) {
  const s = String(cat || '').trim();
  if (FACT_CATEGORIES.includes(s)) return s;
  if (/情绪|反应|脾气上来|一生气|一难过/.test(s)) return '情绪反应';
  if (/人际|关系|朋友|家人|同事|室友|父母/.test(s)) return '人际关系';
  if (/喜|爱|讨厌|厌|恶|口味|偏好/.test(s)) return '喜恶';
  if (/行为|习惯|作息|做事|处事/.test(s)) return '行为习惯';
  if (/性格|脾气|个性/.test(s)) return '性格';
  return '其他';
}

function normalizeRecentCategory(cat) {
  const s = String(cat || '').trim();
  if (RECENT_CATEGORIES.includes(s)) return s;
  if (/烦|愁|担心|焦虑|困扰|纠结|难过/.test(s)) return '烦心事';
  if (/计划|打算|准备|要去|安排/.test(s)) return '计划';
  if (/忙|工作|学习|在做|项目|考试/.test(s)) return '在忙';
  if (/状态|身体|心情|精神|睡眠|生病/.test(s)) return '状态';
  return '其他';
}

function normalizeCategory(cat, about = 'user', section = 'fact') {
  if (about === 'self') return normalizeSelfCategory(cat);
  return normSection(section) === 'recent' ? normalizeRecentCategory(cat) : normalizeFactCategory(cat);
}

function categoriesFor(about = 'user', section = 'fact') {
  if (about === 'self') return SELF_CATEGORIES;
  return normSection(section) === 'recent' ? RECENT_CATEGORIES : FACT_CATEGORIES;
}

function shiftDate(dateStr, days) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function localToday() {
  let tz = 'Asia/Shanghai';
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key='timezone'`).get();
    if (row?.value) tz = row.value;
  } catch { /* ignore */ }
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** 旧版画像（只有一块、四类）和旧印象贴纸，按新结构收一次 */
function migrateLegacy(characterId) {
  ensureTable();
  const cid = Number(characterId);
  if (!cid) return;
  const key = `user_read_migrated_${cid}`;
  try {
    if (db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value === '1') return;
  } catch { return; }
  try {
    const rows = db.prepare(
      `SELECT id, category FROM char_user_reads WHERE character_id=? AND COALESCE(about,'user')='user'`
    ).all(cid);
    const upd = db.prepare(`UPDATE char_user_reads SET section='fact', category=? WHERE id=?`);
    for (const r of rows) {
      const old = String(r.category || '').trim();
      const next = old === '喜好' ? '喜恶' : (old === '行为' || old === '习惯') ? '行为习惯' : normalizeFactCategory(old);
      upd.run(next, r.id);
    }
    let imps = [];
    try {
      imps = db.prepare(
        `SELECT category, content, related_facts, note, confirmed
         FROM char_impressions WHERE character_id=? ORDER BY id ASC LIMIT 120`
      ).all(cid);
    } catch { /* no table */ }
    const items = [];
    for (const row of imps) {
      if (row.confirmed === 0) continue;
      let facts = [];
      try {
        const arr = JSON.parse(row.related_facts || '[]');
        if (Array.isArray(arr)) facts = arr.map((x) => String(x || '').trim()).filter(Boolean);
      } catch { /* ignore */ }
      const main = String(row.content || '').trim();
      if (main && !facts.includes(main)) facts.unshift(main);
      const rawCat = String(row.category || '').trim();
      const category = rawCat === '喜好' ? '喜恶'
        : rawCat === '习惯' ? '行为习惯'
          : (rawCat === '不擅长' || rawCat === '样子') ? '其他'
            : normalizeFactCategory(rawCat);
      const note = String(row.note || '').trim();
      const reason = note.length >= 4 ? note : '聊天里慢慢看出来的';
      for (const fact of facts.slice(0, 4)) {
        const judgment = String(fact).replace(/（\?）\s*$/, '').trim();
        if (judgment.length < 2 || judgment.length > 36) continue;
        items.push({ category, judgment, reason });
      }
    }
    if (items.length) applyItems(cid, items, { about: 'user', section: 'fact' });
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')`).run(key);
  } catch (e) {
    console.warn('[user-read] migrate', e.message);
  }
}

function mapRow(r) {
  const about = r.about === 'self' ? 'self' : 'user';
  const section = about === 'self' ? 'fact' : normSection(r.section);
  return {
    id: r.id,
    character_id: r.character_id,
    category: normalizeCategory(r.category, about, section),
    judgment: String(r.judgment || ''),
    reason: String(r.reason || ''),
    about,
    section,
    last_seen: String(r.last_seen || ''),
    source: r.source === 'self' ? 'self' : 'manual',
    triggers: parseArr(r.triggers),
    marks: parseArr(r.marks),
    bad_habit: Number(r.bad_habit) === 1,
    mention_count: Number(r.mention_count) || 0,
    last_mentioned: String(r.last_mentioned || ''),
    last_said: String(r.last_said || ''),
    nag_until: String(r.nag_until || ''),
    upset_signs: parseArr(r.upset_signs),
    upset_checked: r.upset_signs != null && String(r.upset_signs) !== '',
    updated_at: r.updated_at,
  };
}

function listReads(characterId, about = 'user', section = '') {
  ensureTable();
  const who = about === 'self' ? 'self' : 'user';
  const rows = db.prepare(
    `SELECT * FROM char_user_reads WHERE character_id=? AND COALESCE(about,'user')=? ORDER BY id ASC`
  ).all(Number(characterId), who).map(mapRow);
  const filtered = section ? rows.filter((r) => r.section === normSection(section)) : rows;
  const orderOf = (r) => categoriesFor(r.about, r.section).indexOf(r.category);
  return filtered.sort((a, b) =>
    (a.section === b.section ? 0 : a.section === 'recent' ? -1 : 1)
    || orderOf(a) - orderOf(b)
    || a.id - b.id);
}

function insertRead(characterId, item = {}) {
  ensureTable();
  const cid = Number(characterId);
  if (!cid) throw new Error('character_id required');
  const about = item.about === 'self' ? 'self' : 'user';
  const section = about === 'self' ? 'fact' : normSection(item.section);
  const category = normalizeCategory(item.category, about, section);
  const judgment = String(item.judgment || item.content || '').trim().slice(0, judgmentCap(category));
  if (judgment.length < 2) throw new Error('请填写判断');
  const reason = String(item.reason || '').trim().slice(0, reasonCap(category));
  const source = item.source === 'self' ? 'self' : 'manual';
  const lastSeen = section === 'recent' ? String(item.last_seen || localToday()).slice(0, 10) : '';
  const limit = section === 'recent' ? PER_RECENT_CAT : PER_CAT;
  const existing = listReads(cid, about, about === 'self' ? '' : section).filter((r) => r.category === category);
  if (existing.length >= limit) throw new Error(`${category}已经有 ${limit} 条了`);
  const r = db.prepare(
    `INSERT INTO char_user_reads (character_id, category, judgment, reason, about, source, section, last_seen) VALUES (?,?,?,?,?,?,?,?)`
  ).run(cid, category, judgment, reason, about, source, section, lastSeen);
  setKeys(r.lastInsertRowid, item);
  return listReads(cid, about).find((x) => x.id === r.lastInsertRowid) || null;
}

function updateRead(id, patch = {}) {
  ensureTable();
  const row = db.prepare('SELECT * FROM char_user_reads WHERE id=?').get(id);
  if (!row) return null;
  const about = row.about === 'self' ? 'self' : 'user';
  const section = about === 'self' ? 'fact' : normSection(patch.section != null ? patch.section : row.section);
  const category = normalizeCategory(patch.category != null ? patch.category : row.category, about, section);
  const judgment = patch.judgment != null
    ? String(patch.judgment).trim().slice(0, judgmentCap(category))
    : String(row.judgment || '');
  if (judgment.length < 2) throw new Error('请填写判断');
  const reason = patch.reason != null
    ? String(patch.reason).trim().slice(0, reasonCap(category))
    : String(row.reason || '');
  const source = patch.source === 'self' || patch.source === 'manual'
    ? patch.source
    : (row.source === 'self' ? 'self' : 'manual');
  let lastSeen = String(row.last_seen || '');
  if (section === 'recent') lastSeen = String(patch.last_seen || lastSeen || localToday()).slice(0, 10);
  else lastSeen = '';
  db.prepare(
    `UPDATE char_user_reads SET category=?, judgment=?, reason=?, source=?, section=?, last_seen=?, updated_at=datetime('now') WHERE id=?`
  ).run(category, judgment, reason, source, section, lastSeen, id);
  if (judgment !== String(row.judgment || '') && patch.triggers == null) {
    // 判断改了，旧联想词可能对不上，清空等下次消化重配
    db.prepare(`UPDATE char_user_reads SET triggers='[]', marks='[]' WHERE id=?`).run(id);
  }
  setKeys(id, patch);
  return listReads(row.character_id, about).find((x) => x.id === Number(id)) || null;
}

function deleteRead(id) {
  ensureTable();
  db.prepare('DELETE FROM char_user_reads WHERE id=?').run(id);
}

function similar(a, b) {
  const x = String(a || '').replace(/\s/g, '');
  const y = String(b || '').replace(/\s/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 6 && y.length >= 6 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

function bigrams(s) {
  const t = String(s || '').replace(/[\s，。！？、；：,.!?;:“”"'‘’（）()]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function overlapRatio(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit += 1;
  return hit / Math.min(x.size, y.size);
}

/**
 * 当天的聊天总结按顺序排好，逐句去掉和前面重复的（相邻两次总结在衔接处常常复述同一段）。
 */
function orderAndDedupeSummaries(rows) {
  const kept = [];
  const seen = [];
  for (const row of rows) {
    const sentences = String(row.content || '')
      .replace(/\r/g, '')
      .split(/(?<=[。！？!?；;])|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    const fresh = [];
    for (const s of sentences) {
      if (seen.some((p) => similar(p, s) || overlapRatio(p, s) >= 0.75)) continue;
      seen.push(s);
      fresh.push(s);
    }
    if (fresh.length) kept.push({ category: row.category || '', text: fresh.join('') });
  }
  return kept;
}

function parseJsonObject(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  const closed = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (closed) text = closed[1].trim();
  else {
    const open = text.match(/^```(?:json)?\s*/i);
    if (open) text = text.slice(open[0].length).replace(/```\s*$/i, '').trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseItems(raw) {
  const parsed = parseJsonObject(raw);
  return Array.isArray(parsed?.items) ? parsed.items : [];
}

function applyItems(characterId, items, opts = {}) {
  const cid = Number(characterId);
  const about = opts.about === 'self' ? 'self' : 'user';
  const section = about === 'self' ? 'fact' : normSection(opts.section);
  const lastSeen = section === 'recent' ? String(opts.dateStr || localToday()).slice(0, 10) : '';
  const limit = section === 'recent' ? PER_RECENT_CAT : PER_CAT;
  const existing = listReads(cid, about, about === 'self' ? '' : section);
  let changed = 0;
  for (const raw of items || []) {
    const category = normalizeCategory(raw?.category, about, section);
    const judgment = String(raw?.judgment || '').trim().slice(0, judgmentCap(category));
    const reason = String(raw?.reason || '').trim().slice(0, reasonCap(category));
    if (judgment.length < 2 || reason.length < 4) continue;
    const replaces = String(raw?.replaces || '').trim();
    const keys = {
      triggers: Array.isArray(raw?.triggers) ? raw.triggers : undefined,
      marks: Array.isArray(raw?.marks) ? raw.marks : undefined,
      bad_habit: typeof raw?.bad_habit === 'boolean' ? raw.bad_habit : undefined,
      upset_signs: Array.isArray(raw?.upset_signs) ? raw.upset_signs : undefined,
    };
    const hit = existing.find((r) => (
      (replaces && similar(r.judgment, replaces))
      || (r.category === category && similar(r.judgment, judgment))
    ));
    if (hit) {
      updateRead(hit.id, { category, judgment, reason, source: 'self', section, last_seen: lastSeen, ...keys });
      Object.assign(hit, { category, judgment, reason, source: 'self', last_seen: lastSeen });
      changed += 1;
      continue;
    }
    const count = existing.filter((r) => r.category === category).length;
    if (count >= limit) continue;
    try {
      const row = insertRead(cid, { category, judgment, reason, about, section, source: 'self', last_seen: lastSeen, ...keys });
      if (row) {
        existing.push(row);
        changed += 1;
      }
    } catch { /* 满了 */ }
  }
  return { changed, items: listReads(cid, about) };
}

/** 兼容旧调用 */
function applyDigestItems(characterId, items, about = 'user') {
  return applyItems(characterId, items, { about, section: 'fact' });
}

/** 近况超过 14 天没再提起就收掉 */
function expireRecent(characterId, refDate = '') {
  ensureTable();
  const cutoff = shiftDate(refDate || localToday(), -RECENT_TTL_DAYS);
  if (!cutoff) return 0;
  const sql = `DELETE FROM char_user_reads
    WHERE COALESCE(about,'user')='user' AND section='recent'
    AND COALESCE(last_seen,'')<>'' AND last_seen < ?`;
  const r = characterId
    ? db.prepare(`${sql} AND character_id=?`).run(cutoff, Number(characterId))
    : db.prepare(sql).run(cutoff);
  return r.changes || 0;
}

function loadChatSummaries(charId, dateStr) {
  try {
    return db.prepare(
      `SELECT id, category, content FROM memories
       WHERE character_id=? AND date=? AND COALESCE(archived,0)=0
       AND COALESCE(source,'chat') NOT IN ('life','schedule','schedule_day')
       AND category NOT IN ('秘密偷看')
       ORDER BY id ASC`
    ).all(Number(charId), dateStr);
  } catch {
    return [];
  }
}

async function callJsonModel(settings, callChatAPIComplete, sys, userMsg, maxTokens = 1400) {
  const opts = { maxTokens, temperature: 0.3, timeout: 120000, noContinue: true, json: true };
  let raw = '';
  try {
    raw = await callChatAPIComplete(settings, sys, userMsg, 'memory', [], opts);
  } catch { /* fallback */ }
  if (!raw) {
    raw = await callChatAPIComplete(settings, sys, userMsg, 'chat', [], opts);
  }
  const parsed = parseJsonObject(raw);
  if (!parsed) console.warn('[user-read] json parse fail', String(raw || '').slice(0, 280));
  return parsed;
}

/** 旧条目、手动添加的条目还没有联想词 / 标记词时补上 */
async function fillMissingKeys(charId, settings, callChatAPIComplete) {
  const cid = Number(charId);
  const needsSigns = (r) => r.about === 'user' && r.section === 'fact'
    && (r.category === '情绪反应' || r.category === '性格') && !r.upset_checked;
  const rows = [...listReads(cid, 'user'), ...listReads(cid, 'self')]
    .filter((r) => !r.triggers.length || !r.marks.length || needsSigns(r))
    .slice(0, 40);
  if (!rows.length) return 0;
  const sys = `给每条判断配词。只输出 JSON，不要 markdown。
{"items":[{"id":1,"triggers":["联想词"],"marks":["标记词"],"bad_habit":false,"upset_signs":[]}]}
${KEY_RULES}
bad_habit 只对「关于对方」的条目判断，其余写 false。id 必须原样照抄。`;
  const userMsg = rows.map((r) => `${r.id}. [${r.about === 'self' ? '关于自己' : '关于对方'}·${r.category}] ${r.judgment}`).join('\n');
  let parsed = null;
  try {
    parsed = await callJsonModel(settings, callChatAPIComplete, sys, userMsg, 1600);
  } catch (e) {
    console.warn('[user-read] fill keys', e.message);
    return 0;
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  let n = 0;
  for (const it of Array.isArray(parsed?.items) ? parsed.items : []) {
    const row = byId.get(Number(it?.id));
    if (!row) continue;
    setKeys(row.id, {
      triggers: it.triggers,
      marks: it.marks,
      bad_habit: row.about === 'user' && typeof it.bad_habit === 'boolean' ? it.bad_habit : undefined,
      upset_signs: needsSigns(row) ? (Array.isArray(it.upset_signs) ? it.upset_signs : []) : undefined,
    });
    n += 1;
  }
  return n;
}

/**
 * 当天和用户的聊天 → 画像（近况 + 本人事实）。
 * opts.dayStory：已收成的整天事记时优先用这份，不再直接啃碎片。
 */
async function digestChatDay(charId, dateStr, settings, callChatAPIComplete, opts = {}) {
  ensureTable();
  const cid = Number(charId);
  migrateLegacy(cid);
  const char = db.prepare('SELECT id, name, mindset FROM characters WHERE id=?').get(cid);
  if (!char) throw new Error('角色不存在');
  const dayStory = String(opts.dayStory || '').trim();
  const summaries = dayStory ? [] : orderAndDedupeSummaries(loadChatSummaries(cid, dateStr));
  if (!dayStory && !summaries.length) {
    const removed = expireRecent(cid, localToday());
    try { await fillMissingKeys(cid, settings, callChatAPIComplete); } catch { /* ignore */ }
    return { changed: 0, removed, reason: 'no_chat', items: listReads(cid) };
  }
  const uname = String(settings?.username || '').trim() || '对方';
  const recent = listReads(cid, 'user', 'recent');
  const facts = listReads(cid, 'user', 'fact');
  const recentLines = recent.length
    ? recent.map((r) => `- [${r.category}] ${r.judgment}（最近提到 ${r.last_seen || '不详'}）`).join('\n')
    : '（还没有）';
  const factLines = facts.length
    ? facts.map((r) => `- [${r.category}] ${r.judgment}`).join('\n')
    : '（还没有）';
  const selfRows = listReads(cid, 'self');
  const selfLines = selfRows.length
    ? selfRows.map((r) => `- [${r.category}] ${r.judgment}`).join('\n')
    : '（还没有）';
  const dayLines = dayStory
    || summaries.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  const materialHint = dayStory
    ? '材料是当天已收成的整天事记（聊天碎片已按时间排好、去掉衔接重复后的总览）。'
    : '材料是当天聊天总结，已按时间排好，前后可能还有少量重复，重复的只算一次。';

  const sys = `你是「${char.name}」本人。消化这一天和「${uname}」的聊天——用你自己的心思整理对对方的认识和对自己的认识。只输出 JSON，不要 markdown。
分三块：
· recent 近况：${uname}最近的状态，会变、会过去。比如最近在忙什么、最近的计划、最近在烦什么、最近身体或心情怎样，不限于这些。
· facts 本人事实：${uname}这个人稳定的东西。性格、喜恶、行为习惯、情绪反应、人际关系（身边的人和相处方式）等。一次性的小事不算事实。
  情绪反应记的是你吃过亏、摸清楚以后的**相处教训**，不是描述：${uname}不高兴、生气、难过、累的时候，你该怎么对TA，什么绝对不能做。
  judgment 写成教训，比如「她生气时要放软语气好好哄，绝不能顺着她的口是心非让她一个人冷静」。
  reason 写那一次的经过：${dateStr} 因为什么惹TA不高兴，TA当时什么样，你当时怎么做的，结果怎样，所以以后要怎样。用第一人称，可以写到 150 字。
  upset_signs 写TA那次不高兴时真说出口的话（没事、随便、嗯、晚安这种），用来以后认出TA。
  这天如果有矛盾、有情绪起伏，要特别看：你的哪个做法让TA更糟、哪个让TA好起来。旧的情绪反应如果只是描述、还不是教训，这天有材料就用 replaces 改成教训。
· self 你自己：从这天聊天里自己的反应、说过的话、做的决定，看出的自己。比如在${uname}面前会怎样、碰到什么会怎么反应、自己在意什么；「变化」写和${uname}相处以后自己慢慢变了什么（以前会…现在会…）。
{"recent":[{"category":"在忙|计划|烦心事|状态|其他","judgment":"一句近况","reason":"为什么这么记","replaces":"若是更新旧近况，写旧近况原文，否则空字符串","triggers":["联想词"],"marks":["标记词"]}],
 "recent_still":["今天又印证、仍然成立的旧近况原文"],
 "recent_done":["今天聊天里已经结束或不再成立的旧近况原文"],
 "facts":[{"category":"性格|喜恶|行为习惯|情绪反应|人际关系|其他","judgment":"一句完整判断，禁止半截话","reason":"为什么这么认为","replaces":"若是改旧判断，写旧判断原文，否则空字符串","triggers":["联想词"],"marks":["标记词"],"bad_habit":false,"upset_signs":[]}],
 "self":[{"category":"性格|行为|喜好|习惯|变化","judgment":"第一人称一句","reason":"为什么这么看自己","replaces":"若是改旧的，写旧的原文，否则空字符串","triggers":["联想词"],"marks":["标记词"]}]}
${KEY_RULES}
规则：
- ${materialHint}
- 纯闲聊、寒暄、无信息量的玩笑不要进近况或事实。
- 近况是给以后聊天用的：${uname}当天提到自己在忙什么、要去哪、计划、烦心事、身体或心情，即使不大也应收进 recent，好让你之后知道对方最近在干嘛。不要因为「不是大事」就空着。
- recent / facts 只写${uname}；self 只写你自己。你们俩之间的约会、拌嘴、相处过程本身不进近况、性格、喜恶这些格子；对方自己的生活、状态才进近况。唯一例外是情绪反应的 reason，必须写那一次的经过。
- recent / facts 的 judgment 不写主语或写「TA」「她」「他」；self 的 judgment 用「我」。一般不超过 28 字（情绪反应的教训可到 48 字）；judgment 禁止半截（如停在「明确表示」「面对…测试」）。
- reason 用第一人称。除情绪反应外不超过 60 字，不贴聊天原文；reason 里可带 ${dateStr} 等具体日期。
- 近况和事实不要重复写同一件事：会过去的放近况，稳定的放事实。
- 「经常忙」仍先看近况：${uname}现在还在忙、最近一直在忙的工作/学业/项目/备考等，即使是经常性的，也进 recent 的「在忙」，这就是角色要知道的「对方最近在干嘛」。只有已经收成稳定作息或处事方式（总是熬夜、不吃早饭、做事拖）才进事实的行为习惯；不要因为带了「经常」「总是」就把正在忙的事只写进事实、近况空着。
- judgment / reason / marks / triggers 里，用户亲口说的具体词须原样保留（药名、地名、店名、作品名、物品名、品牌等），禁止收成笼统说法。
- self 不要把角色卡上的性格原句再抄一遍，要是这天聊天里真的显出来的。
- 和旧条目意思一样就不要新写；有变化就用 replaces 改旧的。
- 没有依据就留空数组，禁止编造。`;
  const userMsg = `【${char.name}的心智】
${String(char.mindset || '').slice(0, 400) || '（还没有心智）'}

【已有近况】
${recentLines}

【已有本人事实】
${factLines}

【${char.name}已经写下的对自己的看法】
${selfLines}

【${dateStr} ${dayStory ? '整天事记' : '的聊天总结（按时间顺序）'}】
${dayLines}`;

  // 画像 JSON 字段多，易被截成半截 → 解析失败；强制 json + 给足上限 + 失败重试
  const digOpts = { maxTokens: 3200, temperature: 0.3, timeout: 120000, noContinue: true, json: true };
  let raw = '';
  let lastErr = null;
  const parsePortrait = (text) => {
    let t = String(text || '').trim();
    const closed = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (closed) t = closed[1].trim();
    return parseJsonObject(t);
  };
  try {
    raw = await callChatAPIComplete(settings, sys, userMsg, 'memory', [], digOpts);
  } catch (e) {
    lastErr = e;
    console.warn('[user-read] digest memory', e.message);
  }
  let parsed = raw ? parsePortrait(raw) : null;
  if (!parsed) {
    try {
      raw = await callChatAPIComplete(settings, sys, userMsg, 'chat', [], digOpts);
      lastErr = null;
      parsed = parsePortrait(raw);
    } catch (e) {
      lastErr = e;
      console.warn('[user-read] digest chat', e.message);
    }
  }
  if (!parsed) {
    try {
      const retrySys = `${sys}\n【补救】上次输出无法解析。请输出更短、完整合法的 JSON，括号必须闭合；没有新认识就空数组。`;
      raw = await callChatAPIComplete(settings, retrySys, userMsg, 'chat', [], {
        ...digOpts, maxTokens: 2200,
      });
      parsed = parsePortrait(raw);
    } catch (e) {
      lastErr = e;
    }
  }
  if (!raw && !parsed) {
    throw new Error(formatPortraitApiError(lastErr) || '画像消化调用失败，没有返回内容');
  }
  if (!parsed) {
    console.warn('[user-read] digest parse fail', String(raw || '').slice(0, 280));
    throw new Error('画像消化结果解析失败');
  }

  let removed = 0;
  const done = Array.isArray(parsed.recent_done) ? parsed.recent_done : [];
  for (const text of done) {
    const hit = recent.find((r) => similar(r.judgment, text));
    if (hit) {
      deleteRead(hit.id);
      removed += 1;
    }
  }
  const still = Array.isArray(parsed.recent_still) ? parsed.recent_still : [];
  for (const text of still) {
    const hit = recent.find((r) => similar(r.judgment, text));
    if (hit && (!hit.last_seen || hit.last_seen < dateStr)) {
      db.prepare(`UPDATE char_user_reads SET last_seen=?, updated_at=datetime('now') WHERE id=?`).run(dateStr, hit.id);
    }
  }
  const recentRes = applyItems(cid, Array.isArray(parsed.recent) ? parsed.recent : [], {
    about: 'user', section: 'recent', dateStr,
  });
  const factRes = applyItems(cid, Array.isArray(parsed.facts) ? parsed.facts : [], {
    about: 'user', section: 'fact',
  });
  const selfRes = applyItems(cid, Array.isArray(parsed.self) ? parsed.self : [], { about: 'self' });
  removed += expireRecent(cid, localToday());
  try { await fillMissingKeys(cid, settings, callChatAPIComplete); } catch { /* ignore */ }
  return {
    changed: recentRes.changed + factRes.changed,
    recentChanged: recentRes.changed,
    factChanged: factRes.changed,
    selfChanged: selfRes.changed,
    removed,
    summaries: dayStory ? 1 : summaries.length,
    fromStory: !!dayStory,
    items: listReads(cid),
  };
}

async function digestSelfFromDay(charId, dateStr, slots, settings, callChatAPIComplete) {
  ensureTable();
  const cid = Number(charId);
  const char = db.prepare('SELECT id, name, mindset, personality, behavior FROM characters WHERE id=?').get(cid);
  if (!char) throw new Error('角色不存在');
  const lived = (slots || []).filter((s) => s.lived);
  if (!lived.length) throw new Error('走过的时段还没记下实际经过');
  const existing = listReads(cid, 'self');
  const existLines = existing.length
    ? existing.map((r) => `- [${r.category}] ${r.judgment}`).join('\n')
    : '（还没有）';
  const dayLines = lived.map((s) => `${s.time || ''} ${s.activity}：${s.lived}`).join('\n');
  const sys = `你在帮「${char.name}」把这一天收成对自己的判断。只输出 JSON。
{"items":[{"category":"性格|行为|喜好|习惯","judgment":"现在怎么看自己的一句，第一人称","reason":"当时为什么会这么总结","replaces":"若是改旧判断，写旧判断原文，否则空字符串"}]}
没有新的稳定判断就 items 为空数组。不要把角色卡上的性格原句再抄一遍。reason 用第一人称，写当时怎么看、什么感觉、为什么收成这一句。`;
  const userMsg = `【心智】
${String(char.mindset || '').slice(0, 500) || '（还没有心智）'}
【性格底色】${String(char.personality || '').slice(0, 160)}
【行为】${String(char.behavior || '').slice(0, 120)}

【已经写下的对自己的判断】
${existLines}

【这一天 ${dateStr}】
${dayLines}

只写这一天真的让「我怎么看自己」站住或改口的。`;
  const digOpts = { maxTokens: 1200, temperature: 0.3, timeout: 90000, noContinue: true, json: true };
  let raw = '';
  try {
    raw = await callChatAPIComplete(settings, sys, userMsg, 'memory', [], digOpts);
  } catch { /* fallback */ }
  if (!raw) {
    raw = await callChatAPIComplete(settings, sys, userMsg, 'chat', [], digOpts);
  }
  return applyItems(cid, parseItems(raw), { about: 'self' });
}

function wantsReason(text, row) {
  const t = String(text || '');
  if (!t) return false;
  const j = String(row.judgment || '').replace(/\s/g, '');
  if (j.length >= 4 && t.includes(j.slice(0, Math.min(6, j.length)))) return true;
  return false;
}

/* ── 聊天时怎么用：按对方这句话检索，「心里知道」和「这轮说出来」分开 ── */

const _offered = new Map();
const _recentMention = new Map();
const _rolls = new Map();
const ROLL_FAIL_MS = 6 * 3600 * 1000;
const ROLL_OK_MS = 10 * 60 * 1000;
const PUSHBACK_WINDOW_MS = 30 * 60 * 1000;

function maxMessageId(cid) {
  try {
    return db.prepare('SELECT MAX(id) AS m FROM messages WHERE character_id=?').get(cid)?.m || 0;
  } catch {
    return 0;
  }
}

function bigramHits(judgment, text) {
  const t = bigrams(text);
  let n = 0;
  for (const g of bigrams(judgment)) if (t.has(g)) n += 1;
  return n;
}

const _wordRe = new Map();
/** 中文词中间常插字（洗完澡、吹一下头发），字与字之间允许隔两个字 */
function wordRe(word) {
  let re = _wordRe.get(word);
  if (!re) {
    const chars = [...word].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    re = new RegExp(chars.join('[^，。！？!?,\\n]{0,2}'));
    _wordRe.set(word, re);
  }
  return re;
}

function wordHit(word, text) {
  if (word.length < 2) return false;
  return text.includes(word) || wordRe(word).test(text);
}

function scoreRow(row, text) {
  let s = 0;
  for (const k of row.triggers) if (wordHit(k, text)) s += 2;
  for (const k of row.marks) if (wordHit(k, text)) s += 2;
  if (!s && bigramHits(row.judgment, text) >= 2) s = 1;
  return s;
}

function mentionedIn(row, text) {
  for (const m of row.marks) {
    if (!wordHit(m, text)) continue;
    const sentence = text.split(/(?<=[。！？!?\n])/).find((x) => wordHit(m, x)) || text;
    return sentence.trim().slice(0, 40);
  }
  return '';
}

function cooldownDays(row) {
  const n = Math.max(1, row.mention_count);
  return COOLDOWN_DAYS[Math.min(n, COOLDOWN_DAYS.length) - 1];
}

function onCooldown(row, today) {
  if (row.nag_until && row.nag_until >= today) return true;
  if (!row.last_mentioned) return false;
  return row.last_mentioned > shiftDate(today, -cooldownDays(row));
}

/** 上一轮给过的条目，看角色回复里有没有真提到；对方嫌唠叨就拉长冷却 */
function settleMentions(cid, userText) {
  const today = localToday();
  const st = _offered.get(cid);
  if (st) {
    let msgs = [];
    try {
      msgs = db.prepare(
        `SELECT content FROM messages WHERE character_id=? AND role='assistant' AND id>? ORDER BY id ASC LIMIT 8`
      ).all(cid, st.afterId);
    } catch { /* ignore */ }
    if (msgs.length) {
      const text = msgs.map((m) => String(m.content || '')).join('\n');
      const upd = db.prepare(
        `UPDATE char_user_reads SET mention_count=COALESCE(mention_count,0)+1, last_mentioned=?, last_said=? WHERE id=?`
      );
      const hit = [];
      for (const id of st.ids) {
        const raw = db.prepare('SELECT * FROM char_user_reads WHERE id=?').get(id);
        if (!raw) continue;
        const said = mentionedIn(mapRow(raw), text);
        if (said) {
          upd.run(today, said, id);
          hit.push(id);
        }
      }
      _offered.delete(cid);
      if (hit.length) _recentMention.set(cid, { ids: hit, at: Date.now() });
    } else if (Date.now() - st.at > 3600 * 1000) {
      _offered.delete(cid);
    }
  }
  if (PUSHBACK_RE.test(userText)) {
    const rm = _recentMention.get(cid);
    if (rm && Date.now() - rm.at < PUSHBACK_WINDOW_MS) {
      const until = shiftDate(today, NAG_COOLDOWN_DAYS);
      const upd = db.prepare('UPDATE char_user_reads SET nag_until=? WHERE id=?');
      for (const id of rm.ids) upd.run(until, id);
      _recentMention.delete(cid);
    }
  }
}

function rollOffer(cid, row) {
  const key = `${cid}:${row.id}`;
  const now = Date.now();
  const cached = _rolls.get(key);
  if (cached && cached.until > now) return cached.ok;
  const ok = Math.random() < (row.bad_habit ? BAD_HABIT_CHANCE : OFFER_CHANCE);
  _rolls.set(key, { ok, until: now + (ok ? ROLL_OK_MS : ROLL_FAIL_MS) });
  return ok;
}

/* ── 认出对方：TA平时在你面前的样子 vs 这会儿 ── */

const PLAYFUL_RE = /[哈嘿嘻呀啦嘛哇呜嘤~～!！]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\[[^\]]{1,8}\]/u;
const DRY_RE = /^(嗯+|哦+|噢+|好+|好的|行|随便|随你|知道了|没事|没什么|晚安|睡了|我睡了|去睡了|ok|嗯嗯|哦哦|是吗|这样啊|你说呢|都行)[。.!！~～…]*$/i;
const CONFLICT_RE = /生气|吵架|吵|凶我|算了|随便你|无所谓|你总是|你每次|不想说|懒得|别理我|烦你|冷战|对不起|抱歉|我错了|你怎么这样|失望|委屈|过分|不理|爱咋咋|你开心就好/;
const GOODNIGHT_RE = /晚安|睡了|去睡|要睡|先睡|困了/;
const STYLE_CACHE_MS = 30 * 60 * 1000;
const _styleCache = new Map();

function msgTime(ts) {
  const s = String(ts || '');
  if (!s) return NaN;
  const d = /[TZ+]/.test(s) ? new Date(s) : new Date(`${s.replace(' ', 'T')}Z`);
  return d.getTime();
}

function styleOf(msgs) {
  const texts = msgs.map((m) => String(m.content || '').replace(/\s/g, '')).filter(Boolean);
  if (!texts.length) return null;
  const n = texts.length;
  return {
    n,
    avgLen: texts.reduce((a, t) => a + t.length, 0) / n,
    playRate: texts.filter((t) => PLAYFUL_RE.test(t)).length / n,
    dryRate: texts.filter((t) => DRY_RE.test(t)).length / n,
  };
}

function userMessages(cid, limit) {
  try {
    return db.prepare(
      `SELECT id, role, content, timestamp FROM messages
       WHERE character_id=? AND role='user' AND COALESCE(is_dream,0)=0 AND COALESCE(recalled,0)=0
       AND (type IS NULL OR type NOT IN ('system'))
       ORDER BY id DESC LIMIT ?`
    ).all(cid, limit);
  } catch {
    try {
      return db.prepare(
        `SELECT id, role, content, timestamp FROM messages WHERE character_id=? AND role='user' ORDER BY id DESC LIMIT ?`
      ).all(cid, limit);
    } catch {
      return [];
    }
  }
}

/** 平时：3 小时以前的消息算出来的样子，缓存半小时 */
function baselineStyle(cid) {
  const cached = _styleCache.get(cid);
  if (cached && Date.now() - cached.at < STYLE_CACHE_MS) return cached.style;
  const cutoff = Date.now() - 3 * 3600 * 1000;
  const older = userMessages(cid, 400).filter((m) => {
    const t = msgTime(m.timestamp);
    return Number.isFinite(t) && t < cutoff;
  }).slice(0, 200);
  const style = older.length >= 20 ? styleOf(older) : null;
  _styleCache.set(cid, { at: Date.now(), style });
  return style;
}

/** 这会儿：最近 45 分钟内最新的 3 条（至少这一句），太早的会把变冷之前的样子混进来 */
function currentStyle(cid) {
  const recent = userMessages(cid, 8);
  const since = Date.now() - 45 * 60 * 1000;
  let win = recent.filter((m) => {
    const t = msgTime(m.timestamp);
    return Number.isFinite(t) && t >= since;
  }).slice(0, 3);
  if (!win.length) win = recent.slice(0, 3);
  return styleOf(win);
}

function recentFriction(cid, sinceMs = 0) {
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT role, content, timestamp FROM messages WHERE character_id=? ORDER BY id DESC LIMIT 30`
    ).all(cid);
  } catch { return false; }
  const since = Math.max(Date.now() - 4 * 3600 * 1000, sinceMs || 0);
  return rows.some((m) => {
    const t = msgTime(m.timestamp);
    if (Number.isFinite(t) && t < since) return false;
    return CONFLICT_RE.test(String(m.content || ''));
  });
}

/* ── 用户情绪：平时只检测不上报；只在开始往负面走 / 还在负面 / 好转时告诉角色一句 ── */

const MOOD_RESET_MS = 12 * 3600 * 1000;

function loadMoodState(cid) {
  try {
    const v = db.prepare('SELECT value FROM settings WHERE key=?').get(`user_mood_${cid}`)?.value;
    const s = v ? JSON.parse(v) : null;
    if (s && typeof s === 'object') return s;
  } catch { /* ignore */ }
  return { state: 'normal', calm: 0, at: 0, msgId: 0, block: '' };
}

function saveMoodState(cid, s) {
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`user_mood_${cid}`, JSON.stringify(s));
  } catch { /* ignore */ }
}

const USER_UPSET_RE = /你怎么这样|你怎么又|随便你|算了吧|算了算了|无所谓|爱咋咋|你开心就好|不想说|懒得说|别理我|过分|失望|好委屈|行吧|呵呵/;

function coldScore(base, cur) {
  if (!base || !cur) return { n: 0, signs: [] };
  const signs = [];
  if (base.avgLen >= 8 && cur.avgLen <= base.avgLen * 0.45) signs.push('话一下子变短了');
  if (base.playRate >= 0.3 && cur.playRate === 0) signs.push('没了平时的语气词和表情');
  if (base.dryRate <= 0.15 && cur.dryRate >= 0.5) signs.push('只回「嗯」「好」这种');
  return { n: signs.length, signs };
}

/**
 * 从画像事实里收检测信号：情绪反应上记的原话，以及性格/教训正文里提到的口是心非、说晚安等。
 */
function portraitCues(facts = []) {
  const signs = [];
  const blobBits = [];
  for (const r of facts) {
    if (r.section && r.section !== 'fact') continue;
    if (r.about === 'self') continue;
    for (const s of r.upset_signs || []) signs.push(s);
    const blob = `${r.judgment || ''} ${r.reason || ''}`;
    blobBits.push(blob);
    for (const m of blob.matchAll(/「([^」]{1,6})」|“([^”]{1,6})”/g)) {
      const w = (m[1] || m[2] || '').trim();
      if (w) signs.push(w);
    }
  }
  const blob = blobBits.join('\n');
  if (/口是心非|说没事|嘴上说没事|说随便/.test(blob)) {
    signs.push('没事', '随便', '随便你', '你忙吧');
  }
  if (/说晚安|晚安就走|说了晚安/.test(blob)) signs.push('晚安', '我睡了', '去睡了');
  if (/只回嗯|话变短|只回好/.test(blob)) signs.push('嗯', '好');
  const uniq = [...new Set(signs.map((s) => String(s || '').trim()).filter((s) => s.length >= 1 && s.length <= 6))];
  return { signs: uniq, blob };
}

const WEAK_SIGN_RE = /^(晚安|嗯+|好|没事|好的|我睡了|去睡了)$/;

function matchPortraitSign(text, cues) {
  const t = String(text || '').trim();
  const short = t.length <= 12 || DRY_RE.test(t);
  for (const s of cues.signs || []) {
    const hit = s.length >= 2
      ? wordHit(s, t)
      : new RegExp(`^${s}[。。.！!～~…]*$`).test(t);
    if (!hit) continue;
    if (WEAK_SIGN_RE.test(s) && !short) continue;
    return s;
  }
  return '';
}

/** 这一句像不像在往负面走，顺带给出看得出来的迹象 */
function senseNegative(cid, text, sinceMs = 0, facts = []) {
  const base = baselineStyle(cid);
  const friction = recentFriction(cid, sinceMs);
  const cues = portraitCues(facts);
  const signs = [];
  const word = text.match(NEG_RE)?.[0] || text.match(USER_UPSET_RE)?.[0] || '';
  if (word) signs.push(`说了「${word}」`);
  const known = matchPortraitSign(text, cues);
  if (known && known !== word) signs.push(`按你对TA的了解，这句「${known}」不像没事`);
  // 最近 3 条看趋势；最新一句单看，配合刚有摩擦时能早一点察觉
  const trend = coldScore(base, currentStyle(cid));
  const latest = coldScore(base, styleOf([{ content: text }]));
  const cold = trend.n >= latest.n ? trend : latest;
  signs.push(...cold.signs);
  const goodnight = GOODNIGHT_RE.test(text) && text.length <= 12;
  const knowsGoodnight = /晚安|我睡了|去睡了/.test(cues.blob || '');
  if (goodnight && (cold.n || friction || knowsGoodnight)) signs.push('说了晚安，但跟平时不太一样');
  if (friction) signs.push('刚才你们之间有点不愉快');
  // 只是话短、没表情不算不高兴；画像里认过的信号可以单独算
  const negative = !!word || !!known || trend.n >= 3 || (cold.n >= 1 && friction)
    || (goodnight && friction)
    || (goodnight && knowsGoodnight && cold.n >= 2);
  const warm = !word && !known && PLAYFUL_RE.test(text) && latest.n === 0;
  return { negative, warm, signs };
}

function moodBlock(kind, signs, reactions) {
  const react = reactions.length
    ? `\n你吃过亏的：${reactions.map((r) => r.judgment).join('；')}`
    : '';
  if (kind === 'onset') {
    const how = signs.length ? `：${signs.join('，')}` : '';
    return `【对方的情绪】TA好像开始不太高兴了${how}。${react}\n要不要管、怎么管，看你自己。`;
  }
  if (kind === 'ongoing') return `【对方的情绪】TA还没缓过来${signs[0] ? `（${signs[0]}）` : ''}。`;
  if (kind === 'easing') return '【对方的情绪】TA好像缓和了一点，但还说不准。';
  return '【对方的情绪】TA的情绪好像缓过来了。';
}

/** 同一条用户消息只推进一次状态，重复构建提示词时复用 */
function updateUserMood(cid, text, userRows) {
  const lastId = userMessages(cid, 1)[0]?.id || 0;
  let s = loadMoodState(cid);
  if (lastId && s.msgId === lastId) return s.block || '';
  if (s.state === 'negative' && Date.now() - (s.at || 0) > MOOD_RESET_MS) {
    s = { state: 'normal', calm: 0, at: 0, msgId: 0, block: '' };
  }
  const recoveredAt = s.recoveredAt || 0;
  const { negative, warm, signs } = senseNegative(cid, text, s.state === 'negative' ? 0 : recoveredAt, userRows);
  const reactions = userRows.filter((r) => r.section === 'fact' && r.category === '情绪反应').slice(0, 2);
  let block = '';
  if (s.state !== 'negative') {
    if (negative) {
      s = { state: 'negative', calm: 0, at: Date.now(), recoveredAt };
      block = moodBlock('onset', signs, reactions);
    }
  } else if (negative) {
    s = { state: 'negative', calm: 0, at: Date.now(), recoveredAt };
    block = moodBlock('ongoing', signs, reactions);
  } else {
    const calm = (s.calm || 0) + 1;
    if (warm || calm >= 2) {
      s = { state: 'normal', calm: 0, at: Date.now(), recoveredAt: Date.now() };
      block = moodBlock('recovered', [], []);
    } else {
      s = { state: 'negative', calm, at: Date.now(), recoveredAt };
      block = moodBlock('easing', [], []);
    }
  }
  saveMoodState(cid, { ...s, msgId: lastId, block });
  return block;
}

function userMoodState(charId) {
  return loadMoodState(Number(charId)).state === 'negative' ? 'negative' : 'normal';
}

function readLabel(r) {
  return r.section === 'recent' ? `近况·${r.category}` : r.category;
}

function formatRecentStanding(rows) {
  const recent = (rows || []).filter((r) => r.section === 'recent' && String(r.judgment || '').trim());
  if (!recent.length) return '';
  recent.sort((a, b) =>
    String(b.last_seen || '').localeCompare(String(a.last_seen || '')) || b.id - a.id);
  const lines = recent.slice(0, 8).map((r) => {
    const when = r.last_seen && r.last_seen.length >= 10 ? `（${r.last_seen.slice(5)}）` : '';
    return `· ${stripPortraitSubject(r.judgment)}${when}`;
  });
  return `【近况】对方最近在干嘛，你会知道。提不提看性格和这轮话，不要盘问、不要念清单。\n${lines.join('\n')}`;
}

function formatForPrompt(charId, userText = '') {
  const cid = Number(charId);
  if (!cid) return '';
  migrateLegacy(cid);
  const text = String(userText || '').trim();
  try { settleMentions(cid, text); } catch (e) { console.warn('[user-read] settle', e.message); }
  const allUserRows = listReads(cid, 'user');
  const standingRecent = formatRecentStanding(allUserRows);
  if (!text) return standingRecent;
  const userRows = allUserRows.filter((r) => r.section !== 'recent');
  let moodText = '';
  try { moodText = updateUserMood(cid, text, allUserRows); } catch (e) { console.warn('[user-read] mood', e.message); }
  const upset = userMoodState(cid) === 'negative';
  if (!allUserRows.length && !moodText) return '';
  const today = localToday();
  const rank = (rows) => rows
    .map((r) => ({ r, s: scoreRow(r, text) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.r.id - a.r.id)
    .map((x) => x.r);
  // 近况常驻；本人事实仍按这轮话勾起
  const userHits = rank(userRows);

  let offer = null;
  const first = userHits.find((r) => r.category !== '情绪反应' && !onCooldown(r, today));
  if (first && rollOffer(cid, first)) offer = first;

  // 对方正不高兴时，不插别的话题
  if (offer && upset) offer = null;

  const know = userHits.filter((r) => r !== offer && !(moodText && r.category === '情绪反应')).slice(0, KNOW_MAX);

  const parts = [];
  if (standingRecent) parts.push(standingRecent);
  if (moodText) parts.push(moodText);
  if (know.length) {
    parts.push(`【相关印象】这轮话勾起的：
${know.map((r) => `· ${stripPortraitSubject(r.judgment)}`).join('\n')}
点到了就接上，别装不记得；禁止念「你说过…」、禁止当清单盘问。`);
  }
  if (offer) {
    const bad = offer.bad_habit ? '（坏习惯）' : '';
    const last = offer.last_said ? `上次你说的是「${offer.last_said}」。` : '';
    parts.push(`【相关印象】· ${stripPortraitSubject(offer.judgment)}${bad}
点到了就接上；禁止念「你说过…」，禁止为带到它加固定提问口癖。${last}`);
  }

  const pool = [offer, ...know].filter(Boolean);
  let picked = pool.filter((r) => r.reason && wantsReason(text, r)).slice(0, 3);
  if (!picked.length && WHY_RE.test(text)) {
    picked = (pool.length ? pool : userRows).filter((r) => r.reason).slice(0, 2);
  }
  if (picked.length) {
    parts.push(`【你当时为什么这么想】\n${picked.map((r) => `「${r.judgment}」：${r.reason}`).join('\n')}`);
  }

  const tracked = [...new Set([offer, ...know].filter(Boolean).map((r) => r.id))];
  if (tracked.length) _offered.set(cid, { afterId: maxMessageId(cid), ids: tracked, at: Date.now() });
  return parts.join('\n\n');
}

/** 自我看法不注入聊天；消化仍走 digestSelfFromDay */
function formatSelfForPrompt() {
  return '';
}

function stripPortraitSubject(judgment) {
  return String(judgment || '')
    .replace(/^(她|他|TA|Ta|ta|对方|用户)\s*/u, '')
    .trim();
}

module.exports = {
  CATEGORIES,
  FACT_CATEGORIES,
  RECENT_CATEGORIES,
  SELF_CATEGORIES,
  RECENT_TTL_DAYS,
  ensureTable,
  migrateLegacy,
  listReads,
  insertRead,
  updateRead,
  deleteRead,
  applyDigestItems,
  orderAndDedupeSummaries,
  loadChatSummaries,
  digestChatDay,
  digestSelfFromDay,
  expireRecent,
  formatForPrompt,
  formatSelfForPrompt,
  userMoodState,
  _senseNegative: senseNegative,
  _portraitCues: portraitCues,
};

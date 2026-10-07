/**
 * TA 信箱：互相写信。
 * 投递/回信时刻在服务端抽样，绝不把 deliver_at / 倒计时暴露给前端或模型。
 */
const db = require('./db');

const TRANSIT_HINTS = [
  '还在路上',
  '邮路不太稳',
  '不知道哪天到',
  '信在漂着',
  '也许快了，也许还要等',
];

function getSettings() {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS letter_books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL UNIQUE,
      title TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS letter_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      role TEXT DEFAULT 'user',
      content TEXT DEFAULT '',
      status TEXT DEFAULT 'in_transit',
      reply_to_id INTEGER DEFAULT NULL,
      posted_at TEXT DEFAULT (datetime('now')),
      deliver_at TEXT DEFAULT NULL,
      read_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS letter_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      entry_id INTEGER,
      kind TEXT DEFAULT 'deliver',
      run_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_letter_entries_book ON letter_entries(book_id, status);
    CREATE INDEX IF NOT EXISTS idx_letter_jobs_due ON letter_jobs(done, run_at);
  `);
}

try { ensureTables(); } catch (e) {
  console.warn('[letter] ensureTables', e.message);
}

function loadChar(id) {
  const cid = Number(id) || 0;
  if (!cid) return null;
  try {
    return db.prepare(
      `SELECT id, name, avatar, personality, language_style, behavior, relationship,
              relationship_custom, status, busy_style, timezone, nicknames
       FROM characters WHERE id=?`
    ).get(cid) || null;
  } catch {
    return null;
  }
}

function getOrCreateBook(characterId) {
  ensureTables();
  const cid = Number(characterId);
  if (!cid) throw new Error('characterId required');
  const char = loadChar(cid);
  if (!char) throw new Error('角色不存在');
  let book = db.prepare('SELECT * FROM letter_books WHERE character_id=?').get(cid);
  if (book) return book;
  const title = `和${char.name || 'TA'}的信箱`;
  const r = db.prepare(
    `INSERT INTO letter_books (character_id, title) VALUES (?,?)`
  ).run(cid, title);
  return db.prepare('SELECT * FROM letter_books WHERE id=?').get(r.lastInsertRowid);
}

function getBook(bookId) {
  return db.prepare(`
    SELECT b.*, c.name as char_name, c.avatar as char_avatar
    FROM letter_books b
    LEFT JOIN characters c ON c.id = b.character_id
    WHERE b.id=?
  `).get(bookId);
}

function getBookForCharacter(characterId) {
  return db.prepare(`
    SELECT b.*, c.name as char_name, c.avatar as char_avatar
    FROM letter_books b
    LEFT JOIN characters c ON c.id = b.character_id
    WHERE b.character_id=?
  `).get(characterId);
}

function normalizeHourToken(h) {
  const n = parseInt(h, 10);
  if (!Number.isFinite(n)) return '00';
  if (n === 24) return '00';
  return String(Math.max(0, Math.min(23, n))).padStart(2, '0');
}

function sqlNow(tz) {
  const zone = tz || getSettings().timezone || 'Asia/Shanghai';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${normalizeHourToken(g('hour'))}:${g('minute')}:${g('second')}`;
  } catch {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }
}

/** 把本地墙钟 SQL 时间转成可比的 epoch（按设定时区解释） */
function parseLocalSqlMs(sql, tz) {
  const s = String(sql || '').trim();
  if (!s) return NaN;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return Date.parse(s.replace(' ', 'T'));
  const zone = tz || getSettings().timezone || 'Asia/Shanghai';
  // 用「假装 UTC」再扣时区偏移估 epoch；对固定偏移时区够用
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  try {
    const probe = new Date();
    const utcStr = probe.toLocaleString('en-US', { timeZone: 'UTC' });
    const locStr = probe.toLocaleString('en-US', { timeZone: zone });
    const offset = new Date(locStr).getTime() - new Date(utcStr).getTime();
    return asUtc - offset;
  } catch {
    return asUtc - 8 * 3600 * 1000;
  }
}

function isoFromMs(ms, tz) {
  // 任务 run_at / deliver_at 与 sqlNow 同一套墙钟，方便 SQLite datetime 比较
  const zone = tz || getSettings().timezone || 'Asia/Shanghai';
  try {
    const d = new Date(ms);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const g = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${normalizeHourToken(g('hour'))}:${g('minute')}:${g('second')}`;
  } catch {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  }
}

function isNightLocal(tz) {
  try {
    const hour = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'Asia/Shanghai',
      hour: 'numeric',
      hour12: false,
    }).format(new Date()), 10);
    return hour >= 22 || hour < 7;
  } catch {
    const h = new Date().getHours();
    return h >= 22 || h < 7;
  }
}

function isCharBusyNow(char) {
  const status = String(char?.status || '').trim();
  if (status && status !== 'online' && status !== '空闲') return true;
  try {
    const cron = require('./cron');
    const settings = getSettings();
    const here = cron.getHereAndNowContext?.(char, settings);
    const act = String(here?.current?.activity || '');
    if (/上班|加班|开会|出差|睡|忙|工作|课堂|考试/.test(act)) return true;
    if (here?.placeMode === 'away' && /忙|会议|客户/.test(act)) return true;
  } catch {}
  return false;
}

/** 对数均匀抽样投递延迟；永不暴露给前端。单位 ms。 */
function sampleTransitDelayMs(char, { forReply = false } = {}) {
  const settings = getSettings();
  const tz = char?.timezone || settings.timezone || 'Asia/Shanghai';
  // 回信稍慢一点：手写信本身也要时间
  const loH = forReply ? 4 : 3;
  const hiH = forReply ? 96 : 72;
  const lo = Math.log(loH * 3600 * 1000);
  const hi = Math.log(hiH * 3600 * 1000);
  let ms = Math.exp(lo + Math.random() * (hi - lo));

  if (isNightLocal(tz)) {
    ms += (6 + Math.random() * 8) * 3600 * 1000;
  }
  if (isCharBusyNow(char)) {
    ms *= 1.35 + Math.random() * 0.85;
  }
  // 极少数「差点丢了」
  if (Math.random() < 0.03) {
    ms += (2 + Math.random() * 5) * 24 * 3600 * 1000;
  }
  // 下限 / 上限夹紧
  const minMs = forReply ? 2 * 3600 * 1000 : 90 * 60 * 1000;
  const maxMs = forReply ? 10 * 24 * 3600 * 1000 : 8 * 24 * 3600 * 1000;
  return Math.max(minMs, Math.min(maxMs, Math.floor(ms)));
}

/** 角色读到信之后，再过多久才动手回信（与投递延迟分开） */
function sampleComposeDelayMs(char) {
  const lo = Math.log(2 * 3600 * 1000);
  const hi = Math.log(36 * 3600 * 1000);
  let ms = Math.exp(lo + Math.random() * (hi - lo));
  if (isCharBusyNow(char)) ms *= 1.5 + Math.random();
  return Math.max(45 * 60 * 1000, Math.min(4 * 24 * 3600 * 1000, Math.floor(ms)));
}

function fuzzyTransitHint(row) {
  if (!row) return '';
  const status = String(row.status || '');
  if (status === 'delivered' || status === 'read') return status === 'read' ? '已读' : '到了';
  if (status !== 'in_transit') return '';
  const tz = getSettings().timezone || 'Asia/Shanghai';
  const posted = parseLocalSqlMs(row.posted_at || row.created_at, tz);
  const age = Number.isFinite(posted) ? Date.now() - posted : 0;
  if (age < 3 * 3600 * 1000) return '刚投进邮筒';
  if (age < 20 * 3600 * 1000) return TRANSIT_HINTS[Math.floor(Math.max(0, age) / 3600000) % TRANSIT_HINTS.length];
  if (age < 3 * 24 * 3600 * 1000) return '邮路不太稳，还没到';
  return '还在漂着，不知道哪天到';
}

function publicLetter(row, { viewer = 'user' } = {}) {
  if (!row) return null;
  const status = String(row.status || '');
  const role = String(row.role || 'user');
  // 用户视角：自己寄出的在途信可见（模糊状态）；对方在途信不可见
  if (viewer === 'user' && role === 'ai' && status === 'in_transit') return null;
  // 角色视角（工具）：自己寄出的在途可见；用户在途不可读正文
  const hideBody = viewer === 'char' && role === 'user' && status === 'in_transit';

  return {
    id: row.id,
    book_id: row.book_id,
    role,
    content: hideBody ? '' : String(row.content || ''),
    status,
    reply_to_id: row.reply_to_id || null,
    posted_at: row.posted_at,
    read_at: row.read_at || null,
    created_at: row.created_at,
    transitHint: fuzzyTransitHint(row),
    // 故意不返回 deliver_at
  };
}

function enqueueJob({ bookId, characterId, entryId, kind, runAt }) {
  const r = db.prepare(`
    INSERT INTO letter_jobs (book_id, character_id, entry_id, kind, run_at, done)
    VALUES (?,?,?,?,?,0)
  `).run(bookId, characterId, entryId || null, kind, runAt);
  return r.lastInsertRowid;
}

function postLetter({ characterId, content, role = 'user', replyToId = null }) {
  ensureTables();
  const cid = Number(characterId);
  const text = String(content || '').trim().slice(0, 4000);
  if (!cid) throw new Error('characterId required');
  if (!text) throw new Error('信不能空着');
  const char = loadChar(cid);
  if (!char) throw new Error('角色不存在');
  const book = getOrCreateBook(cid);
  const forReply = role === 'ai';
  const delay = sampleTransitDelayMs(char, { forReply });
  const now = sqlNow();
  const deliverAt = isoFromMs(Date.now() + delay);
  const r = db.prepare(`
    INSERT INTO letter_entries (book_id, role, content, status, reply_to_id, posted_at, deliver_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(book.id, role === 'ai' ? 'ai' : 'user', text, 'in_transit', replyToId || null, now, deliverAt);
  const entryId = r.lastInsertRowid;
  enqueueJob({
    bookId: book.id,
    characterId: cid,
    entryId,
    kind: 'deliver',
    runAt: deliverAt,
  });
  const row = db.prepare('SELECT * FROM letter_entries WHERE id=?').get(entryId);
  return publicLetter(row, { viewer: role === 'ai' ? 'char' : 'user' });
}

function listLetters(characterId, { viewer = 'user' } = {}) {
  ensureTables();
  const book = getBookForCharacter(characterId);
  if (!book) return { book: null, letters: [], unread: 0 };
  const rows = db.prepare(`
    SELECT * FROM letter_entries WHERE book_id=?
    ORDER BY datetime(posted_at) DESC, id DESC
    LIMIT 80
  `).all(book.id);
  const letters = [];
  for (const row of rows) {
    const pub = publicLetter(row, { viewer });
    if (pub) letters.push(pub);
  }
  let unread = 0;
  if (viewer === 'user') {
    unread = rows.filter((r) => r.role === 'ai' && r.status === 'delivered').length;
  } else {
    unread = rows.filter((r) => r.role === 'user' && r.status === 'delivered').length;
  }
  return {
    book: {
      id: book.id,
      character_id: book.character_id,
      title: book.title,
      char_name: book.char_name,
      char_avatar: book.char_avatar,
    },
    letters,
    unread,
  };
}

function markLetterRead(letterId, { by = 'user' } = {}) {
  const row = db.prepare('SELECT * FROM letter_entries WHERE id=?').get(letterId);
  if (!row) return null;
  if (by === 'user' && row.role !== 'ai') return publicLetter(row);
  if (by === 'char' && row.role !== 'user') return publicLetter(row);
  if (row.status !== 'delivered' && row.status !== 'read') {
    return publicLetter(row, { viewer: by });
  }
  if (row.status === 'delivered') {
    db.prepare(`UPDATE letter_entries SET status='read', read_at=? WHERE id=?`)
      .run(sqlNow(), letterId);
  }
  return publicLetter(db.prepare('SELECT * FROM letter_entries WHERE id=?').get(letterId), { viewer: by });
}

function markAllDeliveredRead(characterId, { by = 'user' } = {}) {
  const book = getBookForCharacter(characterId);
  if (!book) return 0;
  const role = by === 'user' ? 'ai' : 'user';
  const r = db.prepare(`
    UPDATE letter_entries SET status='read', read_at=?
    WHERE book_id=? AND role=? AND status='delivered'
  `).run(sqlNow(), book.id, role);
  return r.changes || 0;
}

function snapshotForTa(characterId) {
  ensureTables();
  const pack = listLetters(characterId, { viewer: 'user' });
  if (!pack.book) {
    return { hasBook: false, unread: 0, preview: null, inTransit: 0 };
  }
  const inTransit = (pack.letters || []).filter((l) => l.role === 'user' && l.status === 'in_transit').length;
  const preview = (pack.letters || []).find((l) => l.status === 'delivered' || l.status === 'read' || l.role === 'user') || null;
  return {
    hasBook: true,
    bookId: pack.book.id,
    unread: pack.unread,
    inTransit,
    preview: preview
      ? {
          id: preview.id,
          role: preview.role,
          status: preview.status,
          transitHint: preview.transitHint,
          excerpt: String(preview.content || '').replace(/\s+/g, ' ').trim().slice(0, 48),
        }
      : null,
  };
}

function promptBlockForChar(characterId) {
  try {
    const ta = require('./ta-helper');
    if (!ta.isBoundCharacter?.(characterId)) return '';
  } catch {}
  ensureTables();
  const pack = listLetters(characterId, { viewer: 'char' });
  if (!pack.book) return '';
  const lines = [];
  const unread = (pack.letters || []).filter((l) => l.role === 'user' && l.status === 'delivered');
  const mineTransit = (pack.letters || []).filter((l) => l.role === 'ai' && l.status === 'in_transit');
  if (unread.length) {
    lines.push(`【TA·信箱】有 ${unread.length} 封对方的来信已到，可以读。回不回按性格；若回，也要再过一阵才寄出，不要说「马上回」或报几天到。`);
    const latest = unread[0];
    if (latest?.content) {
      lines.push(`最近一封大意：${String(latest.content).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
  }
  if (mineTransit.length) {
    lines.push(`【TA·信箱】你寄出的信还在路上（${mineTransit[0].transitHint || '还在路上'}）。不要报精确到达时间。`);
  }
  const waiting = db.prepare(`
    SELECT COUNT(*) as n FROM letter_entries e
    JOIN letter_books b ON b.id=e.book_id
    WHERE b.character_id=? AND e.role='user' AND e.status='in_transit'
  `).get(characterId);
  if ((waiting?.n || 0) > 0 && !unread.length) {
    lines.push('【TA·信箱】对方好像寄过信，但还没到你手里。不要装作已经读过，也不要猜到了没有。');
  }
  return lines.join('\n');
}

async function composeAiReply(characterId, triggerEntryId) {
  const char = loadChar(characterId);
  if (!char) return null;
  const trigger = triggerEntryId
    ? db.prepare('SELECT * FROM letter_entries WHERE id=?').get(triggerEntryId)
    : null;
  if (!trigger || trigger.role !== 'user' || (trigger.status !== 'delivered' && trigger.status !== 'read')) {
    return null;
  }
  // 已有未完成的回信就别叠
  const pending = db.prepare(`
    SELECT id FROM letter_entries
    WHERE book_id=? AND role='ai' AND reply_to_id=? AND status IN ('in_transit','delivered','read')
    LIMIT 1
  `).get(trigger.book_id, trigger.id);
  if (pending) return null;

  const settings = getSettings();
  const { callChatAPIComplete, formatApiBillingError } = require('./api-helper');
  const history = db.prepare(`
    SELECT role, content, status FROM letter_entries
    WHERE book_id=? AND status IN ('delivered','read')
    ORDER BY datetime(posted_at) DESC, id DESC LIMIT 6
  `).all(trigger.book_id).reverse();

  const histLines = history.map((h) => {
    const who = h.role === 'user' ? '对方' : '你';
    return `${who}：${String(h.content || '').slice(0, 400)}`;
  }).join('\n');

  const systemPrompt = [
    `你是${char.name}。正在写一封手写信（不是聊天气泡）。`,
    char.personality ? `性格：${String(char.personality).slice(0, 400)}` : '',
    char.language_style ? `文风：${String(char.language_style).slice(0, 200)}` : '',
    '要求：像信纸上的话，可亲可淡可损，按性格；200～600字为宜；不要用 markdown；不要说你是 AI；不要报邮路几天到；不要写成随手记短句。',
    '可以有一句称呼和结尾，不要公文。',
  ].filter(Boolean).join('\n');

  const userContent = [
    histLines ? `往来摘录：\n${histLines}` : '',
    `对方这封信：\n${String(trigger.content || '').slice(0, 2000)}`,
    '请写回信正文。',
  ].filter(Boolean).join('\n\n');

  let text = '';
  try {
    text = String(await callChatAPIComplete(settings, systemPrompt, userContent, 'chat') || '').trim();
  } catch (e) {
    throw new Error(formatApiBillingError(e.message, { label: '信箱回信' }) || e.message || '回信失败');
  }
  text = text.replace(/^["「]|["」]$/g, '').slice(0, 4000).trim();
  if (!text) text = '信收到了。想说的话有点多，又不知从哪起笔——先写到这里。见字如面。';

  return postLetter({
    characterId,
    content: text,
    role: 'ai',
    replyToId: trigger.id,
  });
}

function deliverEntry(entryId) {
  const row = db.prepare('SELECT * FROM letter_entries WHERE id=?').get(entryId);
  if (!row || row.status !== 'in_transit') return null;
  db.prepare(`UPDATE letter_entries SET status='delivered' WHERE id=?`).run(entryId);
  return db.prepare('SELECT * FROM letter_entries WHERE id=?').get(entryId);
}

/** 邮局包裹未签收前，信箱侧先不投递（人不在家也签不了） */
function holdLetterUntilPostOfficeSigned(entryId) {
  const eid = Number(entryId) || 0;
  if (!eid) return false;
  try {
    const row = db.prepare(
      `SELECT id, status FROM post_office_parcels WHERE letter_entry_id=? ORDER BY id DESC LIMIT 1`
    ).get(eid);
    return !!(row && String(row.status) === 'in_transit');
  } catch {
    return false;
  }
}

function deliverLinkedLetterForParcel(characterId, entryId) {
  const delivered = deliverEntry(entryId);
  if (!delivered) return null;
  try {
    const { push } = require('./push');
    push('letter_updated', {
      characterId,
      bookId: delivered.book_id,
      entryId: delivered.id,
      role: delivered.role,
      event: 'delivered',
    });
  } catch {}
  if (delivered.role === 'user') {
    const char = loadChar(characterId);
    const composeAt = isoFromMs(Date.now() + sampleComposeDelayMs(char));
    enqueueJob({
      bookId: delivered.book_id,
      characterId,
      entryId: delivered.id,
      kind: 'compose_reply',
      runAt: composeAt,
    });
  }
  return delivered;
}

let _letterJobBusy = false;

async function processDueLetterJobs() {
  if (_letterJobBusy) return { processed: 0, skipped: true };
  _letterJobBusy = true;
  try {
    ensureTables();
    const now = sqlNow();
    const jobs = db.prepare(`
      SELECT * FROM letter_jobs
      WHERE done=0 AND datetime(run_at) <= datetime(?)
      ORDER BY datetime(run_at) ASC
      LIMIT 8
    `).all(now);
    let processed = 0;
    for (const job of jobs) {
      // 认领，防重叠
      db.prepare(`UPDATE letter_jobs SET run_at=? WHERE id=? AND done=0`)
        .run(isoFromMs(Date.now() + 12 * 60 * 1000), job.id);
      try {
        if (job.kind === 'deliver') {
          if (holdLetterUntilPostOfficeSigned(job.entry_id)) {
            db.prepare(`UPDATE letter_jobs SET run_at=? WHERE id=? AND done=0`)
              .run(isoFromMs(Date.now() + 20 * 60 * 1000), job.id);
            continue;
          }
          const delivered = deliverEntry(job.entry_id);
          db.prepare(`UPDATE letter_jobs SET done=1 WHERE id=?`).run(job.id);
          processed += 1;
          if (delivered) {
            try {
              const { push } = require('./push');
              push('letter_updated', {
                characterId: job.character_id,
                bookId: job.book_id,
                entryId: delivered.id,
                role: delivered.role,
                event: 'delivered',
              });
            } catch {}
          }
          if (delivered && delivered.role === 'user') {
            const char = loadChar(job.character_id);
            const composeAt = isoFromMs(Date.now() + sampleComposeDelayMs(char));
            enqueueJob({
              bookId: job.book_id,
              characterId: job.character_id,
              entryId: delivered.id,
              kind: 'compose_reply',
              runAt: composeAt,
            });
          }
        } else if (job.kind === 'compose_reply') {
          // 动手回信时视为已读对方来信
          try { markLetterRead(job.entry_id, { by: 'char' }); } catch {}
          await composeAiReply(job.character_id, job.entry_id);
          db.prepare(`UPDATE letter_jobs SET done=1 WHERE id=?`).run(job.id);
          processed += 1;
        } else {
          db.prepare(`UPDATE letter_jobs SET done=1 WHERE id=?`).run(job.id);
        }
      } catch (e) {
        console.warn('[letter] job', job.id, e.message);
        // 稍后再试
        db.prepare(`UPDATE letter_jobs SET run_at=? WHERE id=? AND done=0`)
          .run(isoFromMs(Date.now() + 20 * 60 * 1000), job.id);
      }
    }
    return { processed };
  } finally {
    _letterJobBusy = false;
  }
}

module.exports = {
  ensureTables,
  getOrCreateBook,
  getBook,
  getBookForCharacter,
  postLetter,
  listLetters,
  markLetterRead,
  markAllDeliveredRead,
  snapshotForTa,
  promptBlockForChar,
  processDueLetterJobs,
  sampleTransitDelayMs,
  fuzzyTransitHint,
  publicLetter,
  deliverLinkedLetterForParcel,
};

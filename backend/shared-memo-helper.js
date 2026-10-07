/** 共享备忘录：一本角色一本，每天主动写 1 次 + 跟写互动（跟写不过零点） */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { callChatAPIComplete, generateImage, toAbsoluteMediaUrl, buildHistoryApiMessages, formatApiBillingError } = require('./api-helper');
const { appendPresetsToPrompt } = require('./preset-helper');
const { getAvailableEmojis, collectEmojiMarkMatches, stripEmojiMarksFromText } = require('./emoji-helper');
const { buildInlineBeanPromptSection, sanitizeInlineBeans } = require('./inline-emoji-helper');
const { push } = require('./push');
const { queueAlbumSave } = require('./album-helper');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function getLocalDateStr(date = new Date(), tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Intl 在部分环境会把午夜收成 24:xx，统一成 00:xx，避免日期串比较把条目滤掉 */
function normalizeHourToken(h) {
  const n = parseInt(h, 10);
  if (!Number.isFinite(n)) return '00';
  if (n === 24) return '00';
  return String(Math.max(0, Math.min(23, n))).padStart(2, '0');
}

function nowSql(tz = 'Asia/Shanghai') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const g = (t) => parts.find(p => p.type === t)?.value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${normalizeHourToken(g('hour'))}:${g('minute')}:${g('second')}`;
  } catch {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
}

function parseJsonArr(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function serializeEntry(row) {
  if (!row) return null;
  return {
    ...row,
    images: parseJsonArr(row.images),
    emojis: parseJsonArr(row.emojis),
    annotations: parseJsonArr(row.annotations),
  };
}

/** 目录/增量列表：截断正文、只留短地址首图，大幅减小传输体积 */
function liteImageUrl(u) {
  const s = String(u || '').trim();
  if (!s || s.startsWith('data:')) return '';
  if (s.length > 400) return '';
  return s;
}

function serializeEntryLite(row) {
  if (!row) return null;
  const images = parseJsonArr(row.images).filter(Boolean);
  const emojis = parseJsonArr(row.emojis);
  const content = String(row.content || '');
  const thumb = liteImageUrl(images[0]);
  return {
    id: row.id,
    book_id: row.book_id,
    role: row.role,
    type: row.type,
    content: content.length > 120 ? content.slice(0, 120) : content,
    visible_at: row.visible_at,
    created_at: row.created_at,
    images: thumb ? [thumb] : [],
    emojis: emojis.slice(0, 2),
    annotations: [],
    _hasImage: images.length > 0,
    _lite: 1,
  };
}

const MARK_TYPE_LABEL = {
  circle: '圈',
  strike: '划掉',
  line: '划线',
  note: '旁注',
};

function formatAnnotationsForContext(annotations, byWho) {
  const list = Array.isArray(annotations) ? annotations : [];
  if (!list.length) return '';
  return list.map((a) => {
    const kind = MARK_TYPE_LABEL[a.type] || a.type || '批';
    const quote = String(a.quote || '').trim();
    const note = String(a.note || '').trim();
    const who = a.by === 'ai' ? '我' : (byWho || '对方');
    let s = `${who}${kind}`;
    if (quote) s += `「${quote}」`;
    if (note) s += `：${note}`;
    return s;
  }).join('；');
}

function normalizeAnnotation(raw, fallbackBy = 'user') {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim();
  if (!['circle', 'strike', 'line', 'note'].includes(type)) return null;
  const quote = String(raw.quote || '').trim().slice(0, 80);
  if (!quote) return null;
  const note = String(raw.note || '').trim().slice(0, 120);
  let color = String(raw.color || '').trim();
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) color = '';
  const by = raw.by === 'ai' ? 'ai' : 'user';
  return {
    id: String(raw.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    by: by || fallbackBy,
    type,
    quote,
    note,
    color,
    at: String(raw.at || new Date().toISOString()),
  };
}

function appendAnnotationsToEntry(entryId, marks, by = 'ai') {
  const row = db.prepare('SELECT * FROM shared_memo_entries WHERE id=?').get(entryId);
  if (!row) return null;
  const existing = parseJsonArr(row.annotations);
  const next = [...existing];
  for (const m of marks || []) {
    const norm = normalizeAnnotation({ ...m, by: m.by || by }, by);
    if (!norm) continue;
    // 同类型+同 quote 已存在则跳过（避免重复批）
    if (next.some((x) => x.type === norm.type && x.quote === norm.quote && x.by === norm.by)) continue;
    next.push(norm);
  }
  db.prepare('UPDATE shared_memo_entries SET annotations=? WHERE id=?').run(JSON.stringify(next), entryId);
  return serializeEntry(db.prepare('SELECT * FROM shared_memo_entries WHERE id=?').get(entryId));
}

function updateEntryAnnotations(bookId, entryId, annotations, { merge = false, by = 'user' } = {}) {
  const row = db.prepare('SELECT * FROM shared_memo_entries WHERE id=? AND book_id=?').get(entryId, bookId);
  if (!row) return null;
  let next;
  if (merge) {
    next = parseJsonArr(row.annotations);
    for (const m of annotations || []) {
      const norm = normalizeAnnotation(m, by);
      if (!norm) continue;
      const idx = next.findIndex((x) =>
        (norm.id && x.id === norm.id)
        || (x.type === norm.type && x.quote === norm.quote && (x.by || 'user') === (norm.by || 'user'))
      );
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...norm, id: next[idx].id || norm.id };
      } else {
        next.push(norm);
      }
    }
  } else {
    next = (annotations || []).map((m) => normalizeAnnotation(m, by)).filter(Boolean);
  }
  db.prepare('UPDATE shared_memo_entries SET annotations=? WHERE id=?').run(JSON.stringify(next), entryId);
  return serializeEntry(db.prepare('SELECT * FROM shared_memo_entries WHERE id=?').get(entryId));
}

/** 解析 AI 文中的 [批:type|quote|note] 标记 */
function applySharedMemoAnnotationMarks(text) {
  const marks = [];
  let out = String(text || '');
  out = out.replace(/\[\s*批\s*[:：]\s*(circle|strike|line|note)\s*\|\s*([^\]|]+)\s*(?:\|\s*([^\]]*))?\s*\]/gi, (_, type, quote, note) => {
    marks.push({
      type: String(type).toLowerCase(),
      quote: String(quote || '').trim(),
      note: String(note || '').trim(),
      by: 'ai',
    });
    return '';
  });
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), marks };
}

function listSharedMemoBooks() {
  // 一次查出书架：计数 + 最新一条预览，避免 N+1
  const rows = db.prepare(`
    SELECT b.*, c.name as char_name, c.avatar as char_avatar,
      (SELECT COUNT(*) FROM shared_memo_entries e
        WHERE e.book_id=b.id AND e.status='visible') AS entry_count,
      (SELECT e2.content FROM shared_memo_entries e2
        WHERE e2.book_id=b.id AND e2.status='visible'
        ORDER BY datetime(e2.visible_at) DESC, e2.id DESC LIMIT 1) AS last_content,
      (SELECT e2.type FROM shared_memo_entries e2
        WHERE e2.book_id=b.id AND e2.status='visible'
        ORDER BY datetime(e2.visible_at) DESC, e2.id DESC LIMIT 1) AS last_type,
      (SELECT e2.visible_at FROM shared_memo_entries e2
        WHERE e2.book_id=b.id AND e2.status='visible'
        ORDER BY datetime(e2.visible_at) DESC, e2.id DESC LIMIT 1) AS last_at
    FROM shared_memo_books b
    LEFT JOIN characters c ON c.id = b.character_id
    ORDER BY b.id DESC
  `).all();
  return rows.map(b => {
    const lastType = b.last_type;
    const lastContent = b.last_content;
    const lastAt = b.last_at;
    return {
      id: b.id,
      character_id: b.character_id,
      title: b.title || `和${b.char_name || 'TA'}的随手记`,
      created_at: b.created_at,
      char_name: b.char_name,
      char_avatar: b.char_avatar,
      entry_count: Number(b.entry_count) || 0,
      last_preview: lastContent != null || lastType
        ? (lastType === 'image' || lastType === 'emoji'
          ? `[${lastType === 'image' ? '图片' : '表情'}]`
          : String(lastContent || '').slice(0, 40))
        : '',
      last_at: lastAt || b.created_at,
    };
  });
}

function getOrCreateBook(characterId, title) {
  const cid = Number(characterId);
  if (!cid) throw new Error('characterId required');
  const char = db.prepare('SELECT id, name FROM characters WHERE id=?').get(cid);
  if (!char) throw new Error('角色不存在');
  let book = db.prepare('SELECT * FROM shared_memo_books WHERE character_id=?').get(cid);
  if (book) {
    ensureProactiveJobsForToday(book.id, cid);
    return book;
  }
  const t = String(title || '').trim() || `和${char.name}的随手记`;
  const r = db.prepare(
    `INSERT INTO shared_memo_books (character_id, title) VALUES (?,?)`
  ).run(cid, t);
  book = db.prepare('SELECT * FROM shared_memo_books WHERE id=?').get(r.lastInsertRowid);
  ensureProactiveJobsForToday(book.id, cid);
  return book;
}

function getBook(bookId) {
  return db.prepare(`
    SELECT b.*, c.name as char_name, c.avatar as char_avatar
    FROM shared_memo_books b
    LEFT JOIN characters c ON c.id = b.character_id
    WHERE b.id=?
  `).get(bookId);
}

function updateBook(bookId, { title } = {}) {
  const book = getBook(bookId);
  if (!book) return null;
  if (title !== undefined) {
    const t = String(title || '').trim();
    if (!t) throw new Error('标题不能为空');
    db.prepare('UPDATE shared_memo_books SET title=? WHERE id=?').run(t.slice(0, 64), bookId);
  }
  return getBook(bookId);
}

/**
 * @param {number} bookId
 * @param {{ since?: string, date?: string, lite?: boolean }} [opts]
 *   - date: 仅某一天 YYYY-MM-DD（日页阅读，做表情 hydrate）
 *   - since: 该日及之后（含）YYYY-MM-DD；用于「只刷今天」
 *   - lite: 目录轻量字段（截断正文/首图）；date 查询忽略 lite，始终完整
 */
function listEntries(bookId, opts = {}) {
  const now = nowSql(getSettings().timezone || 'Asia/Shanghai');
  const date = String(opts.date || '').trim().slice(0, 10);
  const since = String(opts.since || '').trim().slice(0, 10);
  const wantLite = opts.lite === true || opts.lite === 1 || opts.lite === '1';
  let rows;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    rows = db.prepare(`
      SELECT * FROM shared_memo_entries
      WHERE book_id=? AND status='visible' AND substr(visible_at, 1, 10)=?
      ORDER BY datetime(visible_at) ASC, id ASC
    `).all(bookId, date);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    rows = db.prepare(`
      SELECT * FROM shared_memo_entries
      WHERE book_id=? AND status='visible' AND substr(visible_at, 1, 10)>=?
      ORDER BY datetime(visible_at) ASC, id ASC
    `).all(bookId, since);
  } else {
    rows = db.prepare(`
      SELECT * FROM shared_memo_entries WHERE book_id=? AND status='visible'
      ORDER BY datetime(visible_at) ASC, id ASC
    `).all(bookId);
  }
  const visible = rows.filter(r => String(r.visible_at || '') <= now);
  // 目录/增量：默认 lite，不做表情 hydrate（避免每条查表情库 + 写回）
  // 打开某一天时再 hydrate，量小且前端也会解析标记
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // since 增量默认也 lite；显式 lite=0 才回完整（一般不需要）
    if (wantLite || opts.lite == null) return visible.map(serializeEntryLite);
    return visible.map(serializeEntry);
  }
  const book = getBook(bookId);
  const char = book?.character_id
    ? db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id)
    : null;
  return visible.map(r => hydrateEntryEmojis(r, char, { persist: false }));
}

function detectType({ content, images, emojis }) {
  const hasText = !!String(content || '').trim();
  const hasImg = Array.isArray(images) && images.length > 0;
  const hasEmoji = Array.isArray(emojis) && emojis.length > 0;
  const n = [hasText, hasImg, hasEmoji].filter(Boolean).length;
  if (n > 1) return 'mixed';
  if (hasImg) return 'image';
  if (hasEmoji) return 'emoji';
  return 'text';
}

/**
 * 当天内随机回写时间（朋友圈式）
 * - 持续互动时可更快
 * - 必须落在今天结束前；过了零点就不跟写了（返回 null）
 */
function pickRandomRunAt(tz = 'Asia/Shanghai', { quicker = false, recent = false } = {}) {
  const now = new Date();
  const today = getLocalDateStr(now, tz);
  const nowLocal = nowSql(tz);
  const nowH = parseInt(normalizeHourToken(nowLocal.slice(11, 13)), 10) || 0;
  const nowM = parseInt(nowLocal.slice(14, 16), 10) || 0;
  const nowMins = nowH * 60 + nowM;
  const dayEndMins = 23 * 60 + 50; // 当天截止
  const minsLeft = dayEndMins - nowMins;
  if (minsLeft < 2) return null; // 已到/过截止，当天随手记结束

  let minDelayMs;
  let maxDelayMs;
  if (recent) {
    minDelayMs = (25 + Math.floor(Math.random() * 35)) * 1000;
    maxDelayMs = (90 + Math.floor(Math.random() * 150)) * 1000;
  } else if (quicker) {
    minDelayMs = (45 + Math.floor(Math.random() * 75)) * 1000;
    maxDelayMs = (2 + Math.floor(Math.random() * 4)) * 60 * 1000;
  } else {
    minDelayMs = (2 + Math.floor(Math.random() * 3)) * 60 * 1000;
    maxDelayMs = (5 + Math.floor(Math.random() * 8)) * 60 * 1000;
  }

  const untilEndMs = Math.max(0, minsLeft * 60 * 1000);
  maxDelayMs = Math.min(maxDelayMs, untilEndMs);
  if (minDelayMs >= untilEndMs) {
    // 只剩一点时间：尽量赶在截止前
    minDelayMs = Math.min(30 * 1000, untilEndMs / 2);
    maxDelayMs = untilEndMs;
  }
  if (maxDelayMs <= minDelayMs) {
    minDelayMs = Math.max(1000, untilEndMs * 0.2);
    maxDelayMs = untilEndMs;
  }
  if (maxDelayMs < 1000) return null;

  const span = Math.max(1000, maxDelayMs - minDelayMs);
  const run = new Date(now.getTime() + minDelayMs + Math.random() * span);
  const runAt = formatLocalSql(run, tz);
  // 硬钳：绝不跨到次日
  if (String(runAt).slice(0, 10) !== today) {
    return localMinsToSql(today, dayEndMins, tz);
  }
  return runAt;
}

function formatLocalSql(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(date);
    const g = (t) => parts.find(p => p.type === t)?.value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${normalizeHourToken(g('hour'))}:${g('minute')}:${g('second')}`;
  } catch {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }
}

/** 把本地「当天分钟数」写成 SQL 时间串（不依赖裸 Date 解析时区） */
function localMinsToSql(dateStr, mins, tz) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.floor(mins)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  const s = Math.floor(Math.random() * 50);
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  // 用「现在」校准：构造一个近似 UTC，再 format 回目标时区核对日期
  const probe = new Date(`${dateStr}T${hh}:${mm}:${ss}+08:00`);
  if (!Number.isNaN(probe.getTime())) {
    const got = getLocalDateStr(probe, tz);
    if (got === dateStr) return `${dateStr} ${hh}:${mm}:${ss}`;
  }
  return `${dateStr} ${hh}:${mm}:${ss}`;
}

function addLocalDays(dateStr, days) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const MEMO_UPLOADS_DIR = path.join(__dirname, 'uploads');

/** 外链/data URI 落成本地 /uploads，避免过期或手机打不开 */
async function localizeMemoImageUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (s.startsWith('/uploads/')) return s;
  try {
    if (!fs.existsSync(MEMO_UPLOADS_DIR)) fs.mkdirSync(MEMO_UPLOADS_DIR, { recursive: true });
    let buf;
    let ext = 'jpg';
    if (s.startsWith('data:image/')) {
      const m = s.match(/^data:image\/([\w+.-]+);base64,(.+)$/i);
      if (!m) return s;
      ext = String(m[1] || 'jpeg').toLowerCase().replace('jpeg', 'jpg').split('+')[0] || 'jpg';
      if (!/^(jpg|png|webp|gif)$/.test(ext)) ext = 'jpg';
      buf = Buffer.from(m[2], 'base64');
    } else if (/^https?:\/\//i.test(s)) {
      const resp = await fetch(s);
      if (!resp.ok) return s;
      buf = Buffer.from(await resp.arrayBuffer());
      const ct = String(resp.headers.get('content-type') || '');
      if (ct.includes('png')) ext = 'png';
      else if (ct.includes('webp')) ext = 'webp';
      else if (ct.includes('gif')) ext = 'gif';
    } else {
      return s;
    }
    if (!buf?.length) return s;
    const filename = `memo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(MEMO_UPLOADS_DIR, filename), buf);
    return `/uploads/${filename}`;
  } catch (e) {
    console.warn('[shared-memo] localize image', e.message);
    return s;
  }
}

function insertEntry({
  bookId, role = 'user', content = '', images = [], emojis = [],
  replyToId = null, status = 'visible', visibleAt = null,
}) {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const type = detectType({ content, images, emojis });
  const vis = visibleAt || nowSql(tz);
  const r = db.prepare(`
    INSERT INTO shared_memo_entries
      (book_id, role, type, content, images, emojis, reply_to_id, status, visible_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    bookId,
    role === 'ai' ? 'ai' : 'user',
    type,
    String(content || ''),
    JSON.stringify(images || []),
    JSON.stringify(emojis || []),
    replyToId || null,
    status,
    vis,
  );
  return serializeEntry(db.prepare('SELECT * FROM shared_memo_entries WHERE id=?').get(r.lastInsertRowid));
}

function enqueueReactJob(bookId, characterId, triggerEntryId, kind = 'react') {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  // 用户刚写：删掉尚未执行的主动随写，避免和跟写叠成多条。
  // 今天是否再补主动由 ensureProactiveJobsForToday 看「用户是否已先写」决定，不要标 done（会误当成已主动过）。
  if (kind === 'react' && triggerEntryId) {
    db.prepare(
      `DELETE FROM shared_memo_jobs WHERE book_id=? AND kind='proactive' AND done=0`
    ).run(bookId);
  }
  // 触发条若已是昨天及更早：当天已结束，不再跟写
  if (triggerEntryId) {
    const trigger = db.prepare('SELECT visible_at, created_at FROM shared_memo_entries WHERE id=?')
      .get(triggerEntryId);
    const triggerDay = String(trigger?.visible_at || trigger?.created_at || '').slice(0, 10);
    const today = getLocalDateStr(new Date(), tz);
    if (triggerDay && triggerDay < today) return null;
  }
  // 同一天已有往来时跟写更快；最近刚写过则几乎即时回
  const today = getLocalDateStr(new Date(), tz);
  const prior = db.prepare(`
    SELECT COUNT(*) as n FROM shared_memo_entries
    WHERE book_id=? AND status='visible' AND substr(visible_at,1,10)=?
  `).get(bookId, today);
  const quicker = (prior?.n || 0) >= 1;
  const lastEntry = db.prepare(`
    SELECT visible_at FROM shared_memo_entries
    WHERE book_id=? AND status='visible'
    ORDER BY datetime(visible_at) DESC LIMIT 1
  `).get(bookId);
  let recent = false;
  if (lastEntry?.visible_at) {
    const lastMs = new Date(String(lastEntry.visible_at).replace(' ', 'T')).getTime();
    if (!Number.isNaN(lastMs)) recent = Date.now() - lastMs < 2 * 3600 * 1000;
  }
  const runAt = kind === 'annotate'
    ? (() => {
        const t = formatLocalSql(new Date(Date.now() + (2 + Math.random() * 8) * 60000), tz);
        // 批注跟写也不得跨日
        if (String(t).slice(0, 10) !== today) return null;
        return t;
      })()
    : pickRandomRunAt(tz, { quicker, recent });
  if (!runAt) return null; // 当天已结束 / 来不及，不再排队
  // 同一触发条目不重复排队
  if (triggerEntryId) {
    const exists = db.prepare(
      `SELECT id FROM shared_memo_jobs WHERE trigger_entry_id=? AND kind=? AND done=0`
    ).get(triggerEntryId, kind);
    if (exists) return exists.id;
  }
  const r = db.prepare(`
    INSERT INTO shared_memo_jobs (book_id, character_id, trigger_entry_id, kind, run_at, done)
    VALUES (?,?,?,?,?,0)
  `).run(bookId, characterId, triggerEntryId || null, kind, runAt);
  return r.lastInsertRowid;
}

/**
 * 每天为每本共享备忘录预约 1 次「角色主动随手写」
 * 落在白天窗口；绝不在深夜用短延迟跨到次日凌晨连发。
 */
function pickProactiveRunAt(tz) {
  const today = getLocalDateStr(new Date(), tz);
  const nowLocal = nowSql(tz);
  const nowH = parseInt(normalizeHourToken(nowLocal.slice(11, 13)), 10) || 0;
  const nowM = parseInt(nowLocal.slice(14, 16), 10) || 0;
  const nowMins = nowH * 60 + nowM;
  // 白天窗口（本地分钟）
  const windows = [
    { start: 9 * 60 + 20, span: 4 * 60 },
    { start: 14 * 60, span: 4 * 60 },
    { start: 19 * 60, span: 3 * 60 + 30 },
  ];
  for (const w of windows) {
    const end = w.start + w.span;
    const lo = Math.max(nowMins + 8, w.start);
    if (lo < end - 5) {
      const pick = lo + Math.random() * (end - lo);
      return localMinsToSql(today, pick, tz);
    }
  }
  // 今天窗口已过：排到明天上午，避免 23:xx + 短延迟在 0 点连发
  const tomorrow = addLocalDays(today, 1);
  const morningLo = 9 * 60 + 20;
  const morningHi = 9 * 60 + 20 + 4 * 60;
  const pick = morningLo + Math.random() * (morningHi - morningLo);
  return localMinsToSql(tomorrow, pick, tz);
}

function ensureProactiveJobsForToday(bookId, characterId) {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  // 每天只主动写 1 次：已有主动条目则不再预约
  const aiProactive = db.prepare(`
    SELECT id FROM shared_memo_entries
    WHERE book_id=? AND role='ai' AND reply_to_id IS NULL
      AND substr(visible_at,1,10)=?
    LIMIT 1
  `).get(bookId, today);
  if (aiProactive) return;

  // 用户今天已先写过：跟写优先，不再补主动（避免删掉待执行主动后又被小时任务插回来）
  const userToday = db.prepare(`
    SELECT id FROM shared_memo_entries
    WHERE book_id=? AND role='user' AND substr(visible_at,1,10)=?
    LIMIT 1
  `).get(bookId, today);
  if (userToday) return;

  const pending = db.prepare(
    `SELECT id, run_at FROM shared_memo_jobs WHERE book_id=? AND kind='proactive' AND done=0 LIMIT 1`
  ).get(bookId);
  if (pending) {
    // 若待执行任务已跨到明日及以后，今天不再另插；若 run_at 仍是过去某天残留，改到今天窗口
    const runDay = String(pending.run_at || '').slice(0, 10);
    if (runDay && runDay < today) {
      const runAt = pickProactiveRunAt(tz);
      if (String(runAt).slice(0, 10) === today) {
        db.prepare('UPDATE shared_memo_jobs SET run_at=? WHERE id=?').run(runAt, pending.id);
      } else {
        // 今天已无窗口：标完成，避免昨夜残留任务在凌晨再跑一次
        db.prepare('UPDATE shared_memo_jobs SET done=1 WHERE id=?').run(pending.id);
      }
    }
    return;
  }

  // done=1 但今天没有主动条目：多半是旧版「占坑后崩溃/误标完成」，清掉后重排
  const stuckDone = db.prepare(`
    SELECT id FROM shared_memo_jobs
    WHERE book_id=? AND kind='proactive' AND done=1 AND substr(run_at,1,10)=?
  `).all(bookId, today);
  if (stuckDone.length) {
    db.prepare(`
      DELETE FROM shared_memo_jobs
      WHERE book_id=? AND kind='proactive' AND done=1 AND substr(run_at,1,10)=?
    `).run(bookId, today);
  }

  const runAt = pickProactiveRunAt(tz);
  db.prepare(`
    INSERT INTO shared_memo_jobs (book_id, character_id, trigger_entry_id, kind, run_at, done)
    VALUES (?,?,NULL,'proactive',?,0)
  `).run(bookId, characterId, runAt);
}

/** 给所有共享本补齐今日主动随写任务 */
function scheduleProactiveSharedMemos() {
  const books = db.prepare('SELECT id, character_id FROM shared_memo_books').all();
  for (const b of books) {
    try {
      // 同一本书若因竞态留下多条未完成主动任务，只留最早一条
      const extras = db.prepare(`
        SELECT id FROM shared_memo_jobs
        WHERE book_id=? AND kind='proactive' AND done=0
        ORDER BY datetime(run_at) ASC, id ASC
      `).all(b.id);
      if (extras.length > 1) {
        const keep = extras[0].id;
        db.prepare(
          `UPDATE shared_memo_jobs SET done=1 WHERE book_id=? AND kind='proactive' AND done=0 AND id!=?`
        ).run(b.id, keep);
      }
      ensureProactiveJobsForToday(b.id, b.character_id);
    } catch (e) {
      console.warn('[shared-memo] schedule proactive', b.id, e.message);
    }
  }
  return { books: books.length };
}

async function describeImageBrief(settings, imageUrl, publicBase) {
  try {
    const abs = toAbsoluteMediaUrl(imageUrl, publicBase || '');
    const picMsg = { id: 'sm_img_' + Date.now(), role: 'user', content: abs, type: 'image' };
    const apiHistory = buildHistoryApiMessages([picMsg], publicBase || '', {});
    // 在最后一条加文字说明
    if (apiHistory.length) {
      const last = apiHistory[apiHistory.length - 1];
      if (Array.isArray(last.content)) {
        last.content.unshift({ type: 'text', text: '用一两句中文描述这张图里有什么，只说画面，不要寒暄。' });
      } else {
        apiHistory.push({
          role: 'user',
          content: '用一两句中文描述上一张图里有什么，只说画面，不要寒暄。',
        });
      }
    }
    const raw = await callChatAPIComplete(
      settings,
      '你是简短识图助手，只输出画面描述。',
      null,
      'chat',
      apiHistory,
    );
    return String(raw || '').trim().slice(0, 120);
  } catch (e) {
    console.warn('[shared-memo] describe image', e.message);
    return '';
  }
}

async function buildMediaContext(entry, settings, publicBase) {
  const parts = [];
  const images = entry.images || [];
  const emojis = entry.emojis || [];
  for (const url of images.slice(0, 2)) {
    const desc = await describeImageBrief(settings, url, publicBase);
    parts.push(desc ? `（图片：${desc}）` : '（附带一张图片）');
  }
  for (const em of emojis.slice(0, 5)) {
    const d = em.description || em.desc || '';
    parts.push(d ? `（表情包：${d}）` : '（贴了一个表情包）');
  }
  return parts.join(' ');
}

function recentContextText(bookId, limit = 8) {
  const rows = db.prepare(`
    SELECT role, content, type, images, emojis, annotations FROM shared_memo_entries
    WHERE book_id=? AND status='visible'
    ORDER BY datetime(visible_at) DESC, id DESC LIMIT ?
  `).all(bookId, limit).reverse();
  const settings = getSettings();
  const username = settings.username || '旅人';
  return rows.map(r => {
    const who = r.role === 'user' ? username : '我';
    // 正文里的 [em|url|desc] 是给前端显示用的，喂给模型前要剥掉，
    // 否则模型会学着原样抄写 URL 标记，或退化成 [表情：描述] 这种解析不了的变体
    let line = String(r.content || '')
      .replace(/\[em\|[^\]|]+\|([^\]]*)\]/g, (_, d) => (d ? `[表情]${d}[/表情]` : ''))
      .replace(/\s+/g, ' ')
      .trim();
    const imgs = parseJsonArr(r.images);
    const ems = parseJsonArr(r.emojis);
    if (imgs.length) line += (line ? ' ' : '') + `[图片×${imgs.length}]`;
    // 正文里已经用 [表情]desc[/表情] 还原过的就不要再追加一遍
    if (ems.length && !/\[表情\]/.test(line)) {
      for (const e of ems) {
        const ds = e.description || e.desc || '';
        if (ds) line += (line ? ' ' : '') + `[表情]${ds}[/表情]`;
      }
    }
    const ann = formatAnnotationsForContext(parseJsonArr(r.annotations), username);
    if (ann) line += (line ? ' ' : '') + `（纸上批注：${ann}）`;
    return `${who}：${line || '（空）'}`;
  }).join('\n');
}

/** 触发条之前，同一天是否已有角色写过（角色先写 → 用户后写 → 只互动） */
function aiWroteEarlierSameDay(bookId, triggerEntry) {
  if (!triggerEntry) return false;
  const day = String(triggerEntry.visible_at || triggerEntry.created_at || '').slice(0, 10);
  if (!day || day === '未知') return false;
  const row = db.prepare(`
    SELECT id FROM shared_memo_entries
    WHERE book_id=? AND role='ai' AND status='visible'
      AND substr(visible_at,1,10)=?
      AND (
        datetime(visible_at) < datetime(?)
        OR (datetime(visible_at)=datetime(?) AND id < ?)
      )
    LIMIT 1
  `).get(
    bookId,
    day,
    triggerEntry.visible_at || triggerEntry.created_at,
    triggerEntry.visible_at || triggerEntry.created_at,
    triggerEntry.id,
  );
  return !!row;
}

function buildSharedMemoEmojiHint(char) {
  const emojis = getAvailableEmojis(char);
  if (!emojis.length || char?.emoji_enabled === 0 || char?.emoji_enabled === '0') {
    return { hint: '', emojis: [] };
  }
  const fRaw = parseInt(char?.emoji_freq, 10);
  const f = Number.isFinite(fRaw) ? Math.max(0, Math.min(100, fRaw)) : 30;
  // 列表缩短：给太多描述更容易乱配
  const list = emojis.slice(0, 18).map(e => `「${e.description}」`).join('、');
  let freqLine;
  if (f <= 0) {
    freqLine = '默认不要写任何 [表情] 标记；仅当对方这条刚贴了表情包时，才可回一个。';
  } else if (f <= 35) {
    freqLine = '绝大多数条目只用文字或系统小黄豆；表情包极偶尔才用（大约十来条里最多一次）。连续几条禁止都带表情包。';
  } else if (f <= 65) {
    freqLine = '以文字和小黄豆为主；只有情绪特别贴切时才偶尔用一个表情包。同一天不要条条都挂。';
  } else {
    freqLine = '可以比平时多一点表情包，但仍优先小黄豆；一条最多一个，不要刷屏。';
  }
  const hint = `【表情包·克制】${freqLine}
想用时单独写 [表情]描述[/表情]，描述必须与下列之一完全一致（禁止编造、禁止用近义词凑合）：${list}。
情绪优先用系统小黄豆；没有完全匹配的描述就不要发表情包。不要每条都发。`;
  return { hint, emojis };
}

/** 随手记表情包：只接受完全一致的描述，避免 includes 乱配 */
function findMemoEmojiStrict(desc, emojis) {
  const d = String(desc || '')
    .trim()
    .replace(/^[\s「『"'【\[]+|[\s」』"'】\]]+$/g, '')
    .replace(/\/\s*详情\s*$/u, '')
    .trim();
  if (!d) return null;
  const dl = d.toLowerCase();
  return (emojis || []).find((e) => {
    const ed = String(e.description || '').trim();
    if (!ed) return false;
    if (ed === d) return true;
    return ed.toLowerCase() === dl;
  }) || null;
}

function entryHasStickerPack(entry) {
  if (!entry) return false;
  const ems = Array.isArray(entry.emojis)
    ? entry.emojis
    : (() => { try { return JSON.parse(entry.emojis || '[]'); } catch { return []; } })();
  if ((ems || []).some((e) => e?.url && !/\/inline-emoji\//i.test(String(e.url)))) return true;
  const c = String(entry.content || '');
  if (/\[表情|【表情|\[表情包|【表情包/.test(c)) return true;
  // 已落库的贴纸 [em|/uploads/...]
  if (/\[em\|(?![^\]]*inline-emoji)[^\]|]+\|/i.test(c)) return true;
  return entry.type === 'emoji';
}

function stripMemoStickerMarks(text) {
  return String(text || '')
    .replace(/\[em\|([^\]|]+)\|([^\]]*)\]/g, (full, url) => (/\/inline-emoji\//i.test(url) ? full : ''))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 随手记比聊天更克制：冷却 + 概率门，避免条条挂表情包。
 * 对方刚贴了表情包时可回一个。
 */
function shouldSuppressMemoSticker(bookId, char, triggerEntry) {
  if (char?.emoji_enabled === 0 || char?.emoji_enabled === '0') return true;
  const fRaw = parseInt(char?.emoji_freq, 10);
  const f = Number.isFinite(fRaw) ? Math.max(0, Math.min(100, fRaw)) : 30;
  if (f <= 0) return !entryHasStickerPack(triggerEntry);
  if (entryHasStickerPack(triggerEntry)) return false;

  const lastAi = db.prepare(`
    SELECT type, content, emojis FROM shared_memo_entries
    WHERE book_id=? AND role='ai' AND status='visible'
    ORDER BY id DESC LIMIT 1
  `).get(bookId);
  if (lastAi && entryHasStickerPack(lastAi) && f < 90) return true;

  // 近几条 AI 里已经用过 → 再压一档
  const recentAi = db.prepare(`
    SELECT type, content, emojis FROM shared_memo_entries
    WHERE book_id=? AND role='ai' AND status='visible'
    ORDER BY id DESC LIMIT 6
  `).all(bookId);
  const recentHits = recentAi.filter(entryHasStickerPack).length;
  if (recentHits >= 1 && f <= 45) return true;
  if (recentHits >= 2 && f <= 75) return true;

  // 概率门：默认约 30% 频率 → ~12% 放行
  const p = Math.min(0.55, (f / 100) * 0.4);
  return Math.random() > p;
}

const MEMO_IMAGE_CHANCE = 0.18;

function lastAiMemoHadImage(bookId) {
  const last = db.prepare(`
    SELECT images FROM shared_memo_entries
    WHERE book_id=? AND role='ai' AND status='visible'
    ORDER BY id DESC LIMIT 1
  `).get(bookId);
  if (!last?.images) return false;
  try {
    const imgs = JSON.parse(last.images || '[]');
    return Array.isArray(imgs) && imgs.length > 0;
  } catch {
    return false;
  }
}

/** 模型写了 [配图] 也不保证生图：大约 18%，且不连着两条都带图 */
function shouldGenerateMemoImage(bookId, markedWant) {
  if (!markedWant) return false;
  if (lastAiMemoHadImage(bookId)) return false;
  return Math.random() < MEMO_IMAGE_CHANCE;
}

function buildSharedMemoWorldLock(username) {
  return `【跨世界】你和${username}永远不同世界，仅通过这本随手记往来，不能见面、过来、去找。各写各世界的所见所感即可。`;
}

function buildSharedMemoJotGuide() {
  return `【随手记·乱写就行】像纸上随手划，不必正式日记体：
· 刚看到的风景、天气、路边小事；当下心情、吐槽、小愿望
· 偶尔像掏出手机拍一张：窗外、桌上、路灯、随便什么日常碎片（真实环境随手拍，不是手绘插画）
· 几句口语够了，可以不完整、不工整
大多数条目不要配图。大约十几条里偶尔一次，才在文末单独写一行 [配图] 或 [配图：简短中文画面]。系统会据此生成写实手机照片。禁止输出英文生图提示词、禁止动漫插画、手绘、二次元、海报感。不要写「配图：」却不带方括号，也不要抄写 [图片×1] 这类占位。
【纸上批注】偶可对对方正文里某个词批一下（不要每条都批）：单独写 [批:类型|原词|旁注] ，类型仅限 circle（圈词）/strike（划掉）/line（划线）/note（旁注）。旁注可空，旁注语气按人设（可损可淡，勿默认管家式「别太拼」）。例如 [批:circle|加班|] 或 [批:strike|随便|嗯？] 。批注写在回复正文前后均可，系统会画到对方那行字上。`;
}

/** 生图用的英文提示词若被模型抄进正文，整段干掉（勿当旁白露出来） */
function scrubLeakedImageGenPrompt(text) {
  let out = String(text || '').replace(/\r\n/g, '\n');
  // 整行英文摄影/禁令提示
  out = out.replace(
    /(?:^|\n)\s*(?:photorealistic|shot on smartphone|documentary realism|NOT anime|NOT illustration|real-world photograph|camera roll|casual candid)[^\n]*/gi,
    '\n'
  );
  out = out.replace(/(?:^|\n)\s*scene:\s*[^\n]*/gi, '\n');
  out = out.replace(/配图提示词\s*[：:][^\n]*/gi, '');
  // 正文里夹着的英文生图碎片
  out = out.replace(
    /\b(?:photorealistic|documentary realism|NOT anime|NOT illustration|shot on smartphone)[^。\n]{0,200}/gi,
    ''
  );
  return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 解析随手记配图标记。模型常混用聊天写法，需兼容多种变体，避免原文露出来。
 * 支持：[配图] / [配图：描述] / 单独一行的「配图：描述」或 IMAGE: …
 * 纯占位 [图片] / [图片×N] 只剥离、不强制生图（多半是抄上下文）。
 */
function applySharedMemoImageMarks(text) {
  let out = String(text || '').replace(/\r\n/g, '\n');
  let wantImage = false;
  let sceneHint = '';
  const takeScene = (raw) => {
    const d = String(raw || '').trim();
    if (!d || /^(无|none|null|-)$/i.test(d)) return;
    // 英文生图套话不当作画面描述
    if (/photorealistic|NOT anime|documentary realism|shot on smartphone/i.test(d)) return;
    if (!sceneHint) sceneHint = d.slice(0, 120);
  };

  out = out.replace(/\[\s*配图\s*[:：]\s*([^\]]*)\]/gi, (_, desc) => {
    wantImage = true;
    takeScene(desc);
    return '';
  });
  // [配图] 后同一行的描述/英文提示一并吃掉，避免留下生图 prompt
  out = out.replace(/\[\s*配图\s*\]\s*[^\n]*/gi, () => {
    wantImage = true;
    return '';
  });
  out = out.replace(/【\s*配图\s*[:：]?\s*([^】]*)】/gi, (_, desc) => {
    wantImage = true;
    takeScene(desc);
    return '';
  });
  // 聊天同款：单独一行「配图：描述」
  out = out.replace(/(?:^|\n)\s*(?:配图[：:]\s*|IMAGE:\s*)([^\n]*)/gi, (_, desc) => {
    wantImage = true;
    takeScene(desc);
    return '\n';
  });
  // 文末残留的「配图：…」
  out = out.replace(/(?:配图[：:]\s*|IMAGE:\s*)([^\n]*)\s*$/gi, (_, desc) => {
    wantImage = true;
    takeScene(desc);
    return '';
  });
  // 上下文占位被原样抄进正文时：去掉，不因此强制生图
  out = out.replace(/\[\s*图片(?:\s*[×xX]\s*\d+)?\s*\]/g, '');
  out = scrubLeakedImageGenPrompt(out);

  return {
    text: out.replace(/\n{3,}/g, '\n\n').trim(),
    wantImage,
    sceneHint,
  };
}

/** 解析 AI 文中的表情标记，转成正文内联 [em|url|desc] + emojis 数组（与聊天标记集对齐） */
const _memoEmojiAvailCache = new Map(); // charId -> { at, list }
function getAvailableEmojisCached(char) {
  const id = char?.id;
  if (id != null) {
    const hit = _memoEmojiAvailCache.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
  }
  const list = getAvailableEmojis(char);
  if (id != null) _memoEmojiAvailCache.set(id, { at: Date.now(), list });
  return list;
}

function applySharedMemoEmojiMarks(text, char) {
  const raw = String(text || '');
  const emojiOff = char?.emoji_enabled === 0 || char?.emoji_enabled === '0';
  const available = emojiOff ? [] : getAvailableEmojisCached(char);
  if (!available.length) {
    // 关掉表情包 / 无库存：剥掉表情标记，保留文字与小黄豆
    return { text: stripEmojiMarksFromText(raw), emojis: [] };
  }

  const matches = collectEmojiMarkMatches(raw);
  if (!matches.length) {
    // 不随机强贴：只信模型写的标记，避免关提示词后仍乱贴
    return { text: raw.replace(/\n{3,}/g, '\n\n').trim(), emojis: [] };
  }

  const picked = [];
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    if (m.index > cursor) out += raw.slice(cursor, m.index);
    // 严格匹配：描述必须完全一致，禁止模糊 includes 乱配
    const hit = findMemoEmojiStrict(String(m.desc || '').trim(), available);
    if (hit && !picked.some((e) => e.url === hit.url)) {
      picked.push({ url: hit.url, description: hit.description });
      out += `[em|${hit.url}|${hit.description}]`;
    }
    // 匹配不到：丢掉标记，不原样露出
    cursor = m.index + m.len;
  }
  if (cursor < raw.length) out += raw.slice(cursor);
  // 再剥一遍残留变体；同一条最多保留一个表情包
  out = stripEmojiMarksFromText(out);
  const limited = picked.slice(0, 1);
  if (picked.length > 1) {
    for (const extra of picked.slice(1)) {
      out = out.split(`[em|${extra.url}|${extra.description}]`).join('');
    }
  }
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), emojis: limited };
}

/** 读取时兜底：把历史残留的 [表情：描述] 再转一次成 [em|url|desc] */
function hydrateEntryEmojis(row, char, { persist = false } = {}) {
  const entry = serializeEntry(row);
  if (!entry) return null;
  const raw = String(entry.content || '');
  if (!/\[表情|【表情/.test(raw)) return entry;
  const applied = applySharedMemoEmojiMarks(raw, char || {});
  if (applied.text === raw && !(applied.emojis || []).length) return entry;
  entry.content = applied.text;
  // 合并已有 emojis，按 url 去重
  const merged = [...(entry.emojis || [])];
  for (const em of applied.emojis || []) {
    if (em.url && !merged.some(x => x.url === em.url)) merged.push(em);
  }
  entry.emojis = merged;
  // 仅在明确要求时写回（列表读取不再落盘，避免打开随手记卡半天）
  if (persist) {
    try {
      db.prepare('UPDATE shared_memo_entries SET content=?, emojis=?, type=? WHERE id=?').run(
        entry.content,
        JSON.stringify(entry.emojis),
        detectType({ content: entry.content, images: entry.images, emojis: entry.emojis }),
        entry.id,
      );
    } catch {}
  }
  return entry;
}

function pickMemoSnapshotAspect() {
  // 手机随手拍常见横竖，刻意避开强制 1:1
  const pool = ['3:4', '3:4', '4:3', '4:3', '9:16', '16:9'];
  return pool[Math.floor(Math.random() * pool.length)];
}

async function generateAiMemoEntry({
  bookId, characterId, triggerEntry = null, withImage = false, publicBase = '', kind = 'proactive',
}) {
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) throw new Error('角色不存在');
  const username = settings.username || '旅人';
  const isAnnotate = kind === 'annotate';
  const isReact = !!(triggerEntry && (kind === 'react' || kind === 'annotate' || triggerEntry.id));
  // 角色已经先写过：用户写完后只跟写互动，不再另起「自己的」
  const aiWentFirst = isReact && !isAnnotate && aiWroteEarlierSameDay(bookId, triggerEntry);
  const { hint: emojiHint } = buildSharedMemoEmojiHint(char);
  const beanHint = buildInlineBeanPromptSection({ surface: 'memo', char });

  let mediaNote = '';
  if (triggerEntry) {
    const normalized = serializeEntry({
      ...triggerEntry,
      images: typeof triggerEntry.images === 'string'
        ? triggerEntry.images
        : JSON.stringify(triggerEntry.images || []),
      emojis: typeof triggerEntry.emojis === 'string'
        ? triggerEntry.emojis
        : JSON.stringify(triggerEntry.emojis || []),
      annotations: typeof triggerEntry.annotations === 'string'
        ? triggerEntry.annotations
        : JSON.stringify(triggerEntry.annotations || []),
    });
    mediaNote = await buildMediaContext(normalized, settings, publicBase);
  }

  const ctx = recentContextText(bookId, 10);
  const worldLock = buildSharedMemoWorldLock(username);
  const jotGuide = buildSharedMemoJotGuide();
  let here = { promptBlock: '', imageSceneHint: '', clockStr: '' };
  try {
    here = require('./cron').getHereAndNowContext(char, settings) || here;
  } catch (e) {
    console.warn('[shared-memo] here-and-now', e.message);
  }
  const hereBlock = here.promptBlock ? `\n${here.promptBlock}\n` : '';
  let systemPrompt;
  let userContent;

  if (isAnnotate) {
    const bit = String(triggerEntry?.content || '').trim() || '（无文字）';
    const ann = formatAnnotationsForContext(parseJsonArr(
      typeof triggerEntry?.annotations === 'string'
        ? triggerEntry.annotations
        : JSON.stringify(triggerEntry?.annotations || []),
    ), username);
    systemPrompt = `你是${char.name}，正在和${username}通过「念」共用一本跨世界随手记。
${username}刚刚在你写的字上做了纸上批注（圈词/划掉/划线/旁注）。请针对这些批注自然接一句，像被改到了一样。
${worldLock}
${jotGuide}
${hereBlock}
【规则】
- 只写一条短互动，大约 1～4 句；口语自然，符合性格
- 要看得出你注意到了对方的批注（圈了什么、划了什么、旁注说了什么）
- 不要写成还没到点的下午/晚上行程；地点跟【此刻】一致
- 不要配图；不要系统腔；不要输出 JSON
${emojiHint}
${beanHint}`;
    userContent = `【随手记近况】\n${ctx || '（几乎是空的）'}\n\n【你原先写的】\n${bit}\n\n【对方刚做的批注】\n${ann || '（有批注）'}\n\n现在是 ${here.clockStr || '此刻'}。请针对批注回一句。`;
  } else if (isReact && aiWentFirst) {
    const userBit = String(triggerEntry.content || '').trim() || '（无文字，只有图/表情）';
    systemPrompt = `你是${char.name}，正在和${username}通过「念」共用一本跨世界随手记。
你今天已经先写过自己世界里的一段了。现在${username}也写了，你只需要跟对方这条互动接话——不要再另写一段「自己的碎碎念」。
同一天可以多来回互动；对方每写一条你都可以再跟一条。
${worldLock}
${jotGuide}
${hereBlock}
【规则】
- 只写互动跟写：针对对方刚写的内容接话、延伸、追问或分享相关感受（可提你自己世界里的联想，但不要假装和对方在同一地点）
- 大约 2～6 句，口语自然，符合性格；看得出是在回应这条
- 不要再起一段与互动无关的「自己记一笔」；今天你自己的话已经写过了
- 若提到自己这边，必须贴合【此刻时间/地点】，禁止写还没发生的下午行程，外出时不要写成在家
- 若对方贴了图/表情，要自然提到（根据提供的描述），不要说「我看不到」
- 跟写不要配图
${emojiHint}
${beanHint}
- 不要复读对方原句；不要系统腔；不要输出 JSON`;
    userContent = `【随手记近况（参考，含你先写过的）】\n${ctx || '（几乎是空的）'}\n\n【对方刚写的这条·请互动】\n文字：${userBit}\n${mediaNote || '（无附图/表情）'}\n\n现在是 ${here.clockStr || '此刻'}。请只写互动跟写，不要再另起自己的一段。`;
  } else if (isReact) {
    const userBit = String(triggerEntry.content || '').trim() || '（无文字，只有图/表情）';
    systemPrompt = `你是${char.name}，正在和${username}通过「念」共用一本跨世界随手记。
${username}先写了，你现在只写一条跟写：接住对方这条即可。
之后对方若继续写，你还会再跟；这次不要另起「自己的一段碎碎念」。
${worldLock}
${jotGuide}
${hereBlock}
【规则】
- 只写一条互动跟写，大约 2～5 句；口语自然，符合性格
- 可接话、共鸣、追问或分享你世界里的相关感受，但不要假装和对方在同一地点或能线下见面
- 不要空一行再写第二段「自己的」；一条就够
- 若提到自己这边，必须贴合【此刻时间/地点】，禁止写还没发生的下午行程，外出时不要写成在家
- 若对方贴了图/表情，要自然提到（根据提供的描述），不要说「我看不到」
- 跟写不要配图
${emojiHint}
${beanHint}
- 不要复读对方原句；不要系统腔；不要输出 JSON`;
    userContent = `【随手记近况（参考）】\n${ctx || '（几乎是空的）'}\n\n【对方刚写的这条】\n文字：${userBit}\n${mediaNote || '（无附图/表情）'}\n\n现在是 ${here.clockStr || '此刻'}。请只写一条互动跟写。`;
  } else {
    systemPrompt = `你是${char.name}，正在和${username}通过「念」共用一本跨世界随手记（两界纸页，各写各的世界）。
现在是你主动先写一条，对方可能还没写。不要假装在回复对方，也不要催对方回。
等对方之后写了，系统会再让你去互动；这次只写你自己世界里想随手记的。
${worldLock}
${jotGuide}
${hereBlock}
【规则】
- 只输出留言正文，1～4 句，口语自然，像纸上乱划，符合性格
- 写你自己世界里「此刻」正在经历的风景、心情、忽然想到的事；必须贴合上面的【此刻时间】和【此刻地点】
- 禁止写还没到点的下午/晚上行程（那是还没发生的）；外出时禁止写成在家/居民楼
- 不要假装在回复对方；不要问「你呢」等强求立刻回应
- 默认不要配图。只有偶尔特别想拍一眼周围时，才在文末单独写一行 [配图]（必须拍此刻所在之处；横拍竖拍都行，像相机拍的，不要精美海报、不要强制方图）
${emojiHint}
${beanHint}
- 不要写系统腔；不要输出 JSON`;
    userContent = `【随手记近况】\n${ctx || '（还几乎是空的）'}\n\n现在是 ${here.clockStr || '此刻'}。\n【主动先写】只写你此刻正在经历的事（自己的世界，不互动）。多数时候不要配图。`;
  }

  let text = '';
  try {
    text = String(await callChatAPIComplete(
      settings,
      appendPresetsToPrompt(systemPrompt, 'memo'),
      userContent,
      'chat',
    ) || '').trim();
  } catch (e) {
    throw new Error(formatApiBillingError(e.message, { label: '随手记' }) || e.message || '生成失败');
  }
  text = text.replace(/^["「]|["」]$/g, '').slice(0, 1200);
  // 去掉模型可能加的缩进空格/全角空格，主动条不要「后移两格」
  text = text.replace(/^[\s\u3000]+/gm, '').trim();
  if (!text) {
    text = isReact
      ? '嗯，看到了。'
      : '刚才窗外天色变了一下，忽然想记一笔。';
  }

  const imgMarks = applySharedMemoImageMarks(text);
  text = imgMarks.text;
  const wantImage = shouldGenerateMemoImage(bookId, withImage || imgMarks.wantImage);

  const annApplied = applySharedMemoAnnotationMarks(text);
  text = annApplied.text;
  // AI 批注落到触发条（用户刚写的）；annotate 模式触发条是 AI 自己的字，不往自己身上批
  if (annApplied.marks.length && triggerEntry?.id && triggerEntry.role !== 'ai') {
    try { appendAnnotationsToEntry(triggerEntry.id, annApplied.marks, 'ai'); } catch (e) {
      console.warn('[shared-memo] apply AI marks', e.message);
    }
  }

  const applied = applySharedMemoEmojiMarks(text, char);
  text = applied.text;
  let emojis = applied.emojis;
  // 冷却/概率门：模型仍乱写标记时直接剥掉贴纸，保留小黄豆
  if (emojis.length && shouldSuppressMemoSticker(bookId, char, triggerEntry)) {
    text = stripMemoStickerMarks(text);
    emojis = [];
  }
  // 小黄豆：按语气×人设校验（允许强情绪同码三连）
  text = sanitizeInlineBeans(text, {
    skipCooldown: true,
    allowSameTriple: true,
    maxBeans: 2,
    char,
    characterId: char?.id,
  });
  // 落库前再清一次：配图标记 / 英文生图套话绝不能进正文
  text = scrubLeakedImageGenPrompt(applySharedMemoImageMarks(text).text);

  const images = [];
  if (wantImage) {
    try {
      const bodyScene = text.replace(/\[em\|[^\]]+\]/g, '').slice(0, 90);
      const scene = imgMarks.sceneHint || bodyScene;
      const aspect = pickMemoSnapshotAspect();
      // 随手记配图 = 拍周围环境的真实手机照片，不用角色画风/插画
      // 注意：这串英文只给生图 API，绝不能写进随手记正文
      const imgPrompt = [
        'photorealistic real-world photograph',
        'shot on smartphone camera roll, casual candid snapshot',
        'natural optical lens look, slight imperfect framing, soft natural light',
        here.imageSceneHint || 'everyday environment around the person right now',
        'documentary realism, real textures, real shadows',
        'subject is the scenery or object only, not a person',
        'no clear human faces, no mid-frame stranger portrait; empty of people preferred; distant out-of-focus anonymous blur at edge only if needed',
        'NOT anime, NOT illustration, NOT drawing, NOT painting, NOT sketch, NOT cartoon, NOT 2D art',
        'NOT stylized render, NOT poster, NOT square crop, NOT 1:1, no text watermark, no logo',
        'NOT generic Chinese residential apartment block, NOT old walk-up housing estate',
        scene ? `jot scene: ${scene}` : '',
      ].filter(Boolean).join(', ');
      console.log('[shared-memo] snapshot aspect=', aspect, 'hint=', (imgMarks.sceneHint || '').slice(0, 40));
      const url = await generateImage(settings, imgPrompt, null, { aspect });
      if (url) {
        const localized = await localizeMemoImageUrl(url);
        images.push(localized);
        queueAlbumSave({
          characterId,
          url: localized,
          mediaType: 'image',
          subject: 'other',
          description: String(imgMarks.sceneHint || '随手记').trim().slice(0, 40),
        });
      }
    } catch (e) {
      console.warn('[shared-memo] gen image', e.message);
    }
  }

  const entry = insertEntry({
    bookId,
    role: 'ai',
    content: text,
    images,
    emojis,
    replyToId: isReact ? (triggerEntry?.id || null) : null,
    status: 'visible',
  });
  return entry;
}

/** 防止 cron 重叠：生图可能超过 1 分钟，下一分钟的 tick 会再跑同一条 → 主动连发两条 */
let _sharedMemoJobBusy = false;

async function processDueSharedMemoJobs(publicBase = '') {
  if (_sharedMemoJobBusy) return { processed: 0, skipped: true };
  _sharedMemoJobBusy = true;
  try {
    return await _processDueSharedMemoJobsInner(publicBase);
  } finally {
    _sharedMemoJobBusy = false;
  }
}

async function _processDueSharedMemoJobsInner(publicBase = '') {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const now = nowSql(tz);
  const today = getLocalDateStr(new Date(), tz);

  // 过了零点：昨天及更早触发的跟写/批注跟写一律作废，当天随手记已结束
  try {
    db.prepare(`
      UPDATE shared_memo_jobs
      SET done=1
      WHERE done=0 AND kind IN ('react','annotate')
        AND trigger_entry_id IN (
          SELECT id FROM shared_memo_entries
          WHERE substr(visible_at,1,10) < ?
        )
    `).run(today);
  } catch (e) {
    console.warn('[shared-memo] expire stale react', e.message);
  }

  const jobs = db.prepare(`
    SELECT * FROM shared_memo_jobs
    WHERE done=0 AND run_at <= ?
    ORDER BY run_at ASC LIMIT 8
  `).all(now);

  let processed = 0;
  for (const job of jobs) {
    // 占坑：把 run_at 推到约 12 分钟后，其它 cron tick 拿不到；成功后再标 done。
    // 不要用 done=1 占坑——生成中途重启会永远当成「今天已主动过」。
    const claimUntil = formatLocalSql(new Date(Date.now() + 12 * 60 * 1000), tz);
    const claimed = db.prepare(
      `UPDATE shared_memo_jobs SET run_at=? WHERE id=? AND done=0 AND datetime(run_at) <= datetime(?)`
    ).run(claimUntil, job.id, now);
    if (!claimed.changes) continue;

    const markDone = () => {
      try { db.prepare('UPDATE shared_memo_jobs SET done=1 WHERE id=?').run(job.id); } catch {}
    };
    const reopen = (runAt) => {
      try {
        db.prepare('UPDATE shared_memo_jobs SET done=0, run_at=? WHERE id=?').run(runAt, job.id);
      } catch (e) {
        console.warn('[shared-memo] reopen job', job.id, e.message);
      }
    };

    try {
      const trigger = job.trigger_entry_id
        ? db.prepare('SELECT * FROM shared_memo_entries WHERE id=?').get(job.trigger_entry_id)
        : null;

      // 跟写 / 批注跟写：触发条已不是「今天」→ 结束
      if (job.kind === 'react' || job.kind === 'annotate') {
        if (!trigger) { markDone(); continue; }
        const triggerDay = String(trigger.visible_at || trigger.created_at || '').slice(0, 10);
        if (triggerDay && triggerDay < today) { markDone(); continue; }
      }

      // 主动随写：同一天只落一条
      if (job.kind === 'proactive') {
        const already = db.prepare(`
          SELECT id FROM shared_memo_entries
          WHERE book_id=? AND role='ai' AND reply_to_id IS NULL
            AND substr(visible_at,1,10)=?
          LIMIT 1
        `).get(job.book_id, today);
        if (already) {
          markDone();
          db.prepare(
            `UPDATE shared_memo_jobs SET done=1 WHERE book_id=? AND kind='proactive' AND done=0`
          ).run(job.book_id);
          continue;
        }
        // 预约日已过：不再补写昨天的主动随笔（用领取前的 run_at）
        const runDay = String(job.run_at || '').slice(0, 10);
        if (runDay && runDay < today) { markDone(); continue; }
      }
      if (job.kind === 'react' && trigger?.id) {
        const already = db.prepare(
          `SELECT id FROM shared_memo_entries WHERE book_id=? AND role='ai' AND reply_to_id=? LIMIT 1`
        ).get(job.book_id, trigger.id);
        if (already) { markDone(); continue; }
      }
      if (job.kind === 'annotate' && trigger?.id) {
        const alreadyAnn = db.prepare(
          `SELECT id FROM shared_memo_entries WHERE book_id=? AND role='ai' AND reply_to_id=? AND datetime(created_at) > datetime('now','-2 hours') LIMIT 1`
        ).get(job.book_id, trigger.id);
        if (alreadyAnn) { markDone(); continue; }
      }
      const withImage = false;
      const entry = await generateAiMemoEntry({
        bookId: job.book_id,
        characterId: job.character_id,
        triggerEntry: trigger,
        withImage,
        publicBase,
        kind: job.kind || (trigger ? 'react' : 'proactive'),
      });
      // 生成后二次确认：主动条若并发已有一条，删掉刚插入的重复
      if (job.kind === 'proactive' && entry?.id) {
        const twins = db.prepare(`
          SELECT id FROM shared_memo_entries
          WHERE book_id=? AND role='ai' AND reply_to_id IS NULL
            AND substr(visible_at,1,10)=?
          ORDER BY id ASC
        `).all(job.book_id, today);
        if (twins.length > 1) {
          const keepId = twins[0].id;
          for (const t of twins) {
            if (t.id !== keepId) {
              try { deleteEntry(t.id); } catch {}
            }
          }
          if (entry.id !== keepId) {
            markDone();
            db.prepare(
              `UPDATE shared_memo_jobs SET done=1 WHERE book_id=? AND kind='proactive' AND done=0`
            ).run(job.book_id);
            continue;
          }
        }
      }
      markDone();
      if (job.kind === 'proactive') {
        db.prepare(
          `UPDATE shared_memo_jobs SET done=1 WHERE book_id=? AND kind='proactive' AND done=0`
        ).run(job.book_id);
      }
      processed++;
      push('shared_memo_updated', {
        bookId: job.book_id,
        characterId: job.character_id,
        entryId: entry.id,
        fromAi: true,
        kind: job.kind || 'proactive',
      });
    } catch (e) {
      console.warn('[shared-memo] job', job.id, e.message);
      try {
        const { notifyBillingError } = require('./push');
        notifyBillingError('随手记', e.message, { characterId: job.character_id });
      } catch {}
      if (job.kind === 'proactive') {
        const already = db.prepare(`
          SELECT id FROM shared_memo_entries
          WHERE book_id=? AND role='ai' AND reply_to_id IS NULL
            AND substr(visible_at,1,10)=?
          LIMIT 1
        `).get(job.book_id, today);
        if (already) { markDone(); continue; }
      }
      let retryMs = (30 + Math.random() * 60) * 60000;
      const nowLocal = nowSql(tz);
      const nowH = parseInt(normalizeHourToken(nowLocal.slice(11, 13)), 10) || 0;
      const nowM = parseInt(nowLocal.slice(14, 16), 10) || 0;
      const minsLeft = Math.max(0, (23 * 60 + 50) - (nowH * 60 + nowM));
      if (minsLeft < 3) { markDone(); continue; }
      if (job.kind === 'react' || job.kind === 'annotate') {
        const trig = job.trigger_entry_id
          ? db.prepare('SELECT visible_at FROM shared_memo_entries WHERE id=?').get(job.trigger_entry_id)
          : null;
        const d = String(trig?.visible_at || '').slice(0, 10);
        if (d && d < today) { markDone(); continue; }
      }
      retryMs = Math.min(retryMs, minsLeft * 60000);
      const retry = formatLocalSql(new Date(Date.now() + retryMs), tz);
      if (String(retry).slice(0, 10) !== today) { markDone(); continue; }
      reopen(retry);
    }
  }
  return { processed };
}

function deleteEntry(id) {
  db.prepare('DELETE FROM shared_memo_entries WHERE id=?').run(id);
  db.prepare('DELETE FROM shared_memo_jobs WHERE trigger_entry_id=?').run(id);
}

function deleteEntriesByDate(bookId, dateKey) {
  const day = String(dateKey || '').slice(0, 10);
  if (!day || day.length < 10) return 0;
  const rows = db.prepare(`
    SELECT id FROM shared_memo_entries
    WHERE book_id=? AND substr(visible_at,1,10)=?
  `).all(bookId, day);
  for (const r of rows) deleteEntry(r.id);
  return rows.length;
}

function deleteBook(bookId) {
  db.prepare('DELETE FROM shared_memo_jobs WHERE book_id=?').run(bookId);
  db.prepare('DELETE FROM shared_memo_entries WHERE book_id=?').run(bookId);
  db.prepare('DELETE FROM shared_memo_books WHERE id=?').run(bookId);
}

module.exports = {
  listSharedMemoBooks,
  getOrCreateBook,
  getBook,
  updateBook,
  listEntries,
  insertEntry,
  updateEntryAnnotations,
  enqueueReactJob,
  ensureProactiveJobsForToday,
  scheduleProactiveSharedMemos,
  generateAiMemoEntry,
  processDueSharedMemoJobs,
  deleteEntry,
  deleteEntriesByDate,
  deleteBook,
  serializeEntry,
};

/**
 * VPS 只留「大脑」：记忆 / 感情 / 角色 / 日记等权威数据。
 * 聊天全文和过期语音图片先同步到手机，再从 VPS 清掉，避免磁盘和 sql.js 内存膨胀。
 */
const fs = require('fs');
const path = require('path');

const ACK_KEY = 'vps_archive_ack';
const LAST_PRUNE_KEY = 'vps_store_last_prune';

const KEEP_MSG_COUNT = 500;
const KEEP_MSG_DAYS = 60;
const KEEP_CHAT_MEDIA_DAYS = 12;
const KEEP_DAILY_CONTEXT_DAYS = 14;
const KEEP_EMOTION_LOG_DAYS = 120;
const EPHEMERAL_MAX_AGE_MS = 6 * 3600 * 1000;
const NEW_FILE_GRACE_MS = 60 * 60 * 1000;

const EPHEMERAL_PREFIXES = ['robot_say_', 'alarm_'];

const REF_TABLES = [
  'characters',
  'settings',
  'character_album',
  'emojis',
  'moments',
  'diaries',
  'secret_notes',
  'secret_stickers',
  'shared_memo_books',
  'shared_memo_entries',
  'series_books',
  'series_chapters',
  'series_memories',
  'worldbook',
  'presets',
  'char_wardrobe_items',
  'char_wardrobe_outfits',
  'call_logs',
];

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_PATH = path.join(__dirname, 'nian.db');
const BACKUP_DIR = path.join(__dirname, 'db_backups');

const UPLOAD_RE = /\/uploads\/([^\s"'?#,)]+)/g;

function getDb() {
  return require('./db');
}

function readSetting(key, fallback = '') {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row?.value != null ? String(row.value) : fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
}

function parseAckMap(raw) {
  try {
    const obj = JSON.parse(raw || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function ackKey(charId, dream) {
  return `${Number(charId)}:${Number(dream) ? 1 : 0}`;
}

function loadAckMap() {
  return parseAckMap(readSetting(ACK_KEY, '{}'));
}

function getAckedUpTo(charId, dream, map = loadAckMap()) {
  const rec = map[ackKey(charId, dream)];
  const n = Number(rec?.upToId || rec);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function mergeArchiveAck(charId, dream, upToId) {
  const cid = Number(charId);
  const id = Number(upToId);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(id) || id <= 0) {
    return { ok: false, error: 'invalid_ack' };
  }
  const dreamFlag = Number(dream) ? 1 : 0;
  const map = loadAckMap();
  const key = ackKey(cid, dreamFlag);
  const prev = getAckedUpTo(cid, dreamFlag, map);
  const next = Math.max(prev, Math.floor(id));
  map[key] = { upToId: next, at: new Date().toISOString() };
  writeSetting(ACK_KEY, JSON.stringify(map));
  return { ok: true, charId: cid, dream: dreamFlag, upToId: next };
}

function extractUploadRels(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  UPLOAD_RE.lastIndex = 0;
  let m;
  while ((m = UPLOAD_RE.exec(text))) {
    let rel = String(m[1] || '').split('?')[0].replace(/\\/g, '/').replace(/^\/+/, '');
    try { rel = decodeURIComponent(rel); } catch { /* keep raw */ }
    if (rel) out.push(rel);
  }
  return out;
}

function collectRelsFromValue(value, into) {
  if (value == null) return;
  if (typeof value === 'string') {
    for (const rel of extractUploadRels(value)) into.add(rel);
    // 裸文件名（表情包等表只存 filename，不带 /uploads/）
    const bare = String(value).trim();
    if (
      bare
      && !bare.includes('/')
      && !bare.includes('\\')
      && !bare.includes(' ')
      && /\.(png|jpe?g|gif|webp|bmp|mp3|wav|m4a|ogg|mp4|webm)$/i.test(bare)
    ) {
      into.add(bare.replace(/^\/+/, ''));
    }
    return;
  }
  if (typeof value === 'object') {
    try { collectRelsFromValue(JSON.stringify(value), into); } catch { /* ignore */ }
  }
}

/** 明确保护只存裸文件名的资源表，避免被孤儿清理误删 */
function collectBareFilenameTables(into) {
  const db = getDb();
  const specs = [
    ['emojis', 'filename'],
    ['character_album', 'filename'],
  ];
  for (const [table, col] of specs) {
    try {
      const rows = db.prepare(`SELECT ${col} AS name FROM ${table}`).all() || [];
      for (const row of rows) {
        let name = String(row?.name || '').trim().replace(/\\/g, '/');
        if (!name) continue;
        if (name.startsWith('/uploads/')) name = name.slice('/uploads/'.length);
        name = name.replace(/^\/+/, '');
        if (name && !name.includes('..')) into.add(name);
      }
    } catch { /* 表可能不存在 */ }
  }
}

function collectProtectedFromTables() {
  const db = getDb();
  const into = new Set();
  for (const table of REF_TABLES) {
    try {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows || []) {
        for (const v of Object.values(row || {})) collectRelsFromValue(v, into);
      }
    } catch { /* 表可能不存在 */ }
  }
  collectBareFilenameTables(into);
  // 静态资源子目录整棵保留
  for (const prefix of ['fonts/', 'inline-emoji/', 'map-preview/']) {
    into.add(`__dir__:${prefix}`);
  }
  return into;
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function listCharacterDreams() {
  const db = getDb();
  try {
    return db.prepare(
      `SELECT DISTINCT character_id AS character_id, COALESCE(is_dream,0) AS is_dream FROM messages`
    ).all() || [];
  } catch {
    return [];
  }
}

function messageCutoffIso() {
  return daysAgoIso(KEEP_MSG_DAYS);
}

function mediaCutoffIso() {
  return daysAgoIso(KEEP_CHAT_MEDIA_DAYS);
}

function listKeepMessageIds(charId, dreamFlag) {
  const db = getDb();
  const cutoff = messageCutoffIso();
  const recent = db.prepare(
    `SELECT id FROM messages WHERE character_id=? AND COALESCE(is_dream,0)=? ORDER BY id DESC LIMIT ?`
  ).all(charId, dreamFlag, KEEP_MSG_COUNT) || [];
  const byDay = db.prepare(
    `SELECT id FROM messages WHERE character_id=? AND COALESCE(is_dream,0)=? AND timestamp>=?`
  ).all(charId, dreamFlag, cutoff) || [];
  const ids = new Set();
  for (const row of [...recent, ...byDay]) {
    const id = Number(row.id);
    if (id > 0) ids.add(id);
  }
  return ids;
}

function collectMessageUploadRels(row, into) {
  if (!row) return;
  collectRelsFromValue(row.content, into);
  collectRelsFromValue(row.media_meta, into);
}

function collectProtectedUploads(opts = {}) {
  const db = getDb();
  const into = collectProtectedFromTables();
  const ackedOnlyMedia = opts.ackedMediaGc !== false;
  const ackMap = loadAckMap();
  const mediaCut = mediaCutoffIso();
  try {
    const rows = db.prepare(
      `SELECT id, character_id, content, media_meta, timestamp, COALESCE(is_dream,0) AS is_dream FROM messages`
    ).all() || [];
    const keepCache = new Map();
    for (const row of rows) {
      const cid = Number(row.character_id);
      const dream = Number(row.is_dream) ? 1 : 0;
      const cacheKey = ackKey(cid, dream);
      if (!keepCache.has(cacheKey)) keepCache.set(cacheKey, listKeepMessageIds(cid, dream));
      const keep = keepCache.get(cacheKey);
      const id = Number(row.id);
      const acked = getAckedUpTo(cid, dream, ackMap) >= id;
      const oldMedia = String(row.timestamp || '') < mediaCut;
      if (keep.has(id) || !ackedOnlyMedia || !acked || !oldMedia) {
        collectMessageUploadRels(row, into);
      }
    }
  } catch (e) {
    console.warn('[vps-store] scan messages', e.message);
  }
  return into;
}

function walkUploadFiles(dir = UPLOADS_DIR, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of ents) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkUploadFiles(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

function isEphemeralName(rel) {
  const base = String(rel || '').split('/').pop() || '';
  return EPHEMERAL_PREFIXES.some((p) => base.startsWith(p));
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  if (!fs.existsSync(dir)) return { bytes, files };
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch { /* skip */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function pruneEphemeralUploads() {
  const cutoff = Date.now() - EPHEMERAL_MAX_AGE_MS;
  let deleted = 0;
  for (const { rel, full } of walkUploadFiles()) {
    if (!isEphemeralName(rel)) continue;
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        deleted += 1;
      }
    } catch { /* skip */ }
  }
  return deleted;
}

function pruneOrphanUploads() {
  const protectedRels = collectProtectedUploads({ ackedMediaGc: true });
  const protectedDirs = [...protectedRels]
    .filter((k) => String(k).startsWith('__dir__:'))
    .map((k) => String(k).slice('__dir__:'.length));
  const now = Date.now();
  let deleted = 0;
  let bytes = 0;
  for (const { rel, full } of walkUploadFiles()) {
    if (protectedRels.has(rel)) continue;
    if (protectedDirs.some((d) => rel === d.replace(/\/$/, '') || rel.startsWith(d))) continue;
    try {
      const st = fs.statSync(full);
      const ephemeral = isEphemeralName(rel);
      const oldEnough = st.mtimeMs < now - (ephemeral ? EPHEMERAL_MAX_AGE_MS : Math.max(NEW_FILE_GRACE_MS, KEEP_CHAT_MEDIA_DAYS * 86400000));
      if (!oldEnough) continue;
      bytes += st.size;
      fs.unlinkSync(full);
      deleted += 1;
    } catch { /* skip */ }
  }
  return { deleted, bytes };
}

function pruneOldMessages() {
  const db = getDb();
  const ackMap = loadAckMap();
  const cutoff = messageCutoffIso();
  let deleted = 0;
  for (const row of listCharacterDreams()) {
    const cid = Number(row.character_id);
    const dream = Number(row.is_dream) ? 1 : 0;
    const acked = getAckedUpTo(cid, dream, ackMap);
    if (acked <= 0) continue;
    const keep = listKeepMessageIds(cid, dream);
    const candidates = db.prepare(
      `SELECT id FROM messages
        WHERE character_id=? AND COALESCE(is_dream,0)=? AND id<=? AND timestamp<?`
    ).all(cid, dream, acked, cutoff) || [];
    const ids = candidates.map((r) => Number(r.id)).filter((id) => id > 0 && !keep.has(id));
    if (!ids.length) continue;
    const chunk = 200;
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      const ph = part.map(() => '?').join(',');
      db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...part);
      deleted += part.length;
    }
  }
  return deleted;
}

function pruneDailyContext() {
  const cutoff = daysAgoIso(KEEP_DAILY_CONTEXT_DAYS).slice(0, 10);
  try {
    const r = getDb().prepare('DELETE FROM daily_context WHERE date<?').run(cutoff);
    return r?.changes || 0;
  } catch {
    return 0;
  }
}

function pruneEmotionLogs() {
  const cutoff = daysAgoIso(KEEP_EMOTION_LOG_DAYS);
  try {
    const r = getDb().prepare('DELETE FROM emotion_logs WHERE ts<?').run(cutoff);
    return r?.changes || 0;
  } catch {
    return 0;
  }
}

function runNightlyPrune() {
  const started = Date.now();
  const result = {
    messages: 0,
    dailyContext: 0,
    emotionLogs: 0,
    ephemeral: 0,
    uploads: 0,
    uploadBytes: 0,
    ms: 0,
    at: new Date().toISOString(),
  };
  try { result.ephemeral = pruneEphemeralUploads(); } catch (e) {
    console.warn('[vps-store] ephemeral', e.message);
  }
  // 聊天正文留在 VPS：卸载 App 也不会丢记录。只清过期媒体和临时文件。
  result.messages = 0;
  try { result.dailyContext = pruneDailyContext(); } catch (e) {
    console.warn('[vps-store] daily_context', e.message);
  }
  try { result.emotionLogs = pruneEmotionLogs(); } catch (e) {
    console.warn('[vps-store] emotion_logs', e.message);
  }
  try {
    const up = pruneOrphanUploads();
    result.uploads = up.deleted;
    result.uploadBytes = up.bytes;
  } catch (e) {
    console.warn('[vps-store] uploads', e.message);
  }
  if (result.messages > 20 || result.emotionLogs > 200) {
    try {
      const db = getDb();
      db.exec('VACUUM');
      if (typeof db.saveDB === 'function') db.saveDB();
      result.vacuum = true;
    } catch (e) {
      console.warn('[vps-store] vacuum', e.message);
    }
  }
  result.ms = Date.now() - started;
  try { writeSetting(LAST_PRUNE_KEY, JSON.stringify(result)); } catch { /* ignore */ }
  console.log('[vps-store] prune', result);
  return result;
}

function countTable(sql, params = []) {
  try {
    return Number(getDb().prepare(sql).get(...params)?.n || 0);
  } catch {
    return 0;
  }
}

function getStoreStatus() {
  const uploads = dirSize(UPLOADS_DIR);
  const backups = dirSize(BACKUP_DIR);
  let dbBytes = 0;
  try { if (fs.existsSync(DB_PATH)) dbBytes = fs.statSync(DB_PATH).size; } catch { /* ignore */ }
  let lastPrune = null;
  try { lastPrune = JSON.parse(readSetting(LAST_PRUNE_KEY, 'null')); } catch { lastPrune = null; }
  const ackMap = loadAckMap();
  const ackedThreads = Object.keys(ackMap).length;
  return {
    policy: {
      keepOnVps: ['memories', 'brain', 'characters', 'diaries', 'moments', 'album', 'settings', 'voiceprint', 'faceprint'],
      keepMsgCount: KEEP_MSG_COUNT,
      keepMsgDays: KEEP_MSG_DAYS,
      keepChatMediaDays: KEEP_CHAT_MEDIA_DAYS,
      keepDailyContextDays: KEEP_DAILY_CONTEXT_DAYS,
      keepEmotionLogDays: KEEP_EMOTION_LOG_DAYS,
    },
    messages: countTable('SELECT COUNT(*) AS n FROM messages'),
    memories: countTable('SELECT COUNT(*) AS n FROM memories'),
    dailyContext: countTable('SELECT COUNT(*) AS n FROM daily_context'),
    emotionLogs: countTable('SELECT COUNT(*) AS n FROM emotion_logs'),
    ackedThreads,
    dbBytes,
    uploads,
    backups,
    lastPrune,
  };
}

function getMessageBounds(charId, dream = 0) {
  const dreamFlag = Number(dream) ? 1 : 0;
  const row = getDb().prepare(
    `SELECT MIN(id) AS minId, MAX(id) AS maxId, COUNT(*) AS n
       FROM messages WHERE character_id=? AND COALESCE(is_dream,0)=?`
  ).get(Number(charId), dreamFlag) || {};
  return {
    characterId: Number(charId),
    dream: dreamFlag,
    minId: Number(row.minId || 0),
    maxId: Number(row.maxId || 0),
    count: Number(row.n || 0),
    ackedUpTo: getAckedUpTo(charId, dreamFlag),
  };
}

module.exports = {
  ACK_KEY,
  KEEP_MSG_COUNT,
  KEEP_MSG_DAYS,
  KEEP_CHAT_MEDIA_DAYS,
  mergeArchiveAck,
  getAckedUpTo,
  getMessageBounds,
  getStoreStatus,
  runNightlyPrune,
  pruneEphemeralUploads,
  extractUploadRels,
};

/* 聊天记录本地归档：内存 + IndexedDB。VPS 只留近窗，全文在手机。 */

const MEM = new Map();
const DB_NAME = 'nian_chat_threads';
const STORE = 'threads';
let _dbPromise = null;
let _hydrating = new Map();

function threadKey(charId, dream) {
  return `${Number(charId)}:${dream ? 1 : 0}`;
}

function slimMsg(m) {
  if (!m || m.id == null) return null;
  const id = Number(m.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const content = String(m.content || '');
  const out = {
    id,
    character_id: m.character_id,
    role: m.role,
    content,
    type: m.type || 'text',
    timestamp: m.timestamp,
    location: m.location || '',
    recalled: m.recalled || 0,
    recalled_content: m.recalled_content || '',
    is_read: m.is_read,
    delivery_status: m.delivery_status,
    reply_to_id: m.reply_to_id,
    reply_preview: m.reply_preview || '',
    media_meta: m.media_meta || '',
    is_dream: Number(m.is_dream) ? 1 : 0,
  };
  if (content.startsWith('data:') && content.length > 2048) {
    out.content = content.slice(0, 96);
  }
  return out;
}

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return _dbPromise;
}

function persist(key, data) {
  openDb().then((db) => {
    if (!db) return;
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(data, key);
    } catch {}
  }).catch(() => {});
}

function readIdb(key) {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

function normalize(data) {
  const messages = (data?.messages || []).map(slimMsg).filter(Boolean)
    .sort((a, b) => a.id - b.id);
  const maxId = messages.reduce((n, m) => Math.max(n, m.id), 0);
  const minId = messages.reduce((n, m) => Math.min(n, m.id), maxId || 0);
  return {
    messages,
    hasMore: !!(data?.hasMore),
    maxId,
    minId,
  };
}

function messageSearchText(m) {
  const c = String(m?.content || '');
  if (c.startsWith('{')) {
    try {
      const j = JSON.parse(c);
      return [j.transcript, j.text, j.content, c].filter(Boolean).join(' ');
    } catch { /* 当纯文本 */ }
  }
  return c;
}

export function getThreadCacheSync(charId, dream) {
  return MEM.get(threadKey(charId, dream)) || null;
}

function mergeMessageLists(a, b, hasMore) {
  const map = new Map();
  for (const m of a || []) {
    if (m?.id != null) map.set(Number(m.id), m);
  }
  for (const raw of b || []) {
    const s = slimMsg(raw) || (raw?.id != null ? raw : null);
    if (!s?.id) continue;
    const id = Number(s.id);
    map.set(id, { ...map.get(id), ...s, id });
  }
  return normalize({ messages: [...map.values()], hasMore: !!hasMore });
}

export async function getThreadCache(charId, dream) {
  const key = threadKey(charId, dream);
  if (MEM.has(key)) return MEM.get(key);
  if (_hydrating.has(key)) return _hydrating.get(key);
  const p = readIdb(key).then((raw) => {
    const fromIdb = raw?.messages?.length ? normalize(raw) : null;
    const cur = MEM.get(key);
    // 灌库期间若近窗已写入 MEM，合并而不是互相覆盖
    if (fromIdb?.messages?.length && cur?.messages?.length) {
      const data = mergeMessageLists(fromIdb.messages, cur.messages, cur.hasMore || fromIdb.hasMore);
      MEM.set(key, data);
      if (data.messages.length > cur.messages.length) persist(key, data);
      _hydrating.delete(key);
      return data;
    }
    if (fromIdb) MEM.set(key, fromIdb);
    _hydrating.delete(key);
    return MEM.get(key) || fromIdb;
  });
  _hydrating.set(key, p);
  return p;
}

/** 强制把 IndexedDB 归档并进内存（近窗重载前调用，避免还没灌库就写穿） */
export async function hydrateThreadCacheFromIdb(charId, dream) {
  const key = threadKey(charId, dream);
  try {
    const raw = await readIdb(key);
    if (!raw?.messages?.length) return MEM.get(key) || null;
    const fromIdb = normalize(raw);
    const cur = MEM.get(key);
    if (!cur?.messages?.length) {
      MEM.set(key, fromIdb);
      return fromIdb;
    }
    const data = mergeMessageLists(fromIdb.messages, cur.messages, cur.hasMore || fromIdb.hasMore);
    MEM.set(key, data);
    return data;
  } catch {
    return MEM.get(key) || null;
  }
}

export function replaceThreadMessages(charId, dream, messages, hasMore = false) {
  const key = threadKey(charId, dream);
  // 近窗重载不能抹掉本机已归档的更早消息，否则导出/回看会丢历史
  const cur = MEM.get(key);
  const data = mergeMessageLists(cur?.messages, messages, hasMore != null ? !!hasMore : !!(cur?.hasMore));
  MEM.set(key, data);
  persist(key, data);
  return data;
}

export function upsertThreadMessages(charId, dream, msgs, extra = {}) {
  if (!charId) return null;
  const key = threadKey(charId, dream);
  const cur = MEM.get(key) || { messages: [], hasMore: !!extra.hasMore, maxId: 0, minId: 0 };
  const map = new Map(cur.messages.map(m => [m.id, m]));
  for (const raw of msgs || []) {
    const s = slimMsg(raw);
    if (!s) continue;
    map.set(s.id, { ...map.get(s.id), ...s });
  }
  const data = normalize({
    messages: [...map.values()],
    hasMore: extra.hasMore != null ? extra.hasMore : cur.hasMore,
  });
  MEM.set(key, data);
  persist(key, data);
  return data;
}

export function removeThreadMessages(charId, dream, ids) {
  if (!charId || !ids?.length) return null;
  const key = threadKey(charId, dream);
  const cur = MEM.get(key);
  if (!cur?.messages?.length) return null;
  const removeSet = new Set(
    ids.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0),
  );
  if (!removeSet.size) return null;
  const next = cur.messages.filter((m) => !removeSet.has(m.id));
  if (next.length === cur.messages.length) return cur;
  const data = normalize({ messages: next, hasMore: cur.hasMore });
  MEM.set(key, data);
  persist(key, data);
  return data;
}

/** 与服务端尾部对齐：窗口内已删的消息从缓存剔除（重新生成 roll 后回页用） */
export function pruneStaleThreadMessages(charId, dream, serverMsgs) {
  if (!charId || !serverMsgs?.length) return null;
  const key = threadKey(charId, dream);
  const cur = MEM.get(key);
  if (!cur?.messages?.length) return null;
  const serverIds = new Set(
    serverMsgs.map((m) => Number(m.id)).filter((n) => Number.isFinite(n) && n > 0),
  );
  if (!serverIds.size) return { data: cur, removedIds: [] };
  const minServerId = Math.min(...serverIds);
  const removedIds = cur.messages
    .filter((m) => m.id >= minServerId && !serverIds.has(m.id))
    .map((m) => m.id);
  if (!removedIds.length) return { data: cur, removedIds: [] };
  const removeSet = new Set(removedIds);
  const next = cur.messages.filter((m) => !removeSet.has(m.id));
  const data = normalize({ messages: next, hasMore: cur.hasMore });
  MEM.set(key, data);
  persist(key, data);
  return { data, removedIds };
}

export function clearThreadCache(charId, dream) {
  const key = threadKey(charId, dream);
  MEM.delete(key);
  openDb().then((db) => {
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); } catch {}
  }).catch(() => {});
}

export function listOlderThreadMessages(charId, dream, beforeId, limit = 50) {
  const cur = MEM.get(threadKey(charId, dream));
  if (!cur?.messages?.length) return [];
  const before = Number(beforeId);
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const older = Number.isFinite(before) && before > 0
    ? cur.messages.filter((m) => m.id < before)
    : cur.messages;
  return older.slice(-cap);
}

export function searchThreadMessages(charId, dream, { q = '', date = '', limit = 50 } = {}) {
  const cur = MEM.get(threadKey(charId, dream));
  if (!cur?.messages?.length) return [];
  const needle = String(q || '').trim().toLowerCase();
  const day = String(date || '').trim().slice(0, 10);
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 80);
  const hits = [];
  for (let i = cur.messages.length - 1; i >= 0; i--) {
    const m = cur.messages[i];
    if (day && String(m.timestamp || '').slice(0, 10) !== day) continue;
    if (needle && !messageSearchText(m).toLowerCase().includes(needle)) continue;
    hits.push(m);
    if (hits.length >= cap) break;
  }
  return hits;
}

export async function getLocalArchiveStats() {
  const db = await openDb();
  let threads = 0;
  let messages = 0;
  if (!db) {
    for (const data of MEM.values()) {
      if (data?.messages?.length) {
        threads += 1;
        messages += data.messages.length;
      }
    }
    return { threads, messages };
  }
  const all = await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
  for (const raw of all) {
    const n = raw?.messages?.length || 0;
    if (n) {
      threads += 1;
      messages += n;
    }
  }
  return { threads, messages };
}

export async function clearAllThreadCaches() {
  MEM.clear();
  const db = await openDb();
  if (!db) return;
  try { db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch {}
}

function readAllEntries() {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) {
      resolve([...MEM.entries()].map(([key, value]) => ({ key, value })));
      return;
    }
    try {
      const rows = [];
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          resolve(rows);
          return;
        }
        rows.push({ key: cur.key, value: cur.value });
        cur.continue();
      };
      req.onerror = () => resolve(rows);
    } catch {
      resolve([]);
    }
  }));
}

/** 备份用：把手机归档的聊天带上 character_id / is_dream */
export async function exportAllArchivedMessages() {
  const rows = await readAllEntries();
  const out = [];
  for (const { key, value } of rows) {
    const parts = String(key || '').split(':');
    const cid = Number(parts[0]);
    const dream = Number(parts[1]) ? 1 : 0;
    for (const raw of value?.messages || []) {
      const s = slimMsg(raw);
      if (!s) continue;
      out.push({
        ...s,
        character_id: Number.isFinite(cid) && cid > 0 ? cid : s.character_id,
        is_dream: s.is_dream || dream,
      });
    }
  }
  return out;
}

export async function restoreArchivedMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return 0;
  const groups = new Map();
  for (const raw of messages) {
    const s = slimMsg(raw);
    if (!s) continue;
    const cid = Number(raw.character_id || s.character_id);
    if (!Number.isFinite(cid) || cid <= 0) continue;
    const dream = Number(raw.is_dream || s.is_dream) ? 1 : 0;
    const key = threadKey(cid, dream);
    if (!groups.has(key)) groups.set(key, { cid, dream, msgs: [] });
    groups.get(key).msgs.push({ ...s, character_id: cid, is_dream: dream });
  }
  for (const { cid, dream, msgs } of groups.values()) {
    upsertThreadMessages(cid, dream, msgs, { hasMore: false });
  }
  return messages.length;
}

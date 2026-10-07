/* 聊天媒体落在手机：VPS 清掉过期语音/图片后，本地还能回放 */

import { resolveMediaUrl } from './server-config.js';

const DB_NAME = 'nian_chat_media';
const STORE = 'blobs';
const MAX_BLOB_BYTES = 25 * 1024 * 1024;

const _blobUrls = new Map();
let _dbPromise = null;
let _installed = false;

function canonMediaKey(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const m = s.match(/\/uploads\/(.+?)(?:\?|#|$)/);
  return m ? `/uploads/${decodeURIComponent(m[1])}` : s;
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

function peekBlobUrl(url) {
  const key = canonMediaKey(url);
  return key ? (_blobUrls.get(key) || '') : '';
}

function rememberBlob(key, blob) {
  if (!key || !blob) return '';
  const prev = _blobUrls.get(key);
  if (prev) {
    try { URL.revokeObjectURL(prev); } catch {}
  }
  const obj = URL.createObjectURL(blob);
  _blobUrls.set(key, obj);
  return obj;
}

export function extractMessageMediaUrls(msg) {
  const found = new Set();
  const add = (u) => {
    const key = canonMediaKey(u);
    if (key.startsWith('/uploads/')) found.add(key);
  };
  const scan = (text) => {
    if (!text) return;
    const s = typeof text === 'string' ? text : '';
    if (!s) return;
    if (s.startsWith('{')) {
      try {
        const j = JSON.parse(s);
        add(j.url);
        add(j.src);
        add(j.image);
        add(j.video);
        add(j.cover);
      } catch { /* 继续正则 */ }
    }
    const re = /\/uploads\/[^\s"'?#,)]+/g;
    let m;
    while ((m = re.exec(s))) add(m[0]);
  };
  scan(msg?.content);
  scan(msg?.media_meta);
  return [...found];
}

export async function getCachedMediaUrl(url) {
  const key = canonMediaKey(url);
  if (!key) return '';
  const hot = peekBlobUrl(key);
  if (hot) return hot;
  const db = await openDb();
  if (!db) return '';
  const blob = await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  if (!blob) return '';
  return rememberBlob(key, blob);
}

export async function cacheRemoteMedia(url) {
  const key = canonMediaKey(url);
  if (!key.startsWith('/uploads/')) return '';
  const existing = await getCachedMediaUrl(key);
  if (existing) return existing;
  const remote = resolveMediaUrl(key) || key;
  if (!remote || remote.startsWith('blob:')) return '';
  try {
    const resp = await fetch(remote);
    if (!resp.ok) return '';
    const blob = await resp.blob();
    if (!blob.size || blob.size > MAX_BLOB_BYTES) return '';
    const db = await openDb();
    if (db) {
      try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, key); } catch {}
    }
    return rememberBlob(key, blob);
  } catch {
    return '';
  }
}

export async function prefetchMessageMedia(msgs, { limit = 12 } = {}) {
  const urls = [];
  for (const msg of msgs || []) {
    for (const u of extractMessageMediaUrls(msg)) {
      if (!urls.includes(u)) urls.push(u);
    }
  }
  const slice = urls.slice(0, Math.max(1, limit));
  for (const u of slice) {
    await cacheRemoteMedia(u);
  }
}

export function installMediaCacheResolver() {
  if (_installed) return;
  _installed = true;
  const orig = typeof window.resolveMediaUrl === 'function'
    ? window.resolveMediaUrl
    : resolveMediaUrl;
  window.resolveMediaUrl = (url) => {
    const local = peekBlobUrl(url);
    if (local) return local;
    return orig(url);
  };
}

export async function clearMediaCache() {
  for (const u of _blobUrls.values()) {
    try { URL.revokeObjectURL(u); } catch {}
  }
  _blobUrls.clear();
  const db = await openDb();
  if (!db) return;
  try { db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch {}
}

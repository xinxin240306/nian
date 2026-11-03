/* 他看过的帖子存在这台手机上。云端只暂存还没拉下来的，拉走就删。 */

import * as api from './api.js';
import { lsGet, lsSet } from './storage.js';
import { isNativeShell } from './server-config.js';

const DB_NAME = 'nian_xhs_browse';
const STORE = 'items';
const KEY = 'list';
const LS_KEY = 'xhs_browse';
const MAX = 400;

let _dbPromise = null;
let _started = false;
let _queue = Promise.resolve();

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

function slim(item) {
  const id = Number(item?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    characterId: item.characterId || null,
    characterName: String(item.characterName || ''),
    kind: String(item.kind || 'see'),
    title: String(item.title || ''),
    author: String(item.author || ''),
    snippet: String(item.snippet || ''),
    query: String(item.query || ''),
    createdAt: Number(item.createdAt) || 0,
  };
}

function readIdb() {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

function writeIdb(items) {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) return resolve(false);
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(items, KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  }));
}

export async function readXhsBrowse() {
  const idb = await readIdb();
  if (Array.isArray(idb)) return idb;
  const local = lsGet(LS_KEY, []);
  return Array.isArray(local) ? local : [];
}

async function writeXhsBrowse(items) {
  lsSet(LS_KEY, items);
  await writeIdb(items);
}

function mergeItems(local, incoming) {
  const map = new Map();
  for (const item of local || []) {
    const row = slim(item);
    if (row) map.set(row.id, row);
  }
  for (const item of incoming || []) {
    const row = slim(item);
    if (row) map.set(row.id, row);
  }
  return [...map.values()]
    .sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id))
    .slice(0, MAX);
}

async function pullAndKeep() {
  const data = await api.getXhsBrowse();
  const incoming = (Array.isArray(data?.items) ? data.items : []).map(slim).filter(Boolean);
  if (!isNativeShell()) return incoming;
  if (!incoming.length) return readXhsBrowse();
  const merged = mergeItems(await readXhsBrowse(), incoming);
  await writeXhsBrowse(merged);
  try { await api.ackXhsBrowse(incoming.map((item) => item.id)); } catch { /* 下次再确认，合并是按 id 覆盖 */ }
  return merged;
}

export function syncXhsBrowse() {
  const run = _queue.then(pullAndKeep, pullAndKeep);
  _queue = run.then(() => {}, () => {});
  return run;
}

export function startXhsBrowseSync() {
  if (_started || !isNativeShell()) return;
  _started = true;
  setTimeout(() => { syncXhsBrowse().catch(() => {}); }, 5000);
  setInterval(() => {
    if (document.visibilityState === 'visible') syncXhsBrowse().catch(() => {});
  }, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncXhsBrowse().catch(() => {});
  });
}

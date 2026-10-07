/* 把 VPS 上还没对齐的聊天拉到手机，对齐后再告诉服务器可以清旧记录 */

import * as api from './api.js';
import { getThreadCache, upsertThreadMessages } from './chat-thread-cache.js';
import { prefetchMessageMedia } from './chat-media-cache.js';

let _queue = Promise.resolve();
let _busy = false;

function enqueue(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.then(() => {}, () => {});
  return run;
}

export async function backfillAndAckThread(charId, dream = false) {
  const cid = Number(charId);
  if (!Number.isFinite(cid) || cid <= 0) return { ok: false };
  const dreamFlag = dream ? 1 : 0;

  let bounds;
  try {
    bounds = await api.getMessageBounds(cid, dreamFlag);
  } catch {
    return { ok: false, error: 'bounds' };
  }

  let cache = await getThreadCache(cid, dream);
  if ((cache?.maxId || 0) < (bounds.maxId || 0)) {
    try {
      const newer = await api.getMessages(cid, {
        dream: dreamFlag,
        sinceId: cache?.maxId || 0,
        limit: 100,
      });
      if (newer?.length) {
        cache = upsertThreadMessages(cid, dream, newer) || cache;
        prefetchMessageMedia(newer, { limit: 8 }).catch(() => {});
      }
    } catch { /* 下次再补 */ }
  }

  let guard = 0;
  while (guard++ < 80) {
    cache = await getThreadCache(cid, dream);
    const minId = cache?.minId || 0;
    if (!bounds.count) break;
    if (minId > 0 && bounds.minId > 0 && minId <= bounds.minId) break;
    const beforeId = minId || ((bounds.maxId || 0) + 1);
    if (!beforeId) break;
    let batch;
    try {
      batch = await api.getMessages(cid, {
        dream: dreamFlag,
        beforeId,
        limit: 100,
      });
    } catch {
      break;
    }
    if (!batch?.length) break;
    cache = upsertThreadMessages(cid, dream, batch, { hasMore: batch.length >= 100 }) || cache;
    prefetchMessageMedia(batch, { limit: 6 }).catch(() => {});
    if (batch.length < 100) break;
  }

  cache = await getThreadCache(cid, dream);
  try { bounds = await api.getMessageBounds(cid, dreamFlag); } catch { /* 用旧 bounds */ }
  const haveAllOnServer = !bounds.count
    || ((cache?.minId || 0) > 0 && cache.minId <= bounds.minId);
  if (haveAllOnServer && cache?.maxId) {
    try {
      await api.ackMessageArchive(cid, dreamFlag, cache.maxId);
    } catch { /* 下次再确认 */ }
  }
  return { ok: true, minId: cache?.minId || 0, maxId: cache?.maxId || 0 };
}

export function scheduleThreadArchive(charId, dream = false) {
  return enqueue(() => backfillAndAckThread(charId, dream));
}

export function startChatArchiveSync(characters) {
  if (_busy) return;
  const list = (characters || []).filter((c) => c?.id);
  if (!list.length) return;
  _busy = true;
  const run = async () => {
    try {
      for (const c of list) {
        await backfillAndAckThread(c.id, false);
        await backfillAndAckThread(c.id, true);
      }
    } finally {
      _busy = false;
    }
  };
  const delay = document.visibilityState === 'visible' ? 4000 : 800;
  setTimeout(() => enqueue(run), delay);
}

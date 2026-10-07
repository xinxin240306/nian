/* ===== 朋友圈未读：新动态红点 + 互动数字角标（微信式） ===== */
import { lsGet, lsSet } from './storage.js';
import * as api from './api.js';

const STORE_KEY = 'moments_unread_v1';
const MAX_ITEMS = 99;

function emptyState() {
  return {
    bootstrapped: false,
    lastSeenMomentId: 0,
    hasNewPost: false,
    items: [],
    seenKeys: [],
  };
}

function loadState() {
  const raw = lsGet(STORE_KEY, null);
  if (!raw || typeof raw !== 'object') return emptyState();
  return {
    ...emptyState(),
    ...raw,
    items: Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [],
    seenKeys: Array.isArray(raw.seenKeys) ? raw.seenKeys.slice(-400) : [],
  };
}

function saveState(state) {
  lsSet(STORE_KEY, {
    bootstrapped: !!state.bootstrapped,
    lastSeenMomentId: Number(state.lastSeenMomentId) || 0,
    hasNewPost: !!state.hasNewPost,
    items: (state.items || []).slice(0, MAX_ITEMS),
    seenKeys: (state.seenKeys || []).slice(-400),
  });
}

let _state = loadState();

function interactKey(item) {
  const type = item?.type === 'like' ? 'like' : 'comment';
  const mid = Number(item?.momentId) || 0;
  const cid = item?.charId != null ? String(item.charId) : (item?.charName || '');
  const extra = type === 'comment'
    ? String(item?.content || item?.time || '')
    : '';
  return `${type}:${mid}:${cid}:${extra}`;
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const k = interactKey(it);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export function isWatchingMomentsFeed() {
  const page = document.getElementById('moments-page');
  return !!(page?.classList.contains('active') && !window._momentsViewCharId);
}

export function getMomentsUnread() {
  return {
    hasNewPost: !!_state.hasNewPost,
    count: (_state.items || []).length,
    items: _state.items || [],
  };
}

export function updateMomentsBadges() {
  const { hasNewPost, count } = getMomentsUnread();
  const showNum = count > 0;
  const showDot = !showNum && hasNewPost;
  const label = count > 99 ? '99+' : String(count);

  document.querySelectorAll('.home-moments-badge, #home-moments-badge, #ct-moments-badge').forEach((el) => {
    if (showNum) {
      el.textContent = label;
      el.style.display = 'flex';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  });
  document.querySelectorAll('.home-moments-dot, #ct-moments-dot').forEach((el) => {
    el.style.display = showDot ? 'block' : 'none';
  });
}
window.updateMomentsBadges = updateMomentsBadges;

export function noteMomentsNewPost() {
  if (isWatchingMomentsFeed()) return;
  _state.hasNewPost = true;
  saveState(_state);
  updateMomentsBadges();
}

export function noteMomentsInteraction(data) {
  if (!data || isWatchingMomentsFeed()) return;
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: data.type === 'like' ? 'like' : 'comment',
    momentId: Number(data.momentId) || 0,
    charName: data.charName || 'TA',
    charAvatar: data.charAvatar || '',
    charId: data.charId != null ? Number(data.charId) : null,
    content: data.content || '',
    time: data.time || new Date().toISOString(),
    isReply: !!data.isReply,
  };
  const key = interactKey(item);
  if (_state.seenKeys.includes(key)) return;
  if (_state.items.some((it) => interactKey(it) === key)) return;
  _state.items = [item, ..._state.items].slice(0, MAX_ITEMS);
  saveState(_state);
  updateMomentsBadges();
}

export function markMomentsFeedSeen(maxId) {
  const n = Number(maxId) || 0;
  if (n > (_state.lastSeenMomentId || 0)) _state.lastSeenMomentId = n;
  _state.hasNewPost = false;
  saveState(_state);
  updateMomentsBadges();
}

export function markMomentsInteractionsSeen() {
  const keys = new Set(_state.seenKeys);
  for (const it of _state.items) keys.add(interactKey(it));
  _state.seenKeys = [...keys].slice(-400);
  _state.items = [];
  saveState(_state);
  updateMomentsBadges();
}

function collectAiInteractions(moment) {
  const out = [];
  const likes = Array.isArray(moment?.likes) ? moment.likes : [];
  const comments = Array.isArray(moment?.comments) ? moment.comments : [];
  const isUserPost = moment.role === 'user' || !moment.character_id;
  for (const l of likes) {
    if (typeof l !== 'object' || l == null) continue;
    const charId = l.charId != null ? Number(l.charId) : null;
    if (!charId && !l.charName) continue;
    out.push({
      type: 'like',
      momentId: moment.id,
      charName: l.charName || 'TA',
      charAvatar: l.charAvatar || '',
      charId,
      content: '',
      time: l.time || moment.created_at || '',
    });
  }
  for (const c of comments) {
    if (c?.role !== 'ai') continue;
    const charId = c.characterId != null ? Number(c.characterId) : (c.charId != null ? Number(c.charId) : null);
    const mentionsUser = isUserPost || !!c.replyToUserName || !!c.isReply;
    if (!mentionsUser) continue;
    out.push({
      type: 'comment',
      momentId: moment.id,
      charName: c.charName || 'TA',
      charAvatar: c.charAvatar || '',
      charId,
      content: c.content || '',
      time: c.time || moment.created_at || '',
      isReply: !!(c.replyToUserName || c.isReply),
    });
  }
  return out;
}

export async function syncMomentsUnread() {
  try {
    const moments = await api.getMoments({ limit: 40 });
    if (!Array.isArray(moments) || !moments.length) {
      if (!_state.bootstrapped) {
        _state.bootstrapped = true;
        saveState(_state);
      }
      updateMomentsBadges();
      return;
    }
    const maxId = moments.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
    const found = [];
    for (const m of moments) found.push(...collectAiInteractions(m));

    if (!_state.bootstrapped) {
      _state.bootstrapped = true;
      _state.lastSeenMomentId = maxId;
      _state.hasNewPost = false;
      _state.items = [];
      _state.seenKeys = found.map(interactKey);
      saveState(_state);
      updateMomentsBadges();
      return;
    }

    if (moments.some((m) => (m.role === 'ai' || m.character_id) && Number(m.id) > (_state.lastSeenMomentId || 0))) {
      if (!isWatchingMomentsFeed()) _state.hasNewPost = true;
    }

    const seen = new Set(_state.seenKeys);
    const existing = new Set(_state.items.map(interactKey));
    const fresh = [];
    for (const it of found) {
      const k = interactKey(it);
      if (seen.has(k) || existing.has(k)) continue;
      existing.add(k);
      fresh.push({
        ...it,
        id: `${it.momentId}_${k}`,
      });
    }
    if (fresh.length) {
      _state.items = [...fresh, ..._state.items].slice(0, MAX_ITEMS);
    }
    saveState(_state);
    updateMomentsBadges();
  } catch (e) {
    console.warn('[moments-unread] sync failed', e);
    updateMomentsBadges();
  }
}

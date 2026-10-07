/* ===== 朋友圈 — 微信风格 ===== */
import * as api from '../api.js';
import { escapeHtml, formatMomentTime } from '../memory.js';
import {
  ensureInlineEmojis,
  formatTextWithInlineEmojis,
  openSystemEmojiOverlay,
} from '../inline-emoji.js';
import { pickCropAndUpload, momentsCoverAspect, applyMediaCrop, setupBgVideo } from '../media-crop.js';
import { getDeviceCoordinates, formatLocationError } from '../app-permissions.js';
import { ICON_MORE } from '../ui-icons.js';
import {
  getMomentsUnread,
  markMomentsFeedSeen,
  markMomentsInteractionsSeen,
  noteMomentsNewPost,
  updateMomentsBadges,
} from '../moments-unread.js';
ensureInlineEmojis().catch(() => {});

let _momentImages = [];
let _momentLocation = '';
let _momentMentions = [];
let _momentCharsCache = null;
let _expandedComments = new Set();
let _openOpsMenuId = null;
let _momentReplyTarget = null;
const _momentsCache = new Map();
const _feedByView = new Map();
let _shellViewKey = null;
let _momentsOpsListenerBound = false;
let _loadMomentsPending = new Map();

function momentsViewKey(charId) {
  return charId ? `c:${charId}` : 'all';
}

function getFeed(viewKey) {
  return _feedByView.get(viewKey) || { items: [], maxId: 0 };
}

function setFeed(viewKey, items) {
  const maxId = items.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
  const next = { items: items.slice(0, 60), maxId };
  _feedByView.set(viewKey, next);
  items.forEach((m) => _momentsCache.set(m.id, { likes: m.likes || [], comments: m.comments || [] }));
  return next;
}

function viewerNameAvatar() {
  const settings = window.getAppSettings?.() || {};
  const viewCharId = window._momentsViewCharId || null;
  if (viewCharId) {
    const nameEl = document.querySelector('.moments-cover-username');
    const img = document.querySelector('.moments-cover-avatar img');
    return {
      username: nameEl?.textContent?.trim() || settings.username || '旅人',
      userAvatar: img?.getAttribute('src') || settings.user_avatar || '',
    };
  }
  return {
    username: settings.username || '旅人',
    userAvatar: settings.user_avatar || '',
  };
}

function parseMomentAtName(raw) {
  return String(raw || '').replace(/[，,。！？!?、；;：:\s]+$/g, '');
}

function buildMomentMentionsFromContent(content, chars, username) {
  const mentions = [];
  const seenChars = new Set();
  let seenUser = false;
  for (const match of String(content || '').matchAll(/@(\S+)/g)) {
    const name = parseMomentAtName(match[1]);
    if (!name) continue;
    if (name === username) {
      if (!seenUser) {
        mentions.push({ name: username, charId: null, type: 'user' });
        seenUser = true;
      }
      continue;
    }
    const char = chars.find(c => c.name === name);
    if (char && !seenChars.has(char.id)) {
      mentions.push({ name: char.name, charId: char.id, type: 'char' });
      seenChars.add(char.id);
    }
  }
  return mentions;
}

function formatMomentText(text) {
  if (!text) return '';
  let html = formatTextWithInlineEmojis(text, { nl2br: false });
  return html.replace(/@(\S+)/g, '<span class="wechat-moment-mention">@$1</span>');
}

function buildLikerLine(likes, username) {
  const names = likes.map(l => {
    if (typeof l === 'string') return l === username ? '我' : escapeHtml(l);
    return escapeHtml(l.charName || '');
  }).filter(Boolean);
  const userLiked = likes.some(l => l === username);
  if (userLiked && !names.includes('我')) names.unshift('我');
  return names.length ? `<div class="wechat-moment-likes">❤️ ${names.join('、')}</div>` : '';
}

window.initMomentsPage = async function() {
  const page = document.getElementById('moments-page');
  const viewCharId = window._momentsCharId ? Number(window._momentsCharId) : null;
  window._momentsCharId = null;
  window._momentsViewCharId = viewCharId || null;
  const viewKey = momentsViewKey(viewCharId);

  const canReuse = _shellViewKey === viewKey && page.querySelector('#moments-list') && page.querySelector('#moments-msgbar-slot');
  if (!_momentsOpsListenerBound) {
    document.addEventListener('click', closeAllOpsMenus);
    _momentsOpsListenerBound = true;
  }
  window.onMomentNotify = handleMomentNotify;
  window.onNewMoment = handleNewMoment;

  if (canReuse) {
    void loadMoments({ silent: true }).then(() => afterMomentsFeedReady());
    return;
  }

  let appSettings = window.getAppSettings?.() || {};
  if (!appSettings.username && !appSettings.user_avatar) {
    try { appSettings = await api.getSettings(); } catch {
      appSettings = window.getAppSettings?.() || {};
    }
  }
  let viewChar = null;
  if (viewCharId) {
    try { viewChar = await api.getCharacter(viewCharId); } catch {}
  }
  const username = viewChar
    ? (viewChar.display_name || viewChar.remark || viewChar.name || '角色')
    : (appSettings.username || '旅人');
  const userAvatar = viewChar
    ? (viewChar.avatar || '')
    : (appSettings.user_avatar || '');
  const coverPhoto = viewChar
    ? (viewChar.moments_cover || '')
    : (appSettings.moments_cover || '');
  const coverSrc = coverPhoto
    ? (window.resolveMediaUrl?.(coverPhoto) || coverPhoto)
    : '';
  const coverIsVideo = !!(coverSrc && /\.(mp4|webm|mov)(\?|$)/i.test(coverSrc));
  let coverCrop = null;
  if (!viewChar && appSettings.moments_cover_crop) {
    try { coverCrop = JSON.parse(appSettings.moments_cover_crop); } catch { coverCrop = null; }
  }
  const avatarSrc = userAvatar
    ? (window.resolveMediaUrl?.(userAvatar) || userAvatar)
    : '';
  const nameColor = appSettings.moments_name_color || 'black';
  const canEditCover = !viewChar;

  page.innerHTML = `
    <div class="moments-topbar" id="moments-topbar">
      <button type="button" class="topbar-back topbar-nav-back moments-topbar-back" onclick="goBack()" title="返回" style="color:#fff;filter:drop-shadow(0 1px 3px rgba(0,0,0,.5))"></button>
      <div style="flex:1;text-align:center;color:#fff;font-size:15px;font-weight:500;filter:drop-shadow(0 1px 3px rgba(0,0,0,.45))">${viewChar ? escapeHtml(username) + '的朋友圈' : ''}</div>
      ${viewChar ? '<div style="width:36px"></div>' : `<div onclick="openComposeMoment()" title="发动态" style="color:#fff;filter:drop-shadow(0 1px 3px rgba(0,0,0,.5));cursor:pointer;display:flex;align-items:center;justify-content:center;width:36px;height:36px">${ICON_MORE}</div>`}
    </div>

    <div class="moments-cover-wrap" id="moments-cover-wrap">
      <div class="moments-cover-bg${canEditCover ? ' moments-cover-bg--editable' : ''}" id="moments-cover-bg"
        ${canEditCover ? 'role="button" tabindex="0"' : ''}>
        ${coverSrc
          ? (coverIsVideo
            ? `<video class="moments-cover-img" id="moments-cover-media" playsinline muted loop></video>`
            : `<img class="moments-cover-img" id="moments-cover-media" src="${escapeHtml(coverSrc)}" alt="">`)
          : ''}
        <div class="moments-cover-gradient"></div>
      </div>
      <div class="moments-cover-user">
        <div class="moments-cover-avatar">
          ${avatarSrc
            ? `<img src="${escapeHtml(avatarSrc)}" alt="" style="width:100%;height:100%;border-radius:8px;object-fit:cover">`
            : `<div style="width:100%;height:100%;border-radius:8px;background:var(--theme-light);display:flex;align-items:center;justify-content:center;font-size:22px">${viewChar ? '👤' : '我'}</div>`}
        </div>
        <span class="moments-cover-username color-${escapeHtml(nameColor)}" id="moments-cover-username">${escapeHtml(username)}</span>
      </div>
    </div>

    <div class="scroll-area moments-scroll-area" id="moments-scroll">
      <div id="moments-msgbar-slot"></div>
      <div class="moments-wechat-feed" id="moments-list"></div>
    </div>

    <div id="moments-msg-overlay" class="overlay fullscreen" style="z-index:210">
      <div class="sheet-full moments-msg-sheet">
        <div class="sheet-full-topbar">
          <div class="topbar-back" onclick="closeMomentsMsgList()">‹</div>
          <div class="sheet-full-title">消息</div>
          <div style="width:36px"></div>
        </div>
        <div class="scroll-area moments-msg-list" id="moments-msg-list"></div>
      </div>
    </div>

    <div id="moment-post-overlay" class="overlay fullscreen" style="z-index:200">
      <div class="sheet-full">
        <div class="sheet-full-topbar">
          <div class="topbar-back" onclick="closeComposeMoment()">✕</div>
          <div class="sheet-full-title">发动态</div>
          <button class="btn btn-primary btn-sm" style="padding:6px 18px;border-radius:20px" onclick="postMoment()">发布</button>
        </div>
        <div class="compose-avatar-row" style="padding:16px">
          <div id="compose-user-avatar" style="width:42px;height:42px;border-radius:50%;background:var(--theme-light);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;overflow:hidden">
            ${appSettings.user_avatar ? `<img src="${escapeHtml(appSettings.user_avatar)}" style="width:100%;height:100%;object-fit:cover">` : '我'}
          </div>
          <textarea class="compose-textarea" id="moment-content-input" placeholder="这一刻的想法…" autofocus></textarea>
        </div>
        <div id="moment-compose-extra" class="moment-compose-extra"></div>
        <div id="moment-images-preview" style="display:flex;gap:6px;flex-wrap:wrap;padding:0 16px 12px"></div>
        <div class="compose-toolbar" style="padding:0 16px 16px;gap:12px">
          <div class="moment-compose-tool" onclick="openMomentBeanEmoji()" title="表情">☺</div>
          <div class="moment-compose-tool" onclick="openMomentMentionPicker()" title="@好友">@</div>
          <div class="moment-compose-tool" onclick="pickMomentLocation()" title="所在位置">📍</div>
          <div class="moment-compose-tool" onclick="document.getElementById('moment-img-input').click()" title="图片">🖼</div>
          <input type="file" id="moment-img-input" accept="image/*" multiple style="display:none" onchange="handleMomentImages(event)">
        </div>
      </div>
    </div>

    <div id="moment-mention-overlay" class="overlay" onclick="this.classList.remove('active')">
      <div class="sheet moment-mention-sheet" onclick="event.stopPropagation()">
        <div class="sheet-handle"></div>
        <div class="sheet-title">选择要 @ 的人</div>
        <div id="moment-mention-list"></div>
      </div>
    </div>
  `;

  _shellViewKey = viewKey;
  window.onMomentNotify = handleMomentNotify;
  window.onNewMoment = handleNewMoment;
  await loadMoments({ silent: !!getFeed(viewKey).items.length });
  afterMomentsFeedReady();
  bindMomentsCoverMedia(coverSrc, coverIsVideo, coverCrop, canEditCover);
};

function bindMomentsCoverMedia(coverSrc, isVideo, crop, canEdit) {
  const bg = document.getElementById('moments-cover-bg');
  const media = document.getElementById('moments-cover-media');
  if (media && coverSrc) {
    if (isVideo) {
      setupBgVideo(media, coverSrc, crop);
    } else {
      applyMediaCrop(media, crop);
    }
  }
  if (!canEdit || !bg) return;
  let openedSheet = false;
  let pressTimer = null;
  bg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.moments-cover-user')) return;
    openedSheet = false;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      openedSheet = true;
      window.openMomentsCoverSheet?.();
    }, 520);
  });
  const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  bg.addEventListener('pointerup', clearPress);
  bg.addEventListener('pointercancel', clearPress);
  bg.addEventListener('pointerleave', clearPress);
  bg.addEventListener('click', (e) => {
    if (e.target.closest('.moments-cover-user')) return;
    if (openedSheet) { openedSheet = false; return; }
    window.pickMomentsCover?.();
  });
}

window.reloadMomentsShell = async function() {
  _shellViewKey = null;
  await window.initMomentsPage?.();
};

window.openMomentsCoverSheet = function() {
  const existing = document.getElementById('moments-cover-sheet');
  if (existing) existing.remove();
  const settings = window.getAppSettings?.() || {};
  const color = settings.moments_name_color || 'black';
  const hasCover = !!settings.moments_cover;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="overlay active" id="moments-cover-sheet" onclick="this.remove()">
      <div class="sheet" onclick="event.stopPropagation()">
        <div class="sheet-handle"></div>
        <div class="sheet-title">朋友圈封面</div>
        <div class="settings-group" style="margin:12px">
          <div class="settings-row settings-row--nav" onclick="pickMomentsCover();document.getElementById('moments-cover-sheet')?.remove()">
            <div class="settings-row-label">更换图片或视频</div>
            <span class="me-cell-chevron">›</span>
          </div>
          ${hasCover ? `<div class="settings-row settings-row--nav" onclick="clearMomentsCover();document.getElementById('moments-cover-sheet')?.remove()">
            <div class="settings-row-label" style="color:#c45c6a">恢复默认封面</div>
          </div>` : ''}
        </div>
        <div class="settings-group" style="margin:12px">
          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
            <div class="settings-row-label">名字颜色</div>
            <div class="tag-list" id="moments-cover-name-color">
              <div class="tag ${color === 'black' ? 'active' : ''}" data-val="black" onclick="setMomentsNameColor('black',this)">黑色</div>
              <div class="tag ${color === 'white' ? 'active' : ''}" data-val="white" onclick="setMomentsNameColor('white',this)">白色</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);
};

function afterMomentsFeedReady() {
  if (window._momentsViewCharId) {
    const slot = document.getElementById('moments-msgbar-slot');
    if (slot) slot.innerHTML = '';
    updateMomentsBadges();
    return;
  }
  const feed = getFeed(momentsViewKey(null));
  const maxId = feed.maxId || feed.items.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
  markMomentsFeedSeen(maxId);
  renderMomentsMsgBar();
}

function renderMomentsMsgBar() {
  const slot = document.getElementById('moments-msgbar-slot');
  if (!slot) return;
  if (window._momentsViewCharId) {
    slot.innerHTML = '';
    return;
  }
  const items = getMomentsUnread().items || [];
  if (!items.length) {
    slot.innerHTML = '';
    return;
  }
  const avatars = [];
  const seen = new Set();
  for (const it of items) {
    const key = it.charId != null ? `id:${it.charId}` : `n:${it.charName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    avatars.push(it);
    if (avatars.length >= 3) break;
  }
  const n = items.length;
  slot.innerHTML = `
    <button type="button" class="wechat-moments-msgbar" onclick="openMomentsMsgList()">
      <span class="wechat-moments-msgbar-avatars">
        ${avatars.map((it) => it.charAvatar
          ? `<img src="${escapeHtml(it.charAvatar)}" alt="">`
          : `<span class="wechat-moments-msgbar-ph">${escapeHtml((it.charName || 'TA').slice(0, 1))}</span>`
        ).join('')}
      </span>
      <span class="wechat-moments-msgbar-text">${n}条新消息</span>
      <span class="wechat-moments-msgbar-chevron">›</span>
    </button>
  `;
}

function momentThumbHtml(moment) {
  const imgs = Array.isArray(moment?.images) ? moment.images : [];
  const first = imgs[0];
  if (!first) {
    const text = String(moment?.content || '').trim();
    return `<div class="moments-msg-thumb moments-msg-thumb--text">${escapeHtml(text.slice(0, 8) || '动态')}</div>`;
  }
  if (isMomentMediaVideo(first)) {
    const src = escapeHtml(window.resolveMediaUrl?.(first) || first);
    return `<video class="moments-msg-thumb" src="${src}" muted playsinline preload="metadata"></video>`;
  }
  const src = escapeHtml(window.resolveMediaUrl?.(first) || first);
  return `<img class="moments-msg-thumb" src="${src}" alt="">`;
}

window.openMomentsMsgList = async function() {
  const overlay = document.getElementById('moments-msg-overlay');
  const list = document.getElementById('moments-msg-list');
  if (!overlay || !list) return;
  const items = [...(getMomentsUnread().items || [])];
  overlay.classList.add('active');
  if (!items.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-text">暂无新消息</div></div>';
    markMomentsInteractionsSeen();
    renderMomentsMsgBar();
    return;
  }
  list.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  const byId = new Map();
  await Promise.all(items.map(async (it) => {
    const id = Number(it.momentId);
    if (!id || byId.has(id)) return;
    const cached = _momentsCache.get(id);
    const feedItem = getFeed(momentsViewKey(null)).items.find((m) => Number(m.id) === id);
    if (feedItem) {
      byId.set(id, feedItem);
      return;
    }
    try {
      const m = await api.getMoment(id);
      if (m) byId.set(id, m);
    } catch {
      if (cached) byId.set(id, { id, ...cached });
    }
  }));
  list.innerHTML = items.map((it) => {
    const m = byId.get(Number(it.momentId));
    const line = it.type === 'like'
      ? '赞了你'
      : (it.isReply ? `回复了你：${it.content || ''}` : (it.content || '评论了你'));
    const avatar = it.charAvatar
      ? `<img class="moments-msg-avatar" src="${escapeHtml(it.charAvatar)}" alt="">`
      : `<div class="moments-msg-avatar">${escapeHtml((it.charName || 'TA').slice(0, 1))}</div>`;
    return `
      <div class="moments-msg-row" onclick="jumpToMomentFromMsg(${Number(it.momentId) || 0})">
        ${avatar}
        <div class="moments-msg-body">
          <div class="moments-msg-name">${escapeHtml(it.charName || 'TA')}</div>
          <div class="moments-msg-line">${escapeHtml(line)}</div>
          <div class="moments-msg-time">${formatMomentTime(it.time)}</div>
        </div>
        ${momentThumbHtml(m)}
      </div>`;
  }).join('');
  markMomentsInteractionsSeen();
  renderMomentsMsgBar();
};

window.closeMomentsMsgList = function() {
  document.getElementById('moments-msg-overlay')?.classList.remove('active');
};

window.jumpToMomentFromMsg = function(momentId) {
  closeMomentsMsgList();
  const post = document.querySelector(`[data-moment-id="${momentId}"]`);
  post?.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

function handleNewMoment(data) {
  const page = document.getElementById('moments-page');
  const active = page?.classList.contains('active');
  if (active && !window._momentsViewCharId) {
    loadMoments({ silent: true }).then(() => afterMomentsFeedReady());
    return;
  }
  if (active && window._momentsViewCharId && Number(data.characterId) === Number(window._momentsViewCharId)) {
    loadMoments({ silent: true });
  }
  noteMomentsNewPost(data);
}

function closeAllOpsMenus() {
  if (_openOpsMenuId) {
    document.getElementById(`ops-menu-${_openOpsMenuId}`)?.classList.remove('open');
    _openOpsMenuId = null;
  }
}

async function loadMoments({ silent = false } = {}) {
  const list = document.getElementById('moments-list');
  if (!list) return;
  const viewCharId = window._momentsViewCharId || null;
  const viewKey = momentsViewKey(viewCharId);
  const { username, userAvatar } = viewerNameAvatar();

  // 并发去重：同一个 viewKey 的相同请求共享 Promise，避免快速来回切换时连续打两次
  const pending = _loadMomentsPending.get(viewKey);
  if (pending) return pending;

  const cached = getFeed(viewKey);
  const task = (async () => {
    if (cached.items.length) {
      if (!list.querySelector('.wechat-moment-post')) {
        paintFeed(cached.items, username, userAvatar, viewCharId);
      }
      await syncMomentsDelta(viewKey, viewCharId, username, userAvatar);
      return;
    }

    if (!silent) {
      list.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
    }
    try {
      const moments = await api.getMoments({ limit: 30, characterId: viewCharId || undefined });
      setFeed(viewKey, moments);
      paintFeed(moments, username, userAvatar, viewCharId);
    } catch {
      if (!list.querySelector('.wechat-moment-post')) {
        list.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
      }
    }
  })();

  _loadMomentsPending.set(viewKey, task);
  try {
    await task;
  } finally {
    _loadMomentsPending.delete(viewKey);
  }
}

function paintFeed(moments, username, userAvatar, viewCharId) {
  const list = document.getElementById('moments-list');
  if (!list) return;
  if (!moments.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">✏️</div><div class="empty-text">${viewCharId ? 'TA 还没有动态' : '还没有动态<br>点右上角发布第一条'}</div></div>`;
    return;
  }
  list.innerHTML = moments.map(m => renderPost(m, username, userAvatar)).join('');
  _expandedComments.forEach(id => {
    const el = document.getElementById(`comments-${id}`);
    if (el) el.style.display = '';
  });
}

function prependMoments(newer, username, userAvatar) {
  if (!newer?.length) return;
  const list = document.getElementById('moments-list');
  if (!list) return;
  list.querySelector('.empty-state')?.remove();
  list.querySelector('.loading')?.remove();
  const html = newer.map(m => renderPost(m, username, userAvatar)).join('');
  list.insertAdjacentHTML('afterbegin', html);
}

function sameInteract(a, b) {
  try { return JSON.stringify(a || []) === JSON.stringify(b || []); } catch { return false; }
}

async function syncMomentsDelta(viewKey, viewCharId, username, userAvatar) {
  const cached = getFeed(viewKey);
  try {
    const delta = await api.getMomentsDelta({
      sinceId: cached.maxId || 0,
      ids: cached.items.map(m => m.id),
      characterId: viewCharId || undefined,
    });
    const newer = Array.isArray(delta?.newer) ? delta.newer : [];
    if (newer.length) {
      const seen = new Set(cached.items.map(m => m.id));
      const fresh = newer.filter(m => !seen.has(m.id));
      if (fresh.length) {
        setFeed(viewKey, [...fresh, ...cached.items]);
        prependMoments(fresh, username, userAvatar);
      }
    }
    for (const u of delta?.interactions || []) {
      const item = getFeed(viewKey).items.find(m => m.id === u.id);
      if (!item) continue;
      if (sameInteract(item.likes, u.likes) && sameInteract(item.comments, u.comments)) continue;
      item.likes = u.likes || [];
      item.comments = u.comments || [];
      _momentsCache.set(u.id, { likes: item.likes, comments: item.comments });
      updatePostInteract(u.id, item.likes, item.comments, username);
    }
  } catch {
    /* 增量失败时保留已显示的缓存，不转圈重拉 */
  }
}

function isMomentMediaVideo(url) {
  const u = String(url || '').toLowerCase();
  return /\.(mp4|webm|mov)(\?|$)/.test(u) || /pexels\.com\/videos\//.test(u) || /video\//.test(u);
}

function renderPost(m, username, userAvatar) {
  const isUser = m.role === 'user' || !m.character_id;
  const name = isUser ? username : (m.char_name || '');
  const avatar = isUser ? userAvatar : (m.char_avatar || '');
  const imgs = Array.isArray(m.images) ? m.images : [];
  const likes = Array.isArray(m.likes) ? m.likes : [];
  const comments = Array.isArray(m.comments) ? m.comments : [];
  const userLiked = likes.some(l => l === username || l?.key === `user_${username}`);

  let imgHtml = '';
  if (imgs.length) {
    const colClass = imgs.length === 1 ? 'cols-1' : imgs.length === 2 ? 'cols-2' : imgs.length === 4 ? 'cols-4' : 'cols-3';
    imgHtml = `<div class="moment-images ${colClass}">${imgs.map(img => {
      if (isMomentMediaVideo(img)) {
        const src = escapeHtml(window.resolveMediaUrl?.(img) || img);
        return `<video class="moment-img moment-video" src="${src}" controls playsinline preload="metadata" style="width:100%;border-radius:6px;background:#000"></video>`;
      }
      const src = escapeHtml(window.resolveMediaUrl?.(img) || img);
      return `<img class="moment-img" src="${src}" alt="" onclick="viewMomentImage('${src}')" loading="lazy">`;
    }).join('')}</div>`;
  }

  const commentsHtml = renderComments(comments, username, m.id, isUser);
  const likerLine = buildLikerLine(likes, username);
  const interactBar = (likerLine || commentsHtml)
    ? `<div class="wechat-moment-interact">${likerLine}${commentsHtml ? `<div class="wechat-moment-comments-inline">${commentsHtml}</div>` : ''}</div>`
    : '';

  const locLabel = String(m.location || '').split(/[|｜]/)[0].trim();
  const locHtml = locLabel
    ? `<span class="wechat-moment-location">${escapeHtml(locLabel)}</span>`
    : '';

  return `
    <div class="wechat-moment-post" data-moment-id="${m.id}" data-is-user="${isUser ? '1' : '0'}">
      <div class="wechat-moment-avatar-col">
        ${avatar
          ? `<img class="wechat-moment-avatar" src="${escapeHtml(avatar)}" alt="">`
          : `<div class="wechat-moment-avatar">${name.slice(0, 1)}</div>`}
      </div>
      <div class="wechat-moment-right">
        <div class="wechat-moment-name">${escapeHtml(name)}</div>
        ${m.content ? `<div class="wechat-moment-text">${formatMomentText(m.content)}</div>` : ''}
        ${imgHtml}
        <div class="wechat-moment-meta-row">
          <span class="wechat-moment-time">${formatMomentTime(m.created_at)}</span>
          ${locHtml}
          <div class="wechat-moment-ops-wrap">
            <div class="wechat-ops-dots" onclick="toggleMomentOpsMenu(${m.id}, event)">••</div>
            <div class="wechat-ops-menu" id="ops-menu-${m.id}">
              <div class="wechat-ops-menu-item ${userLiked ? 'liked' : ''}" onclick="momentOpsLike(${m.id}, event)">👍 赞</div>
              <div class="wechat-ops-menu-item" onclick="momentOpsComment(${m.id}, event)">💬 评论</div>
            </div>
          </div>
        </div>
        ${interactBar}
        <div id="comments-${m.id}" style="${_expandedComments.has(m.id) ? '' : 'display:none'}">
          <div class="wechat-moment-comment-input-row">
            <button type="button" class="btn btn-ghost btn-sm moment-comment-emoji-btn" style="padding:4px 8px;font-size:16px;line-height:1" onclick="openMomentCommentBeanEmoji(${m.id})" title="表情">☺</button>
            <input class="input" id="comment-input-${m.id}" placeholder="评论…"
              style="flex:1;font-size:13px;padding:6px 10px"
              onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitMomentComment(${m.id})}">
            <button class="btn btn-primary btn-sm" style="padding:5px 12px" onclick="submitMomentComment(${m.id})">发送</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function getCommentBody(c) {
  if (c.replyToCharName || c.replyToUserName || c.replyToNpcName) return c.content || '';
  const m = (c.content || '').match(/^回复\s+(.+?)[:：]\s*([\s\S]*)$/);
  return m ? m[2].trim() : (c.content || '');
}

function parseLegacyReply(c) {
  if (c.replyToCharName) return null;
  const m = (c.content || '').match(/^回复\s+(.+?)[:：]\s*([\s\S]*)$/);
  return m ? { target: m[1].trim(), body: m[2].trim() } : null;
}

function renderComments(comments, username, momentId, isUserPost) {
  if (!comments.length) return '';
  return comments.map(c => {
    const isNpc = c.role === 'npc';
    const isAi = c.role === 'ai' || isNpc;
    const name = isAi ? (c.charName || 'TA') : (c.username || username);
    const body = getCommentBody(c);
    const charId = c.characterId || c.charId;
    const replyable = c.role === 'ai' && charId;
    const clickAttr = replyable
      ? ` onclick="replyToMomentComment(${momentId}, this)" data-char-id="${charId}" data-char-name="${escapeHtml(name)}" data-comment-content="${escapeHtml(c.content || '')}"`
      : '';
    const cls = replyable ? ' wechat-comment-replyable' : '';

    let inner;
    const legacy = !isAi ? parseLegacyReply(c) : null;
    if (!isAi && (c.replyToCharName || legacy)) {
      const target = c.replyToCharName || legacy?.target || '';
      const text = c.replyToCharName ? body : (legacy?.body || body);
      inner = `<span class="wechat-comment-name">${escapeHtml(name)}</span><span class="wechat-comment-reply-tag">回复</span><span class="wechat-comment-name">${escapeHtml(target)}</span>：<span class="wechat-comment-content">${formatMomentText(text)}</span>`;
    } else if (isAi && (c.replyToUserName || c.replyToNpcName)) {
      const replyTarget = c.replyToUserName || c.replyToNpcName;
      inner = `<span class="wechat-comment-name">${escapeHtml(name)}</span><span class="wechat-comment-reply-tag">回复</span><span class="wechat-comment-name">${escapeHtml(replyTarget)}</span>：<span class="wechat-comment-content">${formatMomentText(body)}</span>`;
    } else {
      inner = `<span class="wechat-comment-name">${escapeHtml(name)}：</span><span class="wechat-comment-content">${formatMomentText(body)}</span>`;
    }

    return `<div class="wechat-comment-line${cls}"${clickAttr}>${inner}</div>`;
  }).join('');
}

function updatePostInteract(momentId, likes, comments, username) {
  const post = document.querySelector(`[data-moment-id="${momentId}"]`);
  if (!post) return;
  _momentsCache.set(momentId, { likes: likes || [], comments: comments || [] });
  const viewKey = momentsViewKey(window._momentsViewCharId || null);
  const item = getFeed(viewKey).items.find(m => m.id === momentId);
  if (item) {
    item.likes = likes || [];
    item.comments = comments || [];
  }
  let interactEl = post.querySelector('.wechat-moment-interact');
  const likerLine = buildLikerLine(likes, username);
  const isUserPost = post?.dataset?.isUser === '1';
  const commentsHtml = renderComments(comments, username, momentId, isUserPost);
  if (!interactEl && (likerLine || commentsHtml)) {
    interactEl = document.createElement('div');
    interactEl.className = 'wechat-moment-interact';
    post.querySelector('.wechat-moment-meta-row')?.after(interactEl);
  }
  if (interactEl) {
    interactEl.innerHTML = likerLine + (commentsHtml ? `<div class="wechat-moment-comments-inline">${commentsHtml}</div>` : '');
  }
}

window.toggleMomentOpsMenu = function(momentId, e) {
  e.stopPropagation();
  if (_openOpsMenuId && _openOpsMenuId !== momentId) {
    document.getElementById(`ops-menu-${_openOpsMenuId}`)?.classList.remove('open');
  }
  const menu = document.getElementById(`ops-menu-${momentId}`);
  if (!menu) return;
  const opening = !menu.classList.contains('open');
  menu.classList.toggle('open', opening);
  _openOpsMenuId = opening ? momentId : null;
};

window.momentOpsLike = async function(momentId, e) {
  e.stopPropagation();
  closeAllOpsMenus();
  const settings = window.getAppSettings?.() || {};
  const username = settings.username || '旅人';
  const post = document.querySelector(`[data-moment-id="${momentId}"]`);
  const menuItem = post?.querySelector('.wechat-ops-menu-item');
  const liked = menuItem?.classList.contains('liked');
  try {
    const result = liked
      ? await api.unlikeMoment(momentId, { username })
      : await api.likeMoment(momentId, { username });
    const newLiked = result.likes.some(l => l === username);
    post?.querySelectorAll('.wechat-ops-menu-item').forEach((el, i) => {
      if (i === 0) el.classList.toggle('liked', newLiked);
    });
    const comments = (_momentsCache.get(momentId)?.comments) || [];
    updatePostInteract(momentId, result.likes, comments, username);
  } catch (err) { window.showToast?.(err.message); }
};

window.momentOpsComment = function(momentId, e) {
  e.stopPropagation();
  closeAllOpsMenus();
  clearMomentReplyTarget(momentId);
  window.toggleMomentComments(momentId);
};

window.replyToMomentComment = function(momentId, el) {
  const charId = parseInt(el.dataset.charId, 10);
  const charName = el.dataset.charName || '';
  const commentContent = el.dataset.commentContent || '';
  if (!charId) { window.showToast?.('无法回复该评论'); return; }
  _momentReplyTarget = { momentId, charId, charName, commentContent };
  _expandedComments.add(momentId);
  const box = document.getElementById(`comments-${momentId}`);
  if (box) box.style.display = '';
  const input = document.getElementById(`comment-input-${momentId}`);
  if (input) {
    input.placeholder = charName ? `回复 ${charName}…` : '评论…';
    input.focus();
  }
};

function clearMomentReplyTarget(momentId) {
  if (!_momentReplyTarget || _momentReplyTarget.momentId === momentId) {
    _momentReplyTarget = null;
    const input = document.getElementById(`comment-input-${momentId}`);
    if (input) input.placeholder = '评论…';
  }
}

window.toggleMomentComments = function(momentId) {
  const el = document.getElementById(`comments-${momentId}`);
  if (!el) return;
  const hidden = el.style.display === 'none';
  el.style.display = hidden ? '' : 'none';
  if (hidden) {
    _expandedComments.add(momentId);
    el.querySelector(`#comment-input-${momentId}`)?.focus();
  } else {
    _expandedComments.delete(momentId);
    clearMomentReplyTarget(momentId);
  }
};

window.submitMomentComment = async function(momentId) {
  const input = document.getElementById(`comment-input-${momentId}`);
  const content = input?.value.trim();
  if (!content) return;
  input.value = '';
  input.disabled = true;

  const settings = window.getAppSettings?.() || {};
  const username = settings.username || '旅人';
  const userAvatar = settings.user_avatar || '';

  const replyTarget = (_momentReplyTarget?.momentId === momentId) ? _momentReplyTarget : null;
  const payload = {
    content, role: 'user', username, avatar: userAvatar,
  };
  if (replyTarget) {
    payload.replyToCharId = replyTarget.charId;
    payload.replyToCharName = replyTarget.charName;
    payload.replyToComment = replyTarget.commentContent;
  }

  const cached = _momentsCache.get(momentId) || { likes: [], comments: [] };
  const optimisticComment = {
    role: 'user',
    content,
    username,
    replyToCharName: replyTarget?.charName || null,
    time: new Date().toISOString(),
  };
  const optimisticComments = [...(cached.comments || []), optimisticComment];
  updatePostInteract(momentId, cached.likes, optimisticComments, username);
  _expandedComments.add(momentId);
  const el = document.getElementById(`comments-${momentId}`);
  if (el) el.style.display = '';
  clearMomentReplyTarget(momentId);

  try {
    const result = await api.commentMoment(momentId, payload);
    updatePostInteract(momentId, cached.likes, result.comments, username);
  } catch (err) {
    updatePostInteract(momentId, cached.likes, cached.comments, username);
    window.showToast?.(err.message || '评论失败');
  }

  input.disabled = false;
};

function handleMomentNotify(data) {
  if (data.momentId) {
    const post = document.querySelector(`[data-moment-id="${data.momentId}"]`);
    if (post) {
      post.classList.add('flash-interact');
      setTimeout(() => post.classList.remove('flash-interact'), 700);
      refreshSingleMoment(data.momentId);
    } else {
      loadMoments({ silent: true });
    }
  }
}

async function refreshSingleMoment(momentId) {
  try {
    const { username, userAvatar } = viewerNameAvatar();
    const m = await api.getMoment(momentId);
    if (!m) return;
    _momentsCache.set(momentId, { likes: m.likes || [], comments: m.comments || [] });
    const viewKey = momentsViewKey(window._momentsViewCharId || null);
    const feed = getFeed(viewKey);
    const idx = feed.items.findIndex(x => x.id === m.id);
    if (idx >= 0) feed.items[idx] = { ...feed.items[idx], ...m };
    else setFeed(viewKey, [m, ...feed.items]);
    const post = document.querySelector(`[data-moment-id="${momentId}"]`);
    if (post) {
      const expanded = _expandedComments.has(momentId);
      const tmp = document.createElement('div');
      tmp.innerHTML = renderPost(m, username, userAvatar);
      post.replaceWith(tmp.firstElementChild);
      if (expanded) {
        const el = document.getElementById(`comments-${momentId}`);
        if (el) el.style.display = '';
      }
    }
  } catch {}
}

window.refreshMomentInteractions = async function(momentId) {
  await refreshSingleMoment(momentId);
};

function updateComposeExtra() {
  const el = document.getElementById('moment-compose-extra');
  if (!el) return;
  const parts = [];
  if (_momentLocation) parts.push(`<span class="moment-compose-tag">📍 ${escapeHtml(_momentLocation)} <span style="cursor:pointer;margin-left:4px" onclick="clearMomentLocation()">×</span></span>`);
  el.innerHTML = parts.join('');
}

window.clearMomentLocation = function() {
  _momentLocation = '';
  updateComposeExtra();
};

window.closeComposeMoment = function() {
  document.getElementById('moment-post-overlay')?.classList.remove('active');
};

window.openComposeMoment = function() {
  _momentImages = [];
  _momentLocation = '';
  _momentMentions = [];
  document.getElementById('moment-content-input').value = '';
  document.getElementById('moment-images-preview').innerHTML = '';
  updateComposeExtra();
  document.getElementById('moment-post-overlay').classList.add('active');
  setTimeout(() => document.getElementById('moment-content-input')?.focus(), 200);
};

window.openMomentMentionPicker = async function() {
  const overlay = document.getElementById('moment-mention-overlay');
  const list = document.getElementById('moment-mention-list');
  overlay.classList.add('active');
  try {
    const chars = _momentCharsCache || await api.getCharacters();
    _momentCharsCache = chars;
    const settings = window.getAppSettings?.() || {};
    const uname = settings.username || '旅人';
    list.innerHTML = `
      <div class="mention-item" onclick="insertMomentMention('${escapeHtml(uname)}', null)">
        <div class="avatar avatar-sm" style="font-size:12px">我</div>
        <span>${escapeHtml(uname)}（我）</span>
      </div>
      ${chars.map(c => `
        <div class="mention-item" onclick="insertMomentMention('${escapeHtml(c.name)}', ${c.id})">
          ${c.avatar ? `<img class="avatar avatar-sm" src="${escapeHtml(c.avatar)}" alt="">` : `<div class="avatar avatar-sm">👤</div>`}
          <span>${escapeHtml(c.name)}</span>
        </div>
      `).join('')}
    `;
  } catch {
    list.innerHTML = '<div style="padding:16px;color:var(--text-secondary)">加载失败</div>';
  }
};

window.insertMomentMention = function(name, charId) {
  const input = document.getElementById('moment-content-input');
  if (input) {
    const at = `@${name} `;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const needSpaceBefore = before.length > 0 && !/[\s，,。！？!?、；;：:]$/.test(before);
    const insert = (needSpaceBefore ? ' ' : '') + at;
    input.value = before + insert + after;
    const pos = before.length + insert.length;
    input.focus();
    input.setSelectionRange(pos, pos);
  }
  const settings = window.getAppSettings?.() || {};
  const username = settings.username || '旅人';
  const chars = _momentCharsCache || [];
  _momentMentions = buildMomentMentionsFromContent(input?.value || '', chars, username);
  document.getElementById('moment-mention-overlay')?.classList.remove('active');
};

window.pickMomentLocation = async function() {
  window.showToast?.('正在获取位置…');
  try {
    const { latitude: lat, longitude: lng } = await getDeviceCoordinates();
    try {
      const geoUrl = (window.resolveApiUrl || ((p) => p))(`/api/geocode/reverse?lat=${lat}&lng=${lng}`);
      const resp = await fetch(geoUrl, {
        credentials: window.isNativeShell?.() ? 'include' : 'same-origin',
      });
      if (resp.ok) {
        const data = await resp.json();
        _momentLocation = data.placeName || '';
      }
    } catch {}
    if (!_momentLocation) _momentLocation = `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`;
    updateComposeExtra();
    window.showToast?.('位置已添加');
  } catch (e) {
    window.showToast?.(formatLocationError(e));
  }
};

window.handleMomentImages = async function(e) {
  const files = Array.from(e.target.files || []);
  const preview = document.getElementById('moment-images-preview');
  for (const file of files.slice(0, 4 - _momentImages.length)) {
    try {
      const result = await pickCropAndUpload(file, { title: '裁剪朋友圈图片', aspect: 1 });
      if (!result) continue;
      _momentImages.push(result.url);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;display:inline-block';
      wrap.innerHTML = `<img src="${result.url}" style="width:80px;height:80px;object-fit:cover;border-radius:8px">
        <div onclick="this.parentNode.remove();_momentImages=_momentImages.filter(u=>u!=='${result.url}')"
          style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.5);color:#fff;border-radius:50%;
          width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer">✕</div>`;
      preview.appendChild(wrap);
    } catch {}
  }
  e.target.value = '';
};

window.postMoment = async function() {
  const content = document.getElementById('moment-content-input').value.trim();
  if (!content && !_momentImages.length) { window.showToast?.('内容不能为空'); return; }
  try {
    const settings = window.getAppSettings?.() || {};
    const username = settings.username || '旅人';
    const chars = _momentCharsCache || await api.getCharacters();
    _momentCharsCache = chars;
    const mentions = buildMomentMentionsFromContent(content, chars, username);
    const created = await api.createMoment({
      role: 'user', content, images: _momentImages,
      location: _momentLocation,
      mentions,
    });
    closeComposeMoment();
    window.showToast?.(mentions.some(m => m.charId) ? '已发布，被 @ 的角色稍后会回复' : '已发布，角色们稍后会来互动');
    _momentImages = [];
    _momentLocation = '';
    _momentMentions = [];
    const viewKey = momentsViewKey(window._momentsViewCharId || null);
    const { username: uname, userAvatar: uav } = viewerNameAvatar();
    if (created?.id && created.content !== undefined) {
      const feed = getFeed(viewKey);
      if (!feed.items.some(m => m.id === created.id)) {
        setFeed(viewKey, [created, ...feed.items]);
        prependMoments([created], uname, uav);
      }
    } else {
      await loadMoments({ silent: true });
    }
  } catch (e) { window.showToast?.(e.message); }
};

window.viewMomentImage = function(src) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer';
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `<img src="${escapeHtml(src)}" style="max-width:95%;max-height:92vh;object-fit:contain;border-radius:6px">`;
  document.body.appendChild(overlay);
};


window.openMomentBeanEmoji = async function() {
  const input = document.getElementById('moment-content-input');
  await openSystemEmojiOverlay({
    targetInput: input,
    includeStickers: false,
  });
};

window.openMomentCommentBeanEmoji = async function(momentId) {
  const input = document.getElementById('comment-input-' + momentId);
  await openSystemEmojiOverlay({
    targetInput: input,
    includeStickers: false,
  });
};

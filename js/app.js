/* ===== 念 · 主应用逻辑 ===== */
import * as api from './api.js';
import { getActiveCharId, setActiveCharId, getThemeColor, getBgSettings, getChatSettings, saveChatSettings, getPwaIcon, savePwaIcon } from './storage.js';
import { applyPwaIcon } from './pwa-icon.js';
import { buildThemeGradient, resolveGradientPreset } from './theme-gradients.js';
import { applyMediaCrop, setupBgVideo, setupBgImage, resetBgMediaEl } from './media-crop.js';
import { ensureWebPushSubscription, subscribeWebPush, pushSubscribeHint, getLocalPushStatus, testWebPush } from './push-subscribe.js';
import { initKeyboardAvoidance, clearInactivePageKeyboardLayout } from './keyboard-avoid.js';
import { formatMessagePreview, stripAiContextLabels } from './memory.js';
import {
  ensureServerConfigured, getServerBase, getWsUrl, isNativeShell, installNativeMediaRewriter, waitForNativeBridge, resolveApiUrl,
} from './server-config.js';
import { promptBasicNativePermissionsOnce, requestAppNotifications, tryShowNativeCapsule, hideNativeCapsule, tryShowNativeIncomingCall, dismissNativeIncomingCall, setNativeHaloCharacter, nianHaptic, openExternalUrl, requestNativeCamera, getAppPermissionStatus } from './app-permissions.js';
window.nianHaptic = nianHaptic;
window.openExternalUrl = openExternalUrl;
import { promptAppUpdateIfNeeded } from './app-update.js';
import { startPhoneNotificationSync } from './phone-bridge.js';
import { installMediaCacheResolver } from './chat-media-cache.js';
import { startChatArchiveSync } from './chat-archive.js';
import { playCallRingtone, stopCallRingtone, prefetchTTS, unlockAudioPlayback, useSystemCallRingtone } from './tts.js';
import { initHomeDesktop, refreshHomeDesktop, tickWidgetClocks } from './home-desktop.js';
import {
  syncMomentsUnread,
  noteMomentsNewPost,
  noteMomentsInteraction,
} from './moments-unread.js';

try {
  if (isNativeShell()) document.documentElement.classList.add('native-shell');
} catch {}

// ===== 全局状态 =====
let characters = [];
let settings = {};
let activeCharId = null;
let wsClient = null;
let wheelOpen = false;

// ===== 页面导航（最先暴露到全局） =====
let pageHistory = ['home'];
const _loadedPages = new Set();
let _navGen = 0;

const _pageLoadPromises = new Map();
function loadPageModule(name) {
  if (_loadedPages.has(name)) return Promise.resolve();
  if (_pageLoadPromises.has(name)) return _pageLoadPromises.get(name);
  const loader = PAGE_LOADERS[name];
  if (!loader) return Promise.resolve();
  const p = loader()
    .then(() => { _loadedPages.add(name); })
    .catch((err) => { throw err; })
    .finally(() => { _pageLoadPromises.delete(name); });
  _pageLoadPromises.set(name, p);
  return p;
}
window.preloadPage = function(name) {
  void loadPageModule(name);
};

const PAGE_LOADERS = {
  chat: () => import('./pages/chat-page.js?v=offpage-notify1'),
  dream: () => import('./pages/dream-page.js'),
  diary: () => import('./pages/diary-page.js'),
  character: () => import('./pages/character-page.js?v=char-import1'),
  worldbook: () => import('./pages/worldbook-page.js'),
  preset: () => import('./pages/preset-page.js'),
  manage: () => import('./pages/manage-page.js'),
  album: () => import('./pages/album-page.js'),
  photostudio: () => import('./pages/photostudio-page.js'),
  moments: () => import('./pages/moments-page.js?v=npc1'),
  settings: () => import('./pages/settings-page.js'),
  memory: () => import('./pages/memory-page.js?v=164'),
  circle: () => import('./pages/circle-page.js?v=char2'),
  beautify: () => import('./pages/beautify-page.js'),
  schedule: () => import('./pages/schedule-page.js?v=162'),
  'emoji-manager': () => import('./pages/emoji-manager-page.js'),
  contacts: () => import('./pages/contacts-page.js?v=char-import1'),
  'group-chat': () => import('./pages/group-chat-page.js'),
  profile: () => import('./pages/profile-page.js?v=shake2'),
  'friend-settings': () => import('./pages/friend-settings-page.js'),
  games: () => import('./pages/games-page.js'),
  reader: () => import('./pages/reader-page.js'),
  series: () => import('./pages/series-page.js'),
  robot: () => import('./pages/robot-page.js'),
  mcp: () => import('./pages/mcp-page.js'),
  impression: () => import('./pages/impression-page.js'),
  wardrobe: () => import('./pages/wardrobe-page.js'),
  appearance: () => import('./pages/appearance-page.js'),
  monitor: () => import('./pages/monitor-page.js'),
  ta: () => import('./pages/ta-page.js'),
  mailbox: () => import('./pages/mailbox-page.js'),
  postoffice: () => import('./pages/postoffice-page.js'),
  tieba: () => import('./pages/tieba-page.js?v=setup2'),
};

// 将 kebab-case 转为 PascalCase，例如 emoji-manager → EmojiManager
function capitalize(s) {
  return s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

async function showPage(name) {
  if (name === 'beautify') {
    window._settingsInitTab = 'beautify';
    name = 'settings';
  }
  if (name === 'worldbook') {
    window._manageTab = 'worldbook';
    name = 'manage';
  }
  if (name === 'preset') {
    window._manageTab = 'preset';
    name = 'manage';
  }
  const navToken = ++_navGen;
  const leavingMonitor = name !== 'monitor' && document.getElementById('monitor-page')?.classList.contains('active');
  if (leavingMonitor) window.destroyMonitorPage?.();
  const leavingChat = name !== 'chat' && (
    _lastPageName === 'chat'
    || document.getElementById('chat-page')?.classList.contains('active')
  );
  if (leavingChat) {
    window.flushChatComposerOnLeave?.();
    window.closeChatLinkSheet?.();
    window.closeChatWebCardSheet?.();
    window.exitChatSelectMode?.();
    window.setChatToolbarOpen?.(false);
    window.closeEmojiPanel?.();
    window.hideContextMenu?.();
    window.closeChatSearch?.();
    window.closeChatSettings?.();
    window.getChatPageViewCharId = () => null;
    try { window.onChatPageHidden?.(); } catch {}
  }
  const leavingGroup = name !== 'group-chat' && document.getElementById('group-chat-page')?.classList.contains('active');
  if (leavingGroup) {
    window._activeGroupId = null;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  clearInactivePageKeyboardLayout();
  const el = document.getElementById(`${name}-page`);
  if (el) {
    el.classList.add('active');
    updatePageLayers(name);
    if (name === 'home') {
      resumeHomeMedia();
    } else {
      pauseHomeMedia();
    }
    if (name === 'contacts') void loadPageModule('chat');
    if (PAGE_LOADERS[name] && !_loadedPages.has(name)) {
      try {
        await loadPageModule(name);
        if (navToken !== _navGen) return;
      } catch (e) {
        if (navToken !== _navGen) return;
        console.error(`[page] load ${name} failed`, e);
        if (name === 'chat') showToast('聊天页加载失败，请刷新后再进', 4000);
        else if (name === 'contacts') showToast('通讯页加载失败，请强制刷新后再进', 4000);
      }
    }
    if (navToken !== _navGen) return;
    const initFn = window[`init${capitalize(name)}Page`];
    if (typeof initFn === 'function') {
      try {
        await initFn();
      } catch (e) {
        if (navToken !== _navGen) return;
        console.error(`[page] init${name} error`, e);
        if (String(e.message || '').includes('超时') || String(e.message || '').includes('后端')) {
          showToast(e.message, 4500);
        }
      }
    }
    if (navToken !== _navGen) return;
    // 必须用当前导航状态判断，避免慢加载完成后误把壁纸又播起来
    if (name === 'home' && isHomeActive()) {
      renderHomeChar();
      resumeHomeMedia();
    }
  }
}

/** 微信式浅灰顶栏（非死白） */
const CHROME_BAR_LIGHT = '#ededed';
const CHROME_BAR_DARK = '#1e1824';

/** 与 `.topbar` 底色一致，避免刘海垫层与顶栏之间露出主题紫 */
function getChromeBarColor(pageName = _lastPageName) {
  if (pageName === 'home' || pageName === 'moments') return '#100818';
  const dark = document.documentElement.getAttribute('data-color-scheme') === 'dark';
  return dark ? CHROME_BAR_DARK : CHROME_BAR_LIGHT;
}

/** 系统状态栏叠在网页上，不再单独占一条黑底 */
const SYSTEM_STATUS_BAR_COLOR = '#000000';

/** 浏览器/PWA 读 theme-color 染系统状态栏；必须同步全部 meta（三星常读 light/dark 那条） */
function setThemeColorMetas(color) {
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', color);
  });
}

/** 沉浸式状态栏：APK 透明叠层，浏览器仍用黑底 */
function ensureSystemStatusBarTheme() {
  // APK 沉浸式：不要用 theme-color 再画出一条黑状态栏
  if (window.Capacitor?.isNativePlatform?.()) {
    setThemeColorMetas('#00000000');
    document.documentElement.style.setProperty('--status-bar-color', 'transparent');
    return;
  }
  setThemeColorMetas(SYSTEM_STATUS_BAR_COLOR);
  document.documentElement.style.setProperty('--status-bar-color', SYSTEM_STATUS_BAR_COLOR);
}

let _lastPageName = 'home';

function updatePageLayers(pageName) {
  _lastPageName = pageName || 'home';
  const isHome = pageName === 'home';
  const isMoments = pageName === 'moments';
  // 主题紫层只给仍透底的页（聊天/梦境）；白底内页不铺，避免点进去先闪紫
  const showThemeBg = !isHome && (pageName === 'chat' || pageName === 'dream');
  document.getElementById('theme-bg')?.classList.toggle('visible', showThemeBg);
  document.body.classList.toggle('on-home', isHome);
  // 透明状态栏叠在顶栏上；内页 html 底色跟顶栏一致
  const chrome = getChromeBarColor(pageName);
  document.documentElement.style.background = (isHome || isMoments) ? '#100818' : chrome;
  document.body.style.background = 'transparent';
  ensureSystemStatusBarTheme();
  syncNativeStatusBar(pageName);
}

async function syncNativeStatusBar(pageName = _lastPageName) {
  try {
    if (!window.Capacitor?.isNativePlatform?.()) return;
    const StatusBar = window.Capacitor.Plugins?.StatusBar;
    const darkChrome = pageName === 'home' || pageName === 'moments';
    const darkScheme = document.documentElement.getAttribute('data-color-scheme') === 'dark';
    // 浅色顶栏：透明状态栏 + 深色字；深色壁纸/顶栏：浅色字
    const lightIcons = darkChrome || darkScheme;
    const style = lightIcons ? 'LIGHT' : 'DARK';
    try { await StatusBar?.show?.(); } catch {}
    try { await StatusBar?.setOverlaysWebView?.({ overlay: true }); } catch {}
    try { await StatusBar?.setBackgroundColor?.({ color: '#00000000' }); } catch {}
    try { await StatusBar?.setStyle?.({ style }); } catch {}
    try {
      window.NianStatusBar?.setLightIcons?.(lightIcons);
    } catch {}
  } catch (e) {
    console.warn('[StatusBar]', e?.message || e);
  }
}

function pauseHomeMedia() {
  const bgVideo = document.getElementById('bg-video');
  if (bgVideo) {
    bgVideo._bgPlayGen = (bgVideo._bgPlayGen || 0) + 1;
    bgVideo.onloadeddata = null;
    try { if (!bgVideo.paused) bgVideo.pause(); } catch {}
  }
  stopParticles();
  const layer = document.getElementById('home-desktop-bg');
  const imageOn = document.getElementById('bg-image')?.style.display !== 'none'
    || document.body.classList.contains('home-bg-image');
  const videoOn = !!(bgVideo && bgVideo.style.display !== 'none');
  layer?.classList.toggle('park-hard', !!(imageOn || videoOn));
}

function resumeHomeMedia() {
  document.getElementById('home-desktop-bg')?.classList.remove('park-hard');
  const bgVideo = document.getElementById('bg-video');
  if (bgVideo && bgVideo.style.display !== 'none') {
    if (bgVideo.paused) bgVideo.play().catch(() => {});
  }
  const canvas = document.getElementById('particle-canvas');
  if (canvas && canvas.style.display !== 'none') {
    startParticles(canvas);
  }
  tickHomeClock();
}

function stopParticles() {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  if (canvas._particleRaf) {
    cancelAnimationFrame(canvas._particleRaf);
    canvas._particleRaf = 0;
  }
  if (canvas._particleResize) {
    window.removeEventListener('resize', canvas._particleResize);
    canvas._particleResize = null;
  }
  canvas._particlesRunning = false;
}

function isHomeActive() {
  return pageHistory[pageHistory.length - 1] === 'home';
}

/** 别名页写进历史时用真实页名，避免返回时栈与画面错位 */
function resolveNavPage(page) {
  if (page === 'beautify') {
    window._settingsInitTab = 'beautify';
    return 'settings';
  }
  if (page === 'worldbook') {
    window._manageTab = 'worldbook';
    return 'manage';
  }
  if (page === 'preset') {
    window._manageTab = 'preset';
    return 'manage';
  }
  return page;
}

function navigateTo(page) {
  const target = resolveNavPage(page);
  const cur = pageHistory[pageHistory.length - 1];
  if (cur !== target) pageHistory.push(target);
  void showPage(page);
}

/**
 * 回到已在栈里的页面（弹出中间页）；不在栈里则替换当前页。
 * 用于「从 A 进 B 再回 A」——禁止再用 navigateTo(A) 把 A 叠一层，否则返回会乱跳。
 */
function navigateBackTo(page) {
  const target = resolveNavPage(page);
  const idx = pageHistory.lastIndexOf(target);
  if (idx >= 0) {
    pageHistory = pageHistory.slice(0, idx + 1);
  } else if (pageHistory.length > 1) {
    pageHistory[pageHistory.length - 1] = target;
  } else {
    pageHistory = ['home', target];
  }
  void showPage(page);
}

window.showPage = showPage;
window.navigateTo = navigateTo;
window.navigateBackTo = navigateBackTo;

/** 未加载群聊页模块时也能从收件箱点进群 */
window.openGroupChat = async function(groupId) {
  window._pendingGroupId = groupId;
  try {
    await loadPageModule('group-chat');
  } catch (e) {
    console.warn('[group-chat] load', e);
  }
  window.navigateTo?.('group-chat');
};

window.goBack = function() {
  window.stopCurrentTTS?.();
  if (pageHistory.length <= 1) {
    void showPage('home');
    return;
  }
  const leaving = pageHistory.pop();
  while (pageHistory.length > 1 && pageHistory[pageHistory.length - 1] === leaving) {
    pageHistory.pop();
  }
  const prev = pageHistory[pageHistory.length - 1] || 'home';
  void showPage(prev);
};
window.goHome = function() {
  window.stopCurrentTTS?.();
  pageHistory = ['home'];
  void showPage('home');
};
window.chatPageGoBack = function() {
  if (window.consumeChatPageBack?.()) return;
  window.goBack?.();
};

function isShownEl(el) {
  if (!el) return false;
  const st = window.getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
  if (st.pointerEvents === 'none') return false;
  return el.getClientRects().length > 0;
}

function dismissOverlayEl(el) {
  if (!el) return;
  const id = el.id || '';
  const named = {
    'chat-media-viewer': () => window.closeChatMediaViewer?.(),
    'chat-link-sheet': () => window.closeChatLinkSheet?.(),
    'chat-web-card-sheet': () => window.closeChatWebCardSheet?.(),
    'chat-search-overlay': () => window.closeChatSearch?.(),
    'chat-settings-overlay': () => window.closeChatSettings?.(),
    'game-topics-overlay': () => window.closeGameTopicsPanel?.(),
    'game-butler-overlay': () => window.closeGameButlerPanel?.(),
    'emotion-overlay': () => window.closeEmotionPanel?.(),
    'incoming-call-overlay': () => window.declineIncomingCall?.(),
    'album-detail-overlay': () => window.closeAlbumDetail?.(),
    'narrative-detail-overlay': () => window.closeStoryDetail?.(),
    'game-memory-overlay': () => window.closeGameMemoryEditor?.(),
  };
  if (named[id]) {
    named[id]();
    return;
  }
  if (el.classList.contains('series-modal-mask') || el.classList.contains('model-picker-overlay') || id === 'model-picker-overlay') {
    el.remove();
    return;
  }
  el.classList.remove('active');
  if (el.style.display && el.style.display !== 'none') el.style.display = 'none';
}

/** 关掉最上层弹层；关过则返回 true。站点锁/填服务器地址不关，但会吞掉返回，避免滑出 App。 */
function closeTopmostUiLayer() {
  if (document.getElementById('site-lock-overlay')?.classList.contains('is-visible')) return true;
  if (document.getElementById('nian-server-setup')) return true;
  const splash = document.getElementById('app-splash');
  if (splash && !splash.classList.contains('is-hidden')) return true;

  const emoji = document.getElementById('chat-emoji-panel');
  if (isShownEl(emoji)) {
    window.closeEmojiPanel?.();
    return true;
  }
  const toolbar = document.getElementById('chat-toolbar');
  if (toolbar?.classList.contains('is-open') && isShownEl(toolbar)) {
    window.setChatToolbarOpen?.(false);
    return true;
  }

  const skip = new Set(['desktop-overlay', 'site-lock-overlay']);
  const layers = [...document.querySelectorAll('.overlay, .incoming-call-overlay, .series-modal-mask, .home-folder-overlay')]
    .filter((el) => !skip.has(el.id) && isShownEl(el));
  layers.sort((a, b) => {
    const za = Number(window.getComputedStyle(a).zIndex) || 0;
    const zb = Number(window.getComputedStyle(b).zIndex) || 0;
    return zb - za;
  });
  if (!layers.length) return false;
  dismissOverlayEl(layers[0]);
  return true;
}

/**
 * 系统侧滑/返回键：先关弹层，再按页面栈返回。
 * 返回 true = 已处理，不要退到手机桌面。
 */
window.handleNativeBack = function handleNativeBack() {
  try {
    if (window.consumeHomeBack?.()) return true;
    if (closeTopmostUiLayer()) return true;
    if (window.consumeChatPageBack?.()) return true;
    const onHome = isHomeActive() || pageHistory.length <= 1;
    if (!onHome) {
      window.goBack?.();
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[native-back]', e);
    return false;
  }
};

// 轮盘已移除，改为主页 iOS 图标网格直接导航

// 轮盘相关函数已移除

// ===== Toast（与朋友圈回复同款系统横幅，跟随浅/深色）=====
function showToast(msg, duration = 2500) {
  showSystemNotify(msg, duration);
}
window.showToast = showToast;

/** 系统/回复类横幅（跟随浅色/深色模式）。duration≤0 时保持显示直到 hideSystemNotify */
function showSystemNotify(msg, duration = 2800) {
  if (!msg) return;
  let el = document.getElementById('system-notify-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'system-notify-banner';
    el.className = 'system-notify';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = null;
  if (duration > 0) {
    el._timer = setTimeout(() => { el.style.display = 'none'; }, duration);
  }
}
function hideSystemNotify() {
  const el = document.getElementById('system-notify-banner');
  if (!el) return;
  clearTimeout(el._timer);
  el._timer = null;
  el.style.display = 'none';
}
window.showSystemNotify = showSystemNotify;
window.hideSystemNotify = hideSystemNotify;

window.formatMomentNotifyText = function(data) {
  if (data.type === 'like') return `${data.charName} 赞了你的朋友圈`;
  if (data.isReply) return `${data.charName} 回复了你：${(data.content || '').slice(0, 20)}`;
  return `${data.charName} 评论了你：${(data.content || '').slice(0, 20)}`;
};

// ===== 消息通知横幅（AI 后台回复时用）=====
const _unreadCounts = {}; // charId → count
const _groupUnreadCounts = {}; // groupId → count

window.getUnreadCount = (charId) => _unreadCounts[String(charId)] || 0;
window.getGroupUnreadCount = (groupId) => _groupUnreadCounts[String(groupId)] || 0;
window.getTotalUnreadCount = () => {
  const chars = Object.values(_unreadCounts).reduce((s, n) => s + (Number(n) || 0), 0);
  const groups = Object.values(_groupUnreadCounts).reduce((s, n) => s + (Number(n) || 0), 0);
  return chars + groups;
};
window.incrementUnread = (charId, count = 1) => {
  const key = String(charId);
  const n = Math.max(1, parseInt(count, 10) || 1);
  _unreadCounts[key] = (_unreadCounts[key] || 0) + n;
  updateInboxBadges();
  updateHomeChatBadge();
  window.updateContactsTabBadge?.();
};
window.bumpGroupUnread = (groupId, count = 1) => {
  const key = String(groupId);
  const n = Math.max(1, parseInt(count, 10) || 1);
  _groupUnreadCounts[key] = (_groupUnreadCounts[key] || 0) + n;
  updateInboxBadges();
  updateHomeChatBadge();
  window.updateContactsTabBadge?.();
};
window.clearUnread = (charId) => {
  _unreadCounts[String(charId)] = 0;
  updateInboxBadges();
  updateHomeChatBadge();
  window.updateContactsTabBadge?.();
};
window.clearGroupUnread = (groupId) => {
  _groupUnreadCounts[String(groupId)] = 0;
  updateInboxBadges();
  updateHomeChatBadge();
  window.updateContactsTabBadge?.();
};

async function syncUnreadCounts() {
  try {
    const prev = { ..._unreadCounts };
    const prevGroups = { ..._groupUnreadCounts };
    const [counts, groupCounts] = await Promise.all([
      api.getUnreadSummary(),
      api.getGroupUnreadSummary().catch(() => ({})),
    ]);
    Object.keys(_unreadCounts).forEach(k => delete _unreadCounts[k]);
    Object.keys(_groupUnreadCounts).forEach(k => delete _groupUnreadCounts[k]);
    const allKeys = new Set([
      ...Object.keys(counts || {}),
      ...Object.keys(prev),
    ]);
    allKeys.forEach((cid) => {
      const serverN = Number(counts?.[cid] ?? counts?.[Number(cid)]) || 0;
      const localN = Number(prev[String(cid)]) || 0;
      const finalN = Math.max(serverN, localN);
      if (finalN > 0) _unreadCounts[String(cid)] = finalN;
    });
    const allGroupKeys = new Set([
      ...Object.keys(groupCounts || {}),
      ...Object.keys(prevGroups),
    ]);
    allGroupKeys.forEach((gid) => {
      const serverN = Number(groupCounts?.[gid] ?? groupCounts?.[Number(gid)]) || 0;
      const localN = Number(prevGroups[String(gid)]) || 0;
      const finalN = Math.max(serverN, localN);
      if (finalN > 0) _groupUnreadCounts[String(gid)] = finalN;
    });
    updateInboxBadges();
    updateHomeChatBadge();
    window.updateContactsTabBadge?.();
  } catch (e) {
    console.warn('[unread] sync failed', e);
  }
}
window.syncUnreadCounts = syncUnreadCounts;

function updateHomeChatBadge() {
  const total = window.getTotalUnreadCount?.() || 0;
  document.querySelectorAll('.home-chat-badge, #home-chat-badge').forEach((badge) => {
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.style.display = 'flex';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
    }
  });
}
window.updateHomeChatBadge = updateHomeChatBadge;

function updateInboxBadges() {
  const inbox = document.getElementById('ct-content');
  if (!inbox) return;
  Object.entries(_unreadCounts).forEach(([cid, n]) => {
    const badge = inbox.querySelector(`[data-unread-char="${cid}"]`);
    if (!badge) return;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.style.display = 'flex';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
    }
  });
  Object.entries(_groupUnreadCounts).forEach(([gid, n]) => {
    const badge = inbox.querySelector(`[data-unread-group="${gid}"]`);
    if (!badge) return;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.style.display = 'flex';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
    }
  });
}
window.updateInboxBadges = updateInboxBadges;

// 全局聊天消息通知横幅（支持多条排队）
const _notifQueue = [];
let _notifShowing = false;
let _pendingIncomingCall = null;
let _incomingRingTimer = null;
let _incomingSettled = false;
let _incomingShowToken = 0;
const INCOMING_TTS_WAIT_MS = 28000;
/** 接听后来电页收起后再开口，避免叠在响铃页上 */
const ANSWER_OPENING_GAP_MS = 1300;

function escNotifText(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function ensureChatNotifBanner() {
  let banner = document.getElementById('chat-notification-banner');
  if (banner) return banner;
  banner = document.createElement('div');
  banner.id = 'chat-notification-banner';
  banner.className = 'chat-notification-banner';
  document.body.appendChild(banner);
  bindChatNotifSwipeDismiss(banner);
  return banner;
}

function resetChatNotifBannerStyle(banner) {
  banner.classList.remove('is-dragging', 'is-dismissing');
  banner.style.transform = '';
  banner.style.opacity = '';
}

/** 微信式上滑关掉当前横幅 */
function bindChatNotifSwipeDismiss(banner) {
  if (banner.dataset.swipeBound === '1') return;
  banner.dataset.swipeBound = '1';

  let startY = 0;
  let startX = 0;
  let dragging = false;
  let moved = false;
  let blockClick = false;
  const SWIPE_THRESHOLD = 42;

  function onDismissRequest() {
    banner._dismiss?.();
  }

  function onPointerDown(clientY, clientX) {
    startY = clientY;
    startX = clientX;
    dragging = true;
    moved = false;
    clearTimeout(banner._timer);
  }

  function onPointerMove(clientY, clientX) {
    if (!dragging) return;
    const dy = clientY - startY;
    const dx = clientX - startX;
    if (Math.abs(dy) > 6 || Math.abs(dx) > 6) moved = true;
    if (dy >= 0) return;
    banner.classList.add('is-dragging');
    banner.style.transform = `translateX(-50%) translateY(${dy}px)`;
    banner.style.opacity = String(Math.max(0.28, 1 + dy / 130));
  }

  function onPointerUp(clientY) {
    if (!dragging) return;
    dragging = false;
    const dy = clientY - startY;
    if (moved) {
      blockClick = true;
      setTimeout(() => { blockClick = false; }, 280);
    }
    if (dy < -SWIPE_THRESHOLD) {
      banner.classList.remove('is-dragging');
      banner.classList.add('is-dismissing');
      banner.style.transform = 'translateX(-50%) translateY(calc(-100% - 36px))';
      banner.style.opacity = '0';
      setTimeout(onDismissRequest, 220);
      return;
    }
    resetChatNotifBannerStyle(banner);
    if (banner.classList.contains('is-visible')) {
      banner._timer = setTimeout(onDismissRequest, 3500);
    }
  }

  banner.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    onPointerDown(e.touches[0].clientY, e.touches[0].clientX);
  }, { passive: true });

  banner.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    onPointerMove(e.touches[0].clientY, e.touches[0].clientX);
  }, { passive: true });

  banner.addEventListener('touchend', (e) => {
    onPointerUp(e.changedTouches[0]?.clientY ?? startY);
  }, { passive: true });

  banner.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    onPointerDown(e.clientY, e.clientX);
    const onMove = (ev) => onPointerMove(ev.clientY, ev.clientX);
    const onUp = (ev) => {
      onPointerUp(ev.clientY);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  banner.addEventListener('click', (e) => {
    if (blockClick) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

function incomingCallOverlayIsUp() {
  const ov = document.getElementById('incoming-call-overlay');
  if (!ov) return false;
  if (!(ov.classList.contains('is-on') || ov.style.display === 'flex')) return false;
  return true;
}

function _showNextNotif() {
  if (_notifShowing || !_notifQueue.length) return;
  // 来电 / 视频通话页面前不弹：把整段队列压住，等来电结束再放出来
  if (window._nianIncomingOverlayShown && !incomingCallOverlayIsUp()) {
    window._nianIncomingOverlayShown = false;
  }
  if (window._nianIncomingOverlayShown && incomingCallOverlayIsUp()) return;
  while (_notifQueue.length && window.isChatPageActiveFor?.(_notifQueue[0].charId)) {
    _notifQueue.shift();
  }
  if (!_notifQueue.length) return;
  _notifShowing = true;
  const { charName, charAvatar, text, charId } = _notifQueue.shift();
  const banner = ensureChatNotifBanner();

  banner.innerHTML = `
    ${charAvatar
      ? `<img src="${escNotifText(charAvatar)}" class="chat-notif-avatar" alt="">`
      : `<div class="chat-notif-avatar-ph">👤</div>`}
    <div class="chat-notif-body">
      <div class="chat-notif-name">${escNotifText(charName)}</div>
      <div class="chat-notif-text">${escNotifText(text)}</div>
    </div>
    <div class="chat-notif-close" aria-hidden="true">✕</div>
  `;
  banner.dataset.charId = String(charId ?? '');

  function dismiss() {
    clearTimeout(banner._timer);
    banner.classList.remove('is-visible', 'is-dismissing');
    resetChatNotifBannerStyle(banner);
    setTimeout(() => {
      banner.style.display = 'none';
      _notifShowing = false;
      _showNextNotif();
    }, 280);
  }
  banner._dismiss = dismiss;

  banner.onclick = () => {
    window.setActiveChar?.(charId);
    window.navigateTo?.('chat');
    dismiss();
  };

  banner.classList.remove('is-visible', 'is-dismissing');
  resetChatNotifBannerStyle(banner);
  banner.style.display = 'flex';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => banner.classList.add('is-visible'));
  });
  banner._timer = setTimeout(dismiss, 3500);
}

function enqueueChatBanner(charName, charAvatar, text, charId) {
  if (window.isChatPageActiveFor?.(charId)) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  _notifQueue.push({ charName, charAvatar, text, charId });
  _showNextNotif();
}

function preferredScreenChatChar() {
  return characters.find((c) => Number(c.screen_chat_priority) === 1) || null;
}

function syncNativeHaloCharacter(fallback) {
  const c = preferredScreenChatChar() || fallback;
  if (c) setNativeHaloCharacter({ characterId: c.id, name: c.name || 'TA' });
}

function toNativeCapsuleBubbles(messages) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!m) continue;
    const type = String(m.type || 'text');
    if (type === 'system' || type === 'voice') continue;
    if (type === 'emoji') {
      const url = String(m.content || m.url || '').trim();
      if (!url || seen.has(`e:${url}`)) continue;
      seen.add(`e:${url}`);
      out.push({ type: 'emoji', url, text: String(m.description || '').trim() });
      continue;
    }
    if (type !== 'text') continue;
    const t = String(m.content || m.text || '').trim();
    if (!t || seen.has(`t:${t}`)) continue;
    seen.add(`t:${t}`);
    out.push({ type: 'text', text: t });
  }
  return out;
}

function notifyChatOsLevel(charName, charAvatar, text, charId, messages) {
  const preview = text || '新消息';
  const pref = preferredScreenChatChar();
  if (pref && Number(pref.id) !== Number(charId)) {
    showSystemNotificationIfNeeded(charName, charAvatar, preview, charId);
    return;
  }
  Promise.resolve(tryShowNativeCapsule({
    characterId: charId,
    name: charName,
    text: preview,
    avatar: charAvatar,
    bubbles: toNativeCapsuleBubbles(messages),
  })).then((shown) => {
    if (!shown) showSystemNotificationIfNeeded(charName, charAvatar, preview, charId);
  }).catch(() => {
    showSystemNotificationIfNeeded(charName, charAvatar, preview, charId);
  });
}

function formatChatNotifPreview(msg) {
  return formatMessagePreview(msg, { withRolePrefix: false, maxLen: 60, empty: '新消息' });
}

window.formatChatNotifPreview = formatChatNotifPreview;

/** 角色每条消息各弹一条横幅（排队依次显示）；系统级通知仍整轮只弹一次 */
window.notifyChatMessages = function(charName, charAvatar, messages, charId) {
  if (window.isChatPageActiveFor?.(charId)) return;
  const list = Array.isArray(messages) && messages.length
    ? messages
    : [{ type: 'text', content: '新消息' }];
  for (const msg of list) {
    enqueueChatBanner(charName, charAvatar, formatChatNotifPreview(msg), charId);
  }
  const previewMsg = list[list.length - 1];
  notifyChatOsLevel(charName, charAvatar, formatChatNotifPreview(previewMsg), charId, list);
};

window.showChatNotification = function(charName, charAvatar, text, charId) {
  if (window.isChatPageActiveFor?.(charId)) return;
  enqueueChatBanner(charName, charAvatar, text, charId);
  notifyChatOsLevel(charName, charAvatar, text, charId, [{ type: 'text', content: text }]);
};

/** HTTP deferAiReply 与 WS background_message 双通道去重（按消息 id） */
const _handledIncomingMsgIds = new Map();
const HANDLED_INCOMING_TTL_MS = 120000;

function pruneHandledIncoming(now = Date.now()) {
  if (_handledIncomingMsgIds.size < 200) return;
  for (const [k, t] of _handledIncomingMsgIds) {
    if (now - t > HANDLED_INCOMING_TTL_MS) _handledIncomingMsgIds.delete(k);
  }
}

/**
 * 认领一轮入站回复的通知/未读。任一消息 id 已处理过则返回 false。
 * 无 id 时用内容指纹兜底。
 */
window.claimIncomingChatNotify = function(charId, messages) {
  const cid = String(charId ?? '');
  const list = Array.isArray(messages) && messages.length
    ? messages
    : [{ type: 'text', content: '新消息' }];
  const now = Date.now();
  pruneHandledIncoming(now);

  const ids = list
    .map(m => (m?.id != null && m.id !== '' ? String(m.id) : ''))
    .filter(Boolean)
    .filter(id => !id.startsWith('seg_') && !id.startsWith('tmp_') && !id.startsWith('vseg_') && !id.startsWith('auto_'));

  if (ids.length) {
    if (ids.some(id => _handledIncomingMsgIds.has(id))) {
      ids.forEach(id => _handledIncomingMsgIds.set(id, now));
      return false;
    }
    ids.forEach(id => _handledIncomingMsgIds.set(id, now));
    return true;
  }

  const fingerprint = `${cid}:` + list.map(m =>
    `${m?.type || 'text'}:${String(m?.content || '').slice(0, 48)}`
  ).join('|');
  if (_handledIncomingMsgIds.has(fingerprint)) return false;
  _handledIncomingMsgIds.set(fingerprint, now);
  return true;
};

/** 离页时统一通知+未读（HTTP/WS 共用，内部去重） */
window.notifyIncomingChatOffPage = function(charId, messages, meta = {}) {
  if (window.isChatPageActiveFor?.(charId)) return false;
  const list = Array.isArray(messages) && messages.length
    ? messages
    : [{ type: 'text', content: '新消息' }];
  if (!window.claimIncomingChatNotify?.(charId, list)) return false;
  const charName = meta.charName || 'TA';
  const charAvatar = meta.charAvatar || '';
  window.notifyChatMessages?.(charName, charAvatar, list, charId);
  window.incrementUnread?.(charId, list.length);
  return true;
};


async function showSystemNotificationIfNeeded(charName, charAvatar, text, charId) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (window.isChatPageActiveFor?.(charId)) return;
  try {
    const reg = await navigator.serviceWorker?.ready;
    const icon = charAvatar && charAvatar.startsWith('http') ? charAvatar : '/assets/icons/icon-192.png';
    const opts = {
      body: (text || '').slice(0, 120),
      icon,
      badge: '/assets/icons/icon-192.png',
      tag: charId ? `nian-chat-${charId}-${Date.now()}` : `nian-chat-${Date.now()}`,
      renotify: true,
      data: { charId },
    };
    if (reg?.showNotification) reg.showNotification(charName || '念', opts);
    else new Notification(charName || '念', opts);
  } catch {}
}

window.requestNotificationPermission = async function() {
  if (isNativeShell()) {
    try { await requestAppNotifications(); } catch {}
  }
  if (!('Notification' in window)) {
    if (isNativeShell()) {
      const s = await requestAppNotifications();
      return s?.notifications ? 'granted' : 'denied';
    }
    return 'unsupported';
  }
  if (Notification.permission === 'granted') {
    await subscribeWebPush();
    return 'granted';
  }
  if (Notification.permission === 'denied') return 'denied';
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    const r = await subscribeWebPush();
    if (!r.ok && r.reason === 'need_https') {
      window.showToast?.('通知已开；Web Push 需 HTTPS 后才能在 App 关闭时收到');
    } else if (!r.ok && r.reason !== 'unsupported') {
      window.showToast?.(pushSubscribeHint(r.reason));
    }
  }
  return perm;
};

window.trySubscribeWebPush = ensureWebPushSubscription;
window.getLocalPushStatus = getLocalPushStatus;
window.testWebPush = testWebPush;

function formatNotifStatus(local, server) {
  if (!local.supported) return { text: '不支持', color: 'var(--text-secondary)' };
  if (local.permission === 'denied') return { text: '已拒绝', color: '#e53935' };
  if (local.permission !== 'granted') return { text: '未开启', color: 'var(--text-secondary)' };
  if (!local.https) return { text: '已开启（待 HTTPS）', color: 'var(--text-secondary)' };
  if (local.subscribed && (server?.subscriptionCount > 0 || server?.enabled)) {
    return { text: '已开启 · 后台推送', color: '#43a047' };
  }
  if (local.subscribed) return { text: '已开启 · 待同步', color: 'var(--text-secondary)' };
  return { text: '已开启 · 待订阅', color: 'var(--text-secondary)' };
}

window.refreshNotifStatus = async function() {
  const statusEls = ['notif-perm-status', 'me-notif-status']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  if (!statusEls.length) return;
  statusEls.forEach(el => {
    el.textContent = '检测中…';
    el.style.color = 'var(--text-secondary)';
  });
  const local = await getLocalPushStatus();
  let server = {};
  try { server = await api.getPushStatus(); } catch {}
  const { text, color } = formatNotifStatus(local, server);
  statusEls.forEach(el => {
    el.textContent = text;
    el.style.color = color;
  });
};

window.enableSystemNotifications = async function() {
  const r = await window.requestNotificationPermission?.();
  if (r === 'granted') {
    const sub = await ensureWebPushSubscription();
    if (sub?.ok) {
      window.showToast?.('已开启系统通知与后台推送');
    } else if (sub?.reason === 'need_https') {
      window.showToast?.('通知已开；换成 HTTPS 后自动支持 App 关闭时推送');
    } else if (sub?.reason !== 'unsupported') {
      window.showToast?.(pushSubscribeHint(sub.reason));
    } else {
      window.showToast?.('通知权限已开');
    }
  } else if (r === 'denied') {
    window.showToast?.(window.isNativeShell?.()
      ? '通知权限被拒绝，请到通讯 › 我 › 权限里打开'
      : '通知权限被拒绝，请在浏览器设置中允许');
  } else if (r === 'unsupported') {
    window.showToast?.('当前浏览器不支持系统通知');
  }
  await window.refreshNotifStatus?.();
};

window.testWebPushNotification = async function() {
  const el = document.getElementById('push-test-result') || document.getElementById('me-push-test-result');
  if (el) {
    el.textContent = '发送中…';
    el.style.color = 'var(--text-secondary)';
  }
  try {
    if (Notification.permission !== 'granted') {
      const perm = await window.requestNotificationPermission();
      if (perm !== 'granted') throw new Error('请先开启通知权限');
    }
    const sub = await ensureWebPushSubscription();
    if (!sub.ok) {
      if (sub.reason === 'need_https') throw new Error('Web Push 需要 HTTPS 环境');
      if (sub.reason !== 'unsupported') throw new Error(pushSubscribeHint(sub.reason) || '推送订阅失败');
    }
    await testWebPush();
    if (el) el.innerHTML = '<span style="color:#43a047">✓ 已发送，请切到后台查看</span>';
    window.showToast?.('测试推送已发送，请切到后台或关闭 App');
  } catch (e) {
    if (el) el.innerHTML = `<span style="color:#e53935">${e.message}</span>`;
    window.showToast?.(e.message);
  }
  await window.refreshNotifStatus?.();
};

async function initWebPushSubscription() {
  if (Notification.permission !== 'granted') return;
  try {
    await ensureWebPushSubscription();
  } catch (e) {
    console.warn('[push] init failed', e);
  }
}

function hideAppSplash() {
  if (typeof window.__nianDismissSplash === 'function') {
    window.__nianDismissSplash();
    return;
  }
  const el = document.getElementById('app-splash');
  if (!el || el.classList.contains('is-hiding') || el.classList.contains('is-hidden')) return;
  el.classList.add('is-hiding');
  setTimeout(() => {
    el.classList.add('is-hidden');
    setTimeout(() => el.remove(), 1600);
  }, 1450);
}

/** 开屏不阻塞在 init/网络：至少 3.2s，最多 5.6s 必关 */
function scheduleSplashHide(startMs) {
  const MIN = 3200;
  const MAX = 5600;
  setTimeout(hideAppSplash, Math.max(0, MIN - (Date.now() - startMs)));
  setTimeout(hideAppSplash, MAX);
}

function handleDeepLinkFromUrl() {
  const params = new URLSearchParams(location.search);
  const open = params.get('open');
  const char = params.get('char');
  if (open === 'chat' && char) {
    setActiveCharId?.(char);
    navigateTo('chat');
    history.replaceState(null, '', location.pathname);
  } else if (open === 'moments') {
    navigateTo('moments');
    history.replaceState(null, '', location.pathname);
  } else if (open === 'diary' && char) {
    setActiveCharId?.(char);
    navigateTo('diary');
    history.replaceState(null, '', location.pathname);
  }
}

// 判断聊天页面是否对当前角色可见（必须是当前导航页，不能只看残留 class / 上次打开的角色）
window.isChatPageActiveFor = function(charId) {
  if (pageHistory[pageHistory.length - 1] !== 'chat') return false;
  if (_lastPageName !== 'chat') return false;
  const chatPage = document.getElementById('chat-page');
  if (!chatPage?.classList.contains('active')) return false;
  const target = Number(charId);
  if (!Number.isFinite(target)) return false;
  const viewId = window.getChatPageViewCharId?.();
  if (viewId != null && viewId !== '') return Number(viewId) === target;
  return Number(window.getActiveCharId?.()) === target;
};

window.dismissChatNotificationsFor = function(charId) {
  const target = Number(charId);
  for (let i = _notifQueue.length - 1; i >= 0; i--) {
    if (Number(_notifQueue[i].charId) === target) _notifQueue.splice(i, 1);
  }
  const banner = document.getElementById('chat-notification-banner');
  if (banner && Number(banner.dataset.charId) === target) {
    clearTimeout(banner._timer);
    banner.classList.remove('is-visible', 'is-dismissing', 'is-dragging');
    resetChatNotifBannerStyle(banner);
    banner.style.display = 'none';
    _notifShowing = false;
    _showNextNotif();
  }
};

// ===== 初始化（异步，不影响同步交互） =====
function bootstrapHomeUI() {
  startClock();
  updatePageLayers('home');
  showPage('home');
  try { initHomeDesktop(); } catch (e) { console.warn('[bootstrap] initHomeDesktop', e); }
  try { applyBackground(); } catch (e) { console.warn('[bootstrap] applyBackground', e); }
}

async function init() {
  const splashStart = Date.now();
  scheduleSplashHide(splashStart);
  bootstrapHomeUI();

  initKeyboardAvoidance();
  // APK：等 Capacitor bridge，再连自建后端；不注册 SW
  await waitForNativeBridge();
  if (isNativeShell()) document.documentElement.classList.add('native-shell');
  if (isNativeShell()) {
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      if (regs?.length) await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches?.keys?.();
      if (keys?.length) await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
  }
  await ensureServerConfigured();
  if (isNativeShell()) installNativeMediaRewriter();
  if (isNativeShell()) {
    try { await promptBasicNativePermissionsOnce(); } catch (e) { console.warn('[perms]', e); }
    try { startPhoneNotificationSync(); } catch (e) { console.warn('[phone-notify]', e); }
    try {
      window.Capacitor?.Plugins?.App?.addListener?.('appStateChange', ({ isActive }) => {
        window._nianAppBackground = !isActive;
        if (isActive) {
          hideNativeCapsule().catch(() => {});
          try { window.__nianReconcileCall?.(); } catch {}
        }
      });
    } catch {}
    setTimeout(() => {
      promptAppUpdateIfNeeded().catch((e) => console.warn('[update]', e));
    }, 4000);
  }

  if (!isNativeShell() && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      setupServiceWorkerUpdates(reg);
      initWebPushSubscription();
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'notification_open') {
          if (e.data.open === 'call' && e.data.charId) {
            window.answerIncomingCallFromNative?.({
              characterId: e.data.charId,
              content: e.data.content || '',
            });
          } else if (e.data.charId) {
            setActiveCharId(e.data.charId);
            navigateTo('chat');
          } else if (e.data.open === 'moments') {
            navigateTo('moments');
          } else if (e.data.open === 'diary' && e.data.charId) {
            setActiveCharId(e.data.charId);
            navigateTo('diary');
          }
        } else if (e.data?.type === 'sw_updated') {
          showToast('发现新版本，请关闭后重新打开应用', 6000);
        }
      });
    }).catch(() => {});
  }
  initOfflineBanner();
  watchSystemColorScheme();
  const siteOk = await ensureSiteAccess();
  if (!siteOk) return;
  try {
    // 设置和角色列表互不依赖，并行拉取而不是串行等待，减少「进入」耗时
    await Promise.all([loadSettings(), loadCharacters()]);
    installMediaCacheResolver();
    startChatArchiveSync(characters);
    applyTheme();
    applyBackground();
    applyThemeBackground();
    applyNavButtonStyle();
    applyBeautifySettings();
    applyPwaIcon(getPwaIcon());
    connectWS();
    handleDeepLinkFromUrl();
    _shareIntakeReady = true;
    if (_pendingNativeShare) {
      const pending = _pendingNativeShare;
      _pendingNativeShare = null;
      void handleNativeShare(pending);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        recheckSiteAccessOnVisible();
        syncUnreadCounts().catch(() => {});
        syncMomentsUnread().catch(() => {});
        initWebPushSubscription();
        ensureWSConnected();
        if (isHomeActive()) resumeHomeMedia();
        // 从别的 App 回来时 WebView 网络常还没醒，立刻探活容易误报
        setTimeout(() => {
          if (document.visibilityState !== 'visible') return;
          api.checkBackendHealth().then(ok => {
            if (!ok) showToast(api.explainBackendUnreachable(), 5000);
          }).catch(() => {});
        }, 1600);
      } else {
        pauseHomeMedia();
      }
    });
    window.addEventListener('nian-needs-auth', () => {
      bindSiteLockForm();
      showSiteLockOverlay(true);
    });
    // 启动后分批预加载各页模块，避免点进功能才现拉 JS
    const prefetchAllPages = () => {
      void loadPageModule('chat');
      Object.keys(PAGE_LOADERS).forEach((name, i) => {
        if (name === 'chat') return;
        setTimeout(() => { void loadPageModule(name); }, 80 + i * 80);
      });
    };
    prefetchAllPages();
    window.__nianBootOk = true;
    if (isNativeShell()) {
      setTimeout(() => {
        void loadPageModule('chat').then(() => {
          try { window.__nianReconcileCall?.(); } catch {}
        });
      }, 600);
    }
  } catch (e) {
    console.error('[init] error', e);
    try { applyBackground(); } catch (_) {}
  }
}

// ===== 加载设置 =====
async function loadSettings() {
  try {
    settings = await api.getSettings();
    const localPwa = getPwaIcon();
    const remotePwa = settings.pwa_icon || '';
    if (remotePwa) {
      savePwaIcon(remotePwa);
    } else if (localPwa) {
      settings.pwa_icon = localPwa;
      api.saveSettings({ ...settings, pwa_icon: localPwa }).catch(() => {});
    }
    applyThemeFromSettings();
    try {
      const { loadCustomFonts } = await import('./custom-fonts.js');
      await loadCustomFonts();
    } catch (fe) {
      console.warn('[fonts] load failed', fe);
    }
    try {
      const { applyAppFont } = await import('./diary-paper.js');
      applyAppFont();
    } catch (fe) {
      console.warn('[fonts] apply app font', fe);
    }
  } catch(e) { console.warn('[settings] load failed', e); }
}

function applyThemeFromSettings() {
  const color = settings.theme_color || '#c9a0dc';
  applyThemePreview(color);
  applyColorScheme();
  applyThemeBackground();
}

function applyColorScheme(scheme) {
  const mode = scheme ?? settings.color_scheme ?? 'auto';
  let resolved = mode;
  if (mode === 'auto') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-color-scheme', resolved === 'dark' ? 'dark' : 'light');
  // 深浅色切换时同步状态栏/顶栏同色
  if (_lastPageName) updatePageLayers(_lastPageName);
}

window.applyColorSchemePreview = applyColorScheme;

let _colorSchemeMq;
function watchSystemColorScheme() {
  if (_colorSchemeMq) return;
  _colorSchemeMq = window.matchMedia('(prefers-color-scheme: dark)');
  _colorSchemeMq.addEventListener('change', () => {
    if ((settings.color_scheme || 'auto') === 'auto') applyColorScheme();
  });
}

function initOfflineBanner() {
  // 不用顶栏 #offline-banner，改成念同款 system-notify
  const offlineBanner = document.getElementById('offline-banner');
  if (offlineBanner) offlineBanner.classList.remove('is-visible');

  let probeSeq = 0;
  let failStreak = 0;
  let offlineShown = false;
  const OFFLINE_MSG = '网络已断开，部分功能可能不可用';

  const setOffline = (offline) => {
    if (offline) {
      if (!offlineShown) {
        offlineShown = true;
        showSystemNotify(OFFLINE_MSG, 0);
      } else {
        // 仍离线时刷新文案并保持常显（避免被其它 notify 盖掉后回不来）
        const el = document.getElementById('system-notify-banner');
        if (el && el.style.display === 'none') showSystemNotify(OFFLINE_MSG, 0);
      }
      return;
    }
    if (offlineShown) {
      offlineShown = false;
      const el = document.getElementById('system-notify-banner');
      if (el && el.textContent === OFFLINE_MSG) hideSystemNotify();
    }
  };

  const probeBackend = async () => {
    if (isNativeShell() && !getServerBase()) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(resolveApiUrl('/api/health'), {
        cache: 'no-store',
        credentials: 'include',
        signal: ctrl.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const update = async () => {
    // 系统 offline / navigator.onLine 只能当线索：本机 localhost、局域网、
    // Windows 休眠唤醒时经常误报断开，聊天 HTTP 其实还通。
    if (isNativeShell() && !getServerBase()) {
      setOffline(false);
      return;
    }
    const seq = ++probeSeq;
    const ok = await probeBackend();
    if (seq !== probeSeq) return;
    if (ok) {
      failStreak = 0;
      setOffline(false);
      return;
    }
    failStreak += 1;
    if (failStreak >= 2) setOffline(true);
  };

  const markReachable = () => {
    failStreak = 0;
    setOffline(false);
  };
  window.noteBackendReachable = markReachable;

  window.addEventListener('online', () => { failStreak = 0; update(); });
  window.addEventListener('offline', update);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(update, 1200);
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') update();
  }, 20000);
  update();
}

function showSiteLockOverlay(show) {
  const el = document.getElementById('site-lock-overlay');
  if (!el) return;
  el.classList.toggle('is-visible', !!show);
  el.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function bindSiteLockForm() {
  const btn = document.getElementById('site-lock-submit');
  const userEl = document.getElementById('site-lock-user');
  const passEl = document.getElementById('site-lock-pass');
  const errEl = document.getElementById('site-lock-error');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';

  const submit = async () => {
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = '验证中…';
    try {
      await api.siteAuthLogin(userEl.value.trim(), passEl.value.trim());
      passEl.value = '';
      showSiteLockOverlay(false);
      window.__nianSiteLockResolve?.(true);
    } catch (e) {
      errEl.textContent = e.message || '验证失败';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = '进入';
    }
  };

  btn.addEventListener('click', submit);
  passEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  userEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') passEl?.focus(); });
}

/** 站点锁：同一浏览器会话有效（默认不绑 IP）；换浏览器才需重登 */
async function ensureSiteAccess() {
  try {
    const st = await api.getSiteAuthStatus();
    if (!st.enabled || st.authenticated) return true;
    bindSiteLockForm();
    showSiteLockOverlay(true);
    document.getElementById('site-lock-user')?.focus();
    return await new Promise((resolve) => {
      window.__nianSiteLockResolve = resolve;
    });
  } catch (e) {
    console.warn('[site-lock] status check failed', e);
    return true;
  }
}

async function recheckSiteAccessOnVisible() {
  try {
    const st = await api.getSiteAuthStatus();
    if (st.enabled && st.needsAuth) {
      bindSiteLockForm();
      showSiteLockOverlay(true);
    }
  } catch { /* ignore */ }
}

function setupServiceWorkerUpdates(reg) {
  const activateWaiting = () => {
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  };
  reg.update().catch(() => {});
  if (reg.waiting) activateWaiting();
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) activateWaiting();
    });
  });
  setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  let hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    initWebPushSubscription();
    // 首次安装不刷；从旧 SW 切到新 SW 时强制刷新，避免网页卡在旧 chat-page（无小黄豆）
    if (!hadController) {
      hadController = true;
      return;
    }
    if (reloaded) return;
    reloaded = true;
    try { location.reload(); } catch { /* ignore */ }
  });
}

window.applyThemePreview = applyThemePreview;
function applyThemePreview(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--theme', color);
  const r = parseInt(color.slice(1, 3), 16) || 201;
  const g = parseInt(color.slice(3, 5), 16) || 160;
  const b = parseInt(color.slice(5, 7), 16) || 220;
  document.documentElement.style.setProperty('--theme-light', `rgba(${r},${g},${b},0.2)`);
  document.documentElement.style.setProperty('--theme-dark', `rgb(${Math.max(0,r-40)},${Math.max(0,g-40)},${Math.max(0,b-40)})`);
  // 状态栏始终系统黑底，不跟主题/顶栏变
  ensureSystemStatusBarTheme();
  syncNativeStatusBar(_lastPageName);
}

function buildThemeGradientForSettings() {
  const theme = settings.theme_color || '#c9a0dc';
  const preset = resolveGradientPreset(settings.theme_bg_type, settings.theme_bg_value);
  return buildThemeGradient(theme, preset);
}

function pageChromeBackground() {
  const dark = document.documentElement.getAttribute('data-color-scheme') === 'dark';
  return dark ? '#1a1520' : (CHROME_BAR_LIGHT || '#ededed');
}

function applyThemeBackground() {
  const el = document.getElementById('theme-bg');
  if (!el) return;
  const type = settings.theme_bg_type || 'gradient';
  const value = settings.theme_bg_value || '';
  // 全局底色默认白（开屏除外）；渐变/纯色主题底不再铺紫
  const chrome = pageChromeBackground();

  el.style.background = 'none';
  el.style.backgroundColor = 'transparent';
  if (type === 'image' && value) {
    const cssUrl = window.cssMediaUrl?.(value) || `url("${String(value).replace(/"/g, '\\"')}")`;
    el.style.background = `${cssUrl} center/cover no-repeat`;
    el.style.backgroundColor = chrome;
  } else {
    el.style.background = chrome;
  }
  // html/body 底色由 updatePageLayers 管（白顶栏页用白/深色实底）。
  document.body.classList.toggle('theme-bg-image', type === 'image' && !!value);
}

function applyNavButtonStyle() {
  let transparency = parseInt(localStorage.getItem('beautify_nav_transparency') ?? '', 10);
  if (Number.isNaN(transparency)) {
    const legacy = parseInt(localStorage.getItem('beautify_nav_opacity') || '14', 10);
    transparency = Math.max(0, Math.min(100, 100 - legacy));
    localStorage.setItem('beautify_nav_transparency', String(transparency));
  }
  const radius = parseInt(localStorage.getItem('beautify_nav_radius') || '28', 10);
  const fullyTransparent = transparency >= 100;
  document.documentElement.classList.toggle('home-nav-transparent', fullyTransparent);
  const glassAlpha = fullyTransparent ? 0 : ((100 - transparency) / 100) * 0.62;
  const borderAlpha = fullyTransparent ? 0 : Math.min(0.52, glassAlpha + 0.12);
  document.documentElement.style.setProperty('--home-nav-glass-alpha', String(Math.max(0, glassAlpha)));
  document.documentElement.style.setProperty('--home-nav-border-alpha', String(Math.max(0, borderAlpha)));
  document.documentElement.style.setProperty('--home-nav-blur', fullyTransparent ? '0px' : '24px');
  document.documentElement.style.setProperty('--home-nav-saturate', fullyTransparent ? '100%' : '180%');
  document.documentElement.style.setProperty('--home-nav-radius', `${Math.min(28, Math.max(0, radius))}px`);
  // 图标圆角：0→方角，28→接近圆形
  const iconPct = Math.min(50, Math.max(8, 8 + radius * (42 / 28)));
  document.documentElement.style.setProperty('--home-ios-icon-radius', `${iconPct}%`);
  const gap = parseInt(localStorage.getItem('beautify_nav_gap') || '10', 10);
  document.documentElement.style.setProperty('--home-nav-gap', `${Math.min(28, Math.max(4, gap))}px`);
  document.documentElement.style.setProperty('--home-side-nav-gap', `${Math.min(16, Math.max(2, Math.round(gap * 0.5)))}px`);

  // 底栏胶囊：独立圆角 / 透明度
  let dockTransparency = parseInt(localStorage.getItem('beautify_dock_transparency') ?? '', 10);
  if (Number.isNaN(dockTransparency)) dockTransparency = 20;
  dockTransparency = Math.max(0, Math.min(100, dockTransparency));
  let dockRadius = parseInt(localStorage.getItem('beautify_dock_radius') ?? '', 10);
  if (Number.isNaN(dockRadius)) dockRadius = 36;
  dockRadius = Math.max(0, Math.min(48, dockRadius));
  const dockClear = dockTransparency >= 100;
  document.documentElement.classList.toggle('home-dock-transparent', dockClear);
  const dockGlass = dockClear ? 0 : ((100 - dockTransparency) / 100) * 0.55;
  const dockBorder = dockClear ? 0 : Math.min(0.55, dockGlass + 0.14);
  document.documentElement.style.setProperty('--home-dock-glass-alpha', String(Math.max(0, dockGlass)));
  document.documentElement.style.setProperty('--home-dock-border-alpha', String(Math.max(0, dockBorder)));
  document.documentElement.style.setProperty('--home-dock-radius', `${dockRadius}px`);
}

function resolveBgOverlay() {
  const overlay = settings.bg_overlay;
  if (overlay) return overlay;
  if (settings.bg_particles_enabled === '1') return 'particles';
  return 'none';
}

function ensureWaterDroplets(el) {
  let layer = el.querySelector('.droplet-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'droplet-layer';
    el.appendChild(layer);
  }
  if (layer.childElementCount > 0) return;

  // Small-to-medium droplets (4–9 px)
  for (let i = 0; i < 20; i++) {
    const d = document.createElement('div');
    d.className = 'water-droplet';
    d.style.left = `${2 + Math.random() * 96}%`;
    d.style.top  = `${Math.random() * 75}%`;
    const size = 4 + Math.random() * 5;
    d.style.width  = `${size}px`;
    d.style.height = `${size}px`;
    d.style.setProperty('--dur',   `${22 + Math.random() * 14}s`);
    d.style.setProperty('--delay', `${Math.random() * 24}s`);
    layer.appendChild(d);
  }
  // Larger "merged" droplets (9–16 px) — fewer, more spread
  for (let i = 0; i < 6; i++) {
    const d = document.createElement('div');
    d.className = 'water-droplet';
    d.style.left = `${5 + Math.random() * 90}%`;
    d.style.top  = `${10 + Math.random() * 60}%`;
    const size = 9 + Math.random() * 7;
    d.style.width  = `${size}px`;
    d.style.height = `${size}px`;
    d.style.setProperty('--dur',   `${26 + Math.random() * 16}s`);
    d.style.setProperty('--delay', `${Math.random() * 20}s`);
    layer.appendChild(d);
  }
}

function ensureMistWisps(el, strength) {
  let layer = el.querySelector('.mist-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'mist-layer';
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    el.appendChild(layer);
  }
  layer.style.setProperty('--overlay-strength', String(strength));
  if (layer.childElementCount > 0) return;
  for (let i = 0; i < 8; i++) {
    const w = document.createElement('div');
    w.className = 'mist-wisp';
    const size = 80 + Math.random() * 140;
    w.style.width = `${size}px`;
    w.style.height = `${size * 0.55}px`;
    w.style.left = `${Math.random() * 100}%`;
    w.style.animationDelay = `${Math.random() * 20}s`;
    w.style.animationDuration = `${24 + Math.random() * 20}s`;
    layer.appendChild(w);
  }
}

function applyDesktopOverlay(overlay, amount) {
  const el = document.getElementById('desktop-overlay');
  if (!el) return;
  const amt = Math.min(100, Math.max(0, parseInt(amount ?? settings.bg_overlay_amount ?? '50', 10))) / 100;
  el.className = 'desktop-overlay';
  el.querySelector('.droplet-layer')?.remove();
  el.querySelector('.mist-layer')?.remove();

  const bgType = settings.bg_type || getBgSettings()?.type || 'particle';
  // 图片壁纸上 backdrop-filter 极吃性能，改用轻量半透明罩
  const lite = bgType === 'image' || window._bPendingBgType === 'image';

  if (overlay === 'mist') {
    el.classList.add('is-mist');
    el.style.setProperty('--overlay-strength', String(amt));
    ensureMistWisps(el, amt);
  } else if (overlay === 'glass') {
    el.classList.add('is-glass');
    if (lite) el.classList.add('is-lite');
    el.style.setProperty('--glass-clarity', String(amt));
  } else if (overlay === 'frosted') {
    el.classList.add('is-frosted');
    if (lite) el.classList.add('is-lite');
    el.style.setProperty('--frost-clarity', String(amt));
    if (!lite) ensureWaterDroplets(el);
  }
}

function parseBgCrop() {
  // 图片壁纸上传时已裁切导出，不再叠加 CSS crop（旧数据里残留的 crop 会错位）
  if (settings.bg_type === 'image') return null;
  try {
    const raw = settings.bg_crop;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

window.setThemeBgPreview = function(type, value, themeColor) {
  const el = document.getElementById('theme-bg');
  if (!el) return;
  const chrome = pageChromeBackground();
  el.style.background = 'none';
  el.style.backgroundColor = 'transparent';
  if (type === 'image' && value) {
    const cssUrl = window.cssMediaUrl?.(value) || `url("${String(value).replace(/"/g, '\\"')}")`;
    el.style.background = `${cssUrl} center/cover no-repeat`;
    el.style.backgroundColor = chrome;
  } else if (type === 'color' && value) {
    // 美化页实时预览仍可看纯色；正式应用见 applyThemeBackground（默认白）
    el.style.background = value;
  } else if (type === 'gradient') {
    const theme = themeColor || settings.theme_color || '#c9a0dc';
    const preset = resolveGradientPreset('gradient', value);
    el.style.background = buildThemeGradient(theme, preset);
  } else {
    el.style.background = chrome;
  }
};

// ===== 加载角色 =====
async function loadCharacters() {
  try {
    characters = await api.getCharacters();
    activeCharId = getActiveCharId();
    if (!activeCharId && characters.length > 0) {
      activeCharId = characters[0].id;
      setActiveCharId(activeCharId);
    }
    renderHomeChar();
    try {
      syncNativeHaloCharacter(getActiveChar());
    } catch {}
    // 未读角标不影响首屏渲染，不阻塞启动链路
    syncUnreadCounts().catch(() => {});
    syncMomentsUnread().catch(() => {});
  } catch(e) { console.warn('[characters] load failed', e); }
}

function getActiveChar() {
  return characters.find(c => c.id === activeCharId) || characters[0] || null;
}

function renderHomeChar() {
  const char = getActiveChar();
  const nameEls = document.querySelectorAll('.home-char-name');
  const avatarEls = document.querySelectorAll('.home-char-avatar');
  const avatarPhs = document.querySelectorAll('.home-char-avatar-placeholder');
  const locTexts = document.querySelectorAll('.home-char-status-text');
  const dotEls = document.querySelectorAll('.home-status-dot');
  const moodEls = document.querySelectorAll('.home-char-mood');

  if (!char) {
    nameEls.forEach(el => { el.textContent = '点击设置角色'; });
    locTexts.forEach(el => { el.textContent = ''; });
    moodEls.forEach(el => { el.style.display = 'none'; });
    dotEls.forEach(el => { el.style.display = 'none'; });
    avatarEls.forEach(el => { el.style.display = 'none'; el.dataset.avatarSrc = ''; });
    avatarPhs.forEach(el => { el.style.display = 'flex'; });
    return;
  }

  nameEls.forEach(el => { el.textContent = char.name; });

  if (char.avatar) {
    const cacheBust = char.avatar + (char.avatar.includes('?') ? '&' : '?') + '_t=' + Date.now();
    avatarEls.forEach(el => {
      if (el.dataset.avatarSrc !== char.avatar) {
        el.src = cacheBust;
        el.dataset.avatarSrc = char.avatar;
        el.onerror = () => {
          el.style.display = 'none';
          const ph = el.closest('.home-char-avatar-wrap')?.querySelector('.home-char-avatar-placeholder');
          if (ph) ph.style.display = 'flex';
        };
      }
      el.style.display = 'block';
    });
    avatarPhs.forEach(el => { el.style.display = 'none'; });
  } else {
    avatarEls.forEach(el => { el.style.display = 'none'; el.dataset.avatarSrc = ''; });
    avatarPhs.forEach(el => { el.style.display = 'flex'; });
  }

  const lastSeen = Date.parse(String((window.getAppSettings?.() || {}).robot_device_last_seen || ''));
  const robotOnline = Number.isFinite(lastSeen) && (Date.now() - lastSeen < 180 * 1000);
  const operating = Number(char.robot_operating) === 1 && robotOnline;
  const opMode = String(char.robot_operating_mode || '');
  const st = char.status || 'online';
  const statusLabel = operating
    ? (opMode === 'screen' ? '操作中' : '操纵中')
    : st === 'busy' ? '忙碌中' : st === 'offline' ? '离线' : '在线';
  dotEls.forEach(el => {
    el.className = `status-dot home-status-dot ${operating ? 'status-operating' : st === 'busy' ? 'status-busy' : st === 'offline' ? 'status-offline' : 'status-online'}`;
    el.style.display = 'block';
  });

  const loc = String(char.present_location || '').trim();
  let mood = String(char.mood || '').trim();
  if (/^忙碌中/.test(mood)) mood = mood.replace(/^忙碌中/, '有点忙').trim();
  if (st === 'busy' && /^有点忙/.test(mood)) mood = '';
  const parts = [statusLabel, loc, mood].filter(Boolean);
  const sub = parts.join(' · ');
  locTexts.forEach(el => { el.textContent = sub; });
  moodEls.forEach(el => { el.style.display = 'none'; });
}

// ===== 时钟 =====
let _lastHomeClockKey = '';
function tickHomeClock() {
  const now = new Date();
  tickWidgetClocks();
  const key = `${now.getHours()}:${now.getMinutes()}`;
  if (key === _lastHomeClockKey) return;
  _lastHomeClockKey = key;
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const weeks = ['周日','周一','周二','周三','周四','周五','周六'];
  const dateLine = `${now.getMonth()+1}月${now.getDate()}日`;
  const week = weeks[now.getDay()];
  const dateStr = `${dateLine} ${week}`;
  document.querySelectorAll('.home-clock').forEach(el => { el.textContent = `${h}:${m}`; });
  document.querySelectorAll('.home-date').forEach(el => {
    const host = el.closest('[data-clock-style]');
    const style = host?.getAttribute('data-clock-style') || 'classic';
    if (style === 'poster' && el.classList.contains('hw-clock-poster-date')) el.textContent = week;
    else if (style === 'poster') el.textContent = dateLine;
    else if (style === 'minimal') { /* no date */ }
    else el.textContent = dateStr;
  });
}
window.tickHomeClock = tickHomeClock;

function startClock() {
  _lastHomeClockKey = '';
  tickHomeClock();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!document.getElementById('home-page')?.classList.contains('active')) return;
    tickHomeClock();
  }, 1000);
}

// ===== 背景 =====

function safeResetBgMedia(el) {
  try { resetBgMediaEl(el); } catch (e) { console.warn('[bg-media] reset failed', e); }
}

function safeSetupBgVideo(video, url, crop, opts) {
  try {
    setupBgVideo(video, url, crop, opts);
  } catch (e) {
    console.warn('[bg-video] setup failed', e);
    if (video) video.style.display = 'none';
  }
}

function applyBackground() {
  const bg = getBgSettings();
  const bgType = settings.bg_type || bg.type || 'particle';
  const bgValue = settings.bg_value || bg.value || '';
  const overlay = resolveBgOverlay();

  const canvas = document.getElementById('particle-canvas');
  const video = document.getElementById('bg-video');
  const image = document.getElementById('bg-image');

  if (canvas) canvas.style.display = 'none';
  if (video) { video.style.display = 'none'; safeResetBgMedia(video); }
  if (image) { image.style.display = 'none'; safeResetBgMedia(image); }

  const hasWallpaper = (bgType === 'video' || bgType === 'image') && bgValue;
  const showParticles = bgType === 'particle' || (hasWallpaper && overlay === 'particles');

  if (bgType === 'video' && bgValue && video) {
    safeSetupBgVideo(video, bgValue, parseBgCrop(), { allowPlay: () => isHomeActive() });
  } else if (bgType === 'image' && bgValue && image) {
    safeSetupBgImage(image, bgValue, parseBgCrop());
  }

  if (showParticles && canvas) {
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'none';
    startParticles(canvas);
  }

  applyDesktopOverlay(['mist', 'glass', 'frosted'].includes(overlay) ? overlay : 'none', settings.bg_overlay_amount);
  document.body.classList.toggle('home-bg-image', bgType === 'image' && !!bgValue);
  if (!isHomeActive()) pauseHomeMedia();
  else resumeHomeMedia();
}

function safeSetupBgImage(img, url, crop) {
  try {
    setupBgImage(img, url, crop);
  } catch (e) {
    console.warn('[bg-image] setup failed', e);
    if (img) img.style.display = 'none';
  }
}

window.applyDesktopPreview = function(bgType, bgValue, overlay, overlayAmount) {
  const canvas = document.getElementById('particle-canvas');
  const video = document.getElementById('bg-video');
  const image = document.getElementById('bg-image');
  if (canvas) canvas.style.display = 'none';
  if (video) { video.style.display = 'none'; safeResetBgMedia(video); }
  if (image) { image.style.display = 'none'; safeResetBgMedia(image); }

  const hasWallpaper = (bgType === 'video' || bgType === 'image') && bgValue;
  const showParticles = bgType === 'particle' || (hasWallpaper && overlay === 'particles');

  if (bgType === 'video' && bgValue && video) {
    // 美化预览允许在非主页播放
    safeSetupBgVideo(video, bgValue, window._bPendingBgCrop || null, { allowPlay: true });
  } else if (bgType === 'image' && bgValue && image) {
    safeSetupBgImage(image, bgValue, window._bPendingBgCrop || null);
  }
  if (showParticles && canvas) {
    canvas.style.display = 'block';
    window.startDesktopParticles?.();
  }
  applyDesktopOverlay(['mist', 'glass', 'frosted'].includes(overlay) ? overlay : 'none', overlayAmount);
};

function startParticles(canvas) {
  if (!canvas || canvas._particlesRunning) return;
  canvas._particlesRunning = true;
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  canvas._particleResize = resize;
  window.addEventListener('resize', resize);

  const native = isNativeShell() || document.documentElement.classList.contains('native-shell');
  const particles = Array.from({ length: native ? 22 : 60 }, () => mkParticle());
  let skipFrame = false;

  function mkParticle() {
    return {
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 2.5 + 0.5,
      dx: (Math.random() - 0.5) * 0.3,
      dy: -(Math.random() * 0.4 + 0.1),
      alpha: Math.random() * 0.35 + 0.05,
      color: ['#e8d5f5','#c9a0dc','#fef0f8','#f0e6fb','#d4b8e8'][Math.floor(Math.random() * 5)],
    };
  }

  function animate() {
    if (!canvas._particlesRunning) {
      canvas._particleRaf = 0;
      return;
    }
    if (native) {
      skipFrame = !skipFrame;
      if (skipFrame) {
        canvas._particleRaf = requestAnimationFrame(animate);
        return;
      }
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.dx; p.y += p.dy;
      if (p.y < -5) { const np = mkParticle(); Object.assign(p, np); p.y = canvas.height + 5; }
      if (p.x < -5) p.x = canvas.width + 5;
      if (p.x > canvas.width + 5) p.x = -5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    canvas._particleRaf = requestAnimationFrame(animate);
  }
  canvas._particleRaf = requestAnimationFrame(animate);
}

// ===== 主题 =====
function applyTheme() {
  const color = settings.theme_color || getThemeColor();
  if (color) document.documentElement.style.setProperty('--theme', color);
}

// ===== 美化设置（localStorage） =====
function applyBeautifySettings() {
  applyNavButtonStyle();
  try { refreshHomeDesktop(); } catch {}
  // 主页文字颜色（时钟 / 角色卡 / 品牌；图标标签由 home-desktop 负责）
  try {
    const color = localStorage.getItem('beautify_home_text_color');
    if (color) {
      document.querySelectorAll('.home-clock,.home-date,.home-header-clock,.home-char-corner,.home-brand').forEach(el => {
        el.style.color = color;
      });
    }
  } catch {}
}

window.refreshHomeLabels = applyBeautifySettings;

// ===== WebSocket =====
let _wsRetryTimer = null;

function connectWS() {
  try {
    const url = getWsUrl();
    if (!url) {
      if (isNativeShell()) console.warn('[ws] 未配置服务器地址，跳过');
      return;
    }
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (_wsRetryTimer) {
      clearTimeout(_wsRetryTimer);
      _wsRetryTimer = null;
    }
    try { wsClient?.close(); } catch {}
    const ws = new WebSocket(url);
    wsClient = ws;
    ws.onopen = () => console.log('[ws] 信道已建立');
    ws.onclose = () => {
      if (wsClient === ws) wsClient = null;
      _wsRetryTimer = setTimeout(connectWS, 5000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
    ws.onmessage = (e) => {
      try { handleWSMessage(JSON.parse(e.data)); } catch {}
    };
  } catch {}
}

function ensureWSConnected() {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) return;
  if (wsClient && wsClient.readyState === WebSocket.CONNECTING) return;
  connectWS();
}
window.ensureWsConnected = ensureWSConnected;

function handleWSMessage(data) {
  switch (data.type) {
    case 'proactive_message':
      handleIncomingChatMessage(data, true);
      break;
    case 'robot_event':
    case 'mic_listening':
    case 'mic_utterance':
    case 'mic_listen_end':
    case 'mood_face':
    case 'touch_face':
      window.onRobotChatEvent?.(data);
      {
        const kind = data?.event || data?.type;
        if (kind === 'mood_face' || kind === 'touch_face') {
          window.applyRobotFacePreview?.(data);
        }
      }
      break;
    case 'background_message':
      handleIncomingChatMessage(data, true);
      break;
    case 'group_message':
    case 'group_typing':
      window.handleGroupWsMessage?.(data);
      if (data.type === 'group_message') {
        const active = window._activeGroupId && Number(data.groupId) === Number(window._activeGroupId);
        if (!active) {
          if (data.message?.role === 'assistant') window.bumpGroupUnread?.(data.groupId);
          window.refreshContactsInbox?.();
        }
      }
      break;
    case 'message_update':
      window.onMessageUpdate?.(data);
      if (!window.isChatPageActiveFor?.(Number(data.characterId))) {
        window.refreshContactsInbox?.();
      }
      break;
    case 'messages_deleted': {
      const ids = Array.isArray(data.ids) ? data.ids : [];
      if (ids.length && window.isChatPageActiveFor?.(Number(data.characterId))) {
        window.removeBubblesByMessageIds?.(ids);
      }
      if (!window.isChatPageActiveFor?.(Number(data.characterId))) {
        window.refreshContactsInbox?.();
      }
      break;
    }
    case 'ai_poke': {
      const appSettings = settings || {};
      const userName = appSettings.username || '旅人';
      const charName = data.charName || getCharName(data.characterId);
      const suffix = data.userSuffix || '肩膀';
      const pokeText = data.text || `${charName} 拍了拍 ${userName} 的${suffix}`;
      showToast(`👋 ${pokeText}`);
      if (Number(data.characterId) === Number(activeCharId)) {
        window.appendPokeHint?.(pokeText);
      }
      window.refreshContactsInbox?.();
      break;
    }
    case 'proactive_call':
      showIncomingCallUI(data);
      break;
    case 'music_control_request': {
      const action = String(data?.action || '').trim();
      if (action) {
        import('./music-sync.js').then((m) => {
          m.handleMusicControlFromAI?.(action);
        }).catch(() => {});
      }
      break;
    }
    case 'incoming_call_result':
      _incomingSettled = true;
      hideIncomingCallUI();
      _pendingIncomingCall = null;
      window.onIncomingCallResult?.(data);
      break;
    case 'peer_end': {
      // 角色主动挂断：关掉通话页；系统气泡由 onPeerEndCall 画，避免和 endCall 再插一条重复
      const cid = Number(data?.characterId);
      if (cid) {
        const activeCid = Number(window.getActiveCharId?.() || window.charId || 0);
        if (activeCid === cid) {
          try { window.hangupCallFromNative?.(); } catch {}
          try { window.endCall?.({ skipSystemTip: true }); } catch {}
        }
      }
      window.onPeerEndCall?.(data);
      break;
    }
    case 'friend_request':
      showToast('收到新的好友申请');
      window.refreshContactsInbox?.();
      if (window._contactsLastTab === 'contacts') {
        try { window.switchContactsTab?.('contacts'); } catch {}
      }
      break;
    case 'friend_request_result': {
      const ok = !!data?.accepted;
      const msg = data?.message
        || (ok ? '对方通过了你的好友申请' : '对方婉拒了你的好友申请');
      showToast(msg);
      window.refreshContactsInbox?.();
      try {
        const active = Number(window.getActiveCharId?.() || 0);
        if (active && Number(data?.characterId) === active) {
          window.initChatPage?.();
        }
      } catch {}
      break;
    }
    case 'system_notice':
      if (data.message) showSystemNotify(String(data.message), 5500);
      break;
    case 'phone_command':
      import('./phone-bridge.js').then((m) => m.handlePhoneCommand(data)).catch((e) => {
        console.warn('[phone] command', e);
      });
      break;
    case 'status_change':
      const char = characters.find(c => Number(c.id) === Number(data.characterId));
      if (char) { char.status = data.status; renderHomeChar(); }
      window.onCharStatusChange?.(data);
      break;
    case 'ai_diary':
      showSystemNotify('有新的秘密可以偷看了 📔');
      break;
    case 'ai_peeked_diary':
      showSystemNotify(`${getCharName(data.characterId)} 悄悄看了你的秘密 👀`);
      break;
    case 'secret_notes_updated':
      break;
    case 'shared_memo_updated':
      window.onSharedMemoUpdated?.(data);
      if (data?.fromAi) showSystemNotify(`${getCharName(data.characterId) || 'TA'} 在随手记里回了你`);
      break;
    case 'ta_album_updated':
      window.refreshTaAlbumIfOpen?.();
      if (document.getElementById('ta-page')?.classList.contains('active')) {
        window.initTaPage?.();
      }
      break;
    case 'ta_studio_album_updated':
      window.refreshTaStudioAlbumIfOpen?.();
      if (document.getElementById('ta-page')?.classList.contains('active')) {
        window.initTaPage?.();
      }
      break;
    case 'photostudio_job':
      window.onPhotostudioJob?.(data);
      break;
    case 'letter_updated':
      if (document.getElementById('mailbox-page')?.classList.contains('active')) {
        window.initMailboxPage?.();
      }
      if (document.getElementById('ta-page')?.classList.contains('active')) {
        window.initTaPage?.();
      }
      if (document.getElementById('postoffice-page')?.classList.contains('active')) {
        window.initPostofficePage?.();
      }
      if (data?.event === 'delivered' && data?.role === 'ai') {
        showSystemNotify(`${getCharName(data.characterId) || 'TA'} 有信到了`);
      }
      break;
    case 'post_office_updated':
      if (document.getElementById('postoffice-page')?.classList.contains('active')) {
        window.initPostofficePage?.();
      }
      if (data?.event === 'delivered') {
        const label = data?.name || '包裹';
        showSystemNotify(`${getCharName(data.characterId) || 'TA'} 签收了「${label}」`);
      }
      break;
    case 'ta_bound':
    case 'ta_unbound':
      if (document.getElementById('ta-page')?.classList.contains('active')) {
        window.initTaPage?.();
      }
      if (data.type === 'ta_unbound' && data.by === 'char') {
        showSystemNotify(`${getCharName(data.characterId) || 'TA'} 解除了 TA 绑定`);
      }
      break;
    case 'series_job':
      window.onSeriesJob?.(data);
      if (data?.message) {
        if (data.status === 'error') showToast(String(data.message));
        else showSystemNotify(String(data.message));
      }
      break;
    case 'new_moment':
      showSystemNotify(`${getCharName(data.characterId)} 发了朋友圈`);
      if (window.onNewMoment) window.onNewMoment(data);
      else noteMomentsNewPost(data);
      break;
    case 'moment_like': {
      const payload = {
        type: 'like',
        momentId: data.momentId,
        charName: data.charName || getCharName(data.charId) || 'TA',
        charAvatar: data.charAvatar || getCharAvatar(data.charId),
        charId: data.charId,
      };
      noteMomentsInteraction(payload);
      showSystemNotify(window.formatMomentNotifyText(payload));
      if (window.onMomentNotify) window.onMomentNotify(payload);
      break;
    }
    case 'moment_comment': {
      const payload = {
        type: 'comment',
        momentId: data.momentId,
        charName: data.charName || getCharName(data.charId) || 'TA',
        charAvatar: data.charAvatar || getCharAvatar(data.charId),
        charId: data.charId,
        content: data.content || '',
        isReply: !!data.isReply,
      };
      noteMomentsInteraction(payload);
      showSystemNotify(window.formatMomentNotifyText(payload));
      if (window.onMomentNotify) window.onMomentNotify(payload);
      break;
    }
    case 'schedule_updated':
      window.notifyMonitorScheduleUpdated?.(data);
      break;
    case 'character_update': {
      const cid = Number(data.characterId);
      const char = characters.find(c => Number(c.id) === cid);
      if (char && data.avatar) {
        char.avatar = data.avatar;
        renderHomeChar();
        window.onCharAvatarUpdated?.(cid, data.avatar);
      }
      if (char && data.mood != null) {
        char.mood = data.mood;
        renderHomeChar();
      }
      if (char && data.theater_active != null) {
        char.theater_active = Number(data.theater_active) ? 1 : 0;
        if (Number(window.getActiveCharId?.()) === cid) {
          window.onTheaterStateChanged?.(char.theater_active);
        }
      }
      if (char && data.robot_operating != null) {
        char.robot_operating = Number(data.robot_operating) ? 1 : 0;
        if (data.robot_operating_mode) char.robot_operating_mode = data.robot_operating_mode;
        else if (!char.robot_operating) char.robot_operating_mode = null;
        renderHomeChar();
        window.onRobotOperatingChanged?.(cid, char.robot_operating, char.robot_operating_mode);
      }
      break;
    }
    // 角色写了 [桌宠:…] 但那一下没送出去。不提示的话，聊天里看着像已经调了。
    case 'robot_will_result':
      if (!data.ok && data.text) showSystemNotify(String(data.text), 5500);
      break;
  }
}

async function handleIncomingChatMessage(data, allowOnChatPage = false) {
  const cid = Number(data.characterId);
  const isActive = window.isChatPageActiveFor?.(cid);
  if (isActive) {
    if (allowOnChatPage) {
      if (typeof window.onProactiveMessage === 'function') {
        window.onProactiveMessage(data);
      } else {
        // 聊天模块尚未挂上 handler：先入缓存/未读，避免静默丢消息
        window.notifyIncomingChatOffPage?.(cid, data.aiMessages?.length
          ? data.aiMessages
          : [{ type: 'text', content: data.content || '新消息' }], {
          charName: getCharName(data.characterId),
          charAvatar: '',
        });
      }
    }
    return;
  }
  const chars = window.getAppCharacters?.() || [];
  const c = chars.find(x => Number(x.id) === cid);
  const charName = c?.name || getCharName(data.characterId);
  const charAvatar = c?.avatar || '';
  const msgs = data.aiMessages?.length
    ? data.aiMessages
    : [{ type: 'text', content: data.content || '新消息' }];
  const visible = msgs.filter((m) => {
    try {
      const meta = typeof m.media_meta === 'string' ? JSON.parse(m.media_meta || '{}') : (m.media_meta || {});
      return !meta.hideChat && !meta.hiddenChat && !meta.robotMic;
    } catch { return true; }
  });
  if (!visible.length) return;
  // 与 HTTP deferAiReply 去重，避免通知弹两次、角标变双倍
  window.notifyIncomingChatOffPage?.(cid, visible, { charName, charAvatar });
  syncUnreadCounts()
    .then(() => window.refreshContactsInbox?.())
    .catch(() => window.refreshContactsInbox?.());
}

function getCharName(id) {
  return characters.find(c => c.id === id)?.name || '对方';
}

function getCharAvatar(id) {
  return characters.find(c => Number(c.id) === Number(id))?.avatar || '';
}

function clearIncomingRingTimer() {
  if (_incomingRingTimer) clearTimeout(_incomingRingTimer);
  _incomingRingTimer = null;
}

let _incomingCamStream = null;
let _incomingCamFacing = 'user';
let _incomingCamOff = false;
let _incomingCamBusy = false;
let _incomingCamToken = 0;

function stopIncomingCamTracks(stream) {
  try {
    stream?.getTracks?.().forEach((t) => {
      try { t.stop(); } catch {}
    });
  } catch {}
}

function syncIncomingCamUi() {
  const overlay = document.getElementById('incoming-call-overlay');
  if (!overlay) return;
  const live = !!_incomingCamStream?.getVideoTracks?.().some((t) => t.readyState === 'live');
  overlay.classList.toggle('has-cam-preview', live && !_incomingCamOff);
  overlay.classList.toggle('is-cam-off', !!_incomingCamOff);
  overlay.classList.toggle('is-rear-cam', _incomingCamFacing === 'environment');
  const label = document.getElementById('incoming-call-cam-label');
  if (label) label.textContent = _incomingCamOff ? '摄像头关' : '摄像头开';
  const flip = document.getElementById('incoming-call-flip-btn');
  if (flip) flip.disabled = !!_incomingCamOff || !!_incomingCamBusy;
  const camBtn = document.getElementById('incoming-call-cam-btn');
  if (camBtn) camBtn.disabled = !!_incomingCamBusy;
}

function bindIncomingCamVideo(stream) {
  const vid = document.getElementById('incoming-call-cam');
  if (!vid) return;
  vid.controls = false;
  vid.removeAttribute('controls');
  vid.muted = true;
  vid.defaultMuted = true;
  vid.autoplay = true;
  vid.playsInline = true;
  vid.setAttribute('playsinline', '');
  vid.setAttribute('webkit-playsinline', '');
  vid.setAttribute('autoplay', '');
  vid.setAttribute('muted', '');
  vid.srcObject = stream || null;
  if (stream) {
    for (const t of stream.getVideoTracks?.() || []) {
      try { if (t.readyState === 'live' && !t.enabled) t.enabled = true; } catch {}
    }
    const p = vid.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
}

async function pickIncomingCamDeviceId(facing, excludeId = '') {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return '';
  }
  const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
  if (!cams.length) return '';
  const wantBack = facing === 'environment';
  const others = excludeId ? cams.filter((c) => c.deviceId !== excludeId) : cams;
  const pool = others.length ? others : cams;
  const labeled = pool.find((c) => {
    const l = (c.label || '').toLowerCase();
    return wantBack
      ? /back|rear|environment|world|后置|后摄/.test(l)
      : /front|user|face|前置|前摄/.test(l);
  });
  if (labeled) return labeled.deviceId;
  if (pool.length === 1) return pool[0].deviceId;
  return wantBack ? pool[pool.length - 1].deviceId : pool[0].deviceId;
}

async function openIncomingCamStream(facing, excludeId = '') {
  const want = facing === 'environment' ? 'environment' : 'user';
  const tryGet = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
  const deviceId = await pickIncomingCamDeviceId(want, excludeId);
  if (deviceId) {
    try {
      return await tryGet({
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      });
    } catch { /* facingMode */ }
  }
  try {
    return await tryGet({
      facingMode: { exact: want },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    });
  } catch {
    try {
      return await tryGet({ facingMode: want });
    } catch {
      return await tryGet(true);
    }
  }
}

async function ensureIncomingCameraPermission() {
  if (!window.isNativeShell?.()) return true;
  try {
    const s = await getAppPermissionStatus();
    if (s?.camera) return true;
    const after = await requestNativeCamera();
    return !!after?.camera;
  } catch {
    return true;
  }
}

async function startIncomingVideoPreview() {
  const token = ++_incomingCamToken;
  _incomingCamFacing = 'user';
  _incomingCamOff = false;
  syncIncomingCamUi();
  if (!navigator.mediaDevices?.getUserMedia) {
    window.showToast?.('当前环境不支持摄像头预览');
    return;
  }
  _incomingCamBusy = true;
  syncIncomingCamUi();
  try {
    await ensureIncomingCameraPermission();
    if (token !== _incomingCamToken) return;
    const stream = await openIncomingCamStream(_incomingCamFacing);
    if (token !== _incomingCamToken) {
      stopIncomingCamTracks(stream);
      return;
    }
    if (_incomingCamStream && _incomingCamStream !== stream) stopIncomingCamTracks(_incomingCamStream);
    _incomingCamStream = stream;
    bindIncomingCamVideo(stream);
    syncIncomingCamUi();
  } catch {
    if (token === _incomingCamToken) {
      window.showToast?.('无法打开摄像头预览');
      syncIncomingCamUi();
    }
  } finally {
    if (token === _incomingCamToken) {
      _incomingCamBusy = false;
      syncIncomingCamUi();
    }
  }
}

function stopIncomingVideoPreview({ keepStream = false } = {}) {
  _incomingCamToken += 1;
  _incomingCamBusy = false;
  const overlay = document.getElementById('incoming-call-overlay');
  const vid = document.getElementById('incoming-call-cam');
  if (vid) vid.srcObject = null;
  if (!keepStream) {
    stopIncomingCamTracks(_incomingCamStream);
    _incomingCamStream = null;
  }
  _incomingCamOff = false;
  _incomingCamFacing = 'user';
  overlay?.classList.remove('has-cam-preview', 'is-cam-off', 'is-rear-cam');
  syncIncomingCamUi();
}

/** 接听时拿走预览流，交给通话页继续用 */
window.takeIncomingCallCameraPrep = function() {
  const stream = _incomingCamStream;
  const facing = _incomingCamFacing;
  const camOff = !!_incomingCamOff;
  _incomingCamStream = null;
  const vid = document.getElementById('incoming-call-cam');
  if (vid) vid.srcObject = null;
  const overlay = document.getElementById('incoming-call-overlay');
  overlay?.classList.remove('has-cam-preview', 'is-cam-off', 'is-rear-cam');
  if (camOff) {
    stopIncomingCamTracks(stream);
    return { stream: null, facing, camOff: true };
  }
  return { stream, facing, camOff: false };
};

window.toggleIncomingCallCamera = async function() {
  if (_incomingCamBusy) return;
  try { window.nianHaptic?.(10); } catch {}
  if (_incomingCamOff) {
    _incomingCamOff = false;
    if (_incomingCamStream?.getVideoTracks?.().some((t) => t.readyState === 'live')) {
      bindIncomingCamVideo(_incomingCamStream);
      syncIncomingCamUi();
      return;
    }
    await startIncomingVideoPreview();
    return;
  }
  _incomingCamOff = true;
  bindIncomingCamVideo(null);
  stopIncomingCamTracks(_incomingCamStream);
  _incomingCamStream = null;
  syncIncomingCamUi();
};

window.flipIncomingCallCamera = async function() {
  if (_incomingCamBusy || _incomingCamOff) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    window.showToast?.('当前环境切不了摄像头');
    return;
  }
  try { window.nianHaptic?.(10); } catch {}
  _incomingCamBusy = true;
  syncIncomingCamUi();
  const nextFacing = _incomingCamFacing === 'environment' ? 'user' : 'environment';
  const old = _incomingCamStream;
  const oldId = old?.getVideoTracks?.()[0]?.getSettings?.()?.deviceId || '';
  const token = _incomingCamToken;
  try {
    const track = old?.getVideoTracks?.()[0];
    if (track?.applyConstraints) {
      try {
        await track.applyConstraints({ facingMode: { exact: nextFacing } });
        if (token !== _incomingCamToken) return;
        _incomingCamFacing = nextFacing;
        syncIncomingCamUi();
        return;
      } catch { /* 多数安卓要重开 */ }
    }
    stopIncomingCamTracks(old);
    _incomingCamStream = null;
    bindIncomingCamVideo(null);
    await new Promise((r) => setTimeout(r, 140));
    if (token !== _incomingCamToken) return;
    const next = await openIncomingCamStream(nextFacing, oldId);
    if (token !== _incomingCamToken) {
      stopIncomingCamTracks(next);
      return;
    }
    _incomingCamStream = next;
    _incomingCamFacing = nextFacing;
    bindIncomingCamVideo(next);
    syncIncomingCamUi();
  } catch {
    window.showToast?.('切换摄像头失败');
  } finally {
    _incomingCamBusy = false;
    syncIncomingCamUi();
  }
};

function hideIncomingCallUI() {
  clearIncomingRingTimer();
  stopCallRingtone();
  dismissNativeIncomingCall?.();
  stopIncomingVideoPreview({ keepStream: false });
  const overlay = document.getElementById('incoming-call-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('is-on', 'is-video', 'has-cam-preview', 'is-cam-off', 'is-rear-cam');
  }
  const bg = document.getElementById('incoming-call-bg');
  if (bg) bg.style.backgroundImage = '';
  // 来电页消失后，恢复消息通知 banner：清除标志 + 触发队列里堆积的消息逐条弹出
  window._nianIncomingOverlayShown = false;
  try {
    setTimeout(() => {
      try { _showNextNotif(); } catch {}
    }, 320);
  } catch {}
}

function reportIncomingCallOutcome(outcome) {
  const call = _pendingIncomingCall;
  if (!call?.characterId) return;
  api.resolveIncomingCall({
    characterId: Number(call.characterId),
    logId: Number(call.logId) || 0,
    outcome,
  }).catch(() => {});
}

function settleIncomingCall(outcome, { keepOverlay } = {}) {
  if (_incomingSettled) return null;
  _incomingSettled = true;
  const call = _pendingIncomingCall;
  if (keepOverlay) {
    clearIncomingRingTimer();
    stopCallRingtone();
    dismissNativeIncomingCall?.();
  } else {
    hideIncomingCallUI();
  }
  if (call && outcome) reportIncomingCallOutcome(outcome);
  if (outcome !== 'answered') _pendingIncomingCall = null;
  return call;
}

function presentIncomingCallUI(data) {
  _pendingIncomingCall = data;
  _incomingSettled = false;
  clearIncomingRingTimer();
  const ringMs = Number(data.ringMs) > 0 ? Number(data.ringMs) : 35000;
  _incomingRingTimer = setTimeout(() => settleIncomingCall('missed'), ringMs);
  const away = !!window._nianAppBackground || (typeof document !== 'undefined' && document.hidden);
  if (isNativeShell() && away) {
    tryShowNativeIncomingCall({
      characterId: data.characterId,
      name: data.charName || getCharName(data.characterId),
      avatar: data.charAvatar || '',
      content: data.content || '',
      ringtone: data.ringtone || '',
      logId: data.logId,
      ringMs,
      systemRing: data.useSystemRingtone != null ? !!data.useSystemRingtone : useSystemCallRingtone(),
    }).then((shown) => {
      if (shown) return;
      // 原生来电页失败时回退网页弹层，避免后台来电完全无提示
      if (_incomingSettled) return;
      if (!_pendingIncomingCall) return;
      if (data.logId && Number(_pendingIncomingCall.logId) !== Number(data.logId)) return;
      showWebIncomingCallOverlay(data);
    }).catch(() => {
      if (_incomingSettled || !_pendingIncomingCall) return;
      showWebIncomingCallOverlay(data);
    });
    return;
  }
  showWebIncomingCallOverlay(data);
}

function showWebIncomingCallOverlay(data) {
  const overlay = document.getElementById('incoming-call-overlay');
  if (!overlay) return;
  const avatar = document.getElementById('incoming-call-avatar');
  const fallback = document.getElementById('incoming-call-avatar-fallback');
  const name = document.getElementById('incoming-call-name');
  const kind = document.getElementById('incoming-call-kind');
  const bg = document.getElementById('incoming-call-bg');
  const who = data.charName || getCharName(data.characterId);
  const face = data.charAvatar || getCharAvatar(data.characterId);
  if (name) name.textContent = who;
  if (kind) kind.textContent = data.video ? '邀请你视频通话' : '邀请你语音通话';
  if (bg) bg.style.backgroundImage = face ? `url(${JSON.stringify(face)})` : '';
  if (avatar && face) {
    avatar.src = face;
    avatar.style.display = 'block';
    avatar.removeAttribute('hidden');
    if (fallback) {
      fallback.hidden = true;
      fallback.style.display = 'none';
    }
  } else {
    if (avatar) {
      avatar.removeAttribute('src');
      avatar.style.display = 'none';
      avatar.setAttribute('hidden', '');
    }
    if (fallback) {
      fallback.hidden = false;
      fallback.style.display = '';
      fallback.textContent = String(who || 'TA').trim().slice(0, 1) || 'TA';
    }
  }
  overlay.classList.toggle('is-video', !!data.video);
  overlay.classList.remove('has-cam-preview', 'is-cam-off', 'is-rear-cam');
  overlay.classList.add('is-on');
  overlay.style.display = 'flex';
  // 来电页面前不显示消息通知 banner：标记 + 立刻把正在显示的 banner 收起（队列里的仍保留）
  window._nianIncomingOverlayShown = true;
  try {
    const live = document.getElementById('chat-notification-banner');
    if (live && (live.classList.contains('is-visible') || live.style.display === 'flex')) {
      live.classList.remove('is-visible');
      live.classList.add('is-dismissing');
      setTimeout(() => {
        live.classList.remove('is-dismissing');
        live.style.display = 'none';
      }, 280);
    }
  } catch {}
  try { navigator.vibrate?.([200, 100, 200, 100, 200]); } catch {}
  playCallRingtone(data.ringtone || '', {
    system: data.useSystemRingtone != null ? !!data.useSystemRingtone : undefined,
  });
  if (data.video) {
    void startIncomingVideoPreview();
  } else {
    stopIncomingVideoPreview({ keepStream: false });
  }
}

async function showIncomingCallUI(data) {
  if (!data?.characterId) return;
  if (document.getElementById('call-screen')?.classList.contains('active')) return;
  if (_pendingIncomingCall && Number(_pendingIncomingCall.logId) === Number(data.logId) && data.logId) return;

  const token = ++_incomingShowToken;
  // 剥掉 [怎么看]/[什么感觉] 等心里话草稿，避免来电开场念/显示出来
  // 文字视频开场可能含旁白换行，不要压成一行
  const peer = characters.find((c) => Number(c.id) === Number(data.characterId));
  const textVideoOpen = !!data.video
    && String(peer?.call_video_mode || 'video').trim().toLowerCase() === 'text';
  const scrubbedRaw = stripAiContextLabels(String(data.content || ''));
  const scrubbed = textVideoOpen
    ? scrubbedRaw.replace(/\n{3,}/g, '\n\n').trim()
    : scrubbedRaw.replace(/\s+/g, ' ').trim();
  _pendingIncomingCall = { ...data, content: scrubbed };
  _incomingSettled = false;
  void loadPageModule('chat').catch(() => {});

  const opening = scrubbed;
  const hasVoice = !!(String(peer?.voice_id || '').trim() || String(peer?.voice_id_nsfw || '').trim());
  const alreadyReady = String(data.readyTtsUrl || '').trim();

  // 文字视频：只预生成引号里的台词；整段旁白不要拿去念
  const speakForTts = (() => {
    if (!textVideoOpen) return opening;
    const quotes = [];
    const re = /「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)"/g;
    let m;
    while ((m = re.exec(opening)) !== null) {
      const q = String(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
      if (q) quotes.push(q);
    }
    if (quotes.length) return quotes.join('\n');
    // 漏引号：尽量捞短口语，否则不预生成（接通后再兜底）
    const compact = opening.replace(/\s+/g, '');
    if (compact.length <= 36 && /[吗呢吧啊呀哦喂嘿嗨]/.test(compact)) return opening.slice(0, 80);
    return '';
  })();

  // 有开场白且角色配了声线：必须先生成好语音再响铃（超时仍响铃，后台补齐）
  if (speakForTts && hasVoice && !alreadyReady) {
    let url = null;
    try {
      const prefetch = prefetchTTS(speakForTts, data.characterId, { inCall: true });
      url = await Promise.race([
        prefetch,
        new Promise((resolve) => setTimeout(() => resolve('__timeout__'), INCOMING_TTS_WAIT_MS)),
      ]);
      if (url === '__timeout__') {
        // 超时：继续等完整 TTS，生成好了再弹来电（符合「语音好了再打」）
        try {
          url = await prefetch;
        } catch {
          url = null;
        }
      }
    } catch {
      url = null;
    }
    if (token !== _incomingShowToken) return;
    if (_incomingSettled) return;
    if (!_pendingIncomingCall) return;
    if (data.logId && Number(_pendingIncomingCall.logId) !== Number(data.logId)) return;
    if (url && url !== '__timeout__') _pendingIncomingCall.readyTtsUrl = url;
  } else if (alreadyReady) {
    _pendingIncomingCall.readyTtsUrl = alreadyReady;
  }

  if (token !== _incomingShowToken) return;
  if (_incomingSettled) return;
  if (!_pendingIncomingCall) return;
  if (data.logId && Number(_pendingIncomingCall.logId) !== Number(data.logId)) return;
  presentIncomingCallUI(_pendingIncomingCall);
}

window.showIncomingCallUI = showIncomingCallUI;

window.declineIncomingCall = function() {
  try { window.nianHaptic?.(12); } catch {}
  settleIncomingCall('declined');
};

window.answerIncomingCall = async function() {
  const camPrep = window.takeIncomingCallCameraPrep?.() || null;
  const call = settleIncomingCall('answered', { keepOverlay: true });
  if (!call) {
    if (camPrep?.stream) {
      try { camPrep.stream.getTracks?.().forEach((t) => t.stop()); } catch {}
    }
    return;
  }
  if (camPrep) {
    call.camStream = camPrep.stream || null;
    call.camFacing = camPrep.facing || 'user';
    call.camOff = !!camPrep.camOff;
  }
  _pendingIncomingCall = null;
  try { window.nianHaptic?.(18); } catch {}
  try { unlockAudioPlayback(); } catch {}
  // 先收起来电页（预览流已交接，不要在 hide 里停掉）
  clearIncomingRingTimer();
  stopCallRingtone();
  dismissNativeIncomingCall?.();
  const overlay = document.getElementById('incoming-call-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('is-on', 'is-video', 'has-cam-preview', 'is-cam-off', 'is-rear-cam');
  }
  const bg = document.getElementById('incoming-call-bg');
  if (bg) bg.style.backgroundImage = '';
  const camVid = document.getElementById('incoming-call-cam');
  if (camVid) camVid.srcObject = null;
  // 接听后跳转聊天页：恢复消息通知 banner 排队显示
  window._nianIncomingOverlayShown = false;
  try {
    setTimeout(() => {
      try { _showNextNotif(); } catch {}
    }, 320);
  } catch {}

  window.setActiveChar?.(call.characterId);
  void navigateTo('chat');
  if (typeof window.acceptProactiveCall !== 'function') {
    try { await loadPageModule('chat'); } catch {}
  }
  if (typeof window.acceptProactiveCall === 'function') {
    void window.acceptProactiveCall(call);
  } else {
    if (call.camStream) {
      try { call.camStream.getTracks?.().forEach((t) => t.stop()); } catch {}
    }
    window.showToast?.('接通失败，请再试一次');
  }
};

window.answerIncomingCallFromNative = function(data) {
  if (!data?.characterId) return false;
  const prev = _pendingIncomingCall;
  _pendingIncomingCall = {
    characterId: Number(data.characterId),
    logId: Number(data.logId) || prev?.logId || 0,
    charName: data.charName || prev?.charName || getCharName(data.characterId),
    charAvatar: data.charAvatar || prev?.charAvatar || '',
    content: data.content || prev?.content || '',
    readyTtsUrl: prev?.readyTtsUrl || '',
    video: !!(data.video ?? prev?.video),
  };
  window.answerIncomingCall();
  return true;
};

// ===== 对外暴露 =====
window.getAppCharacters = () => characters;
/** 日记 / 时空 / 梦境 / 游戏等：仅完整角色好友（不含摇一摇陌生人、已删、拉黑、圈子 NPC） */
window.getFriendCharacters = () => (characters || []).filter((c) => (
  c
  && Number(c.id) > 0
  && String(c.contact_status || '') === 'friend'
  && String(c.peer_status || 'ok') !== 'deleted'
  && !c.is_circle_npc
  && String(c.source || '') !== 'circle_npc'
  && !(Number(c.circle_npc_id) > 0)
));
window.isCircleNpcCharacter = (c) => !!(
  c && (c.is_circle_npc || String(c.source || '') === 'circle_npc' || Number(c.circle_npc_id) > 0)
);
/** 完整角色（排除圈子 NPC 轻量号） */
window.filterFullCharacters = (list) => (list || []).filter((c) => !window.isCircleNpcCharacter(c));
window.renderHomeChar = renderHomeChar;
window.syncCharacterStatus = function(characterId, status) {
  const id = Number(characterId);
  const char = characters.find(c => Number(c.id) === id);
  if (char) char.status = status;
  if (Number(activeCharId) === id) renderHomeChar();
};
window.getAppSettings = () => settings;
window.getActiveCharId = () => activeCharId;
window.setActiveChar = function(id) {
  activeCharId = id;
  setActiveCharId(id);
  renderHomeChar();
  try {
    const c = characters.find((x) => Number(x.id) === Number(id));
    syncNativeHaloCharacter(c || { id, name: 'TA' });
  } catch {}
};
window.openCharacterFromNative = function(id) {
  const cid = Number(id);
  if (!cid) return false;
  window.setActiveChar?.(cid);
  window.navigateTo?.('chat');
  try { window.expandCallFromNative?.(); } catch {}
  return true;
};

// ===== 系统分享到念（X / 其它 App） =====
let _shareIntakeReady = false;
let _pendingNativeShare = null;
let _shareBusy = false;

function formatNativeShareText(payload) {
  let text = String(payload?.text || '').trim();
  const subject = String(payload?.subject || '').trim();
  if (subject && text && !text.includes(subject)) text = `${subject}\n\n${text}`;
  else if (subject && !text) text = subject;
  return text;
}

function dataUrlFromBase64(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], 'share.jpg', { type: mime || 'image/jpeg' });
}

async function nativeShareMetaToFile(meta) {
  if (!meta?.path) return null;
  const mime = meta.mime || 'image/jpeg';
  const name = meta.name || 'share.jpg';
  try {
    const src = window.Capacitor?.convertFileSrc?.(meta.path);
    if (src) {
      const resp = await fetch(src);
      if (resp.ok) {
        const blob = await resp.blob();
        if (blob.size > 0) return new File([blob], name, { type: mime || blob.type || 'image/jpeg' });
      }
    }
  } catch {}
  try {
    const b64 = window.NianShare?.readFileBase64?.(meta.path);
    if (b64) return dataUrlFromBase64(b64, mime);
  } catch {}
  return null;
}

function pickShareCharacter(chars) {
  return new Promise((resolve) => {
    let overlay = document.getElementById('share-target-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'share-target-overlay';
      overlay.className = 'overlay center';
      overlay.style.zIndex = '10050';
      overlay.innerHTML = `
        <div class="modal" onclick="event.stopPropagation()" style="max-width:min(420px,92vw);width:100%">
          <div class="modal-title">分享给谁</div>
          <div class="modal-body" id="share-target-list" style="max-height:50vh;overflow:auto;padding:4px 0"></div>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost btn-sm" data-share-cancel>取消</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
    const list = overlay.querySelector('#share-target-list');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    list.innerHTML = chars.map((c) => {
      const av = c.avatar
        ? `<img src="${esc(c.avatar)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover">`
        : `<div style="width:36px;height:36px;border-radius:50%;background:rgba(127,127,127,.2);display:grid;place-items:center">✨</div>`;
      return `<button type="button" data-share-char="${Number(c.id)}" style="display:flex;align-items:center;gap:12px;width:100%;padding:10px 12px;border:0;background:transparent;text-align:left;font:inherit;color:inherit;cursor:pointer">
        ${av}<span style="font-size:16px">${esc(c.name || '角色')}</span>
      </button>`;
    }).join('');

    const done = (id) => {
      overlay.classList.remove('active');
      overlay.onclick = null;
      resolve(id);
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) done(null);
    };
    overlay.querySelector('[data-share-cancel]')?.addEventListener('click', () => done(null), { once: true });
    list.querySelectorAll('[data-share-char]').forEach((btn) => {
      btn.addEventListener('click', () => done(Number(btn.getAttribute('data-share-char'))), { once: true });
    });
    overlay.classList.add('active');
  });
}

async function resolveShareTargetCharId() {
  const chars = (window.getAppCharacters?.() || []).filter((c) => c && Number(c.id) > 0);
  if (!chars.length) return null;
  const active = Number(window.getActiveCharId?.());
  if (active && chars.some((c) => Number(c.id) === active)) return active;
  if (chars.length === 1) return Number(chars[0].id);
  return pickShareCharacter(chars);
}

async function waitForShareChatReady(charId, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof window.sendShareToChat === 'function'
      && Number(window.getChatPageViewCharId?.()) === Number(charId)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return typeof window.sendShareToChat === 'function';
}

async function handleNativeShare(payload) {
  if (_shareBusy) {
    _pendingNativeShare = payload;
    return;
  }
  _shareBusy = true;
  try {
    const text = formatNativeShareText(payload);
    const metas = Array.isArray(payload?.files) ? payload.files : [];
    if (!text && !metas.length) {
      showToast('没有可分享的内容');
      return;
    }
    const charId = await resolveShareTargetCharId();
    if (!charId) {
      showToast('已取消分享');
      return;
    }
    window.setActiveChar?.(charId);
    try {
      const hist = pageHistory;
      if (!hist.length || hist[hist.length - 1] !== 'chat') hist.push('chat');
    } catch {}
    await window.showPage?.('chat');
    const ready = await waitForShareChatReady(charId);
    if (!ready) {
      showToast('聊天页还没就绪，请再试一次');
      return;
    }
    showToast(payload?.hint === 'x' ? '正在整理 X 分享…' : '正在整理分享…');
    const files = [];
    for (const meta of metas) {
      const f = await nativeShareMetaToFile(meta);
      if (f) files.push(f);
    }
    await window.sendShareToChat({
      text,
      files,
      subject: String(payload?.subject || '').trim(),
    });
  } catch (e) {
    showToast('分享失败：' + (e.message || '未知错误'));
  } finally {
    _shareBusy = false;
    if (_pendingNativeShare) {
      const next = _pendingNativeShare;
      _pendingNativeShare = null;
      void handleNativeShare(next);
    }
  }
}

window.__nianReceiveShare = function(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!_shareIntakeReady) {
    _pendingNativeShare = payload;
    return true;
  }
  if (_shareBusy) {
    _pendingNativeShare = payload;
    return true;
  }
  void handleNativeShare(payload);
  return true;
};

window.refreshAppData = async () => {
  await loadSettings();
  await loadCharacters();
  // 同步用户头像到聊天气泡设置
  if (settings.user_avatar) {
    const cs = getChatSettings();
    if (cs.userAvatarUrl !== settings.user_avatar) {
      cs.userAvatarUrl = settings.user_avatar;
      saveChatSettings(cs);
    }
  }
  // 编辑页刚改完 call_video_mode 等字段时，聊天页 currentChar 可能还是旧对象
  try {
    const cc = window.getChatCurrentChar?.();
    if (cc?.id != null) {
      const fresh = characters.find((c) => Number(c.id) === Number(cc.id));
      if (fresh) window.patchChatCurrentChar?.(fresh);
    }
  } catch {}
  applyBackground();
  applyThemeFromSettings();
  applyNavButtonStyle();
};
window.applyBackground = applyBackground;
window.applyThemeBackground = applyThemeBackground;
window.applyNavButtonStyle = applyNavButtonStyle;
window.startDesktopParticles = function() {
  const canvas = document.getElementById('particle-canvas');
  if (canvas) startParticles(canvas);
};

// 竖着滑页面时，不要误碰到开关 / 滑条
function installControlScrollGuard() {
  const SLOP = 10;
  let startX = 0;
  let startY = 0;
  let startVal = null;
  let axis = null;
  let el = null;
  let kind = null;
  let pid = null;

  function rangeEl(t) {
    return t?.closest?.('input[type="range"]') || null;
  }
  function toggleInput(t) {
    const lab = t?.closest?.('label.toggle');
    if (lab) return lab.querySelector('input[type="checkbox"]');
    if (t?.matches?.('input[type="checkbox"]') && t.closest('.toggle')) return t;
    return null;
  }

  document.addEventListener('pointerdown', (e) => {
    const range = rangeEl(e.target);
    const tog = range ? null : toggleInput(e.target);
    if (!range && !tog) return;
    el = range || tog;
    kind = range ? 'range' : 'toggle';
    startX = e.clientX;
    startY = e.clientY;
    axis = null;
    pid = e.pointerId;
    startVal = kind === 'range' ? el.value : el.checked;
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (!el || e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (axis == null && (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP)) {
      axis = Math.abs(dy) > Math.abs(dx) * 0.85 ? 'y' : 'x';
    }
    if (axis === 'y' && kind === 'range' && el.value !== startVal) {
      el.value = startVal;
    }
  }, true);

  const finish = (e) => {
    if (!el || (e && pid != null && e.pointerId !== pid)) return;
    const cur = el;
    const k = kind;
    const val = startVal;
    const wasY = axis === 'y';
    el = null;
    kind = null;
    axis = null;
    pid = null;
    if (!wasY) return;
    if (k === 'range') {
      if (cur.value !== val) cur.value = val;
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    cur.checked = val;
    const block = (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      cur.checked = val;
    };
    cur.addEventListener('click', block, { capture: true, once: true });
    cur.addEventListener('change', block, { capture: true, once: true });
    setTimeout(() => { cur.checked = val; }, 0);
  };
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);

  document.addEventListener('input', (e) => {
    if (kind === 'range' && axis === 'y' && e.target === el && el.value !== startVal) {
      el.value = startVal;
    }
  }, true);
}

// ===== 绑定事件 =====
document.addEventListener('DOMContentLoaded', () => {
  installControlScrollGuard();
  // 异步初始化（加载设置/角色等）
  init().catch(e => {
    console.error('[init] error', e);
    bootstrapHomeUI();
    hideAppSplash();
  });
});

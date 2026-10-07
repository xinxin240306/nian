/* ===== 软键盘：把当前页钉到 visualViewport，底栏随键盘自然抬起 ===== */

let _inited = false;
let _layoutBaseline = 0;
let _pluginKb = 0;
let _focusPollTimer = 0;
let _kbOpen = false;

const INPUT_SEL = 'textarea, input[type="text"], input[type="search"], .chat-input, .compose-textarea';

function captureLayoutBaseline() {
  const vv = window.visualViewport;
  const h = Math.max(
    window.innerHeight || 0,
    document.documentElement?.clientHeight || 0,
    vv ? Math.round(vv.height + (vv.offsetTop || 0)) : 0
  );
  if (h > _layoutBaseline + 24) _layoutBaseline = h;
  else if (!_layoutBaseline) _layoutBaseline = h;
}

function isComposerFocused() {
  return !!document.activeElement?.matches?.(INPUT_SEL);
}

function getKeyboardOffset() {
  // 输入框没焦点且原生插件也没报键盘高度：不要信残留的 visualViewport
  // （切到别的 App 再回来时，WebView 经常仍是「键盘弹起」时的矮高度）
  if (!isComposerFocused() && _pluginKb < 80) return 0;
  if (_pluginKb >= 80) return _pluginKb;

  const vv = window.visualViewport;
  if (!vv) return 0;
  captureLayoutBaseline();

  const vvBottom = Math.round(vv.height + (vv.offsetTop || 0));
  const fromInner = Math.max(0, Math.round((window.innerHeight || 0) - vvBottom));
  const fromBase = Math.max(0, Math.round(_layoutBaseline - vvBottom));
  // 部分 WebView：innerHeight 已随键盘变矮，但 vv.height 仍接近全屏——用 baseline 兜底
  const fromInnerAlone = Math.max(0, Math.round((_layoutBaseline || window.innerHeight) - (window.innerHeight || 0)));
  const kb = Math.max(fromInner, fromBase, fromInnerAlone);
  return kb >= 80 ? kb : 0;
}

function unpinChatBackground() {
  const bg = document.getElementById('chat-bg');
  if (!bg) return;
  bg.style.position = '';
  bg.style.top = '';
  bg.style.left = '';
  bg.style.right = '';
  bg.style.bottom = '';
  bg.style.width = '';
  bg.style.height = '';
  bg.style.zIndex = '';
  bg.style.pointerEvents = '';
  bg.style.transform = '';
}

/** 聊天背景钉在整屏，不随页面被压矮而裁切 */
function pinChatBackground() {
  const bg = document.getElementById('chat-bg');
  if (!bg) return;
  bg.style.position = 'fixed';
  bg.style.top = '0';
  bg.style.left = '0';
  bg.style.right = '0';
  bg.style.bottom = '0';
  bg.style.width = '100%';
  bg.style.height = '100%';
  bg.style.height = `${Math.max(_layoutBaseline || 0, window.innerHeight || 0, window.screen?.height || 0)}px`;
  bg.style.zIndex = '0';
  bg.style.pointerEvents = 'none';
  bg.style.transform = 'none';
}

function scrollMessagesIn(root) {
  const area = root?.querySelector?.('#messages-area, #dream-msgs, #reader-chat-area, #call-chat-area');
  if (!area) return;
  area.style.scrollBehavior = 'auto';
  area.scrollTop = area.scrollHeight;
  area.style.removeProperty('scroll-behavior');
  requestAnimationFrame(() => {
    area.scrollTop = area.scrollHeight;
  });
}

function preScrollChatBeforeKeyboard() {
  const page = document.getElementById('chat-page');
  if (!page?.classList.contains('active')) return;
  if (typeof window.__nianJumpChatBottom === 'function') {
    window.__nianJumpChatBottom();
    return;
  }
  scrollMessagesIn(page);
}

function cancelBrowserKeyboardPan() {
  try { window.scrollTo(0, 0); } catch {}
  try { document.documentElement.scrollTop = 0; } catch {}
  try { document.body.scrollTop = 0; } catch {}
  try { window.visualViewport?.scrollTo?.(0, 0); } catch {}
}

export function resetViewportLayout(el) {
  if (!el) return;
  el.style.top = '';
  el.style.height = '';
  el.style.bottom = '';
  el.classList.remove('keyboard-open');
  el.style.removeProperty('--keyboard-offset');
  el.style.removeProperty('--chat-topbar-h');
  el.style.removeProperty('--chat-input-h');
  if (el.id === 'chat-page') unpinChatBackground();
}

export function forceResetKeyboardLayout() {
  _pluginKb = 0;
  _kbOpen = false;
  document.querySelectorAll('.page, #call-screen').forEach(resetViewportLayout);
  cancelBrowserKeyboardPan();
}

if (typeof window !== 'undefined') {
  window.__nianResetKeyboardLayout = forceResetKeyboardLayout;
}

function resolveKeyboardViewportHeight(vv, kb) {
  let height = Math.round(vv.height);
  if (_pluginKb >= 80 && _layoutBaseline) {
    height = Math.max(120, Math.round(_layoutBaseline - _pluginKb));
  } else if (height < 120 && _layoutBaseline) {
    height = Math.max(120, Math.round(_layoutBaseline - kb));
  }
  return height;
}

/** 微信式聊天：背景固定，只压矮可视区，消息区从底部顶起 */
function pinChatPageKeyboard(el, focused) {
  const vv = window.visualViewport;
  if (!vv || !el) return;

  const kb = getKeyboardOffset();
  if (kb <= 0) {
    resetViewportLayout(el);
    return;
  }

  cancelBrowserKeyboardPan();
  if (focused) preScrollChatBeforeKeyboard();

  el.style.top = '0';
  el.style.height = `${resolveKeyboardViewportHeight(vv, kb)}px`;
  el.style.bottom = 'auto';
  el.classList.add('keyboard-open');
  el.style.setProperty('--keyboard-offset', '0px');
  pinChatBackground();

  if (focused) scrollMessagesIn(el);
}

/**
 * 键盘打开时：把页面钉到 visualViewport。
 * top = offsetTop → 顶栏始终在看得见的顶部
 * height = vv.height → 页面落在键盘上方，flex 底栏自然贴底
 */
function pinToVisualViewport(el, focused) {
  const vv = window.visualViewport;
  if (!vv || !el) return;

  const kb = getKeyboardOffset();
  if (kb <= 0) {
    resetViewportLayout(el);
    return;
  }

  if (el.id === 'chat-page') {
    pinChatPageKeyboard(el, focused);
    return;
  }

  cancelBrowserKeyboardPan();

  const top = Math.round(vv.offsetTop || 0);
  const height = resolveKeyboardViewportHeight(vv, kb);

  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.bottom = 'auto';
  el.classList.add('keyboard-open');
  // 页面本身已压到键盘上方，勿再给底栏叠加 --keyboard-offset
  el.style.setProperty('--keyboard-offset', '0px');

  unpinChatBackground();

  if (focused) scrollMessagesIn(el);
}

function noteKeyboardClosed() {
  const open = getKeyboardOffset() >= 80;
  if (_kbOpen && !open) {
    try { window.dispatchEvent(new Event('nian-keyboard-hide')); } catch {}
  }
  _kbOpen = open;
}

function applyViewportLayout() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    forceResetKeyboardLayout();
    return;
  }
  noteKeyboardClosed();
  const focused = isComposerFocused();
  if (!focused) {
    _pluginKb = 0;
    forceResetKeyboardLayout();
    return;
  }

  const callScreen = document.getElementById('call-screen');
  if (callScreen?.classList.contains('active')) {
    document.querySelectorAll('.page.active').forEach(resetViewportLayout);
    pinToVisualViewport(callScreen, focused);
    return;
  }

  resetViewportLayout(callScreen);

  const page = document.querySelector('.page.active');
  if (!page) return;
  pinToVisualViewport(page, focused);
}

function startFocusPoll() {
  stopFocusPoll();
  let n = 0;
  _focusPollTimer = window.setInterval(() => {
    applyViewportLayout();
    if (++n >= 25) stopFocusPoll(); // ~1.25s，覆盖慢弹键盘
  }, 50);
}

function stopFocusPoll() {
  if (_focusPollTimer) {
    clearInterval(_focusPollTimer);
    _focusPollTimer = 0;
  }
}

function bindCapacitorKeyboard() {
  const K = window.Capacitor?.Plugins?.Keyboard;
  if (!K?.addListener) return;

  const onShow = (info) => {
    const h = Math.round(info?.keyboardHeight || 0);
    _pluginKb = h >= 80 ? h : 0;
    if (!_layoutBaseline) captureLayoutBaseline();
    applyViewportLayout();
  };
  const onHide = () => {
    _pluginKb = 0;
    applyViewportLayout();
    try { window.dispatchEvent(new Event('nian-keyboard-hide')); } catch {}
  };

  try { K.addListener('keyboardWillShow', onShow); } catch {}
  try { K.addListener('keyboardDidShow', onShow); } catch {}
  try { K.addListener('keyboardWillHide', onHide); } catch {}
  try { K.addListener('keyboardDidHide', onHide); } catch {}
}

export function initKeyboardAvoidance() {
  if (_inited) return;
  _inited = true;

  captureLayoutBaseline();
  bindCapacitorKeyboard();

  const vv = window.visualViewport;
  if (!vv) {
    document.addEventListener('focusin', (e) => {
      if (!e.target.matches?.(INPUT_SEL)) return;
      setTimeout(() => {
        e.target.scrollIntoView({ block: 'end', behavior: 'smooth' });
      }, 320);
    });
    return;
  }

  vv.addEventListener('resize', applyViewportLayout);
  vv.addEventListener('scroll', () => {
    cancelBrowserKeyboardPan();
    applyViewportLayout();
  });
  window.addEventListener('resize', applyViewportLayout);

  document.addEventListener('focusin', (e) => {
    if (!e.target.matches?.(INPUT_SEL)) return;
    if (e.target.id === 'chat-input') preScrollChatBeforeKeyboard();
    captureLayoutBaseline();
    cancelBrowserKeyboardPan();
    applyViewportLayout();
    startFocusPoll();
  }, true);

  document.addEventListener('focusout', () => {
    stopFocusPoll();
    setTimeout(applyViewportLayout, 120);
    setTimeout(applyViewportLayout, 320);
  });

  window.addEventListener('orientationchange', () => {
    _layoutBaseline = 0;
    _pluginKb = 0;
    setTimeout(() => {
      captureLayoutBaseline();
      applyViewportLayout();
    }, 250);
  });

  document.querySelectorAll('.page').forEach(resetViewportLayout);
  resetViewportLayout(document.getElementById('call-screen'));
  bindAppForegroundKeyboardReset();
  applyViewportLayout();
}

function hideNativeKeyboard() {
  try { window.Capacitor?.Plugins?.Keyboard?.hide?.(); } catch {}
}

function onAppBackgroundKeyboard() {
  hideNativeKeyboard();
  try { document.activeElement?.blur?.(); } catch {}
  forceResetKeyboardLayout();
}

function onAppForegroundKeyboard() {
  _pluginKb = 0;
  _layoutBaseline = 0;
  forceResetKeyboardLayout();
  const apply = () => {
    captureLayoutBaseline();
    applyViewportLayout();
  };
  setTimeout(apply, 60);
  setTimeout(apply, 240);
  setTimeout(apply, 520);
}

function bindAppForegroundKeyboardReset() {
  if (window.__nianKbAppBound) return;
  window.__nianKbAppBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onAppBackgroundKeyboard();
    else onAppForegroundKeyboard();
  });
  window.addEventListener('pagehide', onAppBackgroundKeyboard);
  try {
    window.Capacitor?.Plugins?.App?.addListener?.('appStateChange', ({ isActive }) => {
      if (isActive) onAppForegroundKeyboard();
      else onAppBackgroundKeyboard();
    });
  } catch {}
}

export function clearInactivePageKeyboardLayout() {
  document.querySelectorAll('.page').forEach(p => {
    if (!p.classList.contains('active')) resetViewportLayout(p);
  });
  const call = document.getElementById('call-screen');
  if (call && !call.classList.contains('active')) resetViewportLayout(call);
}

/* ===== 虚拟贴吧 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { formatTextWithInlineEmojis, openSystemEmojiOverlay } from '../inline-emoji.js';

let _view = 'home'; // setup | home | bar | thread | compose | create-bar
let _account = null;
let _bars = [];
let _bar = null;
let _threads = [];
let _thread = null;
let _posts = [];
let _searchQ = '';
let _busy = false;
let _composeBarId = 0;
let _homeSeq = 0;
let _searchTimer = null;
let _barSort = 'live';
let _pullAction = null;
let _pullLock = false;
let _pullSuppressClick = 0;
let _replyTo = null;
let _barSeq = 0;
let _threadSeq = 0;

const SNAP_KEY = 'nian_tieba_snap_v1';

const BAR_COLORS = [
  '#c9a0dc', '#74b9ff', '#fd79a8', '#fdcb6e',
  '#55efc4', '#a29bfe', '#ff7675', '#81ecec',
];

const SEARCH_ICON = `<svg class="tb-search-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

function formatWhen(iso) {
  if (!iso) return '';
  try {
    let s = String(iso).trim().replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) s += 'Z';
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) return String(iso).slice(0, 16);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    const sameYear = d.getFullYear() === now.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    const h = `${d.getHours()}`.padStart(2, '0');
    const min = `${d.getMinutes()}`.padStart(2, '0');
    return sameYear ? `${m}-${day} ${h}:${min}` : `${d.getFullYear()}-${m}-${day}`;
  } catch {
    return '';
  }
}

function avatarLetter(name) {
  return escapeHtml(String(name || '?').charAt(0));
}

function cssColor(color) {
  const c = String(color || '').trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#c9a0dc';
}

function nameColor(name) {
  const s = String(name || '');
  let n = 0;
  for (let i = 0; i < s.length; i += 1) n = (n + s.charCodeAt(i)) % BAR_COLORS.length;
  return BAR_COLORS[n];
}

function excerpt(text, n = 90) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function greetLine() {
  const h = new Date().getHours();
  let g = '你好';
  if (h < 5) g = '夜深了';
  else if (h < 11) g = '早上好';
  else if (h < 14) g = '中午好';
  else if (h < 18) g = '下午好';
  else g = '晚上好';
  const name = String(_account?.username || '').trim();
  return name ? `${g}，${name}` : g;
}

function animClass(on) {
  return on ? ' tb-anim' : '';
}

function delayStyle(on, delay, extra = '') {
  const bits = [];
  if (extra) bits.push(extra);
  if (on) bits.push(`--delay:${delay}ms`);
  return bits.length ? ` style="${bits.join(';')}"` : '';
}

function barAvatarHtml(bar, sizeClass = '') {
  const color = cssColor(bar.color);
  const cls = `tb-avatar ${sizeClass}`.trim();
  if (bar.avatar) {
    return `<div class="${cls}" style="background:${color}"><img src="${escapeHtml(bar.avatar)}" alt=""></div>`;
  }
  return `<div class="${cls}" style="background:${color}">${avatarLetter(bar.name)}</div>`;
}

function userAvatarHtml(name, avatar, color, extraClass = '') {
  const bg = color && /^var\(--[a-z0-9-]+\)$/.test(color) ? color : cssColor(color || '#c9a0dc');
  const cls = `tb-user-av ${extraClass}`.trim();
  if (avatar) {
    return `<div class="${cls}" style="background:${bg}"><img src="${escapeHtml(avatar)}" alt=""></div>`;
  }
  return `<div class="${cls}" style="background:${bg}">${avatarLetter(name)}</div>`;
}

function accountButtonHtml() {
  const name = escapeHtml(_account?.username || '账号');
  const face = _account?.avatar
    ? `<img src="${escapeHtml(_account.avatar)}" alt="">`
    : avatarLetter(_account?.username || '我');
  return `<button type="button" class="topbar-action tb-me" title="${name}" onclick="tbAccountMenu()">${face}</button>`;
}

function ensureShell() {
  const page = document.getElementById('tieba-page');
  if (!page) return null;
  if (page.dataset.shellBuilt !== 'tb-v4') {
    page.innerHTML = `
      <div class="tb-shell">
        <div class="topbar tb-topbar">
          <button type="button" class="topbar-back topbar-nav-back" id="tb-back" title="返回"></button>
          <div class="topbar-title" id="tb-title">贴吧</div>
          <div class="topbar-actions" id="tb-actions"></div>
        </div>
        <div class="tb-body scroll-area scroll-area-native" id="tb-body"></div>
        <div class="tb-composer" id="tb-composer" hidden>
          <div class="tb-reply-target" id="tb-reply-target" hidden></div>
          <div class="tb-composer-row">
            <div class="tb-composer-face" id="tb-composer-face"></div>
            <button type="button" class="tb-emoji-btn" id="tb-emoji-btn" title="小黄豆" aria-label="小黄豆">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#f6c445"/><circle cx="9" cy="10" r="1.2" fill="#5c4314"/><circle cx="15" cy="10" r="1.2" fill="#5c4314"/><path d="M8.5 14.2c1 1.4 2.2 2 3.5 2s2.5-.6 3.5-2" fill="none" stroke="#5c4314" stroke-width="1.4" stroke-linecap="round"/></svg>
            </button>
            <input class="input tb-composer-input" id="tb-reply-input" placeholder="写下这一楼…" maxlength="4000" enterkeyhint="send" />
            <button type="button" class="btn btn-primary tb-composer-send" id="tb-reply-send">盖楼</button>
          </div>
        </div>
        <div id="tb-fab-slot"></div>
      </div>
    `;
    page.dataset.shellBuilt = 'tb-v4';
    document.getElementById('tb-back')?.addEventListener('click', () => window.tbGoBack());
    document.getElementById('tb-emoji-btn')?.addEventListener('click', () => window.tbOpenEmoji());
    document.getElementById('tb-reply-send')?.addEventListener('click', () => window.tbSendReply());
    document.getElementById('tb-reply-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        window.tbSendReply();
      }
    });
  }
  return page;
}

function setTitle(text) {
  const el = document.getElementById('tb-title');
  if (el) el.textContent = text;
}

function setActions(html) {
  const el = document.getElementById('tb-actions');
  if (el) el.innerHTML = html || '';
}

function setFab(html) {
  const slot = document.getElementById('tb-fab-slot');
  if (slot) slot.innerHTML = html || '';
}

function refreshComposerFace() {
  const slot = document.getElementById('tb-composer-face');
  if (!slot) return;
  slot.innerHTML = _account
    ? userAvatarHtml(_account.username, _account.avatar, 'var(--theme)', 'tb-user-av-sm')
    : '';
}

function setComposerVisible(show) {
  const el = document.getElementById('tb-composer');
  if (el) el.hidden = !show;
  const body = document.getElementById('tb-body');
  if (body) body.classList.toggle('has-composer', !!show);
  if (show) {
    refreshComposerFace();
    setFab('');
  }
}

function showLoading() {
  setFab('');
  const body = document.getElementById('tb-body');
  if (body) body.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
}

function needsAuthError(e) {
  return !!(e?.needsTiebaAuth || /请先登录贴吧|请先设置贴吧身份/.test(String(e?.message || '')));
}

function cityMode() {
  return window.getAppSettings?.()?.tieba_city_mode === 'split' ? 'split' : 'merge';
}

function snapStore() {
  try {
    const data = JSON.parse(sessionStorage.getItem(SNAP_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function snapLoad(key) {
  return snapStore()[key] || null;
}

function snapSave(key, value) {
  try {
    const all = snapStore();
    all[key] = value;
    sessionStorage.setItem(SNAP_KEY, JSON.stringify(all));
  } catch { /* 会话缓存写满就放弃，下次进帖会重新拉取 */ }
}

function snapDropPrefix(prefix) {
  try {
    const all = snapStore();
    for (const k of Object.keys(all)) {
      if (k === prefix || k.startsWith(prefix)) delete all[k];
    }
    sessionStorage.setItem(SNAP_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

function setPullTip(text, pullPx = 0) {
  const tip = document.getElementById('tb-pull-tip');
  const scroller = document.getElementById('tb-body');
  if (!tip) return;
  tip.textContent = text || '下拉刷新';
  tip.classList.toggle('is-armed', text === '松开刷新');
  const extra = pullPx > 0 ? Math.min(40, Math.round(pullPx * 0.4)) : 0;
  tip.style.height = extra ? `${28 + extra}px` : '';
  scroller?.classList.toggle('is-pulling', extra > 0);
}

function armPull(fn) {
  _pullAction = fn;
  const body = document.getElementById('tb-body');
  if (!body || body.dataset.pullBound === 'tb2') return;
  body.dataset.pullBound = 'tb2';
  let startY = 0;
  let dy = 0;
  let tracking = false;
  let fromPointer = false;

  const atTop = () => body.scrollTop <= 1;

  const follow = (y) => {
    if (!tracking || !_pullAction) return;
    const next = y - startY;
    if (next > 8) {
      dy = next;
      setPullTip(dy > 64 ? '松开刷新' : '下拉刷新', dy);
      return true;
    }
    if (next < -12) {
      tracking = false;
      fromPointer = false;
      dy = 0;
      setPullTip('下拉刷新', 0);
    }
    return false;
  };

  const finish = () => {
    if (!tracking) return;
    const go = dy > 64 && typeof _pullAction === 'function';
    if (dy > 12) _pullSuppressClick = Date.now();
    tracking = false;
    fromPointer = false;
    dy = 0;
    if (!go) {
      setPullTip('下拉刷新', 0);
      return;
    }
    if (_pullLock) {
      setPullTip('正在刷新', 0);
      return;
    }
    _pullLock = true;
    setPullTip('正在刷新', 0);
    Promise.resolve(_pullAction()).finally(() => { _pullLock = false; });
  };

  // 手机上 pointer 下拉会被当成滚动并 pointercancel，刷新就丢了。用手势位移判断，取消也算松手。
  body.addEventListener('touchstart', (e) => {
    if (!_pullAction || _pullLock || e.touches.length !== 1 || !atTop()) {
      tracking = false;
      return;
    }
    startY = e.touches[0].clientY;
    dy = 0;
    tracking = true;
    fromPointer = false;
  }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (!tracking || fromPointer || !e.touches[0]) return;
    if (follow(e.touches[0].clientY) && e.cancelable) e.preventDefault();
  }, { passive: false, capture: true });
  body.addEventListener('touchend', () => { if (!fromPointer) finish(); });
  body.addEventListener('touchcancel', () => { if (!fromPointer) finish(); });

  body.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if ((e.pointerType === 'mouse' && e.button !== 0) || !_pullAction || _pullLock || !atTop()) return;
    startY = e.clientY;
    dy = 0;
    tracking = true;
    fromPointer = true;
  });
  body.addEventListener('pointermove', (e) => {
    if (!fromPointer || e.pointerType === 'touch') return;
    follow(e.clientY);
  });
  body.addEventListener('pointerup', () => { if (fromPointer) finish(); });
  body.addEventListener('pointercancel', () => {
    if (!fromPointer) return;
    tracking = false;
    fromPointer = false;
    dy = 0;
    setPullTip('下拉刷新', 0);
  });
  body.addEventListener('click', (e) => {
    if (Date.now() - _pullSuppressClick > 450) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

function profileDefaults() {
  const s = window.getAppSettings?.() || {};
  return {
    username: String(s.username || '').trim().slice(0, 16) || '',
    avatar: String(s.user_avatar || '').trim(),
  };
}

let _setupAvatar = '';

async function refreshMe() {
  const cached = api.getTiebaAccountCache?.() || null;
  const token = api.getTiebaToken?.() || '';
  // 有本地会话时先用缓存顶上，避免短暂网络抖动就踢回登录页
  if (token && cached?.username) _account = cached;
  try {
    const data = await api.tiebaMe();
    if (data?.loggedIn && data.account) {
      _account = data.account;
      api.setTiebaAccountCache?.(data.account);
      return;
    }
    // 服务端明确未登录：清掉失效 token
    if (token) {
      api.setTiebaToken('');
      api.setTiebaAccountCache?.(null);
    }
    _account = null;
  } catch {
    // 网络失败但本地还有身份缓存：继续用缓存进贴吧
    if (!(token && cached?.username)) _account = null;
  }
}

window.initTiebaPage = async function() {
  ensureShell();
  showLoading();
  setComposerVisible(false);
  await refreshMe();
  if (!_account) {
    _view = 'setup';
    renderSetup();
    return;
  }
  _view = 'home';
  await loadHome();
};

window.tbGoBack = function() {
  if (_view === 'compose') {
    openBar(_composeBarId || _bar?.id);
    return;
  }
  if (_view === 'create-bar') {
    loadHome();
    return;
  }
  if (_view === 'thread') {
    openBar(_thread?.bar_id || _bar?.id);
    return;
  }
  if (_view === 'bar') {
    loadHome();
    return;
  }
  if (_view === 'setup' || _view === 'auth') {
    window.goBack?.();
    return;
  }
  window.goBack?.();
};

function renderSetup() {
  setTitle('设置吧名身份');
  setActions('');
  setFab('');
  setComposerVisible(false);
  const body = document.getElementById('tb-body');
  if (!body) return;
  const defaults = profileDefaults();
  _setupAvatar = defaults.avatar || '';
  const face = _setupAvatar
    ? `<img src="${escapeHtml(_setupAvatar)}" alt="">`
    : `<span>${avatarLetter(defaults.username || '吧')}</span>`;
  body.innerHTML = `
    <div class="tb-auth">
      <div class="tb-auth-stage tb-anim">
        <div class="tb-setup-avatar" id="tb-setup-avatar-preview">${face}</div>
        <div class="tb-setup-avatar-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="tb-use-profile-avatar">用通讯头像</button>
          <button type="button" class="btn btn-ghost btn-sm" id="tb-pick-avatar">选图片</button>
          <button type="button" class="btn btn-ghost btn-sm" id="tb-clear-avatar">清除</button>
        </div>
      </div>
      <div class="tb-panel tb-anim" style="--delay:60ms">
        <div class="tb-auth-title">创建你的贴吧身份</div>
        <div class="tb-auth-desc">只需设置一次。之后打开贴吧会自动进入</div>
        <label class="input-label">吧名</label>
        <input class="input" id="tb-setup-name" placeholder="2～16 字" maxlength="16" value="${escapeHtml(defaults.username)}" />
        <label class="input-label">签名</label>
        <input class="input" id="tb-setup-sign" placeholder="一句话介绍自己" maxlength="40" />
        <button type="button" class="btn btn-primary tb-submit" id="tb-setup-submit">进入贴吧</button>
        <div class="tb-auth-hint">头像可以用通讯录里「我」的头像，也可以另外选一张</div>
      </div>
    </div>
  `;
  document.getElementById('tb-use-profile-avatar')?.addEventListener('click', () => {
    const av = profileDefaults().avatar;
    if (!av) {
      window.showToast?.('通讯里还没有设置头像');
      return;
    }
    _setupAvatar = av;
    const preview = document.getElementById('tb-setup-avatar-preview');
    if (preview) preview.innerHTML = `<img src="${escapeHtml(av)}" alt="">`;
  });
  document.getElementById('tb-clear-avatar')?.addEventListener('click', () => {
    _setupAvatar = '';
    const name = document.getElementById('tb-setup-name')?.value || '吧';
    const preview = document.getElementById('tb-setup-avatar-preview');
    if (preview) preview.innerHTML = `<span>${avatarLetter(name)}</span>`;
  });
  document.getElementById('tb-pick-avatar')?.addEventListener('click', () => window.tbPickSetupAvatar());
  document.getElementById('tb-setup-name')?.addEventListener('input', (e) => {
    if (_setupAvatar) return;
    const preview = document.getElementById('tb-setup-avatar-preview');
    if (preview) preview.innerHTML = `<span>${avatarLetter(e.target.value || '吧')}</span>`;
  });
  document.getElementById('tb-setup-submit')?.addEventListener('click', () => window.tbSubmitSetup());
}

window.tbPickSetupAvatar = async function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { pickCropAndUpload } = await import('../media-crop.js');
      const result = await pickCropAndUpload(file, { aspect: 1, title: '裁剪头像', confirmText: '完成' });
      if (result?.url) {
        _setupAvatar = result.url;
        const preview = document.getElementById('tb-setup-avatar-preview');
        if (preview) preview.innerHTML = `<img src="${escapeHtml(result.url)}" alt="">`;
      }
    } catch (err) {
      if (err?.message !== 'User cancelled') window.showToast?.(err?.message || '上传失败');
    }
  };
  input.click();
};

window.tbSubmitSetup = async function() {
  if (_busy) return;
  const username = document.getElementById('tb-setup-name')?.value || '';
  const signature = document.getElementById('tb-setup-sign')?.value || '';
  _busy = true;
  const btn = document.getElementById('tb-setup-submit');
  if (btn) btn.disabled = true;
  try {
    const data = await api.tiebaSetup({
      username,
      signature,
      avatar: _setupAvatar || '',
    });
    _account = data.account;
    window.showToast?.(`欢迎，${_account.username}`);
    await loadHome();
  } catch (e) {
    const msg = e?.message || '设置失败';
    if (/接口不存在|返回了网页/.test(msg)) {
      window.showToast?.('贴吧接口未加载，请重启后端后再试');
    } else {
      window.showToast?.(msg);
    }
  } finally {
    _busy = false;
    if (btn) btn.disabled = false;
  }
};

function homeActionsHtml() {
  return `
    <button type="button" class="topbar-action" title="建吧" onclick="tbOpenCreateBar()">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
    </button>
    ${accountButtonHtml()}
  `;
}

async function loadHome(opts = {}) {
  const soft = !!(opts && opts.soft);
  const seq = ++_homeSeq;
  _barSeq += 1;
  _threadSeq += 1;
  const q = _searchQ;
  _view = 'home';
  _pullAction = null;
  setTitle('贴吧');
  setComposerVisible(false);
  setFab('');
  setActions(homeActionsHtml());
  if (!soft) showLoading();
  try {
    const bars = await api.tiebaListBars(q, cityMode());
    if (seq !== _homeSeq) return;
    _bars = bars;
    renderHome({ animate: !soft });
  } catch (e) {
    if (seq !== _homeSeq) return;
    const msg = e?.message || String(e);
    const hint = /接口不存在|返回了网页/.test(msg)
      ? '贴吧接口还没加载到当前后端，请关掉旧的 node 进程后重新启动 backend。'
      : /连不上|没有响应|Failed to fetch/i.test(msg)
        ? '若聊天正常，多半是后端没重启到最新代码（CORS 需允许 X-Tieba-Token）。'
        : '';
    const body = document.getElementById('tb-body');
    if (body) {
      body.innerHTML = `
        <div class="tb-empty">
          <div class="tb-empty-mark">吧</div>
          <div class="tb-empty-title">加载失败</div>
          <div class="tb-empty-hint">${escapeHtml(msg)}${hint ? `<br><br>${escapeHtml(hint)}` : ''}</div>
          <button type="button" class="btn btn-primary btn-sm" onclick="loadHome()">重试</button>
        </div>`;
    }
  }
}

function barBlurb(b) {
  if (b?.kind === 'city' && b.source_names) return `${b.source_names} 在这里`;
  return b?.theme || b?.slogan || '';
}

function tileMeta(b) {
  if (b?.kind === 'city' && b.source_names && !Number(b.character_id)) return escapeHtml(b.source_names);
  return `${b.thread_count || 0} 个主题`;
}

function cityModeHtml() {
  const mode = cityMode();
  return `
    <div class="tb-city-mode">
      <div class="tb-city-mode-copy">
        <div class="tb-city-mode-title">同一所在地</div>
        <div class="tb-city-mode-sub">${mode === 'split' ? '每个角色单独一个吧' : '同一个地方合成一个吧'}</div>
      </div>
      <div class="tb-seg" role="group" aria-label="同一所在地怎么建吧">
        <button type="button" data-city-mode="merge" class="${mode === 'merge' ? 'active' : ''}">合成</button>
        <button type="button" data-city-mode="split" class="${mode === 'split' ? 'active' : ''}">分开</button>
      </div>
    </div>
  `;
}

function spotlightHtml(b, animate, kicker) {
  const color = cssColor(b.color);
  const label = kicker || ((b.thread_count || 0) > 0 ? '人气最高' : '最新的吧');
  return `
    <button type="button" class="tb-spotlight tb-wash${animClass(animate)}"${delayStyle(animate, 40, `--bar-color:${color}`)} onclick="tbOpenBar(${b.id})">
      ${barAvatarHtml(b, 'tb-avatar-lg')}
      <div class="tb-spotlight-copy">
        <div class="tb-kicker">${label}</div>
        <div class="tb-spotlight-name">${escapeHtml(b.name)}</div>
        <div class="tb-spotlight-slogan">${escapeHtml(barBlurb(b) || '来坐坐，盖一楼')}</div>
        <div class="tb-spotlight-meta">${b.thread_count || 0} 个主题 · ${b.member_count || 0} ${b.kind === 'city' ? '人在此地' : '位吧友'}</div>
      </div>
    </button>
  `;
}

function tileHtml(b, i, animate) {
  const color = cssColor(b.color);
  return `
    <button type="button" class="tb-tile${animClass(animate)}"${delayStyle(animate, 70 + i * 35, `--bar-color:${color}`)} onclick="tbOpenBar(${b.id})">
      <div class="tb-tile-band">${barAvatarHtml(b)}</div>
      <div class="tb-tile-name">${escapeHtml(b.name)}</div>
      <div class="tb-tile-meta">${tileMeta(b)}</div>
    </button>
  `;
}

function addTileHtml(animate, delay) {
  return `
    <button type="button" class="tb-tile tb-tile-add${animClass(animate)}"${delayStyle(animate, delay)} onclick="tbOpenCreateBar()">
      <div class="tb-tile-add-mark">+</div>
      <div class="tb-tile-name">建一个吧</div>
      <div class="tb-tile-meta">给一个话题安家</div>
    </button>
  `;
}

function resultHtml(b, i, animate) {
  return `
    <button type="button" class="tb-result${animClass(animate)}"${delayStyle(animate, i * 30)} onclick="tbOpenBar(${b.id})">
      ${barAvatarHtml(b)}
      <div class="tb-result-info">
        <div class="tb-result-name">${escapeHtml(b.name)}</div>
        <div class="tb-result-meta">${escapeHtml(barBlurb(b) || '还没有简介')}</div>
      </div>
      <div class="tb-result-count"><b>${b.thread_count || 0}</b><small>主题</small></div>
    </button>
  `;
}

function renderHome({ animate = true } = {}) {
  const body = document.getElementById('tb-body');
  if (!body) return;
  const prev = document.getElementById('tb-search');
  const focused = document.activeElement === prev;
  const caret = focused ? prev.selectionStart : null;
  const shownQ = focused ? prev.value : _searchQ;
  const sign = String(_account?.signature || '').trim();
  const sub = sign || '找一个吧坐下来，或者建一个新的';
  const threads = _bars.reduce((n, b) => n + (Number(b.thread_count) || 0), 0);
  const searching = !!_searchQ;

  let list = '';
  const city = _bars.filter((b) => b.kind === 'city');
  const custom = _bars.filter((b) => b.kind !== 'city');
  if (searching) {
    list = _bars.length ? `
      <div class="tb-section-label">找到 ${_bars.length} 个吧</div>
      <div class="tb-result-list">
        ${_bars.map((b, i) => resultHtml(b, i, animate)).join('')}
      </div>
    ` : `
      <div class="tb-empty tb-empty-compact">
        <div class="tb-empty-title">没有找到这个吧</div>
        <div class="tb-empty-hint">换个词，或者直接建一个</div>
        <button type="button" class="btn btn-primary btn-sm" onclick="tbOpenCreateBar()">创建吧</button>
      </div>
    `;
  } else if (!city.length && !custom.length) {
    list = `
      <div class="tb-empty">
        <div class="tb-empty-mark">吧</div>
        <div class="tb-empty-title">还没有吧</div>
        <div class="tb-empty-hint">角色资料卡里填了所在地，这里会出现城市吧。也可以自己建一个</div>
        <button type="button" class="btn btn-primary" onclick="tbOpenCreateBar()">创建第一个吧</button>
      </div>
    `;
  } else if (!city.length) {
    const rest = custom.slice(1);
    list = `
      ${spotlightHtml(custom[0], animate)}
      <div class="tb-section-label">${rest.length ? '其他的吧' : '接着逛'}</div>
      <div class="tb-tile-grid">
        ${rest.map((b, i) => tileHtml(b, i, animate)).join('')}
        ${addTileHtml(animate, 70 + rest.length * 35)}
      </div>
    `;
  } else {
    const cityBlock = city.length === 1
      ? spotlightHtml(city[0], animate, '所在地')
      : `<div class="tb-tile-grid">${city.map((b, i) => tileHtml(b, i, animate)).join('')}</div>`;
    list = `
      <div class="tb-section-label">所在地</div>
      ${cityBlock}
      <div class="tb-section-label">${custom.length ? '建的吧' : '自己建一个'}</div>
      <div class="tb-tile-grid">
        ${custom.map((b, i) => tileHtml(b, i, animate)).join('')}
        ${addTileHtml(animate, 70 + (city.length + custom.length) * 35)}
      </div>
    `;
  }

  const stats = (!searching && _bars.length) ? `
    <div class="tb-stat-row">
      <div class="tb-stat"><b>${_bars.length}</b><span>个吧</span></div>
      <div class="tb-stat"><b>${threads}</b><span>篇主题</span></div>
    </div>
  ` : '';

  body.innerHTML = `
    <div class="tb-home">
      <div class="tb-hello">
        ${userAvatarHtml(_account?.username, _account?.avatar, 'var(--theme)', 'tb-user-av-lg')}
        <div class="tb-hello-copy">
          <div class="tb-hello-name">${escapeHtml(greetLine())}</div>
          <div class="tb-hello-sub">${escapeHtml(sub)}</div>
        </div>
      </div>
      <div class="tb-search-wrap">
        ${SEARCH_ICON}
        <input class="input tb-search" id="tb-search" placeholder="搜索吧名、所在地" value="${escapeHtml(shownQ)}" enterkeyhint="search" autocomplete="off" />
      </div>
      ${cityModeHtml()}
      ${stats}
      <div id="tb-home-list">${list}</div>
    </div>
  `;
  const search = document.getElementById('tb-search');
  search?.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    const el = search;
    _searchTimer = setTimeout(() => {
      if (!el.isConnected) return;
      _searchQ = el.value.trim();
      loadHome({ soft: true });
    }, 280);
  });
  if (focused && search) {
    search.focus();
    const pos = caret == null ? search.value.length : caret;
    try { search.setSelectionRange(pos, pos); } catch { /* 某些输入法下光标设不回去 */ }
  }
  body.querySelectorAll('[data-city-mode]').forEach((btn) => {
    btn.addEventListener('click', () => window.tbSetCityMode(btn.dataset.cityMode));
  });
}

window.tbOpenCreateBar = function() {
  if (!_account) {
    _view = 'setup';
    renderSetup();
    return;
  }
  _view = 'create-bar';
  setTitle('创建吧');
  setActions('');
  setFab('');
  setComposerVisible(false);
  const body = document.getElementById('tb-body');
  const color = BAR_COLORS[Math.floor(Math.random() * BAR_COLORS.length)];
  body.innerHTML = `
    <div class="tb-form">
      <div class="tb-create-cover tb-wash tb-anim" id="tb-bar-preview" style="--bar-color:${color}">
        <strong id="tb-bar-letter">吧</strong>
        <em>封面预览</em>
      </div>
      <div class="tb-panel tb-anim" style="--delay:50ms">
        <label class="input-label">吧名</label>
        <input class="input" id="tb-bar-name" placeholder="例如：跨时空聊天" maxlength="18" />
        <p class="tb-field-hint">不必自己加「吧」，保存时会补上</p>
        <label class="input-label">吧的内容</label>
        <textarea class="input" id="tb-bar-theme" placeholder="这个吧聊什么。以后吧里的人会按这个主题说话" maxlength="200" rows="3"></textarea>
        <label class="tb-owner-switch">
          <span>
            <b>我来当吧主</b>
            <small>关掉则由 NPC 当吧主</small>
          </span>
          <input type="checkbox" id="tb-owner-user" checked />
        </label>
        <div class="input-label tb-color-label">封面颜色</div>
        <input type="hidden" id="tb-bar-color" value="${color}" />
        <div class="tb-color-row">
          ${BAR_COLORS.map((c) => `
            <button type="button" class="tb-color-dot${c === color ? ' active' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>
          `).join('')}
        </div>
      </div>
      <button type="button" class="btn btn-primary tb-submit" id="tb-bar-submit">创建这个吧</button>
    </div>
  `;
  body.querySelectorAll('.tb-color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      body.querySelectorAll('.tb-color-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      const c = cssColor(dot.dataset.color);
      const hidden = document.getElementById('tb-bar-color');
      if (hidden) hidden.value = c;
      document.getElementById('tb-bar-preview')?.style.setProperty('--bar-color', c);
    });
  });
  document.getElementById('tb-bar-name')?.addEventListener('input', (e) => {
    const letter = document.getElementById('tb-bar-letter');
    if (letter) letter.textContent = (e.target.value || '吧').charAt(0);
  });
  document.getElementById('tb-bar-submit')?.addEventListener('click', () => window.tbSubmitCreateBar());
  document.getElementById('tb-bar-name')?.focus();
};

window.tbSubmitCreateBar = async function() {
  if (_busy) return;
  _busy = true;
  try {
    const bar = await api.tiebaCreateBar({
      name: document.getElementById('tb-bar-name')?.value,
      theme: document.getElementById('tb-bar-theme')?.value,
      ownerMode: document.getElementById('tb-owner-user')?.checked ? 'user' : 'npc',
      color: document.getElementById('tb-bar-color')?.value,
    });
    window.showToast?.(`「${bar.name}」创建成功`);
    await openBar(bar.id);
  } catch (e) {
    if (needsAuthError(e)) {
      _view = 'setup';
      renderSetup();
    }
    window.showToast?.(e.message || '创建失败');
  } finally {
    _busy = false;
  }
};

function rowSig(rows, pick) {
  return (rows || []).map(pick).join('|');
}

function notePulledThreads(prev, next) {
  const prevIds = new Set(prev.map((t) => t.id));
  const added = next.filter((t) => !prevIds.has(t.id)).length;
  const changed = rowSig(prev, (t) => `${t.id}:${t.reply_count}:${t.pinned ? 1 : 0}:${t.last_reply_at || ''}`)
    !== rowSig(next, (t) => `${t.id}:${t.reply_count}:${t.pinned ? 1 : 0}:${t.last_reply_at || ''}`);
  const body = document.getElementById('tb-body');
  if (body) body.scrollTop = 0;
  if (added > 0) window.showToast?.(`新来了 ${added} 个帖`);
  else if (changed) window.showToast?.('帖子已更新');
  else window.showToast?.('已经是最新的');
}

function notePulledPosts(prev, next) {
  const prevIds = new Set(prev.map((p) => p.id));
  const added = next.filter((p) => !prevIds.has(p.id)).length;
  const changed = rowSig(prev, (p) => `${p.id}:${p.floor}:${String(p.content || '').length}`)
    !== rowSig(next, (p) => `${p.id}:${p.floor}:${String(p.content || '').length}`);
  if (added > 0) {
    window.showToast?.(`新来了 ${added} 楼`);
    requestAnimationFrame(() => {
      const floors = document.querySelectorAll('#tb-body .tb-floor');
      floors[floors.length - added]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return;
  }
  const body = document.getElementById('tb-body');
  if (body) body.scrollTop = 0;
  window.showToast?.(changed ? '帖子已更新' : '已经是最新的');
}

window.tbOpenBar = (id) => openBar(id);

function applyBar(bar, threads) {
  _bar = bar;
  _threads = threads || [];
  _view = 'bar';
  _composeBarId = bar.id;
  setComposerVisible(false);
  setTitle(bar.name || '吧');
  setActions(`
    <button type="button" class="topbar-action" title="发帖" onclick="tbOpenCompose(${bar.id})">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
    </button>
  `);
  renderBar();
  armPull(() => openBar(bar.id, { refresh: true }));
}

async function openBar(id, opts = {}) {
  if (!id) return loadHome();
  const seq = ++_barSeq;
  _threadSeq += 1;
  const refresh = !!(opts && opts.refresh);
  const sort = ['live', 'hot', 'new'].includes(_barSort) ? _barSort : 'live';
  const key = `bar:${id}:${sort}`;
  if (!refresh) {
    const snap = snapLoad(key);
    if (snap?.bar && Number(snap.bar.id) === Number(id)) {
      applyBar(snap.bar, snap.threads || []);
      return;
    }
  }
  const keep = _view === 'bar' && Number(_bar?.id) === Number(id);
  const prevThreads = keep ? _threads.slice() : null;
  _view = 'bar';
  _composeBarId = id;
  setComposerVisible(false);
  if (!keep) showLoading();
  else setPullTip('正在刷新');
  try {
    const data = await api.tiebaListThreads(id, { sort, limit: 50 });
    if (seq !== _barSeq) return;
    snapSave(key, { bar: data.bar, threads: data.threads || [] });
    applyBar(data.bar, data.threads || []);
    if (prevThreads) notePulledThreads(prevThreads, _threads);
  } catch (e) {
    if (seq !== _barSeq) return;
    if (keep && _bar) {
      window.showToast?.(e.message || '刷新失败');
      renderBar();
      return;
    }
    setActions('');
    setFab('');
    document.getElementById('tb-body').innerHTML = `
      <div class="tb-empty"><div class="tb-empty-title">打不开这个吧</div><div class="tb-empty-hint">${escapeHtml(e.message)}</div></div>`;
  }
}

function threadCardHtml(t, i) {
  const blurb = excerpt(t.content);
  return `
    <button type="button" class="tb-thread-card tb-anim" style="--delay:${i * 28}ms" onclick="tbOpenThread(${t.id})">
      <div class="tb-thread-main">
        <div class="tb-thread-kicker">
          ${userAvatarHtml(t.author_name, t.author_avatar, nameColor(t.author_name), 'tb-user-av-xs')}
          <span class="tb-thread-author">${escapeHtml(t.author_name)}</span>
          <span class="tb-dot">·</span>
          <span class="tb-thread-when">${formatWhen(t.last_reply_at || t.created_at)}</span>
        </div>
        <div class="tb-thread-title">${t.pinned ? '<span class="tb-pin">置顶</span>' : ''}${escapeHtml(t.title)}</div>
        ${blurb ? `<div class="tb-thread-excerpt">${escapeHtml(blurb)}</div>` : ''}
      </div>
      <div class="tb-reply-stamp" title="回复"><b>${t.reply_count || 0}</b><span>回复</span></div>
    </button>
  `;
}

function ownerLine(bar) {
  if (!bar) return '';
  if (bar.is_owner) return '吧主 · 你';
  if (bar.owner_mode === 'npc') return '吧主 · NPC';
  return '';
}

function renderBar() {
  const body = document.getElementById('tb-body');
  if (!body || !_bar) return;
  const color = cssColor(_bar.color);
  const blurb = barBlurb(_bar) || '这个吧还没写简介';
  const who = ownerLine(_bar);
  const sorts = [['live', '实时'], ['hot', '热门'], ['new', '新帖']];
  body.innerHTML = `
    <div class="tb-bar-page">
      <div class="tb-pull-tip" id="tb-pull-tip">下拉刷新</div>
      <div class="tb-cover tb-wash tb-anim" style="--bar-color:${color}">
        <div class="tb-cover-row">
          ${barAvatarHtml(_bar, 'tb-avatar-xl')}
          <div class="tb-cover-copy">
            <div class="tb-cover-name">${escapeHtml(_bar.name)}</div>
            <div class="tb-cover-slogan">${escapeHtml(blurb)}</div>
            ${who ? `<div class="tb-cover-owner">${who}</div>` : ''}
          </div>
        </div>
        <div class="tb-cover-stats">
          <div class="tb-cover-stat"><b>${_bar.thread_count || 0}</b><span>主题</span></div>
          <div class="tb-cover-stat"><b>${_bar.member_count || 0}</b><span>${_bar.kind === 'city' ? '在此地' : '吧友'}</span></div>
        </div>
      </div>
      <div class="tb-sorts">
        ${sorts.map(([id, label]) => `
          <button type="button" class="tb-sort${_barSort === id ? ' active' : ''}" onclick="tbSetSort('${id}')">${label}</button>
        `).join('')}
      </div>
      ${_threads.length ? `
        <div class="tb-thread-list">
          ${_threads.map((t, i) => threadCardHtml(t, i)).join('')}
        </div>
      ` : `
        <div class="tb-empty">
          <div class="tb-empty-mark">帖</div>
          <div class="tb-empty-title">还没有帖子</div>
          <div class="tb-empty-hint">来发第一帖吧</div>
          <button type="button" class="btn btn-primary" onclick="tbOpenCompose(${_bar.id})">发帖</button>
        </div>
      `}
    </div>
  `;
  setFab(`
    <button type="button" class="tb-fab" onclick="tbOpenCompose(${_bar.id})" title="发帖">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
    </button>
  `);
}

window.tbOpenCompose = function(barId) {
  if (!_account) {
    _view = 'setup';
    renderSetup();
    return;
  }
  _view = 'compose';
  _composeBarId = barId || _bar?.id;
  setTitle('发帖');
  setActions('');
  setFab('');
  setComposerVisible(false);
  const body = document.getElementById('tb-body');
  const bar = _bar || { name: '吧', color: '#c9a0dc' };
  body.innerHTML = `
    <div class="tb-form">
      <div class="tb-compose-to tb-anim">
        ${barAvatarHtml(bar, 'tb-avatar-sm')}
        <div>
          <div class="tb-compose-kicker">发布到</div>
          <div class="tb-compose-bar">${escapeHtml(bar.name || '吧')}</div>
        </div>
      </div>
      <div class="tb-paper tb-anim" style="--delay:40ms">
        <input class="tb-paper-title" id="tb-thread-title" placeholder="写一个标题" maxlength="60" />
        <textarea class="tb-paper-body" id="tb-thread-content" placeholder="正文写在这里" maxlength="4000" rows="8"></textarea>
      </div>
      <button type="button" class="btn btn-primary tb-submit" id="tb-thread-submit">发布</button>
    </div>
  `;
  document.getElementById('tb-thread-submit')?.addEventListener('click', () => window.tbSubmitThread());
  document.getElementById('tb-thread-title')?.focus();
};

window.tbSubmitThread = async function() {
  if (_busy || !_composeBarId) return;
  _busy = true;
  try {
    const thread = await api.tiebaCreateThread(_composeBarId, {
      title: document.getElementById('tb-thread-title')?.value,
      content: document.getElementById('tb-thread-content')?.value,
    });
    window.showToast?.('发布成功');
    snapDropPrefix(`bar:${_composeBarId}:`);
    await openThread(thread.id, { refresh: true });
  } catch (e) {
    if (needsAuthError(e)) {
      _view = 'setup';
      renderSetup();
    }
    window.showToast?.(e.message || '发布失败');
  } finally {
    _busy = false;
  }
};

window.tbOpenThread = (id) => openThread(id);

function applyThread(data) {
  const switching = Number(_thread?.id) !== Number(data.thread?.id);
  _thread = data.thread;
  _posts = data.posts || [];
  if (data.bar) _bar = data.bar;
  _view = 'thread';
  setComposerVisible(true);
  setFab('');
  setTitle(_thread?.title || '帖子');
  setActions(`<span class="tb-floor-hint">${_posts.length} 楼</span>`);
  if (switching) clearComposerDraft();
  renderThread();
  armPull(() => openThread(_thread.id, { refresh: true }));
}

async function openThread(id, opts = {}) {
  if (!id) return;
  const seq = ++_threadSeq;
  _barSeq += 1;
  const refresh = !!(opts && opts.refresh);
  const key = `thread:${id}`;
  if (!refresh) {
    const snap = snapLoad(key);
    if (snap?.thread && Number(snap.thread.id) === Number(id)) {
      applyThread(snap);
      return;
    }
  }
  const keep = _view === 'thread' && Number(_thread?.id) === Number(id);
  const prevPosts = keep ? _posts.slice() : null;
  _view = 'thread';
  setComposerVisible(true);
  if (!keep) showLoading();
  else setPullTip('正在刷新');
  try {
    const data = await api.tiebaGetThread(id, { limit: 100 });
    if (seq !== _threadSeq) return;
    snapSave(key, { thread: data.thread, posts: data.posts || [], bar: data.bar || null });
    applyThread(data);
    if (prevPosts) notePulledPosts(prevPosts, _posts);
  } catch (e) {
    if (seq !== _threadSeq) return;
    if (keep && _thread) {
      window.showToast?.(e.message || '刷新失败');
      setComposerVisible(true);
      renderThread();
      return;
    }
    setComposerVisible(false);
    setActions('');
    document.getElementById('tb-body').innerHTML = `
      <div class="tb-empty"><div class="tb-empty-title">帖子打不开</div><div class="tb-empty-hint">${escapeHtml(e.message)}</div></div>`;
  }
}

function hostPost() {
  return _posts.find((p) => Number(p.floor) === 1) || null;
}

function sameAuthor(a, b) {
  if (!a || !b) return false;
  if (Number(a.author_id) > 0 && Number(b.author_id) > 0) return Number(a.author_id) === Number(b.author_id);
  return String(a.author_name || '') === String(b.author_name || '') && !!a.author_name;
}

function quoteHtml(p) {
  const n = Number(p.reply_to_floor) || 0;
  if (!n) return '';
  const target = _posts.find((x) => Number(x.floor) === n);
  const who = target?.author_name ? ` ${escapeHtml(target.author_name)}` : '';
  return `<button type="button" class="tb-floor-quote" onclick="tbJumpFloor(${n})">回复 ${n}楼${who}</button>`;
}

function floorHtml(p, i) {
  const host = hostPost();
  const isOp = Number(p.floor) === 1;
  const isHost = isOp || sameAuthor(p, host);
  const color = cssColor(_bar?.color);
  const cls = `tb-floor${isOp ? ' is-op' : ''}${isHost ? ' is-host' : ''} tb-anim`;
  return `
    <article class="${cls}" data-floor="${p.floor}" style="--delay:${Math.min(i, 8) * 30}ms;--bar-color:${color}">
      <div class="tb-floor-top">
        ${userAvatarHtml(p.author_name, p.author_avatar, isHost ? color : nameColor(p.author_name), isOp ? 'tb-user-av-lg' : '')}
        <div class="tb-floor-who">
          <div class="tb-floor-name-row">
            <span class="tb-floor-name">${escapeHtml(p.author_name)}</span>
            ${isHost ? '<span class="tb-lz">楼主</span>' : ''}
          </div>
          <div class="tb-floor-time">${formatWhen(p.created_at)}</div>
        </div>
        <div class="tb-floor-num${isOp ? ' is-op' : ''}">${p.floor}<small>${isOp ? '主楼' : '楼'}</small></div>
      </div>
      ${quoteHtml(p)}
      <div class="tb-floor-content">${formatTextWithInlineEmojis(p.content || '')}</div>
      <div class="tb-floor-actions">
        <button type="button" class="tb-floor-act" onclick="tbReplyFloor(${p.floor})">回复这层</button>
      </div>
    </article>
  `;
}

function renderThread() {
  const body = document.getElementById('tb-body');
  if (!body || !_thread) return;
  const color = cssColor(_bar?.color);
  const barId = _bar?.id || _thread.bar_id;
  const host = hostPost();
  const hostName = host?.author_name || _thread.author_name || '';
  body.innerHTML = `
    <div class="tb-thread-page">
      <div class="tb-pull-tip" id="tb-pull-tip">下拉刷新</div>
      <header class="tb-opener tb-anim" style="--bar-color:${color}">
        ${barId ? `
          <button type="button" class="tb-bar-pill" onclick="tbOpenBar(${barId})">
            ${barAvatarHtml(_bar || { name: _thread.bar_name || '吧', color }, 'tb-avatar-sm')}
            <span>${escapeHtml(_bar?.name || _thread.bar_name || '吧')}</span>
          </button>
        ` : ''}
        <h1>${_thread.pinned ? '<span class="tb-pin">置顶</span>' : ''}${escapeHtml(_thread.title)}</h1>
        ${hostName ? `
          <div class="tb-opener-by">
            ${userAvatarHtml(hostName, host?.author_avatar, color, 'tb-user-av-sm')}
            <span class="tb-opener-name">${escapeHtml(hostName)}</span>
            <span class="tb-lz">楼主</span>
          </div>
        ` : ''}
        <div class="tb-opener-meta">${_posts.length} 楼 · ${_thread.reply_count || 0} 条回复</div>
        ${_bar?.is_owner ? `
          <div class="tb-owner-row">
            <button type="button" class="tb-owner-btn" onclick="tbTogglePin()">${_thread.pinned ? '取消置顶' : '置顶'}</button>
            <button type="button" class="tb-owner-btn danger" onclick="tbDeleteThread()">删帖</button>
          </div>
        ` : ''}
      </header>
      <div class="tb-floors">
        ${_posts.map((p, i) => floorHtml(p, i)).join('')}
      </div>
    </div>
  `;
  paintReplyTarget();
}

function clearComposerDraft() {
  _replyTo = null;
  const input = document.getElementById('tb-reply-input');
  if (input) input.value = '';
  paintReplyTarget();
}

function paintReplyTarget() {
  const el = document.getElementById('tb-reply-target');
  const input = document.getElementById('tb-reply-input');
  const body = document.getElementById('tb-body');
  if (input) input.placeholder = _replyTo ? `回复 ${_replyTo.floor}楼 ${_replyTo.author_name || ''}…` : '写下这一楼…';
  body?.classList.toggle('has-reply-target', !!_replyTo);
  if (!el) return;
  if (!_replyTo) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <span>回复 <b>${_replyTo.floor}楼</b> ${escapeHtml(_replyTo.author_name || '')}</span>
    <button type="button" id="tb-reply-cancel">取消</button>
  `;
  document.getElementById('tb-reply-cancel')?.addEventListener('click', () => {
    _replyTo = null;
    paintReplyTarget();
  });
}

window.tbReplyFloor = function(floor) {
  const post = _posts.find((p) => Number(p.floor) === Number(floor));
  if (!post) return;
  _replyTo = { floor: post.floor, author_name: post.author_name || '' };
  paintReplyTarget();
  document.getElementById('tb-reply-input')?.focus();
};

window.tbJumpFloor = function(floor) {
  const el = document.querySelector(`.tb-floor[data-floor="${Number(floor)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('is-flash');
  void el.offsetWidth;
  el.classList.add('is-flash');
};

window.tbOpenEmoji = function() {
  const input = document.getElementById('tb-reply-input');
  openSystemEmojiOverlay({ targetInput: input, includeStickers: false });
};

window.tbSendReply = async function() {
  if (_busy || !_thread) return;
  const input = document.getElementById('tb-reply-input');
  const content = input?.value || '';
  if (!String(content).trim()) {
    window.showToast?.('写点什么再发送');
    return;
  }
  if (!_account) {
    _view = 'setup';
    setComposerVisible(false);
    renderSetup();
    return;
  }
  _busy = true;
  const btn = document.getElementById('tb-reply-send');
  if (btn) btn.disabled = true;
  try {
    const post = await api.tiebaReply(_thread.id, content, _replyTo?.floor || 0);
    _posts.push(post);
    _thread.reply_count = (_thread.reply_count || 0) + 1;
    _thread.last_reply_at = post.created_at || _thread.last_reply_at;
    snapSave(`thread:${_thread.id}`, { thread: _thread, posts: _posts, bar: _bar });
    snapDropPrefix(`bar:${_bar?.id || _thread.bar_id}:`);
    clearComposerDraft();
    renderThread();
    setActions(`<span class="tb-floor-hint">${_posts.length} 楼</span>`);
    requestAnimationFrame(() => {
      const last = document.querySelector('.tb-floor:last-child');
      last?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  } catch (e) {
    if (needsAuthError(e)) {
      setComposerVisible(false);
      _view = 'setup';
      renderSetup();
    }
    window.showToast?.(e.message || '发送失败');
  } finally {
    _busy = false;
    if (btn) btn.disabled = false;
  }
};

window.tbSetCityMode = async function(mode) {
  const next = mode === 'split' ? 'split' : 'merge';
  if (next === cityMode()) return;
  const settings = window.getAppSettings?.();
  const prev = settings?.tieba_city_mode;
  if (settings) settings.tieba_city_mode = next;
  try {
    await api.saveSettings({ tieba_city_mode: next });
  } catch (e) {
    if (settings) settings.tieba_city_mode = prev;
    window.showToast?.(e.message || '没保存上');
    return;
  }
  await loadHome({ soft: true });
};

window.tbSetSort = function(sort) {
  if (!['live', 'hot', 'new'].includes(sort) || !_bar) return;
  if (sort === _barSort) return;
  _barSort = sort;
  openBar(_bar.id);
};

window.tbTogglePin = async function() {
  if (_busy || !_thread || !_bar?.is_owner) return;
  _busy = true;
  try {
    const thread = await api.tiebaPinThread(_thread.id, !_thread.pinned);
    _thread = { ..._thread, ...thread };
    snapSave(`thread:${_thread.id}`, { thread: _thread, posts: _posts, bar: _bar });
    snapDropPrefix(`bar:${_bar.id}:`);
    renderThread();
    window.showToast?.(_thread.pinned ? '已置顶' : '已取消置顶');
  } catch (e) {
    if (needsAuthError(e)) {
      setComposerVisible(false);
      _view = 'setup';
      renderSetup();
    }
    window.showToast?.(e.message || '操作失败');
  } finally {
    _busy = false;
  }
};

window.tbDeleteThread = async function() {
  if (_busy || !_thread || !_bar?.is_owner) return;
  if (!window.confirm('删掉这篇帖子？楼层会一起去掉。')) return;
  _busy = true;
  const barId = _bar.id;
  try {
    await api.tiebaDeleteThread(_thread.id);
    snapDropPrefix(`thread:${_thread.id}`);
    snapDropPrefix(`bar:${barId}:`);
    window.showToast?.('已删帖');
    await openBar(barId, { refresh: true });
  } catch (e) {
    if (needsAuthError(e)) {
      setComposerVisible(false);
      _view = 'setup';
      renderSetup();
    }
    window.showToast?.(e.message || '删不掉');
  } finally {
    _busy = false;
  }
};

window.tbAccountMenu = async function() {
  if (!_account) {
    _view = 'setup';
    renderSetup();
    return;
  }
  const sign = _account.signature ? `\n${_account.signature}\n` : '';
  const ok = window.confirm(`当前账号：${_account.username}${sign}\n清除本地身份？（下次进入需重新设置）`);
  if (!ok) return;
  await api.tiebaLogout();
  _account = null;
  _view = 'setup';
  renderSetup();
};

// 暴露给重试按钮
window.loadHome = loadHome;

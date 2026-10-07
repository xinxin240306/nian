/* ===== 虚拟贴吧 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';

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

const BAR_COLORS = [
  '#c9a0dc', '#74b9ff', '#fd79a8', '#fdcb6e',
  '#55efc4', '#a29bfe', '#ff7675', '#81ecec',
];

function formatWhen(iso) {
  if (!iso) return '';
  try {
    const d = new Date(String(iso).replace(' ', 'T'));
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

function barAvatarHtml(bar, sizeClass = '') {
  const color = bar.color || '#c9a0dc';
  if (bar.avatar) {
    return `<div class="tb-avatar ${sizeClass}" style="background:${escapeHtml(color)}"><img src="${escapeHtml(bar.avatar)}" alt=""></div>`;
  }
  return `<div class="tb-avatar ${sizeClass}" style="background:${escapeHtml(color)}">${avatarLetter(bar.name)}</div>`;
}

function userAvatarHtml(name, avatar, color) {
  const bg = color || 'var(--theme)';
  if (avatar) {
    return `<div class="tb-user-av" style="background:${bg}"><img src="${escapeHtml(avatar)}" alt=""></div>`;
  }
  return `<div class="tb-user-av" style="background:${bg}">${avatarLetter(name)}</div>`;
}

function ensureShell() {
  const page = document.getElementById('tieba-page');
  if (!page) return null;
  if (page.dataset.shellBuilt !== 'tb-v1') {
    page.innerHTML = `
      <div class="tb-shell">
        <div class="topbar tb-topbar">
          <button type="button" class="topbar-back topbar-nav-back" id="tb-back" title="返回"></button>
          <div class="topbar-title" id="tb-title">贴吧</div>
          <div class="topbar-actions" id="tb-actions"></div>
        </div>
        <div class="tb-body scroll-area scroll-area-native" id="tb-body"></div>
        <div class="tb-composer" id="tb-composer" hidden>
          <input class="input tb-composer-input" id="tb-reply-input" placeholder="盖一楼…" maxlength="4000" />
          <button type="button" class="btn btn-primary tb-composer-send" id="tb-reply-send">发送</button>
        </div>
      </div>
    `;
    page.dataset.shellBuilt = 'tb-v1';
    document.getElementById('tb-back')?.addEventListener('click', () => window.tbGoBack());
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

function setComposerVisible(show) {
  const el = document.getElementById('tb-composer');
  if (el) el.hidden = !show;
  const body = document.getElementById('tb-body');
  if (body) body.classList.toggle('has-composer', !!show);
}

function showLoading() {
  const body = document.getElementById('tb-body');
  if (body) body.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
}

function needsAuthError(e) {
  return !!(e?.needsTiebaAuth || /请先登录贴吧|请先设置贴吧身份/.test(String(e?.message || '')));
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
  setComposerVisible(false);
  const body = document.getElementById('tb-body');
  if (!body) return;
  const defaults = profileDefaults();
  _setupAvatar = defaults.avatar || '';
  body.innerHTML = `
    <div class="tb-auth tb-enter">
      <div class="tb-auth-hero">
        <div class="tb-auth-badge">吧</div>
        <div class="tb-auth-title">创建你的贴吧身份</div>
        <div class="tb-auth-desc">只需设置一次。之后打开贴吧会自动进入，不用再登录</div>
      </div>
      <div class="tb-auth-form">
        <div class="tb-setup-avatar-row">
          <div class="tb-setup-avatar" id="tb-setup-avatar-preview">
            ${_setupAvatar
              ? `<img src="${escapeHtml(_setupAvatar)}" alt="">`
              : `<span>${avatarLetter(defaults.username || '吧')}</span>`}
          </div>
          <div class="tb-setup-avatar-actions">
            <button type="button" class="btn btn-ghost btn-sm" id="tb-use-profile-avatar">用通讯头像</button>
            <button type="button" class="btn btn-ghost btn-sm" id="tb-pick-avatar">选图片</button>
            <button type="button" class="btn btn-ghost btn-sm" id="tb-clear-avatar">清除</button>
          </div>
        </div>
        <label class="input-label">吧名（显示名）</label>
        <input class="input" id="tb-setup-name" placeholder="2～16 字" maxlength="16" value="${escapeHtml(defaults.username)}" />
        <label class="input-label" style="margin-top:12px">签名</label>
        <input class="input" id="tb-setup-sign" placeholder="一句话介绍自己" maxlength="40" />
        <button type="button" class="btn btn-primary tb-auth-submit" id="tb-setup-submit">进入贴吧</button>
        <div class="tb-auth-hint">头像可直接用通讯录里「我」的头像，也可以自己选一张</div>
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

async function loadHome() {
  _view = 'home';
  setTitle('贴吧');
  setComposerVisible(false);
  setActions(`
    <button type="button" class="topbar-action" title="建吧" onclick="tbOpenCreateBar()">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
    </button>
    <button type="button" class="topbar-action tb-user-chip" title="账号" onclick="tbAccountMenu()">
      ${_account?.avatar ? `<img class="tb-top-av" src="${escapeHtml(_account.avatar)}" alt="">` : ''}
      ${escapeHtml(_account?.username || '')}
    </button>
  `);
  showLoading();
  try {
    _bars = await api.tiebaListBars(_searchQ);
    renderHome();
  } catch (e) {
    const msg = e?.message || String(e);
    const hint = /接口不存在|返回了网页/.test(msg)
      ? '贴吧接口还没加载到当前后端，请关掉旧的 node 进程后重新启动 backend。'
      : /连不上|没有响应|Failed to fetch/i.test(msg)
        ? '若聊天正常，多半是后端没重启到最新代码（CORS 需允许 X-Tieba-Token）。'
        : '';
    document.getElementById('tb-body').innerHTML = `
      <div class="tb-empty">
        <div class="tb-empty-title">加载失败</div>
        <div class="tb-empty-hint">${escapeHtml(msg)}${hint ? `<br><br>${escapeHtml(hint)}` : ''}</div>
        <button class="btn btn-sm" onclick="loadHome()">重试</button>
      </div>`;
  }
}

function renderHome() {
  const body = document.getElementById('tb-body');
  if (!body) return;
  body.innerHTML = `
    <div class="tb-home">
      <div class="tb-search-wrap">
        <input class="input tb-search" id="tb-search" placeholder="搜索吧名" value="${escapeHtml(_searchQ)}" />
      </div>
      <div class="tb-section-label">推荐的吧</div>
      ${_bars.length ? `
        <div class="tb-bar-grid">
          ${_bars.map((b, i) => `
            <button type="button" class="tb-bar-card" style="--delay:${i * 40}ms" onclick="tbOpenBar(${b.id})">
              ${barAvatarHtml(b)}
              <div class="tb-bar-card-info">
                <div class="tb-bar-card-name">${escapeHtml(b.name)}</div>
                <div class="tb-bar-card-meta">${b.thread_count || 0} 贴 · ${escapeHtml(b.slogan || '暂无简介')}</div>
              </div>
              <span class="tb-bar-card-chevron">›</span>
            </button>
          `).join('')}
        </div>
      ` : `
        <div class="tb-empty">
          <div class="tb-empty-icon">吧</div>
          <div class="tb-empty-title">还没有吧</div>
          <div class="tb-empty-hint">建一个吧，邀请世界里的人来盖楼</div>
          <button type="button" class="btn btn-primary" onclick="tbOpenCreateBar()">创建第一个吧</button>
        </div>
      `}
    </div>
  `;
  const search = document.getElementById('tb-search');
  let timer = null;
  search?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      _searchQ = search.value.trim();
      loadHome();
    }, 280);
  });
  requestAnimationFrame(() => {
    body.querySelectorAll('.tb-bar-card').forEach((el) => el.classList.add('tb-enter'));
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
  setComposerVisible(false);
  const body = document.getElementById('tb-body');
  const color = BAR_COLORS[Math.floor(Math.random() * BAR_COLORS.length)];
  body.innerHTML = `
    <div class="tb-form tb-enter">
      <div class="tb-form-preview" id="tb-bar-preview" style="background:${color}">吧</div>
      <label class="input-label">吧名</label>
      <input class="input" id="tb-bar-name" placeholder="例如：跨时空聊天" maxlength="18" />
      <label class="input-label" style="margin-top:12px">一句话简介</label>
      <input class="input" id="tb-bar-slogan" placeholder="这个吧聊什么" maxlength="40" />
      <input type="hidden" id="tb-bar-color" value="${color}" />
      <div class="tb-color-row">
        ${BAR_COLORS.map((c) => `
          <button type="button" class="tb-color-dot${c === color ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>
        `).join('')}
      </div>
      <button type="button" class="btn btn-primary" style="width:100%;margin-top:20px" id="tb-bar-submit">创建</button>
    </div>
  `;
  body.querySelectorAll('.tb-color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      body.querySelectorAll('.tb-color-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      const c = dot.dataset.color;
      document.getElementById('tb-bar-color').value = c;
      const preview = document.getElementById('tb-bar-preview');
      if (preview) preview.style.background = c;
    });
  });
  document.getElementById('tb-bar-name')?.addEventListener('input', (e) => {
    const preview = document.getElementById('tb-bar-preview');
    if (preview) preview.textContent = (e.target.value || '吧').charAt(0);
  });
  document.getElementById('tb-bar-submit')?.addEventListener('click', () => window.tbSubmitCreateBar());
};

window.tbSubmitCreateBar = async function() {
  if (_busy) return;
  _busy = true;
  try {
    const bar = await api.tiebaCreateBar({
      name: document.getElementById('tb-bar-name')?.value,
      slogan: document.getElementById('tb-bar-slogan')?.value,
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

window.tbOpenBar = (id) => openBar(id);

async function openBar(id) {
  if (!id) return loadHome();
  _view = 'bar';
  _composeBarId = id;
  setComposerVisible(false);
  showLoading();
  try {
    const data = await api.tiebaListThreads(id);
    _bar = data.bar;
    _threads = data.threads || [];
    setTitle(_bar.name);
    setActions(`
      <button type="button" class="topbar-action" title="发帖" onclick="tbOpenCompose(${_bar.id})">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
    `);
    renderBar();
  } catch (e) {
    document.getElementById('tb-body').innerHTML = `
      <div class="empty-state"><div class="empty-text">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderBar() {
  const body = document.getElementById('tb-body');
  if (!body || !_bar) return;
  body.innerHTML = `
    <div class="tb-bar-page">
      <div class="tb-bar-banner" style="--bar-color:${escapeHtml(_bar.color || '#c9a0dc')}">
        ${barAvatarHtml(_bar, 'tb-avatar-lg')}
        <div class="tb-bar-banner-info">
          <div class="tb-bar-banner-name">${escapeHtml(_bar.name)}</div>
          <div class="tb-bar-banner-meta">${_bar.thread_count || 0} 个主题 · ${_threads.length} 条显示中</div>
          ${_bar.slogan ? `<div class="tb-bar-banner-slogan">${escapeHtml(_bar.slogan)}</div>` : ''}
        </div>
      </div>
      <div class="tb-thread-tabs">
        <span class="tb-thread-tab active">最新回复</span>
      </div>
      ${_threads.length ? `
        <div class="tb-thread-list">
          ${_threads.map((t, i) => `
            <button type="button" class="tb-thread-row" style="--delay:${i * 30}ms" onclick="tbOpenThread(${t.id})">
              <div class="tb-thread-main">
                <div class="tb-thread-title">${escapeHtml(t.title)}</div>
                <div class="tb-thread-meta">
                  <span>${escapeHtml(t.author_name)}</span>
                  <span>·</span>
                  <span>${formatWhen(t.last_reply_at || t.created_at)}</span>
                </div>
              </div>
              <div class="tb-thread-count">${t.reply_count || 0}<small>回复</small></div>
            </button>
          `).join('')}
        </div>
      ` : `
        <div class="tb-empty">
          <div class="tb-empty-title">还没有帖子</div>
          <div class="tb-empty-hint">来发第一帖吧</div>
          <button type="button" class="btn btn-primary" onclick="tbOpenCompose(${_bar.id})">发帖</button>
        </div>
      `}
      <button type="button" class="tb-fab" onclick="tbOpenCompose(${_bar.id})" title="发帖">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  `;
  requestAnimationFrame(() => {
    body.querySelector('.tb-bar-banner')?.classList.add('tb-enter');
    body.querySelectorAll('.tb-thread-row').forEach((el) => el.classList.add('tb-enter'));
  });
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
  setComposerVisible(false);
  const body = document.getElementById('tb-body');
  body.innerHTML = `
    <div class="tb-form tb-enter">
      <div class="tb-compose-bar-hint">发到 · ${escapeHtml(_bar?.name || '吧')}</div>
      <label class="input-label">标题</label>
      <input class="input" id="tb-thread-title" placeholder="写个醒目的标题" maxlength="60" />
      <label class="input-label" style="margin-top:12px">正文</label>
      <textarea class="input" id="tb-thread-content" placeholder="说点什么…" maxlength="4000" rows="8"></textarea>
      <button type="button" class="btn btn-primary" style="width:100%;margin-top:20px" id="tb-thread-submit">发布</button>
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
    await openThread(thread.id);
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

async function openThread(id) {
  _view = 'thread';
  showLoading();
  setComposerVisible(true);
  try {
    const data = await api.tiebaGetThread(id);
    _thread = data.thread;
    _posts = data.posts || [];
    _bar = data.bar || _bar;
    setTitle(_thread.title.length > 12 ? `${_thread.title.slice(0, 12)}…` : _thread.title);
    setActions(`<span class="tb-floor-hint">${_posts.length} 楼</span>`);
    renderThread();
  } catch (e) {
    setComposerVisible(false);
    document.getElementById('tb-body').innerHTML = `
      <div class="empty-state"><div class="empty-text">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderThread() {
  const body = document.getElementById('tb-body');
  if (!body || !_thread) return;
  body.innerHTML = `
    <div class="tb-thread-page">
      <div class="tb-thread-head tb-enter">
        <div class="tb-thread-head-title">${escapeHtml(_thread.title)}</div>
        <div class="tb-thread-head-meta">
          ${escapeHtml(_bar?.name || '')} · ${_thread.reply_count || 0} 回复
        </div>
      </div>
      <div class="tb-floors">
        ${_posts.map((p, i) => `
          <article class="tb-floor" style="--delay:${i * 35}ms">
            <div class="tb-floor-side">
              ${userAvatarHtml(p.author_name, p.author_avatar, i === 0 ? (_bar?.color || 'var(--theme)') : undefined)}
              <div class="tb-floor-num">${p.floor}楼</div>
            </div>
            <div class="tb-floor-body">
              <div class="tb-floor-user">
                <span class="tb-floor-name">${escapeHtml(p.author_name)}</span>
                ${p.floor === 1 ? '<span class="tb-lz">楼主</span>' : ''}
              </div>
              <div class="tb-floor-content">${escapeHtml(p.content).replace(/\n/g, '<br>')}</div>
              <div class="tb-floor-time">${formatWhen(p.created_at)}</div>
            </div>
          </article>
        `).join('')}
      </div>
    </div>
  `;
  requestAnimationFrame(() => {
    body.querySelectorAll('.tb-floor').forEach((el) => el.classList.add('tb-enter'));
  });
  const input = document.getElementById('tb-reply-input');
  if (input) input.value = '';
}

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
    const post = await api.tiebaReply(_thread.id, content);
    _posts.push(post);
    _thread.reply_count = (_thread.reply_count || 0) + 1;
    if (input) input.value = '';
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

window.tbAccountMenu = async function() {
  if (!_account) {
    _view = 'setup';
    renderSetup();
    return;
  }
  const ok = window.confirm(`当前账号：${_account.username}\n\n清除本地身份？（下次进入需重新设置）`);
  if (!ok) return;
  await api.tiebaLogout();
  _account = null;
  _view = 'setup';
  renderSetup();
};

// 暴露给重试按钮
window.loadHome = loadHome;

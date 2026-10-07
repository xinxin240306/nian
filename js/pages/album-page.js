/* ===== 角色相册页（角色相册 → 网格 → 全屏浏览） ===== */
import * as api from '../api.js';
import { escapeHtml, formatDetailTime } from '../memory.js';
import { ICON_PLUS, ICON_TRASH } from '../ui-icons.js';
import { downloadBlobFile, downloadResultToast } from '../download-file.js';
import { resolveApiUrl, getSiteSessionToken } from '../server-config.js';

const TYPE_TABS = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'voice', label: '语音' },
];

const SUBJECT_TABS = [
  { id: 'all', label: '全部' },
  { id: 'self', label: '拍自己' },
  { id: 'other', label: '拍用户' },
  { id: 'robot', label: '小机' },
];

const ICON_DOWNLOAD = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`;

/** 'home' | 'grid' | 'detail' */
let _view = 'home';
let _charId = null;
let _chars = [];
let _type = 'all';
let _subject = 'all';
let _uploadSubject = 'self';
let _items = [];
let _detailItem = null;
let _promptOpen = false;
let _albumMeta = new Map(); // charId -> { count, coverUrl, imageCount, videoCount, voiceCount }
let _swipeStartX = 0;
let _swipeStartY = 0;

function albumMediaUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  return window.resolveMediaUrl?.(s) || s;
}

function acceptForType(type) {
  if (type === 'video') return 'video/*';
  if (type === 'voice') return 'audio/*,video/mp4,video/*,.mp4,.m4a,.wav,.webm,.mkv';
  return 'image/*';
}

function uploadType() {
  if (_type === 'video' || _type === 'voice') return _type;
  return 'image';
}

function charById(id) {
  return _chars.find(c => Number(c.id) === Number(id)) || null;
}

function charName(id) {
  return charById(id)?.name || '角色';
}

function subjectLabel(subject) {
  return subject === 'self' ? '拍自己' : '拍用户';
}

function mediaTypeLabel(type) {
  if (type === 'video') return '视频';
  if (type === 'voice') return '语音';
  return '图片';
}

function showSubjectFilter() {
  return _type === 'all' || _type === 'image' || _type === 'video';
}

function filteredItems() {
  return _items.filter((it) => {
    if (_type !== 'all' && it.media_type !== _type) return false;
    if (showSubjectFilter() && _subject !== 'all') {
      // 「小机」按来源筛，不是 self/other 那一组
      if (_subject === 'robot') return it.source === 'robot';
      const subj = it.media_type === 'voice' ? 'other' : (it.subject === 'self' ? 'self' : 'other');
      if (subj !== _subject) return false;
    }
    return true;
  });
}

function formatAlbumDate(raw) {
  if (!raw) return '';
  const s = formatDetailTime(raw);
  if (!s || /Invalid/i.test(s)) return String(raw).replace('T', ' ').slice(0, 16);
  return s;
}

function setTopbar({ title, backFn, actionHtml = '' }) {
  const titleEl = document.getElementById('album-title');
  const actionEl = document.getElementById('album-topbar-action');
  const backBtn = document.getElementById('album-back-btn');
  if (titleEl) titleEl.textContent = title;
  if (actionEl) actionEl.innerHTML = actionHtml;
  if (backBtn) {
    backBtn.onclick = (e) => {
      e?.preventDefault?.();
      backFn?.();
    };
  }
}

window.initAlbumPage = async function() {
  _chars = await api.getCharacters().catch(() => []);
  _view = 'home';
  _charId = null;
  _type = 'all';
  _subject = 'all';
  _items = [];
  _detailItem = null;
  _promptOpen = false;

  const page = document.getElementById('album-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" id="album-back-btn" title="返回"></button>
      <div class="topbar-title" id="album-title" style="font-family:'Noto Serif SC',serif">相册</div>
      <div class="topbar-actions" id="album-topbar-action"></div>
    </div>
    <div class="album-shell" id="album-shell">
      <div class="loading"><div class="loading-spinner"></div></div>
    </div>
    <input type="file" id="album-file-input" style="display:none" onchange="handleAlbumUpload(event)">
    <div id="album-detail-overlay" class="album-viewer" style="display:none"></div>
  `;
  await showAlbumHome();
  const jumpId = window._albumOpenCharId;
  window._albumOpenCharId = null;
  if (jumpId) {
    await openCharAlbum(jumpId);
  }
};

async function loadAlbumMeta() {
  _albumMeta = new Map();
  await Promise.all(_chars.map(async (c) => {
    try {
      const items = await api.getAlbumItems(c.id);
      const images = items.filter(i => i.media_type === 'image');
      const videos = items.filter(i => i.media_type === 'video');
      const voices = items.filter(i => i.media_type === 'voice');
      const cover = images[0]?.url || videos[0]?.url || c.avatar || '';
      _albumMeta.set(Number(c.id), {
        count: items.length,
        imageCount: images.length,
        videoCount: videos.length,
        voiceCount: voices.length,
        coverUrl: cover,
        coverIsVideo: !images[0] && !!videos[0],
      });
    } catch {
      _albumMeta.set(Number(c.id), {
        count: 0, imageCount: 0, videoCount: 0, voiceCount: 0, coverUrl: c.avatar || '', coverIsVideo: false,
      });
    }
  }));
}

async function showAlbumHome() {
  _view = 'home';
  _charId = null;
  _detailItem = null;
  window.closeAlbumDetail?.();
  setTopbar({
    title: '相册',
    backFn: () => window.goBack?.(),
  });
  const shell = document.getElementById('album-shell');
  if (!shell) return;
  shell.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  await loadAlbumMeta();

  if (!_chars.length) {
    shell.innerHTML = '<div class="empty-state"><div class="empty-text">还没有角色</div></div>';
    return;
  }

  shell.innerHTML = `
    <div class="album-home-hint">按角色分相册 · 聊天里生成的图、视频会自动进来</div>
    <div class="album-char-grid">
      ${_chars.map(c => renderCharAlbumCard(c)).join('')}
    </div>
  `;
}

function renderCharAlbumCard(c) {
  const meta = _albumMeta.get(Number(c.id)) || { count: 0, coverUrl: c.avatar || '', coverIsVideo: false };
  const cover = meta.coverUrl
    ? (meta.coverIsVideo
      ? `<video class="album-char-cover-media" src="${escapeHtml(albumMediaUrl(meta.coverUrl))}" muted playsinline preload="metadata"></video>`
      : `<img class="album-char-cover-media" src="${escapeHtml(albumMediaUrl(meta.coverUrl))}" alt="">`)
    : `<div class="album-char-cover-placeholder">${escapeHtml((c.name || '?').slice(0, 1))}</div>`;
  return `
    <button type="button" class="album-char-card" onclick="openCharAlbum(${c.id})">
      <div class="album-char-cover">${cover}</div>
      <div class="album-char-meta">
        <div class="album-char-name">${escapeHtml(c.name || '角色')}</div>
        <div class="album-char-count">${meta.count} 项</div>
      </div>
    </button>
  `;
}

window.openCharAlbum = async function(charId) {
  _charId = parseInt(charId, 10) || null;
  if (!_charId) return;
  _view = 'grid';
  _type = 'all';
  _subject = 'all';
  _uploadSubject = 'self';
  _detailItem = null;
  setTopbar({
    title: charName(_charId),
    backFn: () => showAlbumHome(),
    actionHtml: `<button type="button" class="topbar-action" onclick="triggerAlbumUpload()" title="上传">${ICON_PLUS}</button>`,
  });
  await loadAlbumGrid();
};

async function loadAlbumGrid() {
  const shell = document.getElementById('album-shell');
  if (!shell || !_charId) return;
  shell.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    _items = await api.getAlbumItems(_charId);
  } catch (e) {
    shell.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
    return;
  }
  renderAlbumGrid();
}

function renderAlbumGrid() {
  const shell = document.getElementById('album-shell');
  if (!shell) return;
  const list = filteredItems();
  const subBar = showSubjectFilter()
    ? `<div class="album-filter-row">
        ${SUBJECT_TABS.map(t => `
          <button type="button" class="tag ${_subject === t.id ? 'active' : ''}" onclick="switchAlbumSubject('${t.id}')">${t.label}</button>
        `).join('')}
      </div>`
    : '';

  shell.innerHTML = `
    <div class="album-filter-row">
      ${TYPE_TABS.map(t => `
        <button type="button" class="tag ${_type === t.id ? 'active' : ''}" onclick="switchAlbumType('${t.id}')">${t.label}</button>
      `).join('')}
    </div>
    ${subBar}
    <div class="album-grid-toolbar">
      <span class="album-grid-count">${list.length} 项</span>
      ${showSubjectFilter() ? `
        <div class="album-upload-as">
          <button type="button" class="tag ${_uploadSubject === 'self' ? 'active' : ''}" onclick="setAlbumUploadSubject('self')">上传·自己</button>
          <button type="button" class="tag ${_uploadSubject === 'other' ? 'active' : ''}" onclick="setAlbumUploadSubject('other')">上传·用户</button>
        </div>
      ` : ''}
    </div>
    ${list.length
      ? `<div class="album-media-grid">${list.map(it => renderGridTile(it)).join('')}</div>`
      : `<div class="empty-state"><div class="empty-text">还没有内容<br>角色生成的会自动出现，也可点右上角上传</div></div>`}
  `;
}

function renderGridTile(item) {
  const type = item.media_type || 'image';
  let thumb = '';
  if (type === 'image') {
    thumb = `<img src="${escapeHtml(albumMediaUrl(item.url))}" alt="" loading="lazy">`;
  } else if (type === 'video') {
    thumb = `
      <video src="${escapeHtml(albumMediaUrl(item.url))}" muted playsinline preload="metadata"></video>
      <span class="album-tile-badge">视频</span>
    `;
  } else {
    thumb = `
      <div class="album-tile-voice">♪</div>
      <span class="album-tile-badge">语音</span>
    `;
  }
  return `
    <button type="button" class="album-tile" onclick="openAlbumDetail(${item.id})">
      ${thumb}
      ${item.source === 'robot' ? '<span class="album-tile-badge album-tile-badge-robot">桌宠</span>' : ''}
    </button>
  `;
}

window.switchAlbumType = function(type) {
  _type = type || 'all';
  if (_type === 'voice') _subject = 'all';
  if (_type === 'video' || _type === 'voice') _uploadSubject = _type === 'voice' ? 'other' : _uploadSubject;
  renderAlbumGrid();
};

window.switchAlbumSubject = function(subject) {
  _subject = subject || 'all';
  if (_subject === 'other' || _subject === 'self') _uploadSubject = _subject;
  renderAlbumGrid();
};

window.setAlbumUploadSubject = function(subject) {
  _uploadSubject = subject === 'other' ? 'other' : 'self';
  renderAlbumGrid();
};

function renderViewerMedia(item) {
  const type = item.media_type || 'image';
  if (type === 'image') {
    return `<img class="album-viewer-media" src="${escapeHtml(albumMediaUrl(item.url))}" alt="">`;
  }
  if (type === 'video') {
    return `<video class="album-viewer-media" src="${escapeHtml(albumMediaUrl(item.url))}" controls playsinline></video>`;
  }
  return `<div class="album-viewer-voice"><div class="album-viewer-voice-icon">♪</div><audio src="${escapeHtml(albumMediaUrl(item.url))}" controls></audio></div>`;
}

function renderViewer(item) {
  const type = item.media_type || 'image';
  const subj = item.subject === 'self' ? 'self' : 'other';
  const prompt = String(item.description || '').trim();
  const note = String(item.note || '').trim();
  const dateStr = formatAlbumDate(item.created_at);
  const metaBits = [mediaTypeLabel(type)];
  if (type !== 'voice') metaBits.push(subjectLabel(subj));
  if (item.source === 'robot') metaBits.push('桌宠抓拍');
  metaBits.push(charName(_charId));

  const promptPreview = prompt || '暂无标题';
  const notePreview = note || '暂无心得';
  const canSwipe = filteredItems().length > 1;

  return `
    <div class="album-viewer-top">
      <button type="button" class="album-viewer-icon-btn" onclick="closeAlbumDetail()" title="关闭" aria-label="关闭">
        <span class="album-viewer-back"></span>
      </button>
      <div class="album-viewer-top-title">${escapeHtml(mediaTypeLabel(type))}</div>
      <button type="button" class="album-viewer-icon-btn" onclick="downloadAlbumItem(${item.id})" title="下载">${ICON_DOWNLOAD}</button>
      <button type="button" class="album-viewer-icon-btn album-viewer-icon-btn-danger" onclick="deleteAlbumItem(${item.id})" title="删除">${ICON_TRASH}</button>
    </div>
    <div class="album-viewer-stage" id="album-viewer-stage">
      ${renderViewerMedia(item)}
    </div>
    <div class="album-viewer-info ${_promptOpen ? 'is-expanded' : ''}">
      ${dateStr ? `<div class="album-viewer-date">${escapeHtml(dateStr)}</div>` : ''}
      <div class="album-viewer-meta">${escapeHtml(metaBits.join(' · '))}${canSwipe ? ' · 左右滑切换' : ''}</div>
      <button type="button" class="album-prompt-toggle" onclick="toggleAlbumPrompt()">
        <span class="album-prompt-label">标题</span>
        <span class="album-prompt-preview">${escapeHtml(promptPreview)}</span>
        <span class="album-prompt-chevron">${_promptOpen ? '▾' : '›'}</span>
      </button>
      <div class="album-prompt-body" style="display:${_promptOpen ? '' : 'none'}">
        ${type !== 'voice' ? `
          <div class="album-prompt-subjects">
            <button type="button" class="tag ${subj === 'self' ? 'active' : ''}" onclick="pickAlbumDetailSubject('self')">拍自己</button>
            <button type="button" class="tag ${subj === 'other' ? 'active' : ''}" onclick="pickAlbumDetailSubject('other')">拍用户</button>
          </div>
          <input type="hidden" id="album-detail-subject" value="${subj}">
        ` : ''}
        <textarea class="input album-prompt-input" id="album-detail-desc" rows="2"
          placeholder="${subj === 'self' ? '如：仰视自拍' : '如：趴在桌上'}">${escapeHtml(prompt)}</textarea>
        <div class="album-note-block">
          <div class="album-note-label">角色心得</div>
          <textarea class="input album-note-input" id="album-detail-note" rows="3"
            placeholder="角色对这张抓拍的私密备注…">${escapeHtml(note)}</textarea>
        </div>
        <button type="button" class="btn btn-primary album-prompt-save" onclick="saveAlbumDetail(${item.id})">保存</button>
      </div>
      ${note && !_promptOpen ? `<div class="album-viewer-note-preview">${escapeHtml(notePreview)}</div>` : ''}
    </div>
  `;
}

function bindViewerGestures() {
  const stage = document.getElementById('album-viewer-stage');
  if (!stage) return;
  stage.ontouchstart = (e) => {
    const t = e.changedTouches?.[0];
    _swipeStartX = t?.clientX || 0;
    _swipeStartY = t?.clientY || 0;
  };
  stage.ontouchend = (e) => {
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - _swipeStartX;
    const dy = t.clientY - _swipeStartY;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0) stepAlbumDetail(1);
    else stepAlbumDetail(-1);
  };
}

window.openAlbumDetail = function(id) {
  const item = _items.find(i => Number(i.id) === Number(id));
  if (!item) return;
  _detailItem = item;
  _view = 'detail';
  _promptOpen = false;
  const overlay = document.getElementById('album-detail-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  overlay.classList.add('active');
  overlay.innerHTML = renderViewer(item);
  bindViewerGestures();
  hookAlbumBack();
};

let _albumGoBackOrig = null;
function hookAlbumBack() {
  if (_albumGoBackOrig) return;
  _albumGoBackOrig = window.goBack;
  window.goBack = function albumGoBack() {
    const ov = document.getElementById('album-detail-overlay');
    if (ov?.classList.contains('active')) {
      window.closeAlbumDetail();
      return;
    }
    _albumGoBackOrig?.();
  };
}

window.closeAlbumDetail = function() {
  const overlay = document.getElementById('album-detail-overlay');
  const video = overlay?.querySelector('video, audio');
  if (video) {
    try { video.pause(); } catch {}
  }
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('active');
    overlay.innerHTML = '';
  }
  _detailItem = null;
  _promptOpen = false;
  if (_view === 'detail') _view = 'grid';
  if (_albumGoBackOrig) {
    window.goBack = _albumGoBackOrig;
    _albumGoBackOrig = null;
  }
};

window.toggleAlbumPrompt = function() {
  _promptOpen = !_promptOpen;
  const info = document.querySelector('#album-detail-overlay .album-viewer-info');
  const body = document.querySelector('#album-detail-overlay .album-prompt-body');
  const chevron = document.querySelector('#album-detail-overlay .album-prompt-chevron');
  info?.classList.toggle('is-expanded', _promptOpen);
  if (body) body.style.display = _promptOpen ? '' : 'none';
  if (chevron) chevron.textContent = _promptOpen ? '▾' : '›';
};

window.pickAlbumDetailSubject = function(subject) {
  const el = document.getElementById('album-detail-subject');
  if (el) el.value = subject === 'self' ? 'self' : 'other';
  document.querySelectorAll('.album-prompt-subjects .tag').forEach(t => {
    t.classList.toggle('active', t.textContent.includes(subject === 'self' ? '自己' : '其他'));
  });
};

function stepAlbumDetail(dir) {
  const list = filteredItems();
  if (!_detailItem || list.length < 2) return;
  const idx = list.findIndex(i => Number(i.id) === Number(_detailItem.id));
  if (idx < 0) return;
  const next = list[(idx + dir + list.length) % list.length];
  if (!next) return;
  _promptOpen = false;
  openAlbumDetail(next.id);
}

window.saveAlbumDetail = async function(id) {
  const desc = document.getElementById('album-detail-desc')?.value?.trim() || '';
  const note = document.getElementById('album-detail-note')?.value?.trim() || '';
  if (!desc) { window.showToast?.('请填写标题'); return; }
  const payload = { description: desc, note };
  const subEl = document.getElementById('album-detail-subject');
  if (subEl) payload.subject = subEl.value === 'self' ? 'self' : 'other';
  try {
    await api.updateAlbumItem(id, payload);
    window.showToast?.('已保存');
    const idx = _items.findIndex(i => Number(i.id) === Number(id));
    if (idx >= 0) {
      _items[idx] = { ..._items[idx], description: desc, note, ...(payload.subject ? { subject: payload.subject } : {}) };
      _detailItem = _items[idx];
    }
    const preview = document.querySelector('#album-detail-overlay .album-prompt-preview');
    if (preview) preview.textContent = desc;
    renderAlbumGrid();
    openAlbumDetail(id);
  } catch (e) {
    window.showToast?.(e.message);
  }
};

window.downloadAlbumItem = async function(id) {
  const item = _items.find(i => Number(i.id) === Number(id)) || _detailItem;
  if (!item) return;
  try {
    window.showToast?.('正在保存到系统相册…');
    const url = resolveApiUrl(`/api/album/item/${id}/download`);
    const headers = {};
    const token = getSiteSessionToken?.() || '';
    if (token) headers['X-Nian-Session'] = token;

    // 原生优先按 URL 直写图库（大视频不走 WebView 假下载）
    const plugin = window.Capacitor?.Plugins?.AppPermissions;
    if (plugin?.saveToGallery && (window.Capacitor?.isNativePlatform?.() || window.isNativeShell?.())) {
      const extGuess = String(item.filename || '').match(/\.[a-z0-9]+$/i)?.[0]
        || (item.media_type === 'video' ? '.mp4' : item.media_type === 'voice' ? '.mp3' : '.jpg');
      const base = String(item.description || 'album').replace(/[\\/:*?"<>|\r\n]+/g, '').slice(0, 24) || 'album';
      const filename = `${base}-${item.id}${extGuess}`;
      const mime = item.media_type === 'video'
        ? 'video/mp4'
        : item.media_type === 'voice'
          ? 'audio/mpeg'
          : 'image/jpeg';
      try {
        const r = await plugin.saveToGallery({ filename, mime, url, headers });
        window.showToast?.(downloadResultToast({ ok: true, via: 'gallery', collection: r?.collection }) || '已保存');
        return;
      } catch {
        /* 再走 blob 降级 */
      }
    }

    const { blob, filename } = await api.downloadAlbumBlob(id);
    const r = await downloadBlobFile(filename || `album-${id}`, blob, blob?.type, { url, headers });
    if (r.cancelled) return;
    window.showToast?.(downloadResultToast(r) || '已保存');
  } catch (e) {
    window.showToast?.(e.message || '下载失败');
  }
};

window.triggerAlbumUpload = function() {
  if (!_charId) {
    window.showToast?.('请先打开某个角色相册');
    return;
  }
  const input = document.getElementById('album-file-input');
  if (!input) return;
  input.accept = acceptForType(uploadType());
  input.click();
};

window.handleAlbumUpload = async function(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !_charId) return;
  const mediaType = uploadType();
  try {
    window.showToast?.('上传中…');
    const up = await api.uploadAlbumFile(file, mediaType);
    const desc = file.name.replace(/\.[^.]+$/, '').slice(0, 30);
    const subject = mediaType === 'voice' ? 'other' : _uploadSubject;
    await api.createAlbumItem({
      characterId: _charId,
      mediaType,
      filename: up.filename,
      description: desc || '未命名',
      subject,
    });
    window.showToast?.('已上传');
    await loadAlbumGrid();
  } catch (err) {
    window.showToast?.('上传失败: ' + err.message);
  }
};

window.deleteAlbumItem = async function(id) {
  if (!confirm('确定删除这项素材？')) return;
  try {
    await api.deleteAlbumItem(id);
    _items = _items.filter(i => Number(i.id) !== Number(id));
    window.closeAlbumDetail();
    renderAlbumGrid();
    window.showToast?.('已删除');
  } catch (e) {
    window.showToast?.(e.message);
  }
};

// 兼容旧调用名
window.onAlbumCharChange = async function(val) {
  if (val) await openCharAlbum(val);
};
window.switchAlbumTab = window.switchAlbumType;
window.saveAlbumDesc = window.saveAlbumDetail;

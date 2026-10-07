/* ===== TA 情侣应用：你们的小世界 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { resolveApiUrl } from '../server-config.js';
import { formatTextWithInlineEmojis, openSystemEmojiOverlay, insertInlineEmojiAtCursor, ensureInlineEmojis } from '../inline-emoji.js';
import { readImageExif, formatTakenAtInput } from '../exif-lite.js';
import { pinNativeTogetherWidget, syncNativeTogetherWidget } from '../app-permissions.js';

let _snap = null;
let _loading = false;
let _todayEntries = [];
let _albumPhotos = [];
let _albumDetailId = 0;

function mediaSrc(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u) || u.startsWith('data:')) return u;
  return resolveApiUrl(u);
}

function localTodayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function avatarHtml(src, name, sizeClass = '') {
  const label = escapeHtml(name || 'TA');
  const url = mediaSrc(src);
  if (url) {
    return `<img class="ta-avatar ${sizeClass}" src="${escapeHtml(url)}" alt="${label}">`;
  }
  return `<div class="ta-avatar ta-avatar-fallback ${sizeClass}">${label.slice(0, 1)}</div>`;
}

function formatEventTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    const h = `${d.getHours()}`.padStart(2, '0');
    const min = `${d.getMinutes()}`.padStart(2, '0');
    return `${m}-${day} ${h}:${min}`;
  } catch {
    return '';
  }
}

function memoSeenKey(bookId) {
  return `ta_memo_seen_${bookId}`;
}

function memoHasUnread(memoBook) {
  if (!memoBook?.id) return false;
  const lastAt = String(memoBook.last_at || '').trim();
  if (!lastAt) return false;
  try {
    const seen = localStorage.getItem(memoSeenKey(memoBook.id)) || '';
    if (!seen) return Number(memoBook.entry_count) > 0;
    return lastAt > seen;
  } catch {
    return Number(memoBook.entry_count) > 0;
  }
}

function markMemoSeen(memoBook) {
  if (!memoBook?.id) return;
  const stamp = String(memoBook.last_at || new Date().toISOString());
  try { localStorage.setItem(memoSeenKey(memoBook.id), stamp); } catch {}
}

function entryPreview(entry) {
  const type = String(entry?.type || 'text');
  if (type === 'image') return '贴了一张图';
  if (type === 'emoji') return '贴了一个表情';
  const t = String(entry?.content || '').replace(/\s+/g, ' ').trim();
  return t || '写了一笔';
}

function entryThumb(entry) {
  const raw = (entry?.images || []).find(Boolean) || '';
  return mediaSrc(raw);
}

function usageBlockHtml(sideLabel, pack) {
  if (!pack?.ok) {
    const hint = pack?.error === 'usage_off'
      ? '未开启使用情况访问'
      : (pack?.note || pack?.error || '暂无数据');
    return `<div class="ta-usage-side"><div class="ta-usage-side-title">${escapeHtml(sideLabel)}</div><div class="ta-muted">${escapeHtml(hint)}</div></div>`;
  }
  const apps = (pack.apps || []).slice(0, 6).map((a) => `
    <div class="ta-usage-row">
      <span>${escapeHtml(a.app)}</span>
      <span class="ta-muted">${escapeHtml(a.label || `${a.minutes || 0}分钟`)}</span>
    </div>`).join('');
  return `<div class="ta-usage-side">
    <div class="ta-usage-side-title">${escapeHtml(sideLabel)} · ${escapeHtml(pack.totalLabel || '')}</div>
    ${apps || '<div class="ta-muted">今天几乎没怎么碰手机</div>'}
  </div>`;
}

function renderBindPick(chars) {
  if (!chars.length) {
    return `<div class="ta-empty">还没有角色。先去管理里创建一个。</div>`;
  }
  return `<div class="ta-pick-grid">${chars.map((c) => `
    <button type="button" class="ta-pick-card" onclick="bindTaCharacter(${c.id})">
      ${avatarHtml(c.avatar, c.name)}
      <div class="ta-pick-name">${escapeHtml(c.name)}</div>
      <div class="ta-pick-hint">邀请进小世界</div>
    </button>`).join('')}</div>`;
}

function renderTodayMemoCards(charName, entries) {
  if (!entries.length) {
    return `<button type="button" class="ta-memo-empty" onclick="openTaSharedMemo()">
      <div class="ta-memo-empty-title">今天还是空白页</div>
      <div class="ta-muted">记下想跟 ${escapeHtml(charName)} 说的话，或随手贴一张图</div>
    </button>`;
  }
  return `<div class="ta-memo-today-list">${entries.map((e) => {
    const mine = String(e.role || '') === 'user';
    const who = mine ? '我' : escapeHtml(charName || 'TA');
    const thumb = entryThumb(e);
    const time = formatEventTime(e.visible_at || e.created_at);
    return `<button type="button" class="ta-memo-slip ${mine ? 'is-mine' : 'is-ta'}" onclick="openTaSharedMemo()">
      <div class="ta-memo-slip-top">
        <span class="ta-memo-slip-who">${who}</span>
        ${time ? `<span class="ta-muted">${escapeHtml(time)}</span>` : ''}
      </div>
      <div class="ta-memo-slip-body">
        <div class="ta-memo-slip-text">${escapeHtml(entryPreview(e))}</div>
        ${thumb ? `<img class="ta-memo-slip-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      </div>
    </button>`;
  }).join('')}</div>`;
}

function renderBound(snap, todayEntries) {
  const char = snap.character || {};
  const aff = snap.affection || {};
  const settings = window.getAppSettings?.() || {};
  const meName = settings.username || '我';
  const meAvatar = settings.user_avatar || '';
  const charName = char.name || 'TA';
  const daysTogether = Number(aff.daysTogether) || 0;
  const togetherLine = (aff.togetherSince || snap.anniversary) && daysTogether > 0
    ? `在一起 ${daysTogether} 天`
    : (snap.anniversary || aff.togetherSince
      ? '从那天起，一直是我们'
      : '在角色资料里填上纪念日，这里会开始数日子');
  const stage = String(aff.stageLabel || '').trim();
  const unread = memoHasUnread(snap.memoBook);

  return `
    <div class="ta-world">
      <div class="ta-couple-hero">
        <div class="ta-couple-avatars" aria-hidden="true">
          <div class="ta-avatar-ring ta-avatar-me">${avatarHtml(meAvatar, meName, 'ta-avatar-lg')}</div>
          <div class="ta-avatar-ring ta-avatar-ta">${avatarHtml(char.avatar, charName, 'ta-avatar-lg')}</div>
          <div class="ta-couple-heart">♡</div>
        </div>
        <div class="ta-couple-names">${escapeHtml(meName)} & ${escapeHtml(charName)}</div>
        <div class="ta-couple-days">${escapeHtml(togetherLine)}</div>
        ${stage ? `<div class="ta-couple-stage">${escapeHtml(stage)}</div>` : ''}
        ${window.isNativeShell?.() ? `<button type="button" class="ta-widget-pin" onclick="pinTaTogetherWidget()">放到桌面小组件</button>` : ''}
      </div>

      <div class="ta-section">
        <div class="ta-section-head">
          <div class="ta-section-title">随手记 ${unread ? '<span class="ta-dot" title="有新内容"></span>' : ''}</div>
          <button type="button" class="ta-section-link" onclick="openTaSharedMemo()">整本 ›</button>
        </div>
        <div class="ta-memo-panel">
          <div class="ta-memo-panel-label">今天</div>
          ${renderTodayMemoCards(charName, todayEntries)}
        </div>
      </div>

      <div class="ta-section">
        <div class="ta-section-head">
          <div class="ta-section-title">相册</div>
          <button type="button" class="ta-section-link" onclick="openTaAlbum()">打开 ›</button>
        </div>
        <button type="button" class="ta-album-panel" onclick="openTaAlbum()">
          ${snap.album?.latestUrl
            ? `<img class="ta-album-cover" src="${escapeHtml(mediaSrc(snap.album.latestUrl))}" alt="" loading="lazy" onerror="this.remove()">
               <div class="ta-album-panel-meta">
                 <div class="ta-album-panel-title">我们的相册</div>
                 <div class="ta-muted">${Number(snap.album.count) || 0} 张 · 可互相留言</div>
               </div>`
            : `<div class="ta-album-panel-meta">
                 <div class="ta-album-panel-title">我们的相册</div>
                 <div class="ta-muted">上传一张带时间地点的照片，${escapeHtml(charName)} 也会慢慢往里塞</div>
               </div>`}
        </button>
        <button type="button" class="ta-studio-panel" onclick="openTaStudioAlbum()">
          ${snap.studioAlbum?.latestUrl
            ? `<div class="ta-studio-panel-stack">
                 <img src="${escapeHtml(mediaSrc(snap.studioAlbum.latestUrl))}" alt="" loading="lazy" onerror="this.remove()">
               </div>
               <div class="ta-album-panel-meta">
                 <div class="ta-album-panel-title">写真集</div>
                 <div class="ta-muted">${Number(snap.studioAlbum.count) || 0} 张 · 写真馆合影</div>
               </div>`
            : `<div class="ta-studio-panel-empty">写真集</div>
               <div class="ta-album-panel-meta">
                 <div class="ta-album-panel-title">写真集</div>
                 <div class="ta-muted">在桌面「写真馆」拍的合影会收在这里</div>
               </div>`}
        </button>
      </div>

      <div class="ta-section">
        <div class="ta-section-head">
          <div class="ta-section-title">信箱 ${Number(snap.mailbox?.unread) > 0 ? '<span class="ta-dot" title="有新来信"></span>' : ''}</div>
          <button type="button" class="ta-section-link" onclick="openTaMailbox()">打开 ›</button>
        </div>
        <button type="button" class="ta-mail-panel" onclick="openTaMailbox()">
          ${snap.mailbox?.preview
            ? `<div class="ta-mail-preview-who">${snap.mailbox.preview.role === 'user' ? '我寄出的' : 'TA 寄来的'} · ${escapeHtml(snap.mailbox.preview.transitHint || snap.mailbox.preview.status || '')}</div>
               <div class="ta-mail-preview-text">${escapeHtml(snap.mailbox.preview.excerpt || '……')}</div>`
            : `<div class="ta-mail-preview-who">来信与回信</div>
               <div class="ta-muted">在这里拆信。写信请去桌面「邮局」，投递走未知邮路。</div>`}
          ${Number(snap.mailbox?.inTransit) > 0
            ? `<div class="ta-mail-transit">${snap.mailbox.inTransit} 封还在路上</div>`
            : ''}
        </button>
        <button type="button" class="ta-section-link" style="margin-top:8px" onclick="openPostOfficeCompose({category:'letter'})">去邮局写信 ›</button>
      </div>

      <div class="ta-section">
        <div class="ta-section-title">我们的小约定</div>
        <div class="ta-promise-card">
          <div class="ta-row-between">
            <div>
              <div class="ta-card-title">互相看看在忙什么</div>
              <div class="ta-muted">打开后，你俩都能在这里看到对方今天的 App 使用概况</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="ta-share-usage" ${snap.shareUsage ? 'checked' : ''} onchange="toggleTaShareUsage(this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>
          ${snap.shareUsage && snap.usage ? `
            <div class="ta-usage-grid">
              ${usageBlockHtml('你', snap.usage.user)}
              ${usageBlockHtml(charName, snap.usage.character)}
            </div>` : (snap.shareUsage ? '<div class="ta-muted" style="margin-top:10px">加载时长中…</div>' : '')}
        </div>
        <div class="ta-promise-card">
          <div class="ta-row-between">
            <div>
              <div class="ta-card-title">电量通知</div>
              <div class="ta-muted">打开后，你手机到 10% 或关机失联时，${escapeHtml(charName)} 会在 TA 里收到提醒</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="ta-battery-alert" ${snap.batteryAlert ? 'checked' : ''} onchange="toggleTaBatteryAlert(this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <button type="button" class="ta-unbind-link" onclick="unbindTaCharacter()">解除绑定</button>
    </div>
  `;
}

async function loadTodayEntries(snap) {
  _todayEntries = [];
  const bookId = snap?.memoBook?.id;
  if (!bookId) return [];
  try {
    const today = localTodayYmd();
    const entries = await api.getSharedMemoEntries(bookId, { since: today, lite: true });
    _todayEntries = (Array.isArray(entries) ? entries : [])
      .filter((e) => String(e.visible_at || e.created_at || '').slice(0, 10) >= today
        || !e.visible_at)
      .sort((a, b) => {
        const ta = String(a.visible_at || a.created_at || '');
        const tb = String(b.visible_at || b.created_at || '');
        return tb.localeCompare(ta) || (Number(b.id) - Number(a.id));
      })
      .slice(0, 12);
  } catch {
    _todayEntries = [];
  }
  return _todayEntries;
}

async function loadSnap() {
  _snap = await api.getTa();
  syncTogetherWidgetFromSnap(_snap);
  return _snap;
}

function syncTogetherWidgetFromSnap(snap) {
  if (!window.isNativeShell?.()) return;
  try {
    const char = snap?.character || {};
    const aff = snap?.affection || {};
    const mood = snap?.mood || {};
    const presence = snap?.presence || {};
    const since = String(aff.togetherSince || snap?.anniversary || '').slice(0, 10);
    const asleep = !!(mood.asleep || presence.asleep);
    syncNativeTogetherWidget({
      characterId: Number(snap?.characterId) || 0,
      name: char.name || 'TA',
      togetherSince: since,
      daysTogether: Number(aff.daysTogether) || 0,
      moodPrimary: asleep ? 'tired' : (mood.primary || ''),
      moodLabel: asleep ? (mood.label || '睡觉') : (mood.label || ''),
      moodEmoji: asleep ? (mood.display || mood.emoji || '😴') : (mood.display || mood.emoji || char.mood || ''),
      activity: mood.activity || presence.activity || '',
      asleep,
    });
  } catch {}
}

async function paint() {
  const page = document.getElementById('ta-page');
  if (!page) return;
  const body = document.getElementById('ta-body');
  if (!body) return;
  body.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const snap = await loadSnap();
    if (!snap.characterId) {
      const chars = window.getAppCharacters?.() || await api.getCharacters?.() || [];
      body.innerHTML = `
        <div class="ta-intro">
          <div class="ta-intro-kicker">TA</div>
          <div class="ta-intro-title">你们的小世界</div>
          <div class="ta-intro-desc">选一个角色进来。随手记、在一起的日子、小约定，都只属于你们俩。</div>
        </div>
        ${renderBindPick(chars)}`;
    } else {
      const todayEntries = await loadTodayEntries(snap);
      body.innerHTML = renderBound(snap, todayEntries);
    }
  } catch (e) {
    body.innerHTML = `<div class="ta-empty">${escapeHtml(e.message || '加载失败')}</div>`;
  }
}

window.initTaPage = async function() {
  const page = document.getElementById('ta-page');
  if (!page) return;
  if (page.dataset.shellBuilt !== 'ta-v2') {
    page.innerHTML = `
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
        <div class="topbar-title">TA</div>
        <div class="topbar-actions"></div>
      </div>
      <div class="scroll-area ta-scroll" id="ta-body"></div>`;
    page.dataset.shellBuilt = 'ta-v2';
  }
  await paint();
};

window.bindTaCharacter = async function(characterId) {
  if (_loading) return;
  _loading = true;
  try {
    await api.bindTa(characterId);
    window.showToast?.('欢迎进来');
    await paint();
  } catch (e) {
    window.showToast?.(e.message || '绑定失败');
  } finally {
    _loading = false;
  }
};

window.pinTaTogetherWidget = async function() {
  if (!window.isNativeShell?.()) {
    window.showToast?.('请在手机 App 里添加');
    return;
  }
  try {
    if (_snap) syncTogetherWidgetFromSnap(_snap);
    const r = await pinNativeTogetherWidget();
    window.showToast?.(r?.prompted === false
      ? '当前桌面不支持直接添加，请长按桌面空白处选「念 → 在一起」'
      : '请在系统弹窗里确认放到桌面');
  } catch (e) {
    window.showToast?.(e.message || '添加失败，可长按桌面空白处 → 小组件 → 念');
  }
};

window.unbindTaCharacter = async function() {
  if (_loading) return;
  if (!confirm('确定离开这个小世界？解绑后情侣信息和约定会从 TA 里消失。')) return;
  _loading = true;
  try {
    await api.unbindTa();
    window.showToast?.('已解绑');
    await paint();
  } catch (e) {
    window.showToast?.(e.message || '解绑失败');
  } finally {
    _loading = false;
  }
};

window.toggleTaShareUsage = async function(on) {
  try {
    await api.setTaShareUsage(!!on);
    await paint();
  } catch (e) {
    window.showToast?.(e.message || '设置失败');
    await paint();
  }
};

window.toggleTaBatteryAlert = async function(on) {
  try {
    await api.setTaBatteryAlert(!!on);
    await paint();
  } catch (e) {
    window.showToast?.(e.message || '设置失败');
    await paint();
  }
};

window.openTaSharedMemo = async function() {
  try {
    const snap = _snap || await loadSnap();
    const cid = snap.characterId;
    if (!cid) {
      window.showToast?.('请先绑定角色');
      return;
    }
    window.showToast?.('打开中…');
    const book = await api.createSharedMemo({ characterId: cid });
    markMemoSeen({
      id: book.id,
      last_at: snap.memoBook?.last_at || book.last_at || new Date().toISOString(),
    });
    window._secretBookInit = { type: 'shared', bookId: book.id };
    window._secretBackTo = 'ta';
    window.navigateTo?.('diary');
  } catch (e) {
    window.showToast?.(e.message || '打开失败');
  }
};

window.openTaMailbox = function() {
  if (!_snap?.characterId) {
    window.showToast?.('请先绑定角色');
    return;
  }
  window.navigateTo?.('mailbox');
};

window.openPostOfficeCompose = function(opts = {}) {
  window._poOpenCompose = true;
  if (opts?.category) window._poComposeCategory = opts.category;
  window.navigateTo?.('postoffice');
};

function formatAlbumTaken(iso) {
  if (!iso) return '时间未填';
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso).slice(0, 16);
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    const h = `${d.getHours()}`.padStart(2, '0');
    const min = `${d.getMinutes()}`.padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch {
    return String(iso).slice(0, 16);
  }
}

function ensureTaAlbumOverlay() {
  let el = document.getElementById('ta-album-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'ta-album-overlay';
  el.className = 'overlay fullscreen ta-album-overlay';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="sheet-full ta-album-sheet" onclick="event.stopPropagation()">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="closeTaAlbum()" title="返回"></button>
        <div class="sheet-full-title">我们的相册</div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="pickTaAlbumUpload()">上传</button>
      </div>
      <div class="ta-album-body" id="ta-album-body"></div>
    </div>`;
  el.addEventListener('click', (e) => {
    if (e.target === el) window.closeTaAlbum?.();
  });
  document.body.appendChild(el);
  return el;
}

function renderAlbumGrid(photos, charName) {
  if (!photos.length) {
    return `<div class="ta-album-empty">
      <div class="ta-album-empty-title">还没有照片</div>
      <div class="ta-muted">上传一张吧。有拍摄时间和地点最好；读不到可以手填。<br>${escapeHtml(charName || 'TA')} 大概一个月也会塞进 4～7 张。</div>
      <button type="button" class="btn btn-primary btn-sm" style="margin-top:14px" onclick="pickTaAlbumUpload()">上传照片</button>
    </div>`;
  }
  return `<div class="ta-album-grid">${photos.map((p) => `
    <button type="button" class="ta-album-cell" onclick="openTaAlbumPhoto(${p.id})">
      <img src="${escapeHtml(mediaSrc(p.url))}" alt="" loading="lazy" onerror="this.classList.add('is-broken')">
      <div class="ta-album-cell-meta">
        <span>${p.role === 'user' ? '我' : escapeHtml(charName || 'TA')}</span>
        <span>${escapeHtml(formatAlbumTaken(p.takenAt).slice(5))}</span>
      </div>
    </button>`).join('')}</div>`;
}

window.openTaAlbum = async function() {
  const snap = _snap || await loadSnap().catch(() => null);
  if (!snap?.characterId) {
    window.showToast?.('请先绑定角色');
    return;
  }
  const overlay = ensureTaAlbumOverlay();
  const body = document.getElementById('ta-album-body');
  body.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  overlay.style.display = 'flex';
  try {
    const r = await api.getTaAlbum({ limit: 80 });
    _albumPhotos = Array.isArray(r?.photos) ? r.photos : [];
    body.innerHTML = renderAlbumGrid(_albumPhotos, snap.character?.name);
  } catch (e) {
    body.innerHTML = `<div class="ta-empty">${escapeHtml(e.message || '加载失败')}</div>`;
  }
};

window.closeTaAlbum = function() {
  const overlay = document.getElementById('ta-album-overlay');
  if (overlay) overlay.style.display = 'none';
  _albumDetailId = 0;
  paint().catch(() => {});
};

window.refreshTaAlbumIfOpen = async function() {
  const overlay = document.getElementById('ta-album-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  if (_albumDetailId) {
    await window.openTaAlbumPhoto(_albumDetailId);
    return;
  }
  await window.openTaAlbum();
};

window.pickTaAlbumUpload = function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const exif = await readImageExif(file);
      let location = '';
      if (Number.isFinite(exif.lat) && Number.isFinite(exif.lng)) {
        try {
          const geo = await api.reverseGeocode(exif.lat, exif.lng);
          location = geo?.placeName || geo?.title || '';
        } catch {}
      }
      showTaAlbumUploadSheet(file, {
        takenAt: formatTakenAtInput(exif.takenAt || ''),
        location,
        lat: exif.lat,
        lng: exif.lng,
      });
    } catch (e) {
      window.showToast?.(e.message || '读取失败');
    }
  };
  input.click();
};

function showTaAlbumUploadSheet(file, meta) {
  let sheet = document.getElementById('ta-album-upload-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'ta-album-upload-sheet';
    sheet.className = 'overlay center';
    sheet.style.zIndex = '10040';
    document.body.appendChild(sheet);
  }
  const preview = URL.createObjectURL(file);
  sheet.innerHTML = `
    <div class="ta-album-upload-card" onclick="event.stopPropagation()">
      <div class="ta-album-upload-title">上传到相册</div>
      <img class="ta-album-upload-preview" src="${preview}" alt="">
      <label class="ta-album-field">拍摄时间
        <input id="ta-album-taken" class="input" type="datetime-local" value="${escapeHtml(meta.takenAt || '')}">
      </label>
      <label class="ta-album-field">地点
        <input id="ta-album-loc" class="input" type="text" maxlength="80" placeholder="读不到就手填" value="${escapeHtml(meta.location || '')}">
      </label>
      <label class="ta-album-field">说明（可选）
        <input id="ta-album-cap" class="input" type="text" maxlength="120" placeholder="一句话">
      </label>
      <div class="ta-album-upload-actions">
        <button type="button" class="btn btn-ghost" onclick="closeTaAlbumUploadSheet()">取消</button>
        <button type="button" class="btn btn-primary" id="ta-album-upload-go">上传</button>
      </div>
    </div>`;
  sheet.style.display = 'flex';
  sheet.onclick = () => window.closeTaAlbumUploadSheet?.();
  document.getElementById('ta-album-upload-go').onclick = async () => {
    const takenAt = document.getElementById('ta-album-taken')?.value || '';
    const location = document.getElementById('ta-album-loc')?.value?.trim() || '';
    const caption = document.getElementById('ta-album-cap')?.value?.trim() || '';
    if (!takenAt || !location) {
      window.showToast?.('请填拍摄时间和地点');
      return;
    }
    try {
      window.showToast?.('上传中…');
      await api.uploadTaAlbumPhoto(file, {
        takenAt: takenAt.length === 16 ? `${takenAt}:00` : takenAt,
        location,
        caption,
        lat: meta.lat,
        lng: meta.lng,
      });
      window.closeTaAlbumUploadSheet?.();
      window.showToast?.('已放入相册');
      await window.openTaAlbum();
    } catch (e) {
      window.showToast?.(e.message || '上传失败');
    }
  };
}

window.closeTaAlbumUploadSheet = function() {
  const sheet = document.getElementById('ta-album-upload-sheet');
  if (sheet) {
    sheet.style.display = 'none';
    sheet.innerHTML = '';
  }
};

window.openTaAlbumPhoto = async function(id) {
  const snap = _snap || await loadSnap().catch(() => null);
  const overlay = ensureTaAlbumOverlay();
  const body = document.getElementById('ta-album-body');
  _albumDetailId = Number(id) || 0;
  body.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  overlay.style.display = 'flex';
  try {
    await ensureInlineEmojis().catch(() => {});
    const r = await api.getTaAlbumPhoto(id);
    const p = r?.photo;
    if (!p) throw new Error('照片不存在');
    const who = p.role === 'user' ? '我' : escapeHtml(snap?.character?.name || 'TA');
    const comments = (p.comments || []).map((c) => {
      const name = c.role === 'user' ? '我' : escapeHtml(snap?.character?.name || 'TA');
      return `<div class="ta-album-comment">
        <span class="ta-album-comment-name">${name}</span>
        <span class="ta-album-comment-text">${formatTextWithInlineEmojis(c.content, { nl2br: false })}</span>
      </div>`;
    }).join('');
    body.innerHTML = `
      <div class="ta-album-detail">
        <button type="button" class="ta-album-back-link" onclick="openTaAlbum()">‹ 全部照片</button>
        <img class="ta-album-detail-img" src="${escapeHtml(mediaSrc(p.url))}" alt="">
        <div class="ta-album-detail-meta">
          <div class="ta-album-detail-who">${who} 上传</div>
          <div class="ta-muted">📅 ${escapeHtml(formatAlbumTaken(p.takenAt))}</div>
          <div class="ta-muted">📍 ${escapeHtml(p.location || '地点未填')}</div>
          ${p.caption ? `<div class="ta-album-caption">${escapeHtml(p.caption)}</div>` : ''}
        </div>
        <div class="ta-album-comments">
          <div class="ta-album-comments-title">留言</div>
          ${comments || '<div class="ta-muted">还没有留言</div>'}
        </div>
        <div class="ta-album-compose">
          <button type="button" class="btn btn-ghost btn-sm" onclick="openTaAlbumBeanEmoji()" title="小黄豆">☺</button>
          <input id="ta-album-comment-input" class="input" type="text" maxlength="160" placeholder="留一句…">
          <button type="button" class="btn btn-primary btn-sm" onclick="sendTaAlbumComment(${p.id})">发送</button>
        </div>
        ${p.role === 'user' ? `<button type="button" class="ta-unbind-link" onclick="deleteTaAlbumPhoto(${p.id})">删除这张</button>` : ''}
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="ta-empty">${escapeHtml(e.message || '加载失败')}</div>`;
  }
};

window.openTaAlbumBeanEmoji = async function() {
  const input = document.getElementById('ta-album-comment-input');
  await openSystemEmojiOverlay({
    targetInput: input,
    includeStickers: false,
    onPickBean: (code) => {
      insertInlineEmojiAtCursor(input, code);
    },
  });
};

window.sendTaAlbumComment = async function(photoId) {
  const input = document.getElementById('ta-album-comment-input');
  const text = String(input?.value || '').trim();
  if (!text) return;
  try {
    await api.commentTaAlbumPhoto(photoId, text);
    if (input) input.value = '';
    await window.openTaAlbumPhoto(photoId);
  } catch (e) {
    window.showToast?.(e.message || '发送失败');
  }
};

window.deleteTaAlbumPhoto = async function(id) {
  if (!confirm('删除这张照片？留言也会一起没。')) return;
  try {
    await api.deleteTaAlbumPhoto(id);
    window.showToast?.('已删除');
    _albumDetailId = 0;
    await window.openTaAlbum();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

window.deleteTaSharedMemo = async function() {
  try {
    const snap = _snap || await loadSnap();
    const bookId = snap.memoBook?.id;
    if (!bookId) {
      window.showToast?.('还没有随手记');
      return;
    }
    if (!confirm('删除整本随手记？不可恢复。')) return;
    await api.deleteSharedMemo(bookId);
    window.showToast?.('已删除');
    await paint();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

/* ===== TA 写真集（相片集风格） ===== */
let _studioPhotos = [];
let _studioDetailId = 0;

function ensureTaStudioOverlay() {
  let el = document.getElementById('ta-studio-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'ta-studio-overlay';
  el.className = 'overlay fullscreen ta-studio-overlay';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="sheet-full ta-studio-sheet" onclick="event.stopPropagation()">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="closeTaStudioAlbum()" title="返回"></button>
        <div class="sheet-full-title">写真集</div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="navigateTo('photostudio')">去拍</button>
      </div>
      <div class="ta-studio-body" id="ta-studio-body"></div>
    </div>`;
  el.addEventListener('click', (e) => {
    if (e.target === el) window.closeTaStudioAlbum?.();
  });
  document.body.appendChild(el);
  return el;
}

function renderStudioBook(photos) {
  if (!photos.length) {
    return `<div class="ta-album-empty">
      <div class="ta-album-empty-title">写真集还是空的</div>
      <div class="ta-muted">去桌面「写真馆」拍一组合影，成片会像相片集一样收在这里。</div>
      <button type="button" class="btn btn-primary btn-sm" style="margin-top:14px" onclick="navigateTo('photostudio')">打开写真馆</button>
    </div>`;
  }
  return `<div class="ta-studio-book">${photos.map((p, i) => `
    <button type="button" class="ta-studio-page ${i % 2 ? 'tilt-r' : 'tilt-l'}" onclick="openTaStudioPhoto(${p.id})">
      <img src="${escapeHtml(mediaSrc(p.url))}" alt="" loading="lazy">
      <div class="ta-studio-caption">${escapeHtml(p.caption || '写真馆合影')}</div>
    </button>`).join('')}</div>`;
}

window.openTaStudioAlbum = async function() {
  const snap = _snap || await loadSnap().catch(() => null);
  if (!snap?.characterId) {
    window.showToast?.('请先绑定角色');
    return;
  }
  const overlay = ensureTaStudioOverlay();
  const body = document.getElementById('ta-studio-body');
  body.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  overlay.style.display = 'flex';
  try {
    const r = await api.getTaStudioAlbum({ limit: 80 });
    _studioPhotos = Array.isArray(r?.photos) ? r.photos : [];
    body.innerHTML = renderStudioBook(_studioPhotos);
  } catch (e) {
    body.innerHTML = `<div class="ta-empty">${escapeHtml(e.message || '加载失败')}</div>`;
  }
};

window.closeTaStudioAlbum = function() {
  const overlay = document.getElementById('ta-studio-overlay');
  if (overlay) overlay.style.display = 'none';
  _studioDetailId = 0;
  paint().catch(() => {});
};

window.refreshTaStudioAlbumIfOpen = async function() {
  const overlay = document.getElementById('ta-studio-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  if (_studioDetailId) {
    await window.openTaStudioPhoto(_studioDetailId);
    return;
  }
  await window.openTaStudioAlbum();
};

window.openTaStudioPhoto = async function(id) {
  const overlay = ensureTaStudioOverlay();
  const body = document.getElementById('ta-studio-body');
  _studioDetailId = Number(id) || 0;
  const photo = _studioPhotos.find((p) => Number(p.id) === _studioDetailId);
  if (!photo) {
    await window.openTaStudioAlbum();
    return;
  }
  overlay.style.display = 'flex';
  body.innerHTML = `
    <div class="ta-studio-detail">
      <button type="button" class="btn btn-ghost btn-sm" onclick="openTaStudioAlbum()">‹ 返回相片集</button>
      <div class="ta-studio-detail-frame">
        <img src="${escapeHtml(mediaSrc(photo.url))}" alt="">
      </div>
      <div class="ta-studio-detail-cap">${escapeHtml(photo.caption || '写真馆合影')}</div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="deleteTaStudioPhoto(${photo.id})">删除</button>
    </div>`;
};

window.deleteTaStudioPhoto = async function(id) {
  if (!confirm('从写真集里删除这张？')) return;
  try {
    await api.deleteTaStudioPhoto(id);
    window.showToast?.('已删除');
    _studioDetailId = 0;
    await window.openTaStudioAlbum();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

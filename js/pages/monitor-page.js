/* ===== 居家监控 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { resolveApiUrl } from '../server-config.js';

const CLOCK_MS = 30 * 1000;
const DEFAULT_ROOMS = ['客厅', '卧室', '厨房', '书房', '阳台', '浴室', '玄关'];
const SCENE_PLACEHOLDER = '无信号';
const ROOM_CAM_CH = {
  客厅: 'CH01', 卧室: 'CH02', 厨房: 'CH03', 书房: 'CH04',
  阳台: 'CH05', 浴室: 'CH06', 玄关: 'CH07',
};

let _characters = [];
let _charId = 0;
let _char = null;
let _state = null;
let _loading = false;
let _capturing = false;
let _savingDesc = false;
let _editingDesc = false;
let _editDescDraft = '';
let _selectedRoom = '客厅';
let _roomPinned = false;
let _clockTimer = null;
let _slotRefreshTimer = null;

function charId() {
  return Number(window._monitorCharId || window.getActiveCharId?.() || 0);
}

function displayName(c) {
  const ch = c || _char;
  return String(ch?.display_name || ch?.name || 'TA').trim();
}

function mediaSrc(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u) || u.startsWith('data:')) return u;
  return resolveApiUrl(u);
}

function monitorRooms() {
  const rooms = _state?.monitor_rooms;
  return Array.isArray(rooms) && rooms.length ? rooms : DEFAULT_ROOMS;
}

function normalizeRoom(room) {
  const r = String(room || '').trim();
  if (!r || r === '家中') return '客厅';
  return monitorRooms().includes(r) ? r : '客厅';
}

function localClockStr() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function isMonitorActive() {
  return document.getElementById('monitor-page')?.classList.contains('active');
}

function clearSlotRefreshTimer() {
  if (_slotRefreshTimer) {
    clearTimeout(_slotRefreshTimer);
    _slotRefreshTimer = null;
  }
}

function stopMonitorTimers() {
  clearSlotRefreshTimer();
  if (_clockTimer) {
    clearInterval(_clockTimer);
    _clockTimer = null;
  }
}

function startClockTimer() {
  if (_clockTimer) clearInterval(_clockTimer);
  _clockTimer = setInterval(() => {
    if (!isMonitorActive()) return;
    updateMonitorClockDisplay();
  }, CLOCK_MS);
}

function scheduleSlotRefresh() {
  clearSlotRefreshTimer();
  if (!isMonitorActive()) return;

  const endMins = Number(_state?.schedule_slot_end_mins);
  if (!Number.isFinite(endMins) || endMins <= 0) return;

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  let delayMs = (endMins - nowMins) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();
  if (delayMs <= 0) delayMs = 1000;

  _slotRefreshTimer = setTimeout(() => {
    if (!isMonitorActive() || _capturing || _savingDesc || _loading) return;
    _roomPinned = false;
    loadMonitorData(true);
  }, delayMs);
}

function updateMonitorClockDisplay() {
  document.querySelectorAll('#monitor-page .monitor-live-clock').forEach((el) => {
    el.textContent = localClockStr();
  });
}

function currentRoomScene() {
  const room = normalizeRoom(_selectedRoom);
  const pack = _state?.camera_scenes?.[room];
  if (pack?.text) return pack;
  if (room === normalizeRoom(_state?.view_room) && _state?.camera_scene) {
    return { text: _state.camera_scene, has_custom: false, auto: true };
  }
  return { text: '', has_custom: false, auto: true };
}

window.notifyMonitorScheduleUpdated = function(data = {}) {
  if (!isMonitorActive()) return;
  const cid = Number(data.characterId || 0);
  if (cid && cid !== _charId) return;
  if (_capturing || _savingDesc || _loading) return;
  _roomPinned = false;
  loadMonitorData(true);
};

window.destroyMonitorPage = function() {
  stopMonitorTimers();
  _editingDesc = false;
  _roomPinned = false;
  closeMonitorCapturePreview();
};

window.initMonitorPage = async function() {
  const page = document.getElementById('monitor-page');
  if (!page) return;

  try {
    _characters = window.filterFullCharacters?.(await api.getCharacters()) || await api.getCharacters();
  } catch {
    _characters = [];
  }

  _charId = charId();
  if (!_charId && _characters.length) {
    _charId = _characters[0].id;
  }
  window._monitorCharId = _charId;
  _editingDesc = false;
  _roomPinned = false;

  if (!_charId) {
    stopMonitorTimers();
    page.innerHTML = `<div class="empty-state"><div class="empty-text">请先创建角色</div></div>`;
    return;
  }

  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  startClockTimer();
  await loadMonitorData(true);
};

async function loadMonitorData(silent) {
  const page = document.getElementById('monitor-page');
  if (!page || !_charId) return;

  if (!silent) {
    _loading = true;
    renderMonitorPage();
  }

  try {
    const data = await api.getMonitor(_charId, _roomPinned ? _selectedRoom : undefined);
    _char = data.character || _char;
    _state = data.state || null;
    if (!_roomPinned) {
      _selectedRoom = normalizeRoom(_state?.inferred_room || _state?.view_room || '客厅');
    } else {
      _selectedRoom = normalizeRoom(_selectedRoom);
    }
    window.setActiveCharId?.(_charId);
  } catch (e) {
    if (!silent) {
      page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
      return;
    }
    window.showToast?.(e.message || '刷新失败', 3000);
  } finally {
    _loading = false;
  }

  renderMonitorPage();
  scheduleSlotRefresh();
}

function charAvatarHtml(c, cls = 'monitor-avatar-img') {
  const name = displayName(c);
  if (c?.avatar) {
    return `<img src="${escapeHtml(c.avatar)}" alt="" class="${cls}">`;
  }
  return `<span class="monitor-avatar-fallback">${escapeHtml(name.slice(0, 1))}</span>`;
}

function renderRoomTabs() {
  const rooms = monitorRooms();
  const inferred = normalizeRoom(_state?.inferred_room);
  const atHome = !!_state?.at_home;

  return `
    <div class="monitor-room-row">
      ${rooms.map((room) => {
        const active = room === normalizeRoom(_selectedRoom);
        const live = atHome && room === inferred;
        return `
          <button type="button" class="monitor-room-chip ${active ? 'active' : ''} ${live ? 'is-live' : ''}"
            onclick="selectMonitorRoom('${room}')">
            ${escapeHtml(room)}${live ? '<span class="monitor-room-dot" title="角色在此"></span>' : ''}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function renderStatusBlock() {
  if (!_state) return '';
  const away = !!_state.away;

  if (away) {
    const destination = escapeHtml(_state.away_destination || '外出中');
    const detail = escapeHtml(_state.activity || _state.status_line || '');
    return `
      <div class="monitor-scene-section monitor-scene-status is-away">
        <div class="monitor-scene-label">角色状态</div>
        <div class="monitor-away-line">${destination}</div>
        <div class="monitor-away-detail">${detail}</div>
        <div class="monitor-away-hint" style="font-size:11px;color:var(--text-secondary);line-height:1.55;margin-top:6px">
          监控仅看得到家里，看不到外头。等回来再继续看。</div>
      </div>
    `;
  }

  const outfitChanged = _state.outfit_changed === false;
  const hasOutfit = _state.outfit_summary && _state.outfit_summary !== '尚未搭配';
  
  const rows = [
    { label: '所在', value: _state.room || '家中' },
    { label: '活动', value: _state.activity || '—' },
    {
      label: '穿搭',
      // 如果有详细穿搭信息，优先显示详细版本
      value: _state.outfit_detail && hasOutfit
        ? _state.outfit_detail
        : (hasOutfit 
            ? (outfitChanged ? _state.outfit_summary + '（与上次无变化）' : _state.outfit_summary)
            : '尚未搭配'),
    },
    {
      // 抽出的 1～2 条「袖口卷 / 外套滑下」细节——只要有就列出来，跟"穿搭"行分开看更直观
      label: '穿戴细节',
      value: (Array.isArray(_state.outfit_focus) && _state.outfit_focus.length)
        ? _state.outfit_focus.map((h) => h?.cn).filter(Boolean).join('；')
        : '—',
    },
    { label: '时段', value: _state.schedule_time_range || (_state.schedule_time ? `${_state.schedule_time} 起` : '—') },
  ];

  return `
    <div class="monitor-scene-section monitor-scene-status">
      <div class="monitor-scene-label">角色状态</div>
      ${rows.map((r) => `
        <div class="monitor-status-row">
          <span class="monitor-status-key">${escapeHtml(r.label)}</span>
          <span class="monitor-status-val">${escapeHtml(r.value)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderCameraBlock() {
  const room = normalizeRoom(_selectedRoom);
  const scene = currentRoomScene();
  const text = String(scene.text || '').trim();
  const hint = scene.has_custom ? '手动备注' : '实况';
  const ch = ROOM_CAM_CH[room] || 'CH00';
  const clock = localClockStr();

  if (_editingDesc) {
    return `
      <div class="monitor-scene-section monitor-scene-camera is-editing">
        <div class="monitor-scene-label-row">
          <div class="monitor-scene-label">${escapeHtml(ch)} · ${escapeHtml(room)}</div>
          <span class="monitor-scene-hint">改这一路实况备注</span>
        </div>
        <textarea class="input monitor-desc-input" id="monitor-desc-input" rows="6"
          placeholder="只写这一帧能看见的：谁在哪、什么姿势、手里拿什么。不要贴居住环境原文。">${escapeHtml(_editDescDraft)}</textarea>
        <div class="monitor-desc-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="cancelMonitorDescEdit()">取消</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="saveMonitorDescEdit()"
            ${_savingDesc ? 'disabled' : ''}>${_savingDesc ? '保存中…' : '保存'}</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="monitor-scene-section monitor-scene-camera">
      <div class="monitor-scene-label-row">
        <div class="monitor-scene-label">${escapeHtml(ch)} · ${escapeHtml(room)}</div>
        <span class="monitor-scene-hint">${escapeHtml(hint)}</span>
      </div>
      <div class="monitor-camera-bezel">
        <div class="monitor-osd monitor-osd-tl">${escapeHtml(ch)}&nbsp;${escapeHtml(room)}</div>
        <div class="monitor-osd monitor-osd-tr"><span class="monitor-rec-mark">● REC</span> ${escapeHtml(clock)}</div>
        <div class="monitor-camera-feed ${text ? '' : 'is-empty'}">${text
          ? escapeHtml(text)
          : '无信号'}</div>
        <div class="monitor-osd monitor-osd-bl">WALL CAM · FIXED</div>
        <div class="monitor-scanlines" aria-hidden="true"></div>
      </div>
    </div>
  `;
}

function renderViewport() {
  const away = !!_state?.away;
  const clock = localClockStr();

  const capturingOverlay = _capturing ? `
    <div class="monitor-capturing-overlay">
      <div class="loading-spinner"></div>
      <div class="monitor-capturing-text">正在生成…</div>
    </div>
  ` : '';

  return `
    <div class="monitor-scene ${away ? 'is-away' : ''}">
      <div class="monitor-scene-header">
        <span class="monitor-live-badge"><span class="monitor-live-dot"></span>CAM · ${escapeHtml(normalizeRoom(_selectedRoom))}</span>
        <span class="monitor-live-clock">${escapeHtml(clock)}</span>
      </div>
      ${renderRoomTabs()}
      ${renderCameraBlock()}
      ${renderStatusBlock()}
      ${capturingOverlay}
    </div>
  `;
}

function renderMonitorPage() {
  const page = document.getElementById('monitor-page');
  if (!page) return;

  const curChar = _characters.find((c) => c.id === _charId) || _char;
  const away = !!_state?.away;
  const clock = localClockStr();
  const subtitle = away
    ? escapeHtml(_state?.status_line || _state?.activity || '外出中')
    : `${escapeHtml(displayName(curChar))} · <span class="monitor-live-clock">${escapeHtml(clock)}</span>`;

  const scene = currentRoomScene();
  const canClearCustom = !!scene.has_custom && !_editingDesc;

  page.innerHTML = `
    <div class="monitor-shell">
      <div class="topbar monitor-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
        <div class="monitor-topbar-center">
          <div class="topbar-title monitor-topbar-title">监控</div>
          <div class="monitor-topbar-sub ${away ? 'is-away' : ''}">${subtitle}</div>
        </div>
        <div class="monitor-topbar-actions">
          <button type="button" class="btn btn-ghost btn-icon monitor-refresh-btn"
            onclick="refreshMonitorPage()" title="刷新" ${_loading ? 'disabled' : ''}>↻</button>
          <button type="button" class="monitor-avatar-btn" onclick="cycleMonitorChar()" title="切换角色">
            ${charAvatarHtml(curChar)}
          </button>
        </div>
      </div>

      <div class="monitor-body scroll-area scroll-area-native">
        ${_loading && !_state ? '<div class="loading"><div class="loading-spinner"></div></div>' : renderViewport()}
      </div>

      <div class="monitor-toolbar">
        ${_editingDesc ? '' : `
          <button type="button" class="btn btn-ghost btn-sm" onclick="startMonitorDescEdit()"
            ${_capturing ? 'disabled' : ''}>✎ 编辑画面</button>
        `}
        ${canClearCustom ? `
          <button type="button" class="btn btn-ghost btn-sm" onclick="clearMonitorRoomScene()"
            ${_savingDesc ? 'disabled' : ''}>恢复自动</button>
        ` : ''}
        <button type="button" class="btn btn-primary btn-sm" onclick="captureMonitorShot('image')"
          ${_capturing || _editingDesc ? 'disabled' : ''}>📷 截屏</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="captureMonitorShot('video')"
          ${_capturing || _editingDesc ? 'disabled' : ''}>🎬 录屏</button>
      </div>
    </div>
  `;

  if (_editingDesc) {
    document.getElementById('monitor-desc-input')?.focus();
  }
}

window.selectMonitorRoom = function(room) {
  _selectedRoom = normalizeRoom(room);
  _roomPinned = true;
  _editingDesc = false;
  renderMonitorPage();
};

function ensureCaptureOverlay() {
  let overlay = document.getElementById('monitor-capture-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'monitor-capture-overlay';
    overlay.className = 'album-viewer monitor-capture-viewer';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);
  }
  return overlay;
}

function renderCapturePreview(data) {
  const url = mediaSrc(data?.url);
  const mode = data?.mode === 'video' ? 'video' : 'image';
  const title = mode === 'video' ? '监控录屏' : '监控截屏';
  const desc = String(data?.state?.status_line || '').trim();
  const media = mode === 'video'
    ? `<video class="album-viewer-media" src="${escapeHtml(url)}" controls autoplay playsinline></video>`
    : `<img class="album-viewer-media" src="${escapeHtml(url)}" alt="">`;

  return `
    <div class="album-viewer-top">
      <button type="button" class="album-viewer-icon-btn" onclick="closeMonitorCapturePreview()" title="关闭" aria-label="关闭">
        <span class="album-viewer-back"></span>
      </button>
      <div class="album-viewer-top-title">${escapeHtml(title)}</div>
      <div style="width:40px"></div>
    </div>
    <div class="album-viewer-stage monitor-capture-stage">
      ${media}
    </div>
    <div class="monitor-capture-footer">
      ${desc ? `<div class="monitor-capture-desc">${escapeHtml(desc)}</div>` : ''}
      <div class="monitor-capture-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick="closeMonitorCapturePreview()">关闭</button>
        <button type="button" class="btn btn-primary btn-sm" onclick="openMonitorAlbum()">查看相册</button>
      </div>
    </div>
  `;
}

function showCapturePreview(data) {
  if (!data?.url) return;
  const overlay = ensureCaptureOverlay();
  overlay.style.display = 'flex';
  overlay.classList.add('active');
  overlay.innerHTML = renderCapturePreview(data);
}

window.closeMonitorCapturePreview = function() {
  const overlay = document.getElementById('monitor-capture-overlay');
  if (!overlay) return;
  overlay.querySelector('video')?.pause();
  overlay.style.display = 'none';
  overlay.classList.remove('active');
  overlay.innerHTML = '';
};

window.openMonitorAlbum = function() {
  closeMonitorCapturePreview();
  window._albumOpenCharId = _charId;
  window.navigateTo('album');
};

window.refreshMonitorPage = async function() {
  if (_loading) return;
  _roomPinned = false;
  await loadMonitorData(false);
};

window.cycleMonitorChar = async function() {
  if (_characters.length <= 1) {
    window.showToast?.('暂无其他角色', 2000);
    return;
  }
  _editingDesc = false;
  _roomPinned = false;
  const idx = _characters.findIndex((c) => c.id === _charId);
  const next = _characters[(idx + 1) % _characters.length];
  _charId = next.id;
  window._monitorCharId = _charId;
  _state = null;
  await loadMonitorData(true);
};

window.startMonitorDescEdit = function() {
  _editDescDraft = String(currentRoomScene().text || '').trim();
  _editingDesc = true;
  renderMonitorPage();
};

window.cancelMonitorDescEdit = function() {
  _editingDesc = false;
  _editDescDraft = '';
  renderMonitorPage();
};

window.saveMonitorDescEdit = async function() {
  if (!_charId || _savingDesc) return;
  const text = document.getElementById('monitor-desc-input')?.value?.trim() || '';
  if (!text) {
    window.showToast?.('请先填写摄像头画面描述', 2500);
    return;
  }
  _savingDesc = true;
  renderMonitorPage();
  try {
    await api.saveMonitorRoomScene(_charId, _selectedRoom, text);
    _editingDesc = false;
    _editDescDraft = '';
    window.showToast?.('画面描述已保存', 2000);
    await loadMonitorData(true);
  } catch (err) {
    window.showToast?.(err.message || '保存失败', 3500);
  } finally {
    _savingDesc = false;
    renderMonitorPage();
  }
};

window.clearMonitorRoomScene = async function() {
  if (!_charId || _savingDesc) return;
  if (!confirm(`恢复「${normalizeRoom(_selectedRoom)}」为自动生成的摄像头画面？`)) return;
  _savingDesc = true;
  renderMonitorPage();
  try {
    await api.clearMonitorRoomScene(_charId, _selectedRoom);
    window.showToast?.('已恢复自动生成', 2000);
    await loadMonitorData(true);
  } catch (err) {
    window.showToast?.(err.message || '操作失败', 3500);
  } finally {
    _savingDesc = false;
    renderMonitorPage();
  }
};

window.captureMonitorShot = async function(mode) {
  if (!_charId || _capturing) return;
  const label = mode === 'video' ? '录屏' : '截屏';
  const room = normalizeRoom(_selectedRoom);
  _capturing = true;
  renderMonitorPage();
  window.showToast?.(`正在生成${room}${label}，请稍候…`, 4000);
  try {
    const data = await api.captureMonitor(_charId, mode, room);
    window.showToast?.(`${label}已保存到相册`, 3500);
    showCapturePreview(data);
  } catch (err) {
    window.showToast?.(err.message || `${label}失败`, 4500);
  } finally {
    _capturing = false;
    renderMonitorPage();
  }
};

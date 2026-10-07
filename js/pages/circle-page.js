/* ===== 圈子页面 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { pickCropAndUpload, momentsCoverAspect } from '../media-crop.js';

async function apiGet(path) {
  return api.apiFetch(path, { method: 'GET' });
}
async function apiPost(path, body) {
  return api.apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
}
async function apiPut(path, body) {
  return api.apiFetch(path, { method: 'PUT', body: JSON.stringify(body) });
}
async function apiDelete(path) {
  return api.apiFetch(path, { method: 'DELETE' });
}

const CIRCLE_COLORS = [
  '#c9a0dc', '#74b9ff', '#fd79a8', '#fdcb6e',
  '#55efc4', '#a29bfe', '#ff7675', '#81ecec',
  '#6366f1', '#f97316', '#22c55e', '#64748b',
];

let _characters = [];
let _charId = 0;
let _circles = [];
let _npcCache = new Map();
let _view = 'list'; // list | npc | moments | friends
let _npcId = 0;
let _currentCircleId = null;
let _busy = false;

function randomColor() {
  return CIRCLE_COLORS[Math.floor(Math.random() * CIRCLE_COLORS.length)];
}

function currentChar() {
  return _characters.find((c) => Number(c.id) === Number(_charId)) || null;
}

function closeAllCircleOverlays() {
  document.querySelectorAll('.circle-overlay').forEach((el) => el.remove());
}

function ensureShell() {
  const page = document.getElementById('circle-page');
  if (!page) return null;
  if (page.dataset.shellBuilt !== 'circle-v2') {
    page.innerHTML = `
      <div class="circle-shell">
        <div class="topbar circle-topbar">
          <button type="button" class="topbar-back topbar-nav-back" id="circle-back-btn" title="返回"></button>
          <div class="topbar-title" id="circle-title">圈子</div>
          <div class="topbar-actions" id="circle-actions"></div>
        </div>
        <div class="circle-char-sheet" id="circle-char-sheet" hidden>
          <div class="circle-char-sheet-panel" id="circle-char-sheet-panel"></div>
        </div>
        <div id="circle-content" class="scroll-area scroll-area-native circle-content"></div>
      </div>
    `;
    page.dataset.shellBuilt = 'circle-v2';
    document.getElementById('circle-back-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.circleGoBack();
    });
    document.getElementById('circle-char-sheet')?.addEventListener('click', (e) => {
      if (e.target?.id === 'circle-char-sheet') closeCharSheet();
    });
  }
  return page;
}

function setTitle(text) {
  const el = document.getElementById('circle-title');
  if (el) el.textContent = text;
}

function setActions(html) {
  const el = document.getElementById('circle-actions');
  if (el) el.innerHTML = html || '';
}

function charAvatarHtml(char, cls = 'circle-char-av') {
  if (!char) return `<div class="${cls} ${cls}--ph">?</div>`;
  if (char.avatar) {
    return `<img class="${cls}" src="${escapeHtml(char.avatar)}" alt="">`;
  }
  return `<div class="${cls} ${cls}--ph">${escapeHtml(String(char.name || '?').charAt(0))}</div>`;
}

function renderTopActionsForList() {
  const char = currentChar();
  setActions(`
    <button type="button" class="topbar-action circle-top-char-btn" id="circle-top-char-btn" title="切换角色">
      ${charAvatarHtml(char, 'circle-top-av')}
    </button>
    <button type="button" class="topbar-action" id="circle-add-btn" title="添加圈子">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
    </button>
  `);
  document.getElementById('circle-top-char-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleCharSheet();
  });
  document.getElementById('circle-add-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    showAddCircleSheet();
  });
}

function toggleCharSheet() {
  const sheet = document.getElementById('circle-char-sheet');
  if (!sheet) return;
  if (sheet.hidden) openCharSheet();
  else closeCharSheet();
}

function closeCharSheet() {
  const sheet = document.getElementById('circle-char-sheet');
  if (sheet) sheet.hidden = true;
}

function openCharSheet() {
  const sheet = document.getElementById('circle-char-sheet');
  const panel = document.getElementById('circle-char-sheet-panel');
  if (!sheet || !panel) return;
  panel.innerHTML = `
    <div class="circle-char-sheet-title">查看谁的圈子</div>
    ${_characters.map((c) => `
      <button type="button" class="circle-char-sheet-item${Number(c.id) === Number(_charId) ? ' active' : ''}" data-id="${c.id}">
        ${charAvatarHtml(c, 'circle-sheet-av')}
        <span>${escapeHtml(c.name || '未命名')}</span>
        ${Number(c.id) === Number(_charId) ? '<span class="circle-char-sheet-check">✓</span>' : ''}
      </button>
    `).join('') || '<div class="circle-empty-hint">还没有角色</div>'}
  `;
  panel.querySelectorAll('[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      if (!id || id === Number(_charId)) {
        closeCharSheet();
        return;
      }
      _charId = id;
      try { window.setActiveCharId?.(id); } catch {}
      closeCharSheet();
      await loadCircles();
    });
  });
  sheet.hidden = false;
}

window.circleGoBack = function() {
  closeCharSheet();
  // 优先关掉弹层，避免「返回键不灵敏」其实是点到了被遮罩挡住的主页返回
  const overlays = document.querySelectorAll('.circle-overlay');
  if (overlays.length) {
    overlays[overlays.length - 1].remove();
    return;
  }
  if (_view === 'moments' || _view === 'friends') {
    openNpcProfile(_npcId);
    return;
  }
  if (_view === 'npc') {
    showListView();
    return;
  }
  window.goBack?.();
};

window.initCirclePage = async function() {
  ensureShell();
  closeAllCircleOverlays();
  closeCharSheet();
  try {
    const all = await api.getCharacters();
    _characters = (all || []).filter((c) => !(
      c?.is_circle_npc || c?.source === 'circle_npc' || Number(c?.circle_npc_id) > 0
    ));
  } catch {
    _characters = [];
  }
  const active = Number(window.getActiveCharId?.() || 0);
  if (active && _characters.some((c) => Number(c.id) === active)) {
    _charId = active;
  } else if (_characters.length) {
    _charId = Number(_characters[0].id);
  } else {
    _charId = 0;
  }

  if (!_characters.length) {
    _view = 'list';
    setTitle('圈子');
    setActions('');
    document.getElementById('circle-content').innerHTML = `
      <div class="circle-empty">
        <div class="circle-empty-title">还没有角色</div>
        <div class="circle-empty-hint">先创建一个角色，再为 TA 管理圈子</div>
      </div>`;
    return;
  }

  const openNpcMomentsId = Number(window._circleOpenNpcMomentsId || 0);
  window._circleOpenNpcMomentsId = 0;
  if (openNpcMomentsId > 0) {
    await showListView();
    await openNpcMoments(openNpcMomentsId);
    return;
  }

  await showListView();
};

async function showListView() {
  _view = 'list';
  _npcId = 0;
  setTitle('圈子');
  renderTopActionsForList();
  await loadCircles();
}

async function loadCircles() {
  const content = document.getElementById('circle-content');
  if (!content) return;
  if (!_charId) {
    content.innerHTML = `<div class="circle-empty"><div class="circle-empty-hint">请先选择角色</div></div>`;
    return;
  }
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  const char = currentChar();
  try {
    const res = await apiGet(`/api/circles?characterId=${encodeURIComponent(_charId)}`);
    _circles = Array.isArray(res) ? res : [];
    if (!_circles.length) {
      content.innerHTML = `
        <div class="circle-char-banner">
          ${charAvatarHtml(char, 'circle-char-av-lg')}
          <div>
            <div class="circle-char-banner-name">${escapeHtml(char?.name || '角色')}的圈子</div>
            <div class="circle-char-banner-meta">管理 TA 身边的人</div>
          </div>
        </div>
        <div class="circle-empty">
          <div class="circle-empty-title">还没有圈子</div>
          <div class="circle-empty-hint">比如：同学、同事、家人……把 NPC 分门别类</div>
          <button type="button" class="btn btn-primary" id="circle-empty-create">创建第一个圈子</button>
        </div>`;
      document.getElementById('circle-empty-create')?.addEventListener('click', () => showAddCircleSheet());
      return;
    }
    content.innerHTML = `
      <div class="circle-char-banner">
        ${charAvatarHtml(char, 'circle-char-av-lg')}
        <div>
          <div class="circle-char-banner-name">${escapeHtml(char?.name || '角色')}的圈子</div>
          <div class="circle-char-banner-meta">${_circles.length} 个圈子 · 点头像可切换角色</div>
        </div>
      </div>
      <div class="circle-list">${renderCircles()}</div>
    `;
    content.querySelectorAll('[data-toggle-circle]').forEach((el) => {
      el.addEventListener('click', () => toggleCircleMembers(Number(el.dataset.toggleCircle)));
    });
    content.querySelectorAll('[data-edit-circle]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        editCircle(Number(el.dataset.editCircle));
      });
    });
    content.querySelectorAll('[data-add-npc]').forEach((el) => {
      el.addEventListener('click', () => showAddNpcSheet(Number(el.dataset.addNpc)));
    });
  } catch (e) {
    content.innerHTML = `
      <div class="circle-empty">
        <div class="circle-empty-hint">加载失败：${escapeHtml(e?.message || String(e))}</div>
        <button type="button" class="btn btn-sm" id="circle-retry">重试</button>
      </div>`;
    document.getElementById('circle-retry')?.addEventListener('click', () => loadCircles());
  }
}

function renderCircles() {
  return _circles.map((c) => `
    <div class="circle-group" id="circle-group-${c.id}">
      <div class="circle-group-header" data-toggle-circle="${c.id}">
        <div class="circle-avatar" style="background:${escapeHtml(c.color || randomColor())}">
          ${c.avatar ? `<img src="${escapeHtml(c.avatar)}" alt="">` : escapeHtml(String(c.name || '?').charAt(0))}
        </div>
        <div class="circle-group-info">
          <div class="circle-group-name">${escapeHtml(c.name)}</div>
          <div class="circle-group-meta">${c.member_count || 0} 个 NPC</div>
        </div>
        <button type="button" class="circle-group-edit" data-edit-circle="${c.id}" title="编辑">···</button>
        <div class="circle-group-arrow" id="circle-arrow-${c.id}">›</div>
      </div>
      <div class="circle-npc-list" id="circle-npcs-${c.id}" hidden>
        <div class="circle-npc-list-inner" id="circle-npcs-inner-${c.id}"></div>
        <button type="button" class="circle-add-npc-btn" data-add-npc="${c.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          添加 NPC
        </button>
      </div>
    </div>
  `).join('');
}

async function toggleCircleMembers(circleId) {
  const list = document.getElementById(`circle-npcs-${circleId}`);
  const arrow = document.getElementById(`circle-arrow-${circleId}`);
  const inner = document.getElementById(`circle-npcs-inner-${circleId}`);
  if (!list || !inner) return;
  if (list.hidden) {
    list.hidden = false;
    if (arrow) arrow.style.transform = 'rotate(90deg)';
    if (!inner.dataset.loaded) await loadCircleNpcs(circleId);
  } else {
    list.hidden = true;
    if (arrow) arrow.style.transform = '';
  }
}

async function loadCircleNpcs(circleId) {
  const inner = document.getElementById(`circle-npcs-inner-${circleId}`);
  if (!inner) return;
  inner.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const npcs = await apiGet(`/api/npcs?circleId=${circleId}`);
    _npcCache.set(circleId, npcs);
    inner.dataset.loaded = '1';
    if (!npcs.length) {
      inner.innerHTML = '<div class="circle-npc-empty">还没有人，点下方添加</div>';
      return;
    }
    inner.innerHTML = npcs.map((npc) => `
      <button type="button" class="circle-npc-card" data-npc-id="${npc.id}">
        <div class="circle-npc-avatar">
          ${npc.avatar
            ? `<img src="${escapeHtml(npc.avatar)}" alt="">`
            : `<div class="circle-npc-av-ph">${escapeHtml(String(npc.name || '?').charAt(0))}</div>`}
        </div>
        <div class="circle-npc-info">
          <div class="circle-npc-name">${escapeHtml(npc.name)}</div>
          ${npc.remark ? `<div class="circle-npc-remark">${escapeHtml(npc.remark)}</div>` : ''}
          <div class="circle-npc-badges">
            ${npc.moments_enabled ? '<span class="circle-badge">朋友圈</span>' : ''}
            ${npc.moments_mutual_with_chars ? '<span class="circle-badge circle-badge--soft">互动</span>' : ''}
          </div>
        </div>
        <span class="circle-npc-chevron">›</span>
      </button>
    `).join('');
    inner.querySelectorAll('[data-npc-id]').forEach((btn) => {
      btn.addEventListener('click', () => openNpcProfile(Number(btn.dataset.npcId)));
    });
  } catch {
    inner.innerHTML = '<div class="circle-npc-empty">加载失败</div>';
  }
}

function openOverlay({ id, title, bodyHtml, onMount }) {
  closeCharSheet();
  document.getElementById(id)?.remove();
  const sheet = document.createElement('div');
  sheet.className = 'overlay fullscreen active circle-overlay';
  sheet.id = id;
  sheet.innerHTML = `
    <div class="sheet-full circle-sheet">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back circle-sheet-back" title="返回"></button>
        <div class="sheet-full-title">${escapeHtml(title)}</div>
        <div class="circle-sheet-action-slot"></div>
      </div>
      <div class="sheet-full-body circle-sheet-body">${bodyHtml}</div>
    </div>
  `;
  sheet.querySelector('.circle-sheet-back')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sheet.remove();
  });
  // 禁止点遮罩误关编辑页；仅返回键关闭
  document.body.appendChild(sheet);
  onMount?.(sheet);
  return sheet;
}

function showAddCircleSheet() {
  if (!_charId) {
    window.showToast?.('请先选择角色');
    return;
  }
  const sheet = openOverlay({
    id: 'add-circle-sheet',
    title: '创建圈子',
    bodyHtml: `
      <div class="form-group">
        <label class="input-label">圈子名称</label>
        <input type="text" class="input" id="circle-name-input" placeholder="例如：大学同学、同事" maxlength="20">
      </div>
      <div class="form-group">
        <label class="input-label">简介（可选）</label>
        <textarea class="input" id="circle-intro-input" placeholder="这个圈子是什么关系…" maxlength="200" rows="2"></textarea>
      </div>
      <div class="form-group">
        <label class="input-label">颜色</label>
        <div class="circle-color-picker" id="circle-color-picker">
          ${CIRCLE_COLORS.map((c, i) => `
            <button type="button" class="circle-color-dot${i === 0 ? ' selected' : ''}" data-color="${c}" style="background:${c}"></button>
          `).join('')}
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-full" id="circle-create-btn">创建</button>
    `,
    onMount(sheet) {
      sheet.querySelectorAll('.circle-color-dot').forEach((opt) => {
        opt.addEventListener('click', () => {
          sheet.querySelectorAll('.circle-color-dot').forEach((o) => o.classList.remove('selected'));
          opt.classList.add('selected');
        });
      });
      sheet.querySelector('#circle-create-btn')?.addEventListener('click', () => createCircle());
      sheet.querySelector('#circle-name-input')?.focus();
    },
  });
  void sheet;
}

async function createCircle() {
  if (_busy) return;
  const name = document.getElementById('circle-name-input')?.value?.trim();
  const intro = document.getElementById('circle-intro-input')?.value?.trim();
  const color = document.querySelector('#circle-color-picker .circle-color-dot.selected')?.dataset?.color || randomColor();
  if (!name) {
    window.showToast?.('请输入圈子名称');
    return;
  }
  _busy = true;
  try {
    await apiPost('/api/circles', { name, intro, color, character_id: _charId });
    document.getElementById('add-circle-sheet')?.remove();
    window.showToast?.('圈子创建成功');
    await loadCircles();
  } catch (e) {
    window.showToast?.(e?.message || '创建失败');
  } finally {
    _busy = false;
  }
}

async function editCircle(circleId) {
  const circle = _circles.find((c) => c.id === circleId);
  if (!circle) return;
  openOverlay({
    id: 'edit-circle-sheet',
    title: '编辑圈子',
    bodyHtml: `
      <div class="form-group">
        <label class="input-label">圈子名称</label>
        <input type="text" class="input" id="edit-circle-name" value="${escapeHtml(circle.name)}" maxlength="20">
      </div>
      <div class="form-group">
        <label class="input-label">简介（可选）</label>
        <textarea class="input" id="edit-circle-intro" maxlength="200" rows="2">${escapeHtml(circle.intro || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="input-label">颜色</label>
        <div class="circle-color-picker" id="edit-circle-color-picker">
          ${CIRCLE_COLORS.map((c) => `
            <button type="button" class="circle-color-dot${c === circle.color ? ' selected' : ''}" data-color="${c}" style="background:${c}"></button>
          `).join('')}
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-full" id="circle-save-btn">保存</button>
      <button type="button" class="btn btn-ghost btn-full circle-danger-btn" id="circle-del-btn">删除圈子</button>
    `,
    onMount(sheet) {
      sheet.querySelectorAll('.circle-color-dot').forEach((opt) => {
        opt.addEventListener('click', () => {
          sheet.querySelectorAll('.circle-color-dot').forEach((o) => o.classList.remove('selected'));
          opt.classList.add('selected');
        });
      });
      sheet.querySelector('#circle-save-btn')?.addEventListener('click', () => saveCircleEdit(circleId));
      sheet.querySelector('#circle-del-btn')?.addEventListener('click', () => deleteCircle(circleId));
    },
  });
}

async function saveCircleEdit(circleId) {
  const name = document.getElementById('edit-circle-name')?.value?.trim();
  const intro = document.getElementById('edit-circle-intro')?.value?.trim();
  const color = document.querySelector('#edit-circle-color-picker .circle-color-dot.selected')?.dataset?.color;
  if (!name) {
    window.showToast?.('请输入圈子名称');
    return;
  }
  try {
    await apiPut(`/api/circles/${circleId}`, { name, intro, color, character_id: _charId });
    document.getElementById('edit-circle-sheet')?.remove();
    window.showToast?.('已保存');
    await loadCircles();
  } catch (e) {
    window.showToast?.(e?.message || '保存失败');
  }
}

async function deleteCircle(circleId) {
  if (!confirm('确定删除这个圈子？里面的 NPC 会保留，只是移出圈子。')) return;
  try {
    await apiDelete(`/api/circles/${circleId}`);
    document.getElementById('edit-circle-sheet')?.remove();
    window.showToast?.('圈子已删除');
    await loadCircles();
  } catch {
    window.showToast?.('删除失败');
  }
}

function showAddNpcSheet(circleId) {
  _currentCircleId = circleId;
  const circle = _circles.find((c) => c.id === circleId);
  openOverlay({
    id: 'add-npc-sheet',
    title: `添加 NPC · ${circle?.name || ''}`,
    bodyHtml: `
      <div class="form-group">
        <label class="input-label">名称 *</label>
        <input type="text" class="input" id="npc-name-input" placeholder="例如：张三" maxlength="20">
      </div>
      <div class="form-group">
        <label class="input-label">备注</label>
        <input type="text" class="input" id="npc-remark-input" placeholder="例如：大学室友" maxlength="40">
      </div>
      <div class="form-group">
        <label class="input-label">性别</label>
        <select class="input" id="npc-gender-input">
          <option value="">未知</option>
          <option value="male">男</option>
          <option value="female">女</option>
        </select>
      </div>
      <div class="form-group">
        <label class="input-label">简介</label>
        <textarea class="input" id="npc-intro-input" placeholder="简单介绍一下…" maxlength="200" rows="2"></textarea>
      </div>
      <div class="form-group">
        <label class="input-label">与用户的关系</label>
        <input type="text" class="input" id="npc-relation-input" placeholder="例如：老同学" maxlength="200">
      </div>
      <div class="form-group">
        <label class="input-label">语言风格</label>
        <textarea class="input" id="npc-lang-style-input" placeholder="贴几句短对话或说话习惯，扮演时参考。例如：话少、爱损人、句末带「哈」、不说「抱抱你」这类软话" maxlength="2000" rows="3"></textarea>
      </div>
      <div class="circle-divider"></div>
      <label class="circle-toggle-row">
        <span>开启朋友圈</span>
        <input type="checkbox" id="npc-moments-enabled" class="circle-check">
      </label>
      <label class="circle-toggle-row" id="moments-mutual-row" hidden>
        <span>允许与角色朋友圈互动</span>
        <input type="checkbox" id="npc-moments-mutual" class="circle-check" checked>
      </label>
      <button type="button" class="btn btn-primary btn-full" id="npc-create-btn" style="margin-top:18px">添加</button>
    `,
    onMount(sheet) {
      const momentsEnabled = sheet.querySelector('#npc-moments-enabled');
      const mutualRow = sheet.querySelector('#moments-mutual-row');
      momentsEnabled?.addEventListener('change', () => {
        mutualRow.hidden = !momentsEnabled.checked;
      });
      sheet.querySelector('#npc-create-btn')?.addEventListener('click', () => createNpc());
      sheet.querySelector('#npc-name-input')?.focus();
    },
  });
}

async function createNpc() {
  if (_busy) return;
  const name = document.getElementById('npc-name-input')?.value?.trim();
  if (!name) {
    window.showToast?.('请输入 NPC 名称');
    return;
  }
  _busy = true;
  try {
    await apiPost('/api/npcs', {
      circle_id: _currentCircleId,
      name,
      remark: document.getElementById('npc-remark-input')?.value?.trim() || '',
      gender: document.getElementById('npc-gender-input')?.value || '',
      intro: document.getElementById('npc-intro-input')?.value?.trim() || '',
      relationship: document.getElementById('npc-relation-input')?.value?.trim() || '',
      language_style: document.getElementById('npc-lang-style-input')?.value?.trim() || '',
      moments_enabled: !!document.getElementById('npc-moments-enabled')?.checked,
      moments_mutual_with_chars: !!document.getElementById('npc-moments-mutual')?.checked,
    });
    document.getElementById('add-npc-sheet')?.remove();
    window.showToast?.('已添加，并在「新的朋友」发出好友申请');
    const inner = document.getElementById(`circle-npcs-inner-${_currentCircleId}`);
    if (inner) delete inner.dataset.loaded;
    await loadCircleNpcs(_currentCircleId);
    await loadCircles();
    const list = document.getElementById(`circle-npcs-${_currentCircleId}`);
    if (list) list.hidden = false;
  } catch (e) {
    window.showToast?.(e?.message || '添加失败');
  } finally {
    _busy = false;
  }
}

async function openNpcProfile(npcId) {
  _view = 'npc';
  _npcId = npcId;
  closeCharSheet();
  closeAllCircleOverlays();
  setTitle('NPC');
  setActions(`
    <button type="button" class="topbar-action" id="npc-edit-btn" title="编辑">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>
    <button type="button" class="topbar-action topbar-action-danger" id="npc-del-btn" title="删除">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>
  `);
  const content = document.getElementById('circle-content');
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const npc = await apiGet(`/api/npcs/${npcId}`);
    const circles = await apiGet(`/api/circles?characterId=${encodeURIComponent(_charId)}`);
    const circleName = circles.find((c) => c.id === npc.circle_id)?.name || '未分组';
    setTitle(npc.name);
    content.innerHTML = `
      <div class="npc-profile">
        <div class="npc-profile-hero">
          <div class="npc-profile-avatar">
            ${npc.avatar
              ? `<img src="${escapeHtml(npc.avatar)}" alt="">`
              : `<div class="npc-profile-av-ph">${escapeHtml(String(npc.name || '?').charAt(0))}</div>`}
          </div>
          <div class="npc-profile-name">${escapeHtml(npc.name)}</div>
          ${npc.remark ? `<div class="npc-profile-remark">${escapeHtml(npc.remark)}</div>` : ''}
          ${npc.gender ? `<div class="npc-profile-gender">${npc.gender === 'male' ? '男' : '女'}</div>` : ''}
        </div>
        <div class="npc-profile-card">
          <div class="npc-profile-row"><span>简介</span><b>${npc.intro ? escapeHtml(npc.intro) : '暂无'}</b></div>
          <div class="npc-profile-row"><span>关系</span><b>${npc.relationship ? escapeHtml(npc.relationship) : '暂无'}</b></div>
          <div class="npc-profile-row"><span>性格</span><b>${npc.personality ? escapeHtml(npc.personality) : '暂无'}</b></div>
          <div class="npc-profile-row"><span>语言风格</span><b>${npc.language_style ? escapeHtml(npc.language_style) : '暂无'}</b></div>
          <div class="npc-profile-row"><span>圈子</span><b>${escapeHtml(circleName)}</b></div>
        </div>
        <div class="npc-profile-card">
          <label class="circle-toggle-row">
            <span>朋友圈</span>
            <input type="checkbox" class="circle-check" id="npc-tog-moments" ${npc.moments_enabled ? 'checked' : ''}>
          </label>
          <label class="circle-toggle-row">
            <span>与角色朋友圈互动</span>
            <input type="checkbox" class="circle-check" id="npc-tog-mutual" ${npc.moments_mutual_with_chars ? 'checked' : ''}>
          </label>
        </div>
        <div class="npc-profile-actions">
          <button type="button" class="btn btn-primary btn-full" id="npc-open-moments">查看朋友圈</button>
          <button type="button" class="btn btn-ghost btn-full" id="npc-open-friends">查看通讯录</button>
        </div>
      </div>
    `;
    document.getElementById('npc-edit-btn')?.addEventListener('click', () => editNpcProfile(npcId));
    document.getElementById('npc-del-btn')?.addEventListener('click', () => deleteNpcProfile(npcId));
    document.getElementById('npc-open-moments')?.addEventListener('click', () => openNpcMoments(npcId));
    document.getElementById('npc-open-friends')?.addEventListener('click', () => openNpcFriends(npcId));
    document.getElementById('npc-tog-moments')?.addEventListener('change', async (e) => {
      try {
        await apiPut(`/api/npcs/${npcId}`, { moments_enabled: e.target.checked });
        window.showToast?.(e.target.checked ? '朋友圈已开' : '朋友圈已关');
      } catch {
        window.showToast?.('操作失败');
        e.target.checked = !e.target.checked;
      }
    });
    document.getElementById('npc-tog-mutual')?.addEventListener('change', async (e) => {
      try {
        await apiPut(`/api/npcs/${npcId}`, { moments_mutual_with_chars: e.target.checked });
      } catch {
        window.showToast?.('操作失败');
        e.target.checked = !e.target.checked;
      }
    });
  } catch (e) {
    content.innerHTML = `
      <div class="circle-empty">
        <div class="circle-empty-hint">${escapeHtml(e?.message || '加载失败')}</div>
        <button type="button" class="btn btn-sm" id="npc-retry">重试</button>
      </div>`;
    document.getElementById('npc-retry')?.addEventListener('click', () => openNpcProfile(npcId));
  }
}

async function editNpcProfile(npcId) {
  const npc = await apiGet(`/api/npcs/${npcId}`);
  const circles = await apiGet(`/api/circles?characterId=${encodeURIComponent(_charId)}`);
  window._editNpcAvatar = npc.avatar || '';
  window._editNpcMomenCover = npc.moments_cover || '';

  openOverlay({
    id: 'edit-npc-sheet',
    title: '编辑 NPC',
    bodyHtml: `
      <div class="form-group">
        <label class="input-label">名称 *</label>
        <input type="text" class="input" id="edit-npc-name" value="${escapeHtml(npc.name)}" maxlength="20">
      </div>
      <div class="form-group">
        <label class="input-label">备注</label>
        <input type="text" class="input" id="edit-npc-remark" value="${escapeHtml(npc.remark || '')}" maxlength="40">
      </div>
      <div class="form-group">
        <label class="input-label">性别</label>
        <select class="input" id="edit-npc-gender">
          <option value="" ${!npc.gender ? 'selected' : ''}>未知</option>
          <option value="male" ${npc.gender === 'male' ? 'selected' : ''}>男</option>
          <option value="female" ${npc.gender === 'female' ? 'selected' : ''}>女</option>
        </select>
      </div>
      <div class="form-group">
        <label class="input-label">头像</label>
        <div class="circle-media-row">
          <div class="circle-avatar-preview" id="edit-npc-avatar-preview">
            ${npc.avatar
              ? `<img src="${escapeHtml(npc.avatar)}" alt="">`
              : `<span>${escapeHtml(String(npc.name || '?').charAt(0))}</span>`}
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="edit-npc-avatar-btn">更换</button>
          <button type="button" class="btn btn-ghost btn-sm" id="edit-npc-avatar-clear">清除</button>
        </div>
      </div>
      <div class="form-group">
        <label class="input-label">简介</label>
        <textarea class="input" id="edit-npc-intro" maxlength="200" rows="2">${escapeHtml(npc.intro || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="input-label">与用户的关系</label>
        <input type="text" class="input" id="edit-npc-relation" value="${escapeHtml(npc.relationship || '')}" maxlength="200">
      </div>
      <div class="form-group">
        <label class="input-label">性格</label>
        <textarea class="input" id="edit-npc-personality" maxlength="500" rows="2">${escapeHtml(npc.personality || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="input-label">语言风格</label>
        <textarea class="input" id="edit-npc-lang-style" maxlength="2000" rows="3" placeholder="贴几句短对话或说话习惯，扮演评论/发动态时参考">${escapeHtml(npc.language_style || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="input-label">所属圈子</label>
        <select class="input" id="edit-npc-circle">
          <option value="">未分组</option>
          ${circles.map((c) => `<option value="${c.id}" ${npc.circle_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="circle-divider"></div>
      <label class="circle-toggle-row">
        <span>开启朋友圈</span>
        <input type="checkbox" class="circle-check" id="edit-npc-moments" ${npc.moments_enabled ? 'checked' : ''}>
      </label>
      <label class="circle-toggle-row">
        <span>允许与角色朋友圈互动</span>
        <input type="checkbox" class="circle-check" id="edit-npc-mutual" ${npc.moments_mutual_with_chars ? 'checked' : ''}>
      </label>
      <div class="form-group" style="margin-top:14px">
        <label class="input-label">朋友圈背景</label>
        <div class="circle-cover-preview" id="edit-npc-moments-cover-preview"
          style="${npc.moments_cover ? `background-image:url('${escapeHtml(npc.moments_cover)}')` : ''}"></div>
        <div class="circle-media-row" style="margin-top:8px">
          <button type="button" class="btn btn-ghost btn-sm" id="edit-npc-cover-btn">更换背景</button>
          <button type="button" class="btn btn-ghost btn-sm" id="edit-npc-cover-clear">清除</button>
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-full" id="edit-npc-save" style="margin-top:18px">保存</button>
    `,
    onMount(sheet) {
      sheet.querySelector('#edit-npc-avatar-btn')?.addEventListener('click', () => changeNpcAvatar());
      sheet.querySelector('#edit-npc-avatar-clear')?.addEventListener('click', () => clearNpcAvatar());
      sheet.querySelector('#edit-npc-cover-btn')?.addEventListener('click', () => changeNpcMomentsCover());
      sheet.querySelector('#edit-npc-cover-clear')?.addEventListener('click', () => clearNpcMomentsCover());
      sheet.querySelector('#edit-npc-save')?.addEventListener('click', () => saveNpcProfile(npcId));
    },
  });
}

async function saveNpcProfile(npcId) {
  if (_busy) return;
  const name = document.getElementById('edit-npc-name')?.value?.trim();
  if (!name) {
    window.showToast?.('请输入名称');
    return;
  }
  const circleRaw = document.getElementById('edit-npc-circle')?.value;
  _busy = true;
  try {
    await apiPut(`/api/npcs/${npcId}`, {
      name,
      remark: document.getElementById('edit-npc-remark')?.value?.trim() || '',
      gender: document.getElementById('edit-npc-gender')?.value || '',
      intro: document.getElementById('edit-npc-intro')?.value?.trim() || '',
      relationship: document.getElementById('edit-npc-relation')?.value?.trim() || '',
      personality: document.getElementById('edit-npc-personality')?.value?.trim() || '',
      language_style: document.getElementById('edit-npc-lang-style')?.value?.trim() || '',
      circle_id: circleRaw ? parseInt(circleRaw, 10) : null,
      moments_enabled: !!document.getElementById('edit-npc-moments')?.checked,
      moments_mutual_with_chars: !!document.getElementById('edit-npc-mutual')?.checked,
      avatar: window._editNpcAvatar || '',
      moments_cover: window._editNpcMomenCover || '',
    });
    document.getElementById('edit-npc-sheet')?.remove();
    window.showToast?.('已保存');
    await openNpcProfile(npcId);
  } catch (e) {
    window.showToast?.(e?.message || '保存失败');
  } finally {
    _busy = false;
  }
}

async function changeNpcAvatar() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await pickCropAndUpload(file, { aspect: 1, title: '裁剪头像', confirmText: '完成' });
      if (result?.url) {
        window._editNpcAvatar = result.url;
        const preview = document.getElementById('edit-npc-avatar-preview');
        if (preview) preview.innerHTML = `<img src="${escapeHtml(result.url)}" alt="">`;
      }
    } catch (err) {
      if (err?.message !== 'User cancelled') window.showToast?.('上传失败');
    }
  };
  input.click();
}

function clearNpcAvatar() {
  window._editNpcAvatar = '';
  const preview = document.getElementById('edit-npc-avatar-preview');
  const name = document.getElementById('edit-npc-name')?.value?.trim() || 'N';
  if (preview) preview.innerHTML = `<span>${escapeHtml(name.charAt(0))}</span>`;
}

async function changeNpcMomentsCover() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await pickCropAndUpload(file, {
        aspect: momentsCoverAspect(),
        title: '裁剪朋友圈背景',
        confirmText: '完成',
      });
      if (result?.url) {
        window._editNpcMomenCover = result.url;
        const preview = document.getElementById('edit-npc-moments-cover-preview');
        if (preview) {
          preview.style.backgroundImage = `url('${result.url}')`;
        }
      }
    } catch (err) {
      if (err?.message !== 'User cancelled') window.showToast?.('上传失败');
    }
  };
  input.click();
}

function clearNpcMomentsCover() {
  window._editNpcMomenCover = '';
  const preview = document.getElementById('edit-npc-moments-cover-preview');
  if (preview) preview.style.backgroundImage = '';
}

async function deleteNpcProfile(npcId) {
  if (!confirm('确定删除这个 NPC？相关朋友圈和好友关系也会删除。')) return;
  try {
    await apiDelete(`/api/npcs/${npcId}`);
    window.showToast?.('已删除');
    await showListView();
  } catch {
    window.showToast?.('删除失败');
  }
}

function formatTimeAgo(isoString) {
  if (!isoString) return '';
  const date = new Date(String(isoString).replace(' ', 'T'));
  const now = new Date();
  const diff = (now - date) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}天前`;
  return date.toLocaleDateString('zh-CN');
}

async function openNpcMoments(npcId) {
  _view = 'moments';
  _npcId = npcId;
  setActions('');
  const content = document.getElementById('circle-content');
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const npc = await apiGet(`/api/npcs/${npcId}`);
    const moments = await apiGet(`/api/npcs/${npcId}/moments`);
    setTitle(`${npc.name}的朋友圈`);
    if (npc.moments_enabled) {
      setActions(`
        <button type="button" class="topbar-action" id="npc-post-moment" title="发动态">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      `);
      document.getElementById('npc-post-moment')?.addEventListener('click', () => showNpcPostMoment(npcId));
    }
    content.innerHTML = `
      <div class="npc-moments">
        ${!npc.moments_enabled ? '<div class="circle-empty-hint" style="padding:16px">该 NPC 未开启朋友圈</div>' : ''}
        ${!moments.length ? '<div class="circle-empty"><div class="circle-empty-title">还没有动态</div></div>' : ''}
        <div class="npc-moments-list">
          ${moments.map((m) => {
            const images = Array.isArray(m.images) ? m.images : [];
            const likes = Array.isArray(m.likes) ? m.likes : [];
            return `
              <article class="npc-moment-card">
                <div class="npc-moment-header">
                  <div class="npc-moment-avatar">
                    ${npc.avatar
                      ? `<img src="${escapeHtml(npc.avatar)}" alt="">`
                      : `<div class="circle-npc-av-ph">${escapeHtml(String(npc.name || '?').charAt(0))}</div>`}
                  </div>
                  <div>
                    <div class="npc-moment-name">${escapeHtml(npc.name)}</div>
                    <div class="npc-moment-time">${formatTimeAgo(m.created_at)}</div>
                  </div>
                </div>
                <div class="npc-moment-content">${escapeHtml(m.content || '')}</div>
                ${images.length ? `<div class="npc-moment-images">${images.map((img) => `<img src="${escapeHtml(img)}" alt="">`).join('')}</div>` : ''}
                <div class="npc-moment-footer">
                  <div class="npc-moment-likes">${likes.length ? `♥ ${escapeHtml(likes.join(', '))}` : ''}</div>
                  <div class="npc-moment-actions">
                    <button type="button" class="btn btn-ghost btn-sm" data-like="${m.id}">赞</button>
                    <button type="button" class="btn btn-ghost btn-sm" data-comment="${m.id}">评论</button>
                  </div>
                </div>
              </article>
            `;
          }).join('')}
        </div>
      </div>
    `;
    content.querySelectorAll('[data-like]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await apiPost(`/api/npcs/${npcId}/moments/${btn.dataset.like}/like`, { likerName: '我' });
          await openNpcMoments(npcId);
        } catch {
          window.showToast?.('操作失败');
        }
      });
    });
    content.querySelectorAll('[data-comment]').forEach((btn) => {
      btn.addEventListener('click', () => showNpcMomentComments(npcId, Number(btn.dataset.comment)));
    });
  } catch (e) {
    content.innerHTML = `<div class="circle-empty"><div class="circle-empty-hint">${escapeHtml(e?.message || '加载失败')}</div></div>`;
  }
}

function showNpcPostMoment(npcId) {
  openOverlay({
    id: 'post-npc-moment-sheet',
    title: '发动态',
    bodyHtml: `
      <textarea id="npc-moment-content" class="input" placeholder="这一刻的想法…" rows="5" maxlength="500"></textarea>
      <div class="circle-count"><span id="npc-moment-count">0</span>/500</div>
      <button type="button" class="btn btn-primary btn-full" id="npc-moment-submit">发布</button>
    `,
    onMount(sheet) {
      const ta = sheet.querySelector('#npc-moment-content');
      const counter = sheet.querySelector('#npc-moment-count');
      ta?.addEventListener('input', () => { if (counter) counter.textContent = String(ta.value.length); });
      sheet.querySelector('#npc-moment-submit')?.addEventListener('click', async () => {
        const content = ta?.value?.trim();
        if (!content) {
          window.showToast?.('请输入内容');
          return;
        }
        try {
          await apiPost(`/api/npcs/${npcId}/moments`, { content });
          sheet.remove();
          window.showToast?.('发布成功');
          await openNpcMoments(npcId);
        } catch {
          window.showToast?.('发布失败');
        }
      });
      ta?.focus();
    },
  });
}

async function showNpcMomentComments(npcId, momentId) {
  const comments = await apiGet(`/api/npcs/${npcId}/moments/${momentId}/comments`);
  openOverlay({
    id: 'npc-comments-sheet',
    title: '评论',
    bodyHtml: `
      <div class="npc-comments-list" id="npc-comments-list">
        ${!comments.length ? '<div class="circle-empty-hint">还没有评论</div>' : ''}
        ${comments.map((c) => `
          <div class="npc-comment-item">
            <div class="npc-comment-author">${escapeHtml(c.author_name)}</div>
            <div class="npc-comment-content">${escapeHtml(c.content)}</div>
            <div class="npc-comment-time">${formatTimeAgo(c.created_at)}</div>
          </div>
        `).join('')}
      </div>
      <div class="npc-comment-composer">
        <input type="text" class="input" id="npc-comment-input" placeholder="写下评论…">
        <button type="button" class="btn btn-primary btn-sm" id="npc-comment-send">发送</button>
      </div>
    `,
    onMount(sheet) {
      sheet.querySelector('#npc-comment-send')?.addEventListener('click', async () => {
        const content = sheet.querySelector('#npc-comment-input')?.value?.trim();
        if (!content) return;
        try {
          await apiPost(`/api/npcs/${npcId}/moments/${momentId}/comments`, {
            author_type: 'user',
            author_id: 0,
            author_name: '我',
            content,
          });
          sheet.remove();
          window.showToast?.('已评论');
          await openNpcMoments(npcId);
        } catch {
          window.showToast?.('评论失败');
        }
      });
    },
  });
}

async function openNpcFriends(npcId) {
  _view = 'friends';
  _npcId = npcId;
  const content = document.getElementById('circle-content');
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const npc = await apiGet(`/api/npcs/${npcId}`);
    const friends = await apiGet(`/api/npcs/${npcId}/friends`);
    setTitle(`${npc.name}的好友`);
    setActions(`
      <button type="button" class="topbar-action" id="npc-add-friend" title="添加好友">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
      </button>
    `);
    document.getElementById('npc-add-friend')?.addEventListener('click', () => showAddNpcFriendSheet(npcId));
    content.innerHTML = `
      <div class="npc-friends">
        ${!friends.length ? '<div class="circle-empty"><div class="circle-empty-title">还没有好友</div></div>' : ''}
        <div class="npc-friends-list">
          ${friends.map((f) => `
            <div class="npc-friend-card">
              <div class="circle-npc-avatar">
                ${f.friend_avatar || f.avatar
                  ? `<img src="${escapeHtml(f.friend_avatar || f.avatar)}" alt="">`
                  : `<div class="circle-npc-av-ph">${escapeHtml(String(f.remark || f.friend_name || f.name || '?').charAt(0))}</div>`}
              </div>
              <div class="circle-npc-info">
                <div class="circle-npc-name">${escapeHtml(f.remark || f.friend_name || f.name || '好友')}</div>
                <div class="circle-npc-remark">${f.friend_type === 'char' ? '角色' : 'NPC'}</div>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" data-rm-friend="${f.friend_type}/${f.friend_id}">移除</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    content.querySelectorAll('[data-rm-friend]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const [friendType, friendId] = btn.dataset.rmFriend.split('/');
        if (!confirm('移除这位好友？')) return;
        try {
          await apiDelete(`/api/npcs/${npcId}/friends/${friendType}/${friendId}`);
          await openNpcFriends(npcId);
        } catch {
          window.showToast?.('移除失败');
        }
      });
    });
  } catch (e) {
    content.innerHTML = `<div class="circle-empty"><div class="circle-empty-hint">${escapeHtml(e?.message || '加载失败')}</div></div>`;
  }
}

async function showAddNpcFriendSheet(npcId) {
  let addable = [];
  try {
    const raw = await apiGet(`/api/npcs/${npcId}/addable-friends`);
    const npcs = (raw?.npcs || []).map((n) => ({
      friend_type: n.type || 'npc',
      friend_id: n.id,
      name: n.name,
      avatar: n.avatar,
    }));
    const chars = (raw?.chars || []).map((c) => ({
      friend_type: c.type || 'char',
      friend_id: c.id,
      name: c.name,
      avatar: c.avatar,
    }));
    addable = [...npcs, ...chars];
  } catch {
    addable = [];
  }
  openOverlay({
    id: 'add-npc-friend-sheet',
    title: '添加好友',
    bodyHtml: `
      ${!addable.length
        ? '<div class="circle-empty-hint">暂时没有可添加的人</div>'
        : `<div class="npc-friends-list">${addable.map((f) => `
            <button type="button" class="npc-friend-card" data-add-friend="${f.friend_type}/${f.friend_id}">
              <div class="circle-npc-avatar">
                ${f.avatar
                  ? `<img src="${escapeHtml(f.avatar)}" alt="">`
                  : `<div class="circle-npc-av-ph">${escapeHtml(String(f.name || '?').charAt(0))}</div>`}
              </div>
              <div class="circle-npc-info">
                <div class="circle-npc-name">${escapeHtml(f.name || '未命名')}</div>
                <div class="circle-npc-remark">${f.friend_type === 'char' ? '角色' : 'NPC'}</div>
              </div>
              <span class="circle-npc-chevron">＋</span>
            </button>
          `).join('')}</div>`}
    `,
    onMount(sheet) {
      sheet.querySelectorAll('[data-add-friend]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const [friendType, friendId] = btn.dataset.addFriend.split('/');
          try {
            await apiPost(`/api/npcs/${npcId}/friends`, {
              friend_type: friendType,
              friend_id: parseInt(friendId, 10),
            });
            sheet.remove();
            window.showToast?.('已添加');
            await openNpcFriends(npcId);
          } catch (e) {
            window.showToast?.(e?.message || '添加失败');
          }
        });
      });
    },
  });
}

// 兼容旧全局调用
window.backToCircleList = () => showListView();
window.loadCircles = loadCircles;
window.openNpcProfile = openNpcProfile;
window.loadNpcProfilePage = openNpcProfile;

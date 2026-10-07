/* ===== 跨时空邮局 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';

let _meta = null;
let _parcels = [];
let _chars = [];
let _view = 'list'; // list | compose | detail
let _detailId = 0;
let _sending = false;
let _draft = {
  characterId: 0,
  category: 'clothing',
  clothingSlot: 'tops',
  name: '',
  note: '',
  message: '',
  notifyTransit: false,
  imageUrl: '',
  letterContent: '',
};

function formatWhen(iso) {
  if (!iso) return '';
  try {
    const d = new Date(String(iso).replace(' ', 'T'));
    if (!Number.isFinite(d.getTime())) return String(iso).slice(0, 16);
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    const h = `${d.getHours()}`.padStart(2, '0');
    const min = `${d.getMinutes()}`.padStart(2, '0');
    return `${m}-${day} ${h}:${min}`;
  } catch {
    return '';
  }
}

function catLabel(id) {
  return (_meta?.categories || []).find((c) => c.id === id)?.label || id;
}

function statusLabel(p) {
  if (p.status === 'in_transit') return p.logisticsHint || '在路上';
  if (p.status === 'delivered') return '已签收';
  return p.status || '';
}

function ensureShell() {
  const page = document.getElementById('postoffice-page');
  if (!page) return null;
  if (page.dataset.shellBuilt !== 'po-v2') {
    page.innerHTML = `
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="poGoBack()" title="返回"></button>
        <div class="topbar-title" id="po-topbar-title">哆啦邮局</div>
        <div class="topbar-actions">
          <button type="button" class="topbar-btn" id="po-compose-btn" onclick="poOpenCompose()">寄件</button>
        </div>
      </div>
      <div class="scroll-area po-scroll" id="po-body"></div>
      <input type="file" id="po-album-input" accept="image/*" style="display:none" onchange="poHandleFile(event)">
      <input type="file" id="po-camera-input" accept="image/*" capture="environment" style="display:none" onchange="poHandleFile(event)">
    `;
    page.dataset.shellBuilt = 'po-v2';
  }
  return page;
}

function setTitle(text) {
  const el = document.getElementById('po-topbar-title');
  if (el) el.textContent = text;
  const btn = document.getElementById('po-compose-btn');
  if (btn) btn.hidden = _view !== 'list';
}

function renderList() {
  const body = document.getElementById('po-body');
  if (!body) return;
  setTitle('哆啦邮局');
  if (!_parcels.length) {
    body.innerHTML = `
      <div class="po-hero">
        <div class="po-hero-title">哆啦邮局</div>
        <div class="po-hero-desc">想要交给TA的信件或礼物就交给万能的哆啦吧！</div>
      </div>
      <div class="po-empty">
        <div class="po-empty-title">邮筒还是空的</div>
        <div class="ta-muted">选个角色，寄一封信，或从相册/拍照送件衣服、摆件。</div>
        <button type="button" class="btn btn-primary po-cta" onclick="poOpenCompose()">去寄件</button>
      </div>`;
    return;
  }
  body.innerHTML = `
    <div class="po-hero">
      <div class="po-hero-title">哆啦邮局</div>
      <div class="po-hero-desc">想要交给TA的信件或礼物就交给万能的哆啦吧！</div>
    </div>
    <div class="po-list">
      ${_parcels.map((p) => `
        <article class="po-card ${p.status === 'in_transit' ? 'is-transit' : 'is-done'}" onclick="poOpenDetail(${p.id})">
          <div class="po-card-thumb">
            ${p.image_url
              ? `<img src="${escapeHtml(p.image_url)}" alt="">`
              : `<span class="po-card-letter">信</span>`}
          </div>
          <div class="po-card-main">
            <div class="po-card-top">
              <span class="po-card-name">${escapeHtml(p.name || catLabel(p.category))}</span>
              <span class="po-chip ${p.status === 'in_transit' ? 'is-transit' : 'is-done'}">${escapeHtml(statusLabel(p))}</span>
            </div>
            <div class="po-card-meta">${escapeHtml(p.char_name || 'TA')} · ${escapeHtml(catLabel(p.category))} · ${escapeHtml(formatWhen(p.posted_at))}</div>
            ${p.note ? `<div class="po-card-note">${escapeHtml(String(p.note).slice(0, 60))}</div>` : ''}
          </div>
        </article>
      `).join('')}
    </div>`;
}

function renderCompose() {
  const body = document.getElementById('po-body');
  if (!body) return;
  setTitle('寄件');
  const cats = _meta?.categories || [];
  const slots = _meta?.clothingSlots || [];
  const isLetter = _draft.category === 'letter';
  const isClothing = _draft.category === 'clothing';

  const charOpts = _chars.map((c) =>
    `<option value="${c.id}" ${Number(_draft.characterId) === Number(c.id) ? 'selected' : ''}>${escapeHtml(c.display_name || c.name)}</option>`
  ).join('');

  body.innerHTML = `
    <div class="po-compose">
      <label class="po-field">
        <span class="po-label">收件角色</span>
        <select id="po-char" class="po-select" onchange="poDraftChar(this.value)">
          <option value="0">请选择</option>
          ${charOpts}
        </select>
      </label>

      <div class="po-label">寄什么</div>
      <div class="po-cat-grid">
        ${cats.map((c) => `
          <button type="button" class="po-cat ${ _draft.category === c.id ? 'is-on' : '' }"
            onclick="poDraftCategory('${c.id}')">${escapeHtml(c.label)}</button>
        `).join('')}
      </div>

      ${isLetter ? `
        <div class="po-paper">
          <div class="po-paper-kicker">信纸</div>
          <textarea id="po-letter" class="po-paper-input" rows="10"
            placeholder="见字如面……" oninput="poDraftLetter(this.value)">${escapeHtml(_draft.letterContent)}</textarea>
        </div>
        <label class="po-field">
          <span class="po-label">备注（可选）</span>
          <input id="po-name" class="po-input" maxlength="40" placeholder="例如：夜深人静写的"
            value="${escapeHtml(_draft.name)}" oninput="poDraftName(this.value)">
        </label>
      ` : `
        ${isClothing ? `
          <div class="po-label">服饰分类</div>
          <div class="po-cat-grid po-cat-grid-sm">
            ${slots.map((s) => `
              <button type="button" class="po-cat ${ _draft.clothingSlot === s.id ? 'is-on' : '' }"
                onclick="poDraftSlot('${s.id}')">${escapeHtml(s.label)}</button>
            `).join('')}
          </div>
        ` : ''}
        <div class="po-upload-row">
          ${_draft.imageUrl
            ? `<div class="po-preview"><img src="${escapeHtml(_draft.imageUrl)}" alt=""><button type="button" class="po-preview-x" onclick="poClearImage()">×</button></div>`
            : `<div class="po-upload-actions">
                <button type="button" class="po-upload-btn" onclick="document.getElementById('po-album-input').click()">从相册选</button>
                <button type="button" class="po-upload-btn po-upload-btn-cam" onclick="document.getElementById('po-camera-input').click()">拍照</button>
              </div>`}
        </div>
        <label class="po-field">
          <span class="po-label">物品名称</span>
          <input id="po-name" class="po-input" maxlength="40" placeholder="例如：奶油色针织开衫"
            value="${escapeHtml(_draft.name)}" oninput="poDraftName(this.value)">
        </label>
        <label class="po-field">
          <span class="po-label">物品说明（可选）</span>
          <textarea id="po-note" class="po-input po-textarea" rows="2" maxlength="400"
            placeholder="颜色、材质、想怎么用……" oninput="poDraftNote(this.value)">${escapeHtml(_draft.note)}</textarea>
        </label>
        <label class="po-field">
          <span class="po-label">随礼留言（可选）</span>
          <textarea id="po-message" class="po-input po-textarea" rows="3" maxlength="400"
            placeholder="有什么想跟礼物一起说的……签收后 TA 会看到"
            oninput="poDraftMessage(this.value)">${escapeHtml(_draft.message)}</textarea>
        </label>
      `}

      ${!isLetter ? `
        <div class="po-toggle-row">
          <div class="po-toggle-text">
            <div class="po-toggle-title">物流通知</div>
            <div class="po-toggle-hint">${_draft.notifyTransit
              ? '打开：在途时角色会知道你寄了东西，但看不到寄了什么'
              : '关闭：东西到了角色才会知道'}</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${_draft.notifyTransit ? 'checked' : ''} onchange="poDraftNotify(this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
      ` : ''}

      <div class="po-eta-hint">投递后大约几小时到几天到，邮路不准点，不会显示精确到达时间。</div>

      <button type="button" class="btn btn-primary po-send" onclick="poSubmit()" ${_sending ? 'disabled' : ''}>
        ${_sending ? '投递中…' : '投进邮筒'}
      </button>
    </div>`;
}

function renderDetail() {
  const body = document.getElementById('po-body');
  const p = _parcels.find((x) => Number(x.id) === Number(_detailId));
  if (!body) return;
  if (!p) {
    _view = 'list';
    renderList();
    return;
  }
  setTitle(p.name || catLabel(p.category));
  const logs = (p.logistics || []).slice().reverse();
  const reaction = p.reaction || {};

  body.innerHTML = `
    <div class="po-detail">
      ${p.image_url ? `<div class="po-detail-hero"><img src="${escapeHtml(p.image_url)}" alt=""></div>` : ''}
      <div class="po-detail-head">
        <div class="po-detail-title">${escapeHtml(p.name || catLabel(p.category))}</div>
        <div class="po-detail-sub">${escapeHtml(p.char_name || 'TA')} · ${escapeHtml(catLabel(p.category))} · ${escapeHtml(statusLabel(p))}</div>
      </div>
      ${p.note ? `<div class="po-detail-note"><span class="po-detail-note-k">说明</span>${escapeHtml(p.note)}</div>` : ''}
      ${p.message ? `<div class="po-detail-note po-detail-message"><span class="po-detail-note-k">留言</span>${escapeHtml(p.message)}</div>` : ''}
      ${p.category !== 'letter' ? `<div class="po-detail-sub" style="margin-top:6px">物流通知：${p.notify_transit ? '在途可感知（不知内容）' : '签收才知道'}</div>` : ''}
      ${p.category === 'letter' && p.letter_content_mine
        ? `<div class="po-paper po-paper-readonly"><div class="po-paper-kicker">信纸</div><div class="po-paper-body">${escapeHtml(p.letter_content_mine)}</div></div>`
        : ''}

      <div class="po-section-title">物流</div>
      <ol class="po-logistics">
        ${logs.map((ev, i) => `
          <li class="po-log-item ${i === 0 ? 'is-current' : ''}">
            <div class="po-log-dot"></div>
            <div class="po-log-text">${escapeHtml(ev.text || '')}</div>
            <div class="po-log-time">${escapeHtml(formatWhen(ev.at))}</div>
          </li>
        `).join('') || '<li class="ta-muted">暂无节点</li>'}
      </ol>

      ${p.status === 'delivered' ? `
        <div class="po-section-title">签收后</div>
        <div class="po-reaction">
          ${p.category === 'clothing'
            ? `<div class="ta-muted">已放入衣柜，单品带爱心标签，以后生图可以按这件穿。</div>`
            : ''}
          ${p.category === 'letter'
            ? `<div class="ta-muted">信件已进入 TA 信箱。可在信箱里等回信、拆信。</div>
               <button type="button" class="btn btn-ghost btn-sm" onclick="openTaMailbox()">打开信箱</button>`
            : ''}
          ${reaction.moment?.posted
            ? `<div class="po-moment-preview">${escapeHtml(reaction.moment.content || '已发朋友圈')}</div>`
            : (p.category !== 'letter' ? `<div class="ta-muted">这次没发朋友圈（看人设）。</div>` : '')}
          <div class="ta-muted">${reaction.chatSent ? 'TA 拆开后给你发了消息。' : 'TA 拆开后会给你发消息。'}</div>
        </div>
      ` : `<div class="po-wait ta-muted">还在跨时空邮路上。人不在家没法签收，会改约派送。节点会陆续点亮，不会显示精确到达时间。</div>`}
    </div>`;
}

function paint() {
  if (_view === 'compose') renderCompose();
  else if (_view === 'detail') renderDetail();
  else renderList();
}

async function loadData() {
  const [meta, pack, chars] = await Promise.all([
    api.getPostOfficeMeta().catch(() => ({ categories: [], clothingSlots: [] })),
    api.getPostOfficeParcels().catch(() => ({ parcels: [] })),
    api.getCharacters({ scope: 'friends' }).catch(() => []),
  ]);
  _meta = meta;
  _parcels = pack?.parcels || [];
  // 邮局只寄给好友（不含拉黑 / 摇一摇陌生人）
  _chars = (chars || []).filter((c) => String(c.contact_status || '') === 'friend'
    && String(c.peer_status || 'ok') !== 'deleted');
  if (!_draft.characterId || !_chars.some((c) => Number(c.id) === Number(_draft.characterId))) {
    const active = Number(window.getActiveCharId?.() || 0);
    const activeOk = _chars.find((c) => Number(c.id) === active);
    _draft.characterId = activeOk?.id || (_chars[0]?.id || 0);
  }
}

window.initPostofficePage = async function() {
  ensureShell();
  const body = document.getElementById('po-body');
  if (body) body.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    if (window._poOpenCompose) {
      _view = 'compose';
      if (window._poComposeCategory) {
        _draft.category = window._poComposeCategory;
        window._poComposeCategory = '';
      }
      window._poOpenCompose = false;
    }
    await loadData();
    paint();
  } catch (e) {
    if (body) body.innerHTML = `<div class="ta-empty">${escapeHtml(e.message || '加载失败')}</div>`;
  }
};

window.poGoBack = function() {
  if (_view === 'compose' || _view === 'detail') {
    _view = 'list';
    paint();
    return;
  }
  window.goBack?.();
};

window.poOpenCompose = function() {
  _view = 'compose';
  paint();
};

window.poOpenDetail = async function(id) {
  _detailId = Number(id);
  _view = 'detail';
  try {
    const pack = await api.getPostOfficeParcel(id);
    if (pack?.parcel) {
      const idx = _parcels.findIndex((p) => Number(p.id) === Number(id));
      if (idx >= 0) _parcels[idx] = { ..._parcels[idx], ...pack.parcel };
      else _parcels.unshift(pack.parcel);
    }
  } catch {}
  paint();
};

window.poDraftChar = function(v) { _draft.characterId = Number(v) || 0; };
window.poDraftCategory = function(id) {
  _draft.category = id;
  paint();
};
window.poDraftSlot = function(id) {
  _draft.clothingSlot = id;
  paint();
};
window.poDraftName = function(v) { _draft.name = v; };
window.poDraftNote = function(v) { _draft.note = v; };
window.poDraftMessage = function(v) { _draft.message = v; };
window.poDraftNotify = function(on) {
  _draft.notifyTransit = !!on;
  paint();
};
window.poDraftLetter = function(v) { _draft.letterContent = v; };
window.poClearImage = function() {
  _draft.imageUrl = '';
  paint();
};

window.poHandleFile = async function(ev) {
  const file = ev.target?.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    window.showToast?.('上传中…');
    const uploaded = await api.uploadFile(file);
    _draft.imageUrl = typeof uploaded === 'string'
      ? uploaded
      : (uploaded?.url || uploaded?.path || uploaded?.filename || '');
    if (_draft.imageUrl && !_draft.imageUrl.startsWith('/') && !_draft.imageUrl.startsWith('http')) {
      _draft.imageUrl = `/uploads/${_draft.imageUrl}`;
    }
    if (!_draft.imageUrl) throw new Error('上传失败');
    paint();
  } catch (e) {
    window.showToast?.(e.message || '上传失败');
  }
};

window.poSubmit = async function() {
  if (_sending) return;
  if (!_draft.characterId) {
    window.showToast?.('请选择收件角色');
    return;
  }
  _sending = true;
  paint();
  try {
    await api.createPostOfficeParcel({
      characterId: _draft.characterId,
      category: _draft.category,
      clothingSlot: _draft.clothingSlot,
      name: _draft.name,
      note: _draft.note,
      message: _draft.message,
      notifyTransit: !!_draft.notifyTransit,
      imageUrl: _draft.imageUrl,
      letterContent: _draft.letterContent,
    });
    window.showToast?.('已投进邮筒');
    _draft = {
      ..._draft,
      name: '',
      note: '',
      message: '',
      notifyTransit: false,
      imageUrl: '',
      letterContent: '',
    };
    _view = 'list';
    await loadData();
    paint();
  } catch (e) {
    window.showToast?.(e.message || '寄出失败');
  } finally {
    _sending = false;
    if (_view === 'compose') paint();
  }
};

window.openPostOfficeCompose = function(opts = {}) {
  window._poOpenCompose = true;
  if (opts.category) window._poComposeCategory = opts.category;
  window.navigateTo?.('postoffice');
};

/* ===== TA 信箱：未知邮路的手写信（收信 / 读信；写信改去邮局） ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';

let _pack = null;

function formatWhen(iso) {
  if (!iso) return '';
  try {
    const d = new Date(String(iso).replace(' ', 'T'));
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

function statusChip(letter) {
  if (letter.status === 'in_transit') {
    return `<span class="mbx-chip is-transit">${escapeHtml(letter.transitHint || '还在路上')}</span>`;
  }
  if (letter.status === 'delivered') {
    return `<span class="mbx-chip is-new">刚到</span>`;
  }
  if (letter.status === 'read') {
    return `<span class="mbx-chip is-read">已读</span>`;
  }
  return '';
}

function letterCardHtml(letter, charName) {
  const mine = letter.role === 'user';
  const who = mine ? '我寄出的' : `${charName || 'TA'}寄来的`;
  const body = String(letter.content || '').trim();
  const excerpt = body.replace(/\s+/g, ' ').slice(0, 160);
  const openable = !mine && (letter.status === 'delivered' || letter.status === 'read');
  return `
    <article class="mbx-card ${mine ? 'is-mine' : 'is-theirs'} ${letter.status === 'delivered' ? 'is-unread' : ''}"
      ${openable ? `onclick="openMailboxLetter(${letter.id})"` : ''}>
      <div class="mbx-card-top">
        <span class="mbx-card-who">${escapeHtml(who)}</span>
        ${statusChip(letter)}
      </div>
      ${body
        ? `<div class="mbx-card-body">${escapeHtml(excerpt)}${body.length > 160 ? '…' : ''}</div>`
        : `<div class="mbx-card-body ta-muted">正文还在邮路上，到了才能拆</div>`}
      <div class="mbx-card-meta">${escapeHtml(formatWhen(letter.posted_at))}</div>
    </article>`;
}

function renderList(pack) {
  const charName = pack?.book?.char_name || 'TA';
  const letters = pack?.letters || [];
  if (!letters.length) {
    return `<div class="mbx-empty">
      <div class="mbx-empty-title">邮筒还是空的</div>
      <div class="ta-muted">去邮局写一封给 ${escapeHtml(charName)}。投出去之后，什么时候到、会不会回，谁也不知道准点。</div>
      <button type="button" class="btn btn-primary mbx-send" style="margin-top:14px" onclick="openPostOfficeCompose({category:'letter'})">去邮局写信</button>
    </div>`;
  }
  return `<div class="mbx-list">${letters.map((l) => letterCardHtml(l, charName)).join('')}</div>`;
}

async function paint() {
  const body = document.getElementById('mailbox-body');
  if (!body) return;
  body.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    _pack = await api.getTaLetters();
    const title = document.getElementById('mailbox-topbar-title');
    if (title) {
      const name = _pack?.book?.char_name || 'TA';
      title.textContent = `信箱 · ${name}`;
    }
    body.innerHTML = `
      <div class="mbx-hero">
        <div class="mbx-hero-title">来信与回信</div>
        <div class="mbx-hero-desc">这里拆信、等回信。要写信请去「邮局」——信纸和跨时空邮路都在那边。</div>
      </div>
      ${renderList(_pack)}
      <div class="mbx-compose">
        <button type="button" class="btn btn-primary mbx-send" onclick="openPostOfficeCompose({category:'letter'})">去邮局写信</button>
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="ta-empty">${escapeHtml(e.message || '加载失败')}</div>`;
  }
}

window.initMailboxPage = async function() {
  const page = document.getElementById('mailbox-page');
  if (!page) return;
  if (page.dataset.shellBuilt !== 'mbx-v1') {
    page.innerHTML = `
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
        <div class="topbar-title" id="mailbox-topbar-title">信箱</div>
        <div class="topbar-actions"></div>
      </div>
      <div class="scroll-area mbx-scroll" id="mailbox-body"></div>`;
    page.dataset.shellBuilt = 'mbx-v1';
  }
  await paint();
};

window.openMailboxLetter = async function(id) {
  const letter = (_pack?.letters || []).find((l) => Number(l.id) === Number(id));
  if (!letter || letter.role !== 'ai') return;
  if (letter.status === 'delivered') {
    try { await api.readTaLetter(id); } catch {}
  }
  const overlay = document.createElement('div');
  overlay.className = 'overlay mbx-read-overlay';
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `
    <div class="mbx-read-sheet" onclick="event.stopPropagation()">
      <div class="mbx-read-kicker">${escapeHtml(_pack?.book?.char_name || 'TA')} 的来信</div>
      <div class="mbx-read-body">${escapeHtml(letter.content || '')}</div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.overlay').remove()">收起</button>
    </div>`;
  document.body.appendChild(overlay);
  await paint();
};

window.openPostOfficeCompose = function(opts = {}) {
  window._poOpenCompose = true;
  if (opts?.category) window._poComposeCategory = opts.category;
  window.navigateTo?.('postoffice');
};

window.openTaMailbox = function() {
  window.navigateTo?.('mailbox');
};

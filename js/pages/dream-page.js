/* ===== 梦境页 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { pickCropAndUpload } from '../media-crop.js';
import { ICON_SETTINGS } from '../ui-icons.js';

/* ─── 状态 ─── */
let _dreamCharId = null;
let _dreamConfig = null;
let _dreamMask = false;
let _dreamManageDates = [];
let _dreamLastCue = '';
let _dreamAiBusy = false;
let _dreamChoicesLoading = false;

const ERA_PRESETS = ['架空古代', '现代都市', '未来科幻', '奇幻异世界', '民国旧时光', '西幻中世纪', '赛博朋克', '自定义'];
const STYLE_OPTIONS = [
  { key: 'romantic', label: '浪漫抒情' },
  { key: 'poetic', label: '意境古风' },
  { key: 'surreal', label: '超现实' },
  { key: 'dark', label: '黑暗叙事' },
  { key: 'gentle', label: '温柔细腻' },
  { key: 'epic', label: '史诗长卷' },
  { key: 'witty', label: '轻俏机敏' },
  { key: 'custom', label: '自定义' },
];
const FREEDOM_OPTIONS = [
  { key: 'free', label: '自由', sub: '自己的部分自己写' },
  { key: 'semi', label: '半自由', sub: '短意图 → 系统扩写（可重掷）' },
  { key: 'guided', label: '不自由', sub: '三选一，走向不同结局' },
];
const TONE_OPTIONS = [
  { key: 'dream', label: '梦境', sub: '可不合逻辑、意象跳跃，但别离谱到无意义' },
  { key: 'reality', label: '现实', sub: '按现实因果推进，事件要说得通' },
];

const STYLE_PROMPTS = {
  romantic: '文笔风格：浪漫抒情，善用感官描写，情感细腻，字里行间含情。',
  poetic: '文笔风格：意境古风，语言清雅简练，多用意象与留白，有古典诗意。',
  surreal: '文笔风格：超现实，意象可跳跃、时空可错位，偏梦境与魔幻隐喻；感官非常规，少写实因果解释，多象征与荒诞美感。',
  dark: '文笔风格：黑暗叙事，气氛压抑沉重，擅长心理与命运感。',
  gentle: '文笔风格：温柔细腻，平静如水，日常小事也能触动人心。',
  epic: '文笔风格：史诗长卷感，场面开阔，节奏有张有弛。',
  witty: '文笔风格：轻俏机敏，对白有锋芒，叙述干净利落。',
};

/* ─── 工具 ─── */
function getDreamSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('dream_settings') || '{}');
    if (!s._bgMigratedV59) {
      if (!s.bg || ['purple', 'blue', 'red', 'dark', 'lavender'].includes(s.bg)) s.bg = 'white';
      s._bgMigratedV59 = true;
      try { localStorage.setItem('dream_settings', JSON.stringify(s)); } catch {}
    }
    return s;
  } catch { return {}; }
}
function saveDreamSettings(s) { localStorage.setItem('dream_settings', JSON.stringify(s)); }

function loadDreamConfig(charId) {
  try { return JSON.parse(localStorage.getItem(`dream_config_${charId}`) || '{}'); } catch { return {}; }
}
function persistDreamConfig(charId, config) {
  try { localStorage.setItem(`dream_config_${charId}`, JSON.stringify(config)); } catch {}
}

function normalizeConfig(raw = {}) {
  const freedom = ['free', 'semi', 'guided'].includes(raw.freedom) ? raw.freedom : 'free';
  const tone = raw.tone === 'reality' || raw.tone === '现实' ? 'reality' : 'dream';
  return {
    charRole: String(raw.charRole || '').trim(),
    userRole: String(raw.userRole || '').trim(),
    background: String(raw.background || '').trim(),
    era: String(raw.era || '架空古代').trim(),
    mask: !!raw.mask,
    style: raw.style || 'romantic',
    styleCustom: String(raw.styleCustom || '').trim(),
    freedom,
    tone,
  };
}

function getActiveDreamStylePrompt(config = _dreamConfig) {
  const c = normalizeConfig(config || {});
  const global = getDreamSettings();
  if (c.style === 'custom') {
    return c.styleCustom
      ? `文笔风格（必须严格遵守）：${c.styleCustom}`
      : '文笔风格：文学散文，细腻生动。';
  }
  const base = STYLE_PROMPTS[c.style] || STYLE_PROMPTS.romantic;
  const hint = String(global.presetHint || '').trim();
  return hint ? `${base} ${hint}` : base;
}

function dreamPayloadExtras() {
  const c = normalizeConfig(_dreamConfig || {});
  return {
    dreamMask: !!(c.mask || _dreamMask),
    dreamStyle: getActiveDreamStylePrompt(c),
    dreamConfig: c,
  };
}

function isSystemDreamMsg(content) {
  if (!content) return false;
  return content.startsWith('[夜深了，梦境降临') ||
    content.startsWith('[梦醒了') ||
    content.startsWith('[梦境结束') ||
    content.startsWith('[新梦境开始') ||
    content.startsWith('[半自由模式') ||
    content.startsWith('[选项模式');
}

function formatDreamProseClient(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  t = t.replace(/([^\n「"\s])(\s*)([「"])/g, '$1\n$3');
  t = t.replace(/([」"])([^\n」"\s])/g, '$1\n$2');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function renderDreamLinesHtml(content) {
  const lines = formatDreamProseClient(content).split('\n');
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '<div class="dream-line-gap"></div>';
    const isDialogue = /^[「"].+[」"]$/.test(trimmed) || /^".+"$/.test(trimmed);
    const cls = isDialogue ? 'dream-line dream-line-dialogue' : 'dream-line';
    return `<p class="${cls}">${escapeHtml(trimmed)}</p>`;
  }).join('');
}

function buildDreamPara(msg, { showContinue = false } = {}) {
  if (isSystemDreamMsg(msg.content)) return '';
  const id = msg.id || '';
  const isUser = msg.role === 'user';
  const cls = isUser ? 'dream-block dream-block-user' : 'dream-block dream-block-ai';
  const ctx = (id && !String(id).startsWith('tmp'))
    ? ` oncontextmenu="showDreamContextMenu(event,${id})"` : '';
  const cue = msg._cue ? ` data-cue="${escapeHtml(msg._cue)}"` : '';
  const cont = (!isUser && showContinue)
    ? `<button type="button" class="dream-inline-continue" onclick="continueDreamNarrative()">续写 ↓</button>`
    : '';
  return `<div class="${cls}" data-id="${id}" data-role="${msg.role}"${cue}${ctx}>${renderDreamLinesHtml(msg.content || '')}${cont}</div>`;
}

function getDreamBgStyle() {
  const s = getDreamSettings();
  const bg = s.bg || 'white';
  if (bg === 'custom' && s.customBgUrl) {
    // 必须用单引号：外层 style="..." 若再用双引号会截断属性导致背景失效
    const u = String(s.customBgUrl).replace(/'/g, '%27');
    return `url('${u}') center / cover no-repeat`;
  }
  const map = {
    white: '#ffffff',
    lavender: 'linear-gradient(160deg,rgba(200,160,255,0.10),rgba(220,190,255,0.04))',
    rose: 'linear-gradient(160deg,rgba(255,180,210,0.10),rgba(255,210,230,0.04))',
    azure: 'linear-gradient(160deg,rgba(160,200,255,0.10),rgba(190,220,255,0.04))',
    mint: 'linear-gradient(160deg,rgba(150,220,200,0.10),rgba(190,240,225,0.04))',
    gold: 'linear-gradient(160deg,rgba(240,210,140,0.10),rgba(255,230,180,0.04))',
  };
  return map[bg] || map.white;
}

function ensureDreamBgLayer() {
  const page = document.getElementById('dream-page');
  if (!page) return null;
  let el = document.getElementById('dream-bg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dream-bg';
    el.className = 'dream-bg-layer';
    el.setAttribute('aria-hidden', 'true');
    page.insertBefore(el, page.firstChild);
  }
  return el;
}

/** 把氛围色/自定义背景铺到梦境页（列表与对话共用） */
function applyDreamTheme() {
  const bgEl = ensureDreamBgLayer();
  if (bgEl) bgEl.style.background = getDreamBgStyle();
  const msgs = document.getElementById('dream-msgs');
  if (msgs) msgs.style.background = 'transparent';
  const bar = document.getElementById('dream-input-bar');
  if (bar) bar.style.background = getDreamInputBgStyle();
  const topbar = document.querySelector('#dream-page > .dream-topbar, #dream-page > .topbar');
  if (topbar) {
    const frosted = getDreamTopbarStyle();
    // 只改背景相关，避免冲掉其它 inline
    const rest = String(topbar.getAttribute('style') || '')
      .replace(/background[^;]*;?/gi, '')
      .replace(/backdrop-filter[^;]*;?/gi, '')
      .trim();
    topbar.setAttribute('style', `${rest};${frosted}`.replace(/^;/, ''));
  }
}

function getDreamInputBgStyle() {
  const bg = getDreamSettings().bg || 'white';
  if (bg === 'custom') return 'rgba(255,255,255,0.88)';
  if (bg === 'white') return '#ffffff';
  return 'rgba(255,255,255,0.92)';
}

function getDreamTopbarStyle() {
  const s = getDreamSettings();
  const bg = s.bg || 'white';
  if (bg === 'custom' && s.customBgUrl) {
    return 'background:rgba(255,255,255,0.88);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)';
  }
  if (bg !== 'white') {
    return 'background:rgba(255,255,255,0.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)';
  }
  return 'background:#ffffff';
}

function chipHtml(items, selected, onclickName) {
  return items.map((it) => {
    const val = typeof it === 'string' ? it : it.key;
    const label = typeof it === 'string' ? it : it.label;
    const active = selected === val;
    return `<button type="button" class="dream-chip ${active ? 'active' : ''}" onclick="${onclickName}(this,'${escapeHtml(val)}')">${escapeHtml(label)}</button>`;
  }).join('');
}

window.expandDreamTextarea = function(el) {
  if (!el) return;
  if (typeof window.openTextExpand === 'function') {
    window.openTextExpand(el);
    return;
  }
  el.style.minHeight = '240px';
  el.focus();
};

/* ─── 第一屏：角色选择 ─── */
window.initDreamPage = async function() {
  _dreamCharId = null;
  _dreamConfig = null;
  window._inDreamDialogue = false;

  const page = document.getElementById('dream-page');
  page.innerHTML = `
    <div class="topbar dream-topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title dream-title">梦境</div>
      <button type="button" class="topbar-action" onclick="openDreamSettings()" title="设置">${ICON_SETTINGS}</button>
    </div>
    <div class="scroll-area dream-portal" id="dream-char-list">
      <div class="dream-portal-header">
        <div class="dream-portal-title">入梦</div>
        <div class="dream-portal-sub">选一位角色，走进长篇梦境</div>
      </div>
      <div class="dream-char-grid"><div class="loading"><div class="loading-spinner"></div>感应中…</div></div>
    </div>
  `;
  applyDreamTheme();

  const chars = window.getFriendCharacters?.() || window.getAppCharacters?.() || [];
  const grid = document.querySelector('#dream-char-list .dream-char-grid');

  if (!chars.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🌙</div>
      <div class="empty-text">还没有好友<br>先加好友后再入梦</div>
      <button class="btn btn-primary btn-sm" style="margin-top:16px" onclick="window.navigateTo?.('contacts')">去通讯录</button>
    </div>`;
    return;
  }

  const cards = await Promise.all(chars.map(async c => {
    let hint = '尚未入梦';
    let lastDate = '';
    try {
      const msgs = await api.getMessages(c.id, { dream: 1, limit: 200 });
      const real = msgs.filter(m => !isSystemDreamMsg(m.content));
      const dates = [...new Set(real.map(m => m.timestamp?.slice(0, 10)).filter(Boolean))].sort();
      lastDate = dates[dates.length - 1] || '';
      const lastAi = [...real].reverse().find(m => m.role === 'assistant' && m.content);
      if (lastAi) hint = lastAi.content.replace(/\n/g, ' ').slice(0, 38) + (lastAi.content.length > 38 ? '…' : '');
      else if (dates.length) hint = `已有 ${dates.length} 个梦境`;
    } catch {}

    const av = c.avatar
      ? `<img class="dream-char-avatar" src="${escapeHtml(c.avatar)}" alt="">`
      : `<div class="dream-char-avatar-ph">🌙</div>`;

    return `
      <div class="dream-char-card" onclick="showCharDreams(${c.id},'${escapeHtml(c.name)}','${escapeHtml(lastDate)}')">
        ${av}
        <div class="dream-char-info">
          <div class="dream-char-name">${escapeHtml(c.name)}</div>
          <div class="dream-char-hint">${escapeHtml(hint)}</div>
        </div>
        <div class="dream-char-enter">入梦</div>
      </div>`;
  }));
  grid.innerHTML = cards.join('');
};

/* ─── 第二屏：某角色的梦境档案 ─── */
window.showCharDreams = async function(charId, charName, lastDate) {
  _dreamCharId = charId;
  window._dreamSelectedCharId = charId;

  const page = document.getElementById('dream-page');
  page.innerHTML = `
    <div class="topbar dream-topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="initDreamPage()" title="返回"></button>
      <div class="topbar-title dream-title">${escapeHtml(charName)} · 梦境</div>
      <button type="button" class="topbar-action" onclick="openDreamSettings()" title="设置">${ICON_SETTINGS}</button>
    </div>
    <div class="scroll-area" id="dream-list" style="padding:12px 0 88px">
      <div class="loading"><div class="loading-spinner"></div>加载中…</div>
    </div>
    <div class="contacts-tabbar contacts-tabbar--line dream-archive-bar">
      <div class="contacts-tab" onclick="openDreamManagePanel()">
        <div class="contacts-tab-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h10M4 17h14"/></svg></div>
        <div class="contacts-tab-label">管理</div>
      </div>
      ${lastDate ? `
      <div class="contacts-tab" onclick="openDreamSetup(${charId},'${escapeHtml(charName)}','${escapeHtml(lastDate)}')">
        <div class="contacts-tab-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg></div>
        <div class="contacts-tab-label">续梦</div>
      </div>` : ''}
      <div class="contacts-tab active" onclick="openDreamSetup(${charId},'${escapeHtml(charName)}',null)">
        <div class="contacts-tab-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></div>
        <div class="contacts-tab-label">新梦境</div>
      </div>
    </div>
  `;
  applyDreamTheme();

  try {
    const msgs = await api.getMessages(charId, { dream: 1, limit: 200 });
    renderDreams(msgs, charId, charName);
  } catch {
    document.getElementById('dream-list').innerHTML = `<div class="empty-state"><div class="empty-icon">🌙</div><div class="empty-text">还没有梦境记录</div></div>`;
  }
};

function groupDreamDates(msgs) {
  const real = msgs.filter(m => !isSystemDreamMsg(m.content));
  const byDate = {};
  for (const m of real) {
    const date = m.timestamp?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    (byDate[date] || (byDate[date] = [])).push(m);
  }
  return Object.entries(byDate).sort(([a], [b]) => b.localeCompare(a));
}

function renderDreams(msgs, charId, charName) {
  const list = document.getElementById('dream-list');
  const groups = groupDreamDates(msgs);
  _dreamManageDates = groups.map(([date, ms]) => ({ date, count: ms.length }));
  if (!groups.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🌙</div><div class="empty-text">还没有梦境<br>点下方「新梦境」开始</div></div>`;
    return;
  }
  list.innerHTML = groups.map(([date, ms]) => {
    const lastAi = [...ms].reverse().find(m => m.role === 'assistant' && m.content);
    const preview = lastAi?.content?.replace(/\n/g, ' ').slice(0, 60) || '…';
    return `
      <div class="dream-card" onclick="openDreamDate('${date}',${charId},'${escapeHtml(charName)}')">
        <div class="dream-date">[${date} 夜] · 梦境碎片 × ${Math.ceil(ms.length / 2)}</div>
        <div class="dream-preview" style="margin-top:6px">${escapeHtml(preview)}</div>
      </div>`;
  }).join('');
}

/* ─── 第三屏：梦境设定 ─── */
window.openDreamSetup = function(charId, charName, continueDate) {
  document.getElementById('dream-setup-overlay')?.remove();
  const saved = normalizeConfig(loadDreamConfig(charId));
  const eraSelected = ERA_PRESETS.includes(saved.era) ? saved.era : '自定义';
  const eraCustomVal = eraSelected === '自定义' ? saved.era : '';

  const overlay = document.createElement('div');
  overlay.id = 'dream-setup-overlay';
  overlay.className = 'dream-setup-sheet';
  overlay._selectedEra = eraSelected;
  overlay._selectedStyle = saved.style || 'romantic';
  overlay._selectedFreedom = saved.freedom || 'free';
  overlay._selectedTone = saved.tone || 'dream';

  overlay.innerHTML = `
    <div class="topbar dream-topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="document.getElementById('dream-setup-overlay').remove()" title="返回"></button>
      <div class="topbar-title dream-title">${continueDate ? '续梦设定' : '梦境设定'}</div>
      <div></div>
    </div>
    ${continueDate ? `<div class="dream-setup-banner">续 [${escapeHtml(continueDate)}] 的梦境 · 可调整设定后进入</div>` : ''}
    <div class="dream-setup-body">
      <section class="dream-setup-sec">
        <div class="dream-setup-sec-title">身份</div>
        <label class="input-label">TA 在梦里</label>
        <input class="input" id="dsi-char-role" placeholder="如：落魄书生、迷路的骑士…" value="${escapeHtml(saved.charRole)}">
        <label class="input-label" style="margin-top:12px">我在梦里</label>
        <input class="input" id="dsi-user-role" placeholder="如：路过的旅人、侍女…" value="${escapeHtml(saved.userRole)}">
      </section>

      <section class="dream-setup-sec">
        <div class="dream-setup-sec-title">故事前提 <span class="dream-setup-opt">可选</span></div>
        <div class="dream-setup-hint">写剧情背景/关系设定（不是壁纸）。壁纸在顶栏「美化」里换。</div>
        <div class="dream-setup-hint">可写前景摘要或已发生的前提。填写后按此展开；留空则按时代自动生成。</div>
        <textarea class="input" id="dsi-background" rows="5"
          placeholder="前景摘要或已发生的前提（可留空）…">${escapeHtml(saved.background)}</textarea>
        <button type="button" class="btn btn-ghost btn-sm" style="margin-top:6px"
          onclick="(window.openTextExpand||expandDreamTextarea)(document.getElementById('dsi-background'))">放大编辑</button>
      </section>

      <section class="dream-setup-sec">
        <div class="dream-setup-sec-title">时代</div>
        <div class="dream-setup-hint">控制长篇角色扮演的时代气质与器物称谓</div>
        <div class="dream-chip-row" id="dsi-era-row">
          ${chipHtml(ERA_PRESETS, eraSelected, 'selectDreamEra')}
        </div>
        <input class="input" id="dsi-era-custom" placeholder="自定义时代描述…"
          style="margin-top:8px;${eraSelected === '自定义' ? '' : 'display:none'}"
          value="${escapeHtml(eraCustomVal)}">
      </section>

      <section class="dream-setup-sec">
        <div class="dream-setup-sec-title">面具</div>
        <div class="settings-row dream-setup-toggle">
          <div class="settings-row-label">
            <div>戴上面具</div>
            <div class="settings-row-sub">角色必然认不出你，只会觉得熟悉却不知是谁</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="dsi-mask" ${saved.mask ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </section>

      <section class="dream-setup-sec">
        <div class="dream-setup-sec-title">文风</div>
        <div class="dream-chip-row" id="dsi-style-row">
          ${chipHtml(STYLE_OPTIONS, saved.style || 'romantic', 'selectDreamStyle')}
        </div>
        <textarea class="input" id="dsi-style-custom" rows="3" placeholder="自定义文风要求（选「自定义」时必填）…"
          style="margin-top:8px;${(saved.style || '') === 'custom' ? '' : 'display:none'}">${escapeHtml(saved.styleCustom)}</textarea>
      </section>

      <section class="dream-setup-sec">
        <div class="dream-setup-sec-title">基调</div>
        <div class="dream-freedom-list">
          ${TONE_OPTIONS.map(o => `
            <button type="button" class="dream-freedom-card dream-tone-card ${(saved.tone || 'dream') === o.key ? 'active' : ''}"
              onclick="selectDreamTone(this,'${o.key}')">
              <div class="dream-freedom-label">${o.label}</div>
              <div class="dream-freedom-sub">${o.sub}</div>
            </button>`).join('')}
        </div>
      </section>

      <section class="dream-setup-sec">
        <div class="dream-setup-sec-title">自由度</div>
        <div class="dream-freedom-list">
          ${FREEDOM_OPTIONS.map(o => `
            <button type="button" class="dream-freedom-card ${(saved.freedom || 'free') === o.key ? 'active' : ''}"
              onclick="selectDreamFreedom(this,'${o.key}')">
              <div class="dream-freedom-label">${o.label}</div>
              <div class="dream-freedom-sub">${o.sub}</div>
            </button>`).join('')}
        </div>
      </section>
    </div>
    <div class="dream-setup-footer contacts-tabbar--line">
      <button type="button" class="dream-enter-btn"
        onclick="confirmDreamSetup(${charId},'${escapeHtml(charName || '')}','${escapeHtml(continueDate || '')}')">
        进入梦境
      </button>
    </div>`;
  document.body.appendChild(overlay);
};

window.selectDreamEra = function(el, era) {
  document.querySelectorAll('#dsi-era-row .dream-chip').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  const ci = document.getElementById('dsi-era-custom');
  if (ci) ci.style.display = era === '自定义' ? '' : 'none';
  const overlay = document.getElementById('dream-setup-overlay');
  if (overlay) overlay._selectedEra = era;
};

window.selectDreamStyle = function(el, key) {
  document.querySelectorAll('#dsi-style-row .dream-chip').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  const ci = document.getElementById('dsi-style-custom');
  if (ci) ci.style.display = key === 'custom' ? '' : 'none';
  const overlay = document.getElementById('dream-setup-overlay');
  if (overlay) overlay._selectedStyle = key;
};

window.selectDreamTone = function(el, key) {
  document.querySelectorAll('#dream-setup-overlay .dream-tone-card').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  const overlay = document.getElementById('dream-setup-overlay');
  if (overlay) overlay._selectedTone = key;
};

window.selectDreamFreedom = function(el, key) {
  document.querySelectorAll('#dream-setup-overlay .dream-freedom-card:not(.dream-tone-card)').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  const overlay = document.getElementById('dream-setup-overlay');
  if (overlay) overlay._selectedFreedom = key;
};

window.confirmDreamSetup = function(charId, charName, continueDate) {
  const overlay = document.getElementById('dream-setup-overlay');
  const selectedEra = overlay?._selectedEra || '架空古代';
  const eraCustom = document.getElementById('dsi-era-custom')?.value?.trim() || '';
  const styleKey = overlay?._selectedStyle || 'romantic';
  const styleCustom = document.getElementById('dsi-style-custom')?.value?.trim() || '';
  if (styleKey === 'custom' && !styleCustom) {
    window.showToast?.('自定义文风请先填写内容');
    return;
  }
  if (selectedEra === '自定义' && !eraCustom) {
    window.showToast?.('请填写自定义时代');
    return;
  }

  const config = normalizeConfig({
    charRole: document.getElementById('dsi-char-role')?.value || '',
    userRole: document.getElementById('dsi-user-role')?.value || '',
    background: document.getElementById('dsi-background')?.value || '',
    era: selectedEra === '自定义' ? eraCustom : selectedEra,
    mask: document.getElementById('dsi-mask')?.checked || false,
    style: styleKey,
    styleCustom,
    freedom: overlay?._selectedFreedom || 'free',
    tone: overlay?._selectedTone || 'dream',
  });

  persistDreamConfig(charId, config);
  _dreamConfig = config;
  _dreamMask = !!config.mask;
  overlay?.remove();

  const date = continueDate || new Date().toISOString().slice(0, 10);
  openDreamDialogue(charId, charName, date, !continueDate);
};

/* ─── 第四屏：梦境对话 ─── */
async function openDreamDialogue(charId, charName, date, isNewDream) {
  _dreamCharId = charId;
  window._inDreamDialogue = true;
  const c = normalizeConfig(_dreamConfig || loadDreamConfig(charId));
  _dreamConfig = c;
  _dreamMask = !!c.mask;

  const page = document.getElementById('dream-page');
  page.innerHTML = `
    <div class="topbar dream-topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="showCharDreams(${charId},'${escapeHtml(charName || '')}','')" title="返回"></button>
      <div class="topbar-title dream-title">[${date} 夜]</div>
      <button type="button" class="dream-wake-link" id="dream-wake-btn" onclick="wakeFromDream()">梦醒了</button>
    </div>
    <div class="scroll-area dream-narrative" id="dream-msgs">
      <div class="loading"><div class="loading-spinner"></div></div>
    </div>
    <div id="dream-choices" class="dream-choices" style="display:none"></div>
    <div id="dream-input-bar" class="dream-input-bar contacts-tabbar--line" data-dream-input-bar>
      <div class="dream-input-row">
        <textarea class="chat-input dream-composer" id="dream-input"
          placeholder="${c.freedom === 'semi' ? '短动作 / 台词意图…' : c.freedom === 'guided' ? '也可自写行动…' : '在梦境中…'}"
          rows="1" oninput="autoResize(this)" onkeydown="handleDreamKey(event)"></textarea>
        <div class="dream-input-actions">
          <button type="button" class="dream-act-btn dream-act-continue" title="接着往下写" onclick="continueDreamNarrative()">续写</button>
          <button type="button" class="dream-act-btn" title="重新生成上一段" onclick="rollDreamMessage()">⟳</button>
          <button type="button" class="dream-act-btn dream-act-send" onclick="sendDreamMessage()">↑</button>
        </div>
      </div>
      <div class="dream-mode-hint">${freedomHint(c.freedom)}</div>
    </div>
  `;
  applyDreamTheme();

  await loadDreamMessages(charId, date);
  if (isNewDream) await triggerDreamOpen(charId);
  else if (c.freedom === 'guided') await maybeShowDreamChoices();
}

function freedomHint(freedom) {
  if (freedom === 'semi') return '半自由：输入短意图由系统扩写 · 「续写」接着上文 · 「⟳」可重掷扩写';
  if (freedom === 'guided') return '不自由：点选项推进 · 也可「续写」让角色接着写';
  return '自由：自己写段落 · 「续写」让角色接着写 · 「⟳」重生成上一段';
}

window.openDreamDate = async function(date, charId, charName) {
  const cid = charId || _dreamCharId || window._dreamSelectedCharId;
  const cname = charName || '';
  _dreamConfig = normalizeConfig(loadDreamConfig(cid));
  _dreamMask = !!_dreamConfig.mask;
  await openDreamDialogue(cid, cname, date, false);
};

async function loadDreamMessages(charId, date) {
  try {
    const msgs = await api.getMessages(charId, { dream: 1, limit: 200 });
    const dayMsgs = msgs.filter(m => m.timestamp?.slice(0, 10) === date);
    const el = document.getElementById('dream-msgs');
    if (!el) return;
    const lastAiIdx = [...dayMsgs].map((m, i) => (m.role === 'assistant' && !isSystemDreamMsg(m.content) ? i : -1)).filter(i => i >= 0).pop();
    const paras = dayMsgs.map((m, i) => buildDreamPara(m, {
      showContinue: i === lastAiIdx,
    })).filter(Boolean).join('');
    el.innerHTML = paras || '<div class="empty-state"><div class="empty-text">梦境碎片尚未形成</div></div>';
    el.scrollTop = el.scrollHeight;
  } catch {}
}

function buildSceneCard(config) {
  const c = normalizeConfig(config);
  const bits = [
    c.era,
    [c.charRole, c.userRole].filter(Boolean).join(' · '),
    c.mask ? '面具' : '',
    TONE_OPTIONS.find(t => t.key === c.tone)?.label || '',
    FREEDOM_OPTIONS.find(f => f.key === c.freedom)?.label || '',
  ].filter(Boolean);
  return `<div class="dream-scene-card">
    <div class="dream-scene-era">${escapeHtml(c.era || '梦境')}</div>
    <div class="dream-scene-roles">${escapeHtml(bits.slice(1).join('  ·  '))}</div>
  </div>`;
}

function buildDreamOpenPrompt(config) {
  const c = normalizeConfig(config);
  const parts = ['[新梦境开始。请直接进入长篇开场，不要复述本指令。]'];
  parts.push('要求：写一大段开场（约500～900字），建立时代氛围、场景与人物心境。');
  if (c.background) {
    parts.push('已有前提/前景如下，请据此自然展开，不要另起炉灶推翻：');
    parts.push(c.background);
  } else {
    parts.push(`没有额外前提：请根据时代「${c.era || '未知时空'}」自动生成合理的背景开场，并埋下可互动的契机。`);
  }
  if (c.charRole) parts.push(`你在梦中的身份：${c.charRole}。`);
  if (c.userRole) {
    parts.push(c.mask
      ? `将与你相遇的人身份为「${c.userRole}」，但你认不出对方是谁，只觉熟悉。`
      : `将与你相遇的人身份为「${c.userRole}」。`);
  } else if (c.mask) {
    parts.push('当那个人出现时，你认不出对方，只觉得有点熟悉。');
  }
  parts.push('【排版】叙述首行缩进两字；人物对白用「」且单独成行。');
  parts.push(getActiveDreamStylePrompt(c));
  parts.push(c.tone === 'reality'
    ? '【基调·现实】按接近现实的因果与生活逻辑推进，事件要说得通。'
    : '【基调·梦境】可不合日常逻辑、意象跳跃，但不要离谱到无意义。');
  parts.push('开场结束时自然停在需要对方行动/回应的节拍上，不要替对方做决定。');
  return parts.join('\n');
}

async function triggerDreamOpen(charId) {
  const config = normalizeConfig(_dreamConfig || {});
  _dreamMask = !!config.mask;
  const prompt = buildDreamOpenPrompt(config);
  const list = document.getElementById('dream-msgs');
  if (!list) return;
  list.querySelector('.empty-state')?.remove();
  list.insertAdjacentHTML('beforeend', buildSceneCard(config));
  showDreamTyping(list);

  await new Promise(r => setTimeout(r, 600 + Math.random() * 400));

  try {
    const result = await api.sendMessage({
      characterId: charId,
      content: prompt,
      isDream: true,
      ...dreamPayloadExtras(),
    });
    document.getElementById('dream-typing')?.remove();
    // 开场指令不展示：删掉刚写入的用户指令消息
    if (result.userMsgId) {
      try { await api.deleteMessage(result.userMsgId); } catch {}
    }
    list.querySelectorAll('.dream-block-user').forEach((n) => n.remove());
    appendDreamAiReply(list, result);
    await afterAiDreamTurn();
  } catch (e) {
    document.getElementById('dream-typing')?.remove();
    window.showToast?.(e.message || '无法进入梦境，请检查 API 设置');
  }
}

function showDreamTyping(list) {
  const typingP = document.createElement('div');
  typingP.id = 'dream-typing';
  typingP.className = 'dream-block dream-block-ai dream-p-typing';
  typingP.innerHTML = '<p class="dream-line">·&nbsp;·&nbsp;·</p>';
  list.appendChild(typingP);
  list.scrollTop = list.scrollHeight;
}

function appendDreamAiReply(list, result) {
  const text = result?.content;
  if (!text) { window.showToast?.('没有收到回复，请检查 API 设置'); return; }
  const id = result.aiMsgId || ('ai_' + Date.now());
  list.querySelectorAll('.dream-inline-continue').forEach(b => b.remove());
  list.insertAdjacentHTML('beforeend',
    `<div class="dream-block dream-block-ai" data-id="${id}" data-role="assistant"
      oncontextmenu="showDreamContextMenu(event,${id})">${renderDreamLinesHtml(text)}
      <button type="button" class="dream-inline-continue" onclick="continueDreamNarrative()">续写 ↓</button>
    </div>`);
  list.scrollTop = list.scrollHeight;
}

function appendDreamUserBlock(list, text, id, cue = '') {
  const cueAttr = cue ? ` data-cue="${escapeHtml(cue)}"` : '';
  list.insertAdjacentHTML('beforeend',
    `<div class="dream-block dream-block-user" data-id="${id}" data-role="user"${cueAttr}>${renderDreamLinesHtml(text)}</div>`);
  list.scrollTop = list.scrollHeight;
}

async function afterAiDreamTurn() {
  const freedom = normalizeConfig(_dreamConfig || {}).freedom;
  if (freedom === 'guided') await maybeShowDreamChoices();
  else hideDreamChoices();
}

function hideDreamChoices() {
  const el = document.getElementById('dream-choices');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

async function maybeShowDreamChoices() {
  if (!_dreamCharId || _dreamChoicesLoading) return;
  const freedom = normalizeConfig(_dreamConfig || {}).freedom;
  if (freedom !== 'guided') return;
  const box = document.getElementById('dream-choices');
  if (!box) return;
  _dreamChoicesLoading = true;
  box.style.display = '';
  box.innerHTML = `<div class="dream-choices-loading">生成选项…</div>`;
  try {
    const r = await api.getDreamChoices(_dreamCharId, dreamPayloadExtras());
    const choices = r.choices || [];
    if (!choices.length) {
      box.innerHTML = `<div class="dream-choices-loading">${escapeHtml(r.error || '暂无选项')}</div>`;
      return;
    }
    box.innerHTML = `
      <div class="dream-choices-title">你的行动</div>
      <div class="dream-choices-list">
        ${choices.map((t, i) => `
          <button type="button" class="dream-choice-btn" onclick="pickDreamChoice(${i})">
            <span class="dream-choice-idx">${i + 1}</span>
            <span>${escapeHtml(t)}</span>
          </button>`).join('')}
      </div>`;
    box._choices = choices;
  } catch (e) {
    box.innerHTML = `<div class="dream-choices-loading">${escapeHtml(e.message || '选项生成失败')}</div>`;
  } finally {
    _dreamChoicesLoading = false;
  }
}

window.pickDreamChoice = async function(idx) {
  const box = document.getElementById('dream-choices');
  const choices = box?._choices || [];
  const text = choices[idx];
  if (!text || !_dreamCharId) return;
  hideDreamChoices();
  await sendDreamMessageRaw(text, { dreamMode: '' });
};

/* ─── 发送 / 重生成 ─── */
window.sendDreamMessage = async function() {
  const input = document.getElementById('dream-input');
  const text = input?.value?.trim();
  if (!text || !_dreamCharId) return;
  input.value = '';
  input.style.height = '';
  const freedom = normalizeConfig(_dreamConfig || {}).freedom;
  if (freedom === 'semi') {
    _dreamLastCue = text;
    await sendDreamMessageRaw(text, { dreamMode: 'expand_user' });
  } else {
    await sendDreamMessageRaw(text, { dreamMode: '' });
  }
};

async function sendDreamMessageRaw(text, { dreamMode = '' } = {}) {
  if (_dreamAiBusy) { window.showToast?.('还在写，请稍候'); return; }
  const list = document.getElementById('dream-msgs');
  if (!list) return;
  list.querySelector('.empty-state')?.remove();
  hideDreamChoices();

  const tmpId = 'tmp_' + Date.now();
  const preview = dreamMode === 'expand_user' ? `（意图）${text}` : text;
  appendDreamUserBlock(list, preview, tmpId, dreamMode === 'expand_user' ? text : '');

  _dreamAiBusy = true;
  showDreamTyping(list);

  try {
    const result = await api.sendMessage({
      characterId: _dreamCharId,
      content: text,
      isDream: true,
      dreamMode: dreamMode || undefined,
      ...dreamPayloadExtras(),
    });
    document.getElementById('dream-typing')?.remove();
    const tmp = list.querySelector(`[data-id="${tmpId}"]`);
    if (tmp) {
      const finalUser = result.userContent || result.dreamExpand?.expanded || text;
      tmp.outerHTML = buildDreamPara({
        id: result.userMsgId || tmpId,
        role: 'user',
        content: finalUser,
        _cue: result.dreamExpand?.cue || (dreamMode === 'expand_user' ? text : ''),
      });
    }
    appendDreamAiReply(list, result);
    await afterAiDreamTurn();
  } catch (e) {
    document.getElementById('dream-typing')?.remove();
    window.showToast?.(e.message || '发送失败');
  } finally {
    _dreamAiBusy = false;
  }
}

window.handleDreamKey = function(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendDreamMessage(); }
};

async function runDreamContinue({ replaceLast = false, reExpand = false } = {}) {
  if (!_dreamCharId || _dreamAiBusy) {
    if (_dreamAiBusy) window.showToast?.('还在写，请稍候');
    return;
  }
  const list = document.getElementById('dream-msgs');
  if (!list) return;
  const freedom = normalizeConfig(_dreamConfig || {}).freedom;

  // 半自由：若最后用户块带 cue，重掷扩写
  if (reExpand || (replaceLast && freedom === 'semi')) {
    const userBlocks = list.querySelectorAll('.dream-block-user');
    const lastUser = userBlocks[userBlocks.length - 1];
    const cue = lastUser?.dataset?.cue || _dreamLastCue;
    if (cue) {
      const aiBlocks = [...list.querySelectorAll('.dream-block-ai[data-role="assistant"]')];
      const lastAi = aiBlocks[aiBlocks.length - 1];
      const lastAiId = lastAi?.dataset?.id;
      const lastUserId = lastUser?.dataset?.id;
      lastAi?.remove();
      lastUser?.remove();
      if (lastAiId && !String(lastAiId).startsWith('tmp') && !String(lastAiId).startsWith('ai_')) {
        try { await api.deleteMessage(lastAiId); } catch {}
      }
      if (lastUserId && !String(lastUserId).startsWith('tmp')) {
        try { await api.deleteMessage(lastUserId); } catch {}
      }
      await sendDreamMessageRaw(cue, { dreamMode: 'expand_user' });
      return;
    }
  }

  _dreamAiBusy = true;
  if (replaceLast) {
    const aiParas = list.querySelectorAll('.dream-block-ai[data-role="assistant"]');
    const last = aiParas[aiParas.length - 1];
    const lastId = last?.dataset?.id;
    last?.remove();
    if (lastId && !String(lastId).startsWith('tmp') && !String(lastId).startsWith('ai_')) {
      try { await api.deleteMessage(lastId); } catch {}
    }
  }

  list.querySelector('.empty-state')?.remove();
  hideDreamChoices();
  showDreamTyping(list);

  try {
    const extras = dreamPayloadExtras();
    const result = await api.triggerAi(
      _dreamCharId, true, 'continue',
      extras.dreamMask, extras.dreamStyle,
      false, false, null, null, extras.dreamConfig
    );
    document.getElementById('dream-typing')?.remove();
    appendDreamAiReply(list, result);
    await afterAiDreamTurn();
  } catch (e) {
    document.getElementById('dream-typing')?.remove();
    window.showToast?.(e.message || (replaceLast ? '重新生成失败' : '续写失败'));
  } finally {
    _dreamAiBusy = false;
  }
}

window.continueDreamNarrative = function() {
  return runDreamContinue({ replaceLast: false });
};

window.rollDreamMessage = function() {
  const freedom = normalizeConfig(_dreamConfig || {}).freedom;
  if (freedom === 'semi') return runDreamContinue({ replaceLast: true, reExpand: true });
  return runDreamContinue({ replaceLast: true });
};

/* ─── 梦醒 + 心理活动总结 ─── */
window.wakeFromDream = async function() {
  if (!_dreamCharId) { window.initDreamPage(); return; }
  const charId = _dreamCharId;

  const btn = document.getElementById('dream-wake-btn');
  if (btn) { btn.textContent = '生成中…'; btn.disabled = true; btn.onclick = null; }

  const chars = window.getAppCharacters?.() || [];
  let charName = chars.find(c => c.id === charId)?.name || '角色';
  try { const c = await api.getCharacter(charId); if (c?.name) charName = c.name; } catch {}

  const s = getDreamSettings();
  const bgKey = s.bg || 'white';
  const themeMap = {
    white: { bg: '255,255,255,248,248,250', fog: '200,200,210', acc: '100,100,110' },
    lavender: { bg: '250,246,255,244,240,252', fog: '200,180,230', acc: '120,90,160' },
    rose: { bg: '255,248,250,255,242,246', fog: '240,190,210', acc: '160,80,110' },
    azure: { bg: '246,250,255,240,246,252', fog: '180,210,240', acc: '70,110,170' },
    mint: { bg: '246,252,250,240,250,246', fog: '170,220,200', acc: '60,130,110' },
    gold: { bg: '255,252,246,252,246,236', fog: '230,210,160', acc: '140,100,40' },
    custom: { bg: '255,255,255,248,248,250', fog: '200,200,210', acc: '100,100,110' },
  };
  const tc = themeMap[bgKey] || themeMap.white;
  const [r1, g1, b1, r2, g2, b2] = tc.bg.split(',').map(Number);
  const [fr, fg, fb] = tc.fog.split(',').map(Number);
  const [ar, ag, ab] = tc.acc.split(',').map(Number);

  const hasCustomBg = bgKey === 'custom' && s.customBgUrl;
  const customUrl = hasCustomBg ? String(s.customBgUrl).replace(/'/g, '%27') : '';
  const overlayBgStyle = hasCustomBg
    ? `background:url('${customUrl}') center / cover no-repeat`
    : `background:linear-gradient(160deg,rgb(${r1},${g1},${b1}),rgb(${r2},${g2},${b2}))`;

  try {
    const result = await api.sendMessage({
      characterId: charId,
      content: `[梦境结束，你从梦中悄然醒来。请以${charName}的第一人称，用100-150字写下此刻对这场梦的内心感触——这是你独自在心里默想的，不是在对任何人说话，全程不出现"你"字。语句完整，不要在句子中途中断。只输出内心独白本身，不加标题、引号、括号或任何说明。]`,
      isDream: true,
      ...dreamPayloadExtras(),
    });

    const summaryText = result?.content || '梦境如烟，随晨光悄悄散去…';

    const list = document.getElementById('dream-msgs');
    if (list) {
      list.insertAdjacentHTML('beforeend', `<div class="dream-wake-divider">· 梦 醒 ·</div>`);
      list.scrollTop = list.scrollHeight;
    }

    const summaryOverlay = document.createElement('div');
    summaryOverlay.id = 'dream-wake-summary-overlay';
    summaryOverlay.style.cssText = `
      position:fixed;inset:0;z-index:300;overflow:hidden;
      ${overlayBgStyle};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:48px 32px;
    `;
    summaryOverlay.innerHTML = `
      ${hasCustomBg ? `<div style="position:absolute;inset:0;background:rgba(255,255,255,0.72);z-index:0"></div>` : ''}
      <div class="dream-fog-layer" style="width:260px;height:200px;top:10%;left:-8%;
        background:rgba(${fr},${fg},${fb},0.35);animation:dreamFog1 14s ease-in-out infinite;"></div>
      <div class="dream-fog-layer" style="width:220px;height:180px;bottom:12%;right:-6%;
        background:rgba(${fr},${fg},${fb},0.3);animation:dreamFog2 18s ease-in-out infinite;"></div>
      <div class="dream-fog-layer" style="width:180px;height:150px;top:50%;left:30%;
        background:rgba(${fr},${fg},${fb},0.22);animation:dreamFog3 22s ease-in-out infinite;"></div>
      <div style="position:relative;z-index:1;text-align:center;max-width:320px;width:100%;
        animation:dreamFadeIn 0.9s ease-out">
        <div style="font-size:38px;margin-bottom:18px;opacity:0.4;letter-spacing:8px;color:rgba(${ar},${ag},${ab},0.55)">☽&thinsp;☾</div>
        <div style="font-size:11px;color:rgba(${ar},${ag},${ab},0.7);letter-spacing:5px;margin-bottom:10px">梦 醒 时 分</div>
        <div style="font-size:13px;color:rgba(${ar},${ag},${ab},0.55);margin-bottom:28px">${escapeHtml(charName)} 的心绪</div>
        <div style="font-family:'Noto Serif SC',serif;font-size:15px;line-height:2;
          color:var(--text-primary);text-indent:2em;text-align:left;
          background:#ffffff;border-radius:14px;padding:20px 22px;
          border:1px solid rgba(0,0,0,0.06);box-shadow:0 4px 20px rgba(0,0,0,0.04)">${escapeHtml(summaryText)}</div>
        <button id="dream-end-btn" class="dream-enter-btn" style="margin-top:32px">结束梦境</button>
      </div>
    `;
    document.body.appendChild(summaryOverlay);

    document.getElementById('dream-end-btn')?.addEventListener('click', () => {
      summaryOverlay.remove();
      window._inDreamDialogue = false;
      window.showCharDreams?.(charId, charName, '');
    });

    try {
      const charData = await api.getCharacter(charId);
      if (charData?.dream_affects_memory) {
        const today = new Date().toISOString().slice(0, 10);
        await api.saveDreamMemory(charId, `[梦境摘要] ${summaryText}`, today);
      }
    } catch {}

    window.showToast?.('梦境已存档');
  } catch (err) {
    if (btn) { btn.textContent = '梦醒了'; btn.disabled = false; btn.onclick = window.wakeFromDream; }
    window.showToast?.(err?.message || '生成失败，请重试');
  }
};

/* ─── 对话消息编辑（右键菜单） ─── */
window.editDreamMsg = async function(msgId) {
  if (!msgId || String(msgId).startsWith('tmp')) return;
  const el = document.querySelector(`#dream-msgs [data-id="${msgId}"]`);
  if (!el) return;

  document.getElementById('dream-edit-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'dream-edit-overlay';
  overlay.className = 'overlay active center';
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `
    <div class="modal" style="width:calc(100% - 32px);max-width:400px" onclick="event.stopPropagation()">
      <div class="modal-title">编辑梦境</div>
      <div class="modal-body">
        <textarea class="input" id="dream-edit-text" style="min-height:120px;line-height:1.7"></textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('dream-edit-overlay').remove()">取消</button>
        <button class="btn btn-primary btn-sm" onclick="saveDreamMsgEdit(${msgId})">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = document.getElementById('dream-edit-text');
  if (ta) {
    ta.value = Array.from(el.querySelectorAll('.dream-line')).map(p => p.textContent).join('\n') || el.textContent;
  }
  setTimeout(() => ta?.focus(), 100);
};

window.saveDreamMsgEdit = async function(msgId) {
  const text = document.getElementById('dream-edit-text')?.value?.trim();
  if (!text) { window.showToast?.('内容不能为空'); return; }
  try {
    await api.updateMessage(msgId, { content: text });
    const el = document.querySelector(`#dream-msgs [data-id="${msgId}"]`);
    if (el) el.outerHTML = buildDreamPara({ id: msgId, role: el.dataset.role, content: text });
    document.getElementById('dream-edit-overlay')?.remove();
    window.showToast?.('已保存');
  } catch (e) { window.showToast?.(e.message || '保存失败'); }
};

window.showDreamContextMenu = function(e, msgId) {
  e.preventDefault();
  window._dreamCtxMsgId = msgId;
  window._ctxDreamMode = true;
  window.showContextMenu?.(e, msgId);
};

/* ─── 梦境设置（美化：氛围色 + 自定义背景） ─── */
window.openDreamSettings = function() {
  document.getElementById('dream-settings-overlay')?.remove();
  const s = getDreamSettings();
  window._pendingDreamBg = s.bg || 'white';
  window._pendingDreamCustomBgUrl = s.customBgUrl || '';

  const BG_OPTIONS = [
    { key: 'white', label: '系统白', color: '#ffffff', tc: 'rgba(60,60,70,0.9)' },
    { key: 'lavender', label: '薰衣草', color: 'linear-gradient(135deg,#c8a8ff,#e8c8ff)', tc: 'rgba(80,40,120,0.9)' },
    { key: 'rose', label: '玫瑰梦', color: 'linear-gradient(135deg,#ffb8d8,#ffd8ec)', tc: 'rgba(160,40,80,0.9)' },
    { key: 'azure', label: '星河蓝', color: 'linear-gradient(135deg,#a8c8ff,#c8e0ff)', tc: 'rgba(40,80,160,0.9)' },
    { key: 'mint', label: '仙雾绿', color: 'linear-gradient(135deg,#a0e0d0,#c8f0e8)', tc: 'rgba(40,120,100,0.9)' },
    { key: 'gold', label: '琥珀金', color: 'linear-gradient(135deg,#ffe0a0,#fff0c0)', tc: 'rgba(140,80,20,0.9)' },
    { key: 'custom', label: '自定义', color: 'linear-gradient(135deg,#f0f0f2,#ffffff)', tc: 'rgba(80,80,90,0.9)' },
  ];

  const overlay = document.createElement('div');
  overlay.id = 'dream-settings-overlay';
  overlay.className = 'dream-setup-sheet';
  overlay.innerHTML = `
    <div class="topbar dream-topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="document.getElementById('dream-settings-overlay').remove()" title="返回"></button>
      <div class="topbar-title">梦境美化</div>
      <button type="button" class="topbar-save" onclick="saveDreamSettingsUI()" title="保存"></button>
    </div>
    <div class="dream-setup-body" style="flex:1;overflow-y:auto">
      <div class="dream-setup-hint" style="margin-bottom:12px">氛围色与背景图会铺在梦境列表和对话里。文风请在进入「新梦境」设定里选。</div>
      <label class="input-label">梦境氛围色</label>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:6px 0 14px">
        ${BG_OPTIONS.map(opt => `
          <div id="dream-bg-${opt.key}" onclick="selectDreamBg('${opt.key}')"
            style="padding:14px 6px;border-radius:12px;text-align:center;cursor:pointer;
              background:${opt.color};
              border:2px solid ${(s.bg || 'white') === opt.key ? 'var(--theme)' : 'rgba(0,0,0,0.08)'};
              transition:border-color 0.15s">
            <div style="font-size:13px;font-weight:500;color:${opt.tc}">${opt.label}</div>
          </div>`).join('')}
      </div>
      <div id="dream-custom-bg-row" style="${(s.bg || 'white') === 'custom' ? '' : 'display:none'}">
        <label class="input-label">自定义背景图</label>
        <div style="display:flex;gap:8px;margin-bottom:14px;align-items:center">
          ${s.customBgUrl
            ? `<img src="${escapeHtml(s.customBgUrl)}" style="width:60px;height:40px;object-fit:cover;border-radius:6px" id="dream-bg-preview">`
            : '<div id="dream-bg-preview" style="width:60px;height:40px;background:var(--bg-primary);border-radius:6px"></div>'}
          <button class="btn btn-ghost btn-sm" onclick="pickDreamBgImage()">选择图片</button>
          <input type="file" id="dream-bg-file" accept="image/*" style="display:none" onchange="handleDreamBgUpload(event)">
        </div>
      </div>
      <label class="input-label">AI 写作偏好（可选）</label>
      <textarea class="input" id="dream-preset-hint" style="min-height:80px;margin-top:4px;margin-bottom:12px"
        placeholder="会叠在当次梦境文风后面，如：多留白、少形容词…">${escapeHtml(s.presetHint || '')}</textarea>
    </div>
  `;
  document.body.appendChild(overlay);
};

window.selectDreamBg = function(key) {
  window._pendingDreamBg = key;
  document.querySelectorAll('[id^="dream-bg-"]').forEach(el => {
    el.style.borderColor = el.id === `dream-bg-${key}` ? 'var(--theme)' : 'rgba(0,0,0,0.08)';
  });
  const row = document.getElementById('dream-custom-bg-row');
  if (row) row.style.display = key === 'custom' ? '' : 'none';
};

window.pickDreamBgImage = function() { document.getElementById('dream-bg-file')?.click(); };

window.handleDreamBgUpload = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const result = await pickCropAndUpload(file, { title: '裁剪梦境背景', aspect: window.innerWidth / window.innerHeight });
    if (!result) return;
    window._pendingDreamCustomBgUrl = result.url;
    window._pendingDreamBg = 'custom';
    selectDreamBg('custom');
    const preview = document.getElementById('dream-bg-preview');
    if (preview) preview.outerHTML = `<img src="${escapeHtml(result.url)}" style="width:60px;height:40px;object-fit:cover;border-radius:6px" id="dream-bg-preview">`;
    window.showToast?.('背景图已上传，记得点保存');
  } catch { window.showToast?.('上传失败'); }
  e.target.value = '';
};

window.saveDreamSettingsUI = function() {
  const cur = getDreamSettings();
  const bg = window._pendingDreamBg || cur.bg || 'white';
  const customBgUrl = window._pendingDreamCustomBgUrl || cur.customBgUrl || '';
  if (bg === 'custom' && !customBgUrl) {
    window.showToast?.('请先选择一张背景图');
    return;
  }
  saveDreamSettings({
    ...cur,
    bg,
    customBgUrl: bg === 'custom' ? customBgUrl : (cur.customBgUrl || ''),
    presetHint: document.getElementById('dream-preset-hint')?.value?.trim() || '',
  });
  document.getElementById('dream-settings-overlay')?.remove();
  applyDreamTheme();
  window.showToast?.('梦境美化已保存');
};

window.clearDreamsConfirm = async function() {
  const charId = _dreamCharId || window._dreamSelectedCharId;
  if (!charId) { window.showToast?.('请先选择角色'); return; }
  if (!confirm('确定删除该角色的全部梦境记录？此操作不可恢复')) return;
  try {
    await api.clearMessages(charId, 1);
    document.getElementById('dream-manage-overlay')?.remove();
    document.getElementById('dream-settings-overlay')?.remove();
    window.showToast?.('已全部清除');
    window.initDreamPage();
  } catch (e) { window.showToast?.(e.message); }
};

window.openDreamManagePanel = async function() {
  const charId = _dreamCharId || window._dreamSelectedCharId;
  if (!charId) { window.showToast?.('请先选择角色'); return; }

  let groups = _dreamManageDates;
  if (!groups?.length) {
    try {
      const msgs = await api.getMessages(charId, { dream: 1, limit: 200 });
      groups = groupDreamDates(msgs).map(([date, ms]) => ({ date, count: ms.length }));
    } catch {
      groups = [];
    }
  }
  if (!groups.length) {
    window.showToast?.('还没有梦境可删');
    return;
  }

  const chars = window.getAppCharacters?.() || [];
  const charName = chars.find(c => c.id === charId)?.name || '角色';

  document.getElementById('dream-manage-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'dream-manage-overlay';
  overlay.className = 'dream-setup-sheet';
  overlay.style.zIndex = '210';
  overlay.innerHTML = `
    <div class="topbar dream-topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="document.getElementById('dream-manage-overlay').remove()" title="返回"></button>
      <div class="topbar-title dream-title">管理梦境</div>
      <div></div>
    </div>
    <div style="padding:10px 16px;font-size:13px;color:var(--text-secondary);line-height:1.5">
      勾选要删除的「夜」；未勾选的会保留。按日期整段删除该夜的全部梦境消息。
    </div>
    <div class="scroll-area" style="flex:1;padding:0 12px 12px" id="dream-manage-list">
      ${groups.map(g => `
        <label class="settings-row" style="cursor:pointer;margin-bottom:8px;border-radius:10px;background:var(--bg-glass)">
          <input type="checkbox" class="dream-manage-cb" value="${escapeHtml(g.date)}" style="margin-right:10px">
          <div style="flex:1">
            <div style="font-size:15px">[${escapeHtml(g.date)} 夜]</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${g.count} 条碎片</div>
          </div>
        </label>`).join('')}
    </div>
    <div class="dream-setup-footer" style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:8px">
        <button type="button" class="btn btn-ghost btn-sm" style="flex:1" onclick="toggleDreamManageAll(true)">全选</button>
        <button type="button" class="btn btn-ghost btn-sm" style="flex:1" onclick="toggleDreamManageAll(false)">全不选</button>
      </div>
      <button type="button" class="btn btn-danger btn-sm" style="width:100%" onclick="deleteSelectedDreamDates(${charId},'${escapeHtml(charName)}')">删除所选</button>
      <button type="button" class="btn btn-ghost btn-sm" style="width:100%;color:var(--text-secondary)" onclick="clearDreamsConfirm()">删除全部梦境</button>
    </div>`;
  document.body.appendChild(overlay);
};

window.toggleDreamManageAll = function(checked) {
  document.querySelectorAll('.dream-manage-cb').forEach(cb => { cb.checked = checked; });
};

window.deleteSelectedDreamDates = async function(charId, charName) {
  const dates = Array.from(document.querySelectorAll('.dream-manage-cb:checked')).map(cb => cb.value);
  if (!dates.length) { window.showToast?.('请先勾选要删除的日期'); return; }
  if (!confirm(`确定删除选中的 ${dates.length} 个梦境夜？此操作不可恢复`)) return;
  try {
    const result = await api.clearDreamDates(charId, dates);
    document.getElementById('dream-manage-overlay')?.remove();
    document.getElementById('dream-settings-overlay')?.remove();
    window.showToast?.(`已删除 ${result.deleted || 0} 条`);
    if (window._inDreamDialogue) {
      window.initDreamPage();
    } else {
      window.showCharDreams(charId, charName, '');
    }
  } catch (e) { window.showToast?.(e.message || '删除失败'); }
};

window.startNewDream = function() {
  const charId = _dreamCharId || window._dreamSelectedCharId;
  if (!charId) { window.showToast?.('请先选择角色'); return; }
  const chars = window.getAppCharacters?.() || [];
  const char = chars.find(c => c.id === charId);
  openDreamSetup(charId, char?.name || '', null);
};

/**
 * 系统内联小黄豆（微信风格 [微笑]）
 * 可用于：聊天 / 日记 / 随手记 / 朋友圈与评论
 * 不可用于：时空、梦境
 */
import { INLINE_EMOJI_BASE, INLINE_EMOJI_PACK } from './inline-emoji-data.js';

const BASE = INLINE_EMOJI_BASE || '/assets/inline-emoji/out';

/** 优先展示顺序（接近微信：表情在前） */
const PREFERRED_ORDER = [
  '微笑', '撇嘴', '色', '呆', '得意', '大哭', '害羞', '闭嘴', '睡着', '大哭',
  '囧', '怒', '吐舌', '呲牙', '惊讶', '难过', '酷', '汗', '抓狂', '吐',
  '偷笑', '愉快', '白眼', '傲慢', '委屈', '快哭了', '阴险', '亲', '可怜',
  '捂脸', '笑哭', '坏笑', '哼', '嘘', '晕', '衰', '敲', '再见', '擦汗',
  '抠鼻', '鼓掌', '坏笑', '左哼哼', '右哼哼', '哈欠', '鄙视', '委屈',
  '阴险', '亲', '吓', '可怜', '玫瑰', '花谢了', '爱心', '心碎', '蛋糕',
  '炸弹', '便便', '月亮', '太阳', '礼物', '抱抱', '强', '弱', '握手',
  '抱拳', '勾引', '拳头', '爱你', 'NO', 'OK', 'ok', 'emm', 'wink',
];

let _ready = null;
let _list = [];
let _byCode = new Map(); // code/alias(lower) -> { code, file, url }

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sortEmojis(list) {
  const rank = new Map(PREFERRED_ORDER.map((c, i) => [c, i]));
  return [...list].sort((a, b) => {
    const ra = rank.has(a.code) ? rank.get(a.code) : 1000;
    const rb = rank.has(b.code) ? rank.get(b.code) : 1000;
    if (ra !== rb) return ra - rb;
    return String(a.code).localeCompare(String(b.code), 'zh');
  });
}

function applyPack(data) {
  const raw = Array.isArray(data?.emojis) ? data.emojis : [];
  _list = sortEmojis(raw.map((e) => {
    const code = String(e.code || '').trim();
    const file = String(e.file || `${code}.png`).trim();
    return {
      code,
      file,
      url: `${BASE}/${encodeURIComponent(file)}`,
      aliases: Array.isArray(e.aliases) ? e.aliases.map(String) : [],
    };
  }).filter((e) => e.code));
  _byCode = new Map();
  for (const e of _list) {
    _byCode.set(e.code, e);
    _byCode.set(e.code.toLowerCase(), e);
    for (const a of e.aliases) {
      if (a) _byCode.set(String(a).toLowerCase(), e);
    }
  }
  return _list;
}

// 内嵌数据同步可用，不依赖 /assets/.../manifest.json 是否被缓存/拦截
try {
  applyPack(INLINE_EMOJI_PACK);
} catch (err) {
  console.warn('[inline-emoji] pack init failed', err?.message || err);
}

export async function ensureInlineEmojis() {
  if (_list.length) return _list;
  if (_ready) return _ready;
  _ready = (async () => {
    try {
      applyPack(INLINE_EMOJI_PACK);
      if (_list.length) return _list;
      const resp = await fetch(`${BASE}/manifest.json`, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`manifest ${resp.status}`);
      applyPack(await resp.json());
    } catch (err) {
      console.warn('[inline-emoji] load failed', err?.message || err);
      _list = [];
      _byCode = new Map();
    }
    return _list;
  })();
  return _ready;
}

export function getInlineEmojis() {
  return _list;
}

export function lookupInlineEmoji(code) {
  const key = String(code || '').trim();
  if (!key) return null;
  return _byCode.get(key) || _byCode.get(key.toLowerCase()) || null;
}

export function tokenFor(code) {
  return `[${String(code || '').trim()}]`;
}

/** 在已 escape 的 HTML 文本里，把 [微笑] 换成 <img> */
export function renderInlineEmojiHtml(escapedText) {
  const s = String(escapedText || '');
  if (!s || !_byCode.size) return s;
  return s.replace(/\[([^\[\]\n]{1,20})\]/g, (full, code) => {
    const hit = lookupInlineEmoji(code);
    if (!hit) return full;
    return `<img class="inline-bean-emoji" src="${esc(hit.url)}" alt="${esc(tokenFor(hit.code))}" title="${esc(hit.code)}" draggable="false">`;
  });
}

/** 去掉已知小黄豆标记（语音条/TTS 用，不保留图也不留 [微笑]） */
export function stripInlineBeanTokens(text) {
  let t = String(text || '');
  if (!t) return '';
  t = t.replace(/\[([^\[\]\n]{1,20})\]/g, (full, code) => (lookupInlineEmoji(code) ? '' : full));
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 纯文本 → 安全 HTML，并渲染小黄豆（换行可选） */
export function formatTextWithInlineEmojis(text, { nl2br = true } = {}) {
  let s = esc(text);
  if (nl2br) s = s.replace(/\n/g, '<br>');
  return renderInlineEmojiHtml(s);
}

export function insertInlineEmojiAtCursor(inputEl, code) {
  const el = inputEl;
  if (!el) return false;
  const token = tokenFor(code);
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  el.value = before + token + after;
  const pos = start + token.length;
  try {
    el.focus();
    el.setSelectionRange(pos, pos);
  } catch { /* ignore */ }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

export function buildInlineEmojiGridHtml({ onclick = 'pickSystemBeanEmoji' } = {}) {
  if (!_list.length) {
    return '<div class="emoji-panel-empty">小黄豆加载中…</div>';
  }
  return _list.map((e) =>
    `<button type="button" class="inline-bean-pick" title="${esc(e.code)}" aria-label="${esc(e.code)}" onclick="${onclick}('${esc(e.code)}')">` +
      `<img src="${esc(e.url)}" alt="${esc(e.code)}" loading="lazy" draggable="false">` +
    `</button>`
  ).join('');
}

/** 通用浮层选择器：优先小黄豆，再表情包分类 */
export async function openSystemEmojiOverlay({
  targetInput = null,
  onPickBean = null,
  includeStickers = true,
  stickerPick = null,
} = {}) {
  await ensureInlineEmojis();
  let overlay = document.getElementById('system-bean-emoji-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'system-bean-emoji-overlay';
    overlay.className = 'overlay center system-bean-emoji-overlay';
    overlay.innerHTML = `
      <div class="system-bean-emoji-sheet" onclick="event.stopPropagation()">
        <div class="sheet-handle"></div>
        <div class="system-bean-emoji-head">
          <div class="system-bean-emoji-title">表情</div>
          <button type="button" class="btn btn-ghost btn-sm" onclick="closeSystemBeanEmojiOverlay()">关闭</button>
        </div>
        <div id="system-bean-emoji-tabs" class="emoji-panel-tabs system-bean-emoji-tabs"></div>
        <div id="system-bean-emoji-grid" class="emoji-panel-grid system-bean-emoji-grid"></div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) window.closeSystemBeanEmojiOverlay?.();
    });
    document.body.appendChild(overlay);
  }

  window._beanEmojiTargetInput = targetInput || null;
  window._beanEmojiOnPick = typeof onPickBean === 'function' ? onPickBean : null;
  window._beanEmojiStickerPick = typeof stickerPick === 'function' ? stickerPick : null;

  const tabs = overlay.querySelector('#system-bean-emoji-tabs');
  const grid = overlay.querySelector('#system-bean-emoji-grid');

  const tabDefs = [{ id: 'bean', name: '小黄豆' }];
  let stickerCats = [];
  if (includeStickers) {
    try {
      const { getEmojiCategories } = await import('./api.js');
      stickerCats = (await getEmojiCategories()) || [];
      stickerCats.forEach((c) => tabDefs.push({ id: `s-${c.id}`, name: c.name || '表情包', cat: c }));
    } catch { /* ignore */ }
  }

  const renderTab = (idx) => {
    tabs.querySelectorAll('.emoji-panel-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
    const def = tabDefs[idx];
    if (!def) return;
    if (def.id === 'bean') {
      grid.classList.add('is-bean-panel');
      grid.innerHTML = buildInlineEmojiGridHtml({ onclick: 'pickSystemBeanEmoji' });
      return;
    }
    grid.classList.remove('is-bean-panel');
    const emojis = (def.cat?.emojis || []).filter((em) => !em.missing);
    if (!emojis.length) {
      grid.innerHTML = '<div class="emoji-panel-empty">这个分类还没有表情</div>';
      return;
    }
    grid.innerHTML = emojis.map((em) => {
      const raw = `/uploads/${em.filename || String(em.url || '').replace(/^.*\//, '').split('?')[0]}`;
      const url = window.resolveMediaUrl?.(em.url || raw) || raw;
      const desc = esc(em.description || '');
      return `<img class="emoji-panel-item" src="${esc(url)}" alt="${desc}" title="${desc}" loading="lazy"
        data-url="${esc(raw)}" data-desc="${desc}"
        onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src=this.src.split('?')[0]+'?_r='+Date.now()}"
        onclick="pickSystemStickerEmoji(this)">`;
    }).join('');
  };

  tabs.innerHTML = tabDefs.map((t, i) =>
    `<div class="emoji-panel-tab${i === 0 ? ' active' : ''}" data-idx="${i}">${esc(t.name)}</div>`
  ).join('');
  tabs.querySelectorAll('.emoji-panel-tab').forEach((el) => {
    el.addEventListener('click', () => renderTab(Number(el.dataset.idx) || 0));
  });
  renderTab(0);

  overlay.style.display = 'flex';
  overlay.classList.add('active');
}

window.closeSystemBeanEmojiOverlay = function closeSystemBeanEmojiOverlay() {
  const overlay = document.getElementById('system-bean-emoji-overlay');
  if (!overlay) return;
  const input = window._beanEmojiTargetInput;
  overlay.classList.remove('active');
  overlay.style.display = 'none';
  window._beanEmojiTargetInput = null;
  window._beanEmojiOnPick = null;
  window._beanEmojiStickerPick = null;
  // 关掉表情后把焦点还给输入框，方便继续打字（系统键盘可再弹）
  if (input && document.body.contains(input)) {
    requestAnimationFrame(() => {
      try { input.focus({ preventScroll: true }); } catch { input.focus(); }
    });
  }
};

window.pickSystemBeanEmoji = function pickSystemBeanEmoji(code) {
  const onPick = window._beanEmojiOnPick;
  const input = window._beanEmojiTargetInput;
  if (typeof onPick === 'function') onPick(code);
  else if (input) insertInlineEmojiAtCursor(input, code);
  window.closeSystemBeanEmojiOverlay?.();
};

window.pickSystemStickerEmoji = function pickSystemStickerEmoji(el) {
  const url = el?.dataset?.url;
  const desc = el?.dataset?.desc || '';
  if (!url) return;
  if (typeof window._beanEmojiStickerPick === 'function') {
    window._beanEmojiStickerPick(url, desc);
  }
  window.closeSystemBeanEmojiOverlay?.();
};

// 预加载
ensureInlineEmojis().catch(() => {});

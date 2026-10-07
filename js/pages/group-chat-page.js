/* ===== 群聊（微信群风格：composer + 群设置） ===== */
import * as api from '../api.js';
import { escapeHtml, parseUTCDate } from '../memory.js';
import {
  buildBubble,
  encodeUserVoiceContent,
  resolveBubbleFontSizePx,
  resolveBubbleSizeScale,
  resolveBubbleFontFamily,
  resolveBubbleGapPx,
  resolveBubbleTextColor,
} from '../chat.js?v=swipe1';
import { getGroupChatSettings, saveGroupChatSettings, getThemeColor } from '../storage.js';
import {
  ensureInlineEmojis,
  buildInlineEmojiGridHtml,
  insertInlineEmojiAtCursor,
  formatTextWithInlineEmojis,
} from '../inline-emoji.js';

let _groupId = null;
let _group = null;
let _memberMap = new Map();
let _sending = false;
let _typingIds = new Set();
let _voiceMode = false;
let _emojiOpen = false;
let _toolbarOpen = false;
let _emojiCatsCache = null;
let _emojiPanelMode = 'bean';
let _emojiStickerIdx = 0;
let _allMessages = [];
let _pendingBeautify = null;

function isNpcChar(c) {
  return !!(c?.is_circle_npc || c?.source === 'circle_npc' || Number(c?.circle_npc_id) > 0);
}

function memberLabel(c) {
  return c?.display_name || c?.remark || c?.name || '成员';
}

function showMemberNames() {
  return _group?.show_member_names !== false;
}

function userAvatarHtml(settings) {
  const url = settings?.user_avatar || '';
  if (url) return `<img class="avatar bubble-avatar" src="${escapeHtml(url)}" alt="">`;
  return `<div class="avatar bubble-avatar" style="font-size:18px">🙂</div>`;
}

function charAvatarHtml(char) {
  if (char?.avatar) return `<img class="avatar bubble-avatar" src="${escapeHtml(char.avatar)}" alt="">`;
  return `<div class="avatar bubble-avatar" style="font-size:18px">👤</div>`;
}

function parseMeta(msg) {
  if (!msg?.media_meta) return {};
  if (typeof msg.media_meta === 'object') return msg.media_meta;
  try { return JSON.parse(msg.media_meta || '{}'); } catch { return {}; }
}

function buildGroupBubble(msg, settings, opts = {}) {
  if (msg.role === 'system') {
    return `<div class="bubble-time poke-hint">${escapeHtml(msg.content || '')}</div>`;
  }
  const isUser = msg.role === 'user';
  const speaker = isUser ? null : (_memberMap.get(Number(msg.speaker_character_id)) || {});
  // 复用单聊气泡渲染（媒体 / 语音 / 贴纸 / 小黄豆文本）
  let core = '';
  try {
    core = buildBubble(
      { ...msg, dbId: msg.id },
      speaker || {},
      settings || {},
      { charId: speaker?.id || null }
    ) || '';
  } catch (e) {
    console.warn('[group-bubble]', e);
  }
  if (core) {
    if (!isUser && showMemberNames() && speaker) {
      const name = escapeHtml(memberLabel(speaker));
      core = core.replace(
        /(<div class="bubble-col">)/,
        `$1<div class="group-speaker-name">${name}</div>`
      );
    }
    return core.replace(
      /class="([^"]*\bbubble-wrap\b[^"]*)"/,
      (m, cls) => `class="${cls} group-bubble" data-msg-id="${msg.id}" data-speaker="${speaker?.id || ''}"`
    );
  }
  // 兜底纯文本
  const displayContent = opts.displayContent != null ? opts.displayContent : (msg.content || '');
  if (isUser) {
    return `
      <div class="bubble-wrap user group-bubble" data-msg-id="${msg.id}">
        ${userAvatarHtml(settings)}
        <div class="bubble-col">
          <div class="bubble-block user"><div class="bubble-text">${formatTextWithInlineEmojis(displayContent)}</div></div>
        </div>
      </div>`;
  }
  const name = memberLabel(speaker);
  return `
    <div class="bubble-wrap ai group-bubble" data-msg-id="${msg.id}" data-speaker="${speaker?.id || ''}">
      ${charAvatarHtml(speaker)}
      <div class="bubble-col">
        ${showMemberNames() ? `<div class="group-speaker-name">${escapeHtml(name)}</div>` : ''}
        <div class="bubble-block ai"><div class="bubble-text">${formatTextWithInlineEmojis(displayContent)}</div></div>
      </div>
    </div>`;
}

function renderTyping() {
  const el = document.getElementById('group-typing');
  if (!el) return;
  if (!_typingIds.size) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  const names = [..._typingIds].map((id) => memberLabel(_memberMap.get(Number(id))));
  el.style.display = '';
  el.textContent = names.length === 1
    ? `${names[0]}正在输入…`
    : `${names.slice(0, 2).join('、')}正在输入…`;
}

function appendMsg(msg, settings, opts = {}) {
  const list = document.getElementById('group-messages-list');
  if (!list) return;
  if (list.querySelector(`[data-msg-id="${msg.id}"]`)) return;
  _allMessages.push(msg);
  list.insertAdjacentHTML('beforeend', buildGroupBubble(msg, settings, opts));
  list.scrollTop = list.scrollHeight;
}

function updateMsgContent(msgId, content) {
  const el = document.querySelector(`#group-messages-list [data-msg-id="${msgId}"] .bubble-text, #group-messages-list [data-msg-id="${msgId}"] .content`);
  if (!el) return;
  el.innerHTML = formatTextWithInlineEmojis(content || '');
  const list = document.getElementById('group-messages-list');
  if (list) list.scrollTop = list.scrollHeight;
}

function memberStackHtml(members) {
  const list = (members || []).slice(0, 4);
  return `<div class="group-avatar-stack">${list.map((m) => (
    m.avatar
      ? `<img src="${escapeHtml(m.avatar)}" alt="">`
      : `<span>👤</span>`
  )).join('')}</div>`;
}

function displayGroupTitle(g) {
  return (g?.remark || g?.title || '群聊');
}

function hexToRgbTriplet(hex) {
  const h = String(hex || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
  return `${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)}`;
}

function applyGroupBeautify(groupId) {
  const el = document.getElementById('group-messages-list');
  const shell = document.querySelector('#group-chat-page .group-chat-shell');
  const s = _pendingBeautify || getGroupChatSettings(groupId);
  if (el) {
    if (typeof window.applyBubbleStyleToEl === 'function') {
      window.applyBubbleStyleToEl(el, s);
    } else {
      el.style.setProperty('--bubble-font-size', `${resolveBubbleFontSizePx(s)}px`);
      el.style.setProperty('--bubble-size', String(resolveBubbleSizeScale(s)));
      el.style.setProperty('--bubble-font-family', resolveBubbleFontFamily(s));
      el.style.setProperty('--bubble-gap', `${resolveBubbleGapPx(s)}px`);
      const tc = resolveBubbleTextColor(s);
      el.style.setProperty('--bubble-text-color', tc === 'white' ? '#fff' : '#111');
      const color = String(s.userBubbleColor || '').trim();
      let rgb = hexToRgbTriplet(color);
      if (!rgb) {
        const theme = getThemeColor() || '#c9a0dc';
        rgb = hexToRgbTriplet(theme) || '201,160,220';
      }
      el.style.setProperty('--theme-rgb', rgb);
      if (/^#[0-9a-fA-F]{6}$/.test(color)) el.style.setProperty('--user-bubble-bg', color);
      const charColor = String(s.charBubbleColor || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(charColor)) el.style.setProperty('--bubble-ai-bg', charColor);
    }
  }
  if (shell) {
    const bgType = s.bgType || 'gradient';
    if (bgType === 'image' && s.bgValue) {
      shell.style.backgroundImage = `url(${s.bgValue})`;
      shell.style.backgroundSize = 'cover';
      shell.style.backgroundPosition = 'center';
    } else if (bgType === 'solid' && s.bgColor) {
      shell.style.backgroundImage = 'none';
      shell.style.backgroundColor = s.bgColor;
    } else {
      shell.style.backgroundImage = '';
      shell.style.backgroundColor = '';
    }
  }
}

function closePanels() {
  _emojiOpen = false;
  _toolbarOpen = false;
  const emoji = document.getElementById('group-emoji-panel');
  const toolbar = document.getElementById('group-toolbar');
  if (emoji) emoji.style.display = 'none';
  if (toolbar) toolbar.style.display = 'none';
}

window.initGroupChatPage = async function() {
  const page = document.getElementById('group-chat-page');
  if (!page) return;
  _groupId = window._pendingGroupId || _groupId;
  window._pendingGroupId = null;
  if (!_groupId) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">未选择群聊</div></div>`;
    return;
  }

  page.innerHTML = `<div class="loading"><div class="loading-spinner"></div></div>`;
  try {
    const [group, messages, settings] = await Promise.all([
      api.getGroup(_groupId),
      api.getGroupMessages(_groupId, { limit: 100 }),
      api.getSettings(),
    ]);
    _group = group;
    _memberMap = new Map((group.members || []).map((m) => [Number(m.id), m]));
    _typingIds = new Set();
    _allMessages = Array.isArray(messages) ? [...messages] : [];
    _voiceMode = false;
    closePanels();
    _pendingBeautify = null;

    const ann = String(group.announcement || '').trim();
    page.innerHTML = `
      <div class="group-chat-shell">
        <div class="topbar">
          <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
          <div class="topbar-title group-chat-title">
            ${memberStackHtml(group.members)}
            <span>${escapeHtml(displayGroupTitle(group))}</span>
            ${group.muted ? '<span class="group-mute-tag" title="消息免打扰">🔕</span>' : ''}
          </div>
          <button type="button" class="topbar-action" onclick="openGroupInfo()" title="群聊设置">···</button>
        </div>
        ${ann ? `<div class="group-announcement-banner" onclick="openGroupInfoEdit('announcement')">${escapeHtml(ann)}</div>` : ''}
        <div id="group-messages-list" class="scroll-area group-messages-list messages-area">
          ${_allMessages.map((m) => buildGroupBubble(m, settings)).join('')}
        </div>
        <div id="group-typing" class="group-typing" style="display:none"></div>
        <div class="group-composer chat-composer" id="group-composer">
          <button type="button" class="chat-plus-btn" id="group-plus-btn" onclick="toggleGroupToolbar()" title="更多" aria-label="更多">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button type="button" class="chat-voice-toggle" id="group-voice-toggle" onclick="toggleGroupVoiceMode()" title="语音" aria-label="切换语音">
            <svg class="chat-voice-icon-mic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>
            <svg class="chat-voice-icon-kbd" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg>
          </button>
          <button type="button" class="group-at-btn" onclick="insertGroupAt()" title="@">@</button>
          <div class="chat-composer-field">
            <textarea id="group-input" class="chat-input" rows="1" placeholder="发送消息"
              onkeydown="groupInputKey(event)" oninput="autoResize(this)"></textarea>
            <button type="button" class="chat-hold-talk" id="group-hold-talk" style="display:none"
              aria-label="按住说话">按住 说话</button>
            <button type="button" class="chat-emoji-btn" id="group-emoji-btn" onclick="toggleGroupEmojiPanel()" title="表情" aria-label="表情">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"/></svg>
            </button>
          </div>
          <button type="button" class="chat-send-btn" onclick="sendGroupChat()" title="发送" aria-label="发送">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>
          </button>
        </div>
        <div id="group-toolbar" class="chat-toolbar-panel group-toolbar-panel" style="display:none">
          <div class="toolbar-grid">
            <button type="button" class="toolbar-item" onclick="openGroupCamera()">
              <div class="toolbar-icon toolbar-icon--cam"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></div>
              <span class="toolbar-label">拍照</span>
            </button>
            <button type="button" class="toolbar-item" onclick="openGroupImagePicker()">
              <div class="toolbar-icon toolbar-icon--img"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8 8"/></svg></div>
              <span class="toolbar-label">图片</span>
            </button>
            <button type="button" class="toolbar-item" onclick="sendGroupLocation()">
              <div class="toolbar-icon toolbar-icon--loc"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg></div>
              <span class="toolbar-label">位置</span>
            </button>
          </div>
        </div>
        <div id="group-emoji-panel" class="chat-emoji-panel" style="display:none">
          <div id="group-emoji-panel-tabs" class="emoji-panel-tabs"></div>
          <div id="group-emoji-picker-content" class="emoji-panel-grid"></div>
        </div>
        <div id="group-at-sheet" class="group-at-sheet" style="display:none"></div>
        <input type="file" id="group-img-input" accept="image/*" style="display:none" onchange="handleGroupImageFile(event)">
        <input type="file" id="group-cam-input" accept="image/*" capture="environment" style="display:none" onchange="handleGroupImageFile(event)">
      </div>
    `;
    applyGroupBeautify(_groupId);
    const list = document.getElementById('group-messages-list');
    if (list) list.scrollTop = list.scrollHeight;
    void api.markGroupRead(_groupId);
    window.clearGroupUnread?.(_groupId);
    window._activeGroupId = _groupId;
    window._groupChatVoiceTarget = _groupId;
    void ensureGroupVoiceReady();
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">加载失败：${escapeHtml(e.message || '')}</div></div>`;
  }
};

window.openGroupChat = async function(groupId) {
  window._pendingGroupId = groupId;
  try {
    await window.preloadPage?.('group-chat');
    await import('./group-chat-page.js').catch(() => {});
  } catch {}
  window.navigateTo?.('group-chat');
};

/* ---------- composer ---------- */

window.toggleGroupVoiceMode = function() {
  _voiceMode = !_voiceMode;
  closePanels();
  const input = document.getElementById('group-input');
  const hold = document.getElementById('group-hold-talk');
  const toggle = document.getElementById('group-voice-toggle');
  if (input) input.style.display = _voiceMode ? 'none' : '';
  if (hold) hold.style.display = _voiceMode ? '' : 'none';
  if (toggle) {
    const mic = toggle.querySelector('.chat-voice-icon-mic');
    const kbd = toggle.querySelector('.chat-voice-icon-kbd');
    if (mic) mic.style.display = _voiceMode ? 'none' : '';
    if (kbd) kbd.style.display = _voiceMode ? '' : 'none';
  }
  if (_voiceMode) {
    window._groupChatVoiceTarget = _groupId;
    void ensureGroupVoiceReady();
  }
};

async function ensureGroupVoiceReady() {
  try {
    if (!window.ensureVoiceHoldBound) {
      await import('./chat-page.js').catch(() => {});
    }
    window.ensureVoiceHoldBound?.('group-hold-talk');
  } catch { /* ignore */ }
}

window.toggleGroupToolbar = function() {
  _toolbarOpen = !_toolbarOpen;
  _emojiOpen = false;
  const toolbar = document.getElementById('group-toolbar');
  const emoji = document.getElementById('group-emoji-panel');
  if (emoji) emoji.style.display = 'none';
  if (toolbar) toolbar.style.display = _toolbarOpen ? '' : 'none';
};

window.toggleGroupEmojiPanel = async function() {
  _emojiOpen = !_emojiOpen;
  _toolbarOpen = false;
  const toolbar = document.getElementById('group-toolbar');
  const emoji = document.getElementById('group-emoji-panel');
  if (toolbar) toolbar.style.display = 'none';
  if (!emoji) return;
  if (!_emojiOpen) {
    emoji.style.display = 'none';
    return;
  }
  emoji.style.display = '';
  await renderGroupEmojiPicker();
};

async function renderGroupEmojiPicker() {
  const tabs = document.getElementById('group-emoji-panel-tabs');
  const content = document.getElementById('group-emoji-picker-content');
  if (!content) return;
  await ensureInlineEmojis();
  if (!_emojiCatsCache) {
    try {
      const cats = await api.getEmojiCategories();
      _emojiCatsCache = (cats || []).map((c) => ({
        ...c,
        emojis: (c.emojis || []).filter((e) => !e.missing),
      })).filter((c) => (c.emojis || []).length > 0);
    } catch {
      _emojiCatsCache = [];
    }
  }
  const filtered = _emojiCatsCache || [];
  if (_emojiPanelMode !== 'sticker') _emojiPanelMode = 'bean';
  if (tabs) {
    tabs.innerHTML = [
      `<div class="emoji-panel-tab${_emojiPanelMode === 'bean' ? ' active' : ''}" onclick="switchGroupEmojiTab('bean')">小黄豆</div>`,
      ...filtered.map((cat, i) =>
        `<div class="emoji-panel-tab${_emojiPanelMode === 'sticker' && _emojiStickerIdx === i ? ' active' : ''}" onclick="switchGroupEmojiTab(${i})">${escapeHtml(cat.name)}</div>`
      ),
    ].join('');
  }
  if (_emojiPanelMode === 'bean') {
    content.classList.add('is-bean-panel');
    content.innerHTML = buildInlineEmojiGridHtml({ onclick: 'insertGroupBeanEmoji' })
      || '<div class="emoji-panel-empty">小黄豆加载失败</div>';
  } else if (filtered.length) {
    content.classList.remove('is-bean-panel');
    const cat = filtered[_emojiStickerIdx] || filtered[0];
    content.innerHTML = (cat.emojis || []).map((em) => {
      const raw = `/uploads/${em.filename || String(em.url || '').replace(/^.*\//, '').split('?')[0]}`;
      const src = window.resolveMediaUrl?.(em.url || raw) || raw;
      return `<img class="emoji-panel-item" src="${escapeHtml(src)}" alt="" loading="lazy"
        onclick="sendGroupSticker('${escapeHtml(raw)}', '${escapeHtml(em.description || '')}')">`;
    }).join('');
  } else {
    content.classList.add('is-bean-panel');
    content.innerHTML = buildInlineEmojiGridHtml({ onclick: 'insertGroupBeanEmoji' });
  }
}

window.switchGroupEmojiTab = function(idx) {
  if (idx === 'bean') _emojiPanelMode = 'bean';
  else {
    _emojiPanelMode = 'sticker';
    _emojiStickerIdx = Number(idx) || 0;
  }
  void renderGroupEmojiPicker();
};

window.insertGroupBeanEmoji = function(code) {
  const input = document.getElementById('group-input');
  if (!input) return;
  if (_voiceMode) toggleGroupVoiceMode();
  insertInlineEmojiAtCursor(input, code);
  window.autoResize?.(input);
};

window.sendGroupSticker = async function(url, description) {
  closePanels();
  await sendGroupPayload({ content: url, type: 'emoji', media_meta: { emojiDescription: description || '' } });
};

window.openGroupCamera = function() {
  const el = document.getElementById('group-cam-input');
  if (!el) return;
  el.value = '';
  el.click();
};

window.openGroupImagePicker = function() {
  const el = document.getElementById('group-img-input');
  if (!el) return;
  el.value = '';
  el.click();
};

window.handleGroupImageFile = async function(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  closePanels();
  try {
    const uploaded = await api.uploadFile(file);
    const url = uploaded?.url || uploaded?.path || '';
    if (!url) throw new Error('上传失败');
    await sendGroupPayload({ content: url, type: 'image' });
  } catch (e) {
    window.showToast?.(e.message || '图片发送失败');
  } finally {
    if (event?.target) event.target.value = '';
  }
};

window.sendGroupLocation = async function() {
  closePanels();
  try {
    const pos = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('设备不支持定位'));
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000 });
    });
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const label = `位置 ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    await sendGroupPayload({
      content: label,
      type: 'location',
      media_meta: { lat, lng, name: label },
    });
  } catch (e) {
    window.showToast?.(e.message || '定位失败');
  }
};

/** 供单聊语音录制结束时转发到群聊 */
window.sendGroupVoiceMessage = async function(content, extra = {}) {
  if (!_groupId) return;
  await sendGroupPayload({
    content,
    type: 'voice',
    media_meta: extra || {},
  });
};

async function sendGroupPayload(payload) {
  if (_sending || !_groupId) return;
  const content = String(payload.content || '').trim();
  if (!content) return;
  _sending = true;
  try {
    const settings = await api.getSettings().catch(() => ({}));
    const res = await api.sendGroupMessage(_groupId, {
      content,
      type: payload.type || 'text',
      media_meta: payload.media_meta || undefined,
      noReply: !!payload.noReply,
    });
    if (res?.userMsg) appendMsg(res.userMsg, settings);
    if (res?.plan?.skipped) window.showToast?.('这轮没人接话');
  } catch (e) {
    window.showToast?.(e.message || '发送失败');
  } finally {
    _sending = false;
  }
}

window.insertGroupAt = function() {
  const sheet = document.getElementById('group-at-sheet');
  if (!sheet || !_group) return;
  if (sheet.style.display !== 'none') {
    sheet.style.display = 'none';
    return;
  }
  sheet.innerHTML = (_group.members || []).map((m) => `
    <button type="button" class="group-at-item" onclick="pickGroupAt(${m.id})">${escapeHtml(memberLabel(m))}${isNpcChar(m) ? ' ·圈子' : ''}</button>
  `).join('') + `<button type="button" class="group-at-item cancel" onclick="document.getElementById('group-at-sheet').style.display='none'">取消</button>`;
  sheet.style.display = '';
};

window.pickGroupAt = function(charId) {
  const m = _memberMap.get(Number(charId));
  const input = document.getElementById('group-input');
  const sheet = document.getElementById('group-at-sheet');
  if (sheet) sheet.style.display = 'none';
  if (!input || !m) return;
  if (_voiceMode) toggleGroupVoiceMode();
  const at = `@${memberLabel(m)} `;
  input.value = (input.value || '') + (input.value && !/\s$/.test(input.value) ? ' ' : '') + at;
  input.focus();
  window.autoResize?.(input);
};

window.groupInputKey = function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    window.sendGroupChat?.();
  }
};

window.sendGroupChat = async function() {
  const input = document.getElementById('group-input');
  const text = String(input?.value || '').trim();
  if (!text) return;
  if (input) {
    input.value = '';
    window.autoResize?.(input);
  }
  closePanels();
  await sendGroupPayload({ content: text, type: 'text' });
};

window.handleGroupWsMessage = function(data) {
  if (!data) return;
  if (data.type === 'group_typing') {
    if (Number(data.groupId) !== Number(_groupId)) return;
    if (data.typing) _typingIds.add(Number(data.characterId));
    else _typingIds.delete(Number(data.characterId));
    renderTyping();
    return;
  }
  if (data.type === 'group_message') {
    const gid = Number(data.groupId);
    const active = window._activeGroupId && gid === Number(window._activeGroupId);
    if (active) {
      void api.getSettings().then((settings) => {
        const msg = data.message;
        if (!msg) return;
        const prefix = data.halfPrefix;
        const rest = data.halfRest;
        if (prefix != null && rest != null && String(msg.content || '').startsWith(String(prefix))) {
          appendMsg(msg, settings, { displayContent: prefix });
          const delay = Math.min(2200, 400 + String(rest).length * 35);
          setTimeout(() => updateMsgContent(msg.id, msg.content), delay);
        } else {
          appendMsg(msg, settings);
        }
      }).catch(() => appendMsg(data.message, {}));
      void api.markGroupRead(gid);
      window.clearGroupUnread?.(gid);
    }
  }
};

/* ---------- 建群 / 拉人 ---------- */

function pickMembersOverlay({ title, chars, selectedIds = [], minCount = 2, onOk }) {
  const selected = new Set((selectedIds || []).map(Number));
  const html = chars.map((c) => `
    <label class="group-create-item">
      <input type="checkbox" value="${c.id}" ${selected.has(Number(c.id)) ? 'checked' : ''}>
      ${c.avatar ? `<img src="${escapeHtml(c.avatar)}" alt="">` : '<span class="ph">👤</span>'}
      <span>${escapeHtml(memberLabel(c))}${isNpcChar(c) ? '<em class="group-npc-tag">圈子</em>' : ''}</span>
    </label>
  `).join('');
  const overlay = document.createElement('div');
  overlay.className = 'group-create-overlay';
  overlay.innerHTML = `
    <div class="group-create-panel">
      <div class="group-create-title">${escapeHtml(title)}</div>
      <div class="group-create-list">${html || '<div class="empty-text" style="padding:16px">暂无可选联系人</div>'}</div>
      <div class="group-create-actions">
        <button type="button" class="btn btn-ghost" data-act="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-act="ok">确定</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', async (e) => {
    const act = e.target?.dataset?.act;
    if (!act && e.target === overlay) {
      overlay.remove();
      return;
    }
    if (act === 'cancel') {
      overlay.remove();
      return;
    }
    if (act === 'ok') {
      const ids = [...overlay.querySelectorAll('input[type=checkbox]:checked')].map((el) => parseInt(el.value, 10));
      if (ids.length < minCount) {
        window.showToast?.(`请至少选 ${minCount} 人`);
        return;
      }
      try {
        await onOk(ids);
        overlay.remove();
      } catch (err) {
        window.showToast?.(err.message || '操作失败');
      }
    }
  });
}

window.createGroupChatFlow = async function() {
  try {
    const chars = await api.getCharacters({ scope: 'chat' });
    if (!chars?.length || chars.length < 2) {
      window.showToast?.('至少需要 2 个联系人才能建群');
      return;
    }
    pickMembersOverlay({
      title: '发起群聊',
      chars,
      minCount: 2,
      onOk: async (ids) => {
        const g = await api.createGroup({ member_ids: ids });
        window.openGroupChat(g.id);
      },
    });
  } catch (e) {
    window.showToast?.(e.message);
  }
};

window.addGroupMembersFlow = async function() {
  if (!_group) return;
  try {
    const chars = await api.getCharacters({ scope: 'chat' });
    const have = new Set((_group.member_ids || []).map(Number));
    const candidates = (chars || []).filter((c) => !have.has(Number(c.id)));
    if (!candidates.length) {
      window.showToast?.('没有可添加的联系人');
      return;
    }
    pickMembersOverlay({
      title: '添加成员',
      chars: candidates,
      minCount: 1,
      onOk: async (ids) => {
        const next = [...new Set([...(_group.member_ids || []), ...ids])];
        const g = await api.updateGroup(_group.id, { member_ids: next });
        _group = g;
        _memberMap = new Map((g.members || []).map((m) => [Number(m.id), m]));
        window.showToast?.('已添加');
        openGroupInfo(true);
      },
    });
  } catch (e) {
    window.showToast?.(e.message);
  }
};

window.removeGroupMember = async function(charId) {
  if (!_group) return;
  const id = Number(charId);
  const next = (_group.member_ids || []).filter((x) => Number(x) !== id);
  if (next.length < 2) {
    window.showToast?.('群聊至少保留 2 人');
    return;
  }
  const name = memberLabel(_memberMap.get(id));
  if (!confirm(`将「${name}」移出群聊？`)) return;
  try {
    const g = await api.updateGroup(_group.id, { member_ids: next });
    _group = g;
    _memberMap = new Map((g.members || []).map((m) => [Number(m.id), m]));
    openGroupInfo(true);
  } catch (e) {
    window.showToast?.(e.message);
  }
};

/* ---------- 微信式群设置 ---------- */

function ensureGroupSettingsOverlay() {
  let el = document.getElementById('group-settings-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'group-settings-overlay';
  el.className = 'overlay fullscreen group-settings-overlay';
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

window.openGroupInfo = function(keepOpen) {
  if (!_group) return;
  const el = ensureGroupSettingsOverlay();
  const g = _group;
  const members = g.members || [];
  const memberGrid = members.map((m) => `
    <div class="group-settings-member">
      <div class="group-settings-member-av" onclick="openChatWith?.(${m.id})">
        ${m.avatar ? `<img src="${escapeHtml(m.avatar)}" alt="">` : '<span>👤</span>'}
        <button type="button" class="group-settings-member-rm" onclick="event.stopPropagation();removeGroupMember(${m.id})" title="移除">−</button>
      </div>
      <div class="group-settings-member-name">${escapeHtml(memberLabel(m))}${isNpcChar(m) ? '<em>圈子</em>' : ''}</div>
    </div>
  `).join('') + `
    <div class="group-settings-member is-add" onclick="addGroupMembersFlow()">
      <div class="group-settings-member-av add">+</div>
      <div class="group-settings-member-name">添加</div>
    </div>`;

  const s = _pendingBeautify || getGroupChatSettings(g.id);
  el.innerHTML = `
    <div class="sheet-full group-settings-sheet">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="closeGroupInfo()" title="返回"></button>
        <div class="sheet-full-title">群聊设置</div>
        <span style="width:44px"></span>
      </div>
      <div class="sheet-full-body group-settings-body">
        <div class="group-settings-members">${memberGrid}</div>

        <div class="settings-group group-settings-block">
          <div class="settings-row" onclick="openGroupInfoEdit('title')">
            <span>群聊名称</span>
            <span class="settings-row-value">${escapeHtml(g.title || '未命名')}<span class="chev">›</span></span>
          </div>
          <div class="settings-row" onclick="openGroupInfoEdit('announcement')">
            <span>群公告</span>
            <span class="settings-row-value">${escapeHtml((g.announcement || '').slice(0, 18) || '未设置')}${(g.announcement || '').length > 18 ? '…' : ''}<span class="chev">›</span></span>
          </div>
          <div class="settings-row" onclick="openGroupInfoEdit('remark')">
            <span>备注</span>
            <span class="settings-row-value">${escapeHtml(g.remark || '未设置')}<span class="chev">›</span></span>
          </div>
          <div class="settings-row" onclick="openGroupChatSearch()">
            <span>查找聊天记录</span>
            <span class="settings-row-value"><span class="chev">›</span></span>
          </div>
        </div>

        <div class="settings-group group-settings-block">
          <div class="settings-row">
            <span>消息免打扰</span>
            <input type="checkbox" id="gs-muted" ${g.muted ? 'checked' : ''} onchange="toggleGroupMuted(this.checked)" style="width:18px;height:18px">
          </div>
          <div class="settings-row">
            <span>显示群成员昵称</span>
            <input type="checkbox" id="gs-show-names" ${g.show_member_names !== false ? 'checked' : ''} onchange="toggleGroupShowNames(this.checked)" style="width:18px;height:18px">
          </div>
        </div>

        <div class="settings-section-title" style="padding:12px 16px 6px">通讯美化</div>
        <div class="settings-group group-settings-block">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <label class="input-label">用户气泡颜色</label>
            <input type="color" id="gs-user-bubble" value="${escapeHtml(s.userBubbleColor || '#c9a0dc')}" oninput="onGroupBeautifyField('userBubbleColor', this.value)">
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <label class="input-label">角色气泡颜色</label>
            <input type="color" id="gs-char-bubble" value="${escapeHtml(s.charBubbleColor || '#f1f2f6')}" oninput="onGroupBeautifyField('charBubbleColor', this.value)">
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <label class="input-label">文字大小 ${resolveBubbleFontSizePx(s)}px</label>
            <input type="range" min="12" max="24" value="${resolveBubbleFontSizePx(s)}" oninput="onGroupBeautifyField('bubbleFontSizePx', Number(this.value)); this.previousElementSibling.textContent='文字大小 '+this.value+'px'">
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <label class="input-label">背景</label>
            <select id="gs-bg-type" onchange="onGroupBeautifyField('bgType', this.value)">
              <option value="gradient" ${(!s.bgType || s.bgType === 'gradient') ? 'selected' : ''}>跟随主题</option>
              <option value="solid" ${s.bgType === 'solid' ? 'selected' : ''}>纯色</option>
              <option value="image" ${s.bgType === 'image' ? 'selected' : ''}>图片 URL</option>
            </select>
            <input type="color" id="gs-bg-color" value="${escapeHtml(s.bgColor || '#f5f0fa')}" style="${s.bgType === 'solid' ? '' : 'display:none'}" oninput="onGroupBeautifyField('bgColor', this.value)">
            <input type="text" id="gs-bg-value" class="input" placeholder="图片 URL" value="${escapeHtml(s.bgValue || '')}" style="${s.bgType === 'image' ? '' : 'display:none'}" onchange="onGroupBeautifyField('bgValue', this.value)">
          </div>
          <div class="settings-row">
            <button type="button" class="btn btn-primary btn-sm" onclick="saveGroupBeautify()">保存美化</button>
          </div>
        </div>

        <div class="group-settings-danger">
          <button type="button" class="btn btn-danger" onclick="deleteCurrentGroup()">删除并退出</button>
        </div>
      </div>
    </div>`;
  el.style.display = '';
  if (!keepOpen) {
    // freshly opened
  }
};

window.closeGroupInfo = function() {
  const el = document.getElementById('group-settings-overlay');
  if (el) el.style.display = 'none';
  // 刷新聊天顶栏标题 / 昵称显示
  if (_groupId) {
    window._pendingGroupId = _groupId;
    void window.initGroupChatPage?.();
  }
};

window.openGroupInfoEdit = function(field) {
  if (!_group) return;
  let title = '';
  let value = '';
  let multi = false;
  if (field === 'title') {
    title = '群聊名称';
    value = _group.title || '';
  } else if (field === 'announcement') {
    title = '群公告';
    value = _group.announcement || '';
    multi = true;
  } else if (field === 'remark') {
    title = '备注';
    value = _group.remark || '';
  } else return;

  const overlay = document.createElement('div');
  overlay.className = 'group-create-overlay';
  overlay.innerHTML = `
    <div class="group-create-panel">
      <div class="group-create-title">${escapeHtml(title)}</div>
      ${multi
        ? `<textarea class="input" id="gs-edit-input" rows="5" style="width:100%;margin:8px 0">${escapeHtml(value)}</textarea>`
        : `<input class="input" id="gs-edit-input" value="${escapeHtml(value)}" style="width:100%;margin:8px 0">`}
      <div class="group-create-actions">
        <button type="button" class="btn btn-ghost" data-act="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-act="ok">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', async (e) => {
    const act = e.target?.dataset?.act;
    if (!act && e.target === overlay) { overlay.remove(); return; }
    if (act === 'cancel') { overlay.remove(); return; }
    if (act === 'ok') {
      const v = String(document.getElementById('gs-edit-input')?.value || '').trim();
      try {
        const payload = {};
        payload[field] = v;
        const g = await api.updateGroup(_group.id, payload);
        _group = g;
        overlay.remove();
        openGroupInfo(true);
        window.showToast?.('已保存');
      } catch (err) {
        window.showToast?.(err.message);
      }
    }
  });
};

window.toggleGroupMuted = async function(on) {
  if (!_group) return;
  try {
    const g = await api.updateGroup(_group.id, { muted: !!on });
    _group = g;
    window.setGroupMuted?.(_group.id, !!on);
    window.showToast?.(on ? '已开启免打扰' : '已关闭免打扰');
  } catch (e) {
    window.showToast?.(e.message);
  }
};

window.toggleGroupShowNames = async function(on) {
  if (!_group) return;
  try {
    const g = await api.updateGroup(_group.id, { show_member_names: !!on });
    _group = g;
  } catch (e) {
    window.showToast?.(e.message);
  }
};

window.onGroupBeautifyField = function(key, value) {
  if (!_group) return;
  const cur = { ...(_pendingBeautify || getGroupChatSettings(_group.id)) };
  cur[key] = value;
  _pendingBeautify = cur;
  if (key === 'bgType') {
    const c = document.getElementById('gs-bg-color');
    const v = document.getElementById('gs-bg-value');
    if (c) c.style.display = value === 'solid' ? '' : 'none';
    if (v) v.style.display = value === 'image' ? '' : 'none';
  }
  applyGroupBeautify(_group.id);
};

window.saveGroupBeautify = function() {
  if (!_group) return;
  const s = _pendingBeautify || getGroupChatSettings(_group.id);
  saveGroupChatSettings(s, _group.id);
  _pendingBeautify = null;
  applyGroupBeautify(_group.id);
  window.showToast?.('美化已保存');
};

window.openGroupChatSearch = function() {
  if (!_group) return;
  const overlay = document.createElement('div');
  overlay.className = 'group-create-overlay';
  overlay.innerHTML = `
    <div class="group-create-panel" style="max-height:80vh;display:flex;flex-direction:column">
      <div class="group-create-title">查找聊天记录</div>
      <input class="input" id="gs-search-q" placeholder="关键词" style="width:100%;margin:8px 0">
      <div id="gs-search-results" class="group-search-results"></div>
      <div class="group-create-actions">
        <button type="button" class="btn btn-ghost" data-act="cancel">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#gs-search-q');
  const results = overlay.querySelector('#gs-search-results');
  const run = () => {
    const q = String(input.value || '').trim().toLowerCase();
    if (!q) {
      results.innerHTML = '<div class="empty-text" style="padding:12px">输入关键词搜索</div>';
      return;
    }
    const hits = (_allMessages || []).filter((m) => {
      if (m.type && m.type !== 'text') return String(m.type).includes(q) || String(m.content || '').toLowerCase().includes(q);
      return String(m.content || '').toLowerCase().includes(q);
    }).slice(-50).reverse();
    if (!hits.length) {
      results.innerHTML = '<div class="empty-text" style="padding:12px">没有找到</div>';
      return;
    }
    results.innerHTML = hits.map((m) => {
      const who = m.role === 'user' ? '我' : memberLabel(_memberMap.get(Number(m.speaker_character_id)));
      const body = escapeHtml(String(m.content || '').slice(0, 80));
      return `<div class="group-search-item"><b>${escapeHtml(who)}</b> · ${body}</div>`;
    }).join('');
  };
  input.addEventListener('input', run);
  overlay.addEventListener('click', (e) => {
    if (e.target?.dataset?.act === 'cancel' || e.target === overlay) overlay.remove();
  });
  setTimeout(() => input.focus(), 50);
};

window.deleteCurrentGroup = async function() {
  if (!_group) return;
  if (!confirm(`删除群聊「${displayGroupTitle(_group)}」？消息将一并清除。`)) return;
  try {
    await api.deleteGroup(_group.id);
    window.showToast?.('已删除群聊');
    window._activeGroupId = null;
    window._groupChatVoiceTarget = null;
    closeGroupInfo();
    window.goBack?.();
  } catch (e) {
    window.showToast?.(e.message);
  }
};

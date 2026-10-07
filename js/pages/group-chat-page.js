/* ===== 群聊（微信群风格） ===== */
import * as api from '../api.js';
import { escapeHtml, parseUTCDate } from '../memory.js';

let _groupId = null;
let _group = null;
let _memberMap = new Map();
let _sending = false;
let _typingIds = new Set();

function userAvatarHtml(settings) {
  const url = settings?.user_avatar || '';
  if (url) return `<img class="avatar bubble-avatar" src="${escapeHtml(url)}" alt="">`;
  return `<div class="avatar bubble-avatar" style="font-size:18px">🙂</div>`;
}

function charAvatarHtml(char) {
  if (char?.avatar) return `<img class="avatar bubble-avatar" src="${escapeHtml(char.avatar)}" alt="">`;
  return `<div class="avatar bubble-avatar" style="font-size:18px">👤</div>`;
}

function fmtBubbleTime(ts) {
  if (!ts) return '';
  try {
    const d = parseUTCDate(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
}

function buildGroupBubble(msg, settings, opts = {}) {
  if (msg.role === 'system') {
    return `<div class="bubble-time poke-hint">${escapeHtml(msg.content || '')}</div>`;
  }
  const isUser = msg.role === 'user';
  const displayContent = opts.displayContent != null ? opts.displayContent : (msg.content || '');
  if (isUser) {
    return `
      <div class="bubble-wrap user" data-msg-id="${msg.id}">
        ${userAvatarHtml(settings)}
        <div class="bubble-col">
          <div class="bubble-block user"><div class="bubble-text">${escapeHtml(displayContent)}</div></div>
        </div>
      </div>`;
  }
  const char = _memberMap.get(Number(msg.speaker_character_id)) || {};
  const name = char.name || '成员';
  return `
    <div class="bubble-wrap ai group-bubble" data-msg-id="${msg.id}" data-speaker="${char.id || ''}">
      ${charAvatarHtml(char)}
      <div class="bubble-col">
        <div class="group-speaker-name">${escapeHtml(name)}</div>
        <div class="bubble-block ai"><div class="bubble-text">${escapeHtml(displayContent)}</div></div>
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
  const names = [..._typingIds].map((id) => _memberMap.get(Number(id))?.name || '成员');
  el.style.display = '';
  el.textContent = names.length === 1
    ? `${names[0]}正在输入…`
    : `${names.slice(0, 2).join('、')}正在输入…`;
}

function appendMsg(msg, settings, opts = {}) {
  const list = document.getElementById('group-messages-list');
  if (!list) return;
  if (list.querySelector(`[data-msg-id="${msg.id}"]`)) return;
  list.insertAdjacentHTML('beforeend', buildGroupBubble(msg, settings, opts));
  list.scrollTop = list.scrollHeight;
}

function updateMsgContent(msgId, content) {
  const el = document.querySelector(`#group-messages-list [data-msg-id="${msgId}"] .bubble-text`);
  if (!el) return;
  el.textContent = content || '';
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

    page.innerHTML = `
      <div class="group-chat-shell">
        <div class="topbar">
          <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
          <div class="topbar-title group-chat-title">
            ${memberStackHtml(group.members)}
            <span>${escapeHtml(group.title || '群聊')}</span>
          </div>
          <button type="button" class="topbar-action" onclick="openGroupInfo()" title="群信息">···</button>
        </div>
        <div id="group-messages-list" class="scroll-area group-messages-list">
          ${(messages || []).map((m) => buildGroupBubble(m, settings)).join('')}
        </div>
        <div id="group-typing" class="group-typing" style="display:none"></div>
        <div class="group-composer">
          <button type="button" class="group-at-btn" onclick="insertGroupAt()" title="@">@</button>
          <textarea id="group-input" class="input" rows="1" placeholder="发送消息"
            onkeydown="groupInputKey(event)" oninput="autoResize(this)"></textarea>
          <button type="button" class="btn btn-primary btn-sm" onclick="sendGroupChat()">发送</button>
        </div>
        <div id="group-at-sheet" class="group-at-sheet" style="display:none"></div>
      </div>
    `;
    const list = document.getElementById('group-messages-list');
    if (list) list.scrollTop = list.scrollHeight;
    void api.markGroupRead(_groupId);
    window.clearGroupUnread?.(_groupId);
    window._activeGroupId = _groupId;
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

window.openGroupInfo = async function() {
  if (!_group) return;
  const names = (_group.members || []).map((m) => m.name).join('、');
  const talk = (_group.members || []).map((m) => {
    const t = m.group_talkativeness === 'quiet' ? '少话' : m.group_talkativeness === 'lively' ? '爱接话' : '正常';
    const model = m.chat_model ? ` · ${m.chat_model}` : '';
    return `${m.name}（${t}${model}）`;
  }).join('\n');
  const ok = confirm(`群名：${_group.title}\n成员：${names}\n\n话唠度 / 模型：\n${talk}\n\n删除此群？`);
  if (!ok) return;
  try {
    await api.deleteGroup(_group.id);
    window.showToast?.('已删除群聊');
    window._activeGroupId = null;
    window.goBack?.();
  } catch (e) {
    window.showToast?.(e.message);
  }
};

window.insertGroupAt = function() {
  const sheet = document.getElementById('group-at-sheet');
  if (!sheet || !_group) return;
  if (sheet.style.display !== 'none') {
    sheet.style.display = 'none';
    return;
  }
  sheet.innerHTML = (_group.members || []).map((m) => `
    <button type="button" class="group-at-item" onclick="pickGroupAt(${m.id})">${escapeHtml(m.name)}</button>
  `).join('') + `<button type="button" class="group-at-item cancel" onclick="document.getElementById('group-at-sheet').style.display='none'">取消</button>`;
  sheet.style.display = '';
};

window.pickGroupAt = function(charId) {
  const m = _memberMap.get(Number(charId));
  const input = document.getElementById('group-input');
  const sheet = document.getElementById('group-at-sheet');
  if (sheet) sheet.style.display = 'none';
  if (!input || !m) return;
  const at = `@${m.name} `;
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
  if (_sending || !_groupId) return;
  const input = document.getElementById('group-input');
  const text = String(input?.value || '').trim();
  if (!text) return;
  _sending = true;
  input.value = '';
  window.autoResize?.(input);
  try {
    const settings = await api.getSettings().catch(() => ({}));
    const res = await api.sendGroupMessage(_groupId, { content: text, noReply: false });
    if (res?.userMsg) appendMsg(res.userMsg, settings);
    if (res?.plan?.skipped) {
      window.showToast?.('这轮没人接话');
    }
  } catch (e) {
    window.showToast?.(e.message || '发送失败');
  } finally {
    _sending = false;
  }
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

window.createGroupChatFlow = async function() {
  try {
    const allChars = await api.getCharacters({ scope: 'chat' });
    const chars = (allChars || []).filter((c) => !(
      c?.is_circle_npc || c?.source === 'circle_npc' || Number(c?.circle_npc_id) > 0
    ));
    if (!chars?.length || chars.length < 2) {
      window.showToast?.('至少需要 2 个完整角色好友才能建群（圈子好友不可进群）');
      return;
    }
    const html = chars.map((c) => `
      <label class="group-create-item">
        <input type="checkbox" value="${c.id}">
        ${c.avatar ? `<img src="${escapeHtml(c.avatar)}" alt="">` : '<span class="ph">👤</span>'}
        <span>${escapeHtml(c.display_name || c.remark || c.name)}</span>
      </label>
    `).join('');

    const overlay = document.createElement('div');
    overlay.className = 'group-create-overlay';
    overlay.innerHTML = `
      <div class="group-create-panel">
        <div class="group-create-title">发起群聊</div>
        <div class="group-create-list">${html}</div>
        <div class="group-create-actions">
          <button type="button" class="btn btn-ghost" data-act="cancel">取消</button>
          <button type="button" class="btn btn-primary" data-act="ok">创建</button>
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
        if (ids.length < 2) {
          window.showToast?.('请至少选 2 人');
          return;
        }
        try {
          const g = await api.createGroup({ member_ids: ids });
          overlay.remove();
          window.openGroupChat(g.id);
        } catch (err) {
          window.showToast?.(err.message);
        }
      }
    });
  } catch (e) {
    window.showToast?.(e.message);
  }
};

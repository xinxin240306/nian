/* ===== 通讯页（联系人 / 聊天收件箱 / 我） ===== */
import * as api from '../api.js';
import { escapeHtml, parseUTCDate, formatMessagePreview } from '../memory.js';
import { ICON_PLUS, ICON_PIN, ICON_PIN_FILLED, ICON_IMPORT } from '../ui-icons.js';
import { pickCropAndUpload, momentsCoverAspect } from '../media-crop.js';
import { getChatSettings, saveChatSettings, getPinnedCharIds, togglePinnedChar } from '../storage.js';
import { getThreadCache, clearThreadCache } from '../chat-thread-cache.js';
import { getDeviceCoordinates, formatLocationError } from '../app-permissions.js';
import {
  nativePermissionsHtml,
  bindNativePermissionToggles,
  refreshNativePermissionToggles,
} from '../native-permissions-ui.js';

let _tab = 'inbox'; // 默认打开聊天收件箱
let _contactsLoadToken = 0;
const CONTACTS_FETCH_MS = 15000;

const TAB_ICON_CHAT = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12c0-4.4 3.8-8 8.5-8S21 7.6 21 12s-3.8 8-8.5 8c-1.1 0-2.2-.2-3.2-.6L4 21l1.4-3.8C4.5 15.9 4 14 4 12z"/></svg>`;
const TAB_ICON_CONTACTS = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8S14.4 16 15 19"/><circle cx="17.5" cy="9" r="2.4"/><path d="M16 19c.3-1.8 1.5-3.2 3.5-3.6"/></svg>`;
const TAB_ICON_MOMENTS = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M3.5 12h17"/><path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/></svg>`;
const TAB_ICON_ME = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5 19.5c1-3.4 3.4-5 7-5s6 1.6 7 5"/></svg>`;

function charDisplayName(c) {
  return String(c?.display_name || c?.remark || c?.name || '角色').trim();
}

function isHiddenInboxPreview(msg) {
  try {
    const meta = typeof msg?.media_meta === 'string' ? JSON.parse(msg.media_meta || '{}') : (msg?.media_meta || {});
    return !!(meta.hideChat || meta.hiddenChat || meta.robotMic);
  } catch {
    return false;
  }
}

window.createCharFromContacts = function() {
  window._charEditorBackMode = 'goback';
  window._skipCharListOnce = true;
  window._pendingCharEditorId = null;
  window.navigateTo?.('character');
};

/** 联系人页导入角色卡（会先加载角色页模块以复用解析逻辑） */
window.importCharCardFromContacts = async function() {
  try {
    await window.preloadPage?.('character');
    await import('./character-page.js').catch(() => {});
  } catch {}
  if (typeof window.importCharCard === 'function') {
    window.importCharCard();
    return;
  }
  window.showToast?.('导入功能加载失败，请强制刷新后再试');
};

function contactsLoadErrorHtml(msg) {
  return `<div class="empty-state">
    <div class="empty-text">${msg || '加载失败'}<br>
      <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="switchContactsTab('${_tab}')">重试</button>
    </div>
  </div>`;
}

window.initContactsPage = async function() {
  const page = document.getElementById('contacts-page');
  const tab = window._contactsLastTab || 'inbox';
  _contactsLoadToken++;

  if (page.dataset.shellBuilt !== 'contacts-v6') {
  page.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%">
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
        <div class="topbar-title" id="ct-title" style="font-family:'Noto Serif SC',serif">通讯</div>
        <div class="topbar-actions"><div id="ct-action" style="display:none"></div></div>
      </div>
      <div id="ct-body" style="flex:1;overflow:hidden;position:relative">
        <div id="ct-content" class="scroll-area scroll-area-native" style="height:100%"></div>
        <div id="ct-add-friend-menu" class="ct-add-friend-menu" style="display:none"></div>
      </div>
      <div class="contacts-tabbar contacts-tabbar--line">
        <div class="contacts-tab" id="ct-tab-inbox" onclick="switchContactsTab('inbox')">
          <div class="contacts-tab-icon">${TAB_ICON_CHAT}<span class="contacts-tab-badge" id="ct-inbox-badge"></span></div>
          <span class="contacts-tab-label">聊天</span>
        </div>
        <div class="contacts-tab" id="ct-tab-contacts" onclick="switchContactsTab('contacts')">
          <div class="contacts-tab-icon">${TAB_ICON_CONTACTS}<span class="contacts-tab-badge" id="ct-friends-badge"></span></div>
          <span class="contacts-tab-label">联系人</span>
        </div>
        <div class="contacts-tab" id="ct-tab-moments" onclick="switchContactsTab('moments')">
          <div class="contacts-tab-icon">${TAB_ICON_MOMENTS}<span class="contacts-moments-dot" id="ct-moments-dot"></span><span class="contacts-tab-badge" id="ct-moments-badge"></span></div>
          <span class="contacts-tab-label">朋友圈</span>
        </div>
        <div class="contacts-tab" id="ct-tab-me" onclick="switchContactsTab('me')">
          <div class="contacts-tab-icon">${TAB_ICON_ME}</div>
          <span class="contacts-tab-label">我</span>
        </div>
      </div>
    </div>
  `;
  page.dataset.shellBuilt = 'contacts-v6';
  }

  window.preloadPage?.('chat');
  await switchContactsTab(tab);
  window.updateMomentsBadges?.();
};

window.switchContactsTab = async function(tab) {
  // 朋友圈 tab直接跳转，不改变通讯页的当前 tab
  if (tab === 'moments') { window.navigateTo('moments'); return; }

  try { stopShakeListening(); } catch {}

  _tab = tab;
  window._contactsLastTab = tab;

  ['inbox','contacts','moments','me'].forEach(t => {
    document.getElementById(`ct-tab-${t}`)?.classList.toggle('active', t === tab);
  });

  const title = document.getElementById('ct-title');
  const action = document.getElementById('ct-action');

  const hideAction = () => {
    if (!action) return;
    action.style.display = 'none';
    action.onclick = null;
    action.innerHTML = '';
    action.className = '';
  };
  const resetTopBack = () => {
    const backBtn = document.querySelector('#contacts-page .topbar-back');
    if (backBtn) {
      backBtn.onclick = (e) => {
        e?.preventDefault?.();
        window.goBack?.();
      };
    }
  };
  const setCreateCharAction = () => {
    if (!action) return;
    action.style.display = '';
    action.className = 'topbar-action';
    action.innerHTML = ICON_PLUS;
    action.title = '创建角色';
    action.onclick = (e) => {
      e?.stopPropagation?.();
      window.createCharFromContacts?.();
    };
  };

  document.getElementById('ct-add-friend-menu')?.style && (document.getElementById('ct-add-friend-menu').style.display = 'none');

  if (tab === 'inbox') {
    if (title) title.textContent = '聊天';
    if (action) {
      action.style.display = '';
      action.className = 'topbar-action';
      action.innerHTML = ICON_PLUS;
      action.title = '发起群聊';
      action.onclick = async (e) => {
        e?.stopPropagation?.();
        try {
          await window.preloadPage?.('group-chat');
          // preload 是 fire-and-forget；再等一帧确保模块已挂上
          await import('../pages/group-chat-page.js').catch(() => {});
        } catch {}
        window.createGroupChatFlow?.();
      };
    }
    resetTopBack();
    await renderInbox();
  } else if (tab === 'contacts') {
    if (title) title.textContent = '联系人';
    setCreateCharAction();
    resetTopBack();
    await renderContacts();
  } else {
    if (title) title.textContent = '我';
    hideAction();
    try {
      await renderMe();
    } catch (e) {
      console.error('[contacts] renderMe', e);
      const content = document.getElementById('ct-content');
      if (content) {
        content.innerHTML = `<div class="empty-state"><div class="empty-text">「我」加载失败<br>
          <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="switchContactsTab('me')">重试</button>
        </div></div>`;
      }
      window.showToast?.('「我」加载失败，请强制刷新', 4000);
    }
  }
};

/* ─── 聊天收件箱 ─── */
async function renderInbox() {
  const content = document.getElementById('ct-content');
  const token = ++_contactsLoadToken;
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    // 未读同步不要挡住收件箱；后端忙时这里以前会先卡 45s
    void window.syncUnreadCounts?.();
    const [chars, groups] = await Promise.all([
      api.getCharacters({ scope: 'chat', timeoutMs: CONTACTS_FETCH_MS }),
      api.getGroups().catch(() => []),
    ]);
    if (token !== _contactsLoadToken) return;
    if (!chars.length && !(groups || []).length) {
      content.innerHTML = `<div class="empty-state">
        <div class="empty-icon">💬</div>
        <div class="empty-text">还没有好友<br>
          <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="switchContactsTab('contacts')">去联系人添加</button>
        </div>
      </div>`;
      return;
    }
    chars.slice(0, 12).forEach((c) => { void getThreadCache(c.id, false); });

    // 分批拉取预览，避免角色多时一次性打爆后端
    const convs = [];
    const batchSize = 4;
    for (let i = 0; i < chars.length; i += batchSize) {
      if (token !== _contactsLoadToken) return;
      const batch = chars.slice(i, i + batchSize);
      const part = await Promise.all(batch.map(async c => {
        try {
          const msgs = await api.getMessages(c.id, { limit: 8, timeoutMs: CONTACTS_FETCH_MS });
          const last = [...(msgs || [])].reverse().find((m) => !isHiddenInboxPreview(m)) || null;
          return { kind: 'char', char: c, last };
        } catch { return { kind: 'char', char: c, last: null }; }
      }));
      convs.push(...part);
    }
    if (token !== _contactsLoadToken) return;

    const groupConvs = await Promise.all((groups || []).map(async (g) => {
      try {
        const msgs = await api.getGroupMessages(g.id, { limit: 1 });
        const last = msgs?.length ? msgs[msgs.length - 1] : null;
        return { kind: 'group', group: g, last };
      } catch {
        return { kind: 'group', group: g, last: null };
      }
    }));
    convs.push(...groupConvs);

    // 置顶优先，其余按最近消息时间倒序
    const pinned = getPinnedCharIds().map(String);
    convs.sort((a, b) => {
      if (a.kind === 'char' && b.kind === 'char') {
        const pa = pinned.indexOf(String(a.char.id));
        const pb = pinned.indexOf(String(b.char.id));
        if (pa >= 0 && pb >= 0) return pa - pb;
        if (pa >= 0) return -1;
        if (pb >= 0) return 1;
      }
      const ta = a.last?.timestamp ? parseUTCDate(a.last.timestamp).getTime() : 0;
      const tb = b.last?.timestamp ? parseUTCDate(b.last.timestamp).getTime() : 0;
      return tb - ta;
    });

    content.innerHTML = convs.map((row) => {
      if (row.kind === 'group') {
        const g = row.group;
        const m = row.last;
        const members = g.members || [];
        const avatars = members.slice(0, 4).map((mem) => (
          mem.avatar
            ? `<img src="${escapeHtml(mem.avatar)}" alt="">`
            : `<span>👤</span>`
        )).join('');
        let preview = '暂无消息';
        if (m) {
          const body = formatMessagePreview(m);
          if (m.role === 'user') preview = body;
          else {
            const sn = members.find((x) => Number(x.id) === Number(m.speaker_character_id))?.name || '';
            preview = sn ? `${sn}: ${body}` : body;
          }
        }
        const unread = window.getGroupUnreadCount?.(g.id) || 0;
        return `
      <div class="inbox-conv-row" onclick="openGroupChat(${g.id})">
        <div class="inbox-conv-avatar group-inbox-avatar">${avatars || '<div class="avatar" style="font-size:20px">👥</div>'}</div>
        <div class="inbox-conv-main">
          <div class="inbox-conv-top">
            <div class="inbox-conv-name">${escapeHtml(g.title || '群聊')}<span class="contacts-status-tag is-group">群</span></div>
            <div class="inbox-conv-meta">
              <span class="inbox-conv-time">${m ? fmtTime(m.timestamp) : ''}</span>
            </div>
          </div>
          <div class="inbox-conv-bottom">
            <div class="inbox-conv-preview${unread ? ' has-unread' : ''}">${escapeHtml(preview)}</div>
            ${unread
              ? `<div class="inbox-unread-badge" data-unread-group="${g.id}">${unread > 99 ? '99+' : unread}</div>`
              : `<div class="inbox-unread-badge" data-unread-group="${g.id}" style="display:none"></div>`}
          </div>
        </div>
      </div>`;
      }
      const c = row.char;
      const m = row.last;
      const unread = window.getUnreadCount?.(c.id) || 0;
      const isPinned = pinned.includes(String(c.id));
      const status = String(c.contact_status || '');
      return `
      <div class="inbox-swipe" data-char-id="${c.id}" data-contact-status="${escapeHtml(status)}">
        <div class="inbox-swipe-track">
          <div class="inbox-swipe-front">
            <div class="inbox-conv-row${isPinned ? ' is-pinned' : ''}" onclick="openChatWith(${c.id})">
              <div class="inbox-conv-avatar">
                ${c.avatar ? `<img class="avatar" src="${escapeHtml(c.avatar)}" alt="">` : `<div class="avatar" style="font-size:20px">👤</div>`}
                <div class="status-dot status-${Number(c.robot_operating) === 1 ? 'operating' : (c.status || 'online')}"></div>
              </div>
              <div class="inbox-conv-main">
                <div class="inbox-conv-top">
                  <div class="inbox-conv-name">${escapeHtml(charDisplayName(c))}${
                    status === 'blocked' ? '<span class="contacts-status-tag is-blocked">已拉黑</span>'
                    : (c.peer_status === 'blocked' ? '<span class="contacts-status-tag is-peer-blocked">已被拉黑</span>' : '')
                  }</div>
                  <div class="inbox-conv-meta">
                    <span class="inbox-conv-time">${m ? fmtTime(m.timestamp) : ''}</span>
                    <button type="button" class="inbox-pin-btn${isPinned ? ' is-on' : ''}"
                      title="${isPinned ? '取消置顶' : '置顶'}"
                      aria-label="${isPinned ? '取消置顶' : '置顶'}"
                      onclick="event.stopPropagation();toggleInboxPin(${c.id})">${isPinned ? ICON_PIN_FILLED : ICON_PIN}</button>
                  </div>
                </div>
                <div class="inbox-conv-bottom">
                  <div class="inbox-conv-preview${unread ? ' has-unread' : ''}">
                    ${m ? escapeHtml(formatMessagePreview(m)) : '暂无消息'}
                  </div>
                  ${unread
                    ? `<div class="inbox-unread-badge" data-unread-char="${c.id}">${unread > 99 ? '99+' : unread}</div>`
                    : `<div class="inbox-unread-badge" data-unread-char="${c.id}" style="display:none"></div>`}
                </div>
              </div>
            </div>
          </div>
          <button type="button" class="inbox-swipe-del" onclick="event.stopPropagation();deleteInboxConv(${c.id})">删除</button>
        </div>
      </div>
    `;}).join('');
    bindInboxSwipe();
    window.updateContactsTabBadge?.();
  } catch(e) {
    if (token !== _contactsLoadToken) return;
    content.innerHTML = contactsLoadErrorHtml(
      /超时|连不上|Failed to fetch/i.test(e.message || '') ? (api.explainBackendUnreachable?.() || '暂时连不上服务器，请检查网络') : `加载失败: ${e.message || '网络错误'}`
    );
  }
}

/* ─── 联系人列表 ─── */
async function renderContacts() {
  const content = document.getElementById('ct-content');
  const token = ++_contactsLoadToken;
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const [chars, reqData] = await Promise.all([
      api.getCharacters({ scope: 'friends', timeoutMs: CONTACTS_FETCH_MS }),
      api.getContactRequests().catch(() => ({ requests: [], pendingCount: 0 })),
    ]);
    if (token !== _contactsLoadToken) return;
    const pending = Number(reqData.pendingCount || 0);
    const badge = document.getElementById('ct-friends-badge');
    if (badge) {
      if (pending > 0) {
        badge.style.display = 'flex';
        badge.textContent = pending > 99 ? '99+' : String(pending);
      } else {
        badge.style.display = 'none';
      }
    }

    const NEW_FRIEND_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8S14.4 16 15 19"/><path d="M17 8v6M14 11h6"/></svg>`;
    const SHAKE_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3.5 6 6.5v11l2.5 3"/><path d="M15.5 3.5 18 6.5v11l-2.5 3"/><path d="M10 8h4"/><path d="M10 12h4"/><path d="M10 16h4"/></svg>`;
    const IMPORT_ICON = ICON_IMPORT.replace('width="18"', 'width="22"').replace('height="18"', 'height="22"').replace('stroke-width="2.4"', 'stroke-width="1.8"');
    const newFriendsRow = `
      <div class="contacts-new-friends" onclick="openFriendRequests()">
        <div class="contacts-new-friends-icon">${NEW_FRIEND_ICON}</div>
        <div class="contacts-new-friends-main">
          <div class="contacts-new-friends-title">新的朋友</div>
          <div class="contacts-new-friends-sub">${pending ? `${pending} 条待处理` : '好友申请'}</div>
        </div>
        ${pending ? `<span class="contacts-new-friends-badge">${pending > 99 ? '99+' : pending}</span>` : '<span class="contacts-row-chevron">›</span>'}
      </div>
      <div class="contacts-new-friends contacts-shake-row" onclick="openShakeMeet()">
        <div class="contacts-new-friends-icon contacts-shake-icon">${SHAKE_ICON}</div>
        <div class="contacts-new-friends-main">
          <div class="contacts-new-friends-title">摇一摇</div>
          <div class="contacts-new-friends-sub">摇一摇，认识新朋友</div>
        </div>
        <span class="contacts-row-chevron">›</span>
      </div>
      <div class="contacts-new-friends" onclick="importCharCardFromContacts()">
        <div class="contacts-new-friends-icon">${IMPORT_ICON}</div>
        <div class="contacts-new-friends-main">
          <div class="contacts-new-friends-title">导入角色卡</div>
          <div class="contacts-new-friends-sub">从 JSON 文件导入角色</div>
        </div>
        <span class="contacts-row-chevron">›</span>
      </div>
    `;

    if (!chars.length) {
      content.innerHTML = `${newFriendsRow}<div class="empty-state">
        <div class="empty-text">还没有好友<br>
          <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="createCharFromContacts()">创建角色</button>
          <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="importCharCardFromContacts()">导入角色卡</button>
          <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="toggleAddFriendMenu()">添加已有角色</button>
        </div>
      </div>`;
      return;
    }

    const friends = chars.filter(c => (c.contact_status || 'friend') !== 'blocked');
    const blocked = chars.filter(c => (c.contact_status || '') === 'blocked');

    const rowHtml = (c) => {
      const peer = c.peer_status || 'ok';
      const isNpc = !!(c.is_circle_npc || c.source === 'circle_npc' || Number(c.circle_npc_id) > 0);
      let tag = '';
      if ((c.contact_status || '') === 'blocked') tag = '<span class="contacts-status-tag is-blocked">已拉黑</span>';
      else if (peer === 'blocked') tag = '<span class="contacts-status-tag is-peer-blocked">对方已拉黑你</span>';
      else if (isNpc) tag = '<span class="contacts-status-tag">圈子</span>';
      return `
      <div class="contacts-char-row" onclick="openCharProfile(${c.id})">
        <div class="contacts-char-avatar-wrap">
          ${c.avatar ? `<img class="avatar" src="${escapeHtml(c.avatar)}" alt="">` : `<div class="avatar" style="font-size:20px">👤</div>`}
          <div class="status-dot status-${Number(c.robot_operating) === 1 ? 'operating' : (c.status || 'online')}"></div>
        </div>
        <div class="contacts-char-main">
          <div class="contacts-char-name">${escapeHtml(charDisplayName(c))}${tag}</div>
        </div>
      </div>`;
    };

    let html = newFriendsRow;
    if (friends.length) {
      html += `<div class="contacts-section-label">好友 · ${friends.length}</div>` + friends.map(rowHtml).join('');
    }
    if (blocked.length) {
      html += `<div class="contacts-section-label">黑名单 · ${blocked.length}</div>` + blocked.map(rowHtml).join('');
    }
    if (!friends.length && !blocked.length) {
      html += `<div class="empty-state"><div class="empty-text">还没有好友</div></div>`;
    }
    content.innerHTML = html;
  } catch(e) {
    if (token !== _contactsLoadToken) return;
    content.innerHTML = contactsLoadErrorHtml(
      /超时|连不上|Failed to fetch/i.test(e.message || '') ? (api.explainBackendUnreachable?.() || '暂时连不上服务器，请检查网络') : '加载失败，请重试'
    );
  }
}

window.toggleAddFriendMenu = async function() {
  const menu = document.getElementById('ct-add-friend-menu');
  if (!menu) return;
  if (menu.style.display !== 'none') {
    menu.style.display = 'none';
    return;
  }
  menu.innerHTML = '<div class="ct-add-friend-loading">加载中…</div>';
  menu.style.display = '';
  try {
    const list = await api.getCharacters({ scope: 'addable', timeoutMs: CONTACTS_FETCH_MS });
    if (!list.length) {
      menu.innerHTML = `<div class="ct-add-friend-empty">没有可添加的角色<br>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="createCharFromContacts()">创建角色</button>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="toggleAddFriendMenu();importCharCardFromContacts()">导入角色卡</button>
      </div>`;
      return;
    }
    menu.innerHTML = `
      <div class="ct-add-friend-title">添加好友</div>
      <div class="ct-add-friend-list">
        ${list.map((c) => `
          <button type="button" class="ct-add-friend-item" onclick="addFriendFromMenu(${c.id})">
            ${c.avatar ? `<img src="${escapeHtml(c.avatar)}" alt="">` : `<span class="ct-add-friend-ph">👤</span>`}
            <span>${escapeHtml(c.name)}</span>
          </button>
        `).join('')}
      </div>
      <button type="button" class="ct-add-friend-cancel" onclick="toggleAddFriendMenu()">取消</button>
    `;
  } catch (e) {
    menu.innerHTML = `<div class="ct-add-friend-empty">加载失败</div>`;
  }
};

window.addFriendFromMenu = async function(charId) {
  try {
    await api.addContactFriend(charId);
    window.showToast?.('已添加好友');
    const menu = document.getElementById('ct-add-friend-menu');
    if (menu) menu.style.display = 'none';
    await switchContactsTab('contacts');
  } catch (e) {
    window.showToast?.(e.message || '添加失败');
  }
};

window.openFriendRequests = async function() {
  const content = document.getElementById('ct-content');
  if (!content) return;
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const data = await api.getContactRequests();
    const list = data.requests || [];
    if (!list.length) {
      content.innerHTML = `
        <div class="friend-req-back" onclick="switchContactsTab('contacts')">‹ 返回</div>
        <div class="empty-state"><div class="empty-text">暂无好友申请</div></div>`;
      return;
    }
    content.innerHTML = `
      <div class="friend-req-back" onclick="switchContactsTab('contacts')">‹ 返回</div>
      <div class="friend-req-list">
        ${list.map((r) => `
          <div class="friend-req-row">
            <div class="friend-req-avatar" onclick="openCharProfile(${r.character_id})">
              ${r.avatar ? `<img src="${escapeHtml(r.avatar)}" alt="">` : '👤'}
            </div>
            <div class="friend-req-main">
              <div class="friend-req-name">${escapeHtml(r.display_name || r.name)}${r.is_circle_npc ? ' <span class="contacts-status-tag">圈子</span>' : ''}</div>
              <div class="friend-req-msg">${escapeHtml(r.message || (r.is_circle_npc ? '来自圈子，想加你为好友' : '请求添加你为好友'))}</div>
            </div>
            <div class="friend-req-actions">
              <button type="button" class="btn btn-primary btn-sm" onclick="respondFriendReq(${r.id}, true)">接受</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="respondFriendReq(${r.id}, false)">拒绝</button>
            </div>
          </div>
        `).join('')}
      </div>`;
  } catch {
    content.innerHTML = contactsLoadErrorHtml('加载失败');
  }
};

window.respondFriendReq = async function(id, accept) {
  try {
    await api.respondFriendRequest(id, accept);
    window.showToast?.(accept ? '已添加好友' : '已拒绝');
    await window.openFriendRequests();
    window.refreshContactsInbox?.();
  } catch (e) {
    window.showToast?.(e.message || '操作失败');
  }
};

let _shakeListening = false;
let _shakeLastAt = 0;
let _shakeBusy = false;
let _shakeMotionHandler = null;
let _shakeArmedAt = 0;
let _shakePeakCount = 0;
let _shakeListenTimer = null;

function stopShakeListening() {
  _shakeListening = false;
  _shakePeakCount = 0;
  if (_shakeListenTimer) {
    clearTimeout(_shakeListenTimer);
    _shakeListenTimer = null;
  }
  if (_shakeMotionHandler) {
    window.removeEventListener('devicemotion', _shakeMotionHandler);
    _shakeMotionHandler = null;
  }
}

async function requestShakePermission() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      return r === 'granted';
    }
  } catch {}
  return true;
}

function startShakeListening() {
  stopShakeListening();
  // 进页后先冷静 1.8s，避免拿起手机/点进来就误触发进聊天
  _shakeArmedAt = Date.now() + 1800;
  _shakePeakCount = 0;
  _shakeListenTimer = setTimeout(() => {
    _shakeListenTimer = null;
    const status = document.getElementById('shake-meet-status');
    if (status && status.textContent.includes('稍等')) {
      status.textContent = '拿起手机摇一摇，认识新朋友';
    }
  }, 1800);
  _shakeListening = true;
  _shakeMotionHandler = (ev) => {
    if (!_shakeListening || _shakeBusy) return;
    if (Date.now() < _shakeArmedAt) return;
    const a = ev.accelerationIncludingGravity || ev.acceleration;
    if (!a) return;
    const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
    // 静止约 9.8；需明显甩动。连续两次峰值才算摇中，减少走路误触
    if (mag < 22) return;
    const now = Date.now();
    if (now - _shakeLastAt < 280) return;
    if (now - _shakeLastAt > 1400) _shakePeakCount = 0;
    _shakeLastAt = now;
    _shakePeakCount += 1;
    if (_shakePeakCount < 2) return;
    _shakePeakCount = 0;
    void runShakeMeet();
  };
  window.addEventListener('devicemotion', _shakeMotionHandler, { passive: true });
}

function upsertAppCharacter(char) {
  if (!char?.id) return;
  const list = window.getAppCharacters?.();
  if (!Array.isArray(list)) return;
  const id = Number(char.id);
  const i = list.findIndex((c) => Number(c.id) === id);
  if (i >= 0) list[i] = { ...list[i], ...char };
  else list.unshift(char);
  // 新角色用独立聊天设置，避免继承上一个角色的聊天壁纸
  try {
    const cur = getChatSettings(id);
    saveChatSettings({
      ...cur,
      bgType: 'gradient',
      bgValue: '',
      bgColor: '',
    }, id);
  } catch {}
}

async function runShakeMeet() {
  if (_shakeBusy) return;
  _shakeBusy = true;
  stopShakeListening();
  const status = document.getElementById('shake-meet-status');
  const actions = document.getElementById('shake-meet-actions');
  if (status) status.textContent = '正在匹配附近的人…';
  if (actions) actions.style.display = 'none';
  try {
    const res = await api.shakeMeet();
    const char = res?.character;
    if (!char?.id) throw new Error('没有摇到人');
    upsertAppCharacter(char);
    window.showToast?.(`摇到了 ${char.display_name || char.name}`);
    window.openChatWith?.(char.id, char);
  } catch (e) {
    window.showToast?.(e.message || '摇一摇失败');
    const content = document.getElementById('ct-content');
    if (content?.querySelector('.shake-meet-page')) {
      if (status) status.textContent = '没摇到，再试一次吧';
      if (actions) actions.style.display = '';
      startShakeListening();
    }
  } finally {
    _shakeBusy = false;
  }
}

window.openShakeMeet = async function() {
  const content = document.getElementById('ct-content');
  if (!content) return;
  stopShakeListening();
  _shakeBusy = false;
  content.innerHTML = `
    <div class="shake-meet-page">
      <div class="friend-req-back" onclick="stopShakeMeetAndBack()">‹ 返回</div>
      <div class="shake-meet-stage">
        <div class="shake-meet-orb" aria-hidden="true"></div>
        <div class="shake-meet-title">摇一摇</div>
        <div class="shake-meet-status" id="shake-meet-status">稍等，传感器准备中…</div>
        <div class="shake-meet-actions" id="shake-meet-actions">
          <button type="button" class="btn btn-primary" onclick="manualShakeMeet()">点我模拟摇一摇</button>
        </div>
        <div class="shake-meet-hint">认识后可以先聊几句，再决定要不要加好友；不加也能继续聊。</div>
      </div>
    </div>`;
  const ok = await requestShakePermission();
  if (!ok) {
    const status = document.getElementById('shake-meet-status');
    if (status) status.textContent = '未获得运动权限，可用下方按钮模拟';
  }
  startShakeListening();
};

window.stopShakeMeetAndBack = function() {
  stopShakeListening();
  window.switchContactsTab?.('contacts');
};

window.manualShakeMeet = function() {
  void runShakeMeet();
};

window.openChatWith = function(charId, seedChar) {
  stopShakeListening();
  const id = Number(charId);
  if (!id) return;
  if (seedChar && Number(seedChar.id) === id) upsertAppCharacter(seedChar);
  window.preloadPage?.('chat');
  void getThreadCache(id, false);
  window.setActiveChar?.(id);
  window._contactsLastTab = _tab;
  window.navigateTo('chat');
};

window.toggleInboxPin = function(charId) {
  togglePinnedChar(charId);
  if (_tab === 'inbox') void renderInbox();
};

const INBOX_SWIPE_OPEN_PX = 76;

function setInboxSwipeTrackX(track, x, animate) {
  if (!track) return;
  track.style.transition = animate ? '' : 'none';
  track.style.transform = x ? `translateX(${x}px)` : '';
}

function closeAllInboxSwipe(exceptRow) {
  document.querySelectorAll('.inbox-swipe.is-open').forEach((row) => {
    if (row === exceptRow) return;
    row.classList.remove('is-open');
    setInboxSwipeTrackX(row.querySelector('.inbox-swipe-track'), 0, true);
  });
}

function openInboxSwipeRow(row) {
  closeAllInboxSwipe(row);
  row.classList.add('is-open');
  setInboxSwipeTrackX(row.querySelector('.inbox-swipe-track'), -INBOX_SWIPE_OPEN_PX, true);
}

function closeInboxSwipeRow(row) {
  row.classList.remove('is-open');
  setInboxSwipeTrackX(row.querySelector('.inbox-swipe-track'), 0, true);
}

function bindInboxSwipe() {
  document.querySelectorAll('.inbox-swipe').forEach((row) => {
    const track = row.querySelector('.inbox-swipe-track');
    if (!track || row.dataset.swipeBound === '1') return;
    row.dataset.swipeBound = '1';
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let tracking = false;
    let axis = null;
    let swiped = false;

    const isOpen = () => row.classList.contains('is-open');
    const onStart = (x, y) => {
      startX = x;
      startY = y;
      dx = isOpen() ? -INBOX_SWIPE_OPEN_PX : 0;
      tracking = true;
      axis = null;
      swiped = false;
      track.style.transition = 'none';
    };
    const onMove = (x, y, ev) => {
      if (!tracking) return;
      const adx = x - startX;
      const ady = y - startY;
      if (!axis) {
        if (Math.abs(adx) < 8 && Math.abs(ady) < 8) return;
        axis = Math.abs(adx) > Math.abs(ady) ? 'x' : 'y';
        if (axis === 'y') {
          tracking = false;
          setInboxSwipeTrackX(track, isOpen() ? -INBOX_SWIPE_OPEN_PX : 0, true);
          return;
        }
        closeAllInboxSwipe(row);
      }
      if (axis !== 'x') return;
      ev.preventDefault();
      swiped = true;
      const base = isOpen() ? -INBOX_SWIPE_OPEN_PX : 0;
      dx = Math.min(0, Math.max(-INBOX_SWIPE_OPEN_PX - 16, base + adx));
      setInboxSwipeTrackX(track, dx, false);
    };
    const onEnd = () => {
      if (!tracking) {
        axis = null;
        return;
      }
      tracking = false;
      if (axis === 'x' && dx < -INBOX_SWIPE_OPEN_PX * 0.4) openInboxSwipeRow(row);
      else closeInboxSwipeRow(row);
      axis = null;
    };

    row.addEventListener('touchstart', (e) => {
      if (e.target.closest('.inbox-swipe-del, .inbox-pin-btn')) return;
      const t = e.changedTouches[0];
      if (t) onStart(t.clientX, t.clientY);
    }, { passive: true });
    row.addEventListener('touchmove', (e) => {
      const t = e.changedTouches[0];
      if (t) onMove(t.clientX, t.clientY, e);
    }, { passive: false });
    row.addEventListener('touchend', onEnd);
    row.addEventListener('touchcancel', onEnd);

    row.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('.inbox-swipe-del, .inbox-pin-btn')) return;
      onStart(e.clientX, e.clientY);
      try { row.setPointerCapture(e.pointerId); } catch {}
    });
    row.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (!(e.buttons & 1) && e.pointerType === 'mouse') return;
      onMove(e.clientX, e.clientY, e);
    });
    row.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      onEnd();
    });
    row.addEventListener('pointercancel', (e) => {
      if (e.pointerType === 'touch') return;
      onEnd();
    });
    row.addEventListener('click', (e) => {
      if (swiped) {
        e.preventDefault();
        e.stopPropagation();
        swiped = false;
        return;
      }
      if (isOpen() && !e.target.closest('.inbox-swipe-del')) {
        e.preventDefault();
        e.stopPropagation();
        closeInboxSwipeRow(row);
      }
    }, true);
  });
}

window.deleteInboxConv = async function(charId) {
  const id = Number(charId);
  if (!id) return;
  const row = document.querySelector(`.inbox-swipe[data-char-id="${id}"]`);
  const status = String(row?.dataset.contactStatus || '');
  const isStranger = status === 'stranger';
  if (isStranger) {
    if (!confirm('未加好友，删除后将移出聊天列表。确定？')) return;
  } else if (!confirm('确定删除与该角色的聊天记录？此操作不可恢复')) {
    return;
  }
  try {
    if (isStranger) {
      await api.deleteContactFriend(id);
    } else {
      await api.clearMessages(id, 0);
    }
    clearThreadCache(id, false);
    window.clearUnread?.(id);
    const pinned = getPinnedCharIds().map(String);
    if (pinned.includes(String(id))) togglePinnedChar(id);
    window.showToast?.(isStranger ? '已删除' : '已清除聊天记录');
    if (_tab === 'inbox') await renderInbox();
    else window.refreshContactsInbox?.();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

function fmtTime(ts) {
  if (!ts) return '';
  const d = parseUTCDate(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  if (now - d < 86400000 * 2) return '昨天';
  if (now - d < 86400000 * 7) return ['日','一','二','三','四','五','六'][d.getDay()];
  return `${d.getMonth()+1}/${d.getDate()}`;
}

/** 收到新消息或回到通讯页时刷新收件箱预览与时间 */
window.refreshContactsInbox = function() {
  window.updateContactsTabBadge?.();
  const page = document.getElementById('contacts-page');
  if (page?.classList.contains('active') && _tab === 'inbox') {
    renderInbox();
  } else {
    window.updateInboxBadges?.();
  }
};

window.updateContactsTabBadge = function() {
  const badge = document.getElementById('ct-inbox-badge');
  if (!badge) return;
  const total = window.getTotalUnreadCount?.() || 0;
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.style.display = 'flex';
  } else {
    badge.textContent = '';
    badge.style.display = 'none';
  }
};

/* ===== 我（内联） ===== */
const APP_VERSION = '1.0.0';
const GENDER_OPTS = ['', '女', '男', '其他'];

let _momentsNameColor = 'black';
let _editingPersonaId = null;

function parsePersonas(settings) {
  try {
    const list = JSON.parse(settings?.user_personas || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function setMeTopbar(title, { back, save } = {}) {
  const titleEl = document.getElementById('ct-title');
  const action = document.getElementById('ct-action');
  if (titleEl) titleEl.textContent = title || '我';
  if (!action) return;
  if (save) {
    action.style.display = '';
    action.className = 'topbar-save';
    action.innerHTML = '';
    action.title = '保存';
    action.onclick = () => (typeof save === 'function' ? save() : window.saveMeProfile?.());
  } else {
    action.style.display = 'none';
    action.onclick = null;
    action.innerHTML = '';
    action.className = '';
  }
  const backBtn = document.querySelector('#contacts-page .topbar-back');
  if (backBtn) {
    backBtn.onclick = (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      if (typeof back === 'function') back();
      else window.goBack?.();
    };
  }
}

async function patchSettings(patch) {
  const cur = await api.getSettings();
  const next = { ...cur, ...patch };
  await api.saveSettings(next);
  await window.refreshAppData?.();
  return next;
}

function meCell(label, value, { onclick, chevron = true } = {}) {
  const click = onclick ? `onclick="${onclick}"` : '';
  return `<div class="settings-row${onclick ? ' settings-row--nav' : ''}" ${click}>
    <div class="settings-row-label">${escapeHtml(label)}</div>
    ${value != null && value !== '' ? `<span class="settings-row-value">${value}</span>` : ''}
    ${chevron && onclick ? '<span class="me-cell-chevron">›</span>' : ''}
  </div>`;
}

function meGroup(html) {
  return `<div class="settings-group">${html}</div>`;
}

async function renderMe() {
  setMeTopbar('我');
  const content = document.getElementById('ct-content');
  if (!content) return;
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let settings = {};
  try { settings = await api.getSettings(); } catch {}
  _momentsNameColor = settings.moments_name_color || 'black';

  const name = String(settings.username || '旅人').trim() || '旅人';
  const region = String(settings.user_location || '').trim() || '未设置地区';
  const personaOn = String(settings.user_persona_enabled || '0') === '1';
  const personas = parsePersonas(settings);
  const personaSub = personaOn
    ? (personas.length ? `已开启 · ${personas.length} 个身份` : '已开启 · 请添加身份')
    : '关闭 · 使用真实身份';

  content.innerHTML = `
    <div class="me-page">
      <div class="settings-section">
        <button type="button" class="me-profile-card" onclick="openMeProfile()">
          <div class="me-profile-avatar">
            ${settings.user_avatar
              ? `<img src="${escapeHtml(settings.user_avatar)}" alt="">`
              : `<span>我</span>`}
          </div>
          <div class="me-profile-meta">
            <div class="me-profile-name">${escapeHtml(name)}</div>
            <div class="me-profile-region">${escapeHtml(region)}</div>
          </div>
          <span class="me-cell-chevron">›</span>
        </button>
      </div>

      <div class="settings-section">
        ${meGroup(meCell('身份', personaSub, { onclick: 'openMeIdentity()' }))}
      </div>

      <div class="settings-section">
        ${meGroup(`
          ${meCell('表情包管理', '', { onclick: "navigateTo('emoji-manager')" })}
          ${meCell('通知', '', { onclick: 'openMeNotifications()' })}
          ${window.isNativeShell?.() ? meCell('权限', '', { onclick: 'openMePermissions()' }) : ''}
        `)}
      </div>

      <div class="settings-section">
        ${meGroup(`
          ${meCell('版本', APP_VERSION, { chevron: false })}
          ${meCell('声明协议', '', { onclick: 'openMeLegal()' })}
        `)}
      </div>
    </div>
  `;
}

window.openMeProfile = async function() {
  setMeTopbar('名片', { back: () => renderMe(), save: () => window.saveMeProfile() });
  const content = document.getElementById('ct-content');
  if (!content) return;
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let settings = {};
  try { settings = await api.getSettings(); } catch {}
  _momentsNameColor = settings.moments_name_color || 'black';
  const gender = String(settings.user_gender || '');
  const home = String(settings.user_home_address || '').trim();

  content.innerHTML = `
    <div class="me-page me-page--detail">
      <div class="me-profile-hero">
        <button type="button" class="me-hero-avatar" onclick="pickMeAvatar()" title="更换头像">
          ${settings.user_avatar
            ? `<img src="${escapeHtml(settings.user_avatar)}" alt="">`
            : `<span>我</span>`}
        </button>
        <div class="me-hero-tip">点击更换头像</div>
      </div>

      <div class="settings-section">
        ${meGroup(`
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">名字</div>
            <input class="input" id="me-username" value="${escapeHtml(settings.username || '旅人')}" maxlength="24" placeholder="名字">
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">地区</div>
            <input class="input" id="me-user-location" value="${escapeHtml(settings.user_location || '')}" placeholder="如：上海">
          </div>
          ${meCell('我的地址', home ? escapeHtml(home) : '获取定位或手动填写', { onclick: 'openMeHomeAddress()' })}
          ${meCell('公司定位', String(settings.user_work_address || '').trim() ? escapeHtml(String(settings.user_work_address).trim()) : '获取定位或手动填写', { onclick: 'openMeWorkAddress()' })}
          <div class="settings-row">
            <div class="settings-row-label">性别</div>
            <select class="input" id="me-user-gender" style="width:auto;min-width:110px">
              <option value="" ${!gender ? 'selected' : ''}>未设置</option>
              <option value="女" ${gender === '女' ? 'selected' : ''}>女</option>
              <option value="男" ${gender === '男' ? 'selected' : ''}>男</option>
              <option value="其他" ${gender === '其他' ? 'selected' : ''}>其他</option>
            </select>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">生日</div>
            <input class="input" id="me-user-birthday" type="date" value="${escapeHtml((settings.user_birthday || '').slice(0, 10))}" style="width:auto">
          </div>
        `)}
      </div>

      <div class="settings-section">
        ${meGroup(`
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">身份描述</div>
            <textarea class="input me-textarea" id="me-user-desc" placeholder="真实身份的简单描述，会注入对话上下文">${escapeHtml(settings.user_desc || '')}</textarea>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">外貌</div>
            <div class="me-selfie-row">
              <div id="me-selfie-preview" class="me-selfie-preview">
                ${settings.user_selfie
                  ? `<img src="${escapeHtml(settings.user_selfie)}" alt="">`
                  : '未上传'}
              </div>
              <div class="me-selfie-actions">
                <button type="button" class="btn btn-ghost btn-sm" onclick="pickMeSelfie()">上传自拍并分析</button>
                ${settings.user_selfie ? `<button type="button" class="btn btn-ghost btn-sm" onclick="reanalyzeMeSelfie()">重新分析</button>` : ''}
                ${settings.user_selfie || settings.user_appearance ? `<button type="button" class="btn btn-ghost btn-sm" style="color:var(--text-secondary)" onclick="clearMeSelfie()">清除</button>` : ''}
              </div>
            </div>
            <textarea class="input me-textarea" id="me-user-appearance" placeholder="外貌描述，可手写或由自拍生成">${escapeHtml(settings.user_appearance || '')}</textarea>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">拍一拍</div>
            <input class="input" id="me-poke-suffix" value="${escapeHtml(settings.poke_user_suffix || '')}" maxlength="12" placeholder="如：肩膀">
          </div>
        `)}
      </div>
    </div>
  `;
  // 通知已移到「我 › 通知」
};

window.openMeNotifications = async function() {
  setMeTopbar('通知', { back: () => renderMe() });
  const content = document.getElementById('ct-content');
  if (!content) return;
  let settings = {};
  try { settings = await api.getSettings(); } catch {}
  const screenChatOn = String(settings.phone_screen_chat ?? '1') !== '0';

  content.innerHTML = `
    <div class="me-page me-page--detail">
      <div class="settings-section">
        ${meGroup(`
          <div class="settings-row settings-row--nav" onclick="enableSystemNotifications()">
            <div class="settings-row-label">系统通知 & Web Push</div>
            <span id="me-notif-status" class="settings-row-value">检测中…</span>
          </div>
          <div class="settings-row settings-row--nav" onclick="testWebPushNotification()">
            <div class="settings-row-label">发送测试推送</div>
            <span id="me-push-test-result" class="settings-row-value"></span>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">屏幕聊天</div>
            <label class="toggle">
              <input type="checkbox" id="me-phone-screen-chat" ${screenChatOn ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        `)}
      </div>
    </div>
  `;
  await window.refreshNotifStatus?.();
  document.getElementById('me-phone-screen-chat')?.addEventListener('change', async (e) => {
    const on = !!e.target.checked;
    try {
      await patchSettings({ phone_screen_chat: on ? '1' : '0' });
      window.showToast?.(on ? '已开启屏幕聊天' : '已关闭屏幕聊天');
    } catch (err) {
      e.target.checked = !on;
      window.showToast?.(err.message || '保存失败');
    }
  });
};

window.openMePermissions = async function() {
  setMeTopbar('权限', { back: () => renderMe() });
  const content = document.getElementById('ct-content');
  if (!content) return;
  if (!window.isNativeShell?.()) {
    content.innerHTML = `<div class="me-page me-page--detail"><div class="empty-state"><div class="empty-text">权限仅在 App 中可用</div></div></div>`;
    return;
  }
  content.innerHTML = `<div class="me-page me-page--detail">${nativePermissionsHtml()}</div>`;
  bindNativePermissionToggles();
  await refreshNativePermissionToggles();
  setTimeout(() => { refreshNativePermissionToggles(); }, 1600);
};

window.saveMeProfile = async function() {
  try {
    await patchSettings({
      username: document.getElementById('me-username')?.value?.trim() || '旅人',
      user_location: document.getElementById('me-user-location')?.value?.trim() || '',
      user_gender: document.getElementById('me-user-gender')?.value || '',
      user_birthday: document.getElementById('me-user-birthday')?.value || '',
      user_desc: document.getElementById('me-user-desc')?.value || '',
      user_appearance: document.getElementById('me-user-appearance')?.value?.trim() || '',
      poke_user_suffix: String(document.getElementById('me-poke-suffix')?.value || '').trim().slice(0, 12),
    });
    window.showToast?.('已保存');
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.openMeHomeAddress = async function() {
  setMeTopbar('我的地址', { back: () => window.openMeProfile() });
  const content = document.getElementById('ct-content');
  if (!content) return;
  let settings = {};
  try { settings = await api.getSettings(); } catch {}
  content.innerHTML = `
    <div class="me-page me-page--detail">
      <div class="settings-section">
        ${meGroup(`
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">家的定位</div>
            <textarea class="input me-textarea" id="me-home-address" placeholder="详细住址，用于「我家」相关对话与定位">${escapeHtml(settings.user_home_address || '')}</textarea>
            <div class="me-addr-actions">
              <button type="button" class="btn btn-primary btn-sm" onclick="locateMeHomeAddress()">获取当前位置</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="saveMeHomeAddress()">保存</button>
            </div>
            <div class="me-hint">可一键定位并填入地址，也可手动改写。地区（城市）仍在名片里单独设置。</div>
          </div>
        `)}
      </div>
    </div>
  `;
};

window.locateMeHomeAddress = async function() {
  const ta = document.getElementById('me-home-address');
  try {
    window.showToast?.('定位中…');
    const { latitude: lat, longitude: lng } = await getDeviceCoordinates();
    const data = await api.reverseGeocode(lat, lng);
    let place = String(data?.placeName || data?.detail || data?.title || '').trim();
    if (place.includes('|')) {
      const [t, d] = place.split('|');
      place = [t, d].filter(Boolean).join(' ');
    }
    if (!place) place = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (ta) ta.value = place;
    await patchSettings({
      user_home_address: place,
      user_home_lat: String(lat),
      user_home_lng: String(lng),
    });
    // 地区为空时顺便填城市
    const city = String(data?.city || '').trim();
    if (city) {
      const cur = await api.getSettings();
      if (!String(cur.user_location || '').trim()) {
        await patchSettings({ user_location: city });
      }
    }
    window.showToast?.('已填入当前位置');
  } catch (e) {
    window.showToast?.(formatLocationError(e) || e.message || '定位失败');
  }
};

window.saveMeHomeAddress = async function() {
  try {
    const addr = document.getElementById('me-home-address')?.value?.trim() || '';
    await patchSettings({ user_home_address: addr });
    window.showToast?.('地址已保存');
    await window.openMeProfile();
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.openMeWorkAddress = async function() {
  setMeTopbar('公司定位', { back: () => window.openMeProfile() });
  const content = document.getElementById('ct-content');
  if (!content) return;
  let settings = {};
  try { settings = await api.getSettings(); } catch {}
  content.innerHTML = `
    <div class="me-page me-page--detail">
      <div class="settings-section">
        ${meGroup(`
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">公司的定位</div>
            <textarea class="input me-textarea" id="me-work-address" placeholder="公司/单位地址，人在这里时角色能对上「在公司」">${escapeHtml(settings.user_work_address || '')}</textarea>
            <div class="me-addr-actions">
              <button type="button" class="btn btn-primary btn-sm" onclick="locateMeWorkAddress()">获取当前位置</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="saveMeWorkAddress()">保存</button>
            </div>
            <div class="me-hint">在公司里点定位并保存，之后查定位对得上就算「在公司」。也可手动改写。</div>
          </div>
        `)}
      </div>
    </div>
  `;
};

window.locateMeWorkAddress = async function() {
  const ta = document.getElementById('me-work-address');
  try {
    window.showToast?.('定位中…');
    const { latitude: lat, longitude: lng } = await getDeviceCoordinates();
    const data = await api.reverseGeocode(lat, lng);
    let place = String(data?.placeName || data?.detail || data?.title || '').trim();
    if (place.includes('|')) {
      const [t, d] = place.split('|');
      place = [t, d].filter(Boolean).join(' ');
    }
    if (!place) place = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (ta) ta.value = place;
    await patchSettings({
      user_work_address: place,
      user_work_lat: String(lat),
      user_work_lng: String(lng),
    });
    window.showToast?.('已填入当前位置');
  } catch (e) {
    window.showToast?.(formatLocationError(e) || e.message || '定位失败');
  }
};

window.saveMeWorkAddress = async function() {
  try {
    const addr = document.getElementById('me-work-address')?.value?.trim() || '';
    await patchSettings({ user_work_address: addr });
    window.showToast?.('公司地址已保存');
    await window.openMeProfile();
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.openMeIdentity = async function() {
  setMeTopbar('身份', { back: () => renderMe() });
  const content = document.getElementById('ct-content');
  if (!content) return;
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let settings = {};
  try { settings = await api.getSettings(); } catch {}
  const on = String(settings.user_persona_enabled || '0') === '1';
  const personas = parsePersonas(settings);
  let chars = [];
  try { chars = await api.getCharacters({ scope: 'friends', timeoutMs: 12000 }); } catch {}
  const nameOf = (id) => {
    const c = chars.find((x) => Number(x.id) === Number(id));
    return c ? (c.display_name || c.remark || c.name || `#${id}`) : `#${id}`;
  };

  content.innerHTML = `
    <div class="me-page me-page--detail">
      <div class="settings-section">
        ${meGroup(`
          <div class="settings-row">
            <div>
              <div class="settings-row-label">使用虚拟身份</div>
              <div class="settings-row-sub">关闭时，和所有角色都用名片里的真实身份</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="me-persona-enabled" ${on ? 'checked' : ''} onchange="toggleMePersonaEnabled(this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>
        `)}
      </div>

      <div id="me-persona-panel" style="${on ? '' : 'display:none'}">
        <div class="settings-section" style="padding:0 16px 8px">
          <button type="button" class="btn btn-primary" style="width:100%" onclick="editMePersona(null)">添加身份</button>
        </div>
        <div class="settings-section">
          ${personas.length ? meGroup(personas.map((p) => {
            const bound = (p.characterIds || []).map(nameOf).filter(Boolean);
            const sub = [p.gender, bound.length ? `绑定 ${bound.slice(0, 3).join('、')}${bound.length > 3 ? '…' : ''}` : '未绑定角色']
              .filter(Boolean).join(' · ');
            return `<div class="settings-row settings-row--nav" onclick="editMePersona('${escapeHtml(p.id)}')">
              <div style="min-width:0;flex:1">
                <div class="settings-row-label">${escapeHtml(p.name || '未命名')}</div>
                <div class="settings-row-sub">${escapeHtml(sub)}</div>
              </div>
              <span class="me-cell-chevron">›</span>
            </div>`;
          }).join('')) : `<div class="me-empty">开启后请添加身份，并选择绑定哪些角色</div>`}
        </div>
      </div>
    </div>
  `;
};

window.toggleMePersonaEnabled = async function(checked) {
  try {
    await patchSettings({ user_persona_enabled: checked ? '1' : '0' });
    const panel = document.getElementById('me-persona-panel');
    if (panel) panel.style.display = checked ? '' : 'none';
    if (checked && !parsePersonas(await api.getSettings()).length) {
      window.showToast?.('已开启，请添加一个身份');
    }
  } catch (e) {
    window.showToast?.(e.message || '设置失败');
    await window.openMeIdentity();
  }
};

window.editMePersona = async function(personaId) {
  _editingPersonaId = personaId || null;
  setMeTopbar(personaId ? '编辑身份' : '添加身份', {
    back: () => window.openMeIdentity(),
    save: () => window.saveMePersona(),
  });
  const content = document.getElementById('ct-content');
  if (!content) return;
  let settings = {};
  try { settings = await api.getSettings(); } catch {}
  const personas = parsePersonas(settings);
  const p = personaId ? personas.find((x) => String(x.id) === String(personaId)) : null;
  let chars = [];
  try { chars = await api.getCharacters({ scope: 'friends', timeoutMs: 12000 }); } catch {}
  const bound = new Set((p?.characterIds || []).map(Number));

  content.innerHTML = `
    <div class="me-page me-page--detail">
      <div class="settings-section">
        ${meGroup(`
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">名字</div>
            <input class="input" id="me-persona-name" value="${escapeHtml(p?.name || '')}" maxlength="24" placeholder="这个身份叫什么">
          </div>
          <div class="settings-row">
            <div class="settings-row-label">性别</div>
            <select class="input" id="me-persona-gender" style="width:auto;min-width:110px">
              ${GENDER_OPTS.map((g) => `<option value="${escapeHtml(g)}" ${(p?.gender || '') === g ? 'selected' : ''}>${g || '未设置'}</option>`).join('')}
            </select>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">生日</div>
            <input class="input" id="me-persona-birthday" type="date" value="${escapeHtml(String(p?.birthday || '').slice(0, 10))}" style="width:auto">
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">身份描述</div>
            <textarea class="input me-textarea" id="me-persona-desc" placeholder="性格、职业、背景等">${escapeHtml(p?.desc || '')}</textarea>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">外貌</div>
            <textarea class="input me-textarea" id="me-persona-appearance" placeholder="外貌描述，聊到长相时会用到">${escapeHtml(p?.appearance || '')}</textarea>
          </div>
        `)}
      </div>

      <div class="settings-section">
        <div class="settings-section-title">绑定角色</div>
        <div class="me-hint" style="padding:0 16px 8px">选中后，和该角色聊天会用这套身份，而不是真实名片</div>
        ${chars.length ? meGroup(chars.map((c) => {
          const id = Number(c.id);
          const label = escapeHtml(c.display_name || c.remark || c.name || `#${id}`);
          const checked = bound.has(id) ? 'checked' : '';
          return `<label class="settings-row me-bind-row">
            <span class="me-bind-main">
              ${c.avatar ? `<img class="me-bind-avatar" src="${escapeHtml(c.avatar)}" alt="">` : `<span class="me-bind-avatar me-bind-avatar--ph">👤</span>`}
              <span class="settings-row-label">${label}</span>
            </span>
            <input type="checkbox" class="me-persona-bind" value="${id}" ${checked}>
          </label>`;
        }).join('')) : `<div class="me-empty">还没有好友可绑定</div>`}
      </div>

      ${personaId ? `<div class="me-danger-wrap">
        <button type="button" class="btn btn-ghost" style="color:#c45c6a;width:100%" onclick="deleteMePersona('${escapeHtml(personaId)}')">删除此身份</button>
      </div>` : ''}
    </div>
  `;
};

window.saveMePersona = async function() {
  try {
    const name = document.getElementById('me-persona-name')?.value?.trim() || '';
    if (!name) {
      window.showToast?.('请填写名字');
      return;
    }
    const gender = document.getElementById('me-persona-gender')?.value || '';
    const birthday = document.getElementById('me-persona-birthday')?.value || '';
    const desc = document.getElementById('me-persona-desc')?.value?.trim() || '';
    const appearance = document.getElementById('me-persona-appearance')?.value?.trim() || '';
    const characterIds = [...document.querySelectorAll('.me-persona-bind:checked')]
      .map((el) => Number(el.value))
      .filter((n) => Number.isFinite(n) && n > 0);

    const cur = await api.getSettings();
    let list = parsePersonas(cur);
    const id = _editingPersonaId || `p_${Date.now().toString(36)}`;
    // 同一角色只保留在一个身份里
    list = list.map((item) => ({
      ...item,
      characterIds: (item.characterIds || []).filter((cid) =>
        String(item.id) === String(id) ? true : !characterIds.includes(Number(cid))
      ),
    }));
    const next = { id, name, gender, birthday, desc, appearance, characterIds };
    const idx = list.findIndex((x) => String(x.id) === String(id));
    if (idx >= 0) list[idx] = next;
    else list.push(next);

    await patchSettings({
      user_personas: JSON.stringify(list),
      user_persona_enabled: '1',
    });
    window.showToast?.('身份已保存');
    await window.openMeIdentity();
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.deleteMePersona = async function(personaId) {
  if (!confirm('确定删除这个身份？')) return;
  try {
    const cur = await api.getSettings();
    const list = parsePersonas(cur).filter((x) => String(x.id) !== String(personaId));
    await patchSettings({ user_personas: JSON.stringify(list) });
    window.showToast?.('已删除');
    await window.openMeIdentity();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

window.openMeLegal = function() {
  setMeTopbar('声明协议', { back: () => renderMe() });
  const content = document.getElementById('ct-content');
  if (!content) return;
  content.innerHTML = `
    <div class="me-page me-page--detail">
      <article class="me-legal">
        <h1>念 · 使用声明与免责协议</h1>
        <p class="me-legal-meta">适用于「念」（NIAN）项目及基于本项目自托管部署、使用的全部情形。</p>

        <h2>1. 开源与授权</h2>
        <p>本项目以源码形式发布。允许个人非商业自托管部署，亦允许为个人使用而修改代码。</p>
        <p><strong>禁止</strong>：将修改后再分发（禁止二改公开分发）；禁止商业使用。</p>
        <p>完整条款以仓库内 LICENSE 文件为准。若尚未附带许可证，并不构成对你生成内容的任何担保或背书。</p>

        <h2>2. 生成内容与责任</h2>
        <p>「念」会通过大模型、语音合成、图像等能力生成文本、语音、图片及其他内容。这些内容由你（或你所部署环境的使用者）触发与配置，其结果<strong>完全由使用者自行负责</strong>。</p>
        <p>项目作者、贡献者与维护者<strong>不对</strong>任何人使用本软件所生成、存储、传播的任何内容承担责任，包括但不限于：虚构角色对话、设定、语音、图像、日记、朋友圈、通话内容，以及由此衍生的任何言论、关系叙事或媒体材料。</p>

        <h2>3. 禁止与合规</h2>
        <p>你不得将本软件用于违反所在地法律法规的用途，不得生成或传播违法、侵权、骚扰、欺诈或侵害他人合法权益的内容。若你将本软件提供给他人使用，你应自行确保对方知悉并遵守本声明。</p>

        <h2>4. 无担保</h2>
        <p>本软件按「现状」提供，不附带任何明示或默示担保，包括但不限于适销性、特定用途适用性与不侵权。作者不保证输出准确、连贯、无偏见或适合任何具体场景。</p>

        <h2>5. 第三方服务</h2>
        <p>若你自行配置的 API、云服务、模型提供方产生费用、限流、内容审核或数据收集，相关权利义务存在于你与该第三方之间，与本项目作者无关。</p>

        <h2>6. 本地数据</h2>
        <p>聊天记录、角色设定、媒体文件等通常保存在你自行部署的环境中。请自行做好备份与访问控制；因设备丢失、误操作、未授权访问造成的数据问题，由使用者自行承担。</p>

        <h2>7. 接受条款</h2>
        <p>继续使用「念」即表示你已阅读并同意本声明：生成的一切内容与后果由你负责；与项目作者无关。</p>

        <p class="me-legal-foot">版本 ${APP_VERSION} · 若协议后续更新，以应用内最新文本为准。</p>
      </article>
    </div>
  `;
};

async function syncUserAvatarToChat(url) {
  const cs = getChatSettings();
  cs.userAvatarUrl = url || '';
  saveChatSettings(cs);
}

window.setMomentsNameColor = async function(val, el) {
  _momentsNameColor = val;
  document.querySelectorAll('#me-moments-name-color .tag, #moments-cover-name-color .tag').forEach((t) => {
    t.classList.toggle('active', t.dataset.val === val);
  });
  const nameEl = document.getElementById('moments-cover-username');
  if (nameEl) {
    nameEl.classList.remove('color-black', 'color-white');
    nameEl.classList.add(val === 'white' ? 'color-white' : 'color-black');
  }
  try {
    await patchSettings({ moments_name_color: val });
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.pickMeAvatar = async function() {
  try {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const result = await pickCropAndUpload(file, { title: '裁剪头像', aspect: 1 });
      if (!result?.url) return;
      await patchSettings({ user_avatar: result.url });
      await syncUserAvatarToChat(result.url);
      window.showToast?.('头像已更新');
      await window.openMeProfile();
    };
    input.click();
  } catch {
    window.showToast?.('上传失败');
  }
};

window.clearMeAvatar = async function() {
  try {
    await patchSettings({ user_avatar: '' });
    await syncUserAvatarToChat('');
    window.showToast?.('头像已清除');
    await window.openMeProfile();
  } catch {
    window.showToast?.('操作失败');
  }
};

window.pickMeSelfie = async function() {
  try {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      window.showToast?.('上传中…');
      let url = '';
      try {
        const cropped = await pickCropAndUpload(file, { title: '裁剪自拍（可跳过严格构图）', aspect: null });
        url = cropped?.url || '';
      } catch {
        /* ignore */
      }
      if (!url) {
        window.showToast?.('上传失败');
        return;
      }
      const cur = await api.getSettings();
      let appearance = '';
      try {
        const r = await api.analyzeUserSelfie(url, { save: true });
        appearance = r?.appearance || '';
      } catch (e) {
        await patchSettings({ user_selfie: url });
        window.showToast?.(e.message || '已上传，但识图失败，可手写下外貌');
        await window.openMeProfile();
        return;
      }
      await patchSettings({
        user_selfie: url,
        user_appearance: appearance || cur.user_appearance || '',
      });
      window.showToast?.(appearance ? '自拍已更新，外貌已写入' : '自拍已更新');
      await window.openMeProfile();
    };
    input.click();
  } catch (e) {
    window.showToast?.(e.message || '上传失败');
  }
};

window.reanalyzeMeSelfie = async function() {
  try {
    const cur = await api.getSettings();
    const url = String(cur.user_selfie || '').trim();
    if (!url) {
      window.showToast?.('请先上传自拍');
      return;
    }
    window.showToast?.('正在重新分析…');
    const r = await api.analyzeUserSelfie(url, { save: true });
    const appearance = r?.appearance || '';
    await patchSettings({ user_appearance: appearance || cur.user_appearance || '' });
    window.showToast?.(appearance ? '外貌描述已更新' : '分析失败');
    await window.openMeProfile();
  } catch (e) {
    window.showToast?.(e.message || '分析失败');
  }
};

window.clearMeSelfie = async function() {
  try {
    await patchSettings({ user_selfie: '', user_appearance: '' });
    window.showToast?.('已清除自拍与外貌');
    await window.openMeProfile();
  } catch (e) {
    window.showToast?.(e.message || '操作失败');
  }
};

window.pickMomentsCover = async function() {
  try {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name || '');
      const result = await pickCropAndUpload(file, {
        title: isVideo ? '设置封面视频' : '设置朋友圈封面',
        aspect: momentsCoverAspect(),
        retainSource: isVideo,
      });
      if (!result?.url) return;
      await patchSettings({
        moments_cover: result.url,
        moments_cover_crop: result.crop ? JSON.stringify(result.crop) : '',
      });
      window.showToast?.('封面已更新');
      await reloadMomentsCoverUi();
    };
    input.click();
  } catch {
    window.showToast?.('上传失败');
  }
};

window.clearMomentsCover = async function() {
  try {
    await patchSettings({ moments_cover: '', moments_cover_crop: '' });
    window.showToast?.('已恢复默认封面');
    await reloadMomentsCoverUi();
  } catch {
    window.showToast?.('操作失败');
  }
};

async function reloadMomentsCoverUi() {
  if (document.getElementById('moments-cover-wrap') && window.reloadMomentsShell) {
    await window.reloadMomentsShell();
  }
}

// 兼容旧入口
window.saveMeSettings = window.saveMeProfile;

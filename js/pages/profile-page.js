/* ===== 角色名片（微信式） ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { ICON_MORE } from '../ui-icons.js';

function displayNameOf(char) {
  return String(char?.display_name || char?.remark || char?.name || '角色').trim();
}

window.openFriendSettings = function(charId) {
  window._friendSettingsCharId = Number(charId);
  window.navigateTo('friend-settings');
};

window.initProfilePage = async function() {
  const page = document.getElementById('profile-page');
  if (!page) return;
  const charId = Number(window._profileCharId || 0);
  if (!charId) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">未选择角色</div></div>`;
    return;
  }
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let char;
  try {
    char = await api.getCharacter(charId);
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">加载失败</div></div>`;
    return;
  }
  const name = displayNameOf(char);
  const realName = char.name || '';
  // 名片「地区」= 后端算好的此刻所在地；外出抠不出城市时可能为空，不要擅自退回常住城
  const region = String(char.present_location || '').trim() || '未设置';
  const status = char.contact_status || 'friend';
  const peer = char.peer_status || 'ok';
  let statusHint = '';
  if (status === 'blocked') statusHint = '已拉黑（你拉黑了对方）';
  else if (status === 'deleted') statusHint = '已删除';
  else if (status === 'stranger') statusHint = '摇一摇认识 · 还不是好友';
  else if (peer === 'blocked') statusHint = '对方已拉黑你';
  else if (peer === 'deleted') statusHint = '对方已删除你';

  const canChat = status === 'friend' || status === 'blocked' || status === 'stranger'
    || status === 'none' || status === 'deleted';
  const isFriend = status === 'friend';
  const isNpc = !!(char.is_circle_npc || char.source === 'circle_npc' || Number(char.circle_npc_id) > 0);
  const canRequestFriend = !isFriend && status !== 'blocked' && peer !== 'blocked';
  const peerBlockedHint = peer === 'blocked'
    ? `<div class="profile-peer-hint">对方把你拉黑了。你仍可发消息（会显示发送失败），继续沟通求和解；对方心软时会自行解除拉黑。你无法替对方取消。</div>`
    : '';
  const npcHint = isNpc
    ? `<div class="profile-peer-hint">圈子好友：可聊天、看朋友圈与互相评论；不含日记、时空、游戏等完整角色功能。</div>`
    : '';

  page.innerHTML = `
    <div class="profile-page-shell">
      <div class="topbar profile-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
        <div class="topbar-title"></div>
        <div class="topbar-actions">
          <button type="button" class="topbar-action" onclick="openFriendSettings(${char.id})" title="资料设置">${ICON_MORE}</button>
        </div>
      </div>
      <div class="scroll-area scroll-area-native profile-body">
        <div class="profile-hero">
          <div class="profile-avatar-wrap">
            ${char.avatar
              ? `<img class="profile-avatar" src="${escapeHtml(char.avatar)}" alt="">`
              : `<div class="profile-avatar profile-avatar-ph">👤</div>`}
          </div>
          <div class="profile-names">
            <div class="profile-nickname">${escapeHtml(name)}${isNpc ? ' <span class="profile-status-tag">圈子</span>' : ''}</div>
            <div class="profile-realname">名字：${escapeHtml(realName)}</div>
            ${statusHint ? `<div class="profile-status-tag">${escapeHtml(statusHint)}</div>` : ''}
          </div>
        </div>
        ${npcHint}
        ${peerBlockedHint}
        <div class="profile-rows">
          ${isNpc ? '' : `
          <div class="profile-row">
            <span class="profile-row-label">地区</span>
            <span class="profile-row-value">${escapeHtml(region)}</span>
          </div>`}
          <button type="button" class="profile-row profile-row-btn" onclick="openCharMoments(${char.id})">
            <span class="profile-row-label">朋友圈</span>
            <span class="profile-row-chevron">›</span>
          </button>
        </div>
        <div class="profile-actions">
          ${canChat ? `
            <button type="button" class="profile-action-btn" onclick="openChatWith(${char.id})">发消息</button>
            ${isFriend && !isNpc ? `
              <button type="button" class="profile-action-btn profile-action-btn--ghost" onclick="startCallFromProfile(${char.id})">语音电话</button>
              <button type="button" class="profile-action-btn profile-action-btn--ghost" onclick="startVideoCallFromProfile(${char.id})">视频电话</button>
            ` : ''}
            ${canRequestFriend ? `
              <button type="button" class="profile-action-btn profile-action-btn--ghost" onclick="addFriendFromProfile(${char.id})">添加好友</button>
            ` : ''}
          ` : `
            <button type="button" class="profile-action-btn" onclick="addFriendFromProfile(${char.id})">加为好友</button>
          `}
        </div>
      </div>
    </div>
  `;
};

window.openCharProfile = function(charId) {
  window._profileCharId = Number(charId);
  window.navigateTo('profile');
};

window.openCharMoments = async function(charId) {
  const id = Number(charId);
  try {
    const char = await api.getCharacter(id).catch(() => null);
    const npcId = Number(char?.circle_npc_id) || 0;
    if (char && (char.is_circle_npc || char.source === 'circle_npc' || npcId > 0) && npcId > 0) {
      window._circleOpenNpcMomentsId = npcId;
      window.navigateTo('circle');
      return;
    }
  } catch {}
  window._momentsCharId = id;
  window.navigateTo('moments');
};

window.startCallFromProfile = function(charId) {
  window.openChatWith?.(charId);
  setTimeout(() => window.startCall?.(), 400);
};

window.startVideoCallFromProfile = function(charId) {
  window.openChatWith?.(charId);
  setTimeout(() => window.startVideoCall?.(), 400);
};

window.addFriendFromProfile = async function(charId) {
  try {
    const char = await api.getCharacter(charId).catch(() => null);
    const status = char?.contact_status || '';
    // 摇一摇陌生人 / 非好友：走申请，等对方决定；已有角色补加仍可直接加
    if (status === 'stranger' || status === 'none' || status === 'deleted' || char?.source === 'shake') {
      const res = await api.createFriendRequest(charId, '我想加你为好友');
      window.showToast?.(res?.already ? '已发过申请，等对方回应' : '已发送好友申请，等对方决定');
    } else {
      await api.addContactFriend(charId);
      window.showToast?.('已添加好友');
    }
    window.initProfilePage?.();
    window.refreshContactsInbox?.();
  } catch (e) {
    window.showToast?.(e.message || '添加失败');
  }
};

/* ===== 朋友资料设置（微信式） ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';

function displayNameOf(char) {
  return String(char?.display_name || char?.remark || char?.name || '角色').trim();
}

window.initFriendSettingsPage = async function() {
  const page = document.getElementById('friend-settings-page');
  if (!page) return;
  const charId = Number(window._friendSettingsCharId || 0);
  if (!charId) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">未选择好友</div></div>`;
    return;
  }

  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let char;
  try {
    char = await api.getCharacter(charId);
  } catch {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">加载失败</div></div>`;
    return;
  }

  const status = char.contact_status || 'friend';
  const isBlocked = status === 'blocked';
  const remark = char.remark || '';

  page.innerHTML = `
    <div class="friend-settings-shell">
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
        <div class="topbar-title">朋友资料</div>
        <div class="topbar-actions"></div>
      </div>
      <div class="scroll-area scroll-area-native friend-settings-body">
        <div class="settings-section" style="margin-top:12px">
          <div class="settings-group">
            <button type="button" class="friend-settings-row" onclick="openCharEditorFromFriendSettings(${char.id})">
              <span class="friend-settings-row-label">设置朋友资料</span>
              <span class="friend-settings-row-chevron">›</span>
            </button>
            <button type="button" class="friend-settings-row" onclick="editFriendRemark(${char.id})">
              <span class="friend-settings-row-label">备注</span>
              <span class="friend-settings-row-value">${remark ? escapeHtml(remark) : '未设置'}</span>
              <span class="friend-settings-row-chevron">›</span>
            </button>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-group">
            <div class="settings-row">
              <div class="settings-row-label">
                <div>加入黑名单</div>
                <div class="settings-row-sub">拉黑后对方消息会显示发送失败</div>
              </div>
              <label class="toggle">
                <input type="checkbox" id="fs-block-toggle" ${isBlocked ? 'checked' : ''}
                  onchange="toggleFriendBlacklist(${char.id}, this.checked)">
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>

        ${status !== 'deleted' ? `
        <div class="settings-section">
          <div class="settings-group">
            <button type="button" class="friend-settings-row friend-settings-row--danger" onclick="deleteFriendFromSettings(${char.id})">
              <span>删除好友</span>
            </button>
          </div>
        </div>` : ''}
      </div>
    </div>
  `;
};

window.openCharEditorFromFriendSettings = function(charId) {
  window._charEditorBackMode = 'goback';
  window._skipCharListOnce = true;
  window._pendingCharEditorId = Number(charId);
  window.navigateTo('character');
};

window.editFriendRemark = async function(charId) {
  const chars = window.getAppCharacters?.() || [];
  const c = chars.find((x) => String(x.id) === String(charId));
  const current = c?.remark || '';
  const next = prompt('备注名（聊天顶栏优先显示）', current);
  if (next === null) return;
  try {
    await api.setContactRemark(charId, next.trim());
    await window.refreshAppData?.();
    window.showToast?.('已保存备注');
    window.initFriendSettingsPage?.();
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.toggleFriendBlacklist = async function(charId, blocked) {
  const toggle = document.getElementById('fs-block-toggle');
  try {
    if (blocked) {
      if (!confirm('拉黑后对方将认为消息发不出。确定拉黑？')) {
        if (toggle) toggle.checked = false;
        return;
      }
      await api.blockContact(charId);
      window.showToast?.('已加入黑名单');
    } else {
      await api.unblockContact(charId);
      window.showToast?.('已移出黑名单');
    }
    await window.refreshAppData?.();
    window.refreshContactsInbox?.();
  } catch (e) {
    window.showToast?.(e.message || '操作失败');
    if (toggle) toggle.checked = !blocked;
  }
};

function showDeleteFriendSheet(charId) {
  return new Promise((resolve) => {
    let overlay = document.getElementById('delete-friend-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'delete-friend-overlay';
      overlay.className = 'overlay center';
      document.body.appendChild(overlay);
    }
    const finish = (value) => {
      overlay.classList.remove('active');
      resolve(value);
    };
    overlay.onclick = (e) => { if (e.target === overlay) finish(null); };
    overlay.innerHTML = `
      <div class="modal" style="width:calc(100% - 32px);max-width:360px" onclick="event.stopPropagation()">
        <div class="modal-title">删除好友</div>
        <div class="modal-body" style="font-size:14px;line-height:1.65;color:var(--text-secondary)">
          删除后对方可再申请加你。<br>
          是否同时删除与对方的聊天、日记、记忆、时空等痕迹？
        </div>
        <div class="modal-footer" style="flex-direction:column;align-items:stretch;gap:8px">
          <button type="button" class="btn btn-primary btn-sm" data-act="wipe">删除好友并清除痕迹</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="keep">仅删除好友</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="cancel">取消</button>
        </div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-act="wipe"]').onclick = () => finish({ wipeTraces: true });
    overlay.querySelector('[data-act="keep"]').onclick = () => finish({ wipeTraces: false });
    overlay.querySelector('[data-act="cancel"]').onclick = () => finish(null);
  });
}

window.deleteFriendFromSettings = async function(charId) {
  const choice = await showDeleteFriendSheet(charId);
  if (!choice) return;
  try {
    await api.deleteContactFriend(charId, { wipeTraces: !!choice.wipeTraces });
    if (choice.wipeTraces) {
      try { window.clearUnread?.(charId); } catch {}
    }
    window.showToast?.(choice.wipeTraces ? '已删除好友并清除痕迹' : '已删除好友');
    await window.refreshAppData?.();
    window.goBack?.();
    window.goBack?.();
    window.refreshContactsInbox?.();
  } catch (e) {
    window.showToast?.(e.message || '操作失败');
  }
};

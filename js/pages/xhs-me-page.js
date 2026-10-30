/* ===== 我的小红书号：让角色认出评论和主页里的人 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';

window.initXhsMePage = async function () {
  const page = document.getElementById('xhs-me-page');
  if (!page) return;
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let me = { nickname: '', redId: '', userId: '' };
  try {
    me = await api.getXhsMe();
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
    return;
  }
  renderXhsMe(page, me, '');
};

function renderXhsMe(page, me, note) {
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">我的小红书</div>
      <button type="button" class="topbar-save" id="xhs-me-save">保存</button>
    </div>
    <div class="scroll-area scroll-area-native" style="padding-bottom:32px">
      <div class="settings-section" style="margin-top:12px">
        <div class="settings-group">
          <div class="settings-row settings-row--stack">
            <div class="settings-row-sub">填你自己的号。他在评论和主页里对上这些，才知道那是你，不是路人。至少填一项。</div>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">昵称</div>
            <input class="input" id="xhs-me-nick" type="text" maxlength="40" value="${escapeHtml(me.nickname || '')}" placeholder="小红书上显示的名字">
            <div class="settings-row-sub">评论里要叫你时，他会写成 @这个昵称。</div>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">小红书号</div>
            <input class="input" id="xhs-me-red" type="text" maxlength="32" value="${escapeHtml(me.redId || '')}" placeholder="主页上那串小号">
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">用户 ID</div>
            <input class="input" id="xhs-me-uid" type="text" maxlength="120" value="${escapeHtml(me.userId || '')}" placeholder="主页链接，或 profile/ 后面那段">
            <div class="settings-row-sub">有这项，他回复你的评论时才能对着你的号回。你会收到回复提醒。</div>
          </div>
          <div style="padding:4px 16px 12px">
            <div class="settings-row-sub" id="xhs-me-note">${escapeHtml(note || '')}</div>
            <button type="button" class="btn btn-ghost btn-sm" id="xhs-me-clear" style="margin-top:8px">清空</button>
          </div>
        </div>
      </div>
    </div>
  `;
  page.querySelector('#xhs-me-save')?.addEventListener('click', () => { void saveXhsMe(false); });
  page.querySelector('#xhs-me-clear')?.addEventListener('click', () => { void saveXhsMe(true); });
}

function setXhsMeNote(text) {
  const el = document.getElementById('xhs-me-note');
  if (el) el.textContent = text;
}

async function saveXhsMe(clear) {
  const body = clear ? { clear: true } : {
    nickname: document.getElementById('xhs-me-nick')?.value || '',
    redId: document.getElementById('xhs-me-red')?.value || '',
    userId: document.getElementById('xhs-me-uid')?.value || '',
  };
  try {
    const saved = await api.saveXhsMe(body);
    if (clear) {
      const nick = document.getElementById('xhs-me-nick');
      const red = document.getElementById('xhs-me-red');
      const uid = document.getElementById('xhs-me-uid');
      if (nick) nick.value = '';
      if (red) red.value = '';
      if (uid) uid.value = '';
      setXhsMeNote('已清空。他认不出你的小红书号了。');
      window.showToast?.('已清空');
      return;
    }
    const uid = document.getElementById('xhs-me-uid');
    if (uid && saved?.userId) uid.value = saved.userId;
    setXhsMeNote('已记住。评论和主页里对上这些，他会当成是你。');
    window.showToast?.('已保存');
  } catch (e) {
    setXhsMeNote(e.message || '保存失败');
    window.showToast?.(e.message || '保存失败');
  }
}

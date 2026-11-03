/* ===== 他看过的小红书帖子 ===== */
import { escapeHtml } from '../memory.js';
import { isNativeShell } from '../server-config.js';
import { readXhsBrowse, syncXhsBrowse } from '../xhs-browse-store.js';

const KIND = {
  open: '点开',
  see: '刷到',
  search: '搜索',
  profile: '看主页',
};

window.initXhsBrowsePage = async function () {
  const page = document.getElementById('xhs-browse-page');
  if (!page) return;
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let note = '';
  let items = [];
  try {
    items = await syncXhsBrowse();
  } catch (e) {
    note = e.message || '没同步上';
    items = await readXhsBrowse();
  }
  renderXhsBrowse(page, Array.isArray(items) ? items : [], note);
};

function when(ts) {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n);
  const now = new Date();
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (same) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function renderXhsBrowse(page, items, note) {
  const where = isNativeShell()
    ? '记在这台手机上。云端只暂存还没拉下来的，拉走就删。'
    : '名单要记在手机里的念上。这台浏览器先不把云端那份删掉，等手机来取。';
  const body = items.length
    ? items.map((item) => {
      const who = item.characterName ? `${item.characterName} · ` : '';
      const author = item.author ? `<div class="settings-row-sub">${escapeHtml(item.author)}</div>` : '';
      const snippet = item.snippet ? `<div class="settings-row-sub">${escapeHtml(item.snippet)}</div>` : '';
      return `<div class="settings-row settings-row--stack" style="border-top:1px solid var(--border,rgba(0,0,0,.06));padding-top:12px">
        <div class="settings-row-sub">${escapeHtml(who + (KIND[item.kind] || '看到') + ' · ' + when(item.createdAt))}</div>
        <div class="settings-row-label">${escapeHtml(item.title || '一篇笔记')}</div>
        ${author}${snippet}
      </div>`;
    }).join('')
    : `<div class="settings-row settings-row--stack">
         <div class="settings-row-sub">还没有记到这台设备上。他之后点开、刷到、搜到的帖子，会在手机打开念时拉下来。</div>
       </div>`;
  const warn = note ? `<div class="settings-row-sub" style="padding:8px 16px">${escapeHtml(note)}</div>` : '';
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">他看过的帖子</div>
      <button type="button" class="topbar-save" id="xhs-browse-refresh">刷新</button>
    </div>
    <div class="scroll-area scroll-area-native" style="padding-bottom:32px">
      <div class="settings-section" style="margin-top:12px">
        <div class="settings-group">
          <div class="settings-row settings-row--stack">
            <div class="settings-row-sub">${escapeHtml(where)}</div>
          </div>
          ${warn}
          ${body}
        </div>
      </div>
    </div>
  `;
  page.querySelector('#xhs-browse-refresh')?.addEventListener('click', () => { void window.initXhsBrowsePage(); });
}

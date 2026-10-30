/* ===== 云端画面：看虚拟屏幕，指出要点的位置 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';

let _point = null;
let _busy = false;

window.initXhsScreenPage = async function () {
  _point = null;
  _busy = false;
  const page = document.getElementById('xhs-screen-page');
  if (!page) return;
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let cfg = { url: '', hasToken: false };
  try {
    cfg = await api.getXhsScreen();
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
    return;
  }
  renderXhsScreen(page, cfg, '');
  if (cfg.url) void refreshXhsShot();
};

function renderXhsScreen(page, cfg, note) {
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">云端画面</div>
      <button type="button" class="topbar-save" id="xhs-refresh">刷新</button>
    </div>
    <div class="scroll-area scroll-area-native" style="padding-bottom:32px">
      <div class="settings-section" style="margin-top:12px">
        <div class="settings-group">
          <div class="settings-row settings-row--stack">
            <div class="settings-row-sub">这是云服务器上的那块屏幕。看到要他点的地方，在画面上点一下，再按「让他点这里」。</div>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">画面地址</div>
            <input class="input" id="xhs-url" type="url" value="${escapeHtml(cfg.url || '')}" placeholder="http://127.0.0.1:8767">
            <div class="settings-row-sub">填画面桥的地址，不是小红书 MCP 的地址。念的后端和画面桥在同一台机器时，用 127.0.0.1。</div>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">口令</div>
            <input class="input" id="xhs-token" type="password" value="" placeholder="${cfg.hasToken ? '已保存，留空不改' : '和画面桥的口令一致'}">
          </div>
          <div style="padding:4px 16px 12px;display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary btn-sm" id="xhs-stack">一键启动</button>
            <button type="button" class="btn btn-ghost btn-sm" id="xhs-save">保存地址</button>
          </div>
        </div>
      </div>
      <div class="xhs-stage" id="xhs-stage">
        <div class="xhs-stage-empty" id="xhs-empty">还没有画面</div>
        <img id="xhs-shot" alt="云端画面" hidden>
        <div class="xhs-mark" id="xhs-mark" hidden></div>
      </div>
      <div style="padding:0 16px 8px">
        <div class="settings-row-sub" id="xhs-note">${escapeHtml(note || '点画面里要他点的位置。')}</div>
        <button type="button" class="btn btn-primary" id="xhs-go" disabled style="margin-top:10px">让他点这里</button>
      </div>
    </div>
  `;
  page.querySelector('#xhs-refresh')?.addEventListener('click', () => { void refreshXhsShot(); });
  page.querySelector('#xhs-save')?.addEventListener('click', () => { void saveXhsScreen(); });
  page.querySelector('#xhs-stack')?.addEventListener('click', () => { void startXhsStack(); });
  page.querySelector('#xhs-shot')?.addEventListener('click', onXhsShotClick);
  page.querySelector('#xhs-go')?.addEventListener('click', () => { void sendXhsClick(); });
}

function setNote(text) {
  const el = document.getElementById('xhs-note');
  if (el) el.textContent = text;
}

function clearPoint() {
  _point = null;
  const mark = document.getElementById('xhs-mark');
  const go = document.getElementById('xhs-go');
  if (mark) mark.hidden = true;
  if (go) go.disabled = true;
}

async function saveXhsScreen() {
  const url = document.getElementById('xhs-url')?.value || '';
  const token = document.getElementById('xhs-token')?.value || '';
  try {
    await api.saveXhsScreen({ url, token });
    setNote('地址已保存。');
    window.showToast?.('已保存');
    await refreshXhsShot();
  } catch (e) {
    setNote(e.message || '保存失败');
    window.showToast?.(e.message || '保存失败');
  }
}

async function startXhsStack() {
  const btn = document.getElementById('xhs-stack');
  if (btn) btn.disabled = true;
  setNote('正在把虚拟屏幕、小红书 MCP 和画面桥一起拉起来…');
  try {
    const data = await api.startXhsStack();
    const urlInput = document.getElementById('xhs-url');
    if (urlInput && data?.url) urlInput.value = data.url;
    setNote(data?.note || (data?.ok ? '已启动' : '没有全部启动'));
    window.showToast?.(data?.ok ? '已启动' : '没有全部启动');
    if (data?.ok && data?.url) await refreshXhsShot();
  } catch (e) {
    setNote(e.message || '启动失败');
    window.showToast?.(e.message || '启动失败');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshXhsShot() {
  if (_busy) return;
  const img = document.getElementById('xhs-shot');
  const empty = document.getElementById('xhs-empty');
  if (!img) return;
  clearPoint();
  setNote('正在取画面…');
  try {
    const data = await api.getXhsScreenShot();
    if (!data?.image) throw new Error('没有画面');
    img.src = data.image;
    img.hidden = false;
    if (empty) empty.hidden = true;
    setNote('点画面里要他点的位置。');
  } catch (e) {
    img.hidden = true;
    if (empty) {
      empty.hidden = false;
      empty.textContent = '还没有画面';
    }
    setNote(e.message || '取画面失败');
  }
}

function onXhsShotClick(ev) {
  const img = ev.currentTarget;
  const rect = img.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = (ev.clientX - rect.left) / rect.width;
  const y = (ev.clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  _point = { x, y };
  const mark = document.getElementById('xhs-mark');
  const stage = document.getElementById('xhs-stage');
  if (mark && stage) {
    const stageRect = stage.getBoundingClientRect();
    mark.hidden = false;
    mark.style.left = `${ev.clientX - stageRect.left}px`;
    mark.style.top = `${ev.clientY - stageRect.top}px`;
  }
  const go = document.getElementById('xhs-go');
  if (go) go.disabled = false;
  setNote('红点是你要他点的地方。确认后按「让他点这里」。');
}

async function sendXhsClick() {
  if (!_point || _busy) return;
  _busy = true;
  const go = document.getElementById('xhs-go');
  if (go) go.disabled = true;
  setNote('正在让他点…');
  try {
    await api.clickXhsScreen({ x: _point.x, y: _point.y });
    setNote('已经点过了。正在刷新画面。');
    window.showToast?.('已经让他点了');
    _busy = false;
    await refreshXhsShot();
  } catch (e) {
    setNote(e.message || '点按失败');
    window.showToast?.(e.message || '点按失败');
    if (go) go.disabled = false;
  } finally {
    _busy = false;
  }
}

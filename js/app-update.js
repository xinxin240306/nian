import { getAppUpdate } from './api.js';

const SKIP_KEY = 'nian_skip_apk_ver';

function plugin() {
  return window.Capacitor?.Plugins?.AppUpdate;
}

export function hasAppUpdatePlugin() {
  return Boolean(plugin()?.getVersion);
}

export async function getNativeAppVersion() {
  const p = plugin();
  if (!p?.getVersion) return { native: false, versionCode: 0, versionName: '' };
  return { native: true, ...(await p.getVersion()) };
}

function apkUrl() {
  return window.resolveApiUrl?.('/api/app-update/apk') || '/api/app-update/apk';
}

function sessionHeaders() {
  const token = window.getSiteSessionToken?.() || localStorage.getItem('nian_site_session') || '';
  const headers = {};
  if (token) headers['X-Nian-Session'] = token;
  return headers;
}

export async function installAppFromServer() {
  const p = plugin();
  if (!p?.installFromUrl) throw new Error('当前安装包还不支持应用内更新');
  if (!p._progressBound) {
    p._progressBound = true;
    p.addListener?.('downloadProgress', (e) => {
      if (e?.percent != null) window.showToast?.(`正在下载安装包 ${e.percent}%`, 1200);
    });
  }
  return p.installFromUrl({ url: apkUrl(), headers: sessionHeaders() });
}

export async function promptAppUpdateIfNeeded(opts = {}) {
  const force = !!opts.force;
  if (!window.isNativeShell?.() || !hasAppUpdatePlugin()) {
    if (force) window.showToast?.('请在 App 里检查更新');
    return;
  }
  const local = await getNativeAppVersion();
  let remote;
  try {
    remote = await getAppUpdate();
  } catch (e) {
    if (force) window.showToast?.(e?.message || '检查更新失败');
    return;
  }
  if (!remote?.available || !remote.versionCode) {
    if (force) window.showToast?.(`已是最新（${local.versionName || '当前包'}）`);
    return;
  }
  if (Number(remote.versionCode) <= Number(local.versionCode || 0)) {
    if (force) window.showToast?.(`已是最新 ${local.versionName}`);
    return;
  }
  if (!force && localStorage.getItem(SKIP_KEY) === String(remote.versionCode)) return;

  const sizeMb = remote.size ? `（约 ${(remote.size / 1048576).toFixed(1)} MB）` : '';
  const ok = window.confirm(
    `发现新版本 ${remote.versionName || remote.versionCode}${sizeMb}\n当前 ${local.versionName || local.versionCode}\n\n下载并安装？`
  );
  if (!ok) {
    localStorage.setItem(SKIP_KEY, String(remote.versionCode));
    return;
  }
  try {
    window.showToast?.('正在下载安装包…', 4000);
    await installAppFromServer();
    window.showToast?.('请在系统安装页点安装');
  } catch (e) {
    window.showToast?.(e?.message || '更新失败');
  }
}

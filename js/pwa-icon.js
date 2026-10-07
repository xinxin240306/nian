/* ===== 保存到桌面 / PWA 图标 ===== */

import { lsGet, lsSet, lsDel } from './storage.js';

const DEFAULT = {
  apple: '/assets/icons/apple-touch-icon.png',
  favicon: '/assets/icons/icon-192.png',
};

function bustUrl(url, ver) {
  if (!url || !ver) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(ver)}`;
}

export function applyPwaIcon(customUrl) {
  const icon = String(customUrl || '').trim();
  if (!icon) {
    lsDel('pwa_icon_ver');
  }
  const ver = icon ? String(lsGet('pwa_icon_ver', '') || Date.now()) : '';
  if (icon && !lsGet('pwa_icon_ver', '')) lsSet('pwa_icon_ver', ver);

  const apple = icon ? bustUrl(icon, ver) : DEFAULT.apple;
  const favicon = icon ? bustUrl(icon, ver) : DEFAULT.favicon;

  document.querySelectorAll('link[rel="apple-touch-icon"]').forEach(el => { el.href = apple; });
  document.querySelectorAll('link[rel="icon"]').forEach(el => {
    el.href = favicon;
    if (icon) el.setAttribute('type', 'image/png');
  });

  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = icon ? `/manifest.json?v=${encodeURIComponent(ver)}` : '/manifest.json';
}

export function bumpPwaIconVersion() {
  const ver = String(Date.now());
  lsSet('pwa_icon_ver', ver);
  return ver;
}

/** 全站自定义字体：上传、注入 @font-face、供纸张/气泡选择器使用 */
import * as api from './api.js';

const STYLE_ID = 'nian-custom-fonts';
const PREVIEW_SAMPLE = '念 · 随手记 春风又绿江南岸 AaBb 123';

/** @type {Array<{id:string,name:string,familyName:string,url:string,format?:string}>} */
let _fonts = [];

export function getCustomFonts() {
  return _fonts.slice();
}

export function getFontPreviewSample() {
  return PREVIEW_SAMPLE;
}

export function customFontsAsPaperEntries() {
  return _fonts.map((f) => ({
    id: `custom:${f.id}`,
    label: f.name || '自定义',
    family: `'${f.familyName}', sans-serif`,
    custom: true,
  }));
}

function formatHint(url, format) {
  if (format) return format;
  const u = String(url || '').toLowerCase();
  if (u.endsWith('.woff2')) return 'woff2';
  if (u.endsWith('.woff')) return 'woff';
  if (u.endsWith('.otf')) return 'opentype';
  return 'truetype';
}

export function injectCustomFontFaces(list = _fonts) {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = (list || []).map((f) => {
    const family = String(f.familyName || '').replace(/['"]/g, '');
    const url = String(f.url || '').replace(/"/g, '');
    if (!family || !url) return '';
    const fmt = formatHint(url, f.format);
    return `@font-face{font-family:'${family}';src:url("${url}") format('${fmt}');font-display:swap;}`;
  }).filter(Boolean).join('\n');
}

export async function loadCustomFonts() {
  try {
    const data = await api.getCustomFonts();
    _fonts = Array.isArray(data?.fonts) ? data.fonts : [];
  } catch {
    try {
      const s = await api.getSettings();
      const raw = s?.custom_fonts;
      _fonts = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(_fonts)) _fonts = [];
    } catch {
      _fonts = [];
    }
  }
  injectCustomFontFaces(_fonts);
  return _fonts;
}

export async function uploadCustomFont(file, name) {
  const data = await api.uploadCustomFont(file, name);
  if (data?.font) {
    _fonts = _fonts.filter((f) => f.id !== data.font.id).concat([data.font]);
    injectCustomFontFaces(_fonts);
  } else {
    await loadCustomFonts();
  }
  return data?.font;
}

export async function renameCustomFont(id, name) {
  const data = await api.renameCustomFont(id, name);
  const idx = _fonts.findIndex((f) => f.id === id);
  if (idx >= 0 && data?.font) _fonts[idx] = data.font;
  else await loadCustomFonts();
  injectCustomFontFaces(_fonts);
  return data?.font;
}

export async function deleteCustomFont(id) {
  await api.deleteCustomFont(id);
  _fonts = _fonts.filter((f) => f.id !== id);
  injectCustomFontFaces(_fonts);
}

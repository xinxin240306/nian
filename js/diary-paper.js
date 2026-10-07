/** 秘密簿纸张：颜色、纹样、翻页效果分开配置 */
import { customFontsAsPaperEntries } from './custom-fonts.js';

export const PAPER_COLORS = [
  { id: 'blank', label: '象牙', bg: '#f7f3ea', textColor: '#3a3228' },
  { id: 'cream', label: '米白', bg: '#faf6ee', textColor: '#3a3228' },
  { id: 'white', label: '纯白', bg: '#ffffff', textColor: '#2c241c' },
  { id: 'pink', label: '浅粉', bg: '#fdf2f6', textColor: '#5a3a48' },
  { id: 'sage', label: '浅绿', bg: '#f3f7f2', textColor: '#334038' },
  { id: 'sky', label: '浅蓝', bg: '#f0f5fb', textColor: '#2f3540' },
  { id: 'lilac', label: '浅紫', bg: '#f5f0fa', textColor: '#3a3048' },
  { id: 'sand', label: '沙色', bg: '#f5efe4', textColor: '#3a3228' },
];

export const PAPER_PATTERNS = [
  { id: 'none', label: '无纹' },
  { id: 'ruled', label: '横线' },
  { id: 'grid', label: '方格' },
  { id: 'dots', label: '点点' },
  { id: 'stripes', label: '竖纹' },
];

export const FLIP_EFFECTS = [
  { id: 'realistic', label: '仿真' },
  { id: 'cover', label: '覆盖' },
  { id: 'slide', label: '滑动' },
  { id: 'none', label: '无动画' },
];

/** 共享备忘录字迹 + 聊天气泡字体 */
export const PAPER_FONTS = [
  { id: 'system', label: '系统', family: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Microsoft YaHei', sans-serif" },
  { id: 'sans', label: '黑体', family: "'Noto Sans SC', 'PingFang SC', sans-serif" },
  { id: 'serif', label: '宋体', family: "'Noto Serif SC', SimSun, serif" },
  { id: 'kai', label: '楷体', family: "KaiTi, STKaiti, 'Noto Serif SC', serif" },
  { id: 'xingkai', label: '行楷', family: "'STXingkai', '华文行楷', 'Xingkai SC', 'FZXingKai-S04', KaiTi, 'Noto Serif SC', serif" },
  { id: 'fang', label: '仿宋', family: "FangSong, STFangsong, 'Noto Serif SC', serif" },
  { id: 'yuan', label: '圆体', family: "'ZCOOL KuaiLe', 'Noto Sans SC', sans-serif" },
  { id: 'hand', label: '行草', family: "'Liu Jian Mao Cao', 'Noto Serif SC', cursive" },
  { id: 'mashan', label: '毛笔', family: "'Ma Shan Zheng', 'Noto Serif SC', cursive" },
  { id: 'xiaowei', label: '小薇', family: "'ZCOOL XiaoWei', 'Noto Serif SC', serif" },
  { id: 'longcang', label: '龙藏', family: "'Long Cang', 'Noto Serif SC', cursive" },
  { id: 'zhimang', label: '芝麻', family: "'Zhi Mang Xing', 'Noto Serif SC', cursive" },
];

/** 内置 + 已上传自定义字体 */
export function getPaperFonts() {
  return [...PAPER_FONTS, ...customFontsAsPaperEntries()];
}

export function isValidPaperFontId(fontId) {
  const id = String(fontId || '').trim();
  if (!id) return false;
  if (PAPER_FONTS.some(f => f.id === id)) return true;
  // 自定义：允许尚未注入完时保留 id，避免被 normalize 清掉
  return id.startsWith('custom:') && id.length > 8;
}

export function resolvePaperFont(fontId) {
  const all = getPaperFonts();
  return all.find(f => f.id === fontId) || PAPER_FONTS[0];
}

const APP_FONT_KEY = 'beautify_app_font';
const DEFAULT_APP_FONT = 'sans';

export function getAppFontId() {
  try {
    const id = String(localStorage.getItem(APP_FONT_KEY) || DEFAULT_APP_FONT).trim();
    return isValidPaperFontId(id) ? id : DEFAULT_APP_FONT;
  } catch {
    return DEFAULT_APP_FONT;
  }
}

export function setAppFontId(fontId) {
  const id = isValidPaperFontId(fontId) ? String(fontId).trim() : DEFAULT_APP_FONT;
  try { localStorage.setItem(APP_FONT_KEY, id); } catch {}
  return id;
}

/** 应用到整站界面（html/body 的 --app-font） */
export function applyAppFont(fontId) {
  const id = fontId != null ? setAppFontId(fontId) : getAppFontId();
  const font = resolvePaperFont(id);
  const family = font?.family || PAPER_FONTS.find((f) => f.id === DEFAULT_APP_FONT)?.family
    || "'Noto Sans SC', 'PingFang SC', sans-serif";
  try {
    document.documentElement.style.setProperty('--app-font', family);
    document.body?.style?.setProperty('font-family', `var(--app-font)`);
  } catch {}
  return id;
}

/** @deprecated 角色编辑页仍用组合预设做默认色 */
export const DIARY_PAPERS = [
  { id: 'blank', label: '空白', bg: '#f7f3ea', pattern: 'none', textColor: '#3a3228' },
  { id: 'cream', label: '米白', bg: '#faf6ee', pattern: 'none', textColor: '#3a3228' },
  { id: 'ruled', label: '横线', bg: '#fbf8f1', pattern: 'ruled', textColor: '#3a3228' },
  { id: 'grid', label: '方格', bg: '#f8f9fb', pattern: 'grid', textColor: '#2f3540' },
  { id: 'dots', label: '点点', bg: '#f9f6f0', pattern: 'dots', textColor: '#3a3228' },
  { id: 'pink', label: '浅粉', bg: '#fdf2f6', pattern: 'none', textColor: '#5a3a48' },
  { id: 'sage', label: '浅绿', bg: '#f3f7f2', pattern: 'none', textColor: '#334038' },
];

const PATTERN_CSS = {
  none: 'none',
  ruled: 'repeating-linear-gradient(transparent 0 27px, rgba(90,120,150,0.18) 27px 28px)',
  grid: `
    repeating-linear-gradient(transparent 0 23px, rgba(100,120,140,0.14) 23px 24px),
    repeating-linear-gradient(90deg, transparent 0 23px, rgba(100,120,140,0.14) 23px 24px)
  `.replace(/\s+/g, ' ').trim(),
  dots: 'radial-gradient(rgba(90,100,120,0.2) 1.1px, transparent 1.2px)',
  stripes: 'repeating-linear-gradient(90deg, transparent 0 18px, rgba(90,120,150,0.1) 18px 19px)',
};

const DEFAULT_SETTINGS = {
  color: 'blank',
  pattern: 'none',
  flip: 'realistic',
  userFont: 'serif',
  aiFont: 'serif',
  userInk: '',
  aiInk: '',
  userFontSize: 16,
  aiFontSize: 16,
  markCircle: '#c45c5c',
  markStrike: '#8b5a2b',
  markLine: '#2a6f9e',
  markNote: '#6b4ea0',
};

function clampFontSize(n, fallback = 16) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(22, Math.max(13, v));
}

function normalizeHexColor(v, fallback) {
  const s = String(v || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  return fallback;
}

export function isDiaryCustomBg(value) {
  const v = String(value || '').trim();
  return v.startsWith('/uploads/') || v.startsWith('http://') || v.startsWith('https://') || v.startsWith('data:');
}

/** 旧版单一 paperId → 新 settings */
export function migratePaperKey(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return normalizePaperSettings(raw);
  }
  const id = String(raw || '').trim();
  if (!id || id === 'default') return { ...DEFAULT_SETTINGS };
  if (id === 'custom') {
    try {
      const url = localStorage.getItem('diary_custom_bg');
      if (url) return normalizePaperSettings({ color: url, pattern: 'none', flip: 'realistic' });
    } catch {}
    return { ...DEFAULT_SETTINGS };
  }
  if (isDiaryCustomBg(id)) {
    return normalizePaperSettings({ color: id, pattern: 'none', flip: 'realistic' });
  }
  const legacy = DIARY_PAPERS.find(p => p.id === id);
  if (legacy) {
    const colorId = PAPER_COLORS.some(c => c.id === legacy.id)
      ? legacy.id
      : (legacy.id === 'ruled' || legacy.id === 'dots' ? 'cream' : legacy.id === 'grid' ? 'sky' : 'blank');
    return normalizePaperSettings({
      color: PAPER_COLORS.some(c => c.id === colorId) ? colorId : 'blank',
      pattern: legacy.pattern || 'none',
      flip: 'realistic',
    });
  }
  return { ...DEFAULT_SETTINGS };
}

export function normalizePaperSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  let color = String(s.color || DEFAULT_SETTINGS.color).trim() || DEFAULT_SETTINGS.color;
  let pattern = String(s.pattern || DEFAULT_SETTINGS.pattern).trim() || DEFAULT_SETTINGS.pattern;
  let flip = String(s.flip || DEFAULT_SETTINGS.flip).trim() || DEFAULT_SETTINGS.flip;
  let userFont = String(s.userFont || DEFAULT_SETTINGS.userFont).trim() || DEFAULT_SETTINGS.userFont;
  let aiFont = String(s.aiFont || DEFAULT_SETTINGS.aiFont).trim() || DEFAULT_SETTINGS.aiFont;
  let userInk = String(s.userInk || '').trim();
  let aiInk = String(s.aiInk || '').trim();
  const userFontSize = clampFontSize(s.userFontSize, DEFAULT_SETTINGS.userFontSize);
  const aiFontSize = clampFontSize(s.aiFontSize, DEFAULT_SETTINGS.aiFontSize);
  const markCircle = normalizeHexColor(s.markCircle, DEFAULT_SETTINGS.markCircle);
  const markStrike = normalizeHexColor(s.markStrike, DEFAULT_SETTINGS.markStrike);
  const markLine = normalizeHexColor(s.markLine, DEFAULT_SETTINGS.markLine);
  const markNote = normalizeHexColor(s.markNote, DEFAULT_SETTINGS.markNote);
  if (!PAPER_PATTERNS.some(p => p.id === pattern)) pattern = 'none';
  if (!FLIP_EFFECTS.some(f => f.id === flip)) flip = 'realistic';
  if (!isValidPaperFontId(userFont)) userFont = DEFAULT_SETTINGS.userFont;
  if (!isValidPaperFontId(aiFont)) aiFont = DEFAULT_SETTINGS.aiFont;
  if (!isDiaryCustomBg(color) && !PAPER_COLORS.some(c => c.id === color) && !/^#[0-9a-fA-F]{6}$/.test(color)) {
    color = DEFAULT_SETTINGS.color;
  }
  if (userInk && !/^#[0-9a-fA-F]{6}$/.test(userInk)) userInk = '';
  if (aiInk && !/^#[0-9a-fA-F]{6}$/.test(aiInk)) aiInk = '';
  return {
    color, pattern, flip, userFont, aiFont, userInk, aiInk,
    userFontSize, aiFontSize, markCircle, markStrike, markLine, markNote,
  };
}

export function parseStoredPaper(raw) {
  if (raw == null || raw === '') return { ...DEFAULT_SETTINGS };
  if (typeof raw === 'object') return migratePaperKey(raw);
  const str = String(raw).trim();
  if (str.startsWith('{')) {
    try { return migratePaperKey(JSON.parse(str)); } catch { /* fallthrough */ }
  }
  return migratePaperKey(str);
}

export function serializePaperSettings(settings) {
  return JSON.stringify(normalizePaperSettings(settings));
}

export function resolvePaperAppearance(settingsOrId) {
  const s = typeof settingsOrId === 'object' && settingsOrId
    ? normalizePaperSettings(settingsOrId)
    : migratePaperKey(settingsOrId);

  let bg = PAPER_COLORS[0].bg;
  let textColor = PAPER_COLORS[0].textColor;
  let imageUrl = '';

  if (isDiaryCustomBg(s.color)) {
    imageUrl = s.color;
    // 底层纯色 + 高不透明遮罩，避免透出下层
    bg = `linear-gradient(#faf6ee,#faf6ee), linear-gradient(rgba(255,252,245,0.88), rgba(255,252,245,0.88)), url("${String(s.color).replace(/"/g, '')}") center/cover no-repeat`;
    textColor = '#2c241c';
  } else if (/^#[0-9a-fA-F]{6}$/.test(s.color)) {
    bg = s.color;
    textColor = '#2c241c';
  } else {
    const c = PAPER_COLORS.find(x => x.id === s.color) || PAPER_COLORS[0];
    bg = c.bg;
    textColor = c.textColor;
  }

  return {
    ...s,
    id: isDiaryCustomBg(s.color) ? 'custom' : s.color,
    label: isDiaryCustomBg(s.color) ? '自定义' : (PAPER_COLORS.find(x => x.id === s.color)?.label || '自定义色'),
    bg,
    textColor,
    imageUrl,
    pattern: s.pattern,
    flip: s.flip,
  };
}

/** 兼容旧调用 */
export function resolveDiaryPaper(paperId) {
  return resolvePaperAppearance(paperId);
}

function applyPatternLayer(el, pattern) {
  if (!el) return;
  const css = PATTERN_CSS[pattern] || PATTERN_CSS.none;
  if (!css || css === 'none') {
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
    return;
  }
  el.style.backgroundImage = css;
  if (pattern === 'dots') {
    el.style.backgroundSize = '14px 14px';
    el.style.backgroundPosition = '8px 8px';
  } else {
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
  }
}

function ensureOpaqueBase(el, appearance) {
  if (!el) return;
  // 实心底色，防止透出下层内容
  const solid = appearance.imageUrl
    ? '#faf6ee'
    : (/^#[0-9a-fA-F]{6}$/.test(appearance.color)
      ? appearance.color
      : (PAPER_COLORS.find(c => c.id === appearance.color)?.bg || '#f7f3ea'));
  el.style.backgroundColor = solid;
  el.style.opacity = '1';
  el.style.isolation = 'isolate';
}

/** 将纸张应用到容器（不透明底色 + 独立纹样层）
 *  注意：不要动顶栏背景——顶栏由 .secret-sheet-topbar 统一用不透明纸色，
 *  以前写成半透明玻璃会透出主题背景图，看起来像「顶栏透明」。 */
export function applyDiarySheetStyle(sheetEl, contentEl, paperIdOrSettings, opts = {}) {
  if (!sheetEl) return resolvePaperAppearance(paperIdOrSettings);
  const p = resolvePaperAppearance(paperIdOrSettings);

  ensureOpaqueBase(sheetEl, p);
  sheetEl.style.background = p.bg;
  sheetEl.style.backgroundSize = p.imageUrl ? 'cover' : '';
  sheetEl.style.backgroundPosition = p.imageUrl ? 'center' : '';
  sheetEl.style.opacity = '1';

  let patternEl = sheetEl.querySelector(':scope > .secret-paper-pattern');
  if (!patternEl) {
    patternEl = document.createElement('div');
    patternEl.className = 'secret-paper-pattern';
    patternEl.setAttribute('aria-hidden', 'true');
    sheetEl.insertBefore(patternEl, sheetEl.firstChild);
  }
  applyPatternLayer(patternEl, p.pattern || 'none');

  // 清除历史版本可能写在顶栏上的半透明内联样式
  const topbar = sheetEl.querySelector('.sheet-full-topbar, .secret-topbar');
  if (topbar) {
    topbar.style.background = '';
    topbar.style.backdropFilter = '';
    topbar.style.webkitBackdropFilter = '';
    if (!opts.keepTopbar) topbar.style.color = p.textColor || '';
  }

  if (contentEl) {
    contentEl.style.color = p.textColor || '#3a3228';
    contentEl.style.textShadow = 'none';
    contentEl.style.lineHeight = '1.9';
    contentEl.style.opacity = '1';
  }
  return p;
}

export function diaryPaperSwatchStyle(paperId) {
  const p = resolvePaperAppearance(paperId);
  if (p.imageUrl) return `url("${p.imageUrl}") center/cover no-repeat`;
  return p.bg;
}

export function getBookPaperKey(type, charId, section) {
  return `secret_book_paper_${type || 'user'}_${charId || 0}_${section || 'diary'}`;
}

export function loadBookPaperSettings(type, charId, section) {
  // 每本书/每个分区各自一个 key，互不影响——不再兜底读全局 diary_user_paper，
  // 否则任意一本存过设置后，其它没单独设置过的本子会全部被它"带偏"。
  const key = getBookPaperKey(type, charId, section);
  try {
    const local = localStorage.getItem(key);
    if (local) return parseStoredPaper(local);
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveBookPaperSettings(type, charId, section, settings) {
  const normalized = normalizePaperSettings(settings);
  const key = getBookPaperKey(type, charId, section);
  try {
    localStorage.setItem(key, serializePaperSettings(normalized));
  } catch {}
  return normalized;
}

export function getFlipDurationMs(flip) {
  switch (flip) {
    case 'realistic': return 720;
    case 'cover': return 520;
    case 'slide': return 420;
    default: return 0;
  }
}

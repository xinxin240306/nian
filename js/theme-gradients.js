/** 内页主题渐变预设（整体偏明亮） */
export const GRADIENT_PRESETS = [
  { id: 'dreamy',  name: '梦幻紫粉' },
  { id: 'sunset',  name: '暖暮橙' },
  { id: 'ocean',   name: '海盐蓝' },
  { id: 'forest',  name: '薄荷绿' },
  { id: 'lavender', name: '浅薰衣草' },
  { id: 'rose',    name: '玫瑰金' },
  { id: 'aurora',  name: '极光' },
  { id: 'mono',    name: '素雾灰' },
];

function parseHex(hex) {
  const h = (hex || '#c9a0dc').replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) || 201,
    g: parseInt(h.slice(2, 4), 16) || 160,
    b: parseInt(h.slice(4, 6), 16) || 220,
  };
}

function rgba({ r, g, b }, a) {
  return `rgba(${r},${g},${b},${a})`;
}

function lighten(c, amount = 40) {
  return {
    r: Math.min(255, c.r + amount),
    g: Math.min(255, c.g + amount),
    b: Math.min(255, c.b + amount),
  };
}

export function buildThemeGradient(themeHex, presetId = 'dreamy') {
  const c = parseHex(themeHex);
  const l = lighten(c, 30);
  switch (presetId) {
    case 'sunset':
      return `linear-gradient(145deg, #fffaf7 0%, #ffe8dc 35%, #ffd4c8 65%, ${rgba(l, 0.35)} 100%)`;
    case 'ocean':
      return `linear-gradient(160deg, #f7fcff 0%, #dff3ff 40%, #c5e8f7 70%, ${rgba(l, 0.28)} 100%)`;
    case 'forest':
      return `linear-gradient(140deg, #f5fcf8 0%, #dcf5e8 45%, #c8edd9 75%, ${rgba(l, 0.25)} 100%)`;
    case 'lavender':
      return `linear-gradient(155deg, #faf8ff 0%, #ede5ff 40%, ${rgba(c, 0.22)} 70%, #f3eeff 100%)`;
    case 'rose':
      return `linear-gradient(135deg, #fff5f9 0%, #fce0ec 40%, #f8cce0 70%, ${rgba(l, 0.3)} 100%)`;
    case 'aurora':
      return `linear-gradient(120deg, #f0fbff 0%, ${rgba(c, 0.18)} 22%, #e5faf0 48%, #f0e8ff 72%, #fff5fa 100%)`;
    case 'mono':
      return `linear-gradient(135deg, #fafafa 0%, #f0f0f4 50%, #e8e8ee 100%)`;
    case 'night':
    case 'dreamy':
    default:
      return `linear-gradient(135deg, #fffcfe 0%, ${rgba(c, 0.08)} 22%, #fff5fa 50%, ${rgba(c, 0.1)} 78%, #faf5ff 100%)`;
  }
}

export function resolveGradientPreset(themeBgType, themeBgValue) {
  if (themeBgType !== 'gradient') return 'dreamy';
  const v = (themeBgValue || '').trim();
  if (!v) return 'dreamy';
  if (v.includes('linear-gradient') || v.includes('#1') || v.includes('#0')) return 'dreamy';
  if (v === 'night') return 'lavender';
  if (GRADIENT_PRESETS.some(p => p.id === v)) return v;
  return 'dreamy';
}

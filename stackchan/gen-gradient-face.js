/**
 * 生成 ParamFace face.json：上蓝下粉渐变眼（像素帧）
 * 用法：node stackchan/gen-gradient-face.js
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'faces', 'NianGradient.json');

const COLORS = {
  bg: '#f3e8e4',
  blue: '#5b6a9a',
  pink: '#e89bb8',
  mid: '#9a82b0',
  highlight: '#ffffff',
  mouth: '#ff52a5',
  blush: '#f0a0b4',
};

/** 整张脸下移，给顶部滚动字幕留空（canvas 坐标 px） */
const FACE_Y_OFFSET = 14;

/** 眼睛内渐变：蓝色约占 2/3，余下为过渡+粉 */
const BLUE_SHARE = 2 / 3;

function encodeRle(indices) {
  const bytes = [];
  let i = 0;
  while (i < indices.length) {
    const idx = indices[i];
    let run = 1;
    while (i + run < indices.length && indices[i + run] === idx && run < 16) run++;
    bytes.push(((run - 1) << 4) | (idx & 0x0f));
    i += run;
  }
  return Buffer.from(bytes).toString('base64');
}

/** 渐变椭圆眼：索引 0=透明，1=蓝，2=粉，3=过渡，4=高光 */
function buildOpenEye(w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w * 0.42;
  const ry = h * 0.44;
  const out = [];
  let yMin = h;
  let yMax = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) {
        out.push([x, y]);
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
  }
  const grid = new Array(w * h).fill(0);
  for (const [x, y] of out) {
    const t = (y - yMin) / Math.max(1, yMax - yMin);
    let idx = 1;
    if (t >= BLUE_SHARE + 0.08) idx = 2;
    else if (t >= BLUE_SHARE - 0.06) idx = 3;
    const hx = cx - rx * 0.28;
    const hy = cy - ry * 0.32;
    if ((x - hx) ** 2 + (y - hy) ** 2 < (w * 0.11) ** 2) idx = 4;
    grid[y * w + x] = idx;
  }
  return grid;
}

function buildClosedEye(w, h) {
  const grid = new Array(w * h).fill(0);
  const cy = Math.floor(h / 2);
  const cx = w / 2;
  const rx = w * 0.38;
  for (let x = 0; x < w; x++) {
    const nx = (x - cx) / rx;
    if (Math.abs(nx) <= 1) {
      grid[cy * w + x] = 1;
      if (cy + 1 < h) grid[(cy + 1) * w + x] = 1;
    }
  }
  return grid;
}

function spriteFrame(w, h, grid, palette) {
  return {
    w,
    h,
    palette,
    data: encodeRle(grid),
  };
}

function buildBlushOverlay(w, h) {
  const grid = new Array(w * h).fill(0);
  const cheeks = [
    { cx: 23, cy: 33, rx: 7, ry: 3.5 },
    { cx: 57, cy: 33, rx: 7, ry: 3.5 },
  ];
  for (const { cx, cy, rx, ry } of cheeks) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) grid[y * w + x] = 1;
      }
    }
  }
  return grid;
}

const EYE_W = 20;
const EYE_Y = 98 + FACE_Y_OFFSET;
const MOUTH_Y = 152 + FACE_Y_OFFSET;
const EYE_H = 22;
const eyePalette = [COLORS.blue, COLORS.pink, COLORS.mid, COLORS.highlight];
const openEye = buildOpenEye(EYE_W, EYE_H);
const closedEye = buildClosedEye(EYE_W, EYE_H);
const eyeOpen = spriteFrame(EYE_W, EYE_H, openEye, eyePalette);
const eyeClosed = spriteFrame(EYE_W, EYE_H, closedEye, [COLORS.blue]);

const blushGrid = buildBlushOverlay(80, 60);
const blushFrame = spriteFrame(80, 60, blushGrid, [COLORS.blush]);

const face = {
  version: 1,
  meta: { name: 'NianGradient', author: 'nian' },
  canvas: { width: 320, height: 240 },
  palette: {
    primary: COLORS.blue,
    secondary: COLORS.pink,
    background: COLORS.bg,
  },
  parts: {
    eyeL: {
      pos: { x: 228, y: EYE_Y },
      shape: 'pixel',
      scale: 3,
      smooth: true,
      frames: { open: eyeOpen, closed: eyeClosed },
      upperLid: { angle: 0, cover: 0 },
      lowerLid: { angle: 0, cover: 0 },
    },
    eyeR: {
      pos: { x: 92, y: EYE_Y },
      shape: 'pixel',
      scale: 3,
      smooth: true,
      frames: { open: eyeOpen, closed: eyeClosed },
      upperLid: { angle: 0, cover: 0 },
      lowerLid: { angle: 0, cover: 0 },
    },
    mouth: {
      pos: { x: 160, y: MOUTH_Y },
      shape: 'omega',
      minWidth: 48,
      maxWidth: 78,
      minHeight: 6,
      maxHeight: 50,
      color: COLORS.mouth,
    },
  },
  overlay: {
    smooth: true,
    frames: { open: blushFrame },
  },
  animation: {
    blink: { interval: 4.2, duration: 130 },
    saccade: { interval: 2.5, amplitude: 0.45 },
    breath: { period: 3.2, depth: 0.55 },
  },
  expressions: {
    happy: {
      parts: {
        eyeL: { lowerLid: { cover: 0.45 } },
        eyeR: { lowerLid: { cover: 0.45 } },
      },
    },
    angry: {
      parts: {
        eyeL: { upperLid: { angle: -24, cover: 0.38 } },
        eyeR: { upperLid: { angle: 24, cover: 0.38 } },
      },
    },
    sad: {
      parts: {
        eyeL: { upperLid: { angle: 14, cover: 0.32 } },
        eyeR: { upperLid: { angle: -14, cover: 0.32 } },
      },
    },
    doubt: {
      parts: {
        eyeL: { upperLid: { cover: 0.48 } },
        eyeR: { upperLid: { cover: 0.06 } },
        mouth: { minWidth: -12, maxWidth: -22 },
      },
    },
    sleepy: {
      parts: {
        eyeL: { upperLid: { cover: 0.62 } },
        eyeR: { upperLid: { cover: 0.62 } },
      },
      animation: {
        blink: { interval: 2.4, duration: 270 },
        breath: { depth: 0.38 },
      },
    },
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(face, null, 2)}\n`, 'utf8');
console.log('Wrote', OUT);

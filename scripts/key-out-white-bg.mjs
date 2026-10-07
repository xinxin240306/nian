/**
 * 批量抠白底：assets/inline-emoji/raw → assets/inline-emoji/out
 * 从边缘 flood-fill 抠背景，保留内部眼白/牙齿等白色区域。
 * 用法：node scripts/key-out-white-bg.mjs
 * 可选：node scripts/key-out-white-bg.mjs --src "D:/某文件夹" --threshold 238
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const sharp = require('sharp');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const SRC = path.resolve(arg('src', path.join(root, 'assets', 'inline-emoji', 'raw')));
const OUT = path.resolve(arg('out', path.join(root, 'assets', 'inline-emoji', 'out')));
const THRESHOLD = Number(arg('threshold', '238')) || 238;
const SOFT = Number(arg('soft', '18')) || 18;
const HARD_SAT = 22;
const SOFT_SAT = 28;
const SEAL_RADIUS = Number(arg('seal', '2')) || 2; // 封住轮廓细缝，防止眼白漏连到白底
const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

if (!fs.existsSync(SRC)) {
  console.error(`找不到源目录：${SRC}`);
  console.error('请把白底小黄豆放进该目录，或用 --src 指定路径');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

function sanitizeStem(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 40) || 'emoji';
}

/** 可作为背景的像素返回 alpha 倍率（0=全透，>0 软边保留比例）；非白返回 -1 */
function bgAlphaMul(r, g, b) {
  const minc = Math.min(r, g, b);
  const maxc = Math.max(r, g, b);
  const sat = maxc - minc;
  if (minc >= THRESHOLD && sat <= HARD_SAT) return 0;
  if (minc >= THRESHOLD - SOFT && sat <= SOFT_SAT) {
    return Math.max(0, Math.min(1, (THRESHOLD - minc) / SOFT));
  }
  return -1;
}

function dilateMask(src, width, height, radius) {
  if (radius <= 0) return src;
  const out = new Uint8Array(src);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!src[y * width + x]) continue;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          out[yy * width + xx] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * 从边缘抠白底：
 * 1) 膨胀非白轮廓封缝，避免眼白/牙齿经细缝连到白底
 * 2) 仅沿硬白 flood
 * 3) 软白只做贴边半透明
 * 4) 内部透明孔洞用原图像素填回
 */
async function keyOutWhite(inputPath, outputPath) {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const ch = info.channels;
  const n = width * height;
  const orig = Buffer.from(data);
  const alphaMul = new Float32Array(n);
  const solid = new Uint8Array(n);
  const isBg = new Uint8Array(n);

  for (let p = 0; p < n; p++) {
    const i = p * ch;
    if (data[i + 3] === 0) {
      alphaMul[p] = 0;
      continue;
    }
    const mul = bgAlphaMul(data[i], data[i + 1], data[i + 2]);
    alphaMul[p] = mul;
    if (mul < 0) solid[p] = 1;
  }

  const sealed = dilateMask(solid, width, height, SEAL_RADIUS);

  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;

  const enqHard = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (isBg[p] || sealed[p] || alphaMul[p] !== 0) return;
    isBg[p] = 1;
    queue[qt++] = p;
  };

  for (let x = 0; x < width; x++) {
    enqHard(x, 0);
    enqHard(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    enqHard(0, y);
    enqHard(width - 1, y);
  }

  while (qh < qt) {
    const p = queue[qh++];
    const x = p % width;
    const y = (p / width) | 0;
    enqHard(x - 1, y);
    enqHard(x + 1, y);
    enqHard(x, y - 1);
    enqHard(x, y + 1);
  }

  // 剥掉封缝膨胀在外侧白底上形成的一圈“白边”，但不穿过本体轮廓
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (let p = 0; p < n; p++) {
      if (isBg[p] || solid[p] || alphaMul[p] !== 0 || !sealed[p]) continue;
      const x = p % width;
      const y = (p / width) | 0;
      const touch =
        (x > 0 && isBg[p - 1]) ||
        (x + 1 < width && isBg[p + 1]) ||
        (y > 0 && isBg[p - width]) ||
        (y + 1 < height && isBg[p + width]);
      if (!touch) continue;
      isBg[p] = 1;
      peeled = true;
    }
  }

  for (let p = 0; p < n; p++) {
    if (isBg[p] || alphaMul[p] <= 0) continue;
    const x = p % width;
    const y = (p / width) | 0;
    const touch =
      (x > 0 && isBg[p - 1]) ||
      (x + 1 < width && isBg[p + 1]) ||
      (y > 0 && isBg[p - width]) ||
      (y + 1 < height && isBg[p + width]);
    if (touch) isBg[p] = 2;
  }

  for (let p = 0; p < n; p++) {
    if (!isBg[p]) continue;
    const i = p * ch;
    data[i + 3] = Math.round(data[i + 3] * alphaMul[p]);
  }

  // 内部透明孔洞 → 还原
  const exterior = new Uint8Array(n);
  qh = 0;
  qt = 0;
  const enqExterior = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (exterior[p] || data[p * ch + 3] > 0) return;
    exterior[p] = 1;
    queue[qt++] = p;
  };
  for (let x = 0; x < width; x++) {
    enqExterior(x, 0);
    enqExterior(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    enqExterior(0, y);
    enqExterior(width - 1, y);
  }
  while (qh < qt) {
    const p = queue[qh++];
    const x = p % width;
    const y = (p / width) | 0;
    enqExterior(x - 1, y);
    enqExterior(x + 1, y);
    enqExterior(x, y - 1);
    enqExterior(x, y + 1);
  }

  for (let p = 0; p < n; p++) {
    const i = p * ch;
    if (data[i + 3] > 0 || exterior[p]) continue;
    data[i] = orig[i];
    data[i + 1] = orig[i + 1];
    data[i + 2] = orig[i + 2];
    data[i + 3] = orig[i + 3] || 255;
  }

  const tmpPath = `${outputPath}.__tmp__.png`;
  await sharp(data, {
    raw: { width, height, channels: ch },
  })
    .trim({ threshold: 0 })
    .png({ compressionLevel: 9 })
    .toFile(tmpPath);

  fs.renameSync(tmpPath, outputPath);
}

const files = fs.readdirSync(SRC)
  .filter((f) => IMAGE_RE.test(f) && !f.startsWith('.'))
  .sort((a, b) => a.localeCompare(b, 'zh'));

if (!files.length) {
  console.error(`源目录没有图片：${SRC}`);
  process.exit(1);
}

// 清掉上次核对用的临时图，避免占着文件句柄
for (const f of fs.readdirSync(OUT)) {
  if (f.startsWith('_check_') || f.includes('.__tmp__.')) {
    try { fs.unlinkSync(path.join(OUT, f)); } catch { /* ignore */ }
  }
}

const manifest = { version: 1, name: '小黄豆', emojis: [] };
let ok = 0;
let fail = 0;
for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const stem = sanitizeStem(file);
  const outName = `${stem}.png`;
  const outPath = path.join(OUT, outName);
  try {
    await keyOutWhite(path.join(SRC, file), outPath);
    manifest.emojis.push({ code: stem, file: outName, aliases: [] });
    ok += 1;
    console.log(`[${ok}/${files.length}] ${file} → ${outName}`);
  } catch (e) {
    fail += 1;
    console.error(`失败 ${file}:`, e.message);
  }
}

const manifestPath = path.join(OUT, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`完成 ${ok}/${files.length}${fail ? `（失败 ${fail}）` : ''}，清单：${manifestPath}`);
if (fail) process.exitCode = 1;

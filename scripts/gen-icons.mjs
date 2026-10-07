/**
 * 从行草字形 path 生成 PWA 所需 PNG（需 sharp）
 * 字形来源与开屏一致：Liu Jian Mao Cao
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const iconsDir = path.join(root, 'assets', 'icons');

const svgPath = path.join(iconsDir, 'icon.svg');
if (!fs.existsSync(svgPath)) {
  console.error('请先运行: node scripts/gen-icon-svg.mjs');
  process.exit(1);
}
const svg = fs.readFileSync(svgPath, 'utf8');

let sharp;
try {
  sharp = require(path.join(root, 'backend', 'node_modules', 'sharp'));
} catch {
  try {
    sharp = require('sharp');
  } catch {
    console.error('请先运行: cd backend && npm install sharp');
    process.exit(1);
  }
}

for (const size of [192, 512]) {
  const out = path.join(iconsDir, `icon-${size}.png`);
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(out);
  console.log('wrote', out);
}

await sharp(Buffer.from(svg)).resize(180, 180).png().toFile(path.join(iconsDir, 'apple-touch-icon.png'));
console.log('wrote apple-touch-icon.png');

// 启动图（竖屏）— 深色底 + 行草「念」
const fontPath = path.join(root, 'assets', 'fonts', 'LiuJianMaoCao-Regular.ttf');
if (!fs.existsSync(fontPath)) {
  fs.mkdirSync(path.dirname(fontPath), { recursive: true });
  const url = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/liujianmaocao/LiuJianMaoCao-Regular.ttf';
  console.log('Downloading Liu Jian Mao Cao...');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font download failed: ${res.status}`);
  fs.writeFileSync(fontPath, Buffer.from(await res.arrayBuffer()));
}
const opentype = require(path.join(root, 'backend', 'node_modules', 'opentype.js'));
const font = opentype.parse(fs.readFileSync(fontPath).buffer);
const splashSize = 200;
const probe = font.getPath('念', 0, 0, splashSize);
const bbox = probe.getBoundingBox();
const cx = (bbox.x1 + bbox.x2) / 2;
const cy = (bbox.y1 + bbox.y2) / 2;
const splashPath = font.getPath('念', 585 - cx, 1080 - cy, splashSize).toPathData(2);

const splashSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1170 2532">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#100818"/>
      <stop offset="50%" stop-color="#1a0a28"/>
      <stop offset="100%" stop-color="#100818"/>
    </linearGradient>
  </defs>
  <rect width="1170" height="2532" fill="url(#bg)"/>
  <circle cx="585" cy="1080" r="140" fill="rgba(201,160,220,0.25)"/>
  <path fill="#c9a0dc" d="${splashPath}"/>
  <text x="585" y="1280" font-size="42" text-anchor="middle" fill="rgba(255,255,255,0.45)" font-family="sans-serif">异世界通讯</text>
</svg>`;

await sharp(Buffer.from(splashSvg)).resize(1170, 2532).png().toFile(path.join(iconsDir, 'splash-1170x2532.png'));
console.log('wrote splash');

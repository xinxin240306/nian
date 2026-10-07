/**
 * 用开屏同款行草字体（Liu Jian Mao Cao）把「念」描成 path，写入 icon.svg
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const fontPath = path.join(root, 'assets', 'fonts', 'LiuJianMaoCao-Regular.ttf');
const outPath = path.join(root, 'assets', 'icons', 'icon.svg');

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
const size = 280;
const probe = font.getPath('念', 0, 0, size);
const bbox = probe.getBoundingBox();
const cx = (bbox.x1 + bbox.x2) / 2;
const cy = (bbox.y1 + bbox.y2) / 2;
const pathData = font.getPath('念', 256 - cx, 256 - cy, size).toPathData(2);

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#e8d5f5"/>
      <stop offset="100%" stop-color="#c9a0dc"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="108" fill="url(#bg)"/>
  <path fill="#ffffff" d="${pathData}"/>
</svg>
`;

fs.writeFileSync(outPath, svg, 'utf8');
console.log('wrote', outPath, 'pathLen=', pathData.length);

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const www = path.join(root, 'www');

const COPY = [
  'index.html',
  'manifest.json',
  'sw.js',
  'assets',
  'css',
  'js',
];

/** 仅供本地脚本重生图标，界面走 Google Fonts，不必打进 App 包 */
const SKIP_DIRS = new Set([
  path.join(root, 'assets', 'fonts'),
]);

function shouldSkip(srcPath) {
  const norm = path.resolve(srcPath);
  for (const skip of SKIP_DIRS) {
    if (norm === skip || norm.startsWith(skip + path.sep)) return true;
  }
  return false;
}

function rmDir(p) {
  if (!fs.existsSync(p)) return;
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, ent.name);
    if (ent.isDirectory()) rmDir(fp);
    else fs.unlinkSync(fp);
  }
  fs.rmdirSync(p);
}

function copyFileRetry(src, dest, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      fs.copyFileSync(src, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (e?.code !== 'EBUSY' && e?.code !== 'EPERM') throw e;
      const wait = 80 * (i + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  throw lastErr;
}

function copyDir(src, dest) {
  if (shouldSkip(src)) {
    console.warn('[prepare-www] skip', path.relative(root, src));
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (shouldSkip(s)) {
      console.warn('[prepare-www] skip', path.relative(root, s));
      continue;
    }
    if (ent.isDirectory()) copyDir(s, d);
    else copyFileRetry(s, d);
  }
}

if (fs.existsSync(www)) rmDir(www);
fs.mkdirSync(www, { recursive: true });

for (const name of COPY) {
  const src = path.join(root, name);
  if (!fs.existsSync(src)) {
    console.warn('[prepare-www] skip missing', name);
    continue;
  }
  const dest = path.join(www, name);
  if (fs.statSync(src).isDirectory()) copyDir(src, dest);
  else copyFileRetry(src, dest);
}

console.log('[prepare-www] synced frontend -> www/');

/**
 * 统一找本机 ffmpeg：项目自带 bin > ffmpeg-static > PATH。
 * 声纹 / 聊天语音转码都走这里，避免系统没装 ffmpeg 时 WebM 解不了。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOCAL_BINS = [
  path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  path.join(process.env.TEMP || '', 'nian-ffmpeg', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
];

function looksLikeFfmpeg(bin) {
  if (!bin) return false;
  const named = bin === 'ffmpeg' || bin === 'ffmpeg.exe';
  if (!named && !fs.existsSync(bin)) return false;
  try {
    const r = spawnSync(bin, ['-version'], { timeout: 8000, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    return !r.error && /ffmpeg\s+version/i.test(out);
  } catch {
    return false;
  }
}

function resolveFfmpegBin() {
  for (const p of LOCAL_BINS) {
    if (looksLikeFfmpeg(p)) return p;
  }
  try {
    const p = require('ffmpeg-static');
    if (looksLikeFfmpeg(p)) return p;
  } catch {}
  if (looksLikeFfmpeg('ffmpeg')) return 'ffmpeg';
  return 'ffmpeg';
}

function isFfmpegReady() {
  return looksLikeFfmpeg(resolveFfmpegBin());
}

module.exports = { resolveFfmpegBin, isFfmpegReady };

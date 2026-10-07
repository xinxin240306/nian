/**
 * TA 情侣相册：双方上传照片、留言；角色每月约 4–7 张。
 */
const path = require('path');
const fs = require('fs');
const db = require('./db');

function push(type, data) {
  try { require('./push').push(type, data); } catch {}
}

function boundId() {
  return require('./ta-helper').boundCharacterId();
}

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ta_album_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      url TEXT NOT NULL,
      caption TEXT DEFAULT '',
      taken_at TEXT DEFAULT '',
      location TEXT DEFAULT '',
      lat REAL,
      lng REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ta_album_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ta_album_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      photo_id INTEGER,
      kind TEXT DEFAULT 'comment',
      run_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

let _tablesReady = false;
function ready() {
  if (_tablesReady) return;
  try { ensureTables(); _tablesReady = true; } catch (e) {
    console.warn('[ta-album] ensure tables', e.message);
  }
}

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  return `${y}-${m}`;
}

function hashChar(id) {
  const n = Number(id) || 0;
  return Math.abs((n * 2654435761) >>> 0);
}

/** 本月目标张数：稳定在 4–7 */
function monthTarget(characterId, key = monthKey()) {
  const h = hashChar(characterId) ^ Number(String(key).replace(/\D/g, '') || 0);
  return 4 + (h % 4);
}

function countAiPhotosInMonth(characterId, key = monthKey()) {
  ready();
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM ta_album_photos
     WHERE character_id=? AND role='ai' AND substr(COALESCE(taken_at, created_at), 1, 7)=?`
  ).get(characterId, key);
  return Number(row?.n) || 0;
}

function snapshotForTa(characterId) {
  ready();
  const cid = Number(characterId) || 0;
  if (!cid) return { count: 0, latestUrl: '', latestAt: '' };
  const row = db.prepare(
    `SELECT COUNT(*) AS n,
            (SELECT url FROM ta_album_photos WHERE character_id=? ORDER BY id DESC LIMIT 1) AS latestUrl,
            (SELECT COALESCE(taken_at, created_at) FROM ta_album_photos WHERE character_id=? ORDER BY id DESC LIMIT 1) AS latestAt
     FROM ta_album_photos WHERE character_id=?`
  ).get(cid, cid, cid);
  return {
    count: Number(row?.n) || 0,
    latestUrl: String(row?.latestUrl || ''),
    latestAt: String(row?.latestAt || ''),
  };
}

function listPhotos(characterId, { limit = 60, beforeId = 0 } = {}) {
  ready();
  const cid = Number(characterId) || 0;
  const lim = Math.min(120, Math.max(1, Number(limit) || 60));
  const before = Number(beforeId) || 0;
  const rows = before > 0
    ? db.prepare(
      `SELECT * FROM ta_album_photos WHERE character_id=? AND id<? ORDER BY id DESC LIMIT ?`
    ).all(cid, before, lim)
    : db.prepare(
      `SELECT * FROM ta_album_photos WHERE character_id=? ORDER BY id DESC LIMIT ?`
    ).all(cid, lim);
  return rows.map(serializePhoto);
}

function getPhoto(photoId, characterId) {
  ready();
  const row = db.prepare('SELECT * FROM ta_album_photos WHERE id=?').get(photoId);
  if (!row) return null;
  if (characterId && Number(row.character_id) !== Number(characterId)) return null;
  const comments = db.prepare(
    `SELECT * FROM ta_album_comments WHERE photo_id=? ORDER BY id ASC`
  ).all(row.id).map(serializeComment);
  return { ...serializePhoto(row), comments };
}

function serializePhoto(row) {
  return {
    id: row.id,
    characterId: row.character_id,
    role: row.role,
    url: row.url,
    caption: row.caption || '',
    takenAt: row.taken_at || row.created_at || '',
    location: row.location || '',
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    createdAt: row.created_at,
  };
}

function serializeComment(row) {
  return {
    id: row.id,
    photoId: row.photo_id,
    characterId: row.character_id,
    role: row.role,
    content: row.content || '',
    createdAt: row.created_at,
  };
}

function insertPhoto({
  characterId, role, url, caption = '', takenAt = '', location = '', lat = null, lng = null,
}) {
  ready();
  const cid = Number(characterId) || 0;
  if (!cid || !url) throw new Error('缺少照片');
  const who = role === 'ai' ? 'ai' : 'user';
  const taken = String(takenAt || '').trim() || new Date().toISOString();
  const r = db.prepare(
    `INSERT INTO ta_album_photos (character_id, role, url, caption, taken_at, location, lat, lng)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    cid,
    who,
    String(url).trim(),
    String(caption || '').trim().slice(0, 200),
    taken.slice(0, 40),
    String(location || '').trim().slice(0, 80),
    Number.isFinite(Number(lat)) ? Number(lat) : null,
    Number.isFinite(Number(lng)) ? Number(lng) : null,
  );
  const photo = getPhoto(r.lastInsertRowid, cid);
  push('ta_album_updated', { characterId: cid, photoId: photo.id, action: 'photo' });
  if (who === 'user') enqueueCommentJob(cid, photo.id);
  return photo;
}

function updatePhotoMeta(photoId, characterId, patch = {}) {
  ready();
  const row = db.prepare('SELECT * FROM ta_album_photos WHERE id=?').get(photoId);
  if (!row || Number(row.character_id) !== Number(characterId)) throw new Error('照片不存在');
  const caption = patch.caption != null ? String(patch.caption).trim().slice(0, 200) : row.caption;
  const takenAt = patch.takenAt != null ? String(patch.takenAt).trim().slice(0, 40) : row.taken_at;
  const location = patch.location != null ? String(patch.location).trim().slice(0, 80) : row.location;
  const lat = patch.lat !== undefined
    ? (Number.isFinite(Number(patch.lat)) ? Number(patch.lat) : null)
    : row.lat;
  const lng = patch.lng !== undefined
    ? (Number.isFinite(Number(patch.lng)) ? Number(patch.lng) : null)
    : row.lng;
  db.prepare(
    `UPDATE ta_album_photos SET caption=?, taken_at=?, location=?, lat=?, lng=? WHERE id=?`
  ).run(caption, takenAt, location, lat, lng, photoId);
  push('ta_album_updated', { characterId: Number(characterId), photoId: Number(photoId), action: 'meta' });
  return getPhoto(photoId, characterId);
}

function deletePhoto(photoId, characterId) {
  ready();
  const row = db.prepare('SELECT * FROM ta_album_photos WHERE id=?').get(photoId);
  if (!row || Number(row.character_id) !== Number(characterId)) throw new Error('照片不存在');
  db.prepare('DELETE FROM ta_album_comments WHERE photo_id=?').run(photoId);
  db.prepare('DELETE FROM ta_album_jobs WHERE photo_id=?').run(photoId);
  db.prepare('DELETE FROM ta_album_photos WHERE id=?').run(photoId);
  push('ta_album_updated', { characterId: Number(characterId), photoId: Number(photoId), action: 'delete' });
  return { ok: true };
}

function addComment({ photoId, characterId, role, content }) {
  ready();
  const photo = db.prepare('SELECT * FROM ta_album_photos WHERE id=?').get(photoId);
  if (!photo || Number(photo.character_id) !== Number(characterId)) throw new Error('照片不存在');
  const text = String(content || '').trim().slice(0, 200);
  if (!text) throw new Error('留言不能为空');
  const who = role === 'ai' ? 'ai' : 'user';
  const r = db.prepare(
    `INSERT INTO ta_album_comments (photo_id, character_id, role, content) VALUES (?,?,?,?)`
  ).run(photoId, characterId, who, text);
  const comment = serializeComment(db.prepare('SELECT * FROM ta_album_comments WHERE id=?').get(r.lastInsertRowid));
  push('ta_album_updated', { characterId: Number(characterId), photoId: Number(photoId), action: 'comment' });
  if (who === 'user') enqueueCommentJob(characterId, photoId, 45);
  return comment;
}

function enqueueCommentJob(characterId, photoId, delaySec = null) {
  ready();
  const sec = delaySec != null
    ? delaySec
    : (40 + Math.floor(Math.random() * 120));
  const runAt = new Date(Date.now() + sec * 1000).toISOString();
  db.prepare(
    `INSERT INTO ta_album_jobs (character_id, photo_id, kind, run_at) VALUES (?,?, 'comment', ?)`
  ).run(characterId, photoId, runAt);
}

async function extractExifFromFile(filePath) {
  const out = { takenAt: '', location: '', lat: null, lng: null };
  try {
    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    if (meta.exif) {
      try {
        const exifReader = require('exif-reader');
        const exif = exifReader(meta.exif);
        const dt = exif?.Photo?.DateTimeOriginal
          || exif?.Image?.DateTime
          || exif?.exif?.DateTimeOriginal;
        if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
          out.takenAt = dt.toISOString();
        } else if (typeof dt === 'string' && dt.trim()) {
          // "2024:01:02 15:30:00"
          const m = dt.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
          if (m) {
            out.takenAt = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toISOString();
          }
        }
        const gps = exif?.GPSInfo || exif?.gps || {};
        const lat = gpsToDecimal(gps.GPSLatitude || gps.Latitude, gps.GPSLatitudeRef || gps.LatitudeRef);
        const lng = gpsToDecimal(gps.GPSLongitude || gps.Longitude, gps.GPSLongitudeRef || gps.LongitudeRef);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          out.lat = lat;
          out.lng = lng;
        }
      } catch { /* no exif-reader */ }
    }
  } catch { /* no sharp */ }
  return out;
}

function gpsToDecimal(arr, ref) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const toNum = (v) => {
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && v.numerator != null) return Number(v.numerator) / Number(v.denominator || 1);
    return Number(v);
  };
  const d = toNum(arr[0]);
  const m = toNum(arr[1]);
  const s = arr[2] != null ? toNum(arr[2]) : 0;
  if (![d, m, s].every(Number.isFinite)) return null;
  let dec = d + m / 60 + s / 3600;
  const r = String(ref || '').toUpperCase();
  if (r === 'S' || r === 'W') dec = -dec;
  return dec;
}

async function reversePlace(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  try {
    const fetch = require('node-fetch');
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=zh&zoom=16`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'nian-ta-album/1.0' },
      timeout: 8000,
    });
    if (!resp.ok) return '';
    const j = await resp.json();
    const a = j?.address || {};
    const parts = [a.suburb || a.neighbourhood || a.quarter, a.city || a.town || a.county || a.state]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    return parts.slice(0, 2).join(' · ') || String(j?.display_name || '').split(',')[0] || '';
  } catch {
    return '';
  }
}

async function generateAiComment(characterId, photoId) {
  const photo = getPhoto(photoId, characterId);
  if (!photo) return null;
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return null;
  const settings = Object.fromEntries(
    (db.prepare('SELECT key, value FROM settings').all() || []).map((r) => [r.key, r.value])
  );
  const recent = (photo.comments || []).slice(-6).map((c) =>
    `${c.role === 'user' ? '用户' : char.name}：${c.content}`
  ).join('\n');
  const { callChatAPI } = require('./api-helper');
  const { buildSystemPrompt } = require('./cron');
  let beanHint = '';
  try {
    beanHint = require('./inline-emoji-helper').buildInlineBeanPromptSection({ surface: 'memo', char }) || '';
  } catch {}
  const hint = `你们在 TA 共享相册里互相留言。对方${photo.role === 'user' ? '刚上传' : '这张'}照片。
拍摄时间：${photo.takenAt || '未知'}；地点：${photo.location || '未知'}；说明：${photo.caption || '无'}。
${recent ? `已有留言：\n${recent}\n` : ''}
写一句很短的口语留言（1 句为主，最多两短句）。可以夸、调侃、追问、感慨，按性格来。
可用小黄豆表情写成 [微笑] 这种标记。不要提相册/系统/AI。只输出留言正文。
${beanHint}`;
  const systemPrompt = buildSystemPrompt(char, settings, hint, { presetScope: 'chat' });
  let raw = await callChatAPI(settings, systemPrompt, '给这张照片留一句言', 'chat');
  raw = String(raw || '').trim().replace(/^["「]|["」]$/g, '').slice(0, 160);
  if (!raw) return null;
  try {
    raw = require('./inline-emoji-helper').sanitizeInlineBeans(raw, { char, characterId: char?.id, skipCooldown: true }) || raw;
  } catch {}
  return addComment({ photoId, characterId, role: 'ai', content: raw });
}

async function generateAiPhoto(characterId) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return null;
  const settings = Object.fromEntries(
    (db.prepare('SELECT key, value FROM settings').all() || []).map((r) => [r.key, r.value])
  );
  const { callChatAPI, generateImage } = require('./api-helper');
  const { buildSystemPrompt, getHereAndNowContext } = require('./cron');
  const here = getHereAndNowContext(char, settings);
  const hint = `你要往和用户的「TA 相册」里塞一张刚拍的照片（不是朋友圈文案）。
${here?.promptBlock || ''}
输出三行：
1) 配图：英文画面描述（可以是你的自拍/眼前风景/桌上的东西，贴合此刻地点与心情；不要写「配图：无」。风景/静物不要写路人特写或清晰人脸；自拍则只有你一人脸清晰）
2) 地点：中文短地名（街/店/家附近），与此刻一致
3) 说明：一句口语短说明，像随手写在照片下，可空成「说明：」
不要其他内容。`;
  const systemPrompt = buildSystemPrompt(char, settings, hint, { presetScope: 'chat' });
  let raw = await callChatAPI(settings, systemPrompt, '往相册放一张此刻的照片', 'chat');
  raw = String(raw || '').trim();
  if (!raw) return null;

  let scene = '';
  let location = '';
  let caption = '';
  for (const line of raw.split(/\n+/)) {
    const t = line.trim();
    const mImg = t.match(/^(?:配图|画面)\s*[:：]\s*(.+)$/i);
    const mLoc = t.match(/^(?:地点|位置)\s*[:：]\s*(.+)$/i);
    const mCap = t.match(/^(?:说明|备注|文案)\s*[:：]\s*(.*)$/i);
    if (mImg) scene = mImg[1].trim();
    else if (mLoc) location = mLoc[1].trim();
    else if (mCap) caption = mCap[1].trim();
  }
  if (!scene || /^无$|^none$/i.test(scene)) {
    scene = `${char.name || 'person'} casual phone photo, ${here?.current?.place || 'everyday life'}, natural light`;
  }
  if (!location) location = String(here?.current?.place || char.location_name || '某处').slice(0, 40);

  const isSelfieish = /self|selfie|自拍|portrait|本人出镜|我的脸/i.test(scene);
  const faceGuard = isSelfieish
    ? 'only this one person has a clear recognizable face; other people only distant out-of-focus silhouettes or backs at frame edge'
    : 'subject is scenery or object only; no clear human faces, no mid-frame stranger portrait; empty of people preferred; distant anonymous blur at edge ok';
  const prompt = `${scene}, ${faceGuard}`;

  const refs = [];
  if (isSelfieish && char.avatar) refs.push(char.avatar);
  try {
    const homeRefs = JSON.parse(char.home_refs || '[]');
    if (Array.isArray(homeRefs)) refs.push(...homeRefs.filter(Boolean).slice(0, 2));
  } catch {}
  const img = await generateImage(settings, prompt, refs[0] || null, {
    referenceImageUrls: refs.slice(0, 3),
    aspect: char.image_aspect || '3:4',
    characterId,
  });
  const url = img?.url || img?.localUrl || '';
  if (!url) throw new Error('生成照片失败');

  // 拍摄时间：此刻附近随机偏移，更像随手拍
  const skewMin = Math.floor(Math.random() * 90);
  const takenAt = new Date(Date.now() - skewMin * 60 * 1000).toISOString();

  const photo = insertPhoto({
    characterId,
    role: 'ai',
    url,
    caption: caption.slice(0, 120),
    takenAt,
    location: location.slice(0, 80),
  });
  try {
    require('./album-helper').queueAlbumSave({
      characterId,
      url,
      mediaType: 'image',
      subject: isSelfieish ? 'self' : 'other',
      description: caption || location || 'TA相册',
      source: 'ta_album',
    });
  } catch {}
  return photo;
}

async function processDueJobs() {
  ready();
  const now = new Date().toISOString();
  const jobs = db.prepare(
    `SELECT * FROM ta_album_jobs WHERE done=0 AND run_at<=? ORDER BY run_at ASC LIMIT 4`
  ).all(now);
  let n = 0;
  for (const job of jobs) {
    db.prepare('UPDATE ta_album_jobs SET done=1 WHERE id=?').run(job.id);
    try {
      if (job.kind === 'comment' && job.photo_id) {
        await generateAiComment(job.character_id, job.photo_id);
        n++;
      } else if (job.kind === 'post') {
        await generateAiPhoto(job.character_id);
        n++;
      }
    } catch (e) {
      console.warn('[ta-album] job', job.id, e.message);
    }
  }
  return n;
}

/** 每天扫一遍：本月未达目标时，按剩余天数随机补一张 */
async function maybeScheduleMonthlyPosts() {
  ready();
  const cid = boundId();
  if (!cid) return 0;
  const key = monthKey();
  const target = monthTarget(cid, key);
  const have = countAiPhotosInMonth(cid, key);
  if (have >= target) return 0;

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const day = now.getDate();
  const leftDays = Math.max(1, daysInMonth - day + 1);
  const need = target - have;
  // 今天发的概率 ≈ need/leftDays，上限 0.55
  const p = Math.min(0.55, need / leftDays);
  if (Math.random() > p) return 0;

  // 白天窗口
  const hour = now.getHours();
  if (hour < 9 || hour > 21) return 0;

  // 避免同一天连发：看今天是否已有 AI 照片
  const today = now.toISOString().slice(0, 10);
  const todayRow = db.prepare(
    `SELECT COUNT(*) AS n FROM ta_album_photos
     WHERE character_id=? AND role='ai' AND substr(COALESCE(taken_at, created_at),1,10)=?`
  ).get(cid, today);
  if ((Number(todayRow?.n) || 0) > 0) return 0;

  const delayMin = 5 + Math.floor(Math.random() * 90);
  const runAt = new Date(Date.now() + delayMin * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO ta_album_jobs (character_id, photo_id, kind, run_at) VALUES (?, NULL, 'post', ?)`
  ).run(cid, runAt);
  return 1;
}

module.exports = {
  ready,
  ensureTables,
  snapshotForTa,
  listPhotos,
  getPhoto,
  insertPhoto,
  updatePhotoMeta,
  deletePhoto,
  addComment,
  extractExifFromFile,
  reversePlace,
  processDueJobs,
  maybeScheduleMonthlyPosts,
  monthTarget,
  countAiPhotosInMonth,
  generateAiPhoto,
};

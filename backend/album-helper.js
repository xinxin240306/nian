const db = require('./db');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, 'uploads');

/** 外链落盘失败缓存：404 等视为过期，本进程内不再反复打 CDN；502 短暂冷却 */
const persistFailCache = new Map();
const PERSIST_FAIL_404_TTL_MS = 24 * 3600 * 1000;
const PERSIST_FAIL_TRANSIENT_TTL_MS = 15 * 60 * 1000;

function persistFailCacheKey(url) {
  return String(url || '').trim().split('#')[0].slice(0, 240);
}

function getCachedPersistFail(url) {
  const key = persistFailCacheKey(url);
  if (!key) return null;
  const hit = persistFailCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.until) {
    persistFailCache.delete(key);
    return null;
  }
  return hit;
}

function markPersistFail(url, status) {
  const key = persistFailCacheKey(url);
  if (!key) return;
  const code = Number(status) || 0;
  const permanent = code === 404 || code === 410 || code === 403;
  const ttl = permanent ? PERSIST_FAIL_404_TTL_MS : PERSIST_FAIL_TRANSIENT_TTL_MS;
  persistFailCache.set(key, { status: code || status || 'err', until: Date.now() + ttl, permanent });
  if (persistFailCache.size > 800) {
    const now = Date.now();
    for (const [k, v] of persistFailCache) {
      if (v.until < now) persistFailCache.delete(k);
    }
  }
}

function parseJsonArray(val, fallback = []) {
  if (Array.isArray(val)) return val;
  if (val == null || val === '') return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

function normalizeDesc(desc) {
  return String(desc || '')
    .trim()
    .replace(/^[\s「『"'【\[]+|[\s」』"'】\]]+$/g, '');
}

function normalizeAlbumSubject(subject, mediaType) {
  if (mediaType === 'voice') return 'other';
  return subject === 'self' ? 'self' : 'other';
}

function getCharacterAlbum(charId, mediaType = null, subject = null) {
  const id = parseInt(charId, 10);
  if (!id) return [];
  let sql = 'SELECT * FROM character_album WHERE character_id=?';
  const params = [id];
  if (mediaType) {
    sql += ' AND media_type=?';
    params.push(mediaType);
  }
  if (subject && ['self', 'other'].includes(subject)) {
    sql += ' AND (subject=? OR (subject IS NULL AND ?=\'other\'))';
    params.push(subject, subject);
  }
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(...params).map(mapAlbumRow);
}

function mapAlbumRow(row) {
  return {
    id: row.id,
    character_id: row.character_id,
    media_type: row.media_type,
    subject: normalizeAlbumSubject(row.subject, row.media_type),
    filename: row.filename,
    description: (row.description || '').trim() || `素材${row.id}`,
    note: String(row.note || '').trim(),
    source: String(row.source || '').trim(),
    url: `/uploads/${row.filename}`,
    created_at: row.created_at,
  };
}

/**
 * 桌宠实机抓拍写入相册（拍其他 + 角色心得）
 */
function saveRobotSnapshotToAlbum({
  characterId, filename, description = '', note = '',
} = {}) {
  const cid = parseInt(characterId, 10);
  if (!cid || !filename) return null;
  const fp = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  const dup = db.prepare(
    'SELECT id FROM character_album WHERE character_id=? AND filename=?'
  ).get(cid, filename);
  if (dup) {
    return {
      id: dup.id,
      filename,
      url: `/uploads/${filename}`,
      duplicate: true,
    };
  }
  const desc = String(description || '').trim().slice(0, 80) || '桌宠抓拍';
  const reflection = String(note || '').trim().slice(0, 500);
  const r = db.prepare(
    'INSERT INTO character_album (character_id, media_type, filename, description, subject, note, source) VALUES (?,?,?,?,?,?,?)'
  ).run(cid, 'image', filename, desc, 'other', reflection, 'robot');
  console.log('[album] robot snapshot', filename, 'char=', cid);
  return {
    id: r.lastInsertRowid,
    filename,
    url: `/uploads/${filename}`,
    description: desc,
    note: reflection,
    subject: 'other',
    source: 'robot',
  };
}

function findAlbumItem(desc, items) {
  const d = normalizeDesc(desc);
  if (!d) return null;
  let hit = items.find(e => e.description === d);
  if (hit) return hit;
  hit = items.find(e => normalizeDesc(e.description) === d);
  if (hit) return hit;
  const dl = d.toLowerCase();
  hit = items.find(e => e.description.toLowerCase() === dl);
  if (hit) return hit;
  const fname = d.replace(/^.*\//, '').split('?')[0];
  if (fname && fname.includes('.')) {
    hit = items.find(e => e.filename === fname);
    if (hit) return hit;
    if (fname.startsWith('/uploads/')) {
      hit = items.find(e => `/uploads/${e.filename}` === fname || e.url === fname);
      if (hit) return hit;
    }
  }
  return null;
}

/** 相册描述不完全一致时尽量命中；避免模型照抄提示词里的「描述」二字导致只出文字 */
function findAlbumItemFuzzy(desc, items) {
  const hit = findAlbumItem(desc, items);
  if (hit) return hit;
  if (!items?.length) return null;
  const d = normalizeDesc(desc);
  if (!d || /^(描述|文字描述|此处填描述|填描述)$/.test(d)) {
    return items.length === 1 ? items[0] : null;
  }
  let partial = items.find((e) => {
    const ed = normalizeDesc(e.description);
    return ed.includes(d) || d.includes(ed);
  });
  if (partial) return partial;
  if (items.length === 1 && d.length >= 2) return items[0];
  return null;
}

function encodeAlbumVoiceContent(url, label) {
  return JSON.stringify({ album: true, url, label: label || '' });
}

function parseAlbumVoiceContent(content) {
  const raw = String(content || '').trim();
  if (!raw.startsWith('{')) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.album && j.url) return j;
  } catch {}
  return null;
}

/** 用户聊天语音条：存进 messages.content */
function encodeUserVoiceContent({ url, duration = 1, transcript = '', voiceprint = null } = {}) {
  const payload = {
    voice: true,
    url: String(url || ''),
    duration: Math.max(1, Math.min(60, Math.round(Number(duration) || 1))),
    transcript: String(transcript || ''),
  };
  const vp = voiceprint && typeof voiceprint === 'object' ? voiceprint : null;
  const result = vp?.result || (typeof voiceprint === 'string' ? voiceprint : '');
  if (result && result !== 'none') {
    payload.voiceprint = result;
    if (typeof vp?.score === 'number' && Number.isFinite(vp.score)) {
      payload.voiceprintScore = Math.round(vp.score * 1000) / 1000;
    }
  }
  return JSON.stringify(payload);
}

function parseUserVoiceContent(content) {
  const raw = String(content || '').trim();
  if (!raw.startsWith('{')) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.voice === true && j.url) return j;
  } catch {}
  return null;
}

/** subject: self=拍自己 other=拍其他 */
const ALBUM_MARK_SPECS = [
  { type: 'image', subject: 'self', re: /\[相册自拍\]([\s\S]*?)\[\/相册自拍\]/g, re2: /\[相册自拍\]([^\]\n]+)\]/g },
  { type: 'image', subject: 'other', re: /\[相册图(?:片)?\]([\s\S]*?)\[\/相册图(?:片)?\]/g, re2: /\[相册图(?:片)?\]([^\]\n]+)\]/g },
  { type: 'video', subject: 'self', re: /\[相册自拍视频\]([\s\S]*?)\[\/相册自拍视频\]/g, re2: /\[相册自拍视频\]([^\]\n]+)\]/g },
  { type: 'video', subject: 'other', re: /\[相册视频\]([\s\S]*?)\[\/相册视频\]/g, re2: /\[相册视频\]([^\]\n]+)\]/g },
  { type: 'voice', subject: 'other', re: /\[相册语音\]([\s\S]*?)\[\/相册语音\]/g, re2: /\[相册语音\]([^\]\n]+)\]/g },
];

function collectAlbumMarkMatches(text) {
  const matches = [];
  for (const spec of ALBUM_MARK_SPECS) {
    for (const re of [spec.re, spec.re2]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        matches.push({
          index: match.index,
          len: match[0].length,
          desc: match[1],
          mediaType: spec.type,
          subject: spec.subject,
        });
      }
    }
  }
  matches.sort((a, b) => a.index - b.index);
  const deduped = [];
  const seen = new Set();
  for (const m of matches) {
    const key = `${m.index}:${m.len}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }
  return deduped;
}

function stripAlbumMarkersFromText(text) {
  let t = String(text || '');
  for (const spec of ALBUM_MARK_SPECS) {
    t = t.replace(spec.re, '');
    t = t.replace(spec.re2, '');
  }
  // 模型漏写开头或只写了闭合标签时的残留
  t = t.replace(/\[\/相册[^\]]+\]/g, '');
  t = t.replace(/\[相册[^\]]+\]/g, '');
  return t.trim();
}

/** 从相册自拍标记提取场景（相册未命中时改走自拍 API） */
function extractAlbumSelfieSceneForApi(text) {
  const matches = collectAlbumMarkMatches(text).filter((m) => m.mediaType === 'image' && m.subject === 'self');
  if (!matches.length) return undefined;
  const scene = normalizeDesc(matches[matches.length - 1].desc);
  if (!scene || /^(描述|文字描述|此处填描述|填描述)$/.test(scene)) return '';
  return scene.slice(0, 300);
}

function hasAlbumSelfieMarker(text) {
  return /\[相册自拍\]/.test(String(text || ''));
}

function listAlbumDescriptions(items) {
  return items.map(i => `「${i.description}」`).join('、');
}

function buildAlbumPromptSection(char, settings = {}) {
  // 相册仅用于保存生图/视频结果，不再注入「从相册发图」指令，避免模型写 [相册自拍] 标记
  void char;
  void settings;
  return '';
}

/** 去掉误写的相册标记，不从中取图（发图全靠生图 API） */
function stripAlbumMarkersFromSegments(segments) {
  if (!segments?.length) return segments;
  const out = [];
  for (const seg of segments) {
    if (seg.type !== 'text') {
      out.push(seg);
      continue;
    }
    const cleaned = stripAlbumMarkersFromText(seg.content);
    if (cleaned) out.push({ ...seg, content: cleaned });
  }
  return out.length ? out : segments;
}

function applyAlbumMarkersToSegments(segments, char) {
  if (!segments?.length || !char?.id) return segments;
  const allItems = getCharacterAlbum(char.id);
  if (!allItems.length) return segments;

  const out = [];
  for (const seg of segments) {
    if (seg.type !== 'text') {
      out.push(seg);
      continue;
    }
    const text = String(seg.content || '');
    const matches = collectAlbumMarkMatches(text);
    if (!matches.length) {
      out.push(seg);
      continue;
    }
    let lastIndex = 0;
    const used = new Set();
    for (const m of matches) {
      if (used.has(m.index) || m.index < lastIndex) continue;
      used.add(m.index);
      const before = text.slice(lastIndex, m.index).trim();
      if (before) out.push({ type: 'text', content: before });
      const pool = allItems.filter(i =>
        i.media_type === m.mediaType && normalizeAlbumSubject(i.subject, i.media_type) === m.subject
      );
      const found = findAlbumItemFuzzy(m.desc, pool);
      if (found) {
        if (m.mediaType === 'voice') {
          out.push({
            type: 'voice',
            content: encodeAlbumVoiceContent(found.url, found.description),
            description: found.description,
            album: true,
            albumSubject: 'other',
          });
        } else {
          out.push({
            type: m.mediaType,
            content: found.url,
            description: found.description,
            album: true,
            albumSubject: found.subject,
          });
        }
      } else {
        const leftover = normalizeDesc(m.desc);
        if (leftover && !/^(描述|文字描述|此处填描述|填描述)$/.test(leftover)) {
          out.push({ type: 'text', content: leftover });
        }
      }
      lastIndex = m.index + m.len;
    }
    const after = text.slice(lastIndex).trim();
    if (after) out.push({ type: 'text', content: after });
  }
  return out.length ? out : segments;
}

/** 相册已发出的类型 → 跳过对应 API 配图/生图 */
function getAlbumAttachFlags(segments) {
  const flags = { selfieImage: false, otherImage: false, selfieVideo: false, otherVideo: false };
  for (const seg of segments || []) {
    if (!seg?.album) continue;
    if (seg.type === 'image' && seg.albumSubject === 'self') flags.selfieImage = true;
    if (seg.type === 'image' && seg.albumSubject === 'other') flags.otherImage = true;
    if (seg.type === 'video' && seg.albumSubject === 'self') flags.selfieVideo = true;
    if (seg.type === 'video' && seg.albumSubject === 'other') flags.otherVideo = true;
  }
  return flags;
}

function formatAlbumMessageForAi(msg) {
  const type = msg?.type || 'text';
  const content = String(msg?.content || '').trim();
  if (type === 'voice') {
    try {
      const meta = typeof msg?.media_meta === 'string'
        ? JSON.parse(msg.media_meta || '{}')
        : (msg?.media_meta || {});
      if (meta.robotMic) return '[你通过桌上小机听到的一段声音]';
    } catch {}
    const album = parseAlbumVoiceContent(content);
    if (album) return `[相册语音]「${album.label || '语音'}」`;
    const userVoice = parseUserVoiceContent(content);
    if (userVoice) {
      const t = String(userVoice.transcript || '').trim();
      return t ? `[用户语音] ${t}` : '[用户发来一段语音]';
    }
  }
  if (type === 'image' || type === 'video') {
    const fname = content.replace(/^.*\//, '').split('?')[0];
    const row = db.prepare('SELECT description, media_type, subject FROM character_album WHERE filename=? LIMIT 1').get(fname);
    if (!row?.description) {
      return type === 'image' ? '[相册图]' : '[相册视频]';
    }
    const subj = normalizeAlbumSubject(row.subject, row.media_type);
    if (row.media_type === 'video') {
      return subj === 'self'
        ? `[相册自拍视频]「${row.description}」`
        : `[相册视频]「${row.description}」`;
    }
    return subj === 'self'
      ? `[相册自拍]「${row.description}」`
      : `[相册图]「${row.description}」`;
  }
  return null;
}

/** API 图生视频失败时，从相册随机取一条视频（优先自拍视频） */
function pickAlbumVideoFallback(charId, { preferSelf = true } = {}) {
  const self = getCharacterAlbum(charId, 'video', 'self');
  const other = getCharacterAlbum(charId, 'video', 'other');
  const pool = preferSelf
    ? (self.length ? self : other)
    : (other.length ? other : self);
  if (!pool.length) return null;
  const item = pool[Math.floor(Math.random() * pool.length)];
  return item?.url || null;
}

function isPlaceholderMediaUrl(url) {
  const s = String(url || '').trim();
  if (!s) return true;
  return s.startsWith('__pending_')
    || s.startsWith('__selfie_failed__')
    || s.startsWith('__video_failed__')
    || s.startsWith('data:text')
    || s.startsWith('{');
}

function isStockCdnUrl(url) {
  return /pexels\.com|unsplash\.com|images\.unsplash/i.test(String(url || ''));
}

function filenameFromMediaUrl(url) {
  const s = String(url || '').trim().split('#')[0];
  if (!s || s.startsWith('data:')) return '';
  try {
    const pathname = /^https?:\/\//i.test(s) ? new URL(s).pathname : s.split('?')[0];
    const i = pathname.indexOf('/uploads/');
    if (i >= 0) {
      return decodeURIComponent(pathname.slice(i + '/uploads/'.length).replace(/^\/+/, ''));
    }
    const base = pathname.replace(/^.*\//, '');
    if (/\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(base)) return base;
  } catch {}
  return '';
}

async function persistRemoteMediaToUploads(url, mediaType) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s) && getCachedPersistFail(s)) return '';
  try {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    let buf;
    let ext = mediaType === 'video' ? 'mp4' : 'jpg';
    if (s.startsWith('data:image/')) {
      // /s：允许 base64 跨行（部分中转站会折行）
      const m = s.match(/^data:image\/([\w+.-]+);base64,(.+)$/is);
      if (!m) return '';
      ext = String(m[1] || 'jpeg').toLowerCase().replace('jpeg', 'jpg').split('+')[0] || 'jpg';
      if (!/^(jpg|png|webp|gif)$/.test(ext)) ext = 'jpg';
      buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    } else if (s.startsWith('data:video/')) {
      const m = s.match(/^data:video\/([\w+.-]+);base64,(.+)$/is);
      if (!m) return '';
      ext = String(m[1] || 'mp4').toLowerCase().split('+')[0] || 'mp4';
      if (!/^(mp4|webm|mov)$/.test(ext)) ext = 'mp4';
      buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    } else if (/^https?:\/\//i.test(s)) {
      const resp = await fetch(s, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NianAlbum/1.0)',
          Accept: mediaType === 'video' ? 'video/*,*/*' : 'image/*,*/*',
        },
      });
      if (!resp.ok) {
        markPersistFail(s, resp.status);
        // TinySnow 临时图链过期很常见：只打一行，避免和 persist failed 叠成刷屏
        const short = s.slice(0, 100);
        if (resp.status === 404 || resp.status === 410) {
          console.warn('[album] CDN 图已失效，跳过入库', resp.status, short);
        } else {
          console.warn('[album] persist HTTP', resp.status, short);
        }
        return '';
      }
      buf = Buffer.from(await resp.arrayBuffer());
      const ct = String(resp.headers.get('content-type') || '');
      if (ct.includes('png')) ext = 'png';
      else if (ct.includes('webp')) ext = 'webp';
      else if (ct.includes('gif')) ext = 'gif';
      else if (ct.includes('webm')) ext = 'webm';
      else if (ct.includes('mp4') || mediaType === 'video') ext = 'mp4';
      else if (/\.png(\?|$)/i.test(s)) ext = 'png';
      else if (/\.webp(\?|$)/i.test(s)) ext = 'webp';
      else if (/\.(jpe?g)(\?|$)/i.test(s)) ext = 'jpg';
      else if (/\.mp4(\?|$)/i.test(s)) ext = 'mp4';
    } else {
      return '';
    }
    if (!buf?.length) return '';
    const filename = `album_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
    return filename;
  } catch (e) {
    markPersistFail(url, 'err');
    console.warn('[album] persist remote', e.message, String(url || '').slice(0, 100));
    return '';
  }
}

/**
 * 把外链 / dataURI 落成本地 /uploads/...；已是本地且文件存在则原样返回。
 * 图库 CDN（Unsplash/Pexels）返回空字符串，不进相册。
 */
async function localizeMediaToUploads(url, mediaType = 'image') {
  const s = String(url || '').trim();
  if (!s || isPlaceholderMediaUrl(s)) return '';
  if (isStockCdnUrl(s)) return '';
  const type = mediaType === 'video' ? 'video' : 'image';
  const existing = filenameFromMediaUrl(s);
  if (existing) {
    const fp = path.join(UPLOADS_DIR, existing);
    if (fs.existsSync(fp)) return `/uploads/${existing}`;
  }
  if (s.startsWith('/uploads/')) return '';
  const filename = await persistRemoteMediaToUploads(s, type);
  return filename ? `/uploads/${filename}` : '';
}

function defaultAlbumDesc(subject, mediaType, extra = '') {
  const now = new Date();
  const stamp = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const hint = String(extra || '').replace(/\s+/g, ' ').trim().slice(0, 36);
  if (mediaType === 'video') {
    return hint
      ? `${subject === 'self' ? '自拍视频' : '视频'} · ${hint}`
      : `${subject === 'self' ? '自拍视频' : '视频'} · ${stamp}`;
  }
  return hint
    ? `${subject === 'self' ? '自拍' : '配图'} · ${hint}`
    : `${subject === 'self' ? '自拍' : '配图'} · ${stamp}`;
}

/**
 * 角色新生成的图/视频写入相册。已存在同文件则跳过。失败不影响主流程。
 */
async function saveGeneratedMediaToAlbum({
  characterId, url, mediaType = 'image', subject = 'other', description = '',
} = {}) {
  const cid = parseInt(characterId, 10);
  if (!cid || !url) return null;
  if (isPlaceholderMediaUrl(url)) {
    console.warn('[album] skip placeholder', String(url).slice(0, 60));
    return null;
  }
  if (isStockCdnUrl(url)) {
    console.warn('[album] skip stock CDN', String(url).slice(0, 80));
    return null;
  }
  const type = mediaType === 'video' ? 'video' : mediaType === 'voice' ? 'voice' : 'image';
  const subj = normalizeAlbumSubject(subject, type);

  // 外链先落本地，保证相册有稳定文件（只尝试一次，避免 404/502 双倍打 CDN）
  let localUrl = String(url).trim();
  const needLocalize = !localUrl.startsWith('/uploads/')
    || !fs.existsSync(path.join(UPLOADS_DIR, filenameFromMediaUrl(localUrl) || ''));
  if (needLocalize) {
    if (getCachedPersistFail(localUrl)) return null;
    const localized = await localizeMediaToUploads(localUrl, type);
    if (localized) localUrl = localized;
  }

  let filename = filenameFromMediaUrl(localUrl);
  const srcPath = filename ? path.join(UPLOADS_DIR, filename) : '';
  if ((!filename || !fs.existsSync(srcPath)) && localUrl !== String(url).trim() && localUrl.startsWith('/uploads/')) {
    // localize 已成功改写成本地路径但文件名解析失败时，再按本地路径试一次
    filename = filenameFromMediaUrl(localUrl);
  }
  if (!filename || !fs.existsSync(path.join(UPLOADS_DIR, filename || ''))) {
    // 仍是外链且尚未请求过：补一次；已在 localize 里失败的不要再 fetch
    if (/^https?:\/\//i.test(localUrl) && !getCachedPersistFail(localUrl) && localUrl === String(url).trim() && !needLocalize) {
      filename = await persistRemoteMediaToUploads(localUrl, type);
    } else if (!filename) {
      return null;
    }
  }
  if (!filename || !fs.existsSync(path.join(UPLOADS_DIR, filename))) {
    return null;
  }

  const dup = db.prepare(
    'SELECT id FROM character_album WHERE character_id=? AND filename=?'
  ).get(cid, filename);
  if (dup) return dup;

  const desc = String(description || '').trim().slice(0, 80) || defaultAlbumDesc(subj, type);
  const r = db.prepare(
    'INSERT INTO character_album (character_id, media_type, filename, description, subject) VALUES (?,?,?,?,?)'
  ).run(cid, type, filename, desc, subj);
  console.log('[album] auto-save', type, subj, filename, 'char=', cid);
  return { id: r.lastInsertRowid, filename, url: `/uploads/${filename}` };
}

function queueAlbumSave(opts) {
  Promise.resolve(saveGeneratedMediaToAlbum(opts)).catch((e) => {
    console.warn('[album] auto-save', e.message);
  });
}

/**
 * 把聊天里已有的本地/可下载生成图视频补进相册（幂等，按 filename 去重）。
 * 本地 /uploads 文件同步入库；外链异步下载。
 */
function backfillAlbumFromChatMedia(charId) {
  const cid = parseInt(charId, 10);
  if (!cid) return 0;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, type, content, media_meta FROM messages
      WHERE character_id=? AND role='assistant' AND type IN ('image','video')
      ORDER BY id DESC LIMIT 200
    `).all(cid);
  } catch (e) {
    console.warn('[album] backfill query', e.message);
    return 0;
  }
  const insert = db.prepare(
    'INSERT INTO character_album (character_id, media_type, filename, description, subject) VALUES (?,?,?,?,?)'
  );
  let added = 0;
  let queued = 0;
  for (const row of rows) {
    const content = String(row.content || '').trim();
    if (!content || isPlaceholderMediaUrl(content) || isStockCdnUrl(content)) continue;
    let subject = row.type === 'video' ? 'self' : 'other';
    let descHint = '';
    try {
      const meta = row.media_meta ? JSON.parse(row.media_meta) : null;
      if (meta?.kind === 'selfie') subject = 'self';
      else if (meta?.kind === 'chat_image') subject = 'other';
      descHint = String(meta?.sceneQuery || meta?.presetQuery || '').trim().slice(0, 40);
    } catch {}
    const type = row.type === 'video' ? 'video' : 'image';
    const desc = descHint || defaultAlbumDesc(subject, type, `聊天#${row.id}`);
    const fname = filenameFromMediaUrl(content);
    if (fname && fs.existsSync(path.join(UPLOADS_DIR, fname))) {
      const dup = db.prepare(
        'SELECT id FROM character_album WHERE character_id=? AND filename=?'
      ).get(cid, fname);
      if (dup) continue;
      try {
        insert.run(cid, type, fname, desc, subject);
        added += 1;
      } catch (e) {
        console.warn('[album] backfill insert', e.message);
      }
      continue;
    }
    // 外链：异步落盘入库；已知失效的 TinySnow 临时链不再排队刷日志
    if (getCachedPersistFail(content)) continue;
    queueAlbumSave({
      characterId: cid,
      url: content,
      mediaType: type,
      subject,
      description: desc,
    });
    queued += 1;
  }
  if (added || queued) {
    console.log('[album] backfill char=', cid, 'added=', added, 'queued=', queued);
  }
  return added + queued;
}

module.exports = {
  getCharacterAlbum,
  findAlbumItem,
  findAlbumItemFuzzy,
  extractAlbumSelfieSceneForApi,
  hasAlbumSelfieMarker,
  normalizeAlbumSubject,
  encodeAlbumVoiceContent,
  parseAlbumVoiceContent,
  encodeUserVoiceContent,
  parseUserVoiceContent,
  buildAlbumPromptSection,
  stripAlbumMarkersFromSegments,
  applyAlbumMarkersToSegments,
  getAlbumAttachFlags,
  stripAlbumMarkersFromText,
  formatAlbumMessageForAi,
  pickAlbumVideoFallback,
  saveGeneratedMediaToAlbum,
  queueAlbumSave,
  localizeMediaToUploads,
  backfillAlbumFromChatMedia,
  mapAlbumRow,
  saveRobotSnapshotToAlbum,
};

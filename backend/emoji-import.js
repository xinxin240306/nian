/** 表情包 JSON / ZIP 包导入 */

const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { beginSaveBatch, endSaveBatch } = require('./db');

const IMAGE_EXT = /\.(gif|png|jpe?g|webp|apng|bmp)$/i;

function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('gif')) return '.gif';
  if (m.includes('webp')) return '.webp';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('bmp')) return '.bmp';
  return '.png';
}

function uniqueFilename(ext, uploadsPath) {
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
  let name;
  do {
    name = `emoji-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`;
  } while (fs.existsSync(path.join(uploadsPath, name)));
  return name;
}

function detectExtFromBuffer(buf) {
  if (!buf || buf.length < 4) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return '.webp';
  return '.png';
}

/** 纯 base64 图片串（无 data: 前缀） */
function looksLikeBase64Image(s) {
  const t = String(s || '').trim().replace(/\s/g, '');
  if (t.length < 64) return false;
  if (t.startsWith('data:image/')) return true;
  if (!/^[A-Za-z0-9+/=]+$/.test(t)) return false;
  try {
    const buf = Buffer.from(t.slice(0, Math.min(t.length, 256)), 'base64');
    return buf.length >= 16;
  } catch {
    return false;
  }
}

function parseBase64Image(input) {
  let mime = 'image/png';
  let b64 = String(input || '').trim();
  if (!b64) return { buffer: Buffer.alloc(0), ext: '.png' };
  const m = b64.match(/^data:(image\/[\w+.-]+);base64,(.+)$/is);
  if (m) {
    mime = m[1];
    b64 = m[2];
  }
  b64 = b64.replace(/\s/g, '');
  const buffer = Buffer.from(b64, 'base64');
  const ext = m ? mimeToExt(mime) : detectExtFromBuffer(buffer);
  return { buffer, ext };
}

const DESC_KEYS = [
  'description', 'desc', 'name', 'label', 'title', 'text', 'remark', 'note',
  '备注', '描述', '说明', 'caption', 'word', 'expression', 'keyword', 'tag',
  'meaning', 'mean', 'alt', 'emoji', 'title_zh', 'word_cn',
];
const B64_KEYS = [
  'data', 'base64', 'image', 'img', 'content', 'blob', 'b64', 'value', 'payload',
  '图片', '内容', 'pic', 'picture', 'sticker', 'emoji_data', 'imageData', 'image_data',
];
const PACK_META_KEYS = new Set([
  'name', 'category', 'title', 'packName', 'pack_name', 'version', 'id', 'type',
  'author', 'created_at', 'createdAt',
]);

function isDescFieldKey(key) {
  return DESC_KEYS.includes(key) || /备注|描述|说明|名称|name|desc|title|text|remark|note/i.test(key);
}

function isB64FieldKey(key) {
  return B64_KEYS.includes(key) || /image|base64|data|content|blob|b64|pic|图片|内容/i.test(key);
}

function looksLikeStickerItem(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const hasDesc = DESC_KEYS.some(k => obj[k] != null && String(obj[k]).trim());
  const hasImg = B64_KEYS.some(k => obj[k] != null && typeof obj[k] === 'string' && obj[k].length > 20)
    || Object.values(obj).some(v => typeof v === 'string' && looksLikeBase64Image(v));
  return !!(hasDesc || obj.filename || obj.file || obj.url || hasImg);
}

/** { "开心": "base64...", "难过": "base64..." } 键即描述 */
function packFromDescKeyedObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const entries = Object.entries(obj).filter(([k, v]) => {
    if (PACK_META_KEYS.has(k)) return false;
    return typeof v === 'string' && looksLikeBase64Image(v);
  });
  const nonMetaCount = Object.keys(obj).filter(k => !PACK_META_KEYS.has(k)).length;
  if (entries.length >= 1 && entries.length === nonMetaCount) {
    return entries.map(([desc, data]) => ({ description: desc, data }));
  }
  return null;
}

/** { descriptions: [...], images: [...] } 双数组对齐 */
function packFromPairedArrays(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const descKeys = ['descriptions', 'descs', 'names', 'labels', 'titles', 'texts', 'remarks', 'notes', 'tags', 'keywords', '备注', '描述', '说明'];
  const imgKeys = ['images', 'data', 'datas', 'base64', 'base64s', 'pics', 'pictures', 'files', 'stickers', 'emojis', 'b64', '图片', '内容', 'list'];
  for (const dk of descKeys) {
    if (!Array.isArray(obj[dk])) continue;
    for (const ik of imgKeys) {
      if (!Array.isArray(obj[ik])) continue;
      const n = Math.min(obj[dk].length, obj[ik].length);
      if (n < 1) continue;
      return Array.from({ length: n }, (_, i) => ({
        description: String(obj[dk][i] ?? '').trim() || `表情${i + 1}`,
        data: obj[ik][i],
      }));
    }
  }
  return null;
}

/** [["开心","base64..."], ["难过","base64..."]] */
function packFromTupleArray(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  if (!Array.isArray(arr[0]) || arr[0].length < 2) return null;
  const stickers = arr.map((row, i) => {
    const desc = String(row[0] ?? '').trim();
    const data = row[1];
    if (typeof data === 'string' && looksLikeBase64Image(data)) {
      return { description: desc || `表情${i + 1}`, data };
    }
    return null;
  }).filter(Boolean);
  return stickers.length ? stickers : null;
}

function extractDescAndData(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let desc = '';
  for (const k of Object.keys(obj)) {
    if (!isDescFieldKey(k)) continue;
    const v = String(obj[k] ?? '').trim();
    if (v && !looksLikeBase64Image(v)) { desc = v; break; }
  }
  if (!desc) {
    for (const k of DESC_KEYS) {
      const v = String(obj[k] ?? '').trim();
      if (v && !looksLikeBase64Image(v)) { desc = v; break; }
    }
  }
  let data = '';
  for (const k of Object.keys(obj)) {
    if (!isB64FieldKey(k)) continue;
    const v = obj[k];
    if (typeof v === 'string' && looksLikeBase64Image(v)) { data = v; break; }
  }
  if (!data) {
    for (const [, v] of Object.entries(obj)) {
      if (typeof v === 'string' && looksLikeBase64Image(v)) { data = v; break; }
    }
  }
  if (!data) return null;
  return { description: desc, data, ...obj };
}

function parseDescBase64Line(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  for (const sep of ['||', '|', '\t', '----', ' ::: ', ':::', ' , ']) {
    const idx = s.indexOf(sep);
    if (idx <= 0) continue;
    const desc = s.slice(0, idx).trim();
    const data = s.slice(idx + sep.length).trim();
    if (desc && looksLikeBase64Image(data)) return { description: desc, data };
  }
  // 描述: base64（仅当 base64 足够长）
  const colon = s.match(/^(.{1,30}?)[：:]\s*(.+)$/);
  if (colon && looksLikeBase64Image(colon[2].trim())) {
    return { description: colon[1].trim(), data: colon[2].trim() };
  }
  return null;
}

function findStickerArray(obj, depth = 0) {
  if (!obj || depth > 4) return null;
  if (Array.isArray(obj)) {
    if (!obj.length) return null;
    if (typeof obj[0] === 'string') return obj;
    if (typeof obj[0] === 'object') return obj;
    return null;
  }
  if (typeof obj !== 'object') return null;

  const preferred = [
    'stickers', 'emojis', 'emoji_stickers', 'items', 'list', 'images', 'data',
    'sticker', 'records', 'files', 'pics', 'pictures', 'values',
  ];
  for (const key of preferred) {
    if (Array.isArray(obj[key]) && obj[key].length) return obj[key];
  }

  // { "0": "base64...", "1": "base64..." }
  const numKeys = Object.keys(obj).filter(k => /^\d+$/.test(k));
  if (numKeys.length >= 1 && numKeys.length === Object.keys(obj).length) {
    const arr = numKeys.sort((a, b) => Number(a) - Number(b)).map(k => obj[k]);
    if (typeof arr[0] === 'string' || typeof arr[0] === 'object') return arr;
  }

  // 对象里全是 base64 字符串值
  const b64Values = Object.values(obj).filter(v => typeof v === 'string' && looksLikeBase64Image(v));
  if (b64Values.length >= 1 && b64Values.length === Object.values(obj).filter(v => typeof v === 'string').length) {
    return b64Values;
  }

  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key]) && obj[key].length) {
      if (typeof obj[key][0] === 'string' || looksLikeStickerItem(obj[key][0])) return obj[key];
    }
  }

  for (const key of ['pack', 'package', 'sticker_pack', 'emoji_pack', 'data', 'result', 'body', 'payload']) {
    if (obj[key] && typeof obj[key] === 'object') {
      const nested = findStickerArray(obj[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function parseRawBase64Pack(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length >= 1) {
    const withDesc = lines.map(parseDescBase64Line).filter(Boolean);
    if (withDesc.length >= 1 && withDesc.length === lines.length) {
      return { name: '', stickers: withDesc };
    }
  }

  if (looksLikeBase64Image(trimmed)) {
    return { name: '', stickers: [trimmed], rawBase64: true };
  }
  const b64Lines = lines.filter(l => looksLikeBase64Image(l));
  if (b64Lines.length) return { name: '', stickers: b64Lines, rawBase64: true };
  return null;
}

function coerceStickerItem(item, index) {
  if (typeof item === 'string') {
    if (!looksLikeBase64Image(item)) return null;
    return { description: `表情${index + 1}`, data: item };
  }
  if (!item || typeof item !== 'object') return null;

  const extracted = extractDescAndData(item);
  if (extracted) {
    if (!extracted.description) extracted.description = `表情${index + 1}`;
    return extracted;
  }

  const b64Keys = Object.keys(item).filter(k => typeof item[k] === 'string' && looksLikeBase64Image(item[k]));
  const hasMeta = DESC_KEYS.some(k => item[k] != null && String(item[k]).trim() && !looksLikeBase64Image(String(item[k])));
  if (!hasMeta && b64Keys.length === 1) {
    return { description: `表情${index + 1}`, data: item[b64Keys[0]] };
  }
  return item;
}

function normalizePack(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return parseRawBase64Pack(raw);
  }
  if (Array.isArray(raw)) {
    const tuples = packFromTupleArray(raw);
    if (tuples) return { name: '', stickers: tuples };
    if (raw.length && typeof raw[0] === 'string') {
      return { name: '', stickers: raw, rawBase64: true };
    }
    return { name: '', stickers: raw };
  }

  if (typeof raw === 'object') {
    // 念 全量导出 / 其它备份格式
    if (Array.isArray(raw.emojis) && raw.emojis[0]?.filename && raw.emojis[0]?.description !== undefined) {
      return {
        name: String(raw.name || raw.category || '').trim(),
        stickers: raw.emojis,
        directRecords: true,
      };
    }
    if (Array.isArray(raw.emoji_stickers)) {
      return {
        name: String(raw.name || '').trim(),
        stickers: raw.emoji_stickers,
        directRecords: true,
      };
    }

    const paired = packFromPairedArrays(raw);
    if (paired) {
      return {
        name: String(raw.name || raw.category || raw.title || '').trim(),
        stickers: paired,
      };
    }

    const descKeyed = packFromDescKeyedObject(raw);
    if (descKeyed) {
      return {
        name: String(raw.name || raw.category || raw.title || '').trim(),
        stickers: descKeyed,
      };
    }

    const stickers = findStickerArray(raw);
    if (stickers) {
      return {
        name: String(raw.name || raw.category || raw.title || raw.packName || raw.pack_name || '').trim(),
        stickers,
        rawBase64: typeof stickers[0] === 'string',
      };
    }
  }
  return null;
}

function resolveDescription(item, filenameRef = '', index = 0) {
  if (typeof item === 'string') return `表情${index + 1}`.slice(0, 30);
  const fromTags = Array.isArray(item.tags) ? item.tags[0]
    : Array.isArray(item.keywords) ? item.keywords[0] : '';
  let desc = '';
  for (const k of DESC_KEYS) {
    const v = item[k];
    if (v != null && String(v).trim() && !looksLikeBase64Image(String(v))) {
      desc = String(v).trim();
      break;
    }
  }
  if (!desc) {
    desc = String(
      item.meaning || item.caption || fromTags || ''
    ).trim();
  }

  if (!desc && filenameRef) {
    const base = filenameRef.split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
    desc = base.replace(/[_-]+/g, ' ').trim();
  }
  if (!desc && item.id != null) desc = String(item.id);
  if (!desc) desc = `表情${index + 1}`;
  return desc.slice(0, 30);
}

function resolveImageFields(item) {
  if (typeof item === 'string' && looksLikeBase64Image(item)) {
    return { type: 'base64', value: item };
  }
  const dataFields = [...B64_KEYS, 'url', 'src', 'link', 'imageUrl', 'image_url', 'thumb', 'thumbnail', 'uri'];
  for (const k of dataFields) {
    const v = item[k];
    if (v && typeof v === 'string' && (looksLikeBase64Image(v) || v.length > 20 && k !== 'uri' && !/^https?:\/\//i.test(v))) {
      if (looksLikeBase64Image(v) || ['data', 'base64', 'image', 'img', 'content', 'blob', 'b64'].includes(k)) {
        return { type: looksLikeBase64Image(v) ? 'base64' : 'base64', value: v };
      }
    }
    if (v && typeof v === 'string' && /^https?:\/\//i.test(v)) return { type: 'url', value: v.trim() };
  }
  const urlFields = ['url', 'src', 'link', 'imageUrl', 'image_url', 'thumb', 'thumbnail', 'uri'];
  for (const k of urlFields) {
    const v = item[k];
    if (v && typeof v === 'string') return { type: 'url', value: v.trim() };
  }
  const fileFields = ['filename', 'file', 'path', 'fileName', 'file_name', 'imagePath', 'image_path'];
  for (const k of fileFields) {
    const v = item[k];
    if (v && typeof v === 'string') return { type: 'file', value: v.trim() };
  }
  return null;
}

function pickManifestJson(files) {
  const names = ['pack.json', 'emoji.json', 'manifest.json', 'stickers.json', 'index.json', 'pack.txt', 'emoji.txt'];
  for (const n of names) {
    const hit = files.find(f => {
      const base = f.name.split(/[/\\]/).pop().toLowerCase();
      return base === n || f.name.toLowerCase().endsWith('/' + n);
    });
    if (hit) return hit;
  }
  return files.find(f => {
    const base = f.name.split(/[/\\]/).pop().toLowerCase();
    return (base.endsWith('.json') || base.endsWith('.txt')) && !f.name.includes('__MACOSX');
  });
}

function saveBuffer(uploadsPath, buffer, extHint) {
  if (!buffer?.length) throw new Error('图片数据为空');
  let ext = '.png';
  if (extHint && IMAGE_EXT.test(extHint)) {
    ext = path.extname(extHint).toLowerCase();
  } else if (typeof extHint === 'string' && extHint.startsWith('.')) {
    ext = extHint;
  }
  const filename = uniqueFilename(ext, uploadsPath);
  fs.writeFileSync(path.join(uploadsPath, filename), buffer);
  return filename;
}

function lookupFile(fileMap, ref) {
  if (!ref) return null;
  const raw = String(ref).trim();
  const base = raw.split(/[/\\]/).pop().toLowerCase();
  return fileMap.get(raw.toLowerCase())
    || fileMap.get(base)
    || fileMap.get(decodeURIComponent(base));
}

async function loadImageFromRef(ref, fileMap, uploadsPath) {
  if (typeof ref === 'string' && looksLikeBase64Image(ref)) {
    const parsed = parseBase64Image(ref);
    if (!parsed.buffer.length) throw new Error('base64 解码失败或为空');
    return saveBuffer(uploadsPath, parsed.buffer, parsed.ext);
  }

  const img = resolveImageFields(typeof ref === 'object' ? ref : { filename: ref });
  if (!img) {
    if (typeof ref === 'object' && ref.filename) {
      return loadImageFromRef({ type: 'file', value: ref.filename }, fileMap, uploadsPath);
    }
    throw new Error('缺少图片 data / url / filename');
  }

  if (img.type === 'base64') {
    const parsed = parseBase64Image(img.value);
    if (!parsed.buffer.length) throw new Error('base64 解码失败或为空');
    const hint = typeof ref === 'object' ? (ref.filename || ref.file || parsed.ext) : parsed.ext;
    return saveBuffer(uploadsPath, parsed.buffer, hint || parsed.ext);
  }

  if (img.type === 'file') {
    const hit = lookupFile(fileMap, img.value);
    if (hit) return saveBuffer(uploadsPath, hit.buffer, hit.name);
    // 已在 uploads 目录
    const base = img.value.split(/[/\\]/).pop();
    const localPath = path.join(uploadsPath, base);
    if (fs.existsSync(localPath)) return base;
    const uploadsRef = img.value.replace(/^\/uploads\//, '');
    if (fs.existsSync(path.join(uploadsPath, uploadsRef))) return path.basename(uploadsRef);
    throw new Error(`找不到文件 ${img.value}`);
  }

  if (img.type === 'url') {
    const url = img.value;
    if (url.startsWith('/uploads/')) {
      const base = path.basename(url);
      if (fs.existsSync(path.join(uploadsPath, base))) return base;
      throw new Error(`本地路径不存在 ${url}`);
    }
    if (!/^https?:\/\//i.test(url)) throw new Error(`无法识别的 url：${url.slice(0, 40)}`);
    const fetch = global.fetch || require('node-fetch');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, 60000) : null;
    let resp;
    try {
      resp = await fetch(url, {
        timeout: 60000,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const ext = path.extname(new URL(url).pathname) || '.png';
    return saveBuffer(uploadsPath, buf, ext);
  }

  throw new Error('无法解析图片字段');
}

/**
 * @returns {{ imported: number, skipped: number, errors: string[], total: number }}
 */
async function importStickersToCategory(db, categoryId, pack, fileMap, uploadsPath) {
  const normalized = normalizePack(pack);
  if (!normalized) throw new Error('JSON 格式无效：未找到 stickers/emojis/items 等表情数组');

  let imported = 0;
  let skipped = 0;
  const errors = [];
  const insert = db.prepare(
    'INSERT INTO emojis (category_id, filename, description) VALUES (?,?,?)'
  );
  const total = normalized.stickers.length;

  beginSaveBatch();
  try {
  for (let i = 0; i < normalized.stickers.length; i++) {
    if (i > 0 && i % 20 === 0) await new Promise((r) => setImmediate(r));
    const rawItem = normalized.stickers[i];
    const item = coerceStickerItem(rawItem, i);
    if (!item) {
      skipped++;
      if (errors.length < 30) errors.push(`第 ${i + 1} 项：不是有效的图片数据`);
      continue;
    }

    const fileHint = typeof item === 'object' ? (item.filename || item.file || item.path || item.url || '') : '';
    const description = resolveDescription(item, fileHint, i);

    try {
      let filename = '';

      if (normalized.directRecords && item.filename) {
        const base = path.basename(String(item.filename));
        const local = path.join(uploadsPath, base);
        if (fs.existsSync(local)) {
          filename = base;
        } else {
          const hit = lookupFile(fileMap, item.filename);
          if (hit) filename = saveBuffer(uploadsPath, hit.buffer, hit.name);
          else throw new Error(`文件 ${item.filename} 不在包内或 uploads 目录`);
        }
      } else {
        filename = await loadImageFromRef(item, fileMap, uploadsPath);
      }

      insert.run(categoryId, filename, description);
      imported++;
    } catch (e) {
      skipped++;
      if (errors.length < 30) errors.push(`第 ${i + 1} 项「${description}」：${e.message}`);
    }
  }
  } finally {
    endSaveBatch();
  }

  return { imported, skipped, errors, total };
}

async function readZipEntries(zipPath) {
  const directory = await unzipper.Open.file(zipPath);
  const jsonFiles = [];
  const imageFiles = new Map();

  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    const fullPath = entry.path.replace(/\\/g, '/');
    if (fullPath.includes('__MACOSX/') || fullPath.startsWith('.')) continue;

    const buf = await entry.buffer();
    const name = fullPath.split('/').pop();
    if (!name) continue;

    const lower = fullPath.toLowerCase();
    if (name.toLowerCase().endsWith('.json') || name.toLowerCase().endsWith('.txt')) {
      jsonFiles.push({ name: fullPath, text: buf.toString('utf8') });
    } else if (IMAGE_EXT.test(name)) {
      imageFiles.set(name.toLowerCase(), { buffer: buf, name });
      imageFiles.set(fullPath.toLowerCase(), { buffer: buf, name });
    }
  }
  return { jsonFiles, imageFiles };
}

async function importJsonPack(db, categoryId, packJson, uploadsPath, fileMap = new Map()) {
  let pack;
  const rawText = typeof packJson === 'string' ? packJson : null;
  try {
    pack = typeof packJson === 'string' ? JSON.parse(packJson) : packJson;
  } catch (e) {
    if (rawText) {
      const raw = parseRawBase64Pack(rawText);
      if (raw) pack = raw;
      else throw new Error(`JSON 解析失败：${e.message}（若是纯 base64，请用 .txt 或 JSON 数组 ["base64",...]）`);
    } else {
      throw new Error(`JSON 解析失败：${e.message}`);
    }
  }
  return importStickersToCategory(db, categoryId, pack, fileMap, uploadsPath);
}

async function importZipPack(db, categoryId, zipPath, uploadsPath) {
  const { jsonFiles, imageFiles } = await readZipEntries(zipPath);
  const manifest = pickManifestJson(jsonFiles);

  if (!manifest) {
    const imgCount = imageFiles.size;
    if (imgCount > 0) {
      throw new Error(`ZIP 内未找到 JSON 清单（有 ${imgCount} 张图片）。请添加 pack.json，或改用纯 JSON（base64）导入`);
    }
    throw new Error('ZIP 内未找到 pack.json 或任何图片');
  }

  const isTxt = manifest.name.toLowerCase().endsWith('.txt');
  let pack;
  if (isTxt) {
    pack = parseRawBase64Pack(manifest.text);
    if (!pack) throw new Error('TXT 内未识别到 base64 图片（每行一条，或整文件一条）');
  } else {
    try {
      pack = JSON.parse(manifest.text);
    } catch (e) {
      const raw = parseRawBase64Pack(manifest.text);
      if (raw) pack = raw;
      else throw new Error(`ZIP 内 JSON 解析失败：${e.message}`);
    }
  }

  const fileMap = new Map();
  for (const [k, v] of imageFiles) {
    fileMap.set(k, { buffer: v.buffer, name: v.name });
  }
  return importStickersToCategory(db, categoryId, pack, fileMap, uploadsPath);
}

async function peekZipPackName(zipPath) {
  const { jsonFiles } = await readZipEntries(zipPath);
  const manifest = pickManifestJson(jsonFiles);
  if (!manifest) return '导入的表情包';
  try {
    const p = normalizePack(JSON.parse(manifest.text));
    return (p?.name || '导入的表情包').slice(0, 20);
  } catch {
    return '导入的表情包';
  }
}

function formatImportError(result) {
  const parts = [`没有成功导入任何表情（共 ${result.total || 0} 项，跳过 ${result.skipped || 0} 项）`];
  if (result.errors?.length) {
    parts.push(result.errors.slice(0, 5).join('\n'));
    if (result.errors.length > 5) parts.push(`…还有 ${result.errors.length - 5} 条`);
  } else {
    parts.push('常见原因：JSON 字段名不匹配、缺少 description、ZIP 内缺图片或清单');
  }
  return parts.join('\n');
}

/** 导出分类为可再导入的 JSON 包（description + base64） */
function exportCategoryPack(db, categoryId, uploadsPath) {
  const cat = db.prepare('SELECT id, name FROM emoji_categories WHERE id=?').get(categoryId);
  if (!cat) throw new Error('分类不存在');
  const rows = db.prepare(
    'SELECT id, filename, description FROM emojis WHERE category_id=? ORDER BY id'
  ).all(categoryId) || [];
  const stickers = [];
  const skipped = [];
  for (const row of rows) {
    const filename = String(row.filename || '').trim();
    if (!filename) {
      skipped.push(`#${row.id} 无文件名`);
      continue;
    }
    const fp = path.join(uploadsPath, filename);
    if (!fs.existsSync(fp)) {
      skipped.push(`${row.description || filename}: 文件丢失`);
      continue;
    }
    try {
      const buf = fs.readFileSync(fp);
      const ext = path.extname(filename).toLowerCase() || detectExtFromBuffer(buf);
      const mime = ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : 'image/png';
      stickers.push({
        description: String(row.description || '').trim() || `表情${stickers.length + 1}`,
        data: `data:${mime};base64,${buf.toString('base64')}`,
      });
    } catch (e) {
      skipped.push(`${row.description || filename}: ${e.message}`);
    }
  }
  return {
    type: 'nian_emoji_pack',
    version: '1.0',
    name: cat.name,
    exported_at: new Date().toISOString(),
    stickers,
    exported: stickers.length,
    skipped: skipped.length,
    errors: skipped,
  };
}

module.exports = {
  normalizePack,
  importJsonPack,
  importZipPack,
  peekZipPackName,
  formatImportError,
  exportCategoryPack,
};

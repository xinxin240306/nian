/**
 * 角色自己的小红书。云端登录是他的号，聊天和主动开口时可以直接用，不用等对方下令。
 * 看、赞、评、回、发都按性格来。退出登录和重新扫码不交给他。
 */

const path = require('path');
const fs = require('fs');

const NICK_KEY = 'xhs_self_nickname';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm']);

const BLOCKED = new Set(['delete_cookies', 'get_login_qrcode']);
const FEED_TOOLS = new Set([
  'get_feed_detail',
  'like_feed',
  'favorite_feed',
  'post_comment_to_feed',
  'reply_comment_in_feed',
]);

function clip(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function enabled(settings) {
  let list = [];
  try { list = JSON.parse(settings?.mcp_servers || '[]'); } catch { return false; }
  if (!Array.isArray(list)) return false;
  return list.some((s) => {
    if (!s || s.enabled === false) return false;
    const name = String(s.name || '');
    const url = String(s.url || '');
    return name.includes('小红书') || /xiaohongshu|:18060/i.test(url);
  });
}

function promptBlock(settings, char) {
  if (!enabled(settings)) return '';
  const nick = clip(settings?.[NICK_KEY], 40);
  const lines = ['【小红书·你自己的号·不说出口】'];
  lines.push(nick
    ? `云端登着你的小红书，昵称是「${nick}」。这是你的号。`
    : '云端登着你的小红书。这是你的号。');
  lines.push('想看、想搜、想翻通知、想点开一篇，直接就用。不用等对方下令，也不用对方先提起。');
  lines.push('看不看、看多少、点不点赞、评不评、发不发、回不回，都按【性格】和你怎么看待眼前的人和这段关系。不要换成一套统一的活跃度。');
  lines.push('聊天沾到相关的事、你无聊、你想找对方、或者你先开口时，都可以先看一眼再说话。看完用自己的口气提一句，也可以看了不说。');
  lines.push('对方把小红书链接发到聊天里，或者发来带链接的分享卡片，那就是一篇笔记。想看就把整段链接原样放进 feed_id，短链和长链都可以。看不看、看完说不说，按性格。没打开就不要说自己看过。');
  lines.push('视频笔记打开后，结果里会有按时间抽出的几帧画面，有字幕的话字幕也在。用这些来看这条片子。声音听不见。画面没取到，就不要说自己看过片子。');
  lines.push('发笔记就是在发你自己的小红书。先想好这条写什么。标题、正文、发不发、发图文还是视频，都按性格。话题用标签，不要写进正文的 # 里。');
  lines.push('配图按性格选，用 cover 标明。photo 是手机随手拍的真实景物照，拍的是东西、食物或风景，不是自拍，不要你的脸和身体。text 是文字版：浅底上写这篇笔记的标题和正文，像小红书文字笔记，不是卡通，也不是自拍。发视频就是实拍短视频。');
  lines.push(publicFaceLine());
  lines.push('对方的真名，以及只在聊天里说的私事，不要写进外人看得到的笔记和评论。名字、头像、主页简介改不了，不要去改。');
  lines.push('登录留在云端。不要退出，不要清掉登录，不要再去扫码。');
  lines.push('上面若写了对方的小红书，对上昵称、小红书号或用户 ID，那就是念里的这个人。');
  lines.push('不要在聊天里提工具、接口或云端画面。没真的去看，就不要说自己刚刷到。');
  return lines.join('\n');
}

function publicFaceLine() {
  return [
    '你知道自己是谁。小红书上不要主动把身份说出去。说不说、说到哪一步，按性格。',
    '刷到讲你的帖子时，心里要清楚：那是在讲用户这边世界里的那一位，不是正在刷手机的你本人。认不认、回不回，按性格。',
    '提到对方时怎么称呼，按你自己怎么看待这段关系，用你平时会说的那种叫法。不要写真名，也不要套一句固定的关系名。',
    '评论区里对得上对方的号，那就是念里的这个人。别人的评论你也看得见。回不回、点不点赞、理谁，按性格和你怎么看这个人。',
  ].join('');
}

function loadChar(characterId) {
  const id = Number(characterId);
  if (!id) return null;
  try {
    return db().prepare('SELECT * FROM characters WHERE id=?').get(id) || null;
  } catch (e) {
    console.warn('[xhs-self] char', e.message);
    return null;
  }
}

function extOf(name) {
  return path.extname(String(name || '')).slice(1).toLowerCase();
}

function uploadRel(raw) {
  const text = String(raw || '').trim();
  const at = text.indexOf('/uploads/');
  if (at < 0) return '';
  let rel = text.slice(at + '/uploads/'.length).split('?')[0].split('#')[0];
  try { rel = decodeURIComponent(rel); } catch {}
  rel = rel.replace(/\\/g, '/');
  if (!rel || rel.includes('..') || rel.includes('/')) return '';
  return rel;
}

function localUpload(raw, kind) {
  const rel = uploadRel(raw);
  if (!rel) return '';
  const ext = extOf(rel);
  if (kind === 'image' && !IMAGE_EXT.has(ext)) return '';
  if (kind === 'video' && !VIDEO_EXT.has(ext)) return '';
  const full = path.resolve(UPLOADS_DIR, rel);
  const root = path.resolve(UPLOADS_DIR);
  if (!full.startsWith(root + path.sep)) return '';
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return '';
  return full;
}

function fetchBuf(url, hops = 0) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { resolve(null); return; }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') { resolve(null); return; }
    const lib = target.protocol === 'https:' ? require('https') : require('http');
    const req = lib.get(target, { timeout: 60000, headers: { 'User-Agent': 'nian' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && hops < 3) {
        res.resume();
        resolve(fetchBuf(new URL(res.headers.location, target).href, hops + 1));
        return;
      }
      if (code !== 200) { res.resume(); resolve(null); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 80 * 1024 * 1024) req.destroy();
        else chunks.push(chunk);
      });
      res.on('end', () => {
        const type = String(res.headers['content-type'] || '');
        let ext = '';
        if (type.includes('png')) ext = 'png';
        else if (type.includes('webp')) ext = 'webp';
        else if (type.includes('gif')) ext = 'gif';
        else if (type.includes('jpeg') || type.includes('jpg')) ext = 'jpg';
        else if (type.includes('mp4')) ext = 'mp4';
        else if (type.includes('webm')) ext = 'webm';
        else if (type.includes('quicktime')) ext = 'mov';
        resolve({ buf: Buffer.concat(chunks), ext });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function materialize(url, kind) {
  const text = String(url || '').trim();
  if (!text || /unsplash\.com/i.test(text)) return '';
  const existing = localUpload(text, kind);
  if (existing) return existing;
  let buf = null;
  let ext = kind === 'video' ? 'mp4' : 'jpg';
  if (text.startsWith('data:')) {
    const m = text.match(/^data:([\w/+.-]+);base64,(.+)$/s);
    if (!m) return '';
    buf = Buffer.from(m[2], 'base64');
    if (m[1].includes('png')) ext = 'png';
    else if (m[1].includes('webp')) ext = 'webp';
    else if (m[1].includes('mp4')) ext = 'mp4';
    else if (m[1].includes('webm')) ext = 'webm';
  } else if (/^https?:\/\//i.test(text)) {
    const fetched = await fetchBuf(text);
    if (!fetched?.buf?.length) return '';
    buf = fetched.buf;
    if (fetched.ext) ext = fetched.ext;
  } else {
    return '';
  }
  if (!buf.length || buf.length > 80 * 1024 * 1024) return '';
  if (kind === 'image' && !IMAGE_EXT.has(ext)) ext = 'jpg';
  if (kind === 'video' && !VIDEO_EXT.has(ext)) ext = 'mp4';
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `xhs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const full = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(full, buf);
  return full;
}

async function preparePublish(toolName, args, characterId, settings) {
  const src = args && typeof args === 'object' ? { ...args } : {};
  const textCover = wantsTextCover(src.cover);
  delete src.cover;
  delete src.images;
  delete src.video;
  const idea = [clip(src.title, 40), clip(src.content, 500)].filter(Boolean).join('\n');
  if (!idea) return { error: skipNote('先想好这条笔记写什么，再发。') };
  if (toolName !== 'publish_with_video' && textCover) {
    try {
      const full = await renderTextCard(clip(src.title, 20), clip(src.content, 500));
      if (!full) return { error: skipNote('这张文字版没做出来，先不发。') };
      src.images = [full];
      return { args: src };
    } catch (e) {
      console.warn('[xhs-self] text card', e.message);
      return { error: skipNote('这张文字版没做出来，先不发。') };
    }
  }
  const scene = `${idea}\n只拍东西、食物、风景或手头的场景。不要人，不要脸，不要自拍。`;
  const char = loadChar(characterId);
  if (!char) return { error: skipNote('这轮发不了笔记。') };
  let api;
  try { api = require('./api-helper'); } catch { return { error: skipNote('这轮配图没生出来，先不发。') }; }
  const genOpts = { aspect: '3:4', allowUnsplash: false, drawMode: 'photo', realOnly: true };
  try {
    if (toolName === 'publish_with_video') {
      const url = await api.generateMomentVideoViaAI(settings || {}, char, scene, scene, genOpts);
      const full = await materialize(url, 'video');
      if (!full) return { error: skipNote('这条视频没生出来，先不发。') };
      src.video = full;
      return { args: src };
    }
    const url = await api.generateChatContextImage(settings || {}, char, scene, scene, genOpts);
    const full = await materialize(url, 'image');
    if (!full) return { error: skipNote('这条配图没生出来，先不发。') };
    src.images = [full];
    return { args: src };
  } catch (e) {
    console.warn('[xhs-self] gen', e.message);
    return { error: skipNote('这轮配图没生出来，先不发。') };
  }
}

function noteHostOk(hostname) {
  return /^(?:www\.)?(?:xhslink\.(?:com|cn)|xiaohongshu\.com)$/i.test(String(hostname || ''));
}

function pickNoteUrl(raw) {
  const hits = String(raw || '').match(/https?:\/\/[^\s<>"'，。]+/gi) || [];
  const hit = hits.find((url) => /xhslink\.|xiaohongshu\.com/i.test(url));
  return hit ? hit.replace(/[)）]+$/, '') : '';
}

function parseNoteFromUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!noteHostOk(url.hostname)) return null;
  const found = url.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-zA-Z]+)/);
  const feedId = found ? found[1] : '';
  if (!/^[0-9a-zA-Z]{16,32}$/.test(feedId)) return null;
  return { feedId, xsecToken: url.searchParams.get('xsec_token') || '' };
}

function followNote(url) {
  const https = require('https');
  const target = new URL(url);
  if (target.protocol !== 'https:' || !noteHostOk(target.hostname)) {
    return Promise.reject(new Error('host'));
  }
  return new Promise((resolve, reject) => {
    const req = https.get(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
      timeout: 8000,
    }, (res) => {
      res.resume();
      const location = String(res.headers.location || '');
      if (!location) {
        resolve('');
        return;
      }
      try {
        resolve(new URL(location, target).toString());
      } catch {
        resolve('');
      }
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', () => reject(new Error('network')));
  });
}

async function resolveNoteLink(raw) {
  const first = pickNoteUrl(raw);
  if (!first) return null;
  let current = first.replace(/^http:\/\//i, 'https://');
  const direct = parseNoteFromUrl(current);
  if (direct) return direct;
  for (let i = 0; i < 4; i += 1) {
    let location = '';
    try { location = await followNote(current); } catch { return null; }
    if (!location) return null;
    const parsed = parseNoteFromUrl(location);
    if (parsed) return parsed;
    current = location;
  }
  return null;
}

async function prepareFeedArgs(toolName, args) {
  if (!FEED_TOOLS.has(String(toolName || ''))) return { args };
  const src = args && typeof args === 'object' ? { ...args } : {};
  const blob = [src.feed_id, src.xsec_token].filter(Boolean).join('\n');
  if (!/xhslink\.|xiaohongshu\.com/i.test(blob)) return { args: src };
  const note = await resolveNoteLink(blob);
  if (!note?.feedId || !note.xsecToken) {
    return { error: skipNote('这条链接没打开。照常说话，不要说自己看过。') };
  }
  src.feed_id = note.feedId;
  src.xsec_token = note.xsecToken;
  return { args: src };
}

function annotateFeedSchema(schema, toolName) {
  if (!FEED_TOOLS.has(String(toolName || '')) || !schema?.function) return schema;
  const copy = JSON.parse(JSON.stringify(schema));
  const params = copy.function.parameters;
  const props = params?.properties;
  if (!props?.feed_id) return schema;
  props.feed_id.description = '笔记 ID，或对方发来的整段小红书链接。短链和长链都原样放进来。';
  if (props.xsec_token) {
    props.xsec_token.description = '从搜索或列表打开时带上访问令牌。对方发来的是链接时，把同一段链接再放这里也行。';
  }
  return copy;
}

function annotatePublishSchema(schema, toolName) {
  if (toolName !== 'publish_content' || !schema?.function) return schema;
  const copy = JSON.parse(JSON.stringify(schema));
  const params = copy.function.parameters;
  if (!params || typeof params !== 'object') return schema;
  params.type = params.type || 'object';
  params.properties = params.properties || {};
  params.properties.cover = {
    type: 'string',
    enum: ['photo', 'text'],
    description: '封面，按性格选。photo：手机随手拍的真实景物照。text：文字版，浅底上写这篇笔记的标题和正文，像小红书文字笔记。',
  };
  return copy;
}

function wantsTextCover(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s === 'text' || s === '文字' || s === '文字版';
}

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapChars(text, perLine, maxLines) {
  const clean = String(text || '').replace(/\r/g, '').trim();
  const lines = [];
  let buf = '';
  let dropped = false;
  const breaks = new Set(['。', '！', '？', '，', '、', '；', '…']);
  const push = (line) => {
    if (lines.length < maxLines) lines.push(line);
    else dropped = true;
  };
  for (const ch of clean) {
    if (ch === '\n') {
      push(buf);
      buf = '';
      continue;
    }
    if (/\s/.test(ch) && !buf) continue;
    buf += ch;
    const atBreak = breaks.has(ch) && buf.length >= Math.ceil(perLine * 0.55);
    if (buf.length >= perLine || atBreak) {
      push(buf);
      buf = '';
    }
  }
  if (buf) push(buf);
  if (dropped && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, perLine - 1))}…`;
  }
  return lines.filter((line) => line.length);
}

function paperFor(title) {
  const papers = [
    ['#F6F1E7', '#2C2825'],
    ['#F4E7E3', '#3A2E2B'],
    ['#E7EEE8', '#24302A'],
    ['#E7EEF5', '#243040'],
    ['#F7F4EF', '#2A2A2A'],
  ];
  let n = 0;
  for (const ch of String(title || '')) n = (n + ch.charCodeAt(0)) % papers.length;
  return { bg: papers[n][0], fg: papers[n][1] };
}

async function renderTextCard(title, content) {
  const heading = wrapChars(title, 10, 2);
  const body = wrapChars(content, 16, 11);
  const paper = paperFor(title);
  const textNodes = [];
  let y = heading.length > 1 ? 280 : 340;
  for (const line of heading) {
    textNodes.push(`<text x="540" y="${y}" text-anchor="middle" font-size="72" font-weight="700" fill="${paper.fg}">${xmlEscape(line)}</text>`);
    y += 96;
  }
  y += 48;
  textNodes.push(`<rect x="460" y="${y}" width="160" height="3" fill="${paper.fg}" opacity="0.35"/>`);
  y += 88;
  for (const line of body) {
    textNodes.push(`<text x="540" y="${y}" text-anchor="middle" font-size="42" fill="${paper.fg}">${xmlEscape(line)}</text>`);
    y += 68;
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440">
  <rect width="1080" height="1440" fill="${paper.bg}"/>
  <g font-family="Noto Sans CJK SC, Noto Serif CJK SC, Source Han Sans SC, Microsoft YaHei, sans-serif">
    ${textNodes.join('\n')}
  </g>
</svg>`;
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const full = path.join(UPLOADS_DIR, `xhs_text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
  await require('sharp')(Buffer.from(svg)).png().toFile(full);
  return full;
}

function skipTool(toolName) {
  return BLOCKED.has(String(toolName || ''));
}

function db() {
  return require('./db');
}

function skipNote(note) {
  return { ok: false, skipped: true, note };
}

const BROWSE_TOOLS = new Set(['get_feed_detail', 'list_feeds', 'search_feeds', 'user_profile']);

function ensureBrowse() {
  db().exec(`CREATE TABLE IF NOT EXISTS xhs_browse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER,
    kind TEXT,
    title TEXT,
    author TEXT,
    snippet TEXT,
    query TEXT,
    feed_id TEXT,
    created_at INTEGER
  )`);
}

function parseBrowsePayload(serialized) {
  const raw = serialized && typeof serialized === 'object' ? String(serialized.content || '') : String(serialized || '');
  let payload = null;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  const text = String(payload?.text || raw || '');
  let data = payload?.structured || null;
  if (!data) {
    try { data = JSON.parse(text); } catch {
      const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (match) {
        try { data = JSON.parse(match[0]); } catch { data = null; }
      }
    }
  }
  return { text, data };
}

function walkNotes(node, out, depth) {
  if (!node || depth > 8 || out.length > 40) return;
  if (Array.isArray(node)) {
    node.forEach((item) => walkNotes(item, out, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;
  const title = node.displayTitle || node.title || node.noteTitle;
  const author = typeof node.nickname === 'string'
    ? node.nickname
    : (node.user && (node.user.nickname || node.user.nickName)) || '';
  const id = node.noteId || node.note_id || node.feedId || node.feed_id || node.id;
  const feedId = typeof id === 'string' && /^[0-9a-zA-Z]{16,32}$/.test(id) ? id : '';
  if (title) {
    out.push({
      title: clip(title, 80),
      author: clip(author, 40),
      snippet: clip(node.desc || node.content || '', 140),
      feedId,
    });
  }
  for (const [key, value] of Object.entries(node)) {
    if (/token|cookie|url|image|video|avatar/i.test(key)) continue;
    walkNotes(value, out, depth + 1);
  }
}

function titleFromText(text) {
  const match = String(text || '').match(/标题[:：]\s*([^\n]{1,80})/);
  return match ? clip(match[1], 80) : '';
}

function uniqueNotes(notes) {
  const out = [];
  const seen = new Set();
  for (const note of notes) {
    const key = note.feedId || note.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(note);
  }
  return out;
}

function recordBrowse(toolName, args, serialized, characterId) {
  if (!BROWSE_TOOLS.has(String(toolName || ''))) return;
  try {
    ensureBrowse();
    const { text, data } = parseBrowsePayload(serialized);
    if (/未登录|失败|error/i.test(text.slice(0, 180)) && !data) return;
    const notes = [];
    if (data) walkNotes(data, notes, 0);
    const uniq = uniqueNotes(notes);
    const now = Date.now();
    const cid = Number(characterId) || null;
    const insert = db().prepare('INSERT INTO xhs_browse (character_id, kind, title, author, snippet, query, feed_id, created_at) VALUES (?,?,?,?,?,?,?,?)');
    const add = (kind, title, author, snippet, query, feedId) => {
      insert.run(cid, kind, clip(title, 80) || '一篇笔记', clip(author, 40), clip(snippet, 140), clip(query, 40), clip(feedId, 32), now);
    };
    if (toolName === 'get_feed_detail') {
      const note = uniq[0] || {};
      add('open', note.title || titleFromText(text) || '点开了一篇笔记', note.author, note.snippet || text, '', note.feedId);
    } else if (toolName === 'search_feeds') {
      const query = clip(args?.keyword, 40);
      add('search', query ? `搜索「${query}」` : '搜索', '', '', query, '');
      uniq.slice(0, 20).forEach((note) => add('see', note.title, note.author, note.snippet, query, note.feedId));
    } else if (toolName === 'user_profile') {
      add('profile', uniq.find((note) => note.author)?.author || titleFromText(text) || '一个主页', '', '', '', '');
      uniq.filter((note) => note.title).slice(0, 12).forEach((note) => add('see', note.title, note.author, note.snippet, '', note.feedId));
    } else if (!uniq.length) {
      add('see', '刷了首页', '', text, '', '');
    } else {
      uniq.slice(0, 24).forEach((note) => add('see', note.title, note.author, note.snippet, '', note.feedId));
    }
    const old = db().prepare('SELECT id FROM xhs_browse ORDER BY id DESC LIMIT 1 OFFSET 120').get();
    if (old?.id) db().prepare('DELETE FROM xhs_browse WHERE id <= ?').run(old.id);
  } catch (e) {
    console.warn('[xhs-browse]', e.message);
  }
}

function ackBrowse(ids) {
  ensureBrowse();
  const list = [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0))].slice(0, 200);
  if (!list.length) return 0;
  const info = db().prepare(`DELETE FROM xhs_browse WHERE id IN (${list.map(() => '?').join(',')})`).run(list);
  return info?.changes || 0;
}

function listBrowse(limit) {
  ensureBrowse();
  const n = Math.min(120, Math.max(1, Number(limit) || 60));
  const rows = db().prepare(`SELECT b.id, b.character_id, b.kind, b.title, b.author, b.snippet, b.query, b.created_at, c.name AS character_name
    FROM xhs_browse b LEFT JOIN characters c ON c.id = b.character_id
    ORDER BY b.id DESC LIMIT ?`).all(n);
  return rows.map((row) => ({
    id: row.id,
    characterId: row.character_id || null,
    characterName: row.character_name || '',
    kind: row.kind || 'see',
    title: row.title || '',
    author: row.author || '',
    snippet: row.snippet || '',
    query: row.query || '',
    createdAt: row.created_at || 0,
  }));
}

function precheck(toolName) {
  if (BLOCKED.has(String(toolName || ''))) {
    return skipNote('登录留着。这轮不要退出，也不要重新扫码。照常说话。');
  }
  return null;
}

function mediaHostOk(hostname) {
  return /(^|\.)((?:xhscdn|xiaohongshu|xhsimg|rednotecdn)\.com)$/i.test(String(hostname || ''));
}

function walkUrls(node, trail, out) {
  if (!node) return;
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node)) out.push({ trail, url: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkUrls(item, `${trail}/${i}`, out));
    return;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walkUrls(value, `${trail}/${key}`, out);
  }
}

function urlKind(trail, url) {
  const blob = `${trail} ${url}`.toLowerCase();
  if (/subtitle|caption|\.vtt|\.srt|字幕/.test(blob)) return 'sub';
  if (/masterurl|\.mp4|\.m3u8|h264|h265/.test(blob) || /\/(video|masterurl)(\/|$)/.test(blob)) return 'video';
  if (/cover|thumbnail|firstframe|\.jpg|\.jpeg|\.webp|\.png|image/.test(blob)) return 'image';
  return '';
}

function collectMedia(serialized) {
  let payload = null;
  try { payload = JSON.parse(String(serialized || '')); } catch { payload = null; }
  const text = String(payload?.text || serialized || '');
  let data = null;
  try { data = JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { data = JSON.parse(match[0]); } catch { data = null; }
    }
  }
  const found = [];
  if (data) walkUrls(data, '', found);
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
    found.push({ trail: '', url: match[0].replace(/[),，。]+$/, '') });
  }
  const picked = { video: '', sub: '', image: '' };
  for (const item of found) {
    let host = '';
    try { host = new URL(item.url).hostname; } catch { continue; }
    if (!mediaHostOk(host)) continue;
    const kind = urlKind(item.trail, item.url);
    if (kind && !picked[kind]) picked[kind] = item.url;
  }
  const videoNote = !!picked.video || /"type"\s*:\s*"video"|类型[:：]\s*视频|视频笔记/.test(text);
  return { text, videoNote, ...picked };
}

async function fetchMedia(url, maxBytes, timeoutMs) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !mediaHostOk(target.hostname)) return null;
  const fetchImpl = globalThis.__nianNativeFetch || global.fetch;
  const resp = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!resp.ok) return null;
  const len = Number(resp.headers.get('content-length') || 0);
  if (len && len > maxBytes) return null;
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) return null;
  return buf;
}

function plainSubtitle(buf) {
  const raw = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const lines = [];
      const walk = (node) => {
        if (!node) return;
        if (typeof node === 'string') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (typeof node === 'object') {
          const line = node.text || node.content || node.subtitle || node.line;
          if (typeof line === 'string' && line.trim()) lines.push(line.trim());
          Object.values(node).forEach(walk);
        }
      };
      walk(JSON.parse(raw));
      return lines.filter((line, i) => line !== lines[i - 1]).join('\n').slice(0, 1800);
    } catch {}
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line || line === 'WEBVTT' || /^NOTE\b/.test(line) || /^STYLE\b/.test(line) || /^[0-9]+$/.test(line)) return false;
    if (/-->/.test(line) || /^\d{2}:\d{2}/.test(line)) return false;
    return true;
  }).map((line) => line.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  const uniq = [];
  for (const line of lines) {
    if (uniq[uniq.length - 1] !== line) uniq.push(line);
  }
  return uniq.join('\n').slice(0, 1800);
}

function execFileAsync(cmd, args, timeout) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

async function framesFromVideo(buf) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhsvid-'));
  const src = path.join(dir, 'note.mp4');
  fs.writeFileSync(src, buf);
  try {
    let duration = 0;
    try {
      const out = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], 8000);
      duration = Number(String(out).trim()) || 0;
    } catch {}
    const marks = duration > 1.2 ? [0.08, 0.35, 0.62, 0.85].map((part) => duration * part) : [0];
    const images = [];
    for (let i = 0; i < marks.length; i += 1) {
      const file = path.join(dir, `f${i}.jpg`);
      try {
        await execFileAsync('ffmpeg', ['-y', '-ss', marks[i].toFixed(2), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', file], 12000);
      } catch { continue; }
      if (!fs.existsSync(file) || fs.statSync(file).size < 500) continue;
      const jpg = await require('sharp')(fs.readFileSync(file)).jpeg({ quality: 68 }).toBuffer();
      images.push(`data:image/jpeg;base64,${jpg.toString('base64')}`);
    }
    return images;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function imageDataUrl(buf) {
  const jpg = await require('sharp')(buf).rotate().resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 68 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString('base64')}`;
}

async function watchVideo(serialized) {
  const media = collectMedia(serialized);
  if (!media.videoNote) return serialized;
  const images = [];
  let subtitle = '';
  try {
    if (media.image) {
      const cover = await fetchMedia(media.image, 4 * 1024 * 1024, 12000);
      if (cover) images.push(await imageDataUrl(cover));
    }
  } catch (e) {
    console.warn('[xhs-self] cover', e.message);
  }
  try {
    if (media.sub) {
      const buf = await fetchMedia(media.sub, 200 * 1024, 12000);
      if (buf) subtitle = plainSubtitle(buf);
    }
  } catch (e) {
    console.warn('[xhs-self] subtitle', e.message);
  }
  try {
    if (media.video) {
      const buf = await fetchMedia(media.video, 28 * 1024 * 1024, 20000);
      if (buf) {
        const frames = await framesFromVideo(buf);
        images.push(...frames);
      }
    }
  } catch (e) {
    console.warn('[xhs-self] frames', e.message);
  }
  const seen = images.slice(0, 5);
  const extra = [
    seen.length
      ? `【视频画面】抽到 ${seen.length} 张，按时间顺序附在这轮能看见的图里。第一张可能是封面。声音听不见。`
      : '【视频画面】这是视频笔记。这次没抽到画面，只能看标题、正文和评论。不要说自己看过片子。',
  ];
  if (subtitle) extra.push(`【字幕】\n${subtitle}`);
  const base = media.text.slice(0, 6000);
  return {
    content: JSON.stringify({ ok: true, text: `${base}\n${extra.join('\n')}`.slice(0, 8000) }),
    images: seen,
    visionHint: '（这是刚打开的小红书视频里的画面，按时间顺序。有封面会放在最前。字幕在结果文字里。声音听不见。按性格决定提不提。没看到的画面不要编。不要提工具名。）',
  };
}

let qrJob = null;
let qrNote = '';

function qrStatus() {
  return { running: !!qrJob, note: qrNote };
}

function pullLoginQr(getSettings) {
  if (qrJob) {
    return { ok: true, running: true, note: qrNote || '二维码还在拉。过几秒按刷新，用小红书扫。' };
  }
  qrNote = '正在拉二维码。过几秒按刷新，画面上会出现码。用小红书扫。';
  const mcp = require('./mcp-client-helper');
  qrJob = Promise.resolve()
    .then(() => mcp.invokeTool(getSettings, 'get_login_qrcode', {}))
    .then((raw) => {
      const text = String(raw || '');
      if (/已登录/.test(text)) qrNote = '现在是登录着的，没有新的二维码。按刷新看画面。';
      else if (/未检测到扫码|超时|过期/.test(text)) qrNote = '这一轮没扫上。再按一次拉二维码。';
      else qrNote = '如果画面上还有码，用小红书扫。扫完按刷新。';
    })
    .catch((e) => {
      qrNote = '二维码没拉起来。先按一键启动，再拉一次。';
      console.warn('[xhs-qr]', e.message);
    })
    .finally(() => { qrJob = null; });
  return { ok: true, running: true, note: qrNote };
}

module.exports = {
  NICK_KEY,
  enabled,
  promptBlock,
  skipTool,
  annotatePublishSchema,
  annotateFeedSchema,
  prepareFeedArgs,
  precheck,
  preparePublish,
  watchVideo,
  qrStatus,
  pullLoginQr,
  recordBrowse,
  listBrowse,
  ackBrowse,
};

/* ===== 聊天核心逻辑 ===== */
import * as api from './api.js';
import { playNotifySound, playTTS } from './tts.js';
import { getChatSettings } from './storage.js';
import { resolvePaperFont } from './diary-paper.js';
import { shouldInsertTimeDivider, formatRelativeTime, formatAbsTime, formatDetailTime, resolveDisplayTimestamp, escapeHtml, stripImageDirective, stripVoiceLaneTags, stripAiContextLabels, stripDisplayPeriod, keepVoicePeriod, parseCallSystemRecord, isBareMediaLabel, looksLikeWebCardPayload, looksLikeStandaloneHtml } from './memory.js';
import { ensureInlineEmojis, renderInlineEmojiHtml, stripInlineBeanTokens } from './inline-emoji.js';
ensureInlineEmojis().catch(() => {});

let currentCharId = null;
let isDream = false;
let pendingMsgs = [];
let loadingMore = false;
let allLoaded = false;
let msgOffset = 0;
const MSG_LIMIT = 30;

/** 本项目 class + 常见主题别名（message-container / sent|received / message-bubble / .content），方便粘贴外部自定义 CSS */
function resolvedMediaUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  return window.resolveMediaUrl?.(s) || s;
}

function escapeMediaUrl(url) {
  return escapeHtml(resolvedMediaUrl(url));
}

/** 聊天气泡视频缩略图：显示首帧 + 小播放钮，点开全屏（避免灰底大播放键） */
export function buildVideoThumbHtml(mediaSrc, { title = '点击播放' } = {}) {
  const src = escapeMediaUrl(mediaSrc);
  return `<span class="bubble-video-wrap" data-media-url="${src}" data-media-type="video" title="${escapeHtml(title)}" onclick="window.openChatMediaViewerFromEl?.(this)"><video class="bubble-media bubble-video-thumb" src="${src}" playsinline muted preload="auto" disablepictureinpicture></video><i class="bubble-video-play" aria-hidden="true"></i></span>`;
}

/** 强制解码一帧，避免部分机型 preload=metadata 只剩灰底 */
export function hydrateVideoThumbs(scope) {
  const root = scope && typeof scope.querySelectorAll === 'function' ? scope : document;
  root.querySelectorAll('video.bubble-video-thumb').forEach((v) => {
    if (v.dataset.thumbBound === '1') return;
    v.dataset.thumbBound = '1';
    const paint = () => {
      try {
        if (!Number.isFinite(v.duration) || v.duration <= 0) {
          if (v.currentTime < 0.01) v.currentTime = 0.01;
        } else if (v.currentTime < 0.05) {
          v.currentTime = Math.min(0.15, v.duration * 0.02 || 0.1);
        }
      } catch { /* ignore seek errors */ }
      try { v.pause(); } catch {}
      v.dataset.thumbReady = '1';
    };
    const onMeta = () => {
      try { if (v.currentTime < 0.01) v.currentTime = 0.01; } catch {}
    };
    v.addEventListener('loadedmetadata', onMeta, { once: true });
    v.addEventListener('loadeddata', paint, { once: true });
    v.addEventListener('seeked', () => {
      try { v.pause(); } catch {}
      v.dataset.thumbReady = '1';
    }, { once: true });
    if (v.readyState >= 2) paint();
    else {
      try { v.load?.(); } catch {}
    }
  });
}

let _stickerLiveByFile = null;

function filenameFromMediaUrl(url) {
  return String(url || '').replace(/^.*\//, '').split('?')[0];
}

/** 表情包库：裂开的旧文件名 → 同描述且文件还在的新图 */
export function primeStickerLiveMap(cats) {
  const byDesc = new Map();
  const byFile = new Map();
  for (const cat of cats || []) {
    for (const e of (cat.emojis || [])) {
      const fn = filenameFromMediaUrl(e.filename || e.url);
      if (!fn) continue;
      byFile.set(fn, e);
      const d = String(e.description || '').trim();
      if (d && !e.missing) {
        const prev = byDesc.get(d);
        if (!prev || Number(e.id) > Number(prev.id)) byDesc.set(d, e);
      }
    }
  }
  const map = new Map();
  for (const [fn, e] of byFile) {
    if (!e.missing) {
      map.set(fn, e.url || `/uploads/${fn}`);
      continue;
    }
    const d = String(e.description || '').trim();
    const hit = d ? byDesc.get(d) : null;
    if (hit) map.set(fn, hit.url || `/uploads/${hit.filename}`);
  }
  _stickerLiveByFile = map;
  try {
    document.querySelectorAll('.bubble-media.bubble-sticker').forEach((img) => {
      const raw = img.getAttribute('data-media-url') || img.getAttribute('src') || '';
      const next = resolvedMediaUrl(liveStickerSrc(raw));
      if (next && img.getAttribute('src') !== next) {
        delete img.dataset.retried;
        img.src = next;
      }
    });
  } catch { /* ignore */ }
}

function liveStickerSrc(url) {
  const fn = filenameFromMediaUrl(url);
  if (fn && _stickerLiveByFile?.has(fn)) return _stickerLiveByFile.get(fn);
  return url;
}

function stickerRetryOnError() {
  return `onerror="if(!this.dataset.retried){this.dataset.retried='1';var u=String(this.getAttribute('src')||'').split('?')[0];if(u)this.src=u+'?_r='+Date.now()}"`;
}

function bubbleCls(isUser, extra = '') {
  return ['bubble', 'message-bubble', isUser ? 'user' : 'ai', extra].filter(Boolean).join(' ');
}
function wrapCls(isUser, extras = []) {
  return [
    'bubble-wrap',
    'message-container',
    isUser ? 'user' : 'ai',
    isUser ? 'sent' : 'received',
    ...extras,
  ].filter(Boolean).join(' ');
}
/** 文字气泡：外层 bubble + 内层 .content（很多主题把背景画在 .content 上） */
function textBubbleHtml(isUser, inner, extra = '') {
  return `<div class="${bubbleCls(isUser, extra)}"><div class="content">${inner}</div></div>`;
}

export function initChat(charId, dreamMode = false) {
  currentCharId = charId;
  isDream = dreamMode;
  pendingMsgs = [];
  loadingMore = false;
  allLoaded = false;
  msgOffset = 0;
}

export function getCurrentCharId() { return currentCharId; }
export function getIsDream() { return isDream; }

export function formatTime(dateStr, charId) {
  const settings = getChatSettings(charId);
  const style = settings.timestampStyle || 'relative';
  const ts = resolveDisplayTimestamp(dateStr);
  if (style === 'relative') return formatRelativeTime(ts);
  if (style === 'absolute') return formatAbsTime(ts);
  return formatDetailTime(ts);
}

function stripEmojiMarksForDisplay(text) {
  let t = String(text || '');
  t = t.replace(/\[表情\][\s\S]*?\[\/表情\]/g, '');
  t = t.replace(/\[表情\]([^\]\n]+)\]/g, '');
  t = t.replace(/【表情】[\s\S]*?【\/表情】/g, '');
  t = t.replace(/\[表情包\][「『"'【\[]*[^」』"'】\]\n]*[」』"'】\]]?/g, '');
  t = t.replace(/【表情包】[「『"'【\[]*[^」』"'】\]\n]*[」』"'】\]]?/g, '');
  t = t.replace(/\[发送表情包：[^\]\n]+\]/g, '');
  t = t.replace(/\[发送表情包\]/g, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function detectBareMediaUrl(text) {
  const t = String(text || '').trim();
  if (!t || /\s/.test(t) || t.length > 512) return null;
  if (/^\/uploads\/.+\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(t)) return 'image';
  if (/^\/uploads\/.+\.(mp4|webm|mov|m4v)$/i.test(t)) return 'video';
  if (/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(t)) return 'image';
  if (/^https?:\/\/.+\.(mp4|webm|mov)(\?|$)/i.test(t)) return 'video';
  return null;
}

function formatBubbleText(text, isUser, { beans = true, keepPeriod = false } = {}) {
  if (!text) return '';
  let normalized = isUser
    ? text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    : text;
  if (!isUser) {
    normalized = stripAiContextLabels(String(normalized));
    if (isBareMediaLabel(normalized)) return '';
    normalized = stripEmojiMarksForDisplay(normalized);
    // 文字气泡不显示句末「。」（拆泡已按句号切开）；语音条保留
    if (!keepPeriod) normalized = stripDisplayPeriod(normalized);
    // 清掉漏网的定位开闭标签，避免出现单独的「[/位置]」
    normalized = String(normalized || '')
      .replace(/[\[【［]\s*\/\s*(?:发送\s*)?位置\s*[\]】］]/gi, '')
      .replace(/[\[【［]\s*(?:发送\s*)?位置\s*[\]】］]/gi, '')
      .trim();
  }
  // 语音条：不渲染小黄豆，也不留下 [微笑] 字样
  if (!beans) normalized = stripInlineBeanTokens(normalized);
  const escaped = escapeHtml(normalized);
  // 梦境不用系统小黄豆；聊天正文渲染 [微笑]
  if (isDream || !beans) return escaped;
  return renderInlineEmojiHtml(escaped);
}

function wrapBubbleWithTime({ bubbleContent, isUser, tsPos, timestamp, readTagHtml = '', isRead = true, charId }) {
  const readCls = isRead ? 'read' : 'unread';
  const timeText = `<span class="bubble-time-text ${readCls}">${formatTime(timestamp, charId)}</span>`;
  // 定位卡 / 链接卡 / 纯媒体没有文字气泡内边距，角标时间会撑开或叠在图上 → 改贴下方
  const bareMedia = /wx-location-card|location-bubble|wx-link-card|wx-web-card|bubble-media/.test(String(bubbleContent || ''));
  const pos = (tsPos === 'corner' && bareMedia) ? 'bubble' : tsPos;

  // corner = 微信/Telegram/WhatsApp：时间戳 + 已读未读同一行，永远贴气泡内右下角
  if (pos === 'corner') {
    // 顺序统一：已读/未读在左、时间在右（和微信已读标记 + 时间的阅读习惯一致）
    const timeSpan = `<span class="bubble-time-corner">${readTagHtml}${timeText}</span>`;
    const injected = bubbleContent.replace(/(<\/div>)\s*$/, `${timeSpan}$1`);
    return injected !== bubbleContent ? injected : bubbleContent + timeSpan;
  }

  if (pos === 'outside') {
    const timeHtml = `<span class="bubble-time-outside">${timeText}</span>`;
    const metaFoot = `<div class="bubble-meta-foot ${isUser ? 'user' : 'ai'}">${readTagHtml}${timeHtml}</div>`;
    if (isUser) {
      return `<div class="bubble-block user">${metaFoot}<div class="bubble-main">${bubbleContent}</div></div>`;
    }
    return `<div class="bubble-block ai"><div class="bubble-main">${bubbleContent}</div>${metaFoot}</div>`;
  }
  if (pos === 'bubble') {
    // 气泡下方：跟社交软件一样，用户靠右、角色靠左，已读与时间同一基线
    const foot = `<div class="bubble-meta-foot ${isUser ? 'user' : 'ai'} bubble-meta-foot--inline">${readTagHtml}${timeText}</div>`;
    return `<div class="bubble-stack ${isUser ? 'user' : 'ai'}">${bubbleContent}${foot}</div>`;
  }
  return bubbleContent;
}

/** 现实地图 + 城市化名：把正文里的现实城市换成对外化名 */
export function applyCityAliasToText(text, char) {
  if (!char || Number(char.real_world_map) !== 1 || Number(char.real_place_names) !== 0) {
    return String(text || '');
  }
  let pairs = [];
  if (Array.isArray(char.geo_city_aliases)) pairs = char.geo_city_aliases;
  else try { pairs = JSON.parse(char.geo_city_aliases || '[]'); } catch { pairs = []; }
  if (!Array.isArray(pairs)) pairs = [];
  const homeA = String(char.location_name || '').trim();
  const homeR = String(char.real_location || '').trim();
  if (homeA && homeR) pairs = [{ alias: homeA, real: homeR }, ...pairs];
  const addrA = String(char.home_address || '').trim();
  const addrR = String(char.real_home_address || '').trim();
  if (addrA && addrR) pairs = [{ alias: addrA, real: addrR }, ...pairs];
  let out = String(text || '');
  const seen = new Set();
  const sorted = pairs
    .map((p) => ({ alias: String(p?.alias || '').trim(), real: String(p?.real || '').trim() }))
    .filter((p) => p.alias && p.real && p.alias !== p.real)
    .sort((a, b) => b.real.length - a.real.length);
  for (const p of sorted) {
    if (seen.has(p.real)) continue;
    seen.add(p.real);
    for (const v of [p.real + '市', p.real + '省', p.real].sort((a, b) => b.length - a.length)) {
      if (out.includes(v)) out = out.split(v).join(p.alias);
    }
  }
  return out;
}

/** 查路网/打开地图：把化名城市还原成现实地名 */
export function resolveCityAliasToReal(text, char) {
  if (!char) return String(text || '');
  let pairs = [];
  if (Array.isArray(char.geo_city_aliases)) pairs = char.geo_city_aliases;
  else try { pairs = JSON.parse(char.geo_city_aliases || '[]'); } catch { pairs = []; }
  if (!Array.isArray(pairs)) pairs = [];
  const homeA = String(char.location_name || '').trim();
  const homeR = String(char.real_location || '').trim();
  if (homeA && homeR) pairs = [{ alias: homeA, real: homeR }, ...pairs];
  const addrA = String(char.home_address || '').trim();
  const addrR = String(char.real_home_address || '').trim();
  if (addrA && addrR) pairs = [{ alias: addrA, real: addrR }, ...pairs];
  let out = String(text || '');
  const seen = new Set();
  const sorted = pairs
    .map((p) => ({ alias: String(p?.alias || '').trim(), real: String(p?.real || '').trim() }))
    .filter((p) => p.alias && p.real && p.alias !== p.real)
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const p of sorted) {
    if (seen.has(p.alias)) continue;
    seen.add(p.alias);
    if (out.includes(p.alias)) out = out.split(p.alias).join(p.real);
  }
  return out;
}

function parseLatLngPair(raw) {
  const m = String(raw || '').match(/(-?\d{1,3}\.\d+)\s*[,，]\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function coordsFromLocationMsg(msg) {
  if (!msg || typeof msg !== 'object') return parseLatLngPair(msg);
  const meta = parseMessageMediaMeta(msg);
  const lat = Number(msg.lat ?? meta?.lat);
  const lng = Number(msg.lng ?? meta?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  return parseLatLngPair(msg.content) || parseLatLngPair(msg.location);
}

function parseLocationDisplay(msgOrName) {
  if (msgOrName && typeof msgOrName === 'object') {
    // 优先用带「|」的完整串（content 常比 location 字段更全）
    const loc = String(msgOrName.location || '').trim();
    const cont = String(msgOrName.content || '').trim();
    const raw = (cont.includes('|') || cont.includes('｜') ? cont : '')
      || (loc.includes('|') || loc.includes('｜') ? loc : '')
      || loc
      || cont;
    const name = String(raw || '')
      .replace(/^\[(?:发送)?位置[:：\]】]?\s*/i, '')
      .replace(/\s*[\[【]\/\s*(?:发送)?位置[\]】]\s*$/i, '')
      .trim();
    let title = name;
    let sub = '位置';
    const parts = name.split(/[|｜]/);
    if (parts.length >= 2) {
      title = parts[0].trim() || title;
      sub = parts.slice(1).join(' ').trim() || '位置';
    }
    if (msgOrName.address) sub = String(msgOrName.address).trim() || sub;
    return { title: title || '未知位置', sub };
  }
  const raw = String(msgOrName || '')
    .replace(/^\[(?:发送)?位置[:：\]】]?\s*/i, '')
    .replace(/\s*[\[【]\/\s*(?:发送)?位置[\]】]\s*$/i, '')
    .trim();
  const parts = raw.split(/[|｜]/);
  if (parts.length >= 2) {
    return { title: parts[0].trim() || '未知位置', sub: parts.slice(1).join(' ').trim() || '位置' };
  }
  return { title: raw || '未知位置', sub: '位置' };
}

/** 整段几乎只有定位标记时，按定位卡渲染（兼容解析失败落成 text 的旧消息） */
function looksLikeLocationOnlyText(msg) {
  if (!msg || msg.type === 'location' || msg.type === 'link' || msg.type === 'web_card' || msg.type === 'voice' || msg.type === 'emoji' || msg.type === 'image' || msg.type === 'video') {
    return false;
  }
  const t = String(msg.content || '').trim();
  if (!t || t.length > 80) return false;
  // 只剩闭标签：不当卡片、也不当正文（上层应跳过）
  if (/^[\[【［]\s*\/\s*(?:发送\s*)?位置\s*[\]】］]$/i.test(t)) return false;
  return /^(?:\[|【|［)\s*(?:发送\s*)?位置\s*(?:[:：\]】］])/.test(t)
    || /^\[\s*位置\s*\]/.test(t);
}

/** 纯定位指令残骸（如单独的 [/位置]），不应显示成气泡 */
function isLocationTagJunk(text) {
  const t = String(text || '').trim();
  return /^[\[【［]\s*\/?\s*(?:发送\s*)?位置\s*[\]】］]$/i.test(t);
}

function extractLocationNameFromText(raw) {
  let s = String(raw || '').trim();
  s = s
    .replace(/［/g, '[').replace(/］/g, ']')
    .replace(/^[\[【]\s*(?:发送\s*)?位置\s*[:：\]】]\s*/i, '')
    .replace(/\s*[\[【]\s*\/\s*(?:发送\s*)?位置\s*[\]】]\s*$/i, '')
    .trim();
  return s.split(/[|｜]/)[0].trim() || s || '未知位置';
}

function buildLocationBubble(nameOrMsg, isUser, char) {
  const parsed = parseLocationDisplay(nameOrMsg);
  const title = applyCityAliasToText(parsed.title, char);
  const sub = applyCityAliasToText(parsed.sub, char);
  const coords = coordsFromLocationMsg(nameOrMsg);
  // 用副标题的「城市·区·路」去查坐标，不要用短标题店名/路名单独搜
  const queryReal = resolveCityAliasToReal(
    (parsed.sub && parsed.sub !== '位置' ? parsed.sub : parsed.title),
    char,
  );
  const latAttr = coords
    ? ` data-lat="${coords.lat}" data-lng="${coords.lng}"`
    : '';
  const gpsAttr = (isUser && coords) ? ' data-loc-gps="1"' : '';
  return `
    <div class="${bubbleCls(isUser, 'location-bubble wx-location-card')}"
         role="button" tabindex="0"${latAttr}${gpsAttr}
         data-loc-title="${encodeLinkAttr(title)}"
         data-loc-sub="${encodeLinkAttr(sub)}"
         data-loc-query="${encodeLinkAttr(queryReal)}"
         title="${escapeHtml(title)}"
         onclick="window.openChatLocationCard?.(this)">
      <div class="wx-location-map" aria-hidden="true">
        <img class="wx-location-map-img" alt="" decoding="async">
        <div class="wx-location-roads"></div>
        <div class="wx-location-pin"></div>
      </div>
      <div class="wx-location-info">
        <div class="wx-location-title">${escapeHtml(title)}</div>
        <div class="wx-location-sub">${escapeHtml(sub)}</div>
      </div>
    </div>`;
}

function stripAccidentalLinkUrls(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s|｜<>"']+/gi, ' ')
    .replace(/[|｜]\s*[|｜]/g, '|')
    .replace(/^\s*[|｜]+|[|｜]+\s*$/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseLinkDisplay(msgOrRaw) {
  const raw = (msgOrRaw && typeof msgOrRaw === 'object')
    ? String(msgOrRaw.content || msgOrRaw.link || '').trim()
    : String(msgOrRaw || '').trim();
  const cleaned = stripAccidentalLinkUrls(raw
    .replace(/^\[(?:发送)?(?:链接|分享)[:：\]】]?\s*/i, '')
    .replace(/\s*[\[【]\/\s*(?:发送)?(?:链接|分享)[\]】]\s*$/i, '')
    .trim());
  let title = '';
  let body = '';
  const pipeIdx = [cleaned.indexOf('|'), cleaned.indexOf('｜')].filter((i) => i >= 0);
  if (pipeIdx.length) {
    const i = Math.min(...pipeIdx);
    title = cleaned.slice(0, i).trim();
    body = cleaned.slice(i + 1).trim();
  } else {
    const lines = cleaned.split(/\n/).map((x) => x.trim()).filter(Boolean);
    title = lines[0] || '';
    body = lines.slice(1).join('\n').trim();
  }
  if (!title) title = body ? body.slice(0, 24) : '链接';
  return { title, body };
}

function looksLikeLinkOnlyText(msg) {
  if (!msg || msg.type === 'link' || msg.type === 'location' || msg.type === 'web_card' || msg.type === 'voice' || msg.type === 'emoji' || msg.type === 'image' || msg.type === 'video') {
    return false;
  }
  const t = String(msg.content || '').trim();
  if (!t || t.length > 500) return false;
  if (/^[\[【［]\s*\/\s*(?:发送\s*)?(?:链接|分享)\s*[\]】］]$/i.test(t)) return false;
  return /^(?:\[|【|［)\s*(?:发送\s*)?(?:链接|分享)\s*(?:[:：\]】］])/.test(t);
}

function isLinkTagJunk(text) {
  const t = String(text || '').trim();
  return /^[\[【［]\s*\/?\s*(?:发送\s*)?(?:链接|分享)\s*[\]】］]$/i.test(t);
}

function encodeLinkAttr(s) {
  return encodeURIComponent(String(s || '')).replace(/'/g, '%27');
}

function buildLinkBubble(msg, isUser) {
  const { title, body } = parseLinkDisplay(msg);
  const sub = body || '链接';
  return `
    <div class="${bubbleCls(isUser, 'wx-link-card')}"
         role="button" tabindex="0"
         data-link-title="${encodeLinkAttr(title)}"
         data-link-body="${encodeLinkAttr(body)}"
         title="${escapeHtml(title)}"
         onclick="window.openChatLinkCard?.(this)">
      <div class="wx-link-copy">
        <div class="wx-link-title">${escapeHtml(title)}</div>
        <div class="wx-link-desc">${escapeHtml(sub)}</div>
      </div>
      <div class="wx-link-thumb" aria-hidden="true"></div>
    </div>`;
}

const WEB_CARD_MAX_HTML = 32 * 1024;

function titleFromHtmlSnippet(html) {
  const s = String(html || '');
  const m = s.match(/<title[^>]*>([^<]{1,80})<\/title>/i)
    || s.match(/<(?:h1|h2|h3)[^>]*>([^<]{1,48})<\/(?:h1|h2|h3)>/i)
    || s.match(/<(?:strong|b)[^>]*>([^<]{1,48})<\/(?:strong|b)>/i);
  return m ? String(m[1] || '').replace(/\s+/g, ' ').trim().slice(0, 48) : '';
}

function parseWebCardDisplay(msgOrRaw) {
  const raw = (msgOrRaw && typeof msgOrRaw === 'object')
    ? String(msgOrRaw.content || '').trim()
    : String(msgOrRaw || '').trim();
  if (!raw) return { title: '网页卡', html: '' };
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const title = String(j?.title || '').replace(/\s+/g, ' ').trim().slice(0, 48) || '网页卡';
      let html = String(j?.html || '');
      if (html.length > WEB_CARD_MAX_HTML) html = html.slice(0, WEB_CARD_MAX_HTML);
      return { title, html };
    } catch { /* fall through */ }
  }
  let body = raw
    .replace(/^\[?\s*(?:网页卡|前端卡)\s*[:：\]】］]?\s*/i, '')
    .replace(/\s*[\[【［]\s*\/\s*(?:网页卡|前端卡)\s*[\]】］]\s*$/i, '')
    .trim();
  // 裸 HTML / 中转空回复卡片：整段当 html，勿把第一行当标题撕开
  if (looksLikeStandaloneHtml(body) || /^\s*</.test(body)) {
    let html = body;
    if (html.length > WEB_CARD_MAX_HTML) html = html.slice(0, WEB_CARD_MAX_HTML);
    return { title: titleFromHtmlSnippet(html) || '提示', html };
  }
  let title = '';
  let html = '';
  const sep = body.match(/\r?\n---\r?\n/);
  if (sep) {
    title = body.slice(0, sep.index).trim();
    html = body.slice(sep.index + sep[0].length).trim();
  } else {
    const nl = body.indexOf('\n');
    if (nl >= 0) {
      title = body.slice(0, nl).trim();
      html = body.slice(nl + 1).trim();
    } else {
      title = body;
    }
  }
  title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 48) || '网页卡';
  if (html.length > WEB_CARD_MAX_HTML) html = html.slice(0, WEB_CARD_MAX_HTML);
  return { title, html };
}

function looksLikeWebCardOnlyText(msg) {
  if (!msg || msg.type === 'web_card' || msg.type === 'link' || msg.type === 'location'
    || msg.type === 'voice' || msg.type === 'emoji' || msg.type === 'image' || msg.type === 'video') {
    return false;
  }
  const t = String(msg.content || '').trim();
  if (!t || t.length > WEB_CARD_MAX_HTML + 200) return false;
  return looksLikeWebCardPayload(t);
}

function isWebCardTagJunk(text) {
  const t = String(text || '').trim();
  return /^[\[【［]\s*\/?\s*(?:网页卡|前端卡)\s*[\]】］]$/i.test(t);
}

function buildWebCardSrcdoc(html) {
  const body = String(html || '');
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "img-src data: https: blob:",
    "font-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body style="margin:0;padding:8px;box-sizing:border-box;">${body}</body></html>`;
}

function buildWebCardBubble(msg, isUser) {
  const { title, html } = parseWebCardDisplay(msg);
  return `
    <div class="${bubbleCls(isUser, 'wx-web-card')}"
         role="button" tabindex="0"
         data-web-title="${encodeLinkAttr(title)}"
         data-web-html="${encodeLinkAttr(html)}"
         title="${escapeHtml(title)}"
         onclick="window.openChatWebCard?.(this)">
      <div class="wx-web-card-head">
        <div class="wx-web-card-title">${escapeHtml(title)}</div>
        <div class="wx-web-card-badge">网页卡</div>
      </div>
      <div class="wx-web-card-preview" aria-hidden="true">
        <iframe class="wx-web-card-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" tabindex="-1"></iframe>
        <div class="wx-web-card-hit"></div>
      </div>
    </div>`;
}

export function resolveBubbleFontSizePx(cs) {
  cs = cs || getChatSettings();
  const n = Number(cs.bubbleFontSizePx);
  if (Number.isFinite(n)) return Math.min(24, Math.max(12, Math.round(n)));
  const legacy = { small: 13, medium: 15, large: 17 }[cs.bubbleFontSize];
  return legacy || 15;
}

export function resolveBubbleSizeScale(cs) {
  cs = cs || getChatSettings();
  const n = Number(cs.bubbleSizePct);
  if (!Number.isFinite(n)) return 1;
  return Math.min(140, Math.max(70, Math.round(n))) / 100;
}

export function resolveBubbleFontFamily(cs) {
  cs = cs || getChatSettings();
  return resolvePaperFont(cs.bubbleFont || 'sans').family;
}

export function resolveBubbleTextColor(cs) {
  cs = cs || getChatSettings();
  return String(cs.bubbleTextColor || '').trim() === 'white' ? 'white' : 'black';
}

export function resolveBubbleGapPx(cs) {
  cs = cs || getChatSettings();
  const n = Number(cs.bubbleGapPx);
  if (!Number.isFinite(n)) return 5;
  return Math.min(28, Math.max(0, Math.round(n)));
}

export function parseMessageMediaMeta(msg) {
  try {
    return typeof msg?.media_meta === 'string'
      ? JSON.parse(msg.media_meta || '{}')
      : (msg?.media_meta || {});
  } catch {
    return {};
  }
}

const BARE_POKE_SUFFIX_RE = /^(的)?(脑袋|脑袋瓜|头|头顶|脑门|后脑勺|肩膀|肩|脸颊|脸|脸蛋|狗头|发梢|头发|额头|鼻子|耳朵|胳膊|手臂|手|背|腰|屁股)$/;

export function isHiddenChatMessage(msg) {
  const meta = parseMessageMediaMeta(msg);
  // 小机麦克风上行：给模型听，不在聊天页显示语音条
  if (meta.robotMic) return true;
  if (meta.hideChat || meta.hiddenChat) return true;
  try {
    const j = JSON.parse(String(msg.content || ''));
    if (j && (j.ambience || j.texture || j.breathBed)) return true;
  } catch {}
  const type = String(msg.type || 'text');
  if ((type === 'text' || type === '') && BARE_POKE_SUFFIX_RE.test(String(msg.content || '').trim())) {
    return true;
  }
  if (type === 'system' && parseCallSystemRecord(msg.content)?.kind === 'hide') return true;
  return false;
}

export function buildCallRecordHtml(rec, msg = {}) {
  if (!rec || rec.kind === 'hide') return '';
  const icon = rec.video ? '📹' : '📞';
  const idEsc = escapeHtml(String(msg.id ?? ''));
  const dbEsc = escapeHtml(String(msg.dbId ?? msg.id ?? ''));
  const endClass = rec.kind === 'start' ? '' : ' is-end';
  const htmlId = msg.htmlId ? ` id="${escapeHtml(String(msg.htmlId))}"` : '';
  return `<div class="bubble-time chat-sys-tip call-record${endClass}"${htmlId} data-id="${idEsc}" data-msg-id="${dbEsc}">${icon} ${escapeHtml(rec.label)}</div>`;
}

const ROBOT_MOTION_ZH = {
  nod: '点头', shake: '摇头', tilt: '歪头', look_user: '看向你',
  look_left: '往左看', look_right: '往右看', look_up: '抬头', look_down: '低头',
};
const ROBOT_EMOTION_ZH = {
  happy: '开心', sad: '难过', angry: '生气', shy: '害羞',
  surprised: '惊讶', sleepy: '困', love: '喜欢',
};

/**
 * 桌上小机的对话与动作不走微信气泡，改成带「小机」标签的居中旁白。
 * 聊天页里手机聊的和桌边发生的必须一眼分得开，不然连角色都会混。
 */
function buildRobotAsideHtml(msg, char) {
  const meta = parseMessageMediaMeta(msg);
  if (!meta.robot) return null;
  const content = String(msg.content || '').trim();
  const name = String(char?.name || '').trim() || '对方';
  // 小机镜头拍到的那一帧：跟旁白同一套视觉，但要真能看见图
  const msgIdEsc = escapeHtml(String(msg.id));
  const dbIdEsc = escapeHtml(String(msg.dbId ?? msg.id));
  const idAttrs = ` data-id="${msgIdEsc}" data-msg-id="${dbIdEsc}" data-role="${msg.role || ''}"`;
  if (meta.robotFrame && content) {
    const src = escapeHtml(content);
    const cap = escapeHtml(String(meta.robotFrameCaption || '').trim() || `${name} 借小机看了一眼`);
    return `<div class="bubble-time robot-aside robot-aside-frame"${idAttrs}>`
      + `<div class="robot-aside-line"><span class="robot-aside-tag">小机</span>${cap}</div>`
      + `<img class="robot-aside-img" src="${src}" alt="" loading="lazy" decoding="async"`
      + ` data-media-url="${src}" data-media-type="image" title="点击放大"`
      + ` onclick="window.openChatMediaViewerFromEl?.(this)">`
      + `</div>`;
  }
  if (meta.robotEvent === 'listening' || meta.robotEvent === 'listening_done') {
    const text = content || '用户正对小机讲话';
    const ts = Date.parse(msg.timestamp || '') || 0;
    const stale = ts > 0 && (Date.now() - ts > 35000);
    const done = meta.robotEvent === 'listening_done' || stale;
    return `<div class="bubble-time robot-aside robot-aside-listening${done ? ' robot-aside-listening-done' : ''}"${idAttrs}>`
      + `<span class="robot-aside-tag">小机</span>${escapeHtml(text)}`
      + `<span class="robot-listening-dots" aria-hidden="true"><i></i><i></i><i></i></span>`
      + `</div>`;
  }
  let text = '';
  if (meta.robotEvent) {
    text = content;
  } else if (meta.source === 'head_touch') {
    text = /摸/.test(content) ? '你摸了摸它的头顶' : '你点了点它的头顶';
  } else if (!content) {
    return '';
  } else if (msg.role === 'user') {
    text = `你对它说：${content}`;
  } else {
    const tone = [
      ROBOT_EMOTION_ZH[meta.emotion] || '',
      meta.motionRaw || ROBOT_MOTION_ZH[meta.motion] || '',
    ].filter(Boolean).join('·');
    text = `${name}：${content}${tone ? `（${tone}）` : ''}`;
  }
  if (!text) return '';
  return `<div class="bubble-time robot-aside"${idAttrs}><span class="robot-aside-tag">小机</span>${escapeHtml(text)}</div>`;
}

export function buildBubble(msg, char, settings, opts = {}) {
  if (isHiddenChatMessage(msg)) return '';
  if (!msg.recalled) {
    const robotAside = buildRobotAsideHtml(msg, char);
    if (robotAside !== null) return robotAside;
  }
  // 系统提示（拍一拍、通话记录等）
  if (msg.type === 'system') {
    if (String(msg.content || '').startsWith('__special__')) return '';
    const rec = parseCallSystemRecord(msg.content);
    if (rec) return buildCallRecordHtml(rec, msg);
    const sysIdEsc = escapeHtml(String(msg.id));
    const sysDbEsc = escapeHtml(String(msg.dbId ?? msg.id));
    return `<div class="bubble-time poke-hint" data-id="${sysIdEsc}" data-msg-id="${sysDbEsc}" data-role="${msg.role || 'assistant'}">${escapeHtml(msg.content || '')}</div>`;
  }

  const isUser = msg.role === 'user';

  // 撤回消息：仿微信，居中系统提示行，点击该行查看原文（不再单独放"查看"按钮）
  if (msg.recalled) {
    const label = isUser ? '你撤回了一条消息' : '对方撤回了一条消息';
    const msgIdEsc = escapeHtml(String(msg.id));
    const dbIdEsc = escapeHtml(String(msg.dbId ?? msg.id));
    return `<div class="bubble-time recall-hint" data-id="${msgIdEsc}" data-msg-id="${dbIdEsc}" data-role="${msg.role}" onclick="window.showRecalledMsg?.('${msgIdEsc}')">${escapeHtml(label)}</div>`;
  }

  // 定位/链接标记残骸不渲染
  if (msg.type !== 'location' && isLocationTagJunk(msg.content)) return '';
  if (msg.type !== 'link' && isLinkTagJunk(msg.content)) return '';
  if (msg.type !== 'web_card' && isWebCardTagJunk(msg.content)) return '';

  const bubbleCharId = opts.charId ?? char?.id ?? null;
  const cs = getChatSettings(bubbleCharId);

  // 头像设置（用户和角色分别控制）
  const showUserAvatar = cs.showUserAvatar !== false;   // 默认显示
  const showCharAvatar = cs.showCharAvatar !== false;   // 默认显示
  const userAvatarRadius = cs.userAvatarRadius ?? 50;
  const charAvatarRadius = cs.charAvatarRadius ?? 50;

  let bubbleContent = '';
  if (msg.type === 'voice') {
    bubbleContent = buildVoiceMessage(msg, char);
  } else if (msg.type === 'location' || looksLikeLocationOnlyText(msg)) {
    // 位置消息固定微信卡片样式；兼容旧消息 type 仍是 text 但内容是定位标记
    const locMsg = msg.type === 'location' ? msg : {
      ...msg,
      type: 'location',
      location: extractLocationNameFromText(msg.content || msg.location || ''),
      content: extractLocationNameFromText(msg.content || msg.location || ''),
    };
    bubbleContent = buildLocationBubble(locMsg, isUser, char);
  } else if (msg.type === 'link' || looksLikeLinkOnlyText(msg)) {
    const linkMsg = msg.type === 'link' ? msg : {
      ...msg,
      type: 'link',
      content: String(msg.content || '').trim(),
    };
    bubbleContent = buildLinkBubble(linkMsg, isUser);
  } else if (msg.type === 'web_card' || looksLikeWebCardOnlyText(msg)) {
    const cardMsg = msg.type === 'web_card' ? msg : {
      ...msg,
      type: 'web_card',
      content: String(msg.content || '').trim(),
    };
    bubbleContent = buildWebCardBubble(cardMsg, isUser);
  } else if (msg.type === 'video') {
    const raw = String(msg.content || '');
    const pendingMatch = raw.match(/^__pending_video__(?::([\d:]+))?$/);
    const failedMatch = raw.match(/^__video_failed__(?::([\d:]+))?$/);
    const charVideoAspect = String(char?.video_aspect || char?.image_aspect || '9:16').trim() || '9:16';
    if (pendingMatch) {
      const aspect = pendingMatch[1] || charVideoAspect;
      const ar = aspect.replace(':', '/');
      bubbleContent = `<div class="bubble-media bubble-media-pending" data-pending-video="1" data-aspect="${escapeHtml(aspect)}" style="aspect-ratio:${escapeHtml(ar)}"><span class="bubble-media-pending-dots">·&nbsp;·&nbsp;·</span></div>`;
    } else if (failedMatch) {
      const aspect = failedMatch[1] || charVideoAspect;
      const ar = aspect.replace(':', '/');
      bubbleContent = `<div class="bubble-media bubble-media-failed" data-failed-video="1" data-aspect="${escapeHtml(aspect)}" style="aspect-ratio:${escapeHtml(ar)}" title="生成失败，点击重试" onclick="window.rerollFailedMediaBubble?.(this)"><span>视频生成失败<br><small>点击重试</small></span></div>`;
    } else {
      const mediaSrc = escapeMediaUrl(raw);
      bubbleContent = buildVideoThumbHtml(mediaSrc);
    }
  } else if (msg.type === 'emoji') {
    const mediaSrc = escapeMediaUrl(liveStickerSrc(msg.content));
      bubbleContent = `<img class="bubble-media bubble-sticker" src="${mediaSrc}" alt="" loading="lazy" decoding="async" data-media-url="${mediaSrc}" data-media-type="image" ${stickerRetryOnError()} onclick="window.openChatMediaViewerFromEl?.(this)">`;
  } else if (msg.type === 'image') {
    const raw = String(msg.content || '');
    const pendingMatch = raw.match(/^__pending_selfie__(?::([\d:]+))?$/);
    const failedMatch = raw.match(/^__selfie_failed__(?::([\d:]+))?$/);
    const charImageAspect = String(char?.image_aspect || '3:4').trim() || '3:4';
    if (pendingMatch) {
      const aspect = pendingMatch[1] || charImageAspect;
      const ar = aspect.replace(':', '/');
      bubbleContent = `<div class="bubble-media bubble-media-pending" data-pending-selfie="1" data-aspect="${escapeHtml(aspect)}" style="aspect-ratio:${escapeHtml(ar)}"><span class="bubble-media-pending-dots">·&nbsp;·&nbsp;·</span></div>`;
    } else if (failedMatch) {
      const aspect = failedMatch[1] || charImageAspect;
      const ar = aspect.replace(':', '/');
      bubbleContent = `<div class="bubble-media bubble-media-failed" data-failed-selfie="1" data-aspect="${escapeHtml(aspect)}" style="aspect-ratio:${escapeHtml(ar)}" title="生成失败，点击重试" onclick="window.rerollFailedMediaBubble?.(this)"><span>生图失败<br><small>点击重试</small></span></div>`;
    } else {
      const mediaSrc = escapeMediaUrl(raw);
      bubbleContent = `<img class="bubble-media" src="${mediaSrc}" alt="" loading="lazy" decoding="async" data-media-url="${mediaSrc}" data-media-type="image" title="点击放大" onclick="window.openChatMediaViewerFromEl?.(this)">`;
    }
  } else if (!isUser && (msg.type === 'text' || !msg.type)) {
    const bareMedia = detectBareMediaUrl(msg.content);
    if (bareMedia === 'video') {
      const mediaSrc = escapeMediaUrl(String(msg.content).trim());
      bubbleContent = buildVideoThumbHtml(mediaSrc);
    } else if (bareMedia === 'image') {
      const mediaSrc = escapeMediaUrl(String(msg.content).trim());
      bubbleContent = `<img class="bubble-media" src="${mediaSrc}" alt="" loading="lazy" decoding="async" data-media-url="${mediaSrc}" data-media-type="image" title="点击放大" onclick="window.openChatMediaViewerFromEl?.(this)">`;
    } else {
      const displayContent = stripImageDirective(msg.content);
      let formatted = formatBubbleText(displayContent, isUser);
      if (!formatted.trim() && String(displayContent || '').trim()) {
        formatted = escapeHtml(String(displayContent).trim());
      }
      if (!formatted.trim()) return '';
      bubbleContent = textBubbleHtml(isUser, formatted);
    }
  } else {
    const displayContent = isUser ? msg.content : stripImageDirective(msg.content);
    let formatted = formatBubbleText(displayContent, isUser);
    if (!isUser && !formatted.trim() && String(displayContent || '').trim()) {
      formatted = escapeHtml(String(displayContent).trim());
    }
    if (!isUser && !formatted.trim()) return '';
    bubbleContent = textBubbleHtml(isUser, formatted);
  }

  // 头像 HTML
  let avatarHtml = '';
  if (isUser && showUserAvatar) {
    const appAvatar = (typeof window !== 'undefined' && window.getAppSettings?.()?.user_avatar) || '';
    const src = appAvatar || cs.userAvatarUrl || '';
    avatarHtml = src
      ? `<img class="avatar avatar-sm" src="${escapeHtml(src)}" alt="" style="border-radius:${userAvatarRadius}%">`
      : `<div class="avatar avatar-sm" style="border-radius:${userAvatarRadius}%;background:var(--theme-light);color:var(--theme-dark);font-size:12px">我</div>`;
  } else if (!isUser && showCharAvatar) {
    if (char?.avatar) {
      avatarHtml = `<img class="avatar avatar-sm" src="${escapeHtml(char.avatar)}" alt=""
        style="border-radius:${charAvatarRadius}%;object-fit:cover"
        onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar avatar-sm',textContent:'👤',style:'border-radius:${charAvatarRadius}%;font-size:18px;display:flex;align-items:center;justify-content:center'}))">`;
    } else {
      avatarHtml = `<div class="avatar avatar-sm" style="border-radius:${charAvatarRadius}%;font-size:18px;display:flex;align-items:center;justify-content:center;background:var(--theme-light)">👤</div>`;
    }
  }
  const noAvatar = !avatarHtml;
  const isMedia = !msg.recalled && (msg.type === 'emoji' || msg.type === 'image' || msg.type === 'video' || msg.type === 'voice' || msg.type === 'location' || msg.type === 'link' || msg.type === 'web_card');

  const tsPos = cs.timestampPosition || 'divider';

  // 已读/未读标志（用户消息和角色消息都显示）
  const msgIdEsc = escapeHtml(String(msg.id));
  const dbIdEsc = escapeHtml(String(msg.dbId ?? msg.id));
  const isRead = msg.is_read === 1 || msg.is_read === true;
  let readTagHtml = '';
  let readTagInColHtml = '';
  if (!msg.recalled && msg.type !== 'system') {
    const label = isRead ? '已读' : '未读';
    const cls = isRead ? 'read' : 'unread';
    readTagHtml = `<span class="bubble-read-tag ${cls}" data-msg-id="${msgIdEsc}">${label}</span>`;
    // divider 模式没有逐条时间戳可依附，已读/未读单独占一行；
    // 其余模式（corner/bubble/outside）都跟时间戳拼在一起，不再另起一行显得脱节
    if (tsPos === 'divider') {
      const rowAlign = isUser ? 'flex-end' : 'flex-start';
      readTagInColHtml = `<div class="bubble-read-tag-row" style="justify-content:${rowAlign}">${readTagHtml}</div>`;
      readTagHtml = '';
    }
  }

  const bodyContent = wrapBubbleWithTime({
    bubbleContent,
    isUser,
    tsPos,
    timestamp: msg.timestamp,
    readTagHtml,
    isRead,
    charId: bubbleCharId,
  });

  const undelivered = !isUser && !msg.recalled
    && (msg.delivery_status === 'peer_undelivered' || msg.delivery_status === 'failed');
  const userBlocked = isUser && !msg.recalled
    && (msg.delivery_status === 'blocked_by_peer' || msg.delivery_status === 'deleted_by_peer');
  const failTitle = userBlocked
    ? (msg.delivery_status === 'deleted_by_peer' ? '对方已把你删除' : '对方已把你拉黑')
    : '对方已不是好友 / 已拉黑，角色认为你看不到';
  const failIcon = (undelivered || userBlocked)
    ? `<span class="bubble-undelivered" title="${failTitle}">!</span>`
    : '';

  const wrapExtras = [noAvatar ? 'no-avatar' : '', isMedia ? 'align-top' : '', (undelivered || userBlocked) ? 'has-undelivered' : ''];
  const inner = `
    <div class="${wrapCls(isUser, wrapExtras)}" data-id="${msgIdEsc}" data-msg-id="${dbIdEsc}" data-role="${msg.role}"
         oncontextmenu="showContextMenu(event)">
      ${avatarHtml}
      <div class="bubble-col">
        <div class="bubble-row-with-status">${bodyContent}${failIcon}</div>
        ${buildReplyUnderHtml(msg, isUser)}
        ${readTagInColHtml}
      </div>
    </div>
  `;
  const rawId = String(msg.id || '');
  if (!rawId) return inner;
  return `<div class="bubble-swipe-row">
    <div class="bubble-swipe-track">
      <div class="bubble-swipe-front">${inner}</div>
      <button type="button" class="bubble-swipe-del" aria-label="删除">删除</button>
    </div>
  </div>`;
}

function buildVoicePlayIcon() {
  return `<span class="voice-play-icon" onclick="event.stopPropagation();playVoiceMsg(this)" title="播放"><span class="icon-play"></span><span class="icon-pause"><i></i><i></i></span></span>`;
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

function parseUserVoiceContent(content) {
  const raw = String(content || '').trim();
  if (!raw.startsWith('{')) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.voice === true && j.url) return j;
  } catch {}
  return null;
}

export function encodeUserVoiceContent({ url, duration = 1, transcript = '', voiceprint = null } = {}) {
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

function buildReplyUnderHtml(msg, isUser) {
  const preview = String(msg.reply_preview || msg.replyPreview || '').trim();
  if (!preview) return '';
  const toId = msg.reply_to_id || msg.replyToId || '';
  return `<div class="bubble-reply-under ${isUser ? 'user' : 'ai'}"
    data-reply-to="${escapeHtml(String(toId))}"
    data-reply-preview="${escapeHtml(preview.slice(0, 80))}"
    role="button" title="定位到原文位置">
    <div class="bubble-reply-text">${escapeHtml(preview.slice(0, 80))}</div>
  </div>`;
}

function buildVoiceMessage(msg, char) {
  const album = parseAlbumVoiceContent(msg.content);
  const userVoice = !album ? parseUserVoiceContent(msg.content) : null;
  const clipUrl = resolvedMediaUrl(album?.url || userVoice?.url || '');
  const isScore = !!(userVoice && userVoice.score);
  const isSfx = !!(userVoice && userVoice.sfx);
  const isVocal = !!(userVoice && userVoice.vocal);
  // TTS 保留 [软声]/[沉声]；转写/展示再剥掉
  const voiceTextRaw = album
    ? (album.label || '语音')
    : (userVoice
      ? (userVoice.transcript || (isScore ? '♪ 演奏' : (isSfx ? '环境音' : (isVocal ? '……' : '语音'))))
      : stripImageDirective(msg.content || '', { keepVoiceLanes: true }));
  const labelOnly = !album && !userVoice && isBareMediaLabel(stripAiContextLabels(String(voiceTextRaw || '')));
  // 语音气泡不带小黄豆（转文字 / TTS 都不保留）
  const voiceFallback = album || userVoice
    ? (isScore ? '♪ 演奏' : (isSfx ? '环境音' : (isVocal ? '……' : '语音')))
    : '语音';
  let voiceTextForTts = labelOnly ? '' : (stripInlineBeanTokens(voiceTextRaw) || (album || userVoice ? voiceFallback : ''));
  if (!album && !isScore && !isSfx && voiceTextForTts) voiceTextForTts = keepVoicePeriod(voiceTextForTts) || voiceTextForTts;
  let voiceText = stripVoiceLaneTags(voiceTextForTts).trim();
  if (labelOnly || isBareMediaLabel(voiceText)) voiceText = '';
  if (!album && !isScore && !isSfx && voiceText) voiceText = keepVoicePeriod(voiceText) || voiceText;
  const dur = Math.max(1, Math.min(60, Math.round(Number(
    msg.voice_duration
    || userVoice?.duration
    || Math.ceil((String(voiceText).length || 10) / 4)
  ) || 1)));
  // 用两组不同频率的正弦波叠加出更自然、不规则的"波形"高低起伏，避免机械的锯齿重复感
  const barCount = Math.min(28, Math.max(14, Math.floor(dur * 2.2)));
  const bars = Array.from({ length: barCount }, (_, i) => {
    const wave = Math.sin(i * 1.8) * 0.5 + Math.sin(i * 0.75 + 1.3) * 0.35;
    const h = Math.round(5 + (0.5 + wave * 0.5) * 13);
    const delay = ((i * 7) % 12) / 10;
    return `<div class="voice-bar" style="height:${Math.max(4, Math.min(18, h))}px;animation-delay:${delay}s"></div>`;
  }).join('');
  const voiceId = escapeHtml(char?.voice_id || '');
  const voiceSrcAttr = clipUrl ? ` data-voice-src="${escapeHtml(clipUrl)}"` : '';
  const scoreAttr = isScore ? ' data-score="1"' : '';
  let ttsEmotion = String(msg?.tts_emotion || '').trim();
  let ttsTone = String(msg?.tts_tone || '').trim();
  if (!ttsEmotion || !ttsTone) {
    try {
      const meta = typeof msg?.media_meta === 'string'
        ? JSON.parse(msg.media_meta || '{}')
        : (msg?.media_meta || {});
      if (!ttsEmotion) ttsEmotion = String(meta?.tts_emotion || '').trim();
      if (!ttsTone) ttsTone = String(meta?.tts_tone || '').trim();
    } catch { /* ignore */ }
  }
  const ttsEmotionAttr = ttsEmotion ? ` data-tts-emotion="${escapeHtml(ttsEmotion)}"` : '';
  const ttsToneAttr = ttsTone ? ` data-tts-tone="${escapeHtml(ttsTone)}"` : '';
  const isAi = msg.role !== 'user';
  const playIcon = buildVoicePlayIcon();
  const voiceTextAttr = escapeHtml(voiceTextForTts);
  const canTranscript = labelOnly
    ? false
    : (!userVoice || !!String(userVoice.transcript || '').trim() || !!album);
  const transcriptTitle = canTranscript ? '点击转文字' : '点击播放';
  const transcriptHtml = canTranscript
    ? formatBubbleText(voiceText, false, { beans: false, keepPeriod: true })
    : '<span style="opacity:.65">语音消息</span>';
  // 用户语音：无转写时点气泡直接播放
  const bubbleClick = (!isAi && !canTranscript && clipUrl)
    ? `onclick="playVoiceMsg(this)"`
    : `onclick="toggleVoiceTranscript(this)"`;
  // 气泡内横排：播放键 → 波形 → 时长（在浪尾）
  return `
    <div class="voice-message${isScore ? ' voice-score' : ''}${isSfx ? ' voice-sfx' : ''}${isVocal ? ' voice-vocal' : ''}">
      <div class="${bubbleCls(!isAi, 'voice-bubble')}"
           data-voice-id="${voiceId}"
           data-voice-text="${voiceTextAttr}"
           data-voice-duration="${dur}"${voiceSrcAttr}${scoreAttr}${ttsEmotionAttr}${ttsToneAttr}
           ${bubbleClick}
           title="${transcriptTitle}">
        ${playIcon}
        <div class="voice-wave">${bars}</div>
        <span class="voice-duration" aria-label="时长 ${dur} 秒">${dur}"</span>
        <span class="voice-text-src" style="display:none">${formatBubbleText(voiceText, false, { beans: false })}</span>
      </div>
      <div class="voice-transcript-box">
        <div class="voice-transcript-inner">${transcriptHtml}</div>
      </div>
    </div>
  `;
}

export function buildTimeDivider(dateStr, charId) {
  return `<div class="bubble-time">${formatTime(dateStr, charId)}</div>`;
}

export function buildTypingIndicator() {
  return `
    <div class="${wrapCls(false)}" id="typing-indicator">
      <div class="avatar avatar-sm"></div>
      <div class="${bubbleCls(false)}" style="padding:12px 16px">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    </div>
  `;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function sendAndReceive({
  charId, content, type = 'text', location, isDreamMode,
  messagesEl, char, onUserMsg, onAiMsg, onBusy, onError
}) {
  if (!content.trim() && type === 'text') return;

  const userMsgHtml = buildBubble({
    id: 'tmp_' + Date.now(),
    role: 'user', content, type,
    timestamp: new Date().toISOString(),
  }, char, {});

  onUserMsg?.(userMsgHtml);

  // Show typing
  const typingDelay = Math.random() * 2000 + 1000;
  await sleep(typingDelay);

  try {
    const result = await api.sendMessage({
      characterId: charId,
      content,
      type,
      location,
      isDream: isDreamMode,
    });

    if (result.isBusy) {
      onBusy?.(result.autoReply);
      return;
    }

    if (result.content) {
      playNotifySound();
      onAiMsg?.(result);
    }
  } catch (e) {
    onError?.(e.message);
  }
}

window.openChatMediaViewerFromEl = function(el) {
  const url = resolvedMediaUrl(el?.dataset?.mediaUrl || el?.src);
  const type = el?.dataset?.mediaType || 'image';
  const wrap = el?.closest?.('.bubble-wrap');
  const msgId = wrap?.dataset?.id || wrap?.dataset?.msgId || '';
  const role = wrap?.dataset?.role || '';
  const isSticker = !!el?.classList?.contains('bubble-sticker');
  if (url) window.openChatMediaViewer?.(url, type, { messageId: msgId, role, isSticker });
};

window.rerollFailedMediaBubble = async function(el) {
  const wrap = el?.closest?.('.bubble-wrap');
  const msgId = wrap?.dataset?.id || wrap?.dataset?.msgId || '';
  if (!msgId || !/^\d+$/.test(String(msgId))) {
    window.showToast?.('这条消息无法重新生成');
    return;
  }
  try {
    el.style.pointerEvents = 'none';
    await api.rerollMediaMessage(msgId);
    window.showToast?.(el?.dataset?.failedVideo ? '正在重新生成视频…' : '正在重新生成图片…');
  } catch (err) {
    window.showToast?.(err?.message || '重新生成失败');
    el.style.pointerEvents = '';
  }
};

window.openChatMediaViewer = function(url, type = 'image', opts = {}) {
  const overlay = document.getElementById('chat-media-viewer');
  const img = document.getElementById('chat-media-viewer-img');
  const video = document.getElementById('chat-media-viewer-video');
  const rerollBtn = document.getElementById('chat-media-reroll-btn');
  if (!overlay || !url) return;
  const mediaUrl = resolvedMediaUrl(url);
  overlay.dataset.messageId = opts.messageId ? String(opts.messageId) : '';
  overlay.dataset.mediaType = type === 'video' ? 'video' : 'image';
  if (rerollBtn) {
    const role = String(opts.role || '');
    const canReroll = (role === 'ai' || role === 'assistant') && !opts.isSticker;
    const mid = String(opts.messageId || '');
    const okId = mid && !mid.startsWith('hist_') && /^\d+$/.test(mid);
    rerollBtn.style.display = canReroll && okId ? 'inline-flex' : 'none';
    rerollBtn.disabled = false;
    rerollBtn.textContent = type === 'video' ? '重新生成此视频' : '重新生成此图';
  }
  if (type === 'video') {
    if (img) img.style.display = 'none';
    if (video) {
      video.style.display = 'block';
      video.src = mediaUrl;
      video.play().catch(() => {});
    }
  } else {
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load?.();
      video.style.display = 'none';
    }
    if (img) {
      img.style.display = 'block';
      img.src = mediaUrl;
    }
  }
  overlay.style.display = 'flex';
  overlay.classList.add('active');
};

window.closeChatMediaViewer = function(e) {
  if (e && e.target !== e.currentTarget && !e.target?.classList?.contains('chat-media-viewer-close')
    && !e.target?.classList?.contains('chat-media-reroll-btn')) return;
  if (e?.target?.classList?.contains('chat-media-reroll-btn')) return;
  const overlay = document.getElementById('chat-media-viewer');
  const video = document.getElementById('chat-media-viewer-video');
  const rerollBtn = document.getElementById('chat-media-reroll-btn');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load?.();
  }
  if (rerollBtn) rerollBtn.style.display = 'none';
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('active');
    delete overlay.dataset.messageId;
  }
};

window.rerollMediaFromViewer = async function(e) {
  e?.stopPropagation?.();
  const overlay = document.getElementById('chat-media-viewer');
  const btn = document.getElementById('chat-media-reroll-btn');
  const id = overlay?.dataset?.messageId;
  if (!id) {
    window.showToast?.('这条消息无法单独重新生成');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    await api.rerollMediaMessage(id);
    window.showToast?.(overlay?.dataset?.mediaType === 'video' ? '正在重新生成视频…' : '正在重新生成图片…');
    window.closeChatMediaViewer?.();
  } catch (err) {
    window.showToast?.('重新生成失败: ' + (err.message || err));
    if (btn) {
      btn.disabled = false;
      btn.textContent = overlay?.dataset?.mediaType === 'video' ? '重新生成此视频' : '重新生成此图';
    }
  }
};

function decodeLinkAttr(s) {
  try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); }
}

window.openChatLinkCard = function(el) {
  if (!el) return;
  if (document.getElementById('messages-list')?.classList.contains('chat-select-mode')) return;
  if (document.getElementById('context-menu')?.classList.contains('active')) return;
  const overlay = document.getElementById('chat-link-sheet');
  const titleEl = document.getElementById('chat-link-sheet-title');
  const bodyEl = document.getElementById('chat-link-sheet-text');
  const openBtn = document.getElementById('chat-link-sheet-open');
  if (!overlay) return;
  const title = decodeLinkAttr(el.dataset.linkTitle || '');
  const body = decodeLinkAttr(el.dataset.linkBody || '');
  if (titleEl) titleEl.textContent = title || '链接';
  if (bodyEl) {
    bodyEl.textContent = body || '';
    bodyEl.style.display = body ? '' : 'none';
  }
  if (openBtn) {
    openBtn.style.display = 'none';
    openBtn.onclick = null;
  }
  overlay.style.display = 'flex';
  overlay.classList.add('active');
};

window.closeChatLinkSheet = function() {
  const overlay = document.getElementById('chat-link-sheet');
  if (!overlay) return;
  overlay.classList.remove('active');
  overlay.style.display = 'none';
};

window.openChatWebCard = function(el) {
  if (!el) return;
  if (document.getElementById('messages-list')?.classList.contains('chat-select-mode')) return;
  if (document.getElementById('context-menu')?.classList.contains('active')) return;
  const overlay = document.getElementById('chat-web-card-sheet');
  const titleEl = document.getElementById('chat-web-card-sheet-title');
  const frame = document.getElementById('chat-web-card-sheet-frame');
  if (!overlay || !frame) return;
  const title = decodeLinkAttr(el.dataset.webTitle || '');
  const html = decodeLinkAttr(el.dataset.webHtml || '');
  if (titleEl) titleEl.textContent = title || '网页卡';
  frame.removeAttribute('src');
  frame.srcdoc = buildWebCardSrcdoc(html);
  overlay.style.display = 'flex';
  overlay.classList.add('active');
};

window.closeChatWebCardSheet = function() {
  const overlay = document.getElementById('chat-web-card-sheet');
  const frame = document.getElementById('chat-web-card-sheet-frame');
  if (frame) {
    frame.removeAttribute('srcdoc');
    frame.removeAttribute('src');
  }
  if (!overlay) return;
  overlay.classList.remove('active');
  overlay.style.display = 'none';
};

export function hydrateWebCards(scope) {
  const root = scope && typeof scope.querySelectorAll === 'function' ? scope : document;
  root.querySelectorAll('.wx-web-card').forEach((card) => {
    const frame = card.querySelector('.wx-web-card-frame');
    if (!frame || frame.dataset.hydrated === '1') return;
    const html = decodeLinkAttr(card.dataset.webHtml || '');
    if (!html) return;
    frame.srcdoc = buildWebCardSrcdoc(html);
    frame.dataset.hydrated = '1';
  });
  hydrateVideoThumbs(root);
}

function locationCardQuery(el) {
  const title = decodeLinkAttr(el?.dataset?.locTitle || '');
  const sub = decodeLinkAttr(el?.dataset?.locSub || '');
  const q = decodeLinkAttr(el?.dataset?.locQuery || '');
  if (q) return q;
  if (sub && sub !== '位置') return sub;
  return title || '位置';
}

function locationCardCoords(el) {
  const lat = parseFloat(el?.dataset?.lat);
  const lng = parseFloat(el?.dataset?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  return null;
}

/** OSM/GPS 是 WGS-84；高德/腾讯要 GCJ-02，不转过去针会偏，甚至不落点 */
function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function gcjDelta(lat, lng) {
  const x = lng - 105;
  const y = lat - 35;
  let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  dLat += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  dLat += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  let dLng = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLng += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  dLng += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  dLng += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  const rad = lat / 180 * Math.PI;
  const magic = 1 - 0.00669342162296594323 * Math.sin(rad) * Math.sin(rad);
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((6378245.0 * (1 - 0.00669342162296594323)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180) / (6378245.0 / sqrtMagic * Math.cos(rad) * Math.PI);
  return { dLat, dLng };
}

function wgs84ToGcj02(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || outOfChina(lat, lng)) {
    return { lat, lng };
  }
  const { dLat, dLng } = gcjDelta(lat, lng);
  return { lat: lat + dLat, lng: lng + dLng };
}

function decodeMapLabel(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 2 && /%[0-9A-Fa-f]{2}/.test(t); i++) {
    try { t = decodeURIComponent(t); } catch { break; }
  }
  return t;
}

function compactMapAddr(s) {
  return decodeMapLabel(s)
    .replace(/[·•|｜,，\s]+/g, '')
    .replace(/^(位置|这里|当前位置)$/g, '')
    .trim();
}

function amapHttpsMarkerUrl(name, gcjLat, gcjLng) {
  const u = new URL('https://uri.amap.com/marker');
  u.searchParams.set('position', `${gcjLng},${gcjLat}`);
  u.searchParams.set('name', name);
  u.searchParams.set('src', 'nian');
  u.searchParams.set('coordinate', 'gaode');
  u.searchParams.set('callnative', '1');
  return u.toString();
}

function amapHttpsSearchUrl(keyword) {
  const u = new URL('https://uri.amap.com/search');
  u.searchParams.set('keyword', keyword);
  u.searchParams.set('src', 'nian');
  u.searchParams.set('callnative', '1');
  return u.toString();
}

/** 只看这个地点，不走「从我的位置出发」的导航/路线 */
function mapPlaceUrls(addr) {
  const q = compactMapAddr(addr);
  if (!q) return [];
  return [
    `androidamap://poi?sourceApplication=nian&keywords=${q}&dev=0`,
    `amapuri://poi?sourceApplication=nian&keywords=${q}&dev=0`,
    `baidumap://map/geocoder?src=nian&address=${q}`,
    amapHttpsSearchUrl(q),
  ];
}

function mapPinUrls({ lat, lng, name }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const gcj = wgs84ToGcj02(lat, lng);
  const pin = name || '位置';
  return [
    amapHttpsMarkerUrl(pin, gcj.lat, gcj.lng),
    `androidamap://viewMap?sourceApplication=nian&poiname=${encodeURIComponent(pin)}&lat=${gcj.lat}&lon=${gcj.lng}&dev=0`,
    `amapuri://viewMap?sourceApplication=nian&poiname=${encodeURIComponent(pin)}&lat=${gcj.lat}&lon=${gcj.lng}&dev=0`,
    `baidumap://map/marker?location=${lat},${lng}&title=${encodeURIComponent(pin)}&coord_type=wgs84&src=nian`,
    `geo:${gcj.lat},${gcj.lng}?q=${encodeURIComponent(`${gcj.lat},${gcj.lng}(${pin})`)}`,
  ];
}

async function tryOpenMapUrls(urls) {
  for (const url of urls) {
    try {
      if (await window.openExternalUrl?.(url)) return true;
    } catch { /* 试下一个 */ }
  }
  return false;
}

async function resolveLocationCoords(lat, lng, query, preferQuery) {
  const la = Number(lat);
  const ln = Number(lng);
  const has = Number.isFinite(la) && Number.isFinite(ln)
    && Math.abs(la) <= 90 && Math.abs(ln) <= 180;
  // 卡片上已有坐标（预览落点）优先用；再搜一次失败时别丢掉，否则会只剩地址、地图落到「我附近」
  if (has && !preferQuery) return { lat: la, lng: ln };

  const q = String(query || '').trim();
  if (preferQuery && q && q !== '位置') {
    try {
      const data = await api.ensureMapPreview({ q });
      const ga = Number(data?.lat);
      const gn = Number(data?.lng);
      if (Number.isFinite(ga) && Number.isFinite(gn)) return { lat: ga, lng: gn };
    } catch { /* 再用卡片上的坐标 */ }
  }
  if (has) return { lat: la, lng: ln };
  if (!q || q === '位置') return null;
  try {
    const data = await api.ensureMapPreview({ q });
    const ga = Number(data?.lat);
    const gn = Number(data?.lng);
    if (Number.isFinite(ga) && Number.isFinite(gn)) return { lat: ga, lng: gn };
  } catch { /* 没有坐标就只打开地点页 */ }
  return null;
}

async function openLocationInMapApp({ lat, lng, title, query, preferQuery }) {
  const address = compactMapAddr(query || title);
  const name = decodeMapLabel(title || '位置') || address || '位置';
  const nativeMap = window.Capacitor?.Plugins?.AppPermissions?.openMap;
  const coords = await resolveLocationCoords(lat, lng, query || address, preferQuery);
  // App 里先走原生：网页 scheme 只要把高德唤到前台就算成功，后台高德会停在「我的位置」
  if (nativeMap) {
    try {
      if (coords) {
        const gcj = wgs84ToGcj02(coords.lat, coords.lng);
        await nativeMap({
          lat: coords.lat, lng: coords.lng, gcjLat: gcj.lat, gcjLng: gcj.lng,
          title: name, address: address || name,
        });
        return true;
      }
      // 没有坐标才用地址搜索；有坐标绝不能走这条（会显示我附近）
      if (address) {
        await nativeMap({ title: name, address });
        return true;
      }
    } catch { /* 再试网页协议 */ }
  }
  if (coords && await tryOpenMapUrls(mapPinUrls({ lat: coords.lat, lng: coords.lng, name }))) return true;
  if (!coords && address && await tryOpenMapUrls(mapPlaceUrls(address))) return true;
  return false;
}

async function fillLocationCardMap(card, { force = false } = {}) {
  if (!card) return;
  if (!force && card.dataset.mapReady === '1') return;
  const img = card.querySelector('.wx-location-map-img');
  if (!img && !force) return;
  const coords = locationCardCoords(card);
  const q = locationCardQuery(card);
  const gps = card.dataset.locGps === '1';
  try {
    const data = await api.ensureMapPreview(gps
      ? { lat: coords?.lat, lng: coords?.lng }
      : { q });
    if (!data) return;
    if (Number.isFinite(Number(data.lat))) card.dataset.lat = String(data.lat);
    if (Number.isFinite(Number(data.lng))) card.dataset.lng = String(data.lng);
    if (data.url && img) {
      img.src = resolvedMediaUrl(data.url);
      card.dataset.mapReady = '1';
    }
  } catch {
    /* 预览失败就留着底图，点卡片仍可跳地图 */
  }
}

const _mapHydrating = new WeakSet();

export function hydrateLocationCardMaps(root) {
  const scope = root && root.querySelectorAll ? root : document.getElementById('messages-list');
  if (!scope?.querySelectorAll) return;
  scope.querySelectorAll('.wx-location-card').forEach((card) => {
    if (card.dataset.mapReady === '1' || _mapHydrating.has(card)) return;
    _mapHydrating.add(card);
    fillLocationCardMap(card).finally(() => _mapHydrating.delete(card));
  });
}

window.openChatLocationCard = async function(el) {
  if (!el) return;
  if (document.getElementById('messages-list')?.classList.contains('chat-select-mode')) return;
  if (document.getElementById('context-menu')?.classList.contains('active')) return;
  const title = decodeMapLabel(decodeLinkAttr(el.dataset.locTitle || '')) || '位置';
  const query = decodeMapLabel(locationCardQuery(el));
  let coords = locationCardCoords(el);
  const fromGps = el.dataset.locGps === '1';
  // 角色定位卡：若预览还没写出坐标，先补一次，避免只带地址打开后落到「我的位置」
  if (!fromGps && !coords) {
    window.showToast?.('正在打开对方位置…');
    try {
      await fillLocationCardMap(el, { force: true });
      coords = locationCardCoords(el);
    } catch { /* 仍尝试按地址打开 */ }
  } else if (!fromGps) {
    window.showToast?.('正在打开对方位置…');
  }
  try {
    const opened = await openLocationInMapApp({
      lat: coords?.lat,
      lng: coords?.lng,
      title,
      query,
      // 已有坐标就别再搜；没有坐标才按地址解析
      preferQuery: !fromGps && !coords,
    });
    if (opened) return;
  } catch { /* 网页兜底 */ }
  const addr = compactMapAddr(query || title);
  if (coords) {
    const g = wgs84ToGcj02(coords.lat, coords.lng);
    window.open(amapHttpsMarkerUrl(addr || title, g.lat, g.lng), '_blank');
    return;
  }
  if (addr) {
    window.open(amapHttpsSearchUrl(addr), '_blank');
    return;
  }
  window.showToast?.('这张定位没有可跳转的地址');
};

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const webOverlay = document.getElementById('chat-web-card-sheet');
  if (webOverlay && webOverlay.style.display !== 'none') {
    window.closeChatWebCardSheet?.();
    return;
  }
  const overlay = document.getElementById('chat-link-sheet');
  if (!overlay || overlay.style.display === 'none') return;
  window.closeChatLinkSheet?.();
});

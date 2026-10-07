/* ===== 记忆系统辅助 ===== */
import { lookupInlineEmoji } from './inline-emoji.js';

// slots = 常驻/按需注入条数（实际注入逻辑见 backend/memory-brain-helper.js）
export const CATEGORIES = {
  '约定':      { icon: '🔒', weight: 1.0, color: '#9b6db4', slots: 0 },
  '待办':      { icon: '✅', weight: 0.95, color: '#6b9e78', slots: 0 },
  '重要时刻':  { icon: '📌', weight: 0.9, color: '#c9a0dc', slots: 0 },
  '秘密/心事': { icon: '🤫', weight: 0.85, color: '#d4a0c8', slots: 0 },
  '情感状态':  { icon: '🌡️', weight: 0.7, color: '#d4a0c8', slots: 0 },
  '偏好与习惯': { icon: '💡', weight: 0.6, color: '#b8a0d8', slots: 2 }, // 仅用户亲口确认的偏好，不含角色喜好/脑补
  '梦境':      { icon: '🌙', weight: 0.5, color: '#a0b4d8', slots: 2 },
  '日常点滴':  { icon: '💬', weight: 0.3, color: '#a0b8d8', slots: 2 },
  '日记偷看':  { icon: '👀', weight: 0.55, color: '#b8a0c8', slots: 2 },
  '秘密偷看':  { icon: '👀', weight: 0.55, color: '#b8a0c8', slots: 2 },
};

export function getCategoryInfo(cat) {
  return CATEGORIES[cat] || { icon: '💭', weight: 0.5, color: '#c9a0dc' };
}

export function sortMemories(memories) {
  return [...memories].sort((a, b) => {
    const wa = CATEGORIES[a.category]?.weight ?? a.weight ?? 0.5;
    const wb = CATEGORIES[b.category]?.weight ?? b.weight ?? 0.5;
    return wb - wa || parseUTCDate(b.created_at) - parseUTCDate(a.created_at);
  });
}

export function renderMemoryHTML(mem) {
  const info = getCategoryInfo(mem.category);
  return `
    <div class="memory-card" data-id="${mem.id}">
      <div class="memory-category" style="color:${info.color}">${info.icon} ${mem.category}</div>
      <div class="memory-content">${escapeHtml(mem.content)}</div>
      <div class="memory-date">${formatMemoryDateLabel(mem)}</div>
    </div>
  `;
}

export function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// SQLite stores datetime as "YYYY-MM-DD HH:MM:SS" (UTC, no tz indicator).
// JS parses a string without 'T' or 'Z' as LOCAL time, showing UTC offset as wrong clock.
// Fix: add 'T' + 'Z' so the browser treats it as UTC, then converts to local.
export function parseUTCDate(dateStr) {
  if (!dateStr) return new Date(NaN);
  if (dateStr.includes('T') || dateStr.includes('Z') || dateStr.includes('+')) {
    return new Date(dateStr);
  }
  // "2026-06-23 07:49:00" → "2026-06-23T07:49:00Z"
  return new Date(dateStr.replace(' ', 'T') + 'Z');
}

/** 气泡时间戳：缺失或无法解析时回退到当前时刻，避免「气泡下」只剩已读没有字 */
export function resolveDisplayTimestamp(dateStr) {
  if (dateStr != null && String(dateStr).trim()) {
    const d = parseUTCDate(dateStr);
    if (!Number.isNaN(d.getTime())) return dateStr;
  }
  return new Date().toISOString();
}

export function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const d = parseUTCDate(dateStr);
  const now = new Date();
  const diff = (Date.now() - d.getTime()) / 1000;
  const isToday = d.toDateString() === now.toDateString();
  const isYesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  const timeStr = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (diff < 60) return '刚刚';
  if (diff < 3600 && isToday) return `${Math.floor(diff / 60)}分钟前`;
  if (isToday) return `今天 ${timeStr}`;
  if (isYesterday) return `昨天 ${timeStr}`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}天前`;
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    + ' ' + timeStr;
}

/** 朋友圈时间：微信式「刚刚 / n分钟前 / n小时前 / 昨天 / M月D日」 */
export function formatMomentTime(dateStr) {
  if (!dateStr) return '';
  const d = parseUTCDate(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  const isYesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (isYesterday) return '昨天';
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatAbsTime(dateStr) {
  if (!dateStr) return '';
  const d = parseUTCDate(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday     = d.toDateString() === now.toDateString();
  const isYesterday = new Date(now - 86400000).toDateString() === d.toDateString();
  const timeStr = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return timeStr;
  if (isYesterday) return `昨天 ${timeStr}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${timeStr}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${timeStr}`;
}

export function formatDetailTime(dateStr) {
  if (!dateStr) return '';
  const d = parseUTCDate(dateStr);
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function getTimeOfDaySlot(hour) {
  if (hour >= 5 && hour < 9) return '清晨';
  if (hour >= 9 && hour < 12) return '上午';
  if (hour >= 12 && hour < 14) return '中午';
  if (hour >= 14 && hour < 18) return '下午';
  if (hour >= 18 && hour < 22) return '晚上';
  return '夜里';
}

export function formatMemoryDateLabel(mem) {
  const content = String(mem?.content || '');
  const inline = content.match(/(\d{4}年\d{1,2}月\d{1,2}日)(清晨|上午|中午|下午|晚上|夜里|夜深了)/);
  if (inline) return `${inline[1]} ${inline[2]}`;
  const raw = mem?.created_at || mem?.date || '';
  if (!raw) return '';
  const d = parseUTCDate(raw);
  if (Number.isNaN(d.getTime())) return String(raw).slice(0, 10);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${getTimeOfDaySlot(d.getHours())}`;
}

export function shouldInsertTimeDivider(prev, curr, thresholdMin = 10) {
  if (!prev) return true;
  const diff = (parseUTCDate(curr) - parseUTCDate(prev)) / 60000;
  return diff >= thresholdMin;
}

/** 讲故事分饰标记：只指导 TTS，界面不显示 */
const VOICE_LANE_OPEN = '软声|软|细声|尖声|撒娇|cute|soft|沉声|沉|粗声|厚声|低沉|deep|low|bass';
const VOICE_LANE_BLOCK_RE = new RegExp(
  `\\[\\s*(${VOICE_LANE_OPEN})\\s*\\]([\\s\\S]*?)\\[\\s*\\/\\s*(?:${VOICE_LANE_OPEN})\\s*\\]`,
  'gi',
);
const VOICE_LANE_ORPHAN_RE = new RegExp(
  `\\[\\s*\\/?\\s*(?:${VOICE_LANE_OPEN})\\s*\\]`,
  'gi',
);

export function stripVoiceLaneTags(text) {
  return String(text || '')
    .replace(VOICE_LANE_BLOCK_RE, '$2')
    .replace(VOICE_LANE_ORPHAN_RE, '')
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * 去掉 AI 回复里的「配图：…」「自拍：…」等系统指令。
 * @param {{ keepVoiceLanes?: boolean }} [opts] 语音条 TTS 需保留 [软声]/[沉声] 标记
 */
export function stripImageDirective(text, opts = {}) {
  if (!text) return text;
  let t = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(?:^|\n)\s*(?:配图[：:]\s*|IMAGE:\s*)[^\n]+/gi, '\n')
    .replace(/(?:配图[：:]\s*|IMAGE:\s*)[^\n]+\s*$/i, '')
    .replace(/(?:^|\n)\s*(?:配视频[：:]\s*|VIDEO:\s*)[^\n]+/gi, '\n')
    .replace(/(?:配视频[：:]\s*|VIDEO:\s*)[^\n]+\s*$/i, '')
    .replace(/(?:^|\n)\s*(?:自拍[：:]\s*|SELFIE:\s*)[^\n]+/gi, '\n')
    .replace(/(?:自拍[：:]\s*|SELFIE:\s*)[^\n]+\s*$/gi, '')
    // 夹在句中的指令行（后端偶发漏剥时前端兜底）
    .replace(/[，,。！？!?\s]*自拍[：:][^\n]*/gi, '')
    .replace(/[，,。！？!?\s]*SELFIE:\s*[^\n]*/gi, '')
    .replace(/\[\s*乐谱\s*\][\s\S]*?\[\s*\/\s*乐谱\s*\]/gi, '')
    .replace(/\[\s*SCORE\s*\][\s\S]*?\[\s*\/\s*SCORE\s*\]/gi, '')
    .replace(/(?:^|\n)\s*(?:乐谱[：:]\s*|SCORE:\s*)[^\n]+/gi, '\n')
    .replace(/(?:乐谱[：:]\s*|SCORE:\s*)[^\n]+\s*$/gi, '')
    .replace(/\[\s*(?:换头像|同意换头像)\s*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!opts.keepVoiceLanes) t = stripVoiceLaneTags(t).trim();
  return t;
}

const CJK_CHAR = /[\u3400-\u9fff]/;
const SENTENCE_END_CHARS = '。．！？!?；;';
const CLOSING_QUOTE_CHARS = '」』"”’）)】';
const DISCOURSE_AFTER_COMMA = /^(那|对了|还有|不过|而且|然后|所以|但是|可是|只是|其实|反正|另外|总之|不然|否则|至于|话说|好啊|好的|好吧|行吧|行啊|嗯|哦|哎|唉|对啊|对吧)/u;

/** 中转空回复/报错常塞一整段 HTML；CSS 里的 ; 会被句末拆泡撕碎，必须整段保留 */
export function looksLikeStandaloneHtml(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 16) return false;
  if (/^\s*<(!DOCTYPE\s+html\b|html\b|head\b|body\b)/i.test(t)) return true;
  const tags = t.match(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>/g) || [];
  if (tags.length < 2) return false;
  if (!/<(?:div|style|section|article|table|span|p|h[1-6]|img|svg|ul|ol|li|button|a)\b/i.test(t)) return false;
  // 正文里偶尔写「用 <div>」不够；至少两枚标签且体积像卡片/页面
  return t.length >= 40 || /style\s*=/i.test(t) || /<\/(?:div|section|article|table|style)>/i.test(t);
}

/** 网页卡标记、JSON 卡，或裸 HTML（中转空消息卡片） */
export function looksLikeWebCardPayload(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^[\[【［]\s*\/\s*(?:网页卡|前端卡)\s*[\]】］]$/i.test(t)) return false;
  if (/^(?:\[|【|［)\s*(?:网页卡|前端卡)\s*(?:[:：\]】］])/.test(t)) return true;
  if (t.startsWith('{') && /"html"\s*:/.test(t)) return true;
  return looksLikeStandaloneHtml(t);
}

function stripTrailingChatPunct(s) {
  return String(s || '').trim().replace(/[。．！？!?…⋯～~、,，；;]+$/u, '').trim();
}

function visibleLen(s) {
  return String(s || '').replace(/\s+/g, '').length;
}

function looksLikeOwnUtterance(s) {
  const t = stripTrailingChatPunct(s);
  if (!t) return false;
  if (DISCOURSE_AFTER_COMMA.test(t)) return true;
  if (/^(好|行|嗯|哦|唉|哎|哈)([啊呀啦哦嘛]?)$/u.test(t) && visibleLen(t) <= 3) return true;
  // 很短的第二人称祈使/问句才另起一泡，避免「头发还没干」这种逗号从句被切开
  return /^[你您]/.test(t) && /[吗吧呢]$/u.test(t) && visibleLen(t) <= 12;
}

function consumeClosers(s, j) {
  while (j + 1 < s.length && CLOSING_QUOTE_CHARS.includes(s[j + 1])) j++;
  return j;
}

function attachLeadingClosers(parts) {
  const out = [];
  for (const raw of parts) {
    const p = String(raw || '').trim();
    if (!p) continue;
    const m = p.match(/^[」』"”’）)】]+/);
    if (out.length && m) {
      out[out.length - 1] += m[0];
      const rest = p.slice(m[0].length).trim();
      if (rest) out.push(rest);
    } else {
      out.push(p);
    }
  }
  return out;
}

/** 按句末标点切开；引号跟在句号后面时不撕到下一条 */
function splitBySentenceEnd(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const parts = [];
  let start = 0;
  const pushTo = (end) => {
    const piece = s.slice(start, end).trim();
    if (piece) parts.push(piece);
    start = end;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '…' || ch === '⋯') {
      let j = i;
      while (j + 1 < s.length && (s[j + 1] === '…' || s[j + 1] === '⋯')) j++;
      j = consumeClosers(s, j);
      pushTo(j + 1);
      i = j;
      continue;
    }
    if (ch === '.' && s.slice(i, i + 3) === '...') {
      let j = i;
      while (j + 1 < s.length && s[j + 1] === '.') j++;
      j = consumeClosers(s, j);
      pushTo(j + 1);
      i = j;
      continue;
    }
    if (ch === '.') {
      const prev = s[i - 1] || '';
      const next = s[i + 1] || '';
      if ((CJK_CHAR.test(prev) || CLOSING_QUOTE_CHARS.includes(prev)) && next !== '.' && !/\d/.test(next)) {
        const j = consumeClosers(s, i);
        pushTo(j + 1);
        i = j;
        continue;
      }
    }
    if (SENTENCE_END_CHARS.includes(ch)) {
      let j = i;
      while (j + 1 < s.length && SENTENCE_END_CHARS.includes(s[j + 1])) j++;
      j = consumeClosers(s, j);
      pushTo(j + 1);
      i = j;
      continue;
    }
    if (ch === '～' || ch === '~') {
      let j = i;
      while (j + 1 < s.length && (s[j + 1] === '～' || s[j + 1] === '~')) j++;
      const after = s.slice(j + 1).trim();
      if (visibleLen(after) >= 4 && looksLikeOwnUtterance(after)) {
        j = consumeClosers(s, j);
        pushTo(j + 1);
        i = j;
      }
    }
  }
  const tail = s.slice(start).trim();
  if (tail) parts.push(tail);
  return attachLeadingClosers(parts.length ? parts : (s.trim() ? [s.trim()] : []));
}

function splitCommasOutsideQuotes(text) {
  const s = String(text || '');
  const bits = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ('「『“'.includes(ch)) depth++;
    else if ('」』”'.includes(ch) && depth) depth--;
    else if (depth === 0 && (ch === '，' || ch === ',')) {
      bits.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  bits.push(s.slice(start).trim());
  return bits.filter(Boolean);
}

/** 逗号两边都像独立微信句时再拆，避免「苹果，香蕉」这种并列被切开 */
function splitLooseCommas(sentence) {
  const bits = splitCommasOutsideQuotes(sentence);
  if (bits.length <= 1) return [String(sentence || '').trim()].filter(Boolean);
  const out = [];
  let buf = bits[0];
  for (let i = 1; i < bits.length; i++) {
    const next = bits[i];
    const leftLen = visibleLen(buf);
    const rightLen = visibleLen(next);
    if (looksLikeOwnUtterance(next) && rightLen >= 2 && leftLen >= 1) {
      if (buf) out.push(buf);
      buf = next;
    } else {
      buf = `${buf}，${next}`;
    }
  }
  if (buf) out.push(buf);
  return out.filter(Boolean);
}

function dropBareTrailingDot(full, offset, str) {
  return offset > 0 && str[offset - 1] === '.' ? full : '';
}

function dropBareDotBeforeClosers(full, closers, offset, str) {
  return offset > 0 && str[offset - 1] === '.' ? full : closers;
}

export function isPeriodOnlyText(text) {
  return /^[。．.…⋯\s]+$/.test(String(text || '').trim());
}

export function isBareMediaLabel(text) {
  const t = String(text || '').trim().replace(/[。．.！!？?\s]+$/g, '');
  if (!t) return false;
  return /^(?:[\[【［(（]\s*)?(?:文字|语音|语音条|语音消息|环境音)(?:\s*[\]】］)）])?$/.test(t);
}

function looksLikeMediaDirectiveOnly(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/(?:自拍|配图|配视频|IMAGE|VIDEO|SELFIE)\s*[：:]/i.test(t)) {
    const without = stripImageDirective(t);
    return !without || without.length < 2;
  }
  return false;
}

/** 拆完后去掉句末「。」，文字气泡不显示句号（问号/感叹号/省略号保留） */
export function stripDisplayPeriod(text) {
  if (!text) return '';
  return String(text)
    .replace(/[。．]([」』"”’）)】]+)$/u, '$1')
    .replace(/\.([」』"”’）)】]+)$/u, dropBareDotBeforeClosers)
    .replace(/[；;，,]+$/u, '')
    .replace(/[。．]+$/u, '')
    .replace(/\.$/u, dropBareTrailingDot)
    .trim();
}

/** 语音气泡保留句末「。」；没有句末标点时补上。单独一个句号不是台词 */
export function keepVoicePeriod(text) {
  const t = String(text || '').trim();
  if (!t || isPeriodOnlyText(t) || isBareMediaLabel(t)) return '';
  if (/^[♪🎵]/.test(t)) return t;
  if (/[。．！？…!?～~]$/u.test(t)) return t;
  return `${t}。`;
}

function isKnownBean(code) {
  return !!lookupInlineEmoji(code);
}

/** 整段是否只剩小黄豆（可含空白），用于避免单独占一个气泡 */
function isBeanOnlySegment(text) {
  const s = String(text || '').trim();
  if (!s || !/\[[^\[\]\n]{1,20}\]/.test(s)) return false;
  const stripped = s.replace(/\[([^\[\]\n]{1,20})\]/g, (full, code) => (
    isKnownBean(String(code || '').trim()) ? '' : full
  )).replace(/\s+/g, '');
  return stripped === '';
}

/** 把单独成段的小黄豆并回前后文字气泡，避免 [微笑] 自己占一条 */
function mergeLoneBeanSegments(parts) {
  const out = [];
  for (const p of parts) {
    const t = String(p || '').trim();
    if (!t) continue;
    if (isBeanOnlySegment(t) && out.length) {
      out[out.length - 1] = `${out[out.length - 1]}${t}`;
      continue;
    }
    out.push(t);
  }
  while (out.length >= 2 && isBeanOnlySegment(out[0])) {
    out[1] = `${out[0]}${out[1]}`;
    out.shift();
  }
  return out;
}

function splitIntoSentenceGroups(text, keepPeriod = false) {
  if (!text) return [text];
  const trimmed = String(text).trim();
  const parts = [];
  for (const sent of splitBySentenceEnd(trimmed)) {
    parts.push(...splitLooseCommas(sent));
  }
  const finish = (p) => (keepPeriod ? p : (stripDisplayPeriod(p) || p));
  const sentences = parts.length <= 1
    ? [finish(trimmed) || trimmed]
    : parts.map(p => finish(p) || p).filter(Boolean);
  return sentences;
}

/** 去掉 AI 从历史里学来的 [文字]/[语音] 标记；并剥心里话草稿标记、通道标签抄写 */
export function stripAiContextLabels(text) {
  if (!text) return '';
  const mindTag = '怎么看这件事|怎么想这件事|决定做什么|决定不说什么|决定怎么说|怎么看|什么感觉|怎么想|怎么做';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(new RegExp(`[\\[【［]\\s*(?:${mindTag})\\s*[\\]】］][\\s\\S]*?[\\[【［]\\s*\\/\\s*(?:${mindTag})\\s*[\\]】］]`, 'gi'), '')
    .replace(new RegExp(`[\\[【［]\\s*(?:${mindTag})\\s*[:：][^\\]】］\\n]*[\\]】］]`, 'gi'), '')
    .replace(new RegExp(`[\\[【［]\\s*(?:${mindTag})\\s*[\\]】］][^\\n\\[【［]*`, 'gi'), '')
    .replace(new RegExp(`[\\[【［]\\s*\\/\\s*(?:${mindTag})\\s*[\\]】］]`, 'gi'), '')
    .replace(new RegExp(`(?:^|\\n)\\s*(?:我)?(?:${mindTag})\\s*[:：][^\\n]*`, 'gi'), '\n')
    // 历史通道标签抄写（与挂断一样，用户看不见）
    .replace(/[\[【［]\s*通话\s*[\]】］]\s*(?:你说|对方说|我说)?\s*[:：]?\s*/g, '')
    .replace(/[\[【［]\s*文字\s*[\]】］]\s*(?:你说|对方说|我说)?\s*[:：]?\s*/g, '')
    .replace(/(?:^|\n)\s*(?:你说|对方说)\s*[:：]\s*/g, '\n')
    .replace(/[\[【［]\s*(?:文字|语音|语音条|语音消息)\s*[\]】］]\s*/g, '')
    .replace(/^[（(]\s*语音(?:条|消息)?\s*[)）]\s*/gm, '')
    .replace(/^(?:语音条|语音消息|语音)\s*[:：]\s*/gm, '')
    .replace(/[\[【［]\s*语速\s*[:：]\s*[0-9.]+[\]】］]/gi, '')
    .replace(/[\[【［]\s*语气\s*[:：][^\]】］\n]{0,12}[\]】］]/gi, '')
    .replace(/[\[【［]\s*(?:end_call|挂断|结束通话|结束电话|挂掉电话|挂电话)\s*(?:[:：][^\]\n]{0,40})?\s*[\]】］]/gi, '')
    .replace(/\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const TRUNC_HANG_RE = /(?:怎么还没|还没来得及|还没|你怎么|我还|把|将|被|从|向|往|给|跟|和|与|或|以及|因为|所以|但是|可是|然后|而且|如果|虽然|不但|不仅|就是|还是|要是|除非|无论|不管|除了|为了|由于|关于|对于|通过|按照|根据|作为|(?:所以|但是|可是|然后|而且)(?:我|你)?(?:想|要))$/;
const TRUNC_KEEP_SHORT = /^(嗯+|哦+|啊+|哈+|唉+|哎+|额+|好+|行+|在|我在|还在|就在|好的|是的|对的|真的|算了|得了|行了|好了|完了|懂了|走了|谢谢|没事)$/;

export function looksTruncatedUtterance(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (looksLikeStandaloneHtml(t) || looksLikeWebCardPayload(t) || t.startsWith('{')) return false;
  if (/^[♪🎵\[]/.test(t)) return false;
  if (/[。！？…!?～~」』"”’）)】]$/u.test(t)) return false;
  if (TRUNC_KEEP_SHORT.test(t)) return false;
  const core = t.replace(/[，,、；;：:\s…⋯]+$/u, '').trim();
  if (!core) return true;
  if (TRUNC_KEEP_SHORT.test(core)) return false;
  if (TRUNC_HANG_RE.test(core)) return true;
  if (/[的地得]$/u.test(core) && !/(好的|是的|对的|真的)$/.test(core) && core.length >= 3) return true;
  if (/\b(?:the|a|an|to|and|or|but|if|when|with|for|of)$/i.test(core)) return true;
  return false;
}

function splitAiSegmentsUnsafe(text, opts = {}) {
  if (!text) return [];
  const keepPeriod = !!opts.keepPeriod;
  const original = String(text).trim();
  // 网页卡 / 裸 HTML：整段一泡，勿按 ; 。！？ 拆
  if (looksLikeWebCardPayload(original)) return [original];
  let cleaned = stripImageDirective(stripAiContextLabels(original));
  if (!cleaned) {
    if (!original || isBareMediaLabel(original) || looksLikeMediaDirectiveOnly(original)) return [];
    // 剥完为空但原文含指令：不要把指令原文再塞回气泡
    if (/(?:自拍|配图|配视频|IMAGE|VIDEO|SELFIE)\s*[：:]/i.test(original)) return [];
    return [original];
  }
  if (looksLikeWebCardPayload(cleaned)) return [cleaned];

  // 空行先分成大段；段内按换行再按句号拆（勿把换行捏成一句粘连）
  const blocks = cleaned.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const sources = blocks.length > 1 ? blocks : [cleaned];
  const result = [];
  for (const block of sources) {
    const lines = block.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const units = lines.length > 1 ? lines : [block.replace(/\n+/g, ' ').trim()];
    for (const unit of units) {
      result.push(...splitIntoSentenceGroups(unit, keepPeriod));
    }
  }
  const merged = mergeLoneBeanSegments(result).filter((p) => {
    const s = String(p || '').trim();
    // 排除孤立的句号 / 标点串：避免「。」「……」自己占一个气泡
    if (!s || isBareMediaLabel(s) || isPeriodOnlyText(s) || looksTruncatedUtterance(s)) return false;
    return true;
  });
  if (merged.length) return merged;
  if (isBareMediaLabel(cleaned)) return [];
  if (isPeriodOnlyText(cleaned)) return [];
  if (keepPeriod) return [cleaned];
  return [stripDisplayPeriod(cleaned) || cleaned];
}

/** 气泡拆分：空行分段 + 换行/句号一句一泡（不按字数合并） */
export function splitAiSegments(text, opts = {}) {
  try {
    const segs = splitAiSegmentsUnsafe(text, opts);
    if (segs.length) return segs;
  } catch { /* 拆句失败时整段原样显示，避免聊天页空白 */ }
  const fallback = String(text || '').trim();
  if (!fallback || looksTruncatedUtterance(fallback)) return [];
  return [fallback];
}

/** 通话系统消息：提示词隐藏，界面只留开始 / 结束 / 时长 */
export function parseCallSystemRecord(content) {
  const t = String(content || '').replace(/^__special__/, '').trim();
  if (!t) return null;
  if (/^\[电话被挂断/.test(t) || /^\[电话没打通/.test(t)) return { kind: 'hide' };
  if (/^\[电话这头/.test(t) || /情境上已经睡着/.test(t)) return { kind: 'hide' };
  // 连麦 / 观影 / 通话旁路指令：只给模型看，不能进聊天页
  if (/^\[连麦/.test(t) || /^\[一起看/.test(t) || /^\[通话提示/.test(t)) return { kind: 'hide' };
  if (/^\[/.test(t) && /(?:只输出\s*\[安静\]|不要喊对方|不要提截图|按你自己的性格|不要写成|不要问对方在干嘛)/.test(t)) {
    return { kind: 'hide' };
  }
  const video = /视频/.test(t);
  if (/^\[(?:视频|语音)?通话开始\]/.test(t) || t === '通话开始' || t === '视频通话开始' || t === '语音通话开始') {
    return { kind: 'start', video, label: video ? '视频通话开始' : '通话开始' };
  }
  // 时长：00:37 / 通话计时 00:37 / · 1分30秒 / · 37秒 / · 2分钟
  const dur = (
    t.match(/(?:通话计时|通话时长|时长)\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/)
    || t.match(/·\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)\s*$/)
    || t.match(/·\s*(\d+\s*分(?:\s*\d+\s*秒)?|\d+\s*秒|\d+\s*分钟)\s*$/)
    || t.match(/\b([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)\s*$/)
  )?.[1] || '';
  const durLabel = String(dur || '').replace(/\s+/g, '');
  const isEnd = /^\[(?:视频|语音)?通话已结束\]/.test(t)
    || /^通话已结束/.test(t)
    || /^(?:视频|语音)?通话结束/.test(t)
    || (/通话结束/.test(t) && !!durLabel)
    || /通话被对方结束/.test(t);
  if (isEnd) {
    const base = video ? '视频通话结束' : '通话结束';
    return { kind: 'end', video, duration: durLabel, label: durLabel ? `${base} · ${durLabel}` : base };
  }
  if (/你没有接听|没有接听并挂断|对方已挂断/.test(t)) {
    return { kind: 'missed', video, label: '对方已挂断' };
  }
  if (t === '已取消呼叫' || /已取消呼叫/.test(t)) {
    return { kind: 'cancel', video, label: '已取消呼叫' };
  }
  if (t === '已拒绝' || t === '未接通') {
    return { kind: 'missed', video: false, label: t };
  }
  return null;
}

/** 收件箱 / 通知等：按消息类型生成简短预览文案 */
export function formatMessagePreview(msg, opts = {}) {
  if (!msg) return opts.empty ?? '暂无消息';
  const maxLen = opts.maxLen ?? 40;
  const withRole = opts.withRolePrefix !== false;
  const prefix = withRole && msg.role === 'user' ? '我：' : '';

  if (msg.recalled) {
    return prefix + (msg.role === 'user' ? '你撤回了一条消息' : '对方撤回了一条消息');
  }

  const type = msg.type || 'text';
  if (type === 'voice') {
    const raw = String(msg.content || '').trim();
    if (raw.startsWith('{')) {
      try {
        const j = JSON.parse(raw);
        if (j?.album && j.label) return prefix + `[语音] ${j.label}`;
        if (j?.voice && j.url) {
          const t = String(j.transcript || '').trim();
          return prefix + (t ? `[语音] ${t}` : '[语音]');
        }
      } catch {}
    }
    return prefix + '[语音]';
  }
  if (type === 'emoji') return prefix + '[表情包]';
  if (type === 'image') return prefix + '[图片]';
  if (type === 'video') return prefix + '[视频]';
  if (type === 'location') return prefix + '[位置]';
  if (type === 'link') {
    const raw = String(msg.content || '').trim();
    const title = raw.split(/[|｜]/)[0].trim();
    return prefix + (title ? `[链接] ${title}` : '[链接]');
  }
  if (type === 'web_card') {
    try {
      const j = JSON.parse(String(msg.content || '').trim() || '{}');
      const title = String(j?.title || '').trim();
      return prefix + (title ? `[网页卡] ${title}` : '[网页卡]');
    } catch {
      return prefix + '[网页卡]';
    }
  }
  if (type === 'text' && looksLikeWebCardPayload(msg.content)) {
    return prefix + '[网页卡]';
  }
  if (type === 'system') {
    const rec = parseCallSystemRecord(msg.content);
    if (rec?.kind === 'hide') {
      const raw = String(msg.content || '');
      if (/电话被挂断/.test(raw)) return '已拒绝';
      if (/电话没打通/.test(raw)) return '未接通';
      return opts.empty ?? '';
    }
    if (rec?.label) return rec.label;
    const sys = String(msg.content || '').replace(/^__special__/, '').trim();
    return prefix + (sys.slice(0, maxLen) + (sys.length > maxLen ? '…' : ''));
  }

  const content = String(msg.content || '').replace(/\s+/g, ' ').trim();
  if (!content) return prefix + '[消息]';
  return prefix + content.slice(0, maxLen) + (content.length > maxLen ? '…' : '');
}

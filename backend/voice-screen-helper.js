/**
 * 开口前的私人草稿只留「我怎么想」给下一轮；
 * 发出去之前再看一遍可见正文，拦住霸总/训人套话。
 */
const db = require('./db');
const { stripMindPrivateTags } = require('./emoji-helper');

const THOUGHT_KEEP = 2;
const THOUGHT_MAX = 160;

/** 管教/支配人设允许压人；其余角色这些句子是套话 */
const STOCK_RE = /看我怎么收拾(?!房间|屋子|家|桌子|行李)|怎么收拾你|收拾你(?!的)|看我怎么(?:治|教训)你|给你点颜色|长本事了|胆子大了|谁给你的胆子|挺能耐|你完了(?!这|那|作业|画|工作|没|吗|？|\?)|信不信我(?:收拾|治|教训)/;

const MARKER_RE = /\[\s*(?:拍一拍|打电话|语音电话|视频电话|视频通话)[^\]]*\]/g;

function stockHit(text) {
  return STOCK_RE.test(String(text || ''));
}

function extractInnerThought(raw) {
  const t = String(raw || '');
  let thought = '';
  const paired = t.match(/[\[【［]\s*我怎么想\s*[\]】］]([\s\S]*?)[\[【［]\s*\/\s*我怎么想\s*[\]】］]/);
  if (paired) thought = paired[1];
  if (!thought) {
    const open = t.match(/[\[【［]\s*我怎么想\s*[\]】］]([\s\S]{4,240}?)(?=[\[【［]|$)/);
    if (open) thought = open[1];
  }
  thought = String(thought || '').replace(/\s+/g, ' ').trim();
  if (thought.length < 6) return '';
  if (/两三句|情绪词|想逗\/想压|不要写成|内心想法/.test(thought)) return '';
  return thought.slice(0, THOUGHT_MAX);
}

function loadThoughts(char) {
  if (Array.isArray(char?.recent_inner_thoughts)) return char.recent_inner_thoughts;
  const raw = char?.recent_inner_thoughts;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
  }
  if (!char?.id) return [];
  try {
    const row = db.prepare('SELECT recent_inner_thoughts FROM characters WHERE id=?').get(Number(char.id));
    const parsed = JSON.parse(row?.recent_inner_thoughts || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberInnerThought(charId, thought) {
  const text = String(thought || '').trim();
  if (!charId || !text) return;
  let prev = [];
  try {
    const row = db.prepare('SELECT recent_inner_thoughts FROM characters WHERE id=?').get(Number(charId));
    const parsed = JSON.parse(row?.recent_inner_thoughts || '[]');
    if (Array.isArray(parsed)) prev = parsed.map((x) => String(x || '').trim()).filter(Boolean);
  } catch { prev = []; }
  const norm = text.replace(/\s+/g, '');
  const last = String(prev[prev.length - 1] || '').replace(/\s+/g, '');
  if (last && last === norm) return;
  prev.push(text);
  while (prev.length > THOUGHT_KEEP) prev.shift();
  try {
    db.prepare('UPDATE characters SET recent_inner_thoughts=? WHERE id=?')
      .run(JSON.stringify(prev), Number(charId));
  } catch (e) {
    console.warn('[voice-screen] save thought', e.message);
  }
}

function rememberFromRaw(charId, raw) {
  const thought = extractInnerThought(raw);
  if (thought) rememberInnerThought(charId, thought);
}

/** 下一轮只带上一两轮没说出口的想法，不带整份四步草稿 */
function formatCarriedThoughts(char) {
  const list = loadThoughts(char)
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(-THOUGHT_KEEP);
  if (!list.length) return '';
  const lines = list.map((x) => `· ${x}`).join('\n');
  return `【还留在心里】上一两轮没说出口的想法，只作底，不要复读成开口，也不要当这轮的任务：\n${lines}\n对方这轮换了题就放下；还是同一件事再接着。`;
}

function peelMarkers(text) {
  const markers = [];
  const body = String(text || '').replace(MARKER_RE, (m) => {
    markers.push(m);
    return '';
  });
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), markers };
}

function dropStockSentences(text) {
  const parts = String(text || '').split(/(?<=[。！？!?…])/);
  const kept = parts.filter((p) => p.trim() && !stockHit(p));
  return kept.join('').trim();
}

async function screenSpoken(char, settings, text) {
  const original = String(text || '').trim();
  if (!original || !char) return original;
  let lecture = false;
  try { lecture = !!require('./emotion-helper').characterToneProfile(char).lecture; } catch { lecture = false; }
  if (lecture) return original;
  const { body, markers } = peelMarkers(original);
  const spoken = stripMindPrivateTags(body).trim();
  if (!spoken || !stockHit(spoken)) return original;

  const style = String(char.language_style || '').trim().slice(0, 500);
  const behavior = String(char.behavior || '').trim().slice(0, 240);
  const sys = `你在改一段已经写好的微信回复，让它像「${char.name || '这个人'}」本人说的。
只输出改后的话，不要解释，不要加标记。
保持原来的意思和大概长短。生气就话短、说反话，不要放狠话，不要训人。
禁止出现：收拾你、看我怎么收拾、你完了、长本事了、胆子大了、谁给你的胆子、挺能耐、给你点颜色。`;
  const user = [
    behavior ? `【行为】${behavior}` : '',
    style ? `【语言风格·只学口气，禁止照抄】\n${style}` : '',
    `【原话】\n${spoken}`,
  ].filter(Boolean).join('\n\n');

  let rewritten = '';
  try {
    const { callChatAPIComplete } = require('./api-helper');
    rewritten = await callChatAPIComplete(settings, sys, user, 'chat', [], {
      maxTokens: 400,
      temperature: 0.4,
      timeout: 25000,
      noContinue: true,
    });
  } catch (e) {
    console.warn('[voice-screen] rewrite', e.message);
  }
  rewritten = String(rewritten || '').replace(/^[「"]|[」"]$/g, '').trim();
  if (!rewritten || stockHit(rewritten)) {
    rewritten = dropStockSentences(rewritten || spoken);
  }
  if (!rewritten) {
    console.warn(`[voice-screen] dropped stock line char=${char.id}`);
    return markers.join('');
  }
  console.log(`[voice-screen] rewritten char=${char.id}`);
  const tail = markers.length ? `\n${markers.join('')}` : '';
  return `${rewritten}${tail}`.trim();
}

async function gateSpokenReply(char, settings, opts = {}) {
  if (opts.raw) rememberFromRaw(char?.id, opts.raw);
  return screenSpoken(char, settings, opts.text);
}

module.exports = {
  stockHit,
  extractInnerThought,
  rememberFromRaw,
  formatCarriedThoughts,
  screenSpoken,
  gateSpokenReply,
};

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { sanitizeInlineBeans, isKnownBean } = require('./inline-emoji-helper');
const { formatAlbumMessageForAi } = require('./album-helper');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
let _emojiLiveIndex = null;
let _emojiLiveIndexAt = 0;

function emojiBasename(filename) {
  return String(filename || '')
    .replace(/\\/g, '/')
    .replace(/^\/uploads\//i, '')
    .split(/[?#]/)[0]
    .replace(/^\/+/, '');
}

function emojiAbsPath(filename) {
  const name = emojiBasename(filename);
  if (!name || name.includes('..') || name.includes('/')) return '';
  return path.join(UPLOADS_DIR, name);
}

function emojiFileExists(filename) {
  const fp = emojiAbsPath(filename);
  try { return !!(fp && fs.existsSync(fp) && fs.statSync(fp).isFile()); } catch { return false; }
}

function invalidateEmojiLiveCache() {
  _emojiLiveIndex = null;
  _emojiLiveIndexAt = 0;
}

function copyEmojiFile(fromName, toName) {
  const src = emojiAbsPath(fromName);
  const dest = emojiAbsPath(toName);
  if (!src || !dest || src === dest) return false;
  if (!fs.existsSync(src)) return false;
  try {
    fs.copyFileSync(src, dest);
    invalidateEmojiLiveCache();
    return true;
  } catch {
    return false;
  }
}

function decorateEmojiRecord(e) {
  const filename = emojiBasename(e?.filename);
  let url = filename ? `/uploads/${filename}` : '';
  if (url && emojiFileExists(filename)) {
    try { url += `?v=${Math.floor(fs.statSync(emojiAbsPath(filename)).mtimeMs)}`; } catch { /* keep */ }
  }
  return {
    ...e,
    filename,
    url,
    missing: !emojiFileExists(filename),
  };
}

function emojiLiveIndex() {
  const now = Date.now();
  if (_emojiLiveIndex && now - _emojiLiveIndexAt < 4000) return _emojiLiveIndex;
  const all = db.prepare('SELECT id, filename, description FROM emojis ORDER BY id').all() || [];
  const byFile = new Map();
  const byDesc = new Map();
  for (const e of all) {
    const filename = emojiBasename(e.filename);
    const exists = emojiFileExists(filename);
    const rec = { ...e, filename, exists };
    byFile.set(filename, rec);
    const d = normalizeEmojiDesc(e.description);
    if (d && exists) byDesc.set(d, filename);
  }
  _emojiLiveIndex = { byFile, byDesc };
  _emojiLiveIndexAt = now;
  return _emojiLiveIndex;
}

/** 旧聊天记录仍指向已删文件时，改用同描述、文件还在的那张 */
function resolveLiveEmojiUrl(url) {
  const name = emojiBasename(url);
  if (!name) return String(url || '');
  const idx = emojiLiveIndex();
  const row = idx.byFile.get(name);
  if (row?.exists) return `/uploads/${name}`;
  const d = normalizeEmojiDesc(row?.description);
  const live = d ? idx.byDesc.get(d) : '';
  return live ? `/uploads/${live}` : `/uploads/${name}`;
}

/**
 * 重新上传不会改旧记录。若新图描述和裂开的旧图一样，把文件拷回旧文件名，
 * 聊天记录里的 /uploads/旧名 才能重新显示。
 */
function healMissingEmojiFiles() {
  const all = db.prepare('SELECT * FROM emojis ORDER BY id DESC').all() || [];
  const sources = new Map();
  for (const e of all) {
    const d = normalizeEmojiDesc(e.description);
    if (!d || !emojiFileExists(e.filename)) continue;
    if (!sources.has(d)) sources.set(d, e);
  }
  let restored = 0;
  for (const e of all) {
    const d = normalizeEmojiDesc(e.description);
    if (!d || emojiFileExists(e.filename)) continue;
    const src = sources.get(d);
    if (!src) continue;
    if (copyEmojiFile(src.filename, e.filename)) restored++;
  }
  if (restored) invalidateEmojiLiveCache();
  return restored;
}

/** 给刚保存描述的新图：补回同描述的裂图，并删掉这条重复的新记录 */
function mergeReplacementEmoji(newRow) {
  if (!newRow?.id) return { merged: 0 };
  const desc = normalizeEmojiDesc(newRow.description);
  if (!desc || !emojiFileExists(newRow.filename)) return { merged: 0 };
  const others = db.prepare('SELECT * FROM emojis WHERE id!=?').all(newRow.id) || [];
  const missing = others.filter((o) => (
    normalizeEmojiDesc(o.description) === desc && !emojiFileExists(o.filename)
  ));
  if (!missing.length) return { merged: 0 };
  let merged = 0;
  for (const o of missing) {
    if (copyEmojiFile(newRow.filename, o.filename)) merged++;
  }
  if (!merged) return { merged: 0 };
  db.prepare('DELETE FROM emojis WHERE id=?').run(newRow.id);
  invalidateEmojiLiveCache();
  return { merged, deletedId: Number(newRow.id) };
}

function parseJsonArray(val, fallback = []) {
  if (Array.isArray(val)) return val;
  if (val == null || val === '') return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

/** 角色可用表情包：来自用户在表情包管理中上传的图（含 GIF） */
function getAvailableEmojis(char) {
  const allowed = parseJsonArray(char?.emoji_categories);
  // 未选任何分类 = 不允许发表情包
  if (!allowed.length) return [];
  const cats = db.prepare('SELECT * FROM emoji_categories ORDER BY id').all();
  const result = [];
  for (const c of cats) {
    const idOk = allowed.some(x => x == c.id);
    if (!idOk) continue;
    const emojis = db.prepare(
      'SELECT * FROM emojis WHERE category_id=? ORDER BY id'
    ).all(c.id);
    for (const e of emojis) {
      if (!emojiFileExists(e.filename)) continue;
      const desc = (e.description || '').trim() || `表情${e.id}`;
      result.push({
        id: e.id,
        description: desc,
        filename: e.filename,
        url: `/uploads/${e.filename}`,
        isGif: /\.gif$/i.test(e.filename || ''),
      });
    }
  }
  return result;
}

function normalizeEmojiDesc(desc) {
  return String(desc || '')
    .trim()
    .replace(/^[\s「『"'【\[]+|[\s」』"'】\]]+$/g, '')
    // 模型有时在描述后塞「/详情」之类尾巴
    .replace(/\/\s*详情\s*$/u, '')
    .replace(/\[\s*\/?\s*详情\s*\]\s*$/u, '')
    .trim();
}

/**
 * 剥掉模型泄漏的思考链 / 推理标签，以及表情标记解析后残留的「/详情」等垃圾。
 * 部分中转会把 &lt;think&gt;…&lt;/think&gt; 写进 content，或把 reasoning 拼进正文。
 */
function stripModelLeakage(text) {
  let t = String(text || '');
  if (!t) return '';

  // 成对思考/推理标签（各家写法）
  t = t.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '');
  t = t.replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '');
  t = t.replace(/<redacted_reasoning\b[^>]*>[\s\S]*?<\/redacted_reasoning>/gi, '');
  t = t.replace(/<antThinking\b[^>]*>[\s\S]*?<\/antThinking>/gi, '');
  // 只有结束标签：前面整段当思考扔掉，保留其后正文
  if (/<\/think>/i.test(t)) {
    t = t.replace(/^[\s\S]*?<\/think>\s*/i, '');
  }
  // 未闭合的开头标签占满整段 → 当作全是思考
  if (/^<think(?:ing)?\b/i.test(t.trim()) && !/<\/think(?:ing)?>/i.test(t)) {
    return '';
  }

  // 中文「思考过程」块：独占开头且后面有空行再跟正文时才剥
  t = t.replace(/^(?:【\s*(?:思考|推理|分析)(?:过程|链)?\s*】|(?:思考|推理|分析)过程\s*[:：])\s*\n[\s\S]*?\n\n+/u, '');

  // 复读【心里话】系统说明（含旧版「先写两行」「正文 =」）
  t = stripThinkInstructionEcho(t);

  // 表情相关泄漏：/详情、[/详情]（不要在这里剥 [/表情]，否则会破坏表情标记解析）
  t = t.replace(/\[\s*\/?\s*详情\s*\]/g, '');
  t = t.replace(/\/\s*详情/g, '');

  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 心里话开闭标签：当前两行草稿 + 旧三步（怎么做/决定…） */
const MIND_PRIVATE_TAG = '怎么看这件事|怎么想这件事|决定做什么|决定不说什么|决定怎么说|怎么看|什么感觉|怎么想|没说出口|怎么做|这一拍心思|动手|提不提';

/**
 * 模型把【心里话】提示原文抄进气泡时整段清掉。
 * 只动指令指纹与空壳标记，不动真正的 [怎么看]内容[/怎么看]（留给 stripMindPrivateTags）。
 */
function stripThinkInstructionEcho(text) {
  let t = String(text || '');
  if (!t) return '';
  // 标题行：【心里话】… / 【心里话·草稿】…
  t = t.replace(/【\s*心里话[^】]*】[^\n]*/g, '');
  // 旧/新说明句（可夹在段首，不只整行）
  t = t.replace(/(?:^|\n)\s*(?:先写两行|用户看不见|再写正文|再另起开口|只写下面两行标记|不要抄本段说明)[^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*标记后面的正文\s*[=＝][^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*两行标记之后才是(?:日记正文|微信开口)[^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*禁止把本段任何(?:标题|说明|条目)[^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*[·•\-＊*]\s*(?:标记是私货|心里觉得)[^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*心里觉得\s*[≠!=＝][^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*禁止「我怎么看这件事：」[^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*标记里禁止写提示词[^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*标记里的判断禁止[^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*看法只用【心智】[^\n]*/g, '\n');
  t = t.replace(/(?:^|\n)\s*还没有心智时按【性格】[^\n]*/g, '\n');
  // 空壳模板：内容只有省略号/空白
  t = t.replace(
    new RegExp(`[\\[【［]\\s*(?:${MIND_PRIVATE_TAG})\\s*[\\]】］]\\s*[.…。．\\s]*[\\[【［]\\s*\\/\\s*(?:${MIND_PRIVATE_TAG})\\s*[\\]】］]`, 'gi'),
    '',
  );
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function normMindsetEcho(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[。！？…!?，,、；;：:「」""''《》【】[\]()（）~\-—]/g, '')
    .toLowerCase();
}

/** 剥掉 [怎么看]/[什么感觉]/[怎么做]/[决定…] 等心里话标记；兼容【】、一行冒号式、未闭合。 */
function stripMindPrivateTags(text) {
  let t = String(text || '');
  if (!t) return '';
  // 成对（允许跨行；闭标签名可与开标签不同）
  t = t.replace(new RegExp(`[\\[【［]\\s*(?:${MIND_PRIVATE_TAG})\\s*[\\]】］][\\s\\S]*?[\\[【［]\\s*\\/\\s*(?:${MIND_PRIVATE_TAG})\\s*[\\]】］]`, 'gi'), '');
  // 一行式 [怎么看:…] / ［怎么做：…］
  t = t.replace(new RegExp(`[\\[【［]\\s*(?:${MIND_PRIVATE_TAG})\\s*[:：][^\\]】］\\n]*[\\]】］]`, 'gi'), '');
  // 未闭合：吃到行尾或下一个 [
  t = t.replace(new RegExp(`[\\[【［]\\s*(?:${MIND_PRIVATE_TAG})\\s*[\\]】］][^\\n\\[【［]*`, 'gi'), '');
  t = t.replace(new RegExp(`[\\[【［]\\s*\\/\\s*(?:${MIND_PRIVATE_TAG})\\s*[\\]】］]`, 'gi'), '');
  // 裸标题行：怎么看：… / 怎么做：…（整行丢掉；短词必须带冒号，避免误伤口语）
  t = t.replace(new RegExp(`(?:^|\\n)\\s*(?:我)?(?:${MIND_PRIVATE_TAG})\\s*[:：][^\\n]*`, 'gi'), '\n');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 模型把喂给它看的历史通道标签抄进正文时剥掉（用户不应看见）。
 * 例：[通话]你说：… / [通话] 对方说：… / [文字]
 * 不误伤口语「你说了算」「对方说得对」。
 */
function stripHistoryChannelEcho(text) {
  let t = String(text || '');
  if (!t) return '';
  t = t.replace(/[\[【［]\s*通话\s*[\]】］]\s*(?:你说|对方说|我说)?\s*[:：]?\s*/g, '');
  t = t.replace(/[\[【［]\s*文字\s*[\]】］]\s*(?:你说|对方说|我说)?\s*[:：]?\s*/g, '');
  t = t.replace(/(?:^|\n)\s*(?:你说|对方说)\s*[:：]\s*/g, '\n');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 用户可见正文统一清洗：心里话草稿 + 挂断类指令 + 通道标签抄写。
 * 朋友圈 / 日记 / 通话字幕 / 气泡都走这一套，和 [挂断] 一样「写得出、看不见」。
 */
function scrubUserVisibleText(text, mindset = '') {
  let t = String(text || '');
  if (!t) return '';
  t = stripMindsetEcho(t, mindset);
  t = stripAiContextLabels(t);
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 旧泄漏：标题 + 冒号（或无冒号换行）。短标签必须带冒号，避免误伤「你问我怎么看你」。 */
const MIND_STEP_FULL = '(?:我)?(?:怎么看这件事|怎么想这件事|什么感觉|决定做什么|决定不说什么|决定怎么说)';
const MIND_STEP_SHORT = '(?:我)?(?:怎么看|怎么想|怎么做)';
const MIND_STEP_ANY = `(?:${MIND_STEP_FULL}|${MIND_STEP_SHORT})`;
const MIND_STEP_PREFIX = '(?:(?:\\d+|[一二三四五])[.、)）]\\s*)?(?:[-*•]\\s*)?';
const MIND_STEP_HEADER_SRC = `${MIND_STEP_PREFIX}(?:【\\s*${MIND_STEP_ANY}\\s*】|${MIND_STEP_FULL}|${MIND_STEP_SHORT}(?=\\s*[:：]))\\s*[:：]?\\s*`;
const MIND_STEP_ECHO_RE = /(?:^|[\n\s。！？!?；;])(?:我)?怎么看这件事\s*[、,，]\s*(?:我)?什么感觉\s*[、,，]\s*(?:我)?决定(?:做什么|怎么说|不说什么)\s*[。．.]?/g;

/**
 * 旧格式兜底：丢掉「我怎么看这件事：」类标题及其心里话，只留开口。
 */
function speechOutsideMindSteps(text) {
  let t = String(text || '');
  if (!t.trim()) return '';
  t = t.replace(MIND_STEP_ECHO_RE, (m) => (/^[\n]/.test(m) ? '\n' : ''));

  const re = new RegExp(MIND_STEP_HEADER_SRC, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(0, m.index);
    if (before && !/(?:^|[\s。！？!?；;\n])$/.test(before)) continue;
    hits.push({ index: m.index, end: m.index + m[0].length });
  }
  if (!hits.length) return t.trim();

  const parts = [];
  const lead = t.slice(0, hits[0].index).replace(/[\s。！？!?；;]+$/g, '').trim()
    .replace(/^(?:(?:\d+|[一二三四五])[.、)）]\s*)+$/g, '').trim();
  if (lead) parts.push(lead);

  const last = hits[hits.length - 1];
  const body = t.slice(last.end).replace(/^\s+/, '');
  const firstLineEnd = body.search(/\n/);
  const firstLine = firstLineEnd >= 0 ? body.slice(0, firstLineEnd) : body;
  const cutInFirst = firstLine.search(/[。！？…!?]/);
  if (cutInFirst >= 0) {
    const rest = body.slice(cutInFirst + 1).trim();
    if (rest) parts.push(rest);
  } else if (firstLineEnd >= 0) {
    const rest = body.slice(firstLineEnd + 1).trim();
    if (rest) parts.push(rest);
  }
  return parts.join('\n').trim();
}

/** 心智原文 + 心里话标记 / 旧三步标题：拆气泡前丢掉。 */
function stripMindsetEcho(text, mindset) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  let speech = stripMindPrivateTags(
    stripThinkInstructionEcho(raw.replace(/^【\s*心智\s*】\s*/gm, '')),
  );
  speech = speechOutsideMindSteps(speech);
  if (!speech) return '';
  const mind = normMindsetEcho(mindset);
  if (mind.length < 20) return speech;
  const kept = [];
  for (const chunk of speech.split(/\n+/)) {
    const line = chunk.trim();
    if (!line) continue;
    const sentences = line.split(/(?<=[。！？…])/).map((s) => s.trim()).filter(Boolean);
    const units = sentences.length ? sentences : [line];
    const ok = [];
    for (const unit of units) {
      const n = normMindsetEcho(unit);
      if (n.length >= 12 && mind.includes(n)) continue;
      ok.push(unit);
    }
    if (ok.length) kept.push(ok.join(''));
  }
  return kept.join('\n').trim();
}

function findLastEmoji(emojis, pred) {
  const list = emojis || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (pred(list[i])) return list[i];
  }
  return null;
}

function findEmojiByDescription(desc, emojis) {
  const d = normalizeEmojiDesc(desc);
  if (!d) return null;
  // 同描述有新旧两张时用最新的（重新上传的那张）
  let hit = findLastEmoji(emojis, e => e.description === d);
  if (hit) return hit;
  hit = findLastEmoji(emojis, e => normalizeEmojiDesc(e.description) === d);
  if (hit) return hit;
  hit = findLastEmoji(emojis, e => e.description.includes(d) || d.includes(e.description));
  if (hit) return hit;
  const dl = d.toLowerCase();
  hit = findLastEmoji(emojis, e => e.description.toLowerCase() === dl);
  if (hit) return hit;
  return findLastEmoji(emojis, e =>
    e.description.toLowerCase().includes(dl) || dl.includes(e.description.toLowerCase())
  );
}

// ===== 撤回（AI 后悔刚发的话） =====
// 标记本身不区分"撤上一轮"还是"撤这一轮刚说的"：出现在整段最前面 = 撤上一轮真正发送过的消息；
// 出现在这一轮文本中间 = 撤的是这一轮里、紧挨在它前面那句刚"发出去"的话。
const RECALL_TOKEN_SRC = '[\\[【]撤回(?:上一条|上一句|刚才那条|刚才那句)?[\\]】]';
const RECALL_MARK_RE = new RegExp(`^\\s*${RECALL_TOKEN_SRC}\\s*\\n*`);
const INLINE_RECALL_RE = new RegExp(RECALL_TOKEN_SRC, 'g');

function extractRecallDirective(text) {
  const t = String(text || '');
  const m = t.match(RECALL_MARK_RE);
  if (!m) return { recall: false, text: t };
  return { recall: true, text: t.slice(m[0].length) };
}

/** 撤回该角色最近一条未撤回的 AI 消息（供 AI 自己"后悔"上一轮说的话时调用） */
function recallLastAiMessage(characterId, isDream) {
  if (!characterId) return null;
  const row = db.prepare(
    `SELECT id, content FROM messages WHERE character_id=? AND role='assistant' AND is_dream=? AND recalled=0 AND (type IS NULL OR type NOT IN ('system')) ORDER BY id DESC LIMIT 1`
  ).get(characterId, isDream ? 1 : 0);
  if (!row) return null;
  db.prepare(`UPDATE messages SET recalled=1, recalled_content=content, content='对方撤回了一条消息' WHERE id=?`).run(row.id);
  try {
    if (!isDream) require('./process-time-helper').onAssistantMessagesChanged(characterId, { droppedContents: [row.content] });
  } catch {}
  return { id: row.id, content: row.content };
}

/** 去掉正文中间残留的撤回标记（通话模式等不做同轮撤回动画的场景兜底剥离） */
function stripInlineRecallMarkers(text) {
  return String(text || '').replace(INLINE_RECALL_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 按行内撤回标记切成若干段：recallAfter=true 表示这一段拆出的最后一条气泡"发出去"后要立刻被撤回 */
function splitByInlineRecallMarkers(text) {
  const t = String(text || '');
  const re = new RegExp(RECALL_TOKEN_SRC, 'g');
  const parts = [];
  let lastIndex = 0;
  let m;
  while ((m = re.exec(t)) !== null) {
    parts.push({ text: t.slice(lastIndex, m.index), recallAfter: true });
    lastIndex = m.index + m[0].length;
  }
  parts.push({ text: t.slice(lastIndex), recallAfter: false });
  return parts;
}

// ===== 引用回复（AI 明确回应/追问用户某句原话） =====
const QUOTE_MARK_PATTERNS = [
  // 标准：[引用]…[/引用] 或 【引用】…【/引用】
  /^\s*[\[【]\s*引用\s*[\]】]\s*([\s\S]*?)\s*[\[【]\s*\/\s*引用\s*[\]】]\s*/,
  // [引用：…] / [引用:…]
  /^\s*[\[【]\s*引用\s*[:：]\s*([\s\S]*?)\s*[\]】]\s*/,
  // [引用]内容]（少见闭合）
  /^\s*[\[【]\s*引用\s*[\]】]\s*([^\[【\]】\n]+)\s*[\]】]\s*/,
];

/** 未闭合的 [引用]… ：常见模型漏写 [/引用] */
function extractUnclosedQuoteMarker(text) {
  const t = String(text || '');
  const m = t.match(/^\s*[\[【]\s*引用\s*[\]】]\s*([\s\S]*)$/);
  if (!m) return null;
  let rest = m[1];
  // 若后面其实有 [/引用]（中间夹了空白/换行），按闭合处理
  const close = rest.match(/^([\s\S]*?)\s*[\[【]\s*\/\s*引用\s*[\]】]\s*([\s\S]*)$/);
  if (close && close[1].trim()) {
    return { quote: close[1].trim(), text: close[2] || '' };
  }
  // 第一行当引用，其后当正文
  const nl = rest.indexOf('\n');
  if (nl >= 0) {
    const quote = rest.slice(0, nl).replace(/[\[【]\s*\/\s*引用\s*[\]】]\s*$/g, '').trim();
    const body = rest.slice(nl + 1);
    if (quote) return { quote, text: body };
  }
  // 同一行：[引用]原话。后面的回复
  const sent = rest.match(/^(.+?[。！？!?…]+)\s+([\s\S]+)$/);
  if (sent && sent[1].trim() && sent[2].trim()) {
    return { quote: sent[1].trim(), text: sent[2] };
  }
  const sent2 = rest.match(/^(.+?[。！？!?])([\s\S]+)$/);
  if (sent2 && sent2[1].trim() && sent2[2].trim().length >= 2) {
    return { quote: sent2[1].trim(), text: sent2[2] };
  }
  // 整段都是引用、没有正文
  const q = rest.replace(/[\[【]\s*\/\s*引用\s*[\]】]/g, '').trim();
  if (q) return { quote: q, text: '' };
  return null;
}

function extractQuoteMarker(text) {
  const t = String(text || '');
  for (const re of QUOTE_MARK_PATTERNS) {
    const m = t.match(re);
    if (m && m[1] && m[1].trim()) {
      return { quote: m[1].trim(), text: t.slice(m[0].length) };
    }
  }
  return extractUnclosedQuoteMarker(t);
}

const CALL_TAG_RE = /[\[【［]\s*(?:打(?:个)?电话|语音电话|语音通话|来电|视频电话|视频通话)\s*(?:[:：][^\]]{0,20})?\s*[\]】］]/gi;
// [挂断] / [end_call] / [结束通话] / [结束电话] / [挂掉] — 角色主动挂掉当前通话
const END_CALL_TAG_RE = /[\[【［]\s*(?:end_call|挂断|结束通话|结束电话|挂掉电话|挂电话)\s*(?:[:：][^\]\n]{0,40})?\s*[\]】］]/gi;

/**
 * 从正文抽出 [挂断]/[end_call] 等。若同时出现 [打电话]/[视频电话]，挂断优先（先挂再打）。
 * @returns {{ text: string, wantEnd: boolean, reason: string }}
 */
function extractEndCallDirective(text) {
  END_CALL_TAG_RE.lastIndex = 0;
  let wantEnd = false;
  let reason = '';
  const t = String(text || '').replace(END_CALL_TAG_RE, (m) => {
    wantEnd = true;
    const colon = m.match(/[:：]\s*([^\]\n]{0,40})/);
    if (colon) reason = colon[1].trim();
    return '\n';
  });
  return {
    text: t.replace(/\n{3,}/g, '\n\n').trim(),
    wantEnd,
    reason,
  };
}

/** 挂断标记前是听筒里的最后一句，标记后是回到微信的文字 */
function splitEndCallSpeech(text) {
  const raw = String(text || '');
  END_CALL_TAG_RE.lastIndex = 0;
  const m = END_CALL_TAG_RE.exec(raw);
  if (!m) return { before: raw.trim(), after: '', wantEnd: false, reason: '' };
  const colon = m[0].match(/[:：]\s*([^\]\n]{0,40})/);
  return {
    before: raw.slice(0, m.index).trim(),
    after: raw.slice(m.index + m[0].length).trim(),
    wantEnd: true,
    reason: colon ? colon[1].trim() : '',
  };
}

function isCallStartContent(content) {
  const c = String(content || '');
  return /通话开始/.test(c) && !/结束/.test(c);
}

function isCallEndContent(content) {
  const c = String(content || '');
  return /通话已结束|通话被对方结束/.test(c) || (/通话结束/.test(c) && !/开始/.test(c));
}

/**
 * 给一段历史标上「这句是电话里说的」。
 * 接通到挂断之间的对白是通话；挂断之后、接通之前是微信。
 * 窗口从半路截进来、第一条通话标记是结束时，结束之前算还在电话里。
 */
function applyCallChannelMarks(history) {
  const list = Array.isArray(history) ? history : [];
  let open = false;
  for (let i = 0; i < list.length; i++) {
    const c = String(list[i]?.content || '');
    if (isCallStartContent(c)) break;
    if (isCallEndContent(c)) { open = true; break; }
  }
  for (const m of list) {
    const c = String(m?.content || '');
    if (isCallStartContent(c)) {
      open = true;
      m._callChannel = false;
      continue;
    }
    if (isCallEndContent(c)) {
      open = false;
      m._callChannel = false;
      continue;
    }
    const type = m?.type || 'text';
    const dialogue = type === 'text' || type === 'voice';
    m._callChannel = !!(open && dialogue && (m.role === 'user' || m.role === 'assistant'));
  }
  return list;
}

/** 整句只是在确认听筒，不是聊天 */
function isOnlyPhonePickup(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const compact = raw.replace(/\s+/g, '').replace(/[—\-–~～。！？!?，,、.：:]+/g, '');
  if (!compact || compact.length > 18) return false;
  const hasCheck = /(能听见|听得见|听得到|听得清|听见了)/.test(compact);
  const hasDash = /[—\-–]/.test(raw);
  if (!hasCheck && !hasDash) return false;
  return /^(喂|喂喂)?(你)?(那边)?(能听见吗|听得见吗|听得到吗|听得清吗|听见了吗|在吗)?$/.test(compact)
    && /(喂|听见|听得)/.test(compact);
}

/** 去掉开头的「喂——能听见吗」，留下后面真正要说的话 */
function stripLeadingPhonePickup(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  if (isOnlyPhonePickup(t)) return '';
  const phrase = t.match(/^(?:喂|喂喂)[\s—\-–~～.。，,]*?(能听见吗|听得见吗|听得到吗|听得清吗|听见了吗)/);
  if (!phrase) return t;
  const cut = phrase.index + phrase[0].length;
  return t.slice(cut).replace(/^[\s。！？!?，,：:~～—\-–]+/, '').trim();
}

/** 最近一条通话系统消息是开始还是结束。rows 从新到旧或从旧到新都行，以最后出现的为准需调用方排好；这里按数组顺序扫，后者覆盖前者。 */
function latestCallPhaseFromMessages(messages) {
  let phase = '';
  for (const m of messages || []) {
    const c = String(m?.content || '');
    if (!c) continue;
    if (/通话开始/.test(c) && !/结束/.test(c)) phase = 'start';
    else if (/通话已结束|通话被对方结束/.test(c) || (/通话结束/.test(c) && !/开始/.test(c))) phase = 'end';
  }
  return phase;
}

/** 库里最新一条通话系统消息。用户先挂、模型回复后到时，请求开始时的历史里还没有「已结束」。 */
function latestPersistedCallPhase(characterId) {
  const cid = Number(characterId) || 0;
  if (!cid) return '';
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT content FROM messages WHERE character_id=? AND type='system' AND COALESCE(is_dream,0)=0 ORDER BY id DESC LIMIT 24`
    ).all(cid);
  } catch {
    return '';
  }
  for (const m of rows) {
    const c = String(m?.content || '');
    if (/通话开始/.test(c) && !/结束/.test(c)) return 'start';
    if (/通话已结束|通话被对方结束/.test(c) || (/通话结束/.test(c) && !/开始/.test(c))) return 'end';
  }
  return '';
}

function buildPostCallChatNote(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let after = 0;
  let seenEnd = false;
  for (const m of list.slice(-8)) {
    const c = String(m?.content || '');
    const isStart = /通话开始/.test(c) && !/结束/.test(c);
    const isEnd = /通话已结束|通话被对方结束/.test(c) || (/通话结束/.test(c) && !/开始/.test(c));
    if (isStart) { seenEnd = false; after = 0; continue; }
    if (isEnd) { seenEnd = true; after = 0; continue; }
    if (seenEnd && m?.role !== 'system') after += 1;
  }
  // 只压挂完后的头一两句，避免整段聊天都不敢发语音
  if (!seenEnd || after > 1) return '';
  return '【当前通道】现在是微信打字，不是电话。上文标 [通话] 的是已经挂断的那通，只当记录。用文字气泡接，不要发语音条接着打电话，不要「喂」，不要问能不能听见。';
}

/** 挂断气泡还在最近几条里，且之后几乎还没正常聊过 */
function recentChatLeftCall(characterId) {
  const cid = Number(characterId) || 0;
  if (!cid) return false;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT role, content FROM messages WHERE character_id=? AND COALESCE(is_dream,0)=0 ORDER BY id DESC LIMIT 8`
    ).all(cid);
  } catch {
    return false;
  }
  return buildPostCallChatNote(rows.slice().reverse()) !== '';
}

/**
 * 剥掉残留在正文里的系统指令标签（模型漏格式时兜底，避免变成可见气泡）
 * 不含表情标记（表情另有解析流程）。
 * keepCallTags：先别剥 [打电话]/[挂断]，后面还要解析。
 * keepQuoteTags / keepRecallTags / keepPokeTags / keepToneTag / keepPeerTags：
 * 聊天预清理要留到各自的解析器，单独成行时也不能被下面的空标记规则删掉。
 */
function stripResidualDirectiveTags(text, opts = {}) {
  let t = stripModelLeakage(text);
  if (!t) return '';
  // 完整引用块（任意位置）。预解析阶段先留着，extractQuoteMarker 再剥
  if (!opts.keepQuoteTags) {
    t = t.replace(/[\[【]\s*引用\s*[\]】][\s\S]*?[\[【]\s*\/\s*引用\s*[\]】]/g, '');
    t = t.replace(/[\[【]\s*引用\s*[:：][^\]】\n]*[\]】]/g, '');
    // 未闭合 [引用]… 到行尾或下一标记
    t = t.replace(/[\[【]\s*引用\s*[\]】][^\n\[【]*/g, '');
    t = t.replace(/[\[【]\s*\/\s*引用\s*[\]】]/g, '');
  }
  // 残留撤回标记。预解析阶段先留着，extractRecall / 同轮撤回再剥
  if (!opts.keepRecallTags) t = t.replace(INLINE_RECALL_RE, '');
  // 桌宠机器标记（[动作:…][表情:…][灯光:…][舵机:…][桌宠:…]，含【】／未闭合／括号写法）
  // 必须带冒号，以免误剥表情包 [表情]描述[/表情]
  t = t.replace(/[\[【［]\s*(?:表情|情绪|emotion|动作|动作指令|motion|灯光|灯|LED|led|舵机|伺服|servo|桌宠|语速)\s*[：:][^\]】］\n]*[\]】］]?/gi, '');
  // 拆句时要留着 [语气:xx]，等入库那一步摘出来存进 media_meta 再剥
  if (!opts.keepToneTag) {
    t = t.replace(/[\[【［]\s*语气\s*[：:][^\]】］\n]*[\]】］]?/gi, '');
  }
  t = t.replace(/[（(]\s*(?:表情|情绪|动作|灯光|舵机)\s*[：:][^）)\n]{0,40}[）)]/gi, '');
  t = t.replace(/\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi, '');
  // 拍一拍指令标记（用户不应看见）。预解析要留到 extractPokeDirective。
  if (!opts.keepPokeTags) {
    t = t.replace(/\[\s*拍一拍\s*(?:[:：][^\]]{0,20})?\s*\]/gi, '');
  }
  // 心里话标记（与 stripMindsetEcho 一致，历史复读时再剥一次）
  t = stripMindPrivateTags(t);
  // 模型把历史通道格式抄进可见正文：[通话]你说： / [通话]对方说： / [文字]
  t = stripHistoryChannelEcho(t);
  // 过程时间自报 / 泄漏的系统块（用户不应看见）
  t = t.replace(/[\[【［]\s*过程(?:时间)?\s*[:：][^\]】］\n]{0,48}[\]】］]?/gi, '');
  // 【过程时间·硬性】/【过程时间】块：只剥到本句结束（。！？!?），避免把后面正常正文吃掉
  t = t.replace(/【\s*过程时间[^】]{0,12}】\s*[^\n]*?[。！？!?]/g, (m) => {
    // 仅当这一行除了标签+这一句外没有别的内容时才整行去掉；否则只去掉标签+句前空白
    return '';
  });
  t = t.replace(/^\s*【\s*主动[·・.]?(?:到达报平安|到了|事情做完了)[^】]*】\s*/gm, '');
  // 睡眠情境 / 时间推进 / 重新回复 / 先前打算 / 新版 <SYS_…> 系统块
  // 这些块的特征：开头是一个明显的系统标签（【睡眠情境·xxx】/【时间推进·xxx】/【重新回复·xxx】/【先前打算·xxx】/<SYS_…>），
  // 内容是自然语言，模型有时会整段复读，导致「状态词夹在角色正常输出里看着像乱码」。
  // 剥离策略：从标记出现处开始，剥到下一个空行 / 文末 / 最多 6 行（这些块一般 1-4 行）。
  t = (() => {
    const re = /【\s*(?:睡眠情境|时间推进|重新回复|先前打算|时间事实|收尾)[·・.:：]?[^】\n]*】|<SYS_(?:SLEEP|INTENT|RETRY|TIMEADVANCE|REST_ELAPSED|PLAN_ELAPSED|NIGHT_WAKE|GOODNIGHT_RE|SLEEPY_RE|LATE_CHAT|ABSENCE)_[A-Z0-9_]*>/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      out += t.slice(last, m.index);
      // 从 m.index 开始向后扫描，最多到下一个空行 / 文末 / 6 行
      let i = re.lastIndex;
      let lines = 0;
      while (i < t.length && lines <= 6) {
        if (t[i] === '\n') {
          lines++;
          if (t[i + 1] === '\n') { i += 1; break; } // 空行停止
        }
        // 如果遇到「明确正文开头」标记：行首非空白后跟中文标点或常规聊天语气——不在这处理，让它走完
        i++;
      }
      // 收尾的换行也吃掉，避免留下空行
      while (out.length === 0 && i < t.length && t[i] === '\n') i++;
      last = i;
      re.lastIndex = i;
    }
    out += t.slice(last);
    return out;
  })();
  if (!opts.keepCallTags) {
    CALL_TAG_RE.lastIndex = 0;
    t = t.replace(CALL_TAG_RE, '');
    END_CALL_TAG_RE.lastIndex = 0;
    t = t.replace(END_CALL_TAG_RE, '');
  }
  // 小剧场场景状态标记（用户不应看见）
  t = t.replace(/\[\s*场景状态\s*\][\s\S]*?\[\s*\/\s*场景状态\s*\]/gi, '');
  t = t.replace(/\[\s*场景状态\s*\][\s\S]*$/i, '');
  t = t.replace(/\[\s*\/\s*场景状态\s*\]/gi, '');
  // 开/关小剧场标记（解析后也会剥；这里兜底不泄漏）
  t = t.replace(/\[\s*(?:开启|结束)小剧场\s*\]/g, '');
  // 视频电话文字镜头（通话页单独显示，气泡里不展示）
  t = t.replace(/\[\s*镜头\s*\][\s\S]*?\[\s*\/\s*镜头\s*\]/gi, '');
  t = t.replace(/\[\s*镜头\s*\][\s\S]*$/i, '');
  t = t.replace(/\[\s*\/\s*镜头\s*\]/gi, '');
  // 注意：不要剥 [位置]/[/位置]、[链接]/[/链接]、[网页卡]——留给卡片解析；
  // 下面「整行空标记」也必须跳过这些开闭标签，否则会拆坏成只剩闭标签
  // 历史标签
  t = t.replace(/[\[【［]\s*(?:文字|语音|语音条|语音消息)\s*[\]】］]\s*/g, '');
  // 单独一行的空标记残骸（引用/撤回等），但保留位置/链接/网页卡开闭行、以及单独的小黄豆
  t = t.replace(/^\s*[\[【][^\]】]{0,12}[\]】]\s*$/gm, (line) => {
    if (/[\[【［]\s*\/?\s*(?:发送\s*)?(?:位置|链接|分享|网页卡|前端卡)\s*[\]】］]/i.test(line)) return line;
    // [换头像] 要留到换头像判断之后再剥，单独一行时不能当空标记删掉
    if (/[\[【［]\s*(?:换头像|同意换头像)\s*[\]】］]/.test(line)) return line;
    if (opts.keepPokeTags && /[\[【［]\s*拍一拍/.test(line)) return line;
    if (opts.keepRecallTags && /[\[【［]\s*撤回/.test(line)) return line;
    if (opts.keepToneTag && /[\[【［]\s*语气\s*[:：]/.test(line)) return line;
    if (opts.keepQuoteTags && /[\[【［]\s*\/?\s*引用\s*[\]】］]/.test(line)) return line;
    if (opts.keepPeerTags && /[\[【［]\s*(?:拉黑用户|解除拉黑|删除用户|删除好友关系|解绑\s*TA)\s*[\]】］]/.test(line)) return line;
    if (isBeanOnlyText(line)) return line;
    if (opts.keepCallTags) {
      CALL_TAG_RE.lastIndex = 0;
      END_CALL_TAG_RE.lastIndex = 0;
      if (CALL_TAG_RE.test(line) || END_CALL_TAG_RE.test(line)) return line;
    }
    return '';
  });
  return t
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 整段只是一只/一串系统小黄豆 */
function isBeanOnlyText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (!/^(\[[^\[\]\n]{1,20}\]\s*)+$/.test(s)) return false;
  const codes = [];
  s.replace(/\[([^\[\]\n]{1,20})\]/g, (_, code) => {
    codes.push(String(code).trim());
    return _;
  });
  return codes.length > 0 && codes.every((c) => isKnownBean(c));
}

function isPeriodOnlyText(text) {
  return /^[。．.\s]+$/.test(String(text || '').trim());
}

/** 模型从历史 [语音]/[文字] 学来的空标签，不是台词 */
function isBareMediaLabel(text) {
  const t = String(text || '').trim().replace(/[。．.！!？?\s]+$/g, '');
  if (!t) return false;
  return /^(?:[\[【［(（]\s*)?(?:文字|语音|语音条|语音消息|环境音)(?:\s*[\]】］)）])?$/.test(t);
}

/** 这段文字是否只剩指令标签/空白（应丢弃，不当气泡） */
function isDirectiveOnlyText(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (isPeriodOnlyText(raw) || isBareMediaLabel(raw)) return true;
  if (isBeanOnlyText(raw)) return false;
  const cleaned = stripResidualDirectiveTags(raw);
  if (!cleaned || isBareMediaLabel(cleaned)) return true;
  if (/^[\[【［][^\]】］]{0,24}[\]】］]$/.test(raw)) return true;
  if (/^[\[【［]\s*(?:引用|\/\s*引用|撤回|文字|语音|表情|表情包|位置|\/\s*位置|发送\s*位置|\/\s*发送\s*位置|链接|\/\s*链接|分享|\/\s*分享|网页卡|\/\s*网页卡|前端卡|\/\s*前端卡|拍一拍|打电话|语音电话|视频电话|视频通话|来电|动作|灯光|舵机|桌宠|怎么看|\/\s*怎么看|什么感觉|\/\s*什么感觉|怎么想|\/\s*怎么想|没说出口|\/\s*没说出口|怎么做|\/\s*怎么做|这一拍心思|\/\s*这一拍心思|动手|\/\s*动手|提不提|\/\s*提不提|决定做什么|\/\s*决定做什么|决定怎么说|\/\s*决定怎么说|决定不说什么|\/\s*决定不说什么|怎么看这件事|\/\s*怎么看这件事|怎么想这件事|\/\s*怎么想这件事)\s*[\]】］]$/i.test(raw)) return true;
  // 整段只剩桌宠动作/表情标记（描述可能较长，超过 24 字）
  if (/^[\[【［]\s*(?:表情|情绪|动作|灯光|舵机|桌宠)\s*[：:][^\]】］{0,80}[\]】］]$/i.test(raw)) return true;
  // 裸残留定位/链接/网页卡闭标签
  if (/^[\[【［]\s*\/\s*(?:发送\s*)?(?:位置|链接|分享|网页卡|前端卡)\s*[\]】］]$/i.test(raw)) return true;
  // 仅含乐谱系统指令
  if (/^(?:乐谱[：:]\s*|SCORE:\s*).+$/i.test(raw)) return true;
  if (/^\[\s*乐谱\s*\][\s\S]*\[\s*\/\s*乐谱\s*\]$/i.test(raw)) return true;
  return false;
}

/** 解析 [位置]地点[/位置] 或 [位置]地点|简述；兼容【】、发送位置、冒号写法 */
function parseLocationPayload(raw, char) {
  let s = String(raw || '')
    .replace(/^\[?\s*(?:发送\s*)?位置\s*[:：\]】］]?\s*/i, '')
    .replace(/\s*[\[【［]\s*\/\s*(?:发送\s*)?位置\s*[\]】］]\s*$/i, '')
    .trim();
  let name = s;
  let address = '';
  const parts = s.split(/[|｜]/);
  if (parts.length >= 2) {
    name = parts[0].trim();
    address = parts.slice(1).join(' ').trim();
  }
  if (!name || name === '位置' || name === '这里' || name === '我这边' || name === '发送位置') {
    const fallback = String(char?.location_name || char?.real_location || '').trim();
    if (fallback) name = fallback;
  }
  name = String(name || '我这边').replace(/\s+/g, ' ').slice(0, 48);
  address = String(address || '').replace(/\s+/g, ' ').slice(0, 80);
  return { name, address };
}

/** 把各种「发位置」写法归一成可解析形式 */
function normalizeLocationMarkerText(text) {
  let t = String(text || '');
  // 全角方括号先转半角，避免 ［位置］／［/位置］漏解析
  t = t.replace(/［/g, '[').replace(/］/g, ']');
  // 【发送位置：外滩】/【位置：xx】整段
  t = t.replace(/【\s*(?:发送\s*)?位置\s*[:：]\s*([^】]+)】/gi, (_, p) => `[位置]${String(p).trim()}[/位置]`);
  // [发送位置：上海] / [位置：星河之城] 整段（含收尾 ]）
  t = t.replace(/\[\s*(?:发送\s*)?位置\s*[:：]\s*([^\]]+)\]/gi, (_, p) => `[位置]${String(p).trim()}[/位置]`);
  // 【位置】…【/位置】
  t = t.replace(/【\s*\/\s*(?:发送\s*)?位置\s*】/gi, '[/位置]');
  t = t.replace(/【\s*(?:发送\s*)?位置\s*】/gi, '[位置]');
  // [发送位置] → [位置]
  t = t.replace(/\[\s*\/\s*发送\s*位置\s*\]/gi, '[/位置]');
  t = t.replace(/\[\s*发送\s*位置\s*\]/gi, '[位置]');
  return t;
}

function stripOrphanLocationTags(text) {
  return String(text || '')
    .replace(/[\[【［]\s*\/\s*(?:发送\s*)?位置\s*[\]】］]/gi, '')
    .replace(/[\[【［]\s*(?:发送\s*)?位置\s*[\]】］]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pushLocationSegment(out, rawPayload, char, recallAfterSend) {
  const { name, address } = parseLocationPayload(rawPayload, char);
  const content = address ? `${name}|${address}` : name;
  out.push({
    type: 'location',
    content,
    location: name,
    address,
    quotePreview: undefined,
    recallAfterSend: !!recallAfterSend,
  });
}

function applyLocationMarkersToSegments(segments, char) {
  if (!Array.isArray(segments) || !segments.length) return segments || [];
  const out = [];
  // 两段式：先闭合块，再处理只开不闭；避免「[位置]地名」吃掉前半、留下 [/位置]
  const closedRe = /\[\s*位置\s*\]\s*([\s\S]*?)\s*\[\s*\/\s*位置\s*\]/gi;
  const openRe = /\[\s*位置\s*\]\s*([^\n\[]+)/gi;

  for (const seg of segments) {
    if (seg.type !== 'text') {
      out.push(seg);
      continue;
    }
    let text = normalizeLocationMarkerText(seg.content || '');
    if (!/\[\s*位置\s*\]/i.test(text) && !/\[\s*\/\s*位置\s*\]/i.test(text)) {
      out.push(seg.type === 'text' && text !== seg.content ? { ...seg, content: text } : seg);
      continue;
    }

    // Pass 1: 闭合 [位置]…[/位置]
    const pieces = [];
    let last = 0;
    let m;
    closedRe.lastIndex = 0;
    while ((m = closedRe.exec(text)) !== null) {
      const before = text.slice(last, m.index);
      if (before) pieces.push({ kind: 'text', text: before });
      pieces.push({ kind: 'location', payload: m[1] || '' });
      last = m.index + m[0].length;
    }
    if (last < text.length) pieces.push({ kind: 'text', text: text.slice(last) });
    if (!pieces.length) pieces.push({ kind: 'text', text });

    // Pass 2: 剩余文本里的未闭合 [位置]…
    for (const piece of pieces) {
      if (piece.kind === 'location') {
        pushLocationSegment(out, piece.payload, char, seg.recallAfterSend);
        continue;
      }
      let rest = piece.text;
      if (!/\[\s*位置\s*\]/i.test(rest)) {
        rest = stripOrphanLocationTags(rest);
        if (rest) out.push({ type: 'text', content: rest, quotePreview: seg.quotePreview, recallAfterSend: seg.recallAfterSend });
        continue;
      }
      openRe.lastIndex = 0;
      let oLast = 0;
      let om;
      let any = false;
      while ((om = openRe.exec(rest)) !== null) {
        any = true;
        const before = stripOrphanLocationTags(rest.slice(oLast, om.index));
        if (before) out.push({ type: 'text', content: before, quotePreview: seg.quotePreview, recallAfterSend: false });
        pushLocationSegment(out, om[1] || '', char, seg.recallAfterSend);
        oLast = om.index + om[0].length;
      }
      const after = stripOrphanLocationTags(rest.slice(oLast));
      if (after) out.push({ type: 'text', content: after, recallAfterSend: any ? false : seg.recallAfterSend });
      else if (!any) {
        const cleaned = stripOrphanLocationTags(rest);
        if (cleaned) out.push({ type: 'text', content: cleaned, recallAfterSend: seg.recallAfterSend });
      }
    }
  }
  return out.length ? out : segments;
}

function buildLocationMessagePromptSection(char) {
  const worldName = String(char?.location_name || '').trim();
  const realRef = String(char?.real_location || '').trim();
  const homeAddr = String(char?.home_address || '').trim();
  const realHomeAddr = String(char?.real_home_address || '').trim();
  const cityLabel = worldName || realRef || '你所在的城市';
  const realMap = Number(char?.real_world_map) === 1;
  const realNames = Number(char?.real_place_names) !== 0;

  let refHint = '';
  let exampleTitle = worldName ? `${worldName}中央大街` : '梧桐路地铁口';
  let exampleSub = `${cityLabel}·步行街一侧`;

  if (realMap && realNames) {
    if (worldName && realRef && worldName !== realRef) {
      refHint = `你住的城对外叫「${worldName}」。发位置时城市名用这个；区、路、店、地标用官方真名（可按「${realRef}」真实路网），禁止魔都这类俗称。`;
      exampleTitle = '淮海中路地铁站';
      exampleSub = `${worldName}·黄浦区·淮海中路`;
    } else if (realRef) {
      refHint = `按现实地图写「${realRef}」的真实区名、路名、店名、地标，用官方真名，不要用俗称。`;
      exampleTitle = '淮海中路地铁站';
      exampleSub = `${realRef}·黄浦区·淮海中路`;
    } else if (worldName) {
      refHint = `城市对外叫「${worldName}」。区、路、店用官方真名。`;
    }
  } else if (realMap && !realNames) {
    if (worldName) {
      refHint = `城市对外只用「${worldName}」，禁止说现实城市真名${realRef ? `（心里按「${realRef}」路网）` : ''}；区、路、店、地标仍用官方真名。`;
      exampleTitle = `${worldName}·淮海中路`;
      exampleSub = '黄浦区·淮海中路地铁站口';
    } else if (realRef) {
      refHint = `按「${realRef}」真实路网写区/路/店真名，城市名若有化名对照则用化名。`;
    }
  } else if (worldName) {
    refHint = `你在「${worldName}」这一套地理里；不要突然改成现实城市名。`;
  }

  if (homeAddr) {
    const homePin = realHomeAddr && realHomeAddr !== homeAddr
      ? `说在家/回家发位置时标题或详细地址用「${homeAddr}」（系统会按现实住址定位）。`
      : `说在家/回家发位置时用住址「${homeAddr}」。`;
    refHint = `${refHint}${refHint ? ' ' : ''}${homePin}`.trim();
  }
  if (!refHint) {
    if (realMap && realNames) refHint = '按现实世界地图写具体位置；须细到路/路口/地标，用官方真名。';
    else if (realMap) refHint = '城市用【地理对照】里的化名，区、路、店、地标用官方真名。';
    else refHint = '写你此刻所在的具体位置；地名从世界书补，不要套现实城市。须细到路/路口/地标。';
  }

  return `【发位置】想让对方知道你在哪时，偶尔单独一行写：
[位置]短标题|详细地址[/位置]
· 短标题必须具体到街/路/巷/胡同（可加路口、门牌、店名），禁止只写「${cityLabel}」或某个区名。
· | 后面必须带路名：城市（化名或对外称呼）·区·路名。
· ${refHint}
正例：[位置]${exampleTitle}|${exampleSub}[/位置]
开闭标签成对。对方让你「到了再发定位 / 到家再发图」时，本轮只答应或说在路上，到了再另发一张；禁止本轮秒发。`;
}

/** 解析 [链接]主题|文案[/链接]；兼容分享、换行。假分享卡不存可外跳 URL */
function stripAccidentalLinkUrls(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s|｜<>"']+/gi, ' ')
    .replace(/[|｜]\s*[|｜]/g, '|')
    .replace(/^\s*[|｜]+|[|｜]+\s*$/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function serializeLinkContent(title, body) {
  const t = String(title || '').trim() || '链接';
  const b = String(body || '').trim();
  return b ? `${t}|${b}` : t;
}

function parseLinkPayload(raw) {
  let s = stripAccidentalLinkUrls(String(raw || '')
    .replace(/^\[?\s*(?:链接|分享)\s*[:：\]】］]?\s*/i, '')
    .replace(/\s*[\[【［]\s*\/\s*(?:链接|分享)\s*[\]】］]\s*$/i, '')
    .trim());
  let title = '';
  let body = '';
  const pipeIdx = [s.indexOf('|'), s.indexOf('｜')].filter((i) => i >= 0);
  if (pipeIdx.length) {
    const i = Math.min(...pipeIdx);
    title = s.slice(0, i).trim();
    body = s.slice(i + 1).trim();
  } else {
    const lines = s.split(/\n/).map((x) => x.trim()).filter(Boolean);
    title = lines[0] || '';
    body = lines.slice(1).join('\n').trim();
  }
  title = String(title || '').replace(/\s+/g, ' ').slice(0, 48);
  body = String(body || '').replace(/\r\n/g, '\n').slice(0, 400);
  if (!title) title = body ? body.slice(0, 24) : '链接';
  return { title, body };
}

function normalizeLinkMarkerText(text) {
  let t = String(text || '');
  t = t.replace(/［/g, '[').replace(/］/g, ']');
  t = t.replace(/【\s*(?:链接|分享)\s*[:：]\s*([^】]+)】/gi, (_, p) => `[链接]${String(p).trim()}[/链接]`);
  t = t.replace(/\[\s*(?:链接|分享)\s*[:：]\s*([^\]]+)\]/gi, (_, p) => `[链接]${String(p).trim()}[/链接]`);
  t = t.replace(/【\s*\/\s*(?:链接|分享)\s*】/gi, '[/链接]');
  t = t.replace(/【\s*(?:链接|分享)\s*】/gi, '[链接]');
  t = t.replace(/\[\s*\/\s*分享\s*\]/gi, '[/链接]');
  t = t.replace(/\[\s*分享\s*\]/gi, '[链接]');
  return t;
}

function stripOrphanLinkTags(text) {
  return String(text || '')
    .replace(/[\[【［]\s*\/\s*(?:链接|分享)\s*[\]】］]/gi, '')
    .replace(/[\[【［]\s*(?:链接|分享)\s*[\]】］]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pushLinkSegment(out, rawPayload, recallAfterSend) {
  const payload = String(rawPayload || '').trim();
  if (!payload) return;
  const { title, body } = parseLinkPayload(payload);
  const content = serializeLinkContent(title, body);
  out.push({
    type: 'link',
    content,
    title,
    body,
    quotePreview: undefined,
    recallAfterSend: !!recallAfterSend,
  });
}

function applyLinkMarkersToSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return segments || [];
  const out = [];
  const closedRe = /\[\s*链接\s*\]\s*([\s\S]*?)\s*\[\s*\/\s*链接\s*\]/gi;
  const openRe = /\[\s*链接\s*\]\s*([^\n\[]+)/gi;

  for (const seg of segments) {
    if (seg.type !== 'text') {
      out.push(seg);
      continue;
    }
    let text = normalizeLinkMarkerText(seg.content || '');
    if (!/\[\s*链接\s*\]/i.test(text) && !/\[\s*\/\s*链接\s*\]/i.test(text)) {
      out.push(seg.type === 'text' && text !== seg.content ? { ...seg, content: text } : seg);
      continue;
    }

    const pieces = [];
    let last = 0;
    let m;
    closedRe.lastIndex = 0;
    while ((m = closedRe.exec(text)) !== null) {
      const before = text.slice(last, m.index);
      if (before) pieces.push({ kind: 'text', text: before });
      pieces.push({ kind: 'link', payload: m[1] || '' });
      last = m.index + m[0].length;
    }
    if (last < text.length) pieces.push({ kind: 'text', text: text.slice(last) });
    if (!pieces.length) pieces.push({ kind: 'text', text });

    for (const piece of pieces) {
      if (piece.kind === 'link') {
        pushLinkSegment(out, piece.payload, seg.recallAfterSend);
        continue;
      }
      let rest = piece.text;
      if (!/\[\s*链接\s*\]/i.test(rest)) {
        rest = stripOrphanLinkTags(rest);
        if (rest) out.push({ type: 'text', content: rest, quotePreview: seg.quotePreview, recallAfterSend: seg.recallAfterSend });
        continue;
      }
      openRe.lastIndex = 0;
      let oLast = 0;
      let om;
      let any = false;
      while ((om = openRe.exec(rest)) !== null) {
        any = true;
        const before = stripOrphanLinkTags(rest.slice(oLast, om.index));
        if (before) out.push({ type: 'text', content: before, quotePreview: seg.quotePreview, recallAfterSend: false });
        pushLinkSegment(out, om[1] || '', seg.recallAfterSend);
        oLast = om.index + om[0].length;
      }
      const after = stripOrphanLinkTags(rest.slice(oLast));
      if (after) out.push({ type: 'text', content: after, recallAfterSend: any ? false : seg.recallAfterSend });
      else if (!any) {
        const cleaned = stripOrphanLinkTags(rest);
        if (cleaned) out.push({ type: 'text', content: cleaned, recallAfterSend: seg.recallAfterSend });
      }
    }
  }
  return out.length ? out : segments;
}

function buildLinkMessagePromptSection() {
  return `【分享链接】刷到想转给对方时单独一行（假分享卡，不是真网页）：
[链接]主题标题|一两句到一小段文案[/链接]
· 主题像标题；| 后面是摘要或金句。对方点开只在聊天里看这段文案，不会跳到外部网站。
· 不要写真实 URL（不要 https://、x.com、短链等）。标题+文案会进记录，你要记得自己分享过什么。
· 不要每条都发。
· 对方说「之后再发 / 到家再发」时本轮不要写链接卡，只答应。
正例：[链接]深夜食堂的灵魂是什么|不是菜有多复杂，是收工以后还能被人记得。[/链接]`;
}

const WEB_CARD_MAX_HTML = 32 * 1024;
const WEB_CARD_TAG = '(?:网页卡|前端卡)';

function looksLikeStandaloneHtml(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 16) return false;
  if (/^\s*<(!DOCTYPE\s+html\b|html\b|head\b|body\b)/i.test(t)) return true;
  const tags = t.match(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>/g) || [];
  if (tags.length < 2) return false;
  if (!/<(?:div|style|section|article|table|span|p|h[1-6]|img|svg|ul|ol|li|button|a)\b/i.test(t)) return false;
  return t.length >= 40 || /style\s*=/i.test(t) || /<\/(?:div|section|article|table|style)>/i.test(t);
}

function looksLikeWebCardPayload(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^[\[【［]\s*\/\s*(?:网页卡|前端卡)\s*[\]】］]$/i.test(t)) return false;
  if (/^(?:\[|【|［)\s*(?:网页卡|前端卡)\s*(?:[:：\]】］])/.test(t)) return true;
  if (t.startsWith('{') && /"html"\s*:/.test(t)) return true;
  return looksLikeStandaloneHtml(t);
}

function titleFromHtmlSnippet(html) {
  const s = String(html || '');
  const m = s.match(/<title[^>]*>([^<]{1,80})<\/title>/i)
    || s.match(/<(?:h1|h2|h3)[^>]*>([^<]{1,48})<\/(?:h1|h2|h3)>/i)
    || s.match(/<(?:strong|b)[^>]*>([^<]{1,48})<\/(?:strong|b)>/i);
  return m ? String(m[1] || '').replace(/\s+/g, ' ').trim().slice(0, 48) : '';
}

function serializeWebCardContent(title, html) {
  return JSON.stringify({
    title: String(title || '').trim() || '网页卡',
    html: String(html || ''),
  });
}

function parseWebCardPayload(raw) {
  const s = String(raw || '').trim();
  if (!s) return { title: '网页卡', html: '' };
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const title = String(j?.title || '').replace(/\s+/g, ' ').trim().slice(0, 48) || '网页卡';
      let html = String(j?.html || '');
      if (html.length > WEB_CARD_MAX_HTML) {
        console.warn('[web_card] html truncated', html.length);
        html = html.slice(0, WEB_CARD_MAX_HTML);
      }
      return { title, html };
    } catch { /* fall through */ }
  }
  let body = s
    .replace(new RegExp(`^\\[?\\s*${WEB_CARD_TAG}\\s*[:：\\]】］]?\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*[\\[【［]\\s*\\/\\s*${WEB_CARD_TAG}\\s*[\\]】］]\\s*$`, 'i'), '')
    .trim();
  // 裸 HTML（中转空回复卡片）：整段当 html
  if (looksLikeStandaloneHtml(body) || /^\s*</.test(body)) {
    let html = body;
    if (html.length > WEB_CARD_MAX_HTML) {
      console.warn('[web_card] html truncated', html.length);
      html = html.slice(0, WEB_CARD_MAX_HTML);
    }
    return { title: titleFromHtmlSnippet(html) || '提示', html };
  }
  let title = '';
  let html = '';
  const sep = body.match(/\r?\n---\r?\n/);
  if (sep) {
    const i = sep.index;
    title = body.slice(0, i).trim();
    html = body.slice(i + sep[0].length).trim();
  } else {
    const nl = body.indexOf('\n');
    if (nl >= 0) {
      title = body.slice(0, nl).trim();
      html = body.slice(nl + 1).trim();
    } else {
      title = body.trim();
      html = '';
    }
  }
  title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 48) || '网页卡';
  if (html.length > WEB_CARD_MAX_HTML) {
    console.warn('[web_card] html truncated', html.length);
    html = html.slice(0, WEB_CARD_MAX_HTML);
  }
  return { title, html };
}

function normalizeWebCardMarkerText(text) {
  let t = String(text || '');
  t = t.replace(/［/g, '[').replace(/］/g, ']');
  t = t.replace(/【\s*(?:网页卡|前端卡)\s*[:：]\s*([^】]+)】/gi, (_, p) => `[网页卡]${String(p).trim()}[/网页卡]`);
  t = t.replace(/【\s*\/\s*(?:网页卡|前端卡)\s*】/gi, '[/网页卡]');
  t = t.replace(/【\s*(?:网页卡|前端卡)\s*】/gi, '[网页卡]');
  t = t.replace(/\[\s*\/\s*前端卡\s*\]/gi, '[/网页卡]');
  t = t.replace(/\[\s*前端卡\s*\]/gi, '[网页卡]');
  return t;
}

function stripOrphanWebCardTags(text) {
  return String(text || '')
    .replace(/[\[【［]\s*\/\s*(?:网页卡|前端卡)\s*[\]】］]/gi, '')
    .replace(/[\[【［]\s*(?:网页卡|前端卡)\s*[\]】］]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pushWebCardSegment(out, rawPayload, recallAfterSend) {
  const payload = String(rawPayload || '').trim();
  if (!payload) return;
  const { title, html } = parseWebCardPayload(payload);
  if (!html) return;
  out.push({
    type: 'web_card',
    content: serializeWebCardContent(title, html),
    title,
    html,
    quotePreview: undefined,
    recallAfterSend: !!recallAfterSend,
  });
}

function applyWebCardMarkersToSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return segments || [];
  const out = [];
  const closedRe = /\[\s*网页卡\s*\]\s*([\s\S]*?)\s*\[\s*\/\s*网页卡\s*\]/gi;

  for (const seg of segments) {
    if (seg.type !== 'text') {
      out.push(seg);
      continue;
    }
    let text = normalizeWebCardMarkerText(seg.content || '');
    if (!/\[\s*网页卡\s*\]/i.test(text) && !/\[\s*\/\s*网页卡\s*\]/i.test(text)) {
      out.push(seg.type === 'text' && text !== seg.content ? { ...seg, content: text } : seg);
      continue;
    }

    let last = 0;
    let m;
    closedRe.lastIndex = 0;
    let any = false;
    while ((m = closedRe.exec(text)) !== null) {
      any = true;
      const before = stripOrphanWebCardTags(text.slice(last, m.index));
      if (before) out.push({ type: 'text', content: before, quotePreview: seg.quotePreview, recallAfterSend: false });
      pushWebCardSegment(out, m[1] || '', seg.recallAfterSend);
      last = m.index + m[0].length;
    }
    const after = stripOrphanWebCardTags(text.slice(last));
    if (after) out.push({ type: 'text', content: after, recallAfterSend: any ? false : seg.recallAfterSend });
    else if (!any) {
      const cleaned = stripOrphanWebCardTags(text);
      if (cleaned) out.push({ type: 'text', content: cleaned, recallAfterSend: seg.recallAfterSend });
    }
  }
  return out.length ? out : segments;
}

function buildWebCardPromptSection() {
  return `【网页卡】对方要你做小页面/前端样例/UI 草稿时，可单独发一张沙箱卡（对方点开在聊天里看，不是真外链）：
[网页卡]短标题
---
完整或片段 HTML（可含 style、内联 script）
[/网页卡]
· 标题一行；--- 后是 HTML，控制在较短篇幅（约一两屏）。
· 可用内联 CSS/JS；不要外链脚本、不要写真实可跳转 URL。
· 不要每条都发；只有对方明确要「页面/前端/小程序样例」时才用。
正例：
[网页卡]今日待办
---
<div style="font:14px/1.5 sans-serif;padding:8px"><b>待办</b><ul><li>买菜</li><li>回消息</li></ul></div>
[/网页卡]`;
}

/** 在最近消息里找引用片段对应的原始消息（用于关联 reply_to_id，找不到也不影响引用条显示） */
function findQuoteSourceId(characterId, isDream, quoteText) {
  if (!characterId || !quoteText) return null;
  const q = String(quoteText).trim();
  if (!q) return null;
  const rows = db.prepare(
    `SELECT id, content FROM messages WHERE character_id=? AND is_dream=? AND recalled=0 ORDER BY id DESC LIMIT 40`
  ).all(characterId, isDream ? 1 : 0);
  for (const r of rows) {
    const c = String(r.content || '').trim();
    if (!c) continue;
    if (c.includes(q) || q.includes(c)) return r.id;
  }
  return null;
}

/** 把引用预览挂到分段结果里第一条文字段上（多气泡时只有第一条带引用条） */
function attachQuotePreviewToSegments(segments, quotePreview) {
  if (!quotePreview || !segments?.length) return segments;
  const idx = segments.findIndex(s => s.type === 'text');
  const target = idx >= 0 ? idx : 0;
  return segments.map((s, i) => (i === target ? { ...s, quotePreview } : s));
}

/** 角色发表情包频率 0～100，默认 30（偶尔） */
function normalizeEmojiFreq(char) {
  const n = parseInt(char?.emoji_freq, 10);
  if (!Number.isFinite(n)) return 30;
  return Math.max(0, Math.min(100, n));
}

/** 本轮是否发表情：每条回复独立按滑块概率掷骰。0% 仅在对方刚发表情时可回一个。 */
const _emojiTurnWanted = new Map();

function shouldRequestEmojiThisTurn(char) {
  if (char?.emoji_enabled === 0 || char?.emoji_enabled === '0') return false;
  const freq = normalizeEmojiFreq(char);
  const id = char?.id;
  if (freq <= 0) return latestUserMessageIsEmoji(id);
  return Math.random() * 100 < freq;
}

function decideEmojiThisTurn(char) {
  const want = shouldRequestEmojiThisTurn(char);
  const id = char?.id;
  if (id) _emojiTurnWanted.set(Number(id), want);
  return want;
}

function consumeEmojiThisTurn(char) {
  const id = Number(char?.id || 0);
  if (id && _emojiTurnWanted.has(id)) {
    const v = _emojiTurnWanted.get(id);
    _emojiTurnWanted.delete(id);
    return v;
  }
  return shouldRequestEmojiThisTurn(char);
}

function emojiFreqPromptHint(freq, { thisTurn } = {}) {
  const f = Math.max(0, Math.min(100, Number(freq) || 0));
  if (thisTurn === false) {
    return '【发表情包·本轮】这轮不要写任何 [表情] 标记，只回文字。';
  }
  if (thisTurn === true) {
    return '【发表情包·本轮必须发】这轮请发恰好一个表情包：单独一行写 [表情]描述[/表情]，描述必须与下列库内某一条完全一致。正文照常说，但必须带这一个表情。';
  }
  if (f <= 0) {
    return '【发表情包频率】用户把频率设为几乎不发：默认纯文字，不要写任何 [表情] 标记。仅当用户刚发了表情、且你想礼貌回一个时，才可发一次。';
  }
  return `【发表情包频率】用户设定约 ${f}% 的回复带一个表情包。未点名「本轮必须发」时不要自己加。`;
}

function buildEmojiPromptSection(char) {
  if (char?.emoji_enabled === 0 || char?.emoji_enabled === '0') return '';
  const emojis = getAvailableEmojis(char);
  if (!emojis.length) return '';
  const list = emojis.map(e => `「${e.description}」`).join('、');
  const freq = normalizeEmojiFreq(char);
  const thisTurn = decideEmojiThisTurn(char);
  return `【表情包】你在「念」里可以发用户已上传的表情（含 GIF）。想发时单独一行写：[表情]描述[/表情] 或简写 [表情]描述，描述须与下列之一一致：${list}。
${emojiFreqPromptHint(freq, { thisTurn })}
写了标记就会真的发图。不要写 [表情包]、不要编造库里没有的描述；不要在标记后加「/详情」或其它路径/后缀。`;
}

/** 模型常把拍一拍部位单独写成气泡，这些不算聊天正文 */
const POKE_BODY_PARTS = new Set([
  '脑袋', '脑袋瓜', '头', '头顶', '脑门', '后脑勺',
  '肩膀', '肩', '脸颊', '脸', '脸蛋', '狗头',
  '发梢', '头发', '额头', '鼻子', '耳朵',
  '胳膊', '手臂', '手', '背', '腰', '屁股',
]);

function isBarePokeSuffix(text, extraSuffixes = []) {
  const t = String(text || '').trim().replace(/^的/, '');
  if (!t) return true;
  if (POKE_BODY_PARTS.has(t)) return true;
  for (const s of extraSuffixes) {
    const x = String(s || '').trim();
    if (x && t === x) return true;
  }
  return false;
}

/** 拍一拍：说明功能，并教角色用 [拍一拍] 回拍或主动拍 */
function buildPokePromptSection(settings) {
  const userSuffix = String(settings?.poke_user_suffix || '').trim().slice(0, 12) || '肩膀';
  return `【拍一拍】像微信戳一下，不只在主动跟句时才能用。
· 用户拍你：像被戳了那样短回，禁止说「你发了省略号/空白」；想回拍就另起一行写 [拍一拍]。
· 你想撩、逗、关心、唤一下对方时：也可主动另起一行写 [拍一拍]（后缀固定「${userSuffix}」），再接或不接一句短话都行。
偶尔用，不要每条都拍；不要把部位名单独写成气泡。`;
}

/** 从正文抽出 [拍一拍] 标记 */
function extractPokeDirective(text, extras = {}) {
  let wantPoke = false;
  let t = String(text || '').replace(/\[\s*拍一拍\s*(?:[:：][^\]]{0,20})?\s*\]/gi, () => {
    wantPoke = true;
    return '\n';
  });
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  if (wantPoke) {
    const extraList = [extras.charSuffix, extras.userSuffix].filter(Boolean);
    t = t.split('\n').filter((line) => !isBarePokeSuffix(line, extraList)).join('\n').trim();
    if (isBarePokeSuffix(t, extraList)) t = '';
  }
  return { text: t, wantPoke };
}

/** 从正文抽出 [打电话] / [视频电话] */
function extractCallDirective(text) {
  CALL_TAG_RE.lastIndex = 0;
  let wantCall = null;
  let t = String(text || '').replace(CALL_TAG_RE, (m) => {
    if (/视频/.test(m)) wantCall = 'video';
    else if (!wantCall) wantCall = 'voice';
    return '\n';
  });
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return { text: t, wantCall };
}

/** 用户这轮是在要角色打来电话，不是要语音条 */
function userRequestsPhoneCall(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/视频(?:电话|通话)|打(?:个)?视频|开视频聊|视频打过来|视频过来/i.test(t)) return 'video';
  if (
    /(?:打|来|拨)(?:个|一通|一个|一下)?(?:电话|语音电话)/i.test(t)
    || /语音电话|语音通话|通电话|来电吧|来个电话/i.test(t)
    || /打过来(?:吧|啊|呀)?|你打给我|打给我|打电话给|call\s*me/i.test(t)
    || /给我打(?:个|一通|一个|一下)?(?:电话|过来)|电话打过来|拨过来/i.test(t)
  ) {
    if (/发(?:个|一条|段)?语音|语音条/.test(t) && !/电话|通话/.test(t)) return null;
    return 'voice';
  }
  return null;
}

/** 明确说现在就拨：覆盖「晚上/晚点」类推迟 */
function messageSaysCallNow(text) {
  const t = String(text || '');
  return /(?:现在|马上|这就|立刻)(?:就)?(?:给(?:你|您))?(?:打|开|拨)|我现在打|马上打过来|这就打给|现在打给|现在开视频|马上视频/.test(t);
}

/**
 * 约在之后再打：今晚/晚上/晚点/明天… —— 此时不响铃。
 * 「晚上给我打视频」「晚点打给你」都属于推迟，不是现在拨。
 */
function messageDefersPhoneCall(text) {
  const t = String(text || '');
  if (!t) return false;
  if (messageSaysCallNow(t)) return false;
  if (/(?:今晚|今天晚上|今天夜里|夜里|半夜|晚点|等(?:会|会儿|一下|下)|待会|回头|改天|明天|后天|周末|下[次回]|到时候|有空再|忙完再|回家再|过会儿|过一会|先不(?:打|开|拨)?)/.test(t)) {
    return true;
  }
  // 裸「晚上」挨着电话/视频意图
  if (/晚上.{0,12}(?:打|开|拨|视频|电话)|(?:打|开|拨|视频|电话).{0,12}晚上/.test(t)) {
    return true;
  }
  return false;
}

/** 角色在让用户打过来，不是自己拨出 —— 不应弹角色来电 */
function replyAsksUserToCall(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/我(?:现在|马上|这就)?(?:给(?:你|您))?打/.test(t)) return false;
  return /(?:你|您)(?:晚上|今晚|晚点|回头|明天|改天)?(?:再)?(?:给(?:我|俺)|来)?打|(?:晚上|今晚|晚点)?给我打(?:个|一通|一个)?(?:视频|电话)|打给我(?:吧|啊|呀)?|(?:你|您)打过来|打过来给我|(?:你|您)拨过来/.test(t);
}

function replyRefusesPhoneCall(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/(?:还是|那就|我还是|我这就|马上|现在就).{0,8}打/.test(t)) return false;
  return /不想打|不能打|不方便打|先不打|等(?:会|会儿|一下|下)打|改天打|现在忙|打不了|不用打|不要打|别打(?:电话)?/.test(t);
}

function inferCallFromReply(text) {
  const t = String(text || '');
  if (!t) return null;
  // 商量、推迟、征求意见、让对方打：还没真拨，不响铃
  if (messageDefersPhoneCall(t)) return null;
  if (replyAsksUserToCall(t)) return null;
  if (/要不要|要我打|好不好打|打不打|方不方便打|方便吗|方便不/.test(t)) return null;
  // 视频：角色自己开/打过来（不要把「给我打视频」当成自己拨）
  if (
    /我(?:现在|马上|这就)?(?:给(?:你|您))?(?:打|开|拨)(?:个|一通|一个)?视频|视频(?:电话|通话)打过来|开个视频聊|打个视频给(?:你|您)|视频打过来了/.test(t)
    || (/(?:想见你|想看看你|看看你(?:的)?脸|看你一眼)/.test(t) && /我.{0,6}(?:视频|打过来|打给你)/.test(t))
  ) {
    return 'video';
  }
  // 角色主动说打过来 / 想实时听声音并要打电话
  if (
    /我(?:现在|马上|这就)?(?:给(?:你|您))?打(?:个|一通)?(?:电话|过来)/.test(t)
    || /电话打[给过]去了|我打过来了|拨给你了|打给你听|打过来聊|通个电话|开个语音聊/.test(t)
    || (/(?:想听|听听)(?:你|您)?(?:的)?声音|想听你说话|听听你说话/.test(t)
      && /我.{0,8}打(?:个|一通)?电话|我.{0,6}打过来|拨过去/.test(t))
  ) {
    return 'voice';
  }
  return null;
}

/** 标记、用户点名、或角色自己说打过来 → 真正响铃 */
function resolveChatIncomingCall({ tagged, rawText, processedText, userMessage, voiceCallMode, isDream } = {}) {
  if (voiceCallMode || isDream) return null;
  const reply = processedText || rawText || '';
  const userMsg = String(userMessage || '');
  // 约好晚上/晚点再打：无论有没有标记，本轮都不响铃（标记仍会从正文里剥掉）
  if (messageDefersPhoneCall(reply) || messageDefersPhoneCall(userMsg)) return null;
  // 角色在喊你打过来，不是自己拨
  if (replyAsksUserToCall(reply)) return null;

  const fromTag = tagged
    || extractCallDirective(rawText).wantCall
    || extractCallDirective(processedText).wantCall;
  if (fromTag === 'video' || fromTag === 'voice') return fromTag;

  const userAsked = userRequestsPhoneCall(userMessage);
  if (userAsked === 'video' || userAsked === 'voice') {
    if (replyRefusesPhoneCall(reply)) return null;
    // 用户点名要打：没写标记时，须明确「现在就打」且像真在拨才响铃（口头「好啊」不够）
    if (messageSaysCallNow(reply) && inferCallFromReply(reply) === userAsked) return userAsked;
    return null;
  }
  return inferCallFromReply(reply);
}

/**
 * 教角色分清语音条 vs 电话/视频，并会主动拨过来。
 * 常驻进聊天提示，不要只在用户点名时才出现。
 */
function buildCallDirectivePromptSection({ userAsked } = {}) {
  const asked = userAsked === 'video'
    ? '用户这轮要你打视频：若是现在就打，答应就另起一行写 [视频电话]；若约晚上/晚点/明天再打，只口头答应，禁止写标记；不想打就直接拒绝，不要假装已拨出。'
    : userAsked === 'voice'
      ? '用户这轮要你打电话：若是现在就打，答应就另起一行写 [打电话]（想看脸就写 [视频电话]）；若约晚上/晚点再打，只口头答应，禁止写标记；不想打就直接拒绝。'
      : '';
  return `【电话 / 视频】这是真功能，不是口头说说。
· 语音条：单向短录音，发完就结束——适合随口一句。
· 打电话：实时通上说话。想听对方声音、想连着聊、嫌打字慢 → 另起一行写 [打电话]。
· 视频电话：还想看见脸、想见见对方 → 另起一行写 [视频电话]（不要只说「想看你」却不拨）。
只有「现在这一刻真要拨出去」才写标记（用户看不见这行）。可先说「我打给你 / 打个视频」再写标记。
约晚上、今晚、晚点、明天、改天、回头再打：只把约定说清楚，禁止写 [打电话]/[视频电话]，系统见标记会立刻响铃。
让对方打给你（「你打给我 / 晚上给我打视频」）：不要写标记，等对方来拨。
想听对方声音：优先自己打电话，不要只让对方发语音条。想看脸：用视频，不要只让对方发自拍凑合。按性格来，不是每条都打；不想打可以说现在不方便。
· 通话中你真的想挂掉这通电话：另起一行写 [挂断]（或 [end_call]，可以 [挂断:困了] 加一句原因）。不要光嘴上说「我挂了」用户那头不会真的挂掉。
挂断前那句是收尾（「先这样」「我先挂了」），不是重新接通。禁止「喂」「能听见吗」「听得到吗」。[挂断] 之后若再写一句，是回到微信的文字，不是语音条，也不是对着电话说话。
${asked}`.trim();
}

/**
 * 小剧场：文字扮演；承接「想见面接在一起」的幻想。
 * 常驻进普通聊天提示，让角色知道可以主动邀。
 */
function buildTheaterInvitePromptSection() {
  return `【小剧场】文字扮演是真功能：虚构场景里可以同处、约会、挨在一起，出戏后不当真。
想挨在一起（含想念、亲近又人到不了时）：按性格口头邀一句一起演，另起一行写 [开启小剧场]（用户看不见这行）。系统见标记会真的开场。
不要每轮都邀；对方不想、正忙、或气氛不对就别提。已在小剧场里时不要再写这个标记。
口头不要说「那你过来／等我回去找你」代替开场；扮演里的同处也不是通讯里的真事。`.trim();
}

/** 角色拍用户：写入系统提示行 */
function insertCharacterPokeMessage(characterId, char, settings, { isDream = false } = {}) {
  const userName = String(settings?.username || '旅人').trim() || '旅人';
  const suffix = String(settings?.poke_user_suffix || '').trim().slice(0, 12) || '肩膀';
  const pokeText = `${char.name} 拍了拍 ${userName} 的${suffix}`;
  const now = new Date().toISOString();
  const id = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
  ).run(characterId, 'system', pokeText, 'system', now, isDream ? 1 : 0).lastInsertRowid;
  try {
    db.prepare(`UPDATE characters SET poke_user_suffix=? WHERE id=?`).run(suffix, characterId);
  } catch {}
  return {
    id,
    role: 'system',
    type: 'system',
    content: pokeText,
    timestamp: now,
  };
}

/** 撤回：让 AI 可以对自己刚发的话"后悔"并收回（上一轮的话，或这一轮刚说出口的话都可以） */
function buildRecallPromptSection() {
  return `【撤回】说漏嘴/说错才用，不要表演撤回。
撤上一轮：回复开头单独一行 [撤回上一条]，再写下句。
刚说完改口：那句后面写 [撤回] 再接改口。例：是周四。[撤回]等等，是周五。`;
}

/** 引用回复：让 AI 能明确指向用户之前某一句话来回应或追问 */
function buildQuoteReplyPromptSection() {
  return `【引用】想点名对方之前某句（调侃、纠正、追问、翻旧账、接住没回完的话）时，回复开头写：[引用]原句照抄[/引用]再接你的话。原句尽量照抄最近聊天里的原文。一条只用一次；顺着刚说的上一句接话不必引用。`;
}

function latestUserMessageIsEmoji(characterId) {
  if (!characterId) return false;
  const row = db.prepare(
    `SELECT type FROM messages WHERE character_id=? AND role='user' AND COALESCE(is_dream,0)=0 ORDER BY id DESC LIMIT 1`
  ).get(characterId);
  return row?.type === 'emoji';
}

const EMOJI_MARK_PATTERNS = [
  /\[表情\]([\s\S]*?)\[\/表情\]/g,
  /\[表情\]([^\]\n]+)\]/g,
  /\[表情\]([^\]\n\/]+)(?!\])/g,
  /【表情】([\s\S]*?)【\/表情】/g,
  /\[表情包\][「『"'【\[]*([^」』"'】\]\n]+)[」』"'】\]]?/g,
  /【表情包】[「『"'【\[]*([^」』"'】\]\n]+)[」』"'】\]]?/g,
  /\[发送表情包：([^\]\n]+)\]/g,
];

function stripEmojiMarksFromText(text) {
  let t = String(text || '');
  for (const re of EMOJI_MARK_PATTERNS) {
    t = t.replace(new RegExp(re.source, re.flags), '');
  }
  t = t.replace(/\[发送表情包\]/g, '');
  t = t.replace(/\s*(?:\/\s*详情|\[\s*\/?\s*详情\s*\])/gu, '');
  return stripModelLeakage(t).replace(/\n{3,}/g, '\n\n').trim();
}

function finalizeEmojiSegments(segments) {
  const emojiDescs = new Set(
    segments
      .filter(s => s.type === 'emoji')
      .map(s => normalizeEmojiDesc(s.description))
      .filter(Boolean)
  );
  const out = [];
  for (const seg of segments) {
    if (seg.type === 'emoji') {
      out.push(seg);
      continue;
    }
    const cleaned = stripEmojiMarksFromText(seg.content);
    if (!cleaned) continue;
    if (emojiDescs.has(normalizeEmojiDesc(cleaned))) continue;
    out.push({ ...seg, content: cleaned });
  }
  return out.length ? out : segments;
}

/** 表情标记后模型常残留的「/详情」等，并入匹配长度以免漏进气泡 */
function emojiMatchTrailingJunkLen(text, index, len) {
  const rest = String(text || '').slice(index + len);
  const m = rest.match(/^\s*(?:\/\s*详情|\[\s*\/?\s*详情\s*\]|\/\s*表情\s*\]|\[\s*\/\s*表情\s*\])/u);
  return m ? m[0].length : 0;
}

function collectEmojiMarkMatches(text) {
  const matches = [];
  for (const re of EMOJI_MARK_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      let len = match[0].length;
      len += emojiMatchTrailingJunkLen(text, match.index, len);
      matches.push({ index: match.index, len, desc: match[1] });
    }
  }
  matches.sort((a, b) => a.index - b.index || b.len - a.len);
  const out = [];
  let end = 0;
  for (const m of matches) {
    if (m.index < end) continue;
    out.push(m);
    end = m.index + m.len;
  }
  return out;
}

/** 把一段（已去掉撤回/引用标记的）文字解析成表情+文字混合的分段，不处理撤回/引用 */
function buildEmojiSegmentsForText(text, char) {
  if (!text) return { segments: [], textContent: '' };

  const wantEmoji = consumeEmojiThisTurn(char);
  const emojis = getAvailableEmojis(char);
  const hasEmojiMark = EMOJI_MARK_PATTERNS.some(re => {
    re.lastIndex = 0;
    return re.test(text);
  });
  if (!emojis.length || !hasEmojiMark) {
    const cleaned = hasEmojiMark ? stripEmojiMarksFromText(text) : stripModelLeakage(text);
    return {
      segments: cleaned ? [{ type: 'text', content: cleaned }] : [],
      textContent: cleaned,
    };
  }

  if (!wantEmoji) {
    const stripped = stripEmojiMarksFromText(text);
    console.log('[emoji] suppressed (not this turn)', char?.id, '→ text only');
    return { segments: stripped ? [{ type: 'text', content: stripped }] : [], textContent: stripped };
  }

  const segments = [];
  const matches = collectEmojiMarkMatches(text);

  let lastIndex = 0;
  const seen = new Set();
  let emojiUsed = 0;
  for (const m of matches) {
    if (seen.has(m.index) || m.index < lastIndex) continue;
    seen.add(m.index);
    const before = text.slice(lastIndex, m.index).trim();
    if (before) segments.push({ type: 'text', content: before });
    const found = findEmojiByDescription(m.desc, emojis);
    if (found && emojiUsed < 1) {
      segments.push({ type: 'emoji', content: found.url, description: found.description });
      emojiUsed++;
    }
    lastIndex = m.index + m.len;
  }
  const after = text.slice(lastIndex).trim();
  if (after) segments.push({ type: 'text', content: after });

  if (!segments.length) {
    const stripped = stripEmojiMarksFromText(text);
    return { segments: stripped ? [{ type: 'text', content: stripped }] : [], textContent: stripped };
  }

  const finalized = finalizeEmojiSegments(segments);
  const textContent = finalized.filter(s => s.type === 'text').map(s => s.content).join('\n').trim();
  return { segments: finalized, textContent: textContent || text };
}

function processAiContentWithEmojis(aiContent, char, options = {}) {
  let text = String(aiContent || '').trim();
  if (!text) return { segments: [], textContent: '', wantPoke: false, wantCall: null };
  // 中转空回复的裸 HTML 卡：聊天和通话都收成网页卡，避免听筒把 HTML/报错页念出来
  if (looksLikeStandaloneHtml(text) && !/\[\s*(?:网页卡|前端卡)\s*\]/i.test(text)) {
    const cardSegs = [];
    pushWebCardSegment(cardSegs, text, false);
    if (cardSegs.length) {
      return { segments: cardSegs, textContent: '', wantPoke: false, wantCall: null };
    }
  }
  // 挂断标记会在后面被剥掉，先切开：标记后的句子要当微信文字，不要和听筒开场粘成一条语音
  let hangupParts = null;
  if (options.voiceCallMode) {
    const hung = splitEndCallSpeech(text);
    if (hung.wantEnd) hangupParts = hung;
  }
  // 先剥思考链泄漏和心智原文，再只剥 [文字]/[语音]，保留 [引用]/[撤回]/[拍一拍]/[打电话] 供后面解析
  text = stripMindsetEcho(stripHistoryMediaLabels(stripModelLeakage(text)), char?.mindset);
  if (!text) return { segments: [], textContent: '', wantPoke: false, wantCall: null };
  const pokeHit = extractPokeDirective(text, {
    charSuffix: char?.poke_char_suffix,
    userSuffix: char?.poke_user_suffix,
  });
  text = pokeHit.text;
  const wantPoke = !!pokeHit.wantPoke && !options.voiceCallMode && !options.isDream;
  const callHit = extractCallDirective(text);
  text = callHit.text;
  const wantCall = (!options.voiceCallMode && !options.isDream) ? callHit.wantCall : null;
  if (isBarePokeSuffix(text, [char?.poke_char_suffix, char?.poke_user_suffix])) {
    text = '';
  }
  // 小黄豆：梦境/通话不用；其它场景按语气×人设校验
  if (options.isDream || options.voiceCallMode) {
    text = sanitizeInlineBeans(text, { forceStrip: true });
  } else {
    text = sanitizeInlineBeans(text, { characterId: options.characterId, char });
  }

  // 撤上一轮：整段最开头就是撤回标记，先执行撤回再处理剩余内容
  // 通话模式下这两个标记本不会被提示词提及，但仍在此处兜底剥离，避免万一模型误写出来被朗读/显示成正文
  let recalledMsg = null;
  if (options.characterId) {
    const rec = extractRecallDirective(text);
    if (rec.recall) {
      recalledMsg = recallLastAiMessage(options.characterId, options.isDream);
      text = stripHistoryMediaLabels(rec.text.trim());
    }
  }

  // 引用回复：AI 在开头写了 [引用]用户原话[/引用]，剥离标记，记下引用内容挂到第一条气泡（通话模式不挂引用条，只剥标记）
  let quotePreview = null;
  if (text) {
    const q = extractQuoteMarker(text);
    if (q) {
      if (!options.voiceCallMode) quotePreview = String(q.quote || '').slice(0, 100);
      // [语气:xx] 留到入库那一步才剥：中途剥掉就没人知道这句该用什么语气念了
      // [撤回] 留到下面同轮切段，这里不能先删
      text = stripAiContextLabels(q.text.trim(), { keepToneTag: true, keepRecallTags: true });
    } else {
      // 未识别成正式引用时，仍清掉正文里漏网的指令标签（位置开闭标签会保留）
      text = stripAiContextLabels(text, { keepToneTag: true, keepRecallTags: true });
    }
  }
  if (text && !options.isDream && char?.language_style) {
    text = stripCopiedLanguageExamples(text, char.language_style);
  }

  // 定位/链接标记尽量在拆句/表情之前解析，避免开闭标签被拆到不同气泡
  if (text && !options.voiceCallMode) {
    let early = applyLocationMarkersToSegments([{ type: 'text', content: text }], char);
    early = applyLinkMarkersToSegments(early);
    early = applyWebCardMarkersToSegments(early);
    const specials = early.filter((s) => s.type === 'location' || s.type === 'link' || s.type === 'web_card');
    if (specials.length) {
      const textBits = early.filter((s) => s.type === 'text').map((s) => s.content).filter(Boolean);
      text = textBits.join('\n').trim();
      options._earlyCardSegs = specials;
      if (!text) {
        const attached = attachQuotePreviewToSegments(specials, quotePreview);
        return {
          segments: attached,
          textContent: '',
          recalledMsg,
          quotePreview,
          wantPoke,
          wantCall,
        };
      }
    }
  }

  if (!text) return { segments: [], textContent: '', recalledMsg, quotePreview, wantPoke, wantCall };

  if (options.voiceCallMode) {
    // 通话模式不做"同轮撤回"动画，把行内标记直接剥掉即可
    text = stripInlineRecallMarkers(text);
    if (looksLikeStandaloneHtml(text) || looksLikeWebCardPayload(text)) {
      const cardSegs = [];
      pushWebCardSegment(cardSegs, text, false);
      if (cardSegs.length) {
        return { segments: cardSegs, textContent: '', recalledMsg, quotePreview, wantPoke: false, wantCall: null };
      }
    }
    if (/^\s*\[安静\]\s*$/.test(text) || /^\s*（安静）\s*$/.test(text)) {
      return { segments: [], textContent: '', recalledMsg, quotePreview, wantPoke: false, wantCall: null };
    }
    const hungUp = hangupParts;
    if (hungUp?.wantEnd) {
      // 挂断这一轮回到聊天：文字气泡。纯「喂——能听见吗」丢掉，不当成挂完后的消息。
      const pieces = [hungUp.before, hungUp.after]
        .map((s) => dropTruncatedSpeech(stripLeadingPhonePickup(stripAiContextLabels(s, { keepToneTag: true }))))
        .filter((s) => s && !isOnlyPhonePickup(s));
      const segments = pieces.map((content) => ({ type: 'text', content, chatAfterHangup: true }));
      const textContent = pieces.map((s) => stripAiContextLabels(s)).filter(Boolean).join('\n');
      return { segments, textContent, recalledMsg, quotePreview, wantPoke: false, wantCall: null };
    }
    text = dropTruncatedSpeech(text);
    if (!text) {
      return { segments: [], textContent: '', recalledMsg, quotePreview, wantPoke: false, wantCall: null };
    }
    // segments 带着 [语气:xx] 往下走，textContent 是给记忆/通知看的，必须干净
    return { segments: [{ type: 'text', content: text }], textContent: stripAiContextLabels(text), recalledMsg, quotePreview, wantPoke: false, wantCall: null };
  }

  // 撤这一轮：文本中间还写了 [撤回]，把它切成若干段，标记出"发出去后要立刻撤回"的那一段
  const chunks = splitByInlineRecallMarkers(text);
  let segments = [];
  for (const chunk of chunks) {
    const chunkText = chunk.text.trim();
    if (!chunkText) continue;
    const { segments: chunkSegments } = buildEmojiSegmentsForText(chunkText, char);
    if (!chunkSegments.length) continue;
    if (chunk.recallAfter) {
      const lastIdx = chunkSegments.length - 1;
      chunkSegments[lastIdx] = { ...chunkSegments[lastIdx], recallAfterSend: true };
    }
    segments.push(...chunkSegments);
  }

  if (!segments.length) return { segments: [], textContent: '', recalledMsg, quotePreview, wantPoke, wantCall };

  segments = applyLocationMarkersToSegments(segments, char);
  segments = applyLinkMarkersToSegments(segments);
  segments = applyWebCardMarkersToSegments(segments);
  if (options._earlyCardSegs?.length) {
    // 早先抽出的定位/链接/网页卡插到文段之后：先说话再发卡
    segments = [...segments, ...options._earlyCardSegs];
  }
  // 再清一次残留闭标签气泡
  segments = segments.filter((s) => !(s.type === 'text' && isDirectiveOnlyText(s.content)));
  segments = attachQuotePreviewToSegments(segments, quotePreview);
  const textContent = segments.filter(s => s.type === 'text').map(s => s.content).join('\n').trim();
  return { segments, textContent: stripAiContextLabels(textContent || text), recalledMsg, quotePreview, wantPoke, wantCall };
}

const CJK_CHAR = /[\u3400-\u9fff]/;
const SENTENCE_END_CHARS = '。．！？!?；;';
const CLOSING_QUOTE_CHARS = '」』"”’）)】';
const DISCOURSE_AFTER_COMMA = /^(那|对了|还有|不过|而且|然后|所以|但是|可是|只是|其实|反正|另外|总之|不然|否则|至于|话说|好啊|好的|好吧|行吧|行啊|嗯|哦|哎|唉|对啊|对吧)/u;

function stripTrailingChatPunct(s) {
  return String(s || '').trim().replace(/[。．！？!?…⋯～~、,，；;]+$/u, '').trim();
}

function visibleLen(s) {
  return String(s || '').replace(/\s+/g, '').length;
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

function looksLikeOwnUtterance(s) {
  const t = stripTrailingChatPunct(s);
  if (!t) return false;
  if (DISCOURSE_AFTER_COMMA.test(t)) return true;
  if (/^(好|行|嗯|哦|唉|哎|哈)([啊呀啦哦嘛]?)$/u.test(t) && visibleLen(t) <= 3) return true;
  return /^[你您]/.test(t) && /[吗吧呢]$/u.test(t) && visibleLen(t) <= 12;
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

/** 拆完后去掉句末「。」，文字气泡不显示句号（问号/感叹号/省略号保留） */
function stripDisplayPeriod(text) {
  if (!text) return '';
  return String(text)
    .replace(/[。．]([」』"”’）)】]+)$/u, '$1')
    .replace(/\.([」』"”’）)】]+)$/u, dropBareDotBeforeClosers)
    .replace(/[；;，,]+$/u, '')
    .replace(/[。．]+$/u, '')
    .replace(/\.$/u, dropBareTrailingDot)
    .trim();
}

function keepVoicePeriod(text) {
  const t = String(text || '').trim();
  if (!t || isPeriodOnlyText(t) || isBareMediaLabel(t)) return '';
  if (/^[♪🎵]/.test(t)) return t;
  if (/[。．！？…!?～~]$/u.test(t)) return t;
  return `${t}。`;
}

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

/** 仅去掉历史标签，不动引用/撤回（供解析指令前使用） */
function stripHistoryMediaLabels(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[\[【［]\s*(?:文字|语音|语音条|语音消息)\s*[\]】］]\s*/g, '')
    .replace(/^[（(]\s*语音(?:条|消息)?\s*[)）]\s*/gm, '')
    .replace(/^(?:语音条|语音消息|语音)\s*[:：]\s*/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 去掉 AI 从历史里学来的 [文字]/[语音] 标记，并兜底清掉残留的引用/撤回指令标签 */
function stripAiContextLabels(text, opts = {}) {
  if (!text) return '';
  return stripResidualDirectiveTags(stripHistoryMediaLabels(stripModelLeakage(text)), opts);
}

function splitAiSegments(text, opts = {}) {
  if (!text) return [text];
  const keepPeriod = !!opts.keepPeriod;
  const original = String(text).trim();
  if (looksLikeWebCardPayload(original)) return [original];
  const cleaned = stripAiContextLabels(text, { keepToneTag: !!opts.keepToneTag });
  if (!cleaned) {
    const orig = String(text).trim();
    if (!orig || isDirectiveOnlyText(orig) || isBareMediaLabel(orig)) return [];
    return [orig];
  }
  if (looksLikeWebCardPayload(cleaned)) return [cleaned];

  const blocks = cleaned.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const sources = blocks.length > 1 ? blocks : [cleaned];
  const result = [];
  for (const block of sources) {
    // 换行也视为分段，避免「句号去掉后两句粘在一行」
    const lines = block.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const units = lines.length > 1 ? lines : [block.replace(/\n+/g, ' ').trim()];
    for (const unit of units) {
      result.push(...splitIntoSentenceGroups(unit, keepPeriod));
    }
  }
  const merged = mergeLoneBeanSegments(result).filter((p) => {
    const s = String(p || '').trim();
    return s && !isBareMediaLabel(s) && !isDirectiveOnlyText(s) && !looksTruncatedUtterance(s);
  });
  if (merged.length) return merged;
  if (isBareMediaLabel(cleaned) || isDirectiveOnlyText(cleaned)) return [];
  if (keepPeriod) return [cleaned];
  return [stripDisplayPeriod(cleaned) || cleaned];
}

/** 把长文本段再拆成短句，便于多气泡 / 多语音条（保留图/视频/语音/表情段） */
function expandSegmentsForBubbles(segments) {
  const out = [];
  for (const seg of segments) {
    if (seg.type === 'emoji' || seg.type === 'image' || seg.type === 'video' || seg.type === 'voice' || seg.type === 'location' || seg.type === 'link' || seg.type === 'web_card') {
      out.push(seg);
      continue;
    }
    const parts = splitAiSegments(seg.content, { keepPeriod: true, keepToneTag: true });
    const bubbles = [];
    for (const p of parts) {
      const content = stripAiContextLabels(p, { keepToneTag: true });
      if (!content || isDirectiveOnlyText(content)) continue;
      // 纯小黄豆并入上一条文字气泡，不单独占一条
      if (isBeanOnlySegment(content) && bubbles.length) {
        bubbles[bubbles.length - 1].content = `${bubbles[bubbles.length - 1].content}${content}`;
        continue;
      }
      bubbles.push({ type: 'text', content });
    }
    if (bubbles.length >= 2 && isBeanOnlySegment(bubbles[0].content)) {
      bubbles[1].content = `${bubbles[0].content}${bubbles[1].content}`;
      if (bubbles[0].quotePreview && !bubbles[1].quotePreview) {
        bubbles[1].quotePreview = bubbles[0].quotePreview;
      }
      bubbles.shift();
    }
    if (bubbles.length) {
      // 引用条只挂在这个原始段拆出来的第一条气泡上；撤回只挂在最后一条（真正"发出去"的那句）
      if (seg.quotePreview) bubbles[0].quotePreview = seg.quotePreview;
      if (seg.recallAfterSend) bubbles[bubbles.length - 1].recallAfterSend = true;
    }
    out.push(...bubbles);
  }
  return out.length ? out : segments;
}

/** 用户要的是聊天语音条（非语音通话） */
function userRequestsVoiceMessage(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/语音通话|语音电话|打(?:个)?电话|通电话|facetime|Facetime|开语音聊/i.test(t)) return false;
  return /(?:发|来|录)(?:个|一条|段)?语音|语音(?:条|消息)|用语音(?:发|说|回|聊)|给我发语音|发我语音|想听(?:你|您)?(?:的)?声音|听听(?:你|您)(?:的)?声音|语音回复/i.test(t);
}

function buildVoiceMessagePromptSection(char) {
  if (Number(char?.voice_messages) !== 1) return '';
  if (!String(char?.voice_id || '').trim()) return '';
  return `【语音条】照常按【语言风格】写要说的话；可能整轮是文字或语音条。不要写「语音」「（语音）」「[语音]」「这是语音」当正文。不要写 (laughs)(sighs)、emmm；玩笑骂人时句首写 [语气:调侃]（用户看不见）。
语音条≠电话：想实时听对方、连着聊，用【电话 / 视频】自己打过去，不要只让对方发语音条。`;
}

function pickVoiceSegmentIndices(segments, char, isDreamMode, options = {}) {
  if (options.voiceCallMode || options.theater) return new Set();
  // 刚挂完电话：这一轮用文字，不要随机抽成语音条（用户点名要语音仍给）
  if (options.justLeftCall && !options.userRequestedVoice) return new Set();
  if (isDreamMode || Number(char?.voice_messages) !== 1) return new Set();
  if (!(String(char?.voice_id || '').trim())) return new Set();
  const skipVoiceTypes = new Set(['emoji', 'image', 'video', 'voice', 'location', 'link', 'web_card']);
  const textIndices = segments
    .map((s, i) => (!skipVoiceTypes.has(s.type) && String(s.content || '').trim() ? i : -1))
    .filter(i => i >= 0);
  if (!textIndices.length) return new Set();
  // 用户明确要语音：本轮文字全部改成语音条
  if (options.userRequestedVoice) return new Set(textIndices);
  // 概率触发：触发则本轮全部语音，不触发则全是文字（不再随机抽 1～2 条）
  const isBusy = char.status === 'busy';
  const triggerChance = isBusy ? 0.4 : 0.18;
  if (Math.random() > triggerChance) return new Set();
  return new Set(textIndices);
}

/** 去掉连发的重复句/近义复读（模型常见） */
function collapseRepeatedProse(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return t;
  const parts = t
    .split(/(?<=[。！？…!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    const m = t.match(/^(.{6,80}?)(?:\s*[，,、；;]?\s*\1)+$/);
    if (m) return m[1].trim();
    return t;
  }
  const norm = (s) => String(s || '')
    .replace(/\s+/g, '')
    .replace(/[。！？…!?，,、；;：:~\-—…]+$/g, '')
    .toLowerCase();
  const out = [];
  let prev = '';
  for (const p of parts) {
    const n = norm(p);
    if (!n) continue;
    if (n === prev) continue;
    if (prev && (n.includes(prev) || prev.includes(n)) && Math.abs(n.length - prev.length) <= 6) continue;
    if (out.some((x) => norm(x) === n)) continue;
    out.push(p);
    prev = n;
  }
  if (!out.length) return t;
  return out.map((s) => (/[。！？…!?]$/.test(s) ? s : `${s}`)).join(out.length > 1 && out.every((s) => /[。！？…!?]$/.test(s)) ? '' : '\n');
}

const _styleExampleCache = new Map();

function compactSpeechForStyle(s) {
  return String(s || '')
    .replace(/[\[【［][^\]】］]{0,48}[\]】］]/g, '')
    .replace(/[（(][^）)]{0,40}[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/[。！？…!?，,、；;：:~\-—…「」""''·・]/g, '')
    .toLowerCase();
}

function looksLikeStyleInstruction(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (/^#{1,3}\s/.test(s)) return true;
  if (/^(重要|注意|禁止|不要|参考|只在|承认|用词|日常|语言|说话方式|反例|风格|原则)/.test(s)) return true;
  if (/^用.{0,10}[:：]/.test(s)) return true;
  if (/(语感|例句|示例|口头禅|标点习惯|句长|修辞密度)/.test(s) && !/[。！？!?]$/.test(s)) return true;
  return false;
}

/** 从【语言风格】里抽出可被模型当台词照搬的例句 */
function extractLanguageStyleExamples(style) {
  const raw = String(style || '').trim();
  if (raw.length < 24) return [];
  const cached = _styleExampleCache.get(raw);
  if (cached) return cached;
  const examples = [];
  const seen = new Set();
  const add = (s) => {
    let t = String(s || '').trim()
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[.、]\s+/, '')
      .replace(/^["「『“]+|["」』”]+$/g, '')
      .trim();
    if (!t || looksLikeStyleInstruction(t)) return;
    const compact = compactSpeechForStyle(t);
    if (compact.length < 6) return;
    const looksUtterance = /[。！？…!?]$/.test(t) || compact.length >= 10;
    if (!looksUtterance) return;
    if (seen.has(compact)) return;
    seen.add(compact);
    examples.push(t);
  };
  for (const m of raw.matchAll(/[「『""]([^」』""\n]{6,80})[」』""]/g)) add(m[1]);
  for (const line of raw.split(/\n+/)) {
    const t = line.trim();
    if (/^[-*•]\s+\S/.test(t) || /^\d+[.、]\s+\S/.test(t)) add(t);
  }
  if (_styleExampleCache.size > 80) _styleExampleCache.clear();
  _styleExampleCache.set(raw, examples);
  return examples;
}

function sentenceCopiesLanguageExample(sentence, examples) {
  const raw = String(sentence || '');
  if (/配图\s*[:：]|自拍\s*[:：]|配视频\s*[:：]|\[\s*表情|\[\s*网页卡|\[\s*位置/.test(raw)) return false;
  const n = compactSpeechForStyle(raw);
  if (!n || n.length < 6) return false;
  return examples.some((ex) => {
    const en = compactSpeechForStyle(ex);
    if (!en) return false;
    if (n === en) return true;
    if (en.length >= 8 && n.length >= 8 && n.includes(en)) return true;
    if (en.length >= 8 && n.length >= 8 && en.includes(n) && Math.abs(n.length - en.length) <= 8) return true;
    const k = Math.min(n.length, en.length, 24);
    if (en.length >= 8 && n.length >= 8 && k >= 12 && n.slice(0, k) === en.slice(0, k)
      && Math.abs(n.length - en.length) <= 10) return true;
    return false;
  });
}

/** 去掉整句照搬【语言风格】例句的气泡，只留按当前话题新写的句子 */
/** 字面上没说完就被掐掉的残句：你怎么还没 / 卡在「把/和/的」上 */
const TRUNC_HANG_RE = /(?:怎么还没|还没来得及|还没|你怎么|我还|把|将|被|从|向|往|给|跟|和|与|或|以及|因为|所以|但是|可是|然后|而且|如果|虽然|不但|不仅|就是|还是|要是|除非|无论|不管|除了|为了|由于|关于|对于|通过|按照|根据|作为|(?:所以|但是|可是|然后|而且)(?:我|你)?(?:想|要))$/;
const TRUNC_KEEP_SHORT = /^(嗯+|哦+|啊+|哈+|唉+|哎+|额+|好+|行+|在|我在|还在|就在|好的|是的|对的|真的|算了|得了|行了|好了|完了|懂了|走了|谢谢|没事)$/;

function looksTruncatedUtterance(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (looksLikeStandaloneHtml(t) || looksLikeWebCardPayload(t) || t.startsWith('{')) return false;
  if (/^[♪🎵\[]/.test(t) || /\[[^\]]{0,12}\]$/.test(t) && t.length <= 16) return false;
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

function dropTruncatedSpeech(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  if (looksLikeStandaloneHtml(raw) || looksLikeWebCardPayload(raw) || raw.trim().startsWith('{')) return raw;
  const parts = raw
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？…!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pool = parts.length ? parts : [raw.trim()];
  const kept = pool.filter((p) => !looksTruncatedUtterance(p));
  if (!kept.length) return '';
  return kept.join(kept.length > 1 && kept.every((s) => /[。！？…!?]$/.test(s)) ? '' : '\n');
}

function stripCopiedLanguageExamples(text, languageStyle) {
  const examples = extractLanguageStyleExamples(languageStyle);
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t || !examples.length) return t;
  if (looksLikeStandaloneHtml(t) || looksLikeWebCardPayload(t) || t.startsWith('{')) return t;
  const parts = t
    .split(/(?<=[。！？…!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pool = parts.length ? parts : [t];
  const kept = pool.filter((p) => !sentenceCopiesLanguageExample(p, examples));
  if (!kept.length) return '';
  return kept.join(kept.length > 1 && kept.every((s) => /[。！？…!?]$/.test(s)) ? '' : '\n');
}

function polishSpokenAiText(text, languageStyle, opts = {}) {
  let t = dropTruncatedSpeech(stripCopiedLanguageExamples(collapseRepeatedProse(text), languageStyle));
  if (!opts.theater) {
    try { t = require('./world-lock-helper').scrubMeetupLeakSpeech(t); } catch { /* ignore */ }
  }
  return t;
}

function proseNearDuplicate(a, b) {
  const norm = (s) => String(s || '')
    .replace(/^【自动回复】/, '')
    .replace(/\s+/g, '')
    .replace(/[。！？…!?，,、；;：:~\-—…「」""'']/g, '')
    .toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 8 && y.length >= 8 && (x.includes(y) || y.includes(x))) return true;
  const n = Math.min(x.length, y.length, 24);
  if (n >= 12 && x.slice(0, n) === y.slice(0, n) && Math.abs(x.length - y.length) <= 10) return true;
  return false;
}

/** 截断续写时去掉与上文重叠的开头，避免整段复读 */
function dedupeContinuationPiece(base, piece) {
  let p = String(piece || '').trim();
  if (!p) return '';
  const b = String(base || '');
  if (!b) return p;
  const prefix = b.slice(0, Math.min(40, b.length));
  if (prefix && p.startsWith(prefix)) {
    p = p.slice(prefix.length).trimStart();
  }
  for (let n = Math.min(b.length, p.length, 80); n >= 8; n--) {
    if (b.slice(-n) === p.slice(0, n)) {
      p = p.slice(n).trimStart();
      break;
    }
  }
  if (!p) return '';
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  if (norm(p).length >= 12 && norm(b).includes(norm(p))) return '';
  return p;
}

/** 输入法切屏误提交的孤立标点等无意义用户消息 */
function isSpuriousUserText(content, type = 'text') {
  if (type !== 'text' && type !== 'voice') return false;
  const t = String(content || '').trim();
  if (!t) return true;
  return /^[.。．…⋯、,，!！?？~～·•\s]+$/.test(t);
}

function coalesceCallSpeechSegments(segments) {
  if (!Array.isArray(segments) || segments.length < 2) return segments || [];
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const bits = buf.map((s) => String(s.content || '').trim()).filter(Boolean);
    if (bits.length) {
      out.push({
        type: 'text',
        content: bits.join('\n'),
        quotePreview: buf[0].quotePreview,
      });
    }
    buf = [];
  };
  for (const seg of segments) {
    if (!seg) continue;
    if (seg.chatAfterHangup) {
      flush();
      out.push(seg);
      continue;
    }
    const t = seg.type || 'text';
    // 说话气泡合并：text/voice 都算（JSON 音效/表情等不并）
    const isSpeech = (t === 'text' || t === 'voice')
      && !String(seg.content || '').trim().startsWith('{');
    if (isSpeech) buf.push(seg);
    else {
      flush();
      out.push(seg);
    }
  }
  flush();
  return out.length ? out : segments;
}

function stampCallLineMeta(id) {
  if (!id) return;
  try {
    let meta = {};
    try { meta = JSON.parse(db.prepare('SELECT media_meta FROM messages WHERE id=?').get(id)?.media_meta || '{}') || {}; } catch { meta = {}; }
    meta.callLine = 1;
    db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), id);
  } catch {}
}

function saveAiReplySegments(characterId, segments, char, isDreamMode, options = {}) {
  // 电话（语音/视频）每轮只留一条说话气泡，不要按聊天那样拆句
  if (options.voiceCallMode) segments = coalesceCallSpeechSegments(segments);
  // 梦境是散文长文：勿拆聊天气泡、勿裁「收尾句」，否则会出现半句话突然没了
  if (!options.voiceCallMode && !isDreamMode) segments = expandSegmentsForBubbles(segments);
  let voiceIndices = pickVoiceSegmentIndices(segments, char, isDreamMode, options);
  // 语音条保持一句一条入库（与直播拆泡一致）；入库前补句末「。」
  if (voiceIndices.size && !options.voiceCallMode && !isDreamMode) {
    for (const i of voiceIndices) {
      const seg = segments[i];
      if (!seg || seg.type === 'emoji' || seg.type === 'image' || seg.type === 'video'
        || seg.type === 'voice' || seg.type === 'location' || seg.type === 'link' || seg.type === 'web_card') continue;
      const raw = String(seg.content || '').trim();
      if (!raw || raw.startsWith('{')) continue;
      const withPeriod = keepVoicePeriod(raw);
      if (withPeriod) seg.content = withPeriod;
    }
  }
  const isDream = isDreamMode ? 1 : 0;
  const aiMessages = [];
  let aiMsgId = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.content && seg.type !== 'emoji') continue;
    // [语气:xx] 得在剥标记之前取走，剥完 content 里就没有了
    let segTone = '';
    try { segTone = require('./speech-text-helper').extractToneTag(seg.content); } catch {}
    let type = 'text';
    if (seg.type === 'emoji') type = 'emoji';
    else if (seg.type === 'image') type = 'image';
    else if (seg.type === 'video') type = 'video';
    else if (seg.type === 'voice') type = 'voice';
    else if (seg.type === 'location') type = 'location';
    else if (seg.type === 'link') type = 'link';
    else if (seg.type === 'web_card') type = 'web_card';
    if (type === 'text' && voiceIndices.has(i)) type = 'voice';
    // 小剧场只用文字气泡，禁止语音条；定位卡片可保留
    if (options.theater && type === 'voice') type = 'text';
    if ((type === 'text' || type === 'voice') && looksLikeWebCardPayload(seg.content)) type = 'web_card';
    if (options.voiceCallMode && type === 'text' && !seg.chatAfterHangup) type = 'voice';
    if (seg.chatAfterHangup && type === 'voice') type = 'text';
    let content;
    let locationVal = '';
    if (type === 'emoji') content = seg.content;
    else if (type === 'image' || type === 'video') content = seg.content;
    else if (type === 'location') {
      const place = String(seg.location || seg.content || '')
        .replace(/^\[位置\]\s*/, '')
        .trim();
      const addr = String(seg.address || '').trim();
      content = addr && !place.includes('|') ? `${place}|${addr}` : place;
      locationVal = place.split(/[|｜]/)[0].trim() || place;
      if (!content) continue;
    } else if (type === 'link') {
      const { title, body } = parseLinkPayload(seg.content || `${seg.title || ''}|${seg.body || ''}`);
      content = serializeLinkContent(title, body);
      if (!content) continue;
    } else if (type === 'web_card') {
      const { title, html } = parseWebCardPayload(seg.content || serializeWebCardContent(seg.title, seg.html));
      if (!html) continue;
      content = serializeWebCardContent(title, html);
    } else if (type === 'voice' && String(seg.content || '').trim().startsWith('{')) content = seg.content;
    else {
      const cleaned = stripAiContextLabels(seg.content);
      if (isDreamMode) content = cleaned;
      else if (type === 'voice') {
        const spoken = dropTruncatedSpeech(sanitizeInlineBeans(cleaned, { forceStrip: true }));
        content = spoken ? keepVoicePeriod(spoken) : '';
      } else {
        content = stripDisplayPeriod(dropTruncatedSpeech(cleaned));
      }
    }
    if ((!content || isDirectiveOnlyText(content)) && type !== 'emoji' && type !== 'location' && type !== 'link' && type !== 'web_card') continue;
    const now = new Date().toISOString();
    let replyToId = null;
    let replyPreview = '';
    if (seg.quotePreview && (type === 'text' || type === 'voice')) {
      replyPreview = String(seg.quotePreview).slice(0, 100);
      replyToId = findQuoteSourceId(characterId, isDream, seg.quotePreview);
    }
    const deliveryStatus = options.deliveryStatus || 'sent';
    let id;
    try {
      id = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read, reply_to_id, reply_preview, delivery_status, location) VALUES (?,?,?,?,?,?,0,?,?,?,?)`
      ).run(characterId, 'assistant', content, type, now, isDream, replyToId, replyPreview, deliveryStatus, locationVal).lastInsertRowid;
    } catch {
      try {
        id = db.prepare(
          `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read, reply_to_id, reply_preview, location) VALUES (?,?,?,?,?,?,0,?,?,?)`
        ).run(characterId, 'assistant', content, type, now, isDream, replyToId, replyPreview, locationVal).lastInsertRowid;
      } catch {
        id = db.prepare(
          `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read, reply_to_id, reply_preview) VALUES (?,?,?,?,?,?,0,?,?)`
        ).run(characterId, 'assistant', content, type, now, isDream, replyToId, replyPreview).lastInsertRowid;
      }
      try { db.prepare(`UPDATE messages SET delivery_status=? WHERE id=?`).run(deliveryStatus, id); } catch {}
      if (locationVal) {
        try { db.prepare(`UPDATE messages SET location=? WHERE id=?`).run(locationVal, id); } catch {}
      }
    }

    if (options.theater) {
      try {
        let meta = {};
        try { meta = JSON.parse(db.prepare('SELECT media_meta FROM messages WHERE id=?').get(id)?.media_meta || '{}') || {}; } catch { meta = {}; }
        meta.theater = 1;
        db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), id);
      } catch {}
    }
    if (options.voiceCallMode && type !== 'web_card' && !seg.chatAfterHangup) stampCallLineMeta(id);

    let ttsEmotion = '';
    let ttsSpeed = 0;
    if (type === 'voice' && content && !String(content).trim().startsWith('{')) {
      try {
        // 与通话同一套：少套 happy/fluent，避免语音气泡听成配音
        const { resolveCallTtsEmotion, resolveTtsSpeed } = require('./api-helper');
        const { extractSpeechRateTag } = require('./speech-text-helper');
        let ttsModel = '';
        try {
          const rows = db.prepare(`SELECT value FROM settings WHERE key='minimax_model'`).get();
          ttsModel = String(rows?.value || '');
        } catch {}
        ttsEmotion = resolveCallTtsEmotion(content, ttsModel, segTone);
        ttsSpeed = resolveTtsSpeed(content, {
          emotion: ttsEmotion,
          taggedSpeed: extractSpeechRateTag(seg.content),
          inCall: true,
        }) || 0;
        if (ttsEmotion || ttsSpeed || segTone || options.voiceCallMode) {
          let meta = {};
          try { meta = JSON.parse(db.prepare('SELECT media_meta FROM messages WHERE id=?').get(id)?.media_meta || '{}') || {}; } catch { meta = {}; }
          if (ttsEmotion) meta.tts_emotion = ttsEmotion;
          if (ttsSpeed) meta.tts_speed = ttsSpeed;
          // 原样留着：电话链路要凭它压过保守的关键词猜测
          if (segTone) meta.tts_tone = segTone;
          if (options.voiceCallMode) meta.callLine = 1;
          db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), id);
        }
      } catch (e) {
        console.warn('[tts_emotion]', e.message);
      }
    } else {
      segTone = '';
    }

    // 同轮撤回：这条气泡是"发出去后立刻反悔"的那句，入库时直接落成已撤回状态，
    // 前端拿到的响应里仍带原文，负责先展示原文再做撤回动画
    let recallAfterSend = false;
    if (seg.recallAfterSend && (type === 'text' || type === 'voice')) {
      recallAfterSend = true;
      db.prepare(`UPDATE messages SET recalled=1, recalled_content=content, content='对方撤回了一条消息' WHERE id=?`).run(id);
    }

    aiMessages.push({
      id, type,
      content: content || seg.content,
      timestamp: now,
      location: type === 'location' ? (locationVal || content) : undefined,
      replyPreview: replyPreview || undefined,
      recallAfterSend: recallAfterSend || undefined,
      delivery_status: deliveryStatus,
      is_read: 0,
      ...((ttsEmotion || ttsSpeed || segTone || options.voiceCallMode) ? {
        ...(ttsEmotion ? { tts_emotion: ttsEmotion } : {}),
        ...(segTone ? { tts_tone: segTone } : {}),
        media_meta: JSON.stringify({
          ...(ttsEmotion ? { tts_emotion: ttsEmotion } : {}),
          ...(ttsSpeed ? { tts_speed: ttsSpeed } : {}),
          ...(segTone ? { tts_tone: segTone } : {}),
          ...(options.voiceCallMode ? { callLine: 1 } : {}),
        }),
      } : {}),
    });
    aiMsgId = id;
    if (type === 'location') {
      try {
        require('./location-weather-helper').attachLocationCoords(id, content, char).catch(() => {});
      } catch {}
    }
  }

  return { aiMsgId, aiMessages };
}

/** 根据表情包 URL 查找用户保存的描述 */
function lookupEmojiDescription(contentOrUrl) {
  const url = String(contentOrUrl || '');
  const filename = url.replace(/^.*\//, '').split('?')[0];
  if (!filename) return null;
  const row = db.prepare('SELECT description FROM emojis WHERE filename=? LIMIT 1').get(filename);
  return row?.description?.trim() || null;
}

/** 将消息格式化为 AI 可理解的文本（含表情包描述、语音/文字标记） */
function formatMessageForAi(msg) {
  const role = msg?.role;
  const type = msg?.type || 'text';
  const content = String(msg?.content || '').trim();
  if (msg?.recalled && role === 'user') {
    const saw = Number(msg.recall_seen) === 1;
    const raw = String(msg.recalled_content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (saw && raw) {
      return `【系统】对方撤回了一条消息。你已经看见原文：「${raw}」。可以点破也可以装没看见，按人设来；不要整段复读原文。`;
    }
    return `【系统】对方撤回了一条消息。你没看清原文，只知道对方把刚发的话收回去了。可以随口接一句，或当没看见。`;
  }
  const albumFmt = formatAlbumMessageForAi(msg);
  if (albumFmt) return albumFmt;
  if (msg._callChannel && (type === 'text' || type === 'voice') && !String(content).trim().startsWith('{')) {
    if (role === 'user') return `[通话] 对方说：${content}`;
    return `[通话] 你说：${content}`;
  }
  if (type === 'emoji') {
    const desc = lookupEmojiDescription(content);
    // [表情包]描述 仅用于用户发图，便于角色理解；角色自己发的图用另一套标记
    if (role === 'user') {
      return desc ? `[表情包]「${desc}」` : '[表情包]';
    }
    return desc ? `[发送表情包：${desc}]` : '[发送表情包]';
  }
  if (type === 'voice') {
    try {
      const meta = typeof msg?.media_meta === 'string'
        ? JSON.parse(msg.media_meta || '{}')
        : (msg?.media_meta || {});
      if (meta.robotMic) return '[你通过桌上小机听到的一段声音]';
      if (meta.callLine && role === 'assistant') return `[通话里说过] ${content}`;
    } catch {}
    // 用户录音 / 相册语音由 formatAlbumMessageForAi 处理；角色 TTS 语音仍用原文
    if (role === 'user') {
      try {
        const j = JSON.parse(content);
        if (j?.voice && j.url) {
          const t = String(j.transcript || '').trim();
          return t ? `[用户语音] ${t}` : '[用户发来一段语音]';
        }
      } catch {}
      return '[用户发来一段语音]';
    }
    // 乐器演奏 / 带 url 的语音条：不要把整段 JSON 喂给模型
    if (content.startsWith('{')) {
      try {
        const j = JSON.parse(content);
        if (j?.voice && j.url) {
          const t = String(j.transcript || '').trim();
          if (j.score) return t ? `[语音] ${t}` : '[语音] ♪ 乐器演奏';
          if (j.breathBed) return '[现场呼吸]';
          if (j.texture) return '[贴身摩擦]';
          if (j.vocal) return '[拟声]';
          if (j.sfx) return j.ambience ? '[现场环境]' : '[环境音]';
          return t ? `[语音] ${t}` : '[语音]';
        }
      } catch {}
    }
    return `[语音] ${content}`;
  }
  if (type === 'image' || type === 'video') {
    if (role === 'assistant') return type === 'video' ? '[你发给对方的一段视频]' : '[你发给对方的一张图片]';
    return '[图片]';
  }
  if (type === 'location') {
    const loc = String(msg?.location || '').trim();
    const cont = String(content || '').trim();
    const place = (cont.includes('|') || cont.includes('｜') ? cont : '')
      || (loc.includes('|') || loc.includes('｜') ? loc : '')
      || loc
      || cont;
    const cleaned = String(place || '')
      .replace(/^\[(?:发送)?位置[:：\]】]?\s*/i, '')
      .replace(/\s*[\[【]\/\s*(?:发送)?位置[\]】]\s*$/i, '')
      .trim();
    const parts = cleaned.split(/[|｜]/).map((x) => x.trim()).filter(Boolean);
    const title = parts[0] || cleaned || '未知';
    const detail = parts.slice(1).join(' ');
    // 带上详细地址，方便对方接「你在哪条路」；写法仍用标准开闭标签
    const body = detail ? `${title}|${detail}` : title;
    return `[位置]${body}[/位置]`;
  }
  if (type === 'link') {
    const { title, body } = parseLinkPayload(content);
    const card = serializeLinkContent(title, body);
    if (role === 'user') {
      return `[用户分享的链接卡]${card}[/用户分享的链接卡]（卡片里的标题和文案你都能读到，按内容接话；不要说去打开网页）`;
    }
    return `[链接]${card}[/链接]`;
  }
  if (type === 'web_card') {
    const { title } = parseWebCardPayload(content);
    return `[网页卡]${title || '网页卡'}[/网页卡]`;
  }
  if (type === 'system' && /拍了拍/.test(content)) {
    if (role === 'user') {
      return `[拍一拍提示] ${content}（用户拍了拍你；这不是文字消息，也不是省略号或空白）`;
    }
    return `[拍一拍提示] ${content}`;
  }
  if (type === 'system') {
    if (/^\[电话被挂断/.test(content) || /^\[电话没打通/.test(content)) return content;
    if (/^\[(?:视频|语音)?通话开始\]/.test(content)) {
      return content.includes('视频') ? '[视频通话开始，已接通]' : '[语音通话开始，已接通]';
    }
    if (/通话已结束|通话结束|通话被对方结束/.test(content)) {
      const dur = content.match(/([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/)
        || content.match(/(\d+\s*分(?:\s*\d+\s*秒)?|\d+\s*秒|\d+\s*分钟)/);
      const kind = content.includes('视频') ? '视频通话结束' : '语音通话结束';
      return dur ? `[${kind} ${String(dur[1]).replace(/\s+/g, '')}]` : `[${kind}]`;
    }
    if (/你没有接听/.test(content)) {
      return content.includes('视频') ? '[用户打来视频电话，你未接]' : '[用户打来语音电话，你未接]';
    }
    if (/安静了大约四十秒/.test(content)) return '[对方大约四十秒没出声]';
    if (/情境上已经睡着/.test(content)) return '[对方已经睡着了]';
    if (/电话这头安静/.test(content)) return '[对方这头安静了一会儿]';
    if (/^\[连麦/.test(content)) return '[连麦挂着]';
    if (/^\[一起看/.test(content)) return '[一起看]';
  }
  // 角色自己的文字气泡标为 [文字]，避免与 [语音] 混淆
  if (role === 'assistant' && type === 'text') return `[文字] ${content}`;
  return content;
}

module.exports = {
  parseJsonArray,
  getAvailableEmojis,
  findEmojiByDescription,
  emojiFileExists,
  emojiBasename,
  decorateEmojiRecord,
  resolveLiveEmojiUrl,
  healMissingEmojiFiles,
  mergeReplacementEmoji,
  invalidateEmojiLiveCache,
  stripModelLeakage,
  stripMindPrivateTags,
  stripHistoryChannelEcho,
  scrubUserVisibleText,
  stripMindsetEcho,
  stripAiContextLabels,
  isBareMediaLabel,
  splitAiSegments,
  lookupEmojiDescription,
  formatMessageForAi,
  parseLinkPayload,
  serializeLinkContent,
  buildEmojiPromptSection,
  buildVoiceMessagePromptSection,
  buildLocationMessagePromptSection,
  buildLinkMessagePromptSection,
  buildWebCardPromptSection,
  parseWebCardPayload,
  serializeWebCardContent,
  looksLikeStandaloneHtml,
  looksLikeWebCardPayload,
  applyLocationMarkersToSegments,
  applyLinkMarkersToSegments,
  applyWebCardMarkersToSegments,
  userRequestsVoiceMessage,
  userRequestsPhoneCall,
  processAiContentWithEmojis,
  pickVoiceSegmentIndices,
  saveAiReplySegments,
  extractRecallDirective,
  recallLastAiMessage,
  extractQuoteMarker,
  findQuoteSourceId,
  stripResidualDirectiveTags,
  buildRecallPromptSection,
  buildQuoteReplyPromptSection,
  buildPokePromptSection,
  buildCallDirectivePromptSection,
  buildTheaterInvitePromptSection,
  extractPokeDirective,
  extractCallDirective,
  extractEndCallDirective,
  splitEndCallSpeech,
  isOnlyPhonePickup,
  stripLeadingPhonePickup,
  latestCallPhaseFromMessages,
  latestPersistedCallPhase,
  recentChatLeftCall,
  buildPostCallChatNote,
  applyCallChannelMarks,
  resolveChatIncomingCall,
  isBarePokeSuffix,
  insertCharacterPokeMessage,
  collectEmojiMarkMatches,
  stripEmojiMarksFromText,
  collapseRepeatedProse,
  extractLanguageStyleExamples,
  stripCopiedLanguageExamples,
  polishSpokenAiText,
  looksTruncatedUtterance,
  dropTruncatedSpeech,
  proseNearDuplicate,
  dedupeContinuationPiece,
  isSpuriousUserText,
};

/**
 * 角色按需搜聊天记录：后端规则分流，命中时注入【聊天记录·相关】
 * 设计见项目根目录 角色回忆-记忆与搜聊天.md
 */
const db = require('./db');
const { scoreTextsAgainst } = require('./embed-helper');

const RECALL_INTENT_RE = /记得吗|还记得|上次说|之前聊|之前说|我跟你说过|你忘了|你不记得|那天|哪天|原话|你说过|我们不是说好|上午说|早上说|早上聊|刚才聊|刚才说|刚刚说/;
const EXACT_RECALL_RE = /原话|你忘了|你不记得|记得吗|还记得|哪天|那天.{0,6}说|当时.{0,6}说/;
const DETAIL_SIGNAL_RE = /具体|叫什么|哪一个|哪次|什么时候|几号|哪天|怎么说|怎么讲/;
const RECENT_CALLBACK_RE = /上午|今早|早上.{0,4}(说|聊|提)|中午那|刚才|刚刚那|早些时候|你刚(才)?说|你不是说|说到(那个|这)|那事儿|那件事|上次那个|刚才那个/;
const FILLER_TERMS = new Set([
  '今天', '昨天', '前天', '上午', '下午', '晚上', '刚才', '现在', '刚刚',
  '真的', '就是', '还是', '然后', '这个', '那个', '我们', '你们', '自己',
  '一下', '一点', '什么', '怎么', '可以', '没有', '不是', '知道', '觉得',
  '因为', '所以', '但是', '如果', '已经', '还没', '在干嘛', '干嘛', '干啥',
  '你好', '在吗', '哈哈', '呵呵', '嗯嗯', '好的', '哦哦', '没事', '晚安',
  '早安', '早上好', '下午好', '晚上好', '好吧', '行吧', '知道了', '收到',
  '好烦', '好累', '开心', '难过', '无聊', '无语', '离谱', '呵呵呵', '谢谢',
]);

function getLocalDateStr(date, tz = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return String(date).slice(0, 10);
  }
}

function extractTerms(text) {
  const terms = new Set();
  String(text || '')
    .split(/[，。！？、；：\s\n\r\t\/\|·…—\-~～「」『』（）()\[\]【】]{1,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 16)
    .forEach((s) => terms.add(s));
  return [...terms];
}

function isRecallSearchEnabled(char = {}, settings = {}) {
  if (String(settings.chat_recall_search_enabled || '') === '0') return false;
  if (char.chat_recall_search_enabled === 0) return false;
  return true;
}

function wantsExactRecall(userText) {
  return EXACT_RECALL_RE.test(String(userText || ''));
}

function hasRecallIntent(userText) {
  return RECALL_INTENT_RE.test(String(userText || ''));
}

function recentWindowText(recentHistory = []) {
  return (recentHistory || [])
    .filter((m) => m?.content && !m.recalled)
    .map((m) => String(m.content))
    .join('\n');
}

function topicTermsInRecent(userText, recentHistory = []) {
  const recent = recentWindowText(recentHistory);
  if (!recent) return false;
  return pickSearchableTerms(userText).some((t) => recent.includes(t));
}

function isFillerTerm(term) {
  return FILLER_TERMS.has(String(term || '').trim());
}

function pickSearchableTerms(userText) {
  const raw = extractTerms(userText).filter((t) => t.length >= 2 && !isFillerTerm(t));
  const extra = [];
  for (const t of raw) {
    if (!/[\u4e00-\u9fff]{3,}/.test(t)) continue;
    for (let i = 0; i <= t.length - 2; i++) {
      const two = t.slice(i, i + 2);
      if (!isFillerTerm(two) && /[\u4e00-\u9fff]{2}/.test(two)) extra.push(two);
      if (i + 3 <= t.length) {
        const three = t.slice(i, i + 3);
        if (!isFillerTerm(three)) extra.push(three);
      }
    }
  }
  return [...new Set([...raw, ...extra])]
    .sort((a, b) => b.length - a.length)
    .slice(0, 6);
}

function termHitsRecentChat(charId, terms, opts = {}) {
  const list = (terms || []).map((t) => String(t || '').trim()).filter((t) => t.length >= 2);
  if (!charId || !list.length) return '';
  const excludeIds = (opts.excludeIds || []).map(Number).filter(Number.isFinite);
  const sinceHours = Number(opts.sinceHours) || 48;
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const dreamFlag = opts.isDream ? 1 : 0;
  const excludeSql = excludeIds.length
    ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})`
    : '';
  for (const term of list) {
    const row = db.prepare(
      `SELECT id FROM messages
       WHERE character_id=? AND is_dream=? AND recalled=0
         AND content LIKE ? AND timestamp>=?
         AND (type IS NULL OR type != 'system')
         ${excludeSql}
       LIMIT 1`
    ).get(charId, dreamFlag, `%${term}%`, since, ...excludeIds);
    if (row) return term;
  }
  return '';
}

/** 本轮是否像翻旧账 / 要点近期对话 / 要原话细节（闲聊默认不搜） */
function shouldSearchChatHistory(userText, recentHistory = [], opts = {}) {
  const text = String(userText || '').trim();
  if (!text) return false;

  // 硬意图：记得吗 / 你忘了 / 原话等
  if (hasRecallIntent(text) || /你忘了|你不记得/.test(text)) return true;
  // 指近窗外的「上午/早上说」等回调
  if (RECENT_CALLBACK_RE.test(text) && !topicTermsInRecent(text, recentHistory)) return true;
  // 追问细节且近窗接不住
  const terms = extractTerms(text).filter((t) => t.length >= 3 && !isFillerTerm(t));
  if (terms.length && DETAIL_SIGNAL_RE.test(text) && !topicTermsInRecent(text, recentHistory)) {
    return true;
  }
  // 会话刚断档后的回接：允许按词搜近 48h（opts.sessionClosed）
  if (opts.sessionClosed && terms.length && !topicTermsInRecent(text, recentHistory) && opts.charId) {
    const hit = termHitsRecentChat(opts.charId, pickSearchableTerms(text), {
      excludeIds: (recentHistory || []).map((m) => m.id),
      sinceHours: 48,
    });
    if (hit) return true;
  }

  return false;
}

/** 记忆点是否已能接上话题（无「原话/哪天」追问时可跳过搜聊天） */
function memoryPointCoversWell(charId, userText, contextText = '') {
  try {
    const narrativeHelper = require('./memory-narrative-helper');
    const ctx = String(contextText || userText || '').trim();
    if (!ctx || !charId) return false;
    const narratives = narrativeHelper.selectNarrativesForPrompt(charId, ctx, { topK: 1, minScore: 0.35 });
    return narratives.length > 0;
  } catch {
    return false;
  }
}

function extractSearchQuery(userText) {
  const text = String(userText || '').trim();
  if (!text) return '';

  const cleaned = text
    .replace(/记得吗|还记得|你忘了|你不记得|我跟你说过|之前说|之前聊|上次说|你说过|我们不是说好|原话(是什么|怎么说)?|上午说|早上说|早上聊|刚才聊|刚才说|刚刚说/g, '')
    .replace(/[？?！!。，,、；;：:""''「」【】（）()]/g, ' ')
    .trim();

  const terms = extractTerms(cleaned).filter((t) => t.length >= 2);
  if (terms.length) {
    terms.sort((a, b) => b.length - a.length);
    return terms[0].slice(0, 24);
  }

  if (cleaned.length >= 2 && cleaned.length <= 20) return cleaned;

  const m = text.match(/(?:报考|考试|学习|约定|承诺|说过|聊过).{0,12}/);
  if (m) return m[0].slice(0, 24);

  return text.slice(0, 16);
}

function enrichMessageMediaFields(row) {
  if (!row) return row;
  const out = { ...row };
  if (out.media_meta && typeof out.media_meta === 'string') {
    try { out.media_meta = JSON.parse(out.media_meta); } catch { /* keep string */ }
  }
  return out;
}

function isHiddenSearchRow(row) {
  let meta = row?.media_meta;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  if (!meta || typeof meta !== 'object') return false;
  return !!(meta.hideChat || meta.hiddenChat || meta.robotMic);
}

/** UI 搜索与角色补洞共用 */
function searchCharacterMessages(charId, opts = {}) {
  const keyword = String(opts.q || opts.keyword || '').trim();
  const dateStr = String(opts.date || '').trim();
  const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  if (!keyword && !isValidDate) return [];

  const dreamFlag = parseInt(opts.dream, 10) || 0;
  const lim = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  const tz = opts.tz || 'Asia/Shanghai';

  const matchLocalDay = (row) => {
    if (!isValidDate) return true;
    const raw = String(row.timestamp || '');
    const d = new Date(/T|Z|\+/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    if (Number.isNaN(d.getTime())) return String(row.timestamp || '').slice(0, 10) === dateStr;
    return getLocalDateStr(d, tz) === dateStr;
  };

  const conditions = ['character_id=?', 'is_dream=?', 'recalled=0'];
  const params = [charId, dreamFlag];
  if (keyword) {
    conditions.push('content LIKE ?');
    params.push(`%${keyword}%`);
  }
  if (isValidDate) {
    const looseStart = new Date(`${dateStr}T00:00:00.000Z`);
    looseStart.setUTCDate(looseStart.getUTCDate() - 1);
    const looseEnd = new Date(`${dateStr}T23:59:59.999Z`);
    looseEnd.setUTCDate(looseEnd.getUTCDate() + 1);
    conditions.push('timestamp>=?');
    params.push(looseStart.toISOString());
    conditions.push('timestamp<=?');
    params.push(looseEnd.toISOString());
  }
  const where = conditions.join(' AND ');

  if (isValidDate && !keyword) {
    const candidates = db.prepare(
      `SELECT * FROM messages WHERE ${where} ORDER BY id ASC LIMIT ?`
    ).all(...params, Math.max(lim * 20, 200));
    return candidates.filter(matchLocalDay).filter(r => !isHiddenSearchRow(r)).slice(0, lim).map(enrichMessageMediaFields);
  }

  const candidates = db.prepare(
    `SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`
  ).all(...params, isValidDate ? Math.max(lim * 20, 200) : lim);
  const msgs = (isValidDate ? candidates.filter(matchLocalDay) : candidates)
    .filter(r => !isHiddenSearchRow(r))
    .slice(0, lim);
  return msgs.reverse().map(enrichMessageMediaFields);
}

/** 角色补洞：关键词检索 + 轻量相关度排序 */
function searchMessagesForRecall(charId, query, opts = {}) {
  const keyword = String(query || '').trim();
  if (!keyword || !charId) return [];

  const dreamFlag = opts.isDream ? 1 : 0;
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 5, 1), 10);
  const excludeIds = new Set((opts.excludeIds || []).map(Number).filter(Number.isFinite));
  const sinceHours = Number(opts.sinceHours) || 0;
  const params = [charId, dreamFlag, `%${keyword}%`];
  let sinceSql = '';
  if (sinceHours > 0) {
    sinceSql = 'AND timestamp>=?';
    params.push(new Date(Date.now() - sinceHours * 3600 * 1000).toISOString());
  }
  params.push(limit * 4);

  const rows = db.prepare(
    `SELECT id, role, content, timestamp, type FROM messages
     WHERE character_id=? AND is_dream=? AND recalled=0
     AND content LIKE ?
     AND (type IS NULL OR type != 'system')
     ${sinceSql}
     ORDER BY id DESC LIMIT ?`
  ).all(...params);

  const usable = rows.filter((r) => !excludeIds.has(r.id));
  // 这些消息都已经 LIKE 命中了关键词，这里只是排个序：
  // 语料就用这批消息自己，谁更集中地围绕这个关键词谁靠前
  const scores = scoreTextsAgainst(keyword, usable.map((r) => ({ content: r.content })));
  return usable
    .map((r, i) => {
      let score = scores[i] || 0;
      if (r.role === 'user') score += 0.05;
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .slice(0, limit)
    .reverse();
}

function formatMessageLine(msg, tz = 'Asia/Shanghai') {
  const content = String(msg.content || '').replace(/\s+/g, ' ').trim();
  const truncated = content.length > 120 ? `${content.slice(0, 118)}…` : content;
  const raw = String(msg.timestamp || '');
  let dateLabel = raw.slice(0, 10);
  try {
    const d = new Date(/T|Z|\+/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    if (!Number.isNaN(d.getTime())) dateLabel = getLocalDateStr(d, tz);
  } catch { /* keep slice */ }
  const who = msg.role === 'user' ? '用户' : '你';
  return `· ${dateLabel} ${who}：${truncated}`;
}

function formatChatRecallForPrompt(hits, tz = 'Asia/Shanghai', extra = {}) {
  if (!hits?.length) {
    if (extra.softMiss) return '';
    return '【聊天记录·相关】系统未检出与本轮话题明显相关的旧对话原文。细节对不上时按人设自然承认记不清，不要编造。';
  }
  const lines = hits.map((h) => formatMessageLine(h, tz));
  const lead = extra.recent
    ? '以下是系统从近期对话里检出的原文（对方在提这件事；接上即可，不要整段复读，也不要装作没聊过）'
    : '以下是系统从旧对话里检出的原文片段（仅供核对细节，不要整段复读；可与【脑海】/记忆点并用）';
  return `【聊天记录·相关】${lead}：
${lines.join('\n')}`;
}

function buildChatRecallBlock(char, userText, recentHistory = [], contextText = '', settings = {}, opts = {}) {
  if (!isRecallSearchEnabled(char, settings)) return '';

  const charId = char?.id;
  if (!charId) return '';

  const recent = !!(opts.sessionClosed || RECENT_CALLBACK_RE.test(String(userText || '')));
  if (!shouldSearchChatHistory(userText, recentHistory, { charId, sessionClosed: !!opts.sessionClosed })) {
    return '';
  }

  const ctx = contextText || userText;
  if (memoryPointCoversWell(charId, userText, ctx) && !wantsExactRecall(userText) && !recent) {
    return '';
  }

  const recentIds = (recentHistory || []).map((m) => m.id).filter(Boolean);
  const queries = [];
  const primary = extractSearchQuery(userText);
  if (primary) queries.push(primary);
  for (const t of pickSearchableTerms(userText)) {
    if (!queries.includes(t)) queries.push(t);
  }
  if (!queries.length) return '';

  const tz = settings.timezone || char.timezone || 'Asia/Shanghai';
  const sinceHours = recent || opts.sessionClosed ? 48 : 0;
  let hits = [];
  for (const query of queries.slice(0, 3)) {
    hits = searchMessagesForRecall(charId, query, {
      limit: 5,
      excludeIds: recentIds,
      isDream: false,
      sinceHours,
    });
    if (hits.length) break;
  }

  return formatChatRecallForPrompt(hits, tz, {
    recent,
    softMiss: recent && !wantsExactRecall(userText),
  });
}

module.exports = {
  isRecallSearchEnabled,
  shouldSearchChatHistory,
  wantsExactRecall,
  memoryPointCoversWell,
  extractSearchQuery,
  searchCharacterMessages,
  searchMessagesForRecall,
  formatChatRecallForPrompt,
  buildChatRecallBlock,
};

/** 双方称呼：normalize / 提示注入 / 扫近聊候选 */

const NICKNAME_MAX = 8;
const NICKNAME_TEXT_MAX = 12;

function emptyNicknames() {
  return { toChar: [], toUser: [] };
}

function normalizeNicknameItem(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const text = String(raw).trim().slice(0, NICKNAME_TEXT_MAX);
    if (!text) return null;
    return { text, primary: false };
  }
  const text = String(raw.text || raw.name || '').trim().slice(0, NICKNAME_TEXT_MAX);
  if (!text) return null;
  return { text, primary: !!raw.primary };
}

function normalizeNicknameSide(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const item = normalizeNicknameItem(raw);
    if (!item) continue;
    const key = item.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= NICKNAME_MAX) break;
  }
  const primaries = out.filter(i => i.primary);
  if (primaries.length > 1) {
    let kept = false;
    for (const i of out) {
      if (i.primary && kept) i.primary = false;
      else if (i.primary) kept = true;
    }
  }
  return out;
}

function normalizeNicknames(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw || '{}'); } catch { obj = {}; }
  }
  if (!obj || typeof obj !== 'object') obj = {};
  return {
    toChar: normalizeNicknameSide(obj.toChar),
    toUser: normalizeNicknameSide(obj.toUser),
  };
}

function nicknamesToJson(raw) {
  return JSON.stringify(normalizeNicknames(raw));
}

function primaryOf(side) {
  if (!side?.length) return '';
  const p = side.find(i => i.primary);
  return (p || side[0]).text;
}

function othersOf(side, primary) {
  return (side || []).map(i => i.text).filter(t => t && t !== primary);
}

const NICKNAME_TRIGGER_RE = /叫(什么|啥|法|他|她)|怎么叫|称呼|昵称|外号|喊我|叫我什么/;

function nicknameHitInContext(nicknames, contextText) {
  const ctx = String(contextText || '');
  if (!ctx.trim()) return false;
  const n = normalizeNicknames(nicknames);
  const all = [...n.toChar, ...n.toUser].map((i) => i.text).filter(Boolean);
  if (all.some((t) => t.length >= 1 && ctx.includes(t))) return true;
  return NICKNAME_TRIGGER_RE.test(ctx);
}

const ADDRESS_VOCATIVES = [
  '亲爱的', '小朋友', '小祖宗', '小笨蛋', '傻瓜蛋',
  '宝贝', '宝宝', '老公', '老婆', '媳妇', '先生', '太太',
  '哥哥', '姐姐', '弟弟', '妹妹', '老师', '同学', '老板', '大人',
  '陛下', '公主', '殿下', '笨蛋', '傻瓜', '臭宝', '心肝', '乖乖',
].sort((a, b) => b.length - a.length);

function stripLeadDecor(text) {
  return String(text || '')
    .replace(/^【自动回复】/, '')
    .replace(/^\s*(?:\[[^\]]{1,32}\]\s*)+/g, '')
    .replace(/^(?:发送)?(?:语音|视频|位置|链接)[:：]?\s*/g, '')
    .trim();
}

function looksLikeVocativeFollow(ch) {
  return !ch || /[，,！!？?～~\s…·啊呀呢啦哦喔哈嘛哟诶欸呐哇你我]/.test(ch);
}

function extractVocativeFromText(text, { userName = '', charName = '' } = {}) {
  const raw = stripLeadDecor(String(text || '').split('\n')[0] || '');
  if (!raw) return '';
  const head = raw.slice(0, 24);
  const skip = new Set(['你', '我', '喂', String(charName || '').trim()].filter(Boolean));
  if (userName && head.startsWith(userName) && looksLikeVocativeFollow(head[userName.length])) {
    return userName;
  }
  for (const v of ADDRESS_VOCATIVES) {
    if (skip.has(v)) continue;
    if (head.startsWith(v) && looksLikeVocativeFollow(head[v.length])) return v;
  }
  return '';
}

/** 近聊里角色最近一次喊用户的叫法 */
function inferLastAddressToUser(recentHistory = [], names = {}) {
  const msgs = (recentHistory || []).filter((m) => m && m.role === 'assistant');
  for (let i = msgs.length - 1; i >= 0; i--) {
    const hit = extractVocativeFromText(msgs[i].content, names);
    if (hit) return hit;
  }
  return '';
}

/**
 * 称呼按人设来，并锁近聊已用喊法。
 * 不再注入「也用过」列表，避免一轮换一个外号。
 */
function buildAddressStabilityBlock(char, settings = {}, recentHistory = []) {
  const userName = String(settings.username || '').trim();
  const charName = String(char?.name || '').trim();
  const settled = inferLastAddressToUser(recentHistory, { userName, charName });
  const storedPrimary = primaryOf(normalizeNicknames(char?.nicknames).toUser);
  const lines = ['【称呼】怎么喊对方按人设、关系和你的说话习惯，不要列菜单轮换外号。'];
  if (settled) {
    lines.push(`近聊你已经在叫对方「${settled}」，继续用；对方明确说换再换。`);
  } else if (storedPrimary && storedPrimary !== charName) {
    lines.push(`就用「${storedPrimary}」这一种，不要再发明一串外号。`);
  } else {
    lines.push('选定一种常用喊法后稳住，禁止一轮一个外号。');
  }
  return lines.join('\n');
}

/** 注入聊天系统提示：稳住称呼，不再喂称呼菜单 */
function buildNicknamePromptBlock(char, settings = {}, contextText = '', recentHistory = []) {
  return buildAddressStabilityBlock(char, settings, recentHistory);
}

/** @deprecated 使用 buildNicknamePromptBlock(char, settings, contextText) */
function formatNicknamesForPrompt(char, settings, contextText) {
  return buildNicknamePromptBlock(char, settings, contextText);
}

function looksLikeNicknameCandidate(text, { charName = '', userName = '' } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > NICKNAME_TEXT_MAX) return false;
  if (/\s/.test(t)) return false;
  if (/[，,。！？!?.：:;；、]/.test(t)) return false;
  if (/^(你|我|他|她|它|咱|我们|你们|他们)$/.test(t)) return false;
  if (/^(老公|老婆|亲爱的|宝贝|宝宝|哥哥|姐姐|弟弟|妹妹|老师|同学)$/.test(t)) return true;
  // 全名本身保留为候选（有时就是正式称呼）
  if (t === charName || t === userName) return t.length <= 6;
  return t.length >= 1 && t.length <= NICKNAME_TEXT_MAX;
}

function filterScanList(list, existingSide, opts) {
  const existing = new Set(
    (existingSide || []).map(i => String(i.text || '').toLowerCase()).filter(Boolean)
  );
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const t = String(raw || '').trim().slice(0, NICKNAME_TEXT_MAX);
    if (!looksLikeNicknameCandidate(t, opts)) continue;
    const key = t.toLowerCase();
    if (seen.has(key) || existing.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= NICKNAME_MAX) break;
  }
  return out;
}

/**
 * 合并候选进已有列表。不改已有 primary；若该侧为空则第一个候选标 primary。
 */
function mergeNicknameCandidates(current, { toChar = [], toUser = [] } = {}) {
  const n = normalizeNicknames(current);
  const mergeSide = (side, candidates) => {
    const hadPrimary = side.some(i => i.primary);
    const seen = new Set(side.map(i => i.text.toLowerCase()));
    for (const c of candidates) {
      const text = String(c || '').trim().slice(0, NICKNAME_TEXT_MAX);
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      side.push({ text, primary: !hadPrimary && side.length === 0 });
      if (side.length >= NICKNAME_MAX) break;
    }
    return side;
  };
  return {
    toChar: mergeSide([...n.toChar], toChar),
    toUser: mergeSide([...n.toUser], toUser),
  };
}

module.exports = {
  NICKNAME_MAX,
  emptyNicknames,
  normalizeNicknames,
  nicknamesToJson,
  primaryOf,
  buildNicknamePromptBlock,
  buildAddressStabilityBlock,
  inferLastAddressToUser,
  formatNicknamesForPrompt,
  nicknameHitInContext,
  filterScanList,
  mergeNicknameCandidates,
  looksLikeNicknameCandidate,
};

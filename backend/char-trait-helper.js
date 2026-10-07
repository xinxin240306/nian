/** 角色喜好/擅长等：话题触发注入（非常驻） */
const db = require('./db');

const TRAIT_CATEGORIES = ['喜欢', '不喜欢', '擅长', '不擅长'];

/**
 * 获取角色音乐偏好（用于音乐同步功能）
 * @param {number} characterId 
 * @returns {Object} 音乐偏好配置
 */
function getCharacterMusicPreference(characterId) {
  // TODO: 未来可从数据库或角色配置中读取
  // 目前返回默认偏好，可根据角色性格定制
  return {
    favoriteGenres: ['流行', '民谣', '轻音乐', 'Indie'],
    dislikedGenres: ['重金属', 'Death Metal', 'Hardcore'],
    favoriteArtists: ['周杰伦', '陈奕迅', '林俊杰', 'Taylor Swift'],
    dislikedArtists: [],
    
    // 性格化偏好（0-1范围）
    personalityTraits: {
      adventurous: 0.3,  // 愿意尝试新风格
      nostalgic: 0.7,    // 喜欢怀旧经典
      lyricFocused: 0.8, // 注重歌词
      moodSensitive: 0.9 // 对情绪变化敏感
    }
  };
}

const LEGACY_TRAIT_CATEGORY_MAP = {
  喜好: '喜欢',
  忌口: '不喜欢',
  习惯: '喜欢',
  擅长: '擅长',
};

function normalizeTraitCategory(cat) {
  const c = String(cat || '').trim();
  if (TRAIT_CATEGORIES.includes(c)) return c;
  if (LEGACY_TRAIT_CATEGORY_MAP[c]) return LEGACY_TRAIT_CATEGORY_MAP[c];
  return '喜欢';
}

function parseKeywords(raw, content = '') {
  let kws = [];
  if (Array.isArray(raw)) kws = raw;
  else if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw || '[]');
      kws = Array.isArray(p) ? p : String(raw).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    } catch {
      kws = String(raw).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  const text = String(content || '').trim();
  const seen = new Set();
  const out = [];
  const push = (k) => {
    const s = String(k || '').trim().slice(0, 24);
    if (!s || s.length < 1) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const k of kws) push(k);
  const parts = text.split(/[,，、;；/|]/).map((s) => s.trim()).filter(Boolean);
  const segments = parts.length ? parts : [text];
  for (const part of segments) {
    if (part.length >= 2 && part.length <= 24) push(part);
    const core = part.replace(/^(很|比较|特别|非常|有点|不)?(喜欢|爱吃|讨厌|擅长|不擅长|会|不会|怕|忌|过敏)/, '').trim();
    if (core && core.length >= 2) push(core);
  }
  return out.slice(0, 10);
}

function listTraits(characterId) {
  if (!characterId) return [];
  try {
    return db.prepare(
      'SELECT id, character_id, content, category, keywords, enabled FROM char_traits WHERE character_id=? ORDER BY id ASC'
    ).all(characterId).map((r) => ({
      ...r,
      category: normalizeTraitCategory(r.category),
      keywords: parseKeywords(r.keywords, r.content),
      enabled: r.enabled !== 0 && r.enabled !== '0',
    }));
  } catch {
    return [];
  }
}

function replaceTraits(characterId, traits) {
  const cid = Number(characterId);
  if (!cid) throw new Error('character_id required');
  db.prepare('DELETE FROM char_traits WHERE character_id=?').run(cid);
  const ins = db.prepare(
    'INSERT INTO char_traits (character_id, content, category, keywords, enabled) VALUES (?,?,?,?,?)'
  );
  const arr = Array.isArray(traits) ? traits : [];
  for (const raw of arr.slice(0, 48)) {
    const content = String(raw?.content || '').trim().slice(0, 120);
    if (!content) continue;
    const category = normalizeTraitCategory(raw?.category);
    const keywords = JSON.stringify(parseKeywords(raw?.keywords, content));
    const enabled = raw?.enabled === false || raw?.enabled === 0 || raw?.enabled === '0' ? 0 : 1;
    ins.run(cid, content, category, keywords, enabled);
  }
  return listTraits(cid);
}

/**
 * 聊到相关话题时才注入角色侧喜好/擅长等。
 */
function formatCharTraitsForPrompt(characterId, contextText = '') {
  const ctx = String(contextText || '');
  const ctxLower = ctx.toLowerCase();
  if (!ctx.trim()) return '';

  const rows = listTraits(characterId).filter((r) => r.enabled);
  if (!rows.length) return '';

  const hits = [];
  for (const row of rows) {
    const text = String(row.content || '').trim();
    if (!text) continue;
    const kws = row.keywords || [];
    let score = 0;
    for (const k of kws) {
      const kk = String(k).toLowerCase();
      if (!kk || kk.length < 2) continue;
      if (!ctxLower.includes(kk)) continue;
      score += kk.length >= 3 ? 4 : 2;
    }
    if (text.length >= 2 && ctxLower.includes(text.toLowerCase())) score += 5;
    if (score > 0) hits.push({ row, score });
  }
  if (!hits.length) return '';

  hits.sort((a, b) => b.score - a.score);
  const lines = hits.slice(0, 6).map((h) => `- [${h.row.category}] ${h.row.content}`);
  return `【角色设定·本轮相关】以下是你（角色）的已知事实，自然用上即可；勿主动盘问用户、勿编造列表外技能。
${lines.join('\n')}`;
}

module.exports = {
  TRAIT_CATEGORIES,
  normalizeTraitCategory,
  parseKeywords,
  listTraits,
  replaceTraits,
  formatCharTraitsForPrompt,
  getCharacterMusicPreference,
};

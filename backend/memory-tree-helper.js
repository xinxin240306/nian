/**
 * 记忆树：每人一棵。最粗的树干是人格；话题是长出来的枝（挂得多就粗）。
 *
 * 粗枝大类（kind）：
 *   event     事件——有后续发展的事；细枝=人/物/场景
 *   daily     日常——反复行为习惯（如运动）；细枝可空，进展挂主干
 *   affection 感情——关系起伏事件（表白/冷战/和好）
 *   user      用户——角色眼里稳定的你；细枝=喜好/习惯/性格/人际关系/样子/不擅长
 *   self      自我——角色对自己的认知；细枝=行为习惯/喜好/经历
 *
 * 事件挂载：命中 0 不挂；命中 1（非事件核）进细枝；命中 ≥2 或命中事件核 → 上主干。
 */
const db = require('./db');
const { callChatAPIComplete } = require('./api-helper');
const { scoreTextsAgainst } = require('./embed-helper');

const TIER_ORDER = { hot: 0, warm: 1, cool: 2, dormant: 3 };
// 都配 scoreTextsAgainst 的 0..1 相关度。RELATED_COS 只是问 LLM 之前的粗筛，
// 后面还有 llmHits 把关，所以放宽一点，让真相关的别在这一步就被拦掉
const RELATED_COS = 0.35;
const STRONG_TITLE_SCORE = 0.45;
const COOL_MIN_SCORE = 0.32;

const KINDS = ['event', 'daily', 'affection', 'user', 'self'];
const KIND_LABEL = {
  event: '事件',
  daily: '日常',
  affection: '感情',
  user: '用户',
  self: '自我',
};

/** 用户粗枝下的细类（对齐画像） */
const USER_TRAIT_COMPONENTS = [
  { key: '喜好', name: '喜好', type: 'trait', aliases: ['爱好', '喜欢'] },
  { key: '习惯', name: '习惯', type: 'trait', aliases: ['作息'] },
  { key: '不擅长', name: '不擅长', type: 'trait', aliases: ['短板'] },
  { key: '性格', name: '性格', type: 'trait', aliases: ['脾气'] },
  { key: '人际关系', name: '人际关系', type: 'trait', aliases: ['人际', '社交'] },
  { key: '样子', name: '样子', type: 'trait', aliases: ['外貌', '穿着'] },
];

/** 自我粗枝下的细类（对齐自我认知） */
const SELF_TRAIT_COMPONENTS = [
  { key: '行为习惯', name: '行为习惯', type: 'trait', aliases: ['习惯', '作息'] },
  { key: '喜好', name: '喜好', type: 'trait', aliases: ['爱好', '喜欢'] },
  { key: '经历', name: '经历', type: 'trait', aliases: ['往事'] },
];

const PORTRAIT_ROOT = {
  user: { title: '对你的印象', content: '角色眼里稳定的你：喜好、习惯、性格等。细枝按类挂，不是事件时间线。' },
  self: { title: '自我认知', content: '我怎么看自己：习惯、喜好、经历。细枝按类挂，不是事件时间线。' },
};

function normalizeKind(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (KINDS.includes(t)) return t;
  if (/日常|习惯|作息|运动|通勤/.test(t)) return 'daily';
  if (/感情|关系|恋爱|和好|冷战|表白/.test(t)) return 'affection';
  if (/用户|画像|印象|对方/.test(t)) return 'user';
  if (/自我|自己|self/.test(t)) return 'self';
  if (/事件|event|话题/.test(t)) return 'event';
  return 'event';
}

function kindOf(narrative) {
  return normalizeKind(narrative?.kind || 'event');
}

function isPortraitKind(kind) {
  return kind === 'user' || kind === 'self';
}

function traitComponentsFor(kind) {
  if (kind === 'user') return USER_TRAIT_COMPONENTS.map((c) => ({ ...c, aliases: [...(c.aliases || [])] }));
  if (kind === 'self') return SELF_TRAIT_COMPONENTS.map((c) => ({ ...c, aliases: [...(c.aliases || [])] }));
  return [];
}

function mapToTraitKey(kind, category) {
  const cat = String(category || '').trim();
  const comps = traitComponentsFor(kind);
  if (!comps.length) return '';
  if (comps.some((c) => c.key === cat)) return cat;
  for (const c of comps) {
    if ((c.aliases || []).includes(cat)) return c.key;
  }
  if (kind === 'user') {
    if (/习惯|作息|总是|经常/.test(cat)) return '习惯';
    if (/不善|不会|怕|短板/.test(cat)) return '不擅长';
    if (/性格|脾气|气质/.test(cat)) return '性格';
    if (/人际|朋友|家人|社交/.test(cat)) return '人际关系';
    if (/样子|外貌|穿|发型/.test(cat)) return '样子';
    if (/喜|爱|好|讨厌/.test(cat)) return '喜好';
    return '性格';
  }
  if (kind === 'self') {
    if (/喜|爱|好|讨厌/.test(cat)) return '喜好';
    if (/经历|往事/.test(cat)) return '经历';
    return '行为习惯';
  }
  return comps[0].key;
}

function nowIso() {
  return new Date().toISOString();
}

function daysBetween(isoA, isoB = new Date().toISOString()) {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 999;
  return Math.max(0, (b - a) / 86400000);
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function parseIds(raw) {
  return parseJsonArray(raw).map(Number).filter((n) => Number.isFinite(n));
}

function extractJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fallthrough */ }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

function slugKey(type, name, fallback) {
  if (type === 'core') return 'core';
  const s = String(name || '').replace(/\s+/g, '').slice(0, 16);
  return s || fallback || 'part';
}

function normalizeType(raw) {
  const t = String(raw || '').toLowerCase();
  if (t === 'core' || t === '事件核' || t === '主题' || t === '主干') return 'core';
  if (t === 'person' || t === '人' || t === '人物') return 'person';
  if (t === 'place' || t === '场景' || t === '地点') return 'place';
  if (t === 'trait' || t === '细类' || t === '类目') return 'trait';
  return 'thing';
}

function normalizeComponent(c, i = 0) {
  if (!c || typeof c !== 'object') return null;
  const type = normalizeType(c.type);
  const name = String(c.name || c.title || '').trim().slice(0, 24);
  if (!name) return null;
  const aliases = parseJsonArray(c.aliases).map((x) => String(x).trim()).filter((x) => x && x.length >= 2);
  return {
    key: String(c.key || slugKey(type, name, `c${i}`)).slice(0, 24),
    name,
    type,
    aliases: aliases.slice(0, 6),
  };
}

function parseComponents(raw) {
  return dedupeComponents(parseJsonArray(raw).map(normalizeComponent).filter(Boolean));
}

function isGenericTerm(s) {
  return /^(他|她|它|他们|她们|同事|同学|朋友|那个人|那本书|那个|这个|朋友们|大家|资料|书)$/.test(String(s || '').trim());
}

function dedupeComponents(list) {
  const seenKey = new Set();
  const seenName = new Set();
  const out = [];
  for (const c of list || []) {
    if (!c) continue;
    if (seenKey.has(c.key)) continue;
    const nameKey = `${c.type}:${c.name}`;
    if (seenName.has(nameKey)) continue;
    seenKey.add(c.key);
    seenName.add(nameKey);
    out.push({ ...c, aliases: [...(c.aliases || [])] });
  }
  const names = new Set(out.map((c) => c.name));
  for (const c of out) {
    c.aliases = (c.aliases || []).filter((a) => {
      if (!a || a === c.name) return false;
      if (names.has(a) && a !== c.name) return false;
      if (isGenericTerm(a)) {
        const owners = out.filter((x) => x.name === a || (x.aliases || []).includes(a));
        return owners.length <= 1;
      }
      return true;
    });
  }
  return out;
}

function ensureCoreComponent(components, title, kind = 'event') {
  if (isPortraitKind(kind)) {
    return dedupeComponents(traitComponentsFor(kind));
  }
  const list = dedupeComponents(components);
  if (!list.some((c) => c.type === 'core' || c.key === 'core')) {
    list.unshift({
      key: 'core',
      name: String(title || '这件事').slice(0, 24) || '这件事',
      type: 'core',
      aliases: [],
    });
  } else {
    const core = list.find((c) => c.type === 'core' || c.key === 'core');
    core.key = 'core';
    core.type = 'core';
  }
  return dedupeComponents(list);
}

function setNarrativeKind(narrativeId, kind) {
  const k = normalizeKind(kind);
  try {
    db.prepare('UPDATE memory_narratives SET kind=? WHERE id=?').run(k, narrativeId);
  } catch { /* mid-migration */ }
  return k;
}

function getNarrativeKind(narrative) {
  if (!narrative) return 'event';
  if (narrative.kind) return normalizeKind(narrative.kind);
  try {
    const row = db.prepare('SELECT kind FROM memory_narratives WHERE id=?').get(narrative.id);
    return normalizeKind(row?.kind || 'event');
  } catch {
    return 'event';
  }
}

function emotionChargeOf(frag) {
  let meta = frag?.meta;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  try {
    const { witherChargeForPrimary } = require('./emotion-helper');
    const label = meta?.mood_label || meta?.emotion?.label;
    const fromOfficial = witherChargeForPrimary(label);
    if (fromOfficial > 0) return fromOfficial;
  } catch { /* ignore */ }
  const em = meta?.emotion || {};
  const valence = Math.abs(Number(em.valence) || 0);
  const arousal = Number(em.arousal) || 0;
  const fromMeta = Math.max(0, Math.min(1, valence * 0.55 + arousal * 0.45));
  if (fromMeta > 0) return fromMeta;
  if (String(frag?.category || '') === '重要时刻') return 0.45;
  if (String(frag?.category || '') === '情感状态') return 0.4;
  return 0;
}

function isFallen(row) {
  if (!row) return false;
  if (String(row.fallen_at || '').trim()) return true;
  return row.status === 'closed';
}

function isPinnedCategory(category) {
  return category === '待办' || category === '约定';
}

function listBranches(narrativeId) {
  try {
    return db.prepare(
      `SELECT * FROM memory_narrative_branches WHERE narrative_id=? ORDER BY id ASC`
    ).all(narrativeId);
  } catch {
    return [];
  }
}

function getBranch(id) {
  try {
    return db.prepare('SELECT * FROM memory_narrative_branches WHERE id=?').get(id);
  } catch {
    return null;
  }
}

function getNarrative(id) {
  return db.prepare('SELECT * FROM memory_narratives WHERE id=?').get(id);
}

function saveComponents(narrativeId, components) {
  const row = getNarrative(narrativeId);
  const kind = getNarrativeKind(row);
  const list = ensureCoreComponent(components, row?.title, kind);
  try {
    db.prepare('UPDATE memory_narratives SET components=? WHERE id=?')
      .run(JSON.stringify(list), narrativeId);
  } catch { /* mid-migration */ }
  return list;
}

function upsertBranch(narrativeId, characterId, component) {
  if (!component || component.type === 'core' || component.key === 'core') return null;
  const existing = db.prepare(
    `SELECT * FROM memory_narrative_branches WHERE narrative_id=? AND component_key=?`
  ).get(narrativeId, component.key);
  if (existing) {
    if (component.name && component.name !== existing.name) {
      db.prepare('UPDATE memory_narrative_branches SET name=?, type=? WHERE id=?')
        .run(component.name, component.type || existing.type, existing.id);
    }
    return getBranch(existing.id);
  }
  const ts = nowIso();
  const r = db.prepare(
    `INSERT INTO memory_narrative_branches
      (narrative_id, character_id, component_key, name, type, linked_memory_ids,
       last_touched_at, touch_count, salience, tier, emotion_charge, pinned)
     VALUES (?,?,?,?,?,'[]',?,0,0.65,'hot',0,0)`
  ).run(
    narrativeId,
    characterId,
    component.key,
    component.name,
    component.type || 'thing',
    ts
  );
  return getBranch(r.lastInsertRowid);
}

function syncBranchesFromComponents(narrative) {
  const comps = parseComponents(narrative.components);
  for (const c of comps) {
    if (c.type === 'core') continue;
    upsertBranch(narrative.id, narrative.character_id, c);
  }
}

function collectTreeLinkedIds(narrative) {
  const ids = new Set(parseIds(narrative.linked_memory_ids));
  for (const b of listBranches(narrative.id)) {
    parseIds(b.linked_memory_ids).forEach((id) => ids.add(id));
  }
  return ids;
}

function collectAllTreeLinkedIds(charId) {
  const ids = new Set();
  const narrs = db.prepare('SELECT id, linked_memory_ids FROM memory_narratives WHERE character_id=?').all(charId);
  for (const n of narrs) parseIds(n.linked_memory_ids).forEach((id) => ids.add(id));
  try {
    const branches = db.prepare(
      `SELECT linked_memory_ids FROM memory_narrative_branches WHERE character_id=?`
    ).all(charId);
    for (const b of branches) parseIds(b.linked_memory_ids).forEach((id) => ids.add(id));
  } catch { /* no table yet */ }
  return ids;
}

function applyTouch(kind, id, { charge = 0, pinned = false, weak = false, moodLabel = '' } = {}) {
  const table = kind === 'branch' ? 'memory_narrative_branches' : 'memory_narratives';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!row) return null;
  const ts = nowIso();
  const nextCharge = Math.max(Number(row.emotion_charge) || 0, Math.min(1, Number(charge) || 0));
  let salience = Number(row.salience);
  if (!Number.isFinite(salience)) salience = 0.65;
  let tier = row.tier || 'hot';
  let touchCount = Number(row.touch_count) || 0;
  if (weak) {
    salience = Math.min(1, salience + 0.1);
    if (tier === 'dormant') tier = 'cool';
    else if (tier === 'cool') tier = 'warm';
  } else {
    touchCount += 1;
    salience = Math.min(1, Math.max(salience, 0.75) + 0.15);
    tier = 'hot';
  }
  const pin = pinned || Number(row.pinned) ? 1 : Number(row.pinned) || 0;
  const label = String(moodLabel || row.mood_label || '').slice(0, 24);
  try {
    db.prepare(
      `UPDATE ${table} SET last_touched_at=?, touch_count=?, salience=?, tier=?, emotion_charge=?, pinned=?, mood_label=? WHERE id=?`
    ).run(ts, touchCount, salience, tier, nextCharge, pin, label, id);
  } catch {
    db.prepare(
      `UPDATE ${table} SET last_touched_at=?, touch_count=?, salience=?, tier=?, emotion_charge=?, pinned=? WHERE id=?`
    ).run(ts, touchCount, salience, tier, nextCharge, pin, id);
  }
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
}

function appendTrunkLink(narrativeId, memoryId) {
  const row = getNarrative(narrativeId);
  if (!row || isFallen(row)) return false;
  const ids = parseIds(row.linked_memory_ids);
  if (ids.includes(Number(memoryId))) return false;
  ids.push(Number(memoryId));
  const ts = nowIso();
  db.prepare(
    `UPDATE memory_narratives SET linked_memory_ids=?, links_updated_at=? WHERE id=?`
  ).run(JSON.stringify(ids), ts, narrativeId);
  return true;
}

function appendBranchLink(branchId, memoryId) {
  const row = getBranch(branchId);
  if (!row || isFallen(row)) return false;
  const ids = parseIds(row.linked_memory_ids);
  if (ids.includes(Number(memoryId))) return false;
  ids.push(Number(memoryId));
  db.prepare(
    `UPDATE memory_narrative_branches SET linked_memory_ids=? WHERE id=?`
  ).run(JSON.stringify(ids), branchId);
  return true;
}

function effectiveIdleDays(row) {
  const touched = row.last_touched_at || row.created_at;
  const raw = daysBetween(touched);
  const charge = Math.max(0, Math.min(1, Number(row.emotion_charge) || 0));
  return raw * (1 - 0.4 * charge);
}

function tierFromIdle(kind, days, pinned, narrativeKind = 'event') {
  if (pinned || isPortraitKind(narrativeKind)) {
    if (days < 21) return 'hot';
    if (days < 90) return 'warm';
    return 'warm';
  }
  if (narrativeKind === 'daily') {
    if (kind === 'branch') {
      if (days < 10) return 'hot';
      if (days < 30) return 'warm';
      if (days < 70) return 'cool';
      return 'dormant';
    }
    if (days < 14) return 'hot';
    if (days < 40) return 'warm';
    if (days < 90) return 'cool';
    return 'dormant';
  }
  if (kind === 'branch') {
    if (days < 7) return 'hot';
    if (days < 21) return 'warm';
    if (days < 50) return 'cool';
    return 'dormant';
  }
  if (days < 10) return 'hot';
  if (days < 28) return 'warm';
  if (days < 70) return 'cool';
  return 'dormant';
}

function salienceForTier(tier, pinned) {
  const floor = pinned ? 0.4 : 0.12;
  if (tier === 'hot') return Math.max(0.72, floor);
  if (tier === 'warm') return Math.max(0.5, floor);
  if (tier === 'cool') return Math.max(0.28, floor);
  return Math.max(0.12, floor);
}

function decayRow(kind, row, narrativeKind = 'event') {
  if (!row || isFallen(row)) return;
  const days = effectiveIdleDays(row);
  const pinned = !!Number(row.pinned) || isPortraitKind(narrativeKind);
  const nk = narrativeKind || (kind === 'trunk' ? getNarrativeKind(row) : 'event');
  const tier = tierFromIdle(kind, days, pinned, nk);
  const salience = Math.min(Number(row.salience) || 1, salienceForTier(tier, pinned));
  const table = kind === 'branch' ? 'memory_narrative_branches' : 'memory_narratives';
  if (row.tier === tier && Math.abs((Number(row.salience) || 0) - salience) < 0.02) return;
  db.prepare(`UPDATE ${table} SET tier=?, salience=? WHERE id=?`).run(tier, salience, row.id);
}

function tipFallDays(row) {
  const links = parseIds(row.linked_memory_ids).length;
  return 30 + Math.min(45, Math.max(0, links - 1) * 10);
}

function markFallen(kind, id) {
  const table = kind === 'branch' ? 'memory_narrative_branches' : 'memory_narratives';
  const ts = nowIso();
  try {
    if (kind === 'trunk') {
      db.prepare(`UPDATE memory_narratives SET fallen_at=?, tier='dormant', salience=0.12 WHERE id=?`).run(ts, id);
    } else {
      db.prepare(`UPDATE memory_narrative_branches SET fallen_at=?, tier='dormant', salience=0.12 WHERE id=?`).run(ts, id);
      const b = getBranch(id);
      if (b) {
        const living = listBranches(b.narrative_id).filter((x) => !isFallen(x) && x.id !== id);
        if (!living.length) {
          db.prepare(
            `UPDATE memory_narratives SET last_touched_at=? WHERE id=? AND COALESCE(fallen_at,'')=''`
          ).run(ts, b.narrative_id);
        }
      }
    }
  } catch { /* mid-migration */ }
}

function tryFallRow(kind, row, trunkHasLivingBranches, narrativeKind = 'event') {
  if (!row || isFallen(row) || Number(row.pinned)) return false;
  if (isPortraitKind(narrativeKind)) return false;
  const days = effectiveIdleDays(row);
  const fallDays = narrativeKind === 'daily' ? tipFallDays(row) + 20 : tipFallDays(row);
  if (days < fallDays) return false;
  if (kind === 'trunk' && trunkHasLivingBranches) return false;
  markFallen(kind, row.id);
  return true;
}

function decayAllTrees(charId) {
  const narrs = db.prepare('SELECT * FROM memory_narratives WHERE character_id=?').all(charId);
  let n = 0;
  for (const row of narrs) {
    const nk = getNarrativeKind(row);
    decayRow('trunk', row, nk);
    n += 1;
    const branches = listBranches(row.id);
    for (const b of branches) {
      decayRow('branch', b, nk);
      n += 1;
    }
    let living = 0;
    for (const b of listBranches(row.id)) {
      if (tryFallRow('branch', b, false, nk)) n += 1;
      else if (!isFallen(b)) living += 1;
    }
    const trunk = getNarrative(row.id);
    if (tryFallRow('trunk', trunk, living > 0, nk)) n += 1;
  }
  return n;
}

function decayAllCharacters() {
  const chars = db.prepare('SELECT id FROM characters').all();
  let n = 0;
  for (const c of chars) n += decayAllTrees(c.id);
  return n;
}

function lexicalHits(text, components) {
  const body = String(text || '');
  if (!body) return [];
  const terms = [];
  for (const c of components) {
    for (const raw of [c.name, ...(c.aliases || [])]) {
      const term = String(raw || '').trim();
      if (term.length < 2) continue;
      terms.push({
        key: c.key,
        term,
        generic: isGenericTerm(term),
        len: term.length,
      });
    }
  }
  terms.sort((a, b) => b.len - a.len);
  const usedSpans = [];
  const specific = new Set();
  const genericKeys = [];
  const overlaps = (start, end) => usedSpans.some(([s, e]) => start < e && end > s);
  for (const t of terms) {
    let from = 0;
    while (from < body.length) {
      const i = body.indexOf(t.term, from);
      if (i < 0) break;
      const end = i + t.term.length;
      if (!overlaps(i, end)) {
        if (t.generic) genericKeys.push(t.key);
        else {
          specific.add(t.key);
          usedSpans.push([i, end]);
        }
      }
      from = i + Math.max(1, t.term.length);
    }
  }
  if (specific.size) return [...specific];
  const uniq = [...new Set(genericKeys)];
  return uniq.length === 1 ? uniq : [];
}

function routeDecision(hitKeys, components) {
  const hits = [...new Set(hitKeys || [])];
  if (!hits.length) return { target: 'none', keys: [] };
  const byKey = new Map(components.map((c) => [c.key, c]));
  const hitCore = hits.some((k) => k === 'core' || byKey.get(k)?.type === 'core');
  if (hitCore || hits.length >= 2) return { target: 'trunk', keys: hits };
  return { target: 'branch', key: hits[0], keys: hits };
}

async function llmHits(settings, frag, narrative, components) {
  const list = components.map((c) => `${c.key}|${c.type}|${c.name}${c.aliases?.length ? `(${c.aliases.join('/')})` : ''}`).join('\n');
  try {
    const raw = await callChatAPIComplete(
      settings,
      `判断这段记忆碎片命中了记忆点「${narrative.title || '未命名'}」的哪些组成部分。
只输出 JSON：{"hits":["组件key"...]}
规则：
- 只选清单里的 key；没有则 {"hits":[]}
- 聊的是主题本身的进展（报名/刷题/结果等）→ 含 core
- 只聊某一个零件的近况 → 只返回那一个 key；两个同类的人/物都点名了才返回两个
- 泛称（同事/那本书/他）对不上专名时不要猜
- 碰巧提到、不是这棵树的组成部分 → 空数组
- 禁止因为「有点像」就硬选`,
      `【组件清单】\n${list}\n\n【碎片】\n${frag.content}`,
      'memory'
    );
    const o = extractJson(raw);
    const allowed = new Set(components.map((c) => c.key));
    const hits = parseJsonArray(o?.hits).map(String).filter((k) => allowed.has(k));
    return hits;
  } catch (e) {
    console.warn('[memory-tree] llmHits', e.message);
    return [];
  }
}

async function extractComponents(settings, char, title, content, frags = [], kind = 'event') {
  const nk = normalizeKind(kind);
  if (isPortraitKind(nk)) return traitComponentsFor(nk);
  const evidence = (frags || []).map((f) => `- ${f.content}`).join('\n').slice(0, 2400);
  try {
    const raw = await callChatAPIComplete(
      settings,
      `从记忆点「${title || '未命名'}」抽出组成部分清单。
必须包含一项 type=core（主题本身/事件核）。其余为人/物/场景。
只输出 JSON：
{"components":[{"key":"core","name":"短名","type":"core|person|thing|place","aliases":["别称"]}]}
纪律：
- 只写证据里出现的零件；不要脑补路人；core 的 name 用主题短名
- 同类必须拆开：两个不同的人不要合成「同事」；两本不同的书不要合成「资料」
- 每人/每物单独一项，name 用可区分的专名；key 用专名（core 固定 core）
- aliases 只能是该零件自己的别称，禁止用能套到另一个零件上的泛称（同事/那本书/他）
角色是${char?.name || ''}。`,
      `【正文】\n${content || '（空）'}\n\n【证据碎片】\n${evidence || '（无）'}`,
      'memory'
    );
    const o = extractJson(raw);
    const comps = parseJsonArray(o?.components).map(normalizeComponent).filter(Boolean);
    return ensureCoreComponent(comps, title, nk);
  } catch (e) {
    console.warn('[memory-tree] extract', e.message);
    return ensureCoreComponent([], title, nk);
  }
}

async function ensureNarrativeTree(narrative, settings, char) {
  if (!narrative?.id) return narrative;
  const kind = getNarrativeKind(narrative);
  let comps = parseComponents(narrative.components);
  if (isPortraitKind(kind)) {
    comps = traitComponentsFor(kind);
    comps = saveComponents(narrative.id, comps);
    syncBranchesFromComponents({ ...getNarrative(narrative.id), components: JSON.stringify(comps) });
    return getNarrative(narrative.id);
  }
  if (!comps.length) {
    const linked = parseIds(narrative.linked_memory_ids);
    const frags = linked.length
      ? db.prepare(
        `SELECT id, content, category FROM memories WHERE id IN (${linked.map(() => '?').join(',')})`
      ).all(...linked)
      : [];
    comps = await extractComponents(settings, char, narrative.title, narrative.content, frags, kind);
    comps = saveComponents(narrative.id, comps);
    narrative = getNarrative(narrative.id);
  } else {
    comps = ensureCoreComponent(comps, narrative.title, kind);
  }
  syncBranchesFromComponents({ ...narrative, components: JSON.stringify(comps) });
  return getNarrative(narrative.id);
}

/** 树上还活着的枝干（active 且没落叶） */
function listLivingNarratives(charId) {
  return db.prepare(
    `SELECT * FROM memory_narratives WHERE character_id=? AND status='active' ORDER BY id DESC`
  ).all(charId).filter((n) => !isFallen(n));
}

function listNarrativesByKind(charId, kind) {
  const k = normalizeKind(kind);
  try {
    return db.prepare(
      `SELECT * FROM memory_narratives WHERE character_id=? AND status='active' AND COALESCE(kind,'event')=? ORDER BY id DESC`
    ).all(charId, k).filter((n) => !isFallen(n));
  } catch {
    return listLivingNarratives(charId).filter((n) => getNarrativeKind(n) === k);
  }
}

/**
 * 用户/自我：每人每类一棵粗枝根；细枝是画像类目。
 */
function ensurePortraitRoot(charId, kind) {
  const k = normalizeKind(kind);
  if (!isPortraitKind(k)) return null;
  const existing = listNarrativesByKind(charId, k)[0];
  if (existing) {
    const comps = traitComponentsFor(k);
    saveComponents(existing.id, comps);
    syncBranchesFromComponents({ ...existing, components: JSON.stringify(comps) });
    try {
      db.prepare(`UPDATE memory_narratives SET pinned=1 WHERE id=?`).run(existing.id);
    } catch { /* ignore */ }
    return getNarrative(existing.id);
  }
  const meta = PORTRAIT_ROOT[k];
  const ts = nowIso();
  let id;
  try {
    const r = db.prepare(
      `INSERT INTO memory_narratives
        (character_id, title, content, linked_memory_ids, status, kind, links_updated_at, content_updated_at,
         last_touched_at, touch_count, salience, tier, pinned)
       VALUES (?,?,?,'[]','active',?,?,?,?,1,0.85,'hot',1)`
    ).run(charId, meta.title, meta.content, k, ts, ts, ts);
    id = r.lastInsertRowid;
  } catch {
    const r = db.prepare(
      `INSERT INTO memory_narratives
        (character_id, title, content, linked_memory_ids, status, links_updated_at, content_updated_at)
       VALUES (?,?,?,'[]','active',?,?)`
    ).run(charId, meta.title, meta.content, ts, ts);
    id = r.lastInsertRowid;
    setNarrativeKind(id, k);
    try {
      db.prepare(
        `UPDATE memory_narratives SET last_touched_at=?, touch_count=1, salience=0.85, tier='hot', pinned=1 WHERE id=?`
      ).run(ts, id);
    } catch { /* ignore */ }
  }
  const comps = traitComponentsFor(k);
  saveComponents(id, comps);
  syncBranchesFromComponents({ ...getNarrative(id), components: JSON.stringify(comps) });
  return getNarrative(id);
}

/**
 * 建一根新枝干，组成部分由上游（睡前整理）直接给出。
 */
function createNarrativeWithComponents(charId, { title, content, linkedIds = [], components = [], kind = 'event' }) {
  const ts = nowIso();
  const nk = normalizeKind(kind);
  let id;
  try {
    const r = db.prepare(
      `INSERT INTO memory_narratives
        (character_id, title, content, linked_memory_ids, status, kind, links_updated_at, content_updated_at,
         last_touched_at, touch_count, salience, tier, pinned)
       VALUES (?,?,?,?, 'active', ?, ?, ?, ?, 1, 0.8, 'hot', ?)`
    ).run(
      charId,
      String(title || '记忆点').slice(0, 40),
      String(content || '').trim().slice(0, 1000),
      JSON.stringify(linkedIds.map(Number)),
      nk,
      ts,
      ts,
      ts,
      isPortraitKind(nk) ? 1 : 0
    );
    id = r.lastInsertRowid;
  } catch {
    const r = db.prepare(
      `INSERT INTO memory_narratives
        (character_id, title, content, linked_memory_ids, status, links_updated_at, content_updated_at)
       VALUES (?,?,?,?, 'active', ?, ?)`
    ).run(
      charId,
      String(title || '记忆点').slice(0, 40),
      String(content || '').trim().slice(0, 1000),
      JSON.stringify(linkedIds.map(Number)),
      ts,
      ts
    );
    id = r.lastInsertRowid;
    setNarrativeKind(id, nk);
  }
  const saved = saveComponents(id, isPortraitKind(nk) ? traitComponentsFor(nk) : components);
  syncBranchesFromComponents({ ...getNarrative(id), components: JSON.stringify(saved) });
  return id;
}

function loadFrag(id) {
  return db.prepare(
    `SELECT id, content, category, weight, meta, embedding FROM memories WHERE id=?`
  ).get(id);
}

/** 碎片该进哪类粗枝（启发式；总结侧也可直接写 meta.branch_kind） */
function classifyFragKind(frag, charName = '', userName = '旅人') {
  let meta = frag?.meta;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  if (meta?.branch_kind) return normalizeKind(meta.branch_kind);

  const cat = String(frag?.category || '');
  const text = String(frag?.content || '');
  const cn = String(charName || '');
  const un = String(userName || '旅人');

  if (/吵架|冷战|和好|分手|表白|告白|吃醋|复合|暧昧升温|关系变/.test(text) || (cat === '情感状态' && /我们|你我|感情|关系/.test(text))) {
    return 'affection';
  }
  if (cat === '偏好与习惯') {
    if (cn && (text.includes(cn) || /^我/.test(text)) && !text.includes(un)) return 'self';
    if (/跑步|健身|运动|瑜伽|游泳|通勤|早起|熬夜|每[天日周]|经常去|又去/.test(text)) return 'daily';
    return 'user';
  }
  if (cat === '日常点滴' && /跑步|健身|运动|瑜伽|游泳|通勤|早起|又去|照常/.test(text)) return 'daily';
  if (cat === '重要时刻' && /表白|吵架|和好|分手/.test(text)) return 'affection';
  return 'event';
}

function guessDailyTitle(text) {
  const t = String(text || '');
  if (/跑步|慢跑/.test(t)) return '运动·跑步';
  if (/健身|力量|器械/.test(t)) return '运动·健身';
  if (/瑜伽/.test(t)) return '运动·瑜伽';
  if (/游泳/.test(t)) return '运动·游泳';
  if (/通勤|上班路上/.test(t)) return '日常·通勤';
  if (/早起/.test(t)) return '作息·早起';
  if (/熬夜/.test(t)) return '作息·熬夜';
  if (/运动/.test(t)) return '日常·运动';
  return String(t).replace(/\s+/g, '').slice(0, 8) || '日常习惯';
}

function findOrCreateDailyNarrative(charId, frag) {
  const titleHint = guessDailyTitle(frag.content);
  const dailies = listNarrativesByKind(charId, 'daily');
  for (const n of dailies) {
    const title = String(n.title || '');
    if (title && (frag.content.includes(title) || title.includes(titleHint.slice(0, 4)) || titleHint.includes(title.slice(0, 4)))) {
      return n;
    }
    const comps = parseComponents(n.components);
    if (lexicalHits(frag.content, comps).length) return n;
  }
  const id = createNarrativeWithComponents(charId, {
    title: titleHint,
    content: `日常习惯「${titleHint}」：反复出现、无强剧情弧。新进展挂在主干上。`,
    linkedIds: [],
    components: [{ key: 'core', name: titleHint, type: 'core', aliases: [] }],
    kind: 'daily',
  });
  return getNarrative(id);
}

function findOrCreateAffectionNarrative(charId, frag) {
  const affections = listNarrativesByKind(charId, 'affection');
  const corpus = require('./memory-brain-helper').getCharCorpus(charId);
  if (affections.length) {
    const scores = scoreTextsAgainst(
      frag.content,
      affections.map((n) => ({ content: n.content || n.title, embedding: n.embedding })),
      { queryEmb: frag.embedding, corpus }
    );
    let best = -1;
    let bestI = -1;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] > best) { best = scores[i]; bestI = i; }
    }
    if (best >= 0.42 && bestI >= 0) return affections[bestI];
  }
  let title = '感情起伏';
  if (/表白|告白/.test(frag.content)) title = '表白';
  else if (/和好|复合/.test(frag.content)) title = '和好';
  else if (/吵架|冷战|分手/.test(frag.content)) title = '冷战与争吵';
  const id = createNarrativeWithComponents(charId, {
    title,
    content: String(frag.content || '').slice(0, 400),
    linkedIds: [],
    components: [{ key: 'core', name: title, type: 'core', aliases: [] }],
    kind: 'affection',
  });
  return getNarrative(id);
}

/**
 * 画像/自我认知写入后：挂到用户枝或自我枝对应细类，并回温。
 */
function touchPortraitCategory(charId, kind, category, { charge = 0.2, moodLabel = '' } = {}) {
  const k = normalizeKind(kind);
  if (!isPortraitKind(k)) return null;
  const root = ensurePortraitRoot(charId, k);
  if (!root) return null;
  const key = mapToTraitKey(k, category);
  const comps = traitComponentsFor(k);
  const comp = comps.find((c) => c.key === key) || comps[0];
  const branch = listBranches(root.id).find((b) => b.component_key === comp.key)
    || upsertBranch(root.id, charId, comp);
  if (branch) applyTouch('branch', branch.id, { charge, pinned: true, weak: false, moodLabel });
  applyTouch('trunk', root.id, { charge: charge * 0.5, pinned: true, weak: true, moodLabel });
  return { narrativeId: root.id, branchId: branch?.id, key: comp.key };
}

/** 从画像卡同步回温用户粗枝（不复制正文，卡仍是内容源） */
function syncPortraitFromCards(charId, kind = 'user') {
  const k = normalizeKind(kind);
  if (!isPortraitKind(k)) return 0;
  const root = ensurePortraitRoot(charId, k);
  if (!root) return 0;
  let n = 0;
  if (k === 'user') {
    const rows = db.prepare(
      `SELECT category, COUNT(*) AS c FROM char_impressions WHERE character_id=? GROUP BY category`
    ).all(charId);
    for (const row of rows) {
      touchPortraitCategory(charId, 'user', row.category, { charge: Math.min(0.5, 0.15 + (row.c || 1) * 0.05) });
      n += 1;
    }
  } else {
    const rows = db.prepare(
      `SELECT category, COUNT(*) AS c FROM char_self_views WHERE character_id=? GROUP BY category`
    ).all(charId);
    for (const row of rows) {
      touchPortraitCategory(charId, 'self', row.category, { charge: Math.min(0.5, 0.15 + (row.c || 1) * 0.05) });
      n += 1;
    }
  }
  return n;
}

async function routeFragmentToTrees(charId, frag, { settings, actives } = {}) {
  if (!frag?.id) return { linked: false };
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  const settingsRow = settings || {};
  let userName = settingsRow.username;
  if (!userName) {
    try {
      userName = db.prepare(`SELECT value FROM settings WHERE key='username'`).get()?.value;
    } catch { /* ignore */ }
  }
  userName = userName || '旅人';
  const wantKind = classifyFragKind(frag, char?.name, userName);

  const charge = emotionChargeOf(frag);
  const pinned = isPinnedCategory(frag.category);
  let moodLabel = '';
  try {
    let meta = frag.meta;
    if (typeof meta === 'string') meta = JSON.parse(meta);
    moodLabel = String(meta?.mood_label || meta?.emotion?.label || '');
  } catch { /* ignore */ }
  const already = collectAllTreeLinkedIds(charId);
  if (already.has(frag.id)) return { linked: false, reason: 'already' };

  // 用户/自我：稳定 trait 挂粗枝细类，不进事件树
  if (isPortraitKind(wantKind)) {
    let traitCat = frag.category;
    if (wantKind === 'user') {
      traitCat = /习惯|作息|总是|经常/.test(frag.content) ? '习惯'
        : (/喜欢|讨厌|爱吃|不吃|爱/.test(frag.content) ? '喜好'
          : (/不善|不会|怕/.test(frag.content) ? '不擅长'
            : (/朋友|家人|同事|人际/.test(frag.content) ? '人际关系'
              : (/穿|头发|样子|长得/.test(frag.content) ? '样子' : '性格'))));
    } else {
      traitCat = /喜|爱|讨厌/.test(frag.content) ? '喜好' : (/经历|曾经|那年/.test(frag.content) ? '经历' : '行为习惯');
    }
    const root = ensurePortraitRoot(charId, wantKind);
    const key = mapToTraitKey(wantKind, traitCat);
    const comps = traitComponentsFor(wantKind);
    const comp = comps.find((c) => c.key === key) || comps[0];
    const branch = listBranches(root.id).find((b) => b.component_key === comp.key)
      || upsertBranch(root.id, charId, comp);
    if (!branch || isFallen(branch)) return { linked: false };
    const ok = appendBranchLink(branch.id, frag.id);
    if (ok) {
      applyTouch('branch', branch.id, { charge, pinned: true, weak: false, moodLabel });
      applyTouch('trunk', root.id, { charge: charge * 0.4, pinned: true, weak: true, moodLabel });
    }
    return { linked: ok, target: 'branch', narrativeId: root.id, branchId: branch.id, kind: wantKind, keys: [key] };
  }

  let trees = (actives || db.prepare(
    `SELECT * FROM memory_narratives WHERE character_id=? AND status='active' ORDER BY id DESC`
  ).all(charId)).filter((n) => !isFallen(n) && !isPortraitKind(getNarrativeKind(n)));

  // 日常：优先匹配日常枝；没有就新建主题枝
  if (wantKind === 'daily') {
    const dailies = trees.filter((n) => getNarrativeKind(n) === 'daily');
    let target = null;
    if (dailies.length) {
      const corpus = require('./memory-brain-helper').getCharCorpus(charId);
      const scores = scoreTextsAgainst(
        frag.content,
        dailies.map((n) => ({ content: n.content || n.title, embedding: n.embedding })),
        { queryEmb: frag.embedding, corpus }
      );
      let best = -1;
      let bestI = -1;
      for (let i = 0; i < scores.length; i++) {
        if (scores[i] > best) { best = scores[i]; bestI = i; }
      }
      if (best >= 0.38 && bestI >= 0) target = dailies[bestI];
      else {
        for (const n of dailies) {
          if (lexicalHits(frag.content, parseComponents(n.components)).length) { target = n; break; }
        }
      }
    }
    if (!target) target = findOrCreateDailyNarrative(charId, frag);
    const n = await ensureNarrativeTree(target, settings, char);
    const ok = appendTrunkLink(n.id, frag.id);
    if (ok) applyTouch('trunk', n.id, { charge, pinned, weak: false, moodLabel });
    return { linked: ok, target: 'trunk', narrativeId: n.id, kind: 'daily', keys: ['core'] };
  }

  // 感情：优先感情枝；对不上就新建
  if (wantKind === 'affection') {
    let target = null;
    const affections = trees.filter((n) => getNarrativeKind(n) === 'affection');
    if (affections.length) {
      const corpus = require('./memory-brain-helper').getCharCorpus(charId);
      const scores = scoreTextsAgainst(
        frag.content,
        affections.map((n) => ({ content: n.content || n.title, embedding: n.embedding })),
        { queryEmb: frag.embedding, corpus }
      );
      let best = -1;
      let bestI = -1;
      for (let i = 0; i < scores.length; i++) {
        if (scores[i] > best) { best = scores[i]; bestI = i; }
      }
      if (best >= 0.42 && bestI >= 0) target = affections[bestI];
    }
    if (!target) target = findOrCreateAffectionNarrative(charId, frag);
    return attachFragmentToNarrative(charId, target.id, frag, { settings });
  }

  // 事件：只在事件枝里按组件命中挂
  trees = trees.filter((n) => getNarrativeKind(n) === 'event');
  if (!trees.length) return { linked: false };

  const corpus = require('./memory-brain-helper').getCharCorpus(charId);
  const living = trees;
  const relScores = scoreTextsAgainst(
    frag.content,
    living.map((n) => ({ content: n.content || n.title, embedding: n.embedding })),
    { queryEmb: frag.embedding, corpus }
  );

  const candidates = [];
  for (let i = 0; i < living.length; i++) {
    const rel = relScores[i] || 0;
    const n = await ensureNarrativeTree(living[i], settings, char);
    const comps = parseComponents(n.components);
    if (!comps.length) continue;
    let hits = lexicalHits(frag.content, comps);
    if (!hits.length) {
      if (rel < RELATED_COS) continue;
      hits = await llmHits(settings, frag, n, comps);
    }
    const decision = routeDecision(hits, comps);
    if (decision.target === 'none') continue;
    candidates.push({ n, comps, decision, score: Math.max(hits.length * 0.2, rel), hits });
  }
  if (!candidates.length) return { linked: false };

  candidates.sort((a, b) => b.hits.length - a.hits.length || b.score - a.score);
  const pick = candidates[0];
  const { n, comps, decision } = pick;

  if (decision.target === 'trunk') {
    const ok = appendTrunkLink(n.id, frag.id);
    if (ok) {
      applyTouch('trunk', n.id, { charge, pinned, weak: false, moodLabel });
      for (const key of decision.keys) {
        if (key === 'core') continue;
        const branch = listBranches(n.id).find((b) => b.component_key === key)
          || upsertBranch(n.id, charId, comps.find((c) => c.key === key));
        if (branch && !isFallen(branch)) applyTouch('branch', branch.id, { charge, pinned: false, weak: true, moodLabel });
      }
    }
    return { linked: ok, target: 'trunk', narrativeId: n.id, kind: 'event', keys: decision.keys };
  }

  const comp = comps.find((c) => c.key === decision.key);
  const branch = listBranches(n.id).find((b) => b.component_key === decision.key)
    || upsertBranch(n.id, charId, comp);
  if (!branch || isFallen(branch)) return { linked: false };
  const ok = appendBranchLink(branch.id, frag.id);
  if (ok) applyTouch('branch', branch.id, { charge, pinned, weak: false, moodLabel });
  return { linked: ok, target: 'branch', narrativeId: n.id, branchId: branch.id, kind: 'event', keys: decision.keys };
}

/**
 * 把碎片挂到指定的那棵树上：树由上游（按话题挂枝）选定，这里只决定落主干还是落细枝。
 * 和 routeFragmentToTrees 的区别是不再重挑树，也不因为组件没命中就放弃——
 * 上游已经判定这条属于这棵树，字面对不上就落主干。
 */
async function attachFragmentToNarrative(charId, narrativeId, frag, { settings } = {}) {
  if (!frag?.id) return { linked: false };
  if (collectAllTreeLinkedIds(charId).has(frag.id)) return { linked: false, reason: 'already' };
  let n = getNarrative(narrativeId);
  if (!n || isFallen(n)) return { linked: false, reason: 'fallen' };
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  n = await ensureNarrativeTree(n, settings, char);
  const comps = parseComponents(n.components);

  const charge = emotionChargeOf(frag);
  const pinned = isPinnedCategory(frag.category);
  let moodLabel = '';
  try {
    let meta = frag.meta;
    if (typeof meta === 'string') meta = JSON.parse(meta);
    moodLabel = String(meta?.mood_label || meta?.emotion?.label || '');
  } catch { /* ignore */ }

  const hits = comps.length ? lexicalHits(frag.content, comps) : [];
  const decision = hits.length ? routeDecision(hits, comps) : { target: 'trunk', keys: [] };

  if (decision.target === 'branch') {
    const comp = comps.find((c) => c.key === decision.key);
    const branch = listBranches(n.id).find((b) => b.component_key === decision.key)
      || upsertBranch(n.id, charId, comp);
    if (branch && !isFallen(branch)) {
      const ok = appendBranchLink(branch.id, frag.id);
      if (ok) applyTouch('branch', branch.id, { charge, pinned, weak: false, moodLabel });
      return { linked: ok, target: 'branch', narrativeId: n.id, branchId: branch.id };
    }
  }

  const ok = appendTrunkLink(n.id, frag.id);
  if (ok) {
    applyTouch('trunk', n.id, { charge, pinned, weak: false, moodLabel });
    for (const key of decision.keys || []) {
      if (key === 'core') continue;
      const branch = listBranches(n.id).find((b) => b.component_key === key)
        || upsertBranch(n.id, charId, comps.find((c) => c.key === key));
      if (branch && !isFallen(branch)) applyTouch('branch', branch.id, { charge, pinned: false, weak: true, moodLabel });
    }
  }
  return { linked: ok, target: 'trunk', narrativeId: n.id };
}

async function routeMemoryIds(charId, ids, settings) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  let linked = 0;
  const actives = db.prepare(
    `SELECT * FROM memory_narratives WHERE character_id=? AND status='active' ORDER BY id DESC`
  ).all(charId).filter((n) => !isFallen(n));
  for (const id of list) {
    const frag = loadFrag(id);
    if (!frag) continue;
    const r = await routeFragmentToTrees(charId, frag, { settings, actives });
    if (r.linked) linked += 1;
  }
  return { linked };
}

function contextHitsBranch(ctx, branch) {
  const text = String(ctx || '');
  if (!text || !branch) return false;
  if (branch.name && text.includes(branch.name)) return true;
  return false;
}

function contextHitsTitle(ctx, narrative) {
  const text = String(ctx || '');
  const title = String(narrative?.title || '');
  return !!(title && title.length >= 2 && text.includes(title));
}

function injectionAllowed(narrative, score, ctx) {
  if (isFallen(narrative)) return false;
  const nk = getNarrativeKind(narrative);
  if (isPortraitKind(nk)) {
    // 用户/自我粗枝：常驻偏多，凉了也比事件更容易带
    const tier = narrative.tier || 'hot';
    if (tier === 'hot' || tier === 'warm') return true;
    return score >= 0.28 || contextHitsTitle(ctx, narrative);
  }
  if (nk === 'daily') {
    const tier = narrative.tier || 'hot';
    if (tier === 'hot' || tier === 'warm') return score >= 0.42 || contextHitsTitle(ctx, narrative);
    if (tier === 'cool') return score >= COOL_MIN_SCORE || contextHitsTitle(ctx, narrative);
    return score >= STRONG_TITLE_SCORE || contextHitsTitle(ctx, narrative);
  }
  const tier = narrative.tier || 'hot';
  if (narrative.status === 'closed') return score >= STRONG_TITLE_SCORE || contextHitsTitle(ctx, narrative);
  if (tier === 'hot' || tier === 'warm') return score >= 0.45 || contextHitsTitle(ctx, narrative);
  if (tier === 'cool') return score >= COOL_MIN_SCORE || contextHitsTitle(ctx, narrative);
  return score >= STRONG_TITLE_SCORE || contextHitsTitle(ctx, narrative);
}

function formatTreeInjection(narratives, ctx = '') {
  if (!narratives?.length) return '';
  const blocks = [];
  for (const n of narratives) {
    const tier = n.tier || 'hot';
    const nk = getNarrativeKind(n);
    const kindZh = KIND_LABEL[nk] || '事件';
    const body = String(n.content || '').slice(0, 800);
    const dirty = n._dirty ? '（待消化）' : '';
    let block = `【${kindZh}枝·${n.title || '未命名'}·${tierLabel(tier)}${dirty}】\n${body}`;
    const branches = listBranches(n.id).filter((b) => {
      if (isFallen(b)) return false;
      if (isPortraitKind(nk)) return b.tier === 'hot' || b.tier === 'warm' || contextHitsBranch(ctx, b);
      if (b.tier === 'hot' || b.tier === 'warm') return true;
      return contextHitsBranch(ctx, b);
    });
    for (const b of branches) {
      if (isPortraitKind(nk)) {
        // 画像/自我：细枝名即类目；内容仍以独立卡注入为主，这里只点一句「有这条线」
        block += `\n【${kindZh}细枝·${b.name}·${tierLabel(b.tier)}】`;
        continue;
      }
      const ids = parseIds(b.linked_memory_ids).slice(-2);
      if (!ids.length) continue;
      const frags = db.prepare(
        `SELECT content FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids);
      const bits = frags.map((f) => String(f.content || '').slice(0, 80)).filter(Boolean);
      if (bits.length) {
        block += `\n【细枝·${b.name}·${tierLabel(b.tier)}】${bits.join(' / ')}`;
      }
    }
    blocks.push(block);
  }
  if (!blocks.length) return '';
  return `【你理过的事】只有跟眼前这句是同一件才连得上；沾点边不算。对不上就当没想起，也不要把以前的情节说成今天正在发生。这是你自己的记忆，不是资料。当作本来就知道，不要说「忽然想起」：\n${blocks.join('\n\n')}`;
}

function tierLabel(tier) {
  if (tier === 'warm') return '温';
  if (tier === 'cool') return '凉';
  if (tier === 'dormant') return '休眠';
  return '热';
}

function sproutNode(kind, id, extra = {}) {
  try {
    if (kind === 'trunk') {
      db.prepare(`UPDATE memory_narratives SET fallen_at='', status='active' WHERE id=?`).run(id);
    } else {
      db.prepare(`UPDATE memory_narrative_branches SET fallen_at='' WHERE id=?`).run(id);
    }
  } catch { /* ignore */ }
  return applyTouch(kind, id, extra);
}

function maybeReviveFallen(charId, ctx) {
  const text = String(ctx || '').trim();
  if (!text || !charId) return 0;
  let n = 0;
  try {
    const fallenNarrs = db.prepare(
      `SELECT * FROM memory_narratives WHERE character_id=? AND (COALESCE(fallen_at,'')!='' OR status='closed')`
    ).all(charId);
    for (const row of fallenNarrs) {
      if (!contextHitsTitle(ctx, row)) continue;
      sproutNode('trunk', row.id);
      n += 1;
    }
    const fallenBranches = db.prepare(
      `SELECT b.* FROM memory_narrative_branches b
       WHERE b.character_id=? AND COALESCE(b.fallen_at,'')!=''`
    ).all(charId);
    for (const b of fallenBranches) {
      if (!contextHitsBranch(ctx, b)) continue;
      sproutNode('branch', b.id);
      const parent = getNarrative(b.narrative_id);
      if (parent && isFallen(parent)) sproutNode('trunk', parent.id, { weak: true });
      n += 1;
    }
  } catch { /* mid-migration */ }
  return n;
}

function deleteBranch(id) {
  db.prepare('DELETE FROM memory_narrative_branches WHERE id=?').run(id);
  return true;
}

function deleteBranchesOf(narrativeId) {
  try {
    db.prepare('DELETE FROM memory_narrative_branches WHERE narrative_id=?').run(narrativeId);
  } catch { /* ignore */ }
}

/**
 * 修剪用：收走这根主枝上所有碎片 id，再删掉空壳（枝+干）。
 * 用户/自我粗枝根不拆。
 */
function harvestAndRemoveNarrative(narrativeId) {
  const n = getNarrative(narrativeId);
  if (!n) return { ids: [], title: '', kind: 'event', skipped: 'missing' };
  const kind = getNarrativeKind(n);
  if (isPortraitKind(kind)) {
    return { ids: [], title: n.title || '', kind, skipped: 'portrait' };
  }
  const ids = [...collectTreeLinkedIds(n)];
  deleteBranchesOf(narrativeId);
  db.prepare('DELETE FROM memory_narratives WHERE id=?').run(narrativeId);
  return { ids, title: n.title || '未命名', kind, skipped: '' };
}

function treeSummary(narrative) {
  const branches = listBranches(narrative.id);
  const trunkN = parseIds(narrative.linked_memory_ids).length;
  const branchN = branches.reduce((s, b) => s + parseIds(b.linked_memory_ids).length, 0);
  const kind = getNarrativeKind(narrative);
  return {
    kind,
    kindLabel: KIND_LABEL[kind] || '事件',
    tier: narrative.tier || 'hot',
    salience: Number(narrative.salience) || 0.7,
    emotionCharge: Number(narrative.emotion_charge) || 0,
    components: parseComponents(narrative.components),
    branchCount: branches.length,
    trunkStageCount: trunkN,
    branchStageCount: branchN,
    stageCount: trunkN + branchN,
  };
}

function canonicalNarrativePair(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x < y ? [x, y] : [y, x];
}

function upsertNarrativeLink(characterId, fromId, toId, type = 'related', score = 0) {
  if (!characterId || !fromId || !toId || fromId === toId) return false;
  const [a, b] = canonicalNarrativePair(fromId, toId);
  const t = String(type || 'related').slice(0, 24);
  const sc = Number(score) || 0;
  try {
    const existing = db.prepare(
      `SELECT id, score FROM memory_narrative_links WHERE from_id=? AND to_id=? AND type=?`
    ).get(a, b, t);
    if (existing) {
      if (sc > (Number(existing.score) || 0)) {
        db.prepare(`UPDATE memory_narrative_links SET score=?, character_id=? WHERE id=?`)
          .run(sc, characterId, existing.id);
      }
      return true;
    }
    db.prepare(
      `INSERT INTO memory_narrative_links (character_id, from_id, to_id, type, score) VALUES (?,?,?,?,?)`
    ).run(characterId, a, b, t, sc);
    return true;
  } catch (e) {
    console.warn('[memory-tree] narrative link', e.message);
    return false;
  }
}

function listNarrativeLinks(characterId, { livingIds = null } = {}) {
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT from_id, to_id, type, score FROM memory_narrative_links WHERE character_id=?`
    ).all(characterId);
  } catch {
    return [];
  }
  const allow = livingIds ? new Set(livingIds.map(Number)) : null;
  return rows
    .filter((r) => !allow || (allow.has(Number(r.from_id)) && allow.has(Number(r.to_id))))
    .map((r) => ({
      from: Number(r.from_id),
      to: Number(r.to_id),
      type: r.type || 'related',
      score: Number(r.score) || 0,
    }));
}

function listRelatedNarrativeIds(narrativeId, characterId) {
  const id = Number(narrativeId);
  try {
    const rows = db.prepare(
      `SELECT from_id, to_id, type, score FROM memory_narrative_links
       WHERE character_id=? AND (from_id=? OR to_id=?)`
    ).all(characterId, id, id);
    return rows.map((r) => ({
      id: Number(r.from_id) === id ? Number(r.to_id) : Number(r.from_id),
      type: r.type || 'related',
      score: Number(r.score) || 0,
    }));
  } catch {
    return [];
  }
}

/**
 * 根据标题/正文相关度给同角色活着的话题补 related / continues 边。
 * sequel_of 写成 continues。
 */
function rebuildNarrativeLinks(characterId, { minScore = RELATED_COS } = {}) {
  if (!characterId) return { links: 0, narratives: 0 };
  const living = listLivingNarratives(characterId);
  let added = 0;
  for (const n of living) {
    const sequelOf = Number(n.sequel_of) || 0;
    if (sequelOf && sequelOf !== Number(n.id)) {
      if (upsertNarrativeLink(characterId, n.id, sequelOf, 'continues', 0.95)) added += 1;
    }
  }
  if (living.length >= 2) {
    for (let i = 0; i < living.length; i++) {
      const others = living.filter((_, j) => j !== i);
      if (!others.length) continue;
      const query = `${living[i].title || ''}\n${String(living[i].content || living[i].stance || '').slice(0, 240)}`;
      const corpus = others.map((n) => `${n.title || ''}\n${String(n.content || n.stance || '').slice(0, 240)}`);
      let scores = [];
      try {
        scores = scoreTextsAgainst(query, corpus, {});
      } catch {
        scores = others.map(() => 0);
      }
      others.forEach((other, k) => {
        const score = Number(scores[k]) || 0;
        if (score < minScore) return;
        if (upsertNarrativeLink(characterId, living[i].id, other.id, 'related', score)) added += 1;
      });
    }
  }
  return { links: added, narratives: living.length };
}

module.exports = {
  KINDS,
  KIND_LABEL,
  USER_TRAIT_COMPONENTS,
  SELF_TRAIT_COMPONENTS,
  parseIds,
  parseComponents,
  ensureCoreComponent,
  emotionChargeOf,
  listBranches,
  getBranch,
  listLivingNarratives,
  listNarrativesByKind,
  createNarrativeWithComponents,
  isGenericTerm,
  collectTreeLinkedIds,
  collectAllTreeLinkedIds,
  appendTrunkLink,
  appendBranchLink,
  applyTouch,
  saveComponents,
  upsertBranch,
  syncBranchesFromComponents,
  extractComponents,
  ensureNarrativeTree,
  ensurePortraitRoot,
  touchPortraitCategory,
  syncPortraitFromCards,
  classifyFragKind,
  routeFragmentToTrees,
  attachFragmentToNarrative,
  routeMemoryIds,
  loadFrag,
  decayAllTrees,
  decayAllCharacters,
  injectionAllowed,
  formatTreeInjection,
  tierLabel,
  deleteBranchesOf,
  deleteBranch,
  harvestAndRemoveNarrative,
  treeSummary,
  lexicalHits,
  routeDecision,
  isFallen,
  maybeReviveFallen,
  sproutNode,
  normalizeKind,
  getNarrativeKind,
  setNarrativeKind,
  kindOf,
  isPortraitKind,
  upsertNarrativeLink,
  listNarrativeLinks,
  listRelatedNarrativeIds,
  rebuildNarrativeLinks,
};

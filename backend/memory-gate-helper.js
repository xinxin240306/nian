/**
 * 记忆门控：双阈值、规则优先、明说预算/冷却、忘了吗补救、调试日志。
 * 严的是「明说」，松的是「潜意识认得」。
 */
'use strict';

const DEFAULTS = {
  MEMORY_BLOCK_ENABLED: true,
  MAX_IMPRESSIONS_PER_TURN: 2,
  MAX_EVENTS_PER_TURN: 1,
  /** 进潜意识（可影响语气） */
  T_retrieve: 0.42,
  /** 允许明说 */
  T_speak: 0.6,
  /** 上轮明说过的同一簇：相关度稍低也续聊 */
  T_continue: 0.32,
  RECALL_COOLDOWN_TURNS: 30,
  RECALL_BUDGET_WINDOW: 10,
  RECALL_BUDGET: 1,
  IMPRESSION_CANDIDATE_MAX: 6,
};

const EXPLICIT_RECALL_RE = /还记得|记不记得|记得吗|你记得|记不记|想起过|那天我们|上次我们|以前我们|一起.{0,12}(过|的时候|那)|回忆/;
const FORGOT_RE = /你忘了|都忘了|忘了吗|是不是忘了|不记得了吗|记不得了吗|怎么不记得|你不记得/;

/** charId → { speakTurns: [{ turn, keys }], turn } */
const _state = new Map();

function getConfig(settings = {}) {
  const num = (key, fallback) => {
    const n = parseFloat(settings?.[key]);
    return Number.isFinite(n) ? n : fallback;
  };
  const flag = (key, fallback) => {
    const v = settings?.[key];
    if (v === true || v === '1' || v === 'true') return true;
    if (v === false || v === '0' || v === 'false') return false;
    return fallback;
  };
  return {
    MEMORY_BLOCK_ENABLED: flag('memory_block_enabled', DEFAULTS.MEMORY_BLOCK_ENABLED),
    MAX_IMPRESSIONS_PER_TURN: Math.max(0, Math.round(num('max_impressions_per_turn', DEFAULTS.MAX_IMPRESSIONS_PER_TURN))),
    MAX_EVENTS_PER_TURN: Math.max(0, Math.round(num('max_events_per_turn', DEFAULTS.MAX_EVENTS_PER_TURN))),
    T_retrieve: num('memory_t_retrieve', DEFAULTS.T_retrieve),
    T_speak: num('memory_t_speak', DEFAULTS.T_speak),
    T_continue: num('memory_t_continue', DEFAULTS.T_continue),
    RECALL_COOLDOWN_TURNS: Math.max(1, Math.round(num('recall_cooldown_turns', DEFAULTS.RECALL_COOLDOWN_TURNS))),
    RECALL_BUDGET_WINDOW: Math.max(1, Math.round(num('recall_budget_window', DEFAULTS.RECALL_BUDGET_WINDOW))),
    RECALL_BUDGET: Math.max(0, Math.round(num('recall_budget', DEFAULTS.RECALL_BUDGET))),
    IMPRESSION_CANDIDATE_MAX: Math.max(1, Math.round(num('impression_candidate_max', DEFAULTS.IMPRESSION_CANDIDATE_MAX))),
  };
}

function charState(charId) {
  const id = Number(charId) || 0;
  let s = _state.get(id);
  if (!s) {
    s = { turn: 0, speakTurns: [], lastForcedKeys: [], lastClusterIds: [], lastClusterCues: [] };
    _state.set(id, s);
  }
  return s;
}

function beginTurn(charId) {
  const s = charState(charId);
  s.turn += 1;
  const cut = s.turn - 80;
  if (cut > 0) s.speakTurns = s.speakTurns.filter((x) => x.turn >= cut);
  return s.turn;
}

function isExplicitRecall(text) {
  return EXPLICIT_RECALL_RE.test(String(text || ''));
}

function isForgotCue(text) {
  return FORGOT_RE.test(String(text || ''));
}

/** 硬旁路：点名回忆 / 忘了吗 → 允许明说，不受预算限制 */
function hardSpeakBypass(userMessage) {
  const t = String(userMessage || '');
  if (!t.trim()) return false;
  if (isForgotCue(t) || isExplicitRecall(t)) return true;
  try {
    if (require('./lived-day-helper').wantsRecall?.(t)) return true;
  } catch { /* ignore */ }
  return false;
}

function relevanceOf(candidate) {
  const v = Number(candidate?.vecScore);
  if (Number.isFinite(v) && v > 0) return v;
  const s = Number(candidate?.score);
  if (Number.isFinite(s)) {
    // collectFlashCandidates 的 score 常 >1；压到大致 0~1
    if (s >= 1.2) return Math.min(0.95, 0.45 + s * 0.08);
    return Math.max(0, Math.min(1, s));
  }
  return 0;
}

function modeFromRelevance(rel, cfg, { keywordHit = false } = {}) {
  if (rel >= cfg.T_speak) return 'usable_now';
  // 只擦到一个词：心里记得、对方说起来接得上，但不往外带
  if (keywordHit || rel >= cfg.T_retrieve) return 'background_only';
  return 'skip';
}

function speakCountInWindow(charId, cfg) {
  const s = charState(charId);
  const from = s.turn - cfg.RECALL_BUDGET_WINDOW + 1;
  return s.speakTurns.filter((x) => x.turn >= from && (x.keys || []).length).length;
}

function inCooldown(charId, key, cfg) {
  const s = charState(charId);
  const from = s.turn - cfg.RECALL_COOLDOWN_TURNS + 1;
  return s.speakTurns.some((x) => x.turn >= from && (x.keys || []).includes(String(key)));
}

function recordSpoken(charId, keys, extra = {}) {
  const list = [...new Set((keys || []).map(String).filter(Boolean))];
  if (!list.length) return;
  const s = charState(charId);
  const clusterIds = [...new Set((extra.clusterIds || []).map(String).filter(Boolean))];
  const cues = [...new Set((extra.cues || []).map((x) => String(x || '').trim()).filter((x) => x.length >= 2))].slice(0, 12);
  s.speakTurns.push({ turn: s.turn, keys: list, clusterIds });
  s.lastForcedKeys = list;
  if (clusterIds.length) s.lastClusterIds = clusterIds;
  if (cues.length) s.lastClusterCues = cues;
}

function lastSpokenClusters(charId) {
  const s = charState(charId);
  if (s.lastClusterIds?.length) return new Set(s.lastClusterIds.map(String));
  for (let i = (s.speakTurns || []).length - 1; i >= 0; i--) {
    const ids = s.speakTurns[i].clusterIds || [];
    if (ids.length) return new Set(ids.map(String));
  }
  return new Set();
}

function lastClusterCues(charId) {
  return [...(charState(charId).lastClusterCues || [])];
}

function isEventMemoryKey(key) {
  return /^(mem:|ep:|narr:|evt:)/.test(String(key));
}

function clusterIdOfKey(key, clusterByKey) {
  const k = String(key);
  if (clusterByKey instanceof Map && clusterByKey.has(k)) return String(clusterByKey.get(k));
  if (clusterByKey && typeof clusterByKey === 'object' && !Array.isArray(clusterByKey) && clusterByKey[k]) {
    return String(clusterByKey[k]);
  }
  if (k.startsWith('narr:') || k.startsWith('ep:') || k.startsWith('evt:')) return k;
  return k;
}

function isContinuingCluster(charId, clusterId, rel, cfg) {
  if (!clusterId) return false;
  if (!lastSpokenClusters(charId).has(String(clusterId))) return false;
  const floor = Number(cfg?.T_continue);
  return rel >= (Number.isFinite(floor) ? floor : DEFAULTS.T_continue);
}

/**
 * 规则优先定档；理解层只改模糊带。
 * @returns {{ modeById: Map<string,string>, forceSpeak: boolean, reasons: Object }}
 */
function ruleAssignModes({
  charId,
  userMessage,
  flashCandidates = [],
  narratives = [],
  impressions = [],
  cfg,
  clusterByKey = null,
} = {}) {
  const modeById = new Map();
  const reasons = {};
  const forceSpeak = hardSpeakBypass(userMessage);
  const budgetExhausted = !forceSpeak && speakCountInWindow(charId, cfg) >= cfg.RECALL_BUDGET;

  const tag = (id, mode, reason) => {
    const key = String(id);
    const prev = modeById.get(key);
    const rank = { skip: 0, background_only: 1, usable_now: 2 };
    if (!prev || (rank[mode] || 0) >= (rank[prev] || 0)) {
      modeById.set(key, mode);
      reasons[key] = reason;
    }
  };

  const clusterOf = (key, row) => row?.clusterId || clusterIdOfKey(key, clusterByKey);

  for (const c of flashCandidates || []) {
    const key = c.key || `mem:${c.id}`;
    const rel = relevanceOf(c);
    const kw = !!(c.kwHit || c.keywordHit);
    const cid = clusterOf(key, c);
    const sameCluster = lastSpokenClusters(charId).has(String(cid));
    const sameTopic = sameCluster && rel >= (Number.isFinite(Number(cfg?.T_continue)) ? cfg.T_continue : 0.32);
    if (forceSpeak) {
      tag(key, rel >= cfg.T_retrieve || kw || isForgotCue(userMessage) ? 'usable_now' : 'background_only', 'hard_bypass');
      continue;
    }
    if (sameTopic) {
      tag(key, 'usable_now', 'same_topic');
      continue;
    }
    if (sameCluster && !kw) {
      tag(key, rel >= cfg.T_retrieve ? 'background_only' : 'skip', 'topic_shift');
      continue;
    }
    if (inCooldown(charId, key, cfg)) {
      tag(key, kw || rel >= cfg.T_retrieve ? 'background_only' : 'skip', 'cooldown');
      continue;
    }
    let mode = modeFromRelevance(rel, cfg, { keywordHit: kw });
    if (mode === 'usable_now' && budgetExhausted) mode = 'background_only';
    tag(key, mode, budgetExhausted && mode === 'background_only' ? 'budget' : 'rule_score');
  }

  for (const n of narratives || []) {
    const key = `narr:${n.id}`;
    const rel = Number(n.score) || relevanceOf(n);
    const cid = clusterOf(key, n) || key;
    const sameCluster = lastSpokenClusters(charId).has(String(cid));
    const sameTopic = sameCluster && rel >= (Number.isFinite(Number(cfg?.T_continue)) ? cfg.T_continue : 0.32);
    if (forceSpeak) {
      tag(key, 'usable_now', 'hard_bypass');
      continue;
    }
    if (sameTopic) {
      tag(key, 'usable_now', 'same_topic');
      continue;
    }
    if (sameCluster && !n.kwHit) {
      tag(key, rel >= cfg.T_retrieve ? 'background_only' : 'skip', 'topic_shift');
      continue;
    }
    if (inCooldown(charId, key, cfg)) {
      tag(key, n.kwHit || rel >= cfg.T_retrieve ? 'background_only' : 'skip', 'cooldown');
      continue;
    }
    let mode = modeFromRelevance(rel, cfg, { keywordHit: !!n.kwHit });
    if (mode === 'usable_now' && budgetExhausted) mode = 'background_only';
    tag(key, mode, 'rule_score');
  }

  for (const p of impressions || []) {
    const key = String(p.id);
    const standing = !!(p.standing || p.cat === '性格');
    const rel = relevanceOf(p);
    const kw = p.directHit != null ? !!p.directHit : !!(p.keywordHit || (p.score && p.score >= 5));
    if (forceSpeak && (kw || rel >= cfg.T_retrieve)) {
      tag(key, standing ? 'background_only' : 'usable_now', 'hard_bypass');
      continue;
    }
    if (standing) {
      tag(key, 'background_only', 'standing');
      continue;
    }
    if (inCooldown(charId, key, cfg)) {
      tag(key, 'skip', 'cooldown');
      continue;
    }
    // 话题印象：对方这句亲口说到这件事（kw=直接命中）才拿出来；只是聊到同一类话题不算
    let mode = kw ? 'usable_now' : modeFromRelevance(rel, cfg);
    if (mode === 'background_only') mode = 'skip';
    if (mode === 'usable_now' && budgetExhausted && !kw) mode = 'skip';
    tag(key, mode, 'rule_score');
  }

  return { modeById, forceSpeak, budgetExhausted, reasons };
}

/** 理解层结果合并：规则已定 usable_now/skip 的硬旁路不降级；对方词命中的 usable_now 不得被模型 skip 掉 */
function mergeModelModes(modeById, understanding, { forceSpeak = false, protectKeys = null } = {}) {
  const out = new Map(modeById);
  const protect = protectKeys instanceof Set ? protectKeys : null;
  const apply = (rows, idOf) => {
    for (const row of rows || []) {
      const id = String(idOf(row));
      if (!id || id === 'undefined') continue;
      const ruled = out.get(id);
      let mode = normalizeMode(row.mode, row.usable);
      if (forceSpeak && ruled === 'usable_now') {
        out.set(id, 'usable_now');
        continue;
      }
      // 模型不得把 standing/background 升成明说，除非规则已允许
      if (mode === 'usable_now' && ruled === 'background_only') mode = 'background_only';
      if (mode === 'usable_now' && ruled === 'skip') mode = 'skip';
      // 对方这轮点到的旧事：模型不得 skip 掉规则的 usable_now
      if (!forceSpeak && mode === 'skip' && ruled === 'usable_now') {
        out.set(id, protect && protect.has(id) ? 'usable_now' : 'background_only');
        continue;
      }
      if (!forceSpeak && mode === 'background_only' && ruled === 'usable_now') {
        out.set(id, protect && protect.has(id) ? 'usable_now' : 'background_only');
        continue;
      }
      if (ruled == null) out.set(id, mode);
    }
  };
  apply(understanding?.impression_filter, (r) => r.id || r.impression_id);
  apply(understanding?.memory_filter, (r) => r.id || r.memory_id);
  return out;
}

function normalizeMode(mode, usable) {
  const m = String(mode || '').trim();
  if (m === 'usable_now' || m === 'background_only' || m === 'skip') return m;
  if (usable === false || usable === 0 || usable === 'false') return 'skip';
  if (usable === true || usable === 1 || usable === 'true') return 'background_only';
  return 'skip';
}

function setsFromModes(modeById) {
  const speak = new Set();
  const background = new Set();
  for (const [id, mode] of modeById || []) {
    if (mode === 'usable_now') speak.add(String(id));
    else if (mode === 'background_only') background.add(String(id));
  }
  return { speak, background };
}

function capSpeakKeys(speakSet, max) {
  if (!max || speakSet.size <= max) return speakSet;
  return new Set([...speakSet].slice(0, max));
}

/** 明说按「簇」封顶：同一事件的 gist + 细节共用 1 次预算 */
function capSpeakClusters(speakSet, clusterByKey, max) {
  if (!max || !speakSet || speakSet.size <= max) return speakSet;
  const eventKeys = [...speakSet].filter(isEventMemoryKey);
  const otherKeys = [...speakSet].filter((k) => !isEventMemoryKey(k));
  if (eventKeys.length <= max) return speakSet;
  const grouped = new Map();
  const order = [];
  for (const key of eventKeys) {
    const cid = clusterIdOfKey(key, clusterByKey);
    if (!grouped.has(cid)) {
      grouped.set(cid, []);
      order.push(cid);
    }
    grouped.get(cid).push(key);
  }
  if (order.length <= max) return new Set([...speakSet]);
  const keep = new Set(otherKeys);
  for (const cid of order.slice(0, max)) {
    for (const key of grouped.get(cid) || []) keep.add(key);
  }
  return keep;
}

const MEMORY_USAGE_HINT = `这些是你心里本来就有的，不是要交代的事。对方说到了，你自然接得上；对方没往那儿说，就让它们待在心里——你眼下更在意的是对方现在这句话、现在这个人。不必为了显得记得而提起，也不会说「你说过…」；没记着的事就是不知道，不往里补。`;

function logTurnDebug(payload) {
  try {
    const line = {
      t: new Date().toISOString(),
      charId: payload.charId,
      turn: payload.turn,
      forceSpeak: !!payload.forceSpeak,
      budgetExhausted: !!payload.budgetExhausted,
      skippedModel: !!payload.skippedModel,
      candidates: payload.candidates || {},
      modes: payload.modes || {},
      injected: {
        speak: payload.speakKeys || [],
        background: payload.backgroundKeys || [],
        impression: payload.impressionPreview || '',
        memoryPreview: payload.memoryPreview || '',
        understandingPreview: payload.understandingPreview || '',
      },
    };
    console.log('[memory-gate]', JSON.stringify(line));
  } catch (e) {
    console.warn('[memory-gate] log', e.message);
  }
}

module.exports = {
  DEFAULTS,
  getConfig,
  beginTurn,
  isExplicitRecall,
  isForgotCue,
  hardSpeakBypass,
  relevanceOf,
  ruleAssignModes,
  mergeModelModes,
  normalizeMode,
  setsFromModes,
  capSpeakKeys,
  capSpeakClusters,
  isEventMemoryKey,
  clusterIdOfKey,
  lastSpokenClusters,
  lastClusterCues,
  isContinuingCluster,
  recordSpoken,
  speakCountInWindow,
  MEMORY_USAGE_HINT,
  logTurnDebug,
  _stateForTest: _state,
};

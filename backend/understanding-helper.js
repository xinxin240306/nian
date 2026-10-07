/**
 * 每轮理解层：规则优先定档 → 模糊带才调模型 → 写入 memory/impression/understanding 块。
 * 失败/超时不挡回复；默认倾向 skip / background_only，不默认明说。
 */
'use strict';

const { callChatAPIComplete } = require('./api-helper');
const perception = require('./perception-helper');
const gate = require('./memory-gate-helper');

const STRATEGIES = ['直接追问', '侧面关心', '正常回应', '不动声色观察'];
const CONTRADICTIONS = ['反话', '嘴硬', '无'];
const TRENDS = ['首次出现', '持续累积', '缓解中', '无异常'];
const PORTRAIT_FITS = ['符合', '违背', '无'];
const MODES = ['usable_now', 'background_only', 'skip'];
const IMPRESSION_SEND_MAX = 8;

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function parseJsonObject(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* slice */ }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

function asBool(v, fallback = true) {
  if (v === true || v === false) return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return fallback;
}

function pickEnum(v, allowed, fallback) {
  const s = String(v || '').trim();
  return allowed.includes(s) ? s : fallback;
}

function indexByKey(items, keyOf) {
  const map = new Map();
  for (const it of items || []) {
    const k = keyOf(it);
    if (k != null && k !== '') map.set(String(k), it);
  }
  return map;
}

function rowMode(hit, fallbackMode) {
  if (hit && hit.mode != null) return gate.normalizeMode(hit.mode, hit.usable);
  if (hit && hit.usable != null) return gate.normalizeMode(null, hit.usable);
  return fallbackMode || 'skip';
}

function mergeFilter(rawList, candidates, keyOf, fallbackModeOf) {
  const byId = indexByKey(rawList, (x) => x.impression_id || x.memory_id || x.id);
  return (candidates || []).map((c) => {
    const key = String(keyOf(c));
    const hit = byId.get(key);
    const fallback = typeof fallbackModeOf === 'function' ? fallbackModeOf(c) : 'skip';
    const mode = rowMode(hit, fallback);
    return {
      id: key,
      mode,
      usable: mode !== 'skip',
      reason: hit ? String(hit.reason || '').slice(0, 80) : '',
      block: c.block || hit?.block || '',
    };
  });
}

function failOpenFilters(flashCandidates, narratives, impressions) {
  return {
    impression_filter: (impressions || []).map((p) => {
      const standing = !!(p.standing || p.cat === '性格');
      const mode = standing ? 'background_only' : 'skip';
      return { id: String(p.id), mode, usable: mode !== 'skip', reason: 'fail_open', block: '印象' };
    }),
    memory_filter: [
      ...(flashCandidates || []).map((c) => ({
        id: c.key,
        mode: 'skip',
        usable: false,
        reason: 'fail_open',
        block: '脑海',
      })),
      ...(narratives || []).map((n) => ({
        id: `narr:${n.id}`,
        mode: 'skip',
        usable: false,
        reason: 'fail_open',
        block: '记忆树',
      })),
    ],
  };
}

function normalizeUnderstandingPayload(raw, {
  flashCandidates = [],
  narratives = [],
  impressions = [],
  perceptionSnap = {},
} = {}) {
  const parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const opened = failOpenFilters(flashCandidates, narratives, impressions);
  const impression_filter = parsed.impression_filter
    ? mergeFilter(parsed.impression_filter, impressions, (p) => p.id, (p) => (
      (p.standing || p.cat === '性格') ? 'background_only' : 'skip'
    ))
    : opened.impression_filter;
  const memoryCandidates = [
    ...(flashCandidates || []).map((c) => ({ ...c, impression_id: c.key, memory_id: c.key })),
    ...(narratives || []).map((n) => ({
      id: n.id,
      key: `narr:${n.id}`,
      memory_id: `narr:${n.id}`,
      block: '记忆树',
    })),
  ];
  const memory_filter = parsed.memory_filter
    ? mergeFilter(parsed.memory_filter, memoryCandidates, (c) => c.key || c.memory_id || c.id, () => 'skip')
    : opened.memory_filter;

  const score = parsed.daily_anomaly_score != null
    ? clamp(parsed.daily_anomaly_score, 0, 100)
    : clamp(perceptionSnap.daily_anomaly_score, 0, 100);
  const trend = pickEnum(parsed.anomaly_trend, TRENDS, perceptionSnap.anomaly_trend || '无异常');

  return {
    has_contradiction: asBool(parsed.has_contradiction, false),
    contradiction_type: pickEnum(parsed.contradiction_type, CONTRADICTIONS, '无'),
    inferred_emotion: String(parsed.inferred_emotion || '').trim().slice(0, 40),
    confidence: clamp(parsed.confidence, 0, 100) || 50,
    daily_anomaly_score: score,
    anomaly_trend: trend,
    suggested_strategy: pickEnum(parsed.suggested_strategy, STRATEGIES, '正常回应'),
    portrait_fit: pickEnum(parsed.portrait_fit, PORTRAIT_FITS, '无'),
    portrait_note: String(parsed.portrait_note || '').trim().slice(0, 40),
    allow_speak_memory: asBool(parsed.allow_speak_memory, false),
    impression_filter,
    memory_filter,
  };
}

function usableKeySet(filterList, { modes = ['usable_now', 'background_only'] } = {}) {
  const allow = new Set(modes);
  const set = new Set();
  for (const row of filterList || []) {
    if (!row) continue;
    const mode = row.mode || gate.normalizeMode(null, row.usable);
    if (allow.has(mode)) set.add(String(row.id));
  }
  return set;
}

function formatUnderstandingPromptBlock(u) {
  if (!u) return '';
  const lines = [];
  const ctype = u.contradiction_type && u.contradiction_type !== '无' ? u.contradiction_type : '';
  if (u.has_contradiction && ctype) {
    lines.push(`对方这轮更像在${ctype}。你听得出来，不必拆穿。`);
  } else if (u.has_contradiction) {
    lines.push('对方这轮可能口是心非。你听得出来，不必拆穿。');
  }
  if (u.inferred_emotion) {
    lines.push(`你觉得对方这会儿是${u.inferred_emotion}。`);
  }
  if (u.portrait_fit === '符合') {
    lines.push(`这轮很像你认识的对方${u.portrait_note ? `（${u.portrait_note}）` : ''}。你本来就知道，不必当成新发现。`);
  } else if (u.portrait_fit === '违背') {
    lines.push(`这轮不太像你熟悉的对方${u.portrait_note ? `（${u.portrait_note}）` : ''}。你自己留意着就行。`);
  }
  if (u.anomaly_trend && u.anomaly_trend !== '无异常' && ((u.daily_anomaly_score || 0) >= 35 || u.portrait_fit === '违背')) {
    lines.push(`今天对方有点不对劲（${u.anomaly_trend}）。你心里有数即可，不必开口点破。`);
  }
  if (!lines.length) return '';
  return `【你这边的感觉】这是你已经看出来的，不是要执行的策略。消化之后再说话，不要向对方分析，也不要复述这段。\n${lines.map((l) => `· ${l}`).join('\n')}`;
}

function formatRecentTurns(history, userMessage, { userName = '对方', charName = '我', maxTurns = 5 } = {}) {
  const rows = (history || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content);
  const slice = rows.slice(-(maxTurns * 2));
  const lines = slice.map((m) => {
    const name = m.role === 'user' ? userName : charName;
    return `${name}：${String(m.content).replace(/\s+/g, ' ').slice(0, 120)}`;
  });
  const last = String(userMessage || '').trim();
  if (last && !lines.length) lines.push(`${userName}：${last.slice(0, 120)}`);
  return lines.join('\n');
}

function snapshotMood(char) {
  try {
    const cron = require('./cron');
    const es = cron.getDecayedEmotionState(char) || {};
    const mood = es.mood || {};
    return {
      valence: Number(mood.valence) || 0,
      note: String(mood.note || '').slice(0, 40),
      phase: es.phase || '',
    };
  } catch {
    return { valence: 0, note: '', phase: '' };
  }
}

function snapshotAffection(char) {
  try {
    const aff = require('./affection-helper').getBrainAffection(char.id);
    if (!aff) return '';
    const stage = aff.stage || aff.kind || '';
    const bond = aff.kind || '';
    return [bond, stage].filter(Boolean).join('/');
  } catch {
    return '';
  }
}

/** 无 L2/L3 候选且无反话/异常线索 → 跳过理解模型 */
function shouldSkipUnderstanding({ flashCandidates, narratives, impressions, userMessage, perceptionSnap }) {
  const topical = (impressions || []).filter((p) => !p.standing);
  const hasCand = (flashCandidates || []).length || (narratives || []).length || topical.length;
  if (hasCand) return false;
  if (perception.hasUnderstandingCue(userMessage, { score: perceptionSnap.daily_anomaly_score })) return false;
  if ((perceptionSnap.daily_anomaly_score || 0) >= 40) return false;
  return true;
}

/** 规则已全部定死（无模糊带）时也可跳过模型 */
function shouldSkipModelAfterRules(modeById, { hasPerceptionCue = false } = {}) {
  if (hasPerceptionCue) return false;
  if (!modeById || !modeById.size) return true;
  // 模糊带：规则给出 usable_now 但仍想让模型否掉文不对题的；或 background 需确认
  // 仅当全部 skip、或仅有 standing background 且无事件候选时跳过
  let hasEvent = false;
  let hasFuzzySpeak = false;
  for (const [id, mode] of modeById) {
    if (String(id).startsWith('narr:') || String(id).startsWith('mem:') || String(id).startsWith('ep:')) {
      hasEvent = true;
      if (mode === 'usable_now') hasFuzzySpeak = true;
    } else if (mode === 'usable_now') {
      hasFuzzySpeak = true;
    }
  }
  if (hasFuzzySpeak) return false;
  if (hasEvent) return false;
  return true;
}

function timeoutMsOf(settings) {
  const n = parseInt(settings?.understanding_timeout_ms, 10);
  if (Number.isFinite(n) && n >= 800) return Math.min(8000, n);
  return 3500;
}

function buildUnderstandingUserPayload({
  userMessage,
  recentText,
  impressions,
  flashCandidates,
  narratives,
  mood,
  affection,
  perceptionSnap,
  ruleModes,
}) {
  const modeHint = (id) => {
    const m = ruleModes?.get(String(id));
    return m ? ` rule=${m}` : '';
  };
  const impLines = (impressions || []).map((p, i) => {
    const facts = Array.isArray(p.facts) ? p.facts.join('、') : String(p.content || '');
    return `${i + 1}. [id=${p.id}] 【${p.cat || p.category || ''}】${String(facts).slice(0, 40)}${modeHint(p.id)}`;
  });
  const memLines = (flashCandidates || []).map((c, i) => (
    `${i + 1}. [id=${c.key}] ${String(c.text || '').slice(0, 60)}${modeHint(c.key)}`
  ));
  const narrLines = (narratives || []).map((n, i) => (
    `${i + 1}. [id=narr:${n.id}] ${String(n.title || '未命名').slice(0, 24)}｜${String(n.stance || n.content || '').replace(/\s+/g, ' ').slice(0, 40)}${modeHint(`narr:${n.id}`)}`
  ));
  return [
    `【本轮用户话】${String(userMessage || '').slice(0, 200)}`,
    `【近窗】\n${recentText || '（无）'}`,
    `【此刻心情】valence=${mood.valence}${mood.note ? `，${mood.note}` : ''}${mood.phase ? `，phase=${mood.phase}` : ''}`,
    affection ? `【感情线】${affection}` : '',
    `【今日感知】异常分=${perceptionSnap.daily_anomaly_score || 0}，趋势=${perceptionSnap.anomaly_trend || '无异常'}`,
    impLines.length ? `【印象候选】\n${impLines.join('\n')}` : '【印象候选】无',
    memLines.length ? `【脑海候选】\n${memLines.join('\n')}` : '【脑海候选】无',
    narrLines.length ? `【记忆树候选】\n${narrLines.join('\n')}` : '【记忆树候选】无',
  ].filter(Boolean).join('\n');
}

const UNDERSTANDING_SYS = `你是角色内心的理解层，只输出 JSON，不要 markdown。判断「现在用这条合不合适」，不是再检索。
每条候选必须给出 mode，只能是：usable_now | background_only | skip。
含义：
- usable_now：当前语境可明说/轻带一句
- background_only：只影响语气态度，禁止点名翻出
- skip：本轮不用
规则：
- 没把握时：性格/情绪反应类 → background_only；与本轮无关的事件 → skip。
- 印象：性格/情绪反应用来读懂这轮 → background_only；喜好/样子等跟当前话题是同一点 → usable_now。
- 生理/体能类观察不要用在情绪疲惫语境（如「心累」对不上「走两步就喘」）→ skip。
- 脑海/记忆树：对方本轮话明显点到旧事（同一件事/关键词重合）→ 必须 usable_now，禁止 skip；擦边相关 → background_only；完全无关 → skip。
- 候选上的 rule= 是规则层初判。对方词命中且 rule=usable_now 时不要降到 skip；硬旁路（对方点名记得/说你忘了）不要降到 skip。
- allow_speak_memory：本轮是否允许角色明说任何旧事；存在 usable_now 事件时为 true。
- 反话/嘴硬：字面没事、挺好、晚安但语气冷/敷衍时标 contradiction。
- suggested_strategy 只能是：直接追问 | 侧面关心 | 正常回应 | 不动声色观察。
- contradiction_type 只能是：反话 | 嘴硬 | 无。
- portrait_fit 只能是：符合 | 违背 | 无。
- anomaly_trend 只能是：首次出现 | 持续累积 | 缓解中 | 无异常。
- impression_id / memory_id 必须用候选里的 id（记忆树用 narr:数字）。
输出：
{"has_contradiction":false,"contradiction_type":"无","inferred_emotion":"","confidence":0,"daily_anomaly_score":0,"anomaly_trend":"无异常","suggested_strategy":"正常回应","portrait_fit":"无","portrait_note":"","allow_speak_memory":false,"impression_filter":[{"impression_id":"1","mode":"skip","reason":""}],"memory_filter":[{"memory_id":"mem:1","block":"脑海","mode":"skip","reason":""}]}`;

async function runUnderstandingModel(settings, userPayload) {
  const ms = timeoutMsOf(settings);
  const call = callChatAPIComplete(
    settings,
    UNDERSTANDING_SYS,
    userPayload,
    'memory',
    [],
    { timeout: ms, temperature: 0.2, maxTokens: 420, noContinue: true }
  );
  const raced = await Promise.race([
    call.then((raw) => ({ ok: true, raw })).catch((e) => ({ ok: false, error: e })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), ms)),
  ]);
  if (!raced?.ok) return null;
  return parseJsonObject(raced.raw);
}

function skipLayer(promptOpts) {
  return !!(promptOpts.isDream || promptOpts.forGame || promptOpts.forTheater
    || promptOpts.forDiaryPeek || promptOpts.forDiary);
}

function prependLived(char, promptOpts, memoryBody) {
  const parts = [];
  try {
    const lived = require('./lived-day-helper').formatForPrompt(
      char,
      promptOpts.userMessage || promptOpts.userText || promptOpts.contextText || ''
    );
    if (lived) parts.push(lived);
  } catch (e) {
    console.warn('[lived-day] understanding', e.message);
  }
  if (memoryBody) parts.push(memoryBody);
  return parts.filter(Boolean).join('\n\n');
}

function attachVecScores(flashCandidates) {
  return (flashCandidates || []).map((c) => {
    if (c.vecScore != null || c.kwHit != null) return c;
    return { ...c, vecScore: gate.relevanceOf(c), kwHit: !!c.kwHit };
  });
}

function cueBits(text) {
  return String(text || '')
    .split(/[，。！？、；：\s\n\r\t\/\|·…—\-~～「」『』（）()\[\]【】]{1,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 12)
    .slice(0, 8);
}

function expandWinningClusterSpeak(speak, merged, prepared, clusterByKey) {
  const eventKeys = [...speak].filter((k) => gate.isEventMemoryKey(k));
  if (!eventKeys.length) return speak;
  const cid = gate.clusterIdOfKey(eventKeys[0], clusterByKey);
  if (String(cid).startsWith('narr:')) speak.add(cid);
  const members = (prepared.flashCandidates || []).filter((c) => {
    const key = c.key || `mem:${c.id}`;
    return (c.clusterId || gate.clusterIdOfKey(key, clusterByKey)) === cid;
  });
  for (const c of members) {
    if (c.kind === 'episode' && c.key) speak.add(c.key);
  }
  const detailMax = require('./memory-brain-helper').CLUSTER_DETAIL_MAX || 2;
  const mems = members
    .filter((c) => c.kind === 'memory')
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  let n = 0;
  for (const m of mems) {
    if (n >= detailMax) break;
    if (!m.key) continue;
    speak.add(m.key);
    merged.set(m.key, 'usable_now');
    n += 1;
  }
  for (const k of [...speak]) {
    if (gate.isEventMemoryKey(k) && gate.clusterIdOfKey(k, clusterByKey) !== cid) speak.delete(k);
  }
  return speak;
}

/**
 * 检索候选 → 规则门控 →（可选）理解层 → 写入 promptOpts 块
 */
async function applyBrainUnderstanding(char, settings, promptOpts = {}) {
  if (!char?.id) return promptOpts;
  const brain = require('./memory-brain-helper');
  const contextText = String(promptOpts.contextText || '').trim()
    || [...(promptOpts.recentHistory || []).slice(-24).map((m) => String(m?.content || '')),
      String(promptOpts.userMessage || promptOpts.userText || '')]
      .filter(Boolean).join('\n');
  const userMessage = promptOpts.userMessage || promptOpts.userText || '';
  const cfg = gate.getConfig(settings || {});
  const turn = gate.beginTurn(char.id);

  // TEMP：对照实验，聊天不注入脑海/画像/挂载
  let forceSkip = false;
  try { forceSkip = !!require('./lived-day-helper').shouldSkipChatMemoryCarry(); } catch { /* ignore */ }
  if (forceSkip) {
    promptOpts.memoryBlock = '';
    promptOpts.impressionBlock = '';
    promptOpts.understandingBlock = '';
    promptOpts.understanding = null;
    gate.logTurnDebug({
      charId: char.id, turn, skippedModel: true,
      candidates: {}, modes: {}, speakKeys: [], backgroundKeys: [],
      memoryPreview: '(force skip chat memory)',
    });
    return promptOpts;
  }

  if (skipLayer(promptOpts)) {
    if (promptOpts.memoryBlock == null && !promptOpts.isDream && !promptOpts.forGame) {
      try {
        promptOpts.memoryBlock = await brain.formatMindFlashForPromptAsync(char, contextText, promptOpts);
      } catch { /* leave empty */ }
    }
    return promptOpts;
  }

  if (!cfg.MEMORY_BLOCK_ENABLED) {
    promptOpts.memoryBlock = prependLived(char, promptOpts, '');
    promptOpts.impressionBlock = '';
    promptOpts.understandingBlock = '';
    promptOpts.understanding = null;
    gate.logTurnDebug({
      charId: char.id, turn, skippedModel: true,
      candidates: {}, modes: {}, speakKeys: [], backgroundKeys: [],
      memoryPreview: String(promptOpts.memoryBlock || '').slice(0, 160),
    });
    return promptOpts;
  }

  let prepared = { selected: null, flashCandidates: [], narratives: [] };
  try {
    prepared = await brain.prepareMindFlashForPromptAsync(char, contextText, promptOpts);
  } catch (e) {
    console.warn('[brain] prepare flash', e.message);
    try {
      promptOpts.memoryBlock = await brain.formatMindFlashForPromptAsync(char, contextText, promptOpts);
    } catch { /* ignore */ }
    promptOpts.impressionBlock = '';
    promptOpts.understandingBlock = '';
    return promptOpts;
  }

  prepared.flashCandidates = attachVecScores(prepared.flashCandidates);
  const clusterByKey = prepared.clusterByKey instanceof Map
    ? prepared.clusterByKey
    : brain.buildClusterKeyMap(prepared.flashCandidates, prepared.narratives, prepared.selected);

  let es = null;
  try { es = require('./cron').getDecayedEmotionState(char); } catch { es = null; }
  const perceptionSnap = perception.snapshotForUnderstanding(es || {});
  const hasPerceptionCueEarly = perception.hasUnderstandingCue(userMessage, { score: perceptionSnap.daily_anomaly_score })
    || (perceptionSnap.daily_anomaly_score || 0) >= 40;
  // 携带画像开：常驻性格每轮挂上；关：只在有感知线索/点名回忆/事件候选时带，其余靠话题检索
  const carryPortrait = char.carry_portrait === 1 || char.carry_portrait === '1' || char.carry_portrait === true;
  const includeStanding = carryPortrait
    || gate.hardSpeakBypass(userMessage)
    || hasPerceptionCueEarly
    || (prepared.flashCandidates || []).length > 0
    || (prepared.narratives || []).length > 0;

  const cron = require('./cron');
  let impressionPick = null;
  try {
    impressionPick = cron.pickImpressionCandidates(char.id, contextText, {
      max: Math.min(IMPRESSION_SEND_MAX, cfg.IMPRESSION_CANDIDATE_MAX),
      includeStanding,
    });
  } catch (e) {
    console.warn('[brain] pick impressions', e.message);
  }
  const impressions = impressionPick?.picked || [];

  const ruled = gate.ruleAssignModes({
    charId: char.id,
    userMessage,
    flashCandidates: prepared.flashCandidates,
    narratives: prepared.narratives,
    impressions,
    cfg,
    clusterByKey,
  });

  const skipNoCand = shouldSkipUnderstanding({
    flashCandidates: prepared.flashCandidates,
    narratives: prepared.narratives,
    impressions,
    userMessage,
    perceptionSnap,
  });
  const hasPerceptionCue = hasPerceptionCueEarly;
  const skipModel = skipNoCand || shouldSkipModelAfterRules(ruled.modeById, { hasPerceptionCue });

  let understanding = normalizeUnderstandingPayload({}, {
    flashCandidates: prepared.flashCandidates,
    narratives: prepared.narratives,
    impressions,
    perceptionSnap,
  });
  // 无模型时：过滤器跟规则走，避免 fail-open 全 skip 盖掉规则 usable_now
  const syncFiltersFromModes = (modeById) => {
    for (const row of understanding.memory_filter || []) {
      if (modeById.has(row.id)) {
        row.mode = modeById.get(row.id);
        row.usable = row.mode !== 'skip';
      }
    }
    for (const row of understanding.impression_filter || []) {
      if (modeById.has(row.id)) {
        row.mode = modeById.get(row.id);
        row.usable = row.mode !== 'skip';
      }
    }
  };
  syncFiltersFromModes(ruled.modeById);

  let modelRaw = null;
  if (!skipModel) {
    try {
      modelRaw = await runUnderstandingModel(settings, buildUnderstandingUserPayload({
        userMessage,
        recentText: formatRecentTurns(promptOpts.recentHistory, userMessage, {
          userName: settings.username || '对方',
          charName: char.name || '我',
        }),
        impressions,
        flashCandidates: prepared.flashCandidates,
        narratives: prepared.narratives,
        mood: snapshotMood(char),
        affection: snapshotAffection(char),
        perceptionSnap,
        ruleModes: ruled.modeById,
      }));
      if (modelRaw) {
        understanding = normalizeUnderstandingPayload(modelRaw, {
          flashCandidates: prepared.flashCandidates,
          narratives: prepared.narratives,
          impressions,
          perceptionSnap,
        });
      }
    } catch (e) {
      console.warn('[brain] understanding call', e.message);
    }
  }

  const merged = (!skipModel && modelRaw)
    ? gate.mergeModelModes(ruled.modeById, understanding, {
      forceSpeak: ruled.forceSpeak,
      protectKeys: new Set(
        (prepared.flashCandidates || [])
          .filter((c) => c.kwHit || c.keywordHit)
          .map((c) => c.key || `mem:${c.id}`)
          .concat(
            (impressions || [])
              .filter((p) => p.keywordHit || (p.score && p.score >= 5))
              .map((p) => String(p.id)),
            (prepared.narratives || [])
              .filter((n) => n.kwHit)
              .map((n) => `narr:${n.id}`),
            Object.entries(ruled.reasons || {})
              .filter(([, reason]) => reason === 'same_topic')
              .map(([id]) => id),
          ),
      ),
    })
    : new Map(ruled.modeById);

  // 仅当模型明确返回 allow_speak_memory=false 时收紧明说（硬旁路、对方词命中除外）
  if (
    !ruled.forceSpeak
    && modelRaw
    && Object.prototype.hasOwnProperty.call(modelRaw, 'allow_speak_memory')
    && asBool(modelRaw.allow_speak_memory, true) === false
  ) {
    const protectKw = new Set(
      (prepared.flashCandidates || [])
        .filter((c) => c.kwHit || c.keywordHit)
        .map((c) => c.key || `mem:${c.id}`),
    );
    for (const [id, mode] of [...merged.entries()]) {
      if (mode === 'usable_now' && /^(mem:|ep:|narr:)/.test(String(id)) && !protectKw.has(String(id))) {
        merged.set(id, 'background_only');
      }
    }
  }
  syncFiltersFromModes(merged);

  let { speak, background } = gate.setsFromModes(merged);
  speak = gate.capSpeakClusters(speak, clusterByKey, cfg.MAX_EVENTS_PER_TURN);
  expandWinningClusterSpeak(speak, merged, prepared, clusterByKey);
  for (const k of speak) background.delete(k);

  // 印象注入：speak + background，总量封顶
  const impInject = [];
  for (const p of impressions) {
    const mode = merged.get(String(p.id));
    if (mode === 'usable_now' || mode === 'background_only') {
      impInject.push({ ...p, injectMode: mode });
    }
  }
  impInject.sort((a, b) => {
    const rank = { usable_now: 2, background_only: 1 };
    return (rank[b.injectMode] || 0) - (rank[a.injectMode] || 0) || (b.score || 0) - (a.score || 0);
  });
  const impFinal = impInject.slice(0, cfg.MAX_IMPRESSIONS_PER_TURN);

  const narrSpeak = new Set(
    [...speak].filter((k) => String(k).startsWith('narr:')).map((k) => Number(String(k).slice(5))).filter((n) => Number.isFinite(n))
  );
  const narrBg = new Set(
    [...background].filter((k) => String(k).startsWith('narr:')).map((k) => Number(String(k).slice(5))).filter((n) => Number.isFinite(n))
  );

  const flashBody = brain.formatMindFlashBlock(char, prepared.selected || Object.assign([], { _narratives: prepared.narratives || [] }), {
    ...promptOpts,
    contextText,
    usableFlashKeys: speak,
    backgroundFlashKeys: background,
    usableNarrativeIds: narrSpeak,
    backgroundNarrativeIds: narrBg,
    maxSpeakFlashes: cfg.MAX_EVENTS_PER_TURN,
    clusterCarry: true,
    clusterDetailMax: brain.CLUSTER_DETAIL_MAX,
    memoryUsageHint: gate.MEMORY_USAGE_HINT,
  });

  promptOpts.memoryBlock = prependLived(char, promptOpts, flashBody);
  promptOpts.impressionBlock = impressionPick
    ? cron.formatImpressionCandidates(impFinal, impressionPick.voice, {
      usageHint: gate.MEMORY_USAGE_HINT,
      fuzzy: true,
    })
    : '';
  promptOpts.understandingBlock = (skipModel && !hasPerceptionCue)
    ? ''
    : formatUnderstandingPromptBlock(understanding);
  promptOpts.understanding = skipModel && !hasPerceptionCue ? null : understanding;
  promptOpts.memoryGate = {
    turn,
    forceSpeak: ruled.forceSpeak,
    modes: Object.fromEntries(merged),
    speak: [...speak],
    background: [...background],
  };

  if (speak.size) {
    const eventKeys = [...speak].filter((k) => gate.isEventMemoryKey(k));
    const clusterIds = [...new Set(eventKeys.map((k) => gate.clusterIdOfKey(k, clusterByKey)))];
    const cues = [];
    for (const c of prepared.flashCandidates || []) {
      if (speak.has(c.key)) cues.push(...cueBits(c.text));
    }
    for (const n of prepared.narratives || []) {
      if (speak.has(`narr:${n.id}`)) cues.push(...cueBits(n.title || n.content));
    }
    gate.recordSpoken(
      char.id,
      [...speak, ...impFinal.filter((p) => p.injectMode === 'usable_now').map((p) => String(p.id))],
      { clusterIds, cues },
    );
  }

  gate.logTurnDebug({
    charId: char.id,
    turn,
    forceSpeak: ruled.forceSpeak,
    budgetExhausted: ruled.budgetExhausted,
    skippedModel: skipModel,
    candidates: {
      flash: (prepared.flashCandidates || []).map((c) => c.key),
      narr: (prepared.narratives || []).map((n) => `narr:${n.id}`),
      imp: impressions.map((p) => String(p.id)),
    },
    modes: Object.fromEntries(merged),
    speakKeys: [...speak],
    backgroundKeys: [...background],
    impressionPreview: String(promptOpts.impressionBlock || '').slice(0, 200),
    memoryPreview: String(flashBody || '').slice(0, 200),
    understandingPreview: String(promptOpts.understandingBlock || '').slice(0, 160),
  });

  return promptOpts;
}

module.exports = {
  parseJsonObject,
  normalizeUnderstandingPayload,
  formatUnderstandingPromptBlock,
  shouldSkipUnderstanding,
  shouldSkipModelAfterRules,
  applyBrainUnderstanding,
  usableKeySet,
  IMPRESSION_SEND_MAX,
  MODES,
};

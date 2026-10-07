/**
 * 睡前整理：把当天零散的碎片（短期记忆）连成记忆点，再挂到记忆树上（长期记忆）。
 *
 * 白天每聊 N 轮总结一次，同一件事跨了窗口就会被切成好几段，还会重复。
 * 这里做三步：按时间顺序连接 → 去掉重复的说法 → 按「是不是同一件事」重新分割成记忆点。
 * 每个记忆点自带组成部分（事/人/物/背景），挂枝时拿它和树上的组成部分求交集：
 *   命中核心 或 对上两个及以上 → 这件事的延续发展，并进那根枝干的主干
 *   只对上一个                 → 支线，挂到那个组成部分的细枝上
 *   一个都对不上               → 自己长成一根新枝干
 */
const db = require('./db');
const { callChatAPIComplete } = require('./api-helper');
const tree = require('./memory-tree-helper');

const DAY_POINT_MAX = 6;        // 一天最多分出几个记忆点
const PRUNE_POINT_MAX = 8;      // 修剪时略放宽，但仍封顶，防一天拆成一地碎片
const DAY_FRAG_MAX = 40;        // 一天最多送多少条碎片给模型
const CATCHUP_DAYS = 7;         // 一次最多补几天的欠账
// 过并启发式：片段多 / 细枝多 / 又胖又岔 → 管家修剪候选
const PRUNE_FAT_STAGES = 15;
const PRUNE_FAT_TWIGS = 8;
const PRUNE_FAT_BOTH_STAGES = 10;
const PRUNE_FAT_BOTH_TWIGS = 5;

// 组成部分不等权：「事」本身对上就够了，两个泛泛的背景凑数不算延续
const COMP_WEIGHT = { core: 2, person: 1, thing: 1, place: 0.5 };

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function extractJson(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/* ─────────── 待整理的碎片 ─────────── */

/** 还没挂上树的碎片，按天分组、组内按时间顺序。过时只是不再当「当前」，仍可挂上话题。 */
function pendingFragmentsByDay(charId, { dateStr = '' } = {}) {
  const linked = tree.collectAllTreeLinkedIds(charId);
  const rows = db.prepare(
    `SELECT id, content, category, weight, date, created_at, episode_id, source
     FROM memories
     WHERE character_id=? AND COALESCE(archived,0)=0
     ORDER BY id ASC`
  ).all(charId).filter((m) => !linked.has(m.id));

  const byDay = new Map();
  for (const m of rows) {
    const day = String(m.date || m.created_at || '').slice(0, 10) || '未知';
    if (dateStr && day !== dateStr) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(m);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, frags]) => ({ day, frags }));
}

/* ─────────── 第一步：连接 → 去重 → 按话题分割 ─────────── */

function normalizePoint(raw, allowedIds) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = (Array.isArray(raw.memory_ids) ? raw.memory_ids : [])
    .map(Number)
    .filter((n) => allowedIds.has(n));
  if (!ids.length) return null;
  const summary = String(raw.summary || '').trim();
  if (!summary) return null;
  const title = String(raw.title || '').trim().slice(0, 40) || summary.slice(0, 12);
  // 必须走 parseComponents：模型给的零件常常没有 key，
  // 直接丢进 ensureCoreComponent 会因为 key 全是空串而被按 key 去重成一个
  const comps = tree.ensureCoreComponent(
    tree.parseComponents(JSON.stringify(Array.isArray(raw.components) ? raw.components : [])),
    title
  );
  return { title, summary: summary.slice(0, 900), components: comps, memoryIds: [...new Set(ids)], kind: tree.normalizeKind(raw.kind || 'event') };
}

/**
 * 把一天的碎片整理成记忆点。不写库，只返回结果，挂枝那步再落地。
 * opts.maxPoints：修剪时可放宽一天能分出的点数。
 * opts.mode：'prune' 时强调拆开碰巧焊在一起的话题。
 */
async function splitDayIntoPoints(charId, day, frags, { settings, maxPoints, mode } = {}) {
  const s = settings || getSettings();
  const use = frags.slice(0, DAY_FRAG_MAX);
  if (!use.length) return { points: [], reason: 'no_fragments' };

  const cap = Math.max(1, Math.min(12, Number(maxPoints) || DAY_POINT_MAX));
  const pruneHint = mode === 'prune'
    ? `\n- 这是「修剪」：这些碎片曾可能被错误焊进同一根枝。标题必须让人一眼看懂在说哪件事；禁止玄乎合成词\n- 仍然遵守「同一件事合成一个记忆点」：起因/经过/后续哪怕隔了别的话题也要并回\n- 只有两件独立的事碰巧被焊在一起时才拆开；不要把一件事的不同阶段拆成多根主枝`
    : '';

  const allowedIds = new Set(use.map((f) => f.id));
  const listing = use
    .map((f) => `#${f.id} [${String(f.created_at || '').slice(11, 16) || '--:--'}][${f.category || ''}] ${f.content}`)
    .join('\n');

  let raw = '';
  try {
    raw = await callChatAPIComplete(
      s,
      `你在做「${mode === 'prune' ? '记忆树修剪' : '睡前整理'}」：把零散的记忆碎片按时间顺序连起来，去掉重复的说法，再按「是不是同一件事」分割成记忆点。目标是「这件事的发展线」，不是把碎片原文拼成流水账。

只输出 JSON（不要 markdown）：
{"points":[{
  "kind":"event|daily|affection",
  "title":"8字内，只写这一件事",
  "summary":"把这件事讲成一段发展线：导火索→关键转折→现在怎样。120-200字",
  "components":[{"name":"短名","type":"core|person|thing|place","aliases":["别称"]}],
  "memory_ids":[碎片id]
}]}

纪律：
- kind：event=有后续发展的事；daily=反复日常习惯（运动/通勤/作息）；affection=关系起伏（表白/冷战/和好）。不要标 user/self
- 同一件事的不同时刻必须合成一个记忆点，哪怕中间隔着别的话题
- 两件只是碰巧连着聊的事必须拆开，禁止用「和/与」焊成一条标题
- 【去重·硬性】多条碎片讲同一争吵/同一约定时，导火索、双方态度、结果各自只写一次；禁止把碎片开头的日期/起因再拼进 summary 造成衔接重复
- 【忌流水账】不要复述每条碎片全文；只提炼对以后有用的核心进展。琐碎过程、重复情绪描写一律省略
- 每条碎片最多归进一个记忆点；实在无关紧要的碎片可以不归
- 最多 ${cap} 个记忆点
- components 必须有且只有一项 type=core，那是「这件事本身」，name 用以后还能认出这件事的短名
- 其余 components 写这件事牵涉到的人(person)、物(thing)、场景背景(place)，只写碎片里真出现过的
- 同类必须拆开：两个不同的人不要合成「同事」；aliases 只写这个零件自己的别称，禁止用能套到别的零件上的泛称
- memory_ids 必须用上面给的真实 id${pruneHint}`,
      `【${day} 的碎片，按时间顺序】\n${listing}`,
      'memory'
    );
  } catch (e) {
    console.warn('[memory-day] split LLM', e.message);
    return { points: [], reason: 'llm_failed', error: e.message };
  }

  const o = extractJson(raw);
  if (!o) return { points: [], reason: 'bad_json' };

  const seen = new Set();
  const points = [];
  for (const p of (Array.isArray(o.points) ? o.points : []).slice(0, cap)) {
    const np = normalizePoint(p, allowedIds);
    if (!np) continue;
    // 一条碎片只能归进一个记忆点，先到先得
    np.memoryIds = np.memoryIds.filter((id) => !seen.has(id));
    if (!np.memoryIds.length) continue;
    np.memoryIds.forEach((id) => seen.add(id));
    np.day = day;
    points.push(np);
  }
  if (!points.length) return { points: [], reason: 'no_points' };
  return { points, unassigned: use.length - seen.size };
}

/* ─────────── 第二步：拿组成部分和树求交集 ─────────── */

function compTerms(c) {
  return [c?.name, ...(c?.aliases || [])]
    .map((x) => String(x || '').trim().toLowerCase())
    .filter((x) => x.length >= 2 && !tree.isGenericTerm(x));
}

// 含数字/拉丁字母的短名（N2、CET6、iPhone）本身就够专，两个字符就能认；
// 纯中文的两字词太容易撞（「公寓」「同事」「资料」），要三个字以上才敢当同一个零件
function containable(term) {
  return term.length >= 3 || (term.length >= 2 && /[a-z0-9]/.test(term));
}

function compsMatch(a, b) {
  const ta = compTerms(a);
  const tb = compTerms(b);
  for (const x of ta) {
    for (const y of tb) {
      if (x === y) return true;
      // 「N2考试」和「N2」当同一个零件
      if (x.includes(y) && containable(y)) return true;
      if (y.includes(x) && containable(x)) return true;
    }
  }
  return false;
}

/** 记忆点的组成部分 ∩ 某根枝干的组成部分 */
function matchAgainstTree(pointComps, treeComps) {
  const matched = [];
  for (const pc of pointComps) {
    const hit = treeComps.find((tc) => compsMatch(pc, tc));
    if (!hit) continue;
    const w = (pc.type === 'core' && hit.type === 'core')
      ? COMP_WEIGHT.core
      : Math.min(COMP_WEIGHT[pc.type] ?? 1, COMP_WEIGHT[hit.type] ?? 1);
    matched.push({ pointKey: pc.key, treeKey: hit.key, treeType: hit.type, weight: w });
  }
  return matched;
}

/**
 * 命中核心 或 权重满 2 → 延续（主干）
 * 恰好对上一个零件     → 支线（细枝）
 * 都对不上             → 无关
 */
function graftDecision(matched) {
  const score = matched.reduce((s, m) => s + m.weight, 0);
  if (!matched.length) return { target: 'none', score: 0, matched };
  if (matched.some((m) => m.treeType === 'core') || score >= 2) {
    return { target: 'trunk', score, matched };
  }
  const side = matched
    .filter((m) => m.treeType !== 'core')
    .sort((a, b) => b.weight - a.weight)[0];
  if (side && score >= 1) return { target: 'branch', key: side.treeKey, score, matched };
  return { target: 'none', score, matched };
}

/** 把记忆点带来的新零件并进枝干，树会越长越认得出这件事 */
function mergeComponentsIntoTree(narrative, pointComps) {
  const existing = tree.parseComponents(narrative.components);
  const added = [];
  for (const pc of pointComps) {
    if (pc.type === 'core') continue;
    if (existing.some((ec) => compsMatch(ec, pc))) continue;
    existing.push(pc);
    added.push(pc.name);
  }
  if (!added.length) return { added: [] };
  const saved = tree.saveComponents(narrative.id, existing);
  tree.syncBranchesFromComponents({ ...narrative, components: JSON.stringify(saved) });
  return { added };
}

/** 把一个记忆点挂到树上 */
function graftPoint(charId, point, { settings, livingFilter } = {}) {
  let living = tree.listLivingNarratives(charId).filter((n) => {
    const k = tree.getNarrativeKind(n);
    return k === 'event' || k === 'daily' || k === 'affection';
  });
  if (typeof livingFilter === 'function') {
    living = living.filter(livingFilter);
  }
  let best = null;
  const pointKind = tree.normalizeKind(point.kind || 'event');
  for (const n of living) {
    const comps = tree.parseComponents(n.components);
    if (!comps.length) continue;
    const d = graftDecision(matchAgainstTree(point.components, comps));
    if (d.target === 'none') continue;
    const kindBonus = tree.getNarrativeKind(n) === pointKind ? 200 : 0;
    const score = kindBonus + (d.target === 'trunk' ? 1000 : 0) + d.score;
    if (!best || score > best.score) best = { n, d, score };
  }

  if (!best) {
    const newId = tree.createNarrativeWithComponents(charId, {
      title: point.title,
      content: point.summary,
      linkedIds: point.memoryIds,
      components: point.components,
      kind: pointKind === 'user' || pointKind === 'self' ? 'event' : pointKind,
    });
    return { action: 'new_trunk', narrativeId: newId, count: point.memoryIds.length };
  }

  const { n, d } = best;
  let linked = 0;
  if (d.target === 'trunk') {
    for (const id of point.memoryIds) {
      if (tree.appendTrunkLink(n.id, id)) linked += 1;
    }
    tree.applyTouch('trunk', n.id, { charge: 0.2, weak: false });
    const merged = mergeComponentsIntoTree(n, point.components);
    return {
      action: 'continue', narrativeId: n.id, count: linked,
      score: d.score, newComponents: merged.added,
    };
  }

  const branch = tree.listBranches(n.id).find((b) => b.component_key === d.key);
  if (!branch || tree.isFallen(branch)) {
    // 该挂的细枝不在了：退回主干，总比丢了强
    for (const id of point.memoryIds) {
      if (tree.appendTrunkLink(n.id, id)) linked += 1;
    }
    return { action: 'continue', narrativeId: n.id, count: linked, score: d.score, fallback: 'branch_missing' };
  }
  for (const id of point.memoryIds) {
    if (tree.appendBranchLink(branch.id, id)) linked += 1;
  }
  tree.applyTouch('branch', branch.id, { charge: 0.2, weak: false });
  return {
    action: 'side_branch', narrativeId: n.id, branchId: branch.id,
    count: linked, score: d.score,
  };
}

/* ─────────── 串起来 ─────────── */

/**
 * 整理某一天（或所有欠账的天）：分割成记忆点 → 逐个挂树。
 * 按天从旧到新，同一天内按记忆点顺序——早的先建枝，后面相关的才好并进来。
 */
async function consolidateDays(charId, { dateStr = '', settings, maxDays = CATCHUP_DAYS } = {}) {
  const s = settings || getSettings();
  const days = pendingFragmentsByDay(charId, { dateStr }).slice(0, maxDays);
  if (!days.length) return { days: 0, points: 0, grafted: 0, newTrunks: 0, sideBranches: 0, continued: 0, detail: [] };

  const detail = [];
  let points = 0;
  let grafted = 0;
  let newTrunks = 0;
  let sideBranches = 0;
  let continued = 0;

  for (const { day, frags } of days) {
    const split = await splitDayIntoPoints(charId, day, frags, { settings: s });
    if (!split.points.length) {
      detail.push({ day, fragments: frags.length, points: 0, reason: split.reason });
      console.warn(`[memory-day] char#${charId} ${day}：${frags.length}条碎片没能分出记忆点（${split.reason}）`);
      // 分不出记忆点也照样贴心情豆（按情绪日志 / 此刻心情）
      try {
        const stick = require('./day-mood-helper').autoStickCharDayMood(charId, day, { pointTitles: [] });
        if (stick?.mood?.emojiCode) {
          console.log(`[memory-day] char#${charId} ${day} 心情贴(无记忆点) → [${stick.mood.emojiCode}]`);
        }
      } catch (e) {
        console.warn('[memory-day] mood sticker', e.message);
      }
      continue;
    }
    const dayDetail = { day, fragments: frags.length, points: split.points.length, results: [] };
    for (const p of split.points) {
      points += 1;
      let r;
      try {
        r = graftPoint(charId, p, { settings: s });
      } catch (e) {
        console.warn('[memory-day] graft', e.message);
        dayDetail.results.push({ title: p.title, action: 'failed', error: e.message });
        continue;
      }
      grafted += r.count || 0;
      if (r.action === 'new_trunk') newTrunks += 1;
      else if (r.action === 'side_branch') sideBranches += 1;
      else if (r.action === 'continue') continued += 1;
      dayDetail.results.push({ title: p.title, ...r });
      const label = r.action === 'new_trunk' ? '新枝干'
        : r.action === 'side_branch' ? `支线(枝#${r.branchId})`
          : `延续(权重${r.score})`;
      console.log(`[memory-day] char#${charId} ${day}「${p.title}」→ ${label} 记忆点#${r.narrativeId}，${r.count}条`);
    }
    // 当天整理成功 → 日历贴一颗角色心情小黄豆
    try {
      const titles = split.points.map((p) => p.title).filter(Boolean);
      const stick = require('./day-mood-helper').autoStickCharDayMood(charId, day, { pointTitles: titles });
      dayDetail.moodSticker = stick?.mood?.emojiCode || stick?.skipped || null;
      if (stick?.mood?.emojiCode) {
        console.log(`[memory-day] char#${charId} ${day} 心情贴 → [${stick.mood.emojiCode}]`);
      }
    } catch (e) {
      console.warn('[memory-day] mood sticker', e.message);
    }
    detail.push(dayDetail);
  }

  try {
    require('./memory-brain-helper').autoLinkNewMemories(
      charId,
      days.flatMap((d) => d.frags.map((f) => f.id))
    );
  } catch { /* ignore */ }

  let narrativeLinks = 0;
  try {
    narrativeLinks = tree.rebuildNarrativeLinks(charId)?.links || 0;
  } catch { /* ignore */ }

  console.log(`[memory-day] char#${charId} 睡前整理：${days.length}天 → ${points}个记忆点，挂上${grafted}条（新枝干${newTrunks} 支线${sideBranches} 延续${continued}）话题连线+${narrativeLinks}`);
  return { days: days.length, points, grafted, newTrunks, sideBranches, continued, narrativeLinks, detail };
}

/** 每晚跑：所有角色补上欠账的天 */
async function runNightlyDayConsolidation() {
  const chars = db.prepare('SELECT id FROM characters').all();
  const results = [];
  for (const c of chars) {
    try {
      const r = await consolidateDays(c.id);
      if (r.days) results.push({ charId: c.id, ...r });
    } catch (e) {
      console.warn('[memory-day] char', c.id, e.message);
    }
  }
  return { results };
}

function isFatNarrative(n) {
  const s = tree.treeSummary(n);
  const twigs = tree.listBranches(n.id).filter(
    (b) => !tree.isFallen(b) && b.component_key !== 'core' && b.type !== 'core'
  ).length;
  if (s.stageCount >= PRUNE_FAT_STAGES) return true;
  if (twigs >= PRUNE_FAT_TWIGS) return true;
  if (s.stageCount >= PRUNE_FAT_BOTH_STAGES && twigs >= PRUNE_FAT_BOTH_TWIGS) return true;
  return false;
}

function listPruneCandidates(charId, { narrativeId, forceAll = false } = {}) {
  const living = tree.listLivingNarratives(charId).filter((n) => {
    const k = tree.getNarrativeKind(n);
    return k === 'event' || k === 'daily' || k === 'affection';
  });
  if (narrativeId) {
    const id = Number(narrativeId);
    return living.filter((n) => n.id === id);
  }
  if (forceAll) return living.filter((n) => tree.treeSummary(n).stageCount > 0);
  return living.filter(isFatNarrative);
}

function describeCandidate(n) {
  const before = tree.treeSummary(n);
  const twigN = tree.listBranches(n.id).filter(
    (b) => !tree.isFallen(b) && b.component_key !== 'core' && b.type !== 'core'
  ).length;
  const ids = [...tree.collectTreeLinkedIds(n)];
  return {
    id: n.id,
    title: n.title || '未命名',
    kind: before.kind || 'event',
    stages: before.stageCount,
    twigs: twigN,
    frags: ids.length,
    memoryIds: ids,
  };
}

function loadFragsByIds(charId, idSet) {
  if (!idSet?.size) return [];
  return db.prepare(
    `SELECT id, content, category, weight, date, created_at, episode_id, source, meta, embedding
     FROM memories
     WHERE character_id=? AND COALESCE(archived,0)=0
     ORDER BY id ASC`
  ).all(charId).filter((m) => idSet.has(m.id));
}

function groupFragsByDay(frags) {
  const byDay = new Map();
  for (const m of frags) {
    const day = String(m.date || m.created_at || '').slice(0, 10) || '未知';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(m);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** 预览用：在内存里模拟挂枝，不写库 */
function simulatePruneForest(points) {
  const trunks = [];
  let continued = 0;
  let sideBranches = 0;
  let newTrunks = 0;
  for (const p of points) {
    const pointKind = tree.normalizeKind(p.kind || 'event');
    let best = null;
    for (const t of trunks) {
      const comps = t.components || [];
      if (!comps.length) continue;
      const d = graftDecision(matchAgainstTree(p.components, comps));
      if (d.target === 'none') continue;
      const kindBonus = tree.normalizeKind(t.kind) === pointKind ? 200 : 0;
      const score = kindBonus + (d.target === 'trunk' ? 1000 : 0) + d.score;
      if (!best || score > best.score) best = { t, d, score };
    }
    if (!best) {
      newTrunks += 1;
      trunks.push({
        title: p.title,
        summary: p.summary,
        kind: pointKind,
        components: (p.components || []).map((c) => ({ ...c })),
        memoryIds: [...p.memoryIds],
        days: p.day ? [p.day] : [],
      });
      continue;
    }
    const { t, d } = best;
    t.memoryIds.push(...p.memoryIds);
    if (p.day && !t.days.includes(p.day)) t.days.push(p.day);
    if (d.target === 'trunk') {
      continued += 1;
      for (const pc of p.components || []) {
        if (pc.type === 'core') continue;
        if (t.components.some((ec) => compsMatch(ec, pc))) continue;
        t.components.push({ ...pc });
      }
      if (p.summary && String(p.summary).length > String(t.summary || '').length) {
        t.summary = p.summary;
      }
    } else {
      sideBranches += 1;
    }
  }
  return {
    trunks: trunks.map((t, i) => ({
      key: i + 1,
      title: t.title,
      summary: String(t.summary || '').slice(0, 160),
      kind: t.kind,
      kindLabel: tree.KIND_LABEL[t.kind] || '事件',
      fragCount: t.memoryIds.length,
      days: t.days,
      twigCount: (t.components || []).filter((c) => c.type !== 'core').length,
    })),
    newTrunks,
    continued,
    sideBranches,
  };
}

/**
 * 只算方案、不改库：收回哪些过并枝、会重分成哪些主枝。
 */
async function previewPruneHungTrees(charId, { narrativeId, forceAll = false, settings } = {}) {
  const s = settings || getSettings();
  const candidates = listPruneCandidates(charId, { narrativeId, forceAll });
  if (!candidates.length) {
    return {
      ok: true,
      preview: true,
      pruned: 0,
      harvested: 0,
      points: 0,
      message: narrativeId
        ? '这根枝不在，或属于用户/自我粗枝（不修剪）'
        : '没有明显过并的主枝需要修剪',
      removed: [],
      proposed: [],
      plan: null,
    };
  }

  const removed = candidates.map(describeCandidate);
  const harvestedIds = new Set();
  for (const r of removed) r.memoryIds.forEach((id) => harvestedIds.add(id));

  if (!harvestedIds.size) {
    return {
      ok: true,
      preview: true,
      pruned: removed.length,
      harvested: 0,
      points: 0,
      message: '候选枝没有可收回的碎片',
      removed: removed.map(({ memoryIds, ...rest }) => rest),
      proposed: [],
      plan: null,
    };
  }

  const frags = loadFragsByIds(charId, harvestedIds);
  const days = groupFragsByDay(frags);
  const points = [];
  const detail = [];
  let unassigned = 0;

  for (const [day, dayFrags] of days) {
    const batches = [];
    for (let i = 0; i < dayFrags.length; i += DAY_FRAG_MAX) {
      batches.push(dayFrags.slice(i, i + DAY_FRAG_MAX));
    }
    const dayDetail = { day, fragments: dayFrags.length, points: 0, results: [] };
    for (const batch of batches) {
      const split = await splitDayIntoPoints(charId, day, batch, {
        settings: s,
        maxPoints: PRUNE_POINT_MAX,
        mode: 'prune',
      });
      if (!split.points?.length) {
        dayDetail.results.push({ action: 'split_failed', reason: split.reason, error: split.error });
        unassigned += batch.length;
        continue;
      }
      unassigned += Number(split.unassigned) || 0;
      for (const p of split.points) {
        points.push({
          title: p.title,
          summary: p.summary,
          kind: p.kind,
          components: p.components,
          memoryIds: p.memoryIds,
          day: p.day || day,
        });
        dayDetail.points += 1;
        dayDetail.results.push({ title: p.title, action: 'proposed', count: p.memoryIds.length });
      }
    }
    detail.push(dayDetail);
  }

  const sim = simulatePruneForest(points);
  const removedView = removed.map(({ memoryIds, ...rest }) => rest);
  const titles = removedView.map((r) => `「${r.title}」`).join('、');
  let message;
  if (sim.trunks.length) {
    message = `预览：拆 ${removedView.length} 根（${titles}），收回 ${harvestedIds.size} 条 → 约 ${sim.trunks.length} 根新主枝。确认后才真正改树。`;
  } else {
    message = `预览失败：拆得动旧枝，但没能重分出话题（模型可能没返回可用结果）`;
  }
  if (unassigned) message += `；约 ${unassigned} 条可能挂不上`;

  return {
    ok: true,
    preview: true,
    pruned: removedView.length,
    harvested: harvestedIds.size,
    points: points.length,
    newTrunks: sim.newTrunks,
    continued: sim.continued,
    sideBranches: sim.sideBranches,
    unassigned,
    message,
    removed: removedView,
    proposed: sim.trunks,
    detail,
    plan: {
      removedIds: removedView.map((r) => r.id),
      points,
      harvested: harvestedIds.size,
    },
  };
}

/**
 * 按用户确认过的 plan 真正动手：拆旧枝 → 按 plan 挂新枝。
 */
async function applyPrunePlan(charId, plan, { settings } = {}) {
  const s = settings || getSettings();
  const removedIds = (Array.isArray(plan?.removedIds) ? plan.removedIds : []).map(Number).filter(Boolean);
  const points = Array.isArray(plan?.points) ? plan.points : [];
  if (!removedIds.length || !points.length) {
    return { ok: false, error: '没有可执行的修剪方案，请先预览' };
  }

  const removed = [];
  const harvestedIds = new Set();
  for (const id of removedIds) {
    const n = tree.listLivingNarratives(charId).find((row) => row.id === id)
      || db.prepare('SELECT * FROM memory_narratives WHERE id=? AND character_id=?').get(id, charId);
    if (!n) continue;
    if (tree.isPortraitKind(tree.getNarrativeKind(n))) continue;
    const desc = describeCandidate(n);
    const h = tree.harvestAndRemoveNarrative(n.id);
    if (h.skipped) continue;
    h.ids.forEach((x) => harvestedIds.add(x));
    removed.push({ ...desc, frags: h.ids.length, memoryIds: undefined });
  }

  if (!removed.length) {
    return {
      ok: false,
      error: '要拆的枝已经不在了，请重新预览',
      pruned: 0,
    };
  }

  // 只挂 plan 里、且确实从旧枝收回的碎片；防止过期方案乱挂
  const allowed = harvestedIds.size ? harvestedIds : null;
  const pruneBorn = new Set();
  const detail = [];
  let grafted = 0;
  let newTrunks = 0;
  let sideBranches = 0;
  let continued = 0;
  let skipped = 0;

  for (const raw of points) {
    const memoryIds = (Array.isArray(raw.memoryIds) ? raw.memoryIds : [])
      .map(Number)
      .filter((id) => !allowed || allowed.has(id));
    if (!memoryIds.length) {
      skipped += 1;
      continue;
    }
    const p = {
      title: String(raw.title || '').trim().slice(0, 40) || '记忆点',
      summary: String(raw.summary || '').trim().slice(0, 900),
      kind: tree.normalizeKind(raw.kind || 'event'),
      components: tree.ensureCoreComponent(
        tree.parseComponents(JSON.stringify(Array.isArray(raw.components) ? raw.components : [])),
        String(raw.title || '')
      ),
      memoryIds,
      day: raw.day || '',
    };
    let r;
    try {
      r = graftPoint(charId, p, {
        settings: s,
        livingFilter: (n) => pruneBorn.has(n.id),
      });
    } catch (e) {
      console.warn('[memory-day] apply prune graft', e.message);
      detail.push({ title: p.title, action: 'failed', error: e.message });
      continue;
    }
    if (r.narrativeId) pruneBorn.add(r.narrativeId);
    grafted += r.count || 0;
    if (r.action === 'new_trunk') newTrunks += 1;
    else if (r.action === 'side_branch') sideBranches += 1;
    else if (r.action === 'continue') continued += 1;
    detail.push({ title: p.title, ...r });
  }

  const titles = removed.map((r) => `「${r.title}」`).join('、');
  let narrativeLinks = 0;
  try {
    narrativeLinks = tree.rebuildNarrativeLinks(charId)?.links || 0;
  } catch { /* ignore */ }
  const message = `已修剪 ${removed.length} 根（${titles}）：新主枝 ${newTrunks}，续挂 ${continued}，支线 ${sideBranches}，共挂回 ${grafted} 条`
    + (skipped ? `；跳过 ${skipped} 个过期话题` : '');

  console.log(`[memory-day] char#${charId} 确认修剪：拆 ${removed.length}，新枝 ${newTrunks}，挂上 ${grafted}，话题连线+${narrativeLinks}`);
  return {
    ok: true,
    preview: false,
    applied: true,
    pruned: removed.length,
    harvested: harvestedIds.size,
    points: points.length,
    newTrunks,
    sideBranches,
    continued,
    grafted,
    narrativeLinks,
    skipped,
    message,
    removed: removed.map(({ memoryIds, ...rest }) => rest),
    detail,
  };
}

/**
 * 管家「修剪」入口：默认先预览；传 apply+plan 才落库。
 */
async function pruneHungTrees(charId, opts = {}) {
  if (opts.apply && opts.plan) {
    return applyPrunePlan(charId, opts.plan, { settings: opts.settings });
  }
  return previewPruneHungTrees(charId, opts);
}

module.exports = {
  pendingFragmentsByDay,
  splitDayIntoPoints,
  matchAgainstTree,
  graftDecision,
  compsMatch,
  graftPoint,
  consolidateDays,
  runNightlyDayConsolidation,
  listPruneCandidates,
  pruneHungTrees,
  previewPruneHungTrees,
  applyPrunePlan,
  isFatNarrative,
  COMP_WEIGHT,
};

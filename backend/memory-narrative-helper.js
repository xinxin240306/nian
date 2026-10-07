/**
 * 日常记忆点：碎片 embedding + 分诊/消化/聚类 + 聊天注入辅助
 * 「记忆点」= 跨天同一件事的归类节点（表仍为 memory_narratives）
 * 对照 consolidation-draft，裁剪 Leiden→连通分量聚类。
 */
const db = require('./db');
const { callChatAPIComplete } = require('./api-helper');
const {
  embedText,
  parseStoredEmbedding,
  scoreTextsAgainst,
  passRelevance,
  cosine,
  lexicalVector,
  centroidOfEmbeddings,
} = require('./embed-helper');

// 下面这些阈值配的是 scoreTextsAgainst 的 0..1 相关度：
// 明确同一件事 0.7 以上，沾边 0.3~0.5，无关 0。
// （老值 0.70/0.72/0.75 配的是 64 维哈希余弦，那个尺度上什么都有 0.6+）
const CLUSTER_EDGE = 0.42;
const STALE_COS = 0.45;
const RELATED_EVENT_COS = 0.45;
const SEED_IMPORTANCE = 0.4; // weight 近似 importance/10
const CONTENT_SOFT_MAX = 800;
const CONTENT_HARD_MAX = 1000;
const DIRTY_LINK_THRESHOLD = 3;
const DIRTY_DAYS = 4;
const STALE_DAYS = 14;

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function parseIds(raw) {
  if (Array.isArray(raw)) return raw.map(Number).filter((n) => Number.isFinite(n));
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function daysBetween(isoA, isoB = new Date().toISOString()) {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / 86400000);
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureChatMemoryEmbedding(row, settings) {
  if (!row?.id) return null;
  const existing = parseStoredEmbedding(row.embedding);
  if (existing?.vec?.length) return existing;
  const emb = await embedText(row.content, settings || getSettings());
  try {
    db.prepare('UPDATE memories SET embedding=? WHERE id=?').run(JSON.stringify(emb), row.id);
  } catch (_) { /* mid-migration */ }
  return emb;
}

async function ensureNarrativeEmbedding(row, settings) {
  if (!row?.id) return null;
  const existing = parseStoredEmbedding(row.embedding);
  if (existing?.vec?.length) return existing;
  const emb = await embedText(row.content, settings || getSettings());
  try {
    db.prepare('UPDATE memory_narratives SET embedding=? WHERE id=?').run(JSON.stringify(emb), row.id);
  } catch (_) { /* ignore */ }
  return emb;
}

/** 入库后异步补向量，不阻塞聊天 */
function scheduleEmbedMemoryIds(ids) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) return;
  Promise.resolve().then(async () => {
    const settings = getSettings();
    for (const id of list.slice(0, 20)) {
      try {
        const row = db.prepare('SELECT id, content, embedding FROM memories WHERE id=?').get(id);
        if (row) await ensureChatMemoryEmbedding(row, settings);
      } catch (e) {
        console.warn('[narrative] embed memory', id, e.message);
      }
    }
  }).catch(() => {});
}

function listActiveNarratives(charId) {
  try {
    return db.prepare(
      `SELECT * FROM memory_narratives WHERE character_id=? AND status='active' AND COALESCE(fallen_at,'')='' ORDER BY id DESC`
    ).all(charId);
  } catch {
    return db.prepare(
      `SELECT * FROM memory_narratives WHERE character_id=? AND status='active' ORDER BY id DESC`
    ).all(charId);
  }
}

function listAllNarratives(charId) {
  return db.prepare(
    `SELECT * FROM memory_narratives WHERE character_id=? ORDER BY
      CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC`
  ).all(charId);
}

function getNarrative(id) {
  return db.prepare('SELECT * FROM memory_narratives WHERE id=?').get(id);
}

function linkedCount(row) {
  return parseIds(row.linked_memory_ids).length;
}

function isDirty(row) {
  const linksAt = row.links_updated_at || row.created_at;
  const contentAt = row.content_updated_at || row.created_at;
  if (Date.parse(linksAt) <= Date.parse(contentAt)) return false;
  const newLinksApprox = Math.max(0, linkedCount(row)); // 简化：用欠账天数+链数阈值
  const age = daysBetween(contentAt);
  // 规格：新链<3 且最老欠账<4天 → 不催；无精确「新链数」时用「链改晚于正文」+天数
  if (age < DIRTY_DAYS && newLinksApprox < DIRTY_LINK_THRESHOLD) return false;
  return Date.parse(linksAt) > Date.parse(contentAt);
}

function isFullForRouting(row) {
  try {
    return require('./memory-tree-helper').isFallen(row);
  } catch {
    return row.status === 'closed';
  }
}

function appendLink(narrativeId, memoryId) {
  const tree = require('./memory-tree-helper');
  const ok = tree.appendTrunkLink(narrativeId, memoryId);
  if (ok) {
    const frag = db.prepare('SELECT category, meta FROM memories WHERE id=?').get(memoryId);
    tree.applyTouch('trunk', narrativeId, {
      charge: tree.emotionChargeOf(frag || {}),
      pinned: frag?.category === '待办' || frag?.category === '约定',
    });
  }
  return ok;
}

function setNarrativeContent(narrativeId, content, { refreshLinksTs = false } = {}) {
  const text = String(content || '').trim().slice(0, CONTENT_HARD_MAX);
  const ts = nowIso();
  if (refreshLinksTs) {
    db.prepare(
      `UPDATE memory_narratives SET content=?, content_updated_at=?, links_updated_at=?, embedding='' WHERE id=?`
    ).run(text, ts, ts, narrativeId);
  } else {
    db.prepare(
      `UPDATE memory_narratives SET content=?, content_updated_at=?, embedding='' WHERE id=?`
    ).run(text, ts, narrativeId);
  }
  const row = getNarrative(narrativeId);
  Promise.resolve()
    .then(() => ensureNarrativeEmbedding(row, getSettings()))
    .catch(() => {});
}

function createNarrative(charId, { title, content, linkedIds = [], kind = 'event' }) {
  const tree = require('./memory-tree-helper');
  const nk = tree.normalizeKind(kind);
  const ts = nowIso();
  const text = String(content || '').trim().slice(0, CONTENT_HARD_MAX);
  let id;
  try {
    const r = db.prepare(
      `INSERT INTO memory_narratives
        (character_id, title, content, linked_memory_ids, status, kind, links_updated_at, content_updated_at)
       VALUES (?,?,?,?, 'active', ?, ?, ?)`
    ).run(
      charId,
      String(title || '记忆点').slice(0, 40),
      text,
      JSON.stringify(linkedIds.map(Number)),
      nk,
      ts,
      ts
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
      text,
      JSON.stringify(linkedIds.map(Number)),
      ts,
      ts
    );
    id = r.lastInsertRowid;
    tree.setNarrativeKind(id, nk);
  }
  try {
    db.prepare(
      `UPDATE memory_narratives SET last_touched_at=?, touch_count=1, salience=0.8, tier='hot', pinned=? WHERE id=?`
    ).run(ts, tree.isPortraitKind(nk) ? 1 : 0, id);
  } catch { /* mid-migration */ }
  Promise.resolve()
    .then(async () => {
      const row = getNarrative(id);
      await ensureNarrativeEmbedding(row, getSettings());
    })
    .catch(() => {});
  return id;
}

function closeNarrative(id) {
  const row = getNarrative(id);
  if (!row || row.status === 'closed') return false;
  let content = String(row.content || '');
  if (!/###\s*(卷末状态|收束此点)/.test(content)) {
    content = `${content.trim()}\n\n### 收束此点\n这件事告一段落；若有后续，另开记忆点或续挂新阶段。`.slice(0, CONTENT_HARD_MAX);
  }
  const ts = nowIso();
  db.prepare(
    `UPDATE memory_narratives SET status='closed', content=?, content_updated_at=?, embedding='' WHERE id=?`
  ).run(content, ts, id);
  return true;
}

/** 分诊：新碎片按组件命中挂树干或分叉；不再只靠向量硬挂主干 */
async function triageNewMemories(charId, { sinceHours = 36 } = {}) {
  const settings = getSettings();
  const tree = require('./memory-tree-helper');
  const cutoff = new Date(Date.now() - sinceHours * 3600000).toISOString();
  const fragments = db.prepare(
    `SELECT id, content, embedding, weight, category, created_at, meta FROM memories
     WHERE character_id=? AND COALESCE(archived,0)=0
       AND created_at >= ?
     ORDER BY id DESC LIMIT 40`
  ).all(charId, cutoff.replace('T', ' ').slice(0, 19));

  const actives = listActiveNarratives(charId).filter((n) => !isFullForRouting(n));
  if (!fragments.length) return { linked: 0 };
  // 即使还没有事件枝，日常/用户/自我也可新建并挂上

  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  for (const n of actives) {
    await tree.ensureNarrativeTree(n, settings, char);
  }
  const refreshed = listActiveNarratives(charId).filter((n) => !isFullForRouting(n));
  const linkedSet = tree.collectAllTreeLinkedIds(charId);

  let linked = 0;
  for (const frag of fragments) {
    if (linkedSet.has(frag.id)) continue;
    await ensureChatMemoryEmbedding(frag, settings);
    const row = db.prepare('SELECT id, content, embedding, weight, category, meta FROM memories WHERE id=?').get(frag.id);
    const r = await tree.routeFragmentToTrees(charId, row || frag, { settings, actives: refreshed });
    if (r.linked) {
      linkedSet.add(frag.id);
      linked += 1;
    }
  }
  return { linked };
}

function collectDirtyAndStale(charId) {
  const settings = getSettings();
  const actives = listActiveNarratives(charId).filter((n) => n.status === 'active');
  const dirty = [];
  const sealReview = [];
  const stale = [];

  const unlinked = db.prepare(
    `SELECT id, content, embedding, weight, created_at FROM memories
     WHERE character_id=? AND COALESCE(archived,0)=0 ORDER BY id DESC LIMIT 120`
  ).all(charId);
  const allLinked = require('./memory-tree-helper').collectAllTreeLinkedIds(charId);
  const freeFrags = unlinked.filter((m) => !allLinked.has(m.id));
  const staleCorpus = require('./memory-brain-helper').getCharCorpus(charId);

  for (const n of actives) {
    if (isDirty(n)) dirty.push(n);

    const age = daysBetween(n.content_updated_at || n.created_at);
    if (age >= STALE_DAYS && !isFullForRouting(n) && freeFrags.length) {
      const hits = scoreTextsAgainst(n.content, freeFrags, { corpus: staleCorpus })
        .filter((s) => s >= STALE_COS).length;
      if (hits >= 3) stale.push({ narrative: n, hits });
    }
  }
  stale.sort((a, b) => b.hits - a.hits);
  return { dirty, sealReview, stale: stale.slice(0, 3), settings };
}

function parseFragMeta(frag) {
  let meta = frag?.meta;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  return meta && typeof meta === 'object' ? meta : {};
}

function pickDigestMoodZh(char, evidence) {
  const eh = require('./emotion-helper');
  let best = '';
  let bestCharge = 0;
  for (const m of evidence || []) {
    const meta = parseFragMeta(m);
    const label = meta.mood_label || meta.emotion?.label;
    const charge = eh.witherChargeForPrimary(label);
    if (charge > bestCharge) {
      bestCharge = charge;
      best = eh.officialMoodZh(label);
    }
  }
  return best || eh.officialMoodZhFromChar(char);
}

function extractLineStance(text) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  const idx = raw.search(/整条线心境/);
  if (idx >= 0) {
    let chunk = raw.slice(idx).replace(/^整条线心境[：:\s]*/, '');
    chunk = chunk.split(/\n\s*(?:此拍心境|时间线|关键节点)/)[0].trim();
    if (chunk.length >= 8) return chunk.slice(0, 400);
  }
  const parts = raw.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
  return (parts.slice(-3).join('') || raw).slice(0, 400);
}

async function digestNarrative(charId, narrative, reason, evidenceFrags = []) {
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return { ok: false };
  const linkedIds = parseIds(narrative.linked_memory_ids);
  const frags = linkedIds.length
    ? db.prepare(
      `SELECT id, category, content, date, weight, meta FROM memories WHERE id IN (${linkedIds.map(() => '?').join(',')})`
    ).all(...linkedIds)
    : [];
  const evidence = [...frags, ...evidenceFrags].slice(0, 24);
  const userName = settings.username || '旅人';
  const eh = require('./emotion-helper');
  const moodZh = pickDigestMoodZh(char, evidence);
  const moodList = Object.values(eh.PRIMARY_LABELS).join('、');

  const systemPrompt = `你是角色「${char.name}」，正在维护自己的「记忆点」（第一人称：跨天同一件事的归类节点）。
写一段记忆点正文（目标 ${CONTENT_SOFT_MAX} 字内，硬上限 ${CONTENT_HARD_MAX}）：
结构建议：
1）这件事是什么（编名依据：一句话说清主题）
2）时间线上的关键节点（起止与转折；延续事件写进同一点，不要拆成多件事）
3）此拍心境：用两三句话写此刻你对这件事怎么想（不要只写一个词，不要长篇宣泄）
4）整条线心境：再用两三句话写整根主枝现在怎么看；若是续挂，更新这一段，旧拍的心境留在时间线里
心情必须写成「心情：${moodZh}。」（官方心情词只这一个：${moodList}。它决定这根枝枯得快慢，不要换成花词或别的词。）
纪律：有碎片依据的事实才写；用户称「${userName}」亦可，但主体视角是你（${char.name}）在回忆。
【忌流水账·硬性】融合成一条发展线，不要把证据碎片原文拼接；同一导火索/同一句态度/同一个结果只出现一次；只留关键转折，省略琐碎过程。
落笔前先在心里回答（不要把问答写进正文）：
1. 这条新碎片跟哪个旧记忆点最相关？（语境判断，不是关键词匹配）
2. 这次进展是延续原判断、发生转折，还是推翻了原判断？
3. 「此拍心境」和「整条线心境」具体变了什么；禁止套「看法有所加深」这类空话。
只输出正文，不要 markdown 代码块，不要 JSON。`;

  const userPrompt = [
    `【维护原因】${reason}`,
    `【记忆点编名】${narrative.title || '未命名'}`,
    `【官方心情】${moodZh}`,
    `【旧正文】\n${narrative.content || '（空）'}`,
    `【证据碎片】\n${evidence.map((m) => `- [#${m.id}][${m.category || ''}] ${m.content}`).join('\n') || '（无）'}`,
  ].join('\n\n');

  try {
    const raw = await callChatAPIComplete(settings, systemPrompt, userPrompt, 'memory');
    const text = String(raw || '').trim();
    if (!text || text.length < 40) return { ok: false, reason: 'short' };
    setNarrativeContent(narrative.id, text, { refreshLinksTs: true });
    try {
      const stance = extractLineStance(text);
      db.prepare(`UPDATE memory_narratives SET mood_label=?, stance=? WHERE id=?`).run(moodZh, stance, narrative.id);
      require('./memory-tree-helper').applyTouch('trunk', narrative.id, {
        charge: eh.witherChargeForPrimary(moodZh),
        moodLabel: moodZh,
        weak: true,
      });
    } catch { /* ignore */ }
    return { ok: true };
  } catch (e) {
    console.warn('[narrative] digest', e.message);
    return { ok: false, reason: e.message };
  }
}

async function digestDue(charId) {
  const { dirty, stale } = collectDirtyAndStale(charId);
  // 一次一个焦点：优先 dirty → stale（不再因条数封卷）
  if (dirty.length) {
    const n = dirty[0];
    const r = await digestNarrative(charId, n, 'dirty：有新阶段挂入，需融进记忆点并刷新心境');
    return { focus: 'dirty', id: n.id, ...r };
  }
  if (stale.length) {
    const { narrative: n, hits } = stale[0];
    const allLinked = require('./memory-tree-helper').collectAllTreeLinkedIds(charId);
    const free = db.prepare(
      `SELECT id, category, content, date, weight, embedding, meta FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0 ORDER BY id DESC LIMIT 80`
    ).all(charId).filter((m) => !allLinked.has(m.id));
    const freeScores = scoreTextsAgainst(n.content, free, {
      corpus: require('./memory-brain-helper').getCharCorpus(charId),
    });
    const evidence = free
      .map((f, i) => ({ f, s: freeScores[i] || 0 }))
      .filter((x) => x.s >= STALE_COS)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map((x) => x.f);
    const tree = require('./memory-tree-helper');
    const settings = getSettings();
    const actives = listActiveNarratives(charId);
    for (const f of evidence.slice(0, 3)) {
      const routed = await tree.routeFragmentToTrees(charId, f, { settings, actives });
      if (!routed.linked) appendLink(n.id, f.id);
    }
    const r = await digestNarrative(charId, getNarrative(n.id), `stale：正文≥${STALE_DAYS}天且主题仍有 ${hits} 条未链碎片流入`, evidence);
    return { focus: 'stale', id: n.id, ...r };
  }
  return { focus: 'none', ok: true };
}

function buildSimilarityGraph(items, getEmb, edgeMin = CLUSTER_EDGE, k = 10, corpus = null) {
  const n = items.length;
  const edges = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    // 词法回落走 scoreTextsAgainst：这里以前用 lexicalVector 的余弦，
    // 64 维哈希让所有碎片两两都过线，连通块会糊成一坨
    const lex = scoreTextsAgainst(items[i].content, items, { corpus });
    const scored = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = getEmb(items[i]);
      const b = getEmb(items[j]);
      const s = (a?.kind === 'api' && b?.kind === 'api' && a.vec && b.vec)
        ? cosine(a.vec, b.vec)
        : (lex[j] || 0);
      if (s >= edgeMin) scored.push({ j, s });
    }
    scored.sort((x, y) => y.s - x.s);
    for (const { j, s } of scored.slice(0, k)) {
      edges[i].push({ j, s });
    }
  }
  return edges;
}

function connectedComponents(n, edges) {
  const seen = new Array(n).fill(false);
  const comps = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const stack = [i];
    const comp = [];
    seen[i] = true;
    while (stack.length) {
      const u = stack.pop();
      comp.push(u);
      for (const { j } of edges[u] || []) {
        if (!seen[j]) {
          seen[j] = true;
          stack.push(j);
        }
      }
    }
    if (comp.length >= 2) comps.push(comp);
  }
  return comps;
}

function normalizeRerankIds(rawIds, candidates) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out = [];
  for (const raw of rawIds || []) {
    const n = Number(raw);
    if (byId.has(n)) {
      out.push(n);
      continue;
    }
    // 序号 1-based → 映射
    if (Number.isFinite(n) && n >= 1 && n <= candidates.length) {
      out.push(candidates[n - 1].id);
    }
  }
  return [...new Set(out)];
}

async function clusterAndMaybeCreate(charId) {
  const settings = getSettings();
  const tree = require('./memory-tree-helper');
  const linkedSet = tree.collectAllTreeLinkedIds(charId);
  const livingN = listActiveNarratives(charId).filter((n) => !tree.isFallen(n)).length;
  const minPool = livingN === 0 ? 2 : 3;
  const edgeMin = livingN === 0 ? 0.38 : CLUSTER_EDGE;

  const pool = db.prepare(
    `SELECT id, content, embedding, weight, category, consolidate_rejects, status FROM memories
     WHERE character_id=? AND COALESCE(archived,0)=0
     ORDER BY id DESC LIMIT 100`
  ).all(charId).filter((m) =>
    !linkedSet.has(m.id)
    && String(m.status || 'current') !== 'historical'
    && (m.weight || 0.5) >= SEED_IMPORTANCE
    && (m.consolidate_rejects || 0) < 2
  );

  if (pool.length < minPool) return { ok: true, created: false, reason: 'pool_small' };

  for (const m of pool.slice(0, 40)) {
    await ensureChatMemoryEmbedding(m, settings);
  }
  const refreshed = pool.map((m) => db.prepare('SELECT id, content, embedding, weight, category, consolidate_rejects FROM memories WHERE id=?').get(m.id));

  const getEmb = (row) => parseStoredEmbedding(row.embedding) || { kind: 'lex', vec: lexicalVector(row.content) };
  const edges = buildSimilarityGraph(refreshed, getEmb, edgeMin, 10,
    require('./memory-brain-helper').getCharCorpus(charId));
  const idToIdx = new Map(refreshed.map((m, i) => [m.id, i]));
  try {
    const linkRows = db.prepare(
      `SELECT from_id, to_id FROM memory_links WHERE character_id=? AND type='same_event'`
    ).all(charId);
    for (const row of linkRows) {
      const i = idToIdx.get(row.from_id);
      const j = idToIdx.get(row.to_id);
      if (i == null || j == null) continue;
      edges[i].push({ j, s: 1 });
      edges[j].push({ i, s: 1 });
    }
  } catch (_) { /* ignore */ }
  const comps = connectedComponents(refreshed.length, edges);
  if (!comps.length) return { ok: true, created: false, reason: 'no_cluster' };

  const ranked = comps.map((comp) => ({
    comp,
    importance: comp.reduce((s, i) => s + (refreshed[i].weight || 0.5), 0),
  })).sort((a, b) => b.importance - a.importance);

  const top = ranked[0].comp.slice(0, 10).map((i) => refreshed[i]);

  // rerank
  let keepIds = top.map((t) => t.id);
  try {
    const raw = await callChatAPIComplete(
      settings,
      `你在判断若干记忆碎片是否属于「同一个记忆点」（同一件进行中的事，允许跨天延续）。
例：先说「报考了考试」，几天后说「开始看书备考」→ 必须同一点（后者是前者延续）。
对每条输出 0/1/2 分：2=同一件事应挂进该点；1=仅相关默认不挂；0=噪音。
只输出 JSON：{"scores":[{"id":数字,"score":0|1|2}]}
id 必须用给定的真实 id。`,
      top.map((t) => `id=${t.id}\n${t.content}`).join('\n---\n'),
      'memory'
    );
    let parsed = null;
    try {
      const m = String(raw).match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch { /* ignore */ }
    if (parsed?.scores?.length) {
      const mapped = normalizeRerankIds(parsed.scores.map((s) => s.id), top);
      if (!mapped.length) {
        console.warn('[narrative] rerank id mismatch — treat as failure');
      } else {
        const scoreById = new Map();
        for (const s of parsed.scores) {
          const ids = normalizeRerankIds([s.id], top);
          if (ids[0] != null) scoreById.set(ids[0], Number(s.score));
        }
        keepIds = [];
        for (const t of top) {
          const sc = scoreById.has(t.id) ? scoreById.get(t.id) : 1;
          if (sc === 0) {
            db.prepare('UPDATE memories SET consolidate_rejects=COALESCE(consolidate_rejects,0)+1 WHERE id=?').run(t.id);
          } else if (sc >= 2) {
            keepIds.push(t.id);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[narrative] rerank', e.message);
  }

  if (keepIds.length < 2) {
    if (livingN === 0 && top.length >= 2) {
      keepIds = top.slice(0, 2).map((t) => t.id);
    } else {
      return { ok: true, created: false, reason: 'rerank_reject' };
    }
  }

  const keepFrags = refreshed.filter((r) => keepIds.includes(r.id));
  const cent = centroidOfEmbeddings(keepFrags.map((f) => getEmb(f)));
  const actives = listActiveNarratives(charId).filter((n) => !isFullForRouting(n));
  let mergeInto = null;
  if (cent && actives.length) {
    for (const n of actives) await ensureNarrativeEmbedding(n, settings);
    const rows = actives.map((n) => getNarrative(n.id));
    const blob = keepFrags.map((f) => f.content).join('\n');
    const lexScores = scoreTextsAgainst(blob, rows, {
      corpus: require('./memory-brain-helper').getCharCorpus(charId),
    });
    rows.forEach((row, i) => {
      const nEmb = parseStoredEmbedding(row?.embedding);
      const s = (cent.kind === 'api' && nEmb?.kind === 'api')
        ? cosine(cent.vec, nEmb.vec)
        : (lexScores[i] || 0);
      if (s >= RELATED_EVENT_COS && (!mergeInto || s > mergeInto.score)) {
        mergeInto = { id: row.id, score: s };
      }
    });
  }

  try {
    const placeholders = keepIds.map(() => '?').join(',');
    const linkRows = db.prepare(
      `SELECT from_id, to_id FROM memory_links
       WHERE character_id=? AND type='same_event'
         AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`
    ).all(charId, ...keepIds, ...keepIds);
    const neighborIds = new Set();
    for (const row of linkRows) {
      neighborIds.add(row.from_id);
      neighborIds.add(row.to_id);
    }
    for (const n of actives) {
      const ids = parseIds(n.linked_memory_ids);
      if (ids.some((id) => neighborIds.has(id))) {
        mergeInto = { id: n.id, score: Math.max(mergeInto?.score || 0, 0.72) };
        break;
      }
    }
  } catch (_) { /* ignore */ }

  if (mergeInto && mergeInto.score >= 0.62) {
    const tree = require('./memory-tree-helper');
    const activesNow = listActiveNarratives(charId);
    for (const id of keepIds) {
      const frag = db.prepare(
        `SELECT id, content, embedding, weight, category, meta FROM memories WHERE id=?`
      ).get(id);
      const routed = await tree.routeFragmentToTrees(charId, frag, { settings, actives: activesNow });
      if (!routed.linked) appendLink(mergeInto.id, id);
    }
    try {
      require('./memory-brain-helper').autoLinkNewMemories(charId, keepIds);
    } catch (_) { /* ignore */ }
    return { ok: true, created: false, merged: mergeInto.id, linked: keepIds.length };
  }

  // 建新记忆点：本人写正文
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  const userName = settings.username || '旅人';
  let title = '一件事';
  let content = keepFrags.map((f) => f.content).join('\n').slice(0, 400);
  let extractedComps = [];
  let extractedKind = 'event';
  try {
    const raw = await callChatAPIComplete(
      settings,
      `你是角色「${char?.name || ''}」，根据证据碎片新建一个「记忆点」（跨天同一件事的归类节点，第一人称）。
输出 JSON（不要 markdown）：
{"kind":"event|daily|affection","title":"8字内编名","content":"①这件事是什么 ②时间线关键节点 ③我现在怎么看（短），共${CONTENT_SOFT_MAX}字内","components":[{"key":"core","name":"主题短名","type":"core|person|thing|place","aliases":["别称"]}]}
kind 三选一：event=有后续发展的事；daily=反复日常习惯（运动/通勤/作息），无强剧情；affection=关系起伏（表白/冷战/和好）。不要用 user/self（画像另走）。
必须有一项 type=core。其余只写证据里出现的人/物/场景。同类零件必须拆开（两个同事不要合成一项）。aliases 不要用能套到另一个零件上的泛称。
用户可称「${userName}」。延续事件必须写进同一点，禁止拆成多件事；勿写成日记宣泄。`,
      keepFrags.map((f) => `- [#${f.id}] ${f.content}`).join('\n'),
      'memory'
    );
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      if (o.title) title = String(o.title).slice(0, 40);
      if (o.content) content = String(o.content).slice(0, CONTENT_HARD_MAX);
      if (Array.isArray(o.components)) extractedComps = o.components;
      if (o.kind) extractedKind = o.kind;
    }
  } catch (e) {
    console.warn('[narrative] create body', e.message);
  }

  if (!extractedKind) {
    try {
      const tree0 = require('./memory-tree-helper');
      extractedKind = tree0.classifyFragKind(keepFrags[0] || {}, char?.name, userName);
      if (extractedKind === 'user' || extractedKind === 'self') extractedKind = 'event';
    } catch {
      extractedKind = 'event';
    }
  }

  const newId = createNarrative(charId, { title, content, linkedIds: keepIds, kind: extractedKind });
  try {
    const tree = require('./memory-tree-helper');
    const row = getNarrative(newId);
    if (extractedComps.length) {
      tree.saveComponents(newId, extractedComps);
      tree.syncBranchesFromComponents(getNarrative(newId));
    } else {
      await tree.ensureNarrativeTree(row, settings, char);
    }
  } catch (e) {
    console.warn('[narrative] create tree', e.message);
  }
  try {
    require('./memory-brain-helper').autoLinkNewMemories(charId, keepIds);
  } catch (_) { /* ignore */ }
  return { ok: true, created: true, id: newId };
}


/**
 * 调度：睡前整理（分割成记忆点+挂枝）→ 分诊兜底 → 消化 →（账净才）聚类
 * 有欠账时只消化，不跑聚类。
 */
async function runConsolidationForCharacter(charId, { forceCluster = false } = {}) {
  try {
    const tree = require('./memory-tree-helper');
    // 睡前整理是主路：当天碎片连接去重、分割成记忆点、按组成部分挂枝。
    // 剩下没归进任何记忆点的零散碎片，才交给下面的分诊/聚类兜底。
    const graft = await require('./memory-day-helper').consolidateDays(charId);
    const triage = await triageNewMemories(charId);
    const debts = collectDirtyAndStale(charId);
    const hasDebt = debts.dirty.length || debts.stale.length;
    let digest = { focus: 'none' };
    if (hasDebt) {
      digest = await digestDue(charId);
    }
    const living = listActiveNarratives(charId).filter((n) => !tree.isFallen(n));
    const bare = living.length === 0;
    let cluster = { skipped: true };
    if (forceCluster || bare) {
      cluster = await clusterAndMaybeCreate(charId);
    } else if (hasDebt) {
      cluster = { skipped: true, reason: 'debt' };
    }
    return { graft, triage, digest, cluster };
  } catch (e) {
    console.warn('[narrative] consolidate char', charId, e.message);
    return { ok: false, error: e.message };
  }
}

async function runNightlyNarrativeMaintenance({ heavy = false } = {}) {
  const tree = require('./memory-tree-helper');
  let decayed = 0;
  try { decayed = tree.decayAllCharacters(); } catch (e) {
    console.warn('[narrative] decay', e.message);
  }
  const chars = db.prepare('SELECT id FROM characters').all();
  const results = [];
  for (const c of chars) {
    // 只跳过一条记忆都没有的角色：睡前整理本来就该处理当天那几条碎片，
    // 原来卡 3 条会让刚开始聊的角色永远整理不到
    const memCount = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE character_id=?').get(c.id)?.n || 0;
    if (memCount < 1) continue;
    const r = await runConsolidationForCharacter(c.id, { forceCluster: heavy });
    results.push({ charId: c.id, ...r });
  }
  return { decayed, results };
}

/** 聊天注入：相关记忆点（同步，词法/已存向量）；休眠/凉点按温度门槛裁 */
function selectNarrativesForPrompt(charId, contextText, { topK = 2, minScore = 0.28, forceIds = [] } = {}) {
  const ctx = String(contextText || '').trim();
  if (!ctx) return [];
  const tree = require('./memory-tree-helper');
  try { tree.maybeReviveFallen(charId, ctx); } catch { /* ignore */ }
  const actives = listActiveNarratives(charId);
  if (!actives.length) return [];
  const corpus = require('./memory-brain-helper').getCharCorpus(charId);
  const scores = scoreTextsAgainst(ctx, actives, { corpus });
  const scored = actives.map((n, i) => ({
    n: { ...n, _dirty: isDirty(n) },
    score: scores[i] || 0,
  }));
  scored.sort((a, b) => b.score - a.score);
  return pickScoredNarratives(scored, ctx, tree, { topK, minScore, forceIds });
}

function pickScoredNarratives(scored, ctx, tree, { topK = 2, minScore = 0.28, forceIds = [] } = {}) {
  const top = scored[0]?.score || 0;
  const withMeta = (x) => ({ ...x.n, score: x.score });
  const picked = scored
    .filter((x) => passRelevance(x.score, top, { floor: minScore })
      && tree.injectionAllowed(x.n, x.score, ctx))
    .slice(0, topK)
    .map(withMeta);
  const have = new Set(picked.map((n) => n.id));
  const forceSet = new Set((forceIds || []).map(Number).filter(Boolean));
  for (const x of scored) {
    if (!forceSet.has(x.n.id) || have.has(x.n.id)) continue;
    picked.push({ ...withMeta(x), _forced: true });
    have.add(x.n.id);
  }
  return picked;
}

function formatNarrativeInjection(narratives, ctx = '') {
  return require('./memory-tree-helper').formatTreeInjection(narratives, ctx);
}

/** 异步：用 API query embedding 精排记忆点 */
async function selectNarrativesForPromptAsync(charId, contextText, opts = {}) {
  const settings = getSettings();
  const ctx = String(contextText || '').trim();
  if (!ctx) return [];
  const tree = require('./memory-tree-helper');
  try { tree.maybeReviveFallen(charId, ctx); } catch { /* ignore */ }
  const qEmb = await embedText(ctx, settings);
  const actives = listActiveNarratives(charId);
  if (!actives.length) return [];
  const rows = [];
  for (const n of actives) {
    await ensureNarrativeEmbedding(n, settings);
    rows.push(getNarrative(n.id));
  }
  const corpus = require('./memory-brain-helper').getCharCorpus(charId);
  const scores = scoreTextsAgainst(ctx, rows, { queryEmb: qEmb, corpus });
  const scored = rows.map((row, i) => ({
    n: { ...row, _dirty: isDirty(row) },
    score: scores[i] || 0,
  }));
  scored.sort((a, b) => b.score - a.score);
  return pickScoredNarratives(scored, ctx, tree, {
    topK: opts.topK ?? 2,
    minScore: opts.minScore ?? 0.28,
    forceIds: opts.forceIds || [],
  });
}

function scheduleRouteMemoryIds(charId, ids) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) return;
  Promise.resolve().then(async () => {
    try {
      const tree = require('./memory-tree-helper');
      await tree.routeMemoryIds(charId, list, getSettings());
      const living = listActiveNarratives(charId).filter((n) => !tree.isFallen(n));
      // 树还空着时先按话题破土，别让相似度聚类先长出一根拼凑的枝
      if (!living.length) await require('./memory-day-helper').consolidateDays(charId);
    } catch (e) {
      console.warn('[narrative] route memories', e.message);
    }
  }).catch(() => {});
}

module.exports = {
  ensureChatMemoryEmbedding,
  ensureNarrativeEmbedding,
  scheduleEmbedMemoryIds,
  listActiveNarratives,
  listAllNarratives,
  getNarrative,
  parseIds,
  linkedCount,
  isDirty,
  createNarrative,
  closeNarrative,
  setNarrativeContent,
  appendLink,
  triageNewMemories,
  digestDue,
  clusterAndMaybeCreate,
  runConsolidationForCharacter,
  runNightlyNarrativeMaintenance,
  selectNarrativesForPrompt,
  selectNarrativesForPromptAsync,
  formatNarrativeInjection,
  scheduleRouteMemoryIds,
  collectDirtyAndStale,
};

/**
 * 公共向量：全项目 embeddings（设置「向量 API」）+ 本地词法回落。
 * 日常记忆检索、叙事卷、穿越记忆共用同一套接口。
 */
const { resolveTaskApiCreds } = require('./api-helper');

function tokenizeForEmbed(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, '');
  const grams = new Map();
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (/[\u4e00-\u9fffa-z0-9]/.test(c)) grams.set(c, (grams.get(c) || 0) + 1);
    if (i + 1 < t.length) {
      const bg = t.slice(i, i + 2);
      if (/[\u4e00-\u9fff]{2}|[a-z0-9]{2}/.test(bg)) grams.set(bg, (grams.get(bg) || 0) + 1);
    }
  }
  return grams;
}

function lexicalVector(text) {
  const grams = tokenizeForEmbed(text);
  const dim = 64;
  const vec = new Array(dim).fill(0);
  for (const [k, v] of grams) {
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    vec[h % dim] += v;
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function parseJson(raw, fallback = null) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return fallback; }
}

function parseStoredEmbedding(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && Array.isArray(raw.vec)) return raw;
  const o = typeof raw === 'string' ? parseJson(raw, null) : raw;
  if (o && Array.isArray(o.vec)) return o;
  if (Array.isArray(o)) return { kind: 'api', vec: o };
  return null;
}

async function fetchApiEmbedding(text, settings) {
  const { url, apiKey, model } = resolveTaskApiCreds(settings || {}, 'embed');
  if (!url || !apiKey) return null;
  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  const embedModel = String(model || '').trim();
  if (!embedModel) return null;
  const body = JSON.stringify({
    model: embedModel,
    input: String(text || '').slice(0, 2000),
  });
  async function tryFetch(apiUrl) {
    const resp = await fetch(`${apiUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      timeout: 30000,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`embed ${resp.status}: ${err.slice(0, 120)}`);
    }
    return resp.json();
  }
  try {
    let data;
    try {
      data = await tryFetch(baseUrl);
    } catch (e1) {
      if (!baseUrl.endsWith('/v1')) data = await tryFetch(`${baseUrl}/v1`);
      else throw e1;
    }
    const vec = data?.data?.[0]?.embedding || data?.embedding;
    if (!Array.isArray(vec) || !vec.length) return null;
    return vec.map(Number);
  } catch (e) {
    console.warn('[embed] api', e.message);
    return null;
  }
}

async function embedText(text, settings) {
  const apiVec = await fetchApiEmbedding(text, settings);
  if (apiVec) return { kind: 'api', vec: apiVec };
  return { kind: 'lex', vec: lexicalVector(text) };
}

/* ═══════════════════════════════════════════════════════
   相关度打分
   没配向量 API 时不能再走 lexicalVector 的余弦：那是 64 维哈希，
   实测无关文本之间也有 0.6 以上，区分度只有 0.06，等于噪声。
   改成 idf 加权的词项覆盖率——到处都是的口水词权重自然趋近 0，
   只有共享了「有辨识度的词」才拿得到分。
   ═══════════════════════════════════════════════════════ */

// 语料够大时 idf 会自己把口水词压平；但角色刚开始聊时语料就几条，
// 「什么」只要恰好出现在一条记忆里就会被当成专名，所以先兜一层
const STOP_BIGRAMS = new Set((
  '什么 怎么 这个 那个 这些 那些 一下 一点 一直 一样 一起 一个 两个 一次 一些 '
  + '还是 就是 不是 不会 不用 不要 可以 应该 已经 现在 今天 昨天 明天 最近 以后 '
  + '有点 觉得 知道 想要 没有 我们 你们 他们 自己 时候 时间 因为 所以 但是 如果 '
  + '这样 那样 这么 那么 真的 好像 感觉 可能 需要 东西 事情 地方 样子 '
  + '起来 下去 出来 过去 回来 很多 非常 特别 有些 别的 还有 然后 而且 或者 '
  + '之后 之前 上次 下次 这次 时间 一直 有没 没有 是不 不好 好了 了吗 的话 '
  + '自己 对方 旅人 用户'
).split(/\s+/).filter(Boolean));

/** 打分用的词项：中文二元词（去口水词）+ 字母数字串（N2、cet6 这类专名） */
function scoringTerms(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) {
    const bg = t.slice(i, i + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(bg) && !STOP_BIGRAMS.has(bg)) out.add(bg);
  }
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  return out;
}

/** 语料的文档频率，用来算 idf。角色的记忆越多，口水词被压得越平 */
function buildCorpusDf(texts) {
  const df = new Map();
  let size = 0;
  for (const txt of texts || []) {
    const s = scoringTerms(txt);
    if (!s.size) continue;
    size += 1;
    for (const k of s) df.set(k, (df.get(k) || 0) + 1);
  }
  return { df, size };
}

// API 向量的余弦：现代 embedding 模型下无关中文文本大约 0.55，明确相关 0.85 以上。
// 映射到 0..1 的相关度，好让上层只用一套阈值，不必关心底下是向量还是词法。
const API_COS_FLOOR = 0.55;
const API_COS_CEIL = 0.85;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * 一个查询 对 一组候选，返回 0..1 的相关度。
 * 两边都有 API 向量就用向量；否则用 idf 覆盖率。
 * corpus 传角色的整个语料时判得最准；不传就拿这批候选临时算。
 */
function scoreTextsAgainst(queryText, docs, { queryEmb = null, corpus = null } = {}) {
  const list = (docs || []).map((d) => (typeof d === 'string' ? { content: d } : (d || {})));
  if (!list.length) return [];
  const qText = String(queryText || '');
  if (!qText.trim()) return list.map(() => 0);

  // 两边都有 API 向量的走向量路
  const qEmb = parseStoredEmbedding(queryEmb);
  const useApi = qEmb?.kind === 'api' && qEmb.vec?.length;
  const apiScores = new Map();
  if (useApi) {
    list.forEach((d, i) => {
      const e = parseStoredEmbedding(d.embedding);
      if (e?.kind === 'api' && e.vec?.length) {
        apiScores.set(i, clamp01((cosine(qEmb.vec, e.vec) - API_COS_FLOOR) / (API_COS_CEIL - API_COS_FLOOR)));
      }
    });
  }

  const qt = scoringTerms(qText);
  const dts = list.map((d) => scoringTerms(d.content));
  const { df, size } = corpus && corpus.df ? corpus : buildCorpusDf(list.map((d) => d.content));
  const N = Math.max(size, dts.length) + 1;
  const idf = (k) => Math.max(0, Math.log((N + 1) / ((df.get(k) || 0) + 0.5)));

  // 只看「查询里确实能在某个候选里找到」的词，长查询不会被无关内容稀释
  const matchable = [...qt].filter((k) => dts.some((d) => d.has(k)));
  const denom = matchable.reduce((s, k) => s + idf(k), 0);

  return list.map((_, i) => {
    if (apiScores.has(i)) return apiScores.get(i);
    if (!denom) return 0;
    const mass = matchable.filter((k) => dts[i].has(k)).reduce((s, k) => s + idf(k), 0);
    // 覆盖率 × 分量：只蹭到一两个轻词的不算相关
    return clamp01((mass / denom) * (mass / (mass + 1.2)) * 2);
  });
}

/** 只有一个候选时的便捷写法；corpus 建议传，否则分母退化成候选自己 */
function scoreTextAgainst(queryText, content, { embedding, queryEmb, corpus } = {}) {
  return scoreTextsAgainst(queryText, [{ content, embedding }], { queryEmb, corpus })[0] || 0;
}

/**
 * 相关项要同时过两道闸：绝对分够高，且没被最高分甩太远。
 * 只用绝对闸时，聊天上下文很长的场合会有蹭词的候选勉强够线。
 */
function passRelevance(score, topScore, { floor = 0.25, ratio = 0.45 } = {}) {
  if (score < floor) return false;
  if (topScore > 0 && score < topScore * ratio) return false;
  return true;
}

function centroidOfEmbeddings(embList) {
  const usable = embList.filter((e) => e?.vec?.length);
  if (!usable.length) return null;
  const dim = usable[0].vec.length;
  const acc = new Array(dim).fill(0);
  let n = 0;
  for (const e of usable) {
    if (e.vec.length !== dim) continue;
    for (let i = 0; i < dim; i++) acc[i] += e.vec[i];
    n++;
  }
  if (!n) return null;
  const avg = acc.map((x) => x / n);
  const norm = Math.sqrt(avg.reduce((s, x) => s + x * x, 0)) || 1;
  return { kind: usable[0].kind || 'lex', vec: avg.map((x) => x / norm) };
}

module.exports = {
  tokenizeForEmbed,
  lexicalVector,
  cosine,
  parseStoredEmbedding,
  fetchApiEmbedding,
  embedText,
  scoringTerms,
  buildCorpusDf,
  scoreTextsAgainst,
  scoreTextAgainst,
  passRelevance,
  centroidOfEmbeddings,
};

/**
 * 本地面容指纹：浏览器提取的几何向量，服务端余弦比对。
 * 不调用聊天模型；只在提示词里可选加一句文字。照片不入库。
 */

const FACEPRINT_SETTING_KEY = 'user_faceprint';
const FACEPRINT_VERSION = 1;
const DEFAULT_MATCH = 0.92;
const DEFAULT_MISMATCH = 0.84;

function l2normalize(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const n = Math.sqrt(s) || 1;
  return vec.map((v) => v / n);
}

function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

function averageEmbeddings(list) {
  if (!list?.length) return null;
  const dim = list[0].length;
  const acc = new Array(dim).fill(0);
  let n = 0;
  for (const e of list) {
    if (!e || e.length !== dim) continue;
    for (let i = 0; i < dim; i++) acc[i] += Number(e[i]) || 0;
    n += 1;
  }
  if (!n) return null;
  for (let i = 0; i < dim; i++) acc[i] /= n;
  return l2normalize(acc);
}

function sanitizeEmbedding(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 80 || raw.length > 512) return null;
  const vec = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) > 8) return null;
    vec.push(n);
  }
  return l2normalize(vec);
}

function parseEmbedding(body = {}) {
  if (!body || typeof body !== 'object') return null;
  return sanitizeEmbedding(body.faceEmbedding ?? body.face_embedding ?? body.embedding ?? body.faceprint);
}

function parseIdentityHint(body = {}) {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body.faceIdentity ?? body.face_identity ?? body.userIdentity ?? body.identity;
  if (raw == null || raw === '') return undefined;
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 'match';
  const key = String(raw).trim().toLowerCase();
  if (key === 'match' || key === 'self' || key === 'user' || key === 'me') return 'match';
  if (key === 'mismatch' || key === 'other' || key === 'stranger' || key === 'not_me') return 'mismatch';
  if (key === 'uncertain' || key === 'unknown') return 'uncertain';
  if (key === 'none' || key === 'off') return 'none';
  return undefined;
}

function loadStoredFaceprint(getSettingsFn) {
  try {
    const s = getSettingsFn?.() || {};
    const raw = s[FACEPRINT_SETTING_KEY] || s.user_faceprint || '';
    if (!raw) return null;
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    const photos = Array.isArray(obj.photos) ? obj.photos.filter((p) => String(p || '').trim()) : [];
    if (!photos.length && !obj?.embedding?.length) return null;
    return { ...obj, photos };
  } catch {
    return null;
  }
}

function saveFaceprint(setSettingFn, data) {
  setSettingFn(FACEPRINT_SETTING_KEY, JSON.stringify(data));
}

function clearFaceprint(setSettingFn) {
  setSettingFn(FACEPRINT_SETTING_KEY, '');
}

function publicFaceprintStatus(stored) {
  const photos = stored?.photos?.length || 0;
  const hasEmbed = !!stored?.embedding?.length;
  if (!photos && !hasEmbed) {
    return { enrolled: false, enrolledAt: null, samples: 0, photos: 0, enrollNext: false };
  }
  return {
    enrolled: true,
    enrolledAt: stored.enrolledAt || null,
    samples: stored.samples || photos || 1,
    photos,
    viaPhoto: photos > 0,
  };
}

function enrollFromPhotoUrls(urls, getSettingsFn, setSettingFn, { merge = true } = {}) {
  const clean = [];
  for (const u of urls || []) {
    const s = String(u || '').trim();
    if (!s) continue;
    if (s.startsWith('/uploads/') || s.startsWith('uploads/')) {
      clean.push(s.startsWith('/') ? s : `/${s}`);
    }
  }
  if (!clean.length) throw new Error('没有可用的面容照片');
  const prev = merge ? loadStoredFaceprint(getSettingsFn) : null;
  const photos = [...(merge && prev?.photos ? prev.photos : []), ...clean]
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .slice(-8);
  const data = {
    version: 2,
    photos,
    enrolledAt: new Date().toISOString(),
    samples: photos.length,
  };
  saveFaceprint(setSettingFn, data);
  return publicFaceprintStatus(data);
}

function classifyScore(score, stored) {
  if (!stored?.embedding?.length) return 'none';
  const matchT = Number(stored.matchThreshold) || DEFAULT_MATCH;
  const misT = Number(stored.mismatchThreshold) || DEFAULT_MISMATCH;
  if (score >= matchT) return 'match';
  if (score <= misT) return 'mismatch';
  return 'uncertain';
}

function verifyEmbeddingAgainstStored(embedding, getSettingsFn) {
  const stored = loadStoredFaceprint(getSettingsFn);
  const live = sanitizeEmbedding(embedding);
  if (!stored?.embedding?.length) {
    return { result: 'none', score: 0 };
  }
  if (!live || live.length !== stored.embedding.length) {
    return { result: 'uncertain', score: 0 };
  }
  const score = cosineSimilarity(live, stored.embedding);
  return { result: classifyScore(score, stored), score };
}

function enrollFromEmbeddings(rawList, getSettingsFn, setSettingFn, { merge = true } = {}) {
  const cleaned = [];
  for (const raw of rawList || []) {
    const e = sanitizeEmbedding(raw);
    if (e) cleaned.push(e);
  }
  if (!cleaned.length) throw new Error('没有可用的面容样本，请正对镜头再试');
  const dim = cleaned[0].length;
  if (cleaned.some((e) => e.length !== dim)) {
    throw new Error('面容样本维度不一致，请重新录入');
  }

  let final = averageEmbeddings(cleaned);
  const prev = merge ? loadStoredFaceprint(getSettingsFn) : null;
  if (prev?.embedding?.length && prev.embedding.length === dim && merge) {
    final = averageEmbeddings([prev.embedding, final]);
  }

  const refs = prev?.embedding?.length === dim && merge
    ? [...cleaned, prev.embedding]
    : cleaned;
  const sims = refs.map((e) => cosineSimilarity(e, final));
  const minIntra = Math.min(...sims);
  const matchThreshold = Math.max(0.88, Math.min(0.97, (Number.isFinite(minIntra) ? minIntra : DEFAULT_MATCH) - 0.025));
  const mismatchThreshold = Math.max(0.78, Math.min(0.90, matchThreshold - 0.07));

  const data = {
    version: FACEPRINT_VERSION,
    embedding: final,
    dim,
    enrolledAt: new Date().toISOString(),
    samples: (prev?.samples || 0) + cleaned.length,
    matchThreshold,
    mismatchThreshold,
  };
  saveFaceprint(setSettingFn, data);
  return publicFaceprintStatus(data);
}

function faceprintPromptNote(result) {
  if (result === 'match') {
    return '【此刻·认出】桌上机器人自己的摄像头刚看过：面前就是平时那位用户本人。可以自然当「是你」；不必每句都说「我认出你了」。';
  }
  if (result === 'mismatch') {
    return '【此刻·认人】桌上机器人自己的摄像头刚看过：面前这个人不是平时那位用户。请按你的性格立刻反应（疑惑、警惕、吐槽、冷一下都可以），但不要像安检盘问，也不要说「人脸识别/比对/摄像头算法」。';
  }
  return '';
}

module.exports = {
  FACEPRINT_SETTING_KEY,
  loadStoredFaceprint,
  clearFaceprint,
  publicFaceprintStatus,
  verifyEmbeddingAgainstStored,
  enrollFromEmbeddings,
  enrollFromPhotoUrls,
  parseEmbedding,
  parseIdentityHint,
  faceprintPromptNote,
  cosineSimilarity,
};

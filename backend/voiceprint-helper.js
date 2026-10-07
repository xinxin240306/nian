/**
 * 本地声纹：从录音提取固定维特征，余弦相似度比对。
 * 不调用聊天模型，不增加多模态 token；只在提示词里可选加一句文字。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const VOICEPRINT_SETTING_KEY = 'user_voiceprint';
const EMBED_DIM = 48;
const MATCH_THRESHOLD = 0.76;
const MISMATCH_THRESHOLD = 0.62;
const VOICEPRINT_VERSION = 3;
/** 中位音高相差超过这个比例，直接判不是同一人（男声主播 vs 女声很好抓） */
const F0_RATIO_MISMATCH = 1.35;
const F0_HZ_MISMATCH = 52;

const { resolveFfmpegBin, isFfmpegReady } = require('./ffmpeg-bin');

/** 读 16-bit PCM WAV → Float32 mono -1..1 */
function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('需要 WAV 音频');
  }
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(chunkStart + 2);
      sampleRate = buf.readUInt32LE(chunkStart + 4);
      bits = buf.readUInt16LE(chunkStart + 14);
    } else if (id === 'data') {
      dataOffset = chunkStart;
      dataSize = size;
      break;
    }
    offset = chunkStart + size + (size % 2);
  }
  if (dataOffset < 0 || bits !== 16) throw new Error('仅支持 16-bit PCM WAV');
  const samples = Math.floor(dataSize / 2 / channels);
  const mono = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += buf.readInt16LE(dataOffset + (i * channels + c) * 2) / 32768;
    }
    mono[i] = sum / channels;
  }
  return { pcm: mono, sampleRate };
}

function fileLooksLikeWav(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
    return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE';
  } catch {
    return false;
  }
}

async function ensureWavFile(inputPath) {
  // 录入、聊天比对都强制走同一条 ffmpeg 16k 单声道，避免浏览器转 WAV 和服务器转 WebM 对不上
  const tmp = path.join(os.tmpdir(), `nian-vp-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const ffmpegBin = resolveFfmpegBin();
  try {
    await execFileAsync(ffmpegBin, [
      '-y', '-i', inputPath,
      '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
      '-af', 'highpass=f=80,lowpass=f=3800',
      tmp,
    ], { timeout: 120000 });
    return { wavPath: tmp, temp: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (fileLooksLikeWav(inputPath)) return { wavPath: inputPath, temp: false };
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(
      `无法解码录音。请在 App 里填的那台服务器上安装 ffmpeg 后重启（VPS：sudo apt install -y ffmpeg）。电脑本机有 ffmpeg 帮不到云服务器。${detail ? ` ${detail}` : ''}`
    );
  }
}

function hann(n, N) {
  return 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1 || 1)));
}

function goertzelPower(frame, sampleRate, freq) {
  const n = frame.length;
  const w = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = frame[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.max(power, 1e-18);
}

function median(arr) {
  if (!arr?.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 定长声纹向量：频带形状（去音量）+ 基频/过零；另回中位音高（Hz）做硬门 */
function extractEmbeddingFromPcm(pcm, sampleRate) {
  if (!pcm?.length || pcm.length < sampleRate * 0.4) {
    throw new Error('录音太短，请至少说 1～2 秒');
  }
  const frameSize = Math.round(sampleRate * 0.025);
  const hop = Math.round(sampleRate * 0.010);
  const nBands = 20;
  const freqs = Array.from({ length: nBands }, (_, i) => {
    const t = i / (nBands - 1 || 1);
    return 80 * Math.pow(3800 / 80, t);
  });

  const totalPossible = Math.max(1, Math.floor((pcm.length - frameSize) / hop));
  const energies = [];
  for (let fi = 0; fi < totalPossible; fi += 1) {
    const start = fi * hop;
    let energy = 0;
    for (let i = 0; i < frameSize; i++) energy += pcm[start + i] * pcm[start + i];
    energies.push(energy);
  }
  const sortedE = [...energies].sort((a, b) => a - b);
  const vadCut = sortedE[Math.floor(sortedE.length * 0.35)] || 0;

  const featLen = nBands + 4;
  const means = new Float64Array(featLen);
  const m2 = new Float64Array(featLen);
  const f0HzList = [];
  let frames = 0;
  const maxFrames = 120;
  const voicedIdx = energies.map((e, i) => (e >= vadCut ? i : -1)).filter((i) => i >= 0);
  const stride = Math.max(1, Math.floor(voicedIdx.length / maxFrames));

  for (let k = 0; k < voicedIdx.length; k += stride) {
    const fi = voicedIdx[k];
    const start = fi * hop;
    const frame = new Float64Array(frameSize);
    let zcr = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = pcm[start + i] * hann(i, frameSize);
      frame[i] = s;
      if (i > 0 && ((pcm[start + i] >= 0) !== (pcm[start + i - 1] >= 0))) zcr += 1;
    }

    const rawBands = freqs.map((f) => Math.log(goertzelPower(frame, sampleRate, f)));
    const bandMean = rawBands.reduce((a, v) => a + v, 0) / nBands;
    const bands = rawBands.map((v) => v - bandMean);

    let bestLag = 0;
    let bestCorr = -1;
    const minLag = Math.floor(sampleRate / 350);
    const maxLag = Math.min(frameSize - 1, Math.floor(sampleRate / 70));
    for (let lag = minLag; lag <= maxLag; lag += 2) {
      let corr = 0;
      for (let i = 0; i < frameSize - lag; i += 2) {
        corr += frame[i] * frame[i + lag];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    const f0HzFrame = bestLag > 0 ? sampleRate / bestLag : 0;
    const f0 = f0HzFrame > 0 ? f0HzFrame / 400 : 0;
    const centroid = bands.reduce((a, v, i) => a + Math.max(0, v) * (i + 1), 0)
      / (bands.reduce((a, v) => a + Math.abs(v), 0) + 1e-9);

    if (f0HzFrame >= 70 && f0HzFrame <= 350 && bestCorr > 0) {
      f0HzList.push(f0HzFrame);
    }

    const feats = [
      ...bands,
      zcr / frameSize,
      centroid / nBands,
      Math.min(1, Math.max(0, f0)),
      Math.max(...bands) - Math.min(...bands),
    ];
    frames += 1;
    for (let i = 0; i < feats.length; i++) {
      const d = feats[i] - means[i];
      means[i] += d / frames;
      m2[i] += d * (feats[i] - means[i]);
    }
  }
  if (frames < 6) throw new Error('有效语音太少，请大声说清楚一点');

  const out = new Array(EMBED_DIM).fill(0);
  for (let i = 0; i < featLen && i < EMBED_DIM; i++) {
    out[i] = means[i];
    const std = frames > 1 ? Math.sqrt(m2[i] / (frames - 1)) : 0;
    if (featLen + i < EMBED_DIM) out[featLen + i] = std;
  }
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return {
    embedding: out.map((v) => v / norm),
    f0Hz: median(f0HzList),
  };
}

function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

function averageEmbeddings(list) {
  if (!list.length) return null;
  const dim = list[0].length;
  const acc = new Array(dim).fill(0);
  for (const e of list) {
    for (let i = 0; i < dim; i++) acc[i] += e[i];
  }
  for (let i = 0; i < dim; i++) acc[i] /= list.length;
  let norm = 0;
  for (const v of acc) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return acc.map((v) => v / norm);
}

async function extractEmbeddingFromFile(filePath) {
  const { wavPath, temp } = await ensureWavFile(filePath);
  try {
    const { pcm, sampleRate } = readWavPcm(wavPath);
    const feat = extractEmbeddingFromPcm(pcm, sampleRate);
    return feat.embedding;
  } finally {
    if (temp) try { fs.unlinkSync(wavPath); } catch {}
  }
}

async function extractFeaturesFromFile(filePath) {
  const { wavPath, temp } = await ensureWavFile(filePath);
  try {
    const { pcm, sampleRate } = readWavPcm(wavPath);
    return extractEmbeddingFromPcm(pcm, sampleRate);
  } finally {
    if (temp) try { fs.unlinkSync(wavPath); } catch {}
  }
}

function loadStoredVoiceprint(getSettingsFn) {
  const s = getSettingsFn() || {};
  const raw = s[VOICEPRINT_SETTING_KEY];
  if (!raw) return null;
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!j?.embedding?.length) return null;
    return j;
  } catch {
    return null;
  }
}

function saveVoiceprint(setSettingFn, data) {
  setSettingFn(VOICEPRINT_SETTING_KEY, JSON.stringify(data));
}

function clearVoiceprint(setSettingFn) {
  setSettingFn(VOICEPRINT_SETTING_KEY, '');
}

function publicVoiceprintStatus(stored) {
  const ffmpegOk = isFfmpegReady();
  if (!stored?.embedding?.length) {
    return { enrolled: false, enrolledAt: null, samples: 0, ffmpegOk };
  }
  const last = stored.last && typeof stored.last === 'object' ? stored.last : null;
  return {
    ffmpegOk,
    enrolled: true,
    needsReenroll: Number(stored.version || 1) < VOICEPRINT_VERSION,
    enrolledAt: stored.enrolledAt || null,
    samples: stored.samples || 1,
    selfScore: Number(stored.selfScore) || 0,
    last: last && last.result
      ? {
        result: last.result,
        score: Number(last.score) || 0,
        at: last.at || null,
        ...(last.f0Hz ? { f0Hz: last.f0Hz } : {}),
        ...(last.reason ? { reason: last.reason } : {}),
      }
      : null,
  };
}

/**
 * @returns {'match'|'mismatch'|'uncertain'|'none'}
 */
function classifyScore(score, hasEnrollment, thresholds = {}) {
  if (!hasEnrollment) return 'none';
  const matchT = Number(thresholds.matchThreshold);
  const mismatchT = Number(thresholds.mismatchThreshold);
  const hi = Number.isFinite(matchT) ? matchT : MATCH_THRESHOLD;
  const lo = Number.isFinite(mismatchT) ? mismatchT : MISMATCH_THRESHOLD;
  if (score >= hi) return 'match';
  if (score <= lo) return 'mismatch';
  return 'uncertain';
}

function rememberLastVerify(getSettingsFn, setSettingFn, payload) {
  if (typeof setSettingFn !== 'function') return;
  const stored = loadStoredVoiceprint(getSettingsFn);
  if (!stored?.embedding?.length) return;
  stored.last = {
    result: payload.result,
    score: Number(payload.score) || 0,
    at: new Date().toISOString(),
    ...(payload.f0Hz ? { f0Hz: Math.round(payload.f0Hz) } : {}),
    ...(payload.reason ? { reason: String(payload.reason).slice(0, 40) } : {}),
    ...(payload.error ? { error: String(payload.error).slice(0, 160) } : {}),
  };
  saveVoiceprint(setSettingFn, stored);
}

/** 粗分说话 / 歌曲伴奏 / 噪声，避免把放歌听成用户在唱 */
function analyzeAudioKind(pcm, sampleRate) {
  const frameSize = Math.round(sampleRate * 0.025);
  const hop = Math.round(sampleRate * 0.010);
  const n = Math.max(1, Math.floor((pcm.length - frameSize) / hop));
  const energies = new Float64Array(n);
  let zcrSum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const start = i * hop;
    let e = 0;
    let z = 0;
    for (let j = 0; j < frameSize; j++) {
      const s = pcm[start + j];
      e += s * s;
      if (j && ((pcm[start + j] >= 0) !== (pcm[start + j - 1] >= 0))) z += 1;
    }
    energies[i] = e;
    zcrSum += z / frameSize;
    if (e > peak) peak = e;
  }
  if (peak < 1e-5) return 'noise';
  const gate = peak * 0.08;
  let voiced = 0;
  let runs = 0;
  let inRun = false;
  for (let i = 0; i < n; i++) {
    const on = energies[i] >= gate;
    if (on) voiced += 1;
    if (on !== inRun) {
      runs += 1;
      inRun = on;
    }
  }
  const duty = voiced / n;
  const meanZ = zcrSum / n;
  const switchesPerSec = (runs / 2) / (n * hop / sampleRate || 1);
  if (duty < 0.12) return 'noise';
  // 歌曲/伴奏通常几乎不断、少有说话那种一顿一顿
  if (duty > 0.9 && switchesPerSec < 1.6) return 'music';
  if (duty > 0.84 && meanZ < 0.07 && switchesPerSec < 2.2) return 'music';
  return 'speech';
}

function scoreAgainstStored(emb, stored) {
  // 以均值模板为主：单段最高分不能单独过线，避免碰巧像某一段就当成你
  const avg = stored?.embedding?.length === emb.length
    ? cosineSimilarity(emb, stored.embedding)
    : 0;
  if (!Array.isArray(stored?.templates) || !stored.templates.length) return avg;
  const temps = stored.templates
    .filter((t) => t?.length === emb.length)
    .map((t) => cosineSimilarity(emb, t));
  if (!temps.length) return avg;
  const bestT = Math.max(...temps);
  return avg * 0.7 + bestT * 0.3;
}

function f0Conflicts(enrolledHz, probeHz) {
  const a = Number(enrolledHz) || 0;
  const b = Number(probeHz) || 0;
  if (a < 70 || b < 70) return false;
  const ratio = Math.max(a, b) / Math.min(a, b);
  const diff = Math.abs(a - b);
  return ratio >= F0_RATIO_MISMATCH || diff >= F0_HZ_MISMATCH;
}

async function verifyFileAgainstStored(filePath, getSettingsFn, setSettingFn) {
  const stored = loadStoredVoiceprint(getSettingsFn);
  if (!stored?.embedding?.length) {
    return { result: 'none', score: 0 };
  }
  if (Number(stored.version || 1) < VOICEPRINT_VERSION) {
    const out = { result: 'uncertain', score: 0, error: '声纹算法已更新，请到设置里清除后重新录入' };
    rememberLastVerify(getSettingsFn, setSettingFn, out);
    return out;
  }
  try {
    const { wavPath, temp } = await ensureWavFile(filePath);
    let pcm;
    let sampleRate;
    try {
      ({ pcm, sampleRate } = readWavPcm(wavPath));
    } finally {
      if (temp) try { fs.unlinkSync(wavPath); } catch {}
    }
    const kind = analyzeAudioKind(pcm, sampleRate);
    if (kind === 'music' || kind === 'noise') {
      const out = { result: kind, score: 0, kind };
      console.log(`[voiceprint] verify ${kind}`);
      rememberLastVerify(getSettingsFn, setSettingFn, out);
      return out;
    }
    const feat = extractEmbeddingFromPcm(pcm, sampleRate);
    const score = scoreAgainstStored(feat.embedding, stored);
    let result = classifyScore(score, true, stored);
    let reason = '';
    if (f0Conflicts(stored.f0Hz, feat.f0Hz)) {
      result = 'mismatch';
      reason = 'pitch';
    }
    const out = { result, score, kind, f0Hz: feat.f0Hz, reason };
    console.log(
      `[voiceprint] verify ${result} score=${score.toFixed(3)}`
      + (feat.f0Hz ? ` f0=${feat.f0Hz.toFixed(0)}Hz` : '')
      + (stored.f0Hz ? ` vs ${Number(stored.f0Hz).toFixed(0)}Hz` : '')
      + (reason ? ` (${reason})` : '')
    );
    rememberLastVerify(getSettingsFn, setSettingFn, out);
    return out;
  } catch (e) {
    console.warn('[voiceprint] verify failed:', e.message);
    const out = { result: 'uncertain', score: 0, error: e.message };
    rememberLastVerify(getSettingsFn, setSettingFn, out);
    return out;
  }
}

async function enrollFromFiles(filePaths, getSettingsFn, setSettingFn, { merge = true } = {}) {
  const features = [];
  for (const fp of filePaths) {
    features.push(await extractFeaturesFromFile(fp));
  }
  const embeddings = features.map((f) => f.embedding);
  const f0s = features.map((f) => f.f0Hz).filter((hz) => hz >= 70);
  const prev = merge ? loadStoredVoiceprint(getSettingsFn) : null;
  const prevOk = prev?.embedding?.length && Number(prev.version || 1) >= VOICEPRINT_VERSION;
  let final = averageEmbeddings(embeddings);
  const templates = [
    ...(prevOk && Array.isArray(prev.templates) ? prev.templates : []),
    ...embeddings,
  ].slice(-8);
  if (prevOk && prev.embedding?.length && merge) {
    final = averageEmbeddings([prev.embedding, final]);
  }
  const sims = embeddings.map((e) => cosineSimilarity(e, final)).filter((s) => Number.isFinite(s));
  const minIntra = sims.length ? Math.min(...sims) : 0.82;
  const matchThreshold = Math.max(0.74, Math.min(0.90, minIntra - 0.04));
  const mismatchThreshold = Math.max(0.58, Math.min(0.76, matchThreshold - 0.14));
  const prevF0 = prevOk && Number(prev.f0Hz) >= 70 ? Number(prev.f0Hz) : 0;
  const f0Hz = f0s.length ? median(prevF0 ? [prevF0, ...f0s] : f0s) : prevF0;
  const data = {
    version: VOICEPRINT_VERSION,
    embedding: final,
    templates,
    dim: final.length,
    f0Hz,
    enrolledAt: new Date().toISOString(),
    samples: (prevOk ? (prev.samples || 0) : 0) + embeddings.length,
    matchThreshold,
    mismatchThreshold,
    selfScore: minIntra,
    last: prevOk ? (prev.last || null) : null,
  };
  saveVoiceprint(setSettingFn, data);
  return publicVoiceprintStatus(data);
}

function parseVoicePayload(content) {
  const raw = String(content || '').trim();
  if (!raw.startsWith('{')) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.voice === true && j.url) return j;
  } catch {}
  return null;
}

function voiceUrlToLocalPath(url, uploadsDir) {
  if (!url || !uploadsDir) return '';
  try {
    const raw = String(url).trim();
    const pathname = raw.startsWith('http') ? new URL(raw).pathname : raw.split('?')[0];
    const marker = '/uploads/';
    const idx = pathname.lastIndexOf(marker);
    if (idx < 0) return '';
    const name = decodeURIComponent(pathname.slice(idx + marker.length));
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return '';
    return path.join(uploadsDir, name);
  } catch {
    return '';
  }
}

function applyVoiceprintToPayload(voice, vp) {
  const next = { ...voice };
  if (vp?.result && vp.result !== 'none') {
    next.voiceprint = vp.result;
    if (typeof vp.score === 'number' && Number.isFinite(vp.score)) {
      next.voiceprintScore = Math.round(vp.score * 1000) / 1000;
    }
  }
  return JSON.stringify(next);
}

function voiceprintFromContent(content) {
  const voice = parseVoicePayload(content);
  if (!voice?.voiceprint || voice.voiceprint === 'none') {
    return { result: 'none', score: 0 };
  }
  return {
    result: voice.voiceprint,
    score: Number(voice.voiceprintScore) || 0,
  };
}

async function ensureVoiceprintOnContent(content, getSettingsFn, setSettingFn, uploadsDir) {
  const voice = parseVoicePayload(content);
  if (!voice || voice.sfx || voice.score || voice.vocal || voice.album) {
    return { content, voiceprint: { result: 'none', score: 0 }, changed: false };
  }
  if (voice.voiceprint && voice.voiceprint !== 'none') {
    return {
      content,
      voiceprint: { result: voice.voiceprint, score: Number(voice.voiceprintScore) || 0 },
      changed: false,
    };
  }
  const fp = voiceUrlToLocalPath(voice.url, uploadsDir);
  if (!fp || !fs.existsSync(fp)) {
    return { content, voiceprint: { result: 'none', score: 0 }, changed: false };
  }
  const vp = await verifyFileAgainstStored(fp, getSettingsFn, setSettingFn);
  if (!vp.result || vp.result === 'none') {
    return { content, voiceprint: vp, changed: false };
  }
  return { content: applyVoiceprintToPayload(voice, vp), voiceprint: vp, changed: true };
}

async function attachLatestUserVoice(history, getSettingsFn, setSettingFn, uploadsDir, updateContent) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role !== 'user' || msg.type !== 'voice') continue;
    const parsed = parseVoicePayload(msg.content);
    if (parsed?.sfx || parsed?.score || parsed?.vocal || parsed?.album) continue;
    const attached = await ensureVoiceprintOnContent(
      msg.content, getSettingsFn, setSettingFn, uploadsDir
    );
    if (attached.changed) {
      msg.content = attached.content;
      if (msg.id && typeof updateContent === 'function') {
        try { updateContent(msg.id, attached.content); } catch {}
      }
    }
    return attached.voiceprint;
  }
  return { result: 'none', score: 0 };
}

function voiceprintStandingNote({ robot } = {}) {
  return robot
    ? '【认声】只有提示写了「声线相符/是用户本人」，才能当成对方在跟你说话。若写了歌曲、对不上或不确定，禁止说成用户在唱、在说话。不要盘问「你是谁」，也不要说「声纹/算法」。'
    : '【声纹】用户从自己手机发来的语音或通话，默认就是本人。只有提示写了不是本人、对不上、是歌曲或环境声时，才不要当成用户在对你说话。不要盘问，也不要说「声纹/识别」。';
}

function voiceprintPromptNote(result, opts = {}) {
  const robot = !!opts.robot;
  if (result === 'match') {
    // 聊天/通话默认就是本人，不在每句里重复「是你」
    if (!robot) return '';
    return '【此刻·听声】桌上小机刚听到的这段声线，和用户已录入的声纹相符，就是平时那位用户。按性格自然当「是你」接话；气氛合适可以轻轻认一声，不要每句都宣布，也不要说「声纹/算法」。';
  }
  if (result === 'mismatch') {
    return robot
      ? '【此刻·听声】桌上小机刚听到的这段声线，和用户已录入的声纹差得比较大，不是平时那位用户在对你说话。按性格反应即可；不要说成用户在唱，也不要说「声纹/算法」。'
      : '【声纹提示】这段语音的声线与用户已录入的声纹差异较大，不是用户本人在说话。不要当成用户在唱或在对你说，也不要生硬盘问。';
  }
  if (result === 'music') {
    return robot
      ? '【此刻·听声】桌上小机听到的是歌曲或伴奏，不是用户在对你说话。按听到的歌自然接即可，禁止说成「你在唱」「你唱的」。'
      : '【声纹提示】这段是歌曲或伴奏，不是用户本人在对你说话。可以聊这首歌，禁止说成用户在唱。';
  }
  if (result === 'noise') {
    return robot
      ? '【此刻·听声】桌上小机听到的更像环境声/噪声，不是用户在对你说话。不要编用户说了什么或唱了什么。'
      : '【声纹提示】这段更像环境声/噪声，不是用户在说话。不要编用户说了或唱了什么。';
  }
  if (result === 'uncertain') {
    return robot
      ? '【此刻·听声】这段声音对不上用户已录入的声纹，不能确定是本人。不要当成用户在跟你说话或唱歌。'
      : '【声纹提示】这段声音对不上已录入的声纹，不能确定是用户本人。不要当成用户在说话或唱歌。';
  }
  return '';
}

function voiceprintChatExtra(vp) {
  if (!vp?.result || vp.result === 'none' || vp.result === 'match') return '';
  const note = voiceprintPromptNote(vp.result);
  if (!note) return '';
  return [voiceprintStandingNote({ robot: false }), note].join('\n');
}

module.exports = {
  VOICEPRINT_SETTING_KEY,
  extractEmbeddingFromFile,
  verifyFileAgainstStored,
  enrollFromFiles,
  loadStoredVoiceprint,
  clearVoiceprint,
  publicVoiceprintStatus,
  parseVoicePayload,
  ensureVoiceprintOnContent,
  attachLatestUserVoice,
  voiceprintFromContent,
  voiceprintStandingNote,
  voiceprintPromptNote,
  voiceprintChatExtra,
  cosineSimilarity,
  MATCH_THRESHOLD,
  MISMATCH_THRESHOLD,
};

/**
 * 桌宠：摄像头「扫一眼」识别用户情绪 + 面容指纹（MediaPipe Face Landmarker）
 * 平时不开摄像头；对话 / 看向用户时短暂开启，识完即关。
 */
import { embeddingFromLandmarks, averageEmbeddings, identityLabelZh } from './robot-faceprint.js';

const MP_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MP_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const LABEL_ZH = {
  happy: '开心',
  sad: '难过',
  angry: '生气',
  shy: '害羞',
  surprised: '惊讶',
  neutral: '平静',
  sleepy: '困',
  love: '爱',
};

/** 用户情绪 → 小机反应表情（共情） */
export function reactionForUserEmotion(userEmotion) {
  const e = String(userEmotion || 'neutral');
  if (e === 'happy') return 'happy';
  if (e === 'love') return 'love';
  if (e === 'sad') return 'sad';
  if (e === 'angry') return 'shy';
  if (e === 'surprised') return 'surprised';
  if (e === 'sleepy') return 'sleepy';
  if (e === 'shy') return 'shy';
  return 'neutral';
}

export function emotionLabelZh(key) {
  return LABEL_ZH[key] || key || '平静';
}

function scoreMap(categories = []) {
  const m = Object.create(null);
  for (const c of categories) {
    if (c?.categoryName) m[c.categoryName] = Number(c.score) || 0;
  }
  return m;
}

function pick(m, ...keys) {
  let s = 0;
  for (const k of keys) s += m[k] || 0;
  return s / Math.max(1, keys.length);
}

export function classifyFromBlendshapes(categories = []) {
  const m = scoreMap(categories);
  const smile = pick(m, 'mouthSmileLeft', 'mouthSmileRight');
  const frown = pick(m, 'mouthFrownLeft', 'mouthFrownRight');
  const browDown = pick(m, 'browDownLeft', 'browDownRight');
  const browInnerUp = m.browInnerUp || 0;
  const jawOpen = m.jawOpen || 0;
  const eyeWide = pick(m, 'eyeWideLeft', 'eyeWideRight');
  const eyeBlink = pick(m, 'eyeBlinkLeft', 'eyeBlinkRight');
  const eyeSquint = pick(m, 'eyeSquintLeft', 'eyeSquintRight');
  const mouthPress = pick(m, 'mouthPressLeft', 'mouthPressRight');
  const mouthPucker = m.mouthPucker || 0;
  const cheekSquint = pick(m, 'cheekSquintLeft', 'cheekSquintRight');

  const scores = {
    love: smile * 1.1 + cheekSquint * 0.6 - frown * 0.5,
    happy: smile * 1.2 + cheekSquint * 0.35 - frown * 0.4,
    sad: frown * 1.3 + browInnerUp * 0.45 - smile * 0.6,
    angry: browDown * 1.2 + mouthPress * 0.7 + frown * 0.25 - smile * 0.5,
    surprised: Math.max(jawOpen, eyeWide) * 1.15 + browInnerUp * 0.5 - smile * 0.2,
    sleepy: eyeBlink * 0.9 + eyeSquint * 0.35 - eyeWide * 0.5 - jawOpen * 0.3,
    shy: mouthPucker * 0.5 + browInnerUp * 0.25 + smile * 0.25 - jawOpen * 0.3,
    neutral: 0.28,
  };

  let best = 'neutral';
  let bestScore = scores.neutral;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestScore) {
      best = k;
      bestScore = v;
    }
  }
  if (best !== 'neutral' && bestScore < 0.22) {
    return { emotion: 'neutral', confidence: bestScore, scores };
  }
  return { emotion: best, confidence: Math.min(1, bestScore), scores };
}

let _sharedLandmarker = null;
let _sharedLandmarkerPromise = null;
let _glanceBusy = false;

async function ensureLandmarker(onStatus) {
  if (_sharedLandmarker) return _sharedLandmarker;
  if (_sharedLandmarkerPromise) return _sharedLandmarkerPromise;
  _sharedLandmarkerPromise = (async () => {
    onStatus?.('加载情绪模型…');
    const { FaceLandmarker, FilesetResolver } = await import(/* @vite-ignore */ MP_CDN);
    const fileset = await FilesetResolver.forVisionTasks(`${MP_CDN}/wasm`);
    _sharedLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MP_MODEL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    return _sharedLandmarker;
  })();
  try {
    return await _sharedLandmarkerPromise;
  } finally {
    _sharedLandmarkerPromise = null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readLandmarks(result) {
  return result?.faceLandmarks?.[0] || result?.face_landmarks?.[0] || null;
}

function emptyGlance(extra = {}) {
  return {
    emotion: 'neutral',
    reaction: 'neutral',
    confidence: 0,
    facePresent: false,
    embedding: null,
    embeddings: [],
    ...extra,
  };
}

async function runCameraLoop(opts = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持摄像头');
  }
  const durationMs = Math.max(800, Math.min(6000, Number(opts.durationMs) || 1800));
  let stream = null;
  let video = null;
  let ownVideo = false;
  try {
    const landmarker = await ensureLandmarker(opts.onStatus);
    opts.onStatus?.(opts.statusText || '角色看了你一眼…');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video = opts.mirrorVideo || document.createElement('video');
    ownVideo = !opts.mirrorVideo;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.srcObject = stream;
    await video.play();
    const readyDeadline = Date.now() + 2000;
    while (video.readyState < 2 && Date.now() < readyDeadline) {
      await sleep(40);
    }

    let pending = null;
    let pendingCount = 0;
    let stable = 'neutral';
    let stableConf = 0;
    let sawFace = false;
    const embeddings = [];
    const end = Date.now() + durationMs;
    let lastT = -1;

    while (Date.now() < end) {
      if (video.readyState >= 2 && video.currentTime !== lastT) {
        lastT = video.currentTime;
        let result;
        try {
          result = landmarker.detectForVideo(video, performance.now());
        } catch {
          await sleep(50);
          continue;
        }
        const faces = result?.faceBlendshapes || result?.face_blendshapes || [];
        const lms = readLandmarks(result);
        if (!faces.length && !lms) {
          pending = null;
          pendingCount = 0;
        } else {
          sawFace = true;
          const { emotion, confidence } = classifyFromBlendshapes(faces[0]?.categories || []);
          if (emotion === pending) pendingCount += 1;
          else {
            pending = emotion;
            pendingCount = 1;
          }
          if (pendingCount >= 3) {
            stable = emotion;
            stableConf = confidence;
          }
          const emb = embeddingFromLandmarks(lms);
          if (emb) embeddings.push(emb);
        }
      }
      await sleep(50);
    }

    const emotion = sawFace ? stable : 'neutral';
    const confidence = sawFace ? stableConf : 0;
    const reaction = reactionForUserEmotion(emotion);
    return {
      emotion,
      reaction,
      confidence,
      facePresent: sawFace,
      embedding: averageEmbeddings(embeddings),
      embeddings,
    };
  } finally {
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
    }
    if (video) {
      video.srcObject = null;
      if (ownVideo) video.remove?.();
    }
  }
}

/**
 * 扫一眼：开摄像头 → 采几帧稳定情绪 + 面容向量 → 关掉摄像头
 * @param {{
 *   mirrorVideo?: HTMLVideoElement | null,
 *   durationMs?: number,
 *   onStatus?: (text: string) => void,
 * }} [opts]
 */
export async function glanceUserEmotion(opts = {}) {
  if (_glanceBusy) return emptyGlance({ busy: true });
  _glanceBusy = true;
  try {
    return await runCameraLoop(opts);
  } finally {
    _glanceBusy = false;
  }
}

/**
 * 录入面容：对着镜头采多帧几何向量（不存照片）
 */
export async function captureFaceprintSamples(opts = {}) {
  if (_glanceBusy) return emptyGlance({ busy: true });
  _glanceBusy = true;
  try {
    return await runCameraLoop({
      ...opts,
      durationMs: Number(opts.durationMs) || 2600,
      statusText: opts.statusText || '正对镜头，保持一两秒…',
    });
  } finally {
    _glanceBusy = false;
  }
}

export { LABEL_ZH, identityLabelZh };

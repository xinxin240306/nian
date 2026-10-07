/**
 * 桌宠人脸找人：JPEG → 脸框中心 → 舵机 yaw/pitch。
 * 不调 LLM。检测用 BlazeFace（懒加载）；认人门控用近期 sense / faceprint 状态。
 */

const FACE_TRACK_QUESTION = '__face_track__';
/** 面板「测人脸追踪」用：即使开关关着也跑一帧检测 */
const FACE_TRACK_FORCE_QUESTION = '__face_track_force__';
/** 扫视找人：BlazeFace 检脸并对准，不认人、不进聊天 */
const FACE_SEARCH_QUESTION = '__face_search__';
/** 对准后认人：同步比对是不是用户，不进聊天 */
const FACE_VERIFY_QUESTION = '__face_verify__';

const YAW_MIN = -70;
const YAW_MAX = 70;
const PITCH_MIN = 5;
const PITCH_MAX = 70;
const NEUTRAL_YAW = 0;
const NEUTRAL_PITCH = 28;

/**
 * 角色不知道用户在哪时：先扫这些逻辑角，每点 BlazeFace 检脸。
 * 坐着不动也能找到（不是帧差运动追踪）。
 */
const SEARCH_POSES = [
  { yaw: 0, pitch: 28 },
  { yaw: -32, pitch: 28 },
  { yaw: 32, pitch: 28 },
  { yaw: -55, pitch: 24 },
  { yaw: 55, pitch: 24 },
  { yaw: 0, pitch: 12 },
  { yaw: 0, pitch: 48 },
  { yaw: -28, pitch: 42 },
  { yaw: 28, pitch: 42 },
];

/** 画面中心死区（归一化半宽），避免微抖 */
const DEADZONE = 0.08;
/** 增量增益：脸偏 0.5 画面宽时大约转这么多度 */
const YAW_GAIN = 56;
const PITCH_GAIN = 40;
/** 连续丢脸几次后停更 */
const MISS_LIMIT = 3;
/** 近期认人结果有效期 */
const IDENTITY_FRESH_MS = 90_000;

/** @type {null | { estimateFaces: Function }} */
let _model = null;
/** @type {Promise<any> | null} */
let _modelPromise = null;
let _modelFailed = false;

const _state = {
  enabled: false,
  yaw: NEUTRAL_YAW,
  pitch: NEUTRAL_PITCH,
  facePresent: false,
  identity: 'none',
  tracking: false,
  miss: 0,
  updatedAt: 0,
  lastError: '',
};

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function isFaceTrackQuestion(question) {
  const q = String(question || '').trim().toLowerCase();
  return q === FACE_TRACK_QUESTION
    || q === 'face_track'
    || q.startsWith('__face_track')
    || q.includes('__face_search');
}

function isFaceTrackForceQuestion(question) {
  const q = String(question || '').trim().toLowerCase();
  return q === FACE_TRACK_FORCE_QUESTION
    || q.includes('__face_track_force')
    || q.includes('__face_search');
}

function isFaceSearchQuestion(question) {
  const q = String(question || '').trim().toLowerCase();
  return q.includes('__face_search') || q === 'face_search';
}

function isFaceVerifyQuestion(question) {
  const q = String(question || '').trim().toLowerCase();
  return q.includes('__face_verify') || q === 'face_verify';
}

function getSearchPoses() {
  return SEARCH_POSES.map((p) => ({ yaw: p.yaw, pitch: p.pitch }));
}

function getTarget() {
  return {
    ok: true,
    enabled: !!_state.enabled,
    yaw: _state.yaw,
    pitch: _state.pitch,
    facePresent: !!_state.facePresent,
    identity: _state.identity || 'none',
    tracking: !!_state.tracking,
    updatedAt: _state.updatedAt || null,
    hasTarget: !!(_state.updatedAt && _state.tracking && _state.facePresent),
    lastError: _state.lastError || '',
  };
}

function setEnabled(on) {
  _state.enabled = !!on;
  if (!_state.enabled) {
    _state.tracking = false;
  }
}

function pauseTracking(reason = '') {
  _state.tracking = false;
  if (reason) _state.lastError = reason;
}

async function ensureModel() {
  if (_model) return _model;
  if (_modelFailed) return null;
  if (_modelPromise) return _modelPromise;
  _modelPromise = (async () => {
    try {
      const tf = require('@tensorflow/tfjs');
      require('@tensorflow/tfjs-backend-cpu');
      await tf.setBackend('cpu');
      await tf.ready();
      const blazeface = require('@tensorflow-models/blazeface');
      _model = await blazeface.load({ maxFaces: 3 });
      return _model;
    } catch (e) {
      _modelFailed = true;
      _model = null;
      console.warn('[face-track] BlazeFace 加载失败:', e.message || e);
      return null;
    } finally {
      _modelPromise = null;
    }
  })();
  return _modelPromise;
}

/**
 * @returns {Promise<{ width: number, height: number, faces: Array<{x:number,y:number,w:number,h:number,score:number}> }>}
 */
async function detectFaces(buffer) {
  const sharp = require('sharp');
  const model = await ensureModel();
  if (!model) return { width: 0, height: 0, faces: [] };

  // 缩小再检，省 CPU；最长边 320
  const meta = await sharp(buffer).rotate().metadata();
  const srcW = meta.width || 0;
  const srcH = meta.height || 0;
  if (!srcW || !srcH) return { width: 0, height: 0, faces: [] };

  const maxSide = 320;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const { data } = await sharp(buffer)
    .rotate()
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tf = require('@tensorflow/tfjs');
  const tensor = tf.tensor3d(new Uint8Array(data), [h, w, 3]);
  let preds = [];
  try {
    preds = await model.estimateFaces(tensor, false);
  } finally {
    tensor.dispose();
  }

  const faces = [];
  for (const p of preds || []) {
    const tl = p.topLeft || p.top_left;
    const br = p.bottomRight || p.bottom_right;
    if (!tl || !br) continue;
    const x0 = Number(tl[0]) || 0;
    const y0 = Number(tl[1]) || 0;
    const x1 = Number(br[0]) || 0;
    const y1 = Number(br[1]) || 0;
    const fw = Math.max(1, x1 - x0);
    const fh = Math.max(1, y1 - y0);
    const score = Number(p.probability?.[0] ?? p.score ?? 0.9) || 0.9;
    // 映射回原图坐标
    faces.push({
      x: x0 / scale,
      y: y0 / scale,
      w: fw / scale,
      h: fh / scale,
      score,
    });
  }
  return { width: srcW, height: srcH, faces };
}

function pickFace(faces) {
  if (!faces?.length) return null;
  let best = null;
  let bestArea = -1;
  for (const f of faces) {
    const area = (f.w || 0) * (f.h || 0);
    if (area > bestArea) {
      bestArea = area;
      best = f;
    }
  }
  return best;
}

/**
 * 认人门控（与面板「认出是不是你」一致）：
 * - 关 / 未录入：跟最大脸
 * - 开且已录入：只跟近期判定为你（match）的脸；别人/不确定 → 不发新舵机（停在上次有效位）
 * 找人脸本身不调 LLM；身份来自近期 sense（看一眼等留下的结果）或已存几何指纹状态。
 */
function identityAllowsTrack(settings, robotHelper, faceprintHelper) {
  const faceprintOn = String(settings?.robot_faceprint_enabled || '0') === '1';
  if (!faceprintOn) {
    return { ok: true, identity: 'none' };
  }
  const stored = faceprintHelper.loadStoredFaceprint(() => settings);
  const status = faceprintHelper.publicFaceprintStatus(stored);
  if (!status?.enrolled) {
    return { ok: true, identity: 'none' };
  }
  const last = robotHelper.getLastSense(IDENTITY_FRESH_MS);
  const id = last?.faceIdentity || 'none';
  if (id === 'match') {
    return { ok: true, identity: 'match' };
  }
  // mismatch / uncertain / none：不转头，头停在原位
  return { ok: false, identity: id === 'mismatch' ? 'mismatch' : (id === 'uncertain' ? 'uncertain' : 'none') };
}

function applyFaceToAngles(face, imgW, imgH) {
  const cx = face.x + face.w / 2;
  const cy = face.y + face.h / 2;
  let dx = cx / imgW - 0.5;
  let dy = cy / imgH - 0.5;
  if (Math.abs(dx) < DEADZONE) dx = 0;
  if (Math.abs(dy) < DEADZONE) dy = 0;

  // 脸在画面右侧 → 头右转（正 yaw）；脸在下方 → 低头（更大 pitch）
  let yaw = _state.yaw + dx * YAW_GAIN;
  let pitch = _state.pitch + dy * PITCH_GAIN;
  yaw = clamp(Math.round(yaw), YAW_MIN, YAW_MAX);
  pitch = clamp(Math.round(pitch), PITCH_MIN, PITCH_MAX);
  return { yaw, pitch, dx, dy };
}

/**
 * 处理一帧找人照片。
 * @returns {{ success: boolean, response: string, target: object }}
 */
async function processFaceTrackFrame(opts = {}) {
  const {
    buffer,
    getSettings,
    robotHelper,
    faceprintHelper,
    question,
    force: forceOpt,
  } = opts;

  const settings = getSettings?.() || {};
  const force = !!forceOpt || isFaceTrackForceQuestion(question);
  const enabled = String(settings.robot_face_track_enabled || '0') !== '0'
    && String(settings.robot_enabled || '0') === '1';
  setEnabled(enabled || force);

  if (!enabled && !force) {
    pauseTracking('face track off');
    return {
      success: true,
      response: 'ok',
      action: 'RESPONSE',
      target: getTarget(),
    };
  }

  if (!buffer?.length) {
    _state.lastError = 'no image';
    return {
      success: false,
      response: 'no image',
      action: 'ERROR',
      target: getTarget(),
    };
  }

  const gate = force
    ? { ok: true, identity: 'none' }
    : identityAllowsTrack(settings, robotHelper, faceprintHelper);
  _state.identity = gate.identity;
  if (!gate.ok) {
    // 不发新舵机：tracking=false → hasTarget=false，头停在上次有效位
    _state.tracking = false;
    _state.updatedAt = Date.now();
    _state.lastError = gate.identity === 'mismatch'
      ? 'identity mismatch'
      : (gate.identity === 'uncertain' ? 'identity uncertain' : 'identity pending');
    if (gate.identity === 'mismatch') {
      _state.facePresent = true;
    }
    return {
      success: true,
      response: 'ok',
      action: 'RESPONSE',
      target: getTarget(),
    };
  }

  let width = 0;
  let height = 0;
  let faces = [];
  try {
    const det = await detectFaces(buffer);
    width = det.width;
    height = det.height;
    faces = det.faces || [];
  } catch (e) {
    _state.lastError = e.message || 'detect failed';
    _state.updatedAt = Date.now();
    console.warn('[face-track] detect:', _state.lastError);
    return {
      success: true,
      response: 'ok',
      action: 'RESPONSE',
      target: getTarget(),
    };
  }

  const face = pickFace(faces);
  if (!face || !width || !height) {
    _state.miss += 1;
    _state.facePresent = false;
    if (_state.miss >= MISS_LIMIT) {
      _state.tracking = false;
      // 丢脸多了不强制回中，避免突兀；停更即可
    }
    _state.updatedAt = Date.now();
    _state.lastError = '';
    try {
      robotHelper.recordSense({
        facePresent: false,
        faceIdentity: gate.identity === 'match' ? 'none' : gate.identity,
      });
    } catch {}
    return {
      success: true,
      response: 'ok',
      action: 'RESPONSE',
      target: getTarget(),
    };
  }

  const next = applyFaceToAngles(face, width, height);
  _state.yaw = next.yaw;
  _state.pitch = next.pitch;
  _state.facePresent = true;
  _state.tracking = true;
  _state.miss = 0;
  _state.updatedAt = Date.now();
  _state.lastError = '';

  try {
    robotHelper.recordSense({
      facePresent: true,
      faceIdentity: gate.identity === 'none' ? 'none' : gate.identity,
      subjectType: gate.identity === 'match' ? 'user' : 'unknown',
      isUser: gate.identity === 'match',
    });
  } catch {}

  return {
    success: true,
    response: 'ok',
    action: 'RESPONSE',
    target: getTarget(),
  };
}

function noteExplicitServo(yaw, pitch) {
  // 角色/测试刚把头转到某角：找人下一帧必须从这个位置接着算，不能假装还在中位。
  if (Number.isFinite(Number(yaw))) _state.yaw = Math.round(Number(yaw));
  if (Number.isFinite(Number(pitch))) _state.pitch = Math.round(Number(pitch));
  _state.tracking = false;
  _state.updatedAt = Date.now();
}

/** 持续跟着：仅角色写 [桌宠:跟着] 后开启；默认关 */
let _followUntil = 0;

function setFollowMode(on, durationMs = 5 * 60 * 1000) {
  if (!on) {
    _followUntil = 0;
    _state.tracking = false;
    return getFollowStatus();
  }
  const ms = Math.max(30_000, Math.min(30 * 60_000, Number(durationMs) || 5 * 60_000));
  _followUntil = Date.now() + ms;
  return getFollowStatus();
}

function isFollowMode() {
  if (!_followUntil) return false;
  if (Date.now() >= _followUntil) {
    _followUntil = 0;
    return false;
  }
  return true;
}

function getFollowStatus() {
  const on = isFollowMode();
  return {
    on,
    until: on ? _followUntil : 0,
    remainMs: on ? Math.max(0, _followUntil - Date.now()) : 0,
  };
}

module.exports = {
  FACE_TRACK_QUESTION,
  FACE_TRACK_FORCE_QUESTION,
  FACE_SEARCH_QUESTION,
  FACE_VERIFY_QUESTION,
  isFaceTrackQuestion,
  isFaceTrackForceQuestion,
  isFaceSearchQuestion,
  isFaceVerifyQuestion,
  getSearchPoses,
  getTarget,
  setEnabled,
  pauseTracking,
  processFaceTrackFrame,
  noteExplicitServo,
  setFollowMode,
  isFollowMode,
  getFollowStatus,
  NEUTRAL_YAW,
  NEUTRAL_PITCH,
};

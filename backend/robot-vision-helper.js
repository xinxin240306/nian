/**
 * 小机自己的摄像头：收一帧画面 → 录入或比对是不是用户 → 记下给角色提示词。
 * 喇叭不报「你不是用户」；身份只进角色侧。
 */

const fs = require('fs');
const path = require('path');
const faceprintHelper = require('./faceprint-helper');

function parseVisionJson(raw) {
  const s = String(raw || '').replace(/```json|```/g, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const EMOTION_KEYS = ['happy', 'sad', 'angry', 'shy', 'surprised', 'neutral', 'sleepy', 'love'];
const EMOTION_ZH = {
  开心: 'happy', 高兴: 'happy', 快乐: 'happy', happy: 'happy',
  难过: 'sad', 伤心: 'sad', sad: 'sad',
  生气: 'angry', 怒: 'angry', angry: 'angry',
  害羞: 'shy', 羞: 'shy', shy: 'shy',
  惊讶: 'surprised', 吃惊: 'surprised', surprised: 'surprised',
  平静: 'neutral', 普通: 'neutral', neutral: 'neutral',
  困: 'sleepy', 困倦: 'sleepy', sleepy: 'sleepy',
  爱: 'love', 喜欢: 'love', love: 'love',
};

function normalizeVisionEmotion(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (EMOTION_KEYS.includes(key)) return key;
  return EMOTION_ZH[String(raw || '').trim()] || EMOTION_ZH[key] || 'neutral';
}

function classifyVisionRead(obj, { hasRef = false } = {}) {
  if (!obj || typeof obj !== 'object') {
    return { result: 'uncertain', emotion: 'neutral', face: false, score: 0 };
  }
  const face = obj.face === true || obj.face === 'true' || obj.face === 1;
  const emotion = face ? normalizeVisionEmotion(obj.emotion) : 'neutral';
  const conf = Math.max(0, Math.min(1, Number(obj.confidence) || 0));
  if (!hasRef) {
    return { result: 'none', emotion, face, score: conf };
  }
  const same = obj.same === true || obj.same === 'true' || obj.same === 1;
  if (!face) return { result: 'uncertain', emotion: 'neutral', face: false, score: conf };
  if (same && conf >= 0.55) return { result: 'match', emotion, face: true, score: conf };
  if (!same && conf >= 0.55) return { result: 'mismatch', emotion, face: true, score: conf };
  return { result: 'uncertain', emotion, face: true, score: conf };
}

function isGlanceQuestion(question) {
  const q = String(question || '').trim();
  if (!q) return true;
  if (q.length <= 12 && /看|瞧|瞄|扫一眼|看看我|看我|look|see/i.test(q)) return true;
  return false;
}

function uploadUrlToDataUrl(url, uploadsPath) {
  const name = decodeURIComponent(String(url || '').replace(/^\/uploads\//, '').split('?')[0]);
  if (!name || name.includes('..')) return '';
  const fp = path.join(uploadsPath, name);
  if (!uploadsPath || !fs.existsSync(fp)) return '';
  const buf = fs.readFileSync(fp);
  if (!buf.length) return '';
  const ext = path.extname(name).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function resolveVisionImageUrl(url, opts = {}) {
  const data = uploadUrlToDataUrl(url, opts.uploadsPath);
  if (data) return data;
  return opts.api?.toAbsoluteMediaUrl?.(url, opts.publicBase || '') || '';
}

/** 持久化最近一帧，聊天识图不单靠进程内存 */
function persistLastCameraFrame(liveUrl, setSetting) {
  const url = String(liveUrl || '').trim();
  if (!url || typeof setSetting !== 'function') return;
  try {
    setSetting('robot_last_camera_url', url);
    setSetting('robot_last_camera_at', String(Date.now()));
  } catch (e) {
    console.warn('[robot-vision] persist frame', e.message);
  }
}

/**
 * 取识图用帧：内存 lastSense → settings → uploads 最新机身图
 */
function getCameraFrameForCharacterVision(opts = {}) {
  const {
    robotHelper,
    getSettings,
    uploadsPath = '',
    maxAgeMs = 180000,
  } = opts;
  const now = Date.now();

  const sense = robotHelper?.getLastSense?.(maxAgeMs);
  if (sense?.imageUrl) {
    return { ...sense, imageUrl: String(sense.imageUrl).trim(), source: 'memory' };
  }

  try {
    const settings = typeof getSettings === 'function' ? getSettings() : {};
    const url = String(settings.robot_last_camera_url || '').trim();
    const at = Number(settings.robot_last_camera_at || 0) || 0;
    if (url && at && now - at <= maxAgeMs) {
      return {
        imageUrl: url,
        at,
        facePresent: true,
        faceIdentity: 'none',
        source: 'settings',
      };
    }
  } catch {}

  try {
    if (!uploadsPath || !fs.existsSync(uploadsPath)) return null;
    const files = fs.readdirSync(uploadsPath)
      .filter((n) => /(?:robot-snap-|\d+-camera)\.(jpe?g|png|webp)$/i.test(n))
      .map((n) => {
        const fp = path.join(uploadsPath, n);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(fp).mtimeMs; } catch {}
        return { n, mtimeMs };
      })
      .filter((x) => x.mtimeMs && now - x.mtimeMs <= maxAgeMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (files[0]) {
      return {
        imageUrl: `/uploads/${files[0].n}`,
        at: files[0].mtimeMs,
        facePresent: true,
        faceIdentity: 'none',
        source: 'disk',
      };
    }
  } catch (e) {
    console.warn('[robot-vision] disk frame', e.message);
  }
  return null;
}

/**
 * 读小机此刻画面：表情；若有参考正脸则同时比对是不是用户。一次识图。
 */
async function analyzeRobotCameraFrame(api, settings, opts = {}) {
  const liveAbs = resolveVisionImageUrl(opts.liveUrl, opts);
  if (!liveAbs) {
    return { result: 'none', emotion: 'neutral', face: false, score: 0 };
  }
  const enrolledAbs = opts.enrolledUrl ? resolveVisionImageUrl(opts.enrolledUrl, opts) : '';
  const hasRef = !!enrolledAbs;
  const wantEmotion = opts.wantEmotion !== false;
  const lines = [
    '这是桌上机器人自己的摄像头拍到的画面。',
    wantEmotion ? '根据画面里最清楚的那张人脸，判断表情。' : '',
    hasRef ? '另外有一张用户本人的参考正脸。判断镜头里的人是不是同一人。' : '',
    '只输出 JSON，不要其它文字：',
    hasRef
      ? '{"face":true或false,"emotion":"happy|sad|angry|shy|surprised|neutral|sleepy|love","same":true或false,"confidence":0到1}'
      : '{"face":true或false,"emotion":"happy|sad|angry|shy|surprised|neutral|sleepy|love","confidence":0到1}',
    '规则：看不清人脸则 face=false、emotion=neutral。',
    hasRef ? '明显另一人 same=false；明显同一人 same=true。' : '',
    'emotion 对应：happy开心 sad难过 angry生气 shy害羞 surprised惊讶 neutral平静 sleepy困 love爱。',
  ].filter(Boolean).join('');

  const content = [{ type: 'text', text: lines }];
  if (hasRef) {
    content.push({ type: 'text', text: '图1 用户参考正脸：' });
    content.push({ type: 'image_url', image_url: { url: enrolledAbs } });
    content.push({ type: 'text', text: '图2 小机此刻画面：' });
  }
  content.push({ type: 'image_url', image_url: { url: liveAbs } });

  const raw = await api.callChatAPIComplete(
    settings,
    '你是桌面机器人的视觉助手。只输出指定 JSON。',
    null,
    'chat',
    [{ role: 'user', content }],
  );
  return classifyVisionRead(parseVisionJson(raw) || {}, { hasRef });
}

function characterLookText(question) {
  const q = String(question || '').trim();
  if (q && !isGlanceQuestion(q)) return q;
  if (q) return `（你刚用桌上这台机器人自己的摄像头看了一眼前方。对方说：${q.slice(0, 80)}）`;
  return '（你刚用桌上这台机器人自己的摄像头看了一眼前方。）';
}

let _analyzeBusy = false;

function kickBackgroundAnalyze(opts) {
  if (_analyzeBusy) return;
  const {
    liveUrl, wantId, emotionOn, photos, getSettings, robotHelper, api,
    publicBase, uploadsPath,
  } = opts;
  _analyzeBusy = true;
  Promise.resolve()
    .then(() => analyzeRobotCameraFrame(api, getSettings(), {
      enrolledUrl: wantId ? photos[photos.length - 1] : '',
      liveUrl,
      wantEmotion: emotionOn,
      publicBase,
      uploadsPath,
      api,
    }))
    .then((read) => {
      const userEmotion = emotionOn && read.face ? read.emotion : '';
      robotHelper.recordSense({
        facePresent: read.face !== false,
        faceIdentity: wantId ? read.result : 'none',
        faceIdentityScore: read.score,
        emotion: userEmotion || 'neutral',
        confidence: read.score,
      });
    })
    .catch((e) => console.warn('[robot-vision] background', e.message))
    .finally(() => { _analyzeBusy = false; });
}

function canAttachCameraFrame(opts = {}) {
  const { char, settings, robotDriveHelper } = opts;
  if (String(settings?.robot_enabled || '0') !== '1') {
    console.log('[robot-vision] attach skip: robot off');
    return false;
  }
  if (robotDriveHelper && char && typeof robotDriveHelper.canCharacterUseRobot === 'function') {
    if (!robotDriveHelper.canCharacterUseRobot(char, settings)) {
      console.log('[robot-vision] attach skip: char not bound');
      return false;
    }
  }
  return true;
}

function buildVisionImagePart(sense, opts = {}) {
  const imageUrl = String(sense?.imageUrl || '').trim();
  if (!imageUrl) return null;
  const abs = resolveVisionImageUrl(imageUrl, opts);
  if (!abs) return null;
  return { type: 'image_url', image_url: { url: abs } };
}

function cameraVisionNote(opts = {}) {
  const event = ['snapshot', 'find'].includes(opts.event) ? opts.event : 'glance';
  const lead = event === 'find'
    ? '你刚借桌上小机找了一下'
    : event === 'snapshot'
      ? '你刚借桌上小机悄悄看了一眼'
      : '你刚借桌上小机看了一眼前方';
  return `【桌上小机·你的视觉】${lead}。下面是你自己通过小机镜头看到的真实画面，不是用户发给你的图。按性格和心情决定提不提、提多少：可以随口点一眼，也可以当没看见。看不清就当没看见，不要编图里没有的东西，不必把画面每样都念一遍。`;
}

function cameraLookCaption(opts = {}) {
  const event = ['snapshot', 'find'].includes(opts.event) ? opts.event : 'glance';
  if (event === 'find') return '（你刚通过桌上小机找过面前。按性格决定提不提，不必把画面每样都说一遍。）';
  if (event === 'snapshot') return '（你刚通过桌上小机看过一眼。按性格决定提不提，不必把画面每样都说一遍。）';
  return '（你刚通过桌上小机看过面前。按性格决定提不提，不必把画面每样都说一遍。）';
}

/**
 * 把小机画面交给角色识图。图必须放在 user 消息里：多数聊天 API 会忽略 system 里的 image_url，
 * 角色就会「调了摄像头却像没看见」。文案写明这是角色自己看到的，不是用户发图。
 */
function buildCameraVisionForChat(systemPrompt, opts = {}) {
  if (!canAttachCameraFrame(opts)) return null;
  const frame = getCameraFrameForCharacterVision({
    robotHelper: opts.robotHelper,
    getSettings: opts.getSettings || (() => opts.settings),
    uploadsPath: opts.uploadsPath || '',
    maxAgeMs: opts.maxAgeMs || 180000,
  });
  if (!frame?.imageUrl) {
    console.log('[robot-vision] attach skip: no recent frame');
    return null;
  }
  const imagePart = buildVisionImagePart(frame, opts);
  if (!imagePart) {
    console.log('[robot-vision] attach skip: resolve image failed', frame.imageUrl);
    return null;
  }
  const via = String(imagePart.image_url?.url || '').startsWith('data:') ? 'data' : 'url';
  console.log(`[robot-vision] attach user ok source=${frame.source || '?'} via=${via} file=${frame.imageUrl}`);
  const note = cameraVisionNote(opts);
  const base = String(systemPrompt || '').trim();
  return {
    systemPrompt: base ? `${base}\n\n${note}` : note,
    userParts: [
      { type: 'text', text: cameraLookCaption(opts) },
      imagePart,
    ],
    frame,
  };
}

/**
 * 把小机画面挂到角色自己的视觉输入（system）：这是角色通过小机看到的，
 * 不是用户发图，也不落成用户气泡。
 * @deprecated 多数模型不读 system 图，请用 buildCameraVisionForChat
 */
function attachCameraFrameToSystemPrompt(systemPrompt, opts = {}) {
  const vis = buildCameraVisionForChat(systemPrompt, opts);
  if (!vis) return null;
  return vis.systemPrompt;
}

/** 兼容旧名：不再把小机画面当成用户发图。 */
function attachCameraFrameToUserContent() {
  return null;
}

function injectCharacterVisionIntoApiHistory() {
  return false;
}

function buildCharacterVisionApiMessage() {
  return null;
}

function buildCameraLookFollowUpUserText(opts = {}) {
  return cameraLookCaption(opts);
}

function buildCameraLookFollowUpUserContent(opts = {}) {
  const text = cameraLookCaption(opts);
  const systemContent = attachCameraFrameToSystemPrompt('', opts);
  if (!systemContent) return null;
  return { text, systemContent };
}

/**
 * 处理一帧机身摄像头画面。
 * 看一眼：立刻应一声；截图写入 lastSense，并由服务端自动带图让角色回话（无需用户再回）。
 * 表情/认人仍可后台跑，不挡截图落地。
 */
async function ingestRobotCameraFrame(opts = {}) {
  const {
    buffer,
    ext = '.jpg',
    question = '',
    getSettings,
    setSetting,
    saveImageBuffer,
    publicBase = '',
    uploadsPath = '',
    robotHelper,
    api,
  } = opts;

  if (!buffer?.length) {
    return { success: false, action: 'ERROR', response: '没有画面', faceIdentity: 'none' };
  }

  const filename = saveImageBuffer(buffer, ext);
  const liveUrl = `/uploads/${filename}`;
  const settings = getSettings();
  const enrollNext = String(settings.robot_faceprint_enroll_next || '0') === '1';
  const emotionOn = String(settings.robot_emotion_sense_enabled || '0') === '1';
  const faceprintOn = String(settings.robot_faceprint_enabled || '0') === '1';
  const glance = isGlanceQuestion(question);

  if (enrollNext) {
    const status = faceprintHelper.enrollFromPhotoUrls([liveUrl], getSettings, setSetting, { merge: true });
    setSetting('robot_faceprint_enroll_next', '0');
    if (!faceprintOn) setSetting('robot_faceprint_enabled', '1');
    robotHelper.recordSense({
      facePresent: true,
      faceIdentity: 'match',
      faceIdentityScore: 1,
      imageUrl: liveUrl,
    });
    persistLastCameraFrame(liveUrl, setSetting);
    return {
      success: true,
      action: 'RESPONSE',
      response: '好，这张脸我记下了。',
      faceIdentity: 'match',
      enrolled: true,
      deferSpeak: false,
      lookText: characterLookText(question),
      faceprint: status,
      imageUrl: liveUrl,
    };
  }

  const stored = faceprintHelper.loadStoredFaceprint(getSettings);
  const photos = stored?.photos || [];
  const wantId = faceprintOn && photos.length > 0;
  const wantRead = emotionOn || wantId;
  const last = robotHelper.getLastSense(25000);

  // 先落截图，角色下一轮就能识图；表情/认人后台补
  robotHelper.recordSense({
    facePresent: true,
    faceIdentity: last?.faceIdentity || 'none',
    faceIdentityScore: last?.faceIdentityScore || 0,
    emotion: last?.emotion || 'neutral',
    imageUrl: liveUrl,
  });
  persistLastCameraFrame(liveUrl, setSetting);

  if (wantRead) {
    kickBackgroundAnalyze({
      liveUrl, wantId, emotionOn, photos, getSettings, robotHelper, api,
      publicBase, uploadsPath,
    });
  }

  return {
    success: true,
    action: 'RESPONSE',
    response: glance ? '嗯。' : '',
    faceIdentity: last?.faceIdentity || 'none',
    userEmotion: last?.emotion && last.emotion !== 'neutral' ? last.emotion : '',
    facePresent: true,
    deferSpeak: !glance,
    lookText: characterLookText(question),
    imageUrl: liveUrl,
  };
}

/**
 * 扫视找人对准后：同步认人（等 LLM 比对完再返回）。
 * 不进聊天页、不触发角色跟一句。
 */
async function verifyRobotCameraFrame(opts = {}) {
  const {
    buffer,
    ext = '.jpg',
    getSettings,
    setSetting,
    saveImageBuffer,
    publicBase = '',
    uploadsPath = '',
    robotHelper,
    api,
  } = opts;

  if (!buffer?.length) {
    return {
      success: false,
      action: 'ERROR',
      response: 'no image',
      faceIdentity: 'none',
      facePresent: false,
    };
  }

  const filename = saveImageBuffer(buffer, ext);
  const liveUrl = `/uploads/${filename}`;
  const settings = getSettings?.() || {};
  const emotionOn = String(settings.robot_emotion_sense_enabled || '0') === '1';
  const faceprintOn = String(settings.robot_faceprint_enabled || '0') === '1';
  const stored = faceprintHelper.loadStoredFaceprint(getSettings);
  const photos = stored?.photos || [];
  const wantId = faceprintOn && photos.length > 0;

  persistLastCameraFrame(liveUrl, setSetting);

  if (!wantId && !emotionOn) {
    robotHelper.recordSense({
      facePresent: true,
      faceIdentity: 'none',
      imageUrl: liveUrl,
    });
    return {
      success: true,
      action: 'RESPONSE',
      response: 'ok',
      faceIdentity: 'none',
      facePresent: true,
      imageUrl: liveUrl,
      deferSpeak: false,
    };
  }

  let read = { result: 'none', emotion: 'neutral', face: true, score: 0 };
  try {
    read = await analyzeRobotCameraFrame(api, settings, {
      enrolledUrl: wantId ? photos[photos.length - 1] : '',
      liveUrl,
      wantEmotion: emotionOn,
      publicBase,
      uploadsPath,
      api,
    });
  } catch (e) {
    console.warn('[robot-vision] verify', e.message);
    read = { result: 'uncertain', emotion: 'neutral', face: true, score: 0 };
  }

  const identity = wantId ? (read.result || 'uncertain') : 'none';
  const userEmotion = emotionOn && read.face ? read.emotion : '';
  robotHelper.recordSense({
    facePresent: read.face !== false,
    faceIdentity: identity,
    faceIdentityScore: read.score || 0,
    emotion: userEmotion || 'neutral',
    confidence: read.score || 0,
    imageUrl: liveUrl,
  });

  return {
    success: true,
    action: 'RESPONSE',
    response: 'ok',
    faceIdentity: identity,
    faceIdentityScore: read.score || 0,
    facePresent: read.face !== false,
    userEmotion: userEmotion || '',
    imageUrl: liveUrl,
    deferSpeak: false,
  };
}

function decodeDataImage(url) {
  const s = String(url || '').trim();
  const m = s.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg';
  return { buffer: Buffer.from(m[2], 'base64'), ext };
}

module.exports = {
  ingestRobotCameraFrame,
  verifyRobotCameraFrame,
  analyzeRobotCameraFrame,
  isGlanceQuestion,
  characterLookText,
  buildCameraLookFollowUpUserText,
  buildCameraLookFollowUpUserContent,
  parseVisionJson,
  decodeDataImage,
  uploadUrlToDataUrl,
  buildCharacterVisionApiMessage,
  attachCameraFrameToSystemPrompt,
  buildCameraVisionForChat,
  attachCameraFrameToUserContent,
  injectCharacterVisionIntoApiHistory,
  getCameraFrameForCharacterVision,
  resolveVisionImageUrl,
};

/**
 * 桌宠电子屏状态缓存：桥接/固件轮询 GET /api/robot/screen 取最新脸与台词
 */

const { toAbsoluteMediaUrl } = require('./api-helper');

/** @type {Map<number, object>} */
const _byChar = new Map();

function defaultScreen() {
  return {
    emotion: 'neutral',
    emotionUrl: '',
    displayText: '',
    reply: '',
    motion: 'idle',
    motionRaw: '',
    led: null,
    servo: null,
    intent: '',
    source: '',
    touchSeq: null,
    // 每来一条硬件指令就 +1。光比角度值判重会把「再往左转一次」当成没变化吞掉。
    hwSeq: 0,
    updatedAt: null,
  };
}

function absolutize(url, publicBase) {
  const u = String(url || '').trim();
  if (!u) return '';
  return toAbsoluteMediaUrl(u, publicBase || '');
}

function normalizePayload(payload = {}, publicBase = '') {
  const p = payload && typeof payload === 'object' ? payload : {};
  const emotion = String(p.emotion || 'neutral').trim() || 'neutral';
  const emotionUrl = absolutize(p.emotionUrl || p.emotion_url || '', publicBase);
  const displayText = String(p.displayText ?? p.display_text ?? p.reply ?? '').trim();
  const reply = String(p.reply ?? displayText).trim();
  const touchSeqRaw = p.touchSeq;
  return {
    emotion,
    emotionUrl,
    displayText,
    reply,
    motion: String(p.motion || 'idle').trim() || 'idle',
    motionRaw: String(p.motionRaw || p.motion_raw || '').trim(),
    motionCustom: !!p.motionCustom,
    led: p.led && typeof p.led === 'object' ? p.led : null,
    servo: p.servo && typeof p.servo === 'object' ? p.servo : null,
    intent: String(p.intent || '').trim(),
    source: String(p.source || '').trim(),
    touchSeq: Number.isFinite(Number(touchSeqRaw)) ? Number(touchSeqRaw) : null,
    hwSeq: Number.isFinite(Number(p.hwSeq)) ? Number(p.hwSeq) : 0,
    updatedAt: new Date().toISOString(),
  };
}

function getScreen(characterId) {
  const id = parseInt(characterId, 10);
  if (!id) return { ...defaultScreen() };
  return { ...defaultScreen(), ...(_byChar.get(id) || {}) };
}

function setScreen(characterId, patch = {}, publicBase = '') {
  const id = parseInt(characterId, 10);
  if (!id) return defaultScreen();
  const prev = getScreen(id);
  const merged = { ...prev, ...patch };
  if (!Number.isFinite(Number(patch.touchSeq)) && Number.isFinite(Number(prev.touchSeq))) {
    merged.touchSeq = prev.touchSeq;
  }
  const hasHardware = !!(patch.servo && typeof patch.servo === 'object')
    || !!(patch.led && typeof patch.led === 'object');
  merged.hwSeq = hasHardware ? (Number(prev.hwSeq) || 0) + 1 : (Number(prev.hwSeq) || 0);
  const next = normalizePayload(merged, publicBase);
  _byChar.set(id, next);
  return next;
}

/**
 * 舵机指令是一次性的：转过去就该从缓存里拿掉。
 * 留着的话，之后任何一次表情变化都会把这个旧角度再转一遍。
 */
function clearScreenServo(characterId) {
  const id = parseInt(characterId, 10);
  if (!id) return;
  const prev = _byChar.get(id);
  if (!prev?.servo) return;
  _byChar.set(id, { ...prev, servo: null });
}

function applyDisplayCommand(characterId, payload, publicBase = '') {
  return setScreen(characterId, {
    ...payload,
    source: payload?.source || payload?.intent || 'display',
  }, publicBase);
}

function applyChatResult(characterId, data = {}, publicBase = '') {
  const parsed = data.parsed || {};
  return setScreen(characterId, {
    emotion: data.emotion || parsed.emotion || 'neutral',
    emotionUrl: data.emotionUrl || '',
    displayText: data.displayText ?? data.speak ?? data.reply ?? '',
    reply: data.speak ?? data.reply ?? '',
    motion: data.motion || parsed.motion || 'idle',
    motionRaw: data.motionRaw || parsed.motionRaw || '',
    motionCustom: data.motionCustom || parsed.motionCustom,
    led: data.led || parsed.led || null,
    servo: data.servo || parsed.servo || null,
    source: 'chat',
  }, publicBase);
}

/**
 * 灯光策略在这里就落到 led 上，插件那侧拿到的已经是最终值。
 * 关了就直接给 off，上限亮度也已经压过 —— 免得每个下游各自记着夹一遍。
 */
function applyLedPolicyToScreen(screen, behavior) {
  const led = screen?.led && typeof screen.led === 'object' ? screen.led : null;
  if (!led || !behavior) return screen;
  if (behavior.ledEnabled === false) {
    return { ...screen, led: { off: true, r: 0, g: 0, b: 0, hex: '#000000', brightness: 0, frequencyHz: 0, effect: 'steady' } };
  }
  const max = Number(behavior.ledMaxBrightness);
  if (!Number.isFinite(max) || max >= 1) return screen;
  const cur = Number(led.brightness);
  const brightness = Math.min(Number.isFinite(cur) ? cur : 1, Math.max(0.05, max));
  return { ...screen, led: { ...led, brightness } };
}

function applyServoDeviceMap(screen, behavior) {
  let helper;
  try { helper = require('./robot-helper'); } catch { return screen; }
  const settings = { robot_pitch_center: behavior?.pitchCenter };
  let servo = screen?.servo && typeof screen.servo === 'object' ? { ...screen.servo } : null;
  if (!servo && screen?.motion && String(screen.motion) !== 'idle') {
    const logical = helper.normalizeServoAngles({ motion: screen.motion });
    if (logical) servo = { motion: screen.motion, yaw: logical.yaw, pitch: logical.pitch };
  }
  if (!servo) return screen;
  const mapped = helper.toDeviceAngles(servo, settings);
  if (!mapped) return screen;
  return {
    ...screen,
    servo: {
      ...servo,
      yaw: mapped.yaw,
      pitch: mapped.pitch,
      params: { ...(servo.params || {}), yaw: mapped.yaw, pitch: mapped.pitch },
    },
  };
}

function buildScreenResponse(characterId, publicBase = '', extras = {}) {
  const screen = getScreen(characterId);
  const behavior = extras.behavior || null;
  const withLed = applyLedPolicyToScreen(screen, behavior);
  return {
    ok: true,
    characterId: parseInt(characterId, 10) || null,
    screen: {
      ...applyServoDeviceMap(withLed, behavior),
      emotionUrl: '',
    },
    behavior,
    updatedAt: screen.updatedAt,
  };
}

function absolutizeFacePayload(face = {}, publicBase = '') {
  const customEmotionAssets = {};
  for (const [k, v] of Object.entries(face.customEmotionAssets || {})) {
    customEmotionAssets[k] = absolutize(v, publicBase);
  }
  return {
    ...face,
    emotionUrl: '',
    emotionAssets: {},
    customEmotionAssets,
  };
}

module.exports = {
  defaultScreen,
  getScreen,
  setScreen,
  clearScreenServo,
  applyDisplayCommand,
  applyChatResult,
  buildScreenResponse,
  absolutize,
  absolutizeFacePayload,
};

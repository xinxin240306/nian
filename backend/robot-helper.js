/**
 * Stack-chan / 桌宠渠道：系统提示、表情·动作标签解析、在场感/表情衰减/人脸追踪协议、抓拍心得
 */

const { callChatAPIComplete, buildHistoryApiMessages, toAbsoluteMediaUrl } = require('./api-helper');
const { buildCharacterProfile } = require('./cron');

const EMOTION_ALIASES = {
  开心: 'happy', 高兴: 'happy', 快乐: 'happy', 笑: 'happy', happy: 'happy', joy: 'happy',
  微笑: 'happy', 呲牙: 'happy', 大笑: 'happy', 偷笑: 'happy', 坏笑: 'happy', 笑哭: 'happy',
  难过: 'sad', 伤心: 'sad', 哭: 'sad', sad: 'sad',
  大哭: 'sad', 落泪: 'sad', 快哭了: 'sad', 委屈: 'sad', 可怜: 'sad', 流泪: 'sad',
  生气: 'angry', 怒: 'angry', angry: 'angry', mad: 'angry',
  哼: 'angry', 嫌弃: 'angry',
  害羞: 'shy', 羞: 'shy', shy: 'shy', 捂脸: 'shy', 尴尬: 'shy',
  惊讶: 'surprised', 吃惊: 'surprised', surprised: 'surprised',
  呆: 'surprised', 惊悚: 'surprised', 喊: 'surprised',
  平静: 'neutral', 普通: 'neutral', 无: 'neutral', neutral: 'neutral',
  吃瓜: 'neutral', 摊手: 'neutral', 无辜: 'neutral',
  困: 'sleepy', 困倦: 'sleepy', sleepy: 'sleepy', 睡着: 'sleepy', 睡: 'sleepy',
  爱: 'love', 喜欢: 'love', love: 'love',
  爱心: 'love', 给心: 'love', 色: 'love', 亲: 'love', 玫瑰: 'love',
};

const MOTION_ALIASES = {
  点头: 'nod', nod: 'nod',
  摇头: 'shake', shake: 'shake',
  看向用户: 'look_user', 看你: 'look_user', 面向你: 'look_user', 看我: 'look_user', 正视: 'look_user', look_user: 'look_user',
  左转: 'look_left', 看左: 'look_left', 看左边: 'look_left', 左边: 'look_left', 往左: 'look_left', look_left: 'look_left',
  右转: 'look_right', 看右: 'look_right', 看右边: 'look_right', 右边: 'look_right', 往右: 'look_right', look_right: 'look_right',
  抬头: 'look_up', 看上: 'look_up', 向上: 'look_up', look_up: 'look_up',
  低头: 'look_down', 看下: 'look_down', 向下: 'look_down', look_down: 'look_down',
  歪头: 'tilt', tilt: 'tilt',
  无: 'idle', 静止: 'idle', idle: 'idle',
};

/** 角色/提示词用的逻辑角：正视 pitch=28。固件机械中位约 45，下发前用 toDeviceAngles 平移。 */
const LOGICAL_YAW_MIN = -70;
const LOGICAL_YAW_MAX = 70;
const LOGICAL_PITCH_MIN = 5;
const LOGICAL_PITCH_MAX = 70;
const LOGICAL_PITCH_CENTER = 28;
const DEFAULT_DEVICE_PITCH_CENTER = 45;
const DEVICE_YAW_MIN = -90;
const DEVICE_YAW_MAX = 90;
const DEVICE_PITCH_MIN = 5;
const DEVICE_PITCH_MAX = 85;

/** 机身本地在场感状态（不调 LLM，由固件/桥执行） */
const PRESENCE_STATES = [
  'idle',       // 待机微动
  'listening',  // 在听
  'thinking',   // 等待念回复
  'speaking',   // 播报中
  'tracking',   // 人脸追踪中
  'drowsy',     // 困倦
  'asleep',     // 睡着
  'startled',   // 被唤醒/惊醒
];

const TAG_KIND = '(?:表情|情绪|emotion|动作|动作指令|motion)';
const LED_KIND = '(?:灯光|灯|LED|led)';
const SERVO_KIND = '(?:舵机|伺服|servo)';
const OPEN = '[\\[【［]';
const CLOSE = '[\\]】］]';

function tagClosedRe(kind) {
  return new RegExp(`${OPEN}\\s*(${kind})\\s*[：:]\\s*([^\\]】］\\n]+?)\\s*${CLOSE}`, 'gi');
}
function tagUnclosedRe(kind) {
  return new RegExp(`${OPEN}\\s*(${kind})\\s*[：:]\\s*([^\\]】］\\n]{1,40})\\s*$`, 'gim');
}
function tagParenRe(kind) {
  return new RegExp(`[（(]\\s*(${kind})\\s*[：:]\\s*([^）)\\n]{1,40})\\s*[）)]`, 'gi');
}

const NAMED_LED_COLORS = {
  红: '#ff3333', red: '#ff3333',
  绿: '#33cc66', green: '#33cc66',
  蓝: '#3388ff', blue: '#3388ff',
  粉: '#ff6b9d', pink: '#ff6b9d',
  白: '#ffffff', white: '#ffffff',
  黄: '#ffee33', yellow: '#ffee33',
  紫: '#aa55ff', purple: '#aa55ff',
  青: '#00cccc', cyan: '#00cccc',
  橙: '#ff9933', orange: '#ff9933',
  金: '#ffd700', gold: '#ffd700',
  暖白: '#ffe4c4', warm: '#ffe4c4',
  冷白: '#e0f4ff', cool: '#e0f4ff',
};

const ROBOT_INVOKE_ALIASES = {
  看一眼: 'peek', 看看: 'peek', 扫一眼: 'peek', 瞄一眼: 'peek', peek: 'peek',
  说句话: 'chat', 说话: 'chat', 聊一句: 'chat', 说一句: 'chat', chat: 'chat',
  逗你: 'tease', 逗: 'tease', 皮一下: 'tease', tease: 'tease',
  安静看: 'silent', 不说话: 'silent', 只看: 'silent', 只看不言: 'silent', 只看不说: 'silent', silent: 'silent',
  记住这一幕: 'peek_remember', 记住: 'peek_remember', 拍一张: 'peek_remember', snapshot: 'peek_remember',
  想你了: 'comfort', 想念: 'comfort', comfort: 'comfort',
  // 找人 = 人脸追踪对准；看环境请用「看一眼」，不要混用
    找人: 'find', 找你: 'find', 找我: 'find', 找一下: 'find', 找一找: 'find', 找到你: 'find',
  find: 'find', find_user: 'find', locate: 'find',
  // 一直跟着 = 持续人脸追踪；必须角色主动下指令
  跟着: 'follow', 一直跟着: 'follow', 跟着我: 'follow', 跟着用户: 'follow',
  跟着转: 'follow', follow: 'follow', track: 'follow',
  别跟着: 'unfollow', 不要跟着: 'unfollow', 停下跟着: 'unfollow', 停止跟着: 'unfollow',
  取消跟着: 'unfollow', unfollow: 'unfollow', stop_follow: 'unfollow',
};

function normalizeEmotion(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'neutral';
  return EMOTION_ALIASES[key] || EMOTION_ALIASES[String(raw || '').trim()] || 'neutral';
}

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '').trim();
  if (/^[0-9a-f]{3}$/i.test(h)) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return { r, g, b, hex: `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` };
  }
  if (/^[0-9a-f]{6}$/i.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      hex: `#${h}`,
    };
  }
  return null;
}

function parseColorToken(tok) {
  const s = String(tok || '').trim();
  if (!s) return null;
  if (/^(off|关|灭|关闭|none)$/i.test(s)) return { off: true };
  if (s.startsWith('#')) {
    const rgb = hexToRgb(s);
    return rgb ? { ...rgb, off: false } : null;
  }
  const rgbM = s.match(/^rgb\s*\(\s*(\d{1,3})\s*[,，]\s*(\d{1,3})\s*[,，]\s*(\d{1,3})\s*\)$/i);
  if (rgbM) {
    const r = Math.max(0, Math.min(255, parseInt(rgbM[1], 10)));
    const g = Math.max(0, Math.min(255, parseInt(rgbM[2], 10)));
    const b = Math.max(0, Math.min(255, parseInt(rgbM[3], 10)));
    const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    return { r, g, b, hex, off: false };
  }
  const named = NAMED_LED_COLORS[s] || NAMED_LED_COLORS[s.toLowerCase()];
  if (named) {
    const rgb = hexToRgb(named);
    return rgb ? { ...rgb, off: false } : null;
  }
  return null;
}

/**
 * 解析 [灯光:…] — 颜色任意（名/hex/rgb），闪烁频率 Hz（0=常亮）
 */
function parseLedDirective(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^(off|关|灭|关闭|none)$/i.test(s)) {
    return { off: true, frequencyHz: 0, brightness: 0, r: 0, g: 0, b: 0, hex: '#000000' };
  }
  const parts = s.split(/[\s,，;；]+/).filter(Boolean);
  let color = null;
  let frequencyHz = 0;
  let brightness = 1;
  for (const p of parts) {
    const kv = p.match(/^(freq|hz|频率|闪烁|blink)\s*[=＝]\s*([\d.]+)/i);
    if (kv) {
      frequencyHz = Number(kv[2]);
      continue;
    }
    const br = p.match(/^(bright|brightness|亮度)\s*[=＝]\s*([\d.]+)/i);
    if (br) {
      brightness = Math.max(0, Math.min(1, Number(br[2])));
      continue;
    }
    if (!color) {
      color = parseColorToken(p);
    } else {
      const n = Number(p);
      if (Number.isFinite(n)) frequencyHz = n;
    }
  }
  if (!color) return null;
  if (color.off) {
    return { off: true, frequencyHz: 0, brightness: 0, r: 0, g: 0, b: 0, hex: '#000000' };
  }
  void frequencyHz;
  return {
    off: false,
    r: color.r,
    g: color.g,
    b: color.b,
    hex: color.hex,
    // 恒为 0：灯只做静态色。闪烁得靠念每 180ms 推一帧合成，会持续占着网关连接。
    frequencyHz: 0,
    effect: 'steady',
    brightness: Math.max(0, Math.min(1, brightness)),
  };
}

/**
 * 把角色自写的动作描述落到这台桌面小人实际能做的头部动作。
 * 仍保留原文 motionRaw；无法对应时才标 custom。
 */
function inferPhysicalMotion(raw) {
  const t = String(raw || '').trim();
  if (!t) return 'idle';
  const key = t.toLowerCase();
  const exact = MOTION_ALIASES[key] || MOTION_ALIASES[t];
  if (exact) return exact;
  if (/摇头|左右摇|晃头|摇摇|摇两下/.test(t)) return 'shake';
  if (/点头|颔首|点了?两下|点点头/.test(t)) return 'nod';
  if (/歪头|侧头|歪歪|歪过|歪着/.test(t)) return 'tilt';
  if (/看左|左转|向左|往左|左边/.test(t)) return 'look_left';
  if (/看右|右转|向右|往右|右边/.test(t)) return 'look_right';
  if (/抬头|向上|仰头|抬脸|看上/.test(t)) return 'look_up';
  if (/低头|向下|俯视|垂头|看下/.test(t)) return 'look_down';
  if (/看向|看你|看我|正视|面向你|盯你|瞄你|看过来/.test(t)) return 'look_user';
  if (/不理|转过|背过|躲开|避开|扭开/.test(t)) return 'look_left';
  // 真人身体接触 / 抽象叙事：小机没有手和身体，收成撒娇式歪头
  if (/蹭|贴|挨|依偎|抱|亲|舔|咬|摸|手背|手心|脸颊|怀里|膝|扑/.test(t)) return 'tilt';
  if (/轻轻晃|慢慢晃|晃两下|晃晃/.test(t)) return 'shake';
  if (/无|静止|停|不动/.test(t)) return 'idle';
  return 'custom';
}

function parseMotionValue(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { motion: 'idle', motionRaw: '', motionCustom: false };
  const motion = inferPhysicalMotion(trimmed);
  return {
    motion,
    motionRaw: trimmed,
    motionCustom: motion === 'custom',
  };
}

function normalizeMotion(raw) {
  return parseMotionValue(raw).motion;
}

/**
 * 解析 [舵机:…] — 优先数字角度，其次动作名。
 * 例：yaw=25 pitch=28 · 25,28 · 左右=20 上下=30 · 左转 · 点头
 */
function parseServoDirective(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^(停|停止|复位|reset|idle|无|静止)$/i.test(s)) {
    return {
      raw: s, action: 'reset', motion: 'idle', motionRaw: s,
      motionCustom: false, params: {}, yaw: 0, pitch: LOGICAL_PITCH_CENTER,
    };
  }

  const params = {};
  const kvRe = /([a-z_\u4e00-\u9fff]+)\s*[=＝:：]\s*(-?\d+(?:\.\d+)?)/gi;
  let m;
  while ((m = kvRe.exec(s)) !== null) {
    const key = String(m[1] || '').toLowerCase();
    const num = Number(m[2]);
    if (!Number.isFinite(num)) continue;
    if (/^(yaw|偏航|左右|水平|横向)$/.test(key)) params.yaw = num;
    else if (/^(pitch|俯仰|上下|垂直|纵向)$/.test(key)) params.pitch = num;
    else if (/^(speed|速度|time|时长|ms)$/.test(key)) params.speed = num;
    else params[key] = num;
  }

  // 纯数字对：25,28 或 25，28 或 25 28
  if (params.yaw == null || params.pitch == null) {
    const pair = s.match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/);
    if (pair) {
      if (params.yaw == null) params.yaw = Number(pair[1]);
      if (params.pitch == null) params.pitch = Number(pair[2]);
    }
  }

  // 「左转 20」「看左边」「抬头」这类。数字是偏移量，不是机身原始角。
  const dir = s.match(/(看左(?:边)?|左转|向左|往左|看右(?:边)?|右转|向右|往右|抬头|向上|看上|低头|向下|看下|看我|正视)\s*(-?\d+(?:\.\d+)?)?/);
  if (dir && params.yaw == null && params.pitch == null) {
    const n = dir[2] != null ? Number(dir[2]) : null;
    if (/左/.test(dir[1])) {
      params.yaw = Number.isFinite(n) ? -Math.abs(n) : -28;
      params.pitch = LOGICAL_PITCH_CENTER;
    } else if (/右/.test(dir[1])) {
      params.yaw = Number.isFinite(n) ? Math.abs(n) : 28;
      params.pitch = LOGICAL_PITCH_CENTER;
    } else if (/抬头|向上|看上/.test(dir[1])) {
      params.yaw = 0;
      params.pitch = Number.isFinite(n)
        ? Math.max(LOGICAL_PITCH_MIN, LOGICAL_PITCH_CENTER - Math.abs(n))
        : 8;
    } else if (/低头|向下|看下/.test(dir[1])) {
      params.yaw = 0;
      params.pitch = Number.isFinite(n)
        ? Math.min(LOGICAL_PITCH_MAX, LOGICAL_PITCH_CENTER + Math.abs(n))
        : 42;
    } else {
      params.yaw = 0;
      params.pitch = LOGICAL_PITCH_CENTER;
    }
  }

  const hasAngles = params.yaw != null || params.pitch != null;
  const mp = parseMotionValue(s);
  const out = {
    raw: s,
    action: hasAngles ? 'angles' : (mp.motionCustom ? 'custom' : mp.motion),
    motion: hasAngles ? 'angles' : mp.motion,
    motionRaw: mp.motionRaw || s,
    motionCustom: !hasAngles && mp.motionCustom,
    params,
  };
  if (params.yaw != null) out.yaw = Number(params.yaw);
  if (params.pitch != null) out.pitch = Number(params.pitch);
  if (params.speed != null) out.speed = Number(params.speed);
  return out;
}

/** 统一成 MCP move_head 可用的 { yaw, pitch }；有数字用数字，否则动作名映射 */
function normalizeServoAngles(servoOrMotion) {
  const s = servoOrMotion && typeof servoOrMotion === 'object' ? servoOrMotion : {};
  const params = s.params && typeof s.params === 'object' ? s.params : {};
  let yaw = params.yaw ?? s.yaw;
  let pitch = params.pitch ?? s.pitch;
  if (yaw != null || pitch != null) {
    yaw = Number(yaw);
    pitch = Number(pitch);
    if (!Number.isFinite(yaw)) yaw = 0;
    if (!Number.isFinite(pitch)) pitch = LOGICAL_PITCH_CENTER;
    // 必须取整：网关对 move_head 做 isinstance(int) 校验，小数会被 400 打回，头就不动了
    yaw = Math.round(Math.max(LOGICAL_YAW_MIN, Math.min(LOGICAL_YAW_MAX, yaw)));
    pitch = Math.round(Math.max(LOGICAL_PITCH_MIN, Math.min(LOGICAL_PITCH_MAX, pitch)));
    return { yaw, pitch, numeric: true };
  }
  const action = String(s.action || s.motion || s.raw || s.motionRaw || servoOrMotion || '')
    .trim()
    .toLowerCase();
  if (!action || action === 'idle' || action === 'none' || action === 'reset') {
    return { yaw: 0, pitch: LOGICAL_PITCH_CENTER, numeric: false };
  }
  if (/look_left|左转|向左|看左/.test(action)) return { yaw: -28, pitch: LOGICAL_PITCH_CENTER, numeric: false };
  if (/look_right|右转|向右|看右/.test(action)) return { yaw: 28, pitch: LOGICAL_PITCH_CENTER, numeric: false };
  if (/look_up|抬头/.test(action)) return { yaw: 0, pitch: 8, numeric: false };
  if (/look_down|低头/.test(action)) return { yaw: 0, pitch: 42, numeric: false };
  if (/look_user|看你|看向|看我|正视/.test(action)) return { yaw: 0, pitch: LOGICAL_PITCH_CENTER, numeric: false };
  if (/nod|点头/.test(action)) return { yaw: 0, pitch: 42, numeric: false };
  if (/shake|摇头/.test(action)) return { yaw: -22, pitch: LOGICAL_PITCH_CENTER, numeric: false };
  if (/tilt|歪头/.test(action)) return { yaw: 18, pitch: LOGICAL_PITCH_CENTER, numeric: false };
  return null;
}

/** 固件开机平视约 pitch=45；角色提示词仍写 28。差多少由这个校准值补。 */
function resolvePitchCenter(settings = {}) {
  let n = Number(settings.robot_pitch_center);
  if (!Number.isFinite(n)) n = DEFAULT_DEVICE_PITCH_CENTER;
  return Math.round(Math.max(DEVICE_PITCH_MIN, Math.min(DEVICE_PITCH_MAX, n)));
}

function clampDeviceAngles(yaw, pitch) {
  let y = Number(yaw);
  let p = Number(pitch);
  if (!Number.isFinite(y)) y = 0;
  if (!Number.isFinite(p)) p = DEFAULT_DEVICE_PITCH_CENTER;
  return {
    yaw: Math.round(Math.max(DEVICE_YAW_MIN, Math.min(DEVICE_YAW_MAX, y))),
    pitch: Math.round(Math.max(DEVICE_PITCH_MIN, Math.min(DEVICE_PITCH_MAX, p))),
  };
}

/**
 * 逻辑角 → 机身角。payload.device 为真时视为已经是机身角（测试滑块用）。
 */
function toDeviceAngles(angles, settings = {}) {
  if (!angles || typeof angles !== 'object') return null;
  if (angles.device) {
    const d = clampDeviceAngles(angles.yaw, angles.pitch);
    return { ...d, device: true };
  }
  const logical = normalizeServoAngles(angles);
  if (!logical) return null;
  const center = resolvePitchCenter(settings);
  const d = clampDeviceAngles(
    logical.yaw,
    center + (logical.pitch - LOGICAL_PITCH_CENTER),
  );
  return { ...d, logicalYaw: logical.yaw, logicalPitch: logical.pitch };
}

function fromDeviceAngles(yaw, pitch, settings = {}) {
  const d = clampDeviceAngles(yaw, pitch);
  const center = resolvePitchCenter(settings);
  return {
    yaw: Math.round(Math.max(LOGICAL_YAW_MIN, Math.min(LOGICAL_YAW_MAX, d.yaw))),
    pitch: Math.round(Math.max(
      LOGICAL_PITCH_MIN,
      Math.min(LOGICAL_PITCH_MAX, LOGICAL_PITCH_CENTER + (d.pitch - center)),
    )),
  };
}

/**
 * 转头后再拍照要等多久。move_head 返回不代表舵机到位。
 * 约 8ms/度（每 10° 约 80ms），另加 180ms 起步，最短 120、最长 1000。
 */
function headMoveSettleMs(fromAngles, toAngles, overrideMs) {
  const forced = Number(overrideMs);
  if (Number.isFinite(forced) && forced > 0) {
    return Math.max(120, Math.min(1000, Math.round(forced)));
  }
  const fy = Number(fromAngles?.yaw);
  const fp = Number(fromAngles?.pitch);
  const ty = Number(toAngles?.yaw);
  const tp = Number(toAngles?.pitch);
  const dy = Number.isFinite(fy) && Number.isFinite(ty) ? Math.abs(ty - fy) : 28;
  const dp = Number.isFinite(fp) && Number.isFinite(tp) ? Math.abs(tp - fp) : 12;
  const deg = Math.sqrt(dy * dy + dp * dp);
  return Math.max(120, Math.min(1000, Math.round(180 + deg * 8)));
}

function isHeadGesture(servoOrMotion) {
  const s = servoOrMotion && typeof servoOrMotion === 'object' ? servoOrMotion : {};
  const a = String(
    s.action || s.motion || s.raw || s.motionRaw
    || (typeof servoOrMotion === 'string' ? servoOrMotion : ''),
  ).trim().toLowerCase();
  if (!a || a === 'angles' || a === 'idle' || a === 'reset') return '';
  if (/\bnod\b|点头/.test(a)) return 'nod';
  if (/\bshake\b|摇头/.test(a)) return 'shake';
  if (/\btilt\b|歪头/.test(a)) return 'tilt';
  return '';
}

/**
 * 点头/摇头/歪头是一段动作，不是一个静止角。
 * 用机身角，从当前位置起跳，做完回到原处（歪头除外，歪完停在侧边）。
 */
function headGestureSteps(kind, from, settings = {}) {
  const home = clampDeviceAngles(
    Number.isFinite(Number(from?.yaw)) ? from.yaw : 0,
    Number.isFinite(Number(from?.pitch)) ? from.pitch : resolvePitchCenter(settings),
  );
  if (kind === 'nod') {
    const delta = 24;
    const downPitch = home.pitch + delta <= DEVICE_PITCH_MAX
      ? home.pitch + delta
      : home.pitch - delta;
    const down = clampDeviceAngles(home.yaw, downPitch);
    return [
      { ...down, waitMs: 280 },
      { ...home, waitMs: 260 },
      { ...down, waitMs: 260 },
      { ...home, waitMs: 220 },
    ];
  }
  if (kind === 'shake') {
    const left = clampDeviceAngles(home.yaw - 22, home.pitch);
    const right = clampDeviceAngles(home.yaw + 22, home.pitch);
    return [
      { ...left, waitMs: 240 },
      { ...right, waitMs: 260 },
      { ...home, waitMs: 220 },
    ];
  }
  if (kind === 'tilt') {
    const side = clampDeviceAngles(home.yaw >= 0 ? home.yaw + 16 : home.yaw - 16, home.pitch);
    return [{ ...side, waitMs: 280 }];
  }
  return [];
}

function servoPayloadFromMotion(parsed) {
  if (!parsed?.foundMotion || parsed.motion === 'idle') return null;
  if (parsed.servo) return null;
  if (parsed.motionCustom) {
    // 自定义动作文案里若带了数字，尽量拆出来
    const fromRaw = parseServoDirective(parsed.motionRaw || '');
    if (fromRaw && (fromRaw.yaw != null || fromRaw.pitch != null)) return fromRaw;
    return {
      raw: parsed.motionRaw,
      action: 'custom',
      motion: 'custom',
      motionRaw: parsed.motionRaw,
      motionCustom: true,
      params: {},
    };
  }
  const angles = normalizeServoAngles({ motion: parsed.motion, action: parsed.motion });
  const gesture = isHeadGesture(parsed.motion);
  return {
    raw: parsed.motionRaw || parsed.motion,
    action: parsed.motion,
    motion: parsed.motion,
    motionRaw: parsed.motionRaw || parsed.motion,
    motionCustom: false,
    // 点头/摇头不要写成静止角，否则会被当成「低头停住」，第二次完全不动
    params: gesture || !angles ? {} : { yaw: angles.yaw, pitch: angles.pitch },
    yaw: gesture ? undefined : angles?.yaw,
    pitch: gesture ? undefined : angles?.pitch,
  };
}

function motionSuggestsGlance(parsed) {
  // 转头看你 ≠ 开摄像头。只有角色明确写了看一眼类桌宠标记才建议开摄。
  return false;
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * 从设置拼出「行为层」配置：机身本地执行，不费 token
 */
function buildBehaviorProfile(settings = {}) {
  const presenceOn = settings.robot_presence_enabled !== '0';
  const faceTrackOn = settings.robot_face_track_enabled !== '0';
  const decaySec = clampInt(settings.robot_expression_decay_sec, 3, 120, 12);
  const drowsySec = clampInt(settings.robot_drowsy_idle_sec, 30, 1800, 180);
  const screen = resolveScreenPolicy(settings);
  const led = resolveLedPolicy(settings);
  return {
    presenceEnabled: presenceOn,
    presenceStates: PRESENCE_STATES,
    muted: screen.muted,
    /** 灯光总开关；关掉后任何情绪都不点灯 */
    ledEnabled: led.enabled,
    /** 上限亮度 0.05–1，情绪给的亮度会被压到这个值以下 */
    ledMaxBrightness: led.maxBrightness,
    /** 机身平视的 pitch（角色写 28 会映射到这个值） */
    pitchCenter: resolvePitchCenter(settings),
    showChatOnScreen: screen.showChatOnScreen,
    syncChat: screen.syncChat,
    playTts: screen.playTts,
    /** 表情展示后，经若干秒衰减回中性（本地定时器，不调 API） */
    expressionDecaySec: decaySec,
    /** 无人互动多久进入困倦（本地，不调 API） */
    drowsyIdleSec: drowsySec,
    /** 摄像头跟人脸转头：本地 CV + 舵机，不调 LLM */
    faceTrackEnabled: faceTrackOn,
    /** 小机自己的摄像头读表情：看人时把画面送到念，对话可带 userEmotion */
    emotionSenseEnabled: String(settings.robot_emotion_sense_enabled || '0') === '1',
    /** 小机自己的摄像头认人：先录入参考正脸，看人时比对 */
    faceprintEnabled: String(settings.robot_faceprint_enabled || '0') === '1',
    notes: {
      presence: '在场感状态机在机身本地跑：idle→drowsy→asleep；被说话/人脸惊醒→startled→listening。不调用念聊天 API。',
      expressionDecay: '对话返回的 emotion 先完整展示，再按 expressionDecaySec 渐变回 neutral。衰减过程零 API。',
      faceTrack: '找人：角色调用找人时，小机转头扫一圈，BlazeFace 检脸并对准；开了「认出是不是你」会再比对。调用跟着才持续跟。看环境用看一眼，不扫视找人。',
      emotionSense: '情绪识别用小机自己的摄像头。看一眼先应声；截图进念后由角色聊天模型识图。表情/认人可后台补，不挡识图。',
      faceprint: '面容识别同样后台识图。看一眼不额外等角色对话；下一句说话才带是不是你。',
    },
  };
}

/** 角色自己写动作：必须是这台小机头/脖子做得到的。 */
function buildRobotMotionTagLines() {
  return [
    '精确控用转头或灯光工具；灯不要动不动满亮。',
  ];
}

/** 平时不进提示词。 */
function buildRobotBodyCuePrompt() {
  return '灯头跟语气走。精确控用转头或灯光工具。';
}

function buildRobotMotionTagPromptBlock() {
  return buildRobotBodyCuePrompt();
}

/**
 * 角色没写 [灯光] 时按语气补的颜色。
 * 亮度得写明：不写会默认满亮，桌上一颗全亮的灯很刺眼。
 */
const LED_BY_EMOTION = {
  shy: '粉 亮度=0.7',
  love: '粉 亮度=0.55',
  angry: '红 亮度=0.85',
  happy: '金 亮度=0.65',
  sad: '蓝 亮度=0.45',
  surprised: '白 亮度=0.8',
  sleepy: '关',
};

function inferHeadGestureFromText(text) {
  const t = String(text || '');
  if (!t) return '';
  if (/摇头|摇摇头|摇了摇头/.test(t)) return 'shake';
  if (/点头|点点头|点了点头|颔首/.test(t)) return 'nod';
  if (/歪头|歪了歪|歪歪头/.test(t)) return 'tilt';
  return '';
}

function inferEmotionFromSpeak(text) {
  const t = String(text || '');
  if (!t) return null;
  if (/哈哈|嘿嘿|嘻嘻|开心|太好了/.test(t)) return 'happy';
  if (/哼+|烦死|滚开|讨厌|气死/.test(t)) return 'angry';
  if (/才不是|才没有|才没|害羞|别看/.test(t)) return 'shy';
  if (/唉+|难过|不想|算了吧/.test(t)) return 'sad';
  if (/[！!]{2,}|诶+|啊\?|什么啊/.test(t)) return 'surprised';
  if (/困了|想睡|眼皮/.test(t)) return 'sleepy';
  return null;
}

function inferMotionFromSpeak(text, emotion) {
  const t = String(text || '').trim();
  if (!t) {
    if (emotion === 'shy' || emotion === 'love') return 'tilt';
    if (emotion === 'angry') return 'shake';
    if (emotion === 'surprised') return 'look_user';
    return null;
  }
  if (/摇头|摇摇头|摇了摇头/.test(t)) return 'shake';
  if (/点头|点点头|点了点头|颔首/.test(t)) return 'nod';
  if (t.length < 48 && /好的|好啊|行吧|可以啊|嗯嗯|那行|那就这样|^好[。！~～呀哦]|成[。！]/.test(t)) return 'nod';
  if (/才不|才不要|不要|不行|休想|免谈|懒得|拒绝/.test(t)) return 'shake';
  if (t.length < 40 && /[?？]|什么意思|怎么回事|啊\?|嗯\?/.test(t)) return 'tilt';
  if (/看过来|把头转过来|转头看你|转过来看|看向你/.test(t)) return 'look_user';
  if (emotion === 'shy' || emotion === 'love') return 'tilt';
  if (emotion === 'angry') return 'shake';
  if (emotion === 'surprised') return 'look_user';
  if (emotion === 'happy' && t.length < 24) return 'nod';
  return null;
}

/**
 * 角色没写标记时，用语气补灯/头/脸。已写的标记优先，不覆盖。
 */
function enrichRobotDirectives(parsed, speak) {
  const out = parsed && typeof parsed === 'object' ? { ...parsed } : parseRobotDirectives(speak);
  const text = String(speak || out.speak || '');
  if (!out.foundEmotion || out.emotion === 'neutral') {
    const guessed = inferEmotionFromSpeak(text);
    if (guessed) {
      out.emotion = guessed;
      out.foundEmotion = true;
      out.inferredEmotion = true;
    }
  }
  if (!out.foundMotion && !out.foundServo) {
    const motion = inferMotionFromSpeak(text, out.emotion);
    if (motion && motion !== 'idle') {
      out.motion = motion;
      out.motionRaw = motion;
      out.foundMotion = true;
      out.inferredMotion = true;
    }
  }
  if (!out.foundLed) {
    const spec = LED_BY_EMOTION[out.emotion];
    if (spec && out.emotion && out.emotion !== 'neutral') {
      const led = parseLedDirective(spec);
      if (led) {
        out.led = led;
        out.foundLed = true;
        out.inferredLed = true;
      }
    }
  }
  return out;
}

/**
 * 用户这句点到了哪类机身能力。能力说明已在 tool schema，这里不再教格式。
 */
function situationalRobotHint(_userMessage) {
  return '';
}

function buildRobotExtraPrompt(settings = {}, opts = {}) {
  const device = String(settings.robot_device_name || 'Stack-chan').trim() || 'Stack-chan';
  const behavior = buildBehaviorProfile(settings);
  const lines = [
    `【桌宠会话·硬性】用户正通过桌上的「念·桌面伴」（${device} 一类桌面机器人）和你说话。`,
    '· 你的声音会从机器人喇叭里播出来；用户可能在旁边对着机器人说话，或通过它的麦克风。',
    '· 这是念的桌面终端，不是真人见面；偶尔提机器即可，勿每句 meta。',
    '· 回复必须短、口语、适合朗读：默认 1～3 句，不要长文、不要微信式连发很多气泡。',
    '· 只输出你说出口的话；不要*动作描写*、不要旁白，也不要把动作写成对白。',
    '· 灯和头跟语气走。开镜头不会自动转头：拍面前用看一眼，扫一圈找人用找人。',
  ];
  lines.push(
    '【电子屏】换小机脸上的表情用工具，不要假设会下载整屏 PNG。'
  );

  if (behavior.presenceEnabled) {
    lines.push(
      '【在场感】机器人本体有本地在场状态（待机/听你说/说话/困倦/睡着/被惊醒）。你只需正常短句回话；困倦与待机动画由机器自己演，不必每句交代「我困了」。若用户刚把你叫醒，语气可略懵一下再接上。'
    );
  }
  if (behavior.faceTrackEnabled) {
    lines.push(
      '【桌上小机】找人、一直跟着、看环境用对应工具；默认不一直跟人转头。'
    );
  }
  // 灯/头已在 buildRobotBodyCuePrompt，勿再复述一遍

  if (behavior.emotionSenseEnabled) {
    lines.push(
      '【情绪识别】桌上这台机器人看人时会用自己的摄像头扫一眼对方表情。若提示里带了【此刻·用户表情】，可轻轻共情或换脸上的表情；不要假装一直在监视，也不要每次都点破「我看出你…」。'
    );
  }
  if (behavior.faceprintEnabled && opts.faceprintEnrolled) {
    lines.push(
      '【认人】桌上这台机器人有自己的摄像头。当它看过面前的人之后，若提示写了「认出是用户本人」，旁边就是 ta；若写了可能不是本人，自然留意即可。不要盘问「你是谁」，也不要每句都宣布「我认出你了」。'
    );
  }
  if (opts.voiceprintEnrolled) {
    try {
      const note = require('./voiceprint-helper').voiceprintStandingNote({ robot: true });
      if (note) lines.push(note);
    } catch {}
  }
  if (opts.facePresent === true) {
    lines.push('【此刻】摄像头检测到用户在镜头前——对方就在机器人旁边，可更自然地看着 ta 说话。');
  } else if (opts.facePresent === false) {
    lines.push('【此刻】摄像头未清晰检测到人脸；对方可能走开或没入镜，不要假设 ta 正盯着屏幕。');
  } else if (!opts.userEmotion && opts.isUser === undefined && !opts.faceprintNote) {
    lines.push('【此刻】这一轮还没有镜头画面。想看面前就调用看一眼。');
  }
  if (opts.userEmotion && opts.userEmotion !== 'neutral') {
    const zh = emotionLabelZh(opts.userEmotion);
    lines.push(`【此刻·用户表情】桌上机器人自己的摄像头判断对方此刻偏「${zh}」。可自然贴合一下语气或换脸上的表情共情，仍保持短句，不要审问对方情绪。`);
  }
  if (opts.faceprintNote) {
    lines.push(opts.faceprintNote);
  }
  if (opts.voiceprintNote) {
    lines.push(opts.voiceprintNote);
  }
  if (opts.isUser === true) {
    lines.push('【此刻·镜头里的人】辨认结果：是用户本人。可以自然当作对方就在桌边。');
  } else if (opts.isUser === false && opts.facePresent === true) {
    const subj = String(opts.subjectType || '').trim();
    if (subj === 'other') {
      lines.push('【此刻·镜头里的人】画面里有人，但不是用户本人。不要当成用户在跟你说话；可疑惑、警惕或随口问「谁啊」。');
    } else {
      lines.push('【此刻·镜头里的人】画面里有人，但辨认不出是不是用户。不要默认就是对方。');
    }
  }
  if (opts.presence && PRESENCE_STATES.includes(String(opts.presence))) {
    const p = String(opts.presence);
    if (p === 'drowsy' || p === 'asleep' || p === 'startled') {
      lines.push(`【机身状态】机器人当前本地状态为「${p}」（刚互动或刚醒）。口语可略贴合，仍保持短句。`);
    }
  }
  if (behavior.expressionDecaySec > 0) {
    lines.push(
      `【表情】脸上的表情会停留约 ${behavior.expressionDecaySec} 秒后自行淡回平静；不必连续多轮重复同一表情。`
    );
  }
  if (opts.operating) {
    if (opts.operatingMode === 'screen') {
      lines.push(
        '【操作中】你正看着对方电脑屏幕并协助操作。回复必须极短：进度、卡住、听改口令、叫停立刻停。不要长篇。用户可能同时在手机聊天里说话，那也是在指挥你。'
      );
    } else {
      lines.push(
        '【操纵中】你正通过小机陪用户在桌边玩。回复可短一些；用户也可能同时在手机里跟你聊。'
      );
    }
  }
  if (opts.muted) {
    lines.push('【禁言】对方把你桌上的喇叭关掉了：你的声音播不出来，但电子屏仍会显示你说的话。你知道自己被禁言了，可以按性格吐槽或配合，不必每句都提。');
  }
  const headTouch = buildHeadTouchPromptLine({ forRobot: true });
  if (headTouch) lines.push(headTouch);
  return lines.join('\n');
}

function replaceAllTagForms(text, kind, onHit) {
  let t = String(text || '');
  const hit = (_m, k, val) => {
    onHit(String(k || ''), String(val || '').trim());
    return '';
  };
  t = t.replace(tagClosedRe(kind), hit);
  t = t.replace(tagUnclosedRe(kind), hit);
  t = t.replace(tagParenRe(kind), hit);
  return t;
}

function tidySpeak(text) {
  return String(text || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

/**
 * 从模型回复中抽出表情/动作，并得到可播报正文。
 * 若整段只剩标记：speak 为空字符串（不要把标记回填进气泡）。
 */
function parseRobotDirectives(rawText) {
  let emotion = 'neutral';
  let motion = 'idle';
  let motionRaw = '';
  let motionCustom = false;
  let foundEmotion = false;
  let foundMotion = false;
  let led = null;
  let servo = null;
  let foundLed = false;
  let foundServo = false;
  let text = String(rawText || '');

  text = replaceAllTagForms(text, TAG_KIND, (kind, val) => {
    if (/表情|情绪|emotion/i.test(kind)) {
      emotion = normalizeEmotion(val);
      foundEmotion = true;
    } else if (/动作|motion/i.test(kind)) {
      const mp = parseMotionValue(val);
      motion = mp.motion;
      motionRaw = mp.motionRaw;
      motionCustom = mp.motionCustom;
      foundMotion = true;
    }
  });

  text = replaceAllTagForms(text, LED_KIND, (_k, val) => {
    led = parseLedDirective(val);
    foundLed = !!led;
  });

  text = replaceAllTagForms(text, SERVO_KIND, (_k, val) => {
    servo = parseServoDirective(val);
    foundServo = !!servo;
  });

  text = replaceAllTagForms(text, '桌宠', () => {});

  const speak = tidySpeak(text);
  return {
    speak,
    emotion,
    motion,
    motionRaw,
    motionCustom,
    foundEmotion,
    foundMotion,
    led,
    servo,
    foundLed,
    foundServo,
  };
}

function stripRobotTags(text) {
  let t = String(text || '');
  t = replaceAllTagForms(t, TAG_KIND, () => {});
  t = replaceAllTagForms(t, LED_KIND, () => {});
  t = replaceAllTagForms(t, SERVO_KIND, () => {});
  t = replaceAllTagForms(t, '桌宠', () => {});
  return tidySpeak(t);
}

/**
 * 角色自愿调用桌上小机：优先认 tool_calls 转成的内部标记，旧 [桌宠:…] 仍作兜底。
 * @returns {{ intent: string|null, textWithout: string, found: boolean, source?: string|null }}
 */
function userAskedRobotToLook(userText) {
  try {
    return !!require('./robot-toolbook-helper').userAskedRobotToLook(userText);
  } catch {
    return false;
  }
}

function resolveRobotIntentFromUserAsk(userText) {
  try {
    return require('./robot-toolbook-helper').resolveRobotIntentFromUserAsk(userText);
  } catch {
    return { intent: null, when: null, found: false };
  }
}

function inferRobotLookFallback(userText) {
  return userAskedRobotToLook(userText) ? 'peek' : null;
}

const ROBOT_CAMERA_VISION_INTENTS = new Set(['peek', 'silent', 'find', 'peek_remember']);
function isRobotCameraVisionIntent(intent) {
  return ROBOT_CAMERA_VISION_INTENTS.has(String(intent || '').trim());
}

/** 用户明确要找人时，角色写的「看一眼」不能把找人盖掉。 */
function preferFindIfUserAsked(characterIntent, userAskIntent) {
  if (String(userAskIntent || '').trim() === 'find') return 'find';
  return characterIntent || null;
}

function parseRobotInvoke(rawText) {
  try {
    const book = require('./robot-toolbook-helper');
    const hit = book.resolveRobotIntentFromText(rawText);
    return {
      intent: hit.intent,
      textWithout: hit.textWithout,
      found: !!hit.found,
      source: hit.source || null,
    };
  } catch {
    let intent = null;
    const textWithout = tidySpeak(replaceAllTagForms(String(rawText || ''), '桌宠', (_k, val) => {
      const raw = String(val || '').trim();
      const key = raw.toLowerCase();
      intent =
        ROBOT_INVOKE_ALIASES[key] ||
        ROBOT_INVOKE_ALIASES[raw] ||
        'chat';
    }));
    return { intent, textWithout, found: !!intent, source: intent ? 'tag' : null };
  }
}

function listEmotionOptions() {
  return ['happy', 'sad', 'angry', 'shy', 'surprised', 'neutral', 'sleepy', 'love'];
}

function buildFacePayload(_settings = {}, robotEmotionsRaw, emotion = 'neutral') {
  const key = normalizeEmotion(emotion);
  return {
    emotion: key,
    emotionUrl: '',
    emotionAssets: {},
    customEmotionAssets: parseRobotEmotions(robotEmotionsRaw),
  };
}

function listMotionOptions() {
  return ['nod', 'shake', 'look_user', 'look_left', 'look_right', 'look_up', 'look_down', 'tilt', 'idle'];
}

function parseRobotEmotions(raw) {
  let obj = {};
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
  } catch {
    obj = {};
  }
  if (!obj || typeof obj !== 'object') obj = {};
  const out = {};
  for (const k of listEmotionOptions()) {
    const v = String(obj[k] || '').trim();
    if (!v) continue;
    out[k] = v.startsWith('/') ? v : `/uploads/${v.replace(/^\/uploads\//, '')}`;
  }
  return out;
}

/**
 * 角色对桌宠抓拍图写私密心得（第一人称、符合人设）
 */
async function generateSnapshotNote(settings, char, opts = {}) {
  const imageUrl = String(opts.imageUrl || '').trim();
  const publicBase = String(opts.publicBase || '').trim();
  const abs = toAbsoluteMediaUrl(imageUrl, publicBase);
  const context = String(opts.context || opts.contextText || '').trim().slice(0, 200);
  const facePresent = opts.facePresent === true;
  const isUser = opts.isUser === true;
  const subjectType = String(opts.subjectType || '').trim();
  const profile = buildCharacterProfile(char || {});
  const name = String(char?.name || '角色').trim() || '角色';
  const situParts = [];
  if (isUser) situParts.push('镜头里是用户本人');
  else if (subjectType === 'other') situParts.push('镜头里有人但不是用户');
  else if (facePresent) situParts.push('镜头里有人但辨认不出是不是用户');
  else situParts.push('镜头里未必清晰拍到人');
  if (context) situParts.push(`抓拍前后对方说过：「${context}」`);
  const situ = situParts.join('；');

  const systemPrompt = [
    `你是${name}本人。你刚通过桌上的「念·桌面伴」机器人摄像头，悄悄抓拍了一张照片存进自己的相册（拍的是用户/眼前场景，归类为「拍其他」）。`,
    profile ? `【你是谁】\n${profile}` : '',
    '【任务】用第一人称写 1～2 句私密心得，像写进手机相册备注：可有占有欲、嫌弃、心软、吐槽、想念，须完全符合你的性格与和用户的关系。',
    '禁止：AI/模型/扮演/meta；不要客观描述照片像素；不要像新闻标题；不要加引号或「心得：」前缀。',
    situ ? `【情境】${situ}` : '',
  ].filter(Boolean).join('\n\n');

  const ask = '写心得（只输出正文）：';

  try {
    let apiHistory = [];
    if (abs) {
      const picMsg = { id: 'robot_snap_' + Date.now(), role: 'user', content: abs, type: 'image' };
      apiHistory = buildHistoryApiMessages([picMsg], publicBase, {});
      if (apiHistory.length) {
        const last = apiHistory[apiHistory.length - 1];
        if (Array.isArray(last.content)) {
          last.content.unshift({ type: 'text', text: ask });
        } else {
          apiHistory.push({ role: 'user', content: ask });
        }
      }
    }
    const raw = await callChatAPIComplete(
      settings,
      systemPrompt,
      abs ? null : `${ask}\n（你没看到画面细节，只凭刚才的情境写一句符合性格的感受。）`,
      'chat',
      apiHistory,
    );
    return String(raw || '')
      .replace(/^\s*心得[：:]\s*/i, '')
      .replace(/^["「『]|["」』]$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280);
  } catch (e) {
    console.warn('[robot/snapshot-note]', e.message);
    return '';
  }
}

async function generateSnapshotCaption(settings, char, opts = {}) {
  const imageUrl = String(opts.imageUrl || '').trim();
  const publicBase = String(opts.publicBase || '').trim();
  const abs = toAbsoluteMediaUrl(imageUrl, publicBase);
  if (!abs) return '桌宠抓拍';
  try {
    const picMsg = { id: 'robot_cap_' + Date.now(), role: 'user', content: abs, type: 'image' };
    const apiHistory = buildHistoryApiMessages([picMsg], publicBase, {});
    const ask = '用 4～12 个汉字给这张抓拍起相册标题（只输出标题，不要标点）：';
    if (apiHistory.length) {
      const last = apiHistory[apiHistory.length - 1];
      if (Array.isArray(last.content)) last.content.unshift({ type: 'text', text: ask });
    }
    const raw = await callChatAPIComplete(
      settings,
      '你是相册标题助手。只输出极短中文标题。',
      null,
      'chat',
      apiHistory,
    );
    const cap = String(raw || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9·]/g, '').trim().slice(0, 16);
    return cap || '桌宠抓拍';
  } catch {
    return '桌宠抓拍';
  }
}

function parseFacePresent(body) {
  if (!body || typeof body !== 'object') return undefined;
  const v = body.facePresent ?? body.face_present;
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

function emotionLabelZh(emotion) {
  const map = {
    happy: '开心', sad: '难过', angry: '生气', shy: '害羞',
    surprised: '惊讶', neutral: '平静', sleepy: '困', love: '爱',
  };
  return map[normalizeEmotion(emotion)] || '平静';
}

/** 角色连续心情 → 小机表情键（无精确分数，只映主情绪） */
function moodToRobotEmotion(mood = {}) {
  if (mood?.flashpoint?.type === 'anger') return 'angry';
  if (mood?.flashpoint?.type === 'hurt') return 'sad';
  if (mood?.flashpoint?.type === 'breakdown') return 'sad';
  if (mood?.flashpoint?.type === 'desire') return 'love';
  if (mood?.flashpoint?.type === 'longing') return 'shy';
  if (mood?.flashpoint?.type === 'intimacy') return 'love';
  const primary = String(mood?.primary || 'calm');
  const map = {
    calm: 'neutral',
    happy: 'happy',
    warm: 'love',
    low: 'sad',
    hurt: 'sad',
    angry: 'angry',
    anxious: 'shy',
    lonely: 'sad',
    tired: 'sleepy',
    excited: 'happy',
    bitter: 'angry',
    longing: 'shy',
    desire: 'love',
    intimate: 'love',
  };
  return map[primary] || 'neutral';
}

/** 连续心情 → 区分明显的环境灯色；动画速度由 arousal 轻度调节。 */
function moodToLedSpec(mood = {}) {
  const primary = String(mood?.primary || 'calm');
  const flash = String(mood?.flashpoint?.type || '');
  const arousal = Math.max(0, Math.min(100, Number(mood?.arousal) || 0));
  /**
   * 只出静态色。呼吸/闪烁得由念每 180ms 推一帧合成，等于持续占着网关连接，
   * 会跟摄像头和舵机抢通道，所以不做动画 —— 心情只决定颜色。
   * 越激动越亮，用来替代原先「越激动闪得越快」。
   */
  const withRgb = (hex, r, g, b, base, arousalBoost = 0) => ({
    off: false,
    hex,
    r,
    g,
    b,
    brightness: Math.max(0.05, Math.min(1, base + arousalBoost * (arousal / 100))),
    effect: 'steady',
    frequencyHz: 0,
    source: 'mood',
  });

  if (flash === 'anger' || primary === 'angry' || primary === 'bitter') {
    return withRgb('#ff2d2d', 255, 45, 45, 0.75, 0.25);
  }
  if (flash === 'hurt' || primary === 'hurt') {
    return withRgb('#8b5cf6', 139, 92, 246, 0.62);
  }
  if (flash === 'breakdown' || primary === 'low' || primary === 'lonely') {
    return withRgb('#7b8494', 123, 132, 148, 0.2);
  }
  if (flash === 'longing' || primary === 'longing') {
    return withRgb('#2979ff', 41, 121, 255, 0.55, 0.2);
  }
  if (flash === 'desire' || primary === 'desire') {
    return withRgb('#ff7a1a', 255, 122, 26, 0.6, 0.25);
  }
  if (flash === 'intimacy' || primary === 'intimate' || primary === 'warm') {
    return withRgb('#ff5ca8', 255, 92, 168, 0.55);
  }
  if (primary === 'happy' || primary === 'excited') {
    return withRgb('#ffd84d', 255, 216, 77, primary === 'excited' ? 0.85 : 0.65);
  }
  if (primary === 'anxious') {
    return withRgb('#36c98f', 54, 201, 143, 0.42, 0.2);
  }
  if (primary === 'tired') {
    return withRgb('#b7a58a', 183, 165, 138, 0.15);
  }
  return withRgb('#fff4dc', 255, 244, 220, 0.28);
}

const _deferredMoodHardware = new Map();

/**
 * 把角色心情映到小机脸（不说话、不改聊天）。
 * 刚有对话表情（约 45 秒内 source=chat）时不覆盖，避免打断当轮演技。
 */
function syncFaceFromCharacterMood(charId, mood, opts = {}) {
  const id = parseInt(charId, 10);
  if (!id || !mood) return null;
  try {
    const db = require('./db');
    const settings = opts.settings || Object.fromEntries(
      (db.prepare('SELECT key, value FROM settings').all() || []).map((r) => [r.key, r.value])
    );
    if (String(settings.robot_enabled || '0') !== '1') return null;
    if (parseInt(settings.robot_character_id, 10) !== id) return null;

    const robotScreen = require('./robot-screen-helper');
    const cur = robotScreen.getScreen(id);
    const src = String(cur.source || '');
    const updatedAt = Date.parse(cur.updatedAt) || 0;
    const ageMs = Date.now() - updatedAt;
    // 对话/传感/摸头刚刷过脸：让当轮表情优先，别被心情同步盖掉
    if (!opts.force && (src === 'chat' || src === 'sense' || src === 'touch') && ageMs >= 0 && ageMs < 45000) {
      const old = _deferredMoodHardware.get(id);
      if (old) clearTimeout(old);
      const timer = setTimeout(() => {
        _deferredMoodHardware.delete(id);
        syncFaceFromCharacterMood(id, mood, { ...opts, force: false });
      }, 45100 - ageMs);
      if (timer.unref) timer.unref();
      _deferredMoodHardware.set(id, timer);
      return null;
    }
    const deferred = _deferredMoodHardware.get(id);
    if (deferred) clearTimeout(deferred);
    _deferredMoodHardware.delete(id);
    // 同表情且不久前已映过：跳过
    const key = moodToRobotEmotion(mood);
    const led = moodToLedSpec(mood);
    if (!opts.force && cur.emotion === key && src === 'mood' && ageMs < 60000) {
      return { emotion: key, skipped: true };
    }

    const char = opts.char || db.prepare('SELECT id, robot_emotions FROM characters WHERE id=?').get(id);
    const face = buildFacePayload(settings, char?.robot_emotions, key);
    const publicBase = String(opts.publicBase || settings.public_base_url || settings.robot_public_base_url || '').replace(/\/$/, '');

    robotScreen.setScreen(id, {
      emotion: key,
      source: 'mood',
      displayText: '',
      reply: '',
      motion: 'idle',
      led,
    }, publicBase);

    try {
      const robotCommands = require('./robot-commands-helper');
      robotCommands.enqueueDisplay(id, {
        emotion: key,
        source: 'mood',
        displayText: '',
        motion: 'idle',
        led,
      });
    } catch {}

    try {
      const { push } = require('./push');
      push('robot_event', {
        event: 'mood_face',
        characterId: id,
        emotion: key,
      });
    } catch {}

    return { emotion: key, led };
  } catch (e) {
    console.warn('[robot] mood face', e.message);
    return null;
  }
}

/** 用户情绪 → 小机共情表情 */
function reactionForUserEmotion(userEmotion) {
  const e = normalizeEmotion(userEmotion);
  if (e === 'happy') return 'happy';
  if (e === 'love') return 'love';
  if (e === 'sad') return 'sad';
  if (e === 'angry') return 'shy';
  if (e === 'surprised') return 'surprised';
  if (e === 'sleepy') return 'sleepy';
  if (e === 'shy') return 'shy';
  return 'neutral';
}

let _lastSense = {
  emotion: 'neutral',
  reaction: 'neutral',
  confidence: 0,
  facePresent: false,
  faceIdentity: 'none',
  faceIdentityScore: 0,
  isUser: false,
  subjectType: 'unknown',
  /** 小机刚拍到的画面（/uploads/…），给角色聊天模型识图用 */
  imageUrl: '',
  at: 0,
};

/**
 * 摄像头真的回了一帧才会触发。robot-drive-helper 靠它把「调用了摄像头」这条旁白
 * 从「指令入队时」推迟到「图写入 uploads 时」。
 */
const _senseListeners = new Set();

function onSense(fn) {
  if (typeof fn !== 'function') return () => {};
  _senseListeners.add(fn);
  return () => _senseListeners.delete(fn);
}

function recordSense(payload = {}) {
  const emotion = normalizeEmotion(payload.emotion || payload.userEmotion || 'neutral');
  const reaction = normalizeEmotion(payload.reaction || reactionForUserEmotion(emotion));
  const confidence = Math.max(0, Math.min(1, Number(payload.confidence) || 0));
  const facePresent = payload.facePresent === true || payload.facePresent === 1 || payload.facePresent === '1';
  const faceIdentity = String(payload.faceIdentity || payload.identity || 'none').trim().toLowerCase();
  const id = ['match', 'mismatch', 'uncertain', 'none'].includes(faceIdentity) ? faceIdentity : 'none';
  const faceIdentityScore = Math.max(0, Math.min(1, Number(payload.faceIdentityScore) || 0));
  const isUser = payload.isUser === true || payload.isUser === 1 || payload.isUser === '1';
  const subjectType = String(payload.subjectType || '').trim().toLowerCase() || (isUser ? 'user' : facePresent ? 'unknown' : 'none');
  // 后台表情/认人会再写一次 sense：没带新图时保留上一帧，别把角色识图用的截图冲掉
  let imageUrl = _lastSense.imageUrl || '';
  if (Object.prototype.hasOwnProperty.call(payload, 'imageUrl')
    || Object.prototype.hasOwnProperty.call(payload, 'image_url')) {
    imageUrl = String(payload.imageUrl || payload.image_url || '').trim();
  }
  _lastSense = {
    emotion,
    reaction,
    confidence,
    facePresent,
    faceIdentity: id,
    faceIdentityScore,
    isUser,
    subjectType,
    imageUrl,
    at: Date.now(),
  };
  const snapshot = { ..._lastSense };
  for (const fn of _senseListeners) {
    try {
      fn(snapshot);
    } catch (e) {
      console.warn('[robot] sense listener', e.message);
    }
  }
  return snapshot;
}

function getLastSense(maxAgeMs = 30000) {
  if (!_lastSense.at) return null;
  if (Date.now() - _lastSense.at > maxAgeMs) return null;
  return { ..._lastSense };
}

let _lastHeadTouch = {
  gesture: '',
  at: 0,
};

function normalizeHeadGesture(raw) {
  const g = String(raw || 'tap').trim().toLowerCase();
  if (['stroke', 'pat', '摸', '摸头', '抚摸', '顺毛'].includes(g)) return 'stroke';
  if (['shake', 'shake_device', '晃', '摇', '摇晃', '晃动', '晃机', '摇机'].includes(g)) return 'shake';
  if (['tap', 'click', '点', '点头', '轻点', '敲'].includes(g)) return 'tap';
  if (/摇|晃/.test(g)) return 'shake';
  if (/摸|抚|顺/.test(g)) return 'stroke';
  return 'tap';
}

/** 从人设抽互动倾向（不写死某一种「生气→震惊」剧本） */
function personalityTouchBias(char = {}) {
  const blob = `${char.personality || ''} ${char.emotion_style || ''} ${char.behavior || ''} ${char.background || ''}`;
  const has = (re) => re.test(blob);
  return {
    clingy: has(/粘人|黏人|依恋|撒娇|软萌|缺爱|依赖/),
    fierce: has(/易怒|暴躁|火爆|炸毛|傲娇|嘴硬|别扭|要面子|高冷|冷淡/),
    soft: has(/温柔|心软|好哄|怕吵架|体贴|乖|内向安静/),
    playful: has(/调皮|活泼|戏精|逗|乐子|开朗|搞笑/),
    sensitive: has(/玻璃心|敏感|委屈|多虑|内耗/),
    chill: has(/淡漠|理性|冷静|佛系|钝感/),
  };
}

function readMoodFromChar(char) {
  try {
    const { normalizeMood } = require('./emotion-helper');
    let state = char?.emotion_state;
    if (typeof state === 'string') {
      try { state = JSON.parse(state); } catch { state = null; }
    }
    const mood = state?.mood || null;
    return normalizeMood(mood, char);
  } catch {
    return { primary: 'calm', fuel: { anger: 0, hurt: 0, low: 0, desire: 0, intimacy: 8 }, yearning: 0, flashpoint: null, valence: 0, arousal: 30 };
  }
}

/**
 * 摸头/摇晃 → 小机表情+动作：跟当前心情 + 人设倾向走，不写死单一剧本。
 * 碰的是硬件，不改角色情绪数值。
 */
function pickHeadGestureReaction({ gesture, mood, char } = {}) {
  const g = normalizeHeadGesture(gesture);
  const m = mood || readMoodFromChar(char);
  const bias = personalityTouchBias(char);
  const primary = String(m.primary || 'calm');
  const angerish = primary === 'angry' || m.flashpoint?.type === 'anger' || (m.fuel?.anger || 0) >= 45;
  const hurtish = primary === 'hurt' || m.flashpoint?.type === 'hurt' || (m.fuel?.hurt || 0) >= 45;
  const lowish = primary === 'low' || primary === 'lonely' || (m.fuel?.low || 0) >= 50;
  const longingish = primary === 'longing' || m.flashpoint?.type === 'longing'
    || ((Number(m.yearning) || 0) >= 45 && (m.fuel?.intimacy || 0) >= 25);
  const desireish = primary === 'desire' || m.flashpoint?.type === 'desire' || (m.fuel?.desire || 0) >= 55;
  const intimateish = primary === 'intimate' || m.flashpoint?.type === 'intimacy' || (m.fuel?.intimacy || 0) >= 60;
  const tired = primary === 'tired';
  const warm = primary === 'happy' || primary === 'warm' || primary === 'excited' || intimateish;
  const bitter = primary === 'bitter' || primary === 'anxious';

  // 摇晃机身：更像惊吓/不悦，再按人设拧一把
  if (g === 'shake') {
    if (angerish && bias.fierce) return { emotion: 'angry', motion: 'shake', gesture: g };
    if (angerish) return { emotion: 'surprised', motion: 'shake', gesture: g };
    if (hurtish && bias.sensitive) return { emotion: 'sad', motion: 'look_down', gesture: g };
    if (tired) return { emotion: 'surprised', motion: 'look_up', gesture: g };
    if (bias.playful && warm) return { emotion: 'happy', motion: 'tilt', gesture: g };
    if (bias.chill) return { emotion: 'neutral', motion: 'shake', gesture: g };
    return { emotion: 'surprised', motion: 'shake', gesture: g };
  }

  // 顺着摸
  if (g === 'stroke') {
    if (angerish && bias.fierce) return { emotion: 'surprised', motion: 'shake', gesture: g };
    if (angerish && bias.soft) return { emotion: 'shy', motion: 'tilt', gesture: g };
    if (angerish) return { emotion: 'shy', motion: 'look_left', gesture: g };
    if (desireish && bias.clingy) return { emotion: 'love', motion: 'tilt', gesture: g };
    if (desireish) return { emotion: 'shy', motion: 'tilt', gesture: g };
    if (longingish && bias.clingy) return { emotion: 'love', motion: 'tilt', gesture: g };
    if (longingish) return { emotion: 'shy', motion: 'nod', gesture: g };
    if (hurtish && bias.clingy) return { emotion: 'love', motion: 'tilt', gesture: g };
    if (hurtish) return { emotion: 'shy', motion: 'nod', gesture: g };
    if (lowish && bias.clingy) return { emotion: 'love', motion: 'tilt', gesture: g };
    if (lowish) return { emotion: 'sad', motion: 'tilt', gesture: g };
    if (bitter && bias.fierce) return { emotion: 'neutral', motion: 'shake', gesture: g };
    if (warm || bias.clingy) return { emotion: 'love', motion: 'tilt', gesture: g };
    if (bias.playful) return { emotion: 'happy', motion: 'tilt', gesture: g };
    if (tired) return { emotion: 'sleepy', motion: 'nod', gesture: g };
    if (bias.chill) return { emotion: 'neutral', motion: 'nod', gesture: g };
    return { emotion: 'shy', motion: 'nod', gesture: g };
  }

  // 轻点
  if (angerish && bias.fierce) return { emotion: 'angry', motion: 'shake', gesture: g };
  if (angerish) return { emotion: 'surprised', motion: 'look_user', gesture: g };
  if (desireish) return { emotion: 'love', motion: 'tilt', gesture: g };
  if (longingish) return { emotion: 'shy', motion: 'tilt', gesture: g };
  if (hurtish) return { emotion: 'shy', motion: 'tilt', gesture: g };
  if (tired) return { emotion: 'sleepy', motion: 'nod', gesture: g };
  if (warm && bias.playful) return { emotion: 'happy', motion: 'tilt', gesture: g };
  if (warm) return { emotion: 'happy', motion: 'tilt', gesture: g };
  if (bias.clingy) return { emotion: 'love', motion: 'tilt', gesture: g };
  if (bias.fierce && bitter) return { emotion: 'neutral', motion: 'shake', gesture: g };
  // 轻点默认用更明显的歪头+惊讶，ParamFace 上比 happy/nod 好认
  return { emotion: 'surprised', motion: 'tilt', gesture: g };
}

function recordHeadTouch(payload = {}) {
  const gesture = normalizeHeadGesture(payload.gesture || payload.event || 'tap');
  _lastHeadTouch = { gesture, at: Date.now() };
  return { ..._lastHeadTouch };
}

function getLastHeadTouch(maxAgeMs = 120000) {
  if (!_lastHeadTouch.at) return null;
  if (Date.now() - _lastHeadTouch.at > maxAgeMs) return null;
  return { ..._lastHeadTouch };
}

function buildHeadTouchPromptLine(opts = {}) {
  const t = getLastHeadTouch(opts.maxAgeMs ?? 45000);
  if (!t) return '';
  const how = t.gesture === 'stroke'
    ? '顺着小机头顶摸了一下'
    : t.gesture === 'shake'
      ? '轻轻摇晃了一下桌上的小机'
      : '轻轻点了点小机头顶';
  // 摸的是桌上硬件，不是角色本人——无体感、不因此情绪大起大落
  if (opts.forRobot) {
    return `【此刻·机身】用户刚刚${how}。碰的是桌上这台小机硬件，不是在碰你的身体——你没有被摸到/被摇到的体感。最多像远程知道「小机被互动了一下」：可极短带过或让小机自己变个脸，禁止写成自己头皮发麻/被摸得很舒服，也禁止因此大起情绪或反复提。`;
  }
  return `【此刻】用户刚刚在桌上${how}。那是碰硬件小机，不是碰你本人；你没有体感。可以知道这件事，但不要当成自己被摸/被摇，也不要为此情绪波动。`;
}

function parseUserEmotion(body = {}) {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body.userEmotion ?? body.user_emotion ?? body.sensedEmotion ?? body.emotionSense;
  if (raw == null || raw === '') return undefined;
  return normalizeEmotion(raw);
}

function parseFaceIdentity(body = {}) {
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

function parsePresenceHint(body) {
  const p = String(body?.presence || body?.presenceState || '').trim().toLowerCase();
  if (PRESENCE_STATES.includes(p)) return p;
  return '';
}

function parseBoolFlag(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** 桌宠截屏操作会话：start / end（固件或桥在 sc 环开始/结束时上报） */
function parseOperatingIntent(body) {
  if (!body || typeof body !== 'object') return { start: false, end: false };
  if (parseBoolFlag(body.endOperating) || parseBoolFlag(body.stopOperating) || parseBoolFlag(body.operatingEnd)) {
    return { start: false, end: true };
  }
  if (parseBoolFlag(body.operating) || parseBoolFlag(body.computerUse) || parseBoolFlag(body.sc)) {
    return { start: true, end: false };
  }
  return { start: false, end: false };
}

/**
 * 电子屏 / 喇叭 / 通讯同步
 * - 禁言：只关喇叭，不播 TTS；电子屏仍显示回复台词
 * - 桌宠屏台词：是否把 reply 打到机身电子屏（与禁言独立）
 * - 同步到聊天：操作短句是否出现在通讯气泡
 */
/**
 * 灯光策略：总开关 + 上限亮度。
 * 情绪给的亮度只是「相对多亮」，实际亮度由这里的上限收着 —— 夜里桌上一颗全亮的灯很刺眼。
 */
function resolveLedPolicy(settings = {}) {
  const enabled = String(settings.robot_led_enabled ?? '1') !== '0';
  let max = Number(settings.robot_led_max_brightness);
  if (!Number.isFinite(max) || max <= 0) max = 1;
  max = Math.max(0.05, Math.min(1, max));
  return { enabled, maxBrightness: max };
}

function resolveScreenPolicy(settings = {}) {
  const muted = String(settings.robot_mute || '0') === '1';
  const screenChat = String(settings.robot_screen_chat || '1') !== '0';
  const syncChat = String(settings.robot_sync_chat || '1') !== '0';
  const ttsOn = String(settings.robot_tts || '1') !== '0';
  /** 机身喇叭音量 0–100。禁言就是把它压到 0，两个开关走的是同一条 MCP 调用 */
  const volume = clampInt(settings.robot_volume, 0, 100, 70);
  return {
    muted,
    showChatOnScreen: screenChat,
    syncChat,
    playTts: !muted && ttsOn,
    volume,
    /** 插件每轮直接照着这个值设机身音量 */
    effectiveVolume: muted ? 0 : volume,
  };
}

function parseSubjectIdentity(body = {}) {
  if (!body || typeof body !== 'object') return {};
  const isUserRaw = body.isUser ?? body.is_user;
  const subjectType = String(body.subjectType || body.subject_type || '').trim().toLowerCase();
  let isUser;
  if (isUserRaw === true || isUserRaw === 1 || isUserRaw === '1' || isUserRaw === 'true') isUser = true;
  else if (isUserRaw === false || isUserRaw === 0 || isUserRaw === '0' || isUserRaw === 'false') isUser = false;
  const out = {};
  if (isUser !== undefined) out.isUser = isUser;
  if (subjectType) out.subjectType = subjectType;
  const conf = body.subjectConfidence ?? body.subject_confidence;
  if (conf != null && Number.isFinite(Number(conf))) out.confidence = Number(conf);
  return out;
}

module.exports = {
  buildRobotExtraPrompt,
  buildRobotMotionTagLines,
  buildRobotMotionTagPromptBlock,
  buildRobotBodyCuePrompt,
  enrichRobotDirectives,
  situationalRobotHint,
  inferMotionFromSpeak,
  inferEmotionFromSpeak,
  inferHeadGestureFromText,
  buildBehaviorProfile,
  parseRobotDirectives,
  parseRobotInvoke,
  userAskedRobotToLook,
  resolveRobotIntentFromUserAsk,
  inferRobotLookFallback,
  isRobotCameraVisionIntent,
  preferFindIfUserAsked,
  stripRobotTags,
  parseLedDirective,
  parseServoDirective,
  normalizeServoAngles,
  toDeviceAngles,
  fromDeviceAngles,
  headMoveSettleMs,
  isHeadGesture,
  headGestureSteps,
  resolvePitchCenter,
  LOGICAL_PITCH_CENTER,
  parseMotionValue,
  servoPayloadFromMotion,
  motionSuggestsGlance,
  normalizeEmotion,
  normalizeMotion,
  parseFacePresent,
  parseSubjectIdentity,
  parseUserEmotion,
  parseFaceIdentity,
  parsePresenceHint,
  parseBoolFlag,
  parseOperatingIntent,
  resolveScreenPolicy,
  resolveLedPolicy,
  listEmotionOptions,
  listMotionOptions,
  parseRobotEmotions,
  buildFacePayload,
  generateSnapshotNote,
  generateSnapshotCaption,
  emotionLabelZh,
  moodToRobotEmotion,
  moodToLedSpec,
  syncFaceFromCharacterMood,
  reactionForUserEmotion,
  recordSense,
  onSense,
  getLastSense,
  recordHeadTouch,
  getLastHeadTouch,
  buildHeadTouchPromptLine,
  normalizeHeadGesture,
  pickHeadGestureReaction,
  personalityTouchBias,
  readMoodFromChar,
  EMOTION_ALIASES,
  MOTION_ALIASES,
  PRESENCE_STATES,
};

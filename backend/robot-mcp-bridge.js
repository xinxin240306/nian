/**
 * 念 → stackchan-mcp HTTP 工具桥
 *
 * 角色下行（glance / speak / servo…）直连网关 /tools/*。
 * 人脸追踪：拍照（VISION_URL→念识脸）后必须再 move_head，否则头不会转。
 */

const robotCommands = require('./robot-commands-helper');
const robotFaceTrack = require('./robot-face-track-helper');
const robotScreen = require('./robot-screen-helper');
const robotHelper = require('./robot-helper');

let _timer = null;
let _deps = null;
let _kickTimer = null;
let _tickAgain = false;
let _running = false;
let _lastStatusLog = 0;
let _lastFaceTrackAt = 0;
let _lastCmdLog = 0;
let _lastScreenSig = '';
/** 上一次真正送到机身的灯色（'r,g,b' 或 'off'）：同色不重复打网关 */
let _lastLedKey = '';
/** 上一次下发的机身角，用来按转幅算拍照前该等多久 */
let _lastHead = null;
let _gestureBusy = false;
let _lastGestureAt = 0;
let _lastGestureKind = '';

const DEVICE_TYPES = ['speak', 'glance', 'snapshot', 'servo', 'led', 'load_face', 'reset_face', 'follow', 'listen'];
const FACE_TRACK_INTERVAL_MS = 5000;

function mcpEnabled(settings) {
  return String(settings?.robot_control_mode || '').trim().toLowerCase() === 'mcp';
}

function mcpBaseUrl(settings) {
  const raw = String(settings?.robot_mcp_base_url || '').trim()
    || process.env.ROBOT_MCP_BASE_URL
    || 'http://127.0.0.1:8766';
  return raw.replace(/\/$/, '');
}

function mcpToken(settings) {
  return String(settings?.robot_mcp_token || settings?.robot_token || '').trim()
    || String(process.env.STACKCHAN_TOKEN || '').trim();
}

async function mcpFetch(settings, path, { method = 'GET', body } = {}) {
  const base = mcpBaseUrl(settings);
  const token = mcpToken(settings);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), method === 'POST' && String(path).includes('listen') ? 90000 : 60000);
  try {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      const err = new Error(data.error || data.message || `MCP HTTP ${resp.status}`);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function callTool(settings, name, arguments_ = {}) {
  return mcpFetch(settings, '/tools/call', {
    method: 'POST',
    body: { name, arguments: arguments_ },
  });
}

async function playAudio(settings, { url, text }) {
  return mcpFetch(settings, '/tools/play_audio', {
    method: 'POST',
    body: { url, text: text || '' },
  });
}

async function listenAudio(settings, opts = {}) {
  return mcpFetch(settings, '/tools/listen', {
    method: 'POST',
    body: {
      silence_ms: Number(opts.silence_ms) || 3000,
      max_duration_ms: Number(opts.max_duration_ms) || 30000,
      source: opts.source || 'nian',
    },
  });
}

async function refreshOnlineFromGateway(deps) {
  const { getSettings, robotDriveHelper } = deps;
  const settings = getSettings();
  if (!mcpEnabled(settings)) return null;
  if (String(settings.robot_enabled || '0') !== '1') return null;
  try {
    const st = await mcpFetch(settings, '/tools/status');
    const connected = !!(st.connected || st.device_connected);
    if (connected) {
      robotDriveHelper.recordDeviceHeartbeat();
    }
    return st;
  } catch (e) {
    if (Date.now() - _lastStatusLog > 60000) {
      _lastStatusLog = Date.now();
      console.warn('[robot-mcp] status', e.message);
    }
    return null;
  }
}

function absoluteAudioUrl(url, publicBase) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    // 网关在 Docker 里：127.0.0.1 指向容器自己，必须换成公网/宿主机可访问地址
    try {
      const u = new URL(s);
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
        const base = String(publicBase || '').replace(/\/$/, '');
        if (base) return `${base}${u.pathname}${u.search || ''}`;
      }
    } catch {}
    return s;
  }
  const base = String(publicBase || '').replace(/\/$/, '');
  if (!base) return s;
  return s.startsWith('/') ? `${base}${s}` : `${base}/${s}`;
}

function parseHexLed(hex) {
  const h = String(hex || '').replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function clampYawPitch(yaw, pitch) {
  let y = Number(yaw);
  let p = Number(pitch);
  if (!Number.isFinite(y)) y = 0;
  if (!Number.isFinite(p)) p = 28;
  y = Math.max(-90, Math.min(90, Math.round(y)));
  p = Math.max(5, Math.min(85, Math.round(p)));
  return { yaw: y, pitch: p };
}

/** 优先数字 yaw/pitch；否则动作名映射。无有效指令返回 null（不要瞎转） */
function motionToAngles(motionOrServo) {
  if (typeof robotHelper.normalizeServoAngles === 'function') {
    const n = robotHelper.normalizeServoAngles(motionOrServo);
    if (n) return { yaw: n.yaw, pitch: n.pitch };
    return null;
  }
  const s = motionOrServo && typeof motionOrServo === 'object' ? motionOrServo : {};
  const params = s.params && typeof s.params === 'object' ? s.params : {};
  const yawRaw = params.yaw ?? s.yaw;
  const pitchRaw = params.pitch ?? s.pitch;
  if (yawRaw != null || pitchRaw != null) {
    return clampYawPitch(yawRaw ?? 0, pitchRaw == null ? 28 : pitchRaw);
  }
  const action = String(s.action || s.motion || s.raw || s.motionRaw || motionOrServo || '')
    .trim()
    .toLowerCase();
  if (!action || action === 'idle' || action === 'none') return null;
  if (/look_left|左转|向左/.test(action)) return { yaw: -28, pitch: 20 };
  if (/look_right|右转|向右/.test(action)) return { yaw: 28, pitch: 20 };
  if (/look_up|抬头/.test(action)) return { yaw: 0, pitch: 8 };
  if (/look_down|低头/.test(action)) return { yaw: 0, pitch: 42 };
  if (/look_user|正视|面向你/.test(action)) return { yaw: 0, pitch: 28 };
  if (/nod|点头/.test(action)) return { yaw: 0, pitch: 42 };
  if (/shake|摇/.test(action)) return { yaw: -22, pitch: 20 };
  if (/tilt|歪|蹭|贴/.test(action)) return { yaw: 18, pitch: 28 };
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function playHeadGesture(settings, kind) {
  if (_gestureBusy) return true;
  if (kind === _lastGestureKind && Date.now() - _lastGestureAt < 1200) return true;
  const steps = robotHelper.headGestureSteps(kind, _lastHead, settings);
  if (!steps.length) return false;
  _gestureBusy = true;
  _lastGestureKind = kind;
  _lastGestureAt = Date.now();
  try {
    for (const step of steps) {
      await callTool(settings, 'move_head', { yaw: step.yaw, pitch: step.pitch });
      _lastHead = { yaw: step.yaw, pitch: step.pitch };
      await sleep(step.waitMs);
    }
    const logical = robotHelper.fromDeviceAngles(_lastHead.yaw, _lastHead.pitch, settings);
    try { robotFaceTrack.noteExplicitServo(logical.yaw, logical.pitch); } catch {}
    console.log(`[robot-mcp] gesture ${kind} steps=${steps.length}`);
    return true;
  } finally {
    _gestureBusy = false;
  }
}

async function moveHeadResolved(settings, motionOrServo) {
  const kind = robotHelper.isHeadGesture(motionOrServo);
  if (kind) return playHeadGesture(settings, kind);
  const mapped = robotHelper.toDeviceAngles(motionOrServo, settings);
  if (!mapped) return false;
  await callTool(settings, 'move_head', { yaw: mapped.yaw, pitch: mapped.pitch });
  _lastHead = { yaw: mapped.yaw, pitch: mapped.pitch };
  const logical = mapped.device
    ? robotHelper.fromDeviceAngles(mapped.yaw, mapped.pitch, settings)
    : { yaw: mapped.logicalYaw, pitch: mapped.logicalPitch };
  try { robotFaceTrack.noteExplicitServo(logical.yaw, logical.pitch); } catch {}
  console.log(`[robot-mcp] move_head yaw=${mapped.yaw} pitch=${mapped.pitch}`
    + (mapped.device ? ' (raw)' : ` (logical ${logical.yaw},${logical.pitch})`));
  return true;
}

/** 识脸结果已在 vision 里写进 face-track state → 有脸才转头 */
async function applyFaceTrackMove(settings) {
  const target = robotFaceTrack.getTarget();
  if (!target?.facePresent) {
    console.log('[robot-mcp] face-track: 本帧没脸，保持不动');
    return false;
  }
  return moveHeadResolved(settings, { yaw: target.yaw, pitch: target.pitch });
}

async function runFaceTrackShot(settings, { force = false, question } = {}) {
  const q = question
    || (force
      ? robotFaceTrack.FACE_TRACK_FORCE_QUESTION
      : robotFaceTrack.FACE_TRACK_QUESTION);
  robotFaceTrack.setEnabled(true);
  await callTool(settings, 'take_photo', { question: q });
  await sleep(200);
  return applyFaceTrackMove(settings);
}

/**
 * 角色调摄像头找人：看一圈 → BlazeFace 检脸（坐着不动也能找到）→ 对准 → 认是不是你 → 锁定。
 * 不是帧差运动追踪；每点停稳再拍照。
 */
async function runFaceSearch(settings, opts = {}) {
  const faceprintHelper = require('./faceprint-helper');
  const wantId = String(settings.robot_faceprint_enabled || '0') === '1'
    && !!faceprintHelper.publicFaceprintStatus(
      faceprintHelper.loadStoredFaceprint(() => settings),
    ).enrolled;
  const maxPoses = Math.max(3, Math.min(9, Number(opts.maxPoses) || 9));
  const maxVerify = Math.max(1, Math.min(4, Number(opts.maxVerify) || 3));
  const poses = [
    { skipMove: true },
    ...robotFaceTrack.getSearchPoses().slice(0, maxPoses),
  ];

  let firstFace = null;
  let verified = 0;

  console.log(`[robot-mcp] face-search start wantId=${wantId} poses=${poses.length}`);

  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i];
    if (!pose.skipMove) {
      try {
        const from = _lastHead ? { ..._lastHead } : null;
        await moveHeadResolved(settings, { yaw: pose.yaw, pitch: pose.pitch });
        const mapped = robotHelper.toDeviceAngles(
          { yaw: pose.yaw, pitch: pose.pitch },
          settings,
        );
        const settle = robotHelper.headMoveSettleMs(from, mapped, opts.settleMs);
        await sleep(Math.max(280, settle || 400));
      } catch (e) {
        console.warn('[robot-mcp] face-search move', e.message);
        continue;
      }
    }

    try {
      await runFaceTrackShot(settings, {
        force: true,
        question: robotFaceTrack.FACE_SEARCH_QUESTION,
      });
    } catch (e) {
      console.warn('[robot-mcp] face-search detect', e.message);
      continue;
    }

    let target = robotFaceTrack.getTarget();
    if (!target?.facePresent) continue;

    // 再精修一帧，把脸尽量摆到画面中心
    try {
      await sleep(280);
      await runFaceTrackShot(settings, {
        force: true,
        question: robotFaceTrack.FACE_SEARCH_QUESTION,
      });
      target = robotFaceTrack.getTarget();
    } catch {}

    if (!target?.facePresent) continue;

    if (!firstFace) {
      firstFace = {
        yaw: target.yaw,
        pitch: target.pitch,
        identity: 'none',
      };
    }

    if (!wantId) {
      console.log(`[robot-mcp] face-search locked (no faceprint) yaw=${target.yaw} pitch=${target.pitch}`);
      return {
        ok: true,
        found: true,
        identity: 'none',
        yaw: target.yaw,
        pitch: target.pitch,
      };
    }

    if (verified >= maxVerify) break;
    verified += 1;

    try {
      await callTool(settings, 'take_photo', {
        question: robotFaceTrack.FACE_VERIFY_QUESTION,
      });
      await sleep(120);
    } catch (e) {
      console.warn('[robot-mcp] face-search verify shot', e.message);
      continue;
    }

    const sense = robotHelper.getLastSense(20000);
    const identity = sense?.faceIdentity || 'uncertain';
    console.log(`[robot-mcp] face-search verify#${verified} → ${identity}`);

    if (identity === 'match') {
      const locked = robotFaceTrack.getTarget();
      return {
        ok: true,
        found: true,
        identity: 'match',
        yaw: locked.yaw,
        pitch: locked.pitch,
      };
    }

    firstFace.identity = identity;
    firstFace.yaw = target.yaw;
    firstFace.pitch = target.pitch;
    // mismatch / uncertain：继续扫下一个方位
  }

  if (firstFace) {
    try {
      await moveHeadResolved(settings, {
        yaw: firstFace.yaw,
        pitch: firstFace.pitch,
      });
    } catch {}
    console.log(`[robot-mcp] face-search done face=${firstFace.identity} (no match)`);
    return {
      ok: true,
      found: true,
      identity: firstFace.identity || 'uncertain',
      yaw: firstFace.yaw,
      pitch: firstFace.pitch,
    };
  }

  console.log('[robot-mcp] face-search done: no face');
  return { ok: true, found: false, identity: 'none' };
}

async function maybePeriodicFaceTrack(settings) {
  // 只有角色明确写了 [桌宠:跟着] 才持续找脸；默认空闲不跟人
  if (!robotFaceTrack.isFollowMode()) return;
  if (String(settings.robot_face_track_enabled || '1') === '0') return;
  const now = Date.now();
  if (now - _lastFaceTrackAt < FACE_TRACK_INTERVAL_MS) return;
  _lastFaceTrackAt = now;
  try {
    await runFaceTrackShot(settings, { force: false });
  } catch (e) {
    console.warn('[robot-mcp] follow face-track', e.message);
  }
}

/** 念表情 → 机身 set_avatar 脸名 */
function emotionToAvatarFace(emotion) {
  const e = String(emotion || 'neutral').toLowerCase().trim();
  const map = {
    neutral: 'idle', idle: 'idle', calm: 'idle', sleepy: 'idle',
    happy: 'happy', love: 'happy', shy: 'embarrassed', embarrassed: 'embarrassed',
    sad: 'sad', surprised: 'surprised', thinking: 'thinking', angry: 'surprised',
  };
  return map[e] || 'idle';
}

function ledToRgb(led) {
  if (!led || typeof led !== 'object' || led.off) return null;
  if (Number.isFinite(led.r) && Number.isFinite(led.g) && Number.isFinite(led.b)) {
    return {
      r: Math.max(0, Math.min(255, Math.round(led.r))),
      g: Math.max(0, Math.min(255, Math.round(led.g))),
      b: Math.max(0, Math.min(255, Math.round(led.b))),
    };
  }
  return parseHexLed(led.hex || led.color);
}

function scaledLedRgb(rgb, level) {
  const n = Math.max(0, Math.min(1, Number(level) || 0));
  return {
    r: Math.round(rgb.r * n),
    g: Math.round(rgb.g * n),
    b: Math.round(rgb.b * n),
  };
}

/**
 * 灯只打一次静态 RGB。
 * 网关只能设静态色，呼吸/闪烁得由念每 180ms 推一帧合成 —— 那是每秒五六次 HTTP，
 * 而且心情不变就永不停止，会跟摄像头和舵机抢同一个网关连接。心情只决定颜色。
 */
async function applyLedSpec(settings, led) {
  const policy = robotHelper.resolveLedPolicy(settings);
  if (!policy.enabled) {
    if (_lastLedKey !== 'off') {
      _lastLedKey = 'off';
      await callTool(settings, 'clear_leds', {});
      console.log('[robot-mcp] clear_leds（灯光已关）');
    }
    return;
  }
  const rgb = ledToRgb(led);
  if (!rgb) {
    if (led?.off && _lastLedKey !== 'off') {
      _lastLedKey = 'off';
      await callTool(settings, 'clear_leds', {});
    }
    return;
  }
  const wanted = Math.max(0.05, Math.min(1, Number(led.brightness) || 1));
  const level = Math.min(wanted, policy.maxBrightness);
  const out = scaledLedRgb(rgb, level);
  const key = `${out.r},${out.g},${out.b}`;
  if (key === _lastLedKey) return;
  _lastLedKey = key;
  await callTool(settings, 'set_all_leds', out);
}

function screenHardwareSig(screen) {
  if (!screen) return '';
  const servo = screen.servo && typeof screen.servo === 'object' ? screen.servo : {};
  const led = screen.led && typeof screen.led === 'object' ? screen.led : {};
  return [
    screen.emotion || '',
    screen.motion || '',
    servo.action || servo.motion || '',
    servo.yaw ?? '',
    servo.pitch ?? '',
    led.hex || led.color || '',
    led.r ?? '', led.g ?? '', led.b ?? '',
    led.effect || '', led.frequencyHz ?? '', led.brightness ?? '',
    led.off ? '0' : '1',
    screen.touchSeq || '',
    screen.hwSeq ?? '',
  ].join('|');
}

/**
 * 跟屏幕缓存同步表情 / 灯光 / 舵机（角色 [表情][灯光][舵机] 会写进 display→screen）
 * 不强迫「一说话就转头」——有指令才动。
 */
async function syncScreenHardware(settings, characterId) {
  const screen = robotScreen.getScreen(characterId);
  const sig = screenHardwareSig(screen);
  if (!sig || sig === _lastScreenSig) return;
  _lastScreenSig = sig;

  // 表情
  try {
    const face = emotionToAvatarFace(screen.emotion);
    await callTool(settings, 'set_avatar', { face });
    console.log(`[robot-mcp] set_avatar ${face} (emotion=${screen.emotion || ''})`);
  } catch (e) {
    console.warn('[robot-mcp] set_avatar', e.message);
  }

  // 灯光
  try {
    await applyLedSpec(settings, screen.led);
  } catch (e) {
    console.warn('[robot-mcp] led', e.message);
  }

  // 舵机：screen.servo 有指令才转（含数字角、复位）。光 motion=idle 不要每轮回中位。
  try {
    const servo = screen.servo && typeof screen.servo === 'object' ? screen.servo : null;
    if (servo) {
      if (!motionToAngles(servo)) return;
      await moveHeadResolved(settings, servo);
      // 转过就消费掉，别让之后的表情变化把这个角度再转一遍
      try { robotScreen.clearScreenServo(characterId); } catch {}
      return;
    }
    const motion = String(screen.motion || '').toLowerCase();
    if (!motion || motion === 'idle') return;
    await moveHeadResolved(settings, { motion });
  } catch (e) {
    console.warn('[robot-mcp] screen servo', e.message);
  }
}

async function applyEmotionIfAny(settings, emotion) {
  if (!emotion) return;
  try {
    const face = emotionToAvatarFace(emotion);
    await callTool(settings, 'set_avatar', { face });
  } catch (e) {
    console.warn('[robot-mcp] emotion', e.message);
  }
}

async function handleCommand(cmd, settings, publicBase) {
  const type = String(cmd?.type || '').trim();
  const p = cmd?.payload && typeof cmd.payload === 'object' ? cmd.payload : {};

  if (type === 'follow') {
    const on = !(p.on === false || p.on === 0 || p.on === '0' || p.off);
    const st = robotFaceTrack.setFollowMode(on, p.durationMs);
    console.log(`[robot-mcp] follow ${on ? 'on' : 'off'} remain=${st.remainMs || 0}ms`);
    if (on && String(settings.robot_face_track_enabled || '1') !== '0') {
      try { await runFaceTrackShot(settings, { force: true }); } catch (e) {
        console.warn('[robot-mcp] follow first shot', e.message);
      }
    }
    return true;
  }

  if (type === 'glance' || type === 'snapshot') {
    // faceSearch / intent=find：看一圈找人并对准（BlazeFace），可选认是不是你
    const wantSearch = !!(p.faceSearch || p.intent === 'find' || p.searchFaces);
    if (wantSearch) {
      try {
        await runFaceSearch(settings, {
          maxPoses: p.maxPoses,
          maxVerify: p.maxVerify,
          settleMs: p.settleMs,
        });
      } catch (e) {
        console.warn('[robot-mcp] face-search', e.message);
      }
      // 找人后若还要给角色识图，再拍一张普通照
      if (p.withPhoto !== false && !p.faceTrackOnly) {
        try {
          await callTool(settings, 'take_photo', {
            question: String(p.context || p.question || '').trim() || '找人后看',
          });
        } catch (e) {
          console.warn('[robot-mcp] face-search photo', e.message);
        }
      }
      return true;
    }

    // faceTrackOnly 只留给「测试追踪」和 [桌宠:跟着]：那两个要的是对准，不要图。
    // 平时的「看我一眼」不再先跑多帧追踪 —— 那是好几秒，用户等不了。
    const faceTrackOnly = !!(p.faceTrackOnly || p.forceFaceTrack || p.test === 'face_track');
    const question = String(p.context || p.question || '').trim()
      || (faceTrackOnly
        ? robotFaceTrack.FACE_TRACK_FORCE_QUESTION
        : (type === 'snapshot' ? '悄悄看一眼' : '看一眼'));

    if (faceTrackOnly || robotFaceTrack.isFaceTrackQuestion(question)) {
      const bursts = Math.max(1, Math.min(5, Number(p.findBurst) || 1));
      for (let i = 0; i < bursts; i++) {
        await runFaceTrackShot(settings, {
          force: faceTrackOnly || robotFaceTrack.isFaceTrackForceQuestion(question),
        });
        if (i + 1 < bursts) await sleep(350);
      }
      return true;
    }

    // 转头 + 拍照是一个原子动作：先摆到位、等舵机停稳，再按快门。
    // 分成两条指令排队的话顺序没保证，可能拍完才转过去。
    const mapped = p.servo && typeof p.servo === 'object'
      ? robotHelper.toDeviceAngles(p.servo, settings)
      : null;
    if (mapped) {
      try {
        await callTool(settings, 'move_head', { yaw: mapped.yaw, pitch: mapped.pitch });
        const logical = mapped.device
          ? robotHelper.fromDeviceAngles(mapped.yaw, mapped.pitch, settings)
          : { yaw: mapped.logicalYaw, pitch: mapped.logicalPitch };
        try { robotFaceTrack.noteExplicitServo(logical.yaw, logical.pitch); } catch {}
        const settle = robotHelper.headMoveSettleMs(_lastHead, mapped, p.settleMs);
        _lastHead = { yaw: mapped.yaw, pitch: mapped.pitch };
        console.log(`[robot-mcp] look move_head yaw=${mapped.yaw} pitch=${mapped.pitch} settle=${settle}ms`);
        await sleep(settle);
      } catch (e) {
        console.warn('[robot-mcp] look move_head', e.message);
      }
    }
    await callTool(settings, 'take_photo', { question });
    return true;
  }

  if (type === 'speak') {
    if (p.muted) return true;
    await applyEmotionIfAny(settings, p.emotion);
    const text = String(p.text || '').trim();
    const audioUrl = absoluteAudioUrl(p.audioUrl || p.audio_url || p.audioPath, publicBase);
    if (audioUrl) {
      console.log(`[robot-mcp] play_audio ${audioUrl.slice(0, 80)}`);
      await playAudio(settings, { url: audioUrl, text });
      return true;
    }
    if (text) {
      console.log(`[robot-mcp] say text=${text.slice(0, 40)}`);
      await callTool(settings, 'say', { text });
      return true;
    }
    return true;
  }

  if (type === 'listen') {
    console.log('[robot-mcp] listen silence_ms=', p.silence_ms || 3000);
    await listenAudio(settings, p);
    return true;
  }

  if (type === 'servo') {
    await moveHeadResolved(settings, p);
    return true;
  }

  if (type === 'led') {
    await applyLedSpec(settings, p);
    return true;
  }

  if (type === 'load_face' || type === 'reset_face') {
    await applyEmotionIfAny(settings, p.emotion || p.face || 'neutral');
    return true;
  }

  return false;
}

function resolvePublicBase(settings, fallback) {
  const fromSet = String(settings.public_base_url || settings.robot_public_base_url || '').trim();
  if (fromSet) return fromSet.replace(/\/$/, '');
  const fb = String(fallback || '').trim();
  if (fb) return fb.replace(/\/$/, '');
  const port = Number(process.env.PORT) || 3000;
  return `http://127.0.0.1:${port}`;
}

async function tick(deps) {
  if (_running) return;
  _running = true;
  try {
    const { getSettings, db } = deps;
    const settings = getSettings();
    if (!mcpEnabled(settings)) return;
    if (String(settings.robot_enabled || '0') !== '1') return;

    const characterId = parseInt(settings.robot_character_id, 10);
    if (!characterId) return;
    if (!db.prepare('SELECT id FROM characters WHERE id=?').get(characterId)) return;

    const st = await refreshOnlineFromGateway(deps);
    const online = !!(st && (st.connected || st.device_connected));

    const publicBase = resolvePublicBase(settings, deps.publicBaseFallback);
    const cmds = robotCommands.getPendingCommands(characterId, 20, { types: DEVICE_TYPES });

    if (cmds.length) {
      if (Date.now() - _lastCmdLog > 8000) {
        _lastCmdLog = Date.now();
        console.log(`[robot-mcp] 执行 ${cmds.length} 条: ${cmds.map((c) => c.type).join(',')}`);
      }
      const ackIds = [];
      for (const cmd of cmds) {
        try {
          await handleCommand(cmd, settings, publicBase);
          if (cmd.id) ackIds.push(cmd.id);
        } catch (e) {
          console.warn(`[robot-mcp] cmd#${cmd.id} ${cmd.type}:`, e.message);
          if (cmd.type === 'listen') {
            try {
              const robotMic = require('./robot-mic-helper');
              const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
              if (char) robotMic.finishRobotMicListening(char, { reason: 'listen_failed' });
            } catch {}
          }
          if (cmd.id) ackIds.push(cmd.id);
        }
      }
      if (ackIds.length) robotCommands.ackCommands(ackIds, { types: DEVICE_TYPES });
      _lastFaceTrackAt = Date.now();
    }

    // 表情/灯光/舵机：跟屏幕缓存同步（角色标记会先进 display→screen）
    if (online) {
      try {
        await syncScreenHardware(settings, characterId);
      } catch (e) {
        console.warn('[robot-mcp] sync screen', e.message);
      }
    }

    if (!cmds.length && online) {
      await maybePeriodicFaceTrack(settings);
    }
  } catch (e) {
    console.warn('[robot-mcp] tick', e.message);
  } finally {
    _running = false;
    if (_tickAgain) {
      _tickAgain = false;
      setTimeout(() => tick(_deps).catch(() => {}), 30);
    }
  }
}

/**
 * 指令入队就立刻下行，不等下一次轮询。
 * 「看我一眼」按轮询走最坏要等满一个周期，用户只会觉得机器没反应。
 */
function kickRobotMcpBridge() {
  if (!_timer || !_deps) return;
  if (_running) {
    _tickAgain = true;
    return;
  }
  if (_kickTimer) return;
  _kickTimer = setTimeout(() => {
    _kickTimer = null;
    tick(_deps).catch(() => {});
  }, 60);
  if (_kickTimer.unref) _kickTimer.unref();
}

function startRobotMcpBridge(deps, opts = {}) {
  stopRobotMcpBridge();
  const intervalMs = Math.max(2000, Number(opts.intervalMs) || 4000);
  console.log(`[robot-mcp] 已启动，每 ${intervalMs}ms 拉取指令 → stackchan-mcp /tools（入队会立刻插队下行）`);
  _deps = deps;
  _timer = setInterval(() => {
    tick(deps).catch((e) => console.warn('[robot-mcp]', e.message));
  }, intervalMs);
  tick(deps).catch(() => {});
}

function stopRobotMcpBridge() {
  _lastLedKey = '';
  _lastHead = null;
  _gestureBusy = false;
  _lastGestureKind = '';
  _lastGestureAt = 0;
  _deps = null;
  _tickAgain = false;
  if (_kickTimer) {
    clearTimeout(_kickTimer);
    _kickTimer = null;
  }
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = {
  mcpEnabled,
  mcpBaseUrl,
  startRobotMcpBridge,
  stopRobotMcpBridge,
  kickRobotMcpBridge,
  refreshOnlineFromGateway,
  callTool,
  playAudio,
  listenAudio,
  mcpFetch,
  applyFaceTrackMove,
  runFaceTrackShot,
  runFaceSearch,
};

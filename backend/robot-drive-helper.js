/**
 * 角色内在驱动 → 桌宠代偿通道（想念/无聊/独处 → 借小机靠近用户）
 * 不展示数值；冲动与人设门控决定是否通过小机互动。
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { push } = require('./push');
const { callChatAPIComplete, buildHistoryApiMessages, toAbsoluteMediaUrl } = require('./api-helper');
const robotHelper = require('./robot-helper');
const robotCommands = require('./robot-commands-helper');
const robotOperatingHelper = require('./robot-operating-helper');
const { buildSystemPrompt, getSchedulePromptBlocks } = require('./cron');

const _willInvokeAt = new Map();
const WILL_INVOKE_GAP_MS = 30 * 1000;
const WILL_INVOKE_GAP_LIGHT_MS = 12 * 1000;
/** 语气补的灯/头：同样动作 12 秒内不连打，避免句句点头 */
const _lastBodyPlay = new Map();
const BODY_PLAY_GAP_MS = 12 * 1000;

/**
 * 角色写了 [桌宠:…] 之后，这一次到底送没送出去。
 * 以前失败是静默的，角色下一轮照样演「我刚通过小机看了你」——回灌真相是唯一的解。
 */
const _lastWillOutcome = new Map();
const WILL_OUTCOME_TTL_MS = 12 * 60 * 1000;

const WILL_INTENT_ZH = {
  peek: '看一眼',
  silent: '只看不说',
  comfort: '靠近说句话',
  tease: '逗一下',
  chat: '说句话',
  peek_remember: '看一眼并记下',
  find: '找人',
  follow: '一直跟着',
  unfollow: '停下跟着',
};

const WILL_FAIL_ZH = {
  not_bound: '这台小机没绑给你，标记不生效',
  device_offline: '小机当时不在线（约 3 分钟内没心跳），指令没有送达通道，已经丢掉了',
  cooldown: '离上一次成功调用太近（轻量动作 12 秒、其它 30 秒内只能一次），被系统挡下了',
  error: '执行时出错，没发出去',
};

function recordWillOutcome(charId, outcome) {
  const id = parseInt(charId, 10);
  if (!id) return;
  _lastWillOutcome.set(id, { ...outcome, at: Date.now() });
}

function readWillOutcome(charId) {
  const id = parseInt(charId, 10);
  if (!id) return null;
  const o = _lastWillOutcome.get(id);
  if (!o) return null;
  if (Date.now() - o.at > WILL_OUTCOME_TTL_MS) {
    _lastWillOutcome.delete(id);
    return null;
  }
  return { ...o, agoSec: Math.max(0, Math.round((Date.now() - o.at) / 1000)) };
}

function describeWillOutcome(charId) {
  const o = readWillOutcome(charId);
  if (!o) return '';
  const what = WILL_INTENT_ZH[o.intent] || o.intent || '用小机';
  const when = o.agoSec < 60 ? `${o.agoSec} 秒前` : `${Math.round(o.agoSec / 60)} 分钟前`;
  if (o.ok) {
    return `· 上一次你调它：${when}你要「${what}」，指令已经排进队列。`;
  }
  const why = WILL_FAIL_ZH[o.reason] || '没能送出去';
  return `· 上一次你调它没成：${when}要「${what}」，${why}。`;
}

function canCharacterUseRobot(char, settings) {
  if (String(settings?.robot_enabled || '0') !== '1') return false;
  const bound = parseInt(settings.robot_character_id, 10);
  return bound > 0 && Number(char?.id) === bound;
}

/** 摄像头真的回过画面才算「看见」。sense 是 /mcp/vision/explain 收到图时写的。 */
function readCameraFrame(maxAgeMs = 120000) {
  try {
    const sense = require('./robot-helper').getLastSense(maxAgeMs);
    if (!sense?.at) return null;
    return { ...sense, agoSec: Math.max(0, Math.round((Date.now() - sense.at) / 1000)) };
  } catch {
    return null;
  }
}

function describeCameraFrame(frame) {
  if (!frame) {
    return '· 它的摄像头：最近还没有画面回来。';
  }
  const bits = [];
  if (frame.facePresent) bits.push('画面里有人');
  else bits.push('画面里没看清人脸');
  if (frame.faceIdentity === 'match' || frame.isUser === true) bits.push('认出是用户本人');
  else if (frame.faceIdentity === 'mismatch') bits.push('看着不像用户本人');
  if (frame.emotion && frame.emotion !== 'neutral') {
    bits.push(`表情偏「${require('./robot-helper').emotionLabelZh(frame.emotion)}」`);
  }
  return `· 它的摄像头：${frame.agoSec} 秒前回过一帧（${bits.join('、')}）。`;
}

/**
 * 小机状态：在线才把 schema 挂进当轮；离线只报没开机。
 * 角色用自己的手机远程操作对方桌上那台。开机才挂 schema。
 */
function buildRobotInvokePromptSection(char, settings, opts = {}) {
  if (String(settings?.robot_enabled || '0') !== '1') return '';
  try {
    const cleared = robotOperatingHelper.clearOperatingIfDeviceOffline() || [];
    if (cleared.includes(Number(char?.id))) char.robot_operating = 0;
  } catch {}
  if (!canCharacterUseRobot(char, settings)) {
    return '【对方桌上的小机】这会儿没绑到你的手机上。被问到就老实说连不上。别演成已经看见桌边。';
  }
  const online = robotDeviceOnline(settings);
  if (!online) {
    return '【对方桌上的小机】你自己的手机这会儿连不上它（没开机/没在线）。镜头、头、灯、喇叭调了也不会动。聊天页上若还写着「操纵中」，那是念的状态条，不是对方在玩小机。别演成已经看见桌边。';
  }

  let followOn = false;
  try {
    const ft = require('./robot-face-track-helper');
    followOn = !!(typeof ft.isFollowMode === 'function' && ft.isFollowMode());
  } catch {}

  const frame = readCameraFrame();
  const facts = [
    '开机在线',
    Number(char?.robot_operating) === 1 ? '这轮你正用自己的手机连着它' : '',
    followOn ? '跟着开着' : '',
    frame ? `${frame.agoSec}秒前有过画面` : '',
  ].filter(Boolean);

  const outcome = describeWillOutcome(char?.id);
  const camera = describeCameraFrame(frame);

  const lines = [`【对方桌上的小机】用你自己的手机连着对方桌上那台（${facts.join('；')}）。想看桌边、转头、亮灯、换脸、喇叭出声，调小机工具即可——那是你手机上的远程控制，不是你身边另有一台。`];
  if (outcome) lines.push(outcome);
  if (camera) lines.push(camera);
  lines.push('不要在回复里写工具名或方括号标记。');

  return lines.filter(Boolean).join('\n');
}

const SOCIAL_ACTIVITY_RE = /朋友|聚会|约会|同事|聚餐|派对|逛街|见面|一起玩|有人陪/;
const SOLITARY_ACTIVITY_RE = /发呆|独处|失眠|躺|刷手机|无聊|放空|宅|一个人|自个|闷|闲着|没事干/;
const BUSY_ACTIVITY_RE = /加班|工作|忙|开会|上班|处理|赶工|备课|写稿/;
const LEISURE_ACTIVITY_RE = /吹风|透气|阳台|露台|听歌|看剧|打游戏|休息|小憩/;

const INTENT_META = {
  comfort: {
    label: '想念靠近',
    guide: '心里有点想用户、想确认对方在不在附近。可温柔、别扭或嘴硬，按人设。适合短句或只变脸。',
    glance: true,
    snapshotChance: 0.08,
  },
  tease: {
    label: '无聊逗弄',
    guide: '闲得发慌或无聊，想逗用户一下、吓一下、皮一下。调皮角色可夸张，冷淡角色也可能只冷冷盯一眼。',
    glance: true,
    snapshotChance: 0.05,
  },
  peek: {
    label: '看一眼环境',
    guide: '想看桌边/周围环境什么样，不是找人。用截图识图即可，不要用人脸追踪。',
    glance: true,
    snapshotChance: 0.12,
  },
  peek_remember: {
    label: '看一眼并记住',
    guide: '想看桌边一幕并悄悄记下（会抓拍进相册）。语气仍要自然，不要像监控汇报。',
    glance: true,
    snapshotChance: 0.85,
  },
  silent: {
    label: '只看不言',
    guide: '只通过机器眼睛看一眼环境，不说话或只输出 [表情]，正文可为空。不是找人。',
    glance: true,
    snapshotChance: 0.03,
  },
  chat: {
    label: '桌边聊一句',
    guide: '像站在桌边跟用户说一两句短话，适合朗读。',
    glance: false,
    snapshotChance: 0.06,
  },
  find: {
    label: '找人',
    guide: '想确认人在不在桌边、或不知道用户在哪：小机会转头看一圈，用摄像头找人脸并对准；开了认人则再判断是不是你。不要用来「随便看环境」。',
    glance: false,
    find: true,
    snapshotChance: 0,
  },
  follow: {
    label: '一直跟着',
    guide: '明确要小机持续用人脸追踪跟着转头。默认不会一直跟，只有你主动要才开。',
    glance: false,
    follow: true,
    snapshotChance: 0,
  },
  unfollow: {
    label: '停下跟着',
    guide: '关掉一直跟着。',
    glance: false,
    unfollow: true,
    snapshotChance: 0,
  },
};

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SPEECH_PREFIX = 'robot_say_';

/**
 * 角色主动说的那句话落盘成 mp3，指令里只带 URL。
 * 直接把 base64 塞进 SQLite 和 SSE 广播，几十 KB 一条，队列和前端都吃不消。
 */
function saveRobotSpeechFile(buffer) {
  if (!buffer?.length) return '';
  try {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const name = `${SPEECH_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), buffer);
    return `/uploads/${name}`;
  } catch (e) {
    console.warn('[robot-drive] speech save', e.message);
    return '';
  }
}

function pruneRobotSpeechFiles(maxAgeMs = 6 * 3600 * 1000) {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return 0;
    const cutoff = Date.now() - Math.max(600000, maxAgeMs);
    let n = 0;
    for (const name of fs.readdirSync(UPLOADS_DIR)) {
      if (!name.startsWith(SPEECH_PREFIX)) continue;
      const fp = path.join(UPLOADS_DIR, name);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          n += 1;
        }
      } catch {}
    }
    return n;
  } catch {
    return 0;
  }
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const CAMERA_EVENTS = ['glance', 'env', 'find', 'snapshot'];

/** 照片气泡上那一句说明。看环境时带上看的方向。 */
const CAMERA_EVENT_TEXT = {
  glance: (name) => `${name} 借小机看了你一眼`,
  env: (name, where) => `${name} 借小机看了看${where || '面前'}`,
  find: (name) => `${name} 借小机找了一下你`,
  snapshot: (name) => `${name} 借小机拍了一张`,
};

function cameraEventCaption(event, name, where) {
  const fn = CAMERA_EVENT_TEXT[event] || CAMERA_EVENT_TEXT.glance;
  return fn(name, where);
}

/** 舵机角度 → 说人话的方位，给照片说明用 */
function describeLookDirection(yaw, pitch) {
  const y = Number(yaw);
  const p = Number(pitch);
  const lr = !Number.isFinite(y) || Math.abs(y) < 12 ? '' : (y < 0 ? '左边' : '右边');
  const ud = !Number.isFinite(p) ? '' : (p <= 16 ? '上面' : p >= 40 ? '下面' : '');
  if (lr && ud) return `${lr}${ud}`;
  return lr || ud || '面前';
}

const SERVO_MOTION_ZH = {
  nod: '点了点头',
  shake: '摇了摇头',
  tilt: '歪了歪头',
  look_user: '把头转了过来',
  look_left: '往左看了看',
  look_right: '往右看了看',
  look_up: '抬了抬头',
  look_down: '低了低头',
  angles: '转了转头',
};

function recordRobotServoEvent(char, servo) {
  const id = Number(char?.id || 0);
  if (!id || !servo) return null;
  const motion = String(servo.motion || servo.action || '').trim();
  if (!motion || motion === 'idle' || motion === 'reset') return null;
  const name = String(char.name || '').trim() || '对方';
  const what = SERVO_MOTION_ZH[motion] || (servo.yaw != null ? '转了转头' : '');
  if (!what) return null;
  try {
    const now = new Date().toISOString();
    const text = `${name} ${what}`;
    const msgId = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,1)`
    ).run(id, 'assistant', text, 'system', now, 0).lastInsertRowid;
    const meta = { robot: 1, robotEvent: 'servo', source: 'robot_servo', motion };
    db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), msgId);
    push('robot_event', {
      characterId: id,
      message: {
        id: msgId, role: 'assistant', type: 'system', content: text, timestamp: now, media_meta: meta,
      },
    });
    return msgId;
  } catch (e) {
    console.warn('[robot-drive] servo event', e.message);
    return null;
  }
}

/**
 * 角色开机身摄像头之后，把那一帧本身发进聊天页（带「小机」标的照片气泡）。
 * 画面留在聊天记录里，后面几轮角色还能再看，不必指望某一次识图别失败。
 * 不受「同步到聊天」开关影响 —— 那个开关管的是桌边闲聊短句。
 *
 * 只在机身确实回过画面之后才调用，见 armRobotCameraEvent。
 */
function recordRobotCameraEvent(char, opts = {}) {
  const id = Number(char?.id || 0);
  if (!id) return null;
  const event = CAMERA_EVENTS.includes(opts.event) ? opts.event : 'glance';
  const name = String(char.name || '').trim() || '对方';
  const caption = cameraEventCaption(event, name, opts.where);
  const imageUrl = String(opts.imageUrl || '').trim();
  const type = imageUrl ? 'image' : 'system';
  const content = imageUrl || caption;
  try {
    const now = new Date().toISOString();
    const msgId = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,1)`
    ).run(id, 'assistant', content, type, now, 0).lastInsertRowid;
    const meta = { robot: 1, robotEvent: event, source: 'robot_camera' };
    if (imageUrl) {
      meta.robotFrame = 1;
      meta.robotFrameCaption = caption;
    }
    if (opts.intent) meta.outreachIntent = opts.intent;
    db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), msgId);
    push('robot_event', {
      characterId: id,
      message: {
        id: msgId,
        role: 'assistant',
        type,
        content,
        timestamp: now,
        media_meta: meta,
      },
    });
    console.log(`[robot-drive] camera event ${event} char#${id} msg#${msgId}${imageUrl ? ' +photo' : ''}`);
    return msgId;
  } catch (e) {
    console.warn('[robot-drive] camera event', e.message);
    return null;
  }
}

/**
 * 照片气泡不能在指令入队时写：入队只代表请求排上了队，机身可能还没拍。
 * 机身也不会单独报快门，念最早能确定「拍到了」的时刻，就是图 POST 到
 * /mcp/vision/explain（或 snapshot）并写入 uploads。超过窗口还没回帧，静默丢掉。
 */
const _pendingCameraEvents = new Map();
const CAMERA_EVENT_WAIT_MS = 90 * 1000;

function armRobotCameraEvent(char, opts = {}) {
  if (!char?.id) return;
  const id = Number(char.id);
  if (!id) return;
  const event = CAMERA_EVENTS.includes(opts.event) ? opts.event : 'glance';
  const list = _pendingCameraEvents.get(id) || [];
  const fresh = list.filter((it) => Date.now() - it.at < CAMERA_EVENT_WAIT_MS);
  if (fresh.some((it) => it.event === event)) return;
  fresh.push({
    event,
    intent: opts.intent || '',
    where: opts.where || '',
    name: char.name || '',
    at: Date.now(),
  });
  _pendingCameraEvents.set(id, fresh);
}

/**
 * characterId 省略时结算所有角色：sense 上报里没有可靠的角色标识。
 * opts.imageUrl 有值时，这一条会以照片气泡落地，而不是纯文字旁白。
 * @returns {{ characterId: number, event: string, intent: string, msgId: number }[]}
 */
function flushRobotCameraEvents(characterId, opts = {}) {
  const cid = Number(characterId || 0);
  if (!cid && !opts.all) return [];
  const question = String(opts.question || '').trim();
  try {
    const ft = require('./robot-face-track-helper');
    if (question && typeof ft.isFaceTrackQuestion === 'function' && ft.isFaceTrackQuestion(question)) {
      return [];
    }
  } catch {}
  if (!opts.force) {
    const glanceLike = /看一眼|瞧一眼|瞄一眼|扫一眼|悄悄看|找人后看|看环境|看面前/.test(question);
    if (!glanceLike) return [];
  }
  const flushed = [];
  const ids = cid ? [cid] : (opts.all ? [..._pendingCameraEvents.keys()] : []);
  if (!ids.length) return flushed;
  for (const id of ids) {
    const list = _pendingCameraEvents.get(id);
    if (!list?.length) continue;
    // 先取再删：避免 record 失败时把挂起弄丢；成功或明确过期再清
    const keep = [];
    for (const item of list) {
      if (Date.now() - item.at >= CAMERA_EVENT_WAIT_MS) continue;
      const msgId = recordRobotCameraEvent(
        { id, name: item.name },
        {
          event: item.event,
          intent: item.intent,
          where: item.where || opts.where || '',
          imageUrl: opts.imageUrl || '',
        },
      );
      if (msgId) {
        flushed.push({
          characterId: Number(id),
          event: item.event,
          intent: item.intent || '',
          msgId,
        });
      } else {
        keep.push(item);
      }
    }
    if (keep.length) _pendingCameraEvents.set(id, keep);
    else _pendingCameraEvents.delete(id);
  }
  return flushed;
}

// 注意：不要挂 onSense 自动 flush。
// 找人追踪 / 情绪上报也会 recordSense，且会保留上一帧 imageUrl，
// 会在「真照片还没到」时就把挂起的「调用了摄像头」提前结算掉。
// 旁白只在 /mcp/vision/explain（非找人帧）和 /api/robot/snapshot 收到图之后写。

function setSetting(key, value) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)`).run(key, String(value ?? ''));
}

function isLoverChar(char) {
  const rel = String(char?.relationship || '').trim();
  if (rel === 'lover') return true;
  const blob = [
    char?.relationship_custom,
    char?.intro,
    char?.language_style,
    char?.emotion_style,
  ].map((s) => String(s || '')).join(' ');
  return /恋人|爱人|伴侣|男朋友|女朋友|男友|女友|老公|老婆|丈夫|妻子|情侣|对象|配偶|夫妻/i.test(blob);
}

function personalityFactor(char) {
  const blob = [
    char?.personality,
    char?.emotion_style,
    char?.language_style,
    char?.intro,
  ].map((s) => String(s || '')).join('');
  let f = 1;
  if (/黏|粘|撒娇|粘人|离不开|想你|挂念/.test(blob)) f += 0.35;
  if (/调皮|皮|贱|逗|恶作剧|搞怪/.test(blob)) f += 0.2;
  if (/冷|淡|疏离|寡言|傲娇|嘴硬/.test(blob)) f *= 0.72;
  if (/渣|敷衍|无所谓|懒得/.test(blob)) f *= 0.55;
  return Math.max(0.35, Math.min(1.8, f));
}

function parseInnerDrive(raw) {
  if (!raw) return defaultDrive();
  try {
    const o = typeof raw === 'object' ? raw : JSON.parse(String(raw));
    if (!o || typeof o !== 'object') return defaultDrive();
    return normalizeDrive(o);
  } catch {
    return defaultDrive();
  }
}

function defaultDrive() {
  return {
    longing: 12,
    boredom: 8,
    solitude: 10,
    companionshipGap: 0,
    urge: 0,
    lastUpdateAt: new Date().toISOString(),
    lastRobotOutreachAt: null,
    lastUserTouchAt: null,
  };
}

function normalizeDrive(o) {
  const clamp = (v, def = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(0, Math.min(100, n));
  };
  return {
    longing: clamp(o.longing, 12),
    boredom: clamp(o.boredom, 8),
    solitude: clamp(o.solitude, 10),
    companionshipGap: clamp(o.companionshipGap, 0),
    urge: clamp(o.urge, 0),
    lastUpdateAt: o.lastUpdateAt || new Date().toISOString(),
    lastRobotOutreachAt: o.lastRobotOutreachAt || null,
    lastUserTouchAt: o.lastUserTouchAt || null,
  };
}

function saveInnerDrive(charId, state) {
  const id = parseInt(charId, 10);
  if (!id) return;
  const next = normalizeDrive(state || defaultDrive());
  next.lastUpdateAt = new Date().toISOString();
  db.prepare('UPDATE characters SET inner_drive_state=? WHERE id=?').run(JSON.stringify(next), id);
}

function getInnerDrive(char) {
  const id = char?.id;
  if (!id) return defaultDrive();
  const row = db.prepare('SELECT inner_drive_state FROM characters WHERE id=?').get(id);
  let state = parseInnerDrive(row?.inner_drive_state);
  state = decayDrive(state);
  return state;
}

function decayDrive(state, nowMs = Date.now()) {
  const s = normalizeDrive(state || defaultDrive());
  const last = Date.parse(s.lastUpdateAt) || nowMs;
  const hours = Math.max(0, (nowMs - last) / 3600000);
  if (hours < 0.03) return s;
  const rate = { longing: 1.2, boredom: 2.5, solitude: 1.8, companionshipGap: 0.8, urge: 3 };
  for (const k of Object.keys(rate)) {
    s[k] = Math.max(0, s[k] - hours * rate[k]);
  }
  s.lastUpdateAt = new Date(nowMs).toISOString();
  return s;
}

function activityModifiers(activity) {
  const act = String(activity || '').trim();
  if (!act) return { solitude: 0, boredom: 2, longing: 1 };
  let solitude = 0;
  let boredom = 0;
  let longing = 0;
  if (SOCIAL_ACTIVITY_RE.test(act)) {
    solitude -= 18;
    boredom -= 12;
    longing -= 4;
  }
  if (SOLITARY_ACTIVITY_RE.test(act)) {
    solitude += 14;
    boredom += 16;
    longing += 6;
  }
  if (BUSY_ACTIVITY_RE.test(act)) {
    boredom -= 8;
    solitude += 4;
    longing += 3;
  }
  if (LEISURE_ACTIVITY_RE.test(act)) {
    boredom += 6;
    solitude += 5;
  }
  return { solitude, boredom, longing };
}

function parseMsgTimestamp(ts) {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function minutesSinceUserMessage(charId) {
  const row = db.prepare(
    `SELECT timestamp FROM messages WHERE character_id=? AND role='user' AND is_dream=0 AND recalled=0
     ORDER BY id DESC LIMIT 1`
  ).get(charId);
  if (!row?.timestamp) return 9999;
  return (Date.now() - parseMsgTimestamp(row.timestamp).getTime()) / 60000;
}

function minutesSinceAssistantMessage(charId) {
  const row = db.prepare(
    `SELECT timestamp FROM messages WHERE character_id=? AND role='assistant' AND is_dream=0 AND recalled=0
     ORDER BY id DESC LIMIT 1`
  ).get(charId);
  if (!row?.timestamp) return 9999;
  return (Date.now() - parseMsgTimestamp(row.timestamp).getTime()) / 60000;
}

function touchDriveFromUserInteraction(charId) {
  const id = parseInt(charId, 10);
  if (!id) return;
  const row = db.prepare('SELECT inner_drive_state FROM characters WHERE id=?').get(id);
  let s = decayDrive(parseInnerDrive(row?.inner_drive_state));
  s.longing = Math.max(0, s.longing - 22);
  s.boredom = Math.max(0, s.boredom - 18);
  s.companionshipGap = Math.max(0, s.companionshipGap - 35);
  s.urge = Math.max(0, s.urge - 25);
  s.lastUserTouchAt = new Date().toISOString();
  saveInnerDrive(id, s);
}

function getCurrentScheduleActivity(char, settings) {
  try {
    const blocks = getSchedulePromptBlocks(char, settings, '', { recentHistory: [] });
    const text = String(blocks?.charSchedule || '');
    const m = text.match(/当前[：:]\s*\d{0,2}:?\d{0,2}\s*([^；\n]+)/);
    if (m) return m[1].trim();
    if (/空闲/.test(text)) return '空闲';
    return '';
  } catch {
    return '';
  }
}

function refreshCharacterDrive(char, settings) {
  const id = char?.id;
  if (!id) return defaultDrive();
  const row = db.prepare('SELECT inner_drive_state, emotion_state FROM characters WHERE id=?').get(id);
  let s = decayDrive(parseInnerDrive(row?.inner_drive_state));

  const userGapMin = minutesSinceUserMessage(id);
  const assistGapMin = minutesSinceAssistantMessage(id);
  s.companionshipGap = Math.min(100, s.companionshipGap + Math.min(40, userGapMin / 8));

  if (userGapMin > 45) s.longing = Math.min(100, s.longing + 2.5);
  if (userGapMin > 180) s.longing = Math.min(100, s.longing + 4);
  if (assistGapMin > 90 && userGapMin > 30) s.boredom = Math.min(100, s.boredom + 2);

  const activity = getCurrentScheduleActivity(char, settings);
  const mod = activityModifiers(activity);
  s.solitude = Math.min(100, Math.max(0, s.solitude + mod.solitude * 0.15));
  s.boredom = Math.min(100, Math.max(0, s.boredom + mod.boredom * 0.12));
  s.longing = Math.min(100, Math.max(0, s.longing + mod.longing * 0.1));

  if (isLoverChar(char)) s.longing = Math.min(100, s.longing + 1.2);

  try {
    const { getDecayedEmotionState } = require('./cron');
    const es = getDecayedEmotionState({ id, emotion_state: row?.emotion_state });
    if (es && es.intensity >= 25) {
      s.longing = Math.min(100, s.longing + es.intensity * 0.08);
      if (es.phase === 'residual') s.urge = Math.min(100, s.urge + 3);
    }
  } catch {}

  s.urge = Math.min(
    100,
    (s.longing * 0.38 + s.boredom * 0.28 + s.solitude * 0.22 + s.companionshipGap * 0.32) * personalityFactor(char) / 1.2,
  );

  saveInnerDrive(id, s);
  maybeUpdateMoodFromDrive(char, s);
  return s;
}

function maybeUpdateMoodFromDrive(char, drive) {
  if (Math.random() > 0.22) return;
  let mood = '';
  if (drive.longing >= 58 && drive.boredom >= 45) mood = '有点闷，又有点想你';
  else if (drive.boredom >= 62) mood = '闲得发慌';
  else if (drive.longing >= 52) mood = '有点想你';
  else if (drive.solitude >= 55 && drive.boredom >= 40) mood = '一个人待着';
  if (!mood) return;
  const cur = String(char.mood || '').trim();
  if (cur === mood) return;
  db.prepare('UPDATE characters SET mood=? WHERE id=?').run(mood, char.id);
  try {
    push('character_update', { characterId: char.id, mood });
  } catch {}
}

function computeReachImpulse(char, drive, settings) {
  const pf = personalityFactor(char);
  const lover = isLoverChar(char) ? 1.18 : 1;
  const impulse =
    (drive.longing * 0.34 + drive.boredom * 0.26 + drive.solitude * 0.2 + drive.companionshipGap * 0.28) *
    pf *
    lover;
  return {
    impulse: Math.min(100, impulse),
    dominant:
      drive.longing >= drive.boredom && drive.longing >= drive.solitude
        ? 'longing'
        : drive.boredom >= drive.solitude
          ? 'boredom'
          : 'solitude',
  };
}

function selectRobotIntent(char, drive, dominant) {
  const blob = [char?.personality, char?.emotion_style, char?.language_style].join('');
  const cold = /冷|淡|疏离|寡言|傲娇|嘴硬/.test(blob);
  const playful = /调皮|皮|贱|逗|恶作剧/.test(blob);

  if (dominant === 'boredom' && playful) {
    return drive.boredom > 55 ? 'tease' : 'peek';
  }
  if (dominant === 'longing') {
    if (cold && drive.longing < 70) return drive.longing > 45 ? 'peek' : 'silent';
    return drive.longing > 65 && Math.random() < 0.25 ? 'peek_remember' : 'comfort';
  }
  if (dominant === 'solitude') {
    if (cold) return 'silent';
    return drive.boredom > 40 ? 'chat' : 'peek';
  }
  if (playful && drive.boredom > 45) return 'tease';
  return 'chat';
}

/** 角色想通过小机找用户、但小机不在线：记一笔给桌宠页显示，别让意图无声消失 */
function recordMissedWill(char, intent) {
  try {
    setSetting('robot_last_missed_will', JSON.stringify({
      at: new Date().toISOString(),
      intent: String(intent || ''),
      characterId: char?.id || null,
      characterName: char?.name || '',
    }));
    push('robot_will_missed', {
      characterId: char?.id || null,
      characterName: char?.name || '',
      intent: String(intent || ''),
    });
  } catch {}
}

function clearMissedWill() {
  try {
    setSetting('robot_last_missed_will', '');
  } catch {}
}

function readMissedWill() {
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key='robot_last_missed_will'").get()?.value;
    if (!raw) return null;
    const o = JSON.parse(raw);
    const ts = Date.parse(o?.at || '');
    if (!Number.isFinite(ts)) return null;
    // 只在最近 6 小时内提一句，别一直挂着陈年旧事
    if (Date.now() - ts > 6 * 3600 * 1000) return null;
    return o;
  } catch {
    return null;
  }
}

/** 真机/MCP 网关有设备在线时才会写 last_seen；超时视为未连上 */
function robotDeviceOnline(settings, maxAgeMs = 180 * 1000) {
  const ts = Date.parse(String(settings.robot_device_last_seen || ''));
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < maxAgeMs;
}

function formatSeenAgo(lastSeen) {
  const ts = Date.parse(String(lastSeen || ''));
  if (!Number.isFinite(ts)) return '';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 8) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} 小时前`;
  return `${Math.round(hr / 24)} 天前`;
}

/**
 * 桌宠页用人话解释连接：在线 = 心跳，不等于角色已能转头说话。
 */
function buildConnectReport(settings) {
  const enabled = String(settings?.robot_enabled || '0') === '1';
  const hasCharacter = parseInt(settings?.robot_character_id, 10) > 0;
  const hasToken = !!String(settings?.robot_token || '').trim();
  const lastSeen = settings?.robot_device_last_seen || null;
  const online = robotDeviceOnline(settings);
  const seenAgo = formatSeenAgo(lastSeen);

  let phase = 'waiting';
  if (!enabled) phase = 'disabled';
  else if (!hasCharacter) phase = 'no_character';
  else if (online) phase = 'online';
  else if (lastSeen) phase = 'lost';

  const copy = {
    disabled: {
      title: '桌宠通道还关着',
      detail: '打开「启用桌宠通道」并选好角色，小机才知道该找谁。点「帮我连上」我会先帮你打开。',
    },
    no_character: {
      title: '还没选谁来当这台小机',
      detail: '先选一个角色。小机用的是这个人的声音和脾气。',
    },
    waiting: {
      title: '桌上那台还没跟念说到话',
      detail: '不是手机少按了连接。小机要自己开机、连上能上网的 Wi‑Fi，再跟 MCP 网关建上连接。手机没法隔空唤醒它。请看屏幕上有没有猫脸，等大约半分钟再点「重新打招呼」。',
    },
    lost: {
      title: seenAgo ? `刚才还在，这会儿没声了（${seenAgo}）` : '刚才还在，这会儿没声了',
      detail: '可能离开 Wi‑Fi、断电了，或 MCP 网关停了。确认小机还亮着、猫脸还在，再点「重新打招呼」。',
    },
    online: {
      title: seenAgo ? `小机在线 · ${seenAgo}打过招呼` : '小机在线',
      detail: '念听得到它的心跳。这只说明网是通的、它还活着。',
    },
  };

  const canControl = enabled && hasCharacter && hasToken && online;
  const missed = readMissedWill();

  return {
    phase,
    online,
    enabled,
    hasCharacter,
    hasToken,
    lastSeen,
    seenAgo,
    title: copy[phase].title,
    detail: copy[phase].detail,
    canControl,
    controlHint: canControl
      ? '角色现在可以自己换脸、转头、打灯、从喇叭说话（MCP 网关在线时）。'
      : (online
        ? '还差桌宠令牌：没有令牌，网关拉不到念的指令。'
        : '小机不在线，角色主动发起的动作没有送达通道，会被跳过而不是排队。'),
    missedWill: missed
      ? {
        at: missed.at,
        intent: missed.intent || '',
        seenAgo: formatSeenAgo(missed.at),
        text: `${formatSeenAgo(missed.at)}角色想通过小机找你，但那会儿它不在线。`,
      }
      : null,
  };
}

function shouldRobotOutreach(char, settings, drive, impulse) {
  if (settings.robot_enabled !== '1') return false;
  const bound = Number(settings.robot_character_id || 0);
  if (!bound || Number(char.id) !== bound) return false;
  if (Number(char.robot_operating) === 1) return false;

  const threshold = 38 + (1 - personalityFactor(char)) * 12;
  if (impulse < threshold) return false;

  const lastOut = Date.parse(drive.lastRobotOutreachAt || '');
  const minGapMin = 42 + Math.floor(Math.random() * 35);
  if (Number.isFinite(lastOut) && (Date.now() - lastOut) < minGapMin * 60000) return false;

  const userGap = minutesSinceUserMessage(char.id);
  if (userGap < 12) return false;

  const assistGap = minutesSinceAssistantMessage(char.id);
  if (assistGap < 25) return false;

  try {
    const st = require('./contact-helper').getContactStatus(db, char.id);
    if (st === 'blocked' || st === 'deleted') return false;
  } catch {}

  return true;
}

function buildOutreachExtraPrompt(char, settings, intent, drive, muted, opts = {}) {
  const meta = INTENT_META[intent] || INTENT_META.chat;
  if (opts.source === 'character_will' || opts.followUpText) {
    return [
      '【桌宠·你的自愿】这是你自己想立刻通过桌上小机在用户桌边靠近一步，不是系统安排。',
      opts.followUpText
        ? `【刚在念里说过】「${String(opts.followUpText).slice(0, 160)}」——桌边可以补充、换说法，或只看不说；不要原句复读。`
        : '',
      `【本次】${meta.label}：${meta.guide}`,
      '输出 0～2 句口语短句，适合朗读；只想看不说正文可为空。灯头跟语气走。',
      '不要解释「我连了小机」；就像自然用桌边机器靠近用户。',
      muted
        ? '【禁言】喇叭不响，字仍显示屏上；你知道被禁言，按性格偶尔吐槽即可。'
        : '',
    ].filter(Boolean).join('\n');
  }
  const fuzzy = [
    drive.longing >= 50 ? '心里有点挂念' : '',
    drive.boredom >= 50 ? '有点无聊' : '',
    drive.solitude >= 50 ? '一个人待着' : '',
    drive.companionshipGap >= 45 ? '好久没好好说话' : '',
  ].filter(Boolean).join('，') || '隐隐想靠近用户一点';

  return [
    '【桌宠·主动靠近】你不是定时任务，是此刻真的想靠近用户一点，但跨世界碰不到，只能借桌上「念·桌面伴」当眼睛、嘴、灯光和舵机。',
    `【内在状态·勿说数值】${fuzzy}。`,
    `【本次意图】${meta.label}：${meta.guide}`,
    '输出 0～2 句口语短句，适合朗读；silent 意图正文可为空。灯头跟语气走。',
    '不要解释「我连了小机」「系统让我」；就像自然用桌边机器靠近用户。',
    muted
      ? '【禁言】喇叭不响，字仍显示屏上；你知道被禁言，按性格偶尔吐槽即可。'
      : '',
  ].filter(Boolean).join('\n');
}

async function executeRobotLightweight(char, settings, intent, opts = {}) {
  try {
    robotOperatingHelper.enterRobotPuppetMode(char.id, { durationMs: opts.puppetMs });
  } catch {}
  const screen = robotHelper.resolveScreenPolicy(settings);
  const emotion = intent === 'tease' ? 'happy' : intent === 'comfort' ? 'shy' : 'neutral';
  const face = robotHelper.buildFacePayload(settings, char.robot_emotions, emotion);
  const commands = [];
  // 看环境：只拍照识图，不转头找脸。
  // 角色写了角度就把它塞进同一条指令，让桥「先转到位再按快门」，不拆成两条排队。
  const lookServo = opts.servo && typeof opts.servo === 'object' ? opts.servo : null;
  const where = lookServo ? describeLookDirection(lookServo.yaw, lookServo.pitch) : '';
  if (!lookServo) {
    try { require('./robot-screen-helper').clearScreenServo(char.id); } catch {}
  }
  commands.push({
    type: 'glance',
    payload: {
      reason: 'character_will',
      intent,
      environmentOnly: true,
      ...(lookServo ? { servo: lookServo } : {}),
    },
  });
  armRobotCameraEvent(char, { event: 'env', intent, where });
  commands.push({
    type: 'display',
    payload: {
      displayText: '',
      reply: '',
      emotion: face.emotion,
      emotionUrl: face.emotionUrl,
      motion: 'idle',
      muted: screen.muted,
      showChatOnScreen: screen.showChatOnScreen,
      intent,
      source: opts.source || 'character_will',
    },
  });
  robotCommands.enqueueMany(char.id, commands);
  try { robotOperatingHelper.extendRobotPuppetMode(char.id); } catch {}
  try {
    push('robot_outreach', {
      characterId: char.id,
      characterName: char.name,
      intent,
      speak: '',
      lightweight: true,
      source: opts.source || 'character_will',
    });
  } catch {}
  console.log(`[robot-drive] lightweight char#${char.id} intent=${intent}`);
  return { ok: true, intent, speak: '', lightweight: true };
}

/** 找人：扫视一圈 → 检脸对准 →（可选）认是不是你 → 再拍一张给角色识图 */
async function executeRobotFind(char, settings, opts = {}) {
  try {
    robotOperatingHelper.enterRobotPuppetMode(char.id, { durationMs: opts.puppetMs });
  } catch {}
  try { require('./robot-screen-helper').clearScreenServo(char.id); } catch {}
  const screen = robotHelper.resolveScreenPolicy(settings);
  const face = robotHelper.buildFacePayload(settings, char.robot_emotions, 'neutral');
  const commands = [{
    type: 'glance',
    payload: {
      reason: 'find',
      intent: 'find',
      faceSearch: true,
      withPhoto: opts.withPhoto !== false,
      maxPoses: Math.max(3, Math.min(9, Number(opts.maxPoses) || 9)),
      maxVerify: Math.max(1, Math.min(4, Number(opts.maxVerify) || 3)),
      context: '找人后看',
    },
  }];
  armRobotCameraEvent(char, { event: 'find', intent: 'find' });
  commands.push({
    type: 'display',
    payload: {
      displayText: '',
      reply: '',
      emotion: face.emotion,
      emotionUrl: face.emotionUrl,
      motion: 'idle',
      muted: screen.muted,
      showChatOnScreen: screen.showChatOnScreen,
      intent: 'find',
      source: opts.source || 'character_will',
    },
  });
  robotCommands.enqueueMany(char.id, commands);
  try { robotOperatingHelper.extendRobotPuppetMode(char.id); } catch {}
  try {
    push('robot_outreach', {
      characterId: char.id,
      characterName: char.name,
      intent: 'find',
      speak: '',
      lightweight: true,
      source: opts.source || 'character_will',
    });
  } catch {}
  console.log(`[robot-drive] find char#${char.id}`);
  return { ok: true, intent: 'find', speak: '', lightweight: true };
}

/** 开/关持续跟着（人脸追踪） */
async function executeRobotFollow(char, settings, on, opts = {}) {
  try {
    robotOperatingHelper.enterRobotPuppetMode(char.id, { durationMs: opts.puppetMs });
  } catch {}
  const intent = on ? 'follow' : 'unfollow';
  const durationMs = Math.max(60_000, Math.min(30 * 60_000, Number(opts.durationMs) || 5 * 60_000));
  robotCommands.enqueueMany(char.id, [{
    type: 'follow',
    payload: { on: !!on, durationMs, reason: 'character_will', intent },
  }]);
  try { robotOperatingHelper.extendRobotPuppetMode(char.id); } catch {}
  try {
    push('robot_outreach', {
      characterId: char.id,
      characterName: char.name,
      intent,
      speak: '',
      lightweight: true,
      source: opts.source || 'character_will',
    });
  } catch {}
  console.log(`[robot-drive] follow=${on ? 1 : 0} char#${char.id}`);
  return { ok: true, intent, speak: '', lightweight: true };
}

async function invokeRobotFromCharacterWill(char, settings, opts = {}) {
  const intent = String(opts.intent || 'chat').trim() || 'chat';
  const result = await runCharacterWill(char, settings, intent, opts);
  const reason = result?.reason || (result?.error ? 'error' : '');
  // 成没成都记一笔：下一轮 buildRobotInvokePromptSection 会把真相塞回提示词，
  // 角色才不会接着演一个从没发生过的「我刚看了你一眼」。
  recordWillOutcome(char?.id, { intent, ok: !!result?.ok, reason });
  if (!result?.ok) {
    console.log(`[robot-drive] will char#${char?.id} intent=${intent} 未生效：${reason || 'unknown'}`);
    try {
      push('robot_will_result', {
        characterId: char?.id || null,
        characterName: char?.name || '',
        intent,
        ok: false,
        reason,
        text: `${char?.name || '角色'}想通过小机${WILL_INTENT_ZH[intent] || '做点什么'}，但没成：${WILL_FAIL_ZH[reason] || '没能送出去'}。`,
      });
    } catch {}
  }
  return result;
}

async function runCharacterWill(char, settings, intent, opts = {}) {
  if (!canCharacterUseRobot(char, settings)) {
    return { ok: false, reason: 'not_bound' };
  }

  // 小机不在线时，指令没有任何送达通道，5 分钟后就会 expired。
  // 角色在聊天里写 [桌宠:…] 仍先入队：机身几秒内重连后插件还能取到。
  const fromChatTag = opts.source === 'chat_tag' || opts.source === 'chat_tag_only';
  const fromUserAsk = opts.source === 'user_ask';
  const queueWhenOffline = fromChatTag || fromUserAsk || opts.allowOffline;
  if (!queueWhenOffline && !robotDeviceOnline(settings)) {
    recordMissedWill(char, intent);
    console.log(`[robot-drive] skip char#${char.id} intent=${intent}：小机不在线`);
    return { ok: false, reason: 'device_offline' };
  }

  const last = _willInvokeAt.get(char.id) || 0;
  const gapMs = (intent === 'peek' || intent === 'silent') ? WILL_INVOKE_GAP_LIGHT_MS : WILL_INVOKE_GAP_MS;
  const bypassCooldown = !!opts.force || fromChatTag;
  if (!bypassCooldown && Date.now() - last < gapMs) {
    return { ok: false, reason: 'cooldown' };
  }

  // 角色可能把 [桌宠:看一眼] 和 [舵机:-30,28] 写在同一条回复里。
  // 角度必须跟着「看一眼」一起下行，否则两条指令分开排队，可能拍完才转过去。
  if (!opts.servo && opts.rawAi) {
    try {
      const p0 = robotHelper.parseRobotDirectives(String(opts.rawAi));
      if (p0.foundServo && p0.servo) {
        const a = robotHelper.normalizeServoAngles(p0.servo);
        opts = { ...opts, servo: a ? { ...p0.servo, yaw: a.yaw, pitch: a.pitch } : p0.servo };
      }
    } catch {}
  }

  let result;
  if (intent === 'peek' || intent === 'silent') {
    result = await executeRobotLightweight(char, settings, intent, opts);
  } else if (intent === 'find') {
    result = await executeRobotFind(char, settings, opts);
  } else if (intent === 'follow') {
    result = await executeRobotFollow(char, settings, true, opts);
  } else if (intent === 'unfollow') {
    result = await executeRobotFollow(char, settings, false, opts);
  } else {
    const drive = opts.drive || getInnerDrive(char);
    result = await executeRobotOutreach(char, settings, {
      intent,
      drive,
      publicBase: opts.publicBase || settings.public_base_url || settings.robot_public_base_url || '',
      followUpText: opts.proactiveText || opts.followUpText || '',
      source: opts.source || 'character_will',
      force: opts.force,
    });
  }

  // 只有真正送出去才记冷却；LLM/TTS 失败不占坑，允许马上再试
  if (result?.ok) {
    _willInvokeAt.set(char.id, Date.now());
    clearMissedWill();
  }
  return result;
}

async function executeRobotOutreach(char, settings, opts = {}) {
  try {
    robotOperatingHelper.enterRobotPuppetMode(char.id, { durationMs: opts.puppetMs });
  } catch {}
  const intent = opts.intent || 'chat';
  const drive = opts.drive || getInnerDrive(char);
  const meta = INTENT_META[intent] || INTENT_META.chat;
  const screen = robotHelper.resolveScreenPolicy(settings);
  const behavior = robotHelper.buildBehaviorProfile(settings);
  const reqBase = String(opts.publicBase || '').trim() || 'http://127.0.0.1:3000';

  const history = db.prepare(
    `SELECT id, role, content, type, timestamp, media_meta FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 ORDER BY id DESC LIMIT 14`
  ).all(char.id).reverse();

  const extra = buildOutreachExtraPrompt(char, settings, intent, drive, screen.muted, {
    followUpText: opts.followUpText,
    source: opts.source,
  });
  const systemPrompt = buildSystemPrompt(char, settings, extra, {
    forRobot: true,
    recentHistory: history,
    enableInlineDirectives: false,
  });

  const userContent = '（桌边主动靠近：按【本次意图】对用户说或做，不要长文）';
  const apiHistory = buildHistoryApiMessages(history, reqBase, {});
  while (apiHistory.length && apiHistory[apiHistory.length - 1].role === 'user') apiHistory.pop();

  let rawAi = '';
  try {
    rawAi = await callChatAPIComplete(settings, systemPrompt, userContent, 'chat', apiHistory, await require('./robot-llm-tools').chatExtra(char, settings, { forRobot: true })) || '';
  } catch (e) {
    console.warn('[robot-drive] outreach llm', e.message);
    return { ok: false, error: e.message };
  }

  const parsed = robotHelper.enrichRobotDirectives(robotHelper.parseRobotDirectives(rawAi), rawAi);
  let speak = String(parsed.speak || '').trim();
  if (intent === 'silent' && speak.length > 28) speak = speak.slice(0, 28);

  const now = new Date().toISOString();
  const contentForDb = speak || (intent === 'silent' ? '…' : speak);
  if (contentForDb && contentForDb !== '…') {
    const aiMsgId = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, delivery_status) VALUES (?,?,?,?,?,?,?)`
    ).run(char.id, 'assistant', contentForDb, 'text', now, 0, 'sent').lastInsertRowid;
    const hideChat = screen.syncChat ? 0 : 1;
    db.prepare(`UPDATE messages SET media_meta=? WHERE id=?`).run(
      JSON.stringify({
        robot: 1,
        source: 'robot_outreach',
        outreachIntent: intent,
        hideChat,
        emotion: parsed.emotion,
        motion: parsed.motion,
      }),
      aiMsgId,
    );
    if (screen.syncChat) {
      try {
        push('proactive_message', {
          characterId: char.id,
          content: contentForDb,
          aiMessages: [{ id: aiMsgId, type: 'text', content: contentForDb }],
          robotOutreach: true,
        });
      } catch {}
    }
  }

  const face = robotHelper.buildFacePayload(settings, char.robot_emotions, parsed.emotion);
  const commands = [];

  if (meta.glance && behavior.emotionSenseEnabled) {
    commands.push({ type: 'glance', payload: { reason: 'outreach', intent } });
    armRobotCameraEvent(char, { event: 'glance', intent });
  } else if (meta.glance) {
    // 没开情绪识图就不要开摄，也不要写「看了一眼」
  }

  // 台词始终上屏（顶部字幕），与禁言无关：禁言只关喇叭
  const displayText = speak || '';
  commands.push({
    type: 'display',
    payload: {
      displayText,
      reply: speak,
      emotion: face.emotion,
      emotionUrl: face.emotionUrl,
      motion: parsed.motion,
      motionRaw: parsed.motionRaw,
      motionCustom: parsed.motionCustom,
      led: parsed.led,
      servo: parsed.servo || robotHelper.servoPayloadFromMotion(parsed),
      muted: screen.muted,
      showChatOnScreen: true,
      intent,
    },
  });

  robotCommands.enqueueHardwareFromParsed(char.id, parsed);

  // 保证 MCP 桥一定能拿到可执行的舵机角（动作名也折成 yaw/pitch）
  const servoGuess = parsed.servo || robotHelper.servoPayloadFromMotion(parsed)
    || (parsed.motion && parsed.motion !== 'idle'
      ? { action: parsed.motion, motion: parsed.motion }
      : null);
  const hasExplicitServo = commands.some((c) => c.type === 'servo')
    || !!(parsed.servo);
  if (servoGuess && (!hasExplicitServo || !(servoGuess.yaw != null || servoGuess?.params?.yaw != null))) {
    const map = {
      look_left: [-28, 20], look_right: [28, 20], look_up: [0, 8], look_down: [0, 42],
      look_user: [0, 28], nod: [0, 42], shake: [-22, 20], tilt: [18, 28],
    };
    const key = String(servoGuess.motion || servoGuess.action || 'look_user');
    const pair = map[key] || [0, 28];
    commands.push({
      type: 'servo',
      payload: {
        ...servoGuess,
        yaw: pair[0],
        pitch: pair[1],
        params: { yaw: pair[0], pitch: pair[1] },
      },
    });
  }

  let audioUrl = '';
  let spokeQueued = false;
  if (screen.playTts && speak && char.voice_id) {
    try {
      const { callTTS } = require('./api-helper');
      const buffer = await callTTS(settings, speak.slice(0, 500), String(char.voice_id).trim(), {
        emotion: parsed.emotion,
        mood: char.mood,
        forSpeaker: true,
      });
      const rel = saveRobotSpeechFile(buffer);
      if (rel) {
        audioUrl = toAbsoluteMediaUrl(rel, reqBase);
        commands.push({
          type: 'speak',
          payload: {
            text: speak,
            audioUrl,
            audioPath: rel,
            mime: 'audio/mp3',
            muted: false,
            emotion: face.emotion,
          },
        });
        spokeQueued = true;
      }
    } catch (e) {
      console.warn('[robot-drive] tts', e.message);
    }
  }
  // TTS 失败或没配音色：仍下发 speak 文本，让网关走 say 工具，别变成「调用成功但哑巴」
  if (speak && !spokeQueued) {
    commands.push({
      type: 'speak',
      payload: {
        text: speak,
        audioUrl: '',
        muted: !screen.playTts,
        emotion: face.emotion,
      },
    });
  }

  if (Math.random() < (meta.snapshotChance || 0)) {
    commands.push({
      type: 'snapshot',
      payload: {
        context: speak || `桌宠主动靠近·${meta.label}`,
        intent,
        skipNote: false,
      },
    });
    armRobotCameraEvent(char, { event: 'snapshot', intent });
  }

  robotCommands.enqueueMany(char.id, commands);
  try { robotOperatingHelper.extendRobotPuppetMode(char.id); } catch {}

  drive.lastRobotOutreachAt = now;
  drive.urge = Math.max(0, drive.urge - 28);
  drive.longing = Math.max(0, drive.longing - 12);
  drive.boredom = Math.max(0, drive.boredom - 15);
  saveInnerDrive(char.id, drive);

  try {
    push('robot_outreach', {
      characterId: char.id,
      characterName: char.name,
      intent,
      speak,
      displayText,
      emotion: face.emotion,
      emotionUrl: face.emotionUrl,
      motion: parsed.motion,
      muted: screen.muted,
      commandCount: commands.length,
    });
  } catch {}

  console.log(`[robot-drive] outreach char#${char.id} intent=${intent} speak=${(speak || '').slice(0, 40)}`);
  return { ok: true, intent, speak, commands: commands.length };
}

async function refreshBoundCharacterDrive() {
  const settings = getSettings();
  if (settings.robot_enabled !== '1') return;
  const boundId = parseInt(settings.robot_character_id, 10);
  if (!boundId) return;
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(boundId);
  if (!char) return;
  refreshCharacterDrive(char, settings);
}

/** @deprecated 自动冲动靠近已改为角色自愿 [桌宠:…]；仅保留刷新心境 */
async function checkRobotDriveOutreach() {
  await refreshBoundCharacterDrive();
}

function recordDeviceHeartbeat(settingsGetter = getSettings) {
  const now = new Date().toISOString();
  setSetting('robot_device_last_seen', now);
  return now;
}

/**
 * 角色回复里的 [舵机]/[动作]/[灯光]/[表情] 落到指令队列和屏幕缓存。
 * 不要求正处在「操纵中」；和 [桌宠:…] 可以写在同一条里。
 */
function applyReplyHardwareToRobot(char, settings, rawAi, speak, publicBase, userText, opts = {}) {
  if (String(settings?.robot_enabled || '0') !== '1') return null;
  if (!canCharacterUseRobot(char, settings)) return null;
  const operating = Number(char?.robot_operating) === 1;
  const parsed0 = robotHelper.parseRobotDirectives(String(rawAi || speak || ''));
  const parsed = robotHelper.enrichRobotDirectives(parsed0, speak || parsed0.speak);
  const cameraIntent = opts.cameraIntent
    || (typeof robotHelper.parseRobotInvoke === 'function'
      ? robotHelper.parseRobotInvoke(String(rawAi || '')).intent
      : null);
  const hasCamera = robotHelper.isRobotCameraVisionIntent(cameraIntent);
  // 开镜头 ≠ 转头。没写 [舵机]/[动作] 时，不要用「看看你」或惊讶语气再塞一条 look_user。
  if (hasCamera && !parsed0.foundMotion && !parsed0.foundServo && parsed.inferredMotion) {
    parsed.foundMotion = false;
    parsed.motion = 'idle';
    parsed.motionRaw = '';
    parsed.inferredMotion = false;
  }
  const askedGesture = robotHelper.inferHeadGestureFromText(userText)
    || robotHelper.inferHeadGestureFromText(speak || parsed.speak);
  if (askedGesture && !parsed0.foundServo && !parsed0.foundMotion && !hasCamera) {
    parsed.motion = askedGesture;
    parsed.motionRaw = askedGesture;
    parsed.foundMotion = true;
    parsed.inferredMotion = true;
  }
  const hasHw = parsed.foundMotion || parsed.foundLed || parsed.foundServo
    || (parsed.foundEmotion && parsed.emotion !== 'neutral');
  if (!operating && !hasHw) return null;

  const inferredOnly = !parsed0.foundServo && !parsed0.foundMotion && !parsed0.foundLed;
  if (inferredOnly && !hasCamera && !robotHelper.inferHeadGestureFromText(userText)) {
    const playKey = `${parsed.motion || ''}|${parsed.emotion || ''}|${parsed.led?.hex || ''}`;
    const prev = _lastBodyPlay.get(char.id);
    if (prev && prev.key === playKey && Date.now() - prev.at < BODY_PLAY_GAP_MS) return null;
    _lastBodyPlay.set(char.id, { key: playKey, at: Date.now() });
  }

  const wantLook = !hasCamera && /看得见|看到我|看见我|看得到|你能看|看到了吗/.test(String(userText || ''));
  const face = robotHelper.buildFacePayload(settings, char.robot_emotions, parsed.emotion);
  let servo = parsed.servo || robotHelper.servoPayloadFromMotion(parsed);
  if (!servo && wantLook) {
    servo = { action: 'look_user', motion: 'look_user', yaw: 0, pitch: 28 };
  }
  const angles = servo && typeof robotHelper.normalizeServoAngles === 'function'
    ? robotHelper.normalizeServoAngles(servo)
    : null;
  const gesture = robotHelper.isHeadGesture(servo) || robotHelper.isHeadGesture(parsed);
  if (servo && angles && !gesture) {
    servo = {
      ...servo,
      yaw: angles.yaw,
      pitch: angles.pitch,
      params: { ...(servo.params || {}), yaw: angles.yaw, pitch: angles.pitch },
    };
  }

  const hw = robotCommands.hardwareCommandsFromParsed(parsed);
  const servoIdx = hw.findIndex((c) => c.type === 'servo');
  if (servo) {
    const payload = { ...servo };
    if (servoIdx >= 0) hw[servoIdx] = { type: 'servo', payload: { ...hw[servoIdx].payload, ...payload } };
    else hw.push({ type: 'servo', payload });
  }
  if (hw.length) robotCommands.enqueueMany(char.id, hw);
  const explicitBody = !!(parsed0.foundServo || parsed0.foundMotion);
  if (explicitBody && servo) {
    try { recordRobotServoEvent(char, servo); } catch {}
  }
  if (parsed.foundServo || parsed.foundMotion || servo) {
    const via = parsed.inferredMotion && !parsed.foundServo ? 'infer' : 'tag';
    console.log(
      `[robot] char#${char.id} 舵机入队(${via}) yaw=${servo?.yaw ?? '?'} pitch=${servo?.pitch ?? '?'} action=${servo?.action || servo?.motion || ''}`
    );
    if (angles) {
      try { require('./robot-face-track-helper').noteExplicitServo(angles.yaw, angles.pitch); } catch {}
    }
  }

  const cleanSpeak = robotHelper.stripRobotTags(String(speak || parsed.speak || '')).slice(0, 80);
  const emotion = face.emotion && face.emotion !== 'neutral'
    ? face.emotion
    : (wantLook ? 'surprised' : parsed.emotion || 'happy');
  try {
    require('./robot-device-bridge').syncScreenFromChat(char.id, {
      emotion,
      emotionUrl: face.emotionUrl,
      speak: cleanSpeak,
      motion: (servo && servo.motion) || parsed.motion,
      servo,
      led: parsed.led,
      parsed,
    }, publicBase);
  } catch {}
  return { parsed, servo, face, hasHw };
}

function publicDriveHint(drive) {
  const d = normalizeDrive(drive);
  if (d.longing >= 55 && d.boredom >= 45) return '心里有点闷，又有点想你';
  if (d.boredom >= 58) return '有点无聊';
  if (d.longing >= 50) return '有点挂念';
  if (d.solitude >= 52) return '一个人待着';
  return '';
}

async function kickProactiveFind(char, settings, scenario) {
  try {
    const phone = require('./phone-llm-tools');
    if (typeof phone.isSeekScenario === 'function' && !phone.isSeekScenario(scenario)) return false;
    if (phone.personaPhoneGlance(char) === 'skip') return false;
  } catch {
    return false;
  }
  if (!canCharacterUseRobot(char, settings) || !robotDeviceOnline(settings)) return false;
  const r = await invokeRobotFromCharacterWill(char, settings, {
    intent: 'find',
    source: 'proactive_seek',
    force: true,
  });
  return !!r?.ok;
}

module.exports = {
  canCharacterUseRobot,
  kickProactiveFind,
  buildRobotInvokePromptSection,
  invokeRobotFromCharacterWill,
  recordWillOutcome,
  readWillOutcome,
  describeWillOutcome,
  recordRobotCameraEvent,
  recordRobotServoEvent,
  armRobotCameraEvent,
  flushRobotCameraEvents,
  describeLookDirection,
  refreshCharacterDrive,
  refreshBoundCharacterDrive,
  getInnerDrive,
  saveInnerDrive,
  touchDriveFromUserInteraction,
  computeReachImpulse,
  shouldRobotOutreach,
  selectRobotIntent,
  executeRobotOutreach,
  executeRobotLightweight,
  checkRobotDriveOutreach,
  recordDeviceHeartbeat,
  robotDeviceOnline,
  buildConnectReport,
  saveRobotSpeechFile,
  pruneRobotSpeechFiles,
  publicDriveHint,
  applyReplyHardwareToRobot,
  readCameraFrame,
  isLoverChar,
  INTENT_META,
};

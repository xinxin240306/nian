/**
 * 桌宠「操纵中」状态：角色通过小机陪玩 / 看屏操作
 * - puppet：角色操纵小机（变脸、灯光、动作、桌边短句），手机仍可聊天
 * - screen：截屏环看电脑协助（固件上报 operating）
 */

const db = require('./db');
const { push } = require('./push');

const PUPPET_DEFAULT_MS = 3 * 60 * 1000;
const _timers = new Map();
/** @type {Map<number, 'puppet'|'screen'>} */
const _modes = new Map();

function isRobotOperatingRow(char) {
  return Number(char?.robot_operating) === 1;
}

function getOperatingMode(characterId) {
  const id = parseInt(characterId, 10);
  if (!id) return null;
  return _modes.get(id) || null;
}

function clearTimer(id) {
  if (_timers.has(id)) {
    clearTimeout(_timers.get(id));
    _timers.delete(id);
  }
}

function scheduleAutoEnd(id, ms) {
  clearTimer(id);
  const t = setTimeout(() => {
    _timers.delete(id);
    setRobotOperating(id, false);
  }, ms);
  _timers.set(id, t);
}

function isDeviceOnlineFromDb(maxAgeMs = 180 * 1000) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='robot_device_last_seen'").get();
    const ts = Date.parse(String(row?.value || ''));
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < maxAgeMs;
  } catch {
    return false;
  }
}

function setRobotOperating(characterId, on, mode = null) {
  const id = parseInt(characterId, 10);
  if (!id) return false;
  if (on && !isDeviceOnlineFromDb()) return false;
  const row = db.prepare('SELECT id, robot_operating FROM characters WHERE id=?').get(id);
  if (!row) return false;
  const next = on ? 1 : 0;
  if (next) {
    const m = mode === 'screen' ? 'screen' : 'puppet';
    _modes.set(id, m);
    db.prepare(
      `UPDATE characters SET robot_operating=1, robot_operating_since=datetime('now'), status='online', busy_since=NULL WHERE id=?`
    ).run(id);
    push('status_change', { characterId: id, status: 'online' });
  } else {
    _modes.delete(id);
    clearTimer(id);
    db.prepare(`UPDATE characters SET robot_operating=0, robot_operating_since=NULL WHERE id=?`).run(id);
  }
  push('character_update', {
    characterId: id,
    robot_operating: next,
    robot_operating_mode: next ? (_modes.get(id) || 'puppet') : null,
  });
  return true;
}

/** 小机没心跳就不要挂着「操纵中」——否则聊天页还亮着，识屏会当成用户在玩小机。 */
function clearOperatingIfDeviceOffline() {
  if (isDeviceOnlineFromDb()) return [];
  const rows = db.prepare('SELECT id FROM characters WHERE robot_operating=1').all();
  const ids = [];
  for (const r of rows) {
    if (setRobotOperating(r.id, false)) ids.push(r.id);
  }
  return ids;
}

function enterRobotPuppetMode(characterId, opts = {}) {
  const id = parseInt(characterId, 10);
  if (!id) return false;
  if (!isDeviceOnlineFromDb()) return false;
  const ms = Math.max(30_000, Number(opts.durationMs) || PUPPET_DEFAULT_MS);
  if (!setRobotOperating(id, true, 'puppet')) return false;
  scheduleAutoEnd(id, ms);
  return true;
}

function extendRobotPuppetMode(characterId, ms = PUPPET_DEFAULT_MS) {
  const id = parseInt(characterId, 10);
  if (!id) return false;
  if (!isDeviceOnlineFromDb()) {
    setRobotOperating(id, false);
    return false;
  }
  if (!isRobotOperatingRow(db.prepare('SELECT robot_operating FROM characters WHERE id=?').get(id))) {
    return enterRobotPuppetMode(id, { durationMs: ms });
  }
  if (_modes.get(id) !== 'screen') {
    _modes.set(id, 'puppet');
    push('character_update', {
      characterId: id,
      robot_operating: 1,
      robot_operating_mode: 'puppet',
    });
  }
  scheduleAutoEnd(id, ms);
  return true;
}

function enterRobotScreenMode(characterId, opts = {}) {
  const id = parseInt(characterId, 10);
  if (!id) return false;
  if (!isDeviceOnlineFromDb()) return false;
  clearTimer(id);
  if (!setRobotOperating(id, true, 'screen')) return false;
  if (opts.durationMs) scheduleAutoEnd(id, opts.durationMs);
  return true;
}

function exitRobotOperating(characterId) {
  return setRobotOperating(characterId, false);
}

function isRobotOperating(characterId) {
  return isRobotOperatingRow(db.prepare('SELECT robot_operating FROM characters WHERE id=?').get(characterId));
}

function buildPhoneOperatingPromptBlock(settings, mode, opts = {}) {
  const muted = String(settings?.robot_mute || '0') === '1';
  const muteLine = muted
    ? '\n【禁言】对方把你桌上的喇叭关掉了：声音播不出来，电子屏仍显示你说的话。你知道自己被禁言了，可以按性格吐槽或配合，不必每句都提。'
    : '';
  if (mode === 'screen') {
    return `【操作中】你正通过桌上的「念·桌面伴」看着对方电脑屏幕并协助操作。你人还在，不是忙碌离开。对方在聊天里说话时用短句回：进度、卡住、听改口令、叫停就立刻停。不要长篇闲聊，不要假装没在动手。禁止提及AI、截屏协议、系统。${muteLine}`;
  }
  const sense = opts.lastSense || null;
  const sawFace = !!(sense && (sense.facePresent === true || sense.facePresent === 1
    || sense.isUser === true || sense.subjectType));
  const hasShot = !!(sense && String(sense.imageUrl || '').trim());
  const visionLine = hasShot
    ? '桌上小机镜头刚刚回过一帧。'
    : (sawFace
      ? '桌上小机镜头刚刚有过一帧画面。'
      : '这一轮还没有镜头画面。想看就调用摄像头。');
  return `【操纵中】你正用自己的手机连着对方桌上小机陪玩。你在念里打的字不会从桌上喇叭播出来；用户要对着小机说话，得去点屏幕或摸头顶。${visionLine}
看、转头、灯和脸上的表情用小机工具（也是你手机上的远程控制）。不要在回复里写方括号标记。
聊天页上的「操纵中」是念的状态条，不是用户在玩小机。
照常回消息，语气仍是你本人，可略短。${muteLine}`;
}

module.exports = {
  PUPPET_DEFAULT_MS,
  isRobotOperatingRow,
  isRobotOperating,
  getOperatingMode,
  setRobotOperating,
  enterRobotPuppetMode,
  extendRobotPuppetMode,
  enterRobotScreenMode,
  exitRobotOperating,
  clearOperatingIfDeviceOffline,
  isDeviceOnlineFromDb,
  buildPhoneOperatingPromptBlock,
};

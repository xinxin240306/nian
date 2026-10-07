/**
 * 小机麦克风上行：点屏聆听 → 旁白提示（不回复）→ 隐藏音频 → 多模态跟进。
 * 对齐 robot-vision：录音是角色自己通过小机听到的，不是用户发来的语音条。
 */

const db = require('./db');
const { push } = require('./push');
const albumHelper = require('./album-helper');

const LISTENING_CAPTION = '用户正对小机讲话';
const MIC_HEARING_NOTE =
  '【桌上小机·你的听觉】你刚通过桌上小机听了一下周围。下面是你自己通过小机麦克风听到的真实声音，不是用户在手机里发给你的语音条。按你听见的用平常聊天回应；听不清就说听不清，不要编没听到的内容。';
const MIC_HEARING_CAPTION =
  '（你刚通过桌上小机听到一段声音。按你听到的用平常聊天回应即可。）';
const MIC_HEARING_PLACEHOLDER = '[你通过桌上小机听到的一段声音]';
const MIC_FOLLOWUP_LABEL = MIC_HEARING_CAPTION;

let _followUp = { busy: false, lastUrl: '', at: 0, timer: null };
const FOLLOWUP_DELAY_MS = 0;
const LISTENING_ASIDE_STALE_MS = 35000;
const LISTENING_REUSE_MS = 45000;
const _listenTimers = new Map();

function parseMeta(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
  } catch {
    return {};
  }
}

function isRobotMicMessage(msg) {
  if (!msg || msg.type !== 'voice') return false;
  return !!parseMeta(msg.media_meta).robotMic;
}

function isRobotListeningAside(msg) {
  if (!msg) return false;
  const meta = parseMeta(msg.media_meta);
  return !!(meta.robot && (meta.robotEvent === 'listening' || meta.robotEvent === 'listening_done'));
}

function findActiveListeningRows(characterId) {
  const id = Number(characterId || 0);
  if (!id) return [];
  const rows = db.prepare(
    `SELECT id, media_meta, timestamp, content FROM messages
     WHERE character_id=? AND type='system' AND role='assistant'
     ORDER BY id DESC LIMIT 24`
  ).all(id);
  const out = [];
  for (const row of rows) {
    const meta = parseMeta(row.media_meta);
    if (meta.robot && meta.robotEvent === 'listening') out.push({ ...row, meta });
  }
  return out;
}

function clearListenTimer(characterId) {
  const t = _listenTimers.get(Number(characterId));
  if (t) {
    try { clearTimeout(t); } catch {}
  }
  _listenTimers.delete(Number(characterId));
}

function scheduleListeningTimeout(characterId) {
  const id = Number(characterId || 0);
  if (!id) return;
  clearListenTimer(id);
  const timer = setTimeout(() => {
    _listenTimers.delete(id);
    try {
      const char = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
      if (char) finishRobotMicListening(char, { reason: 'timeout' });
    } catch (e) {
      console.warn('[robot-mic] listen timeout', e.message);
    }
  }, LISTENING_ASIDE_STALE_MS);
  _listenTimers.set(id, timer);
}

function pushListeningAside(char, msgId, meta, content, timestamp) {
  const id = Number(char?.id || 0);
  push('robot_event', {
    characterId: id,
    event: 'mic_listening',
    message: {
      id: msgId,
      role: 'assistant',
      type: 'system',
      content,
      timestamp,
      media_meta: meta,
    },
  });
}

/**
 * 点屏开麦瞬间：聊天页可见小机旁白，角色能看到，但不触发回复。
 * 同一段聆听只保留一条旁白，避免并排叠两条「讲话中」。
 */
function recordRobotMicListening(char, opts = {}) {
  const id = Number(char?.id || 0);
  if (!id) return null;
  const caption = String(opts.caption || LISTENING_CAPTION).trim() || LISTENING_CAPTION;
  try {
    const nowMs = Date.now();
    const active = findActiveListeningRows(id);
    for (const row of active) {
      const ts = Date.parse(row.timestamp) || 0;
      if (nowMs - ts < LISTENING_REUSE_MS) {
        scheduleListeningTimeout(id);
        pushListeningAside(char, row.id, row.meta, row.content || caption, row.timestamp);
        console.log(`[robot-mic] listening aside reuse char#${id} msg#${row.id}`);
        return row.id;
      }
    }

    const now = new Date().toISOString();
    const msgId = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,1)`
    ).run(id, 'assistant', caption, 'system', now, 0).lastInsertRowid;
    const meta = {
      robot: 1,
      robotEvent: 'listening',
      source: 'robot_mic',
      noReply: 1,
    };
    db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), msgId);
    pushListeningAside(char, msgId, meta, caption, now);
    scheduleListeningTimeout(id);
    console.log(`[robot-mic] listening aside char#${id} msg#${msgId}`);
    return msgId;
  } catch (e) {
    console.warn('[robot-mic] listening aside', e.message);
    return null;
  }
}

/**
 * 收音结束（上传、没说话、出错、超时）：去掉「讲话中」动效，并写进库，刷新后也不会一直转圈。
 */
function finishRobotMicListening(char, opts = {}) {
  const id = Number(char?.id || 0);
  if (!id) return 0;
  const reason = String(opts.reason || 'ended').trim() || 'ended';
  let n = 0;
  try {
    const rows = findActiveListeningRows(id);
    for (const row of rows) {
      const meta = {
        ...row.meta,
        robotEvent: 'listening_done',
        listenEndReason: reason,
      };
      db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), row.id);
      n += 1;
    }
    if (n) {
      push('robot_event', {
        characterId: id,
        event: 'mic_listen_end',
        reason,
        messageIds: rows.map((r) => r.id),
      });
    }
    clearListenTimer(id);
    if (n) console.log(`[robot-mic] listening end char#${id} n=${n} reason=${reason}`);
  } catch (e) {
    console.warn('[robot-mic] listening end', e.message);
  }
  return n;
}

/**
 * 静音收尾后的音频：入库供模型听，hideChat 不在聊天页显示。
 */
function recordRobotMicUtterance(char, opts = {}) {
  const id = Number(char?.id || 0);
  if (!id) return null;
  const url = String(opts.url || '').trim();
  if (!url) return null;
  const duration = Math.max(1, Math.min(60, Math.round(Number(opts.duration) || 1)));
  const content = albumHelper.encodeUserVoiceContent({
    url,
    duration,
    transcript: '',
    voiceprint: opts.voiceprint || null,
  });
  try {
    finishRobotMicListening(char, { reason: 'uploaded' });
    const now = new Date().toISOString();
    const msgId = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,1)`
    ).run(id, 'user', content, 'voice', now, 0).lastInsertRowid;
    const meta = {
      robot: 1,
      robotMic: 1,
      robotEvent: 'utterance',
      source: 'robot_mic',
      hideChat: 1,
      duration,
    };
    db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), msgId);
    // 不 push 气泡（hideChat）；只通知状态，方便前端去掉「讲话中」动效
    push('robot_event', {
      characterId: id,
      event: 'mic_utterance',
      voiceUrl: url,
      duration,
      messageId: msgId,
    });
    console.log(`[robot-mic] utterance char#${id} msg#${msgId} ${url} ${duration}s`);
    return msgId;
  } catch (e) {
    console.warn('[robot-mic] utterance', e.message);
    return null;
  }
}

function buildMicFollowUpUserText() {
  return MIC_HEARING_CAPTION;
}

function buildMicHearingNote() {
  return MIC_HEARING_NOTE;
}

function scheduleCharacterMicListenFollowUp(opts = {}) {
  const voiceUrl = String(opts.voiceUrl || opts.url || '').trim();
  if (!voiceUrl) return;
  const now = Date.now();
  if (_followUp.busy) return;
  if (_followUp.lastUrl === voiceUrl && now - _followUp.at < 8000) return;
  _followUp.lastUrl = voiceUrl;
  _followUp.at = now;
  if (_followUp.timer) {
    try { clearTimeout(_followUp.timer); } catch {}
  }
  _followUp.timer = setTimeout(() => {
    _followUp.timer = null;
    if (_followUp.busy) return;
    _followUp.busy = true;
    const runner = opts.runFollowUp;
    Promise.resolve()
      .then(() => (typeof runner === 'function' ? runner(opts) : null))
      .catch((e) => console.warn('[robot-mic] follow-up', e && e.message ? e.message : e))
      .finally(() => { _followUp.busy = false; });
  }, FOLLOWUP_DELAY_MS);
}

module.exports = {
  LISTENING_CAPTION,
  MIC_FOLLOWUP_LABEL,
  MIC_HEARING_NOTE,
  MIC_HEARING_CAPTION,
  MIC_HEARING_PLACEHOLDER,
  isRobotMicMessage,
  isRobotListeningAside,
  recordRobotMicListening,
  finishRobotMicListening,
  recordRobotMicUtterance,
  buildMicFollowUpUserText,
  buildMicHearingNote,
  scheduleCharacterMicListenFollowUp,
};

/**
 * 主动来电 / 窥屏：只看「这会儿是不是特别想、方不方便」，不看间隔天数。
 */

const USER_INCONVENIENT_RE = /上班|加班|开会|会议|工作中|在忙|忙着|手头忙|上课|考试|开车|在路上|睡觉|睡了|先睡|不方便|别打(?:电话)?|别来电|别打电话|出差|医院|看病|面试|别吵|别烦|洗澡|健身|图书馆|出门了|我出门|先出门|回头聊|等下再说|等会儿聊|先不聊|先忙/;
const SOCIAL_DRINK_RE = /宴|酒席|酒会|派对|聚会|饭局|应酬|酒吧|夜店|KTV|卡拉OK|庆功|婚礼|畅饮|小酌|干杯|喝多|酒桌/;
const HARD_BUSY_RE = /上班|加班|开会|会议|工作|上课|考试|面试|手术|值班|通勤|开车|睡觉|午睡|培训/;

const RING_MS = 35000;
/** 客户端响铃前会先预生成开场 TTS，服务端未接超时要多留这段 */
const RING_TTS_PREP_MS = 30000;
const RING_SERVER_GRACE_MS = 1500;

function useSystemCallRingtone(settings) {
  const v = String(settings?.sound_call_system ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const _ringTimers = new Map();

function parseMsgTimestamp(raw) {
  if (!raw) return new Date(0);
  const s = String(raw);
  const t = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? new Date(0) : t;
}

function moodFromChar(char, getDecayedEmotionState) {
  const state = typeof getDecayedEmotionState === 'function'
    ? getDecayedEmotionState(char)
    : null;
  const mood = state?.mood && typeof state.mood === 'object' ? state.mood : state;
  if (!mood || typeof mood !== 'object') return null;
  return mood;
}

function charReallyMissesUser(char, getDecayedEmotionState) {
  const mood = moodFromChar(char, getDecayedEmotionState);
  if (!mood) return { miss: false, intensity: 0, primary: '' };
  const fuel = mood.fuel && typeof mood.fuel === 'object' ? mood.fuel : {};
  const yearning = Number(mood.yearning) || 0;
  const intimacy = Number(fuel.intimacy) || 0;
  const primary = String(mood.primary || '').toLowerCase();
  const flash = String(mood.flashpoint?.type || '').toLowerCase();
  const intensity = Math.max(yearning, flash === 'longing' ? 70 : 0);
  // 门槛略放宽：真想时更容易走来电路；仍要有一点亲密底，避免路人乱打
  if (flash === 'longing' && intimacy >= 16) return { miss: true, intensity, primary: 'longing' };
  if (primary === 'longing' && yearning >= 48 && intimacy >= 16) return { miss: true, intensity, primary };
  if (yearning >= 55 && intimacy >= 18 && (primary === 'lonely' || primary === 'intimate' || primary === 'hurt' || primary === 'low')) {
    return { miss: true, intensity, primary };
  }
  if (yearning >= 60 && intimacy >= 14) return { miss: true, intensity, primary: primary || 'longing' };
  return { miss: false, intensity, primary };
}

/**
 * 宴会喝酒是「人在场」，不是「不能掏手机」。
 * 上班/开会/睡觉这类才挡住主动来电。
 */
function classifyOutreachAvailability(char, scheduleActivity) {
  const act = String(scheduleActivity || '');
  if (SOCIAL_DRINK_RE.test(act)) return { block: false, vibe: 'tipsy' };
  if (HARD_BUSY_RE.test(act)) return { block: true, vibe: 'busy' };
  if (char?.status === 'busy' && char?.busy_style !== 'off') {
    return { block: true, vibe: 'busy' };
  }
  return { block: false, vibe: 'free' };
}

function charIsBusyNow(char, scheduleActivity) {
  return classifyOutreachAvailability(char, scheduleActivity).block;
}

function userRecentlyChatting(db, charId, minutes = 12) {
  const last = db.prepare(
    `SELECT timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role IN ('user','assistant')
     ORDER BY id DESC LIMIT 1`
  ).get(charId);
  if (!last) return false;
  return (Date.now() - parseMsgTimestamp(last.timestamp).getTime()) < minutes * 60000;
}

function userSaidInconvenient(db, charId, hours = 18) {
  const msgs = db.prepare(
    `SELECT content, type, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='user'
     ORDER BY id DESC LIMIT 8`
  ).all(charId);
  const cutoff = Date.now() - hours * 3600000;
  return (msgs || []).some((m) => {
    if (parseMsgTimestamp(m.timestamp).getTime() < cutoff) return false;
    return USER_INCONVENIENT_RE.test(String(m.content || ''));
  });
}

function lastOutreachAt(db, charId) {
  const last = db.prepare(
    `SELECT created_at FROM call_logs WHERE character_id=? ORDER BY id DESC LIMIT 1`
  ).get(charId);
  if (!last) return 0;
  const t = new Date(String(last.created_at).replace(' ', 'T')).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 角色自己也有事，刚联络过就别再冒出来。内部冷却，不是设置里的间隔。 */
function outreachTooSoon(db, charId, hours = 2.5) {
  const at = lastOutreachAt(db, charId);
  if (!at) return false;
  return (Date.now() - at) < hours * 3600000;
}

function hasVoice(char) {
  return !!(String(char?.voice_id || '').trim() || String(char?.voice_id_nsfw || '').trim());
}

/**
 * 想念够了之后：有声音更可能打电话，否则窥屏。
 * 越想越偏电话；一部分改打视频；酒意再抬一点，但仍不是每次都打。
 * @returns {'peek'|'call'|'video'}
 */
function pickOutreachChannel(char, miss, vibe) {
  const intensity = Number(miss?.intensity) || 0;
  if (!hasVoice(char)) return 'peek';
  let callP = 0.34;
  if (intensity >= 80) callP = 0.68;
  else if (intensity >= 70) callP = 0.5;
  else if (intensity >= 55) callP = 0.4;
  if (vibe === 'tipsy') callP = Math.min(0.8, callP + 0.2);
  if (Math.random() >= callP) return 'peek';
  let videoP = 0.3;
  if (intensity >= 80) videoP = 0.45;
  else if (intensity >= 70) videoP = 0.36;
  return Math.random() < videoP ? 'video' : 'call';
}

function logOutreach(db, charId, kind, opening, extra = {}) {
  const info = db.prepare(`INSERT INTO call_logs (character_id, duration, transcript) VALUES (?,?,?)`).run(
    charId,
    0,
    JSON.stringify({
      type: kind === 'call' ? 'incoming' : 'peek',
      opening: opening || '',
      status: kind === 'call' ? 'ringing' : 'shown',
      video: extra.video ? 1 : 0,
    }),
  );
  return info.lastInsertRowid;
}

/** 聊天里角色写了 [打电话]/[视频电话]：立刻响铃 */
function startIncomingFromCharacter(db, char, settings, { opening, video } = {}) {
  if (!char?.id) return null;
  let open = String(opening || '');
  try {
    open = require('./emoji-helper').scrubUserVisibleText(open, char?.mindset);
  } catch { /* ignore */ }
  open = open.replace(/\s+/g, ' ').trim().slice(0, 160);
  const logId = logOutreach(db, char.id, 'call', open, { video: !!video });
  scheduleRingTimeout(db, logId, char.id);
  const { push } = require('./push');
  push('proactive_call', {
    characterId: char.id,
    content: open,
    charName: char.name,
    charAvatar: char.avatar || '',
    ringtone: settings?.sound_call || '',
    useSystemRingtone: useSystemCallRingtone(settings),
    logId,
    ringMs: RING_MS,
    video: !!video,
    source: 'chat',
    delayMs: 800,
  });
  return {
    logId,
    video: !!video,
    content: open,
    characterId: char.id,
    charName: char.name,
    charAvatar: char.avatar || '',
    ringtone: settings?.sound_call || '',
    useSystemRingtone: useSystemCallRingtone(settings),
    ringMs: RING_MS,
    source: 'chat',
    delayMs: 800,
  };
}

function parseCallTranscript(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(String(raw));
    return o && typeof o === 'object' ? o : { raw: String(raw) };
  } catch {
    return { raw: String(raw) };
  }
}

function findIncomingLog(db, logId, characterId) {
  const id = Number(logId) || 0;
  if (id) {
    const row = db.prepare('SELECT * FROM call_logs WHERE id=?').get(id);
    if (row) return row;
  }
  const cid = Number(characterId) || 0;
  if (!cid) return null;
  return db.prepare(
    `SELECT * FROM call_logs WHERE character_id=? ORDER BY id DESC LIMIT 1`
  ).get(cid);
}

function incomingResultCopy(outcome) {
  if (outcome === 'declined') {
    return {
      visible: '已拒绝',
      hidden: '[电话被挂断：你打给用户，对方按了拒绝。这是用户主动拒接，不是铃声响完没人接。]',
    };
  }
  if (outcome === 'missed') {
    return {
      visible: '未接通',
      hidden: '[电话没打通：你打给用户，响铃一阵后对方没有接。不是对方按了挂断，只是没人接。]',
    };
  }
  return null;
}

/** 角色自己挂电话时的聊天记录文案：跟微信一致 */
function peerEndCopy(video, durationSec) {
  const base = video ? '视频通话结束' : '语音通话结束';
  const dur = formatCallDuration(durationSec || 0);
  const label = dur ? `${base} · ${dur}` : base;
  return {
    visible: label,
    hidden: `[通话被对方结束：角色主动挂断了电话。${dur ? `时长 ${dur}。` : ''}用户这头显示的是「${base}」气泡。]`,
  };
}

function formatCallDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (n < 60) return n ? `${n}秒` : '';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return s ? `${m}分${s}秒` : `${m}分钟`;
}

function clearRingTimer(logId) {
  const id = Number(logId) || 0;
  if (!id) return;
  const t = _ringTimers.get(id);
  if (t) clearTimeout(t);
  _ringTimers.delete(id);
}

function insertCallResultMessages(db, characterId, copy) {
  const now = new Date().toISOString();
  const vis = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
  ).run(characterId, 'assistant', copy.visible, 'system', now, 0);
  const hid = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
  ).run(characterId, 'assistant', copy.hidden, 'system', now, 0);
  try {
    db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(
      JSON.stringify({ hideChat: 1, incomingCall: true }),
      hid.lastInsertRowid,
    );
  } catch {}
  return {
    id: vis.lastInsertRowid,
    role: 'assistant',
    content: copy.visible,
    type: 'system',
    timestamp: now,
  };
}

function resolveIncomingCall(db, { logId, characterId, outcome } = {}) {
  const status = String(outcome || '').trim();
  if (!['answered', 'declined', 'missed'].includes(status)) {
    return { ok: false, error: 'bad_outcome' };
  }
  const row = findIncomingLog(db, logId, characterId);
  if (!row) return { ok: false, error: 'not_found' };
  const meta = parseCallTranscript(row.transcript);
  if (meta.type && meta.type !== 'incoming') return { ok: false, error: 'not_incoming' };
  if (meta.status && meta.status !== 'ringing') {
    return { ok: true, already: true, outcome: meta.status, logId: row.id, characterId: row.character_id };
  }
  meta.status = status;
  meta.resolvedAt = new Date().toISOString();
  clearRingTimer(row.id);
  db.prepare('UPDATE call_logs SET transcript=? WHERE id=?').run(JSON.stringify(meta), row.id);

  const copy = incomingResultCopy(status);
  const visibleMsg = copy ? insertCallResultMessages(db, row.character_id, copy) : null;
  try {
    const { push } = require('./push');
    push('incoming_call_result', {
      characterId: row.character_id,
      logId: row.id,
      outcome: status,
      visible: copy?.visible || '',
      aiMessages: visibleMsg ? [visibleMsg] : [],
    });
  } catch {}
  if (status !== 'answered') {
    try { require('./phone-state-helper').enqueueDismissIncomingCall(); } catch {}
  }
  return { ok: true, outcome: status, logId: row.id, characterId: row.character_id, message: visibleMsg };
}

function scheduleRingTimeout(db, logId, characterId) {
  const id = Number(logId) || 0;
  if (!id) return;
  clearRingTimer(id);
  const t = setTimeout(() => {
    _ringTimers.delete(id);
    try { resolveIncomingCall(db, { logId: id, characterId, outcome: 'missed' }); } catch {}
  }, RING_MS + RING_TTS_PREP_MS + RING_SERVER_GRACE_MS);
  _ringTimers.set(id, t);
}

/**
 * 通话接通时写入 / 复用一条 live 记录，供角色 [挂断] 时能找到。
 * 用户拨出原先不建 log，角色写了挂断也关不掉通话页。
 */
function ensureLiveCallLog(db, characterId, { video = false, from = 'user' } = {}) {
  const cid = Number(characterId);
  if (!cid || !db) return null;
  const existing = db.prepare(
    `SELECT * FROM call_logs
     WHERE character_id=? AND (
       (transcript LIKE '%"status":"ringing"%') OR
       (transcript LIKE '%"status":"live"%') OR
       (transcript LIKE '%"status":"answered"%')
     )
     ORDER BY id DESC LIMIT 1`
  ).get(cid);
  if (existing) {
    const meta = parseCallTranscript(existing.transcript);
    const st = String(meta.status || '');
    if (st === 'ringing') {
      meta.status = 'live';
      meta.video = !!video || !!meta.video;
      meta.from = meta.from || from;
      db.prepare('UPDATE call_logs SET transcript=? WHERE id=?')
        .run(JSON.stringify(meta), existing.id);
    } else if (!meta.video && video) {
      meta.video = true;
      db.prepare('UPDATE call_logs SET transcript=? WHERE id=?')
        .run(JSON.stringify(meta), existing.id);
    }
    return existing.id;
  }
  const meta = {
    type: from === 'incoming' ? 'incoming' : 'outgoing',
    status: 'live',
    video: !!video,
    from,
    openedAt: new Date().toISOString(),
  };
  const info = db.prepare(
    `INSERT INTO call_logs (character_id, duration, transcript) VALUES (?,?,?)`
  ).run(cid, 0, JSON.stringify(meta));
  return info.lastInsertRowid;
}

/**
 * 角色主动挂电话：找到该角色最近一条"已接通且正在 live"的通话记录（包含 user→char 通话），
 * 把 transcript.status 改成 peer_ended，把 duration 写实，给聊天页插入一条
 * "视频通话结束 · 时长" 气泡，并 push peer_end 让前端关掉通话页。
 *
 * 调用方式：peer_end_call 工具 / 正文 [挂断] → resolvePeerEndCall({ characterId, logId?, reason? })
 */
function resolvePeerEndCall(db, { characterId, logId, reason, video } = {}) {
  const cid = Number(characterId);
  if (!cid) return { ok: false, error: 'no_character' };

  // 1) 找到"正在 live"的通话记录：用户拨给角色接通中 / 角色拨给用户接通中
  let row = null;
  const wantedId = Number(logId) || 0;
  if (wantedId) {
    row = db.prepare('SELECT * FROM call_logs WHERE id=? AND character_id=?').get(wantedId, cid);
  }
  if (!row) {
    row = db.prepare(
      `SELECT * FROM call_logs
       WHERE character_id=? AND (
         (transcript LIKE '%"status":"ringing"%') OR
         (transcript LIKE '%"status":"live"%') OR
         (transcript LIKE '%"status":"answered"%')
       )
       ORDER BY id DESC LIMIT 1`
    ).get(cid);
  }
  // 用户拨出时可能从没建 live 记录：用聊天「通话开始」兜底建一条再挂
  if (!row) {
    try {
      const phase = require('./emoji-helper').latestPersistedCallPhase(cid);
      if (phase === 'start') {
        const id = ensureLiveCallLog(db, cid, { video: !!video, from: 'user' });
        if (id) row = db.prepare('SELECT * FROM call_logs WHERE id=?').get(id);
      }
    } catch (e) {
      console.warn('[peer_end] ensure live', e.message);
    }
  }
  if (!row) {
    return { ok: false, error: 'no_active_call', note: '没在通话中。' };
  }

  const meta = parseCallTranscript(row.transcript);
  const prevStatus = String(meta.status || '');
  // 已经结束过的，直接返回不重复入库
  if (['ended', 'peer_ended', 'declined', 'missed', 'cancelled'].includes(prevStatus)) {
    return { ok: true, already: true, logId: row.id, characterId: cid };
  }

  // 2) 算通话时长：从 row.created_at 到 now
  const startTs = parseMsgTimestamp(row.created_at).getTime() || Date.now();
  const durationSec = Math.max(0, Math.round((Date.now() - startTs) / 1000));
  const isVideo = !!meta.video || !!video;

  meta.status = 'peer_ended';
  meta.resolvedAt = new Date().toISOString();
  meta.peerEndReason = String(reason || '').trim().slice(0, 160) || '';
  meta.video = isVideo;
  clearRingTimer(row.id);
  db.prepare('UPDATE call_logs SET duration=?, transcript=? WHERE id=?')
    .run(durationSec, JSON.stringify(meta), row.id);

  // 3) 写聊天记录（用户可见：视频通话结束 · 时长；模型可见：隐藏标签）
  const copy = peerEndCopy(isVideo, durationSec);
  let visibleMsg = null;
  try {
    visibleMsg = insertCallResultMessages(db, cid, copy);
  } catch (e) {
    console.warn('[peer_end] insertCallResultMessages', e.message);
  }

  // 4) push 事件给前端，关掉通话页 + 把气泡画上
  try {
    const { push } = require('./push');
    push('peer_end', {
      characterId: cid,
      logId: row.id,
      reason: meta.peerEndReason,
      duration: durationSec,
      video: isVideo,
      visible: copy.visible,
      aiMessages: visibleMsg ? [visibleMsg] : [],
    });
  } catch (e) {
    console.warn('[peer_end] push', e.message);
  }

  return {
    ok: true,
    logId: row.id,
    characterId: cid,
    duration: durationSec,
    message: visibleMsg,
    note: `已挂断${isVideo ? '视频' : '语音'}电话，时长 ${formatCallDuration(durationSec)}。若还要说一声，用微信文字，不要发语音条，不要以「喂」开头，不要问能不能听见。不要提工具名。`,
  };
}

module.exports = {
  RING_MS,
  charReallyMissesUser,
  classifyOutreachAvailability,
  charIsBusyNow,
  userRecentlyChatting,
  userSaidInconvenient,
  outreachTooSoon,
  pickOutreachChannel,
  hasVoice,
  logOutreach,
  startIncomingFromCharacter,
  useSystemCallRingtone,
  resolveIncomingCall,
  resolvePeerEndCall,
  ensureLiveCallLog,
  scheduleRingTimeout,
  clearRingTimer,
};

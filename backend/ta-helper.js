/**
 * TA 情侣应用：单角色绑定、解绑、注入块、低电/关机事件。
 */
const db = require('./db');

const SETTING_CHAR = 'ta_character_id';
const SETTING_SHARE_USAGE = 'ta_share_usage';
const SETTING_BATTERY_ALERT = 'ta_battery_alert';
const SETTING_EVENTS = 'ta_phone_events';
const SETTING_OFFLINE_FLAG = 'ta_phone_was_online';
const SETTING_LOWBAT_AT = 'ta_lowbat_notified_at';
const SETTING_OFFLINE_AT = 'ta_offline_notified_at';

const MAX_EVENTS = 40;
const LOWBAT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const OFFLINE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function getSettingsMap() {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
}

function getSetting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row?.value != null ? String(row.value) : fallback;
  } catch {
    return fallback;
  }
}

function boundCharacterId() {
  const n = parseInt(getSetting(SETTING_CHAR, '0'), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isBoundCharacter(characterId) {
  const bid = boundCharacterId();
  return !!bid && Number(characterId) === bid;
}

function shareUsageOn() {
  return getSetting(SETTING_SHARE_USAGE, '0') === '1';
}

function setShareUsage(on) {
  setSetting(SETTING_SHARE_USAGE, on ? '1' : '0');
  return shareUsageOn();
}

function batteryAlertOn() {
  return getSetting(SETTING_BATTERY_ALERT, '0') === '1';
}

function setBatteryAlert(on) {
  setSetting(SETTING_BATTERY_ALERT, on ? '1' : '0');
  return batteryAlertOn();
}

function loadChar(id) {
  const cid = Number(id) || 0;
  if (!cid) return null;
  try {
    return db.prepare(
      `SELECT id, name, avatar, anniversary, birthday, relationship, relationship_custom,
              nicknames, mood, emotion_state, location_name, real_location,
              home_address, real_home_address, timezone, home_environment, schedule_week_plan
       FROM characters WHERE id=?`
    ).get(cid) || null;
  } catch {
    return null;
  }
}

function parseEvents() {
  try {
    const raw = getSetting(SETTING_EVENTS, '[]');
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveEvents(list) {
  setSetting(SETTING_EVENTS, JSON.stringify((list || []).slice(0, MAX_EVENTS)));
}

function pushPhoneEvent(type, note, extra = {}) {
  const list = parseEvents();
  list.unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: String(type || 'info'),
    note: String(note || '').slice(0, 200),
    at: new Date().toISOString(),
    ...extra,
  });
  saveEvents(list.slice(0, MAX_EVENTS));
  return list[0];
}

function bindCharacter(characterId) {
  const cid = Number(characterId) || 0;
  if (!cid) return { ok: false, error: 'no_char' };
  const char = loadChar(cid);
  if (!char) return { ok: false, error: 'not_found' };
  setSetting(SETTING_CHAR, String(cid));
  // 识屏优先角色与 TA 绑定对齐
  try {
    db.prepare('UPDATE characters SET screen_chat_priority=0').run();
    db.prepare('UPDATE characters SET screen_chat_priority=1 WHERE id=?').run(cid);
  } catch (e) {
    console.warn('[ta] screen_chat_priority', e.message);
  }
  try {
    require('./push').push('ta_bound', { characterId: cid, charName: char.name });
  } catch {}
  return { ok: true, characterId: cid, character: char };
}

function unbind({ by = 'user', characterId = 0 } = {}) {
  const prev = boundCharacterId();
  if (!prev) return { ok: true, characterId: 0 };
  if (by === 'char' && characterId && Number(characterId) !== prev) {
    return { ok: false, error: 'not_bound', note: '你没有和对方绑定 TA，解不了。' };
  }
  setSetting(SETTING_CHAR, '0');
  setShareUsage(false);
  setBatteryAlert(false);
  try {
    db.prepare('UPDATE characters SET screen_chat_priority=0 WHERE id=?').run(prev);
  } catch {}
  try {
    require('./push').push('ta_unbound', { characterId: prev, by });
  } catch {}
  return { ok: true, characterId: 0, previousId: prev, by };
}

function recentMemoPreview(characterId) {
  try {
    const book = db.prepare(
      'SELECT id FROM shared_memo_books WHERE character_id=? ORDER BY id DESC LIMIT 1'
    ).get(characterId);
    if (!book) return '';
    const entry = db.prepare(
      `SELECT role, content, created_at FROM shared_memo_entries
       WHERE book_id=? ORDER BY id DESC LIMIT 1`
    ).get(book.id);
    if (!entry) return '随手记还是空的。';
    const who = entry.role === 'assistant' ? '你' : '对方';
    const text = String(entry.content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return text ? `${who}最近写过：${text}` : '随手记里有新动静。';
  } catch {
    return '';
  }
}

/** 给绑定角色注入的短块：只含 TA 里能看见的事 */
function buildTaPromptBlock(characterId) {
  if (!isBoundCharacter(characterId)) return '';
  const char = loadChar(characterId);
  if (!char) return '';
  const lines = ['【TA】你们在「TA」里绑着。这些是 App 里能看到的，不是全知。提不提按性格，不要提工具名或「TA App」。若要解除绑定，可用工具或在回复里写【解绑TA】（用户看不到标记）。'];
  try {
    const aff = require('./affection-helper').getBrainAffection(characterId);
    if (aff) {
      if (aff.stageLabel) lines.push(`感情阶段：${aff.stageLabel}`);
      if (aff.kind === 'romantic' && aff.daysTogether) lines.push(`在一起约 ${aff.daysTogether} 天`);
      if (aff.settledNicks?.length) lines.push(`日常称呼：${aff.settledNicks.slice(0, 4).join('、')}`);
    }
  } catch {}
  if (char.anniversary) lines.push(`纪念日：${String(char.anniversary).slice(0, 10)}`);
  const memo = recentMemoPreview(characterId);
  if (memo) lines.push(memo);
  if (shareUsageOn()) {
    lines.push('对方开了「互相看使用时长」。想看今天刷了多久可用工具；你自己那边的时长也在 TA 里。');
  }
  try {
    const letterBlock = require('./letter-helper').promptBlockForChar(characterId);
    if (letterBlock) lines.push(letterBlock);
  } catch {}
  // 哆啦邮局提示改由 buildSystemPrompt 统一注入，避免重复
  if (batteryAlertOn()) {
    const events = parseEvents().slice(0, 3);
    for (const ev of events) {
      if (ev.type === 'low_battery') lines.push(`【TA·电量提醒】${ev.note}`);
      else if (ev.type === 'offline') lines.push(`【TA·电量提醒】${ev.note}`);
    }
  }
  return lines.join('\n');
}

function publicSnapshot() {
  const cid = boundCharacterId();
  const char = cid ? loadChar(cid) : null;
  let affection = null;
  let mood = null;
  let presence = { asleep: false, activity: '' };
  if (char) {
    try { affection = require('./affection-helper').getBrainAffection(cid); } catch {}
    try {
      const emotionHelper = require('./emotion-helper');
      let state = null;
      try {
        const raw = char.emotion_state;
        state = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      } catch { state = null; }
      if (state?.mood) mood = emotionHelper.publicMoodView(state.mood, char);
      else if (char.mood) mood = { display: char.mood, primary: '', label: '' };
    } catch {
      if (char.mood) mood = { display: char.mood, primary: '', label: '' };
    }
    try {
      const cron = require('./cron');
      presence = cron.resolveCallCharAsleepOnLine(cid) || presence;
    } catch { /* ignore */ }
  }
  // 行程在睡觉时，小组件/对外展示应跟「睡觉」对齐，不要还亮平静微笑豆
  if (presence?.asleep) {
    const base = mood && typeof mood === 'object' ? mood : {};
    mood = {
      ...base,
      primary: 'tired',
      label: '睡觉',
      display: '😴',
      emoji: '😴',
      bean: '睡着',
      asleep: true,
      activity: String(presence.activity || '').slice(0, 40),
    };
  } else if (mood && typeof mood === 'object') {
    try {
      const dayMood = require('./day-mood-helper');
      const bean = dayMood.beanFromPrimary?.(mood.primary) || '';
      if (bean) mood = { ...mood, bean, asleep: false, activity: String(presence.activity || '').slice(0, 40) };
      else mood = { ...mood, asleep: false, activity: String(presence.activity || '').slice(0, 40) };
    } catch {
      mood = { ...mood, asleep: false, activity: String(presence.activity || '').slice(0, 40) };
    }
  }
  let usage = null;
  if (shareUsageOn() && cid) {
    try {
      usage = require('./ta-usage-helper').getMutualUsage(cid);
    } catch (e) {
      usage = { ok: false, error: e.message };
    }
  }
  let memoBook = null;
  if (cid) {
    try {
      const sharedMemo = require('./shared-memo-helper');
      const books = sharedMemo.listSharedMemoBooks() || [];
      memoBook = books.find((b) => Number(b.character_id) === cid) || null;
      if (!memoBook) {
        const row = db.prepare(
          'SELECT id, title, character_id, cover, created_at FROM shared_memo_books WHERE character_id=? ORDER BY id DESC LIMIT 1'
        ).get(cid);
        if (row) {
          memoBook = {
            ...row,
            entry_count: 0,
            last_at: row.created_at || '',
            last_preview: '',
          };
        }
      }
    } catch {}
  }
  let mailbox = null;
  if (cid) {
    try { mailbox = require('./letter-helper').snapshotForTa(cid); } catch {}
  }
  let album = null;
  if (cid) {
    try { album = require('./ta-album-helper').snapshotForTa(cid); } catch {}
  }
  let studioAlbum = null;
  if (cid) {
    try { studioAlbum = require('./photostudio-helper').snapshotStudioAlbum(cid); } catch {}
  }
  return {
    characterId: cid,
    shareUsage: shareUsageOn(),
    batteryAlert: batteryAlertOn(),
    mailbox,
    album,
    studioAlbum,
    character: char,
    affection: affection
      ? {
          stageLabel: affection.stageLabel,
          stage: affection.stage,
          kind: affection.kind,
          daysTogether: affection.daysTogether,
          daysKnown: affection.daysKnown,
          favor: affection.favor,
          disappointment: affection.disappointment,
          settledNicks: affection.settledNicks || [],
          settled: affection.settled || [],
          togetherSince: affection.togetherSince || '',
        }
      : null,
    mood,
    presence,
    usage,
    memoBook,
    events: batteryAlertOn() ? parseEvents().slice(0, 20) : [],
    anniversary: char?.anniversary || '',
  };
}

/** 低电 / 关机失联：仅在「电量通知」打开时写入事件 + 供提示词 */
function tickPhoneAlerts() {
  const cid = boundCharacterId();
  if (!cid || !batteryAlertOn()) return { notified: false };
  let state;
  try { state = require('./phone-state-helper'); } catch { return { notified: false }; }

  const reachable = !!state.phoneReachable?.();
  const wasOnline = getSetting(SETTING_OFFLINE_FLAG, '0') === '1';

  if (reachable) {
    setSetting(SETTING_OFFLINE_FLAG, '1');
    try {
      const st = state.statusResult?.() || {};
      const bat = Number(st.battery);
      if (Number.isFinite(bat) && bat <= 10 && !st.charging) {
        const last = parseInt(getSetting(SETTING_LOWBAT_AT, '0'), 10) || 0;
        if (Date.now() - last > LOWBAT_COOLDOWN_MS) {
          setSetting(SETTING_LOWBAT_AT, String(Date.now()));
          pushPhoneEvent('low_battery', `对方手机电量大约只剩 ${Math.round(bat)}%`);
          return { notified: true, type: 'low_battery', characterId: cid };
        }
      }
    } catch {}
    return { notified: false };
  }

  // 失联：曾经在线，现在不可达
  if (wasOnline) {
    const last = parseInt(getSetting(SETTING_OFFLINE_AT, '0'), 10) || 0;
    if (Date.now() - last > OFFLINE_COOLDOWN_MS) {
      setSetting(SETTING_OFFLINE_AT, String(Date.now()));
      setSetting(SETTING_OFFLINE_FLAG, '0');
      pushPhoneEvent('offline', '对方手机好像关机了，或很久没连上念');
      return { notified: true, type: 'offline', characterId: cid };
    }
  }
  return { notified: false };
}

/** 角色工具：读 TA 摘要 */
function toolStatus(characterId) {
  if (!isBoundCharacter(characterId)) {
    return { ok: false, bound: false, note: '你们没有在 TA 里绑定。不要假装看见情侣信息。' };
  }
  const snap = publicSnapshot();
  return {
    ok: true,
    bound: true,
    characterName: snap.character?.name || '',
    affection: snap.affection,
    anniversary: snap.anniversary,
    mood: snap.mood ? { display: snap.mood.display || snap.mood.emoji || '' } : null,
    shareUsage: snap.shareUsage,
    batteryAlert: snap.batteryAlert,
    memoHint: recentMemoPreview(characterId),
    recentEvents: snap.batteryAlert
      ? (snap.events || []).slice(0, 5).map((e) => ({ type: e.type, note: e.note, at: e.at }))
      : [],
    note: '这是 TA 里能看到的。怎么反应按性格，不要提工具名。',
  };
}

function toolUnbind(characterId) {
  const r = unbind({ by: 'char', characterId });
  if (!r.ok) return { ok: false, ...r };
  return { ok: true, unbound: true, note: '已从 TA 解绑。之后看不到情侣信息了。用你自己的口吻说一声即可。' };
}

/** 从角色回复里剥 【解绑TA】 */
function stripUnbindMarker(text) {
  const raw = String(text || '');
  const hit = /【\s*解绑\s*TA\s*】|\[\s*解绑\s*TA\s*\]/i.test(raw);
  const cleaned = raw.replace(/【\s*解绑\s*TA\s*】|\[\s*解绑\s*TA\s*\]/gi, '').trim();
  return { hit, text: cleaned };
}

/** 从角色回复里剥 【解绑TA】并执行解绑 */
function applyUnbindFromAiContent(characterId, text) {
  const { hit, text: cleaned } = stripUnbindMarker(text);
  if (hit) unbind({ by: 'char', characterId });
  return { hit, content: cleaned };
}

module.exports = {
  SETTING_CHAR,
  SETTING_SHARE_USAGE,
  SETTING_BATTERY_ALERT,
  boundCharacterId,
  isBoundCharacter,
  shareUsageOn,
  setShareUsage,
  batteryAlertOn,
  setBatteryAlert,
  bindCharacter,
  unbind,
  buildTaPromptBlock,
  publicSnapshot,
  tickPhoneAlerts,
  toolStatus,
  toolUnbind,
  stripUnbindMarker,
  applyUnbindFromAiContent,
  pushPhoneEvent,
  parseEvents,
};

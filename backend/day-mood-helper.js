/**
 * 日历日心情小黄豆：角色（睡前整理自动）+ 用户（手动）
 */
const db = require('./db');
const { isKnownBean } = require('./inline-emoji-helper');

const PRIMARY_TO_BEAN = {
  calm: '微笑',
  happy: '愉快',
  warm: '给心',
  low: '委屈',
  hurt: '落泪',
  angry: '生气',
  anxious: '汗',
  lonely: '月亮',
  tired: '睡着',
  excited: '呲牙',
  bitter: '嫌弃',
  longing: '月亮',
  desire: '色',
  intimate: '亲',
};

const FALLBACK_BEAN = '微笑';

function scheduleDateStr(date) {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) return String(date);
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m || m < 1 || m > 12) return null;
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

function normalizeBeanCode(code) {
  const c = String(code || '').trim().replace(/^\[|\]$/g, '');
  if (!c || !isKnownBean(c)) return '';
  return c;
}

function beanFromPrimary(primary) {
  const key = String(primary || '').trim().toLowerCase();
  const code = PRIMARY_TO_BEAN[key] || FALLBACK_BEAN;
  return normalizeBeanCode(code) || FALLBACK_BEAN;
}

function rowToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    owner: row.owner,
    characterId: row.character_id == null ? null : Number(row.character_id),
    emojiCode: row.emoji_code,
    source: row.source || 'user',
    note: row.note || '',
    updatedAt: row.updated_at || '',
  };
}

function getCharMood(characterId, dateStr) {
  const row = db.prepare(
    `SELECT * FROM day_mood_stickers WHERE owner='char' AND character_id=? AND date=?`
  ).get(Number(characterId), dateStr);
  return rowToPublic(row);
}

function getUserMood(dateStr) {
  const row = db.prepare(
    `SELECT * FROM day_mood_stickers WHERE owner='user' AND date=?`
  ).get(dateStr);
  return rowToPublic(row);
}

function listMonthMoods({ year, month, characterId }) {
  const range = monthRange(year, month);
  if (!range) return { days: {}, error: '无效年月' };
  const days = {};
  const userRows = db.prepare(
    `SELECT * FROM day_mood_stickers WHERE owner='user' AND date>=? AND date<=?`
  ).all(range.start, range.end);
  for (const row of userRows) {
    if (!days[row.date]) days[row.date] = {};
    days[row.date].user = rowToPublic(row);
  }
  const cid = Number(characterId) || 0;
  if (cid) {
    const charRows = db.prepare(
      `SELECT * FROM day_mood_stickers WHERE owner='char' AND character_id=? AND date>=? AND date<=?`
    ).all(cid, range.start, range.end);
    for (const row of charRows) {
      if (!days[row.date]) days[row.date] = {};
      days[row.date].char = rowToPublic(row);
    }
  }
  return { year: Number(year), month: Number(month), characterId: cid || null, days };
}

function upsertUserMood(dateStr, emojiCode, { note = '' } = {}) {
  const date = scheduleDateStr(dateStr);
  const code = normalizeBeanCode(emojiCode);
  if (!code) return { error: '无效的小黄豆' };
  const existing = db.prepare(`SELECT id FROM day_mood_stickers WHERE owner='user' AND date=?`).get(date);
  if (existing) {
    db.prepare(
      `UPDATE day_mood_stickers SET emoji_code=?, source='user', note=?, updated_at=datetime('now') WHERE id=?`
    ).run(code, String(note || '').slice(0, 120), existing.id);
    return { ok: true, mood: getUserMood(date) };
  }
  db.prepare(
    `INSERT INTO day_mood_stickers (date, owner, character_id, emoji_code, source, note)
     VALUES (?, 'user', NULL, ?, 'user', ?)`
  ).run(date, code, String(note || '').slice(0, 120));
  return { ok: true, mood: getUserMood(date) };
}

function upsertCharMood(characterId, dateStr, emojiCode, {
  source = 'auto',
  note = '',
  overwriteUserEdit = false,
} = {}) {
  const cid = Number(characterId);
  if (!cid) return { error: '缺少 characterId' };
  const date = scheduleDateStr(dateStr);
  const code = normalizeBeanCode(emojiCode);
  if (!code) return { error: '无效的小黄豆' };
  const existing = db.prepare(
    `SELECT * FROM day_mood_stickers WHERE owner='char' AND character_id=? AND date=?`
  ).get(cid, date);
  if (existing) {
    if (source === 'auto' && existing.source === 'user' && !overwriteUserEdit) {
      return { ok: true, skipped: true, mood: rowToPublic(existing) };
    }
    db.prepare(
      `UPDATE day_mood_stickers SET emoji_code=?, source=?, note=?, updated_at=datetime('now') WHERE id=?`
    ).run(code, source === 'user' ? 'user' : 'auto', String(note || '').slice(0, 120), existing.id);
    return { ok: true, mood: getCharMood(cid, date) };
  }
  db.prepare(
    `INSERT INTO day_mood_stickers (date, owner, character_id, emoji_code, source, note)
     VALUES (?, 'char', ?, ?, ?, ?)`
  ).run(date, cid, code, source === 'user' ? 'user' : 'auto', String(note || '').slice(0, 120));
  return { ok: true, mood: getCharMood(cid, date) };
}

function deleteMood({ owner, date, characterId }) {
  const dateStr = scheduleDateStr(date);
  if (owner === 'user') {
    db.prepare(`DELETE FROM day_mood_stickers WHERE owner='user' AND date=?`).run(dateStr);
    return { ok: true };
  }
  if (owner === 'char') {
    const cid = Number(characterId);
    if (!cid) return { error: '缺少 characterId' };
    db.prepare(`DELETE FROM day_mood_stickers WHERE owner='char' AND character_id=? AND date=?`).run(cid, dateStr);
    return { ok: true };
  }
  return { error: '无效 owner' };
}

/** 从当日情绪日志推断小黄豆 */
function inferBeanFromEmotionLogs(characterId, dateStr) {
  const rows = db.prepare(
    `SELECT primary_tag, valence, arousal, label, ts FROM emotion_logs
     WHERE character_id=? AND substr(ts,1,10)=?
     ORDER BY id DESC LIMIT 24`
  ).all(Number(characterId), dateStr);
  if (!rows.length) return null;
  const counts = {};
  for (const r of rows) {
    const tag = String(r.primary_tag || '').trim() || 'calm';
    counts[tag] = (counts[tag] || 0) + 1;
  }
  let best = 'calm';
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) { best = k; bestN = n; }
  }
  // 若最近一条情绪更极端，优先用最近
  const latest = rows[0];
  const latestTag = String(latest?.primary_tag || '').trim();
  const v = Number(latest?.valence) || 0;
  if (latestTag && (Math.abs(v) >= 25 || bestN <= 1)) best = latestTag;
  return beanFromPrimary(best);
}

/** 从记忆点标题粗映射（无 LLM） */
function inferBeanFromPointTitles(titles) {
  const blob = (titles || []).join(' ');
  if (!blob) return null;
  if (/吵|怒|生气|发火|怼|骂/.test(blob)) return beanFromPrimary('angry');
  if (/哭|委屈|难过|分手|冷战|伤害/.test(blob)) return beanFromPrimary('hurt');
  if (/想你|思念|挂念|好久不见/.test(blob)) return beanFromPrimary('longing');
  if (/累|疲惫|睡|加班|熬夜/.test(blob)) return beanFromPrimary('tired');
  if (/开[心心]|哈哈|愉快|约会|表白|拥抱|亲/.test(blob)) return beanFromPrimary('happy');
  if (/忐忑|紧张|担心|焦虑/.test(blob)) return beanFromPrimary('anxious');
  if (/孤单|一个人|寂寞/.test(blob)) return beanFromPrimary('lonely');
  return beanFromPrimary('calm');
}

/**
 * 睡前整理后：为角色当天贴一颗心情豆（不覆盖用户手动改过的角色贴）
 */
function autoStickCharDayMood(characterId, dateStr, { pointTitles = [] } = {}) {
  const cid = Number(characterId);
  const date = scheduleDateStr(dateStr);
  if (!cid || !date) return { skipped: true, reason: 'bad_args' };

  let code = inferBeanFromEmotionLogs(cid, date);
  if (!code) code = inferBeanFromPointTitles(pointTitles);
  if (!code) code = FALLBACK_BEAN;
  code = normalizeBeanCode(code) || FALLBACK_BEAN;

  return upsertCharMood(cid, date, code, {
    source: 'auto',
    note: pointTitles.slice(0, 3).join(' · ').slice(0, 120),
  });
}

module.exports = {
  PRIMARY_TO_BEAN,
  scheduleDateStr,
  normalizeBeanCode,
  beanFromPrimary,
  listMonthMoods,
  getCharMood,
  getUserMood,
  upsertUserMood,
  upsertCharMood,
  deleteMood,
  inferBeanFromEmotionLogs,
  inferBeanFromPointTitles,
  autoStickCharDayMood,
};

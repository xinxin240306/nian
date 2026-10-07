/**
 * 用户明确要求 + 角色当面答应 → 落成可执行约束。
 * 只嘴上要求、角色没答应：不落库。
 * 用于：聊天注入、日程睡眠点、生活补全。
 */
const db = require('./db');

const USER_ASK_RE = /(?:不许|不要|别再|别要|别|少|禁止|从现在起?|以后|往后|答应我|你要|你得|你该|给我|说好).{0,30}(?:通宵|熬夜|晚睡|早睡|睡觉|那样|这样|再干|再这么|太累)|(?:你|给我).{0,6}(?:早点睡|好好休息|早睡|好好睡觉|今晚早[点]?睡)|不要太晚睡|不许熬夜|别熬夜|别通宵|不要那样|别那样|不要这样|别这样/;
const AGREE_RE = /好的?|行啊?|行吧|嗯+|哦+|知道了|记下了|答应|听你的|依你|随你|遵命|不熬了|今晚早睡|不会再熬|不会了|下次注意|记住了|得嘞|成|妥|照做|我改|我听/;
const REFUSE_RE = /但是|可是|才不要|偏不|再说吧|看情况|管不着|随缘|无所谓|做不到|很难|才不|休想|做梦/;
const RELEASE_ASK_RE = /(?:算了|不用了|随你|你想|可以熬|通宵也行|晚睡也行|不用早睡|别管作息)/;
const SLEEP_TOPIC_RE = /通宵|熬夜|晚睡|早睡|早点睡|睡觉|作息|几点睡|别太晚/;

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS char_promises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      kind TEXT DEFAULT 'general',
      content TEXT NOT NULL,
      user_ask TEXT DEFAULT '',
      char_reply TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      source_user_msg_id INTEGER,
      source_assistant_msg_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_char_promises_active
      ON char_promises(character_id, active, kind);
  `);
}

function localToday(tz = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function getMsg(id) {
  if (!id) return null;
  try {
    return db.prepare('SELECT id, role, content FROM messages WHERE id=?').get(Number(id));
  } catch {
    return null;
  }
}

function latestUserBefore(charId, beforeId) {
  try {
    if (beforeId) {
      return db.prepare(
        `SELECT id, content FROM messages
         WHERE character_id=? AND role='user' AND COALESCE(is_dream,0)=0 AND COALESCE(recalled,0)=0
         AND id < ? AND (type IS NULL OR type NOT IN ('system'))
         ORDER BY id DESC LIMIT 1`
      ).get(Number(charId), Number(beforeId));
    }
    return db.prepare(
      `SELECT id, content FROM messages
       WHERE character_id=? AND role='user' AND COALESCE(is_dream,0)=0 AND COALESCE(recalled,0)=0
       AND (type IS NULL OR type NOT IN ('system'))
       ORDER BY id DESC LIMIT 1`
    ).get(Number(charId));
  } catch {
    return null;
  }
}

function scrub(text) {
  return String(text || '')
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeUserAsk(text) {
  const t = scrub(text);
  if (t.length < 2 || t.length > 200) return false;
  return USER_ASK_RE.test(t);
}

function looksLikeAgree(text) {
  const t = scrub(text);
  if (!t || t.length > 400) return false;
  if (REFUSE_RE.test(t) && !/虽然|不过还是|但还是会|可我还是听/.test(t)) return false;
  // 短答应或明确改口
  if (AGREE_RE.test(t)) return true;
  return false;
}

function looksLikeReleaseAsk(text) {
  return RELEASE_ASK_RE.test(scrub(text));
}

function classifyKind(userText) {
  const t = scrub(userText);
  if (SLEEP_TOPIC_RE.test(t)) return 'sleep';
  if (/不许|不要|别再|别|禁止/.test(t)) return 'avoid';
  return 'general';
}

function summarizeContent(kind, userText, assistantText) {
  const u = scrub(userText).slice(0, 48);
  const a = scrub(assistantText).slice(0, 36);
  if (kind === 'sleep') {
    if (/通宵|熬夜/.test(u + a)) return '答应对方：不再通宵熬夜，尽量早点睡';
    if (/早睡|早点睡|睡觉/.test(u + a)) return '答应对方：早点睡、别太晚睡';
    return `答应对方作息要求：${u}`;
  }
  if (kind === 'avoid') return `答应对方不做：${u}`;
  return `答应对方：${u}`;
}

function similarActive(charId, content) {
  const rows = listActive(charId);
  const c = scrub(content);
  return rows.find((r) => scrub(r.content) === c || (c.length >= 8 && scrub(r.content).includes(c.slice(0, 8))));
}

function listActive(charId, kind = '') {
  ensureTable();
  try {
    if (kind) {
      return db.prepare(
        `SELECT * FROM char_promises WHERE character_id=? AND active=1 AND kind=? ORDER BY id DESC LIMIT 20`
      ).all(Number(charId), kind);
    }
    return db.prepare(
      `SELECT * FROM char_promises WHERE character_id=? AND active=1 ORDER BY id DESC LIMIT 20`
    ).all(Number(charId));
  } catch {
    return [];
  }
}

function activeSleepConstraint(charId) {
  const rows = listActive(charId, 'sleep');
  return rows[0] || null;
}

function deactivateKind(charId, kind, reason = '') {
  ensureTable();
  db.prepare(
    `UPDATE char_promises SET active=0, updated_at=datetime('now')
     WHERE character_id=? AND active=1 AND kind=?`
  ).run(Number(charId), kind);
  if (reason) console.log(`[promise] deactivate char#${charId} kind=${kind} ${reason}`);
}

function insertPromise(charId, row) {
  ensureTable();
  const content = String(row.content || '').trim().slice(0, 120);
  if (!content) return null;
  if (similarActive(charId, content)) return similarActive(charId, content);
  // 同类作息约束只保留最新一条有效
  if (row.kind === 'sleep') deactivateKind(charId, 'sleep', 'replaced');
  const info = db.prepare(
    `INSERT INTO char_promises
      (character_id, kind, content, user_ask, char_reply, active, source_user_msg_id, source_assistant_msg_id)
     VALUES (?,?,?,?,?,1,?,?)`
  ).run(
    Number(charId),
    String(row.kind || 'general').slice(0, 16),
    content,
    String(row.user_ask || '').slice(0, 160),
    String(row.char_reply || '').slice(0, 160),
    row.source_user_msg_id || null,
    row.source_assistant_msg_id || null,
  );
  const id = info.lastInsertRowid;
  try {
    require('./memory-brain-helper').insertMemory({
      characterId: Number(charId),
      category: '约定',
      content: content,
      weight: 0.9,
      date: localToday(),
      source: 'promise',
      keywords: ['答应', '约定', row.kind === 'sleep' ? '作息' : '要求'].filter(Boolean),
      meta: { promise_id: id, kind: row.kind },
    });
  } catch (e) {
    console.warn('[promise] memory', e.message);
  }
  console.log(`[promise] char#${charId} ${row.kind}: ${content}`);
  return db.prepare('SELECT * FROM char_promises WHERE id=?').get(id);
}

/**
 * 在助手回复落库后调用：必须同时有「用户要求」和「角色答应」。
 */
function maybeCaptureFromTurn(charId, options = {}) {
  if (!charId) return null;
  let assistant = null;
  let user = null;
  if (options.assistantMsgId) assistant = getMsg(options.assistantMsgId);
  if (options.userMsgId) user = getMsg(options.userMsgId);
  if (!assistant || assistant.role !== 'assistant') {
    // 只有 userMsgId 时等助手回复再抓
    return null;
  }
  if (!user || user.role !== 'user') {
    user = latestUserBefore(charId, assistant.id);
  }
  if (!user?.content || !assistant?.content) return null;

  const userText = scrub(user.content);
  const asstText = scrub(assistant.content);

  // 用户松绑 + 角色答应 → 作废作息约束
  if (looksLikeReleaseAsk(userText) && looksLikeAgree(asstText) && SLEEP_TOPIC_RE.test(userText + asstText)) {
    deactivateKind(charId, 'sleep', 'user released');
    return { released: 'sleep' };
  }

  if (!looksLikeUserAsk(userText)) return null;
  if (!looksLikeAgree(asstText)) return null;

  try {
    const worldLock = require('./world-lock-helper');
    if (worldLock.isCrossWorldMeetupTalk(userText) || worldLock.isCrossWorldMeetupTalk(asstText)) {
      return null;
    }
  } catch { /* ignore */ }

  const kind = classifyKind(userText);
  const content = summarizeContent(kind, userText, asstText);
  if (content) {
    try {
      if (require('./world-lock-helper').isCrossWorldMeetupTalk(content)) return null;
    } catch { /* ignore */ }
  }
  return insertPromise(charId, {
    kind,
    content,
    user_ask: userText,
    char_reply: asstText.slice(0, 120),
    source_user_msg_id: user.id,
    source_assistant_msg_id: assistant.id,
  });
}

function formatForPrompt(charId) {
  const rows = listActive(charId);
  if (!rows.length) return '';
  let worldLock;
  try { worldLock = require('./world-lock-helper'); } catch { worldLock = null; }
  const lines = rows
    .filter((r) => !(worldLock && worldLock.isCrossWorldMeetupTalk(r.content)))
    .slice(0, 6)
    .map((r) => `· ${r.content}`);
  if (!lines.length) return '';
  return `【已答应对方的事】只有对方明确要求、且你当面答应过的才在这里。说话和过日子都要当真：禁止嘴上答应、后面照旧；日程里能动的时段也要遵守（宴会/上班/考试等推不掉的除外）。会合/过来找不算可执行承诺，已剔除。\n${lines.join('\n')}`;
}

function formatForSchedule(charId) {
  const rows = listActive(charId);
  if (!rows.length) return '';
  const sleep = rows.filter((r) => r.kind === 'sleep');
  const other = rows.filter((r) => r.kind !== 'sleep').slice(0, 4);
  const bits = [];
  if (sleep.length) {
    bits.push(`作息约束（对方要求且已答应）：${sleep[0].content}。今夜禁止通宵/熬到天亮，须正常入睡；能动的晚间时段按早点休息写`);
  }
  for (const r of other) bits.push(`已答应：${r.content}`);
  return bits.join('\n');
}

module.exports = {
  ensureTable,
  maybeCaptureFromTurn,
  listActive,
  activeSleepConstraint,
  formatForPrompt,
  formatForSchedule,
  looksLikeUserAsk,
  looksLikeAgree,
};

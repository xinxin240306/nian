/** 秘密簿：仅「我们」自动生成（备忘录/心事不再自动写） */
const db = require('./db');
const { callChatAPIComplete, formatApiBillingError } = require('./api-helper');

const SECRET_SECTIONS = ['us'];
const SECRET_SECTION_LABELS = { memo: '备忘录', us: '我们', heart: '心事' };
const ALL_SECTIONS = ['memo', 'us', 'heart'];

/** 线上日常琐事：不是「见面后共同清单」 */
const US_ONLINE_TRIVIAL_RE = /(下班|回家|陪.{0,6}(聊|说)|语音|视频通话|发消息|回消息|线上|网聊|每天陪|睡前聊|早安|晚安|等你回|等我回|挂着电话|一起熬夜聊天|打字|微信|短信)/;

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function getLocalDateStr(date = new Date(), tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function noteAtNow(tz = 'Asia/Shanghai') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const g = (t) => parts.find(p => p.type === t)?.value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
  } catch {
    return new Date().toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** 标题保持具体，不强行加「一起」前缀 */
function normalizeUsTitle(title) {
  let t = String(title || '').trim().replace(/\s+/g, ' ');
  t = t.replace(/^[【\[]\s*|\s*[】\]]$/g, '');
  return t.slice(0, 28);
}

function formatUsContent(title, detail) {
  const t = normalizeUsTitle(title);
  const d = String(detail || '').trim().slice(0, 200);
  if (!t) return '';
  return d ? `${t}\n${d}` : t;
}

function normalizeSecretFact(text, section = 'us') {
  let s = String(text || '').trim();
  if (section === 'memo') {
    return s.slice(0, 20000);
  }
  if (section === 'us') {
    const nl = s.indexOf('\n');
    const title = nl >= 0 ? s.slice(0, nl) : s;
    const detail = nl >= 0 ? s.slice(nl + 1) : '';
    return formatUsContent(title, detail);
  }
  s = s.replace(/\s+/g, ' ').replace(/^[・\-–•]\s*/, '');
  return s.slice(0, 48);
}

function secretNotesSimilar(a, b) {
  const x = String(a || '').replace(/\s/g, '');
  const y = String(b || '').replace(/\s/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const ax = x.split(/[\n|｜]/)[0] || x;
  const ay = y.split(/[\n|｜]/)[0] || y;
  if (ax.length >= 4 && ay.length >= 4 && (ax.includes(ay) || ay.includes(ax))) return true;
  return false;
}

function insertSecretNote({ characterId, role = 'ai', section, content, noteAt, date, source = 'auto', confirmed = null }) {
  if (!ALL_SECTIONS.includes(section)) return null;
  // 心事已停用：拒绝新写入
  if (section === 'heart' && source !== 'manual_legacy') return null;
  const fact = normalizeSecretFact(content, section);
  if (!fact) return null;
  const cid = Number(characterId);
  const existing = db.prepare(
    `SELECT id, content FROM secret_notes WHERE character_id=? AND section=? AND date=?`
  ).all(cid, section, date);
  if (existing.some(r => secretNotesSimilar(r.content, fact))) return null;
  let conf = confirmed;
  if (conf == null) conf = section === 'memo' ? 0 : 1;
  const r = db.prepare(
    `INSERT INTO secret_notes (character_id, role, section, content, note_at, date, source, confirmed) VALUES (?,?,?,?,?,?,?,?)`
  ).run(cid, role, section, fact, noteAt || noteAtNow(), date, source, conf ? 1 : 0);
  return r.lastInsertRowid;
}

function parseSecretGenJson(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

/**
 * 「我们」已停用：改为共享备忘录，不再自动生成 us
 */
async function generateSecretNotesForDay(charId, dateStr = null, opts = {}) {
  return { ok: true, added: 0, skipped: true, reason: 'us_disabled' };
}

/** 出现具体「一起做某事」信号时也不再补写「我们」 */
async function patchSecretNotesFromChat(charId, dateStr = null) {
  return { ok: true, added: 0, skipped: true, reason: 'us_disabled' };
}

function listSecretNotes({ characterId, section, date, role } = {}) {
  let q = 'SELECT * FROM secret_notes WHERE 1=1';
  const params = [];
  if (characterId != null && characterId !== '') {
    q += ' AND character_id=?';
    params.push(Number(characterId));
  }
  if (section) { q += ' AND section=?'; params.push(section); }
  if (date) { q += ' AND date=?'; params.push(date); }
  if (role) { q += ' AND role=?'; params.push(role); }
  q += ' ORDER BY note_at DESC, id DESC';
  return db.prepare(q).all(...params);
}

function decorateDiaryWithStickers(diaryId, charId = null) {
  if (!diaryId) return 0;
  try {
    const existing = db.prepare(
      `SELECT COUNT(*) AS n FROM secret_stickers WHERE owner_type='diary' AND owner_id=?`
    ).get(diaryId);
    if (existing?.n > 0) return 0;

    let emojis = [];
    try {
      emojis = db.prepare('SELECT id, filename FROM emojis ORDER BY RANDOM() LIMIT 24').all();
    } catch { emojis = []; }
    if (!emojis.length) return 0;

    const count = 2 + Math.floor(Math.random() * 3);
    const pick = emojis.slice(0, Math.min(count, emojis.length));
    const ins = db.prepare(
      `INSERT INTO secret_stickers (owner_type, owner_id, emoji_id, unicode, x, y, scale) VALUES ('diary',?,?,?,?,?,?)`
    );
    const positions = [
      [0.78, 0.18], [0.18, 0.72], [0.82, 0.68], [0.22, 0.22], [0.55, 0.82],
    ];
    let n = 0;
    pick.forEach((e, i) => {
      const [x, y] = positions[i % positions.length];
      const jitterX = (Math.random() - 0.5) * 0.08;
      const jitterY = (Math.random() - 0.5) * 0.08;
      ins.run(
        diaryId,
        e.id,
        '',
        Math.min(0.92, Math.max(0.08, x + jitterX)),
        Math.min(0.92, Math.max(0.08, y + jitterY)),
        0.9 + Math.random() * 0.35
      );
      n++;
    });
    return n;
  } catch (e) {
    console.warn('[secret] decorate stickers', e.message);
    return 0;
  }
}

module.exports = {
  SECRET_SECTIONS,
  ALL_SECTIONS,
  SECRET_SECTION_LABELS,
  insertSecretNote,
  generateSecretNotesForDay,
  patchSecretNotesFromChat,
  listSecretNotes,
  decorateDiaryWithStickers,
  noteAtNow,
  getLocalDateStr,
  normalizeSecretFact,
  normalizeUsTitle,
  formatUsContent,
};

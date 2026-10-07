/**
 * 角色档案：按人生阶段记录经历，一键消化成心智，并写回性格 / 行为 / 背景摘要。
 * 档案是原料；性格与行为是消化产物；心智是聊天时真正在跑的内在看法。
 */
const db = require('./db');

const ARCHIVE_STAGES = ['童年', '少年', '青年', '成年', '相识前', '相识后', '其他'];
const STAGE_ORDER = Object.fromEntries(ARCHIVE_STAGES.map((s, i) => [s, i]));
const CONTENT_MAX = 800;
const TITLE_MAX = 40;
const MINDSET_MAX = 900;
const PERSONALITY_MAX = 500;
const BEHAVIOR_MAX = 500;
const BACKGROUND_MAX = 900;

function ensureArchiveTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS char_archive_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT '其他',
      title TEXT DEFAULT '',
      content TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_char_archive_char ON char_archive_entries(character_id)`);
  try {
    db.exec(`ALTER TABLE characters ADD COLUMN mindset TEXT DEFAULT ''`);
  } catch { /* exists */ }
  try {
    db.exec(`ALTER TABLE characters ADD COLUMN mindset_digested_at TEXT DEFAULT NULL`);
  } catch { /* exists */ }
}

function normalizeStage(stage) {
  const s = String(stage || '').trim().slice(0, 12);
  if (!s) return '其他';
  if (ARCHIVE_STAGES.includes(s)) return s;
  return s;
}

function clip(text, max) {
  return String(text || '').trim().slice(0, max);
}

function listEntries(characterId) {
  ensureArchiveTable();
  const cid = Number(characterId);
  if (!cid) return [];
  const rows = db.prepare(
    `SELECT * FROM char_archive_entries WHERE character_id=? ORDER BY sort_order ASC, id ASC`
  ).all(cid);
  return rows.map((r) => ({
    ...r,
    stage: normalizeStage(r.stage),
    title: String(r.title || ''),
    content: String(r.content || ''),
  })).sort((a, b) => {
    const oa = STAGE_ORDER[a.stage] ?? 50;
    const ob = STAGE_ORDER[b.stage] ?? 50;
    if (oa !== ob) return oa - ob;
    return (a.sort_order - b.sort_order) || (a.id - b.id);
  });
}

function getEntry(id) {
  ensureArchiveTable();
  const row = db.prepare('SELECT * FROM char_archive_entries WHERE id=?').get(id);
  if (!row) return null;
  return {
    ...row,
    stage: normalizeStage(row.stage),
    title: String(row.title || ''),
    content: String(row.content || ''),
  };
}

function insertEntry(characterId, item = {}) {
  ensureArchiveTable();
  const cid = Number(characterId);
  if (!cid) throw new Error('character_id required');
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(cid);
  if (!char) throw new Error('角色不存在');
  const content = clip(item.content, CONTENT_MAX);
  if (!content || content.length < 2) throw new Error('请填写经历内容');
  const stage = normalizeStage(item.stage);
  const title = clip(item.title, TITLE_MAX);
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order),0) AS m FROM char_archive_entries WHERE character_id=?'
  ).get(cid)?.m || 0;
  const sortOrder = item.sort_order != null ? Number(item.sort_order) : maxOrder + 1;
  const r = db.prepare(
    `INSERT INTO char_archive_entries (character_id, stage, title, content, sort_order)
     VALUES (?,?,?,?,?)`
  ).run(cid, stage, title, content, sortOrder);
  return getEntry(r.lastInsertRowid);
}

function updateEntry(id, patch = {}) {
  ensureArchiveTable();
  const row = db.prepare('SELECT * FROM char_archive_entries WHERE id=?').get(id);
  if (!row) return null;
  const stage = patch.stage != null ? normalizeStage(patch.stage) : row.stage;
  const title = patch.title != null ? clip(patch.title, TITLE_MAX) : String(row.title || '');
  const content = patch.content != null ? clip(patch.content, CONTENT_MAX) : String(row.content || '');
  if (!content || content.length < 2) throw new Error('请填写经历内容');
  const sortOrder = patch.sort_order != null ? Number(patch.sort_order) : row.sort_order;
  db.prepare(
    `UPDATE char_archive_entries
     SET stage=?, title=?, content=?, sort_order=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(stage, title, content, sortOrder, id);
  return getEntry(id);
}

function deleteEntry(id) {
  ensureArchiveTable();
  db.prepare('DELETE FROM char_archive_entries WHERE id=?').run(id);
  return true;
}

function deleteAllForCharacter(characterId) {
  ensureArchiveTable();
  db.prepare('DELETE FROM char_archive_entries WHERE character_id=?').run(Number(characterId));
}

function getMindset(characterId) {
  ensureArchiveTable();
  const row = db.prepare(
    'SELECT mindset, mindset_digested_at, personality, behavior, background FROM characters WHERE id=?'
  ).get(Number(characterId));
  if (!row) return null;
  return {
    mindset: String(row.mindset || ''),
    digestedAt: row.mindset_digested_at || null,
    personality: String(row.personality || ''),
    behavior: String(row.behavior || ''),
    background: String(row.background || ''),
  };
}

function formatEntriesForDigest(entries) {
  const byStage = new Map();
  for (const e of entries) {
    const stage = e.stage || '其他';
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(e);
  }
  const lines = [];
  for (const stage of ARCHIVE_STAGES) {
    const list = byStage.get(stage);
    if (!list?.length) continue;
    lines.push(`## ${stage}`);
    for (const e of list) {
      const head = e.title ? `【${e.title}】` : '';
      lines.push(`- ${head}${e.content}`);
    }
    byStage.delete(stage);
  }
  for (const [stage, list] of byStage) {
    lines.push(`## ${stage}`);
    for (const e of list) {
      const head = e.title ? `【${e.title}】` : '';
      lines.push(`- ${head}${e.content}`);
    }
  }
  return lines.join('\n');
}

function extractSection(raw, labels) {
  const text = String(raw || '');
  for (const label of labels) {
    const re = new RegExp(
      `【${label}】\\s*([\\s\\S]*?)(?=\\n\\s*【(?:心智|性格|行为模式|行为|背景摘要|背景)】|$)`,
      'i'
    );
    const m = text.match(re);
    if (m) return String(m[1] || '').trim();
  }
  return '';
}

function parseDigestOutput(raw) {
  const mindset = clip(extractSection(raw, ['心智']), MINDSET_MAX);
  const personality = clip(extractSection(raw, ['性格']), PERSONALITY_MAX);
  const behavior = clip(extractSection(raw, ['行为模式', '行为']), BEHAVIOR_MAX);
  const background = clip(extractSection(raw, ['背景摘要', '背景']), BACKGROUND_MAX);
  return { mindset, personality, behavior, background };
}

function applyDigest(characterId, digest) {
  ensureArchiveTable();
  const cid = Number(characterId);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const row = db.prepare(
    'SELECT personality, behavior, background FROM characters WHERE id=?'
  ).get(cid);
  if (!row) return null;
  db.prepare(
    `UPDATE characters
     SET mindset=?,
         mindset_digested_at=?,
         personality=?,
         behavior=?,
         background=?
     WHERE id=?`
  ).run(
    digest.mindset || '',
    now,
    digest.personality || row.personality || '',
    digest.behavior || row.behavior || '',
    digest.background || row.background || '',
    cid
  );
  return getMindset(cid);
}

async function digestArchive(characterId, settings, callChatAPIComplete) {
  ensureArchiveTable();
  const cid = Number(characterId);
  const char = db.prepare(
    'SELECT id, name, personality, behavior, background, intro, relationship, relationship_custom FROM characters WHERE id=?'
  ).get(cid);
  if (!char) throw new Error('角色不存在');
  const entries = listEntries(cid);
  if (!entries.length) throw new Error('请先添加至少一条经历');

  const name = char.name || 'TA';
  const archiveText = formatEntriesForDigest(entries);
  const sysPrompt = `你在消化角色「${name}」的人生档案，生成稳定的内在心智。
只输出四个栏目，不要聊天、不要解释过程。
栏目必须齐全，格式严格：
【心智】
【性格】
【行为模式】
【背景摘要】`;

  const userMsg = `根据下列人生经历，消化出「${name}」现在是怎样一个人。

要求：
1. 【心智】第一人称、内在视角。写「我怎么看人/事、我信什么、我怕什么、我默认怎么保护自己」。200～450 字。不是性格标签列表，不是剧情复述。
2. 【性格】第三人称简述底色与遇事反应（慢热/直球、嘴硬心软、吃醋或生气时大概怎样）。80～200 字。
3. 【行为模式】日常习惯、社交方式、冲突时先退还是先顶、对亲近的人一般态度。80～200 字。
4. 【背景摘要】用经历写成一段稳定来历（出身、成长、重要过往），不要写成「童年：…少年：…」条目清单。120～300 字。
5. 经历是事实原料；禁止发明档案里没有的重大事件。可合理推断内在态度。
6. 不要写 AI、扮演、角色卡、系统提示等字样。

【现有角色卡·仅供参考，以档案经历为准】
性格：${String(char.personality || '').slice(0, 200) || '（空）'}
行为：${String(char.behavior || '').slice(0, 200) || '（空）'}
背景：${String(char.background || '').slice(0, 240) || '（空）'}
介绍：${String(char.intro || '').slice(0, 120) || '（空）'}

【人生档案】
${archiveText}`;

  let raw = '';
  try {
    raw = await callChatAPIComplete(settings, sysPrompt, userMsg, 'memory', [], {
      maxTokens: 1600,
      temperature: 0.55,
      timeout: 120000,
      noContinue: true,
    });
  } catch { /* fallback */ }
  if (!raw) {
    raw = await callChatAPIComplete(settings, sysPrompt, userMsg, 'chat', [], {
      maxTokens: 1600,
      temperature: 0.55,
      timeout: 120000,
      noContinue: true,
    });
  }
  if (!raw) throw new Error('AI 未返回内容');

  const parsed = parseDigestOutput(raw);
  if (!parsed.mindset && !parsed.personality) {
    throw new Error('消化结果解析失败，请重试');
  }
  // 心智是必须的；若缺则用全文前半兜底
  if (!parsed.mindset) {
    parsed.mindset = clip(String(raw).replace(/【[^】]+】/g, '').trim(), MINDSET_MAX);
  }
  const applied = applyDigest(cid, parsed);
  return {
    ok: true,
    ...parsed,
    digestedAt: applied?.digestedAt || null,
    entryCount: entries.length,
    raw,
  };
}

/** 聊天提示：有心智时用心智主导，性格/行为作补充；背景不再全文塞入 */
function formatMindsetForPrompt(char) {
  if (!char) return '';
  const mindset = String(char.mindset || '').trim();
  if (!mindset) return '';
  const parts = [
    `【心智】这是你消化过往之后形成的内在看法。只在心里用，禁止复述原文，禁止拆成消息发出去，不要点名栏目。\n${mindset.slice(0, MINDSET_MAX)}`,
  ];
  if (char.personality) {
    parts.push(`【性格】${String(char.personality).slice(0, 280)}`);
  }
  if (char.behavior) {
    parts.push(`【行为模式】${String(char.behavior).slice(0, 240)}`);
  }
  return parts.join('\n');
}

module.exports = {
  ARCHIVE_STAGES,
  ensureArchiveTable,
  normalizeStage,
  listEntries,
  getEntry,
  insertEntry,
  updateEntry,
  deleteEntry,
  deleteAllForCharacter,
  getMindset,
  digestArchive,
  applyDigest,
  formatMindsetForPrompt,
  formatEntriesForDigest,
};

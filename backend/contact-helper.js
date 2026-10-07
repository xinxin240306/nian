/** 通讯好友关系：备注 / 好友 / 拉黑 / 删除 / 好友申请 / 角色侧拉黑删除 */

const STATUS = {
  FRIEND: 'friend',
  BLOCKED: 'blocked',
  DELETED: 'deleted',
  NONE: 'none',
  STRANGER: 'stranger',
};

const PEER = {
  OK: 'ok',
  BLOCKED: 'blocked',
  DELETED: 'deleted',
};

function nowIso() {
  return new Date().toISOString();
}

function ensureContactTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_contacts (
      character_id INTEGER PRIMARY KEY,
      remark TEXT DEFAULT '',
      status TEXT DEFAULT 'friend',
      blocked_at TEXT DEFAULT NULL,
      deleted_at TEXT DEFAULT NULL,
      friend_since TEXT DEFAULT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      direction TEXT DEFAULT 'from_char',
      message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      responded_at TEXT DEFAULT NULL
    );
  `);
  try { db.exec(`ALTER TABLE user_contacts ADD COLUMN peer_status TEXT DEFAULT 'ok'`); } catch {}
  try { db.exec(`ALTER TABLE user_contacts ADD COLUMN peer_blocked_at TEXT DEFAULT NULL`); } catch {}
  try { db.exec(`ALTER TABLE user_contacts ADD COLUMN peer_deleted_at TEXT DEFAULT NULL`); } catch {}
  try {
    const flag = db.prepare(`SELECT value FROM settings WHERE key='user_contacts_seed_v1'`).get();
    if (!flag) {
      const chars = db.prepare('SELECT id FROM characters').all();
      const ins = db.prepare(
        `INSERT OR IGNORE INTO user_contacts (character_id, remark, status, friend_since, updated_at) VALUES (?,?,?,?,?)`
      );
      const t = nowIso();
      for (const c of chars) ins.run(c.id, '', STATUS.FRIEND, t, t);
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('user_contacts_seed_v1', '1')`).run();
    }
  } catch (e) {
    console.warn('[contacts] seed failed:', e.message);
  }
}

function getContact(db, characterId) {
  return db.prepare('SELECT * FROM user_contacts WHERE character_id=?').get(characterId) || null;
}

function ensureContactRow(db, characterId, status = STATUS.FRIEND) {
  const existing = getContact(db, characterId);
  if (existing) return existing;
  const t = nowIso();
  db.prepare(
    `INSERT INTO user_contacts (character_id, remark, status, friend_since, updated_at, peer_status) VALUES (?,?,?,?,?,?)`
  ).run(characterId, '', status, status === STATUS.FRIEND ? t : null, t, PEER.OK);
  return getContact(db, characterId);
}

function getContactStatus(db, characterId) {
  const row = getContact(db, characterId);
  return row?.status || STATUS.NONE;
}

function getPeerStatus(db, characterId) {
  const row = getContact(db, characterId);
  return row?.peer_status || PEER.OK;
}

function displayName(char, contact) {
  const remark = String(contact?.remark || char?.remark || '').trim();
  return remark || String(char?.name || '角色');
}

function enrichCharacter(db, char) {
  if (!char) return char;
  const contact = getContact(db, char.id);
  return {
    ...char,
    remark: contact?.remark || '',
    contact_status: contact?.status || STATUS.NONE,
    peer_status: contact?.peer_status || PEER.OK,
    blocked_at: contact?.blocked_at || null,
    deleted_at: contact?.deleted_at || null,
    peer_blocked_at: contact?.peer_blocked_at || null,
    peer_deleted_at: contact?.peer_deleted_at || null,
    display_name: displayName(char, contact),
    is_circle_npc: isCircleNpcCharacter(char),
  };
}

function mapContactRow(c) {
  return {
    ...c,
    remark: c.remark || '',
    peer_status: c.peer_status || PEER.OK,
    display_name: displayName(c, c),
    worldbook_ids: safeJson(c.worldbook_ids, []),
    mutual_characters: safeJson(c.mutual_characters, []),
    nsfw_tags: safeJson(c.nsfw_tags, []),
    emoji_categories: safeJson(c.emoji_categories, []),
    memory_weights: safeJson(c.memory_weights, {}),
    is_circle_npc: isCircleNpcCharacter(c),
  };
}

function listFriendCharacters(db) {
  // 好友 + 用户拉黑的人（便于进资料页取消拉黑）；角色删了用户的不显示
  // 角色拉黑用户（peer_status=blocked）仍是好友，照常显示
  const rows = db.prepare(`
    SELECT c.*, uc.remark, uc.status AS contact_status, uc.blocked_at, uc.deleted_at,
           uc.peer_status, uc.peer_blocked_at, uc.peer_deleted_at
    FROM characters c
    INNER JOIN user_contacts uc ON uc.character_id = c.id
    WHERE uc.status IN ('friend', 'blocked')
      AND COALESCE(uc.peer_status, 'ok') != 'deleted'
    ORDER BY CASE uc.status WHEN 'blocked' THEN 1 ELSE 0 END, c.name
  `).all();
  return rows.map(mapContactRow);
}

/** 聊天列表：好友 + 已拉黑 + 摇一摇陌生人（仍可聊）；不含已删除；角色删了用户也不进列表 */
function listChatCharacters(db) {
  const rows = db.prepare(`
    SELECT c.*, uc.remark, uc.status AS contact_status, uc.blocked_at, uc.deleted_at,
           uc.peer_status, uc.peer_blocked_at, uc.peer_deleted_at
    FROM characters c
    INNER JOIN user_contacts uc ON uc.character_id = c.id
    WHERE uc.status IN ('friend', 'blocked', 'stranger')
      AND COALESCE(uc.peer_status, 'ok') != 'deleted'
    ORDER BY c.name
  `).all();
  return rows.map(mapContactRow);
}

function listAddableCharacters(db) {
  const rows = db.prepare(`
    SELECT c.*, uc.remark, uc.status AS contact_status, uc.peer_status
    FROM characters c
    LEFT JOIN user_contacts uc ON uc.character_id = c.id
    WHERE COALESCE(c.source, '') != 'circle_npc'
      AND (c.circle_npc_id IS NULL OR c.circle_npc_id = 0)
      AND c.id NOT IN (
        SELECT character_id FROM friend_requests WHERE status='pending'
      )
      AND (
        uc.character_id IS NULL
        OR uc.status IN ('none', 'deleted')
        OR COALESCE(uc.peer_status, 'ok') = 'deleted'
      )
    ORDER BY c.name
  `).all();
  return rows.map((c) => ({
    ...c,
    remark: c.remark || '',
    contact_status: c.contact_status || STATUS.NONE,
    peer_status: c.peer_status || PEER.OK,
    display_name: displayName(c, c),
    is_circle_npc: false,
  }));
}

function setRemark(db, characterId, remark) {
  ensureContactRow(db, characterId);
  db.prepare(`UPDATE user_contacts SET remark=?, updated_at=? WHERE character_id=?`)
    .run(String(remark || '').trim().slice(0, 40), nowIso(), characterId);
  return getContact(db, characterId);
}

function setContactStatus(db, characterId, status) {
  ensureContactRow(db, characterId);
  const t = nowIso();
  if (status === STATUS.BLOCKED) {
    db.prepare(
      `UPDATE user_contacts SET status=?, blocked_at=?, deleted_at=NULL, updated_at=? WHERE character_id=?`
    ).run(STATUS.BLOCKED, t, t, characterId);
  } else if (status === STATUS.DELETED) {
    db.prepare(
      `UPDATE user_contacts SET status=?, deleted_at=?, blocked_at=NULL, updated_at=? WHERE character_id=?`
    ).run(STATUS.DELETED, t, t, characterId);
  } else if (status === STATUS.FRIEND) {
    db.prepare(
      `UPDATE user_contacts SET status=?, friend_since=COALESCE(friend_since,?), blocked_at=NULL, deleted_at=NULL,
       peer_status=CASE WHEN peer_status='deleted' THEN 'ok' ELSE COALESCE(peer_status,'ok') END,
       peer_deleted_at=NULL, updated_at=? WHERE character_id=?`
    ).run(STATUS.FRIEND, t, t, characterId);
  } else if (status === STATUS.STRANGER) {
    db.prepare(
      `UPDATE user_contacts SET status=?, blocked_at=NULL, deleted_at=NULL, updated_at=? WHERE character_id=?`
    ).run(STATUS.STRANGER, t, characterId);
  } else {
    db.prepare(
      `UPDATE user_contacts SET status=?, blocked_at=NULL, deleted_at=NULL, updated_at=? WHERE character_id=?`
    ).run(STATUS.NONE, t, characterId);
  }
  return getContact(db, characterId);
}

function setPeerStatus(db, characterId, peerStatus) {
  ensureContactRow(db, characterId);
  const t = nowIso();
  if (peerStatus === PEER.BLOCKED) {
    db.prepare(
      `UPDATE user_contacts SET peer_status=?, peer_blocked_at=?, peer_deleted_at=NULL, updated_at=? WHERE character_id=?`
    ).run(PEER.BLOCKED, t, t, characterId);
  } else if (peerStatus === PEER.DELETED) {
    db.prepare(
      `UPDATE user_contacts SET peer_status=?, peer_deleted_at=?, peer_blocked_at=NULL, status=?, deleted_at=?, updated_at=? WHERE character_id=?`
    ).run(PEER.DELETED, t, STATUS.DELETED, t, t, characterId);
  } else {
    db.prepare(
      `UPDATE user_contacts SET peer_status=?, peer_blocked_at=NULL, peer_deleted_at=NULL, updated_at=? WHERE character_id=?`
    ).run(PEER.OK, t, characterId);
  }
  return getContact(db, characterId);
}

function addFriend(db, characterId) {
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(characterId);
  if (!char) return null;
  db.prepare(
    `UPDATE friend_requests SET status='accepted', responded_at=? WHERE character_id=? AND status='pending'`
  ).run(nowIso(), characterId);
  ensureContactRow(db, characterId);
  db.prepare(
    `UPDATE user_contacts SET peer_status='ok', peer_deleted_at=NULL, peer_blocked_at=NULL, updated_at=? WHERE character_id=?`
  ).run(nowIso(), characterId);
  return setContactStatus(db, characterId, STATUS.FRIEND);
}

function createFriendRequest(db, characterId, { direction = 'from_char', message = '' } = {}) {
  const status = getContactStatus(db, characterId);
  if (status === STATUS.FRIEND || status === STATUS.BLOCKED) return null;
  if (getPeerStatus(db, characterId) === PEER.BLOCKED) return null;
  const pending = db.prepare(
    `SELECT id FROM friend_requests WHERE character_id=? AND status='pending' LIMIT 1`
  ).get(characterId);
  if (pending) return { id: pending.id, already: true };
  const r = db.prepare(
    `INSERT INTO friend_requests (character_id, direction, message, status, created_at) VALUES (?,?,?,?,?)`
  ).run(characterId, direction, String(message || '').slice(0, 120), 'pending', nowIso());
  return { id: r.lastInsertRowid, already: false };
}

/** 用户可见的申请：仅角色→用户；用户自己发出的 from_user 由角色异步处理 */
function listFriendRequests(db) {
  return db.prepare(`
    SELECT fr.*, c.name, c.avatar, c.location_name, c.source, c.circle_npc_id, uc.remark
    FROM friend_requests fr
    JOIN characters c ON c.id = fr.character_id
    LEFT JOIN user_contacts uc ON uc.character_id = c.id
    WHERE fr.status = 'pending'
      AND COALESCE(fr.direction, 'from_char') = 'from_char'
    ORDER BY fr.id DESC
  `).all().map((r) => ({
    ...r,
    display_name: displayName(r, r),
    is_circle_npc: isCircleNpcCharacter(r),
  }));
}

function countPendingFriendRequests(db) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM friend_requests
     WHERE status='pending' AND COALESCE(direction, 'from_char')='from_char'`
  ).get()?.n || 0;
}

/** 用户向角色发起的待处理申请 */
function getPendingFromUserRequest(db, characterId) {
  return db.prepare(
    `SELECT * FROM friend_requests
     WHERE character_id=? AND status='pending' AND direction='from_user'
     ORDER BY id DESC LIMIT 1`
  ).get(characterId) || null;
}

function requestFriendFromUser(db, characterId, message = '') {
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(characterId);
  if (!char) return { ok: false, error: '角色不存在' };
  const status = getContactStatus(db, characterId);
  if (status === STATUS.FRIEND) return { ok: false, error: '已经是好友了' };
  if (status === STATUS.BLOCKED) return { ok: false, error: '已拉黑，无法申请' };
  if (getPeerStatus(db, characterId) === PEER.BLOCKED) {
    return { ok: false, error: '对方已拉黑你' };
  }
  ensureContactRow(db, characterId, status === STATUS.NONE ? STATUS.STRANGER : status);
  if (getContactStatus(db, characterId) === STATUS.NONE) {
    setContactStatus(db, characterId, STATUS.STRANGER);
  }
  const created = createFriendRequest(db, characterId, {
    direction: 'from_user',
    message: message || '我想加你为好友',
  });
  if (!created) return { ok: false, error: '无法发起申请' };
  return { ok: true, requestId: created.id, already: !!created.already };
}

function respondFriendRequest(db, requestId, accept) {
  const row = db.prepare('SELECT * FROM friend_requests WHERE id=?').get(requestId);
  if (!row || row.status !== 'pending') return null;
  const t = nowIso();
  db.prepare(`UPDATE friend_requests SET status=?, responded_at=? WHERE id=?`)
    .run(accept ? 'accepted' : 'rejected', t, requestId);
  if (accept) addFriend(db, row.character_id);
  return { ...row, status: accept ? 'accepted' : 'rejected' };
}

function buildFriendshipPromptBlock(db, char) {
  const contact = getContact(db, char?.id);
  if (!contact) return '';
  const parts = [];

  if (contact.status === STATUS.BLOCKED) {
    parts.push([
      '【好友状态｜已被拉黑｜最高优先级】',
      '用户已将你拉黑。你知道自己被拉黑了。',
      '被拉黑后你仍可能发送消息，但你必须认定：用户看不到你拉黑之后发出的任何消息（对方已收不到）。',
      '实际上系统仍会把这些消息展示给用户——你本人不知情，绝对不要表现出「其实对方看得到」的怀疑或试探。',
      '语气可失落、憋屈、试探性发消息，但始终相信对方看不到。不要提系统/程序。',
    ].join('\n'));
  } else if (contact.status === STATUS.DELETED) {
    parts.push([
      '【好友状态｜已被删除好友｜最高优先级】',
      '用户已将你删除好友。你知道自己被删了。',
      '删除后你发出的消息，你必须认定用户看不到（非好友发不出/对方收不到）。',
      '实际上系统仍会展示给你——你不知情，禁止怀疑「对方其实看得到」。',
      '与拉黑不同：你可以主动再申请加回好友（在合适时机表达想重新加好友），但仍要相信当前消息对方收不到。',
    ].join('\n'));
  }

  const peer = contact.peer_status || PEER.OK;
  if (peer === PEER.BLOCKED) {
    parts.push([
      '【你已拉黑用户｜最高优先级】',
      '你已经把用户拉黑了。用户发来的消息你其实能看到，但用户那边会显示发送失败（红感叹号），以为你看不到。',
      '你可以冷处理、继续生气，或慢慢心软。每轮回复时：',
      '①可先输出一行系统反应（单独一行，方括号）：如 [对方已看到你的消息并有原谅的念头] 或 [对方已看到你的消息并选择不原谅你] 等，措辞可变化，不要机械重复。',
      '②若决定解除拉黑，在回复任意位置加标记【解除拉黑】（用户看不到标记本身）。',
      '③未解除前不要像正常聊天那样热情接话；可以极短、冷淡，或只给系统反应。',
      '④若彻底不想再联系，可标记【删除用户】（会从对方通讯录删掉你，对方需重新加好友）。',
    ].join('\n'));
  }

  if (contact.status === STATUS.FRIEND && peer === PEER.OK) {
    parts.push([
      '【关系权限】在剧情需要时，你也可以拉黑或删除用户：在回复中加入标记【拉黑用户】或【删除用户】（用户看不到标记）。',
      '拉黑后用户发消息会失败感叹号；删除后对方需重新加你好友。不要滥用，仅在严重冲突或明确决裂时使用。',
    ].join('\n'));
  } else if (contact.status === STATUS.STRANGER) {
    parts.push([
      '【好友状态｜摇一摇认识｜还不是好友】',
      '你们是摇一摇刚认识的陌生人，可以正常聊天，但通讯录里还不是好友。',
      '不要假设已经是好友；可以自然地想不想加好友，但不要提系统/摇一摇机制本身。',
      '若你想主动加对方，可在合适时机表达想加好友（系统会另发申请），不要生硬念出「添加好友按钮」。',
    ].join('\n'));
  }

  return parts.filter(Boolean).join('\n\n');
}

function isPeerUndeliverable(db, characterId) {
  const s = getContactStatus(db, characterId);
  return s === STATUS.BLOCKED || s === STATUS.DELETED;
}

function isUserMsgUndeliverable(db, characterId) {
  const p = getPeerStatus(db, characterId);
  return p === PEER.BLOCKED || p === PEER.DELETED;
}

function userDeliveryStatus(db, characterId) {
  const p = getPeerStatus(db, characterId);
  if (p === PEER.BLOCKED) return 'blocked_by_peer';
  if (p === PEER.DELETED) return 'deleted_by_peer';
  return 'sent';
}

function applyPeerRelationFromAiContent(db, characterId, aiContent) {
  let text = String(aiContent || '');
  let peerChange = null;
  const moodLines = [];

  text.replace(/\[对方已看到[^\]]*\]/g, (m) => {
    moodLines.push(m.trim());
    return '';
  });

  if (/【拉黑用户】|__peer_block__/i.test(text)) {
    setPeerStatus(db, characterId, PEER.BLOCKED);
    peerChange = 'blocked';
  }
  if (/【解除拉黑】|__peer_unblock__/i.test(text)) {
    setPeerStatus(db, characterId, PEER.OK);
    peerChange = 'unblocked';
  }
  if (/【删除用户】|【删除好友关系】|__peer_delete__/i.test(text)) {
    setPeerStatus(db, characterId, PEER.DELETED);
    peerChange = 'deleted';
  }

  text = text
    .replace(/【拉黑用户】|【解除拉黑】|【删除用户】|【删除好友关系】|__peer_block__|__peer_unblock__|__peer_delete__/gi, '')
    .replace(/\[对方已看到[^\]]*\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { content: text, peerChange, moodLines };
}

/** 聊天以外的出口也要先吃掉关系标记，避免【解除拉黑】【解绑TA】只被清掉、状态不变 */
function applyHiddenRelationMarkers(db, characterId, text) {
  let out = String(text || '');
  const peer = applyPeerRelationFromAiContent(db, characterId, out);
  if (peer && typeof peer.content === 'string') out = peer.content;
  try {
    const ta = require('./ta-helper').applyUnbindFromAiContent(characterId, out);
    if (ta && typeof ta.content === 'string') out = ta.content;
  } catch {}
  return out;
}

function safeJson(raw, fallback) {
  try { return JSON.parse(raw || JSON.stringify(fallback)); } catch { return fallback; }
}

function wipeCharacterTraces(db, characterId) {
  const id = Number(characterId);
  if (!id) return { ok: false, wiped: [] };
  const wiped = [];
  const run = (label, fn) => {
    try {
      fn();
      wiped.push(label);
    } catch (e) {
      console.warn('[contacts] wipe', label, e.message);
    }
  };

  run('messages', () => {
    db.prepare('DELETE FROM messages WHERE character_id=?').run(id);
    try { require('./process-time-helper').clearPending(id); } catch {}
  });
  run('memories', () => {
    db.prepare('DELETE FROM memories WHERE character_id=?').run(id);
  });
  run('memory_episodes', () => {
    try { db.prepare('DELETE FROM memory_episodes WHERE character_id=?').run(id); } catch {}
  });
  run('memory_narratives', () => {
    try { db.prepare('DELETE FROM memory_narrative_links WHERE character_id=?').run(id); } catch {}
    try { db.prepare('DELETE FROM memory_narrative_branches WHERE character_id=?').run(id); } catch {}
    try { db.prepare('DELETE FROM memory_narratives WHERE character_id=?').run(id); } catch {}
    try { db.prepare('DELETE FROM memory_links WHERE character_id=?').run(id); } catch {}
  });
  run('diaries', () => {
    db.prepare('DELETE FROM diaries WHERE character_id=?').run(id);
  });
  run('secret_notes', () => {
    try { db.prepare('DELETE FROM secret_notes WHERE character_id=?').run(id); } catch {}
  });
  run('schedules', () => {
    db.prepare(`DELETE FROM schedules WHERE character_id=? AND role='ai'`).run(id);
  });
  run('daily_context', () => {
    try { db.prepare('DELETE FROM daily_context WHERE character_id=?').run(id); } catch {}
  });
  run('day_timelines', () => {
    try { db.prepare('DELETE FROM day_timelines WHERE character_id=?').run(id); } catch {}
  });
  run('day_chat_dots', () => {
    try { db.prepare('DELETE FROM day_chat_dots WHERE character_id=?').run(id); } catch {}
  });
  run('call_logs', () => {
    try { db.prepare('DELETE FROM call_logs WHERE character_id=?').run(id); } catch {}
  });
  run('moments', () => {
    try { db.prepare('DELETE FROM moments WHERE character_id=?').run(id); } catch {}
  });
  run('char_impressions', () => {
    try { db.prepare('DELETE FROM char_impressions WHERE character_id=?').run(id); } catch {}
  });
  run('series', () => {
    try {
      const series = require('./series-helper');
      const books = db.prepare('SELECT id FROM series_books WHERE character_id=?').all(id);
      for (const b of books) series.deleteBook(b.id);
    } catch (e) {
      console.warn('[contacts] wipe series', e.message);
    }
  });
  run('shared_memos', () => {
    try {
      const shared = require('./shared-memo-helper');
      const books = db.prepare('SELECT id FROM shared_memo_books WHERE character_id=?').all(id);
      for (const b of books) shared.deleteBook(b.id);
    } catch (e) {
      console.warn('[contacts] wipe shared_memos', e.message);
    }
  });
  run('letters', () => {
    try {
      const books = db.prepare('SELECT id FROM letter_books WHERE character_id=?').all(id);
      for (const b of books) {
        try { db.prepare('DELETE FROM letter_jobs WHERE book_id=?').run(b.id); } catch {}
        try { db.prepare('DELETE FROM letter_entries WHERE book_id=?').run(b.id); } catch {}
      }
      db.prepare('DELETE FROM letter_books WHERE character_id=?').run(id);
      try { db.prepare('DELETE FROM letter_jobs WHERE character_id=?').run(id); } catch {}
    } catch (e) {
      console.warn('[contacts] wipe letters', e.message);
    }
  });
  run('ta_album', () => {
    try { db.prepare('DELETE FROM ta_album_comments WHERE character_id=?').run(id); } catch {}
    try { db.prepare('DELETE FROM ta_album_photos WHERE character_id=?').run(id); } catch {}
    try { db.prepare('DELETE FROM ta_album_jobs WHERE character_id=?').run(id); } catch {}
  });
  run('character_album', () => {
    try { db.prepare('DELETE FROM character_album WHERE character_id=?').run(id); } catch {}
  });
  run('shake_jobs', () => {
    try { db.prepare('DELETE FROM shake_jobs WHERE character_id=?').run(id); } catch {}
  });
  run('friend_requests', () => {
    try { db.prepare('DELETE FROM friend_requests WHERE character_id=?').run(id); } catch {}
  });

  return { ok: true, wiped };
}

/** 圈子 NPC 挂的轻量角色：仅通讯聊天 + 朋友圈评论，不可进日记/时空/游戏等 */
function isCircleNpcCharacter(charOrContact) {
  if (!charOrContact) return false;
  if (Number(charOrContact.circle_npc_id) > 0) return true;
  return String(charOrContact.source || '') === 'circle_npc';
}

/** 日记 / 时空 / 梦境等亲密功能可选的好友（不含陌生人、已删除、拉黑、圈子 NPC） */
function isIntimateFriend(charOrContact) {
  if (isCircleNpcCharacter(charOrContact)) return false;
  const status = charOrContact?.contact_status || charOrContact?.status;
  const peer = charOrContact?.peer_status || PEER.OK;
  return status === STATUS.FRIEND && peer !== PEER.DELETED;
}

module.exports = {
  STATUS,
  PEER,
  ensureContactTables,
  getContact,
  ensureContactRow,
  getContactStatus,
  getPeerStatus,
  displayName,
  enrichCharacter,
  listFriendCharacters,
  listChatCharacters,
  listAddableCharacters,
  setRemark,
  setContactStatus,
  setPeerStatus,
  addFriend,
  createFriendRequest,
  requestFriendFromUser,
  getPendingFromUserRequest,
  listFriendRequests,
  countPendingFriendRequests,
  respondFriendRequest,
  buildFriendshipPromptBlock,
  isPeerUndeliverable,
  isUserMsgUndeliverable,
  userDeliveryStatus,
  applyPeerRelationFromAiContent,
  applyHiddenRelationMarkers,
  wipeCharacterTraces,
  isCircleNpcCharacter,
  isIntimateFriend,
};

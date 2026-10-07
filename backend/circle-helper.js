/**
 * 圈子功能：NPC人际关系管理
 * - 圈子：管理NPC的分组
 * - NPC：非角色人物，可以有朋友圈和通讯录
 * - NPC朋友圈：独立于角色朋友圈
 * - NPC通讯录：NPC之间可以加朋友
 */
const db = require('./db');

// ============================================================
// 工具函数
// ============================================================
function nowIso() {
  return new Date().toISOString();
}

function safeJson(raw, fallback) {
  try { return JSON.parse(raw || JSON.stringify(fallback)); } catch { return fallback; }
}

// ============================================================
// 数据库初始化
// ============================================================
function ensureCircleTables(db) {
  // 圈子表
  db.exec(`
    CREATE TABLE IF NOT EXISTS circles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '新圈子',
      avatar TEXT DEFAULT '',
      intro TEXT DEFAULT '',
      color TEXT DEFAULT '#c9a0dc',
      character_id INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  try {
    db.exec(`ALTER TABLE circles ADD COLUMN character_id INTEGER`);
  } catch (e) {
    // 列已存在
  }

  // NPC表：独立于characters的NPC人物
  db.exec(`
    CREATE TABLE IF NOT EXISTS circle_npcs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER,
      name TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      intro TEXT DEFAULT '',
      gender TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      language_style TEXT DEFAULT '',
      background TEXT DEFAULT '',
      relationship TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      moments_enabled INTEGER DEFAULT 0,
      moments_mutual_with_chars INTEGER DEFAULT 1,
      moments_cover TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (circle_id) REFERENCES circles(id) ON DELETE SET NULL
    )
  `);

  // 为已存在的表添加 moments_cover / language_style 列（向后兼容）
  try {
    db.exec(`ALTER TABLE circle_npcs ADD COLUMN moments_cover TEXT DEFAULT ''`);
  } catch (e) {
    // 列已存在或其它错误，忽略
  }
  try {
    db.exec(`ALTER TABLE circle_npcs ADD COLUMN language_style TEXT DEFAULT ''`);
  } catch (e) {
    // 列已存在或其它错误，忽略
  }
  try {
    db.exec(`ALTER TABLE circle_npcs ADD COLUMN linked_character_id INTEGER DEFAULT NULL`);
  } catch (e) {
    // 列已存在
  }
  try {
    db.exec(`ALTER TABLE characters ADD COLUMN circle_npc_id INTEGER DEFAULT NULL`);
  } catch (e) {
    // 列已存在
  }

  // NPC朋友圈表：独立于主朋友圈
  db.exec(`
    CREATE TABLE IF NOT EXISTS circle_moments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      npc_id INTEGER NOT NULL,
      content TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      likes TEXT DEFAULT '[]',
      comments TEXT DEFAULT '[]',
      location TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (npc_id) REFERENCES circle_npcs(id) ON DELETE CASCADE
    )
  `);

  // NPC朋友圈评论（NPC对角色的评论、角色对NPC的评论）
  db.exec(`
    CREATE TABLE IF NOT EXISTS circle_moment_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      moment_id INTEGER NOT NULL,
      author_type TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      author_name TEXT NOT NULL,
      author_avatar TEXT DEFAULT '',
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (moment_id) REFERENCES circle_moments(id) ON DELETE CASCADE
    )
  `);

  // NPC通讯录：NPC之间的好友关系
  db.exec(`
    CREATE TABLE IF NOT EXISTS circle_friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      npc_id INTEGER NOT NULL,
      friend_type TEXT NOT NULL,
      friend_id INTEGER NOT NULL,
      remark TEXT DEFAULT '',
      status TEXT DEFAULT 'friend',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(npc_id, friend_type, friend_id),
      FOREIGN KEY (npc_id) REFERENCES circle_npcs(id) ON DELETE CASCADE
    )
  `);

  // NPC与角色之间的朋友圈互动记录
  db.exec(`
    CREATE TABLE IF NOT EXISTS circle_char_moments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      npc_id INTEGER NOT NULL,
      character_id INTEGER,
      moment_type TEXT NOT NULL,
      target_moment_id INTEGER,
      target_type TEXT DEFAULT 'char_moment',
      content TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (npc_id) REFERENCES circle_npcs(id) ON DELETE CASCADE,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    )
  `);

  // 添加索引
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_circle_npcs_circle ON circle_npcs(circle_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_circle_moments_npc ON circle_moments(npc_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_circle_friends_npc ON circle_friends(npc_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_circle_char_moments_npc ON circle_char_moments(npc_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_circle_char_moments_char ON circle_char_moments(character_id)`);
  } catch (e) {
    console.warn('[circle] index creation:', e.message);
  }
}

// ============================================================
// 圈子CRUD
// ============================================================
function listCircles(dbInstance, characterId = null) {
  const dbRef = dbInstance || db;
  const cid = characterId != null && characterId !== '' ? parseInt(characterId, 10) : null;
  if (cid > 0) {
    return dbRef.prepare(`
      SELECT c.*,
             (SELECT COUNT(*) FROM circle_npcs WHERE circle_id = c.id) as member_count
      FROM circles c
      WHERE c.character_id = ?
      ORDER BY c.sort_order, c.created_at DESC
    `).all(cid);
  }
  return dbRef.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM circle_npcs WHERE circle_id = c.id) as member_count
    FROM circles c
    ORDER BY c.sort_order, c.created_at DESC
  `).all();
}

function getCircle(dbInstance, id) {
  const dbRef = dbInstance || db;
  const row = dbRef.prepare('SELECT * FROM circles WHERE id=?').get(id);
  if (!row) return null;
  const members = dbRef.prepare('SELECT * FROM circle_npcs WHERE circle_id=? ORDER BY name').all(id);
  return { ...row, members };
}

function createCircle(dbInstance, data = {}) {
  const dbRef = dbInstance || db;
  const t = nowIso();
  const characterId = data.character_id != null && data.character_id !== ''
    ? parseInt(data.character_id, 10)
    : null;
  if (!(characterId > 0)) {
    throw new Error('请先选择角色');
  }
  const r = dbRef.prepare(`
    INSERT INTO circles (name, avatar, intro, color, character_id, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(data.name || '新圈子').trim().slice(0, 30),
    String(data.avatar || ''),
    String(data.intro || '').slice(0, 200),
    String(data.color || '#c9a0dc'),
    characterId,
    Number(data.sort_order || 0),
    t, t
  );
  return getCircle(dbRef, r.lastInsertRowid);
}

function updateCircle(dbInstance, id, data = {}) {
  const dbRef = dbInstance || db;
  const t = nowIso();
  const existing = dbRef.prepare('SELECT * FROM circles WHERE id=?').get(id);
  if (!existing) return null;
  const nextCharId = data.character_id !== undefined
    ? (parseInt(data.character_id, 10) || null)
    : existing.character_id;
  dbRef.prepare(`
    UPDATE circles SET
      name = ?,
      avatar = ?,
      intro = ?,
      color = ?,
      character_id = ?,
      sort_order = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    data.name !== undefined ? String(data.name || '').trim().slice(0, 30) : existing.name,
    data.avatar !== undefined ? String(data.avatar || '') : (existing.avatar || ''),
    data.intro !== undefined ? String(data.intro || '').slice(0, 200) : (existing.intro || ''),
    data.color !== undefined ? String(data.color || '#c9a0dc') : (existing.color || '#c9a0dc'),
    nextCharId,
    data.sort_order !== undefined ? Number(data.sort_order || 0) : (existing.sort_order || 0),
    t, id
  );
  return getCircle(dbRef, id);
}

function deleteCircle(dbInstance, id) {
  const dbRef = dbInstance || db;
  dbRef.prepare('UPDATE circle_npcs SET circle_id = NULL WHERE circle_id=?').run(id);
  dbRef.prepare('DELETE FROM circles WHERE id=?').run(id);
  return { ok: true };
}

// ============================================================
// NPC CRUD
// ============================================================
function listNpcs(dbInstance, circleId = null) {
  const dbRef = dbInstance || db;
  let sql = 'SELECT * FROM circle_npcs';
  let params = [];
  if (circleId) {
    sql += ' WHERE circle_id=?';
    params = [circleId];
  }
  sql += ' ORDER BY name';
  return dbRef.prepare(sql).all(...params).map(enrichNpc);
}

function getNpc(dbInstance, id) {
  const dbRef = dbInstance || db;
  const row = dbRef.prepare('SELECT * FROM circle_npcs WHERE id=?').get(id);
  if (!row) return null;
  return enrichNpc(row);
}

function enrichNpc(row) {
  if (!row) return row;
  return {
    ...row,
    moments_enabled: !!row.moments_enabled,
    moments_mutual_with_chars: !!row.moments_mutual_with_chars,
    friends_count: 0,
    moments_count: 0,
  };
}

function createNpc(dbInstance, data = {}) {
  const dbRef = dbInstance || db;
  const t = nowIso();
  const r = dbRef.prepare(`
    INSERT INTO circle_npcs (circle_id, name, avatar, intro, gender, personality, language_style, background, relationship, remark, moments_enabled, moments_mutual_with_chars, moments_cover, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.circle_id || null,
    String(data.name || '新NPC').trim().slice(0, 20),
    String(data.avatar || ''),
    String(data.intro || '').slice(0, 200),
    String(data.gender || ''),
    String(data.personality || '').slice(0, 500),
    String(data.language_style || '').slice(0, 2000),
    String(data.background || '').slice(0, 500),
    String(data.relationship || '').slice(0, 200),
    String(data.remark || '').slice(0, 40),
    data.moments_enabled ? 1 : 0,
    data.moments_mutual_with_chars !== false ? 1 : 0,
    String(data.moments_cover || ''),
    t, t
  );
  const npc = getNpc(dbRef, r.lastInsertRowid);
  try {
    const bridge = ensureNpcContactBridge(dbRef, npc);
    if (bridge?.npc) return bridge.npc;
  } catch (e) {
    console.warn('[circle] npc contact bridge', e.message);
  }
  return npc;
}

/** 圈子 NPC → 轻量角色 + 「新的朋友」申请（仅聊天/朋友圈评论权限） */
function ensureNpcContactBridge(dbInstance, npc, { pushNotify = true } = {}) {
  const dbRef = dbInstance || db;
  if (!npc?.id) return null;
  ensureCircleTables(dbRef);

  const contacts = require('./contact-helper');

  function ensurePendingRequest(characterId, forNpc) {
    const status = contacts.getContactStatus(dbRef, characterId);
    if (status === contacts.STATUS.FRIEND || status === contacts.STATUS.BLOCKED) {
      return { id: null, already: true, skipped: true };
    }
    const msg = String(forNpc.remark || '').trim()
      ? `我是${forNpc.name}，${String(forNpc.remark).trim().slice(0, 40)}`
      : `我是${forNpc.name}，想加你为好友`;
    const request = contacts.createFriendRequest(dbRef, characterId, {
      direction: 'from_char',
      message: msg.slice(0, 120),
    });
    if (pushNotify && request && !request.already) {
      try {
        const { push } = require('./push');
        push('friend_request', { characterId, requestId: request.id, from: 'circle_npc' });
      } catch {}
    }
    return request;
  }

  let linkedId = Number(npc.linked_character_id) || 0;
  if (linkedId > 0) {
    const existing = dbRef.prepare('SELECT id FROM characters WHERE id=?').get(linkedId);
    if (existing) {
      syncNpcToCharacter(dbRef, npc, linkedId);
      const request = ensurePendingRequest(linkedId, npc);
      return { npc: getNpc(dbRef, npc.id), characterId: linkedId, created: false, request };
    }
    linkedId = 0;
  }

  const byNpc = dbRef.prepare(
    `SELECT id FROM characters WHERE circle_npc_id=? LIMIT 1`
  ).get(npc.id);
  if (byNpc?.id) {
    linkedId = byNpc.id;
    try {
      dbRef.prepare('UPDATE circle_npcs SET linked_character_id=? WHERE id=?').run(linkedId, npc.id);
    } catch {}
    syncNpcToCharacter(dbRef, npc, linkedId);
    const request = ensurePendingRequest(linkedId, npc);
    return { npc: getNpc(dbRef, npc.id), characterId: linkedId, created: false, request };
  }

  const description = [
    npc.personality && `【性格】${npc.personality}`,
    npc.background && `【背景】${npc.background}`,
    npc.relationship && `【与用户关系】${npc.relationship}`,
  ].filter(Boolean).join('\n');

  const r = dbRef.prepare(`
    INSERT INTO characters (
      name, avatar, intro, opening, language_style, location_name, real_location,
      description, personality, background, behavior, relationship, relationship_custom,
      voice_id, voice_messages, memory_trigger_n, memory_summary_enabled, busy_style,
      allow_diary, post_moments, mutual_characters, image_ref, image_style,
      nsfw_enabled, nsfw_tags, nsfw_note, dream_affects_memory, birthday, anniversary,
      status, emoji_categories, memory_weights, worldbook_ids,
      proactive_msg_enabled, proactive_msg_minutes, proactive_call_enabled, emoji_enabled
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    String(npc.name || '新朋友').slice(0, 20),
    String(npc.avatar || ''),
    String(npc.intro || '').slice(0, 200),
    '',
    String(npc.language_style || '').slice(0, 2000),
    '', '',
    description,
    String(npc.personality || '').slice(0, 500),
    String(npc.background || '').slice(0, 500),
    '',
    String(npc.relationship || '圈子认识的朋友').slice(0, 200),
    '',
    '', 0, 10, 0, 'gentle',
    0, 0, '[]', '[]', 'anime',
    0, '[]', '', 0, '', '',
    'online', '[]', '{}', '[]',
    0, 60, 0, 1
  );
  linkedId = r.lastInsertRowid;

  try {
    dbRef.prepare('UPDATE characters SET source=?, circle_npc_id=?, diary_enabled=0, schedule_enabled=0 WHERE id=?')
      .run('circle_npc', npc.id, linkedId);
  } catch {
    try {
      dbRef.prepare('UPDATE characters SET source=?, circle_npc_id=? WHERE id=?')
        .run('circle_npc', npc.id, linkedId);
    } catch {}
  }

  try {
    dbRef.prepare('UPDATE circle_npcs SET linked_character_id=? WHERE id=?').run(linkedId, npc.id);
  } catch {}

  // 不自动加好友：走「新的朋友」申请
  const request = ensurePendingRequest(linkedId, npc);

  return {
    npc: getNpc(dbRef, npc.id),
    characterId: linkedId,
    created: true,
    request,
  };
}

function syncNpcToCharacter(dbInstance, npc, characterId) {
  const dbRef = dbInstance || db;
  const cid = Number(characterId || npc?.linked_character_id) || 0;
  if (!npc || !cid) return;
  const description = [
    npc.personality && `【性格】${npc.personality}`,
    npc.background && `【背景】${npc.background}`,
    npc.relationship && `【与用户关系】${npc.relationship}`,
  ].filter(Boolean).join('\n');
  try {
    dbRef.prepare(`
      UPDATE characters SET
        name=?, avatar=?, intro=?, language_style=?, description=?,
        personality=?, background=?, relationship=?,
        source='circle_npc', circle_npc_id=?,
        allow_diary=0, post_moments=0,
        proactive_msg_enabled=0, proactive_call_enabled=0
      WHERE id=?
    `).run(
      String(npc.name || '').slice(0, 20),
      String(npc.avatar || ''),
      String(npc.intro || '').slice(0, 200),
      String(npc.language_style || '').slice(0, 2000),
      description,
      String(npc.personality || '').slice(0, 500),
      String(npc.background || '').slice(0, 500),
      String(npc.relationship || '圈子认识的朋友').slice(0, 200),
      npc.id,
      cid
    );
  } catch (e) {
    console.warn('[circle] sync npc→char', e.message);
  }
}

function updateNpc(dbInstance, id, data = {}) {
  const dbRef = dbInstance || db;
  const t = nowIso();
  const existing = getNpc(dbRef, id);
  if (!existing) return null;

  const nextCircleId = data.circle_id !== undefined
    ? (data.circle_id ? parseInt(data.circle_id, 10) : null)
    : existing.circle_id;

  dbRef.prepare(`
    UPDATE circle_npcs SET
      circle_id = ?,
      name = ?,
      avatar = ?,
      intro = ?,
      gender = ?,
      personality = ?,
      language_style = ?,
      background = ?,
      relationship = ?,
      remark = ?,
      moments_enabled = ?,
      moments_mutual_with_chars = ?,
      moments_cover = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    nextCircleId,
    data.name !== undefined ? String(data.name || '').trim().slice(0, 20) : existing.name,
    data.avatar !== undefined ? String(data.avatar || '') : (existing.avatar || ''),
    data.intro !== undefined ? String(data.intro || '').slice(0, 200) : (existing.intro || ''),
    data.gender !== undefined ? String(data.gender || '') : (existing.gender || ''),
    data.personality !== undefined ? String(data.personality || '').slice(0, 500) : (existing.personality || ''),
    data.language_style !== undefined ? String(data.language_style || '').slice(0, 2000) : (existing.language_style || ''),
    data.background !== undefined ? String(data.background || '').slice(0, 500) : (existing.background || ''),
    data.relationship !== undefined ? String(data.relationship || '').slice(0, 200) : (existing.relationship || ''),
    data.remark !== undefined ? String(data.remark || '').slice(0, 40) : (existing.remark || ''),
    data.moments_enabled !== undefined ? (data.moments_enabled ? 1 : 0) : (existing.moments_enabled ? 1 : 0),
    data.moments_mutual_with_chars !== undefined ? (data.moments_mutual_with_chars ? 1 : 0) : (existing.moments_mutual_with_chars ? 1 : 0),
    data.moments_cover !== undefined ? String(data.moments_cover || '') : (existing.moments_cover || ''),
    t, id
  );
  const npc = getNpc(dbRef, id);
  try {
    if (npc?.linked_character_id) syncNpcToCharacter(dbRef, npc, npc.linked_character_id);
    else ensureNpcContactBridge(dbRef, npc, { pushNotify: false });
  } catch (e) {
    console.warn('[circle] sync on update', e.message);
  }
  return getNpc(dbRef, id);
}

function deleteNpc(dbInstance, id) {
  const dbRef = dbInstance || db;
  const npc = getNpc(dbRef, id);
  const linkedId = Number(npc?.linked_character_id) || 0;
  dbRef.prepare('DELETE FROM circle_moments WHERE npc_id=?').run(id);
  dbRef.prepare('DELETE FROM circle_friends WHERE npc_id=? OR (friend_type=? AND friend_id=?)').run(id, 'npc', id);
  dbRef.prepare('DELETE FROM circle_char_moments WHERE npc_id=?').run(id);
  dbRef.prepare('DELETE FROM circle_npcs WHERE id=?').run(id);
  if (linkedId > 0) {
    try {
      const contacts = require('./contact-helper');
      contacts.wipeCharacterTraces(dbRef, linkedId);
    } catch {}
    try { dbRef.prepare('DELETE FROM messages WHERE character_id=?').run(linkedId); } catch {}
    try { dbRef.prepare('DELETE FROM user_contacts WHERE character_id=?').run(linkedId); } catch {}
    try { dbRef.prepare('DELETE FROM friend_requests WHERE character_id=?').run(linkedId); } catch {}
    try { dbRef.prepare('DELETE FROM characters WHERE id=?').run(linkedId); } catch {}
  } else {
    try {
      const rows = dbRef.prepare(`SELECT id FROM characters WHERE circle_npc_id=?`).all(id) || [];
      for (const row of rows) {
        try { dbRef.prepare('DELETE FROM messages WHERE character_id=?').run(row.id); } catch {}
        try { dbRef.prepare('DELETE FROM user_contacts WHERE character_id=?').run(row.id); } catch {}
        try { dbRef.prepare('DELETE FROM friend_requests WHERE character_id=?').run(row.id); } catch {}
        try { dbRef.prepare('DELETE FROM characters WHERE id=?').run(row.id); } catch {}
      }
    } catch {}
  }
  return { ok: true };
}

function moveNpcToCircle(dbInstance, npcId, circleId) {
  const dbRef = dbInstance || db;
  const t = nowIso();
  dbRef.prepare('UPDATE circle_npcs SET circle_id=?, updated_at=? WHERE id=?').run(circleId || null, t, npcId);
  return getNpc(dbRef, npcId);
}

// ============================================================
// NPC朋友圈
// ============================================================
function getNpcMoments(dbInstance, npcId, { limit = 20, offset = 0 } = {}) {
  const dbRef = dbInstance || db;
  const moments = dbRef.prepare(`
    SELECT * FROM circle_moments
    WHERE npc_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(npcId, limit, offset);
  
  return moments.map(m => ({
    ...m,
    images: safeJson(m.images, []),
    likes: safeJson(m.likes, []),
    comments: safeJson(m.comments, []),
  }));
}

function getNpcMoment(dbInstance, id) {
  const dbRef = dbInstance || db;
  const m = dbRef.prepare('SELECT * FROM circle_moments WHERE id=?').get(id);
  if (!m) return null;
  return {
    ...m,
    images: safeJson(m.images, []),
    likes: safeJson(m.likes, []),
    comments: safeJson(m.comments, []),
  };
}

function createNpcMoment(dbInstance, data = {}) {
  const dbRef = dbInstance || db;
  const npc = getNpc(dbRef, data.npc_id);
  if (!npc) return null;
  
  const r = dbRef.prepare(`
    INSERT INTO circle_moments (npc_id, content, images, location, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    data.npc_id,
    String(data.content || '').slice(0, 500),
    JSON.stringify(data.images || []),
    String(data.location || '').slice(0, 50),
    nowIso()
  );
  return getNpcMoment(dbRef, r.lastInsertRowid);
}

function deleteNpcMoment(dbInstance, id) {
  const dbRef = dbInstance || db;
  dbRef.prepare('DELETE FROM circle_moment_comments WHERE moment_id=?').run(id);
  dbRef.prepare('DELETE FROM circle_moments WHERE id=?').run(id);
  return { ok: true };
}

function likeNpcMoment(dbInstance, momentId, likerName) {
  const dbRef = dbInstance || db;
  const m = getNpcMoment(dbRef, momentId);
  if (!m) return null;
  
  const likes = m.likes || [];
  if (!likes.includes(likerName)) {
    likes.push(likerName);
    dbRef.prepare('UPDATE circle_moments SET likes=? WHERE id=?').run(JSON.stringify(likes), momentId);
  }
  return getNpcMoment(dbRef, momentId);
}

function unlikeNpcMoment(dbInstance, momentId, likerName) {
  const dbRef = dbInstance || db;
  const m = getNpcMoment(dbRef, momentId);
  if (!m) return null;
  
  const likes = (m.likes || []).filter(n => n !== likerName);
  dbRef.prepare('UPDATE circle_moments SET likes=? WHERE id=?').run(JSON.stringify(likes), momentId);
  return getNpcMoment(dbRef, momentId);
}

function commentNpcMoment(dbInstance, momentId, comment) {
  const dbRef = dbInstance || db;
  const m = getNpcMoment(dbRef, momentId);
  if (!m) return null;
  
  const r = dbRef.prepare(`
    INSERT INTO circle_moment_comments (moment_id, author_type, author_id, author_name, author_avatar, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    momentId,
    comment.author_type || 'npc',
    comment.author_id || 0,
    String(comment.author_name || '匿名'),
    String(comment.author_avatar || ''),
    String(comment.content || '').slice(0, 200),
    nowIso()
  );
  
  return dbRef.prepare('SELECT * FROM circle_moment_comments WHERE id=?').get(r.lastInsertRowid);
}

function getNpcMomentComments(dbInstance, momentId) {
  const dbRef = dbInstance || db;
  return dbRef.prepare(`
    SELECT * FROM circle_moment_comments
    WHERE moment_id = ?
    ORDER BY created_at ASC
  `).all(momentId);
}

// ============================================================
// NPC朋友圈与角色朋友圈的互动
// ============================================================
function npcCommentCharMoment(dbInstance, data = {}) {
  const dbRef = dbInstance || db;
  const npc = getNpc(dbRef, data.npc_id);
  if (!npc) return { ok: false, error: 'npc_not_found' };
  
  // 检查NPC是否开启了与角色朋友圈互动
  if (!npc.moments_mutual_with_chars) {
    return { ok: false, error: 'mutual_disabled' };
  }
  
  const r = dbRef.prepare(`
    INSERT INTO circle_char_moments (npc_id, character_id, moment_type, target_moment_id, target_type, content, created_at)
    VALUES (?, ?, 'comment', ?, 'char_moment', ?, ?)
  `).run(
    data.npc_id,
    data.character_id,
    data.target_moment_id,
    String(data.content || '').slice(0, 200),
    nowIso()
  );
  
  return { ok: true, id: r.lastInsertRowid };
}

function charCommentNpcMoment(dbInstance, data = {}) {
  const dbRef = dbInstance || db;
  const npc = getNpc(dbRef, data.npc_id);
  if (!npc) return { ok: false, error: 'npc_not_found' };
  
  if (!npc.moments_mutual_with_chars) {
    return { ok: false, error: 'mutual_disabled' };
  }
  
  const r = dbRef.prepare(`
    INSERT INTO circle_moment_comments (moment_id, author_type, author_id, author_name, author_avatar, content, created_at)
    VALUES (?, 'char', ?, ?, ?, ?, ?)
  `).run(
    data.moment_id,
    data.character_id,
    String(data.character_name || '用户'),
    String(data.character_avatar || ''),
    String(data.content || '').slice(0, 200),
    nowIso()
  );
  
  return { ok: true, id: r.lastInsertRowid };
}

// ============================================================
// NPC通讯录 / 好友关系
// ============================================================
const FRIEND_TYPE_NPC = 'npc';
const FRIEND_TYPE_CHAR = 'char';

function listNpcFriends(dbInstance, npcId) {
  const dbRef = dbInstance || db;
  const rows = dbRef.prepare(`
    SELECT cf.*, 
           CASE cf.friend_type
             WHEN 'npc' THEN (SELECT name FROM circle_npcs WHERE id = cf.friend_id)
             WHEN 'char' THEN (SELECT name FROM characters WHERE id = cf.friend_id)
             ELSE '未知'
           END as friend_name,
           CASE cf.friend_type
             WHEN 'npc' THEN (SELECT avatar FROM circle_npcs WHERE id = cf.friend_id)
             WHEN 'char' THEN (SELECT avatar FROM characters WHERE id = cf.friend_id)
             ELSE ''
           END as friend_avatar
    FROM circle_friends cf
    WHERE cf.npc_id = ? AND cf.status = 'friend'
    ORDER BY friend_name
  `).all(npcId);
  
  return rows.map(r => ({
    ...r,
    friend_type: r.friend_type,
  }));
}

function listAddableFriends(dbInstance, npcId) {
  const dbRef = dbInstance || db;
  // 获取所有NPC（排除自己）
  const npcs = dbRef.prepare(`
    SELECT id, name, avatar FROM circle_npcs WHERE id != ? AND id NOT IN (
      SELECT friend_id FROM circle_friends WHERE npc_id = ? AND friend_type = 'npc' AND status = 'friend'
    )
  `).all(npcId, npcId);
  
  // 获取所有角色（排除已添加的）
  const chars = dbRef.prepare(`
    SELECT id, name, avatar FROM characters WHERE id NOT IN (
      SELECT friend_id FROM circle_friends WHERE npc_id = ? AND friend_type = 'char' AND status = 'friend'
    )
  `).all(npcId);
  
  return {
    npcs: npcs.map(n => ({ type: 'npc', id: n.id, name: n.name, avatar: n.avatar })),
    chars: chars.map(c => ({ type: 'char', id: c.id, name: c.name, avatar: c.avatar })),
  };
}

function addNpcFriend(dbInstance, npcId, friendType, friendId) {
  const dbRef = dbInstance || db;
  
  // 检查是否已存在
  const existing = dbRef.prepare(`
    SELECT * FROM circle_friends WHERE npc_id=? AND friend_type=? AND friend_id=? AND status='friend'
  `).get(npcId, friendType, friendId);
  
  if (existing) return { ok: false, error: 'already_friend' };
  
  const t = nowIso();
  dbRef.prepare(`
    INSERT INTO circle_friends (npc_id, friend_type, friend_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'friend', ?, ?)
  `).run(npcId, friendType, friendId, t, t);
  
  return { ok: true };
}

function removeNpcFriend(dbInstance, npcId, friendType, friendId) {
  const dbRef = dbInstance || db;
  dbRef.prepare(`
    DELETE FROM circle_friends WHERE npc_id=? AND friend_type=? AND friend_id=?
  `).run(npcId, friendType, friendId);
  return { ok: true };
}

function setNpcFriendRemark(dbInstance, npcId, friendType, friendId, remark) {
  const dbRef = dbInstance || db;
  const t = nowIso();
  dbRef.prepare(`
    UPDATE circle_friends SET remark=?, updated_at=? WHERE npc_id=? AND friend_type=? AND friend_id=?
  `).run(String(remark || '').slice(0, 40), t, npcId, friendType, friendId);
  return { ok: true };
}

// ============================================================
// 获取NPC的综合信息（用于AI上下文）
// ============================================================
function buildNpcContextPrompt(dbInstance, npcId) {
  const dbRef = dbInstance || db;
  const npc = getNpc(dbRef, npcId);
  if (!npc) return '';
  
  const friends = listNpcFriends(dbRef, npcId);
  const moments = getNpcMoments(dbRef, npcId, { limit: 5 });
  
  const parts = [];
  parts.push(`【NPC信息】${npc.name}`);
  if (npc.remark) parts.push(`备注：${npc.remark}`);
  if (npc.intro) parts.push(`简介：${npc.intro}`);
  if (npc.personality) parts.push(`性格：${npc.personality}`);
  if (npc.language_style) parts.push(`语言风格（说话时参考）：\n${npc.language_style}`);
  if (npc.relationship) parts.push(`与用户关系：${npc.relationship}`);
  
  if (friends.length) {
    const friendNames = friends.map(f => f.friend_name).join('、');
    parts.push(`朋友圈好友：${friendNames}`);
  }
  
  if (moments.length) {
    parts.push(`最近动态：`);
    moments.slice(0, 3).forEach(m => {
      parts.push(`- ${m.content.slice(0, 50)}${m.content.length > 50 ? '...' : ''}`);
    });
  }
  
  return parts.join('\n');
}

// ============================================================
// 初始化（由server.js调用）
// ============================================================
function migrateExistingNpcsToContacts(dbInstance) {
  const dbRef = dbInstance || db;
  let n = 0;
  const rows = dbRef.prepare(`
    SELECT * FROM circle_npcs
    WHERE linked_character_id IS NULL OR linked_character_id = 0
  `).all() || [];
  for (const row of rows) {
    try {
      const bridge = ensureNpcContactBridge(dbRef, row, { pushNotify: false });
      if (bridge?.created) n += 1;
    } catch (e) {
      console.warn('[circle] migrate npc bridge', row?.id, e.message);
    }
  }
  if (n) console.log(`[circle] linked ${n} existing NPC(s) → friend requests`);
}

function initCircleModule() {
  try {
    ensureCircleTables(db);
    // 旧数据没有 character_id：挂到第一个角色上，避免进圈子时全部消失
    try {
      const orphans = db.prepare(`
        SELECT COUNT(*) AS n FROM circles
        WHERE character_id IS NULL OR character_id = 0
      `).get();
      if ((orphans?.n || 0) > 0) {
        const first = db.prepare('SELECT id FROM characters ORDER BY id ASC LIMIT 1').get();
        if (first?.id) {
          db.prepare(`
            UPDATE circles SET character_id=?
            WHERE character_id IS NULL OR character_id = 0
          `).run(first.id);
          console.log(`[circle] migrated ${orphans.n} orphan circle(s) → character ${first.id}`);
        }
      }
    } catch (e) {
      console.warn('[circle] migrate character_id', e.message);
    }
    try {
      migrateExistingNpcsToContacts(db);
    } catch (e) {
      console.warn('[circle] migrate npc contacts', e.message);
    }
    console.log('[circle] module initialized');
  } catch (e) {
    console.error('[circle] init failed:', e.message);
  }
}

module.exports = {
  initCircleModule,
  ensureCircleTables,
  // 圈子
  listCircles,
  getCircle,
  createCircle,
  updateCircle,
  deleteCircle,
  // NPC
  listNpcs,
  getNpc,
  createNpc,
  updateNpc,
  deleteNpc,
  moveNpcToCircle,
  enrichNpc,
  ensureNpcContactBridge,
  syncNpcToCharacter,
  migrateExistingNpcsToContacts,
  // NPC朋友圈
  getNpcMoments,
  getNpcMoment,
  createNpcMoment,
  deleteNpcMoment,
  likeNpcMoment,
  unlikeNpcMoment,
  commentNpcMoment,
  getNpcMomentComments,
  // NPC-角色朋友圈互动
  npcCommentCharMoment,
  charCommentNpcMoment,
  // NPC通讯录
  FRIEND_TYPE_NPC,
  FRIEND_TYPE_CHAR,
  listNpcFriends,
  listAddableFriends,
  addNpcFriend,
  removeNpcFriend,
  setNpcFriendRemark,
  // 上下文
  buildNpcContextPrompt,
};

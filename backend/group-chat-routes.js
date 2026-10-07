/**
 * 群聊 REST：创建/列表/消息/触发编排
 */
function registerGroupChatRoutes(app, {
  db,
  getSettings,
  push,
  buildSystemPrompt,
  withCharChatPrefs,
  groupChat,
}) {
  const {
    parseMemberIds,
    getGroupWithMembers,
    loadGroupHistory,
    insertGroupMessage,
    orchestrateGroupReplies,
    defaultGroupTitle,
    normalizeTalk,
  } = groupChat;

  function mapGroupRow(group, members) {
    const ids = parseMemberIds(group.member_ids);
    const mems = members || ids.map((id) => db.prepare('SELECT id, name, avatar, status, group_talkativeness, chat_model FROM characters WHERE id=?').get(id)).filter(Boolean);
    return {
      id: group.id,
      title: group.title || defaultGroupTitle(mems),
      avatar: group.avatar || '',
      member_ids: ids,
      members: mems.map((m) => ({
        id: m.id,
        name: m.name,
        avatar: m.avatar || '',
        status: m.status || 'online',
        group_talkativeness: normalizeTalk(m.group_talkativeness),
        chat_model: m.chat_model || '',
      })),
      created_at: group.created_at,
      updated_at: group.updated_at,
    };
  }

  app.get('/api/groups', (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM group_chats ORDER BY updated_at DESC, id DESC').all() || [];
      res.json(rows.map((g) => mapGroupRow(g)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/groups/unread-summary', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT group_id, COUNT(*) AS n FROM group_messages
        WHERE role='assistant' AND COALESCE(is_read,0)=0
        GROUP BY group_id
      `).all() || [];
      const out = {};
      rows.forEach((r) => { out[r.group_id] = r.n; });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/groups/:id', (req, res) => {
    const pack = getGroupWithMembers(db, req.params.id);
    if (!pack) return res.status(404).json({ error: '群不存在' });
    res.json(mapGroupRow(pack.group, pack.members));
  });

  app.post('/api/groups', (req, res) => {
    try {
      const body = req.body || {};
      let ids = Array.isArray(body.member_ids) ? body.member_ids.map((x) => parseInt(x, 10)).filter((n) => n > 0) : [];
      ids = [...new Set(ids)];
      if (ids.length < 2) return res.status(400).json({ error: '群聊至少选 2 个角色' });
      const members = ids.map((id) => db.prepare('SELECT * FROM characters WHERE id=?').get(id)).filter(Boolean);
      if (members.length < 2) return res.status(400).json({ error: '角色无效' });
      const title = String(body.title || '').trim() || defaultGroupTitle(members);
      const avatar = String(body.avatar || '').trim();
      const r = db.prepare(`
        INSERT INTO group_chats (title, avatar, member_ids, created_at, updated_at)
        VALUES (?,?,?,datetime('now'),datetime('now'))
      `).run(title, avatar, JSON.stringify(ids));
      const group = db.prepare('SELECT * FROM group_chats WHERE id=?').get(r.lastInsertRowid);
      res.json(mapGroupRow(group, members));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/groups/:id', (req, res) => {
    const pack = getGroupWithMembers(db, req.params.id);
    if (!pack) return res.status(404).json({ error: '群不存在' });
    const body = req.body || {};
    let title = pack.group.title;
    let avatar = pack.group.avatar;
    let memberIds = parseMemberIds(pack.group.member_ids);
    if (body.title !== undefined) title = String(body.title || '').trim();
    if (body.avatar !== undefined) avatar = String(body.avatar || '').trim();
    if (body.member_ids !== undefined) {
      memberIds = [...new Set((body.member_ids || []).map((x) => parseInt(x, 10)).filter((n) => n > 0))];
      if (memberIds.length < 2) return res.status(400).json({ error: '群聊至少 2 个角色' });
    }
    db.prepare(`UPDATE group_chats SET title=?, avatar=?, member_ids=?, updated_at=datetime('now') WHERE id=?`)
      .run(title, avatar, JSON.stringify(memberIds), pack.group.id);
    const next = getGroupWithMembers(db, pack.group.id);
    res.json(mapGroupRow(next.group, next.members));
  });

  app.delete('/api/groups/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM group_messages WHERE group_id=?').run(id);
    db.prepare('DELETE FROM group_chats WHERE id=?').run(id);
    res.json({ ok: true });
  });

  app.get('/api/groups/:id/messages', (req, res) => {
    const pack = getGroupWithMembers(db, req.params.id);
    if (!pack) return res.status(404).json({ error: '群不存在' });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 80));
    const beforeId = parseInt(req.query.beforeId, 10);
    let rows;
    if (Number.isFinite(beforeId) && beforeId > 0) {
      rows = db.prepare(`
        SELECT * FROM group_messages WHERE group_id=? AND id<? ORDER BY id DESC LIMIT ?
      `).all(pack.group.id, beforeId, limit).reverse();
    } else {
      rows = loadGroupHistory(db, pack.group.id, limit);
    }
    res.json(rows);
  });

  app.post('/api/groups/:id/messages', async (req, res) => {
    try {
      const pack = getGroupWithMembers(db, req.params.id);
      if (!pack) return res.status(404).json({ error: '群不存在' });
      const content = String(req.body?.content || '').trim();
      if (!content) return res.status(400).json({ error: '空消息' });
      const noReply = !!req.body?.noReply;
      const row = insertGroupMessage(db, {
        groupId: pack.group.id,
        role: 'user',
        content,
        type: 'text',
      });
      push?.('group_message', { groupId: pack.group.id, message: row, speakerCharacterId: null });

      if (noReply) {
        return res.json({ userMsg: row, noReply: true });
      }

      const plan = await orchestrateGroupReplies({
        db,
        groupId: pack.group.id,
        userText: content,
        push,
        getSettings,
        buildSystemPrompt,
        withCharChatPrefs,
      });
      res.json({ userMsg: row, plan });
    } catch (e) {
      console.error('[group-messages]', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/groups/:id/trigger', async (req, res) => {
    try {
      const pack = getGroupWithMembers(db, req.params.id);
      if (!pack) return res.status(404).json({ error: '群不存在' });
      const lastUser = db.prepare(`
        SELECT * FROM group_messages WHERE group_id=? AND role='user' ORDER BY id DESC LIMIT 1
      `).get(pack.group.id);
      const userText = String(req.body?.content || lastUser?.content || '').trim();
      if (!userText) return res.status(400).json({ error: '没有可回复的用户消息' });

      const plan = await orchestrateGroupReplies({
        db,
        groupId: pack.group.id,
        userText,
        push,
        getSettings,
        buildSystemPrompt,
        withCharChatPrefs,
      });
      res.json({ plan });
    } catch (e) {
      console.error('[group-trigger]', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/groups/:id/read', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      db.prepare(`UPDATE group_messages SET is_read=1 WHERE group_id=? AND role='assistant' AND COALESCE(is_read,0)=0`).run(id);
    } catch {}
    res.json({ ok: true });
  });
}

module.exports = { registerGroupChatRoutes };

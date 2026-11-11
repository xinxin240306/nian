/**
 * 虚拟贴吧 REST
 */
function registerTiebaRoutes(app, { tieba }) {
  const {
    ensureTiebaTables,
    registerAccount,
    loginAccount,
    setupIdentity,
    updateAccount,
    logoutToken,
    getAccountFromReq,
    requireAccount,
    mapAccount,
    readToken,
    listBars,
    getBar,
    createBar,
    listThreads,
    getThread,
    createThread,
    listPosts,
    replyThread,
    setThreadPinned,
    deleteThread,
    refreshBarNpcPosts,
    tiebaBarBusy,
    refreshThreadNpcReplies,
    barHasNpcThreads,
    tiebaBarHandles,
    respondToTiebaUser,
    listMyTiebaPosts,
    tiebaPerson,
    settleBarPersonaHandles,
    settleTiebaContacts,
  } = tieba;

  function ensure(res) {
    try {
      ensureTiebaTables();
      return true;
    } catch (e) {
      console.error('[tieba] ensure tables', e);
      res.status(500).json({ error: `贴吧数据未就绪：${e.message}` });
      return false;
    }
  }

  function attachTokenCookie(res, token) {
    if (!token) return;
    res.setHeader('Set-Cookie', `nian_tieba_token=${encodeURIComponent(token)}; Path=/; Max-Age=${90 * 24 * 3600}; SameSite=Lax`);
  }

  app.get('/api/tieba/health', (req, res) => {
    if (!ensure(res)) return;
    res.json({ ok: true, feature: 'tieba' });
  });

  app.get('/api/tieba/me', (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = getAccountFromReq(req);
      res.json({ loggedIn: !!acc, account: mapAccount(acc) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/tieba/setup', (req, res) => {
    try {
      if (!ensure(res)) return;
      const body = req.body || {};
      const result = setupIdentity({
        username: body.username,
        password: body.password,
        avatar: body.avatar,
        signature: body.signature,
      });
      attachTokenCookie(res, result.token);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch('/api/tieba/me', (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = requireAccount(req, res);
      if (!acc) return;
      const account = updateAccount(acc.id, req.body || {});
      res.json({ account });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/tieba/register', (req, res) => {
    try {
      if (!ensure(res)) return;
      const body = req.body || {};
      const result = registerAccount(body.username, body.password, {
        avatar: body.avatar,
        signature: body.signature,
      });
      attachTokenCookie(res, result.token);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/tieba/login', (req, res) => {
    try {
      if (!ensure(res)) return;
      const body = req.body || {};
      const result = loginAccount(body.username, body.password);
      attachTokenCookie(res, result.token);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/tieba/logout', (req, res) => {
    try {
      if (!ensure(res)) return;
      logoutToken(readToken(req));
      res.setHeader('Set-Cookie', 'nian_tieba_token=; Path=/; Max-Age=0; SameSite=Lax');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/tieba/bars', (req, res) => {
    try {
      if (!ensure(res)) return;
      const bars = listBars({
        q: req.query.q || '',
        limit: req.query.limit,
        cityMode: req.query.cityMode === 'split' ? 'split' : 'merge',
        account: getAccountFromReq(req),
      });
      res.json(bars);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/tieba/bars/:id', (req, res) => {
    try {
      if (!ensure(res)) return;
      const bar = getBar(req.params.id, getAccountFromReq(req));
      if (!bar) return res.status(404).json({ error: '吧不存在' });
      res.json(bar);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/tieba/bars', (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = requireAccount(req, res);
      if (!acc) return;
      const bar = createBar(acc, req.body || {});
      res.json(bar);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/tieba/bars/:id/threads', async (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = getAccountFromReq(req);
      let bar = getBar(req.params.id, acc);
      if (!bar) return res.status(404).json({ error: '吧不存在' });
      const sort = ['live', 'hot', 'new'].includes(req.query.sort) ? req.query.sort : 'live';
      const offset = parseInt(req.query.offset, 10) || 0;
      const asked = String(req.query.refresh || '') === '1';
      if (offset === 0 && (asked || !barHasNpcThreads(bar.id))) {
        const job = refreshBarNpcPosts(bar.id);
        if (asked) {
          await job;
          bar = getBar(bar.id, acc) || bar;
        } else {
          job.catch((err) => console.warn('[tieba] npc threads', err.message));
        }
      }
      bar.generating = tiebaBarBusy(bar.id);
      try { await settleBarPersonaHandles(bar.id); } catch (e) { console.warn('[tieba] handles', e.message); }
      bar.cast_handles = tiebaBarHandles(bar.id);
      const threads = listThreads(bar.id, {
        limit: req.query.limit,
        offset,
        sort,
      });
      res.json({ bar, threads });
    } catch (e) {
      console.warn('[tieba] threads', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/tieba/bars/:id/threads', (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = requireAccount(req, res);
      if (!acc) return;
      const thread = createThread(acc, req.params.id, req.body || {});
      res.json(thread);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/tieba/threads/:id', async (req, res) => {
    try {
      if (!ensure(res)) return;
      const offset = parseInt(req.query.offset, 10) || 0;
      if (String(req.query.refresh || '') === '1' && offset === 0) {
        await refreshThreadNpcReplies(req.params.id);
      }
      const thread = getThread(req.params.id);
      if (!thread) return res.status(404).json({ error: '帖子不存在' });
      const bar = getBar(thread.bar_id, getAccountFromReq(req));
      if (bar) {
        try { await settleBarPersonaHandles(bar.id); } catch (e) { console.warn('[tieba] handles', e.message); }
        bar.cast_handles = tiebaBarHandles(bar.id);
      }
      const posts = listPosts(thread.id, {
        limit: req.query.limit,
        offset,
      });
      res.json({ thread, posts, bar });
    } catch (e) {
      console.warn('[tieba] thread', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/tieba/me/posts', (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = requireAccount(req, res);
      if (!acc) return;
      res.json({ posts: listMyTiebaPosts(acc.id) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/tieba/contacts', async (req, res) => {
    try {
      if (!ensure(res)) return;
      res.json({ contacts: await settleTiebaContacts() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/tieba/people/:handle', (req, res) => {
    try {
      if (!ensure(res)) return;
      const person = tiebaPerson(req.params.handle);
      if (!person) return res.status(404).json({ error: '没有这个吧友' });
      res.json(person);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/tieba/threads/:id/replies', async (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = requireAccount(req, res);
      if (!acc) return;
      const body = req.body || {};
      const post = replyThread(acc, req.params.id, body.content, body.replyToFloor);
      let followups = [];
      try {
        followups = await respondToTiebaUser(req.params.id, post);
      } catch (e) {
        console.warn('[tieba] reply npc', e.message);
      }
      res.json({ post, followups });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/tieba/threads/:id/pin', (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = requireAccount(req, res);
      if (!acc) return;
      const thread = setThreadPinned(acc, req.params.id, !!(req.body || {}).pinned);
      res.json(thread);
    } catch (e) {
      const status = e.needsTiebaAuth ? 401 : 400;
      res.status(status).json({ error: e.message, needsTiebaAuth: !!e.needsTiebaAuth });
    }
  });

  app.delete('/api/tieba/threads/:id', (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = requireAccount(req, res);
      if (!acc) return;
      res.json(deleteThread(acc, req.params.id));
    } catch (e) {
      const status = e.needsTiebaAuth ? 401 : 400;
      res.status(status).json({ error: e.message, needsTiebaAuth: !!e.needsTiebaAuth });
    }
  });
}

module.exports = { registerTiebaRoutes };

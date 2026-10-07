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
      const bars = listBars({ q: req.query.q || '', limit: req.query.limit });
      res.json(bars);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/tieba/bars/:id', (req, res) => {
    try {
      if (!ensure(res)) return;
      const bar = getBar(req.params.id);
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

  app.get('/api/tieba/bars/:id/threads', (req, res) => {
    try {
      if (!ensure(res)) return;
      const bar = getBar(req.params.id);
      if (!bar) return res.status(404).json({ error: '吧不存在' });
      const threads = listThreads(bar.id, {
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ bar, threads });
    } catch (e) {
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

  app.get('/api/tieba/threads/:id', (req, res) => {
    try {
      if (!ensure(res)) return;
      const thread = getThread(req.params.id);
      if (!thread) return res.status(404).json({ error: '帖子不存在' });
      const posts = listPosts(thread.id, {
        limit: req.query.limit,
        offset: req.query.offset,
      });
      const bar = getBar(thread.bar_id);
      res.json({ thread, posts, bar });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/tieba/threads/:id/replies', (req, res) => {
    try {
      if (!ensure(res)) return;
      const acc = requireAccount(req, res);
      if (!acc) return;
      const post = replyThread(acc, req.params.id, (req.body || {}).content);
      res.json(post);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = { registerTiebaRoutes };

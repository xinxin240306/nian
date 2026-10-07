/**
 * 虚拟贴吧：吧 / 帖 / 盖楼 + 贴吧账号（仅用户名密码）
 */
const crypto = require('crypto');
const db = require('./db');

const SESSION_DAYS = 90;
const TOKEN_HEADER = 'x-tieba-token';

const DEFAULT_BARS = [
  { name: '念吧', slogan: '穿越者的聚集地', color: '#c9a0dc' },
  { name: '异世界日常吧', slogan: '分享今天发生的小事', color: '#74b9ff' },
  { name: '吐槽吧', slogan: '有话直说，轻点喷', color: '#fd79a8' },
  { name: '情书吧', slogan: '写给TA，也写给自己', color: '#fdcb6e' },
];

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function safeName(raw, max = 20) {
  return String(raw || '').trim().slice(0, max);
}

function ensureTiebaTables() {
  const d = db.getDB();
  d.run(`
    CREATE TABLE IF NOT EXISTS tieba_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      signature TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  try { d.run(`ALTER TABLE tieba_accounts ADD COLUMN signature TEXT DEFAULT ''`); } catch {}
  try { d.run(`ALTER TABLE tieba_accounts ADD COLUMN avatar TEXT DEFAULT ''`); } catch {}
  d.run(`
    CREATE TABLE IF NOT EXISTS tieba_sessions (
      token TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES tieba_accounts(id) ON DELETE CASCADE
    )
  `);
  d.run(`
    CREATE TABLE IF NOT EXISTS tieba_bars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slogan TEXT DEFAULT '',
      color TEXT DEFAULT '#c9a0dc',
      avatar TEXT DEFAULT '',
      creator_id INTEGER,
      member_count INTEGER DEFAULT 0,
      thread_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  d.run(`
    CREATE TABLE IF NOT EXISTS tieba_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bar_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_id INTEGER,
      author_name TEXT NOT NULL,
      author_avatar TEXT DEFAULT '',
      reply_count INTEGER DEFAULT 0,
      last_floor INTEGER DEFAULT 1,
      last_reply_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (bar_id) REFERENCES tieba_bars(id) ON DELETE CASCADE
    )
  `);
  d.run(`
    CREATE TABLE IF NOT EXISTS tieba_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      floor INTEGER NOT NULL,
      content TEXT NOT NULL,
      author_id INTEGER,
      author_name TEXT NOT NULL,
      author_avatar TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES tieba_threads(id) ON DELETE CASCADE
    )
  `);
  d.run(`CREATE INDEX IF NOT EXISTS idx_tieba_threads_bar ON tieba_threads(bar_id, last_reply_at DESC)`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_tieba_posts_thread ON tieba_posts(thread_id, floor)`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_tieba_sessions_account ON tieba_sessions(account_id)`);

  seedDefaultBars();
}

function seedDefaultBars() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM tieba_bars').get()?.n || 0;
  if (count > 0) return;
  const now = nowIso();
  for (const b of DEFAULT_BARS) {
    db.prepare(`
      INSERT INTO tieba_bars (name, slogan, color, member_count, thread_count, created_at)
      VALUES (?, ?, ?, 0, 0, ?)
    `).run(b.name, b.slogan, b.color, now);
  }
}

function mapAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    avatar: row.avatar || '',
    signature: row.signature || '',
    created_at: row.created_at,
  };
}

function createSession(accountId) {
  const token = makeToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO tieba_sessions (token, account_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(token, accountId, expires, nowIso());
  return { token, expires_at: expires };
}

function readToken(req) {
  const h = String(req.headers?.[TOKEN_HEADER] || req.headers?.['x-tieba-token'] || '').trim();
  if (h) return h;
  const auth = String(req.headers?.authorization || '');
  if (/^Tieba\s+/i.test(auth)) return auth.replace(/^Tieba\s+/i, '').trim();
  // 兼容：query / cookie，避免个别环境自定义头被拦
  const q = String(req.query?.tiebaToken || req.query?.token || '').trim();
  if (q) return q;
  const cookie = String(req.headers?.cookie || '');
  const m = cookie.match(/(?:^|;\s*)nian_tieba_token=([^;]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return '';
}

function getAccountFromReq(req) {
  const token = readToken(req);
  if (!token) return null;
  const sess = db.prepare('SELECT * FROM tieba_sessions WHERE token=?').get(token);
  if (!sess) return null;
  if (new Date(String(sess.expires_at).replace(' ', 'T')).getTime() < Date.now()) {
    try { db.prepare('DELETE FROM tieba_sessions WHERE token=?').run(token); } catch {}
    return null;
  }
  return db.prepare('SELECT * FROM tieba_accounts WHERE id=?').get(sess.account_id) || null;
}

function requireAccount(req, res) {
  const acc = getAccountFromReq(req);
  if (!acc) {
    res.status(401).json({ error: '请先登录贴吧账号', needsTiebaAuth: true });
    return null;
  }
  return acc;
}

function registerAccount(username, password, extra = {}) {
  const name = safeName(username, 16);
  if (!name || name.length < 2) throw new Error('用户名至少 2 个字');
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(name)) throw new Error('用户名只能用中英文、数字和下划线');
  let pwd = String(password || '');
  // 本地虚拟贴吧允许不设密码：自动生成，前端只做一次身份设置
  if (pwd.length > 0 && pwd.length < 4) throw new Error('密码至少 4 位');
  if (!pwd) pwd = crypto.randomBytes(16).toString('hex');
  const exists = db.prepare('SELECT id FROM tieba_accounts WHERE username=?').get(name);
  if (exists) throw new Error('这个用户名已被占用');
  const salt = makeSalt();
  const password_hash = hashPassword(pwd, salt);
  const avatar = String(extra.avatar || '').trim().slice(0, 500);
  const signature = String(extra.signature || '').trim().slice(0, 40);
  const r = db.prepare(`
    INSERT INTO tieba_accounts (username, password_hash, salt, avatar, signature, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, password_hash, salt, avatar, signature, nowIso());
  const account = db.prepare('SELECT * FROM tieba_accounts WHERE id=?').get(r.lastInsertRowid);
  const session = createSession(account.id);
  return { account: mapAccount(account), ...session };
}

function loginAccount(username, password) {
  const name = safeName(username, 16);
  const acc = db.prepare('SELECT * FROM tieba_accounts WHERE username=?').get(name);
  if (!acc) throw new Error('用户名或密码不对');
  const hash = hashPassword(password, acc.salt);
  const a = Buffer.from(hash);
  const b = Buffer.from(acc.password_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('用户名或密码不对');
  }
  const session = createSession(acc.id);
  return { account: mapAccount(acc), ...session };
}

/** 单机场景：已有账号则直接续期登录，没有则创建 */
function setupIdentity({ username, password, avatar, signature } = {}) {
  const name = safeName(username, 16);
  if (!name || name.length < 2) throw new Error('请填写吧名（至少 2 个字）');
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(name)) throw new Error('吧名只能用中英文、数字和下划线');
  const existing = db.prepare('SELECT * FROM tieba_accounts WHERE username=?').get(name);
  if (existing) {
    // 同名已存在：无密码或密码正确则续期；否则要求换名
    const pwd = String(password || '');
    if (pwd) {
      const hash = hashPassword(pwd, existing.salt);
      const a = Buffer.from(hash);
      const b = Buffer.from(existing.password_hash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new Error('这个吧名已被占用，请换一个');
      }
    }
    const avatarVal = avatar !== undefined ? String(avatar || '').trim().slice(0, 500) : existing.avatar;
    const sigVal = signature !== undefined ? String(signature || '').trim().slice(0, 40) : existing.signature;
    db.prepare(`
      UPDATE tieba_accounts SET avatar=?, signature=? WHERE id=?
    `).run(avatarVal, sigVal, existing.id);
    const account = db.prepare('SELECT * FROM tieba_accounts WHERE id=?').get(existing.id);
    const session = createSession(account.id);
    return { account: mapAccount(account), ...session };
  }
  return registerAccount(name, password, { avatar, signature });
}

function updateAccount(accountId, data = {}) {
  const existing = db.prepare('SELECT * FROM tieba_accounts WHERE id=?').get(accountId);
  if (!existing) throw new Error('账号不存在');
  let username = existing.username;
  if (data.username !== undefined) {
    username = safeName(data.username, 16);
    if (!username || username.length < 2) throw new Error('吧名至少 2 个字');
    if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(username)) throw new Error('吧名只能用中英文、数字和下划线');
    const clash = db.prepare('SELECT id FROM tieba_accounts WHERE username=? AND id!=?').get(username, accountId);
    if (clash) throw new Error('这个吧名已被占用');
  }
  const avatar = data.avatar !== undefined ? String(data.avatar || '').trim().slice(0, 500) : (existing.avatar || '');
  const signature = data.signature !== undefined ? String(data.signature || '').trim().slice(0, 40) : (existing.signature || '');
  db.prepare(`
    UPDATE tieba_accounts SET username=?, avatar=?, signature=? WHERE id=?
  `).run(username, avatar, signature, accountId);
  return mapAccount(db.prepare('SELECT * FROM tieba_accounts WHERE id=?').get(accountId));
}

function logoutToken(token) {
  if (!token) return;
  db.prepare('DELETE FROM tieba_sessions WHERE token=?').run(token);
}

function mapBar(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slogan: row.slogan || '',
    color: row.color || '#c9a0dc',
    avatar: row.avatar || '',
    creator_id: row.creator_id || null,
    member_count: row.member_count || 0,
    thread_count: row.thread_count || 0,
    created_at: row.created_at,
  };
}

function listBars({ q = '', limit = 50 } = {}) {
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  let rows;
  if (q) {
    rows = db.prepare(`
      SELECT * FROM tieba_bars
      WHERE name LIKE ? OR slogan LIKE ?
      ORDER BY thread_count DESC, id DESC
      LIMIT ?
    `).all(`%${q}%`, `%${q}%`, lim);
  } else {
    rows = db.prepare(`
      SELECT * FROM tieba_bars
      ORDER BY thread_count DESC, id DESC
      LIMIT ?
    `).all(lim);
  }
  return rows.map(mapBar);
}

function getBar(id) {
  return mapBar(db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(id));
}

function createBar(account, { name, slogan, color } = {}) {
  const barName = safeName(name, 20);
  if (!barName || barName.length < 2) throw new Error('吧名至少 2 个字');
  if (!barName.endsWith('吧')) {
    // 允许不带「吧」，自动补
  }
  const finalName = barName.endsWith('吧') ? barName : `${barName}吧`;
  const exists = db.prepare('SELECT id FROM tieba_bars WHERE name=?').get(finalName);
  if (exists) throw new Error('这个吧已经存在了');
  const sloganText = String(slogan || '').trim().slice(0, 40);
  const colorText = String(color || '#c9a0dc').slice(0, 20);
  const r = db.prepare(`
    INSERT INTO tieba_bars (name, slogan, color, creator_id, member_count, thread_count, created_at)
    VALUES (?, ?, ?, ?, 1, 0, ?)
  `).run(finalName, sloganText, colorText, account.id, nowIso());
  return getBar(r.lastInsertRowid);
}

function mapThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    bar_id: row.bar_id,
    title: row.title,
    content: row.content,
    author_id: row.author_id,
    author_name: row.author_name,
    author_avatar: row.author_avatar || '',
    reply_count: row.reply_count || 0,
    last_floor: row.last_floor || 1,
    last_reply_at: row.last_reply_at,
    created_at: row.created_at,
    bar_name: row.bar_name || undefined,
  };
}

function listThreads(barId, { limit = 30, offset = 0 } = {}) {
  const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 30));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const rows = db.prepare(`
    SELECT * FROM tieba_threads
    WHERE bar_id=?
    ORDER BY last_reply_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(barId, lim, off);
  return rows.map(mapThread);
}

function getThread(id) {
  const row = db.prepare(`
    SELECT t.*, b.name AS bar_name
    FROM tieba_threads t
    LEFT JOIN tieba_bars b ON b.id = t.bar_id
    WHERE t.id=?
  `).get(id);
  return mapThread(row);
}

function createThread(account, barId, { title, content } = {}) {
  const bar = db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(barId);
  if (!bar) throw new Error('吧不存在');
  const t = String(title || '').trim().slice(0, 60);
  const c = String(content || '').trim().slice(0, 4000);
  if (!t) throw new Error('请填写标题');
  if (!c) throw new Error('请填写正文');
  const now = nowIso();
  const r = db.prepare(`
    INSERT INTO tieba_threads
      (bar_id, title, content, author_id, author_name, author_avatar, reply_count, last_floor, last_reply_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(barId, t, c, account.id, account.username, account.avatar || '', now, now);
  const threadId = r.lastInsertRowid;
  db.prepare(`
    INSERT INTO tieba_posts (thread_id, floor, content, author_id, author_name, author_avatar, created_at)
    VALUES (?, 1, ?, ?, ?, ?, ?)
  `).run(threadId, c, account.id, account.username, account.avatar || '', now);
  db.prepare('UPDATE tieba_bars SET thread_count = thread_count + 1 WHERE id=?').run(barId);
  return getThread(threadId);
}

function mapPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    thread_id: row.thread_id,
    floor: row.floor,
    content: row.content,
    author_id: row.author_id,
    author_name: row.author_name,
    author_avatar: row.author_avatar || '',
    created_at: row.created_at,
  };
}

function listPosts(threadId, { limit = 50, offset = 0 } = {}) {
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const rows = db.prepare(`
    SELECT * FROM tieba_posts
    WHERE thread_id=?
    ORDER BY floor ASC
    LIMIT ? OFFSET ?
  `).all(threadId, lim, off);
  return rows.map(mapPost);
}

function replyThread(account, threadId, content) {
  const thread = db.prepare('SELECT * FROM tieba_threads WHERE id=?').get(threadId);
  if (!thread) throw new Error('帖子不存在');
  const c = String(content || '').trim().slice(0, 4000);
  if (!c) throw new Error('请填写回复内容');
  const now = nowIso();
  const nextFloor = (thread.last_floor || 1) + 1;
  const r = db.prepare(`
    INSERT INTO tieba_posts (thread_id, floor, content, author_id, author_name, author_avatar, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(threadId, nextFloor, c, account.id, account.username, account.avatar || '', now);
  db.prepare(`
    UPDATE tieba_threads
    SET reply_count = reply_count + 1, last_floor = ?, last_reply_at = ?
    WHERE id=?
  `).run(nextFloor, now, threadId);
  return mapPost(db.prepare('SELECT * FROM tieba_posts WHERE id=?').get(r.lastInsertRowid));
}

function initTiebaModule() {
  ensureTiebaTables();
}

module.exports = {
  initTiebaModule,
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
};

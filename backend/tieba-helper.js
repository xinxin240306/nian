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

  try { d.run(`ALTER TABLE tieba_bars ADD COLUMN theme TEXT DEFAULT ''`); } catch {}
  try { d.run(`ALTER TABLE tieba_bars ADD COLUMN owner_mode TEXT DEFAULT 'user'`); } catch {}
  try { d.run(`ALTER TABLE tieba_bars ADD COLUMN kind TEXT DEFAULT 'custom'`); } catch {}
  try { d.run(`ALTER TABLE tieba_bars ADD COLUMN city_key TEXT DEFAULT ''`); } catch {}
  try { d.run(`ALTER TABLE tieba_bars ADD COLUMN character_id INTEGER DEFAULT 0`); } catch {}
  try { d.run(`ALTER TABLE tieba_bars ADD COLUMN source_names TEXT DEFAULT ''`); } catch {}
  try { d.run(`ALTER TABLE tieba_threads ADD COLUMN pinned INTEGER DEFAULT 0`); } catch {}
  try { d.run(`ALTER TABLE tieba_threads ADD COLUMN pinned_at TEXT DEFAULT ''`); } catch {}
  try { d.run(`ALTER TABLE tieba_posts ADD COLUMN reply_to_floor INTEGER DEFAULT 0`); } catch {}
  d.run(`CREATE INDEX IF NOT EXISTS idx_tieba_bars_city ON tieba_bars(kind, city_key, character_id)`);

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

const CITY_COLORS = [
  '#c9a0dc', '#74b9ff', '#fd79a8', '#fdcb6e',
  '#55efc4', '#a29bfe', '#ff7675', '#81ecec',
];

function colorForKey(key) {
  let n = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i += 1) n = (n + s.charCodeAt(i) * (i + 1)) % CITY_COLORS.length;
  return CITY_COLORS[n];
}

function placeCore(place) {
  const p = String(place || '').trim();
  return p.endsWith('吧') ? p.slice(0, -1) : p;
}

function locatedCharacters() {
  try {
    const cols = new Set((db.prepare('PRAGMA table_info(characters)').all() || []).map((c) => c.name));
    if (!cols.has('location_name') || !cols.has('name')) return [];
    const fields = ['id', 'name', 'location_name'];
    if (cols.has('intro')) fields.push('intro');
    let sql = `SELECT ${fields.join(', ')} FROM characters WHERE TRIM(COALESCE(location_name,'')) != ''`;
    if (cols.has('circle_npc_id')) sql += ` AND IFNULL(circle_npc_id,0)=0`;
    if (cols.has('source')) sql += ` AND IFNULL(source,'') != 'circle_npc'`;
    return db.prepare(sql).all() || [];
  } catch (e) {
    console.warn('[tieba] city characters', e.message);
    return [];
  }
}

function freeBarName(desired) {
  let name = String(desired || '城市吧').slice(0, 30);
  if (!db.prepare('SELECT id FROM tieba_bars WHERE name=?').get(name)) return name;
  const base = name.endsWith('吧') ? name.slice(0, -1) : name;
  for (let n = 2; n <= 30; n += 1) {
    const suffix = String(n);
    name = `${base.slice(0, 29 - suffix.length)}${suffix}吧`.slice(0, 30);
    if (!db.prepare('SELECT id FROM tieba_bars WHERE name=?').get(name)) return name;
  }
  return `${base.slice(0, 18)}${Date.now().toString().slice(-6)}吧`.slice(0, 30);
}

function upsertCityBar(group, mode) {
  const charId = mode === 'split' ? Number(group.chars[0].id) : 0;
  const names = group.chars.map((c) => String(c.name || '').trim()).filter(Boolean);
  const sourceNames = names.join('、').slice(0, 80);
  const core = placeCore(group.place) || '这里';
  const who = names[0] || '角色';
  const desired = (mode === 'split' ? `${core}·${who}吧` : `${core}吧`).slice(0, 30);
  const intro = mode === 'split' ? String(group.chars[0].intro || '').trim() : '';
  const theme = (intro || (mode === 'split'
    ? `${who}在${core}的日常`
    : `${core}。常在这里的人：${sourceNames || '还没有人'}`)).slice(0, 200);
  const slogan = theme.replace(/\s+/g, ' ').slice(0, 40);
  const color = colorForKey(`${group.key}:${charId}`);
  const members = Math.max(1, group.chars.length);
  const existing = db.prepare(`
    SELECT * FROM tieba_bars WHERE kind='city' AND city_key=? AND IFNULL(character_id,0)=?
  `).get(group.key, charId);
  if (!existing) {
    const name = freeBarName(desired);
    db.prepare(`
      INSERT INTO tieba_bars
        (name, slogan, theme, color, creator_id, member_count, thread_count, created_at, owner_mode, kind, city_key, character_id, source_names)
      VALUES (?, ?, ?, ?, NULL, ?, 0, ?, 'npc', 'city', ?, ?, ?)
    `).run(name, slogan, theme, color, members, nowIso(), group.key, charId, sourceNames);
    return;
  }
  let name = existing.name;
  if (existing.name !== desired) {
    const taken = db.prepare('SELECT id FROM tieba_bars WHERE name=? AND id!=?').get(desired, existing.id);
    if (!taken) name = desired;
  }
  if (name === existing.name
    && slogan === (existing.slogan || '')
    && theme === (existing.theme || '')
    && color === (existing.color || '')
    && members === Number(existing.member_count || 0)
    && sourceNames === (existing.source_names || '')
    && existing.owner_mode === 'npc') return;
  db.prepare(`
    UPDATE tieba_bars
    SET name=?, slogan=?, theme=?, color=?, member_count=?, source_names=?, owner_mode='npc', kind='city'
    WHERE id=?
  `).run(name, slogan, theme, color, members, sourceNames, existing.id);
}

function syncCityBars(mode) {
  const want = mode === 'split' ? 'split' : 'merge';
  const groups = new Map();
  for (const c of locatedCharacters()) {
    const place = String(c.location_name || '').trim().replace(/\s+/g, '');
    if (!place) continue;
    const key = place;
    if (want === 'split') {
      groups.set(`${key}#${c.id}`, { key, place, chars: [c] });
    } else {
      const g = groups.get(key) || { key, place, chars: [] };
      g.chars.push(c);
      groups.set(key, g);
    }
  }
  for (const g of groups.values()) upsertCityBar(g, want);
}

function mapBar(row, account = null) {
  if (!row) return null;
  const ownerMode = row.owner_mode === 'npc' ? 'npc' : 'user';
  const kind = row.kind === 'city' ? 'city' : 'custom';
  const creatorId = row.creator_id || null;
  return {
    id: row.id,
    name: row.name,
    slogan: row.slogan || '',
    theme: row.theme || '',
    color: row.color || '#c9a0dc',
    avatar: row.avatar || '',
    creator_id: creatorId,
    member_count: row.member_count || 0,
    thread_count: row.thread_count || 0,
    created_at: row.created_at,
    owner_mode: ownerMode,
    kind,
    city_key: row.city_key || '',
    character_id: Number(row.character_id) || 0,
    source_names: row.source_names || '',
    is_owner: !!(account && ownerMode === 'user' && Number(creatorId) === Number(account.id)),
  };
}

function listBars({ q = '', limit = 50, cityMode = 'merge', account = null } = {}) {
  const mode = cityMode === 'split' ? 'split' : 'merge';
  syncCityBars(mode);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const query = String(q || '').trim();
  const like = `%${query}%`;
  const whereQ = query
    ? `AND (name LIKE ? OR slogan LIKE ? OR IFNULL(theme,'') LIKE ? OR IFNULL(source_names,'') LIKE ?)`
    : '';
  const paramsQ = query ? [like, like, like, like] : [];
  const custom = db.prepare(`
    SELECT * FROM tieba_bars
    WHERE IFNULL(kind,'custom') != 'city' ${whereQ}
    ORDER BY thread_count DESC, id DESC
    LIMIT ?
  `).all(...paramsQ, lim);
  const city = db.prepare(`
    SELECT * FROM tieba_bars
    WHERE kind='city'
      AND (
        (? = 'split' AND IFNULL(character_id,0) > 0)
        OR (? = 'merge' AND IFNULL(character_id,0) = 0)
      )
      ${whereQ}
    ORDER BY member_count DESC, thread_count DESC, id DESC
    LIMIT ?
  `).all(mode, mode, ...paramsQ, lim);
  return [...city, ...custom].map((row) => mapBar(row, account));
}

function getBar(id, account = null) {
  return mapBar(db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(id), account);
}

function createBar(account, { name, slogan, color, theme, ownerMode } = {}) {
  const barName = safeName(name, 20);
  if (!barName || barName.length < 2) throw new Error('吧名至少 2 个字');
  const finalName = barName.endsWith('吧') ? barName : `${barName}吧`;
  const exists = db.prepare('SELECT id FROM tieba_bars WHERE name=?').get(finalName);
  if (exists) throw new Error('这个吧已经存在了');
  const themeText = String(theme || '').trim().slice(0, 200);
  const sloganText = String(slogan || '').trim().slice(0, 40) || themeText.replace(/\s+/g, ' ').slice(0, 40);
  const colorText = /^#[0-9a-fA-F]{3,8}$/.test(String(color || '').trim()) ? String(color).trim() : '#c9a0dc';
  const owner = ownerMode === 'npc' ? 'npc' : 'user';
  const r = db.prepare(`
    INSERT INTO tieba_bars
      (name, slogan, theme, color, creator_id, member_count, thread_count, created_at, owner_mode, kind, city_key, character_id, source_names)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, 'custom', '', 0, '')
  `).run(finalName, sloganText, themeText, colorText, account.id, nowIso(), owner);
  return getBar(r.lastInsertRowid, account);
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
    pinned: Number(row.pinned) === 1,
    pinned_at: row.pinned_at || '',
    bar_name: row.bar_name || undefined,
  };
}

const THREAD_SORTS = {
  live: 'IFNULL(pinned,0) DESC, last_reply_at DESC, id DESC',
  hot: 'IFNULL(pinned,0) DESC, reply_count DESC, last_reply_at DESC, id DESC',
  new: 'IFNULL(pinned,0) DESC, created_at DESC, id DESC',
};

function listThreads(barId, { limit = 30, offset = 0, sort = 'live' } = {}) {
  const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 30));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const order = THREAD_SORTS[sort] || THREAD_SORTS.live;
  const rows = db.prepare(`
    SELECT * FROM tieba_threads
    WHERE bar_id=?
    ORDER BY ${order}
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
    reply_to_floor: Number(row.reply_to_floor) || 0,
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

function replyThread(account, threadId, content, replyToFloor) {
  const thread = db.prepare('SELECT * FROM tieba_threads WHERE id=?').get(threadId);
  if (!thread) throw new Error('帖子不存在');
  const c = String(content || '').trim().slice(0, 4000);
  if (!c) throw new Error('请填写回复内容');
  const now = nowIso();
  const nextFloor = (thread.last_floor || 1) + 1;
  let replyFloor = parseInt(replyToFloor, 10) || 0;
  if (replyFloor > 0) {
    const hit = db.prepare('SELECT floor FROM tieba_posts WHERE thread_id=? AND floor=?').get(threadId, replyFloor);
    if (!hit || replyFloor >= nextFloor) replyFloor = 0;
  }
  const r = db.prepare(`
    INSERT INTO tieba_posts (thread_id, floor, content, author_id, author_name, author_avatar, created_at, reply_to_floor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(threadId, nextFloor, c, account.id, account.username, account.avatar || '', now, replyFloor);
  db.prepare(`
    UPDATE tieba_threads
    SET reply_count = reply_count + 1, last_floor = ?, last_reply_at = ?
    WHERE id=?
  `).run(nextFloor, now, threadId);
  return mapPost(db.prepare('SELECT * FROM tieba_posts WHERE id=?').get(r.lastInsertRowid));
}

function assertBarOwner(account, barRow) {
  if (!account) {
    const err = new Error('请先登录贴吧账号');
    err.needsTiebaAuth = true;
    throw err;
  }
  if (!barRow || barRow.owner_mode === 'npc' || Number(barRow.creator_id) !== Number(account.id)) {
    throw new Error('只有吧主可以操作');
  }
}

function setThreadPinned(account, threadId, pinned) {
  const thread = db.prepare('SELECT * FROM tieba_threads WHERE id=?').get(threadId);
  if (!thread) throw new Error('帖子不存在');
  const bar = db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(thread.bar_id);
  assertBarOwner(account, bar);
  const on = pinned ? 1 : 0;
  db.prepare('UPDATE tieba_threads SET pinned=?, pinned_at=? WHERE id=?')
    .run(on, on ? nowIso() : '', threadId);
  return getThread(threadId);
}

function deleteThread(account, threadId) {
  const thread = db.prepare('SELECT * FROM tieba_threads WHERE id=?').get(threadId);
  if (!thread) throw new Error('帖子不存在');
  const bar = db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(thread.bar_id);
  assertBarOwner(account, bar);
  db.prepare('DELETE FROM tieba_posts WHERE thread_id=?').run(threadId);
  db.prepare('DELETE FROM tieba_threads WHERE id=?').run(threadId);
  db.prepare(`
    UPDATE tieba_bars
    SET thread_count = CASE WHEN thread_count > 0 THEN thread_count - 1 ELSE 0 END
    WHERE id=?
  `).run(thread.bar_id);
  return { ok: true, bar_id: thread.bar_id };
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
  setThreadPinned,
  deleteThread,
};

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
  try { d.run(`ALTER TABLE tieba_bars ADD COLUMN npc_slot TEXT DEFAULT ''`); } catch {}
  try { d.run(`ALTER TABLE tieba_threads ADD COLUMN media_url TEXT DEFAULT ''`); } catch {}
  try { d.run(`ALTER TABLE tieba_threads ADD COLUMN media_type TEXT DEFAULT ''`); } catch {}
  try { d.run(`ALTER TABLE tieba_posts ADD COLUMN media_url TEXT DEFAULT ''`); } catch {}
  try { d.run(`ALTER TABLE tieba_posts ADD COLUMN media_type TEXT DEFAULT ''`); } catch {}
  d.run(`CREATE INDEX IF NOT EXISTS idx_tieba_bars_city ON tieba_bars(kind, city_key, character_id)`);
  d.run(`
    CREATE TABLE IF NOT EXISTS tieba_npcs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bar_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      gender TEXT DEFAULT '',
      persona TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(bar_id, name)
    )
  `);
  d.run(`CREATE INDEX IF NOT EXISTS idx_tieba_npcs_bar ON tieba_npcs(bar_id, id DESC)`);
  try { d.run(`ALTER TABLE tieba_npcs ADD COLUMN avatar TEXT DEFAULT ''`); } catch {}
  d.run(`
    CREATE TABLE IF NOT EXISTS tieba_handles (
      character_id INTEGER PRIMARY KEY,
      handle TEXT NOT NULL,
      real_name INTEGER DEFAULT 0,
      avatar TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

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
    media_url: row.media_url || '',
    media_type: row.media_type || '',
    bar_name: row.bar_name || undefined,
  };
}

const THREAD_SORTS = {
  live: 'IFNULL(pinned,0) DESC, last_reply_at DESC, id DESC',
  hot: 'IFNULL(pinned,0) DESC, reply_count DESC, last_reply_at DESC, id DESC',
  new: 'IFNULL(pinned,0) DESC, created_at DESC, id DESC',
};

function listThreads(barId, { limit = 30, offset = 0, sort = 'live' } = {}) {
  paintBarAvatars(barId);
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
    media_url: row.media_url || '',
    media_type: row.media_type || '',
  };
}

function listPosts(threadId, { limit = 50, offset = 0 } = {}) {
  const thread = db.prepare('SELECT bar_id FROM tieba_threads WHERE id=?').get(threadId);
  if (thread?.bar_id) paintBarAvatars(thread.bar_id);
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
  startTiebaNpcSchedule();
}

// 下拉会马上再写一批。白天另外按时间点自己写，人不在页面里也会更新。
const NPC_REFRESH_GAP_MS = 15000;
const barNpcJobs = new Map();
const barNpcDoneAt = new Map();
const barStockJobs = new Map();
const threadNpcJobs = new Map();
const threadNpcDoneAt = new Map();
let tiebaMediaJob = null;
let tiebaStockJob = null;

const TIEBA_POST_WANT = 12;
const TIEBA_REPLY_WANT = 10;
const TIEBA_NAME_WANT = 16;
const TIEBA_NPC_POOL = 24;
const TIEBA_NPC_POOL_MIN = 12;

const NPC_SYSTEM = `你在给一个虚拟贴吧写吧友发言。只输出一个 JSON 对象，不要 markdown，不要解释，不要思考过程。
网名像真人随手起的，2 到 8 个字，彼此差得很远。性别和脾气都要岔开，不要全是同一类人。
口气像贴吧：短、口语。不要小作文，不要小说腔，不要「作为AI」，不要官腔。
标题不超过10个字，正文不超过18个字，回复不超过8个字。能短就短。`;

function clipText(raw, max) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanNpcName(raw) {
  const name = String(raw || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9_·]/g, '')
    .slice(0, 16);
  if (name.length < 2 || name.length > 16) return '';
  if (/贴吧|管理员|系统|助手|官方/.test(name)) return '';
  return name;
}

function normalizeGender(raw) {
  const s = String(raw || '').trim();
  if (s === '女' || /^female$/i.test(s)) return '女';
  if (s === '男' || /^male$/i.test(s)) return '男';
  return '不详';
}

function tryParseJson(src) {
  try { return JSON.parse(src); } catch { /* 尾逗号 */ }
  try { return JSON.parse(String(src || '').replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

function closeTruncatedJson(text) {
  const start = String(text || '').indexOf('{');
  if (start < 0) return null;
  let s = String(text).slice(start);
  const wholeEnd = s.lastIndexOf('}');
  if (wholeEnd > 0) {
    const parsed = tryParseJson(s.slice(0, wholeEnd + 1));
    if (parsed) return parsed;
  }
  let inStr = false;
  let esc = false;
  const stack = [];
  let lastSafe = -1;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') stack.push(c);
    else if ((c === '}' || c === ']') && stack.length) {
      stack.pop();
      if (stack.length > 0 && stack.length <= 2) lastSafe = i;
    }
  }
  if (lastSafe < 1) return null;
  s = s.slice(0, lastSafe + 1).replace(/,\s*$/, '');
  inStr = false;
  esc = false;
  const rest = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') rest.push('}');
    else if (c === '[') rest.push(']');
    else if ((c === '}' || c === ']') && rest.length) rest.pop();
  }
  if (inStr) return null;
  return tryParseJson(s + rest.reverse().join(''));
}

function extractJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  let text = String(raw || '').trim();
  if (!text) return null;
  const closed = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (closed) text = closed[1].trim();
  else {
    const open = text.match(/^```(?:json)?\s*/i);
    if (open) text = text.slice(open[0].length).replace(/```\s*$/i, '').trim();
  }
  return closeTruncatedJson(text);
}

function asList(v) {
  return Array.isArray(v) ? v : [];
}

function asPerson(n) {
  if (Array.isArray(n)) return { name: n[0], gender: n[1], persona: n[2] };
  return n && typeof n === 'object' ? n : {};
}

function asThreadItem(t) {
  if (Array.isArray(t)) return { author: t[0], title: t[1], content: t[2], replies: t[3], scene: t[4] };
  return t && typeof t === 'object' ? t : {};
}

function asReplyItem(r) {
  if (Array.isArray(r)) return { author: r[0], content: r[1], reply_to: r.length >= 3 ? r[2] : 1 };
  return r && typeof r === 'object' ? r : {};
}

function nameBlocked(name, reserved, allowed) {
  if (!name) return true;
  if (allowed && allowed.has(name)) return false;
  return reserved.has(name);
}

function hashStr(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function npcAvatarDataUri(seed) {
  const h = hashStr(seed);
  const hue = h % 360;
  const skin = ['#f6e2c8', '#f3d2b5', '#e0ac7a', '#c68642', '#8d5524', '#6b3a22'][h % 6];
  const hair = `hsl(${(hue + 28) % 360},42%,${16 + (h % 22)}%)`;
  const bg = `hsl(${hue},46%,${56 + (h % 14)}%)`;
  const hairStyle = (h >> 4) % 4;
  let hairSvg = '';
  if (hairStyle === 0) hairSvg = `<path d="M16 34c2-16 8-22 16-22s14 6 16 22c-4-8-9-12-16-12s-12 4-16 12z" fill="${hair}"/>`;
  else if (hairStyle === 1) hairSvg = `<path d="M18 28c0-12 6-18 14-18s14 6 14 18v4H18z" fill="${hair}"/>`;
  else if (hairStyle === 2) hairSvg = `<path d="M20 20c4-8 20-8 24 2 2 6-2 8-4 6 2-6-4-8-8-8s-10 2-8 8c-2 2-6 0-4-8z" fill="${hair}"/>`;
  else hairSvg = `<path d="M17 30c0-12 7-18 15-18s15 6 15 18c-4-7-9-10-15-10s-11 3-15 10z" fill="${hair}"/><path d="M18 32c-1 10 0 16 5 18M46 32c1 10 0 16-5 18" stroke="${hair}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  const eyes = (h >> 6) % 3;
  let eyeSvg = `<circle cx="26" cy="36" r="1.7" fill="#2b2118"/><circle cx="38" cy="36" r="1.7" fill="#2b2118"/>`;
  if (eyes === 1) eyeSvg = `<path d="M23 36h6M35 36h6" stroke="#2b2118" stroke-width="1.7" stroke-linecap="round"/>`;
  if (eyes === 2) eyeSvg = `<circle cx="26" cy="36" r="2.2" fill="#2b2118"/><circle cx="38" cy="36" r="2.2" fill="#2b2118"/><circle cx="26.7" cy="35.3" r=".6" fill="#fff"/><circle cx="38.7" cy="35.3" r=".6" fill="#fff"/>`;
  const mouth = (h >> 8) % 3;
  let mouthSvg = `<path d="M29 44c1.2 1.5 4.8 1.5 6 0" stroke="#a15a4a" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
  if (mouth === 1) mouthSvg = `<path d="M28 43.5h8" stroke="#a15a4a" stroke-width="1.3" stroke-linecap="round"/>`;
  if (mouth === 2) mouthSvg = `<circle cx="32" cy="44" r="1.5" fill="#c46a5a"/>`;
  const blush = (h >> 3) % 2 === 0
    ? `<ellipse cx="22" cy="41" rx="2.2" ry="1.2" fill="#e7a394" opacity=".75"/><ellipse cx="42" cy="41" rx="2.2" ry="1.2" fill="#e7a394" opacity=".75"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/>${hairSvg}<circle cx="32" cy="38" r="14" fill="${skin}"/>${eyeSvg}${mouthSvg}${blush}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function paintBarAvatars(barId) {
  const id = Number(barId);
  if (!id) return;
  try {
    ensureTiebaTables();
    const npcs = db.prepare(`SELECT id, name, IFNULL(avatar,'') AS avatar FROM tieba_npcs WHERE bar_id=?`).all(id);
    for (const n of npcs) {
      const avatar = n.avatar || npcAvatarDataUri(`${id}:${n.name}`);
      if (!n.avatar) db.prepare('UPDATE tieba_npcs SET avatar=? WHERE id=?').run(avatar, n.id);
      db.prepare(`UPDATE tieba_threads SET author_avatar=? WHERE bar_id=? AND author_name=? AND IFNULL(author_avatar,'')=''`).run(avatar, id, n.name);
      db.prepare(`UPDATE tieba_posts SET author_avatar=? WHERE IFNULL(author_avatar,'')='' AND author_name=? AND thread_id IN (SELECT id FROM tieba_threads WHERE bar_id=?)`).run(avatar, n.name, id);
    }
    const handles = db.prepare(`SELECT handle, IFNULL(avatar,'') AS avatar FROM tieba_handles WHERE IFNULL(avatar,'')!=''`).all();
    for (const h of handles) {
      db.prepare(`UPDATE tieba_threads SET author_avatar=? WHERE bar_id=? AND author_name=? AND IFNULL(author_avatar,'')=''`).run(h.avatar, id, h.handle);
      db.prepare(`UPDATE tieba_posts SET author_avatar=? WHERE IFNULL(author_avatar,'')='' AND author_name=? AND thread_id IN (SELECT id FROM tieba_threads WHERE bar_id=?)`).run(h.avatar, h.handle, id);
    }
  } catch (e) {
    console.warn('[tieba] avatar', e.message);
  }
}

function rosterFromCtx(ctx, reserved, allowed) {
  const map = new Map();
  const names = [];
  for (const n of asList(ctx.roster)) {
    const person = asPerson(n);
    const name = cleanNpcName(person?.name || n);
    if (!name || map.has(name) || nameBlocked(name, reserved, allowed)) continue;
    map.set(name, {
      name,
      gender: normalizeGender(person?.gender || person?.性别),
      persona: clipText(person?.persona || person?.性格, 40) || '路过',
    });
    names.push(name);
  }
  return { map, names };
}

function bindSpeaker(raw, { reserved, allowed, rosterMap, rosterNames, keep, blocked, stale }) {
  const name = cleanNpcName(raw);
  const keepSet = keep || new Set();
  const blockedSet = blocked || new Set();
  if (name && !blockedSet.has(name) && (keepSet.has(name) || !nameBlocked(name, reserved, allowed))) {
    const known = !rosterNames.length || rosterMap.has(name) || allowed.has(name) || keepSet.has(name);
    const retired = stale && stale.has(name) && !allowed.has(name) && !rosterMap.has(name) && !keepSet.has(name);
    if (known && !retired) return name;
  }
  if (!rosterNames.length) return '';
  const fresh = rosterNames.find((cand) => !blockedSet.has(cand) && !(stale && stale.has(cand)));
  if (fresh) return fresh;
  return rosterNames.find((cand) => !blockedSet.has(cand)) || '';
}

function shapeTiebaNpcRoster(raw, ctx = {}) {
  const data = extractJsonObject(raw);
  if (!data || typeof data !== 'object') return null;
  const reserved = ctx.reserved instanceof Set ? ctx.reserved : new Set(ctx.reserved || []);
  const want = Math.min(16, Math.max(1, parseInt(ctx.want, 10) || 12));
  const out = [];
  const seen = new Set();
  for (const rawNpc of asList(data.npcs || data.people || data.users)) {
    const n = asPerson(rawNpc);
    const name = cleanNpcName(n?.name || n?.author);
    if (!name || seen.has(name) || reserved.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      gender: normalizeGender(n?.gender || n?.性别),
      persona: clipText(n?.persona || n?.personality || n?.性格, 16) || '路过',
    });
    if (out.length >= want) break;
  }
  return out.length ? out : null;
}

function shapeTiebaNpcThreads(raw, ctx = {}) {
  const data = extractJsonObject(raw);
  if (!data || typeof data !== 'object') return null;
  const reserved = ctx.reserved instanceof Set ? ctx.reserved : new Set(ctx.reserved || []);
  const allowed = ctx.allowed instanceof Set ? ctx.allowed : new Set(ctx.allowed || []);
  const recentAuthors = new Set((ctx.recentAuthors || []).map((n) => String(n || '').trim()).filter(Boolean));
  const staleAuthors = new Set((ctx.staleAuthors || []).map((n) => String(n || '').trim()).filter(Boolean));
  const titleSeen = new Set((ctx.recentTitles || []).map((t) => clipText(t, 40)).filter(Boolean));
  const { map: rosterMap, names: rosterNames } = rosterFromCtx(ctx, reserved, allowed);
  const personas = new Map();
  for (const rawNpc of asList(data.npcs || data.people || data.users)) {
    const n = asPerson(rawNpc);
    const name = cleanNpcName(n?.name || n?.author);
    if (!name || nameBlocked(name, reserved, allowed)) continue;
    personas.set(name, {
      name,
      gender: normalizeGender(n?.gender || n?.性别),
      persona: clipText(n?.persona || n?.personality || n?.性格, 40) || '路过',
    });
  }
  const npcOf = (name) => rosterMap.get(name) || personas.get(name) || { name, gender: '不详', persona: '路过' };
  const threads = [];
  const usedAuthors = new Set();
  const replyTextSeen = new Set();
  const castReplies = new Map();
  const replyCap = Math.min(15, Math.max(1, parseInt(ctx.replyLimit, 10) || 12));
  let mediaTaken = false;
  const speak = { reserved, allowed, rosterMap, rosterNames, stale: staleAuthors };
  for (const rawThread of asList(data.threads || data.posts || data.帖子)) {
    const t = asThreadItem(rawThread);
    let author = bindSpeaker(t?.author || t?.name || t?.楼主 || t?.author_name, { ...speak, blocked: usedAuthors });
    if (!author) continue;
    if (rosterNames.length && recentAuthors.has(author) && !allowed.has(author)) {
      const fresher = rosterNames.find((n) => !usedAuthors.has(n) && !recentAuthors.has(n));
      if (fresher) author = fresher;
    }
    const title = clipText(t?.title || t?.标题, 24);
    const content = clipText(t?.content || t?.正文 || t?.body, 48);
    if (title.length < 2 || content.length < 2) continue;
    if (titleSeen.has(title)) continue;
    titleSeen.add(title);
    const replies = [];
    const replyNames = new Set([author]);
    for (const rawReply of asList(t?.replies || t?.回复).slice(0, replyCap)) {
      const r = asReplyItem(rawReply);
      const rn = bindSpeaker(r?.author || r?.name, { ...speak, blocked: replyNames });
      if (!rn) continue;
      const rc = clipText(r?.content || r?.正文 || r?.body, 24);
      if (rc.length < 2 || rc === content || rc === title || replyTextSeen.has(rc)) continue;
      if (allowed.has(rn)) {
        const used = castReplies.get(rn) || 0;
        if (used >= 2) continue;
        castReplies.set(rn, used + 1);
      }
      replyNames.add(rn);
      replyTextSeen.add(rc);
      const to = Number(r?.reply_to ?? r?.replyTo ?? r?.reply_to_floor) === 1 ? 1 : 0;
      replies.push({ npc: npcOf(rn), content: rc, replyTo: to });
    }
    let scene = '';
    let video = false;
    if (!mediaTaken) {
      let rawScene = clipText(t?.scene || t?.image || t?.picture || '', 90);
      if (/^video\s*[:：]/i.test(rawScene)) {
        video = true;
        rawScene = clipText(rawScene.replace(/^video\s*[:：]\s*/i, ''), 90);
      }
      if (rawScene.length >= 3) {
        scene = rawScene;
        video = video && scene.length >= 3;
        mediaTaken = true;
      }
    }
    threads.push({
      npc: npcOf(author),
      title,
      content,
      replies,
      scene,
      video,
      fresh: allowed.has(author) || (!recentAuthors.has(author) && !usedAuthors.has(author)),
    });
    usedAuthors.add(author);
  }
  const want = Math.min(15, Math.max(1, parseInt(ctx.want, 10) || TIEBA_POST_WANT));
  const castFirst = [];
  const others = [];
  for (const t of threads) {
    if (allowed.has(t.npc.name)) {
      if (castFirst.length < 2 && !castFirst.some((x) => x.npc.name === t.npc.name)) castFirst.push(t);
    } else {
      others.push(t);
    }
  }
  const fresh = others.filter((t) => t.fresh);
  const pool = fresh.length ? fresh : others;
  const picked = [...castFirst, ...pool].slice(0, want);
  if (picked.length && !picked.some((t) => t.scene)) {
    const donor = threads.find((t) => t.scene);
    if (donor) {
      picked[0].scene = donor.scene;
      picked[0].video = donor.video;
    }
  }
  return picked.length ? picked : null;
}

function shapeTiebaNpcReplies(raw, ctx = {}) {
  const data = extractJsonObject(raw);
  if (!data || typeof data !== 'object') return null;
  const reserved = ctx.reserved instanceof Set ? ctx.reserved : new Set(ctx.reserved || []);
  const allowed = ctx.allowed instanceof Set ? ctx.allowed : new Set(ctx.allowed || []);
  const staleAuthors = new Set((ctx.staleAuthors || []).map((n) => String(n || '').trim()).filter(Boolean));
  const floors = new Set((ctx.floors || []).map((n) => Number(n)).filter((n) => n > 0));
  const existing = new Set((ctx.existing || []).map((c) => clipText(c, 80)).filter(Boolean));
  const keep = new Set((ctx.keepNames || []).map((n) => cleanNpcName(n)).filter(Boolean));
  const { map: rosterMap, names: rosterNames } = rosterFromCtx(ctx, reserved, allowed);
  const personas = new Map();
  for (const rawNpc of asList(data.npcs || data.people)) {
    const n = asPerson(rawNpc);
    const name = cleanNpcName(n?.name || n?.author);
    if (!name || nameBlocked(name, reserved, allowed)) continue;
    personas.set(name, {
      name,
      gender: normalizeGender(n?.gender || n?.性别),
      persona: clipText(n?.persona || n?.性格 || n?.persona, 40) || '路过',
    });
  }
  const replies = [];
  const used = new Set();
  const cap = Math.min(15, Math.max(1, parseInt(ctx.replyLimit, 10) || 12));
  const speak = { reserved, allowed, rosterMap, rosterNames, keep, stale: staleAuthors };
  for (const rawReply of asList(data.replies || data.回复 || data.posts)) {
    const r = asReplyItem(rawReply);
    const name = bindSpeaker(r?.author || r?.name, { ...speak, blocked: used });
    if (!name) continue;
    const content = clipText(r?.content || r?.正文 || r?.body, 24);
    if (content.length < 2 || existing.has(content)) continue;
    let replyTo = parseInt(r?.reply_to_floor ?? r?.reply_to ?? r?.replyTo, 10) || 0;
    if (!floors.has(replyTo)) replyTo = floors.has(1) ? 1 : 0;
    used.add(name);
    existing.add(content);
    replies.push({
      npc: rosterMap.get(name) || personas.get(name) || { name, gender: '不详', persona: '路过' },
      content,
      replyTo,
    });
    if (replies.length >= cap) break;
  }
  return replies.length ? replies : null;
}

function characterColumns() {
  try {
    return new Set((db.prepare('PRAGMA table_info(characters)').all() || []).map((c) => c.name));
  } catch {
    return new Set();
  }
}

function looksKnown(row) {
  const blob = `${row?.intro || ''} ${row?.personality || ''} ${row?.description || ''}`;
  return /明星|偶像|顶流|艺人|歌手|演员|主播|网红|名人|知名|公众|传说|大神|选手|爱豆/.test(blob);
}

function barCast(bar) {
  if (!bar || bar.kind !== 'city') return [];
  const cols = characterColumns();
  if (!cols.has('name')) return [];
  const fields = ['id', 'name'];
  for (const c of ['intro', 'personality', 'description', 'location_name', 'avatar', 'language_style']) {
    if (cols.has(c)) fields.push(c);
  }
  let sql = `SELECT ${fields.join(', ')} FROM characters WHERE TRIM(COALESCE(name,'')) != ''`;
  if (cols.has('circle_npc_id')) sql += ' AND IFNULL(circle_npc_id,0)=0';
  if (cols.has('source')) sql += ` AND IFNULL(source,'') != 'circle_npc'`;
  try {
    if (Number(bar.character_id) > 0) {
      return db.prepare(`${sql} AND id=?`).all(Number(bar.character_id)).slice(0, 1);
    }
    const key = String(bar.city_key || '').trim();
    if (!key || !cols.has('location_name')) return [];
    return (db.prepare(`${sql} AND TRIM(COALESCE(location_name,'')) != ''`).all() || [])
      .filter((c) => String(c.location_name || '').trim().replace(/\s+/g, '') === key)
      .slice(0, 8);
  } catch (e) {
    console.warn('[tieba] cast', e.message);
    return [];
  }
}

function reservedSpeakerNames(extra = []) {
  const names = new Set();
  const add = (n) => {
    const name = String(n || '').trim();
    if (name) names.add(name);
  };
  extra.forEach(add);
  try {
    for (const r of db.prepare('SELECT username FROM tieba_accounts').all()) add(r.username);
  } catch { /* 账号表还没有 */ }
  try {
    for (const r of db.prepare('SELECT name FROM characters').all()) add(r.name);
  } catch { /* 角色表还没有 */ }
  return names;
}

function recentNpcs(barId, skip) {
  const skipSet = skip instanceof Set ? skip : new Set(skip || []);
  return db.prepare(`
    SELECT name, gender, persona FROM tieba_npcs
    WHERE bar_id=?
    ORDER BY id DESC
    LIMIT 40
  `).all(barId).filter((n) => n?.name && !skipSet.has(n.name));
}

function recentThreadBriefs(barId) {
  return db.prepare(`
    SELECT title, author_name FROM tieba_threads
    WHERE bar_id=?
    ORDER BY id DESC
    LIMIT 12
  `).all(barId);
}

function tiebaLlmError(e) {
  const msg = String(e?.message || e || '');
  console.warn('[tieba] npc', msg.slice(0, 300));
  if (/429|exhausted|额度|quota|billing|余额|积分/i.test(msg)) return '聊天接口这会儿限流了，等一会儿再拉';
  if (/401|密钥|unauthorized/i.test(msg)) return '聊天接口密钥无效，吧友没写成';
  if (/timeout|超时|aborted|ETIMEDOUT/i.test(msg)) return '吧友写到一半超时了，再拉一次';
  return '吧友这会儿没写成，再拉一次';
}

async function askTiebaJson(systemPrompt, userContent, opts = {}) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const call = require('./api-helper').callChatAPIComplete;
  let raw = '';
  try {
    raw = await call(settings, systemPrompt, userContent, 'chat', [], {
      json: true,
      maxTokens: opts.maxTokens || 1600,
      temperature: 0.85,
      timeout: opts.timeout || 60000,
    });
  } catch (e) {
    throw new Error(tiebaLlmError(e));
  }
  if (!raw) throw new Error('还没配聊天接口，吧友没写成');
  return raw;
}

function withTiebaTx(fn) {
  const native = db.getDB().native;
  if (typeof native?.transaction !== 'function') return fn();
  return native.transaction(fn)();
}

function ensureTiebaNpc(barId, npc) {
  const name = npc.name;
  const avatar = npc.avatar || npcAvatarDataUri(`${barId}:${name}`);
  let row = db.prepare('SELECT * FROM tieba_npcs WHERE bar_id=? AND name=?').get(barId, name);
  if (row) {
    if (!row.avatar) {
      db.prepare('UPDATE tieba_npcs SET avatar=? WHERE id=?').run(avatar, row.id);
      row.avatar = avatar;
    }
    return row;
  }
  try {
    db.prepare(`
      INSERT INTO tieba_npcs (bar_id, name, gender, persona, avatar, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(barId, name, npc.gender || '不详', npc.persona || '', avatar, nowIso());
  } catch (e) {
    if (!/UNIQUE|constraint/i.test(String(e?.message || e))) throw e;
  }
  row = db.prepare('SELECT * FROM tieba_npcs WHERE bar_id=? AND name=?').get(barId, name);
  if (!row) throw new Error('没能记下这个吧友');
  if (!row.avatar) row.avatar = avatar;
  return row;
}

function resolveAuthor(barId, npc) {
  if (npc?.characterId) {
    return {
      name: npc.name,
      avatar: npc.avatar || npcAvatarDataUri(`char:${npc.characterId}:${npc.name}`),
    };
  }
  const row = ensureTiebaNpc(barId, npc);
  return { name: row.name, avatar: row.avatar || npcAvatarDataUri(`${barId}:${row.name}`) };
}

function plusMinutesIso(iso, mins) {
  const base = new Date(`${String(iso || '').trim().replace(' ', 'T')}Z`);
  if (!Number.isFinite(base.getTime())) return nowIso();
  return new Date(base.getTime() + mins * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

function insertNpcThreads(barId, threads, at) {
  return withTiebaTx(() => {
    let added = 0;
    const created = [];
    let cursor = 0;
    const end = at || nowIso();
    const step = 4;
    const anchor = plusMinutesIso(end, -Math.max(0, threads.length - 1) * step);
    for (const t of threads) {
      const posted = plusMinutesIso(anchor, cursor);
      cursor += step;
      const npc = resolveAuthor(barId, t.npc);
      const replies = Array.isArray(t.replies) ? t.replies : [];
      let lastAt = posted;
      const info = db.prepare(`
        INSERT INTO tieba_threads
          (bar_id, title, content, author_id, author_name, author_avatar, reply_count, last_floor, last_reply_at, created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(barId, t.title, t.content, npc.name, npc.avatar, replies.length, 1 + replies.length, posted, posted);
      const threadId = Number(info?.lastInsertRowid || 0);
      if (!threadId) throw new Error('帖子没写进库');
      db.prepare(`
        INSERT INTO tieba_posts
          (thread_id, floor, content, author_id, author_name, author_avatar, created_at, reply_to_floor)
        VALUES (?, 1, ?, NULL, ?, ?, ?, 0)
      `).run(threadId, t.content, npc.name, npc.avatar, posted);
      let floor = 1;
      replies.forEach((rep, idx) => {
        floor += 1;
        const atReply = plusMinutesIso(posted, 1 + idx);
        lastAt = atReply > end ? end : atReply;
        const replyNpc = resolveAuthor(barId, rep.npc);
        db.prepare(`
          INSERT INTO tieba_posts
            (thread_id, floor, content, author_id, author_name, author_avatar, created_at, reply_to_floor)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
        `).run(threadId, floor, rep.content, replyNpc.name, replyNpc.avatar, lastAt, rep.replyTo || 0);
      });
      if (lastAt !== posted) {
        db.prepare('UPDATE tieba_threads SET last_reply_at=? WHERE id=?').run(lastAt, threadId);
      }
      created.push({ id: threadId, scene: t.scene || '', video: !!t.video });
      added += 1;
    }
    if (added) {
      db.prepare('UPDATE tieba_bars SET thread_count = thread_count + ? WHERE id=?').run(added, barId);
    }
    return { added, created };
  });
}

function insertNpcReplies(threadId, replies) {
  return withTiebaTx(() => {
    const thread = db.prepare('SELECT * FROM tieba_threads WHERE id=?').get(threadId);
    if (!thread) return 0;
    let floor = Number(thread.last_floor) || 1;
    const end = nowIso();
    const anchor = plusMinutesIso(end, -Math.max(0, replies.length - 1));
    let added = 0;
    let lastAt = end;
    for (const rep of replies) {
      floor += 1;
      lastAt = plusMinutesIso(anchor, added);
      if (lastAt > end) lastAt = end;
      const npc = resolveAuthor(thread.bar_id, rep.npc);
      db.prepare(`
        INSERT INTO tieba_posts
          (thread_id, floor, content, author_id, author_name, author_avatar, created_at, reply_to_floor)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(threadId, floor, rep.content, npc.name, npc.avatar, lastAt, rep.replyTo || 0);
      added += 1;
    }
    if (!added) return 0;
    db.prepare(`
      UPDATE tieba_threads
      SET reply_count = reply_count + ?, last_floor = ?, last_reply_at = ?
      WHERE id=?
    `).run(added, floor, lastAt, threadId);
    return added;
  });
}

function castLine(row) {
  const bits = [clipText(row.personality, 36), clipText(row.intro, 60), clipText(row.description, 60)].filter(Boolean);
  return `- ${row.name}${bits.length ? `：${bits.join('；')}` : ''}`;
}

function postsUnderRealName(row) {
  const blob = `${row?.intro || ''} ${row?.personality || ''} ${row?.description || ''} ${row?.language_style || ''}`;
  return /实名上网|用真名|用本名|本名上网|不匿名|公开身份|官号|认证号|实名发|用自己的名字/.test(blob);
}

const HANDLE_A = ['晚风', '半糖', '白噪', '北窗', '南风', '慢拍', '鱼灯', '汽水', '耳机', '云朵', '夜航', '柠檬', '旧信', '街灯', '雨停', '软糖', '月台', '候鸟', '半醒', '未读'];
const HANDLE_B = ['收信', '去冰', '不回', '在逃', '发呆', '续命', '听雨', '晚点', '分你', '收藏', '路过', '已读', '关机', '在线', '掉线', '半拍', '不想睡', '刚醒'];

function fallbackHandle(character, taken) {
  const h = hashStr(`${character.id}:${character.name}`);
  const realName = String(character.name || '').trim();
  for (let i = 0; i < 16; i += 1) {
    const a = HANDLE_A[(h + i * 3) % HANDLE_A.length];
    const b = HANDLE_B[(h + i * 7) % HANDLE_B.length];
    const handle = (i < 10 ? `${a}${b}` : `${a}${(h + i) % 90 + 10}`).slice(0, 16);
    if (!handle || handle === realName || taken.has(handle)) continue;
    return handle;
  }
  return `路过${(h % 900) + 100}`;
}

function ensureCharacterHandles(cast) {
  if (!cast?.length) return [];
  const taken = new Set();
  try {
    for (const r of db.prepare('SELECT username FROM tieba_accounts').all()) {
      if (r.username) taken.add(String(r.username).trim());
    }
    for (const r of db.prepare('SELECT handle FROM tieba_handles').all()) {
      if (r.handle) taken.add(String(r.handle).trim());
    }
  } catch { /* 表还没有 */ }
  for (const c of cast) {
    const name = String(c.name || '').trim();
    if (name) taken.add(name);
  }
  const ready = [];
  for (const c of cast) {
    const realName = String(c.name || '').trim().slice(0, 16);
    if (!c.id || !realName) continue;
    const existing = db.prepare('SELECT * FROM tieba_handles WHERE character_id=?').get(c.id);
    if (existing?.handle) {
      taken.add(existing.handle);
      ready.push({
        id: c.id,
        characterId: c.id,
        name: realName,
        handle: existing.handle,
        real: Number(existing.real_name) === 1,
        avatar: existing.avatar || npcAvatarDataUri(`char:${c.id}:${existing.handle}`),
      });
      continue;
    }
    const real = postsUnderRealName(c);
    let handle = real ? realName : fallbackHandle(c, taken);
    if (!handle || (!real && handle === realName)) handle = fallbackHandle({ ...c, id: `${c.id}x` }, taken);
    if (taken.has(handle) && !real) handle = `${String(handle).slice(0, 12)}${c.id}`.slice(0, 16);
    const avatar = real && c.avatar ? String(c.avatar) : npcAvatarDataUri(`char:${c.id}:${handle}`);
    db.prepare(`
      INSERT INTO tieba_handles (character_id, handle, real_name, avatar, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(c.id, handle, real ? 1 : 0, avatar, nowIso());
    taken.add(handle);
    ready.push({ id: c.id, characterId: c.id, name: realName, handle, real, avatar });
  }
  return ready;
}

function allowHandles(reserved, handles) {
  const allowed = new Set();
  for (const h of handles || []) {
    const name = String(h.handle || '').trim();
    if (!name) continue;
    allowed.add(name);
    reserved.delete(name);
  }
  return allowed;
}

function paintHandleNpcs(threads, handles) {
  const map = new Map((handles || []).map((h) => [h.handle, h]));
  const paint = (npc) => {
    if (!npc) return npc;
    const hit = map.get(npc.name);
    if (!hit) return npc;
    return {
      ...npc,
      characterId: hit.characterId || hit.id,
      avatar: hit.avatar || npc.avatar || '',
      persona: npc.persona && npc.persona !== '路过' ? npc.persona : '角色',
    };
  };
  return (threads || []).map((t) => ({
    ...t,
    npc: paint(t.npc),
    replies: (t.replies || []).map((r) => ({ ...r, npc: paint(r.npc) })),
  }));
}

function tiebaBarHandles(barId) {
  ensureTiebaTables();
  const bar = db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(Number(barId));
  if (!bar) return [];
  return ensureCharacterHandles(barCast(bar)).map((h) => ({
    handle: h.handle,
    avatar: h.avatar || '',
    real: !!h.real,
  }));
}

function batchScore(items) {
  const list = items || [];
  const replies = list.reduce((n, t) => n + (Array.isArray(t.replies) ? t.replies.length : 0), 0);
  return list.length * 10 + replies;
}

function threadsFullEnough(items) {
  const list = items || [];
  if (list.length < 6) return false;
  const replies = list.reduce((n, t) => n + (t.replies?.length || 0), 0);
  return replies >= 18;
}

function threadAsk(bar, cast, handles, npcs, briefs, want) {
  const theme = clipText(bar.theme || bar.slogan || '日常闲聊', 200);
  const lines = [
    `吧名：${bar.name}`,
    `主题：${theme}`,
  ];
  if (bar.kind === 'city') {
    const place = bar.city_key || String(bar.name || '').replace(/吧$/, '');
    lines.push(`这是「${place}」当地的吧。帖子要像住在这里的人随手发的，带一点当地的吃穿住行，不要写成攻略或导游词。`);
  } else {
    lines.push('帖子围绕这个吧的主题，不要跑题。');
  }
  if (handles.length) {
    lines.push('这些是角色的贴吧号。发帖人和回复人写这个号，不要写括号里的本名：');
    for (const h of handles) {
      if (h.real) lines.push(`- ${h.handle}（这个人设是实名上网，号就是本名）`);
      else lines.push(`- ${h.handle}（本名是${h.name}，author 里不要写本名）`);
    }
    lines.push('这一轮用其中 1 到 2 个号当楼主，再让这些号在别人的帖里各回 1 条。');
  }
  if (cast.length) {
    const known = cast.filter(looksKnown).map((c) => c.name);
    if (known.length) {
      lines.push(`正文里可以八卦 ${known.join('、')}，态度要不一样：有人粉、有人路人、有人阴阳。不要每帖同一句。发帖人仍然用贴吧号或吧友网名，不要写本名。`);
    } else {
      lines.push('看人设像名人、偶像或传说人物的，正文里可以认出来，态度各不相同。看不出来就当普通邻居，不要每帖点名。');
    }
    lines.push('角色只供你把握他们会聊什么，不要把本名写进 author：');
    lines.push(cast.map(castLine).join('\n'));
  }
  const roster = (npcs || []).filter((n) => n?.name).slice(0, 16);
  if (roster.length) {
    lines.push('这些吧友已经在这个吧里。楼主和回复人只能从他们和上面的角色贴吧号里选，不要新造网名：');
    for (const n of roster) {
      const bit = [n.gender && n.gender !== '不详' ? n.gender : '', n.persona && n.persona !== '路过' ? n.persona : ''].filter(Boolean).join(' ');
      lines.push(`- ${n.name}${bit ? ` ${bit}` : ''}`);
    }
    lines.push('优先让比较久没发帖的人当楼主。');
  }
  if (briefs.length) {
    lines.push('最近标题，不要再写类似的：');
    for (const b of briefs) lines.push(`- ${clipText(b.title, 24)}`);
  } else {
    lines.push('这个吧还没有帖。写出住在这里、或泡这个主题的人真的会发的帖。');
  }
  if (roster.length) lines.push('连同角色贴吧号，写 8 个帖，每个帖 6 条别人的短回复。不要新造网名，不要输出 npcs。');
  else lines.push('请新造一批彼此不像的网名。连同角色贴吧号，写 8 个帖，每个帖 6 条别人的短回复。不要输出 npcs。');
  lines.push('楼主各不相同。回复的人不能是该帖楼主，每条回复的用词都不要重复。回复至少 2 个字。');
  lines.push('8 个帖里正好 1 个带一张随手拍。那个帖的数组最后多一项英文画面，不超过 12 个词，画面里不要文字。想发短视频就在这项开头写 video: 。其他帖不要这项。');
  lines.push('只输出 {"threads":[["楼主","标题","正文",[["回复人","内容"]],"english scene"]]}');
  lines.push('标题不超过 8 个字，正文不超过 16 个字，回复不超过 8 个字。');
  return lines.join('\n');
}

function replyAsk(bar, thread, posts, handles, need, staleNames) {
  const lines = [
    `吧名：${bar.name}`,
    `主题：${clipText(bar.theme || bar.slogan || '日常', 160)}`,
    `帖子标题：${thread.title}`,
    '已有楼层：',
  ];
  for (const p of posts) {
    lines.push(`${p.floor}楼 ${p.author_name}：${clipText(p.content, 40)}`);
  }
  if (handles.length) {
    lines.push('角色贴吧号，可以拿来回帖，不要写他们的本名：');
    for (const h of handles) lines.push(`- ${h.handle}${h.real ? '（实名）' : ''}`);
    lines.push('其中 2 到 4 条用这些号。');
  }
  const roster = (staleNames || []).filter((n) => n?.name).slice(0, 16);
  if (roster.length) {
    lines.push('回复人只能从这些吧友和角色贴吧号里选，不要新造网名：');
    lines.push(roster.map((n) => n.name).join('、'));
    lines.push(`写 ${need} 条新回复。每条一个不同的人，不要复读，不要自我介绍。`);
  } else {
    lines.push(`请新造 ${Math.max(need + 2, 8)} 个没出现过的网名，写 ${need} 条新回复。每条一个不同的人，不要复读，不要自我介绍。`);
  }
  lines.push('不要输出 npcs。只输出 {"replies":[["网名","内容",1]]}');
  lines.push('第三个数是在回第几楼，不针对某一层就写 0。');
  return lines.join('\n');
}

function tiebaRoster(barId, handles) {
  const skip = new Set((handles || []).map((h) => h.handle).filter(Boolean));
  const rows = db.prepare(`
    SELECT name, gender, persona FROM tieba_npcs
    WHERE bar_id=?
    ORDER BY id ASC
  `).all(barId).filter((n) => n?.name && !skip.has(n.name));
  const last = new Map();
  for (const r of db.prepare(`
    SELECT author_name, MAX(id) AS n FROM tieba_threads WHERE bar_id=? GROUP BY author_name
  `).all(barId)) {
    last.set(r.author_name, Number(r.n) || 0);
  }
  rows.sort((a, b) => (last.get(a.name) || 0) - (last.get(b.name) || 0));
  return rows;
}

async function fillTiebaNpcPool(barId) {
  const bar = db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(barId);
  if (!bar) return { added: 0 };
  const cast = barCast(bar);
  const handles = ensureCharacterHandles(cast);
  const have = tiebaRoster(bar.id, handles);
  if (have.length >= TIEBA_NPC_POOL) return { added: 0, skipped: true };
  const need = Math.min(12, TIEBA_NPC_POOL - have.length);
  const reserved = reservedSpeakerNames([
    bar.name,
    ...cast.map((c) => c.name),
    ...have.map((n) => n.name),
    ...handles.map((h) => h.handle),
  ]);
  const lines = [
    `吧名：${bar.name}`,
    `主题：${clipText(bar.theme || bar.slogan || '日常', 80)}`,
    have.length ? `这些网名已经有了，不要再用：${have.map((n) => n.name).slice(0, 24).join('、')}` : '这个吧还没有固定吧友。',
    `请新造 ${need} 个彼此不像的贴吧网名，2 到 8 个字。性别岔开。脾气不超过 8 个字。`,
    '不要用真人的本名，不要解释。只输出 {"npcs":[["网名","女","爱抬杠"]]}',
  ];
  const raw = await askTiebaJson(NPC_SYSTEM, lines.join('\n'), { maxTokens: 700, timeout: 20000 });
  const people = shapeTiebaNpcRoster(raw, { reserved, want: need });
  if (!people?.length) {
    console.warn('[tieba] npc stock unparsed', String(raw).slice(0, 180));
    return { added: 0 };
  }
  let added = 0;
  for (const person of people) {
    if (db.prepare('SELECT id FROM tieba_npcs WHERE bar_id=? AND name=?').get(bar.id, person.name)) continue;
    ensureTiebaNpc(bar.id, person);
    added += 1;
  }
  console.log('[tieba] npc stock', bar.id, bar.name, added);
  return { added };
}

function stockTiebaNpcs(barId) {
  const id = Number(barId);
  if (!id) return Promise.resolve({ added: 0 });
  const running = barStockJobs.get(id);
  if (running) return running;
  const job = fillTiebaNpcPool(id).finally(() => {
    if (barStockJobs.get(id) === job) barStockJobs.delete(id);
  });
  barStockJobs.set(id, job);
  return job;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || 'timeout')), ms);
    Promise.resolve(promise).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function tiebaVideoDue(barId) {
  const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const row = db.prepare(`
    SELECT 1 AS ok FROM tieba_threads
    WHERE bar_id=? AND media_type='video' AND created_at>=?
    LIMIT 1
  `).get(barId, since);
  return !row;
}

function queueTiebaMedia(barId, created, opts = {}) {
  const item = (created || []).find((row) => row?.id && row.scene);
  if (!item || tiebaMediaJob) return;
  if (!opts.scheduled) {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const recent = db.prepare(`
      SELECT 1 AS ok FROM tieba_threads
      WHERE bar_id=? AND IFNULL(media_url,'')!='' AND created_at>=?
      LIMIT 1
    `).get(barId, since);
    if (recent) return;
  }
  const job = attachTiebaMedia(barId, item).finally(() => {
    if (tiebaMediaJob === job) tiebaMediaJob = null;
  });
  tiebaMediaJob = job;
}

async function attachTiebaMedia(barId, item) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const api = require('./api-helper');
  const prompt = `Casual phone photo, natural light, no text, no watermark, no logo. ${item.scene}`;
  let url = '';
  try {
    url = await withTimeout(
      api.generateImage(settings, prompt, null, { aspect: '3:4' }),
      50000,
      'image',
    );
  } catch (e) {
    console.warn('[tieba] image', e.message);
    return;
  }
  if (!url) {
    console.warn('[tieba] image', api.getLastGenerateImageError?.() || 'empty');
    return;
  }
  let type = 'image';
  if (item.video && tiebaVideoDue(barId) && api.resolveImg2VideoConfig?.(settings)) {
    try {
      const videoUrl = await withTimeout(api.generateImageToVideo(settings, {
        prompt: 'handheld phone video, slight natural movement, no text',
        referenceImageUrl: url,
        aspect: '3:4',
        motionPromptCustom: item.scene,
      }), 90000, 'video');
      if (videoUrl) {
        url = videoUrl;
        type = 'video';
      }
    } catch (e) {
      console.warn('[tieba] video', e.message);
    }
  }
  db.prepare('UPDATE tieba_threads SET media_url=?, media_type=? WHERE id=?').run(url, type, item.id);
  db.prepare('UPDATE tieba_posts SET media_url=?, media_type=? WHERE thread_id=? AND floor=1').run(url, type, item.id);
  console.log('[tieba] media', item.id, type);
}

async function ensureTiebaRoster(bar) {
  const handles = ensureCharacterHandles(barCast(bar));
  let roster = tiebaRoster(bar.id, handles);
  if (roster.length >= TIEBA_NPC_POOL_MIN) return { handles, roster: roster.slice(0, 16) };
  try {
    await stockTiebaNpcs(bar.id);
  } catch (e) {
    console.warn('[tieba] npc stock', e.message);
  }
  roster = tiebaRoster(bar.id, handles);
  return { handles, roster: roster.slice(0, 16) };
}

async function generateBarNpcThreads(barId, opts = {}) {
  ensureTiebaTables();
  const bar = db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(barId);
  if (!bar) return { added: 0 };
  const want = TIEBA_POST_WANT;
  const cast = barCast(bar);
  const { handles, roster } = await ensureTiebaRoster(bar);
  const briefs = recentThreadBriefs(barId);
  const reserved = reservedSpeakerNames([bar.name, ...cast.map((c) => c.name)]);
  const allowed = allowHandles(reserved, handles);
  const prior = roster.length
    ? []
    : recentNpcs(bar.id, allowed).map((n) => n.name);
  const ctx = {
    reserved,
    allowed,
    recentAuthors: briefs.map((b) => b.author_name).filter((n) => !allowed.has(n)),
    staleAuthors: prior,
    roster,
    recentTitles: briefs.map((b) => b.title),
    want,
    replyLimit: 12,
  };
  const base = threadAsk(bar, cast, handles, roster, briefs, want);
  let best = null;
  let raw = '';
  const started = Date.now();
  for (let i = 0; i < 2; i += 1) {
    if (i > 0 && (Date.now() - started > 20000 || threadsFullEnough(best))) break;
    const extra = i
      ? `\n上次太短或不是 JSON。这次只输出紧凑 JSON。楼主用${roster.length ? '给定的吧友网名' : '新网名'}和角色贴吧号，每个帖 6 条不一样的短回复。`
      : '';
    raw = await askTiebaJson(NPC_SYSTEM, base + extra, { maxTokens: 1800 });
    const parsed = shapeTiebaNpcThreads(raw, ctx);
    if (!parsed) continue;
    if (!best || batchScore(parsed) > batchScore(best)) best = parsed;
    if (threadsFullEnough(best)) break;
  }
  if (!best) {
    console.warn('[tieba] npc threads unparsed', String(raw).slice(0, 180));
    throw new Error('吧友这会儿没写成，再拉一次');
  }
  const painted = paintHandleNpcs(best, handles);
  const saved = insertNpcThreads(bar.id, painted, opts.at || '');
  const added = saved?.added || 0;
  if (!added) throw new Error('吧友这会儿没写成，再拉一次');
  queueTiebaMedia(bar.id, saved.created, opts);
  const replyN = painted.reduce((n, t) => n + (t.replies?.length || 0), 0);
  console.log('[tieba] npc threads', bar.id, bar.name, added, 'replies', replyN, opts.at || 'now');
  return { added };
}

async function generateThreadNpcReplies(threadId) {
  ensureTiebaTables();
  const thread = db.prepare('SELECT * FROM tieba_threads WHERE id=?').get(threadId);
  if (!thread) return { added: 0 };
  const bar = db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(thread.bar_id);
  if (!bar) return { added: 0 };
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM tieba_posts WHERE thread_id=?').get(threadId)?.n || 0);
  const comments = Math.max(0, total - 1);
  const need = 12 - comments;
  if (need < 3) return { added: 0 };
  const floors = db.prepare('SELECT floor FROM tieba_posts WHERE thread_id=? ORDER BY floor ASC').all(threadId)
    .map((r) => r.floor);
  const posts = db.prepare(`
    SELECT floor, author_name, content FROM tieba_posts
    WHERE thread_id=?
    ORDER BY floor DESC
    LIMIT 8
  `).all(threadId).reverse();
  const cast = barCast(bar);
  const { handles, roster } = await ensureTiebaRoster(bar);
  const reserved = reservedSpeakerNames([
    bar.name,
    thread.author_name,
    ...posts.map((p) => p.author_name),
    ...cast.map((c) => c.name),
  ]);
  const allowed = allowHandles(reserved, handles);
  const ctx = {
    reserved,
    allowed,
    staleAuthors: roster.length ? [] : recentNpcs(bar.id, allowed).map((n) => n.name),
    roster,
    keepNames: posts.map((p) => p.author_name),
    floors,
    existing: posts.map((p) => p.content),
    replyLimit: need,
  };
  const base = replyAsk(bar, thread, posts, handles, need, roster);
  let best = null;
  let raw = '';
  const started = Date.now();
  const enough = (list) => (list?.length || 0) >= Math.min(need, 8);
  for (let i = 0; i < 2; i += 1) {
    if (i > 0 && (Date.now() - started > 20000 || enough(best))) break;
    const extra = i ? `\n上次太短或不是 JSON。这次只输出紧凑 JSON，回帖人必须是${roster.length ? '给定的吧友' : '新网名'}或角色贴吧号。` : '';
    raw = await askTiebaJson(NPC_SYSTEM, base + extra, { maxTokens: 1800 });
    const parsed = shapeTiebaNpcReplies(raw, ctx);
    if (!parsed) continue;
    if (!best || parsed.length > best.length) best = parsed;
    if (enough(best)) break;
  }
  if (!best) {
    console.warn('[tieba] npc replies unparsed', String(raw).slice(0, 180));
    throw new Error('这会儿没人接话，再拉一次');
  }
  const painted = best.map((r) => {
    const hit = handles.find((h) => h.handle === r.npc?.name);
    if (!hit) return r;
    return { ...r, npc: { ...r.npc, characterId: hit.characterId, avatar: hit.avatar, persona: '角色' } };
  });
  const added = insertNpcReplies(thread.id, painted);
  if (!added) throw new Error('这会儿没人接话，再拉一次');
  console.log('[tieba] npc replies', thread.id, added);
  return { added };
}

async function respondToTiebaUser(threadId, userPost) {
  if (!userPost?.content) return [];
  ensureTiebaTables();
  const thread = db.prepare('SELECT * FROM tieba_threads WHERE id=?').get(Number(threadId));
  if (!thread) return [];
  const bar = db.prepare('SELECT * FROM tieba_bars WHERE id=?').get(thread.bar_id);
  if (!bar) return [];
  const handles = ensureCharacterHandles(barCast(bar));
  const parentFloor = Number(userPost.reply_to_floor) > 1 ? Number(userPost.reply_to_floor) : Number(userPost.floor);
  const parent = parentFloor > 0
    ? db.prepare('SELECT floor, author_name, content FROM tieba_posts WHERE thread_id=? AND floor=?').get(thread.id, parentFloor)
    : null;
  const reserved = reservedSpeakerNames([bar.name, userPost.author_name]);
  const allowed = allowHandles(reserved, handles);
  const roster = tiebaRoster(bar.id, handles).slice(0, 12);
  const lines = [
    `吧：${bar.name}`,
    `帖子：${clipText(thread.title, 40)}`,
    parent ? `这层楼是 ${parent.author_name}：${clipText(parent.content, 60)}` : '',
    `${userPost.author_name} 刚说：${clipText(userPost.content, 80)}`,
    handles.length ? `可以拿这些角色贴吧号接话，不要写本名：${handles.map((h) => h.handle).join('、')}` : '',
    roster.length ? `旁人从这些吧友里选，不要新造网名：${roster.map((n) => n.name).join('、')}` : '',
    parent && parent.author_name && parent.author_name !== userPost.author_name
      ? `请让 ${parent.author_name} 先接一句，再加两个旁人。`
      : '用三个不同的人接话。',
    `不要用 ${userPost.author_name} 这个名字当回复人。要接住刚才那句话，每条不超过 16 个字。`,
    '只输出 {"replies":[["网名","内容"]]}',
  ].filter(Boolean);
  const raw = await askTiebaJson(NPC_SYSTEM, lines.join('\n'), { maxTokens: 500, timeout: 18000 });
  const shaped = shapeTiebaNpcReplies(raw, {
    reserved,
    allowed,
    roster,
    keepNames: [parent?.author_name],
    staleAuthors: roster.length ? [] : recentNpcs(bar.id, allowed).map((n) => n.name),
    floors: [parentFloor, 1].filter((n) => n > 0),
    existing: [userPost.content],
    replyLimit: 3,
  });
  if (!shaped?.length) return [];
  const painted = shaped.map((r) => {
    const hit = handles.find((h) => h.handle === r.npc?.name);
    const npc = hit
      ? { ...r.npc, characterId: hit.characterId, avatar: hit.avatar, persona: '角色' }
      : r.npc;
    return { ...r, npc, replyTo: parentFloor > 1 ? parentFloor : 0 };
  });
  const before = Number(db.prepare('SELECT last_floor FROM tieba_threads WHERE id=?').get(thread.id)?.last_floor || 0);
  const added = insertNpcReplies(thread.id, painted);
  if (!added) return [];
  return db.prepare('SELECT * FROM tieba_posts WHERE thread_id=? AND floor>? ORDER BY floor ASC')
    .all(thread.id, before)
    .map(mapPost);
}

function listMyTiebaPosts(accountId) {
  ensureTiebaTables();
  return db.prepare(`
    SELECT p.id, p.thread_id, p.floor, p.content, p.created_at, p.author_name,
           t.title, b.name AS bar_name
    FROM tieba_posts p
    JOIN tieba_threads t ON t.id = p.thread_id
    LEFT JOIN tieba_bars b ON b.id = t.bar_id
    WHERE p.author_id=?
    ORDER BY p.id DESC
    LIMIT 30
  `).all(Number(accountId));
}

function tiebaContactCards() {
  ensureTiebaTables();
  let friends = [];
  try {
    const contacts = require('./contact-helper');
    friends = contacts.listFriendCharacters(db)
      .filter((c) => c.contact_status === 'friend' && !contacts.isCircleNpcCharacter(c))
      .slice(0, 12);
  } catch (e) {
    console.warn('[tieba] contacts', e.message);
    return [];
  }
  if (!friends.length) return [];
  const byId = new Map(friends.map((f) => [Number(f.id), f]));
  return ensureCharacterHandles(friends).map((h) => ({
    character_id: h.id,
    handle: h.handle,
    avatar: h.avatar || '',
    real: !!h.real,
    display_name: byId.get(Number(h.id))?.display_name || h.name,
  }));
}

function tiebaPerson(handle) {
  ensureTiebaTables();
  const name = String(handle || '').trim();
  if (!name) return null;
  const row = db.prepare('SELECT handle, avatar, real_name FROM tieba_handles WHERE handle=?').get(name);
  const threads = db.prepare(`
    SELECT t.*, b.name AS bar_name
    FROM tieba_threads t
    LEFT JOIN tieba_bars b ON b.id = t.bar_id
    WHERE t.author_name=?
    ORDER BY t.id DESC
    LIMIT 20
  `).all(name).map(mapThread);
  return {
    handle: name,
    avatar: row?.avatar || '',
    real: Number(row?.real_name) === 1,
    threads,
  };
}

function cooldownLeft(doneAt, id) {
  const prev = doneAt.get(id) || 0;
  return Math.max(0, NPC_REFRESH_GAP_MS - (Date.now() - prev));
}

function barHasNpcThreads(barId) {
  const row = db.prepare(`
    SELECT 1 AS ok FROM tieba_threads
    WHERE bar_id=? AND author_id IS NULL
    LIMIT 1
  `).get(Number(barId));
  return !!row;
}

async function refreshBarNpcPosts(barId) {
  const id = Number(barId);
  if (!id) return { added: 0 };
  const running = barNpcJobs.get(id);
  if (running) return running;
  if (cooldownLeft(barNpcDoneAt, id) > 0) return { added: 0, skipped: true };
  const job = generateBarNpcThreads(id)
    .then((result) => {
      if ((result?.added || 0) > 0) barNpcDoneAt.set(id, Date.now());
      return result || { added: 0 };
    })
    .finally(() => {
      if (barNpcJobs.get(id) === job) barNpcJobs.delete(id);
    });
  barNpcJobs.set(id, job);
  return job;
}

async function refreshThreadNpcReplies(threadId) {
  const id = Number(threadId);
  if (!id) return { added: 0 };
  const running = threadNpcJobs.get(id);
  if (running) return running;
  if (cooldownLeft(threadNpcDoneAt, id) > 0) return { added: 0, skipped: true };
  const job = generateThreadNpcReplies(id)
    .then((result) => {
      if ((result?.added || 0) > 0) threadNpcDoneAt.set(id, Date.now());
      return result || { added: 0 };
    })
    .finally(() => {
      if (threadNpcJobs.get(id) === job) threadNpcJobs.delete(id);
    });
  threadNpcJobs.set(id, job);
  return job;
}

// 白天几个时间点各写一轮。人不在页面里也会写，时间记在那个点上。
const TIEBA_SLOT_MINS = [8 * 60 + 15, 10 * 60 + 40, 13 * 60 + 5, 15 * 60 + 50, 18 * 60 + 20, 21 * 60 + 10];
let tiebaSlotTimer = null;
let tiebaSlotJob = null;

function tiebaBarSlotMins(barId) {
  const n = TIEBA_SLOT_MINS.length;
  const id = Math.abs(Number(barId) || 0);
  const a = id % n;
  let b = (id * 3 + 1) % n;
  if (b === a) b = (a + 1) % n;
  return [TIEBA_SLOT_MINS[a], TIEBA_SLOT_MINS[b]].sort((x, y) => x - y);
}

function tiebaSlotKey(date, mins) {
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${date}:${hh}:${mm}`;
}

function tiebaDueSlot(barId, npcSlot, date, nowMins) {
  const done = String(npcSlot || '');
  for (const mins of tiebaBarSlotMins(barId)) {
    if (mins > nowMins) continue;
    const key = tiebaSlotKey(date, mins);
    if (done < key) return { mins, key };
  }
  return null;
}

function tiebaLocalParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'Asia/Shanghai',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    mins: hour * 60 + Number(get('minute') || 0),
  };
}

function tiebaSlotStamp(dateStr, mins, tz) {
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
  let utc = Date.parse(`${dateStr}T${clock}Z`);
  if (!Number.isFinite(utc)) return nowIso();
  for (let i = 0; i < 3; i += 1) {
    const parts = tiebaLocalParts(new Date(utc), tz);
    const want = dateStr.split('-').map(Number);
    const got = parts.date.split('-').map(Number);
    const dayDiff = (Date.UTC(want[0], want[1] - 1, want[2]) - Date.UTC(got[0], got[1] - 1, got[2])) / 86400000;
    const diffMin = dayDiff * 1440 + (mins - parts.mins);
    if (!diffMin) break;
    utc += diffMin * 60000;
  }
  return new Date(utc).toISOString().replace('T', ' ').slice(0, 19);
}

function tiebaTimezone() {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key='timezone'`).get();
    const raw = String(row?.value || '').trim() || 'Asia/Shanghai';
    new Intl.DateTimeFormat('en-US', { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    return 'Asia/Shanghai';
  }
}

function tiebaCityMode() {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key='tieba_city_mode'`).get();
    return row?.value === 'split' ? 'split' : 'merge';
  } catch {
    return 'merge';
  }
}

function barsForNpcSchedule(mode) {
  const city = db.prepare(`
    SELECT * FROM tieba_bars
    WHERE kind='city'
      AND (
        (? = 'split' AND IFNULL(character_id,0) > 0)
        OR (? = 'merge' AND IFNULL(character_id,0) = 0)
      )
  `).all(mode, mode);
  const custom = db.prepare(`
    SELECT * FROM tieba_bars WHERE IFNULL(kind,'custom') != 'city'
  `).all();
  return [...city, ...custom];
}

async function writeOneDueTiebaNpcSlot() {
  ensureTiebaTables();
  const mode = tiebaCityMode();
  syncCityBars(mode);
  const tz = tiebaTimezone();
  const parts = tiebaLocalParts(new Date(), tz);
  if (parts.mins < TIEBA_SLOT_MINS[0]) return { added: 0 };
  const due = [];
  for (const bar of barsForNpcSchedule(mode)) {
    const slot = tiebaDueSlot(bar.id, bar.npc_slot, parts.date, parts.mins);
    if (!slot || barNpcJobs.has(bar.id)) continue;
    due.push({ bar, slot });
  }
  due.sort((a, b) => a.slot.mins - b.slot.mins || a.bar.id - b.bar.id);
  const next = due[0];
  if (!next) return { added: 0 };
  const elapsed = Math.max(0, parts.mins - next.slot.mins);
  const jitter = elapsed ? (Math.abs(Number(next.bar.id) * 17) % Math.min(13, elapsed + 1)) : 0;
  const at = tiebaSlotStamp(parts.date, next.slot.mins + jitter, tz);
  const id = next.bar.id;
  const job = generateBarNpcThreads(id, { scheduled: true, at })
    .finally(() => {
      if (barNpcJobs.get(id) === job) barNpcJobs.delete(id);
    });
  barNpcJobs.set(id, job);
  const result = await job;
  if ((result?.added || 0) > 0) {
    db.prepare('UPDATE tieba_bars SET npc_slot=? WHERE id=?').run(next.slot.key, id);
    barNpcDoneAt.set(id, Date.now());
    console.log('[tieba] npc slot', next.bar.name, next.slot.key, result.added);
  }
  return result || { added: 0 };
}

async function runDueTiebaNpcSlot(limit = 1) {
  if (tiebaSlotJob) return tiebaSlotJob;
  const job = (async () => {
    let added = 0;
    const n = Math.max(1, Math.min(3, Number(limit) || 1));
    for (let i = 0; i < n; i += 1) {
      try {
        const result = await writeOneDueTiebaNpcSlot();
        if (!(result?.added > 0)) break;
        added += result.added;
      } catch (e) {
        console.warn('[tieba] npc slot', e.message);
        break;
      }
    }
    return { added };
  })().finally(() => {
    if (tiebaSlotJob === job) tiebaSlotJob = null;
  });
  tiebaSlotJob = job;
  return job;
}

async function stockOneThinTiebaBar() {
  if (tiebaStockJob) return tiebaStockJob;
  const job = (async () => {
    ensureTiebaTables();
    const mode = tiebaCityMode();
    try { syncCityBars(mode); } catch (e) { console.warn('[tieba] npc stock', e.message); }
    for (const bar of barsForNpcSchedule(mode)) {
      if (barNpcJobs.has(bar.id) || barStockJobs.has(bar.id)) continue;
      const n = Number(db.prepare('SELECT COUNT(*) AS n FROM tieba_npcs WHERE bar_id=?').get(bar.id)?.n || 0);
      if (n >= TIEBA_NPC_POOL_MIN) continue;
      return stockTiebaNpcs(bar.id);
    }
    return { added: 0 };
  })().finally(() => {
    if (tiebaStockJob === job) tiebaStockJob = null;
  });
  tiebaStockJob = job;
  return job;
}

function startTiebaNpcSchedule() {
  if (tiebaSlotTimer) return;
  const tick = (limit) => {
    stockOneThinTiebaBar()
      .catch((e) => console.warn('[tieba] npc stock', e.message))
      .finally(() => {
        runDueTiebaNpcSlot(limit).catch((e) => console.warn('[tieba] npc slot', e.message));
      });
  };
  tiebaSlotTimer = setInterval(() => tick(1), 15 * 60 * 1000);
  setTimeout(() => tick(3), 8000);
  if (tiebaSlotTimer.unref) tiebaSlotTimer.unref();
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
  refreshBarNpcPosts,
  barHasNpcThreads,
  refreshThreadNpcReplies,
  tiebaBarHandles,
  respondToTiebaUser,
  listMyTiebaPosts,
  tiebaContactCards,
  tiebaPerson,
  runDueTiebaNpcSlot,
  tiebaDueSlot,
  tiebaSlotStamp,
  shapeTiebaNpcThreads,
  shapeTiebaNpcReplies,
  shapeTiebaNpcRoster,
};

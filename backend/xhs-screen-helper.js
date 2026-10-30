/**
 * 念后端转发云端画面：手机只跟念说话，由念去取图、把你点的位置送过去。
 */

const URL_KEY = 'xhs_screen_url';
const TOKEN_KEY = 'xhs_screen_token';
const MAX_PNG = 6_000_000;

function readConfig(settings) {
  const url = String(settings?.[URL_KEY] || '').trim().replace(/\/+$/, '');
  const token = String(settings?.[TOKEN_KEY] || '').trim();
  return { url, token };
}

function publicConfig(settings) {
  const { url, token } = readConfig(settings);
  return { url, hasToken: !!token };
}

function assertBaseUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('画面地址无效');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('地址要以 http:// 或 https:// 开头');
  }
  if (u.username || u.password) throw new Error('不要把口令写在地址里，填在口令一栏');
  if (!u.hostname) throw new Error('画面地址无效');
  return u.origin;
}

function saveConfig(setSetting, body) {
  const url = String(body?.url ?? '').trim().replace(/\/+$/, '');
  if (url) assertBaseUrl(url);
  setSetting(URL_KEY, url);
  const token = body?.token == null ? '' : String(body.token).trim();
  if (token) setSetting(TOKEN_KEY, token);
}

function endpoint(settings, path) {
  const { url, token } = readConfig(settings);
  if (!url) {
    const e = new Error('还没填写画面地址');
    e.code = 'unconfigured';
    throw e;
  }
  const origin = assertBaseUrl(url);
  return { href: `${origin}${path}`, token };
}

async function bridgeFetch(href, token, options) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let resp;
  try {
    resp = await fetch(href, { ...options, headers, timeout: 20000 });
  } catch (e) {
    const err = new Error('连不上云端画面。确认画面桥开着；念的后端和它在同一台机器时，地址填 http://127.0.0.1:8767');
    err.cause = e;
    throw err;
  }
  return resp;
}

async function fetchShot(settings) {
  const { href, token } = endpoint(settings, '/shot');
  const resp = await bridgeFetch(href, token, { method: 'GET' });
  const buf = typeof resp.buffer === 'function'
    ? await resp.buffer()
    : Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    let msg = `画面桥返回 ${resp.status}`;
    try {
      const j = JSON.parse(buf.toString('utf8'));
      if (j?.error) msg = String(j.error);
    } catch {}
    throw new Error(msg);
  }
  if (buf.length < 32 || buf.length > MAX_PNG) throw new Error('画面数据异常');
  const png = buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (!png) throw new Error('云端没有返回画面');
  return {
    ok: true,
    image: `data:image/png;base64,${buf.toString('base64')}`,
  };
}

function normalizePoint(body) {
  const x = Number(body?.x);
  const y = Number(body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error('点的位置要落在画面里面');
  }
  return { x, y };
}

async function clickAt(settings, body) {
  const point = normalizePoint(body);
  const { href, token } = endpoint(settings, '/click');
  const resp = await bridgeFetch(href, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(point),
  });
  const text = await resp.text();
  let data = {};
  try { data = JSON.parse(text || '{}'); } catch {}
  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || `点按失败 ${resp.status}`);
  }
  return {
    ok: true,
    px: data.px,
    py: data.py,
    width: data.width,
    height: data.height,
  };
}

module.exports = {
  URL_KEY,
  TOKEN_KEY,
  readConfig,
  publicConfig,
  saveConfig,
  fetchShot,
  clickAt,
  normalizePoint,
  assertBaseUrl,
};

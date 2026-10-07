const crypto = require('crypto');

const COOKIE_NAME = 'nian_site_session';
const SESSION_MS = 90 * 24 * 60 * 60 * 1000;

function isEnabled() {
  const v = process.env.SITE_LOCK_ENABLED;
  return v === '1' || v === 'true';
}

function getSecret() {
  return process.env.SITE_LOCK_SECRET || process.env.SITE_LOCK_PASS || 'nian-change-me';
}

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    const first = String(fwd).split(',')[0].trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

function normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return '127.0.0.1';
  return s;
}

function isLoopbackIp(ip) {
  const s = normalizeIp(ip);
  return s === '127.0.0.1' || s === 'localhost';
}

function isPrivateLanIp(ip) {
  const s = normalizeIp(ip);
  if (isLoopbackIp(s)) return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  return false;
}

/**
 * 是否校验会话绑定的 IP。
 * 默认关闭：同一浏览器 Cookie/本地 token 有效期内换 Wi‑Fi、流量也不用重输密码；
 * 换浏览器 / 清站点数据才要再登。需要更严可设 SITE_LOCK_BIND_IP=1。
 */
function shouldBindIp() {
  const v = String(process.env.SITE_LOCK_BIND_IP || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  return false;
}

function ipsMatch(sessionIp, reqIp) {
  const a = normalizeIp(sessionIp);
  const b = normalizeIp(reqIp);
  if (a === b) return true;
  if (isLoopbackIp(a) && isLoopbackIp(b)) return true;
  return false;
}

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readSessionToken(req) {
  const header = String(req.headers?.['x-nian-session'] || '').trim();
  if (header) return header;
  const auth = String(req.headers?.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const cookies = parseCookieHeader(req.headers?.cookie);
  return cookies[COOKIE_NAME] || '';
}

function parseSessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.ip !== 'string' || !payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function isAuthenticated(req) {
  if (!isEnabled()) return true;
  const payload = parseSessionToken(readSessionToken(req));
  if (!payload) return false;
  if (Date.now() > payload.exp) return false;
  if (!shouldBindIp()) return true;
  const reqIp = getClientIp(req);
  // 本机/局域网：不因 IP 字符串细微差异（127.0.0.1 vs ::1 等）反复要求验证
  if (isPrivateLanIp(payload.ip) && isPrivateLanIp(reqIp)) return true;
  return ipsMatch(payload.ip, reqIp);
}

function envVal(key) {
  return String(process.env[key] || '').trim().replace(/\r/g, '');
}

function verifyCredentials(username, password) {
  const user = envVal('SITE_LOCK_USER');
  const pass = envVal('SITE_LOCK_PASS');
  if (!user || !pass) return false;
  const u = String(username || '').trim();
  const p = String(password || '').trim();
  return u === user && p === pass;
}

function createSessionToken(req) {
  return signPayload({
    ip: getClientIp(req),
    exp: Date.now() + SESSION_MS,
  });
}

function getCookieOptions(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!secure,
    maxAge: SESSION_MS,
    path: '/',
  };
}

/**
 * 桌宠设备令牌：请求头 X-Nian-Robot-Token 或 Authorization: Robot <token>
 * 实际比对在路由里用 settings.robot_token；此处仅放行路径进入后续校验。
 */
function readRobotToken(req) {
  const header = String(req.headers?.['x-nian-robot-token'] || '').trim();
  if (header) return header;
  const auth = String(req.headers?.authorization || '');
  if (/^Robot\s+/i.test(auth)) return auth.replace(/^Robot\s+/i, '').trim();
  return '';
}

function siteLockMiddleware(req, res, next) {
  if (!isEnabled()) return next();
  if (req.path === '/api/health') return next();
  if (req.path === '/api/app-update' || req.path === '/api/app-update/apk') return next();
  if (req.path.startsWith('/api/site-auth/')) return next();
  // 桌宠专用接口：允许带设备令牌进路由（路由内再校验 robot_token）
  if (req.path.startsWith('/api/robot/') && readRobotToken(req)) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: '需要验证', needsAuth: true });
}

module.exports = {
  COOKIE_NAME,
  isEnabled,
  isAuthenticated,
  verifyCredentials,
  createSessionToken,
  getCookieOptions,
  siteLockMiddleware,
  getClientIp,
  readRobotToken,
};

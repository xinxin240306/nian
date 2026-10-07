const { WebSocketServer } = require('ws');
const { sendWebPushForEvent } = require('./web-push-helper');
const siteLock = require('./site-lock');

let wss = null;
const clients = new Set();

function initWS(server) {
  wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    if (siteLock.isEnabled() && !siteLock.isAuthenticated(req)) {
      ws.close(4401, 'auth required');
      return;
    }
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', msg: '念·信道已建立' }));
  });
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function push(type, payload) {
  // envelope `type` 必须压过 payload 里的字段，否则 robot_event 会被
  // payload.type（mic_listening / mood_face）盖掉，前端 switch 收不到。
  broadcast({ ...(payload || {}), type });
  if (type === 'proactive_message' || type === 'background_message') {
    try { require('./phone-state-helper').enqueueCapsule(payload || {}); } catch {}
  }
  if (type === 'proactive_call') {
    try { require('./phone-state-helper').enqueueIncomingCall(payload || {}); } catch {}
  }
  setImmediate(() => {
    sendWebPushForEvent(type, payload).catch(e => console.error('[webpush]', e.message));
  });
}

/** 额度不足时弹系统通知（带冷却，避免后台任务连弹） */
const _billingNoticeAt = new Map();
function notifyBillingError(scopeLabel, errMsg, opts = {}) {
  const { isApiBillingError, formatApiBillingError } = require('./api-helper');
  if (!isApiBillingError(errMsg)) return false;
  const label = String(scopeLabel || 'API').trim() || 'API';
  const cooldownMs = Number(opts.cooldownMs) >= 0 ? Number(opts.cooldownMs) : 90 * 1000;
  const key = opts.perCharacter && opts.characterId
    ? `${label}:${opts.characterId}`
    : label;
  const now = Date.now();
  if (now - (_billingNoticeAt.get(key) || 0) < cooldownMs) return false;
  _billingNoticeAt.set(key, now);
  const friendly = formatApiBillingError(errMsg, { label });
  push('system_notice', {
    message: friendly,
    scope: 'billing',
    characterId: opts.characterId || null,
  });
  return true;
}

function hasClients() {
  for (const ws of clients) {
    if (ws.readyState === 1) return true;
  }
  return false;
}

module.exports = { initWS, push, broadcast, hasClients, notifyBillingError };

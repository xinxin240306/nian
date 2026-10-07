/* ===== Web Push 订阅（HTTPS + 用户授权后生效） ===== */
import * as api from './api.js';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isPushEnvironmentReady() {
  if (location.protocol === 'https:') return true;
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function subscriptionToJson(sub) {
  if (!sub) return null;
  if (typeof sub.toJSON === 'function') return sub.toJSON();
  return JSON.parse(JSON.stringify(sub));
}

/** 等待 Service Worker 就绪后订阅/续订 Web Push */
export async function ensureWebPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (Notification.permission !== 'granted') {
    return { ok: false, reason: 'no_permission' };
  }
  if (!isPushEnvironmentReady()) {
    return { ok: false, reason: 'need_https' };
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api.getPushPublicKey();
    if (!publicKey) return { ok: false, reason: 'no_vapid' };

    const appKey = urlBase64ToUint8Array(publicKey);
    let sub = await reg.pushManager.getSubscription();

    if (sub) {
      const existingKey = sub.options?.applicationServerKey;
      let keyMismatch = false;
      if (existingKey && existingKey.byteLength === appKey.byteLength) {
        for (let i = 0; i < appKey.byteLength; i++) {
          if (existingKey[i] !== appKey[i]) { keyMismatch = true; break; }
        }
      }
      if (keyMismatch) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
    }

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appKey,
      });
    }

    await api.subscribePush(subscriptionToJson(sub));
    return { ok: true, endpoint: sub.endpoint };
  } catch (e) {
    console.warn('[push] subscribe failed', e);
    return { ok: false, reason: e.message || 'subscribe_failed' };
  }
}

/** 与 ensureWebPushSubscription 相同，保留旧名兼容 */
export async function subscribeWebPush() {
  return ensureWebPushSubscription();
}

export async function unsubscribeWebPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api.unsubscribePush({ endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export async function getLocalPushStatus() {
  const base = {
    supported: 'serviceWorker' in navigator && 'PushManager' in window,
    https: isPushEnvironmentReady(),
    permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
    subscribed: false,
  };
  if (!base.supported || base.permission !== 'granted' || !base.https) return base;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    base.subscribed = !!sub?.endpoint;
    base.endpoint = sub?.endpoint || '';
  } catch {}
  return base;
}

export async function testWebPush() {
  try {
    return await api.testPush();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function pushSubscribeHint(reason) {
  switch (reason) {
    case 'need_https': return 'Web Push 需要 HTTPS，部署证书后再开启';
    case 'unsupported': return '当前浏览器不支持 Web Push';
    case 'no_permission': return '请先允许通知权限';
    case 'no_vapid': return '服务端未配置推送密钥，请重启后端';
    default: return reason ? `推送订阅失败：${reason}` : '';
  }
}

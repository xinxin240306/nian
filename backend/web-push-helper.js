/**
 * Web Push：App 被划掉后仍可通过系统推送服务收到通知（需 HTTPS + 用户订阅）
 */
let webpush;
try {
  webpush = require('web-push');
} catch (e) {
  console.warn('[webpush] 未安装 web-push，请在 backend 目录运行: npm install web-push');
}

const db = require('./db');

let vapidReady = false;

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function ensureVapid(settings) {
  if (!webpush) return null;
  if (vapidReady && settings.vapid_public_key) return settings.vapid_public_key;

  let pub = settings.vapid_public_key;
  let priv = settings.vapid_private_key;
  let subject = settings.vapid_subject;

  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    upsert.run('vapid_public_key', pub);
    upsert.run('vapid_private_key', priv);
    console.log('[webpush] 已自动生成 VAPID 密钥（HTTPS 部署后推送即可用）');
  }

  if (!subject) {
    subject = process.env.VAPID_SUBJECT || 'mailto:nian@local.app';
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vapid_subject', subject);
  } else if (process.env.VAPID_SUBJECT && subject !== process.env.VAPID_SUBJECT) {
    subject = process.env.VAPID_SUBJECT;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vapid_subject', subject);
    vapidReady = false;
  }

  webpush.setVapidDetails(subject, pub, priv);
  vapidReady = true;
  return pub;
}

function getPublicKey() {
  if (!webpush) throw new Error('web-push 未安装');
  const settings = getSettings();
  return ensureVapid(settings);
}

function saveSubscription(subscription, userAgent = '') {
  if (!subscription?.endpoint || !subscription?.keys) return false;
  db.prepare(`
    INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, user_agent, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    String(userAgent || '').slice(0, 300)
  );
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('push_enabled', '1');
  return true;
}

function removeSubscription(endpoint) {
  if (!endpoint) return;
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
  const left = db.prepare('SELECT COUNT(*) as c FROM push_subscriptions').get()?.c || 0;
  if (left === 0) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('push_enabled', '0');
  }
}

function getCharName(charId) {
  if (!charId) return 'TA';
  const c = db.prepare('SELECT name FROM characters WHERE id=?').get(charId);
  return c?.name || 'TA';
}

function formatPushMsgPreview(msg) {
  if (!msg) return '新消息';
  const type = msg.type || 'text';
  if (type === 'voice') {
    try {
      const j = JSON.parse(String(msg.content || ''));
      if (j?.score) return String(j.transcript || '♪ 演奏').slice(0, 40);
      if (j?.voice && j.transcript) return `[语音] ${String(j.transcript).slice(0, 36)}`;
    } catch {}
    return '[语音]';
  }
  if (type === 'emoji') return '[表情包]';
  if (type === 'image' || type === 'video') return '[图片]';
  if (type === 'location') return '[位置]';
  if (type === 'link') {
    const raw = String(msg.content || '').trim();
    const title = raw.split(/[|｜]/)[0].trim();
    return title ? `[链接] ${title}`.slice(0, 120) : '[链接]';
  }
  if (type === 'web_card') {
    try {
      const j = JSON.parse(String(msg.content || '').trim() || '{}');
      const title = String(j?.title || '').trim();
      return title ? `[网页卡] ${title}`.slice(0, 120) : '[网页卡]';
    } catch {
      return '[网页卡]';
    }
  }
  return String(msg.content || '新消息').slice(0, 120);
}

function buildNotification(type, payload, settings) {
  const icon = '/assets/icons/icon-192.png';

  switch (type) {
    case 'proactive_message':
    case 'background_message': {
      const name = getCharName(payload.characterId);
      const msgs = payload.aiMessages?.length
        ? payload.aiMessages
        : [{ type: 'text', content: payload.content || '发来新消息' }];
      return msgs.map((msg, i) => ({
        title: name,
        body: formatPushMsgPreview(msg),
        tag: `nian-chat-${payload.characterId}-${msg.id || i}`,
        data: { charId: payload.characterId, open: 'chat' },
        icon,
      }));
    }
    case 'moment_comment': {
      const name = payload.charName || getCharName(payload.charId);
      const body = (payload.content || '评论了你的朋友圈').slice(0, 120);
      return {
        title: name,
        body: payload.isReply ? `回复你：${body}` : `评论：${body}`,
        tag: `nian-moment-${payload.momentId}`,
        data: { momentId: payload.momentId, open: 'moments' },
        icon,
      };
    }
    case 'moment_like': {
      const name = payload.charName || getCharName(payload.charId);
      return {
        title: name,
        body: '赞了你的朋友圈',
        tag: `nian-like-${payload.momentId}`,
        data: { momentId: payload.momentId, open: 'moments' },
        icon,
      };
    }
    case 'ai_poke': {
      const name = payload.charName || getCharName(payload.characterId);
      return {
        title: name,
        body: (payload.text || '拍了拍你').slice(0, 120),
        tag: `nian-poke-${payload.characterId}`,
        data: { charId: payload.characterId, open: 'chat' },
        icon,
      };
    }
    case 'proactive_call': {
      const name = payload.charName || getCharName(payload.characterId);
      return {
        title: `${name} 来电`,
        body: (payload.content || '邀请你通话').slice(0, 80),
        tag: `nian-call-${payload.characterId}`,
        data: { charId: payload.characterId, open: 'call', content: payload.content || '' },
        icon,
      };
    }
    case 'new_moment': {
      const name = getCharName(payload.characterId);
      return {
        title: name,
        body: '发了朋友圈',
        tag: `nian-moment-new-${payload.characterId}`,
        data: { open: 'moments' },
        icon,
      };
    }
    case 'ai_diary':
      return {
        title: getCharName(payload.characterId),
        body: '写了新日记',
        tag: `nian-diary-${payload.characterId}`,
        data: { charId: payload.characterId, open: 'diary' },
        icon,
      };
    default:
      return null;
  }
}

async function sendWebPushForEvent(type, payload) {
  if (!webpush) return;
  const settings = getSettings();
  if (settings.push_enabled === '0') return;

  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!subs.length) return;

  const notifList = buildNotification(type, payload, settings);
  if (!notifList?.length) return;
  const notifications = Array.isArray(notifList) ? notifList : [notifList];

  ensureVapid(settings);
  if (!vapidReady) return;

  for (const notif of notifications) {
    const body = JSON.stringify({
      title: notif.title,
      body: notif.body,
      tag: notif.tag,
      data: notif.data,
      icon: notif.icon,
    });

    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
          },
          body,
          { TTL: 60 * 60 * 12, urgency: 'high' }
        );
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(sub.endpoint);
        }
      }
    }));
  }
}

function getPushStatus() {
  const settings = getSettings();
  const count = db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get()?.c || 0;
  let vapidPublic = '';
  try {
    vapidPublic = getPublicKey() || settings.vapid_public_key || '';
  } catch {}
  return {
    enabled: settings.push_enabled !== '0',
    subscriptionCount: count,
    hasVapid: !!vapidPublic,
    vapidPublicKey: vapidPublic ? vapidPublic.slice(0, 12) + '…' : '',
  };
}

async function sendTestPush(title = '念', body = 'Web Push 测试成功') {
  if (!webpush) throw new Error('web-push 未安装');
  const settings = getSettings();
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!subs.length) throw new Error('尚无推送订阅，请先在 App 内开启通知');

  ensureVapid(settings);
  if (!vapidReady) throw new Error('VAPID 未就绪');

  const payload = JSON.stringify({
    title,
    body,
    tag: 'nian-push-test',
    data: { open: 'home' },
    icon: '/assets/icons/icon-192.png',
  });

  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
        },
        payload,
        { TTL: 300, urgency: 'high' }
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        removeSubscription(sub.endpoint);
      } else {
        throw e;
      }
    }
  }));
  if (!sent) throw new Error('推送发送失败，请重新开启通知');
  return { sent };
}

module.exports = {
  getPublicKey,
  saveSubscription,
  removeSubscription,
  sendWebPushForEvent,
  getPushStatus,
  sendTestPush,
};

/**
 * 对方在小红书上的号。角色用来认出评论和主页里的人是不是念里的对方。
 */

const NICK_KEY = 'xhs_me_nickname';
const RED_KEY = 'xhs_me_red_id';
const USER_KEY = 'xhs_me_user_id';

function clip(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const USER_ID_RE = /^[0-9a-zA-Z]{6,32}$/;

function parseUserId(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const fromUrl = text.match(/\/user\/profile\/([0-9a-zA-Z]+)/);
  if (fromUrl && USER_ID_RE.test(fromUrl[1])) return fromUrl[1];
  if (USER_ID_RE.test(text)) return text;
  return null;
}

function extractUserId(raw) {
  const id = parseUserId(raw);
  if (id == null) {
    throw new Error('用户 ID 不对。可以贴分享短链、主页链接，或 profile/ 后面那段。');
  }
  return id;
}

function pickShortLink(raw) {
  const m = String(raw || '').match(/https?:\/\/(?:www\.)?xhslink\.cn\/[^\s<>"']+/i);
  if (!m) return '';
  return m[0].replace(/[，。,.]+$/, '');
}

function followOnce(url) {
  const https = require('https');
  const target = new URL(url);
  if (target.protocol !== 'https:' || !/^(?:www\.)?(?:xhslink\.cn|xiaohongshu\.com)$/i.test(target.hostname)) {
    return Promise.reject(new Error('只接受小红书的分享链接。'));
  }
  return new Promise((resolve, reject) => {
    const req = https.get(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
      timeout: 8000,
    }, (res) => {
      res.resume();
      resolve(String(res.headers.location || ''));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('分享链接没打开。'));
    });
    req.on('error', () => reject(new Error('分享链接没打开。')));
  });
}

async function resolveUserId(raw) {
  const direct = parseUserId(raw);
  if (direct != null) return direct;
  const short = pickShortLink(raw);
  if (!short) extractUserId(raw);
  let current = short;
  for (let i = 0; i < 3; i += 1) {
    const location = await followOnce(current);
    const id = parseUserId(location);
    if (id) return id;
    if (!location) break;
    current = location;
  }
  throw new Error('这条分享链接里没有主页 ID。打开自己的主页，重新复制链接再贴一次。');
}

function extractRedId(raw) {
  const text = clip(raw, 32);
  if (!text) return '';
  if (!/^[0-9a-zA-Z_\-]{3,32}$/.test(text)) {
    throw new Error('小红书号只保留数字、字母和常见符号，不要带空格。');
  }
  return text;
}

function read(settings) {
  return {
    nickname: clip(settings?.[NICK_KEY], 40),
    redId: clip(settings?.[RED_KEY], 32),
    userId: clip(settings?.[USER_KEY], 32),
  };
}

function save(setSetting, body) {
  const nickname = clip(body?.nickname, 40);
  const redId = extractRedId(body?.redId);
  const userId = extractUserId(body?.userId);
  if (!nickname && !redId && !userId) {
    throw new Error('至少填昵称、小红书号、用户 ID 里的一项，他才认得出你。');
  }
  setSetting(NICK_KEY, nickname);
  setSetting(RED_KEY, redId);
  setSetting(USER_KEY, userId);
  return { nickname, redId, userId };
}

function clear(setSetting) {
  setSetting(NICK_KEY, '');
  setSetting(RED_KEY, '');
  setSetting(USER_KEY, '');
}

function promptBlock(settings) {
  const me = read(settings);
  if (!me.nickname && !me.redId && !me.userId) return '';
  const lines = ['【小红书·对方的号·不说出口】'];
  if (me.nickname) lines.push(`对方的小红书昵称是「${me.nickname}」。`);
  if (me.redId) lines.push(`对方的小红书号是「${me.redId}」。`);
  if (me.userId) lines.push(`对方的小红书用户 ID 是「${me.userId}」。`);
  lines.push('评论、点赞、主页里对上昵称、小红书号或用户 ID，那就是念里的这个人，不是路人。没对上就当普通网友。');
  lines.push('评论里要叫对方时，正文里写 @ 加上对方昵称。这只是评论里的字。');
  if (me.userId) {
    lines.push('要回对方自己的那条评论时，用回复评论，并带上这个用户 ID，这样回的是对方。');
  }
  lines.push('不要在聊天里把这组号码念出来，除非对方问。');
  return lines.join('\n');
}

module.exports = {
  NICK_KEY,
  RED_KEY,
  USER_KEY,
  read,
  save,
  clear,
  promptBlock,
  resolveUserId,
};

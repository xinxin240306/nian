/**
 * 桌宠摄像头：判断镜头里是不是用户本人（参考用户头像 + 可选声纹提示）
 */

const { callChatAPIComplete, buildHistoryApiMessages, toAbsoluteMediaUrl } = require('./api-helper');

function parseVisionJson(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/**
 * @param {object} settings
 * @param {string} sceneImageUrl - 摄像头画面 /uploads/...
 * @param {string} publicBase
 * @returns {Promise<{ isUser: boolean, subjectType: string, confidence: number, note: string }>}
 */
async function inferSubjectFromImage(settings, sceneImageUrl, publicBase = '') {
  const scene = toAbsoluteMediaUrl(sceneImageUrl, publicBase);
  if (!scene) {
    return { isUser: false, subjectType: 'none', confidence: 0, note: '无画面' };
  }
  const ref = toAbsoluteMediaUrl(String(settings?.user_avatar || '').trim(), publicBase);
  if (!ref) {
    return {
      isUser: false,
      subjectType: 'unknown',
      confidence: 0.25,
      note: '未设置用户头像参考，无法辨认是不是你',
    };
  }

  const systemPrompt = [
    '你是视觉辨认助手。比较「用户参考照」与「机器人摄像头画面」。',
    '判断画面里最主要的那个人是不是参考照里的同一人（用户本人）。',
    '只输出 JSON，不要其它字：{"isUser":true或false,"confidence":0到1的小数,"subjectType":"user|other|none|unknown","note":"一句中文"}',
    'subjectType: user=确认是用户, other=明显是别人, none=没拍到人, unknown=看不清',
  ].join('\n');

  const picMsgs = [
    { id: 'id_ref', role: 'user', content: ref, type: 'image' },
    { id: 'id_scene', role: 'user', content: scene, type: 'image' },
  ];
  let apiHistory = buildHistoryApiMessages(picMsgs, publicBase, {});
  const ask = '第二张摄像头画面里主要那个人，是不是第一张参考照里的同一人？只输出 JSON。';
  if (apiHistory.length) {
    const last = apiHistory[apiHistory.length - 1];
    if (Array.isArray(last.content)) {
      last.content.unshift({ type: 'text', text: ask });
    } else {
      apiHistory.push({ role: 'user', content: ask });
    }
  }

  try {
    const raw = await callChatAPIComplete(
      settings,
      systemPrompt,
      null,
      'chat',
      apiHistory,
    );
    const parsed = parseVisionJson(raw);
    if (!parsed) {
      return { isUser: false, subjectType: 'unknown', confidence: 0.2, note: '辨认未返回结果' };
    }
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const subjectType = String(parsed.subjectType || '').trim().toLowerCase();
    let isUser = parsed.isUser === true || parsed.isUser === 'true';
    if (subjectType === 'user' && confidence >= 0.45) isUser = true;
    if (subjectType === 'other' || subjectType === 'none') isUser = false;
    return {
      isUser,
      subjectType: subjectType || (isUser ? 'user' : 'unknown'),
      confidence,
      note: String(parsed.note || '').trim().slice(0, 120),
    };
  } catch (e) {
    console.warn('[robot-identity]', e.message);
    return { isUser: false, subjectType: 'unknown', confidence: 0, note: '辨认失败' };
  }
}

function mergeSubjectHints(opts = {}) {
  const facePresent = opts.facePresent === true;
  const isUser = opts.isUser === true;
  const subjectType = String(opts.subjectType || '').trim().toLowerCase();
  const confidence = Number(opts.confidence) || 0;
  if (!facePresent) {
    return { isUser: false, subjectType: 'none', confidence: 0, facePresent: false };
  }
  if (isUser || subjectType === 'user') {
    return {
      isUser: true,
      subjectType: 'user',
      confidence: Math.max(confidence, 0.5),
      facePresent: true,
    };
  }
  if (subjectType === 'other') {
    return { isUser: false, subjectType: 'other', confidence, facePresent: true };
  }
  return {
    isUser: false,
    subjectType: subjectType || 'unknown',
    confidence,
    facePresent: true,
  };
}

module.exports = {
  inferSubjectFromImage,
  mergeSubjectHints,
};

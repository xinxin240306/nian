const nodeFetch = require('node-fetch');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

/**
 * 音乐控制：通过前端发送命令到原生层
 * 后端仅返回指令确认，实际执行在前端触发
 */
async function handleMusicControl(action) {
  const validActions = ['next', 'previous', 'play_pause'];
  if (!validActions.includes(action)) {
    return { ok: false, error: 'invalid_action' };
  }
  
  // 返回成功标记，让前端通过 WebSocket/轮询获取并执行
  return {
    ok: true,
    action,
    note: '切歌指令已发送',
  };
}

/** node-fetch 的 timeout + AbortSignal，避免原生 fetch 忽略 timeout 导致挂死 */
function fetchWithTimeout(url, options = {}) {
  const timeoutMs = Number(options.timeout ?? options.timeoutMs ?? 0) || 0;
  const { timeout, timeoutMs: _ignored, signal: outerSignal, ...rest } = options;
  if (!timeoutMs && !outerSignal) {
    return nodeFetch(url, rest);
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  const timer = (timeoutMs > 0 && controller)
    ? setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch {}
    }, timeoutMs)
    : null;
  if (controller && outerSignal) {
    if (outerSignal.aborted) {
      try { controller.abort(); } catch {}
    } else {
      outerSignal.addEventListener('abort', () => { try { controller.abort(); } catch {} }, { once: true });
    }
  }
  const reqOpts = {
    ...rest,
    ...(controller ? { signal: controller.signal } : {}),
    // 不再叠 node-fetch 自带 timeout：与 AbortSignal 双杀时会把超时报成「The user aborted a request」
  };
  return nodeFetch(url, reqOpts)
    .catch((err) => {
      const msg = String(err?.message || err || '');
      if (timedOut || /aborted a request|AbortError|The operation was aborted|signal is aborted/i.test(msg)) {
        if (timedOut) {
          const e = new Error(`上游 API 超时（${Math.round(timeoutMs / 1000)}s）：${String(url).slice(0, 80)}`);
          e.code = 'ETIMEDOUT';
          e.cause = err;
          throw e;
        }
      }
      throw err;
    })
    .finally(() => { if (timer) clearTimeout(timer); });
}

const fetch = fetchWithTimeout;

/** 慢速图生图（Banana / gpt-image 等）控制台常见 5～10 分钟；等不够会显示失败，但对方已扣费 */
const IMAGE_GEN_MAX_WAIT_MS = 15 * 60 * 1000;

function isImageGenWaitTimeoutError(msg) {
  return /超时|ETIMEDOUT|timeout|aborted a request|AbortError|The operation was aborted/i.test(String(msg || ''));
}

let _formatMessageForAi = null;
function getFormatMessageForAi() {
  if (!_formatMessageForAi) {
    try { _formatMessageForAi = require('./emoji-helper').formatMessageForAi; } catch { _formatMessageForAi = (m) => m?.content || ''; }
  }
  return _formatMessageForAi;
}

const AVATAR_CHANGE_PATTERNS = [
  /换(个|一个|下|上)?头像/,
  /换上当头像/,
  /换上(?:这个|这张|那|它|图片|照片)?(?:当|做|作|成)?(?:你的)?头像/,
  /情侣头像/,
  /一起换/,
  /用(?:这个|这张|那|它)?(?:当|做|作|成)?(?:你的)?头像/,
  /头像换(成|一下|了)/,
  /(我们|咱们)(的)?头像/,
  /(?:这个|这张|那张|它)(?:当|做|作|成)?(?:你的)?头像/,
  /(?:设|改|换成|改成|设置)(?:为|成|成你的)?头像/,
  /当(?:你的)?头像/,
  /做(?:你的)?头像/,
];

/** AI 同意换头像时写的标记（用户不可见，解析后剥离） */
function replyAcceptsAvatarChange(text) {
  return /[\[【［]\s*(?:换头像|同意换头像)\s*[\]】］]/i.test(String(text || ''));
}

function stripAvatarChangeMarker(text) {
  if (!text) return text || '';
  return String(text)
    .replace(/[\[【［]\s*(?:换头像|同意换头像)\s*[\]】］]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 有待换头像图时注入：由角色决定是否写 [换头像] */
function buildAvatarChangeChoiceHint() {
  return '[用户发来一张图片，希望你换上当头像。由你自己决定：想换就在回复里单独写一行 [换头像]（用户看不到这行，系统会帮你换上）；不想换就自然拒绝或婉拒，不要写 [换头像]。不要提「系统」「标记」或「指令」。]';
}

function toAbsoluteMediaUrl(url, baseUrl) {
  if (!url || typeof url !== 'string') return url;
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || u.startsWith('data:')) return u;
  const base = String(baseUrl || '').replace(/\/$/, '');
  return u.startsWith('/') ? `${base}${u}` : `${base}/${u}`;
}

function isImageMessageType(type) {
  return type === 'image' || type === 'video';
}

function isPlaceholderMediaContent(url) {
  const s = String(url || '').trim();
  return !s
    || s.startsWith('__pending_')
    || s.startsWith('__selfie_failed__')
    || s.startsWith('__video_failed__');
}

function assistantOwnImageLabel(msg, { attachImage = false } = {}) {
  try {
    const { formatAlbumMessageForAi } = require('./album-helper');
    const album = formatAlbumMessageForAi(msg);
    if (album && album !== '[相册图]' && album !== '[相册视频]') {
      return attachImage
        ? `这是你自己发给对方的图：${album}。请看清画面，不是用户发来的。`
        : `你发给对方的${album}`;
    }
  } catch { /* 无相册描述就用短标签 */ }
  return attachImage
    ? '[这是你自己发给对方的一张图，请看清画面。不是用户发来的。]'
    : '[你发给对方的一张图片]';
}

function parseMsgMediaMeta(msg) {
  const raw = msg?.media_meta;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(String(raw));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/**
 * 桌上小机镜头拍回来的一帧。它是角色自己的视觉，不是用户发的图，
 * 所以既不能套「用户发来一张图片」的说法，也不能因为 role=assistant 就只留文字占位。
 */
function isRobotFrameMessage(msg) {
  if (!msg?.content || msg.type !== 'image') return false;
  return !!parseMsgMediaMeta(msg).robotFrame;
}

/** 小机麦克风上行：隐藏语音条，最近一条附真音频给模型听。 */
function isRobotMicMessage(msg) {
  if (!msg?.content || msg.type !== 'voice') return false;
  return !!parseMsgMediaMeta(msg).robotMic;
}

/**
 * 机身画面就在本机磁盘上，直接转 base64。
 * 走绝对 URL 要依赖 public_base_url 配对且模型侧能拉到图，多一个说不清的失败点。
 */
function localUploadToDataUrl(url) {
  try {
    const rel = String(url || '').split('?')[0];
    if (!rel.startsWith('/uploads/')) return '';
    const name = decodeURIComponent(rel.slice('/uploads/'.length));
    if (!name || name.includes('/') || name.includes('..')) return '';
    const fp = require('path').join(__dirname, 'uploads', name);
    const fs = require('fs');
    if (!fs.existsSync(fp)) return '';
    const buf = fs.readFileSync(fp);
    if (!buf.length) return '';
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

function parseUserVoicePayload(content) {
  const raw = String(content || '').trim();
  if (!raw.startsWith('{')) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.voice === true && j.url) return j;
  } catch {}
  return null;
}

function fallbackMessageTextForAi(msg) {
  const type = msg?.type || 'text';
  const role = msg?.role === 'user' ? 'user' : 'assistant';
  if (type === 'emoji') return role === 'user' ? '[表情包]' : '[发送表情包]';
  if (type === 'image') return role === 'user' ? '[用户发来一张图片]' : '[你发给对方的一张图片]';
  if (type === 'video') return role === 'user' ? '[用户发来一段视频]' : '[视频]';
  if (type === 'voice') {
    if (isRobotMicMessage(msg)) return '[你通过桌上小机听到的一段声音]';
    if (msg?._callChannel) {
      const said = String(msg?.content || '').trim();
      return role === 'user' ? `[通话] 对方说：${said}` : `[通话] 你说：${said}`;
    }
    if (role === 'user') {
      const v = parseUserVoicePayload(msg?.content);
      const t = String(v?.transcript || '').trim();
      return t ? `[用户语音] ${t}` : '[用户发来一段语音]';
    }
    return `[语音] ${String(msg?.content || '').trim()}`.trim() || '[语音]';
  }
  if (type === 'location') return `[位置]${String(msg?.location || msg?.content || '').replace(/^\[(?:发送)?位置[:：\]】]?\s*/i, '').replace(/\s*[\[【]\/\s*(?:发送)?位置[\]】]\s*$/i, '').trim()}[/位置]`;
  if (type === 'link') {
    const raw = String(msg?.content || '').trim();
    if (!raw) return '[链接]';
    // 检查是否包含小红书链接
    const hasXhsLink = /xhslink\.com|xiaohongshu\.com/i.test(raw);
    const linkLabel = hasXhsLink ? '小红书链接' : '链接';
    if (role === 'user') return `[用户分享的${linkLabel}]\n${raw}\n[/用户分享的${linkLabel}]`;
    return `[${linkLabel}]${raw}[/${linkLabel}]`;
  }
  if (type === 'web_card') {
    try {
      const j = JSON.parse(String(msg?.content || '').trim() || '{}');
      const title = String(j?.title || '').trim() || '网页卡';
      return `[网页卡]${title}[/网页卡]`;
    } catch {
      return '[网页卡]';
    }
  }
  return role === 'user' ? '[用户消息]' : '[消息]';
}

function buildMessageContent(msg, baseUrl, options = {}) {
  const role = msg.role === 'user' ? 'user' : 'assistant';
  const type = msg.type || 'text';
  const content = msg.content || '';
  const timeNote = options.isLast && options.timeNote ? options.timeNote : '';
  const resolveImage = options.resolveImageUrl || ((u) => toAbsoluteMediaUrl(u, baseUrl));
  const resolveAudio = options.resolveAudioPart || null;
  const formatForAi = options.formatForAi || getFormatMessageForAi();

  // 小机画面：只有最近一帧附真图，早先的退化成文字占位，省 token
  if (isRobotFrameMessage(msg)) {
    if (options.robotFrameTextOnly) {
      return { role, content: '[你通过桌上小机的镜头看到的一帧画面]' };
    }
    const label = '[这是你自己通过桌上小机的镜头看到的画面，不是用户发给你的图。'
      + '按你看见的内容自然回应；看不清就说看不清，不要编图里没有的东西]';
    const src = localUploadToDataUrl(content) || resolveImage(content, baseUrl);
    return {
      role,
      content: [
        { type: 'text', text: label },
        { type: 'image_url', image_url: { url: src } },
      ],
    };
  }

  if (isImageMessageType(type) && content) {
    if (options.imageTextOnly) {
      const label = role === 'user'
        ? (timeNote ? `${timeNote} [用户发来一张图片]` : '[用户发来一张图片]')
        : assistantOwnImageLabel(msg, { attachImage: false });
      return { role, content: label };
    }
    const label = role === 'user'
      ? (timeNote ? `${timeNote} [用户发来一张图片，请观看并回应]` : '[用户发来一张图片，请观看并回应]')
      : assistantOwnImageLabel(msg, { attachImage: true });
    return {
      role,
      content: [
        { type: 'text', text: label },
        { type: 'image_url', image_url: { url: resolveImage(content, baseUrl) } },
      ],
    };
  }

  // 小机麦克风：角色自己的听觉。附件仍放 user（多数 API 会忽略 system 里的音频），文案写明不是用户发语音。
  if (type === 'voice' && role === 'user' && isRobotMicMessage(msg)) {
    const voice = parseUserVoicePayload(content);
    if (voice?.url) {
      let label = timeNote
        ? `${timeNote} [这是你自己通过桌上小机的麦克风听到的声音，不是用户发给你的语音。按你听见的内容自然回应；听不清就说听不清，不要编没听到的东西]`
        : '[这是你自己通过桌上小机的麦克风听到的声音，不是用户发给你的语音。按你听见的内容自然回应；听不清就说听不清，不要编没听到的东西]';
      try {
        const { voiceprintPromptNote } = require('./voiceprint-helper');
        const vpNote = voiceprintPromptNote(voice.voiceprint, {
          robot: true,
          score: voice.voiceprintScore,
        });
        if (vpNote) label = `${label}\n${vpNote}`;
      } catch {}
      const wantAudio = !options.voiceTextOnly && !options.robotMicTextOnly;
      if (wantAudio && typeof resolveAudio === 'function') {
        const audioPart = resolveAudio(voice.url, baseUrl);
        if (audioPart) {
          return { role, content: [{ type: 'text', text: label }, audioPart] };
        }
        console.warn('[robot-mic] audio part missing for', voice.url);
        return {
          role,
          content: `${label}（系统未能附带音频文件，你实际上听不到内容；请如实说明没听到，不要编造听到了什么）`,
        };
      }
      return { role, content: '[你通过桌上小机听到的一段声音]' };
    }
  }

  // 用户语音：最新一条附带多模态音频；历史语音仅文字占位（省 token）
  // 不附带转写：便于判断模型是否真的听清了录音
  if (type === 'voice' && role === 'user') {
    const voice = parseUserVoicePayload(content);
    if (voice?.url) {
      let label = timeNote
        ? `${timeNote} [用户发来一段语音，请直接听这段录音并按内容回应；注意语气、情绪与停顿]`
        : '[用户发来一段语音，请直接听这段录音并按内容回应；注意语气、情绪与停顿]';
      try {
        const { voiceprintPromptNote } = require('./voiceprint-helper');
        if (options.isLast) {
          const vpNote = voiceprintPromptNote(voice.voiceprint, { score: voice.voiceprintScore });
          if (vpNote) label = `${label}\n${vpNote}`;
        }
      } catch {}
      if (!options.voiceTextOnly && typeof resolveAudio === 'function') {
        const audioPart = resolveAudio(voice.url, baseUrl);
        if (audioPart) {
          return { role, content: [{ type: 'text', text: label }, audioPart] };
        }
        console.warn('[chat-voice] audio part missing for', voice.url);
        return {
          role,
          content: `${label}（系统未能附带音频文件，你实际上听不到内容；请如实说明没听到，不要编造用户说了什么）`,
        };
      }
      return { role, content: '[用户发来一段语音]' };
    }
  }

  const aiText = String(formatForAi(msg) || '').trim();
  const body = aiText || fallbackMessageTextForAi(msg);
  if (timeNote && role === 'user') {
    return { role, content: `${timeNote} ${body}`.trim() };
  }
  return { role, content: body };
}

function buildHistoryApiMessages(history, baseUrl, options = {}) {
  if (!history?.length) return [];
  try { require('./emoji-helper').applyCallChannelMarks(history); } catch {}
  const { timeNoteUserId } = options;
  let fallbackUserIdx = -1;
  if (timeNoteUserId == null) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        fallbackUserIdx = i;
        break;
      }
    }
  }
  let lastUserImageIdx = -1;
  let lastUserVoiceIdx = -1;
  const lastAssistantImageIdxs = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      if (lastUserImageIdx < 0 && isImageMessageType(history[i].type) && history[i].content) {
        lastUserImageIdx = i;
      }
      if (lastUserVoiceIdx < 0 && history[i].type === 'voice' && parseUserVoicePayload(history[i].content)) {
        lastUserVoiceIdx = i;
      }
    } else if (
      lastAssistantImageIdxs.length < 2
      && history[i].type === 'image'
      && history[i].content
      && !isPlaceholderMediaContent(history[i].content)
      && !isRobotFrameMessage(history[i])
    ) {
      lastAssistantImageIdxs.push(i);
    }
  }
  // 小机画面是角色自己拍的（role=assistant），上面那轮扫不到；单独找最近一帧附图
  let lastRobotFrameIdx = -1;
  let lastRobotMicIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (lastRobotFrameIdx < 0 && isRobotFrameMessage(history[i])) {
      lastRobotFrameIdx = i;
    }
    if (lastRobotMicIdx < 0 && isRobotMicMessage(history[i])) {
      lastRobotMicIdx = i;
    }
    if (lastRobotFrameIdx >= 0 && lastRobotMicIdx >= 0) break;
  }
  return history.map((msg, idx) => {
    const isTimeNoteTarget = timeNoteUserId != null
      ? String(msg.id) === String(timeNoteUserId)
      : idx === fallbackUserIdx;
    const isImage = isImageMessageType(msg.type) && msg.content;
    const imageTextOnly = isImage && idx !== lastUserImageIdx && !lastAssistantImageIdxs.includes(idx);
    const isUserVoice = msg.role === 'user' && msg.type === 'voice' && parseUserVoicePayload(msg.content);
    const voiceTextOnly = isUserVoice && idx !== lastUserVoiceIdx;
    return buildMessageContent(msg, baseUrl, {
      ...options,
      isLast: isTimeNoteTarget,
      imageTextOnly,
      voiceTextOnly,
      robotFrameTextOnly: isRobotFrameMessage(msg)
        && (options.noRobotFrameImage || idx !== lastRobotFrameIdx),
      robotMicTextOnly: isRobotMicMessage(msg)
        && (options.noRobotMicAudio || idx !== lastRobotMicIdx),
    });
  });
}

function detectAvatarChangeIntent(history) {
  const recentUser = (history || []).filter(m => m.role === 'user').slice(-8);
  const texts = recentUser
    .filter(m => m.type !== 'image' && m.type !== 'video' && m.type !== 'emoji')
    .map(m => m.content || '');
  const hasIntent = texts.some(t => AVATAR_CHANGE_PATTERNS.some(p => p.test(String(t))));
  if (!hasIntent) return null;
  // 只用图片，不用视频当头像
  const imgMsg = [...recentUser].reverse().find((m) => {
    if (m.type !== 'image' || !m.content) return false;
    const url = String(m.content || '').trim();
    if (!url || isPlaceholderMediaContent(url)) return false;
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return false;
    return true;
  });
  return imgMsg?.content || null;
}

/** 识别各类 API 的额度/余额不足（聊天、记忆、日记、TTS、生图等共用） */
const API_BILLING_RE = /quota|余额|insufficient(?:[_\s-]?funds)?|token remain|pre_consume|额度不足|余额不足|billing(?:[_\s-]?hard[_\s-]?limit)?|payment[_\s-]?required|\b402\b|out of credit|no credit|not enough (?:credit|balance|quota)|exceeded.*(?:quota|credit|limit)|account.*(?:balance|欠费)|欠费|余额不够|balance is not enough|credit(?:s)? (?:exhausted|depleted|used up)|arrearage|余额已用完|no balance/i;

function isApiBillingError(errMsg) {
  const msg = String(errMsg || '');
  if (!msg) return false;
  if (API_BILLING_RE.test(msg)) return true;
  const apiErr = msg.match(/API error (\d+):\s*(.+)/i);
  if (apiErr && API_BILLING_RE.test(apiErr[2])) return true;
  if (apiErr && ['402', '403'].includes(apiErr[1]) && /quota|余额|token|credit|billing|limit|额度/i.test(apiErr[2])) {
    return true;
  }
  return false;
}

/** 将 API 403 / quota 等错误转为用户可读提示（聊天、记忆、日记、TTS、生图等共用） */
function formatApiBillingError(errMsg, opts = {}) {
  const msg = String(errMsg || '');
  const label = String(opts.label || '').trim() || 'API';
  if (isApiBillingError(msg)) {
    return `${label}额度不足，请充值或更换对应 Key`;
  }
  if (/401|invalid.*key|authentication|unauthorized/i.test(msg)) {
    return `${label} Key 无效或未授权，请检查设置中的 Key`;
  }
  const apiErr = msg.match(/API(?:\s*error)?\s*(\d+)\s*[:：]\s*(.+)/i);
  if (apiErr) {
    const body = apiErr[2].slice(0, 180);
    if (isApiBillingError(body) || isApiBillingError(`API error ${apiErr[1]}: ${body}`)) {
      return `${label}额度不足，请充值或更换对应 Key`;
    }
    return `API 错误 ${apiErr[1]}：${body}`;
  }
  return msg.slice(0, 220);
}

function formatChatApiNetworkError(err, settings) {
  const msg = String(err?.message || err || '');
  const endpoint = (settings?.chat_api_url || '').trim() || '聊天 API';
  if (/ETIMEDOUT|timeout/i.test(msg)) {
    return `聊天 API 请求超时（${endpoint}），与语音/TTS 无关。请检查网络、VPN 或更换中转地址`;
  }
  if (/ECONNRESET|socket hang up|Premature close/i.test(msg)) {
    return `聊天 API 连接被中断（${endpoint}），请关闭 VPN/代理后重试`;
  }
  return msg.slice(0, 400);
}

function resolveTaskApiCreds(settings, type = 'chat') {
  const map = {
    diary: ['diary_api_url', 'diary_api_key', 'diary_model'],
    memory: ['memory_api_url', 'memory_api_key', 'memory_model'],
    dream: ['dream_api_url', 'dream_api_key', 'dream_model'],
    series: ['series_api_url', 'series_api_key', 'series_model'],
    series_outline: ['series_api_url', 'series_api_key', 'series_outline_model'],
    series_play: ['series_api_url', 'series_api_key', 'series_play_model'],
    series_embed: ['series_embed_api_url', 'series_embed_api_key', 'series_embed_model'],
    embed: ['embed_api_url', 'embed_api_key', 'embed_model'],
    chat: ['chat_api_url', 'chat_api_key', 'chat_model'],
  };
  const [urlKey, keyKey, modelKey] = map[type] || map.chat;
  // 剧集/穿越强制独立配置，绝不回退聊天 API（部分模型写肉文会空回复）
  if (type === 'series' || type === 'series_outline' || type === 'series_play') {
    const url = String(settings.series_api_url || '').trim();
    const apiKey = String(settings.series_api_key || '').trim();
    // 大纲槽：按量模型优先；游玩槽：按次/高质量优先；都回退到 series_model
    let model = '';
    if (type === 'series_outline') {
      model = String(settings.series_outline_model || settings.series_model || '').trim();
    } else if (type === 'series_play') {
      model = String(settings.series_play_model || settings.series_model || '').trim();
    } else {
      model = String(settings.series_model || settings.series_play_model || settings.series_outline_model || '').trim();
    }
    return { url, apiKey, model };
  }
  if (type === 'series_embed' || type === 'embed') {
    // 全项目向量：优先 embed_*，兼容旧 series_embed_*；再回退聊天（不再绑死时空）
    const url = String(
      settings.embed_api_url || settings.series_embed_api_url || settings.chat_api_url || '',
    ).trim();
    const apiKey = String(
      settings.embed_api_key || settings.series_embed_api_key || settings.chat_api_key || '',
    ).trim();
    const model = String(
      settings.embed_model
        || settings.series_embed_model
        || '',
    ).trim();
    return { url, apiKey, model };
  }
  return {
    url: (settings[urlKey] || settings.chat_api_url || '').trim(),
    apiKey: (settings[keyKey] || settings.chat_api_key || '').trim(),
    model: ((settings[modelKey] || '').trim() || (settings.chat_model || 'gpt-4o').trim()),
  };
}

async function callChatAPI(settings, systemPrompt, userContent, type = 'chat', historyMessages = []) {
  const { url, apiKey, model } = resolveTaskApiCreds(settings, type);

  if (!url || !apiKey) return null;
  if ((type === 'series' || type === 'series_outline' || type === 'series_play') && !model) return null;

  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;

  const messages = [{ role: 'system', content: systemPrompt }];
  for (const h of historyMessages) {
    messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content });
  }
  if (userContent) messages.push({ role: 'user', content: userContent });

  async function tryFetch(apiUrl) {
    const resp = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: parseFloat(settings.chat_temperature || '0.8'),
        max_tokens: parseInt(settings.chat_max_tokens || '1000'),
        stream: false,
      }),
      timeout: 90000,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`API error ${resp.status}: ${err.slice(0, 200)}`);
    }
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error('API returned non-JSON (check if Base URL needs /v1)');
    }
    return resp.json();
  }

  let data;
  try {
    data = await tryFetch(baseUrl);
  } catch (e1) {
    if (!baseUrl.endsWith('/v1')) {
      try {
        data = await tryFetch(baseUrl + '/v1');
      } catch (e2) {
        throw new Error(formatChatApiNetworkError(e2, settings));
      }
    } else {
      throw new Error(formatChatApiNetworkError(e1, settings));
    }
  }

  return data.choices?.[0]?.message?.content?.trim() || null;
}

/** 与聊天发送相同：API 截断时自动续写，避免话说到一半 */
async function callChatAPIComplete(settings, systemPrompt, userContent, type = 'chat', historyMessages = [], extra = {}) {
  const { url, apiKey, model } = resolveTaskApiCreds(settings, type);
  if (!url || !apiKey) return null;
  if ((type === 'series' || type === 'series_outline' || type === 'series_play') && !model) return null;

  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const h of historyMessages) {
    messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content });
  }
  if (userContent) messages.push({ role: 'user', content: userContent });

  const tools = Array.isArray(extra?.tools) && extra.tools.length ? extra.tools : null;
  if (tools) {
    const turn = await completeChatTurn({
      settings,
      type,
      messages,
      maxTokens: parseInt(settings.chat_max_tokens || '1000', 10) || 1000,
      tools,
      timeout: extra.timeout || 90000,
      characterId: extra.characterId,
    });
    return String(turn.content || '').trim() || null;
  }

  const maxTokens = extra.maxTokens != null
    ? parseInt(extra.maxTokens, 10)
    : parseInt(settings.chat_max_tokens || '1000');
  const temperature = extra.temperature != null
    ? Number(extra.temperature)
    : parseFloat(settings.chat_temperature || '0.8');
  const fetchTimeout = Number(extra.timeout) > 0 ? Number(extra.timeout) : 60000;
  const wantJson = !!extra.json;
  const payload = {
    model,
    messages,
    temperature: Number.isFinite(temperature) ? temperature : 0.8,
    max_tokens: maxTokens || 1000,
    stream: false,
  };
  // 结构化任务：让接口直接出 JSON，比事后「容错解析」靠谱
  if (wantJson) payload.response_format = { type: 'json_object' };
  const chatHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  function looksLikeJsonFormatRejected(err) {
    const m = String(err?.message || err || '');
    return /response_format|json_object|json mode|structured|not support|unsupported|unknown parameter|extra inputs|unrecognized/i.test(m);
  }

  async function tryFetch(apiUrl, bodyObj) {
    const resp = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify(bodyObj),
      timeout: fetchTimeout,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`API error ${resp.status}: ${err.slice(0, 200)}`);
    }
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error('API returned non-JSON (check if Base URL needs /v1)');
    }
    return resp.json();
  }

  async function fetchOnce(bodyObj) {
    try {
      return await tryFetch(baseUrl, bodyObj);
    } catch (e1) {
      if (!baseUrl.endsWith('/v1')) {
        return tryFetch(baseUrl + '/v1', bodyObj);
      }
      throw e1;
    }
  }

  let data;
  try {
    data = await fetchOnce(payload);
  } catch (e1) {
    // 部分中转不认 response_format：去掉后再打一次，仍靠 prompt 要 JSON
    if (wantJson && payload.response_format && looksLikeJsonFormatRejected(e1)) {
      delete payload.response_format;
      data = await fetchOnce(payload);
    } else {
      throw e1;
    }
  }

  let aiContent = '';
  const msg = data.choices?.[0]?.message;
  if (typeof msg?.content === 'string') aiContent = msg.content.trim();
  else if (Array.isArray(msg?.content)) {
    aiContent = msg.content
      .map((p) => (typeof p === 'string' ? p : (p?.text || p?.content || '')))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  // 部分 thinking / 中转把正文放在 reasoning 字段，content 为空或只剩围栏残片
  if (!aiContent || /^(```(?:json)?\s*)?$/i.test(aiContent)) {
    const alt = msg?.reasoning_content || msg?.reasoning || data.choices?.[0]?.reasoning_content || '';
    if (typeof alt === 'string' && alt.trim()) aiContent = alt.trim();
  }
  if (!aiContent) return null;

  // JSON 任务被 max_tokens 截断：整次加量重发，不用聊天那套「接着说完」（会破坏 JSON）
  const finishReason = data.choices?.[0]?.finish_reason;
  if (wantJson && finishReason === 'length' && !extra._jsonTokenRetry) {
    const bumped = Math.min(Math.max((maxTokens || 1000) * 2, 2400), 4096);
    console.warn(`[api] json 输出被截断，加量重试 max_tokens ${maxTokens || 1000}→${bumped}`);
    return callChatAPIComplete(settings, systemPrompt, userContent, type, historyMessages, {
      ...extra,
      maxTokens: bumped,
      _jsonTokenRetry: true,
    });
  }
  if (wantJson && finishReason === 'length') {
    console.warn('[api] json 输出仍被截断', String(aiContent).slice(0, 160));
  }

  const sentenceEnds = /[。！？…!?」』"'～~）)】\n]$/;
  const looksCutMid = !sentenceEnds.test(aiContent) && (
    /[，、；,;：:]$/.test(aiContent)
    || (aiContent.length >= 24 && /[的了着过地得和与及在是把被从向对跟比让给到为以而却又也还但并或]$/.test(aiContent))
  );
  const needsContinue = !extra.noContinue && !wantJson && (
    finishReason === 'length'
    || looksCutMid
    || (finishReason !== 'stop' && !sentenceEnds.test(aiContent) && aiContent.length > 60)
  );

  if (needsContinue) {
    try {
      const continueMessages = [
        ...messages.slice(0, 1).map(m => {
          const hint = '你上一条被截断了，从断句处接着说完，不要重复已写内容。';
          if (Array.isArray(m.content)) {
            return { ...m, content: [...m.content, { type: 'text', text: hint }] };
          }
          return { ...m, content: `${m.content}\n${hint}` };
        }),
        ...messages.slice(1),
        { role: 'assistant', content: aiContent },
        { role: 'user', content: '…' },
      ];
      const continueBody = JSON.stringify({
        model,
        messages: continueMessages,
        temperature: parseFloat(settings.chat_temperature || '0.8'),
        max_tokens: 600,
        stream: false,
      });
      let contData;
      try {
        const r = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: chatHeaders,
          body: continueBody,
          timeout: 60000,
        });
        if (r.ok) contData = await r.json();
      } catch {}
      if (!contData && !baseUrl.endsWith('/v1')) {
        try {
          const r2 = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: chatHeaders,
            body: continueBody,
            timeout: 60000,
          });
          if (r2.ok) contData = await r2.json();
        } catch {}
      }
      const cont = contData?.choices?.[0]?.message?.content?.trim();
      if (cont) {
        let piece = cont;
        try {
          piece = require('./emoji-helper').dedupeContinuationPiece(aiContent, cont) || '';
        } catch { /* keep cont */ }
        if (piece) aiContent = aiContent + piece;
      }
    } catch {}
  }

  return aiContent.trim() || null;
}

function looksLikeToolsRejected(err) {
  const m = String(err?.message || err || '');
  if (!/tool/i.test(m) && !/function.?call/i.test(m)) return false;
  return /400|404|422|invalid|unknown|not support|unrecognized|unexpected|extra inputs/i.test(m);
}

function isInlineAudioPart(part) {
  if (!part || typeof part !== 'object') return false;
  if (part.type === 'input_audio' || part.input_audio) return true;
  const url = String(part.image_url?.url || part.url || '');
  return /^data:audio\//i.test(url);
}

function messagesHaveInlineAudio(messages) {
  return (messages || []).some((m) => Array.isArray(m?.content) && m.content.some(isInlineAudioPart));
}

function looksLikeInlineAudioRejected(err) {
  const m = String(err?.message || err || '');
  if (!m) return false;
  if (/invalid.*image|unsupported.*image|could not process.*image|invalid.*audio|unsupported.*audio|unknown.*mime|media.?type|inline.?data|cannot.*decode|not a valid image|invalid_image|image_url/i.test(m)) {
    return true;
  }
  if (/(?:payload|entity|request).{0,12}too.{0,8}large|\b413\b/i.test(m)) return true;
  return /API(?:\s*error)?\s*(400|413)\b/i.test(m) && /audio|image|mime|base64|media/i.test(m);
}

/** 去掉多模态音频附件，改成文字占位。有改动才返回 true。 */
function stripInlineAudioFromMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  let changed = false;
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    const next = [];
    for (const p of m.content) {
      if (isInlineAudioPart(p)) {
        changed = true;
        continue;
      }
      if (p?.type === 'text' && /请直接听这段录音/.test(String(p.text || ''))) {
        next.push({
          ...p,
          text: String(p.text).replace(
            /请直接听这段录音并按内容回应[^。\n]*[。.]?/,
            '用户发来一段语音（音频未能送达模型，请根据上下文自然回应，不要编造具体说了什么）。',
          ),
        });
        changed = true;
        continue;
      }
      next.push(p);
    }
    if (!changed) continue;
    m.content = next.length === 1 && next[0]?.type === 'text' ? next[0].text : next;
  }
  return changed;
}

async function postChatCompletionsOnce(apiUrl, apiKey, body, timeout) {
  const r = await fetchWithTimeout(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    timeout: timeout || 120000,
  });
  const ct = r.headers.get('content-type') || '';
  const txtProbe = !ct.includes('application/json');
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`API ${r.status}：${txt.slice(0, 240)}`);
  }
  if (txtProbe) throw new Error('API返回了非JSON内容，请检查Base URL是否需要加/v1');
  return r.json();
}

async function postChatCompletions(baseUrl, apiKey, body, timeout, retries = 2) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const maxAttempts = Math.max(1, Number(retries) + 1) || 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      try {
        return await postChatCompletionsOnce(root, apiKey, body, timeout);
      } catch (e1) {
        if (!root.endsWith('/v1')) {
          try {
            return await postChatCompletionsOnce(`${root}/v1`, apiKey, body, timeout);
          } catch (e2) {
            throw e1;
          }
        }
        throw e1;
      }
    } catch (e) {
      lastErr = e;
      if (!isRetryableChatUpstreamError(e) || attempt >= maxAttempts - 1) throw e;
      const waitMs = 800 * (attempt + 1);
      console.warn(`[chat] 上游瞬时失败，${waitMs}ms 后重试 ${attempt + 1}/${maxAttempts - 1}:`, String(e?.message || e).slice(0, 160));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/**
 * 一轮 chat/completions，可选带 tools。
 * 中转若不认 tools 会去掉再试。模型只出 tool_calls 时补一轮让它开口。
 * content 会附上内部旧标记，方便现有小机执行链。
 */
async function completeChatTurn(opts = {}) {
  const robotTools = require('./robot-llm-tools');
  let url = opts.url;
  let apiKey = opts.apiKey;
  let model = opts.model;
  if (!url || !apiKey) {
    const creds = resolveTaskApiCreds(opts.settings || {}, opts.type || 'chat');
    url = url || creds.url;
    apiKey = apiKey || creds.apiKey;
    model = model || creds.model;
  }
  if (!url || !apiKey) throw new Error('未配置 API');
  const baseUrl = String(url).replace(/\/+$/, '');
  const temperature = opts.temperature != null
    ? Number(opts.temperature)
    : parseFloat((opts.settings && opts.settings.chat_temperature) || '0.8');
  const maxTokens = parseInt(opts.maxTokens || opts.max_tokens || '1000', 10) || 1000;
  const timeout = opts.timeout || 120000;
  const messages = Array.isArray(opts.messages) ? opts.messages.slice() : [];
  let tools = Array.isArray(opts.tools) && opts.tools.length ? opts.tools : null;

  const makeBody = (msgs, withTools, choice) => {
    const body = {
      model,
      messages: msgs,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (withTools && tools) {
      body.tools = tools;
      body.tool_choice = choice || 'auto';
    }
    return body;
  };

  let toolsAccepted = !!tools;
  let data;
  const phoneTools = (() => {
    try { return require('./phone-llm-tools'); } catch { return null; }
  })();
  const toyHelper = (() => {
    try { return require('./toy-helper'); } catch { return null; }
  })();
  const firstChoice = (() => {
    if (!toolsAccepted) return 'auto';
    const toyChoice = toyHelper && toyHelper.forcedToolChoice(messages, tools);
    if (toyChoice) return toyChoice;
    if (phoneTools) return phoneTools.forcedToolChoice(messages, tools) || 'auto';
    return 'auto';
  })();
  async function postOrRetryWithoutAudio(withTools, choice) {
    try {
      return await postChatCompletions(baseUrl, apiKey, makeBody(messages, withTools, choice), timeout);
    } catch (err) {
      if (looksLikeInlineAudioRejected(err) && messagesHaveInlineAudio(messages) && stripInlineAudioFromMessages(messages)) {
        console.warn('[chat-voice] 音频附件被拒，去掉后再请求：', err.message);
        return await postChatCompletions(baseUrl, apiKey, makeBody(messages, withTools, choice), timeout);
      }
      throw err;
    }
  }

  try {
    data = await postOrRetryWithoutAudio(toolsAccepted, firstChoice);
  } catch (e) {
    if (toolsAccepted && looksLikeToolsRejected(e)) {
      console.warn('[chat-tools] 中转不支持 tools，去掉后再请求：', e.message);
      toolsAccepted = false;
      data = await postOrRetryWithoutAudio(false);
    } else {
      throw e;
    }
  }

  let message = data?.choices?.[0]?.message || {};
  let calls = toolsAccepted ? robotTools.parseToolCalls(message) : [];
  let content = String(message.content || '').trim();
  const mcpHelper = (() => {
    try { return require('./mcp-client-helper'); } catch { return null; }
  })();
  const hasPhoneControlTool = !!(tools && tools.some((t) => t?.function?.name === 'phone_control'));
  const userTextFromMessages = (() => {
    try {
      const list = Array.isArray(messages) ? messages : [];
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content.map((p) => (p && (p.text || p.content)) || '').join(' ');
        }
      }
    } catch {}
    return '';
  })();
  const callKey = (c) => `${c.name}:${JSON.stringify(c.args || {})}`;
  const asApiToolCalls = (msg, theCalls) => {
    const orig = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const want = new Set(theCalls.map((c) => String(c.id)));
    const filtered = orig.filter((t) => want.has(String(t.id || '')));
    if (filtered.length === theCalls.length) return filtered;
    return theCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
    }));
  };
  const classifyCalls = (theCalls) => {
    const phoneKept = phoneTools ? phoneTools.dropOffTopicRobotCalls(theCalls, messages) : theCalls;
    const skippedRobot = theCalls.filter((c) => {
      if (phoneKept.some((k) => k.id === c.id)) return false;
      if (mcpHelper?.isMcpToolName?.(c.name)) return false;
      if (phoneTools?.isPhoneTool?.(c.name)) return false;
      if (toyHelper?.isToyTool?.(c.name)) return false;
      return true;
    });
    const hasMcpCalls = !!(mcpHelper && theCalls.some((c) => mcpHelper.isMcpToolName(c.name)));
    const hasToyCalls = !!(toyHelper && theCalls.some((c) => toyHelper.isToyTool(c.name)));
    const hasPhoneCalls = !!(phoneTools && phoneKept.some((c) => phoneTools.isPhoneTool(c.name)));
    return {
      skippedRobot,
      needsLiveResult: hasPhoneCalls || hasMcpCalls || hasToyCalls,
    };
  };
  const defaultVisionHint = hasPhoneControlTool
    ? '（这是刚才看到的画面。按性格决定提不提、提多少，也可以当没看见。想点进去看，用 phone_control 点这一屏上的字或图标；先看再点；支付、密码不要点；不要每轮都翻。不要提工具名。）'
    : '（这是刚才看到的画面。按性格决定提不提、提多少，不必把上面每样都念一遍，也可以当没看见。不要提工具名。）';

  async function executeCalls(theCalls, skippedRobot) {
    const visionParts = [];
    const toolMsgs = [];
    let visionHint = '';
    const deferredIds = new Set();
    const hasScreenThisBatch = theCalls.some((c) => c.name === 'phone_screen');
    for (const c of theCalls) {
      let payload;
      if (c.name === 'music_control') {
        // 音乐控制工具：通过 Shizuku 发送媒体命令
        try {
          const result = await handleMusicControl(c.args?.action);
          payload = JSON.stringify(result);
        } catch (e) {
          payload = JSON.stringify({ ok: false, error: e.message || 'music_control_failed' });
        }
      } else if (skippedRobot.some((s) => s.id === c.id)) {
        payload = JSON.stringify({
          ok: false,
          skipped: true,
          note: '这次问的是手机（电量/心率/通知等），不要开桌上小机，也不要用镜头。请用手机工具的结果回答。',
        });
      } else if (hasScreenThisBatch && c.name === 'phone_control') {
        deferredIds.add(c.id);
        payload = JSON.stringify({
          ok: false,
          skipped: true,
          note: '先看完这一屏再点。这次控屏没执行，看完画面后再调用 phone_control。',
        });
      } else if (phoneTools && phoneTools.isPhoneTool(c.name)) {
        let result = {};
        try {
          result = await phoneTools.execute(c, {
            characterId: opts.characterId,
            messages,
            userText: userTextFromMessages,
          }) || {};
        } catch (e) {
          result = { ok: false, error: e.message || 'tool_failed' };
        }
        const { imageDataUrl, selfieDataUrl, ...rest } = result;
        if (typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:image/')) {
          visionParts.push({ type: 'image_url', image_url: { url: imageDataUrl } });
        }
        if (typeof selfieDataUrl === 'string' && selfieDataUrl.startsWith('data:image/')) {
          visionParts.push({ type: 'image_url', image_url: { url: selfieDataUrl } });
        }
        if (rest.source === 'rear_cam') {
          visionHint = '（这是后置摄像头拍到的，不是手机屏幕。按性格决定提不提，不必把每样都说一遍，也可以当没看见。不要提工具名。）';
        } else if (selfieDataUrl) {
          visionHint = '（第一张是手机屏幕，第二张是视频通话前置镜头。按性格决定聊不聊、聊多少，不必把屏幕上每样都念一遍，也可以当没看见。不要提工具名。）';
        } else if (imageDataUrl) {
          visionHint = defaultVisionHint;
        }
        payload = JSON.stringify(rest);
      } else if (toyHelper && toyHelper.isToyTool(c.name)) {
        let result = {};
        try {
          result = await toyHelper.execute(c, {
            characterId: opts.characterId,
            settings: opts.settings || {},
            messages,
          }) || {};
        } catch (e) {
          result = { ok: false, error: e.message || 'toy_failed' };
        }
        payload = JSON.stringify(result);
      } else if (mcpHelper && mcpHelper.isMcpToolName(c.name)) {
        try {
          const raw = await mcpHelper.executeToolCall(c, () => opts.settings || {});
          payload = typeof raw === 'string' ? raw : JSON.stringify(raw || { ok: true });
        } catch (e) {
          payload = JSON.stringify({ ok: false, error: e.message || 'mcp_failed' });
        }
      } else {
        payload = robotTools.toolFollowUpPayload([c]);
      }
      toolMsgs.push({
        role: 'tool',
        tool_call_id: c.id,
        content: payload,
      });
    }
    return { visionParts, toolMsgs, visionHint, deferredIds };
  }

  const MAX_TOOL_ROUNDS = 3;
  let convoMsgs = messages;
  let pending = calls;
  const seenKeys = new Set();
  const allCalls = [];
  let round = 0;

  while (
    toolsAccepted
    && pending.length
    && opts.allowToolFollowUp !== false
    && round < MAX_TOOL_ROUNDS
  ) {
    const info = classifyCalls(pending);
    if (round === 0) {
      if (!info.needsLiveResult && !info.skippedRobot.length && content) break;
    } else if (!info.needsLiveResult) {
      for (const c of pending) {
        if (!seenKeys.has(callKey(c))) allCalls.push(c);
      }
      break;
    }

    round += 1;
    const { visionParts, toolMsgs, visionHint, deferredIds } = await executeCalls(pending, info.skippedRobot);
    for (const c of pending) {
      if (deferredIds.has(c.id)) continue;
      seenKeys.add(callKey(c));
      allCalls.push(c);
    }
    const followMsgs = convoMsgs.concat([
      {
        role: 'assistant',
        content: message.content || null,
        tool_calls: asApiToolCalls(message, pending),
      },
      ...toolMsgs,
    ]);
    if (visionParts.length) {
      followMsgs.push({
        role: 'user',
        content: [
          { type: 'text', text: visionHint || defaultVisionHint },
          ...visionParts,
        ],
      });
    }
    try {
      const data2 = await postChatCompletions(baseUrl, apiKey, makeBody(followMsgs, true, 'auto'), timeout);
      const msg2 = data2?.choices?.[0]?.message || {};
      const nextPending = [];
      for (const c of robotTools.parseToolCalls(msg2)) {
        if (seenKeys.has(callKey(c))) continue;
        nextPending.push(c);
      }
      content = String(msg2.content || '').trim() || content;
      message = msg2;
      data = data2;
      convoMsgs = followMsgs;
      pending = nextPending;
    } catch (e) {
      console.warn('[chat-tools] tool follow-up', e.message);
      break;
    }
  }
  if (allCalls.length) calls = allCalls;

  if (phoneTools) calls = phoneTools.dropOffTopicRobotCalls(calls, messages);
  const merged = robotTools.mergeContentWithToolTags(content, calls);
  let finishReason = String(data?.choices?.[0]?.finish_reason || '');
  if (finishReason === 'tool_calls' || finishReason === 'function_call') finishReason = 'stop';
  return {
    content: merged,
    spoken: content,
    toolCalls: calls,
    toolsAccepted,
    finishReason,
    message,
    data,
  };
}

function normalizeMinimaxApiKey(raw) {
  return String(raw || '').trim().replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '');
}

const MIN_TTS_AUDIO_BYTES = 800;

function isMp3Buffer(buf) {
  if (!buf?.length) return false;
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

async function readMinimaxTtsBody(resp) {
  const ct = resp.headers.get('content-type') || '';
  const ab = await resp.arrayBuffer();
  const buffer = Buffer.from(ab);
  if (buffer.length >= MIN_TTS_AUDIO_BYTES && (ct.includes('audio') || isMp3Buffer(buffer))) {
    return { kind: 'audio', buffer };
  }
  return { kind: 'text', text: buffer.toString('utf8') };
}

function buildMinimaxTtsTargets(settings) {
  const groupId = String(settings.minimax_group_id || '').trim();
  let custom = String(settings.minimax_api_url || '').trim().replace(/\/+$/, '');
  if (custom) {
    custom = custom.replace(/\/v1\/t2a_v2$/i, '').replace(/\/v1$/i, '');
    return [{ base: custom, groupId }];
  }
  const seen = new Set();
  const out = [];
  const add = (base, gid) => {
    const b = String(base || '').replace(/\/+$/, '');
    if (!b || seen.has(b)) return;
    seen.add(b);
    out.push({ base: b, groupId: gid });
  };
  if (groupId) {
    add('https://api.minimaxi.com', groupId);
    add('https://api.minimax.chat', groupId);
    add('https://api.minimaxi.chat', groupId);
  } else {
    add('https://api.minimax.io', '');
    add('https://api-uw.minimax.io', '');
    add('https://api.minimaxi.chat', '');
  }
  return out;
}

function isRetryableNetworkError(err) {
  const msg = String(err?.message || err || '');
  return /premature close|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|read ECONNRESET/i.test(msg);
}

/** 聊天中转瞬时故障：500/超时/upstream failed，适合短退避重试（404/401 不重试） */
function isRetryableChatUpstreamError(err) {
  const msg = String(err?.message || err || '');
  if (!msg) return false;
  if (/API\s*40[14]|invalid.*key|authentication|unauthorized|额度不足|余额不足/i.test(msg)) return false;
  if (isRetryableNetworkError(err)) return true;
  if (/上游 API 超时|ETIMEDOUT|timeout|aborted/i.test(msg)) return true;
  if (/API\s*(500|502|503|504)/i.test(msg)) return true;
  if (/do_request_failed|upstream error|bad gateway|gateway timeout|service unavailable/i.test(msg)) return true;
  return false;
}

function isRetryableTtsNetworkError(err) {
  return isRetryableNetworkError(err);
}

function format80AiNetworkError(err) {
  const msg = String(err?.message || err || '');
  if (/ECONNRESET|read ECONNRESET|socket hang up|Premature close/i.test(msg)) {
    return '连接 80ai 时被服务器中断（ECONNRESET），常见原因：网络不稳定、VPN/代理干扰、或 80ai 生图耗时过长。请关闭代理/VPN 后重试，或换 gptimage2_low 模型再测。';
  }
  if (/ETIMEDOUT|timeout/i.test(msg)) {
    return '连接 80ai 超时，请检查网络或稍后重试。';
  }
  if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg)) {
    return '无法连接 80ai 服务器，请确认 Base URL 为 https://api.80ai.net 且网络正常。';
  }
  return msg.slice(0, 400);
}

async function fetch80AiRequest(url, options = {}, retries = 3) {
  let lastErr;
  const { timeoutMs = 180000, ...fetchOpts } = options;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        ...fetchOpts,
        timeout: timeoutMs,
        ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      const raw = await resp.text().catch(() => '');
      return { resp, raw };
    } catch (e) {
      lastErr = e;
      if (!isRetryableNetworkError(e) || attempt >= retries) throw e;
      console.warn('[80ai] 网络错误，重试', attempt + 1, '/', retries, e.message);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function fetchMinimaxTts(endpoint, headers, body, retries = 4) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        compress: false,
        timeout: 120000,
        ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(120000) } : {}),
      });
    } catch (e) {
      lastErr = e;
      if (!isRetryableTtsNetworkError(e) || attempt >= retries) break;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  // node-fetch 对部分国内节点易 Premature close，改用原生 https 再试
  try {
    return await postMinimaxTtsViaHttps(endpoint, headers, body);
  } catch (e) {
    throw lastErr || e;
  }
}

function postMinimaxTtsViaHttps(endpoint, headers, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(endpoint); } catch (e) { reject(e); return; }
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body),
        Connection: 'close',
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (k) => res.headers[String(k).toLowerCase()] },
          arrayBuffer: async () => buffer,
          text: async () => buffer.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ETIMEDOUT')); });
    req.write(body);
    req.end();
  });
}

function formatMinimaxTtsFinalError(lastErr, groupId) {
  const msg = String(lastErr || '');
  if (isApiBillingError(msg)) {
    return formatApiBillingError(msg, { label: '语音 TTS' });
  }
  if (/premature close|ECONNRESET|socket hang up|ETIMEDOUT|Invalid response body/i.test(msg)) {
    return `MiniMax 连接被中断（网络波动，不一定是 Key 填错）。建议：① 关闭 VPN/代理后重试；② 设置里 Base URL 试填 https://api.minimaxi.com；③ 语音模型改用 speech-02-turbo；④ 过几分钟再试。原始错误：${msg.slice(0, 120)}`;
  }
  if (/invalid api key|auth|unauthorized|401/i.test(msg)) {
    return `MiniMax API Key 无效或未授权。${groupId ? '请确认 Key 与 Group ID 同属一个账户。' : ''} ${msg.slice(0, 120)}`;
  }
  const hint = groupId
    ? '请确认 API Key、Group ID 同属一个 MiniMax 账户；国内 Base URL 可填 https://api.minimax.chat 或 https://api.minimaxi.com'
    : '国内 MiniMax 账号还需填写 Group ID（账户中心 19 位数字）；国际账号 Key 勿填 Group ID';
  return `${msg || 'MiniMax TTS 请求失败'}。${hint}`;
}

function buildMinimaxTtsUrl(base, groupId) {
  const root = String(base || '').replace(/\/+$/, '');
  let url = `${root}/v1/t2a_v2`;
  if (groupId) url += `?GroupId=${encodeURIComponent(groupId)}`;
  return url;
}

/** MiniMax voice_setting.emotion 合法值 */
const TTS_EMOTION_SET = new Set([
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper',
]);

const TTS_EMOTION_ALIASES = {
  happy: 'happy', joy: 'happy', 开心: 'happy', 高兴: 'happy', 快乐: 'happy', 笑: 'happy',
  love: 'happy', 爱: 'happy', 喜欢: 'happy', 害羞: 'happy', shy: 'happy',
  sad: 'sad', 难过: 'sad', 伤心: 'sad', 哭: 'sad', 委屈: 'sad',
  angry: 'angry', mad: 'angry', 生气: 'angry', 怒: 'angry', 烦: 'angry',
  fearful: 'fearful', fear: 'fearful', 害怕: 'fearful', 紧张: 'fearful',
  disgusted: 'disgusted', disgust: 'disgusted', 厌恶: 'disgusted', 嫌弃: 'disgusted',
  surprised: 'surprised', 惊讶: 'surprised', 吃惊: 'surprised',
  calm: 'calm', neutral: 'calm', 平静: 'calm', 中性: 'calm', sleepy: 'calm', 困: 'calm',
  fluent: 'fluent', 生动: 'fluent',
  whisper: 'whisper', 低语: 'whisper', 小声: 'whisper',
};

/**
 * 模型自己标的 [语气:xx] → MiniMax 情绪。
 * 比 TTS_EMOTION_ALIASES 宽：这里收的是「说话方式」的说法，不只是情绪名。
 * 「调侃」单列成 fluent 是重点——嘴上骂心里没气的那类台词全靠它兜。
 */
const TTS_TONE_MAP = {
  调侃: 'fluent', 玩笑: 'fluent', 开玩笑: 'fluent', 打趣: 'fluent', 逗: 'fluent', 逗你: 'fluent',
  戏谑: 'fluent', 揶揄: 'fluent', 俏皮: 'fluent', 调皮: 'fluent', 傲娇: 'fluent', 嘴硬: 'fluent',
  撒娇: 'happy', 害羞: 'happy', 亲昵: 'happy', 甜: 'happy', 黏人: 'happy',
  开心: 'happy', 高兴: 'happy', 兴奋: 'happy', 雀跃: 'happy', 得意: 'happy',
  温柔: 'calm', 认真: 'calm', 严肃: 'calm', 平静: 'calm', 淡定: 'calm', 无奈: 'calm',
  疲惫: 'calm', 累: 'calm', 困: 'calm', 敷衍: 'calm', 犹豫: 'calm',
  难过: 'sad', 伤心: 'sad', 委屈: 'sad', 心疼: 'sad', 失落: 'sad', 想念: 'sad', 哽咽: 'sad',
  生气: 'angry', 发火: 'angry', 恼火: 'angry', 不爽: 'angry', 质问: 'angry', 冷: 'angry',
  惊讶: 'surprised', 吃惊: 'surprised', 意外: 'surprised', 震惊: 'surprised',
  害怕: 'fearful', 紧张: 'fearful', 不安: 'fearful', 心虚: 'fearful',
  嫌弃: 'disgusted', 厌恶: 'disgusted',
  低声: 'whisper', 悄悄: 'whisper', 耳语: 'whisper', 气声: 'whisper',
};

/** 解析 [语气:xx]；模型标了就信它，标错也比正则猜错强 */
function normalizeTtsTone(raw, model) {
  const key = String(raw || '').trim();
  if (!key) return '';
  const direct = TTS_TONE_MAP[key];
  if (direct) return normalizeTtsEmotion(direct, model);
  // 「有点无奈」「特别开心」这类带修饰的写法
  for (const word of Object.keys(TTS_TONE_MAP)) {
    if (word.length >= 2 && key.includes(word)) return normalizeTtsEmotion(TTS_TONE_MAP[word], model);
  }
  return normalizeTtsEmotion(key, model);
}

function isSpeech26Model(model) {
  return /^speech-2\.6/i.test(String(model || ''));
}

function isSpeech28Model(model) {
  return /^speech-2\.8/i.test(String(model || ''));
}

/** 规范为 MiniMax 情绪；whisper/fluent 仅 speech-2.6 可用 */
function normalizeTtsEmotion(raw, model) {
  if (raw == null || raw === '') return '';
  const key = String(raw).trim();
  const lower = key.toLowerCase();
  let e = TTS_EMOTION_ALIASES[key] || TTS_EMOTION_ALIASES[lower] || lower;
  if (!TTS_EMOTION_SET.has(e)) return '';
  if ((e === 'whisper' || e === 'fluent') && !isSpeech26Model(model)) {
    return e === 'whisper' ? 'calm' : 'happy';
  }
  return e;
}

/** 嘴上骂的词：真发火和打闹都会说，单看字面分不出来 */
const MOCK_SCOLD_RE = /讨厌|烦死|好烦|你烦|烦不烦|少来|少烦|滚|一边去|哼|有病|神经|笨蛋|傻瓜|呆子|坏死|坏蛋|贫嘴|德行|欠揍|找打|气死|无语|不理你|懒得理|受不了你|拿你没辙/;
/** 配上这些就不是翻脸：语气助词、笑声、昵称 */
const PLAYFUL_SOFTENER_RE = /[～~]|[啦嘛哟咯呀捏喔噢哦呢哇嘿]|哈哈|嘻嘻|嘿嘿|呵呵|噗|咯咯|笑死|抱抱|亲亲|么么|宝贝|亲爱的|老公|老婆|哥哥|姐姐/;
/** 真翻脸才会说的：出现这些就别再往打闹上兜 */
const HARD_ANGER_RE = /闭嘴|凭什么|受够了|真是够了|别烦我|我警告你|不可理喻|滚出去|别再联系|以后别|我们到此为止/;

/** 调皮/撒娇/开玩笑：MiniMax 空 emotion 或看到「烦/讨厌/滚」会读成严肃、生气 */
function isPlayfulSpeech(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (HARD_ANGER_RE.test(t)) return false;
  if (/哈哈+|嘻嘻+|嘿嘿+|呵呵+|噗+|咯咯|开玩笑|逗你|骗你的|说笑|调皮|笑死/.test(t)) return true;
  if (/[～~]/.test(t)) return true;
  const compact = t.replace(/\s+/g, '').replace(/[。！？…!?]+$/g, '');
  // 短句里骂人词配上语气助词或昵称：在打闹，不是在吵架
  if (compact.length <= 40 && MOCK_SCOLD_RE.test(compact) && PLAYFUL_SOFTENER_RE.test(compact)) return true;
  if (compact.length <= 24 && /(?:啦|嘛|哟|咯|呀|捏)$/.test(compact)) return true;
  return false;
}

/** 从朗读文本猜情绪（短聊口语） */
function inferTtsEmotionFromText(text) {
  const t = String(text || '');
  if (!t.trim()) return '';
  if (isPlayfulSpeech(t)) {
    if (/呜+|哭了|好难过|好伤心|好委屈/.test(t) && !/哈哈|嘻嘻|嘿嘿/.test(t)) return 'sad';
    return 'fluent';
  }
  // 打闹和真怒共用的词，没有确凿怒意就不填情绪：
  // 交给 MiniMax 按整句自己判，比一律按 angry 合成稳得多
  if (MOCK_SCOLD_RE.test(t) && !HARD_ANGER_RE.test(t)) return '';
  const rules = [
    [/生气了|闭嘴|凭什么|受够了|无语透了|真是够了|别烦我|我警告你/, 'angry'],
    [/(?:^|[。！\n])滚(?:吧|啊|！|!|$)/, 'angry'],
    [/恶心|嫌弃|真恶心|吐了|恶心死/, 'disgusted'],
    [/吓死|好怕|害怕|不敢|好紧张|别吓我/, 'fearful'],
    [/真的假的|不会吧|天哪|居然|哇{2,}/, 'surprised'],
    [/呜+|哭|难过|伤心|委屈|心疼|好想哭|别走/, 'sad'],
    // 陪睡呓语：电话里不要 normal "嗯……"，要气声+轻。
    // 必须排在「困了/想睡/晚安」(→calm) 之前，否则 calm 会先命中被 resolveCallTtsEmotion 丢弃。
    // 嗯/唔/呓语/半梦半醒/睡梦中 都要兜成 whisper。
    [/呓语|半梦|半睡|睡眼惺忪|迷迷糊糊|睡梦中|睡着了|打呼|翻身|呼吸声|极轻|轻声说|轻哼/, 'whisper'],
    // 纯呓语气词：配合「……」「——」尾巴时尤其要兜成 whisper。
    // 引号/括号开头也算（如「嗯……」/（唉……））
    [/(?:^|[^\p{L}\p{N}])(?:嗯|唔|呣|哼|唉)(?:[～~\-—…]+|$)/u, 'whisper'],
    // 「困了」「好困」这类也想兜成 whisper——但在「happy/calm」规则之前，
    // 并替换掉老的「困了|想睡|晚安|好累 → calm」兜底。
    [/困倦|好困|困得|快睡着了|想睡了/, 'whisper'],
    [/嘘+|小声点|偷偷|别告诉|悄悄话/, 'whisper'],
    [/哈哈+|嘻嘻+|嘿嘿+|噗+|噗嗤+|咯咯+|太好了|好开心|好高兴|真棒|耶+|好玩|爱你|想你啦|喜欢你|么么|抱抱|开心死/, 'happy'],
    [/困了|想睡|晚安|好累/, 'calm'],
  ];
  for (const [re, emo] of rules) {
    if (re.test(t)) return emo;
  }
  return '';
}

function inferTtsEmotionFromMood(mood) {
  const s = String(mood || '');
  if (!s.trim()) return '';
  if (/欲望|发烫|欲念/.test(s)) return 'happy';
  if (/思念|惦念|挂念|想你|亲近|亲密/.test(s)) return 'happy';
  if (/开心|高兴|想你|期待|害羞|爱|喜欢/.test(s)) return 'happy';
  if (/不好|难过|累|委屈|哭|雨/.test(s)) return 'sad';
  if (/生气|怒|烦/.test(s)) return 'angry';
  if (/忙|无聊|平静/.test(s)) return 'calm';
  return '';
}

function parseEmotionStateRaw(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

/** 从 emotion_state（连续情绪）映射 MiniMax 情绪 */
function inferTtsEmotionFromEmotionState(raw) {
  const state = parseEmotionStateRaw(raw);
  if (!state) return '';
  const mood = state.mood && typeof state.mood === 'object' ? state.mood : state;
  const primary = String(mood.primary || '').trim().toLowerCase();
  const v = Number(mood.valence) || 0;
  const a = Number(mood.arousal) || 0;
  const fuel = mood.fuel && typeof mood.fuel === 'object' ? mood.fuel : {};
  const anger = Number(fuel.anger) || 0;
  const hurt = Number(fuel.hurt) || 0;
  const low = Number(fuel.low) || 0;

  if (anger >= 52) return 'angry';
  if (hurt >= 52) return 'sad';
  if (low >= 58 && v <= -8) return 'sad';

  const PRIMARY_MAP = {
    calm: 'calm',
    happy: 'happy',
    warm: 'happy',
    low: 'sad',
    hurt: 'sad',
    angry: 'angry',
    anxious: 'fearful',
    lonely: 'sad',
    tired: 'calm',
    excited: 'surprised',
    bitter: 'disgusted',
    longing: 'sad',
    desire: 'happy',
    intimate: 'happy',
  };
  if (PRIMARY_MAP[primary]) return PRIMARY_MAP[primary];

  if (v <= -32 && a >= 42) return 'angry';
  if (v <= -22) return 'sad';
  if (v >= 32 && a >= 52) return 'surprised';
  if (v >= 18) return 'happy';
  if (a >= 58 && v < 0) return 'fearful';
  return '';
}

function inferLanguageBoost(text) {
  const t = String(text || '');
  const cn = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (t.match(/[A-Za-z]/g) || []).length;
  if (cn >= 2 && cn >= en) return 'Chinese';
  if (en >= 8 && en > cn * 2) return 'English';
  return 'auto';
}

/**
 * 解析本次 TTS 应使用的情绪提示。
 * 优先级：模型标注的 [语气:xx] → 调皮台词 → 本句情绪词 → 显式 emotion
 *        → 角色 emotion_state → 角色 mood。
 * 语气标注排第一：这句是不是玩笑只有写它的模型知道，字面永远猜不准。
 * 无明确信号时不填 emotion，交给 MiniMax 按文本自选（避免一律 calm/fluent 假声）。
 */
function resolveTtsEmotion(text, { tone, emotion, mood, emotionState, model } = {}) {
  const m = model || 'speech-02-hd';
  const tagged = normalizeTtsTone(tone, m);
  if (tagged) return tagged;
  if (isPlayfulSpeech(text)) {
    return normalizeTtsEmotion(inferTtsEmotionFromText(text) || 'fluent', m);
  }
  const fromText = normalizeTtsEmotion(inferTtsEmotionFromText(text), m);
  if (fromText) return fromText;
  const explicit = normalizeTtsEmotion(emotion, m);
  if (explicit) return explicit;
  const fromState = normalizeTtsEmotion(inferTtsEmotionFromEmotionState(emotionState), m);
  if (fromState) return fromState;
  return normalizeTtsEmotion(inferTtsEmotionFromMood(mood), m) || '';
}

/**
 * 电话里 MiniMax 的 happy/calm/fluent 很容易听成配音。
 * 只在「不套就会读错」或情绪非常硬时才填 emotion。
 */
function resolveCallTtsEmotion(text, model, tone) {
  const t = String(text || '');
  const m = model || 'speech-02-hd';
  const rawTone = String(tone || '').trim();
  const tagged = normalizeTtsTone(rawTone, m);
  if (tagged) {
    if (/调侃|玩笑|开玩笑|打趣|逗|戏谑|揶揄|俏皮|调皮|傲娇|嘴硬|撒娇/.test(rawTone)) {
      // 嘴上骂其实在打闹：不套会被读成真怒；平常一句调侃不必套 happy
      if (MOCK_SCOLD_RE.test(t) || HARD_ANGER_RE.test(t)) return tagged;
    } else if (tagged === 'angry' || tagged === 'sad' || tagged === 'whisper' || tagged === 'fearful') {
      return tagged;
    }
    // 温柔/认真/开心/无奈这类：空情绪比套 MiniMax 表演腔更像打电话
  }
  const fromText = normalizeTtsEmotion(inferTtsEmotionFromText(t), m);
  if (!fromText) return '';
  if (fromText === 'sad' || fromText === 'angry' || fromText === 'fearful' || fromText === 'disgusted' || fromText === 'whisper') {
    return fromText;
  }
  return '';
}

function ttsNumberSetting(settings, key, fallback, { min, max } = {}) {
  const n = Number(String(settings?.[key] ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (Number.isFinite(min) && n < min) return fallback;
  if (Number.isFinite(max) && n > max) return fallback;
  return n;
}

function clampTtsSpeed(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.72, Math.min(1.22, Math.round(n * 100) / 100));
}

function inferTtsSpeedFromText(text) {
  const t = String(text || '');
  if (/嗯[—\-～~…]{1,}|那个[….。]{2,}|等一下|我在弄|忙着呢|心不在焉/.test(t)) return 0.82;
  if (/一边.{0,12}(打电话|听着|说话|聊)/.test(t)) return 0.82;
  return null;
}

function speedForTtsEmotion(emotion) {
  switch (String(emotion || '')) {
    case 'happy':
    case 'fluent': return 1.0;
    case 'surprised': return 1.12;
    case 'angry': return 1.1;
    case 'sad': return 0.84;
    case 'calm': return 0.88;
    case 'fearful': return 1.05;
    case 'whisper': return 0.86;
    case 'disgusted': return 0.92;
    default: return 1.0;
  }
}

/**
 * 电话语速固定 1.0：跟情绪变速、模型标 [语速] 都会听成忽快忽慢。
 * 语音条仍可跟情绪走。小机喇叭用用户设的 robot_tts_speed。
 */
function resolveTtsSpeed(text, { forSpeaker, settings, emotion, taggedSpeed, speed, inCall } = {}) {
  if (forSpeaker) {
    return ttsNumberSetting(settings, 'robot_tts_speed', 1.0, { min: 0.5, max: 2 });
  }
  if (inCall) return 1;
  const explicit = Number(speed);
  if (Number.isFinite(explicit) && explicit > 0) return clampTtsSpeed(explicit);
  if (taggedSpeed != null) return clampTtsSpeed(taggedSpeed);
  const fromText = inferTtsSpeedFromText(text);
  if (fromText != null) return fromText;
  return clampTtsSpeed(speedForTtsEmotion(emotion));
}

function isLoudCallTts(opts) {
  if (!opts?.inCall || opts.forSpeaker) return false;
  if (opts.loudPlace === true) return true;
  if (opts.characterId == null) return false;
  try {
    return !!require('./sound-fx-helper').isLoudCallPlace(opts.characterId);
  } catch {
    return false;
  }
}

function clampTtsPitch(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-12, Math.min(12, Math.round(n)));
}

/**
 * 多分饰段合成后拼成一条 mp3。优先 ffmpeg；没有则直接拼接（同参数时通常可播）。
 */
async function concatTtsMp3Buffers(buffers) {
  const parts = (buffers || []).filter((b) => Buffer.isBuffer(b) && b.length >= MIN_TTS_AUDIO_BYTES);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];

  try {
    const { resolveFfmpegBin, isFfmpegReady } = require('./ffmpeg-bin');
    if (isFfmpegReady()) {
      const os = require('os');
      const { promisify } = require('util');
      const { execFile } = require('child_process');
      const execFileAsync = promisify(execFile);
      const ffmpegBin = resolveFfmpegBin();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nian-tts-'));
      try {
        const listPath = path.join(dir, 'list.txt');
        const outPath = path.join(dir, 'out.mp3');
        const lines = [];
        for (let i = 0; i < parts.length; i++) {
          const p = path.join(dir, `p${i}.mp3`);
          fs.writeFileSync(p, parts[i]);
          lines.push(`file '${p.replace(/\\/g, '/')}'`);
        }
        fs.writeFileSync(listPath, `${lines.join('\n')}\n`, 'utf8');
        await execFileAsync(ffmpegBin, [
          '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
          '-c', 'copy', outPath,
        ], { timeout: 60000 });
        const out = fs.readFileSync(outPath);
        if (out.length >= MIN_TTS_AUDIO_BYTES) return out;
      } finally {
        try {
          for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
          fs.rmdirSync(dir);
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[TTS] concat ffmpeg failed, fallback raw join:', e.message);
  }
  return Buffer.concat(parts);
}

/**
 * 小机那条链路上，mp3 还要被解成 PCM、重采样、压成 opus 才进喇叭。
 * 直接按设备原生的 16k 合成能少一次重采样，毛刺和底噪都会轻一些。
 * 觉得声音发闷就把 robot_tts_sample_rate 调回 24000 / 32000。
 */
function buildTtsAudioSetting(settings, forSpeaker) {
  return {
    sample_rate: forSpeaker
      ? ttsNumberSetting(settings, 'robot_tts_sample_rate', 16000, { min: 8000, max: 44100 })
      : 32000,
    bitrate: forSpeaker
      ? ttsNumberSetting(settings, 'robot_tts_bitrate', 128000, { min: 32000, max: 256000 })
      : 128000,
    format: 'mp3',
    channel: 1,
  };
}

/**
 * @param {object} settings
 * @param {string} text
 * @param {string} voiceId
 * @param {{ emotion?: string, mood?: string, forSpeaker?: boolean }} [opts]
 *   forSpeaker：这段是要从小机喇叭放出来的，旁白不念、按设备采样率合成
 *   文本里可用 [软声]…[/软声] / [沉声]…[/沉声]：同一 voice_id 上分段调 pitch 再拼接
 */
async function callTTS(settings, text, voiceId, opts = {}) {
  const apiKey = normalizeMinimaxApiKey(settings.minimax_api_key);
  if (!apiKey) {
    throw new Error('请先在设置中填写 MiniMax API Key');
  }
  const vid = (voiceId || '').trim();
  if (!vid) {
    throw new Error('请先在角色中填写 MiniMax 声音 ID');
  }
  const forSpeaker = !!opts.forSpeaker;
  const inCall = !!opts.inCall && !forSpeaker;
  const model = resolveTtsModel(settings);
  const {
    sanitizeForSpeech,
    extractSpeechRateTag,
    extractToneTag,
    extractVoiceLaneSegments,
    stripVoiceLaneTags,
    voiceLaneNeedsSplit,
    voiceLaneProsody,
  } = require('./speech-text-helper');
  const taggedSpeed = extractSpeechRateTag(text);
  // 标签可能还留在原文里（机器人链路），也可能入库时就摘出来走 opts 传进来
  const taggedTone = extractToneTag(text) || String(opts?.tone || '').trim();
  const rawDisplay = stripImageDirectiveForDisplay(text);
  // 电话 / 聊天气泡：少套情绪、少表演标记，避免听成配音
  // 小机喇叭仍可保留旁白剥离与设备语速
  const naturalPhoneLike = inCall || !forSpeaker;
  const sanitizeOpts = {
    dropAsides: forSpeaker || naturalPhoneLike,
    keepSpeechActs: !naturalPhoneLike && isSpeech28Model(model),
  };

  let laneSegs;
  // 电话默认一条平常嗓子；文里若带了 [软声]/[沉声]（讲故事轻分饰），按段做极轻音高差
  if (naturalPhoneLike && !voiceLaneNeedsSplit(rawDisplay)) {
    const flat = sanitizeForSpeech(stripVoiceLaneTags(rawDisplay), sanitizeOpts);
    laneSegs = flat ? [{ lane: 'normal', text: flat }] : [];
  } else {
    laneSegs = extractVoiceLaneSegments(rawDisplay)
      .map((s) => ({
        lane: s.lane,
        text: sanitizeForSpeech(s.text, sanitizeOpts),
      }))
      .filter((s) => s.text);
  }
  if (!laneSegs.length) {
    throw new Error('TTS 文本为空');
  }

  const groupId = String(settings.minimax_group_id || '').trim();
  const loudPlace = isLoudCallTts(opts);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  const targets = buildMinimaxTtsTargets(settings);
  const outputFormats = ['url', 'hex'];

  async function synthesizeOne(speakText, lane) {
    // 软/沉只微调 pitch/speed；电话场景仍不套 happy 等表演情绪
    const prosody = voiceLaneProsody(lane);
    let emotion = '';
    if (naturalPhoneLike) {
      // 少套 happy/fluent，空情绪往往比「生动」更像真人随口说
      emotion = resolveCallTtsEmotion(speakText, model, taggedTone);
    } else {
      emotion = resolveTtsEmotion(speakText, {
        tone: taggedTone,
        emotion: opts?.emotion,
        mood: opts?.mood,
        emotionState: opts?.emotionState,
        model,
      });
      if (!emotion && prosody.preferEmotion) {
        emotion = normalizeTtsEmotion(prosody.preferEmotion, model);
      }
    }

    let speed = resolveTtsSpeed(text, {
      forSpeaker,
      settings,
      emotion,
      taggedSpeed,
      speed: opts?.speed,
      inCall: naturalPhoneLike,
    });
    speed = clampTtsSpeed(speed * (prosody.speedMul || 1));
    let vol = forSpeaker ? ttsNumberSetting(settings, 'robot_tts_volume', 0.85, { min: 0.1, max: 10 }) : 1.0;
    if (loudPlace) {
      speed = clampTtsSpeed(speed * 0.86);
      vol = Math.max(vol, 1.28);
    }
    const pitch = clampTtsPitch(
      Number.isFinite(Number(opts?.pitch)) ? Number(opts.pitch) + prosody.pitch : prosody.pitch,
    );
    const voice_setting = {
      voice_id: vid,
      speed,
      // 小喇叭推满会削顶，听着就是「撕拉撕拉」。留一点余量。
      vol,
      pitch,
    };
    if (emotion) voice_setting.emotion = emotion;

    const basePayload = {
      model,
      text: speakText,
      stream: false,
      language_boost: inferLanguageBoost(speakText),
      voice_setting,
      audio_setting: buildTtsAudioSetting(settings, forSpeaker),
    };

    let lastErr = '';

    async function decodeTtsResponse(data) {
      const audioRaw = data?.data?.audio;
      if (audioRaw) {
        const hexBuf = /^[0-9a-fA-F]+$/.test(audioRaw) ? Buffer.from(audioRaw, 'hex') : Buffer.from(audioRaw, 'base64');
        if (hexBuf.length >= MIN_TTS_AUDIO_BYTES) return hexBuf;
        lastErr = `音频过短（${hexBuf.length} 字节），可能解码失败`;
        return null;
      }
      const audioUrl = data?.data?.audio_file || data?.audio_file;
      if (audioUrl) {
        try {
          const ar = await fetch(audioUrl, {
            compress: false,
            timeout: 60000,
            ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(60000) } : {}),
          });
          if (ar.ok) {
            const buf = Buffer.from(await ar.arrayBuffer());
            if (buf.length >= MIN_TTS_AUDIO_BYTES) return buf;
            lastErr = `下载音频过短（${buf.length} 字节）`;
            return null;
          }
          lastErr = `下载音频失败 HTTP ${ar.status}`;
          return null;
        } catch (e) {
          lastErr = e.message || '下载音频失败';
          return null;
        }
      }
      return null;
    }

    for (const { base, groupId: gid } of targets) {
      for (const output_format of outputFormats) {
        const endpoint = buildMinimaxTtsUrl(base, gid);
        const payload = { ...basePayload, output_format };
        if (gid && !endpoint.includes('GroupId=')) payload.group_id = gid;
        const body = JSON.stringify(payload);
        try {
          const resp = await fetchMinimaxTts(endpoint, headers, body);
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            lastErr = errText.slice(0, 300) || `HTTP ${resp.status}`;
            continue;
          }
          const parsed = await readMinimaxTtsBody(resp);
          if (parsed.kind === 'audio' && parsed.buffer.length >= MIN_TTS_AUDIO_BYTES) {
            console.log('[TTS] emotion=%s pitch=%s lane=%s model=%s bytes=%d', emotion || '-', pitch, lane || 'normal', model, parsed.buffer.length);
            return parsed.buffer;
          }
          const rawText = parsed.text || '';
          let data;
          try {
            data = JSON.parse(rawText);
          } catch {
            lastErr = rawText.slice(0, 200) || '响应不是 JSON';
            continue;
          }
          if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
            lastErr = data.base_resp.status_msg || JSON.stringify(data.base_resp);
            continue;
          }
          const buffer = await decodeTtsResponse(data);
          if (buffer?.length >= MIN_TTS_AUDIO_BYTES) {
            console.log('[TTS] emotion=%s pitch=%s lane=%s model=%s bytes=%d', emotion || '-', pitch, lane || 'normal', model, buffer.length);
            return buffer;
          }
          lastErr = lastErr || '响应无有效音频数据';
        } catch (e) {
          lastErr = e.message;
          if (!/premature close|Invalid response body/i.test(e.message)) {
            console.error('[TTS] request failed', endpoint, output_format, e.message);
          }
        }
      }
    }
    throw new Error(formatMinimaxTtsFinalError(lastErr, groupId));
  }

  if (laneSegs.length === 1) {
    return synthesizeOne(laneSegs[0].text, laneSegs[0].lane);
  }

  const buffers = [];
  for (const seg of laneSegs) {
    buffers.push(await synthesizeOne(seg.text, seg.lane));
  }
  const merged = await concatTtsMp3Buffers(buffers);
  if (!merged?.length) throw new Error('TTS 分段拼接失败');
  console.log('[TTS] merged lanes=%d bytes=%d', laneSegs.length, merged.length);
  return merged;
}

const MIN_MUSIC_AUDIO_BYTES = 4000;

function buildMinimaxMusicUrl(base, groupId) {
  const root = String(base || '').replace(/\/+$/, '');
  let url = `${root}/v1/music_generation`;
  if (groupId) url += `?GroupId=${encodeURIComponent(groupId)}`;
  return url;
}

function isNonRetryableMusicError(msg) {
  return /not available to new users|no longer available|没有权限|未开通|insufficient|1008|2013|account.*music|music.*not.*enable|付费.*关闭|新用户|余额不足|quota/i.test(String(msg || ''));
}

function detectAudioExt(buf) {
  if (!buf?.length) return 'mp3';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') return 'wav';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (isMp3Buffer(buf)) return 'mp3';
  return 'mp3';
}

async function decodeMinimaxMusicResponse(data) {
  const audioRaw = data?.data?.audio;
  if (audioRaw && typeof audioRaw === 'string' && audioRaw.length > 80) {
    const hexBuf = /^[0-9a-fA-F]+$/.test(audioRaw)
      ? Buffer.from(audioRaw, 'hex')
      : Buffer.from(audioRaw, 'base64');
    if (hexBuf.length >= MIN_MUSIC_AUDIO_BYTES) return hexBuf;
  }
  const audioUrl = data?.data?.audio_file || data?.data?.url || data?.data?.audio_url || data?.audio_file;
  if (audioUrl && /^https?:\/\//i.test(String(audioUrl))) {
    const ar = await fetch(audioUrl, { compress: false, timeout: 90000 });
    if (!ar.ok) return null;
    const buf = Buffer.from(await ar.arrayBuffer());
    if (buf.length >= MIN_MUSIC_AUDIO_BYTES) return buf;
  }
  return null;
}

/**
 * MiniMax Music Generation：纯器乐（is_instrumental），不是 TTS。
 * 需账户已开通 Music API；2026-08-20 后新用户可能无法调用。
 */
async function generateMinimaxInstrumental(settings, prompt) {
  const apiKey = normalizeMinimaxApiKey(settings?.minimax_api_key);
  if (!apiKey) throw new Error('请先填写 MiniMax API Key');
  const promptText = String(prompt || '').trim().slice(0, 2000);
  if (promptText.length < 8) throw new Error('音乐描述过短');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const preferred = String(settings?.minimax_music_model || '').trim();
  const models = [...new Set([preferred, 'music-3.0', 'music-2.6'].filter(Boolean))];
  const targets = buildMinimaxTtsTargets(settings);
  const plan = [];
  if (targets[0]) {
    for (const model of models) plan.push({ ...targets[0], model });
  }
  if (targets[1] && models[0]) plan.push({ ...targets[1], model: models[0] });

  let lastErr = '';
  for (const { base, groupId: gid, model } of plan) {
    for (const output_format of ['url', 'hex']) {
      const endpoint = buildMinimaxMusicUrl(base, gid);
      const payload = {
        model,
        prompt: promptText,
        is_instrumental: true,
        output_format,
        audio_setting: { sample_rate: 44100, bitrate: 128000, format: 'mp3' },
      };
      if (gid) payload.group_id = gid;
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          timeout: 110000,
        });
        const raw = await resp.text();
        if (!resp.ok) {
          lastErr = raw.slice(0, 300) || `HTTP ${resp.status}`;
          if (isNonRetryableMusicError(lastErr)) throw new Error(lastErr);
          break;
        }
        let data;
        try { data = JSON.parse(raw); } catch {
          lastErr = raw.slice(0, 200) || '响应不是 JSON';
          break;
        }
        if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
          lastErr = data.base_resp.status_msg || String(data.base_resp.status_code);
          if (isNonRetryableMusicError(lastErr)) throw new Error(lastErr);
          break;
        }
        const buffer = await decodeMinimaxMusicResponse(data);
        if (buffer?.length >= MIN_MUSIC_AUDIO_BYTES) {
          const durationMs = Number(data.extra_info?.music_duration) || 0;
          const duration = durationMs > 0
            ? Math.max(1, Math.min(180, Math.round(durationMs / 1000)))
            : Math.max(8, Math.min(60, Math.round(buffer.length / 16000)));
          console.log('[music] MiniMax instrumental model=%s bytes=%d dur=%s', model, buffer.length, duration);
          return { buffer, duration, ext: detectAudioExt(buffer), model };
        }
        lastErr = '响应无有效音频数据';
      } catch (e) {
        lastErr = e.message;
        if (isNonRetryableMusicError(lastErr)) throw e;
        console.warn('[music] MiniMax request failed', endpoint, model, output_format, e.message);
        break;
      }
    }
  }
  throw new Error(lastErr || 'MiniMax 音乐生成失败');
}

function chatApiRoot(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/v1beta$/i, '')
    .replace(/\/v1$/i, '');
}

function collectBase64Audio(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectBase64Audio(item, out, seen);
    return out;
  }
  const mime = String(node.mime_type || node.mimeType || node.mime || '');
  const type = String(node.type || node.kind || '');
  const data = node.data || node.b64_json || node.audio_data;
  const looksAudio = /audio/i.test(mime) || type === 'audio' || node.inlineData;
  if (typeof data === 'string' && data.length > 800 && (looksAudio || /^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 80)))) {
    out.push(data.replace(/\s+/g, ''));
  }
  if (node.inlineData?.data) out.push(String(node.inlineData.data).replace(/\s+/g, ''));
  if (node.output_audio?.data) out.push(String(node.output_audio.data).replace(/\s+/g, ''));
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectBase64Audio(value, out, seen);
  }
  return out;
}

function decodeLyriaAudioBuffer(data) {
  const chunks = collectBase64Audio(data);
  for (const raw of chunks) {
    try {
      const buf = Buffer.from(raw, 'base64');
      if (buf.length >= MIN_MUSIC_AUDIO_BYTES && (isMp3Buffer(buf) || buf.toString('ascii', 0, 4) === 'RIFF' || buf.length > 20000)) {
        return buf;
      }
    } catch {}
  }
  return null;
}

/**
 * Google Lyria（Gemini API 的音乐模型）。gemini-3.1-pro 本身不能出音频。
 * 复用聊天 API Key / Base URL；官方走 /v1beta/interactions。
 */
async function generateGeminiLyriaInstrumental(settings, prompt) {
  const { url, apiKey } = resolveTaskApiCreds(settings, 'chat');
  if (!apiKey) throw new Error('未配置聊天 API Key');
  const promptText = String(prompt || '').trim().slice(0, 1800);
  if (promptText.length < 8) throw new Error('音乐描述过短');

  const root = chatApiRoot(url);
  const official = 'https://generativelanguage.googleapis.com';
  const hosts = [];
  const addHost = (h) => {
    const x = String(h || '').replace(/\/+$/, '');
    if (x && !hosts.includes(x)) hosts.push(x);
  };
  if (root) addHost(root);
  if (!root || /googleapis\.com/i.test(root)) addHost(official);

  const models = ['lyria-3-clip-preview', 'lyria-3.5'];
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-goog-api-key': apiKey,
  };
  const input = `${promptText} Unaccompanied solo only. One instrument. No band, no drums, no bass, no orchestra, no vocals. About 20 to 30 seconds.`;

  let lastErr = '';
  for (const host of hosts) {
    for (const model of models) {
      const endpoints = [
        `${host}/v1beta/interactions`,
        `${host}/v1/interactions`,
      ];
      if (host !== official && root) endpoints.push(`${host}/interactions`);
      const payload = JSON.stringify({
        model,
        input,
        response_format: { type: 'audio' },
      });
      for (const endpoint of endpoints) {
        try {
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: payload,
            timeout: 110000,
          });
          const raw = await resp.text();
          if (!resp.ok) {
            lastErr = raw.slice(0, 280) || `HTTP ${resp.status}`;
            if (/404|not found|unknown path|no route/i.test(lastErr)) continue;
            if (/permission|not supported|not enabled|未开通|没有权限/i.test(lastErr)) break;
            continue;
          }
          let data;
          try { data = JSON.parse(raw); } catch {
            lastErr = 'Lyria 响应不是 JSON';
            continue;
          }
          const buffer = decodeLyriaAudioBuffer(data);
          if (buffer?.length >= MIN_MUSIC_AUDIO_BYTES) {
            const duration = model.includes('clip') ? 30 : Math.max(12, Math.min(60, Math.round(buffer.length / 16000)));
            console.log('[music] Gemini Lyria model=%s bytes=%d dur=%s', model, buffer.length, duration);
            return { buffer, duration, ext: detectAudioExt(buffer), model };
          }
          lastErr = 'Lyria 响应无音频';
        } catch (e) {
          lastErr = e.message;
          console.warn('[music] Lyria request failed', endpoint, model, e.message);
        }
      }
    }
  }
  throw new Error(lastErr || 'Gemini Lyria 音乐生成失败');
}

const SPEECH_MODEL_RE = /^speech-/i;

/** MiniMax 官方 TTS 模型（无 /models 列表接口，按文档维护） */
const MINIMAX_SPEECH_MODELS = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
  'speech-01-hd',
  'speech-01-turbo',
  'speech-01-240228',
];

/** 图像生成常用模型（linkapi 等中转站无 /models 列表时使用） */
const IMAGEN_MODELS = [
  'imagen-3.0-generate-001',
  'imagen-3.0-fast-generate-001',
  'imagen-3.0-generate-002',
  'imagen-4.0-generate-001',
  'imagen-4.0-fast-generate-001',
];

function listKnownImageModels() {
  return [...IMAGEN_MODELS];
}

function resolveTtsModel(settings) {
  const raw = (settings.minimax_model || '').trim();
  if (raw && SPEECH_MODEL_RE.test(raw)) return raw;
  if (raw) {
    console.warn('[TTS] minimax_model 不是语音模型，已回退 speech-02-hd:', raw);
  }
  return 'speech-02-hd';
}

function normalizeImageApiBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return u;
  u = u.replace(/\?wait=true$/i, '').replace(/\/+$/, '');
  if (/\/v1\/generate$/i.test(u)) {
    return u.replace(/\/v1\/generate$/i, '/v1');
  }
  if (/\/generate$/i.test(u) && !/\/images\//i.test(u)) {
    return u.replace(/\/generate$/i, '');
  }
  if (/\/images\/generations$/i.test(u)) {
    return u.replace(/\/images\/generations$/i, '');
  }
  if (/\/images\/variations$/i.test(u)) {
    return u.replace(/\/images\/variations$/i, '');
  }
  if (/\/images\/edits$/i.test(u)) {
    return u.replace(/\/images\/edits$/i, '');
  }
  return u;
}

function buildImageGenerationEndpoints(baseUrl) {
  const u = normalizeImageApiBase(baseUrl);
  if (!u) return [];
  if (/\/images\/generations$/i.test(String(baseUrl || '').trim())) {
    return [String(baseUrl).trim().replace(/\/+$/, '')];
  }
  if (u.endsWith('/v1')) return [`${u}/images/generations`];
  return [`${u}/v1/images/generations`, `${u}/images/generations`];
}

function buildImageVariationEndpoints(baseUrl) {
  const u = normalizeImageApiBase(baseUrl);
  if (!u) return [];
  if (u.endsWith('/v1')) return [`${u}/images/variations`];
  return [`${u}/v1/images/variations`, `${u}/images/variations`];
}

function buildImageEditEndpoints(baseUrl) {
  const u = normalizeImageApiBase(baseUrl);
  if (!u) return [];
  if (/\/images\/edits$/i.test(String(baseUrl || '').trim())) {
    return [String(baseUrl).trim().replace(/\/+$/, '')];
  }
  if (u.endsWith('/v1')) return [`${u}/images/edits`];
  return [`${u}/v1/images/edits`, `${u}/images/edits`];
}

function isHiApiUrl(url) {
  return /hiapi\.ai/i.test(String(url || ''));
}

function looksLikeHiApiHost(url) {
  return isHiApiUrl(url);
}

function looksLikeTinySnowUrl(url) {
  return /tinysnow/i.test(String(url || ''));
}

function looksLikeTasksPath(url) {
  return /\/v1\/tasks(\b|\/|$)|\/tasks\/?$/i.test(String(url || ''));
}

function looksLikeEditsPath(url) {
  return /\/images\/edits/i.test(String(url || ''));
}

function looksLikeVideosPath(url) {
  return /\/v1\/videos(\b|\/|$)|\/videos\/?$/i.test(String(url || ''));
}

function looksLike80AiUrl(url) {
  return /80ai\.(net|com)/i.test(String(url || ''));
}

function modelLooksHiApiImg2Img(model) {
  const m = String(model || '');
  return /\/image-to-image\b|\/text-to-image\b|nano-banana|seedream/i.test(m);
}

function modelLooksHiApiVideo(model) {
  const m = String(model || '');
  if (/^sora/i.test(m)) return false;
  return /\/image-to-video\b|\/text-to-video\b|\/i2v\b|-i2v\b|kling|seedance|wan2|wan-|jimeng/i.test(m);
}

/** 画面向 NSFW / 擦边：露骨 + 内裤内衣等（日常「穿搭好看」不匹配，除非写到内裤/内衣本身） */
const NSFW_MEDIA_RE = /nsfw|hentai|porn|erotic|nude|naked|nsfl|explicit sex|blowjob|handjob|cumshot|creampie|ahegao|cameltoe|cleavage|see-?through|sheer\b|bulge|\bxxx\b|r-?18|18\+|做爱|上床|性爱|性交|口交|肛交|手淫|自慰|全裸|裸体|裸睡|裸照|露点|真空出街|开档|潮吹|内射|后入|骑乘|乳交|足交|射精|射进来|肉棒|鸡巴|阴茎|小穴|阴蒂|阴唇|乳头|奶子|凸点|勒痕|走光|擦边|情趣内衣|丁字裤|内裤|内衣|胸罩|文胸|三角裤|平角裤|裤裆|underwear|panties|lingerie|bra\b|thong|黄图|色图|色情|18禁|无码|有码/i;

function looksLikeNsfwMediaPrompt(text) {
  return NSFW_MEDIA_RE.test(String(text || ''));
}

function inferNsfwMediaRequest(options = {}, prompt = '') {
  const provider = String(options.provider || options.mediaProvider || '').trim().toLowerCase();
  if (provider === 'nsfw') return true;
  if (provider === 'daily' || provider === 'normal') return false;
  const flag = options.nsfw ?? options.contentMode;
  if (flag === true || flag === 1 || flag === '1' || flag === 'nsfw') return true;
  if (flag === false || flag === 0 || flag === '0' || flag === 'daily') return false;
  return looksLikeNsfwMediaPrompt([
    prompt,
    options.sceneQuery,
    options.userMessage,
    options.presetQuery,
    options.motionPromptCustom,
  ].filter(Boolean).join('\n'));
}

/**
 * 「要露骨图」的意图词：本身不是画面描述，但说明用户在索要 NSFW 向的图/视频。
 * 与 NSFW_MEDIA_RE 分开：那条是画面词（进 prompt 才命中），这条是聊天里的意图词。
 */
const NSFW_MEDIA_INTENT_RE = /露骨|大胆|私房|湿身|诱惑|勾引|性感|情趣|暴露|少穿|别穿|不穿|没穿|脱(?:了|掉|光|衣|下)|一丝不挂|真空|福利(?:图|照)|骚(?:一点|点)|浪(?:一点|点)|色(?:一点|点)|瑟瑟|涩涩|sexy|seductive|revealing|skimpy|strip|undress|topless|bottomless|spicy|lewd/i;

/**
 * 聊天走向是否已经偏 NSFW。
 * 不能只看模型写的英文画面词——聊天模型会自我审查，写出来的「自拍：」几乎总是穿戴整齐。
 * 这里把用户原话与最近几轮也算进来（肉文 / NSFW prompt 用，不再切换媒体供应商）。
 */
function inferChatMediaNsfwContext({
  userMessage = '',
  sceneQuery = '',
  replyText = '',
  recentHistory = [],
  char = null,
} = {}) {
  if (char && (char.nsfw_enabled === 0 || char.nsfw_enabled === '0')) return false;
  const thisTurn = [sceneQuery, replyText, userMessage].filter(Boolean).join('\n');
  if (NSFW_MEDIA_RE.test(thisTurn)) return true;
  if (NSFW_MEDIA_INTENT_RE.test([sceneQuery, userMessage].filter(Boolean).join('\n'))) return true;
  // 本轮话说得含蓄，但前几轮已经在这个方向上：要图就按 NSFW 走
  const recent = (Array.isArray(recentHistory) ? recentHistory : [])
    .slice(-4)
    .map((m) => String(m?.content || m || ''))
    .filter(Boolean)
    .join('\n');
  if (recent && (NSFW_MEDIA_RE.test(recent) || NSFW_MEDIA_INTENT_RE.test(recent))) return true;
  return false;
}

/** Pass-through：不再按 NSFW 切换到专用媒体供应商；保留导出名以免调用方破坏 */
function routeSettingsForMediaGen(settings) {
  return settings;
}

/** 图生图协议：按路径 / 域名 / 模型识别，未知则为 auto（失败会换协议再试） */
function detectImg2ImgProtocol(url, model) {
  const u = String(url || '');
  const m = String(model || '');
  if (looksLike80AiUrl(u)) return '80ai';
  if (looksLikeEditsPath(u) || looksLikeTinySnowUrl(u)) return 'openai-edits';
  if (looksLikeHiApiHost(u) || looksLikeTasksPath(u)) return 'hiapi';
  if (modelLooksHiApiImg2Img(m)) return 'hiapi';
  return 'auto';
}

/** 图生视频协议：HiAPI 兼容 /v1/tasks，或 OpenAI 兼容 /v1/videos */
function detectImg2VideoProtocol(url, model) {
  const u = String(url || '');
  const m = String(model || '');
  if (looksLikeVideosPath(u) || /^sora/i.test(m)) return 'openai-videos';
  if (looksLikeHiApiHost(u) || looksLikeTasksPath(u)) return 'hiapi';
  if (modelLooksHiApiVideo(m)) return 'hiapi';
  return 'auto';
}

function img2ImgProtocolOrder(protocol) {
  if (protocol === '80ai') return ['80ai'];
  if (protocol === 'hiapi') return ['hiapi', 'openai-edits'];
  if (protocol === 'openai-edits') return ['openai-edits', 'hiapi'];
  return ['openai-edits', 'hiapi'];
}

function img2VideoProtocolOrder(protocol) {
  if (protocol === 'openai-videos') return ['openai-videos', 'hiapi'];
  if (protocol === 'hiapi') return ['hiapi', 'openai-videos'];
  return ['hiapi', 'openai-videos'];
}

function img2ImgModelForProtocol(model, protocol) {
  const m = String(model || '').trim();
  if (protocol === 'hiapi') return normalizeHiApiImg2ImgModel(m || 'gpt-image-2');
  if (protocol === '80ai') return normalize80AiModelInput(m);
  return m.replace(/\/image-to-image$/i, '').replace(/\/text-to-image$/i, '') || 'gpt-image-2';
}

function img2VideoModelForProtocol(model, protocol) {
  const m = String(model || '').trim();
  if (protocol === 'hiapi') return m || 'kling-3.0-omni/image-to-video';
  return m.replace(/\/image-to-video$/i, '') || 'sora-2';
}

function isMediaApiProtocolMismatch(msg) {
  const t = String(msg || '');
  return /HTTP 404\b|HTTP 405\b|not found|no route|cannot post|unknown (endpoint|path|url)|method not allowed|接口不存在|路径不存在|does not exist|unsupported (url|path|endpoint)|invalid url path|<html/i.test(t);
}

function shouldTryNextMediaProtocol(err, protocol, isLast) {
  if (isLast) return false;
  if (isApiBillingError(err)) return false;
  if (protocol === 'auto') return true;
  return isMediaApiProtocolMismatch(err);
}

/** HiAPI 模型别名 → 官方名 */
function normalizeHiApiImageModel(raw, { preferImg2Img = false } = {}) {
  let m = String(raw || '').trim();
  if (!m) {
    return preferImg2Img ? 'gpt-image-2/image-to-image' : 'gpt-image-2/text-to-image';
  }
  const compact = m.toLowerCase().replace(/[\s_]+/g, '-');
  const aliases = {
    banana: 'Nano-Banana',
    'nano-banana': 'Nano-Banana',
    nanobanana: 'Nano-Banana',
    banana2: 'Nano-Banana-2',
    'nano-banana-2': 'Nano-Banana-2',
    nanobanana2: 'Nano-Banana-2',
    'banana-2': 'Nano-Banana-2',
    'banana-pro': 'Nano-Banana-Pro',
    bananapro: 'Nano-Banana-Pro',
    'nano-banana-pro': 'Nano-Banana-Pro',
    nanobananapro: 'Nano-Banana-Pro',
    'banana2-lite': 'Nano-Banana-2-Lite',
    'nano-banana-2-lite': 'Nano-Banana-2-Lite',
    seedream: preferImg2Img ? 'seedream-5.0-lite/image-to-image' : 'seedream-5.0-lite/text-to-image',
    'seedream-5': preferImg2Img ? 'seedream-5.0-lite/image-to-image' : 'seedream-5.0-lite/text-to-image',
    'seedream-5.0': preferImg2Img ? 'seedream-5.0-lite/image-to-image' : 'seedream-5.0-lite/text-to-image',
    'seedream-lite': preferImg2Img ? 'seedream-5.0-lite/image-to-image' : 'seedream-5.0-lite/text-to-image',
    'seedream-5.0-lite': preferImg2Img ? 'seedream-5.0-lite/image-to-image' : 'seedream-5.0-lite/text-to-image',
    'seedream-pro': preferImg2Img ? 'seedream-5.0-pro/image-to-image' : 'seedream-5.0-pro/text-to-image',
    'seedream-5.0-pro': preferImg2Img ? 'seedream-5.0-pro/image-to-image' : 'seedream-5.0-pro/text-to-image',
    'seedream-4.5': preferImg2Img ? 'seedream-4.5/image-to-image' : 'seedream-4.5/text-to-image',
  };
  if (aliases[compact]) m = aliases[compact];

  if (/^gpt-image-2$/i.test(m)) {
    return preferImg2Img ? 'gpt-image-2/image-to-image' : 'gpt-image-2/text-to-image';
  }
  if (preferImg2Img && /gpt-image-2\/text-to-image/i.test(m)) {
    return m.replace(/text-to-image/i, 'image-to-image');
  }
  if (preferImg2Img && /seedream/i.test(m) && /text-to-image/i.test(m)) {
    return m.replace(/text-to-image/i, 'image-to-image');
  }
  // 图生图模型名拿来做纯文生图：image-to-image → text-to-image
  if (!preferImg2Img && /image-to-image/i.test(m)) {
    return m.replace(/image-to-image/i, 'text-to-image');
  }
  if (!preferImg2Img && /seedream/i.test(m) && /image-to-image/i.test(m) === false && !/\//.test(m)) {
    // 已在 aliases 处理
  }
  // 已是完整名 / Banana 系列：原样保留
  return m;
}

/** HiAPI 图生图模型名：gpt-image-2 → gpt-image-2/image-to-image；Banana 不改成 GPT */
function normalizeHiApiImg2ImgModel(raw) {
  return normalizeHiApiImageModel(raw, { preferImg2Img: true });
}

/** 把图生图栏的配置改成「纯文生图」兜底用（无参考图） */
function resolveImg2ImgTextToImageConfig(settings) {
  const cfg = resolveImg2ImgConfig(settings);
  if (!cfg) return null;
  if (cfg.protocol === 'hiapi' || cfg.hiapi) {
    return {
      ...cfg,
      model: normalizeHiApiImageModel(cfg.model, { preferImg2Img: false }),
    };
  }
  if (cfg.protocol === '80ai') {
    return {
      ...cfg,
      model: normalize80AiModelInput(cfg.model).replace(/_edit$/i, ''),
    };
  }
  // TinySnow / OpenAI 兼容：用同一 Key 打 /images/generations，模型去掉 image-to-image 后缀
  let model = String(cfg.model || 'gpt-image-2').trim() || 'gpt-image-2';
  model = model.replace(/\/image-to-image$/i, '').replace(/\/text-to-image$/i, '') || 'gpt-image-2';
  return { ...cfg, model, hiapi: false };
}

/**
 * 聊天配图文生图失败时：用「图生图 API」的 URL/Key 再试一轮纯文生图（不带参考图）
 */
async function generateImageViaImg2ImgTextFallback(settings, prompt, taskOpts = {}) {
  const cfg = resolveImg2ImgTextToImageConfig(settings);
  if (!cfg) return null;

  // 主文生图已成功时不必再试；主文生图失败时即使用同一套凭证也应走 text-to-image 协议
  const mainUrl = normalizeImageApiBase(String(settings?.image_api_url || '').trim());
  const mainKey = String(settings?.image_api_key || '').trim();
  const fbUrl = normalizeImageApiBase(cfg.url);
  if (!taskOpts.afterMainImageFailure && mainUrl && mainKey && fbUrl === mainUrl && cfg.key === mainKey) {
    return null;
  }

  console.warn(`[generateImage] 文生图失败，改用图生图 API 做纯文生图 model=${cfg.model} protocol=${cfg.protocol}`);
  const aspect = resolveRequestAspect(taskOpts, '3:4');
  if (cfg.protocol === '80ai') {
    return generateImageVia80Ai({
      ...settings,
      image_api_url: cfg.url,
      image_api_key: cfg.key,
      image_model: cfg.model,
    }, prompt, null, { aspect });
  }
  if (cfg.protocol === 'hiapi' || cfg.protocol === 'auto' || cfg.hiapi || isHiApiUrl(cfg.url)) {
    const viaHi = await generateImageViaHiApiTasks(cfg, prompt, [], {
      aspect,
      publicBase: taskOpts.publicBase || taskOpts.reqBase || '',
      requireReference: false,
    });
    if (viaHi) return viaHi;
    if (isApiBillingError(_lastGenerateImageError)) return null;
    if (cfg.protocol === 'hiapi' && !isMediaApiProtocolMismatch(_lastGenerateImageError)) return null;
  }

  // OpenAI 兼容：/images/generations
  const baseUrl = normalizeImageApiBase(cfg.url);
  const { pixels } = resolveImageSizeParams(aspect);
  const imgBody = {
    prompt: String(prompt || '').trim() || 'image',
    n: 1,
    size: pixels,
    model: cfg.model,
  };
  let lastErr = '';
  for (const endpoint of buildImageGenerationEndpoints(baseUrl)) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify(imgBody),
        timeout: IMAGE_GEN_MAX_WAIT_MS,
      });
      const raw = await resp.text().catch(() => '');
      if (!resp.ok) {
        lastErr = formatImageGenApiError(`HTTP ${resp.status}: ${raw.slice(0, 300)}`) || raw.slice(0, 200);
        console.error('[generateImage/img2img-t2i]', endpoint, lastErr);
        continue;
      }
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      const result = extractImageResultFromApiData(data);
      if (result) {
        _lastGenerateImageMeta = {
          usedReference: false,
          model: cfg.model,
          mode: 'img2img-api/text-to-image',
          refLoaded: false,
        };
        _lastGenerateImageError = '';
        return result;
      }
      lastErr = `返回空: ${raw.slice(0, 200)}`;
    } catch (e) {
      lastErr = e.message || String(e);
      console.error('[generateImage/img2img-t2i]', endpoint, lastErr);
      if (isImageGenWaitTimeoutError(lastErr)) break;
    }
  }
  if (lastErr) _lastGenerateImageError = lastErr;
  return null;
}

/**
 * 按模型拼 HiAPI 图像 input。
 * - gpt-image-2/image-to-image → input_urls + 1K
 * - Nano-Banana-2 / Pro → image_input + 1K
 * - Seedream 图生图 → image_urls；Lite 仅 2K/4K，Pro 可用 1K/2K（默认 2K）
 * - Flux / Grok / 其它 i2i → image_urls
 * - 经典 Nano-Banana → 仅文生图
 */
function buildHiApiImageTaskInput(model, { prompt, referenceUrls = [], aspect } = {}) {
  const m = String(model || '');
  const aspectRatio = aspectToHiApiImageAspect(aspect);
  const promptText = String(prompt || '').trim() || 'image';
  const refs = (Array.isArray(referenceUrls) ? referenceUrls : [referenceUrls]).filter(Boolean);

  // GPT Image 2
  if (/gpt-image-2/i.test(m)) {
    const input = {
      prompt: promptText,
      aspect_ratio: aspectRatio,
      resolution: '1K',
    };
    if (/image-to-image/i.test(m) || refs.length) {
      input.input_urls = refs.slice(0, 5);
    }
    return { input, refField: refs.length ? 'input_urls' : null };
  }

  // 经典 Nano-Banana：文档仅文生图，无参考图
  if (/^nano-banana$/i.test(m)) {
    return {
      input: {
        prompt: promptText,
        aspect_ratio: aspectRatio,
        output_format: 'png',
      },
      refField: null,
      refsUnsupported: refs.length > 0,
    };
  }

  // Nano-Banana-2 / Pro：image_input
  if (/^nano-banana-2$/i.test(m) || /^nano-banana-pro$/i.test(m)) {
    const input = {
      prompt: promptText,
      aspect_ratio: aspectRatio,
      resolution: '1K',
      output_format: 'png',
      image_input: refs.slice(0, 8),
    };
    return { input, refField: 'image_input' };
  }

  // Seedream：图生图走 image_urls；Lite 不接受 1K
  if (/seedream/i.test(m)) {
    const isLite = /lite/i.test(m);
    const isI2i = /image-to-image/i.test(m) || refs.length > 0;
    const input = {
      prompt: promptText,
      aspect_ratio: aspectRatio,
      // Lite i2i/t2i 文档：2K/4K；Pro：1K/2K。自拍默认 2K 最稳
      resolution: isLite ? '2K' : '2K',
    };
    if (/pro/i.test(m) && !isLite) {
      // pro 可用 1K，但仍默认 2K 质量更好；需要省钱时可再改
      input.resolution = '2K';
      input.output_format = 'png';
    }
    if (isI2i) {
      const maxRefs = isLite ? 14 : 10;
      input.image_urls = refs.slice(0, maxRefs);
      if (!input.image_urls.length) {
        return { input, refField: 'image_urls', refsUnsupported: false };
      }
      return { input, refField: 'image_urls' };
    }
    // 纯文生图
    return { input, refField: null };
  }

  // Flux / Grok / Banana Lite 等：image_urls
  if (/nano-banana-2-lite|flux.*image-to-image|grok-imagine.*image-to-image|flux-2/i.test(m)) {
    const input = {
      prompt: promptText,
      aspect_ratio: aspectRatio,
      resolution: '1K',
    };
    if (refs.length) input.image_urls = refs.slice(0, 10);
    return { input, refField: refs.length ? 'image_urls' : null };
  }

  // 其它图像模型：有参考图时优先 image_urls，创建失败时再换字段
  const input = {
    prompt: promptText,
    aspect_ratio: aspectRatio,
    resolution: '1K',
  };
  if (refs.length) input.image_urls = refs.slice(0, 8);
  return { input, refField: refs.length ? 'image_urls' : null };
}

function rotateHiApiImageRefField(input, preferredOrder = ['image_input', 'image_urls', 'input_urls']) {
  const present = preferredOrder.find(k => Array.isArray(input[k]));
  if (!present) return false;
  const urls = input[present];
  const next = preferredOrder[(preferredOrder.indexOf(present) + 1) % preferredOrder.length];
  delete input.input_urls;
  delete input.image_input;
  delete input.image_urls;
  input[next] = urls;
  return true;
}

/** HiAPI 部分模型不认 aspect_ratio，会报 additional property；换 size/像素再试，禁止裸删导致默认 1:1 */
const HIAPI_ASPECT_FIELD_MODES = ['aspect_ratio', 'size_ratio', 'size_pixels', 'aspectRatio', 'prompt_only'];

function clearHiApiAspectFields(input) {
  if (!input || typeof input !== 'object') return;
  delete input.aspect_ratio;
  delete input.aspectRatio;
  delete input.aspect;
  // 仅清「比例用的 size」：形如 3:4 / 1024x1536；保留其它语义的 size 不管（极少）
  if (typeof input.size === 'string' && (/^\d+:\d+$/.test(input.size) || /^\d+x\d+$/i.test(input.size))) {
    delete input.size;
  }
}

function applyHiApiAspectFieldMode(input, aspect, modeName) {
  const { ratio, pixels } = resolveImageSizeParams(aspect);
  clearHiApiAspectFields(input);
  if (modeName === 'aspect_ratio') input.aspect_ratio = ratio;
  else if (modeName === 'size_ratio') input.size = ratio;
  else if (modeName === 'size_pixels') input.size = pixels;
  else if (modeName === 'aspectRatio') input.aspectRatio = ratio;
  // prompt_only：靠 generateImage 已注入的比例约束，不再塞字段
  return input;
}

function nextHiApiAspectMode(current) {
  const i = HIAPI_ASPECT_FIELD_MODES.indexOf(current);
  if (i < 0 || i >= HIAPI_ASPECT_FIELD_MODES.length - 1) return null;
  return HIAPI_ASPECT_FIELD_MODES[i + 1];
}

function isHiApiAspectFieldName(key) {
  return /^(aspect_ratio|aspectRatio|aspect|size)$/i.test(String(key || ''));
}

/** 独立图生图 API（任意中转：自动识别 HiAPI /v1/tasks、OpenAI /images/edits、80ai）；未配置时返回 null */
function resolveImg2ImgConfig(settings) {
  const url = String(settings?.img2img_api_url || '').trim();
  const key = String(settings?.img2img_api_key || '').trim();
  if (!url || !key) return null;
  let model = String(settings?.img2img_model || '').trim();
  const protocol = detectImg2ImgProtocol(url, model);
  if (!model) {
    if (protocol === '80ai') model = 'gptimage2_medium';
    else if (protocol === 'hiapi') model = 'gpt-image-2/image-to-image';
    else model = 'gpt-image-2';
  } else if (protocol === 'hiapi') {
    model = normalizeHiApiImg2ImgModel(model);
  }
  return { url, key, model, protocol, hiapi: protocol === 'hiapi' };
}

function resolveHiApiImageApiConfig(settings, { preferImg2Img = false } = {}) {
  const url = String(settings?.image_api_url || '').trim();
  const key = String(settings?.image_api_key || '').trim();
  if (!url || !key || !isHiApiUrl(url)) return null;
  const model = normalizeHiApiImageModel(settings?.image_model, { preferImg2Img });
  return { url, key, model, hiapi: true };
}

function extractImageResultFromApiData(data) {
  const result =
    data?.data?.[0]?.url ||
    data?.data?.[0]?.b64_json ||
    data?.data?.[0]?.image_url ||
    (typeof data?.data?.[0] === 'string' ? data.data[0] : null) ||
    data?.url ||
    data?.image_url ||
    data?.images?.[0]?.url ||
    data?.images?.[0] ||
    data?.output?.[0]?.url ||
    data?.output?.[0] ||
    data?.result?.url ||
    null;
  if (!result || typeof result !== 'string') return null;
  if (!/^https?:\/\//i.test(result) && !result.startsWith('/') && !result.startsWith('data:')) {
    return `data:image/png;base64,${result}`;
  }
  return result;
}

async function loadImageAsUploadPart(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  const dataUrl = await resolveImageToBase64(imageUrl);
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  const contentType = m[1] || 'image/png';
  const buffer = Buffer.from(m[2], 'base64');
  const ext = /jpeg|jpg/i.test(contentType) ? 'jpg' : /webp/i.test(contentType) ? 'webp' : 'png';
  return { buffer, contentType, ext };
}

function normalizeSelfieAspect(raw) {
  const a = String(raw || '3:4').trim();
  const allowed = ['1:1', '3:4', '4:3', '5:7', '7:5', '9:16', '16:9'];
  return allowed.includes(a) ? a : '3:4';
}

/**
 * 按画面内容推断聊图/视频比例（全角色通用）。
 * · 风景/空镜/街景等 → 横屏 16:9
 * · 自拍/人像 → 角色「自拍比例」或竖屏视频偏好
 * · 美食/静物/特写等随手拍 → 竖图 3:4
 * kind: 'selfie' | 'image' | 'video'
 *
 * 视频只认 9:16 / 16:9（多数图生视频模型不吃 3:4）；
 * 且不要拿整段聊天正文做风景判断，否则「城市/窗外」等词会误判成横屏导致生视频失败。
 */
function inferChatMediaAspect(opts = {}) {
  const kind = String(opts.kind || 'image');
  const query = String(opts.query || opts.scene || '').trim();
  // 配图可用正文；配视频只看场景词（配视频：后面那句），避免聊天闲话误触
  const blob = kind === 'video'
    ? query
    : `${query} ${opts.text || ''} ${opts.scene || ''}`;
  const char = opts.char || {};
  const selfiePref = normalizeSelfieAspect(char.image_aspect || '3:4');
  // 视频默认用视频比例；不要回落到自拍用的 3:4
  const videoPrefRaw = normalizeSelfieAspect(char.video_aspect || '9:16');
  const videoPref = (videoPrefRaw === '16:9' || videoPrefRaw === '4:3') ? '16:9' : '9:16';

  if (kind === 'selfie') return selfiePref;

  const landscape = /风景|美景|景色|山水|海景|海边|海岸|沙滩|晚霞|朝霞|日落|日出|星空|夜景|街景|地平线|田野|草原|森林|瀑布|雪景|云海|全景|天际线|horizon|landscape|scenery|skyline|sunset|sunrise|beach|seascape|ocean|mountain|panorama|wide\s*shot|aerial|cityscape|street\s*view/i.test(blob);
  const portrait = /自拍|人像|半身|正脸|侧脸|穿搭|镜子|镜中|腹肌|手部|selfie|portrait|mirror\s*selfie|close-?up\s*face/i.test(blob);
  const foodOrDetail = /美食|食物|咖啡|奶茶|蛋糕|甜点|菜|碗|盘|特写|静物|花|盆栽|宠物|猫|狗|书|书桌|food|coffee|dessert|close-?up|still\s*life|pet/i.test(blob);

  if (kind === 'video') {
    // 视频链路只输出 9:16 / 16:9
    if (landscape && !portrait) return '16:9';
    if (portrait) return '9:16';
    return videoPref;
  }

  // 普通配图（非自拍）
  if (landscape && !portrait) return '16:9';
  if (portrait) return selfiePref;
  if (foodOrDetail) return '3:4';
  return selfiePref;
}

/** 视频用比例：强制收敛到 9:16 / 16:9 */
function normalizeVideoAspect(raw) {
  const a = normalizeSelfieAspect(raw || '9:16');
  if (a === '16:9' || a === '4:3') return '16:9';
  return '9:16';
}

/** 生图用比例：优先显式传入，缺省用竖图 3:4（禁止悄悄掉回 1:1） */
function resolveRequestAspect(options = {}, fallback = '3:4') {
  return normalizeSelfieAspect(options.aspect || options.size || fallback);
}

/** 把比例写进提示词，逼模型/中转不要偷偷出方图 */
function aspectPromptConstraint(aspect) {
  const a = normalizeSelfieAspect(aspect);
  const hint = {
    '9:16': 'strict vertical 9:16 frame, mid-shot or three-quarter showing shoulders and chest, not a tight face-only crop, NOT square, NOT 1:1',
    '3:4': 'strict vertical 3:4 portrait frame, NOT square, NOT 1:1',
    '5:7': 'strict vertical 5:7 portrait frame, NOT square, NOT 1:1',
    '16:9': 'strict horizontal 16:9 widescreen frame, NOT square, NOT 1:1',
    '4:3': 'strict 4:3 landscape frame, NOT square, NOT 1:1',
    '7:5': 'strict horizontal 7:5 landscape frame, NOT square, NOT 1:1',
    '1:1': 'strict square 1:1 frame',
  }[a] || `strict aspect ratio ${a}`;
  return hint;
}

/** TinySnow 等常用比例字符串；OpenAI 兼容站用像素 */
function resolveImageSizeParams(aspect) {
  const ratio = normalizeSelfieAspect(aspect);
  const pixels = {
    '1:1': '1024x1024',
    '3:4': '1024x1536',
    '4:3': '1536x1024',
    '5:7': '1024x1434',
    '7:5': '1434x1024',
    '9:16': '1024x1792',
    '16:9': '1792x1024',
  }[ratio] || '1024x1536';
  return { ratio, pixels };
}

/** OpenAI 兼容 /images/edits：size 必须是 WxH 像素；传 "9:16" 常被忽略并默认 1024x1024 */
function buildOpenAiEditSizeCandidates(aspect) {
  const { ratio, pixels } = resolveImageSizeParams(aspect);
  if (ratio === '1:1') return ['1024x1024'];
  const alt = {
    '3:4': ['1024x1536', '768x1024'],
    '4:3': ['1536x1024', '1024x768'],
    '5:7': ['1024x1434', '896x1254', '768x1075'],
    '7:5': ['1434x1024', '1254x896', '1075x768'],
    '9:16': ['1024x1792', '768x1344', '720x1280'],
    '16:9': ['1792x1024', '1344x768', '1280x720'],
  }[ratio] || [pixels];
  return [...new Set([pixels, ...alt])];
}

function targetAspectNumber(aspect) {
  return ({
    '1:1': 1,
    '3:4': 3 / 4,
    '4:3': 4 / 3,
    '5:7': 5 / 7,
    '7:5': 7 / 5,
    '9:16': 9 / 16,
    '16:9': 16 / 9,
  })[normalizeSelfieAspect(aspect)] || null;
}

/** 探测生成结果宽高比；无法探测时返回 null（不误杀） */
async function probeGeneratedImageAspect(result) {
  if (!result || typeof result !== 'string') return null;
  try {
    let buf = null;
    if (result.startsWith('data:')) {
      const b64 = result.split(',')[1] || '';
      if (!b64) return null;
      buf = Buffer.from(b64, 'base64');
    } else if (/^https?:\/\//i.test(result) || result.startsWith('/uploads/')) {
      if (result.startsWith('/uploads/')) {
        const localPath = path.join(__dirname, 'uploads', path.basename(result));
        if (fs.existsSync(localPath)) buf = fs.readFileSync(localPath);
      }
      if (!buf) {
        const abs = /^https?:\/\//i.test(result) ? result : toAbsoluteMediaUrl(result, '');
        const resp = await fetch(abs, { timeout: 30000 });
        if (!resp.ok) return null;
        buf = Buffer.from(await resp.arrayBuffer());
      }
    } else if (result.length > 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(result.slice(0, 120))) {
      buf = Buffer.from(result.replace(/\s/g, ''), 'base64');
    }
    if (!buf?.length) return null;
    const sharp = require('sharp');
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return null;
    return { w: meta.width, h: meta.height, ratio: meta.width / meta.height };
  } catch {
    return null;
  }
}

function generatedAspectMatches(measured, aspect, slack = 0.12) {
  const want = targetAspectNumber(aspect);
  if (!want || !measured?.ratio) return true;
  return Math.abs(measured.ratio - want) / want <= slack;
}

/** HiAPI 图像任务用的宽高比（与自拍比例对齐） */
function aspectToHiApiImageAspect(aspect) {
  const a = normalizeSelfieAspect(aspect || '3:4');
  // HiAPI 文档常见：1:1 / 4:5 / 3:4 / 9:16 / 16:9 等；3:4 直接传
  return a;
}

function isPrivateOrLocalMediaUrl(absUrl) {
  try {
    const u = new URL(String(absUrl || ''));
    let host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (host.startsWith('::ffff:')) host = host.slice(7);
    if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.localhost')) {
      return true;
    }
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  } catch {
    return /(?:^|\/\/)(?:localhost|127\.0\.0\.1)(?:[:/]|$)/i.test(String(absUrl || ''));
  }
}

function saveGeneratedImageLocally(buffer, ext = 'png') {
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const safeExt = /^(png|jpg|jpeg|webp)$/i.test(ext) ? ext.toLowerCase().replace('jpeg', 'jpg') : 'png';
  const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  return `/uploads/${filename}`;
}

/**
 * HiAPI 参考图：
 * - TinySnow 是 multipart 直接上传文件，本机路径就能用
 * - HiAPI 默认要「他们服务器能下载的 URL」；localhost/内网会失败
 * - 解决：内网或相对路径时，把本地图转成 data URI（base64）塞进 input，不依赖公网
 */
async function compressImageDataUrlForHiApi(dataUrl, maxBytes = 3.5 * 1024 * 1024) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return dataUrl;
  let buf = Buffer.from(m[2], 'base64');
  if (buf.length <= maxBytes) return dataUrl;
  try {
    const sharp = require('sharp');
    let quality = 88;
    let width = 1536;
    for (let i = 0; i < 6; i++) {
      const out = await sharp(buf)
        .rotate()
        .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (out.length <= maxBytes || (width <= 768 && quality <= 60)) {
        return `data:image/jpeg;base64,${out.toString('base64')}`;
      }
      buf = out;
      width = Math.max(768, Math.round(width * 0.75));
      quality = Math.max(55, quality - 8);
    }
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn('[hiapi] compress ref failed:', e.message);
    return dataUrl;
  }
}

async function resolvePublicInputUrlsForHiApi(referenceImageUrls, publicBase) {
  const refs = (Array.isArray(referenceImageUrls) ? referenceImageUrls : [referenceImageUrls])
    .filter(Boolean)
    .slice(0, 14);
  const out = [];
  for (const ref of refs) {
    const raw = String(ref).trim();
    let abs = raw;
    if (!/^https?:\/\//i.test(abs) && !abs.startsWith('data:')) {
      abs = toAbsoluteMediaUrl(abs, publicBase);
    }

    // 优先：能读到本地文件就转 data URI（等同 TinySnow 上传字节，不依赖 HiAPI 能否访问你的域名）
    const localCandidate = raw.startsWith('data:') ? raw : (raw.startsWith('/') ? raw : abs);
    const dataUrl = await resolveImageToBase64(localCandidate);
    if (dataUrl) {
      const compact = await compressImageDataUrlForHiApi(dataUrl);
      console.log(
        `[generateImage/hiapi] ref → data URI (~${Math.round(compact.length * 0.75 / 1024)}KB)`
      );
      out.push(compact);
      continue;
    }

    // 读不到本地：仅当是公网 https 才把 URL 交给 HiAPI 去拉
    if (/^https:\/\//i.test(abs) && !isPrivateOrLocalMediaUrl(abs)) {
      out.push(abs);
      continue;
    }

    _lastGenerateImageError = `参考图读取失败：${raw.slice(0, 80)}。请确认形象参考图已上传`;
    return null;
  }
  if (!out.length) {
    _lastGenerateImageError = '参考图读取失败，请确认形象参考图已上传且可访问';
    return null;
  }
  return out;
}

/**
 * HiAPI 统一任务生图：POST /v1/tasks → poll → 落盘
 * cfg: { url, key, model }；可带参考图（自拍）或不带（文生图）
 */
async function generateImageViaHiApiTasks(cfg, prompt, referenceImageUrls, taskOpts = {}) {
  if (!cfg?.url || !cfg?.key || !cfg?.model) return null;

  const refsRaw = (Array.isArray(referenceImageUrls) ? referenceImageUrls : [referenceImageUrls]).filter(Boolean);
  let inputUrls = [];
  if (refsRaw.length) {
    inputUrls = await resolvePublicInputUrlsForHiApi(refsRaw, taskOpts.publicBase || '');
    if (!inputUrls) return null;
  }

  const aspect = aspectToHiApiImageAspect(taskOpts.size || taskOpts.aspect || '3:4');
  const built = buildHiApiImageTaskInput(cfg.model, {
    prompt,
    referenceUrls: inputUrls,
    aspect,
  });

  if (built.refsUnsupported && taskOpts.requireReference) {
    _lastGenerateImageError = `模型「${cfg.model}」不支持参考图。自拍请改用 Nano-Banana-2 / Nano-Banana-Pro，或 gpt-image-2/image-to-image`;
    return null;
  }
  if (built.refsUnsupported && inputUrls.length) {
    console.warn(`[generateImage/hiapi] ${cfg.model} 不支持参考图，已降级为纯文生图`);
  }

  let input = built.input;
  const roots = [];
  const u = normalizeImageApiBase(cfg.url);
  if (u.endsWith('/v1')) roots.push(u);
  else roots.push(`${u}/v1`, u);

  let lastErr = '';
  for (const root of [...new Set(roots)]) {
    const endpoint = `${root}/tasks`;
    let attemptInput = { ...input };
    let aspectMode = 'aspect_ratio';
    applyHiApiAspectFieldMode(attemptInput, aspect, aspectMode);
    let refRetries = 0;
    try {
      while (refRetries < 8) {
        console.log(
          `[generateImage/hiapi] ${endpoint} model=${cfg.model} aspect=${aspect} mode=${aspectMode} refs=${inputUrls.length}`
          + (attemptInput.image_input ? ' field=image_input'
            : attemptInput.image_urls ? ' field=image_urls'
              : attemptInput.input_urls ? ' field=input_urls' : '')
        );
        let resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: cfg.model, input: attemptInput }),
          timeout: 60000,
        });
        let raw = await resp.text().catch(() => '');
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }

        const errText = String(data?.message || data?.error?.message || raw || '');
        const rejectExtra = /additional properties?\s+'([^']+)'\s+not allowed/i.exec(errText);
        if (!resp.ok && rejectExtra) {
          const badKey = rejectExtra[1];
          if (badKey && Object.prototype.hasOwnProperty.call(attemptInput, badKey)) {
            // 比例字段被拒：换下一种传法，禁止裸删后默认出 1:1
            if (isHiApiAspectFieldName(badKey)) {
              const nextMode = nextHiApiAspectMode(aspectMode);
              console.warn(`[generateImage/hiapi] aspect field "${badKey}" rejected → try ${nextMode || 'abort'}`);
              if (!nextMode) {
                lastErr = `模型不接受比例字段，且已无替代传法（目标 ${aspect}）`;
                break;
              }
              aspectMode = nextMode;
              applyHiApiAspectFieldMode(attemptInput, aspect, aspectMode);
              refRetries++;
              continue;
            }
            console.warn(`[generateImage/hiapi] drop unsupported field: ${badKey}`);
            delete attemptInput[badKey];
            refRetries++;
            continue;
          }
        }

        // 参考图字段名不对：换 image_input / image_urls / input_urls 再试
        const needRefRemap = !resp.ok && inputUrls.length && (
          /input_urls|image_input|image_urls|reference/i.test(errText)
          || /required property/i.test(errText)
        );
        if (needRefRemap && rotateHiApiImageRefField(attemptInput)) {
          console.warn('[generateImage/hiapi] retry with alternate ref field');
          // 换参考字段后重新挂上比例，避免被之前的删除搞丢
          applyHiApiAspectFieldMode(attemptInput, aspect, aspectMode);
          refRetries++;
          continue;
        }

        if (!resp.ok) {
          lastErr = formatImageGenApiError(`HTTP ${resp.status}: ${raw.slice(0, 400)}`)
            || data?.message || `HiAPI 生图创建任务失败 HTTP ${resp.status}`;
          console.error('[generateImage/hiapi]', endpoint, lastErr);
          break;
        }
        const taskId = data?.data?.taskId || data?.taskId || data?.data?.id || data?.id;
        if (!taskId) {
          lastErr = `HiAPI 未返回 taskId: ${raw.slice(0, 200)}`;
          break;
        }
        const polled = await pollHiApiTask(cfg, taskId, {
          maxWaitMs: IMAGE_GEN_MAX_WAIT_MS,
          intervalMs: 3000,
          media: 'image',
        });
        if (!polled?.localUrl) {
          lastErr = _lastGenerateImageError || _lastGenerateVideoError || 'HiAPI 生图任务失败';
          break;
        }
        _lastGenerateImageMeta = {
          usedReference: inputUrls.length > 0 && !built.refsUnsupported,
          model: cfg.model,
          mode: 'hiapi/tasks',
          refLoaded: inputUrls.length > 0,
          refCount: inputUrls.length,
          aspect,
          aspectMode,
        };
        _lastGenerateImageError = '';
        return polled.localUrl;
      }
    } catch (e) {
      lastErr = e.message || String(e);
      console.error('[generateImage/hiapi]', endpoint, lastErr);
    }
  }
  _lastGenerateImageError = lastErr || 'HiAPI 生图失败';
  return null;
}

/**
 * HiAPI 兼容图生图（img2img_* 配置）：POST /v1/tasks
 */
async function generateImageViaHiApi(settings, prompt, referenceImageUrls, taskOpts = {}) {
  const cfg = resolveImg2ImgConfig(settings);
  if (!cfg) return null;
  const hiCfg = {
    ...cfg,
    model: img2ImgModelForProtocol(cfg.model, 'hiapi'),
    hiapi: true,
  };
  return generateImageViaHiApiTasks(hiCfg, prompt, referenceImageUrls, {
    ...taskOpts,
    requireReference: true,
  });
}

/**
 * OpenAI 兼容图生图：POST /v1/images/edits（multipart）
 * TinySnow 及同类中转支持单图/多图参考。
 */
async function generateImageViaOpenAiEdits(settings, prompt, referenceImageUrls, taskOpts = {}) {
  const baseCfg = resolveImg2ImgConfig(settings);
  if (!baseCfg) return null;
  const cfg = {
    ...baseCfg,
    model: img2ImgModelForProtocol(baseCfg.model, 'openai-edits'),
  };

  const refs = (Array.isArray(referenceImageUrls) ? referenceImageUrls : [referenceImageUrls])
    .filter(Boolean)
    .slice(0, 5);
  if (!refs.length) {
    _lastGenerateImageError = '图生图需要至少一张参考图';
    return null;
  }

  const parts = [];
  for (const ref of refs) {
    const part = await loadImageAsUploadPart(ref);
    if (part) parts.push(part);
  }
  if (!parts.length) {
    _lastGenerateImageError = '参考图读取失败，请确认形象参考图已上传且可访问';
    return null;
  }

  const { ratio, pixels } = resolveImageSizeParams(taskOpts.size || taskOpts.aspect || '3:4');
  // OpenAI edits：size 必须用 WxH。先传 "9:16" 会被忽略并默认方图（还 HTTP 200），
  // 所以只走像素候选，成功后还要核对照片比例。
  const sizeCandidates = buildOpenAiEditSizeCandidates(ratio);

  const FormData = require('form-data');
  let lastErr = '';
  let wrongAspectHit = false;
  for (const endpoint of buildImageEditEndpoints(cfg.url)) {
    for (const sizeVal of sizeCandidates) {
      try {
        const form = new FormData();
        form.append('model', cfg.model);
        form.append('prompt', String(prompt || '').trim() || 'portrait selfie, same person as reference');
        form.append('n', '1');
        form.append('size', sizeVal);
        form.append('response_format', 'b64_json');
        parts.forEach((p, i) => {
          form.append('image', p.buffer, {
            filename: `ref${i + 1}.${p.ext}`,
            contentType: p.contentType,
          });
        });

        console.log(`[generateImage/img2img] ${endpoint} model=${cfg.model} size=${sizeVal} want=${ratio} refs=${parts.length}`);
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.key}`, ...form.getHeaders() },
          body: form,
          timeout: IMAGE_GEN_MAX_WAIT_MS,
        });
        const raw = await resp.text().catch(() => '');
        if (!resp.ok) {
          lastErr = formatImageGenApiError(`HTTP ${resp.status}: ${raw.slice(0, 300)}`)
            || `图生图失败 HTTP ${resp.status}`;
          console.error('[generateImage/img2img]', endpoint, sizeVal, lastErr);
          continue;
        }
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          lastErr = `图生图返回非 JSON：${raw.slice(0, 200)}`;
          console.error('[generateImage/img2img]', endpoint, lastErr);
          continue;
        }
        const result = extractImageResultFromApiData(data);
        if (!result) {
          lastErr = `图生图返回空/格式不匹配: ${JSON.stringify(data).slice(0, 300)}`;
          console.error('[generateImage/img2img]', endpoint, lastErr);
          continue;
        }
        const measured = await probeGeneratedImageAspect(result);
        if (measured && !generatedAspectMatches(measured, ratio)) {
          wrongAspectHit = true;
          console.warn(
            `[generateImage/img2img] size=${sizeVal} 返回 ${measured.w}x${measured.h}，与目标 ${ratio} 不符，继续试下一档`
          );
          lastErr = `图生图返回 ${measured.w}x${measured.h}，不是设定的 ${ratio}`;
          continue;
        }
        if (measured) {
          console.log(`[generateImage/img2img] ok ${measured.w}x${measured.h} (~${ratio})`);
        }
        _lastGenerateImageMeta = {
          usedReference: true,
          model: cfg.model,
          mode: 'images/edits',
          refLoaded: true,
          refCount: parts.length,
          aspect: ratio,
          size: sizeVal,
          width: measured?.w || 0,
          height: measured?.h || 0,
        };
        _lastGenerateImageError = '';
        return result;
      } catch (e) {
        lastErr = e.message || String(e);
        console.error('[generateImage/img2img]', endpoint, lastErr);
        // 超时说明对方可能已接单在画，换尺寸/换端点会再扣一次费
        if (isImageGenWaitTimeoutError(lastErr)) break;
      }
    }
    if (isImageGenWaitTimeoutError(lastErr)) break;
  }
  _lastGenerateImageError = lastErr
    || (wrongAspectHit
      ? `图生图中转似乎忽略了非方尺寸（目标 ${ratio}）。请确认该站 gpt-image 支持 size=${pixels}`
      : '图生图 API 调用失败');
  return null;
}

/**
 * 图生图入口：按 URL/模型自动选协议，失败且像「接口不对」时换另一种再试。
 */
async function generateImageViaEdits(settings, prompt, referenceImageUrls, taskOpts = {}) {
  const cfg = resolveImg2ImgConfig(settings);
  if (!cfg) return null;
  const protocol = cfg.protocol || detectImg2ImgProtocol(cfg.url, cfg.model);
  const order = img2ImgProtocolOrder(protocol);
  let lastErr = '';

  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    console.log(`[generateImage/img2img] try protocol=${p} (${i + 1}/${order.length}) url=${cfg.url} model=${cfg.model}`);
    let result = null;
    if (p === 'hiapi') {
      result = await generateImageViaHiApi(settings, prompt, referenceImageUrls, taskOpts);
    } else if (p === '80ai') {
      const refs = (Array.isArray(referenceImageUrls) ? referenceImageUrls : [referenceImageUrls]).filter(Boolean);
      result = await generateImageVia80Ai({
        ...settings,
        image_api_url: cfg.url,
        image_api_key: cfg.key,
        image_model: img2ImgModelForProtocol(cfg.model, '80ai'),
      }, prompt, refs, taskOpts);
    } else {
      result = await generateImageViaOpenAiEdits(settings, prompt, referenceImageUrls, taskOpts);
    }
    if (result) return result;
    lastErr = _lastGenerateImageError || lastErr;
    if (isImageGenWaitTimeoutError(lastErr)) break;
    if (!shouldTryNextMediaProtocol(lastErr, protocol, i === order.length - 1)) break;
    console.warn(`[generateImage/img2img] ${p} 未通，换协议再试: ${(lastErr || '').slice(0, 120)}`);
  }
  if (lastErr) _lastGenerateImageError = lastErr;
  return null;
}

let _lastGenerateImageError = '';
let _lastGenerateImageMeta = { usedReference: false, model: '', mode: '', refLoaded: false };

function getLastGenerateImageError() {
  const raw = _lastGenerateImageError || '';
  if (!raw) return '';
  if (isApiBillingError(raw)) return formatApiBillingError(raw, { label: '图像 API' });
  return raw;
}

function getLastGenerateImageMeta() {
  return { ..._lastGenerateImageMeta };
}

const CHAT_LIKE_MODEL_RE = /minimax|gpt-4|gpt-3|claude|gemini|deepseek|qwen|llama|mistral|grok|o1|o3|o4|highspeed|turbo/i;
const IMAGE_GEN_MODEL_RE = /dall|gpt-image|imagen|flux|stable|sdxl|midjourney|recraft|ideogram|kling.*image|seedream|gptimage|banana/i;

function is80AiImageApi(url) {
  return looksLike80AiUrl(url);
}

function normalize80AiBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/v1\/images\/generations$/i, '');
  u = u.replace(/\/images\/generations$/i, '');
  u = u.replace(/\/v1$/i, '');
  u = u.replace(/\/api\/config\/(?:task-scenes|generation-models)$/i, '');
  return u;
}

/** 80ai / Banana Web：GET /api/config/generation-models 或 task-scenes */
async function fetch80AiImageModels(baseUrl) {
  const root = normalize80AiBase(baseUrl);
  const endpoints = [
    `${root}/api/config/task-scenes`,
    `${root}/api/config/generation-models`,
  ];
  let lastErr = '';
  for (const endpoint of endpoints) {
    try {
      const { resp, raw } = await fetch80AiRequest(endpoint, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 20000,
      }, 2);
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}: ${raw.slice(0, 120)}`;
        continue;
      }
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;
      const models = [...new Set(data.map(item => item.model_key || item.scene_key).filter(Boolean))];
      if (models.length) return models.sort();
    } catch (e) {
      lastErr = format80AiNetworkError(e);
    }
  }
  throw new Error(lastErr || '80ai 模型列表为空，请确认地址为 https://api.80ai.net');
}

/** 80ai 网站显示名 ↔ API model_key；用户填「Image 2」等也能识别 */
const EIGHTY_AI_MODEL_ALIASES = {
  image: 'gptimage2_medium',
  image2: 'gptimage2_medium',
  'image2高质量': 'gptimage2_medium',
  'image2顶级': 'gptimage2_high',
  'image2性价比': 'gptimage2_low',
  gptimage2: 'gptimage2_medium',
  banana: 'banana',
  banana2: 'banana2',
  nanobanana: 'banana',
  nanobanana2: 'banana2',
  nanobananapro: 'banana_pro',
};

function normalize80AiModelInput(raw) {
  let model = String(raw || '').trim();
  if (!model) return 'gptimage2_medium';
  model = model.replace(/_edit$/i, '');
  if (/^(gptimage2|banana)/i.test(model)) return model;
  const key = model.toLowerCase().replace(/[\s_\-（）()【】]/g, '');
  return EIGHTY_AI_MODEL_ALIASES[key] || model;
}

async function fetch80AiImageModelOptions(baseUrl) {
  const root = normalize80AiBase(baseUrl);
  const endpoints = [
    `${root}/api/config/generation-models`,
    `${root}/api/config/task-scenes`,
  ];
  let lastErr = '';
  for (const endpoint of endpoints) {
    try {
      const { resp, raw } = await fetch80AiRequest(endpoint, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 20000,
      }, 2);
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}: ${raw.slice(0, 120)}`;
        continue;
      }
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;
      const seen = new Set();
      const options = [];
      for (const item of data) {
        const key = item.model_key || item.scene_key;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const label = String(item.model_label || item.scene_label || item.display_name || '').replace(/[^\u0000-\uFFFF\w\s（）()\-·⚡️🍌]/g, '').trim();
        options.push({
          key,
          label,
          maxReferenceImages: item.max_reference_images ?? 0,
          sceneType: item.scene_type || 'generate',
        });
      }
      if (options.length) return options.sort((a, b) => a.key.localeCompare(b.key));
    } catch (e) {
      lastErr = format80AiNetworkError(e);
    }
  }
  throw new Error(lastErr || '80ai 模型列表为空');
}

function resolve80AiModel(settings, referenceImageUrl) {
  const base = normalize80AiModelInput(settings.image_model);
  if (referenceImageUrl) {
    const model = /_edit$/i.test(base) ? base : `${base}_edit`;
    return { model, mode: 'image_edit', useReferenceImages: true };
  }
  return { model: base.replace(/_edit$/i, ''), mode: 'generate', useReferenceImages: false };
}

/** 带参考图时依次尝试的 image_edit 模型（generate 模式 max_reference_images=0，附带参考图会报 model 无效） */
function get80AiRefEditModelCandidates(settings) {
  const base = normalize80AiModelInput(settings.image_model).replace(/_edit$/i, '');
  const gpt = ['gptimage2_medium', 'gptimage2_high', 'gptimage2_low'];
  const banana = ['banana2', 'banana_pro', 'banana'];
  let bases = [];
  if (/^gptimage2/i.test(base)) bases = [base, ...gpt.filter(m => m !== base)];
  else if (/^banana/i.test(base)) bases = [base, ...banana.filter(m => m !== base)];
  else bases = [...gpt, ...banana];
  return [...new Set(bases.map(m => `${m}_edit`))];
}

function extract80AiImageUrl(task) {
  if (!task) return null;
  const images = task.images || [];
  for (const img of images) {
    const url = img?.image_url || img?.preview_url;
    if (url && img?.status !== 'failed') return url;
  }
  return task.image_url || null;
}

/**
 * 将图片 URL 转成 base64 data URL。
 * - data URL → 原样返回
 * - /uploads/... 或 http://localhost/uploads/... → 直接读本地文件（避免自连接 TLS 问题）
 * - 其他外部 URL → fetch 后转 base64
 */
async function resolveImageToBase64(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  if (imageUrl.startsWith('data:')) return imageUrl;

  const UPLOADS_DIR = path.join(__dirname, 'uploads');

  const tryLocalUploads = (pathname) => {
    if (!pathname || !pathname.startsWith('/uploads/')) return null;
    const localPath = path.join(UPLOADS_DIR, pathname.slice('/uploads/'.length));
    if (!fs.existsSync(localPath)) return null;
    const buf = fs.readFileSync(localPath);
    const ext = path.extname(localPath).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  };

  if (imageUrl.startsWith('/uploads/')) {
    const local = tryLocalUploads(imageUrl);
    if (local) return local;
  }

  try {
    const u = new URL(imageUrl);
    const local = tryLocalUploads(u.pathname);
    if (local) return local;
  } catch {}

  try {
    const resp = await fetch(imageUrl, { timeout: 15000 });
    if (resp.ok) {
      const buf = await resp.buffer();
      const ct = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      return `data:${ct};base64,${buf.toString('base64')}`;
    }
  } catch (e) {
    console.warn('[resolveImageToBase64] fetch failed:', e.message);
  }
  return null;
}

function parse80AiErrorDetail(raw, status) {
  try {
    const j = JSON.parse(raw);
    let detail = j.detail ?? j.error ?? j.message;
    if (Array.isArray(detail)) {
      return detail.map(d => (typeof d === 'string' ? d : d.msg || JSON.stringify(d))).join('; ');
    }
    if (detail && typeof detail === 'object') return JSON.stringify(detail);
    if (detail) return String(detail);
  } catch {}
  return String(raw || '').slice(0, 300) || `HTTP ${status}`;
}

/** 80ai：POST /api/tasks（非 OpenAI /v1/images/generations） */
async function post80AiImageTask(settings, prompt, referenceImageUrl, model, taskOpts = {}) {
  const root = normalize80AiBase(settings.image_api_url);
  const apiKey = String(settings.image_api_key || '').trim();
  const mode = taskOpts.mode || 'generate';
  const body = {
    prompt: String(prompt || '').trim(),
    model,
    mode,
    // 必须跟角色「图片比例」一致；缺省竖图，禁止默默掉回 1:1
    size: resolveRequestAspect(taskOpts, '3:4'),
    resolution: '1K',
    source: 'api',
  };
  let sentReference = false;
  const refUrls = (Array.isArray(referenceImageUrl)
    ? referenceImageUrl
    : (referenceImageUrl ? [referenceImageUrl] : [])
  ).filter(Boolean).slice(0, 5);
  if (refUrls.length) {
    const imgs = [];
    for (const ref of refUrls) {
      const base64Img = await resolveImageToBase64(ref);
      if (base64Img) imgs.push(base64Img);
    }
    if (imgs.length) {
      body.reference_images = imgs;
      sentReference = true;
      const approxKb = Math.round(imgs.reduce((s, b) => s + b.length, 0) * 3 / 4 / 1024);
      console.log(`[generateImage/80ai] ${model} (${mode}) 已附 ${imgs.length} 张参考图 (~${approxKb}KB)`);
    } else {
      _lastGenerateImageError = `参考图读取失败。请确认图片已上传且在 backend/uploads/ 目录存在`;
      console.error('[generateImage/80ai]', _lastGenerateImageError);
      return null;
    }
  }

  try {
    const { resp, raw } = await fetch80AiRequest(`${root}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs: IMAGE_GEN_MAX_WAIT_MS,
    }, 0);
    if (!resp.ok) {
      const errMsg = parse80AiErrorDetail(raw, resp.status);
      _lastGenerateImageError = formatImageGenApiError(`HTTP ${resp.status}: ${errMsg}`)
        || `80ai 生图失败 HTTP ${resp.status}`;
      console.error('[generateImage/80ai]', model, mode, _lastGenerateImageError);
      return null;
    }
    const ct = resp.headers.get('content-type') || '';
    if (raw && !ct.includes('application/json') && !/^\s*[\[{]/.test(raw)) {
      const snippet = raw.trim().slice(0, 200);
      _lastGenerateImageError = snippet.startsWith('<')
        ? '80ai 返回了网页而非 JSON，请确认 Base URL 为 https://api.80ai.net 且 API Key 有效'
        : `80ai 返回非 JSON：${snippet || '(空响应)'}`;
      console.error('[generateImage/80ai]', model, _lastGenerateImageError);
      return null;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const snippet = raw.trim().slice(0, 200);
      _lastGenerateImageError = snippet
        ? `80ai 返回非 JSON：${snippet}`
        : '80ai 返回空响应，请检查 API Key 与账户积分';
      console.error('[generateImage/80ai]', model, _lastGenerateImageError);
      return null;
    }
    const tasks = Array.isArray(data) ? data : [data];
    for (const task of tasks) {
      const url = extract80AiImageUrl(task);
      if (url) {
        _lastGenerateImageMeta = { usedReference: sentReference, model, mode, refLoaded: sentReference };
        return url;
      }
      if (task?.status === 'failed') {
        _lastGenerateImageError = task.error_message || '80ai 任务失败';
        return null;
      }
    }
    const pending = tasks.find(t => /pending|processing|queued|running|waiting|in_progress|submitted/i.test(String(t?.status || '')))
      || tasks[0];
    const resolved = await finalize80AiTaskResponse(settings, pending, { want: 'image' });
    if (resolved) {
      _lastGenerateImageMeta = { usedReference: sentReference, model, mode, refLoaded: sentReference };
      return resolved;
    }
    if (!_lastGenerateImageError) {
      _lastGenerateImageError = tasks[0]?.error_message || '80ai 未返回图片 URL';
    }
    return null;
  } catch (e) {
    _lastGenerateImageError = format80AiNetworkError(e);
    console.error('[generateImage/80ai]', model, e.message);
    return null;
  }
}

function is80AiEditBlockedError(msg) {
  return /局部重绘|image_edit|暂不开放/i.test(String(msg || ''));
}

function is80AiRefRetryableError(msg) {
  return /model.*无效|invalid model|reference|参考|reference_images|不支持|validation|422/i.test(String(msg || ''));
}

async function generateImageVia80Ai(settings, prompt, referenceImageUrl = null, options = {}) {
  const aspect = options.aspect || options.size;
  const refUrls = (Array.isArray(referenceImageUrl)
    ? referenceImageUrl
    : (referenceImageUrl ? [referenceImageUrl] : [])
  ).filter(Boolean).slice(0, 5);
  if (!refUrls.length) {
    const { model, mode } = resolve80AiModel(settings, null);
    const url = await post80AiImageTask(settings, prompt, null, model, { mode, aspect });
    if (url) _lastGenerateImageMeta = { usedReference: false, model, mode, refLoaded: false };
    return url;
  }

  const models = get80AiRefEditModelCandidates(settings);
  if (!models.length) {
    _lastGenerateImageError = '当前模型不支持 80ai 参考图（image_edit），请在设置里改用 gptimage2_medium';
    return null;
  }
  let lastErr = '';
  let editBlocked = false;
  for (const model of models) {
    const url = await post80AiImageTask(settings, prompt, refUrls, model, { mode: 'image_edit', aspect });
    if (url) {
      if (model !== models[0]) {
        console.warn(`[generateImage/80ai] 参考图生图：${models[0]} 不可用，已改用 ${model}`);
      }
      return url;
    }
    lastErr = _lastGenerateImageError || '';
    if (is80AiEditBlockedError(lastErr)) {
      editBlocked = true;
      break;
    }
    if (!is80AiRefRetryableError(lastErr)) break;
  }
  if (editBlocked) {
    _lastGenerateImageError = '80ai Open API 暂未开放参考图生图（image_edit / 局部重绘）。网页端上传参考图可用，但 API 目前不行。纯文生图请用设置里的「测试生图」（不带参考图）；自拍只能先直接发参考图或换支持 img2img 的中转站。';
  } else {
    _lastGenerateImageError = lastErr || '参考图生图失败。设置里填 gptimage2_medium 即可，带参考图时系统会自动用 gptimage2_medium_edit + image_edit';
  }
  _lastGenerateImageMeta = { usedReference: false, model: models[0] || '', mode: 'image_edit', refLoaded: false };
  return null;
}

function isValidImageGenModel(model) {
  const m = String(model || '').trim();
  if (!m) return true;
  if (/^(gptimage|banana)/i.test(m)) return true;
  if (CHAT_LIKE_MODEL_RE.test(m) && !IMAGE_GEN_MODEL_RE.test(m)) return false;
  return IMAGE_GEN_MODEL_RE.test(m);
}

function formatImageGenApiError(raw) {
  const text = String(raw || '');
  let msg = text;
  try {
    const jsonPart = text.replace(/^HTTP \d+:\s*/, '');
    const j = JSON.parse(jsonPart);
    msg = j.error?.message || j.message || text;
  } catch {}
  if (isApiBillingError(msg) || isApiBillingError(text)) {
    return formatApiBillingError(msg || text, { label: '图像 API' });
  }
  if (/only imagen models/i.test(msg)) {
    return '当前中转站（如 linkapi.ai）只支持 Imagen 生图模型，请在设置→图像生成里把模型改为 imagen-3.0-generate-001 或 imagen-3.0-fast-generate-001，勿填 dall-e-3 / gpt-image-1 / 聊天模型';
  }
  if (/not supported model for image generation/i.test(msg)) {
    return `生图模型不被该 API 支持：${msg}。请确认设置里填的是文生图模型（linkapi 仅 Imagen 系列）`;
  }
  if (/model.*无效|模型无效|invalid model/i.test(msg)) {
    return `${msg.slice(0, 200)}。常见原因：① 模型名填错（Image 2 高质量 = gptimage2_medium）；② 文生图 generate 模式不能附带参考图（会误报 model 无效），自拍参考图须走 image_edit（系统已自动切到 gptimage2_medium_edit）`;
  }
  if (/局部重绘|image_edit|暂不开放/i.test(msg)) {
    return '80ai Open API 暂未开放参考图生图（image_edit）。网页端可用，API 暂不行。纯文生图（设置→测试生图）仍可用 gptimage2_medium；自拍参考图需等 80ai 开放 API 或换其他 img2img 中转站';
  }
  if (/ECONNRESET|read ECONNRESET|socket hang up|Premature close/i.test(msg)) {
    return format80AiNetworkError(msg);
  }
  return msg.slice(0, 400);
}

function resolveImageGenModel(settings) {
  const raw = (settings.image_model || '').trim();
  const baseUrl = (settings.image_api_url || '').trim();
  if (is80AiImageApi(baseUrl)) {
    return normalize80AiModelInput(raw);
  }
  if (!raw) {
    if (/linkapi\.ai/i.test(baseUrl)) {
      _lastGenerateImageError = 'linkapi.ai 须填写 Imagen 模型，如 imagen-3.0-generate-001';
    }
    return '';
  }
  if (/linkapi\.ai/i.test(baseUrl) && !/imagen/i.test(raw)) {
    console.warn('[generateImage] linkapi 仅支持 imagen 模型:', raw);
    _lastGenerateImageError = `linkapi.ai 只支持 Imagen 生图，当前「${raw}」不可用，请改为 imagen-3.0-generate-001 等`;
    return '';
  }
  if (isValidImageGenModel(raw)) return raw;
  console.warn('[generateImage] image_model 不是文生图模型，已忽略:', raw);
  _lastGenerateImageError = `图像模型「${raw}」不是文生图模型（聊天模型不能用于生图）。分享风景/美食请用 Unsplash；自拍请填写 imagen、dall-e-3、gpt-image-1 等`;
  return '';
}

// generateImage: 纯文生图走 image_api_*；有参考图优先走独立图生图 API（img2img_*）
async function generateImage(settings, prompt, referenceImageUrl = null, options = {}) {
  _lastGenerateImageError = '';
  _lastGenerateImageMeta = { usedReference: false, model: '', mode: '', refLoaded: false };
  const aspect = resolveRequestAspect(options, '3:4');
  options = { ...options, aspect, size: aspect };
  console.log('[generateImage] aspect=', aspect, 'refs=', !!(referenceImageUrl || options.referenceImages?.length));
  const aspectBit = aspectPromptConstraint(aspect);
  let workPromptBase = String(prompt || '').trim();
  if (workPromptBase && !/aspect ratio|9:16|3:4|16:9|1:1|strict vertical|strict horizontal/i.test(workPromptBase)) {
    workPromptBase = `${workPromptBase}, ${aspectBit}`;
  }
  prompt = workPromptBase;
  settings = routeSettingsForMediaGen(settings);
  const requireReference = options.requireReference === true;
  const refList = (Array.isArray(options.referenceImages) && options.referenceImages.length
    ? options.referenceImages
    : (referenceImageUrl ? [referenceImageUrl] : [])
  ).filter(Boolean);

  // 有参考图且配置了图生图 API → 自动识别 /images/edits、/v1/tasks、80ai
  if (refList.length && resolveImg2ImgConfig(settings)) {
    const edited = await generateImageViaEdits(settings, prompt, refList, {
      aspect: options.aspect || options.size,
      publicBase: options.publicBase || options.reqBase || '',
    });
    if (edited) return edited;
    if (requireReference) {
      if (!_lastGenerateImageError) {
        _lastGenerateImageError = '图生图失败：参考图未能生效（请检查图生图 API 地址、Key 与模型）';
      }
      return null;
    }
    console.warn('[generateImage] 独立图生图失败，不再静默改为纯文生图:', (_lastGenerateImageError || '').slice(0, 120));
    return null;
  }

  const url = (settings.image_api_url || '').trim();
  const apiKey = (settings.image_api_key || '').trim();
  if (!url || !apiKey) {
    if (!refList.length) {
      const viaImg2 = await generateImageViaImg2ImgTextFallback(settings, prompt, { ...options, afterMainImageFailure: true });
      if (viaImg2) return viaImg2;
    }
    _lastGenerateImageError = refList.length
      ? '请先在设置中填写「图生图 API」（自拍参考图）或「图像生成 API」'
      : '请先在设置中填写图像生成 API 地址和 Key（或配置图生图 API 作兜底）';
    return null;
  }

  if (is80AiImageApi(url)) {
    const aspectOpt = { aspect: options.aspect || options.size };
    if (refList.length) {
      const withRef = await generateImageVia80Ai(settings, prompt, refList, aspectOpt);
      if (withRef) return withRef;
      if (requireReference) {
        if (!_lastGenerateImageError) {
          _lastGenerateImageError = '参考图未能传入 80ai API，未生成图片（避免只按 prompt 瞎画一张不像的人）';
        }
        return null;
      }
      console.warn('[generateImage/80ai] 参考图生图失败，不再静默改为纯文生图:', (_lastGenerateImageError || '').slice(0, 120));
      return null;
    }
    const via80 = await generateImageVia80Ai(settings, prompt, null, aspectOpt);
    if (via80) return via80;
    const viaImg2 = await generateImageViaImg2ImgTextFallback(settings, prompt, { ...options, afterMainImageFailure: true });
    if (viaImg2) return viaImg2;
    return null;
  }

  // HiAPI 文生图 / 可选参考图：走 /v1/tasks（不是 OpenAI /images/generations）
  const hiapiImg = resolveHiApiImageApiConfig(settings, { preferImg2Img: refList.length > 0 });
  if (hiapiImg) {
    const viaHi = await generateImageViaHiApiTasks(hiapiImg, prompt, refList, {
      aspect: options.aspect || options.size,
      publicBase: options.publicBase || options.reqBase || '',
      requireReference,
    });
    if (viaHi) return viaHi;
    if (requireReference || refList.length) return null;
    // 纯文生图失败：尝试图生图栏的 Key 再出一张（无参考图）
    const viaImg2 = await generateImageViaImg2ImgTextFallback(settings, prompt, { ...options, afterMainImageFailure: true });
    if (viaImg2) return viaImg2;
    return null;
  }

  const baseUrl = normalizeImageApiBase(url);
  let workPrompt = String(prompt || '');

  // 未配置独立图生图时：有参考图先尝试 /images/variations（兼容旧中转）
  if (refList.length) {
    try {
      const FormData = require('form-data');
      const imgResp = await fetch(refList[0], { timeout: 15000 });
      if (imgResp.ok) {
        const imgBuffer = await imgResp.buffer();
        const form = new FormData();
        form.append('image', imgBuffer, { filename: 'ref.png', contentType: 'image/png' });
        form.append('n', '1');
        // 之前写死 1024x1024，角色配的 9:16/3:4 等比例全部被忽略、自拍永远出正方形；
        // 官方 DALL-E-2 variations 接口确实只认方图，但很多「旧中转」实际支持任意比例，改成按配置尝试
        form.append('size', resolveImageSizeParams(resolveRequestAspect(options, '3:4')).pixels);
        for (const varEndpoint of buildImageVariationEndpoints(baseUrl)) {
          const varResp = await fetch(varEndpoint, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() },
            body: form,
            timeout: 60000,
          });
          if (!varResp.ok) continue;
          const ct = varResp.headers.get('content-type') || '';
          if (!ct.includes('application/json')) continue;
          const varData = await varResp.json();
          const varUrl = extractImageResultFromApiData(varData);
          if (varUrl) {
            _lastGenerateImageMeta = {
              usedReference: true,
              model: settings.image_model || '',
              mode: 'images/variations',
              refLoaded: true,
              refCount: 1,
            };
            return varUrl;
          }
        }
      }
    } catch (e) {
      console.error('[img variation]', e.message);
    }
    if (requireReference) {
      _lastGenerateImageError = _lastGenerateImageError
        || '参考图生图失败。请在设置里配置「图生图 API」（OpenAI / HiAPI / 80ai 均可）';
      return null;
    }
    // variation 失败且非强制参考图：降级文生图（仅加文字提示，不保证像）
    workPrompt = `${workPrompt}, same character appearance as reference`;
  }

  // 标准文生图，自动尝试 /images/generations 和 /v1/images/generations
  const imgModel = resolveImageGenModel(settings);
  if ((settings.image_model || '').trim() && !imgModel) {
    return null;
  }
  const { pixels, ratio } = resolveImageSizeParams(resolveRequestAspect(options, '3:4'));
  const imgBody = { prompt: workPrompt, n: 1, size: pixels };
  // 部分中转同时认 ratio 字符串
  if (ratio && ratio !== pixels) imgBody.aspect_ratio = ratio;
  if (imgModel) imgBody.model = imgModel;

  const imgHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  const candidates = buildImageGenerationEndpoints(baseUrl);

  let lastErr = '';
  for (const endpoint of candidates) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: imgHeaders,
        body: JSON.stringify(imgBody),
        timeout: IMAGE_GEN_MAX_WAIT_MS,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        lastErr = formatImageGenApiError(`HTTP ${resp.status}: ${errText.slice(0, 300)}`);
        console.error('[generateImage]', endpoint, lastErr);
        continue;
      }
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const hint = baseUrl.endsWith('/v1')
          ? '请确认该中转站支持 OpenAI 格式 /v1/images/generations，且模型支持文生图'
          : 'Base URL 请填写带 /v1 的地址，例如 https://linkapi.ai/v1';
        lastErr = `非JSON响应 (${ct})，${hint}`;
        console.error('[generateImage]', endpoint, lastErr);
        continue;
      }
      const data = await resp.json();
      console.log('[generateImage] raw response:', JSON.stringify(data).slice(0, 500));
      const result = extractImageResultFromApiData(data);
      if (result) {
        _lastGenerateImageMeta = {
          usedReference: false,
          model: imgModel || '',
          mode: 'images/generations',
          refLoaded: false,
        };
        return result;
      }
      lastErr = `API返回空/格式不匹配: ${JSON.stringify(data).slice(0, 300)}`;
      console.error('[generateImage]', endpoint, lastErr);
    } catch (e) {
      lastErr = e.message;
      console.error('[generateImage]', endpoint, e.message);
      if (isImageGenWaitTimeoutError(lastErr)) break;
    }
  }
  console.error('[generateImage] 所有端点均失败:', lastErr);
  _lastGenerateImageError = formatImageGenApiError(lastErr) || '所有端点均失败';
  if (!refList.length && !isImageGenWaitTimeoutError(lastErr)) {
    const viaImg2 = await generateImageViaImg2ImgTextFallback(settings, prompt, { ...options, afterMainImageFailure: true });
    if (viaImg2) return viaImg2;
  }
  return null;
}

/** 配图/配视频/自拍指令行前缀（含英文别名） */
const MEDIA_DIR_PREFIX_RE = '(?:配图|配视频|自拍|IMAGE|VIDEO|SELFIE)';

/**
 * 模型常把「自拍：」单独一行、描述另起一行 → 拼回「自拍：描述」。
 * 拆气泡前不拼的话，前缀行剥不掉、描述当正文露出，且往往触发生不成图。
 */
function normalizeMediaDirectiveLines(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const barePrefix = new RegExp(`^\\s*${MEDIA_DIR_PREFIX_RE}[：:]\\s*$`, 'i');
  const anyPrefix = new RegExp(`^\\s*${MEDIA_DIR_PREFIX_RE}[：:]`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bare = line.match(barePrefix);
    if (bare && i + 1 < lines.length) {
      const next = String(lines[i + 1] || '').trim();
      if (next && !anyPrefix.test(next)) {
        out.push(`${bare[0].replace(/\s*$/, '')}${next}`);
        i += 1;
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 去掉 AI 回复里的「配图/配视频/自拍/乐谱：…」系统指令，用户不应看到 */
function stripImageDirectiveForDisplay(text) {
  if (!text) return '';
  let t = stripAvatarChangeMarker(
    normalizeMediaDirectiveLines(text)
      .replace(/(?:^|\n)\s*(?:配图[：:]\s*|IMAGE:\s*)[^\n]*/gi, '\n')
      .replace(/(?:配图[：:]\s*|IMAGE:\s*)[^\n]*\s*$/gi, '')
      .replace(/(?:^|\n)\s*(?:配视频[：:]\s*|VIDEO:\s*)[^\n]*/gi, '\n')
      .replace(/(?:配视频[：:]\s*|VIDEO:\s*)[^\n]*\s*$/gi, '')
      .replace(/(?:^|\n)\s*(?:自拍[：:]\s*|SELFIE:\s*)[^\n]*/gi, '\n')
      .replace(/(?:自拍[：:]\s*|SELFIE:\s*)[^\n]*\s*$/gi, '')
      .replace(/[，,。！？!?\s]*自拍[：:][^\n]*/gi, '')
      .replace(/[，,。！？!?\s]*SELFIE:\s*[^\n]*/gi, '')
      .replace(/\n{2,}/g, '\n')
      .trim()
  );
  try {
    const { stripMusicScoreDirective } = require('./music-score-helper');
    t = stripMusicScoreDirective(t);
  } catch { /* ignore */ }
  try {
    const { stripSoundFxDirective } = require('./sound-fx-helper');
    t = stripSoundFxDirective(t);
  } catch { /* ignore */ }
  try {
    const { stripAlbumMarkersFromText } = require('./album-helper');
    t = stripAlbumMarkersFromText(t);
  } catch { /* ignore */ }
  return t;
}

/** 从回复中提取「自拍：场景描述」（英文或中英混写均可） */
function extractSelfieSceneQuery(text) {
  const t = normalizeMediaDirectiveLines(text || '');
  const m = t.match(/(?:^|\n)\s*(?:自拍[：:]\s*|SELFIE:\s*)([^\n]+)/i)
    || t.match(/(?:自拍[：:]\s*|SELFIE:\s*)([^\n]+)/i);
  if (!m) return undefined;
  const q = m[1].trim();
  if (!q || /^(无|none|null|-)$/i.test(q)) return null;
  return q.slice(0, 300);
}

/** 画风：短锚点优先；堆长词不会更像真人，只会把场景冲淡、画面趋同 */
const DEFAULT_SELFIE_STYLE_REAL = [
  'photorealistic real phone photo of a real human',
  'natural skin pores, matte skin, no oily sheen, no plastic CGI skin',
  'ordinary camera-roll snapshot, natural light',
  'not 3D render, not Unreal/Blender, not doll, not anime illustration',
  'no beauty filter, no glamour glow, no lens distortion or stretched face',
  'natural adult head-to-shoulder ratio; do not enlarge the head or shrink the shoulders',
].join(', ');

const DEFAULT_SELFIE_STYLE_ANIME = [
  'anime 2D illustration, clean lineart, soft cel shading',
  'casual phone-photo framing, calm natural eyes',
  'neutral or barely smiling face, no exaggerated grin or overacted cute expression',
].join(', ');

/** 图生视频：短动作约束；细节靠静图场景，不在这里堆同质「随手拍」套话 */
const DEFAULT_VIDEO_MOTION_PROMPT = [
  'short handheld phone video that starts from this still as the first frame',
  'subtle natural motion only: breathing, soft hair or cloth, tiny camera drift',
  'freeze facial expression from the still image; do not amplify emotion',
  'no wider smile, no open mouth, no laughing, no exaggerated cute face',
  'eyes stay calm; rare soft blink only',
  'no cinematic grading, no beauty filter, no face warp',
  'no speech or singing; soft ambient sound only',
].join('. ');

/** NSFW 图生视频：跟日常同一套随手拍动感；衣物/裸露跟静图走，不默认浪叫脸 */
const DEFAULT_NSFW_VIDEO_MOTION_PROMPT = [
  'short handheld phone video that starts from this still as the first frame',
  'keep the same person face body and clothing layout as the first frame',
  'subtle natural motion only: breathing, soft hair or cloth, tiny camera drift; extra body motion only if the scene asks',
  'keep facial expression from the still unless the scene asks for a change; no default sexy or moan face',
  'no cute aegyo, no cinematic grading, no beauty filter plastic skin, no lens face warp',
  'no speech or singing; soft ambient sound only',
].join('. ');

/** 自拍构图方式池：避免每次都是「自己伸手拿手机怼脸」 */
const SELFIE_SHOT_METHODS = [
  'mirror selfie, phone may appear in the mirror',
  'tripod or selfie-stick timer, hands free',
  'candid photo taken by a friend, subject not holding phone',
  'phone propped on desk or windowsill with timer, subject farther from camera',
  'over-the-shoulder mirror check',
  'medium-distance phone photo showing head, shoulders and upper chest in natural proportion, not a wide-angle close selfie',
];

/** 场景缺氛围时随机补一点，避免永远同一套「暖光卧室」 */
const SELFIE_ATMO_ACCENTS = [
  'golden hour window light',
  'cool overcast daylight',
  'warm bedside lamp at night',
  'harsh noon outdoor sun',
  'neon street reflections at night',
  'kitchen fluorescent morning light',
  'rainy window, soft grey daylight',
  'cafe indoor mixed light',
];

const SELFIE_SHOT_METHOD_RE = /mirror|tripod|selfie[\s-]?stick|timer|candid|friend|taken by|passerby|propped|arm[\s-]?out|holding (?:a )?phone|front[\s-]?camera|over[\s-]?shoulder|from behind|someone else/i;
const SELFIE_ATMO_RE = /light|lighting|sun|lamp|neon|golden|hour|night|morning|rain|window|fluorescent|overcast|cafe|street|kitchen/i;

function sceneAlreadySpecifiesShotMethod(scene) {
  return SELFIE_SHOT_METHOD_RE.test(String(scene || ''));
}

/** 场景未写清拍法时随机给一种，写了则尊重原文；并始终压住「永远伸手自拍」 */
function pickSelfieShotVarietyHint(sceneQuery) {
  if (sceneAlreadySpecifiesShotMethod(sceneQuery)) {
    return 'use the photography method already described in the scene';
  }
  const pick = SELFIE_SHOT_METHODS[Math.floor(Math.random() * SELFIE_SHOT_METHODS.length)];
  return `shot method: ${pick}`;
}

function pickSelfieAtmosphereHint(sceneQuery, char) {
  if (SELFIE_ATMO_RE.test(String(sceneQuery || ''))) return '';
  // 在家且有居所描述时，气氛跟家里走，不再叠随机 outdoor 氛围
  if (char && resolveSelfiePlaceContext(char, sceneQuery).useHome && resolveCharacterHomeEnvironment(char)) {
    return '';
  }
  const pick = SELFIE_ATMO_ACCENTS[Math.floor(Math.random() * SELFIE_ATMO_ACCENTS.length)];
  return `atmosphere: ${pick}`;
}

const SELFIE_EXPRESSION_SOFT_HINT =
  'neutral face, lips closed, no smile, no smirk; no cute overacting, no big eyes pose, no wide toothy grin';

/** 自拍：只允许角色一人脸清晰；路人只能远景糊影/背影，绝不能像给别人拍特写 */
const SELFIE_SOLO_FACE_HINT =
  'only this one person has a clear recognizable face; if any other people appear they must be tiny distant out-of-focus anonymous silhouettes or backs at the frame edge, never mid-frame, never sharp face, never looking at camera as a co-subject';

/**
 * NSFW 自拍：气质跟日常随手拍同一套，只放开衣物/裸露。
 * 禁止默认潮红半睁微张嘴的片场情色脸；身份锁定与「只有一人脸清晰」仍然生效。
 */
const SELFIE_NSFW_ALLOW_HINT = [
  'same ordinary phone snapshot as a daily selfie, not porn lighting, not boudoir, not a seductive model pose',
  'adult uncensored content is allowed: follow the scene text for clothing and exposure exactly',
  'if undressed, lingerie or nude is written, render it as written; do not add extra garments, do not cover the body, do not fall back to a modest everyday outfit',
  'neutral face copied from the face reference: lips closed, no smile, no smirk, no grin; flushed or parted lips only if the scene text explicitly asks, never as a default',
  'keep the exact face geometry from the face reference; do not warp, beautify, slim, or reshape the jaw eyes or nose',
  'matte unretouched skin, visible pores, no oily highlight, no airbrushed glow-up',
].join(', ');

/** 风景/静物配图：画面主体是景或物，不要生出「像在给路人拍写真」的清晰人脸 */
const CHAT_CONTEXT_NO_FACE_HINT = [
  'subject is the scenery or object only, not a person',
  'no clear human faces, no portrait of a stranger, no mid-frame person as the photo subject',
  'empty of people preferred; distant out-of-focus anonymous pedestrians at the far edge are ok only as tiny blur',
  'do not look like a posed photo of someone else',
].join(', ');

/**
 * 画画 / 插画 / 你画我猜：不要走「手机实拍风景」那条。
 * 返回 'doodle' | 'illustration' | null
 */
function detectDrawingMediaIntent({ userMessage = '', query = '', caption = '' } = {}) {
  const q = String(query || '');
  const blob = `${userMessage}\n${q}\n${caption}`;
  if (!blob.trim()) return null;

  // 配图行里已写明画风
  if (/\b(doodle|pictionary|crayon|stick[- ]?figure|guessing[- ]?game)\b/i.test(q)
    || /简笔画|涂鸦|你画我猜|蜡笔|儿童画/.test(q)) {
    return 'doodle';
  }
  if (/\b(illustration|sketch|drawing|lineart|anime\s*art|concept\s*art|fanart)\b/i.test(q)
    || /插画|漫画|素描|手绘|二次元画/.test(q)) {
    return 'illustration';
  }

  // 用户话 / 正文：你画我猜、简笔画优先 doodle
  if (/你画我猜|猜词画画|简笔画|涂鸦|蜡笔画|儿童画|stick\s*figure|pictionary/i.test(blob)) {
    return 'doodle';
  }
  // 「画一张/画个/给我画/插画」→ 插画（不是实拍）
  if (/(?:帮我|给我|替我|来|再)?画(?:张|个|一幅|一副|一画)?(?:图|画|插画|素描)?|画张|画个|画幅|插画|手绘一张|素描一张|comic|illustration/i.test(blob)
    && !/(?:拍|拍照|照片|自拍|实拍|摄影)/.test(blob)) {
    return 'illustration';
  }
  return null;
}

function isDrawingMediaAsk(text) {
  return !!detectDrawingMediaIntent({ userMessage: text });
}

/** 把场景描述里夸张大笑/咧嘴笑压成轻柔微笑 */
function softenSmileInSceneQuery(query) {
  return String(query || '')
    .replace(/\b(wide|big|bright|huge|toothy|cheesy|broad|happy|cheerful|excited|playful)\s+(toothy\s+)?(grin|smile)s?\b/gi, 'barely smiling')
    .replace(/\b(grinning|beaming|laughing hard|laughing|giggling|smirking widely)\b/gi, 'calm soft expression')
    .replace(/\b(showing|flashing)\s+(all\s+)?teeth\b/gi, 'lips gently closed')
    .replace(/\bmouth\s+(wide\s+)?open\b/gi, 'lips gently closed')
    .replace(/\b(soft natural smile|gentle smile|warm smile|sweet smile|cute smile|lovely smile|bright smile)\b/gi, 'barely smiling, lips closed')
    .replace(/\b(kawaii|aegyo|puppy eyes|sparkling eyes|starry eyes)\b/gi, 'calm natural eyes')
    .replace(/开心大笑|哈哈大笑|咧嘴笑|露齿笑|灿烂笑容|甜笑|卖萌|嘟嘴|眨眼卖萌/g, '表情自然克制')
    .trim();
}

/** NSFW / Hera：默认去微笑；场景里的 smirk/playful 往往是模型自己加的 */
function neutralizeSmileInNsfwScene(query) {
  return softenSmileInSceneQuery(query)
    .replace(/\b(playful|sexy|seductive|coy|flirty|cute|faint|slight|tiny|hint of)\s+(smirk|smile|grin)s?\b/gi, 'neutral expression')
    .replace(/\b(smirking|smiling|grinning)\b/gi, 'neutral')
    .replace(/\b(a playful smirk|smirk|smile|grin)\b/gi, 'neutral closed-lip expression')
    .replace(/微笑|浅笑|坏笑|坏坏地笑|嘴角上扬|笑着/g, '表情平静')
    .trim();
}

function getDefaultSelfieStylePrompt(imageStyle) {
  return imageStyle === 'real' ? DEFAULT_SELFIE_STYLE_REAL : DEFAULT_SELFIE_STYLE_ANIME;
}

function buildSelfieStylePrompt(imageStyle, customPrompt) {
  const custom = String(customPrompt || '').trim();
  if (custom) return custom;
  return getDefaultSelfieStylePrompt(imageStyle);
}

/** 居住环境关键词：从人设推断或供生图默认背景使用 */
const HOME_ENV_PROFILE_RE = /别墅|豪宅|公寓|loft|复式|海景|江景|湖景|山景|落地窗|全景窗|庭院|花园|泳池|庄园|城堡|木屋|小屋|民宿|套房|卧室|客厅|书房|厨房|阳台|露台|天台|顶层|半山|海边|临江|极简|北欧|中式|轻奢|penthouse|villa|mansion|condo|apartment|ocean view|sea view|floor-to-ceiling|balcony|terrace|living room|bedroom|kitchen|study/i;

const GENERIC_INDOOR_SCENE_RE = /^(casual )?(indoor )?(selfie|photo)|casual outfit|bedroom selfie|bathroom mirror|plain room|simple room|at home|everyday look|cozy room|generic indoor|mirror selfie/i;

function resolveCharacterHomeEnvironment(char) {
  const explicit = String(char?.home_environment || '').trim();
  const fromRefs = formatHomeRefsForPrompt(char);
  const parts = [explicit, fromRefs].filter(Boolean);
  if (parts.length) return parts.join('；').slice(0, 400);
  return inferHomeEnvironmentFromProfile(char);
}

/** 家装参考图：[{ url, label }]，label 如「卧室落地窗」「客厅沙发区」 */
const HOME_REF_MAX = 6;

function normalizeHomeRefs(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw || '[]'); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      if (typeof item === 'string' && item.trim()) {
        return { url: item.trim(), label: '' };
      }
      if (!item || typeof item !== 'object') return null;
      const url = String(item.url || '').trim();
      if (!url) return null;
      const label = String(item.label || item.desc || item.description || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 40);
      return { url, label };
    })
    .filter(Boolean)
    .slice(0, HOME_REF_MAX);
}

function homeRefsToJson(refs) {
  return JSON.stringify(normalizeHomeRefs(refs));
}

function formatHomeRefsForPrompt(char) {
  const refs = normalizeHomeRefs(char?.home_refs);
  if (!refs.length) return '';
  return refs
    .map((r) => (r.label ? r.label : '家装一角'))
    .join('；')
    .slice(0, 280);
}

const HOME_ROOM_KEYS = [
  '卧室', '客厅', '书房', '厨房', '阳台', '浴室', '卫生间', '洗手间', '餐厅', '玄关',
  '衣帽间', '工作室', '天台', '露台', '花园', '庭院', '泳池', '画室', '工作室',
  'bedroom', 'living', 'kitchen', 'study', 'balcony', 'bath', 'dining', 'studio',
];

/** 自拍场景其实是拍物/宠/鱼/食——不应注入家装参考、不应走人脸图生图 */
function isObjectOrStillLifeScene(scene) {
  const s = String(scene || '').trim();
  if (!s) return false;
  if (/自拍|本人|出镜|对镜|mirror\s*selfie|portrait|face|穿搭|holding\s*phone|腹肌|半身照|正脸|侧脸|outfit|selfie/i.test(s)) {
    return false;
  }
  return /鱼|金鱼|锦鲤|热带鱼|鱼缸|水族|乌龟|仓鼠|宠物|猫|狗|兔|鸟|花|植物|盆栽|多肉|美食|食物|咖啡|奶茶|蛋糕|甜品|菜|碗|盘|静物|特写|风景|海|沙滩|天空|街|建筑|书|desk|food|fish|goldfish|aquarium|koi|pet|flower|plant|still\s*life|close-?up\s*of/i.test(s);
}

function sceneLooksExplicitlyAtHome(scene) {
  return /家|家里|在家|客厅|卧室|书房|厨房|阳台|浴室|居所|apartment|bedroom|living\s*room|at\s*home|villa|home\s*interior|residence/i
    .test(String(scene || ''));
}

function sceneLooksAwayFromHome(scene) {
  const s = String(scene || '');
  if (sceneLooksExplicitlyAtHome(s)) return false;
  return /海边|街上|街头|咖啡|公司|办公室|商场|学校|户外|公园|沙滩|餐厅|店里|通勤|地铁|机场|车站|医院|健身房|夜市|出差|上班|便利店|天台(?!家)|车里|车上|outdoor|street|downtown|coffee|cafe|office|mall|school|park|beach|restaurant|gym|subway|airport|station|hotel|bar|club|campus|commute|roadside|plaza|market/i.test(s);
}

/** 读此刻日程地点（懒加载，避免与 cron 循环依赖） */
function loadSelfieHereAndNow(char) {
  if (!char?.id) return null;
  try {
    const { db } = require('./db');
    const settings = Object.fromEntries(
      (db.prepare('SELECT key, value FROM settings').all() || []).map((r) => [r.key, r.value])
    );
    return require('./cron').getHereAndNowContext(char, settings);
  } catch {
    return null;
  }
}

/**
 * 自拍/配视频静图：是否应用「居住环境」与家装参考。
 * 场景文案优先；空/泛室内时再看日程 placeMode；外出按所在地，不套家里。
 */
function resolveSelfiePlaceContext(char, sceneQuery = '') {
  const scene = String(sceneQuery || '').trim();
  if (sceneLooksAwayFromHome(scene)) {
    const here = loadSelfieHereAndNow(char);
    return { useHome: false, placeMode: 'away', here, reason: 'scene-away' };
  }
  if (sceneLooksExplicitlyAtHome(scene) || sceneQuerySpecifiesHome(scene)) {
    return { useHome: true, placeMode: 'home', here: null, reason: 'scene-home' };
  }
  const here = loadSelfieHereAndNow(char);
  const placeMode = String(here?.placeMode || 'home');
  if (placeMode === 'away' || placeMode === 'activity') {
    return { useHome: false, placeMode, here, reason: 'schedule-away' };
  }
  return { useHome: true, placeMode: 'home', here, reason: 'default-home' };
}

function spokenCharPlaceForSelfie(char) {
  try {
    return require('./location-weather-helper').spokenCharLocation(char) || '';
  } catch {
    return String(char?.location_name || char?.real_location || '').trim();
  }
}

/** 外出时注入所在地/日程地点，禁止套家里装修 */
function buildCharacterAwayLocationHint(char, here, sceneQuery = '') {
  if (here?.imageSceneHint) return String(here.imageSceneHint).trim();
  const place = String(here?.locationLabel || '').trim()
    || spokenCharPlaceForSelfie(char);
  const scene = String(sceneQuery || '').trim();
  if (place) {
    return `on location in/around ${place}, match local streets weather and vibe of this place, NOT home interior, NOT residential apartment block`;
  }
  if (sceneLooksAwayFromHome(scene)) {
    return 'out of home on-location setting matching the scene, NOT home interior, NOT residential apartment';
  }
  return 'out of home public or activity setting, NOT home interior, NOT residential apartment';
}

/** 是否应注入家装参考图（仅在家自拍/室内人居场景） */
function sceneShouldUseHomeRefs(sceneQuery, char = null) {
  const scene = String(sceneQuery || '').trim();
  if (sceneLooksAwayFromHome(scene)) return false;
  if (isObjectOrStillLifeScene(scene)) return false;
  if (char && !resolveSelfiePlaceContext(char, scene).useHome) return false;
  if (sceneLooksExplicitlyAtHome(scene)) return true;
  if (!scene) return !!char; // 无场景文案时：有角色且判定在家才用
  if (sceneQueryLooksGenericIndoor(scene) || /自拍/i.test(scene)) return true;
  return false;
}

/**
 * 按场景描述挑选家装参考图 URL（最多 max 张）。
 * 外出场景不注入；仅在家时取匹配房间或默认前几张。
 */
function selectHomeReferenceUrls(char, sceneQuery = '', max = 2) {
  const refs = normalizeHomeRefs(char?.home_refs);
  if (!refs.length) return [];
  if (!sceneShouldUseHomeRefs(sceneQuery, char)) return [];

  const scene = String(sceneQuery || '');

  const scored = refs.map((r) => {
    const label = String(r.label || '');
    let score = 1;
    for (const k of HOME_ROOM_KEYS) {
      const re = new RegExp(k, 'i');
      if (re.test(label) && re.test(scene)) score += 10;
      else if (re.test(label) && !scene) score += 2;
    }
    if (label && scene && label.length >= 2 && scene.includes(label.slice(0, Math.min(4, label.length)))) {
      score += 6;
    }
    return { url: r.url, label, score };
  }).sort((a, b) => b.score - a.score);

  if (scored[0]?.score >= 8) {
    return scored.slice(0, Math.max(1, max)).map((r) => r.url);
  }
  if (!scene || sceneQueryLooksGenericIndoor(scene) || /家|家里|自拍|客厅|卧室|房间|居所|室内/i.test(scene)) {
    return scored.slice(0, Math.min(max, scored.length)).map((r) => r.url);
  }
  return [];
}

function buildHomeRefConsistencyPrompt(homeRefCount, labelHint = '') {
  const n = Number(homeRefCount) || 0;
  if (n <= 0) return '';
  const labelBit = String(labelHint || '').trim();
  return [
    'background room layout furniture windows and decor must match the home interior reference photo(s)',
    labelBit ? `scene area: ${labelBit}` : '',
    'keep character face identity from character reference',
    'do not copy people from home photos',
  ].filter(Boolean).join('; ');
}

function inferHomeEnvironmentFromProfile(char) {
  if (!char) return '';
  const blobs = [char.background, char.intro, char.description, char.behavior, char.personality]
    .map(s => String(s || '').trim())
    .filter(Boolean);
  if (!blobs.length) return '';
  const chunks = blobs.join('\n')
    .split(/[\n。！？；;]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 4 && s.length <= 120);
  const hits = chunks.filter(l => HOME_ENV_PROFILE_RE.test(l)).slice(0, 4);
  return hits.join('；').slice(0, 280);
}

function sceneQuerySpecifiesHome(scene) {
  return /villa|penthouse|mansion|luxury|ocean view|sea view|floor-to-ceiling|balcony|terrace|loft|apartment|living room|bedroom|kitchen|study|别墅|豪宅|海景|落地窗|江景|客厅|卧室|书房|阳台|露台|泳池/i
    .test(String(scene || ''));
}

function sceneQueryLooksGenericIndoor(scene) {
  const s = String(scene || '').trim();
  if (!s) return true;
  if (sceneQuerySpecifiesHome(s)) return false;
  const lower = s.toLowerCase();
  if (GENERIC_INDOOR_SCENE_RE.test(lower)) return true;
  return s.length < 52 && /indoor|bedroom|bathroom|casual/i.test(lower) && !sceneQuerySpecifiesHome(s);
}

function buildCharacterHomeEnvironmentHint(char) {
  const raw = resolveCharacterHomeEnvironment(char);
  if (!raw) return '';
  return `MUST match this home: ${raw}; background and furniture must match this residence. FORBIDDEN: generic Chinese residential apartment block, old concrete walk-up, cramped cheap rental, typical urban housing estate`;
}

/**
 * 仅在「在家」时注入居住环境；外出按日程地点/所在地注入，不套家里装修。
 */
function enrichSelfieSceneQuery(sceneQuery, char) {
  if (isObjectOrStillLifeScene(sceneQuery)) {
    return String(sceneQuery || '').trim();
  }
  const scene = String(sceneQuery || '').trim();
  const place = resolveSelfiePlaceContext(char, scene);

  if (place.useHome) {
    const homeHint = buildCharacterHomeEnvironmentHint(char);
    if (!homeHint) return scene;
    if (!scene) return `at home, ${homeHint}`;
    if (/MUST match this home/i.test(scene)) return scene;
    const raw = resolveCharacterHomeEnvironment(char);
    if (raw && scene.includes(raw.slice(0, Math.min(16, raw.length)))) return scene;
    // 即使写了「客厅/卧室」等短词，仍补完整居所，避免只剩普通室内
    return `${scene}, ${homeHint}`;
  }

  const locHint = buildCharacterAwayLocationHint(char, place.here, scene);
  if (!locHint) return scene;
  if (!scene) return locHint;
  // 泛写/无明确地点时补所在地；已写清外出地点则只加「别画成家里」
  if (sceneQueryLooksGenericIndoor(scene) || scene.length < 48) {
    return `${scene}, ${locHint}`;
  }
  if (/MUST match this home|home interior|residence/i.test(scene)) return locHint;
  return `${scene}, NOT home interior`;
}

function formatHomeEnvironmentForChatPrompt(char) {
  const raw = resolveCharacterHomeEnvironment(char);
  return raw ? raw.replace(/\s+/g, ' ').trim().slice(0, 220) : '';
}

/**
 * 从角色卡抽外貌/穿搭线索，注入自拍/视频静图 prompt（避免永远 casual outfit）。
 * 优先命中含外貌关键词的短句；没有则用 intro/description 前几句。
 */
function buildCharacterAppearanceHint(char, opts = {}) {
  if (!char) return '';
  let outfitBit = '';
  try {
    const { buildOutfitAppearanceHint, detectExplicitOutfitOverride } = require('./wardrobe-helper');
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const override = opts.outfitOverride
      || detectExplicitOutfitOverride({
        userMessage: opts.userMessage || '',
        sceneQuery: opts.sceneQuery || '',
      });
    outfitBit = buildOutfitAppearanceHint(char, dateStr, undefined, {
      outfitOverride: override,
      skipDailyOutfit: !!opts.skipDailyOutfit,
      outfitPhrase: opts.outfitPhrase || '',
    });
  } catch {}
  const blobs = [char.description, char.intro, char.background, char.personality]
    .map(s => String(s || '').trim())
    .filter(Boolean);
  let personaBit = '';
  if (blobs.length) {
    const text = blobs.join('\n');
    const appearanceRe = /外貌|长相|样子|穿|衣|着装|打扮|发型|头发|发色|眼睛|瞳|身高|身材|体型|瘦|胖|胸|臀|腰|腿|肌|腹|肤色|妆|眼镜|脸|眉|鼻|嘴|气质|制服|西装|裙|靴|夹克|黑|白|红|appearance|outfit|wear|hair|eyes|tall|slim|curvy|bust|hips|waist|handsome|beautiful|skin/i;
    const chunks = text
      .split(/[\n。！？；;]+/)
      .map(s => s.trim())
      .filter(s => s.length >= 4 && s.length <= 80);
    const hits = chunks.filter(l => appearanceRe.test(l)).slice(0, 4);
    const picked = (hits.length ? hits : chunks.slice(0, 2)).join('；').slice(0, 180);
    if (picked) personaBit = `persona look: ${picked}; outfit must fit persona, not generic white tee`;
  }
  // 私密部位一般不上传参考图：靠人设/NSFW 补充文字约束体型与轮廓
  const bodyNote = String(char.nsfw_note || '').trim().slice(0, 160);
  const bodyBit = bodyNote
    ? `body details from character note: ${bodyNote}`
    : '';
  const merged = [outfitBit, personaBit, bodyBit].filter(Boolean).join('; ');
  return merged;
}

/**
 * 组装自拍生图提示词：场景优先，画风只做短锚点（越长越容易普通、趋同）
 * sceneQuery 来自 AI 末尾「自拍：…」行
 */
function buildSelfieGenerationPrompt({ imageStyle, charName, sceneQuery, hasRef, hasBodyRef, hasFullBodyRef, hasHandRef, hasSpecialRef, specialLabel, stylePrompt, aspect, char, hasHomeRef, outfitOverride, userMessage, skipDailyOutfit, nsfw } = {}) {
  const isNsfw = !!nsfw;
  const style = buildSelfieStylePrompt(imageStyle, stylePrompt);
  const enriched = enrichSelfieSceneQuery(sceneQuery, char);
  const scene = isNsfw ? neutralizeSmileInNsfwScene(enriched) : softenSmileInSceneQuery(enriched);
  const shotHint = pickSelfieShotVarietyHint(scene);
  const atmoHint = pickSelfieAtmosphereHint(scene, char);
  // NSFW 时不注入今日衣柜穿搭，否则会硬给套上一身日常衣服
  const appearance = buildCharacterAppearanceHint(char, {
    outfitOverride,
    userMessage,
    sceneQuery,
    skipDailyOutfit: skipDailyOutfit || (isNsfw && !outfitOverride?.phrase),
  });
  const lockOutfit = isNsfw || /wearing exactly:|wear the outfit described in the scene prompt/i.test(appearance);
  const identity = hasRef
    ? buildSelfieRefConsistencyPrompt({
      hasBodyRef: !!hasBodyRef,
      hasFullBodyRef: !!hasFullBodyRef,
      hasHandRef: !!hasHandRef,
      hasSpecialRef: !!hasSpecialRef,
      specialLabel: specialLabel || '',
      lockOutfit,
    })
    : '';
  const homeRefBit = buildHomeRefConsistencyPrompt(
    hasHomeRef ? 1 : 0,
    hasHomeRef && char
      ? normalizeHomeRefs(char.home_refs).map((r) => r.label).filter(Boolean).slice(0, 2).join(' / ')
      : '',
  );
  const nameBit = charName ? String(charName).trim() : '';
  const antiFake = imageStyle === 'real'
    ? 'real human photograph only, not CGI/3D'
    : '';
  const aspectBit = aspectPromptConstraint(aspect || '3:4');
  // 锁身材/去油必须靠前：提示词过长时部分中转会截断，家装+人设一长，末尾的锁脸句会被切掉
  const proportionBit = imageStyle === 'real'
    ? [
      'first reference is full-body proportion lock when present: keep the same height, limb length and head-to-body ratio; do not shorten the legs or compact the torso',
      'next face reference is identity lock: same face, do not warp',
      'camera a little farther than a close selfie; adult tall proportions, not short or stubby',
    ].join('; ')
    : '';
  const skinBit = (imageStyle === 'real' && isNsfw)
    ? 'matte unretouched skin, visible pores, no oily sheen, no glamour glow'
    : '';
  const expressionBit = isNsfw ? SELFIE_NSFW_ALLOW_HINT : SELFIE_EXPRESSION_SOFT_HINT;
  // identity（锁脸/身材）紧跟场景：人设+家装一长时，靠后可能被中转截断
  return [scene, proportionBit, skinBit, identity, appearance, shotHint, atmoHint, expressionBit, SELFIE_SOLO_FACE_HINT, style, homeRefBit, nameBit, antiFake, aspectBit]
    .filter(Boolean)
    .join(', ');
}

function stripImageDirectiveFromSegments(segments, fallbackText = '') {
  const base = segments?.length
    ? segments
    : [{ type: 'text', content: fallbackText }];
  // 拆泡后「自拍：」与描述可能已是两段：先拼回再剥
  const barePrefix = new RegExp(`^\\s*${MEDIA_DIR_PREFIX_RE}[：:]\\s*$`, 'i');
  const anyPrefix = new RegExp(`^\\s*${MEDIA_DIR_PREFIX_RE}[：:]`, 'i');
  const merged = [];
  for (let i = 0; i < base.length; i++) {
    const seg = base[i];
    if (seg.type === 'text' && barePrefix.test(String(seg.content || ''))) {
      const next = base[i + 1];
      if (next?.type === 'text') {
        const nextText = String(next.content || '').trim();
        if (nextText && !anyPrefix.test(nextText)) {
          const prefix = String(seg.content || '').replace(/\s*$/, '');
          merged.push({ ...seg, content: `${prefix}${nextText}` });
          i += 1;
          continue;
        }
      }
    }
    merged.push(seg);
  }
  return merged
    .map(seg => {
      if (seg.type !== 'text') return seg;
      return { ...seg, content: stripImageDirectiveForDisplay(seg.content) };
    })
    .filter(seg => seg.type === 'emoji' || seg.type === 'location' || seg.type === 'link' || seg.type === 'web_card' || (seg.content && String(seg.content).trim()));
}

/** 明确含人物/人像的描述（严格过滤） */
const PEOPLE_STRICT_RE = /\b(people|person|persons|portrait|portraits|selfie|selfies|human|humans|headshot|headshots|crowd|crowds|wedding|group portrait|family portrait)\b/i;

function photoMetadataBlob(photo) {
  const tags = (photo.tags || []).map(t => t.title || t.name || '').join(' ');
  return `${photo.alt_description || ''} ${photo.description || ''} ${tags}`.toLowerCase();
}

function photoMarkedNoPeople(photo) {
  return /\b(no people|without people|nobody|unpopulated|empty (?:street|beach|road|landscape|city))\b/.test(photoMetadataBlob(photo));
}

function photoObviouslyHasPeople(photo) {
  if (!photo) return false;
  if (photoMarkedNoPeople(photo)) return false;
  return PEOPLE_STRICT_RE.test(photoMetadataBlob(photo));
}

/** 兼容旧名：只排除明确有人物的图，不再误伤 silhouette/model 等标签 */
function photoLikelyHasPeople(photo) {
  return photoObviouslyHasPeople(photo);
}

function filterPhotosNoPeople(results, { strict = true } = {}) {
  if (!results?.length) return [];
  const marked = results.filter(photoMarkedNoPeople);
  const filtered = results.filter(p => !photoObviouslyHasPeople(p));
  if (filtered.length) return filtered;
  if (marked.length) return marked;
  if (!strict) return results.slice(0, Math.min(8, results.length));
  return [];
}

function sanitizeUnsplashQuery(query) {
  let q = String(query || '').trim();
  q = q.replace(/^["'`]|["'`]$/g, '');
  const stripped = q.replace(/\b(person|people|portrait|human|headshot|selfie|crowd|wedding)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const out = (stripped || q).slice(0, 100);
  return out;
}

/** 中文关键词转英文搜图短语；已是英文则原样清理 */
function normalizeUnsplashQuery(query) {
  const q = String(query || '').trim();
  if (!q) return '';
  if (/[\u4e00-\u9fff]/.test(q)) {
    return extractImageQueryFromText(q) || sanitizeUnsplashQuery(q);
  }
  return sanitizeUnsplashQuery(q) || extractImageQueryFromText(q);
}

/** 从中文文案提取英文搜图短语（无 AI，兜底用） */
function extractImageQueryFromText(text) {
  const t = String(text || '');
  const map = [
    [/美食|好吃|餐厅|料理|火锅|烧烤|甜品|蛋糕|面包|奶茶|外卖|便当|拉面|寿司/, 'food still life table'],
    [/咖啡|拿铁|美式|手冲/, 'coffee cup cafe still life'],
    [/茶|下午茶|奶盖/, 'tea cup still life'],
    [/酒|啤酒|红酒|鸡尾酒/, 'drink glass still life'],
    [/猫|喵/, 'cat animal pet'],
    [/狗|犬|柴犬|柯基/, 'dog animal pet'],
    [/鱼|金鱼|锦鲤|热带鱼|鱼缸|水族/, 'goldfish in aquarium close-up'],
    [/花|玫瑰|樱花|植物|绿植|盆栽|多肉/, 'flowers botanical plant'],
    [/雨|下雨/, 'rain window drops aesthetic'],
    [/雪|下雪/, 'snow landscape scenery'],
    [/海|海滩|沙滩|浪|海洋/, 'ocean beach landscape'],
    [/山|森林|树|自然|风景|草原|田野|湖/, 'landscape nature forest scenery'],
    [/夜|月亮|星星|夕阳|日落|晚霞|朝阳|清晨|天空|云|蓝天/, 'sky sunset clouds landscape'],
    [/城|街|建筑|霓虹|灯光|桥|巷/, 'city architecture street empty'],
    [/书|阅读|图书馆|书桌|笔记/, 'book desk still life'],
    [/音乐|唱片|吉他|钢琴|耳机/, 'music instrument still life'],
    [/旅行|旅途|出行|度假|机场|火车|车票/, 'travel landscape scenery'],
    [/电脑|键盘|屏幕|显示器|工位/, 'desk computer workspace still life'],
    [/鞋|球鞋|衣服|衣服挂|衣架/, 'clothing fashion still life no face'],
    [/月亮|满月/, 'full moon night sky'],
    [/日落|夕阳|晚霞/, 'sunset sky landscape'],
  ];
  for (const [pat, topic] of map) {
    if (pat.test(t)) return topic;
  }
  // 无具体主题时不要默认风景，避免「说自拍却出风景」
  return '';
}

/**
 * 从角色正文推断「要发什么画面」——口头说发了但没写指令行时用。
 * 返回 { kind:'selfie'|'image', scene, query }
 */
function inferShareIntentFromReply(text) {
  const raw = String(text || '');
  let t = raw
    .replace(/(?:^|\n)\s*(?:配图|自拍|配视频)\s*[：:][^\n]*/gi, '\n')
    .replace(/发(过)?(去|来)了|传(过)?(去|来)了|发你了|发给你了|拍好了|赶紧看|看完评价|发张图|发个图|给你发(?:张|个)?(?:图|照片)?|发你看看|发过来看看/g, ' ')
    .replace(/\[(表情|表情包|位置|链接|网页卡)\][\s\S]*?\[\/\1\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return { kind: 'selfie', scene: '', query: '' };

  const stillQ = extractImageQueryFromText(t);
  const aboutSelf = /自拍|本人|出镜|对镜|我这张|我的脸|穿搭|镜子里/.test(t);
  const aboutObject = isObjectOrStillLifeScene(t) || (!!stillQ && !aboutSelf
    && !/我|脸|穿|镜子|自拍/.test(t.replace(/我们|我家|我们家/g, '')));

  // 正文画面线索：留给生图，不要只剩笼统 coffee/sky
  const zhHint = t.split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => s.length >= 2)
    .find((p) => /窗|街|咖啡|雨|海|猫|狗|花|夜|天|穿|床|沙发|车|公园|办公室|桌上|手里/.test(p))
    || t.slice(0, 120);

  if (aboutObject && (stillQ || zhHint) && !aboutSelf) {
    const query = [stillQ, zhHint].filter(Boolean).join(', ').slice(0, 220);
    return { kind: 'image', scene: query, query };
  }

  // 自拍：从正文抽地点/动作/穿着碎片拼英文场景，避免空场景掉进默认家里
  const bits = [];
  const eng = t.match(/[A-Za-z][A-Za-z0-9 ,.'-]{10,160}/);
  if (eng) bits.push(eng[0].trim());

  if (/咖啡|cafe|星巴克|咖啡店/.test(t)) bits.push('sitting in a cafe');
  else if (/街上|街头|外面|户外|路边/.test(t)) bits.push('outdoors on the street');
  else if (/公园/.test(t)) bits.push('in a park');
  else if (/公司|办公室|工位/.test(t)) bits.push('at the office desk');
  else if (/地铁|公交|车站/.test(t)) bits.push('in transit commute');
  else if (/窗边|窗前|靠窗|窗外/.test(t)) bits.push('by the window');
  else if (/床上|刚醒|起床/.test(t)) bits.push('on the bed just woke up');
  else if (/浴室|洗脸|刷牙/.test(t)) bits.push('in the bathroom mirror');
  else if (/客厅|沙发/.test(t)) bits.push('in the living room');
  else if (/厨房/.test(t)) bits.push('in the kitchen');
  else if (/阳台/.test(t)) bits.push('on the balcony');
  else if (/车里|车上|副驾/.test(t)) bits.push('inside a car');
  else if (/夜|晚上|深夜/.test(t)) bits.push('at night');
  else if (/早上|清晨|上午/.test(t)) bits.push('in the morning');

  if (/喝/.test(t)) bits.push('holding a drink');
  if (/吃|刚吃/.test(t)) bits.push('after a meal');
  if (/跑步|运动|健身/.test(t)) bits.push('after workout');
  if (/上班|加班/.test(t)) bits.push('during work break');
  if (/下雨|雨天/.test(t)) bits.push('rainy weather');
  if (/下雪|雪天/.test(t)) bits.push('snowy weather');
  if (/对镜|镜子/.test(t)) bits.push('mirror selfie');
  if (/伸手|举着手机/.test(t)) bits.push('arm extended phone selfie');
  if (/抓拍|朋友拍/.test(t)) bits.push('candid shot by a friend');

  if (/黑衣服|黑色|全黑/.test(t)) bits.push('wearing black outfit');
  if (/白衣服|白色|白T|白衬衫/.test(t)) bits.push('wearing white top');
  if (/外套|夹克|皮衣/.test(t)) bits.push('wearing a jacket');
  if (/帽子|棒球帽/.test(t)) bits.push('wearing a cap');
  if (/眼镜/.test(t)) bits.push('wearing glasses');

  let scene = [...new Set(bits)].join(', ').slice(0, 220);
  // 英碎片不够时，把中文画面线索也塞进场景，避免空场景→默认家里
  if (!scene && zhHint) scene = zhHint;
  else if (zhHint && scene.length < 40) scene = `${scene}, ${zhHint}`.slice(0, 220);

  if (stillQ && !aboutSelf && /给你看|快看|瞧瞧|拍了|这张/.test(raw)) {
    return { kind: 'image', scene: [stillQ, zhHint].filter(Boolean).join(', '), query: stillQ };
  }
  return { kind: 'selfie', scene, query: stillQ || '' };
}

/** 只要一段可读的画面字符串（配图 prompt / 日志用） */
function inferShareSceneFromReply(text) {
  const info = inferShareIntentFromReply(text);
  return String(info.scene || info.query || '').trim();
}

function parseMomentContentAndImageQuery(raw) {
  let content = normalizeMediaDirectiveLines(raw || '');
  /** undefined=未说明, null=明确不要, string=关键词 */
  let imageQuery = undefined;
  let videoQuery = undefined;

  const videoMatch = content.match(/(?:^|\n)\s*(?:配视频[：:]\s*|VIDEO:\s*)([^\n]+)/i)
    || content.match(/(?:配视频[：:]\s*|VIDEO:\s*)([^\n]+)\s*$/i);
  if (videoMatch) {
    const q = videoMatch[1].trim();
    if (!q || q === '无' || /^none$/i.test(q) || /^无视频$/i.test(q)) {
      videoQuery = null;
    } else {
      videoQuery = q;
    }
    content = content.replace(videoMatch[0], '\n').replace(/\n{2,}/g, '\n').trim();
  }

  const lineMatch = content.match(/(?:^|\n)\s*(?:配图[：:]\s*|IMAGE:\s*)([^\n]+)/i)
    || content.match(/(?:配图[：:]\s*|IMAGE:\s*)([^\n]+)\s*$/i);
  if (lineMatch) {
    const q = lineMatch[1].trim();
    if (!q || q === '无' || /^none$/i.test(q) || /^无图$/i.test(q)) {
      imageQuery = null;
    } else {
      imageQuery = q;
    }
    content = content.replace(lineMatch[0], '\n').replace(/\n{2,}/g, '\n').trim();
  }
  return { content, imageQuery, videoQuery };
}

async function inferMomentImageQuery(settings, content) {
  const systemPrompt = `你是朋友圈配图关键词助手。根据中文文案，输出一条 Unsplash 英文搜图短语。
要求：只能是风景、静物、食物、动物、植物、天空、城市建筑空镜；禁止人物、人像、自拍、合影、模特、行人特写。
不超过 8 个英文单词，不要句子。只输出关键词。`;
  try {
    const raw = await callChatAPI(settings, systemPrompt, content, 'chat');
    const q = sanitizeUnsplashQuery(raw);
    return q || null;
  } catch {
    return null;
  }
}

async function searchUnsplashPhotos(settings, query, { noPeople = false, perPage = 30 } = {}) {
  const key = (settings.unsplash_api_key || '').trim();
  if (!key) return [];
  let q = normalizeUnsplashQuery(query);
  if (!q) q = extractImageQueryFromText(query);
  if (!q) return [];
  try {
    const resp = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${perPage}&orientation=squarish&content_filter=high&client_id=${key}`,
      { timeout: 15000 }
    );
    if (!resp.ok) {
      console.warn('[unsplash] search failed', resp.status, q);
      return [];
    }
    const data = await resp.json();
    const results = data.results || [];
    if (!noPeople) return results;
    let filtered = filterPhotosNoPeople(results, { strict: true });
    if (filtered.length) return filtered;
    filtered = filterPhotosNoPeople(results, { strict: false });
    if (filtered.length) {
      console.warn('[unsplash] strict no-people filter empty, using relaxed pool for query:', q);
      return filtered;
    }
    return results.slice(0, Math.min(8, results.length));
  } catch (e) {
    console.warn('[unsplash] search error:', e.message, q);
    return [];
  }
}

function pickUnsplashPhoto(results) {
  if (!results?.length) return null;
  const pool = results.slice(0, Math.min(8, results.length));
  const photo = pool[Math.floor(Math.random() * pool.length)];
  return photo.urls?.regular || photo.urls?.small || null;
}

// 从 Unsplash 搜索符合主题的图片（默认过滤人物，滤空时逐步放宽）
async function fetchUnsplashImage(settings, query, opts = {}) {
  const { noPeople = true, perPage = 30 } = opts;
  const key = (settings.unsplash_api_key || '').trim();
  if (!key) return null;

  const baseQuery = normalizeUnsplashQuery(query) || extractImageQueryFromText(query) || 'nature landscape scenery';
  const tryQueries = [
    baseQuery,
    `${baseQuery} still life`,
    `${baseQuery} landscape`,
    extractImageQueryFromText(query),
    'nature landscape scenery still life',
    'landscape scenery empty',
  ].filter((q, i, arr) => q && arr.indexOf(q) === i);

  for (const q of tryQueries) {
    for (const strictNoPeople of (noPeople ? [true, false] : [false])) {
      const results = await searchUnsplashPhotos(settings, q, { noPeople: strictNoPeople, perPage });
      const url = pickUnsplashPhoto(results);
      if (url) return url;
    }
  }
  return null;
}

/** 朋友圈角色配图：本地关键词优先，AI 关键词兜底 */
async function fetchUnsplashImageForMoment(settings, contentText, presetQuery = null) {
  const queries = [];
  if (presetQuery) queries.push(normalizeUnsplashQuery(presetQuery));
  queries.push(extractImageQueryFromText(contentText));
  if (typeof presetQuery !== 'string' || !presetQuery.trim()) {
    const aiQuery = await inferMomentImageQuery(settings, contentText);
    if (aiQuery) queries.push(aiQuery);
  }

  const seen = new Set();
  for (const q of queries) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const url = await fetchUnsplashImage(settings, q, { noPeople: true });
    if (url) return url;
  }
  return null;
}

/** 聊天分享配图（已弃用主路径，仅作生图失败时的兜底） */
async function fetchUnsplashImageForChat(settings, contentText, presetQuery = null) {
  return fetchUnsplashImageForMoment(settings, contentText, presetQuery);
}

/** 聊天配图：根据「配图：」描述与正文拼生图 prompt（纯文生图，不走参考图） */
function buildChatContextImagePrompt(char, { presetQuery, captionText, placeHint, drawMode, userMessage } = {}) {
  const imageStyle = char?.image_style || 'anime';
  let subject = String(presetQuery || '').trim();
  if (/[\u4e00-\u9fff]/.test(subject)) {
    const mapped = extractImageQueryFromText(subject);
    // 保留中文细节：只映射会丢掉「窗外那杯拿铁」这类具体画面
    subject = mapped ? `${mapped}, ${subject}` : subject;
  }
  if (!subject && captionText) {
    const mapped = extractImageQueryFromText(captionText);
    const hint = inferShareSceneFromReply(captionText);
    subject = [mapped, hint].filter(Boolean).join(', ') || '';
  }
  subject = subject.replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);

  const mode = drawMode
    || detectDrawingMediaIntent({
      userMessage: userMessage || '',
      query: presetQuery || '',
      caption: captionText || '',
    })
    || 'photo';

  // 你画我猜 / 简笔画：故意画糊一点，方便猜
  if (mode === 'doodle') {
    if (!subject) subject = 'a simple everyday object';
    // 去掉易泄露答案的标签词
    const clean = subject
      .replace(/\b(illustration|sketch|doodle|drawing|photo|photograph)s?\b/gi, ' ')
      .replace(/插画|素描|涂鸦|简笔画|配图/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'a simple everyday object';
    return [
      `Amateur pictionary doodle of "${clean}"`,
      'child-like crayon sketch on white paper',
      'messy hand-drawn lines, rough proportions',
      'simple cartoon, intentionally imperfect and vague',
      'no text, no labels, no letters, no photorealism',
      'looks like a quick guessing-game drawing',
    ].join(', ');
  }

  // 插画 / 手绘：按角色画风，禁止落成手机实拍风景
  if (mode === 'illustration') {
    if (!subject) subject = 'a charming simple illustration scene';
    const styleDesc = imageStyle === 'real'
      ? 'digital illustration, soft painterly concept art, clean composition, not a photograph'
      : 'anime 2D illustration, clean lineart, soft cel shading, expressive but readable, not a photograph';
    return [
      styleDesc,
      subject,
      'hand-drawn or painted look, artistic illustration',
      'not photorealistic, not iPhone camera roll, not Unsplash stock photo, not phone snapshot',
      'drawn characters or creatures are ok when the subject asks; no random photoreal stranger faces',
      'high quality illustration',
    ].filter(Boolean).join(', ');
  }

  // 默认：实拍风景/静物分享
  const styleDesc = imageStyle === 'real'
    ? 'casual accidental iPhone snapshot, slight motion blur, phone grain, no beauty filter, no cinematic look'
    : 'photorealistic photograph, natural lighting, realistic textures';
  if (!subject) subject = 'everyday still life, soft natural window light';

  const place = String(placeHint || '').trim();
  const homeHint = buildCharacterHomeEnvironmentHint(char);
  const looksIndoorHome = !isObjectOrStillLifeScene(subject)
    && /apartment|bedroom|indoor|room corner|window view|at home|家里|客厅|卧室|居民/.test(`${subject} ${place}`);
  const placeBits = [];
  if (place) placeBits.push(place);
  else if (homeHint && looksIndoorHome) placeBits.push(homeHint);
  placeBits.push('NOT generic Chinese apartment block, NOT old residential housing');

  return [
    styleDesc,
    ...placeBits,
    subject,
    CHAT_CONTEXT_NO_FACE_HINT,
    'high quality, sharp focus on the scenery or object not on bystanders',
  ].filter(Boolean).join(', ');
}

/** 聊天配图尝试的比例：风景优先横屏，失败则回退竖图/方图（部分 API 不支持 16:9） */
function chatContextAspectCandidates(opts = {}, char) {
  // 插画/简笔画默认方图更稳
  if (opts.drawMode === 'doodle' || opts.drawMode === 'illustration') {
    const primary = normalizeSelfieAspect(opts.aspect || '1:1');
    return [...new Set([primary, '1:1', '3:4'])];
  }
  const primary = normalizeSelfieAspect(
    opts.aspect
    || inferChatMediaAspect({
      kind: 'image',
      text: opts.captionText || '',
      query: opts.query || '',
      char,
    })
  );
  const list = [primary];
  if (primary === '16:9') list.push('3:4', '1:1');
  else if (primary !== '3:4') list.push('3:4');
  return [...new Set(list)];
}

/** 聊天配图：优先生图 API；失败则用图生图 API 做纯文生图；再失败且已配 Unsplash 时搜图兜底 */
async function generateChatContextImage(settings, char, contentText, presetQuery = null, opts = {}) {
  const captionText = String(contentText || '').trim();
  const query = typeof presetQuery === 'string' ? presetQuery : '';
  const drawMode = opts.drawMode
    || detectDrawingMediaIntent({
      userMessage: opts.userMessage || '',
      query,
      caption: captionText,
    })
    || null;
  // 画画不要掉进 Unsplash 实拍风景兜底
  const allowUnsplashFallback = !drawMode && opts.allowUnsplash !== false;
  const nsfw = inferNsfwMediaRequest(opts, `${captionText}\n${query}`);
  settings = routeSettingsForMediaGen(settings, { nsfw, forVideo: false });
  const hasImageApi = (settings.image_api_url || '').trim() && (settings.image_api_key || '').trim();
  const hasImg2Img = !!resolveImg2ImgConfig(settings);
  if (!hasImageApi && !hasImg2Img) {
    if (!allowUnsplashFallback) {
      console.warn('[chat image/gen] 画画模式需要图像 API，未配置则无法出插画/简笔画');
      return null;
    }
    console.warn('[chat image/gen] 未配置图像/图生图 API，尝试 Unsplash 兜底');
    return fetchUnsplashImageForChat(settings, captionText, query || null);
  }

  const aspects = chatContextAspectCandidates({
    aspect: opts.aspect || (drawMode ? '1:1' : ''),
    captionText,
    query,
    drawMode,
  }, char);
  const genOpts = {
    publicBase: opts.publicBase || opts.reqBase || '',
    reqBase: opts.reqBase || opts.publicBase || '',
  };
  const basePrompt = buildChatContextImagePrompt(char, {
    presetQuery: query || null,
    captionText,
    placeHint: opts.placeHint || '',
    drawMode,
    userMessage: opts.userMessage || '',
  });

  for (const aspect of aspects) {
    const prompt = [basePrompt, aspectPromptConstraint(aspect)].filter(Boolean).join(', ');
    const url = await generateImage(settings, prompt, null, { ...genOpts, aspect });
    if (url) {
      console.log('[chat image/gen] ok mode=', drawMode || 'photo', 'aspect=', aspect, ':', prompt.slice(0, 140));
      return url;
    }
    console.warn('[chat image/gen] aspect', aspect, 'failed:', (getLastGenerateImageError() || 'empty').slice(0, 120));
  }

  // 主文生图全失败：显式走图生图栏 text-to-image（与自拍 edits 不同协议）
  if (hasImg2Img) {
    const cfg = resolveImg2ImgTextToImageConfig(settings);
    if (cfg) {
      for (const aspect of aspects) {
        const prompt = [basePrompt, aspectPromptConstraint(aspect)].filter(Boolean).join(', ');
        let url = null;
        if (cfg.protocol === '80ai') {
          url = await generateImageVia80Ai({
            ...settings,
            image_api_url: cfg.url,
            image_api_key: cfg.key,
            image_model: cfg.model,
          }, prompt, null, { aspect });
        } else if (cfg.protocol === 'hiapi' || cfg.hiapi || isHiApiUrl(cfg.url)) {
          url = await generateImageViaHiApiTasks(cfg, prompt, [], {
            aspect,
            publicBase: genOpts.publicBase,
            requireReference: false,
          });
        } else {
          url = await generateImageViaImg2ImgTextFallback(settings, prompt, {
            ...genOpts,
            aspect,
            afterMainImageFailure: true,
          });
        }
        if (url) {
          console.log('[chat image/gen] img2img text-to-image ok mode=', drawMode || 'photo', 'aspect=', aspect);
          return url;
        }
      }
    }
  }

  if (!allowUnsplashFallback) return null;
  const fallback = await fetchUnsplashImageForChat(settings, captionText, query || null);
  if (fallback) console.warn('[chat image/gen] fallback to Unsplash');
  return fallback;
}

// ─── 视频生成（聊天配图；与图像 API 同地址/Key）───

let _lastGenerateVideoError = '';
let _lastGenerateVideoMeta = { model: '', mode: '' };

function getLastGenerateVideoError() {
  const raw = _lastGenerateVideoError || '';
  if (!raw) return '';
  if (isApiBillingError(raw)) return formatApiBillingError(raw, { label: '视频 API' });
  return raw;
}

function getLastGenerateVideoMeta() {
  return { ..._lastGenerateVideoMeta };
}

const VIDEO_GEN_MODEL_RE = /veo|kling|seedance|sora|runway|hailuo|jimeng|luma|minimax.*video|doubao|wanx|video/i;

const EIGHTY_AI_VIDEO_MODEL_ALIASES = {
  veo3: 'veo3_fast',
  veo: 'veo3_fast',
  veo31: 'veo3.1_fast',
  kling: 'kling-v2-master',
  kling2: 'kling-v2-master',
  seedance: 'seedance-2.0-fast',
  seedance2: 'seedance-2.0-fast',
};

function normalize80AiVideoModelInput(raw) {
  let model = String(raw || '').trim();
  if (!model) return '';
  const key = model.toLowerCase().replace(/[\s_\-（）()【】]/g, '');
  if (EIGHTY_AI_VIDEO_MODEL_ALIASES[key]) return EIGHTY_AI_VIDEO_MODEL_ALIASES[key];
  return model;
}

function get80AiVideoModelCandidates(settings) {
  const raw = normalize80AiVideoModelInput(settings.video_model);
  const defaults = [
    'veo3_fast', 'veo3', 'veo3.1_fast',
    'kling-v2-master', 'kling-v2-5-turbo',
    'seedance-2.0-fast', 'seedance-2.0',
  ];
  if (raw) return [...new Set([raw, ...defaults])];
  return defaults;
}

function extract80AiVideoUrl(task) {
  if (!task) return null;
  if (task.video_url) return task.video_url;
  const videos = task.videos || [];
  for (const v of videos) {
    const url = v?.video_url || v?.url || v?.link || v?.download_url;
    if (url && v?.status !== 'failed') return url;
  }
  const output = task.output;
  if (output) {
    const urls = output.video_urls || output.videos;
    if (Array.isArray(urls) && urls[0]) {
      return typeof urls[0] === 'string' ? urls[0] : (urls[0].url || urls[0].video_url);
    }
    if (typeof output.url === 'string' && /\.mp4|video/i.test(output.url)) return output.url;
  }
  if (Array.isArray(task.outputs)) {
    for (const o of task.outputs) {
      const url = typeof o === 'string' ? o : (o?.video_url || o?.url);
      if (url) return url;
    }
  }
  return null;
}

function is80AiTaskSuccessStatus(status) {
  return /^(completed|succeed|success|done)$/i.test(String(status || '').trim());
}

function is80AiTaskFailedStatus(status) {
  return /failed|error|cancelled|canceled/i.test(String(status || ''));
}

function get80AiTaskId(task) {
  if (!task) return '';
  return String(task.id || task.task_id || task.taskId || '').trim();
}

async function poll80AiTask(settings, taskId, { maxWaitMs, intervalMs = 4000, want = 'video' } = {}) {
  const root = normalize80AiBase(settings.image_api_url);
  const apiKey = String(settings.image_api_key || '').trim();
  const waitMs = Number(maxWaitMs) > 0
    ? maxWaitMs
    : (want === 'image' ? IMAGE_GEN_MAX_WAIT_MS : 300000);
  const started = Date.now();
  const pollPaths = [
    `${root}/api/tasks/${encodeURIComponent(taskId)}`,
    `${root}/api/tasks/${encodeURIComponent(taskId)}/status`,
  ];
  const setErr = (msg) => {
    if (want === 'image') _lastGenerateImageError = msg;
    else _lastGenerateVideoError = msg;
  };
  const waitMin = Math.round(waitMs / 60000);
  while (Date.now() - started < waitMs) {
    for (const path of pollPaths) {
      try {
        const { resp, raw } = await fetch80AiRequest(path, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          timeoutMs: 30000,
        }, 1);
        if (!resp.ok) continue;
        const data = JSON.parse(raw);
        const task = Array.isArray(data) ? data[0] : (data?.data || data);
        if (!task) continue;
        const videoUrl = extract80AiVideoUrl(task);
        const imageUrl = extract80AiImageUrl(task);
        const mediaUrl = want === 'video' ? (videoUrl || imageUrl) : (imageUrl || videoUrl);
        if (mediaUrl && (is80AiTaskSuccessStatus(task.status) || mediaUrl)) return { task, url: mediaUrl };
        if (is80AiTaskFailedStatus(task.status)) {
          setErr(task.error_message || task.error || '80ai 任务失败');
          return null;
        }
      } catch (e) {
        console.warn(want === 'image' ? '[generateImage/80ai] poll' : '[generateVideo/80ai] poll', e.message);
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  setErr(want === 'image'
    ? `80ai 生图超时（已等约 ${waitMin} 分钟）。对方可能仍在出图并已扣费，请先到控制台确认，不要立刻点重试。`
    : `视频生成超时（约 ${waitMin} 分钟），请稍后重试`);
  return null;
}

async function finalize80AiTaskResponse(settings, task, { want = 'video' } = {}) {
  const videoUrl = extract80AiVideoUrl(task);
  const imageUrl = extract80AiImageUrl(task);
  const immediate = want === 'video' ? (videoUrl || imageUrl) : (imageUrl || videoUrl);
  if (immediate && (is80AiTaskSuccessStatus(task?.status) || immediate)) return immediate;
  const taskId = get80AiTaskId(task);
  const pending = task && (/pending|processing|queued|running|waiting|in_progress|submitted/i.test(String(task.status || '')) || (taskId && !immediate));
  if (taskId && (pending || !immediate)) {
    const polled = await poll80AiTask(settings, taskId, {
      want,
      maxWaitMs: want === 'image' ? IMAGE_GEN_MAX_WAIT_MS : 300000,
    });
    return polled?.url || null;
  }
  if (is80AiTaskFailedStatus(task?.status)) {
    const msg = task?.error_message || task?.error || '80ai 任务失败';
    if (want === 'image') _lastGenerateImageError = msg;
    else _lastGenerateVideoError = msg;
    return null;
  }
  return immediate;
}

/** 80ai：POST /api/tasks 生成短视频 */
async function post80AiVideoTask(settings, prompt, model, taskOpts = {}) {
  const root = normalize80AiBase(settings.image_api_url);
  const apiKey = String(settings.image_api_key || '').trim();
  const body = {
    prompt: String(prompt || '').trim(),
    model,
    mode: taskOpts.mode || 'generate',
    output_type: 'video',
    size: taskOpts.size || '16:9',
    resolution: taskOpts.resolution || '720p',
    duration: taskOpts.duration || 5,
    source: 'api',
  };

  try {
    const { resp, raw } = await fetch80AiRequest(`${root}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs: 120000,
    }, 2);
    if (!resp.ok) {
      const errMsg = parse80AiErrorDetail(raw, resp.status);
      _lastGenerateVideoError = formatImageGenApiError(`HTTP ${resp.status}: ${errMsg}`)
        || `80ai 视频生成失败 HTTP ${resp.status}`;
      return null;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      _lastGenerateVideoError = `80ai 返回非 JSON：${raw.trim().slice(0, 200)}`;
      return null;
    }
    const tasks = Array.isArray(data) ? data : [data];
    for (const task of tasks) {
      const url = await finalize80AiTaskResponse(settings, task, { want: 'video' });
      if (url) {
        _lastGenerateVideoMeta = { model, mode: body.mode };
        return url;
      }
      if (is80AiTaskFailedStatus(task?.status)) {
        _lastGenerateVideoError = task.error_message || '80ai 视频任务失败';
        return null;
      }
    }
    _lastGenerateVideoError = _lastGenerateVideoError || tasks[0]?.error_message || '80ai 未返回视频 URL';
    return null;
  } catch (e) {
    _lastGenerateVideoError = format80AiNetworkError(e);
    console.error('[generateVideo/80ai]', model, e.message);
    return null;
  }
}

async function generateVideoVia80Ai(settings, prompt) {
  const models = get80AiVideoModelCandidates(settings);
  let lastErr = '';
  for (const model of models) {
    const url = await post80AiVideoTask(settings, prompt, model);
    if (url) return url;
    lastErr = _lastGenerateVideoError || '';
    if (lastErr && !/model.*无效|invalid model|不支持|not support/i.test(lastErr)) break;
  }
  _lastGenerateVideoError = lastErr || '80ai 视频生成失败，请在设置填写视频模型（如 veo3_fast）';
  return null;
}

function buildVideoGenerationEndpoints(baseUrl) {
  const u = normalizeImageApiBase(baseUrl);
  return [
    `${u}/videos/generations`,
    `${u}/video/generations`,
    `${u}/videos`,
  ].filter((p, i, arr) => arr.indexOf(p) === i);
}

function buildVideoStatusEndpoints(baseUrl, taskId) {
  const u = normalizeImageApiBase(baseUrl);
  const id = encodeURIComponent(taskId);
  return [
    `${u}/videos/${id}`,
    `${u}/videos/generations/${id}`,
    `${u}/video/generations/${id}`,
    `${u}/tasks/${id}`,
  ];
}

function extractOpenAiVideoUrl(data) {
  if (!data) return null;
  if (typeof data.output === 'string' && /^https?:\/\//i.test(data.output)) return data.output;
  return data.video_url
    || data.url
    || data.output?.url
    || (Array.isArray(data.output) && (typeof data.output[0] === 'string' ? data.output[0] : (data.output[0]?.url || data.output[0]?.video_url)))
    || (Array.isArray(data.data) && (data.data[0]?.url || data.data[0]?.video_url))
    || null;
}

async function pollOpenAiVideoTask(settings, baseUrl, taskId, { maxWaitMs = 300000, intervalMs = 5000 } = {}) {
  const apiKey = String(settings.image_api_key || '').trim();
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    for (const endpoint of buildVideoStatusEndpoints(baseUrl, taskId)) {
      try {
        const resp = await fetch(endpoint, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 30000,
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const url = extractOpenAiVideoUrl(data);
        const status = String(data.status || data.state || '').toLowerCase();
        if (url && /completed|succeed|success|done/.test(status)) return url;
        if (/failed|error|cancelled/.test(status)) {
          _lastGenerateVideoError = data.error?.message || data.message || '视频任务失败';
          return null;
        }
      } catch (e) {
        console.warn('[generateVideo] poll', endpoint, e.message);
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  _lastGenerateVideoError = '视频生成超时，请稍后重试';
  return null;
}

async function generateVideoViaOpenAICompat(settings, prompt) {
  const baseUrl = normalizeImageApiBase(settings.image_api_url);
  const apiKey = String(settings.image_api_key || '').trim();
  const model = (settings.video_model || '').trim() || 'veo3_fast';
  const body = { prompt: String(prompt || '').trim(), model, duration: 5, size: '1280x720' };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  let lastErr = '';
  for (const endpoint of buildVideoGenerationEndpoints(baseUrl)) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeout: 120000,
      });
      const raw = await resp.text().catch(() => '');
      if (!resp.ok) {
        lastErr = formatImageGenApiError(`HTTP ${resp.status}: ${raw.slice(0, 300)}`);
        continue;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        lastErr = '视频 API 返回非 JSON';
        continue;
      }
      const immediate = extractOpenAiVideoUrl(data);
      if (immediate) {
        _lastGenerateVideoMeta = { model, mode: 'generate' };
        return immediate;
      }
      const taskId = data.id || data.task_id || data.data?.id;
      if (taskId) {
        const url = await pollOpenAiVideoTask(settings, baseUrl, taskId);
        if (url) {
          _lastGenerateVideoMeta = { model, mode: 'generate' };
          return url;
        }
        lastErr = _lastGenerateVideoError || lastErr;
        continue;
      }
      lastErr = '视频 API 未返回 task id 或 URL';
    } catch (e) {
      lastErr = e.message;
    }
  }
  _lastGenerateVideoError = lastErr || '视频生成失败，请确认 API 支持文生视频';
  return null;
}

/** 文生视频：与 generateImage 共用 image_api_url / image_api_key */
async function generateVideo(settings, prompt) {
  _lastGenerateVideoError = '';
  _lastGenerateVideoMeta = { model: '', mode: '' };
  const url = (settings.image_api_url || '').trim();
  const apiKey = (settings.image_api_key || '').trim();
  if (!url || !apiKey) {
    _lastGenerateVideoError = '请先在设置中填写图像/视频 API 地址和 Key';
    return null;
  }
  if (is80AiImageApi(url)) return generateVideoVia80Ai(settings, prompt);
  return generateVideoViaOpenAICompat(settings, prompt);
}

function isHiApiVideoApi(url, model) {
  return detectImg2VideoProtocol(url, model) === 'hiapi';
}

/** 独立图生视频 API（任意中转：自动识别 /v1/tasks 或 /v1/videos）；未配置时返回 null */
function resolveImg2VideoConfig(settings) {
  const url = String(settings?.img2video_api_url || '').trim();
  const key = String(settings?.img2video_api_key || '').trim();
  if (!url || !key) return null;
  let model = String(settings?.img2video_model || '').trim();
  const protocolHint = detectImg2VideoProtocol(url, model);
  if (!model) {
    model = protocolHint === 'openai-videos' ? 'sora-2' : 'kling-3.0-omni/image-to-video';
  }
  const protocol = detectImg2VideoProtocol(url, model);
  const hiapi = protocol === 'hiapi';
  let seconds = String(settings?.img2video_seconds || '').trim();
  if (!seconds) seconds = protocol === 'openai-videos' ? '4' : '5';
  if (protocol === 'openai-videos' && !/^(4|6|8|12)$/.test(seconds)) {
    seconds = '4';
  } else {
    const n = parseInt(seconds, 10);
    if (!Number.isFinite(n)) seconds = '5';
  }
  // 默认保留音轨（靠提示词只要环境音）；仅当设置「去掉音轨」时 ffmpeg 全静音
  const stripAudio = settings?.img2video_strip_audio === '1';
  return { url, key, model, seconds, stripAudio, hiapi, protocol };
}

function resolveHiApiDuration(seconds, model) {
  let n = parseInt(seconds, 10);
  if (!Number.isFinite(n) || n <= 0) n = /veo/i.test(model) ? 4 : 5;
  if (/veo/i.test(model)) {
    if (n <= 4) return 4;
    if (n <= 6) return 6;
    return 8;
  }
  if (/seedance/i.test(model)) {
    if (n < 4) n = 4;
    if (n > 15) n = 15;
    return n;
  }
  // Kling 文档：3–15 秒；Wan 等可 2 秒起
  if (/kling/i.test(model)) {
    if (n < 3) n = 3;
  } else if (n < 2) {
    n = 2;
  }
  if (n > 15) n = 15;
  return n;
}

function aspectToHiApiAspect(aspect) {
  const a = normalizeSelfieAspect(aspect || '9:16');
  if (a === '16:9' || a === '4:3') return '16:9';
  if (a === '9:16' || a === '3:4' || a === '1:1') return '9:16';
  return 'auto';
}

/** 图生视频只取 1 张锚点图：优先正脸 → 身体 → 手部 */
function selectVideoReferenceUrl(imageRefRaw) {
  const g = normalizeImageRefGroups(imageRefRaw);
  return g.face[0] || g.body[0] || g.hands[0] || null;
}

function normalizeVideoApiBase(url) {
  let u = normalizeImageApiBase(url);
  if (!u) return u;
  u = u.replace(/\/video\/generations$/i, '').replace(/\/+$/, '');
  u = u.replace(/\/videos\/?$/i, '').replace(/\/+$/, '');
  return u;
}

function buildVideoCreateEndpoints(baseUrl) {
  const u = normalizeVideoApiBase(baseUrl);
  if (!u) return [];
  if (u.endsWith('/v1')) return [`${u}/videos`];
  return [`${u}/v1/videos`, `${u}/videos`];
}

function pickSoraVideoSize(width, height, model) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const portrait = h >= w;
  const isPro = /sora-2-pro|pro/i.test(String(model || ''));
  if (portrait) {
    if (isPro && h >= 1600) return '1080x1920';
    if (isPro && h >= 1400) return '1024x1792';
    return '720x1280';
  }
  if (isPro && w >= 1600) return '1920x1080';
  if (isPro && w >= 1400) return '1792x1024';
  return '1280x720';
}

/** 角色可选比例 → Sora/Veo 像素 size（无 1:1，方形用竖屏） */
function aspectToSoraVideoSize(aspect, model) {
  const a = normalizeSelfieAspect(aspect || '9:16');
  const isPro = /sora-2-pro|pro/i.test(String(model || ''));
  if (a === '16:9') return isPro ? '1920x1080' : '1280x720';
  if (a === '4:3') return '1280x720';
  if (a === '9:16') return isPro ? '1080x1920' : '720x1280';
  if (a === '3:4') return '720x1280';
  if (a === '1:1') return '720x1280';
  return '720x1280';
}

async function resizeImageBufferToVideoSize(buffer, sizeStr) {
  const m = String(sizeStr || '').match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error(`无效视频尺寸: ${sizeStr}`);
  const tw = parseInt(m[1], 10);
  const th = parseInt(m[2], 10);
  const sharp = require('sharp');
  const meta = await sharp(buffer).metadata();
  if (meta.width === tw && meta.height === th) {
    const fmt = meta.format === 'png' ? 'png' : meta.format === 'webp' ? 'webp' : 'jpeg';
    return {
      buffer,
      contentType: fmt === 'png' ? 'image/png' : fmt === 'webp' ? 'image/webp' : 'image/jpeg',
      ext: fmt === 'png' ? 'png' : fmt === 'webp' ? 'webp' : 'jpg',
      width: tw,
      height: th,
    };
  }
  const out = await sharp(buffer)
    .resize(tw, th, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { buffer: out, contentType: 'image/jpeg', ext: 'jpg', width: tw, height: th };
}

function saveGeneratedVideoLocally(buffer) {
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  return `/uploads/${filename}`;
}

/**
 * 去掉图生视频自带音轨（Sora/Veo 嗓音对不上角色 TTS）。
 * 需要本机有 ffmpeg；失败则保留原片。
 */
async function stripVideoAudioTrack(localUrl) {
  const rel = String(localUrl || '').trim();
  if (!rel.startsWith('/uploads/')) return rel;
  const uploadsDir = path.join(__dirname, 'uploads');
  const inputPath = path.join(uploadsDir, path.basename(rel));
  if (!fs.existsSync(inputPath)) return rel;
  const outName = `vid_silent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
  const outputPath = path.join(uploadsDir, outName);
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      '-an', '-c:v', 'copy',
      outputPath,
    ], { timeout: 120000 });
    try { fs.unlinkSync(inputPath); } catch {}
    console.log('[generateVideo/img2video] stripped audio →', outName);
    return `/uploads/${outName}`;
  } catch (e) {
    console.warn('[generateVideo/img2video] strip audio failed, keep original:', e.message);
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    return rel;
  }
}

async function downloadOpenAiVideoContent(baseUrl, apiKey, videoId) {
  const roots = [];
  const u = normalizeVideoApiBase(baseUrl);
  if (u.endsWith('/v1')) roots.push(u);
  else {
    roots.push(`${u}/v1`, u);
  }
  let lastErr = '';
  for (const root of [...new Set(roots)]) {
    const endpoint = `${root}/videos/${encodeURIComponent(videoId)}/content`;
    try {
      const resp = await fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 120000,
      });
      if (!resp.ok) {
        const raw = await resp.text().catch(() => '');
        lastErr = `下载视频 HTTP ${resp.status}: ${raw.slice(0, 200)}`;
        continue;
      }
      const buf = await resp.buffer();
      if (buf && buf.length > 1000) return buf;
      lastErr = '下载的视频文件过小或为空';
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  _lastGenerateVideoError = lastErr || '视频下载失败';
  return null;
}

function buildImg2VideoMotionPrompt(prompt, customMotionPrompt, { nsfw = false } = {}) {
  const aesthetic = String(customMotionPrompt || '').trim()
    || (nsfw ? DEFAULT_NSFW_VIDEO_MOTION_PROMPT : DEFAULT_VIDEO_MOTION_PROMPT);
  const rawScene = String(prompt || '').trim();
  // NSFW 不做表情柔化：场景若真写了 parted lips 应保留；没写则下面默认跟日常一样克制
  const scene = nsfw ? rawScene : softenSmileInSceneQuery(rawScene);
  // 场景动作在前；NSFW 跟日常同一套随手拍动感，不另加浪叫脸
  if (nsfw) {
    return [
      scene || 'Generate a short phone video that starts from this still as the first frame',
      'the first frame must match this still: face, hair, body and layout',
      'animate with the same quiet phone-video motion as a daily clip; extra body motion only if the scene asks',
      'keep expression from the still; do not add a default sexy face',
      aesthetic,
    ].filter(Boolean).join('. ');
  }
  return [
    scene || 'Generate a short phone video that starts from this still as the first frame',
    'the first frame must match this still: face, hair, outfit and layout',
    'lock facial expression to the still: do not make the smile bigger or more excited over time',
    'no open mouth, no laughter, no exaggerated anime expression',
    aesthetic,
  ].filter(Boolean).join('. ');
}

async function finalizeImg2VideoLocal(cfg, localUrl, meta = {}) {
  let out = localUrl;
  if (cfg.stripAudio) out = await stripVideoAudioTrack(out);
  _lastGenerateVideoMeta = {
    model: cfg.model,
    mode: meta.mode || 'img2video',
    size: meta.size || '',
    strippedAudio: !!cfg.stripAudio,
  };
  _lastGenerateVideoError = '';
  return out;
}

function isHiApiVeoVideoModel(model) {
  return /veo/i.test(String(model || ''));
}

function isHiApiWanVideoModel(model) {
  return /wan2|wan-2|wanx/i.test(String(model || ''));
}

function isHiApiImageAccessError(msg) {
  return /download|fetch|retriev|access.+(url|image)|image.?(url|urls)|invalid.+(image|url)|cannot.+(load|get|read|access).*(image|url)|url.+(invalid|unreachable|not found|timed? ?out)|data\s*uri|base64|公网|内网|localhost|not a valid url|must be a url|media\[|first_frame|last_frame/i.test(String(msg || ''));
}

function isHiApiVideoSchemaError(msg) {
  const t = String(msg || '');
  return /additional properties?|not allowed|required property|is required|must have required|unknown field|unrecognized|invalid.+input|schema/i.test(t)
    || /\b(image_urls|image_url|first_frame_url|last_frame_url|image_tail|media|generate_audio|sound|aspect_ratio)\b/i.test(t);
}

const HIAPI_VIDEO_IMAGE_FIELDS = [
  'image_urls', 'image_url', 'first_frame_url', 'media',
  'last_frame_url', 'last_image_url', 'image_tail', 'end_image',
];

/** 静图当图生视频起始帧。各家字段名不同，失败再轮换；终帧字段只作兼容回退。 */
function preferredHiApiVideoImageFields(model) {
  const m = String(model || '');
  if (isHiApiVeoVideoModel(m)) return ['image_url', 'image_urls', 'media', 'last_frame_url'];
  if (isHiApiWanVideoModel(m)) return ['media', 'first_frame_url', 'image_urls', 'last_frame_url'];
  if (/seedance/i.test(m)) return ['first_frame_url', 'image_urls', 'media', 'last_frame_url'];
  if (/kling/i.test(m)) return ['image_urls', 'image_url', 'first_frame_url', 'image_tail', 'media'];
  return ['image_urls', 'image_url', 'first_frame_url', 'media', 'last_frame_url', 'image_tail'];
}

function detectHiApiVideoImageFieldHint(errText) {
  const t = String(errText || '');
  if (/\bmedia\b/i.test(t) && /required|must|missing|need/i.test(t)) return 'media';
  if (/image_urls/i.test(t)) return 'image_urls';
  if (/\bimage_url\b/i.test(t)) return 'image_url';
  if (/first_frame_url/i.test(t)) return 'first_frame_url';
  if (/last_frame_url|last_image_url/i.test(t)) return 'last_frame_url';
  if (/image_tail/i.test(t)) return 'image_tail';
  if (/end_image/i.test(t)) return 'end_image';
  if (/required property|is required|must have required/i.test(t)) return 'next';
  return null;
}

function buildHiApiImg2VideoBaseInput(model, { prompt, aspect, duration, wantSound = false } = {}) {
  const m = String(model || '');
  const text = String(prompt || '').slice(0, 800);
  if (isHiApiVeoVideoModel(m)) {
    return {
      prompt: text,
      aspect_ratio: aspectToHiApiAspect(aspect),
      resolution: '720p',
      duration,
      generate_audio: !!wantSound,
      negative_prompt: 'human voice, speech, talking, dialogue, singing, watermark, lens distortion, wide-angle face warp, fisheye, stretched face, thin face, beauty filter, cinematic grading, studio lighting, expression overacting, uncanny exaggerated face, wide toothy grin, big smile with mouth wide open, laughing mouth stretched, exaggerated smile showing all teeth, cute aegyo face, sparkling eyes, open mouth, talking mouth, emotional overacting, cartoonish exaggerated expression',
    };
  }
  if (isHiApiWanVideoModel(m)) {
    return {
      prompt: text,
      resolution: '720P',
      duration,
      prompt_extend: false,
      watermark: false,
    };
  }
  if (/seedance/i.test(m)) {
    return {
      prompt: text,
      resolution: '720p',
      duration,
      generate_audio: !!wantSound,
    };
  }
  const input = {
    prompt: text,
    resolution: '720p',
    duration,
    // 部分中转支持；不支持会被 postHiApiVideoTask 自动丢掉
    negative_prompt: 'exaggerated expression, wide toothy grin, open mouth, laughing, talking mouth, cute aegyo, sparkling eyes, beauty filter, face warp, stretched face',
  };
  if (wantSound && /kling/i.test(m) && /omni/i.test(m)) input.sound = true;
  return input;
}

function applyHiApiVideoImageField(input, publicUrl, kind) {
  delete input.image_urls;
  delete input.image_url;
  delete input.image;
  delete input.images;
  delete input.input_urls;
  delete input.media;
  delete input.first_frame_url;
  delete input.last_frame_url;
  delete input.last_image_url;
  delete input.image_tail;
  delete input.end_image;
  delete input.reference_image_urls;
  if (kind === 'image_urls') input.image_urls = [publicUrl];
  else if (kind === 'image_url') input.image_url = publicUrl;
  else if (kind === 'first_frame_url') input.first_frame_url = publicUrl;
  else if (kind === 'last_frame_url') input.last_frame_url = publicUrl;
  else if (kind === 'last_image_url') input.last_image_url = publicUrl;
  else if (kind === 'image_tail') input.image_tail = publicUrl;
  else if (kind === 'end_image') input.end_image = publicUrl;
  else if (kind === 'media') input.media = [{ type: 'first_frame', url: publicUrl }];
  else if (kind === 'media_last') input.media = [{ type: 'last_frame', url: publicUrl }];
  return input;
}

function listHiApiImg2VideoInputVariants(model, opts) {
  const base = buildHiApiImg2VideoBaseInput(model, opts);
  return preferredHiApiVideoImageFields(model).map((kind) => ({
    kind,
    input: applyHiApiVideoImageField({ ...base }, opts.publicUrl, kind),
  }));
}

async function postHiApiVideoTask(cfg, endpoint, model, input) {
  let lastErr = '';
  for (let i = 0; i < 6; i++) {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input }),
      timeout: 60000,
    });
    const raw = await resp.text().catch(() => '');
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    const errText = String(data?.message || data?.error?.message || raw || '');

    if (!resp.ok) {
      const rejectExtra = /additional properties?\s+'([^']+)'\s+not allowed/i.exec(errText);
      if (rejectExtra) {
        const badKey = rejectExtra[1];
        if (badKey && Object.prototype.hasOwnProperty.call(input, badKey)) {
          if (HIAPI_VIDEO_IMAGE_FIELDS.includes(badKey) || badKey === 'media') {
            lastErr = errText;
            return { ok: false, err: lastErr, errText };
          }
          console.warn(`[generateVideo/hiapi] drop unsupported field: ${badKey}`);
          delete input[badKey];
          continue;
        }
      }
      if (/720P|1080P|480P/i.test(errText) && typeof input.resolution === 'string') {
        const cur = input.resolution;
        const flipped = /[A-Z]$/.test(cur) ? cur.toLowerCase() : cur.replace(/p$/i, 'P');
        if (flipped !== cur) {
          console.warn(`[generateVideo/hiapi] resolution ${cur} → ${flipped}`);
          input.resolution = flipped;
          continue;
        }
      }
      lastErr = formatImageGenApiError(`HTTP ${resp.status}: ${raw.slice(0, 400)}`)
        || data?.message || `HiAPI 创建任务失败 HTTP ${resp.status}`;
      return { ok: false, err: lastErr, errText };
    }
    const taskId = data?.data?.taskId || data?.taskId || data?.data?.id || data?.id;
    if (!taskId) {
      return { ok: false, err: `HiAPI 未返回 taskId: ${raw.slice(0, 200)}`, errText };
    }
    return { ok: true, taskId };
  }
  return { ok: false, err: lastErr || 'HiAPI 创建任务失败', errText: lastErr };
}

async function persistVideoRefBuffer(buffer, ext, { publicBase } = {}) {
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = `vidref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  const localPath = `/uploads/${filename}`;
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  let dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  dataUrl = await compressImageDataUrlForHiApi(dataUrl, 2 * 1024 * 1024);
  const abs = toAbsoluteMediaUrl(localPath, publicBase);
  const httpsUrl = (abs && /^https:\/\//i.test(abs) && !isPrivateOrLocalMediaUrl(abs)) ? abs : '';
  return { localPath, publicUrl: dataUrl, dataUrl, httpsUrl };
}

/**
 * 把本地参考图裁到目标比例并落盘。
 * 图生视频优先内嵌 data URI（手机/局域网时 HiAPI 拉不到你的网站，与图生图一致）；
 * 若有公网 https 地址则一并返回，创建失败时再换 URL 重试。
 */
async function preparePublicReferenceImageUrl(referenceImageUrl, { aspect, publicBase, model } = {}) {
  const part = await loadImageAsUploadPart(referenceImageUrl);
  if (!part?.buffer) {
    _lastGenerateVideoError = '参考图读取失败，请确认形象参考图已上传';
    return null;
  }

  const size = aspect
    ? aspectToSoraVideoSize(aspect, model || 'sora-2')
    : aspectToSoraVideoSize('9:16', model || 'sora-2');
  let prepared;
  try {
    prepared = await resizeImageBufferToVideoSize(part.buffer, size);
  } catch (e) {
    _lastGenerateVideoError = `参考图缩放失败: ${e.message}`;
    return null;
  }

  const saved = await persistVideoRefBuffer(prepared.buffer, prepared.ext, { publicBase });
  console.log(
    `[img2video/hiapi] first-frame prepared size=${size} dataURI=~${Math.round(saved.dataUrl.length * 0.75 / 1024)}KB https=${saved.httpsUrl ? 'yes' : 'no'}`
  );
  return { ...saved, size };
}

/**
 * HiAPI 统一任务：POST /v1/tasks → GET /v1/tasks/:id → output[].url
 * 静图当起始帧：按模型优先 image_urls / image_url / first_frame_url / media.first_frame，失败再轮换
 */
async function generateImageToVideoViaHiApi(settings, { prompt, referenceImageUrl, aspect, publicBase, motionPromptCustom, nsfw } = {}) {
  const rawCfg = resolveImg2VideoConfig(settings);
  if (!rawCfg) return null;
  const cfg = {
    ...rawCfg,
    model: img2VideoModelForProtocol(rawCfg.model, 'hiapi'),
    hiapi: true,
  };

  const prepared = await preparePublicReferenceImageUrl(referenceImageUrl, {
    aspect,
    publicBase,
    model: cfg.model,
  });
  if (!prepared) return null;

  const motionPrompt = buildImg2VideoMotionPrompt(prompt, motionPromptCustom, { nsfw: !!nsfw });
  const duration = resolveHiApiDuration(cfg.seconds, cfg.model);
  const variantOpts = {
    prompt: motionPrompt,
    aspect,
    duration,
    wantSound: false,
  };

  const imageCandidates = [];
  const dataUrl = prepared.dataUrl || prepared.publicUrl;
  if (dataUrl) imageCandidates.push({ kind: 'data-uri', url: dataUrl });
  if (prepared.httpsUrl && prepared.httpsUrl !== dataUrl) {
    imageCandidates.push({ kind: 'https', url: prepared.httpsUrl });
  }

  const roots = [];
  const u = normalizeVideoApiBase(cfg.url);
  if (u.endsWith('/v1')) roots.push(u);
  else roots.push(`${u}/v1`, u);

  let lastErr = '';
  for (const img of imageCandidates) {
    const queue = listHiApiImg2VideoInputVariants(cfg.model, { ...variantOpts, publicUrl: img.url });
    const tried = new Set();
    let skipImage = false;
    while (queue.length && !skipImage) {
      const variant = queue.shift();
      if (tried.has(variant.kind)) continue;
      tried.add(variant.kind);
      for (const root of [...new Set(roots)]) {
        const endpoint = `${root}/tasks`;
        const input = JSON.parse(JSON.stringify(variant.input));
        try {
          console.log(`[generateVideo/hiapi] ${endpoint} model=${cfg.model} duration=${duration} ref=${img.kind} field=${variant.kind}`);
          const created = await postHiApiVideoTask(cfg, endpoint, cfg.model, input);
          if (!created.ok) {
            lastErr = created.err;
            console.error('[generateVideo/hiapi]', endpoint, lastErr);
            if (isApiBillingError(lastErr)) {
              _lastGenerateVideoError = lastErr;
              return null;
            }
            if (isHiApiImageAccessError(lastErr) && !isHiApiVideoSchemaError(lastErr)) {
              skipImage = true;
              break;
            }
            const hint = detectHiApiVideoImageFieldHint(created.errText || lastErr);
            if (hint && hint !== variant.kind) {
              if (hint !== 'next' && !tried.has(hint)) {
                const extra = applyHiApiVideoImageField(
                  buildHiApiImg2VideoBaseInput(cfg.model, variantOpts),
                  img.url,
                  hint
                );
                queue.unshift({ kind: hint, input: extra });
              }
              break;
            }
            continue;
          }
          const polled = await pollHiApiTask(cfg, created.taskId, { maxWaitMs: 600000, intervalMs: 5000 });
          if (!polled?.localUrl) {
            lastErr = _lastGenerateVideoError || 'HiAPI 任务失败';
            if (isHiApiImageAccessError(lastErr)) {
              skipImage = true;
              break;
            }
            continue;
          }
          return finalizeImg2VideoLocal(cfg, polled.localUrl, {
            mode: 'hiapi/tasks',
            size: prepared.size,
          });
        } catch (e) {
          lastErr = e.message || String(e);
          console.error('[generateVideo/hiapi]', endpoint, lastErr);
        }
      }
    }
  }
  if (lastErr && !prepared.httpsUrl && /data.?uri|base64|url|image/i.test(lastErr)) {
    lastErr = `${lastErr}。手机网页/局域网访问时静图已内嵌 base64；若模型只接受公网图片地址，请用公网 HTTPS 打开本站后再试`;
  }
  _lastGenerateVideoError = lastErr || 'HiAPI 图生视频失败';
  return null;
}

async function pollHiApiTask(cfg, taskId, { maxWaitMs = 600000, intervalMs = 5000, media = 'video' } = {}) {
  const started = Date.now();
  const roots = [];
  const base = media === 'image' ? normalizeImageApiBase(cfg.url) : normalizeVideoApiBase(cfg.url);
  if (base.endsWith('/v1')) roots.push(base);
  else roots.push(`${base}/v1`, base);
  const logTag = media === 'image' ? 'generateImage/hiapi' : 'generateVideo/hiapi';
  const setErr = (msg) => {
    if (media === 'image') _lastGenerateImageError = msg;
    else _lastGenerateVideoError = msg;
  };

  const pickRemoteUrl = (outputs, data, wantImage) => {
    const list = Array.isArray(outputs) ? outputs : [];
    const typed = list.find(o => wantImage
      ? /image|jpg|png|webp|jpeg/i.test(String(o?.type || o?.mime || ''))
      : /video|mp4/i.test(String(o?.type || o?.mime || '')));
    const first = typed || list[0];
    if (!first) return wantImage ? (extractImageResultFromApiData(data) || '') : '';
    if (typeof first === 'string') return first;
    return first.url || first.image_url || first.video_url || first.b64_json || first.base64 || '';
  };

  while (Date.now() - started < maxWaitMs) {
    for (const root of [...new Set(roots)]) {
      const endpoint = `${root}/tasks/${encodeURIComponent(taskId)}`;
      try {
        const resp = await fetch(endpoint, {
          method: 'GET',
          headers: { Authorization: `Bearer ${cfg.key}` },
          timeout: 30000,
        });
        if (!resp.ok) continue;
        const raw = await resp.json();
        const data = raw?.data || raw;
        const status = String(data.status || '').toLowerCase();
        console.log(`[${logTag}] poll ${taskId} ${status}`);
        if (status === 'fail' || status === 'failed') {
          const msg = data.error?.message || data.message || raw?.message || data.error?.code || 'HiAPI 任务失败';
          setErr(String(msg).slice(0, 300));
          console.error(`[${logTag}] task fail:`, String(msg).slice(0, 200));
          return null;
        }
        if (status === 'success' || status === 'succeeded' || status === 'completed') {
          const outputs = Array.isArray(data.output) ? data.output : [];
          if (media === 'image') {
            let remote = pickRemoteUrl(outputs, data, true);
            if (remote && !/^https?:\/\//i.test(remote) && !remote.startsWith('data:')
              && /^[A-Za-z0-9+/=]+$/.test(remote) && remote.length > 200) {
              remote = `data:image/png;base64,${remote}`;
            }
            if (remote && remote.startsWith('data:')) {
              const part = await loadImageAsUploadPart(remote);
              if (!part?.buffer) {
                setErr('HiAPI 返回了图片数据但无法解析');
                return null;
              }
              return { localUrl: saveGeneratedImageLocally(part.buffer, part.ext) };
            }
            if (!remote || !/^https?:\/\//i.test(remote)) {
              setErr(`HiAPI 成功但未返回图片 URL（output=${JSON.stringify(outputs).slice(0, 180)}）`);
              return null;
            }
            const dl = await fetch(remote, { timeout: 180000 });
            if (!dl.ok) {
              setErr(`下载 HiAPI 图片失败 HTTP ${dl.status}`);
              return null;
            }
            const buf = await dl.buffer();
            if (!buf?.length) {
              setErr('下载 HiAPI 图片为空');
              return null;
            }
            const ct = String(dl.headers.get('content-type') || '');
            const ext = /webp/i.test(ct) || /\.webp(\?|$)/i.test(remote) ? 'webp'
              : /jpe?g/i.test(ct) || /\.jpe?g(\?|$)/i.test(remote) ? 'jpg'
                : 'png';
            console.log(`[${logTag}] saved image ${Math.round(buf.length / 1024)}KB as .${ext}`);
            return { localUrl: saveGeneratedImageLocally(buf, ext) };
          }
          let remote = pickRemoteUrl(outputs, data, false) || extractOpenAiVideoUrl(data);
          if (!remote || !/^https?:\/\//i.test(remote)) {
            setErr('HiAPI 成功但未返回视频 URL');
            return null;
          }
          const dl = await fetch(remote, { timeout: 180000 });
          if (!dl.ok) {
            setErr(`下载 HiAPI 视频失败 HTTP ${dl.status}`);
            return null;
          }
          const buf = await dl.buffer();
          return { localUrl: saveGeneratedVideoLocally(buf) };
        }
      } catch (e) {
        console.warn(`[${logTag}] poll`, e.message);
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  setErr(media === 'image'
    ? 'HiAPI 图生图超时（已等约 15 分钟）。对方可能仍在出图并已扣费，请先到控制台确认，不要立刻点重试。'
    : 'HiAPI 图生视频超时，请稍后重试');
  return null;
}

/**
 * 图生视频入口：自动识别 HiAPI /v1/tasks 或 OpenAI /v1/videos，协议不对会换一种再试。
 */
async function generateImageToVideo(settings, { prompt, referenceImageUrl, aspect, publicBase, motionPromptCustom, nsfw } = {}) {
  _lastGenerateVideoError = '';
  _lastGenerateVideoMeta = { model: '', mode: '' };
  const nsfwHit = inferNsfwMediaRequest({ nsfw, motionPromptCustom }, prompt);
  settings = routeSettingsForMediaGen(settings);
  const cfg = resolveImg2VideoConfig(settings);
  if (!cfg) {
    _lastGenerateVideoError = '请先在设置中填写图生视频 API 地址和 Key';
    return null;
  }
  const ref = String(referenceImageUrl || '').trim();
  if (!ref) {
    _lastGenerateVideoError = '图生视频需要角色形象参考图（角色编辑 → 正脸）';
    return null;
  }

  const protocol = cfg.protocol || detectImg2VideoProtocol(cfg.url, cfg.model);
  const order = img2VideoProtocolOrder(protocol);
  const args = { prompt, referenceImageUrl: ref, aspect, publicBase, motionPromptCustom, nsfw: nsfwHit };
  let lastErr = '';
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    console.log(`[generateVideo/img2video] try protocol=${p} (${i + 1}/${order.length}) url=${cfg.url} model=${cfg.model}`);
    const result = p === 'hiapi'
      ? await generateImageToVideoViaHiApi(settings, args)
      : await generateImageToVideoViaOpenAi(settings, args);
    if (result) return result;
    lastErr = _lastGenerateVideoError || lastErr;
    if (!shouldTryNextMediaProtocol(lastErr, protocol, i === order.length - 1)) break;
    console.warn(`[generateVideo/img2video] ${p} 未通，换协议再试: ${(lastErr || '').slice(0, 120)}`);
  }
  if (lastErr) _lastGenerateVideoError = lastErr;
  return null;
}

async function generateImageToVideoViaOpenAi(settings, { prompt, referenceImageUrl, aspect, motionPromptCustom, nsfw } = {}) {
  const baseCfg = resolveImg2VideoConfig(settings);
  if (!baseCfg) return null;
  const cfg = {
    ...baseCfg,
    model: img2VideoModelForProtocol(baseCfg.model, 'openai-videos'),
  };
  const ref = String(referenceImageUrl || '').trim();

  const part = await loadImageAsUploadPart(ref);
  if (!part?.buffer) {
    _lastGenerateVideoError = '参考图读取失败，请确认形象参考图已上传';
    return null;
  }

  let resolvedSize = aspect ? aspectToSoraVideoSize(aspect, cfg.model) : '';
  if (!resolvedSize) {
    try {
      const sharp = require('sharp');
      const meta = await sharp(part.buffer).metadata();
      resolvedSize = pickSoraVideoSize(meta.width || 0, meta.height || 0, cfg.model);
    } catch {
      resolvedSize = aspectToSoraVideoSize('9:16', cfg.model);
    }
  }

  let prepared;
  try {
    prepared = await resizeImageBufferToVideoSize(part.buffer, resolvedSize);
  } catch (e) {
    _lastGenerateVideoError = `参考图缩放失败: ${e.message}`;
    return null;
  }

  const motionPrompt = buildImg2VideoMotionPrompt(prompt, motionPromptCustom, { nsfw: !!nsfw });
  const FormData = require('form-data');
  let lastErr = '';
  const refFieldOrder = ['input_reference', 'image', 'first_frame', 'last_frame'];

  for (const endpoint of buildVideoCreateEndpoints(cfg.url)) {
    for (const refField of refFieldOrder) {
    try {
      const form = new FormData();
      form.append('model', cfg.model);
      form.append('prompt', motionPrompt.slice(0, 800));
      form.append('seconds', String(cfg.seconds));
      form.append('size', resolvedSize);
      form.append(refField, prepared.buffer, {
        filename: `ref.${prepared.ext}`,
        contentType: prepared.contentType,
      });

      console.log(`[generateVideo/img2video] ${endpoint} model=${cfg.model} size=${resolvedSize} seconds=${cfg.seconds} ref=${refField}`);
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.key}`, ...form.getHeaders() },
        body: form,
        timeout: 120000,
      });
      const raw = await resp.text().catch(() => '');
      if (!resp.ok) {
        lastErr = formatImageGenApiError(`HTTP ${resp.status}: ${raw.slice(0, 400)}`)
          || `图生视频失败 HTTP ${resp.status}`;
        console.error('[generateVideo/img2video]', endpoint, lastErr);
        continue;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        lastErr = `图生视频返回非 JSON：${raw.slice(0, 200)}`;
        continue;
      }

      const immediate = extractOpenAiVideoUrl(data);
      if (immediate && /^https?:\/\//i.test(immediate)) {
        try {
          const dl = await fetch(immediate, { timeout: 120000 });
          if (dl.ok) {
            const buf = await dl.buffer();
            return finalizeImg2VideoLocal(cfg, saveGeneratedVideoLocally(buf), {
              mode: 'videos',
              size: resolvedSize,
            });
          }
        } catch (e) {
          console.warn('[generateVideo/img2video] direct url download', e.message);
        }
      }

      const taskId = data.id || data.task_id || data.data?.id;
      if (!taskId) {
        lastErr = '图生视频未返回任务 id';
        continue;
      }

      const polled = await pollOpenAiStyleVideoTask(cfg, taskId, { maxWaitMs: 600000, intervalMs: 8000 });
      if (!polled) {
        lastErr = _lastGenerateVideoError || '图生视频轮询失败';
        continue;
      }
      if (polled.localUrl) {
        return finalizeImg2VideoLocal(cfg, polled.localUrl, { mode: 'videos', size: resolvedSize });
      }
      lastErr = _lastGenerateVideoError || '图生视频完成但无法下载';
    } catch (e) {
      lastErr = e.message || String(e);
      console.error('[generateVideo/img2video]', endpoint, lastErr);
    }
    if (isApiBillingError(lastErr)) break;
    }
    if (isApiBillingError(lastErr)) break;
  }

  _lastGenerateVideoError = lastErr || '图生视频 API 调用失败';
  return null;
}

async function pollOpenAiStyleVideoTask(cfg, taskId, { maxWaitMs = 600000, intervalMs = 8000 } = {}) {
  const started = Date.now();
  const roots = [];
  const u = normalizeVideoApiBase(cfg.url);
  if (u.endsWith('/v1')) roots.push(u);
  else roots.push(`${u}/v1`, u);

  while (Date.now() - started < maxWaitMs) {
    for (const root of [...new Set(roots)]) {
      const endpoint = `${root}/videos/${encodeURIComponent(taskId)}`;
      try {
        const resp = await fetch(endpoint, {
          method: 'GET',
          headers: { Authorization: `Bearer ${cfg.key}` },
          timeout: 30000,
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const status = String(data.status || data.state || '').toLowerCase();
        const progress = data.progress ?? data.percent ?? '';
        if (progress !== '' && progress !== undefined) {
          console.log(`[generateVideo/img2video] poll ${taskId} ${status} ${progress}%`);
        }
        if (/failed|error|cancelled|canceled/.test(status)) {
          _lastGenerateVideoError = data.error?.message || data.message || '图生视频任务失败';
          return null;
        }
        if (/completed|succeed|success|done/.test(status)) {
          const remote = extractOpenAiVideoUrl(data);
          if (remote && /^https?:\/\//i.test(remote)) {
            try {
              const dl = await fetch(remote, { timeout: 120000 });
              if (dl.ok) {
                const buf = await dl.buffer();
                return { localUrl: saveGeneratedVideoLocally(buf) };
              }
            } catch (e) {
              console.warn('[generateVideo/img2video] remote download', e.message);
            }
          }
          const buf = await downloadOpenAiVideoContent(cfg.url, cfg.key, taskId);
          if (buf) return { localUrl: saveGeneratedVideoLocally(buf) };
          return null;
        }
      } catch (e) {
        console.warn('[generateVideo/img2video] poll', e.message);
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  _lastGenerateVideoError = '图生视频超时，请稍后重试';
  return null;
}

const HIAPI_IMG2VIDEO_MODELS = [
  'kling-3.0-omni/image-to-video',
  'veo-3.1/image-to-video',
  'wan2.7-video/image-to-video',
];

const LEGACY_IMG2VIDEO_MODELS = [
  'sora-2',
  'sora-2-pro',
  'veo-3.1-fast-generate-preview',
  'veo-3.1-generate-preview',
];

function listKnownImg2VideoModels(settings) {
  if (settings && isHiApiVideoApi(settings.img2video_api_url, settings.img2video_model)) {
    return [...HIAPI_IMG2VIDEO_MODELS];
  }
  return [...HIAPI_IMG2VIDEO_MODELS, ...LEGACY_IMG2VIDEO_MODELS];
}

const VIDEO_MODEL_ID_RE = /sora|veo|kling|seedance|runway|luma|wanx|wan2|wan-|jimeng|minimax.*video|hailuo|vidu|happyhorse|i2v|t2v|image-to-video|text-to-video|img2video|video/i;
const IMG2VIDEO_MODEL_ID_RE = /image-to-video|img2video|\/i2v\b|-i2v\b|i2v-/i;

function extractModelIdsFromPayload(data) {
  const rows = Array.isArray(data?.data) ? data.data
    : (Array.isArray(data?.models) ? data.models
      : (Array.isArray(data?.result) ? data.result
        : (Array.isArray(data) ? data : [])));
  return rows.map((m) => {
    if (typeof m === 'string') return m;
    return m?.id || m?.model || m?.name || m?.model_name || '';
  }).map(s => String(s || '').trim()).filter(Boolean);
}

function rankImg2VideoModels(ids) {
  const uniq = [...new Set(ids)];
  const i2v = uniq.filter(id => IMG2VIDEO_MODEL_ID_RE.test(id));
  const video = uniq.filter(id => VIDEO_MODEL_ID_RE.test(id) && !IMG2VIDEO_MODEL_ID_RE.test(id));
  // 图生视频优先：image-to-video / i2v，再其它视频模型
  return [...i2v, ...video];
}

/** HiAPI 公开价目表（含 model_name / subcategory），作 /v1/models 的补充源 */
async function fetchHiApiPricingRows() {
  const endpoints = [
    'https://www.hiapi.ai/api/pricing',
    'https://api.hiapi.ai/api/pricing',
  ];
  let lastErr = '';
  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 20000,
      });
      const raw = await resp.text().catch(() => '');
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}: ${raw.slice(0, 120)}`;
        continue;
      }
      let data;
      try { data = JSON.parse(raw); } catch {
        lastErr = 'pricing 返回非 JSON';
        continue;
      }
      const rows = Array.isArray(data?.data) ? data.data
        : (Array.isArray(data?.models) ? data.models : []);
      if (rows.length) return rows;
      lastErr = 'pricing 列表为空';
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  throw new Error(lastErr || '无法拉取 HiAPI pricing');
}

function modelsFromHiApiPricing(rows, { subcategory, idRe, rankFn } = {}) {
  const ids = (rows || [])
    .filter(r => r && !r.coming_soon)
    .filter(r => {
      const name = String(r.model_name || r.id || r.name || '');
      const sub = String(r.subcategory || '').toLowerCase();
      const tags = String(r.tags || '');
      if (subcategory && sub === String(subcategory).toLowerCase()) return true;
      if (idRe && idRe.test(name)) return true;
      if (subcategory === 'image-to-image' && /image-to-image/i.test(tags)) return true;
      if (subcategory === 'image-to-video' && /image-to-video/i.test(tags)) return true;
      return false;
    })
    .map(r => String(r.model_name || r.id || r.name || '').trim())
    .filter(Boolean);
  return typeof rankFn === 'function' ? rankFn(ids) : [...new Set(ids)];
}

async function fetchModelsListFromRoots(url, key, { normalizeBase = normalizeVideoApiBase } = {}) {
  const roots = [];
  const u = normalizeBase(url);
  if (!u) return { ids: [], error: '无效 URL' };
  if (u.endsWith('/v1')) roots.push(u);
  else roots.push(`${u}/v1`, u);

  let lastErr = '';
  for (const root of [...new Set(roots)]) {
    const endpoint = `${root}/models`;
    try {
      const resp = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
        timeout: 30000,
      });
      const raw = await resp.text().catch(() => '');
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}: ${raw.slice(0, 200)}`;
        continue;
      }
      const trimmed = String(raw || '').trim();
      if (!trimmed || trimmed.startsWith('<') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
        lastErr = 'API 返回了 HTML 或非 JSON，请检查 Base URL（通常需含 /v1）';
        continue;
      }
      let data;
      try { data = JSON.parse(raw); } catch {
        lastErr = '模型列表返回非 JSON';
        continue;
      }
      const ids = extractModelIdsFromPayload(data);
      if (ids.length) return { ids, error: '' };
      lastErr = '模型列表为空';
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { ids: [], error: lastErr || '拉取失败' };
}

const IMG2IMG_MODEL_ID_RE = /image-to-image|img2img|\/i2i\b|-i2i\b|image.?edit|edit.?image/i;

function rankImg2ImgModels(ids) {
  const uniq = [...new Set(ids)];
  const i2i = uniq.filter(id => IMG2IMG_MODEL_ID_RE.test(id));
  const image = uniq.filter(id =>
    /gpt-image|flux|seedream|banana|imagen|dall|qwen-image|grok-imagine|z-image|ideogram|nano|recraft/i.test(id)
    && !IMG2IMG_MODEL_ID_RE.test(id)
  );
  return [...i2i, ...image];
}

const HIAPI_IMG2IMG_FALLBACK = [
  'gpt-image-2/image-to-image',
  'gpt-image-2/image-to-image@pro',
  'gpt-image-2/image-to-image@ext',
];

/** 从图生图 API 用 Key 拉模型；按中转类型走 /v1/models、80ai 或 HiAPI 价目表 */
async function fetchImg2ImgModelsFromApi(settings, overrides = {}) {
  const url = String(overrides.url || settings?.img2img_api_url || '').trim();
  const key = String(overrides.key || settings?.img2img_api_key || '').trim();
  const genericFallback = [
    ...HIAPI_IMG2IMG_FALLBACK,
    'gpt-image-2',
    'gpt-image-1.5',
    'Nano-Banana-2',
    'seedream-5.0-lite/image-to-image',
  ];
  if (!url || !key) {
    return { models: genericFallback, source: 'builtin', error: '未配置图生图 API' };
  }

  if (looksLike80AiUrl(url)) {
    try {
      const models = await fetch80AiImageModels(url);
      return {
        models,
        source: '80ai',
        note: '80ai 模型列表。自拍参考图请选 Image 2 系列（gptimage2_medium）',
      };
    } catch (e) {
      return {
        models: ['gptimage2_medium', 'gptimage2_high', 'gptimage2_low', 'banana2', 'banana', 'banana_pro'],
        source: '80ai-fallback',
        error: e.message,
      };
    }
  }

  const hiapiLike = looksLikeHiApiHost(url) || looksLikeTasksPath(url);
  const { ids, error: pullErr } = await fetchModelsListFromRoots(url, key, {
    normalizeBase: normalizeImageApiBase,
  });
  if (ids.length) {
    const ranked = rankImg2ImgModels(ids);
    if (ranked.length) {
      return {
        models: ranked,
        source: 'api',
        total: ids.length,
        note: ranked.some(id => IMG2IMG_MODEL_ID_RE.test(id))
          ? '已优先列出图生图（image-to-image）模型'
          : undefined,
      };
    }
    return { models: ids, source: 'api-all', total: ids.length, note: '未识别到明显图生图模型名，已返回全部模型' };
  }

  if (hiapiLike) {
    try {
      const rows = await fetchHiApiPricingRows();
      const ranked = modelsFromHiApiPricing(rows, {
        subcategory: 'image-to-image',
        idRe: IMG2IMG_MODEL_ID_RE,
        rankFn: rankImg2ImgModels,
      });
      if (ranked.length) {
        return {
          models: ranked,
          source: 'hiapi-pricing',
          note: pullErr
            ? `/v1/models 拉取失败（${pullErr.slice(0, 60)}），已从 HiAPI 价目表筛出图生图模型`
            : '已从 HiAPI 价目表筛出图生图模型',
        };
      }
    } catch (e) {
      return {
        models: [...HIAPI_IMG2IMG_FALLBACK],
        source: 'builtin',
        error: `${pullErr || '拉取失败'}；pricing 也失败：${e.message}`,
      };
    }
  }

  if (looksLikeTinySnowUrl(url)) {
    return {
      models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'],
      source: 'tinysnow',
      note: pullErr
        ? `模型列表拉取失败（${String(pullErr).slice(0, 60)}），已给出 TinySnow 常用生图模型`
        : 'TinySnow 图生图常用模型（文档推荐 gpt-image-2）',
    };
  }

  return {
    models: genericFallback,
    source: 'builtin',
    error: pullErr || '未能从该地址拉取模型，已给出常用图生图模型，也可手动填写',
  };
}

/** 从中转站 GET /v1/models 拉取，并筛视频相关模型；失败则回退内置列表 */
async function fetchImg2VideoModelsFromApi(settings, overrides = {}) {
  const url = String(overrides.url || settings?.img2video_api_url || '').trim();
  const key = String(overrides.key || settings?.img2video_api_key || '').trim();
  const probeSettings = { ...settings, img2video_api_url: url, img2video_api_key: key };
  if (!url || !key) {
    return { models: listKnownImg2VideoModels(probeSettings), source: 'builtin', error: '未配置图生视频 API' };
  }

  const { ids, error: pullErr } = await fetchModelsListFromRoots(url, key, {
    normalizeBase: normalizeVideoApiBase,
  });
  if (ids.length) {
    const ranked = rankImg2VideoModels(ids);
    if (ranked.length) {
      return {
        models: ranked,
        source: 'api',
        total: ids.length,
        note: ranked.some(id => IMG2VIDEO_MODEL_ID_RE.test(id))
          ? '已优先列出图生视频（image-to-video / i2v）模型'
          : undefined,
      };
    }
    if (ids.length) {
      return { models: ids, source: 'api-all', total: ids.length, note: '未识别到明显视频模型名，已返回全部模型' };
    }
  }

  if (looksLikeHiApiHost(url) || looksLikeTasksPath(url)) {
    try {
      const rows = await fetchHiApiPricingRows();
      const ranked = modelsFromHiApiPricing(rows, {
        subcategory: 'image-to-video',
        idRe: IMG2VIDEO_MODEL_ID_RE,
        rankFn: rankImg2VideoModels,
      });
      if (ranked.length) {
        return {
          models: ranked,
          source: 'hiapi-pricing',
          note: pullErr
            ? `/v1/models 拉取失败（${pullErr.slice(0, 60)}），已从 HiAPI 价目表筛出图生视频模型`
            : '已从 HiAPI 价目表筛出图生视频模型',
        };
      }
    } catch (e) {
      return {
        models: listKnownImg2VideoModels(probeSettings),
        source: 'builtin',
        error: `${pullErr || '拉取失败'}；pricing 也失败：${e.message}`,
      };
    }
  }

  return {
    models: listKnownImg2VideoModels(probeSettings),
    source: 'builtin',
    error: pullErr || '拉取失败，已回退内置列表',
  };
}

function buildChatContextVideoPrompt(char, { presetQuery, captionText, forImg2Video = false, nsfw = false } = {}) {
  const imageStyle = char?.image_style || 'anime';
  const styleDesc = forImg2Video
    ? (imageStyle === 'real'
      ? 'Generate a short casual iPhone camera-roll clip that starts from this exact photo as the first frame, keep face hair body and layout unchanged, ordinary unposed phone video feel'
      : 'Generate a short casual phone clip that starts from this exact illustration as the first frame, keep character face hair body and layout unchanged')
    : (imageStyle === 'real'
      ? 'casual accidental iPhone video clip, slight handheld shake, mild soft focus, phone grain, natural light, no cinematic look'
      : 'casual phone video clip, smooth natural motion');

  let subject = nsfw ? String(presetQuery || '').trim() : softenSmileInSceneQuery(presetQuery);
  if (/[\u4e00-\u9fff]/.test(subject)) {
    subject = extractImageQueryFromText(subject) || subject;
  }
  if (!subject && captionText) {
    subject = extractImageQueryFromText(captionText) || '';
  }
  subject = subject.replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!nsfw) subject = softenSmileInSceneQuery(subject);
  if (!subject) {
    subject = forImg2Video
      ? 'subtle breathing, gentle hair movement, tiny accidental camera drift, soft restrained expression'
      : 'gentle ocean waves on beach, golden hour';
  }

  if (forImg2Video) {
    if (nsfw) {
      return [
        styleDesc,
        subject,
        'do not replace the person or redraw a different body',
        'keep the exact facial expression from the still image; do not heighten into a sexy or moan face unless the scene asks',
        'subtle breathing, hair and cloth movement, tiny camera drift; extra body motion only if the scene asks',
        'no exaggerated cute/aegyo unless the scene asks',
        'no lens distortion, no wide-angle face warp, no fisheye, do not stretch or thin the face',
        'no beauty filter plastic skin, no cinematic grading',
        'no dialogue, no speech, no singing',
        'audio: ambient environment only, no human voice',
        'short ordinary phone-album clip',
      ].filter(Boolean).join(', ');
    }
    return [
      styleDesc,
      subject,
      'do not replace the person or redraw a different scene',
      'keep the exact facial expression from the still image; do not heighten emotion while moving',
      'prefer neutral or barely closed-lip smile; teeth not visible; mouth stays closed',
      'no laughing, no open-mouth talking face, no exaggerated cute/aegyo expression',
      'no lens distortion, no wide-angle face warp, no fisheye, do not stretch or thin the face',
      'no beauty filter, no cinematic grading, no artistic stylization',
      'no dialogue, no speech, no singing',
      'audio: ambient environment only, no human voice',
      'short ordinary phone-album clip',
    ].filter(Boolean).join(', ');
  }
  return [
    styleDesc,
    subject,
    CHAT_CONTEXT_NO_FACE_HINT,
    'no lens distortion, no wide-angle face warp, no fisheye',
    'no cinematic look, no beauty filter',
    'short ordinary phone-album clip',
  ].filter(Boolean).join(', ');
}

/** 配视频场景静图提示：脸/发跟参考，场景按「配视频：」重画（与自拍同一随手拍气质） */
function buildVideoSceneStillPrompt(char, sceneQuery, opts = {}) {
  const refGroups = normalizeImageRefGroups(char?.image_ref || '[]');
  const nsfw = !!opts.nsfw || looksLikeNsfwMediaPrompt(sceneQuery);
  const rawScene = String(sceneQuery || '').trim();
  const scene = (nsfw ? rawScene : softenSmileInSceneQuery(rawScene))
    || 'accidental phone snapshot, clothing as described in the scene, natural light, calm restrained expression';
  const faceBit = 'face: neutral or barely closed-lip smile only, no cute overacting, no wide grin, teeth not visible; flushed or parted lips only if the scene asks';
  const stillScene = [
    scene,
    'looks like a random still from a phone video in the camera roll',
    'not posed, not deliberate composition',
    'new scene and pose allowed',
    'shot method may be mirror, tripod/timer, candid by someone else, or classic selfie — do not always arm-out holding phone',
    faceBit,
    'no lens distortion, no wide-angle face warp, no fisheye',
  ].join(', ');
  const refFlags = resolveSelfieRefFlags(refGroups, sceneQuery);
  return buildSelfieGenerationPrompt({
    imageStyle: char?.image_style || 'anime',
    charName: char?.name,
    sceneQuery: stillScene,
    hasRef: true,
    hasBodyRef: refFlags.hasBodyRef,
    hasFullBodyRef: refFlags.hasFullBodyRef,
    hasHandRef: refFlags.hasHandRef,
    hasSpecialRef: refFlags.hasSpecialRef,
    specialLabel: refFlags.specialLabel,
    stylePrompt: char?.selfie_style_prompt || '',
    aspect: opts.aspect
      || inferChatMediaAspect({ kind: 'video', query: sceneQuery, char })
      || char?.video_aspect
      || '9:16',
    char,
    hasHomeRef: !refFlags.useSpecial && !!opts.hasHomeRef,
    nsfw,
    skipDailyOutfit: nsfw,
  });
}

/**
 * 先按场景用图生图生成「新构图」静图（脸/发锁角色），再交给图生视频当起始帧去动。
 * 返回本地/可访问的静图 URL；失败写 _lastGenerateVideoError。
 */
async function generateCharacterSceneStillForVideo(settings, char, sceneQuery, { publicBase, aspect, nsfw } = {}) {
  const nsfwHit = inferNsfwMediaRequest({ nsfw, sceneQuery }, sceneQuery);
  settings = routeSettingsForMediaGen(settings, { nsfw: nsfwHit, forVideo: false });
  const refGroups = normalizeImageRefGroups(char?.image_ref || '[]');
  const imageRefs = selectSelfieReferenceUrls(refGroups, sceneQuery);
  const refFlags = resolveSelfieRefFlags(refGroups, sceneQuery);
  if (!imageRefs.length) {
    _lastGenerateVideoError = refGroups.special_enabled
      ? '配视频需要角色形象参考图（正脸或特殊形态）'
      : '配视频需要角色形象参考图（正脸）';
    return null;
  }
  const hasImg2 = !!resolveImg2ImgConfig(settings);
  const hasTxt = !!(settings.image_api_url || '').trim() && !!(settings.image_api_key || '').trim();
  if (!hasImg2 && !hasTxt) {
    _lastGenerateVideoError = '配视频需要先配置「图生图 API」（推荐）或「图像生成 API」，才能按新场景画静图再做成视频';
    return null;
  }

  let aspectNorm = normalizeVideoAspect(
    aspect
    || inferChatMediaAspect({ kind: 'video', query: sceneQuery, char })
    || char?.video_aspect
    || '9:16'
  );
  const stillPrompt = buildVideoSceneStillPrompt(char, sceneQuery, {
    aspect: aspectNorm,
    hasHomeRef: !refFlags.useSpecial && selectHomeReferenceUrls(char, sceneQuery, 1).length > 0,
    nsfw: nsfwHit,
  });
  const homeUrls = refFlags.useSpecial ? [] : selectHomeReferenceUrls(char, sceneQuery, 2);
  const refUrls = [
    ...imageRefs.map(r => toAbsoluteMediaUrl(r, publicBase)).filter(Boolean),
    ...homeUrls.map(r => toAbsoluteMediaUrl(r, publicBase)).filter(Boolean),
  ].slice(0, 5);
  console.log('[chat video/still] prompt:', stillPrompt.slice(0, 160), 'refs=', refUrls.length, 'img2=', hasImg2, 'aspect=', aspectNorm);

  let stillUrl = null;
  try {
    stillUrl = await generateImage(settings, stillPrompt, refUrls[0] || null, {
      referenceImages: refUrls,
      requireReference: hasImg2,
      aspect: aspectNorm,
      publicBase,
      nsfw: nsfwHit,
    });
  } catch (e) {
    _lastGenerateVideoError = `场景静图失败: ${e.message}`;
    return null;
  }

  // 非默认竖屏失败时，回退 9:16 再试一次（部分图生图模型对 16:9 不稳定）
  if (!stillUrl && aspectNorm !== '9:16') {
    console.warn('[chat video/still] aspect', aspectNorm, 'failed, retry 9:16:', (getLastGenerateImageError() || '').slice(0, 120));
    aspectNorm = '9:16';
    try {
      stillUrl = await generateImage(settings, stillPrompt, refUrls[0] || null, {
        referenceImages: refUrls,
        requireReference: hasImg2,
        aspect: aspectNorm,
        publicBase,
        nsfw: nsfwHit,
      });
    } catch (e) {
      _lastGenerateVideoError = `场景静图失败: ${e.message}`;
      return null;
    }
  }

  if (!stillUrl) {
    _lastGenerateVideoError = getLastGenerateImageError() || '场景静图生成失败';
    return null;
  }
  if (typeof stillUrl === 'string' && stillUrl.startsWith('data:')) {
    // 落盘，便于 HiAPI 公网拉取
    try {
      const m = stillUrl.match(/^data:image\/([\w+.-]+);base64,(.+)$/s);
      if (m) {
        const ext = /png/i.test(m[1]) ? 'png' : /webp/i.test(m[1]) ? 'webp' : 'jpg';
        const buf = Buffer.from(m[2], 'base64');
        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const filename = `vidstill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        fs.writeFileSync(path.join(uploadsDir, filename), buf);
        stillUrl = `/uploads/${filename}`;
      }
    } catch (e) {
      console.warn('[chat video/still] persist dataURL failed:', e.message);
    }
  }
  console.log('[chat video/still] ok:', String(stillUrl).slice(0, 100));
  return stillUrl;
}

/** 聊天配视频：先场景静图（脸像角色）→ 再图生视频（静图作起始帧）；失败则文生视频 / Pexels */
async function generateChatContextVideo(settings, char, contentText, presetQuery = null, opts = {}) {
  const captionText = String(contentText || '').trim();
  const nsfw = inferNsfwMediaRequest(opts, `${captionText}\n${presetQuery || ''}`);
  settings = routeSettingsForMediaGen(settings, { nsfw, forVideo: true });
  const refUrl = selectVideoReferenceUrl(char?.image_ref);
  const img2v = resolveImg2VideoConfig(settings);
  const publicBase = opts.publicBase || opts.reqBase || '';
  const hasPexels = !!(settings.pexels_api_key || '').trim();

  if (img2v && refUrl) {
    let sceneQuery = typeof presetQuery === 'string' ? presetQuery.trim() : '';
    if (!sceneQuery && captionText) {
      const m = captionText.match(/(?:配视频[：:]\s*|VIDEO:\s*)([^\n]+)/i);
      if (m) sceneQuery = m[1].trim();
      if (!sceneQuery) sceneQuery = extractImageQueryFromText(captionText) || '';
    }

    const stillUrl = await generateCharacterSceneStillForVideo(settings, char, sceneQuery, {
      publicBase,
      aspect: opts.aspect,
      nsfw,
    });
    if (!stillUrl) {
      console.warn('[chat video/img2video] still failed:', (_lastGenerateVideoError || '').slice(0, 160));
      return null;
    }

    const motionPrompt = buildChatContextVideoPrompt(char, {
      presetQuery: sceneQuery || null,
      captionText,
      forImg2Video: true,
      nsfw,
    });
    let videoAspect = normalizeVideoAspect(
      opts.aspect
      || inferChatMediaAspect({
        kind: 'video',
        query: sceneQuery || (typeof presetQuery === 'string' ? presetQuery : '') || '',
        char,
      })
      || char?.video_aspect
      || '9:16'
    );
    const url = await generateImageToVideo(settings, {
      prompt: motionPrompt,
      referenceImageUrl: stillUrl,
      aspect: videoAspect,
      publicBase,
      motionPromptCustom: char?.video_motion_prompt || '',
      nsfw,
    });
    if (url) {
      console.log('[chat video/img2video] ok (still→video) aspect=', videoAspect, ':', motionPrompt.slice(0, 140));
      return url;
    }
    // 横屏失败时再试竖屏（Kling 等对 16:9 偶发拒收）
    if (videoAspect === '16:9') {
      console.warn('[chat video/img2video] 16:9 failed, retry 9:16:', (_lastGenerateVideoError || '').slice(0, 160));
      const retryUrl = await generateImageToVideo(settings, {
        prompt: motionPrompt,
        referenceImageUrl: stillUrl,
        aspect: '9:16',
        publicBase,
        motionPromptCustom: char?.video_motion_prompt || '',
        nsfw,
      });
      if (retryUrl) {
        console.log('[chat video/img2video] ok (retry 9:16):', motionPrompt.slice(0, 140));
        return retryUrl;
      }
    }
    console.warn('[chat video/img2video] video failed:', (_lastGenerateVideoError || 'empty').slice(0, 180));
    return null;
  }

  if (img2v && !refUrl) {
    console.warn('[chat video] 已配图生视频，但角色无正脸参考图，改走文生视频/Pexels');
  }

  const hasImageApi = (settings.image_api_url || '').trim() && (settings.image_api_key || '').trim();
  if (!hasImageApi) {
    console.warn('[chat video/gen] 未配置图像/视频 API，尝试 Pexels 兜底');
    const onlyPexels = await fetchPexelsVideoForChat(settings, captionText, typeof presetQuery === 'string' ? presetQuery : null);
    if (onlyPexels) return onlyPexels;
    _lastGenerateVideoError = hasPexels
      ? 'Pexels 未搜到可用视频'
      : (img2v && !refUrl
        ? '已配置图生视频，但角色未上传正脸参考图；也未配置 Pexels Key'
        : '未配置「图生视频」API（地址+Key），也没有可用的图像 API / Pexels Key');
    return null;
  }

  const prompt = buildChatContextVideoPrompt(char, {
    presetQuery: typeof presetQuery === 'string' ? presetQuery : null,
    captionText,
  });
  const url = await generateVideo(settings, prompt);
  if (url) {
    console.log('[chat video/gen] ok:', prompt.slice(0, 140));
    return url;
  }
  console.warn('[chat video/gen] failed:', (_lastGenerateVideoError || 'empty').slice(0, 180));
  const fallback = await fetchPexelsVideoForChat(
    settings,
    captionText,
    typeof presetQuery === 'string' ? presetQuery : null
  );
  if (fallback) {
    console.warn('[chat video/gen] fallback to Pexels');
    return fallback;
  }

  const baseErr = _lastGenerateVideoError || '文生视频失败';
  if (!img2v) {
    _lastGenerateVideoError = hasPexels
      ? `${baseErr}；Pexels 也未搜到可用视频。建议在设置里另配「图生视频」API`
      : `${baseErr}。聊天 AI 配视频需要：①设置「图生视频」API（推荐，角色需正脸参考图），或②图像 API 下填写「视频模型」并确认账号支持视频，或③配置 Pexels Key 做图库兜底`;
  } else if (!refUrl) {
    _lastGenerateVideoError = `${baseErr}。已配置图生视频，但当前角色没有正脸参考图，无法静图→视频`;
  }
  return null;
}

async function fetchPexelsVideoForMoment(settings, contentText, presetQuery = null) {
  return fetchPexelsVideoForChat(settings, contentText, presetQuery);
}

/**
 * 朋友圈「配视频」关闭图库时：不锁角色脸，先按内容/关键词文生图出一张静图，
 * 再交给「图生视频」API 把这张图当起始帧做成短片。需要设置里配好「图生视频」（img2video_*）。
 */
async function generateMomentVideoViaAI(settings, char, contentText, presetQuery = null) {
  const query = typeof presetQuery === 'string' ? presetQuery : null;
  const stillUrl = await generateChatContextImage(settings, char, contentText, query);
  if (!stillUrl) return null;
  const prompt = buildChatContextVideoPrompt(char, { presetQuery: query, captionText: contentText });
  return generateImageToVideo(settings, {
    prompt,
    referenceImageUrl: stillUrl,
    aspect: char?.video_aspect || char?.image_aspect || '9:16',
  });
}

// ─── Pexels 视频库 ───

function pickPexelsVideoFileUrl(video) {
  const files = (video?.video_files || []).filter(f => f?.link);
  if (!files.length) return null;
  const mp4s = files.filter(f => /mp4/i.test(f.file_type || f.link || ''));
  const pool = mp4s.length ? mp4s : files;
  const score = (f) => {
    const w = f.width || 0;
    if (w >= 480 && w <= 1280) return 10000 - Math.abs(w - 720);
    if (w > 1280) return 5000 - w;
    return w;
  };
  pool.sort((a, b) => score(b) - score(a));
  return pool[0].link;
}

async function searchPexelsVideos(settings, query, { perPage = 15 } = {}) {
  const key = (settings.pexels_api_key || '').trim();
  if (!key) return [];
  let q = normalizeUnsplashQuery(query);
  if (!q) q = extractImageQueryFromText(query);
  if (!q) return [];
  try {
    const resp = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=${perPage}`,
      { headers: { Authorization: key }, timeout: 20000 }
    );
    if (!resp.ok) {
      console.warn('[pexels] search failed', resp.status, q);
      return [];
    }
    const data = await resp.json();
    return data.videos || [];
  } catch (e) {
    console.warn('[pexels] search error:', e.message, q);
    return [];
  }
}

async function fetchPexelsVideo(settings, query, opts = {}) {
  const key = (settings.pexels_api_key || '').trim();
  if (!key) return null;
  const baseQuery = normalizeUnsplashQuery(query) || extractImageQueryFromText(query) || 'nature landscape';
  const tryQueries = [
    baseQuery,
    `${baseQuery} scenery`,
    `${baseQuery} nature`,
    'ocean waves landscape',
    'city timelapse',
    'rain window',
  ].filter((q, i, arr) => q && arr.indexOf(q) === i);

  for (const q of tryQueries) {
    const results = await searchPexelsVideos(settings, q, { perPage: opts.perPage || 15 });
    for (const v of results.slice(0, 8)) {
      const url = pickPexelsVideoFileUrl(v);
      if (url) return url;
    }
  }
  return null;
}

async function fetchPexelsVideoForChat(settings, contentText, presetQuery = null) {
  const queries = [];
  if (presetQuery) queries.push(normalizeUnsplashQuery(presetQuery));
  queries.push(extractImageQueryFromText(contentText));
  const seen = new Set();
  for (const q of queries) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const url = await fetchPexelsVideo(settings, q);
    if (url) return url;
  }
  return null;
}

function replySuggestsShareVideo(text) {
  const t = String(text || '').trim();
  if (!t || isTrivialChatLine(t)) return false;
  if (replyAsksUserForVideo(t)) return false;
  if (/配视频[：:]\s*[^\n\s]+/i.test(t) && !/配视频[：:]\s*无/i.test(t)) return true;
  if (/发(了|个|一段)?视频|小视频|vlog|\bclip\b|拍(了|段).{0,6}视频|\[发视频\]|\[视频\]/i.test(t)) return true;
  if (/给你看.{0,12}(视频|vlog)|分享.{0,8}视频/.test(t)) return true;
  // 「录好了/拍好了」须与「视频」同句或紧邻，避免纯文字聊天误触
  if (/(录|拍)好(了|咯|啦|哒).{0,8}(视频|vlog|小段)|刚录好.{0,8}(视频|vlog)/.test(t)) return true;
  if (/(视频|vlog).{0,12}(录|拍)好(了|咯|啦|哒)/.test(t)) return true;
  if (/发你(了|咯|啦)?.{0,6}视频|发给你(了|咯|啦)?.{0,6}视频/.test(t)) return true;
  if (/视频.{0,8}发(过)?(去|来|你)|发(过)?(去|来).{0,6}视频/.test(t)) return true;
  if (/配视频[：:]\s*无/i.test(t)) return false;
  return false;
}

function isTrivialChatLine(text) {
  const t = String(text || '').replace(/\s+/g, '').trim();
  if (!t || t.length > 28) return false;
  return /^(嗯|恩|好|哦|啊|行|知道了|收到|哈哈+|在吗|早安|晚安|睡了|拜拜|再见|ok)[。！？~～…]*$/i.test(t);
}

const CHAT_VISUAL_SUBJECT = /图|照片|图片|相片|风景|天空|晚霞|美食|花|海|雪|雨|猫|狗|咖啡|奶茶|月亮|星星|窗外|夕阳|云|景色|美景|食物|蛋糕|樱花|宠物|霓虹|夜景|视频|vlog/;

/** 角色在向用户索要图片/视频（不是角色自己要发） */
function replyAsksUserForImage(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/给(你|您)(看|发)/.test(t) && !/给(我|俺)/.test(t)) return false;
  if (/给(我|俺)(发|看|传|发张|发一下)/.test(t) && /图|照片|图片|相片|自拍|穿搭|样子|啥样|长什么样/.test(t)) return true;
  if (/发(张|个|一张)?(图|照片|图片|相片)(给|我)|传(张|个)?(图|照片)给(我|俺)/.test(t)) return true;
  if (/给(我|俺)看看|给我看(下|一眼|眼)?|让我看看/.test(t) && /图|照片|图片|相片|自拍|样子|啥样|长什么样|穿搭|打扮|窗外|外面|天空|风景/.test(t)) return true;
  if (/你也发(张|个|一张)?(图|照片|图片)?|你也拍(张|个)?(图|照片)?/.test(t)) return true;
  if (/能不能发.{0,10}(图|照片|图片)|可以发.{0,10}(图|照片)吗|发(张|个)?(图|照片)来/.test(t)) return true;
  return false;
}

function replyAsksUserForVideo(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/给(我|俺)(发|看|传)/.test(t) && /视频|vlog|小段/.test(t)) return true;
  if (/发(段|个|一个)?视频(给|我)|传(段|个)?视频给(我|俺)/.test(t)) return true;
  if (/给(我|俺)看看|给我看(下|一眼)?|让我看看/.test(t) && /视频|vlog/.test(t)) return true;
  if (/能不能发.{0,10}视频|可以发.{0,10}视频吗/.test(t)) return true;
  return false;
}

/** 朋友圈正文：描述画面即可配图（发动态本身偏视觉） */
function replySuggestsContextImage(text) {
  const t = String(text || '').trim();
  if (!t || isTrivialChatLine(t)) return false;
  if (/配图[：:]\s*无/i.test(t)) return false;

  if (/风景|美景|景色|美食|食物|好吃|咖啡|奶茶|茶|蛋糕|面包|甜品|外卖|餐厅|食堂/.test(t)) return true;
  if (/雨|雪|海|沙滩|浪|花|樱花|玫瑰|猫|狗|宠物|月亮|星星|天空|云|夕阳|晚霞|朝阳|晨光|霓虹|桥|森林|山/.test(t)) return true;
  if (/窗外|外面|楼下|街道|城市|旅途|旅行|机场|火车|酒店|房间|书桌|书架|灯光|夜景|日落|日出/.test(t)) return true;
  if (/拍(了|的|张)|刚拍|随手拍|分享|晒(图|一下)|给你看|快看|你看(这|那)|瞧瞧|记录(一下)?|刚(才|刚).{0,6}(看到|路过|发现)/.test(t)) return true;
  if (/今天.{0,10}(天气|太阳|月亮|雨|雪|云)|这里.{0,8}(好美|真美|不错|好安静)/.test(t)) return true;
  return false;
}

/** 回复里已经带了表情包/定位/链接等，口中「发过去了」可能不是生图 */
function replyAlreadyHasSharePayload(text) {
  const t = String(text || '');
  if (/\[(表情|表情包)\][\s\S]*?\[\/(表情|表情包)\]/.test(t)) return true;
  if (/\[位置\][\s\S]*?\[\/位置\]/.test(t)) return true;
  if (/\[链接\][\s\S]*?\[\/链接\]/.test(t)) return true;
  if (/\[网页卡\][\s\S]*?\[\/网页卡\]/.test(t)) return true;
  return false;
}

/**
 * 角色正文已经当成「图已经在聊天里了」在说话：
 * 「发过去了」「赶紧看」「看完评价」等。用来补发漏写的「自拍：/配图：」。
 * 注意：疑问/商量（「要不要发张图」「发张图？」）不算已发出。
 */
function replyClaimsSentShareMedia(text) {
  const t = String(text || '').trim();
  if (!t || isTrivialChatLine(t)) return false;
  if (replyAsksUserForImage(t) || replyAsksUserForVideo(t)) return false;
  if (replyAlreadyHasSharePayload(t)) return false;
  if (/还没(拍|发|传)|先不发|等(我|一下|会).{0,8}(拍|发)|到家再|回头发|待会发|晚点发|之后再(拍|发)/.test(t)) {
    return false;
  }
  // 疑问 / 商量 / 假设：嘴上提图，但没当真发出
  if (/(?:要不要|要不要我|要我|要不要给你|要不要发|要我发|我发不发|发不发|要发吗|发吗|发不|要不|不如|要不要看我).{0,12}(?:发|拍|传)/.test(t)) {
    return false;
  }
  if (/[？?]\s*$/.test(t) && /(?:发|拍|传).{0,8}(?:图|照片|图片|相片|自拍)/.test(t)
    && !/(?:已经|都).{0,4}(?:发|拍|传)|发(过)?(去|来)了|拍好了/.test(t)) {
    return false;
  }

  const compact = t.replace(/\s+/g, '');
  const visual = /图|照片|图片|相片|自拍|这张|镜头/.test(t);
  if (/单号|红包|转账|验证码|快递|文件|链接|地址|定位/.test(t) && !visual) return false;

  // 明确完成态：已经发出 / 拍好了
  if (/发(过)?(去|来)了|传(过)?(去|来)了/.test(t)) return true;
  if (/发你了|发给你了|发你啦|发给你啦|发你咯|发给你咯/.test(t)) return true;
  if (/(已经|都)(给)?(你)?发(过|了)/.test(t) && (visual || compact.length <= 24)) return true;
  if (/拍好了/.test(t) && !/视频/.test(t)) return true;
  if (/画好了|画完了|画好啦|画完啦/.test(t)) return true;

  // 「发张图给你 / 发你看看」——口头当发出了，但排除「想发/会发/可以发」未完成态
  if (/(?:发|传)(?:张|个|一张)?(?:图|照片|图片|相片|自拍)/.test(t)
    && /(?:给你|发你|给你看|发你看|过来看|过去看)/.test(t)
    && !/(?:别|不要|先别|还没|想|会|能|可以|求你|给我|让我|要不要|要我).{0,8}(?:发|传)/.test(t)
    && !/(?:想|会|准备|打算|考虑).{0,6}(?:发|拍|传)/.test(t)) {
    return true;
  }
  if (/(?:给你|发你)(?:看|看看)?(?:下|一眼)?(?:这|那)?(?:张|个)?(?:图|照片|图片|相片|自拍)/.test(t)
    && visual
    && !/给(我|俺)看|让我看|给我看/.test(t)
    && !/[？?]/.test(t)) {
    return true;
  }
  if (/发(?:过来|过去|给你)(?:看看|瞧瞧|一下)?/.test(t) && (visual || /看/.test(t)) && !/[？?]/.test(t)) return true;

  if (/(赶紧|快)看(啊|呀|嘛|吧|啦|咯|一眼|下)?[!！.。~～…]*$/.test(compact) && compact.length <= 12) return true;
  if (/看完.{0,8}(评|说|告诉|觉得|感觉)/.test(t)) return true;
  if (/(赶紧|快)看/.test(t) && visual) return true;
  if (/(评价一下|给个评价|这张怎么样)/.test(t) && (visual || compact.length <= 20)) return true;
  return false;
}

/**
 * 更松的一档口语：「看好了」「给你吧」「喏」「拍完了」这类。
 * 单独看太泛（正常聊天也会说），只在用户本轮确实要过图/视频时才认。
 */
function replyLooselyClaimsSentMedia(text) {
  const t = String(text || '').trim();
  if (!t || isTrivialChatLine(t)) return false;
  if (replyAsksUserForImage(t) || replyAsksUserForVideo(t)) return false;
  if (replyAlreadyHasSharePayload(t)) return false;
  if (/还没(拍|发|传)|先不发|等(我|一下|会).{0,8}(拍|发)|到家再|回头发|待会发|晚点发|之后再(拍|发)|不想拍|不拍|不发/.test(t)) {
    return false;
  }
  const compact = t.replace(/\s+/g, '');
  const visual = /图|照片|图片|相片|自拍|这张|镜头/.test(t);

  if (/看好了|拍完了|拍完啦|弄好了|搞好了|整好了|出来了/.test(t) && (visual || compact.length <= 24)) return true;
  if (/(点开|放大|存下来|存好|收好)/.test(t) && (visual || compact.length <= 24)) return true;
  if (/^(喏|诺|呐)[，,。！!~～…\s]/.test(compact) || /^(喏|诺|呐)$/.test(compact)) return true;
  if (/(给你|给你吧|给吧|拿去|拿着|接着|接住)[。！!~～…]*$/.test(compact) && compact.length <= 14) return true;
  if (/(看吧|看看吧|自己看|你自己看|你看吧|瞧吧)[。！!~～…]*$/.test(compact) && compact.length <= 14) return true;
  return false;
}

/**
 * 嘴上说发出了，但没写可用指令行时，推断该补自拍 / 风景图 / 视频。
 * 说不清时默认自拍，避免再把本人照补成风景。
 * 仅认「已发出」完成态；闲聊提「发张图」不算。
 */
function resolveClaimedMissingShare({
  combined,
  userMessage = '',
  hasExplicitSelfie = false,
  wantsGeneral = false,
  wantsVideo = false,
  userWantsSelfie = false,
  userImageRequest = false,
} = {}) {
  if (hasExplicitSelfie || wantsGeneral || wantsVideo) return null;
  const blob = String(combined || '');
  // 用户本轮硬要图时，才叠一层更松的口语（看好了/喏）；平时只认完成态声称
  const claimed = replyClaimsSentShareMedia(blob)
    || ((userWantsSelfie || userImageRequest) && (
      replySuggestsShareImage(blob) || replyLooselyClaimsSentMedia(blob)
    ));
  if (!claimed) return null;

  const inferred = inferShareIntentFromReply(blob);
  const fromUser = userImageRequest ? inferShareIntentFromReply(userMessage) : null;
  const drawAsk = detectDrawingMediaIntent({ userMessage, query: '', caption: blob });

  if (/视频|vlog/.test(blob) && !/自拍|照片|这张图|相片/.test(blob)) {
    return {
      kind: 'video',
      query: inferred.query || inferred.scene || extractImageQueryFromText(blob) || '',
    };
  }
  // 画画/插画：补配图，不要默认成自拍实拍
  if (drawAsk || /画好了|画完了|插画|简笔画|涂鸦/.test(blob)) {
    const sub = inferred.query || inferred.scene || fromUser?.query || fromUser?.scene
      || extractImageQueryFromText(userMessage) || extractImageQueryFromText(blob)
      || 'a charming scene';
    const mode = drawAsk || (/简笔画|涂鸦|你画我猜|doodle/i.test(blob) ? 'doodle' : 'illustration');
    return {
      kind: 'image',
      query: mode === 'doodle' ? `simple doodle of ${sub}` : `illustration of ${sub}`,
    };
  }
  if (userWantsSelfie || /自拍|本人|出镜|对镜|穿搭|我这张/.test(blob)) {
    return {
      kind: 'selfie',
      sceneQuery: inferred.scene || fromUser?.scene || '',
    };
  }
  if (inferred.kind === 'image' || fromUser?.kind === 'image') {
    const q = inferred.query || inferred.scene || fromUser?.query || fromUser?.scene || '';
    if (q) return { kind: 'image', query: q };
  }
  // 口头说发图：尽量带上正文场景，避免空场景掉进「默认家里自拍」
  return {
    kind: 'selfie',
    sceneQuery: inferred.scene || fromUser?.scene || '',
  };
}

/**
 * 用户是否「硬要」对方现在发图（不是闲聊提图/照片）。
 * 硬请求才注入发图提示、漏指令时才强制补图。
 */
function isHardUserImageAsk(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  try {
    if (require('./process-time-helper').userWantsDeferredMedia(t)) return false;
  } catch { /* ignore */ }
  if (/(?:别|不要|先别|先不|不用).{0,6}(?:发|拍|传).{0,8}(?:图|照片|图片|相片|自拍)/.test(t)) return false;
  // 闲聊提及：谈及某张图/照片里的内容，不是要对方发
  if (/(?:那张|这张|那幅|截图里|照片里|图片里|图里|那张图|这张图).{0,20}/.test(t)
    && !/(?:发|拍|来|给我看|让我看|想看|要看|再发|再拍)/.test(t)) {
    return false;
  }
  if (/相册|壁纸|头像|表情包/.test(t) && !/(?:发|拍|来).{0,8}(?:图|照片|自拍)/.test(t)) return false;

  if (isHardUserSelfieAsk(t)) return true;
  // 画画 / 插画 / 你画我猜（不是要实拍风景）
  if (isDrawingMediaAsk(t)) return true;
  // 祈使 / 索要：发给我、来一张、拍一张、想看图
  if (/(?:发|来|整|拍)(?:个|张|一张|些|点)?[^，,。！？!?\n]{0,12}?(?:图|照片|图片|相片)/.test(t)) return true;
  if (/(?:能不能|可以|求你|麻烦).{0,10}(?:发|拍).{0,10}(?:图|照片|图片|相片)/.test(t)) return true;
  if (/(?:给(?:我|俺)|让我)(?:看|发).{0,16}(?:图|照片|图片|相片|风景|天空|外面|窗外)/.test(t)) return true;
  if (/(?:想看|要看|想要).{0,10}(?:图|照片|图片|相片|风景)/.test(t)) return true;
  if (/share.{0,10}(photo|picture|pic)|\[发图\]/i.test(t)) return true;
  return false;
}

function isHardUserSelfieAsk(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/不要.{0,6}自拍|别.{0,4}自拍|不发自拍|不要本人|别发你/.test(t)) return false;
  try {
    if (require('./process-time-helper').userWantsDeferredMedia(t)) return false;
  } catch { /* ignore */ }
  return /(?:发|来)(?:个|张|一张)?[^，,。！？!?\n]{0,12}?自拍|本人照|selfie/i.test(t)
    || /看(?:看)?你(?:的)?(?:自拍|样子|穿搭|今天穿什么|穿什么)/i.test(t)
    || /你(?:现在|今天).{0,8}(?:长什么样|什么样|啥样)/i.test(t)
    || /给(?:我|俺)(?:看|发).{0,10}(?:你|你的).{0,10}(?:照片|自拍|样子|近照)/i.test(t)
    || /(?:露骨|大胆|私房|湿身|情趣|暴露|性感|不穿|没穿|脱)[^，,。！？!?\n]{0,12}(?:图|照片|图片|自拍)/i.test(t)
    || /拍(?:张|一张)?(?:你自己|你)|你拍(?:张|一张)/i.test(t);
}

/** 角色明确拒绝本轮发图 */
function replyRefusesShareMedia(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/配图[：:]\s*无|自拍[：:]\s*无|配视频[：:]\s*无/i.test(t)) return true;
  if (/(?:不发|不拍|先不发|先不拍|不想发|不想拍|等会再|待会再|晚点再|到家再|回头发).{0,8}(?:图|照片|自拍|视频)?/.test(t)
    && !/(?:发|拍).{0,6}(?:了|去了|你了)/.test(t)) {
    return true;
  }
  if (/不(?:方便|想|要|能|会).{0,8}(?:拍|发)/.test(t) && /(?:图|照片|自拍|视频|拍)/.test(t)) return true;
  if (/(?:改天|下次再|过会儿再|等(?:一下|会儿|会儿?)再).{0,8}(?:拍|发|图|照片|自拍)/.test(t)) return true;
  return false;
}

/** 聊天：仅当角色明确在分享/发图时才配图，平常提到画面不算 */
function replySuggestsShareImage(text) {
  const t = String(text || '').trim();
  if (!t || isTrivialChatLine(t)) return false;
  if (replyAsksUserForImage(t)) return false;
  if (replyClaimsSentShareMedia(t)) return true;
  if (/配图[：:]\s*无/i.test(t)) return false;
  // 疑问/商量提图：不算真要发
  if (/(?:要不要|要不要我|要我|发不发|要发吗|发吗|要不|不如).{0,12}(?:发|拍)/.test(t)) return false;
  if (/[？?]\s*$/.test(t) && /(?:发|拍).{0,8}(?:图|照片|图片|相片|自拍)/.test(t)) return false;

  if (/配图[：:]\s*[^\n\s]+/i.test(t)) return true;
  // 完成态或明确交付，不要把「发张图」单拎出来当已发
  if (/发(了|过)(张|一张|些|个)?(图|照片|图片|相片)|\[发图\]|\[(风景|美食|食物|夜景|美景|图|图片)\]/.test(t)) return true;
  if (/这是(我)?(刚)?拍(的|张)|拍了?(一)?张(图|照片)?|一张照片|一张图/.test(t)) return true;
  if (/(拍)好(了|咯|啦|哒).{0,8}(图|照片|图片|相片)|刚拍好.{0,8}(图|照片)?/.test(t)) return true;
  if (/(图|照片|图片).{0,12}(拍)好(了|咯|啦|哒)/.test(t)) return true;
  if (/发你(了|咯|啦).{0,6}(图|照片|图片)|发给你(了|咯|啦).{0,6}(图|照片|图片)/.test(t)) return true;
  if (/给你发(?:张|个|一张)?(?:图|照片|图片|相片)|发(?:张|个)(?:图|照片).{0,6}给你/.test(t)
    && !/(?:想|会|准备|打算|要不要|能|可以).{0,6}(?:发|拍)/.test(t)
    && !/[？?]/.test(t)) {
    return true;
  }

  if (/分享|晒(图|一下|张)?|发送|share|photo|picture/i.test(t) && CHAT_VISUAL_SUBJECT.test(t) && !/给(我|俺)/.test(t)) {
    if (/给你看|发给你|分享(给)?你/.test(t) && !/[？?]/.test(t)) return true;
  }
  if (/给你看|快看|你看(这|那|一下)|瞧瞧/.test(t) && CHAT_VISUAL_SUBJECT.test(t) && !/给(我|俺)看|让我看|给我看/.test(t) && !/[？?]/.test(t)) {
    return true;
  }
  if (/拍(了|的|张|个)|刚拍|随手拍/.test(t) &&
      (/图|照片|分享|晒|好看|怎么样|这个|这边|这里/.test(t) || CHAT_VISUAL_SUBJECT.test(t)) &&
      !/给(我|俺)/.test(t)) {
    return true;
  }
  return false;
}

/**
 * 是否应自动配 Unsplash 图
 * presetQuery: undefined=未写配图行, null=配图：无, string=关键词
 * forChat: true 时仅认「分享照片」意图（聊天）；false 时朋友圈等可凭画面描述配图
 */
function shouldAttachContextImage(combined, presetQuery, { hasExplicitSelfie = false, forChat = false } = {}) {
  if (hasExplicitSelfie) return false;
  if (presetQuery === null) return false;
  const t = String(combined || '').trim();
  if (forChat && replyAsksUserForImage(t)) return false;
  if (typeof presetQuery === 'string' && presetQuery.trim()) return true;
  if (!t) return false;

  if (forChat) {
    return /配图[：:]\s*[^\n]+/i.test(t) && !/配图[：:]\s*无/i.test(t);
  }
  if (/配图[：:]\s*[^\n]+/i.test(t) && !/配图[：:]\s*无/i.test(t)) return true;
  return replySuggestsContextImage(t);
}

function shouldAttachContextVideo(combined, videoQuery, { forChat = false } = {}) {
  if (videoQuery === null) return false;
  const t = String(combined || '').trim();
  if (forChat && replyAsksUserForVideo(t)) return false;
  if (typeof videoQuery === 'string' && videoQuery.trim()) return true;
  if (!t) return false;
  if (forChat) {
    return /配视频[：:]\s*[^\n]+/i.test(t) && !/配视频[：:]\s*无/i.test(t);
  }
  if (/配视频[：:]\s*[^\n]+/i.test(t) && !/配视频[：:]\s*无/i.test(t)) return true;
  return /视频|vlog|clip|录(制|像)/i.test(t) && /海|雨|雪|街|城市|风景|窗外|旅行|日落|星空|浪/.test(t);
}

/**
 * 形象参考图：兼容旧版 URL 数组与新版 { face, body, hands, fullbody, special… }
 * face 正脸/侧脸，body 半身/腹肌/身材，hands 手部，fullbody 全身比例
 * special 特殊/非人类形态；special_enabled 开关；special_label 形态名（可选）
 */
function normalizeImageRefGroups(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw || '[]'); } catch { parsed = []; }
  }
  if (Array.isArray(parsed)) {
    const urls = parsed.map(u => String(u || '').trim()).filter(Boolean);
    return {
      face: urls.slice(0, 3),
      body: [],
      hands: [],
      fullbody: [],
      special: [],
      special_enabled: false,
      special_label: '',
    };
  }
  if (parsed && typeof parsed === 'object') {
    const take = (key, max) => []
      .concat(parsed[key] || [])
      .map(u => String(u || '').trim())
      .filter(Boolean)
      .slice(0, max);
    const enabled = parsed.special_enabled === true
      || parsed.special_enabled === 1
      || parsed.special_enabled === '1'
      || parsed.special_enabled === 'true';
    return {
      face: take('face', 3),
      body: take('body', 2),
      hands: take('hands', 2),
      fullbody: take('fullbody', 2),
      special: take('special', 3),
      special_enabled: enabled,
      special_label: String(parsed.special_label || parsed.specialLabel || '').trim().slice(0, 40),
    };
  }
  return {
    face: [], body: [], hands: [], fullbody: [],
    special: [], special_enabled: false, special_label: '',
  };
}

function flattenImageRefGroups(groups) {
  const g = normalizeImageRefGroups(groups);
  return [...g.face, ...g.body, ...g.hands, ...g.fullbody, ...g.special].filter(Boolean).slice(0, 8);
}

/** 场景是否在要特殊/非人类形态（变身、原形、兽形等） */
function wantsSpecialFormScene(sceneQuery = '', specialLabel = '') {
  const scene = String(sceneQuery || '');
  if (!scene.trim()) return false;
  const label = String(specialLabel || '').trim();
  if (label && scene.toLowerCase().includes(label.toLowerCase())) return true;
  return /特殊形态|非人|非人类|原形|变身|变成|兽形|兽态|动物形态|真身|本体|龙形|狐狸形|猫形|狼形|翅膀|有尾巴|beast\s*form|true\s*form|animal\s*form|non[- ]?human|creature\s*form|monster\s*form|werewolf|kitsune|dragon\s*form/i.test(scene);
}

/** 按自拍场景优先选用身体/手部参考；特殊形态开启且场景点名时改用 special */
function selectSelfieReferenceUrls(imageRefRaw, sceneQuery = '') {
  const g = normalizeImageRefGroups(imageRefRaw);
  const scene = `${sceneQuery || ''}`;
  const out = [];
  const pushUnique = (urls, n) => {
    for (const u of urls) {
      if (!u || out.includes(u)) continue;
      out.push(u);
      if (out.length >= n) break;
    }
  };

  if (g.special_enabled && g.special.length && wantsSpecialFormScene(scene, g.special_label)) {
    pushUnique(g.special, 3);
    // 特殊形态优先，避免人类正脸/身材参考把形态拉回人形
    return out.slice(0, 6);
  }

  const wantHands = /hand|finger|palm|wrist|nail|手|指|掌|腕/i.test(scene);
  // Hera 图生图把第一张当画布：全身/身材必须在正脸前面，否则会把大脸特写拉成矮身子
  pushUnique(g.fullbody, 1);
  if (!out.length) pushUnique(g.body, 1);
  pushUnique(g.face, 1);
  pushUnique(g.body, 1);
  pushUnique(g.fullbody, 2);
  pushUnique(g.body, 2);
  if (wantHands) pushUnique(g.hands, 2);
  pushUnique(g.hands, 5);
  pushUnique(g.face, 5);
  return out.slice(0, 6);
}

/** 自拍参考选用结果：是否走特殊形态，以及一致性提示用的标记 */
function resolveSelfieRefFlags(imageRefRaw, sceneQuery = '') {
  const g = normalizeImageRefGroups(imageRefRaw);
  const useSpecial = !!(g.special_enabled && g.special.length && wantsSpecialFormScene(sceneQuery, g.special_label));
  return {
    groups: g,
    useSpecial,
    hasSpecialRef: useSpecial,
    specialLabel: g.special_label || '',
    hasBodyRef: !useSpecial && g.body.length > 0,
    hasFullBodyRef: !useSpecial && (g.fullbody?.length || 0) > 0,
    hasHandRef: !useSpecial && g.hands.length > 0,
  };
}

/** 自拍参考图一致性：短一点，把字数留给场景 */
function buildSelfieRefConsistencyPrompt(options = {}) {
  if (options.hasSpecialRef) {
    const label = String(options.specialLabel || '').trim();
    const formBit = label
      ? `match the non-human / special form "${label}" from the special-form reference`
      : 'match the non-human / special form from the special-form reference';
    return [
      formBit,
      'keep species silhouette, proportions, fur/scale/skin texture and distinctive features from special reference',
      'do not force human face or human body proportions from other refs',
      'pose/background may change but still feel like this same being',
    ].join(', ');
  }
  const bits = [
    'same person as reference',
    'keep face shape, jaw, eyes, skin tone and hair color/length exactly; do not warp or restyle the face',
    'copy a neutral closed-lip expression from the face reference unless the scene explicitly asks otherwise; no default smile',
  ];
  if (options.hasBodyRef) bits.push('match body type, shoulder width and torso scale from body reference; do not copy a close-up face crop as the whole body');
  if (options.hasFullBodyRef) bits.push('match overall height and head-to-body proportion from full-body reference; keep adult shoulder width, no giant head');
  if (options.hasHandRef) bits.push('match hand shape from hand reference');
  if (options.lockOutfit) {
    bits.push('do not copy outfit from reference photos; wear the outfit described in the prompt');
    bits.push('pose/background may change but still feel like this person');
  } else {
    bits.push('outfit/pose/background may change but still feel like this person');
  }
  return bits.join(', ');
}

function buildChatImagePromptSection(char, opts = {}) {
  const homeDesc = formatHomeEnvironmentForChatPrompt(char);
  const placeName = spokenCharPlaceForSelfie(char);
  const homeRule = homeDesc
    ? `\n- **居住环境（仅在家时用）**：${homeDesc}\n  只有确实在家拍「自拍：」/「配视频：」时，才体现该居所的空间、家具与窗外景观。禁止落成普通出租屋、廉价小卧室、千篇一律浴室镜前。${normalizeHomeRefs(char?.home_refs).length ? '（已上传家装参考图，在家场景尽量对应图注，如卧室/客厅等）' : ''}`
    : '';
  const awayRule = placeName
    ? `\n- **外出时**：按**此刻日程地点**与所在地「${placeName}」写场景（街、店、办公、通勤等本地氛围），**禁止**套用上面的家里装修/窗景。`
    : `\n- **外出时**：按**此刻日程地点**与聊天里的外出地点写场景，**禁止**套用家里装修/窗景。`;
  let specialFormRule = '';
  try {
    const refG = normalizeImageRefGroups(char?.image_ref || {});
    if (refG.special_enabled && refG.special.length) {
      const label = refG.special_label || '特殊/非人类形态';
      specialFormRule = `\n- **特殊形态**：已启用「${label}」参考图。变身/原形/非人形态出镜时，在「自拍：」或「配视频：」里写明该形态（可直接写「${label}」），系统会改用特殊形态参考图，不要只写成普通人类自拍。`;
    }
  } catch {}
  let outfitRule = '';
  try {
    const wh = require('./wardrobe-helper');
    const override = opts.outfitOverride
      || wh.detectExplicitOutfitOverride({ userMessage: opts.userMessage || '' });
    const block = wh.buildOutfitChatPromptBlock(char, undefined, {
      userMessage: opts.userMessage || '',
      outfitOverride: override,
    });
    if (block) {
      outfitRule = override?.skipDaily
        ? `\n- **本轮换装（优先于今日穿搭）**：${block}`
        : `\n- **今日穿着（仅本轮发自拍时用）**：${block}`;
    }
  } catch {}
  // 聊天已走到 NSFW 向：只放开衣物/裸露，构图气质仍跟日常自拍同一套。
  // 否则模型会写回今日穿搭，生图端也就判不出 NSFW。
  const nsfwRule = opts.nsfw
    ? `\n- **本轮为亲密/露骨向（只改穿着，其它跟日常自拍同一套）**：写「自拍：」/「配视频：」仍按下面结构：地点 + 正在做什么 + 具体衣物或裸露状态 + 拍法 + 氛围/光线 + 表情。衣物按对方要的程度直写（脱去/未穿/内衣/裸露都可以），禁止改回今日穿搭或 casual outfit，禁止只写氛围交差。拍法继续轮换（对镜/支架/窗台/偶尔伸手），不要每次对镜内衣。光线写真实随手拍（窗光、台灯、浴室灯），不要 cinematic sexy / boudoir。表情跟聊天走，默认自然克制，禁止默认 flushed cheeks / half-lidded eyes / parted lips / 卖骚 pose。正例：「自拍：late night bedroom by the window, sitting on the bed edge in pale gray cotton briefs, phone propped on the nightstand timer, cool window light, calm looking at camera」。反例：「自拍：intimate lingerie, flushed, half-lidded, parted lips, seductive pose」。系统已为这类画面配了专用生图通道。`
    : '';
  return `【聊天配图·仅真发时】${nsfwRule}
- **默认少发图/视频**。闲聊提到「图/照片/画面」或商量「要不要发张图」时，**不要**写「配图：」「自拍：」指令行，也不要假装已发出。
- 只有你**真要发出文件**，或用户**明确要现在发图/视频/画画**时，才在末尾另起一行写指令（用户看不到）。发图/视频**一律走生图 API**，不要写 [相册自拍]、[相册图] 等相册标记。
- **已发出才准说发出·硬性**：正文说「发过去了」「发你了」「拍好了」「画好了」「赶紧看」「看完评价」之前，必须先写「自拍：…」或「配图：…」。没写指令行 = 没发。禁止「配图：无」/「自拍：无」和「发过去了」写在同一条。口头商量「发张图？」不算已发出。
- **延后再发·硬性**：对方说「到家再发」「回家发图」「之后再拍」等——本轮只答应或说在路上，**禁止**写「配图：」「自拍：」「配视频：」，也不要假装已发出。到了/到家后再另发一张。
- **画画 / 插画 / 你画我猜**：对方要你「画一张」「画个插画」「简笔画」「你画我猜」时，写「配图：illustration of …」或「配图：simple doodle of …」（手绘/插画，可画角色、动物、物品）。**禁止**落成手机实拍风景，也**不要**用「自拍：」顶替。你画我猜请故意画简单糊一点方便猜。
- 非自拍配图（实拍分享）：写「配图：具体英文画面」（写实；主体是风景/静物/动物，**禁止写人物、人像、路人特写**）。可写 empty / no people；若必须有街景氛围，只写 distant anonymous blur at edge，禁止 mid-frame person / clear face / portrait。**拍鱼/宠物/食物/静物/风景必须用「配图：」，禁止写「自拍：」**——「自拍：」仅用于角色本人出镜。不要写就写「配图：无」。
- **自拍 / 自己出镜视频**（「自拍：」或「配视频：」）：
  - 一行写清：**地点 + 正在做什么 + 具体穿着（贴合人设）+ 拍法 + 氛围/光线 + 表情**。越具体越好，禁止空泛的 casual outfit / bedroom selfie / everyday look。
  - 若用户本轮明确要求换某身衣服拍照，穿着必须按用户指定；否则优先用下面的今日穿搭单品；没有今日穿搭时再按人设与当下情境。不要每次白 T 牛仔裤。${outfitRule}
  - 地点跟着**此刻日程 + 聊天**：在家才用【居住环境】；外出必须写外出地点，不要默认家里。${homeRule}${awayRule}${specialFormRule}
  - 拍法轮换：对镜 / 支架定时 / 朋友抓拍 / 窗台摆拍 / 偶尔伸手自拍。
  - 表情跟聊天情绪：默认自然克制；开心 barely closed-lip smile；难过 tired eyes；生气 tense jaw。禁止 wide toothy grin / 卖萌 / 大笑露齿。
  - 画面里**只有你一人脸清晰**；旁人只能远景糊影/背影，禁止再写另一个清晰人脸或「和路人合影特写」。
  - 正例：「自拍：night street corner under neon, black leather jacket over turtleneck matching persona, candid shot by a friend mid-walk, wet asphalt reflections, calm barely smiling」
  - 反例：「自拍：casual indoor selfie, casual outfit, soft smile」——太普通，禁止。
- 风景短视频同「配视频：」。向用户索要图/视频时禁止写这些指令行。`;
}

/**
 * 查询中转站 API Key 余额（New-API / HiAPI / 80ai 等兼容接口）
 */
const DEFAULT_QUOTA_PER_UNIT = 500000;

function balanceBaseCandidates(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  if (!raw) return [];
  const bases = new Set([raw]);
  if (raw.endsWith('/v1')) bases.add(raw.slice(0, -3).replace(/\/+$/, ''));
  else bases.add(`${raw}/v1`);
  return [...bases].filter(Boolean);
}

function quotaToUsd(quota, quotaPerUnit = DEFAULT_QUOTA_PER_UNIT) {
  const n = Number(quota);
  if (!Number.isFinite(n)) return null;
  return n / quotaPerUnit;
}

function formatUsd(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

async function fetchBalanceJson(endpoint, apiKey, timeout = 12000) {
  const resp = await fetchWithTimeout(endpoint, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout,
  });
  const raw = await resp.text().catch(() => '');
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}${raw ? `：${raw.slice(0, 120)}` : ''}`);
    err.status = resp.status;
    throw err;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('<')) throw new Error('返回了 HTML 而非 JSON，请检查 Base URL');
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}`);
  }
}

function parseTokenUsageBalance(data) {
  const d = data?.data || data;
  if (!d || typeof d !== 'object') return null;
  const granted = Number(d.total_granted);
  const used = Number(d.total_used);
  const available = Number(d.total_available);
  if (![granted, used, available].some((n) => Number.isFinite(n))) return null;
  const unlimited = !!d.unlimited_quota;
  const usagePercent = granted > 0 ? Math.round((used / granted) * 1000) / 10 : 0;
  const availUsd = quotaToUsd(available);
  const usedUsd = quotaToUsd(used);
  const grantUsd = quotaToUsd(granted);
  let summary = unlimited ? '无限额度' : `剩余 ${formatUsd(availUsd)}`;
  if (!unlimited && Number.isFinite(granted) && granted > 0) {
    summary += ` / 总额 ${formatUsd(grantUsd)}（已用 ${usagePercent}%）`;
  } else if (!unlimited && Number.isFinite(usedUsd)) {
    summary += `，已用 ${formatUsd(usedUsd)}`;
  }
  if (d.name) summary = `${d.name}：${summary}`;
  const expiresAt = Number(d.expires_at) || 0;
  if (expiresAt > 0) {
    const dt = new Date(expiresAt * 1000);
    if (!Number.isNaN(dt.getTime())) summary += `，到期 ${dt.toLocaleDateString('zh-CN')}`;
  }
  return {
    source: 'token_usage',
    unlimited,
    name: String(d.name || '').trim(),
    totalGranted: Number.isFinite(granted) ? granted : null,
    totalUsed: Number.isFinite(used) ? used : null,
    totalAvailable: Number.isFinite(available) ? available : null,
    remainingUsd: availUsd,
    usedUsd,
    usagePercent,
    expiresAt,
    modelLimitsEnabled: !!d.model_limits_enabled,
    summary,
  };
}

function parseBillingBalance(sub, usage) {
  const remaining = Number(
    sub?.hard_limit_usd ?? sub?.total_available ?? sub?.balance ?? sub?.total_amount,
  );
  const usedRaw = Number(usage?.total_usage);
  const usedUsd = Number.isFinite(usedRaw) ? usedRaw / 100 : null;
  if (!Number.isFinite(remaining) && !Number.isFinite(usedUsd)) return null;
  const parts = [];
  if (Number.isFinite(remaining)) parts.push(`剩余 ${formatUsd(remaining)}`);
  if (Number.isFinite(usedUsd)) parts.push(`累计已用 ${formatUsd(usedUsd)}`);
  const accessUntil = Number(sub?.access_until) || 0;
  if (accessUntil > 0) {
    const dt = new Date(accessUntil * 1000);
    if (!Number.isNaN(dt.getTime())) parts.push(`有效期至 ${dt.toLocaleDateString('zh-CN')}`);
  }
  return {
    source: 'billing',
    unlimited: false,
    remainingUsd: Number.isFinite(remaining) ? remaining : null,
    usedUsd: Number.isFinite(usedUsd) ? usedUsd : null,
    accessUntil,
    summary: parts.join('，') || '查询成功',
  };
}

async function fetchApiBalance(url, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('请先填写 API Key');
  const bases = balanceBaseCandidates(url);
  if (!bases.length) throw new Error('请先填写 Base URL');

  let lastErr = '该中转站不支持余额查询';
  for (const base of bases) {
    const tokenEndpoint = `${base}/api/usage/token/`;
    try {
      const data = await fetchBalanceJson(tokenEndpoint, key);
      const parsed = parseTokenUsageBalance(data);
      if (parsed) return { ok: true, ...parsed, endpoint: tokenEndpoint };
    } catch (e) {
      lastErr = e.message;
      if (e.status === 401) throw new Error('API Key 无效或未授权');
    }
  }

  for (const base of bases) {
    const subEndpoints = base.endsWith('/v1')
      ? [`${base}/dashboard/billing/subscription`]
      : [`${base}/v1/dashboard/billing/subscription`, `${base}/dashboard/billing/subscription`];
    const usageEndpoints = base.endsWith('/v1')
      ? [`${base}/dashboard/billing/usage`]
      : [`${base}/v1/dashboard/billing/usage`, `${base}/dashboard/billing/usage`];

    for (let i = 0; i < subEndpoints.length; i++) {
      try {
        const sub = await fetchBalanceJson(subEndpoints[i], key);
        let usage = {};
        try { usage = await fetchBalanceJson(usageEndpoints[i], key); } catch {}
        const parsed = parseBillingBalance(sub, usage);
        if (parsed) return { ok: true, ...parsed, endpoint: subEndpoints[i] };
      } catch (e) {
        lastErr = e.message;
        if (e.status === 401) throw new Error('API Key 无效或未授权');
      }
    }
  }

  throw new Error(lastErr);
}

/**
 * 识图：根据用户自拍生成可供角色聊天引用的外貌描述。
 */
async function describeUserAppearance(settings, imageUrl, publicBase = '') {
  const abs = toAbsoluteMediaUrl(imageUrl, publicBase || '');
  if (!abs) return '';
  try {
    const picMsg = { id: 'user_selfie_' + Date.now(), role: 'user', content: abs, type: 'image' };
    const apiHistory = buildHistoryApiMessages([picMsg], publicBase || '', {});
    const ask = '仔细看这张用户自拍，用中文写一段客观外貌描述（40～100字），供聊天角色认识用户长相。须包含：性别观感、大致年龄段、发色发型、五官与肤色、体型/穿着风格、显著特征。只输出描述本身，不要称呼、不要推测性格、不要寒暄、不要用「照片里」。';
    if (apiHistory.length) {
      const last = apiHistory[apiHistory.length - 1];
      if (Array.isArray(last.content)) {
        last.content.unshift({ type: 'text', text: ask });
      } else {
        apiHistory.push({ role: 'user', content: ask });
      }
    }
    const raw = await callChatAPIComplete(
      settings,
      '你是外貌描述助手。只输出一段客观中文外貌描写，供角色扮演聊天引用。',
      null,
      'chat',
      apiHistory,
    );
    return String(raw || '')
      .replace(/^["「『]|["」』]$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  } catch (e) {
    console.warn('[user-appearance] describe', e.message);
    return '';
  }
}

/**
 * 观影：把屏幕画面转成「一起看的内容」摘要，供通话角色当当面追剧用（不提截图/UI）。
 */
async function describeCallWatchScene(settings, imageUrl, publicBase = '') {
  const abs = toAbsoluteMediaUrl(imageUrl, publicBase || '');
  if (!abs) return '';
  try {
    const picMsg = { id: 'call_watch_' + Date.now(), role: 'user', content: abs, type: 'image' };
    const apiHistory = buildHistoryApiMessages([picMsg], publicBase || '', {});
    const ask = `根据这张手机画面，用中文写 2～4 句「你们正在一起看什么」。
优先写：片名/节目/视频类型（能认就写）、此刻剧情或画面在发生什么、重要对白/字幕要点（若有）。
禁止写：截图、屏幕、界面、状态栏、图标、通知、识图、照片。
不要评价画质，不要寒暄。看不清就写「画面不太清楚，像是在看视频或刷内容」。只输出摘要本身。`;
    if (apiHistory.length) {
      const last = apiHistory[apiHistory.length - 1];
      if (Array.isArray(last.content)) {
        last.content.unshift({ type: 'text', text: ask });
      } else {
        apiHistory.push({ role: 'user', content: ask });
      }
    }
    const raw = await callChatAPIComplete(
      settings,
      '你是观影内容摘要助手。把画面转成两人当面一起看的剧情/内容说明，禁止提及截图或手机界面。',
      null,
      'chat',
      apiHistory,
    );
    return String(raw || '')
      .replace(/^["「『]|["」』]$/g, '')
      .replace(/\s+/g, ' ')
      .replace(/截图|屏幕截图|手机屏幕|识图|界面|状态栏/g, '')
      .trim()
      .slice(0, 280);
  } catch (e) {
    console.warn('[call-watch] describe', e.message);
    return '';
  }
}

module.exports = {
  fetchWithTimeout,
  isApiBillingError,
  formatApiBillingError,
  fetchApiBalance,
  resolveTaskApiCreds,
  callChatAPI,
  callChatAPIComplete,
  completeChatTurn,
  describeUserAppearance,
  describeCallWatchScene,
  callTTS,
  generateMinimaxInstrumental,
  generateGeminiLyriaInstrumental,
  normalizeTtsEmotion,
  normalizeTtsTone,
  inferTtsEmotionFromEmotionState,
  resolveTtsEmotion,
  resolveCallTtsEmotion,
  resolveTtsSpeed,
  generateImage,
  getLastGenerateImageError,
  getLastGenerateImageMeta,
  resolveImg2ImgConfig,
  resolveImg2VideoConfig,
  routeSettingsForMediaGen,
  normalizeSelfieAspect,
  normalizeVideoAspect,
  inferChatMediaAspect,
  normalizeImageRefGroups,
  flattenImageRefGroups,
  selectSelfieReferenceUrls,
  resolveSelfieRefFlags,
  wantsSpecialFormScene,
  selectVideoReferenceUrl,
  extractSelfieSceneQuery,
  buildSelfieStylePrompt,
  getDefaultSelfieStylePrompt,
  DEFAULT_SELFIE_STYLE_REAL,
  DEFAULT_SELFIE_STYLE_ANIME,
  DEFAULT_VIDEO_MOTION_PROMPT,
  DEFAULT_NSFW_VIDEO_MOTION_PROMPT,
  buildSelfieGenerationPrompt,
  buildCharacterAppearanceHint,
  resolveCharacterHomeEnvironment,
  buildCharacterHomeEnvironmentHint,
  enrichSelfieSceneQuery,
  resolveSelfiePlaceContext,
  formatHomeEnvironmentForChatPrompt,
  normalizeHomeRefs,
  homeRefsToJson,
  formatHomeRefsForPrompt,
  selectHomeReferenceUrls,
  buildHomeRefConsistencyPrompt,
  isObjectOrStillLifeScene,
  sceneShouldUseHomeRefs,
  is80AiImageApi,
  fetch80AiImageModels,
  fetch80AiImageModelOptions,
  normalize80AiModelInput,
  MINIMAX_SPEECH_MODELS,
  IMAGEN_MODELS,
  listKnownImageModels,
  listKnownImg2VideoModels,
  fetchImg2ImgModelsFromApi,
  fetchImg2VideoModelsFromApi,
  fetchUnsplashImage,
  fetchUnsplashImageForMoment,
  fetchUnsplashImageForChat,
  buildChatContextImagePrompt,
  generateChatContextImage,
  generateVideo,
  generateImageToVideo,
  getLastGenerateVideoError,
  getLastGenerateVideoMeta,
  buildChatContextVideoPrompt,
  generateChatContextVideo,
  fetchPexelsVideoForMoment,
  generateMomentVideoViaAI,
  fetchPexelsVideo,
  fetchPexelsVideoForChat,
  extractImageQueryFromText,
  parseMomentContentAndImageQuery,
  replySuggestsContextImage,
  replySuggestsShareImage,
  replySuggestsShareVideo,
  replyClaimsSentShareMedia,
  replyLooselyClaimsSentMedia,
  resolveClaimedMissingShare,
  isHardUserImageAsk,
  isHardUserSelfieAsk,
  replyRefusesShareMedia,
  detectDrawingMediaIntent,
  isDrawingMediaAsk,
  inferChatMediaNsfwContext,
  replyAsksUserForImage,
  replyAsksUserForVideo,
  shouldAttachContextImage,
  shouldAttachContextVideo,
  normalizeMediaDirectiveLines,
  stripImageDirectiveForDisplay,
  stripImageDirectiveFromSegments,
  buildChatImagePromptSection,
  buildSelfieRefConsistencyPrompt,
  photoLikelyHasPeople,
  toAbsoluteMediaUrl,
  buildHistoryApiMessages,
  detectAvatarChangeIntent,
  replyAcceptsAvatarChange,
  stripAvatarChangeMarker,
  buildAvatarChangeChoiceHint,
  isImageMessageType,
  isRobotFrameMessage,
  isRobotMicMessage,
};

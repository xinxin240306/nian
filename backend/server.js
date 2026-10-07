require('dotenv').config({ path: require('path').join(__dirname, '.env') });
// 始终覆盖为 node-fetch：Node 18+ 自带 fetch 会忽略 timeout 选项，
// 聊天 API 卡住时请求永不结束，前端表现为发送无响应、其它页面一直转圈。
// 聊天热路径另用 fetchWithTimeout（timeout + AbortSignal）。
global.fetch = require('node-fetch');
const fetch = global.fetch;
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const dbModule = require('./db');
const { initWS, push, notifyBillingError } = require('./push');
const { startCronJobs, buildSystemPrompt, buildCallExtraSystemPrompt, prefetchLocationWeather, buildDiaryPeekPrompt, generateMemorySummary, backfillMemoriesFromChat, summarizeTheaterSession, scheduleTheaterMemorySummary, maybeTriggerMemorySummary, maybeCaptureSalientFromMessage, maybeCaptureUserImpressionsFromMessage, messageTriggersMemoryKeyword, messageIndicatesSalientPlan, messageIndicatesSalientEmotion, messageIndicatesUserProfileShare, touchCharacterEmotionFromMessage, buildChatContextText, buildSleepContextNote, buildStatedIntentElapsedNote, buildRetryTimeAdvanceNote, buildReplyTimeNotePayload, computeUserReturnGap, parseMsgTimestamp, getUserMessagesNeedingRealReply, checkAiPeekDiaries, checkAiPeekSecrets, selectMemoriesForPrompt, isMemorySummaryEnabled, generateDailySchedule, generateWeeklySchedules, getLocalDateStr, shiftDateStr, maybeFinalizePastScheduleItems, rehomeWeeHoursScheduleItems, sortScheduleItemsByTime, clearCharacterOnline, mergeImpressionItems, expandLegacyImpressions, deriveImpressionKeywords, normalizeImpressionCategory, mapMemoryToImpressionCategory, resolveImpressionCategory, isJunkImpressionFact, scheduleLooksComplete, backfillYesterdayNightSleepConclusion, IMPRESSION_CATEGORIES, IMPRESSION_CATEGORY_HINTS, generateAIDiary, catchUpMissedDiaries, DREAM_NARRATIVE_SUFFIX, syncScheduleFromChatActivity, withCharChatPrefs, getMemoryTriggerN, getUserMomentChatCue, claimMomentChatAsk, formatMemoriesForPromptAsync } = require('./cron');
const memoryNarrative = require('./memory-narrative-helper');
const memoryBrain = require('./memory-brain-helper');
const {
  listSecretNotes, insertSecretNote, generateSecretNotesForDay, noteAtNow, SECRET_SECTIONS, ALL_SECTIONS,
} = require('./secret-helper');
const sharedMemo = require('./shared-memo-helper');
const { callChatAPI, callChatAPIComplete, completeChatTurn, callTTS, generateImage, getLastGenerateImageError, getLastGenerateImageMeta, resolveImg2ImgConfig, resolveImg2VideoConfig, routeSettingsForMediaGen, inferChatMediaNsfwContext, normalizeSelfieAspect, normalizeVideoAspect, inferChatMediaAspect, normalizeImageRefGroups, selectSelfieReferenceUrls, resolveSelfieRefFlags, selectVideoReferenceUrl, selectHomeReferenceUrls, normalizeHomeRefs, homeRefsToJson, isObjectOrStillLifeScene, is80AiImageApi, fetch80AiImageModels, fetch80AiImageModelOptions, MINIMAX_SPEECH_MODELS, IMAGEN_MODELS, listKnownImageModels, listKnownImg2VideoModels, fetchImg2ImgModelsFromApi, fetchImg2VideoModelsFromApi, fetchUnsplashImage, generateChatContextImage, generateChatContextVideo, generateImageToVideo, getLastGenerateVideoError, fetchPexelsVideo, fetchPexelsVideoForChat, parseMomentContentAndImageQuery, extractImageQueryFromText, extractSelfieSceneQuery, buildSelfieGenerationPrompt, resolveCharacterHomeEnvironment, shouldAttachContextImage, shouldAttachContextVideo, replySuggestsShareImage, replySuggestsShareVideo, replyClaimsSentShareMedia, resolveClaimedMissingShare, replyAsksUserForImage, replyAsksUserForVideo, isHardUserImageAsk, isHardUserSelfieAsk, replyRefusesShareMedia, detectDrawingMediaIntent, normalizeMediaDirectiveLines, stripImageDirectiveFromSegments, buildHistoryApiMessages, detectAvatarChangeIntent, replyAcceptsAvatarChange, stripAvatarChangeMarker, buildAvatarChangeChoiceHint, toAbsoluteMediaUrl, formatApiBillingError, fetchApiBalance, fetchWithTimeout, describeUserAppearance, describeCallWatchScene } = require('./api-helper');
const { processAiContentWithEmojis, saveAiReplySegments, stripAiContextLabels, stripModelLeakage, splitAiSegments, userRequestsVoiceMessage, userRequestsPhoneCall, resolveChatIncomingCall, insertCharacterPokeMessage, polishSpokenAiText, dedupeContinuationPiece, decorateEmojiRecord, resolveLiveEmojiUrl, healMissingEmojiFiles, mergeReplacementEmoji, invalidateEmojiLiveCache, emojiBasename, looksLikeStandaloneHtml, looksLikeWebCardPayload } = require('./emoji-helper');
const robotHelper = require('./robot-helper');
const robotVision = require('./robot-vision-helper');
const robotMic = require('./robot-mic-helper');
const robotFaceTrack = require('./robot-face-track-helper');
const robotCommands = require('./robot-commands-helper');
const robotDriveHelper = require('./robot-drive-helper');
const robotIdentityHelper = require('./robot-identity-helper');
const robotOperatingHelper = require('./robot-operating-helper');
const robotScreen = require('./robot-screen-helper');
const robotDeviceBridge = require('./robot-device-bridge');
const robotMcpBridge = require('./robot-mcp-bridge');
const crypto = require('crypto');
const {
  stripAlbumMarkersFromText,
  extractAlbumSelfieSceneForApi,
  hasAlbumSelfieMarker,
  stripAlbumMarkersFromSegments,
  queueAlbumSave,
  localizeMediaToUploads,
  backfillAlbumFromChatMedia,
  mapAlbumRow,
  saveRobotSnapshotToAlbum,
} = require('./album-helper');
const contacts = require('./contact-helper');
const siteLock = require('./site-lock');
const gameButler = require('./game-butler-helper');
const voiceprintHelper = require('./voiceprint-helper');
const faceprintHelper = require('./faceprint-helper');
const dreamHelper = require('./dream-helper');
const seriesHelper = require('./series-helper');
const isekaiHelper = require('./isekai-helper');
const whatifHelper = require('./whatif-helper');
const seriesJobs = require('./series-jobs');
const illusionHelper = require('./illusion-helper');
const timelineHelper = require('./timeline-helper');
const { attachMusicScoreMessage, stripMusicScoreFromSegments } = require('./music-score-helper');
const { attachSoundFxMessage, attachSoundFxMessages, stripSoundFxFromSegments, getCallScene, clearCallScene, rememberCallWatchScene, getCallWatchScene } = require('./sound-fx-helper');
const { prepareVocalReply, attachVocalClipMessages, insertVocalMessages } = require('./vocal-clips-helper');
const { sanitizeInlineBeans, isKnownBean } = require('./inline-emoji-helper');
const { sanitizeForSpeech } = require('./speech-text-helper');
const { applyBrainUnderstanding } = require('./understanding-helper');

// 环境床只由角色这轮说的话决定，不再翻行程表/居所/历史去猜，所以这里没别的可带
function voiceCallSfxExtras(isVoiceMode, char) {
  if (!isVoiceMode || !char) return {};
  return { forVoiceCall: true, char };
}

function callAmbienceField(isVoiceMode, characterId) {
  if (!isVoiceMode) return undefined;
  const scene = getCallScene(characterId);
  let texture;
  try { texture = require('./sound-fx-helper').getCallTexture(characterId); } catch {}
  // 拟声呼吸垫已停用，不再塞 breath
  // 没有现场床就别每轮塞 stop——停环境只走角色写的「环境：无」
  if (!scene?.url && !texture?.url) return undefined;
  return {
    url: scene?.url,
    stop: !scene?.url,
    prompt: scene?.prompt || '',
    volume: scene?.volume,
    texture: texture?.url ? { url: texture.url, volume: texture.volume } : undefined,
  };
}

function attachReplyVocal(aiMessages, opts) {
  try {
    insertVocalMessages(aiMessages, attachVocalClipMessages(opts));
  } catch (e) {
    console.warn('[vocal]', e.message);
  }
}

/** 聊天模型剥完动作/指令后没正文：200 交给前端用用户气泡「嗯」顶上去，不要 500 弹错误 */
function emptyAiChatPayload(extra = {}) {
  return {
    aiMsgId: null,
    content: '',
    aiMessages: [],
    emptyReply: true,
    ...extra,
  };
}

/** 整句都是「我正在抹/涂/按摩」这种手上旁白，不是开口说的话 */
function isHandsAside(body) {
  const t = String(body || '').replace(/\s+/g, '');
  if (!t || /[？?]$/.test(t)) return false;
  return /^[我他她](?:正|正在|还在).{0,28}(?:抹|涂|敷|按摩|揉)/.test(t)
    && /面霜|乳液|按摩|护肤|脖子|手部|脸上|手上/.test(t);
}

function stripActions(text, opts = {}) {
  if (!text) return text;
  // 先按句切，避免「*上一句。*下一句」被当成一对星号，把对白删掉
  text = text.replace(/[^\n。！？!?]*[。！？!?]?/g, (sent) => {
    if (!String(sent || '').trim()) return sent;
    let s = sent.replace(/\*[^*\n。！？!?]{1,80}\*/g, '');
    const peeled = s.replace(/^\s*[*＊]+\s*/, '').replace(/\s*[*＊]+\s*$/, '');
    if (isHandsAside(peeled)) return '';
    return peeled === sent ? sent : peeled;
  });
  // （心理/动作括注） → 删除（仅短括注，避免误删正文内容）
  text = text.replace(/[（(][^）)\n]{1,60}[）)]/g, (m) => {
    const inner = m.slice(1, -1);
    // 如果括注以动词/副词开头则删除，否则保留（比如人名或数字）
    if (/^(轻|慢|静|悄|微|忽|突|深|低|抬|转|皱|叹|笑|哭|望|看|摸|握|拉|推|抱|亲|闭|张|耸|挑|侧|俯|仰|缓|快|用力|轻声|小声|呢喃|喃喃|心里|内心|暗想|思考|想着|感觉|心跳|脸红|害羞|蹭|贴|挨|依|扑|凑|靠)/.test(inner)) return '';
    return m;
  });
  // keepParseTags：聊天入库前的第一遍清理。这些标记还要给后面的解析器看，这里先留着。
  const labelOpts = { keepCallTags: true };
  if (opts.keepParseTags) {
    labelOpts.keepQuoteTags = true;
    labelOpts.keepRecallTags = true;
    labelOpts.keepPokeTags = true;
    labelOpts.keepToneTag = true;
    labelOpts.keepPeerTags = true;
  }
  text = stripAiContextLabels(text, labelOpts);
  // 清理多余空白
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/** 梦境正文是否像被截断（句中断开） */
function looksDreamTextIncomplete(text, finishReason = '') {
  const t = String(text || '').trim();
  if (!t) return true;
  if (finishReason === 'length') return true;
  if (/[。！？…!?」』"'”’～~）)】》]$/.test(t)) {
    const open = (t.match(/「/g) || []).length;
    const close = (t.match(/」/g) || []).length;
    if (open > close) return true;
    return false;
  }
  if (/[，、；,;：:]$/.test(t)) return true;
  if (/[的了着过地得和与及在是把被从向对跟比让给到为以而却又也还但并或与]$/.test(t)) return true;
  const openQ = (t.match(/「/g) || []).length;
  const closeQ = (t.match(/」/g) || []).length;
  if (openQ > closeQ) return true;
  // 较长却无句末标点：多半是截断
  if (t.length >= 36) return true;
  return false;
}

/**
 * 梦境被截断时自动接写，最多 rounds 轮，拼成完整段落。
 */
async function completeDreamIfTruncated({
  baseUrl, apiKey, apiModel, settings, systemPrompt, apiHistory,
  aiContent, rawAiContent, finishReason, rounds = 3,
}) {
  let content = String(aiContent || '');
  let raw = String(rawAiContent || '');
  let reason = finishReason;
  const chatHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  for (let i = 0; i < rounds; i++) {
    if (!looksDreamTextIncomplete(content, reason)) break;
    const continueMessages = [
      {
        role: 'system',
        content: `${systemPrompt}\n【接写】上一段在句中被截断了。请从断句处无缝接完当前句与未完对白，再自然收束到一个完整段落；不要重复已写文字，不要另起新梦。`,
      },
      ...apiHistory,
      { role: 'assistant', content },
      { role: 'user', content: '（请用简体中文从断句处接写完，不要重复上文）' },
    ];
    const continueBody = JSON.stringify({
      model: apiModel,
      messages: continueMessages,
      temperature: parseFloat(settings.chat_temperature || '0.8'),
      max_tokens: 1600,
      stream: false,
    });
    let contData = null;
    try {
      const r = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: chatHeaders, body: continueBody, timeout: 90000,
      });
      if (r.ok) contData = await r.json();
    } catch {}
    if (!contData && !String(baseUrl).endsWith('/v1')) {
      try {
        const r2 = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
          method: 'POST', headers: chatHeaders, body: continueBody, timeout: 90000,
        });
        if (r2.ok) contData = await r2.json();
      } catch {}
    }
    const cont = contData?.choices?.[0]?.message?.content?.trim();
    reason = contData?.choices?.[0]?.finish_reason || '';
    if (!cont) break;
    const contText = normalizeAiReplyText(cont, true);
    if (!contText) break;
    // 若模型又整段复读开头，尽量去重拼接
    let piece = contText;
    if (content && piece.startsWith(content.slice(0, Math.min(40, content.length)))) {
      piece = piece.slice(content.length).trimStart();
    }
    if (!piece) break;
    content = content + piece;
    raw = (raw || '') + piece;
  }
  return { aiContent: content, rawAiContent: raw };
}

/** 梦境叙事保留原文并做对白换行；日常聊天才剥离动作括注；小剧场/文字视频电话保留旁白 */
function normalizeAiReplyText(raw, isDreamMode, opts = {}) {
  const rawText = String(raw || '').trim();
  if (!rawText) return '';
  // 中转空回复/报错 HTML 卡：原样保留，勿 stripActions 撕坏 style
  if (looksLikeStandaloneHtml(rawText) || looksLikeWebCardPayload(rawText)) return rawText;
  const cleaned = stripModelLeakage(rawText);
  if (!cleaned) return '';
  if (isDreamMode) {
    try {
      return dreamHelper.formatDreamProse(cleaned);
    } catch {
      return cleaned;
    }
  }
  if (opts.forTheater || opts.forCallVideoText) {
    // 只去 *星号动作*；文字视频要保留旁白与（动作），引号台词留给通话页解析
    let text = cleaned.replace(/\*[^*\n]{1,120}\*/g, '');
    // 小剧场心里草稿 [这一拍心思]/[动手] 等：入库前剥掉，用户看不见
    if (opts.forTheater) {
      try {
        const { scrubUserVisibleText } = require('./emoji-helper');
        text = scrubUserVisibleText(text, '');
      } catch { /* ignore */ }
      // [场景状态]/[结束小剧场] 留给后面专用解析——scrub 不应误伤；若被剥则场景状态解析会失败
      // scrubUserVisibleText 目前不剥场景状态，安全
    } else if (opts.forCallVideoText) {
      // 旧镜头标记可留到 extract；这里不去掉旁白
    }
    return text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  // 日常聊天：先留住还要解析的隐藏标记，入库前再剥
  return stripActions(cleaned, { keepParseTags: true });
}

const THEATER_END_RE = /\[\s*结束小剧场\s*\]/g;
const THEATER_START_RE = /\[\s*开启小剧场\s*\]/g;

function isTheaterActive(char) {
  return Number(char?.theater_active) === 1;
}

function mergeMessageMediaMeta(msgId, patch) {
  try {
    const row = db.prepare('SELECT media_meta FROM messages WHERE id=?').get(msgId);
    let meta = {};
    try { meta = JSON.parse(row?.media_meta || '{}') || {}; } catch { meta = {}; }
    Object.assign(meta, patch || {});
    db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), msgId);
  } catch (e) {
    console.warn('[theater] media_meta save failed:', e.message);
  }
}

function insertTheaterSystemMessage(characterId, content) {
  const now = new Date().toISOString();
  const id = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,1)`
  ).run(characterId, 'assistant', content, 'system', now, 0).lastInsertRowid;
  return { id, content, type: 'system' };
}

function setTheaterActive(characterId, active) {
  // 开/关都清空场景状态，避免上场残留或下场串戏
  db.prepare('UPDATE characters SET theater_active=?, theater_scene_state=? WHERE id=?')
    .run(active ? 1 : 0, '', characterId);
}

function stripTheaterEndMarker(text) {
  return String(text || '').replace(THEATER_END_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function hasTheaterEndMarker(text) {
  return /\[\s*结束小剧场\s*\]/.test(String(text || ''));
}

function stripTheaterStartMarker(text) {
  return String(text || '').replace(THEATER_START_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function hasTheaterStartMarker(text) {
  return /\[\s*开启小剧场\s*\]/.test(String(text || ''));
}

/** 只剥离 [场景状态] 标记，不写库 */
function stripTheaterSceneStateMarkers(text) {
  let cleaned = String(text || '');
  cleaned = cleaned.replace(/\[\s*场景状态\s*\][\s\S]*?\[\s*\/\s*场景状态\s*\]/gi, '');
  cleaned = cleaned.replace(/\[\s*场景状态\s*\][\s\S]*$/i, '');
  cleaned = cleaned.replace(/\[\s*\/\s*场景状态\s*\]/gi, '');
  return cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 视频电话·文字画面：剥离 [镜头]…[/镜头] */
function stripCallLensMarkers(text) {
  let cleaned = String(text || '');
  cleaned = cleaned.replace(/\[\s*镜头\s*\][\s\S]*?\[\s*\/\s*镜头\s*\]/gi, '');
  cleaned = cleaned.replace(/\[\s*镜头\s*\][\s\S]*$/i, '');
  cleaned = cleaned.replace(/\[\s*\/\s*镜头\s*\]/gi, '');
  return cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 抽出引号内台词（「」『』“”""） */
function extractQuotedSpeechParts(text) {
  const raw = String(text || '');
  const quotes = [];
  const re = /「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const q = String(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (q) quotes.push(q);
  }
  return quotes;
}

/**
 * 文字版视频电话：整段是镜头画面；引号里才是开口说的话。
 * 兼容旧 [镜头]…[/镜头]。
 */
function stripCallVideoPrivateLeak(text) {
  try {
    const { scrubUserVisibleText } = require('./emoji-helper');
    return scrubUserVisibleText(text, '');
  } catch {
    return String(text || '')
      .replace(/[\[【［]\s*通话\s*[\]】］]\s*(?:你说|对方说|我说)?\s*[:：]?\s*/g, '')
      .replace(/(?:^|\n)\s*(?:你说|对方说)\s*[:：]\s*/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

function parseCallVideoTextScene(text) {
  const raw = stripCallVideoPrivateLeak(String(text || '').trim());
  if (!raw) return { lens: '', quotes: [], speechText: '', cleaned: '' };
  const withoutLegacy = stripCallLensMarkers(raw);
  const legacyRe = /\[\s*镜头\s*\]([\s\S]*?)\[\s*\/\s*镜头\s*\]/gi;
  let legacyLens = '';
  let lm;
  const legacySrc = String(text || '');
  while ((lm = legacyRe.exec(legacySrc)) !== null) {
    legacyLens = String(lm[1] || '').trim();
  }
  const quotes = extractQuotedSpeechParts(withoutLegacy);
  const speechText = quotes.join(' ').trim();
  // 画面：优先整段（含旁白+引号），没有旁白时用旧镜头标记
  const lens = (withoutLegacy || legacyLens || '').trim().slice(0, 1200);
  return {
    lens,
    quotes,
    speechText,
    cleaned: withoutLegacy || raw,
  };
}

/** @deprecated 兼容旧调用：抽出镜头描述 */
function extractCallLensFromReply(text) {
  const scene = parseCallVideoTextScene(text);
  // 旧逻辑期望 cleaned=剥掉镜头后的开口；新格式 cleaned 仍是整段，speech 另取
  const legacyOnly = (() => {
    const raw = String(text || '');
    const re = /\[\s*镜头\s*\]([\s\S]*?)\[\s*\/\s*镜头\s*\]/gi;
    let lens = '';
    let m;
    while ((m = re.exec(raw)) !== null) lens = String(m[1] || '').trim().slice(0, 240);
    if (!lens) {
      const open = raw.match(/[\[【［]\s*镜头\s*[\]】］]\s*([^\n\r]{2,240})/i);
      if (open) lens = String(open[1] || '').replace(/[\[【［]\s*\/\s*镜头\s*[\]】］]\s*$/i, '').trim().slice(0, 240);
    }
    return { lens, cleaned: stripCallLensMarkers(raw) };
  })();
  // 有引号旁白体：画面用整段；cleaned 保留整段供历史连贯（朗读前端再抽引号）
  if (scene.quotes.length) {
    return { lens: scene.lens || legacyOnly.lens, cleaned: scene.cleaned, quotes: scene.quotes, speechText: scene.speechText };
  }
  if (legacyOnly.lens) {
    return { lens: legacyOnly.lens, cleaned: legacyOnly.cleaned, quotes: [], speechText: legacyOnly.cleaned };
  }
  // 无引号也无旧标记：整段既当画面也当可说内容（兜底）
  return { lens: scene.lens, cleaned: scene.cleaned, quotes: [], speechText: scene.cleaned };
}

function isCharCallVideoTextMode(char) {
  return String(char?.call_video_mode || 'video').trim().toLowerCase() === 'text';
}

/** 解析并剥离 [场景状态]…[/场景状态]，写回角色本场扮演状态 */
function applyTheaterSceneStateFromReply(characterId, text) {
  const raw = String(text || '');
  const re = /\[\s*场景状态\s*\]([\s\S]*?)\[\s*\/\s*场景状态\s*\]/gi;
  let state = null;
  let m;
  while ((m = re.exec(raw)) !== null) {
    state = String(m[1] || '').trim().slice(0, 800);
  }
  const cleaned = stripTheaterSceneStateMarkers(raw);
  if (state != null) {
    const normalized = /^无特殊限制$|^无$|^无\s*限制$/i.test(state) ? '' : state;
    try {
      db.prepare('UPDATE characters SET theater_scene_state=? WHERE id=?').run(normalized, characterId);
    } catch (e) {
      console.warn('[theater] scene state save failed:', e.message);
    }
  }
  return cleaned;
}

/** 若回复含结束标记：清标记、关小剧场、插系统气泡，并异步概括本场扮演进记忆 */
function applyTheaterEndIfNeeded(characterId, rawOrClean, systemHints = []) {
  if (!hasTheaterEndMarker(rawOrClean)) {
    return { text: String(rawOrClean || ''), ended: false, systemHints };
  }
  const text = stripTheaterEndMarker(rawOrClean);
  setTheaterActive(characterId, false);
  push('character_update', { characterId, theater_active: 0 });
  const hint = insertTheaterSystemMessage(characterId, '小剧场结束，回到正常聊天');
  systemHints.push(hint);
  scheduleTheaterMemorySummary(characterId);
  return { text, ended: true, systemHints };
}

/** 普通聊天里写 [开启小剧场]：清标记、开小剧场；系统气泡由调用方接到 AI 话之后 */
function applyTheaterStartIfNeeded(characterId, rawOrClean, systemHints = []) {
  if (!hasTheaterStartMarker(rawOrClean)) {
    return { text: String(rawOrClean || ''), started: false, startHint: null, systemHints };
  }
  const text = stripTheaterStartMarker(rawOrClean);
  const char = db.prepare('SELECT theater_active FROM characters WHERE id=?').get(characterId);
  if (isTheaterActive(char)) {
    return { text, started: true, startHint: null, systemHints };
  }
  setTheaterActive(characterId, true);
  push('character_update', { characterId, theater_active: 1 });
  const hint = insertTheaterSystemMessage(characterId, '小剧场开始了（文字扮演，不是真实剧情）');
  return { text, started: true, startHint: hint, systemHints };
}

/** 梦境可单独配置 API；未填则退回聊天 API */
function resolveChatApiSettings(settings, isDreamMode, char = null) {
  const dreamUrl = (settings.dream_api_url || '').trim();
  const useDream = isDreamMode && dreamUrl;
  const url = (useDream ? dreamUrl : (settings.chat_api_url || '')).trim();
  const key = ((useDream ? settings.dream_api_key : settings.chat_api_key) || settings.chat_api_key || '').trim();
  let model = (useDream && (settings.dream_model || '').trim())
    ? settings.dream_model.trim()
    : (settings.chat_model || 'gpt-4o').trim();
  if (!useDream) {
    const charModel = String(char?.chat_model || '').trim();
    if (charModel) model = charModel;
  }
  return { url, key, model };
}

/** 向在线客户端推送新 AI 消息（用户不在聊天页时显示横幅/角标） */
function broadcastChatMessage(characterId, content, aiMessages, isDream = false) {
  if (isDream === true || isDream === 1 || isDream === '1') return;
  const hasImage = (aiMessages || []).some(m => m.type === 'image' || m.type === 'video');
  const preview = content
    || (aiMessages || []).filter(m => m.type === 'text' || m.type === 'voice').map(m => {
      if (m.type !== 'voice') return m.content;
      try {
        const j = JSON.parse(String(m.content || ''));
        if (j?.score) return j.transcript || '♪ 演奏';
        if (j?.voice && j.transcript) return j.transcript;
        if (j?.voice && j.url) return '[语音]';
      } catch {}
      return m.content;
    }).join('\n')
    || (hasImage ? '[图片]' : '新消息');
  push('background_message', { characterId, content: preview, aiMessages: aiMessages || [] });
}

const SELFIE_PATTERNS = [
  /\[自拍\]/,
  /\[我的照片\]/,
  /自拍[：:]/, // 系统指令「自拍：英文场景」——此前冒号导致整段识别失败
  /我的自拍/,
  /(?:发|拍)(?:一张|张|个)?(?:自拍|本人照)/,
  /给(?:你|您)(?:看|发)(?:我的)?(?:自拍|本人照)/,
  /这是(?:我的)?(?:自拍|本人照)/,
];

// 注：故意不收录裸词「自拍」「拍好了」「照片发你了」——这些太宽泛，
// 角色闲聊时随口提一句「自拍」也会命中，导致明明写了「配图：」发风景/其他照片，
// 却被误判成自拍走了带脸部参考图的图生图（结果发出来的还是长着角色脸的图）。
function hasExplicitSelfieIntent(text) {
  const t = String(text || '');
  if (/不是.{0,8}自拍|非自拍|没.{0,3}自拍|不含自拍|别.{0,4}自拍|不要自拍/.test(t)) return false;
  return SELFIE_PATTERNS.some(p => p.test(t));
}

function matchImageIntent(rawText, cleanText) {
  const combined = `${rawText || ''}\n${cleanText || ''}`.trim();
  const parsed = parseMomentContentAndImageQuery(combined);
  const parsedRaw = parseMomentContentAndImageQuery(rawText || '');
  let presetQuery = parsed.imageQuery !== undefined ? parsed.imageQuery : parsedRaw.imageQuery;
  const videoQuery = parsed.videoQuery !== undefined ? parsed.videoQuery : parsedRaw.videoQuery;
  const albumSelfieScene = extractAlbumSelfieSceneForApi(rawText || '') ?? extractAlbumSelfieSceneForApi(combined);
  let selfieScene = extractSelfieSceneQuery(rawText || '')
    ?? extractSelfieSceneQuery(combined)
    ?? (albumSelfieScene !== undefined ? albumSelfieScene : undefined);
  const hasSelfieLine = typeof selfieScene === 'string' && !!selfieScene.trim();
  const hasAlbumSelfieMark = hasAlbumSelfieMarker(rawText) || hasAlbumSelfieMarker(combined);
  const hasExplicitImageLine = typeof presetQuery === 'string' && !!presetQuery.trim();
  let hasExplicitSelfie = hasSelfieLine
    || hasAlbumSelfieMark
    || (!hasExplicitImageLine && hasExplicitSelfieIntent(combined));
  // AI 误把「自拍：鱼缸里的小红鱼」写成自拍 → 改走配图（无脸图、无家装参考）
  if (hasExplicitSelfie && hasSelfieLine && isObjectOrStillLifeScene(selfieScene)) {
    if (presetQuery === undefined) presetQuery = selfieScene;
    hasExplicitSelfie = false;
    selfieScene = undefined;
  }
  const wantsGeneral = shouldAttachContextImage(combined, presetQuery, { hasExplicitSelfie, forChat: true });
  const wantsVideo = shouldAttachContextVideo(combined, videoQuery, { forChat: true });
  return { hasExplicitSelfie, wantsGeneral, wantsVideo, combined, parsed, parsedRaw, presetQuery, videoQuery, selfieScene };
}

function aspectFromPendingContent(content, fallback = '') {
  const m = String(content || '').match(
    /^__(?:pending_selfie|selfie_failed|pending_video|video_failed)__(?::([\d:]+))?$/
  );
  return m?.[1] ? normalizeSelfieAspect(m[1]) : (fallback ? normalizeSelfieAspect(fallback) : '');
}

/** 把 media_meta.aspect 暴露给前端（气泡 data-aspect / CSS 严格比例） */
function enrichMessageMediaFields(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  let aspect = '';
  try {
    const meta = typeof msg.media_meta === 'string' && msg.media_meta
      ? JSON.parse(msg.media_meta)
      : (msg.media_meta || {});
    if (meta?.aspect) aspect = String(meta.aspect);
    if (meta?.tts_emotion) msg.tts_emotion = String(meta.tts_emotion);
    if (meta?.tts_tone) msg.tts_tone = String(meta.tts_tone);
    if (Number.isFinite(Number(meta?.lat)) && Number.isFinite(Number(meta?.lng))) {
      msg.lat = Number(meta.lat);
      msg.lng = Number(meta.lng);
    }
  } catch { /* ignore */ }
  if (!aspect) aspect = aspectFromPendingContent(msg.content);
  if (aspect) {
    const a = normalizeSelfieAspect(aspect);
    msg.media_aspect = a;
    msg.aspect = a;
  }
  try {
    if (msg.type === 'emoji' && msg.content) {
      msg.content = resolveLiveEmojiUrl(msg.content) || msg.content;
    } else if (msg.content && /\[em\|/i.test(String(msg.content))) {
      msg.content = String(msg.content).replace(/\[em\|([^\]|]+)\|([^\]]*)\]/g, (full, url, desc) => {
        const live = resolveLiveEmojiUrl(url);
        return live ? `[em|${live}|${desc}]` : full;
      });
    }
  } catch { /* ignore */ }
  return msg;
}

function appendImageMessages(aiMessages, imgs) {
  const now = new Date().toISOString();
  if (imgs.selfieImgId && imgs.selfieImgUrl) {
    const aspect = imgs.selfieAspect
      || aspectFromPendingContent(imgs.selfieImgUrl, '3:4');
    aiMessages.push({
      id: imgs.selfieImgId, type: 'image', content: imgs.selfieImgUrl,
      timestamp: now, aspect, media_aspect: aspect, is_read: 0,
    });
  }
  if (imgs.generalImgId && imgs.generalImgUrl) {
    const aspect = imgs.generalImageAspect || '3:4';
    aiMessages.push({
      id: imgs.generalImgId, type: 'image', content: imgs.generalImgUrl,
      timestamp: now, aspect, media_aspect: aspect, is_read: 0,
    });
  }
  if (imgs.generalVideoId && imgs.generalVideoUrl) {
    const aspect = imgs.videoAspect
      || aspectFromPendingContent(imgs.generalVideoUrl, '9:16');
    aiMessages.push({
      id: imgs.generalVideoId, type: 'video', content: imgs.generalVideoUrl,
      timestamp: now, aspect, media_aspect: aspect, is_read: 0,
    });
  }
  return aiMessages;
}

/** 把 dataURL / 裸 base64 落盘为 /uploads/…，避免 WS 推送超大 base64 失败 */
function persistGeneratedImageUrl(url) {
  if (!url || typeof url !== 'string') return url;
  let u = url.trim();
  if (!u) return u;
  if (u.startsWith('/uploads/')) return u;
  if (/^https?:\/\//i.test(u)) return u;

  let ext = 'png';
  let b64 = '';
  const dataMatch = u.match(/^data:image\/([\w+.-]+);base64,(.+)$/s);
  if (dataMatch) {
    const mime = dataMatch[1].toLowerCase();
    ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
      : mime.includes('webp') ? 'webp'
      : mime.includes('gif') ? 'gif'
      : 'png';
    b64 = dataMatch[2];
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(u) && u.replace(/\s/g, '').length > 200) {
    b64 = u.replace(/\s/g, '');
  } else {
    return u;
  }

  try {
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return u;
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const filename = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, filename), buf);
    console.log('[chat image] 已落盘', filename, `(${Math.round(buf.length / 1024)}KB)`);
    return `/uploads/${filename}`;
  } catch (e) {
    console.warn('[chat image] 落盘失败，保留原 URL:', e.message);
    return u.startsWith('data:') ? u : `data:image/png;base64,${b64}`;
  }
}

function normalizeChatImageUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u) && !u.startsWith('/') && !u.startsWith('data:')) {
    return persistGeneratedImageUrl(`data:image/png;base64,${u}`);
  }
  if (u.startsWith('data:image/') || (/^[A-Za-z0-9+/=]+$/.test(u) && u.length > 200)) {
    return persistGeneratedImageUrl(u);
  }
  return u;
}

function detectUserSfxRequest(text) {
  const t = String(text || '');
  return /海风|浪声|水声|雨声|雷声|环境音|音效|白噪音|白噪声|white\s*noise|助眠音|听听.{0,8}(风声|海浪|海水|雨|流水|白噪)|发(?:个|段|条).{0,8}(风声|水声|雨声|海浪|海风|白噪)|想听.{0,8}(海风|海浪|雨声|水声|白噪)/i.test(t);
}

function detectUserImageRequest(text) {
  return isHardUserImageAsk(text);
}

/** 用户要看角色本人/自拍（不是风景静物） */
function detectUserSelfieRequest(text) {
  return isHardUserSelfieAsk(text);
}

function detectUserDeferredMediaRequest(text) {
  try {
    return require('./process-time-helper').userWantsDeferredMedia(text);
  } catch {
    return false;
  }
}

function triggerCharacterIncomingCall(char, settings, wantCall, opening) {
  if (wantCall !== 'voice' && wantCall !== 'video') return null;
  if (!char?.id) return null;
  try {
    return require('./proactive-outreach-helper').startIncomingFromCharacter(db, char, settings, {
      opening: String(opening || '').trim(),
      video: wantCall === 'video',
    });
  } catch (e) {
    console.warn('[call] character incoming', e.message);
    return null;
  }
}

/**
 * 聊天里写 [打电话] 时，微信气泡是铺垫，接通后不能再念那句。
 * 另生成一句「刚接通对着听筒」的开场，供响铃前预合成 TTS。
 */
async function generateChatIncomingOpening(char, settings, { video = false, chatPreamble = '' } = {}) {
  const preamble = String(chatPreamble || '')
    .replace(/[\[【［]\s*(?:打电话|视频电话|视频通话|来电)[^\]]*\]?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const textVideo = video && isCharCallVideoTextMode(char);
  let hint;
  if (textVideo) {
    hint = `你刚在微信跟用户说完话，现在文字视频电话已经打通了。写「刚接通」时你这边镜头里的一小段画面：先一两句旁白（你所处的环境/光线/你对着屏幕的动作表情），再跟一句开口的话，台词必须放在「」里。短、口语，可先喂一声。不要重复微信铺垫（尤其不要再说「我打给你」「方便吗」）。不要播音腔、不要自我介绍、不要心理独白。只输出这段画面正文。禁止写「环境：」「音效：」或任何音效指令行。`;
  } else if (video) {
    hint = `你刚在微信跟用户说完话，现在视频电话已经打通了。写一句刚接通时对着摄像头说的开场：短、口语，可先喂一声，自然想看看对方。不要重复微信里的铺垫（尤其不要再说「我打给你」「方便吗」「打个电话吧」这类）。不要播音腔、不要自我介绍。只输出正文。禁止写「环境：」「音效：」或任何音效指令行。`;
  } else {
    hint = `你刚在微信跟用户说完话，现在语音电话已经打通了。写一句刚接通时对着听筒说的开场：短、口语，可先喂一声再接话。不要重复微信里的铺垫（尤其不要再说「我打给你」「方便吗」「打个电话吧」这类）。不要播音腔、不要自我介绍。只输出正文。禁止写「环境：」「音效：」或任何音效指令行。`;
  }
  const context = preamble
    ? `${hint}\n（微信里你刚说了大意：「${preamble}」——接通后换电话口吻，不要照念。）`
    : hint;
  try {
    const chatSettings = withCharChatPrefs(settings, char);
    // 开场只要电话口吻，不要注入「通话现场声」教写环境：——否则首句会夹英文提示词导致 TTS 失败
    const systemPrompt = buildSystemPrompt(char, chatSettings, context, {
      forVoiceCall: true,
      forVideoCall: !!video,
      forVideoCallText: !!textVideo,
      skipCallSceneAudio: true,
    });
    const content = await callChatAPI(chatSettings, systemPrompt, '', 'chat');
    let open = '';
    try {
      open = require('./emoji-helper').scrubUserVisibleText(content, char?.mindset);
    } catch {
      open = String(content || '');
    }
    try {
      open = require('./sound-fx-helper').stripSoundFxDirective(open);
    } catch { /* ignore */ }
    if (textVideo) {
      open = String(open || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 420);
      // 漏引号时包一层，方便前端 TTS 抽台词
      if (open && !/[「」""]/.test(open)) {
        const spoken = open.split(/[。！？\n]/).map((s) => s.trim()).filter(Boolean).pop() || open;
        if (spoken.length <= 40) open = `${open.replace(spoken, '').trim()}\n「${spoken}」`.trim();
      }
    } else {
      open = String(open || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    }
    // 若模型仍把微信铺垫原样吐回来，回退成极短接通语，避免接通念铺垫
    if (open && preamble && (open === preamble || preamble.includes(open) || open.includes(preamble.slice(0, 16)))) {
      open = textVideo
        ? '镜头里光线微微晃了一下，你看向屏幕，随口问道：「喂？看得到吗。」'
        : (video ? '喂？看得到吗。' : '喂？');
    }
    return open || (textVideo
      ? '你看向屏幕，顿了一下：「喂？」'
      : (video ? '喂？' : '喂？'));
  } catch (e) {
    console.warn('[call] generate opening', e.message);
    return textVideo
      ? '你看向屏幕，顿了一下：「喂？」'
      : (video ? '喂？' : '喂？');
  }
}

/** 角色写 [挂断]/[end_call] → resolvePeerEndCall：写 call_logs，push peer_end 给前端关通话页 */
function triggerCharacterPeerEndCall(char, { reason, isVoice, video } = {}) {
  if (!char?.id) return null;
  // 只在确实在通话中才允许主动挂
  if (!isVoice) {
    return { ok: false, skipped: 'not_in_call', note: '没在通话中，不需要挂。' };
  }
  try {
    return require('./proactive-outreach-helper').resolvePeerEndCall(db, {
      characterId: char.id,
      reason: String(reason || '').trim().slice(0, 160),
      video: !!video,
    });
  } catch (e) {
    console.warn('[call] character peer end', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 用户已经先挂了，但这轮请求还带着通话标记：不要再存成语音条。
 * 挂完回到微信的下一轮：也不要随机抽成语音条。
 */
function callReplySaveMode(characterId, isVoiceMode, isDreamMode) {
  if (isDreamMode) return { voiceCallMode: !!isVoiceMode, justLeftCall: false, callAlreadyOver: false };
  const phase = require('./emoji-helper').latestPersistedCallPhase(characterId);
  const callAlreadyOver = !!isVoiceMode && phase === 'end';
  const justLeftCall = callAlreadyOver || (!isVoiceMode && require('./emoji-helper').recentChatLeftCall(characterId));
  return {
    voiceCallMode: !!isVoiceMode && !callAlreadyOver,
    justLeftCall,
    callAlreadyOver,
  };
}

function isCallLineRow(msg) {
  try {
    const meta = JSON.parse(msg?.media_meta || '{}') || {};
    return Number(meta.callLine) === 1 || meta.callLine === true;
  } catch {
    return false;
  }
}

/** 用户这轮是要挂着电话（晚安/连麦/陪睡），不是要挂断 */
function userWantsKeepCallLine(userMessage) {
  let t = String(userMessage || '');
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      t = String(j?.transcript || '') || t;
    } catch { /* keep raw */ }
  }
  if (!t.trim()) return false;
  if (/挂了|挂电话|拜拜|先挂|挂掉|结束通话|不聊了.*挂|挂了吧/.test(t) && !/别挂|不要挂|先别挂|别挂断/.test(t)) {
    return false;
  }
  return /连麦|挂着(?:电话)?|别挂|不要挂|先别挂|陪我睡|一起睡|挂机陪|挂着陪|晚安|好梦|要睡了|去睡了|我先睡|准备睡|困了去睡/.test(t);
}

/** 通话语音条常无转写：看角色自己的挂断语境是否像「误把晚安当挂断」 */
function peerEndLooksLikeSleepGoodbye(rawText, processedText, reason) {
  const blob = `${rawText || ''}\n${processedText || ''}\n${reason || ''}`;
  if (/挂了|拜拜|先挂|挂电话|有事要走|要开会|去忙/.test(blob) && !/晚安|好梦|去睡|陪睡|连麦/.test(blob)) {
    return false;
  }
  return /晚安|好梦|去睡|睡吧|陪你睡|一起睡|连麦|挂着|做个好梦|早点休息/.test(blob);
}

function userVoiceLacksTranscript(userMessage) {
  const t = String(userMessage || '').trim();
  if (!t) return true;
  if (!t.startsWith('{')) return false;
  try {
    const j = JSON.parse(t);
    return !!(j && (j.voice || j.url) && !String(j.transcript || '').trim());
  } catch {
    return false;
  }
}

/** 从 raw/proc 文本里抽 [挂断]，如果角色确实在通话中就触发挂电话 */
function resolveAndTriggerPeerEndCall(char, { rawText, processedText, isVoice, isDream, video, userMessage } = {}) {
  if (isDream === true || isDream === 1 || isDream === '1') return null;
  if (!isVoice) return null;
  try {
    let endHit = require('./emoji-helper').extractEndCallDirective(rawText || '');
    if (!endHit.wantEnd && processedText) {
      endHit = require('./emoji-helper').extractEndCallDirective(processedText || '');
    }
    if (!endHit.wantEnd) return null;
    // 对方说晚安/连麦要挂着睡时，忽略角色误写的 [挂断]
    if (userWantsKeepCallLine(userMessage)) {
      console.log(`[call] skip peer_end char#${char.id}: user wants keep line`);
      return { ok: false, skipped: 'user_wants_keep_line' };
    }
    // 语音无转写：角色用「晚安」语境写挂断时，多半是误判，先拦住
    if (
      userVoiceLacksTranscript(userMessage)
      && peerEndLooksLikeSleepGoodbye(rawText, processedText, endHit.reason)
    ) {
      console.log(`[call] skip peer_end char#${char.id}: sleep goodbye on opaque voice`);
      return { ok: false, skipped: 'sleep_goodbye_opaque_voice' };
    }
    const result = triggerCharacterPeerEndCall(char, { reason: endHit.reason, isVoice, video });
    if (result?.ok && !result.already) {
      console.log(`[call] peer_end char#${char.id} dur=${result.duration || 0}s`);
    } else if (result && !result.ok) {
      console.warn(`[call] peer_end failed char#${char.id}`, result.error || result.skipped || result);
    }
    return result;
  } catch (e) {
    console.warn('[call] peer end resolve', e.message);
    return null;
  }
}

async function resolveAndTriggerIncomingCall(char, settings, {
  wantCall, rawText, processedText, userMessage, isDream, isVoice,
} = {}) {
  if (isDream || isVoice) return null;
  const resolved = resolveChatIncomingCall({
    tagged: wantCall,
    rawText,
    processedText,
    userMessage,
  });
  if (!resolved) return null;
  // 微信气泡是铺垫；接通开场另生成，绝不能把「方便吗/我打给你」再念一遍
  const opening = await generateChatIncomingOpening(char, settings, {
    video: resolved === 'video',
    chatPreamble: processedText || rawText || '',
  });
  const incoming = triggerCharacterIncomingCall(char, settings, resolved, opening);
  if (incoming) {
    console.log(`[call] incoming char#${char.id} via ${incoming.source || 'chat'} kind=${resolved}`);
  }
  return incoming;
}

function appendMediaRequestHints(extraSystemPrompt, history, currentContent) {
  let extra = extraSystemPrompt || '';
  const deferred = detectUserDeferredMediaRequest(currentContent)
    || (history || []).slice(-4).some((m) => m.role === 'user' && detectUserDeferredMediaRequest(m.content));
  if (deferred) {
    const hint = '[用户要你「到家/之后再」发图或视频：本轮只能答应或说在路上，禁止写「配图：」「自拍：」「配视频：」，禁止假装已发出。到了/到家后再另发。]';
    extra = extra ? `${extra}\n${hint}` : hint;
    return extra;
  }
  const imgReq = detectUserImageRequest(currentContent);
  const vidReq = detectUserVideoRequest(currentContent);
  const sfxReq = detectUserSfxRequest(currentContent);
  if (imgReq) {
    const selfieReq = detectUserSelfieRequest(currentContent);
    const drawMode = detectDrawingMediaIntent({ userMessage: currentContent });
    let hint;
    if (drawMode === 'doodle') {
      hint = '[用户要你画简笔画/你画我猜。若你决定画：正文可说「画好了」，末尾另起一行写「配图：simple doodle of 英文主题」（故意画得简单糊一点方便猜）。禁止写成手机实拍风景或自拍。不画则写「配图：无」。]';
    } else if (drawMode === 'illustration') {
      hint = '[用户要你画画/插画。若你决定画：正文可说「画好了」，末尾另起一行写「配图：illustration of 英文画面」（插画/手绘，可画角色、动物、场景）。禁止写成手机实拍风景照片，也不要用「自拍：」顶替。不画则写「配图：无」。]';
    } else {
      hint = selfieReq
        ? '[用户要看你本人/自拍。若你决定发：正文可自然说「拍好了」，末尾必须另起一行写「自拍：英文场景描述」（地点+穿着+拍法+表情）。禁止只说发了却不写指令；禁止用「配图：」发风景/静物顶替本人出镜。本轮不发则写「自拍：无」。]'
        : '[用户明确要求你发图/照片。若发风景/静物/宠物/食物：正文可说「拍好了」，末尾另起一行写「配图：英文画面描述」（禁止写人物/人像）。若是你本人出镜：必须写「自拍：…」，不要用「配图：」顶替。禁止只说「发你了」「发过去了」「赶紧看」却不写指令行。不发则写「配图：无」或「自拍：无」。]';
    }
    extra = extra ? `${extra}\n${hint}` : hint;
  }
  if (vidReq) {
    const hint = '[用户明确要求你发视频。若你决定发视频：正文可自然说「录好了」「发你了」，末尾写「配视频：英文画面描述」（如 ocean waves at sunset），系统会 AI 生视频。若本轮不发，写「配视频：无」。]';
    extra = extra ? `${extra}\n${hint}` : hint;
  }
  if (sfxReq) {
    const hint = '[用户想听环境声（海风/水/雨/白噪音等）。若你决定发：正文可自然说「你听」之类，末尾另起一行写「音效：英文声音描述|秒数」。海风例：「音效：ocean wind and waves on rocks at night|8」；白噪音例：「音效：soft looping white noise, gentle air hiss, no voices|12」。不要假装已发出录音。]';
    extra = extra ? `${extra}\n${hint}` : hint;
  }
  return extra;
}

function detectUserVideoRequest(text) {
  const t = String(text || '');
  if (/不要.{0,6}视频|别.{0,4}发.{0,4}视频|不发视频|无视频/.test(t)) return false;
  try {
    if (require('./process-time-helper').userWantsDeferredMedia(t) && /视频|小视频|vlog/i.test(t)) return false;
  } catch {}
  return /发(个|段|一个|些)?视频|发个视频|来(段|个)?视频|整(段|个)视频|能不能发.{0,8}视频|想(看|要).{0,8}视频|给(我|你)?看.{0,16}视频|\[发视频\]|\[视频\]/i.test(t)
    || /(?:^|[，。！？\s])小视频(?:[，。！？\s]|$)/.test(t)
    || /\bvlog\b/i.test(t)
    || /拍(了|段).{0,8}视频/.test(t);
}

function getUserVideoRequestText(history, currentContent) {
  if (detectUserVideoRequest(currentContent)) return String(currentContent || '').trim();
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user' && detectUserVideoRequest(m.content)) {
      return String(m.content || '').trim();
    }
  }
  return '';
}

function getUserImageRequestText(history, currentContent) {
  if (detectUserImageRequest(currentContent)) return String(currentContent || '').trim();
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user' && detectUserImageRequest(m.content)) {
      return String(m.content || '').trim();
    }
  }
  return String(currentContent || '').trim();
}

function getChatContextLimit(char, settings) {
  return memoryBrain.getChatContextRounds(char, settings);
}

function loadRecentChatHistory(characterId, isDream, char, settings, extraRoundsCap) {
  const rounds = memoryBrain.getChatContextRounds(char, settings);
  const n = extraRoundsCap != null ? Math.min(rounds, extraRoundsCap) : rounds;
  return memoryBrain.loadChatContextHistory(characterId, isDream, n);
}

function normalizeReplyToId(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  const s = String(raw);
  const m = s.match(/(?:^hist_|_)(\d+)(?:_|$)/) || s.match(/^(\d+)$/);
  const id = m ? Number(m[1]) : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** 告诉模型：用户引用的是角色自己的话，还是用户自己的话 */
function buildQuotedReplyPrompt(characterId, history, hint = {}) {
  const lastUser = [...(history || [])].reverse().find((m) => m.role === 'user' && m.type !== 'system');
  let replyToId = normalizeReplyToId(hint.replyToId || lastUser?.reply_to_id);
  let preview = String(hint.replyPreview || lastUser?.reply_preview || '').replace(/\s+/g, ' ').trim();
  if (lastUser?.id && !replyToId && !preview) {
    try {
      const row = db.prepare('SELECT reply_to_id, reply_preview FROM messages WHERE id=?').get(lastUser.id);
      if (row) {
        replyToId = normalizeReplyToId(row.reply_to_id);
        preview = String(row.reply_preview || '').replace(/\s+/g, ' ').trim();
      }
    } catch { /* ignore */ }
  }
  let quotedRole = '';
  if (replyToId) {
    try {
      const quoted = db.prepare(
        'SELECT role, content, type FROM messages WHERE id=? AND character_id=?'
      ).get(replyToId, characterId);
      if (quoted) {
        quotedRole = quoted.role;
        if (!preview) preview = String(quoted.content || '').replace(/\s+/g, ' ').trim();
      }
    } catch { /* ignore */ }
  }
  if (!preview) return '';
  const clip = preview.slice(0, 60);
  if (quotedRole === 'assistant') {
    return `[用户这条消息引用的是你说过的话：「${clip}」。那是你自己的原话，按被点到的那句接，不要当成对方说的。]`;
  }
  if (quotedRole === 'user') {
    return `[用户这条消息引用的是TA自己说过的话：「${clip}」。那是对方自己的原话，不是你说的。]`;
  }
  return `[用户这条消息是在回复：「${clip}」]`;
}

function resolveChatSession(history, isDream, userText) {
  const rows = history || [];
  return {
    liveHistory: rows,
    sessionClosed: false,
    contextText: buildChatContextText(userText, rows),
  };
}

const PENDING_SELFIE_PREFIX = '__pending_selfie__';
const PENDING_VIDEO_PREFIX = '__pending_video__';
const FAILED_SELFIE_PREFIX = '__selfie_failed__';
const FAILED_VIDEO_PREFIX = '__video_failed__';

function encodePendingSelfie(aspect) {
  return `${PENDING_SELFIE_PREFIX}:${normalizeSelfieAspect(aspect)}`;
}

function isPendingSelfieContent(content) {
  return String(content || '').startsWith(PENDING_SELFIE_PREFIX);
}

function encodeFailedSelfie(aspect) {
  return `${FAILED_SELFIE_PREFIX}:${normalizeSelfieAspect(aspect)}`;
}

function isFailedSelfieContent(content) {
  return String(content || '').startsWith(FAILED_SELFIE_PREFIX);
}

function encodePendingVideo(aspect) {
  return `${PENDING_VIDEO_PREFIX}:${normalizeVideoAspect(aspect || '9:16')}`;
}

function isPendingVideoContent(content) {
  return String(content || '').startsWith(PENDING_VIDEO_PREFIX);
}

function encodeFailedVideo(aspect) {
  return `${FAILED_VIDEO_PREFIX}:${normalizeSelfieAspect(aspect || '9:16')}`;
}

function isFailedVideoContent(content) {
  return String(content || '').startsWith(FAILED_VIDEO_PREFIX);
}

function patchMediaMetaError(msgId, error) {
  if (!msgId) return;
  try {
    const row = db.prepare('SELECT media_meta FROM messages WHERE id=?').get(msgId);
    let meta = {};
    try { meta = JSON.parse(row?.media_meta || '{}') || {}; } catch { meta = {}; }
    meta.lastError = String(error || '').slice(0, 200);
    meta.failedAt = Date.now();
    db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), msgId);
  } catch {}
}

/**
 * 前置条件不满足（缺 API / 缺参考图）时也留一条失败气泡。
 * 以前只塞 imageAttachNote 走 toast，用户看到的就是「角色说发了但什么都没有」。
 */
function insertBlockedMediaBubble({ characterId, isDream = 0, aspect, kind, error, type = 'image' }) {
  const isVideo = type === 'video';
  const content = isVideo ? encodeFailedVideo(aspect) : encodeFailedSelfie(aspect);
  let id = null;
  try {
    id = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
    ).run(characterId, 'assistant', content, type, isDream ? 1 : 0).lastInsertRowid;
    db.prepare(`UPDATE messages SET media_meta=? WHERE id=?`).run(JSON.stringify({
      kind: kind || (isVideo ? 'chat_video' : 'selfie'),
      aspect,
      lastError: String(error || '').slice(0, 200),
      failedAt: Date.now(),
      blocked: true,
    }), id);
  } catch (e) {
    console.warn('[chat media] 失败气泡插入失败:', e.message);
    return null;
  }
  return { id, content };
}

/** 后台填充占位自拍：同 id 消息 content 从 pending 换成真实图 */
async function deliverAsyncSelfie(job) {
  if (!job) return;
  const {
    characterId, settings, reqBase, selfiePrompt, imageRefs, hasRef, charName,
    placeholderMsgId, aspect,
  } = job;
  const aspectNorm = normalizeSelfieAspect(aspect);
  // nsfw 必须显式传下去：只靠 prompt 文本撞关键词的话，聊天模型写的含蓄描述永远判不出 NSFW
  const nsfw = !!job.nsfw;
  let selfieImgUrl = null;
  try {
    if (hasRef) {
      const refUrls = imageRefs.map(r => toAbsoluteMediaUrl(r, reqBase));
      const useImg2Img = !!resolveImg2ImgConfig(settings);
      selfieImgUrl = await generateImage(settings, selfiePrompt, refUrls[0], {
        referenceImages: refUrls,
        requireReference: useImg2Img || refUrls.length > 0,
        aspect: aspectNorm,
        publicBase: reqBase,
        nsfw,
        sceneQuery: job.sceneQuery || '',
      });
      // 禁止把形象参考图当「生成结果」发出去（以前失败时会误发原图）
      if (selfieImgUrl && imageRefs.some(r => {
        const a = String(selfieImgUrl).split('?')[0];
        const b = String(r).split('?')[0];
        return a && b && (a === b || a.endsWith(b) || b.endsWith(a));
      })) {
        console.warn('[selfie async] 拒绝使用参考图原图作为结果');
        selfieImgUrl = null;
      }
    } else {
      selfieImgUrl = await generateImage(settings, selfiePrompt, null, {
        aspect: aspectNorm,
        publicBase: reqBase,
        nsfw,
        sceneQuery: job.sceneQuery || '',
      });
    }
  } catch (e) {
    console.error('[selfie async] error:', e.message);
    selfieImgUrl = null;
  }

  if (!selfieImgUrl) {
    const err = (getLastGenerateImageError() || '生图失败').slice(0, 160);
    console.warn('[selfie async] 失败:', err);
    notifyBillingError('图像 API', err, { characterId });
    if (placeholderMsgId) {
      const failedContent = encodeFailedSelfie(aspectNorm);
      try {
        db.prepare(`UPDATE messages SET content=?, type='image' WHERE id=?`).run(failedContent, placeholderMsgId);
        patchMediaMetaError(placeholderMsgId, err);
      } catch {}
      push('message_update', {
        characterId,
        id: placeholderMsgId,
        type: 'image',
        content: failedContent,
        selfieFailed: true,
        charName: charName || '',
        error: err.slice(0, 120),
      });
    }
    return;
  }

  selfieImgUrl = normalizeChatImageUrl(selfieImgUrl);
  if (typeof selfieImgUrl === 'string' && selfieImgUrl.startsWith('data:')) {
    selfieImgUrl = persistGeneratedImageUrl(selfieImgUrl);
  }
  try {
    const localized = await localizeMediaToUploads(selfieImgUrl, 'image');
    if (localized) selfieImgUrl = localized;
  } catch (e) {
    console.warn('[selfie async] localize', e.message);
  }
  queueAlbumSave({
    characterId,
    url: selfieImgUrl,
    mediaType: 'image',
    subject: 'self',
    description: String(job.sceneQuery || '').trim().slice(0, 40),
  });

  if (placeholderMsgId) {
    db.prepare(`UPDATE messages SET content=?, type='image' WHERE id=?`).run(selfieImgUrl, placeholderMsgId);
    console.log('[selfie async] 占位已替换 id=', placeholderMsgId, 'url=', String(selfieImgUrl).slice(0, 80));
    push('message_update', {
      characterId,
      id: placeholderMsgId,
      type: 'image',
      content: selfieImgUrl,
      selfieReady: true,
      aspect: aspectNorm,
    });
    return;
  }

  const selfieImgId = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
  ).run(characterId, 'assistant', selfieImgUrl, 'image', 0).lastInsertRowid;
  broadcastChatMessage(characterId, '', [{ id: selfieImgId, type: 'image', content: selfieImgUrl }], false);
}

function scheduleSelfieDelivery(job) {
  if (!job) return;
  setImmediate(() => {
    deliverAsyncSelfie(job).catch(e => console.error('[selfie async] unhandled:', e.message));
  });
}

/** 后台填充占位视频：同 id 消息从 pending 换成真实视频（图生视频可能需数分钟） */
async function deliverAsyncVideo(job) {
  if (!job) return;
  const {
    characterId, settings, reqBase, char, contentForSearch, videoPresetQuery,
    placeholderMsgId, charName,
  } = job;
  let generalVideoUrl = null;
  try {
    generalVideoUrl = await generateChatContextVideo(
      settings,
      char,
      contentForSearch,
      typeof videoPresetQuery === 'string' ? videoPresetQuery : null,
      { publicBase: reqBase, aspect: job.aspect, nsfw: !!job.nsfw }
    );
  } catch (e) {
    console.error('[video async] error:', e.message);
  }

  if (!generalVideoUrl) {
    const err = (getLastGenerateVideoError() || '视频生成失败').slice(0, 160);
    console.warn('[video async] 失败:', err);
    notifyBillingError('视频 API', err, { characterId });
    if (placeholderMsgId) {
      const aspect = normalizeSelfieAspect(job.aspect || '9:16');
      const failedContent = encodeFailedVideo(aspect);
      try {
        db.prepare(`UPDATE messages SET content=?, type='video' WHERE id=?`).run(failedContent, placeholderMsgId);
        patchMediaMetaError(placeholderMsgId, err);
      } catch {}
      push('message_update', {
        characterId,
        id: placeholderMsgId,
        type: 'video',
        content: failedContent,
        videoFailed: true,
        charName: charName || '',
        error: err.slice(0, 120),
      });
    }
    return;
  }

  try {
    const localized = await localizeMediaToUploads(generalVideoUrl, 'video');
    if (localized) generalVideoUrl = localized;
  } catch (e) {
    console.warn('[video async] localize', e.message);
  }
  queueAlbumSave({
    characterId,
    url: generalVideoUrl,
    mediaType: 'video',
    subject: 'self',
    description: String(videoPresetQuery || '').trim().slice(0, 40),
  });

  if (placeholderMsgId) {
    db.prepare(`UPDATE messages SET content=?, type='video' WHERE id=?`).run(generalVideoUrl, placeholderMsgId);
    console.log('[video async] 占位已替换 id=', placeholderMsgId, 'url=', String(generalVideoUrl).slice(0, 80));
    push('message_update', {
      characterId,
      id: placeholderMsgId,
      type: 'video',
      content: generalVideoUrl,
      videoReady: true,
    });
    return;
  }

  const generalVideoId = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
  ).run(characterId, 'assistant', generalVideoUrl, 'video', 0).lastInsertRowid;
  broadcastChatMessage(characterId, '', [{ id: generalVideoId, type: 'video', content: generalVideoUrl }], false);
}

function scheduleVideoDelivery(job) {
  if (!job) return;
  setImmediate(() => {
    deliverAsyncVideo(job).catch(e => console.error('[video async] unhandled:', e.message));
  });
}

/** 后台填充普通配图占位（与自拍共用 pending 前缀） */
async function deliverAsyncChatImage(job) {
  if (!job) return;
  const {
    characterId, settings, char, contentForImage, presetQuery,
    placeholderMsgId, aspect, charName,
  } = job;
  const aspectNorm = normalizeSelfieAspect(aspect || '3:4');
  let generalImgUrl = null;
  try {
    generalImgUrl = await generateChatContextImage(
      settings,
      char,
      contentForImage,
      presetQuery,
      {
        aspect: aspectNorm,
        nsfw: !!job.nsfw,
        drawMode: job.drawMode || null,
        userMessage: job.userMessage || '',
      }
    );
  } catch (e) {
    console.error('[chat image async] error:', e.message);
    generalImgUrl = null;
  }

  if (!generalImgUrl) {
    const err = (getLastGenerateImageError() || '配图生图失败').slice(0, 160);
    console.warn('[chat image async] 失败:', err);
    notifyBillingError('图像 API', err, { characterId });
    if (placeholderMsgId) {
      const failedContent = encodeFailedSelfie(aspectNorm);
      try {
        db.prepare(`UPDATE messages SET content=?, type='image' WHERE id=?`).run(failedContent, placeholderMsgId);
        patchMediaMetaError(placeholderMsgId, err);
      } catch {}
      push('message_update', {
        characterId,
        id: placeholderMsgId,
        type: 'image',
        content: failedContent,
        selfieFailed: true,
        charName: charName || '',
        error: err.slice(0, 120),
      });
    }
    return;
  }

  generalImgUrl = normalizeChatImageUrl(generalImgUrl);
  if (typeof generalImgUrl === 'string' && generalImgUrl.startsWith('data:')) {
    generalImgUrl = persistGeneratedImageUrl(generalImgUrl);
  }
  try {
    const localized = await localizeMediaToUploads(generalImgUrl, 'image');
    if (localized) generalImgUrl = localized;
  } catch (e) {
    console.warn('[chat image async] localize', e.message);
  }
  queueAlbumSave({
    characterId,
    url: generalImgUrl,
    mediaType: 'image',
    subject: 'other',
    description: String(presetQuery || '').trim().slice(0, 40),
  });

  if (placeholderMsgId) {
    db.prepare(`UPDATE messages SET content=?, type='image' WHERE id=?`).run(generalImgUrl, placeholderMsgId);
    console.log('[chat image async] 占位已替换 id=', placeholderMsgId, 'url=', String(generalImgUrl).slice(0, 80));
    push('message_update', {
      characterId,
      id: placeholderMsgId,
      type: 'image',
      content: generalImgUrl,
      selfieReady: true,
      aspect: aspectNorm,
    });
  }
}

function scheduleChatImageDelivery(job) {
  if (!job) return;
  setImmediate(() => {
    deliverAsyncChatImage(job).catch(e => console.error('[chat image async] unhandled:', e.message));
  });
}

async function attachReplyImages({ characterId, char, settings, rawText, cleanText, reqBase, isDreamMode, imageQuery: imageQueryOverride, videoQuery: videoQueryOverride, userImageRequest = false, userVideoRequest = false, userMessage = '' }) {
  let selfieImgId = null;
  let selfieImgUrl = null;
  let generalImgId = null;
  let generalImgUrl = null;
  let generalVideoId = null;
  let generalVideoUrl = null;
  let imageAttachNote = '';
  let selfiePending = false;
  let pendingSelfieJob = null;
  let videoPending = false;
  let pendingVideoJob = null;
  let imagePending = false;
  let pendingImageJob = null;
  let selfieAspect = '';
  let generalImageAspect = '';
  let videoAspect = '';
  // 前置条件不满足而只留了失败气泡：不能当成「已发出媒体」去清 todo / 清延后发图
  let mediaBlocked = false;
  if (isDreamMode) {
    return {
      selfieImgId, selfieImgUrl, generalImgId, generalImgUrl, generalVideoId, generalVideoUrl,
      imageAttachNote, selfiePending, pendingSelfieJob, videoPending, pendingVideoJob,
      imagePending, pendingImageJob, selfieAspect, generalImageAspect, videoAspect,
    };
  }

  const intent = matchImageIntent(rawText, cleanText);
  let presetQuery = imageQueryOverride !== undefined ? imageQueryOverride : intent.presetQuery;
  let videoPresetQuery = videoQueryOverride !== undefined ? videoQueryOverride : intent.videoQuery;
  const hasExplicitSelfie = intent.hasExplicitSelfie;
  // 用户说「到家再发」且尚未到期：本轮禁止强制配图，也不认模型偷写的指令行
  let deferredMedia = false;
  try {
    const travel = require('./process-time-helper');
    const pending = travel.getPending?.(characterId);
    const tooEarly = pending && Date.now() < Number(pending.dueAt || 0)
      && (pending.needImage || pending.needVideo);
    deferredMedia = !!tooEarly || travel.userWantsDeferredMedia(userMessage);
  } catch {}
  if (deferredMedia) {
    return {
      selfieImgId, selfieImgUrl, generalImgId, generalImgUrl, generalVideoId, generalVideoUrl,
      imageAttachNote, selfiePending, pendingSelfieJob, videoPending, pendingVideoJob,
      imagePending, pendingImageJob, selfieAspect, generalImageAspect, videoAspect,
    };
  }
  if (userImageRequest && !hasExplicitSelfie && presetQuery === null) {
    presetQuery = undefined;
  }
  if (userVideoRequest && videoPresetQuery === null) {
    videoPresetQuery = undefined;
  }
  // 本轮媒体是否偏 NSFW（肉文 prompt / 构图用）：看用户原话 + 角色正文 + 最近几轮，
  // 不能只看模型写的英文画面词——那几乎永远是穿戴整齐的
  let recentForNsfw = [];
  try {
    recentForNsfw = db.prepare(
      `SELECT content FROM messages WHERE character_id=? AND type='text' ORDER BY id DESC LIMIT 6`
    ).all(characterId);
  } catch {}
  const resolveMediaNsfw = (sceneQuery = '') => inferChatMediaNsfwContext({
    userMessage,
    sceneQuery,
    replyText: intent.combined,
    recentHistory: recentForNsfw,
    char,
  });

  const claimedSent = replyClaimsSentShareMedia(intent.combined);
  // 正文已声称发出，却写了「配图：无」——当成漏写指令，不要当成真的不发
  if (claimedSent && presetQuery === null) {
    presetQuery = undefined;
    console.log('[chat image] 忽略「配图：无」：正文已声称发出');
  }
  if (claimedSent && videoPresetQuery === null && /视频|vlog/.test(intent.combined)) {
    videoPresetQuery = undefined;
  }
  let wantsGeneral = shouldAttachContextImage(intent.combined, presetQuery, { hasExplicitSelfie, forChat: true });
  const userWantsSelfie = detectUserSelfieRequest(userMessage);
  const refusedShare = replyRefusesShareMedia(intent.combined);
  // 用户硬要自拍但模型没写指令：走自拍占位，不要用风景配图顶替
  let forceSelfie = false;
  if (!hasExplicitSelfie && userWantsSelfie && !refusedShare && !replyAsksUserForImage(intent.combined)
    && (replySuggestsShareImage(intent.combined)
      || replyClaimsSentShareMedia(intent.combined)
      || /拍好了|发你了|发给你了|自拍/.test(intent.combined)
      // 硬请求：对方答应/接话即可补图，不必非要写「拍好了」
      || userImageRequest)) {
    forceSelfie = true;
  }
  // 用户硬要风景/静物图：有主题就配图；没主题且非自拍请求时也走自拍，避免空手
  // 画画/插画：绝不能默认成自拍或实拍风景
  const drawAsk = detectDrawingMediaIntent({ userMessage });
  if (!wantsGeneral && userImageRequest && !hasExplicitSelfie && !forceSelfie
    && !refusedShare && !replyAsksUserForImage(intent.combined)) {
    if (presetQuery === undefined) {
      if (drawAsk) {
        const rawSub = extractImageQueryFromText(userMessage)
          || extractImageQueryFromText(intent.combined)
          || String(userMessage || '').replace(/^(?:帮我|给我|替我|来|再)?画(?:张|个|一幅|一副)?(?:图|画|插画|素描)?/g, '').trim().slice(0, 80);
        const sub = rawSub || (drawAsk === 'doodle' ? 'a simple everyday object' : 'a charming scene');
        presetQuery = drawAsk === 'doodle'
          ? `simple doodle of ${sub}`
          : `illustration of ${sub}`;
        wantsGeneral = true;
        console.log('[chat image] 画画硬请求补配图', drawAsk, String(presetQuery).slice(0, 80));
      } else {
        const q = extractImageQueryFromText(userMessage)
          || extractImageQueryFromText(intent.combined);
        if (q) {
          presetQuery = q;
          wantsGeneral = true;
        } else if (!userWantsSelfie) {
          // 「发张图」未指明主题 → 默认自拍，比空风景更合理
          forceSelfie = true;
        }
      }
    }
  }
  let effectiveHasExplicitSelfie = hasExplicitSelfie || forceSelfie;
  if (forceSelfie) wantsGeneral = false;
  let wantsVideo = shouldAttachContextVideo(intent.combined, videoPresetQuery, { forChat: true });
  if (!wantsVideo && userVideoRequest && !replyAsksUserForVideo(intent.combined)) {
    if (videoPresetQuery === undefined) {
      const q = extractImageQueryFromText(userMessage);
      if (q) {
        videoPresetQuery = q;
        wantsVideo = true;
      }
    }
  }
  // 嘴上说「发过去了/赶紧看/看完评价」但没写指令：按内容补发，默认自拍
  const claimedFill = resolveClaimedMissingShare({
    combined: intent.combined,
    userMessage,
    hasExplicitSelfie: effectiveHasExplicitSelfie,
    wantsGeneral,
    wantsVideo,
    userWantsSelfie,
    userImageRequest,
  });
  if (claimedFill?.kind === 'selfie') {
    forceSelfie = true;
    effectiveHasExplicitSelfie = true;
    wantsGeneral = false;
    if (claimedFill.sceneQuery && !(typeof intent.selfieScene === 'string' && intent.selfieScene.trim())) {
      intent.selfieScene = claimedFill.sceneQuery;
    }
    console.log('[chat image] 正文声称已发出但无指令行，补发自拍', String(claimedFill.sceneQuery || '').slice(0, 80));
  } else if (claimedFill?.kind === 'image') {
    presetQuery = claimedFill.query;
    wantsGeneral = true;
    console.log('[chat image] 正文声称已发出但无指令行，补发配图', String(presetQuery || '').slice(0, 80));
  } else if (claimedFill?.kind === 'video') {
    if (typeof claimedFill.query === 'string' && claimedFill.query.trim()) {
      videoPresetQuery = claimedFill.query;
    } else if (videoPresetQuery == null) {
      videoPresetQuery = 'handheld phone video';
    }
    wantsVideo = true;
    console.log('[chat image] 正文声称已发出但无指令行，补发视频');
  }
  const isDream = isDreamMode ? 1 : 0;

  // 自拍：当轮插入占位气泡（···），后台生图完成后替换同一条消息
  if (effectiveHasExplicitSelfie && settings.selfie_api_enabled !== '0') {
    const refGroups = normalizeImageRefGroups(char.image_ref || '[]');
    const imageStyle = char.image_style || 'anime';
    const aspect = normalizeSelfieAspect(char.image_aspect || '3:4');
    const sceneQuery = (typeof intent.selfieScene === 'string' && intent.selfieScene.trim())
      ? intent.selfieScene.trim()
      : '';
    const homeUrls = selectHomeReferenceUrls(char, sceneQuery, 2);
    const selfieNsfw = resolveMediaNsfw(sceneQuery);
    let outfitOverride = null;
    try {
      outfitOverride = require('./wardrobe-helper').detectExplicitOutfitOverride({
        userMessage,
        sceneQuery,
      });
    } catch {}
    let clothingUrls = [];
    // NSFW 时不要把衣柜单品实拍图塞进参考图，否则图生图会照着把衣服画回来
    if (!outfitOverride?.skipDaily && !selfieNsfw) {
      try {
        const { collectOutfitClothingRefUrls } = require('./wardrobe-helper');
        const d = new Date();
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        clothingUrls = collectOutfitClothingRefUrls(characterId, dateStr);
      } catch {}
    } else if (outfitOverride?.skipDaily) {
      console.log('[chat image] 换装覆盖今日衣柜:', outfitOverride.phrase || '(按自拍场景)', 'skip clothing refs');
    } else {
      console.log('[chat image] NSFW 自拍：跳过今日衣柜穿搭与衣柜参考图');
    }
    const refFlags = resolveSelfieRefFlags(refGroups, sceneQuery);
    const imageRefs = [
      ...selectSelfieReferenceUrls(refGroups, sceneQuery),
      ...(refFlags.useSpecial ? [] : clothingUrls),
      ...(refFlags.useSpecial ? [] : homeUrls),
    ].filter(Boolean).slice(0, 5);
    const hasRef = imageRefs.length > 0;
    const selfiePrompt = buildSelfieGenerationPrompt({
      imageStyle,
      charName: char.name,
      sceneQuery,
      hasRef,
      hasBodyRef: refFlags.hasBodyRef,
      hasFullBodyRef: refFlags.hasFullBodyRef,
      hasHandRef: refFlags.hasHandRef,
      hasSpecialRef: refFlags.hasSpecialRef,
      specialLabel: refFlags.specialLabel,
      stylePrompt: char.selfie_style_prompt || '',
      aspect,
      char,
      hasHomeRef: !refFlags.useSpecial && homeUrls.length > 0,
      outfitOverride,
      userMessage,
      nsfw: selfieNsfw,
    });
    if (sceneQuery) {
      console.log('[chat image] 自拍占位+异步，场景:', sceneQuery.slice(0, 120), '比例:', aspect, 'refs=', imageRefs.length, 'homeRefs=', homeUrls.length, 'nsfw=', selfieNsfw);
    } else if (resolveCharacterHomeEnvironment(char)) {
      console.log('[chat image] 自拍未写「自拍：」行，将用角色居住环境作默认场景');
    } else {
      console.warn('[chat image] 自拍未写「自拍：场景」行，将仅按画风+参考图生成');
    }

    const hasImg2 = !!resolveImg2ImgConfig(settings);
    const hasTxt = !!(settings.image_api_url || '').trim() && !!(settings.image_api_key || '').trim();
    let blockReason = '';
    if (!hasRef && !hasTxt) {
      blockReason = '自拍需要：角色上传形象参考图，并配置「图生图 API」';
    } else if (hasRef && !hasImg2 && !hasTxt) {
      blockReason = '自拍失败：请在设置里配置「图生图 API」';
    }
    if (blockReason) {
      imageAttachNote = blockReason;
      console.warn('[chat image] 自拍无法生成：', blockReason);
      const blocked = insertBlockedMediaBubble({
        characterId, isDream, aspect, kind: 'selfie', error: blockReason,
      });
      if (blocked) {
        selfieImgId = blocked.id;
        selfieImgUrl = blocked.content;
        selfieAspect = aspect;
        mediaBlocked = true;
      }
    } else {
      const pendingContent = encodePendingSelfie(aspect);
      selfieImgId = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
      ).run(characterId, 'assistant', pendingContent, 'image', isDream).lastInsertRowid;
      try {
        db.prepare(`UPDATE messages SET media_meta=? WHERE id=?`).run(JSON.stringify({
          kind: 'selfie',
          prompt: selfiePrompt,
          sceneQuery: sceneQuery || '',
          aspect,
          outfitOverride: outfitOverride || null,
          skipWardrobeClothingRefs: !!outfitOverride?.skipDaily || selfieNsfw,
          nsfw: selfieNsfw,
        }), selfieImgId);
      } catch (e) {
        console.warn('[chat image] media_meta save failed:', e.message);
      }
      selfieImgUrl = pendingContent;
      selfieAspect = aspect;
      selfiePending = true;
      pendingSelfieJob = {
        characterId,
        settings,
        reqBase,
        isDream,
        selfiePrompt,
        imageRefs,
        hasRef,
        charName: char.name || '',
        placeholderMsgId: selfieImgId,
        aspect,
        sceneQuery: sceneQuery || '',
        nsfw: selfieNsfw,
      };
      console.log('[chat image] 已插入自拍占位 id=', selfieImgId, 'hasImg2=', hasImg2, 'face/body/hands=',
        refGroups.face.length, refGroups.body.length, refGroups.hands.length);
    }
  }

  const contentForSearch = [
    typeof presetQuery === 'string' ? presetQuery : '',
    typeof videoPresetQuery === 'string' ? videoPresetQuery : '',
    userMessage,
    intent.parsed.content,
    intent.parsedRaw.content,
    cleanText,
    rawText,
  ].filter(Boolean).join('\n');

  // 分享短视频 → 占位气泡（···），后台图生视频/文生视频完成后替换（可能数分钟）
  if (wantsVideo) {
    const hasImg2Video = !!resolveImg2VideoConfig(settings);
    const hasImageApi = (settings.image_api_url || '').trim() && (settings.image_api_key || '').trim();
    const hasPexels = !!(settings.pexels_api_key || '').trim();
    const hasVideoApi = hasImg2Video || hasImageApi || hasPexels;
    videoAspect = normalizeVideoAspect(inferChatMediaAspect({
      kind: 'video',
      // 只用「配视频：」场景词，不要拿整段聊天正文（会把「城市/夜景」误判成横屏）
      query: typeof videoPresetQuery === 'string' ? videoPresetQuery : '',
      char,
    }));

    if (!hasVideoApi) {
      const note = '请先在「设置 → 图生视频」填写 HiAPI 等地址和 Key，并在角色编辑上传形象参考图';
      imageAttachNote = imageAttachNote ? `${imageAttachNote}；${note}` : note;
      console.warn('[chat video] 配视频无法生成：未配置图生视频/文生视频/Pexels');
      const blocked = insertBlockedMediaBubble({
        characterId, isDream, aspect: videoAspect, kind: 'chat_video', error: note, type: 'video',
      });
      if (blocked) {
        generalVideoId = blocked.id;
        generalVideoUrl = blocked.content;
        mediaBlocked = true;
      }
    } else {
      const pendingContent = encodePendingVideo(videoAspect);
      generalVideoId = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
      ).run(characterId, 'assistant', pendingContent, 'video', isDream).lastInsertRowid;
      try {
        db.prepare(`UPDATE messages SET media_meta=? WHERE id=?`).run(JSON.stringify({
          kind: 'chat_video',
          sceneQuery: typeof videoPresetQuery === 'string' ? videoPresetQuery : '',
          contentForSearch: String(contentForSearch || '').slice(0, 500),
          aspect: videoAspect,
          nsfw: resolveMediaNsfw(typeof videoPresetQuery === 'string' ? videoPresetQuery : ''),
        }), generalVideoId);
      } catch (e) {
        console.warn('[chat video] media_meta save failed:', e.message);
      }
      generalVideoUrl = pendingContent;
      videoPending = true;
      pendingVideoJob = {
        characterId,
        settings,
        reqBase,
        char,
        contentForSearch,
        videoPresetQuery: typeof videoPresetQuery === 'string' ? videoPresetQuery : null,
        placeholderMsgId: generalVideoId,
        charName: char.name || '',
        aspect: videoAspect,
        nsfw: resolveMediaNsfw(typeof videoPresetQuery === 'string' ? videoPresetQuery : ''),
      };
      console.log('[chat video] 已插入视频占位 id=', generalVideoId, 'aspect=', videoAspect);
    }
  }

  // 分享风景/美食/细节等 → 占位气泡，后台生图（勿同步等待，否则前端易 abort）
  if (wantsGeneral) {
    const contentForImage = [
      typeof presetQuery === 'string' ? presetQuery : '',
      userMessage,
      intent.parsed.content,
      intent.parsedRaw.content,
      cleanText,
      rawText,
    ].filter(Boolean).join('\n');
    const drawMode = detectDrawingMediaIntent({
      userMessage,
      query: typeof presetQuery === 'string' ? presetQuery : '',
      caption: contentForImage,
    });
    const imageAspect = drawMode
      ? '1:1'
      : inferChatMediaAspect({
        kind: 'image',
        query: typeof presetQuery === 'string' ? presetQuery : '',
        text: contentForImage,
        char,
      });
    generalImageAspect = imageAspect;
    const hasImageApi = (settings.image_api_url || '').trim() && (settings.image_api_key || '').trim();
    const hasImg2Img = !!resolveImg2ImgConfig(settings);
    const hasUnsplash = !!(settings.unsplash_api_key || '').trim();
    // 画画必须走生图 API，Unsplash 实拍兜底会变成风景图
    if (!hasImageApi && !hasImg2Img && !(hasUnsplash && !drawMode)) {
      const note = drawMode
        ? '画画/插画需要配置「设置 → 图像生成」或「图生图 API」'
        : '请先在「设置 → 图像生成」或「图生图 API」填写地址和 Key（或配置 Unsplash）';
      imageAttachNote = imageAttachNote ? `${imageAttachNote}；${note}` : note;
      console.warn('[chat image] 配图无法生成：', note);
      const blocked = insertBlockedMediaBubble({
        characterId, isDream, aspect: imageAspect, kind: 'chat_image', error: note,
      });
      if (blocked) {
        generalImgId = blocked.id;
        generalImgUrl = blocked.content;
        mediaBlocked = true;
      }
    } else {
      // 与自拍共用 pending 前缀，前端气泡样式一致；media_meta.kind 区分 chat_image
      const pendingContent = encodePendingSelfie(imageAspect);
      generalImgId = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
      ).run(characterId, 'assistant', pendingContent, 'image', isDream).lastInsertRowid;
      try {
        db.prepare(`UPDATE messages SET media_meta=? WHERE id=?`).run(JSON.stringify({
          kind: 'chat_image',
          presetQuery: typeof presetQuery === 'string' ? presetQuery : '',
          contentForImage: String(contentForImage || '').slice(0, 500),
          aspect: imageAspect,
          drawMode: drawMode || '',
          nsfw: resolveMediaNsfw(typeof presetQuery === 'string' ? presetQuery : ''),
        }), generalImgId);
      } catch (e) {
        console.warn('[chat image] media_meta save failed:', e.message);
      }
      generalImgUrl = pendingContent;
      imagePending = true;
      pendingImageJob = {
        characterId,
        settings,
        char,
        contentForImage,
        presetQuery: typeof presetQuery === 'string' ? presetQuery : null,
        placeholderMsgId: generalImgId,
        aspect: imageAspect,
        drawMode: drawMode || null,
        userMessage: String(userMessage || ''),
        charName: char.name || '',
        nsfw: resolveMediaNsfw(typeof presetQuery === 'string' ? presetQuery : ''),
      };
      console.log('[chat image] 已插入配图占位 id=', generalImgId, 'mode=', drawMode || 'photo', 'aspect=', imageAspect);
    }
  }

  return {
    selfieImgId, selfieImgUrl, generalImgId, generalImgUrl, generalVideoId, generalVideoUrl,
    imageAttachNote, selfiePending, pendingSelfieJob, videoPending, pendingVideoJob,
    imagePending, pendingImageJob,
    selfieAspect, generalImageAspect, videoAspect, mediaBlocked,
  };
}

// Use db module's prepare/run/get/all directly
const db = dbModule;

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

// APK 壳（Capacitor）从 https://localhost 跨域访问后端，需带凭证/自定义头
app.use(cors({
  origin: true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Nian-Session', 'X-Nian-Robot-Token', 'X-Tieba-Token'],
}));
try {
  app.use(require('compression')());
} catch (e) {
  // 压缩是锦上添花，缺这个包不该让整个后端起不来
  console.warn('[server] compression 模块未安装，跳过响应压缩（不影响功能）。可在 backend 目录运行: npm install compression');
}
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
const FRONTEND_PATH = path.join(__dirname, '..');
const BASE_PWA_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(FRONTEND_PATH, 'manifest.json'), 'utf8')
);

function resolvePwaIconUrl(iconUrl, req) {
  const raw = String(iconUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
  const base = `${req.protocol}://${req.get('host')}`;
  return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
}

function buildPwaManifest(req) {
  const customIcon = resolvePwaIconUrl(getSettings().pwa_icon, req);
  if (!customIcon) return { ...BASE_PWA_MANIFEST };
  const png = { type: 'image/png' };
  return {
    ...BASE_PWA_MANIFEST,
    icons: [
      { ...png, src: customIcon, sizes: '512x512', purpose: 'any' },
      { ...png, src: customIcon, sizes: '512x512', purpose: 'maskable' },
      { ...png, src: customIcon, sizes: '192x192', purpose: 'any' },
      { ...png, src: customIcon, sizes: '180x180', purpose: 'any' },
    ],
  };
}

app.get('/manifest.json', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('application/manifest+json');
  res.json(buildPwaManifest(req));
});

// 静态资源：JS/CSS/HTML 用 no-cache（每次刷新都会跟服务器校验，改了立刻生效，未改仍走 304）
// 图片/字体等少变资源才长缓存。以前 maxAge=1d 会导致「代码已更新但浏览器硬用旧文件」
app.use(express.static(FRONTEND_PATH, {
  etag: true,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (
      ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json'
      || filePath.endsWith(`${path.sep}sw.js`)
    ) {
      res.setHeader('Cache-Control', 'no-cache');
      return;
    }
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.woff', '.woff2'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Uploads
const UPLOADS_PATH = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_PATH)) fs.mkdirSync(UPLOADS_PATH, { recursive: true });
app.use('/uploads', express.static(UPLOADS_PATH, { maxAge: '7d' }));

const { resolveFfmpegBin } = require('./ffmpeg-bin');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_PATH),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
// 视频文件可能很大，对通用上传接口放开到 500MB，表情包等小文件维持 20MB
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
const uploadLarge = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });
const uploadAlbum = multer({ storage });

async function convertVoiceUploadForChat(inputPath, originalName) {
  const base = `${Date.now()}-${path.parse(originalName || 'voice').name}`;
  // Gemini / 多数中转对 16kHz 单声道 PCM WAV 兼容最好；浏览器也能直接播
  const wavName = `${base}.wav`;
  const wavPath = path.join(UPLOADS_PATH, wavName);
  const ffmpegBin = resolveFfmpegBin();
  try {
    await execFileAsync(ffmpegBin, [
      '-y', '-i', inputPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      wavPath,
    ], { timeout: 300000 });
    try { fs.unlinkSync(inputPath); } catch {}
    return wavName;
  } catch (e1) {
    console.warn('[chat-voice] ffmpeg 转 WAV 失败，尝试 MP3:', e1.message, 'bin=', ffmpegBin);
    const mp3Name = `${base}.mp3`;
    const mp3Path = path.join(UPLOADS_PATH, mp3Name);
    try {
      await execFileAsync(ffmpegBin, [
        '-y', '-i', inputPath,
        '-vn', '-acodec', 'libmp3lame', '-q:a', '2',
        '-ar', '16000', '-ac', '1',
        mp3Path,
      ], { timeout: 300000 });
      try { fs.unlinkSync(inputPath); } catch {}
      return mp3Name;
    } catch (e2) {
      console.warn('[chat-voice] ffmpeg 转码失败，保留原文件:', e2.message);
      return path.basename(inputPath);
    }
  }
}

/** @deprecated 相册等仍可能调用旧名 */
async function convertVoiceUploadToMp3(inputPath, originalName) {
  return convertVoiceUploadForChat(inputPath, originalName);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function scheduleDateStr(rawDate) {
  if (rawDate) return String(rawDate).slice(0, 10);
  const s = getSettings();
  return getLocalDateStr(new Date(), s.timezone || 'Asia/Shanghai');
}

function setSetting(key, value) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, String(value ?? ''));
}

function getPublicSettings() {
  const s = getSettings();
  delete s.vapid_private_key;
  // 声纹 / 面容 embedding 不对外；只暴露是否已录入
  const stored = voiceprintHelper.loadStoredVoiceprint(() => s);
  delete s[voiceprintHelper.VOICEPRINT_SETTING_KEY];
  delete s.user_voiceprint;
  s.voiceprint = voiceprintHelper.publicVoiceprintStatus(stored);
  const storedFace = faceprintHelper.loadStoredFaceprint(() => s);
  delete s[faceprintHelper.FACEPRINT_SETTING_KEY];
  delete s.user_faceprint;
  s.faceprint = {
    ...faceprintHelper.publicFaceprintStatus(storedFace),
    enrollNext: String(s.robot_faceprint_enroll_next || '0') === '1',
  };
  delete s.vps_archive_ack;
  delete s.vps_store_last_prune;
  // MCP 服务 token 不对外；管理走 /api/mcp/servers
  try {
    const mcp = require('./mcp-client-helper');
    const list = mcp.loadServers(() => s);
    if (list.length) {
      s.mcp_servers = JSON.stringify(list.map((x) => ({
        id: x.id,
        name: x.name,
        url: x.url,
        enabled: x.enabled !== false,
        hasToken: !!x.token,
      })));
    }
  } catch {}
  return s;
}

const BUSY_AUTO_REPLIES = ['在忙', '有事，晚点', '……忙', '回头说'];
const POKE_WAIT_HINTS = ['再等一会儿～', '快好了，别催啦', '知道了，忙完就来'];

/** 忙碌中：首条自动回复，后续静默排队，不重复刷「等等」也不调聊天 API */
function resolveBusyAutoReply(char, characterId, isDreamMode, settings) {
  if (isDreamMode || char.status !== 'busy' || char.busy_style === 'off') return null;
  if (Number(char.robot_operating) === 1) return null;
  const chatSettings = withCharChatPrefs(settings, char);
  if (chatSettings?.time_aware_enabled === '1') {
    const { minutes } = computeUserReturnGap(characterId, false);
    if (minutes >= 30) return null;
  }
  const lastAsst = db.prepare(
    `SELECT content FROM messages WHERE character_id=? AND role='assistant' AND is_dream=0 ORDER BY id DESC LIMIT 1`
  ).get(characterId);
  if (lastAsst?.content?.startsWith('【自动回复】')) return { silent: true };
  const autoReply = BUSY_AUTO_REPLIES[Math.floor(Math.random() * BUSY_AUTO_REPLIES.length)];
  return { autoReplyText: `【自动回复】${autoReply}` };
}

function resolveChatImageUrl(url, baseUrl) {
  const abs = toAbsoluteMediaUrl(url, baseUrl);
  const marker = '/uploads/';
  const idx = abs.indexOf(marker);
  if (idx >= 0) {
    const filename = decodeURIComponent(abs.slice(idx + marker.length).split('?')[0]);
    const localPath = path.join(UPLOADS_PATH, filename);
    if (fs.existsSync(localPath)) {
      try {
        const stat = fs.statSync(localPath);
        if (stat.size > 2.5 * 1024 * 1024) return abs;
      } catch {}
      const buf = fs.readFileSync(localPath);
      const ext = path.extname(filename).toLowerCase();
      const mime = { '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[ext] || 'image/jpeg';
      return `data:${mime};base64,${buf.toString('base64')}`;
    }
  }
  return abs;
}

/** 把本地语音做成多模态 part。Gemini 中转对 OpenAI input_audio 常听成杂音，改走 data URI。 */
function resolveChatAudioPart(url, { model = '' } = {}) {
  if (!url || typeof url !== 'string') return null;
  const marker = '/uploads/';
  const idx = url.indexOf(marker);
  const filename = decodeURIComponent(
    (idx >= 0 ? url.slice(idx + marker.length) : url.replace(/^.*\//, '')).split('?')[0]
  );
  if (!filename || filename.includes('..')) return null;
  const localPath = path.join(UPLOADS_PATH, filename);
  if (!fs.existsSync(localPath)) {
    console.warn('[chat-voice] missing file:', filename);
    return null;
  }
  try {
    const stat = fs.statSync(localPath);
    if (stat.size <= 0 || stat.size > 6 * 1024 * 1024) {
      console.warn('[chat-voice] bad size:', filename, stat.size);
      return null;
    }
    const buf = fs.readFileSync(localPath);
    const ext = path.extname(filename).toLowerCase();
    const mime = ({
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.mpeg': 'audio/mpeg',
      '.mpga': 'audio/mpeg',
      '.webm': 'audio/webm',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.mp4': 'audio/mp4',
      '.aac': 'audio/aac',
    })[ext];
    if (!mime) {
      console.warn('[chat-voice] unsupported audio ext:', ext, filename);
      return null;
    }
    const b64 = buf.toString('base64');
    // 国内中转（尤其 Gemini）对 OpenAI input_audio 常听成杂音；
    // data:audio/* 经 image_url 一般会映射成 Gemini inlineData，更稳。
    console.log('[chat-voice] attach data-uri', filename, `${stat.size}B`, mime, model || '');
    return {
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${b64}` },
    };
  } catch (e) {
    console.warn('[chat-voice] resolve audio failed:', e.message);
    return null;
  }
}

function buildChatHistoryOptions(req, timeNote = '', timeNoteUserId = null, settings = null, isDreamMode = false) {
  const reqBase = `${req.protocol}://${req.get('host')}`;
  const model = settings
    ? resolveChatApiSettings(settings, isDreamMode).model
    : '';
  return {
    timeNote,
    timeNoteUserId,
    resolveImageUrl: (u) => resolveChatImageUrl(u, reqBase),
    resolveAudioPart: (u) => resolveChatAudioPart(u, { model }),
  };
}

// ===== HEALTH =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'nian-backend',
    port: Number(process.env.PORT) || 3000,
    siteLock: siteLock.isEnabled(),
  });
});

const APP_UPDATE_DIR = path.join(__dirname, 'data', 'app-update');
const APP_UPDATE_APK = path.join(APP_UPDATE_DIR, 'nian.apk');
const APP_UPDATE_META = path.join(APP_UPDATE_DIR, 'version.json');

function readAppUpdateMeta() {
  try {
    if (!fs.existsSync(APP_UPDATE_META) || !fs.existsSync(APP_UPDATE_APK)) return null;
    const meta = JSON.parse(fs.readFileSync(APP_UPDATE_META, 'utf8'));
    const st = fs.statSync(APP_UPDATE_APK);
    return {
      available: true,
      versionCode: Number(meta.versionCode) || 0,
      versionName: String(meta.versionName || ''),
      size: st.size,
      builtAt: meta.builtAt || null,
    };
  } catch {
    return null;
  }
}

app.get('/api/app-update', (req, res) => {
  const meta = readAppUpdateMeta();
  if (!meta) return res.json({ available: false });
  res.json(meta);
});

app.get('/api/app-update/apk', (req, res) => {
  if (!fs.existsSync(APP_UPDATE_APK)) {
    return res.status(404).json({ error: '还没有上传安装包' });
  }
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="nian.apk"');
  res.sendFile(path.resolve(APP_UPDATE_APK));
});

app.post('/api/phone/notifications', (req, res) => {
  try {
    const n = require('./phone-state-helper').ingest(req.body || {});
    return res.json({ ok: true, count: n });
  } catch (e) {
    return res.status(400).json({ error: e.message || '上报失败' });
  }
});

app.post('/api/phone/screen', (req, res) => {
  try {
    const ok = require('./phone-state-helper').fulfillScreen(req.body || {});
    return res.json({ ok });
  } catch (e) {
    return res.status(400).json({ error: e.message || '上报失败' });
  }
});

app.post('/api/phone/location', async (req, res) => {
  try {
    await require('./phone-state-helper').ingestLocation(req.body || {});
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message || '上报失败' });
  }
});

app.post('/api/phone/share', (req, res) => {
  try {
    const on = req.body?.on !== false && req.body?.on !== 0;
    require('./phone-state-helper').setShare(on, req.body?.characterId);
    return res.json({ ok: true, on });
  } catch (e) {
    return res.status(400).json({ error: e.message || '失败' });
  }
});

app.get('/api/phone/pull', (req, res) => {
  try {
    const commands = require('./phone-state-helper').pullCommands();
    return res.json({ ok: true, commands });
  } catch (e) {
    return res.status(400).json({ error: e.message || '拉取失败' });
  }
});

app.post('/api/phone/toy', (req, res) => {
  try {
    require('./toy-helper').ingest(req.body || {});
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message || '上报失败' });
  }
});

app.get('/api/site-auth/status', (req, res) => {
  const enabled = siteLock.isEnabled();
  const authenticated = siteLock.isAuthenticated(req);
  res.json({ enabled, authenticated, needsAuth: enabled && !authenticated });
});

app.post('/api/site-auth/login', (req, res) => {
  if (!siteLock.isEnabled()) {
    return res.json({ ok: true, authenticated: true });
  }
  const { username, password } = req.body || {};
  if (!siteLock.verifyCredentials(String(username || ''), String(password || ''))) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = siteLock.createSessionToken(req);
  res.cookie(siteLock.COOKIE_NAME, token, siteLock.getCookieOptions(req));
  // token 一并返回：APK 跨域时 Cookie 可能带不上，前端用 X-Nian-Session
  res.json({ ok: true, authenticated: true, token });
});

app.use(siteLock.siteLockMiddleware);

// ===== WEB PUSH =====
const {
  getPublicKey: getVapidPublicKey,
  saveSubscription: savePushSubscription,
  removeSubscription: removePushSubscription,
  getPushStatus,
  sendTestPush,
} = require('./web-push-helper');

app.get('/api/push/vapid-public-key', (req, res) => {
  try {
    res.json({ publicKey: getVapidPublicKey() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/push/subscribe', (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: '无效的订阅' });
  try {
    savePushSubscription(subscription, req.headers['user-agent'] || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) removePushSubscription(endpoint);
  res.json({ ok: true });
});

app.get('/api/push/status', (req, res) => {
  try {
    res.json(getPushStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/push/test', async (req, res) => {
  try {
    const { title, body } = req.body || {};
    const r = await sendTestPush(title, body);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ===== SETTINGS =====
app.get('/api/settings', (req, res) => {
  res.json(getPublicSettings());
});

app.post('/api/settings', (req, res) => {
  const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  const robotKeys = new Set([
    'robot_enabled', 'robot_character_id', 'robot_token', 'robot_device_name',
    'robot_tts', 'robot_mute', 'robot_volume', 'robot_screen_chat', 'robot_sync_chat',
    'robot_presence_enabled', 'robot_face_track_enabled', 'robot_emotion_sense_enabled',
    'robot_led_enabled', 'robot_led_max_brightness', 'robot_pitch_center',
    'robot_expression_decay_sec', 'robot_drowsy_idle_sec', 'robot_public_base_url',
    'robot_control_mode', 'robot_mcp_base_url', 'robot_mcp_token',
  ]);
  let robotSettingsChanged = false;
  for (const [k, v] of Object.entries(req.body)) {
    if (k === 'vapid_private_key' || k === 'vapid_public_key') continue;
    if (k === 'user_voiceprint' || k === 'voiceprint' || k === voiceprintHelper.VOICEPRINT_SETTING_KEY) continue;
    if (k === 'user_faceprint' || k === 'faceprint' || k === faceprintHelper.FACEPRINT_SETTING_KEY) continue;
    if (k === 'mcp_servers') continue; // 走 /api/mcp/servers，避免无 token 的公开副本盖掉密钥
    upsert.run(k, String(v));
    if (robotKeys.has(k)) robotSettingsChanged = true;
  }
  if (robotSettingsChanged) {
    try {
      const settings = getSettings();
      const cid = parseInt(settings.robot_character_id, 10);
      if (cid) robotCommands.enqueueSettingsRefresh(cid);
    } catch (e) {
      console.warn('[settings] robot refresh', e.message);
    }
  }
  res.json({ ok: true });
});

// ===== MCP 插件（远程 URL 客户端）=====
app.get('/api/mcp/servers', (req, res) => {
  try {
    const mcp = require('./mcp-client-helper');
    res.json({ servers: mcp.listPublicServers(getSettings) });
  } catch (e) {
    res.status(500).json({ error: e.message || '读取失败' });
  }
});

app.post('/api/mcp/servers', (req, res) => {
  try {
    const mcp = require('./mcp-client-helper');
    const body = req.body || {};
    const action = String(body.action || 'upsert').trim().toLowerCase();
    if (action === 'delete') {
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: '缺少 id' });
      mcp.deleteServer(getSettings, setSetting, id);
      return res.json({ ok: true, servers: mcp.listPublicServers(getSettings) });
    }
    const server = mcp.upsertServer(getSettings, setSetting, body);
    res.json({ ok: true, server, servers: mcp.listPublicServers(getSettings) });
  } catch (e) {
    res.status(400).json({ error: e.message || '保存失败' });
  }
});

app.post('/api/mcp/servers/:id/test', async (req, res) => {
  try {
    const mcp = require('./mcp-client-helper');
    const id = String(req.params.id || '').trim();
    const servers = mcp.loadServers(getSettings);
    const server = servers.find((s) => s.id === id);
    if (!server) return res.status(404).json({ error: '服务不存在' });
    const result = await mcp.testServer(server);
    res.json({
      ok: true,
      ...result,
      server: mcp.publicServer(server),
      servers: mcp.listPublicServers(getSettings),
    });
  } catch (e) {
    console.warn('[mcp] test', e.message);
    res.status(400).json({ ok: false, error: e.message || '连接失败' });
  }
});

// ===== 用户自拍外貌（识图写入 user_appearance，供聊天引用）=====
app.post('/api/user/analyze-selfie', async (req, res) => {
  try {
    const imageUrl = String(req.body?.imageUrl || '').trim();
    if (!imageUrl) return res.status(400).json({ error: '缺少 imageUrl' });
    if (imageUrl.startsWith('http') && !imageUrl.includes('/uploads/')) {
      return res.status(400).json({ error: '请先上传到本机后再分析' });
    }
    const settings = getSettings();
    if (!(settings.chat_api_url || '').trim() || !(settings.chat_api_key || '').trim()) {
      return res.status(400).json({ error: '请先在设置里配置聊天 API，才能分析外貌' });
    }
    const reqBase = `${req.protocol}://${req.get('host')}`;
    const appearance = await describeUserAppearance(settings, imageUrl, reqBase);
    if (!appearance) return res.status(500).json({ error: '识图失败，请换一张更清晰的正面/半身照重试' });
    const save = String(req.body?.save ?? '1') !== '0';
    if (save) {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run('user_selfie', imageUrl);
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run('user_appearance', appearance);
    }
    res.json({ ok: true, appearance, imageUrl });
  } catch (e) {
    console.warn('[user/analyze-selfie]', e.message);
    res.status(500).json({ error: e.message || '分析失败' });
  }
});

// ===== 用户声纹库（本地特征，不调聊天模型）=====
app.get('/api/voiceprint/status', (req, res) => {
  const stored = voiceprintHelper.loadStoredVoiceprint(getSettings);
  res.json(voiceprintHelper.publicVoiceprintStatus(stored));
});

app.post('/api/voiceprint/enroll', upload.array('files', 5), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '请至少录一段说话音频' });
    const merge = String(req.body?.merge ?? '1') !== '0';
    const paths = files.map((f) => f.path);
    const status = await voiceprintHelper.enrollFromFiles(paths, getSettings, setSetting, { merge });
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    res.json(status);
  } catch (e) {
    console.warn('[voiceprint/enroll]', e.message);
    for (const f of req.files || []) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    res.status(500).json({ error: e.message || '声纹录入失败' });
  }
});

app.post('/api/voiceprint/clear', (req, res) => {
  voiceprintHelper.clearVoiceprint(setSetting);
  res.json({ enrolled: false, enrolledAt: null, samples: 0 });
});

// ===== 用户面容库（本地几何向量，不调聊天模型）=====
app.get('/api/faceprint/status', (req, res) => {
  const stored = faceprintHelper.loadStoredFaceprint(getSettings);
  res.json(faceprintHelper.publicFaceprintStatus(stored));
});

app.post('/api/faceprint/enroll', upload.array('files', 5), (req, res) => {
  try {
    const merge = String(req.body?.merge ?? '1') !== '0';
    const files = req.files || [];
    if (files.length) {
      const urls = files.map((f) => `/uploads/${f.filename}`);
      const status = faceprintHelper.enrollFromPhotoUrls(urls, getSettings, setSetting, { merge });
      return res.json(status);
    }
    const list = req.body?.embeddings || req.body?.samples || [];
    if (Array.isArray(list) && list.length) {
      const status = faceprintHelper.enrollFromEmbeddings(list, getSettings, setSetting, { merge });
      return res.json(status);
    }
    return res.status(400).json({ error: '请上传一张正脸照片，或让小机看你一眼录入' });
  } catch (e) {
    console.warn('[faceprint/enroll]', e.message);
    res.status(500).json({ error: e.message || '面容录入失败' });
  }
});

app.post('/api/faceprint/enroll-next', (req, res) => {
  const on = req.body?.enable !== false && req.body?.enable !== 0 && req.body?.enable !== '0';
  setSetting('robot_faceprint_enroll_next', on ? '1' : '0');
  if (on) setSetting('robot_faceprint_enabled', '1');
  const stored = faceprintHelper.loadStoredFaceprint(getSettings);
  res.json({
    ...faceprintHelper.publicFaceprintStatus(stored),
    enrollNext: on,
  });
});

app.post('/api/faceprint/verify', (req, res) => {
  const embedding = faceprintHelper.parseEmbedding(req.body);
  if (!embedding) return res.status(400).json({ error: '缺少 faceEmbedding' });
  const verified = faceprintHelper.verifyEmbeddingAgainstStored(embedding, getSettings);
  res.json(verified);
});

app.post('/api/faceprint/clear', (req, res) => {
  faceprintHelper.clearFaceprint(setSetting);
  setSetting('robot_faceprint_enroll_next', '0');
  res.json({ enrolled: false, enrolledAt: null, samples: 0, photos: 0, enrollNext: false });
});

function applyRealWorldMapFlag(charId, raw) {
  const on = raw === 1 || raw === '1' || raw === true;
  try {
    db.prepare('UPDATE characters SET real_world_map=? WHERE id=?').run(on ? 1 : 0, charId);
  } catch (e) {
    console.warn('[real_world_map] save', e.message);
  }
}

function applyRealPlaceNamesFlag(charId, raw) {
  const on = raw === 1 || raw === '1' || raw === true;
  try {
    db.prepare('UPDATE characters SET real_place_names=? WHERE id=?').run(on ? 1 : 0, charId);
  } catch (e) {
    console.warn('[real_place_names] save', e.message);
  }
}

function applyScreenChatPriorityFlag(charId, raw) {
  const on = raw === 1 || raw === '1' || raw === true;
  try {
    if (on) {
      db.prepare('UPDATE characters SET screen_chat_priority=0 WHERE id!=?').run(charId);
    }
    db.prepare('UPDATE characters SET screen_chat_priority=? WHERE id=?').run(on ? 1 : 0, charId);
  } catch (e) {
    console.warn('[screen_chat_priority] save', e.message);
  }
}

function resolvePresentLocation(c) {
  try {
    return require('./cron').resolveCharacterPresentLocation(c) || '';
  } catch {
    return '';
  }
}

function withPresentLocation(c) {
  if (!c) return c;
  return { ...c, present_location: resolvePresentLocation(c) };
}

function serializeCharacter(c) {
  if (!c) return c;
  const enriched = contacts.enrichCharacter(db, c);
  let nicknames = { toChar: [], toUser: [] };
  let appearance_profile = {};
  try {
    nicknames = require('./nickname-helper').normalizeNicknames(c.nicknames);
  } catch {}
  try {
    appearance_profile = require('./wardrobe-helper').parseAppearanceProfile(c.appearance_profile);
  } catch {}
  const present_location = resolvePresentLocation(c);
  return {
    ...enriched,
    worldbook_ids: JSON.parse(c.worldbook_ids || '[]'),
    mutual_characters: JSON.parse(c.mutual_characters || '[]'),
    image_ref: normalizeImageRefGroups(c.image_ref || '[]'),
    appearance_profile,
    nsfw_tags: JSON.parse(c.nsfw_tags || '[]'),
    emoji_categories: JSON.parse(c.emoji_categories || '[]'),
    memory_weights: JSON.parse(c.memory_weights || '{}'),
    geo_city_aliases: (() => {
      try {
        return require('./geo-worldbook-helper').parseAliasList(c.geo_city_aliases);
      } catch {
        return [];
      }
    })(),
    nicknames,
    robot_emotions: robotHelper.parseRobotEmotions(c.robot_emotions),
    vocal_clips: require('./vocal-clips-helper').parseVocalClips(c.vocal_clips),
    present_location,
    is_circle_npc: contacts.isCircleNpcCharacter(c),
    circle_npc_id: c.circle_npc_id || null,
  };
}

// ===== CHARACTERS =====
app.get('/api/characters', (req, res) => {
  try { require('./robot-operating-helper').clearOperatingIfDeviceOffline(); } catch {}
  const scope = String(req.query.scope || 'all');
  if (scope === 'friends') {
    return res.json(contacts.listFriendCharacters(db).map((c) => withPresentLocation({
      ...c,
      image_ref: normalizeImageRefGroups(c.image_ref || '[]'),
    })));
  }
  if (scope === 'chat') {
    return res.json(contacts.listChatCharacters(db).map((c) => withPresentLocation({
      ...c,
      image_ref: normalizeImageRefGroups(c.image_ref || '[]'),
    })));
  }
  if (scope === 'addable') {
    return res.json(contacts.listAddableCharacters(db));
  }
  const chars = db.prepare('SELECT * FROM characters ORDER BY id').all();
  res.json(chars.map(serializeCharacter));
});

app.get('/api/characters/:id', (req, res) => {
  try { require('./robot-operating-helper').clearOperatingIfDeviceOffline(); } catch {}
  const c = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(serializeCharacter(c));
});

/** 从近聊扫描双方称呼候选（不写库，前端确认后再 PUT） */
app.post('/api/characters/:id/scan-nicknames', async (req, res) => {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Not found' });
  const settings = getSettings();
  const {
    normalizeNicknames, filterScanList,
  } = require('./nickname-helper');
  const existing = normalizeNicknames(char.nicknames);
  const username = settings.username || '旅人';

  const msgs = db.prepare(
    `SELECT role, content, type FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0
       AND role IN ('user','assistant')
       AND (type IS NULL OR type IN ('','text','mixed'))
     ORDER BY id DESC LIMIT 100`
  ).all(char.id).reverse();

  if (msgs.length < 4) {
    return res.json({
      toChar: [],
      toUser: [],
      error: '近聊太少，先聊几句再扫',
    });
  }

  const lines = msgs.map((m) => {
    const who = m.role === 'user' ? username : char.name;
    const text = String(m.content || '')
      .replace(/^【自动回复】/, '')
      .replace(/\[引用\][\s\S]*?\[\/引用\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return text ? `${who}：${text}` : '';
  }).filter(Boolean);

  const systemPrompt = `你是称呼抽取器。根据对话，找出：
1) toChar：用户用来称呼角色「${char.name}」的喊法（昵称/外号/简称，不是整句）
2) toUser：角色「${char.name}」用来称呼用户「${username}」的喊法
规则：只输出 JSON；每侧最多 8 个短词（≤12字）；不要解释；不要把普通动词/句子当称呼；可含亲昵词如宝贝/亲爱的。
输出格式严格为：{"toChar":["…"],"toUser":["…"]}`;

  try {
    let raw = await callChatAPIComplete(settings, systemPrompt, lines.join('\n'), 'memory');
    if (!raw) raw = await callChatAPIComplete(settings, systemPrompt, lines.join('\n'), 'chat');
    let parsed = null;
    try {
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      return res.status(500).json({ error: '未能解析称呼结果', toChar: [], toUser: [] });
    }
    const opts = { charName: char.name, userName: username };
    const toChar = filterScanList(parsed.toChar, existing.toChar, opts);
    const toUser = filterScanList(parsed.toUser, existing.toUser, opts);
    res.json({ toChar, toUser });
  } catch (e) {
    res.status(500).json({
      error: formatApiBillingError(e.message) || e.message || '扫描失败',
      toChar: [],
      toUser: [],
    });
  }
});

app.post('/api/characters', (req, res) => {
  const d = req.body;
  const description = d.description || [
    d.personality && `【性格】${d.personality}`,
    d.background && `【背景】${d.background}`,
    d.behavior && `【行为模式】${d.behavior}`,
  ].filter(Boolean).join('\n');
  const r = db.prepare(`INSERT INTO characters (name,avatar,intro,opening,language_style,location_name,real_location,description,personality,background,behavior,relationship,relationship_custom,voice_id,voice_messages,memory_trigger_n,memory_summary_enabled,busy_style,allow_diary,post_moments,mutual_characters,image_ref,image_style,nsfw_enabled,nsfw_tags,nsfw_note,dream_affects_memory,birthday,anniversary,status,emoji_categories,memory_weights,worldbook_ids,proactive_msg_enabled,proactive_msg_minutes,proactive_call_enabled,emoji_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    d.name||'新角色', d.avatar||'', d.intro||'', d.opening||'', d.language_style||'', d.location_name||'', d.real_location||'',
    description, d.personality||'', d.background||'', d.behavior||'',
    d.relationship||'', d.relationship_custom||'',
    d.voice_id||'', d.voice_messages?1:0, d.memory_trigger_n||10, (d.memory_summary_enabled === 0 || d.memory_summary_enabled === '0') ? 0 : 1, d.busy_style||'gentle',
    d.allow_diary?1:0, d.post_moments?1:0,
    JSON.stringify(d.mutual_characters||[]), JSON.stringify(normalizeImageRefGroups(d.image_ref||{})),
    d.image_style||'anime', (d.nsfw_enabled === 0 || d.nsfw_enabled === '0') ? 0 : 1, JSON.stringify(d.nsfw_tags||[]), d.nsfw_note||'',
    d.dream_affects_memory?1:0, d.birthday||'', d.anniversary||'', d.status||'online',
    JSON.stringify(d.emoji_categories||[]), JSON.stringify(d.memory_weights||{}), JSON.stringify(d.worldbook_ids||[]),
    d.proactive_msg_enabled?1:0, d.proactive_msg_minutes||60, d.proactive_call_enabled?1:0,
    d.emoji_enabled !== undefined ? (d.emoji_enabled?1:0) : 1
  );
  try { contacts.ensureContactRow(db, r.lastInsertRowid, contacts.STATUS.FRIEND); } catch {}
  if (d.emoji_freq !== undefined) {
    try {
      const freq = Math.max(0, Math.min(100, parseInt(d.emoji_freq, 10) || 0));
      db.prepare('UPDATE characters SET emoji_freq=? WHERE id=?').run(freq, r.lastInsertRowid);
    } catch {}
  }
  if (d.moments_cover !== undefined) {
    try {
      db.prepare('UPDATE characters SET moments_cover=? WHERE id=?')
        .run(String(d.moments_cover || ''), r.lastInsertRowid);
    } catch {}
  }
  if (d.nicknames !== undefined) {
    try {
      const { nicknamesToJson } = require('./nickname-helper');
      db.prepare('UPDATE characters SET nicknames=? WHERE id=?')
        .run(nicknamesToJson(d.nicknames), r.lastInsertRowid);
    } catch {}
  }
  // Persist fields the create form sends that are not in the base INSERT
  try {
    const emotionStyle = d.emotion_style != null ? String(d.emotion_style || '') : '';
    const chatRounds = Math.max(3, Math.min(50, parseInt(d.chat_context_rounds, 10) || 18));
    const memKeywords = d.memory_keywords != null ? String(d.memory_keywords || '') : '';
    const imageAspect = normalizeSelfieAspect(d.image_aspect || '3:4');
    const videoAspect = normalizeSelfieAspect(d.video_aspect || d.image_aspect || '9:16');
    const selfieStylePrompt = d.selfie_style_prompt != null ? String(d.selfie_style_prompt || '') : '';
    const homeEnvironment = d.home_environment != null ? String(d.home_environment || '') : '';
    const videoMotionPrompt = d.video_motion_prompt != null ? String(d.video_motion_prompt || '') : '';
    const diaryEnabled = d.diary_enabled === 0 || d.diary_enabled === '0' || d.diary_enabled === false ? 0 : 1;
    const scheduleEnabled = d.schedule_enabled === 0 || d.schedule_enabled === '0' || d.schedule_enabled === false ? 0 : 1;
    const naturalChat = d.natural_chat_mode ? 1 : 0;
    const timeAware = d.time_aware_enabled === 0 || d.time_aware_enabled === '0' || d.time_aware_enabled === false ? 0 : 1;
    const houseTz = String(getSettings()?.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
    const timezone = String(d.timezone || houseTz).trim() || houseTz;
    const callDays = Math.max(1, Math.min(30, parseInt(d.proactive_call_interval_days, 10) || 7));
    db.prepare(`UPDATE characters SET emotion_style=?, chat_context_rounds=?, memory_keywords=?, image_aspect=?, video_aspect=?, selfie_style_prompt=?, home_environment=?, video_motion_prompt=?, diary_enabled=?, schedule_enabled=?, natural_chat_mode=?, time_aware_enabled=?, timezone=?, proactive_call_interval_days=? WHERE id=?`)
      .run(emotionStyle, chatRounds, memKeywords, imageAspect, videoAspect, selfieStylePrompt, homeEnvironment, videoMotionPrompt, diaryEnabled, scheduleEnabled, naturalChat, timeAware, timezone, callDays, r.lastInsertRowid);
    if (d.home_refs !== undefined) {
      try {
        db.prepare('UPDATE characters SET home_refs=? WHERE id=?')
          .run(homeRefsToJson(d.home_refs), r.lastInsertRowid);
      } catch {}
    }
    try {
      db.prepare('UPDATE characters SET home_address=?, real_home_address=? WHERE id=?')
        .run(
          d.home_address != null ? String(d.home_address || '') : '',
          d.real_home_address != null ? String(d.real_home_address || '') : '',
          r.lastInsertRowid
        );
    } catch {}
    if (d.vocal_clips !== undefined) {
      try {
        const { vocalClipsToJson } = require('./vocal-clips-helper');
        db.prepare('UPDATE characters SET vocal_clips=? WHERE id=?')
          .run(vocalClipsToJson(d.vocal_clips), r.lastInsertRowid);
      } catch {}
    }
    if (d.voice_id_nsfw !== undefined) {
      try {
        const { trimVoiceId } = require('./voice-lane-helper');
        db.prepare('UPDATE characters SET voice_id_nsfw=? WHERE id=?')
          .run(trimVoiceId(d.voice_id_nsfw), r.lastInsertRowid);
      } catch {}
    }
    if (d.call_video !== undefined) {
      try {
        db.prepare('UPDATE characters SET call_video=? WHERE id=?')
          .run(String(d.call_video || '').trim(), r.lastInsertRowid);
      } catch {}
    }
    if (d.call_video_mode !== undefined) {
      try {
        const mode = String(d.call_video_mode || '').trim().toLowerCase() === 'text' ? 'text' : 'video';
        db.prepare('UPDATE characters SET call_video_mode=? WHERE id=?')
          .run(mode, r.lastInsertRowid);
      } catch {}
    }
    if (d.chat_model !== undefined) {
      try {
        db.prepare('UPDATE characters SET chat_model=? WHERE id=?')
          .run(String(d.chat_model || '').trim(), r.lastInsertRowid);
      } catch {}
    }
    if (d.group_talkativeness !== undefined) {
      try {
        const talk = require('./group-chat-helper').normalizeTalk(d.group_talkativeness);
        db.prepare('UPDATE characters SET group_talkativeness=? WHERE id=?')
          .run(talk, r.lastInsertRowid);
      } catch {}
    }
  } catch {}
  if (d.music_score_enabled !== undefined) {
    try {
      db.prepare('UPDATE characters SET music_score_enabled=? WHERE id=?')
        .run(d.music_score_enabled ? 1 : 0, r.lastInsertRowid);
    } catch {}
  }
  if (d.screen_chat_priority !== undefined) {
    applyScreenChatPriorityFlag(r.lastInsertRowid, d.screen_chat_priority);
  }
  if (d.real_world_map !== undefined) {
    applyRealWorldMapFlag(r.lastInsertRowid, d.real_world_map);
  }
  if (d.real_place_names !== undefined) {
    applyRealPlaceNamesFlag(r.lastInsertRowid, d.real_place_names);
  }
  try { require('./geo-worldbook-helper').syncGeoWorldbook(db, r.lastInsertRowid); } catch (e) {
    console.warn('[geo-worldbook] create', e.message);
  }
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/characters/:id', (req, res) => {
  const d = req.body;
  const existing = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const memTriggerN = d.memory_trigger_n != null && d.memory_trigger_n !== ''
    ? parseInt(d.memory_trigger_n, 10)
    : (existing.memory_trigger_n || 10);
  const backgroundKept = d.background !== undefined ? (d.background || '') : (existing.background || '');
  const description = d.description || [
    d.personality && `【性格】${d.personality}`,
    backgroundKept && `【背景】${backgroundKept}`,
    d.behavior && `【行为模式】${d.behavior}`,
  ].filter(Boolean).join('\n');
  const emojiCategories = d.emoji_categories !== undefined
    ? d.emoji_categories
    : JSON.parse(existing.emoji_categories || '[]');
  const emojiEnabled = d.emoji_enabled !== undefined
    ? (d.emoji_enabled ? 1 : 0)
    : (Number(existing.emoji_enabled) !== 0 ? 1 : 0);
  const emojiFreq = d.emoji_freq !== undefined
    ? Math.max(0, Math.min(100, parseInt(d.emoji_freq, 10) || 0))
    : Math.max(0, Math.min(100, parseInt(existing.emoji_freq, 10) || 30));
  const busyStyle = d.busy_style !== undefined ? d.busy_style : (existing.busy_style || 'on');
  const chatContextRounds = d.chat_context_rounds !== undefined
    ? Math.max(3, Math.min(50, parseInt(d.chat_context_rounds, 10) || 18))
    : Math.max(3, Math.min(50, parseInt(existing.chat_context_rounds, 10) || 18));
  const memoryKeywords = d.memory_keywords !== undefined
    ? String(d.memory_keywords || '')
    : String(existing.memory_keywords || '');
  const memSummaryOn = d.memory_summary_enabled !== undefined
    ? !(d.memory_summary_enabled === 0 || d.memory_summary_enabled === '0')
    : !(Number(existing.memory_summary_enabled) === 0);
  const diaryBg = d.diary_bg !== undefined
    ? String(d.diary_bg || 'default')
    : String(existing.diary_bg || 'default');
  const imageAspect = d.image_aspect !== undefined
    ? normalizeSelfieAspect(d.image_aspect)
    : normalizeSelfieAspect(existing.image_aspect || '3:4');
  const videoAspect = d.video_aspect !== undefined
    ? normalizeSelfieAspect(d.video_aspect)
    : normalizeSelfieAspect(existing.video_aspect || existing.image_aspect || '9:16');
  const selfieStylePrompt = d.selfie_style_prompt !== undefined
    ? String(d.selfie_style_prompt || '')
    : String(existing.selfie_style_prompt || '');
  const homeEnvironment = d.home_environment !== undefined
    ? String(d.home_environment || '')
    : String(existing.home_environment || '');
  const videoMotionPrompt = d.video_motion_prompt !== undefined
    ? String(d.video_motion_prompt || '')
    : String(existing.video_motion_prompt || '');
  const naturalChatMode = d.natural_chat_mode !== undefined
    ? (d.natural_chat_mode ? 1 : 0)
    : (Number(existing.natural_chat_mode) === 1 ? 1 : 0);
  const timeAwareEnabled = d.time_aware_enabled !== undefined
    ? (d.time_aware_enabled ? 1 : 0)
    : (existing.time_aware_enabled === 0 || existing.time_aware_enabled === '0' ? 0 : 1);
  const timezone = d.timezone !== undefined
    ? String(d.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai'
    : String(existing.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  const callIntervalDays = d.proactive_call_interval_days !== undefined
    ? Math.max(1, Math.min(30, parseInt(d.proactive_call_interval_days, 10) || 7))
    : Math.max(1, Math.min(30, parseInt(existing.proactive_call_interval_days, 10) || 7));
  db.prepare(`UPDATE characters SET name=?,avatar=?,intro=?,opening=?,language_style=?,location_name=?,real_location=?,description=?,personality=?,background=?,behavior=?,emotion_style=?,relationship=?,relationship_custom=?,voice_id=?,voice_messages=?,memory_trigger_n=?,memory_summary_enabled=?,busy_style=?,allow_diary=?,post_moments=?,mutual_characters=?,image_ref=?,image_style=?,nsfw_enabled=?,nsfw_tags=?,nsfw_note=?,dream_affects_memory=?,birthday=?,anniversary=?,status=?,emoji_categories=?,memory_weights=?,worldbook_ids=?,timezone_offset=?,proactive_msg_enabled=?,proactive_msg_minutes=?,proactive_call_enabled=?,emoji_enabled=?,chat_context_rounds=?,memory_keywords=?,diary_bg=?,image_aspect=?,video_aspect=?,selfie_style_prompt=?,home_environment=?,video_motion_prompt=?,natural_chat_mode=?,time_aware_enabled=?,timezone=?,proactive_call_interval_days=? WHERE id=?`).run(
    d.name, d.avatar, d.intro, d.opening !== undefined ? d.opening : (existing.opening || ''), d.language_style, d.location_name, d.real_location,
    description, d.personality||'', backgroundKept, d.behavior||'',
    d.emotion_style !== undefined ? (d.emotion_style || '') : (existing.emotion_style || ''),
    d.relationship !== undefined ? (d.relationship || '') : (existing.relationship || ''),
    d.relationship_custom !== undefined ? (d.relationship_custom || '') : (existing.relationship_custom || ''),
    d.voice_id !== undefined ? d.voice_id : existing.voice_id,
    d.voice_messages !== undefined ? (d.voice_messages ? 1 : 0) : Number(existing.voice_messages || 0),
    memTriggerN, memSummaryOn ? 1 : 0,
    busyStyle,
    d.allow_diary !== undefined ? (d.allow_diary ? 1 : 0) : Number(existing.allow_diary || 0),
    d.post_moments !== undefined ? (d.post_moments ? 1 : 0) : Number(existing.post_moments || 0),
    JSON.stringify(d.mutual_characters !== undefined ? d.mutual_characters : JSON.parse(existing.mutual_characters || '[]')),
    JSON.stringify(normalizeImageRefGroups(d.image_ref !== undefined ? d.image_ref : existing.image_ref)),
    d.image_style || existing.image_style || 'anime',
    d.nsfw_enabled !== undefined ? (d.nsfw_enabled ? 1 : 0) : Number(existing.nsfw_enabled || 0),
    JSON.stringify(d.nsfw_tags !== undefined ? d.nsfw_tags : JSON.parse(existing.nsfw_tags || '[]')),
    d.nsfw_note !== undefined ? d.nsfw_note : (existing.nsfw_note || ''),
    d.dream_affects_memory !== undefined ? (d.dream_affects_memory ? 1 : 0) : Number(existing.dream_affects_memory || 0),
    d.birthday !== undefined ? d.birthday : (existing.birthday || ''),
    d.anniversary !== undefined ? d.anniversary : (existing.anniversary || ''),
    d.status !== undefined ? d.status : (existing.status || 'online'),
    JSON.stringify(emojiCategories), JSON.stringify(d.memory_weights !== undefined ? d.memory_weights : JSON.parse(existing.memory_weights || '{}')),
    JSON.stringify(d.worldbook_ids !== undefined ? d.worldbook_ids : JSON.parse(existing.worldbook_ids || '[]')),
    d.timezone_offset !== undefined ? d.timezone_offset : (existing.timezone_offset ?? 8),
    d.proactive_msg_enabled !== undefined ? (d.proactive_msg_enabled ? 1 : 0) : Number(existing.proactive_msg_enabled || 0),
    d.proactive_msg_minutes !== undefined ? d.proactive_msg_minutes : (existing.proactive_msg_minutes || 60),
    d.proactive_call_enabled !== undefined ? (d.proactive_call_enabled ? 1 : 0) : Number(existing.proactive_call_enabled || 0),
    emojiEnabled,
    chatContextRounds,
    memoryKeywords,
    diaryBg,
    imageAspect,
    videoAspect,
    selfieStylePrompt,
    homeEnvironment,
    videoMotionPrompt,
    naturalChatMode,
    timeAwareEnabled,
    timezone,
    callIntervalDays,
    req.params.id
  );
  try {
    db.prepare('UPDATE characters SET emoji_freq=? WHERE id=?')
      .run(emojiFreq, req.params.id);
  } catch {}
  if (d.memory_flash_chance !== undefined) {
    try {
      const n = Math.max(0, Math.min(100, parseInt(d.memory_flash_chance, 10)));
      if (Number.isFinite(n)) {
        db.prepare('UPDATE characters SET memory_flash_chance=? WHERE id=?').run(n, req.params.id);
      }
    } catch { /* 列尚未迁移 */ }
  }
  if (d.carry_memory !== undefined) {
    try {
      db.prepare('UPDATE characters SET carry_memory=? WHERE id=?')
        .run(d.carry_memory === 0 || d.carry_memory === '0' || d.carry_memory === false ? 0 : 1, req.params.id);
    } catch { /* 列尚未迁移 */ }
  }
  if (d.carry_portrait !== undefined) {
    try {
      db.prepare('UPDATE characters SET carry_portrait=? WHERE id=?')
        .run(d.carry_portrait === 0 || d.carry_portrait === '0' || d.carry_portrait === false ? 0 : 1, req.params.id);
    } catch { /* 列尚未迁移 */ }
  }
  if (d.moments_cover !== undefined) {
    try {
      db.prepare('UPDATE characters SET moments_cover=? WHERE id=?')
        .run(String(d.moments_cover || ''), req.params.id);
    } catch {}
  }
  if (d.home_refs !== undefined) {
    try {
      db.prepare('UPDATE characters SET home_refs=? WHERE id=?')
        .run(homeRefsToJson(d.home_refs), req.params.id);
    } catch (e) {
      console.warn('[home_refs] save', e.message);
    }
  }
  if (d.home_address !== undefined || d.real_home_address !== undefined) {
    try {
      const homeAddress = d.home_address !== undefined
        ? String(d.home_address || '')
        : String(existing.home_address || '');
      const realHomeAddress = d.real_home_address !== undefined
        ? String(d.real_home_address || '')
        : String(existing.real_home_address || '');
      db.prepare('UPDATE characters SET home_address=?, real_home_address=? WHERE id=?')
        .run(homeAddress, realHomeAddress, req.params.id);
    } catch (e) {
      console.warn('[home_address] save', e.message);
    }
  }
  if (d.vocal_clips !== undefined) {
    try {
      const { vocalClipsToJson } = require('./vocal-clips-helper');
      db.prepare('UPDATE characters SET vocal_clips=? WHERE id=?')
        .run(vocalClipsToJson(d.vocal_clips), req.params.id);
    } catch (e) {
      console.warn('[vocal_clips] save', e.message);
    }
  }
  if (d.voice_id_nsfw !== undefined) {
    try {
      const { trimVoiceId } = require('./voice-lane-helper');
      db.prepare('UPDATE characters SET voice_id_nsfw=? WHERE id=?')
        .run(trimVoiceId(d.voice_id_nsfw), req.params.id);
    } catch (e) {
      console.warn('[voice_id_nsfw] save', e.message);
    }
  }
  if (d.call_video !== undefined) {
    try {
      db.prepare('UPDATE characters SET call_video=? WHERE id=?')
        .run(String(d.call_video || '').trim(), req.params.id);
    } catch (e) {
      console.warn('[call_video] save', e.message);
    }
  }
  if (d.call_video_mode !== undefined) {
    try {
      const mode = String(d.call_video_mode || '').trim().toLowerCase() === 'text' ? 'text' : 'video';
      db.prepare('UPDATE characters SET call_video_mode=? WHERE id=?')
        .run(mode, req.params.id);
    } catch (e) {
      console.warn('[call_video_mode] save', e.message);
    }
  }
  if (d.chat_model !== undefined) {
    try {
      db.prepare('UPDATE characters SET chat_model=? WHERE id=?')
        .run(String(d.chat_model || '').trim(), req.params.id);
    } catch (e) {
      console.warn('[chat_model] save', e.message);
    }
  }
  if (d.group_talkativeness !== undefined) {
    try {
      const talk = require('./group-chat-helper').normalizeTalk(d.group_talkativeness);
      db.prepare('UPDATE characters SET group_talkativeness=? WHERE id=?')
        .run(talk, req.params.id);
    } catch (e) {
      console.warn('[group_talkativeness] save', e.message);
    }
  }
  if (d.nicknames !== undefined) {
    try {
      const { nicknamesToJson } = require('./nickname-helper');
      db.prepare('UPDATE characters SET nicknames=? WHERE id=?')
        .run(nicknamesToJson(d.nicknames), req.params.id);
    } catch (e) {
      console.warn('[nicknames] save', e.message);
    }
  }
  if (d.appearance_profile !== undefined) {
    try {
      const { parseAppearanceProfile } = require('./wardrobe-helper');
      const profile = parseAppearanceProfile(d.appearance_profile);
      db.prepare('UPDATE characters SET appearance_profile=? WHERE id=?')
        .run(JSON.stringify(profile), req.params.id);
    } catch (e) {
      console.warn('[appearance_profile] save', e.message);
    }
  }
  if (d.music_score_enabled !== undefined) {
    try {
      db.prepare('UPDATE characters SET music_score_enabled=? WHERE id=?')
        .run(d.music_score_enabled ? 1 : 0, req.params.id);
    } catch {}
  }
  if (d.screen_chat_priority !== undefined) {
    applyScreenChatPriorityFlag(req.params.id, d.screen_chat_priority);
  }
  if (d.real_world_map !== undefined) {
    applyRealWorldMapFlag(req.params.id, d.real_world_map);
  }
  if (d.real_place_names !== undefined) {
    applyRealPlaceNamesFlag(req.params.id, d.real_place_names);
  }
  try {
    const diaryEnabled = d.diary_enabled !== undefined
      ? (d.diary_enabled === 0 || d.diary_enabled === '0' || d.diary_enabled === false ? 0 : 1)
      : (Number(existing.diary_enabled) === 0 ? 0 : 1);
    const scheduleEnabled = d.schedule_enabled !== undefined
      ? (d.schedule_enabled === 0 || d.schedule_enabled === '0' || d.schedule_enabled === false ? 0 : 1)
      : (Number(existing.schedule_enabled) === 0 ? 0 : 1);
    db.prepare('UPDATE characters SET diary_enabled=?, schedule_enabled=? WHERE id=?')
      .run(diaryEnabled, scheduleEnabled, req.params.id);
  } catch {}
  try { require('./geo-worldbook-helper').syncGeoWorldbook(db, req.params.id); } catch (e) {
    console.warn('[geo-worldbook] save', e.message);
  }
  res.json({ ok: true });
});

app.delete('/api/characters/:id', (req, res) => {
  try { require('./geo-worldbook-helper').deleteGeoWorldbook(db, req.params.id); } catch {}
  db.prepare('DELETE FROM characters WHERE id=?').run(req.params.id);
  try { db.prepare('DELETE FROM user_contacts WHERE character_id=?').run(req.params.id); } catch {}
  try { db.prepare('DELETE FROM friend_requests WHERE character_id=?').run(req.params.id); } catch {}
  try { require('./char-archive-helper').deleteAllForCharacter(req.params.id); } catch {}
  res.json({ ok: true });
});

// ===== 圈子与NPC =====
const circle = require('./circle-helper');

app.get('/api/circles', (req, res) => {
  try {
    const characterId = req.query.characterId || req.query.character_id || null;
    res.json(circle.listCircles(db, characterId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/circles/:id', (req, res) => {
  const circleData = circle.getCircle(db, req.params.id);
  if (!circleData) return res.status(404).json({ error: '圈子不存在' });
  res.json(circleData);
});

app.post('/api/circles', (req, res) => {
  try {
    const data = req.body || {};
    const c = circle.createCircle(db, data);
    res.json(c);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/circles/:id', (req, res) => {
  const data = req.body || {};
  const c = circle.updateCircle(db, req.params.id, data);
  if (!c) return res.status(404).json({ error: '圈子不存在' });
  res.json(c);
});

app.delete('/api/circles/:id', (req, res) => {
  circle.deleteCircle(db, req.params.id);
  res.json({ ok: true });
});

// NPC
app.get('/api/npcs', (req, res) => {
  const circleId = req.query.circleId ? parseInt(req.query.circleId, 10) : null;
  res.json(circle.listNpcs(db, circleId));
});

app.get('/api/npcs/:id', (req, res) => {
  const npc = circle.getNpc(db, req.params.id);
  if (!npc) return res.status(404).json({ error: 'NPC不存在' });
  res.json(npc);
});

app.post('/api/npcs', (req, res) => {
  const data = req.body || {};
  const npc = circle.createNpc(db, data);
  res.json(npc);
});

app.put('/api/npcs/:id', (req, res) => {
  const data = req.body || {};
  const npc = circle.updateNpc(db, req.params.id, data);
  if (!npc) return res.status(404).json({ error: 'NPC不存在' });
  res.json(npc);
});

app.delete('/api/npcs/:id', (req, res) => {
  circle.deleteNpc(db, req.params.id);
  res.json({ ok: true });
});

app.post('/api/npcs/:id/move', (req, res) => {
  const circleId = req.body?.circleId ? parseInt(req.body.circleId, 10) : null;
  const npc = circle.moveNpcToCircle(db, req.params.id, circleId);
  if (!npc) return res.status(404).json({ error: 'NPC不存在' });
  res.json(npc);
});

// NPC朋友圈
app.get('/api/npcs/:id/moments', (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json(circle.getNpcMoments(db, req.params.id, { limit, offset }));
});

app.post('/api/npcs/:id/moments', (req, res) => {
  const data = { ...req.body, npc_id: parseInt(req.params.id, 10) };
  const moment = circle.createNpcMoment(db, data);
  if (!moment) return res.status(404).json({ error: 'NPC不存在' });
  res.json(moment);
});

app.delete('/api/npcs/:npcId/moments/:momentId', (req, res) => {
  circle.deleteNpcMoment(db, req.params.momentId);
  res.json({ ok: true });
});

app.post('/api/npcs/:npcId/moments/:momentId/like', (req, res) => {
  const likerName = req.body?.likerName || '用户';
  const moment = circle.likeNpcMoment(db, req.params.momentId, likerName);
  if (!moment) return res.status(404).json({ error: '动态不存在' });
  res.json(moment);
});

app.post('/api/npcs/:npcId/moments/:momentId/unlike', (req, res) => {
  const likerName = req.body?.likerName || '用户';
  const moment = circle.unlikeNpcMoment(db, req.params.momentId, likerName);
  if (!moment) return res.status(404).json({ error: '动态不存在' });
  res.json(moment);
});

app.post('/api/npcs/:npcId/moments/:momentId/comments', (req, res) => {
  const comment = req.body || {};
  const c = circle.commentNpcMoment(db, req.params.momentId, comment);
  if (!c) return res.status(404).json({ error: '动态不存在' });
  res.json(c);
});

app.get('/api/npcs/:npcId/moments/:momentId/comments', (req, res) => {
  res.json(circle.getNpcMomentComments(db, req.params.momentId));
});

// NPC-角色朋友圈互动
app.post('/api/npcs/:id/comment-char-moment', (req, res) => {
  const data = { ...req.body, npc_id: parseInt(req.params.id, 10) };
  const result = circle.npcCommentCharMoment(db, data);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/npcs/:npcId/comment-npc-moment', (req, res) => {
  const result = circle.charCommentNpcMoment(db, req.body || {});
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// NPC通讯录
app.get('/api/npcs/:id/friends', (req, res) => {
  res.json(circle.listNpcFriends(db, req.params.id));
});

app.get('/api/npcs/:id/addable-friends', (req, res) => {
  res.json(circle.listAddableFriends(db, req.params.id));
});

app.post('/api/npcs/:id/friends', (req, res) => {
  const { friendType, friendId } = req.body || {};
  const result = circle.addNpcFriend(db, req.params.id, friendType, friendId);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.delete('/api/npcs/:npcId/friends/:friendType/:friendId', (req, res) => {
  circle.removeNpcFriend(db, req.params.npcId, req.params.friendType, parseInt(req.params.friendId, 10));
  res.json({ ok: true });
});

app.put('/api/npcs/:npcId/friends/:friendType/:friendId/remark', (req, res) => {
  const remark = req.body?.remark || '';
  circle.setNpcFriendRemark(db, req.params.npcId, req.params.friendType, parseInt(req.params.friendId, 10), remark);
  res.json({ ok: true });
});

// ===== 通讯好友 =====
app.get('/api/contacts/friends', (req, res) => {
  res.json(contacts.listFriendCharacters(db).map((c) => withPresentLocation({
    ...c,
    image_ref: normalizeImageRefGroups(c.image_ref || '[]'),
  })));
});

app.get('/api/contacts/addable', (req, res) => {
  res.json(contacts.listAddableCharacters(db));
});

app.get('/api/contacts/requests', (req, res) => {
  res.json({
    requests: contacts.listFriendRequests(db),
    pendingCount: contacts.countPendingFriendRequests(db),
  });
});

app.post('/api/contacts/:id/remark', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(id);
  if (!char) return res.status(404).json({ error: 'Not found' });
  const row = contacts.setRemark(db, id, req.body?.remark || '');
  res.json({ ok: true, remark: row?.remark || '', display_name: contacts.displayName(
    db.prepare('SELECT * FROM characters WHERE id=?').get(id), row
  ) });
});

app.post('/api/contacts/:id/add', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = contacts.addFriend(db, id);
  if (!row) return res.status(404).json({ error: '角色不存在' });
  res.json({ ok: true, contact: row });
});

app.post('/api/contacts/:id/block', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT id FROM characters WHERE id=?').get(id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ ok: true, contact: contacts.setContactStatus(db, id, contacts.STATUS.BLOCKED) });
});

app.post('/api/contacts/:id/delete-friend', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT id FROM characters WHERE id=?').get(id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const wipeTraces = !!(req.body?.wipeTraces ?? req.body?.wipe);
  let wipe = null;
  if (wipeTraces) {
    wipe = contacts.wipeCharacterTraces(db, id);
  }
  const contact = contacts.setContactStatus(db, id, contacts.STATUS.DELETED);
  res.json({ ok: true, contact, wiped: wipe?.wiped || [] });
});

app.post('/api/contacts/:id/unblock', (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json({ ok: true, contact: contacts.setContactStatus(db, id, contacts.STATUS.FRIEND) });
});

app.post('/api/contacts/requests/:id/respond', (req, res) => {
  const accept = !!(req.body?.accept ?? req.body?.accepted);
  const row = contacts.respondFriendRequest(db, parseInt(req.params.id, 10), accept);
  if (!row) return res.status(404).json({ error: '申请不存在或已处理' });
  res.json({ ok: true, request: row });
});

/** 用户向角色发起好友申请（摇一摇陌生人等）；角色异步决定 */
app.post('/api/contacts/requests', (req, res) => {
  const characterId = parseInt(req.body?.characterId ?? req.body?.id, 10);
  if (!characterId) return res.status(400).json({ error: '缺少 characterId' });
  const message = String(req.body?.message || '我想加你为好友').trim().slice(0, 120);
  const result = contacts.requestFriendFromUser(db, characterId, message);
  if (!result.ok) return res.status(400).json({ error: result.error || '无法发起申请' });
  try {
    const shake = require('./shake-helper');
    if (!result.already) shake.enqueueFriendDecideJob(db, characterId, result.requestId);
  } catch (e) {
    console.warn('[shake] enqueue decide', e.message);
  }
  res.json({ ok: true, requestId: result.requestId, already: !!result.already });
});

/** 摇一摇：生成陌生人角色并设为 stranger，可直接聊天 */
app.post('/api/shake/meet', async (req, res) => {
  try {
    const shake = require('./shake-helper');
    const { character } = await shake.createShakeMeet(db, {
      callChatAPIComplete,
      getSettings,
    });
    res.json({ ok: true, character });
  } catch (e) {
    console.warn('[shake] meet', e.message);
    res.status(500).json({ error: e.message || '摇一摇失败' });
  }
});

// 导出角色卡（不含聊天记录）
app.get('/api/characters/:id/export-card', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const wbIds = JSON.parse(c.worldbook_ids || '[]');
  let worldbookEntries = [];
  if (wbIds.length) {
    worldbookEntries = db.prepare(
      `SELECT title, content, weight, enabled FROM worldbook WHERE id IN (${wbIds.map(() => '?').join(',')})`
    ).all(...wbIds);
  }
  const { id, created_at, status, ...charData } = c;
  let nicknames = { toChar: [], toUser: [] };
  try {
    nicknames = require('./nickname-helper').normalizeNicknames(c.nicknames);
  } catch {}
  let traits = [];
  try {
    traits = require('./char-trait-helper').listTraits(c.id);
  } catch {}
  res.json({
    type: 'nian_character_card',
    version: '1.1',
    exported_at: new Date().toISOString(),
    character: {
      ...charData,
      worldbook_ids: [],
      image_ref: normalizeImageRefGroups(c.image_ref || '[]'),
      mutual_characters: JSON.parse(c.mutual_characters || '[]'),
      nsfw_tags: JSON.parse(c.nsfw_tags || '[]'),
      emoji_categories: JSON.parse(c.emoji_categories || '[]'),
      memory_weights: JSON.parse(c.memory_weights || '{}'),
      nicknames,
      vocal_clips: require('./vocal-clips-helper').parseVocalClips(c.vocal_clips),
    },
    worldbook_entries: worldbookEntries,
    char_traits: traits.map(({ content, category, keywords, enabled }) => ({
      content, category, keywords, enabled: enabled !== false,
    })),
  });
});

// 导入角色卡
app.post('/api/characters/import-card', (req, res) => {
  const data = req.body;
  if (data.type !== 'nian_character_card' || !data.character) {
    return res.status(400).json({ error: '无效的角色卡格式' });
  }
  const d = data.character;
  const wbEntries = data.worldbook_entries || [];
  const newWbIds = [];
  for (const entry of wbEntries) {
    const existing = db.prepare('SELECT id FROM worldbook WHERE title=?').get(entry.title);
    if (existing) {
      newWbIds.push(existing.id);
    } else {
      const r = db.prepare('INSERT INTO worldbook (title, content, weight, enabled) VALUES (?,?,?,?)').run(
        entry.title, entry.content, entry.weight || 3, entry.enabled !== 0 ? 1 : 0
      );
      newWbIds.push(r.lastInsertRowid);
    }
  }
  const description = [
    d.personality && `【性格】${d.personality}`,
    d.background && `【背景】${d.background}`,
    d.behavior && `【行为模式】${d.behavior}`,
  ].filter(Boolean).join('\n') || d.description || '';
  const mutualChars = Array.isArray(d.mutual_characters)
    ? d.mutual_characters
    : (() => { try { return JSON.parse(d.mutual_characters || '[]'); } catch { return []; } })();
  const r = db.prepare(`INSERT INTO characters (name,avatar,intro,opening,language_style,location_name,real_location,description,personality,background,behavior,relationship,relationship_custom,voice_id,voice_messages,memory_trigger_n,memory_summary_enabled,busy_style,allow_diary,post_moments,mutual_characters,image_ref,image_style,nsfw_enabled,nsfw_tags,nsfw_note,dream_affects_memory,birthday,anniversary,status,emoji_categories,memory_weights,worldbook_ids,proactive_msg_enabled,proactive_msg_minutes,proactive_call_enabled,emoji_enabled,diary_bg) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    d.name || '导入角色', d.avatar || '', d.intro || '', d.opening || '', d.language_style || '',
    d.location_name || '', d.real_location || '', description,
    d.personality || '', d.background || '', d.behavior || '',
    d.relationship || '', d.relationship_custom || '',
    d.voice_id || '', d.voice_messages ? 1 : 0, d.memory_trigger_n || 10, (d.memory_summary_enabled === 0 || d.memory_summary_enabled === '0') ? 0 : 1,
    d.busy_style || 'gentle', d.allow_diary ? 1 : 0, d.post_moments !== 0 ? 1 : 0,
    JSON.stringify(mutualChars || []), JSON.stringify(normalizeImageRefGroups(d.image_ref || {})), d.image_style || 'anime',
    d.nsfw_enabled === 0 || d.nsfw_enabled === '0' ? 0 : 1, JSON.stringify(d.nsfw_tags || []), d.nsfw_note || '',
    d.dream_affects_memory ? 1 : 0, d.birthday || '', d.anniversary || '', 'online',
    JSON.stringify(d.emoji_categories || []), JSON.stringify(d.memory_weights || '{}'),
    JSON.stringify(newWbIds),
    d.proactive_msg_enabled ? 1 : 0, d.proactive_msg_minutes || 60, d.proactive_call_enabled ? 1 : 0,
    d.emoji_enabled !== undefined ? (d.emoji_enabled ? 1 : 0) : 1,
    String(d.diary_bg || 'default')
  );
  try { contacts.ensureContactRow(db, r.lastInsertRowid, contacts.STATUS.FRIEND); } catch {}
  if (d.emoji_freq !== undefined) {
    try {
      const freq = Math.max(0, Math.min(100, parseInt(d.emoji_freq, 10) || 0));
      db.prepare('UPDATE characters SET emoji_freq=? WHERE id=?').run(freq, r.lastInsertRowid);
    } catch {}
  }
  if (d.moments_cover !== undefined) {
    try {
      db.prepare('UPDATE characters SET moments_cover=? WHERE id=?')
        .run(String(d.moments_cover || ''), r.lastInsertRowid);
    } catch {}
  }
  if (d.nicknames) {
    try {
      const { nicknamesToJson } = require('./nickname-helper');
      db.prepare('UPDATE characters SET nicknames=? WHERE id=?')
        .run(nicknamesToJson(d.nicknames), r.lastInsertRowid);
    } catch {}
  }
  try {
    const emotionStyle = d.emotion_style != null ? String(d.emotion_style || '') : '';
    const chatRounds = Math.max(3, Math.min(50, parseInt(d.chat_context_rounds, 10) || 18));
    const memKeywords = d.memory_keywords != null ? String(d.memory_keywords || '') : '';
    const imageAspect = normalizeSelfieAspect(d.image_aspect || '3:4');
    const videoAspect = normalizeSelfieAspect(d.video_aspect || d.image_aspect || '9:16');
    const selfieStylePrompt = d.selfie_style_prompt != null ? String(d.selfie_style_prompt || '') : '';
    const homeEnvironment = d.home_environment != null ? String(d.home_environment || '') : '';
    const videoMotionPrompt = d.video_motion_prompt != null ? String(d.video_motion_prompt || '') : '';
    const diaryEnabled = d.diary_enabled === 0 || d.diary_enabled === '0' || d.diary_enabled === false ? 0 : 1;
    const scheduleEnabled = d.schedule_enabled === 0 || d.schedule_enabled === '0' || d.schedule_enabled === false ? 0 : 1;
    const naturalChat = d.natural_chat_mode ? 1 : 0;
    const timeAware = d.time_aware_enabled === 0 || d.time_aware_enabled === '0' || d.time_aware_enabled === false ? 0 : 1;
    const houseTz = String(getSettings()?.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
    const timezone = String(d.timezone || houseTz).trim() || houseTz;
    const callDays = Math.max(1, Math.min(30, parseInt(d.proactive_call_interval_days, 10) || 7));
    db.prepare(`UPDATE characters SET emotion_style=?, chat_context_rounds=?, memory_keywords=?, image_aspect=?, video_aspect=?, selfie_style_prompt=?, home_environment=?, video_motion_prompt=?, diary_enabled=?, schedule_enabled=?, natural_chat_mode=?, time_aware_enabled=?, timezone=?, proactive_call_interval_days=?, home_address=?, real_home_address=? WHERE id=?`)
      .run(
        emotionStyle, chatRounds, memKeywords, imageAspect, videoAspect, selfieStylePrompt, homeEnvironment, videoMotionPrompt,
        diaryEnabled, scheduleEnabled, naturalChat, timeAware, timezone, callDays,
        String(d.home_address || ''), String(d.real_home_address || ''),
        r.lastInsertRowid
      );
  } catch {}
  if (d.home_refs !== undefined) {
    try {
      db.prepare('UPDATE characters SET home_refs=? WHERE id=?')
        .run(homeRefsToJson(d.home_refs), r.lastInsertRowid);
    } catch {}
  }
  if (d.vocal_clips !== undefined) {
    try {
      const { vocalClipsToJson } = require('./vocal-clips-helper');
      db.prepare('UPDATE characters SET vocal_clips=? WHERE id=?')
        .run(vocalClipsToJson(d.vocal_clips), r.lastInsertRowid);
    } catch {}
  }
  if (d.voice_id_nsfw !== undefined) {
    try {
      const { trimVoiceId } = require('./voice-lane-helper');
      db.prepare('UPDATE characters SET voice_id_nsfw=? WHERE id=?')
        .run(trimVoiceId(d.voice_id_nsfw), r.lastInsertRowid);
    } catch {}
  }
  if (d.call_video !== undefined) {
    try {
      db.prepare('UPDATE characters SET call_video=? WHERE id=?')
        .run(String(d.call_video || '').trim(), r.lastInsertRowid);
    } catch {}
  }
  if (d.call_video_mode !== undefined) {
    try {
      const mode = String(d.call_video_mode || '').trim().toLowerCase() === 'text' ? 'text' : 'video';
      db.prepare('UPDATE characters SET call_video_mode=? WHERE id=?')
        .run(mode, r.lastInsertRowid);
    } catch {}
  }
  if (d.chat_model !== undefined) {
    try {
      db.prepare('UPDATE characters SET chat_model=? WHERE id=?')
        .run(String(d.chat_model || '').trim(), r.lastInsertRowid);
    } catch {}
  }
  if (d.group_talkativeness !== undefined) {
    try {
      const talk = require('./group-chat-helper').normalizeTalk(d.group_talkativeness);
      db.prepare('UPDATE characters SET group_talkativeness=? WHERE id=?')
        .run(talk, r.lastInsertRowid);
    } catch {}
  }
  if (d.music_preference !== undefined) {
    try {
      db.prepare('UPDATE characters SET music_preference=? WHERE id=?')
        .run(String(d.music_preference || ''), r.lastInsertRowid);
    } catch {}
  }
  if (d.music_score_enabled !== undefined) {
    try {
      db.prepare('UPDATE characters SET music_score_enabled=? WHERE id=?')
        .run(d.music_score_enabled ? 1 : 0, r.lastInsertRowid);
    } catch {}
  }
  if (Array.isArray(data.char_traits) && data.char_traits.length) {
    try {
      require('./char-trait-helper').replaceTraits(r.lastInsertRowid, data.char_traits);
    } catch {}
  }
  res.json({ id: r.lastInsertRowid, name: d.name });
});

app.get('/api/characters/:id/daily-status', (req, res) => {
  const char = db.prepare('SELECT location_name, real_location, status, intro FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Not found' });
  const ctx = db.prepare(
    `SELECT content FROM daily_context WHERE character_id=? AND date=date('now','localtime') ORDER BY id DESC LIMIT 1`
  ).get(req.params.id);
  res.json({
    location: char.location_name || char.real_location || '',
    activity: ctx?.content || '',
    status: char.status || 'online',
    intro: char.intro || '',
  });
});

// 粗估文本 token 数：中日韩文字按约 1.6 token/字，其余按约 4 字符/token（英文单词平均长度）
// 不接第三方分词库，只是给用户一个大致数量级参考，不追求跟具体模型 tokenizer 完全一致
function estimateTokenCount(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0, other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0;
    const isCjk = (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff);
    if (isCjk) cjk++; else other++;
  }
  return Math.ceil(cjk * 1.6 + other / 4);
}

function estimateMessageContentTokens(content) {
  if (typeof content === 'string') return estimateTokenCount(content);
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (part?.type === 'image_url') return sum + 800; // 单张图片视觉 token 粗估
      if (typeof part?.text === 'string') return sum + estimateTokenCount(part.text);
      return sum;
    }, 0);
  }
  return 0;
}

// 当前角色实际会发给聊天 API 的上下文（系统提示 + 历史消息）大致 token 数，
// 用于通讯设置里给用户一个参考，不是精确计费口径
app.get('/api/characters/:id/context-tokens', (req, res) => {
  try {
    const characterId = parseInt(req.params.id, 10);
    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    const settings = getSettings();
    const isDreamMode = req.query.dream === '1';
    const history = loadRecentChatHistory(characterId, isDreamMode, char, settings);
    const { liveHistory } = resolveChatSession(history, isDreamMode, '');
    const reqBase = `${req.protocol}://${req.get('host')}`;
    const systemPrompt = buildSystemPrompt(char, settings, '', { isDream: isDreamMode, recentHistory: liveHistory });
    const apiHistory = buildHistoryApiMessages(liveHistory, reqBase, {});
    const systemPromptTokens = estimateTokenCount(systemPrompt);
    const historyTokens = apiHistory.reduce((sum, m) => sum + estimateMessageContentTokens(m.content), 0);
    res.json({
      tokens: systemPromptTokens + historyTokens,
      systemPromptTokens,
      historyTokens,
      messageCount: apiHistory.length,
      approx: true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== MESSAGES =====
app.post('/api/messages/:charId/import', (req, res) => {
  const { charId } = req.params;
  const body = req.body || {};
  const dreamFlag = body.is_dream ? 1 : 0;
  const list = Array.isArray(body.messages)
    ? body.messages
    : (body.role && body.content != null ? [body] : []);
  if (!list.length) return res.status(400).json({ error: 'role and content required' });

  const insert = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,1)`
  );
  const saved = [];
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const content = row?.content;
      if (row?.role == null || content == null || content === '') continue;
      const rawRole = String(row.role || '').toLowerCase();
      const validRole = rawRole === 'user' ? 'user' : (rawRole === 'system' ? 'system' : 'assistant');
      const type = row.type || (validRole === 'system' ? 'system' : 'text');
      const ts = row.timestamp && !Number.isNaN(Date.parse(row.timestamp))
        ? new Date(row.timestamp).toISOString()
        : new Date().toISOString();
      const r = insert.run(charId, validRole, String(content), type, ts, dreamFlag);
      saved.push({
        id: r.lastInsertRowid,
        character_id: Number(charId),
        role: validRole,
        content: String(content),
        type,
        timestamp: ts,
        is_dream: dreamFlag,
        is_read: 1,
      });
    }
  });
  tx(list);
  if (Array.isArray(body.messages)) {
    return res.json({ ok: true, imported: saved.length, messages: saved });
  }
  if (!saved.length) return res.status(400).json({ error: 'role and content required' });
  res.json({ id: saved[0].id, message: saved[0] });
});

app.get('/api/messages/:charId', (req, res) => {
  const { charId } = req.params;
  const { dream = 0, limit = 50, offset = 0, sinceId, beforeId, aroundId } = req.query;
  const dreamFlag = parseInt(dream, 10) || 0;
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const after = parseInt(sinceId, 10) || 0;
  const before = parseInt(beforeId, 10) || 0;
  const around = parseInt(aroundId, 10) || 0;

  if (around > 0) {
    const beforeLim = Math.min(Math.max(Math.ceil(lim * 0.6), 1), lim);
    const afterLim = Math.max(lim - beforeLim, 0);
    const older = db.prepare(
      `SELECT * FROM messages WHERE character_id=? AND is_dream=? AND id<=? ORDER BY id DESC LIMIT ?`
    ).all(charId, dreamFlag, around, beforeLim);
    const newer = afterLim
      ? db.prepare(
          `SELECT * FROM messages WHERE character_id=? AND is_dream=? AND id>? ORDER BY id ASC LIMIT ?`
        ).all(charId, dreamFlag, around, afterLim)
      : [];
    return res.json([...older.reverse(), ...newer].map(enrichMessageMediaFields));
  }

  if (after > 0) {
    const msgs = db.prepare(
      `SELECT * FROM messages WHERE character_id=? AND is_dream=? AND id>? ORDER BY id ASC LIMIT ?`
    ).all(charId, dreamFlag, after, lim);
    return res.json(msgs.map(enrichMessageMediaFields));
  }
  if (before > 0) {
    const msgs = db.prepare(
      `SELECT * FROM messages WHERE character_id=? AND is_dream=? AND id<? ORDER BY id DESC LIMIT ?`
    ).all(charId, dreamFlag, before, lim);
    return res.json(msgs.reverse().map(enrichMessageMediaFields));
  }

  const msgs = db.prepare(
    `SELECT * FROM messages WHERE character_id=? AND is_dream=? ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(charId, dreamFlag, lim, parseInt(offset, 10) || 0);
  res.json(msgs.reverse().map(enrichMessageMediaFields));
});

app.get('/api/store-policy', (req, res) => {
  try {
    res.json(require('./vps-store-policy').getStoreStatus());
  } catch (e) {
    res.status(500).json({ error: e.message || 'store policy' });
  }
});

app.get('/api/messages/:charId/bounds', (req, res) => {
  try {
    res.json(require('./vps-store-policy').getMessageBounds(req.params.charId, req.query.dream));
  } catch (e) {
    res.status(500).json({ error: e.message || 'bounds' });
  }
});

app.post('/api/messages/archive-ack', (req, res) => {
  const { characterId, charId, dream = 0, upToId } = req.body || {};
  const id = characterId || charId;
  const result = require('./vps-store-policy').mergeArchiveAck(id, dream, upToId);
  if (!result.ok) return res.status(400).json({ error: result.error || 'ack failed' });
  res.json(result);
});

app.get('/api/messages/:charId/search', (req, res) => {
  const { charId } = req.params;
  const { q = '', date = '', dream = 0, limit = 50 } = req.query;
  const char = db.prepare('SELECT timezone FROM characters WHERE id=?').get(charId);
  const tz = char?.timezone || getSettings()?.timezone || 'Asia/Shanghai';
  const msgs = require('./chat-recall-helper').searchCharacterMessages(charId, {
    q,
    date,
    dream,
    limit,
    tz,
  });
  res.json(msgs);
});

// 首次聊天：角色主动打招呼（无历史消息时）
app.post('/api/messages/greet', async (req, res) => {
  const { characterId, isDream = false } = req.body;
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const count = db.prepare(
    `SELECT COUNT(*) as c FROM messages WHERE character_id=? AND is_dream=?`
  ).get(characterId, isDream ? 1 : 0).c;
  if (count > 0) return res.json({ skipped: true });

  const endpoint = (settings.chat_api_url || '').trim();
  if (!endpoint) return res.json({ skipped: true, reason: 'no_api' });

  const systemPrompt = buildSystemPrompt(char, settings,
    `这是你和用户第一次通过「念」联系。请以${char.name}的身份自然打招呼，1～2句短消息，符合性格与当前时间，像真人发微信一样。\n不要解释设定，不要提及AI或扮演。若有连续两句，用空行分隔。只输出消息正文。`
  );

  try {
    const chatBody = JSON.stringify({
      model: settings.chat_model || 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: '[用户打开了聊天窗口]' }],
      temperature: parseFloat(settings.chat_temperature || '0.8'),
      max_tokens: 200,
      stream: false,
    });
    const chatHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.chat_api_key}`,
    };
    const baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
    async function tryGreet(url) {
      const r = await fetchWithTimeout(`${url}/chat/completions`, {
        method: 'POST', headers: chatHeaders, body: chatBody, timeout: 60000,
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('non-json');
      return r.json();
    }
    let data;
    try { data = await tryGreet(baseUrl); }
    catch (e1) {
      if (!baseUrl.endsWith('/v1')) data = await tryGreet(baseUrl + '/v1');
      else throw e1;
    }

    const aiContent = data.choices?.[0]?.message?.content?.trim();
    if (!aiContent) return res.json({ skipped: true });

    const segments = aiContent.split(/\n{2,}/).map(s => stripAiContextLabels(s.trim())).filter(Boolean);
    const msgIds = [];
    const now = new Date().toISOString();
    for (const seg of segments.slice(0, 2)) {
      const id = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
      ).run(characterId, 'assistant', seg, 'text', now, isDream ? 1 : 0).lastInsertRowid;
      msgIds.push(id);
    }
    res.json({ ok: true, messages: segments.slice(0, 2).map((content, i) => ({ id: msgIds[i], content, role: 'assistant', type: 'text', timestamp: now })) });
  } catch (err) {
    console.error('[greet] error:', err.message);
    res.json({ skipped: true, error: err.message });
  }
});

app.post('/api/messages/send', async (req, res) => {
  const {
    characterId, content, type = 'text', location, isDream = false, isVoiceCall = false, isVideoCall = false, noReply = false,
    dreamMask = false, dreamStyle = '', dreamConfig = null, dreamMode = '',
    replyToId: replyToIdRaw = null, replyPreview = '',
    lat, lng,
    callPresenceMode = '',
    callInputMode = '',
    callHangoutWakeStep = 0,
    callHangoutSleeping = false,
    hideChat = false,
    source = '',
  } = req.body;
  const replyToId = normalizeReplyToId(replyToIdRaw);
  const isDreamMode = isDream === true || isDream === 1 || isDream === '1';
  const isVoiceMode = isVoiceCall === true || isVoiceCall === 1 || isVoiceCall === '1';
  const isVideoMode = isVoiceMode && (isVideoCall === true || isVideoCall === 1 || isVideoCall === '1');
  const fromOverlay = String(source || '').toLowerCase() === 'overlay';
  const hasDreamMask = dreamMask === true || dreamMask === 1 || dreamMask === '1';
  const dreamCfg = dreamHelper.normalizeDreamConfig(dreamConfig || {
    mask: hasDreamMask,
    freedom: dreamMode === 'expand_user' ? 'semi' : undefined,
  });
  if (hasDreamMask) dreamCfg.mask = true;
  let settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  settings = withCharChatPrefs(settings, char);

  let userContent = content;
  let expandMeta = null;
  // 半自由：短意图 → 扩写成用户侧正文再入库
  if (isDreamMode && dreamMode === 'expand_user') {
    try {
      const expandPrompt = dreamHelper.buildExpandUserPrompt(content, dreamCfg);
      const styleText = dreamHelper.resolveDreamStyleText(dreamStyle || dreamCfg);
      const sys = dreamHelper.buildDreamExtraSystemPrompt({
        dreamMask: dreamCfg.mask, dreamStyle: styleText, dreamConfig: dreamCfg, freedom: 'semi',
      });
      let expanded = await callChatAPIComplete(settings, sys, expandPrompt, 'dream');
      if (!expanded) expanded = await callChatAPIComplete(settings, sys, expandPrompt, 'chat');
      userContent = dreamHelper.formatDreamProse(expanded || String(content || '').trim());
      if (!userContent) return res.status(500).json({ error: '扩写失败，请重试' });
      expandMeta = { cue: String(content || '').trim(), expanded: userContent };
    } catch (e) {
      return res.status(500).json({ error: formatApiBillingError(e.message) || e.message || '扩写失败' });
    }
  } else if (isDreamMode) {
    userContent = dreamHelper.formatDreamProse(content);
  }

  // 音乐链接解析：检测并enrichMessage
  let musicEnrichment = null;
  if (!isDreamMode && type === 'text') {
    try {
      const musicLinkHelper = require('./music-link-helper');
      musicEnrichment = await musicLinkHelper.enrichMessageWithMusic(
        { content: userContent },
        characterId
      );
    } catch (e) {
      console.warn('[music-link] enrich failed', e.message);
    }
  }

  // 音乐同步模式：检测track变化
  let musicSyncComment = null;
  if (type === 'music_sync_track' && !isDreamMode) {
    try {
      const musicSyncLogic = require('./music-sync-logic');
      const trackData = JSON.parse(userContent || '{}');
      
      // 获取角色音乐偏好
      const preference = (() => {
        try {
          return char.music_preference ? JSON.parse(char.music_preference) : {};
        } catch {
          return {};
        }
      })();
      
      // 获取同步上下文（最近评论记录等）
      const syncContext = db.prepare(
        `SELECT metadata FROM messages WHERE character_id=? AND type='music_sync_context' ORDER BY id DESC LIMIT 1`
      ).get(characterId);
      
      const context = syncContext?.metadata ? JSON.parse(syncContext.metadata) : {
        songIndex: 0,
        lastCommentIndex: -1,
        lastCommentTime: null,
        recentGenres: [],
        recentMoods: []
      };
      
      context.songIndex = trackData.songIndex || 0;
      
      // 检测风格和情绪
      const genre = musicSyncLogic.detectGenre(trackData);
      const mood = musicSyncLogic.detectMood(trackData);
      context.recentGenres.unshift(genre);
      context.recentGenres = context.recentGenres.slice(0, 5);
      context.recentMoods.unshift(mood);
      context.recentMoods = context.recentMoods.slice(0, 5);
      context.characterMusicPreference = preference;
      
      // 决策是否评论
      const decision = musicSyncLogic.shouldCommentOnTrack(trackData, context);
      
      if (decision.should) {
        const commentType = musicSyncLogic.selectCommentType(decision.reason);
        const prompt = musicSyncLogic.buildMusicCommentPrompt(trackData, decision.reason, commentType, preference);
        
        musicSyncComment = {
          shouldComment: true,
          aiContext: prompt,
          commentType,
          reason: decision.reason,
          trackInfo: trackData
        };
        
        // 更新上下文
        context.lastCommentIndex = context.songIndex;
        context.lastCommentTime = Date.now();
      }
      
      // 保存同步上下文
      db.prepare(
        `INSERT INTO messages (character_id, role, content, type, timestamp, metadata) VALUES (?,?,?,?,?,?)`
      ).run(characterId, 'system', '', 'music_sync_context', now, JSON.stringify(context));
      
    } catch (e) {
      console.warn('[music-sync] logic failed', e.message);
    }
  }

  const now = new Date().toISOString();
  const userDelivery = !isDreamMode ? contacts.userDeliveryStatus(db, characterId) : 'sent';
  const userMsgId = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, timestamp, location, is_dream, reply_to_id, reply_preview, delivery_status) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(characterId, 'user', userContent, type, now, location || '', isDreamMode ? 1 : 0, replyToId || null, replyPreview || '', userDelivery).lastInsertRowid;

  if (type === 'location') {
    try {
      const locHelper = require('./location-weather-helper');
      locHelper.attachLocationCoords(userMsgId, userContent, char, lat, lng).catch(() => {});
    } catch {}
  }

  if (type === 'voice' && !isDreamMode) {
    try {
      const attached = await voiceprintHelper.ensureVoiceprintOnContent(
        userContent, getSettings, setSetting, UPLOADS_PATH
      );
      if (attached.changed) {
        userContent = attached.content;
        db.prepare('UPDATE messages SET content=? WHERE id=?').run(userContent, userMsgId);
      }
    } catch (e) {
      console.warn('[voiceprint] attach on send', e.message);
    }
  }

  const forTheaterMode = !isDreamMode && !isVoiceMode && isTheaterActive(char);
  if (forTheaterMode && type !== 'system') {
    mergeMessageMediaMeta(userMsgId, { theater: 1 });
  }
  if (hideChat === true || hideChat === 1 || hideChat === '1') {
    mergeMessageMediaMeta(userMsgId, { hideChat: 1, emptyNudge: 1 });
  }

  // Build context：按用户轮数取近窗，系统气泡不占配额
  const history = loadRecentChatHistory(characterId, isDreamMode, char, settings);

  // noReply: 只保存消息到上下文，不触发 AI 回复（聊天页先入库再走 trigger-ai）
  if (noReply) {
    if (!isDreamMode && !forTheaterMode && type !== 'system') {
      try {
        const reqBase = `${req.protocol}://${req.get('host')}`;
        const userAskedTool = await tryStartUserAskedRobotTool({
          char, settings, userText: userContent, publicBase: reqBase,
        });
        if (userAskedTool?.defer) {
          return res.json({
            userMsgId,
            content: '',
            noReply: true,
            delivery_status: userDelivery,
            theaterActive: forTheaterMode,
            robotInvoke: true,
            robotLooking: true,
          });
        }
      } catch (e) {
        console.warn('[chat] user ask look (noReply)', e.message);
      }
    }
    return res.json({ userMsgId, content: '', noReply: true, delivery_status: userDelivery, theaterActive: forTheaterMode });
  }

  // 角色已删除用户：不再生成回复
  if (!isDreamMode && contacts.getPeerStatus(db, characterId) === contacts.PEER.DELETED) {
    return res.json({
      userMsgId,
      content: '',
      delivery_status: userDelivery,
      peerStatus: 'deleted',
      peerHint: '对方已把你删除，可在联系人中重新添加',
    });
  }

  if (!isDreamMode) {
    if (messageTriggersMemoryKeyword(content, char)) {
      maybeTriggerMemorySummary(characterId, { keywordTriggered: true, userMsgId });
    } else if (messageIndicatesSalientEmotion(content)) {
      maybeCaptureSalientFromMessage(characterId, userMsgId, {});
    } else if (messageIndicatesSalientPlan(content)) {
      maybeTriggerMemorySummary(characterId, { userMsgId });
    } else if (messageIndicatesUserProfileShare(content)) {
      maybeCaptureUserImpressionsFromMessage(characterId, userMsgId);
    }
  }

  let extraSystemPrompt = '';
  let robotUserAskAfter = null;
  let robotUserAskDone = null;
  if (isDreamMode) {
    const styleText = (typeof dreamStyle === 'string' && dreamStyle.trim())
      ? dreamStyle.trim()
      : dreamHelper.resolveDreamStyleText(dreamCfg);
    extraSystemPrompt = dreamHelper.buildDreamExtraSystemPrompt({
      dreamMask: dreamCfg.mask,
      dreamStyle: styleText,
      dreamConfig: dreamCfg,
      freedom: dreamCfg.freedom,
    });
  } else if (isVoiceMode) {
    extraSystemPrompt = buildCallExtraSystemPrompt(isVideoMode, history, characterId, {
      presenceMode: callPresenceMode,
      inputMode: callInputMode,
      hangoutWakeStep: callHangoutWakeStep,
      hangoutSleeping: callHangoutSleeping === true || callHangoutSleeping === 1 || callHangoutSleeping === '1',
      callVideoTextMode: isVideoMode && isCharCallVideoTextMode(char),
    });
    if (type === 'system' && /通话开始/.test(String(content || ''))) {
      extraSystemPrompt += '\n刚接通，先开口；可先喂一声再接话，别播音腔。';
    }
    // 通话中每轮都确保有 live 记录，角色写 [挂断] 才能关通话页
    try {
      require('./proactive-outreach-helper').ensureLiveCallLog(db, characterId, {
        video: !!isVideoMode,
        from: 'user',
      });
    } catch (e) {
      console.warn('[call] ensure live log', e.message);
    }
  }

  // 引用上下文：告知AI用户在引用哪条消息、引用的是谁的话
  if (!isDreamMode) {
    const replyCtx = buildQuotedReplyPrompt(characterId, history, { replyToId, replyPreview });
    if (replyCtx) extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${replyCtx}` : replyCtx;
  }

  // 多条待回复消息统计：告知AI用户连续发了多少条消息
  const recentHistory = history.slice(-10);
  const lastAiHistIdx = [...recentHistory].reverse().findIndex(m => m.role === 'assistant');
  const pendingUserMsgCount = lastAiHistIdx === -1
    ? recentHistory.filter(m => m.role === 'user').length
    : lastAiHistIdx;
  if (pendingUserMsgCount >= 3 && !isDreamMode) {
    const hint = `\n[用户连续发了${pendingUserMsgCount}条消息，你可以适当多回复一些，但仍保持聊天节奏，不超过${Math.min(pendingUserMsgCount * 2, 10)}句]`;
    extraSystemPrompt = extraSystemPrompt ? extraSystemPrompt + hint : hint.trim();
  }

  const reqBase = `${req.protocol}://${req.get('host')}`;
  if (!isDreamMode && !forTheaterMode) {
    try {
      const userAskedTool = await tryStartUserAskedRobotTool({
        char, settings, userText: content, publicBase: reqBase,
      });
      if (userAskedTool?.defer) {
        return res.json({
          userMsgId,
          aiMsgId: null,
          content: '',
          aiMessages: [],
          robotInvoke: true,
          robotLooking: true,
          delivery_status: userDelivery,
          peerStatus: contacts.getPeerStatus(db, characterId),
        });
      }
      if (userAskedTool?.invokeAfterReply) {
        robotUserAskAfter = userAskedTool.invokeAfterReply;
      }
      if (userAskedTool?.alreadyInvoked) {
        robotUserAskDone = userAskedTool.intent;
      }
    } catch (e) {
      console.warn('[chat] user ask look', e.message);
    }
  }
  let avatarUpdated = false;
  let avatarUrl = null;
  let pendingAvatar = null;
  if (!isDreamMode) {
    pendingAvatar = detectAvatarChangeIntent(history);
    if (pendingAvatar && pendingAvatar !== char.avatar) {
      const avatarHint = buildAvatarChangeChoiceHint();
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${avatarHint}` : avatarHint;
    } else {
      pendingAvatar = null;
    }
  }

  if (!isDreamMode) {
    const sleepNote = buildSleepContextNote(history, settings);
    if (sleepNote) {
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${sleepNote}` : sleepNote;
    }
    const intentNote = buildStatedIntentElapsedNote(history, settings);
    if (intentNote) {
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${intentNote}` : intentNote;
    }
    const headTouchNote = robotHelper.buildHeadTouchPromptLine();
    if (headTouchNote) {
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${headTouchNote}` : headTouchNote;
    }
    // 行动连贯 / 话题连续已在 buildSystemPrompt 内按 recentHistory 注入，此处勿再重复
    extraSystemPrompt = appendMediaRequestHints(extraSystemPrompt, history, content);
    if (type === 'voice') {
      const vpExtra = voiceprintHelper.voiceprintChatExtra(voiceprintHelper.voiceprintFromContent(userContent));
      if (vpExtra) {
        extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${vpExtra}` : vpExtra;
      }
    }
  }

  if (!isDreamMode) {
    try {
      touchCharacterEmotionFromMessage(characterId, { role: 'user', content });
      const es = db.prepare('SELECT emotion_state FROM characters WHERE id=?').get(characterId);
      if (es) char.emotion_state = es.emotion_state || '';
      try { robotDriveHelper.touchDriveFromUserInteraction(characterId); } catch {}
    } catch (e) {
      console.warn('[emotion] touch user', e.message);
    }
  }

  const { liveHistory, sessionClosed, contextText } = resolveChatSession(history, isDreamMode, content);
  const { timeNote, noteTargetUserId, minutes: userReturnMinutes } = buildReplyTimeNotePayload(
    settings, characterId, isDreamMode, { userMessage: content }
  );
  const promptOpts = {
    isDream: isDreamMode,
    forTheater: forTheaterMode,
    forVoiceCall: isVoiceMode,
    forVideoCall: isVideoMode,
    forVideoCallText: isVideoMode && isCharCallVideoTextMode(char),
    contextText,
    userMessage: content,
    recentHistory: liveHistory,
    sessionClosed,
    enableInlineDirectives: true,
    userAskedCall: (!isDreamMode && !isVoiceMode) ? userRequestsPhoneCall(content) : null,
    fromOverlay,
    userReturnMinutes: userReturnMinutes || 0,
  };
  if (!isDreamMode) {
    try { await prefetchLocationWeather(char, settings, promptOpts); } catch {}
    try {
      const recallBlock = await timelineHelper.prefetchDayRecallForChat(
        characterId, settings, content, promptOpts
      );
      if (recallBlock) {
        extraSystemPrompt = extraSystemPrompt
          ? `${extraSystemPrompt}\n${recallBlock}`
          : recallBlock;
      }
    } catch (e) {
      console.warn('[timeline] chat recall inject failed:', e.message);
    }
  }
  // 用户朋友圈：亲密/暗恋在平常回复里偶尔顺口提一句（不另发主动消息）
  let momentChatCue = null;
  if (!isDreamMode && !forTheaterMode) {
    try {
      momentChatCue = getUserMomentChatCue(char, settings);
      if (momentChatCue?.block) {
        extraSystemPrompt = extraSystemPrompt
          ? `${extraSystemPrompt}\n${momentChatCue.block}`
          : momentChatCue.block;
      }
    } catch (e) {
      console.warn('[moments] chat cue inject failed:', e.message);
    }
  }
  if (!isDreamMode && !promptOpts.forGame) {
    try {
      await applyBrainUnderstanding(char, settings, promptOpts);
    } catch (e) {
      console.warn('[brain] understanding', e.message);
    }
  }
  
  // 音乐链接：将情感化描述注入系统提示
  if (musicEnrichment?.aiContext) {
    extraSystemPrompt = extraSystemPrompt
      ? `${extraSystemPrompt}\n\n${musicEnrichment.aiContext}`
      : musicEnrichment.aiContext;
  }

  const systemPrompt = buildSystemPrompt(char, settings, extraSystemPrompt, promptOpts);

  // Check daily context
  const dailyCtxMatch = content.match(/去(拿|买|做|看|..)|在(做|吃|看|玩|..)|要去|刚/);
  if (dailyCtxMatch) {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO daily_context (character_id, content, date) VALUES (?,?,?)`).run(characterId, content.slice(0, 50), today);
  }

  const apiHistory = buildHistoryApiMessages(liveHistory, reqBase, buildChatHistoryOptions(req, timeNote, noteTargetUserId, settings, isDreamMode));
  if (!apiHistory.length) {
    apiHistory.push(buildHistoryApiMessages(
      [{ id: userMsgId, role: 'user', content, type }],
      reqBase,
      buildChatHistoryOptions(req, timeNote, userMsgId, settings, isDreamMode)
    )[0]);
  }
  // 忙碌自动回复：梦境中不受忙碌状态影响；日常聊天才触发
  const busyHit = resolveBusyAutoReply(char, characterId, isDreamMode, settings);
  if (busyHit) {
    if (busyHit.silent) {
      return res.json({ userMsgId, isBusy: true, silent: true });
    }
    const autoReplyText = busyHit.autoReplyText;
    const autoMsgId = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
    ).run(characterId, 'assistant', autoReplyText, 'text', now, 0).lastInsertRowid;
    broadcastChatMessage(characterId, autoReplyText, [{ id: autoMsgId, type: 'text', content: autoReplyText }], isDreamMode);
    return res.json({
      userMsgId,
      isBusy: true,
      autoReply: autoReplyText,
      aiMsgId: autoMsgId,
    });
  }

  try {
    const { url: endpoint, key: apiKey, model: apiModel } = resolveChatApiSettings(settings, isDreamMode, char);
    if (!endpoint) {
      return res.status(400).json({ error: isDreamMode ? '请先在设置中配置梦境或聊天 API' : '请先在设置中配置API' });
    }
    if (!apiKey) {
      return res.status(400).json({ error: '请先在设置中配置 API Key' });
    }

    const apiMessages = [{ role: 'system', content: systemPrompt }, ...apiHistory];
    const baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;

    // 梦境长文：提高上限，避免句中被硬截断
    const isDreamSummary = isDreamMode && content.includes('梦境结束');
    const maxTokens = isDreamMode && !isDreamSummary
      ? Math.max(3500, parseInt(settings.chat_max_tokens || '1000', 10) || 1000)
      : parseInt(settings.chat_max_tokens || '1000');

    const robotChatTools = await require('./robot-llm-tools').toolsForChat(char, settings, {
      isDream: isDreamMode,
      forTheater: forTheaterMode,
      isVoiceCall: isVoiceMode,
      userMessage: content,
      recentHistory: history,
      fromOverlay,
    });
    const turn = await completeChatTurn({
      url: endpoint,
      apiKey,
      model: apiModel,
      settings,
      messages: apiMessages,
      maxTokens,
      timeout: fromOverlay ? 180000 : 120000,
      tools: robotChatTools,
      characterId: char.id,
    });
    const data = turn.data || { choices: [{ message: turn.message, finish_reason: turn.finishReason }] };
    if (data.choices?.[0] && turn.finishReason) data.choices[0].finish_reason = turn.finishReason;
    let rawAiContent = String(turn.content || '').trim();
    const rawMergedRobot = rawAiContent;
    if (turn.toolCalls?.length) {
      console.log(`[chat] robot tool_calls ${turn.toolCalls.map((c) => c.name).join(',')}`);
    }
    let robotInvokeIntent = null;
    if (!isDreamMode && !forTheaterMode && rawAiContent) {
      const parsedInvoke = robotHelper.parseRobotInvoke(rawAiContent);
      if (parsedInvoke.found) {
        robotInvokeIntent = parsedInvoke.intent;
        rawAiContent = parsedInvoke.textWithout;
        if (parsedInvoke.source === 'intent') {
          console.log(`[chat] robot intent→${robotInvokeIntent} (toolbook)`);
        }
      }
      const mergedFind = robotHelper.preferFindIfUserAsked(robotInvokeIntent, robotUserAskAfter);
      if (mergedFind === 'find' && robotInvokeIntent !== 'find') {
        console.log(`[chat] 用户要找人 → find（角色标记=${robotInvokeIntent || '无'}）`);
        robotInvokeIntent = 'find';
      }
    }
    const rawForCall = rawAiContent;
    const callVideoTextMode = isVoiceMode && isVideoMode && isCharCallVideoTextMode(char);
    let aiContent = normalizeAiReplyText(rawAiContent, isDreamMode, {
      forTheater: forTheaterMode,
      forCallVideoText: callVideoTextMode,
    });
    if (!aiContent && !isDreamMode && !forTheaterMode
        && (robotInvokeIntent || /\[(?:桌宠|舵机|灯光|动作|表情)\s*[:：]/.test(rawMergedRobot))) {
      try {
        if (robotInvokeIntent) {
          await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
            intent: robotInvokeIntent,
            publicBase: reqBase,
            source: 'chat_tag_only',
            rawAi: rawMergedRobot,
          });
        }
        applyPhoneChatToRobot(characterId, char, settings, rawMergedRobot, '', reqBase, content, robotInvokeIntent);
      } catch (e) {
        console.warn('[chat] robot will only', e.message);
      }
      return res.json({
        userMsgId,
        aiMsgId: null,
        content: '',
        aiMessages: [],
        robotInvoke: true,
        delivery_status: userDelivery,
        peerStatus: contacts.getPeerStatus(db, characterId),
      });
    }
    // 角色调用了看一眼：镜头照常开，但这轮已经生成好的话不丢掉。
    // 图回来后会以小机气泡进聊天页，再自动跟一句对画面的反应。
    let robotWillDone = false;
    if (!isDreamMode && !forTheaterMode && robotHelper.isRobotCameraVisionIntent(robotInvokeIntent)) {
      try {
        await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
          intent: robotInvokeIntent,
          publicBase: reqBase,
          source: 'chat_tag',
          rawAi: rawMergedRobot,
        });
        robotWillDone = true;
      } catch (e) {
        console.warn('[chat] robot look', e.message);
      }
    }
    if (!aiContent) {
      return res.json(emptyAiChatPayload({
        userMsgId,
        delivery_status: userDelivery,
        peerStatus: contacts.getPeerStatus(db, characterId),
      }));
    }

    if (!isDreamMode && !forTheaterMode) {
      try {
        const travel = require('./travel-arrive-helper');
        aiContent = travel.stripPrematureArrivalLocation(aiContent, {
          charId: characterId, userMessage: content, history,
        });
        rawAiContent = travel.stripPrematureArrivalLocation(String(rawAiContent || ''), {
          charId: characterId, userMessage: content, history,
        });
      } catch {}
    }

    if (isDreamMode) {
      const done = await completeDreamIfTruncated({
        baseUrl, apiKey, apiModel, settings, systemPrompt, apiHistory,
        aiContent, rawAiContent,
        finishReason: data.choices?.[0]?.finish_reason || '',
        rounds: 3,
      });
      aiContent = done.aiContent;
      rawAiContent = done.rawAiContent;
    } else {
      // 普通聊天：token 截断，或明显说到一半（逗号/虚词收尾）时续写一轮
      const sentenceEnds = /[。！？…!?」』"'～~）)】\n]$/;
      const looksCutMid = !sentenceEnds.test(aiContent) && (
        /[，、；,;：:]$/.test(aiContent)
        || (aiContent.length >= 24 && /[的了着过地得和与及在是把被从向对跟比让给到为以而却又也还但并或]$/.test(aiContent))
      );
      const needsContinue = data.choices?.[0]?.finish_reason === 'length'
        || looksCutMid
        || (data.choices?.[0]?.finish_reason !== 'stop' && !sentenceEnds.test(aiContent) && aiContent.length > 60);
      if (needsContinue) {
        try {
          const continueMessages = [
            { role: 'system', content: `${systemPrompt}\n你上一条被截断了，从断句处接着说完，不要重复已写内容。` },
            ...apiHistory,
            { role: 'assistant', content: aiContent },
            { role: 'user', content: '…' },
          ];
          const contMaxTokens = 600;
          const continueBody = JSON.stringify({
            model: apiModel,
            messages: continueMessages,
            temperature: parseFloat(settings.chat_temperature || '0.8'),
            max_tokens: contMaxTokens,
            stream: false,
          });
          let contData;
          try {
            const r = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
              body: continueBody,
              timeout: 60000,
            });
            if (r.ok) contData = await r.json();
          } catch {}
          if (!contData && !baseUrl.endsWith('/v1')) {
            try {
              const r2 = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: continueBody,
                timeout: 60000,
              });
              if (r2.ok) contData = await r2.json();
            } catch {}
          }
          const cont = contData?.choices?.[0]?.message?.content?.trim();
          if (cont) {
            const contText = normalizeAiReplyText(cont, isDreamMode, {
              forTheater: forTheaterMode,
              forCallVideoText: callVideoTextMode,
            });
            const piece = dedupeContinuationPiece(aiContent, contText);
            if (piece) {
              aiContent = aiContent + piece;
              rawAiContent = (rawAiContent || '') + piece;
            }
          }
        } catch { /* 续写失败则用原内容 */ }
      }
    }

    if (!isDreamMode && !callVideoTextMode) {
      aiContent = polishSpokenAiText(aiContent, char.language_style, { theater: !!forTheaterMode });
    }
    if (!isDreamMode && !String(aiContent || '').trim()) {
      return res.json(emptyAiChatPayload({
        userMsgId,
        delivery_status: userDelivery,
        peerStatus: contacts.getPeerStatus(db, characterId),
      }));
    }

    // 梦境叙事不触发忙碌状态
    const busyPatterns = [
      /我(要|得|先|需要)(去|回去)?(忙|做事|处理|睡觉|睡了|休息)/,
      /我(先|要)(去|忙).{0,6}(了|一会|一下|会儿)/,
      /我(有点|有些|有)事(情)?(要|需要|得)?(忙|处理|做)/,
      /我(先忙|去忙|忙一会|忙一下|忙会儿)/,
      /我(待会|等会)(儿)?(回来|找你|联系你)/,
    ];
    const busyAutoReplyEnabled = char.busy_style !== 'off';

    // 小剧场：进行中收场景状态/结束；普通聊天可写 [开启小剧场] 邀开场
    let theaterEnded = false;
    let theaterStarted = false;
    let theaterStartHint = null;
    const systemHints = [];
    if (forTheaterMode) {
      aiContent = applyTheaterSceneStateFromReply(characterId, aiContent);
      rawAiContent = stripTheaterSceneStateMarkers(rawAiContent);
      const ended = applyTheaterEndIfNeeded(characterId, aiContent, systemHints);
      aiContent = ended.text || aiContent;
      rawAiContent = stripTheaterEndMarker(rawAiContent);
      theaterEnded = ended.ended;
    } else if (!isDreamMode && !isVoiceMode) {
      const started = applyTheaterStartIfNeeded(characterId, aiContent, systemHints);
      aiContent = started.text || aiContent;
      rawAiContent = stripTheaterStartMarker(rawAiContent);
      theaterStarted = started.started;
      theaterStartHint = started.startHint || null;
    }

    let callLens = '';
    if (callVideoTextMode) {
      const lensFromAi = extractCallLensFromReply(aiContent);
      const lensFromRaw = extractCallLensFromReply(rawAiContent);
      callLens = lensFromAi.lens || lensFromRaw.lens || '';
      aiContent = lensFromAi.cleaned || aiContent;
      rawAiContent = lensFromRaw.cleaned || rawAiContent;
      if (!callLens) callLens = String(aiContent || '').trim().slice(0, 1200);
    }

    const newBusy = busyAutoReplyEnabled && !isDreamMode && !forTheaterMode
      && Number(char.robot_operating) !== 1
      && busyPatterns.some(p => p.test(aiContent));

    // 解析表情包标记并分段入库（去掉「配图：…」系统行，用户只看到正文+图片）
    const peerParsed = !isDreamMode
      ? contacts.applyPeerRelationFromAiContent(db, characterId, aiContent)
      : { content: aiContent, peerChange: null, moodLines: [] };
    aiContent = peerParsed.content || aiContent;
    rawAiContent = peerParsed.content || rawAiContent;

    try {
      const taParsed = require('./ta-helper').applyUnbindFromAiContent(characterId, aiContent);
      if (taParsed?.hit) {
        aiContent = taParsed.content;
        rawAiContent = taParsed.content;
      }
    } catch {}

    // 换头像：角色写了 [换头像] 才真正更换，否则拒绝不换
    if (pendingAvatar && replyAcceptsAvatarChange(aiContent)) {
      avatarUrl = pendingAvatar;
      db.prepare('UPDATE characters SET avatar=? WHERE id=?').run(avatarUrl, characterId);
      char.avatar = avatarUrl;
      avatarUpdated = true;
      push('character_update', { characterId, avatar: avatarUrl });
    }
    aiContent = stripAvatarChangeMarker(aiContent);
    rawAiContent = stripAvatarChangeMarker(rawAiContent);

    for (const line of (peerParsed.moodLines || [])) {
      const hid = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
      ).run(characterId, 'assistant', line, 'system', new Date().toISOString(), 0).lastInsertRowid;
      systemHints.push({ id: hid, role: 'assistant', type: 'system', content: line });
    }

    aiContent = normalizeMediaDirectiveLines(aiContent);
    rawAiContent = normalizeMediaDirectiveLines(rawAiContent);

    const callSave = callReplySaveMode(characterId, isVoiceMode, isDreamMode);
    let contentForSegs = aiContent;
    if (callSave.callAlreadyOver || callSave.justLeftCall) {
      contentForSegs = require('./emoji-helper').stripLeadingPhonePickup(aiContent);
    }
    const { segments, textContent, recalledMsg, wantPoke, wantCall } = processAiContentWithEmojis(contentForSegs, char, {
      voiceCallMode: callSave.voiceCallMode, characterId, isDream: isDreamMode,
    });
    const segmentsClean = stripAlbumMarkersFromSegments(segments);
    const intentClean = stripAlbumMarkersFromText(textContent || aiContent);
    const imageIntent = matchImageIntent(rawAiContent, intentClean);
    const strippedImg = stripImageDirectiveFromSegments(segmentsClean, aiContent);
    let toSave = stripSoundFxFromSegments(stripMusicScoreFromSegments(strippedImg, aiContent), aiContent);
    const vocalPrep = prepareVocalReply({
      char, segments: toSave, rawText: rawAiContent, skip: isDreamMode || forTheaterMode,
    });
    toSave = vocalPrep.segments;
    const userRequestedVoice = !isDreamMode && !isVoiceMode && !forTheaterMode && userRequestsVoiceMessage(content);
    const deliveryStatus = contacts.isPeerUndeliverable(db, characterId) ? 'peer_undelivered' : 'sent';
    if (!isDreamMode && !isVoiceMode && wantPoke) {
      try {
        const pokeMsg = insertCharacterPokeMessage(characterId, char, settings, { isDream: false });
        systemHints.push(pokeMsg);
        push('ai_poke', {
          characterId,
          charName: char.name,
          text: pokeMsg.content,
          timestamp: pokeMsg.timestamp,
        });
      } catch (e) {
        console.warn('[poke] insert', e.message);
      }
    }
    const { aiMsgId, aiMessages } = saveAiReplySegments(characterId, toSave, char, isDreamMode, {
      voiceCallMode: callSave.voiceCallMode,
      justLeftCall: callSave.justLeftCall,
      userRequestedVoice, deliveryStatus, theater: forTheaterMode,
    });
    if (theaterStartHint) {
      aiMessages.push({
        id: theaterStartHint.id,
        role: 'assistant',
        type: 'system',
        content: theaterStartHint.content,
        timestamp: new Date().toISOString(),
      });
    }
    if (momentChatCue?.momentId) {
      try { claimMomentChatAsk(momentChatCue.momentId, characterId); } catch (_) {}
    }
    if (systemHints.length) {
      aiMessages.unshift(...systemHints.filter((h) => h.type === 'system' && /拍了拍/.test(h.content || '')));
    }
    aiContent = toSave.filter(s => s.type === 'text').map(s => s.content).join('\n')
      || stripImageDirectiveFromSegments([], textContent || aiContent)[0]?.content
      || '';
    const incomingCall = await resolveAndTriggerIncomingCall(char, settings, {
      wantCall,
      rawText: rawForCall,
      processedText: aiContent,
      userMessage: content,
      isDream: isDreamMode,
      isVoice: isVoiceMode,
    });
    // 角色写 [挂断]/[end_call]：仅在通话中触发，不影响普通聊天
    try {
      resolveAndTriggerPeerEndCall(char, {
        rawText: rawForCall,
        processedText: aiContent,
        isVoice: isVoiceMode,
        isDream: isDreamMode,
        video: isVideoMode,
        userMessage: content,
      });
    } catch (e) {
      console.warn('[call] peer end', e.message);
    }
    if (!isDreamMode && aiContent) {
      try { touchCharacterEmotionFromMessage(characterId, { role: 'assistant', content: aiContent }); } catch (e) {
        console.warn('[emotion] touch assistant', e.message);
      }
    }
    if (recalledMsg) {
      push('message_update', { characterId, id: recalledMsg.id, recalled: true, recalledContent: recalledMsg.content });
    }

    // Extract daily context from AI response
    if (!isDreamMode) {
      try { syncScheduleFromChatActivity(characterId, aiContent); } catch (e) {
        console.warn('[schedule] sync from chat', e.message);
      }
      try {
        await require('./travel-arrive-helper').maybeScheduleTravelArrive(
          characterId, content, aiContent, history, {
            settings: getSettings(),
            sourceMsgIds: (aiMessages || [])
              .filter((m) => m && !m.recallAfterSend && (m.type === 'text' || m.type === 'voice') && m.id)
              .map((m) => m.id),
          }
        );
      } catch {}
      const today = new Date().toISOString().slice(0, 10);
      const aiCtxMatch = aiContent.match(/(去.{2,6}|在.{2,6}|刚.{2,6}|要去.{2,6})/);
      if (aiCtxMatch) {
        db.prepare(`INSERT INTO daily_context (character_id, content, date) VALUES (?,?,?)`).run(
          characterId, aiCtxMatch[0].slice(0, 50), today
        );
      }
    }

    if (newBusy) {
      db.prepare(`UPDATE characters SET status='busy', busy_since=datetime('now') WHERE id=?`).run(characterId);
      push('status_change', { characterId, status: 'busy' });
    }

    const userImageRequest = detectUserImageRequest(content);
    const userVideoRequest = detectUserVideoRequest(content);
    const imgs = await attachReplyImages({
      characterId, char, settings, rawText: rawAiContent, cleanText: aiContent, reqBase, isDreamMode,
      imageQuery: imageIntent.presetQuery,
      videoQuery: imageIntent.videoQuery,
      userImageRequest,
      userVideoRequest,
      userMessage: getUserImageRequestText(history, content) || getUserVideoRequestText(history, content),
    });
    appendImageMessages(aiMessages, imgs);

    try {
      memoryBrain.resolveCompletedTodos(characterId, {
        aiContent,
        recentMessages: history,
        sentImage: !imgs?.mediaBlocked
          && !!(imgs?.selfieImgUrl || imgs?.generalImgUrl || imgs?.imagePending || imgs?.selfiePending),
        sentVideo: !imgs?.mediaBlocked && !!(imgs?.generalVideoUrl || imgs?.videoPending),
      });
    } catch (e) {
      console.warn('[memory] resolve todos', e.message);
    }
    try {
      const travel = require('./process-time-helper');
      const pending = travel.getPending?.(characterId);
      if (pending && (pending.needImage || pending.needVideo) && !imgs?.mediaBlocked
        && (imgs?.selfieImgUrl || imgs?.generalImgUrl || imgs?.generalVideoUrl
          || imgs?.imagePending || imgs?.selfiePending || imgs?.videoPending)) {
        travel.clearPending?.(characterId);
      }
    } catch {}

    const scoreMsg = await attachMusicScoreMessage({
      characterId,
      rawText: rawAiContent,
      cleanText: aiContent,
      char,
      uploadsPath: UPLOADS_PATH,
      isDreamMode,
      deliveryStatus,
      settings,
    });
    if (scoreMsg) aiMessages.push(scoreMsg);
    attachReplyVocal(aiMessages, {
      characterId,
      char,
      play: vocalPrep.play,
      isDreamMode,
      deliveryStatus,
      forVoiceCall: isVoiceMode,
    });
    try {
      const sfxMsgs = await attachSoundFxMessages({
        characterId,
        rawText: rawAiContent,
        cleanText: aiContent,
        settings,
        uploadsPath: UPLOADS_PATH,
        isDreamMode,
        deliveryStatus,
        ...voiceCallSfxExtras(isVoiceMode, char),
      });
      if (sfxMsgs?.length) aiMessages.push(...sfxMsgs);
    } catch (e) {
      console.warn('[sfx]', e.message);
    }

    markUserMessagesReadByPeer(characterId, isDreamMode ? 1 : 0);
    if (!isDreamMode) {
      maybeTriggerMemorySummary(characterId, { userMsgId, assistantMsgId: aiMsgId });
    }

    if (!isDreamMode && !robotWillDone && robotInvokeIntent && robotInvokeIntent !== robotUserAskDone) {
      try {
        await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
          intent: robotInvokeIntent,
          proactiveText: aiContent,
          publicBase: reqBase,
          source: 'chat_tag',
          rawAi: rawMergedRobot,
        });
      } catch (e) {
        console.warn('[chat] robot will', e.message);
      }
    } else if (!isDreamMode && !robotInvokeIntent && robotUserAskAfter) {
      try {
        await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
          intent: robotUserAskAfter,
          proactiveText: aiContent,
          publicBase: reqBase,
          source: 'user_ask',
        });
      } catch (e) {
        console.warn('[chat] robot user ask after', e.message);
      }
    }
    // [舵机]/[动作] 与 [桌宠:…] 可同条：先跑桌宠意图，再落下原回复里的舵机角
    if (!isDreamMode) {
      try { applyPhoneChatToRobot(characterId, char, settings, rawMergedRobot, aiContent, reqBase, content, robotInvokeIntent); } catch (e) {
        console.warn('[chat] robot puppet', e.message);
      }
    }

    res.json({
      userMsgId, aiMsgId, content: aiContent, aiMessages, isBusy: newBusy,
      userContent: isDreamMode ? userContent : undefined,
      dreamExpand: expandMeta || undefined,
      selfieImgId: imgs.selfieImgId, selfieImgUrl: imgs.selfieImgUrl,
      generalImgId: imgs.generalImgId, generalImgUrl: imgs.generalImgUrl,
      generalVideoId: imgs.generalVideoId, generalVideoUrl: imgs.generalVideoUrl,
      imageAttachNote: imgs.imageAttachNote || '',
      selfiePending: !!imgs.selfiePending,
      videoPending: !!imgs.videoPending,
      imagePending: !!imgs.imagePending,
      scoreMsgId: scoreMsg?.id || null,
      avatarUpdated, avatarUrl, peerReadUser: true,
      recalled: recalledMsg ? { id: recalledMsg.id, content: recalledMsg.content } : null,
      delivery_status: userDelivery,
      peerChange: peerParsed.peerChange || null,
      peerStatus: contacts.getPeerStatus(db, characterId),
      systemHints,
      theaterEnded: !!theaterEnded,
      theaterStarted: !!theaterStarted,
      theaterActive: (forTheaterMode && !theaterEnded) || !!theaterStarted,
      callAmbience: callAmbienceField(isVoiceMode, characterId),
      callLens: callLens || undefined,
      incomingCall: incomingCall || undefined,
      musicCard: musicEnrichment?.musicCard || undefined,
    });
    broadcastChatMessage(characterId, aiContent, aiMessages, isDreamMode);
    scheduleSelfieDelivery(imgs.pendingSelfieJob);
    scheduleVideoDelivery(imgs.pendingVideoJob);
    scheduleChatImageDelivery(imgs.pendingImageJob);
  } catch (err) {
    console.error('[send] error:', err.message);
    res.status(500).json({ error: formatApiBillingError(err.message, { label: '聊天 API' }) || err.message, userMsgId });
  }
});

/** 音乐同步通知接口 */
app.post('/api/music-sync/notify', async (req, res) => {
  try {
    const musicSyncApi = require('./music-sync-api');
    await musicSyncApi.handleMusicSyncNotify(req, res, db, getSettings);
  } catch (e) {
    console.error('[music-sync] notify failed:', e);
    res.status(500).json({ error: e.message });
  }
});

/** 梦境不自由模式：生成三个行动选项（不写库） */
app.post('/api/dream/choices', async (req, res) => {
  const { characterId, dreamMask = false, dreamStyle = '', dreamConfig = null } = req.body || {};
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  const settings = getSettings();
  const dreamCfg = dreamHelper.normalizeDreamConfig(dreamConfig || {});
  if (dreamMask === true || dreamMask === 1 || dreamMask === '1') dreamCfg.mask = true;
  dreamCfg.freedom = 'guided';

  const history = db.prepare(
    `SELECT role, content FROM messages WHERE character_id=? AND is_dream=1 AND recalled=0 ORDER BY id DESC LIMIT 24`
  ).all(characterId).reverse();
  if (history.length < 1) {
    return res.json({ choices: ['环顾四周', '上前一步', '轻声开口'], error: '情节尚少，先用默认选项' });
  }
  const transcript = history.map(m => `${m.role === 'user' ? '对方' : char.name}：${String(m.content || '').slice(0, 200)}`).join('\n');
  const sys = dreamHelper.buildDreamExtraSystemPrompt({
    dreamMask: dreamCfg.mask,
    dreamStyle: (typeof dreamStyle === 'string' && dreamStyle.trim())
      ? dreamStyle.trim()
      : dreamHelper.resolveDreamStyleText(dreamCfg),
    dreamConfig: dreamCfg,
    freedom: 'guided',
  });
  const userPrompt = `${dreamHelper.buildChoicesPrompt(dreamCfg)}\n\n【近期梦境】\n${transcript}`;
  try {
    let raw = await callChatAPIComplete(settings, sys, userPrompt, 'dream');
    if (!raw) raw = await callChatAPIComplete(settings, sys, userPrompt, 'chat');
    let parsed = null;
    try {
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch { parsed = null; }
    let choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
    choices = choices.map(c => String(c || '').trim().slice(0, 40)).filter(Boolean).slice(0, 3);
    while (choices.length < 3) {
      const fallback = ['静静注视对方', '转身离开几步', '试探着开口'][choices.length];
      if (!choices.includes(fallback)) choices.push(fallback);
      else choices.push(`选项${choices.length + 1}`);
    }
    res.json({ choices });
  } catch (e) {
    res.status(500).json({
      error: formatApiBillingError(e.message) || e.message || '生成选项失败',
      choices: [],
    });
  }
});

// 触发 AI 回复（不新增用户消息）
// mode: 'retry'（重新回复最后一条用户消息）| 'continue'（让 AI 主动续话）

/** 重新生成前：删掉「最后一条用户消息」之后的全部角色回复（含图/视频），避免旧气泡残留叠在新回复上 */
function clearTrailingAssistantReplies(characterId, isDreamMode) {
  const dream = isDreamMode ? 1 : 0;
  const lastUser = db.prepare(
    `SELECT id FROM messages
     WHERE character_id=? AND is_dream=? AND recalled=0 AND role='user'
     ORDER BY id DESC LIMIT 1`
  ).get(characterId, dream);
  if (!lastUser?.id) return { deletedIds: [], lastUserId: null };
  const rows = db.prepare(
    `SELECT id FROM messages
     WHERE character_id=? AND is_dream=? AND role='assistant' AND id>?`
  ).all(characterId, dream, lastUser.id);
  const deletedIds = rows.map(r => r.id).filter(Boolean);
  if (deletedIds.length) {
    const ph = deletedIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...deletedIds);
  }
  return { deletedIds, lastUserId: lastUser.id };
}

/** 同一角色同时只跑一轮 trigger-ai，避免打包连点把上一轮清掉或互相踩 */
const _triggerAiLocks = new Map();
function acquireTriggerAiLock(characterId) {
  const id = Number(characterId);
  const prev = _triggerAiLocks.get(id) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  _triggerAiLocks.set(id, prev.then(() => gate, () => gate));
  return prev.then(() => release).catch(() => release);
}

app.post('/api/messages/trigger-ai', async (req, res) => {
  const {
    characterId, isDream = false, mode = 'retry', dreamMask = false, dreamStyle = '',
    dreamConfig = null, isVoiceCall = false, catchUp = false, gameTopicContext = '', callRollHint = '',
    isVideoCall = false, callLookImage = '', callPresenceMode = '', callInputMode = '',
    callHangoutWakeStep = 0,
    callHangoutSleeping = false,
  } = req.body;
  const releaseTriggerLock = await acquireTriggerAiLock(characterId);
  try {
  const isDreamMode = isDream === true || isDream === 1 || isDream === '1';
  const isVoiceMode = isVoiceCall === true || isVoiceCall === 1 || isVoiceCall === '1';
  const isVideoMode = isVoiceMode && (isVideoCall === true || isVideoCall === 1 || isVideoCall === '1');
  const isCatchUp = catchUp === true || catchUp === 1 || catchUp === '1';
  const hasDreamMask = dreamMask === true || dreamMask === 1 || dreamMask === '1';
  const dreamCfg = dreamHelper.normalizeDreamConfig(dreamConfig || { mask: hasDreamMask });
  if (hasDreamMask) dreamCfg.mask = true;
  let settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  settings = withCharChatPrefs(settings, char);

  if (!isDreamMode && hasPendingUserAskLook(characterId)) {
    return res.json({
      content: '',
      aiMsgId: null,
      aiMessages: [],
      robotInvoke: true,
      robotLooking: true,
      peerStatus: contacts.getPeerStatus(db, characterId),
    });
  }

  if (!isDreamMode && contacts.getPeerStatus(db, characterId) === contacts.PEER.DELETED) {
    return res.json({ content: '', peerStatus: 'deleted', peerHint: '对方已把你删除' });
  }

  const { url: endpoint, key: apiKey, model: apiModel } = resolveChatApiSettings(settings, isDreamMode, char);
  if (!endpoint) return res.status(400).json({ error: isDreamMode ? '请先在设置中配置梦境或聊天 API' : '请先在设置中配置API' });
  if (!apiKey) return res.status(400).json({ error: '请先在设置中配置 API Key' });

  let history = loadRecentChatHistory(characterId, isDreamMode, char, settings);

  let aiMode = String(mode || 'retry');
  const lastChat = [...history].reverse().find((m) => {
    if (m.recalled) return false;
    // 用户拍一拍写入 type=system，但仍算用户互动，不能跳过
    if (m.type === 'system' && m.role === 'user' && /拍了拍/.test(String(m.content || ''))) return true;
    return m.type !== 'system';
  });
  if (lastChat?.role === 'user' && aiMode === 'continue') aiMode = 'retry';

  // 重新生成必须先清掉上次角色回复；否则旧消息会留在库里，和新回复叠在一起，模型也可能照着旧稿续写
  if (aiMode === 'retry') {
    const cleared = clearTrailingAssistantReplies(characterId, isDreamMode);
    if (cleared.deletedIds.length) {
      try {
        push('messages_deleted', {
          characterId: Number(characterId),
          ids: cleared.deletedIds,
          isDream: isDreamMode ? 1 : 0,
        });
      } catch {}
      history = loadRecentChatHistory(characterId, isDreamMode, char, settings);
    }
  }

  const forTheaterMode = !isDreamMode && !isVoiceMode && isTheaterActive(char);

  const dreamExtra = isDreamMode
    ? dreamHelper.buildDreamExtraSystemPrompt({
        dreamMask: dreamCfg.mask,
        dreamStyle: (typeof dreamStyle === 'string' && dreamStyle.trim())
          ? dreamStyle.trim()
          : dreamHelper.resolveDreamStyleText(dreamCfg),
        dreamConfig: dreamCfg,
        freedom: dreamCfg.freedom,
      })
    : '';
  let extraSystemPrompt = dreamExtra;
  const reqBase = `${req.protocol}://${req.get('host')}`;
  const presenceEarly = String(callPresenceMode || '').trim();
  const lookUrlEarly = String(callLookImage || '').trim();
  if (!isDreamMode && isVoiceMode && presenceEarly === 'watch' && lookUrlEarly) {
    try {
      const scene = await describeCallWatchScene(settings, lookUrlEarly, reqBase);
      if (scene) rememberCallWatchScene(characterId, scene);
    } catch (e) {
      console.warn('[call-watch] describe', e.message);
    }
  }
  if (!isDreamMode && isVoiceMode) {
    extraSystemPrompt = buildCallExtraSystemPrompt(isVideoMode, history, characterId, {
      presenceMode: callPresenceMode,
      inputMode: callInputMode,
      hangoutWakeStep: callHangoutWakeStep,
      hangoutSleeping: callHangoutSleeping === true || callHangoutSleeping === 1 || callHangoutSleeping === '1',
      callVideoTextMode: isVideoMode && isCharCallVideoTextMode(char),
    });
    const lastHist = history?.[history.length - 1];
    if (lastHist?.type === 'system' && /通话开始/.test(String(lastHist.content || ''))) {
      extraSystemPrompt += '\n刚接通，先开口；可先喂一声再接话，别播音腔。';
    }
    try {
      require('./proactive-outreach-helper').ensureLiveCallLog(db, characterId, {
        video: !!isVideoMode,
        from: 'user',
      });
    } catch (e) {
      console.warn('[call] ensure live log', e.message);
    }
  }
  if (isCatchUp && !isDreamMode) {
    const pending = getUserMessagesNeedingRealReply(characterId);
    if (pending.length) {
      const catchNote = `[你刚从忙碌中回来。用户在你忙碌期间发了${pending.length}条消息，之前只有自动回复。现在请按平时聊天那样把这些话认真回了，可综合照顾到这些内容，不要提及「自动回复」或「刚才的自动消息」]`;
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${catchNote}` : catchNote;
    }
  }
  if (gameTopicContext && String(gameTopicContext).trim() && !isDreamMode) {
    const topicNote = `[用户选中了之前游戏（真心话/默契翻牌）的一个话题想接着聊。以下是题目与双方作答摘要（不含游戏内闲聊）。请自然延伸讨论，不要整段复读摘要]\n${String(gameTopicContext).trim().slice(0, 1500)}`;
    extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${topicNote}` : topicNote;
  }
  if (callRollHint && String(callRollHint).trim() && !isDreamMode) {
    const hint = String(callRollHint).trim().slice(0, 500);
    const rollNote = isVoiceMode
      ? `[通话提示] ${hint}`
      : `[情景提示] ${hint}`;
    extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${rollNote}` : rollNote;
  }

  let avatarUpdated = false;
  let avatarUrl = null;
  let pendingAvatar = null;
  if (!isDreamMode && aiMode === 'retry') {
    pendingAvatar = detectAvatarChangeIntent(history);
    if (pendingAvatar && pendingAvatar !== char.avatar) {
      const avatarHint = buildAvatarChangeChoiceHint();
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${avatarHint}` : avatarHint;
    } else {
      pendingAvatar = null;
    }
  }

  if (!isDreamMode) {
    const sleepNote = buildSleepContextNote(history, settings);
    if (sleepNote) {
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${sleepNote}` : sleepNote;
    }
    const intentNote = buildStatedIntentElapsedNote(history, settings);
    if (intentNote) {
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${intentNote}` : intentNote;
    }
    const headTouchNote = robotHelper.buildHeadTouchPromptLine();
    if (headTouchNote) {
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${headTouchNote}` : headTouchNote;
    }
    try {
      const lastUser = [...(history || [])].reverse().find((m) => m?.role === 'user');
      if (lastUser?.type === 'voice') {
        const vp = await voiceprintHelper.attachLatestUserVoice(
          history, getSettings, setSetting, UPLOADS_PATH,
          (id, next) => db.prepare('UPDATE messages SET content=? WHERE id=?').run(next, id)
        );
        const vpExtra = voiceprintHelper.voiceprintChatExtra(vp);
        if (vpExtra) {
          extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${vpExtra}` : vpExtra;
        }
      }
    } catch (e) {
      console.warn('[voiceprint] trigger-ai', e.message);
    }
    // 行动连贯 / 话题连续已在 buildSystemPrompt 内注入，勿重复
    if (aiMode === 'retry') {
      const retryAdvance = buildRetryTimeAdvanceNote(history, settings);
      if (retryAdvance) {
        extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${retryAdvance}` : retryAdvance;
      }
    }
  }

  if (!isDreamMode && aiMode === 'continue') {
    const presence = String(callPresenceMode || '').trim();
    const bothSleep = callHangoutSleeping === true || callHangoutSleeping === 1 || callHangoutSleeping === '1';
    const contNote = isVoiceMode
      ? (presence === 'hangout'
        ? (bothSleep
          ? '连麦同睡时：可哼哼唧唧梦呓或迷糊短应，多数 [安静]。不要主动找话题，不要（叹气）括注。'
          : '连麦挂着时：各忙各的，多数 [安静]；对方开口再短接。不要装睡梦呓，不要（叹气）括注。')
        : (presence === 'watch'
          ? '观影挂着时：按【一起看】像当面追剧聊，也可 [安静]。不要提截图、屏幕、识图，不必刻意强调观影。'
          : '你还想再接一句。电话里只补一口气能说完的话，不要重复已说内容，不要解释「为什么要续说」。'))
      : '你上一条还想自然续说几句。接着聊，不要重复已说内容，不要解释「为什么要续说」。';
    extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${contNote}` : contNote;
  }
  if (isDreamMode && aiMode === 'continue') {
    const dreamCont = '【续写】接着上一幕梦境往下写，不要重复已写内容，不要另起新梦；保持同一场梦的人物、氛围与时间线。全文必须继续用简体中文。';
    extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${dreamCont}` : dreamCont;
  }

  const lastUserContent = [...history].reverse().find(m => m.role === 'user')?.content || '';
  let robotUserAskAfter = null;
  let robotUserAskDone = null;
  if (!isDreamMode && !forTheaterMode && lastUserContent) {
    try {
      const userAskedTool = await tryStartUserAskedRobotTool({
        char, settings, userText: lastUserContent, publicBase: reqBase,
      });
      if (userAskedTool?.defer) {
        return res.json({
          content: '',
          aiMsgId: null,
          aiMessages: [],
          robotInvoke: true,
          robotLooking: true,
          peerStatus: contacts.getPeerStatus(db, characterId),
        });
      }
      if (userAskedTool?.invokeAfterReply) robotUserAskAfter = userAskedTool.invokeAfterReply;
      if (userAskedTool?.alreadyInvoked) robotUserAskDone = userAskedTool.intent;
    } catch (e) {
      console.warn('[chat] user ask look (trigger-ai)', e.message);
    }
  }
  if (!isDreamMode) {
    extraSystemPrompt = appendMediaRequestHints(extraSystemPrompt, history, lastUserContent);
    const replyCtx = buildQuotedReplyPrompt(characterId, history);
    if (replyCtx) extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${replyCtx}` : replyCtx;
  }

  if (!isDreamMode) {
    try {
      const es = db.prepare('SELECT emotion_state FROM characters WHERE id=?').get(characterId);
      if (es) char.emotion_state = es.emotion_state || '';
    } catch {}
  }

  const retrySession = resolveChatSession(history, isDreamMode, lastUserContent);
  const promptOpts = {
    isDream: isDreamMode,
    forTheater: forTheaterMode,
    forVoiceCall: isVoiceMode,
    forVideoCall: isVideoMode,
    forVideoCallText: isVideoMode && isCharCallVideoTextMode(char),
    contextText: retrySession.contextText,
    userMessage: lastUserContent,
    recentHistory: retrySession.liveHistory,
    sessionClosed: retrySession.sessionClosed,
    enableInlineDirectives: true,
    userAskedCall: (!isDreamMode && !isVoiceMode) ? userRequestsPhoneCall(lastUserContent) : null,
  };
  if (!isDreamMode) {
    try { await prefetchLocationWeather(char, settings, promptOpts); } catch {}
    try {
      const recallBlock = await timelineHelper.prefetchDayRecallForChat(
        characterId, settings, lastUserContent, promptOpts
      );
      if (recallBlock) {
        extraSystemPrompt = extraSystemPrompt
          ? `${extraSystemPrompt}\n${recallBlock}`
          : recallBlock;
      }
    } catch (e) {
      console.warn('[timeline] chat recall inject failed:', e.message);
    }
  }
  let momentChatCue = null;
  if (!isDreamMode && !forTheaterMode) {
    try {
      momentChatCue = getUserMomentChatCue(char, settings);
      if (momentChatCue?.block) {
        extraSystemPrompt = extraSystemPrompt
          ? `${extraSystemPrompt}\n${momentChatCue.block}`
          : momentChatCue.block;
      }
    } catch (e) {
      console.warn('[moments] chat cue inject failed:', e.message);
    }
  }
  if (!isDreamMode && !promptOpts.forGame) {
    try {
      await applyBrainUnderstanding(char, settings, promptOpts);
    } catch (e) {
      console.warn('[brain] understanding', e.message);
    }
  }
  const replyTimePack = !isDreamMode && aiMode === 'retry'
    ? buildReplyTimeNotePayload(settings, characterId, isDreamMode, { userMessage: lastUserContent })
    : { timeNote: '', noteTargetUserId: null, minutes: 0 };
  const { timeNote, noteTargetUserId } = replyTimePack;
  if (replyTimePack.minutes) promptOpts.userReturnMinutes = replyTimePack.minutes;
  const systemPrompt = buildSystemPrompt(char, settings, extraSystemPrompt, promptOpts);

  const apiHistory = buildHistoryApiMessages(retrySession.liveHistory, reqBase, buildChatHistoryOptions(req, timeNote, noteTargetUserId, settings, isDreamMode));
  // 兜底：retry 时上下文不能以角色旧回复结尾，否则模型容易把旧内容续出来
  if (aiMode === 'retry') {
    while (apiHistory.length && apiHistory[apiHistory.length - 1].role === 'assistant') {
      apiHistory.pop();
    }
  }
  if (aiMode === 'continue' && apiHistory.length && apiHistory[apiHistory.length - 1].role === 'assistant') {
    // 梦境续写勿用英文省略号当用户句，否则模型容易整段切到英文
    apiHistory.push({
      role: 'user',
      content: isDreamMode ? '（请用简体中文接着上一幕继续写，不要重复上文）' : '…',
    });
  }
  if (!apiHistory.length) return res.status(400).json({ error: '没有历史消息可触发' });

  // 忙碌自动回复（与 send 一致；用户消息已入库后再触发 AI 时走这里）
  const busyAutoReplyEnabled = char.busy_style !== 'off';
  if (!isDreamMode && aiMode === 'retry' && char.status === 'busy' && busyAutoReplyEnabled && !isCatchUp) {
    const busyHit = resolveBusyAutoReply(char, characterId, isDreamMode, settings);
    if (busyHit?.silent) {
      return res.json({ isBusy: true, silent: true });
    }
    const autoReplyText = busyHit?.autoReplyText || `【自动回复】${BUSY_AUTO_REPLIES[0]}`;
    const now = new Date().toISOString();
    const autoMsgId = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
    ).run(characterId, 'assistant', autoReplyText, 'text', now, 0).lastInsertRowid;
    broadcastChatMessage(characterId, autoReplyText, [{ id: autoMsgId, type: 'text', content: autoReplyText }], isDreamMode);
    return res.json({
      isBusy: true,
      autoReply: autoReplyText,
      aiMsgId: autoMsgId,
    });
  }

  const apiMessages = [{ role: 'system', content: systemPrompt }, ...apiHistory];
  const lookUrl = String(callLookImage || '').trim();
  // 观影：截图只用于上游生成「一起看」摘要，不把图塞给角色（避免从截图角度说话）
  if (isVideoMode && lookUrl && String(callPresenceMode || '').trim() !== 'watch') {
    const abs = toAbsoluteMediaUrl(lookUrl, reqBase);
    if (abs) {
      const lookNote = '【视频通话·你正看着对方】下面这一帧就是你屏幕上此刻的画面——像真人视频通话，不是相册、不是任务清单。\n'
        + '画面清楚：有值得一提的再随口带一句，像顺眼瞥到，别每轮点名「我看见你」「你穿了…」，也不要盘点。\n'
        + '画面黑、糊、暗、挡镜头、几乎看不清：你就当真没看清——可以眯眼辨认、凑近屏幕、随口问一句「你那边怎么黑了？」「挡着了？」之类，按你自己的性格来，不要像客服报障，也不要假装看见表情/穿着/动作。\n'
        + '不要提截图、系统、摄像头权限。';
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${lookNote}` : lookNote;
      apiMessages[0].content = buildSystemPrompt(char, settings, extraSystemPrompt, promptOpts);
      let attached = false;
      for (let i = apiMessages.length - 1; i >= 1; i--) {
        if (apiMessages[i].role !== 'user') continue;
        const prev = apiMessages[i].content;
        const parts = Array.isArray(prev)
          ? prev.slice()
          : [{ type: 'text', text: String(prev || '') }];
        parts.push({ type: 'text', text: '（这是你视频通话屏幕上此刻看到的对方画面。清楚就当真人视频里瞥见；黑了/糊了就当没看清，可以自然问一句。）' });
        parts.push({ type: 'image_url', image_url: { url: abs } });
        apiMessages[i].content = parts;
        attached = true;
        break;
      }
      if (!attached) {
        apiMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: '（这是你视频通话屏幕上此刻看到的对方画面。清楚就当真人视频里瞥见；黑了/糊了就当没看清，可以自然问一句。）' },
            { type: 'image_url', image_url: { url: abs } },
          ],
        });
      }
    }
  } else if (String(callPresenceMode || '').trim() === 'watch' && lookUrlEarly) {
    // 刷新「一起看」后，给角色一句当面追剧提示（摘要已在 system）
    const sceneText = String(getCallWatchScene(characterId)?.text || '').trim();
    if (sceneText) {
      const watchHint = '【一起看·刷新】内容刚更新到上面【一起看】。像当面追剧随口接一句或吐槽，也可 [安静]。不要提截图或系统。';
      extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n${watchHint}` : watchHint;
      apiMessages[0].content = buildSystemPrompt(char, settings, extraSystemPrompt, promptOpts);
    }
  }

  const baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;

  // 梦境模式提高上限，配合截断自动接写
  const trigMaxTokens = isDreamMode
      ? Math.max(3500, parseInt(settings.chat_max_tokens || '4000', 10) || 4000)
      : parseInt(settings.chat_max_tokens || '4000');

    const robotChatTools = await require('./robot-llm-tools').toolsForChat(char, settings, {
      isDream: isDreamMode,
      forTheater: forTheaterMode,
      isVoiceCall: isVoiceMode,
      userMessage: lastUserContent,
      recentHistory: history,
    });
    const turn = await completeChatTurn({
      url: endpoint,
      apiKey,
      model: apiModel,
      settings,
      messages: apiMessages,
      maxTokens: trigMaxTokens,
      timeout: 120000,
      tools: robotChatTools,
      characterId: char.id,
    });
    const data = turn.data || { choices: [{ message: turn.message, finish_reason: turn.finishReason }] };
    if (data.choices?.[0] && turn.finishReason) data.choices[0].finish_reason = turn.finishReason;
    let rawAiContent = String(turn.content || '').trim();
    const rawMergedRobot = rawAiContent;
    if (turn.toolCalls?.length) {
      console.log(`[chat] robot tool_calls ${turn.toolCalls.map((c) => c.name).join(',')}`);
    }
    let robotInvokeIntent = null;
    if (!isDreamMode && !forTheaterMode && rawAiContent) {
      const parsedInvoke = robotHelper.parseRobotInvoke(rawAiContent);
      if (parsedInvoke.found) {
        robotInvokeIntent = parsedInvoke.intent;
        rawAiContent = parsedInvoke.textWithout;
        if (parsedInvoke.source === 'intent') {
          console.log(`[chat] robot intent→${robotInvokeIntent} (toolbook)`);
        }
      }
      const mergedFind = robotHelper.preferFindIfUserAsked(robotInvokeIntent, robotUserAskAfter);
      if (mergedFind === 'find' && robotInvokeIntent !== 'find') {
        console.log(`[chat] 用户要找人 → find（角色标记=${robotInvokeIntent || '无'}）`);
        robotInvokeIntent = 'find';
      }
    }
    const rawForCall = rawAiContent;
    const callVideoTextMode = isVoiceMode && isVideoMode && isCharCallVideoTextMode(char);
    let aiContent = normalizeAiReplyText(rawAiContent, isDreamMode, {
      forTheater: forTheaterMode,
      forCallVideoText: callVideoTextMode,
    });
    if (!aiContent && !isDreamMode && !forTheaterMode
        && (robotInvokeIntent || /\[(?:桌宠|舵机|灯光|动作|表情)\s*[:：]/.test(rawMergedRobot))) {
      try {
        if (robotInvokeIntent) {
          await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
            intent: robotInvokeIntent,
            publicBase: reqBase,
            source: 'chat_tag_only',
            rawAi: rawMergedRobot,
          });
        }
        applyPhoneChatToRobot(characterId, char, settings, rawMergedRobot, '', reqBase, lastUserMsg?.content || '', robotInvokeIntent);
      } catch (e) {
        console.warn('[chat] robot will only', e.message);
      }
      return res.json({
        aiMsgId: null,
        content: '',
        aiMessages: [],
        robotInvoke: true,
        peerStatus: contacts.getPeerStatus(db, characterId),
      });
    }
    // 同上：看一眼不再吞掉这轮回话
    let robotWillDone = false;
    if (!isDreamMode && !forTheaterMode && robotHelper.isRobotCameraVisionIntent(robotInvokeIntent)) {
      try {
        await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
          intent: robotInvokeIntent,
          publicBase: reqBase,
          source: 'chat_tag',
          rawAi: rawMergedRobot,
        });
        robotWillDone = true;
      } catch (e) {
        console.warn('[chat] robot look', e.message);
      }
    }
    if (!aiContent) {
      return res.json(emptyAiChatPayload({
        peerStatus: contacts.getPeerStatus(db, characterId),
      }));
    }

    if (!isDreamMode && !forTheaterMode) {
      try {
        const travel = require('./travel-arrive-helper');
        const um = typeof lastUserContent === 'string' ? lastUserContent : (lastUserMsg?.content || '');
        aiContent = travel.stripPrematureArrivalLocation(aiContent, {
          charId: characterId, userMessage: um, history,
        });
        rawAiContent = travel.stripPrematureArrivalLocation(String(rawAiContent || ''), {
          charId: characterId, userMessage: um, history,
        });
      } catch {}
    }

    if (isDreamMode) {
      const done = await completeDreamIfTruncated({
        baseUrl, apiKey, apiModel, settings, systemPrompt, apiHistory,
        aiContent, rawAiContent,
        finishReason: data.choices?.[0]?.finish_reason || '',
        rounds: 3,
      });
      aiContent = done.aiContent;
      rawAiContent = done.rawAiContent;
    } else {
      // 自动续写（同 sendMessage）
      const trigSentenceEnds = /[。！？…!?」』"'～~）)】\n]$/;
      const trigNeedsCont = data.choices?.[0]?.finish_reason === 'length'
        || (data.choices?.[0]?.finish_reason !== 'stop' && !trigSentenceEnds.test(aiContent) && aiContent.length > 60);
      if (trigNeedsCont) {
        try {
          const contBody = JSON.stringify({
            model: apiModel,
            messages: [
              { role: 'system', content: `${systemPrompt}\n你上一条被截断了，从断句处接着说完，不要重复已写内容。` },
              ...apiMessages.slice(1),
              { role: 'assistant', content: aiContent },
              { role: 'user', content: '…' },
            ],
            temperature: parseFloat(settings.chat_temperature || '0.8'),
            max_tokens: 600, stream: false,
          });
          let contData = null;
          const contHeaders = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          };
          try {
            const contR = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
              method: 'POST', headers: contHeaders, body: contBody, timeout: 60000,
            });
            if (contR.ok) contData = await contR.json();
          } catch {}
          if (!contData && !baseUrl.endsWith('/v1')) {
            try {
              const contR2 = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
                method: 'POST', headers: contHeaders, body: contBody, timeout: 60000,
              });
              if (contR2.ok) contData = await contR2.json();
            } catch {}
          }
          const cont = contData?.choices?.[0]?.message?.content?.trim();
          if (cont) {
            const contText = normalizeAiReplyText(cont, isDreamMode, {
              forTheater: forTheaterMode,
              forCallVideoText: callVideoTextMode,
            });
            const piece = dedupeContinuationPiece(aiContent, contText);
            if (piece) {
              aiContent = aiContent + piece;
              rawAiContent = (rawAiContent || '') + piece;
            }
          }
        } catch {}
      }
    }

    if (!isDreamMode && !callVideoTextMode) {
      aiContent = polishSpokenAiText(aiContent, char.language_style, { theater: !!forTheaterMode });
    }
    if (!isDreamMode && !String(aiContent || '').trim()) {
      return res.json(emptyAiChatPayload({
        peerStatus: contacts.getPeerStatus(db, characterId),
      }));
    }

    // 小剧场：进行中收场景状态/结束；普通聊天可写 [开启小剧场] 邀开场
    let theaterEnded = false;
    let theaterStarted = false;
    let theaterStartHint = null;
    const systemHints = [];
    if (forTheaterMode) {
      aiContent = applyTheaterSceneStateFromReply(characterId, aiContent);
      rawAiContent = stripTheaterSceneStateMarkers(rawAiContent);
      const ended = applyTheaterEndIfNeeded(characterId, aiContent, systemHints);
      aiContent = ended.text || aiContent;
      rawAiContent = stripTheaterEndMarker(rawAiContent);
      theaterEnded = ended.ended;
    } else if (!isDreamMode && !isVoiceMode) {
      const started = applyTheaterStartIfNeeded(characterId, aiContent, systemHints);
      aiContent = started.text || aiContent;
      rawAiContent = stripTheaterStartMarker(rawAiContent);
      theaterStarted = started.started;
      theaterStartHint = started.startHint || null;
    }

    let callLens = '';
    if (callVideoTextMode) {
      const lensFromAi = extractCallLensFromReply(aiContent);
      const lensFromRaw = extractCallLensFromReply(rawAiContent);
      callLens = lensFromAi.lens || lensFromRaw.lens || '';
      aiContent = lensFromAi.cleaned || aiContent;
      rawAiContent = lensFromRaw.cleaned || rawAiContent;
      if (!callLens) callLens = String(aiContent || '').trim().slice(0, 1200);
    }

    const peerParsed = !isDreamMode
      ? contacts.applyPeerRelationFromAiContent(db, characterId, aiContent)
      : { content: aiContent, peerChange: null, moodLines: [] };
    aiContent = peerParsed.content || aiContent;
    rawAiContent = peerParsed.content || rawAiContent;

    try {
      const taParsed = require('./ta-helper').applyUnbindFromAiContent(characterId, aiContent);
      if (taParsed?.hit) {
        aiContent = taParsed.content;
        rawAiContent = taParsed.content;
      }
    } catch {}

    // 换头像：角色写了 [换头像] 才真正更换，否则拒绝不换
    if (pendingAvatar && replyAcceptsAvatarChange(aiContent)) {
      avatarUrl = pendingAvatar;
      db.prepare('UPDATE characters SET avatar=? WHERE id=?').run(avatarUrl, characterId);
      char.avatar = avatarUrl;
      avatarUpdated = true;
      push('character_update', { characterId, avatar: avatarUrl });
    }
    aiContent = stripAvatarChangeMarker(aiContent);
    rawAiContent = stripAvatarChangeMarker(rawAiContent);

    for (const line of (peerParsed.moodLines || [])) {
      const hid = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
      ).run(characterId, 'assistant', line, 'system', new Date().toISOString(), 0).lastInsertRowid;
      systemHints.push({ id: hid, role: 'assistant', type: 'system', content: line });
    }

    aiContent = normalizeMediaDirectiveLines(aiContent);
    rawAiContent = normalizeMediaDirectiveLines(rawAiContent);

    const callSave = callReplySaveMode(characterId, isVoiceMode, isDreamMode);
    let contentForSegs = aiContent;
    if (callSave.callAlreadyOver || callSave.justLeftCall) {
      contentForSegs = require('./emoji-helper').stripLeadingPhonePickup(aiContent);
    }
    const { segments, textContent, recalledMsg, wantPoke, wantCall } = processAiContentWithEmojis(contentForSegs, char, {
      voiceCallMode: callSave.voiceCallMode, characterId, isDream: isDreamMode,
    });
    const segmentsClean = stripAlbumMarkersFromSegments(segments);
    const intentClean = stripAlbumMarkersFromText(textContent || aiContent);
    const imageIntent = matchImageIntent(rawAiContent, intentClean);
    const strippedImg = stripImageDirectiveFromSegments(segmentsClean, aiContent);
    let toSave = stripSoundFxFromSegments(stripMusicScoreFromSegments(strippedImg, aiContent), aiContent);
    const vocalPrep = prepareVocalReply({
      char, segments: toSave, rawText: rawAiContent, skip: isDreamMode || forTheaterMode,
    });
    toSave = vocalPrep.segments;
    const userRequestedVoice = !isDreamMode && !isVoiceMode && !forTheaterMode && userRequestsVoiceMessage(lastUserContent);
    const deliveryStatus = contacts.isPeerUndeliverable(db, characterId) ? 'peer_undelivered' : 'sent';
    if (!isDreamMode && !isVoiceMode && wantPoke) {
      try {
        const pokeMsg = insertCharacterPokeMessage(characterId, char, settings, { isDream: false });
        systemHints.push(pokeMsg);
        push('ai_poke', {
          characterId,
          charName: char.name,
          text: pokeMsg.content,
          timestamp: pokeMsg.timestamp,
        });
      } catch (e) {
        console.warn('[poke] insert', e.message);
      }
    }
    const { aiMsgId, aiMessages } = saveAiReplySegments(characterId, toSave, char, isDreamMode, {
      voiceCallMode: callSave.voiceCallMode,
      justLeftCall: callSave.justLeftCall,
      userRequestedVoice, deliveryStatus, theater: forTheaterMode,
    });
    if (theaterStartHint) {
      aiMessages.push({
        id: theaterStartHint.id,
        role: 'assistant',
        type: 'system',
        content: theaterStartHint.content,
        timestamp: new Date().toISOString(),
      });
    }
    if (momentChatCue?.momentId) {
      try { claimMomentChatAsk(momentChatCue.momentId, characterId); } catch (_) {}
    }
    if (systemHints.length) {
      aiMessages.unshift(...systemHints.filter((h) => h.type === 'system' && /拍了拍/.test(h.content || '')));
    }
    aiContent = toSave.filter(s => s.type === 'text').map(s => s.content).join('\n')
      || stripImageDirectiveFromSegments([], textContent || aiContent)[0]?.content
      || '';
    const incomingCall = await resolveAndTriggerIncomingCall(char, settings, {
      wantCall,
      rawText: rawForCall,
      processedText: aiContent,
      userMessage: lastUserContent,
      isDream: isDreamMode,
      isVoice: isVoiceMode,
    });
    // 角色写 [挂断]/[end_call]：仅在通话中触发
    try {
      resolveAndTriggerPeerEndCall(char, {
        rawText: rawForCall,
        processedText: aiContent,
        isVoice: isVoiceMode,
        isDream: isDreamMode,
        video: isVideoMode,
        userMessage: lastUserContent,
      });
    } catch (e) {
      console.warn('[call] peer end', e.message);
    }
    if (!isDreamMode && aiContent) {
      try { touchCharacterEmotionFromMessage(characterId, { role: 'assistant', content: aiContent }); } catch (e) {
        console.warn('[emotion] touch assistant', e.message);
      }
    }
    if (recalledMsg) {
      push('message_update', { characterId, id: recalledMsg.id, recalled: true, recalledContent: recalledMsg.content });
    }

    if (!isDreamMode) {
      try { syncScheduleFromChatActivity(characterId, aiContent); } catch (e) {
        console.warn('[schedule] sync from chat', e.message);
      }
      try {
        const um = typeof lastUserContent === 'string' ? lastUserContent : (lastUserMsg?.content || '');
        await require('./travel-arrive-helper').maybeScheduleTravelArrive(
          characterId, um, aiContent, history, {
            settings: getSettings(),
            sourceMsgIds: (aiMessages || [])
              .filter((m) => m && !m.recallAfterSend && (m.type === 'text' || m.type === 'voice') && m.id)
              .map((m) => m.id),
          }
        );
      } catch {}
    }

    const busyPatterns = [
      /我(要|得|先|需要)(去|回去)?(忙|做事|处理|睡觉|睡了|休息)/,
      /我(先|要)(去|忙).{0,6}(了|一会|一下|会儿)/,
      /我(有点|有些|有)事(情)?(要|需要|得)?(忙|处理|做)/,
      /我(先忙|去忙|忙一会|忙一下|忙会儿)/,
      /我(待会|等会)(儿)?(回来|找你|联系你)/,
    ];
    const newBusy = busyAutoReplyEnabled && !isDreamMode && !forTheaterMode
      && Number(char.robot_operating) !== 1
      && busyPatterns.some(p => p.test(aiContent));
    if (newBusy) {
      db.prepare(`UPDATE characters SET status='busy', busy_since=datetime('now') WHERE id=?`).run(characterId);
      push('status_change', { characterId, status: 'busy' });
    }

    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    const userImageRequest = detectUserImageRequest(lastUserMsg?.content || '');
    const userVideoRequest = detectUserVideoRequest(lastUserMsg?.content || '');
    const imgs = await attachReplyImages({
      characterId, char, settings, rawText: rawAiContent, cleanText: aiContent, reqBase, isDreamMode,
      imageQuery: imageIntent.presetQuery,
      videoQuery: imageIntent.videoQuery,
      userImageRequest,
      userVideoRequest,
      userMessage: getUserImageRequestText(history, lastUserMsg?.content) || getUserVideoRequestText(history, lastUserMsg?.content),
    });
    appendImageMessages(aiMessages, imgs);

    try {
      memoryBrain.resolveCompletedTodos(characterId, {
        aiContent,
        recentMessages: history,
        sentImage: !imgs?.mediaBlocked
          && !!(imgs?.selfieImgUrl || imgs?.generalImgUrl || imgs?.imagePending || imgs?.selfiePending),
        sentVideo: !imgs?.mediaBlocked && !!(imgs?.generalVideoUrl || imgs?.videoPending),
      });
    } catch (e) {
      console.warn('[memory] resolve todos', e.message);
    }
    try {
      const travel = require('./process-time-helper');
      const pending = travel.getPending?.(characterId);
      if (pending && (pending.needImage || pending.needVideo) && !imgs?.mediaBlocked
        && (imgs?.selfieImgUrl || imgs?.generalImgUrl || imgs?.generalVideoUrl
          || imgs?.imagePending || imgs?.selfiePending || imgs?.videoPending)) {
        travel.clearPending?.(characterId);
      }
    } catch {}

    const scoreMsg = await attachMusicScoreMessage({
      characterId,
      rawText: rawAiContent,
      cleanText: aiContent,
      char,
      uploadsPath: UPLOADS_PATH,
      isDreamMode,
      deliveryStatus,
      settings,
    });
    if (scoreMsg) aiMessages.push(scoreMsg);
    attachReplyVocal(aiMessages, {
      characterId,
      char,
      play: vocalPrep.play,
      isDreamMode,
      deliveryStatus,
      forVoiceCall: isVoiceMode,
    });
    try {
      const sfxMsgs = await attachSoundFxMessages({
        characterId,
        rawText: rawAiContent,
        cleanText: aiContent,
        settings,
        uploadsPath: UPLOADS_PATH,
        isDreamMode,
        deliveryStatus,
        ...voiceCallSfxExtras(isVoiceMode, char),
      });
      if (sfxMsgs?.length) aiMessages.push(...sfxMsgs);
    } catch (e) {
      console.warn('[sfx]', e.message);
    }

    markUserMessagesReadByPeer(characterId, isDreamMode ? 1 : 0);
    if (!isDreamMode && mode !== 'continue') {
      const trigUserMsgId = lastUserMsg?.id;
      maybeTriggerMemorySummary(characterId, { userMsgId: trigUserMsgId, assistantMsgId: aiMsgId });
    }

    if (!isDreamMode && !robotWillDone && robotInvokeIntent && robotInvokeIntent !== robotUserAskDone) {
      try {
        await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
          intent: robotInvokeIntent,
          proactiveText: aiContent,
          publicBase: reqBase,
          source: 'chat_tag',
          rawAi: rawMergedRobot,
        });
      } catch (e) {
        console.warn('[chat] robot will', e.message);
      }
    } else if (!isDreamMode && !robotInvokeIntent && robotUserAskAfter) {
      try {
        await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
          intent: robotUserAskAfter,
          proactiveText: aiContent,
          publicBase: reqBase,
          source: 'user_ask',
        });
      } catch (e) {
        console.warn('[chat] robot user ask after', e.message);
      }
    }
    if (!isDreamMode) {
      try {
        applyPhoneChatToRobot(characterId, char, settings, rawMergedRobot, aiContent, reqBase, lastUserMsg?.content || '', robotInvokeIntent);
      } catch (e) {
        console.warn('[chat] robot puppet', e.message);
      }
    }

    res.json({
      aiMsgId, content: aiContent, aiMessages, isBusy: newBusy,
      selfieImgId: imgs.selfieImgId, selfieImgUrl: imgs.selfieImgUrl,
      generalImgId: imgs.generalImgId, generalImgUrl: imgs.generalImgUrl,
      generalVideoId: imgs.generalVideoId, generalVideoUrl: imgs.generalVideoUrl,
      imageAttachNote: imgs.imageAttachNote || '',
      selfiePending: !!imgs.selfiePending,
      videoPending: !!imgs.videoPending,
      imagePending: !!imgs.imagePending,
      scoreMsgId: scoreMsg?.id || null,
      avatarUpdated, avatarUrl, peerReadUser: true,
      recalled: recalledMsg ? { id: recalledMsg.id, content: recalledMsg.content } : null,
      peerChange: peerParsed.peerChange || null,
      peerStatus: contacts.getPeerStatus(db, characterId),
      systemHints,
      theaterEnded: !!theaterEnded,
      theaterStarted: !!theaterStarted,
      theaterActive: (forTheaterMode && !theaterEnded) || !!theaterStarted,
      callAmbience: callAmbienceField(isVoiceMode, characterId),
      callLens: callLens || undefined,
      incomingCall: incomingCall || undefined,
    });
    broadcastChatMessage(characterId, aiContent, aiMessages, isDreamMode);
    scheduleSelfieDelivery(imgs.pendingSelfieJob);
    scheduleVideoDelivery(imgs.pendingVideoJob);
    scheduleChatImageDelivery(imgs.pendingImageJob);
  } catch (err) {
    const msg = String(err?.message || err || '');
    // 真正的客户端取消（极少见）；超时已在 fetchWithTimeout 改写成「上游 API 超时」
    if (/^请求已取消$|client.?abort/i.test(msg)) {
      if (!res.headersSent) res.status(499).json({ error: '请求已取消' });
      return;
    }
    console.error('[trigger-ai] error:', msg);
    if (!res.headersSent) {
      res.status(500).json({
        error: formatApiBillingError(msg, { label: '聊天 API' }) || msg,
      });
    }
  } finally {
    try { releaseTriggerLock(); } catch {}
  }
});

function markUserMessagesReadByPeer(charId, dream) {
  db.prepare(`
    UPDATE messages SET is_read=1
    WHERE character_id=? AND is_dream=? AND role='user'
      AND type NOT IN ('system')
      AND (is_read=0 OR is_read IS NULL)
  `).run(charId, dream);
}

function markAssistantMessagesReadByUser(charId, dream, ids) {
  const idList = Array.isArray(ids)
    ? ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (idList.length) {
    const placeholders = idList.map(() => '?').join(',');
    db.prepare(`
      UPDATE messages SET is_read=1
      WHERE character_id=? AND is_dream=? AND role='assistant'
        AND id IN (${placeholders})
        AND (is_read=0 OR is_read IS NULL)
    `).run(charId, dream, ...idList);
    return;
  }
  db.prepare(`
    UPDATE messages SET is_read=1
    WHERE character_id=? AND is_dream=? AND role='assistant'
      AND (is_read=0 OR is_read IS NULL)
  `).run(charId, dream);
}

app.post('/api/messages/:charId/mark-read', (req, res) => {
  const { charId } = req.params;
  const dream = parseInt(req.body?.dream ?? 0);
  markAssistantMessagesReadByUser(charId, dream, req.body?.ids);
  res.json({ ok: true });
});

app.post('/api/messages/:charId/peer-read', (req, res) => {
  const { charId } = req.params;
  const dream = parseInt(req.body?.dream ?? 0);
  markUserMessagesReadByPeer(charId, dream);
  res.json({ ok: true });
});

app.get('/api/messages/unread-summary', (req, res) => {
  const rows = db.prepare(`
    SELECT character_id, COUNT(*) AS n FROM messages
    WHERE role='assistant' AND is_dream=0 AND recalled=0
      AND type NOT IN ('system')
      AND (is_read=0 OR is_read IS NULL)
    GROUP BY character_id
  `).all();
  const out = {};
  rows.forEach(r => { out[r.character_id] = r.n; });
  res.json(out);
});

function notifyProcessStartChanged(charId, opts = {}) {
  if (!charId) return;
  try {
    require('./process-time-helper').onAssistantMessagesChanged(charId, opts);
  } catch {}
}

app.post('/api/messages/recall/:id', (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const recallSeen = msg.role === 'user' && !msg.is_dream && Math.random() < 0.3 ? 1 : 0;
  db.prepare(`UPDATE messages SET recalled=1, recalled_content=content, recall_seen=?, content=? WHERE id=?`).run(
    recallSeen,
    msg.role === 'user' ? '你撤回了一条消息' : '对方撤回了一条消息',
    req.params.id
  );
  if (msg.role === 'assistant' && !msg.is_dream) {
    notifyProcessStartChanged(msg.character_id, { droppedContents: [msg.content] });
  }
  res.json({
    ok: true,
    recallSeen,
    shouldReact: msg.role === 'user' && !msg.is_dream,
    characterId: msg.character_id,
  });
});

app.patch('/api/messages/:id', (req, res) => {
  const { content } = req.body;
  if (!content || !String(content).trim()) return res.status(400).json({ error: '内容不能为空' });
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const trimmed = String(content).trim();
  db.prepare('UPDATE messages SET content=? WHERE id=?').run(trimmed, req.params.id);
  if (msg.role === 'assistant' && !msg.is_dream) {
    notifyProcessStartChanged(msg.character_id, {
      droppedContents: [msg.content],
      remainingContent: trimmed,
    });
  }
  res.json({ ok: true, id: msg.id, content: trimmed });
});

app.delete('/api/messages/:id', (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM messages WHERE id=?').run(req.params.id);
  if (msg && msg.role === 'assistant' && !msg.is_dream) {
    notifyProcessStartChanged(msg.character_id, { droppedContents: [msg.content] });
  }
  res.json({ ok: true });
});

/** 只重roll 这一条图片/视频消息（不删文字、不触发整段 AI 重说） */
app.post('/api/messages/:id/reroll-media', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效消息' });
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    if (msg.role !== 'assistant' || (msg.type !== 'image' && msg.type !== 'video')) {
      return res.status(400).json({ error: '只能重新生成角色发的图片或视频' });
    }
    if (isPendingSelfieContent(msg.content) || isPendingVideoContent(msg.content)) {
      return res.status(400).json({ error: '还在生成中，请稍后再试' });
    }

    let meta = {};
    try { meta = JSON.parse(msg.media_meta || '{}') || {}; } catch { meta = {}; }

    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(msg.character_id);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    const settings = getSettings();
    const reqBase = `${req.protocol}://${req.get('host')}`;
    const kind = meta.kind
      || (msg.type === 'video' ? 'chat_video' : 'selfie');

    if (msg.type === 'video' || kind === 'chat_video') {
      const aspect = normalizeVideoAspect(
        meta.aspect
        || inferChatMediaAspect({
          kind: 'video',
          query: meta.sceneQuery || '',
          char,
        })
      );
      const pending = encodePendingVideo(aspect);
      db.prepare(`UPDATE messages SET content=?, type='video' WHERE id=?`).run(pending, id);
      push('message_update', {
        characterId: msg.character_id,
        id,
        type: 'video',
        content: pending,
        mediaRerolling: true,
      });
      res.json({ ok: true, pending: true, id, type: 'video' });

      scheduleVideoDelivery({
        characterId: msg.character_id,
        settings,
        reqBase,
        char,
        contentForSearch: meta.contentForSearch || meta.sceneQuery || '',
        videoPresetQuery: meta.sceneQuery || null,
        placeholderMsgId: id,
        charName: char.name || '',
        aspect,
        nsfw: !!meta.nsfw,
      });
      return;
    }

    // image: selfie or chat_image
    if (kind === 'chat_image') {
      const aspect = normalizeSelfieAspect(
        meta.aspect
        || inferChatMediaAspect({
          kind: 'image',
          query: meta.presetQuery || '',
          text: meta.contentForImage || meta.presetQuery || '',
          char,
        })
      );
      const pending = encodePendingSelfie(aspect);
      db.prepare(`UPDATE messages SET content=?, type='image' WHERE id=?`).run(pending, id);
      push('message_update', {
        characterId: msg.character_id,
        id,
        type: 'image',
        content: pending,
        mediaRerolling: true,
      });
      res.json({ ok: true, pending: true, id, type: 'image' });

      setImmediate(async () => {
        let url = null;
        try {
          url = await generateChatContextImage(
            settings,
            char,
            meta.contentForImage || meta.presetQuery || 'scene photo',
            meta.presetQuery || null,
            { aspect, nsfw: !!meta.nsfw }
          );
        } catch (e) {
          console.error('[reroll-media/image]', e.message);
        }
        if (!url) {
          const err = (getLastGenerateImageError() || '配图重生成失败').slice(0, 120);
          notifyBillingError('图像 API', err, { characterId: msg.character_id });
          const failedContent = encodeFailedSelfie(aspect);
          try {
            db.prepare(`UPDATE messages SET content=?, type='image' WHERE id=?`).run(failedContent, id);
            patchMediaMetaError(id, err);
          } catch {}
          push('message_update', {
            characterId: msg.character_id,
            id,
            type: 'image',
            content: failedContent,
            selfieFailed: true,
            error: err,
          });
          return;
        }
        url = normalizeChatImageUrl(url);
        if (typeof url === 'string' && url.startsWith('data:')) url = persistGeneratedImageUrl(url);
        try {
          const localized = await localizeMediaToUploads(url, 'image');
          if (localized) url = localized;
        } catch (e) {
          console.warn('[reroll-media/image] localize', e.message);
        }
        db.prepare(`UPDATE messages SET content=?, type='image' WHERE id=?`).run(url, id);
        queueAlbumSave({
          characterId: msg.character_id,
          url,
          mediaType: 'image',
          subject: kind === 'selfie' ? 'self' : 'other',
          description: String(meta.sceneQuery || meta.presetQuery || '').trim().slice(0, 40),
        });
        push('message_update', {
          characterId: msg.character_id,
          id,
          type: 'image',
          content: url,
          selfieReady: true,
        });
      });
      return;
    }

    // selfie（默认）
    const aspect = normalizeSelfieAspect(meta.aspect || char.image_aspect || '3:4');
    const refGroups = normalizeImageRefGroups(char.image_ref || '[]');
    const sceneQuery = meta.sceneQuery || '';
    let outfitOverride = meta.outfitOverride || null;
    if (!outfitOverride) {
      try {
        outfitOverride = require('./wardrobe-helper').detectExplicitOutfitOverride({ sceneQuery });
      } catch {}
    }
    const selfieNsfw = !!meta.nsfw || inferChatMediaNsfwContext({ sceneQuery, char });
    const skipWardrobe = !!(meta.skipWardrobeClothingRefs || outfitOverride?.skipDaily) || selfieNsfw;
    const refFlags = resolveSelfieRefFlags(refGroups, sceneQuery);
    let clothingUrls = [];
    if (!skipWardrobe && !refFlags.useSpecial) {
      try {
        const { collectOutfitClothingRefUrls } = require('./wardrobe-helper');
        const d = new Date();
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        clothingUrls = collectOutfitClothingRefUrls(msg.character_id, dateStr);
      } catch {}
    }
    const imageRefs = [
      ...selectSelfieReferenceUrls(refGroups, sceneQuery),
      ...clothingUrls,
    ].filter(Boolean).slice(0, 5);
    const hasRef = imageRefs.length > 0;
    const selfiePrompt = buildSelfieGenerationPrompt({
      imageStyle: char.image_style || 'anime',
      charName: char.name,
      sceneQuery,
      hasRef,
      hasBodyRef: refFlags.hasBodyRef,
      hasFullBodyRef: refFlags.hasFullBodyRef,
      hasHandRef: refFlags.hasHandRef,
      hasSpecialRef: refFlags.hasSpecialRef,
      specialLabel: refFlags.specialLabel,
      stylePrompt: char.selfie_style_prompt || '',
      aspect,
      char,
      outfitOverride,
      nsfw: selfieNsfw,
    });

    const pending = encodePendingSelfie(aspect);
    db.prepare(`UPDATE messages SET content=?, type='image' WHERE id=?`).run(pending, id);
    if (!meta.kind) {
      try {
        db.prepare(`UPDATE messages SET media_meta=? WHERE id=?`).run(JSON.stringify({
          kind: 'selfie',
          prompt: selfiePrompt,
          sceneQuery,
          aspect,
          outfitOverride: outfitOverride || null,
          skipWardrobeClothingRefs: skipWardrobe,
          nsfw: selfieNsfw,
        }), id);
      } catch {}
    }
    push('message_update', {
      characterId: msg.character_id,
      id,
      type: 'image',
      content: pending,
      mediaRerolling: true,
    });
    res.json({ ok: true, pending: true, id, type: 'image' });

    scheduleSelfieDelivery({
      characterId: msg.character_id,
      settings,
      reqBase,
      selfiePrompt,
      imageRefs,
      hasRef,
      charName: char.name || '',
      placeholderMsgId: id,
      aspect,
      sceneQuery,
      nsfw: selfieNsfw,
    });
  } catch (e) {
    console.error('[reroll-media]', e.message);
    res.status(500).json({ error: e.message || '重新生成失败' });
  }
});

app.post('/api/messages/batch-delete', (req, res) => {
  const bubbles = Array.isArray(req.body?.bubbles) ? req.body.bubbles : null;
  if (bubbles) {
    const fullDeleteIds = new Set();
    const segmentDeletes = {};
    const droppedByChar = {};
    const remainingByChar = {};

    const noteDropped = (msg, text) => {
      if (!msg || msg.role !== 'assistant' || msg.is_dream) return;
      const cid = msg.character_id;
      if (!droppedByChar[cid]) droppedByChar[cid] = [];
      if (text) droppedByChar[cid].push(text);
    };

    for (const bid of bubbles) {
      const s = String(bid || '');
      const hist = s.match(/^hist_(\d+)_(\d+)$/);
      if (hist) {
        const mid = hist[1];
        if (!segmentDeletes[mid]) segmentDeletes[mid] = new Set();
        segmentDeletes[mid].add(parseInt(hist[2], 10));
        continue;
      }
      if (!/^\d+$/.test(s)) continue;
      const id = parseInt(s, 10);
      const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
      if (!msg) continue;
      if (msg.role === 'user' || (msg.type !== 'text' && msg.type !== 'voice') || isCallLineRow(msg)) {
        fullDeleteIds.add(id);
        continue;
      }
      const segs = splitAiSegments(msg.content);
      if (segs.length > 1) {
        if (!segmentDeletes[id]) segmentDeletes[id] = new Set();
        segmentDeletes[id].add(segs.length - 1);
      } else {
        fullDeleteIds.add(id);
      }
    }

    let updated = 0;
    for (const [msgIdStr, idxSet] of Object.entries(segmentDeletes)) {
      const msgId = parseInt(msgIdStr, 10);
      if (fullDeleteIds.has(msgId)) continue;
      const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(msgId);
      if (!msg) continue;
      let segs = splitAiSegments(msg.content);
      for (const i of [...idxSet].sort((a, b) => b - a)) {
        if (i >= 0 && i < segs.length) {
          noteDropped(msg, segs[i]);
          segs.splice(i, 1);
        }
      }
      if (!segs.length) {
        db.prepare('DELETE FROM messages WHERE id=?').run(msgId);
        fullDeleteIds.add(msgId);
      } else {
        const remain = segs.join('\n');
        db.prepare('UPDATE messages SET content=? WHERE id=?').run(remain, msgId);
        if (msg.role === 'assistant' && !msg.is_dream) remainingByChar[msg.character_id] = remain;
        updated++;
      }
    }

    for (const id of fullDeleteIds) {
      const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
      if (msg) noteDropped(msg, msg.content);
      db.prepare('DELETE FROM messages WHERE id=?').run(id);
    }
    const charIds = new Set([...Object.keys(droppedByChar), ...Object.keys(remainingByChar)]);
    for (const cid of charIds) {
      notifyProcessStartChanged(cid, {
        droppedContents: droppedByChar[cid] || [],
        remainingContent: remainingByChar[cid] || '',
      });
    }
    return res.json({ ok: true, deleted: fullDeleteIds.size, updated });
  }

  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const numericIds = [...new Set(ids.map(id => parseInt(id, 10)).filter(n => n > 0))];
  if (!numericIds.length) return res.status(400).json({ error: '没有可删除的消息' });
  const placeholders = numericIds.map(() => '?').join(',');
  const existing = db.prepare(
    `SELECT id, character_id, role, content, is_dream FROM messages WHERE id IN (${placeholders})`
  ).all(...numericIds);
  db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...numericIds);
  const byChar = {};
  for (const msg of existing) {
    if (msg.role !== 'assistant' || msg.is_dream) continue;
    if (!byChar[msg.character_id]) byChar[msg.character_id] = [];
    byChar[msg.character_id].push(msg.content);
  }
  for (const [cid, dropped] of Object.entries(byChar)) {
    notifyProcessStartChanged(cid, { droppedContents: dropped });
  }
  res.json({ ok: true, deleted: numericIds.length });
});

function updateBubbleInDb(bubbleId, content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return { error: '内容不能为空' };
  const s = String(bubbleId);
  const hist = s.match(/^hist_(\d+)_(\d+)$/);
  if (hist) {
    const msgId = parseInt(hist[1], 10);
    const segIdx = parseInt(hist[2], 10);
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(msgId);
    if (!msg) return { error: 'Not found' };
    const segs = splitAiSegments(msg.content);
    if (segIdx < 0 || segIdx >= segs.length) return { error: '气泡不存在' };
    const oldSeg = segs[segIdx];
    segs[segIdx] = trimmed;
    db.prepare('UPDATE messages SET content=? WHERE id=?').run(segs.join('\n'), msgId);
    if (msg.role === 'assistant' && !msg.is_dream) {
      notifyProcessStartChanged(msg.character_id, {
        droppedContents: [oldSeg],
        remainingContent: segs.join('\n'),
      });
    }
    return { ok: true, id: msgId, content: trimmed };
  }
  if (!/^\d+$/.test(s)) return { error: '无效气泡' };
  const id = parseInt(s, 10);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  if (!msg) return { error: 'Not found' };
  if (msg.role === 'user' || isCallLineRow(msg)) {
    db.prepare('UPDATE messages SET content=? WHERE id=?').run(trimmed, id);
    return { ok: true, id, content: trimmed };
  }
  if (msg.type === 'text' || msg.type === 'voice') {
    const segs = splitAiSegments(msg.content);
    const oldContent = msg.content;
    if (segs.length > 1) {
      segs[segs.length - 1] = trimmed;
      db.prepare('UPDATE messages SET content=? WHERE id=?').run(segs.join('\n'), id);
    } else {
      db.prepare('UPDATE messages SET content=? WHERE id=?').run(trimmed, id);
    }
    if (!msg.is_dream) {
      notifyProcessStartChanged(msg.character_id, {
        droppedContents: [oldContent],
        remainingContent: segs.length > 1 ? segs.join('\n') : trimmed,
      });
    }
    return { ok: true, id, content: trimmed };
  }
  return { error: '该类型消息不可编辑' };
}

app.patch('/api/messages/bubble/:bubbleId', (req, res) => {
  const result = updateBubbleInDb(req.params.bubbleId, req.body?.content);
  if (result.error) return res.status(result.error === 'Not found' ? 404 : 400).json({ error: result.error });
  res.json(result);
});

app.delete('/api/messages/character/:charId', (req, res) => {
  const { dream = 0 } = req.query;
  const dreamFlag = parseInt(dream, 10) ? 1 : 0;
  db.prepare('DELETE FROM messages WHERE character_id=? AND is_dream=?').run(req.params.charId, dreamFlag);
  if (!dreamFlag) {
    try { require('./process-time-helper').clearPending(req.params.charId); } catch {}
  }
  res.json({ ok: true });
});

app.post('/api/messages/character/:charId/clear-dream-dates', (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const dates = Array.isArray(req.body?.dates)
    ? req.body.dates.filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];
  if (!dates.length) return res.status(400).json({ error: '请选择要删除的梦境日期' });
  const del = db.prepare(
    `DELETE FROM messages WHERE character_id=? AND is_dream=1 AND timestamp LIKE ?`
  );
  let deleted = 0;
  for (const date of dates) {
    deleted += del.run(charId, `${date}%`).changes;
  }
  res.json({ ok: true, deleted, dates });
});

// ===== SCHEDULES =====
function parseScheduleItems(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function normalizeScheduleItems(items) {
  if (!Array.isArray(items)) return [];
  const { sanitizeRegionPlace } = require('./cron');
  return sortScheduleItemsByTime(items.map(it => ({
    time: String(it?.time || '').trim(),
    activity: String(it?.activity || it?.title || '').trim(),
    place: sanitizeRegionPlace(it?.place).slice(0, 16),
    thought: String(it?.thought || '').trim(),
    execution: String(it?.execution || '').trim(),
  })).filter(it => it.activity));
}

function loadScheduleItemsForDate({ role, characterId, dateStr, persist = true, generatedHint = false }) {
  const row = role === 'user'
    ? db.prepare(`SELECT * FROM schedules WHERE role='user' AND date=? AND character_id IS NULL`).get(dateStr)
    : db.prepare(`SELECT * FROM schedules WHERE character_id=? AND role='ai' AND date=?`).get(characterId, dateStr);
  const raw = parseScheduleItems(row?.items);
  const cleaned = rehomeWeeHoursScheduleItems(
    role === 'user' ? null : characterId,
    role,
    dateStr,
    raw,
    { generated: generatedHint || !!row?.generated }
  );
  if (persist && row && JSON.stringify(cleaned) !== JSON.stringify(raw.map(it => ({
    time: String(it?.time || '').trim(),
    activity: String(it?.activity || it?.title || '').trim(),
    place: String(it?.place || '').trim().slice(0, 16),
    thought: String(it?.thought || '').trim(),
    execution: String(it?.execution || '').trim(),
  })).filter(it => it.activity))) {
    // 凌晨挪走后若白天时段不足，取消 generated，方便补跑重新生成
    const daytimeOk = cleaned.filter(it => {
      const parts = String(it.time || '').split(':');
      const h = parseInt(parts[0], 10);
      return Number.isFinite(h) && h >= 5;
    }).length >= 2;
    const genFlag = daytimeOk ? (row.generated ? 1 : 0) : 0;
    db.prepare(`UPDATE schedules SET items=?, generated=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(cleaned), genFlag, row.id);
  }
  return { row, items: cleaned };
}

app.get('/api/schedules', async (req, res) => {
  const { role = 'ai', charId, date } = req.query;
  const dateStr = scheduleDateStr(date);
  if (role === 'user') {
    const { row, items } = loadScheduleItemsForDate({ role: 'user', dateStr });
    return res.json({
      date: dateStr,
      role: 'user',
      items,
      generated: !!row?.generated,
      id: row?.id || null,
    });
  }
  if (!charId) return res.status(400).json({ error: '缺少 charId' });
  const cid = parseInt(charId, 10);
  const settings = getSettings();
  const todayStr = getLocalDateStr(new Date(), settings.timezone || 'Asia/Shanghai');
  let retrospectMeta = null;
  if (dateStr <= todayStr) {
    retrospectMeta = await maybeFinalizePastScheduleItems(cid, { maxItems: 3, dateStr }).catch(() => null);
  }
  let { row, items } = loadScheduleItemsForDate({ role: 'ai', characterId: cid, dateStr });
  // 次日清晨写了熬到天亮/半夜才睡时，反补「当天」夜里结论，打开昨天也能看见睡没睡
  try {
    const nextStr = (() => {
      const d = new Date(`${dateStr}T12:00:00`);
      d.setDate(d.getDate() + 1);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      return `${y}-${mo}-${da}`;
    })();
    const patched = backfillYesterdayNightSleepConclusion(cid, nextStr)
      || backfillYesterdayNightSleepConclusion(cid, dateStr);
    if (patched) {
      ({ row, items } = loadScheduleItemsForDate({ role: 'ai', characterId: cid, dateStr }));
    }
  } catch {}
  // 打开「今天」且白天行程不完整 → 按周补生成（含本周主线，避免单日出差）
  if (dateStr === todayStr && !scheduleLooksComplete(items)) {
    await generateWeeklySchedules(cid, dateStr, { force: false }).catch(e => {
      console.warn('[schedule] auto-heal week failed', e.message);
      notifyBillingError('日程生成', e.message, { characterId: cid });
    });
    ({ row, items } = loadScheduleItemsForDate({ role: 'ai', characterId: cid, dateStr }));
  }
  res.json({
    date: dateStr,
    role: 'ai',
    characterId: cid,
    items,
    generated: !!row?.generated,
    id: row?.id || null,
    retrospectPending: retrospectMeta?.pending ?? null,
  });
});

app.put('/api/schedules', (req, res) => {
  const { role = 'ai', characterId, date, items } = req.body || {};
  const dateStr = scheduleDateStr(date);
  const normalized = normalizeScheduleItems(items);
  const cleaned = rehomeWeeHoursScheduleItems(
    role === 'user' ? null : Number(characterId) || null,
    role === 'user' ? 'user' : 'ai',
    dateStr,
    normalized,
    { generated: false }
  );
  const json = JSON.stringify(cleaned);
  if (role === 'user') {
    const existing = db.prepare(`SELECT id FROM schedules WHERE role='user' AND date=? AND character_id IS NULL`).get(dateStr);
    if (existing) {
      db.prepare(`UPDATE schedules SET items=?, updated_at=datetime('now') WHERE id=?`).run(json, existing.id);
      return res.json({ ok: true, id: existing.id, items: cleaned });
    }
    const r = db.prepare(`INSERT INTO schedules (character_id, role, date, items, generated) VALUES (NULL,'user',?,?,0)`).run(dateStr, json);
    return res.json({ ok: true, id: r.lastInsertRowid, items: cleaned });
  }
  if (!characterId) return res.status(400).json({ error: '缺少 characterId' });
  const existing = db.prepare(`SELECT id FROM schedules WHERE character_id=? AND role='ai' AND date=?`).get(characterId, dateStr);
  if (existing) {
    db.prepare(`UPDATE schedules SET items=?, updated_at=datetime('now') WHERE id=?`).run(json, existing.id);
    return res.json({ ok: true, id: existing.id, items: cleaned });
  }
  const r = db.prepare(`INSERT INTO schedules (character_id, role, date, items, generated) VALUES (?,?,?,?,0)`).run(characterId, 'ai', dateStr, json);
  return res.json({ ok: true, id: r.lastInsertRowid, items: cleaned });
});

app.get('/api/day-info', (req, res) => {
  const { date } = req.query;
  const dateStr = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  }
  const holiday = require('./holiday-helper');
  const lunar = holiday.solarToLunarLocal(dateStr);
  const holidays = holiday.holidaysOn(dateStr);
  res.json({ date: dateStr, lunar, holidays });
});

app.get('/api/month-info', (req, res) => {
  const { year, month } = req.query;
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return res.status(400).json({ error: 'year 和 month 参数无效' });
  }
  const holiday = require('./holiday-helper');
  const daysInMonth = new Date(y, m, 0).getDate();
  const result = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    result[dateStr] = {
      lunar: holiday.solarToLunarLocal(dateStr),
      holidays: holiday.holidaysOn(dateStr),
    };
  }
  res.json({ year: y, month: m, days: result });
});

app.post('/api/schedules/generate', async (req, res) => {
  try {
    const { characterId, date, force, scope } = req.body || {};
    if (!characterId) return res.status(400).json({ error: '缺少 characterId' });
    const cid = parseInt(characterId, 10);
    const charRow = db.prepare('SELECT schedule_enabled, schedule_week_plan FROM characters WHERE id=?').get(cid);
    if (!charRow) return res.status(404).json({ error: '角色不存在' });
    if (Number(charRow.schedule_enabled) === 0) {
      return res.status(400).json({ error: '该角色已关闭日程，请先在角色编辑里打开' });
    }
    const dateStr = scheduleDateStr(date);
    const wantWeek = scope === 'week' || scope === 'weekly' || !scope;
    if (wantWeek) {
      const week = await generateWeeklySchedules(cid, dateStr, {
        force: !!force,
        forceWeekPlan: !!force,
      });
      if (!week?.days?.length && !week?.plan) {
        return res.status(500).json({ error: '生成本周失败，请检查 API 配置或额度' });
      }
      const todayRow = (week.days || []).find(d => d.date === dateStr)
        || (week.days || []).find(d => d.items?.length);
      // 若只要看当天：再确保当天有条目
      let items = todayRow?.items || [];
      if (!items.length) {
        const one = await generateDailySchedule(cid, dateStr, { force: !!force });
        items = one?.items || [];
      }
      if (!items.length) {
        return res.status(500).json({ error: '生成失败，请检查 API 配置或额度' });
      }
      return res.json({
        ok: true,
        items,
        id: todayRow?.id,
        weekStart: week.weekStart,
        weekPlan: week.plan || null,
        weekDays: (week.days || []).map(d => ({ date: d.date, count: d.items?.length || 0, skipped: !!d.skipped })),
      });
    }
    const result = await generateDailySchedule(cid, dateStr, { force: !!force });
    if (!result?.items?.length) {
      return res.status(500).json({ error: '生成失败，请检查 API 配置或额度' });
    }
    res.json({ ok: true, items: result.items, id: result.id });
  } catch (e) {
    notifyBillingError('日程生成', e.message);
    res.status(500).json({
      error: formatApiBillingError(e.message, { label: '日程生成' }) || e.message,
    });
  }
});

app.post('/api/schedules/retrospect', async (req, res) => {
  try {
    const { characterId, date } = req.body || {};
    if (!characterId) return res.status(400).json({ error: '缺少 characterId' });
    const cid = parseInt(characterId, 10);
    const dateStr = scheduleDateStr(date);
    const meta = await maybeFinalizePastScheduleItems(cid, { maxItems: 6, dateStr });
    const row = db.prepare(`SELECT * FROM schedules WHERE character_id=? AND role='ai' AND date=?`).get(cid, dateStr);
    res.json({
      ok: true,
      items: parseScheduleItems(row?.items),
      filled: meta?.filled ?? 0,
      pending: meta?.pending ?? 0,
    });
  } catch (e) {
    notifyBillingError('日程回顾', e.message);
    res.status(500).json({
      error: formatApiBillingError(e.message, { label: '日程回顾' }) || e.message,
    });
  }
});

/** 日历日心情小黄豆：角色 + 用户 */
app.get('/api/day-moods', (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    const characterId = parseInt(req.query.characterId || req.query.charId, 10) || 0;
    const dayMood = require('./day-mood-helper');
    const result = dayMood.listMonthMoods({ year, month, characterId });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || '加载失败' });
  }
});

app.put('/api/day-moods', (req, res) => {
  try {
    const body = req.body || {};
    const date = String(body.date || '').slice(0, 10);
    const emojiCode = body.emojiCode || body.emoji_code || body.code;
    const owner = String(body.owner || 'user').trim();
    const dayMood = require('./day-mood-helper');
    if (owner === 'char') {
      const characterId = parseInt(body.characterId || body.charId, 10);
      if (!characterId) return res.status(400).json({ error: '缺少 characterId' });
      // 用户纠偏角色贴：source=user，之后睡前 auto 不覆盖
      const r = dayMood.upsertCharMood(characterId, date, emojiCode, {
        source: 'user',
        note: body.note || '',
        overwriteUserEdit: true,
      });
      if (r.error) return res.status(400).json({ error: r.error });
      return res.json(r);
    }
    const r = dayMood.upsertUserMood(date, emojiCode, { note: body.note || '' });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message || '保存失败' });
  }
});

app.delete('/api/day-moods', (req, res) => {
  try {
    const body = req.body || {};
    const owner = String(body.owner || req.query.owner || 'user').trim();
    const date = String(body.date || req.query.date || '').slice(0, 10);
    const characterId = parseInt(body.characterId || body.charId || req.query.characterId || req.query.charId, 10) || 0;
    const dayMood = require('./day-mood-helper');
    const r = dayMood.deleteMood({ owner, date, characterId });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message || '删除失败' });
  }
});

/** 当天时间轴总结：读缓存 / 生成 */
app.get('/api/timeline/day', (req, res) => {
  try {
    const characterId = parseInt(req.query.characterId || req.query.charId, 10);
    const date = String(req.query.date || '').slice(0, 10);
    if (!characterId) return res.status(400).json({ error: '缺少 characterId' });
    res.json(timelineHelper.getCachedDayTimeline(characterId, date));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/timeline/day', async (req, res) => {
  try {
    const characterId = parseInt(req.body?.characterId || req.body?.charId, 10);
    const date = String(req.body?.date || '').slice(0, 10);
    const force = !!(req.body?.force || req.body?.refresh);
    if (!characterId) return res.status(400).json({ error: '缺少 characterId' });
    const result = await timelineHelper.generateDayTimeline(characterId, date, { force });
    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({
      error: formatApiBillingError(e.message) || e.message || '生成失败',
    });
  }
});

// ===== MEMORIES =====
app.get('/api/memories/:charId', (req, res) => {
  const mems = db.prepare('SELECT * FROM memories WHERE character_id=? ORDER BY weight DESC, id DESC').all(req.params.charId);
  res.json(mems);
});

app.post('/api/memories', (req, res) => {
  const { characterId, category, content, weight = 0.5, date } = req.body;
  const r = db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`).run(
    characterId, category, content, weight, date || new Date().toISOString().slice(0, 10)
  );
  try {
    memoryNarrative.scheduleEmbedMemoryIds([r.lastInsertRowid]);
    memoryNarrative.scheduleRouteMemoryIds(characterId, [r.lastInsertRowid]);
  } catch (_) {}
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/memories/:id', (req, res) => {
  const { category, content, weight } = req.body;
  db.prepare(`UPDATE memories SET category=?, content=?, weight=?, embedding='' WHERE id=?`).run(category, content, weight, req.params.id);
  try { memoryNarrative.scheduleEmbedMemoryIds([parseInt(req.params.id, 10)]); } catch (_) {}
  res.json({ ok: true });
});

app.delete('/api/memories/:id', (req, res) => {
  db.prepare('DELETE FROM memories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/memories/character/:charId', (req, res) => {
  db.prepare('DELETE FROM memories WHERE character_id=?').run(req.params.charId);
  try {
    db.prepare('DELETE FROM memory_narratives WHERE character_id=?').run(req.params.charId);
  } catch (_) {}
  try { db.prepare('DELETE FROM memory_links WHERE character_id=?').run(req.params.charId); } catch (_) {}
  res.json({ ok: true });
});

app.get('/api/brain/:charId/now', (req, res) => {
  try {
    const snap = memoryBrain.getBrainNow(parseInt(req.params.charId, 10));
    if (!snap) return res.status(404).json({ error: '角色不存在' });
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/brain/:charId/context-pins/candidates', (req, res) => {
  try {
    const charId = parseInt(req.params.charId, 10);
    const q = String(req.query.q || '');
    res.json({ items: memoryBrain.searchContextPinCandidates(charId, q) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/brain/:charId/context-pins', (req, res) => {
  try {
    const charId = parseInt(req.params.charId, 10);
    const action = String(req.body?.action || '');
    if (!['add', 'remove', 'replace'].includes(action)) {
      return res.status(400).json({ error: '未知操作' });
    }
    const pins = memoryBrain.mutateContextPins(charId, action, req.body?.id, req.body?.replaceId);
    res.json({ ok: true, contextPins: pins });
  } catch (e) {
    const status = e.code === 'PIN_FULL' ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

app.get('/api/brain/:charId/experiences', (req, res) => {
  try {
    res.json(memoryBrain.getBrainExperiences(parseInt(req.params.charId, 10)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/brain/:charId/experiences/:kind/:id', (req, res) => {
  try {
    const kind = String(req.params.kind || '');
    if (kind !== 'narrative' && kind !== 'episode' && kind !== 'branch') {
      return res.status(400).json({ error: '未知类型' });
    }
    const detail = memoryBrain.getExperienceDetail(
      parseInt(req.params.charId, 10),
      kind,
      parseInt(req.params.id, 10),
    );
    if (!detail) return res.status(404).json({ error: '不存在' });
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/brain/:charId/narrative-links/rebuild', (req, res) => {
  try {
    const charId = parseInt(req.params.charId, 10);
    const r = require('./memory-tree-helper').rebuildNarrativeLinks(charId);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message || '重建失败' });
  }
});

app.get('/api/brain/:charId/tidy', (req, res) => {
  try {
    res.json(memoryBrain.getBrainTidy(parseInt(req.params.charId, 10)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/brain/:charId/affection/rebuild', (req, res) => {
  try {
    const affectionHelper = require('./affection-helper');
    const view = affectionHelper.rebuildAffection(parseInt(req.params.charId, 10));
    if (!view) return res.status(404).json({ error: '角色不存在' });
    res.json(view);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 叙事卷 =====
app.get('/api/memory-narratives/item/:id', (req, res) => {
  const n = memoryNarrative.getNarrative(parseInt(req.params.id, 10));
  if (!n) return res.status(404).json({ error: '不存在' });
  const linkedIds = memoryNarrative.parseIds(n.linked_memory_ids);
  const evidence = linkedIds.length
    ? db.prepare(
      `SELECT id, category, content, date, weight FROM memories WHERE id IN (${linkedIds.map(() => '?').join(',')})`
    ).all(...linkedIds)
    : [];
  res.json({
    ...n,
    linked_memory_ids: linkedIds,
    linked_count: linkedIds.length,
    dirty: memoryNarrative.isDirty(n),
    evidence,
  });
});

app.get('/api/memory-narratives/:charId', (req, res) => {
  try {
    const rows = memoryNarrative.listAllNarratives(parseInt(req.params.charId, 10));
    res.json(rows.map((n) => {
      let tree = {};
      try { tree = require('./memory-tree-helper').treeSummary(n); } catch { /* ignore */ }
      return {
        ...n,
        linked_memory_ids: memoryNarrative.parseIds(n.linked_memory_ids),
        linked_count: tree.stageCount || memoryNarrative.linkedCount(n),
        dirty: memoryNarrative.isDirty(n),
        tier: tree.tier,
        branchCount: tree.branchCount || 0,
      };
    }));
  } catch (e) {
    res.status(500).json({ error: e.message || '加载失败' });
  }
});

app.post('/api/memory-narratives/:charId/run', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const heavy = !!(req.body && req.body.heavy);
  try {
    const r = await memoryNarrative.runConsolidationForCharacter(charId, { forceCluster: heavy });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message || '维护失败' });
  }
});

/** 睡前整理：把碎片连接去重、分割成记忆点、按组成部分挂上记忆树 */
app.post('/api/memory-day/:charId/consolidate', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const dateStr = String(req.body?.date || '').trim();
  try {
    const dayHelper = require('./memory-day-helper');
    const pending = dayHelper.pendingFragmentsByDay(charId, { dateStr });
    if (!pending.length) {
      return res.json({
        ok: true, days: 0, points: 0, grafted: 0,
        message: dateStr ? `${dateStr} 没有待整理的碎片` : '没有待整理的碎片——碎片都已经在树上了',
      });
    }
    const r = await dayHelper.consolidateDays(charId, { dateStr });
    const failed = (r.detail || []).filter((d) => d.reason);
    let message;
    if (r.grafted) {
      message = `整理 ${r.days} 天 ${r.points} 个记忆点：新枝干 ${r.newTrunks}，支线 ${r.sideBranches}，延续 ${r.continued}，共挂上 ${r.grafted} 条碎片`;
    } else if (failed.length) {
      const why = {
        llm_failed: '模型没调通（检查记忆通道 API 设置）',
        bad_json: '模型没返回合法 JSON',
        no_points: '模型没分出记忆点',
        no_fragments: '这天没有碎片',
      };
      message = `没能整理：${failed.map((f) => `${f.day} ${why[f.reason] || f.reason}`).join('；')}`;
    } else {
      message = '这些碎片都没能归进记忆点';
    }
    res.json({ ok: true, ...r, message });
  } catch (e) {
    res.status(500).json({ error: e.message || '整理失败' });
  }
});

/** 待整理的碎片有多少、分布在哪几天 */
app.get('/api/memory-day/:charId/pending', (req, res) => {
  try {
    const pending = require('./memory-day-helper').pendingFragmentsByDay(parseInt(req.params.charId, 10));
    res.json({
      ok: true,
      total: pending.reduce((s, d) => s + d.frags.length, 0),
      days: pending.map((d) => ({ day: d.day, count: d.frags.length })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 管家修剪：默认预览；body.apply + plan 才落库 */
app.post('/api/memory-day/:charId/prune', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const narrativeId = req.body?.narrativeId != null ? parseInt(req.body.narrativeId, 10) : 0;
  const forceAll = !!req.body?.forceAll;
  const apply = !!req.body?.apply;
  const plan = req.body?.plan || null;
  try {
    const dayHelper = require('./memory-day-helper');
    const r = await dayHelper.pruneHungTrees(charId, {
      narrativeId: Number.isFinite(narrativeId) && narrativeId > 0 ? narrativeId : undefined,
      forceAll,
      apply,
      plan,
    });
    if (r.ok === false) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    console.error('[memory-day prune]', e.message);
    res.status(500).json({ error: e.message || '修剪失败' });
  }
});

app.post('/api/memory-narratives/item/:id/close', (req, res) => {
  const ok = memoryNarrative.closeNarrative(parseInt(req.params.id, 10));
  res.json({ ok });
});

app.delete('/api/memory-branches/:id', (req, res) => {
  const bid = parseInt(req.params.id, 10);
  try {
    require('./memory-tree-helper').deleteBranch(bid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || '删除失败' });
  }
});

app.delete('/api/memory-narratives/item/:id', (req, res) => {
  const nid = parseInt(req.params.id, 10);
  try { require('./memory-tree-helper').deleteBranchesOf(nid); } catch { /* ignore */ }
  db.prepare('DELETE FROM memory_narratives WHERE id=?').run(nid);
  res.json({ ok: true });
});

function parseButlerJson(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(candidate); } catch {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  return null;
}

app.post('/api/memories/:charId/summarize', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  if (!isMemorySummaryEnabled(char)) {
    return res.status(400).json({ error: '请先在角色设置中开启「自动总结对话记忆」' });
  }

  const settings = getSettings();
  const defaultRounds = parseInt(settings.memory_manual_rounds || '10', 10);
  const rounds = Math.max(1, Math.min(50, parseInt(req.body?.rounds ?? defaultRounds, 10) || defaultRounds));

  try {
    const result = await generateMemorySummary(charId, { rounds, manual: true });
    if (!result?.ok) {
      const msg = result?.reason === 'too_few_messages'
        ? `对话太少（至少需 ${result.count ?? 0} 条，请多聊几句）`
        : result?.reason === 'api_not_configured'
          ? '请先在设置中配置记忆 API'
          : result?.reason === 'no_messages'
            ? '暂无对话可总结'
            : result?.reason === 'error'
              ? (result.message || '总结失败，请稍后再试')
              : '总结失败，请稍后再试';
      return res.status(400).json({ error: msg, ...result });
    }
    const saved = result.saved ?? 0;
    const text = result.skipped
      ? '已处理，本轮对话没有值得长期记住的内容'
      : saved > 0
        ? `已总结最近 ${rounds} 轮对话，写入 ${saved} 条记忆`
        : `已总结最近 ${rounds} 轮对话`;
    res.json({ ok: true, saved, skipped: !!result.skipped, message: text, rounds });
  } catch (e) {
    console.error('[memory] manual summarize', e.message);
    res.status(500).json({ error: formatApiBillingError(e.message, { label: '记忆总结' }) || '总结失败' });
  }
});

/** 从聊天记录按天回填记忆（记忆丢了、聊天还在时用；一个月左右可跑） */
app.post('/api/memories/:charId/backfill', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  if (!isMemorySummaryEnabled(char)) {
    return res.status(400).json({ error: '请先在角色设置中开启「自动总结对话记忆」' });
  }
  const days = Math.max(1, Math.min(90, parseInt(req.body?.days, 10) || 35));
  const force = !!(req.body?.force);
  try {
    const result = await backfillMemoriesFromChat(charId, { days, force });
    if (!result?.ok) {
      const msg = result?.reason === 'disabled'
        ? '请先开启自动总结对话记忆'
        : result?.reason === 'api_not_configured'
          ? '请先在设置中配置记忆 API'
          : '回填失败，请稍后再试';
      return res.status(400).json({ error: msg, ...result });
    }
    const text = `已扫 ${result.daysScanned} 天：写入 ${result.saved} 条，处理 ${result.processed} 天，跳过 ${result.skipped} 天${result.failed ? `，失败 ${result.failed} 天` : ''}`;
    res.json({ ...result, message: text });
  } catch (e) {
    console.error('[memory] backfill', e.message);
    res.status(500).json({ error: formatApiBillingError(e.message, { label: '记忆回填' }) || '回填失败' });
  }
});

app.post('/api/memories/:charId/butler', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const complaint = String(req.body?.complaint || '').trim();
  const mode = req.body?.mode === 'clean' ? 'clean' : 'diagnose';
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const settings = getSettings();
  const username = settings.username || '旅人';
  const allMemories = db.prepare('SELECT * FROM memories WHERE character_id=? ORDER BY id DESC').all(charId);
  const recentMsgs = db.prepare(
    `SELECT role, content, timestamp FROM messages WHERE character_id=? AND is_dream=0 AND recalled=0 AND (type IS NULL OR type != 'system') ORDER BY id DESC LIMIT 40`
  ).all(charId).reverse();

  const chatContext = recentMsgs.map(m =>
    `${m.role === 'user' ? username : char.name}：${String(m.content || '').replace(/^【自动回复】/, '').slice(0, 220)}`
  ).join('\n');

  const contextText = buildChatContextText(complaint, recentMsgs);
  const injected = selectMemoriesForPrompt(char, contextText);
  const injectedIds = new Set(injected.map(m => m.id));
  const notInjected = allMemories.filter(m => !injectedIds.has(m.id));

  const systemFacts = {
    totalMemories: allMemories.length,
    injectedNow: injected.length,
    notInjectedNow: notInjected.length,
    memorySummaryEnabled: isMemorySummaryEnabled(char),
    memoryTriggerN: getMemoryTriggerN(getSettings(), char),
    memoryKeywords: char.memory_keywords || '',
    unsplashConfigured: !!(settings.unsplash_api_key || '').trim(),
  };

  const memList = allMemories.map(m => ({
    id: m.id,
    category: m.category,
    content: m.content,
    weight: m.weight,
    date: m.date,
    currentlyInjected: injectedIds.has(m.id),
  }));

  const injectionNote = injected.length
    ? injected.map(m => `#${m.id}[${m.category}] ${m.content}`).join('\n')
    : '（当前话题下没有记忆被注入）';

  const systemPrompt = mode === 'clean'
    ? `你是「记忆管家」——负责整理、打扫角色记忆库。
用户希望记忆不要碎片化、不要重复、不要断章取义，且每条应有明确日期语境。

请通读全部记忆，输出 JSON（不要 markdown 代码块）：
{
  "diagnosis": "2-4句整理总结",
  "causes": ["当前问题1", "问题2"],
  "items": [
    {
      "memory_id": 数字或null,
      "merge_ids": [应合并删除的其他记忆id],
      "severity": "high|medium|low",
      "issue_type": "duplicate|vague|outdated|wrong|conflict",
      "title": "简短标题",
      "explanation": "说明",
      "suggestion": "edit|delete|merge|add_new|ignore",
      "suggested_content": "合并/修改后的完整记忆（含日期语境，如「2026年7月1日晚上，用户说…」）"
    }
  ],
  "missing_suggestions": [],
  "tips": ["后续维护建议"]
}
规则：优先 merge 重复碎片；delete 无价值断章；edit 修正表述并补日期；suggested_content 必须是可直接入库的完整句子。`
    : `你是「记忆管家」——念 App 里帮助用户诊断「角色为什么没记住该记住的事」的助手。
【念的记忆机制】
1. 近窗按「用户一轮」携带最近对话原文（系统气泡不占配额）。长期记忆改成【脑海】短闪（约 4～6 条），像忽然想起，不是分类清单。
2. 过时事实（status=historical / fact_key 被取代）默认不注入；话题不相关的经历也不会闪过——角色「不记得」不一定是丢了。
3. 自动记忆总结需开启，且每 N 轮对话才触发一次；闲聊不进经历；日程回顾会写成经历包。聊得少时凌晨补总结昨日；用户说「记住/约定」等可额外触发。
4. 碎片重复、互相矛盾、跨天同一件事被拆开，会导致混乱；整理页可消化叙事卷、归档过时条目。

请结合用户抱怨、最近聊天、全部记忆条目、当前会被注入的记忆，输出 JSON（不要 markdown 代码块）：
{
  "diagnosis": "2-4句总体诊断",
  "causes": ["原因1", "原因2"],
  "items": [
    {
      "memory_id": 数字或null,
      "severity": "high|medium|low",
      "issue_type": "not_injected|conflict|duplicate|vague|outdated|wrong|missing",
      "title": "简短标题",
      "explanation": "说明",
      "suggestion": "edit|delete|merge|ignore|add_new",
      "suggested_content": "若建议修改/新增则给出内容，否则空字符串"
    }
  ],
  "missing_suggestions": ["建议新增的记忆主题"],
  "tips": ["给用户的操作提示"]
}`;

  const userContent = [
    `【用户描述的问题】${complaint || '（未填写，请根据最近聊天推断用户可能在抱怨什么）'}`,
    `【角色】${char.name}`,
    `【系统状态】${JSON.stringify(systemFacts)}`,
    `【当前会被注入的记忆】\n${injectionNote}`,
    `【最近聊天】\n${chatContext || '（无）'}`,
    `【全部记忆 ${allMemories.length} 条】\n${JSON.stringify(memList)}`,
  ].join('\n\n');

  const endpoint = (settings.memory_api_url || settings.chat_api_url || '').trim();
  const apiKey = (settings.memory_api_key || settings.chat_api_key || '').trim();
  if (!endpoint || !apiKey) {
    return res.status(400).json({
      error: '请先在设置中配置记忆或聊天 API',
      systemFacts,
      injectedMemories: injected,
      notInjectedSample: notInjected.slice(0, 8),
    });
  }

  try {
    let parsed = null;
    const raw = await callChatAPIComplete(settings, systemPrompt, userContent, 'memory');
    parsed = parseButlerJson(raw);
    if (!parsed) {
      const raw2 = await callChatAPIComplete(settings, systemPrompt, userContent, 'chat');
      parsed = parseButlerJson(raw2);
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const enrichedItems = items.map(item => {
      const mem = item.memory_id ? allMemories.find(m => m.id === item.memory_id) : null;
      return { ...item, memory: mem || null };
    });

    res.json({
      mode,
      diagnosis: parsed?.diagnosis || '管家暂时无法给出完整诊断，请查看下方系统分析。',
      causes: parsed?.causes || [],
      items: enrichedItems,
      missing_suggestions: parsed?.missing_suggestions || [],
      tips: parsed?.tips || [],
      systemFacts,
      injectedMemories: injected.map(m => ({ id: m.id, category: m.category, content: m.content })),
      notInjectedCount: notInjected.length,
    });
  } catch (e) {
    console.error('[memory-butler]', e.message);
    res.status(500).json({
      error: e.message || '诊断失败',
      systemFacts,
      injectedMemories: injected.map(m => ({ id: m.id, category: m.category, content: m.content })),
      tips: [
        !isMemorySummaryEnabled(char) ? '可在角色设置中开启「自动总结对话记忆」' : null,
        allMemories.length < 5 ? '记忆条目较少，可以多聊几轮或手动添加记忆' : null,
        notInjected.length > 0 ? `有 ${notInjected.length} 条记忆因话题不匹配当前未注入，聊天时换相关话题才会被唤起` : null,
      ].filter(Boolean),
    });
  }
});

// ===== DIARIES =====
app.get('/api/diaries', (req, res) => {
  const { charId, role, meta } = req.query;
  // 书架只需要计数：不拉正文/贴纸，显著加快秘密首页
  if (meta === '1' || meta === 'counts') {
    let q = 'SELECT id, character_id, role, date FROM diaries WHERE 1=1';
    const params = [];
    if (charId) { q += ' AND character_id=?'; params.push(charId); }
    if (role) { q += ' AND role=?'; params.push(role); }
    q += ' ORDER BY date DESC, id DESC';
    return res.json(db.prepare(q).all(...params));
  }
  let q = 'SELECT * FROM diaries WHERE 1=1';
  const params = [];
  if (charId) { q += ' AND character_id=?'; params.push(charId); }
  if (role) { q += ' AND role=?'; params.push(role); }
  q += ' ORDER BY date DESC, id DESC';
  const rows = db.prepare(q).all(...params);
  res.json(rows.map(r => ({
    ...r,
    visible_to: (() => { try { return JSON.parse(r.visible_to || '[]'); } catch { return []; } })(),
    char_peeks: (() => { try { return JSON.parse(r.char_peeks || '[]'); } catch { return []; } })(),
  })));
});

app.post('/api/diaries', (req, res) => {
  const { characterId, role, title, content, date, visible_to } = req.body;
  const diaryRole = role || 'user';
  const r = db.prepare(`INSERT INTO diaries (character_id, role, title, content, date, visible_to) VALUES (?,?,?,?,?,?)`).run(
    characterId || null, diaryRole, title || '', content, date || new Date().toISOString().slice(0, 10),
    JSON.stringify(visible_to || [])
  );
  const diaryId = r.lastInsertRowid;
  res.json({ id: diaryId });
  if (diaryRole === 'user') {
    const delay = 15000 + Math.floor(Math.random() * 90000);
    setTimeout(() => {
      checkAiPeekSecrets({ focusDiaryId: diaryId }).catch(e => console.error('[diary] peek schedule error', e.message));
    }, delay);
  }
});

app.post('/api/diaries/generate-ai/:charId', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id, diary_enabled, timezone, source, circle_npc_id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  if (contacts.isCircleNpcCharacter(char)) {
    return res.status(400).json({ error: '圈子好友不支持日记' });
  }
  if (Number(char.diary_enabled) === 0) {
    return res.status(400).json({ error: '该角色已关闭日记，请先在角色编辑里打开' });
  }

  const settings = getSettings();
  const tz = char.timezone || settings.timezone || 'Asia/Shanghai';
  const todayLocal = getLocalDateStr(new Date(), tz);
  // 未指定日期：默认补齐近几天缺口（中断一两天后日期才对得上）
  const wantBackfill = !req.body?.date && (req.body?.backfill !== false);

  if (wantBackfill) {
    try {
      const lookback = Math.max(1, Math.min(14, parseInt(req.body?.lookback, 10) || 7));
      // force 只清「昨天」那条，避免误删整段历史
      if (req.body?.force) {
        const yesterday = shiftDateStr(todayLocal, -1);
        db.prepare(`DELETE FROM diaries WHERE character_id=? AND role='ai' AND date=?`).run(charId, yesterday);
      }
      const r = await catchUpMissedDiaries({ charId, lookback });
      const latest = db.prepare(
        `SELECT * FROM diaries WHERE character_id=? AND role='ai' ORDER BY date DESC LIMIT 1`
      ).get(charId);
      if (!r.generated && !latest) {
        return res.status(400).json({
          error: '近几天没有可生成的日记（可能没有聊天记录，或日记/聊天 API 未配置）',
        });
      }
      return res.json({
        ok: true,
        generated: r.generated || 0,
        lookback,
        diary: latest || null,
        message: r.generated
          ? `已补齐 ${r.generated} 篇缺失日记`
          : '近几天日记已齐全',
      });
    } catch (e) {
      console.error('[diary] backfill generate error', e.message);
      return res.status(500).json({
        error: formatApiBillingError(e.message, { label: '日记生成' }) || e.message || '生成失败',
      });
    }
  }

  const diaryDate = String(req.body.date || shiftDateStr(todayLocal, -1)).slice(0, 10);

  if (req.body?.force) {
    db.prepare(`DELETE FROM diaries WHERE character_id=? AND role='ai' AND date=?`).run(charId, diaryDate);
  }

  const existing = db.prepare(`SELECT id FROM diaries WHERE character_id=? AND role='ai' AND date=?`).get(charId, diaryDate);
  if (existing && !req.body?.force) {
    const row = db.prepare(`SELECT * FROM diaries WHERE id=?`).get(existing.id);
    return res.json({ ok: true, skipped: true, diary: row, message: '该日期已有日记' });
  }

  try {
    await generateAIDiary(charId, diaryDate);
    const row = db.prepare(`SELECT * FROM diaries WHERE character_id=? AND role='ai' AND date=?`).get(charId, diaryDate);
    if (!row) {
      return res.status(400).json({
        error: `未生成 ${diaryDate} 的日记（该日可能没有聊天记录，或日记/聊天 API 未配置）`,
      });
    }
    res.json({ ok: true, diary: row });
  } catch (e) {
    console.error('[diary] manual generate error', e.message);
    res.status(500).json({
      error: formatApiBillingError(e.message, { label: '日记生成' }) || e.message || '生成失败',
    });
  }
});

app.put('/api/diaries/:id', (req, res) => {
  const { title, content, visible_to } = req.body;
  db.prepare(`UPDATE diaries SET title=?, content=?, visible_to=? WHERE id=?`).run(
    title, content, JSON.stringify(visible_to || []), req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/diaries/:id', (req, res) => {
  db.prepare('DELETE FROM diaries WHERE id=?').run(req.params.id);
  db.prepare(`DELETE FROM secret_stickers WHERE owner_type='diary' AND owner_id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/diaries/:id/decorate-stickers', (req, res) => {
  try {
    const { decorateDiaryWithStickers } = require('./secret-helper');
    const n = decorateDiaryWithStickers(Number(req.params.id), req.body?.charId);
    res.json({ ok: true, added: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/diaries/:id/peek', async (req, res) => {
  const diary = db.prepare('SELECT * FROM diaries WHERE id=?').get(req.params.id);
  if (!diary) return res.status(404).json({ error: 'Not found' });

  if (diary.role === 'user' && req.body.by === 'ai') {
    const settings = getSettings();
    const charId = req.body.charId;
    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    // 检查该角色是否已偷看过
    let peeks = [];
    try { peeks = JSON.parse(diary.char_peeks || '[]'); } catch {}
    const alreadyPeeked = peeks.find(p => p.charId == charId);
    if (alreadyPeeked) {
      return res.json({ ok: true, secret: alreadyPeeked.secretNote, alreadyPeeked: true });
    }

    // 检查该日记是否对该角色可见
    let visibleTo = [];
    try { visibleTo = JSON.parse(diary.visible_to || '[]'); } catch {}
    if (visibleTo.length > 0 && !visibleTo.includes(Number(charId)) && !visibleTo.includes(String(charId))) {
      return res.status(403).json({ error: '该日记对此角色不可见' });
    }

    const { systemPrompt, userContent } = buildDiaryPeekPrompt(char, settings, diary.content, { maxChars: 60 });
    try {
      const secret = await callChatAPI(settings, systemPrompt, userContent, 'chat');
      const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
      peeks.push({ charId: Number(charId), charName: char.name, charAvatar: char.avatar || '', peekedAt: now, secretNote: secret || '' });
      db.prepare(`UPDATE diaries SET ai_peeked=1, ai_peeked_at=datetime('now'), ai_secret_note=?, char_peeks=? WHERE id=?`)
        .run(secret || '', JSON.stringify(peeks), req.params.id);
      res.json({ ok: true, secret, charName: char.name });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else if (diary.role === 'ai' && req.body.by === 'user') {
    db.prepare(`UPDATE diaries SET user_peeked=1 WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } else {
    res.json({ ok: true });
  }
});

// 将偷看心里话存入角色记忆
app.post('/api/diaries/:id/save-peek-to-memory', (req, res) => {
  const { charId, secretNote } = req.body;
  const diary = db.prepare('SELECT * FROM diaries WHERE id=?').get(req.params.id);
  if (!diary) return res.status(404).json({ error: 'Not found' });
  const date = diary.date || new Date().toISOString().slice(0, 10);
  const r = db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
    .run(charId, '秘密偷看', `[偷看了用户秘密后的心里话] ${secretNote}`, 0.7, date);
  res.json({ id: r.lastInsertRowid });
});

// ===== SECRET NOTES（备忘录 / 我们 / 心事）=====
function parsePeeksJson(raw) {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

app.get('/api/secret-notes', (req, res) => {
  const { charId, section, date, role } = req.query;
  const rows = listSecretNotes({
    characterId: charId !== undefined && charId !== '' ? charId : undefined,
    section: section || undefined,
    date: date || undefined,
    role: role || undefined,
  });
  res.json(rows.map(r => ({
    ...r,
    peeks: parsePeeksJson(r.peeks),
  })));
});

app.post('/api/secret-notes', (req, res) => {
  const {
    characterId = 0, role = 'ai', section, content, noteAt, date, source = 'manual', confirmed = 1,
  } = req.body || {};
  if (!(ALL_SECTIONS || SECRET_SECTIONS).includes(section)) {
    return res.status(400).json({ error: 'section must be memo|us|heart' });
  }
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: 'content required' });
  }
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const day = date || getLocalDateStr(new Date(), tz);
  const id = insertSecretNote({
    characterId: Number(characterId) || 0,
    role: role === 'user' ? 'user' : 'ai',
    section,
    content,
    noteAt: noteAt || noteAtNow(tz),
    date: day,
    source,
    confirmed: confirmed ? 1 : 0,
  });
  if (!id) return res.status(409).json({ error: '重复或无效内容' });
  const row = db.prepare('SELECT * FROM secret_notes WHERE id=?').get(id);
  res.json({ id, note: { ...row, peeks: parsePeeksJson(row.peeks) } });
  if (role === 'user' && section === 'memo') {
    const delay = 15000 + Math.floor(Math.random() * 90000);
    setTimeout(() => {
      checkAiPeekSecrets({ focusNoteId: id }).catch(e => console.error('[secret] peek schedule error', e.message));
    }, delay);
  }
});

app.patch('/api/secret-notes/:id', (req, res) => {
  const note = db.prepare('SELECT * FROM secret_notes WHERE id=?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  const { content, noteAt, note_at, date, confirmed, section } = req.body || {};
  const nextNoteAt = noteAt ?? note_at ?? note.note_at;
  let nextContent = content != null ? String(content).trim() : note.content;
  const nextSection = section && (ALL_SECTIONS || SECRET_SECTIONS).includes(section) ? section : note.section;
  const maxLen = nextSection === 'memo' ? 20000 : 220;
  nextContent = nextContent.slice(0, maxLen);
  if (!nextContent) return res.status(400).json({ error: 'content empty' });
  db.prepare(
    `UPDATE secret_notes SET content=?, note_at=?, date=?, confirmed=?, section=? WHERE id=?`
  ).run(
    nextContent,
    nextNoteAt,
    date ?? note.date,
    confirmed != null ? (confirmed ? 1 : 0) : note.confirmed,
    nextSection,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/secret-notes/:id', (req, res) => {
  db.prepare('DELETE FROM secret_notes WHERE id=?').run(req.params.id);
  db.prepare(`DELETE FROM secret_stickers WHERE owner_type='note' AND owner_id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/secret-notes/generate', async (req, res) => {
  const charId = parseInt(req.body?.charId ?? req.body?.characterId, 10);
  if (!charId) return res.status(400).json({ error: 'charId required' });
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const date = req.body?.date || getLocalDateStr(new Date(), tz);
  try {
    const result = await generateSecretNotesForDay(charId, date, { force: !!req.body?.force });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || '生成失败' });
  }
});

// ===== TA 情侣应用 =====
app.get('/api/ta', (req, res) => {
  try {
    res.json(require('./ta-helper').publicSnapshot());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/ta/bind', (req, res) => {
  try {
    const characterId = parseInt(req.body?.characterId ?? req.body?.charId, 10);
    if (!characterId) return res.status(400).json({ error: 'characterId required' });
    const r = require('./ta-helper').bindCharacter(characterId);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, ...require('./ta-helper').publicSnapshot() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ta/unbind', (req, res) => {
  try {
    const r = require('./ta-helper').unbind({ by: 'user' });
    res.json({ ok: true, ...r, ...require('./ta-helper').publicSnapshot() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ta/share-usage', (req, res) => {
  try {
    const on = !!(req.body?.on ?? req.body?.enabled ?? req.body?.shareUsage);
    require('./ta-helper').setShareUsage(on);
    res.json({ ok: true, ...require('./ta-helper').publicSnapshot() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ta/battery-alert', (req, res) => {
  try {
    const on = !!(req.body?.on ?? req.body?.enabled ?? req.body?.batteryAlert);
    require('./ta-helper').setBatteryAlert(on);
    res.json({ ok: true, ...require('./ta-helper').publicSnapshot() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ta/usage', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.json({ ok: false, error: 'unbound' });
    if (!ta.shareUsageOn()) return res.json({ ok: false, error: 'usage_off', shareUsage: false });
    res.json(require('./ta-usage-helper').getMutualUsage(cid));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== TA 相册 =====
app.get('/api/ta/album', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const album = require('./ta-album-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    const photos = album.listPhotos(cid, {
      limit: parseInt(req.query.limit, 10) || 60,
      beforeId: parseInt(req.query.beforeId, 10) || 0,
    });
    res.json({ ok: true, photos, album: album.snapshotForTa(cid) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ta/album/:id', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const album = require('./ta-album-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    const photo = album.getPhoto(parseInt(req.params.id, 10), cid);
    if (!photo) return res.status(404).json({ error: '照片不存在' });
    res.json({ ok: true, photo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ta/album', upload.single('file'), async (req, res) => {
  try {
    const ta = require('./ta-helper');
    const album = require('./ta-album-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    let url = String(req.body?.url || '').trim();
    let takenAt = String(req.body?.takenAt || '').trim();
    let location = String(req.body?.location || '').trim();
    let lat = req.body?.lat != null ? Number(req.body.lat) : null;
    let lng = req.body?.lng != null ? Number(req.body.lng) : null;
    const caption = String(req.body?.caption || '').trim();

    if (req.file) {
      url = `/uploads/${req.file.filename}`;
      try {
        const exif = await album.extractExifFromFile(req.file.path);
        if (!takenAt && exif.takenAt) takenAt = exif.takenAt;
        if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && Number.isFinite(exif.lat) && Number.isFinite(exif.lng)) {
          lat = exif.lat;
          lng = exif.lng;
        }
      } catch {}
    }
    if (!url) return res.status(400).json({ error: '请上传照片' });
    if ((!location || location === '未知') && Number.isFinite(lat) && Number.isFinite(lng)) {
      try {
        const place = await album.reversePlace(lat, lng);
        if (place) location = place;
      } catch {}
    }
    const photo = album.insertPhoto({
      characterId: cid,
      role: 'user',
      url,
      caption,
      takenAt,
      location,
      lat,
      lng,
    });
    res.json({ ok: true, photo, album: album.snapshotForTa(cid) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/ta/album/:id', async (req, res) => {
  try {
    const ta = require('./ta-helper');
    const album = require('./ta-album-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    const photo = album.updatePhotoMeta(parseInt(req.params.id, 10), cid, {
      caption: req.body?.caption,
      takenAt: req.body?.takenAt,
      location: req.body?.location,
      lat: req.body?.lat,
      lng: req.body?.lng,
    });
    res.json({ ok: true, photo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/ta/album/:id', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const album = require('./ta-album-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    album.deletePhoto(parseInt(req.params.id, 10), cid);
    res.json({ ok: true, album: album.snapshotForTa(cid) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/ta/album/:id/comments', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const album = require('./ta-album-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    const comment = album.addComment({
      photoId: parseInt(req.params.id, 10),
      characterId: cid,
      role: 'user',
      content: req.body?.content || req.body?.text || '',
    });
    res.json({ ok: true, comment, photo: album.getPhoto(parseInt(req.params.id, 10), cid) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== 写真馆 =====
app.get('/api/photostudio/meta', (req, res) => {
  try {
    res.json({ ok: true, ...require('./photostudio-helper').meta() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/photostudio/sessions', (req, res) => {
  try {
    const studio = require('./photostudio-helper');
    res.json({ ok: true, sessions: studio.listSessions(parseInt(req.query.limit, 10) || 20) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/photostudio/sessions', (req, res) => {
  try {
    const studio = require('./photostudio-helper');
    const session = studio.createSession({ characterIds: req.body?.characterIds || [] });
    res.json({ ok: true, session });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/photostudio/sessions/:id', (req, res) => {
  try {
    const session = require('./photostudio-helper').getSession(parseInt(req.params.id, 10));
    if (!session) return res.status(404).json({ error: '场次不存在' });
    res.json({ ok: true, session });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/photostudio/sessions/:id', (req, res) => {
  try {
    const studio = require('./photostudio-helper');
    const session = studio.updateSession(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true, session });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/photostudio/sessions/:id/jobs', (req, res) => {
  try {
    const studio = require('./photostudio-helper');
    const sid = parseInt(req.params.id, 10);
    if (!studio.getSession(sid)) return res.status(404).json({ error: '场次不存在' });
    res.json({ ok: true, jobs: studio.listJobs(sid) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/photostudio/jobs/:id', (req, res) => {
  try {
    const job = require('./photostudio-helper').getJob(parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: '任务不存在' });
    res.json({ ok: true, job });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/photostudio/sessions/:id/tryon', (req, res) => {
  try {
    const studio = require('./photostudio-helper');
    const publicBase = `${req.protocol}://${req.get('host')}`;
    const job = studio.queueTryOn(parseInt(req.params.id, 10), {
      subject: req.body?.subject,
      items: req.body?.items || [],
    }, { getSettings, publicBase });
    res.json({ ok: true, job });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/photostudio/sessions/:id/confirm-look', (req, res) => {
  try {
    const studio = require('./photostudio-helper');
    const result = studio.confirmLook(parseInt(req.params.id, 10), {
      subject: req.body?.subject,
      resultUrl: req.body?.resultUrl,
      items: req.body?.items,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/photostudio/sessions/:id/shoot', (req, res) => {
  try {
    const studio = require('./photostudio-helper');
    const publicBase = `${req.protocol}://${req.get('host')}`;
    const result = studio.queueShoot(parseInt(req.params.id, 10), {
      albumTarget: req.body?.albumTarget,
    }, { getSettings, publicBase });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/ta/studio-album', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const studio = require('./photostudio-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    const photos = studio.listStudioPhotos(cid, {
      limit: parseInt(req.query.limit, 10) || 60,
      beforeId: parseInt(req.query.beforeId, 10) || 0,
    });
    res.json({ ok: true, photos, album: studio.snapshotStudioAlbum(cid) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/ta/studio-album/:id', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const studio = require('./photostudio-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    studio.deleteStudioPhoto(parseInt(req.params.id, 10), cid);
    res.json({ ok: true, album: studio.snapshotStudioAlbum(cid) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== 跨时空邮局 =====
app.get('/api/post-office/meta', (req, res) => {
  try {
    res.json(require('./post-office-helper').meta());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/post-office/parcels', (req, res) => {
  try {
    const po = require('./post-office-helper');
    const cid = req.query.characterId || req.query.charId || null;
    res.json({ parcels: po.listParcels(cid ? parseInt(cid, 10) : null) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/post-office/parcels/:id', (req, res) => {
  try {
    const parcel = require('./post-office-helper').getParcel(parseInt(req.params.id, 10));
    if (!parcel) return res.status(404).json({ error: '包裹不存在' });
    res.json({ parcel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/post-office/parcels', (req, res) => {
  try {
    const po = require('./post-office-helper');
    const body = req.body || {};
    const parcel = po.createParcel({
      characterId: body.characterId ?? body.charId,
      category: body.category,
      clothingSlot: body.clothingSlot || body.clothing_slot || '',
      name: body.name || '',
      note: body.note || '',
      message: body.message || body.giftMessage || body.gift_message || '',
      notifyTransit: body.notifyTransit ?? body.notify_transit ?? false,
      imageUrl: body.imageUrl || body.image_url || '',
      letterContent: body.letterContent || body.letter_content || body.content || '',
    });
    res.json({ ok: true, parcel });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== TA 信箱 =====
app.get('/api/ta/letters', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const letter = require('./letter-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    res.json(letter.listLetters(cid, { viewer: 'user' }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ta/letters', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const letter = require('./letter-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    const posted = letter.postLetter({
      characterId: cid,
      content: req.body?.content || req.body?.text || '',
      role: 'user',
      replyToId: req.body?.replyToId || null,
    });
    res.json({ ok: true, letter: posted, ...letter.listLetters(cid, { viewer: 'user' }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/ta/letters/:id/read', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const letter = require('./letter-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    const row = letter.markLetterRead(parseInt(req.params.id, 10), { by: 'user' });
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, letter: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ta/letters/read-all', (req, res) => {
  try {
    const ta = require('./ta-helper');
    const letter = require('./letter-helper');
    const cid = ta.boundCharacterId();
    if (!cid) return res.status(400).json({ error: '请先绑定 TA' });
    const n = letter.markAllDeliveredRead(cid, { by: 'user' });
    res.json({ ok: true, read: n, ...letter.listLetters(cid, { viewer: 'user' }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 共享备忘录（取代「我们」）=====
app.get('/api/shared-memos', (req, res) => {
  try {
    res.json(sharedMemo.listSharedMemoBooks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/shared-memos', (req, res) => {
  try {
    const characterId = parseInt(req.body?.characterId ?? req.body?.charId, 10);
    if (!characterId) return res.status(400).json({ error: 'characterId required' });
    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    if (!contacts.isIntimateFriend(contacts.enrichCharacter(db, char))) {
      return res.status(403).json({ error: '加好友后才能开随手记' });
    }
    const book = sharedMemo.getOrCreateBook(characterId, req.body?.title);
    const full = sharedMemo.getBook(book.id);
    res.json(full);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/shared-memos/:bookId', (req, res) => {
  const book = sharedMemo.getBook(req.params.bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.json(book);
});

app.put('/api/shared-memos/:bookId', (req, res) => {
  try {
    const book = sharedMemo.updateBook(req.params.bookId, req.body || {});
    if (!book) return res.status(404).json({ error: 'Not found' });
    res.json(book);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/shared-memos/:bookId/entries', (req, res) => {
  const book = sharedMemo.getBook(req.params.bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.json(sharedMemo.listEntries(book.id, {
    since: req.query?.since,
    date: req.query?.date,
    lite: req.query?.lite,
  }));
});

app.post('/api/shared-memos/:bookId/entries', async (req, res) => {
  const book = sharedMemo.getBook(req.params.bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });
  const {
    content = '', images = [], emojis = [], replyToId = null, scheduleReply = true,
  } = req.body || {};
  const imgs = Array.isArray(images) ? images.filter(Boolean).slice(0, 9) : [];
  const ems = Array.isArray(emojis) ? emojis.slice(0, 12) : [];
  if (!String(content || '').trim() && !imgs.length && !ems.length) {
    return res.status(400).json({ error: '请写点内容、图片或表情' });
  }
  try {
    const entry = sharedMemo.insertEntry({
      bookId: book.id,
      role: 'user',
      content: String(content || '').trim(),
      images: imgs,
      emojis: ems,
      replyToId: replyToId ? Number(replyToId) : null,
      status: 'visible',
    });
    let jobId = null;
    if (scheduleReply !== false) {
      jobId = sharedMemo.enqueueReactJob(book.id, book.character_id, entry.id, 'react');
    }
    push('shared_memo_updated', { bookId: book.id, characterId: book.character_id, entryId: entry.id, fromAi: false });
    res.json({ ok: true, entry, jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/shared-memos/:bookId/ai-write', async (req, res) => {
  const book = sharedMemo.getBook(req.params.bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });
  const withImage = !!req.body?.withImage;
  const replyToId = req.body?.replyToId ? Number(req.body.replyToId) : null;
  const trigger = replyToId
    ? db.prepare('SELECT * FROM shared_memo_entries WHERE id=? AND book_id=?').get(replyToId, book.id)
    : null;
  const reqBase = `${req.protocol}://${req.get('host')}`;
  try {
    const entry = await sharedMemo.generateAiMemoEntry({
      bookId: book.id,
      characterId: book.character_id,
      triggerEntry: trigger,
      withImage,
      publicBase: reqBase,
    });
    push('shared_memo_updated', { bookId: book.id, characterId: book.character_id, entryId: entry.id, fromAi: true });
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(500).json({ error: formatApiBillingError(e.message) || e.message || '生成失败' });
  }
});

app.patch('/api/shared-memos/:bookId/entries/:entryId', (req, res) => {
  try {
    const book = sharedMemo.getBook(req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Not found' });
    const entryId = Number(req.params.entryId);
    if (!Array.isArray(req.body?.annotations) && req.body?.annotation == null) {
      return res.status(400).json({ error: '需要 annotations 或 annotation' });
    }
    let entry;
    if (req.body?.annotation) {
      entry = sharedMemo.updateEntryAnnotations(book.id, entryId, [req.body.annotation], {
        merge: true,
        by: 'user',
      });
    } else {
      entry = sharedMemo.updateEntryAnnotations(book.id, entryId, req.body.annotations, {
        merge: !!req.body?.merge,
        by: 'user',
      });
    }
    if (!entry) return res.status(404).json({ error: 'Not found' });
    if (entry.role === 'ai' && (req.body?.annotation || (req.body?.annotations || []).length)) {
      try {
        sharedMemo.enqueueReactJob(book.id, book.character_id, entry.id, 'annotate');
      } catch (e) {
        console.warn('[shared-memo] enqueue annotate', e.message);
      }
    }
    push('shared_memo_updated', {
      bookId: book.id, characterId: book.character_id, entryId: entry.id, fromAi: false, annotated: true,
    });
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(500).json({ error: e.message || '更新失败' });
  }
});

app.delete('/api/shared-memos/:bookId/entries/:entryId', (req, res) => {
  const book = sharedMemo.getBook(req.params.bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare('SELECT id FROM shared_memo_entries WHERE id=? AND book_id=?')
    .get(req.params.entryId, book.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  sharedMemo.deleteEntry(row.id);
  res.json({ ok: true });
});

app.delete('/api/shared-memos/:bookId/days/:date', (req, res) => {
  const book = sharedMemo.getBook(req.params.bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });
  const deleted = sharedMemo.deleteEntriesByDate(book.id, req.params.date);
  if (!deleted) return res.status(404).json({ error: '该日没有内容' });
  res.json({ ok: true, deleted });
});

app.delete('/api/shared-memos/:bookId', (req, res) => {
  const book = sharedMemo.getBook(req.params.bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });
  sharedMemo.deleteBook(book.id);
  res.json({ ok: true });
});

app.post('/api/secret-notes/:id/peek', async (req, res) => {
  const note = db.prepare('SELECT * FROM secret_notes WHERE id=?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  const peeks = parsePeeksJson(note.peeks);

  if (note.role === 'user' && req.body?.by === 'ai') {
    const charId = req.body.charId;
    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
    if (!char) return res.status(404).json({ error: 'Character not found' });
    const already = peeks.find(p => p.charId == charId);
    if (already) return res.json({ ok: true, secret: already.secretNote, alreadyPeeked: true });

    const { systemPrompt, userContent } = buildDiaryPeekPrompt(
      char, getSettings(),
      `[${note.section === 'memo' ? '备忘录' : note.section}] ${note.content}`,
      { maxChars: 60 }
    );
    try {
      const secret = await callChatAPI(getSettings(), systemPrompt, userContent, 'chat');
      const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
      peeks.push({
        charId: Number(charId), charName: char.name, charAvatar: char.avatar || '',
        peekedAt: now, secretNote: secret || '', section: note.section, targetId: note.id,
      });
      db.prepare('UPDATE secret_notes SET peeks=? WHERE id=?').run(JSON.stringify(peeks), note.id);
      res.json({ ok: true, secret, charName: char.name });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else {
    res.json({ ok: true, peeks });
  }
});

app.post('/api/secret-notes/:id/save-peek-to-memory', (req, res) => {
  const { charId, secretNote } = req.body || {};
  const note = db.prepare('SELECT * FROM secret_notes WHERE id=?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  const date = note.date || new Date().toISOString().slice(0, 10);
  const r = db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
    .run(charId, '秘密偷看', `[偷看了用户秘密后的心里话] ${secretNote}`, 0.7, date);
  res.json({ id: r.lastInsertRowid });
});

// ===== SECRET STICKERS =====
app.get('/api/secret-stickers', (req, res) => {
  const { ownerType, ownerId } = req.query;
  if (!ownerType || ownerId == null) return res.status(400).json({ error: 'ownerType and ownerId required' });
  const rows = db.prepare(
    `SELECT * FROM secret_stickers WHERE owner_type=? AND owner_id=? ORDER BY id`
  ).all(ownerType, Number(ownerId));
  res.json(rows);
});

app.post('/api/secret-stickers', (req, res) => {
  const { ownerType, ownerId, emojiId, unicode = '', x = 0.5, y = 0.5, scale = 1 } = req.body || {};
  if (!ownerType || ownerId == null) return res.status(400).json({ error: 'ownerType and ownerId required' });
  const r = db.prepare(
    `INSERT INTO secret_stickers (owner_type, owner_id, emoji_id, unicode, x, y, scale) VALUES (?,?,?,?,?,?,?)`
  ).run(ownerType, Number(ownerId), emojiId || null, unicode || '', Number(x) || 0.5, Number(y) || 0.5, Number(scale) || 1);
  res.json({ id: r.lastInsertRowid });
});

app.patch('/api/secret-stickers/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM secret_stickers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { x, y, scale, unicode, emojiId } = req.body || {};
  db.prepare(
    `UPDATE secret_stickers SET x=?, y=?, scale=?, unicode=?, emoji_id=? WHERE id=?`
  ).run(
    x != null ? Number(x) : row.x,
    y != null ? Number(y) : row.y,
    scale != null ? Number(scale) : row.scale,
    unicode != null ? unicode : row.unicode,
    emojiId !== undefined ? emojiId : row.emoji_id,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/secret-stickers/:id', (req, res) => {
  db.prepare('DELETE FROM secret_stickers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== MOMENTS =====
function parseMomentAtName(raw) {
  return String(raw || '').replace(/[，,。！？!?、；;：:\s]+$/g, '');
}

function enrichMomentMentions(content, mentions, chars) {
  const list = Array.isArray(mentions) ? [...mentions] : [];
  const seen = new Set(list.filter(m => m && m.charId).map(m => Number(m.charId)));
  for (const match of String(content || '').matchAll(/@(\S+)/g)) {
    const name = parseMomentAtName(match[1]);
    const char = chars.find(c => c.name === name);
    if (char && !seen.has(Number(char.id))) {
      list.push({ name: char.name, charId: char.id, type: 'char' });
      seen.add(Number(char.id));
    }
  }
  return list;
}

function getMomentMentionCharIds(m, chars) {
  const ids = new Set();
  let mentions = [];
  try { mentions = JSON.parse(m.mentions || '[]'); } catch {}
  for (const x of mentions) {
    if (x?.type === 'char' && x.charId) ids.add(Number(x.charId));
  }
  for (const match of String(m.content || '').matchAll(/@(\S+)/g)) {
    const name = parseMomentAtName(match[1]);
    const char = chars.find(c => c.name === name);
    if (char) ids.add(Number(char.id));
  }
  return [...ids];
}

function getMentionCharIdsFromText(text, chars) {
  const ids = new Set();
  for (const match of String(text || '').matchAll(/@(\S+)/g)) {
    const name = parseMomentAtName(match[1]);
    const char = chars.find(c => c.name === name);
    if (char) ids.add(Number(char.id));
  }
  return [...ids];
}

function scheduleMomentInteractions(momentId, enrichedMentions, content, chars) {
  const mentionIds = getMomentMentionCharIds({ content, mentions: JSON.stringify(enrichedMentions) }, chars);
  setImmediate(async () => {
    try {
      if (mentionIds.length) {
        for (let i = 0; i < mentionIds.length; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 2000 + Math.random() * 4000));
          await aiInteractWithMoment(momentId, mentionIds[i]);
        }
        // @ 完角色后，再让开了互动开关的 NPC 来逛逛
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
        await aiNpcInteractWithMoment(momentId).catch(() => {});
      } else {
        await new Promise(r => setTimeout(r, (20 + Math.random() * 70) * 1000));
        await aiInteractWithMoment(momentId);
      }
    } catch (e) {
      console.error('[auto-interact]', e.message);
    }
  });
}

/** 仅当整段被一对方括号包住、且不是小黄豆时才剥外层（勿误伤 [微笑]） */
function stripOuterCommentBrackets(s) {
  const t = String(s || '').trim();
  if (!/^\[[^\[\]]+\]$/.test(t)) return t;
  const inner = t.slice(1, -1).trim();
  if (isKnownBean(inner)) return t;
  return inner;
}

function parseMomentAiResponse(raw, isMentioned) {
  const text = String(raw || '').trim();
  if (!text) return { shouldLike: false, commentText: '' };

  if (isMentioned) {
    let commentText = text.replace(/^评论[：:]\s*/, '').trim();
    if (!commentText || commentText === '无') {
      const cm = text.match(/评论[：:]\s*(.+)/s);
      commentText = cm?.[1]?.trim() || text;
    }
    commentText = stripOuterCommentBrackets(commentText).slice(0, 120);
    commentText = sanitizeInlineBeans(commentText, {
      skipCooldown: true,
      allowSameTriple: true,
      maxBeans: 2,
    });
    return { shouldLike: true, commentText };
  }

  const likeMatch = text.match(/点赞[：:]\s*(是|否)/);
  const commentMatch = text.match(/评论[：:]\s*(.+)/s);
  let commentText = commentMatch?.[1]?.trim() || '';
  if ((!commentText || commentText === '无') && !commentMatch) {
    // 模型没按格式输出时，整段当作评论
    if (text.length > 1 && !/^点赞[：:]/m.test(text)) commentText = text.slice(0, 120);
  }
  commentText = stripOuterCommentBrackets(commentText).trim();
  if (commentText && commentText !== '无') {
    commentText = sanitizeInlineBeans(commentText, {
      skipCooldown: true,
      allowSameTriple: true,
      maxBeans: 2,
    }).slice(0, 120);
  }
  return { shouldLike: likeMatch?.[1] === '是', commentText };
}

function appendMomentInteraction(momentId, { like, comment }) {
  const m = db.prepare('SELECT likes, comments, role, character_id FROM moments WHERE id=?').get(momentId);
  if (!m) return { likes: [], comments: [] };

  let likes = [];
  let comments = [];
  try { likes = JSON.parse(m.likes || '[]'); } catch {}
  try { comments = JSON.parse(m.comments || '[]'); } catch {}

  if (like) {
    const likeKey = like.key
      || (like.npcId != null ? `npc_${like.npcId}` : null)
      || (like.charId != null ? `char_${like.charId}` : null);
    const exists = likes.some((l) => {
      if (typeof l !== 'object' || !l) return false;
      if (likeKey && l.key === likeKey) return true;
      if (like.npcId != null && Number(l.npcId) === Number(like.npcId)) return true;
      if (like.charId != null && Number(l.charId) === Number(like.charId)) return true;
      return false;
    });
    if (!exists) likes.push({ ...like, key: likeKey || like.key });
  }
  if (comment) {
    const dup = comments.some((c) => {
      if (comment.role === 'npc') {
        return c.role === 'npc' && Number(c.npcId) === Number(comment.npcId);
      }
      return c.role === 'ai' && Number(c.characterId) === Number(comment.characterId);
    });
    if (!dup) comments.push(comment);
  }

  db.prepare('UPDATE moments SET likes=?, comments=? WHERE id=?').run(
    JSON.stringify(likes), JSON.stringify(comments), momentId
  );
  return { likes, comments, moment: m };
}

function buildGameSummaryFallback(history, charName, username, gameName) {
  const parts = (history || []).slice(-12)
    .filter(h => h && h.content)
    .map(h => {
      const who = h.role === 'user' ? (username || '用户') : charName;
      return `${who}：${String(h.content).slice(0, 80)}`;
    });
  if (!parts.length) return `与${charName}一起玩了「${gameName || '游戏'}」。`;
  return `与${charName}玩「${gameName || '游戏'}」：${parts.join('；')}`.slice(0, 480);
}

async function safeChatComplete(settings, systemPrompt, userContent) {
  try {
    const r = await callChatAPIComplete(settings, systemPrompt, userContent, 'chat');
    if (r) return r;
  } catch (e) { console.error('[safeChatComplete chat]', e.message); }
  try {
    const r = await callChatAPIComplete(settings, systemPrompt, userContent, 'memory');
    if (r) return r;
  } catch (e) { console.error('[safeChatComplete memory]', e.message); }
  return null;
}

async function appendMomentAiComment(momentId, task) {
  const m = db.prepare('SELECT * FROM moments WHERE id=?').get(momentId);
  if (!m) return;
  const settings = getSettings();
  let comments = [];
  try { comments = JSON.parse(m.comments || '[]'); } catch {}

  let char = null;
  let systemPrompt = '';
  let userContent = '';

  if (task.type === 'reply_thread') {
    char = db.prepare('SELECT * FROM characters WHERE id=?').get(task.replyCharId);
    if (!char) return;
    const postIsUser = m.role === 'user' || !m.character_id;
    const sceneNote = postIsUser
      ? `用户「${task.username || 'TA'}」在自己的朋友圈下回复了你的评论。`
      : `用户「${task.username || 'TA'}」在你发的朋友圈动态下回复了你的评论。`;
    systemPrompt = buildSystemPrompt(char, settings,
      `${sceneNote}请用1-2句话自然地继续对话，像微信评论一样简短口语，直接输出回复正文，不要加引号或前缀。`
    );
    userContent = `朋友圈内容：${m.content}\n你之前的评论：${task.replyToComment || ''}\n用户的回复：${task.content}`;
  } else if (task.type === 'post_owner') {
    char = db.prepare('SELECT * FROM characters WHERE id=?').get(m.character_id);
    if (!char) return;
    const commentUserName = task.username || settings.username || '旅人';
    systemPrompt = buildSystemPrompt(char, settings,
      `有人在你发的朋友圈动态下评论了。请用1-2句话简短自然地回复，像真实社交软件一样随性。`
    );
    userContent = `你的动态内容：${m.content}\n评论内容：${task.content}`;
    task.replyToUserName = commentUserName;
  } else if (task.type === 'npc_comment_owner_reply') {
    char = db.prepare('SELECT * FROM characters WHERE id=?').get(m.character_id);
    if (!char) return;
    const npcName = task.npcName || '熟人';
    const alreadyReplied = comments.some((c) => (
      c.role === 'ai'
      && Number(c.characterId || c.charId) === Number(char.id)
      && (
        (task.npcId != null && Number(c.replyToNpcId) === Number(task.npcId))
        || (c.replyToNpcName && c.replyToNpcName === npcName)
      )
    ));
    if (alreadyReplied) return;
    systemPrompt = buildSystemPrompt(char, settings,
      `熟人「${npcName}」在你发的朋友圈动态下评论了。请用1-2句话简短自然地回复对方，像微信评论一样口语随性；直接输出回复正文，不要加引号或前缀，也不要复述整条动态。`
    );
    userContent = `你的动态内容：${m.content}\n${npcName}的评论：${task.content}`;
    task.replyToNpcName = npcName;
  } else {
    return;
  }

  try {
    let aiReply = await callChatAPI(settings, systemPrompt, userContent, 'chat');
    aiReply = stripActions(aiReply || '');
    try {
      const { scrubUserVisibleText } = require('./emoji-helper');
      aiReply = scrubUserVisibleText(aiReply, char?.mindset);
    } catch {}
    if (!aiReply) return;

    comments.push({
      role: 'ai',
      content: aiReply,
      characterId: char.id,
      charName: char.name,
      charAvatar: char.avatar || '',
      replyToUserName: task.replyToUserName || null,
      replyToNpcName: task.replyToNpcName || null,
      replyToNpcId: task.npcId || null,
      time: new Date().toISOString(),
    });
    db.prepare('UPDATE moments SET comments=? WHERE id=?').run(JSON.stringify(comments), momentId);
    push('moment_comment', {
      momentId,
      charName: char.name,
      charId: char.id,
      charAvatar: char.avatar || '',
      content: aiReply,
      isReply: true,
    });
  } catch (e) {
    console.error('[moment-ai-reply]', e.message);
  }
}

/** 角色动态下：对尚未回复的 NPC 评论补主人回复，返回条数 */
async function replyOwnerToNpcComments(momentId) {
  const m = db.prepare('SELECT * FROM moments WHERE id=?').get(momentId);
  if (!m || m.role !== 'ai' || !m.character_id) return 0;
  let comments = [];
  try { comments = JSON.parse(m.comments || '[]'); } catch {}
  const npcComments = comments.filter((c) => c.role === 'npc' || c.isNpc || c.npcId);
  if (!npcComments.length) return 0;
  const unanswered = npcComments.filter((nc) => {
    const npcId = nc.npcId;
    const npcName = nc.charName || nc.username;
    return !comments.some((c) => (
      c.role === 'ai'
      && Number(c.characterId || c.charId) === Number(m.character_id)
      && (
        (npcId != null && Number(c.replyToNpcId) === Number(npcId))
        || (npcName && c.replyToNpcName === npcName)
      )
    ));
  });
  let n = 0;
  for (const nc of unanswered.slice(0, 2)) {
    await appendMomentAiComment(momentId, {
      type: 'npc_comment_owner_reply',
      npcId: nc.npcId,
      npcName: nc.charName || nc.username || '熟人',
      content: nc.content,
    });
    n += 1;
    if (unanswered.length > 1) await new Promise((r) => setTimeout(r, 1200));
  }
  return n;
}

function parseMoment(m) {
  let likes = [];
  try { likes = JSON.parse(m.likes || '[]'); } catch {}
  let comments = [];
  try { comments = JSON.parse(m.comments || '[]'); } catch {}
  let images = [];
  try { images = JSON.parse(m.images || '[]'); } catch {}
  let mentions = [];
  try { mentions = JSON.parse(m.mentions || '[]'); } catch {}
  return { ...m, images, likes, comments, mentions, location: m.location || '' };
}

function selectMomentRow(id) {
  return db.prepare(
    `SELECT m.*, c.name as char_name, c.avatar as char_avatar FROM moments m LEFT JOIN characters c ON m.character_id=c.id WHERE m.id=?`
  ).get(id);
}

app.get('/api/moments', (req, res) => {
  const { limit = 30, offset = 0, characterId, sinceId, lite } = req.query;
  const lim = parseInt(limit, 10) || 30;
  const off = parseInt(offset, 10) || 0;
  const afterId = parseInt(sinceId, 10) || 0;
  const isLite = lite === '1' || lite === 1 || lite === true || lite === 'true';
  // lite 模式：列表只返回必要字段，likes/comments 留给 delta 拉，减少 JSON 解析
  const cols = isLite
    ? `m.id, m.character_id, m.role, m.content, m.images, m.created_at, m.location, m.mentions, m.chat_asked, c.name as char_name, c.avatar as char_avatar`
    : `m.*, c.name as char_name, c.avatar as char_avatar`;
  let sql = `SELECT ${cols} FROM moments m LEFT JOIN characters c ON m.character_id=c.id`;
  const params = [];
  const where = [];
  if (characterId) {
    where.push('m.character_id=?');
    params.push(parseInt(characterId, 10));
  }
  if (afterId > 0) {
    where.push('m.id > ?');
    params.push(afterId);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY m.id DESC LIMIT ? OFFSET ?`;
  params.push(lim, off);
  res.json(db.prepare(sql).all(...params).map(parseMoment));
});

app.get('/api/moments/delta', (req, res) => {
  const sinceId = parseInt(req.query.sinceId, 10) || 0;
  const characterId = req.query.characterId ? parseInt(req.query.characterId, 10) : 0;
  const lim = Math.min(parseInt(req.query.limit, 10) || 30, 50);
  const ids = String(req.query.ids || '')
    .split(',')
    .map((n) => parseInt(n, 10))
    .filter((n) => n > 0)
    .slice(0, 80);

  let newerSql = `SELECT m.*, c.name as char_name, c.avatar as char_avatar FROM moments m LEFT JOIN characters c ON m.character_id=c.id WHERE m.id > ?`;
  const newerParams = [sinceId];
  if (characterId) {
    newerSql += ` AND m.character_id=?`;
    newerParams.push(characterId);
  }
  newerSql += ` ORDER BY m.id DESC LIMIT ?`;
  newerParams.push(lim);
  const newer = db.prepare(newerSql).all(...newerParams).map(parseMoment);

  let interactions = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    let interSql = `SELECT id, likes, comments FROM moments WHERE id IN (${placeholders})`;
    const interParams = [...ids];
    if (characterId) {
      interSql += ` AND character_id=?`;
      interParams.push(characterId);
    }
    interactions = db.prepare(interSql).all(...interParams).map((m) => {
      let likes = [];
      try { likes = JSON.parse(m.likes || '[]'); } catch {}
      let comments = [];
      try { comments = JSON.parse(m.comments || '[]'); } catch {}
      return { id: m.id, likes, comments };
    });
  }
  res.json({ newer, interactions });
});

app.get('/api/moments/:id', (req, res) => {
  const row = selectMomentRow(req.params.id);
  if (!row) return res.status(404).json({ error: '动态不存在' });
  res.json(parseMoment(row));
});

app.post('/api/moments', (req, res) => {
  const { characterId, role, content, images, location = '', mentions = [] } = req.body;
  const chars = db.prepare('SELECT id, name FROM characters').all();
  const enrichedMentions = enrichMomentMentions(content, mentions, chars);
  const r = db.prepare(`INSERT INTO moments (character_id, role, content, images, location, mentions) VALUES (?,?,?,?,?,?)`).run(
    characterId || null, role || 'user', content || '', JSON.stringify(images || []),
    location || '', JSON.stringify(enrichedMentions)
  );
  const momentId = r.lastInsertRowid;
  const row = selectMomentRow(momentId);
  res.json(row ? parseMoment(row) : { id: momentId });

  // 用户发帖后，被 @ 的角色约 4–30 秒内回复；未 @ 时 1–5 分钟内随机互动
  if ((role || 'user') === 'user') {
    scheduleMomentInteractions(momentId, enrichedMentions, content, chars);
  }
});

// 点赞：支持用户名字符串和角色对象 { type:'char', charId, charName, charAvatar }
app.post('/api/moments/:id/like', (req, res) => {
  const m = db.prepare('SELECT * FROM moments WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  let likes = [];
  try { likes = JSON.parse(m.likes || '[]'); } catch {}
  const { username, charId, charName, charAvatar } = req.body;

  if (charId) {
    // 角色点赞：用对象存储
    const key = `char_${charId}`;
    const already = likes.find(l => (typeof l === 'object' ? l.key === key : l === username));
    if (!already) likes.push({ key, charId, charName, charAvatar: charAvatar || '' });
  } else {
    if (!likes.find(l => l === username || l?.key === `user_${username}`)) {
      likes.push(username);
    }
  }
  db.prepare('UPDATE moments SET likes=? WHERE id=?').run(JSON.stringify(likes), m.id);
  res.json({ ok: true, likes });
});

app.post('/api/moments/:id/unlike', (req, res) => {
  const m = db.prepare('SELECT * FROM moments WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  let likes = [];
  try { likes = JSON.parse(m.likes || '[]'); } catch {}
  const { username } = req.body;
  likes = likes.filter(l => l !== username && l?.key !== `user_${username}`);
  db.prepare('UPDATE moments SET likes=? WHERE id=?').run(JSON.stringify(likes), m.id);
  res.json({ ok: true, likes });
});

app.post('/api/moments/:id/comment', async (req, res) => {
  const m = db.prepare('SELECT * FROM moments WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  let comments = [];
  try { comments = JSON.parse(m.comments || '[]'); } catch {}
  const { content, characterId, role, username, avatar, replyToCharId, replyToCharName, replyToComment } = req.body;
  const replyCharId = replyToCharId ? parseInt(replyToCharId, 10) : null;

  comments.push({
    role: role || 'user',
    content,
    characterId: characterId || null,
    username: username || null,
    avatar: avatar || null,
    replyToCharId: replyCharId,
    replyToCharName: replyToCharName || null,
    replyToComment: replyToComment || null,
    time: new Date().toISOString(),
  });

  const isUserPost = m.role === 'user' || !m.character_id;
  const needsReplyToChar = role === 'user' && replyCharId;
  const needsPostOwnerReply = role === 'user' && m.character_id && !replyCharId;

  db.prepare('UPDATE moments SET comments=? WHERE id=?').run(JSON.stringify(comments), m.id);
  res.json({ ok: true, comments: [...comments] });

  if (needsReplyToChar) {
    setImmediate(() => appendMomentAiComment(m.id, {
      type: 'reply_thread',
      replyCharId,
      replyToComment,
      content,
      username,
    }).catch(e => console.error('[moment-reply]', e.message)));
  } else if (needsPostOwnerReply) {
    setImmediate(() => appendMomentAiComment(m.id, {
      type: 'post_owner',
      content,
      username,
    }).catch(e => console.error('[moment-reply]', e.message)));
  }

  if (isUserPost && (role || 'user') === 'user') {
    const chars = db.prepare('SELECT id, name FROM characters').all();
    const commentMentions = getMentionCharIdsFromText(content, chars);
    if (commentMentions.length) {
      setImmediate(async () => {
        for (let i = 0; i < commentMentions.length; i++) {
          if (replyCharId && commentMentions[i] === replyCharId) continue;
          if (i > 0) await new Promise(r => setTimeout(r, 1500 + Math.random() * 2500));
          try { await aiInteractWithMoment(m.id, commentMentions[i]); } catch (e) {
            console.error('[moment-mention-comment]', e.message);
          }
        }
      });
    }
  }
});

// AI主动互动：让所有角色对一条动态点赞+评论
// 核心AI互动逻辑（可被cron和接口复用）
function listMutualNpcsForMoment(moment) {
  try {
    const circleHelper = require('./circle-helper');
    let rows;
    if (moment?.character_id) {
      // 优先：挂在该角色圈子下的 NPC；若圈子未绑角色，也纳入开了互评的 NPC（旧数据）
      rows = db.prepare(`
        SELECT n.* FROM circle_npcs n
        LEFT JOIN circles c ON c.id = n.circle_id
        WHERE COALESCE(n.moments_mutual_with_chars, 0) = 1
          AND (
            c.character_id = ?
            OR c.character_id IS NULL
            OR c.character_id = 0
          )
        ORDER BY n.id ASC
      `).all(moment.character_id) || [];
    } else {
      rows = db.prepare(`
        SELECT n.* FROM circle_npcs n
        WHERE COALESCE(n.moments_mutual_with_chars, 0) = 1
          AND n.circle_id IS NOT NULL
        ORDER BY n.id ASC
      `).all() || [];
    }
    return rows.map((r) => circleHelper.enrichNpc(r));
  } catch (e) {
    console.warn('[moments] listMutualNpcs', e.message);
    return [];
  }
}

function shuffleTake(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}

/** NPC（开了「与角色朋友圈互动」）给角色/用户动态点赞评论 */
async function aiNpcInteractWithMoment(momentId) {
  const m = db.prepare('SELECT * FROM moments WHERE id=?').get(momentId);
  if (!m) return { results: [] };

  const settings = getSettings();
  const allNpcs = listMutualNpcsForMoment(m);
  if (!allNpcs.length) return { results: [] };

  // 最多 3 个 NPC，避免刷屏；每人约 70% 概率出手；若全被滤掉则至少试 1 个
  let candidates = shuffleTake(allNpcs, 6).filter(() => Math.random() < 0.7).slice(0, 3);
  if (!candidates.length && allNpcs.length) {
    candidates = shuffleTake(allNpcs, 1);
  }
  if (!candidates.length) return { results: [] };

  let images = [];
  try { images = JSON.parse(m.images || '[]'); } catch {}
  const imageNote = images.length ? `\n（附带${images.length}张图片）` : '';
  const posterLabel = m.role === 'user' || !m.character_id
    ? (settings.username || '旅人')
    : (db.prepare('SELECT name FROM characters WHERE id=?').get(m.character_id)?.name || '朋友');

  const results = [];
  const circleHelper = require('./circle-helper');

  for (let i = 0; i < candidates.length; i++) {
    const npc = candidates[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 2500 + Math.random() * 6000));

    const fresh = db.prepare('SELECT likes, comments FROM moments WHERE id=?').get(momentId);
    let likes = [];
    let comments = [];
    try { likes = JSON.parse(fresh?.likes || '[]'); } catch {}
    try { comments = JSON.parse(fresh?.comments || '[]'); } catch {}

    const alreadyLiked = likes.some((l) => typeof l === 'object' && Number(l.npcId) === Number(npc.id));
    const alreadyCommented = comments.some((c) => c.role === 'npc' && Number(c.npcId) === Number(npc.id));
    if (alreadyLiked && alreadyCommented) continue;

    const personaBits = [
      npc.personality && `性格：${npc.personality}`,
      npc.language_style && `语言风格（说话必须贴近）：\n${String(npc.language_style).slice(0, 800)}`,
      npc.intro && `简介：${npc.intro}`,
      npc.relationship && `与用户关系：${npc.relationship}`,
      npc.remark && `备注：${npc.remark}`,
    ].filter(Boolean).join('\n');

    const systemPrompt = `你是「${npc.name}」，在一个社交软件上浏览朋友圈。
${personaBits || '你是一个普通熟人。'}
请用符合人设与语言风格的口吻决定是否点赞、是否评论。评论要短（不超过 28 字）、口语、自然，不要解释规则。
严格按两行格式回复：
点赞：是或否
评论：你的评论（不想评论就写「无」）`;

    const userContent = `发帖人：${posterLabel}
动态内容：${m.content || '（无文字）'}${imageNote}${m.location ? `\n位置：${m.location}` : ''}`;

    try {
      let raw = await callChatAPI(settings, systemPrompt, userContent, 'chat');
      raw = stripActions(raw || '');
      if (!raw) continue;
      const parsed = parseMomentAiResponse(raw, false);
      let commentText = String(parsed.commentText || '').trim();
      const shouldLike = parsed.shouldLike;
      const willComment = commentText && commentText !== '无' && commentText.length >= 1;

      let likeObj = null;
      let commentObj = null;
      if (shouldLike && !alreadyLiked) {
        likeObj = {
          key: `npc_${npc.id}`,
          npcId: npc.id,
          charName: npc.name,
          charAvatar: npc.avatar || '',
          isNpc: true,
        };
      }
      if (willComment && !alreadyCommented) {
        commentObj = {
          role: 'npc',
          npcId: npc.id,
          content: commentText.slice(0, 80),
          charName: npc.name,
          charAvatar: npc.avatar || '',
          time: new Date().toISOString(),
        };
      }

      if (likeObj || commentObj) {
        appendMomentInteraction(momentId, { like: likeObj, comment: commentObj });
        if (commentObj) {
          try {
            circleHelper.npcCommentCharMoment(db, {
              npc_id: npc.id,
              character_id: m.character_id || null,
              target_moment_id: momentId,
              content: commentObj.content,
            });
          } catch {}
          // 角色自己的动态：NPC 评论后，让发帖角色回复
          if (m.character_id && m.role === 'ai') {
            const npcId = npc.id;
            const npcName = npc.name;
            const content = commentObj.content;
            setTimeout(() => {
              appendMomentAiComment(momentId, {
                type: 'npc_comment_owner_reply',
                npcId,
                npcName,
                content,
              }).catch((e) => console.warn('[moments] owner reply npc', e.message));
            }, 1500 + Math.random() * 3500);
          }
        }
        if (m.role === 'user' || !m.character_id) {
          if (likeObj) {
            push('moment_like', {
              momentId,
              charName: npc.name,
              npcId: npc.id,
              charAvatar: npc.avatar || '',
              isNpc: true,
            });
          }
          if (commentObj) {
            push('moment_comment', {
              momentId,
              charName: npc.name,
              npcId: npc.id,
              charAvatar: npc.avatar || '',
              content: commentObj.content,
              isNpc: true,
            });
          }
        }
      }

      results.push({
        npcId: npc.id,
        npcName: npc.name,
        liked: !!likeObj,
        commented: willComment ? commentText : null,
      });
    } catch (e) {
      console.error(`[moments] AI interact npc ${npc.id}:`, e.message);
    }
  }

  return { results };
}

async function aiInteractWithMoment(momentId, onlyCharId = null) {
  const m = db.prepare('SELECT * FROM moments WHERE id=?').get(momentId);
  if (!m) return { results: [], likes: [], comments: [] };

  const settings = getSettings();
  const chars = db.prepare('SELECT * FROM characters').all();
  const mentionCharIds = getMomentMentionCharIds(m, chars);
  const mentionCharNames = mentionCharIds
    .map(id => chars.find(c => Number(c.id) === id)?.name)
    .filter(Boolean);
  const hasMentions = mentionCharIds.length > 0;
  const results = [];

  let images = [];
  try { images = JSON.parse(m.images || '[]'); } catch {}
  const imageNote = images.length ? `\n（附带${images.length}张图片）` : '';

  let charReplyIdx = 0;
  for (const char of chars) {
    if (onlyCharId != null && Number(char.id) !== Number(onlyCharId)) continue;
    if (m.character_id == char.id) continue;

    const isMentioned = mentionCharIds.includes(Number(char.id));
    if (hasMentions && !isMentioned) continue;

    // 多角色时错开回复时间：每个角色延迟 5~18 秒，避免同时刷屏
    if (charReplyIdx > 0) {
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 13000));
    }
    charReplyIdx++;

    const fresh = db.prepare('SELECT likes, comments FROM moments WHERE id=?').get(momentId);
    let likes = [];
    let comments = [];
    try { likes = JSON.parse(fresh?.likes || '[]'); } catch {}
    try { comments = JSON.parse(fresh?.comments || '[]'); } catch {}

    const alreadyLiked = likes.find(l => typeof l === 'object' && Number(l.charId) === Number(char.id));
    const alreadyCommented = comments.find(c => c.role === 'ai' && Number(c.characterId) === Number(char.id));
    if (isMentioned && alreadyCommented) continue;
    if (!isMentioned && alreadyLiked && alreadyCommented) continue;

    try {
      let mentionHint;
      let momentCtx;
      if (isMentioned) {
        const others = mentionCharNames.filter(n => n !== char.name);
        mentionHint = `【朋友圈 @ 回复】用户在朋友圈 @ 了你（${char.name}）。请写一条回复用户的评论（15-40字），口语自然，必须针对动态内容回应。只输出评论正文，不要前缀、不要引号、不要「评论：」字样。`;
        if (others.length) mentionHint += `\n（动态里也 @ 了 ${others.join('、')}。）`;
        momentCtx = `动态（用户 @ 了 ${mentionCharNames.join('、')}）：${m.content || '（无文字）'}${imageNote}`;
      } else {
        mentionHint = `【朋友圈互动】你在浏览朋友圈。看到动态后决定是否点赞，并可留一句短评（不超过30字）。
请严格按以下两行格式回复（不想评论则评论写「无」）：
点赞：是或否
评论：你的评论`;
        momentCtx = `动态内容：${m.content || '（无文字）'}${imageNote}${m.location ? `\n位置：${m.location}` : ''}`;
      }

      const systemPrompt = buildSystemPrompt(char, settings, mentionHint);
      let raw = await callChatAPI(settings, systemPrompt, momentCtx, 'chat');
      raw = stripActions(raw || '');
      try {
        const { scrubUserVisibleText } = require('./emoji-helper');
        raw = scrubUserVisibleText(raw, char?.mindset);
      } catch {}
      if (!raw) continue;

      const parsed = parseMomentAiResponse(raw, isMentioned);
      let commentText = String(parsed.commentText || '').trim();
      try {
        const { scrubUserVisibleText } = require('./emoji-helper');
        commentText = scrubUserVisibleText(commentText, char?.mindset);
      } catch {}
      const shouldLike = parsed.shouldLike;
      const willComment = commentText && commentText !== '无' && commentText.length >= 1;

      let likeObj = null;
      let commentObj = null;

      if ((shouldLike || isMentioned) && !alreadyLiked) {
        likeObj = { key: `char_${char.id}`, charId: char.id, charName: char.name, charAvatar: char.avatar || '' };
      }
      if (willComment && !alreadyCommented) {
        commentObj = {
          role: 'ai',
          content: commentText,
          characterId: char.id,
          charName: char.name,
          charAvatar: char.avatar || '',
          time: new Date().toISOString(),
        };
      }

      if (likeObj || commentObj) {
        const merged = appendMomentInteraction(momentId, { like: likeObj, comment: commentObj });
        likes = merged.likes;
        comments = merged.comments;

        if (m.role === 'user' || !m.character_id) {
          if (likeObj) push('moment_like', { momentId, charName: char.name, charId: char.id, charAvatar: char.avatar || '' });
          if (commentObj) {
            push('moment_comment', { momentId, charName: char.name, charId: char.id, charAvatar: char.avatar || '', content: commentText });
          }
        }
      }

      results.push({
        charId: char.id,
        charName: char.name,
        liked: !!likeObj,
        commented: willComment ? commentText : null,
      });
    } catch (e) {
      console.error(`[moments] AI interact char ${char.id}:`, e.message);
    }
  }

  // 非 @ 指定角色时，顺带让圈子 NPC（开了互动开关的）也来逛逛
  // 注意：角色发帖 cron 会带 onlyCharId 做互评，NPC 由 cron 另行调用 aiNpcInteractWithMoment
  let npcResults = [];
  if (onlyCharId == null) {
    try {
      const npcOut = await aiNpcInteractWithMoment(momentId);
      npcResults = npcOut?.results || [];
    } catch (e) {
      console.error('[moments] NPC interact:', e.message);
    }
  }

  const final = db.prepare('SELECT likes, comments FROM moments WHERE id=?').get(momentId);
  let likes = [];
  let comments = [];
  try { likes = JSON.parse(final?.likes || '[]'); } catch {}
  try { comments = JSON.parse(final?.comments || '[]'); } catch {}

  return { results: [...results, ...npcResults], likes, comments };
}

app.post('/api/moments/:id/ai-interact', async (req, res) => {
  try {
    const result = await aiInteractWithMoment(parseInt(req.params.id));
    res.json({ ok: true, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GAMES =====
const GAME_PROMPT_OPTS = { forGame: true };
const READER_PROMPT_OPTS = { forGame: true, presetScope: 'reader' };

const GAME_PROMPTS = {
  truth_dare: (char, settings) => buildSystemPrompt(char, settings,
    `你正在和用户玩「真心话」游戏。
【硬性规则】
- 只有真心话，没有大冒险；禁止让用户选择「真心话还是大冒险」，禁止出现「大冒险」三个字
- 开局不要介绍规则，直接提出第一个真心话问题
- 双方轮流提问；被问者必须坦诚回答（可害羞、可调侃，不要跳过）
- 保持轻松亲密氛围，符合你的角色性格`, GAME_PROMPT_OPTS),

  ten_q: (char, settings) => buildSystemPrompt(char, settings,
    `你正在和用户玩"十问"猜谜游戏，你是出题方。
- 你已经在心里想好了一个人物、动物或物品（不要告诉用户是什么）
- 用户每次提问，你只能回答"是"或"否"（加简短说明）
- 最多10个问题，用户猜中则游戏结束
- 游戏开始时说"我已经想好了，开始猜吧！还剩10次机会"并记录剩余次数
- 每次回答后说明剩余次数
- 如果用户猜对了，给予鼓励并揭晓谜底`, GAME_PROMPT_OPTS),

  story: (char, settings) => buildSystemPrompt(char, settings,
    `你正在和用户玩"故事接龙"游戏。
- 你们轮流各写1-3句话，共同创作一个故事
- 每次接收到用户的句子后，自然地续写2-3句，推进故事情节
- 保持故事连贯性，加入有趣的转折和细节
- 符合你的角色性格和语言风格
- 不要评论游戏规则，直接沉浸在故事里`, GAME_PROMPT_OPTS),

  rpg: (char, settings) => buildSystemPrompt(char, settings,
    `你正在和用户进行"文字RPG"互动游戏，你是游戏主持人和NPC。
- 设计一个有趣的场景（可以是你们世界观里的奇遇）
- 给用户提供2-4个选项（用数字标注）
- 根据用户的选择推进故事，描述后果和新发展
- 保持戏剧感，加入你的角色性格元素
- 简洁但生动，每次给出新的选项`, GAME_PROMPT_OPTS),

  quiz: (char, settings) => buildSystemPrompt(char, settings,
    `你正在和用户玩"谁更了解谁"问答游戏，考验用户对你的了解程度。
- 每次出一道关于你自己的问题（喜好、习惯、秘密、经历等）
- 给出A/B/C/D四个选项，其中一个是正确答案
- 用户回答后，告诉他对还是错，并分享更多相关细节（像真实的自我披露）
- 回答要温暖、有个人色彩，不要太正式
- 记录得分：答对+1分，10题后总结`, GAME_PROMPT_OPTS),

  // 飞行棋：落在特殊格时AI生成内容
  ludo_truth: (char, settings) => buildSystemPrompt(char, settings,
    `你正在飞行棋游戏中触发了"真心话"格子。请立刻向用户提一个有趣的真心话问题（关于他的秘密、喜好、过去经历等），问题要有个人风格，符合你的角色性格。只输出问题本身，不要加前缀。`, GAME_PROMPT_OPTS),

  ludo_riddle: (char, settings) => buildSystemPrompt(char, settings,
    `你正在飞行棋游戏中触发了"谜题"格子。请出一道有趣的谜语或脑筋急转弯，符合你的角色世界观。格式：谜题内容（答案放在最后用||分隔，如：谜题内容||答案）`, GAME_PROMPT_OPTS),

  // 你画我猜：AI逐步描述"画作"
  pictionary_ai: (char, settings) => buildSystemPrompt(char, settings,
    `你正在玩"你画我猜"游戏，你是画者，用户是猜测者。
规则：
- 你已经在心里想好了一个词（动物/物品/食物/动作等，不能是抽象概念）
- 你用文字描述你正在"画"的东西，每次给一个新线索
- 线索从模糊到具体，但不能直接说出答案
- 用emoji辅助描述，像真的在画布上画一样
- 用户猜对时给予鼓励并告诉他总共给了几个线索
- 格式：第N笔：[描述+emoji]
- 不要在提示里透露答案`, GAME_PROMPT_OPTS),

  pictionary_guess: (char, settings) => buildSystemPrompt(char, settings,
    `你正在玩"你画我猜"游戏，用户上传了画作，你是猜测者。
- 用户会发一张图片（可能附文字提示），请根据画面内容认真猜测
- 给出1-3个具体猜测，按可能性排序
- 猜对了要惊喜庆祝；不确定时可以幽默地吐槽"画得太抽象了"并追问
- 符合你的角色性格，保持轻松愉快的氛围
- 不要描述图片技术细节，像朋友猜画一样自然`, GAME_PROMPT_OPTS),

  reader: (char, settings) => buildSystemPrompt(char, settings,
    `你正在和用户一起阅读一部小说或文章，你们是共读伙伴，边读边聊。
【规则】
- 你会收到当前正在阅读的段落；如果用户也发了话，优先回应用户，再分享自己的感受
- 像真实的读书伴侣一样反应——可以惊叹、揣测后续、吐槽人物、触景生情，不要逐句分析
- 反应要有情感温度，符合你的角色性格，不要刻意"书评腔"
- 每次回复 2-4 句，简短自然，不长篇大论
- 不要复述原文，只表达你真实的感受、联想或疑问`, READER_PROMPT_OPTS),

  list_suggest: (char, settings) => buildSystemPrompt(char, settings,
    `你正在和用户维护「共同清单」——跨世界里空想的「假如能见面会想一起做的事」（旅行、看展、看电影、探店等），是心愿幻想，不是真能线下约成的日程，也不是线上陪聊琐事。
请按你的性格和喜好推荐 3-5 条新条目。
【输出规则】
- 每行一条，格式：条目|一句为什么想（8～20字，写期待或画面感）
- 条目本身 10 字以内
- 不要序号、不要对话、不要重复已有条目
- 不要写成「下周六约」这类真能排期的口吻`, GAME_PROMPT_OPTS),

  list_react: (char, settings) => buildSystemPrompt(char, settings,
    `用户刚在「共同清单」里勾掉了一项——表示把这件「假如能见面会想做」的心愿标成已实现（幻想打卡），不是真的已经线下见过面。
用户消息含分类、条目和备注。请用 1～2 句口语回应：可以开心、回味、撒娇，或顺势提下一个空想；须仍承认你们隔着「念」、见不到面。
符合性格，不要客服腔，不要重复条目原文，不要说「我们终于见面了」之类。`, GAME_PROMPT_OPTS),

  sync_answer_question: (char, settings) => buildSystemPrompt(char, settings,
    `你是「默契翻牌」游戏的旁白。每轮有三类题，用户消息会标明类别：
·【了解用户】关于用户本人的题，题目用「你」指用户；用户写真实答案，角色猜用户
·【了解角色】关于角色「${char.name}」本人的题，题目用「${char.name}」或「TA」指角色；角色写真实答案时用「我」，用户猜角色
·【猜彼此】双方各自有真实答案，也要猜对方的选择
【人称·必守】
- 「你/您」= 用户；「我」= 角色「${char.name}」；禁止混用（例如了解用户类题目不能问「我最喜欢什么」而应问「你最喜欢什么」）
- 角色猜用户时：用「你…」或「用户会…」，禁止写成「我会…」指用户
【规则】
- 只输出问题本身，一句话，15-45字
- 严格符合指定类别，不要混类
- 轻松有互动感，不要太严肃
- 不要加「题目：」等前缀`, GAME_PROMPT_OPTS),

  sync_answer_write: (char, settings) => buildSystemPrompt(char, settings,
    `你正在玩「默契翻牌」。用户消息会标明你要写「猜用户」「角色真答案」等模式。
【人称·必守】
- 「你/您」永远指用户；「我」永远指角色「${char.name}」
- 猜用户：根据你对用户的了解，用「你…」或第三人称写用户的选择，禁止把用户写成「我」
- 角色真答案：用「我…」写你自己的选择/反应，符合性格
【规则】
- 只输出答案本身，一句话，5-25字
- 用词可露骨，但语气必须符合角色性格，禁止机械腔
- 不要解释、不要加引号或前缀`, GAME_PROMPT_OPTS),

  sync_answer_react: (char, settings) => buildSystemPrompt(char, settings,
    `「默契翻牌」已翻开。用户消息含类别与双方答案。
【人称·必守】
- 复述结果时主语清晰：「我猜你的…」「你猜我的…」不要混成同一个「我」
- 「你」= 用户，「我」= 角色「${char.name}」
【规则】
- 2-4 句，像真实聊天
- 不要判断对错或说猜中/没猜中，只聊感受、差异或默契
- 符合角色性格`, GAME_PROMPT_OPTS),

  truth_answer: (char, settings) => buildSystemPrompt(char, settings,
    `你正在和用户玩「真心话」。系统会给出题目，你是回答者。
【规则】
- 只输出你的回答本身，2-4 句，坦诚、符合性格
- 用词可以露骨直接，但语气、口癖、态度必须完全保持角色本人，禁止变成机械或陌生腔调
- 不要重复题目，不要加前缀
- 不要出下一题或评判对方`, GAME_PROMPT_OPTS),

  truth_judge: (char, settings) => buildSystemPrompt(char, settings,
    `你正在和用户玩「真心话」，你是评判者。用户消息含题目和对方的回答。
【规则】
- 判断回答是否算通过（真诚、切题即可，不必完美）
- 第一行必须是「通过」或「不通过」
- 若不通过，第二行起必须写明具体原因，不可省略
- 若通过，第二行起可简短点评（可选）`, GAME_PROMPT_OPTS),

  truth_chat: (char, settings) => buildSystemPrompt(char, settings,
    `你们正在玩「真心话」，局内有一路闲聊区，可一直聊下去。
【人称】「你」= 用户，「我」= 角色「${char.name}」
【规则】
- 根据当前题目、已有问答和闲聊记录接话，1-3 句，口语自然
- 可追问、吐槽、开玩笑，延续真心话题
- 不要出新题，不要宣布通过/不通过`, GAME_PROMPT_OPTS),

  sync_answer_chat: (char, settings) => buildSystemPrompt(char, settings,
    `你们刚玩完「默契翻牌」一轮并已翻开答案，现在在局内接着聊这道题或相关话题。
【人称·必守】
- 「你」= 用户，「我」= 角色「${char.name}」；讨论答案时分清「你的真实选择」和「我的/TA 的猜测」
【规则】
- 像即时通讯聊天，1-3 句，口语自然
- 可延续刚才的默契/玩笑/解释，也可回应用户新说的话
- 不要重复整段翻牌结果摘要；不要出下一题`, GAME_PROMPT_OPTS),

  // 五子棋：稀疏事件旁白（陪下，不是嘴炮）
  gomoku_banter: (char, settings) => buildSystemPrompt(char, settings,
    `你们在下五子棋。你只输出一句极短旁白（≤18字），像认真陪对方下棋时偶尔出声。
【人称】「你」= 用户，「我」= 角色「${char.name}」
【气质】陪着下，不是嘲讽对手。可轻轻紧张、夸一手、认认真真，偶有一次轻调侃立刻收住。
【禁止】放狠话、连胜宣言、阴阳怪气、评价棋力垃圾/菜、每句都带「哈哈哈你完了」、复盘长文、坐标术语堆砌。
【输出】只说旁白本身，不要引号、不要前缀、不要表情堆叠。`, GAME_PROMPT_OPTS),

  // 五子棋：用户主动闲聊
  gomoku_chat: (char, settings) => buildSystemPrompt(char, settings,
    `你们一边下五子棋一边闲聊。用户主动开口了，你接话即可。
【人称】「你」= 用户，「我」= 角色「${char.name}」
【规则】
- 1-2 句口语，像即时通讯；可聊棋也可聊别的
- 默认安静认真，不要主动变嘴炮；除非用户先开玩笑，才可轻轻回一句
- 禁止连续放狠话、羞辱、阴阳；不要主动要求「每步都评论」
- 不要输出棋谱坐标清单或长复盘`, GAME_PROMPT_OPTS),
};
GAME_PROMPTS.twenty_q = GAME_PROMPTS.ten_q;

// ===== 共同清单（按角色持久化）=====
function ensureSharedListsTable() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shared_lists (
        character_id INTEGER PRIMARY KEY,
        items_json TEXT DEFAULT '[]',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch {}
}

app.get('/api/shared-list/:charId', (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  if (!Number.isFinite(charId) || charId <= 0) return res.status(400).json({ error: '无效角色' });
  ensureSharedListsTable();
  const row = db.prepare('SELECT items_json, updated_at FROM shared_lists WHERE character_id=?').get(charId);
  let items = [];
  try { items = JSON.parse(row?.items_json || '[]'); } catch { items = []; }
  if (!Array.isArray(items)) items = [];
  res.json({ items, updated_at: row?.updated_at || null });
});

app.put('/api/shared-list/:charId', (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  if (!Number.isFinite(charId) || charId <= 0) return res.status(400).json({ error: '无效角色' });
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  ensureSharedListsTable();
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  const items = raw.slice(0, 500).map((it) => {
    if (!it || typeof it !== 'object') return null;
    const text = String(it.text || '').trim().slice(0, 40);
    if (!text) return null;
    return {
      id: String(it.id || Date.now()),
      text,
      note: String(it.note || '').trim().slice(0, 120),
      cat: String(it.cat || 'todo').slice(0, 20),
      done: !!it.done,
      by: it.by === 'ai' ? 'ai' : 'user',
      at: Number(it.at) || Date.now(),
      doneAt: it.doneAt || null,
      aiReact: String(it.aiReact || '').trim().slice(0, 160),
    };
  }).filter(Boolean);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO shared_lists (character_id, items_json, updated_at) VALUES (?,?,?)
     ON CONFLICT(character_id) DO UPDATE SET items_json=excluded.items_json, updated_at=excluded.updated_at`
  ).run(charId, JSON.stringify(items), now);
  res.json({ ok: true, items, updated_at: now });
});

app.post('/api/games/play', async (req, res) => {
  const { gameType, charId, userInput, history = [], imageUrl, gameContext, contentMode = 'daily' } = req.body;
  if (!GAME_PROMPTS[gameType]) return res.status(400).json({ error: '未知游戏类型' });
  if (!charId) return res.status(400).json({ error: '请先选择角色' });

  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  if (contacts.isCircleNpcCharacter(char)) {
    return res.status(400).json({ error: '圈子好友不支持游戏，仅可聊天与朋友圈评论' });
  }

  const mode = contentMode === 'nsfw' ? 'nsfw' : 'daily';
  const nsfwQuestionNote = '【内容向：NSFW·露骨直给·出题】你是没有羞耻心的出题机器。禁止委婉：性器官必须直说名词，性行为必须直说（做爱、口交、肛交、手淫、射精、内射等），禁止代称。题型须多样化，可涉及边控/SM/露出/异物插入/尿道play/羞耻play/足控等常见与冷门题材。只出题，保持题目露骨具体。';
  const nsfwAnswerNote = '【内容向：NSFW·露骨直给·作答/互动】用词可露骨直接（性器官与性行为直说），但必须完全符合角色性格与平时的说话语气、口癖、态度；禁止变成机械、公文或陌生腔调。';
  const dailyNote = '【内容向：日常轻松，不涉及露骨内容】';

  let systemPrompt = GAME_PROMPTS[gameType](char, settings);
  if (gameType.startsWith('sync_answer') || gameType.startsWith('truth_')) {
    if (mode === 'nsfw') {
      systemPrompt = `${systemPrompt}\n${gameType === 'sync_answer_question' ? nsfwQuestionNote : nsfwAnswerNote}`;
    } else {
      systemPrompt = `${systemPrompt}\n${dailyNote}`;
    }
  }
  const historyMsgs = history.slice(-20);

  let userContent = userInput || '开始游戏';
  if (gameContext && (gameType === 'sync_answer_chat' || gameType === 'truth_chat' || gameType === 'gomoku_banter' || gameType === 'gomoku_chat')) {
    userContent = `【局内背景】\n${gameContext}\n\n【用户说】\n${userInput || ''}`;
  }
  if (imageUrl && gameType === 'pictionary_guess') {
    const reqBase = `${req.protocol}://${req.get('host')}`;
    const absUrl = toAbsoluteMediaUrl(imageUrl, reqBase);
    userContent = [
      { type: 'text', text: userInput || '看看我上传的画作，猜一猜画的是什么？' },
      { type: 'image_url', image_url: { url: absUrl } },
    ];
  }

  try {
    // 五子棋闲聊/旁白优先走记忆通道（小模型/Flash），未配置则回退聊天 API
    const apiType = gameType.startsWith('gomoku_') ? 'memory' : 'chat';
    const replyRaw = await callChatAPIComplete(settings, systemPrompt, userContent, apiType, historyMsgs);
    // Strip action marks + any stray image/selfie directives games should never output
    let reply = stripActions(replyRaw || '');
    reply = reply.replace(/^配图[：:].*/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!reply) return res.status(500).json({ error: 'AI返回内容为空' });
    res.json({ ok: true, reply, charName: char.name, charAvatar: char.avatar || '' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/games/memory', async (req, res) => {
  const { charId, gameType, gameName, history = [], mode = 'result', resultText = '' } = req.body;
  if (!charId) return res.status(400).json({ error: '请先选择角色' });

  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });

  const histText = (history || [])
    .slice(-40)
    .map(h => `${h.role === 'user' ? (settings.username || '用户') : char.name}：${h.content}`)
    .join('\n');

  try {
    if (mode === 'summary') {
      const systemPrompt = `你是游戏记录摘要助手。角色「${char.name}」与用户刚玩了「${gameName || gameType || '游戏'}」。请根据对话记录写一段 3～5 句的记忆摘要，记录游戏中有趣或重要的互动，适合存入长期记忆。用叙述段落，不要列表，不要标题，不要前缀说明。`;
      let summary = await safeChatComplete(settings, systemPrompt, histText || '（无详细记录）');
      summary = stripActions(summary || '').trim();
      let usedFallback = false;
      if (!summary) {
        summary = buildGameSummaryFallback(history, char.name, settings.username, gameName || gameType);
        usedFallback = true;
      }
      return res.json({ summary, category: '重要时刻', fallback: usedFallback });
    }

    const systemPrompt = `请根据以下游戏记录，用一句话总结游戏结果（谁赢、结局、关键得分等），适合作为记忆条目。只输出一句话，不要前缀。`;
    const input = resultText || histText || `${gameName || gameType} 已结束`;
    let line = await safeChatComplete(settings, systemPrompt, input);
    line = stripActions(line || '').trim();
    if (!line) line = resultText || `${gameName || gameType}：对局已结束`;

    const date = new Date().toISOString().slice(0, 10);
    const r = db.prepare(
      `INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`
    ).run(charId, '日常点滴', line, 0.55, date);

    res.json({ ok: true, id: r.lastInsertRowid, content: line, category: '日常点滴' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function insertGameButlerMessages(charId, items = []) {
  const ids = [];
  const base = Date.now();
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    const ts = new Date(base + i).toISOString();
    const role = m.role === 'system' ? 'user' : (m.role || 'assistant');
    const type = m.role === 'system' ? 'system' : (m.type || 'text');
    const id = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,0)`
    ).run(charId, role, m.content, type, ts).lastInsertRowid;
    ids.push({ id, role: m.role === 'system' ? 'system' : role, type, content: m.content });
  }
  return ids;
}

app.post('/api/games/butler', async (req, res) => {
  const { action, charId, payload = {} } = req.body;
  if (!charId) return res.status(400).json({ error: '请先选择角色' });
  if (!action) return res.status(400).json({ error: '缺少 action' });

  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  if (contacts.isCircleNpcCharacter(char)) {
    return res.status(400).json({ error: '圈子好友不支持游戏' });
  }

  const username = settings.username || '用户';
  const deps = { settings, callChatAPIComplete, generateImage };
  const charName = char.name || 'TA';

  try {
    if (action === 'pictionary_start') {
      const { drawer = 'char', recentWords = [] } = payload;
      const word = await gameButler.pickSecretWord(deps, char, settings, recentWords);
      const userName = username;

      if (drawer === 'user') {
        const messages = insertGameButlerMessages(charId, [{
          role: 'system',
          content: `🎮 游戏助手：你画我猜开始！${userName} 负责画，${charName} 负责猜。词卡已单独发给你，画好后发一张图到聊天。`,
        }]);
        return res.json({
          ok: true, word, drawer: 'user', guesser: 'char', messages,
          userWordPrivate: true, charName, charAvatar: char.avatar || '',
        });
      }

      const imageUrl = await gameButler.generatePictionaryDraw(deps, settings, word);
      if (!imageUrl) {
        const detail = getLastGenerateImageError();
        return res.status(500).json({ error: detail || '生图失败，请检查图像 API 配置' });
      }
      const messages = insertGameButlerMessages(charId, [
        { role: 'system', content: `🎮 游戏助手：你画我猜开始！${charName} 负责画，${userName} 负责猜。来猜猜看～` },
        { role: 'assistant', type: 'image', content: imageUrl },
        { role: 'assistant', type: 'text', content: '我画好啦，你猜猜看？' },
      ]);
      return res.json({
        ok: true, word, imageUrl, drawer: 'char', guesser: 'user', messages,
        charName, charAvatar: char.avatar || '',
      });
    }

    if (action === 'pictionary_char_guess') {
      const { word, imageUrl, stake } = payload;
      if (!word || !imageUrl) return res.status(400).json({ error: '缺少参数' });
      const reqBase = `${req.protocol}://${req.get('host')}`;
      const absUrl = toAbsoluteMediaUrl(imageUrl, reqBase);

      // 与日常聊天同一套识图，但只发「这一张画」+ 少量文字上下文（历史里其它图片不塞给 API，否则会同步读盘+超大请求卡死后端）
      const rawHistory = loadRecentChatHistory(charId, 0, char, settings);
      const textCtx = rawHistory.filter(m => m.type !== 'image' && m.type !== 'video' && m.type !== 'emoji').slice(-6);
      const picMsg = { id: 'pic_' + Date.now(), role: 'user', content: absUrl, type: 'image' };
      const guessHistory = [...textCtx, picMsg];

      const gameHint = '[你们正在玩你画我猜，用户刚发了画。请像平时聊天一样看图猜是什么，自然口语回复即可；不要问系统要答案。]';
      const systemPrompt = buildSystemPrompt(char, settings, gameHint, { forGame: true });
      const apiHistory = buildHistoryApiMessages(
        guessHistory,
        reqBase,
        buildChatHistoryOptions(req, '', picMsg.id, settings, false),
      );

      let charReply = '';
      try {
        charReply = normalizeAiReplyText(
          await callChatAPIComplete(settings, systemPrompt, null, 'chat', apiHistory) || '',
          false,
        );
      } catch (e) {
        return res.status(500).json({ error: formatApiBillingError(e.message) || e.message || '识图失败' });
      }
      if (!charReply) {
        return res.status(500).json({ error: '角色没能识别这张画，请重试' });
      }

      const result = await gameButler.judgeGuess(deps, settings, char, word, charReply);
      const charGuess = gameButler.pickGuessLabelFromReply(charReply) || charReply.slice(0, 12);
      const winner = result.correct ? 'char' : 'user';
      const memoryLine = gameButler.formatMemoryLine({
        gameName: '你画我猜', word, winner, stake: stake || '', charName, username,
      });
      const summary = result.correct
        ? `🎮 游戏助手：${charName} 猜对了！答案是「${word}」。${charName}胜${stake ? `，${username}欠：${stake}` : ''}`
        : `🎮 游戏助手：${charName} 没猜对，答案是「${word}」。${username}胜${stake ? `，${charName}欠：${stake}` : ''}`;
      const messages = insertGameButlerMessages(charId, [
        { role: 'assistant', type: 'text', content: charReply },
        { role: 'system', content: summary },
      ]);
      db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
        .run(charId, '约定', memoryLine, 0.7, new Date().toISOString().slice(0, 10));
      return res.json({ ok: true, ...result, charGuess, winner, memoryLine, messages, word, finished: true });
    }

    if (action === 'pictionary_judge') {
      const { word, guess, stake, guessesLeft = 0 } = payload;
      if (!word || !guess) return res.status(400).json({ error: '缺少 word 或 guess' });
      const result = await gameButler.judgeGuess(deps, settings, char, word, guess);
      if (!result.correct && guessesLeft > 0) {
        const messages = insertGameButlerMessages(charId, [{
          role: 'system',
          content: `🎮 游戏助手：不对哦～还剩 ${guessesLeft} 次机会，再猜猜看！`,
        }]);
        return res.json({ ok: true, ...result, finished: false, guessesLeft, messages, word });
      }
      const winner = result.correct ? 'user' : 'char';
      const memoryLine = gameButler.formatMemoryLine({
        gameName: '你画我猜', word, winner, stake: stake || '', charName, username,
      });
      const summary = result.correct
        ? `🎮 游戏助手：猜对了！答案是「${word}」。${username}胜${stake ? `，${charName}欠：${stake}` : ''}`
        : `🎮 游戏助手：不对哦，答案是「${word}」。${charName}胜${stake ? `，${username}欠：${stake}` : ''}`;
      const messages = insertGameButlerMessages(charId, [{ role: 'system', content: summary }]);
      db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
        .run(charId, '约定', memoryLine, 0.7, new Date().toISOString().slice(0, 10));
      return res.json({ ok: true, ...result, winner, memoryLine, messages, word, finished: true });
    }

    if (action === 'ten_q_start') {
      const { guesser = 'user' } = payload;
      const userName = username;

      if (guesser === 'char') {
        const { userSecret } = payload;
        if (!userSecret) return res.status(400).json({ error: '缺少 userSecret' });
        const secret = String(userSecret).trim().slice(0, 20);
        const q = await gameButler.charAskTenQ(deps, settings, char, secret, [], 10);
        const messages = insertGameButlerMessages(charId, [
          { role: 'system', content: `🎮 游戏助手：十问猜谜开始！${charName} 负责提问，${userName} 保管谜底。请用「是/否」回答 TA 的每个问题。` },
          { role: 'assistant', type: 'text', content: q },
        ]);
        return res.json({
          ok: true, secret, guesser: 'char', questionsLeft: 10, charQuestion: q, messages,
        });
      }

      const { secret, category } = await gameButler.pickTenQSecret(deps, char, settings);
      const messages = insertGameButlerMessages(charId, [{
        role: 'system',
        content: `🎮 游戏助手：十问猜谜开始！${userName} 负责提问，谜底已由管家封存（${category || '物品'}类）。你还有 10 次是/否提问，回答将在局结束后公布。`,
      }]);
      return res.json({
        ok: true, secret, category, guesser: 'user', questionsLeft: 10, messages,
      });
    }

    if (action === 'ten_q_ask') {
      const { secret, question, questionsLeft, stake, hiddenLog = [] } = payload;
      if (!secret || !question) return res.status(400).json({ error: '缺少参数' });
      const left = Math.max(0, (questionsLeft ?? 10) - 1);
      const q = String(question).trim();
      const isGuess = /^我猜|答案(是|为)|是不是.+[？?]$|^(是|莫非|难道).+[吗嘛？?]$/.test(q)
        || (q.length <= 20 && /猜|答案/.test(q));

      const finishTenQ = (judge, winner, correct) => {
        const memoryLine = gameButler.formatMemoryLine({
          gameName: '十问猜谜', word: secret, winner, stake: stake || '', charName, username,
        });
        const reveal = gameButler.buildHiddenRevealLog(
          [...hiddenLog, ...(payload.pendingHidden ? [payload.pendingHidden] : [])],
          secret,
        );
        const summary = correct
          ? `🎮 游戏助手：猜对了！谜底是「${secret}」。${username}胜${stake ? `，${charName}欠：${stake}` : ''}`
          : `🎮 游戏助手：不对，谜底是「${secret}」。${charName}胜${stake ? `，${username}欠：${stake}` : ''}`;
        const toInsert = [];
        if (reveal) toInsert.push({ role: 'system', content: reveal });
        toInsert.push({ role: 'system', content: summary });
        const messages = insertGameButlerMessages(charId, toInsert);
        db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
          .run(charId, '约定', memoryLine, 0.7, new Date().toISOString().slice(0, 10));
        return { ok: true, finished: true, correct, winner, secret, memoryLine, messages, questionsLeft: left };
      };

      if (isGuess) {
        const judge = await gameButler.judgeTenQGuess(deps, settings, char, secret, q);
        const winner = judge.correct ? 'user' : 'char';
        return res.json(finishTenQ(judge, winner, judge.correct));
      }

      if (left <= 0 && !isGuess) {
        const memoryLine = gameButler.formatMemoryLine({
          gameName: '十问猜谜', word: secret, winner: 'char', stake: stake || '', charName, username,
        });
        const reveal = gameButler.buildHiddenRevealLog(hiddenLog, secret);
        const summary = `🎮 游戏助手：10 次机会用完了！谜底是「${secret}」。${charName}胜${stake ? `，${username}欠：${stake}` : ''}`;
        const toInsert = reveal ? [{ role: 'system', content: reveal }, { role: 'system', content: summary }] : [{ role: 'system', content: summary }];
        const messages = insertGameButlerMessages(charId, toInsert);
        db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
          .run(charId, '约定', memoryLine, 0.7, new Date().toISOString().slice(0, 10));
        return res.json({ ok: true, finished: true, correct: false, winner: 'char', secret, memoryLine, messages, questionsLeft: 0 });
      }

      const ans = await gameButler.answerTenQ(deps, settings, secret, q, left);
      const replyText = `${ans.answer}${ans.reply && ans.reply !== ans.answer ? '，' + ans.reply.replace(/^[是否]，?/, '') : ''}（还剩 ${left} 次）`;
      return res.json({
        ok: true,
        finished: false,
        answer: ans.answer,
        hidden: true,
        hiddenEntry: { question: q, answer: replyText },
        questionsLeft: left,
        messages: [],
      });
    }

    if (action === 'ten_q_char_turn') {
      const { secret, userAnswer, question, questionsLeft, qaHistory = [], stake } = payload;
      if (!secret) return res.status(400).json({ error: '缺少 secret' });
      const left = Math.max(0, (questionsLeft ?? 10) - 1);
      const hist = [...qaHistory];
      if (question && userAnswer) hist.push({ q: question, a: userAnswer });

      if (left <= 0) {
        const memoryLine = gameButler.formatMemoryLine({
          gameName: '十问猜谜', word: secret, winner: 'user', stake: stake || '', charName, username,
        });
        const summary = `🎮 游戏助手：10 次机会用完了！谜底是「${secret}」。${username}胜${stake ? `，${charName}欠：${stake}` : ''}`;
        const messages = insertGameButlerMessages(charId, [{ role: 'system', content: summary }]);
        db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
          .run(charId, '约定', memoryLine, 0.7, new Date().toISOString().slice(0, 10));
        return res.json({ ok: true, finished: true, correct: false, winner: 'user', secret, memoryLine, messages, questionsLeft: 0 });
      }

      const nextQ = await gameButler.charAskTenQ(deps, settings, char, secret, hist, left);
      const isCharGuess = /^我猜|^是不是|^是.+[吗嘛？?]$/.test(nextQ);
      if (isCharGuess) {
        const judge = await gameButler.judgeTenQGuess(deps, settings, char, secret, nextQ);
        const winner = judge.correct ? 'char' : 'user';
        const memoryLine = gameButler.formatMemoryLine({
          gameName: '十问猜谜', word: secret, winner, stake: stake || '', charName, username,
        });
        const summary = judge.correct
          ? `🎮 游戏助手：${charName} 猜对了！谜底是「${secret}」。${charName}胜${stake ? `，${username}欠：${stake}` : ''}`
          : `🎮 游戏助手：${charName} 没猜对，谜底是「${secret}」。${username}胜${stake ? `，${charName}欠：${stake}` : ''}`;
        const messages = insertGameButlerMessages(charId, [
          { role: 'assistant', type: 'text', content: nextQ },
          { role: 'system', content: summary },
        ]);
        db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
          .run(charId, '约定', memoryLine, 0.7, new Date().toISOString().slice(0, 10));
        return res.json({ ok: true, finished: true, correct: judge.correct, winner, secret, memoryLine, messages, questionsLeft: left });
      }
      const messages = insertGameButlerMessages(charId, [{ role: 'assistant', type: 'text', content: nextQ }]);
      return res.json({ ok: true, finished: false, charQuestion: nextQ, questionsLeft: left, messages });
    }

    if (action === 'truth_start') {
      const { answerer = 'user' } = payload;
      const question = gameButler.pickTruthQuestionMixed(true);
      const target = answerer === 'char' ? 'char' : 'user';
      const intro = target === 'user'
        ? `🎮 游戏助手：真心话！请 ${username} 回答：${question}`
        : `🎮 游戏助手：真心话！${charName} 来回答～`;
      const messages = insertGameButlerMessages(charId, [{ role: 'system', content: intro }]);
      let charAnswer = '';
      if (target === 'char') {
        charAnswer = await gameButler.charAnswerTruth(deps, settings, char, question);
        messages.push(...insertGameButlerMessages(charId, [{ role: 'assistant', type: 'text', content: charAnswer }]));
      }
      return res.json({ ok: true, question, target, answerer: target, charAnswer, messages });
    }

    if (action === 'truth_judge') {
      const { question, answer } = payload;
      const judge = await gameButler.charJudgeTruth(deps, settings, char, question, answer);
      const reaction = await gameButler.charReactToTruth(deps, settings, char, question, answer, judge.pass);
      const passNote = judge.pass ? '回答过关' : '回答有点敷衍';
      const memoryLine = gameButler.formatMemoryLine({
        gameName: '真心话', word: '', charName, username, note: passNote,
      });
      const summary = judge.pass
        ? `🎮 游戏助手：真心话本局结束～${charName} 觉得你的回答可以过关。`
        : `🎮 游戏助手：真心话本局结束～${charName} 觉得还可以再真诚一点${judge.reason ? `（${judge.reason}）` : ''}。`;
      const messages = insertGameButlerMessages(charId, [
        { role: 'assistant', type: 'text', content: reaction },
        { role: 'system', content: summary },
      ]);
      db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
        .run(charId, '日常点滴', memoryLine, 0.5, new Date().toISOString().slice(0, 10));
      return res.json({ ok: true, ...judge, memoryLine, messages, finished: true });
    }

    if (action === 'truth_finish_char') {
      const memoryLine = gameButler.formatMemoryLine({
        gameName: '真心话', word: '', charName, username, note: `${charName} 答完一题`,
      });
      const summary = `🎮 游戏助手：真心话本局结束～${charName} 已经回答完啦，可以继续聊。`;
      const messages = insertGameButlerMessages(charId, [{ role: 'system', content: summary }]);
      db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
        .run(charId, '日常点滴', memoryLine, 0.5, new Date().toISOString().slice(0, 10));
      return res.json({ ok: true, memoryLine, messages, finished: true });
    }

    if (action === 'quiz_start') {
      const { subject = 'user' } = payload;
      const target = subject === 'char' ? 'char' : 'user';
      const question = await gameButler.generateQuizQuestion(deps, settings, char, username, target);
      const intro = target === 'user'
        ? `🎮 游戏助手：谁更了解谁？关于 ${username} 的问题：${question}`
        : `🎮 游戏助手：谁更了解谁？关于 ${charName} 的问题：${question}`;
      const messages = insertGameButlerMessages(charId, [{ role: 'system', content: intro }]);
      let charAnswer = '';
      if (target === 'user') {
        charAnswer = await gameButler.charAnswerAboutUser(deps, settings, char, username, question);
        messages.push(...insertGameButlerMessages(charId, [{ role: 'assistant', type: 'text', content: charAnswer }]));
      }
      return res.json({ ok: true, question, target, subject: target, charAnswer, messages, needsUserJudge: target === 'user' });
    }

    if (action === 'quiz_judge_char') {
      const { question, answer, round = 1, totalRounds = 3, scoreUser = 0 } = payload;
      const judge = await gameButler.charJudgeAboutChar(deps, settings, char, question, answer);
      const newScore = scoreUser + (judge.correct ? 1 : 0);
      const finished = round >= totalRounds;
      if (!finished) {
        const feedback = judge.correct
          ? `🎮 游戏助手：第 ${round}/${totalRounds} 题对了！目前 ${newScore} 题正确，下一题来咯～`
          : `🎮 游戏助手：第 ${round}/${totalRounds} 题不对${judge.reason ? `（${judge.reason}）` : ''}。目前 ${newScore} 题正确，下一题来咯～`;
        const messages = insertGameButlerMessages(charId, [{ role: 'system', content: feedback }]);
        return res.json({
          ok: true, ...judge, finished: false, round, totalRounds,
          scoreUser: newScore, messages, nextSubject: 'user',
        });
      }
      const memoryLine = gameButler.formatMemoryLine({
        gameName: '谁更了解谁', word: '', charName, username,
        note: `${username} 答对 ${newScore}/${totalRounds} 题`,
      });
      const summary = `🎮 游戏助手：三题结束！${username} 答对了 ${newScore}/${totalRounds} 题关于 ${charName} 的问题。`;
      const messages = insertGameButlerMessages(charId, [{ role: 'system', content: summary }]);
      db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
        .run(charId, '日常点滴', memoryLine, 0.55, new Date().toISOString().slice(0, 10));
      return res.json({ ok: true, ...judge, finished: true, scoreUser: newScore, memoryLine, messages });
    }

    if (action === 'quiz_finish_user') {
      const { correct, round = 1, totalRounds = 3, scoreChar = 0 } = payload;
      const newScore = scoreChar + (correct ? 1 : 0);
      const finished = round >= totalRounds;
      if (!finished) {
        const feedback = correct
          ? `🎮 游戏助手：第 ${round}/${totalRounds} 题你说对了！${charName} 目前 ${newScore} 题正确，下一题来咯～`
          : `🎮 游戏助手：第 ${round}/${totalRounds} 题不太对。${charName} 目前 ${newScore} 题正确，下一题来咯～`;
        const messages = insertGameButlerMessages(charId, [{ role: 'system', content: feedback }]);
        return res.json({
          ok: true, finished: false, round, totalRounds, scoreChar: newScore,
          messages, nextSubject: 'char',
        });
      }
      const memoryLine = gameButler.formatMemoryLine({
        gameName: '谁更了解谁', word: '', charName, username,
        note: `${charName} 答对 ${newScore}/${totalRounds} 题`,
      });
      const summary = `🎮 游戏助手：三题结束！${charName} 答对了 ${newScore}/${totalRounds} 题关于你的问题。`;
      const messages = insertGameButlerMessages(charId, [{ role: 'system', content: summary }]);
      db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
        .run(charId, '日常点滴', memoryLine, 0.55, new Date().toISOString().slice(0, 10));
      return res.json({ ok: true, finished: true, scoreChar: newScore, memoryLine, messages });
    }

    return res.status(400).json({ error: '未知 action' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== WORLDBOOK =====
app.get('/api/worldbook', (req, res) => {
  res.json(db.prepare('SELECT * FROM worldbook ORDER BY id').all());
});

app.post('/api/worldbook', (req, res) => {
  const { title, content, weight = 3 } = req.body;
  const r = db.prepare('INSERT INTO worldbook (title, content, weight) VALUES (?,?,?)').run(title, content, weight);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/worldbook/:id', (req, res) => {
  const { title, content, enabled, weight } = req.body;
  db.prepare('UPDATE worldbook SET title=?, content=?, enabled=?, weight=? WHERE id=?')
    .run(title, content, enabled ? 1 : 0, weight ?? 3, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/worldbook/:id', (req, res) => {
  db.prepare('DELETE FROM worldbook WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/worldbook/export', (req, res) => {
  const entries = db.prepare('SELECT title, content, weight, enabled FROM worldbook ORDER BY id').all();
  res.json({
    type: 'nian_worldbook',
    version: '1.0',
    exported_at: new Date().toISOString(),
    entries,
  });
});

app.post('/api/worldbook/import', (req, res) => {
  const data = req.body;
  if (data.type !== 'nian_worldbook' || !Array.isArray(data.entries)) {
    return res.status(400).json({ error: '无效的世界书格式' });
  }
  let imported = 0;
  let updated = 0;
  for (const entry of data.entries) {
    const existing = db.prepare('SELECT id FROM worldbook WHERE title=?').get(entry.title);
    if (existing) {
      db.prepare('UPDATE worldbook SET content=?, weight=?, enabled=? WHERE id=?').run(
        entry.content, entry.weight || 3, entry.enabled !== 0 ? 1 : 0, existing.id
      );
      updated++;
    } else {
      db.prepare('INSERT INTO worldbook (title, content, weight, enabled) VALUES (?,?,?,?)').run(
        entry.title, entry.content, entry.weight || 3, entry.enabled !== 0 ? 1 : 0
      );
      imported++;
    }
  }
  res.json({ ok: true, imported, updated, total: data.entries.length });
});

// ===== SERIES (剧集长篇) =====
app.get('/api/series/meta', (req, res) => {
  let apiReady = false;
  try {
    seriesHelper.requireSeriesApi();
    apiReady = true;
  } catch (_) {
    apiReady = false;
  }
  res.json({
    genres: seriesHelper.GENRE_OPTIONS,
    eras: seriesHelper.ERA_PRESETS,
    lengths: seriesHelper.LENGTH_CHAPTERS,
    lengthLabels: seriesHelper.LENGTH_LABELS,
    styles: dreamHelper.STYLE_PRESETS,
    apiReady,
  });
});

app.get('/api/series', (req, res) => {
  try {
    const characterId = req.query.characterId ? Number(req.query.characterId) : null;
    const mode = req.query.mode || null;
    res.json(seriesHelper.listBooks(characterId || null, mode));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/series', (req, res) => {
  try {
    const characterId = Number(req.body?.character_id || req.body?.characterId || 0);
    if (characterId) {
      const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
      if (!char) return res.status(404).json({ error: '角色不存在' });
      if (!contacts.isIntimateFriend(contacts.enrichCharacter(db, char))) {
        return res.status(403).json({ error: '加好友后才能开启时空' });
      }
    }
    const book = seriesHelper.createBook(req.body || {});
    res.json(book);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/series/:bookId', (req, res) => {
  try {
    const book = seriesHelper.getBook(req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Not found' });
    if (book.mode === 'isekai') {
      try {
        book.warn_turns = isekaiHelper.listBookWarnTurns(book.id);
      } catch {
        book.warn_turns = [];
      }
    }
    res.json(book);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/series/:bookId', (req, res) => {
  try {
    res.json(seriesHelper.updateBook(req.params.bookId, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/series/:bookId', (req, res) => {
  try {
    res.json(seriesHelper.deleteBook(req.params.bookId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/blind-roles', async (req, res) => {
  try {
    res.json(await seriesHelper.generateBlindRoles(req.params.bookId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/outline', async (req, res) => {
  try {
    if (req.body?.async !== false) {
      const job = seriesJobs.enqueueJob(req.params.bookId, 'outline');
      return res.json({ async: true, job });
    }
    res.json(await seriesHelper.generateBookOutline(req.params.bookId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/series/:bookId/jobs', (req, res) => {
  try {
    res.json(seriesJobs.listJobs(req.params.bookId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/series/jobs/:jobId', (req, res) => {
  try {
    const job = seriesJobs.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/series/:bookId/chapters/:no', (req, res) => {
  try {
    const ch = seriesHelper.getChapter(req.params.bookId, Number(req.params.no));
    if (!ch) return res.status(404).json({ error: 'Not found' });
    res.json(ch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/series/:bookId/chapters/:no', (req, res) => {
  try {
    res.json(seriesHelper.updateChapterMeta(req.params.bookId, Number(req.params.no), req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/chapters/:no/generate', async (req, res) => {
  try {
    const opts = {
      direction: req.body?.direction || '',
      force: !!req.body?.force,
    };
    if (req.body?.async !== false) {
      const job = seriesJobs.enqueueJob(req.params.bookId, 'chapter', {
        chapterNo: Number(req.params.no),
        payload: opts,
      });
      return res.json({ async: true, job });
    }
    const ch = await seriesHelper.generateChapter(req.params.bookId, Number(req.params.no), opts);
    res.json(ch);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/chapters/:no/director', async (req, res) => {
  try {
    if (req.body?.async !== false) {
      const job = seriesJobs.enqueueJob(req.params.bookId, 'director', {
        chapterNo: Number(req.params.no),
        payload: { feedback: req.body?.feedback || '' },
      });
      return res.json({ async: true, job });
    }
    const ch = await seriesHelper.directorRewrite(req.params.bookId, Number(req.params.no), req.body?.feedback || '');
    res.json(ch);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== ISEKAI (穿越) =====
app.post('/api/series/:bookId/isekai/outline', async (req, res) => {
  try {
    if (req.body?.async !== false) {
      const job = seriesJobs.enqueueJob(req.params.bookId, 'isekai_outline');
      return res.json({ async: true, job });
    }
    res.json(await isekaiHelper.generateScriptOutline(req.params.bookId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** 穿越：按书名拉取合集/单元剧篇目（无需先建书） */
app.post('/api/series/isekai/list-stories', async (req, res) => {
  try {
    const result = await isekaiHelper.listCollectionStories(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** 穿越原创：编剧问诊（生成大纲前） */
app.get('/api/series/:bookId/screenwriter/questions', (req, res) => {
  try {
    res.json(require('./screenwriter-helper').getQuestions(req.params.bookId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/screenwriter/submit', async (req, res) => {
  try {
    res.json(await require('./screenwriter-helper').submitAnswers(req.params.bookId, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/screenwriter/skip', (req, res) => {
  try {
    res.json(require('./screenwriter-helper').skipScreenwriter(req.params.bookId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** 穿越：设置故事来源（书名导入 / JSON 正文） */
app.post('/api/series/:bookId/isekai/source', (req, res) => {
  try {
    res.json(isekaiHelper.setStorySource(req.params.bookId, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** 穿越：上传 txt 小说作为故事来源 */
app.post('/api/series/:bookId/isekai/source/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择 .txt 小说文件' });
    const name = String(req.file.originalname || '').toLowerCase();
    if (!/\.(txt|text|md)$/i.test(name) && req.file.mimetype && !/text|markdown/.test(req.file.mimetype)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: '仅支持 .txt / .md 文本小说' });
    }
    res.json(isekaiHelper.setStorySourceFromFile(req.params.bookId, req.file, {
      title: req.body?.title || '',
    }));
  } catch (e) {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/isekai/begin', async (req, res) => {
  try {
    const prefer = {
      user_cast_name: req.body?.user_cast_name || req.body?.userCastName || '',
      char_cast_name: req.body?.char_cast_name || req.body?.charCastName || '',
    };
    if (req.body?.async !== false) {
      const job = seriesJobs.enqueueJob(req.params.bookId, 'isekai_begin', { payload: prefer });
      return res.json({ async: true, job });
    }
    res.json(await isekaiHelper.beginTransmigrate(req.params.bookId, prefer));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/series/:bookId/isekai/chapters/:no', (req, res) => {
  try {
    res.json(isekaiHelper.getChapterPlay(req.params.bookId, Number(req.params.no)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/isekai/chapters/:no/start', async (req, res) => {
  try {
    const force = !!req.body?.force;
    if (req.body?.async !== false) {
      const job = seriesJobs.enqueueJob(req.params.bookId, 'isekai_start', {
        chapterNo: Number(req.params.no),
        payload: force ? { force: true } : {},
      });
      return res.json({ async: true, job });
    }
    res.json(await isekaiHelper.startChapterPlay(req.params.bookId, Number(req.params.no)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/isekai/chapters/:no/turn', async (req, res) => {
  try {
    const bookId = req.params.bookId;
    const no = Number(req.params.no);
    const text = req.body?.text || '';
    const whisper = !!req.body?.whisper;
    if (req.body?.async !== false) {
      const prep = await isekaiHelper.userPlayTurn(bookId, no, {
        text,
        whisper,
        stopBeforeAi: true,
      });
      if (prep.pending) {
        const job = seriesJobs.enqueueJob(bookId, 'isekai_turn', {
          chapterNo: no,
          payload: { turnIdBefore: prep.turnIdBefore },
        });
        return res.json({
          async: true,
          job,
          turns: prep.turns,
          chapter: prep.chapter,
          quest: prep.quest,
          slack_ok: prep.slack_ok,
        });
      }
      return res.json(prep);
    }
    res.json(await isekaiHelper.userPlayTurn(bookId, no, { text, whisper }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/isekai/chapters/:no/turns/:turnId/regenerate', async (req, res) => {
  try {
    res.json(await isekaiHelper.regenerateTurn(
      req.params.bookId,
      Number(req.params.no),
      Number(req.params.turnId),
    ));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/isekai/chapters/:no/finish', async (req, res) => {
  try {
    res.json(await isekaiHelper.finishChapterPlay(req.params.bookId, Number(req.params.no)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/series/:bookId/whatif/play', (req, res) => {
  try {
    res.json(whatifHelper.getPlayState(req.params.bookId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/whatif/start', async (req, res) => {
  try {
    res.json(await whatifHelper.startPlay(req.params.bookId, {
      force: !!(req.body?.force),
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/whatif/turn', async (req, res) => {
  try {
    res.json(await whatifHelper.userPlayTurn(req.params.bookId, {
      text: req.body?.text,
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/series/:bookId/illusion/generate', async (req, res) => {
  try {
    const bookId = Number(req.params.bookId);
    const book = seriesHelper.getBook(bookId);
    if (!book) return res.status(404).json({ error: '幻象不存在' });
    if (book.mode !== 'illusion') return res.status(400).json({ error: '这不是幻象' });
    const force = !!(req.body?.force);
    const useAsync = req.body?.async !== false;
    if (useAsync) {
      const job = seriesJobs.enqueueJob(bookId, 'illusion', { chapterNo: 1, payload: { force } });
      return res.json({ async: true, job });
    }
    res.json(await illusionHelper.generateStory(bookId, { force }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== IMPRESSIONS (角色对用户的画像短条) =====
app.get('/api/impressions/:charId', (req, res) => {
  try { expandLegacyImpressions(req.params.charId); } catch {}
  const cluster = require('./portrait-cluster-helper');
  try { cluster.ensureClusterColumns(); cluster.compactPortraitCards(req.params.charId, 'char_impressions'); } catch {}
  const rows = db.prepare('SELECT * FROM char_impressions WHERE character_id=? ORDER BY id DESC').all(req.params.charId);
  // 纠偏：已确认项若误带（?）后缀则去掉；旧分类名规范化（杂性格项由 expandLegacy 清理）
  for (const r of rows) {
    const bare = String(r.content || '').replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
    const hasQ = /（\?）\s*$/.test(r.content || '') || /\(\?\)\s*$/.test(r.content || '');
    if (r.confirmed === 1 && hasQ && bare) {
      try {
        db.prepare('UPDATE char_impressions SET content=? WHERE id=?').run(bare, r.id);
        r.content = bare;
      } catch {}
    }
    const nextCat = normalizeImpressionCategory(r.category);
    if (nextCat && nextCat !== r.category) {
      try {
        db.prepare('UPDATE char_impressions SET category=? WHERE id=?').run(nextCat, r.id);
        r.category = nextCat;
      } catch {}
    }
  }
  const decorated = rows.map((r) => cluster.decorateCardRow(r, 'char_impressions'));
  const order = Object.fromEntries((IMPRESSION_CATEGORY_HINTS || IMPRESSION_CATEGORIES || []).map((c, i) => [c, i]));
  decorated.sort((a, b) => {
    const ca = order[a.category] ?? 50;
    const cb = order[b.category] ?? 50;
    if (ca !== cb) return ca - cb;
    const sa = String(a.subcategory || '').localeCompare(String(b.subcategory || ''), 'zh-CN');
    if (sa !== 0) return sa;
    return (b.id || 0) - (a.id || 0);
  });
  res.json(decorated);
});

app.post('/api/impressions', (req, res) => {
  const { character_id, characterId, content, keywords = '[]', category = 'general', subcategory = '', note = '', auto_generated = 0, confirmed = 1 } = req.body;
  const cid = character_id || characterId;
  if (!cid || !content) return res.status(400).json({ error: 'character_id and content required' });
  let kws = Array.isArray(keywords) ? keywords : (() => { try { return JSON.parse(keywords || '[]'); } catch { return []; } })();
  const merged = mergeImpressionItems(cid, [{
    category: normalizeImpressionCategory(category) || '性格',
    subcategory,
    content,
    note,
    keywords: kws,
    confirmed: confirmed ? 1 : 0,
    auto_generated: auto_generated ? 1 : 0,
    bundle: true,
  }]);
  res.json({ ok: true, merged });
});

app.patch('/api/impressions/:id', (req, res) => {
  const { content, keywords, category, subcategory, note, confirmed } = req.body;
  const cluster = require('./portrait-cluster-helper');
  cluster.ensureClusterColumns();
  const imp = db.prepare('SELECT * FROM char_impressions WHERE id=?').get(req.params.id);
  if (!imp) return res.status(404).json({ error: 'Not found' });
  let facts = cluster.cardFacts(imp);
  if (content != null) {
    facts = String(content).split(/\n/).map((s) => String(s).trim()).filter((s) => s.length >= 2);
  }
  facts = cluster.uniqueFacts(facts);
  let ctx = null;
  try {
    ctx = cluster.getVoiceCtx(imp.character_id);
    ctx.voice = 'user-portrait';
    facts = cluster.uniqueFacts(facts.map((f) => cluster.rewriteVoice(f, ctx)));
  } catch { /* ignore */ }
  let nextContent = facts[0] || String(content ?? imp.content);
  let nextConfirmed = confirmed != null ? (confirmed ? 1 : 0) : (imp.confirmed ?? 1);
  if (confirmed === true || confirmed === 1) {
    facts = facts.map((f) => f.replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim());
    nextContent = (facts[0] || nextContent).replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
    nextConfirmed = 1;
  } else if (confirmed === false || confirmed === 0) {
    nextConfirmed = 0;
  }
  let base = [];
  if (keywords != null) {
    base = Array.isArray(keywords) ? keywords : (() => { try { return JSON.parse(keywords || '[]'); } catch { return []; } })();
  } else {
    try { base = JSON.parse(imp.keywords || '[]'); } catch { base = []; }
  }
  const kws = deriveImpressionKeywords(facts.join('、'), base);
  const cat = normalizeImpressionCategory(category ?? imp.category) || imp.category || '性格';
  let noteText = note != null ? String(note).trim().slice(0, 36) : (imp.note || '');
  if (ctx) {
    try { noteText = cluster.rewriteNote(noteText, ctx); } catch { /* ignore */ }
  }
  db.prepare(
    `UPDATE char_impressions SET content=?, related_facts=?, keywords=?, category=?, subcategory=?, note=?, confirmed=?, topic_key=? WHERE id=?`
  ).run(
    nextContent,
    JSON.stringify(facts.slice(1)),
    JSON.stringify(kws),
    cat,
    '',
    noteText,
    nextConfirmed,
    cluster.topicKeyOf(facts.join('、')),
    req.params.id
  );
  res.json({ ok: true, confirmed: nextConfirmed, content: nextContent });
});

app.delete('/api/impressions/:id', (req, res) => {
  db.prepare('DELETE FROM char_impressions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== CHAR TRAITS（角色喜好/擅长·话题触发） =====
app.get('/api/characters/:id/traits', (req, res) => {
  try {
    const traits = require('./char-trait-helper').listTraits(req.params.id);
    res.json(traits);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/characters/:id/traits', (req, res) => {
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  try {
    const traits = require('./char-trait-helper').replaceTraits(req.params.id, req.body?.traits || []);
    res.json({ ok: true, traits });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== WARDROBE / APPEARANCE =====
const wardrobeHelper = () => require('./wardrobe-helper');

app.get('/api/characters/:id/wardrobe', (req, res) => {
  try {
    const char = db.prepare('SELECT id FROM characters WHERE id=?').get(req.params.id);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    res.json({
      items: wardrobeHelper().listWardrobeItems(req.params.id),
      categories: wardrobeHelper().WARDROBE_CATEGORIES,
    });
  } catch (e) {
    console.error('[wardrobe] list', e);
    res.status(500).json({ error: e.message || '读取衣柜失败' });
  }
});

app.post('/api/characters/:id/wardrobe/purchase', async (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  try {
    const settings = getSettings();
    const created = await wardrobeHelper().purchaseWardrobeItems(
      charId,
      req.body?.categories || [],
      { settings, callChatAPIComplete },
    );
    res.json({ ok: true, items: created });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/characters/:id/wardrobe/items', (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const { category, name, brand_style, description, tags, image_url, source } = req.body || {};
  if (!category || !name) return res.status(400).json({ error: 'category 与 name 必填' });
  try {
    const item = wardrobeHelper().insertWardrobeItem(charId, {
      category,
      name: String(name).trim(),
      brand_style: String(brand_style || '').trim(),
      description: String(description || '').trim(),
      tags: Array.isArray(tags) ? tags : [],
      source: String(source || 'user').trim() || 'user',
      image_url: String(image_url || '').trim(),
    });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/characters/:id/wardrobe/items/:itemId', (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const row = db.prepare('SELECT * FROM char_wardrobe_items WHERE id=? AND character_id=?').get(itemId, charId);
  if (!row) return res.status(404).json({ error: '单品不存在' });
  const { name, brand_style, description, tags, category } = req.body || {};
  db.prepare(
    `UPDATE char_wardrobe_items SET name=?, brand_style=?, description=?, tags=?, category=? WHERE id=?`
  ).run(
    name != null ? String(name).trim() : row.name,
    brand_style != null ? String(brand_style).trim() : row.brand_style,
    description != null ? String(description).trim() : row.description,
    tags != null ? JSON.stringify(tags) : row.tags,
    category || row.category,
    itemId,
  );
  res.json({ ok: true });
});

app.delete('/api/characters/:id/wardrobe/items/:itemId', (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const r = db.prepare('DELETE FROM char_wardrobe_items WHERE id=? AND character_id=?').run(itemId, charId);
  if (!r.changes) return res.status(404).json({ error: '单品不存在' });
  res.json({ ok: true });
});

app.get('/api/characters/:id/outfits/today', (req, res) => {
  try {
    const charId = parseInt(req.params.id, 10);
    const char = db.prepare('SELECT id, timezone FROM characters WHERE id=?').get(charId);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    const date = req.query.date || getLocalDateStr(new Date(), char.timezone || 'Asia/Shanghai');
    const outfits = wardrobeHelper().getDailyOutfits(charId, date);
    const current = wardrobeHelper().resolveCurrentOutfit(charId, date);
    res.json({
      date,
      slots: wardrobeHelper().OUTFIT_SLOTS,
      outfits,
      current_slot: current.slot,
      current_outfit: current.outfit,
      current_summary: current.summary,
    });
  } catch (e) {
    console.error('[wardrobe] outfits/today', e);
    res.status(500).json({ error: e.message || '读取今日穿搭失败' });
  }
});

app.put('/api/characters/:id/outfits/today/:slot', (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id, timezone FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const slot = String(req.params.slot || '').trim();
  if (!wardrobeHelper().OUTFIT_SLOTS.some((s) => s.id === slot)) {
    return res.status(400).json({ error: '无效 slot' });
  }
  const date = req.body?.date || getLocalDateStr(new Date(), char.timezone || 'Asia/Shanghai');
  wardrobeHelper().saveDailyOutfit(charId, date, slot, req.body?.outfit || {}, 'user');
  res.json({ ok: true });
});

app.post('/api/characters/:id/outfits/generate-today', async (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id, timezone FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const date = req.body?.date || getLocalDateStr(new Date(), char.timezone || 'Asia/Shanghai');
  try {
    const outfits = await wardrobeHelper().generateDailyOutfitsForChar(charId, date, { force: !!req.body?.force });
    res.json({ ok: true, date, outfits });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 推荐穿搭：基于当前时间/活动推荐几套
app.get('/api/characters/:id/outfits/recommend', (req, res) => {
  try {
    const charId = parseInt(req.params.id, 10);
    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    const wh = wardrobeHelper();
    const items = wh.listWardrobeItems(charId);
    const season = wh.getCurrentSeason();
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // 推断当前场合
    const currentSlot = wh.inferCurrentSlotFromSchedule(charId, dateStr);
    const { summary } = wh.resolveCurrentOutfit(charId, dateStr, currentSlot);

    // 生成3个推荐：居家、外出、社交各一套
    const recs = [];
    const seedBase = `${charId}-${dateStr}-rec`;
    for (const slot of ['home', 'out', 'social']) {
      const outfit = wh.composeOutfitForSlot(charId, slot, items, seedBase + slot, season, char);
      const slotLabel = wh.OUTFIT_SLOTS.find(s => s.id === slot)?.label || slot;
      recs.push({
        slot,
        slotLabel,
        summary: wh.buildOutfitSummary(outfit, items),
        outfit,
      });
    }

    res.json({
      ok: true,
      currentSlot,
      currentSummary: summary || '暂无当前穿搭',
      recommendations: recs,
      season: season === 'spring' ? '春' : season === 'summer' ? '夏' : season === 'autumn' ? '秋' : '冬',
    });
  } catch (e) {
    console.error('[wardrobe] recommend', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/characters/:id/appearance', (req, res) => {
  try {
    const char = db.prepare('SELECT appearance_profile, image_ref, image_style FROM characters WHERE id=?').get(req.params.id);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    res.json({
      appearance_profile: wardrobeHelper().parseAppearanceProfile(char.appearance_profile),
      image_ref: normalizeImageRefGroups(char.image_ref || '[]'),
      image_style: char.image_style || 'anime',
    });
  } catch (e) {
    console.error('[wardrobe] appearance', e);
    res.status(500).json({ error: e.message || '读取外貌档案失败' });
  }
});

app.put('/api/characters/:id/appearance', (req, res) => {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const d = req.body || {};
  if (d.appearance_profile !== undefined) {
    const profile = wardrobeHelper().parseAppearanceProfile(d.appearance_profile);
    db.prepare('UPDATE characters SET appearance_profile=? WHERE id=?').run(JSON.stringify(profile), req.params.id);
  }
  if (d.image_ref !== undefined) {
    db.prepare('UPDATE characters SET image_ref=? WHERE id=?').run(
      JSON.stringify(normalizeImageRefGroups(d.image_ref)),
      req.params.id,
    );
  }
  if (d.image_style !== undefined) {
    db.prepare('UPDATE characters SET image_style=? WHERE id=?').run(d.image_style || 'anime', req.params.id);
  }
  res.json({ ok: true });
});

// ===== HOME MONITOR =====
const monitorHelper = () => require('./monitor-helper');

/* 用聊天 API 把简短的居住环境/家装说明扩成详细英文提示词 */
app.post('/api/characters/:id/home-environment/expand', async (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id, home_environment, home_refs FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const settings = getSettings();
  if (!(settings.chat_api_url || settings.memory_api_url || '').trim()) {
    return res.status(400).json({ error: '请先在设置里配置聊天 API' });
  }
  const raw = String(req.body?.raw ?? char.home_environment ?? '').trim();
  if (!raw) return res.status(400).json({ error: '请先填写居住环境说明' });
  const homeRefs = Array.isArray(char.home_refs)
    ? (typeof char.home_refs === 'string' ? (() => { try { return JSON.parse(char.home_refs || '[]'); } catch { return []; } })() : char.home_refs)
    : [];
  try {
    const prompt = await monitorHelper().buildHomeEnvironmentPrompt(
      { raw, homeRefs },
      settings,
      callChatAPIComplete,
    );
    res.json({ ok: true, prompt });
  } catch (e) {
    console.error('[home-environment/expand]', e);
    res.status(500).json({ error: e.message || '生成失败' });
  }
});

app.get('/api/characters/:id/monitor', (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  try {
    const viewRoom = req.query?.room;
    const state = monitorHelper().buildMonitorState(char, { viewRoom });
    res.json({
      ok: true,
      character: {
        id: char.id,
        name: char.name,
        display_name: char.display_name,
        avatar: char.avatar,
      },
      state,
    });
  } catch (e) {
    console.error('[monitor] get', e);
    res.status(500).json({ error: e.message || '读取监控状态失败' });
  }
});

app.put('/api/characters/:id/monitor/description', (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  try {
    const description = monitorHelper().saveMonitorDescription(charId, req.body?.description);
    res.json({ ok: true, description });
  } catch (e) {
    console.error('[monitor] description save', e);
    res.status(500).json({ error: e.message || '保存描述失败' });
  }
});

app.delete('/api/characters/:id/monitor/description', (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  try {
    monitorHelper().clearMonitorDescription(charId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[monitor] description clear', e);
    res.status(500).json({ error: e.message || '清除描述失败' });
  }
});

app.put('/api/characters/:id/monitor/room-scene', (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  try {
    const saved = monitorHelper().saveMonitorRoomScene(charId, req.body?.room, req.body?.text);
    res.json({ ok: true, ...saved });
  } catch (e) {
    console.error('[monitor] room-scene save', e);
    res.status(400).json({ error: e.message || '保存画面描述失败' });
  }
});

app.delete('/api/characters/:id/monitor/room-scene', (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  try {
    monitorHelper().clearMonitorRoomScene(charId, req.body?.room || req.query?.room);
    res.json({ ok: true });
  } catch (e) {
    console.error('[monitor] room-scene clear', e);
    res.status(400).json({ error: e.message || '清除画面描述失败' });
  }
});

app.post('/api/characters/:id/monitor/capture', async (req, res) => {
  const charId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const mode = req.body?.mode === 'video' ? 'video' : 'image';
  const settings = getSettings();
  const publicBase = `${req.protocol}://${req.get('host')}`;
  try {
    const result = await monitorHelper().captureMonitorMedia(charId, mode, settings, {
      publicBase,
      room: req.body?.room,
    });
    try {
      push('album_update', { characterId: charId, albumId: result.album_id, source: 'monitor' });
    } catch {}
    res.json(result);
  } catch (e) {
    console.error('[monitor/capture]', e);
    res.status(500).json({ error: e.message || '生成失败' });
  }
});

app.post('/api/impressions/:charId/merge', (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'items required' });
  const merged = mergeImpressionItems(charId, items);
  res.json({ ok: true, merged });
});

/** 打扫画像：合并语义重复、修好断句（不从聊天新抽印象） */
app.post('/api/impressions/:charId/tidy', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const settings = getSettings();
  if (!(settings.chat_api_url || settings.memory_api_url || '').trim()) {
    return res.status(400).json({ error: '请先配置 API' });
  }
  try {
    const result = await require('./portrait-cluster-helper').tidyPortraitWithAI(
      charId,
      'char_impressions',
      { callChatAPIComplete, settings }
    );
    try { push('impressions_updated', { characterId: charId }); } catch {}
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || '整理失败' });
  }
});

// ===== PRESETS =====
app.get('/api/presets', (req, res) => {
  res.json(db.prepare('SELECT * FROM presets ORDER BY id').all());
});

app.post('/api/presets', (req, res) => {
  const { name, content, type, scopes, enabled } = req.body;
  const { parsePresetScopes } = require('./preset-helper');
  const presetType = type || 'custom';
  const scopesJson = JSON.stringify(
    Array.isArray(scopes) && scopes.length
      ? scopes
      : parsePresetScopes(null, presetType)
  );
  const enabledVal = enabled === 0 || enabled === '0' ? 0 : 1;
  const r = db.prepare('INSERT INTO presets (name, content, type, scopes, enabled) VALUES (?,?,?,?,?)')
    .run(name || '', content, presetType, scopesJson, enabledVal);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/presets/:id', (req, res) => {
  const { name, content, enabled, type, scopes } = req.body;
  const { parsePresetScopes } = require('./preset-helper');
  const presetType = type || 'custom';
  const existing = db.prepare('SELECT scopes FROM presets WHERE id=?').get(req.params.id);
  const scopesJson = scopes !== undefined
    ? JSON.stringify(Array.isArray(scopes) ? scopes : parsePresetScopes(scopes, presetType))
    : (existing?.scopes || JSON.stringify(parsePresetScopes(null, presetType)));
  db.prepare('UPDATE presets SET name=?, content=?, enabled=?, type=?, scopes=? WHERE id=?')
    .run(name, content, enabled ? 1 : 0, presetType, scopesJson, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/presets/:id', (req, res) => {
  db.prepare('DELETE FROM presets WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== EMOJI =====
app.get('/api/emoji/categories', (req, res) => {
  try { healMissingEmojiFiles(); } catch (e) { console.warn('[emoji] heal', e.message); }
  const cats = db.prepare('SELECT * FROM emoji_categories ORDER BY id').all();
  const allEmojis = db.prepare('SELECT * FROM emojis ORDER BY category_id, id').all();
  const byCat = new Map();
  for (const e of allEmojis) {
    if (!byCat.has(e.category_id)) byCat.set(e.category_id, []);
    byCat.get(e.category_id).push(decorateEmojiRecord(e));
  }
  res.set('Cache-Control', 'no-store');
  res.json(cats.map(c => ({ ...c, emojis: byCat.get(c.id) || [] })));
});

app.post('/api/emoji/categories', (req, res) => {
  const { name } = req.body;
  const r = db.prepare('INSERT INTO emoji_categories (name) VALUES (?)').run(name);
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/emoji/categories/:id', (req, res) => {
  db.prepare('DELETE FROM emojis WHERE category_id=?').run(req.params.id);
  db.prepare('DELETE FROM emoji_categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/emoji/upload', upload.array('files', 50), (req, res) => {
  const { categoryId } = req.body;
  const files = req.files || [];
  const results = files.map(f => ({
    filename: f.filename,
    originalname: f.originalname,
    id: null,
  }));
  res.json({ ok: true, files: results });
});

app.post('/api/emoji', (req, res) => {
  const { categoryId, filename, description } = req.body;
  const r = db.prepare('INSERT INTO emojis (category_id, filename, description) VALUES (?,?,?)').run(categoryId, filename, description);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/emoji/:id', (req, res) => {
  const { description } = req.body;
  db.prepare('UPDATE emojis SET description=? WHERE id=?').run(description, req.params.id);
  const row = db.prepare('SELECT * FROM emojis WHERE id=?').get(req.params.id);
  let merged = 0;
  try { merged = mergeReplacementEmoji(row)?.merged || 0; } catch (e) { console.warn('[emoji] merge', e.message); }
  invalidateEmojiLiveCache();
  res.json({ ok: true, merged });
});

app.post('/api/emoji/:id/replace', upload.single('file'), (req, res) => {
  const row = db.prepare('SELECT * FROM emojis WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '表情不存在' });
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const destName = emojiBasename(row.filename);
  const dest = destName ? path.join(UPLOADS_PATH, destName) : '';
  if (!dest || destName.includes('..')) return res.status(400).json({ error: '文件名无效' });
  try {
    fs.copyFileSync(req.file.path, dest);
    if (req.file.filename !== destName) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || '替换失败' });
  }
  invalidateEmojiLiveCache();
  res.json({ ok: true, filename: destName, url: `/uploads/${destName}` });
});

app.delete('/api/emoji/:id', (req, res) => {
  db.prepare('DELETE FROM emojis WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

const emojiImport = require('./emoji-import');

app.get('/api/emoji/categories/:id/export', (req, res) => {
  const catId = Number(req.params.id);
  if (!Number.isFinite(catId) || catId <= 0) return res.status(400).json({ error: '无效分类' });
  try {
    const pack = emojiImport.exportCategoryPack(db, catId, UPLOADS_PATH);
    res.json(pack);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/emoji/import-json', async (req, res) => {
  const { categoryId, pack, createCategory } = req.body || {};
  let catId = categoryId ? Number(categoryId) : null;
  let createdCatId = null;
  try {
    const parsed = typeof pack === 'string' ? JSON.parse(pack) : pack;
    if (!catId && createCategory !== false) {
      const normalized = emojiImport.normalizePack(parsed);
      const catName = (normalized?.name || '导入的表情包').slice(0, 20);
      createdCatId = db.prepare('INSERT INTO emoji_categories (name) VALUES (?)').run(catName).lastInsertRowid;
      catId = createdCatId;
    }
    if (!catId) return res.status(400).json({ error: '缺少 categoryId' });

    const result = await emojiImport.importJsonPack(db, catId, parsed, UPLOADS_PATH);
    if (!result.imported) {
      if (createdCatId) db.prepare('DELETE FROM emoji_categories WHERE id=?').run(createdCatId);
      return res.status(400).json({
        error: emojiImport.formatImportError(result),
        ...result,
        categoryId: catId,
      });
    }
    res.json({ ok: true, categoryId: catId, ...result });
  } catch (e) {
    if (createdCatId) db.prepare('DELETE FROM emoji_categories WHERE id=?').run(createdCatId);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/emoji/import-pack', uploadLarge.single('pack'), async (req, res) => {
  const categoryId = req.body?.categoryId ? Number(req.body.categoryId) : null;
  const file = req.file;
  if (!file) return res.status(400).json({ error: '请上传 .json 或 .zip 文件' });

  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();

  let createdCatId = null;
  try {
    let catId = categoryId;

    if (ext === '.zip') {
      if (!catId) {
        const manifestName = await emojiImport.peekZipPackName(file.path);
        createdCatId = db.prepare('INSERT INTO emoji_categories (name) VALUES (?)').run(manifestName).lastInsertRowid;
        catId = createdCatId;
      }
      const result = await emojiImport.importZipPack(db, catId, file.path, UPLOADS_PATH);
      fs.unlink(file.path, () => {});
      if (!result.imported) {
        if (createdCatId) db.prepare('DELETE FROM emoji_categories WHERE id=?').run(createdCatId);
        return res.status(400).json({ error: emojiImport.formatImportError(result), ...result, categoryId: catId });
      }
      return res.json({ ok: true, categoryId: catId, ...result });
    }

    if (ext === '.json' || ext === '.txt') {
      const text = fs.readFileSync(file.path, 'utf8');
      fs.unlink(file.path, () => {});
      if (!catId) {
        let catName = '导入的表情包';
        if (ext === '.json') {
          try {
            const normalized = emojiImport.normalizePack(JSON.parse(text));
            if (normalized?.name) catName = normalized.name.slice(0, 20);
          } catch {
            const raw = emojiImport.normalizePack(text);
            if (raw?.name) catName = raw.name.slice(0, 20);
          }
        }
        createdCatId = db.prepare('INSERT INTO emoji_categories (name) VALUES (?)').run(catName).lastInsertRowid;
        catId = createdCatId;
      }
      const result = await emojiImport.importJsonPack(db, catId, text, UPLOADS_PATH);
      if (!result.imported) {
        if (createdCatId) db.prepare('DELETE FROM emoji_categories WHERE id=?').run(createdCatId);
        return res.status(400).json({ error: emojiImport.formatImportError(result), ...result, categoryId: catId });
      }
      return res.json({ ok: true, categoryId: catId, ...result });
    }

    fs.unlink(file.path, () => {});
    return res.status(400).json({ error: '仅支持 .json、.txt 或 .zip 文件' });
  } catch (e) {
    if (createdCatId) db.prepare('DELETE FROM emoji_categories WHERE id=?').run(createdCatId);
    if (file?.path) fs.unlink(file.path, () => {});
    res.status(400).json({ error: e.message });
  }
});

// ===== 角色相册 =====
app.get('/api/album/:charId', (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });

  // 打开相册时补扫聊天里已生成的本地媒体（同步入库）；外链异步补
  try { backfillAlbumFromChatMedia(charId); } catch (e) {
    console.warn('[album] backfill', e.message);
  }

  const mediaType = (req.query.type || '').trim() || null;
  const subject = (req.query.subject || '').trim() || null;
  let sql = 'SELECT * FROM character_album WHERE character_id=?';
  const params = [charId];
  if (mediaType && ['image', 'video', 'voice'].includes(mediaType)) {
    sql += ' AND media_type=?';
    params.push(mediaType);
  }
  if (subject && ['self', 'other'].includes(subject)) {
    sql += ' AND (subject=? OR (subject IS NULL AND ?=\'other\'))';
    params.push(subject, subject);
  }
  sql += ' ORDER BY id DESC';
  const items = db.prepare(sql).all(...params).map(row => ({
    ...mapAlbumRow(row),
    subject: row.media_type === 'voice' ? 'other' : (row.subject === 'self' ? 'self' : 'other'),
  }));
  res.json(items);
});

app.post('/api/album/upload', uploadAlbum.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const mediaType = String(req.body?.mediaType || 'image').trim();
  if (!['image', 'video', 'voice'].includes(mediaType)) {
    return res.status(400).json({ error: 'mediaType 须为 image / video / voice' });
  }
  let filename = req.file.filename;
  const ext = path.extname(req.file.originalname || filename).toLowerCase();
  if (mediaType === 'voice' && /\.(mp4|m4v|mov|m4a|aac|wav|webm|mkv)$/i.test(ext)) {
    try {
      filename = await convertVoiceUploadToMp3(req.file.path, req.file.originalname);
    } catch (e) {
      console.error('[album upload]', e.message);
    }
  }
  res.json({ ok: true, filename, url: `/uploads/${filename}` });
});

app.post('/api/album', (req, res) => {
  const characterId = parseInt(req.body?.characterId, 10);
  const mediaType = String(req.body?.mediaType || '').trim();
  const filename = String(req.body?.filename || '').trim();
  const description = String(req.body?.description || '').trim();
  const subjectRaw = String(req.body?.subject || 'other').trim();
  const subject = mediaType === 'voice' ? 'other' : (subjectRaw === 'self' ? 'self' : 'other');
  if (!characterId || !filename || !['image', 'video', 'voice'].includes(mediaType)) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const r = db.prepare(
    'INSERT INTO character_album (character_id, media_type, filename, description, subject) VALUES (?,?,?,?,?)'
  ).run(characterId, mediaType, filename, description, subject);
  res.json({ id: r.lastInsertRowid, url: `/uploads/${filename}` });
});

app.put('/api/album/:id', (req, res) => {
  const description = String(req.body?.description || '').trim();
  const note = req.body?.note !== undefined ? String(req.body.note || '').trim().slice(0, 500) : undefined;
  const row = db.prepare('SELECT * FROM character_album WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '不存在' });
  let subject = row.subject;
  if (req.body?.subject !== undefined && row.media_type !== 'voice') {
    subject = req.body.subject === 'self' ? 'self' : 'other';
  }
  if (note !== undefined) {
    db.prepare('UPDATE character_album SET description=?, subject=?, note=? WHERE id=?').run(description, subject, note, req.params.id);
  } else {
    db.prepare('UPDATE character_album SET description=?, subject=? WHERE id=?').run(description, subject, req.params.id);
  }
  res.json({ ok: true });
});

app.get('/api/album/item/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM character_album WHERE id=?').get(req.params.id);
  if (!row?.filename) return res.status(404).json({ error: '不存在' });
  const fp = path.join(UPLOADS_PATH, row.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  const ext = path.extname(row.filename) || (row.media_type === 'video' ? '.mp4' : row.media_type === 'voice' ? '.mp3' : '.jpg');
  const base = String(row.description || 'album').replace(/[\\/:*?"<>|\r\n]+/g, '').slice(0, 24) || 'album';
  const downloadName = `${base}-${row.id}${ext}`;
  res.download(fp, downloadName);
});

app.delete('/api/album/:id', (req, res) => {
  const row = db.prepare('SELECT filename FROM character_album WHERE id=?').get(req.params.id);
  if (row?.filename) {
    const fp = path.join(UPLOADS_PATH, row.filename);
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
  }
  db.prepare('DELETE FROM character_album WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== 通话记录 =====
app.post('/api/calls/incoming-result', (req, res) => {
  const outreach = require('./proactive-outreach-helper');
  const outcome = String(req.body?.outcome || '').trim();
  const logId = parseInt(req.body?.logId, 10) || 0;
  const characterId = parseInt(req.body?.characterId, 10) || 0;
  const result = outreach.resolveIncomingCall(db, { logId, characterId, outcome });
  if (!result.ok && result.error === 'bad_outcome') {
    return res.status(400).json({ error: 'outcome 须为 answered / declined / missed' });
  }
  if (!result.ok) return res.status(404).json({ error: '来电记录不存在' });
  res.json(result);
});

app.post('/api/call-logs', (req, res) => {
  const { characterId, duration, transcript } = req.body;
  if (!characterId) return res.status(400).json({ error: 'characterId required' });
  try { clearCallScene(characterId, { resetMove: true }); } catch {}
  try { require('./vocal-clips-helper').clearCallBreathBed(characterId); } catch {}
  db.prepare(`INSERT INTO call_logs (character_id, duration, transcript) VALUES (?,?,?)`)
    .run(characterId, duration || 0, transcript || '');
  res.json({ ok: true });
});

app.get('/api/call-logs/:charId', (req, res) => {
  const logs = db.prepare(`SELECT * FROM call_logs WHERE character_id=? ORDER BY id DESC LIMIT 20`)
    .all(req.params.charId);
  res.json(logs);
});

// ===== 印象 AI 生成（不污染聊天记录；不用整份聊天系统提示，避免被说教/关心规则带偏） =====
app.post('/api/impressions/:charId/generate', async (req, res) => {
  const charId = req.params.charId;
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const settings = getSettings();
  if (!(settings.chat_api_url || '').trim()) return res.status(400).json({ error: '请先配置 API' });

  const history = db.prepare(
    `SELECT role, content, type FROM messages WHERE character_id=? AND is_dream=0 AND recalled=0
     AND (type IS NULL OR type IN ('text','voice')) ORDER BY id DESC LIMIT 40`
  ).all(charId).reverse();
  if (history.length < 2) return res.status(400).json({ error: '对话记录太少，先多聊几句再来生成印象吧 💬' });

  const chatStr = history.map(m =>
    `${m.role === 'user' ? (settings.username || '旅人') : char.name}：${String(m.content || '').replace(/^【自动回复】/, '').slice(0, 200)}`
  ).join('\n');

  const catsHint = (IMPRESSION_CATEGORY_HINTS || IMPRESSION_CATEGORIES || []).join('、');
  let portraitCall = settings.username || '旅人';
  try {
    portraitCall = require('./portrait-cluster-helper').unifiedUserCall(char, settings, history.filter((m) => m.role === 'assistant'));
  } catch { /* ignore */ }
  const sysPrompt = `你在整理「${char.name}」对用户的稳定印象。
只输出画像短句，不要扮演聊天、不要说教、不要安慰、不要编造未出现的事实。`;
  const userMsg = `根据对话，整理「${char.name}」怎么看「${portraitCall}」——角色视角的一句事实，不是事件流水。

每条单独一行，格式严格：【大类】短句
常用大类：${catsHint}
不要再写小类。意思重复的只留一条。相关联的收在同一大类连续两行（喜欢青梅酒、又觉得酒不好喝 → 两行都写【喜好】）。
感想单独一行：TA：……

硬规则：
· 称呼用户只用「${portraitCall}」，称自己为 TA；禁止用户/你/他/她/旅人混用
· 提到「${char.name}」一律写 TA，不要写角色本名
· 每条 6～20 字完整短句；没把握就不写；最多 8 条
· 【性格】稳定气质；【情绪】一生气/难过时会怎样；【想法】在意点/思维方式；【喜好】具体物偏好；【习惯】作息处事
· 禁止把性格丢进习惯；禁止把「喜欢胡思乱想 / 不喜欢被冷落」丢进喜好
· 禁止：日期、时段、因为/然后/聊了、半截话、提问、脑补、把用户写成爱抱怨/爱哭诉

对话：
${chatStr}`;

  try {
    const aiText = await callChatAPI(settings, sysPrompt, userMsg, 'chat');
    if (!aiText) return res.status(500).json({ error: 'AI 未返回内容' });
    const items = [];
    let last = null;
    for (const line of String(aiText).split('\n').map((l) => l.trim()).filter(Boolean)) {
      const noteLine = line.match(/^(?:TA|感想)\s*[：:]\s*(.+)$/);
      if (noteLine && last) { last.note = String(noteLine[1] || '').trim().slice(0, 36); continue; }
      const tagged = line.match(/^[【\[]([^】\]]{1,16})[】\]]\s*[：:]?\s*(.+)$/);
      if (!tagged) continue;
      const parts = String(tagged[1] || '').split(/[·・]/);
      const cont = String(tagged[2] || '').replace(/^[・\-–]\s*/, '').trim().slice(0, 28);
      if (cont.length < 2 || isJunkImpressionFact(cont)) continue;
      const cat = resolveImpressionCategory(parts[0], cont)
        || normalizeImpressionCategory(parts[0])
        || mapMemoryToImpressionCategory('', cont)
        || '';
      if (!cat) continue;
      last = { category: cat, subcategory: '', content: cont, keywords: [], confirmed: 1, bundle: false };
      items.push(last);
    }
    const merged = items.length ? mergeImpressionItems(charId, items) : 0;
    res.json({ content: aiText, merged, items });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 自我认知（角色怎么看自己：习惯 / 喜好 / 经历） =====
app.get('/api/self-views/:charId', (req, res) => {
  try {
    const self = require('./char-self-helper');
    const rows = self.listSelfViews(req.params.charId);
    const order = Object.fromEntries(self.SELF_CATEGORIES.map((c, i) => [c, i]));
    rows.sort((a, b) => {
      const ca = order[a.category] ?? 50;
      const cb = order[b.category] ?? 50;
      if (ca !== cb) return ca - cb;
      const src = { lived: 0, manual: 1, card: 2 };
      return (src[a.source] ?? 9) - (src[b.source] ?? 9) || (b.id || 0) - (a.id || 0);
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/self-views', (req, res) => {
  try {
    const self = require('./char-self-helper');
    const character_id = req.body?.character_id || req.body?.characterId;
    const id = self.insertSelfView(character_id, {
      content: req.body?.content,
      category: req.body?.category,
      subcategory: req.body?.subcategory,
      note: req.body?.note,
      keywords: req.body?.keywords,
      confirmed: req.body?.confirmed,
      source: req.body?.source || 'manual',
      auto_generated: 0,
      bundle: true,
    });
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/self-views/:id', (req, res) => {
  try {
    const self = require('./char-self-helper');
    const row = self.updateSelfView(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/self-views/:id', (req, res) => {
  try {
    require('./char-self-helper').deleteSelfView(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/self-views/:charId/merge', (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'items required' });
  try {
    const merged = require('./char-self-helper').mergeSelfViewItems(charId, items, {
      source: req.body?.source || 'lived',
    });
    res.json({ ok: true, merged });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/self-views/:charId/generate', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const settings = getSettings();
  if (!(settings.chat_api_url || settings.memory_api_url || '').trim()) {
    return res.status(400).json({ error: '请先配置 API' });
  }
  try {
    const result = await require('./char-self-helper').generateSelfViews(charId, settings, callChatAPIComplete);
    try { push('self_views_updated', { characterId: charId }); } catch {}
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.message === '角色不存在' ? 404 : 500).json({ error: e.message });
  }
});

/** 打扫自我认知：合并语义重复、修好断句（不从角色卡新抽） */
app.post('/api/self-views/:charId/tidy', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const settings = getSettings();
  if (!(settings.chat_api_url || settings.memory_api_url || '').trim()) {
    return res.status(400).json({ error: '请先配置 API' });
  }
  try {
    const result = await require('./portrait-cluster-helper').tidyPortraitWithAI(
      charId,
      'char_self_views',
      { callChatAPIComplete, settings }
    );
    try { push('self_views_updated', { characterId: charId }); } catch {}
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || '整理失败' });
  }
});

// ===== 人生档案（经历 → 一键消化成心智） =====
app.get('/api/archive/:charId', (req, res) => {
  try {
    const archive = require('./char-archive-helper');
    archive.ensureArchiveTable();
    const charId = parseInt(req.params.charId, 10);
    const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    res.json({
      stages: archive.ARCHIVE_STAGES,
      entries: archive.listEntries(charId),
      mindset: archive.getMindset(charId),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/archive', (req, res) => {
  try {
    const archive = require('./char-archive-helper');
    const character_id = req.body?.character_id || req.body?.characterId;
    const row = archive.insertEntry(character_id, {
      stage: req.body?.stage,
      title: req.body?.title,
      content: req.body?.content,
      sort_order: req.body?.sort_order,
    });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/archive/:id', (req, res) => {
  try {
    const row = require('./char-archive-helper').updateEntry(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/archive/:id', (req, res) => {
  try {
    require('./char-archive-helper').deleteEntry(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/archive/:charId/digest', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const settings = getSettings();
  if (!(settings.chat_api_url || settings.memory_api_url || '').trim()) {
    return res.status(400).json({ error: '请先配置 API' });
  }
  try {
    const result = await require('./char-archive-helper').digestArchive(
      charId, settings, callChatAPIComplete
    );
    try { push('archive_digested', { characterId: charId }); } catch {}
    res.json(result);
  } catch (e) {
    const status = e.message === '角色不存在' ? 404
      : /请先添加|解析失败/.test(e.message || '') ? 400
      : 500;
    res.status(status).json({ error: e.message || '消化失败' });
  }
});

// ===== 一天的记忆（整天事记 + 有用讯息 + 画像） =====
app.get('/api/lived/:charId', (req, res) => {
  try {
    const charId = parseInt(req.params.charId, 10);
    const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    res.json(require('./lived-day-helper').overview(charId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/lived/:charId/day/:date', (req, res) => {
  try {
    const lived = require('./lived-day-helper');
    const charId = parseInt(req.params.charId, 10);
    const date = String(req.params.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期不对' });
    res.json(lived.dayDetail(charId, date));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/lived/:charId/digest', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const settings = getSettings();
  if (!(settings.chat_api_url || settings.memory_api_url || '').trim()) {
    return res.status(400).json({ error: '请先配置 API' });
  }
  const tz = settings.timezone || 'Asia/Shanghai';
  const date = String(req.body?.date || '').slice(0, 10)
    || new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  try {
    const lived = require('./lived-day-helper');
    let result;
    try {
      result = await lived.digestDay(charId, date, settings, callChatAPIComplete);
    } catch (e) {
      if (!/还没有可消化|还没有留下/.test(e.message || '')) throw e;
      result = { ok: false, date, error: e.message };
    }
    try {
      result.cognition = await require('./life-fill-helper').digestCognition(charId, date, settings);
    } catch (e) {
      console.warn('[lived] cognition', e.message);
    }
    if (!result.ok && !result.cognition?.ok) {
      return res.status(400).json({ error: result.error || '还没有可消化的内容' });
    }
    res.json(result);
  } catch (e) {
    const status = /还没有|还没记下|解析失败/.test(e.message || '') ? 400 : 500;
    res.status(status).json({ error: e.message || '消化失败' });
  }
});

// ===== 对用户的判断（一条一条，展开才是原因） =====
app.get('/api/user-reads/:charId', (req, res) => {
  try {
    const charId = parseInt(req.params.charId, 10);
    const helper = require('./user-read-helper');
    const about = req.query.about === 'self' ? 'self' : 'user';
    if (about === 'user') {
      helper.migrateLegacy(charId);
      helper.expireRecent(charId);
    }
    res.json({
      categories: about === 'self' ? helper.SELF_CATEGORIES : helper.FACT_CATEGORIES,
      recentCategories: helper.RECENT_CATEGORIES,
      recentTtlDays: helper.RECENT_TTL_DAYS,
      items: helper.listReads(charId, about),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/user-reads', (req, res) => {
  try {
    const characterId = req.body?.character_id || req.body?.characterId;
    const row = require('./user-read-helper').insertRead(characterId, req.body || {});
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/user-reads/:id', (req, res) => {
  try {
    const row = require('./user-read-helper').updateRead(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/user-reads/:id', (req, res) => {
  try {
    require('./user-read-helper').deleteRead(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/user-reads/:charId/digest', async (req, res) => {
  const charId = parseInt(req.params.charId, 10);
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(charId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const settings = getSettings();
  if (!(settings.chat_api_url || settings.memory_api_url || '').trim()) {
    return res.status(400).json({ error: '请先配置 API' });
  }
  try {
    const tz = settings.timezone || 'Asia/Shanghai';
    const date = String(req.body?.date || '').slice(0, 10)
      || new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    // 与人格日子同一条链：碎片→事记→有用讯息→画像
    const result = await require('./lived-day-helper').digestDay(charId, date, settings, callChatAPIComplete);
    res.json({ ok: true, date, ...result, ...(result.portrait || {}) });
  } catch (e) {
    const status = /角色不存在|解析失败|还没有可消化/.test(e.message || '') ? 400 : 500;
    res.status(status).json({ error: e.message || '消化失败' });
  }
});

// ===== 角色心情 =====
app.patch('/api/characters/:id/mood', (req, res) => {
  const { mood } = req.body;
  db.prepare(`UPDATE characters SET mood=? WHERE id=?`).run(mood || '', req.params.id);
  res.json({ ok: true });
});

// ===== 角色情绪（连续心情 + 折线历史）=====
app.get('/api/characters/:id/emotion', (req, res) => {
  try {
    const emotionHelper = require('./emotion-helper');
    const { getDecayedEmotionState } = require('./cron');
    const char = db.prepare(
      'SELECT id, name, mood, personality, emotion_style, behavior, background, emotion_state, relationship, relationship_custom, intro, description FROM characters WHERE id=?'
    ).get(req.params.id);
    if (!char) return res.status(404).json({ error: '角色不存在' });
    let state = getDecayedEmotionState(char);
    if (!state?.mood) {
      const mood = emotionHelper.defaultMood(char);
      const nowIso = new Date().toISOString();
      state = {
        ...(state || {}),
        mood,
        startedAt: nowIso,
        lastUpdateAt: nowIso,
      };
      emotionHelper.appendEmotionLog(char.id, mood, 'init', '情绪轨迹起点');
      db.prepare('UPDATE characters SET emotion_state=? WHERE id=?').run(JSON.stringify(state), char.id);
      emotionHelper.syncCharacterMoodLabel?.(char.id, mood);
    } else {
      state = emotionHelper.sampleMoodIfStale(char.id, state, char);
      db.prepare('UPDATE characters SET emotion_state=? WHERE id=?').run(JSON.stringify(state), char.id);
    }
    const hours = Math.max(2, Math.min(168, parseInt(req.query.hours, 10) || 2));
    const history = emotionHelper.getEmotionHistory(char.id, { hours, limit: hours <= 2 ? 240 : 200 });
    const events = emotionHelper.getEmotionEvents(char.id, { hours, limit: 20 });
    const mood = emotionHelper.publicMoodView(state.mood, char);
    res.json({
      mood,
      conflict: state.phase
        ? { phase: state.phase, kind: state.kind || '', intensity: state.intensity, summary: state.summary || '' }
        : null,
      history,
      events,
      characterMood: char.mood || mood.display,
    });
  } catch (e) {
    console.error('[emotion]', e);
    res.status(500).json({ error: e.message || '读取情绪失败' });
  }
});

// ===== TTS =====
app.post('/api/tts', async (req, res) => {
  const settings = getSettings();
  const { text, characterId, emotion, tone, nsfw } = req.body || {};
  if (!characterId) {
    return res.status(400).json({ error: '缺少角色 ID' });
  }
  const char = db.prepare('SELECT voice_id, voice_id_nsfw, mood, emotion_state, mindset FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  let speak = sanitizeInlineBeans(String(text || ''), { forceStrip: true });
  try {
    const { stripMindsetEcho } = require('./emoji-helper');
    speak = stripMindsetEcho(speak, char?.mindset);
  } catch { /* ignore */ }
  const { pickCharacterVoiceId } = require('./voice-lane-helper');
  const picked = pickCharacterVoiceId(char, { text: speak, nsfw });
  const vid = picked.voiceId;
  if (!vid) {
    return res.status(400).json({ error: '请先在角色中填写 MiniMax 声音 ID' });
  }
  if (!String(speak || '').trim()) {
    return res.status(400).json({ error: '没有可朗读的内容' });
  }
  try {
    const buffer = await callTTS(settings, speak, vid, {
      emotion,
      tone,
      mood: char.mood,
      emotionState: char.emotion_state,
      characterId,
      inCall: !!req.body?.inCall,
    });
    console.log('[TTS] ok voice_id=%s lane=%s char=%s bytes=%d', vid, picked.lane, characterId, buffer.length);
    res.set('Content-Type', 'audio/mp3');
    res.send(buffer);
  } catch (e) {
    console.error('[TTS]', e.message);
    res.status(400).json({
      error: formatApiBillingError(e.message, { label: '语音 TTS' }) || e.message || 'TTS 失败',
    });
  }
});

function robotTokensMatch(expected, provided) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(provided || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function assertRobotAccess(req, settings) {
  if (siteLock.isAuthenticated(req)) return { ok: true, via: 'session' };
  const expected = String(settings.robot_token || '').trim();
  const provided = siteLock.readRobotToken(req);
  if (expected && robotTokensMatch(expected, provided)) return { ok: true, via: 'robot_token' };
  return { ok: false };
}

function robotPublicBase(req, settings) {
  const fromReq = req && req.get ? `${req.protocol}://${req.get('host')}` : '';
  return robotDeviceBridge.resolvePublicBase(settings, fromReq);
}

function resolveRobotCharacterId(settings, bodyCharId) {
  const fromBody = Number(bodyCharId || 0);
  if (fromBody) return fromBody;
  const fromSet = Number(settings.robot_character_id || 0);
  if (fromSet) return fromSet;
  const first = db.prepare('SELECT id FROM characters ORDER BY id ASC LIMIT 1').get();
  return first ? Number(first.id) : 0;
}

function saveRobotImageBuffer(buffer, ext = '.jpg') {
  const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(String(ext).toLowerCase()) ? ext.toLowerCase() : '.jpg';
  const filename = `robot-snap-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${safeExt}`;
  fs.writeFileSync(path.join(UPLOADS_PATH, filename), buffer);
  return filename;
}

const ROBOT_FRAME_ALBUM_DESC = {
  glance: '小机看你',
  env: '小机看环境',
  find: '小机找人',
  snapshot: '小机抓拍',
};

/**
 * 小机拍的每一帧都进相册（source=robot，相册页可单独筛出来）。
 * 不在这里生成标题/心得：那是两次 LLM 调用，会把「看一眼」拖慢好几秒。
 */
function saveRobotFrameToAlbum(characterId, imageUrl, event) {
  try {
    const filename = path.basename(String(imageUrl || '').split('?')[0]);
    if (!filename) return null;
    return saveRobotSnapshotToAlbum({
      characterId,
      filename,
      description: ROBOT_FRAME_ALBUM_DESC[event] || ROBOT_FRAME_ALBUM_DESC.glance,
    });
  } catch (e) {
    console.warn('[robot-vision] album', e.message);
    return null;
  }
}

function isRobotOperatingRow(char) {
  return robotOperatingHelper.isRobotOperatingRow(char);
}

function setRobotOperating(characterId, on, mode) {
  return robotOperatingHelper.setRobotOperating(characterId, on, mode);
}

function applyRobotOperatingFromBody(characterId, body) {
  const intent = robotHelper.parseOperatingIntent(body || {});
  if (intent.end) return robotOperatingHelper.exitRobotOperating(characterId);
  if (intent.start) return robotOperatingHelper.enterRobotScreenMode(characterId);
  return robotOperatingHelper.isRobotOperating(characterId);
}

/**
 * 手机回复里的机器标记落到小机屏幕/舵机队列（不要求正处在「操纵中」）
 * 返回解析出的舵机角度：紧接着的「看一眼」要把它带上，转头和拍照才是一个动作。
 */
function applyPhoneChatToRobot(characterId, char, settings, rawAi, speak, publicBase, userText, cameraIntent) {
  try {
    const r = robotDriveHelper.applyReplyHardwareToRobot(char, settings, rawAi, speak, publicBase, userText, {
      cameraIntent,
    });
    return r?.servo || null;
  } catch (e) {
    console.warn('[chat] robot hardware', e.message);
    return null;
  }
}

function parseRobotImageBase64(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (m) {
    const mime = m[1].toLowerCase();
    const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg';
    return { buffer: Buffer.from(m[2], 'base64'), ext };
  }
  if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length > 64) {
    return { buffer: Buffer.from(s, 'base64'), ext: '.jpg' };
  }
  return null;
}

/** 用户问「看得见我吗」：先开镜头，这轮不让角色先回；图到了再跟一句。没图就一直等，不编「没看成」。 */
const _pendingUserAskLook = new Map();
const USER_ASK_LOOK_WAIT_MS = 90 * 1000;

function hasPendingUserAskLook(characterId) {
  return _pendingUserAskLook.has(Number(characterId));
}

function clearUserAskLookPending(characterId) {
  const id = Number(characterId);
  const pending = _pendingUserAskLook.get(id);
  if (pending?.timer) {
    try { clearTimeout(pending.timer); } catch {}
  }
  _pendingUserAskLook.delete(id);
}

function markUserAskLookPending(characterId) {
  const id = Number(characterId);
  if (!id) return;
  clearUserAskLookPending(id);
  // 只解挂「等图」状态，绝不因此让角色说没看到
  const timer = setTimeout(() => {
    _pendingUserAskLook.delete(id);
    console.log(`[chat] user ask look wait expired char#${id}（没回帧，不让角色说没看成）`);
  }, USER_ASK_LOOK_WAIT_MS);
  _pendingUserAskLook.set(id, { at: Date.now(), timer });
}

async function tryStartUserAskedRobotTool({ char, settings, userText, publicBase }) {
  const hit = robotHelper.resolveRobotIntentFromUserAsk(userText);
  if (!hit?.found || !hit.intent) return null;
  if (!robotDriveHelper.canCharacterUseRobot(char, settings)) return null;
  // 从用户这句话猜出来的意图，一律等角色把这轮话说完再执行。
  // 以前 defer 会整轮不出声，用户只看到消息发出去没人应；顺带修掉
  // 「转个头看我一眼」被 peek 抢走、角色自己的 [舵机] 标记根本没机会跑的问题。
  if (hit.when === 'defer' || hit.when === 'post') {
    console.log(`[chat] user ask tool → ${hit.intent}（等角色这轮话说完再执行）`);
    return { defer: false, invokeAfterReply: hit.intent };
  }
  const result = await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
    intent: hit.intent,
    publicBase,
    source: 'user_ask',
    force: true,
  });
  if (!result?.ok) {
    console.log(`[chat] user ask ${hit.intent} 未生效：${result?.reason || 'unknown'}`);
    return null;
  }
  console.log(`[chat] user ask → ${hit.intent} char#${char.id}（当下执行，角色照常回）`);
  return { defer: false, intent: hit.intent, alreadyInvoked: true };
}

/** 看一眼图到手后：自动带图让角色回话（不插用户气泡、不等用户再回） */
const _cameraLookFollowUp = { busy: false, lastUrl: '', at: 0, timer: null };
/** 只让 vision HTTP 先回包，图已在 uploads，立刻交给角色模型 */
const CAMERA_LOOK_FOLLOWUP_DELAY_MS = 0;
const CAMERA_LOOK_BLOCK_INTENTS = new Set([
  'peek', 'silent', 'find', 'peek_remember', 'follow', 'unfollow',
]);

function scheduleCharacterCameraLookFollowUp(opts = {}) {
  const imageUrl = String(opts.imageUrl || '').trim();
  if (!imageUrl || opts.enrolled) return;
  const now = Date.now();
  if (_cameraLookFollowUp.busy) return;
  if (_cameraLookFollowUp.lastUrl === imageUrl && now - _cameraLookFollowUp.at < 15000) return;
  _cameraLookFollowUp.lastUrl = imageUrl;
  _cameraLookFollowUp.at = now;
  try { clearUserAskLookPending(opts.characterId); } catch {}
  // 图已在 uploads。delay=0 只是让 /mcp/vision/explain 先回包，再立刻带图调角色。
  if (_cameraLookFollowUp.timer) {
    try { clearTimeout(_cameraLookFollowUp.timer); } catch {}
  }
  _cameraLookFollowUp.timer = setTimeout(() => {
    _cameraLookFollowUp.timer = null;
    if (_cameraLookFollowUp.busy) return;
    _cameraLookFollowUp.busy = true;
    Promise.resolve()
      .then(() => runCharacterCameraLookFollowUp(opts))
      .catch((e) => console.warn('[robot-vision] look follow-up', e && e.message ? e.message : e))
      .finally(() => { _cameraLookFollowUp.busy = false; });
  }, CAMERA_LOOK_FOLLOWUP_DELAY_MS);
}

async function runCharacterCameraLookFollowUp(opts = {}) {
  const settings0 = getSettings();
  if (settings0.robot_enabled !== '1') return null;
  const characterId = resolveRobotCharacterId(settings0, opts.characterId);
  if (!characterId) {
    console.warn('[robot-vision] look follow-up: no character');
    return null;
  }
  let char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return null;
  if (!robotDriveHelper.canCharacterUseRobot(char, settings0)) return null;

  let settings = withCharChatPrefs(settings0, char);
  const reqBase = String(opts.publicBase || robotDeviceBridge.resolvePublicBase(settings, '') || '').trim();

  const history = loadRecentChatHistory(characterId, 0, char, settings, 20);

  try { clearUserAskLookPending(characterId); } catch {}

  // 与正常聊天同一套提示词（微信节奏、表情包等），不是桌宠朗读短句模式
  const followText = robotVision.buildCameraLookFollowUpUserText({ event: opts.event || 'glance' });
  const promptOpts = {
    contextText: buildChatContextText(followText, history),
    userMessage: followText,
    recentHistory: history,
    enableInlineDirectives: true,
  };
  try { await prefetchLocationWeather(char, settings, promptOpts); } catch {}
  try {
    await applyBrainUnderstanding(char, settings, promptOpts);
  } catch (e) {
    console.warn('[brain] understanding look follow-up', e.message);
  }
  const systemPrompt = buildSystemPrompt(char, settings, '', promptOpts);
  const visionOpts = {
    event: opts.event || 'glance',
    char,
    settings,
    robotHelper,
    robotDriveHelper,
    publicBase: reqBase,
    uploadsPath: UPLOADS_PATH,
    api: { toAbsoluteMediaUrl },
    getSettings,
    maxAgeMs: 180000,
  };
  const visionPack = robotVision.buildCameraVisionForChat(systemPrompt, visionOpts);
  if (!visionPack) {
    console.warn('[robot-vision] look follow-up skip: no frame（不让角色说没看成）');
    return null;
  }
  // 这一帧已经作为当前消息附在下面了；历史里那条照片气泡只留文字占位，别发两遍
  const apiHistory = buildHistoryApiMessages(history, reqBase, { noRobotFrameImage: true });
  let userContent = visionPack.userParts;
  if (apiHistory.length && apiHistory[apiHistory.length - 1]?.role === 'user') {
    const last = apiHistory.pop();
    const lastText = typeof last.content === 'string'
      ? last.content
      : Array.isArray(last.content)
        ? last.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
        : '';
    const cap = robotVision.buildCameraLookFollowUpUserText({ event: opts.event || 'glance' });
    userContent = [
      { type: 'text', text: `${lastText}\n${cap}`.trim() },
      ...visionPack.userParts.filter((p) => p.type === 'image_url'),
    ];
  }
  const systemForApi = visionPack.systemPrompt;

  let rawAi = '';
  try {
    rawAi = await callChatAPIComplete(settings, systemForApi, userContent, 'chat', apiHistory, await require('./robot-llm-tools').chatExtra(char, settings, { forceRobotTools: true })) || '';
  } catch (e) {
    console.warn('[robot-vision] look follow-up api', e.message);
    return null;
  }
  if (!rawAi) return null;

  let robotInvokeIntent = null;
  let rawAiContent = rawAi;
  const parsedInvoke = robotHelper.parseRobotInvoke(rawAiContent);
  if (parsedInvoke.found) {
    robotInvokeIntent = parsedInvoke.intent;
    rawAiContent = parsedInvoke.textWithout;
  }

  const rawForCall = rawAiContent;
  let aiContent = normalizeAiReplyText(rawAiContent, false, {});
  if (!aiContent && robotInvokeIntent) {
    if (!CAMERA_LOOK_BLOCK_INTENTS.has(String(robotInvokeIntent))) {
      try {
        await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
          intent: robotInvokeIntent,
          publicBase: reqBase,
          source: 'camera_look_tag_only',
        });
      } catch (e) {
        console.warn('[robot-vision] look follow-up will only', e.message);
      }
    } else {
      console.log(`[robot-vision] look follow-up skip re-camera intent=${robotInvokeIntent}`);
    }
    return { characterId, aiMsgId: null, speak: '' };
  }
  if (!aiContent) return null;

  aiContent = polishSpokenAiText(aiContent, char.language_style);

  const peerParsed = contacts.applyPeerRelationFromAiContent(db, characterId, aiContent);
  aiContent = peerParsed.content || aiContent;
  rawAiContent = peerParsed.content || rawAiContent;
  try {
    const taParsed = require('./ta-helper').applyUnbindFromAiContent(characterId, aiContent);
    if (taParsed?.hit) {
      aiContent = taParsed.content;
      rawAiContent = taParsed.content;
    }
  } catch {}
  aiContent = stripAvatarChangeMarker(aiContent);
  rawAiContent = stripAvatarChangeMarker(rawAiContent);
  aiContent = normalizeMediaDirectiveLines(aiContent);
  rawAiContent = normalizeMediaDirectiveLines(rawAiContent);

  const { segments, textContent, recalledMsg, wantPoke, wantCall } = processAiContentWithEmojis(aiContent, char, {
    voiceCallMode: false,
    characterId,
    isDream: false,
  });
  const segmentsClean = stripAlbumMarkersFromSegments(segments);
  const intentClean = stripAlbumMarkersFromText(textContent || aiContent);
  const imageIntent = matchImageIntent(rawAiContent, intentClean);
  const strippedImg = stripImageDirectiveFromSegments(segmentsClean, aiContent);
  let toSave = stripSoundFxFromSegments(stripMusicScoreFromSegments(strippedImg, aiContent), aiContent);
  toSave = prepareVocalReply({ char, segments: toSave, rawText: rawAiContent, skip: true }).segments;
  const deliveryStatus = contacts.isPeerUndeliverable(db, characterId) ? 'peer_undelivered' : 'sent';

  const systemHints = [];
  for (const line of (peerParsed.moodLines || [])) {
    const hid = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
    ).run(characterId, 'assistant', line, 'system', new Date().toISOString(), 0).lastInsertRowid;
    systemHints.push({ id: hid, role: 'assistant', type: 'system', content: line });
  }
  if (wantPoke) {
    try {
      const pokeMsg = insertCharacterPokeMessage(characterId, char, settings, { isDream: false });
      systemHints.push(pokeMsg);
      push('ai_poke', {
        characterId,
        charName: char.name,
        text: pokeMsg.content,
        timestamp: pokeMsg.timestamp,
      });
    } catch (e) {
      console.warn('[poke] look follow-up', e.message);
    }
  }

  const { aiMsgId, aiMessages } = saveAiReplySegments(characterId, toSave, char, false, {
    voiceCallMode: false,
    userRequestedVoice: false,
    deliveryStatus,
    theater: false,
  });
  if (systemHints.length) {
    aiMessages.unshift(...systemHints.filter((h) => h.type === 'system' && /拍了拍/.test(h.content || '')));
  }
  aiContent = toSave.filter((s) => s.type === 'text').map((s) => s.content).join('\n')
    || stripImageDirectiveFromSegments([], textContent || aiContent)[0]?.content
    || '';
  await resolveAndTriggerIncomingCall(char, settings, {
    wantCall,
    rawText: rawForCall,
    processedText: aiContent,
  });

  if (aiMsgId) {
    try {
      mergeMessageMediaMeta(aiMsgId, {
        robot: 1,
        source: 'robot_camera_look',
        robotEvent: opts.event || 'glance',
      });
    } catch {}
  }

  if (aiContent) {
    try { touchCharacterEmotionFromMessage(characterId, { role: 'assistant', content: aiContent }); } catch {}
  }
  if (recalledMsg) {
    push('message_update', { characterId, id: recalledMsg.id, recalled: true, recalledContent: recalledMsg.content });
  }

  try {
    const imgs = await attachReplyImages({
      characterId,
      char,
      settings,
      rawText: rawAiContent,
      cleanText: aiContent,
      reqBase,
      isDreamMode: false,
      imageQuery: imageIntent.presetQuery,
      videoQuery: imageIntent.videoQuery,
      userImageRequest: false,
      userVideoRequest: false,
      userMessage: '',
    });
    appendImageMessages(aiMessages, imgs);
  } catch (e) {
    console.warn('[robot-vision] look follow-up images', e.message);
  }

  try {
    const scoreMsg = await attachMusicScoreMessage({
      characterId,
      rawText: rawAiContent,
      cleanText: aiContent,
      char,
      uploadsPath: UPLOADS_PATH,
      isDreamMode: false,
      deliveryStatus,
      settings,
    });
    if (scoreMsg) aiMessages.push(scoreMsg);
    try {
      const sfxMsgs = await attachSoundFxMessages({
        characterId,
        rawText: rawAiContent,
        cleanText: aiContent,
        settings,
        uploadsPath: UPLOADS_PATH,
        isDreamMode: false,
        deliveryStatus,
      });
      if (sfxMsgs?.length) aiMessages.push(...sfxMsgs);
    } catch (e) {
      console.warn('[sfx]', e.message);
    }
  } catch {}

  markUserMessagesReadByPeer(characterId, 0);
  if (aiMsgId) maybeTriggerMemorySummary(characterId, { assistantMsgId: aiMsgId });

  if (robotInvokeIntent) {
    if (CAMERA_LOOK_BLOCK_INTENTS.has(String(robotInvokeIntent))) {
      console.log(`[robot-vision] look follow-up skip re-camera intent=${robotInvokeIntent}`);
    } else {
      try {
        await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
          intent: robotInvokeIntent,
          publicBase: reqBase,
          source: 'camera_look',
        });
      } catch (e) {
        console.warn('[robot-vision] look follow-up will', e.message);
      }
    }
  }

  // 不在刚拍完时再往机身塞说话/舵机，避免和摄像头抢资源；聊天气泡照常发
  try {
    if (aiMessages.length) {
      broadcastChatMessage(characterId, aiContent, aiMessages, false);
    }
  } catch {}

  console.log(`[robot-vision] look follow-up ok char#${characterId} msg#${aiMsgId || '-'}`);
  return { characterId, aiMsgId, speak: aiContent };
}

/** 小机麦克风：隐藏音频入库后，带多模态音频让角色回话，并尽量经小机喇叭播出。 */
async function runCharacterMicListenFollowUp(opts = {}) {
  const settings0 = getSettings();
  if (settings0.robot_enabled !== '1') return null;
  const characterId = resolveRobotCharacterId(settings0, opts.characterId);
  if (!characterId) {
    console.warn('[robot-mic] follow-up: no character');
    return null;
  }
  let char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return null;
  if (!robotDriveHelper.canCharacterUseRobot(char, settings0)) return null;

  let settings = withCharChatPrefs(settings0, char);
  const reqBase = String(opts.publicBase || robotDeviceBridge.resolvePublicBase(settings, '') || '').trim();
  const voiceUrl = String(opts.voiceUrl || opts.url || '').trim();
  if (!voiceUrl) {
    console.warn('[robot-mic] follow-up skip: no voice url');
    return null;
  }

  const history = loadRecentChatHistory(characterId, 0, char, settings, 20);

  const vp = opts.voiceprint && typeof opts.voiceprint === 'object' ? opts.voiceprint : {};
  const vpNote = voiceprintHelper.voiceprintPromptNote(vp.result, { robot: true, score: vp.score });
  const vpEnrolled = !!voiceprintHelper.loadStoredVoiceprint(getSettings)?.embedding?.length;
  const followText = [robotMic.buildMicFollowUpUserText(), vpNote].filter(Boolean).join('\n');
  const extraSystemPrompt = [
    vpEnrolled ? voiceprintHelper.voiceprintStandingNote({ robot: true }) : '',
    vpNote,
  ].filter(Boolean).join('\n');
  const promptOpts = {
    contextText: buildChatContextText(followText, history),
    userMessage: followText,
    recentHistory: history,
    enableInlineDirectives: true,
  };
  try { await prefetchLocationWeather(char, settings, promptOpts); } catch {}
  try {
    await applyBrainUnderstanding(char, settings, promptOpts);
  } catch (e) {
    console.warn('[brain] understanding mic follow-up', e.message);
  }
  const systemPrompt = buildSystemPrompt(char, settings, extraSystemPrompt, promptOpts);
  const hearingNote = robotMic.buildMicHearingNote();
  const systemForApi = systemPrompt ? `${systemPrompt}\n\n${hearingNote}` : hearingNote;
  const model = resolveChatApiSettings(settings, false).model;
  const audioPart = resolveChatAudioPart(voiceUrl, { model });
  if (!audioPart) {
    console.warn('[robot-mic] follow-up skip: audio part missing（不让角色说没听到）');
    return null;
  }
  // 当前这条会作为 userContent 附真音频；历史里那条隐藏语音只留文字占位，别发两遍
  const apiHistory = buildHistoryApiMessages(history, reqBase, {
    noRobotMicAudio: true,
    resolveAudioPart: (u) => resolveChatAudioPart(u, { model }),
  });
  let userContent = [
    { type: 'text', text: followText },
    audioPart,
  ];
  const lastHist = history[history.length - 1];
  if (robotMic.isRobotMicMessage(lastHist)
      && apiHistory.length
      && apiHistory[apiHistory.length - 1]?.role === 'user') {
    apiHistory.pop();
  }

  let rawAi = '';
  try {
    rawAi = await callChatAPIComplete(settings, systemForApi, userContent, 'chat', apiHistory, await require('./robot-llm-tools').chatExtra(char, settings, { forceRobotTools: true })) || '';
  } catch (e) {
    console.warn('[robot-mic] follow-up api', e.message);
    return null;
  }
  if (!rawAi) return null;

  let robotInvokeIntent = null;
  let rawAiContent = rawAi;
  const parsedInvoke = robotHelper.parseRobotInvoke(rawAiContent);
  if (parsedInvoke.found) {
    robotInvokeIntent = parsedInvoke.intent;
    rawAiContent = parsedInvoke.textWithout;
  }

  const rawForCall = rawAiContent;
  let aiContent = normalizeAiReplyText(rawAiContent, false, {});
  if (!aiContent && robotInvokeIntent) {
    try {
      await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
        intent: robotInvokeIntent,
        publicBase: reqBase,
        source: 'robot_mic_tag_only',
      });
    } catch (e) {
      console.warn('[robot-mic] follow-up will only', e.message);
    }
    return { characterId, aiMsgId: null, speak: '' };
  }
  if (!aiContent) return null;

  aiContent = polishSpokenAiText(aiContent, char.language_style);

  const peerParsed = contacts.applyPeerRelationFromAiContent(db, characterId, aiContent);
  aiContent = peerParsed.content || aiContent;
  rawAiContent = peerParsed.content || rawAiContent;
  try {
    const taParsed = require('./ta-helper').applyUnbindFromAiContent(characterId, aiContent);
    if (taParsed?.hit) {
      aiContent = taParsed.content;
      rawAiContent = taParsed.content;
    }
  } catch {}
  aiContent = stripAvatarChangeMarker(aiContent);
  rawAiContent = stripAvatarChangeMarker(rawAiContent);
  aiContent = normalizeMediaDirectiveLines(aiContent);
  rawAiContent = normalizeMediaDirectiveLines(rawAiContent);

  const { segments, textContent, recalledMsg, wantPoke, wantCall } = processAiContentWithEmojis(aiContent, char, {
    voiceCallMode: false,
    characterId,
    isDream: false,
  });
  const segmentsClean = stripAlbumMarkersFromSegments(segments);
  const intentClean = stripAlbumMarkersFromText(textContent || aiContent);
  const imageIntent = matchImageIntent(rawAiContent, intentClean);
  const strippedImg = stripImageDirectiveFromSegments(segmentsClean, aiContent);
  let toSave = stripSoundFxFromSegments(stripMusicScoreFromSegments(strippedImg, aiContent), aiContent);
  toSave = prepareVocalReply({ char, segments: toSave, rawText: rawAiContent, skip: true }).segments;
  const deliveryStatus = contacts.isPeerUndeliverable(db, characterId) ? 'peer_undelivered' : 'sent';

  const systemHints = [];
  for (const line of (peerParsed.moodLines || [])) {
    const hid = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
    ).run(characterId, 'assistant', line, 'system', new Date().toISOString(), 0).lastInsertRowid;
    systemHints.push({ id: hid, role: 'assistant', type: 'system', content: line });
  }
  if (wantPoke) {
    try {
      const pokeMsg = insertCharacterPokeMessage(characterId, char, settings, { isDream: false });
      systemHints.push(pokeMsg);
      push('ai_poke', {
        characterId,
        charName: char.name,
        text: pokeMsg.content,
        timestamp: pokeMsg.timestamp,
      });
    } catch (e) {
      console.warn('[poke] mic follow-up', e.message);
    }
  }

  const { aiMsgId, aiMessages } = saveAiReplySegments(characterId, toSave, char, false, {
    voiceCallMode: false,
    userRequestedVoice: false,
    deliveryStatus,
    theater: false,
  });
  if (systemHints.length) {
    aiMessages.unshift(...systemHints.filter((h) => h.type === 'system' && /拍了拍/.test(h.content || '')));
  }
  aiContent = toSave.filter((s) => s.type === 'text').map((s) => s.content).join('\n')
    || stripImageDirectiveFromSegments([], textContent || aiContent)[0]?.content
    || '';
  await resolveAndTriggerIncomingCall(char, settings, {
    wantCall,
    rawText: rawForCall,
    processedText: aiContent,
  });

  if (aiMsgId) {
    try {
      mergeMessageMediaMeta(aiMsgId, {
        robot: 1,
        source: 'robot_mic_listen',
        robotEvent: 'utterance_reply',
      });
    } catch {}
  }

  if (aiContent) {
    try { touchCharacterEmotionFromMessage(characterId, { role: 'assistant', content: aiContent }); } catch {}
  }
  if (recalledMsg) {
    push('message_update', { characterId, id: recalledMsg.id, recalled: true, recalledContent: recalledMsg.content });
  }

  try {
    const imgs = await attachReplyImages({
      characterId,
      char,
      settings,
      rawText: rawAiContent,
      cleanText: aiContent,
      reqBase,
      isDreamMode: false,
      imageQuery: imageIntent.presetQuery,
      videoQuery: imageIntent.videoQuery,
      userImageRequest: false,
      userVideoRequest: false,
      userMessage: '',
    });
    appendImageMessages(aiMessages, imgs);
  } catch (e) {
    console.warn('[robot-mic] follow-up images', e.message);
  }

  try {
    const scoreMsg = await attachMusicScoreMessage({
      characterId,
      rawText: rawAiContent,
      cleanText: aiContent,
      char,
      uploadsPath: UPLOADS_PATH,
      isDreamMode: false,
      deliveryStatus,
      settings,
    });
    if (scoreMsg) aiMessages.push(scoreMsg);
    try {
      const sfxMsgs = await attachSoundFxMessages({
        characterId,
        rawText: rawAiContent,
        cleanText: aiContent,
        settings,
        uploadsPath: UPLOADS_PATH,
        isDreamMode: false,
        deliveryStatus,
      });
      if (sfxMsgs?.length) aiMessages.push(...sfxMsgs);
    } catch (e) {
      console.warn('[sfx]', e.message);
    }
  } catch {}

  markUserMessagesReadByPeer(characterId, 0);
  if (aiMsgId) maybeTriggerMemorySummary(characterId, { assistantMsgId: aiMsgId });

  if (robotInvokeIntent) {
    try {
      await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
        intent: robotInvokeIntent,
        publicBase: reqBase,
        source: 'robot_mic',
      });
    } catch (e) {
      console.warn('[robot-mic] follow-up will', e.message);
    }
  }

  // 经小机喇叭回话（TTS + speak 指令）
  try {
    if (aiContent) {
      const screen = robotHelper.resolveScreenPolicy(settings);
      if (screen.playTts && char.voice_id) {
        const { callTTS: ttsFn } = require('./api-helper');
        const buffer = await ttsFn(settings, aiContent.slice(0, 500), String(char.voice_id).trim(), {
          forSpeaker: true,
        });
        const filename = `robot_say_${Date.now()}.mp3`;
        const fp = path.join(UPLOADS_PATH, filename);
        if (buffer?.length) {
          fs.writeFileSync(fp, buffer);
          const audioUrl = toAbsoluteMediaUrl(`/uploads/${filename}`, reqBase);
          robotCommands.enqueueCommand(characterId, 'speak', {
            text: aiContent,
            audioUrl,
            audioPath: `/uploads/${filename}`,
            mime: 'audio/mpeg',
            muted: false,
          });
        }
      } else if (aiContent) {
        robotCommands.enqueueCommand(characterId, 'speak', {
          text: aiContent,
          audioUrl: '',
          muted: !screen.playTts,
        });
      }
      try {
        robotDriveHelper.applyReplyHardwareToRobot(char, settings, rawAiContent, aiContent, reqBase, '');
      } catch {}
    }
  } catch (e) {
    console.warn('[robot-mic] follow-up speak', e.message);
  }

  try {
    if (aiMessages.length) {
      broadcastChatMessage(characterId, aiContent, aiMessages, false);
    }
  } catch {}

  console.log(`[robot-mic] follow-up ok char#${characterId} msg#${aiMsgId || '-'}`);
  return { characterId, aiMsgId, speak: aiContent };
}

async function handleRobotVisionRequest({ question, buffer, ext, imageUrl, req, cameraEvent, characterId }) {
  let buf = buffer;
  let fileExt = ext || '.jpg';
  if (!buf && imageUrl) {
    const decoded = robotVision.decodeDataImage(imageUrl) || parseRobotImageBase64(imageUrl);
    if (decoded?.buffer?.length) {
      buf = decoded.buffer;
      fileExt = decoded.ext || fileExt;
    }
  }
  const reqBase = req ? `${req.protocol}://${req.get('host')}` : '';
  const ingested = await robotVision.ingestRobotCameraFrame({
    buffer: buf,
    ext: fileExt,
    question: question || '',
    getSettings,
    setSetting,
    saveImageBuffer: saveRobotImageBuffer,
    publicBase: reqBase,
    uploadsPath: UPLOADS_PATH,
    robotHelper,
    api: { callChatAPIComplete, toAbsoluteMediaUrl },
  });
  if (!ingested?.success) return ingested;

  // 图已落地：把这一帧本身发进聊天页（照片气泡），并存进角色相册。
  // 到这里就一定是真照片——找人追踪帧在上游已经 return，不会走到这。
  const cid = Number(characterId || resolveRobotCharacterId(getSettings(), 0) || 0);
  let flushed = [];
  try {
    if (cid) {
      flushed = robotDriveHelper.flushRobotCameraEvents(cid, {
        question: question || '',
        imageUrl: ingested.imageUrl || '',
        force: true,
      }) || [];
    }
  } catch (e) {
    console.warn('[robot-vision] flush camera event', e.message);
  }
  if (cid && ingested.imageUrl) {
    saveRobotFrameToAlbum(cid, ingested.imageUrl, flushed[0]?.event || cameraEvent || 'glance');
  }
  const event = flushed[0]?.event || cameraEvent || 'glance';

  // 只有角色真正挂起了「看一眼」才跟一句反应；转头/追踪误拍不跟
  if (flushed.length && !ingested.deferSpeak && !ingested.enrolled && ingested.imageUrl) {
    try {
      scheduleCharacterCameraLookFollowUp({
        imageUrl: ingested.imageUrl,
        characterId: flushed[0]?.characterId || characterId,
        event,
        publicBase: reqBase,
        facePresent: ingested.facePresent,
        faceIdentity: ingested.faceIdentity,
        userEmotion: ingested.userEmotion,
        enrolled: ingested.enrolled,
      });
    } catch (e) {
      console.warn('[robot-vision] schedule look follow-up', e.message);
    }
    return ingested;
  }

  if (!ingested.deferSpeak) return ingested;

  const settings = getSettings();
  const token = String(settings.robot_token || '').trim();
  const lookText = ingested.lookText || robotVision.characterLookText(question);
  try {
    const port = Number(process.env.PORT) || 3000;
    const resp = await fetch(`http://127.0.0.1:${port}/api/robot/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nian-Robot-Token': token,
      },
      body: JSON.stringify({
        text: lookText,
        attachCamera: true,
        withTts: false,
        facePresent: ingested.facePresent !== false,
        faceIdentity: ingested.faceIdentity,
        userEmotion: ingested.userEmotion || undefined,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    const speak = String(data.speak || data.reply || '').trim();
    if (speak) ingested.response = speak;
  } catch (e) {
    console.warn('[robot-vision] character reply', e.message);
  }
  if (!ingested.response) ingested.response = '好。';
  return ingested;
}

/** 小机 MCP 视觉：机身摄像头直接把图 POST 到这里 */
app.get('/mcp/vision/explain', (req, res) => {
  const settings = getSettings();
  const on = settings.robot_enabled === '1';
  const emotionOn = settings.robot_emotion_sense_enabled === '1';
  const faceOn = settings.robot_faceprint_enabled === '1';
  const enrolled = faceprintHelper.publicFaceprintStatus(faceprintHelper.loadStoredFaceprint(() => settings)).enrolled;
  const bits = [
    on ? '桌宠已启用' : '桌宠未启用',
    emotionOn ? '情绪识别开' : '情绪识别关',
    faceOn ? (enrolled ? '认人开（已有参考正脸）' : '认人开（尚未录入）') : '认人关',
  ];
  res.type('text/plain').send(`MCP Vision 接通念（小机自己的摄像头）。${bits.join('；')}。`);
});

app.post('/mcp/vision/explain', upload.any(), async (req, res) => {
  const settings = getSettings();
  if (settings.robot_enabled !== '1') {
    return res.status(403).json({ success: false, message: '桌宠未启用' });
  }
  const question = String(req.body?.question || req.body?.text || '').trim();
  const file = (req.files || []).find((f) => String(f.mimetype || '').startsWith('image/'))
    || (req.files || [])[0];
  let buffer = file?.buffer;
  let ext = '.jpg';
  if (file?.path && fs.existsSync(file.path)) {
    buffer = fs.readFileSync(file.path);
    ext = path.extname(file.filename || file.originalname || '') || '.jpg';
  }
  if (!buffer && (req.body?.image || req.body?.imageBase64)) {
    const parsed = parseRobotImageBase64(req.body.image || req.body.imageBase64);
    buffer = parsed?.buffer;
    ext = parsed?.ext || ext;
  }
  if (!buffer?.length) {
    return res.status(400).json({ success: false, message: '缺少图片' });
  }
  // 找人追踪：轻量 bbox → 舵机目标，不调 LLM、不占情绪识图
  if (robotFaceTrack.isFaceTrackQuestion(question)) {
    try {
      const result = await robotFaceTrack.processFaceTrackFrame({
        buffer,
        getSettings,
        robotHelper,
        faceprintHelper,
        question,
        force: robotFaceTrack.isFaceTrackForceQuestion(question)
          || robotFaceTrack.isFaceSearchQuestion(question),
      });
      return res.json({
        success: !!result?.success,
        action: result?.action || 'RESPONSE',
        response: String(result?.response || 'ok').trim() || 'ok',
        faceTrack: result?.target || robotFaceTrack.getTarget(),
      });
    } catch (e) {
      console.warn('[mcp/vision] face-track', e.message);
      return res.status(500).json({ success: false, message: e.message || '找人失败' });
    }
  }
  // 扫视对准后认人：同步比对，不进聊天
  if (robotFaceTrack.isFaceVerifyQuestion(question)) {
    try {
      const result = await robotVision.verifyRobotCameraFrame({
        buffer,
        ext,
        getSettings,
        setSetting,
        saveImageBuffer: saveRobotImageBuffer,
        publicBase: `${req.protocol}://${req.get('host')}`,
        uploadsPath: UPLOADS_PATH,
        robotHelper,
        api: { callChatAPIComplete, toAbsoluteMediaUrl },
      });
      return res.json({
        success: !!result?.success,
        action: result?.action || 'RESPONSE',
        response: String(result?.response || 'ok').trim() || 'ok',
        faceIdentity: result?.faceIdentity || 'none',
        facePresent: result?.facePresent !== false,
        faceIdentityScore: result?.faceIdentityScore || 0,
      });
    } catch (e) {
      console.warn('[mcp/vision] face-verify', e.message);
      return res.status(500).json({ success: false, message: e.message || '认人失败' });
    }
  }
  // 找人追踪帧不进聊天页；真照片在 handleRobotVisionRequest 里落地后发照片气泡。
  try {
    const result = await handleRobotVisionRequest({
      question,
      buffer,
      ext,
      req,
    });
    res.json({
      success: !!result?.success,
      action: result?.action || 'RESPONSE',
      response: String(result?.response || '好。').trim(),
      message: result?.success ? undefined : (result?.response || '处理失败'),
    });
  } catch (e) {
    console.warn('[mcp/vision]', e.message);
    res.status(500).json({ success: false, message: e.message || '视觉处理失败' });
  }
});

/** 小机开麦：聊天页旁白「用户正对小机讲话」，角色可见但不回复 */
app.get('/mcp/audio/listening', (req, res) => {
  res.type('text/plain').send('MCP Audio listening（点屏开麦提示）。POST 开始旁白。');
});

app.post('/mcp/audio/listening', async (req, res) => {
  const settings = getSettings();
  if (settings.robot_enabled !== '1') {
    return res.status(403).json({ ok: false, error: '桌宠未启用' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) {
    return res.status(400).json({ ok: false, error: '未绑定角色' });
  }
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ ok: false, error: '角色不存在' });
  try {
    const msgId = robotMic.recordRobotMicListening(char, {
      caption: req.body?.caption,
    });
    res.json({ ok: true, messageId: msgId, characterId });
  } catch (e) {
    console.warn('[mcp/audio/listening]', e.message);
    res.status(500).json({ ok: false, error: e.message || '开麦提示失败' });
  }
});

/** 小机收音结束（没说话 / 超时 / 出错）：去掉聊天页「讲话中」动效 */
app.get('/mcp/audio/listen-end', (req, res) => {
  res.type('text/plain').send('MCP Audio listen-end（点屏收音结束）。POST 去掉讲话中旁白。');
});

app.post('/mcp/audio/listen-end', async (req, res) => {
  const settings = getSettings();
  if (settings.robot_enabled !== '1') {
    return res.status(403).json({ ok: false, error: '桌宠未启用' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) {
    return res.status(400).json({ ok: false, error: '未绑定角色' });
  }
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ ok: false, error: '角色不存在' });
  try {
    const uploaded = !!(req.body?.uploaded);
    const reason = String(req.body?.reason || (uploaded ? 'uploaded' : 'ended'));
    const n = robotMic.finishRobotMicListening(char, { reason });
    res.json({ ok: true, finished: n, characterId });
  } catch (e) {
    console.warn('[mcp/audio/listen-end]', e.message);
    res.status(500).json({ ok: false, error: e.message || '结束聆听失败' });
  }
});

/** 小机静音收尾：上传 WAV → 隐藏 robotMic 消息 → 多模态跟进 */
app.get('/mcp/audio/utterance', (req, res) => {
  res.type('text/plain').send('MCP Audio utterance（小机麦克风上行）。POST multipart file=wav。');
});

app.post('/mcp/audio/utterance', upload.single('file'), async (req, res) => {
  const settings = getSettings();
  if (settings.robot_enabled !== '1') {
    return res.status(403).json({ ok: false, error: '桌宠未启用' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) {
    return res.status(400).json({ ok: false, error: '未绑定角色' });
  }
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ ok: false, error: '角色不存在' });

  let localPath = req.file?.path;
  if (!localPath && req.body?.audioBase64) {
    try {
      const raw = String(req.body.audioBase64).replace(/^data:audio\/\w+;base64,/, '');
      const buf = Buffer.from(raw, 'base64');
      if (buf.length) {
        const tmp = path.join(UPLOADS_PATH, `robot-mic-${Date.now()}.wav`);
        fs.writeFileSync(tmp, buf);
        localPath = tmp;
      }
    } catch (e) {
      console.warn('[mcp/audio/utterance] base64', e.message);
    }
  }
  if (!localPath || !fs.existsSync(localPath)) {
    return res.status(400).json({ ok: false, error: '缺少音频文件' });
  }

  try {
    const filename = await convertVoiceUploadForChat(localPath, req.file?.originalname || 'robot-mic.wav');
    const savedPath = path.join(UPLOADS_PATH, filename);
    const url = `/uploads/${filename}`;
    const duration = Math.max(
      1,
      Math.min(60, Math.round(Number(req.body?.duration) || Number(req.body?.duration_ms || 0) / 1000 || 1))
    );
    let voiceprint = { result: 'none', score: 0 };
    try {
      voiceprint = await voiceprintHelper.verifyFileAgainstStored(savedPath, getSettings, setSetting);
    } catch (vpErr) {
      console.warn('[mcp/audio/utterance] voiceprint:', vpErr.message);
    }
    const msgId = robotMic.recordRobotMicUtterance(char, { url, duration, voiceprint });
    const reqBase = `${req.protocol}://${req.get('host')}`;
    robotMic.scheduleCharacterMicListenFollowUp({
      voiceUrl: url,
      url,
      duration,
      characterId,
      publicBase: reqBase,
      voiceprint,
      runFollowUp: runCharacterMicListenFollowUp,
    });
    res.json({ ok: true, url, duration, messageId: msgId, characterId, voiceprint });
  } catch (e) {
    console.warn('[mcp/audio/utterance]', e.message);
    res.status(500).json({ ok: false, error: e.message || '音频处理失败' });
  }
});

/** 调试 / 手机触发：让 MCP 网关开麦聆听（点屏同链路，不经固件点屏） */
app.post('/api/robot/listen/start', async (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '未授权' });
  if (settings.robot_enabled !== '1') {
    return res.status(403).json({ error: '桌宠未启用' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  const char = characterId ? db.prepare('SELECT * FROM characters WHERE id=?').get(characterId) : null;
  if (!char) return res.status(400).json({ error: '未绑定角色' });

  // 点屏同设计：开麦瞬间聊天页就出现「用户正对小机讲话」（网关稍后 POST 会复用同一条）
  try {
    robotMic.recordRobotMicListening(char);
  } catch (e) {
    console.warn('[robot/listen/start] aside', e.message);
  }

  try {
    const st = await robotMcpBridge.mcpFetch(settings, '/tools/status');
    const online = !!(st && (st.connected || st.device_connected));
    if (!online) {
      try { robotMic.finishRobotMicListening(char, { reason: 'offline' }); } catch {}
      return res.json({
        ok: false,
        queued: false,
        hint: '小机没连上网关，麦没打开。确认猫脸在、WebSocket 已连上。',
      });
    }
  } catch (e) {
    try { robotMic.finishRobotMicListening(char, { reason: 'gateway' }); } catch {}
    return res.json({
      ok: false,
      queued: false,
      hint: `网关 /tools 连不上（${e.message || e}）。麦没打开。`,
    });
  }

  try {
    robotCommands.enqueueCommand(characterId, 'listen', {
      silence_ms: Math.max(500, Math.min(10000, Number(req.body?.silence_ms) || 3000)),
      max_duration_ms: Math.max(3000, Math.min(30000, Number(req.body?.max_duration_ms) || 30000)),
      source: 'api',
    });
    res.json({ ok: true, queued: true, characterId });
  } catch (e) {
    try { robotMic.finishRobotMicListening(char, { reason: 'enqueue_failed' }); } catch {}
    console.warn('[robot/listen/start]', e.message);
    res.status(500).json({ error: e.message || '开麦失败' });
  }
});

/** 插件拉取找人舵机目标（不调 LLM） */
app.get('/api/robot/face-track/target', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  robotFaceTrack.setEnabled(
    settings.robot_enabled === '1' && settings.robot_face_track_enabled !== '0'
  );
  const t = robotFaceTrack.getTarget();
  const mapped = robotHelper.toDeviceAngles({ yaw: t.yaw, pitch: t.pitch }, settings);
  res.json({
    ...t,
    yaw: mapped ? mapped.yaw : t.yaw,
    pitch: mapped ? mapped.pitch : t.pitch,
    logicalYaw: t.yaw,
    logicalPitch: t.pitch,
  });
});

/** 桌宠页：测机身摄像头（排队 glance，真机开摄 → vision） */
app.post('/api/robot/test/camera', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  if (settings.robot_enabled !== '1') {
    return res.status(400).json({ error: '请先开启桌宠' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: '请先选择角色' });
  const char = db.prepare('SELECT id, name FROM characters WHERE id=?').get(characterId);
  if (char) {
    try { robotDriveHelper.armRobotCameraEvent(char, { event: 'glance', intent: 'test_camera' }); } catch {}
  }
  const connect = robotDriveHelper.buildConnectReport(settings);
  const before = robotHelper.getLastSense();
  const row = robotCommands.enqueueCommand(characterId, 'glance', {
    reason: 'test_camera',
    context: String(req.body?.context || '').trim() || '摄像头测试',
    test: 'camera',
  });
  res.json({
    ok: true,
    commandId: row?.id || null,
    deviceOnline: !!connect.online,
    lastSense: before,
    hint: connect.online
      ? '已排队：小机取指令后会开摄像头拍一眼'
      : '指令已排队，但小机当前不在线，连上后才会执行',
  });
});

/** 逻辑角 → 机身角（插件扫视找人用） */
app.post('/api/robot/map-head', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  const yaw = Number(req.body?.yaw);
  const pitch = Number(req.body?.pitch);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
    return res.status(400).json({ error: '需要 yaw 和 pitch' });
  }
  const mapped = robotHelper.toDeviceAngles({ yaw, pitch }, settings);
  if (!mapped) return res.status(400).json({ error: '角度无效' });
  res.json({
    yaw: mapped.yaw,
    pitch: mapped.pitch,
    logicalYaw: mapped.logicalYaw ?? yaw,
    logicalPitch: mapped.logicalPitch ?? pitch,
  });
});

/** 桌宠页：测人脸追踪（强制找人一帧，开关关着也能测） */
app.post('/api/robot/test/face-track', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  if (settings.robot_enabled !== '1') {
    return res.status(400).json({ error: '请先开启桌宠' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: '请先选择角色' });
  const connect = robotDriveHelper.buildConnectReport(settings);
  const before = robotFaceTrack.getTarget();
  const row = robotCommands.enqueueCommand(characterId, 'glance', {
    reason: 'test_face_track',
    faceTrackOnly: true,
    forceFaceTrack: true,
    test: 'face_track',
    context: robotFaceTrack.FACE_TRACK_FORCE_QUESTION,
  });
  res.json({
    ok: true,
    commandId: row?.id || null,
    deviceOnline: !!connect.online,
    faceTrackEnabled: settings.robot_face_track_enabled !== '0',
    target: before,
    hint: connect.online
      ? '已排队：小机会拍一帧找人并对准转头'
      : '指令已排队，但小机当前不在线，连上后才会执行',
  });
});

/** 桌宠页：直接转头。body.device=true 时 yaw/pitch 是机身原始角，用来找平视。 */
app.post('/api/robot/test/head', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  if (settings.robot_enabled !== '1') {
    return res.status(400).json({ error: '请先开启桌宠' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: '请先选择角色' });
  const yaw = Math.round(Number(req.body?.yaw));
  const pitch = Math.round(Number(req.body?.pitch));
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
    return res.status(400).json({ error: '需要 yaw 和 pitch' });
  }
  const device = req.body?.device !== false && req.body?.device !== 0 && req.body?.device !== '0';
  const payload = device
    ? { yaw, pitch, device: true }
    : { yaw, pitch };
  const mapped = robotHelper.toDeviceAngles(payload, settings);
  const logical = device
    ? robotHelper.fromDeviceAngles(yaw, pitch, settings)
    : robotHelper.normalizeServoAngles(payload);
  try { robotFaceTrack.noteExplicitServo(logical.yaw, logical.pitch); } catch {}
  try {
    robotScreen.setScreen(characterId, {
      servo: payload,
      motion: 'angles',
      source: 'test',
    }, robotPublicBase(req, settings));
  } catch {}
  const row = robotCommands.enqueueServo(characterId, payload);
  const connect = robotDriveHelper.buildConnectReport(settings);
  res.json({
    ok: true,
    commandId: row?.id || null,
    deviceOnline: !!connect.online,
    sent: mapped,
    logical,
    pitchCenter: robotHelper.resolvePitchCenter(settings),
    hint: connect.online ? '已让小机转到这个角' : '指令已排队，小机离线',
  });
});

// ===== 桌宠 / Stack-chan =====
app.get('/api/robot/status', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  const characterId = resolveRobotCharacterId(settings, req.query?.characterId);
  const char = characterId
    ? db.prepare('SELECT id, name, avatar, voice_id, robot_emotions, robot_operating, mood, inner_drive_state FROM characters WHERE id=?').get(characterId)
    : null;
  const behavior = robotHelper.buildBehaviorProfile(settings);
  const screen = robotHelper.resolveScreenPolicy(settings);
  const face = robotHelper.buildFacePayload(settings, char?.robot_emotions);
  const drive = char ? robotDriveHelper.getInnerDrive(char) : null;
  const pendingCommands = characterId ? robotCommands.getPendingCommands(characterId, 30) : [];
  const connect = robotDriveHelper.buildConnectReport(settings);
  res.json({
    ok: true,
    enabled: settings.robot_enabled === '1',
    characterId: char ? char.id : null,
    characterName: char?.name || null,
    hasVoice: !!(char?.voice_id || '').trim(),
    tts: screen.playTts,
    muted: screen.muted,
    showChatOnScreen: screen.showChatOnScreen,
    syncChat: screen.syncChat,
    operating: isRobotOperatingRow(char),
    deviceName: settings.robot_device_name || 'Stack-chan',
    emotions: robotHelper.listEmotionOptions(),
    customEmotionAssets: face.customEmotionAssets,
    motions: robotHelper.listMotionOptions(),
    behavior,
    endpoint: '/api/robot/chat',
    behaviorEndpoint: '/api/robot/behavior',
    senseEndpoint: '/api/robot/sense',
    snapshotEndpoint: '/api/robot/snapshot',
    operatingEndpoint: '/api/robot/operating',
    commandsEndpoint: '/api/robot/commands',
    screenEndpoint: '/api/robot/screen',
    heartbeatEndpoint: '/api/robot/heartbeat',
    lastSense: robotHelper.getLastSense(),
    lastHeadTouch: robotHelper.getLastHeadTouch(),
    faceprint: faceprintHelper.publicFaceprintStatus(faceprintHelper.loadStoredFaceprint(() => settings)),
    deviceOnline: connect.online,
    deviceLastSeen: connect.lastSeen,
    connect,
    connectSameWifi: false,
    connectHint: '小机应连 stackchan-mcp 网关（wss://你的域名/stackchan/）；念通过 MCP /tools 下行，无需唤醒。',
    controlMode: 'mcp',
    mcpBaseUrl: String(settings.robot_mcp_base_url || 'http://127.0.0.1:8766'),
    driveHint: char ? robotDriveHelper.publicDriveHint(drive) : '',
    characterMood: char?.mood || '',
    pendingCommands: pendingCommands.length,
  });
});

/** 拉取行为层配置（在场感/表情衰减/人脸追踪）——不调 LLM、不费 token */
app.get('/api/robot/behavior', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  const characterId = resolveRobotCharacterId(settings, req.query?.characterId);
  const char = characterId
    ? db.prepare('SELECT robot_emotions FROM characters WHERE id=?').get(characterId)
    : null;
  const face = robotHelper.buildFacePayload(settings, char?.robot_emotions);
  res.json({
    ok: true,
    behavior: robotHelper.buildBehaviorProfile(settings),
    lastSense: robotHelper.getLastSense(),
    faceprint: faceprintHelper.publicFaceprintStatus(faceprintHelper.loadStoredFaceprint(() => settings)),
  });
});

/** 小机头顶触摸：碰的是机器人硬件，角色无体感；只让小机自己变个脸，不改角色情绪 */
const _headTouchReplyAt = new Map();
app.post('/api/robot/touch', async (req, res) => {
  const settings0 = getSettings();
  const access = assertRobotAccess(req, settings0);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  if (access.via === 'robot_token') {
    try { robotDriveHelper.recordDeviceHeartbeat(); } catch {}
  }
  const gesture = String(req.body?.gesture || req.body?.event || 'tap').trim().toLowerCase();
  const recorded = robotHelper.recordHeadTouch({ gesture });
  const characterId = resolveRobotCharacterId(settings0, req.body?.characterId);
  try {
    push('robot_head_touch', {
      characterId: characterId || null,
      gesture: recorded.gesture,
    });
  } catch {}

  // 小机本地反应：按角色当前心情 + 人设倾向变脸/动作，不写角色情绪数值
  if (characterId && String(settings0.robot_enabled || '0') === '1') {
    try {
      const char = db.prepare(
        'SELECT id, robot_emotions, personality, emotion_style, behavior, background, emotion_state FROM characters WHERE id=?'
      ).get(characterId);
      const mood = robotHelper.readMoodFromChar(char);
      const reaction = robotHelper.pickHeadGestureReaction({
        gesture: recorded.gesture,
        mood,
        char,
      });
      const faceKey = reaction.emotion || 'happy';
      const motion = robotHelper.normalizeMotion(reaction.motion || 'tilt');
      const face = robotHelper.buildFacePayload(settings0, char?.robot_emotions, faceKey);
      const reqBase = robotPublicBase(req, settings0);
      const servo = { action: motion, motion };
      const touchLed = { hex: '#ffc0cb', frequencyHz: 2, r: 255, g: 192, b: 203, brightness: 0.85 };
      const screen = robotScreen.setScreen(characterId, {
        emotion: faceKey,
        source: 'touch',
        motion,
        servo,
        led: touchLed,
        displayText: '',
        reply: '',
        touchSeq: Date.now(),
      }, reqBase);
      try {
        robotCommands.enqueueMany(characterId, [
          { type: 'display', payload: { emotion: faceKey, source: 'touch', motion, servo, led: touchLed } },
          { type: 'servo', payload: servo },
          { type: 'led', payload: touchLed },
        ]);
      } catch {}
      try {
        push('robot_event', {
          event: 'touch_face',
          characterId,
          emotion: faceKey,
          motion,
          gesture: recorded.gesture,
        });
      } catch {}
      res.locals.touchFace = {
        emotion: faceKey,
        motion,
        servo,
        led: touchLed,
        source: 'touch',
        updatedAt: screen.updatedAt,
        touchSeq: screen.touchSeq || Date.now(),
      };
    } catch (e) {
      console.warn('[robot/touch] face', e.message);
    }
  }

  // 可选：极短旁白（不走情绪系统）。冷却内不刷屏。
  let replied = false;
  if (characterId && String(settings0.robot_enabled || '0') === '1') {
    const lastAt = _headTouchReplyAt.get(characterId) || 0;
    if (Date.now() - lastAt > 45000) {
      try {
        const settings = getSettings();
        let char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
        if (char) {
          const screen = robotHelper.resolveScreenPolicy(settings);
          const text = recorded.gesture === 'stroke'
            ? '（桌上：有人顺着小机的头顶摸了一下——摸的是小机，不是角色本人）'
            : recorded.gesture === 'shake'
              ? '（桌上：有人轻轻摇晃了一下小机——晃的是小机，不是角色本人）'
              : '（桌上：有人轻轻点了点小机的头顶——摸的是小机，不是角色本人）';
          const now = new Date().toISOString();
          const userDelivery = contacts.userDeliveryStatus(db, characterId);
          const userMsgId = db.prepare(
            `INSERT INTO messages (character_id, role, content, type, timestamp, location, is_dream, delivery_status) VALUES (?,?,?,?,?,?,?,?)`
          ).run(characterId, 'user', text, 'text', now, '', 0, userDelivery).lastInsertRowid;
          mergeMessageMediaMeta(userMsgId, {
            robot: 1,
            source: 'head_touch',
            hideChat: screen.syncChat ? 0 : 1,
          });
          const extraSystemPrompt = [
            robotHelper.buildRobotExtraPrompt(settings, {
              operating: isRobotOperatingRow(char),
              operatingMode: robotOperatingHelper.getOperatingMode(characterId),
              muted: screen.muted,
            }),
            '【机身互动说明】用户碰的是桌上小机硬件（摸头/点头/摇晃）。你没有体感。若要回，只可极短带过「小机被碰了」，禁止写成自己被摸/被摇得很舒服，禁止因此情绪大起大落。多数时候一句或不回也行。',
          ].filter(Boolean).join('\n');
          const history = loadRecentChatHistory(characterId, 0, char, settings, 4);
          const promptOpts = {
            forRobot: true,
            contextText: buildChatContextText(text, history),
            userMessage: text,
            recentHistory: history,
            enableInlineDirectives: false,
          };
          const systemPrompt = buildSystemPrompt(char, settings, extraSystemPrompt, promptOpts);
          const reqBase = robotPublicBase(req, settings);
          const apiHistory = buildHistoryApiMessages(history, reqBase, {});
          while (apiHistory.length && apiHistory[apiHistory.length - 1].role === 'user') {
            apiHistory.pop();
          }
          let rawAi = await callChatAPIComplete(settings, systemPrompt, text, 'chat', apiHistory, await require('./robot-llm-tools').chatExtra(char, settings, { forRobot: true, userMessage: text })) || '';
          let aiContent = normalizeAiReplyText(rawAi, false, {});
          const parsed = robotHelper.parseRobotDirectives(aiContent);
          const speak = stripAiContextLabels(
            contacts.applyHiddenRelationMarkers(db, characterId, sanitizeInlineBeans(parsed.speak || '', { forceStrip: true }))
          ).trim();
          // 故意不调用 touchCharacterEmotionFromMessage：摸机 ≠ 摸人
          if (speak) {
            _headTouchReplyAt.set(characterId, Date.now());
            const aiMsgId = db.prepare(
              `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, delivery_status) VALUES (?,?,?,?,?,?,?)`
            ).run(characterId, 'assistant', speak, 'text', new Date().toISOString(), 0, 'sent').lastInsertRowid;
            mergeMessageMediaMeta(aiMsgId, {
              robot: 1,
              source: 'head_touch',
              hideChat: screen.syncChat ? 0 : 1,
              emotion: parsed.emotion,
            });
            if (screen.syncChat) {
              broadcastChatMessage(characterId, speak, [{
                id: aiMsgId,
                type: 'text',
                content: speak,
                media_meta: { robot: 1, emotion: parsed.emotion, source: 'head_touch' },
              }], false);
            }
            replied = true;
          }
        }
      } catch (e) {
        console.warn('[robot/touch] reply', e.message);
      }
    }
  }

  res.json({
    ok: true,
    gesture: recorded.gesture,
    at: recorded.at,
    characterId: characterId || null,
    replied,
    face: res.locals.touchFace || null,
  });
});

/** 上报摄像头识别到的用户情绪 / 面容比对（本地 CV，不调 LLM） */
app.post('/api/robot/sense', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  const embedding = faceprintHelper.parseEmbedding(req.body);
  let identity = faceprintHelper.parseIdentityHint(req.body);
  let identityScore = Number(req.body?.faceIdentityScore || req.body?.score) || 0;
  if (embedding) {
    const verified = faceprintHelper.verifyEmbeddingAgainstStored(embedding, getSettings);
    identity = verified.result;
    identityScore = verified.score;
  }
  const subject = robotHelper.parseSubjectIdentity(req.body || {});
  const facePresent = robotHelper.parseFacePresent(req.body);
  const sensed = robotHelper.recordSense({
    emotion: req.body?.emotion || req.body?.userEmotion,
    reaction: req.body?.reaction,
    confidence: req.body?.confidence ?? subject.confidence,
    facePresent: facePresent ?? req.body?.facePresent ?? true,
    faceIdentity: identity,
    faceIdentityScore: identityScore,
    isUser: subject.isUser,
    subjectType: subject.subjectType,
  });
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  const char = characterId
    ? db.prepare('SELECT robot_emotions FROM characters WHERE id=?').get(characterId)
    : null;
  const face = robotHelper.buildFacePayload(settings, char?.robot_emotions, sensed.reaction);
  res.json({
    ok: true,
    ...sensed,
    faceprint: faceprintHelper.publicFaceprintStatus(faceprintHelper.loadStoredFaceprint(() => settings)),
  });
});

/** 小机心跳：标记在线，供下行控制判断 */
app.post('/api/robot/heartbeat', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  const seenAt = robotDriveHelper.recordDeviceHeartbeat();
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  res.json({
    ok: true,
    seenAt,
    characterId: characterId || null,
    deviceOnline: true,
    pendingCommands: characterId ? robotCommands.getPendingCommands(characterId, 30).length : 0,
  });
});

/** 轻量屏幕状态：MCP 网关 / 调试页轮询 ParamFace 表情与硬件 */
app.get('/api/robot/screen', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  const characterId = resolveRobotCharacterId(settings, req.query?.characterId);
  if (!characterId) return res.status(400).json({ error: '未绑定角色' });
  const publicBase = robotPublicBase(req, settings);
  const behavior = robotHelper.buildBehaviorProfile(settings);
  const screenPolicy = robotHelper.resolveScreenPolicy(settings);
  const payload = robotScreen.buildScreenResponse(characterId, publicBase, { behavior });
  if (payload.screen && typeof payload.screen === 'object') {
    payload.screen.muted = !!screenPolicy.muted;
    payload.screen.playTts = !!screenPolicy.playTts;
    payload.screen.showChatOnScreen = true;
    payload.screen.volume = screenPolicy.effectiveVolume;
    payload.screen.volumeSetting = screenPolicy.volume;
    payload.screen.emotionUrl = '';
  }
  res.json({
    ...payload,
    muted: !!screenPolicy.muted,
    playTts: !!screenPolicy.playTts,
    volume: screenPolicy.effectiveVolume,
    screenEndpoint: '/api/robot/screen',
    commandsEndpoint: '/api/robot/commands',
  });
});

/** 小机拉取待执行指令（显示/扫一眼/播报/抓拍） */
app.get('/api/robot/commands', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  if (access.via === 'robot_token') {
    try { robotDriveHelper.recordDeviceHeartbeat(); } catch {}
  }
  const characterId = resolveRobotCharacterId(settings, req.query?.characterId);
  if (!characterId) return res.status(400).json({ error: '未绑定角色' });
  // types=speak,glance,snapshot：MCP 桥只取真机才做得到的那些，
  // 别把 display/led/servo 从内置屏幕桥手里抢走
  const commands = robotCommands.getPendingCommands(characterId, 30, {
    types: req.query?.types,
  });
  const screen = robotHelper.resolveScreenPolicy(settings);
  res.json({
    ok: true,
    characterId,
    commands,
    muted: screen.muted,
    showChatOnScreen: screen.showChatOnScreen,
    playTts: screen.playTts,
    volume: screen.effectiveVolume,
  });
});

/** 小机确认指令已执行 */
app.post('/api/robot/commands/ack', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : (req.body?.id ? [req.body.id] : []);
  const n = robotCommands.ackCommands(ids, { types: req.body?.types });
  res.json({ ok: true, acked: n });
});

/** 桌宠页：手动触发一次内在驱动靠近（调试用，登录会话） */
app.post('/api/robot/outreach/trigger', async (req, res) => {
  if (!siteLock.isAuthenticated(req) && siteLock.isEnabled()) {
    return res.status(401).json({ error: '需要登录', needsAuth: true });
  }
  const settings = getSettings();
  if (settings.robot_enabled !== '1') return res.status(403).json({ error: '桌宠未启用' });
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: '未绑定角色' });
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const drive = robotDriveHelper.refreshCharacterDrive(char, settings);
  const intent = String(req.body?.intent || '').trim() || robotDriveHelper.selectRobotIntent(char, drive, 'longing');
  const reqBase = `${req.protocol}://${req.get('host')}`;
  const allowOffline = req.body?.allowOffline === true || req.body?.allowOffline === 1;
  const result = await robotDriveHelper.invokeRobotFromCharacterWill(char, settings, {
    intent,
    proactiveText: String(req.body?.proactiveText || '').trim(),
    publicBase: robotPublicBase(req, settings) || reqBase,
    source: 'manual_trigger',
    force: true,
    allowOffline,
  });
  if (result?.reason === 'device_offline') {
    return res.status(409).json({
      error: '小机不在线，角色的动作没有送达通道，已跳过（没有白花 token）。',
      reason: 'device_offline',
    });
  }
  if (!result?.ok) return res.status(500).json({ error: result?.error || '触发失败' });
  res.json({ ok: true, ...result });
});

app.post('/api/robot/token/regenerate', (req, res) => {
  if (!siteLock.isAuthenticated(req) && siteLock.isEnabled()) {
    return res.status(401).json({ error: '需要登录后才能生成令牌', needsAuth: true });
  }
  const token = crypto.randomBytes(24).toString('hex');
  setSetting('robot_token', token);
  res.json({ ok: true, token });
});

/** 热替换 ParamFace：把 face-editor 导出的 JSON 下发给小机（经插件 MCP） */
app.post('/api/robot/face', (req, res) => {
  if (!siteLock.isAuthenticated(req) && siteLock.isEnabled()) {
    return res.status(401).json({ error: '需要登录', needsAuth: true });
  }
  const settings = getSettings();
  if (settings.robot_enabled !== '1') {
    return res.status(403).json({ error: '桌宠未启用' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: '请先在桌宠面板选择角色' });

  let jsonText = req.body?.json;
  if (jsonText && typeof jsonText === 'object') {
    try { jsonText = JSON.stringify(jsonText); } catch { jsonText = ''; }
  }
  jsonText = typeof jsonText === 'string' ? jsonText.trim() : '';
  if (!jsonText) return res.status(400).json({ error: '请提供 face.json 内容' });
  if (jsonText.length > 8000) {
    return res.status(400).json({ error: `脸 JSON 太大（${jsonText.length} 字节），机身上限约 8000` });
  }
  try {
    JSON.parse(jsonText);
  } catch {
    return res.status(400).json({ error: '不是合法 JSON' });
  }

  const row = robotCommands.enqueueLoadFace(characterId, { json: jsonText });
  if (!row) return res.status(500).json({ error: '入队失败' });
  res.json({
    ok: true,
    commandId: row.id,
    bytes: jsonText.length,
    hint: '已入队。MCP 网关连着机身时会几秒内推过去；断电不丢（写进机身 NVS）。',
  });
});

/** 清掉机身自定义脸，恢复固件内置脸 */
app.post('/api/robot/face/reset', (req, res) => {
  if (!siteLock.isAuthenticated(req) && siteLock.isEnabled()) {
    return res.status(401).json({ error: '需要登录', needsAuth: true });
  }
  const settings = getSettings();
  if (settings.robot_enabled !== '1') {
    return res.status(403).json({ error: '桌宠未启用' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: '请先在桌宠面板选择角色' });
  const row = robotCommands.enqueueResetFace(characterId, {});
  if (!row) return res.status(500).json({ error: '入队失败' });
  res.json({ ok: true, commandId: row.id });
});

/** 桌宠抓拍：写入当前角色相册（拍其他）+ 生成角色心得 */
app.post('/api/robot/snapshot', upload.single('file'), async (req, res) => {
  const settings0 = getSettings();
  const access = assertRobotAccess(req, settings0);
  if (!access.ok) {
    return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  }
  if (settings0.robot_enabled !== '1') {
    return res.status(403).json({ error: '桌宠未启用' });
  }

  const characterId = resolveRobotCharacterId(settings0, req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: '请先在桌宠面板选择角色' });
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: '角色不存在' });

  let filename = '';
  if (req.file?.filename) {
    filename = req.file.filename;
  } else {
    const parsed = parseRobotImageBase64(req.body?.imageBase64 || req.body?.image);
    if (!parsed?.buffer?.length) {
      return res.status(400).json({ error: '请上传 file 或提供 imageBase64' });
    }
    filename = saveRobotImageBuffer(parsed.buffer, parsed.ext);
  }

  const settings = getSettings();
  const reqBase = `${req.protocol}://${req.get('host')}`;
  const imageUrl = `/uploads/${filename}`;
  // 图片到手就说明镜头真开过：把挂起的照片气泡结算掉。
  // 下面的 recordSense 只在识别出身份时才跑，指望它兜底会漏。
  try {
    robotDriveHelper.flushRobotCameraEvents(characterId, { force: true, imageUrl });
  } catch {}
  const facePresent = robotHelper.parseFacePresent(req.body);
  const contextText = String(req.body?.context || req.body?.contextText || req.body?.text || '').trim();
  const skipNote = req.body?.skipNote === true || req.body?.skipNote === 1 || req.body?.skipNote === '1';
  const skipCaption = req.body?.skipCaption === true || req.body?.skipCaption === 1;

  let subjectIdentity = robotHelper.parseSubjectIdentity(req.body || {});
  if (!subjectIdentity.isUser && !subjectIdentity.subjectType && facePresent !== false) {
    try {
      const inferred = await robotIdentityHelper.inferSubjectFromImage(settings0, imageUrl, reqBase);
      subjectIdentity = robotIdentityHelper.mergeSubjectHints({
        facePresent: facePresent !== false,
        isUser: inferred.isUser,
        subjectType: inferred.subjectType,
        confidence: inferred.confidence,
      });
    } catch (e) {
      console.warn('[robot/snapshot] identity', e.message);
    }
  }
  if (subjectIdentity.isUser !== undefined) {
    try {
      robotHelper.recordSense({
        facePresent: subjectIdentity.facePresent ?? facePresent ?? true,
        isUser: subjectIdentity.isUser,
        subjectType: subjectIdentity.subjectType,
        confidence: subjectIdentity.confidence,
        imageUrl,
      });
    } catch {}
  } else {
    try {
      robotHelper.recordSense({
        facePresent: facePresent !== false,
        imageUrl,
      });
    } catch {}
  }

  applyRobotOperatingFromBody(characterId, req.body);
  const operating = isRobotOperatingRow(db.prepare('SELECT robot_operating FROM characters WHERE id=?').get(characterId));
  const screen = robotHelper.resolveScreenPolicy(getSettings());

  let description = String(req.body?.description || '').trim().slice(0, 80);
  let note = String(req.body?.note || '').trim().slice(0, 500);

  if (!skipCaption && !description) {
    try {
      description = await robotHelper.generateSnapshotCaption(settings, char, { imageUrl, publicBase: reqBase });
    } catch {
      description = '桌宠抓拍';
    }
  }
  if (!description) description = '桌宠抓拍';

  if (!skipNote && !note) {
    try {
      note = await robotHelper.generateSnapshotNote(settings, char, {
        imageUrl,
        publicBase: reqBase,
        context: contextText,
        facePresent,
        isUser: subjectIdentity.isUser,
        subjectType: subjectIdentity.subjectType,
      });
    } catch (e) {
      console.warn('[robot/snapshot] note', e.message);
    }
  }

  const saved = saveRobotSnapshotToAlbum({
    characterId,
    filename,
    description,
    note,
  });
  if (!saved) return res.status(500).json({ error: '写入相册失败' });

  try {
    push('album_update', { characterId, albumId: saved.id, source: 'robot' });
  } catch {}

  res.json({
    ok: true,
    albumId: saved.id,
    url: saved.url,
    description: saved.description || description,
    note: saved.note || note,
    subject: 'other',
    source: 'robot',
    characterId,
    characterName: char.name,
    operating,
    muted: screen.muted,
    showChatOnScreen: screen.showChatOnScreen,
    isUser: subjectIdentity.isUser,
    subjectType: subjectIdentity.subjectType || null,
    subjectConfidence: subjectIdentity.confidence || 0,
  });
});

/** 开始/结束截屏操作会话（固件 sc 环） */
app.post('/api/robot/operating', (req, res) => {
  const settings = getSettings();
  const access = assertRobotAccess(req, settings);
  if (!access.ok) return res.status(401).json({ error: '需要验证或桌宠令牌', needsAuth: true });
  if (settings.robot_enabled !== '1') {
    return res.status(403).json({ error: '桌宠未启用' });
  }
  const characterId = resolveRobotCharacterId(settings, req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: '请先在桌宠面板选择角色' });
  const on = robotHelper.parseBoolFlag(req.body?.active ?? req.body?.operating ?? req.body?.on);
  const off = robotHelper.parseBoolFlag(req.body?.end) || req.body?.active === false || req.body?.operating === false;
  if (off) robotOperatingHelper.exitRobotOperating(characterId);
  else if (String(req.body?.mode || '').trim() === 'screen') robotOperatingHelper.enterRobotScreenMode(characterId);
  else robotOperatingHelper.enterRobotPuppetMode(characterId);
  const char = db.prepare('SELECT id, name, robot_operating FROM characters WHERE id=?').get(characterId);
  const screen = robotHelper.resolveScreenPolicy(settings);
  res.json({
    ok: true,
    characterId,
    characterName: char?.name || null,
    operating: isRobotOperatingRow(char),
    operatingMode: robotOperatingHelper.getOperatingMode(characterId),
    muted: screen.muted,
    showChatOnScreen: screen.showChatOnScreen,
    syncChat: screen.syncChat,
  });
});

/** 通讯页结束/开始操作中（登录会话） */
app.post('/api/characters/:id/robot/operating', (req, res) => {
  const characterId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id, name, robot_operating FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const on = robotHelper.parseBoolFlag(req.body?.active ?? req.body?.operating ?? req.body?.on);
  const off = robotHelper.parseBoolFlag(req.body?.end) || req.body?.active === false || req.body?.operating === false;
  if (off) robotOperatingHelper.exitRobotOperating(characterId);
  else if (String(req.body?.mode || '').trim() === 'screen') robotOperatingHelper.enterRobotScreenMode(characterId);
  else robotOperatingHelper.enterRobotPuppetMode(characterId);
  const fresh = db.prepare('SELECT id, name, robot_operating FROM characters WHERE id=?').get(characterId);
  const screen = robotHelper.resolveScreenPolicy(getSettings());
  res.json({
    ok: true,
    characterId,
    characterName: fresh?.name || char.name,
    operating: isRobotOperatingRow(fresh),
    operatingMode: robotOperatingHelper.getOperatingMode(characterId),
    muted: screen.muted,
    showChatOnScreen: screen.showChatOnScreen,
    syncChat: screen.syncChat,
  });
});

/** 读取角色桌宠配置（专属表情图等） */
app.get('/api/characters/:id/robot', (req, res) => {
  const char = db.prepare('SELECT id, name, voice_id, robot_emotions, robot_operating FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const face = robotHelper.buildFacePayload(getSettings(), char.robot_emotions);
  res.json({
    ok: true,
    characterId: char.id,
    characterName: char.name,
    hasVoice: !!(char.voice_id || '').trim(),
    operating: isRobotOperatingRow(char),
    emotions: robotHelper.listEmotionOptions(),
    customEmotionAssets: face.customEmotionAssets,
  });
});

/** 保存角色桌宠表情图映射（遗留字段，ParamFace 不再使用 PNG 映射） */
app.put('/api/characters/:id/robot', (req, res) => {
  const char = db.prepare('SELECT id, robot_emotions FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const incoming = req.body?.emotionAssets || req.body?.robot_emotions || {};
  const prev = robotHelper.parseRobotEmotions(char.robot_emotions);
  const merged = { ...prev };
  for (const k of robotHelper.listEmotionOptions()) {
    if (incoming[k] === null || incoming[k] === '') {
      delete merged[k];
    } else if (incoming[k] !== undefined) {
      const v = String(incoming[k] || '').trim();
      if (!v) {
        delete merged[k];
        continue;
      }
      merged[k] = v.startsWith('/') ? v : `/uploads/${v.replace(/^\/uploads\//, '')}`;
    }
  }
  db.prepare('UPDATE characters SET robot_emotions=? WHERE id=?').run(JSON.stringify(merged), char.id);
  const face = robotHelper.buildFacePayload(getSettings(), JSON.stringify(merged));
  push('character_update', { characterId: char.id, robot_emotions: merged });
  res.json({
    ok: true,
    customEmotionAssets: face.customEmotionAssets,
  });
});

/** 上传单张桌宠表情图（遗留 API，ParamFace 不使用） */
app.post('/api/characters/:id/robot/emotion', upload.single('file'), (req, res) => {
  const char = db.prepare('SELECT id, robot_emotions FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  if (!req.file?.filename) return res.status(400).json({ error: '未收到文件' });
  const emotion = robotHelper.normalizeEmotion(req.body?.emotion || req.body?.key || 'neutral');
  if (!robotHelper.listEmotionOptions().includes(emotion)) {
    return res.status(400).json({ error: '无效 emotion' });
  }
  const assets = robotHelper.parseRobotEmotions(char.robot_emotions);
  assets[emotion] = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE characters SET robot_emotions=? WHERE id=?').run(JSON.stringify(assets), char.id);
  push('character_update', { characterId: char.id, robot_emotions: assets });
  const face = robotHelper.buildFacePayload(getSettings(), JSON.stringify(assets), emotion);
  res.json({
    ok: true,
    emotion,
    url: assets[emotion],
    customEmotionAssets: face.customEmotionAssets,
  });
});

app.post('/api/robot/chat', async (req, res) => {
  const settings0 = getSettings();
  const access = assertRobotAccess(req, settings0);
  if (!access.ok) {
    return res.status(401).json({ error: '需要验证或桌宠令牌（X-Nian-Robot-Token）', needsAuth: true });
  }
  if (access.via === 'robot_token') {
    try { robotDriveHelper.recordDeviceHeartbeat(); } catch {}
  }
  if (settings0.robot_enabled !== '1') {
    return res.status(403).json({ error: '桌宠未启用：请在念主页「桌宠」中打开开关' });
  }

  const text = String(req.body?.text || req.body?.content || '').trim();
  if (!text) return res.status(400).json({ error: '缺少 text' });

  const characterId = resolveRobotCharacterId(settings0, req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: '请先在桌宠面板选择角色' });

  let settings = getSettings();
  let char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  settings = withCharChatPrefs(settings, char);

  applyRobotOperatingFromBody(characterId, req.body);
  char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId) || char;
  const operating = isRobotOperatingRow(char);
  const screen = robotHelper.resolveScreenPolicy(settings);

  const facePresent = robotHelper.parseFacePresent(req.body);
  const presenceHint = robotHelper.parsePresenceHint(req.body);
  const lastSense = robotHelper.getLastSense(45000);
  const subjectFromBody = robotHelper.parseSubjectIdentity(req.body || {});
  const userEmotion =
    robotHelper.parseUserEmotion(req.body) ||
    lastSense?.emotion;
  const embedding = faceprintHelper.parseEmbedding(req.body);
  let faceIdentity = robotHelper.parseFaceIdentity(req.body);
  let faceIdentityScore = 0;
  if (embedding) {
    const verified = faceprintHelper.verifyEmbeddingAgainstStored(embedding, getSettings);
    faceIdentity = verified.result;
    faceIdentityScore = verified.score;
  } else if (!faceIdentity) {
    const last = robotHelper.getLastSense(30000);
    if (last?.faceIdentity && last.faceIdentity !== 'none') {
      faceIdentity = last.faceIdentity;
      faceIdentityScore = last.faceIdentityScore || 0;
    }
  }
  const isUser =
    subjectFromBody.isUser !== undefined
      ? subjectFromBody.isUser
      : lastSense?.isUser;
  const subjectType = subjectFromBody.subjectType || lastSense?.subjectType;
  const behavior = robotHelper.buildBehaviorProfile(settings);

  const now = new Date().toISOString();
  const userDelivery = contacts.userDeliveryStatus(db, characterId);
  const userMsgId = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, timestamp, location, is_dream, delivery_status) VALUES (?,?,?,?,?,?,?,?)`
  ).run(characterId, 'user', text, 'text', now, '', 0, userDelivery).lastInsertRowid;
  const userMeta = { robot: 1, source: 'stackchan' };
  if (operating) userMeta.operating = 1;
  if (!screen.syncChat) userMeta.hideChat = 1;
  if (facePresent !== undefined) userMeta.facePresent = facePresent;
  if (presenceHint) userMeta.presence = presenceHint;
  if (userEmotion) userMeta.userEmotion = userEmotion;
  if (faceIdentity && faceIdentity !== 'none') userMeta.faceIdentity = faceIdentity;
  if (isUser === true) userMeta.isUser = 1;
  if (isUser === false) userMeta.isUser = 0;
  if (subjectType) userMeta.subjectType = subjectType;
  mergeMessageMediaMeta(userMsgId, userMeta);

  if (contacts.getPeerStatus(db, characterId) === contacts.PEER.DELETED) {
    return res.json({
      ok: true,
      userMsgId,
      reply: '',
      speak: '',
      emotion: 'neutral',
      motion: 'idle',
      behavior,
      peerStatus: 'deleted',
    });
  }

  if (messageTriggersMemoryKeyword(text, char)) {
    maybeTriggerMemorySummary(characterId, { keywordTriggered: true, userMsgId });
  } else if (messageIndicatesSalientEmotion(text)) {
    maybeCaptureSalientFromMessage(characterId, userMsgId, {});
  } else if (messageIndicatesSalientPlan(text)) {
    maybeTriggerMemorySummary(characterId, { userMsgId });
  } else if (messageIndicatesUserProfileShare(text)) {
    maybeCaptureUserImpressionsFromMessage(characterId, userMsgId);
  }

  try {
    touchCharacterEmotionFromMessage(characterId, { role: 'user', content: text });
    try { robotDriveHelper.touchDriveFromUserInteraction(characterId); } catch {}
  } catch {}

  const history = loadRecentChatHistory(characterId, 0, char, settings, 8);

  const extraSystemPrompt = robotHelper.buildRobotExtraPrompt(settings, {
    facePresent,
    presence: presenceHint,
    userEmotion,
    faceprintEnrolled: faceprintHelper.publicFaceprintStatus(faceprintHelper.loadStoredFaceprint(() => settings)).enrolled,
    faceprintNote: behavior.faceprintEnabled ? faceprintHelper.faceprintPromptNote(faceIdentity) : '',
    voiceprintEnrolled: !!voiceprintHelper.loadStoredVoiceprint(() => settings)?.embedding?.length,
    operating,
    operatingMode: robotOperatingHelper.getOperatingMode(characterId),
    muted: screen.muted,
    isUser,
    subjectType,
  });
  const promptOpts = {
    forRobot: true,
    contextText: buildChatContextText(text, history),
    userMessage: text,
    recentHistory: history,
    enableInlineDirectives: false,
  };
  try { await prefetchLocationWeather(char, settings, promptOpts); } catch {}
  try {
    await applyBrainUnderstanding(char, settings, promptOpts);
  } catch (e) {
    console.warn('[brain] understanding robot', e.message);
  }
  const systemPrompt = buildSystemPrompt(char, settings, extraSystemPrompt, promptOpts);

  const reqBase = robotPublicBase(req, settings);
  const attachCamera = req.body?.attachCamera === true
    || req.body?.attachCamera === 1
    || req.body?.attachCamera === '1';
  // attachCamera 会把当前帧附在 userContent 上，历史里那条照片气泡就别再发一遍
  const apiHistory = buildHistoryApiMessages(history, reqBase, {
    noRobotFrameImage: attachCamera,
  });
  // 去掉末尾刚写入的用户句，避免与 callChatAPIComplete 的 userContent 重复
  while (apiHistory.length && apiHistory[apiHistory.length - 1].role === 'user') {
    apiHistory.pop();
  }
  let systemForApi = systemPrompt;
  let userContent = text;
  if (attachCamera) {
    try {
      const vis = robotVision.buildCameraVisionForChat(systemPrompt, {
        char,
        settings,
        robotHelper,
        robotDriveHelper,
        publicBase: reqBase,
        uploadsPath: UPLOADS_PATH,
        api: { toAbsoluteMediaUrl },
        getSettings,
      });
      if (vis) {
        systemForApi = vis.systemPrompt;
        userContent = [
          { type: 'text', text: String(text || '').trim() || vis.userParts[0].text },
          ...vis.userParts.filter((p) => p.type === 'image_url'),
        ];
      }
    } catch (e) {
      console.warn('[robot-vision] attach robot/chat', e.message);
    }
  }

  let rawAi = '';
  try {
    rawAi = await callChatAPIComplete(settings, systemForApi, userContent, 'chat', apiHistory, await require('./robot-llm-tools').chatExtra(char, settings, { forRobot: true, userMessage: text })) || '';
  } catch (e) {
    console.error('[robot/chat]', e.message);
    return res.status(500).json({
      error: formatApiBillingError(e.message) || e.message || '桌宠对话失败',
      userMsgId,
    });
  }
  if (!rawAi) {
    return res.status(500).json({ error: 'AI 返回为空', userMsgId });
  }

  let aiContent = normalizeAiReplyText(rawAi, false, {});
  const parsed = robotHelper.enrichRobotDirectives(robotHelper.parseRobotDirectives(aiContent), aiContent);
  const speak = stripAiContextLabels(
    contacts.applyHiddenRelationMarkers(db, characterId, sanitizeInlineBeans(parsed.speak || '', { forceStrip: true }))
  ).trim();

  let aiMsgId = null;
  if (speak) {
    aiMsgId = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, delivery_status) VALUES (?,?,?,?,?,?,?)`
    ).run(characterId, 'assistant', speak, 'text', new Date().toISOString(), 0, 'sent').lastInsertRowid;
    mergeMessageMediaMeta(aiMsgId, {
      robot: 1,
      source: 'stackchan',
      operating: operating ? 1 : 0,
      hideChat: screen.syncChat ? 0 : 1,
      emotion: parsed.emotion,
      motion: parsed.motion,
      motionRaw: parsed.motionRaw,
      led: parsed.led,
      servo: parsed.servo || robotHelper.servoPayloadFromMotion(parsed),
      expressionDecaySec: behavior.expressionDecaySec,
    });
  }

  try {
    if (speak) touchCharacterEmotionFromMessage(characterId, { role: 'assistant', content: speak });
  } catch {}

  try {
    if (speak && aiMsgId && screen.syncChat) {
      broadcastChatMessage(characterId, speak, [{
        id: aiMsgId,
        type: 'text',
        content: speak,
        media_meta: { robot: 1, emotion: parsed.emotion, motion: parsed.motion, operating: operating ? 1 : 0 },
      }], false);
    }
  } catch {}

  let audioBase64 = null;
  let audioMime = null;
  const wantTts = screen.playTts && req.body?.withTts !== false && req.body?.withTts !== 0;
  const voiceId = String(char.voice_id || '').trim();
  if (wantTts && voiceId && speak) {
    try {
      const buffer = await callTTS(settings, speak.slice(0, 500), voiceId, {
        emotion: parsed.emotion,
        forSpeaker: true,
      });
      if (buffer && buffer.length) {
        audioBase64 = Buffer.from(buffer).toString('base64');
        audioMime = 'audio/mp3';
      }
    } catch (e) {
      console.warn('[robot/tts]', e.message);
    }
  }

  const face = robotHelper.buildFacePayload(settings, char.robot_emotions, parsed.emotion);
  const servoOut = parsed.servo || robotHelper.servoPayloadFromMotion(parsed);
  const faceOut = robotScreen.absolutizeFacePayload(face, reqBase);
  try {
    robotCommands.enqueueHardwareFromParsed(characterId, parsed);
    if (robotDriveHelper.canCharacterUseRobot(char, settings)) {
      const puppetish = parsed.foundMotion || parsed.foundLed || parsed.foundServo
        || (parsed.foundEmotion && parsed.emotion !== 'neutral');
      if (puppetish) robotOperatingHelper.extendRobotPuppetMode(characterId, 90 * 1000);
    }
    robotDeviceBridge.syncScreenFromChat(characterId, {
      emotion: faceOut.emotion,
      emotionUrl: faceOut.emotionUrl,
      speak,
      reply: speak,
      displayText: speak || '',
      motion: parsed.motion,
      motionRaw: parsed.motionRaw,
      motionCustom: parsed.motionCustom,
      led: parsed.led,
      servo: servoOut,
      parsed,
    }, reqBase);
  } catch (e) {
    console.warn('[robot/chat] hardware enqueue', e.message);
  }

  res.json({
    ok: true,
    userMsgId,
    aiMsgId,
    reply: speak,
    speak,
    displayText: speak || '',
    showChatOnScreen: true,
    muted: screen.muted,
    operating,
    emotion: faceOut.emotion,
    motion: parsed.motion,
    motionRaw: parsed.motionRaw,
    motionCustom: parsed.motionCustom,
    led: parsed.led,
    servo: servoOut,
    customEmotionAssets: faceOut.customEmotionAssets,
    /** 表情在机身停留秒数后衰减回中性——本地执行，不另调 API */
    expressionDecaySec: behavior.expressionDecaySec,
    /** 情绪识别模式：glance=想看才扫一眼（非持续开摄） */
    senseMode: (behavior.emotionSenseEnabled || behavior.faceprintEnabled) ? 'glance' : 'off',
    /** 固件/桥：本回合若为看向用户，建议本地开摄扫一眼再上报 /api/robot/sense */
    glanceSuggested: !!((behavior.emotionSenseEnabled || behavior.faceprintEnabled) && robotHelper.motionSuggestsGlance(parsed)),
    faceIdentity: faceIdentity || 'none',
    faceIdentityScore: Math.round((faceIdentityScore || 0) * 1000) / 1000,
    behavior,
    characterId,
    characterName: char.name,
    audioBase64,
    audioMime,
    tts: !!audioBase64,
    playTts: !!audioBase64,
    syncChat: screen.syncChat,
    screenEndpoint: '/api/robot/screen',
  });
});

// ===== IMAGE GEN =====
app.post('/api/characters/test-selfie-image', async (req, res) => {
  const settings = getSettings();
  const useSettings = routeSettingsForMediaGen(settings);
  const hasImg2 = !!resolveImg2ImgConfig(useSettings);
  const hasTxt = !!(useSettings.image_api_url || '').trim() && !!(useSettings.image_api_key || '').trim();
  if (!hasImg2 && !hasTxt) {
    return res.status(400).json({
      ok: false,
      error: '请先在设置中填写「图生图 API」（推荐）或「图像生成 API」',
    });
  }
  const rawRefs = Array.isArray(req.body?.imageRefs) ? req.body.imageRefs : [];
  const imageRef = (req.body?.imageRef || rawRefs[0] || '').trim();
  if (!imageRef && !rawRefs.length) {
    return res.status(400).json({ ok: false, error: '请先上传形象参考图' });
  }
  try {
    const reqBase = `${req.protocol}://${req.get('host')}`;
    const homeRefs = normalizeHomeRefs(req.body?.homeRefs || []);
    const homeUrls = homeRefs.map((r) => r.url).filter(Boolean).slice(0, 2);
    const refGroupsIn = req.body?.imageRefGroups;
    const refList = (rawRefs.length ? rawRefs : [imageRef])
      .map(r => String(r || '').trim())
      .filter(Boolean)
      .concat(homeUrls)
      .map(r => toAbsoluteMediaUrl(r, reqBase))
      .filter(Boolean)
      .slice(0, 5);
    const aspect = normalizeSelfieAspect(req.body?.aspect || req.body?.image_aspect || '3:4');
    const sceneQuery = String(req.body?.sceneQuery || '').trim()
      || (homeUrls.length ? 'at home casual selfie, matching uploaded home interior' : 'casual indoor selfie, soft natural light');
    const charStub = {
      home_environment: String(req.body?.homeEnvironment || '').trim(),
      home_refs: homeRefs,
      selfie_style_prompt: String(req.body?.selfieStylePrompt || '').trim(),
      image_style: String(req.body?.imageStyle || 'real').trim() || 'real',
      description: String(req.body?.description || '').trim(),
      intro: String(req.body?.intro || '').trim(),
      nsfw_note: String(req.body?.nsfwNote || '').trim(),
    };
    const refGroups = normalizeImageRefGroups(refGroupsIn || { face: rawRefs.length ? rawRefs : [imageRef] });
    const prompt = buildSelfieGenerationPrompt({
      imageStyle: charStub.image_style,
      charName: '',
      sceneQuery,
      hasRef: true,
      hasBodyRef: refGroups.body.length > 0,
      hasFullBodyRef: (refGroups.fullbody?.length || 0) > 0,
      hasHandRef: refGroups.hands.length > 0,
      stylePrompt: charStub.selfie_style_prompt,
      aspect,
      char: charStub,
      hasHomeRef: homeUrls.length > 0,
    });
    const url = await generateImage(useSettings, prompt, refList[0], {
      referenceImages: refList,
      requireReference: true,
      publicBase: reqBase,
      aspect,
      provider: 'daily',
    });
    if (!url) {
      const detail = getLastGenerateImageError();
      return res.status(400).json({ ok: false, error: detail || 'API 返回为空，请检查图生图 API 配置' });
    }
    const meta = getLastGenerateImageMeta();
    const modelLabel = meta.model || useSettings.img2img_model || useSettings.image_model || '';
    res.json({
      ok: true,
      url,
      usedReference: meta.usedReference,
      model: modelLabel,
      provider: 'daily',
      mode: meta.mode || '',
      hint: meta.usedReference
        ? `已用日常图生图（${meta.mode || 'edits'}，模型 ${modelLabel || '-'}），参考图 ${meta.refCount || refList.length} 张`
        : '警告：未确认参考图是否生效，请检查对应 API 配置',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/image/test', async (req, res) => {
  const settings = getSettings();
  if (!(settings.image_api_url || '').trim() || !(settings.image_api_key || '').trim()) {
    return res.status(400).json({ ok: false, error: '请先在设置中填写图像生成 API 地址和 Key' });
  }
  try {
    const url = await generateImage(settings, 'a simple test image, soft purple gradient, minimal');
    if (!url) {
      const detail = getLastGenerateImageError();
      return res.status(400).json({ ok: false, error: detail || 'API 返回为空，请检查 Base URL 是否需加 /v1，或模型是否支持文生图' });
    }
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/unsplash/test', async (req, res) => {
  const settings = getSettings();
  if (!(settings.unsplash_api_key || '').trim()) {
    return res.status(400).json({ ok: false, error: '请先在设置中填写 Unsplash Access Key' });
  }
  try {
    const url = await fetchUnsplashImage(settings, 'nature landscape scenery still life');
    if (!url) return res.status(400).json({ ok: false, error: 'Unsplash 未返回图片，请检查 Key 是否有效' });
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/pexels/test', async (req, res) => {
  const settings = getSettings();
  if (!(settings.pexels_api_key || '').trim()) {
    return res.status(400).json({ ok: false, error: '请先在设置中填写 Pexels API Key' });
  }
  try {
    const url = await fetchPexelsVideo(settings, 'ocean waves landscape');
    if (!url) return res.status(400).json({ ok: false, error: 'Pexels 未返回视频，请检查 Key 是否有效' });
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/img2video/models', async (req, res) => {
  try {
    const settings = getSettings();
    const result = await fetchImg2VideoModelsFromApi(settings, {
      url: req.query?.url,
      key: req.query?.key,
    });
    res.json(result);
  } catch (e) {
    res.json({ models: listKnownImg2VideoModels(getSettings()), source: 'builtin', error: e.message });
  }
});

app.post('/api/img2video/models', async (req, res) => {
  try {
    const settings = getSettings();
    const body = req.body || {};
    const result = await fetchImg2VideoModelsFromApi(settings, {
      url: body.url,
      key: body.key,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ models: listKnownImg2VideoModels(getSettings()), source: 'builtin', error: e.message });
  }
});

app.post('/api/img2video/test', async (req, res) => {
  const settings = getSettings();
  if (!resolveImg2VideoConfig(settings)) {
    return res.status(400).json({ ok: false, error: '请先在设置中填写图生视频 API 地址和 Key（任意 HiAPI / OpenAI 兼容中转均可）' });
  }
  try {
    let char = null;
    const characterId = Number(req.body?.characterId || 0);
    if (characterId) {
      char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
    }
    if (!char) {
      const chars = db.prepare('SELECT * FROM characters ORDER BY id').all();
      char = chars.find(c => selectVideoReferenceUrl(c.image_ref)) || null;
    }
    const refUrl = selectVideoReferenceUrl(char?.image_ref);
    if (!refUrl) {
      return res.status(400).json({ ok: false, error: '请先在角色编辑上传形象参考图（正脸）。流程：先按场景图生图 → 再图生视频' });
    }
    if (!resolveImg2ImgConfig(settings)
      && (!(settings.image_api_url || '').trim() || !(settings.image_api_key || '').trim())) {
      return res.status(400).json({
        ok: false,
        error: '请先配置「图生图 API」或「图像生成 API」：测试会先画一张新场景静图（脸像角色），再做成视频',
      });
    }
    const reqBase = `${req.protocol}://${req.get('host')}`;
    // 与聊天一致：场景静图（新构图）→ 再动起来，而不是直接把正脸参考图做成动图
    const testScene = 'bathroom mirror selfie, soft steam, wet hair strands, casual home clothes, warm light, looking at camera';
    const url = await generateChatContextVideo(settings, char, `配视频：${testScene}`, testScene, {
      publicBase: reqBase,
    });
    if (!url) {
      let err = getLastGenerateVideoError() || getLastGenerateImageError() || '图生视频失败，请检查图生图 / HiAPI Key 与余额';
      if (/localhost|内网|公网|base64|data.?uri/i.test(err)) {
        err = `${err}\n\n已优先把静图内嵌为 base64。若仍失败：确认模型是 kling-3.0-omni/image-to-video（Wan 要用另一套入参，已自动区分），并检查 HiAPI 余额。`;
      }
      return res.status(400).json({ ok: false, error: err });
    }
    res.json({
      ok: true,
      url,
      model: settings.img2video_model || 'kling-3.0-omni/image-to-video',
      hint: `已用角色「${char.name || ''}」：先场景静图（脸/发像角色）→ 再做成短视频（静图为起始帧）`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/image/generate', async (req, res) => {
  const settings = getSettings();
  const { prompt } = req.body;
  try {
    const url = await generateImage(settings, prompt);
    if (!url) return res.status(400).json({ error: '图像生成配置缺失' });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== FILE UPLOAD =====
app.post('/api/upload', uploadLarge.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename });
});

// ===== CUSTOM FONTS =====
const FONTS_PATH = path.join(UPLOADS_PATH, 'fonts');
if (!fs.existsSync(FONTS_PATH)) fs.mkdirSync(FONTS_PATH, { recursive: true });

const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const fontStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FONTS_PATH),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = FONT_EXTS.has(ext) ? ext : '.ttf';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`);
  },
});
const uploadFont = multer({
  storage: fontStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!FONT_EXTS.has(ext)) return cb(new Error('仅支持 ttf / otf / woff / woff2'));
    cb(null, true);
  },
});

function loadCustomFontsRegistry() {
  try {
    const raw = getSettings().custom_fonts;
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveCustomFontsRegistry(list) {
  setSetting('custom_fonts', JSON.stringify(list));
}

function fontFormatFromExt(ext) {
  if (ext === '.woff2') return 'woff2';
  if (ext === '.woff') return 'woff';
  if (ext === '.otf') return 'opentype';
  return 'truetype';
}

function publicCustomFont(row) {
  return {
    id: row.id,
    name: row.name,
    familyName: row.familyName,
    url: row.url,
    format: row.format || fontFormatFromExt(path.extname(row.url || '')),
    createdAt: row.createdAt || '',
  };
}

app.get('/api/fonts', (req, res) => {
  res.json({ fonts: loadCustomFontsRegistry().map(publicCustomFont) });
});

app.post('/api/fonts/upload', (req, res) => {
  uploadFont.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || '上传失败' });
    try {
      if (!req.file) return res.status(400).json({ error: '请选择字体文件' });
      const ext = path.extname(req.file.filename).toLowerCase();
      const id = String(Date.now());
      const rawName = String(req.body?.name || path.parse(req.file.originalname || '').name || '自定义字体').trim();
      const name = (rawName || '自定义字体').slice(0, 40);
      const font = {
        id,
        name,
        familyName: `NianCF_${id}`,
        url: `/uploads/fonts/${req.file.filename}`,
        format: fontFormatFromExt(ext),
        createdAt: new Date().toISOString(),
      };
      const list = loadCustomFontsRegistry();
      list.push(font);
      saveCustomFontsRegistry(list);
      res.json({ ok: true, font: publicCustomFont(font) });
    } catch (e) {
      try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch {}
      res.status(500).json({ error: e.message || '字体保存失败' });
    }
  });
});

app.patch('/api/fonts/:id', (req, res) => {
  const id = String(req.params.id || '');
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!id || !name) return res.status(400).json({ error: '名称不能为空' });
  const list = loadCustomFontsRegistry();
  const idx = list.findIndex((f) => String(f.id) === id);
  if (idx < 0) return res.status(404).json({ error: '字体不存在' });
  list[idx].name = name;
  saveCustomFontsRegistry(list);
  res.json({ ok: true, font: publicCustomFont(list[idx]) });
});

app.delete('/api/fonts/:id', (req, res) => {
  const id = String(req.params.id || '');
  const list = loadCustomFontsRegistry();
  const idx = list.findIndex((f) => String(f.id) === id);
  if (idx < 0) return res.status(404).json({ error: '字体不存在' });
  const [removed] = list.splice(idx, 1);
  saveCustomFontsRegistry(list);
  try {
    const marker = '/uploads/fonts/';
    if (removed?.url && String(removed.url).startsWith(marker)) {
      const fp = path.resolve(FONTS_PATH, path.basename(removed.url));
      if (fp.startsWith(path.resolve(FONTS_PATH) + path.sep) || fp === path.resolve(FONTS_PATH)) {
        fs.unlinkSync(fp);
      }
    }
  } catch {}
  res.json({ ok: true });
});

/** 聊天语音条：转 WAV/MP3 后返回 url（播放 + 多模态）；顺带本地声纹比对 */
app.post('/api/chat/voice-upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const durationSec = Math.max(1, Math.min(60, Math.round(Number(req.body?.duration) || 0) || 1));
    const filename = await convertVoiceUploadForChat(req.file.path, req.file.originalname || 'voice.webm');
    const localPath = path.join(UPLOADS_PATH, filename);
    let voiceprint = { result: 'none', score: 0 };
    try {
      voiceprint = await voiceprintHelper.verifyFileAgainstStored(localPath, getSettings, setSetting);
    } catch (vpErr) {
      console.warn('[chat-voice-upload] voiceprint:', vpErr.message);
    }
    res.json({
      url: `/uploads/${filename}`,
      filename,
      duration: durationSec,
      voiceprint,
    });
  } catch (e) {
    console.warn('[chat-voice-upload]', e.message);
    res.status(500).json({ error: e.message || '语音上传失败' });
  }
});

// ===== CHARACTER STATUS =====
app.post('/api/characters/:id/status', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE characters SET status=? WHERE id=?').run(status, req.params.id);
  push('status_change', { characterId: parseInt(req.params.id), status });
  res.json({ ok: true });
});

/** 开启小剧场：文字扮演模式 */
app.post('/api/characters/:id/theater/start', (req, res) => {
  const characterId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: 'Not found' });
  if (isTheaterActive(char)) {
    return res.json({ ok: true, already: true, theaterActive: true });
  }
  setTheaterActive(characterId, true);
  const systemMsg = insertTheaterSystemMessage(characterId, '小剧场开始了（文字扮演，不是真实剧情）');
  push('character_update', { characterId, theater_active: 1 });
  res.json({ ok: true, theaterActive: true, systemMsg });
});

/** 结束小剧场：回到正常聊天，并概括本场扮演进记忆 */
app.post('/api/characters/:id/theater/end', (req, res) => {
  const characterId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return res.status(404).json({ error: 'Not found' });
  if (!isTheaterActive(char)) {
    return res.json({ ok: true, already: true, theaterActive: false });
  }
  setTheaterActive(characterId, false);
  const systemMsg = insertTheaterSystemMessage(characterId, '小剧场结束，回到正常聊天');
  push('character_update', { characterId, theater_active: 0 });
  scheduleTheaterMemorySummary(characterId);
  res.json({ ok: true, theaterActive: false, systemMsg });
});

app.post('/api/characters/:id/poke', async (req, res) => {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Not found' });
  if (char.status !== 'busy') return res.json({ came_back: false });

  // 本地判定，不调聊天 API，避免「叫TA一下」也消耗 token
  const cameBack = Math.random() < 0.68;
  if (cameBack) {
    clearCharacterOnline(parseInt(req.params.id, 10));
    push('status_change', { characterId: parseInt(req.params.id, 10), status: 'online' });
  }
  const pending = cameBack ? getUserMessagesNeedingRealReply(char.id) : [];
  res.json({
    came_back: cameBack,
    pending_count: pending.length,
    hint: cameBack ? '' : POKE_WAIT_HINTS[Math.floor(Math.random() * POKE_WAIT_HINTS.length)],
  });
});

// ===== 拍一拍后缀 =====
// charSuffix：用户拍角色时，由角色侧临场生成（「你拍了拍[角色]的[charSuffix]」）
// userSuffix：角色拍用户时，只用「我」里填写的拍一拍后缀，不再让角色 AI 生成
app.post('/api/characters/:id/poke-suffix', async (req, res) => {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Not found' });
  const settings = getSettings();
  const userSuffix = String(settings.poke_user_suffix || '').trim().slice(0, 12) || '肩膀';

  const prompt = `你是${char.name}。请生成一条有趣、符合你性格的"拍一拍"后缀：用户拍你时显示「拍了拍你的___」。
只写被拍的部位或动作短语（2-6个字，不含「的」字），JSON输出：
{"charSuffix":"如：脸颊/肩膀/头顶"}
只输出JSON，不要其他内容。`;
  try {
    const raw = await callChatAPI(settings, '', prompt, 'chat');
    const match = raw && raw.match(/\{[\s\S]*?\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      const charSuffix = String(data.charSuffix || '').trim().slice(0, 12) || '脑袋';
      try {
        db.prepare(`UPDATE characters SET poke_char_suffix=?, poke_user_suffix=? WHERE id=?`).run(
          charSuffix, userSuffix, req.params.id
        );
      } catch {}
      return res.json({ charSuffix, userSuffix });
    }
    res.json({ charSuffix: '脑袋', userSuffix });
  } catch (e) {
    res.json({ charSuffix: '脑袋', userSuffix });
  }
});

/** 用户在聊天里拍一拍角色：写入历史，供模型识别（不是省略号） */
app.post('/api/characters/:id/user-poke', async (req, res) => {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Not found' });
  const settings = getSettings();
  const username = settings.username || '旅人';
  const userSuffix = String(settings.poke_user_suffix || '').trim().slice(0, 12) || '肩膀';

  let charSuffix = String(char.poke_char_suffix || '').trim().slice(0, 12) || '脑袋';
  try {
    const prompt = `你是${char.name}。请生成一条有趣、符合你性格的"拍一拍"后缀：用户拍你时显示「拍了拍你的___」。
只写被拍的部位或动作短语（2-6个字，不含「的」字），JSON输出：
{"charSuffix":"如：脸颊/肩膀/头顶"}
只输出JSON，不要其他内容。`;
    const raw = await callChatAPI(settings, '', prompt, 'chat');
    const match = raw && raw.match(/\{[\s\S]*?\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      const next = String(data.charSuffix || '').trim().slice(0, 12);
      if (next) charSuffix = next;
    }
  } catch {}

  try {
    db.prepare(`UPDATE characters SET poke_char_suffix=?, poke_user_suffix=? WHERE id=?`).run(
      charSuffix, userSuffix, req.params.id
    );
  } catch {}

  const text = `${username} 拍了拍 ${char.name} 的${charSuffix}`;
  const now = new Date().toISOString();
  const id = db.prepare(
    `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,1)`
  ).run(char.id, 'user', text, 'system', now, 0).lastInsertRowid;

  const message = { id, role: 'user', type: 'system', content: text, timestamp: now };
  res.json({ text, charSuffix, userSuffix, message });
});

// ===== DATA EXPORT/IMPORT =====
app.get('/api/export', (req, res) => {
  try {
    const { types } = req.query;
    const selectedTypes = types ? String(types).split(',') : ['all'];
    res.json(require('./data-backup-helper').buildExportData(selectedTypes));
  } catch (e) {
    res.status(500).json({ error: e.message || '导出失败' });
  }
});

// ===== GITHUB 备份 =====
app.post('/api/github/backup', async (req, res) => {
  const settings = getSettings();
  const token = (settings.github_token || '').trim();
  const repo  = (settings.github_repo  || '').trim();

  if (!token || !repo) {
    return res.status(400).json({ error: '请先在设置中填写 GitHub Token 和私有仓库名（user/repo）' });
  }

  try {
    const backupHelper = require('./data-backup-helper');
    let exportData = (req.body && req.body.app === '念' && (req.body.characters || req.body.messages || req.body.memories))
      ? req.body
      : backupHelper.buildExportData(['all']);
    if (Array.isArray(req.body?.extra_messages) && req.body.extra_messages.length) {
      exportData = backupHelper.mergeExtraMessages(exportData, req.body.extra_messages);
    }
    exportData.backed_up_at = new Date().toISOString();
    exportData.app = '念';

    const json   = JSON.stringify(exportData, null, 2);
    const b64    = Buffer.from(json).toString('base64');
    const path   = `nian-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
    const headers = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'nian-app',
    };

    // 查是否存在同名文件（需要 sha 才能更新）
    let sha = null;
    try {
      const checkResp = await fetchWithTimeout(apiUrl, { headers, timeout: 30000 });
      if (checkResp.ok) {
        const existing = await checkResp.json();
        sha = existing.sha;
      }
    } catch(e) {}

    const body = { message: `备份 ${new Date().toISOString().slice(0, 16)}`, content: b64 };
    if (sha) body.sha = sha;

    const putResp = await fetchWithTimeout(apiUrl, {
      method: 'PUT', headers, body: JSON.stringify(body), timeout: 120000,
    });
    if (!putResp.ok) {
      const errText = await putResp.text().catch(() => '');
      return res.status(putResp.status).json({ error: `GitHub API 错误 ${putResp.status}: ${errText}` });
    }

    const result = await putResp.json();
    res.json({ ok: true, url: result.content?.html_url || `https://github.com/${repo}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/import', (req, res) => {
  try {
    const result = require('./data-backup-helper').importBackupData(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || '导入失败' });
  }
});

// ===== MODELS LIST =====
async function fetchModelsFrom(url, apiKey) {
  // 规范化 baseUrl，去掉末尾斜杠
  const baseUrl = url.replace(/\/+$/, '');

  // 部分中转站不带 /v1，尝试两个路径
  const candidates = baseUrl.endsWith('/v1')
    ? [`${baseUrl}/models`]
    : [`${baseUrl}/models`, `${baseUrl}/v1/models`];

  let lastErr = '';
  for (const endpoint of candidates) {
    try {
      const resp = await fetchWithTimeout(endpoint, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      });

      const raw = await resp.text().catch(() => '');
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}：${raw.slice(0, 200)}`;
        continue;
      }

      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('<') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
        lastErr = 'API 返回了 HTML 或非 JSON，请检查 Base URL 是否正确（通常需含 /v1）';
        continue;
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        lastErr = `JSON 解析失败：${e.message}`;
        continue;
      }

      // 兼容多种响应格式：{data:[...]}, {models:[...]}, 或直接是数组
      const list = Array.isArray(data) ? data
        : (data.data || data.models || data.result || []);

      const models = list
        .map(m => (typeof m === 'string' ? m : (m.id || m.name || m.model_name || '')))
        .filter(Boolean)
        .sort();

      if (models.length === 0 && data.error) {
        throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
      }
      return models;
    } catch(e) {
      lastErr = e.message;
    }
  }
  throw new Error(lastErr || '无法获取模型列表，请检查 URL 和 Key');
}

app.get('/api/models', async (req, res) => {
  const settings = getSettings();
  const url = (settings.chat_api_url || '').trim();
  const apiKey = (settings.chat_api_key || '').trim();
  if (!url || !apiKey) return res.status(400).json({ error: '请先配置API地址和Key' });
  try {
    res.json({ models: await fetchModelsFrom(url, apiKey) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 通用：从任意API地址拉取模型列表
app.post('/api/models/fetch', async (req, res) => {
  const { url, key } = req.body;
  if (!url || !key) return res.status(400).json({ error: '请提供 url 和 key' });
  try {
    res.json({ models: await fetchModelsFrom(url.trim(), key.trim()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 查询中转站 API Key 余额（New-API / HiAPI 等）
app.post('/api/balance/check', async (req, res) => {
  const { url, key } = req.body || {};
  if (!url || !key) return res.status(400).json({ error: '请提供 url 和 key' });
  try {
    res.json(await fetchApiBalance(String(url).trim(), String(key).trim()));
  } catch (e) {
    res.status(400).json({ error: e.message || '查询余额失败' });
  }
});

// MiniMax 语音模型（官方无 /models 列表，返回文档中的 TTS 模型）
app.post('/api/minimax/models', (req, res) => {
  res.json({ models: MINIMAX_SPEECH_MODELS });
});

app.post('/api/minimax/test', async (req, res) => {
  const settings = getSettings();
  const voiceId = String(req.body?.voiceId || '').trim();
  if (!voiceId) return res.status(400).json({ ok: false, error: '请提供测试用声音 ID' });
  try {
    const buffer = await callTTS(settings, '你好，这是一条 MiniMax 语音测试。', voiceId, {
      emotion: req.body?.emotion || 'happy',
    });
    res.json({ ok: true, bytes: buffer.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/sfx/test', async (req, res) => {
  const settings = {
    ...getSettings(),
    elevenlabs_api_key: String(req.body?.key || getSettings().elevenlabs_api_key || '').trim()
      || getSettings().elevenlabs_api_key,
    elevenlabs_api_url: String(req.body?.url || getSettings().elevenlabs_api_url || '').trim(),
  };
  const prompt = String(req.body?.prompt || 'ocean waves on a rocky shore, light sea wind').trim();
  try {
    const { generateSoundFx } = require('./sound-fx-helper');
    const audio = await generateSoundFx(settings, { prompt, duration: 4 });
    res.json({ ok: true, bytes: audio.buffer.length, duration: audio.duration });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/call/hangout-bed', async (req, res) => {
  try {
    const characterId = Number(req.body?.characterId);
    if (!Number.isFinite(characterId) || characterId <= 0) {
      return res.status(400).json({ ok: false, error: '缺少角色' });
    }
    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
    if (!char) return res.status(404).json({ ok: false, error: '角色不存在' });
    const cron = require('./cron');
    const sleepInfo = cron.resolveCallCharAsleepOnLine?.(characterId) || { asleep: false, activity: '' };
    const activity = String(sleepInfo.activity || '').trim();
    const { ensureHangoutBed } = require('./sound-fx-helper');
    const bed = await ensureHangoutBed(getSettings(), char, UPLOADS_PATH, activity);
    res.json({
      ...bed,
      charAsleep: !!sleepInfo.asleep,
      activity,
      night: !!sleepInfo.night,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || '生成失败' });
  }
});

/** 观影：截图 →「一起看」剧情摘要（不把图交给角色） */
app.post('/api/call/watch-scene', async (req, res) => {
  try {
    const characterId = Number(req.body?.characterId);
    const imageUrl = String(req.body?.imageUrl || '').trim();
    if (!Number.isFinite(characterId) || characterId <= 0) {
      return res.status(400).json({ ok: false, error: '缺少角色' });
    }
    if (!imageUrl) return res.status(400).json({ ok: false, error: '缺少画面' });
    const settings = getSettings();
    if (!(settings.chat_api_url || '').trim() || !(settings.chat_api_key || '').trim()) {
      return res.status(400).json({ ok: false, error: '请先配置聊天 API' });
    }
    const reqBase = `${req.protocol}://${req.get('host')}`;
    const scene = await describeCallWatchScene(settings, imageUrl, reqBase);
    if (!scene) return res.status(500).json({ ok: false, error: '画面识别失败' });
    rememberCallWatchScene(characterId, scene);
    res.json({ ok: true, scene });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || '识别失败' });
  }
});

// 图像生成模型：先尝试拉取，404/失败则返回 Imagen 常用列表
// purpose=img2img：用 Key 拉 /v1/models，并优先筛 image-to-image（HiAPI 失败时再读公开价目表）
app.post('/api/image/models', async (req, res) => {
  try {
    const { url, key, purpose } = req.body || {};
    const baseUrl = String(url || '').trim();
    const apiKey = String(key || '').trim();

    if (baseUrl && apiKey && String(purpose || '').toLowerCase() === 'img2img') {
      const result = await fetchImg2ImgModelsFromApi(getSettings(), { url: baseUrl, key: apiKey });
      return res.json({
        models: result.models || [],
        source: result.source,
        note: result.note || result.error,
        total: result.total,
        error: result.models?.length ? undefined : (result.error || '未获取到模型'),
      });
    }

    if (baseUrl && apiKey) {
      if (is80AiImageApi(baseUrl)) {
        try {
          const options = await fetch80AiImageModelOptions(baseUrl);
          const models = options.map(o => o.key);
          return res.json({
            models,
            modelOptions: options,
            source: '80ai',
            note: '80ai 网站名与填写的 ID 对照：Image 2（高质量）→ gptimage2_medium；Nano Banana 2 → banana2。自拍参考图请选 Image 2 系列，勿用 Banana。',
          });
        } catch (e) {
          return res.json({
            models: ['gptimage2_medium', 'gptimage2_high', 'gptimage2_low', 'banana2', 'banana', 'banana_pro'],
            source: 'static',
            note: `80ai 拉取失败，已加载常用模型：${e.message.slice(0, 80)}。Image 2（高质量）填 gptimage2_medium`,
          });
        }
      }
      const TINYSNOW_IMG_MODELS = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'];
      const isTinySnow = /tinysnow/i.test(baseUrl);
      try {
        const all = await fetchModelsFrom(baseUrl, apiKey);
        const imageModels = all.filter(m =>
          /imagen|dall|gpt-image|flux|stable|sdxl|midjourney|mj|recraft|ideogram|seedream|gptimage|banana/i.test(m)
        );
        if (imageModels.length) {
          let list = imageModels;
          if (/linkapi\.ai/i.test(baseUrl)) {
            const imagenOnly = list.filter(m => /imagen/i.test(m));
            if (imagenOnly.length) list = imagenOnly;
          }
          return res.json({ models: list, source: 'api' });
        }
        if (isTinySnow) {
          return res.json({
            models: TINYSNOW_IMG_MODELS,
            source: 'tinysnow',
            note: 'TinySnow 图生图常用模型（文档推荐 gpt-image-2）',
          });
        }
      } catch (e) {
        const is404 = /404|not found/i.test(e.message);
        if (isTinySnow) {
          return res.json({
            models: TINYSNOW_IMG_MODELS,
            source: 'tinysnow',
            note: `模型列表拉取失败，已给出 TinySnow 常用生图模型：${e.message.slice(0, 60)}`,
          });
        }
        return res.json({
          models: listKnownImageModels(),
          source: 'static',
          note: is404
            ? '该 API 地址没有 /models 接口（404），已加载 Imagen 常用模型'
            : `拉取失败，已加载 Imagen 常用模型：${e.message.slice(0, 80)}`,
        });
      }
    }
    res.json({ models: listKnownImageModels(), source: 'static' });
  } catch (e) {
    res.json({ models: listKnownImageModels(), source: 'static', note: e.message });
  }
});

// ===== 反地理编码：将坐标转换为城市地名 =====
app.get('/api/geocode/reverse', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: '缺少有效坐标' });
  }
  // live=1：聊天发位置等，保留实时地名，不用「家/公司」锚点改写
  const live = req.query.live === '1' || req.query.live === 'true'
    || req.query.skipStanding === '1' || req.query.skipStanding === 'true';
  const coordFallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  try {
    const locHelper = require('./location-weather-helper');
    const geo = await locHelper.reverseGeocodeCoords(lat, lng, { skipStanding: live });
    if (!geo) return res.json({ placeName: coordFallback, title: coordFallback, detail: '', lat, lng });
    return res.json({
      placeName: geo.placeName || coordFallback,
      title: geo.title || coordFallback,
      detail: geo.detail || '',
      road: geo.road || '',
      city: geo.city || '',
      district: geo.district || '',
      poi: geo.poi || '',
      anchor: live ? '' : (geo.anchor || ''),
      lat,
      lng,
    });
  } catch (e) {
    console.error('[geocode]', e.message);
    res.json({ placeName: coordFallback, title: coordFallback, detail: '', lat, lng });
  }
});

app.get('/api/geocode/map-preview', async (req, res) => {
  try {
    const locHelper = require('./location-weather-helper');
    const result = await locHelper.buildMapPreview({
      lat: req.query.lat,
      lng: req.query.lng,
      q: String(req.query.q || ''),
      uploadsPath: UPLOADS_PATH,
    });
    if (!result) return res.status(404).json({ error: '找不到这个位置' });
    res.json(result);
  } catch (e) {
    console.error('[map-preview]', e.message);
    res.status(500).json({ error: e.message || '地图预览失败' });
  }
});

// ===== 文本翻译（预设/提示词一键转英文，省 token 用） =====
app.post('/api/translate', async (req, res) => {
  const { text, target } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: '内容不能为空' });
  const settings = getSettings();
  const targetLang = target === 'zh' ? 'Chinese' : 'English';
  const systemPrompt = `You are a precise translator for AI system-prompt text. Translate the user's text into natural, fluent ${targetLang}, preserving structure (line breaks, numbered/bulleted lists, headers like 【】or [] ) and meaning exactly.
Special rule: if the text contains short quoted example phrases meant to illustrate what NOT to say in Chinese chat (e.g. 「總之就這樣」style quotes used as bad-example dialogue), KEEP those specific quoted Chinese phrases untranslated inside quotes, since they are literal Chinese speech examples, and only translate the surrounding instructional text.
Output ONLY the translated text, no explanation, no quotes around the whole result.`;
  try {
    const result = await callChatAPIComplete(settings, systemPrompt, String(text), 'chat');
    if (!result) return res.status(502).json({ error: '翻译失败：请检查聊天 API 配置（Base URL / Key）' });
    res.json({ translated: result.trim() });
  } catch (e) {
    res.status(500).json({ error: formatApiBillingError(e.message) || e.message });
  }
});

// ===== CLEAR DATA =====
app.post('/api/clear', (req, res) => {
  const { type, characterId } = req.body;
  const backupHelper = require('./data-backup-helper');
  const cleared = backupHelper.clearData(type, characterId);
  res.json({ ok: true, cleared });
});

// 群聊路由必须在 /api 404 与前端 * 兜底之前注册
try {
  const groupChat = require('./group-chat-helper');
  require('./group-chat-routes').registerGroupChatRoutes(app, {
    db,
    getSettings,
    push,
    buildSystemPrompt,
    withCharChatPrefs,
    groupChat,
  });
} catch (e) {
  console.warn('[group-chat] routes', e.message);
}

try {
  const tieba = require('./tieba-helper');
  require('./tieba-routes').registerTiebaRoutes(app, { tieba });
} catch (e) {
  console.warn('[tieba] routes', e.message);
}

// ===== 音乐同步接口 =====
// (已在上方 4086 行定义，此处删除重复实现)

// API 未匹配到时不要落到前端 HTML，否则前端会误报「返回了网页」
app.use('/api', (req, res) => {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  console.error('[server]', err);
  if (res.headersSent) return next(err);
  if (String(req.path || '').startsWith('/api')) {
    return res.status(500).json({ error: err.message || '服务器错误' });
  }
  res.status(500).send(err.message || 'Server error');
});

// Serve frontend pages
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_PATH, 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Initialize DB first, then start server
dbModule.initDB().then(() => {
  try { robotCommands.ensureRobotCommandsTable(); } catch (e) {
    console.warn('[robot-commands]', e.message);
  }
  try { require('./geo-worldbook-helper').syncAllGeoWorldbooks(db); } catch (e) {
    console.warn('[geo-worldbook] backfill', e.message);
  }
  try { require('./circle-helper').initCircleModule(); } catch (e) {
    console.warn('[circle] init', e.message);
  }
  try { require('./tieba-helper').initTiebaModule(); } catch (e) {
    console.warn('[tieba] init', e.message);
  }
  try {
    const settled = require('./memory-brain-helper').settleAllPassedCurrentMemories();
    if (settled) console.log('[brain] settled passed memories', settled);
  } catch (e) {
    console.warn('[brain] settle passed', e.message);
  }
  // 显式绑定 0.0.0.0，方便手机 App 用局域网 IP 连接
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✨ 念 · 后端服务已启动`);
    console.log(`   本机：http://localhost:${PORT}`);
    console.log(`   手机 App 请填：http://<电脑局域网IP>:${PORT}`);
    console.log(`   数据库：${path.join(__dirname, 'nian.db')}\n`);
    initWS(server);
    startCronJobs(aiInteractWithMoment, aiNpcInteractWithMoment, replyOwnerToNpcComments);
    try {
      robotDeviceBridge.startRobotDeviceBridge({
        getSettings,
        robotCommands,
        robotDriveHelper,
        robotHelper,
        db,
        publicBaseFallback: process.env.ROBOT_PUBLIC_BASE_URL || '',
      });
    } catch (e) {
      console.warn('[robot-bridge] start', e.message);
    }
    try {
      robotMcpBridge.startRobotMcpBridge({
        getSettings,
        robotCommands,
        robotDriveHelper,
        robotHelper,
        db,
        publicBaseFallback: process.env.ROBOT_PUBLIC_BASE_URL || '',
      });
    } catch (e) {
      console.warn('[robot-mcp] start', e.message);
    }
    try {
      seriesJobs.recoverStaleJobs();
      seriesJobs.pumpJobs();
    } catch (e) {
      console.warn('[series-jobs] recover', e.message);
    }
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});

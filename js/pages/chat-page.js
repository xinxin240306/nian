/* ===== 聊天页逻辑 ===== */
import * as api from '../api.js';
import { getChatSettings, saveChatSettings, getPendingMessages, savePendingMessages, getVoiceTranscriptOpenMap, setVoiceTranscriptOpen, getThemeColor } from '../storage.js';
import {
  getThreadCache,
  getThreadCacheSync,
  upsertThreadMessages,
  replaceThreadMessages,
  hydrateThreadCacheFromIdb,
  clearThreadCache,
  removeThreadMessages,
  pruneStaleThreadMessages,
  listOlderThreadMessages,
  searchThreadMessages,
} from '../chat-thread-cache.js';
import { scheduleThreadArchive, backfillAndAckThread } from '../chat-archive.js';
import { prefetchMessageMedia } from '../chat-media-cache.js';
import { downloadTextFile, downloadResultToast } from '../download-file.js';
  import { buildBubble, buildTimeDivider, buildTypingIndicator, resolveBubbleFontSizePx, resolveBubbleSizeScale, resolveBubbleFontFamily, resolveBubbleTextColor, resolveBubbleGapPx, encodeUserVoiceContent, getIsDream, formatTime, isHiddenChatMessage, applyCityAliasToText, buildCallRecordHtml, hydrateLocationCardMaps, hydrateWebCards, hydrateVideoThumbs, buildVideoThumbHtml, primeStickerLiveMap } from '../chat.js?v=swipe1';
import { hydrateMusicCards } from '../music-card.js';
import { initMusicSync, stopMusicSync } from '../music-sync.js';
import {
  ensureInlineEmojis,
  buildInlineEmojiGridHtml,
  insertInlineEmojiAtCursor,
} from '../inline-emoji.js';
import { getPaperFonts, isValidPaperFontId } from '../diary-paper.js';
import { shouldInsertTimeDivider, escapeHtml, splitAiSegments, stripVoiceLaneTags, stripAiContextLabels, looksLikeWebCardPayload, looksTruncatedUtterance } from '../memory.js';

function voiceBubbleSegments(content) {
  const raw = String(content || '').trim();
  if (raw.startsWith('{')) return [raw];
  return splitAiSegments(raw, { keepPeriod: true });
}

/** 通话里说的那句：入库带 callLine，聊天列表不要再按句拆成一句一泡 */
function isCallLineMessage(msg) {
  if (!msg || msg.role === 'user') return false;
  try {
    const meta = typeof msg.media_meta === 'string'
      ? JSON.parse(msg.media_meta || '{}')
      : (msg.media_meta || {});
    if (Number(meta?.callLine) === 1 || meta?.callLine === true) return true;
  } catch {}
  const cid = msg.character_id != null ? msg.character_id : charId;
  if (isInVoiceCallWith(cid)) return true;
  try {
    const s = getCallEngineState();
    if (s?.inCall && Number(s.callCharId) === Number(cid)) return true;
  } catch {}
  return false;
}
import { playNotifySound, playTTS, playReadyTTS, prefetchTTS, playVoiceAudio, playVoiceClipUrl, getLastTtsError, stopTTS, unlockAudioPlayback, playCallAmbient, stopCallAmbient, playCallBreathBed, playCallTextureBed, stopCallBodyBeds, playHangoutBed, playHangoutBedProcedural, stopHangoutBed, playCallOneShot, stopCallOneShot, duckCallAmbient, ensureCallAmbientPlaying, setHangoutBedListenQuiet } from '../tts.js';
import { pickCropAndUpload } from '../media-crop.js';
import { getGameTopics, gameTopicGameName } from '../game-topics.js';
import {
  bindGameButler,
  isGameButlerActive,
  onGameButlerUserSend,
  restoreGameButlerBar,
  initGameButlerUI,
  onGameButlerImageUpload,
} from '../game-butler.js';
import { getAppPermissionStatus, requestNativeMicrophone, requestNativeCamera, getDeviceCoordinates, formatLocationError, setNativeCallOverlay, setNativeCallPreviewFrame, setNativeCallMediaAudio, getNativeDeviceStatus, hasNativeCallAudio, startNativeCall, stopNativeCall, setNativeCallListen, beginNativeCallUtterance, abortNativeCallUtterance, commitNativeCallUtterance, nativeCallRms, nativeCallLevelAge, pullNativeCallRms, noteNativeCallListenTick, openExternalUrl, captureNativeScreen, toyStatus } from '../app-permissions.js';
import { isNativeShell } from '../server-config.js';
import { installCallEngine, getState as getCallEngineState, patchState as patchCallEngineState, callExtras as callEngineExtras, connectWhenOpenerReady, setCallSpeaking as engineSetSpeaking, setCallThinking as engineSetThinking, armAfterSpeak as engineArmAfterSpeak, reviveAfterForeground as engineReviveAfterForeground, noteUserSpeechForSleep, setVoiceMode as engineSetVoiceMode, onHangoutSleepChange as engineOnHangoutSleepChange, setCallPresenceMode as engineSetPresenceMode } from '../call/index.js';
import { setUserAsleep as engineSetUserAsleep } from '../call/call-presence.js';

// 暴露给外部（app.js 返回按钮等）调用，用于离开页面时停止朗读
window.stopCurrentTTS = stopTTS;
window.openExternalUrl = openExternalUrl;

function getGameTopicContextForAi() {
  return window._gameTopicContext || null;
}

window.clearGameTopic = function() {
  window._gameTopicContext = null;
  const bar = document.getElementById('game-topic-bar');
  if (bar) bar.style.display = 'none';
};

function isTheaterActiveLocal() {
  return Number(currentChar?.theater_active) === 1;
}
window.isTheaterActiveNow = () => isTheaterActiveLocal();

window.onTheaterStateChanged = function(active) {
  if (currentChar) currentChar.theater_active = Number(active) ? 1 : 0;
  setTheaterBarVisible(!!Number(active));
};

function setTheaterBarVisible(on) {
  const bar = document.getElementById('theater-bar');
  if (bar) bar.style.display = on ? 'flex' : 'none';
  const input = document.getElementById('chat-input');
  if (input && !isDream) {
    input.placeholder = on ? '描写或对白…' : '写点什么…';
  }
}

function restoreTheaterBar() {
  setTheaterBarVisible(isTheaterActiveLocal());
}

function isRobotDeviceOnline() {
  const s = window.getAppSettings?.() || {};
  const ts = Date.parse(String(s.robot_device_last_seen || ''));
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < 180 * 1000;
}

function isCharOperating(char = currentChar) {
  if (Number(char?.robot_operating) !== 1) return false;
  return isRobotDeviceOnline();
}

function isBusyBlocking(char = currentChar) {
  if (isDream) return false;
  if (isCharOperating(char)) return false;
  return char?.status === 'busy' && char?.busy_style !== 'off';
}

function isCharScreenOperating(char = currentChar) {
  return isCharOperating(char) && String(char?.robot_operating_mode || '') === 'screen';
}

function chatStatusLabel(char = currentChar) {
  if (isCharOperating(char)) {
    return isCharScreenOperating(char) ? '操作中' : '操纵中';
  }
  const st = char?.status || 'online';
  return { online: '在线', busy: '忙碌中', offline: '离线' }[st] || '在线';
}

function chatStatusDotClass(char = currentChar) {
  if (isCharOperating(char)) return 'status-dot status-operating';
  const st = char?.status || 'online';
  return `status-dot status-${st}`;
}

function operatingBarHint() {
  const syncOff = String(window.getAppSettings?.()?.robot_sync_chat || '1') === '0';
  if (isCharScreenOperating()) {
    if (syncOff) return '看屏协助中 · 操作短句不写入聊天 · 仍可指挥或打断';
    return '看屏协助中 · 聊天仍可发送，用来指挥或打断';
  }
  if (syncOff) return '桌边陪玩中 · 短句不写入聊天 · 要对小机说话请点屏幕或摸头顶';
    return '角色正通过桌上小机陪你 · 手机打字不会从喇叭出来；要对小机说话请点屏幕或摸头顶';
}

function syncOperatingBar() {
  const bar = document.getElementById('operating-bar');
  if (!bar || isDream) {
    if (bar) bar.style.display = 'none';
    return;
  }
  const on = isCharOperating();
  bar.style.display = on ? 'flex' : 'none';
  const title = document.getElementById('operating-bar-title');
  if (title) {
    title.textContent = isCharScreenOperating()
      ? '操作中 · 正在通过桌宠看屏幕'
      : '操纵中 · 正在操纵桌上小机';
  }
  const text = document.getElementById('operating-bar-text');
  if (text) text.textContent = operatingBarHint();
}
window.syncOperatingBar = syncOperatingBar;

window.endRobotOperating = async function() {
  if (!charId) return;
  try {
    await api.setCharacterRobotOperating(charId, false);
    if (currentChar) currentChar.robot_operating = 0;
    const appChars = window.getAppCharacters?.() || [];
    const idx = appChars.findIndex(c => Number(c.id) === Number(charId));
    if (idx >= 0) appChars[idx].robot_operating = 0;
    applyChatHeader(currentChar);
    syncOperatingBar();
    syncBusyBar();
    window.renderHomeChar?.();
  } catch (e) {
    window.showToast?.(e.message || '结束失败');
  }
};

window.onRobotOperatingChanged = function(characterId, operating, operatingMode) {
  const cid = Number(characterId);
  const appChars = window.getAppCharacters?.() || [];
  const idx = appChars.findIndex(c => Number(c.id) === cid);
  if (idx >= 0) {
    appChars[idx].robot_operating = operating ? 1 : 0;
    if (operatingMode) appChars[idx].robot_operating_mode = operatingMode;
    else if (!operating) appChars[idx].robot_operating_mode = null;
  }
  if (Number(charId) === cid && currentChar) {
    currentChar.robot_operating = operating ? 1 : 0;
    if (operatingMode) currentChar.robot_operating_mode = operatingMode;
    else if (!operating) currentChar.robot_operating_mode = null;
    applyChatHeader(currentChar);
    syncOperatingBar();
    syncBusyBar();
  }
  if (Number(window.getActiveCharId?.()) === cid) window.renderHomeChar?.();
};

function appendTheaterSystemBubble(systemMsg) {
  if (!systemMsg?.content) return;
  const list = document.getElementById('messages-list');
  list?.insertAdjacentHTML('beforeend', buildBubble({
    id: systemMsg.id || ('theater_' + Date.now()),
    role: 'assistant',
    content: systemMsg.content,
    type: 'system',
    timestamp: new Date().toISOString(),
  }, currentChar, {}));
  scrollBottom(true);
}

window.startTheater = async function() {
  if (!charId || isDream) {
    window.showToast?.(isDream ? '梦境中不可用' : '请先选择角色');
    return;
  }
  if (isTheaterActiveLocal()) {
    window.showToast?.('小剧场进行中');
    setTheaterBarVisible(true);
    setChatToolbarOpen(false);
    return;
  }
  if (isGameButlerActive(charId)) {
    window.showToast?.('请先结束当前游戏');
    return;
  }
  setChatToolbarOpen(false);
  window.closeEmojiPanel?.();
  try {
    const result = await api.startTheater(charId);
    if (currentChar) currentChar.theater_active = 1;
    const appChars = window.getAppCharacters?.() || [];
    const idx = appChars.findIndex(c => Number(c.id) === Number(charId));
    if (idx >= 0) appChars[idx].theater_active = 1;
    setTheaterBarVisible(true);
    appendTheaterSystemBubble(result.systemMsg);
    // 开场让角色接一句
    if (!result.already) {
      try {
        await _saveQueue;
        const aiResult = await triggerAiAndWaitTyping(charId, false, 'continue', false, null, false, false, getGameTopicContextForAi());
        rememberAiReplyResult(aiResult);
        await applyAiReplyResult(aiResult, new Date().toISOString(), charId);
      } catch (e) {
        stopWaitTypingPulse(true);
        showCharTypingFor(charId, false);
        window.showToast?.(e.message || '角色暂时没有接上');
      }
    }
  } catch (e) {
    window.showToast?.(e.message || '开启小剧场失败');
  }
};

window.endTheater = async function() {
  if (!charId) return;
  try {
    const result = await api.endTheater(charId);
    if (currentChar) currentChar.theater_active = 0;
    const appChars = window.getAppCharacters?.() || [];
    const idx = appChars.findIndex(c => Number(c.id) === Number(charId));
    if (idx >= 0) appChars[idx].theater_active = 0;
    setTheaterBarVisible(false);
    if (!result.already) appendTheaterSystemBubble(result.systemMsg);
  } catch (e) {
    window.showToast?.(e.message || '结束小剧场失败');
  }
};

window.openGameTopicsPanel = function(forCharId) {
  const cid = forCharId != null && forCharId !== '' ? Number(forCharId) : charId;
  if (!cid || isDream) {
    window.showToast?.(isDream ? '梦境中不可用' : '请先选择角色');
    return;
  }
  setChatToolbarOpen(false);
  window.closeEmojiPanel?.();
  const overlay = document.getElementById('game-topics-overlay');
  const list = document.getElementById('game-topics-list');
  const topics = getGameTopics(cid);
  if (list) {
    if (!topics.length) {
      list.innerHTML = `<div style="text-align:center;padding:48px 24px;color:var(--text-secondary);line-height:1.7">
        <div style="font-size:40px;margin-bottom:12px">📝</div>
        <div>暂无游戏话题</div>
        <div style="font-size:12px;margin-top:8px">玩真心话或默契翻牌、翻牌/通过后自动收录</div>
      </div>`;
    } else {
      list.innerHTML = topics.map(t => `
        <div onclick="selectGameTopic('${escapeHtml(String(t.id))}', ${cid})" style="padding:12px;margin-bottom:10px;background:var(--bg-glass);border:1px solid var(--border);border-radius:12px;cursor:pointer">
          <div style="font-size:12px;color:var(--theme);margin-bottom:4px">${escapeHtml(gameTopicGameName(t.game))} · ${t.mode === 'nsfw' ? 'NSFW' : '日常'}</div>
          <div style="font-size:14px;font-weight:500;margin-bottom:6px;line-height:1.5">${escapeHtml(t.question)}</div>
          <pre style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;margin:0;font-family:inherit;line-height:1.55">${escapeHtml(t.summary)}</pre>
        </div>`).join('');
    }
  }
  if (overlay) overlay.style.display = 'flex';
};

window.closeGameTopicsPanel = function() {
  const overlay = document.getElementById('game-topics-overlay');
  if (overlay) overlay.style.display = 'none';
};

window.selectGameTopic = function(topicId, forCharId) {
  const cid = forCharId != null && forCharId !== '' ? Number(forCharId) : charId;
  const topic = getGameTopics(cid).find(t => String(t.id) === String(topicId));
  if (!topic) return;
  window._gameTopicContext = topic.summary;
  window._gameTopicCharId = cid;
  window._gameTopicQuestion = topic.question;
  window._gameTopicGame = topic.game;
  window.closeGameTopicsPanel?.();
  if (Number(charId) === Number(cid)) {
    const bar = document.getElementById('game-topic-bar');
    const text = document.getElementById('game-topic-bar-text');
    const name = document.getElementById('game-topic-bar-name');
    if (bar) bar.style.display = 'flex';
    if (name) name.textContent = gameTopicGameName(topic.game);
    if (text) text.textContent = topic.question;
    document.getElementById('chat-input')?.focus();
  }
  window.showToast?.(Number(charId) === Number(cid) ? '已选中话题，发消息即可接着聊' : '已选中，去聊天页发消息即可');
};

function restoreGameTopicBarIfNeeded() {
  if (!charId || !window._gameTopicContext || Number(window._gameTopicCharId) !== Number(charId)) return;
  const bar = document.getElementById('game-topic-bar');
  const text = document.getElementById('game-topic-bar-text');
  const name = document.getElementById('game-topic-bar-name');
  if (bar) bar.style.display = 'flex';
  if (name) name.textContent = gameTopicGameName(window._gameTopicGame || 'truth_dare');
  if (text) text.textContent = window._gameTopicQuestion || '';
}

let currentChar = null;
let charId = null;
let isDream = false;

window.getChatCurrentChar = () => currentChar;
window.patchChatCurrentChar = (fresh) => {
  if (!fresh || currentChar == null) return;
  if (Number(fresh.id) !== Number(currentChar.id)) return;
  currentChar = { ...currentChar, ...fresh };
  if (inVideoCall) syncCallVideoTextModeUi();
};
let pendingMsgs = [];
let isLoading = false;
let offset = 0;
const LIMIT = 40;
/** 无本地缓存时，最多从服务端往回凑这么多再按「今天」切开 */
const MAX_INITIAL_MSGS = 120;
/** 进页立刻铺到屏幕上的气泡上限；多出来的进顶上折叠，点开再看 */
const MAX_VISIBLE_ON_OPEN = 48;
/** 从本地归档只取尾部窗口切屏，避免整本聊天史参与 DOM */
const CACHE_PAINT_TAIL = 160;
/** 进页后与服务器对齐近窗条数（不必每次拉 200） */
const SYNC_RECONCILE_LIMIT = 40;
let callTranscript = [];
let inCall = false;
let callCharId = null;
let callMinimized = false;
let callDialing = false;
let _dialingToken = 0;
/** 拨出最短振铃结束时刻；开场 TTS 就绪后也要等过了这个点再接通 */
let _dialRingUntil = 0;
let _callMediaPrepPromise = null;
let _callConnectBusy = false;
let callStartTime = null;
let callTimerInterval = null;
let inVideoCall = false;
let _callUserStream = null;
let _callCamFacing = 'user';
let _callVideoSwapBound = false;
let _callMediaGen = 0;
let _callPreparedAudioStream = null;
let _micWarmStream = null;
let _callLookPendingUrl = '';
let _callLookBusy = false;
let _callCamFlipping = false;
let _callMotionTimer = null;
let _callMotionPrev = null;
let _callMotionBurst = 0;
let _callMotionPending = false;
let _callMotionPendingAt = 0;
let _callMotionSettle = 0;
let _callMotionLastSent = 0;
let _callMotionCanvas = null;
let _callPipBound = false;
let _callPipPos = { edge: 'right', yRatio: 0.62 };
// 已入队等待AI回复的消息数
let _pendingAiCount = 0;
let _doSendBusy = false;
/** 空气泡自动用用户「嗯」顶上去：同一轮最多一次，避免死循环 */
const EMPTY_AI_NUDGE_TEXT = '嗯';
const EMPTY_AI_NUDGE_MAX = 1;
let _emptyAiNudgeCount = 0;
let _emptyAiNudging = false;
/** 打包已送到模型、第一条气泡还没出：顶栏断续显示正在输入 */
let _waitTypingTimer = 0;
let _waitTypingGen = 0;
let _waitTypingCharId = null;
const _pendingUserMsgIds = new Set();
/**
 * WS 成图/成视频可能早于气泡入 DOM（文字还在打字动画）。
 * HTTP 回包里的 content 仍是 __pending_*__，会盖掉已就绪的 URL → 气泡一直 ···。
 * 用此表记住「某 id 已就绪」的最新内容，渲染/写缓存时优先用。
 */
const _mediaReadyById = new Map();

function rememberMediaReadyUpdate(data) {
  const id = data?.id != null ? String(data.id) : '';
  if (!id || !data?.content) return;
  _mediaReadyById.set(id, {
    id,
    characterId: data.characterId,
    content: String(data.content),
    type: data.type || 'image',
    aspect: data.aspect || '',
    selfieReady: !!data.selfieReady,
    videoReady: !!data.videoReady,
    selfieFailed: !!data.selfieFailed,
    videoFailed: !!data.videoFailed,
    error: data.error || '',
    at: Date.now(),
  });
}

function clearMediaReadyUpdate(id) {
  if (id == null || id === '') return;
  _mediaReadyById.delete(String(id));
}

function peekMediaReadyUpdate(id) {
  if (id == null || id === '') return null;
  return _mediaReadyById.get(String(id)) || null;
}

/** 若该 id 已有 WS 成图结果，用就绪内容替换 HTTP 里的 pending 占位 */
function hydrateMediaMsgFromReadyCache(msg) {
  if (!msg || msg.id == null) return msg;
  const ready = peekMediaReadyUpdate(msg.id);
  if (!ready?.content) return msg;
  const cur = String(msg.content || '');
  if (!isPlaceholderMediaContent(cur) && cur === ready.content) return msg;
  // 仅当当前仍是占位/失败，或就绪内容更新时才替换（避免误伤）
  if (isPlaceholderMediaContent(cur) || cur !== ready.content) {
    return {
      ...msg,
      content: ready.content,
      type: ready.type || msg.type,
      aspect: ready.aspect || msg.aspect,
      media_aspect: ready.aspect || msg.media_aspect,
    };
  }
  return msg;
}

/** 异步自拍等待中：文字已出，图稍后到；多档补拉避免 WS 丢包或竞态后一直 ··· */
let _selfiePendingTimer = null;
let _selfiePollTimers = [];
function beginSelfiePendingWait(forCharId) {
  clearSelfiePendingWait(false);
  if (!shouldRenderForChar(forCharId)) return;
  // 成图常在数秒内完成；早拉几次，避免卡在 pending
  const pollAt = [2500, 6000, 14000, 30000, 60000];
  for (const ms of pollAt) {
    const t = setTimeout(async () => {
      _selfiePollTimers = _selfiePollTimers.filter(x => x !== t);
      if (!shouldRenderForChar(forCharId) || !_selfiePendingTimer) return;
      try { await syncNewMessages(); } catch {}
    }, ms);
    _selfiePollTimers.push(t);
  }
  // 生图较久；到期后停输入并再拉库补图
  _selfiePendingTimer = setTimeout(async () => {
    _selfiePendingTimer = null;
    for (const t of _selfiePollTimers) clearTimeout(t);
    _selfiePollTimers = [];
    if (!shouldRenderForChar(forCharId)) return;
    showCharTypingFor(forCharId, false);
    try { await syncNewMessages(); } catch {}
  }, 200000);
}
function clearSelfiePendingWait(hideTyping = true) {
  if (_selfiePendingTimer) {
    clearTimeout(_selfiePendingTimer);
    _selfiePendingTimer = null;
  }
  for (const t of _selfiePollTimers) clearTimeout(t);
  _selfiePollTimers = [];
  if (hideTyping) showCharTyping(false);
}

function replyHasPendingMedia(result) {
  if (!result) return false;
  const msgs = result.aiMessages || [];
  if (msgs.some(m =>
    (m?.type === 'image' || m?.type === 'video') && isPlaceholderMediaContent(m.content)
  )) return true;
  if (result.selfieImgUrl && isPlaceholderMediaContent(result.selfieImgUrl)) return true;
  if (result.generalImgUrl && isPlaceholderMediaContent(result.generalImgUrl)) return true;
  if (result.generalVideoUrl && isPlaceholderMediaContent(result.generalVideoUrl)) return true;
  return false;
}

/** HTTP 已收到的 AI 消息 id，防止 WS background_message 在打字动画期间再渲一遍 */
const _seenAiMsgIds = new Map();
const SEEN_AI_MSG_TTL_MS = 120000;

function rememberAiMsgIds(ids) {
  const now = Date.now();
  for (const id of ids || []) {
    if (id == null || id === '') continue;
    const s = String(id);
    if (s.startsWith('seg_') || s.startsWith('tmp_') || s.startsWith('vseg_') || s.startsWith('hist_') || s.startsWith('auto_')) continue;
    _seenAiMsgIds.set(s, now);
  }
  if (_seenAiMsgIds.size > 300) {
    for (const [k, t] of _seenAiMsgIds) {
      if (now - t > SEEN_AI_MSG_TTL_MS) _seenAiMsgIds.delete(k);
    }
  }
}

function hasSeenAiMsgId(id) {
  if (id == null || id === '') return false;
  const s = String(id);
  const t = _seenAiMsgIds.get(s);
  if (t == null) return false;
  if (Date.now() - t > SEEN_AI_MSG_TTL_MS) {
    _seenAiMsgIds.delete(s);
    return false;
  }
  return true;
}

function rememberAiReplyResult(result) {
  if (!result) return;
  if (result.aiMessages?.length) rememberAiMsgIds(result.aiMessages.map(m => m.id));
  rememberAiMsgIds([result.aiMsgId, result.selfieImgId, result.generalImgId, result.generalVideoId]);
}

function isAiMsgInDom(id) {
  if (id == null || id === '') return false;
  const list = document.getElementById('messages-list');
  if (!list) return false;
  const s = String(id);
  try {
    return !!list.querySelector(`[data-id="${CSS.escape(s)}"],[data-msg-id="${CSS.escape(s)}"]`);
  } catch {
    return false;
  }
}

/** HTTP 路径：若 WS 已先插入 DOM，则跳过，避免聊天气泡/通话字幕双份 */
function filterUnrenderedAiMessages(msgs) {
  if (!msgs?.length) return [];
  return msgs.filter(m => {
    if (m?.id == null || m.id === '') return true;
    return !isAiMsgInDom(m.id);
  });
}

function markPendingUserMsg(msgId, tmpId) {
  if (!msgId) return;
  const id = String(msgId);
  _pendingUserMsgIds.add(id);
  const el = document.querySelector(`[data-id="${tmpId || id}"]`);
  if (el) el.dataset.pendingAi = '1';
}

function clearPendingUserMsgs() {
  _pendingUserMsgIds.clear();
  document.querySelectorAll('.bubble-wrap[data-pending-ai="1"]').forEach(el => {
    delete el.dataset.pendingAi;
  });
}
// 保证手动点发送触发 AI 时，消息已入库
let _saveQueue = Promise.resolve();

function chainSave(task) {
  const p = _saveQueue.then(() => task());
  _saveQueue = p.catch(() => {});
  return p;
}

function isInVoiceCallWith(id) {
  return !!(inCall && callCharId != null && Number(id) === Number(callCharId));
}

function getVideoCallLookMode() {
  const s = getChatSettings(callCharId || charId);
  const m = String(s.videoCallLook || 'auto');
  if (m === 'off') return 'off';
  return 'auto';
}

function getVideoCallLookSecFromSettings(s) {
  const n = parseInt(s?.videoCallLookSec, 10);
  return Math.min(60, Math.max(8, Number.isFinite(n) ? n : 12));
}

function getVideoCallLookSec() {
  return getVideoCallLookSecFromSettings(getChatSettings(callCharId || charId));
}

function callTriggerExtra(lookUrl = '') {
  const extras = callEngineExtras();
  if (!inCall && !callDialing && !extras.callPresenceMode) {
    return {
      isVideoCall: !!inVideoCall,
      callLookImage: lookUrl || undefined,
    };
  }
  return {
    isVideoCall: !!(inVideoCall || extras.isVideoCall),
    callLookImage: lookUrl || undefined,
    // 本地芯片优先：自动切连麦后引擎若尚未对齐，不能仍上报 talk
    callPresenceMode: _callPresenceMode || extras.callPresenceMode || undefined,
    callHangoutSleeping: extras.callHangoutSleeping || undefined,
    callHangoutWakeStep: extras.callHangoutWakeStep || undefined,
    callInputMode: extras.callInputMode
      || ((inCall || callDialing) ? (_callVoiceMode ? 'voice' : 'keyboard') : undefined),
  };
}

function stopCallCamera() {
  stopCallMotionWatch();
  _callLookPendingUrl = '';
  _callLookBusy = false;
  _callCamFacing = 'user';
  _callCamFlipping = false;
  if (_callUserStream) {
    stopMediaStream(_callUserStream);
    _callUserStream = null;
  }
  const userVid = document.getElementById('call-user-video');
  if (userVid) {
    userVid.srcObject = null;
    userVid.classList.remove('is-call-paused');
  }
  const charVid = document.getElementById('call-char-video');
  if (charVid) {
    charVid.pause();
    charVid.removeAttribute('src');
    charVid.classList.remove('is-call-paused');
  }
  const pipImg = document.getElementById('call-pip-fallback-img');
  if (pipImg) pipImg.removeAttribute('src');
  const actions = document.getElementById('call-video-actions');
  if (actions) actions.style.display = 'none';
  document.getElementById('call-screen')?.classList.remove(
    'is-video', 'has-call-clip', 'has-user-cam', 'is-cam-swapped', 'is-rear-cam', 'is-cam-off'
  );
}

function bindCallVideoSwap() {
  if (_callVideoSwapBound) return;
  _callVideoSwapBound = true;
  const userVid = document.getElementById('call-user-video');
  const charVid = document.getElementById('call-char-video');
  const onPip = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.swapCallVideoLayout?.();
  };
  userVid?.addEventListener('click', (e) => {
    if (document.getElementById('call-screen')?.classList.contains('is-cam-swapped')) return;
    onPip(e);
  });
  charVid?.addEventListener('click', (e) => {
    if (!document.getElementById('call-screen')?.classList.contains('is-cam-swapped')) return;
    onPip(e);
  });
}

function syncCallCameraFacingClass() {
  const screen = document.getElementById('call-screen');
  if (!screen) return;
  screen.classList.toggle('is-rear-cam', _callCamFacing === 'environment');
  const userVid = document.getElementById('call-user-video');
  const hasCam = !!(userVid?.srcObject && liveVideoTracks(userVid.srcObject).length
    && !screen.classList.contains('is-cam-off'));
  screen.classList.toggle('has-user-cam', hasCam);
}

async function pickCameraDeviceId(facing, excludeId = '') {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return '';
  }
  const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
  if (!cams.length) return '';
  const wantBack = facing === 'environment';
  const others = excludeId ? cams.filter((c) => c.deviceId !== excludeId) : cams;
  const pool = others.length ? others : cams;
  const labeled = pool.find((c) => {
    const l = (c.label || '').toLowerCase();
    return wantBack
      ? /back|rear|environment|world|后置|后摄/.test(l)
      : /front|user|face|前置|前摄/.test(l);
  });
  if (labeled) return labeled.deviceId;
  if (pool.length === 1) return pool[0].deviceId;
  return wantBack ? pool[pool.length - 1].deviceId : pool[0].deviceId;
}

async function openCallCameraStream(facing, excludeId = '') {
  const want = facing === 'environment' ? 'environment' : 'user';
  const tryGet = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
  const deviceId = await pickCameraDeviceId(want, excludeId);
  if (deviceId) {
    try {
      return await tryGet({
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      });
    } catch { /* facingMode */ }
  }
  try {
    return await tryGet({
      facingMode: { exact: want },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    });
  } catch {
    try {
      return await tryGet({ facingMode: want });
    } catch {
      return await tryGet(true);
    }
  }
}

async function forcePlayCallVideoEl(el, { loop = false } = {}) {
  if (!el) return false;
  try {
    el.controls = false;
    el.removeAttribute('controls');
    el.muted = true;
    el.defaultMuted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.setAttribute('autoplay', '');
    el.setAttribute('muted', '');
    if (loop) {
      el.loop = true;
      el.setAttribute('loop', '');
    }
    if (el.paused || el.ended || el.readyState < 2) {
      const p = el.play();
      if (p && typeof p.then === 'function') await p;
    }
    el.classList.toggle('is-call-paused', !!el.paused);
    return !el.paused;
  } catch {
    el.classList.add('is-call-paused');
    return false;
  }
}

function bindCallVideoPauseClass(el) {
  if (!el || el.dataset.callPauseClass === '1') return;
  el.dataset.callPauseClass = '1';
  el.addEventListener('pause', () => {
    if (inVideoCall || getCallEngineState?.()?.inVideoCall) el.classList.add('is-call-paused');
  });
  el.addEventListener('playing', () => el.classList.remove('is-call-paused'));
}

async function attachCallUserVideo(stream) {
  const userVid = document.getElementById('call-user-video');
  if (!userVid || !stream) return;
  bindCallVideoPauseClass(userVid);
  bindCallVideoSwap();
  // 有轨但未启用：画面一直黑，有的 WebView 还会画出播放键
  for (const t of liveVideoTracks(stream)) {
    try {
      if (t.readyState === 'live' && !t.enabled) t.enabled = true;
    } catch {}
  }
  const needRemount = userVid.srcObject !== stream
    || userVid.paused
    || userVid.readyState < 2
    || !(userVid.videoWidth > 0);
  if (needRemount) {
    if (userVid.srcObject === stream) {
      // 从来电页挪过来的同一条流：先摘再挂，WebView 才会继续出帧
      try { userVid.srcObject = null; } catch {}
    }
    userVid.srcObject = stream;
  }
  const screen = document.getElementById('call-screen');
  screen?.classList.add('is-video');
  syncCallCameraFacingClass();
  const played = await forcePlayCallVideoEl(userVid);
  if (!played || !(userVid.videoWidth > 0)) {
    await new Promise((r) => {
      const done = () => {
        userVid.removeEventListener('loadedmetadata', done);
        userVid.removeEventListener('loadeddata', done);
        r();
      };
      userVid.addEventListener('loadedmetadata', done);
      userVid.addEventListener('loadeddata', done);
      setTimeout(done, 500);
    });
    await forcePlayCallVideoEl(userVid);
  }
  if (userVid.paused) {
    setTimeout(() => { void forcePlayCallVideoEl(userVid); }, 80);
    setTimeout(() => { void forcePlayCallVideoEl(userVid); }, 400);
  }
  syncCallCameraFacingClass();
}

async function ensureCallVideosPlaying() {
  const engVideo = !!getCallEngineState?.()?.inVideoCall;
  if (!inVideoCall && !engVideo) return;
  const screen = document.getElementById('call-screen');
  if (liveVideoTracks(_callUserStream).length && !screen?.classList.contains('is-cam-off')) {
    await attachCallUserVideo(_callUserStream);
  } else {
    syncCallCameraFacingClass();
  }
  const charVid = document.getElementById('call-char-video');
  if (charVid && screen?.classList.contains('has-call-clip') && charVid.getAttribute('src')) {
    bindCallVideoPauseClass(charVid);
    const ok = await forcePlayCallVideoEl(charVid, { loop: true });
    if (!ok) {
      try {
        charVid.removeAttribute('src');
        charVid.load?.();
      } catch {}
      screen.classList.remove('has-call-clip');
      charVid.classList.remove('is-call-paused');
    }
  }
}

/** 通话对端角色：优先用列表里较新的字段（避免编辑页改完 call_video_mode 后聊天页 currentChar 仍是旧的） */
function resolveCallPeerChar() {
  const id = callCharId != null ? callCharId : charId;
  if (id == null) return currentChar;
  const fromApp = window.getAppCharacters?.().find((c) => Number(c.id) === Number(id));
  if (fromApp && Number(currentChar?.id) === Number(id)) return { ...currentChar, ...fromApp };
  if (fromApp) return fromApp;
  return getCharMeta(id) || currentChar;
}

function isCallVideoTextMode(char) {
  const c = char || resolveCallPeerChar();
  return String(c?.call_video_mode || 'video').trim().toLowerCase() === 'text';
}

function syncCallVideoTextModeUi() {
  const screen = document.getElementById('call-screen');
  if (!screen) return;
  const textMode = !!(inVideoCall && isCallVideoTextMode());
  screen.classList.toggle('is-call-lens-text', textMode);
  if (!textMode) return;
  const cap = document.getElementById('call-lens-caption');
  if (!cap) return;
  cap.hidden = false;
  if (!String(cap.textContent || '').trim()) cap.textContent = '镜头接通中…';
}

async function startCallCamera({ silent = false, forceNew = false, camOff = false } = {}) {
  const screen = document.getElementById('call-screen');
  const charVid = document.getElementById('call-char-video');
  const actions = document.getElementById('call-video-actions');
  const pipImg = document.getElementById('call-pip-fallback-img');
  const peer = resolveCallPeerChar();
  screen?.classList.add('is-video');
  screen?.classList.toggle('is-cam-off', !!camOff);
  if (actions) actions.style.display = 'none';
  bindCallVideoSwap();
  if (pipImg) pipImg.src = peer?.avatar || currentChar?.avatar || document.getElementById('call-avatar')?.src || '';

  const textMode = isCallVideoTextMode(peer);
  screen?.classList.toggle('is-call-lens-text', textMode);
  const callVideo = textMode ? '' : String(peer?.call_video || currentChar?.call_video || '').trim();
  if (charVid) {
    bindCallVideoPauseClass(charVid);
    if (callVideo) {
      const resolved = window.resolveMediaUrl?.(callVideo) || callVideo;
      if (charVid.getAttribute('src') !== resolved) {
        charVid.src = resolved;
      }
      screen?.classList.add('has-call-clip');
      const ok = await forcePlayCallVideoEl(charVid, { loop: true });
      // 开场白后手势已失效时，别让暂停态原生大播放键盖住整屏（含自己的摄像头小窗观感）
      if (!ok) {
        try {
          charVid.removeAttribute('src');
          charVid.load?.();
        } catch {}
        screen?.classList.remove('has-call-clip');
        charVid.classList.remove('is-call-paused');
      }
    } else {
      charVid.removeAttribute('src');
      try { charVid.load?.(); } catch {}
      screen?.classList.remove('has-call-clip');
      charVid.classList.remove('is-call-paused');
      if (!silent && !textMode) window.showToast?.('该角色还没上传通话动画，先用头像当画面');
    }
  }
  if (textMode) {
    syncCallVideoTextModeUi();
  } else {
    clearCallLensCaption(true);
  }

  if (camOff) {
    if (_callUserStream) {
      stopMediaStream(_callUserStream);
      _callUserStream = null;
    }
    const userVid = document.getElementById('call-user-video');
    if (userVid) userVid.srcObject = null;
    syncCallCameraFacingClass();
    syncNativeCallOverlay();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    if (!silent) window.showToast?.('当前环境不支持摄像头');
    return;
  }
  try {
    if (forceNew || !liveVideoTracks(_callUserStream).length) {
      await ensureNativeCameraGranted();
      const next = await openCallCameraStream(_callCamFacing);
      if (_callUserStream && _callUserStream !== next) stopMediaStream(_callUserStream);
      _callUserStream = next;
    }
    await attachCallUserVideo(_callUserStream);
  } catch (e) {
    const nativeOn = !!(await getAppPermissionStatus().catch(() => ({})))?.camera;
    window.showToast?.(nativeOn ? '打不开摄像头，可能被其他应用占用' : '无法打开摄像头，请允许相机权限');
  }

  if (getVideoCallLookMode() !== 'off') startCallMotionWatch();
  syncNativeCallOverlay();
}

window.swapCallVideoLayout = function() {
  if (!inVideoCall || callDialing || callMinimized) return;
  document.getElementById('call-screen')?.classList.toggle('is-cam-swapped');
};

window.flipCallCamera = async function() {
  if (!inVideoCall || callDialing || callMinimized || _callCamFlipping) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    window.showToast?.('当前环境切不了摄像头');
    return;
  }
  _callCamFlipping = true;
  const btn = document.getElementById('call-flip-cam-btn');
  if (btn) btn.disabled = true;
  const nextFacing = _callCamFacing === 'environment' ? 'user' : 'environment';
  const old = _callUserStream;
  const oldId = old?.getVideoTracks?.()[0]?.getSettings?.()?.deviceId || '';
  const userVid = document.getElementById('call-user-video');
  try {
    const nextId = await pickCameraDeviceId(nextFacing, oldId);
    const track = old?.getVideoTracks?.()[0];
    if (track?.applyConstraints) {
      try {
        await track.applyConstraints({ facingMode: { exact: nextFacing } });
        _callCamFacing = nextFacing;
        syncCallCameraFacingClass();
        window.showToast?.(nextFacing === 'environment' ? '已切到后置' : '已切到前置');
        syncNativeCallOverlay();
        return;
      } catch { /* 多数安卓要关了再开 */ }
    }
    if (!nextId && !oldId) {
      const cams = (await navigator.mediaDevices.enumerateDevices().catch(() => []))
        .filter((d) => d.kind === 'videoinput' && d.deviceId);
      if (cams.length < 2) {
        window.showToast?.('没找到另一颗摄像头');
        return;
      }
    }
    if (old) {
      old.getTracks().forEach((t) => t.stop());
      _callUserStream = null;
      if (userVid) userVid.srcObject = null;
    }
    await new Promise((r) => setTimeout(r, 160));
    const tryGet = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
    let next = null;
    if (nextId) {
      try {
        next = await tryGet({
          deviceId: { exact: nextId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        });
      } catch { next = null; }
    }
    if (!next) next = await openCallCameraStream(nextFacing, oldId);
    _callUserStream = next;
    _callCamFacing = nextFacing;
    await attachCallUserVideo(next);
    window.showToast?.(nextFacing === 'environment' ? '已切到后置' : '已切到前置');
    syncNativeCallOverlay();
  } catch {
    _callCamFacing = nextFacing === 'environment' ? 'user' : 'environment';
    try {
      const fallback = await openCallCameraStream(_callCamFacing);
      _callUserStream = fallback;
      await attachCallUserVideo(fallback);
    } catch {}
    window.showToast?.('没法切到另一颗摄像头');
    syncNativeCallOverlay();
  } finally {
    _callCamFlipping = false;
    if (btn) btn.disabled = false;
  }
};

/**
 * 评估通话截帧画质。黑屏/糊也照样发给角色（像真视频：看不清就问），
 * 仅用于动作触发节流：纯黑别狂刷识图。
 * @returns {'ok'|'dark'|'flat'|false}
 */
function assessCallLookFrame(ctx, width, height) {
  if (!ctx || !width || !height) return false;
  const sw = Math.min(64, width);
  const sh = Math.min(48, height);
  let data;
  try {
    data = ctx.getImageData(0, 0, sw, sh).data;
  } catch {
    return false;
  }
  const n = sw * sh;
  if (n < 1) return false;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const std = Math.sqrt(variance);
  if (mean < 12) return 'dark';
  if (mean < 28 && std < 16) return 'dark';
  if (std < 6) return 'flat';
  return 'ok';
}

/** @deprecated 动作触发用：黑/糊不主动追问；用户发言时仍会送帧 */
function isCallLookFrameUsable(ctx, width, height) {
  return assessCallLookFrame(ctx, width, height) === 'ok';
}

async function captureCallLookFrame({ allowUnclear = true } = {}) {
  const video = document.getElementById('call-user-video');
  if (!video || video.readyState < 2) return '';
  if (document.getElementById('call-screen')?.classList.contains('is-cam-off')) return '';
  const w = video.videoWidth || 0;
  const h = video.videoHeight || 0;
  if (!w || !h) return '';
  const maxW = 720;
  const scale = w > maxW ? maxW / w : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const quality = assessCallLookFrame(ctx, canvas.width, canvas.height);
  if (!quality) return '';
  // 用户发言 / 接通预截：黑屏糊屏也送；仅动作追问时跳过纯黑，避免空刷
  if (!allowUnclear && quality !== 'ok') return '';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
  if (!blob) return '';
  const file = new File([blob], `call-look-${Date.now()}.jpg`, { type: 'image/jpeg' });
  const up = await api.uploadFile(file);
  return up?.url || '';
}

async function maybeCaptureLookForSend() {
  if (!inVideoCall) return '';
  if (getVideoCallLookMode() === 'off') return '';
  // 开场接通后预截的那帧：留给下一轮识图，不卡开场回复
  if (_callLookPendingUrl) {
    const pending = _callLookPendingUrl;
    _callLookPendingUrl = '';
    return pending;
  }
  try {
    return await captureCallLookFrame();
  } catch {
    return '';
  }
}

/** 接通并开场后再截一帧，塞进下一轮 trigger */
async function queueCallLookForNextRound() {
  if (!inVideoCall || callDialing) return;
  if (getVideoCallLookMode() === 'off') return;
  try {
    await waitForCallUserVideoFrame(2500);
    if (!inVideoCall || callDialing) return;
    const url = await captureCallLookFrame();
    if (url && inVideoCall) _callLookPendingUrl = url;
  } catch { /* 下一轮再说 */ }
}

function stopCallMotionWatch() {
  if (_callMotionTimer) {
    clearInterval(_callMotionTimer);
    _callMotionTimer = null;
  }
  _callMotionPrev = null;
  _callMotionBurst = 0;
  _callMotionPending = false;
  _callMotionPendingAt = 0;
  _callMotionSettle = 0;
}

function startCallMotionWatch() {
  stopCallMotionWatch();
  if (getVideoCallLookMode() === 'off') return;
  _callMotionLastSent = Date.now();
  _callMotionTimer = setInterval(tickCallMotion, 180);
}

function tickCallMotion() {
  if (!inVideoCall || callDialing || _callCamFlipping) return;
  if (_callLookBusy || _doSendBusy || _callLiveTts || _callLiveRec) return;
  if (document.getElementById('call-screen')?.classList.contains('is-cam-off')) return;
  const video = document.getElementById('call-user-video');
  if (!video || video.readyState < 2) return;
  const w = 48;
  const h = 36;
  if (!_callMotionCanvas) _callMotionCanvas = document.createElement('canvas');
  if (_callMotionCanvas.width !== w) _callMotionCanvas.width = w;
  if (_callMotionCanvas.height !== h) _callMotionCanvas.height = h;
  const ctx = _callMotionCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, w, h);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return;
  }
  const gray = new Float32Array(w * h);
  let lumSum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const y = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    gray[p] = y;
    lumSum += y;
  }
  // 全黑/近黑时像素噪声也会“晃”，不要当用户换角度去看
  if (lumSum / gray.length < 22) {
    _callMotionPrev = gray;
    _callMotionBurst = 0;
    _callMotionPending = false;
    _callMotionSettle = 0;
    return;
  }
  if (_callMotionPrev && _callMotionPrev.length === gray.length) {
    let diff = 0;
    for (let i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - _callMotionPrev[i]);
    const score = diff / gray.length;
    if (!_callMotionPending) {
      if (score >= 30) _callMotionBurst += 1;
      else _callMotionBurst = Math.max(0, _callMotionBurst - 1);
      if (_callMotionBurst >= 3) {
        _callMotionPending = true;
        _callMotionPendingAt = Date.now();
        _callMotionSettle = 0;
      }
    } else if (score < 14) {
      _callMotionSettle += 1;
      if (_callMotionSettle >= 2) {
        _callMotionPending = false;
        _callMotionBurst = 0;
        _callMotionSettle = 0;
        const gap = getVideoCallLookSec() * 1000;
        if (Date.now() - _callMotionLastSent >= gap) {
          sendCallLookToCharacter('motion');
        }
      }
    } else if (Date.now() - _callMotionPendingAt > 1800) {
      _callMotionPending = false;
      _callMotionBurst = 0;
      _callMotionSettle = 0;
      const gap = getVideoCallLookSec() * 1000;
      if (Date.now() - _callMotionLastSent >= gap) {
        sendCallLookToCharacter('motion');
      }
    } else {
      _callMotionSettle = 0;
    }
  }
  _callMotionPrev = gray;
}

async function sendCallLookToCharacter(reason = 'motion') {
  if (!inVideoCall || !callCharId || callDialing) return;
  if (_callLookBusy || _doSendBusy) return;
  _callLookBusy = true;
  _callMotionLastSent = Date.now();
  const sendCharId = callCharId;
  try {
    const lookUrl = await captureCallLookFrame({ allowUnclear: false });
    if (!lookUrl || !inVideoCall || callCharId !== sendCharId) return;
    _doSendBusy = true;
    const hint = reason === 'motion'
      ? '对方镜头晃了一下或换了角度。像真人视频通话：你刚透过屏幕瞥到这一幕，有变化再随口提一句；看不清就当没看清，别硬演看见。不要提截图或系统。'
      : '你正透过视频看着对方此刻的画面。像真人视频：清楚就自然接；看不清可以眯眼辨认或随口问一句。不要提截图。';
    const result = await api.triggerAi(
      sendCharId, isDream, 'continue', false, null, true, false, null,
      hint,
      null,
      { ...callTriggerExtra(lookUrl), isVideoCall: true, callLookImage: lookUrl },
    );
    rememberAiReplyResult(result);
    showCharTypingFor(sendCharId, false);
    setCallIdleStatus();
    if (hasAiReplyPayload(result)) {
      await applyAiReplyResult(result, new Date().toISOString(), sendCharId);
    }
  } catch {
    showCharTypingFor(sendCharId, false);
    setCallIdleStatus();
  } finally {
    _callLookBusy = false;
    _doSendBusy = false;
  }
}

function setCallIdleStatus() {
  syncCallWaveform();
}

function callOverlayPhase() {
  if (_callLiveTts) return 'speaking';
  if (inCall && !callDialing && _doSendBusy) return 'thinking';
  if (inCall && !callDialing && _callLiveOn && _callVoiceMode) return 'listening';
  return 'idle';
}

function syncCallWaveform() {
  const screen = document.getElementById('call-screen');
  if (!screen) return;
  const state = callOverlayPhase();
  screen.classList.toggle('is-wave-idle', state === 'idle');
  screen.classList.toggle('is-wave-thinking', state === 'thinking');
  screen.classList.toggle('is-wave-listening', state === 'listening');
  screen.classList.toggle('is-wave-speaking', state === 'speaking');
}

function isCallRealtimeTalk() {
  return !!(_callRealtimeMode && inCall && !isCallHangoutMode() && _callVoiceMode);
}

function callLiveMinRms() {
  if (isCallHangoutMode()) return CALL_LIVE_HANGOUT_MIN_RMS;
  const soft = _callQuietRejectStreak >= 2 ? 0.7 : 1;
  if (isCallRealtimeTalk()) return CALL_REALTIME_MIN_RMS * soft;
  return CALL_LIVE_MIN_RMS * soft;
}

function interruptCallSpeech() {
  _callTtsPlayGen += 1;
  stopTTS();
  if (_callLiveTts) setCallSpeaking(false);
  syncCallBedDuck();
}

async function handleCallBargeIn() {
  if (_callBargeBusy || _callLiveRec || _callLiveCommitting || !isCallRealtimeTalk()) return;
  _callBargeBusy = true;
  try {
    interruptCallSpeech();
    await sleepMs(80);
    if (!inCall || !_callLiveOn || _callLiveRec || _callLiveTts) return;
    _callLiveHeardSpeech = true;
    _callLiveLoudTicks = CALL_LIVE_SPEECH_TICKS;
    _callLiveSilentAt = 0;
    await beginCallLiveUtterance();
  } finally {
    _callBargeBusy = false;
  }
}

function setCallSpeaking(on) {
  document.getElementById('call-screen')?.classList.toggle('is-speaking', !!on);
  _callLiveTts = !!on;
  try { engineSetSpeaking(!!on); } catch {}
  if (on && _callLiveRec && !isCallRealtimeTalk()) {
    const elapsed = _callLiveUtterStart ? Date.now() - _callLiveUtterStart : 0;
    if (elapsed >= CALL_LIVE_MIN_MS && _callLiveHeardSpeech) commitCallLiveUtterance();
    else abortCallLiveUtterance();
  }
  syncCallBedDuck();
  updateCallLiveHoldUi();
  syncCallWaveform();
  syncNativeCallOverlay({ speaking: !!on });
}

function syncCallBedDuck() {
  const onCall = !!(inCall && !callDialing);
  // 角色开口不再压/停环境音；换位置由 play/stop 自己淡入淡出
  try { duckCallAmbient(false); } catch {}
  try { setHangoutBedListenQuiet(onCall && _callLiveOn && !_callLiveTts); } catch {}
}

let _callPreviewTimer = 0;
let _lastCallOverlayPhase = '';

async function syncNativeCallOverlay(extra = {}) {
  if (!window.isNativeShell?.()) return;
  try {
    const char = (callCharId != null ? getCharMeta(callCharId) : null) || currentChar;
    if (!inCall) {
      stopCallPreviewPump();
      _lastCallOverlayPhase = '';
      await setNativeCallOverlay({ on: false });
      return;
    }
    const phase = extra.phase != null ? String(extra.phase) : callOverlayPhase();
    const speaking = extra.speaking != null ? !!extra.speaking : phase === 'speaking';
    await setNativeCallOverlay({
      on: true,
      video: !!inVideoCall,
      avatar: char?.avatar || document.getElementById('call-avatar')?.src || '',
      clip: inVideoCall && !isCallVideoTextMode(char) ? (char?.call_video || '') : '',
      facing: inVideoCall ? _callCamFacing : '',
      characterId: callCharId,
      name: char?.name || 'TA',
      speaking,
      phase,
    });
    _lastCallOverlayPhase = phase;
    if (inVideoCall) startCallPreviewPump();
    else stopCallPreviewPump();
  } catch {}
}

function startCallPreviewPump() {
  if (_callPreviewTimer) return;
  _callPreviewTimer = window.setInterval(pushCallPreviewFrame, 2000);
  pushCallPreviewFrame();
}

function stopCallPreviewPump() {
  if (_callPreviewTimer) {
    clearInterval(_callPreviewTimer);
    _callPreviewTimer = 0;
  }
}

async function pushCallPreviewFrame() {
  if (!inVideoCall || !inCall || callDialing) return;
  try {
    const video = document.getElementById('call-user-video');
    if (!video || video.readyState < 2) return;
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    if (!w || !h) return;
    const maxW = 480;
    const scale = w > maxW ? maxW / w : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    await setNativeCallPreviewFrame(canvas.toDataURL('image/jpeg', 0.62));
  } catch {}
}

window.expandCallFromNative = function() {
  if (inCall && !callDialing) window.expandCall?.();
  else void reconcileOrphanNativeCall();
};

window.hangupCallFromNative = function() {
  if (inCall || callDialing) window.endCall?.();
  else void reconcileOrphanNativeCall();
};

/** WebView 挂掉后原生仍显示通话球：清悬浮窗并补一条通话结束系统消息 */
let _reconcileCallBusy = false;
async function reconcileOrphanNativeCall() {
  if (!window.isNativeShell?.()) return;
  if (inCall || callDialing || _reconcileCallBusy) return;
  try {
    const es = getCallEngineState();
    if (es?.inCall || es?.callDialing) return;
  } catch {}
  _reconcileCallBusy = true;
  try {
    const st = await getAppPermissionStatus();
    const charId = Number(st?.activeCallCharId) || 0;
    const callOn = !!st?.callOn;
    if (!callOn && charId <= 0) return;

    const wasVideo = !!st?.activeCallVideo;
    const startedAt = Number(st?.activeCallStartedAt) || 0;
    const durationSec = startedAt > 0
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : 0;
    const durStr = formatCallDur(durationSec);

    await setNativeCallOverlay({ on: false });
    await stopNativeCall();
    await setNativeCallMediaAudio(false);

    if (charId > 0) {
      const endContent = `[${wasVideo ? '视频通话' : '语音通话'}已结束] 通话计时 ${durStr}`;
      let savedId = null;
      try {
        const saved = await api.sendMessage({
          characterId: charId,
          isDream: false,
          noReply: true,
          content: endContent,
          type: 'system',
        });
        savedId = saved?.userMsgId ?? saved?.id ?? null;
      } catch {}
      api.saveCallLog({
        characterId: charId,
        duration: durationSec,
        transcript: '',
      }).catch(() => {});
      const endMsg = {
        id: savedId != null ? savedId : `call_orphan_end_${Date.now()}`,
        role: 'user',
        type: 'system',
        content: endContent,
        timestamp: new Date().toISOString(),
        character_id: charId,
      };
      try { upsertThreadMessages(charId, false, [endMsg]); } catch {}
      if (shouldRenderForChar(charId)) {
        const chatList = document.getElementById('messages-list');
        if (chatList && !isAiMsgInDom(endMsg.id) && !chatList.querySelector('[data-call-orphan-end]')) {
          const html = buildBubble(endMsg, getCharMeta(charId), {}, { charId })
            .replace(/class="([^"]*call-record[^"]*)"/, 'class="$1" data-call-orphan-end="1"');
          chatList.insertAdjacentHTML('beforeend', html);
          scrollBottom(true);
        }
      }
      window.showToast?.(`${wasVideo ? '视频通话' : '通话'}已中断 · ${durStr}`);
    }
  } catch (e) {
    console.warn('[call] reconcile orphan', e?.message || e);
    try {
      const es = getCallEngineState();
      if (es?.inCall || es?.callDialing || inCall || callDialing) return;
    } catch {}
    try { await setNativeCallOverlay({ on: false }); } catch {}
    try { await stopNativeCall(); } catch {}
    try { await setNativeCallMediaAudio(false); } catch {}
  } finally {
    _reconcileCallBusy = false;
  }
}

window.__nianReconcileCall = () => { void reconcileOrphanNativeCall(); };

function clearCallPipInlinePos() {
  const screen = document.getElementById('call-screen');
  if (!screen) return;
  screen.style.top = '';
  screen.style.left = '';
  screen.style.right = '';
  screen.style.bottom = '';
  screen.style.transform = '';
}

function applyCallPipPosition() {
  const screen = document.getElementById('call-screen');
  if (!screen || !callMinimized) return;
  const pad = 10;
  const video = screen.classList.contains('is-video');
  const w = screen.offsetWidth || (video ? 96 : 48);
  const h = screen.offsetHeight || (video ? 72 : 48);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minY = Math.max(pad, (window.visualViewport?.offsetTop || 0) + pad);
  const maxY = Math.max(minY, vh - h - pad);
  let y = Math.round((_callPipPos.yRatio ?? 0.62) * (vh - h));
  y = Math.min(maxY, Math.max(minY, y));
  screen.style.top = `${y}px`;
  screen.style.bottom = 'auto';
  screen.style.transform = 'none';
  if (_callPipPos.edge === 'left') {
    screen.style.left = `${pad}px`;
    screen.style.right = 'auto';
  } else {
    screen.style.right = `${pad}px`;
    screen.style.left = 'auto';
  }
  // keep ratio in sync after clamp
  _callPipPos.yRatio = (vh - h) > 0 ? y / (vh - h) : 0.62;
}

let _callRelistenAt = 0;
let _callCaptureNudgeAt = 0;
let _callListenNoteAt = 0;

function playCallMediaEl(v) {
  if (!v) return;
  const live = v.srcObject || v.currentSrc || v.getAttribute('src');
  if (!live) return;
  try { v.muted = true; } catch {}
  if (!v.paused && v.readyState >= 2) return;
  const p = v.play?.();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function attachCallMicSink(stream) {
  if (!stream || !stream.getAudioTracks?.().length) return;
  let el = document.getElementById('call-mic-sink');
  if (!el) {
    el = document.createElement('audio');
    el.id = 'call-mic-sink';
    el.muted = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:0;pointer-events:none';
    document.body.appendChild(el);
  }
  if (el.srcObject !== stream) el.srcObject = stream;
  const p = el.play?.();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

/** 小窗 / 切到别的应用时，采集画面和麦都要保持在播，不能等用户点回整页 */
function keepCallCaptureAlive(opts = {}) {
  if (!inCall || callDialing) return;
  document.getElementById('call-screen')?.querySelectorAll('video').forEach(playCallMediaEl);
  _callLiveStream?.getAudioTracks?.().forEach((t) => { if (t.readyState === 'live') t.enabled = true; });
  _callUserStream?.getVideoTracks?.().forEach((t) => { if (t.readyState === 'live') t.enabled = true; });
  try {
    if (_callLiveCtx && _callLiveCtx.state === 'suspended') _callLiveCtx.resume?.().catch(() => {});
  } catch {}
  if (_callLiveStream) attachCallMicSink(_callLiveStream);
  if (!opts.relisten || !_callVoiceMode) return;
  const now = Date.now();
  if (now - _callRelistenAt < 1500) return;
  _callRelistenAt = now;
  if (_callLiveOn) void applyNativeCallListenMode();
  else void startCallLiveListen();
}

window.minimizeCall = function() {
  if (!inCall || callDialing) return;
  callMinimized = true;
  try { patchCallEngineState({ callMinimized: true }); } catch {}
  const screen = document.getElementById('call-screen');
  if (!screen) return;
  screen.classList.add('is-minimized');
  ensureCallPipBound();
  requestAnimationFrame(() => {
    applyCallPipPosition();
    keepCallCaptureAlive({ relisten: true });
  });
  window.showToast?.('通话已收起，可以继续说话');
};

window.expandCall = function() {
  if (!inCall) return;
  callMinimized = false;
  try { patchCallEngineState({ callMinimized: false }); } catch {}
  const screen = document.getElementById('call-screen');
  if (!screen) return;
  screen.classList.remove('is-minimized', 'is-dragging');
  clearCallPipInlinePos();
  keepCallCaptureAlive();
};

function ensureCallPipBound() {
  if (_callPipBound) return;
  const screen = document.getElementById('call-screen');
  if (!screen) return;
  _callPipBound = true;

  let dragging = false;
  let moved = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  const onMove = (e) => {
    if (!dragging || !callMinimized || (pointerId != null && e.pointerId !== pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 8) return;
    moved = true;
    screen.classList.add('is-dragging');
    const pad = 8;
    const w = screen.offsetWidth;
    const h = screen.offsetHeight;
    let left = origLeft + dx;
    let top = origTop + dy;
    left = Math.min(window.innerWidth - w - pad, Math.max(pad, left));
    top = Math.min(window.innerHeight - h - pad, Math.max(pad, top));
    screen.style.left = `${left}px`;
    screen.style.top = `${top}px`;
    screen.style.right = 'auto';
    screen.style.bottom = 'auto';
    screen.style.transform = 'none';
  };

  const onUp = (e) => {
    if (!dragging || (pointerId != null && e.pointerId !== pointerId)) return;
    dragging = false;
    screen.classList.remove('is-dragging');
    try { screen.releasePointerCapture?.(pointerId); } catch {}
    pointerId = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (!callMinimized) return;
    if (!moved) {
      window.expandCall();
      return;
    }
    const rect = screen.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    _callPipPos.edge = mid < window.innerWidth / 2 ? 'left' : 'right';
    const h = rect.height;
    _callPipPos.yRatio = (window.innerHeight - h) > 0
      ? rect.top / (window.innerHeight - h)
      : 0.62;
    applyCallPipPosition();
  };

  screen.addEventListener('pointerdown', (e) => {
    if (!callMinimized || !inCall) return;
    if (e.target.closest?.('#call-pip-hangup')) return;
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    moved = false;
    pointerId = e.pointerId;
    const rect = screen.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origLeft = rect.left;
    origTop = rect.top;
    try { screen.setPointerCapture?.(pointerId); } catch {}
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  window.addEventListener('resize', () => {
    if (callMinimized) applyCallPipPosition();
  });
}

async function playCallReplyAudio(result, forCharId) {
  if (!isInVoiceCallWith(forCharId) || !result) return;
  applyCallAmbienceField(result.callAmbience);
  // 文字视频：场景条只在这里推一次，后面 TTS 不再重复 append
  applyCallLensFromResult(result);
  const lensPushed = !!(inVideoCall && isCallVideoTextMode() && (
    String(result?.callLens || '').trim()
    || (result.aiMessages || []).some((m) => String(m?.content || '').trim())
    || String(result?.content || '').trim()
  ));
  const parts = [];
  if (result.aiMessages?.length) {
    for (const m of result.aiMessages) {
      if ((m.type === 'text' || m.type === 'voice') && String(m.content || '').trim()
        && !looksLikeWebCardPayload(m.content)) {
        parts.push({
          raw: m.content,
          id: m.id,
          emotion: String(m.tts_emotion || '').trim() || undefined,
          tone: String(m.tts_tone || '').trim() || undefined,
        });
      }
    }
  } else if (result.autoReply) {
    parts.push({ raw: result.autoReply, id: result.aiMsgId });
  } else if (result.content) {
    parts.push({ raw: result.content, id: result.aiMsgId });
  }
  for (const part of parts) applyCallScenePayload(parseCallAudioPayload(part.raw));
  for (const part of parts) {
    await playCallSpeechPayload(parseCallAudioPayload(part.raw), forCharId, part.id, {
      armListen: false,
      emotion: part.emotion,
      tone: part.tone,
      skipScenePush: lensPushed,
    });
  }
  await armCallLiveAfterSpeak();
}

function shouldRenderForChar(forCharId) {
  return window.isChatPageActiveFor?.(Number(forCharId)) === true;
}

function markOpenChatRead(forCharId = charId) {
  if (!forCharId || !shouldRenderForChar(forCharId)) return;
  api.markMessagesRead(forCharId, isDream ? 1 : 0)
    .then(() => markVisibleAiMsgsRead())
    .catch(() => {});
}

window.onChatPageHidden = function() {
  _chatLoadSeq += 1;
  _chatFgSyncSeq += 1;
  _chatPageReloading = false;
  stopWaitTypingPulse(true);
  showCharTyping(false);
  clearSelfiePendingWait(false);
};

function getCharMeta(forCharId) {
  if (Number(forCharId) === Number(charId) && currentChar) return currentChar;
  return window.getAppCharacters?.().find(c => Number(c.id) === Number(forCharId)) || { id: forCharId, name: 'TA', avatar: '' };
}

function deferAiReply(forCharId, previewOrMsgs) {
  if (window.isChatPageActiveFor?.(forCharId)) return;
  const msgs = Array.isArray(previewOrMsgs)
    ? previewOrMsgs
    : [{ type: 'text', content: previewOrMsgs || '新消息' }];
  const c = getCharMeta(forCharId);
  // 与 WS background_message 共用去重，避免通知/未读双倍
  const claimed = window.notifyIncomingChatOffPage?.(forCharId, msgs, {
    charName: c.name || 'TA',
    charAvatar: c.avatar || '',
  });
  if (claimed === false) {
    // 已被另一通道认领：只同步服务端未读，不再本地累加
    window.syncUnreadCounts?.();
  }
}

function showCharTypingFor(forCharId, on, kind) {
  if (!shouldRenderForChar(forCharId)) return;
  showCharTyping(on, kind);
}

function setWaitTypingDimmed(on) {
  document.getElementById('chat-char-status')?.classList.toggle('typing-dim', !!on);
}

function stopWaitTypingPulse(hide = true) {
  _waitTypingGen += 1;
  if (_waitTypingTimer) {
    clearTimeout(_waitTypingTimer);
    _waitTypingTimer = 0;
  }
  const cid = _waitTypingCharId;
  _waitTypingCharId = null;
  setWaitTypingDimmed(false);
  if (hide && cid != null) showCharTypingFor(cid, false);
}

/** 等第一条气泡：先显示正在输入，整段最多切回在线 1～3 次，每次停够一会儿再继续输入 */
function startWaitTypingPulse(forCharId, kind = 'typing') {
  if (_waitTypingCharId != null && Number(_waitTypingCharId) === Number(forCharId)) return;
  stopWaitTypingPulse(false);
  if (!forCharId || !shouldRenderForChar(forCharId)) return;
  if (document.visibilityState !== 'visible') return;
  if (isInVoiceCallWith(forCharId)) return;

  const gen = ++_waitTypingGen;
  _waitTypingCharId = forCharId;
  const switches = 1 + Math.floor(Math.random() * 3);
  let done = 0;

  const holdOn = () => {
    if (gen !== _waitTypingGen) return;
    if (!shouldRenderForChar(forCharId) || document.visibilityState !== 'visible') {
      stopWaitTypingPulse(true);
      return;
    }
    showCharTypingFor(forCharId, true, kind);
    setWaitTypingDimmed(false);
    if (done >= switches) return;
    _waitTypingTimer = setTimeout(holdOff, 2600 + Math.random() * 2200);
  };
  const holdOff = () => {
    if (gen !== _waitTypingGen) return;
    showCharTypingFor(forCharId, false);
    setWaitTypingDimmed(false);
    done += 1;
    _waitTypingTimer = setTimeout(holdOn, 800 + Math.random() * 700);
  };
  holdOn();
}

function typingKindForMsg(msgOrType) {
  const t = msgOrType && typeof msgOrType === 'object'
    ? (msgOrType.type || 'text')
    : String(msgOrType || 'text');
  return t === 'voice' ? 'speaking' : 'typing';
}

function isEmojiBubble(msgOrText, isEmoji = false) {
  if (isEmoji) return true;
  return !!(msgOrText && typeof msgOrText === 'object' && msgOrText.type === 'emoji');
}

/** 用来估阅读/打字时长的可见字数（语音条用转写，图/视频当短句） */
function visibleBubbleLen(msgOrText, isEmoji = false) {
  if (isEmojiBubble(msgOrText, isEmoji)) return 0;
  if (msgOrText && typeof msgOrText === 'object') {
    const t = msgOrText.type || 'text';
    if (t === 'image' || t === 'video') return 14;
    if (t === 'location' || t === 'link' || t === 'web_card') return 10;
  }
  const raw = typeof msgOrText === 'string' ? msgOrText : String(msgOrText?.content || '');
  let len = raw.length;
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j?.vocal || (j?.sfx && !j.ambience)) len = 8;
      else if (j?.voice) len = Math.min(String(j.transcript || '').length || 16, 48);
    } catch { /* 按原文长度估 */ }
  }
  return len;
}

/** 后续气泡：打下一条之前的输入时长 */
function bubbleTypingMs(msgOrText, isEmoji = false) {
  if (isEmojiBubble(msgOrText, isEmoji)) return 320 + Math.random() * 200;
  const len = visibleBubbleLen(msgOrText, isEmoji);
  return Math.min(Math.max(420 + len * 20, 480), 1600) + Math.random() * 280;
}

/** 上一条已经出来：先停一下（不要挂着正在输入），再开始打下一条 */
function bubbleRestMs(msgOrText, isEmoji = false) {
  if (isEmojiBubble(msgOrText, isEmoji)) return 280 + Math.random() * 160;
  const len = visibleBubbleLen(msgOrText, isEmoji);
  return Math.min(Math.max(320 + len * 10, 360), 1200) + Math.random() * 180;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 上一条出来后先歇一下再打下一条；第一条不额外等（等模型时已经在输入） */
async function pauseBeforeAiBubble(forCharId, msgOrText, opts = {}) {
  if (!opts.afterVisible) stopWaitTypingPulse(true);
  if (opts.skip || !shouldRenderForChar(forCharId)) return;
  if (document.visibilityState !== 'visible') return;
  if (!opts.afterVisible) return;

  // 通话中：整轮气泡一次出齐，不要聊天式「一个一个蹦」
  if (isInVoiceCallWith(forCharId)) {
    showCharTypingFor(forCharId, false);
    return;
  }

  const kind = opts.kind || typingKindForMsg(opts.kindMsg || msgOrText);
  const typingSrc = opts.kindMsg || msgOrText;

  showCharTypingFor(forCharId, false);
  await sleepMs(bubbleRestMs(msgOrText, opts.isEmoji));
  if (!shouldRenderForChar(forCharId) || document.visibilityState !== 'visible') return;

  showCharTypingFor(forCharId, true, kind);
  await sleepMs(bubbleTypingMs(typingSrc, opts.isEmoji));
  showCharTypingFor(forCharId, false);
}

function aiMessagesIncludeImages(msgs) {
  return msgs?.some(m => m.type === 'image' || m.type === 'video');
}

function hasAiReplyPayload(result) {
  return !!(result?.content || result?.aiMessages?.length || result?.systemHints?.length
    || result?.selfieImgUrl || result?.generalImgUrl || result?.generalVideoUrl || result?.autoReply
    || result?.incomingCall || result?.isBusy || result?.robotLooking || result?.emptyReply);
}

function isEmptyAiReplyError(err) {
  return /返回内容为空|返回为空/.test(String(err?.message || err || ''));
}

function looksLikeDirectiveOnly(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const stripped = t
    .replace(/\*[^*\n]{1,120}\*/g, '')
    .replace(/[\[【［][^\]】］]{0,80}[\]】］]/g, '')
    .replace(/[（(][^）)]{1,60}[）)]/g, '')
    .replace(/[。．.\s]+/g, ' ')
    .trim();
  return !stripped;
}

function replyLooksEmpty(result) {
  if (!result || result.emptyReply) return true;
  if (result.incomingCall || result.autoReply) return false;
  if (result.systemHints?.length) return false;
  if (result.selfieImgUrl || result.generalImgUrl || result.generalVideoUrl) return false;
  const msgs = Array.isArray(result.aiMessages) ? result.aiMessages : [];
  const visibleMsg = msgs.some((m) => {
    if (!m) return false;
    const t = m.type || 'text';
    if (t !== 'text' && t !== 'voice') return true;
    return !looksLikeDirectiveOnly(m.content);
  });
  if (visibleMsg) return false;
  const raw = String(result.content || '').trim();
  if (!raw || looksLikeDirectiveOnly(raw)) return true;
  try {
    return !splitAiSegments(raw).some((s) => !looksLikeDirectiveOnly(s));
  } catch {
    return false;
  }
}

function shouldNudgeEmptyAiReply(result, { fromCall = false } = {}) {
  if (fromCall || isDream) return false;
  if (result?.robotInvoke || result?.isBusy) return false;
  return replyLooksEmpty(result);
}

async function maybeNudgeEmptyAiReply(forCharId) {
  if (isDream || !forCharId) return false;
  if (_emptyAiNudgeCount >= EMPTY_AI_NUDGE_MAX) {
    _emptyAiNudgeCount = 0;
    return false;
  }
  _emptyAiNudging = true;
  try {
    await new Promise((r) => setTimeout(r, 280));
    if (_doSendBusy) return false;
    _emptyAiNudgeCount += 1;
    await doSend(EMPTY_AI_NUDGE_TEXT, 'text', { hideChat: true }, false, forCharId);
    return true;
  } finally {
    _emptyAiNudging = false;
  }
}

async function triggerAiAndWaitTyping(forCharId, ...rest) {
  startWaitTypingPulse(forCharId);
  try {
    const result = await api.triggerAi(forCharId, ...rest);
    if (!hasAiReplyPayload(result)) stopWaitTypingPulse(true);
    return result;
  } catch (e) {
    stopWaitTypingPulse(true);
    throw e;
  }
}

/** trigger-ai 在入库后才报错时：把已保存的回复捞回来画气泡/播通话，避免通话页和聊天页都像没接上 */
async function recoverSavedAiReply(forCharId) {
  if (!forCharId) return false;
  try {
    const recent = await api.getMessages(forCharId, { dream: isDream ? 1 : 0, limit: 16, offset: 0 });
    const list = Array.isArray(recent) ? recent : [];
    if (!list.length) return false;
    let lastUser = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.role === 'user' && list[i]?.type !== 'system') {
        lastUser = i;
        break;
      }
    }
    const tail = lastUser >= 0 ? list.slice(lastUser + 1) : list.slice(-4);
    const fresh = tail.filter((m) => {
      if (m?.role !== 'assistant' || m.recalled) return false;
      if (isHiddenChatMessage(m)) return false;
      if (m.id != null && (hasSeenAiMsgId(m.id) || isAiMsgInDom(m.id) || wasCallSpeechPlayed(m.id))) return false;
      return true;
    });
    if (!fresh.length) return false;
    upsertThreadMessages(forCharId, isDream, fresh);
    await applyAiReplyResult({
      content: fresh.filter((m) => m.type === 'text' || m.type === 'voice').map((m) => m.content).join('\n'),
      aiMsgId: fresh[fresh.length - 1].id,
      aiMessages: fresh,
    }, new Date().toISOString(), forCharId);
    return true;
  } catch {
    return false;
  }
}

function updatePendingBadge() {
  const badge = document.getElementById('pending-ai-badge');
  if (!badge) return;
  if (_pendingAiCount > 0) {
    badge.textContent = _pendingAiCount;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
  document.getElementById('chat-composer')?.classList.toggle('has-pending-ai', _pendingAiCount > 0);
}
let _foldedMessages = [];
let _foldExpanded = false;
let _hasMoreOnServer = true;
let _chatLoadSeq = 0;
let _chatPageReloading = false;
let _chatListGesture = { startY: 0, moved: false };
let _chatScrollLock = null;
let _refreshChatScrollLock = () => {};
let _chatScrollAdjusting = 0;

function applyChatHeader(char) {
  if (!char) return;
  const nameEl = document.getElementById('chat-char-name');
  const avatarEl = document.getElementById('chat-avatar');
  const avatarPh = document.getElementById('chat-avatar-placeholder');
  const statusDot = document.getElementById('chat-status-dot');
  const statusText = document.getElementById('chat-char-status');

  const shown = String(char.display_name || char.remark || char.name || '').trim() || char.name;
  if (nameEl) nameEl.textContent = isDream ? `${shown} · 梦境` : shown;

  if (char.avatar) {
    if (avatarEl) {
      if (avatarEl.dataset.avatarSrc !== char.avatar) {
        const cacheBust = char.avatar + (char.avatar.includes('?') ? '&' : '?') + '_t=' + Date.now();
        avatarEl.src = cacheBust;
        avatarEl.dataset.avatarSrc = char.avatar;
      }
      avatarEl.style.display = 'block';
    }
    if (avatarPh) avatarPh.style.display = 'none';
  } else {
    if (avatarEl) {
      avatarEl.src = '';
      avatarEl.style.display = 'none';
      avatarEl.dataset.avatarSrc = '';
    }
    if (avatarPh) avatarPh.style.display = 'flex';
  }

  if (statusText && !statusText.classList.contains('typing')) {
    statusText.textContent = chatStatusLabel(char);
  }
  if (statusDot) {
    statusDot.className = chatStatusDotClass(char);
    statusDot.style.opacity = '';
  }
  syncCircleNpcChatToolbar(char);
  syncStrangerBar();
  void refreshChatDeviceLinks(char);
}

/** 圈子 NPC：工具栏只保留基础通讯能力 */
function syncCircleNpcChatToolbar(char) {
  const isNpc = !!(char?.is_circle_npc || char?.source === 'circle_npc' || Number(char?.circle_npc_id) > 0);
  const hideLabels = new Set([
    '话题', '记忆', '一起听歌', '共享屏幕', '语音通话', '视频通话', '总结记忆', '小剧场', '情绪',
  ]);
  document.querySelectorAll('#chat-toolbar .toolbar-item').forEach((btn) => {
    const label = btn.querySelector('.toolbar-label')?.textContent?.trim() || '';
    if (!label) return;
    if (isNpc && hideLabels.has(label)) btn.style.display = 'none';
    else btn.style.display = '';
  });
}

/** 顶栏设置左侧：当前角色连着 stackchan 亮方块机；bbtoy 连着亮贝壳（线条图标） */
let _chatLinkRefreshSeq = 0;
window.refreshChatDeviceLinks = async function(char = currentChar) {
  const scEl = document.getElementById('chat-link-sc');
  const bbEl = document.getElementById('chat-link-bbtoy');
  if (!scEl && !bbEl) return;
  const seq = ++_chatLinkRefreshSeq;
  const settings = window.getAppSettings?.() || {};
  const c = char || currentChar;
  const scOn = !!c?.id
    && String(settings.robot_enabled || '0') === '1'
    && String(settings.robot_character_id || '') === String(c.id)
    && isRobotDeviceOnline();
  if (scEl) {
    scEl.hidden = !scOn;
    scEl.classList.toggle('is-on', scOn);
  }

  let bbOn = false;
  if (isNativeShell?.() && String(settings.toy_enabled || '0') === '1') {
    try {
      const st = await toyStatus();
      if (seq !== _chatLinkRefreshSeq) return;
      bbOn = !!(st?.ready || st?.connected);
    } catch {
      bbOn = false;
    }
  }
  if (bbEl) {
    bbEl.hidden = !bbOn;
    bbEl.classList.toggle('is-on', bbOn);
  }
};

window.openToyFromChat = function(tab) {
  window._toyInitTab = tab === 'bbtoy' ? 'bbtoy' : 'stackchan';
  window.navigateTo?.('robot');
};

let _avatarTapTimer = null;
let _avatarLastTap = 0;

function setupChatAvatarTap() {
  const wrap = document.getElementById('chat-avatar-wrap');
  if (!wrap || wrap.dataset.tapBound === '1') return;
  wrap.dataset.tapBound = '1';
  wrap.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - _avatarLastTap < 380) {
      clearTimeout(_avatarTapTimer);
      _avatarLastTap = 0;
      if (charId && !isDream) window.pokeChat?.();
      return;
    }
    _avatarLastTap = now;
    _avatarTapTimer = setTimeout(() => {
      _avatarLastTap = 0;
      window.navigateTo?.('character');
    }, 380);
  });
}

let _selectMode = false;
const _selectedBubbleIds = new Set();
let _selectIgnoreUntil = 0;
let _goBackOrig = null;

function resolveBubbleId(el) {
  if (!el) return null;
  const id = el.dataset?.id || '';
  if (!id || String(id).startsWith('tmp_') || String(id).startsWith('seg_') || String(id).startsWith('vseg_')) return null;
  // 分段泡：用母消息 id（data-msg-id）
  if (String(id).startsWith('hist_')) {
    const mid = el.dataset?.msgId || String(id).split('_')[1];
    return mid && /^\d+$/.test(String(mid)) ? String(mid) : null;
  }
  return String(id);
}

function syncBusyBar() {
  const bar = document.getElementById('busy-bar');
  if (!bar || isDream) return;
  const show = isBusyBlocking();
  bar.style.display = show ? 'block' : 'none';
}

function syncStrangerBar() {
  const bar = document.getElementById('stranger-bar');
  if (!bar) return;
  if (isDream) {
    bar.style.display = 'none';
    return;
  }
  const status = currentChar?.contact_status || '';
  const show = status === 'stranger' || status === 'none' || status === 'deleted';
  bar.style.display = show ? 'flex' : 'none';
  const btn = document.getElementById('stranger-bar-add-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '添加好友';
  }
}

window.requestFriendFromChat = async function() {
  const id = Number(charId || currentChar?.id || 0);
  if (!id) return;
  const btn = document.getElementById('stranger-bar-add-btn');
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '已申请…';
    }
    const res = await api.createFriendRequest(id, '我想加你为好友');
    window.showToast?.(res?.already ? '已发过申请，等对方回应' : '已发送好友申请，等对方决定');
    if (btn) btn.textContent = '申请中';
  } catch (e) {
    window.showToast?.(e.message || '申请失败');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '添加好友';
    }
  }
};

function getBubbleTextForEdit(wrap) {
  if (!wrap) return '';
  const voiceTranscript = wrap.querySelector('.voice-transcript-inner');
  if (voiceTranscript?.textContent?.trim()) return voiceTranscript.textContent.trim();
  const voiceSrc = wrap.querySelector('.voice-text-src');
  if (voiceSrc?.textContent?.trim()) return voiceSrc.textContent.trim();
  const mainBubble = wrap.querySelector('.bubble-main .bubble:not(.recalled)')
    || wrap.querySelector('.bubble:not(.recalled):not(.voice-bubble)');
  return mainBubble?.textContent?.trim() || '';
}

function canEditBubbleWrap(wrap) {
  if (typeof window.canEditChatBubbleWrap === 'function') {
    return window.canEditChatBubbleWrap(wrap);
  }
  if (!wrap || wrap.dataset.role === 'system') return false;
  if (wrap.dataset.role !== 'user' && wrap.dataset.role !== 'assistant') return false;
  const bubbleId = wrap.dataset?.msgId || wrap.dataset?.id;
  if (!bubbleId || String(bubbleId).startsWith('tmp_') || String(bubbleId).startsWith('seg_') || String(bubbleId).startsWith('vseg_') || String(bubbleId).startsWith('hist_')) return false;
  return !!getBubbleTextForEdit(wrap);
}
window.canEditBubbleWrap = canEditBubbleWrap;

function updateChatSelectBar() {
  const bar = document.getElementById('chat-select-bar');
  const countEl = document.getElementById('chat-select-count');
  const delBtn = document.getElementById('chat-select-delete-btn');
  const editBtn = document.getElementById('chat-select-edit-btn');
  const n = _selectedBubbleIds.size;
  if (countEl) countEl.textContent = String(n);
  if (delBtn) delBtn.disabled = n === 0;
  if (editBtn) {
    let canEdit = false;
    if (n === 1) {
      const bubbleId = [..._selectedBubbleIds][0];
      const wrap = document.querySelector(`.bubble-wrap[data-id="${CSS.escape(String(bubbleId))}"]`);
      canEdit = canEditBubbleWrap(wrap);
    }
    editBtn.disabled = !canEdit;
  }
  if (bar) bar.style.display = _selectMode ? 'flex' : 'none';
}

function refreshSelectModeUi() {
  const list = document.getElementById('messages-list');
  if (!list) return;
  list.classList.toggle('chat-select-mode', _selectMode);
  list.querySelectorAll('.bubble-wrap[data-id]').forEach(wrap => {
    const bubbleId = resolveBubbleId(wrap);
    wrap.classList.toggle('is-selected', !!(bubbleId && _selectedBubbleIds.has(bubbleId)));
  });
  const inputArea = document.querySelector('#chat-page .chat-input-area');
  if (inputArea) inputArea.style.display = _selectMode ? 'none' : '';
  updateChatSelectBar();
}

window.enterChatSelectMode = function(preselectBubbleId = null) {
  if (!charId || isDream) return;
  closeAllBubbleSwipe();
  _selectMode = true;
  _selectIgnoreUntil = Date.now() + 520;
  window._selectIgnoreUntil = _selectIgnoreUntil;
  _selectedBubbleIds.clear();
  if (preselectBubbleId) {
    const id = String(preselectBubbleId);
    if (id && !id.startsWith('tmp_') && !id.startsWith('seg_') && !id.startsWith('vseg_') && !id.startsWith('hist_')) {
      _selectedBubbleIds.add(id);
    }
  }
  refreshSelectModeUi();
};

window.exitChatSelectMode = function() {
  _selectMode = false;
  _selectedBubbleIds.clear();
  if (_goBackOrig) {
    window.goBack = _goBackOrig;
    _goBackOrig = null;
  }
  refreshSelectModeUi();
};

window.consumeChatPageBack = function() {
  if (document.getElementById('chat-page')?.classList.contains('active') !== true) return false;
  if (document.getElementById('context-menu')?.classList.contains('active')) {
    window.hideContextMenu?.();
    return true;
  }
  if (_selectMode) {
    window.exitChatSelectMode?.();
    return true;
  }
  const emoji = document.getElementById('chat-emoji-panel');
  if (emoji && emoji.style.display && emoji.style.display !== 'none') {
    window.closeEmojiPanel?.();
    return true;
  }
  const toolbar = document.getElementById('chat-toolbar');
  if (toolbar?.classList.contains('is-open') && toolbar.style.display !== 'none') {
    window.setChatToolbarOpen?.(false);
    return true;
  }
  return false;
};

window.chatPageGoBack = function() {
  if (window.consumeChatPageBack?.()) return;
  window.goBack?.();
};

window.toggleChatMsgSelect = function(wrap) {
  if (!_selectMode || !wrap) return;
  const bubbleId = resolveBubbleId(wrap);
  if (!bubbleId) return;
  if (_selectedBubbleIds.has(bubbleId)) _selectedBubbleIds.delete(bubbleId);
  else _selectedBubbleIds.add(bubbleId);
  refreshSelectModeUi();
};

function removeChatBubbleEl(el) {
  if (!el) return;
  (el.closest?.('.bubble-swipe-row') || el).remove();
}

function removeBubblesFromDom(bubbleIds) {
  const idSet = new Set(bubbleIds.map(String));
  document.querySelectorAll('.bubble-wrap[data-id]').forEach(wrap => {
    if (!idSet.has(wrap.dataset.id)) return;
    removeChatBubbleEl(wrap);
  });
}

window.deleteSelectedChatMessages = async function() {
  const bubbles = [..._selectedBubbleIds];
  if (!bubbles.length) return;
  if (!confirm(`确定删除选中的 ${bubbles.length} 个气泡？`)) return;
  try {
    await api.deleteMessagesBatch(bubbles);
    removeBubblesFromDom(bubbles);
    const msgIds = bubbles
      .map((b) => String(b))
      .filter((b) => /^\d+$/.test(b));
    if (msgIds.length) removeThreadMessages(charId, isDream, msgIds);
    window.exitChatSelectMode?.();
    window.showToast?.(`已删除 ${bubbles.length} 个气泡`);
  } catch (e) {
    window.showToast?.('删除失败: ' + (e.message || '网络错误'));
  }
};

window.editSelectedChatMessage = async function() {
  if (_selectedBubbleIds.size !== 1) return;
  const bubbleId = [..._selectedBubbleIds][0];
  await window.editBubbleMsg?.(bubbleId);
};

window.editBubbleMsg = async function(bubbleId) {
  if (!bubbleId || isDream) {
    window.showToast?.('这条不能编辑');
    return;
  }
  const id = String(bubbleId);
  const wrap = document.querySelector(`.bubble-wrap[data-id="${id}"], .bubble-wrap[data-msg-id="${id}"]`);
  if (!wrap) {
    // chat-page 未接管时走页面内置编辑器
    window.openChatBubbleEditor?.(id);
    return;
  }
  const current = getBubbleTextForEdit(wrap);
  window.openChatBubbleEditor?.(wrap.dataset.msgId || wrap.dataset.id || id, current);
};

window.editBubbleMsgSave = async function(saveId, next, wrap) {
  await api.updateMessageBubble(saveId, next);
  const el = wrap || document.querySelector(`.bubble-wrap[data-id="${saveId}"], .bubble-wrap[data-msg-id="${saveId}"]`);
  const bubble = el?.querySelector('.bubble-main .bubble:not(.recalled)')
    || el?.querySelector('.bubble:not(.recalled):not(.voice-bubble)');
  const voiceInner = el?.querySelector('.voice-transcript-inner');
  if (voiceInner) voiceInner.textContent = next;
  else if (bubble) bubble.textContent = next;
  const voiceSrc = el?.querySelector('.voice-text-src');
  if (voiceSrc) voiceSrc.textContent = next;
  if (_selectMode) window.exitChatSelectMode?.();
};

window.editUserMsg = window.editBubbleMsg;
window.getBubbleTextForEdit = getBubbleTextForEdit;

function setupChatSelectMode() {
  const list = document.getElementById('messages-list');
  if (!list || list.dataset.selectBound === '1') return;
  list.dataset.selectBound = '1';
  list.addEventListener('click', (e) => {
    if (!_selectMode) return;
    if (Date.now() < _selectIgnoreUntil || Date.now() < (window._ctxIgnoreUntil || 0)) return;
    const wrap = e.target.closest('.bubble-wrap[data-id]');
    if (!wrap) return;
    e.preventDefault();
    e.stopPropagation();
    window.toggleChatMsgSelect?.(wrap);
  });
}

/** 切后台/切页时的误发送防护（输入法收起常误发孤零零的「。」）；手指点发送发标点不受影响 */
let _chatComposing = false;
let _chatImeGuardUntil = 0;
let _chatExplicitSendAt = 0;
let _chatValueOnFocus = '';

function isSpuriousUserText(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return isLikelyImeSpuriousText(t);
}

/** 从 seg_/vseg_ 临时 id 里解析母消息 id；解析不到则视为真正的中断残留 */
function parentIdFromTempBubbleId(dataId) {
  const s = String(dataId || '');
  // vseg_${msgId}_${ts}_${j} 或 seg_${msgId}_${j}
  let m = s.match(/^(?:vseg|seg)_(\d+)_/);
  if (m) return m[1];
  return null;
}

/**
 * 清掉「中断残留」的临时分段泡。
 * 注意：母消息末段已落 DOM 时，前面的 vseg_/seg_ 是正常分段，不能删——
 * 否则回前台 sync 会以为消息已在页上，不再重画，语音/文字分段就「突然消失」。
 */
function purgeInterruptedAiTempBubbles() {
  const list = document.getElementById('messages-list');
  if (!list) return;
  list.querySelectorAll('.bubble-wrap[data-id^="seg_"], .bubble-wrap[data-id^="vseg_"]').forEach(el => {
    const parentId = parentIdFromTempBubbleId(el.dataset.id);
    // 母消息已完整落盘：把临时 id 收成 hist_，与历史重绘一致，避免下次再被误清
    if (parentId && isAiMsgInDom(parentId)) {
      const parts = String(el.dataset.id || '').split('_');
      const idx = parts[parts.length - 1];
      if (/^\d+$/.test(idx)) {
        el.dataset.id = `hist_${parentId}_${idx}`;
        if (!el.dataset.msgId || String(el.dataset.msgId).startsWith('seg_') || String(el.dataset.msgId).startsWith('vseg_')) {
          el.dataset.msgId = parentId;
        }
      }
      return;
    }
    removeChatBubbleEl(el);
  });
}

function armChatImeGuard(ms = 450) {
  _chatImeGuardUntil = Math.max(_chatImeGuardUntil, Date.now() + ms);
}

function markExplicitChatSend() {
  _chatExplicitSendAt = Date.now();
}

function wasExplicitChatSend(ms = 1200) {
  return Date.now() - _chatExplicitSendAt < ms;
}

function isChatPageDomActive() {
  return document.getElementById('chat-page')?.classList.contains('active') === true;
}

function isChatImeGuarded() {
  if (_chatComposing) return true;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return true;
  if (!isChatPageDomActive()) return true;
  return Date.now() < _chatImeGuardUntil;
}

/** 切后台/切页时输入法误提交的孤立标点 */
function isLikelyImeSpuriousText(text) {
  return /^[.。．…⋯、,，!！?？~～·•]+$/.test(String(text || '').trim());
}

function clearSpuriousChatInput() {
  const input = document.getElementById('chat-input');
  if (!input || !isLikelyImeSpuriousText(input.value)) return;
  input.value = '';
  autoResize?.(input);
}

/** 失焦后输入法才塞进来的句号：整框只有标点时清掉；防护窗内也清 */
function stripImePunctIfDraftWasEmpty() {
  if (wasExplicitChatSend()) return;
  const input = document.getElementById('chat-input');
  if (!input || document.activeElement === input) return;
  if (!isLikelyImeSpuriousText(input.value)) return;
  const onFocus = String(_chatValueOnFocus || '').trim();
  if (!onFocus || isLikelyImeSpuriousText(onFocus) || isChatImeGuarded()) {
    clearSpuriousChatInput();
  }
}

function shouldBlockImeSpuriousSend(text, input) {
  if (!isLikelyImeSpuriousText(text)) return false;
  if (wasExplicitChatSend()) return false;
  // 仅在切屏/离页防护窗内，或输入框未聚焦时拦截（延迟 IME 回车）
  if (isChatImeGuarded()) return true;
  if (input && document.activeElement !== input) return true;
  return false;
}

/** 离开聊天页：收起键盘并清掉输入法刚塞进来的句号，避免隐藏的输入框被延迟回车发出去 */
window.flushChatComposerOnLeave = function() {
  stopWaitTypingPulse(true);
  armChatImeGuard(3000);
  stripImePunctIfDraftWasEmpty();
  const input = document.getElementById('chat-input');
  try { input?.blur(); } catch {}
};

function onChatOutsidePointer(e) {
  const input = document.getElementById('chat-input');
  if (!input || document.activeElement !== input) return;
  if (e.target === input) return;
  const area = input.closest('.chat-input-area');
  if (area?.contains(e.target)) return;
  // 点底栏/其它页时先开防护，赶在输入法延迟 Enter 之前
  armChatImeGuard(2000);
}

function setupChatImeGuards() {
  if (window.__nianChatImeGuardsBound) return;
  window.__nianChatImeGuardsBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      armChatImeGuard(5000);
      stripImePunctIfDraftWasEmpty();
      const input = document.getElementById('chat-input');
      if (input && document.activeElement === input) {
        try { input.blur(); } catch {}
      }
    } else {
      armChatImeGuard(800);
    }
  });
  document.addEventListener('pagehide', () => {
    armChatImeGuard(3000);
    window.flushChatComposerOnLeave?.();
  });
  window.addEventListener('nian-keyboard-hide', () => {
    armChatImeGuard(2800);
    setTimeout(stripImePunctIfDraftWasEmpty, 40);
    setTimeout(stripImePunctIfDraftWasEmpty, 240);
  });
  try {
    window.Capacitor?.Plugins?.App?.addListener?.('appStateChange', ({ isActive }) => {
      if (isActive) {
        armChatImeGuard(800);
        return;
      }
      armChatImeGuard(3000);
      stripImePunctIfDraftWasEmpty();
      try { document.getElementById('chat-input')?.blur(); } catch {}
    });
  } catch {}
  document.addEventListener('pointerdown', onChatOutsidePointer, true);
  document.addEventListener('touchstart', onChatOutsidePointer, { capture: true, passive: true });
  const sendWrap = document.getElementById('chat-send-btn-wrap');
  sendWrap?.addEventListener('pointerdown', markExplicitChatSend, true);
  sendWrap?.addEventListener('touchstart', markExplicitChatSend, { capture: true, passive: true });
  document.querySelector('.call-send-btn')?.addEventListener('pointerdown', markExplicitChatSend, true);
  document.querySelector('.call-send-btn')?.addEventListener('touchstart', markExplicitChatSend, { capture: true, passive: true });
}

let _chatFgSyncSeq = 0;

/** 从后台回到聊天页：补上切走期间已经入库、但当前页没画出来的角色回复 */
async function syncOpenChatFromServer() {
  if (!charId) return;
  if (_chatPageReloading) return;
  if (!shouldRenderForChar(charId)) return;
  purgeInterruptedAiTempBubbles();
  const seq = ++_chatFgSyncSeq;
  const viewingId = charId;
  const dreamFlag = isDream ? 1 : 0;
  try {
    const list = document.getElementById('messages-list');
    if (!list) return;
    repairOutOfOrderMessageList();
    // 只按 DOM 水位拉更新；漏画的新消息靠 sinceId / recent 补，不要把整本缓存旧消息倒到末尾
    const sinceId = getListLatestMsgId(list);

    const msgs = sinceId > 0
      ? await api.getMessages(viewingId, { dream: dreamFlag, sinceId, limit: 80 })
      : await api.getMessages(viewingId, { dream: dreamFlag, limit: 50, offset: 0 });
    if (seq !== _chatFgSyncSeq || Number(charId) !== Number(viewingId)) return;
    if (!shouldRenderForChar(viewingId)) return;

    const domMax = getListLatestMsgId(list);
    const missing = (Array.isArray(msgs) ? msgs : []).filter(m => {
      if (m?.id == null || m.id === '') return false;
      if (isAiMsgInDom(m.id)) return false;
      if (domMax > 0 && !(Number(m.id) > domMax)) return false;
      return true;
    }).sort((a, b) => Number(a.id) - Number(b.id));

    if (!missing.length) {
      const last = msgs?.[msgs.length - 1];
      if (last?.role === 'assistant') showCharTyping(false);
    } else {
      rememberAiMsgIds(missing.map(m => m.id));
      upsertThreadMessages(viewingId, dreamFlag, missing);
      const area = document.getElementById('messages-area');
      const nearBottom = area
        ? (area.scrollHeight - area.scrollTop - area.clientHeight < 120)
        : true;
      // 动画中途被打断时可能已有 hist_/旧 vseg_ 半截，先清再整条重画
      removeBubblesByMessageIds(missing.map(m => m.id));
      list.insertAdjacentHTML('beforeend', buildMessagesHtml(missing));
      attachRecalledMeta(missing);
      restoreVoiceTranscripts();
      hydrateLocationCardMaps(list);
      hydrateWebCards(list);
      hydrateMusicCards(missing);
      showCharTyping(false);
      if (nearBottom) jumpMessagesToBottom();
    }

    // 同 id 占位→成图不会出现在 sinceId 增量里，有 pending 时再拉最近消息补刷
    const hasPendingMedia = !!list.querySelector(
      '[data-pending-video], [data-pending-selfie], [data-failed-video], [data-failed-selfie], .bubble-media-pending, .bubble-media-failed'
    );
    if (hasPendingMedia) {
      const recent = await api.getMessages(viewingId, { dream: dreamFlag, limit: 200, offset: 0 });
      if (seq !== _chatFgSyncSeq || Number(charId) !== Number(viewingId)) return;
      if (Array.isArray(recent) && recent.length) {
        reconcileDeletedMessagesFromServer(recent, viewingId);
        upsertThreadMessages(viewingId, dreamFlag, recent);
        patchMediaBubblesFromMessages(recent);
      }
    }
  } catch (e) {
    console.warn('[chat] foreground sync', e.message);
  }
}

function setupChatForegroundSync() {
  if (window.__nianChatFgSyncBound) return;
  window.__nianChatFgSyncBound = true;
  const onForeground = () => {
    if (document.visibilityState === 'hidden') return;
    window.ensureWsConnected?.();
    void reconcileOrphanNativeCall();
    if (!document.getElementById('chat-page')?.classList.contains('active')) return;
    syncOpenChatFromServer();
    // 回复可能刚入库，再补一次，避免切回来太早还没拉到
    setTimeout(() => {
      if (document.visibilityState === 'visible') syncOpenChatFromServer();
    }, 1800);
  };
  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('pageshow', onForeground);
  window.addEventListener('focus', onForeground);
  try {
    window.Capacitor?.Plugins?.App?.addListener?.('appStateChange', ({ isActive }) => {
      if (isActive) onForeground();
    });
  } catch {}
  
  // 监听音乐同步AI评论事件
  window.addEventListener('musicSyncComment', (e) => {
    const { characterId, message } = e.detail || {};
    if (Number(characterId) === Number(charId) && message) {
      // 刷新聊天消息列表以显示AI的新评论
      syncOpenChatFromServer();
    }
  });
}

function setupChatInputCollapse() {
  const input = document.getElementById('chat-input');
  if (!input || input.dataset.collapseBound === '1') return;
  input.dataset.collapseBound = '1';
  const collapsePanels = () => {
    setChatToolbarOpen(false);
    window.closeEmojiPanel?.();
  };
  // 单行/未溢出时上滑会连锁滚外层，看起来像把输入栏「拽」起来
  let touchStartY = 0;
  input.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  input.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - touchStartY;
    const canScroll = input.scrollHeight > input.clientHeight + 1;
    if (!canScroll) {
      e.preventDefault();
      return;
    }
    const atTop = input.scrollTop <= 0;
    const atBottom = input.scrollTop + input.clientHeight >= input.scrollHeight - 1;
    if ((dy > 0 && atTop) || (dy < 0 && atBottom)) e.preventDefault();
  }, { passive: false });
  input.addEventListener('focus', () => {
    _chatValueOnFocus = input.value;
    jumpMessagesToBottom();
    collapsePanels();
  });
  input.addEventListener('click', collapsePanels);
  input.addEventListener('compositionstart', () => { _chatComposing = true; });
  // 合成结束不设防护窗：否则刚用输入法打出「。」「！」会被当成误触拦掉
  input.addEventListener('compositionend', () => {
    _chatComposing = false;
    if (document.activeElement !== input) stripImePunctIfDraftWasEmpty();
  });
  input.addEventListener('input', () => {
    if (document.activeElement !== input) stripImePunctIfDraftWasEmpty();
  });
  input.addEventListener('blur', () => {
    // 切屏/收键盘往往先 blur，visibilitychange 来不及；先开防护挡住延迟回车和误点发送
    armChatImeGuard(2800);
    stripImePunctIfDraftWasEmpty();
    setTimeout(stripImePunctIfDraftWasEmpty, 50);
    setTimeout(stripImePunctIfDraftWasEmpty, 220);
    setTimeout(stripImePunctIfDraftWasEmpty, 600);
  });
  setupChatImeGuards();
}

const BUBBLE_SWIPE_OPEN_PX = 76;

function setBubbleSwipeX(track, x, animate) {
  if (!track) return;
  track.style.transition = animate ? '' : 'none';
  track.style.transform = x ? `translateX(${x}px)` : '';
}

function closeAllBubbleSwipe(exceptRow = null) {
  document.querySelectorAll('#messages-list .bubble-swipe-row.is-open').forEach((row) => {
    if (row === exceptRow) return;
    row.classList.remove('is-open');
    setBubbleSwipeX(row.querySelector('.bubble-swipe-track'), 0, true);
  });
}

function openBubbleSwipe(row) {
  closeAllBubbleSwipe(row);
  row.classList.add('is-open');
  setBubbleSwipeX(row.querySelector('.bubble-swipe-track'), -BUBBLE_SWIPE_OPEN_PX, true);
}

function closeBubbleSwipe(row) {
  if (!row) return;
  row.classList.remove('is-open');
  setBubbleSwipeX(row.querySelector('.bubble-swipe-track'), 0, true);
}

function setupChatBubbleSwipe() {
  const list = document.getElementById('messages-list');
  if (!list || list.dataset.bubbleSwipeBound === '1') return;
  list.dataset.bubbleSwipeBound = '1';

  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let axis = null;
  let swiped = false;
  let swipeIgnoreUntil = 0;
  let row = null;
  let track = null;

  const isOpen = () => !!row?.classList.contains('is-open');
  const swallowSoon = () => { swipeIgnoreUntil = Date.now() + 420; };
  const onStart = (x, y, target) => {
    if (_selectMode) return;
    if (document.getElementById('context-menu')?.classList.contains('active')) return;
    if (target?.closest?.('.bubble-swipe-del')) return;
    const next = target?.closest?.('.bubble-swipe-row');
    if (!next || !list.contains(next)) return;
    const wrap = next.querySelector('.bubble-wrap[data-id]');
    const id = String(wrap?.dataset?.id || '');
    if (!id || id.startsWith('tmp') || id.startsWith('seg_') || id.startsWith('vseg_')) return;
    if (row && row !== next) closeBubbleSwipe(row);
    row = next;
    track = next.querySelector('.bubble-swipe-track');
    if (!track) return;
    startX = x;
    startY = y;
    dx = isOpen() ? -BUBBLE_SWIPE_OPEN_PX : 0;
    tracking = true;
    axis = null;
    swiped = false;
    track.style.transition = 'none';
  };
  const onMove = (x, y, ev) => {
    if (!tracking || !track) return;
    const adx = x - startX;
    const ady = y - startY;
    if (!axis) {
      if (Math.abs(adx) < 8 && Math.abs(ady) < 8) return;
      axis = Math.abs(adx) > Math.abs(ady) ? 'x' : 'y';
      if (axis === 'y') {
        tracking = false;
        setBubbleSwipeX(track, isOpen() ? -BUBBLE_SWIPE_OPEN_PX : 0, true);
        return;
      }
    }
    if (axis !== 'x') return;
    ev.preventDefault?.();
    swiped = true;
    const base = isOpen() ? -BUBBLE_SWIPE_OPEN_PX : 0;
    dx = Math.min(0, Math.max(-BUBBLE_SWIPE_OPEN_PX - 16, base + adx));
    setBubbleSwipeX(track, dx, false);
  };
  const onEnd = () => {
    if (!tracking) {
      axis = null;
      return;
    }
    const didSwipe = axis === 'x' && swiped;
    tracking = false;
    if (axis === 'x' && dx < -BUBBLE_SWIPE_OPEN_PX * 0.4) openBubbleSwipe(row);
    else closeBubbleSwipe(row);
    axis = null;
    if (didSwipe) swallowSoon();
  };

  list.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.changedTouches[0];
    if (t) onStart(t.clientX, t.clientY, e.target);
  }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    const t = e.changedTouches[0];
    if (t) onMove(t.clientX, t.clientY, e);
  }, { passive: false });
  list.addEventListener('touchend', onEnd);
  list.addEventListener('touchcancel', onEnd);

  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    onStart(e.clientX, e.clientY, e.target);
    if (!tracking) return;
    try { list.setPointerCapture(e.pointerId); } catch {}
  });
  list.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (!(e.buttons & 1) && e.pointerType === 'mouse') return;
    onMove(e.clientX, e.clientY, e);
  });
  list.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') return;
    onEnd();
  });
  list.addEventListener('pointercancel', (e) => {
    if (e.pointerType === 'touch') return;
    onEnd();
  });

  list.addEventListener('click', (e) => {
    if (_selectMode) return;
    const btn = e.target.closest?.('.bubble-swipe-del');
    if (btn && list.contains(btn)) {
      e.preventDefault();
      e.stopPropagation();
      const wrap = btn.closest('.bubble-swipe-row')?.querySelector('.bubble-wrap[data-id]');
      const id = wrap?.dataset?.id;
      if (id) window.deleteMsg?.(id, { confirm: false });
      return;
    }
    if (swiped || Date.now() < swipeIgnoreUntil) {
      e.preventDefault();
      e.stopPropagation();
      swiped = false;
      return;
    }
    if (list.querySelector('.bubble-swipe-row.is-open')) {
      e.preventDefault();
      e.stopPropagation();
      closeAllBubbleSwipe();
    }
  }, true);

  const area = document.getElementById('messages-area');
  if (area && area.dataset.bubbleSwipeScroll !== '1') {
    area.dataset.bubbleSwipeScroll = '1';
    area.addEventListener('scroll', () => {
      if (tracking) return;
      closeAllBubbleSwipe();
    }, { passive: true });
  }
}

function setupChatLongPress() {
  const list = document.getElementById('messages-list');
  if (!list || list.dataset.longPressBound === '1') return;
  list.dataset.longPressBound = '1';
  let timer = null;
  let armTimer = null;
  let startX = 0;
  let startY = 0;
  let menuOpened = false;
  let pressWrap = null;
  let pressEl = null;
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
  };
  const clearHoldVisual = (keepArmed = false) => {
    pressEl?.classList.remove('is-holding', 'is-holding-deep');
    pressWrap?.classList.remove('is-holding', 'is-holding-deep');
    if (!keepArmed) {
      pressEl?.classList.remove('is-ctx-armed');
      pressWrap?.classList.remove('is-ctx-armed');
    }
  };
  list.addEventListener('click', (e) => {
    if (_selectMode) return;
    const strip = e.target.closest?.('.bubble-reply-under');
    if (!strip || !list.contains(strip)) return;
    if (Date.now() < (window._ctxIgnoreUntil || 0)) return;
    if (chatListGestureShouldIgnoreTap()) return;
    const id = strip.dataset.replyTo;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    window.jumpToChatMessage?.(id);
  });
  list.addEventListener('touchstart', (e) => {
    if (_selectMode) return;
    if (e.touches.length !== 1) return;
    const wrap = e.target.closest('.bubble-wrap[data-id]');
    if (!wrap) return;
    menuOpened = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    pressWrap = wrap;
    pressEl = e.target.closest('.bubble-reply-under') || wrap;
    pressEl.classList.add('is-holding');
    clearTimer();
    armTimer = setTimeout(() => {
      armTimer = null;
      pressEl?.classList.add('is-holding-deep');
      window.nianHaptic?.('tick');
    }, 170);
    timer = setTimeout(() => {
      timer = null;
      menuOpened = true;
      pressEl?.classList.remove('is-holding', 'is-holding-deep');
      window.nianHaptic?.('press');
      window.showContextMenu?.({
        preventDefault() {},
        stopPropagation() {},
        clientX: startX,
        clientY: startY,
        currentTarget: wrap,
        target: e.target,
      });
    }, 480);
  }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    if (!timer && !armTimer) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.hypot(dx, dy) > 12) {
      clearTimer();
      clearHoldVisual();
    }
  }, { passive: true });
  list.addEventListener('touchend', (e) => {
    if (menuOpened) {
      e.preventDefault();
      e.stopPropagation();
      menuOpened = false;
      clearHoldVisual(true);
    } else {
      clearHoldVisual();
    }
    clearTimer();
  }, { passive: false });
  list.addEventListener('touchcancel', () => {
    menuOpened = false;
    clearHoldVisual();
    clearTimer();
  }, { passive: true });
}

window.initChatPage = async function() {
  const thisCharId = window.getActiveCharId?.();
  charId = thisCharId;
  window.getChatPageViewCharId = () => charId;
  if (charId) window.dismissChatNotificationsFor?.(charId);
  isDream = false;
  _emojiCatsCache = null;
  _emojiFetchPromise = null;
  refreshEmojiCatsInBackground();
  _pendingAiCount = 0;
  clearPendingUserMsgs();
  updatePendingBadge();
  window.exitChatSelectMode?.();
  const loadId = ++_chatLoadSeq;

  stopWaitTypingPulse(true);
  showCharTyping(false);
  setupChatAvatarTap();
  setupChatLongPress();
  setupChatBubbleSwipe();
  setupChatSelectMode();
  setupChatInputCollapse();
  setupChatForegroundSync();
  setupChatScrollStability();
  ensureVoiceHoldBound('chat-hold-talk');
  setChatVoiceMode(false);
  resetVoiceRecordingState();
  
  // 初始化音乐同步功能
  initMusicSync();

  bindGameButler({
    getCharId: () => charId,
    getChar: () => currentChar,
    getUserName: () => window.getAppSettings?.()?.username || '你',
    isDream: () => isDream,
    showTyping: (on) => { if (charId) showCharTypingFor(charId, on); },
    showUserMessage: async (text, type = 'text', mediaUrl = null) => {
      const list = document.getElementById('messages-list');
      const now = new Date().toISOString();
      const tmpId = 'tmp_' + Date.now();
      const content = type === 'image' ? mediaUrl : text;
      const userBubble = buildBubble({
        id: tmpId, dbId: tmpId, role: 'user',
        content, type, timestamp: now,
      }, currentChar, {});
      list?.insertAdjacentHTML('beforeend', userBubble);
      jumpMessagesToBottom();
      try {
        const saved = await persistUserMessage(content, type, {}, null, charId);
        bindSavedUserMsgId(tmpId, saved.userMsgId);
      } catch {
        window.showToast?.('消息保存失败');
      }
    },
    displaySystem: (text) => {
      const list = document.getElementById('messages-list');
      list?.insertAdjacentHTML('beforeend', buildBubble({
        id: 'sys_' + Date.now(), role: 'user', content: text, type: 'system', timestamp: new Date().toISOString(),
      }, currentChar, {}));
      scrollBottom(true);
    },
    appendSystem: async (text) => {
      const list = document.getElementById('messages-list');
      list?.insertAdjacentHTML('beforeend', buildBubble({
        id: 'sys_' + Date.now(), role: 'user', content: text, type: 'system', timestamp: new Date().toISOString(),
      }, currentChar, {}));
      scrollBottom(true);
      try {
        await api.sendMessage({ characterId: charId, content: text, type: 'system', noReply: true, isDream });
      } catch {}
    },
    displayCharText: async (text) => {
      await appendAiBubble({ id: 'gb_' + Date.now(), type: 'text', content: text }, new Date().toISOString(), charId);
    },
    displayCharImage: async (url) => {
      await appendAiBubble({ id: 'gbimg_' + Date.now(), type: 'image', content: url }, new Date().toISOString(), charId);
    },
    displayHiddenButler: (question, answer) => {
      const list = document.getElementById('messages-list');
      const id = 'sealed_' + Date.now();
      list?.insertAdjacentHTML('beforeend', `
        <div class="game-butler-sealed" data-sealed-id="${id}">
          <div><span class="game-butler-sealed-icon">🔒</span>游戏助手已作答 · 局结束后公布</div>
          <div class="game-butler-sealed-q">问：${escapeHtml(question)}</div>
        </div>`);
      scrollBottom(true);
    },
    appendCharText: async (text) => {
      await appendAiBubble({ id: 'gb_' + Date.now(), type: 'text', content: text }, new Date().toISOString(), charId);
    },
    appendCharImage: async (url) => {
      await appendAiBubble({ id: 'gbimg_' + Date.now(), type: 'image', content: url }, new Date().toISOString(), charId);
    },
  });
  initGameButlerUI();

  // 切换角色时先隐藏忙碌条，加载完成后再同步
  const busyBar = document.getElementById('busy-bar');
  if (busyBar) busyBar.style.display = 'none';
  setTheaterBarVisible(false);
  syncOperatingBar();

  if (!charId) {
    _chatPageReloading = false;
    // 没有角色时，引导去创建
    const page = document.getElementById('chat-page');
    const list = document.getElementById('messages-list');
    if (list) list.innerHTML = `
      <div class="empty-state" style="padding:60px 24px;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">🌸</div>
        <div style="font-size:16px;color:var(--text-secondary);margin-bottom:20px;line-height:1.7">
          还没有创建角色<br>先去创建一个TA吧
        </div>
        <button class="btn btn-primary" onclick="window.createCharFromContacts?.()">去创建角色</button>
      </div>
    `;
    const nameEl = document.getElementById('chat-char-name');
    if (nameEl) nameEl.textContent = '通讯';
    const avatarEl = document.getElementById('chat-avatar');
    if (avatarEl) { avatarEl.src = ''; avatarEl.style.display = 'none'; avatarEl.dataset.avatarSrc = ''; }
    document.getElementById('chat-avatar-placeholder')?.style.setProperty('display', 'flex');
    return;
  }

  // 每次进聊天都先清掉上一会话的气泡，避免串到别人的记录/壁纸页
  {
    const list = document.getElementById('messages-list');
    if (list) list.innerHTML = '';
    document.getElementById('stranger-bar')?.style.setProperty('display', 'none');
  }
  const prevId = currentChar?.id != null ? Number(currentChar.id) : null;
  if (prevId !== Number(charId)) {
    currentChar = null;
    const nameEl = document.getElementById('chat-char-name');
    if (nameEl) nameEl.textContent = '…';
    const avatarEl = document.getElementById('chat-avatar');
    if (avatarEl) { avatarEl.src = ''; avatarEl.style.display = 'none'; avatarEl.dataset.avatarSrc = ''; }
    document.getElementById('chat-avatar-placeholder')?.style.setProperty('display', 'flex');
  }

  // 先用本地缓存渲染顶栏，避免切换角色时短暂显示上一个头像
  const cachedChar = window.getAppCharacters?.().find(c => Number(c.id) === Number(charId));
  if (cachedChar) {
    currentChar = { ...cachedChar };
    applyChatHeader(currentChar);
    syncBusyBar();
    syncOperatingBar();
  } else {
    // 新摇到的角色可能还不在缓存里：用占位，等 getCharacter 回来再刷
    currentChar = { id: charId, name: '新朋友', contact_status: 'stranger' };
    applyChatHeader(currentChar);
  }

  _chatPageReloading = true;
  _chatFgSyncSeq++;
  offset = 0;
  _foldedMessages = [];
  _foldExpanded = false;

  pendingMsgs = getPendingMessages(charId);
  updatePendingUI();
  setupToolbarPages();
  applyBgSettings();
  applyBubbleStyle();
  // 用户点击聊天区后解除浏览器自动播放限制，便于语音条播放
  const chatPage = document.getElementById('chat-page');
  if (chatPage && !chatPage.dataset.audioUnlocked) {
    chatPage.dataset.audioUnlocked = '1';
    const unlockOnce = () => { unlockAudioPlayback(); chatPage.removeEventListener('pointerdown', unlockOnce); };
    chatPage.addEventListener('pointerdown', unlockOnce, { passive: true });
  }
  // 进入聊天：清除该角色的未读计数
  window.clearUnread?.(charId);

  const localThread = await paintLocalThreadFirst(loadId, thisCharId);
  if (loadId !== _chatLoadSeq || charId !== thisCharId) return;
  if (!shouldRenderForChar(thisCharId)) return;
  _chatPageReloading = false;
  void refreshOpenChatFromServer(loadId, thisCharId, !!localThread?.messages?.length);
};

async function refreshOpenChatFromServer(loadId, thisCharId, hadLocal) {
  if (!shouldRenderForChar(thisCharId)) return;
  try {
    currentChar = await api.getCharacter(thisCharId);
    if (loadId !== _chatLoadSeq || charId !== thisCharId) return;
    if (!shouldRenderForChar(thisCharId)) return;
    const appChars = window.getAppCharacters?.();
    const idx = appChars?.findIndex(c => Number(c.id) === Number(thisCharId));
    if (idx >= 0) appChars[idx] = { ...appChars[idx], ...currentChar };
    else if (Array.isArray(appChars) && currentChar) appChars.unshift(currentChar);
    window.renderHomeChar?.();
    applyChatHeader(currentChar);
    syncBusyBar();
    restoreGameTopicBarIfNeeded();
    restoreGameButlerBar(thisCharId);
    restoreTheaterBar();
    syncOperatingBar();
    if (hadLocal) {
      await syncNewMessages(loadId);
      revealMessagesAtBottom();
      await maybeFirstGreet();
    } else {
      // IDB 可能刚读完：再试一次本地，避免清空后重拉整窗
      const late = getThreadCacheSync(thisCharId, isDream) || await getThreadCache(thisCharId, isDream);
      if (loadId !== _chatLoadSeq || charId !== thisCharId) return;
      if (!shouldRenderForChar(thisCharId)) return;
      if (late?.messages?.length) {
        paintThreadFromCache(late);
        await syncNewMessages(loadId);
        revealMessagesAtBottom();
        await maybeFirstGreet();
      } else {
        await loadMessages(true);
        await maybeFirstGreet();
      }
    }
  } catch (e) {
    if (loadId !== _chatLoadSeq) return;
    showChatLoadError(e.message);
    window.showToast?.('加载失败: ' + e.message);
  }
}

window.initDreamChatPage = async function(cid) {
  charId = cid || window.getActiveCharId?.();
  isDream = true;
  const thisCharId = charId;
  const loadId = ++_chatLoadSeq;
  stopWaitTypingPulse(true);
  showCharTyping(false);
  setupChatAvatarTap();
  setupChatScrollStability();
  const cachedChar = window.getAppCharacters?.().find(c => Number(c.id) === Number(charId));
  if (cachedChar) {
    currentChar = { ...cachedChar };
    applyChatHeader(currentChar);
  }
  _chatPageReloading = true;
  _chatFgSyncSeq++;
  const localThread = await paintLocalThreadFirst(loadId, thisCharId);
  if (loadId !== _chatLoadSeq || charId !== thisCharId) return;
  try {
    currentChar = await api.getCharacter(charId);
    if (loadId !== _chatLoadSeq || charId !== thisCharId) return;
    applyChatHeader(currentChar);
    if (localThread?.messages?.length) {
      await syncNewMessages(loadId);
      revealMessagesAtBottom();
      _chatPageReloading = false;
    } else {
      document.getElementById('messages-list').innerHTML = '';
      await loadMessages(true);
    }
  } catch (e) {
    showChatLoadError(e.message);
  } finally {
    if (loadId === _chatLoadSeq) _chatPageReloading = false;
  }
};

function renderChatHeader() {
  applyChatHeader(currentChar);
}

function withInstantAreaScroll(area, fn) {
  if (!area) return fn();
  area.style.scrollBehavior = 'auto';
  try {
    return fn();
  } finally {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (area.style.scrollBehavior === 'auto') area.style.removeProperty('scroll-behavior');
      });
    });
  }
}

function isMessagesNearBottom(px = 160) {
  const area = document.getElementById('messages-area');
  if (!area) return true;
  return area.scrollHeight - area.scrollTop - area.clientHeight < px;
}

function chatListGestureShouldIgnoreTap() {
  return !!_chatListGesture.moved;
}

function captureMessageScrollAnchor(area, list) {
  if (!area || !list) return null;
  const areaRect = area.getBoundingClientRect();
  const nodes = list.querySelectorAll(
    '.bubble-wrap[data-msg-id], .bubble-wrap[data-id], .recall-hint[data-msg-id], .poke-hint[data-msg-id]'
  );
  for (const el of nodes) {
    const id = el.dataset.msgId || el.dataset.id;
    if (!id) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > areaRect.top + 4) {
      return { id: String(id), offset: r.top - areaRect.top };
    }
  }
  return { scrollTop: area.scrollTop };
}

function restoreMessageScrollAnchor(area, list, anchor) {
  if (!area || !anchor) return;
  const apply = () => {
    withInstantAreaScroll(area, () => {
      if (anchor.id && list) {
        const esc = cssAttrEscape(anchor.id);
        const el = list.querySelector(
          `.bubble-wrap[data-msg-id="${esc}"], .bubble-wrap[data-id="${esc}"], ` +
          `.recall-hint[data-msg-id="${esc}"], .poke-hint[data-msg-id="${esc}"]`
        );
        if (el) {
          const areaRect = area.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          area.scrollTop += (r.top - areaRect.top) - (anchor.offset || 0);
          return;
        }
      }
      if (Number.isFinite(anchor.scrollTop)) area.scrollTop = anchor.scrollTop;
    });
  };
  apply();
  requestAnimationFrame(apply);
}

function keepScrollAfterPrepend(area, prevHeight, prevTop) {
  if (!area) return;
  const apply = () => {
    withInstantAreaScroll(area, () => {
      area.scrollTop = prevTop + (area.scrollHeight - prevHeight);
    });
  };
  apply();
  requestAnimationFrame(apply);
}

function beginChatScrollAdjust() {
  _chatScrollAdjusting++;
}

function endChatScrollAdjust() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _chatScrollAdjusting = Math.max(0, _chatScrollAdjusting - 1);
      _refreshChatScrollLock();
    });
  });
}

function repairOutOfOrderMessageList() {
  const list = document.getElementById('messages-list');
  if (!list || !isMessageListOutOfOrder(list)) return false;
  const cached = getThreadCacheSync(charId, isDream);
  if (!cached?.messages?.length) return false;
  const area = document.getElementById('messages-area');
  const nearBottom = isMessagesNearBottom(160);
  const anchor = nearBottom ? null : captureMessageScrollAnchor(area, list);
  beginChatScrollAdjust();
  paintThreadFromCache(cached);
  if (nearBottom) revealMessagesAtBottom();
  else restoreMessageScrollAnchor(area, list, anchor);
  endChatScrollAdjust();
  return true;
}

function setupChatScrollStability() {
  const area = document.getElementById('messages-area');
  const list = document.getElementById('messages-list');
  if (!area || !list || area.dataset.scrollStable === '1') return;
  area.dataset.scrollStable = '1';

  const refreshLock = () => {
    if (isMessagesNearBottom(120)) {
      _chatScrollLock = null;
      return;
    }
    const areaRect = area.getBoundingClientRect();
    const nodes = list.querySelectorAll('.bubble-wrap[data-id], .recall-hint[data-id], .poke-hint[data-id]');
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.bottom > areaRect.top + 8) {
        _chatScrollLock = { el, top: r.top - areaRect.top };
        return;
      }
    }
    _chatScrollLock = null;
  };
  _refreshChatScrollLock = refreshLock;

  area.addEventListener('touchstart', (e) => {
    _chatListGesture.startY = e.touches[0]?.clientY || 0;
    _chatListGesture.moved = false;
    const y = area.scrollTop;
    area.style.scrollBehavior = 'auto';
    area.scrollTop = y;
  }, { passive: true });
  area.addEventListener('touchmove', (e) => {
    const y = e.touches[0]?.clientY || 0;
    if (Math.abs(y - _chatListGesture.startY) > 10) _chatListGesture.moved = true;
  }, { passive: true });
  area.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    _chatListGesture.startY = e.clientY;
    _chatListGesture.moved = false;
  });
  area.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (Math.abs(e.clientY - _chatListGesture.startY) > 10) _chatListGesture.moved = true;
  });
  area.addEventListener('scroll', refreshLock, { passive: true });

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (_chatScrollAdjusting) return;
      const lock = _chatScrollLock;
      if (!lock?.el || !lock.el.isConnected) {
        refreshLock();
        return;
      }
      if (isMessagesNearBottom(120)) return;
      const areaRect = area.getBoundingClientRect();
      const r = lock.el.getBoundingClientRect();
      const delta = (r.top - areaRect.top) - lock.top;
      if (Math.abs(delta) > 1) {
        area.style.scrollBehavior = 'auto';
        area.scrollTop += delta;
      }
    });
    ro.observe(list);
  }
}

function cssAttrEscape(value) {
  const s = String(value ?? '');
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

function getOldestKnownMsgId() {
  if (_foldedMessages.length) {
    const id = Number(_foldedMessages[0]?.id);
    if (id > 0) return id;
  }
  const wraps = document.querySelectorAll(
    '#messages-list .bubble-wrap[data-msg-id], #messages-list .bubble-wrap[data-id], ' +
    '#messages-list .recall-hint[data-msg-id], #messages-list .robot-aside[data-msg-id], ' +
    '#messages-list .poke-hint[data-msg-id]'
  );
  let min = Infinity;
  wraps.forEach(el => {
    const id = parseInt(el.dataset.msgId || el.dataset.id, 10);
    if (Number.isFinite(id) && id > 0 && id < min) min = id;
  });
  return min === Infinity ? 0 : min;
}

function splitCachedWindow(messages) {
  const today = todayChatDayStr();
  let splitAt = 0;
  while (splitAt < messages.length && toChatDayStr(messages[splitAt].timestamp) < today) splitAt++;
  if (splitAt >= messages.length || splitAt === 0) {
    return { visible: messages, folded: [] };
  }
  return { visible: messages.slice(splitAt), folded: messages.slice(0, splitAt) };
}

/** 首屏可见条数封顶：今天聊再多也不一次全画进 DOM */
function capVisibleForOpen(visible, folded) {
  const vis = Array.isArray(visible) ? visible : [];
  const fold = Array.isArray(folded) ? folded.slice() : [];
  if (vis.length <= MAX_VISIBLE_ON_OPEN) return { visible: vis, folded: fold };
  const overflow = vis.slice(0, vis.length - MAX_VISIBLE_ON_OPEN);
  return {
    visible: vis.slice(-MAX_VISIBLE_ON_OPEN),
    folded: fold.concat(overflow),
  };
}

/** 进页先画本地线程，避免等接口时整页空白 */
async function paintLocalThreadFirst(loadId, thisCharId) {
  // 优先用内存缓存；通讯页点进时通常已预热。冷启动不在这里死等整本 IndexedDB 归档。
  let cached = getThreadCacheSync(charId, isDream);
  if (!cached?.messages?.length) {
    const idbPromise = getThreadCache(charId, isDream);
    cached = await Promise.race([
      idbPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (!cached?.messages?.length) {
      // 超时后 IDB 仍继续读；读到且列表还空时再补画，不挡进页
      void idbPromise.then((data) => {
        if (loadId !== _chatLoadSeq || charId !== thisCharId) return;
        if (!data?.messages?.length) return;
        const list = document.getElementById('messages-list');
        if (list?.querySelector('.bubble-wrap, .recall-hint, .poke-hint')) return;
        paintThreadFromCache(data);
        revealMessagesAtBottom();
      });
      return null;
    }
  }
  if (loadId !== _chatLoadSeq || charId !== thisCharId) return null;
  if (cached?.messages?.length) {
    paintThreadFromCache(cached);
    revealMessagesAtBottom();
    return cached;
  }
  return null;
}

function showChatLoadError(message) {
  const area = document.getElementById('messages-area');
  area?.classList.remove('is-opening');
  const list = document.getElementById('messages-list');
  if (!list || list.querySelector('.bubble-wrap, .bubble-time, .empty-state')) return;
  const raw = String(message || '');
  const detail = /超时|Failed to fetch|failed to fetch|NetworkError|连不上/i.test(raw)
    ? escapeHtml(api.explainBackendUnreachable?.() || '暂时连不上服务器，请检查网络')
    : escapeHtml(raw || '请稍后重试');
  list.innerHTML = `
    <div class="empty-state" style="padding:60px 24px;text-align:center">
      <div style="font-size:16px;color:var(--text-secondary);line-height:1.7">
        聊天记录加载失败<br>
        <span style="font-size:13px">${detail}</span>
      </div>
    </div>
  `;
}

function paintThreadFromCache(cached) {
  const wantId = Number(charId);
  const all = (cached.messages || []).filter((m) => {
    if (m?.character_id == null || m.character_id === '') return true;
    return Number(m.character_id) === wantId;
  });
  const windowMsgs = all.length > CACHE_PAINT_TAIL ? all.slice(-CACHE_PAINT_TAIL) : all;
  const truncatedHead = all.length > windowMsgs.length;
  let { visible, folded } = splitCachedWindow(windowMsgs);
  ({ visible, folded } = capVisibleForOpen(visible, folded));
  const MAX_FOLD = 160;
  const foldTail = folded.length > MAX_FOLD ? folded.slice(-MAX_FOLD) : folded;
  _foldedMessages = foldTail;
  _hasMoreOnServer = !!cached.hasMore || truncatedHead || folded.length > foldTail.length || foldTail.length > 0;
  _foldExpanded = false;
  offset = visible.length + foldTail.length;
  if (visible.length) appendMessages(visible, true);
  else {
    const list = document.getElementById('messages-list');
    if (list) list.innerHTML = buildFoldBar();
  }
  updateFoldBar();
  restoreVoiceTranscripts();
}

function appendFreshMessages(msgs) {
  if (!msgs?.length) return;
  const list = document.getElementById('messages-list');
  if (!list) return;
  const fresh = msgs
    .filter(m => m?.id != null && !isAiMsgInDom(m.id))
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (!fresh.length) return;
  list.insertAdjacentHTML('beforeend', buildMessagesHtml(fresh));
  attachRecalledMeta(fresh);
  restoreVoiceTranscripts();
  hydrateLocationCardMaps(list);
  hydrateWebCards(list);
  hydrateMusicCards(fresh);
}

function reconcileDeletedMessagesFromServer(tailMsgs, forCharId = charId) {
  if (!forCharId || !tailMsgs?.length) return;
  const result = pruneStaleThreadMessages(forCharId, isDream, tailMsgs);
  if (result?.removedIds?.length) {
    removeBubblesByMessageIds(result.removedIds);
  }
}

/** 列表里气泡 id 是否从上到下递增；被误把旧缓存补到末尾时会乱序 */
function isMessageListOutOfOrder(list) {
  const wraps = list?.querySelectorAll?.('.bubble-wrap[data-msg-id]');
  if (!wraps?.length) return false;
  let prev = 0;
  for (const el of wraps) {
    const id = parseInt(el.dataset.msgId || el.dataset.id || '0', 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (prev && id < prev) return true;
    if (id > prev) prev = id;
  }
  return false;
}

/** 仅把「比当前 DOM 更新」且漏画的消息补到末尾；绝不要把折叠区/整本缓存旧消息往底下倒 */
function paintMissingMessagesToDom(msgs, { nearBottomScroll = true, onlyNewerThanDom = true } = {}) {
  if (!msgs?.length) return 0;
  const list = document.getElementById('messages-list');
  if (!list) return 0;
  const domMax = getListLatestMsgId(list);
  const missing = msgs
    .filter((m) => {
      if (m?.id == null || m.id === '') return false;
      if (isAiMsgInDom(m.id)) return false;
      if (onlyNewerThanDom && domMax > 0 && !(Number(m.id) > domMax)) return false;
      return true;
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (!missing.length) return 0;
  appendFreshMessages(missing);
  if (nearBottomScroll) {
    const area = document.getElementById('messages-area');
    const nearBottom = area
      ? (area.scrollHeight - area.scrollTop - area.clientHeight < 160)
      : true;
    if (nearBottom) scrollBottom(false);
  }
  return missing.length;
}

async function syncNewMessages(loadSeq = _chatLoadSeq) {
  if (!charId) return;
  if (!shouldRenderForChar(charId)) return;
  const dreamFlag = isDream ? 1 : 0;
  const list = document.getElementById('messages-list');
  repairOutOfOrderMessageList();
  // 只用 DOM 水位做增量（DOM 正常时才可靠）
  const sinceId = getListLatestMsgId(list);
  markOpenChatRead(charId);
  try {
    if (sinceId > 0) {
      const newer = await api.getMessages(charId, { dream: dreamFlag, sinceId, limit: 100 });
      if (loadSeq !== _chatLoadSeq || !shouldRenderForChar(charId)) return;
      const incoming = Array.isArray(newer) ? newer : [];
      if (incoming.length) {
        upsertThreadMessages(charId, isDream, incoming);
        paintMissingMessagesToDom(incoming);
      }
    }

    const recent = await api.getMessages(charId, { dream: dreamFlag, limit: SYNC_RECONCILE_LIMIT, offset: 0 });
    if (loadSeq !== _chatLoadSeq || !shouldRenderForChar(charId)) return;
    if (Array.isArray(recent) && recent.length) {
      reconcileDeletedMessagesFromServer(recent);
      upsertThreadMessages(charId, isDream, recent);
      paintMissingMessagesToDom(recent);
      applyReadStateFromMessages(recent);
      patchBubbleTimestampsFromMessages(recent);
      patchMediaBubblesFromMessages(recent);
      for (const m of recent) {
        if (m.recalled) applyRecalledUiForMsg(m.id, m.recalled_content);
      }
    }
  } catch (e) {
    console.warn('[chat] sync new', e.message);
  }
}

async function loadMessages(reset = false, { force = false } = {}) {
  const loadSeq = _chatLoadSeq;
  if (reset) {
    if (!force) document.getElementById('messages-area')?.classList.add('is-opening');
    offset = 0;
    _foldedMessages = [];
    _foldExpanded = false;
    _hasMoreOnServer = true;
    markOpenChatRead(charId);
  }
  isLoading = true;
  try {
    if (reset) {
      if (!force) {
        const cached = getThreadCacheSync(charId, isDream) || await getThreadCache(charId, isDream);
        if (loadSeq !== _chatLoadSeq) return;
        if (cached?.messages?.length) {
          paintThreadFromCache(cached);
          await syncNewMessages(loadSeq);
          scheduleThreadArchive(charId, isDream);
          prefetchMessageMedia(cached.messages.slice(-30), { limit: 10 }).catch(() => {});
          return;
        }
      }
      const win = await fetchInitialChatWindow(loadSeq);
      if (loadSeq !== _chatLoadSeq) return;
      offset = win.fetchedCount;
      _hasMoreOnServer = win.hasMore || win.folded.length > 0;
      _foldedMessages = win.folded;
      // 先灌 IndexedDB，再合并近窗，避免冷启动写穿归档导致导出丢历史
      await hydrateThreadCacheFromIdb(charId, isDream);
      if (loadSeq !== _chatLoadSeq) return;
      replaceThreadMessages(charId, isDream, [...win.folded, ...win.visible], win.hasMore);
      appendMessages(win.visible, true);
      updateFoldBar();
      restoreVoiceTranscripts();
      scheduleThreadArchive(charId, isDream);
    } else {
      const beforeId = getOldestKnownMsgId();
      const localOlder = listOlderThreadMessages(charId, isDream, beforeId, LIMIT);
      if (localOlder.length) {
        appendMessages(localOlder, false);
        offset += localOlder.length;
        if (localOlder.length >= LIMIT) {
          _hasMoreOnServer = true;
        } else {
          const olderId = Number(localOlder[0]?.id) || beforeId;
          let msgs = [];
          try {
            msgs = olderId > 0
              ? await api.getMessages(charId, { dream: isDream ? 1 : 0, limit: LIMIT, beforeId: olderId })
              : [];
          } catch { msgs = []; }
          if (loadSeq !== _chatLoadSeq) return;
          if (msgs.length) {
            appendMessages(msgs, false);
            upsertThreadMessages(charId, isDream, msgs, { hasMore: msgs.length >= LIMIT });
            offset += msgs.length;
            _hasMoreOnServer = msgs.length >= LIMIT;
          } else {
            _hasMoreOnServer = false;
          }
        }
        updateFoldBar();
        restoreVoiceTranscripts();
        return;
      }
      const msgs = beforeId > 0
        ? await api.getMessages(charId, { dream: isDream ? 1 : 0, limit: LIMIT, beforeId })
        : await api.getMessages(charId, { dream: isDream ? 1 : 0, limit: LIMIT, offset });
      if (loadSeq !== _chatLoadSeq) return;
      _hasMoreOnServer = msgs.length >= LIMIT;
      appendMessages(msgs, false);
      upsertThreadMessages(charId, isDream, msgs, { hasMore: _hasMoreOnServer });
      offset += msgs.length;
      updateFoldBar();
      restoreVoiceTranscripts();
    }
  } catch {}
  finally {
    if (loadSeq === _chatLoadSeq) {
      isLoading = false;
      if (reset) {
        _chatPageReloading = false;
        revealMessagesAtBottom();
      }
    }
  }
}

function chatTimeZone() {
  return currentChar?.timezone
    || window.getAppSettings?.()?.timezone
    || 'Asia/Shanghai';
}

function toChatDayStr(ts) {
  if (!ts) return '';
  const raw = String(ts);
  const d = ts instanceof Date ? ts : new Date(/T|Z|\+/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: chatTimeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function todayChatDayStr() {
  return toChatDayStr(new Date().toISOString());
}

/** 首屏：近窗铺开（有上限）；更早的先收在顶上 */
async function fetchInitialChatWindow(loadSeq) {
  const today = todayChatDayStr();
  let collected = [];
  let fetchedCount = 0;
  let hasMore = true;
  while (collected.length < MAX_INITIAL_MSGS) {
    const opts = { dream: isDream ? 1 : 0, limit: LIMIT };
    if (collected.length) opts.beforeId = collected[0].id;
    const batch = await api.getMessages(charId, opts);
    if (loadSeq !== _chatLoadSeq) {
      return { visible: [], folded: [], fetchedCount, hasMore: true };
    }
    if (!batch.length) {
      hasMore = false;
      break;
    }
    fetchedCount += batch.length;
    collected = batch.concat(collected);
    if (batch.length < LIMIT) {
      hasMore = false;
      break;
    }
    const oldestDay = toChatDayStr(collected[0]?.timestamp);
    if (oldestDay && oldestDay < today) break;
  }

  let splitAt = 0;
  while (splitAt < collected.length && toChatDayStr(collected[splitAt].timestamp) < today) {
    splitAt++;
  }
  // 今天还没有消息：避免空白墙，把刚拉到的最近一页直接展示
  if (splitAt >= collected.length) {
    const capped = capVisibleForOpen(collected, []);
    return {
      visible: capped.visible,
      folded: capped.folded,
      fetchedCount,
      hasMore: hasMore || capped.folded.length > 0,
    };
  }
  if (splitAt === 0) {
    const capped = capVisibleForOpen(collected, []);
    return {
      visible: capped.visible,
      folded: capped.folded,
      fetchedCount,
      hasMore: hasMore || capped.folded.length > 0,
    };
  }
  {
    const capped = capVisibleForOpen(
      collected.slice(splitAt),
      collected.slice(0, splitAt),
    );
    return {
      visible: capped.visible,
      folded: capped.folded,
      fetchedCount,
      hasMore: true,
    };
  }
}

// 顶部"查看更早消息"是唯一入口：本地已取到但折叠未展示的，先展开；
// 本地折叠已经清空、服务端还有更早记录的，再去翻页拉取——不再和单独的"加载更多"按钮并存。
function buildFoldBar() {
  if (_foldedMessages.length > 0) {
    return `<div class="msg-fold-bar" id="msg-fold-bar" onclick="loadOlderMessages(event)">
      <span class="msg-fold-icon">⋯</span>
      <span>还有更早的对话，点击展开</span>
    </div>`;
  }
  if (_hasMoreOnServer) {
    return `<div class="msg-fold-bar" id="msg-fold-bar" onclick="loadOlderMessages(event)">
      <span class="msg-fold-icon">⋯</span>
      <span>点击加载更早的消息</span>
    </div>`;
  }
  return '';
}

function updateFoldBar() {
  const list = document.getElementById('messages-list');
  let bar = document.getElementById('msg-fold-bar');
  const html = buildFoldBar();
  if (!html) { bar?.remove(); return; }
  if (bar) bar.outerHTML = html;
  else list.insertAdjacentHTML('afterbegin', html);
}

window.loadOlderMessages = async function() {
  if (chatListGestureShouldIgnoreTap()) return;
  if (isLoading) return;
  const bar = document.getElementById('msg-fold-bar');
  if (bar) {
    bar.style.opacity = '0.5';
    bar.style.pointerEvents = 'none';
    const tip = bar.querySelector('span:last-child');
    if (tip) tip.textContent = '加载中…';
  }
  // 先展开本地折叠（每次一页，避免一次倒进上百条后视口闪到最早）
  if (_foldedMessages.length) {
    _foldExpanded = true;
    const list = document.getElementById('messages-list');
    const area = document.getElementById('messages-area');
    const prevHeight = area?.scrollHeight || 0;
    const prevTop = area?.scrollTop || 0;
    beginChatScrollAdjust();
    document.getElementById('msg-fold-bar')?.remove();
    const take = Math.min(LIMIT, _foldedMessages.length);
    const batch = _foldedMessages.splice(-take);
    const html = buildMessagesHtml(batch);
    list.insertAdjacentHTML('afterbegin', html);
    attachRecalledMeta(batch);
    hydrateLocationCardMaps(list);
    hydrateWebCards(list);
    hydrateMusicCards(batch);
    updateFoldBar();
    keepScrollAfterPrepend(area, prevHeight, prevTop);
    endChatScrollAdjust();
    return;
  }
  // 再向服务端翻更早一页（直接插入列表，不再二次折叠）
  if (_hasMoreOnServer) {
    _foldExpanded = true;
    await loadMessages(false);
    updateFoldBar();
  }
};
// 兼容旧引用
window.expandFoldedMessages = window.loadOlderMessages;

async function maybeFirstGreet() {
  if (isDream || !charId) return;
  const list = document.getElementById('messages-list');
  if (list?.querySelector('.bubble-wrap')) return;

  try {
    const result = await api.greetCharacter(charId, false);
    if (result.messages?.length) {
      playNotifySound();
      for (let i = 0; i < result.messages.length; i++) {
        const msg = result.messages[i];
        const prev = i > 0 ? result.messages[i - 1] : null;
        await pauseBeforeAiBubble(charId, prev || msg, {
          afterVisible: !!prev,
          kindMsg: msg,
        });
        list.insertAdjacentHTML('beforeend', buildBubble({
          id: msg.id, role: 'assistant', content: msg.content, type: 'text', timestamp: msg.timestamp,
        }, currentChar, {}));
        scrollBottom(true);
      }
    }
  } catch {
    showCharTyping(false);
  }
}

let _searchTimer = null;
let _jumpSeq = 0;
let _dateJumping = false;

function isCoarsePointer() {
  return !!(window.matchMedia?.('(pointer: coarse)')?.matches
    || document.documentElement.classList.contains('native-shell'));
}

function visibleSearchHits(msgs) {
  return (msgs || []).filter((m) => {
    if (!m || isHiddenChatMessage(m)) return false;
    if (m.type === 'system' && String(m.content || '').startsWith('__special__')) return false;
    return true;
  });
}

function renderChatSearchHits(msgs, keyword = '') {
  const results = document.getElementById('chat-search-results');
  if (!results) return;
  const list = visibleSearchHits(msgs);
  if (!list.length) {
    results.innerHTML = '<div class="empty-state"><div class="empty-text">没有找到相关消息</div></div>';
    return;
  }
  const kw = String(keyword || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  results.innerHTML = list.map((m) => {
    const who = m.role === 'user' ? '我' : escapeHtml(currentChar?.name || 'TA');
    let snippet = escapeHtml(m.content || '');
    if (kw) {
      snippet = snippet.replace(new RegExp(kw, 'gi'), (match) =>
        `<mark style="background:var(--theme-light);color:var(--theme-dark);border-radius:2px;padding:0 1px">${match}</mark>`);
    }
    return `<div class="list-item" style="flex-direction:column;align-items:flex-start;gap:4px;cursor:pointer;touch-action:manipulation"
         onclick="event.stopPropagation();jumpToChatMessage('${m.id}')">
      <div style="font-size:11px;color:var(--text-secondary)">${who} · ${new Date(m.timestamp).toLocaleString('zh-CN')}</div>
      <div style="font-size:14px;line-height:1.5;word-break:break-word">${snippet}</div>
    </div>`;
  }).join('');
}

window.openChatSearch = function() {
  if (!charId) return;
  const overlay = document.getElementById('chat-search-overlay');
  if (!overlay) return;
  overlay.style.pointerEvents = '';
  overlay.style.display = 'flex';
  document.getElementById('chat-search-results').innerHTML = '';
  const input = document.getElementById('chat-search-input');
  if (input) input.value = '';
  const dateInput = document.getElementById('chat-search-date');
  if (dateInput) dateInput.value = '';
  // 手机上自动聚焦会弹出键盘，挡住日期选择
  if (!isCoarsePointer()) setTimeout(() => input?.focus(), 200);
};

async function searchMessagesMerged(q, { date = '', limit = 40 } = {}) {
  await getThreadCache(charId, isDream);
  const local = searchThreadMessages(charId, isDream, { q, date, limit });
  let remote = [];
  try {
    remote = await api.searchMessages(charId, q, { dream: isDream ? 1 : 0, date, limit });
  } catch {
    remote = [];
  }
  const map = new Map();
  for (const m of [...local, ...(remote || [])]) {
    if (m?.id == null) continue;
    map.set(Number(m.id), m);
  }
  return [...map.values()].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limit);
}

window.jumpToChatDate = async function(dateStr) {
  if (!charId || !dateStr || _dateJumping) return;
  _dateJumping = true;
  const results = document.getElementById('chat-search-results');
  if (results) results.innerHTML = '<div class="empty-state"><div class="empty-text">查找中…</div></div>';
  try {
    const msgs = await searchMessagesMerged('', { date: dateStr, limit: 40 });
    const hits = visibleSearchHits(msgs);
    if (!hits.length) {
      if (results) results.innerHTML = '<div class="empty-state"><div class="empty-text">这一天没有聊天记录</div></div>';
      return;
    }
    renderChatSearchHits(hits);
    await window.jumpToChatMessage(hits[0].id);
  } catch {
    if (results) results.innerHTML = '<div class="empty-state"><div class="empty-text">查找失败</div></div>';
  } finally {
    _dateJumping = false;
  }
};

window.closeChatSearch = function() {
  const overlay = document.getElementById('chat-search-overlay');
  if (overlay) {
    overlay.style.pointerEvents = '';
    overlay.style.display = 'none';
  }
  document.getElementById('chat-search-input')?.blur();
  document.getElementById('chat-search-date')?.blur();
};

window.doChatSearch = function(q) {
  clearTimeout(_searchTimer);
  const results = document.getElementById('chat-search-results');
  if (!q.trim()) { results.innerHTML = ''; return; }
  _searchTimer = setTimeout(async () => {
    try {
      const msgs = await searchMessagesMerged(q.trim(), { limit: 50 });
      renderChatSearchHits(msgs, q.trim());
    } catch {
      results.innerHTML = '<div class="empty-state"><div class="empty-text">搜索失败</div></div>';
    }
  }, 350);
};

window.jumpToChatMessage = async function(msgId) {
  if (!charId || !msgId) return;
  const seq = ++_jumpSeq;
  const overlay = document.getElementById('chat-search-overlay');
  document.getElementById('chat-search-input')?.blur();
  document.getElementById('chat-search-date')?.blur();
  document.getElementById('chat-settings-overlay')?.style.setProperty('display', 'none');
  if (overlay) overlay.style.pointerEvents = 'none';

  const idStr = String(msgId);
  const targetId = Number(msgId);
  const list = document.getElementById('messages-list');
  const area = document.getElementById('messages-area');
  const dreamFlag = isDream ? 1 : 0;
  const findEl = (id = idStr) => {
    if (!list) return null;
    const esc = cssAttrEscape(id);
    return list.querySelector(
      `.bubble-wrap[data-msg-id="${esc}"], .bubble-wrap[data-id="${esc}"], ` +
      `.bubble-wrap[data-id^="hist_${esc}_"], ` +
      `.recall-hint[data-msg-id="${esc}"], .recall-hint[data-id="${esc}"], ` +
      `.robot-aside[data-msg-id="${esc}"], .robot-aside[data-id="${esc}"], ` +
      `.poke-hint[data-msg-id="${esc}"], .poke-hint[data-id="${esc}"]`
    );
  };

  const expandLocalFold = () => {
    if (!_foldedMessages.length || !list) return;
    _foldExpanded = true;
    const prevHeight = area?.scrollHeight || 0;
    const prevTop = area?.scrollTop || 0;
    beginChatScrollAdjust();
    document.getElementById('msg-fold-bar')?.remove();
    const html = buildMessagesHtml(_foldedMessages);
    list.insertAdjacentHTML('afterbegin', html);
    attachRecalledMeta(_foldedMessages);
    hydrateLocationCardMaps(list);
    hydrateWebCards(list);
    hydrateMusicCards(_foldedMessages);
    _foldedMessages = [];
    updateFoldBar();
    keepScrollAfterPrepend(area, prevHeight, prevTop);
    endChatScrollAdjust();
  };

  const restoreOverlay = () => {
    if (overlay) overlay.style.pointerEvents = '';
  };

  try {
    let el = findEl();
    if (!el && _foldedMessages.some(m => Number(m.id) === targetId || String(m.id) === idStr)) {
      expandLocalFold();
      el = findEl();
    }
    if (!el && _foldedMessages.length) {
      expandLocalFold();
      el = findEl();
    }

    if (!el) {
      let localGuard = 0;
      while (!el && localGuard < 40) {
        const beforeId = getOldestKnownMsgId();
        const local = listOlderThreadMessages(charId, isDream, beforeId, 80);
        if (!local.length) break;
        appendMessages(local, false);
        el = findEl();
        localGuard += 1;
        if (Number(local[0]?.id) < targetId && !el) break;
      }
    }

    if (!el) {
      _foldExpanded = true;
      try {
        isLoading = true;
        const around = await api.getMessages(charId, {
          dream: dreamFlag,
          aroundId: targetId,
          limit: 80,
        });
        if (seq !== _jumpSeq) return;
        if (around.length && list) {
          const hasTarget = around.some((m) => Number(m.id) === targetId);
          const aroundMax = around.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
          const oldestDom = getOldestKnownMsgId();
          // 旧后端会忽略 aroundId、返回最近一页；那种结果不能往顶部塞
          const looksLikeContext = hasTarget || (oldestDom > 0 && aroundMax > 0 && aroundMax <= oldestDom);
          if (looksLikeContext) {
            const known = new Set();
            list.querySelectorAll('.bubble-wrap[data-msg-id], .recall-hint[data-msg-id], .robot-aside[data-msg-id], .poke-hint[data-msg-id]').forEach((node) => {
              const id = parseInt(node.dataset.msgId || node.dataset.id, 10);
              if (id > 0) known.add(id);
            });
            const fresh = around.filter((m) => m?.id != null && !known.has(Number(m.id)));
            if (fresh.length) {
              appendMessages(fresh, false);
              upsertThreadMessages(charId, isDream, fresh, { hasMore: true });
              offset += fresh.length;
              updateFoldBar();
            }
            el = findEl();
            if (!el) {
              const near = visibleSearchHits(around)
                .sort((a, b) => Math.abs(Number(a.id) - targetId) - Math.abs(Number(b.id) - targetId))[0];
              if (near) el = findEl(String(near.id));
            }
          }
        }
      } catch {
        /* 再走向上翻页 */
      } finally {
        isLoading = false;
      }
    }

    if (!el) {
      _foldExpanded = true;
      let guard = 0;
      while (!el && guard < 40) {
        if (seq !== _jumpSeq) return;
        guard++;
        if (_foldedMessages.length) {
          expandLocalFold();
          el = findEl();
          continue;
        }
        const beforeId = getOldestKnownMsgId();
        try {
          isLoading = true;
          const msgs = beforeId > 0
            ? await api.getMessages(charId, { dream: dreamFlag, limit: 100, beforeId })
            : await api.getMessages(charId, { dream: dreamFlag, limit: 100, offset: 0 });
          if (seq !== _jumpSeq) return;
          if (!msgs.length) {
            _hasMoreOnServer = false;
            break;
          }
          if (beforeId > 0) {
            _hasMoreOnServer = msgs.length >= 100;
            appendMessages(msgs, false);
          } else {
            _hasMoreOnServer = msgs.length >= 100;
            _foldedMessages = [];
            appendMessages(msgs, true);
          }
          upsertThreadMessages(charId, isDream, msgs, { hasMore: _hasMoreOnServer });
          offset += msgs.length;
          updateFoldBar();
          el = findEl();
          if (!el && beforeId > 0 && Number(msgs[0]?.id) < targetId) break;
          if (!beforeId && el) break;
        } catch {
          break;
        } finally {
          isLoading = false;
        }
      }
    }

    if (seq !== _jumpSeq) return;
    if (!el) {
      restoreOverlay();
      window.showToast?.('未找到该消息');
      return;
    }

    // 先让点击结束，关掉浮层，避免点穿；手机再等键盘收掉再滚
    await new Promise((r) => setTimeout(r, 40));
    if (seq !== _jumpSeq) return;
    closeChatSearch();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    if (isCoarsePointer()) await new Promise((r) => setTimeout(r, 200));
    if (seq !== _jumpSeq) return;

    el = findEl() || el;
    if (area) {
      withInstantAreaScroll(area, () => {
        const areaRect = area.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const nextTop = area.scrollTop + (elRect.top - areaRect.top) - (area.clientHeight / 2) + (elRect.height / 2);
        area.scrollTop = Math.max(0, nextTop);
      });
    } else {
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    el.classList.add('msg-highlight');
    setTimeout(() => el.classList.remove('msg-highlight'), 2600);
  } catch {
    restoreOverlay();
    window.showToast?.('跳转失败');
  }
};

function exportMessageBody(m) {
  if (m?.recalled) return '[已撤回]';
  const raw = String(m?.content || '');
  if (!raw) return '';
  const type = m?.type || 'text';
  if (type === 'image') return '[图片]';
  if (type === 'video') return '[视频]';
  if (type === 'location') return `[位置] ${raw}`;
  if (type === 'emoji') return `[表情] ${raw}`;
  if (type === 'voice' || raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j?.sfx) return `[音效] ${j.transcript || ''}`.trim();
      if (j?.score) return `[演奏] ${j.transcript || ''}`.trim();
      if (j?.voice || j?.url) {
        const tr = String(j.transcript || '').trim();
        return tr ? `[语音] ${tr}` : '[语音]';
      }
    } catch { /* 当正文 */ }
  }
  if (raw.startsWith('__special__')) return '';
  return raw;
}

window.exportChatHistory = async function(format = 'txt') {
  if (!charId) return;
  window.showToast?.('正在导出…');
  try {
    // 先把服务器近窗/未归档旧消息尽量补回本机，再导出
    try { await backfillAndAckThread(charId, isDream); } catch { /* 用本地尽力导出 */ }
    await hydrateThreadCacheFromIdb(charId, isDream);
    await getThreadCache(charId, isDream);
    const map = new Map();
    const addMsg = (m) => {
      const id = Number(m?.id);
      if (!Number.isFinite(id) || id <= 0) return;
      map.set(id, { ...(map.get(id) || {}), ...m, id });
    };
    for (const m of getThreadCacheSync(charId, isDream)?.messages || []) addMsg(m);

    let newest = 0;
    for (const id of map.keys()) if (id > newest) newest = id;
    if (newest > 0) {
      try {
        const newer = await api.getMessages(charId, { dream: isDream ? 1 : 0, sinceId: newest, limit: 200 });
        for (const m of newer || []) addMsg(m);
      } catch { /* 用本地 */ }
    }

    let beforeId = Infinity;
    for (const id of map.keys()) if (id > 0 && id < beforeId) beforeId = id;
    if (!Number.isFinite(beforeId)) beforeId = 0;

    let guard = 0;
    while (guard++ < 120) {
      let batch = [];
      try {
        batch = beforeId > 0
          ? await api.getMessages(charId, { dream: isDream ? 1 : 0, limit: 200, beforeId })
          : await api.getMessages(charId, { dream: isDream ? 1 : 0, limit: 200, offset: 0 });
      } catch { break; }
      if (!batch.length) break;
      const prevSize = map.size;
      for (const m of batch) addMsg(m);
      let minId = Infinity;
      for (const id of map.keys()) if (id < minId) minId = id;
      if (batch.length < 200) break;
      if (beforeId > 0 && (minId >= beforeId || map.size === prevSize)) break;
      beforeId = minId;
      // 补到本机，避免下次再丢
      try { upsertThreadMessages(charId, isDream, batch, { hasMore: batch.length >= 200 }); } catch {}
    }

    const all = [...map.values()]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .filter((m) => {
        if (String(m.content || '').startsWith('__special__')) return false;
        if (m.type === 'system' && String(m.content || '').startsWith('__special__')) return false;
        return true;
      });
    if (!all.length) {
      window.showToast?.('没有可导出的聊天记录');
      return;
    }

    const userName = window.getAppSettings?.()?.username || '我';
    const charName = currentChar?.name || 'TA';
    let content = '';
    let mime = 'text/plain;charset=utf-8';
    let ext = 'txt';
    if (format === 'md') {
      content = `# ${charName} 对话记录\n\n` + all.map((m) => {
        const who = m.role === 'user' ? userName : (m.role === 'system' ? '系统' : charName);
        const t = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN') : '';
        const body = exportMessageBody(m);
        return `**${who}** · ${t}\n\n${body}\n`;
      }).join('\n');
      ext = 'md';
    } else if (format === 'json') {
      const jsonData = {
        character: charName,
        user: userName,
        exported_at: new Date().toISOString(),
        messages: all.map((m) => ({
          id: m.id,
          role: m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'assistant'),
          name: m.role === 'user' ? userName : (m.role === 'system' ? '系统' : charName),
          type: m.type || 'text',
          content: m.recalled ? '[已撤回]' : (m.content || ''),
          timestamp: m.timestamp,
        })),
      };
      content = JSON.stringify(jsonData, null, 2);
      mime = 'application/json;charset=utf-8';
      ext = 'json';
    } else {
      content = all.map((m) => {
        const who = m.role === 'user' ? userName : (m.role === 'system' ? '系统' : charName);
        const t = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN') : '';
        return `[${t}] ${who}: ${exportMessageBody(m)}`;
      }).join('\n');
    }

    const r = await downloadTextFile(`${charName}-chat-${localDateStr()}.${ext}`, content, mime);
    if (r.cancelled) return;
    if (!r.ok || r.via === 'anchor-unreliable') {
      window.showToast?.(downloadResultToast(r) || '导出失败：无法写入文件');
      return;
    }
    const tip = downloadResultToast(r) || '导出完成';
    window.showToast?.(`${tip}（${all.length} 条）`);
  } catch (e) {
    window.showToast?.('导出失败：' + (e?.message || e));
  }
};

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseExportTimestamp(raw) {
  const s = String(raw || '').trim();
  if (!s) return new Date().toISOString();
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  // 兼容导出用的 zh-CN：2026/10/7 上午9:38:00
  let ampm = '';
  const normalized = s
    .replace(/\//g, '-')
    .replace(/\s*(上午|下午|AM|PM)\s*/i, (_, m) => {
      ampm = String(m);
      return ' ';
    })
    .trim();
  const m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return new Date().toISOString();
  let hh = parseInt(m[4] || '0', 10);
  if (/下午|^pm$/i.test(ampm) && hh < 12) hh += 12;
  if (/上午|^am$/i.test(ampm) && hh === 12) hh = 0;
  const d = new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    hh,
    parseInt(m[5] || '0', 10),
    parseInt(m[6] || '0', 10),
  );
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function importRoleFromWho(who, userName, charName) {
  const w = String(who || '').trim();
  if (!w) return 'assistant';
  if (w === userName || w === '我' || w === 'user') return 'user';
  if (w === '系统' || w === 'system') return 'system';
  if (charName && w === charName) return 'assistant';
  return 'assistant';
}

window.importChatHistory = async function(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !charId) return;
  window.showToast?.('正在导入…');
  try {
    const text = await file.text();
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const userName = window.getAppSettings?.()?.username || '我';
    const charName = currentChar?.name || 'TA';
    let messages = [];

    if (ext === 'json') {
      const data = JSON.parse(text);
      const rawMsgs = Array.isArray(data) ? data : (data.messages || []);
      messages = rawMsgs
        .map((m) => {
          const content = m?.recalled ? '[已撤回]' : (m?.content ?? '');
          if (content === '' || String(content).startsWith('__special__')) return null;
          const rawRole = String(m.role || '').toLowerCase();
          const role = rawRole === 'user' ? 'user' : (rawRole === 'system' ? 'system' : 'assistant');
          return {
            role,
            content: String(content),
            type: m.type || (role === 'system' ? 'system' : 'text'),
            timestamp: parseExportTimestamp(m.timestamp),
          };
        })
        .filter(Boolean);
    } else {
      // txt / md：逐行解析 "[时间] 角色: 内容" 或 "**角色** · 时间\n\n内容"
      const lines = text.split(/\r?\n/);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i].trim();
        if (line.startsWith('# ') || !line) {
          i++;
          continue;
        }
        const txtMatch = line.match(/^\[([^\]]+)\]\s*(.+?)\s*[:：]\s*(.*)$/);
        if (txtMatch) {
          const content = String(txtMatch[3] ?? '').trim();
          if (content) {
            const role = importRoleFromWho(txtMatch[2], userName, charName);
            messages.push({
              role,
              content,
              type: role === 'system' ? 'system' : 'text',
              timestamp: parseExportTimestamp(txtMatch[1]),
            });
          }
          i++;
          continue;
        }
        const mdMatch = line.match(/^\*\*(.+?)\*\*\s*[·•]\s*(.*)$/);
        if (mdMatch) {
          const role = importRoleFromWho(mdMatch[1], userName, charName);
          const ts = parseExportTimestamp(mdMatch[2]);
          i++;
          while (i < lines.length && !lines[i].trim()) i++;
          const contentLines = [];
          while (i < lines.length && lines[i].trim() && !/^\*\*.+\*\*\s*[·•]/.test(lines[i].trim()) && !/^\[([^\]]+)\]\s*.+?\s*[:：]/.test(lines[i].trim())) {
            contentLines.push(lines[i].trim());
            i++;
          }
          if (contentLines.length) {
            messages.push({
              role,
              content: contentLines.join('\n'),
              type: role === 'system' ? 'system' : 'text',
              timestamp: ts,
            });
          }
          continue;
        }
        i++;
      }
    }

    if (!messages.length) {
      window.showToast?.('未识别到聊天记录，请检查文件格式');
      return;
    }

    if (!confirm(`将导入 ${messages.length} 条消息到当前对话，是否继续？`)) return;

    let ok = 0;
    const saved = [];
    const CHUNK = 200;
    for (let i = 0; i < messages.length; i += CHUNK) {
      const chunk = messages.slice(i, i + CHUNK);
      try {
        if (typeof api.saveImportedMessages === 'function') {
          const r = await api.saveImportedMessages(charId, chunk, { isDream });
          ok += Number(r?.imported) || (r?.messages?.length) || 0;
          if (Array.isArray(r?.messages)) saved.push(...r.messages);
        } else {
          for (const m of chunk) {
            const r = await api.saveImportedMessage(charId, { ...m, is_dream: isDream ? 1 : 0 });
            ok++;
            if (r?.message) saved.push(r.message);
            else if (r?.id) saved.push({ ...m, id: r.id, character_id: charId, is_dream: isDream ? 1 : 0 });
          }
        }
      } catch (e) {
        // 批量失败时降级逐条，尽量导入
        for (const m of chunk) {
          try {
            const r = await api.saveImportedMessage(charId, { ...m, is_dream: isDream ? 1 : 0 });
            ok++;
            if (r?.message) saved.push(r.message);
            else if (r?.id) saved.push({ ...m, id: r.id, character_id: charId, is_dream: isDream ? 1 : 0 });
          } catch { /* skip */ }
        }
      }
    }

    if (saved.length) {
      try { upsertThreadMessages(charId, isDream, saved, { hasMore: true }); } catch { /* ignore */ }
    }

    if (!ok) {
      window.showToast?.('导入失败：没有成功写入任何消息');
      return;
    }
    window.showToast?.(`导入完成，共 ${ok} 条`);
    await loadMessages(true, { force: true });
    document.getElementById('chat-settings-overlay').style.display = 'none';
  } catch (e) {
    window.showToast?.('导入失败：' + (e?.message || e));
  }
};

function restoreVoiceTranscripts() {
  const map = getVoiceTranscriptOpenMap?.() || {};
  Object.keys(map).forEach(id => {
    const wrap = document.querySelector(`.bubble-wrap[data-id="${id}"]`);
    const box = wrap?.querySelector('.voice-transcript-box');
    const voiceMsg = wrap?.querySelector('.voice-message');
    if (box && voiceMsg) {
      box.classList.add('is-open');
      syncVoiceTranscriptPadding(voiceMsg, box);
    }
  });
}

function buildMessagesHtml(msgs) {
  let html = '';
  let prevTime = null;
  const tsPos = getChatSettings(charId).timestampPosition || 'divider';
  for (const msg of msgs) {
    if (isHiddenChatMessage(msg)) continue;
    if (msg.type === 'system' && String(msg.content || '').startsWith('__special__')) continue;
    if (tsPos === 'divider' && shouldInsertTimeDivider(prevTime, msg.timestamp, 10)) {
      html += buildTimeDivider(msg.timestamp, charId);
    }
    if (msg.type === 'system') {
      html += buildBubble(msg, currentChar, {}, { charId });
    } else if (msg.role === 'assistant' && msg.type !== 'emoji' && msg.type !== 'image' && msg.type !== 'video'
      && msg.type !== 'link' && looksLikeWebCardPayload(msg.content)) {
      html += buildBubble({ ...msg, type: 'web_card' }, currentChar, {}, { charId });
    } else if (msg.role === 'assistant' && msg.type === 'voice') {
      if (isCallLineMessage(msg)) {
        html += buildBubble(msg, currentChar, {}, { charId });
      } else {
        let segs;
        try { segs = voiceBubbleSegments(msg.content); } catch { segs = [msg.content]; }
        if (!segs.length) segs = [msg.content];
        const dbId = msg.id;
        segs.forEach((seg, i) => {
          const segId = segs.length === 1
            ? msg.id
            : (i === segs.length - 1 ? msg.id : `hist_${msg.id}_${i}`);
          html += buildBubble({
            ...msg,
            id: segId,
            dbId,
            content: seg,
            type: 'voice',
          }, currentChar, {}, { charId });
        });
      }
    } else if (msg.role === 'assistant' && (msg.type === 'location' || msg.type === 'link' || msg.type === 'web_card')) {
      html += buildBubble(msg, currentChar, {}, { charId });
    } else if (msg.role === 'assistant' && msg.type !== 'emoji' && msg.type !== 'image' && msg.type !== 'video' && msg.type !== 'link' && msg.type !== 'web_card') {
      if (isCallLineMessage(msg)) {
        html += buildBubble(msg, currentChar, {}, { charId });
      } else {
        let segs;
        try { segs = splitAiSegments(msg.content); } catch { segs = [msg.content]; }
        if (!segs.length) segs = [msg.content];
        const dbId = msg.id;
        segs.forEach((seg, i) => {
          html += buildBubble({
            ...msg,
            id: i === segs.length - 1 ? msg.id : `hist_${msg.id}_${i}`,
            dbId,
            content: seg,
          }, currentChar, {}, { charId });
        });
      }
    } else {
      html += buildBubble(msg, currentChar, {}, { charId });
    }
    prevTime = msg.timestamp;
  }
  return html;
}

function attachRecalledMeta(msgs) {
  const list = document.getElementById('messages-list');
  msgs.forEach(msg => {
    if (msg.recalled && msg.recalled_content) {
      const el = list.querySelector(`[data-id="${msg.id}"]`);
      if (el) el.dataset.recalledContent = msg.recalled_content;
    }
  });
}

function getListLatestMsgId(list) {
  const wraps = list?.querySelectorAll(
    '.bubble-wrap[data-msg-id], .call-record[data-msg-id], .chat-sys-tip[data-msg-id], .poke-hint[data-msg-id]'
  );
  if (!wraps?.length) return 0;
  let max = 0;
  wraps.forEach(el => {
    const id = parseInt(el.dataset.msgId || el.dataset.id || '0', 10);
    if (id > max) max = id;
  });
  return max;
}

function appendMessages(msgs, isReset = false) {
  const list = document.getElementById('messages-list');
  if (!msgs.length) return;

  if (isReset) {
    const fetchLastId = msgs[msgs.length - 1]?.id || 0;
    const domLastId = getListLatestMsgId(list);
    // init 期间较早的请求返回时，DOM 可能已有更新的实时消息，不要覆盖
    if (!_chatPageReloading && domLastId > fetchLastId) return;
  }

  // 首屏已按「当天」切开；上翻加载的更早消息直接展示
  const html = buildMessagesHtml(msgs);

  if (isReset) {
    list.innerHTML = buildFoldBar() + html;
    attachRecalledMeta(msgs);
    if (charId) upsertThreadMessages(charId, isDream, msgs);
    hydrateLocationCardMaps(list);
    hydrateWebCards(list);
    hydrateMusicCards(msgs);
    return;
  }

  const area = document.getElementById('messages-area');
  const prevHeight = area?.scrollHeight || 0;
  const prevTop = area?.scrollTop || 0;
  beginChatScrollAdjust();
  const bar = document.getElementById('msg-fold-bar');
  if (bar) bar.insertAdjacentHTML('afterend', html);
  else list.insertAdjacentHTML('afterbegin', html);
  attachRecalledMeta(msgs);
  if (charId) upsertThreadMessages(charId, isDream, msgs);
  hydrateLocationCardMaps(list);
  hydrateWebCards(list);
  hydrateMusicCards(msgs);
  keepScrollAfterPrepend(area, prevHeight, prevTop);
  endChatScrollAdjust();
}

function layoutCallChatArea() {
  const area = document.getElementById('call-chat-area');
  const bottom = document.getElementById('call-bottom');
  if (!area || !bottom) return;
  const gap = 3;
  const maxH = bottom.getBoundingClientRect().top - gap - area.getBoundingClientRect().top;
  if (maxH > 48) area.style.maxHeight = `${Math.floor(maxH)}px`;
}

function scrollCallChat() {
  layoutCallChatArea();
  const area = document.getElementById('call-chat-area');
  if (!area) return;
  const overflow = area.scrollHeight - area.clientHeight;
  area.scrollTop = overflow > 0 ? overflow : 0;
}

/** 新通话开始前清空通话页文字区（挂断只清 transcript，DOM 会残留上一通） */
function clearCallChatArea() {
  const area = document.getElementById('call-chat-area');
  if (area) area.innerHTML = '';
}

/** 等本地预览有可用帧，再截给角色「看一眼」 */
async function waitForCallUserVideoFrame(timeoutMs = 2800) {
  const video = document.getElementById('call-user-video');
  if (!video) return false;
  if (video.readyState >= 2 && video.videoWidth > 0) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!inVideoCall || callDialing) return false;
    if (video.readyState >= 2 && video.videoWidth > 0) return true;
    await sleepMs(50);
  }
  return !!(video.readyState >= 2 && video.videoWidth > 0);
}

function bindCallChatLayout() {
  if (window._callChatLayoutBound) return;
  window._callChatLayoutBound = true;
  window._callChatLayoutHandler = () => scrollCallChat();
  window.addEventListener('resize', window._callChatLayoutHandler);
}

function charHasVoiceId(char) {
  return !!(String(char?.voice_id || '').trim() || String(char?.voice_id_nsfw || '').trim());
}

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

/** 心里话草稿和历史通道标签：画面上不能出现（与 memory.stripAiContextLabels 同规则） */
function stripCallVideoPrivateLeak(text) {
  return stripAiContextLabels(String(text || ''));
}

/** 文字视频：整段当地画面；引号内才是要朗读的台词 */
function parseCallVideoTextSceneClient(text) {
  const raw = stripCallVideoPrivateLeak(String(text || '').trim());
  if (!raw) return { lens: '', quotes: [], speechText: '' };
  const withoutLegacy = raw
    .replace(/\[\s*镜头\s*\][\s\S]*?\[\s*\/\s*镜头\s*\]/gi, (block) => {
      const inner = block.replace(/\[\s*\/?\s*镜头\s*\]/gi, '').trim();
      return inner ? ` ${inner} ` : '';
    })
    .replace(/\[\s*\/?\s*镜头\s*\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const quotes = extractQuotedSpeechParts(withoutLegacy || raw);
  return {
    lens: (withoutLegacy || raw).slice(0, 1200),
    quotes,
    speechText: quotes.join(' ').trim(),
  };
}

function stripCallSoundFxLines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/(?:^|\n)\s*(?:音效[：:]\s*|SFX:\s*|SOUND:\s*|环境[：:]\s*|AMB:\s*|AMBIENCE:\s*)[^\n]+/gi, '\n')
    .replace(/(?:音效[：:]\s*|SFX:\s*|SOUND:\s*|环境[：:]\s*|AMB:\s*|AMBIENCE:\s*)[^\n]+\s*$/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function callSpeakText(text) {
  let t = String(text || '').replace(/^【自动回复】/, '').trim();
  if (looksLikeWebCardPayload(t)) return '';
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (j?.sfx) return '';
      t = String(j.transcript || '').trim();
    } catch {}
  }
  if (/^\s*\[安静\]\s*$/.test(t) || /^\s*（安静）\s*$/.test(t)) return '';
  t = stripAiContextLabels(t);
  // 来电开场/模型漏写：剥掉「环境：」「音效：」行，避免念英文提示词导致 TTS 失败
  t = stripCallSoundFxLines(t);
  // 心里话 / 通道标签已在 stripAiContextLabels；这里再清镜头与语速
  t = t
    .replace(/\[\s*镜头\s*\][\s\S]*?\[\s*\/\s*镜头\s*\]/gi, '')
    .replace(/\[\s*镜头\s*\][\s\S]*$/i, '')
    .replace(/\[\s*\/\s*镜头\s*\]/gi, '')
    .replace(/[\[【［]\s*语速\s*[:：]\s*[0-9.]+[\]】］]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 文字视频：优先读引号台词；模型漏写引号时，别整段沉默——抽看起来像对白的短句
  if (inVideoCall && isCallVideoTextMode()) {
    const quotes = extractQuotedSpeechParts(t);
    if (quotes.length) return quotes.join('\n').trim();
    return fallbackSpeakFromVideoText(t);
  }
  if (looksTruncatedUtterance(t)) return '';
  return t;
}

/** 文字视频漏引号时：从整段画面里捞短对白，避免角色有话却不播语音 */
function fallbackSpeakFromVideoText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  // 中文「说/问/道：xxx」后的内容
  const said = [];
  const re = /(?:说|问|道|喊|回|答|念|嘀咕|低声|轻声)[道着]?[：:]\s*([^\n「」""]{1,40})/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const q = String(m[1] || '').replace(/[。．！？!?…~～]+$/u, '').trim();
    if (q && !/^(他|她|你|我|这|那|似乎|好像)/.test(q)) said.push(q);
  }
  if (said.length) return said.slice(0, 3).join('\n');
  // 整段很短且像一句口语 → 当台词念
  const compact = raw.replace(/\s+/g, '');
  if (compact.length <= 36 && /[吗呢吧啊呀哦喂嘿嗨]/.test(compact)) {
    return raw.slice(0, 80);
  }
  return '';
}

function callDisplayText(text) {
  const tidy = (s) => stripVoiceLaneTags(stripCallSoundFxLines(stripAiContextLabels(s)))
    .replace(/[\[【［]\s*语气\s*[:：][^\]】］\n]{0,12}[\]】］]/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  // 文字视频：红框里要整段（旁白+台词）。只朗读的引号另走 callSpeakText，不要在这里剥掉描写
  if (inVideoCall && isCallVideoTextMode()) {
    const scene = parseCallVideoTextSceneClient(text);
    return tidy(scene.lens || text);
  }
  return tidy(callSpeakText(text));
}

/** 文字视频：一条场景追加进中间通话区，不盖住上一条 */
function pushCallSceneLine(text) {
  const shown = String(text || '').trim();
  if (!shown || shown === '……' || shown === '…') return;
  const dup = callTranscript[callTranscript.length - 1];
  if (dup?.role === 'assistant' && dup.content === shown) return;
  callTranscript.push({ role: 'assistant', content: shown });
  appendCallChatMsg('assistant', shown);
}

function applyCallLensFromResult(result) {
  if (!inVideoCall || !isCallVideoTextMode()) return;
  let lens = String(result?.callLens || '').trim();
  const rawParts = [];
  if (result?.aiMessages?.length) {
    for (const m of result.aiMessages) {
      const c = String(m?.content || '').trim();
      if (c) rawParts.push(c);
    }
  }
  if (!rawParts.length && result?.content) rawParts.push(String(result.content || ''));
  const joined = rawParts.join('\n').trim();
  if (!lens && joined) {
    const scene = parseCallVideoTextSceneClient(joined);
    lens = scene.lens || joined;
  }
  // 旧 [镜头] 标记兜底
  if (!lens && joined) {
    const hit = extractCallLensClient(joined);
    if (hit) lens = hit;
  }
  if (lens) pushCallSceneLine(callDisplayText(lens) || lens);
  else syncCallVideoTextModeUi();
}

function setCallLensCaption(text) {
  const cap = document.getElementById('call-lens-caption');
  if (!cap) return;
  const t = String(text || '').trim();
  if (!inVideoCall || !isCallVideoTextMode()) {
    clearCallLensCaption(true);
    return;
  }
  syncCallVideoTextModeUi();
  if (!t) return;
  cap.hidden = false;
  cap.textContent = t;
  document.getElementById('call-screen')?.classList.add('has-call-lens');
  // 区域固定、内容滚动：新旁白贴上后滚到底，方便看最新镜头
  try { cap.scrollTop = cap.scrollHeight; } catch {}
}

function clearCallLensCaption(hide = false) {
  const cap = document.getElementById('call-lens-caption');
  if (!cap) return;
  if (hide) {
    cap.hidden = true;
    cap.textContent = '';
    const screen = document.getElementById('call-screen');
    screen?.classList.remove('has-call-lens');
    // 通话中文字画面模式不要摘掉 class，否则镜头条整段不显示，看起来像语音电话
    if (!inVideoCall || !isCallVideoTextMode()) {
      screen?.classList.remove('is-call-lens-text');
    }
  }
}

function extractCallLensClient(text) {
  const raw = String(text || '');
  const re = /\[\s*镜头\s*\]([\s\S]*?)\[\s*\/\s*镜头\s*\]/gi;
  let lens = '';
  let m;
  while ((m = re.exec(raw)) !== null) {
    lens = String(m[1] || '').trim().slice(0, 240);
  }
  return lens;
}

/**
 * 通话 TTS 分句：
 *   - 只按硬停顿（句号 / 问号 / 感叹号 / …）切，保留 [语气:xx]、[语速:xx]、
 *     [软声]…[/沉声] 等后端 TTS 需要看的标签；
 *   - 引号、分饰标签内不分；
 *   - 段内拿不到任何切点时整段返回，避免对长文本沉默地"只读第一句"。
 * 用于「一段话被一口气念出来」的问题：每段独立合成，段间加 ~500ms 静音，
 * 比让 MiniMax 自己排版节奏更稳。
 */
function splitForCallTTS(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  // 一段话没切点就直接整段返回，避免「本来只 1 句」被空隔断成两段
  const HARD_BREAK_RE = /[。．.！!？?]+|[…]{2,}/g;
  // 保护：这些开闭符内不算句号
  const OPENS = ['「', '『', '“', '（', '(', '[', '【', '［'];
  const CLOSES = ['」', '』', '”', '）', ')', ']', '】', '］'];
  // 「[软声]…[/软声]」一类的多字符标签也要保护
  const TAG_OPEN = ['[软声]', '[沉声]'];
  const TAG_CLOSE = ['[/软声]', '[/沉声]'];
  // 配对优先级：先扫多字符标签，再扫单字符括弧
  const matchesAny = (s, i, list) => {
    for (const t of list) if (s.startsWith(t, i)) return t;
    return null;
  };
  // 给定位置之前的「未闭合」深度：>0 表示在引号 / 标签内
  const depthAt = (idx) => {
    const stack = [];
    for (let i = 0; i <= idx; i++) {
      let tok = matchesAny(raw, i, TAG_OPEN);
      if (tok) { stack.push({ close: TAG_CLOSE[TAG_OPEN.indexOf(tok)] }); i += tok.length - 1; continue; }
      tok = matchesAny(raw, i, TAG_CLOSE);
      if (tok) {
        if (stack.length && stack[stack.length - 1].close === tok) stack.pop();
        i += tok.length - 1; continue;
      }
      tok = matchesAny(raw, i, OPENS);
      if (tok) { stack.push({ close: CLOSES[OPENS.indexOf(tok)] }); i += tok.length - 1; continue; }
      tok = matchesAny(raw, i, CLOSES);
      if (tok) {
        if (stack.length && stack[stack.length - 1].close === tok) stack.pop();
        i += tok.length - 1;
      }
    }
    return stack.length;
  };

  const cuts = [];
  let m;
  HARD_BREAK_RE.lastIndex = 0;
  while ((m = HARD_BREAK_RE.exec(raw))) {
    if (depthAt(m.index) > 0) continue;
    cuts.push(m.index + m[0].length);
  }
  const parts = [];
  let last = 0;
  for (const at of cuts) {
    const seg = raw.slice(last, at).trim();
    if (seg) parts.push(seg);
    last = at;
  }
  const tail = raw.slice(last).trim();
  if (tail) parts.push(tail);
  return parts.filter((p) => p && !looksTruncatedUtterance(p));
}

/** 通话段间停顿（毫秒）：够听清上一句尾音，又别让人等不耐烦 */
const CALL_SEGMENT_GAP_MS = 520;
/** 文字视频：两句台词中间夹了旁白时，停顿略长一点 */
const CALL_TEXT_VIDEO_QUOTE_GAP_MS = 900;

function parseCallAudioPayload(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (j?.texture && j.url) {
        return { kind: 'texture', url: j.url, volume: j.volume };
      }
      if (j?.breathBed && j.url) {
        return { kind: 'breathBed', url: j.url, volume: j.volume };
      }
      if (j?.sfx && j.ambience && (j.stop || !j.url)) {
        return { kind: 'stopAmbience' };
      }
      if (j?.sfx && j.url) {
        return {
          kind: j.ambience ? 'ambience' : 'oneshot',
          url: j.url,
          volume: j.volume,
          prompt: j.prompt || '',
        };
      }
      if (j?.vocal && j.url) {
        return { kind: 'clip', url: j.url, text: '', vocal: true };
      }
      if (j?.voice && j.url) {
        return { kind: 'clip', url: j.url, text: String(j.transcript || '').trim() };
      }
      if (j?.voice) {
        const text = String(j.transcript || '').trim();
        return text ? { kind: 'speech', text } : { kind: 'none' };
      }
    } catch {}
  }
  // 文字视频保留整段（旁白+台词）给画面；朗读时再抽引号。提前 callSpeakText 会把描写滤掉
  if (inVideoCall && isCallVideoTextMode()) {
    const raw = String(s || '').trim();
    return raw ? { kind: 'speech', text: raw } : { kind: 'none' };
  }
  const text = callSpeakText(s);
  return text ? { kind: 'speech', text } : { kind: 'none' };
}

function applyCallAmbienceField(field) {
  if (!field) return;
  if (field.stop || !field.url) {
    stopCallAmbient();
  } else {
    playCallAmbient(field.url, { volume: field.volume, prompt: field.prompt });
  }
  if (field.texture?.url) {
    playCallTextureBed(field.texture.url, { volume: field.texture.volume });
  }
  if (field.breath?.url) {
    playCallBreathBed(field.breath.url, { volume: field.breath.volume });
  }
}

function applyCallScenePayload(payload) {
  if (payload?.kind === 'stopAmbience') {
    stopCallAmbient();
  } else if (payload?.kind === 'ambience') {
    playCallAmbient(payload.url, { volume: payload.volume, prompt: payload.prompt });
  } else if (payload?.kind === 'texture') {
    playCallTextureBed(payload.url, { volume: payload.volume });
  } else if (payload?.kind === 'breathBed') {
    playCallBreathBed(payload.url, { volume: payload.volume });
  } else if (payload?.kind === 'oneshot') {
    playCallOneShot(payload.url);
  }
}

async function playCallSpeechPayload(payload, forCharId, msgId, extra = {}) {
  if (payload?.kind === 'clip') {
    await playCallTtsSegment(payload.text, forCharId, { msgId, clipUrl: payload.url, ...extra });
  } else if (payload?.kind === 'speech') {
    await playCallTtsSegment(payload.text, forCharId, { msgId, ...extra });
  }
}

async function persistCallTtsClip(msgId, blobUrl, transcript) {
  const id = Number(msgId);
  if (!Number.isFinite(id) || id <= 0 || !blobUrl) return;
  try {
    const resp = await fetch(blobUrl);
    const blob = await resp.blob();
    if (!blob.size) return;
    let durationSec = Math.max(1, Math.min(60, Math.ceil((String(transcript || '').length || 10) / 4)));
    try {
      const probed = await probeAudioBlobDuration(blob);
      if (probed > 0.4) durationSec = Math.max(1, Math.round(probed));
    } catch { /* 用字数估时长即可 */ }
    const mime = blob.type || 'audio/mpeg';
    const ext = /wav/i.test(mime) ? 'wav' : (/ogg/i.test(mime) ? 'ogg' : 'mp3');
    const file = new File([blob], `call-tts-${id}.${ext}`, { type: mime });
    const uploaded = await api.uploadChatVoice(file, durationSec);
    if (!uploaded?.url) return;
    const content = encodeUserVoiceContent({
      url: uploaded.url,
      duration: uploaded.duration || durationSec,
      transcript: String(transcript || ''),
    });
    await api.updateMessage(id, { content });
    const src = window.resolveMediaUrl?.(uploaded.url) || uploaded.url;
    const list = document.getElementById('messages-list');
    let wrap = null;
    try {
      const s = CSS.escape(String(id));
      wrap = list?.querySelector(`.bubble-wrap[data-msg-id="${s}"], .bubble-wrap[data-id="${s}"]`);
    } catch { wrap = null; }
    const bubble = wrap?.querySelector('.voice-bubble');
    if (bubble && src) bubble.dataset.voiceSrc = src;
  } catch (e) {
    console.warn('[call] persist tts', e?.message || e);
  }
}

async function playCallTtsSegment(text, forCharId, { msgId, clipUrl, armListen = true, emotion, tone, soft, skipScenePush = false } = {}) {
  if (!isInVoiceCallWith(forCharId)) return;
  if (msgId != null && wasCallSpeechPlayed(msgId)) {
    if (armListen) await armCallLiveAfterSpeak();
    return;
  }
  const t = callSpeakText(text);
  const shown = callDisplayText(text) || stripVoiceLaneTags(t).trim();
  const needAnswer = callDialing && Number(forCharId) === Number(callCharId);
  const textVideoMode = !!(inVideoCall && isCallVideoTextMode());
  // 文字视频场景条只推一次：applyCallLensFromResult 已推过就别再塞一份（否则一整段 + 拆句各一条）
  if (textVideoMode && shown && !skipScenePush) pushCallSceneLine(shown);
  // 无可读文本时也要接通：否则首句是 [安静]/空气泡会卡在拨号页
  if (!t && !clipUrl) {
    if (needAnswer) {
      const answered = await answerPendingCall({ enableVoice: true });
      if (answered && isInVoiceCallWith(forCharId) && armListen) await armCallLiveAfterSpeak();
    } else if (armListen && textVideoMode) {
      await armCallLiveAfterSpeak();
    }
    return;
  }
  const last = callTranscript[callTranscript.length - 1];
  if (shown && last?.role === 'assistant' && last.content === shown && msgId != null && wasCallSpeechPlayed(msgId)) {
    if (armListen) await armCallLiveAfterSpeak();
    return;
  }

  const useSoft = soft || _callSoftTtsNext;
  if (_callSoftTtsNext) _callSoftTtsNext = false;

  // 文字视频：按引号台词分段（中间旁白=画面停顿）；漏引号时用 callSpeakText 的兜底句
  let ttsSegments;
  let textVideoQuoteGap = false;
  if (clipUrl || !t) {
    ttsSegments = [t].filter(Boolean);
  } else if (textVideoMode) {
    const quotes = extractQuotedSpeechParts(String(text || ''));
    if (quotes.length) {
      ttsSegments = quotes;
      textVideoQuoteGap = quotes.length > 1;
    } else {
      ttsSegments = splitForCallTTS(t);
    }
  } else {
    ttsSegments = splitForCallTTS(t);
  }
  if (!ttsSegments.length && t) ttsSegments = [t];
  // 整段只一段时下面走老的「单段」路径，不做无谓的二次网络请求与停顿
  const useSplitPlay = ttsSegments.length > 1;

  const hasVoice = charHasVoiceId(getCharMeta(forCharId));
  const urls = [];
  if (clipUrl) {
    urls.push(clipUrl);
  } else if (t && hasVoice) {
    if (useSplitPlay) {
      // 先并发预取所有段（短路：任一段拿不到就回退整段）
      const fetched = await Promise.all(ttsSegments.map((seg) => prefetchTTS(seg, forCharId, {
        inCall: true,
        emotion: String(emotion || '').trim() || undefined,
        tone: String(tone || '').trim() || undefined,
      })));
      if (!isInVoiceCallWith(forCharId)) return;
      // 任一段失败就回退到整段方案：避免半段沉默听感更差
      if (fetched.some((u) => !u)) {
        const fallback = await prefetchTTS(t, forCharId, {
          inCall: true,
          emotion: String(emotion || '').trim() || undefined,
          tone: String(tone || '').trim() || undefined,
        });
        if (!isInVoiceCallWith(forCharId)) return;
        if (fallback) urls.push(fallback);
      } else {
        urls.push(...fetched);
      }
    } else {
      const one = await prefetchTTS(t, forCharId, {
        inCall: true,
        emotion: String(emotion || '').trim() || undefined,
        tone: String(tone || '').trim() || undefined,
      });
      if (!isInVoiceCallWith(forCharId)) return;
      if (one) urls.push(one);
    }
    // 只在单段合成（或整段回退）时存为消息语音条；分段时仍存，但只记首段
    if (urls[0] && msgId && !useSplitPlay) persistCallTtsClip(msgId, urls[0], shown || t);
  }
  if (needAnswer) {
    // 语音已就绪：等最短振铃 → 接通（新引擎）
    const answered = await connectWhenOpenerReady();
    // 同步本地拨号标志，避免其它逻辑仍以为在 dialing
    if (answered) {
      callDialing = false;
      _dialRingUntil = 0;
    }
    if (!answered || !isInVoiceCallWith(forCharId)) return;
  }

  if (clipUrl && !t) {
    await new Promise((r) => setTimeout(r, 380));
    if (!isInVoiceCallWith(forCharId)) return;
  }

  if (!textVideoMode && shown && shown !== '……' && shown !== '…') {
    const dup = callTranscript[callTranscript.length - 1];
    if (!(dup?.role === 'assistant' && dup.content === shown)) {
      callTranscript.push({ role: 'assistant', content: shown });
      appendCallChatMsg('assistant', shown);
    }
  }
  if (urls.length) {
    const playGen = ++_callTtsPlayGen;
    const segGapMs = textVideoQuoteGap
      ? CALL_TEXT_VIDEO_QUOTE_GAP_MS
      : (isCallRealtimeTalk() ? CALL_REALTIME_SEGMENT_GAP_MS : CALL_SEGMENT_GAP_MS);
    if (isCallRealtimeTalk() && useNativeCallAudio()) {
      try {
        await setNativeCallListen(true, { ambient: false, bargeIn: true });
      } catch {}
    }
    setCallSpeaking(true);
    await setNativeCallMediaAudio(true);
    try { duckCallAmbient(false); } catch {}
    try { ensureCallAmbientPlaying(); } catch {}
    let allOk = true;
    let firstErr = '';
    for (let i = 0; i < urls.length; i++) {
      // 段间停顿：被取消 / 通话结束 / 别人插话 时立刻停
      if (i > 0) {
        await sleepMs(segGapMs);
        if (playGen !== _callTtsPlayGen || !isInVoiceCallWith(forCharId)) { allOk = false; break; }
      }
      const lastSeg = i === urls.length - 1;
      const ok = await playReadyTTS(urls[i], () => {
        if (playGen !== _callTtsPlayGen) return;
        if (lastSeg) {
          setCallSpeaking(false);
          setCallIdleStatus();
        }
      }, useSoft ? { volume: 0.48 } : (textVideoMode ? { volume: 1.55 } : undefined));
      if (playGen !== _callTtsPlayGen) { allOk = false; break; }
      if (!ok) {
        allOk = false;
        if (!firstErr) firstErr = getLastTtsError() || '';
        break;
      }
      try { ensureCallAmbientPlaying(); } catch {}
    }
    if (playGen === _callTtsPlayGen) setCallSpeaking(false);
    setCallIdleStatus();
    try { duckCallAmbient(false); } catch {}
    try { ensureCallAmbientPlaying(); } catch {}
    if (allOk) markCallSpeechPlayed(msgId);
    if (!allOk && firstErr && !/自动播放|NotAllowed|interact/i.test(firstErr)) {
      window.showToast?.('语音播放失败: ' + firstErr);
    }
  } else {
    setCallIdleStatus();
    if (t && !hasVoice) {
      window.showToast?.('角色未配置声音 ID，通话没有语音');
    } else if (t) {
      markCallSpeechPlayed(msgId);
    }
  }
  // 开场白播完（或无需播）再开麦听
  if (!_callVoiceMode && isInVoiceCallWith(forCharId) && !callDialing) {
    setCallVoiceMode(true);
  }
  if (armListen) await armCallLiveAfterSpeak();
}

function jumpMessagesToBottom() {
  const area = document.getElementById('messages-area');
  if (!area) return;
  _chatScrollLock = null;
  area.style.scrollBehavior = 'auto';
  area.scrollTop = area.scrollHeight;
}

window.__nianJumpChatBottom = jumpMessagesToBottom;

function revealMessagesAtBottom() {
  const area = document.getElementById('messages-area');
  if (!area) return;
  jumpMessagesToBottom();
  requestAnimationFrame(() => {
    jumpMessagesToBottom();
    requestAnimationFrame(() => {
      jumpMessagesToBottom();
      area.classList.remove('is-opening');
    });
  });
}

function scrollBottom(smooth = false) {
  const area = document.getElementById('messages-area');
  if (!area) return;
  // 正在上翻看历史时不要 smooth 跟到底：目标 scrollHeight 一旦因顶部插入变掉，会闪到很早的消息
  if (smooth && !isMessagesNearBottom(160)) return;
  if (smooth) area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
  else jumpMessagesToBottom();
}

// ===== 发送消息 =====
window.sendChatMessage = async function() {
  const input = document.getElementById('chat-input');
  let text = input?.value.trim() || '';

  if (!charId) return;

  // 切页/切后台时输入法收起常塞一个「。」并误点发送
  if (text && shouldBlockImeSpuriousSend(text, input)) {
    input.value = '';
    autoResize?.(input);
    return;
  }
  if (!isChatPageDomActive()) {
    if (text && isSpuriousUserText(text)) {
      input.value = '';
      autoResize?.(input);
    }
    return;
  }

  // 游戏进行中：消息交给游戏管家，不触发普通聊天 AI
  if (isGameButlerActive(charId)) {
    const input = document.getElementById('chat-input');
    const text = input?.value.trim() || '';
    if (!text) { window.showToast?.('请输入内容'); return; }
    input.value = '';
    autoResize(input);
    await onGameButlerUserSend(text);
    return;
  }

  const hasQueued = _pendingAiCount > 0;

  // 有文字：若已有攒消息（如表情包）则只入库，否则正常发送并触发回复
  if (text) {
    input.value = '';
    autoResize(input);

    if (pendingMsgs.length > 0) {
      pendingMsgs.push(text);
      savePendingMessages(charId, pendingMsgs);
      updatePendingUI();
      return;
    }

    if (hasQueued) {
      await doSend(text, 'text', {}, true);
      _pendingAiCount = 0;
      updatePendingBadge();
      await triggerAiReply({ mode: 'retry' });
      return;
    }

    _pendingAiCount = 0;
    updatePendingBadge();
    await doSend(text);
    return;
  }

  // 空输入：有攒消息时统一触发 AI 回复（表情包 / 多条文字）
  if (hasQueued) {
    _pendingAiCount = 0;
    updatePendingBadge();
    await triggerAiReply({ mode: 'retry' });
    return;
  }

  _pendingAiCount = 0;
  updatePendingBadge();
  await triggerAiReply();
};

function resolveTriggerAiModeFromDom() {
  const list = document.getElementById('messages-list');
  const bubbles = [...(list?.querySelectorAll('.bubble-wrap[data-role]') || [])];
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const role = bubbles[i].dataset.role;
    if (role === 'user') return 'retry';
    if (role === 'assistant') return 'continue';
  }
  return '';
}

async function resolveTriggerAiMode() {
  if (_pendingAiCount > 0 || _pendingUserMsgIds.size > 0) return 'retry';
  const fromDom = resolveTriggerAiModeFromDom();
  if (fromDom) return fromDom;
  try {
    const msgs = await api.getMessages(charId, { dream: isDream ? 1 : 0, limit: 12, offset: 0 });
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.recalled) continue;
      if (m.type === 'system') continue;
      return m.role === 'user' ? 'retry' : 'continue';
    }
  } catch { /* fall through */ }
  return 'retry';
}

/** 清掉「最后一条用户消息」之后的角色气泡（库 + DOM），给重新生成腾地方 */
async function clearAiRepliesAfterLastUser(forCharId = charId) {
  if (!forCharId) return { ok: false, reason: 'no_char' };
  const msgs = await api.getMessages(forCharId, { dream: isDream ? 1 : 0, limit: 200, offset: 0 });
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && !msgs[i].recalled) { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return { ok: false, reason: 'no_user', msgs };
  const aiAfter = msgs.slice(lastUserIdx + 1).filter(m => m.role === 'assistant');
  if (!aiAfter.length) return { ok: true, cleared: 0, msgs, lastUserIdx };

  const ids = aiAfter.map(m => m.id).filter(Boolean);
  if (ids.length) {
    try {
      await api.deleteMessagesByIds(ids);
    } catch {
      for (const id of ids) {
        try { await api.deleteMessage(id); } catch {}
      }
    }
  }

  if (Number(forCharId) === Number(charId)) {
    removeAiBubblesAfterLastUserInDom();
  }
  if (ids.length) removeThreadMessages(forCharId, isDream, ids);
  return { ok: true, cleared: aiAfter.length, msgs, lastUserIdx, ids };
}

function removeAiBubblesAfterLastUserInDom() {
  const list = document.getElementById('messages-list');
  if (!list) return;
  const allBubbles = [...list.querySelectorAll('.bubble-wrap[data-role]')];
  let lastUserBubbleIdx = -1;
  allBubbles.forEach((b, i) => { if (b.dataset.role === 'user') lastUserBubbleIdx = i; });
  for (let i = allBubbles.length - 1; i > lastUserBubbleIdx; i--) {
    removeChatBubbleEl(allBubbles[i]);
  }
}

function removeBubblesByMessageIds(ids) {
  if (!ids?.length) return;
  const list = document.getElementById('messages-list');
  if (!list) return;
  const idSet = new Set(ids.map(String));
  list.querySelectorAll('.bubble-wrap[data-id], .bubble-wrap[data-msg-id], .bubble-time[data-id]').forEach(el => {
    const a = String(el.dataset.msgId || el.dataset.id || '');
    if (idSet.has(a)) {
      removeChatBubbleEl(el);
      return;
    }
    // hist_${id}_${i} / vseg_${id}_${ts}_${i} / seg_${id}_${i}
    if (/^(hist|vseg|seg)_/.test(a)) {
      const mid = a.split('_')[1];
      if (idSet.has(mid)) removeChatBubbleEl(el);
    }
  });
}
window.removeBubblesByMessageIds = removeBubblesByMessageIds;

// 空按发送：重新触发 AI 回复（retry 或 continue）
async function triggerAiReply(opts = {}) {
  if (isBusyBlocking()) {
    window.showToast?.('对方忙碌中，消息已记录');
    return;
  }
  if (_doSendBusy) {
    window.showToast?.('上一条还在发送中，请稍候');
    return;
  }
  const sendCharId = charId;
  const list = document.getElementById('messages-list');
  if (!list) return;

  _doSendBusy = true;
  jumpMessagesToBottom();

  await _saveQueue;
  clearPendingUserMsgs();
  _pendingAiCount = 0;
  updatePendingBadge();

  const mode = opts.mode || await resolveTriggerAiMode();
  // retry：先清旧角色回复，避免空按发送时旧气泡和新回复叠在一起
  if (mode === 'retry') {
    try { await clearAiRepliesAfterLastUser(sendCharId); } catch {}
  }

  startWaitTypingPulse(sendCharId);

  const runOnce = async () => {
    const inThisCall = isInVoiceCallWith(sendCharId);
    const lookUrl = inThisCall ? await maybeCaptureLookForSend('') : '';
    return triggerAiAndWaitTyping(
      sendCharId, isDream, mode, false, null, inThisCall, false,
      getGameTopicContextForAi(), null, null, callTriggerExtra(lookUrl),
    );
  };

  let emptyNudge = false;
  try {
    let result = await runOnce();
    rememberAiReplyResult(result);

    // 忙碌静默 / 桌宠看镜头占位：也要走 apply，别静默吞掉
    if (result?.isBusy || result?.robotLooking) {
      await applyAiReplyResult(result, new Date().toISOString(), sendCharId);
      if (result.robotLooking && replyLooksEmpty(result)) {
        const recovered = await recoverSavedAiReply(sendCharId);
        if (!recovered) {
          try { await syncNewMessages(); } catch {}
        }
      }
      return;
    }

    if (hasAiReplyPayload(result) && !replyLooksEmpty(result)) {
      _emptyAiNudgeCount = 0;
      await applyAiReplyResult(result, new Date().toISOString(), sendCharId);
      return;
    }

    // 空回包：先捞库里是否其实已写入，再考虑自动顶「嗯」或静默重试一次
    stopWaitTypingPulse(true);
    let recovered = await recoverSavedAiReply(sendCharId);
    if (!recovered) {
      try { await syncNewMessages(); } catch {}
      recovered = await recoverSavedAiReply(sendCharId);
    }
    if (recovered) return;

    if (shouldNudgeEmptyAiReply(result, { fromCall: isInVoiceCallWith(sendCharId) })) {
      emptyNudge = true;
      return;
    }

    // 上游偶发空回/中转抽风：打包发送自动再试一次
    if (!opts._retried) {
      startWaitTypingPulse(sendCharId);
      result = await runOnce();
      rememberAiReplyResult(result);
      if (hasAiReplyPayload(result) && !replyLooksEmpty(result)) {
        _emptyAiNudgeCount = 0;
        await applyAiReplyResult(result, new Date().toISOString(), sendCharId);
        return;
      }
      recovered = await recoverSavedAiReply(sendCharId);
      if (recovered) return;
      if (shouldNudgeEmptyAiReply(result, { fromCall: isInVoiceCallWith(sendCharId) })) {
        emptyNudge = true;
        return;
      }
    }

    stopWaitTypingPulse(true);
    showCharTypingFor(sendCharId, false);
    window.showToast?.('对方这轮没回上，再点一次 ↑ 试试');
  } catch (e) {
    stopWaitTypingPulse(true);
    showCharTypingFor(sendCharId, false);
    let recovered = await recoverSavedAiReply(sendCharId);
    if (!recovered) {
      try { await syncNewMessages(); } catch {}
      recovered = await recoverSavedAiReply(sendCharId);
    }
    if (recovered) return;

    const msg = String(e?.message || '');
    const timedOut = /超时|aborted|abort/i.test(msg);
    // 超时/上游失败：自动重试一次（打包发送最常见）
    if (!opts._retried && (timedOut || /上游|500|502|503|中转|网络/i.test(msg))) {
      try {
        startWaitTypingPulse(sendCharId);
        const result = await runOnce();
        rememberAiReplyResult(result);
        if (hasAiReplyPayload(result) && !replyLooksEmpty(result)) {
          _emptyAiNudgeCount = 0;
          await applyAiReplyResult(result, new Date().toISOString(), sendCharId);
          return;
        }
        recovered = await recoverSavedAiReply(sendCharId);
        if (recovered) return;
        if (shouldNudgeEmptyAiReply(result, { fromCall: isInVoiceCallWith(sendCharId) })) {
          emptyNudge = true;
          return;
        }
      } catch (e2) {
        recovered = await recoverSavedAiReply(sendCharId);
        if (recovered) return;
        const msg2 = String(e2?.message || msg);
        if (isEmptyAiReplyError(e2) && !isInVoiceCallWith(sendCharId) && !isDream) {
          emptyNudge = true;
        } else {
          window.showToast?.(
            /超时|aborted|abort/i.test(msg2)
              ? '角色回复超时，已重试仍未成功。可再点 ↑；若其实已回，下拉刷新聊天'
              : `触发失败: ${msg2}`,
          );
        }
        return;
      }
    }

    if (isEmptyAiReplyError(e) && !isInVoiceCallWith(sendCharId) && !isDream) {
      emptyNudge = true;
    } else if (timedOut) {
      window.showToast?.('角色回复超时：可能 API 太慢。已尝试刷新；若已回可直接看气泡，否则再点 ↑');
    } else {
      window.showToast?.('触发失败: ' + msg);
    }
  } finally {
    _doSendBusy = false;
  }
  if (emptyNudge) await maybeNudgeEmptyAiReply(sendCharId);
}

// 展示一组 AI 气泡（第一条立刻出，后面按上一条阅读停留）
async function renderAiBubbles(segments, msgId, userTimestamp, msgType = 'text', forCharId = charId) {
  const parts = (segments || []).filter((seg) => String(seg || '').trim());
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!shouldRenderForChar(forCharId)) return;
    const prev = i > 0 ? parts[i - 1] : null;
    await pauseBeforeAiBubble(forCharId, prev ? { type: msgType, content: prev } : { type: msgType, content: seg }, {
      afterVisible: i > 0,
      kindMsg: { type: msgType, content: seg },
    });
    if (!shouldRenderForChar(forCharId)) return;
    const isLast = i === parts.length - 1;
    await appendAiBubble({
      id: parts.length === 1 ? msgId : (isLast ? msgId : `hist_${msgId}_${i}`),
      dbId: msgId,
      type: msgType,
      content: seg,
    }, i === 0 ? userTimestamp : null, forCharId);
  }
}

async function appendAiBubble(msg, userTimestamp, forCharId = charId) {
  // 成图 WS 可能已到：用就绪 URL，避免 HTTP 快照里的 __pending_*__ 一直占着
  let hydrated = (msg?.type === 'image' || msg?.type === 'video')
    ? hydrateMediaMsgFromReadyCache(msg)
    : msg;
  if (hydrated && hydrated.type !== 'emoji' && hydrated.type !== 'image' && hydrated.type !== 'video'
    && hydrated.type !== 'link' && looksLikeWebCardPayload(hydrated.content)) {
    hydrated = { ...hydrated, type: 'web_card' };
  }
  const aiNow = new Date().toISOString();
  const msgTs = hydrated.timestamp || aiNow;
  const content = hydrated.content || '';
  let preview = hydrated.type === 'emoji' ? '[表情包]'
    : hydrated.type === 'location' ? '[位置]'
    : hydrated.type === 'link' ? '[链接]'
    : hydrated.type === 'web_card' ? (() => {
      try {
        const j = JSON.parse(String(content || ''));
        return j?.title ? `[网页卡] ${j.title}` : '[网页卡]';
      } catch { return '[网页卡]'; }
    })()
    : (hydrated.type === 'image' || hydrated.type === 'video' ? '[图片]' : content);
  if (hydrated.type === 'voice') {
    preview = '[语音]';
    try {
      const j = JSON.parse(String(content || ''));
      if (j?.score) preview = j.transcript || '♪ 演奏';
      else if (j?.voice && j.transcript) preview = `[语音] ${j.transcript}`;
    } catch { /* TTS 纯文本语音条 */ }
  }

  const inThisCall = isInVoiceCallWith(forCharId);
  const onChatPage = shouldRenderForChar(forCharId);
  if (!onChatPage && !inThisCall) {
    // 离页后不再逐条弹通知/加未读（整轮由 applyAiReplyResult / WS 统一处理）
    return;
  }

  // HTTP 与 WS 可能先后到达：已在 DOM 则跳过，避免聊天气泡和通话字幕双份
  if (hydrated?.id != null && isAiMsgInDom(hydrated.id)) {
    // 占位气泡已在、本次已有成图结果 → 就地替换，不要因去重直接 return
    if ((hydrated.type === 'image' || hydrated.type === 'video')
      && !isPlaceholderMediaContent(content)) {
      const listEl = document.getElementById('messages-list');
      let wrap;
      try {
        const s = CSS.escape(String(hydrated.id));
        wrap = listEl?.querySelector(`.bubble-wrap[data-msg-id="${s}"], .bubble-wrap[data-id="${s}"]`);
      } catch { wrap = null; }
      if (wrap && applyReadyMediaToBubble(wrap, hydrated)) scrollBottom(true);
    }
    // 通话中：气泡可能被 sync 先画上但听筒没播
    const msgType = hydrated.type || 'text';
    if (isInVoiceCallWith(forCharId) && content.trim() && (msgType === 'text' || msgType === 'voice')
      && !looksLikeWebCardPayload(content)
      && !wasCallSpeechPlayed(hydrated.id)) {
      const payload = parseCallAudioPayload(content);
      applyCallScenePayload(payload);
      let emo = String(hydrated.tts_emotion || '').trim();
      let tone = String(hydrated.tts_tone || '').trim();
      if ((!emo || !tone) && hydrated.media_meta) {
        try {
          const meta = typeof hydrated.media_meta === 'string'
            ? JSON.parse(hydrated.media_meta)
            : hydrated.media_meta;
          if (!emo) emo = String(meta?.tts_emotion || '').trim();
          if (!tone) tone = String(meta?.tts_tone || '').trim();
        } catch { /* ignore */ }
      }
      await playCallSpeechPayload(payload, forCharId, hydrated.id, {
        armListen: false,
        emotion: emo || undefined,
        tone: tone || undefined,
        skipScenePush: !!(inVideoCall && isCallVideoTextMode()),
      });
    }
    return;
  }

  const list = document.getElementById('messages-list');
  const charMeta = getCharMeta(forCharId);
  const tsPos2 = getChatSettings(forCharId).timestampPosition || 'divider';
  const onPage = onChatPage;
  const bubbleHtml = buildBubble({
    id: hydrated.id,
    dbId: hydrated.id,
    role: 'assistant',
    content,
    type: hydrated.type || 'text',
    location: hydrated.location || (hydrated.type === 'location' ? content : ''),
    timestamp: msgTs,
    is_read: onPage ? 1 : hydrated.is_read,
    lat: hydrated.lat,
    lng: hydrated.lng,
    media_meta: hydrated.media_meta,
    reply_preview: hydrated.replyPreview || hydrated.reply_preview || '',
    aspect: hydrated.aspect || hydrated.media_aspect,
    media_aspect: hydrated.media_aspect || hydrated.aspect,
  }, charMeta, {}, { charId: forCharId });
  if (!bubbleHtml) return;

  // 拨出开场：先合成语音再接通；接通前不往聊天列表塞气泡，避免「先出字再转语音」
  const holdBubbleForDial = callDialing && Number(forCharId) === Number(callCharId)
    && (hydrated.type === 'text' || hydrated.type === 'voice' || !hydrated.type);

  const paintBubble = () => {
    if (!onPage || !list) return;
    if (hydrated?.id != null && isAiMsgInDom(hydrated.id)) return;
    if (userTimestamp && tsPos2 === 'divider' && shouldInsertTimeDivider(userTimestamp, msgTs, 10)) {
      list.insertAdjacentHTML('beforeend', buildTimeDivider(msgTs, forCharId));
    }
    list.insertAdjacentHTML('beforeend', bubbleHtml);
    scrollBottom(true);
    if (hydrated.type === 'location') hydrateLocationCardMaps(list);
    if (hydrated.type === 'web_card') hydrateWebCards(list);
    markAiBubbleReadNow(forCharId, hydrated.id);
  };

  if (!holdBubbleForDial) paintBubble();

  // 同轮撤回：这句"发出去"后过一小会儿自动变成"已撤回"，不阻塞后面消息继续出现
  if (onPage && hydrated.recallAfterSend && hydrated.id != null && content.trim()) {
    const recallDelay = Math.min(Math.max(content.length * 45, 700), 1800);
    setTimeout(() => { applyRecalledUiForMsg(hydrated.id, content); }, recallDelay);
  }

  const msgType = hydrated.type || 'text';
  if (isInVoiceCallWith(forCharId) && content.trim() && (msgType === 'text' || msgType === 'voice')
    && !looksLikeWebCardPayload(content)) {
    const payload = parseCallAudioPayload(content);
    applyCallScenePayload(payload);
    let emo = String(hydrated.tts_emotion || '').trim();
    let tone = String(hydrated.tts_tone || '').trim();
    if ((!emo || !tone) && hydrated.media_meta) {
      try {
        const meta = typeof hydrated.media_meta === 'string'
          ? JSON.parse(hydrated.media_meta)
          : hydrated.media_meta;
        if (!emo) emo = String(meta?.tts_emotion || '').trim();
        if (!tone) tone = String(meta?.tts_tone || '').trim();
      } catch { /* ignore */ }
    }
    await playCallSpeechPayload(payload, forCharId, hydrated.id, {
      armListen: false,
      emotion: emo || undefined,
      tone: tone || undefined,
      // 场景条已由 applyCallLensFromResult 推过，这里只播声音
      skipScenePush: !!(inVideoCall && isCallVideoTextMode()),
    });
    if (holdBubbleForDial) paintBubble();
  } else if (holdBubbleForDial) {
    paintBubble();
  }
}

async function renderAiMessageSequence(aiMessages, userTimestamp, forCharId = charId, options = {}) {
  const { skipTyping = false, callMode = false } = options;
  const noSplit = callMode || isInVoiceCallWith(forCharId);
  if (!aiMessages?.length) return;

  if (noSplit && isInVoiceCallWith(forCharId)) {
    for (const m of aiMessages) {
      if (m?.type === 'text' || m?.type === 'voice') {
        applyCallScenePayload(parseCallAudioPayload(m.content));
      }
    }
  }

  // 通话中：同轮说话合并成一条再画气泡（音效/隐藏消息不打断）
  const paintMsgs = (() => {
    if (!noSplit) return aiMessages;
    const out = [];
    let speechBuf = [];
    const flushSpeech = () => {
      if (!speechBuf.length) return;
      if (speechBuf.length === 1) {
        out.push(speechBuf[0]);
      } else {
        const bits = speechBuf.map((m) => String(m.content || '').trim()).filter(Boolean);
        const head = speechBuf[0];
        out.push({
          ...head,
          type: head.type === 'voice' || speechBuf.some((m) => m.type === 'voice') ? 'voice' : 'text',
          content: bits.join('\n'),
          media_meta: (() => {
            try {
              const meta = typeof head.media_meta === 'string'
                ? JSON.parse(head.media_meta || '{}')
                : (head.media_meta || {});
              return JSON.stringify({ ...meta, callLine: 1 });
            } catch {
              return JSON.stringify({ callLine: 1 });
            }
          })(),
        });
      }
      speechBuf = [];
    };
    for (const m of aiMessages) {
      if (!m || isHiddenChatMessage(m)) {
        flushSpeech();
        if (m) out.push(m);
        continue;
      }
      // 音效 JSON：只播不占聊天气泡
      if (m.type === 'voice' && String(m.content || '').trim().startsWith('{')) {
        try {
          const j = JSON.parse(m.content);
          if (j?.sfx) {
            flushSpeech();
            out.push(m);
            continue;
          }
        } catch { /* normal voice */ }
      }
      if (m.type === 'text' || m.type === 'voice') {
        speechBuf.push(m);
        continue;
      }
      flushSpeech();
      out.push(m);
    }
    flushSpeech();
    return out.length ? out : aiMessages;
  })();

  let lastShown = null;
  let lastShownEmoji = false;

  async function waitBeforeNext(nextMsg, isEmoji = false) {
    if (lastShown != null) {
      await pauseBeforeAiBubble(forCharId, lastShown, {
        skip: skipTyping,
        afterVisible: true,
        isEmoji: lastShownEmoji,
        kindMsg: nextMsg,
      });
    } else {
      await pauseBeforeAiBubble(forCharId, nextMsg, { skip: skipTyping, isEmoji });
    }
  }

  function markShown(msg, isEmoji = false) {
    lastShown = msg;
    lastShownEmoji = isEmoji;
  }

  for (let i = 0; i < paintMsgs.length; i++) {
    const msg = paintMsgs[i];
    if (isHiddenChatMessage(msg)) continue;
    // 通话中音效只走听筒，不占聊天气泡（含旧数据未打 hideChat 的 oneshot）
    if (noSplit && msg.type === 'voice' && String(msg.content || '').trim().startsWith('{')) {
      try {
        if (JSON.parse(msg.content)?.sfx) {
          if (isInVoiceCallWith(forCharId) && !wasCallSpeechPlayed(msg.id)) {
            const payload = parseCallAudioPayload(msg.content);
            applyCallScenePayload(payload);
            await playCallSpeechPayload(payload, forCharId, msg.id, { armListen: false });
          }
          continue;
        }
      } catch { /* normal voice */ }
    }
    await waitBeforeNext(msg, msg.type === 'emoji');
    if (!shouldRenderForChar(forCharId) && !isInVoiceCallWith(forCharId)) {
      // 中途离页/闸门误判：已写入缓存的消息靠 sync/回页补画，勿再卡死在「seen 但无 DOM」
      return;
    }

    if ((msg.type === 'text' || msg.type === 'voice') && looksLikeWebCardPayload(msg.content)) {
      await appendAiBubble({ ...msg, type: 'web_card' }, i === 0 ? userTimestamp : null, forCharId);
      markShown(msg, false);
    } else if (noSplit && (msg.type === 'text' || msg.type === 'voice')) {
      await appendAiBubble(msg, i === 0 ? userTimestamp : null, forCharId);
      markShown(msg, false);
    } else if (msg.type === 'text' && looksLikeWebCardPayload(msg.content)) {
      await appendAiBubble({ ...msg, type: 'web_card' }, i === 0 ? userTimestamp : null, forCharId);
      markShown(msg, false);
    } else if (msg.type === 'text') {
      if (isCallLineMessage(msg)) {
        await appendAiBubble(msg, i === 0 ? userTimestamp : null, forCharId);
        markShown(msg, false);
      } else {
        const segments = splitAiSegments(msg.content).filter((s) => String(s || '').trim());
        if (!segments.length) continue;
        for (let j = 0; j < segments.length; j++) {
          if (j > 0) await waitBeforeNext(segments[j]);
          if (!shouldRenderForChar(forCharId) && !isInVoiceCallWith(forCharId)) return;
          const isLast = j === segments.length - 1;
          // 与 buildMessagesHtml 一致用 hist_，避免回前台 purge 误删分段
          await appendAiBubble({
            id: segments.length === 1 ? msg.id : (isLast ? msg.id : `hist_${msg.id}_${j}`),
            dbId: msg.id,
            type: 'text',
            content: segments[j],
            timestamp: msg.timestamp,
            replyPreview: j === 0 ? msg.replyPreview : '',
            recallAfterSend: isLast ? msg.recallAfterSend : false,
          }, i === 0 && j === 0 ? userTimestamp : null, forCharId);
          markShown(segments[j], false);
        }
      }
    } else if (msg.type === 'voice') {
      if (isCallLineMessage(msg)) {
        await appendAiBubble(msg, i === 0 ? userTimestamp : null, forCharId);
        markShown(msg, false);
      } else {
        const segments = voiceBubbleSegments(msg.content);
        for (let j = 0; j < segments.length; j++) {
          if (j > 0) await waitBeforeNext(segments[j]);
          if (!shouldRenderForChar(forCharId) && !isInVoiceCallWith(forCharId)) return;
          const isLast = j === segments.length - 1;
          const segId = segments.length === 1
            ? msg.id
            : (isLast ? msg.id : `hist_${msg.id}_${j}`);
          await appendAiBubble({
            id: segId,
            dbId: msg.id,
            type: 'voice',
            content: segments[j],
            timestamp: msg.timestamp,
            replyPreview: j === 0 ? msg.replyPreview : '',
            recallAfterSend: isLast ? msg.recallAfterSend : false,
            media_meta: msg.media_meta,
          }, i === 0 && j === 0 ? userTimestamp : null, forCharId);
          markShown(segments[j], false);
        }
      }
    } else if (msg.type === 'emoji' || msg.type === 'image' || msg.type === 'video' || msg.type === 'location' || msg.type === 'link' || msg.type === 'web_card') {
      await appendAiBubble(msg, i === 0 ? userTimestamp : null, forCharId);
      markShown(msg, msg.type === 'emoji');
    } else {
      await appendAiBubble(msg, i === 0 ? userTimestamp : null, forCharId);
      markShown(msg, false);
    }
  }
  if (noSplit && isInVoiceCallWith(forCharId)) await armCallLiveAfterSpeak();
}

async function applyAiReplyResult(result, userTimestamp, forCharId = charId) {
  stopWaitTypingPulse(true);
  // 角色已回：清掉「等回复」标记，避免自己气泡长按一直没有「编辑」
  if (Number(forCharId) === Number(charId)) clearPendingUserMsgs();
  const onPage = shouldRenderForChar(forCharId);
  // 先记下 id，再开打字动画；否则 WS 推送会在 DOM 还没气泡时再渲染一轮
  rememberAiReplyResult(result);
  // 来电尽早弹：不要等整轮打字/图片气泡播完（否则容易晚于服务端响铃超时）
  if (result.incomingCall && !isInVoiceCallWith(forCharId)) {
    window.showIncomingCallUI?.({
      ...result.incomingCall,
      characterId: Number(result.incomingCall.characterId || forCharId),
    });
  }
  if (isInVoiceCallWith(forCharId) && result?.callAmbience) {
    applyCallAmbienceField(result.callAmbience);
  }
  if (isInVoiceCallWith(forCharId) && inVideoCall) {
    // 文字视频场景条提前画上；后面播语音时 skipScenePush，避免整段再拆成碎句各推一次
    applyCallLensFromResult(result);
  }

  if (result.peerChange || result.peerStatus || result.peerHint) {
    showPeerRelationToast(result.peerChange, result.peerStatus, result.peerHint);
    // 刷新本地角色 peer_status
    try {
      const appChars = window.getAppCharacters?.() || [];
      const idx = appChars.findIndex(c => Number(c.id) === Number(forCharId));
      if (idx >= 0 && result.peerStatus) appChars[idx].peer_status = result.peerStatus;
    } catch {}
  }

  if (result.systemHints?.length && onPage) {
    const list = document.getElementById('messages-list');
    for (const hint of result.systemHints) {
      list?.insertAdjacentHTML('beforeend', buildBubble({
        id: hint.id || ('hint_' + Date.now()),
        role: 'assistant',
        content: hint.content,
        type: 'system',
        timestamp: new Date().toISOString(),
      }, getCharMeta(forCharId), {}));
    }
    scrollBottom(true);
  }

  if (result.theaterEnded || result.theaterActive === false) {
    if (Number(forCharId) === Number(charId) && currentChar) currentChar.theater_active = 0;
    const appChars = window.getAppCharacters?.() || [];
    const idx = appChars.findIndex(c => Number(c.id) === Number(forCharId));
    if (idx >= 0) appChars[idx].theater_active = 0;
    if (Number(forCharId) === Number(charId)) setTheaterBarVisible(false);
  } else if (result.theaterStarted || result.theaterActive) {
    if (Number(forCharId) === Number(charId) && currentChar) currentChar.theater_active = 1;
    const appChars = window.getAppCharacters?.() || [];
    const idx = appChars.findIndex(c => Number(c.id) === Number(forCharId));
    if (idx >= 0) appChars[idx].theater_active = 1;
    if (Number(forCharId) === Number(charId)) setTheaterBarVisible(true);
  }

  // AI 后悔刚发的话：先把上一条更新成"已撤回"，再渲染新内容
  if (result.recalled?.id != null && onPage) {
    applyRecalledUiForMsg(result.recalled.id, result.recalled.content);
  }

  if (result.isBusy && result.silent) {
    if (onPage) {
      syncBusyBar();
      updateCharStatus('busy');
      window.showToast?.('对方忙碌中，消息已送达');
    }
    return;
  }

  if (result.isBusy && result.autoReply) {
    if (onPage) {
      syncBusyBar();
      const list = document.getElementById('messages-list');
      list?.insertAdjacentHTML('beforeend', buildBubble({
        id: result.aiMsgId || ('auto_' + Date.now()), role: 'assistant',
        content: result.autoReply, type: 'text', timestamp: new Date().toISOString(),
      }, getCharMeta(forCharId), {}));
      scrollBottom(true);
      updateCharStatus('busy');
      markVisibleUserMsgsRead(forCharId);
      if (isInVoiceCallWith(forCharId)) await playCallTtsSegment(result.autoReply, forCharId, { msgId: result.aiMsgId });
    } else {
      if (isInVoiceCallWith(forCharId)) await playCallTtsSegment(result.autoReply, forCharId, { msgId: result.aiMsgId });
      else deferAiReply(forCharId, result.autoReply);
    }
    return;
  }

  if (result.isBusy && onPage) {
    syncBusyBar();
    updateCharStatus('busy');
  }

  if (result.content || result.aiMessages?.length || result.selfieImgUrl || result.generalImgUrl || result.generalVideoUrl) {
    if (result.aiMessages?.length) {
      // 勿用 HTTP 里过期的 pending 盖掉 WS 已写入的成图 URL
      const hydratedMsgs = result.aiMessages.map(m =>
        (m?.type === 'image' || m?.type === 'video') ? hydrateMediaMsgFromReadyCache(m) : m
      );
      upsertThreadMessages(forCharId, isDream, hydratedMsgs);
      result.aiMessages = hydratedMsgs;
    }
    if (replyHasPendingMedia(result)) beginSelfiePendingWait(forCharId);
    if (onPage) playNotifySound();
    else {
      if (isInVoiceCallWith(forCharId)) {
        await playCallReplyAudio(result, forCharId);
        window.syncUnreadCounts?.();
      } else {
        const msgs = [];
        if (result.aiMessages?.length) {
          msgs.push(...result.aiMessages);
        } else {
          if (result.content) msgs.push({ type: 'text', content: result.content });
          if (result.selfieImgUrl) msgs.push({ type: 'image', content: result.selfieImgUrl });
          if (result.generalImgUrl) msgs.push({ type: 'image', content: result.generalImgUrl });
          if (result.generalVideoUrl) msgs.push({ type: 'video', content: result.generalVideoUrl });
        }
        deferAiReply(forCharId, msgs.length ? msgs : [{ type: 'text', content: '[新消息]' }]);
      }
    }

    if (onPage) {
      const callMode = isInVoiceCallWith(forCharId);
      const freshMsgs = filterUnrenderedAiMessages(result.aiMessages || []);
      const mainIdInDom = result.aiMsgId != null && isAiMsgInDom(result.aiMsgId);

      if (freshMsgs.length) {
        await renderAiMessageSequence(freshMsgs, userTimestamp, forCharId, { callMode });
        // 打字动画中途闸门抖动/中断时，把仍漏画的气泡补上
        if (shouldRenderForChar(forCharId)) paintMissingMessagesToDom(freshMsgs);
      } else if (!mainIdInDom && result.content && !(result.aiMessages?.length)) {
        if (callMode && looksLikeWebCardPayload(result.content)) {
          await appendAiBubble({ id: result.aiMsgId, type: 'web_card', content: result.content }, userTimestamp, forCharId);
        } else if (callMode) {
          await appendAiBubble({ id: result.aiMsgId, type: 'text', content: result.content }, userTimestamp, forCharId);
        } else if (looksLikeWebCardPayload(result.content)) {
          await appendAiBubble({ id: result.aiMsgId, type: 'web_card', content: result.content }, userTimestamp, forCharId);
        } else {
          const segments = splitAiSegments(result.content);
          await renderAiBubbles(segments, result.aiMsgId, userTimestamp, 'text', forCharId);
        }
      } else if (callMode && (result.aiMessages?.length || result.content)) {
        // 气泡已被 WS/sync 先画上但听筒没播：补播一次
        await playCallReplyAudio(result, forCharId);
      }

      if (!aiMessagesIncludeImages(freshMsgs) && !aiMessagesIncludeImages(result.aiMessages)) {
        let afterVisible = !!(freshMsgs.length || (result.content && !(result.aiMessages?.length)));
        if (result.selfieImgUrl && !isAiMsgInDom(result.selfieImgId)) {
          await pauseBeforeAiBubble(forCharId, { type: 'image' }, { afterVisible });
          await appendAiBubble({ id: result.selfieImgId, type: 'image', content: result.selfieImgUrl }, userTimestamp, forCharId);
          afterVisible = true;
        }
        if (result.generalImgUrl && !isAiMsgInDom(result.generalImgId)) {
          await pauseBeforeAiBubble(forCharId, { type: 'image' }, { afterVisible });
          await appendAiBubble({ id: result.generalImgId, type: 'image', content: result.generalImgUrl }, null, forCharId);
          afterVisible = true;
        }
        if (result.generalVideoUrl && !isAiMsgInDom(result.generalVideoId)) {
          await pauseBeforeAiBubble(forCharId, { type: 'video' }, { afterVisible });
          await appendAiBubble({ id: result.generalVideoId, type: 'video', content: result.generalVideoUrl }, null, forCharId);
        }
      }

      updateCharMoodFromReply(result.content);
      // 仍在该角色聊天页 → 标已读；中途离开 → 补一次离页通知（整轮只弹一条，不是逐条狂弹）
      if (shouldRenderForChar(forCharId)) {
        markVisibleUserMsgsRead(forCharId);
        api.markMessagesRead(forCharId, isDream ? 1 : 0).catch(() => {});
        markVisibleAiMsgsRead();
      } else {
        markCachedUserMsgsRead(forCharId, isDream);
        if (isInVoiceCallWith(forCharId)) {
          await playCallReplyAudio(result, forCharId);
        } else {
          const leftMsgs = result.aiMessages?.length
            ? result.aiMessages
            : [
                result.content && { type: 'text', content: result.content },
                result.selfieImgUrl && { id: result.selfieImgId, type: 'image', content: result.selfieImgUrl },
                result.generalImgUrl && { id: result.generalImgId, type: 'image', content: result.generalImgUrl },
                result.generalVideoUrl && { id: result.generalVideoId, type: 'video', content: result.generalVideoUrl },
              ].filter(Boolean);
          deferAiReply(forCharId, leftMsgs.length ? leftMsgs : [{ type: 'text', content: '[新消息]' }]);
        }
      }
    } else if (result.peerReadUser) {
      // 无可见气泡（例如 silent）但后端已标用户消息已读 → 仍同步缓存，避免回页又显示未读
      markCachedUserMsgsRead(forCharId, isDream);
    }
    if (result.imageAttachNote) {
      window.showToast?.(result.imageAttachNote);
    }
  } else if (result.peerReadUser) {
    markVisibleUserMsgsRead(forCharId);
  }

  if (result.avatarUpdated && result.avatarUrl && onPage) {
    if (currentChar) currentChar.avatar = result.avatarUrl;
    applyChatHeader(currentChar);
    const appChars = window.getAppCharacters?.() || [];
    const idx = appChars.findIndex(c => Number(c.id) === Number(forCharId));
    if (idx >= 0) appChars[idx].avatar = result.avatarUrl;
    window.showToast?.('角色已换上新头像');
  }

}

async function persistUserMessage(text, type, extra, replyState, targetCharId = charId) {
  return chainSave(() => api.sendMessage({
    characterId: targetCharId,
    content: text,
    type,
    location: extra.location || null,
    lat: extra.lat,
    lng: extra.lng,
    isDream,
    noReply: true,
    hideChat: extra.hideChat === true || extra.hiddenChat === true,
    isVoiceCall: isInVoiceCallWith(targetCharId),
    isVideoCall: !!(isInVoiceCallWith(targetCharId) && inVideoCall),
    ...callTriggerExtra(),
    replyToId: replyState?.id || null,
    replyPreview: replyState?.preview || '',
  }));
}

function applyUserDeliveryStatus(tmpId, deliveryStatus) {
  if (!tmpId || !deliveryStatus) return;
  const el = document.querySelector(`[data-id="${CSS.escape(String(tmpId))}"]`);
  if (!el) return;
  if (deliveryStatus === 'blocked_by_peer' || deliveryStatus === 'deleted_by_peer') {
    el.classList.add('has-undelivered');
    const row = el.querySelector('.bubble-row-with-status');
    if (row && !row.querySelector('.bubble-undelivered')) {
      const title = deliveryStatus === 'deleted_by_peer' ? '对方已把你删除' : '对方已把你拉黑';
      row.insertAdjacentHTML('beforeend', `<span class="bubble-undelivered" title="${title}">!</span>`);
    }
  }
}

function showPeerRelationToast(peerChange, peerStatus, peerHint) {
  if (peerHint) window.showToast?.(peerHint);
  else if (peerChange === 'blocked') window.showToast?.('对方已把你拉黑');
  else if (peerChange === 'unblocked') window.showToast?.('对方已解除拉黑');
  else if (peerChange === 'deleted') window.showToast?.('对方已把你删除，可在联系人重新添加');
  else if (peerStatus === 'blocked') window.showToast?.('对方已把你拉黑');
  else if (peerStatus === 'deleted') window.showToast?.('对方已把你删除');
}

function bindSavedUserMsgId(tmpId, userMsgId) {
  if (!tmpId || !userMsgId) return;
  const id = String(userMsgId);
  const el = document.querySelector(`[data-id="${tmpId}"]`);
  if (el) {
    el.dataset.id = id;
    el.dataset.msgId = id;
  }
}

async function doSend(text, type = 'text', extra = {}, noReply = false, targetCharId = null) {
  const sendCharId = targetCharId != null ? targetCharId : charId;
  if (!sendCharId) return;
  if ((type === 'text' || type === 'voice') && !String(text || '').trim()) return;
  if (!_emptyAiNudging) _emptyAiNudgeCount = 0;
  if (type === 'text' && isLikelyImeSpuriousText(text)) {
    const input = document.getElementById('chat-input');
    if (shouldBlockImeSpuriousSend(text, input)) {
      if (input && isLikelyImeSpuriousText(input.value)) {
        input.value = '';
        autoResize?.(input);
      }
      return;
    }
  }
  if (_doSendBusy && !noReply) {
    window.showToast?.('上一条还在发送中，请稍候');
    return;
  }

  _peerReadMarked = false;

  const viewingThis = Number(sendCharId) === Number(charId);
  const forCall = isInVoiceCallWith(sendCharId);
  const hideBubble = extra.hideChat === true || extra.hiddenChat === true || _emptyAiNudging;
  const list = document.getElementById('messages-list');
  const now = new Date().toISOString();

  // 捕获并清除引用状态（与是否立即触发 AI 无关；回车入库 / 攒消息也要关掉引用条）
  const replyState = hideBubble ? null : (window._replyState || null);
  if (replyState && viewingThis && type !== 'system') window.clearReply?.();

  let tmpId = null;
  // 系统消息不渲染用户气泡（如通话开始/结束消息）；空回复顶上去的「嗯」也不画出来
  if (type !== 'system' && viewingThis && list && !hideBubble) {
    tmpId = 'tmp_' + Date.now();
    const userBubble = buildBubble({
      id: tmpId, dbId: tmpId, role: 'user',
      content: text, type, timestamp: now,
      location: extra.location || '',
      lat: extra.lat,
      lng: extra.lng,
      media_meta: (Number.isFinite(Number(extra.lat)) && Number.isFinite(Number(extra.lng)))
        ? JSON.stringify({ lat: Number(extra.lat), lng: Number(extra.lng) })
        : '',
      reply_preview: replyState?.preview || '',
      reply_to_id: replyState?.id || '',
      voice_duration: extra.duration || undefined,
    }, currentChar, {});
    list.insertAdjacentHTML('beforeend', userBubble);
    jumpMessagesToBottom();
    if (type === 'location') hydrateLocationCardMaps(list);
    if (type === 'web_card') hydrateWebCards(list);
  }
  if (type !== 'system' && forCall && !hideBubble) {
    onCallUserSpoke(text);
    const voiceLabel = type === 'voice'
      ? `🎤 语音${extra.duration ? ` ${extra.duration}"` : ''}`
      : text;
    appendCallChatMsg('user', voiceLabel);
    if (type === 'voice') {
      callTranscript.push({ role: 'user', content: '[语音消息]' });
    }
    // 语音也要认「连麦/晚安」；有转写时立刻切连麦芯片
    if (type === 'voice' || type === 'text') {
      maybeAutoHangoutFromUserText(text);
    }
  }

  // 气泡一出现就入库，主动消息/上下文能立刻读到
  let userMsgId = null;
  if (!noReply) {
    _doSendBusy = true;
    if (forCall) {
      try { engineSetThinking(true); } catch {}
      updateCallLiveHoldUi();
      setCallIdleStatus();
    }
  }
  try {
    const saved = await persistUserMessage(text, type, extra, viewingThis ? replyState : null, sendCharId);
    userMsgId = saved.userMsgId;
    if (userMsgId) {
      const hideMeta = hideBubble
        ? JSON.stringify({ hideChat: 1, emptyNudge: 1 })
        : ((Number.isFinite(Number(extra.lat)) && Number.isFinite(Number(extra.lng)))
          ? JSON.stringify({ lat: Number(extra.lat), lng: Number(extra.lng) })
          : '');
      upsertThreadMessages(sendCharId, isDream, [{
        id: userMsgId,
        character_id: sendCharId,
        role: 'user',
        content: text,
        type,
        timestamp: new Date().toISOString(),
        location: extra.location || '',
        media_meta: hideMeta,
        delivery_status: saved.delivery_status,
        is_read: 0,
      }]);
    }
    if (viewingThis) {
      bindSavedUserMsgId(tmpId, userMsgId);
      applyUserDeliveryStatus(tmpId, saved.delivery_status);
      if (saved.delivery_status === 'blocked_by_peer') {
        window.showToast?.('对方已把你拉黑');
      } else if (saved.delivery_status === 'deleted_by_peer') {
        window.showToast?.(saved.peerHint || '对方已把你删除，可在联系人中重新添加');
        if (!noReply) _doSendBusy = false;
        return;
      }
    }
  } catch (e) {
    if (!noReply) _doSendBusy = false;
    window.showToast?.('消息保存失败: ' + (e.message || '网络错误'));
    return;
  }

  if (noReply) {
    _pendingAiCount++;
    markPendingUserMsg(userMsgId, tmpId);
    updatePendingBadge();
    return;
  }

  if (forCall) {
    setCallIdleStatus();
    syncCallWaveform();
  }
  startWaitTypingPulse(sendCharId);

  let emptyNudge = false;
  try {
    await _saveQueue;
    // 开场「通话开始」不带截图；接通后预截的帧留给下一轮
    const skipLook = type === 'system' && /通话开始/.test(String(text || ''));
    const lookUrl = forCall && !skipLook
      ? await maybeCaptureLookForSend(type === 'text' || type === 'voice' || type === 'system' ? text : '')
      : '';
    const result = await triggerAiAndWaitTyping(sendCharId, isDream, 'retry', false, null, forCall, false, getGameTopicContextForAi(), null, null, callTriggerExtra(lookUrl));
    rememberAiReplyResult(result);
    const hasReply = hasAiReplyPayload(result);
    if (hasReply && !replyLooksEmpty(result)) {
      _emptyAiNudgeCount = 0;
      await applyAiReplyResult(result, now, sendCharId);
    } else if (!hasReply && forCall) {
      appendCallChatMsg('system', '角色暂时没有回应，请稍后再试');
      setCallIdleStatus();
    } else if (shouldNudgeEmptyAiReply(result, { fromCall: forCall })) {
      stopWaitTypingPulse(true);
      emptyNudge = true;
    } else {
      await applyAiReplyResult(result, now, sendCharId);
    }
  } catch (e) {
    stopWaitTypingPulse(true);
    showCharTypingFor(sendCharId, false);
    const recovered = await recoverSavedAiReply(sendCharId);
    if (forCall) {
      setCallIdleStatus();
      if (!recovered) {
        const errText = String(e?.message || '').trim();
        // 连麦通道本身往往已通；失败多半是聊天上游 API 瞬时 500/超时
        const soft = /超时|500|502|503|do_request|upstream/i.test(errText)
          ? '角色暂时没接上话（上游波动），再试一句或稍后再拨'
          : (errText ? `角色回复失败：${errText}` : '角色回复失败');
        appendCallChatMsg('system', soft);
      }
    }
    // 接口报错时消息可能已入库，尝试刷新列表
    if (!recovered && viewingThis) {
      try { await syncNewMessages(); } catch {}
    }
    const errMsg = String(e?.message || '');
    if (!recovered) {
      if (isEmptyAiReplyError(e) && !forCall && !isDream) {
        emptyNudge = true;
      } else if (/超时|aborted|abort/i.test(errMsg)) {
        window.showToast?.('角色回复超时：可能 API 太慢。已尝试刷新聊天；没有气泡再空按发送');
      } else {
        const partial = type === 'location'
          ? '位置已发送，角色暂时无法回复'
          : '消息已发送，角色暂时无法回复';
        window.showToast?.(errMsg ? `${partial}：${errMsg}` : partial);
      }
    }
  } finally {
    _doSendBusy = false;
    if (forCall) {
      try { engineSetThinking(false); } catch {}
      setCallIdleStatus();
      syncCallWaveform();
    }
  }
  if (emptyNudge) await maybeNudgeEmptyAiReply(sendCharId);
}

/** AI 回复后：DOM + 本地缓存里用户气泡都标成已读 */
function markVisibleUserMsgsRead(forCharId = charId) {
  document.querySelectorAll('#messages-list .bubble-wrap.user .bubble-read-tag.unread').forEach(el => {
    el.classList.replace('unread', 'read');
    el.textContent = '已读';
  });
  document.querySelectorAll('#messages-list .bubble-wrap.user .bubble-time-text.unread').forEach(el => {
    el.classList.replace('unread', 'read');
  });
  markCachedUserMsgsRead(forCharId, isDream);
}

/** 用户打开聊天后把角色气泡里的「未读」标记为「已读」 */
function markVisibleAiMsgsRead() {
  document.querySelectorAll('#messages-list .bubble-wrap.ai .bubble-read-tag.unread').forEach(el => {
    el.classList.replace('unread', 'read');
    el.textContent = '已读';
  });
  document.querySelectorAll('#messages-list .bubble-wrap.ai .bubble-time-text.unread').forEach(el => {
    el.classList.replace('unread', 'read');
  });
}

function markCachedAiMsgsRead(cid, dream, ids) {
  if (!cid) return;
  const cached = getThreadCacheSync(cid, dream);
  if (!cached?.messages?.length) return;
  const idSet = Array.isArray(ids) && ids.length
    ? new Set(ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))
    : null;
  let changed = false;
  const next = cached.messages.map(m => {
    if (m.role !== 'assistant' || m.type === 'system') return m;
    if (m.is_read === 1 || m.is_read === true) return m;
    if (idSet && !idSet.has(Number(m.id))) return m;
    changed = true;
    return { ...m, is_read: 1 };
  });
  if (changed) replaceThreadMessages(cid, dream, next, cached.hasMore);
}

/** 当前正在看聊天：这条角色气泡一出来就标已读（库里只标这一条，后面还没出的不算） */
function markAiBubbleReadNow(forCharId, msgId) {
  const n = Number(msgId);
  markVisibleAiMsgsRead();
  if (!Number.isFinite(n) || n <= 0) return;
  markCachedAiMsgsRead(forCharId, isDream, [n]);
  api.markMessagesRead(forCharId, isDream ? 1 : 0, [n]).catch(() => {});
}

/** 把本地线程缓存里该会话用户消息标为已读，避免回页又刷成「未读」 */
function markCachedUserMsgsRead(cid, dream) {
  if (!cid) return;
  const cached = getThreadCacheSync(cid, dream);
  if (!cached?.messages?.length) return;
  let changed = false;
  const next = cached.messages.map(m => {
    if (m.role !== 'user' || m.type === 'system') return m;
    if (m.is_read === 1 || m.is_read === true) return m;
    changed = true;
    return { ...m, is_read: 1 };
  });
  if (changed) replaceThreadMessages(cid, dream, next, cached.hasMore);
}

/** 用服务端消息的 is_read 刷新已在 DOM 里的气泡（同步后不重绘也能对上） */
function applyReadStateFromMessages(msgs) {
  if (!msgs?.length) return;
  const list = document.getElementById('messages-list');
  if (!list) return;
  for (const m of msgs) {
    if (m?.id == null) continue;
    const isRead = m.is_read === 1 || m.is_read === true;
    if (!isRead) continue;
    let wraps;
    try {
      const s = CSS.escape(String(m.id));
      wraps = list.querySelectorAll(`.bubble-wrap[data-msg-id="${s}"], .bubble-wrap[data-id="${s}"]`);
    } catch {
      continue;
    }
    wraps.forEach(wrap => {
      wrap.querySelectorAll('.bubble-read-tag.unread').forEach(el => {
        el.classList.replace('unread', 'read');
        el.textContent = '已读';
      });
      wrap.querySelectorAll('.bubble-time-text.unread').forEach(el => {
        el.classList.replace('unread', 'read');
      });
    });
  }
}

function isPlaceholderMediaContent(content) {
  const url = String(content || '').trim();
  return !url
    || url.startsWith('__pending_selfie__')
    || url.startsWith('__pending_video__')
    || url.startsWith('__selfie_failed__')
    || url.startsWith('__video_failed__');
}

/** 把占位/失败媒体气泡换成真实图视频（同 id 只改 content 时 sinceId 拉不到） */
function applyReadyMediaToBubble(wrap, data) {
  if (!wrap) return false;
  const url = String(data.content || '').trim();
  if (isPlaceholderMediaContent(url)) return false;
  const resolved = window.resolveMediaUrl?.(url) || url;
  const mediaSrc = resolved.replace(/"/g, '&quot;');
  const main = wrap.querySelector('.bubble-main') || wrap;
  const pending = main.querySelector(
    '[data-pending-video], [data-pending-selfie], [data-failed-video], [data-failed-selfie], .bubble-media-pending, .bubble-media-failed'
  );
  const existing = main.querySelector('img.bubble-media, .bubble-video-wrap, video.bubble-media');
  if (!pending && existing) {
    const cur = existing.getAttribute('data-media-url')
      || existing.getAttribute('src')
      || existing.querySelector?.('video')?.getAttribute('data-media-url')
      || existing.querySelector?.('video')?.getAttribute('src')
      || '';
    if (cur === url || cur === resolved || cur === mediaSrc) return false;
  }
  const isVideo = data.type === 'video' || data.videoReady || /\.(mp4|webm|mov)(\?|$)/i.test(url);
  const keepSticker = data.type === 'emoji'
    || existing?.classList?.contains('bubble-sticker')
    || pending?.classList?.contains('bubble-sticker');
  const mediaHtml = isVideo
    ? buildVideoThumbHtml(mediaSrc)
    : `<img class="bubble-media${keepSticker ? ' bubble-sticker' : ''}" src="${mediaSrc}" alt="" data-media-url="${mediaSrc}" data-media-type="image" title="点击放大" onclick="window.openChatMediaViewerFromEl?.(this)">`;
  if (pending) pending.outerHTML = mediaHtml;
  else if (existing) existing.outerHTML = mediaHtml;
  else main.insertAdjacentHTML('beforeend', mediaHtml);
  if (isVideo) hydrateVideoThumbs(main);
  return true;
}

function patchMediaBubblesFromMessages(msgs) {
  if (!msgs?.length) return;
  const list = document.getElementById('messages-list');
  if (!list) return;
  let changed = false;
  for (const m of msgs) {
    if (m?.id == null || isPlaceholderMediaContent(m.content)) continue;
    const type = String(m.type || '');
    if (type === 'emoji') continue;
    const url = String(m.content || '').trim();
    const looksMedia = type === 'image' || type === 'video'
      || /^\/uploads\//i.test(url)
      || /^https?:\/\//i.test(url)
      || /\.(mp4|webm|mov|jpe?g|png|gif|webp)(\?|$)/i.test(url);
    if (!looksMedia) continue;
    let wrap;
    try {
      const s = CSS.escape(String(m.id));
      wrap = list.querySelector(`.bubble-wrap[data-msg-id="${s}"], .bubble-wrap[data-id="${s}"]`);
    } catch {
      continue;
    }
    if (!wrap) continue;
    if (applyReadyMediaToBubble(wrap, {
      content: url,
      type: type || (/\.(mp4|webm|mov)(\?|$)/i.test(url) ? 'video' : 'image'),
    })) changed = true;
  }
  if (changed) scrollBottom(true);
}

/** WS 媒体更新时同步写线程缓存，避免回通讯录再进仍显示 ··· */
function upsertMediaMsgToThreadCache(cid, data) {
  const idNum = Number(data.id);
  if (!Number.isFinite(idNum) || idNum <= 0) return;
  const content = String(data.content || '').trim();
  if (!content) return;
  const isVideo = !!(data.videoFailed || data.videoReady || data.type === 'video'
    || content.startsWith('__pending_video__') || content.startsWith('__video_failed__')
    || /\.(mp4|webm|mov)(\?|$)/i.test(content));
  const msg = {
    id: idNum,
    character_id: cid,
    role: 'assistant',
    content,
    type: isVideo ? 'video' : 'image',
  };
  if (Number(charId) === Number(cid) && isDream) {
    upsertThreadMessages(cid, 1, [msg]);
    return;
  }
  upsertThreadMessages(cid, 0, [msg]);
  const dreamCache = getThreadCacheSync(cid, 1);
  if (dreamCache?.messages?.some(m => Number(m.id) === idNum)) {
    upsertThreadMessages(cid, 1, [msg]);
  }
}

/** 缓存里曾缺 timestamp 时，同步后把时间补进已有气泡 */
function patchBubbleTimestampsFromMessages(msgs) {
  if (!msgs?.length || !charId) return;
  const list = document.getElementById('messages-list');
  if (!list) return;
  for (const m of msgs) {
    if (m?.id == null || !m.timestamp) continue;
    let wraps;
    try {
      const s = CSS.escape(String(m.id));
      wraps = list.querySelectorAll(`.bubble-wrap[data-msg-id="${s}"], .bubble-wrap[data-id="${s}"]`);
    } catch {
      continue;
    }
    if (!wraps.length) continue;
    const text = formatTime(m.timestamp, charId);
    if (!text) continue;
    wraps.forEach(wrap => {
      const timeEls = wrap.querySelectorAll('.bubble-time-text');
      if (timeEls.length) {
        timeEls.forEach(el => { el.textContent = text; });
        return;
      }
      // 气泡下/外模式却缺了时间节点时补一行
      const tsPos = getChatSettings(charId).timestampPosition || 'divider';
      if (tsPos !== 'bubble' && tsPos !== 'outside') return;
      const isUser = wrap.classList.contains('user');
      const foot = wrap.querySelector('.bubble-meta-foot');
      if (foot && !foot.querySelector('.bubble-time-text')) {
        const readCls = foot.querySelector('.bubble-read-tag.read') ? 'read' : 'unread';
        foot.insertAdjacentHTML('beforeend', `<span class="bubble-time-text ${readCls}">${text}</span>`);
      } else if (!foot && tsPos === 'bubble') {
        const stack = wrap.querySelector('.bubble-stack') || wrap.querySelector('.bubble-row-with-status');
        if (!stack) return;
        const readTag = wrap.querySelector('.bubble-read-tag');
        const readHtml = readTag ? readTag.outerHTML : '';
        if (readTag) readTag.remove();
        const readCls = /class="[^"]*\bread\b/.test(readHtml) ? 'read' : 'unread';
        stack.insertAdjacentHTML('beforeend',
          `<div class="bubble-meta-foot ${isUser ? 'user' : 'ai'} bubble-meta-foot--inline">${readHtml}<span class="bubble-time-text ${readCls}">${text}</span></div>`);
      }
    });
  }
}

// 心情由后端连续情绪系统按轮写入；保留函数以免旧调用报错
function updateCharMoodFromReply(_text) {
  /* no-op: emotion-helper.syncCharacterMoodLabel */
}


function updateCharStatus(status) {
  if (currentChar) currentChar.status = status;
  applyChatHeader(currentChar);
  syncBusyBar();
  syncOperatingBar();
  if (charId) window.syncCharacterStatus?.(charId, status);
}

// 顶栏：等模型时断续显示；两条之间停顿时再亮，发出去就恢复原来的状态
let _peerReadMarked = false;

function showCharTyping(on, kind = 'typing') {
  const text = document.getElementById('chat-char-status');
  const dot = document.getElementById('chat-status-dot');
  if (!text) return;
  if (on) {
    if (!text.classList.contains('typing') && shouldRenderForChar(charId)) {
      markVisibleUserMsgsRead(charId);
      if (!_peerReadMarked && charId) {
        _peerReadMarked = true;
        api.markPeerReadUserMessages(charId, isDream ? 1 : 0).catch(() => {});
      }
    }
    text.classList.add('typing');
    const label = kind === 'speaking' ? '正在说话中' : '正在输入中';
    text.innerHTML = `${label}<span class="dot-anim">.</span><span class="dot-anim" style="animation-delay:.4s">.</span><span class="dot-anim" style="animation-delay:.8s">.</span>`;
    if (dot) dot.style.opacity = '0.4';
  } else {
    text.classList.remove('typing', 'typing-dim');
    text.textContent = chatStatusLabel(currentChar);
    if (dot) dot.style.opacity = '';
  }
}

// ===== 多条攒发 =====
window.updatePendingCount = function() {
  const input = document.getElementById('chat-input');
  if (!input?.value.trim()) return;
};

function updatePendingUI() {
  const bar = document.getElementById('pending-bar');
  const count = document.getElementById('pending-count');
  if (bar) bar.style.display = pendingMsgs.length > 0 ? 'block' : 'none';
  if (count) count.textContent = pendingMsgs.length;
}

window.clearPendingMsgs = function() {
  pendingMsgs = [];
  savePendingMessages(charId, []);
  updatePendingUI();
};

// ===== 工具栏 =====
function syncToolbarDots() {
  const pages = document.getElementById('toolbar-pages');
  const dots = document.getElementById('toolbar-dots');
  if (!pages || !dots) return;
  const pageW = pages.clientWidth || 1;
  const idx = Math.round(pages.scrollLeft / pageW);
  dots.querySelectorAll('span').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
  });
}

function setupToolbarPages() {
  const pages = document.getElementById('toolbar-pages');
  const dots = document.getElementById('toolbar-dots');
  if (!pages || pages.dataset.bound === '1') return;
  pages.dataset.bound = '1';
  pages.addEventListener('scroll', () => syncToolbarDots(), { passive: true });
  dots?.querySelectorAll('span').forEach((el) => {
    el.addEventListener('click', () => {
      const i = Number(el.dataset.page) || 0;
      const pageW = pages.clientWidth || 1;
      pages.scrollTo({ left: i * pageW, behavior: 'smooth' });
    });
  });
}

function setChatToolbarOpen(open) {
  const tb = document.getElementById('chat-toolbar');
  const plus = document.getElementById('chat-plus-btn') || document.querySelector('#chat-page .chat-plus-btn');
  if (tb) {
    tb.style.display = open ? 'block' : 'none';
    tb.classList.toggle('is-open', !!open);
  }
  plus?.classList.toggle('is-open', !!open);
  if (open) {
    setupToolbarPages();
    const pages = document.getElementById('toolbar-pages');
    if (pages) {
      pages.scrollLeft = 0;
      syncToolbarDots();
    }
  }
}
window.setChatToolbarOpen = setChatToolbarOpen;

window.toggleToolbar = function() {
  const tb = document.getElementById('chat-toolbar');
  if (!tb) return;
  const opening = tb.style.display === 'none' || !tb.classList.contains('is-open');
  setChatToolbarOpen(opening);
  if (opening) window.closeEmojiPanel?.();
};

window.toggleMusicSync = async function() {
  setChatToolbarOpen(false);
  if (!charId) {
    window.showToast?.('请先选择一个角色');
    return;
  }
  
  const { startMusicSync, stopMusicSync, isMusicSyncActive } = await import('../music-sync.js');
  
  if (isMusicSyncActive()) {
    stopMusicSync();
    window.showToast?.('已停止一起听歌');
  } else {
    try {
      await startMusicSync(charId);
      window.showToast?.('开始一起听歌');
    } catch (e) {
      window.showToast?.(e.message || '启动失败');
    }
  }
};

window.startScreenShare = async function() {
  setChatToolbarOpen(false);
  if (!window.isNativeShell?.()) {
    window.showToast?.('共享屏幕要在手机上的念 App 里用');
    return;
  }
  try {
    const {
      getAppPermissionStatus,
      showNativeScreenShare,
      openOverlaySettings,
      goNativeHome,
    } = await import('../app-permissions.js');
    const s = await getAppPermissionStatus();
    if (!s.overlay) {
      window.showToast?.('请先打开悬浮窗，才会出现看屏彩环');
      await openOverlaySettings();
      return;
    }
    const shown = await showNativeScreenShare({
      characterId: charId,
      name: currentChar?.name || 'TA',
    });
    if (!shown) {
      window.showToast?.('没能打开看屏彩环');
      return;
    }
    await goNativeHome();
  } catch (e) {
    window.showToast?.(e?.message || '共享屏幕失败');
  }
};

window.closeEmojiPanel = function() {
  const panel = document.getElementById('chat-emoji-panel');
  if (panel) panel.style.display = 'none';
  document.getElementById('chat-emoji-btn')?.classList.remove('active');
};

window.toggleEmojiPanel = function(fromToolbar) {
  const panel = document.getElementById('chat-emoji-panel');
  const btn = document.getElementById('chat-emoji-btn');
  if (!panel) return;
  const opening = panel.style.display === 'none';
  if (!opening) {
    window.closeEmojiPanel();
    return;
  }
  setChatToolbarOpen(false);
  document.getElementById('chat-input')?.blur();
  panel.style.display = 'flex';
  btn?.classList.add('active');
  if (fromToolbar) btn?.classList.remove('active');
  window.openEmojiPicker?.();
};

// ===== 用户语音条（按住说话 → 多模态） =====
let _chatVoiceMode = false;
let _callVoiceMode = false;
let _voiceRec = null;
let _voiceChunks = [];
let _voiceStream = null;
let _voiceStartedAt = 0;
let _voiceMaxTimer = null;
let _voiceTickTimer = null;
let _voicePointerId = null;
let _voiceStartY = 0;
let _voiceCancel = false;
let _voiceSending = false;
let _voiceStarting = false;
/** 按住申请麦权限期间已松手：开始录音后立刻结束，避免「空录 60 秒 / 没声音」 */
let _voiceReleasedWhileStarting = false;
let _voiceHoldBoundIds = new Set();
let _activeVoiceHoldId = 'chat-hold-talk';
let _voiceDocListening = false;
let _micWarmPromise = null;

function pickVoiceMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

function liveAudioTracks(stream) {
  return stream?.getAudioTracks?.().filter((t) => t.readyState === 'live') || [];
}

function liveVideoTracks(stream) {
  return stream?.getVideoTracks?.().filter((t) => t.readyState === 'live') || [];
}

function stopMediaStream(stream) {
  if (!stream) return;
  try { stream.getTracks().forEach((t) => t.stop()); } catch {}
}

function isMediaPermissionError(err) {
  return /NotAllowedError|NotAllowed|PermissionDenied|Permission|denied/i.test(String(err?.name || err?.message || ''));
}

async function ensureNativeMicGranted() {
  if (!window.isNativeShell?.()) return true;
  try {
    const s = await getAppPermissionStatus();
    if (s?.microphone) return true;
    const after = await requestNativeMicrophone();
    return !!after?.microphone;
  } catch {
    return true;
  }
}

async function ensureNativeCameraGranted() {
  if (!window.isNativeShell?.()) return true;
  try {
    const s = await getAppPermissionStatus();
    if (s?.camera) return true;
    const after = await requestNativeCamera();
    return !!after?.camera;
  } catch {
    return true;
  }
}

async function toastMicFailure(err) {
  let nativeOn = false;
  try {
    nativeOn = !!(await getAppPermissionStatus())?.microphone;
  } catch {}
  if (isMediaPermissionError(err) && nativeOn) {
    window.showToast?.('麦克风被占用或系统拦了网页录音，关掉其他录音应用后再试');
    return;
  }
  if (isMediaPermissionError(err)) {
    window.showToast?.('请允许麦克风权限后再用语音');
    return;
  }
  window.showToast?.('无法使用麦克风: ' + (err?.message || '未知错误'));
}

/** 无耳机时关处理，避免 WebView 误切通话声道。有耳机麦时必须开，才能用上 SCO/HFP。 */
const MIC_MEDIA_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

const MIC_CALL_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

function useNativeCallAudio() {
  return !!(window.isNativeShell?.() && hasNativeCallAudio());
}

function isHeadsetAudioRoute(route) {
  return !!(route?.headsetInput || route?.scoOn || /sco|ble|wired|usb/i.test(String(route?.route || '')));
}

function scoreAudioInputLabel(label) {
  const s = String(label || '').toLowerCase();
  if (!s) return 0;
  const bt = /bluetooth|bt\b|a2dp|ble headset|headset|buds|airpods|wh-|wf-|sony|bose|beats|freebuds|enco|耳机/i.test(s);
  const comm = /communication|通话|sco/i.test(s);
  if (bt && comm) return 5;
  if (bt) return 4;
  if (/usb|wired|有线/i.test(s)) return 3;
  if (comm) return 3;
  if (/default|麦克风|microphone|mic/i.test(s)) return 1;
  return 2;
}

async function pickPreferredAudioInputId(preferHeadset = false) {
  if (!navigator.mediaDevices?.enumerateDevices) return preferHeadset ? 'communications' : '';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
    inputs.sort((a, b) => scoreAudioInputLabel(b.label) - scoreAudioInputLabel(a.label));
    const best = inputs[0];
    if (best && scoreAudioInputLabel(best.label) >= 3) return best.deviceId;
    if (preferHeadset) {
      const comm = inputs.find((d) => d.deviceId === 'communications' || /communication|通话/i.test(d.label || ''));
      if (comm) return comm.deviceId;
      return 'communications';
    }
  } catch {}
  return preferHeadset ? 'communications' : '';
}

async function getUserMediaAudio() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风');
  }
  const route = await setNativeCallMediaAudio(true);
  const headset = isHeadsetAudioRoute(route);
  const constraints = headset ? MIC_CALL_CONSTRAINTS : MIC_MEDIA_CONSTRAINTS;
  const deviceId = await pickPreferredAudioInputId(headset);
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...constraints, deviceId: { exact: deviceId } },
      });
    } catch {}
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...constraints, deviceId },
      });
    } catch {}
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const afterId = await pickPreferredAudioInputId(headset);
  if (afterId && afterId !== liveAudioTracks(stream)[0]?.getSettings?.().deviceId) {
    try {
      const preferred = await navigator.mediaDevices.getUserMedia({
        audio: { ...constraints, deviceId: { exact: afterId } },
      });
      stopMediaStream(stream);
      return preferred;
    } catch {}
  }
  return stream;
}

function takeWarmMicStream() {
  if (liveAudioTracks(_micWarmStream).length) {
    const s = _micWarmStream;
    _micWarmStream = null;
    _micWarmPromise = null;
    return s;
  }
  return null;
}

function takePreparedCallAudio() {
  const prepared = liveAudioTracks(_callPreparedAudioStream).length
    ? _callPreparedAudioStream
    : null;
  if (prepared) {
    _callPreparedAudioStream = null;
    return prepared;
  }
  return takeWarmMicStream();
}

function releaseWarmMic() {
  _micWarmPromise = null;
  if (_micWarmStream) {
    stopMediaStream(_micWarmStream);
    _micWarmStream = null;
  }
  if (!inCall) setNativeCallMediaAudio(false);
}

function stopPreparedCallAudio() {
  if (_callPreparedAudioStream && _callPreparedAudioStream !== _callLiveStream) {
    stopMediaStream(_callPreparedAudioStream);
  }
  _callPreparedAudioStream = null;
}

function invalidateCallMediaPrep() {
  _callMediaGen += 1;
  stopPreparedCallAudio();
}

/** 在用户点按的同一拍里开麦（await 之后 WebView 会丢掉手势） */
function prepareCallMedia(asVideo) {
  const gen = _callMediaGen;
  ensureNativeMicGranted().catch(() => {});
  if (asVideo) ensureNativeCameraGranted().catch(() => {});
  const audioP = useNativeCallAudio()
    ? startNativeCall()
      .then((r) => {
        if (gen !== _callMediaGen || !inCall) {
          stopNativeCall();
          return;
        }
        if (!r?.ok) throw new Error(r?.error || '无法打开通话麦克风');
      })
      .catch((err) => {
        if (gen === _callMediaGen) _callPreparedAudioError = err;
      })
    : getUserMediaAudio()
      .then((stream) => {
        if (gen !== _callMediaGen || !inCall) {
          stopMediaStream(stream);
          return;
        }
        stopPreparedCallAudio();
        _callPreparedAudioStream = stream;
      })
      .catch((err) => {
        if (gen === _callMediaGen) _callPreparedAudioError = err;
      });
  let videoP = Promise.resolve();
  if (asVideo && !liveVideoTracks(_callUserStream).length) {
    videoP = openCallCameraStream(_callCamFacing)
      .then(async (stream) => {
        if (gen !== _callMediaGen || !inCall) {
          stopMediaStream(stream);
          return;
        }
        if (_callUserStream && _callUserStream !== stream) stopMediaStream(_callUserStream);
        _callUserStream = stream;
        // 立刻挂到小窗，别等开场白播完才出画面
        await attachCallUserVideo(stream);
        syncNativeCallOverlay();
      })
      .catch((err) => {
        if (gen === _callMediaGen) _callPreparedVideoError = err;
      });
  } else if (asVideo && liveVideoTracks(_callUserStream).length) {
    videoP = attachCallUserVideo(_callUserStream).then(() => syncNativeCallOverlay()).catch(() => {});
  }
  return Promise.all([audioP, videoP]);
}

let _callPreparedAudioError = null;
let _callPreparedVideoError = null;

/** 进入语音模式时先要一次麦，并保持占用，避免松手后再开第二次被拦 */
function warmUpMicrophone() {
  if (_micWarmPromise) return _micWarmPromise;
  if (liveAudioTracks(_micWarmStream).length) return Promise.resolve(true);
  if (!navigator.mediaDevices?.getUserMedia) return Promise.resolve(false);
  ensureNativeMicGranted().catch(() => {});
  _micWarmPromise = getUserMediaAudio()
    .then((stream) => {
      if (_micWarmStream && _micWarmStream !== stream) stopMediaStream(_micWarmStream);
      _micWarmStream = stream;
      _micWarmPromise = Promise.resolve(true);
      return true;
    })
    .catch(async (err) => {
      _micWarmPromise = null;
      await ensureNativeMicGranted();
      try {
        const stream = await getUserMediaAudio();
        if (_micWarmStream && _micWarmStream !== stream) stopMediaStream(_micWarmStream);
        _micWarmStream = stream;
        _micWarmPromise = Promise.resolve(true);
        return true;
      } catch (err2) {
        await toastMicFailure(err2 || err);
        return false;
      }
    });
  return _micWarmPromise;
}

function getActiveVoiceHold() {
  return document.getElementById(_activeVoiceHoldId)
    || document.getElementById('chat-hold-talk')
    || document.getElementById('call-hold-talk');
}

function setChatVoiceMode(on) {
  _chatVoiceMode = !!on;
  const composer = document.getElementById('chat-composer');
  const input = document.getElementById('chat-input');
  const hold = document.getElementById('chat-hold-talk');
  const toggle = document.getElementById('chat-voice-toggle');
  const mic = toggle?.querySelector('.chat-voice-icon-mic');
  const kbd = toggle?.querySelector('.chat-voice-icon-kbd');
  composer?.classList.toggle('is-voice-mode', _chatVoiceMode);
  toggle?.classList.toggle('is-voice', _chatVoiceMode);
  toggle?.setAttribute('title', _chatVoiceMode ? '键盘' : '语音');
  toggle?.setAttribute('aria-label', _chatVoiceMode ? '切换键盘输入' : '切换语音输入');
  if (mic) mic.style.display = _chatVoiceMode ? 'none' : '';
  if (kbd) kbd.style.display = _chatVoiceMode ? '' : 'none';
  if (input) input.style.display = _chatVoiceMode ? 'none' : '';
  if (hold) hold.style.display = _chatVoiceMode ? '' : 'none';
  if (_chatVoiceMode) {
    window.closeEmojiPanel?.();
    setChatToolbarOpen(false);
    input?.blur();
    ensureVoiceHoldBound('chat-hold-talk');
    warmUpMicrophone();
  } else {
    releaseWarmMic();
    if (_activeVoiceHoldId === 'chat-hold-talk') hideVoiceRecordTip();
  }
}

window.toggleChatVoiceMode = function() {
  if (!charId) {
    window.showToast?.('请先选择聊天对象');
    return;
  }
  setChatVoiceMode(!_chatVoiceMode);
};

function applyCallVoiceModeUi() {
  const composer = document.getElementById('call-composer');
  const input = document.getElementById('call-input');
  const hold = document.getElementById('call-hold-talk');
  const toggle = document.getElementById('call-voice-toggle');
  const sendBtn = document.querySelector('#call-composer .call-send-btn');
  const mic = toggle?.querySelector('.call-voice-icon-mic');
  const kbd = toggle?.querySelector('.call-voice-icon-kbd');
  composer?.classList.toggle('is-voice-mode', _callVoiceMode);
  toggle?.classList.toggle('is-voice', _callVoiceMode);
  toggle?.setAttribute('title', _callVoiceMode ? '打字' : '免提说话');
  toggle?.setAttribute('aria-label', _callVoiceMode ? '切换打字' : '切换免提说话');
  if (mic) mic.style.display = _callVoiceMode ? 'none' : '';
  if (kbd) kbd.style.display = _callVoiceMode ? '' : 'none';
  if (input) input.style.display = _callVoiceMode ? 'none' : '';
  if (hold) {
    hold.style.display = _callVoiceMode ? '' : 'none';
    hold.classList.add('is-live');
    hold.classList.remove('is-recording', 'is-cancel');
    hold.style.pointerEvents = 'none';
  }
  if (sendBtn) sendBtn.style.display = _callVoiceMode ? 'none' : '';
  if (_callVoiceMode) input?.blur();
}

function setCallVoiceMode(on) {
  _callVoiceMode = !!on;
  applyCallVoiceModeUi();
  try {
    const s = getCallEngineState();
    if (!!s.voiceMode !== !!on) engineSetVoiceMode(!!on);
    return;
  } catch {}
  if (_callVoiceMode) {
    startCallLiveListen();
  } else {
    stopCallLiveListen();
    if (_activeVoiceHoldId === 'call-hold-talk') hideVoiceRecordTip();
  }
}

window.toggleCallVoiceMode = function() {
  if (!inCall) return;
  if (_callPresenceMode === 'hangout') {
    setCallVoiceMode(true);
    window.showToast?.('连麦模式保持开麦');
    return;
  }
  setCallVoiceMode(!_callVoiceMode);
};

const CALL_LIVE_SILENCE_MS = 5000;
/** 普通模式：停说 5 秒提交 */
const CALL_REALTIME_SILENCE_MS = 5000;
/** 连麦：用户停说 5 秒后提交 */
const CALL_HANGOUT_SILENCE_MS = 5000;
const CALL_LIVE_IDLE_SUBMIT_MS = 10000;
const CALL_LIVE_COMPANION_IDLE_MS = 45000;
const CALL_BEDTIME_ASK_MS = 40000;
const CALL_BEDTIME_ASLEEP_MS = 60000;
const CALL_LIVE_MIN_MS = 550;
const CALL_LIVE_MAX_MS = 28000;
const CALL_HANGOUT_MAX_MS = 90000;
/** 连麦陪睡：用户安静这么久，下次开口重新从迷糊开始 */
const HANGOUT_WAKE_RESET_MS = 3 * 60 * 1000;
/** 连续响过这么多 tick 才算开口（约 120ms），跟以前一样 */
const CALL_LIVE_SPEECH_TICKS = 2;
/** 提交前 PCM 能量下限。连麦环境声（翻身）远低于正常说话 */
const CALL_LIVE_MIN_RMS = 0.016;
const CALL_REALTIME_MIN_RMS = 0.011;
const CALL_LIVE_HANGOUT_MIN_RMS = 0.0028;
/** 实时通话：略降开口门槛；打断对方时门槛更高，避免外放回声误触 */
const CALL_REALTIME_SPEECH_FLOOR = 0.010;
const CALL_REALTIME_BARGE_FLOOR = 0.032;
const CALL_REALTIME_SEGMENT_GAP_MS = 280;
/** 噪声底噪上限：过夜/风扇会把门限抬到听不见说话 */
const CALL_NOISE_CAP_REALTIME = 0.011;
const CALL_NOISE_CAP_DEFAULT = 0.016;
const CALL_NOISE_CAP_HANGOUT = 0.008;
/** 普通模式：沉默提示后若久等仍无开口，允许再发一次沉默（避免整晚零消息） */
const CALL_SILENCE_REARM_MS = 120000;
/** 听故事 / 你继续说：对方可以长时间听（「连麦」归底部芯片，不写进陪听） */
const CALL_COMPANION_RE = /讲故事|睡前故事|讲个故事|讲一段|念一段|念给我|陪我睡|听着就行|你继续说|接着讲|讲下去|我不说话|我听着|你说我就听|我先睡|你慢慢说|陪我听|往下讲|继续讲|讲完/;
/** 挂着电话各忙各的：不要定时捅「安静了十秒」 */
const CALL_HANGOUT_RE = /各忙各的|各干各的|你忙你的|我忙我的|挂着(?:电话|就行|呗|吧)?|放着(?:电话|就行)?|连着就行|开着就行|陪着就行|挂机陪|挂着陪|连麦挂着|先不聊|不说话也行|你忙你的我忙我的/;
const CALL_BEDTIME_RE = /睡前|陪我睡|我先睡|要睡了|去睡|困了|晚安|准备睡/;
const CALL_LIVE_TICK_MS = 60;

let _callLiveNative = false;
let _callLiveOn = false;
let _callLiveTts = false;
let _callLiveToken = 0;
let _callLiveStream = null;
let _callLiveCtx = null;
let _callLiveAnalyser = null;
let _callLiveSource = null;
let _callLiveTimer = null;
let _callLiveRec = null;
let _callLiveChunks = [];
let _callLiveUtterStart = 0;
let _callLiveSilentAt = 0;
let _callLiveLoudTicks = 0;
let _callLiveBargeTicks = 0;
let _callLiveNoise = 0.012;
let _callLiveCommitting = false;
/** 普通通话默认开实时：短停顿提交 + 对方说话时可口头打断 */
let _callRealtimeMode = true;
let _callTtsPlayGen = 0;
let _callBargeBusy = false;
let _callLiveHeardSpeech = false;
let _callLiveArmedAt = 0;
let _callNeedUserVoiceBeforeSilence = false;
let _callSilenceBlockedAt = 0;
let _callQuietRejectStreak = 0;
let _callSleepStep = 0;
/** 连麦陪睡清醒阶：0 未开口 / 1 迷糊 / 2 半醒 / 3 清醒 */
let _hangoutWakeStep = 0;
let _hangoutWakeAt = 0;
let _callPreferShortIdle = false;
let _callUserAsleep = false;
let _callDeviceLocked = false;
let _callScreenOn = true;
let _callLockPollTimer = null;
/** talk | hangout | watch */
let _callPresenceMode = 'talk';
let _hangoutMutterTimer = 0;
let _hangoutMutterBusy = false;
let _hangoutBedToken = 0;
let _watchCaptureTimer = 0;
let _watchCaptureBusy = false;
let _watchCaptureWarned = false;
let _callSoftTtsNext = false;
/** 通话里已播过听筒的消息 id，避免 DOM 先插入后 HTTP 漏播、或双通道重播 */
const _playedCallSpeechIds = new Set();

function markCallSpeechPlayed(msgId) {
  if (msgId == null || msgId === '') return;
  const s = String(msgId);
  if (s.startsWith('tmp_') || s.startsWith('seg_') || s.startsWith('vseg_') || s.startsWith('hist_')) return;
  _playedCallSpeechIds.add(s);
  if (_playedCallSpeechIds.size > 200) {
    const keep = [..._playedCallSpeechIds].slice(-120);
    _playedCallSpeechIds.clear();
    for (const id of keep) _playedCallSpeechIds.add(id);
  }
}

function wasCallSpeechPlayed(msgId) {
  if (msgId == null || msgId === '') return false;
  return _playedCallSpeechIds.has(String(msgId));
}

const CALL_WATCH_MIN_MS = 5 * 60 * 1000;
const CALL_WATCH_MAX_MS = 10 * 60 * 1000;
const CALL_WATCH_FIRST_MS = 12000;

const CALL_PRESENCE_META = {
  talk: {
    label: '普通通话',
    hint: '正常聊天 · 停顿会接话',
    toast: '已切换到普通通话',
  },
  hangout: {
    label: '连麦中',
    hint: '麦一直开着 · 停顿约十秒后发给对方',
    /** 夜间连麦：日程若休息/睡觉，对方也会跟着睡 */
    nightHint: '挂着陪睡 · 开口会慢慢把对方叫醒',
    toast: '已切换到连麦：麦一直开着，你停顿约十秒后才会发给对方',
  },
  watch: {
    label: '观影中',
    hint: '一起看 · 会按画面偶尔聊',
    toast: '已切换到观影：会按屏幕内容聊天',
  },
};

function applyCallPresenceModeUi({ announce = false } = {}) {
  const mode = _callPresenceMode === 'hangout' || _callPresenceMode === 'watch'
    ? _callPresenceMode
    : 'talk';
  const meta = CALL_PRESENCE_META[mode] || CALL_PRESENCE_META.talk;

  const bar = document.getElementById('call-mode-bar');
  if (bar) bar.dataset.mode = mode;

  document.querySelectorAll('#call-mode-bar .call-mode-chip').forEach((btn) => {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  const hint = document.getElementById('call-mode-hint');
  if (hint) {
    hint.textContent = (mode === 'hangout' && isCallEvening() && meta.nightHint)
      ? meta.nightHint
      : meta.hint;
    if (announce) {
      hint.classList.remove('is-flash');
      void hint.offsetWidth;
      hint.classList.add('is-flash');
    }
  }

  const badge = document.getElementById('call-mode-badge');
  if (badge) {
    badge.hidden = false;
    badge.dataset.mode = mode;
    badge.textContent = meta.label;
    if (announce) {
      badge.classList.remove('is-pop');
      void badge.offsetWidth;
      badge.classList.add('is-pop');
    }
  }

  const screen = document.getElementById('call-screen');
  if (screen) {
    screen.classList.toggle('is-mode-hangout', mode === 'hangout');
    screen.classList.toggle('is-mode-watch', mode === 'watch');
    screen.classList.toggle('is-mode-talk', mode === 'talk');
  }

  if (announce) {
    try { window.nianHaptic?.('tick'); } catch {}
    window.showSystemNotify?.(meta.toast, 2200);
  }
}

function stopHangoutPresence() {
  _hangoutBedToken += 1;
  if (_hangoutMutterTimer) {
    clearTimeout(_hangoutMutterTimer);
    _hangoutMutterTimer = 0;
  }
  _hangoutMutterBusy = false;
  stopHangoutBed();
}

function stopWatchPresence() {
  if (_watchCaptureTimer) {
    clearTimeout(_watchCaptureTimer);
    _watchCaptureTimer = 0;
  }
  _watchCaptureBusy = false;
}

function resetCallPresenceMode() {
  stopHangoutPresence();
  stopWatchPresence();
  _callPresenceMode = 'talk';
  _watchCaptureWarned = false;
  resetHangoutWakeLadder();
  applyCallPresenceModeUi();
}

async function startHangoutBed() {
  const token = ++_hangoutBedToken;
  const cid = callCharId;
  if (!cid) return;
  try {
    const bed = await api.fetchHangoutBed(cid);
    if (token !== _hangoutBedToken || !inCall || callDialing || _callPresenceMode !== 'hangout') return;
    const vol = Number(bed?.volume) > 0 ? Number(bed.volume) : 0.09;
    if (bed?.url) {
      playHangoutBed(bed.url, { volume: vol, procedural: bed.kind || bed.procedural });
    } else {
      playHangoutBedProcedural(bed?.procedural || bed?.kind || 'keyboard', { volume: vol });
    }
  } catch {
    if (token !== _hangoutBedToken || !inCall || _callPresenceMode !== 'hangout') return;
    playHangoutBedProcedural('keyboard', { volume: 0.085 });
  }
}

function scheduleHangoutMutter() {
  // 重做后取消定时自言自语；连麦环境音 + 周期采样接管
  if (_hangoutMutterTimer) {
    clearTimeout(_hangoutMutterTimer);
    _hangoutMutterTimer = 0;
  }
}

async function runHangoutMutter() {
  return;
}

function startHangoutPresence() {
  // 由新引擎 setCallPresenceMode 接管
  return;
}

async function captureWatchScreenUrl() {
  const cap = await captureNativeScreen();
  if (!cap?.ok || !cap.imageBase64) return '';
  const mime = cap.mime || 'image/jpeg';
  const bin = atob(cap.imageBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const ext = /png/i.test(mime) ? 'png' : 'jpg';
  const file = new File([blob], `call-watch-${Date.now()}.${ext}`, { type: mime });
  const up = await api.uploadFile(file);
  return up?.url || '';
}

function nextWatchCaptureDelayMs(first = false) {
  if (first) return CALL_WATCH_FIRST_MS;
  return CALL_WATCH_MIN_MS + Math.floor(Math.random() * (CALL_WATCH_MAX_MS - CALL_WATCH_MIN_MS + 1));
}

function scheduleWatchCapture({ first = false } = {}) {
  if (_watchCaptureTimer) {
    clearTimeout(_watchCaptureTimer);
    _watchCaptureTimer = 0;
  }
  if (!inCall || callDialing || _callPresenceMode !== 'watch') return;
  _watchCaptureTimer = setTimeout(() => { void sendWatchScreenToCharacter(); }, nextWatchCaptureDelayMs(first));
}

async function sendWatchScreenToCharacter() {
  _watchCaptureTimer = 0;
  if (!inCall || callDialing || !callCharId || _callPresenceMode !== 'watch') return;
  if (_watchCaptureBusy || _doSendBusy || _callLookBusy || _hangoutMutterBusy) {
    scheduleWatchCapture();
    return;
  }
  _watchCaptureBusy = true;
  const sendCharId = callCharId;
  try {
    const lookUrl = await captureWatchScreenUrl();
    if (!lookUrl) {
      if (!_watchCaptureWarned) {
        _watchCaptureWarned = true;
        window.showToast?.('观影截屏失败：需要原生截屏权限');
      }
      return;
    }
    if (!inCall || callCharId !== sendCharId || _callPresenceMode !== 'watch') return;
    const described = await api.fetchWatchScene(sendCharId, lookUrl);
    const scene = String(described?.scene || '').trim();
    if (!scene) {
      if (!_watchCaptureWarned) {
        _watchCaptureWarned = true;
        window.showToast?.('观影画面识别失败，请检查聊天 API');
      }
      return;
    }
    if (!inCall || callCharId !== sendCharId || _callPresenceMode !== 'watch') return;
    await doSend(
      `[一起看] 你们正一起看：${scene}。像当面追剧那样随口聊一句剧情或吐槽，也可以只输出 [安静]。不要提截图、屏幕、识图。`,
      'system',
      { hideChat: true },
      false,
      sendCharId,
    );
  } catch {
    showCharTypingFor(sendCharId, false);
    setCallIdleStatus();
  } finally {
    _watchCaptureBusy = false;
    updateCallLiveHoldUi();
    if (inCall && _callPresenceMode === 'watch') scheduleWatchCapture();
  }
}

function startWatchPresence() {
  // 由新引擎 setCallPresenceMode 接管
  return;
}

window.setCallPresenceMode = function(mode) {
  const next = mode === 'hangout' || mode === 'watch' ? mode : 'talk';
  const prev = _callPresenceMode;
  _callPresenceMode = next;
  // 引擎负责连麦环境音/采样；本地镜像给旧逻辑和 extras 兜底
  try {
    engineSetPresenceMode?.(next, { announce: prev !== next });
  } catch {
    try { patchCallEngineState({ presenceMode: next }); } catch {}
  }
  applyCallPresenceModeUi({ announce: prev !== next });
  if (!inCall || callDialing) return;
  if (next === 'talk') {
    _callLiveArmedAt = Date.now();
    _callNeedUserVoiceBeforeSilence = false;
  }
  void applyNativeCallListenMode();
  updateCallLiveHoldUi();
  if (next === 'hangout' || prev === 'hangout') {
    try { engineOnHangoutSleepChange?.(); } catch {}
  }
};

function callUserTextBlob(text) {
  const raw = String(text || '');
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const t = String(j?.transcript || '').trim();
      if (t) return t;
    } catch {}
  }
  return raw;
}

function recentCallUserTexts() {
  const texts = [];
  for (const m of (callTranscript || []).slice(-12)) {
    if (m?.role === 'user') texts.push(callUserTextBlob(m.content));
  }
  try {
    const cached = getThreadCacheSync(callCharId || charId, false);
    for (const m of (cached?.messages || []).slice(-16)) {
      if (m?.role === 'user') texts.push(callUserTextBlob(m.content));
    }
  } catch {}
  return texts;
}

function isCallCompanionListenMode() {
  if (_callPresenceMode === 'hangout' || _callPresenceMode === 'watch') return false;
  return CALL_COMPANION_RE.test(recentCallUserTexts().join('\n'));
}

/** 挂着连麦、各忙各的：麦一直开着，听到声音就收，停顿约十秒再发给角色。底部芯片优先。 */
function isCallHangoutMode() {
  return _callPresenceMode === 'hangout';
}

async function applyNativeCallListenMode() {
  if (!_callLiveNative || !_callLiveOn || !inCall || callDialing) return;
  try {
    // 连麦也走普通通话采集（耳机 AEC/NS 开着）。环境感交给模型听录音，
    // 不要关降噪——否则戴耳机时像「全开麦、没通话处理」。
    await setNativeCallListen(true, {
      ambient: false,
      bargeIn: isCallRealtimeTalk(),
    });
  } catch {}
}

/** 用户说了挂机陪/连麦/要挂着睡时，自动切到连麦芯片（仅普通模式下） */
function maybeAutoHangoutFromUserText(text) {
  if (!inCall || callDialing || _callPresenceMode !== 'talk') return;
  const raw = callUserTextBlob(text);
  if (!raw) return;
  // 讲故事陪听不要误切连麦
  if (/讲故事|讲个故事|讲一段|念一段|接着讲|继续讲|讲下去/.test(raw) && !/连麦|挂着/.test(raw)) return;
  const wantsHangout = CALL_HANGOUT_RE.test(raw)
    || /连麦/.test(raw)
    || /挂着(?:电话)?睡|别挂|不要挂|先别挂|陪我睡|一起睡/.test(raw)
    // 通话里说晚安/去睡：默认挂着陪睡，不是挂断（明确说「挂了」除外）
    || (CALL_BEDTIME_RE.test(raw) && !/挂了|挂电话|拜拜|先挂|挂掉|结束通话/.test(raw));
  if (wantsHangout) {
    window.setCallPresenceMode?.('hangout');
  }
}

/**
 * bedtime listen 模式判定。
 * 原先还要看 isCallEvening() 自动开启——晚上 22 点开始只要用户提「讲故事/陪我听」就被吞进 bedtime，
 * 30 秒后自动塞「是不是睡着了」、60 秒后塞「已经睡着了」，导致用户想听一段完整故事被活活打断成 [安静]。
 * 现在只在用户**真正说过晚安/要睡的关键词**时才打开 bedtime；陪伴听故事可以正常进行到自然收束。
 */
function isCallBedtimeListenMode() {
  if (_callPresenceMode === 'hangout' || _callPresenceMode === 'watch') return false;
  return CALL_BEDTIME_RE.test(recentCallUserTexts().join('\n'));
}

function isCallEvening() {
  try {
    const hour = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: chatTimeZone(),
      hour: 'numeric',
      hour12: false,
    }).format(new Date()), 10);
    return hour >= 22 || hour < 6;
  } catch {
    const h = new Date().getHours();
    return h >= 22 || h < 6;
  }
}

async function refreshCallLockState() {
  const wasLocked = _callDeviceLocked || _callScreenOn === false;
  try {
    const st = await getNativeDeviceStatus();
    if (st?.native) {
      _callDeviceLocked = !!st.locked;
      _callScreenOn = st.screenOn !== false;
    } else {
      _callDeviceLocked = false;
      _callScreenOn = document.visibilityState !== 'hidden';
    }
  } catch {
    _callDeviceLocked = false;
    _callScreenOn = document.visibilityState !== 'hidden';
  }
  const nowAwake = !_callDeviceLocked && _callScreenOn !== false;
  // 锁屏一夜后「判定睡着」会永久挡住沉默提交；亮屏回来要重新开听
  if (wasLocked && nowAwake && inCall && !callDialing) {
    reviveCallLiveAfterForeground();
  } else if (!nowAwake && inCall && !callDialing && _callPresenceMode === 'hangout') {
    try { engineSetUserAsleep(true); } catch {}
    // 锁屏时常卡在 speaking，周期采样/原生收句都会停——先清掉
    try { setCallSpeaking(false); } catch {}
  }
}

function startCallLockPoll() {
  stopCallLockPoll();
  refreshCallLockState();
  _callLockPollTimer = setInterval(() => { refreshCallLockState(); }, 4000);
}

function stopCallLockPoll() {
  if (_callLockPollTimer) {
    clearInterval(_callLockPollTimer);
    _callLockPollTimer = null;
  }
}

function resetCallSleepWatch() {
  _callSleepStep = 0;
  _callUserAsleep = false;
  _callPreferShortIdle = false;
  resetHangoutWakeLadder();
}

/** 亮屏/回前台：清掉「睡着」锁、压低噪声底、重新开原生麦 */
function reviveCallLiveAfterForeground() {
  if (!inCall || callDialing || !_callVoiceMode) return;
  _callUserAsleep = false;
  try { engineSetUserAsleep(false); } catch {}
  if (_callSleepStep >= 1 && !isCallBedtimeListenMode()) _callSleepStep = 0;
  _callNeedUserVoiceBeforeSilence = false;
  _callSilenceBlockedAt = 0;
  _callQuietRejectStreak = 0;
  _callLiveNoise = Math.min(_callLiveNoise, isCallHangoutMode() ? 0.006 : 0.009);
  // 锁屏时 TTS 结束回调常冻住，speaking 卡住会永久关麦——先强制清掉
  try { setCallSpeaking(false); } catch {}
  try { engineSetThinking(false); } catch {}
  // 正在录一句时别清掉开口标记，否则停顿永远交不出去
  if (!_callLiveRec && !_callLiveCommitting) {
    _callLiveHeardSpeech = false;
    _callLiveArmedAt = Date.now();
    _callLiveLoudTicks = 0;
    _callLiveBargeTicks = 0;
  }
  // 新引擎优先：force 清 speaking 并重开麦
  try {
    void engineReviveAfterForeground();
  } catch {
    void engineArmAfterSpeak({ force: true }).catch(() => {});
  }
  if (_callLiveOn) {
    void applyNativeCallListenMode();
    try { _callLiveCtx?.resume?.(); } catch {}
  }
  keepCallCaptureAlive();
  updateCallLiveHoldUi();
}

function callNoiseCap() {
  if (isCallHangoutMode()) return CALL_NOISE_CAP_HANGOUT;
  if (isCallRealtimeTalk()) return CALL_NOISE_CAP_REALTIME;
  return CALL_NOISE_CAP_DEFAULT;
}

function maybeRearmCallSilence() {
  if (!_callNeedUserVoiceBeforeSilence || _callUserAsleep) return;
  if (isCallHangoutMode() || _callPresenceMode === 'watch') return;
  if (!_callSilenceBlockedAt) return;
  if (Date.now() - _callSilenceBlockedAt < CALL_SILENCE_REARM_MS) return;
  _callNeedUserVoiceBeforeSilence = false;
  _callSilenceBlockedAt = 0;
  if (!_callLiveHeardSpeech && !_callLiveRec) _callLiveArmedAt = Date.now();
}

const HANGOUT_KEEP_SLEEP_RE = /继续睡|再睡会|再睡一會兒|再眯|你睡|睡吧|睡啊|去睡|晚安|好梦|好夢|抱抱|摸摸|陪我睡|我不吵|没事你睡|沒事你睡|安啦|没事了|沒事了/;
const HANGOUT_SOFT_VOICE_RE = /^(嗯+|唔+|啊+|唉+|呵+|哦+|噢+|欸+|哎+|呼+|……|\.{1,}|…+|哼+)$/;

function resetHangoutWakeLadder() {
  _hangoutWakeStep = 0;
  _hangoutWakeAt = 0;
}

function currentHangoutWakeStep() {
  if (!_hangoutWakeStep) return 0;
  if (_hangoutWakeAt && Date.now() - _hangoutWakeAt > HANGOUT_WAKE_RESET_MS) {
    _hangoutWakeStep = 0;
    return 0;
  }
  return _hangoutWakeStep;
}

function hangoutUtteranceLooksKeepSleep(text) {
  const raw = callUserTextBlob(text);
  const t = String(raw || '').replace(/\s+/g, '').trim();
  if (!t) return false;
  return HANGOUT_SOFT_VOICE_RE.test(t) || HANGOUT_KEEP_SLEEP_RE.test(t);
}

function noteHangoutUserSpeech(text) {
  if (!isCallHangoutMode()) return;
  const now = Date.now();
  if (_hangoutWakeAt && now - _hangoutWakeAt > HANGOUT_WAKE_RESET_MS) {
    _hangoutWakeStep = 0;
  }
  _hangoutWakeAt = now;
  if (hangoutUtteranceLooksKeepSleep(text)) {
    _hangoutWakeStep = Math.max(1, Math.min(_hangoutWakeStep, 1));
    return;
  }
  _hangoutWakeStep = Math.min(3, Math.max(1, _hangoutWakeStep + 1));
}

function callUtteranceSilenceMs() {
  if (isCallHangoutMode()) return CALL_HANGOUT_SILENCE_MS;
  if (isCallRealtimeTalk()) return CALL_REALTIME_SILENCE_MS;
  return CALL_LIVE_SILENCE_MS;
}

function callUtteranceMaxMs() {
  return isCallHangoutMode() ? CALL_HANGOUT_MAX_MS : CALL_LIVE_MAX_MS;
}

function onCallUserSpoke(text) {
  _callSleepStep = 0;
  _callUserAsleep = false;
  _callPreferShortIdle = true;
  try { noteUserSpeechForSleep(String(text || '')); } catch {}
  noteHangoutUserSpeech(text);
  // 连麦：用户开口后先把自言自语推后，避免刚叫醒又被呓语打断
  if (inCall && _callPresenceMode === 'hangout') {
    scheduleHangoutMutter();
  }
}

function isCallLockNightMode() {
  if (!inCall || callDialing || _callUserAsleep) return false;
  // 锁屏 / 屏幕灭：用户在忙别的，给足空间，连麦自然挂着即可，
  // 但不再联合「22 点后」强制拉成 bedtime 主动催睡链路（以前 22 点后只要锁屏就触发）。
  if (_callDeviceLocked || _callScreenOn === false) return true;
  return false;
}

function isCallBedtimeIdle() {
  return isCallBedtimeListenMode() || isCallLockNightMode();
}

function callSilenceIdleMs() {
  if (_callUserAsleep) return 36e5;
  if (_callSleepStep >= 1) return CALL_BEDTIME_ASLEEP_MS;
  // 各忙各的 / 挂着连麦 / 观影：不自动提交沉默（0 = 关闭）
  if (isCallHangoutMode() || _callPresenceMode === 'watch') return 0;
  if (isCallBedtimeIdle()) return CALL_BEDTIME_ASK_MS;
  // 听故事等陪听：拉长空闲，且不受「刚说过话就改回 10 秒」影响
  if (isCallCompanionListenMode()) return CALL_LIVE_COMPANION_IDLE_MS;
  if (_callPreferShortIdle) return CALL_LIVE_IDLE_SUBMIT_MS;
  return CALL_LIVE_IDLE_SUBMIT_MS;
}

function updateCallLiveHoldUi() {
  const hold = document.getElementById('call-hold-talk');
  if (hold && _callVoiceMode) {
    hold.classList.add('is-live');
    hold.style.pointerEvents = 'none';
    if (_callLiveCommitting) {
      hold.classList.remove('is-hearing', 'is-paused');
      hold.textContent = '正在发送…';
    } else if (_callLiveTts) {
      hold.classList.add('is-paused');
      hold.classList.remove('is-hearing');
      hold.textContent = isCallRealtimeTalk() ? '对方正在说 · 可开口打断' : '对方正在说';
    } else if (_callLiveRec) {
      hold.classList.remove('is-paused');
      hold.classList.add('is-hearing');
      const silentMs = _callLiveSilentAt ? Date.now() - _callLiveSilentAt : 0;
      if (silentMs > 350 && _callLiveHeardSpeech) {
        const waitMs = callUtteranceSilenceMs();
        const left = Math.max(1, Math.ceil((waitMs - silentMs) / 1000));
        hold.textContent = `停顿 ${left} 秒后发送`;
      } else {
        hold.textContent = isCallHangoutMode() ? '连麦中' : '正在使用麦克风';
      }
    } else if (_doSendBusy) {
      hold.classList.add('is-paused');
      hold.classList.remove('is-hearing');
      hold.textContent = '对方正在想';
    } else if (_callLiveOn) {
      hold.classList.remove('is-paused');
      hold.classList.add('is-hearing');
      hold.textContent = isCallHangoutMode()
        ? '连麦中'
        : (_callPresenceMode === 'watch' ? '观影中' : '正在使用麦克风');
    } else {
      hold.classList.remove('is-hearing', 'is-paused');
      hold.textContent = '通话中';
    }
  }
  syncCallWaveform();
  const phase = callOverlayPhase();
  if (phase !== _lastCallOverlayPhase) syncNativeCallOverlay({ phase });
}

function callLiveRms() {
  if (_callLiveNative) return nativeCallRms();
  const analyser = _callLiveAnalyser;
  if (!analyser) return 0;
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

function abortCallLiveUtterance() {
  const rec = _callLiveRec;
  _callLiveRec = null;
  _callLiveChunks = [];
  _callLiveUtterStart = 0;
  _callLiveSilentAt = 0;
  _callLiveLoudTicks = 0;
  if (rec?.native) {
    abortNativeCallUtterance();
    updateCallLiveHoldUi();
    return;
  }
  if (rec && rec.state !== 'inactive') {
    try { rec.ondataavailable = null; rec.onstop = null; rec.stop(); } catch {}
  }
  updateCallLiveHoldUi();
}

async function armCallLiveAfterSpeak() {
  // 新引擎接管收音状态机
  try {
    await engineArmAfterSpeak();
    return;
  } catch {}
  if (!inCall || callDialing || !_callVoiceMode) {
    syncCallWaveform();
    return;
  }
  if (!_callLiveOn) await startCallLiveListen();
  if (!inCall || callDialing || !_callVoiceMode) return;
  if (_callLiveTts && isCallRealtimeTalk()) {
    syncCallBedDuck();
    updateCallLiveHoldUi();
    syncCallWaveform();
    return;
  }
  if (_callLiveTts) return;
  abortCallLiveUtterance();
  _callLiveHeardSpeech = false;
  _callLiveArmedAt = _callNeedUserVoiceBeforeSilence ? 0 : Date.now();
  syncCallBedDuck();
  updateCallLiveHoldUi();
  syncCallWaveform();
}

async function submitCallSilence() {
  // 重做后：普通模式不再自动塞「安静了十秒」；连麦靠 5s 停顿提交 / 周期采样
  return;
}

async function beginCallLiveUtterance() {
  if (_callLiveRec || _callLiveCommitting) return;
  if (_callLiveNative) {
    await beginNativeCallUtterance();
    _callLiveRec = { native: true, state: 'recording', mimeType: 'audio/wav' };
    _callLiveUtterStart = Date.now();
    _callLiveSilentAt = 0;
    updateCallLiveHoldUi();
    return;
  }
  if (!_callLiveStream) return;
  const mime = pickVoiceMimeType();
  _callLiveChunks = [];
  const recOpts = mime
    ? { mimeType: mime, audioBitsPerSecond: 128000 }
    : { audioBitsPerSecond: 128000 };
  let rec;
  try {
    rec = new MediaRecorder(_callLiveStream, recOpts);
  } catch {
    rec = mime ? new MediaRecorder(_callLiveStream, { mimeType: mime }) : new MediaRecorder(_callLiveStream);
  }
  rec.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) _callLiveChunks.push(ev.data);
  };
  try {
    rec.start(200);
  } catch {
    rec.start();
  }
  _callLiveRec = rec;
  _callLiveUtterStart = Date.now();
  _callLiveSilentAt = 0;
  updateCallLiveHoldUi();
}

function wavPcmRms(blob) {
  if (!blob || blob.size < 48) return 0;
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let sum = 0;
    let n = 0;
    for (let i = 44; i + 1 < bytes.length; i += 2) {
      let s = bytes[i] | (bytes[i + 1] << 8);
      if (s >= 32768) s -= 65536;
      const v = s / 32768;
      sum += v * v;
      n += 1;
    }
    return n ? Math.sqrt(sum / n) : 0;
  }).catch(() => 0);
}

function rejectCallLiveClip() {
  _callLiveCommitting = false;
  _callLiveHeardSpeech = false;
  _callQuietRejectStreak = Math.min(8, (_callQuietRejectStreak || 0) + 1);
  // 连续太安静被丢弃：噪声底/门槛可能过高，往下松一档
  if (_callQuietRejectStreak >= 2) {
    _callLiveNoise = Math.min(_callLiveNoise, callNoiseCap() * 0.7);
  }
  if (!_callNeedUserVoiceBeforeSilence) _callLiveArmedAt = Date.now();
  updateCallLiveHoldUi();
}

async function commitCallLiveUtterance() {
  if (_callLiveCommitting || !_callLiveRec) return;
  const rec = _callLiveRec;
  const startedAt = _callLiveUtterStart;
  _callLiveRec = null;
  _callLiveUtterStart = 0;
  _callLiveSilentAt = 0;
  _callLiveCommitting = true;
  updateCallLiveHoldUi();
  if (rec?.native) {
    let blob = null;
    let mimeType = 'audio/wav';
    try {
      const r = await commitNativeCallUtterance();
      mimeType = r?.mime || 'audio/wav';
      const b64 = String(r?.base64 || '');
      if (b64) {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        blob = new Blob([bin], { type: mimeType });
      }
    } catch {}
    const wallSec = Math.max(0, (Date.now() - startedAt) / 1000);
    const energy = blob && /wav/i.test(mimeType) ? await wavPcmRms(blob) : 1;
    const minRms = callLiveMinRms();
    const tooQuiet = blob && /wav/i.test(mimeType) && energy < minRms;
    const tooShort = wallSec < CALL_LIVE_MIN_MS / 1000 || !blob || blob.size < 400 || tooQuiet;
    if (tooShort) {
      rejectCallLiveClip();
      return;
    }
    try {
      while ((_doSendBusy || _voiceSending) && inCall) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!inCall || !callCharId) return;
      _callNeedUserVoiceBeforeSilence = false;
      _callSilenceBlockedAt = 0;
      _callQuietRejectStreak = 0;
      const durationSec = Math.max(1, Math.round(wallSec) || 1);
      const file = new File([blob], `call-live-${Date.now()}.wav`, { type: mimeType });
      _voiceSending = true;
      const uploaded = await api.uploadChatVoice(file, durationSec);
      if (!uploaded?.url) throw new Error('上传未返回地址');
      const content = encodeUserVoiceContent({
        url: uploaded.url,
        duration: uploaded.duration || durationSec,
        voiceprint: uploaded.voiceprint || null,
      });
      await doSend(content, 'voice', { duration: uploaded.duration || durationSec }, false, callCharId);
    } catch (err) {
      if (inCall) window.showToast?.('语音发送失败: ' + (err?.message || '网络错误'));
    } finally {
      _voiceSending = false;
      _callLiveCommitting = false;
      _callLiveHeardSpeech = false;
      updateCallLiveHoldUi();
      setCallIdleStatus();
    }
    return;
  }
  const mimeType = rec.mimeType || pickVoiceMimeType() || 'audio/webm';
  const blob = await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(new Blob(_callLiveChunks, { type: mimeType }));
    };
    rec.onstop = done;
    try {
      if (typeof rec.requestData === 'function' && rec.state === 'recording') {
        try { rec.requestData(); } catch {}
      }
      if (rec.state !== 'inactive') rec.stop();
      else done();
    } catch {
      done();
    }
    setTimeout(done, 1500);
  });
  const chunks = _callLiveChunks;
  _callLiveChunks = [];
  const wallSec = Math.max(0, (Date.now() - startedAt) / 1000);
  const tooShort = wallSec < CALL_LIVE_MIN_MS / 1000 || blob.size < 400 || !chunks.length;
  if (tooShort) {
    rejectCallLiveClip();
    return;
  }
  try {
    while ((_doSendBusy || _voiceSending) && inCall) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!inCall || !callCharId) return;
    _callNeedUserVoiceBeforeSilence = false;
    _callSilenceBlockedAt = 0;
    _callQuietRejectStreak = 0;
    const metaSec = await probeAudioBlobDuration(blob);
    const durationSec = Math.max(1, Math.round(metaSec > 0.4 ? metaSec : wallSec) || 1);
    const ext = /mp4|m4a/i.test(mimeType) ? 'm4a' : (/ogg/i.test(mimeType) ? 'ogg' : 'webm');
    const file = new File([blob], `call-live-${Date.now()}.${ext}`, { type: mimeType || 'audio/webm' });
    _voiceSending = true;
    const uploaded = await api.uploadChatVoice(file, durationSec);
    if (!uploaded?.url) throw new Error('上传未返回地址');
    const content = encodeUserVoiceContent({
      url: uploaded.url,
      duration: uploaded.duration || durationSec,
      voiceprint: uploaded.voiceprint || null,
    });
    await doSend(content, 'voice', { duration: uploaded.duration || durationSec }, false, callCharId);
  } catch (err) {
    if (inCall) window.showToast?.('语音发送失败: ' + (err?.message || '网络错误'));
  } finally {
    _voiceSending = false;
    _callLiveCommitting = false;
    _callLiveHeardSpeech = false;
    updateCallLiveHoldUi();
    setCallIdleStatus();
  }
}

function maybeNoteNativeCallListen() {
  if (!_callLiveNative || !inCall || callDialing) return;
  const now = Date.now();
  if (now - _callListenNoteAt < 500) return;
  _callListenNoteAt = now;
  const speechRms = isCallHangoutMode() ? 0.008 : (isCallRealtimeTalk() ? 0.016 : 0.02);
  void noteNativeCallListenTick({
    silenceMs: callUtteranceSilenceMs(),
    maxMs: callUtteranceMaxMs(),
    speechRms,
  });
}

function tickCallLiveListen() {
  if (!_callLiveOn) return;
  if (!_callLiveNative && !_callLiveAnalyser) return;
  maybeNoteNativeCallListen();
  if (_callLiveNative && nativeCallLevelAge() > 250) void pullNativeCallRms();
  if (callMinimized || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
    const now = Date.now();
    if (now - _callCaptureNudgeAt > 2000) {
      _callCaptureNudgeAt = now;
      keepCallCaptureAlive();
    }
  }
  if (_callLiveCommitting || callDialing || !inCall) {
    updateCallLiveHoldUi();
    syncCallWaveform();
    return;
  }
  maybeRearmCallSilence();
  const rms = callLiveRms();
  const hangout = isCallHangoutMode();
  const realtime = isCallRealtimeTalk();
  const noiseCap = callNoiseCap();
  if (!_callLiveHeardSpeech && !_callLiveTts) {
    _callLiveNoise = Math.min(noiseCap, _callLiveNoise * 0.96 + rms * 0.04);
  } else if (!_callLiveHeardSpeech && _callLiveTts && realtime) {
    _callLiveNoise = Math.min(noiseCap, _callLiveNoise * 0.98 + rms * 0.02);
  }
  const speechTh = hangout
    ? Math.max(0.006, _callLiveNoise * 1.7)
    : realtime
      ? Math.max(CALL_REALTIME_SPEECH_FLOOR, _callLiveNoise * 2.2)
      : Math.max(0.018, _callLiveNoise * 3.0);
  const silenceTh = hangout
    ? Math.max(0.004, _callLiveNoise * 1.2)
    : realtime
      ? Math.max(0.007, _callLiveNoise * 1.45)
      : Math.max(0.010, _callLiveNoise * 1.7);

  if (_callLiveTts && realtime && !_callLiveRec && !_voiceSending && !_doSendBusy) {
    const bargeTh = Math.max(CALL_REALTIME_BARGE_FLOOR, _callLiveNoise * 4.2);
    if (rms >= bargeTh) {
      _callLiveBargeTicks += 1;
      if (_callLiveBargeTicks >= CALL_LIVE_SPEECH_TICKS) {
        _callLiveBargeTicks = 0;
        void handleCallBargeIn();
      }
    } else {
      _callLiveBargeTicks = 0;
    }
    updateCallLiveHoldUi();
    syncCallWaveform();
    return;
  }
  _callLiveBargeTicks = 0;

  if (_callLiveTts || _doSendBusy) {
    updateCallLiveHoldUi();
    syncCallWaveform();
    return;
  }
  const loud = rms >= (_callLiveRec ? silenceTh : speechTh);
  if (loud) {
    _callLiveLoudTicks += 1;
    _callLiveSilentAt = 0;
    if (_callLiveLoudTicks >= CALL_LIVE_SPEECH_TICKS) {
      _callLiveHeardSpeech = true;
      _callLiveArmedAt = 0;
      if (!_callLiveRec && !_voiceSending) beginCallLiveUtterance();
    }
  } else {
    _callLiveLoudTicks = 0;
    if (_callLiveRec && _callLiveHeardSpeech) {
      if (!_callLiveSilentAt) _callLiveSilentAt = Date.now();
      const silentMs = Date.now() - _callLiveSilentAt;
      const elapsed = Date.now() - _callLiveUtterStart;
      if (elapsed >= callUtteranceMaxMs()) {
        commitCallLiveUtterance();
      } else if (silentMs >= callUtteranceSilenceMs() && elapsed >= CALL_LIVE_MIN_MS) {
        commitCallLiveUtterance();
      }
    } else if (!_callLiveHeardSpeech && _callLiveArmedAt && !_voiceSending && !_doSendBusy) {
      const idleMs = callSilenceIdleMs();
      if (idleMs > 0 && Date.now() - _callLiveArmedAt >= idleMs) {
        submitCallSilence();
        return;
      }
    }
  }
  updateCallLiveHoldUi();
  syncCallWaveform();
}

async function startCallLiveListen() {
  // 新通话引擎接管麦；旧 VAD 不再平行开两套
  try {
    await engineArmAfterSpeak();
    return;
  } catch {}
  if (!inCall || callDialing) return;
  if (_callLiveOn) {
    updateCallLiveHoldUi();
    return;
  }
  const token = ++_callLiveToken;
  const hold = document.getElementById('call-hold-talk');
  if (hold) hold.textContent = '正在接通麦克风…';
  if (useNativeCallAudio()) {
    try {
      unlockAudioPlayback?.();
      await ensureNativeMicGranted();
      const started = await startNativeCall();
      if (token !== _callLiveToken || !inCall || !_callVoiceMode || callDialing) return;
      if (!started?.ok) throw new Error(started?.error || '无法打开通话麦克风');
      await setNativeCallListen(true, {
        ambient: false,
        bargeIn: isCallRealtimeTalk(),
      });
      _callLiveNative = true;
      _callLiveOn = true;
      _callLiveNoise = Math.min(0.009, callNoiseCap());
      _callLiveLoudTicks = 0;
      _callLiveHeardSpeech = false;
      if (!_callNeedUserVoiceBeforeSilence) _callLiveArmedAt = Date.now();
      syncCallBedDuck();
      syncCallWaveform();
      if (_callLiveTimer) clearInterval(_callLiveTimer);
      _callLiveTimer = setInterval(tickCallLiveListen, CALL_LIVE_TICK_MS);
      document.getElementById('call-screen')?.classList.add('is-live-listen');
      bindCallLiveForegroundHooks();
      updateCallLiveHoldUi();
      setCallIdleStatus();
    } catch (err) {
      if (token !== _callLiveToken) return;
      stopCallLiveListen();
      _callVoiceMode = false;
      applyCallVoiceModeUi();
      await toastMicFailure(err);
    }
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    _callVoiceMode = false;
    applyCallVoiceModeUi();
    window.showToast?.('当前环境不支持免提说话，请改用打字');
    return;
  }
  try {
    unlockAudioPlayback?.();
    let stream = takePreparedCallAudio();
    if (!stream) {
      await ensureNativeMicGranted();
      stream = await getUserMediaAudio();
    }
    if (token !== _callLiveToken || !inCall || !_callVoiceMode || callDialing) {
      stopMediaStream(stream);
      return;
    }
    _callLiveStream = stream;
    attachCallMicSink(stream);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      _callLiveCtx = new Ctx();
      try { await _callLiveCtx.resume(); } catch {}
      if (token !== _callLiveToken || !inCall) {
        stopCallLiveListen();
        return;
      }
      _callLiveSource = _callLiveCtx.createMediaStreamSource(_callLiveStream);
      _callLiveAnalyser = _callLiveCtx.createAnalyser();
      _callLiveAnalyser.fftSize = 2048;
      _callLiveAnalyser.smoothingTimeConstant = 0.35;
      _callLiveSource.connect(_callLiveAnalyser);
    }
    if (!_callLiveAnalyser) {
      stopMediaStream(stream);
      _callLiveStream = null;
      throw new Error('无法检测音量');
    }
    _callLiveOn = true;
    _callLiveNoise = Math.min(0.009, callNoiseCap());
    _callLiveLoudTicks = 0;
    _callLiveHeardSpeech = false;
    if (!_callNeedUserVoiceBeforeSilence) _callLiveArmedAt = Date.now();
    syncCallBedDuck();
    syncCallWaveform();
    if (_callLiveTimer) clearInterval(_callLiveTimer);
    _callLiveTimer = setInterval(tickCallLiveListen, CALL_LIVE_TICK_MS);
    document.getElementById('call-screen')?.classList.add('is-live-listen');
    bindCallLiveForegroundHooks();
    updateCallLiveHoldUi();
    setCallIdleStatus();
  } catch (err) {
    if (token !== _callLiveToken) return;
    stopCallLiveListen();
    _callVoiceMode = false;
    applyCallVoiceModeUi();
    await toastMicFailure(err);
  }
}

/** 页面计时被系统停掉时，原生麦自己把一句收完再交给这里发出去 */
window.__nianIngestNativeUtterance = async function(b64, wallMs) {
  if (!inCall || callDialing || !callCharId) return;
  if (_callLiveCommitting || _voiceSending) return;
  // 后台收句时若 speaking 仍卡着，先清掉，否则角色回完又关麦
  try { setCallSpeaking(false); } catch {}
  try { engineSetThinking(false); } catch {}
  _callLiveRec = null;
  _callLiveHeardSpeech = false;
  const raw = String(b64 || '');
  if (!raw) return;
  let blob = null;
  try {
    const bin = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    blob = new Blob([bin], { type: 'audio/wav' });
  } catch {
    return;
  }
  const wallSec = Math.max(0, Number(wallMs) || 0) / 1000;
  const energy = await wavPcmRms(blob);
  const tooQuiet = energy < callLiveMinRms();
  const tooShort = wallSec < CALL_LIVE_MIN_MS / 1000 || blob.size < 400 || tooQuiet;
  if (tooShort) return;
  _callLiveCommitting = true;
  _callLiveRec = null;
  updateCallLiveHoldUi();
  try {
    while ((_doSendBusy || _voiceSending) && inCall) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!inCall || !callCharId) return;
    _callNeedUserVoiceBeforeSilence = false;
    _callSilenceBlockedAt = 0;
    _callQuietRejectStreak = 0;
    const durationSec = Math.max(1, Math.round(wallSec) || 1);
    const file = new File([blob], `call-live-${Date.now()}.wav`, { type: 'audio/wav' });
    _voiceSending = true;
    const uploaded = await api.uploadChatVoice(file, durationSec);
    if (!uploaded?.url) throw new Error('上传未返回地址');
    const content = encodeUserVoiceContent({
      url: uploaded.url,
      duration: uploaded.duration || durationSec,
      voiceprint: uploaded.voiceprint || null,
    });
    await doSend(content, 'voice', { duration: uploaded.duration || durationSec }, false, callCharId);
  } catch (err) {
    if (inCall) window.showToast?.('语音发送失败: ' + (err?.message || '网络错误'));
  } finally {
    _voiceSending = false;
    _callLiveCommitting = false;
    _callLiveHeardSpeech = false;
    updateCallLiveHoldUi();
    setCallIdleStatus();
    try { void engineArmAfterSpeak({ force: true }); } catch {}
  }
};

function bindCallLiveForegroundHooks() {
  if (window.__nianCallLiveVis) return;
  window.__nianCallLiveVis = true;
  document.addEventListener('visibilitychange', () => {
    if (!inCall || !_callVoiceMode) return;
    if (document.visibilityState === 'visible') {
      reviveCallLiveAfterForeground();
      return;
    }
    keepCallCaptureAlive({ relisten: true });
  });
  try {
    window.Capacitor?.Plugins?.App?.addListener?.('appStateChange', ({ isActive }) => {
      if (!inCall || !_callVoiceMode) return;
      if (isActive) reviveCallLiveAfterForeground();
      else keepCallCaptureAlive({ relisten: true });
    });
  } catch {}
}

function stopCallLiveListen() {
  _callLiveToken++;
  _callLiveOn = false;
  _callLiveTts = false;
  _callLiveCommitting = false;
  _callLiveBargeTicks = 0;
  _callBargeBusy = false;
  _callTtsPlayGen += 1;
  if (_callLiveNative) {
    setNativeCallListen(false);
    _callLiveNative = false;
  }
  if (_callLiveTimer) {
    clearInterval(_callLiveTimer);
    _callLiveTimer = null;
  }
  abortCallLiveUtterance();
  if (_callLiveSource) {
    try { _callLiveSource.disconnect(); } catch {}
  }
  _callLiveSource = null;
  _callLiveAnalyser = null;
  if (_callLiveCtx) {
    try { _callLiveCtx.close(); } catch {}
  }
  _callLiveCtx = null;
  if (_callLiveStream) {
    stopMediaStream(_callLiveStream);
  }
  _callLiveStream = null;
  const micSink = document.getElementById('call-mic-sink');
  if (micSink) micSink.srcObject = null;
  stopPreparedCallAudio();
  document.getElementById('call-screen')?.classList.remove('is-live-listen');
  const hold = document.getElementById('call-hold-talk');
  hold?.classList.remove('is-hearing', 'is-paused');
  if (hold) {
    hold.classList.add('is-live');
    hold.style.pointerEvents = 'none';
    hold.textContent = '通话中';
  }
  syncCallBedDuck();
  syncCallWaveform();
}

function showVoiceRecordTip(cancel) {
  let tip = document.getElementById('chat-voice-record-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chat-voice-record-tip';
    tip.className = 'chat-voice-record-tip';
    tip.innerHTML = `<div class="chat-voice-record-label"></div><span class="chat-voice-record-sec">0"</span>`;
    document.body.appendChild(tip);
  }
  tip.classList.toggle('is-cancel', !!cancel);
  const label = tip.querySelector('.chat-voice-record-label');
  if (label) label.textContent = cancel ? '松开手指，取消发送' : '松开发送，上滑取消';
  tip.style.display = '';
}

function updateVoiceRecordSec(sec) {
  const el = document.querySelector('#chat-voice-record-tip .chat-voice-record-sec');
  if (el) el.textContent = `${Math.max(0, Math.floor(sec))}"`;
}

function hideVoiceRecordTip() {
  const tip = document.getElementById('chat-voice-record-tip');
  if (tip) tip.style.display = 'none';
}

function stopVoiceStream() {
  if (_voiceStream) {
    try { _voiceStream.getTracks().forEach((t) => t.stop()); } catch {}
  }
  _voiceStream = null;
  if (!inCall) setNativeCallMediaAudio(false);
}

function resetVoiceHoldButton(hold) {
  if (!hold || hold.id === 'call-hold-talk') return;
  hold.classList.remove('is-recording', 'is-cancel');
  hold.textContent = '按住 说话';
}

function resetVoiceRecordingState() {
  if (_voiceMaxTimer) { clearTimeout(_voiceMaxTimer); _voiceMaxTimer = null; }
  if (_voiceTickTimer) { clearInterval(_voiceTickTimer); _voiceTickTimer = null; }
  _voiceRec = null;
  _voiceChunks = [];
  _voicePointerId = null;
  _voiceCancel = false;
  _voiceStartedAt = 0;
  _voiceStarting = false;
  _voiceReleasedWhileStarting = false;
  stopVoiceStream();
  hideVoiceRecordTip();
  resetVoiceHoldButton(document.getElementById('chat-hold-talk'));
}

function bindVoiceDocListeners() {
  if (_voiceDocListening) return;
  _voiceDocListening = true;
  // 用 document 捕获松手，避免手指滑出按钮就丢 pointerup / 录不上
  document.addEventListener('pointermove', onVoiceDocPointerMove, true);
  document.addEventListener('pointerup', onVoiceDocPointerUp, true);
  document.addEventListener('pointercancel', onVoiceDocPointerCancel, true);
}

function onVoiceDocPointerMove(e) {
  if ((!_voiceRec && !_voiceStarting) || (_voicePointerId != null && e.pointerId !== _voicePointerId)) return;
  if (!_voiceStartedAt) return;
  const dy = (_voiceStartY || 0) - (e.clientY || 0);
  _voiceCancel = dy > 56;
  const hold = getActiveVoiceHold();
  hold?.classList.toggle('is-cancel', _voiceCancel);
  if (hold && _voiceRec) hold.textContent = _voiceCancel ? '松开取消' : '松开发送';
  showVoiceRecordTip(_voiceCancel);
  updateVoiceRecordSec((Date.now() - _voiceStartedAt) / 1000);
}

function onVoiceDocPointerUp(e) {
  if (_voicePointerId != null && e.pointerId !== _voicePointerId) return;
  if (_voiceStarting) {
    // 权限弹窗 / getUserMedia 期间松手：标记，等 start 完成后立刻收尾
    _voiceReleasedWhileStarting = true;
    _voiceCancel = _voiceCancel || ((_voiceStartY || 0) - (e.clientY || 0) > 56);
    return;
  }
  if (!_voiceRec) return;
  const cancel = _voiceCancel || ((_voiceStartY || 0) - (e.clientY || 0) > 56);
  finishVoiceRecording({ cancel });
}

function onVoiceDocPointerCancel(e) {
  if (_voicePointerId != null && e.pointerId !== _voicePointerId) return;
  if (_voiceStarting) {
    // 系统权限弹窗常会触发 cancel，不能当成取消录音；仅在用户已明确抬起时由 pointerup 标记
    return;
  }
  if (!_voiceRec) return;
  finishVoiceRecording({ cancel: _voiceCancel });
}

async function beginVoiceRecording(e) {
  if (_callLiveOn) return;
  const holdIdHint = e?.currentTarget?.id || _activeVoiceHoldId || '';
  const forGroupVoice = holdIdHint === 'group-hold-talk' || !!window._groupChatVoiceTarget;
  if (_voiceSending || _voiceRec || _voiceStarting || (!charId && !forGroupVoice)) return;
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    window.showToast?.('录音需要 HTTPS 或 localhost');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    window.showToast?.('当前浏览器不支持录音');
    return;
  }
  try {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    unlockAudioPlayback?.();
    _activeVoiceHoldId = e?.currentTarget?.id || _activeVoiceHoldId || 'chat-hold-talk';
    if (_activeVoiceHoldId === 'call-hold-talk') return;
    _voicePointerId = e?.pointerId ?? null;
    _voiceStartY = e?.clientY ?? 0;
    _voiceCancel = false;
    _voiceReleasedWhileStarting = false;
    _voiceStarting = true;
    bindVoiceDocListeners();

    const hold = getActiveVoiceHold();
    hold?.classList.add('is-recording');
    hold?.classList.remove('is-cancel');
    if (hold) hold.textContent = '正在接通麦克风…';
    showVoiceRecordTip(false);
    updateVoiceRecordSec(0);

    _voiceStream = takeWarmMicStream() || await getUserMediaAudio();

    // 权限等待期间已松手 → 不进入录音
    if (_voiceReleasedWhileStarting) {
      stopVoiceStream();
      resetVoiceRecordingState();
      window.showToast?.('说话时间太短');
      return;
    }

    const mime = pickVoiceMimeType();
    _voiceChunks = [];
    const recOpts = mime
      ? { mimeType: mime, audioBitsPerSecond: 128000 }
      : { audioBitsPerSecond: 128000 };
    try {
      _voiceRec = new MediaRecorder(_voiceStream, recOpts);
    } catch {
      _voiceRec = mime
        ? new MediaRecorder(_voiceStream, { mimeType: mime })
        : new MediaRecorder(_voiceStream);
    }
    _voiceRec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) _voiceChunks.push(ev.data);
    };
    _voiceRec.onerror = (ev) => {
      console.warn('[voice] MediaRecorder error', ev?.error || ev);
    };
    try {
      _voiceRec.start(200);
    } catch {
      // 部分浏览器不支持 timeslice
      _voiceRec.start();
    }
    _voiceStartedAt = Date.now();
    _voiceStarting = false;
    if (hold) hold.textContent = '松开发送';
    _voiceTickTimer = setInterval(() => {
      updateVoiceRecordSec((Date.now() - _voiceStartedAt) / 1000);
    }, 200);
    _voiceMaxTimer = setTimeout(() => {
      window.showToast?.('已达 60 秒上限');
      finishVoiceRecording({ cancel: false, force: true });
    }, 60000);
    try { e?.currentTarget?.setPointerCapture?.(_voicePointerId); } catch {}
    try { hold?.setPointerCapture?.(_voicePointerId); } catch {}

    // start 完成后才发现已松手（极短按）：立刻收尾，避免空录到 60 秒
    if (_voiceReleasedWhileStarting) {
      finishVoiceRecording({ cancel: _voiceCancel, force: false });
    }
  } catch (err) {
    resetVoiceRecordingState();
    await toastMicFailure(err);
  }
}

async function probeAudioBlobDuration(blob) {
  if (!blob || blob.size < 100) return 0;
  try {
    const url = URL.createObjectURL(blob);
    const dur = await new Promise((resolve) => {
      const audio = new Audio();
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try { URL.revokeObjectURL(url); } catch {}
        resolve(v);
      };
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const d = Number(audio.duration);
        finish(Number.isFinite(d) && d > 0 ? d : 0);
      };
      audio.onerror = () => finish(0);
      setTimeout(() => finish(0), 2500);
      audio.src = url;
    });
    return dur;
  } catch {
    return 0;
  }
}

async function finishVoiceRecording({ cancel = false, force = false } = {}) {
  if (_voiceStarting) {
    // 权限未完成就松手：标记，等 begin 在 start 前后清掉
    _voiceReleasedWhileStarting = true;
    if (cancel) _voiceCancel = true;
    return;
  }
  if (!_voiceRec) return;
  const rec = _voiceRec;
  const startedAt = _voiceStartedAt;
  const mimeType = rec.mimeType || pickVoiceMimeType() || 'audio/webm';
  if (_voiceMaxTimer) { clearTimeout(_voiceMaxTimer); _voiceMaxTimer = null; }
  if (_voiceTickTimer) { clearInterval(_voiceTickTimer); _voiceTickTimer = null; }
  _voiceRec = null;

  const blob = await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(new Blob(_voiceChunks, { type: mimeType }));
    };
    rec.onstop = done;
    try {
      if (typeof rec.requestData === 'function' && rec.state === 'recording') {
        try { rec.requestData(); } catch {}
      }
      if (rec.state !== 'inactive') rec.stop();
      else done();
    } catch {
      done();
    }
    setTimeout(done, 1500);
  });
  stopVoiceStream();
  hideVoiceRecordTip();
  resetVoiceHoldButton(getActiveVoiceHold());
  if (_chatVoiceMode) warmUpMicrophone();
  const chunksEmpty = !_voiceChunks.length;
  _voiceChunks = [];
  _voicePointerId = null;

  if (cancel || _voiceCancel) {
    _voiceCancel = false;
    window.showToast?.('已取消');
    return;
  }

  const wallSec = Math.max(0, (Date.now() - startedAt) / 1000);
  const metaSec = await probeAudioBlobDuration(blob);
  const durationSec = Math.max(1, Math.round(metaSec > 0.4 ? metaSec : wallSec) || 1);

  if (!force && (wallSec < 0.45 || blob.size < 400 || chunksEmpty)) {
    window.showToast?.('说话时间太短');
    return;
  }
  if (!force && blob.size < 200) {
    window.showToast?.('没有录到声音，请检查麦克风');
    return;
  }

  _voiceSending = true;
  try {
    const ext = /mp4|m4a/i.test(mimeType) ? 'm4a' : (/ogg/i.test(mimeType) ? 'ogg' : 'webm');
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mimeType || 'audio/webm' });
    const uploaded = await api.uploadChatVoice(file, durationSec);
    if (!uploaded?.url) throw new Error('上传未返回地址');
    const content = encodeUserVoiceContent({
      url: uploaded.url,
      duration: uploaded.duration || durationSec,
      voiceprint: uploaded.voiceprint || null,
    });
    const fromGroup = _activeVoiceHoldId === 'group-hold-talk'
      || (window._groupChatVoiceTarget && document.getElementById('group-chat-page')?.classList?.contains('active'));
    if (fromGroup && window._groupChatVoiceTarget && window.sendGroupVoiceMessage) {
      await window.sendGroupVoiceMessage(content, { duration: uploaded.duration || durationSec });
      const vpResultG = uploaded.voiceprint?.result;
      const vpHintG = vpResultG === 'match' ? '声纹：听着是你'
        : vpResultG === 'mismatch' ? '声纹：不像本人'
          : vpResultG === 'uncertain' ? '声纹：不够确定'
            : vpResultG === 'music' ? '声纹：像歌曲，不当你'
              : vpResultG === 'noise' ? '声纹：像环境声'
                : '';
      if (vpHintG) window.showToast?.(vpHintG);
      return;
    }
    const targetId = _activeVoiceHoldId === 'call-hold-talk' ? callCharId : charId;
    const fromCall = _activeVoiceHoldId === 'call-hold-talk';
    // 聊天页语音：先入库攒着（同表情包），点 ↑ 再统一让角色回；通话里仍即时回复
    await doSend(content, 'voice', { duration: uploaded.duration || durationSec }, !fromCall, targetId);
    const vpResult = uploaded.voiceprint?.result;
    const vpHint = vpResult === 'match' ? '声纹：听着是你'
      : vpResult === 'mismatch' ? '声纹：不像本人'
        : vpResult === 'uncertain' ? '声纹：不够确定'
          : vpResult === 'music' ? '声纹：像歌曲，不当你'
            : vpResult === 'noise' ? '声纹：像环境声'
              : '';
    if (!fromCall && _pendingAiCount > 0) {
      window.showToast?.(vpHint ? `${vpHint}。点 ↑ 让对方回复` : '语音已发送，点 ↑ 让对方回复');
    } else if (vpHint) {
      window.showToast?.(vpHint);
    }
  } catch (err) {
    window.showToast?.('语音发送失败: ' + (err?.message || '网络错误'));
  } finally {
    _voiceSending = false;
  }
}

function onVoiceHoldPointerDown(e) {
  if (e.button != null && e.button !== 0) return;
  beginVoiceRecording(e);
}

function ensureVoiceHoldBound(holdId = 'chat-hold-talk') {
  if (_voiceHoldBoundIds.has(holdId)) return;
  const hold = document.getElementById(holdId);
  if (!hold) return;
  hold.addEventListener('pointerdown', onVoiceHoldPointerDown);
  // move/up/cancel 改由 document 统一处理，避免滑出按钮丢事件
  hold.addEventListener('contextmenu', (e) => e.preventDefault());
  hold.addEventListener('dragstart', (e) => e.preventDefault());
  _voiceHoldBoundIds.add(holdId);
  bindVoiceDocListeners();
}
window.ensureVoiceHoldBound = ensureVoiceHoldBound;

window.openCamera = function() {
  const el = document.getElementById('cam-input');
  if (!el) return;
  el.value = '';
  el.click();
};
window.openImagePicker = function() {
  const el = document.getElementById('img-input');
  if (!el) return;
  // 先清空，避免取消后再选同一张截图不触发 change
  el.value = '';
  el.click();
};

window.handleImageFile = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  // 立刻清空，避免裁剪卡住时再点上传没反应
  e.target.value = '';
  try {
    const isVideo = file.type.startsWith('video/');
    let result;
    if (isVideo) {
      result = await pickCropAndUpload(file, {
        title: '裁剪视频',
        aspect: window.innerWidth / window.innerHeight,
      });
    } else {
      result = await api.uploadFile(file);
    }
    if (!result?.url) return;
    if (!isVideo && (await onGameButlerImageUpload?.(result.url))) {
      setChatToolbarOpen(false);
      return;
    }
    await doSend(result.url, isVideo ? 'video' : 'image', {}, true);
    setChatToolbarOpen(false);
  } catch(err) { window.showToast?.('上传失败'); }
};

/**
 * 系统分享 → 链接卡载荷：去掉裸链，拆成标题|文案（角色可读，界面也是卡片）。
 * 几乎只有网址时返回 null。
 */
function prepareShareCardForChat(raw, subject = '') {
  let text = String(raw || '').trim();
  if (!text) return null;
  
  // 提取链接（特别是小红书链接）
  const urlMatches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const xhsLinks = urlMatches.filter(u => /xhslink\.com|xiaohongshu\.com/i.test(u));
  const linkUrl = xhsLinks[0] || urlMatches[0] || '';
  
  let bodyText = text
    .replace(/https?:\/\/[^\s<>"']+/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  bodyText = bodyText
    .replace(/^(?:来自|分享自|via|from)\s+[^\n]+$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (bodyText.length < 2) return null;

  const subj = String(subject || '').trim().replace(/\s+/g, ' ').slice(0, 48);
  let title = '';
  let body = '';
  if (subj && !bodyText.includes(subj)) {
    title = subj;
    body = bodyText.slice(0, 400);
  } else {
    const lines = bodyText.split(/\n/).map((x) => x.trim()).filter(Boolean);
    if (lines.length >= 2) {
      title = lines[0].replace(/\s+/g, ' ').slice(0, 48);
      body = lines.slice(1).join('\n').slice(0, 400);
    } else {
      const one = lines[0] || bodyText;
      if (one.length <= 28) {
        title = one;
        body = '';
      } else {
        const head = one.slice(0, 28);
        const m = head.match(/^(.{8,24}?)[，。！？、；：:\s]/);
        title = (m ? m[1] : one.slice(0, 20)).trim() || '分享';
        body = one.startsWith(title)
          ? one.slice(title.length).replace(/^[，。！？、；：:\s]+/, '').trim()
          : one;
        if (!body) body = one;
        body = body.slice(0, 400);
      }
    }
  }
  if (!title) title = body ? body.slice(0, 24) : '分享';
  
  // 附加链接到内容中
  let content = body ? `${title}|${body}` : title;
  if (linkUrl) {
    content = `${content}\n链接: ${linkUrl}`;
  }
  
  return { title, body, content, url: linkUrl };
}

function fillChatInputDraft(draft) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const cur = String(input.value || '').trim();
  input.value = cur ? `${cur}\n${draft}` : draft;
  autoResize?.(input);
  try { input.focus(); } catch {}
}

/** 系统分享到念：做成链接卡入库（不触发回复），等用户点 ↑ 后再让角色回 */
window.sendShareToChat = async function({ text = '', files = [], subject = '' } = {}) {
  if (!charId) {
    window.showToast?.('请先选择聊天对象');
    return false;
  }
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const rawBody = String(text || '').trim();
  const card = prepareShareCardForChat(rawBody, subject);
  if (!card && !list.length && !rawBody) {
    window.showToast?.('没有可分享的内容');
    return false;
  }
  try {
    for (const file of list) {
      const uploaded = await api.uploadFile(file);
      if (!uploaded?.url) continue;
      await doSend(uploaded.url, 'image', {}, true);
    }
    if (card?.content) {
      await doSend(card.content, 'link', {}, true);
    } else if (rawBody && !list.length) {
      fillChatInputDraft(rawBody);
      window.showToast?.('分享里主要是链接，对方打不开。改成你想说的内容后点 ↑');
      return true;
    }
    if (_pendingAiCount > 0) {
      window.showToast?.('已分享到聊天，点 ↑ 让对方回复');
    }
    return true;
  } catch (e) {
    window.showToast?.('分享发送失败：' + (e.message || '未知错误'));
    return false;
  }
};

window.sendLocation = async function() {
  if (!charId) { window.showToast?.('请先选择聊天对象'); return; }
  window.showToast?.('正在获取实时位置…');
  let lat;
  let lng;
  try {
    // 实时定位：不用缓存点，也不要用名片里的「家定位」
    const coords = await getDeviceCoordinates({ fresh: true });
    lat = coords.latitude;
    lng = coords.longitude;
  } catch (e) {
    window.showToast?.(formatLocationError(e));
    return;
  }
  try {
    let placeName = '';
    let title = '';
    try {
      // live：反查地名时不要把坐标改写成「家|已存住址」
      const data = await api.reverseGeocode(lat, lng, { live: true });
      placeName = (data.placeName || '').trim();
      title = (data.title || '').trim();
      // 统一成「短标题|详细地址」，卡片主副标题分开显示
      if (!placeName.includes('|') && data.title && data.detail) {
        placeName = `${data.title}|${data.detail}`;
      }
    } catch {}
    if (!placeName || placeName === '未知位置') {
      placeName = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      title = placeName;
    }
    placeName = applyCityAliasToText(placeName, currentChar);
    title = applyCityAliasToText(title, currentChar);
    const locLabel = title || placeName.split(/[|｜]/)[0].trim() || placeName;
    setChatToolbarOpen(false);
    // content / location 都带「标题|详情」，卡片才能显示副标题；经纬度留给地图预览和点开
    await doSend(placeName, 'location', { location: placeName, lat, lng }, true);
    if (_pendingAiCount > 0) {
      window.showToast?.(`实时位置已发送（${locLabel}），点 ↑ 让对方回复`);
    }
  } catch (e) {
    window.showToast?.('发送失败：' + (e.message || '未知错误'));
  }
};

function armRobotListeningAsideTimer() {
  if (window._robotListenAsideTimer) clearTimeout(window._robotListenAsideTimer);
  window._robotListenAsideTimer = setTimeout(() => {
    document.querySelectorAll('.robot-aside-listening').forEach((el) => {
      el.classList.add('robot-aside-listening-done');
    });
    window._robotListenAsideTimer = null;
  }, 35000);
}

/** 小机那边发生的事（角色开摄像头等）：当场追加一条旁白，不进未读 */
window.onRobotChatEvent = function(data) {
  const kind = data?.event || data?.type;
  if (kind === 'mood_face' || kind === 'touch_face') {
    window.applyRobotFacePreview?.(data);
    return;
  }
  const sameChar = data?.characterId == null || shouldRenderForChar(Number(data.characterId));
  // 麦克风上行完成 / 没说话收尾：去掉讲话中动效即可，音频本身不显示
  if (kind === 'mic_utterance' || kind === 'mic_listen_end') {
    if (!sameChar) return;
    document.querySelectorAll('.robot-aside-listening').forEach((el) => {
      el.classList.add('robot-aside-listening-done');
    });
    if (window._robotListenAsideTimer) {
      clearTimeout(window._robotListenAsideTimer);
      window._robotListenAsideTimer = null;
    }
    return;
  }
  if (!shouldRenderForChar(Number(data?.characterId))) return;
  const msg = data.message;
  if (!msg?.content) return;
  const list = document.getElementById('messages-list');
  if (!list) return;
  const meta = typeof msg.media_meta === 'string'
    ? (() => { try { return JSON.parse(msg.media_meta || '{}'); } catch { return {}; } })()
    : (msg.media_meta || {});
  const isListeningAside = kind === 'mic_listening' || meta.robotEvent === 'listening';
  if (isListeningAside) {
    const already = list.querySelector('.robot-aside-listening:not(.robot-aside-listening-done)');
    if (already) {
      armRobotListeningAsideTimer();
      return;
    }
  }
  const html = buildBubble({ ...msg, dbId: msg.id }, currentChar, {});
  if (!html) return;
  list.insertAdjacentHTML('beforeend', html);
  scrollBottom(true);
  if (isListeningAside) armRobotListeningAsideTimer();
};

window.appendPokeHint = function(text) {
  if (!text) return;
  const list = document.getElementById('messages-list');
  if (!list) return;
  list.insertAdjacentHTML('beforeend', `<div class="bubble-time poke-hint">${escapeHtml(text)}</div>`);
  scrollBottom(true);
};

let _emojiCatsCache = null;
let _emojiFetchPromise = null;
/** 聊天表情面板：0 = 小黄豆；其后才是表情包分类 */
let _emojiPanelMode = 'bean'; // 'bean' | 'sticker'
let _emojiStickerIdx = 0;

function filterEmojiCatsWithItems(cats) {
  return (cats || []).map(c => ({
    ...c,
    emojis: (c.emojis || []).filter(e => !e.missing),
  })).filter(c => (c.emojis || []).length > 0);
}

function isDreamChatContext() {
  // 以聊天页本地状态为准（chat.js 的 getIsDream 未必同步）
  try {
    if (typeof isDream !== 'undefined' && isDream) return true;
  } catch { /* ignore */ }
  try {
    if (document.getElementById('dream-page')?.classList?.contains('active')) return true;
  } catch { /* ignore */ }
  return false;
}

function setEmojiPickerBeanMode(on) {
  const content = document.getElementById('emoji-picker-content');
  if (!content) return;
  content.classList.toggle('is-bean-panel', !!on);
}

function renderEmojiPickerFromCache() {
  const tabs = document.getElementById('emoji-panel-tabs');
  const content = document.getElementById('emoji-picker-content');
  if (!content) return;
  const dream = isDreamChatContext();
  const filtered = filterEmojiCatsWithItems(_emojiCatsCache);

  if (dream) {
    // 梦境：只用表情包贴纸，不提供系统小黄豆
    _emojiPanelMode = 'sticker';
    setEmojiPickerBeanMode(false);
    if (!filtered.length) {
      if (tabs) tabs.innerHTML = '';
      content.innerHTML = '<div class="emoji-panel-empty">还没有表情包<br>去「总设置→表情包」上传并填写描述</div>';
      return;
    }
    if (tabs) {
      tabs.innerHTML = filtered.map((cat, i) =>
        `<div class="emoji-panel-tab${i === _emojiStickerIdx ? ' active' : ''}" onclick="switchEmojiTab(${i})">${escapeHtml(cat.name)}</div>`
      ).join('');
    }
    renderEmojiCatContent(filtered[_emojiStickerIdx] || filtered[0], content);
    return;
  }

  // 普通聊天：强制小黄豆优先
  if (_emojiPanelMode !== 'sticker') _emojiPanelMode = 'bean';
  const tabHtml = [
    `<div class="emoji-panel-tab${_emojiPanelMode === 'bean' ? ' active' : ''}" onclick="switchEmojiTab('bean')">小黄豆</div>`,
    ...filtered.map((cat, i) =>
      `<div class="emoji-panel-tab${_emojiPanelMode === 'sticker' && _emojiStickerIdx === i ? ' active' : ''}" onclick="switchEmojiTab(${i})">${escapeHtml(cat.name)}</div>`
    ),
  ].join('');
  if (tabs) tabs.innerHTML = tabHtml;

  if (_emojiPanelMode === 'bean') {
    setEmojiPickerBeanMode(true);
    const grid = buildInlineEmojiGridHtml({ onclick: 'insertChatBeanEmoji' });
    content.innerHTML = grid || '<div class="emoji-panel-empty">小黄豆加载失败，请刷新重试</div>';
  } else if (filtered.length) {
    setEmojiPickerBeanMode(false);
    renderEmojiCatContent(filtered[_emojiStickerIdx] || filtered[0], content);
  } else {
    _emojiPanelMode = 'bean';
    setEmojiPickerBeanMode(true);
    content.innerHTML = buildInlineEmojiGridHtml({ onclick: 'insertChatBeanEmoji' });
  }
}

async function refreshEmojiCatsInBackground() {
  if (_emojiFetchPromise) return _emojiFetchPromise;
  _emojiFetchPromise = api.getEmojiCategories()
    .then((cats) => {
      primeStickerLiveMap(cats);
      _emojiCatsCache = filterEmojiCatsWithItems(cats);
      const panel = document.getElementById('chat-emoji-panel');
      if (panel && panel.style.display !== 'none') renderEmojiPickerFromCache();
    })
    .catch(() => {})
    .finally(() => { _emojiFetchPromise = null; });
  return _emojiFetchPromise;
}

function parseJsonArray(val, fallback = []) {
  if (Array.isArray(val)) return val;
  if (val == null || val === '') return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

window.openEmojiPicker = async function() {
  const panel = document.getElementById('chat-emoji-panel');
  const content = document.getElementById('emoji-picker-content');
  if (!panel || !content) return;

  // 普通聊天先立刻画出小黄豆 tab，避免旧缓存/异步慢导致“只见表情包”
  if (!isDreamChatContext()) {
    _emojiPanelMode = 'bean';
    renderEmojiPickerFromCache();
  } else {
    content.innerHTML = '<div class="emoji-panel-loading"><div class="loading-spinner"></div></div>';
  }
  try {
    await ensureInlineEmojis();
    renderEmojiPickerFromCache();
    await refreshEmojiCatsInBackground();
    renderEmojiPickerFromCache();
  } catch (e) {
    console.warn('[emoji] open picker', e);
    if (!isDreamChatContext()) {
      _emojiPanelMode = 'bean';
      renderEmojiPickerFromCache();
    } else {
      content.innerHTML = '<div class="emoji-panel-empty">加载失败，请刷新重试</div>';
    }
  }
};

function renderEmojiCatContent(cat, container) {
  if (!cat?.emojis?.length) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:13px">该分类暂无表情</div>';
    return;
  }
  container.innerHTML = cat.emojis.map(em => {
    const raw = `/uploads/${em.filename || String(em.url || '').replace(/^.*\//, '').split('?')[0]}`;
    const src = window.resolveMediaUrl?.(em.url || raw) || raw;
    return `<img class="emoji-panel-item" src="${escapeHtml(src)}" alt="${escapeHtml(em.description)}" loading="lazy"
      onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src=this.src.split('?')[0]+'?_r='+Date.now()}"
      onclick="selectPendingEmoji('${escapeHtml(raw)}', '${escapeHtml(em.description || '')}')">`;
  }).join('');
}

window.switchEmojiTab = function(idx) {
  if (idx === 'bean') {
    _emojiPanelMode = 'bean';
    renderEmojiPickerFromCache();
    return;
  }
  const cats = _emojiCatsCache || [];
  _emojiPanelMode = 'sticker';
  _emojiStickerIdx = Number(idx) || 0;
  setEmojiPickerBeanMode(false);
  document.querySelectorAll('.emoji-panel-tab').forEach((t, i) => {
    // 梦境无小黄豆 tab：下标直接对应分类；普通聊天下标 0 是小黄豆
    const active = isDreamChatContext()
      ? i === _emojiStickerIdx
      : i === _emojiStickerIdx + 1;
    t.classList.toggle('active', active);
  });
  const content = document.getElementById('emoji-picker-content');
  if (content) renderEmojiCatContent(cats[_emojiStickerIdx], content);
};

/** 插入小黄豆到输入框（不立刻发送） */
window.insertChatBeanEmoji = function(code) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  insertInlineEmojiAtCursor(input, code);
  try { window.updatePendingCount?.(); } catch { /* ignore */ }
};

window.selectPendingEmoji = async function(url, description) {
  // 表情包贴纸：立即显示在聊天区并入库，但不触发角色回复；按 ↑ 统一回复
  await doSend(url, 'emoji', { emojiDescription: description || '' }, true);
};

window.sendEmojiMsg = window.selectPendingEmoji;

window.rerollMessage = async function() {
  if (!charId) return;
  if (_doSendBusy) {
    window.showToast?.('上一条还在发送中，请稍候');
    return;
  }
  const sendCharId = charId;
  _doSendBusy = true;
  let emptyNudge = false;
  try {
    const cleared = await clearAiRepliesAfterLastUser(sendCharId);
    if (!cleared.ok && cleared.reason === 'no_user') {
      window.showToast?.('没有用户消息');
      return;
    }
    if (!cleared.ok) {
      window.showToast?.('重新生成失败');
      return;
    }
    if (!cleared.cleared) {
      window.showToast?.('没有AI消息可重新生成');
      return;
    }

    scrollBottom(true);
    startWaitTypingPulse(sendCharId);

    const result = await triggerAiAndWaitTyping(sendCharId, isDream, 'retry');
    rememberAiReplyResult(result);

    if (result.content || result.aiMessages?.length || result.selfieImgUrl || result.generalImgUrl || result.generalVideoUrl) {
      if (replyLooksEmpty(result)) {
        stopWaitTypingPulse(true);
        emptyNudge = true;
      } else {
        _emptyAiNudgeCount = 0;
        const userTs = cleared.msgs[cleared.lastUserIdx].timestamp;
        await applyAiReplyResult(result, userTs, sendCharId);
      }
    } else if (shouldNudgeEmptyAiReply(result)) {
      stopWaitTypingPulse(true);
      emptyNudge = true;
    } else {
      stopWaitTypingPulse(true);
    }
  } catch (e) {
    stopWaitTypingPulse(true);
    showCharTypingFor(sendCharId, false);
    const recovered = await recoverSavedAiReply(sendCharId);
    if (!recovered) {
      if (isEmptyAiReplyError(e) && !isDream) {
        emptyNudge = true;
      } else {
        window.showToast?.('重新生成失败: ' + e.message);
      }
    }
  } finally {
    _doSendBusy = false;
  }
  if (emptyNudge) await maybeNudgeEmptyAiReply(sendCharId);
};

// ===== 骰子 Roll =====
window.rollDice = async function() {
  if (!charId) return;
  const sides = 6;
  const result = Math.floor(Math.random() * sides) + 1;
  const faces = ['', '⚀','⚁','⚂','⚃','⚄','⚅'];
  await doSend(`[掷骰子 ${faces[result]} 结果：${result}点]`, 'text');
};

// ===== 拍一拍 =====

window.pokeChat = async function() {
  if (!charId) return;
  if (isBusyBlocking()) {
    return window.pokeCharacter?.();
  }
  const page = document.getElementById('chat-page');
  page?.classList.add('shaking');
  setTimeout(() => page?.classList.remove('shaking'), 600);
  const settings = window.getAppSettings?.() || {};
  const name = settings.username || '旅人';
  const charName = currentChar?.name || 'TA';
  const list = document.getElementById('messages-list');

  // 先显示占位，入库后再换成正式文案（写入历史，模型才能看见）
  const tmpDiv = document.createElement('div');
  tmpDiv.className = 'bubble-time poke-hint';
  tmpDiv.textContent = `${name} 拍了拍 ${charName}`;
  list.appendChild(tmpDiv);
  scrollBottom(true);

  let pokeText = tmpDiv.textContent;
  try {
    const result = await api.userPoke(charId);
    pokeText = result.text || pokeText;
    tmpDiv.textContent = pokeText;
    if (result.message?.id != null) tmpDiv.dataset.id = String(result.message.id);
    scrollBottom(false);
  } catch (e) {
    window.showToast?.(e.message || '拍一拍失败');
    return;
  }

  // 触发角色回应：明确告知这是拍一拍，不是省略号/空白
  try {
    const pokeHint = '用户刚刚拍了拍你（见对话里的「拍一拍提示」系统行）。这不是省略号、不是空白消息。请像真人被拍一下那样自然短回；若想回拍可单独写一行 [拍一拍]。禁止说「你发了一串省略号」或「没看懂你发什么」。';
    if (_doSendBusy) {
      window.showToast?.('上一条还在发送中，请稍候');
      return;
    }
    await _saveQueue;
    clearPendingUserMsgs();
    _pendingAiCount = 0;
    updatePendingBadge();
    const sendCharId = charId;
    _doSendBusy = true;
    scrollBottom(true);
    startWaitTypingPulse(sendCharId);
    try {
      const result = await triggerAiAndWaitTyping(
        sendCharId, isDream, 'retry', false, null,
        isInVoiceCallWith(sendCharId), false, getGameTopicContextForAi(), pokeHint,
        null, callTriggerExtra(),
      );
      rememberAiReplyResult(result);
      if (hasAiReplyPayload(result)) {
        await applyAiReplyResult(result, new Date().toISOString(), sendCharId);
      }
    } catch (e2) {
      stopWaitTypingPulse(true);
      showCharTypingFor(sendCharId, false);
      const recovered = await recoverSavedAiReply(sendCharId);
      if (!recovered) {
        try { await syncNewMessages(); } catch {}
        const msg = String(e2?.message || '');
        if (/超时|aborted|abort/i.test(msg)) {
          window.showToast?.('角色回复超时：已尝试刷新；没有气泡再空按发送');
        } else {
          window.showToast?.('触发失败: ' + msg);
        }
      }
    } finally {
      _doSendBusy = false;
    }
  } catch (e) { /* 拍一拍回应失败时静默处理 */ }
};

async function triggerCatchUpReply() {
  if (_doSendBusy) return;
  const sendCharId = charId;
  _doSendBusy = true;
  scrollBottom(true);
  startWaitTypingPulse(sendCharId);
  try {
    const result = await triggerAiAndWaitTyping(sendCharId, isDream, 'retry', false, null, false, true);
    rememberAiReplyResult(result);
    if (hasAiReplyPayload(result)) {
      await applyAiReplyResult(result, new Date().toISOString(), sendCharId);
    }
  } catch (e) {
    stopWaitTypingPulse(true);
    showCharTypingFor(sendCharId, false);
  } finally {
    _doSendBusy = false;
  }
}

window.pokeCharacter = async function() {
  if (!charId) return;
  try {
    const result = await api.pokeCharacter(charId);
    if (result.came_back) {
      updateCharStatus('online');
      syncBusyBar();
      window.showToast?.(`${currentChar?.name} 回来了！`);
      if (result.pending_count > 0) {
        await triggerCatchUpReply();
      }
    } else {
      window.showToast?.(result.hint || 'TA说还要再等等…');
    }
  } catch {}
};

// ===== 消息操作 =====
/** 把某条消息在页面上更新成"已撤回"外观（手动撤回按钮 / AI 自己撤回都走这里）
 *  仿微信：把原来的气泡整体替换成一行居中的灰色系统提示，点这行文字本身即可查看原文
 *  （查看逻辑见 index.html 里的全局 showRecalledMsg，会弹出「撤回的消息」弹窗）。 */
function applyRecalledUiForMsg(msgId, recalledContent) {
  const el = document.querySelector(`[data-id="${msgId}"], [data-msg-id="${msgId}"]`);
  if (!el) return false;
  if (el.classList.contains('recall-hint')) {
    if (recalledContent) el.dataset.recalledContent = recalledContent;
    return true;
  }
  // 如果这条消息有语音条正在播放，停止 TTS（含通话中的朗读）
  if (el.querySelector('.voice-bubble.is-playing')) {
    stopTTS();
  }
  const role = el.dataset.role || 'assistant';
  const idAttr = el.dataset.id || String(msgId);
  const dbIdAttr = el.dataset.msgId || idAttr;
  const hint = document.createElement('div');
  hint.className = 'bubble-time recall-hint';
  hint.dataset.id = idAttr;
  hint.dataset.msgId = dbIdAttr;
  hint.dataset.role = role;
  hint.textContent = role === 'user' ? '你撤回了一条消息' : '对方撤回了一条消息';
  hint.setAttribute('onclick', `window.showRecalledMsg?.('${idAttr}')`);
  if (recalledContent) hint.dataset.recalledContent = recalledContent;
  (el.closest('.bubble-swipe-row') || el).replaceWith(hint);
  return true;
}
window.applyRecalledUiForMsg = applyRecalledUiForMsg;

window.recallMsg = async function(msgId) {
  if (!msgId || String(msgId).startsWith('tmp')) return;
  try {
    const result = await api.recallMessage(msgId);
    applyRecalledUiForMsg(msgId);
    if (result?.shouldReact && !isDream && !isBusyBlocking()) {
      triggerRecallReact();
    }
  } catch(e) { window.showToast?.('撤回失败'); }
};

async function triggerRecallReact() {
  if (_doSendBusy) return;
  const sendCharId = charId;
  if (!sendCharId) return;
  _doSendBusy = true;
  try {
    startWaitTypingPulse(sendCharId);
    const hint = '对方刚刚撤回了一条消息（见对话里的撤回系统提示）。这不是空白。按人设短回一句：看见原文就按看见的接，没看见就只对「收回去了」本身反应。不要复述整段原文，不要说自己是 AI。';
    const result = await triggerAiAndWaitTyping(
      sendCharId, isDream, 'continue', false, null,
      isInVoiceCallWith(sendCharId), false, getGameTopicContextForAi(), hint,
      null, callTriggerExtra(),
    );
    rememberAiReplyResult(result);
    if (hasAiReplyPayload(result)) {
      await applyAiReplyResult(result, new Date().toISOString(), sendCharId);
    }
  } catch {
    stopWaitTypingPulse(true);
    showCharTypingFor(sendCharId, false);
  } finally {
    _doSendBusy = false;
  }
}

window.deleteMsg = async function(msgId, opts = {}) {
  if (!msgId || String(msgId).startsWith('tmp')) return;
  if (opts.confirm !== false && !confirm('确定删除这条消息？')) return;
  try {
    await api.deleteMessagesBatch([String(msgId)]);
    removeBubblesFromDom([String(msgId)]);
    if (/^\d+$/.test(String(msgId))) removeThreadMessages(charId, isDream, [msgId]);
  } catch {}
};

function syncVoiceTranscriptPadding(voiceMsg, box) {
  if (!voiceMsg || !box) return;
  const wrap = voiceMsg.closest('.bubble-wrap');
  const extra = box.classList.contains('is-open') ? box.offsetHeight + 1 : 0;
  if (wrap) wrap.style.marginBottom = extra ? `${extra}px` : '';
  voiceMsg.style.paddingBottom = '';
}

/** 点击语音条本体：只展开/收起转文字，不播放 */
window.toggleVoiceTranscript = function(el) {
  if (!el) return;
  const bubbleEl = el.classList.contains('voice-bubble') ? el : el.closest('.voice-bubble');
  if (!bubbleEl) return;
  const wrap = bubbleEl.closest('.bubble-wrap');
  const voiceMsg = bubbleEl.closest('.voice-message');
  const transcriptBox = voiceMsg?.querySelector('.voice-transcript-box');
  if (!transcriptBox) return;

  const open = !transcriptBox.classList.contains('is-open');
  transcriptBox.classList.toggle('is-open', open);
  syncVoiceTranscriptPadding(voiceMsg, transcriptBox);
  const msgId = wrap?.dataset?.id || '';
  if (msgId) setVoiceTranscriptOpen(msgId, open);
};

/** 点击播放三角：朗读 / 停止，不联动转文字 */
window.playVoiceMsg = async function(el) {
  if (!el) return;
  const bubbleEl = el.classList.contains('voice-bubble') ? el : el.closest('.voice-bubble');
  if (!bubbleEl) return;

  // 正在播放此气泡时，点击 = 停止
  if (bubbleEl.classList.contains('is-playing')) {
    stopTTS();
    bubbleEl.classList.remove('is-playing');
    return;
  }

  const wrap = bubbleEl.closest('.bubble-wrap');
  const voiceSrc = (bubbleEl.dataset.voiceSrc || '').trim();
  const text = (bubbleEl.dataset.voiceText || bubbleEl.querySelector('.voice-text-src')?.textContent || '').trim();
  if (!voiceSrc && !text) return;

  const msgId = wrap?.dataset?.id || '';

  const setPlaying = (on) => {
    document.querySelectorAll('.voice-bubble.is-playing').forEach(b => {
      if (b !== bubbleEl) b.classList.remove('is-playing');
    });
    bubbleEl.classList.toggle('is-playing', on);
  };

  if (voiceSrc) {
    const played = await playVoiceClipUrl(voiceSrc, {
      onStart: () => setPlaying(true),
      onEnd: () => setPlaying(false),
    });
    if (!played) {
      setPlaying(false);
      window.showToast?.('语音播放失败: ' + (getLastTtsError() || '无法播放该文件'));
    }
    return;
  }

  if (!charHasVoiceId(currentChar) && !(bubbleEl.dataset.voiceId || '').trim()) {
    window.showToast?.('请先在角色中填写 MiniMax 声音 ID');
    return;
  }

  const ttsEmotion = (bubbleEl.dataset.ttsEmotion || '').trim();
  const ttsTone = (bubbleEl.dataset.ttsTone || '').trim();

  const played = await playVoiceAudio(text, msgId, {
    onStart: () => setPlaying(true),
    onEnd: () => setPlaying(false),
    characterId: charId,
    emotion: ttsEmotion || undefined,
    tone: ttsTone || undefined,
  });

  if (!played) {
    setPlaying(false);
    window.showToast?.('语音播放失败: ' + (getLastTtsError() || '请检查 MiniMax API Key、Group ID 与声音 ID'));
  }
};

// ===== 键盘处理 =====
window.handleChatKey = async function(e) {
  // 输入法候选中按回车是在选字/确认拼音，不是要发送
  if (e.isComposing || e.keyCode === 229 || _chatComposing) return;
  if (!isChatPageDomActive()) {
    clearSpuriousChatInput();
    return;
  }
  const settings = getChatSettings(charId);
  if (settings.enterSend && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input?.value.trim();
    if (!text) {
      if (_pendingAiCount > 0) await window.sendChatMessage();
      return;
    }
    // 切页/切后台防护窗内拦截孤立标点；平时可故意只发「。」「！」
    if (shouldBlockImeSpuriousSend(text, input)) {
      input.value = '';
      autoResize?.(input);
      return;
    }
    markExplicitChatSend();
    input.value = '';
    autoResize?.(input);
    // 回车只入库，不触发 AI；等主动消息或手动点发送
    await doSend(text, 'text', {}, true);
  }
};

// ===== 手动总结当前对话 =====
let _summarizeChatBusy = false;

window.summarizeCurrentChat = async function() {
  setChatToolbarOpen(false);
  window.closeEmojiPanel?.();
  if (!charId || isDream) {
    window.showToast?.(isDream ? '梦境中不可用' : '请先选择角色');
    return;
  }
  if (_summarizeChatBusy) return;
  const summaryOn = currentChar?.memory_summary_enabled !== 0 && currentChar?.memory_summary_enabled !== '0';
  if (!summaryOn) {
    window.showToast?.('请先在角色设置中开启「自动总结对话记忆」');
    return;
  }
  _summarizeChatBusy = true;
  const settings = window.getAppSettings?.() || {};
  const rounds = Math.max(1, Math.min(50, parseInt(settings.memory_manual_rounds || '10', 10) || 10));
  window.showToast?.(`正在总结最近 ${rounds} 轮对话…`);
  try {
    const result = await api.summarizeChatMemory(charId, rounds);
    window.showToast?.(result.message || '总结完成');
  } catch (e) {
    window.showToast?.(e.message || '总结失败');
  } finally {
    _summarizeChatBusy = false;
  }
};

// ===== 通讯内设置 =====
// 临时存放未保存的设置更改
let _pendingChatSettings = {};

window.openChatSettings = async function() {
  const overlay = document.getElementById('chat-settings-overlay');
  overlay.style.display = 'flex';
  const s = getChatSettings(charId);
  _pendingChatSettings = { ...s };

  // 恢复各组 tag-list（按 data-key 分组，避免跨组干扰）
  const tagGroups = ['timestampStyle', 'timestampPosition', 'readTagColor', 'bubbleTextColor', 'bgType'];
  const defaults = {
    timestampStyle: 'relative',
    timestampPosition: 'divider',
    readTagColor: 'black',
    bubbleTextColor: 'black',
    bgType: 'gradient',
  };
  tagGroups.forEach(key => {
    const val = s[key] || defaults[key];
    const group = document.getElementById(`cs-${key}`);
    if (!group) return;
    group.querySelectorAll('.tag').forEach(t => {
      t.classList.toggle('active', t.dataset.val === val);
    });
  });

  const lookVal = String(s.videoCallLook || 'auto') === 'off' ? 'off' : 'auto';
  const lookGroup = document.getElementById('cs-videoCallLook');
  if (lookGroup) {
    lookGroup.querySelectorAll('.tag').forEach(t => t.classList.toggle('active', t.dataset.val === lookVal));
  }
  const lookSecEl = document.getElementById('cs-videoCallLookSec');
  if (lookSecEl) lookSecEl.value = getVideoCallLookSecFromSettings(s);
  const lookSecRow = document.getElementById('cs-video-look-sec-row');
  if (lookSecRow) lookSecRow.style.display = lookVal === 'off' ? 'none' : 'flex';

  // 气泡字号（px 滑块）
  const pxEl = document.getElementById('cs-bubbleFontSizePx');
  const pxValEl = document.getElementById('cs-bubbleFontSizePx-val');
  const fontPx = resolveBubbleFontSizePx(s);
  if (pxEl) pxEl.value = fontPx;
  if (pxValEl) pxValEl.textContent = `${fontPx}px`;
  _pendingChatSettings.bubbleFontSizePx = fontPx;

  const sizeEl = document.getElementById('cs-bubbleSizePct');
  const sizeValEl = document.getElementById('cs-bubbleSizePct-val');
  const sizePct = Math.round(resolveBubbleSizeScale(s) * 100);
  if (sizeEl) sizeEl.value = sizePct;
  if (sizeValEl) sizeValEl.textContent = `${sizePct}%`;
  _pendingChatSettings.bubbleSizePct = sizePct;

  const gapEl = document.getElementById('cs-bubbleGapPx');
  const gapValEl = document.getElementById('cs-bubbleGapPx-val');
  const gapPx = resolveBubbleGapPx(s);
  if (gapEl) gapEl.value = gapPx;
  if (gapValEl) gapValEl.textContent = `${gapPx}px`;
  _pendingChatSettings.bubbleGapPx = gapPx;
  _pendingChatSettings.bubbleTextColor = resolveBubbleTextColor(s);

  // 气泡字体
  const fontId = isValidPaperFontId(s.bubbleFont) ? s.bubbleFont : 'sans';
  _pendingChatSettings.bubbleFont = fontId;
  fillBubbleFontTags(fontId);

  // 气泡颜色调色板（用户 / 角色分开配色）
  syncBubbleColorUI(s.userBubbleColor || '', 'user');
  syncBubbleColorUI(s.charBubbleColor || '', 'char');

  // 气泡风格
  const bsGroup = document.getElementById('cs-bubbleStyle');
  const bsVal = s.bubbleStyle || 'solid';
  if (bsGroup) {
    bsGroup.querySelectorAll('.tag').forEach(t => t.classList.toggle('active', t.dataset.val === bsVal));
    const intensityRow = document.getElementById('cs-bubble-intensity-row');
    if (intensityRow) intensityRow.style.display = bsVal !== 'solid' ? 'block' : 'none';
  }
  // 气泡形状（兼容旧值）
  const shapeGroup = document.getElementById('cs-bubbleShape');
  const shapeVal = normalizeBubbleShape(s.bubbleShape || 'default');
  _pendingChatSettings.bubbleShape = shapeVal;
  if (shapeGroup) shapeGroup.querySelectorAll('.tag').forEach(t => t.classList.toggle('active', t.dataset.val === shapeVal));
  const customCssRow = document.getElementById('cs-custom-bubble-css-row');
  const customCssEl = document.getElementById('cs-custom-bubble-css');
  if (customCssEl) customCssEl.value = s.customBubbleCss || '';
  _pendingChatSettings.customBubbleCss = s.customBubbleCss || '';
  if (customCssRow) customCssRow.style.display = shapeVal === 'custom' ? 'block' : 'none';
  const opEl = document.getElementById('cs-bubbleOpacity');
  if (opEl) opEl.value = s.bubbleOpacity ?? 65;
  const blurEl = document.getElementById('cs-bubbleBlur');
  if (blurEl) blurEl.value = s.bubbleBlur ?? 12;

  // 打开设置时用 pending 刷新一次预览
  applyBubbleStyle(_pendingChatSettings);

  // 头像
  const showUserAvEl = document.getElementById('cs-showUserAvatar');
  if (showUserAvEl) showUserAvEl.checked = s.showUserAvatar !== false;
  document.getElementById('cs-user-avatar-detail').style.display = s.showUserAvatar !== false ? 'block' : 'none';
  const userRadiusEl = document.getElementById('cs-userAvatarRadius');
  if (userRadiusEl) userRadiusEl.value = s.userAvatarRadius ?? 50;
  const showCharAvEl = document.getElementById('cs-showCharAvatar');
  if (showCharAvEl) showCharAvEl.checked = s.showCharAvatar !== false;
  document.getElementById('cs-char-avatar-detail').style.display = s.showCharAvatar !== false ? 'block' : 'none';
  const charRadiusEl = document.getElementById('cs-charAvatarRadius');
  if (charRadiusEl) charRadiusEl.value = s.charAvatarRadius ?? 50;

  const enterToggle = document.getElementById('enter-send-toggle');
  if (enterToggle) enterToggle.checked = !!s.enterSend;
  const locToggle = document.getElementById('show-location-toggle');
  if (locToggle) locToggle.checked = !!s.showLocation;
  const locBtn = document.getElementById('toolbar-location-btn');
  if (locBtn) locBtn.style.display = s.showLocation === false ? 'none' : '';

  // 背景预览
  updateBgRows(s.bgType || 'gradient', s.bgValue || '', s.bgColor || '#1a1a2e');

  // 当前角色行为（per-character）
  const charSection = document.getElementById('cs-char-section');
  if (charId && currentChar) {
    charSection.style.display = 'block';
    const char = currentChar;

    const remarkEl = document.getElementById('cs-remark');
    if (remarkEl) remarkEl.value = char.remark || '';

    // 时区（角色级；空则显示全局设置）
    const tzEl = document.getElementById('cs-timezone');
    if (tzEl) {
      const houseTz = window.getAppSettings?.()?.timezone || 'Asia/Shanghai';
      tzEl.value = char.timezone || houseTz;
    }

    const voiceIdEl = document.getElementById('cs-voice-id');
    if (voiceIdEl) voiceIdEl.value = char.voice_id || '';
    const voiceIdNsfwEl = document.getElementById('cs-voice-id-nsfw');
    if (voiceIdNsfwEl) voiceIdNsfwEl.value = char.voice_id_nsfw || '';
    const voiceMsgEl = document.getElementById('cs-voice-messages');
    if (voiceMsgEl) voiceMsgEl.checked = !!char.voice_messages;
    const musicScoreEl = document.getElementById('cs-music-score');
    if (musicScoreEl) musicScoreEl.checked = !!char.music_score_enabled;
    const moodEl = document.getElementById('cs-mood');
    if (moodEl) moodEl.value = char.mood || '';

    // 记忆总结
    const carryMem = document.getElementById('cs-carry-memory');
    if (carryMem) carryMem.checked = !(char.carry_memory === 0 || char.carry_memory === '0');
    const carryPortrait = document.getElementById('cs-carry-portrait');
    if (carryPortrait) carryPortrait.checked = char.carry_portrait === 1 || char.carry_portrait === '1' || char.carry_portrait === true;
    const memSummary = document.getElementById('cs-mem-summary');
    const summaryOn = char.memory_summary_enabled !== 0 && char.memory_summary_enabled !== '0';
    if (memSummary) memSummary.checked = summaryOn;
    const memTrigger = document.getElementById('cs-memory-trigger-n');
    if (memTrigger) memTrigger.value = char.memory_trigger_n ?? 12;
    const chatRounds = document.getElementById('cs-chat-rounds');
    if (chatRounds) chatRounds.value = char.chat_context_rounds ?? 18;
    const memKw = document.getElementById('cs-mem-keywords');
    if (memKw) memKw.value = char.memory_keywords || '';
    const flashChance = Number.isFinite(parseInt(char.memory_flash_chance, 10))
      ? Math.max(0, Math.min(100, parseInt(char.memory_flash_chance, 10)))
      : 20;
    const flashEl = document.getElementById('cs-mem-flash-chance');
    const flashVal = document.getElementById('cs-mem-flash-chance-val');
    if (flashEl) flashEl.value = flashChance;
    if (flashVal) flashVal.textContent = `${flashChance}%`;

    const naturalEl = document.getElementById('cs-natural-chat');
    if (naturalEl) naturalEl.checked = Number(char.natural_chat_mode) === 1;
    const timeAwareEl = document.getElementById('cs-time-aware');
    if (timeAwareEl) timeAwareEl.checked = !(char.time_aware_enabled === 0 || char.time_aware_enabled === '0');

    const proactiveMsgEl = document.getElementById('cs-proactive-msg');
    const proactiveOn = !!char.proactive_msg_enabled;
    if (proactiveMsgEl) proactiveMsgEl.checked = proactiveOn;

    const proactiveCallEl = document.getElementById('cs-proactive-call');
    const callOn = !!char.proactive_call_enabled;
    if (proactiveCallEl) proactiveCallEl.checked = callOn;

    // 当前角色上下文 token 数（约）
    const tokenEl = document.getElementById('cs-context-tokens');
    if (tokenEl) {
      tokenEl.textContent = '计算中…';
      api.getCharContextTokens(charId, isDream).then(r => {
        if (r?.tokens != null) tokenEl.textContent = `≈ ${r.tokens} tokens（${r.messageCount ?? 0} 条历史）`;
        else tokenEl.textContent = '获取失败';
      }).catch(() => { tokenEl.textContent = '获取失败'; });
    }

    // 忙碌自动回复
    const busyEl = document.getElementById('cs-busy-auto');
    if (busyEl) busyEl.checked = char.busy_style !== 'off';

    // 表情包开关
    const emojiEnabledEl = document.getElementById('cs-emoji-enabled');
    const emojiCatsRow = document.getElementById('cs-emoji-cats-row');
    const emojiOn = char.emoji_enabled !== 0 && char.emoji_enabled !== '0';
    if (emojiEnabledEl) emojiEnabledEl.checked = emojiOn;
    if (emojiCatsRow) emojiCatsRow.style.display = emojiOn ? 'block' : 'none';

    // 发表情包概率
    const freqRaw = parseInt(char.emoji_freq, 10);
    const emojiFreq = Number.isFinite(freqRaw) ? Math.max(0, Math.min(100, freqRaw)) : 30;
    const freqEl = document.getElementById('cs-emoji-freq');
    const freqValEl = document.getElementById('cs-emoji-freq-val');
    if (freqEl) freqEl.value = emojiFreq;
    if (freqValEl) freqValEl.textContent = `${emojiFreq}%`;

    // 表情包分类
    const catContainer = document.getElementById('cs-emoji-cats');
    if (catContainer) {
      try {
        const cats = await api.getEmojiCategories();
        const selected = parseJsonArray(char.emoji_categories);
        catContainer.innerHTML = cats.map(c => `
          <div class="tag ${selected.some(x => x == c.id) ? 'active' : ''}" data-ec-id="${c.id}"
            onclick="this.classList.toggle('active')">${c.name}</div>
        `).join('');
      } catch { catContainer.innerHTML = '<span style="font-size:12px;color:var(--text-secondary)">暂无分类</span>'; }
    }
  } else {
    if (charSection) charSection.style.display = 'none';
  }
};

function chatBgCssUrl(url) {
  return window.cssMediaUrl?.(url) || (url ? `url("${String(url).replace(/"/g, '\\"')}")` : '');
}

function updateBgRows(type, value, color) {
  const imgRow = document.getElementById('cs-bg-image-row');
  const colorRow = document.getElementById('cs-bg-color-row');
  if (imgRow) imgRow.style.display = type === 'image' ? 'flex' : 'none';
  if (colorRow) colorRow.style.display = type === 'color' ? 'flex' : 'none';
  const preview = document.getElementById('cs-bg-preview');
  if (preview) {
    if (type === 'image' && value) {
      preview.style.backgroundImage = chatBgCssUrl(value);
      preview.style.display = 'block';
    } else {
      preview.style.backgroundImage = '';
      preview.style.display = 'none';
    }
  }
  const colorPicker = document.getElementById('cs-bgColor');
  if (colorPicker && color) colorPicker.value = color;
}

// tag 点击（暂存，不立即写 localStorage）
// 给 HTML 中的 tag 用（统一走 pending 模式）
window.setChatSetting = window.setChatSettingPending;

window.saveChatSettingsUI = async function() {
  const s = _pendingChatSettings;
  // 读取滑块 / 开关
  const radius = document.getElementById('cs-avatarRadius');
  if (radius) s.avatarRadius = radius.value;
  const enterToggle = document.getElementById('enter-send-toggle');
  if (enterToggle) s.enterSend = enterToggle.checked;
  const locToggle = document.getElementById('show-location-toggle');
  if (locToggle) s.showLocation = locToggle.checked;
  const locBtn = document.getElementById('toolbar-location-btn');
  if (locBtn) locBtn.style.display = s.showLocation === false ? 'none' : '';
  const colorPicker = document.getElementById('cs-bgColor');
  if (colorPicker && s.bgType === 'color') s.bgColor = colorPicker.value;

  // 气泡颜色（空字符串 = 用户跟随主题 / 角色跟随默认中性色）
  if (Object.prototype.hasOwnProperty.call(s, 'userBubbleColor')) {
    s.userBubbleColor = String(s.userBubbleColor || '').trim();
  } else {
    const colorEl = document.getElementById('cs-userBubbleColor');
    if (colorEl) s.userBubbleColor = colorEl.value;
  }
  if (Object.prototype.hasOwnProperty.call(s, 'charBubbleColor')) {
    s.charBubbleColor = String(s.charBubbleColor || '').trim();
  }

  // 气泡风格
  const opEl = document.getElementById('cs-bubbleOpacity');
  if (opEl) s.bubbleOpacity = parseInt(opEl.value);
  const blurEl = document.getElementById('cs-bubbleBlur');
  if (blurEl) s.bubbleBlur = parseInt(blurEl.value);
  const fontPxEl = document.getElementById('cs-bubbleFontSizePx');
  if (fontPxEl) s.bubbleFontSizePx = parseInt(fontPxEl.value, 10);
  const sizePctEl = document.getElementById('cs-bubbleSizePct');
  if (sizePctEl) s.bubbleSizePct = parseInt(sizePctEl.value, 10);
  const gapPxEl = document.getElementById('cs-bubbleGapPx');
  if (gapPxEl) s.bubbleGapPx = parseInt(gapPxEl.value, 10);
  s.bubbleTextColor = resolveBubbleTextColor(s);
  if (s.bubbleShape) s.bubbleShape = normalizeBubbleShape(s.bubbleShape);
  const customCssSaveEl = document.getElementById('cs-custom-bubble-css');
  if (customCssSaveEl) s.customBubbleCss = customCssSaveEl.value;

  // 头像设置
  s.showUserAvatar = document.getElementById('cs-showUserAvatar')?.checked ?? true;
  s.userAvatarRadius = parseInt(document.getElementById('cs-userAvatarRadius')?.value ?? 50);
  s.showCharAvatar = document.getElementById('cs-showCharAvatar')?.checked ?? true;
  s.charAvatarRadius = parseInt(document.getElementById('cs-charAvatarRadius')?.value ?? 50);

  const lookSecSave = document.getElementById('cs-videoCallLookSec');
  if (lookSecSave) s.videoCallLookSec = getVideoCallLookSecFromSettings({ videoCallLookSec: lookSecSave.value });
  if (s.videoCallLook === 'off') s.videoCallLook = 'off';
  else s.videoCallLook = 'auto';

  saveChatSettings(s, charId);
  applyBgSettings();
  applyBubbleStyle(s);

  // 保存当前角色行为设置
  if (charId && currentChar) {
    try {
      const timezone = document.getElementById('cs-timezone')?.value || 'Asia/Shanghai';
      const voiceId = document.getElementById('cs-voice-id')?.value?.trim() || '';
      const voiceIdNsfw = document.getElementById('cs-voice-id-nsfw')?.value?.trim() || '';
      const voiceMessages = document.getElementById('cs-voice-messages')?.checked ? 1 : 0;
      const musicScoreEnabled = document.getElementById('cs-music-score')?.checked ? 1 : 0;
      const mood = document.getElementById('cs-mood')?.value?.trim() || '';
      const memorySummaryEnabled = document.getElementById('cs-mem-summary')?.checked ? 1 : 0;
      const carryMemory = document.getElementById('cs-carry-memory')?.checked ? 1 : 0;
      const carryPortrait = document.getElementById('cs-carry-portrait')?.checked ? 1 : 0;
      const memoryTriggerN = Math.max(5, Math.min(50, parseInt(document.getElementById('cs-memory-trigger-n')?.value ?? 12, 10) || 12));
      const chatRounds = parseInt(document.getElementById('cs-chat-rounds')?.value ?? 18);
      const memKeywords = document.getElementById('cs-mem-keywords')?.value?.trim() || '';
      const memoryFlashChance = Math.max(0, Math.min(100, parseInt(document.getElementById('cs-mem-flash-chance')?.value ?? 20, 10) || 0));
      const naturalChatMode = document.getElementById('cs-natural-chat')?.checked ? 1 : 0;
      const timeAwareEnabled = document.getElementById('cs-time-aware')?.checked ? 1 : 0;
      const proactiveMsgEnabled = document.getElementById('cs-proactive-msg')?.checked ? 1 : 0;
      const proactiveCallEnabled = document.getElementById('cs-proactive-call')?.checked ? 1 : 0;
      const busyAuto = document.getElementById('cs-busy-auto')?.checked ? 'on' : 'off';
      const emojiEnabled = document.getElementById('cs-emoji-enabled')?.checked ? 1 : 0;
      const emojiCats = Array.from(document.querySelectorAll('#cs-emoji-cats .tag.active')).map(t => parseInt(t.dataset.ecId));
      const emojiFreqRaw = parseInt(document.getElementById('cs-emoji-freq')?.value ?? 30, 10);
      const emojiFreq = Number.isFinite(emojiFreqRaw) ? Math.max(0, Math.min(100, emojiFreqRaw)) : 30;

      const charUpdate = {
        ...currentChar,
        timezone,
        voice_id: voiceId,
        voice_id_nsfw: voiceIdNsfw,
        voice_messages: voiceMessages,
        music_score_enabled: musicScoreEnabled,
        mood,
        carry_memory: carryMemory,
        carry_portrait: carryPortrait,
        memory_summary_enabled: memorySummaryEnabled,
        memory_trigger_n: memoryTriggerN,
        chat_context_rounds: chatRounds,
        memory_keywords: memKeywords,
        memory_flash_chance: memoryFlashChance,
        natural_chat_mode: naturalChatMode,
        time_aware_enabled: timeAwareEnabled,
        proactive_msg_enabled: proactiveMsgEnabled,
        proactive_call_enabled: proactiveCallEnabled,
        busy_style: busyAuto,
        emoji_enabled: emojiEnabled,
        emoji_freq: emojiFreq,
        emoji_categories: emojiCats,
        // 保留原有的 JSON 字段
        mutual_characters: Array.isArray(currentChar.mutual_characters)
          ? currentChar.mutual_characters
          : JSON.parse(currentChar.mutual_characters || '[]'),
        worldbook_ids: Array.isArray(currentChar.worldbook_ids)
          ? currentChar.worldbook_ids
          : JSON.parse(currentChar.worldbook_ids || '[]'),
      };
      // 聊天设置不改写在线/忙碌状态（由 trigger-ai / 叫TA / cron 维护）
      delete charUpdate.status;
      delete charUpdate.busy_since;
      await api.updateCharacter(charId, charUpdate);
      const remarkVal = document.getElementById('cs-remark')?.value?.trim() || '';
      try {
        const r = await api.setContactRemark(charId, remarkVal);
        currentChar.remark = r.remark || '';
        currentChar.display_name = r.display_name || currentChar.name;
        applyChatHeader(currentChar);
      } catch {}
      // 同步更新本地缓存
      Object.assign(currentChar, charUpdate);
      const emojiCount = emojiEnabled && emojiCats.length
        ? (await api.getEmojiCategories()).filter(c => emojiCats.some(id => id == c.id)).reduce((n, c) => n + (c.emojis?.length || 0), 0)
        : 0;
      if (emojiEnabled && emojiCats.length && !emojiCount) {
        window.showToast?.('保存成功，但该分类下暂无可用表情（请去表情包管理上传并填写描述）', 3500);
      } else {
        window.showToast?.('保存成功');
      }
    } catch(e) { window.showToast?.('角色设置保存失败: ' + e.message); return; }
  } else {
    window.showToast?.('保存成功');
  }

  document.getElementById('chat-settings-overlay').style.display = 'none';
  // 实时刷新：重新渲染消息列表以应用新头像/气泡设置
  await loadMessages(true);
  // 重渲后再次套用（含自定义 CSS），避免样式标签/类名被中间逻辑冲掉
  applyBubbleStyle(getChatSettings(charId));
};

window.setChatBg = function(type, value) {
  _pendingChatSettings.bgType = type;
  if (value) _pendingChatSettings.bgValue = value;
  updateBgRows(type, value || _pendingChatSettings.bgValue || '', _pendingChatSettings.bgColor || '#1a1a2e');
  const group = document.getElementById('cs-bgType');
  if (group) group.querySelectorAll('.tag').forEach(t => t.classList.toggle('active', t.dataset.val === type));
  if (type === 'image' && !String(_pendingChatSettings.bgValue || '').trim()) {
    window.pickChatBgImage?.();
  }
};

window.pickChatBgImage = function() {
  const el = document.getElementById('chat-bg-input');
  if (!el) return;
  el.value = '';
  el.click();
};

window.handleChatBgUpload = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';
  try {
    window.showToast?.('处理图片…');
    const result = await pickCropAndUpload(file, { title: '裁剪聊天背景', aspect: window.innerWidth / window.innerHeight });
    if (!result?.url) return;
    _pendingChatSettings.bgValue = result.url;
    _pendingChatSettings.bgType = 'image';
    updateBgRows('image', result.url, _pendingChatSettings.bgColor || '#1a1a2e');
    const group = document.getElementById('cs-bgType');
    if (group) group.querySelectorAll('.tag').forEach(t => t.classList.toggle('active', t.dataset.val === 'image'));
    window.showToast?.('背景已选好，点右上角保存后生效');
  } catch (err) {
    window.showToast?.(err?.message ? `上传失败: ${err.message}` : '上传失败');
  }
};

function syncBubbleColorUI(color, kind = 'user') {
  const isChar = kind === 'char';
  const idPrefix = isChar ? 'cs-char-bubble' : 'cs-bubble';
  const pickerId = isChar ? 'cs-charBubbleColor' : 'cs-userBubbleColor';
  const normalized = String(color || '').trim().toLowerCase();
  const picker = document.getElementById(pickerId);
  const presets = [...document.querySelectorAll(`#${idPrefix}-presets .bubble-color-swatch[data-color]`)];
  let matchedPreset = false;
  if (picker) {
    if (/^#[0-9a-f]{6}$/i.test(normalized)) picker.value = normalized;
    else if (!normalized) {
      if (isChar) {
        picker.value = '#f1f2f6';
      } else {
        const theme = getThemeColor()
          || getComputedStyle(document.documentElement).getPropertyValue('--theme').trim()
          || '#c9a0dc';
        if (/^#[0-9a-f]{6}$/i.test(theme)) picker.value = theme;
      }
    }
  }
  presets.forEach(el => {
    const swatch = String(el.dataset.color || '').trim().toLowerCase();
    const on = swatch === normalized;
    if (on) matchedPreset = true;
    el.classList.toggle('active', on);
  });
  const customSwatch = document.getElementById(`${idPrefix}-custom-swatch`);
  if (customSwatch) {
    const isCustom = !!normalized && /^#[0-9a-f]{6}$/i.test(normalized) && !matchedPreset;
    customSwatch.classList.toggle('active', isCustom);
    if (isCustom) customSwatch.style.background = normalized;
    else customSwatch.style.background = 'conic-gradient(red,yellow,green,cyan,blue,magenta,red)';
  }
}

window.setBubbleColorPreset = function(color) {
  const next = String(color || '').trim();
  _pendingChatSettings.userBubbleColor = next;
  syncBubbleColorUI(next, 'user');
  applyBubbleStyle(_pendingChatSettings);
};

window.setCharBubbleColorPreset = function(color) {
  const next = String(color || '').trim();
  _pendingChatSettings.charBubbleColor = next;
  syncBubbleColorUI(next, 'char');
  applyBubbleStyle(_pendingChatSettings);
};

window.onBubbleIntensityInput = function() {
  const opEl = document.getElementById('cs-bubbleOpacity');
  const blurEl = document.getElementById('cs-bubbleBlur');
  if (opEl) _pendingChatSettings.bubbleOpacity = parseInt(opEl.value, 10);
  if (blurEl) _pendingChatSettings.bubbleBlur = parseInt(blurEl.value, 10);
  applyBubbleStyle(_pendingChatSettings);
};

window.closeChatSettings = function() {
  document.getElementById('chat-settings-overlay').style.display = 'none';
  // 未保存时还原外观预览
  applyBgSettings();
  applyBubbleStyle(getChatSettings(charId));
};

const BUBBLE_SHAPE_ALIASES = {
  telegram: 'soft',
  wechat: 'tail',
  square: 'sharp',
  pill: 'plane',
};

function normalizeBubbleShape(shape) {
  const raw = String(shape || 'default').trim() || 'default';
  return BUBBLE_SHAPE_ALIASES[raw] || raw;
}

function hexToRgbTriplet(hex) {
  const h = String(hex || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
  return `${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)}`;
}

function applyBubbleStyleToEl(el, s) {
  if (!el) return;
  s = s || getChatSettings(charId);
  const style = s.bubbleStyle || 'solid';
  const shape = normalizeBubbleShape(s.bubbleShape || 'default');
  const isCustomShape = shape === 'custom';
  el.className = el.className
    .replace(/bubble-style-\S+/g, '')
    .replace(/bubble-shape-\S+/g, '')
    .replace(/\buser-bubble-custom\b/g, '')
    .replace(/\bchar-bubble-custom\b/g, '')
    .replace(/\bread-tag-(black|white)\b/g, '')
    .replace(/\bbubble-text-(black|white)\b/g, '')
    .trim();
  // 自定义形状时不要再挂透明/毛玻璃等风格类，避免和用户 CSS 抢优先级
  if (!isCustomShape && style !== 'solid') el.classList.add(`bubble-style-${style}`);
  if (shape !== 'default') el.classList.add(`bubble-shape-${shape}`);

  const fontPx = resolveBubbleFontSizePx(s);
  el.style.setProperty('--bubble-font-size', `${fontPx}px`);
  el.style.setProperty('--bubble-size', String(resolveBubbleSizeScale(s)));
  el.style.setProperty('--bubble-font-family', resolveBubbleFontFamily(s));
  el.style.setProperty('--bubble-gap', `${resolveBubbleGapPx(s)}px`);

  const textColor = resolveBubbleTextColor(s);
  el.classList.add(`bubble-text-${textColor}`);
  el.style.setProperty('--bubble-text-color', textColor === 'white' ? '#fff' : '#111');

  const readTagColor = s.readTagColor === 'white' ? 'white' : 'black';
  el.classList.add(`read-tag-${readTagColor}`);
  el.style.setProperty('--read-tag-color', readTagColor === 'white' ? '#fff' : '#000');

  // 用户与角色气泡共用的不透明度 / 实色强度
  // 自定义形状时强制不透明，避免主题 CSS 引用 --bubble-opacity（默认 0.65）导致发透
  const op = isCustomShape ? 1 : (s.bubbleOpacity ?? 65) / 100;
  const strength = isCustomShape ? 1 : (0.45 + ((s.bubbleBlur ?? 12) - 2) / 38 * 0.55);
  el.style.setProperty('--bubble-opacity', op);
  el.style.setProperty('--bubble-solid-strength', strength);
  el.style.setProperty('--user-bubble-opacity', op);
  el.style.setProperty('--user-bubble-solid-strength', strength);

  const color = String(s.userBubbleColor || '').trim();
  let rgb = hexToRgbTriplet(color);
  if (!rgb) {
    const theme = getThemeColor()
      || getComputedStyle(document.documentElement).getPropertyValue('--theme').trim()
      || '#c9a0dc';
    rgb = hexToRgbTriplet(theme) || '201,160,220';
  }
  el.style.setProperty('--theme-rgb', rgb);

  // 自定义 CSS 模式下：色板写死规则会盖住用户样式，这里主动让路；不透明度已拉满
  if (isCustomShape) {
    el.classList.remove('user-bubble-custom', 'char-bubble-custom');
    el.style.removeProperty('--user-bubble-bg');
    el.style.removeProperty('--bubble-ai-bg');
    el.style.removeProperty('--char-rgb');
    return;
  }

  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    el.classList.add('user-bubble-custom');
    el.style.setProperty('--user-bubble-bg', color);
  } else {
    el.classList.remove('user-bubble-custom');
    el.style.removeProperty('--user-bubble-bg');
  }

  // 角色气泡颜色：复用 --bubble-ai-bg（默认实色中性底），
  // 顺带派生 --char-rgb 给透明/毛玻璃/磨砂风格用
  const charColor = String(s.charBubbleColor || '').trim();
  const charRgb = hexToRgbTriplet(charColor);
  if (charRgb) {
    el.classList.add('char-bubble-custom');
    el.style.setProperty('--bubble-ai-bg', charColor);
    el.style.setProperty('--char-rgb', charRgb);
  } else {
    el.classList.remove('char-bubble-custom');
    el.style.removeProperty('--bubble-ai-bg');
    el.style.removeProperty('--char-rgb');
  }
}

function applyBubbleStyle(s) {
  s = s || getChatSettings(charId);
  applyBubbleStyleToEl(document.getElementById('messages-area'), s);
  applyBubbleStyleToEl(document.getElementById('cs-bubble-preview-stage'), s);
  applyBubbleStyleToEl(document.getElementById('cs-custom-bubble-preview-stage'), s);
  applyCustomBubbleCss(normalizeBubbleShape(s.bubbleShape || 'default') === 'custom' ? (s.customBubbleCss || '') : '');
}
window.applyBubbleStyleToEl = applyBubbleStyleToEl;

// 自定义气泡注入后追加：只锁语音条横排，不写死宽高（与文字气泡同一套尺寸规则）
const VOICE_BUBBLE_LAYOUT_LOCK = `
#messages-area.bubble-shape-custom .bubble-wrap .bubble.voice-bubble,
#cs-bubble-preview-stage.bubble-shape-custom .bubble-wrap .bubble.voice-bubble,
#cs-custom-bubble-preview-stage.bubble-shape-custom .bubble-wrap .bubble.voice-bubble {
  display: flex !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  white-space: nowrap !important;
  writing-mode: horizontal-tb !important;
  overflow: visible !important;
  flex-direction: row !important;
}
#messages-area.bubble-shape-custom .bubble-wrap.ai .voice-bubble .voice-play-icon,
#cs-bubble-preview-stage.bubble-shape-custom .bubble-wrap.ai .voice-bubble .voice-play-icon,
#cs-custom-bubble-preview-stage.bubble-shape-custom .bubble-wrap.ai .voice-bubble .voice-play-icon { order: 1 !important; }
#messages-area.bubble-shape-custom .bubble-wrap.ai .voice-bubble .voice-wave,
#cs-bubble-preview-stage.bubble-shape-custom .bubble-wrap.ai .voice-bubble .voice-wave,
#cs-custom-bubble-preview-stage.bubble-shape-custom .bubble-wrap.ai .voice-bubble .voice-wave { order: 2 !important; }
#messages-area.bubble-shape-custom .bubble-wrap.ai .voice-bubble .voice-duration,
#cs-bubble-preview-stage.bubble-shape-custom .bubble-wrap.ai .voice-bubble .voice-duration,
#cs-custom-bubble-preview-stage.bubble-shape-custom .bubble-wrap.ai .voice-bubble .voice-duration { order: 3 !important; }
#messages-area.bubble-shape-custom .bubble-wrap.user .voice-bubble .voice-duration,
#cs-bubble-preview-stage.bubble-shape-custom .bubble-wrap.user .voice-bubble .voice-duration,
#cs-custom-bubble-preview-stage.bubble-shape-custom .bubble-wrap.user .voice-bubble .voice-duration { order: 1 !important; }
#messages-area.bubble-shape-custom .bubble-wrap.user .voice-bubble .voice-wave,
#cs-bubble-preview-stage.bubble-shape-custom .bubble-wrap.user .voice-bubble .voice-wave,
#cs-custom-bubble-preview-stage.bubble-shape-custom .bubble-wrap.user .voice-bubble .voice-wave { order: 2 !important; }
#messages-area.bubble-shape-custom .bubble-wrap.user .voice-bubble .voice-play-icon,
#cs-bubble-preview-stage.bubble-shape-custom .bubble-wrap.user .voice-bubble .voice-play-icon,
#cs-custom-bubble-preview-stage.bubble-shape-custom .bubble-wrap.user .voice-bubble .voice-play-icon { order: 3 !important; }
#messages-area .voice-bubble .voice-duration,
#messages-area .voice-bubble .voice-play-icon,
#cs-bubble-preview-stage .voice-bubble .voice-duration,
#cs-bubble-preview-stage .voice-bubble .voice-play-icon,
#cs-custom-bubble-preview-stage .voice-bubble .voice-duration,
#cs-custom-bubble-preview-stage .voice-bubble .voice-play-icon {
  display: flex !important;
  flex-shrink: 0 !important;
  visibility: visible !important;
  opacity: 1 !important;
  position: relative !important;
}
#messages-area .voice-bubble .voice-duration,
#cs-bubble-preview-stage .voice-bubble .voice-duration,
#cs-custom-bubble-preview-stage .voice-bubble .voice-duration {
  display: inline-block !important;
  font-size: 12.5px !important;
}
#messages-area .voice-bubble .voice-wave,
#cs-bubble-preview-stage .voice-bubble .voice-wave,
#cs-custom-bubble-preview-stage .voice-bubble .voice-wave {
  display: flex !important;
  flex: 1 1 auto !important;
  flex-wrap: nowrap !important;
  min-width: 40px !important;
  height: 20px !important;
  visibility: visible !important;
  opacity: 1 !important;
}
#messages-area .voice-bubble .voice-bar,
#cs-bubble-preview-stage .voice-bubble .voice-bar,
#cs-custom-bubble-preview-stage .voice-bubble .voice-bar {
  display: block !important;
  visibility: visible !important;
  opacity: 0.45 !important;
  background: currentColor !important;
}
#messages-area .bubble.user.voice-bubble .voice-duration,
#messages-area .bubble.user.voice-bubble .voice-play-icon,
#messages-area .bubble.user.voice-bubble .voice-bar,
#cs-bubble-preview-stage .bubble.user.voice-bubble .voice-duration,
#cs-bubble-preview-stage .bubble.user.voice-bubble .voice-play-icon,
#cs-bubble-preview-stage .bubble.user.voice-bubble .voice-bar,
#cs-custom-bubble-preview-stage .bubble.user.voice-bubble .voice-duration,
#cs-custom-bubble-preview-stage .bubble.user.voice-bubble .voice-play-icon,
#cs-custom-bubble-preview-stage .bubble.user.voice-bubble .voice-bar {
  color: currentColor !important;
}
#messages-area .bubble.user.voice-bubble .voice-play-icon,
#cs-bubble-preview-stage .bubble.user.voice-bubble .voice-play-icon,
#cs-custom-bubble-preview-stage .bubble.user.voice-bubble .voice-play-icon {
  background: color-mix(in srgb, currentColor 18%, transparent) !important;
}
#messages-area .voice-bubble.is-playing .voice-bar,
#cs-bubble-preview-stage .voice-bubble.is-playing .voice-bar,
#cs-custom-bubble-preview-stage .voice-bubble.is-playing .voice-bar {
  opacity: 1 !important;
}
`;

// 把用户选择器前缀到聊天/预览宿主上，压过默认 .bubble.user 渐变和色板规则
function scopeCustomBubbleCss(css) {
  const trimmed = String(css || '').trim();
  if (!trimmed) return '';
  if (/#messages-area|#cs-bubble-preview-stage|#cs-custom-bubble-preview-stage/.test(trimmed)) {
    return trimmed;
  }
  const hosts = [
    '#messages-area.bubble-shape-custom',
    '#cs-bubble-preview-stage.bubble-shape-custom',
    '#cs-custom-bubble-preview-stage.bubble-shape-custom',
  ];
  // 简单规则：给每个选择器加上宿主前缀（够用日常气泡样式；复杂 @规则原样保留）
  // 语音条也套用自定义外观；横排结构由 VOICE_BUBBLE_LAYOUT_LOCK 兜底
  return trimmed.replace(/(^|})(\s*)([^{}@/][^{}]*)\{/g, (full, brace, space, selectors) => {
    const scoped = selectors.split(',').map((sel) => {
      const s = sel.trim();
      if (!s) return s;
      return hosts.map((h) => `${h} ${s}`).join(',\n');
    }).filter(Boolean).join(',\n');
    return `${brace}${space}${scoped}{`;
  });
}

// 自定义气泡 CSS：注入 <style>，实时作用于预览区和聊天区
function applyCustomBubbleCss(css) {
  let styleEl = document.getElementById('custom-bubble-style');
  if (!css || !css.trim()) {
    styleEl?.remove();
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'custom-bubble-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `${scopeCustomBubbleCss(css)}\n${VOICE_BUBBLE_LAYOUT_LOCK}`;
}

window.onCustomBubbleCssInput = function(val) {
  _pendingChatSettings.customBubbleCss = val;
  // 同步刷新上方「浏览效果」和自定义区小预览
  applyBubbleStyle(_pendingChatSettings);
};

// 气泡风格 tag 点击时同步显示/隐藏强度行
window.setChatSettingPending = function(key, value, el) {
  let next = value;
  if (key === 'bubbleShape') next = normalizeBubbleShape(value);
  _pendingChatSettings[key] = next;
  if (el) {
    el.closest('.tag-list')?.querySelectorAll('.tag').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
  }
  if (key === 'bgType') updateBgRows(next, _pendingChatSettings.bgValue || '', _pendingChatSettings.bgColor || '#1a1a2e');
  if (key === 'bubbleStyle') {
    const row = document.getElementById('cs-bubble-intensity-row');
    if (row) row.style.display = next !== 'solid' ? 'block' : 'none';
  }
  if (key === 'bubbleShape') {
    const customRow = document.getElementById('cs-custom-bubble-css-row');
    if (customRow) customRow.style.display = next === 'custom' ? 'block' : 'none';
  }
  if (key === 'bubbleStyle' || key === 'bubbleShape' || key === 'readTagColor' || key === 'bubbleTextColor' || key === 'bubbleFont') {
    applyBubbleStyle(_pendingChatSettings);
  }
  if (key === 'videoCallLook') {
    const row = document.getElementById('cs-video-look-sec-row');
    if (row) row.style.display = next === 'off' ? 'none' : 'flex';
  }
};

function fillBubbleFontTags(activeId) {
  const group = document.getElementById('cs-bubbleFont');
  if (!group) return;
  const fonts = getPaperFonts();
  const cur = isValidPaperFontId(activeId) ? activeId : 'sans';
  group.innerHTML = fonts.map((f) =>
    `<div class="tag${f.id === cur ? ' active' : ''}" data-val="${f.id}"
      style="font-family:${f.family}"
      onclick="setChatSettingPending('bubbleFont','${f.id}',this)">${f.label}</div>`
  ).join('');
}

window.onBubbleFontSizeSlide = function(val) {
  const px = Math.min(24, Math.max(12, Math.round(Number(val) || 15)));
  _pendingChatSettings.bubbleFontSizePx = px;
  const label = document.getElementById('cs-bubbleFontSizePx-val');
  if (label) label.textContent = `${px}px`;
  applyBubbleStyle(_pendingChatSettings);
};

window.onBubbleSizeSlide = function(val) {
  const pct = Math.min(140, Math.max(70, Math.round(Number(val) || 100)));
  _pendingChatSettings.bubbleSizePct = pct;
  const label = document.getElementById('cs-bubbleSizePct-val');
  if (label) label.textContent = `${pct}%`;
  applyBubbleStyle(_pendingChatSettings);
};

window.onBubbleGapSlide = function(val) {
  const px = Math.min(28, Math.max(0, Math.round(Number(val) || 0)));
  _pendingChatSettings.bubbleGapPx = px;
  const label = document.getElementById('cs-bubbleGapPx-val');
  if (label) label.textContent = `${px}px`;
  applyBubbleStyle(_pendingChatSettings);
};

function applyBgSettings() {
  const s = getChatSettings(charId);
  const bgEl = document.getElementById('chat-bg');
  if (!bgEl) return;
  if (s.bgType === 'image' && s.bgValue) {
    bgEl.style.background = `${chatBgCssUrl(s.bgValue)} center/cover no-repeat`;
  } else if (s.bgType === 'color' && s.bgColor) {
    bgEl.style.background = s.bgColor;
  } else {
    // 未单独设置聊天背景时透出「美化」页的主题背景
    bgEl.style.background = 'transparent';
  }
}

window.refreshChatAppearance = function() {
  applyBgSettings();
  applyBubbleStyle();
  const s = getChatSettings(charId);
  const locBtn = document.getElementById('toolbar-location-btn');
  if (locBtn) locBtn.style.display = s.showLocation === false ? 'none' : '';
};

window.confirmClearChat = function() {
  if (!confirm('确定清除所有聊天记录？此操作不可恢复')) return;
  api.clearMessages(charId, isDream ? 1 : 0).then(() => {
    clearThreadCache(charId, isDream);
    document.getElementById('messages-list').innerHTML = '';
    document.getElementById('chat-settings-overlay').style.display = 'none';
    window.showToast?.('已清除');
  });
};

// ===== 语音通话 =====
window.acceptProactiveCall = async function(call) {
  const cid = Number(call?.characterId);
  if (!cid) return;
  if (inCall) {
    window.showToast?.('请先结束当前通话');
    return;
  }
  const peer = getCharMeta(cid);
  const peerName = call.charName || peer?.name || 'TA';
  const peerAvatar = call.charAvatar || peer?.avatar || '';
  unlockAudioPlayback();
  // 必须在用户手势同一拍里启动原生通话/麦，否则 WebView 会丢掉权限与播放器绑定
  void setNativeCallMediaAudio(true);
  bindCallChatLayout();
  ensureCallPipBound();
  callTranscript = [];
  _playedCallSpeechIds.clear();
  clearCallChatArea();
  inCall = true;
  inVideoCall = !!call.video;
  callDialing = false;
  callCharId = cid;
  callMinimized = false;
  _callNeedUserVoiceBeforeSilence = false;
  _callCamFacing = call.camFacing === 'environment' ? 'environment' : 'user';
  const answerCamOff = !!(call.video && call.camOff);
  if (call.video && !answerCamOff && call.camStream && liveVideoTracks(call.camStream).length) {
    if (_callUserStream && _callUserStream !== call.camStream) stopMediaStream(_callUserStream);
    _callUserStream = call.camStream;
  } else if (call.camStream && call.camStream !== _callUserStream) {
    stopMediaStream(call.camStream);
  }
  resetCallSleepWatch();
  resetCallPresenceMode();
  startCallLockPoll();
  setCallVoiceMode(false);
  // 来电前已关摄像头则只备麦，别再抢开相机
  const mediaPrep = prepareCallMedia(!!call.video && !answerCamOff);

  const screen = document.getElementById('call-screen');
  screen.classList.remove('is-minimized', 'is-dragging', 'is-speaking', 'is-dialing', 'is-cam-swapped', 'is-rear-cam');
  screen.classList.toggle('is-video', !!call.video);
  screen.classList.toggle('is-cam-off', !!answerCamOff);
  clearCallPipInlinePos();
  screen.classList.add('active');
  showCallConnectedUi();
  startCallTimer();

  const avatarEl = document.getElementById('call-avatar');
  const nameEl = document.getElementById('call-name');
  if (avatarEl) avatarEl.src = peerAvatar;
  if (nameEl) nameEl.textContent = peerName;

  // 接听当下就挂预览 + 抢播通话动画：开场白 await 之后手势失效，再 play 会卡大播放键
  if (call.video) {
    if (!answerCamOff && liveVideoTracks(_callUserStream).length) {
      void attachCallUserVideo(_callUserStream).then(() => syncNativeCallOverlay());
    }
    const earlyCharVid = document.getElementById('call-char-video');
    const earlyPeer = peer || resolveCallPeerChar();
    const earlyClip = !isCallVideoTextMode(earlyPeer)
      ? String(earlyPeer?.call_video || '').trim()
      : '';
    if (earlyCharVid && earlyClip) {
      bindCallVideoPauseClass(earlyCharVid);
      const resolved = window.resolveMediaUrl?.(earlyClip) || earlyClip;
      if (earlyCharVid.getAttribute('src') !== resolved) earlyCharVid.src = resolved;
      screen.classList.add('has-call-clip');
      void forcePlayCallVideoEl(earlyCharVid, { loop: true });
    }
  }

  const opening = stripCallSoundFxLines(String(call.content || '').trim());
  const readyUrl = String(call.readyTtsUrl || '').trim();
  const textVideoOpen = !!(call.video && isCallVideoTextMode(peer));
  const speakOpening = textVideoOpen ? (callSpeakText(opening) || '') : callSpeakText(opening);
  const canSpeak = !!(readyUrl || (speakOpening && charHasVoiceId(peer)));
  if (opening) {
    // 文字视频：整段画面进通话区；语音只念台词
    if (textVideoOpen) {
      pushCallSceneLine(callDisplayText(opening) || opening);
    } else {
      const shownOpen = callDisplayText(opening) || speakOpening || opening;
      if (shownOpen) {
        callTranscript.push({ role: 'assistant', content: shownOpen });
        appendCallChatMsg('assistant', shownOpen);
      }
    }
  }

  // 接听瞬间先把通话页稳住；开场白已在响铃前生成好，隔一小会儿再播，避免叠在来电页上
  const speakAfter = Date.now() + 1300;
  if (useNativeCallAudio()) {
    await Promise.race([mediaPrep, sleepMs(480)]);
  } else {
    await mediaPrep;
  }
  if (!inCall) return;

  if (canSpeak) {
    const gap = speakAfter - Date.now();
    if (gap > 0) await sleepMs(gap);
    if (!inCall) return;
    setCallSpeaking(true);
    void setNativeCallMediaAudio(true);
    try {
      let ok = false;
      // 文字视频只念台词；普通视频/语音按硬停顿切
      const openerSpeak = speakOpening || opening;
      const openerParts = splitForCallTTS(openerSpeak).filter(Boolean);
      const openerUrls = [];
      if (readyUrl) {
        // 预生成路径：开场白一般短，多数情况下就是 1 段；多段时整段拼好的 readyUrl
        // 不便二次切，直接整段播，避免打断节奏
        openerUrls.push(readyUrl);
      } else if (openerParts.length > 1 && charHasVoiceId(peer)) {
        const fetched = await Promise.all(openerParts.map((seg) => prefetchTTS(seg, cid, { inCall: true })));
        if (!inCall) { setCallSpeaking(false); setCallIdleStatus(); return; }
        if (fetched.every((u) => !!u)) openerUrls.push(...fetched);
        else {
          // 任一段失败回退整段
          const fallback = await prefetchTTS(openerSpeak, cid, { inCall: true });
          if (fallback) openerUrls.push(fallback);
        }
      }
      if (openerUrls.length > 1) {
        let allOk = true;
        let firstErr = '';
        for (let i = 0; i < openerUrls.length; i++) {
          if (i > 0) {
            await sleepMs(CALL_SEGMENT_GAP_MS);
            if (!inCall) { allOk = false; break; }
          }
          const o = await playReadyTTS(openerUrls[i], () => {
            setCallSpeaking(false);
            setCallIdleStatus();
          });
          if (!o) { allOk = false; if (!firstErr) firstErr = getLastTtsError() || ''; break; }
        }
        ok = allOk;
      } else if (readyUrl) {
        ok = await playReadyTTS(readyUrl, () => {
          setCallSpeaking(false);
          setCallIdleStatus();
        });
      } else if (openerSpeak) {
        // 响铃前没预生成成功时的兜底
        ok = await playTTS(openerSpeak, () => {
          setCallSpeaking(false);
          setCallIdleStatus();
        }, cid);
      }
      setCallSpeaking(false);
      setCallIdleStatus();
      if (ok === false) {
        const err = getLastTtsError() || '';
        if (err && !/自动播放|NotAllowed|interact/i.test(err)) {
          window.showToast?.('语音播放失败: ' + err);
        }
      }
    } catch {
      setCallSpeaking(false);
      setCallIdleStatus();
    }
    if (!inCall) return;
  } else {
    setCallIdleStatus();
  }

  await mediaPrep;
  if (!inCall) return;
  if (inVideoCall) {
    await startCallCamera({ silent: true, camOff: answerCamOff });
    if (!inCall) return;
    await ensureCallVideosPlaying();
    syncCallVideoTextModeUi();
    void queueCallLookForNextRound();
  }

  setCallVoiceMode(true);
  syncNativeCallOverlay();

  const chatList = document.getElementById('messages-list');
  if (chatList && !document.getElementById('call-divider-start')) {
    chatList.insertAdjacentHTML('beforeend', buildCallRecordHtml({
      kind: 'start', video: inVideoCall, label: inVideoCall ? '视频通话开始' : '通话开始',
    }, { htmlId: 'call-divider-start' }));
    scrollBottom(true);
  }
  try {
    await api.sendMessage({
      characterId: callCharId,
      isDream: false,
      noReply: true,
      type: 'system',
      content: inVideoCall ? '[视频通话开始]' : '[语音通话开始]',
    });
  } catch {}

  if (!inCall) return;
  await armCallLiveAfterSpeak();
};

function formatCallDur(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2,'0')}:${String(sec % 60).padStart(2,'0')}`;
}

function startCallTimer() {
  callStartTime = Date.now();
  const timerEl = document.getElementById('call-timer');
  if (timerEl) timerEl.textContent = '00:00';
  callTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    if (timerEl) timerEl.textContent = formatCallDur(elapsed);
    const timeDisp = document.getElementById('call-time-display');
    if (timeDisp) {
      const now = new Date();
      timeDisp.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    }
  }, 1000);
}

function showCallDialingUi(char) {
  const screen = document.getElementById('call-screen');
  screen?.classList.add('is-dialing');
  screen?.classList.remove('is-minimized', 'is-speaking');
  const dAvatar = document.getElementById('call-dialing-avatar');
  const dName = document.getElementById('call-dialing-name');
  const dStatus = document.getElementById('call-dialing-status');
  if (dAvatar) dAvatar.src = char?.avatar || '';
  if (dName) dName.textContent = char?.name || 'TA';
  if (dStatus) dStatus.textContent = '正在呼叫…';
  const avatar = document.getElementById('call-avatar');
  const name = document.getElementById('call-name');
  if (avatar) avatar.src = char?.avatar || '';
  if (name) name.textContent = char?.name || 'TA';
}

function showCallConnectedUi() {
  const screen = document.getElementById('call-screen');
  screen?.classList.remove('is-dialing');
  const activeView = document.getElementById('call-active-view');
  const endedView = document.getElementById('call-ended-view');
  const bottom = document.getElementById('call-bottom');
  if (activeView) activeView.style.display = 'flex';
  if (endedView) endedView.style.display = 'none';
  if (bottom) bottom.style.display = '';
}

function shouldPeerDeclineCall(char) {
  if (isCharOperating(char)) return false;
  if (char?.status === 'busy' && char?.busy_style !== 'off') {
    return Math.random() >= 0.32; // 忙碌时约 68% 拒接
  }
  return false;
}

async function afterCallDeclined(peerCharId, peerName, wasVideo = false) {
  const list = document.getElementById('messages-list');
  if (list && shouldRenderForChar(peerCharId)) {
    list.insertAdjacentHTML('beforeend', buildCallRecordHtml({
      kind: 'missed', video: wasVideo, label: '对方已挂断',
    }));
    scrollBottom(true);
  }
  try {
    await api.sendMessage({
      characterId: peerCharId,
      isDream: false,
      noReply: true,
      type: 'system',
      content: wasVideo
        ? '[用户打来视频电话，你没有接听并挂断了]'
        : '[用户打来语音电话，你没有接听并挂断了]',
    });
    const result = await triggerAiAndWaitTyping(
      peerCharId,
      false,
      'continue',
      false,
      null,
      false,
      false,
      null,
      wasVideo
        ? '用户刚给你打来视频电话，你没接。用一两句口语说在忙什么。不要提系统。'
        : '用户刚给你打来语音电话，你没接。用一两句口语说在忙什么。不要提系统。'
    );
    rememberAiReplyResult(result);
    if (hasAiReplyPayload(result)) {
      await applyAiReplyResult(result, new Date().toISOString(), peerCharId);
    }
  } catch (e) {
    window.showToast?.(e?.message || `${peerName || '对方'}未接听`);
  }
}

async function answerPendingCall({ enableVoice = true } = {}) {
  if (!inCall) return false;
  if (!callDialing) {
    if (enableVoice && !_callVoiceMode) setCallVoiceMode(true);
    return true;
  }
  if (_callConnectBusy) return !callDialing && inCall;
  _callConnectBusy = true;
  const token = _dialingToken;
  try {
    callDialing = false;
    showCallConnectedUi();
    startCallTimer();
    try { await _callMediaPrepPromise; } catch {}
    if (token !== _dialingToken || !inCall) return false;
    if (inVideoCall) {
      await startCallCamera({ silent: false });
      if (token !== _dialingToken || !inCall) return false;
      await ensureCallVideosPlaying();
    }
    if (token !== _dialingToken || !inCall) return false;
    if (enableVoice) setCallVoiceMode(true);
    setCallIdleStatus();
    syncCallWaveform();
    syncNativeCallOverlay();
    const chatList = document.getElementById('messages-list');
    if (chatList && !document.getElementById('call-divider-start')) {
      chatList.insertAdjacentHTML('beforeend', buildCallRecordHtml({
        kind: 'start', video: inVideoCall, label: inVideoCall ? '视频通话开始' : '通话开始',
      }, { htmlId: 'call-divider-start' }));
      scrollBottom(true);
    }
    requestAnimationFrame(() => scrollCallChat());
    return true;
  } finally {
    _callConnectBusy = false;
  }
}

window.cancelDialingCall = function() {
  if (!callDialing) return;
  _dialingToken++;
  _dialRingUntil = 0;
  const peerId = callCharId;
  const wasVideo = inVideoCall;
  callDialing = false;
  inCall = false;
  inVideoCall = false;
  callCharId = null;
  callMinimized = false;
  invalidateCallMediaPrep();
  _callMediaPrepPromise = null;
  stopNativeCall();
  stopCallLockPoll();
  resetCallSleepWatch();
  resetCallPresenceMode();
  setCallVoiceMode(false);
  stopCallCamera();
  setNativeCallMediaAudio(false);
  void setNativeCallOverlay({ on: false });
  const screen = document.getElementById('call-screen');
  screen?.classList.remove('active', 'is-dialing', 'is-minimized', 'is-speaking', 'is-video', 'has-call-clip', 'has-call-lens', 'is-call-lens-text', 'is-cam-swapped', 'is-rear-cam', 'is-wave-idle', 'is-wave-thinking', 'is-wave-listening', 'is-wave-speaking');
  clearCallPipInlinePos();
  if (peerId && shouldRenderForChar(peerId)) {
    const list = document.getElementById('messages-list');
    list?.insertAdjacentHTML('beforeend', buildCallRecordHtml({
      kind: 'cancel', video: wasVideo, label: '已取消呼叫',
    }));
    scrollBottom(true);
  }
};

window.startVideoCall = function() {
  return window.startCall(true);
};

window.startCall = async function(asVideo = false) {
  setChatToolbarOpen(false);
  window.closeEmojiPanel?.();
  if (!currentChar || !charId) return;
  if (isDream) {
    window.showToast?.('梦境中不可用');
    return;
  }
  if (inCall) {
    if (isInVoiceCallWith(charId)) {
      window.expandCall?.();
    } else {
      window.showToast?.('请先结束当前通话');
    }
    return;
  }
  unlockAudioPlayback();
  setNativeCallMediaAudio(true);
  bindCallChatLayout();
  ensureCallPipBound();
  callTranscript = [];
  _playedCallSpeechIds.clear();
  clearCallChatArea();
  inCall = true;
  inVideoCall = !!asVideo;
  callDialing = true;
  callCharId = Number(charId);
  callMinimized = false;
  _callNeedUserVoiceBeforeSilence = false;
  resetCallSleepWatch();
  resetCallPresenceMode();
  startCallLockPoll();
  const token = ++_dialingToken;
  setCallVoiceMode(false);
  _callPreparedAudioError = null;
  _callPreparedVideoError = null;
  _callCamFacing = 'user';
  _callMediaPrepPromise = prepareCallMedia(asVideo);

  const screen = document.getElementById('call-screen');
  screen.classList.remove('is-minimized', 'is-dragging', 'is-speaking', 'has-call-clip', 'is-cam-swapped', 'is-rear-cam');
  screen.classList.toggle('is-video', !!asVideo);
  clearCallPipInlinePos();
  screen.classList.add('active');
  showCallDialingUi(currentChar);
  // 拨号手势里先把通话动画 mute 播起来，接通后再等会播不动就会卡大播放键
  if (asVideo) {
    const earlyCharVid = document.getElementById('call-char-video');
    const earlyClip = !isCallVideoTextMode(currentChar)
      ? String(currentChar?.call_video || '').trim()
      : '';
    if (earlyCharVid && earlyClip) {
      bindCallVideoPauseClass(earlyCharVid);
      const resolved = window.resolveMediaUrl?.(earlyClip) || earlyClip;
      if (earlyCharVid.getAttribute('src') !== resolved) earlyCharVid.src = resolved;
      screen.classList.add('has-call-clip');
      void forcePlayCallVideoEl(earlyCharVid, { loop: true });
    }
  }
  const dStatus = document.getElementById('call-dialing-status');
  if (dStatus) dStatus.textContent = asVideo ? '正在视频呼叫…' : '正在呼叫…';
  syncNativeCallOverlay();

  const ringMs = 2200 + Math.floor(Math.random() * 2200);
  _dialRingUntil = Date.now() + ringMs;

  // 先判定接/拒：接了才在振铃期间并行生成开场+TTS，避免拒接还空烧一轮 API
  const willDecline = shouldPeerDeclineCall(currentChar);
  const startLine = asVideo ? '[视频通话开始]' : '[语音通话开始]';
  let openerPromise = null;
  if (!willDecline) {
    openerPromise = (async () => {
      await sleepMs(60);
      if (token !== _dialingToken || !callDialing || !inCall) return;
      // 振铃期间就跑开场：语音就绪后再接通（playCallTtsSegment 里会等 _dialRingUntil）
      await doSend(startLine, 'system', {}, false, callCharId);
    })();
  }

  await new Promise(r => setTimeout(r, ringMs));
  if (token !== _dialingToken || !callDialing || !inCall) {
    invalidateCallMediaPrep();
    _dialRingUntil = 0;
    return;
  }

  const peerId = callCharId;
  const peerName = currentChar?.name || '对方';
  if (willDecline) {
    _dialRingUntil = 0;
    const hangStatus = document.getElementById('call-dialing-status');
    if (hangStatus) hangStatus.textContent = '对方已挂断';
    await new Promise(r => setTimeout(r, 900));
    if (token !== _dialingToken) return;
    const wasVideo = inVideoCall;
    callDialing = false;
    inCall = false;
    inVideoCall = false;
    callCharId = null;
    callMinimized = false;
    invalidateCallMediaPrep();
    setCallVoiceMode(false);
    stopCallCamera();
    stopNativeCall();
    setNativeCallMediaAudio(false);
    syncNativeCallOverlay();
    screen.classList.remove('active', 'is-dialing', 'is-minimized', 'is-speaking', 'is-video', 'has-call-clip', 'is-cam-swapped', 'is-rear-cam');
    clearCallPipInlinePos();
    window.showToast?.('对方未接听');
    await afterCallDeclined(peerId, peerName, wasVideo);
    return;
  }

  if (token !== _dialingToken || !inCall || !callDialing) {
    invalidateCallMediaPrep();
    _dialRingUntil = 0;
    return;
  }

  // 仍停在拨号页：等开场 AI+TTS；就绪后 playCallTtsSegment 会接通并出声
  const dStatus2 = document.getElementById('call-dialing-status');
  if (dStatus2 && callDialing) dStatus2.textContent = asVideo ? '正在接通…' : '正在接通…';
  if (openerPromise) {
    try { await openerPromise; } catch {}
  }
  if (token !== _dialingToken || !inCall) {
    _dialRingUntil = 0;
    return;
  }
  // 无声开场 / TTS 失败兜底：仍要切到通话页，避免卡在拨号
  if (callDialing) {
    await answerPendingCall({ enableVoice: true });
    _dialRingUntil = 0;
  } else if (!_callVoiceMode) {
    setCallVoiceMode(true);
  }
  if (token !== _dialingToken || !inCall) return;
  syncCallVideoTextModeUi();
  if (inVideoCall) void queueCallLookForNextRound();
  if (inCall && !callDialing) await armCallLiveAfterSpeak();
};

window.endCall = async function(opts = {}) {
  if (callDialing) {
    window.cancelDialingCall();
    return;
  }
  const skipSystemTip = !!opts.skipSystemTip;
  const endedCallCharId = callCharId;
  const wasMinimized = callMinimized;
  const wasVideo = inVideoCall;
  const callCharMeta = endedCallCharId != null ? getCharMeta(endedCallCharId) : null;
  inCall = false;
  inVideoCall = false;
  callDialing = false;
  callMinimized = false;
  setCallSpeaking(false);
  clearCallLensCaption(true);
  stopTTS();
  stopCallAmbient();
  stopCallBodyBeds();
  stopHangoutBed();
  stopCallOneShot();
  stopCallLockPoll();
  resetCallSleepWatch();
  resetCallPresenceMode();
  resetVoiceRecordingState();
  setCallVoiceMode(false);
  stopCallCamera();
  stopCallPreviewPump();
  _callMediaPrepPromise = null;
  stopNativeCall();
  setNativeCallMediaAudio(false);
  try { await setNativeCallOverlay({ on: false }); } catch { syncNativeCallOverlay(); }

  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
  const durationSec = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
  callStartTime = null;

  const durStr = formatCallDur(durationSec);
  const screen = document.getElementById('call-screen');

  if (wasMinimized) {
    screen?.classList.remove('active', 'is-minimized', 'is-dragging', 'is-speaking', 'is-dialing', 'is-video', 'has-call-clip', 'is-cam-swapped', 'is-rear-cam', 'is-wave-idle', 'is-wave-thinking', 'is-wave-listening', 'is-wave-speaking');
    clearCallPipInlinePos();
    window.showToast?.(`${wasVideo ? '视频通话' : '通话'}结束 · ${durStr}`);
  } else {
    const activeView = document.getElementById('call-active-view');
    const endedView  = document.getElementById('call-ended-view');
    const bottom     = document.getElementById('call-bottom');
    const durEl      = document.getElementById('call-ended-dur');
    screen?.classList.remove('is-dialing');
    if (activeView) activeView.style.display = 'none';
    if (endedView)  { endedView.style.display = 'flex'; }
    if (bottom)     bottom.style.display = 'none';
    if (durEl)      durEl.textContent = `通话时长 ${durStr}`;

    setTimeout(() => {
      screen?.classList.remove('active', 'is-minimized', 'is-speaking', 'is-dialing', 'is-video', 'has-call-clip', 'is-cam-swapped', 'is-rear-cam', 'is-wave-idle', 'is-wave-thinking', 'is-wave-listening', 'is-wave-speaking');
      clearCallPipInlinePos();
      if (activeView) activeView.style.display = 'flex';
      if (endedView)  endedView.style.display = 'none';
      if (bottom)     bottom.style.display = '';
    }, 3000);
  }

  // 用户自己挂断：写入系统气泡并进本地会话缓存，避免刷新后消失。
  // 角色主动挂断走 peer_end，那边已经有「语音通话结束 · 时长」，这里不要再插一条。
  if (endedCallCharId && !skipSystemTip) {
    const endContent = `[${wasVideo ? '视频通话' : '语音通话'}已结束] 通话计时 ${durStr}`;
    let savedId = null;
    try {
      const saved = await api.sendMessage({
        characterId: endedCallCharId, isDream: false, noReply: true,
        content: endContent,
        type: 'system',
      });
      savedId = saved?.userMsgId ?? saved?.id ?? null;
    } catch {}
    const endMsg = {
      id: savedId != null ? savedId : `call_end_${Date.now()}`,
      role: 'user',
      type: 'system',
      content: endContent,
      timestamp: new Date().toISOString(),
      character_id: endedCallCharId,
    };
    try { upsertThreadMessages(endedCallCharId, false, [endMsg]); } catch {}
    if (shouldRenderForChar(endedCallCharId)) {
      const chatList = document.getElementById('messages-list');
      if (chatList && !isAiMsgInDom(endMsg.id)) {
        chatList.insertAdjacentHTML('beforeend', buildBubble(endMsg, callCharMeta || getCharMeta(endedCallCharId), {}, { charId: endedCallCharId }));
        scrollBottom(true);
      }
    }
  }

  if (endedCallCharId) {
    const peerName = callCharMeta?.name || 'TA';
    const summary = callTranscript.length
      ? callTranscript.map(m =>
        `${m.role === 'user' ? '我' : peerName}：${m.content}`
      ).join('\n')
      : '';
    api.saveCallLog({ characterId: endedCallCharId, duration: durationSec, transcript: summary }).catch(() => {});
  }

  callTranscript = [];
  _playedCallSpeechIds.clear();
  clearCallChatArea();
  callCharId = null;
};

/** 安装新通话引擎：覆盖拨出/接听/挂断/模式切换；本地标志与引擎状态同步 */
(function installNianCallEngine() {
  const syncFlags = () => {
    try {
      const s = getCallEngineState();
      inCall = !!s.inCall;
      callDialing = !!s.callDialing;
      callCharId = s.callCharId;
      inVideoCall = !!s.inVideoCall;
      callMinimized = !!s.callMinimized;
      _callPresenceMode = s.presenceMode || 'talk';
      _callVoiceMode = !!s.voiceMode;
      _callUserAsleep = !!s.userAsleep;
      _dialRingUntil = Number(s.dialRingUntil) || 0;
      _dialingToken = Number(s.dialingToken) || _dialingToken;
      applyCallVoiceModeUi();
      if (inCall && !callDialing) startCallLockPoll();
      else stopCallLockPoll();
    } catch (e) {
      console.warn('[call] syncFlags', e?.message || e);
    }
  };

  installCallEngine({
    syncFlags,
    pullFlags: syncFlags,
    doSend: (...args) => doSend(...args),
    isSendBusy: () => !!_doSendBusy,
    setIdleStatus: () => setCallIdleStatus(),
    syncOverlay: () => { void syncNativeCallOverlay(); },
    probeAudioDuration: (blob) => probeAudioBlobDuration(blob),
    getCurrentChar: () => currentChar,
    getCharId: () => charId,
    getCharMeta: (id) => getCharMeta(id),
    isDream: () => !!isDream,
    setChatToolbarOpen: (on) => setChatToolbarOpen?.(on),
    bindCallChatLayout: () => bindCallChatLayout(),
    ensureCallPipBound: () => ensureCallPipBound(),
    clearCallPipInlinePos: () => clearCallPipInlinePos(),
    prepareCallMedia: (asVideo) => prepareCallMedia(asVideo),
    invalidateCallMediaPrep: () => invalidateCallMediaPrep(),
    stopCallCamera: () => stopCallCamera(),
    startCallCamera: (opts) => startCallCamera(opts),
    shouldPeerDeclineCall: (char) => shouldPeerDeclineCall(char),
    afterCallDeclined: (id, name, video) => afterCallDeclined(id, name, video),
    shouldRenderForChar: (id) => shouldRenderForChar(id),
    scrollBottom: (force) => scrollBottom(force),
    syncCallVideoTextModeUi: () => syncCallVideoTextModeUi(),
    queueCallLookForNextRound: () => queueCallLookForNextRound(),
    useNativeCallAudio: () => useNativeCallAudio(),
    prepareMediaSettle: async () => {
      try { await _callMediaPrepPromise; } catch {}
    },
    setMediaPrepPromise: (p) => {
      _callMediaPrepPromise = p || null;
    },
    adoptIncomingCamStream: (stream, facing) => {
      if (_callUserStream && _callUserStream !== stream) stopMediaStream(_callUserStream);
      _callUserStream = stream;
      _callCamFacing = facing === 'environment' ? 'environment' : 'user';
      // 接听当下立刻挂到小窗，别只存流等后面再挂
      if (stream && liveVideoTracks(stream).length) {
        void attachCallUserVideo(stream).then(() => syncNativeCallOverlay());
      }
    },
    ensureCallVideosPlaying: () => ensureCallVideosPlaying(),
    applyVoiceModeUi: (on) => {
      _callVoiceMode = !!on;
      applyCallVoiceModeUi();
    },
  });
})();

/** 通话 ↻：与聊天页「重新生成」相同，重滚上一条 AI 回复 */
window.rerollCallMessage = async function() {
  if (!inCall || !callCharId || callDialing) return;
  if (_doSendBusy) {
    window.showToast?.('上一条还在发送中，请稍候');
    return;
  }
  const sendCharId = callCharId;
  _doSendBusy = true;
  updateCallLiveHoldUi();
  appendCallChatMsg('system', '↻ 重新生成回复…');

  try {
    const cleared = await clearAiRepliesAfterLastUser(sendCharId);
    if (!cleared.ok && cleared.reason === 'no_user') {
      window.showToast?.('没有可重新生成的内容');
      setCallIdleStatus();
      return;
    }
    if (!cleared.cleared) {
      window.showToast?.('没有 AI 消息可重新生成');
      setCallIdleStatus();
      return;
    }

    // 通话字幕去掉被删掉的助手句（尽量与库同步）
    while (callTranscript.length && callTranscript[callTranscript.length - 1]?.role === 'assistant') {
      callTranscript.pop();
    }
    const area = document.getElementById('call-chat-area');
    if (area) {
      [...area.querySelectorAll('.call-chat-assistant')].slice(-(cleared.cleared || 1)).forEach(el => el.remove());
    }

    await new Promise(r => setTimeout(r, Math.random() * 400 + 180));

    const result = await api.triggerAi(sendCharId, isDream, 'retry', false, null, true, false, null, null, null, callTriggerExtra());
    rememberAiReplyResult(result);
    setCallIdleStatus();

    if (hasAiReplyPayload(result)) {
      await applyAiReplyResult(result, cleared.msgs[cleared.lastUserIdx].timestamp, sendCharId);
    } else {
      appendCallChatMsg('system', '角色暂时没有回应，请稍后再试');
    }
  } catch (e) {
    showCharTypingFor(sendCharId, false);
    setCallIdleStatus();
    const recovered = await recoverSavedAiReply(sendCharId);
    if (!recovered) {
      appendCallChatMsg('system', '重新生成失败' + (e?.message ? `：${e.message}` : ''));
      window.showToast?.('重新生成失败: ' + (e.message || ''));
    }
  } finally {
    _doSendBusy = false;
  }
};

window.rollCallScenario = window.rerollCallMessage;

// 通话屏实时文字显示
function appendCallChatMsg(role, text) {
  const area = document.getElementById('call-chat-area');
  if (!area) return;
  const div = document.createElement('div');
  div.className = `call-chat-msg call-chat-${role}`;
  div.textContent = text;
  area.appendChild(div);
  scrollCallChat();
}

window.handleCallKey = function(e) {
  if (e.isComposing || e.keyCode === 229 || _chatComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const input = document.getElementById('call-input');
    const text = input?.value.trim() || '';
    if (text && shouldBlockImeSpuriousSend(text, input)) return;
    markExplicitChatSend();
    window.sendCallMessage();
  }
};

window.sendCallMessage = async function() {
  const input = document.getElementById('call-input');
  const text = input?.value.trim() || '';
  if (!text || !callCharId) return;
  if (shouldBlockImeSpuriousSend(text, input)) {
    input.value = '';
    return;
  }
  input.value = '';
  callTranscript.push({ role: 'user', content: text });
  maybeAutoHangoutFromUserText(text);
  await doSend(text, 'text', {}, false, callCharId);
};

// ===== 记忆页跳转 =====
window.openMemoryPage = function() {
  setChatToolbarOpen(false);
  window._memoryMode = 'short';
  window._memoryInitTab = 'memory';
  window.navigateTo?.('memory');
};

// ===== 情绪面板 =====
let _emotionHours = 2;
let _emotionEvents = [];
let _emotionHistory = [];
let _emotionTrailAnim = null;
let _emotionLoadBusy = false;
let _emotionQueuedLoad = null;

function emotionEventColor(type) {
  if (type === 'anger' || type === 'rekindle') return '#c45b5b';
  if (type === 'hurt') return '#8a6aa8';
  if (type === 'desire') return '#c2785a';
  if (type === 'longing') return '#6a8ab0';
  if (type === 'intimacy') return '#c47a9a';
  if (type === 'rise') return '#3d8f6e';
  if (type === 'silence_unread' || type === 'silence_read' || type === 'phone_ignore') return '#9a7a32';
  return '#5a7a96';
}

function setEmotionEventOpen(ev, { toggle = false } = {}) {
  if (!ev) {
    document.querySelectorAll('.emotion-event-item').forEach(el => el.classList.remove('active'));
    return;
  }
  document.querySelectorAll('.emotion-event-item').forEach(el => {
    const match = String(el.dataset.id) === String(ev.id);
    if (toggle && match && el.classList.contains('active')) {
      el.classList.remove('active');
      return;
    }
    el.classList.toggle('active', match);
  });
}

function renderEmotionEvents(events) {
  const el = document.getElementById('emotion-events');
  if (!el) return;
  _emotionEvents = events || [];
  if (!_emotionEvents.length) {
    el.innerHTML = `<div class="emotion-events-empty">这段时间还没有明显的大幅起伏</div>`;
    return;
  }
  el.innerHTML = _emotionEvents.slice(0, 16).map(ev => {
    const reason = escapeHtml(ev.reason || ev.detail || ev.summary || '暂无具体原因记录');
    return `
    <button type="button" class="emotion-event-item" data-id="${ev.id}">
      <div class="emotion-event-row">
        <span class="emotion-event-dot emotion-event-dot--${escapeHtml(ev.type)}"></span>
        <span class="emotion-event-main">
          <div class="emotion-event-name">${escapeHtml(ev.title)}</div>
          <div class="emotion-event-sub">${escapeHtml(ev.label || '点开看原因')}</div>
        </span>
        <span class="emotion-event-when">${escapeHtml((ev.when || '').slice(5))}</span>
      </div>
      <div class="emotion-event-reason">${reason}</div>
    </button>`;
  }).join('');
}

function animateEmotionTrail(svg) {
  if (_emotionTrailAnim) {
    cancelAnimationFrame(_emotionTrailAnim);
    _emotionTrailAnim = null;
  }
  const clipRect = svg.querySelector('#emotionSweepClip rect');
  const beam = svg.querySelector('.emotion-chart-beam');
  const beamGlow = svg.querySelector('.emotion-chart-beam-glow');
  const heads = svg.querySelectorAll('.emotion-chart-head-mood');
  const marks = [...svg.querySelectorAll('.emotion-chart-mark')];
  if (!clipRect) return;

  const plotL = Number(clipRect.getAttribute('data-plot-l')) || 0;
  const plotW = Number(clipRect.getAttribute('data-plot-w')) || 320;

  clipRect.setAttribute('width', '0');
  marks.forEach(m => { m.style.opacity = '0'; });
  heads.forEach(h => { h.style.opacity = '0'; });

  const dur = 2800;
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = p < 0.7 ? (p / 0.7) * 0.85 : 0.85 + ((p - 0.7) / 0.3) * 0.15;
    const ease = e * e * (3 - 2 * e);
    const x = plotL + plotW * ease;
    clipRect.setAttribute('width', String(Math.max(0, x - plotL)));
    if (beam) {
      beam.setAttribute('x1', x.toFixed(1));
      beam.setAttribute('x2', x.toFixed(1));
      beam.style.opacity = p < 1 ? '1' : '0.35';
    }
    if (beamGlow) {
      beamGlow.setAttribute('x1', x.toFixed(1));
      beamGlow.setAttribute('x2', x.toFixed(1));
      beamGlow.style.opacity = p < 1 ? '1' : '0.2';
    }
    heads.forEach(h => {
      const hx = Number(h.getAttribute('cx')) || 0;
      h.style.opacity = hx <= x + 1 ? '1' : '0';
    });
    marks.forEach((m) => {
      const mx = Number(m.dataset.x) || 0;
      m.style.opacity = mx <= x + 1 ? '1' : '0';
    });
    if (p < 1) {
      _emotionTrailAnim = requestAnimationFrame(tick);
    } else {
      clipRect.setAttribute('width', String(plotW));
      _emotionTrailAnim = null;
      const pulse = (t) => {
        if (!beam || !svg.isConnected) {
          _emotionTrailAnim = null;
          return;
        }
        const a = 0.25 + (Math.sin(t / 320) + 1) * 0.2;
        beam.style.opacity = String(a);
        if (beamGlow) beamGlow.style.opacity = String(a * 0.55);
        _emotionTrailAnim = requestAnimationFrame(pulse);
      };
      _emotionTrailAnim = requestAnimationFrame(pulse);
    }
  };
  _emotionTrailAnim = requestAnimationFrame(tick);
}

/** 近 windowHours 小时的体感心情阶梯序列（效价叠火气/委屈，单线监护仪） */
function emotionFeltFromLog(h) {
  if (Number.isFinite(Number(h?.felt))) return Number(h.felt);
  const v = Number(h?.valence) || 0;
  const anger = Number(h?.fuel_anger) || 0;
  const hurt = Number(h?.fuel_hurt) || 0;
  const low = Number(h?.fuel_low) || 0;
  const yearning = Number(h?.fuel_longing) || 0;
  return v - anger * 0.34 - hurt * 0.30 - low * 0.22 - Math.max(0, yearning - 38) * 0.10;
}

function buildEmotionMonitorSeries(history, windowHours = 2) {
  const tEnd = Date.now();
  const tStart = tEnd - windowHours * 3600000;
  const raw = (history || [])
    .map(h => {
      const t = Date.parse(h.ts);
      const v = emotionFeltFromLog(h);
      if (!Number.isFinite(t) || !Number.isFinite(v)) return null;
      return { t, v, id: h.id };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);

  if (!raw.length) return null;

  let v = 0;
  let saw = false;
  for (const h of raw) {
    if (h.t <= tStart) {
      v = h.v;
      saw = true;
    }
  }
  const inWin = raw.filter(h => h.t >= tStart && h.t <= tEnd);
  if (!saw && !inWin.length) return null;
  if (!saw && inWin.length) v = inWin[0].v;

  const series = [{ t: tStart, v }];
  for (const h of inWin) {
    const last = series[series.length - 1];
    if (h.t > last.t) series.push({ t: h.t, v: last.v });
    series.push({ t: h.t, v: h.v });
    v = h.v;
  }
  const last = series[series.length - 1];
  if (last.t < tEnd) series.push({ t: tEnd, v: last.v });

  return { series, tStart, tEnd };
}

/** 以平静（效价 0）为中线，不把性格基线当成「平时」。 */
function renderEmotionChart(history, events, mood = {}, { animate = false } = {}) {
  const svg = document.getElementById('emotion-chart');
  const empty = document.getElementById('emotion-chart-empty');
  if (!svg) return;

  if (_emotionTrailAnim) {
    cancelAnimationFrame(_emotionTrailAnim);
    _emotionTrailAnim = null;
  }

  const built = buildEmotionMonitorSeries(history, _emotionHours || 2);
  _emotionHistory = history || [];
  if (!built || built.series.length < 2) {
    svg.innerHTML = '';
    if (empty) empty.style.display = '';
    const ampEl = document.getElementById('emotion-chart-amplitude');
    if (ampEl) ampEl.textContent = '幅度 —';
    return;
  }
  if (empty) empty.style.display = 'none';

  const { series, tStart, tEnd } = built;
  const span = Math.max(tEnd - tStart, 1);
  const calmZero = 0;
  const deltas = series.map(s => s.v - calmZero);
  const rawValues = series.map(s => s.v);
  const amplitude = Math.max(...rawValues) - Math.min(...rawValues);
  const observedAbs = Math.max(1, ...deltas.map(Math.abs));
  const scale = Math.min(100, Math.max(6, Math.ceil((observedAbs * 1.18) / 5) * 5));
  const ampEl = document.getElementById('emotion-chart-amplitude');
  if (ampEl) ampEl.textContent = `幅度 ${amplitude.toFixed(amplitude < 10 ? 1 : 0)}`;
  const W = 360;
  const H = 220;
  const padL = 28;
  const padR = 10;
  const padT = 14;
  const padB = 14;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const toX = (t) => padL + ((t - tStart) / span) * plotW;
  const toY = (v) => {
    const delta = Math.max(-scale, Math.min(scale, (Number(v) || 0) - calmZero));
    return padT + (1 - (delta + scale) / (scale * 2)) * plotH;
  };

  const pts = series.map(s => ({
    x: toX(s.t),
    y: toY(s.v),
    v: s.v,
    delta: s.v - calmZero,
  }));
  const midY = toY(calmZero);
  const segments = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const positive = (a.delta + b.delta) / 2 >= 0;
    const color = positive ? '#3d8f6e' : '#c45b5b';
    const glow = positive ? 'rgba(61,143,110,.25)' : 'rgba(196,91,91,.22)';
    segments.push(
      `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${glow}" stroke-width="6" stroke-linecap="round"/>`,
      `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`,
    );
  }

  const last = pts[pts.length - 1];
  const lastColor = last.delta >= 0 ? '#3d8f6e' : '#c45b5b';
  const marks = (events || []).filter(e => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= tStart && t <= tEnd;
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.width = '';
  svg.innerHTML = `
    <defs>
      <clipPath id="emotionSweepClip">
        <rect data-plot-l="${padL}" data-plot-w="${plotW}" x="${padL}" y="${padT}" width="${animate ? 0 : plotW}" height="${plotH}"/>
      </clipPath>
    </defs>
    <line x1="${padL}" y1="${midY.toFixed(1)}" x2="${W - padR}" y2="${midY.toFixed(1)}" stroke="currentColor" stroke-opacity="0.22" stroke-dasharray="4 4"/>
    <text x="2" y="${padT + 8}" font-size="9" fill="currentColor" opacity="0.48">+${scale}</text>
    <text x="2" y="${midY + 3}" font-size="9" fill="currentColor" opacity="0.48">平静</text>
    <text x="2" y="${H - padB - 2}" font-size="9" fill="currentColor" opacity="0.48">-${scale}</text>
    <g clip-path="url(#emotionSweepClip)">
      ${segments.join('')}
      <circle class="emotion-chart-head-mood emotion-chart-point" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4.2" style="fill:${lastColor}"/>
      ${marks.map((p) => {
        const t = Date.parse(p.ts);
        const x = toX(t);
        const y = toY(Number.isFinite(Number(p.felt)) ? Number(p.felt) : (Number(p.valence) || 0));
        const color = emotionEventColor(p.type);
        return `<g class="emotion-chart-mark" data-id="${p.id}" data-x="${x.toFixed(1)}">
          <line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${H - padB}" stroke="${color}" stroke-opacity="0.22" stroke-width="1"/>
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="transparent"/>
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.8" fill="${color}"/>
        </g>`;
      }).join('')}
    </g>
    <line class="emotion-chart-beam-glow" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" style="opacity:${animate ? 1 : 0}"/>
    <line class="emotion-chart-beam" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" style="opacity:${animate ? 1 : 0}"/>
  `;
  if (animate) requestAnimationFrame(() => animateEmotionTrail(svg));
}

function renderFuelRow(r, thresholds) {
  const v = Math.max(0, Math.min(100, Number(r.value) || 0));
  const threshold = Number(thresholds[r.thresholdKey || r.key]);
  const nearText = r.near && Number.isFinite(threshold) && v >= threshold - 12 ? r.near : '';
  const tip = nearText ? `<div class="emotion-fuel-tip">${nearText}</div>` : '';
  return `<div class="emotion-fuel-block">
      <div class="emotion-fuel-row">
        <span>${r.name}</span>
        <div class="emotion-fuel-track"><div class="emotion-fuel-fill emotion-fuel-fill--${r.key}" style="width:${v}%"></div></div>
        <span class="emotion-fuel-val">${Math.round(v)}</span>
      </div>${tip}
    </div>`;
}

function renderEmotionFuels(mood) {
  const el = document.getElementById('emotion-fuels');
  if (!el || !mood?.fuel) return;
  const yearning = Math.max(0, Math.min(100, Number(mood.yearning) || 0));
  const th = mood.thresholds || {};
  const groups = [
    {
      title: '亮的',
      rows: [
        { key: 'joy', name: '😊', value: mood.joy ?? Math.max(0, Number(mood.valence) || 0) },
        { key: 'warm', name: '🌸', value: mood.warm ?? 0 },
      ],
    },
    {
      title: '沉的',
      rows: [
        { key: 'anger', name: '💢', value: mood.fuel.anger, near: '接近燃点' },
        { key: 'hurt', name: '😢', value: mood.fuel.hurt, near: '接近燃点' },
        { key: 'low', name: '🌧️', value: mood.fuel.low, near: '接近燃点' },
        { key: 'anxious', name: '😟', value: mood.anxious ?? 0 },
        { key: 'tired', name: '😴', value: mood.tired ?? 0 },
      ],
    },
    {
      title: '对人',
      rows: [
        { key: 'longing', thresholdKey: 'yearning', name: '💭', value: yearning, near: '接近燃点' },
        { key: 'intimacy', name: '💗', value: mood.fuel.intimacy, near: '接近燃点' },
        { key: 'desire', name: '🔥', value: mood.fuel.desire, near: '接近燃点' },
      ],
    },
  ];
  el.innerHTML = groups.map((g) => `
      <div class="emotion-fuel-group-title">${g.title}</div>
      ${g.rows.map((r) => renderFuelRow(r, th)).join('')}
    `).join('');
}

async function loadEmotionPanel(hours = _emotionHours, { animate = false } = {}) {
  _emotionHours = hours;
  if (!charId) return;
  if (_emotionLoadBusy) {
    _emotionQueuedLoad = { hours, animate };
    return;
  }
  _emotionLoadBusy = true;
  const title = document.getElementById('emotion-panel-title');
  if (title) title.textContent = `${currentChar?.name || '角色'}的情绪`;
  try {
    const data = await api.getCharEmotion(charId, hours);
    const mood = data?.mood || {};
    const label = document.getElementById('emotion-label');
    const buildup = document.getElementById('emotion-buildup');
    const note = document.getElementById('emotion-note');
    if (label) label.textContent = mood.emoji || mood.display || '😌';
    if (buildup) {
      const BUILDUP_ZH = {
        steady: '',
        mild: '微微积着',
        building: '有积压',
        near_flash: '接近燃点',
        flash: '刚过燃点',
      };
      const bits = [];
      const bu = BUILDUP_ZH[mood.buildup] || (mood.buildup && mood.buildup !== 'steady' ? mood.buildup : '');
      if (bu) bits.push(bu);
      if (data?.conflict?.phase === 'open') bits.push('还有未翻篇的冲突余波');
      else if (data?.conflict?.phase === 'residual') bits.push('冲突已缓，余温还在');
      buildup.textContent = bits.filter(Boolean).join(' · ');
    }
    if (note) note.textContent = mood.note || '';
    renderEmotionFuels(mood);
    renderEmotionEvents(data?.events || []);
    renderEmotionChart(data?.history || [], data?.events || [], mood, { animate });
    if (mood.display && currentChar) {
      currentChar.mood = mood.display;
      window.renderHomeChar?.();
    }
  } catch (e) {
    window.showToast?.(e.message || '读取情绪失败');
  } finally {
    _emotionLoadBusy = false;
    const queued = _emotionQueuedLoad;
    _emotionQueuedLoad = null;
    if (queued) loadEmotionPanel(queued.hours, { animate: queued.animate });
  }
}

window.openEmotionPanel = function() {
  setChatToolbarOpen(false);
  const ov = document.getElementById('emotion-overlay');
  if (!ov) return;
  ov.style.display = '';
  ov.classList.add('active');
  loadEmotionPanel(_emotionHours, { animate: true });
};

window.closeEmotionPanel = function() {
  const ov = document.getElementById('emotion-overlay');
  if (!ov) return;
  ov.classList.remove('active');
  ov.style.display = 'none';
  _emotionQueuedLoad = null;
  if (_emotionTrailAnim) {
    cancelAnimationFrame(_emotionTrailAnim);
    _emotionTrailAnim = null;
  }
};

window.setEmotionRange = function(hours) {
  const h = [2, 24, 168].includes(Number(hours)) ? Number(hours) : 2;
  _emotionHours = h;
  document.querySelectorAll('#emotion-range-tabs button').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.hours) === h);
  });
  const start = document.getElementById('emotion-chart-start-label');
  if (start) start.textContent = h === 168 ? '7天前' : `${h}小时前`;
  loadEmotionPanel(h);
};

document.getElementById('emotion-events')?.addEventListener('click', (e) => {
  const item = e.target.closest('.emotion-event-item');
  if (!item) return;
  const ev = _emotionEvents.find(x => String(x.id) === String(item.dataset.id));
  setEmotionEventOpen(ev || null, { toggle: true });
});

document.getElementById('emotion-chart')?.addEventListener('click', (e) => {
  const mark = e.target.closest?.('.emotion-chart-mark');
  if (!mark) return;
  const ev = _emotionEvents.find(x => String(x.id) === String(mark.dataset.id));
  if (!ev) return;
  setEmotionEventOpen(ev);
  const btn = document.querySelector(`.emotion-event-item[data-id="${CSS.escape(String(ev.id))}"]`);
  btn?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
});

// ===== 刷新 =====
window.refreshChatPage = function() {
  showCharTyping(false);
  loadMessages(true, { force: true });
};

/** 自拍占位 → 换成真实图（或失败态，不再删气泡） */
window.onMessageUpdate = function(data) {
  const cid = Number(data.characterId);
  const id = data.id != null ? String(data.id) : '';
  if (!id) return;
  if (data.recalled) {
    if (shouldRenderForChar(cid)) applyRecalledUiForMsg(id, data.recalledContent);
    return;
  }
  if (data.deleted) {
    if (shouldRenderForChar(cid)) {
      document.querySelectorAll(`[data-id="${CSS.escape(id)}"],[data-msg-id="${CSS.escape(id)}"]`).forEach(el => removeChatBubbleEl(el));
    }
    clearMediaReadyUpdate(id);
    return;
  }
  if (data.selfieFailed || data.videoFailed) {
    rememberMediaReadyUpdate(data);
    clearSelfiePendingWait(true);
    upsertMediaMsgToThreadCache(cid, data);
    if (shouldRenderForChar(cid)) {
      const wrap = document.querySelector(`.bubble-wrap[data-id="${CSS.escape(id)}"], .bubble-wrap[data-msg-id="${CSS.escape(id)}"]`);
      const errHint = String(data.error || '').trim();
      if (wrap && data.content) {
        const main = wrap.querySelector('.bubble-main') || wrap;
        const isVideo = data.videoFailed || data.type === 'video';
        const aspect = isVideo
          ? (String(data.content || '').match(/^__video_failed__(?::([\d:]+))?$/) || [])[1] || '9:16'
          : (String(data.content || '').match(/^__selfie_failed__(?::([\d:]+))?$/) || [])[1] || '3:4';
        const ar = String(aspect).replace(':', '/');
        const label = isVideo ? '视频生成失败' : '生图失败';
        const failedHtml = `<div class="bubble-media bubble-media-failed" data-failed-${isVideo ? 'video' : 'selfie'}="1" data-aspect="${aspect}" style="aspect-ratio:${ar}" title="${errHint ? errHint.replace(/"/g, '&quot;') : label}" onclick="window.rerollFailedMediaBubble?.(this)"><span>${label}<br><small>点击重试</small></span></div>`;
        const oldMedia = main.querySelector('img.bubble-media, video.bubble-media, .bubble-media-pending, .bubble-media-failed');
        if (oldMedia) oldMedia.outerHTML = failedHtml;
        else main.insertAdjacentHTML('beforeend', failedHtml);
      } else if (!wrap) {
        syncNewMessages().catch(() => {});
      }
      if (data.videoFailed) {
        window.showToast?.(errHint ? `视频生成失败：${errHint}` : '视频生成失败，气泡仍保留可重试');
      } else {
        window.showToast?.(errHint ? `生图失败：${errHint}` : '生图失败，气泡仍保留可重试');
      }
    }
    return;
  }
  if (data.mediaRerolling) {
    // 重新生成开始：清掉旧的 ready 缓存，允许 pending 覆盖
    clearMediaReadyUpdate(id);
    upsertMediaMsgToThreadCache(cid, data);
    beginSelfiePendingWait(cid);
    // 占位态：把现有媒体换成 ···
    if (!shouldRenderForChar(cid)) return;
    const wrap = document.querySelector(`.bubble-wrap[data-id="${CSS.escape(id)}"], .bubble-wrap[data-msg-id="${CSS.escape(id)}"]`);
    if (!wrap) { syncNewMessages().catch(() => {}); return; }
    const main = wrap.querySelector('.bubble-main') || wrap;
    const isVideo = data.type === 'video';
    const aspect = isVideo
      ? (String(data.content || '').match(/^__pending_video__(?::([\d:]+))?$/) || [])[1] || '9:16'
      : (String(data.content || '').match(/^__pending_selfie__(?::([\d:]+))?$/) || [])[1] || '3:4';
    const ar = String(aspect).replace(':', '/');
    const pendingHtml = isVideo
      ? `<div class="bubble-media bubble-media-pending" data-pending-video="1" data-aspect="${aspect}" style="aspect-ratio:${ar}"><span class="bubble-media-pending-dots">·&nbsp;·&nbsp;·</span></div>`
      : `<div class="bubble-media bubble-media-pending" data-pending-selfie="1" data-aspect="${aspect}" style="aspect-ratio:${ar}"><span class="bubble-media-pending-dots">·&nbsp;·&nbsp;·</span></div>`;
    const oldMedia = main.querySelector('img.bubble-media, video.bubble-media, .bubble-media-pending, .bubble-media-failed');
    if (oldMedia) oldMedia.outerHTML = pendingHtml;
    else main.insertAdjacentHTML('beforeend', pendingHtml);
    return;
  }
  // 成功成图/成视频：先记 ready，再写缓存、刷气泡（气泡可能尚未入 DOM）
  if (data.content && !isPlaceholderMediaContent(data.content)) {
    rememberMediaReadyUpdate(data);
    clearSelfiePendingWait(true);
    upsertMediaMsgToThreadCache(cid, data);
  }
  if (!shouldRenderForChar(cid)) {
    window.refreshContactsInbox?.();
    return;
  }
  const wrap = document.querySelector(`.bubble-wrap[data-id="${CSS.escape(id)}"], .bubble-wrap[data-msg-id="${CSS.escape(id)}"]`);
  if (!wrap) {
    // 文字还在打字动画、图气泡还没 append：ready 已记入 _mediaReadyById，
    // 稍后 appendAiBubble / sync 会用就绪 URL，避免一直显示 ···
    syncNewMessages().catch(() => {});
    return;
  }
  if (applyReadyMediaToBubble(wrap, data)) {
    scrollBottom(true);
    rememberAiMsgIds([id]);
  }
};

/** 角色主动/后台推送消息：在聊天页增量追加（HTTP 与 WS 可能双通道，按 id 去重） */
window.onIncomingCallResult = function(data) {
  const cid = Number(data?.characterId);
  if (!cid || !shouldRenderForChar(cid)) return;
  const label = String(data.visible || '').trim()
    || (data.outcome === 'declined' ? '已拒绝' : data.outcome === 'missed' ? '未接通' : '');
  if (!label) return;
  const msg = data.aiMessages?.[0] || {
    id: 'inc_' + Date.now(),
    role: 'assistant',
    type: 'system',
    content: label,
    timestamp: new Date().toISOString(),
  };
  if (isHiddenChatMessage(msg)) return;
  const id = msg.id != null ? String(msg.id) : '';
  if (id && (hasSeenAiMsgId(id) || isAiMsgInDom(id))) return;
  if (id) rememberAiMsgIds([msg.id]);
  upsertThreadMessages(cid, isDream, [msg]);
  const list = document.getElementById('messages-list');
  list?.insertAdjacentHTML('beforeend', buildBubble(msg, getCharMeta(cid), {}));
  scrollBottom(true);
};

/** 角色主动挂电话：聊天页追加 system 气泡（视频通话结束 · 时长）。
  app.js 在收到 peer_end 事件时会先调 endCall() 关掉通话页，这里只画气泡。*/
window.onPeerEndCall = function(data) {
  const cid = Number(data?.characterId);
  if (!cid || !shouldRenderForChar(cid)) return;
  const msg = data?.aiMessages?.[0] || {
    id: 'peer_end_' + Date.now(),
    role: 'assistant',
    type: 'system',
    content: String(data?.visible || (data?.video ? '视频通话结束' : '语音通话结束')),
    timestamp: new Date().toISOString(),
  };
  if (isHiddenChatMessage(msg)) return;
  const id = msg.id != null ? String(msg.id) : '';
  if (id && (hasSeenAiMsgId(id) || isAiMsgInDom(id))) return;
  if (id) rememberAiMsgIds([msg.id]);
  upsertThreadMessages(cid, isDream, [msg]);
  const list = document.getElementById('messages-list');
  list?.insertAdjacentHTML('beforeend', buildBubble(msg, getCharMeta(cid), {}));
  scrollBottom(true);
};

window.onProactiveMessage = async function(data) {
  const cid = Number(data.characterId);
  if (!shouldRenderForChar(cid)) {
    const msgs = data.aiMessages?.length
      ? data.aiMessages
      : (data.content ? [{ type: 'text', content: data.content }] : []);
    if (msgs.length) {
      upsertThreadMessages(cid, isDream, msgs);
      deferAiReply(cid, msgs);
    }
    return;
  }
  showCharTyping(false);
  if (Number(cid) === Number(charId)) clearPendingUserMsgs();
  if (data.recalled?.id != null) {
    applyRecalledUiForMsg(data.recalled.id, data.recalled.content);
  }
  if (data.selfieFailed && !(data.aiMessages || []).length) {
    window.showToast?.('对方拍照好像失败了，可以再让TA拍一张');
    return;
  }
  if (data.aiMessages?.length) {
    const fresh = data.aiMessages.filter(m => {
      if (isHiddenChatMessage(m)) return false;
      const id = m.id != null ? String(m.id) : '';
      if (!id) return true;
      // HTTP 已认领或 DOM 已有 → 跳过（防双份）；漏画由 render 结束后 paintMissing / sync 补
      if (hasSeenAiMsgId(id) || isAiMsgInDom(id)) return false;
      return true;
    });
    if (!fresh.length) {
      // HTTP 可能已认领但动画中断：稍后再补，避免和打字动画抢同一条
      setTimeout(() => {
        if (shouldRenderForChar(cid)) paintMissingMessagesToDom(data.aiMessages);
      }, 1200);
      return;
    }
    rememberAiMsgIds(fresh.map(m => m.id));
    upsertThreadMessages(cid, isDream, fresh);
    playNotifySound();
    // 与手动回复一致：逐条打字，后一条按上一条阅读停留再出
    await renderAiMessageSequence(fresh, null, cid, { callMode: isInVoiceCallWith(cid) });
    // 动画中断或闸门抖动后，把仍未上屏的气泡一次性补上
    if (shouldRenderForChar(cid)) {
      paintMissingMessagesToDom(fresh);
      markVisibleUserMsgsRead(cid);
      api.markMessagesRead(cid, isDream ? 1 : 0).catch(() => {});
      markVisibleAiMsgsRead();
    } else {
      // 中途离开：整轮补一条离页通知（去重，不会和 HTTP 双弹）
      deferAiReply(cid, fresh);
    }
  } else if (data.content) {
    syncNewMessages().catch(() => {});
  }
};

window.onCharAvatarUpdated = function(cid, avatarUrl) {
  if (Number(cid) !== Number(charId)) return;
  if (currentChar) currentChar.avatar = avatarUrl;
  applyChatHeader(currentChar);
};

window.onCharStatusChange = function(data) {
  if (Number(data.characterId) !== Number(charId)) return;
  if (currentChar) currentChar.status = data.status;
  updateCharStatus(data.status);
  syncOperatingBar();
};

/** 通话会话：拨出 / 接听 / 挂断 时序 */

import * as api from '../api.js';
import {
  setNativeCallMediaAudio,
  setNativeCallOverlay,
  stopNativeCall,
} from '../app-permissions.js';
import {
  playReadyTTS,
  playTTS,
  prefetchTTS,
  stopTTS,
  unlockAudioPlayback,
  stopCallAmbient,
  stopCallBodyBeds,
  stopCallOneShot,
  getLastTtsError,
} from '../tts.js';
import { buildCallRecordHtml } from '../chat.js?v=swipe1';
import { stripAiContextLabels } from '../memory.js';
import {
  getState,
  patchState,
  resetPresenceFlags,
  isInVoiceCallWith,
  INCOMING_SPEAK_DELAY_MS,
  PRESENCE,
} from './call-state.js';
import {
  showDialingUi,
  showConnectedUi,
  startCallTimer,
  stopCallTimer,
  clearCallChatArea,
  appendCallChatMsg,
  formatCallDur,
  applyPresenceModeUi,
  syncWaveform,
} from './call-ui.js';
import {
  bindPresenceDeps,
  resetPresenceRuntime,
  setCallPresenceMode,
} from './call-presence.js';
import {
  bindMicDeps,
  setCallSpeaking,
  setCallThinking,
  armAfterSpeak,
  stopLiveListen,
  setVoiceMode,
  onHangoutSleepChange,
} from './call-mic.js';
import { stopHangoutAmbient, syncAmbientDuck } from './call-ambient.js';

let _deps = null;
let _connectBusy = false;
let _callTranscript = [];
let _playedSpeechIds = new Set();
let _mediaPrepPromise = null;

export function bindSessionDeps(deps) {
  _deps = deps || null;
  const sync = () => { try { _deps?.syncFlags?.(); } catch {} };
  bindPresenceDeps({
    doSend: (...args) => _deps?.doSend?.(...args),
    onPresenceChanged: (next) => {
      sync();
      if (next === PRESENCE.HANGOUT || next === PRESENCE.TALK || next === PRESENCE.WATCH) {
        void armAfterSpeak();
      }
      onHangoutSleepChange();
    },
    onHangoutSleepChange,
    onEnterHangout: () => onHangoutSleepChange(),
    onLeaveHangout: () => {},
    onEnterWatch: () => {},
    onLeaveWatch: () => {},
  });
  bindMicDeps({
    doSend: (...args) => _deps?.doSend?.(...args),
    isSendBusy: () => !!_deps?.isSendBusy?.(),
    setIdleStatus: () => _deps?.setIdleStatus?.(),
    syncOverlay: () => _deps?.syncOverlay?.(),
    probeAudioDuration: (blob) => _deps?.probeAudioDuration?.(blob),
    applyVoiceModeUi: (on) => _deps?.applyVoiceModeUi?.(on),
  });
  _deps._sync = sync;
}

function syncFlags() {
  try { _deps?.syncFlags?.(); } catch {}
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function charHasVoiceId(char) {
  return !!(String(char?.voice_id || '').trim() || String(char?.voice_id_nsfw || '').trim());
}

function markSpeechPlayed(msgId) {
  if (msgId == null || msgId === '') return;
  const s = String(msgId);
  if (s.startsWith('tmp_') || s.startsWith('seg_')) return;
  _playedSpeechIds.add(s);
}

function wasSpeechPlayed(msgId) {
  if (msgId == null || msgId === '') return false;
  return _playedSpeechIds.has(String(msgId));
}

export function getCallTranscript() {
  return _callTranscript;
}

export function pushTranscript(role, content) {
  const text = String(content || '').trim();
  if (!text) return;
  _callTranscript.push({ role, content: text });
  appendCallChatMsg(role, text);
}

async function answerPendingCall({ enableVoice = true } = {}) {
  const st = getState();
  if (!st.inCall) return false;
  if (!st.callDialing) {
    if (enableVoice && !st.voiceMode) setVoiceMode(true);
    return true;
  }
  if (_connectBusy) return !st.callDialing && st.inCall;
  _connectBusy = true;
  const token = st.dialingToken;
  try {
    patchState({ callDialing: false });
    syncFlags();
    showConnectedUi();
    startCallTimer();
    try { await _mediaPrepPromise; } catch {}
    if (token !== getState().dialingToken || !getState().inCall) return false;
    if (getState().inVideoCall) {
      await _deps?.startCallCamera?.({ silent: false });
      if (token !== getState().dialingToken || !getState().inCall) return false;
      await _deps?.ensureCallVideosPlaying?.();
    }
    if (token !== getState().dialingToken || !getState().inCall) return false;
    if (enableVoice) setVoiceMode(true);
    _deps?.setIdleStatus?.();
    syncWaveform();
    _deps?.syncOverlay?.();
    const chatList = document.getElementById('messages-list');
    if (chatList && !document.getElementById('call-divider-start')) {
      chatList.insertAdjacentHTML('beforeend', buildCallRecordHtml({
        kind: 'start',
        video: getState().inVideoCall,
        label: getState().inVideoCall ? '视频通话开始' : '通话开始',
      }, { htmlId: 'call-divider-start' }));
      _deps?.scrollBottom?.(true);
    }
    return true;
  } finally {
    _connectBusy = false;
  }
}

/**
 * 角色说完一段 TTS 后调用：普通模式开麦；连麦保持。
 * dialing 时：等最短振铃结束 → 接通 → 再播（由 playCallSpeech 控制）。
 */
export async function onRoleSpeechFinished() {
  await armAfterSpeak();
}

export async function playOpenerAfterAnswer(opening, readyUrl, forCharId) {
  const peer = _deps?.getCharMeta?.(forCharId) || {};
  const text = String(opening || '').trim();
  const url = String(readyUrl || '').trim();
  const canSpeak = !!(url || (text && charHasVoiceId(peer)));
  if (text) pushTranscript('assistant', text);

  const speakAfter = Date.now() + INCOMING_SPEAK_DELAY_MS;
  await _deps?.prepareMediaSettle?.();
  if (!getState().inCall) return;

  if (canSpeak) {
    const gap = speakAfter - Date.now();
    if (gap > 0) await sleepMs(gap);
    if (!getState().inCall) return;
  } else {
    await armAfterSpeak();
    return;
  }

  setCallSpeaking(true);
  void setNativeCallMediaAudio(true);
  try {
    let ok = false;
    if (url) {
      ok = await playReadyTTS(url, () => {
        setCallSpeaking(false);
        _deps?.setIdleStatus?.();
      });
    } else {
      ok = await playTTS(text, () => {
        setCallSpeaking(false);
        _deps?.setIdleStatus?.();
      }, forCharId);
    }
    setCallSpeaking(false);
    if (!ok) {
      const err = getLastTtsError() || '';
      if (err && !/自动播放|NotAllowed|interact/i.test(err)) {
        window.showToast?.('语音播放失败: ' + err);
      }
    }
  } finally {
    setCallSpeaking(false);
    _deps?.setIdleStatus?.();
  }
  await armAfterSpeak();
}

/**
 * 用户拨出：振铃 →（拒接）或 生成开场+TTS → 就绪后接通并出声。
 * 开场由 doSend('[语音/视频通话开始]') 触发；TTS 播完前不得提前接通。
 * 这里负责拨号壳；真正接通由 playCallTtsSegment / waitOpenerThenConnect 完成。
 */
export async function startCall(asVideo = false) {
  _deps?.setChatToolbarOpen?.(false);
  window.closeEmojiPanel?.();
  const currentChar = _deps?.getCurrentChar?.();
  const charId = _deps?.getCharId?.();
  if (!currentChar || !charId) return;
  if (_deps?.isDream?.()) {
    window.showToast?.('梦境中不可用');
    return;
  }
  const st0 = getState();
  if (st0.inCall) {
    if (isInVoiceCallWith(charId)) {
      window.expandCall?.();
    } else {
      window.showToast?.('请先结束当前通话');
    }
    return;
  }

  unlockAudioPlayback();
  setNativeCallMediaAudio(true);
  _deps?.bindCallChatLayout?.();
  _deps?.ensureCallPipBound?.();
  _callTranscript = [];
  _playedSpeechIds.clear();
  clearCallChatArea();

  const token = (getState().dialingToken || 0) + 1;
  patchState({
    inCall: true,
    inVideoCall: !!asVideo,
    callDialing: true,
    callCharId: Number(charId),
    callMinimized: false,
    dialingToken: token,
    dialRingUntil: 0,
  });
  syncFlags();
  resetPresenceFlags();
  applyPresenceModeUi();
  setVoiceMode(false);
  syncFlags();
  _mediaPrepPromise = _deps?.prepareCallMedia?.(asVideo) || null;
  _deps?.setMediaPrepPromise?.(_mediaPrepPromise);

  const screen = document.getElementById('call-screen');
  screen?.classList.remove('is-minimized', 'is-dragging', 'is-speaking', 'has-call-clip', 'is-cam-swapped', 'is-rear-cam');
  screen?.classList.toggle('is-video', !!asVideo);
  _deps?.clearCallPipInlinePos?.();
  screen?.classList.add('active');
  showDialingUi(currentChar);
  // 拨号手势里先把摄像头流挂上（振铃页 CSS 会藏小窗，接通后立刻有画面）
  if (asVideo) void _deps?.ensureCallVideosPlaying?.();
  const dStatus = document.getElementById('call-dialing-status');
  if (dStatus) dStatus.textContent = asVideo ? '正在视频呼叫…' : '正在呼叫…';
  _deps?.syncOverlay?.();

  const ringMs = 2200 + Math.floor(Math.random() * 2200);
  patchState({ dialRingUntil: Date.now() + ringMs });
  syncFlags();

  const willDecline = !!_deps?.shouldPeerDeclineCall?.(currentChar);
  const startLine = asVideo ? '[视频通话开始]' : '[语音通话开始]';
  let openerPromise = null;
  if (!willDecline) {
    openerPromise = (async () => {
      await sleepMs(60);
      if (token !== getState().dialingToken || !getState().callDialing || !getState().inCall) return;
      // 振铃期间生成开场；接通必须等 TTS 就绪（由 play 路径 answerPendingCall）
      await _deps?.doSend?.(startLine, 'system', {}, false, getState().callCharId);
    })();
  }

  await sleepMs(ringMs);
  if (token !== getState().dialingToken || !getState().callDialing || !getState().inCall) {
    _deps?.invalidateCallMediaPrep?.();
    patchState({ dialRingUntil: 0 });
    return;
  }

  const peerId = getState().callCharId;
  const peerName = currentChar?.name || '对方';
  if (willDecline) {
    patchState({ dialRingUntil: 0 });
    const hangStatus = document.getElementById('call-dialing-status');
    if (hangStatus) hangStatus.textContent = '对方已挂断';
    await sleepMs(900);
    if (token !== getState().dialingToken) return;
    const wasVideo = getState().inVideoCall;
    patchState({
      callDialing: false,
      inCall: false,
      inVideoCall: false,
      callCharId: null,
      callMinimized: false,
    });
    _deps?.invalidateCallMediaPrep?.();
    setVoiceMode(false);
    _deps?.stopCallCamera?.();
    stopNativeCall();
    setNativeCallMediaAudio(false);
    _deps?.syncOverlay?.();
    screen?.classList.remove('active', 'is-dialing', 'is-minimized', 'is-speaking', 'is-video');
    _deps?.clearCallPipInlinePos?.();
    window.showToast?.('对方未接听');
    await _deps?.afterCallDeclined?.(peerId, peerName, wasVideo);
    return;
  }

  if (token !== getState().dialingToken || !getState().inCall || !getState().callDialing) {
    _deps?.invalidateCallMediaPrep?.();
    patchState({ dialRingUntil: 0 });
    return;
  }

  const dStatus2 = document.getElementById('call-dialing-status');
  if (dStatus2 && getState().callDialing) dStatus2.textContent = '正在接通…';

  // 等开场 AI+TTS：playCallTtsSegment 会在语音就绪后 answerPendingCall
  if (openerPromise) {
    try { await openerPromise; } catch {}
  }
  if (token !== getState().dialingToken || !getState().inCall) {
    patchState({ dialRingUntil: 0 });
    return;
  }

  // 兜底：若开场无声/失败仍卡在拨号，再接通（但已尽量等 opener 完成）
  if (getState().callDialing) {
    await answerPendingCall({ enableVoice: true });
    patchState({ dialRingUntil: 0 });
  } else if (!getState().voiceMode) {
    setVoiceMode(true);
  }
  if (token !== getState().dialingToken || !getState().inCall) return;
  _deps?.syncCallVideoTextModeUi?.();
  if (getState().inVideoCall) void _deps?.queueCallLookForNextRound?.();
  if (getState().inCall && !getState().callDialing) await armAfterSpeak();
}

export async function acceptProactiveCall(call) {
  const cid = Number(call?.characterId);
  if (!cid) return;
  if (getState().inCall) {
    window.showToast?.('请先结束当前通话');
    return;
  }
  const peer = _deps?.getCharMeta?.(cid) || {};
  const peerName = call.charName || peer?.name || 'TA';
  const peerAvatar = call.charAvatar || peer?.avatar || '';
  // 来电开场再剥一次心里话草稿，避免念出 [怎么看]/[什么感觉]
  const opening = stripAiContextLabels(String(call?.content || '')).replace(/\s+/g, ' ').trim();
  call = { ...call, content: opening };

  unlockAudioPlayback();
  void setNativeCallMediaAudio(true);
  _deps?.bindCallChatLayout?.();
  _deps?.ensureCallPipBound?.();
  _callTranscript = [];
  _playedSpeechIds.clear();
  clearCallChatArea();

  patchState({
    inCall: true,
    inVideoCall: !!call.video,
    callDialing: false,
    callCharId: cid,
    callMinimized: false,
  });
  syncFlags();
  resetPresenceRuntime();
  applyPresenceModeUi();
  setVoiceMode(false);
  syncFlags();

  const answerCamOff = !!(call.video && call.camOff);
  if (call.video && !answerCamOff && call.camStream) {
    _deps?.adoptIncomingCamStream?.(call.camStream, call.camFacing);
  } else if (call.camStream) {
    try { call.camStream.getTracks?.().forEach((t) => t.stop()); } catch {}
  }

  const mediaPrep = _deps?.prepareCallMedia?.(!!call.video && !answerCamOff);
  _deps?.setMediaPrepPromise?.(mediaPrep);

  const screen = document.getElementById('call-screen');
  screen?.classList.remove('is-minimized', 'is-dragging', 'is-speaking', 'is-dialing', 'is-cam-swapped', 'is-rear-cam');
  screen?.classList.toggle('is-video', !!call.video);
  screen?.classList.toggle('is-cam-off', !!answerCamOff);
  _deps?.clearCallPipInlinePos?.();
  screen?.classList.add('active');
  showConnectedUi();
  startCallTimer();

  const avatarEl = document.getElementById('call-avatar');
  const nameEl = document.getElementById('call-name');
  if (avatarEl) avatarEl.src = peerAvatar;
  if (nameEl) nameEl.textContent = peerName;

  // 接听手势里立刻挂自己的摄像头小窗（微信式 PIP），别等开场白播完
  if (call.video && !answerCamOff) {
    void _deps?.ensureCallVideosPlaying?.();
  }

  if (useNative()) {
    await Promise.race([Promise.resolve(mediaPrep), sleepMs(480)]);
  } else {
    await mediaPrep;
  }
  if (!getState().inCall) return;

  const chatList = document.getElementById('messages-list');
  if (chatList && !document.getElementById('call-divider-start')) {
    chatList.insertAdjacentHTML('beforeend', buildCallRecordHtml({
      kind: 'start',
      video: getState().inVideoCall,
      label: getState().inVideoCall ? '视频通话开始' : '通话开始',
    }, { htmlId: 'call-divider-start' }));
    _deps?.scrollBottom?.(true);
  }

  setVoiceMode(true);
  await playOpenerAfterAnswer(call.content, call.readyTtsUrl, cid);
  if (!getState().inCall) return;
  if (getState().inVideoCall) {
    await _deps?.startCallCamera?.({ silent: true, camOff: answerCamOff });
    await _deps?.ensureCallVideosPlaying?.();
    _deps?.syncCallVideoTextModeUi?.();
    void _deps?.queueCallLookForNextRound?.();
  }
}

function useNative() {
  return !!_deps?.useNativeCallAudio?.();
}

export function cancelDialingCall() {
  if (!getState().callDialing) return;
  const token = (getState().dialingToken || 0) + 1;
  const peerId = getState().callCharId;
  const wasVideo = getState().inVideoCall;
  patchState({
    dialingToken: token,
    dialRingUntil: 0,
    callDialing: false,
    inCall: false,
    inVideoCall: false,
    callCharId: null,
    callMinimized: false,
  });
  syncFlags();
  _deps?.invalidateCallMediaPrep?.();
  _mediaPrepPromise = null;
  stopNativeCall();
  resetPresenceRuntime();
  setVoiceMode(false);
  _deps?.stopCallCamera?.();
  setNativeCallMediaAudio(false);
  void setNativeCallOverlay({ on: false });
  const screen = document.getElementById('call-screen');
  screen?.classList.remove('active', 'is-dialing', 'is-minimized', 'is-speaking', 'is-video');
  _deps?.clearCallPipInlinePos?.();
  if (peerId && _deps?.shouldRenderForChar?.(peerId)) {
    const list = document.getElementById('messages-list');
    list?.insertAdjacentHTML('beforeend', buildCallRecordHtml({
      kind: 'cancel', video: wasVideo, label: '已取消呼叫',
    }));
    _deps?.scrollBottom?.(true);
  }
}

export async function endCall(opts = {}) {
  if (getState().callDialing) {
    cancelDialingCall();
    return;
  }
  const skipSystemTip = !!opts.skipSystemTip;
  const endedCallCharId = getState().callCharId;
  const wasMinimized = getState().callMinimized;
  const wasVideo = getState().inVideoCall;
  const startTime = getState().callStartTime;

  patchState({
    inCall: false,
    inVideoCall: false,
    callDialing: false,
    callMinimized: false,
    callCharId: null,
  });
  syncFlags();
  setCallSpeaking(false);
  setCallThinking(false);
  stopTTS();
  stopCallAmbient();
  stopCallBodyBeds();
  stopHangoutAmbient();
  stopCallOneShot();
  resetPresenceRuntime();
  stopLiveListen();
  setVoiceMode(false);
  _deps?.stopCallCamera?.();
  _mediaPrepPromise = null;
  stopNativeCall();
  setNativeCallMediaAudio(false);
  try { await setNativeCallOverlay({ on: false }); } catch { _deps?.syncOverlay?.(); }

  stopCallTimer();
  const durationSec = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  patchState({ callStartTime: null });
  const durStr = formatCallDur(durationSec);
  const screen = document.getElementById('call-screen');

  if (wasMinimized) {
    screen?.classList.remove('active', 'is-minimized', 'is-dragging', 'is-speaking', 'is-dialing', 'is-video');
    _deps?.clearCallPipInlinePos?.();
    window.showToast?.(`${wasVideo ? '视频通话' : '通话'}结束 · ${durStr}`);
  } else {
    screen?.classList.remove('active', 'is-speaking', 'is-dialing', 'is-video');
  }

  if (endedCallCharId) {
    try {
      await api.saveCallLog({
        characterId: endedCallCharId,
        duration: durationSec,
        video: wasVideo,
        outcome: 'ended',
      });
    } catch {}
    if (!skipSystemTip && _deps?.shouldRenderForChar?.(endedCallCharId)) {
      const list = document.getElementById('messages-list');
      list?.insertAdjacentHTML('beforeend', buildCallRecordHtml({
        kind: 'end',
        video: wasVideo,
        label: wasVideo ? `视频通话结束 · ${durStr}` : `通话结束 · ${durStr}`,
        duration: durationSec,
      }));
      _deps?.scrollBottom?.(true);
    }
    if (!skipSystemTip) {
      try {
        await _deps?.doSend?.(
          wasVideo ? `[视频通话结束 · ${durStr}]` : `[通话结束 · ${durStr}]`,
          'system',
          { hideChat: true },
          false,
          endedCallCharId,
        );
      } catch {}
    }
  }
}

/**
 * 供 chat-page playCallTtsSegment 使用：拨号中等振铃结束并接通（语音已就绪）。
 */
export async function connectWhenOpenerReady() {
  const st = getState();
  if (!st.callDialing) return true;
  const ringLeft = st.dialRingUntil - Date.now();
  if (ringLeft > 0) {
    await sleepMs(ringLeft);
    if (!getState().inCall || !getState().callDialing) return false;
  }
  const dSt = document.getElementById('call-dialing-status');
  if (dSt) dSt.textContent = '正在接通…';
  const answered = await answerPendingCall({ enableVoice: false });
  patchState({ dialRingUntil: 0 });
  return answered;
}

export {
  answerPendingCall,
  setCallPresenceMode,
  setCallSpeaking,
  setCallThinking,
  armAfterSpeak,
  setVoiceMode,
  markSpeechPlayed,
  wasSpeechPlayed,
  charHasVoiceId,
};

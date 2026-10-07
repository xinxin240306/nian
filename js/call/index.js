/** 通话引擎入口：挂到 window，供 HTML / app.js 调用 */

import {
  getState,
  patchState,
  callExtras,
  isInVoiceCallWith,
  isHangoutSleeping,
  PRESENCE,
} from './call-state.js';
import {
  bindSessionDeps,
  startCall,
  acceptProactiveCall,
  endCall,
  cancelDialingCall,
  answerPendingCall,
  connectWhenOpenerReady,
  onRoleSpeechFinished,
  setCallPresenceMode,
  setCallSpeaking,
  setCallThinking,
  armAfterSpeak,
  setVoiceMode,
  markSpeechPlayed,
  wasSpeechPlayed,
  getCallTranscript,
  pushTranscript,
  playOpenerAfterAnswer,
} from './call-session.js';
import { stopLiveListen, isMicBusy, onHangoutSleepChange, reviveAfterForeground } from './call-mic.js';
import { noteUserSpeechForSleep } from './call-presence.js';
import { syncAmbientDuck } from './call-ambient.js';
import { applyPresenceModeUi, syncWaveform } from './call-ui.js';

let _installed = false;
let _pullFlags = null;

export function installCallEngine(deps) {
  bindSessionDeps(deps);
  _pullFlags = typeof deps.pullFlags === 'function' ? deps.pullFlags : null;

  const wrap = (fn) => async (...args) => {
    const ret = await fn(...args);
    _pullFlags?.();
    return ret;
  };

  window.startCall = wrap(startCall);
  window.startVideoCall = () => window.startCall(true);
  window.acceptProactiveCall = wrap(acceptProactiveCall);
  window.endCall = wrap(endCall);
  window.cancelDialingCall = wrap(cancelDialingCall);
  window.setCallPresenceMode = (mode) => {
    setCallPresenceMode(mode);
    _pullFlags?.();
  };
  window.toggleCallVoiceMode = () => {
    const next = !getState().voiceMode;
    setVoiceMode(next);
    deps.applyVoiceModeUi?.(next);
    _pullFlags?.();
  };

  _installed = true;
  return {
    getState,
    patchState,
    callExtras,
    isInVoiceCallWith,
    isHangoutSleeping,
    connectWhenOpenerReady,
    onRoleSpeechFinished,
    answerPendingCall,
    setCallSpeaking,
    setCallThinking,
    armAfterSpeak,
    reviveAfterForeground,
    setVoiceMode,
    markSpeechPlayed,
    wasSpeechPlayed,
    getCallTranscript,
    pushTranscript,
    playOpenerAfterAnswer,
    stopLiveListen,
    isMicBusy,
    noteUserSpeechForSleep,
    onHangoutSleepChange,
    syncAmbientDuck,
    applyPresenceModeUi,
    syncWaveform,
    PRESENCE,
  };
}

export function isCallEngineInstalled() {
  return _installed;
}

export {
  getState,
  patchState,
  callExtras,
  isInVoiceCallWith,
  isHangoutSleeping,
  connectWhenOpenerReady,
  onRoleSpeechFinished,
  answerPendingCall,
  setCallSpeaking,
  setCallThinking,
  armAfterSpeak,
  reviveAfterForeground,
  setVoiceMode,
  markSpeechPlayed,
  wasSpeechPlayed,
  getCallTranscript,
  pushTranscript,
  noteUserSpeechForSleep,
  onHangoutSleepChange,
  setCallPresenceMode,
  syncAmbientDuck,
  PRESENCE,
};

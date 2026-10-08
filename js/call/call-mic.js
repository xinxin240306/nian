/** 通话收音状态机：普通 / 连麦 / 观影 */

import * as api from '../api.js';
import { encodeUserVoiceContent } from '../chat.js?v=swipe1';
import {
  startNativeCall,
  stopNativeCall,
  setNativeCallListen,
  setNativeAmbientSampleInterval,
  ackNativeAmbientSample,
  beginNativeCallUtterance,
  abortNativeCallUtterance,
  commitNativeCallUtterance,
  nativeCallRms,
  nativeCallLevelAge,
  pullNativeCallRms,
  noteNativeCallListenTick,
  hasNativeCallAudio,
} from '../app-permissions.js';
import {
  getState,
  patchState,
  MIC,
  PRESENCE,
  USER_SILENCE_MS,
  HANGOUT_SAMPLE_MIN_MS,
  HANGOUT_SAMPLE_MAX_MS,
  HANGOUT_SLEEP_SAMPLE_MIN_MS,
  HANGOUT_SLEEP_SAMPLE_MAX_MS,
  CALL_UTTER_MIN_MS,
  CALL_UTTER_MAX_MS,
  isHangout,
  isHangoutSleeping,
  randomBetween,
} from './call-state.js';
import { syncWaveform, updateHoldTalkUi } from './call-ui.js';
import { syncAmbientDuck } from './call-ambient.js';
import { noteUserSpeechForSleep, noteUserQuietAsleep } from './call-presence.js';

let _deps = null;
let _liveOn = false;
let _liveNative = false;
let _liveToken = 0;
let _liveStream = null;
let _liveCtx = null;
let _liveAnalyser = null;
let _liveSource = null;
let _liveTimer = 0;
let _liveRec = null;
let _liveChunks = [];
let _liveUtterStart = 0;
let _liveSilentAt = 0;
let _liveLoudTicks = 0;
let _liveNoise = 0.012;
let _liveCommitting = false;
let _liveHeardSpeech = false;
let _liveArmedAt = 0;
let _sampleTimer = 0;
let _voiceSending = false;
let _listenNoteAt = 0;

const SPEECH_TICKS = 2;
const TICK_MS = 60;
const MIN_RMS_TALK = 0.016;
const MIN_RMS_HANGOUT = 0.0028;

export function bindMicDeps(deps) {
  _deps = deps || null;
  bindForegroundHooks();
}

function refreshUi() {
  updateHoldTalkUi({
    committing: _liveCommitting,
    recording: !!_liveRec,
    heardSpeech: _liveHeardSpeech,
    silentAt: _liveSilentAt,
  });
  syncWaveform();
  _deps?.syncOverlay?.();
}

function setMicPhase(phase) {
  patchState({ micPhase: phase });
  refreshUi();
}

export function setCallSpeaking(on) {
  const speaking = !!on;
  patchState({ speaking });
  if (speaking) {
    setMicPhase(MIC.SPEAKING);
    // 普通模式：角色说话时停麦采集（连麦保持 ambient）
    // 锁屏/切走时不要关 listen，否则 TTS 播完前端回调冻住，用户说话进不来
    if (!pageInBackground() && !isHangout() && getState().presenceMode !== PRESENCE.WATCH) {
      abortUtterance();
      void setNativeCallListen(false).catch(() => {});
    } else {
      void applyListenMode();
    }
  } else if (getState().thinking) {
    setMicPhase(MIC.THINKING);
  } else {
    setMicPhase(getState().voiceMode ? MIC.LISTENING : MIC.IDLE);
    if (getState().voiceMode) void applyListenMode();
  }
  syncAmbientDuck();
  refreshUi();
}

export function setCallThinking(on) {
  const thinking = !!on;
  patchState({ thinking });
  if (thinking) {
    if (!getState().speaking) setMicPhase(MIC.THINKING);
    // 普通：思考时不收音
    if (getState().presenceMode === PRESENCE.TALK) {
      abortUtterance();
      void setNativeCallListen(false).catch(() => {});
    }
  } else if (!getState().speaking) {
    setMicPhase(getState().voiceMode ? MIC.LISTENING : MIC.IDLE);
    if (getState().voiceMode) void armAfterSpeak();
  }
  refreshUi();
}

async function applyListenMode() {
  const st = getState();
  if (!_liveNative || !_liveOn || !st.inCall || st.callDialing) return;
  const hangoutOrWatch = st.presenceMode === PRESENCE.HANGOUT || st.presenceMode === PRESENCE.WATCH;
  const bg = pageInBackground();
  const allow = hangoutOrWatch || bg
    ? !!st.voiceMode
    : (!!st.voiceMode && !st.speaking && !st.thinking);
  if (!allow) {
    try { await setNativeCallListen(false); } catch {}
    return;
  }
  try {
    // 连麦「环境音」= 角色侧垫音（playHangoutBed），不是开环境麦。
    // ambient:true 会关软件 AEC/NS、改用 UNPROCESSED，和耳机降噪无关，这里一律关掉。
    await setNativeCallListen(true, {
      ambient: false,
      bargeIn: false,
    });
  } catch {}
}

function abortUtterance() {
  const rec = _liveRec;
  _liveRec = null;
  _liveChunks = [];
  _liveUtterStart = 0;
  _liveSilentAt = 0;
  _liveLoudTicks = 0;
  if (rec?.native) {
    abortNativeCallUtterance();
    refreshUi();
    return;
  }
  if (rec && rec.state !== 'inactive') {
    try { rec.ondataavailable = null; rec.onstop = null; rec.stop(); } catch {}
  }
  refreshUi();
}

function wavPcmRms(blob) {
  if (!blob || blob.size < 48) return Promise.resolve(0);
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

function pickVoiceMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const t of types) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) return t;
    } catch {}
  }
  return '';
}

function liveRms() {
  if (_liveNative) return nativeCallRms();
  if (!_liveAnalyser) return 0;
  const buf = new Uint8Array(_liveAnalyser.fftSize);
  _liveAnalyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

function minRms() {
  return isHangout() ? MIN_RMS_HANGOUT : MIN_RMS_TALK;
}

async function beginUtterance() {
  if (_liveRec || _liveCommitting) return;
  const st = getState();
  // 普通模式：思考/说话中禁止开始录音
  if (st.presenceMode === PRESENCE.TALK && (st.speaking || st.thinking)) return;

  if (_liveNative) {
    await beginNativeCallUtterance();
    _liveRec = { native: true, state: 'recording', mimeType: 'audio/wav' };
    _liveUtterStart = Date.now();
    _liveSilentAt = 0;
    refreshUi();
    return;
  }
  if (!_liveStream) return;
  const mime = pickVoiceMimeType();
  _liveChunks = [];
  let rec;
  try {
    rec = new MediaRecorder(_liveStream, mime
      ? { mimeType: mime, audioBitsPerSecond: 128000 }
      : { audioBitsPerSecond: 128000 });
  } catch {
    rec = mime ? new MediaRecorder(_liveStream, { mimeType: mime }) : new MediaRecorder(_liveStream);
  }
  rec.ondataavailable = (ev) => {
    if (ev.data?.size > 0) _liveChunks.push(ev.data);
  };
  try { rec.start(200); } catch { rec.start(); }
  _liveRec = rec;
  _liveUtterStart = Date.now();
  _liveSilentAt = 0;
  refreshUi();
}

function rejectClip() {
  _liveCommitting = false;
  _liveHeardSpeech = false;
  if (!getState().speaking && !getState().thinking) _liveArmedAt = Date.now();
  refreshUi();
}

async function commitUtterance({ periodic = false } = {}) {
  if (_liveCommitting || !_liveRec) return;
  const rec = _liveRec;
  const startedAt = _liveUtterStart;
  _liveRec = null;
  _liveUtterStart = 0;
  _liveSilentAt = 0;
  _liveCommitting = true;
  setMicPhase(MIC.THINKING);
  patchState({ thinking: true });
  refreshUi();

  const finish = () => {
    _voiceSending = false;
    _liveCommitting = false;
    _liveHeardSpeech = false;
    patchState({ thinking: false });
    if (!getState().speaking) setMicPhase(getState().voiceMode ? MIC.LISTENING : MIC.IDLE);
    refreshUi();
    _deps?.setIdleStatus?.();
  };

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
    // 耳机 SCO 经通话降噪后上行偏小，略放宽；有足够时长+体积时不再因 RMS 单独丢掉
    const rmsFloor = minRms() * 0.55;
    const tooQuiet = blob && /wav/i.test(mimeType)
      && energy < rmsFloor
      && !(wallSec >= 1.0 && blob.size >= 1600);
    const tooShort = wallSec < CALL_UTTER_MIN_MS / 1000 || !blob || blob.size < 400 || tooQuiet;
    if (tooShort) {
      console.warn('[call] reject clip', { wallSec, size: blob?.size || 0, energy, tooQuiet });
      rejectClip();
      patchState({ thinking: false });
      if (!getState().speaking) setMicPhase(getState().voiceMode ? MIC.LISTENING : MIC.IDLE);
      // 明显说了一句却被丢掉时提示，避免「停顿后发送」然后没反应
      if (wallSec >= 1.2 && getState().inCall && !periodic) {
        window.showToast?.('刚才的声音太短或太轻，没发出去，再说一次吧');
      }
      void armAfterSpeak({ force: true });
      return;
    }
    try {
      while ((_deps?.isSendBusy?.() || _voiceSending) && getState().inCall) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!getState().inCall || !getState().callCharId) { finish(); return; }
      const durationSec = Math.max(1, Math.round(wallSec) || 1);
      const file = new File([blob], `call-live-${Date.now()}.wav`, { type: mimeType });
      _voiceSending = true;
      const uploaded = await api.uploadChatVoice(file, durationSec);
      if (!uploaded?.url) throw new Error('上传未返回地址');
      const content = encodeUserVoiceContent({
        url: uploaded.url,
        duration: uploaded.duration || durationSec,
        voiceprint: uploaded.voiceprint || null,
        transcript: periodic ? '[连麦环境收音]' : undefined,
      });
      noteUserSpeechForSleep(periodic ? '' : '说话');
      await _deps?.doSend?.(content, 'voice', { duration: uploaded.duration || durationSec }, false, getState().callCharId);
      if (!periodic) setUserAwakeFromSpeech();
    } catch (err) {
      if (getState().inCall) window.showToast?.('语音发送失败: ' + (err?.message || '网络错误'));
    } finally {
      finish();
    }
    return;
  }

  const mimeType = rec.mimeType || pickVoiceMimeType() || 'audio/webm';
  const blob = await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(new Blob(_liveChunks, { type: mimeType }));
    };
    rec.onstop = done;
    try {
      if (typeof rec.requestData === 'function' && rec.state === 'recording') {
        try { rec.requestData(); } catch {}
      }
      if (rec.state !== 'inactive') rec.stop();
      else done();
    } catch { done(); }
    setTimeout(done, 1500);
  });
  const chunks = _liveChunks;
  _liveChunks = [];
  const wallSec = Math.max(0, (Date.now() - startedAt) / 1000);
  if (wallSec < CALL_UTTER_MIN_MS / 1000 || blob.size < 400 || !chunks.length) {
    rejectClip();
    patchState({ thinking: false });
    if (!getState().speaking) setMicPhase(getState().voiceMode ? MIC.LISTENING : MIC.IDLE);
    return;
  }
  try {
    while ((_deps?.isSendBusy?.() || _voiceSending) && getState().inCall) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!getState().inCall || !getState().callCharId) { finish(); return; }
    let durationSec = Math.max(1, Math.round(wallSec) || 1);
    try {
      const probed = await _deps?.probeAudioDuration?.(blob);
      if (probed > 0.4) durationSec = Math.max(1, Math.round(probed));
    } catch {}
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
    await _deps?.doSend?.(content, 'voice', { duration: uploaded.duration || durationSec }, false, getState().callCharId);
    if (!periodic) setUserAwakeFromSpeech();
  } catch (err) {
    if (getState().inCall) window.showToast?.('语音发送失败: ' + (err?.message || '网络错误'));
  } finally {
    finish();
  }
}

function setUserAwakeFromSpeech() {
  noteUserSpeechForSleep('说话');
}

function pageInBackground() {
  return !!(window._nianAppBackground || (typeof document !== 'undefined' && document.hidden));
}

function tick() {
  if (!_liveOn) return;
  if (!_liveNative && !_liveAnalyser) return;
  // 锁屏/切走后把收句交给原生：再打卡会让原生以为页面 VAD 还活着，反而把后台那句掐掉
  if (pageInBackground()) return;
  maybeNoteNative();
  if (_liveNative && nativeCallLevelAge() > 250) void pullNativeCallRms();

  const st = getState();
  if (_liveCommitting || st.callDialing || !st.inCall) {
    refreshUi();
    return;
  }

  // 普通：思考/说话中完全不收音
  if (st.presenceMode === PRESENCE.TALK && (st.speaking || st.thinking)) {
    if (_liveRec) abortUtterance();
    refreshUi();
    return;
  }

  if (!st.voiceMode) {
    refreshUi();
    return;
  }

  const rms = liveRms();
  const hangout = isHangout();
  const noiseCap = hangout ? 0.012 : 0.028;
  if (!_liveHeardSpeech && !st.speaking) {
    _liveNoise = Math.min(noiseCap, _liveNoise * 0.96 + rms * 0.04);
  }
  const speechTh = hangout
    ? Math.max(0.006, _liveNoise * 1.7)
    : Math.max(0.018, _liveNoise * 3.0);
  const silenceTh = hangout
    ? Math.max(0.004, _liveNoise * 1.25)
    : Math.max(0.012, _liveNoise * 2.0);

  if (rms >= speechTh) {
    _liveLoudTicks += 1;
    _liveSilentAt = 0;
    if (_liveLoudTicks >= SPEECH_TICKS) {
      _liveHeardSpeech = true;
      if (!_liveRec) void beginUtterance();
    }
  } else {
    _liveLoudTicks = 0;
    if (_liveRec && _liveHeardSpeech) {
      if (rms < silenceTh) {
        if (!_liveSilentAt) _liveSilentAt = Date.now();
        const silentMs = Date.now() - _liveSilentAt;
        const elapsed = Date.now() - _liveUtterStart;
        if (silentMs >= USER_SILENCE_MS || elapsed >= CALL_UTTER_MAX_MS) {
          void commitUtterance();
        }
      } else {
        _liveSilentAt = 0;
      }
    }
  }
  refreshUi();
}

function maybeNoteNative() {
  if (!_liveNative || !getState().inCall || getState().callDialing) return;
  const now = Date.now();
  if (now - _listenNoteAt < 500) return;
  _listenNoteAt = now;
  void noteNativeCallListenTick({
    silenceMs: USER_SILENCE_MS,
    maxMs: CALL_UTTER_MAX_MS,
    speechRms: isHangout() ? 0.008 : 0.02,
  });
}

function stopSampleTimer() {
  if (_sampleTimer) {
    clearTimeout(_sampleTimer);
    _sampleTimer = 0;
  }
}

function schedulePeriodicSample() {
  stopSampleTimer();
  if (!isHangout() || !getState().voiceMode) {
    void setNativeAmbientSampleInterval(0);
    return;
  }
  const sleeping = isHangoutSleeping();
  const delay = sleeping
    ? randomBetween(HANGOUT_SLEEP_SAMPLE_MIN_MS, HANGOUT_SLEEP_SAMPLE_MAX_MS)
    : randomBetween(HANGOUT_SAMPLE_MIN_MS, HANGOUT_SAMPLE_MAX_MS);
  // 原生墙钟扛锁屏；JS setTimeout 只作无原生/前台备份
  if (_liveNative || hasNativeCallAudio()) {
    void setNativeAmbientSampleInterval(delay);
    return;
  }
  _sampleTimer = setTimeout(async () => {
    _sampleTimer = 0;
    if (!isHangout() || !getState().inCall) return;
    await runPeriodicSample();
    schedulePeriodicSample();
  }, delay);
}

async function runPeriodicSample() {
  const st = getState();
  if (!isHangout() || !st.voiceMode || _liveCommitting) return;
  // 锁屏后 TTS 结束回调常冻在 speaking=true，会永久挡住周期采样——后台时强制清掉
  if (st.speaking) {
    if (!pageInBackground()) return;
    patchState({ speaking: false, thinking: false });
    try { document.getElementById('call-screen')?.classList.remove('is-speaking'); } catch {}
  }
  // 若用户正在说话，交给 5s 静音提交，不强制打断
  if (_liveRec && _liveHeardSpeech) return;
  abortUtterance();
  await beginUtterance();
  // 短采 2.5s 环境/动静
  await new Promise((r) => setTimeout(r, 2500));
  if (!isHangout() || !_liveRec) return;
  await commitUtterance({ periodic: true });
}

export function onHangoutSleepChange() {
  schedulePeriodicSample();
}

export async function armAfterSpeak(opts = {}) {
  const force = !!opts.force;
  const st = getState();
  if (!st.inCall || st.callDialing || !st.voiceMode) {
    refreshUi();
    return;
  }
  if (force) {
    // 锁屏/切屏后 TTS 结束回调可能卡在 speaking=true，强制清掉才能重开麦
    patchState({ speaking: false, thinking: false });
    try { document.getElementById('call-screen')?.classList.remove('is-speaking'); } catch {}
    try { _deps?.setIdleStatus?.(); } catch {}
  }
  if (!_liveOn) await startLiveListen();
  if (!getState().inCall || getState().callDialing || !getState().voiceMode) return;
  if (!force && getState().speaking) return;

  abortUtterance();
  _liveHeardSpeech = false;
  _liveArmedAt = Date.now();
  setMicPhase(MIC.LISTENING);
  await applyListenMode();
  syncAmbientDuck();
  refreshUi();
}

/** 亮屏/回前台：清掉卡住的 speaking，重新开麦 */
export async function reviveAfterForeground() {
  const st = getState();
  if (!st.inCall || st.callDialing || !st.voiceMode) return;
  _liveCommitting = false;
  _voiceSending = false;
  if (hasNativeCallAudio()) {
    try {
      await startNativeCall();
      _liveNative = true;
      _liveOn = true;
    } catch (e) {
      console.warn('[call] revive native', e?.message || e);
    }
  }
  await armAfterSpeak({ force: true });
}

async function ingestNativeUtterance(b64, wallMs, opts = {}) {
  const periodic = !!(opts && (opts.periodic === true || opts === true));
  const st = getState();
  if (!st.inCall || st.callDialing || !st.callCharId) return;
  if (_liveCommitting || _voiceSending) return;
  patchState({ speaking: false, thinking: false });
  try { document.getElementById('call-screen')?.classList.remove('is-speaking'); } catch {}
  abortUtterance();
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
  // 周期环境采样：夜里再静也要发出去（静本身也是环境信息）
  if (periodic) {
    if (wallSec < 1.2 || blob.size < 400) {
      void ackNativeAmbientSample();
      void armAfterSpeak({ force: true });
      return;
    }
    void ackNativeAmbientSample();
  } else if (energy < minRms() || wallSec < CALL_UTTER_MIN_MS / 1000 || blob.size < 400) {
    void armAfterSpeak({ force: true });
    return;
  }

  _liveCommitting = true;
  setMicPhase(MIC.THINKING);
  patchState({ thinking: true });
  refreshUi();
  const finish = () => {
    _voiceSending = false;
    _liveCommitting = false;
    _liveHeardSpeech = false;
    patchState({ thinking: false });
    if (!getState().speaking) setMicPhase(getState().voiceMode ? MIC.LISTENING : MIC.IDLE);
    refreshUi();
    _deps?.setIdleStatus?.();
    void armAfterSpeak({ force: true });
  };
  try {
    while ((_deps?.isSendBusy?.() || _voiceSending) && getState().inCall) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!getState().inCall || !getState().callCharId) { finish(); return; }
    const durationSec = Math.max(1, Math.round(wallSec) || 1);
    const file = new File([blob], `call-live-${Date.now()}.wav`, { type: 'audio/wav' });
    _voiceSending = true;
    const uploaded = await api.uploadChatVoice(file, durationSec);
    if (!uploaded?.url) throw new Error('上传未返回地址');
    const content = encodeUserVoiceContent({
      url: uploaded.url,
      duration: uploaded.duration || durationSec,
      voiceprint: uploaded.voiceprint || null,
      transcript: periodic ? '[连麦环境收音]' : undefined,
    });
    if (!periodic) noteUserSpeechForSleep('说话');
    await _deps?.doSend?.(content, 'voice', { duration: uploaded.duration || durationSec }, false, getState().callCharId);
    if (!periodic) setUserAwakeFromSpeech();
  } catch (err) {
    if (getState().inCall) window.showToast?.('语音发送失败: ' + (err?.message || '网络错误'));
  } finally {
    finish();
  }
}

function bindForegroundHooks() {
  if (typeof window === 'undefined' || window.__nianCallEngineVis) return;
  window.__nianCallEngineVis = true;
  document.addEventListener('visibilitychange', () => {
    if (!getState().inCall || !getState().voiceMode) return;
    if (document.visibilityState === 'visible') void reviveAfterForeground();
    // 切走时不要关 listen：后台收音全靠原生麦
  });
  try {
    window.Capacitor?.Plugins?.App?.addListener?.('appStateChange', ({ isActive }) => {
      if (!getState().inCall || !getState().voiceMode) return;
      if (isActive) void reviveAfterForeground();
    });
  } catch {}
  // 原生播完 TTS 且页面冻住时会注入：清 speaking 并重开麦
  window.__nianCallPlayIdle = () => {
    if (!getState().inCall || getState().callDialing) return;
    patchState({ speaking: false, thinking: false });
    try { document.getElementById('call-screen')?.classList.remove('is-speaking'); } catch {}
    try { _deps?.setIdleStatus?.(); } catch {}
    if (getState().voiceMode) void applyListenMode();
    refreshUi();
  };
  // 给 chat-page 遗留 handler 分流；原生也直接调 __nianIngestNativeUtterance
  window.__nianCallMicIngest = (b64, wallMs, opts) => {
    void ingestNativeUtterance(b64, wallMs, opts);
  };
  window.__nianIngestNativeUtterance = window.__nianCallMicIngest;
  window.__nianAmbientSampleAck = () => {
    void ackNativeAmbientSample();
  };
}

export async function startLiveListen() {
  const st = getState();
  if (!st.inCall || st.callDialing || !st.voiceMode) return;
  const token = ++_liveToken;
  _liveOn = true;
  bindForegroundHooks();

  if (hasNativeCallAudio()) {
    try {
      await startNativeCall();
      if (token !== _liveToken) return;
      _liveNative = true;
      await applyListenMode();
      if (!_liveTimer) _liveTimer = setInterval(tick, TICK_MS);
      setMicPhase(MIC.LISTENING);
      refreshUi();
      if (isHangout()) schedulePeriodicSample();
      return;
    } catch (e) {
      console.warn('[call] native listen', e?.message || e);
    }
  }

  _liveNative = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (token !== _liveToken || !getState().inCall || !getState().voiceMode) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    _liveStream = stream;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    _liveCtx = new Ctx();
    _liveAnalyser = _liveCtx.createAnalyser();
    _liveAnalyser.fftSize = 2048;
    _liveSource = _liveCtx.createMediaStreamSource(stream);
    _liveSource.connect(_liveAnalyser);
    if (!_liveTimer) _liveTimer = setInterval(tick, TICK_MS);
    setMicPhase(MIC.LISTENING);
    refreshUi();
    if (isHangout()) schedulePeriodicSample();
  } catch (e) {
    console.warn('[call] web mic', e?.message || e);
    window.showToast?.('无法打开麦克风');
    _liveOn = false;
  }
}

export function stopLiveListen() {
  _liveToken += 1;
  _liveOn = false;
  stopSampleTimer();
  void setNativeAmbientSampleInterval(0);
  abortUtterance();
  if (_liveTimer) {
    clearInterval(_liveTimer);
    _liveTimer = 0;
  }
  try { stopNativeCall(); } catch {}
  void setNativeCallListen(false).catch(() => {});
  if (_liveSource) {
    try { _liveSource.disconnect(); } catch {}
    _liveSource = null;
  }
  _liveAnalyser = null;
  if (_liveCtx) {
    try { _liveCtx.close(); } catch {}
    _liveCtx = null;
  }
  if (_liveStream) {
    try { _liveStream.getTracks().forEach((t) => t.stop()); } catch {}
    _liveStream = null;
  }
  _liveNative = false;
  _liveHeardSpeech = false;
  _liveArmedAt = 0;
  _liveCommitting = false;
  setMicPhase(MIC.IDLE);
  refreshUi();
}

export function setVoiceMode(on) {
  patchState({ voiceMode: !!on });
  try { _deps?.applyVoiceModeUi?.(!!on); } catch {}
  if (on) {
    void startLiveListen();
    if (isHangout()) schedulePeriodicSample();
  } else {
    stopLiveListen();
  }
  refreshUi();
}

export function markUserMaybeAsleepFromIdle() {
  if (!isHangout()) return;
  noteUserQuietAsleep();
}

/** 对外：是否正在录音/提交 */
export function isMicBusy() {
  return !!(_liveRec || _liveCommitting);
}

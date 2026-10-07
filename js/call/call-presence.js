/** 三模式：普通 / 连麦 / 观影；双方同睡判定；观影定时截屏 */

import * as api from '../api.js';
import { captureNativeScreen } from '../app-permissions.js';
import {
  getState,
  patchState,
  PRESENCE,
  isHangoutSleeping,
  WATCH_INTERVAL_MS,
  WATCH_FIRST_MS,
} from './call-state.js';
import { applyPresenceModeUi } from './call-ui.js';
import { startHangoutAmbient, stopHangoutAmbient, refreshAmbientForSleepChange } from './call-ambient.js';

const GOODNIGHT_RE = /晚安|好梦|好夢|睡了|睡觉啦|睡啦|去睡|早点休息|先睡|晚安啦|good\s*night|陪我睡|一起睡/i;

let _watchTimer = 0;
let _watchBusy = false;
let _watchWarned = false;
let _deps = null;

export function bindPresenceDeps(deps) {
  _deps = deps || null;
}

export function resetPresenceRuntime() {
  stopWatchPresence();
  stopHangoutAmbient();
  patchState({
    presenceMode: PRESENCE.TALK,
    userAsleep: false,
    charAsleep: false,
    charActivity: '',
    _wakeStep: 0,
  });
}

export function setUserAsleep(on) {
  const next = !!on;
  const prev = !!getState().userAsleep;
  if (prev === next) return;
  patchState({ userAsleep: next });
  if (getState().presenceMode === PRESENCE.HANGOUT) {
    applyPresenceModeUi();
    refreshAmbientForSleepChange(_deps);
    _deps?.onHangoutSleepChange?.();
  }
}

export function setCharPresence({ asleep, activity } = {}) {
  patchState({
    charAsleep: !!asleep,
    charActivity: String(activity || '').slice(0, 48),
  });
  if (getState().presenceMode === PRESENCE.HANGOUT) {
    applyPresenceModeUi();
    refreshAmbientForSleepChange(_deps);
    _deps?.onHangoutSleepChange?.();
  }
}

export function noteUserSpeechForSleep(text) {
  const raw = String(text || '').trim();
  if (!raw) return;
  if (GOODNIGHT_RE.test(raw)) {
    setUserAsleep(true);
    return;
  }
  // 连麦/挂着/陪睡：不要因为开口把「睡着」清掉（晚安后再说连麦很常见）
  if (/连麦|挂着(?:电话)?|陪睡|一起睡|别挂|不要挂/.test(raw)) return;
  // 用户主动开口且不是晚安 → 认为醒着
  if (raw.length >= 2) setUserAsleep(false);
}

export function noteUserQuietAsleep() {
  // 锁屏/长时间无主动语音：仅在连麦时作为用户睡的弱信号
  if (getState().presenceMode !== PRESENCE.HANGOUT) return;
  setUserAsleep(true);
}

async function startHangoutPresence() {
  stopWatchPresence();
  await refreshCharAsleepFromServer();
  void startHangoutAmbient({
    onCharPresence: setCharPresence,
  });
  _deps?.onEnterHangout?.();
}

function stopHangoutPresence() {
  stopHangoutAmbient();
  _deps?.onLeaveHangout?.();
}

async function refreshCharAsleepFromServer() {
  const st = getState();
  if (!st.callCharId) return;
  try {
    const bed = await api.fetchHangoutBed(st.callCharId);
    if (bed) {
      setCharPresence({ asleep: !!bed.charAsleep, activity: bed.activity || '' });
    }
  } catch {}
}

async function captureWatchScreenUrl() {
  try {
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
    return String(up?.url || '').trim();
  } catch (e) {
    console.warn('[call] watch capture', e?.message || e);
  }
  return '';
}

async function sendWatchScreenToCharacter() {
  const st = getState();
  if (!st.inCall || st.callDialing || st.presenceMode !== PRESENCE.WATCH || !st.callCharId) return;
  if (_watchBusy) return;
  _watchBusy = true;
  const sendCharId = st.callCharId;
  try {
    const imageUrl = await captureWatchScreenUrl();
    if (!st.inCall || st.callCharId !== sendCharId || st.presenceMode !== PRESENCE.WATCH) return;
    if (!imageUrl) {
      if (!_watchWarned) {
        _watchWarned = true;
        window.showToast?.('观影截屏失败，请检查屏幕录制权限');
      }
      return;
    }
    const described = await api.fetchWatchScene(sendCharId, imageUrl);
    if (!st.inCall || st.callCharId !== sendCharId || st.presenceMode !== PRESENCE.WATCH) return;
    const text = String(described?.scene || '').trim();
    if (!text) return;
    // 系统提示：一起看，不提截图/识图
    await _deps?.doSend?.(
      `[一起看] 你们正一起看：${text}`,
      'system',
      { hideChat: true },
      false,
      sendCharId,
    );
  } catch (e) {
    console.warn('[call] watch scene', e?.message || e);
  } finally {
    _watchBusy = false;
  }
}

function scheduleWatchCapture(delayMs) {
  clearTimeout(_watchTimer);
  _watchTimer = setTimeout(async () => {
    _watchTimer = 0;
    if (!getState().inCall || getState().presenceMode !== PRESENCE.WATCH) return;
    await sendWatchScreenToCharacter();
    if (getState().inCall && getState().presenceMode === PRESENCE.WATCH) {
      scheduleWatchCapture(WATCH_INTERVAL_MS);
    }
  }, Math.max(1000, delayMs));
}

function startWatchPresence() {
  stopHangoutPresence();
  _watchWarned = false;
  scheduleWatchCapture(WATCH_FIRST_MS);
  _deps?.onEnterWatch?.();
}

function stopWatchPresence() {
  clearTimeout(_watchTimer);
  _watchTimer = 0;
  _watchBusy = false;
  _deps?.onLeaveWatch?.();
}

export function setCallPresenceMode(nextRaw, { announce = true } = {}) {
  const next = nextRaw === PRESENCE.HANGOUT || nextRaw === PRESENCE.WATCH
    ? nextRaw
    : PRESENCE.TALK;
  const st = getState();
  if (!st.inCall || st.callDialing) return;
  if (st.presenceMode === next) {
    applyPresenceModeUi({ announce: false });
    return;
  }
  const prev = st.presenceMode;
  if (prev === PRESENCE.HANGOUT) stopHangoutPresence();
  if (prev === PRESENCE.WATCH) stopWatchPresence();
  patchState({ presenceMode: next });
  applyPresenceModeUi({ announce });
  if (next === PRESENCE.HANGOUT) void startHangoutPresence();
  if (next === PRESENCE.WATCH) startWatchPresence();
  _deps?.onPresenceChanged?.(next, prev);
}

export function hangoutSleepingNow() {
  return isHangoutSleeping();
}

export async function pollCharAsleep() {
  if (getState().presenceMode !== PRESENCE.HANGOUT) return;
  await refreshCharAsleepFromServer();
}

/** 通话共享状态（普通 / 连麦 / 观影） */

export const PRESENCE = {
  TALK: 'talk',
  HANGOUT: 'hangout',
  WATCH: 'watch',
};

/** idle | listening | thinking | speaking */
export const MIC = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
};

export const USER_SILENCE_MS = 5000;
export const HANGOUT_SAMPLE_MIN_MS = 10 * 60 * 1000;
export const HANGOUT_SAMPLE_MAX_MS = 15 * 60 * 1000;
/** 双方睡着：偶尔采一段环境动静（不宜过长，锁屏后 JS 定时器还会冻住） */
export const HANGOUT_SLEEP_SAMPLE_MIN_MS = 25 * 60 * 1000;
export const HANGOUT_SLEEP_SAMPLE_MAX_MS = 40 * 60 * 1000;
export const INCOMING_SPEAK_DELAY_MS = 1200;
export const WATCH_INTERVAL_MS = 5 * 60 * 1000;
export const WATCH_FIRST_MS = 45000;
export const CALL_UTTER_MIN_MS = 550;
export const CALL_UTTER_MAX_MS = 28000;

const state = {
  inCall: false,
  callDialing: false,
  callCharId: null,
  inVideoCall: false,
  callMinimized: false,
  presenceMode: PRESENCE.TALK,
  micPhase: MIC.IDLE,
  voiceMode: false,
  speaking: false,
  thinking: false,
  /** 用户侧判定睡着（晚安意图 / 长时间安静 / 锁屏夜） */
  userAsleep: false,
  /** 角色行程是否睡觉/休息（后端镜像） */
  charAsleep: false,
  charActivity: '',
  dialingToken: 0,
  dialRingUntil: 0,
  callStartTime: null,
  softTtsNext: false,
};

export function getState() {
  return state;
}

export function patchState(partial) {
  Object.assign(state, partial || {});
  return state;
}

export function isInVoiceCallWith(id) {
  return !!(state.inCall && state.callCharId != null && Number(id) === Number(state.callCharId));
}

export function isHangout() {
  return state.inCall && !state.callDialing && state.presenceMode === PRESENCE.HANGOUT;
}

export function isWatch() {
  return state.inCall && !state.callDialing && state.presenceMode === PRESENCE.WATCH;
}

export function isTalk() {
  return state.inCall && !state.callDialing && state.presenceMode === PRESENCE.TALK;
}

/** 双方都在睡才算连麦睡觉 */
export function isHangoutSleeping() {
  return isHangout() && !!state.userAsleep && !!state.charAsleep;
}

export function callExtras() {
  if (!state.inCall && !state.callDialing) return {};
  return {
    isVideoCall: !!state.inVideoCall,
    callPresenceMode: state.presenceMode,
    callHangoutSleeping: isHangoutSleeping() || undefined,
    callHangoutWakeStep: isHangoutSleeping() ? Math.max(1, Number(state._wakeStep) || 1) : undefined,
    callInputMode: state.voiceMode ? 'voice' : 'keyboard',
  };
}

export function resetPresenceFlags() {
  state.presenceMode = PRESENCE.TALK;
  state.userAsleep = false;
  state.charAsleep = false;
  state.charActivity = '';
  state._wakeStep = 0;
  state.micPhase = MIC.IDLE;
  state.speaking = false;
  state.thinking = false;
}

export function randomBetween(minMs, maxMs) {
  const a = Math.min(minMs, maxMs);
  const b = Math.max(minMs, maxMs);
  return a + Math.floor(Math.random() * (b - a + 1));
}

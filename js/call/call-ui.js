/** 通话 UI：模式条、波形、接通/拨号视图 */

import {
  getState,
  isHangout,
  isHangoutSleeping,
  isWatch,
  PRESENCE,
} from './call-state.js';

const PRESENCE_META = {
  [PRESENCE.TALK]: {
    label: '普通通话',
    hint: '角色说完再收音 · 停说 5 秒发送',
    toast: '已切换到普通通话',
  },
  [PRESENCE.HANGOUT]: {
    label: '连麦中',
    hint: '麦一直开着 · 停说 5 秒发送',
    sleepHint: '一起睡 · 偶尔听听你 · 迷糊应一声',
    toast: '已切换到连麦',
  },
  [PRESENCE.WATCH]: {
    label: '观影中',
    hint: '一起看 · 约每 5 分钟同步画面',
    toast: '已切换到观影',
  },
};

export function applyPresenceModeUi({ announce = false } = {}) {
  const st = getState();
  const mode = st.presenceMode === PRESENCE.HANGOUT || st.presenceMode === PRESENCE.WATCH
    ? st.presenceMode
    : PRESENCE.TALK;
  const meta = PRESENCE_META[mode] || PRESENCE_META[PRESENCE.TALK];

  const bar = document.getElementById('call-mode-bar');
  if (bar) bar.dataset.mode = mode;

  document.querySelectorAll('#call-mode-bar .call-mode-chip').forEach((btn) => {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  const hint = document.getElementById('call-mode-hint');
  if (hint) {
    hint.textContent = (mode === PRESENCE.HANGOUT && isHangoutSleeping() && meta.sleepHint)
      ? meta.sleepHint
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
    badge.textContent = (mode === PRESENCE.HANGOUT && isHangoutSleeping())
      ? '连麦睡觉'
      : meta.label;
  }

  if (announce) window.showToast?.(meta.toast);
}

export function showDialingUi(char) {
  const screen = document.getElementById('call-screen');
  screen?.classList.add('is-dialing');
  screen?.classList.remove('is-speaking', 'is-wave-listening', 'is-wave-thinking', 'is-wave-speaking');
  const dial = document.getElementById('call-dialing-view');
  const active = document.getElementById('call-active-view');
  const ended = document.getElementById('call-ended-view');
  if (dial) dial.hidden = false;
  if (active) active.hidden = true;
  if (ended) ended.hidden = true;
  const avatar = document.getElementById('call-dialing-avatar');
  const name = document.getElementById('call-dialing-name');
  if (avatar) avatar.src = char?.avatar || '';
  if (name) name.textContent = char?.name || 'TA';
}

export function showConnectedUi() {
  const screen = document.getElementById('call-screen');
  screen?.classList.remove('is-dialing');
  const dial = document.getElementById('call-dialing-view');
  const active = document.getElementById('call-active-view');
  const ended = document.getElementById('call-ended-view');
  if (dial) dial.hidden = true;
  if (active) active.hidden = false;
  if (ended) ended.hidden = true;
  applyPresenceModeUi();
}

export function syncWaveform() {
  const st = getState();
  const screen = document.getElementById('call-screen');
  if (!screen) return;
  const phase = st.speaking
    ? 'speaking'
    : st.thinking
      ? 'thinking'
      : (st.inCall && !st.callDialing && st.voiceMode ? 'listening' : 'idle');
  screen.classList.toggle('is-wave-idle', phase === 'idle');
  screen.classList.toggle('is-wave-thinking', phase === 'thinking');
  screen.classList.toggle('is-wave-listening', phase === 'listening');
  screen.classList.toggle('is-wave-speaking', phase === 'speaking');
  screen.classList.toggle('is-speaking', !!st.speaking);
}

export function updateHoldTalkUi({ committing = false, recording = false, heardSpeech = false, silentAt = 0 } = {}) {
  const hold = document.getElementById('call-hold-talk');
  const st = getState();
  if (!hold || !st.voiceMode) return;
  hold.classList.add('is-live');
  hold.style.pointerEvents = 'none';

  if (committing) {
    hold.classList.remove('is-hearing', 'is-paused');
    hold.textContent = '正在发送…';
  } else if (st.speaking) {
    hold.classList.add('is-paused');
    hold.classList.remove('is-hearing');
    hold.textContent = '对方正在说';
  } else if (st.thinking) {
    hold.classList.add('is-paused');
    hold.classList.remove('is-hearing');
    hold.textContent = '对方正在想';
  } else if (recording) {
    hold.classList.remove('is-paused');
    hold.classList.add('is-hearing');
    const silentMs = silentAt ? Date.now() - silentAt : 0;
    if (silentMs > 350 && heardSpeech) {
      const left = Math.max(1, Math.ceil((USER_SILENCE_LEFT(silentMs)) / 1000));
      hold.textContent = `停顿 ${left} 秒后发送`;
    } else {
      hold.textContent = isHangout() ? (isHangoutSleeping() ? '陪睡中' : '连麦中') : (isWatch() ? '观影中' : '正在使用麦克风');
    }
  } else {
    hold.classList.remove('is-paused');
    hold.classList.add('is-hearing');
    hold.textContent = isHangout()
      ? (isHangoutSleeping() ? '陪睡中' : '连麦中')
      : (isWatch() ? '观影中' : '正在使用麦克风');
  }
  syncWaveform();
}

function USER_SILENCE_LEFT(silentMs) {
  return Math.max(0, 5000 - silentMs);
}

export function formatCallDur(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let _timerInterval = null;

export function startCallTimer() {
  stopCallTimer();
  const st = getState();
  st.callStartTime = Date.now();
  const el = document.getElementById('call-timer');
  const tick = () => {
    if (!el || !st.callStartTime) return;
    el.textContent = formatCallDur(Math.floor((Date.now() - st.callStartTime) / 1000));
  };
  tick();
  _timerInterval = setInterval(tick, 1000);
}

export function stopCallTimer() {
  if (_timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }
}

export function clearCallChatArea() {
  const area = document.getElementById('call-chat-area');
  if (area) area.innerHTML = '';
}

export function appendCallChatMsg(role, text) {
  const area = document.getElementById('call-chat-area');
  if (!area) return;
  const row = document.createElement('div');
  row.className = `call-chat-msg is-${role === 'user' ? 'user' : 'assistant'}`;
  row.textContent = String(text || '').trim();
  area.appendChild(row);
  area.scrollTop = area.scrollHeight;
}

export { PRESENCE_META };

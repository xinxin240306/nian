/**
 * 今日感知：异常分按指数滚动淡出，写入 emotion_state.perception。
 * 默认 6 小时时间常数：越久没说话旧信号越淡，不会在整点或满 6 小时清零。
 */
'use strict';

const HEDGE_RE = /^(嗯+|哦+|噢+|额+|啊+|哈+|好的?|ok|OK|嗯嗯|哦哦|没事|还好|还行|随便|都行|挺好|不错|知道了|收到|好吧|行吧)([。.！!…~～])*$/i;
const SOFT_DENY_RE = /没事|挺好的|还好吧|随便你|爱怎样|不用了|算了|都行/;
const FATIGUE_RE = /累|疲惫|心累|不想|没劲|烦|难过|郁闷|压力|焦虑|撑不住/;
const GOODNIGHT_RE = /晚安|先这样|不说了|去忙|去睡/;

const DEFAULT_TAU_HOURS = 6;

function clamp(n, lo = 0, hi = 100) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function getSettings() {
  try {
    const rows = require('./db').prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function numSetting(settings, key, fallback) {
  const n = parseFloat(settings?.[key]);
  return Number.isFinite(n) ? n : fallback;
}

function emptyPerception() {
  return {
    cycleStartedAt: null,
    lastUserAt: null,
    score: 0,
    prevScore: 0,
    lastLen: 0,
    msgCount: 0,
    trend: '无异常',
    lastSignal: 0,
  };
}

function readPerception(state) {
  const p = state && typeof state === 'object' ? state.perception : null;
  if (!p || typeof p !== 'object') return emptyPerception();
  return {
    cycleStartedAt: p.cycleStartedAt || null,
    lastUserAt: p.lastUserAt || null,
    score: clamp(p.score),
    prevScore: clamp(p.prevScore),
    lastLen: Number(p.lastLen) || 0,
    msgCount: Number(p.msgCount) || 0,
    trend: p.trend || '无异常',
    lastSignal: Number(p.lastSignal) || 0,
  };
}

function signalFromMessage(text, intervalMs = 0) {
  const t = String(text || '').trim();
  if (!t) return 0;
  let s = 0;
  const len = t.length;
  if (len <= 4) s += 22;
  else if (len <= 8) s += 12;
  else if (len >= 40) s -= 8;
  if (HEDGE_RE.test(t)) s += 24;
  if (SOFT_DENY_RE.test(t) && GOODNIGHT_RE.test(t)) s += 20;
  else if (SOFT_DENY_RE.test(t)) s += 10;
  if (FATIGUE_RE.test(t)) s += 16;
  if (intervalMs >= 60 * 60 * 1000) s += 18;
  else if (intervalMs >= 30 * 60 * 1000) s += 12;
  else if (intervalMs >= 10 * 60 * 1000) s += 6;
  // 久空窗后极短晚安/敷衍收尾：反常信号加重（不写接法，只抬分）
  if (GOODNIGHT_RE.test(t) && len <= 8 && intervalMs >= 60 * 60 * 1000) s += 16;
  return clamp(s);
}

function trendFromScores(score, prevScore, msgCount) {
  if (score < 20) return '无异常';
  if (msgCount <= 2 && score >= 35) return '首次出现';
  if (score + 6 < prevScore && prevScore >= 28) return '缓解中';
  if (score >= prevScore + 4 && score >= 28) return '持续累积';
  if (score >= 35) return prevScore < 28 ? '首次出现' : '持续累积';
  return '无异常';
}

function hasUnderstandingCue(text, perception) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (HEDGE_RE.test(t) || SOFT_DENY_RE.test(t) || FATIGUE_RE.test(t) || GOODNIGHT_RE.test(t)) return true;
  if (/算了|呵呵|不想说|没事吧|还好吧/.test(t)) return true;
  if ((Number(perception?.score) || 0) >= 40) return true;
  return false;
}

/** 就地写入 state.perception；由心情更新路径一并落库。 */
function touchFromUserMessage(_charId, state, text, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') return state;
  const settings = getSettings();
  const tauHours = Math.max(0.5, numSetting(settings, 'perception_gap_hours', DEFAULT_TAU_HOURS));
  const prev = readPerception(state);
  const lastAt = prev.lastUserAt ? Date.parse(prev.lastUserAt) : 0;
  const interval = lastAt && Number.isFinite(lastAt) ? Math.max(0, nowMs - lastAt) : 0;
  let score = prev.score;
  let cycleStartedAt = prev.cycleStartedAt || (lastAt ? prev.lastUserAt : null);
  let msgCount = prev.msgCount;
  if (interval > 0 && lastAt) {
    score = score * Math.exp(-(interval / 3600000) / tauHours);
  }
  if (!cycleStartedAt) cycleStartedAt = new Date(nowMs).toISOString();
  const signal = signalFromMessage(text, interval);
  score = clamp(score * 0.55 + signal * 0.55);
  msgCount += 1;
  const trend = trendFromScores(score, prev.score, msgCount);
  state.perception = {
    cycleStartedAt,
    lastUserAt: new Date(nowMs).toISOString(),
    score: Math.round(score * 10) / 10,
    prevScore: Math.round(prev.score * 10) / 10,
    lastLen: String(text || '').trim().length,
    msgCount,
    trend,
    lastSignal: signal,
  };
  return state;
}

function snapshotForUnderstanding(state) {
  const p = readPerception(state);
  return {
    daily_anomaly_score: Math.round(p.score),
    anomaly_trend: p.trend || '无异常',
    msgCount: p.msgCount,
  };
}

module.exports = {
  readPerception,
  signalFromMessage,
  trendFromScores,
  hasUnderstandingCue,
  touchFromUserMessage,
  snapshotForUnderstanding,
  HEDGE_RE,
  SOFT_DENY_RE,
  FATIGUE_RE,
};

/* ===== TTS / 语音功能 ===== */
import { fetchTTS } from './api.js';
import { resolveMediaUrl } from './server-config.js';

const ttsCache = new Map();
let currentAudio = null;
let currentPlayKey = null;
let lastTtsError = '';
let audioUnlockPromise = null;
// 每次 stopTTS 时递增，用于检测 fetchTTS 期间是否已被取消
let _ttsGeneration = 0;

export function getLastTtsError() { return lastTtsError; }

let sharedAudioCtx = null;

function getSharedAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

/** 在用户点击「拨打电话」等手势时调用，解除浏览器自动播放限制 */
export function unlockAudioPlayback() {
  if (audioUnlockPromise) return audioUnlockPromise;
  audioUnlockPromise = (async () => {
    try {
      const ctx = getSharedAudioContext();
      if (ctx) {
        await ctx.resume();
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      }
    } catch (e) {
      console.warn('[tts] AudioContext unlock', e);
    }
    try {
      const silent = new Audio('data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABhABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf///////////////////////////////////////////w==');
      silent.volume = 0.01;
      await silent.play();
    } catch (e) {
      console.warn('[tts] silent play unlock', e);
    }
  })();
  return audioUnlockPromise;
}

function makeCacheKey(text, msgId, characterId, emotion, tone) {
  const t = String(text || '').trim();
  if (!t) return '';
  const sid = String(msgId || '').trim();
  const emo = String(emotion || '').trim();
  const tn = String(tone || '').trim();
  const emoPart = (emo ? `:emo:${emo}` : '') + (tn ? `:tone:${tn}` : '');
  // 必须包含文本：同一消息拆成多条语音气泡时，子 id 可能重复或共用父 id
  if (sid) return `msg:${sid}:${t.slice(0, 160)}${emoPart}`;
  return `tts:${characterId}:${t.slice(0, 160)}${emoPart}`;
}

async function getOrFetchAudioUrl(text, msgId, characterId, emotion, tone) {
  if (!characterId) {
    lastTtsError = '缺少角色 ID';
    return null;
  }
  const key = makeCacheKey(text, msgId, characterId, emotion, tone);
  if (ttsCache.has(key)) return { key, url: ttsCache.get(key) };

  lastTtsError = '';
  const result = await fetchTTS(text, characterId, { emotion, tone });
  if (!result?.url) {
    lastTtsError = result?.error || '语音生成失败';
    return null;
  }
  ttsCache.set(key, result.url);
  return { key, url: result.url };
}

function resetAllVoicePlayIcons() {
  document.querySelectorAll('.voice-bubble.is-playing').forEach(el => {
    el.classList.remove('is-playing');
  });
}

let preferCallAudioSink = false;
let nativeCallPlay = null;
let nativeCallStopPlay = null;
let nativeCallBedPlay = null;
let nativeCallBedStop = null;
/** 原生垫音已接管时，关掉 Web Audio 同轨，避免双份 */
let nativeBedActive = false;

export function setTtsPreferCallSink(on) {
  preferCallAudioSink = !!on;
}

export function setNativeCallPlayHandlers({ play, stop } = {}) {
  nativeCallPlay = typeof play === 'function' ? play : null;
  nativeCallStopPlay = typeof stop === 'function' ? stop : null;
}

export function setNativeCallBedHandlers({ play, stop } = {}) {
  nativeCallBedPlay = typeof play === 'function' ? play : null;
  nativeCallBedStop = typeof stop === 'function' ? stop : null;
  if (!nativeCallBedPlay) {
    nativeBedActive = false;
  }
}

async function preferMediaAudioOutput(audio) {
  if (!audio?.setSinkId || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId);
    const labelOf = (d) => String(d.label || '').toLowerCase();
    const isBt = (d) => /bluetooth|a2dp|headset|buds|airpods|sco|耳机/i.test(labelOf(d));
    const isComm = (d) => /communication|通话|sco/i.test(labelOf(d));
    let pick;
    if (preferCallAudioSink) {
      // 通话听筒：优先蓝牙媒体；没有耳机时走默认扬声器，别强绑 communications（听筒）——
      // 原生失败回退到 HTML Audio 时否则会像「接通了但完全没声」
      pick = outs.find((d) => isBt(d) && !isComm(d))
        || outs.find(isBt)
        || outs.find((d) => d.deviceId === 'default')
        || outs.find((d) => /speaker|扬声器|内置/i.test(labelOf(d)));
    } else {
      pick = outs.find((d) => isBt(d) && !isComm(d)) || outs.find(isBt);
    }
    if (pick?.deviceId) await audio.setSinkId(pick.deviceId);
  } catch {}
}

function speechAudioPlugin() {
  return window.Capacitor?.Plugins?.AppPermissions;
}

function canNativeSpeechPlay() {
  const p = speechAudioPlugin();
  return Boolean(p?.playSpeechUrl || p?.duckMediaForSpeech);
}

async function duckMediaForSpeech() {
  const p = speechAudioPlugin();
  if (!p?.duckMediaForSpeech) return;
  try { await p.duckMediaForSpeech(); } catch { /* ignore */ }
}

async function unduckMediaAfterSpeech() {
  const p = speechAudioPlugin();
  if (!p?.unduckMediaAfterSpeech) return;
  try { await p.unduckMediaAfterSpeech(); } catch { /* ignore */ }
}

async function stopNativeSpeechPlay() {
  const p = speechAudioPlugin();
  if (!p?.stopSpeechPlay) return;
  try { await p.stopSpeechPlay(); } catch { /* ignore */ }
}

function speechBytesToBase64(u8) {
  const chunk = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function guessSpeechMime(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('.wav')) return 'audio/wav';
  if (u.includes('.ogg')) return 'audio/ogg';
  if (u.includes('.m4a') || u.includes('.aac')) return 'audio/mp4';
  if (u.includes('.webm')) return 'audio/webm';
  return 'audio/mpeg';
}

/** 聊天语音：原生播放（其它 App 音乐闪避；本机媒体音量不改） */
async function playViaNativeSpeech(url, volume) {
  const p = speechAudioPlugin();
  if (!p?.playSpeechUrl) throw new Error('no_speech_play');
  const src = String(url || '');
  if (!src) throw new Error('empty_audio');
  const vol = Number.isFinite(Number(volume))
    ? Math.max(0.05, Math.min(2, Number(volume)))
    : null;
  const abs = resolveMediaUrl(src) || src;
  if (/^https?:\/\//i.test(abs) && !/\.blob\./i.test(abs)) {
    await p.playSpeechUrl({ url: abs, ...(vol != null ? { volume: vol } : {}) });
    return;
  }
  if (p.playSpeechData) {
    const resp = await fetch(src);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 80) {
      await p.playSpeechData({
        base64: speechBytesToBase64(new Uint8Array(buf)),
        mime: resp.headers.get('content-type') || guessSpeechMime(src),
        ...(vol != null ? { volume: vol } : {}),
      });
      return;
    }
  }
  await p.playSpeechUrl({ url: abs || src, ...(vol != null ? { volume: vol } : {}) });
}

async function playAudioUrl(url, onEnd, { volume } = {}) {
  const src = resolveMediaUrl(url) || url;
  const vol = Number.isFinite(Number(volume))
    ? Math.max(0.05, Math.min(2, Number(volume)))
    : null;
  // 通话原生播放（含轻声）：不依赖 WebView HTML Audio，锁屏后仍能出声
  if (nativeCallPlay) {
    try {
      currentAudio = { pause() { nativeCallStopPlay?.(); } };
      await nativeCallPlay(src, vol);
      if (currentAudio && currentAudio.pause) currentAudio = null;
      onEnd?.();
      return true;
    } catch (e) {
      currentAudio = null;
      // blob / 原生播放失败时改走网页音频，避免通话里彻底没声
    }
  }
  // 聊天语音：与系统音乐共存——音频焦点让其它 App 闪避，再播角色声
  if (!preferCallAudioSink && canNativeSpeechPlay()) {
    try {
      currentAudio = { pause() { stopNativeSpeechPlay(); } };
      await playViaNativeSpeech(src, vol);
      if (currentAudio && currentAudio.pause) currentAudio = null;
      onEnd?.();
      return true;
    } catch (e) {
      currentAudio = null;
      console.warn('[tts] native speech play fallback', e?.message || e);
    }
  }
  await unlockAudioPlayback();
  await duckMediaForSpeech();
  const audio = new Audio(src);
  if (vol != null) audio.volume = vol;
  try { audio.setAttribute?.('playsinline', ''); } catch {}
  await preferMediaAudioOutput(audio);
  currentAudio = audio;
  const finish = () => {
    if (currentAudio === audio) currentAudio = null;
    unduckMediaAfterSpeech();
    onEnd?.();
  };
  audio.onended = finish;
  audio.onerror = () => {
    lastTtsError = '音频播放失败';
    finish();
  };
  try {
    await audio.play();
  } catch (e) {
    lastTtsError = /notallowed|interact/i.test(String(e.message || e))
      ? '浏览器阻止自动播放，请点击播放按钮'
      : (e.message || '音频播放失败');
    if (currentAudio === audio) currentAudio = null;
    unduckMediaAfterSpeech();
    onEnd?.();
    throw e;
  }
  return true;
}

/** 相册语音条：直接播放已上传的音频文件 */
export async function playVoiceClipUrl(url, { onStart, onEnd } = {}) {
  if (!url?.trim()) {
    lastTtsError = '语音文件无效';
    return false;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
    resetAllVoicePlayIcons();
  }
  currentPlayKey = null;
  lastTtsError = '';
  try {
    onStart?.();
    await playAudioUrl(url, onEnd);
    return true;
  } catch (e) {
    lastTtsError = e.message || '播放失败';
    onEnd?.();
    return false;
  }
}

/** 聊天语音条：每条消息 TTS 只请求一次，之后复用缓存 */
export async function playVoiceAudio(text, msgId, { onStart, onEnd, characterId, emotion, tone } = {}) {
  if (!text?.trim() || !characterId) {
    lastTtsError = '请先在角色中填写 MiniMax 声音 ID';
    return false;
  }

  const cached = await getOrFetchAudioUrl(text, msgId, characterId, emotion, tone);
  if (!cached) return false;

  const { key, url } = cached;

  if (currentAudio && currentPlayKey !== key) {
    currentAudio.pause();
    currentAudio = null;
    resetAllVoicePlayIcons();
  }

  if (currentAudio && currentPlayKey === key) {
    currentAudio.currentTime = 0;
    try {
      onStart?.();
      await unlockAudioPlayback();
      await currentAudio.play();
    } catch {
      onEnd?.();
    }
    return true;
  }

  currentPlayKey = key;
  try {
    onStart?.();
    await playAudioUrl(url, onEnd);
    return true;
  } catch (e) {
    console.error('[tts] play error', e);
    lastTtsError = e.message || '播放失败';
    currentPlayKey = null;
    onEnd?.();
    return false;
  }
}

/** 先拉 TTS，接通后再播，避免接通后干等 */
export async function prefetchTTS(text, characterId, { inCall, emotion, tone } = {}) {
  if (!characterId) {
    lastTtsError = '请先在角色中填写 MiniMax 声音 ID';
    return null;
  }
  lastTtsError = '';
  const gen = _ttsGeneration;
  try {
    const result = await fetchTTS(text, characterId, {
      inCall,
      emotion: String(emotion || '').trim() || undefined,
      tone: String(tone || '').trim() || undefined,
    });
    if (_ttsGeneration !== gen) return null;
    if (!result?.url) {
      lastTtsError = result?.error || '语音生成失败';
      return null;
    }
    return result.url;
  } catch (e) {
    lastTtsError = e.message || '语音生成失败';
    return null;
  }
}

export async function playReadyTTS(url, onEnd, { volume } = {}) {
  if (!url) {
    lastTtsError = lastTtsError || '语音生成失败';
    onEnd?.();
    return false;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
    currentPlayKey = null;
    resetAllVoicePlayIcons();
  }
  const gen = _ttsGeneration;
  // 没有显式 volume 时，按设置里的「通话角色声音」倍率给到 native player，
  // 默认 1.0；用户调到 130 就是 1.3，能顶过去系统媒体音量被压的环境
  const mix = sfxMix();
  const finalVolume = Number.isFinite(Number(volume))
    ? Number(volume)
    : Math.max(0.05, Math.min(2.0, (mix.callVoice || 1.0) * CALL_VOICE_GAIN_BOOST));
  try {
    await unlockAudioPlayback();
    if (_ttsGeneration !== gen) {
      onEnd?.();
      return false;
    }
    // 角色开口不压环境音；播的时候再把垫音叫醒一次（防系统焦点闪避后静音）
    try { duckCallAmbient(false); } catch {}
    try { ensureCallAmbientPlaying(); } catch {}
    await playAudioUrl(url, () => {
      try { ensureCallAmbientPlaying(); } catch {}
      onEnd?.();
    }, { volume: finalVolume });
    return true;
  } catch (e) {
    lastTtsError = e.message || '语音播放失败';
    console.error('[tts] error', e);
    onEnd?.();
    return false;
  }
}

/** 通话等场景：不缓存，每次新请求 */
export async function playTTS(text, onEnd, characterId) {
  if (!characterId) {
    lastTtsError = '请先在角色中填写 MiniMax 声音 ID';
    onEnd?.();
    return false;
  }
  const url = await prefetchTTS(text, characterId, { inCall: true });
  if (!url) {
    onEnd?.();
    return false;
  }
  return playReadyTTS(url, onEnd);
}

export function stopTTS() {
  _ttsGeneration++;          // 使所有正在 await fetchTTS 的调用失效
  try { nativeCallStopPlay?.(); } catch {}
  try { stopNativeSpeechPlay(); } catch {}
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  currentPlayKey = null;
  resetAllVoicePlayIcons();
  try { unduckMediaAfterSpeech(); } catch {}
  try { duckCallAmbient(false); } catch {}
}

const AMBIENT_VOL = 0.40;
const CALL_VOICE_GAIN_BOOST = 1.0; // 通话里角色声音的额外增益（乘到系统音量上）

function clampPct(n, fallback, max = 100) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(0, Math.min(max, Math.round(x)));
}

/** 设置里 0～100。现场是倍率（100=原来的吵/静分级）；一次性/贴身是绝对音量。 */
function sfxMix() {
  const s = (() => {
    try { return window.getAppSettings?.() || {}; } catch { return {}; }
  })();
  return {
    scene: clampPct(s.sfx_vol_scene, 100) / 100,
    oneshot: clampPct(s.sfx_vol_oneshot, 70) / 100,
    close: clampPct(s.sfx_vol_close, 32) / 100,
    duck: clampPct(s.sfx_vol_duck, 88) / 100,
    callVoice: clampPct(s.sfx_vol_call_voice, 100, 200) / 100, // 通话里角色声音倍率（>100 放大，最大 200）
  };
}

function resolveSceneBase(prompt, explicit) {
  const n = Number(explicit);
  if (Number.isFinite(n) && n > 0) return Math.max(0.1, Math.min(0.62, n));
  const t = String(prompt || '').toLowerCase();
  if (/夜市|地摊|大排档|地铁|商场|超市|机场|高铁|车站|健身房|busy|crowd|loud|night market|subway|mall|gym|station|motorbike/.test(t)) {
    return 0.55;
  }
  if (/暴雨|倾盆|大风|狂风|街上|马路|餐厅|食堂|堵车|heavy rain|thunder|strong wind|street|traffic|restaurant/.test(t)) {
    return 0.42;
  }
  if (/咖啡|厨房|公园|海边|沙滩|下雨|浴室|公交|开车|cafe|kitchen|park|ocean|beach|rain|bathroom|bus|car cabin/.test(t)) {
    return 0.28;
  }
  if (/睡觉|陪睡|图书馆|办公室|卧室|客厅|quiet|bedroom|library|office|room tone|living room|soft|fridge/.test(t)) {
    return 0.18;
  }
  return AMBIENT_VOL;
}

const loopBufferCache = new Map();

function trimLoopBuffer(ctx, buffer) {
  const ch0 = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const thresh = 0.01;
  let start = 0;
  let end = ch0.length - 1;
  while (start < end && Math.abs(ch0[start]) < thresh) start += 1;
  while (end > start && Math.abs(ch0[end]) < thresh) end -= 1;
  const pad = Math.floor(sr * 0.015);
  start = Math.max(0, start - pad);
  end = Math.min(ch0.length - 1, end + pad);
  if (end - start < sr * 0.8) return buffer;
  const len = end - start + 1;
  const out = ctx.createBuffer(buffer.numberOfChannels, len, sr);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.getChannelData(c).set(buffer.getChannelData(c).subarray(start, end + 1));
  }
  return out;
}

async function decodeLoopBuffer(src) {
  if (loopBufferCache.has(src)) return loopBufferCache.get(src);
  const ctx = getSharedAudioContext();
  if (!ctx) return null;
  const resp = await fetch(src);
  const arr = await resp.arrayBuffer();
  const decoded = await ctx.decodeAudioData(arr.slice(0));
  const trimmed = trimLoopBuffer(ctx, decoded);
  loopBufferCache.set(src, trimmed);
  return trimmed;
}

function createLoopLayer({ kind = 'scene', defaultVol = 0.4, resolveVolume } = {}) {
  let url = '';
  let keepAlive = false;
  let targetVol = defaultVol;
  let ducked = false;
  let master = null;
  let schedTimer = null;
  let nextStart = 0;
  let buffer = null;
  let playGen = 0;
  let stopFadeTimer = null;
  const voices = [];
  const FADE_IN_SEC = 1.35;
  const FADE_OUT_SEC = 1.45;

  function mixedVol() {
    const mix = sfxMix();
    let v = kind === 'texture' ? mix.close : targetVol;
    if (kind === 'scene') v = targetVol * mix.scene;
    if (ducked) v *= mix.duck;
    return Math.max(0.0001, Math.min(0.95, v));
  }

  function apply({ fadeSec } = {}) {
    if (!master || !sharedAudioCtx) return;
    const v = mixedVol();
    const ctx = sharedAudioCtx;
    const sec = Number(fadeSec);
    try {
      master.gain.cancelScheduledValues(ctx.currentTime);
      if (Number.isFinite(sec) && sec > 0.05) {
        const cur = Math.max(0.0001, master.gain.value || 0.0001);
        master.gain.setValueAtTime(cur, ctx.currentTime);
        master.gain.linearRampToValueAtTime(v, ctx.currentTime + sec);
      } else {
        master.gain.setTargetAtTime(v, ctx.currentTime, 0.08);
      }
    } catch {
      master.gain.value = v;
    }
  }

  function clearVoices() {
    for (const v of voices) {
      try { v.src.stop(); } catch {}
      try { v.src.disconnect(); } catch {}
      try { v.gain.disconnect(); } catch {}
    }
    voices.length = 0;
  }

  function stopSched() {
    if (schedTimer) {
      clearTimeout(schedTimer);
      schedTimer = null;
    }
  }

  function hardTeardown() {
    clearVoices();
    stopSched();
    url = '';
    buffer = null;
    targetVol = defaultVol;
    ducked = false;
    if (master) {
      try { master.disconnect(); } catch {}
      master = null;
    }
  }

  function spawnAt(at) {
    const ctx = getSharedAudioContext();
    if (!ctx || !buffer || !master || !keepAlive) return;
    const overlap = Math.min(0.42, Math.max(0.18, buffer.duration * 0.09));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(master);
    const fadeInEnd = at + overlap;
    const fadeOutAt = at + Math.max(overlap + 0.05, buffer.duration - overlap);
    const endAt = at + buffer.duration;
    try {
      g.gain.setValueAtTime(0.0001, Math.max(ctx.currentTime, at));
      g.gain.linearRampToValueAtTime(1, Math.max(ctx.currentTime, fadeInEnd));
      g.gain.setValueAtTime(1, Math.max(ctx.currentTime, fadeOutAt));
      g.gain.linearRampToValueAtTime(0.0001, Math.max(ctx.currentTime + 0.02, endAt));
    } catch {
      g.gain.value = 1;
    }
    try { src.start(at); } catch { return; }
    voices.push({ src, gain: g });
    while (voices.length > 6) {
      const old = voices.shift();
      try { old.src.stop(); } catch {}
      try { old.src.disconnect(); } catch {}
      try { old.gain.disconnect(); } catch {}
    }
  }

  function schedule() {
    stopSched();
    const ctx = getSharedAudioContext();
    if (!keepAlive || !ctx || !buffer) return;
    const overlap = Math.min(0.42, Math.max(0.18, buffer.duration * 0.09));
    const period = Math.max(0.35, buffer.duration - overlap);
    if (nextStart < ctx.currentTime - 0.05) nextStart = ctx.currentTime;
    while (nextStart < ctx.currentTime + 2.8) {
      spawnAt(nextStart);
      nextStart += period;
    }
    const wait = Math.max(80, (nextStart - ctx.currentTime - 1.2) * 1000);
    schedTimer = setTimeout(schedule, wait);
  }

  function beginLoop(buf) {
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    clearVoices();
    stopSched();
    buffer = buf;
    if (!master) {
      master = ctx.createGain();
      master.gain.value = 0.0001;
      master.connect(ctx.destination);
    }
    // 从几乎静音淡入，避免环境音突然砸进来
    try {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(0.0001, ctx.currentTime);
      master.gain.linearRampToValueAtTime(mixedVol(), ctx.currentTime + FADE_IN_SEC);
    } catch {
      apply({ fadeSec: FADE_IN_SEC });
    }
    nextStart = ctx.currentTime;
    schedule();
  }

  function revive() {
    if (!keepAlive) return;
    const ctx = getSharedAudioContext();
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    if (buffer) schedule();
  }

  return {
    play(rawUrl, { volume, prompt } = {}) {
      const src = resolveMediaUrl(rawUrl) || rawUrl;
      if (!src) return;
      if (stopFadeTimer) {
        clearTimeout(stopFadeTimer);
        stopFadeTimer = null;
      }
      keepAlive = true;
      targetVol = resolveVolume
        ? resolveVolume(prompt, volume)
        : (Number.isFinite(Number(volume)) && Number(volume) > 0
          ? Math.max(0.08, Math.min(0.7, Number(volume)))
          : defaultVol);
      if (url === src && buffer) {
        apply({ fadeSec: 0.55 });
        revive();
        return;
      }
      // 换场景：先渐出旧环境，再淡入新的，不要硬掐断
      const switching = !!(url && url !== src && master);
      if (switching) {
        const ctx = getSharedAudioContext();
        try {
          if (ctx && master) {
            const cur = Math.max(0.0001, master.gain.value || 0.0001);
            master.gain.cancelScheduledValues(ctx.currentTime);
            master.gain.setValueAtTime(cur, ctx.currentTime);
            master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + FADE_OUT_SEC);
          }
        } catch { /* ignore */ }
      }
      const fadeStartedAt = switching ? performance.now() : 0;
      url = src;
      const gen = ++playGen;
      decodeLoopBuffer(src).then((buf) => {
        if (gen !== playGen || !keepAlive || url !== src || !buf) return;
        const remain = switching
          ? Math.max(0, Math.round(FADE_OUT_SEC * 1000) - (performance.now() - fadeStartedAt))
          : 0;
        if (remain > 40) {
          stopFadeTimer = setTimeout(() => {
            stopFadeTimer = null;
            if (gen !== playGen || !keepAlive || url !== src) return;
            beginLoop(buf);
          }, remain);
          return;
        }
        beginLoop(buf);
      }).catch((e) => {
        console.warn('[tts] loop decode', e?.message || e);
      });
    },
    stop() {
      keepAlive = false;
      stopSched();
      if (stopFadeTimer) {
        clearTimeout(stopFadeTimer);
        stopFadeTimer = null;
      }
      const ctx = getSharedAudioContext();
      if (master && ctx) {
        const gen = ++playGen;
        try {
          const cur = Math.max(0.0001, master.gain.value || 0.0001);
          master.gain.cancelScheduledValues(ctx.currentTime);
          master.gain.setValueAtTime(cur, ctx.currentTime);
          master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + FADE_OUT_SEC);
        } catch { /* ignore */ }
        // 淡出后再拆节点，避免听感硬掐断
        stopFadeTimer = setTimeout(() => {
          stopFadeTimer = null;
          if (gen !== playGen) return;
          hardTeardown();
        }, Math.round(FADE_OUT_SEC * 1000) + 60);
      } else {
        playGen += 1;
        hardTeardown();
      }
    },
    setDucked(on) {
      ducked = !!on;
      apply({ fadeSec: 0.25 });
    },
    reapply() {
      apply({ fadeSec: 0.2 });
    },
    revive,
  };
}

const roomAmbient = createLoopLayer({ kind: 'scene', defaultVol: AMBIENT_VOL, resolveVolume: resolveSceneBase });
const breathBed = createLoopLayer({ kind: 'breath', defaultVol: 0.24 });
const textureBed = createLoopLayer({ kind: 'texture', defaultVol: 0.28 });

/** 连麦忙碌垫音：交叉淡入淡出无缝循环，中间不能有「停一下再响」 */
function createBreathingLayer({ defaultVol = 0.1 } = {}) {
  let master = null;
  let buffer = null;
  let url = '';
  let keepAlive = false;
  let ducked = false;
  let listenQuiet = false;
  let targetVol = defaultVol;
  let playGen = 0;
  let schedTimer = null;
  let nextStart = 0;
  let voices = [];
  let kind = 'keyboard';
  let stopFadeTimer = null;
  const FADE_IN_SEC = 1.2;
  const FADE_OUT_SEC = 1.35;

  function mixedVol() {
    // 角色说话时 duck；开麦听人时略压，但仍可闻（不要压到听不见）
    return Math.max(0.0001, (ducked ? targetVol * 0.22 : targetVol) * (listenQuiet ? 0.45 : 1));
  }

  function apply({ fadeSec } = {}) {
    if (!master) return;
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    const vol = mixedVol();
    const sec = Number(fadeSec);
    try {
      master.gain.cancelScheduledValues(ctx.currentTime);
      if (Number.isFinite(sec) && sec > 0.05) {
        const cur = Math.max(0.0001, master.gain.value || 0.0001);
        master.gain.setValueAtTime(cur, ctx.currentTime);
        master.gain.linearRampToValueAtTime(vol, ctx.currentTime + sec);
      } else {
        master.gain.setTargetAtTime(vol, ctx.currentTime, 0.12);
      }
    } catch {
      master.gain.value = vol;
    }
  }

  function clearVoices() {
    while (voices.length) {
      const v = voices.shift();
      try { v.src.stop(); } catch {}
      try { v.src.disconnect(); } catch {}
      try { v.gain.disconnect(); } catch {}
    }
  }

  function stopSched() {
    if (schedTimer) {
      clearTimeout(schedTimer);
      schedTimer = null;
    }
  }

  function spawnAt(at) {
    const ctx = getSharedAudioContext();
    if (!ctx || !buffer || !master || !keepAlive) return;
    const overlap = Math.min(0.55, Math.max(0.22, buffer.duration * 0.12));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(master);
    const fadeInEnd = at + overlap;
    const fadeOutAt = at + Math.max(overlap + 0.05, buffer.duration - overlap);
    const endAt = at + buffer.duration;
    try {
      g.gain.setValueAtTime(0.0001, Math.max(ctx.currentTime, at));
      g.gain.linearRampToValueAtTime(1, Math.max(ctx.currentTime, fadeInEnd));
      g.gain.setValueAtTime(1, Math.max(ctx.currentTime, fadeOutAt));
      g.gain.linearRampToValueAtTime(0.0001, Math.max(ctx.currentTime + 0.02, endAt));
    } catch {
      g.gain.value = 1;
    }
    try { src.start(at); } catch { return; }
    voices.push({ src, gain: g });
    while (voices.length > 6) {
      const old = voices.shift();
      try { old.src.stop(); } catch {}
      try { old.src.disconnect(); } catch {}
      try { old.gain.disconnect(); } catch {}
    }
  }

  function schedule() {
    stopSched();
    const ctx = getSharedAudioContext();
    if (!keepAlive || !ctx || !buffer) return;
    const overlap = Math.min(0.55, Math.max(0.22, buffer.duration * 0.12));
    const period = Math.max(0.4, buffer.duration - overlap);
    if (nextStart < ctx.currentTime - 0.05) nextStart = ctx.currentTime;
    while (nextStart < ctx.currentTime + 2.8) {
      spawnAt(nextStart);
      nextStart += period;
    }
    const wait = Math.max(80, (nextStart - ctx.currentTime - 1.2) * 1000);
    schedTimer = setTimeout(schedule, wait);
  }

  function begin(buf) {
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    clearVoices();
    stopSched();
    buffer = buf;
    if (!master) {
      master = ctx.createGain();
      master.gain.value = 0.0001;
      master.connect(ctx.destination);
    }
    try {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(0.0001, ctx.currentTime);
      master.gain.linearRampToValueAtTime(mixedVol(), ctx.currentTime + FADE_IN_SEC);
    } catch {
      apply({ fadeSec: FADE_IN_SEC });
    }
    nextStart = ctx.currentTime;
    schedule();
  }

  function makeProcedural(k) {
    const ctx = getSharedAudioContext();
    if (!ctx) return null;
    const sr = ctx.sampleRate;
    const seconds = 8.5;
    const n = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    if (k === 'room' || k === 'sleep') {
      let pink = 0;
      for (let i = 0; i < n; i++) {
        const white = Math.random() * 2 - 1;
        pink = 0.98 * pink + 0.02 * white;
        const env = 0.35 + 0.65 * Math.sin((Math.PI * i) / n);
        d[i] = pink * 0.018 * env;
      }
    } else if (k === 'kitchen') {
      let t = 0.2;
      while (t < seconds - 0.2) {
        const i0 = Math.floor(t * sr);
        const clickLen = Math.floor(sr * (0.012 + Math.random() * 0.03));
        for (let i = 0; i < clickLen && i0 + i < n; i++) {
          const env = Math.exp(-i / (sr * 0.008));
          d[i0 + i] += (Math.random() * 2 - 1) * env * 0.03;
        }
        t += 0.6 + Math.random() * 1.8;
      }
      for (let i = 0; i < n; i++) d[i] += (Math.random() * 2 - 1) * 0.004;
    } else if (k === 'pencil') {
      let t = 0;
      while (t < seconds) {
        const burst = 0.1 + Math.random() * 0.4;
        const gap = 0.2 + Math.random() * 0.85;
        const start = Math.floor(t * sr);
        const end = Math.min(n, Math.floor((t + burst) * sr));
        for (let i = start; i < end; i++) {
          const local = (i - start) / Math.max(1, end - start);
          const env = Math.sin(Math.PI * local) * (0.012 + Math.random() * 0.01);
          d[i] += (Math.random() * 2 - 1) * env;
        }
        t += burst + gap;
      }
    } else {
      let t = 0.04;
      while (t < seconds - 0.04) {
        const i0 = Math.floor(t * sr);
        const clickLen = Math.floor(sr * (0.007 + Math.random() * 0.014));
        for (let i = 0; i < clickLen && i0 + i < n; i++) {
          const env = Math.exp(-i / (sr * 0.0038));
          d[i0 + i] += (Math.random() * 2 - 1) * env * (0.035 + Math.random() * 0.028);
        }
        t += (Math.random() < 0.72)
          ? (0.045 + Math.random() * 0.11)
          : (0.28 + Math.random() * 0.55);
      }
      // 轻房间底噪，掩盖循环接点
      for (let i = 0; i < n; i++) d[i] += (Math.random() * 2 - 1) * 0.0035;
    }
    return buf;
  }

  function revive() {
    if (!keepAlive) return;
    const ctx = getSharedAudioContext();
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    if (buffer) schedule();
  }

  function fadeOutThen(fn) {
    const ctx = getSharedAudioContext();
    if (!master || !ctx) {
      fn();
      return;
    }
    try {
      const cur = Math.max(0.0001, master.gain.value || 0.0001);
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(cur, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + FADE_OUT_SEC);
    } catch { /* ignore */ }
    stopFadeTimer = setTimeout(() => {
      stopFadeTimer = null;
      fn();
    }, Math.round(FADE_OUT_SEC * 1000));
  }

  return {
    play(rawUrl, { volume, procedural } = {}) {
      if (stopFadeTimer) {
        clearTimeout(stopFadeTimer);
        stopFadeTimer = null;
      }
      keepAlive = true;
      kind = String(procedural || kind || 'keyboard');
      targetVol = Number.isFinite(Number(volume)) && Number(volume) > 0
        ? Math.max(0.05, Math.min(0.18, Number(volume)))
        : defaultVol;
      const src = resolveMediaUrl(rawUrl) || rawUrl;
      if (!src) {
        const switching = !!master;
        const run = () => {
          const buf = makeProcedural(kind);
          if (buf) begin(buf);
        };
        if (switching) fadeOutThen(run);
        else run();
        return;
      }
      if (url === src && buffer) {
        apply({ fadeSec: 0.4 });
        revive();
        return;
      }
      const switching = !!(url && url !== src && master);
      if (switching) {
        const ctx = getSharedAudioContext();
        try {
          if (ctx && master) {
            const cur = Math.max(0.0001, master.gain.value || 0.0001);
            master.gain.cancelScheduledValues(ctx.currentTime);
            master.gain.setValueAtTime(cur, ctx.currentTime);
            master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + FADE_OUT_SEC);
          }
        } catch { /* ignore */ }
      }
      const fadeStartedAt = switching ? performance.now() : 0;
      url = src;
      const gen = ++playGen;
      decodeLoopBuffer(src).then((buf) => {
        if (gen !== playGen || !keepAlive || url !== src || !buf) return;
        const remain = switching
          ? Math.max(0, Math.round(FADE_OUT_SEC * 1000) - (performance.now() - fadeStartedAt))
          : 0;
        if (remain > 40) {
          stopFadeTimer = setTimeout(() => {
            stopFadeTimer = null;
            if (gen !== playGen || !keepAlive || url !== src) return;
            begin(buf);
          }, remain);
          return;
        }
        begin(buf);
      }).catch((e) => {
        console.warn('[tts] hangout bed decode', e?.message || e);
        if (gen !== playGen || !keepAlive) return;
        const fallback = makeProcedural(kind);
        if (fallback) begin(fallback);
      });
    },
    playProcedural(procedural, { volume } = {}) {
      if (stopFadeTimer) {
        clearTimeout(stopFadeTimer);
        stopFadeTimer = null;
      }
      keepAlive = true;
      kind = String(procedural || 'keyboard');
      const switching = !!master;
      url = '';
      targetVol = Number.isFinite(Number(volume)) && Number(volume) > 0
        ? Math.max(0.05, Math.min(0.18, Number(volume)))
        : defaultVol;
      const run = () => {
        const buf = makeProcedural(kind);
        if (buf) begin(buf);
      };
      if (switching) fadeOutThen(run);
      else run();
    },
    stop() {
      keepAlive = false;
      stopSched();
      if (stopFadeTimer) {
        clearTimeout(stopFadeTimer);
        stopFadeTimer = null;
      }
      const ctx = getSharedAudioContext();
      const gen = ++playGen;
      if (master && ctx) {
        try {
          const cur = Math.max(0.0001, master.gain.value || 0.0001);
          master.gain.cancelScheduledValues(ctx.currentTime);
          master.gain.setValueAtTime(cur, ctx.currentTime);
          master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + FADE_OUT_SEC);
        } catch {}
        stopFadeTimer = setTimeout(() => {
          stopFadeTimer = null;
          if (gen !== playGen) return;
          clearVoices();
          url = '';
          buffer = null;
          ducked = false;
          listenQuiet = false;
          targetVol = defaultVol;
          if (master) {
            try { master.disconnect(); } catch {}
            master = null;
          }
        }, Math.round(FADE_OUT_SEC * 1000) + 60);
      } else {
        clearVoices();
        url = '';
        buffer = null;
        ducked = false;
        listenQuiet = false;
        targetVol = defaultVol;
        if (master) {
          try { master.disconnect(); } catch {}
          master = null;
        }
      }
    },
    setDucked(on) {
      ducked = !!on;
      apply({ fadeSec: 0.28 });
    },
    setListenQuiet(on) {
      listenQuiet = !!on;
      apply({ fadeSec: 0.35 });
    },
    revive,
  };
}

const hangoutBed = createBreathingLayer({ defaultVol: 0.1 });

export function playCallAmbient(url, opts) {
  const src = resolveMediaUrl(url) || url;
  const vol = Number.isFinite(Number(opts?.volume)) ? Number(opts.volume) : undefined;
  // App 通话：垫音走原生 MediaPlayer（与角色 TTS 同通话声道），角色开口时不会被系统停掉
  if (nativeCallBedPlay && src) {
    nativeBedActive = true;
    try { roomAmbient.stop(); } catch {}
    Promise.resolve(nativeCallBedPlay(src, vol)).catch((e) => {
      console.warn('[tts] native bed fallback', e?.message || e);
      nativeBedActive = false;
      roomAmbient.play(url, opts);
    });
    return;
  }
  nativeBedActive = false;
  roomAmbient.play(url, opts);
}

export function playCallBreathBed(url, opts) {
  breathBed.play(url, opts);
}

export function playCallTextureBed(url, opts) {
  if (sfxMix().close <= 0.001) {
    textureBed.stop();
    return;
  }
  textureBed.play(url, opts);
}

export function playHangoutBed(url, opts) {
  hangoutBed.play(url, opts);
}

export function playHangoutBedProcedural(kind, opts) {
  hangoutBed.playProcedural(kind, opts);
}

export function ensureCallAmbientPlaying() {
  if (!nativeBedActive) roomAmbient.revive();
  breathBed.revive();
  textureBed.revive();
  hangoutBed.revive();
}

export function stopCallAmbient() {
  if (nativeCallBedStop) {
    try { nativeCallBedStop(); } catch {}
  }
  nativeBedActive = false;
  roomAmbient.stop();
}

export function stopCallBodyBeds() {
  breathBed.stop();
  textureBed.stop();
}

export function stopHangoutBed() {
  hangoutBed.stop();
}

export function duckCallAmbient(on) {
  // 角色开口不再压现场垫音（含原生轨）；仅贴身/连麦垫音可按需压
  if (!on) {
    roomAmbient.setDucked(false);
  } else if (!nativeBedActive) {
    roomAmbient.setDucked(true);
  }
  breathBed.setDucked(on);
  textureBed.setDucked(on);
  hangoutBed.setDucked(on);
}

/** 连麦开麦听人时把忙碌垫音压到几乎听不见，避免当成用户说话 */
export function setHangoutBedListenQuiet(on) {
  hangoutBed.setListenQuiet(on);
}

export function refreshCallSfxMix() {
  roomAmbient.reapply();
  breathBed.reapply();
  textureBed.reapply();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ensureCallAmbientPlaying();
  });
  window.addEventListener('pageshow', () => ensureCallAmbientPlaying());
  window.addEventListener('focus', () => ensureCallAmbientPlaying());
}

let oneshotAudio = null;
let oneshotFadeTimer = null;

function clearOneshotFade() {
  if (oneshotFadeTimer) {
    clearInterval(oneshotFadeTimer);
    oneshotFadeTimer = null;
  }
}

export function playCallOneShot(url) {
  const src = resolveMediaUrl(url) || url;
  if (!src) return;
  const vol = sfxMix().oneshot;
  if (vol <= 0.001) return;
  clearOneshotFade();
  if (oneshotAudio) {
    try { oneshotAudio.pause(); oneshotAudio.src = ''; } catch {}
    oneshotAudio = null;
  }
  const a = new Audio(src);
  a.loop = false;
  a.volume = 0;
  const target = Math.max(0, Math.min(1, vol));
  a.play().catch(() => {});
  oneshotAudio = a;
  const fadeInMs = 480;
  const t0 = performance.now();
  oneshotFadeTimer = setInterval(() => {
    if (oneshotAudio !== a) {
      clearOneshotFade();
      return;
    }
    const p = Math.min(1, (performance.now() - t0) / fadeInMs);
    try { a.volume = target * p; } catch {}
    if (p >= 1) clearOneshotFade();
  }, 32);
  a.ontimeupdate = () => {
    if (oneshotAudio !== a) return;
    const dur = a.duration;
    if (!Number.isFinite(dur) || dur < 0.6) return;
    const left = dur - a.currentTime;
    if (left < 0.85 && left >= 0) {
      try { a.volume = Math.max(0, target * (left / 0.85)); } catch {}
    }
  };
  a.onended = () => {
    if (oneshotAudio === a) oneshotAudio = null;
    clearOneshotFade();
  };
}

export function stopCallOneShot() {
  clearOneshotFade();
  const a = oneshotAudio;
  if (!a) return;
  const startVol = Math.max(0, a.volume || 0);
  if (startVol <= 0.02) {
    try { a.pause(); a.src = ''; } catch {}
    oneshotAudio = null;
    return;
  }
  const t0 = performance.now();
  const fadeMs = 700;
  oneshotFadeTimer = setInterval(() => {
    const p = Math.min(1, (performance.now() - t0) / fadeMs);
    try { a.volume = startVol * (1 - p); } catch {}
    if (p >= 1) {
      clearOneshotFade();
      try { a.pause(); a.src = ''; } catch {}
      if (oneshotAudio === a) oneshotAudio = null;
    }
  }, 32);
}

export function isPlaying() {
  return !!currentAudio && !currentAudio.paused;
}

function soundSetting(key) {
  try {
    const s = window.getAppSettings?.() || {};
    return String(s[key] || '').trim();
  } catch {
    return '';
  }
}

export function useSystemCallRingtone(settings) {
  try {
    const s = settings || window.getAppSettings?.() || {};
    const v = String(s.sound_call_system ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
  } catch {
    return false;
  }
}

function playCustomSoundOnce(url) {
  const src = resolveMediaUrl(url) || url;
  if (!src) return false;
  try {
    const audio = new Audio(src);
    audio.volume = 0.95;
    audio.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

let _callRingAudio = null;
let nativeRingPlay = null;
let nativeRingStop = null;

export function setNativeCallRingHandlers({ play, stop } = {}) {
  nativeRingPlay = typeof play === 'function' ? play : null;
  nativeRingStop = typeof stop === 'function' ? stop : null;
}

export function stopCallRingtone() {
  if (_callRingAudio) {
    try { _callRingAudio.pause(); } catch {}
    _callRingAudio = null;
  }
  try { nativeRingStop?.(); } catch {}
}

export function playCallRingtone(url, opts = {}) {
  stopCallRingtone();
  const useSystem = opts.system === true
    || (opts.system !== false && useSystemCallRingtone());
  if (useSystem && nativeRingPlay) {
    const handle = nativeRingPlay({ systemRing: true, url: '' });
    _callRingAudio = {
      pause() { try { nativeRingStop?.(); } catch {} },
    };
    if (handle && typeof handle.catch === 'function') handle.catch(() => {});
    return;
  }
  const raw = String(url || soundSetting('sound_call') || '').trim();
  const src = raw ? (resolveMediaUrl(raw) || raw) : '';
  if (src) {
    try {
      const audio = new Audio(src);
      audio.loop = true;
      audio.volume = 0.95;
      _callRingAudio = audio;
      audio.play().catch(() => {});
      return;
    } catch {}
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 440;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.11, ctx.currentTime);
    osc.start();
    _callRingAudio = {
      pause() {
        try { osc.stop(); } catch {}
        try { ctx.close(); } catch {}
      },
    };
  } catch {}
}

// 消息提示音
export function playNotifySound() {
  const custom = soundSetting('sound_notify');
  if (custom && playCustomSoundOnce(custom)) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.14, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {}
}

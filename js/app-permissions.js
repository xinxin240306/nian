import { resolveMediaUrl } from './server-config.js';
import { setTtsPreferCallSink, setNativeCallPlayHandlers, setNativeCallRingHandlers, setNativeCallBedHandlers } from './tts.js';

const ASKED_KEY = 'nian_asked_basic_perms';

function plugin() {
  return window.Capacitor?.Plugins?.AppPermissions;
}

export function hasAppPermissionsPlugin() {
  return Boolean(plugin()?.getStatus);
}

function fallbackHaptic(kind) {
  try {
    if (kind === 'tick') navigator.vibrate?.(14);
    else navigator.vibrate?.(42);
  } catch { /* ignore */ }
}

/** tick=按住确认，press=长按触发。App 里走系统按键触感，网页退回 vibrate。 */
export function nianHaptic(kind = 'press') {
  const p = plugin();
  if (p?.haptic) {
    p.haptic({ kind }).catch(() => fallbackHaptic(kind));
    return;
  }
  fallbackHaptic(kind);
}

export async function getAppPermissionStatus() {
  const p = plugin();
  if (!p?.getStatus) {
    return { native: false };
  }
  return { native: true, ...(await p.getStatus()) };
}

export async function requestBasicNativePermissions() {
  const p = plugin();
  if (p?.requestBasic) return p.requestBasic();
  return null;
}

export async function requestNativeMicrophone() {
  const p = plugin();
  if (p?.requestMicrophone) return p.requestMicrophone();
  return null;
}

export async function requestNativeCamera() {
  const p = plugin();
  if (p?.requestCamera) return p.requestCamera();
  return null;
}

export async function requestNativeLocation() {
  const p = plugin();
  if (p?.requestLocation) return p.requestLocation();
  return null;
}

export async function getNativeCurrentLocation() {
  const p = plugin();
  if (!p?.getCurrentLocation) return null;
  try {
    return await p.getCurrentLocation();
  } catch (e) {
    return { ok: false, error: String(e?.message || e || '') };
  }
}

export function formatLocationError(err) {
  const inApp = window.isNativeShell?.();
  const code = Number(err?.code) || 0;
  const msg = String(err?.message || '');
  if (code === 1 || /denied|permission|访问位置/i.test(msg)) {
    return inApp
      ? '获取位置失败：请允许「念」访问位置'
      : '获取位置失败：请允许浏览器访问位置权限';
  }
  if (/location_off|定位服务/i.test(msg)) {
    return '获取位置失败：请先打开手机的定位服务';
  }
  if (code === 3 || /timeout/i.test(msg)) {
    return '获取位置失败：定位超时，请重试';
  }
  if (code === 2) return '获取位置失败：无法获取位置信息';
  return '获取位置失败：' + (msg || '未知错误');
}

export async function getDeviceCoordinates() {
  if (window.isNativeShell?.() && plugin()?.requestLocation && plugin()?.getCurrentLocation) {
    try {
      const s = await getAppPermissionStatus();
      if (!s?.location) {
        const after = await requestNativeLocation();
        if (!after?.location) {
          const err = new Error('请允许「念」访问位置');
          err.code = 1;
          throw err;
        }
      }
      const native = await getNativeCurrentLocation();
      if (native?.ok !== false && native?.latitude != null && native?.longitude != null) {
        return { latitude: Number(native.latitude), longitude: Number(native.longitude) };
      }
      const nativeErr = String(native?.error || '');
      if (nativeErr === 'location_off') {
        const err = new Error('请先打开手机的定位服务');
        err.code = 2;
        throw err;
      }
      if (nativeErr === 'location_denied') {
        const err = new Error('请允许「念」访问位置');
        err.code = 1;
        throw err;
      }
      if (nativeErr === 'location_timeout') {
        const err = new Error('定位超时，请重试');
        err.code = 3;
        throw err;
      }
    } catch (e) {
      if (e?.code === 1 || e?.code === 2 || e?.code === 3) throw e;
    }
  }

  return await new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(Object.assign(new Error('当前环境不支持定位'), { code: 2 }));
      return;
    }
    if (!window.isNativeShell?.() && !window.isSecureContext) {
      reject(Object.assign(new Error('定位需要在 HTTPS 或 localhost 环境下使用'), { code: 2 }));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => reject(err),
      { timeout: 20000, maximumAge: 60000, enableHighAccuracy: true }
    );
  });
}

export async function requestAppNotifications() {
  const p = plugin();
  if (p?.requestNotifications) return p.requestNotifications();
  return null;
}

export async function openNotificationListenerSettings() {
  return plugin()?.openNotificationListenerSettings?.();
}

export async function listNativeNotifications() {
  const p = plugin();
  if (!p?.listNotifications) return { native: false, items: [] };
  return { native: true, ...(await p.listNotifications()) };
}

export async function getNativeDeviceStatus() {
  const p = plugin();
  if (!p?.getDeviceStatus) return { native: false };
  return { native: true, ...(await p.getDeviceStatus()) };
}

export async function dumpNativeScreen() {
  const p = plugin();
  if (!p?.dumpScreen) return { native: false };
  return { native: true, ...(await p.dumpScreen()) };
}

export async function captureNativeScreen() {
  const p = plugin();
  if (!p?.captureScreen) return { native: false, ok: false };
  return { native: true, ...(await p.captureScreen()) };
}

export async function controlNativeScreen(opts = {}) {
  const p = plugin();
  if (!p?.controlScreen) return { native: false, ok: false, error: 'no_plugin' };
  return { native: true, ...(await p.controlScreen(opts)) };
}

export async function requestIgnoreBatteryOptimizations() {
  return plugin()?.requestIgnoreBatteryOptimizations?.();
}

export async function openOverlaySettings() {
  return plugin()?.openOverlaySettings?.();
}

export async function openAccessibilitySettings() {
  return plugin()?.openAccessibilitySettings?.();
}

export async function openUsageAccessSettings() {
  return plugin()?.openUsageAccessSettings?.();
}

export async function requestActivityRecognition() {
  return plugin()?.requestActivityRecognition?.();
}

export async function requestHealthConnect() {
  return plugin()?.requestHealthConnect?.();
}

export async function openHealthConnectSettings() {
  return plugin()?.openHealthConnectSettings?.();
}

export async function refreshNativeHealth() {
  const p = plugin();
  if (!p?.refreshHealth) return { native: false };
  return { native: true, ...(await p.refreshHealth()) };
}

export async function setForegroundKeepAlive(enabled) {
  return plugin()?.setForeground?.({ enabled: !!enabled });
}

export async function setNativeBridgeConfig(serverBase, sessionToken) {
  return plugin()?.setBridgeConfig?.({
    serverBase: String(serverBase || ''),
    sessionToken: String(sessionToken || ''),
  });
}

export async function syncNativeTogetherWidget({
  characterId = 0,
  name = 'TA',
  togetherSince = '',
  daysTogether = 0,
  moodPrimary = '',
  moodLabel = '',
  moodEmoji = '',
  activity = '',
  asleep = false,
} = {}) {
  const p = plugin();
  if (!p?.syncTogetherWidget) return false;
  try {
    await p.syncTogetherWidget({
      characterId: Number(characterId) || 0,
      name: String(name || 'TA'),
      togetherSince: String(togetherSince || '').slice(0, 10),
      daysTogether: Number(daysTogether) || 0,
      moodPrimary: String(moodPrimary || ''),
      moodLabel: String(moodLabel || ''),
      moodEmoji: String(moodEmoji || ''),
      activity: String(activity || '').slice(0, 40),
      asleep: !!asleep,
    });
    return true;
  } catch {
    return false;
  }
}

export async function refreshNativeTogetherWidget() {
  const p = plugin();
  if (!p?.refreshTogetherWidget) return false;
  try {
    await p.refreshTogetherWidget();
    return true;
  } catch {
    return false;
  }
}

export async function pinNativeTogetherWidget() {
  const p = plugin();
  if (!p?.pinTogetherWidget) {
    throw new Error('当前环境不支持桌面小组件');
  }
  return p.pinTogetherWidget();
}

export async function setNativeHaloCharacter({ characterId, name } = {}) {
  const p = plugin();
  if (!p?.setHaloCharacter) return false;
  try {
    await p.setHaloCharacter({
      characterId: Number(characterId) || 0,
      name: String(name || 'TA'),
    });
    return true;
  } catch {
    return false;
  }
}

export async function tryShowNativeIncomingCall({ characterId, name, avatar, content, ringtone, logId, ringMs, systemRing } = {}) {
  const p = plugin();
  if (!p?.showIncomingCall) return false;
  try {
    const r = await p.showIncomingCall({
      characterId: Number(characterId) || 0,
      name: String(name || 'TA'),
      avatar: resolveMediaUrl(avatar || '') || String(avatar || ''),
      content: String(content || ''),
      ringtone: resolveMediaUrl(ringtone || '') || String(ringtone || ''),
      logId: Number(logId) || 0,
      ringMs: Number(ringMs) || 35000,
      systemRing: !!systemRing,
    });
    return !!r?.shown;
  } catch {
    return false;
  }
}

export async function playNativeCallRing({ systemRing = false, url = '' } = {}) {
  const p = plugin();
  if (!p?.playCallRing) return false;
  try {
    await p.playCallRing({
      systemRing: !!systemRing,
      url: resolveMediaUrl(url || '') || String(url || ''),
    });
    return true;
  } catch {
    return false;
  }
}

export async function stopNativeCallRing() {
  try { await plugin()?.stopCallRing?.(); } catch {}
}

try {
  setNativeCallRingHandlers({
    play: (opts) => playNativeCallRing(opts),
    stop: () => stopNativeCallRing(),
  });
} catch {}

export async function dismissNativeIncomingCall() {
  return plugin()?.dismissIncomingCall?.();
}

export async function tryShowNativeCapsule({ characterId, name, text, avatar, bubbles } = {}) {
  const p = plugin();
  if (!p?.showCapsule) return false;
  try {
    const payload = {
      characterId: Number(characterId) || 0,
      name: String(name || 'TA'),
      text: String(text || ''),
      avatar: resolveMediaUrl(avatar || '') || '',
    };
    if (Array.isArray(bubbles) && bubbles.length) payload.bubbles = bubbles;
    const r = await p.showCapsule(payload);
    return !!r?.shown;
  } catch {
    return false;
  }
}

export async function hideNativeCapsule() {
  return plugin()?.hideCapsule?.();
}

export async function showNativeScreenShare({ characterId, name } = {}) {
  const p = plugin();
  if (!p?.showScreenShare) return false;
  try {
    const r = await p.showScreenShare({
      characterId: Number(characterId) || 0,
      name: String(name || 'TA'),
    });
    return !!r?.shown;
  } catch {
    return false;
  }
}

export async function setNativeCallOverlay(opts = {}) {
  const p = plugin();
  if (!p?.setCallOverlay) return false;
  try {
    const phase = String(opts.phase || (opts.speaking ? 'speaking' : 'idle'));
    await p.setCallOverlay({
      on: !!opts.on,
      video: !!opts.video,
      avatar: resolveMediaUrl(opts.avatar || '') || String(opts.avatar || ''),
      clip: resolveMediaUrl(opts.clip || '') || String(opts.clip || ''),
      facing: String(opts.facing || ''),
      characterId: Number(opts.characterId) || 0,
      name: String(opts.name || 'TA'),
      speaking: !!opts.speaking || phase === 'speaking',
      phase,
    });
    return true;
  } catch {
    return false;
  }
}

export async function setNativeCallMediaAudio(on = true) {
  const p = plugin();
  if (!p?.setCallMediaAudio) {
    try { setTtsPreferCallSink(false); } catch {}
    return { ok: false };
  }
  try {
    const r = await p.setCallMediaAudio({ on: !!on });
    // 只要原生通话播放器还在，就走原生 TTS；不要只在耳机时才开，否则锁屏后 HTML Audio 会被掐
    try {
      if (on) setTtsPreferCallSink(true);
      else setTtsPreferCallSink(false);
    } catch {}
    return { ok: true, ...r };
  } catch {
    try { setTtsPreferCallSink(false); } catch {}
    return { ok: false };
  }
}

let _nativeCallRms = 0;
let _nativeCallRmsAt = 0;
let _nativeCallLevelHandle = null;

export function hasNativeCallAudio() {
  return Boolean(plugin()?.startNativeCall);
}

export function nativeCallRms() {
  return _nativeCallRms;
}

export function nativeCallLevelAge() {
  return _nativeCallRmsAt ? Date.now() - _nativeCallRmsAt : 1e9;
}

async function bindNativeCallLevel() {
  const p = plugin();
  if (!p?.addListener) return;
  try {
    if (_nativeCallLevelHandle?.remove) await _nativeCallLevelHandle.remove();
  } catch {}
  _nativeCallLevelHandle = null;
  try {
    _nativeCallLevelHandle = await p.addListener('callLevel', (e) => {
      _nativeCallRms = Number(e?.rms) || 0;
      _nativeCallRmsAt = Date.now();
    });
  } catch {}
}

export async function startNativeCall() {
  const p = plugin();
  if (!p?.startNativeCall) return { ok: false };
  await bindNativeCallLevel();
  setNativeCallPlayHandlers({
    play: (url, volume) => playNativeCallUrl(url, volume),
    stop: () => stopNativeCallPlay(),
  });
  setNativeCallBedHandlers({
    play: (url, volume) => playNativeCallBed(url, volume),
    stop: () => stopNativeCallBed(),
  });
  try {
    const r = await p.startNativeCall();
    setTtsPreferCallSink(true);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e?.message || 'native_call_failed' };
  }
}

export async function pullNativeCallRms() {
  const p = plugin();
  if (!p?.getNativeCallLevel) return _nativeCallRms;
  try {
    const r = await p.getNativeCallLevel();
    const rms = Number(r?.rms);
    if (Number.isFinite(rms)) {
      _nativeCallRms = rms;
      _nativeCallRmsAt = Date.now();
    }
  } catch {}
  return _nativeCallRms;
}

export async function noteNativeCallListenTick({ silenceMs = 3000, maxMs = 20000, speechRms = 0.02 } = {}) {
  const p = plugin();
  if (!p?.noteCallListenTick) return null;
  try {
    const r = await p.noteCallListenTick({
      silenceMs: Math.round(Number(silenceMs) || 3000),
      maxMs: Math.round(Number(maxMs) || 20000),
      speechRms: Number(speechRms) || 0.02,
    });
    const rms = Number(r?.rms);
    if (Number.isFinite(rms)) {
      _nativeCallRms = rms;
      _nativeCallRmsAt = Date.now();
    }
    return r;
  } catch {
    return null;
  }
}

export async function stopNativeCall() {
  _nativeCallRms = 0;
  _nativeCallRmsAt = 0;
  try {
    if (_nativeCallLevelHandle?.remove) await _nativeCallLevelHandle.remove();
  } catch {}
  _nativeCallLevelHandle = null;
  try { await stopNativeCallBed(); } catch {}
  setNativeCallPlayHandlers({});
  setNativeCallBedHandlers({});
  setTtsPreferCallSink(false);
  const p = plugin();
  if (!p?.stopNativeCall) return { ok: false };
  try {
    return { ok: true, ...(await p.stopNativeCall()) };
  } catch {
    return { ok: false };
  }
}

export async function setNativeCallListen(on = true, { ambient = false, bargeIn = false } = {}) {
  const p = plugin();
  if (!p?.setNativeCallListen) return false;
  try {
    await p.setNativeCallListen({ on: !!on, ambient: !!ambient, bargeIn: !!bargeIn });
    return true;
  } catch {
    return false;
  }
}

/** 连麦周期环境采样：原生墙钟间隔（毫秒）。0=关。锁屏后仍能触发。 */
export async function setNativeAmbientSampleInterval(intervalMs = 0) {
  const p = plugin();
  if (!p?.setNativeCallAmbientSample) return false;
  try {
    await p.setNativeCallAmbientSample({ intervalMs: Math.max(0, Math.round(Number(intervalMs) || 0)) });
    return true;
  } catch {
    return false;
  }
}

export async function ackNativeAmbientSample() {
  const p = plugin();
  if (!p?.ackNativeCallAmbientSample) return false;
  try {
    await p.ackNativeCallAmbientSample();
    return true;
  } catch {
    return false;
  }
}

export async function beginNativeCallUtterance() {
  const p = plugin();
  if (!p?.beginNativeCallUtterance) return false;
  try {
    await p.beginNativeCallUtterance();
    return true;
  } catch {
    return false;
  }
}

export async function abortNativeCallUtterance() {
  const p = plugin();
  if (!p?.abortNativeCallUtterance) return false;
  try {
    await p.abortNativeCallUtterance();
    return true;
  } catch {
    return false;
  }
}

export async function commitNativeCallUtterance() {
  const p = plugin();
  if (!p?.commitNativeCallUtterance) return null;
  try {
    return await p.commitNativeCallUtterance();
  } catch {
    return null;
  }
}

function bytesToBase64(u8) {
  const chunk = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

export async function playNativeCallUrl(url, volume) {
  const p = plugin();
  if (!p?.playNativeCallUrl) throw new Error('当前环境不支持原生通话播放');
  const src = String(url || '');
  if (!src) throw new Error('empty_audio');
  const vol = Number.isFinite(Number(volume))
    ? Math.max(0.05, Math.min(2, Number(volume)))
    : null;
  const abs = resolveMediaUrl(src) || src;
  // http(s) 交给原生 MediaPlayer 直接拉，少一次 WebView fetch（锁屏更稳）
  if (/^https?:\/\//i.test(abs) && !/\.blob\./i.test(abs)) {
    await p.playNativeCallUrl({ url: abs, ...(vol != null ? { volume: vol } : {}) });
    return;
  }
  try {
    const resp = await fetch(src);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 80 && p.playNativeCallData) {
      const b64 = bytesToBase64(new Uint8Array(buf));
      const mime = resp.headers.get('content-type') || guessPlayMime(src);
      await p.playNativeCallData({
        base64: b64,
        mime,
        ...(vol != null ? { volume: vol } : {}),
      });
      return;
    }
  } catch (e) {
    if (/^(blob:|data:)/i.test(src)) throw e;
  }
  if (/^(blob:|data:)/i.test(src)) throw new Error('play_failed');
  await p.playNativeCallUrl({ url: abs || src, ...(vol != null ? { volume: vol } : {}) });
}

function guessPlayMime(src) {
  if (/\.wav(\?|$)/i.test(src)) return 'audio/wav';
  if (/\.(m4a|mp4)(\?|$)/i.test(src)) return 'audio/mp4';
  if (/\.ogg(\?|$)/i.test(src)) return 'audio/ogg';
  return 'audio/mpeg';
}

export async function stopNativeCallPlay() {
  const p = plugin();
  if (!p?.stopNativeCallPlay) return;
  try { await p.stopNativeCallPlay(); } catch {}
}

/** 通话现场循环垫音（原生轨，可与角色 TTS 同时出声） */
export async function playNativeCallBed(url, volume) {
  const p = plugin();
  if (!p?.playNativeCallBed) return false;
  const src = String(url || '');
  if (!src) return false;
  const vol = Number.isFinite(Number(volume))
    ? Math.max(0.02, Math.min(1, Number(volume)))
    : 0.35;
  const abs = resolveMediaUrl(src) || src;
  try {
    await p.playNativeCallBed({ url: abs, volume: vol });
    return true;
  } catch {
    return false;
  }
}

export async function stopNativeCallBed() {
  const p = plugin();
  if (!p?.stopNativeCallBed) return;
  try { await p.stopNativeCallBed(); } catch {}
}

export async function setNativeCallPreviewFrame(imageDataUrl) {
  const p = plugin();
  if (!p?.setCallPreviewFrame) return false;
  try {
    await p.setCallPreviewFrame({ imageDataUrl: String(imageDataUrl || '') });
    return true;
  } catch {
    return false;
  }
}

export async function hideNativeScreenShare() {
  return plugin()?.hideScreenShare?.();
}

export async function goNativeHome() {
  const p = plugin();
  if (!p?.goHome) return false;
  try {
    await p.goHome();
    return true;
  } catch {
    return false;
  }
}

export async function requestScreenCapture() {
  return plugin()?.requestScreenCapture?.();
}

export async function openNativeAppSettings() {
  return plugin()?.openAppSettings?.();
}

export async function requestShizuku() {
  return plugin()?.requestShizuku?.();
}

export async function openShizukuApp() {
  return plugin()?.openShizuku?.();
}

export async function applyShizukuHelpers() {
  return plugin()?.applyShizukuHelpers?.();
}

export async function openExactAlarmSettings() {
  return plugin()?.openExactAlarmSettings?.();
}

export async function openExternalUrl(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  const p = plugin();
  if (p?.openUrl) {
    await p.openUrl({ url: s });
    return true;
  }
  if (!/^https?:/i.test(s)) return false;
  const opened = window.open(s, '_blank');
  return !!opened;
}

export async function handleNativeAlarm(opts = {}) {
  const p = plugin();
  if (!p?.handleAlarm) return { native: false, ok: false, error: 'no_plugin' };
  return { native: true, ...(await p.handleAlarm(opts)) };
}

export async function toyStatus() {
  const p = plugin();
  if (!p?.toyStatus) return { native: false, ok: false, error: 'no_plugin' };
  return { native: true, ...(await p.toyStatus()) };
}

export async function toyScan() {
  const p = plugin();
  if (!p?.toyScan) return { native: false, ok: false, error: 'no_plugin' };
  return { native: true, ...(await p.toyScan()) };
}

export async function toyConnect(address, name) {
  const p = plugin();
  if (!p?.toyConnect) return { native: false, ok: false, error: 'no_plugin' };
  return { native: true, ...(await p.toyConnect({ address, name: name || '' })) };
}

export async function toyDisconnect() {
  const p = plugin();
  if (!p?.toyDisconnect) return { native: false, ok: false, error: 'no_plugin' };
  return { native: true, ...(await p.toyDisconnect()) };
}

export async function toyApply(opts = {}) {
  const p = plugin();
  if (!p?.toyApply) return { native: false, ok: false, error: 'no_plugin' };
  return { native: true, ...(await p.toyApply(opts)) };
}

/** 首次进入套壳 App：弹通知/相机/麦克风/存储，再弹电池优化 */
export async function promptBasicNativePermissionsOnce() {
  if (!window.isNativeShell?.() || !hasAppPermissionsPlugin()) return;
  try {
    if (localStorage.getItem(ASKED_KEY) === '1') return;
    localStorage.setItem(ASKED_KEY, '1');
    await requestBasicNativePermissions();
    await requestIgnoreBatteryOptimizations();
  } catch (e) {
    console.warn('[perms] basic prompt', e);
  }
}

import { postPhoneNotifications, postPhoneScreen, postPhoneLocation } from './api.js';
import { isNativeShell, getServerBase, getSiteSessionToken } from './server-config.js';
import {
  listNativeNotifications,
  getNativeDeviceStatus,
  dumpNativeScreen,
  captureNativeScreen,
  controlNativeScreen,
  getAppPermissionStatus,
  getDeviceCoordinates,
  showNativeScreenShare,
  hideNativeScreenShare,
  handleNativeAlarm,
  toyApply,
  refreshNativeHealth,
} from './app-permissions.js';

const SYNC_MS = 12 * 1000;
let _timer = 0;
let _busy = false;
let _started = false;
let _eventTimer = 0;
let _screenBusy = false;
let _nativeTick = false;

function persistBridgeConfig() {
  try {
    window.Capacitor?.Plugins?.AppPermissions?.setBridgeConfig?.({
      serverBase: getServerBase(),
      sessionToken: getSiteSessionToken(),
    });
  } catch {}
}

async function refreshNativeTick() {
  try {
    const s = await getAppPermissionStatus();
    _nativeTick = !!s.foreground;
  } catch {
    _nativeTick = false;
  }
}

function scheduleSync() {
  if (_eventTimer) return;
  _eventTimer = window.setTimeout(() => {
    _eventTimer = 0;
    syncOnce();
  }, 400);
}

async function syncOnce() {
  if (_busy || !isNativeShell()) return;
  _busy = true;
  persistBridgeConfig();
  refreshNativeTick();
  try {
    const snap = await listNativeNotifications();
    if (!snap?.native) return;
    let device = null;
    let usage = null;
    let health = null;
    let apps = null;
    try {
      const st = await getNativeDeviceStatus();
      if (st?.native) {
        device = {
          battery: st.battery,
          charging: !!st.charging,
          screenOn: st.screenOn !== false,
          locked: !!st.locked,
          inApp: !!st.inApp,
          package: st.package || '',
          app: st.app || '',
        };
        if (st.usage && typeof st.usage === 'object') usage = st.usage;
        if (st.health && typeof st.health === 'object') health = st.health;
        if (st.apps && typeof st.apps === 'object') apps = st.apps;
      }
    } catch {}
    await postPhoneNotifications({
      listenerEnabled: !!snap.listenerEnabled,
      connected: !!snap.connected,
      items: Array.isArray(snap.items) ? snap.items : [],
      device,
      usage,
      health,
      apps,
    });
  } catch (e) {
    console.warn('[phone] sync', e.message || e);
  } finally {
    _busy = false;
  }
}

async function handleScreenCommand(data) {
  if (!isNativeShell()) return;
  if (_screenBusy) {
    try {
      await postPhoneScreen({ requestId: data.requestId, ok: false, error: 'busy' });
    } catch {}
    return;
  }
  _screenBusy = true;
  const requestId = String(data.requestId || '');
  const wantLook = String(data.mode || 'read') === 'look';
  try {
    const dump = await dumpNativeScreen();
    const a11yOn = !!(dump?.accessibilityEnabled && dump?.connected);
    let imageDataUrl = '';
    if (wantLook) {
      try {
        const cap = await captureNativeScreen();
        if (cap?.ok && cap.imageBase64) {
          imageDataUrl = `data:${cap.mime || 'image/jpeg'};base64,${cap.imageBase64}`;
        }
      } catch (e) {
        console.warn('[phone] screencap', e.message || e);
      }
    }
    if (!a11yOn && !imageDataUrl) {
      await postPhoneScreen({ requestId, ok: false, error: 'a11y_off' });
      return;
    }
    await postPhoneScreen({
      requestId,
      ok: true,
      accessibility: a11yOn,
      screenshot: !!imageDataUrl,
      package: dump?.package || '',
      app: dump?.app || '',
      tree: dump?.tree || '',
      imageDataUrl: imageDataUrl || undefined,
    });
  } catch (e) {
    try {
      await postPhoneScreen({ requestId, ok: false, error: e.message || 'failed' });
    } catch {}
  } finally {
    _screenBusy = false;
  }
}

async function handleControlCommand(data) {
  if (!isNativeShell()) return;
  const requestId = String(data.requestId || '');
  if (!requestId) return;
  if (_screenBusy) {
    try { await postPhoneScreen({ requestId, ok: false, error: 'busy' }); } catch {}
    return;
  }
  _screenBusy = true;
  try {
    const r = await controlNativeScreen({
      action: data.action,
      text: data.text,
      x: data.x,
      y: data.y,
      x2: data.x2,
      y2: data.y2,
      durationMs: data.durationMs,
    });
    await postPhoneScreen({
      requestId,
      ok: r?.ok !== false,
      error: r?.error || '',
      package: r?.package || '',
      app: r?.app || '',
      tree: r?.tree || '',
      targets: r?.targets || '',
      matches: r?.matches,
      accessibility: r?.accessibility !== false,
    });
  } catch (e) {
    try { await postPhoneScreen({ requestId, ok: false, error: e.message || 'failed' }); } catch {}
  } finally {
    _screenBusy = false;
  }
}

async function handleAlarmCommand(data) {
  if (!isNativeShell()) return;
  const requestId = String(data.requestId || '');
  if (!requestId) return;
  try {
    const r = await handleNativeAlarm(data);
    let alarms = r?.alarms || [];
    if (typeof alarms === 'string') {
      try { alarms = JSON.parse(alarms); } catch { alarms = []; }
    }
    await postPhoneScreen({
      requestId,
      ok: r?.ok !== false,
      error: r?.error || '',
      alarmId: r?.alarmId || 0,
      when: r?.when || 0,
      hasVoice: !!r?.hasVoice,
      alarms: r?.alarms || [],
    });
  } catch (e) {
    try { await postPhoneScreen({ requestId, ok: false, error: e.message || 'failed' }); } catch {}
  }
}

async function handleToyCommand(data) {
  if (!isNativeShell()) return;
  const requestId = String(data.requestId || '');
  try {
    const r = await toyApply({
      action: data.action || 'set',
      suction: data.suction,
      vibration: data.vibration,
      electric: data.electric,
      duration: data.duration,
      ramp: data.ramp,
      steps: Array.isArray(data.steps) ? data.steps : undefined,
    });
    await postPhoneScreen({
      requestId,
      ok: !!(r?.ready || r?.connected || data.action === 'status'),
      error: r?.error || '',
      connected: !!r?.connected,
      ready: !!r?.ready,
      suction: r?.suction,
      vibration: r?.vibration,
      electric: r?.electric,
      name: r?.name || '',
      address: r?.address || '',
      phase: r?.phase || '',
    });
  } catch (e) {
    try { await postPhoneScreen({ requestId, ok: false, error: e.message || 'failed' }); } catch {}
  }
}

async function handleHealthCommand(data) {
  if (!isNativeShell()) return;
  const requestId = String(data.requestId || '');
  try {
    let health = null;
    let device = null;
    let usage = null;
    let apps = null;
    try {
      const st = await refreshNativeHealth();
      if (st?.native) {
        device = {
          battery: st.battery,
          charging: !!st.charging,
          screenOn: st.screenOn !== false,
          locked: !!st.locked,
          inApp: !!st.inApp,
          package: st.package || '',
          app: st.app || '',
        };
        if (st.usage && typeof st.usage === 'object') usage = st.usage;
        if (st.health && typeof st.health === 'object') health = st.health;
        if (st.apps && typeof st.apps === 'object') apps = st.apps;
      }
    } catch {
      try {
        const st = await getNativeDeviceStatus();
        if (st?.native && st.health) health = st.health;
      } catch {}
    }
    const snap = await listNativeNotifications();
    await postPhoneNotifications({
      listenerEnabled: !!snap?.listenerEnabled,
      connected: !!snap?.connected,
      items: Array.isArray(snap?.items) ? snap.items : [],
      device,
      usage,
      health,
      apps,
      healthRequestId: requestId || undefined,
    });
  } catch (e) {
    console.warn('[phone] health refresh', e.message || e);
  }
}

async function handleLocationCommand(data) {
  if (!isNativeShell()) return;
  const requestId = String(data.requestId || '');
  try {
    const coords = await getDeviceCoordinates();
    const lat = Number(coords?.latitude);
    const lng = Number(coords?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      await postPhoneLocation({ requestId, ok: false, error: 'unavailable' });
      return;
    }
    await postPhoneLocation({
      requestId,
      ok: true,
      lat,
      lng,
      accuracy: Number(coords.accuracy) || 0,
    });
  } catch (e) {
    const msg = String(e?.message || e || '');
    let error = 'unavailable';
    if (/denied|访问位置|permission/i.test(msg)) error = 'location_denied';
    else if (/定位服务|location_off/i.test(msg)) error = 'location_off';
    try { await postPhoneLocation({ requestId, ok: false, error }); } catch {}
  }
}

export function handlePhoneCommand(data) {
  if (!isNativeShell()) return;
  if (data?.command === 'screen_share') {
    if (data.on === false) hideNativeScreenShare();
    else showNativeScreenShare({ characterId: data.characterId, name: data.name });
    return;
  }
  if (data?.command === 'health') {
    handleHealthCommand(data);
    return;
  }
  if (data?.command === 'location') {
    handleLocationCommand(data);
    return;
  }
  // 前台服务自己拉看屏/控屏；网页被系统暂停时才靠那条路。
  if (_nativeTick) return;
  if (data?.command === 'control') {
    handleControlCommand(data);
    return;
  }
  if (data?.command === 'alarm') {
    handleAlarmCommand(data);
    return;
  }
  if (data?.command === 'toy') {
    handleToyCommand(data);
    return;
  }
  if (!data || data.command !== 'screen') return;
  handleScreenCommand(data);
}

export function startPhoneNotificationSync() {
  if (_started || !isNativeShell()) return;
  _started = true;
  persistBridgeConfig();
  refreshNativeTick();
  syncOnce();
  _timer = window.setInterval(syncOnce, SYNC_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncOnce();
  });
  window.addEventListener('focus', syncOnce);
  try {
    const p = window.Capacitor?.Plugins?.AppPermissions;
    p?.addListener?.('notificationsChanged', () => { scheduleSync(); });
  } catch {}
}

/**
 * 用户手机上报的状态：通知栏、电量、看屏结果。
 * 角色读这些走 tools，不进提示词（啵啵贝开着时，心率会写进那一段提示词）。
 */

const crypto = require('crypto');

const MAX_ITEMS = 40;
const STALE_MS = 90 * 1000;
const SCREEN_WAIT_MS = 16000;
const PENDING_TTL_MS = 60 * 1000;
const PENDING_MAX = 12;

let _snap = {
  at: 0,
  listenerEnabled: false,
  connected: false,
  items: [],
  device: { at: 0, battery: null, charging: null, screenOn: null, locked: null },
  usage: { at: 0, granted: false, todayMinutes: 0, yesterdayMinutes: 0, weekMinutes: 0, today: [], yesterday: [], week: [] },
  health: {
    at: 0, supported: false, granted: false, todaySteps: null, sinceBoot: null,
    connectAvailable: false, connectStatus: 'missing', connectGranted: false,
    connectSteps: null, sleepMinutes: null, heartRateBpm: null, heartRateMin: null, heartRateMax: null,
    distanceMeters: null, caloriesKcal: null,
  },
  apps: { at: 0, items: [] },
  location: { at: 0, ok: false, error: '', title: '', detail: '', placeName: '', accuracy: 0, stale: false },
};

const _screenWait = new Map();
const _pending = [];
let _lastPullAt = 0;
let _share = { on: false, characterId: 0, at: 0 };

function setShare(on, characterId) {
  const cid = Number(characterId) || _share.characterId || 0;
  _share = { on: !!on, characterId: cid, at: Date.now() };
  return _share;
}

function shareActive() {
  if (!_share.on) return false;
  if (Date.now() - (_share.at || 0) > 30 * 60 * 1000) {
    _share.on = false;
    return false;
  }
  return true;
}

function preferredScreenChatCharId() {
  try {
    const ta = require('./ta-helper');
    const bid = ta.boundCharacterId();
    if (bid) return bid;
  } catch {}
  try {
    const row = require('./db').prepare(
      'SELECT id FROM characters WHERE COALESCE(screen_chat_priority,0)=1 ORDER BY id LIMIT 1'
    ).get();
    return Number(row?.id) || 0;
  } catch {
    return 0;
  }
}

/** 以 TA 绑定角色为准；未绑定则无人可识屏/控屏。 */
function isPreferredScreenChatChar(characterId) {
  const preferred = preferredScreenChatCharId();
  if (!preferred) return false;
  return Number(characterId) === preferred;
}

function ingest(body = {}) {
  const items = Array.isArray(body.items) ? body.items : [];
  const cleaned = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const pkg = String(raw.package || '').trim().slice(0, 120);
    const app = String(raw.app || pkg).trim().slice(0, 40);
    const title = String(raw.title || '').trim().slice(0, 120);
    const text = String(raw.text || '').trim().slice(0, 240);
    if (!pkg && !title && !text) continue;
    cleaned.push({
      package: pkg,
      app: app || pkg,
      title,
      text,
      when: Number(raw.when) || 0,
      ongoing: !!raw.ongoing,
      category: String(raw.category || '').slice(0, 40),
    });
    if (cleaned.length >= MAX_ITEMS) break;
  }
  const device = ingestDevice(body.device);
  const call = ingestCall(body.call, body.device && body.device.call);
  const usage = ingestUsage(body.usage);
  const health = ingestHealth(body.health);
  const apps = ingestApps(body.apps);
  _snap = {
    at: Date.now(),
    listenerEnabled: body.listenerEnabled !== false,
    connected: body.connected !== false,
    items: cleaned,
    device,
    call,
    usage,
    health,
    apps,
  };
  const healthReq = String(body.healthRequestId || '').trim();
  if (healthReq) fulfillHealth(healthReq);
  return _snap.items.length;
}

function ingestApps(raw) {
  const prev = _snap.apps || { at: 0, items: [] };
  if (!raw || typeof raw !== 'object') return prev;
  const list = Array.isArray(raw.items) ? raw.items : (Array.isArray(raw) ? raw : []);
  const items = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const app = String(row.app || '').trim().slice(0, 40);
    const pkg = String(row.package || '').trim().slice(0, 120);
    if (!app && !pkg) continue;
    const key = pkg || app;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ app: app || pkg, package: pkg });
    if (items.length >= 120) break;
  }
  if (!items.length) return prev;
  return { at: Date.now(), items };
}

function ingestDevice(raw) {
  const prev = _snap.device || {};
  if (!raw || typeof raw !== 'object') return prev;
  const batteryRaw = raw.battery == null || raw.battery === '' ? NaN : Number(raw.battery);
  const battery = Number.isFinite(batteryRaw) && batteryRaw >= 0
    ? Math.max(0, Math.min(100, Math.round(batteryRaw)))
    : prev.battery;
  return {
    at: Date.now(),
    battery: Number.isFinite(battery) ? battery : prev.battery,
    charging: raw.charging == null ? prev.charging : !!raw.charging,
    screenOn: raw.screenOn == null ? prev.screenOn : !!raw.screenOn,
    locked: raw.locked == null ? prev.locked : !!raw.locked,
    inApp: raw.inApp == null ? prev.inApp : !!raw.inApp,
    package: raw.package == null ? prev.package : String(raw.package || '').trim().slice(0, 120),
    app: raw.app == null ? prev.app : String(raw.app || '').trim().slice(0, 40),
  };
}

function ingestCall(raw, deviceCall) {
  const src = (raw && typeof raw === 'object') ? raw
    : (deviceCall && typeof deviceCall === 'object' ? deviceCall : null);
  if (!src) return _snap.call || { on: false, video: false, facing: '' };
  const facing = String(src.facing || '').trim();
  return {
    on: !!src.on,
    video: !!src.video,
    facing: facing === 'environment' ? 'environment' : (src.video ? 'user' : ''),
  };
}

function clipApps(list, max) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const minutes = Math.max(0, Math.round(Number(raw.minutes) || 0));
    if (minutes <= 0) continue;
    const lastAgo = raw.lastAgoMin == null || raw.lastAgoMin === '' ? null : Math.max(0, Math.round(Number(raw.lastAgoMin)));
    out.push({
      app: String(raw.app || raw.package || '').trim().slice(0, 40),
      package: String(raw.package || '').trim().slice(0, 120),
      minutes,
      lastAgoMin: Number.isFinite(lastAgo) ? lastAgo : null,
    });
    if (out.length >= max) break;
  }
  return out;
}

function ingestUsage(raw) {
  const prev = _snap.usage || {};
  if (!raw || typeof raw !== 'object') return prev;
  return {
    at: Date.now(),
    granted: raw.granted !== false && raw.granted !== 0,
    todayMinutes: Math.max(0, Math.round(Number(raw.todayMinutes) || 0)),
    yesterdayMinutes: Math.max(0, Math.round(Number(raw.yesterdayMinutes) || 0)),
    weekMinutes: Math.max(0, Math.round(Number(raw.weekMinutes) || 0)),
    today: clipApps(raw.today, 12),
    yesterday: clipApps(raw.yesterday, 8),
    week: clipApps(raw.week, 8),
  };
}

function ingestHealth(raw) {
  const prev = _snap.health || {};
  if (!raw || typeof raw !== 'object') return prev;
  const n = (v) => {
    if (v == null || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const steps = n(raw.todaySteps);
  const boot = n(raw.sinceBoot);
  const hasConnectInfo = raw.connectStatus != null
    || raw.connectAvailable != null
    || raw.connectGranted != null
    || raw.connectSteps != null
    || raw.heartRateBpm != null
    || raw.heartRateGranted != null
    || raw.sleepMinutes != null
    || raw.distanceMeters != null
    || raw.caloriesKcal != null
    || raw.spo2Percent != null
    || raw.exerciseCount != null
    || raw.backgroundGranted != null
    || raw.connectError != null;
  const base = {
    at: Date.now(),
    supported: raw.supported !== false && raw.supported !== 0,
    granted: raw.granted !== false && raw.granted !== 0,
    todaySteps: steps,
    sinceBoot: boot,
  };
  if (!hasConnectInfo) {
    return { ...prev, ...base };
  }
  const pick = (key) => (key in raw ? n(raw[key]) : prev[key] ?? null);
  // 读失败时空壳不要冲掉上一份心率/睡眠
  const readFailed = !!(raw.connectError);
  const heartRateGranted = raw.heartRateGranted == null
    ? (readFailed ? (prev.heartRateGranted ?? !!raw.connectGranted) : !!raw.connectGranted)
    : !!raw.heartRateGranted;
  const hrCleared = !readFailed && (raw.heartRateGranted === false || raw.heartRateGranted === 0);
  const connectGranted = readFailed && prev.connectGranted && !raw.connectGranted
    ? true
    : !!raw.connectGranted;
  return {
    ...base,
    connectAvailable: raw.connectAvailable == null ? !!prev.connectAvailable : !!raw.connectAvailable,
    connectStatus: String(raw.connectStatus || prev.connectStatus || (raw.connectAvailable ? 'available' : 'missing')),
    connectGranted,
    connectError: raw.connectError ? String(raw.connectError).slice(0, 80) : null,
    backgroundGranted: raw.backgroundGranted == null ? !!prev.backgroundGranted : !!raw.backgroundGranted,
    heartRateGranted,
    connectSteps: pick('connectSteps'),
    sleepMinutes: pick('sleepMinutes'),
    heartRateBpm: hrCleared ? null : pick('heartRateBpm'),
    heartRateMin: hrCleared ? null : pick('heartRateMin'),
    heartRateMax: hrCleared ? null : pick('heartRateMax'),
    heartRateAtMs: hrCleared ? null : pick('heartRateAtMs'),
    heartRateSource: hrCleared
      ? null
      : (('heartRateSource' in raw && raw.heartRateSource)
        ? String(raw.heartRateSource).slice(0, 20)
        : (prev.heartRateSource || null)),
    distanceMeters: pick('distanceMeters'),
    caloriesKcal: pick('caloriesKcal'),
    spo2Percent: pick('spo2Percent'),
    exerciseCount: pick('exerciseCount'),
    exerciseMinutes: pick('exerciseMinutes'),
    exerciseTitle: ('exerciseTitle' in raw && raw.exerciseTitle)
      ? String(raw.exerciseTitle).slice(0, 40)
      : (prev.exerciseTitle || null),
  };
}

function snapshot() {
  return _snap;
}

function ageMs() {
  return _snap.at ? Date.now() - _snap.at : null;
}

function query(opts = {}) {
  const limit = Math.max(1, Math.min(20, parseInt(opts.limit, 10) || 12));
  const q = String(opts.query || opts.app || '').trim().toLowerCase();
  let items = _snap.items.slice();
  if (q) {
    items = items.filter((it) => {
      const blob = `${it.app} ${it.package} ${it.title} ${it.text}`.toLowerCase();
      return blob.includes(q);
    });
  }
  items.sort((a, b) => (b.when || 0) - (a.when || 0));
  return items.slice(0, limit);
}

function notificationResult(opts = {}) {
  const age = ageMs();
  if (!_snap.at) {
    return {
      ok: false,
      available: false,
      error: 'no_phone',
      note: '这会儿看不到用户手机通知栏。可能没开套壳 App、没开通知监听，或手机还没把快照传上来。不要假装已经看见了具体消息。',
    };
  }
  if (_snap.listenerEnabled === false || _snap.connected === false) {
    return {
      ok: false,
      available: false,
      error: 'listener_off',
      ageSec: age != null ? Math.round(age / 1000) : null,
      note: '用户还没把「通知监听」打开，读不到通知栏。不要编造条目。',
    };
  }
  const items = query(opts);
  const stale = age != null && age > STALE_MS;
  return {
    ok: true,
    available: true,
    stale,
    ageSec: age != null ? Math.round(age / 1000) : null,
    count: items.length,
    total: _snap.items.length,
    note: stale
      ? '快照有点旧，手机可能在后台。下面是最近一次看到的通知栏摘要，不是保证此刻仍挂着。'
      : '下面是用户手机通知栏当前摘要。聊天软件常常只有标题或「N条消息」，没有完整正文。用你自己的口吻说，不要提工具名。',
    items: items.map((it) => ({
      app: it.app,
      title: it.title,
      text: it.text,
      ongoing: it.ongoing,
      ageSec: it.when ? Math.max(0, Math.round((Date.now() - it.when) / 1000)) : null,
    })),
  };
}

function statusResult() {
  const d = _snap.device || {};
  if (!_snap.at && !d.at) {
    return {
      ok: false,
      available: false,
      error: 'no_phone',
      note: '看不到用户手机状态。套壳 App 可能没开。不要编造电量。',
    };
  }
  const age = d.at ? Date.now() - d.at : ageMs();
  const stale = age != null && age > STALE_MS;
  const battery = d.battery == null || d.battery === '' ? null : Math.round(Number(d.battery));
  const hasBattery = Number.isFinite(battery);
  // screenOn/locked 仅供内部门闩；角色工具已禁用 phone_status，不会直接读到
  return {
    ok: hasBattery,
    available: hasBattery,
    stale,
    ageSec: age != null ? Math.round(age / 1000) : null,
    battery: hasBattery ? battery : null,
    charging: d.charging,
    screenOn: d.screenOn,
    locked: d.locked,
    inApp: d.inApp,
    package: d.package || '',
    app: d.app || '',
    note: !hasBattery
      ? '套壳 App 这会儿还没把电量报上来。不要编造电量，也不要去开桌上小机。'
      : (stale
        ? '状态有点旧。电量仅在快没电时才会单独告诉你。'
        : '电量仅在快没电或关机失联时才会单独告诉你。'),
  };
}

function formatMinutes(n) {
  const m = Math.max(0, Math.round(Number(n) || 0));
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}小时${r}分钟` : `${h}小时`;
}

function usageResult(opts = {}) {
  const u = _snap.usage || {};
  if (!_snap.at && !u.at) {
    return {
      ok: false,
      available: false,
      error: 'no_phone',
      note: '看不到用户手机使用时长。套壳 App 可能没开。不要编造他刷了多久。',
    };
  }
  if (u.granted === false) {
    return {
      ok: false,
      available: false,
      error: 'usage_off',
      note: '用户还没打开「使用情况访问」，看不到各 App 用了多久。不要编造时长。',
    };
  }
  const range = String(opts.range || opts.period || 'today').trim().toLowerCase();
  const key = range === 'yesterday' || range === 'yday' || range === '昨天'
    ? 'yesterday'
    : (range === 'week' || range === '7d' || range === '一周' ? 'week' : 'today');
  const label = key === 'yesterday' ? '昨天' : (key === 'week' ? '近7天' : '今天');
  const totalKey = key === 'yesterday' ? 'yesterdayMinutes' : (key === 'week' ? 'weekMinutes' : 'todayMinutes');
  let apps = Array.isArray(u[key]) ? u[key].slice() : [];
  const q = String(opts.query || opts.app || '').trim().toLowerCase();
  if (q) {
    apps = apps.filter((it) => `${it.app} ${it.package}`.toLowerCase().includes(q));
  }
  const limit = Math.max(1, Math.min(15, parseInt(opts.limit, 10) || 8));
  apps = apps.slice(0, limit);
  const age = u.at ? Date.now() - u.at : ageMs();
  const stale = age != null && age > STALE_MS;
  const total = Math.max(0, Math.round(Number(u[totalKey]) || 0));
  return {
    ok: true,
    available: true,
    stale,
    ageSec: age != null ? Math.round(age / 1000) : null,
    range: key,
    totalMinutes: total,
    totalLabel: formatMinutes(total),
    count: apps.length,
    apps: apps.map((it) => ({
      app: it.app,
      minutes: it.minutes,
      duration: formatMinutes(it.minutes),
      lastAgoMin: it.lastAgoMin,
    })),
    note: stale
      ? `快照有点旧。下面是最近一次看到的${label}前台使用时长，不是保证此刻仍准确。用你自己的口吻说，不要提工具名。`
      : `下面是用户手机${label}各 App 的前台使用时长（系统统计，不是点开后的内容）。锁屏/后台通常不算。用你自己的口吻说，不要提工具名。`,
  };
}

function appsResult(opts = {}) {
  const a = _snap.apps || {};
  const items = Array.isArray(a.items) ? a.items : [];
  if (!items.length) {
    return {
      ok: false,
      available: false,
      error: !_snap.at ? 'no_phone' : 'empty',
      note: !_snap.at
        ? '看不到用户手机装了哪些应用。套壳 App 可能没开。不要编造。'
        : '还没拿到桌面应用列表。不要编造装了什么。',
    };
  }
  const q = String(opts.query || opts.app || opts.name || '').trim().toLowerCase();
  let list = items;
  if (q) {
    list = items.filter((it) => `${it.app} ${it.package}`.toLowerCase().includes(q));
  }
  const limit = Math.max(1, Math.min(80, parseInt(opts.limit, 10) || (q ? 20 : 40)));
  list = list.slice(0, limit);
  return {
    ok: true,
    available: true,
    count: list.length,
    total: items.length,
    apps: list.map((it) => it.app),
    note: q
      ? (list.length
        ? '下面是名字对得上的已装应用。打开用 phone_control action=open，text 填应用名。不要把整份清单念出来。'
        : '没找到叫这个名字的已装应用。不要编造已经打开。')
      : `用户手机桌面上大约能打开 ${items.length} 个应用。下面是一部分名字。要打开某个用 phone_control action=open。不要把整份清单念给用户听。`,
  };
}

function healthResult() {
  const h = _snap.health || {};
  if (!_snap.at && !h.at) {
    return {
      ok: false,
      available: false,
      error: 'no_phone',
      note: '看不到用户手机健康数据。套壳 App 可能没开。不要编造步数或睡眠。',
    };
  }
  const connectOn = !!h.connectAvailable && !!h.connectGranted;
  const connectSteps = h.connectSteps == null ? null : Math.max(0, Math.round(Number(h.connectSteps)));
  const sensorSteps = h.todaySteps == null ? null : Math.max(0, Math.round(Number(h.todaySteps)));
  const steps = connectSteps != null ? connectSteps : sensorSteps;
  const sleepMin = h.sleepMinutes == null ? null : Math.max(0, Math.round(Number(h.sleepMinutes)));
  const hr = h.heartRateBpm == null ? null : Math.round(Number(h.heartRateBpm));
  const hrMin = h.heartRateMin == null ? null : Math.round(Number(h.heartRateMin));
  const hrMax = h.heartRateMax == null ? null : Math.round(Number(h.heartRateMax));
  const dist = h.distanceMeters == null ? null : Math.max(0, Math.round(Number(h.distanceMeters)));
  const kcal = h.caloriesKcal == null ? null : Math.max(0, Math.round(Number(h.caloriesKcal)));
  const spo2 = h.spo2Percent == null ? null : Math.round(Number(h.spo2Percent));
  const exerciseMin = h.exerciseMinutes == null ? null : Math.max(0, Math.round(Number(h.exerciseMinutes)));
  const exerciseCount = h.exerciseCount == null ? null : Math.max(0, Math.round(Number(h.exerciseCount)));
  const hasConnectData = connectSteps != null || sleepMin != null || hr != null || dist != null || kcal != null
    || Number.isFinite(spo2) || exerciseMin != null || exerciseCount != null;
  const hasSensor = sensorSteps != null;
  const age = h.at ? Date.now() - h.at : ageMs();
  const stale = age != null && age > STALE_MS;

  if (!hasConnectData && !hasSensor) {
    if (h.connectAvailable && !h.connectGranted) {
      return {
        ok: false,
        available: false,
        error: 'connect_off',
        note: '用户手机有「健康数据共享」，但还没授权给念。不要编步数、睡眠或心率。',
      };
    }
    if (connectOn) {
      return {
        ok: false,
        available: false,
        error: 'connect_empty',
        note: '健康数据共享里还是空的。手表数据要先写进三星健康，再允许三星健康写入「健康数据共享」（心率/睡眠/血氧都要勾）。不要编数字。',
      };
    }
    if (h.supported === false) {
      return {
        ok: false,
        available: false,
        error: 'no_sensor',
        note: '这台手机没有计步器，也没有读到健康数据共享。不要编数字。',
      };
    }
    if (h.granted === false) {
      return {
        ok: false,
        available: false,
        error: 'activity_off',
        note: '用户还没给「身体活动」权限，计步器读不到。健康数据共享也还没数据。不要编步数。',
      };
    }
    return {
      ok: false,
      available: false,
      error: 'no_reading',
      note: '计步器这会儿还没吐出读数（刚授权或刚开机常见）。不要编步数。',
    };
  }

  const bits = [];
  if (connectSteps != null) bits.push('步数来自健康数据共享（可能含手表）');
  else if (sensorSteps != null) {
    bits.push('步数来自手机自己的计步器');
    if (!connectOn && h.connectAvailable) {
      bits.push('健康数据共享还没授权给念，所以只有计步，没有心率/睡眠');
    } else if (!h.connectAvailable || h.connectStatus === 'missing') {
      bits.push('系统里暂时没有健康数据共享，手机计步器读不到心率');
    }
  }
  if (sleepMin != null) bits.push('有睡眠时长');
  if (hr != null) {
    if (h.heartRateSource === 'resting') bits.push('心率是静息心率');
    else if (h.heartRateSource === 'latest') bits.push('心率是最近一次读数，不是实时心电图');
    else bits.push('有心率');
  } else if (h.heartRateGranted === false && (connectOn || h.connectGranted)) {
    bits.push('心率这项还没授权给念，所以没有心率');
  } else if (h.connectAvailable && !h.connectGranted) {
    bits.push('健康数据共享还没授权给念，所以没有心率');
  } else if (h.backgroundGranted === false && (connectOn || h.connectGranted)) {
    bits.push('健康权限里还没勾「后台读取」，刷别的 App 时可能读不到手表数据');
  } else if (connectOn || h.connectGranted) {
    bits.push('健康数据共享里这会儿没有心率（手机测不了，通常要手表/手环写入「健康数据共享」并勾选心率）');
  } else if (hasSensor && !hasConnectData) {
    bits.push('没有心率：要手表写入健康数据共享，并在权限里勾选心率');
  }
  if (Number.isFinite(spo2)) bits.push('有血氧');
  if (exerciseMin != null || exerciseCount != null) bits.push('有今天的运动记录');
  const note = stale
    ? `读数有点旧。${bits.join('；')}。没有的项目不要编。用你自己的口吻说，不要提工具名。`
    : `${bits.join('；')}。不是微信运动排行榜。没有返回的项目不要编。用你自己的口吻说，不要提工具名。`;

  return {
    ok: true,
    available: true,
    stale,
    ageSec: age != null ? Math.round(age / 1000) : null,
    todaySteps: steps,
    stepsSource: connectSteps != null ? 'health_connect' : 'phone_sensor',
    sleepMinutes: sleepMin,
    sleepLabel: sleepMin == null ? null : formatMinutes(sleepMin),
    heartRateBpm: Number.isFinite(hr) ? hr : null,
    heartRateMin: Number.isFinite(hrMin) ? hrMin : null,
    heartRateMax: Number.isFinite(hrMax) ? hrMax : null,
    heartRateGranted: h.heartRateGranted !== false,
    heartRateSource: h.heartRateSource || null,
    heartRateAtMs: Number.isFinite(Number(h.heartRateAtMs)) ? Number(h.heartRateAtMs) : null,
    distanceMeters: dist,
    caloriesKcal: kcal,
    spo2Percent: Number.isFinite(spo2) ? spo2 : null,
    exerciseCount: exerciseCount,
    exerciseMinutes: exerciseMin,
    exerciseTitle: h.exerciseTitle || null,
    note,
  };
}

function fulfillScreen(body = {}) {
  const id = String(body.requestId || '').trim();
  const waiter = _screenWait.get(id);
  if (!waiter) return false;
  _screenWait.delete(id);
  clearTimeout(waiter.timer);
  waiter.resolve({
    ok: body.ok !== false,
    error: body.error || null,
    package: String(body.package || '').slice(0, 120),
    app: String(body.app || '').slice(0, 40),
    tree: String(body.tree || '').slice(0, 5000),
    targets: String(body.targets || '').slice(0, 2000),
    imageDataUrl: typeof body.imageDataUrl === 'string' && body.imageDataUrl.startsWith('data:image/')
      ? body.imageDataUrl
      : null,
    selfieDataUrl: typeof body.selfieDataUrl === 'string' && body.selfieDataUrl.startsWith('data:image/')
      ? body.selfieDataUrl
      : null,
    source: String(body.source || '').trim().slice(0, 40),
    accessibility: !!body.accessibility,
    screenshot: !!body.screenshot,
    alarmId: Number(body.alarmId) || 0,
    when: Number(body.when) || 0,
    hasVoice: !!body.hasVoice,
    hour: body.hour == null ? null : Number(body.hour),
    minute: body.minute == null ? null : Number(body.minute),
    repeat: String(body.repeat || ''),
    label: String(body.label || ''),
    speech: String(body.speech || ''),
    name: String(body.name || ''),
    alarms: Array.isArray(body.alarms) ? body.alarms : (typeof body.alarms === 'string' ? (() => { try { return JSON.parse(body.alarms); } catch { return []; } })() : body.alarms),
    matches: Array.isArray(body.matches) ? body.matches.map((n) => String(n || '').slice(0, 40)).filter(Boolean).slice(0, 8) : [],
    suction: body.suction == null ? null : Number(body.suction),
    vibration: body.vibration == null ? null : Number(body.vibration),
    electric: body.electric == null ? null : Number(body.electric),
    connected: body.connected != null ? !!body.connected : undefined,
    ready: body.ready != null ? !!body.ready : undefined,
    address: String(body.address || ''),
    phase: String(body.phase || ''),
  });
  return true;
}

function fulfillHealth(requestId) {
  const id = String(requestId || '').trim();
  const waiter = _screenWait.get(id);
  if (!waiter) return false;
  _screenWait.delete(id);
  clearTimeout(waiter.timer);
  waiter.resolve({ ok: true });
  return true;
}

const HEALTH_WAIT_MS = 14000;
const LOCATION_WAIT_MS = 22000;

function fulfillLocation(requestId) {
  const id = String(requestId || '').trim();
  const waiter = _screenWait.get(id);
  if (!waiter) return false;
  _screenWait.delete(id);
  clearTimeout(waiter.timer);
  waiter.resolve({ ok: true });
  return true;
}

let _locTrail = { day: '', points: [] };

function trailDayKey() {
  try {
    const tz = require('./db').prepare(`SELECT value FROM settings WHERE key='timezone'`).get()?.value || 'Asia/Shanghai';
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function rememberLocationTrail(loc) {
  if (!loc?.ok) return;
  const day = trailDayKey();
  if (_locTrail.day !== day) _locTrail = { day, points: [] };
  const label = loc.anchorLabel || loc.title || '';
  if (!label) return;
  const last = _locTrail.points[_locTrail.points.length - 1];
  if (last && last.label === label) {
    last.at = loc.at || Date.now();
    return;
  }
  _locTrail.points.push({
    at: loc.at || Date.now(),
    label,
    anchor: loc.anchor || '',
  });
  if (_locTrail.points.length > 14) _locTrail.points = _locTrail.points.slice(-14);
}

function locationTrailLine() {
  const day = trailDayKey();
  if (_locTrail.day !== day || !_locTrail.points.length) return '';
  return _locTrail.points.map((p) => p.label).join(' → ');
}

async function ingestLocation(body = {}) {
  const lat = Number(body.lat ?? body.latitude);
  const lng = Number(body.lng ?? body.longitude);
  const error = String(body.error || '').trim();
  const ok = body.ok !== false && Number.isFinite(lat) && Number.isFinite(lng);
  let title = String(body.title || '').trim();
  let detail = String(body.detail || '').trim();
  let placeName = String(body.placeName || '').trim();
  if (ok && !title) {
    try {
      const geo = await require('./location-weather-helper').reverseGeocodeCoords(lat, lng, {
        accuracy: Number(body.accuracy) || 0,
      });
      if (geo) {
        title = geo.title || title;
        detail = geo.detail || detail;
        placeName = geo.placeName || placeName;
        body.anchor = geo.anchor || '';
        body.anchorLabel = geo.anchorLabel || '';
        body.poi = geo.poi || '';
      }
    } catch {}
  }
  _snap.location = {
    at: Date.now(),
    ok,
    error: ok ? '' : (error || 'unavailable'),
    lat: ok ? lat : null,
    lng: ok ? lng : null,
    accuracy: Number(body.accuracy) || 0,
    title,
    detail,
    placeName,
    stale: !!body.stale,
    anchor: String(body.anchor || '').trim(),
    anchorLabel: String(body.anchorLabel || '').trim(),
    poi: String(body.poi || '').trim(),
  };
  rememberLocationTrail(_snap.location);
  const req = String(body.requestId || body.locationRequestId || '').trim();
  if (req) fulfillLocation(req);
  return _snap.location;
}

async function refreshLocation() {
  if (!phoneReachable()) return false;
  const requestId = crypto.randomBytes(12).toString('hex');
  enqueueCommand({ type: 'location', requestId });
  try {
    require('./push').broadcast?.({ type: 'phone_command', command: 'location', requestId });
  } catch {}
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      _screenWait.delete(requestId);
      resolve(null);
    }, LOCATION_WAIT_MS);
    _screenWait.set(requestId, { resolve, timer });
  });
  return !!(_snap.location?.ok && (Date.now() - (_snap.location.at || 0) < LOCATION_WAIT_MS + 2000));
}

function locationResult() {
  const loc = _snap.location || {};
  if (!phoneReachable()) {
    return {
      ok: false, available: false, error: 'unreachable',
      note: '这会儿连不上对方手机，读不到定位。不要编造街道。',
    };
  }
  const err = String(loc.error || '');
  if (err === 'location_denied' || err === 'denied') {
    return {
      ok: false, available: false, error: 'denied',
      note: '对方还没允许念读定位。不要编具体位置；按性格可以说让对方开一下定位。',
    };
  }
  if (err === 'location_off') {
    return {
      ok: false, available: false, error: 'off',
      note: '对方手机定位服务关着。不要编位置。',
    };
  }
  if (!loc.ok || loc.lat == null) {
    return {
      ok: false, available: false, error: err || 'empty',
      note: '这会儿读不到定位。可能没开权限、定位关了，或超时。不要编造。',
    };
  }
  const place = loc.placeName || [loc.title, loc.detail].filter(Boolean).join(' · ') || '当前位置';
  const stale = loc.stale || (loc.at && Date.now() - loc.at > 3 * 60 * 1000);
  const title = loc.title || place.split('|')[0] || '当前位置';
  const extra = loc.detail && loc.detail !== title ? `（${loc.detail}）` : '';
  const trail = locationTrailLine();
  let nowLine = '';
  if (loc.anchor === 'home') {
    nowLine = `对方此刻在家${extra || ''}。这是常驻点「家」，不是店里。`;
  } else if (loc.anchor === 'work') {
    nowLine = `对方此刻在公司${extra || ''}。这是常驻点「公司」。`;
  } else {
    nowLine = `对方此刻大约在「${title}」${extra}。${loc.poi && loc.poi !== title ? `店/地点名是${loc.poi}。` : ''}对得上店名或路名时用店名，不要只说到城市。`;
    if (String(loc.poi || loc.title || '') && loc.anchor !== 'home' && loc.anchor !== 'work') {
      nowLine += '不是家也不是公司。';
    }
  }
  return {
    ok: true,
    available: true,
    title,
    detail: loc.detail || '',
    placeName: loc.placeName || place,
    accuracy: loc.accuracy || 0,
    anchor: loc.anchor || '',
    todayTrail: trail,
    note: `${nowLine}${stale ? '可能是稍早一点的位置。' : ''}${trail ? ` 今天到过：${trail}。这是一条走动线，不是只有眼前这一点。` : ''}按性格用，不要念经纬度，不要提工具名。`,
  };
}

/** 角色问健康数据时，先让手机立刻重读 Health Connect，再返回结果。 */
async function refreshHealth() {
  if (!phoneReachable()) return false;
  const requestId = crypto.randomBytes(12).toString('hex');
  enqueueCommand({ type: 'health', requestId });
  let push;
  try { push = require('./push'); } catch { push = null; }
  try {
    push?.broadcast?.({ type: 'phone_command', command: 'health', requestId });
  } catch {}
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      _screenWait.delete(requestId);
      resolve(null);
    }, HEALTH_WAIT_MS);
    _screenWait.set(requestId, { resolve, timer });
  });
  return !!result;
}

function prunePending() {
  const now = Date.now();
  for (let i = _pending.length - 1; i >= 0; i--) {
    if (now - (_pending[i].at || 0) > PENDING_TTL_MS) _pending.splice(i, 1);
  }
  while (_pending.length > PENDING_MAX) _pending.shift();
}

function enqueueCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return;
  prunePending();
  _pending.push({ ...cmd, at: Date.now() });
}

function pullCommands() {
  _lastPullAt = Date.now();
  prunePending();
  return _pending.splice(0, _pending.length).map(({ at, ...rest }) => rest);
}

function phoneReachable() {
  try {
    if (require('./push').hasClients()) return true;
  } catch {}
  const age = ageMs();
  if (age != null && age < STALE_MS) return true;
  if (_lastPullAt && Date.now() - _lastPullAt < 20000) return true;
  return false;
}

function isVoicePayload(raw) {
  const t = String(raw || '').trim();
  if (!t.startsWith('{')) return false;
  try {
    const j = JSON.parse(t);
    return !!(j && (j.voice || j.album || j.transcript));
  } catch {
    return false;
  }
}

function isOverlaySystemText(raw) {
  const t = String(raw || '').trim();
  if (!t) return true;
  if (/拍了拍/.test(t)) return true;
  if (/^\[拍一拍提示\]/.test(t)) return true;
  if (t === '新消息' || t === '[新消息]' || t === '……' || t === '...') return true;
  try {
    const { isBarePokeSuffix } = require('./emoji-helper');
    if (isBarePokeSuffix(t)) return true;
  } catch {}
  return false;
}

function capsuleBubbleText(raw) {
  let t = String(raw || '').trim();
  if (isVoicePayload(t)) return '';
  t = t
    .replace(/\[(桌宠|舵机|灯光|动作|表情):[^\]]*\]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[。．]+$/, '')
    .trim();
  if (isOverlaySystemText(t)) return '';
  return t;
}

/** 离开聊天页时屏幕只出文字和表情包；系统行、语音条不往屏幕上送 */
function capsuleBubbles(payload = {}) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || !item.type) return;
    const key = `${item.type}\0${item.url || item.text || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  if (Array.isArray(payload.aiMessages)) {
    for (const m of payload.aiMessages) {
      if (!m) continue;
      const type = String(m.type || 'text');
      if (type === 'system' || type === 'voice') continue;
      if (type === 'emoji') {
        const url = String(m.content || m.url || '').trim();
        if (url) push({ type: 'emoji', url, text: String(m.description || '').trim() });
        continue;
      }
      if (type !== 'text') continue;
      const t = capsuleBubbleText(m.content || m.text);
      if (t) push({ type: 'text', text: t });
    }
  }
  return out;
}

function userInNian() {
  const d = _snap.device || {};
  return d.inApp === true;
}

function userAwayFromNian() {
  const d = _snap.device || {};
  return d.inApp === false;
}

function enqueueIncomingCall(payload = {}) {
  const characterId = Number(payload.characterId);
  if (!characterId) return;
  let name = String(payload.charName || payload.name || '').trim();
  let avatar = String(payload.charAvatar || payload.avatar || '').trim();
  if (!name || !avatar) {
    try {
      const row = require('./db').prepare('SELECT name, avatar FROM characters WHERE id=?').get(characterId);
      if (row) {
        if (!name) name = String(row.name || '').trim();
        if (!avatar) avatar = String(row.avatar || '').trim();
      }
    } catch {}
  }
  let ringtone = String(payload.ringtone || '').trim();
  let systemRing = payload.systemRing ?? payload.useSystemRingtone;
  if (systemRing == null) {
    try {
      const row = require('./db').prepare("SELECT value FROM settings WHERE key='sound_call_system'").get();
      const v = String(row?.value || '').trim().toLowerCase();
      systemRing = v === '1' || v === 'true' || v === 'on';
    } catch {
      systemRing = false;
    }
  }
  if (!ringtone && !systemRing) {
    try {
      const row = require('./db').prepare("SELECT value FROM settings WHERE key='sound_call'").get();
      ringtone = String(row?.value || '').trim();
    } catch {}
  }
  enqueueCommand({
    type: 'incoming_call',
    characterId,
    name: name || 'TA',
    avatar,
    content: String(payload.content || '').trim(),
    ringtone,
    systemRing: !!systemRing,
    logId: Number(payload.logId) || 0,
    ringMs: Number(payload.ringMs) || 35000,
    video: !!payload.video,
  });
}

function enqueueDismissIncomingCall() {
  enqueueCommand({ type: 'dismiss_incoming_call' });
}

function enqueueCapsule(payload = {}) {
  try {
    const v = require('./db').prepare(`SELECT value FROM settings WHERE key='phone_screen_chat'`).get()?.value;
    if (String(v ?? '1') === '0') return;
  } catch {}
  const characterId = Number(payload.characterId);
  if (!characterId) return;
  if (!isPreferredScreenChatChar(characterId)) return;
  let name = String(payload.charName || payload.name || '').trim();
  let avatar = String(payload.charAvatar || payload.avatar || '').trim();
  if (!name || !avatar) {
    try {
      const row = require('./db').prepare('SELECT name, avatar FROM characters WHERE id=?').get(characterId);
      if (row) {
        if (!name) name = String(row.name || '').trim();
        if (!avatar) avatar = String(row.avatar || '').trim();
      }
    } catch {}
  }
  const bubbles = capsuleBubbles(payload);
  const cmd = {
    type: 'capsule',
    characterId,
    name: name || 'TA',
    avatar,
    text: bubbles.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
  };
  if (bubbles.length) cmd.bubbles = bubbles;
  enqueueCommand(cmd);
}

async function captureScreen(opts = {}) {
  const mode = String(opts.mode || 'look').trim() === 'read' ? 'read' : 'look';
  const characterId = Number(opts.characterId) || 0;
  if (characterId && !isPreferredScreenChatChar(characterId)) {
    return {
      ok: false,
      available: false,
      error: 'not_preferred',
      note: '看屏这会儿轮不到你。按性格接着聊，不要提这个。',
    };
  }
  const shareOff = opts.share === false || opts.share === 0;
  const wantShare = shareOff ? false : (opts.share === true || opts.share === 1 || shareActive() || userAwayFromNian());
  let push;
  try { push = require('./push'); } catch { push = null; }
  if (!phoneReachable()) {
    return {
      ok: false,
      available: false,
      error: 'no_phone',
      note: '用户手机这会儿没连上念。不要假装已经看见屏幕。',
    };
  }
  const allowInApp = opts.allowInApp === true || opts.force === true;
  if (userInNian() && !allowInApp) {
    return {
      ok: false,
      available: false,
      error: 'in_nian',
      note: '对方这会儿还在念里面，这一屏就是念的界面。不要当成他在刷别的 App，也不要编造屏幕上的内容。',
    };
  }
  if (wantShare && characterId) {
    setShare(true, characterId);
    let name = '';
    try {
      const row = require('./db').prepare('SELECT name FROM characters WHERE id=?').get(characterId);
      name = String(row?.name || '').trim();
    } catch {}
    const shareCmd = { type: 'screen_share', on: true, characterId, name: name || 'TA' };
    enqueueCommand(shareCmd);
    try { push?.broadcast?.({ type: 'phone_command', command: 'screen_share', ...shareCmd }); } catch {}
  }
  const requestId = crypto.randomBytes(12).toString('hex');
  enqueueCommand({ type: 'screen', requestId, mode });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      _screenWait.delete(requestId);
      resolve(null);
    }, SCREEN_WAIT_MS);
    _screenWait.set(requestId, { resolve, timer });
    try {
      push?.broadcast?.({ type: 'phone_command', command: 'screen', requestId, mode });
    } catch (e) {
      // 网页信道没有也没关系，前台服务会把排队的看屏拉走
    }
  });
  if (!result) {
    return {
      ok: false,
      available: false,
      error: 'timeout',
      note: '跟手机要屏幕时没回。App 可能在后台被杀掉，或还没开无障碍。不要编造屏幕上的内容。',
    };
  }
  if (!result.ok) {
    const err = result.error || 'failed';
    if (err === 'rear_cam') {
      return {
        ok: false,
        available: false,
        error: 'rear_cam',
        note: '后置摄像头开着。这会儿看不到手机屏幕，只能看镜头对着的地方，但没拿到画面。不要编造。',
      };
    }
    return {
      ok: false,
      available: false,
      error: err,
      note: err === 'a11y_off'
        ? '用户还没打开无障碍，读不到屏幕上的字。不要编造。'
        : '没看成这一屏。不要编造上面有什么。',
    };
  }
  const hasTree = !!String(result.tree || '').trim();
  const hasImg = !!result.imageDataUrl;
  const selfie = typeof result.selfieDataUrl === 'string' && result.selfieDataUrl.startsWith('data:image/')
    ? result.selfieDataUrl
    : '';
  const source = String(result.source || '').trim();
  const overlayNote = wantShare
    ? ' 底部光环、圆形通话头像、输入框、「操纵中」条都是念的界面，不是用户在看的内容，不要描述。'
    : '';
  const talkNote = '按性格和此刻心情决定提不提、提多少：可以随口点一样，也可以当没看见、接着聊原来的事。不要把画面上每样东西都念一遍，不要提识屏或工具。';
  if (source === 'rear_cam') {
    if (!hasImg) {
      return {
        ok: false,
        available: false,
        error: 'rear_cam',
        note: '后置摄像头开着。这会儿看不到手机屏幕，只能看镜头对着的地方，但没拿到画面。不要编造。',
      };
    }
    return {
      ok: true,
      available: true,
      mode,
      source: 'rear_cam',
      screenshot: true,
      imageDataUrl: result.imageDataUrl,
      note: `后置摄像头开着。这张是镜头对着的地方，不是手机屏幕。${talkNote}`,
    };
  }
  if (!hasTree && !hasImg) {
    return {
      ok: false,
      available: false,
      error: 'empty',
      note: '这一屏几乎没有可读的字，也没截到图。不要编造。',
    };
  }
  const plusSelfie = source === 'screen_plus_selfie' && !!selfie;
  return {
    ok: true,
    available: true,
    mode,
    source: plusSelfie ? 'screen_plus_selfie' : (source || 'screen'),
    app: result.app || result.package || '',
    package: result.package || '',
    tree: hasImg ? '' : (hasTree ? result.tree : ''),
    targets: String(result.targets || '').trim(),
    screenshot: hasImg,
    imageDataUrl: hasImg ? result.imageDataUrl : null,
    selfieDataUrl: plusSelfie ? selfie : null,
    note: hasImg
      ? (plusSelfie
        ? `第一张是手机这一屏，第二张是视频通话前置镜头里的人。${talkNote}${overlayNote}`
        : `画面已另外附上。${talkNote}${overlayNote}`)
      : `没截到图，下面是无障碍读到的字。看不清就老实说，不要编造。${talkNote}${overlayNote}`,
  };
}

const CONTROL_DANGER_RE = /支付|付款|转账|立即购买|确认购买|确认付款|立即支付|开通会员|开通超级|密码|付款码|指纹|面容支付|提交订单|绑卡|充值/;

function startShareIfNeeded(characterId, push) {
  const cid = Number(characterId) || 0;
  if (!cid) return;
  if (!isPreferredScreenChatChar(cid)) return;
  setShare(true, cid);
  let name = '';
  try {
    const row = require('./db').prepare('SELECT name FROM characters WHERE id=?').get(cid);
    name = String(row?.name || '').trim();
  } catch {}
  const shareCmd = { type: 'screen_share', on: true, characterId: cid, name: name || 'TA' };
  enqueueCommand(shareCmd);
  try { push?.broadcast?.({ type: 'phone_command', command: 'screen_share', ...shareCmd }); } catch {}
}

async function controlScreen(opts = {}) {
  const action = String(opts.action || '').trim();
  const text = String(opts.text || '').trim();
  const characterId = Number(opts.characterId) || 0;
  if (characterId && !isPreferredScreenChatChar(characterId)) {
    return {
      ok: false,
      available: false,
      error: 'not_preferred',
      note: '控屏这会儿轮不到你。按性格接着聊，不要提这个。',
    };
  }
  if (action === 'open' || action === 'launch') {
    return {
      ok: false,
      available: false,
      error: 'no_open',
      note: '不能代开应用。可以切歌或点当前这一屏，不要假装打开了。',
    };
  }
  let push;
  try { push = require('./push'); } catch { push = null; }
  if (!phoneReachable()) {
    return { ok: false, available: false, error: 'no_phone', note: '用户手机这会儿没连上念。不要假装已经点过。' };
  }
  if (userInNian()) {
    return { ok: false, available: false, error: 'in_nian', note: '对方这会儿还在念里面，不要去点屏幕。' };
  }
  if (CONTROL_DANGER_RE.test(text)) {
    return { ok: false, available: false, error: 'blocked', note: '支付、转账、密码这类不能代点。跟用户说一声，让他自己点。' };
  }
  const okAction = /^(tap|click|tap_text|click_text|swipe|back|home|recents|type|media_next|media_prev|media_play|media_pause|next|prev|play|pause)$/.test(action);
  if (!okAction) {
    return { ok: false, available: false, error: 'bad_action', note: '动作不对。不能打开应用。点字用 tap_text，坐标用 tap，滑动用 swipe，返回用 back，切歌用 media_*。' };
  }
  if ((action === 'tap_text' || action === 'click_text' || action === 'type') && !text) {
    return { ok: false, available: false, error: 'no_text', note: '没说要点哪个字或要输入什么。' };
  }
  startShareIfNeeded(characterId, push);
  const requestId = crypto.randomBytes(12).toString('hex');
  const cmd = {
    type: 'control',
    requestId,
    action,
    text,
    x: opts.x,
    y: opts.y,
    x2: opts.x2,
    y2: opts.y2,
    durationMs: opts.durationMs,
  };
  enqueueCommand(cmd);
  try { push?.broadcast?.({ type: 'phone_command', command: 'control', ...cmd }); } catch {}
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      _screenWait.delete(requestId);
      resolve(null);
    }, SCREEN_WAIT_MS);
    _screenWait.set(requestId, { resolve, timer });
  });
  if (!result) {
    return { ok: false, available: false, error: 'timeout', note: '手机没回。无障碍可能没开，或 App 在后台被杀掉。不要假装点过了。' };
  }
  if (!result.ok) {
    const err = result.error || 'failed';
    return {
      ok: false,
      available: false,
      error: err,
      app: result.app || '',
      matches: result.matches || [],
      note: err === 'a11y_off'
        ? '用户还没打开无障碍，点不了。不要假装点过。'
        : err === 'blocked'
          ? '这一下被拦住了（支付/密码类）。让用户自己点。'
          : err === 'locked'
            ? '手机还锁着，点不了。不要假装已经点过。'
            : '没点上。看返回的可点列表再试，或老实说没点到。',
    };
  }
  return {
    ok: true,
    available: true,
    action,
    app: result.app || result.package || '',
    package: result.package || '',
    tree: String(result.tree || '').trim(),
    targets: String(result.targets || '').trim(),
    note: '已经动手了。下面是操作后这一屏的字和可点项（坐标 0~1）。底部那圈光环、气泡、以及「操纵中」条是念的浮层，不是屏幕内容，也不代表用户在玩小机。若还想看清画面可以再识一屏。看完用自己的口吻说，不要提工具名。',
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseAlarmTime(opts = {}) {
  let hour = opts.hour == null || opts.hour === '' ? NaN : Number(opts.hour);
  let minute = opts.minute == null || opts.minute === '' ? NaN : Number(opts.minute);
  const when = String(opts.when || opts.time || '').trim();
  const hm = when.match(/^(\d{1,2})[:：](\d{2})$/);
  if (hm) {
    hour = Number(hm[1]);
    minute = Number(hm[2]);
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  hour = Math.round(hour);
  minute = Math.round(minute);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  let dayOffset = Math.max(0, Math.round(Number(opts.dayOffset) || 0));
  if (opts.tomorrow === true || opts.tomorrow === 1 || /明天|明日/.test(String(opts.when || opts.label || ''))) {
    dayOffset = Math.max(dayOffset, 1);
  }
  const repeat = String(opts.repeat || '').toLowerCase() === 'daily' || /每天|每日|everyday/i.test(String(opts.repeat || ''))
    ? 'daily'
    : 'once';
  return { hour, minute, dayOffset, repeat };
}

async function synthesizeAlarmVoice(characterId, speech) {
  const cid = Number(characterId) || 0;
  const text = String(speech || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!cid || !text) return { audioUrl: '', error: 'no_speech' };
  try {
    const db = require('./db');
    const char = db.prepare('SELECT voice_id, name, mood, emotion_state FROM characters WHERE id=?').get(cid);
    const vid = String(char?.voice_id || '').trim();
    if (!vid) return { audioUrl: '', name: String(char?.name || ''), error: 'no_voice_id' };
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
    const { callTTS } = require('./api-helper');
    const { sanitizeForSpeech } = require('./speech-text-helper');
    const speak = sanitizeForSpeech(text, { dropAsides: true });
    if (!speak) return { audioUrl: '', name: String(char.name || ''), error: 'empty' };
    const buffer = await callTTS(settings, speak, vid, {
      mood: char.mood,
      emotionState: char.emotion_state,
    });
    if (!buffer || buffer.length < 80) return { audioUrl: '', name: String(char.name || ''), error: 'tts_empty' };
    const fs = require('fs');
    const path = require('path');
    const uploads = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploads)) fs.mkdirSync(uploads, { recursive: true });
    const filename = `alarm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp3`;
    fs.writeFileSync(path.join(uploads, filename), buffer);
    return { audioUrl: `/uploads/${filename}`, name: String(char.name || ''), bytes: buffer.length };
  } catch (e) {
    return { audioUrl: '', error: e.message || 'tts_failed' };
  }
}

async function handleAlarm(opts = {}) {
  const action = String(opts.action || 'set').trim() || 'set';
  const characterId = Number(opts.characterId) || 0;
  let push;
  try { push = require('./push'); } catch { push = null; }
  if (!phoneReachable()) {
    return { ok: false, available: false, error: 'no_phone', note: '用户手机这会儿没连上念。不要假装已经设好闹钟。' };
  }

  if (action === 'list' || action === 'cancel') {
    const requestId = crypto.randomBytes(12).toString('hex');
    const cmd = { type: 'alarm', requestId, action, id: Number(opts.id) || 0 };
    enqueueCommand(cmd);
    try { push?.broadcast?.({ type: 'phone_command', command: 'alarm', ...cmd }); } catch {}
    const result = await waitPhone(requestId, 18000);
    if (!result) {
      return { ok: false, available: false, error: 'timeout', note: '手机没回。App 可能在后台被杀掉。不要假装查过/改过闹钟。' };
    }
    if (action === 'list') {
      const raw = Array.isArray(result.alarms) ? result.alarms : [];
      const alarms = raw.filter((a) => a && a.enabled !== false);
      if (!alarms.length) {
        return { ok: true, available: true, alarms: [], note: '手机上现在没有念设的角色闹钟。不要编造有闹钟。' };
      }
      const lines = alarms.slice(0, 12).map((a) => {
        const t = `${pad2(a.hour)}:${pad2(a.minute)}`;
        const rep = a.repeat === 'daily' ? '每天' : '一次';
        const who = a.name ? `${a.name} ` : '';
        const lab = a.label ? ` ${a.label}` : '';
        return `${t} ${rep}${lab}${a.hasVoice ? `（${who}的声音）` : ''}`.trim();
      });
      return {
        ok: true,
        available: true,
        alarms,
        note: `当前角色闹钟：${lines.join('；')}。用自己的口吻说，不要提工具名。`,
      };
    }
    if (!result.ok) {
      return { ok: false, available: false, error: result.error || 'failed', note: '没取消掉。不要假装已经关掉。' };
    }
    return { ok: true, available: true, note: '已经帮用户关掉这个闹钟。用自己的口吻说一声即可。' };
  }

  const t = parseAlarmTime(opts);
  if (!t) {
    return { ok: false, available: false, error: 'bad_time', note: '时间没听清。再问一句几点几分。' };
  }
  let speech = String(opts.speech || opts.text || '').replace(/\s+/g, ' ').trim();
  if (!speech) {
    const label = String(opts.label || '').trim();
    speech = label ? `${label}。起来吧。` : '该起床了，别再睡了。';
  }
  speech = speech.slice(0, 180);
  const voice = await synthesizeAlarmVoice(characterId, speech);
  const requestId = crypto.randomBytes(12).toString('hex');
  const cmd = {
    type: 'alarm',
    requestId,
    action: 'set',
    hour: t.hour,
    minute: t.minute,
    dayOffset: t.dayOffset,
    tomorrow: t.dayOffset > 0,
    repeat: t.repeat,
    label: String(opts.label || '').trim().slice(0, 40),
    speech,
    audioUrl: voice.audioUrl || '',
    characterId,
    name: voice.name || '',
  };
  enqueueCommand(cmd);
  try { push?.broadcast?.({ type: 'phone_command', command: 'alarm', ...cmd }); } catch {}
  const result = await waitPhone(requestId, 28000);
  if (!result) {
    return { ok: false, available: false, error: 'timeout', note: '手机没回。可能还没允许「闹钟和提醒」，或 App 在后台被杀掉。不要假装已经设好。' };
  }
  if (!result.ok) {
    const err = result.error || 'failed';
    return {
      ok: false,
      available: false,
      error: err,
      note: err === 'exact_alarm_off'
        ? '用户还没允许念设置精确闹钟。让他自己到设置 → 高阶权限 → 角色闹钟里打开「闹钟和提醒」。不要假装已经设好。'
        : '闹钟没设上。不要假装已经设好。',
    };
  }
  const hh = pad2(result.hour == null ? t.hour : result.hour);
  const mm = pad2(result.minute == null ? t.minute : result.minute);
  const whenLabel = t.repeat === 'daily' ? `每天 ${hh}:${mm}` : `${t.dayOffset > 0 ? '明天 ' : ''}${hh}:${mm}`;
  const voiceNote = result.hasVoice
    ? '响铃是你刚才那句话的录音，会循环播放。'
    : (voice.error === 'no_voice_id'
      ? '闹钟已设，但这个角色还没填声音 ID，会用系统铃声。'
      : '闹钟已设，语音没合成成功，会用系统铃声。');
  return {
    ok: true,
    available: true,
    alarmId: result.alarmId,
    when: `${hh}:${mm}`,
    repeat: t.repeat,
    hasVoice: !!result.hasVoice,
    note: `已经设好 ${whenLabel} 的闹钟。${voiceNote}用自己的口吻告诉用户，不要提工具名。`,
  };
}

function waitPhone(requestId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _screenWait.delete(requestId);
      resolve(null);
    }, ms);
    _screenWait.set(requestId, { resolve, timer });
  });
}

module.exports = {
  ingest,
  snapshot,
  ageMs,
  query,
  notificationResult,
  toolResult: notificationResult,
  statusResult,
  usageResult,
  appsResult,
  healthResult,
  refreshHealth,
  ingestLocation,
  locationResult,
  refreshLocation,
  fulfillLocation,
  captureScreen,
  controlScreen,
  handleAlarm,
  fulfillScreen,
  fulfillHealth,
  pullCommands,
  enqueueCommand,
  enqueueCapsule,
  enqueueIncomingCall,
  enqueueDismissIncomingCall,
  phoneReachable,
  setShare,
  shareActive,
  preferredScreenChatCharId,
  isPreferredScreenChatChar,
  userAwayFromNian,
  userInNian,
  waitPhone,
};

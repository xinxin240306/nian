/* ===== API 调用层 ===== */
import {
  getApiBase,
  getServerBase,
  resolveApiUrl,
  isNativeShell,
  getSiteSessionToken,
  setSiteSessionToken,
} from './server-config.js';

export function explainBackendUnreachable() {
  if (isNativeShell()) {
    const base = getServerBase() || '未设置';
    return `暂时连不上服务器（${base}）。请检查手机网络、代理，以及设置里的服务器地址`;
  }
  return '后端没有响应，请确认已在 backend 目录运行 node server.js';
}

if (typeof window !== 'undefined') {
  window.explainBackendUnreachable = explainBackendUnreachable;
}

function isNetworkFetchError(e) {
  const msg = String(e?.message || e || '');
  return e?.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg);
}

function explainHtmlInsteadOfApi(path, status) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const hint = isNativeShell()
    ? `请确认 App 里填写的服务器地址正确，且电脑/VPS 上 backend 已启动（当前壳 ${origin || '未知'}）。`
    : `请确认：① 已在 backend 目录运行 node server.js；② 用 http://localhost:3000 打开应用（当前 ${origin || '未知地址'}）。不要用 Live Server、不要直接双击打开 html 文件。`;
  return `请求 ${path} 返回了网页而不是 API 数据。${hint}`;
}

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getSiteSessionToken();
  if (token) headers['X-Nian-Session'] = token;
  return headers;
}

function apiCredentials() {
  return isNativeShell() ? 'include' : 'same-origin';
}

export async function parseApiResponse(resp, path) {
  const ct = resp.headers.get('content-type') || '';
  const text = await resp.text();
  const looksHtml = text.trim().startsWith('<') || ct.includes('text/html');
  if (looksHtml) {
    throw new Error(explainHtmlInsteadOfApi(path, resp.status));
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`服务器返回了非 JSON（HTTP ${resp.status}）：${text.slice(0, 120)}`);
  }
  return data;
}

function isFetchAbortError(e) {
  if (!e) return false;
  if (e.name === 'AbortError' || e.code === 20) return true;
  // 部分 WebView / Capacitor 只给英文文案，name 不一定是 AbortError
  return /user aborted|aborted a request|The operation was aborted|signal is aborted/i.test(String(e.message || ''));
}

export async function apiFetch(path, options = {}) {
  const { timeoutMs: customTimeout, headers: customHeaders, signal: outerSignal, ...fetchOptions } = options;
  // 生图/聊天等可能远超 45s；慢模型图生图控制台常见 5～10 分钟，前端需等到后端取回图
  const imageSlow = /test-selfie-image|\/image\/(generate|test)|img2img/.test(path);
  const chatSlow = /\/messages\/(send|trigger-ai)/.test(path);
  const slow = imageSlow || chatSlow || /\/send|trigger-ai|generate|import|butler|summarize|backfill|retrospect/.test(path);
  // 聊天：与后端单次 API 超时对齐（120s）。配图已异步，不必再为生图加长等待
  const timeoutMs = customTimeout ?? (imageSlow ? 15 * 60 * 1000 : (chatSlow ? 120000 : (slow ? 130000 : 45000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let resp;
  try {
    resp = await fetch(resolveApiUrl(path), {
      credentials: apiCredentials(),
      ...fetchOptions,
      headers: apiHeaders({ 'Content-Type': 'application/json', ...customHeaders }),
      // signal 必须放最后，避免被 ...fetchOptions 覆盖后永远不超时
      signal: controller.signal,
    });
  } catch (e) {
    if (isFetchAbortError(e)) {
      throw new Error(imageSlow
        ? '生图超时（前端已等约 15 分钟）。对方网站可能仍在出图并已扣费，请先到控制台确认，不要立刻点重试'
        : chatSlow
          ? '角色回复超时（聊天 API 太慢或中转卡住）。可再空按发送重试；若其实已回，刷新聊天可见'
          : '请求超时，后端可能正在忙（导入/聊天/写库），请稍后再试');
    }
    if (isNetworkFetchError(e)) {
      throw new Error(explainBackendUnreachable());
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const data = await parseApiResponse(resp, path);

  if (resp.ok) {
    try { window.noteBackendReachable?.(); } catch {}
  }

  if (!resp.ok) {
    const e = new Error(data.error || `请求失败 ${resp.status}`);
    if (data.needsAuth) {
      e.needsAuth = true;
      window.dispatchEvent(new CustomEvent('nian-needs-auth'));
    }
    if (data.needsTiebaAuth) e.needsTiebaAuth = true;
    if (data.userMsgId != null) e.userMsgId = data.userMsgId;
    throw e;
  }

  return data;
}

async function fetchJsonWithTimeout(path, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { headers: initHeaders, ...rest } = init;
    const resp = await fetch(resolveApiUrl(path), {
      credentials: apiCredentials(),
      ...rest,
      headers: apiHeaders(initHeaders || {}),
      signal: controller.signal,
    });
    return { resp, data: await parseApiResponse(resp, path) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkBackendHealth() {
  try {
    const { resp, data } = await fetchJsonWithTimeout('/api/health', { cache: 'no-store' }, 8000);
    return resp.ok && data.ok === true;
  } catch {
    return false;
  }
}

export async function getSiteAuthStatus() {
  const { data } = await fetchJsonWithTimeout(
    '/api/site-auth/status',
    { cache: 'no-store' },
    8000
  );
  return data;
}

export async function siteAuthLogin(username, password) {
  const data = await apiFetch('/api/site-auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (data?.token) setSiteSessionToken(data.token);
  return data;
}

// Settings
export const getSettings = () => apiFetch('/api/settings');
export const putSettings = (data) => apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(data) });
export const getAppUpdate = () => apiFetch('/api/app-update');
export const postPhoneNotifications = (data) => apiFetch('/api/phone/notifications', { method: 'POST', body: JSON.stringify(data || {}) });
export const postPhoneScreen = (data) => apiFetch('/api/phone/screen', { method: 'POST', body: JSON.stringify(data || {}), timeoutMs: 20000 });
export const postPhoneLocation = (data) => apiFetch('/api/phone/location', { method: 'POST', body: JSON.stringify(data || {}), timeoutMs: 20000 });
export const saveSettings = (data) => apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(data) });
export const robotChat = (data) => apiFetch('/api/robot/chat', { method: 'POST', body: JSON.stringify(data), timeoutMs: 120000 });
export const getRobotStatus = () => apiFetch('/api/robot/status');
export const getRobotBehavior = () => apiFetch('/api/robot/behavior');
export const getRobotCommands = () => apiFetch('/api/robot/commands');
export const getRobotFaceTrackTarget = () => apiFetch('/api/robot/face-track/target');
export const testRobotCamera = (data = {}) =>
  apiFetch('/api/robot/test/camera', { method: 'POST', body: JSON.stringify(data || {}) });
export const testRobotFaceTrack = (data = {}) =>
  apiFetch('/api/robot/test/face-track', { method: 'POST', body: JSON.stringify(data || {}) });
export const testRobotHead = (data = {}) =>
  apiFetch('/api/robot/test/head', { method: 'POST', body: JSON.stringify(data || {}) });
export const startRobotListen = (data = {}) =>
  apiFetch('/api/robot/listen/start', { method: 'POST', body: JSON.stringify(data || {}) });
export const ackRobotCommands = (ids) =>
  apiFetch('/api/robot/commands/ack', { method: 'POST', body: JSON.stringify({ ids }) });
export const robotHeartbeat = () => apiFetch('/api/robot/heartbeat', { method: 'POST', body: '{}' });
export const triggerRobotOutreach = (data = {}) =>
  apiFetch('/api/robot/outreach/trigger', { method: 'POST', body: JSON.stringify(data || {}) });
export const regenerateRobotToken = () => apiFetch('/api/robot/token/regenerate', { method: 'POST', body: '{}' });
export const getMcpServers = () => apiFetch('/api/mcp/servers');
export const saveMcpServer = (data) => apiFetch('/api/mcp/servers', { method: 'POST', body: JSON.stringify(data || {}) });
export const deleteMcpServer = (id) => apiFetch('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ action: 'delete', id }) });
export const testMcpServer = (id) => apiFetch(`/api/mcp/servers/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}', timeoutMs: 30000 });
export const pushRobotFace = (json) =>
  apiFetch('/api/robot/face', { method: 'POST', body: JSON.stringify({ json }), timeoutMs: 30000 });
export const resetRobotFace = () =>
  apiFetch('/api/robot/face/reset', { method: 'POST', body: '{}' });
export const getFaceprintStatus = () => apiFetch('/api/faceprint/status');
export const enrollFaceprint = (embeddings, { merge = true } = {}) =>
  apiFetch('/api/faceprint/enroll', {
    method: 'POST',
    body: JSON.stringify({ embeddings, merge: merge ? '1' : '0' }),
  });
export async function enrollFaceprintPhoto(file, { merge = true } = {}) {
  const fd = new FormData();
  fd.append('files', file);
  fd.append('merge', merge ? '1' : '0');
  const resp = await fetch(resolveApiUrl('/api/faceprint/enroll'), {
    method: 'POST',
    body: fd,
    credentials: apiCredentials(),
    headers: apiHeaders(),
  });
  const data = await parseApiResponse(resp, '/api/faceprint/enroll');
  if (!resp.ok) throw new Error(data.error || '面容录入失败');
  return data;
}
export const setFaceprintEnrollNext = (enable) =>
  apiFetch('/api/faceprint/enroll-next', { method: 'POST', body: JSON.stringify({ enable: !!enable }) });
export const clearFaceprint = () => apiFetch('/api/faceprint/clear', { method: 'POST', body: '{}' });
export const getCharacterRobot = (id) => apiFetch(`/api/characters/${id}/robot`);
export const saveCharacterRobot = (id, data) => apiFetch(`/api/characters/${id}/robot`, { method: 'PUT', body: JSON.stringify(data) });
export const setCharacterRobotOperating = (id, active) =>
  apiFetch(`/api/characters/${id}/robot/operating`, {
    method: 'POST',
    body: JSON.stringify({ active: !!active }),
  });
export async function uploadRobotEmotion(charId, emotion, file) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('emotion', emotion);
  const resp = await fetch(resolveApiUrl(`/api/characters/${charId}/robot/emotion`), {
    method: 'POST',
    body: fd,
    credentials: apiCredentials(),
    headers: apiHeaders(),
  });
  const data = await parseApiResponse(resp, `/api/characters/${charId}/robot/emotion`);
  if (!resp.ok) throw new Error(data.error || '上传失败');
  return data;
}
export async function robotSnapshot({ file, characterId, context, facePresent, skipNote, imageBase64 } = {}) {
  if (file) {
    const fd = new FormData();
    fd.append('file', file);
    if (characterId) fd.append('characterId', String(characterId));
    if (context) fd.append('context', context);
    if (facePresent != null) fd.append('facePresent', facePresent ? '1' : '0');
    if (skipNote) fd.append('skipNote', '1');
    const resp = await fetch(resolveApiUrl('/api/robot/snapshot'), {
      method: 'POST',
      body: fd,
      credentials: apiCredentials(),
      headers: apiHeaders(),
    });
    const data = await parseApiResponse(resp, '/api/robot/snapshot');
    if (!resp.ok) throw new Error(data.error || '抓拍失败');
    return data;
  }
  return apiFetch('/api/robot/snapshot', {
    method: 'POST',
    body: JSON.stringify({ characterId, context, facePresent, skipNote, imageBase64 }),
    timeoutMs: 120000,
  });
}
export const analyzeUserSelfie = (imageUrl, { save = true } = {}) =>
  apiFetch('/api/user/analyze-selfie', {
    method: 'POST',
    body: JSON.stringify({ imageUrl, save: save ? 1 : 0 }),
  });

// Characters
export const getContactRequests = () => apiFetch('/api/contacts/requests');
export const setContactRemark = (id, remark) =>
  apiFetch(`/api/contacts/${id}/remark`, { method: 'POST', body: JSON.stringify({ remark }) });
export const addContactFriend = (id) =>
  apiFetch(`/api/contacts/${id}/add`, { method: 'POST', body: '{}' });
export const createFriendRequest = (characterId, message = '') =>
  apiFetch('/api/contacts/requests', {
    method: 'POST',
    body: JSON.stringify({ characterId, message }),
  });
export const shakeMeet = () =>
  apiFetch('/api/shake/meet', { method: 'POST', body: '{}', timeoutMs: 90000 });
export const blockContact = (id) =>
  apiFetch(`/api/contacts/${id}/block`, { method: 'POST', body: '{}' });
export const deleteContactFriend = (id, opts = {}) =>
  apiFetch(`/api/contacts/${id}/delete-friend`, {
    method: 'POST',
    body: JSON.stringify({ wipeTraces: !!opts.wipeTraces }),
  });
export const unblockContact = (id) =>
  apiFetch(`/api/contacts/${id}/unblock`, { method: 'POST', body: '{}' });
export const respondFriendRequest = (id, accept) =>
  apiFetch(`/api/contacts/requests/${id}/respond`, { method: 'POST', body: JSON.stringify({ accept: !!accept }) });

export const getCharacters = (opts = {}) => {
  const q = opts.scope ? `?scope=${encodeURIComponent(opts.scope)}` : '';
  return apiFetch(`/api/characters${q}`, opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {});
};
export const getCharacter = (id) => apiFetch(`/api/characters/${id}`);
export const getCharDailyStatus = (id) => apiFetch(`/api/characters/${id}/daily-status`);
export const getCharContextTokens = (id, isDream = false) => apiFetch(`/api/characters/${id}/context-tokens${isDream ? '?dream=1' : ''}`);
export const createCharacter = (data) => apiFetch('/api/characters', { method: 'POST', body: JSON.stringify(data) });
export const updateCharacter = (id, data) => apiFetch(`/api/characters/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteCharacter = (id) => apiFetch(`/api/characters/${id}`, { method: 'DELETE' });
export const scanCharacterNicknames = (id) => apiFetch(`/api/characters/${id}/scan-nicknames`, { method: 'POST', timeoutMs: 90000 });
export const exportCharacterCard = (id) => apiFetch(`/api/characters/${id}/export-card`);
export const importCharacterCard = (data) => apiFetch('/api/characters/import-card', { method: 'POST', body: JSON.stringify(data) });
export const setCharStatus = (id, status) => apiFetch(`/api/characters/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
export const startTheater = (id) => apiFetch(`/api/characters/${id}/theater/start`, { method: 'POST' });
export const endTheater = (id) => apiFetch(`/api/characters/${id}/theater/end`, { method: 'POST' });
export const pokeCharacter = (id) => apiFetch(`/api/characters/${id}/poke`, { method: 'POST' });
export const getPokeSuffix = (id) => apiFetch(`/api/characters/${id}/poke-suffix`, { method: 'POST' });
export const userPoke = (id) => apiFetch(`/api/characters/${id}/user-poke`, { method: 'POST' });

// Messages
export const getMessages = (charId, { dream = 0, limit = 50, offset = 0, sinceId, beforeId, aroundId, timeoutMs } = {}) => {
  const q = new URLSearchParams({ dream: String(dream), limit: String(limit) });
  if (aroundId) q.set('aroundId', String(aroundId));
  else if (sinceId) q.set('sinceId', String(sinceId));
  else if (beforeId) q.set('beforeId', String(beforeId));
  else q.set('offset', String(offset || 0));
  return apiFetch(`/api/messages/${charId}?${q}`, {
    ...(timeoutMs != null ? { timeoutMs } : {}),
  });
};
export const markMessagesRead = (charId, dream = 0, ids) =>
  apiFetch(`/api/messages/${charId}/mark-read`, {
    method: 'POST',
    body: JSON.stringify({
      dream,
      ...(Array.isArray(ids) && ids.length ? { ids } : {}),
    }),
  });
export const markPeerReadUserMessages = (charId, dream = 0) =>
  apiFetch(`/api/messages/${charId}/peer-read`, { method: 'POST', body: JSON.stringify({ dream }) });
export const getUnreadSummary = () => apiFetch('/api/messages/unread-summary', { timeoutMs: 12000 });
export const searchMessages = (charId, q, { dream = 0, limit = 50, date = '' } = {}) =>
  apiFetch(`/api/messages/${charId}/search?q=${encodeURIComponent(q || '')}&dream=${dream}&limit=${limit}${date ? `&date=${encodeURIComponent(date)}` : ''}`);
export const getMessageBounds = (charId, dream = 0) =>
  apiFetch(`/api/messages/${charId}/bounds?dream=${Number(dream) ? 1 : 0}`);
export const ackMessageArchive = (charId, dream, upToId) =>
  apiFetch('/api/messages/archive-ack', {
    method: 'POST',
    body: JSON.stringify({ characterId: charId, dream: Number(dream) ? 1 : 0, upToId }),
  });
export const getStorePolicy = () => apiFetch('/api/store-policy', { timeoutMs: 20000 });
export const greetCharacter = (characterId, isDream = false) =>
  apiFetch('/api/messages/greet', { method: 'POST', body: JSON.stringify({ characterId, isDream }) });
export const sendMessage = (data) => apiFetch('/api/messages/send', { method: 'POST', body: JSON.stringify(data) });
/** live:true = 聊天发实时位置等：不要用已存的「家/公司」锚点改写地名 */
export const reverseGeocode = (lat, lng, opts = {}) => {
  const q = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
  });
  if (opts.live || opts.skipStanding) q.set('live', '1');
  return apiFetch(`/api/geocode/reverse?${q}`);
};
export const ensureMapPreview = ({ lat, lng, q } = {}) => {
  const params = new URLSearchParams();
  if (Number.isFinite(Number(lat))) params.set('lat', String(lat));
  if (Number.isFinite(Number(lng))) params.set('lng', String(lng));
  if (q) params.set('q', String(q));
  return apiFetch(`/api/geocode/map-preview?${params}`);
};
export const triggerAi = (characterId, isDream, mode, dreamMask = false, dreamStyle = null, isVoiceCall = false, catchUp = false, gameTopicContext = null, callRollHint = null, dreamConfig = null, extra = {}) =>
  apiFetch('/api/messages/trigger-ai', { method: 'POST', body: JSON.stringify({
    characterId, isDream, mode, dreamMask, dreamStyle, isVoiceCall, catchUp,
    gameTopicContext: gameTopicContext || undefined,
    callRollHint: callRollHint || undefined,
    dreamConfig: dreamConfig || undefined,
    isVideoCall: extra.isVideoCall || undefined,
    callLookImage: extra.callLookImage || undefined,
    callPresenceMode: extra.callPresenceMode || undefined,
    callHangoutWakeStep: extra.callHangoutWakeStep || undefined,
    callHangoutSleeping: extra.callHangoutSleeping || undefined,
    callInputMode: extra.callInputMode || undefined,
  }) });
export const fetchHangoutBed = (characterId) =>
  apiFetch('/api/call/hangout-bed', {
    method: 'POST',
    body: JSON.stringify({ characterId }),
    timeoutMs: 90000,
  });
export const fetchWatchScene = (characterId, imageUrl) =>
  apiFetch('/api/call/watch-scene', {
    method: 'POST',
    body: JSON.stringify({ characterId, imageUrl }),
    timeoutMs: 90000,
  });
export const getDreamChoices = (characterId, { dreamMask = false, dreamStyle = '', dreamConfig = null } = {}) =>
  apiFetch('/api/dream/choices', {
    method: 'POST',
    body: JSON.stringify({ characterId, dreamMask, dreamStyle, dreamConfig }),
    timeoutMs: 90000,
  });
export const saveDreamMemory = (characterId, content, date) => apiFetch('/api/memories', { method: 'POST', body: JSON.stringify({ characterId, category: '梦境', content, weight: 0.7, date }) });
export const recallMessage = (id) => apiFetch(`/api/messages/recall/${id}`, { method: 'POST' });
export const updateMessage = (id, data) => apiFetch(`/api/messages/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const updateMessageBubble = (bubbleId, content) =>
  apiFetch(`/api/messages/bubble/${encodeURIComponent(String(bubbleId))}`, { method: 'PATCH', body: JSON.stringify({ content }) });
export const deleteMessage = (id) => apiFetch(`/api/messages/${id}`, { method: 'DELETE' });
export const rerollMediaMessage = (id) =>
  apiFetch(`/api/messages/${id}/reroll-media`, { method: 'POST', timeoutMs: 120000 });
export const deleteMessagesBatch = (bubbles) =>
  apiFetch('/api/messages/batch-delete', { method: 'POST', body: JSON.stringify({ bubbles }) });
/** 按数据库消息 id 整条删除（重新生成清旧回复用；不要走 bubbles 分段删除） */
export const deleteMessagesByIds = (ids) =>
  apiFetch('/api/messages/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
export const clearMessages = (charId, dream = 0) => apiFetch(`/api/messages/character/${charId}?dream=${dream}`, { method: 'DELETE' });
export const clearDreamDates = (charId, dates) =>
  apiFetch(`/api/messages/character/${charId}/clear-dream-dates`, { method: 'POST', body: JSON.stringify({ dates }) });

// Call logs
export const saveCallLog = (data) => apiFetch('/api/call-logs', { method: 'POST', body: JSON.stringify(data) });
export const resolveIncomingCall = (data) => apiFetch('/api/calls/incoming-result', { method: 'POST', body: JSON.stringify(data) });

// Character mood
export const updateCharMood = (charId, mood) => apiFetch(`/api/characters/${charId}/mood`, { method: 'PATCH', body: JSON.stringify({ mood }) });
export const getCharEmotion = (charId, hours = 2) =>
  apiFetch(`/api/characters/${charId}/emotion?hours=${encodeURIComponent(hours)}`);

export const summarizeChatMemory = (charId, rounds) => apiFetch(`/api/memories/${charId}/summarize`, {
  method: 'POST',
  body: JSON.stringify({ rounds }),
});
export const backfillChatMemories = (charId, data = {}) => apiFetch(`/api/memories/${charId}/backfill`, {
  method: 'POST',
  body: JSON.stringify(data),
});

// Generate impressions via AI (no chat message side-effect)
export const generateImpressions = (charId) => apiFetch(`/api/impressions/${charId}/generate`, { method: 'POST', timeoutMs: 90000 });
export const tidyImpressions = (charId) => apiFetch(`/api/impressions/${charId}/tidy`, { method: 'POST', body: '{}', timeoutMs: 120000 });

export const getSelfViews = (charId) => apiFetch(`/api/self-views/${charId}`);
export const createSelfView = (data) => apiFetch('/api/self-views', { method: 'POST', body: JSON.stringify(data) });
export const updateSelfView = (id, data) => apiFetch(`/api/self-views/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteSelfView = (id) => apiFetch(`/api/self-views/${id}`, { method: 'DELETE' });
export const mergeSelfViews = (charId, items, source) => apiFetch(`/api/self-views/${charId}/merge`, { method: 'POST', body: JSON.stringify({ items, source }) });
export const generateSelfViews = (charId) => apiFetch(`/api/self-views/${charId}/generate`, { method: 'POST', timeoutMs: 90000 });
export const tidySelfViews = (charId) => apiFetch(`/api/self-views/${charId}/tidy`, { method: 'POST', body: '{}', timeoutMs: 120000 });

export const getArchive = (charId) => apiFetch(`/api/archive/${charId}`);
export const createArchiveEntry = (data) => apiFetch('/api/archive', { method: 'POST', body: JSON.stringify(data) });
export const updateArchiveEntry = (id, data) => apiFetch(`/api/archive/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteArchiveEntry = (id) => apiFetch(`/api/archive/${id}`, { method: 'DELETE' });
export const digestArchive = (charId) => apiFetch(`/api/archive/${charId}/digest`, { method: 'POST', body: '{}', timeoutMs: 150000 });

export const getLivedMemory = (charId) => apiFetch(`/api/lived/${charId}`);
export const getLivedDay = (charId, date) => apiFetch(`/api/lived/${charId}/day/${date}`);
export const digestLivedDay = (charId, date) => apiFetch(`/api/lived/${charId}/digest`, {
  method: 'POST',
  body: JSON.stringify({ date: date || '' }),
  timeoutMs: 150000,
});

export const getUserReads = (charId) => apiFetch(`/api/user-reads/${charId}`);
export const getSelfReads = (charId) => apiFetch(`/api/user-reads/${charId}?about=self`);
export const createUserRead = (data) => apiFetch('/api/user-reads', { method: 'POST', body: JSON.stringify(data) });
export const updateUserRead = (id, data) => apiFetch(`/api/user-reads/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteUserRead = (id) => apiFetch(`/api/user-reads/${id}`, { method: 'DELETE' });
export const digestUserReads = (charId, date) => apiFetch(`/api/user-reads/${charId}/digest`, {
  method: 'POST',
  body: JSON.stringify({ date: date || '' }),
  timeoutMs: 150000,
});

// Import chat history (single or batch). Batch: { messages, is_dream }
export const saveImportedMessage = (charId, msg) =>
  apiFetch(`/api/messages/${charId}/import`, { method: 'POST', body: JSON.stringify(msg) });
export const saveImportedMessages = (charId, messages, { isDream = false } = {}) =>
  apiFetch(`/api/messages/${charId}/import`, {
    method: 'POST',
    body: JSON.stringify({ messages, is_dream: isDream ? 1 : 0 }),
    timeoutMs: 180000,
  });

// Memories
export const getMemories = (charId) => apiFetch(`/api/memories/${charId}`);
export const getBrainNow = (charId) => apiFetch(`/api/brain/${charId}/now`);
export const searchContextPinCandidates = (charId, q = '') => apiFetch(`/api/brain/${charId}/context-pins/candidates?q=${encodeURIComponent(q || '')}`);
export const mutateContextPin = (charId, body) => apiFetch(`/api/brain/${charId}/context-pins`, { method: 'POST', body: JSON.stringify(body) });
export const getBrainExperiences = (charId) => apiFetch(`/api/brain/${charId}/experiences`);
export const getBrainExperience = (charId, kind, id) => apiFetch(`/api/brain/${charId}/experiences/${kind}/${id}`);
export const getBrainTidy = (charId) => apiFetch(`/api/brain/${charId}/tidy`);
export const rebuildBrainAffection = (charId) => apiFetch(`/api/brain/${charId}/affection/rebuild`, { method: 'POST', body: '{}' });
export const rebuildNarrativeLinks = (charId) => apiFetch(`/api/brain/${charId}/narrative-links/rebuild`, { method: 'POST', body: '{}' });
export const createMemory = (data) => apiFetch('/api/memories', { method: 'POST', body: JSON.stringify(data) });
export const updateMemory = (id, data) => apiFetch(`/api/memories/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteMemory = (id) => apiFetch(`/api/memories/${id}`, { method: 'DELETE' });
export const clearMemories = (charId) => apiFetch(`/api/memories/character/${charId}`, { method: 'DELETE' });
export const auditMemories = (charId, data = {}) => apiFetch(`/api/memories/${charId}/butler`, { method: 'POST', body: JSON.stringify(data) });
export const getMemoryNarratives = (charId) => apiFetch(`/api/memory-narratives/${charId}`);
export const getMemoryNarrative = (id) => apiFetch(`/api/memory-narratives/item/${id}`);
export const runMemoryNarrative = (charId, heavy = false) => apiFetch(`/api/memory-narratives/${charId}/run`, { method: 'POST', body: JSON.stringify({ heavy }) });
// 睡前整理：碎片 → 记忆点 → 挂树
export const consolidateMemoryDay = (charId, date = '') => apiFetch(`/api/memory-day/${charId}/consolidate`, { method: 'POST', body: JSON.stringify({ date }), timeoutMs: 180000 });
export const pruneMemoryTrees = (charId, opts = {}) => apiFetch(`/api/memory-day/${charId}/prune`, { method: 'POST', body: JSON.stringify(opts), timeoutMs: 300000 });
export const getMemoryDayPending = (charId) => apiFetch(`/api/memory-day/${charId}/pending`);
export const closeMemoryNarrative = (id) => apiFetch(`/api/memory-narratives/item/${id}/close`, { method: 'POST', body: '{}' });
export const deleteMemoryNarrative = (id) => apiFetch(`/api/memory-narratives/item/${id}`, { method: 'DELETE' });
export const deleteMemoryBranch = (id) => apiFetch(`/api/memory-branches/${id}`, { method: 'DELETE' });

// Diaries
export const getDiaries = (params = {}) => {
  const q = new URLSearchParams(params).toString();
  return apiFetch(`/api/diaries${q ? '?' + q : ''}`);
};
export const createDiary = (data) => apiFetch('/api/diaries', { method: 'POST', body: JSON.stringify(data) });
export const updateDiary = (id, data) => apiFetch(`/api/diaries/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteDiary = (id) => apiFetch(`/api/diaries/${id}`, { method: 'DELETE' });
export const peekDiary = (id, data) => apiFetch(`/api/diaries/${id}/peek`, { method: 'POST', body: JSON.stringify(data) });
export const generateAiDiary = (charId, data = {}) => apiFetch(`/api/diaries/generate-ai/${charId}`, { method: 'POST', body: JSON.stringify(data) });
export const savePeekToMemory = (id, data) => apiFetch(`/api/diaries/${id}/save-peek-to-memory`, { method: 'POST', body: JSON.stringify(data) });
export const decorateDiaryStickers = (id, data = {}) => apiFetch(`/api/diaries/${id}/decorate-stickers`, { method: 'POST', body: JSON.stringify(data) });

export const getSecretNotes = (params = {}) => {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  ).toString();
  return apiFetch(`/api/secret-notes${q ? '?' + q : ''}`);
};
export const createSecretNote = (data) => apiFetch('/api/secret-notes', { method: 'POST', body: JSON.stringify(data) });
export const updateSecretNote = (id, data) => apiFetch(`/api/secret-notes/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteSecretNote = (id) => apiFetch(`/api/secret-notes/${id}`, { method: 'DELETE' });
export const generateSecretNotes = (data) => apiFetch('/api/secret-notes/generate', { method: 'POST', body: JSON.stringify(data) });
export const peekSecretNote = (id, data) => apiFetch(`/api/secret-notes/${id}/peek`, { method: 'POST', body: JSON.stringify(data) });
export const saveSecretPeekToMemory = (id, data) => apiFetch(`/api/secret-notes/${id}/save-peek-to-memory`, { method: 'POST', body: JSON.stringify(data) });

export const getSecretStickers = (ownerType, ownerId) =>
  apiFetch(`/api/secret-stickers?ownerType=${encodeURIComponent(ownerType)}&ownerId=${ownerId}`);
export const createSecretSticker = (data) => apiFetch('/api/secret-stickers', { method: 'POST', body: JSON.stringify(data) });
export const updateSecretSticker = (id, data) => apiFetch(`/api/secret-stickers/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteSecretSticker = (id) => apiFetch(`/api/secret-stickers/${id}`, { method: 'DELETE' });

// TA 情侣
export const getTa = () => apiFetch('/api/ta');
export const bindTa = (characterId) => apiFetch('/api/ta/bind', { method: 'PUT', body: JSON.stringify({ characterId }) });
export const unbindTa = () => apiFetch('/api/ta/unbind', { method: 'POST', body: '{}' });
export const setTaShareUsage = (on) => apiFetch('/api/ta/share-usage', { method: 'POST', body: JSON.stringify({ on: !!on }) });
export const setTaBatteryAlert = (on) => apiFetch('/api/ta/battery-alert', { method: 'POST', body: JSON.stringify({ on: !!on }) });

// Diaries
export const getTaUsage = () => apiFetch('/api/ta/usage');
export const getTaAlbum = (params = {}) => {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.beforeId) q.set('beforeId', String(params.beforeId));
  const qs = q.toString();
  return apiFetch(`/api/ta/album${qs ? `?${qs}` : ''}`);
};
export const getTaAlbumPhoto = (id) => apiFetch(`/api/ta/album/${id}`);
export async function uploadTaAlbumPhoto(file, meta = {}) {
  const fd = new FormData();
  if (file) fd.append('file', file);
  if (meta.url) fd.append('url', meta.url);
  if (meta.caption) fd.append('caption', meta.caption);
  if (meta.takenAt) fd.append('takenAt', meta.takenAt);
  if (meta.location) fd.append('location', meta.location);
  if (meta.lat != null) fd.append('lat', String(meta.lat));
  if (meta.lng != null) fd.append('lng', String(meta.lng));
  const resp = await fetch(resolveApiUrl('/api/ta/album'), {
    method: 'POST',
    body: fd,
    credentials: apiCredentials(),
    headers: apiHeaders(),
  });
  const data = await parseApiResponse(resp, '/api/ta/album');
  if (!resp.ok) throw new Error(data.error || '上传失败');
  return data;
}
export const updateTaAlbumPhoto = (id, data) => apiFetch(`/api/ta/album/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteTaAlbumPhoto = (id) => apiFetch(`/api/ta/album/${id}`, { method: 'DELETE' });
export const commentTaAlbumPhoto = (id, content) => apiFetch(`/api/ta/album/${id}/comments`, { method: 'POST', body: JSON.stringify({ content }) });
export const getTaStudioAlbum = (params = {}) => {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.beforeId) q.set('beforeId', String(params.beforeId));
  const qs = q.toString();
  return apiFetch(`/api/ta/studio-album${qs ? `?${qs}` : ''}`);
};
export const deleteTaStudioPhoto = (id) => apiFetch(`/api/ta/studio-album/${id}`, { method: 'DELETE' });

export const getPhotostudioMeta = () => apiFetch('/api/photostudio/meta');
export const listPhotostudioSessions = (limit) =>
  apiFetch(`/api/photostudio/sessions${limit ? `?limit=${limit}` : ''}`);
export const createPhotostudioSession = (characterIds) =>
  apiFetch('/api/photostudio/sessions', { method: 'POST', body: JSON.stringify({ characterIds }) });
export const getPhotostudioSession = (id) => apiFetch(`/api/photostudio/sessions/${id}`);
export const patchPhotostudioSession = (id, data) =>
  apiFetch(`/api/photostudio/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const listPhotostudioJobs = (sessionId) => apiFetch(`/api/photostudio/sessions/${sessionId}/jobs`);
export const getPhotostudioJob = (id) => apiFetch(`/api/photostudio/jobs/${id}`);
export const queuePhotostudioTryon = (sessionId, data) =>
  apiFetch(`/api/photostudio/sessions/${sessionId}/tryon`, {
    method: 'POST',
    body: JSON.stringify(data),
    timeoutMs: 60 * 1000,
  });
export const confirmPhotostudioLook = (sessionId, data) =>
  apiFetch(`/api/photostudio/sessions/${sessionId}/confirm-look`, { method: 'POST', body: JSON.stringify(data) });
export const queuePhotostudioShoot = (sessionId, data = {}) =>
  apiFetch(`/api/photostudio/sessions/${sessionId}/shoot`, {
    method: 'POST',
    body: JSON.stringify(data),
    timeoutMs: 60 * 1000,
  });

export const getTaLetters = () => apiFetch('/api/ta/letters');
export const postTaLetter = (data) => apiFetch('/api/ta/letters', { method: 'POST', body: JSON.stringify(data) });
export const getPostOfficeMeta = () => apiFetch('/api/post-office/meta');
export const getPostOfficeParcels = (characterId) => {
  const q = characterId ? `?characterId=${encodeURIComponent(characterId)}` : '';
  return apiFetch(`/api/post-office/parcels${q}`);
};
export const getPostOfficeParcel = (id) => apiFetch(`/api/post-office/parcels/${id}`);
export const createPostOfficeParcel = (data) =>
  apiFetch('/api/post-office/parcels', { method: 'POST', body: JSON.stringify(data) });
export const readTaLetter = (id) => apiFetch(`/api/ta/letters/${id}/read`, { method: 'POST', body: '{}' });
export const readAllTaLetters = () => apiFetch('/api/ta/letters/read-all', { method: 'POST', body: '{}' });

export const getSharedMemos = () => apiFetch('/api/shared-memos');
export const createSharedMemo = (data) => apiFetch('/api/shared-memos', { method: 'POST', body: JSON.stringify(data) });
export const getSharedMemo = (bookId) => apiFetch(`/api/shared-memos/${bookId}`);
export const updateSharedMemo = (bookId, data) =>
  apiFetch(`/api/shared-memos/${bookId}`, { method: 'PUT', body: JSON.stringify(data) });
export const getSharedMemoEntries = (bookId, opts = {}) => {
  const q = new URLSearchParams();
  if (opts.since) q.set('since', String(opts.since).slice(0, 10));
  if (opts.date) q.set('date', String(opts.date).slice(0, 10));
  // 目录默认 lite；日页带 date 时后端会忽略 lite 返回完整
  if (opts.lite === false || opts.lite === 0) q.set('lite', '0');
  else if (!opts.date) q.set('lite', '1');
  const qs = q.toString();
  return apiFetch(`/api/shared-memos/${bookId}/entries${qs ? `?${qs}` : ''}`);
};
export const createSharedMemoEntry = (bookId, data) =>
  apiFetch(`/api/shared-memos/${bookId}/entries`, { method: 'POST', body: JSON.stringify(data) });
export const patchSharedMemoEntry = (bookId, entryId, data) =>
  apiFetch(`/api/shared-memos/${bookId}/entries/${entryId}`, { method: 'PATCH', body: JSON.stringify(data) });
export const aiWriteSharedMemo = (bookId, data = {}) =>
  apiFetch(`/api/shared-memos/${bookId}/ai-write`, { method: 'POST', body: JSON.stringify(data) });
export const deleteSharedMemoEntry = (bookId, entryId) =>
  apiFetch(`/api/shared-memos/${bookId}/entries/${entryId}`, { method: 'DELETE' });
export const deleteSharedMemoDay = (bookId, date) =>
  apiFetch(`/api/shared-memos/${bookId}/days/${encodeURIComponent(date)}`, { method: 'DELETE' });
export const deleteSharedMemo = (bookId) => apiFetch(`/api/shared-memos/${bookId}`, { method: 'DELETE' });

// Moments
export const getMoments = ({ limit = 30, offset = 0, characterId, sinceId, lite = true } = {}) => {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (characterId) q.set('characterId', String(characterId));
  if (sinceId) q.set('sinceId', String(sinceId));
  if (lite) q.set('lite', '1');
  return apiFetch(`/api/moments?${q}`);
};
export const getMomentsDelta = ({ sinceId = 0, ids = [], characterId, limit = 30 } = {}) => {
  const q = new URLSearchParams({ sinceId: String(sinceId || 0), limit: String(limit) });
  if (characterId) q.set('characterId', String(characterId));
  if (ids.length) q.set('ids', ids.filter(Boolean).join(','));
  return apiFetch(`/api/moments/delta?${q}`);
};
export const getMoment = (id) => apiFetch(`/api/moments/${id}`);
export const createMoment = (data) => apiFetch('/api/moments', { method: 'POST', body: JSON.stringify(data) });
export const likeMoment = (id, data) => apiFetch(`/api/moments/${id}/like`, { method: 'POST', body: JSON.stringify(data) });
export const unlikeMoment = (id, data) => apiFetch(`/api/moments/${id}/unlike`, { method: 'POST', body: JSON.stringify(data) });
export const commentMoment = (id, data) => apiFetch(`/api/moments/${id}/comment`, { method: 'POST', body: JSON.stringify(data) });
export const aiInteractMoment = (id) => apiFetch(`/api/moments/${id}/ai-interact`, { method: 'POST', body: JSON.stringify({}) });

// Games
export const playGame = (data) => apiFetch('/api/games/play', { method: 'POST', body: JSON.stringify(data) });
export const summarizeGameMemory = (data) => apiFetch('/api/games/memory', { method: 'POST', body: JSON.stringify(data) });
export const gameButler = (data) => apiFetch('/api/games/butler', { method: 'POST', body: JSON.stringify(data) });

// Web Push
export const getPushPublicKey = () => apiFetch('/api/push/vapid-public-key');
export const subscribePush = (subscription) => apiFetch('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) });
export const unsubscribePush = (data) => apiFetch('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify(data) });
export const getPushStatus = () => apiFetch('/api/push/status');
export const testPush = (data = {}) => apiFetch('/api/push/test', { method: 'POST', body: JSON.stringify(data) });

// Worldbook
export const getWorldbook = () => apiFetch('/api/worldbook');
export const createWorldEntry = (data) => apiFetch('/api/worldbook', { method: 'POST', body: JSON.stringify(data) });
export const updateWorldEntry = (id, data) => apiFetch(`/api/worldbook/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteWorldEntry = (id) => apiFetch(`/api/worldbook/${id}`, { method: 'DELETE' });
export const exportWorldbook = () => apiFetch('/api/worldbook/export');
export const importWorldbook = (data) => apiFetch('/api/worldbook/import', { method: 'POST', body: JSON.stringify(data) });

// Series (剧集长篇；长文生成给足超时)
const SERIES_LONG_MS = 420000;
export const getSeriesMeta = () => apiFetch('/api/series/meta');
export const listSeries = (characterId, mode) => {
  const q = new URLSearchParams();
  if (characterId) q.set('characterId', characterId);
  if (mode) q.set('mode', mode);
  const s = q.toString();
  return apiFetch(`/api/series${s ? `?${s}` : ''}`);
};
export const getSeriesBook = (bookId) => apiFetch(`/api/series/${bookId}`);
export const createSeriesBook = (data) => apiFetch('/api/series', { method: 'POST', body: JSON.stringify(data) });
export const updateSeriesBook = (bookId, data) => apiFetch(`/api/series/${bookId}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteSeriesBook = (bookId) => apiFetch(`/api/series/${bookId}`, { method: 'DELETE' });
export const seriesBlindRoles = (bookId) => apiFetch(`/api/series/${bookId}/blind-roles`, { method: 'POST', body: '{}', timeoutMs: SERIES_LONG_MS });
export const seriesGenerateOutline = (bookId, data = {}) => apiFetch(`/api/series/${bookId}/outline`, { method: 'POST', body: JSON.stringify({ async: true, ...data }), timeoutMs: SERIES_LONG_MS });
export const getSeriesChapter = (bookId, no) => apiFetch(`/api/series/${bookId}/chapters/${no}`);
export const updateSeriesChapter = (bookId, no, data) => apiFetch(`/api/series/${bookId}/chapters/${no}`, { method: 'PATCH', body: JSON.stringify(data) });
export const seriesGenerateChapter = (bookId, no, data = {}) => apiFetch(`/api/series/${bookId}/chapters/${no}/generate`, { method: 'POST', body: JSON.stringify({ async: true, ...data }), timeoutMs: SERIES_LONG_MS });
export const seriesDirectorRewrite = (bookId, no, feedback) => apiFetch(`/api/series/${bookId}/chapters/${no}/director`, { method: 'POST', body: JSON.stringify({ feedback, async: true }), timeoutMs: SERIES_LONG_MS });
export const getSeriesJobs = (bookId) => apiFetch(`/api/series/${bookId}/jobs`);
export const getSeriesJob = (jobId) => apiFetch(`/api/series/jobs/${jobId}`);
// 穿越
export const isekaiGenerateOutline = (bookId, data = {}) => apiFetch(`/api/series/${bookId}/isekai/outline`, { method: 'POST', body: JSON.stringify({ async: true, ...data }), timeoutMs: SERIES_LONG_MS });
export const getScreenwriterQuestions = (bookId) => apiFetch(`/api/series/${bookId}/screenwriter/questions`);
export const submitScreenwriter = (bookId, data) =>
  apiFetch(`/api/series/${bookId}/screenwriter/submit`, { method: 'POST', body: JSON.stringify(data), timeoutMs: SERIES_LONG_MS });
export const skipScreenwriter = (bookId) =>
  apiFetch(`/api/series/${bookId}/screenwriter/skip`, { method: 'POST', body: '{}' });
export const isekaiSetStorySource = (bookId, data = {}) => apiFetch(`/api/series/${bookId}/isekai/source`, { method: 'POST', body: JSON.stringify(data) });
export const isekaiListStories = (data = {}) => apiFetch('/api/series/isekai/list-stories', { method: 'POST', body: JSON.stringify(data), timeoutMs: SERIES_LONG_MS });
export async function isekaiUploadNovel(bookId, file, title = '') {
  const fd = new FormData();
  fd.append('file', file);
  if (title) fd.append('title', title);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERIES_LONG_MS);
  try {
    const resp = await fetch(resolveApiUrl(`/api/series/${bookId}/isekai/source/upload`), {
      method: 'POST',
      body: fd,
      credentials: apiCredentials(),
      headers: apiHeaders(),
      signal: controller.signal,
    });
    const data = await parseApiResponse(resp, '/api/series/isekai/source/upload');
    if (!resp.ok) throw new Error(data.error || '上传失败');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('上传超时，请换更小的 txt 或稍后重试');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
export const isekaiBegin = (bookId, data = {}) => apiFetch(`/api/series/${bookId}/isekai/begin`, { method: 'POST', body: JSON.stringify({ async: true, ...data }), timeoutMs: SERIES_LONG_MS });
export const isekaiGetChapter = (bookId, no) => apiFetch(`/api/series/${bookId}/isekai/chapters/${no}`);
export const isekaiStartChapter = (bookId, no, data = {}) => apiFetch(`/api/series/${bookId}/isekai/chapters/${no}/start`, { method: 'POST', body: JSON.stringify({ async: true, ...data }), timeoutMs: SERIES_LONG_MS });
export const isekaiTurn = (bookId, no, data = {}) => apiFetch(`/api/series/${bookId}/isekai/chapters/${no}/turn`, { method: 'POST', body: JSON.stringify({ async: true, ...data }), timeoutMs: 60000 });
export const isekaiRegenerateTurn = (bookId, no, turnId) => apiFetch(`/api/series/${bookId}/isekai/chapters/${no}/turns/${turnId}/regenerate`, { method: 'POST', body: '{}', timeoutMs: SERIES_LONG_MS });
export const isekaiFinishChapter = (bookId, no) => apiFetch(`/api/series/${bookId}/isekai/chapters/${no}/finish`, { method: 'POST', body: '{}', timeoutMs: SERIES_LONG_MS });

export const whatifGetPlay = (bookId) => apiFetch(`/api/series/${bookId}/whatif/play`);
export const whatifStart = (bookId, data = {}) => apiFetch(`/api/series/${bookId}/whatif/start`, { method: 'POST', body: JSON.stringify(data || {}), timeoutMs: SERIES_LONG_MS });
export const whatifTurn = (bookId, data) => apiFetch(`/api/series/${bookId}/whatif/turn`, { method: 'POST', body: JSON.stringify(data), timeoutMs: SERIES_LONG_MS });
export const illusionGenerate = (bookId, data = {}) => apiFetch(`/api/series/${bookId}/illusion/generate`, { method: 'POST', body: JSON.stringify({ async: true, ...data }), timeoutMs: SERIES_LONG_MS });

// Impressions (角色印象备忘)
export const getImpressions = (charId) => apiFetch(`/api/impressions/${charId}`);
export const createImpression = (data) => apiFetch('/api/impressions', { method: 'POST', body: JSON.stringify(data) });
export const updateImpression = (id, data) => apiFetch(`/api/impressions/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteImpression = (id) => apiFetch(`/api/impressions/${id}`, { method: 'DELETE' });
export const mergeImpressions = (charId, items) => apiFetch(`/api/impressions/${charId}/merge`, { method: 'POST', body: JSON.stringify({ items }) });

export const getCharTraits = (charId) => apiFetch(`/api/characters/${charId}/traits`);
export const saveCharTraits = (charId, traits) => apiFetch(`/api/characters/${charId}/traits`, { method: 'PUT', body: JSON.stringify({ traits }) });

// Presets
export const getPresets = () => apiFetch('/api/presets');
export const createPreset = (data) => apiFetch('/api/presets', { method: 'POST', body: JSON.stringify(data) });
export const updatePreset = (id, data) => apiFetch(`/api/presets/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deletePreset = (id) => apiFetch(`/api/presets/${id}`, { method: 'DELETE' });

// Emoji
export const getEmojiCategories = () => apiFetch('/api/emoji/categories');
export const createEmojiCategory = (name) => apiFetch('/api/emoji/categories', { method: 'POST', body: JSON.stringify({ name }) });
export const deleteEmojiCategory = (id) => apiFetch(`/api/emoji/categories/${id}`, { method: 'DELETE' });
export const createEmoji = (data) => apiFetch('/api/emoji', { method: 'POST', body: JSON.stringify(data) });
export const updateEmoji = (id, description) => apiFetch(`/api/emoji/${id}`, { method: 'PUT', body: JSON.stringify({ description }) });
export const deleteEmoji = (id) => apiFetch(`/api/emoji/${id}`, { method: 'DELETE' });
export async function replaceEmojiFile(id, file) {
  const fd = new FormData();
  fd.append('file', file);
  const resp = await fetch(resolveApiUrl(`/api/emoji/${id}/replace`), {
    method: 'POST', body: fd, credentials: apiCredentials(), headers: apiHeaders(),
  });
  const data = await parseApiResponse(resp, `/api/emoji/${id}/replace`);
  if (!resp.ok) throw new Error(data.error || '替换失败');
  return data;
}

// 角色相册
export const getAlbumItems = (charId, type, subject) => {
  const qs = new URLSearchParams();
  if (type) qs.set('type', type);
  if (subject && subject !== 'all') qs.set('subject', subject);
  const q = qs.toString();
  return apiFetch(`/api/album/${charId}${q ? `?${q}` : ''}`);
};
export async function uploadAlbumFile(file, mediaType) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('mediaType', mediaType);
  const resp = await fetch(resolveApiUrl('/api/album/upload'), {
    method: 'POST', body: fd, credentials: apiCredentials(), headers: apiHeaders(),
  });
  const data = await parseApiResponse(resp, '/api/album/upload');
  if (!resp.ok) throw new Error(data.error || '上传失败');
  return data;
}
export const createAlbumItem = (data) => apiFetch('/api/album', { method: 'POST', body: JSON.stringify(data) });
export const updateAlbumItem = (id, data) => apiFetch(`/api/album/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteAlbumItem = (id) => apiFetch(`/api/album/${id}`, { method: 'DELETE' });
export async function downloadAlbumBlob(id) {
  const path = `/api/album/item/${id}/download`;
  const resp = await fetch(resolveApiUrl(path), {
    credentials: apiCredentials(),
    headers: apiHeaders(),
  });
  if (!resp.ok) {
    let msg = '下载失败';
    try {
      const data = await resp.json();
      if (data?.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const disp = resp.headers.get('content-disposition') || '';
  const star = disp.match(/filename\*=UTF-8''([^;]+)/i);
  const quoted = disp.match(/filename="?([^";]+)"?/i);
  let filename = '';
  try {
    filename = decodeURIComponent((star?.[1] || quoted?.[1] || '').trim());
  } catch {
    filename = (star?.[1] || quoted?.[1] || '').trim();
  }
  return { blob, filename: filename || `album-${id}` };
}

// Upload
export async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const resp = await fetch(resolveApiUrl('/api/upload'), {
    method: 'POST', body: fd, credentials: apiCredentials(), headers: apiHeaders(),
  });
  if (!resp.ok) throw new Error('上传失败');
  return resp.json();
}

/** 自定义字体库 */
export const getCustomFonts = () => apiFetch('/api/fonts');

export async function uploadCustomFont(file, name = '') {
  const fd = new FormData();
  fd.append('file', file);
  if (name) fd.append('name', name);
  const resp = await fetch(resolveApiUrl('/api/fonts/upload'), {
    method: 'POST', body: fd, credentials: apiCredentials(), headers: apiHeaders(),
  });
  const data = await parseApiResponse(resp, '/api/fonts/upload');
  if (!resp.ok) throw new Error(data.error || '字体上传失败');
  return data;
}

export async function renameCustomFont(id, name) {
  return apiFetch(`/api/fonts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export const deleteCustomFont = (id) =>
  apiFetch(`/api/fonts/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** 聊天用户语音条（服务端转 WAV/MP3，并可选声纹比对） */
export async function uploadChatVoice(file, durationSec = 1) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('duration', String(Math.max(1, Math.round(Number(durationSec) || 1))));
  const resp = await fetch(resolveApiUrl('/api/chat/voice-upload'), {
    method: 'POST', body: fd, credentials: apiCredentials(), headers: apiHeaders(),
  });
  const data = await parseApiResponse(resp, '/api/chat/voice-upload');
  if (!resp.ok) throw new Error(data.error || '语音上传失败');
  return data;
}

export const getVoiceprintStatus = () => apiFetch('/api/voiceprint/status');

/** 录入用户声纹（1～5 段说话录音） */
export async function enrollVoiceprint(files, { merge = true } = {}) {
  const list = Array.isArray(files) ? files : [files];
  const fd = new FormData();
  fd.append('merge', merge ? '1' : '0');
  for (const f of list) {
    if (f) fd.append('files', f);
  }
  const resp = await fetch(resolveApiUrl('/api/voiceprint/enroll'), {
    method: 'POST', body: fd, credentials: apiCredentials(), headers: apiHeaders(),
  });
  const data = await parseApiResponse(resp, '/api/voiceprint/enroll');
  if (!resp.ok) throw new Error(data.error || '声纹录入失败');
  return data;
}

export async function clearVoiceprint() {
  return apiFetch('/api/voiceprint/clear', { method: 'POST', body: '{}' });
}

// 批量上传表情包文件（返回 filenames 数组）
export async function uploadEmojiFiles(categoryId, files) {
  const fd = new FormData();
  fd.append('categoryId', String(categoryId));
  for (const f of files) fd.append('files', f);
  const resp = await fetch(resolveApiUrl('/api/emoji/upload'), {
    method: 'POST', body: fd, credentials: apiCredentials(), headers: apiHeaders(),
  });
  if (!resp.ok) throw new Error('上传失败');
  return resp.json();
}

/** 导入 JSON 表情包（含 base64 时可自动建分类） */
export const exportEmojiCategory = (id) => apiFetch(`/api/emoji/categories/${id}/export`);
export const importEmojiJson = (data) => apiFetch('/api/emoji/import-json', { method: 'POST', body: JSON.stringify(data) });
export const getSharedList = (charId) => apiFetch(`/api/shared-list/${charId}`);
export const saveSharedList = (charId, items) => apiFetch(`/api/shared-list/${charId}`, {
  method: 'PUT',
  body: JSON.stringify({ items }),
});

/** 上传 .json 或 .zip 表情包包；categoryId 可选（不传则按包内 name 新建分类） */
export async function importEmojiPackFile(categoryId, file) {
  const fd = new FormData();
  if (categoryId != null) fd.append('categoryId', String(categoryId));
  fd.append('pack', file);
  const resp = await fetch(resolveApiUrl('/api/emoji/import-pack'), {
    method: 'POST', body: fd, credentials: apiCredentials(), headers: apiHeaders(),
  });
  let data = {};
  try { data = await resp.json(); } catch {}
  if (!resp.ok) {
    const err = new Error(data.error || `导入失败（HTTP ${resp.status}）`);
    err.details = data.errors;
    err.total = data.total;
    err.skipped = data.skipped;
    throw err;
  }
  return data;
}

// TTS（MiniMax，经后端 /api/tts；voice_id 只从角色数据库读取）
export async function fetchTTS(text, characterId, { emotion, tone, inCall } = {}) {
  if (!characterId) return { error: '缺少角色 ID' };
  let resp;
  try {
    resp = await fetch(resolveApiUrl('/api/tts'), {
      method: 'POST',
      credentials: apiCredentials(),
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        text,
        characterId,
        ...(emotion ? { emotion } : {}),
        ...(tone ? { tone } : {}),
        ...(inCall ? { inCall: true } : {}),
      }),
    });
  } catch (e) {
    return { error: e.message || '网络错误，请确认后端已启动' };
  }
  const ct = resp.headers.get('content-type') || '';
  if (resp.ok && ct.includes('audio')) {
    const blob = await resp.blob();
    if (!blob.size) return { error: '音频为空' };
    return { url: URL.createObjectURL(blob) };
  }
  try {
    const textBody = await resp.text();
    if (textBody.trim().startsWith('<') || ct.includes('text/html')) {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      return { error: `本地后端未连接。请运行 node server.js 并用 http://localhost:3000 打开（当前 ${origin || '未知'}）` };
    }
    const data = JSON.parse(textBody);
    return { error: data.error || '语音生成失败' };
  } catch {
    return { error: `语音生成失败（HTTP ${resp.status}）` };
  }
}

// Image generation
export const generateImage = (prompt) => apiFetch('/api/image/generate', { method: 'POST', body: JSON.stringify({ prompt }) });
export const testImageApi = () => apiFetch('/api/image/test', { method: 'POST', body: JSON.stringify({}) });
export const testSelfieImage = (imageRefOrRefs, opts = {}) => {
  const refs = Array.isArray(imageRefOrRefs)
    ? imageRefOrRefs
    : (imageRefOrRefs ? [imageRefOrRefs] : []);
  return apiFetch('/api/characters/test-selfie-image', {
    method: 'POST',
    body: JSON.stringify({
      imageRef: refs[0] || '',
      imageRefs: refs,
      imageRefGroups: opts.imageRefGroups || null,
      aspect: opts.aspect || opts.image_aspect || '',
      homeRefs: opts.homeRefs || [],
      homeEnvironment: opts.homeEnvironment || '',
      selfieStylePrompt: opts.selfieStylePrompt || '',
      imageStyle: opts.imageStyle || '',
      sceneQuery: opts.sceneQuery || '',
      provider: opts.provider || 'daily',
      nsfwNote: opts.nsfwNote || '',
      description: opts.description || '',
      intro: opts.intro || '',
    }),
    timeoutMs: 15 * 60 * 1000,
  });
};
export const testUnsplashApi = () => apiFetch('/api/unsplash/test', { method: 'POST', body: JSON.stringify({}) });
export const testPexelsApi = () => apiFetch('/api/pexels/test', { method: 'POST', body: JSON.stringify({}) });
export const testImg2VideoApi = (characterId) => apiFetch('/api/img2video/test', {
  method: 'POST',
  body: JSON.stringify(characterId ? { characterId } : {}),
  timeoutMs: 620000,
});
export const fetchImg2VideoModels = (url, key) => apiFetch('/api/img2video/models', {
  method: 'POST',
  body: JSON.stringify(url && key ? { url, key } : {}),
});

// Export/Import
export const exportData = (types) => apiFetch(`/api/export?types=${(types || ['all']).join(',')}`, { timeoutMs: 180000 });
export const importData = (data) => apiFetch('/api/import', { method: 'POST', body: JSON.stringify(data), timeoutMs: 180000 });
export const githubBackup = (payload) => apiFetch('/api/github/backup', {
  method: 'POST',
  body: JSON.stringify(payload && payload.app ? payload : {}),
  timeoutMs: 180000,
});
export const clearData = (type, characterId) => apiFetch('/api/clear', { method: 'POST', body: JSON.stringify({ type, characterId }) });

// 文本翻译（预设/提示词一键转英文）
export const translateText = (text, target = 'en') => apiFetch('/api/translate', { method: 'POST', body: JSON.stringify({ text, target }) });

// Schedules
export const getSchedule = ({ role = 'ai', charId, date } = {}) => {
  const q = new URLSearchParams({ role });
  if (charId != null) q.set('charId', String(charId));
  if (date) q.set('date', date);
  return apiFetch(`/api/schedules?${q}`);
};
export const saveSchedule = (data) => apiFetch('/api/schedules', { method: 'PUT', body: JSON.stringify(data) });
export const generateSchedule = (characterId, { date, force, scope = 'week' } = {}) =>
  apiFetch('/api/schedules/generate', { method: 'POST', body: JSON.stringify({ characterId, date, force, scope }) });
export const retrospectSchedule = (characterId, { date } = {}) =>
  apiFetch('/api/schedules/retrospect', { method: 'POST', body: JSON.stringify({ characterId, date }) });

// 日历日心情小黄豆
export const getDayMoods = ({ year, month, characterId } = {}) => {
  const q = new URLSearchParams({ year: String(year), month: String(month) });
  if (characterId) q.set('characterId', String(characterId));
  return apiFetch(`/api/day-moods?${q}`);
};

// 日历日信息：农历+节假日
export const getDayInfo = (date) =>
  apiFetch(`/api/day-info?date=${encodeURIComponent(date)}`);

// 日历月信息：批量农历+节假日
export const getMonthInfo = (year, month) =>
  apiFetch(`/api/month-info?year=${year}&month=${month}`);
export const saveDayMood = (data) =>
  apiFetch('/api/day-moods', { method: 'PUT', body: JSON.stringify(data) });
export const deleteDayMood = (data) =>
  apiFetch('/api/day-moods', { method: 'DELETE', body: JSON.stringify(data) });

// 当天时间轴总结
export const getDayTimeline = (characterId, date) => {
  const q = new URLSearchParams({ characterId: String(characterId) });
  if (date) q.set('date', date);
  return apiFetch(`/api/timeline/day?${q}`);
};
export const refreshDayTimeline = (characterId, date, { force = true } = {}) =>
  apiFetch('/api/timeline/day', {
    method: 'POST',
    body: JSON.stringify({ characterId, date, force }),
  });

// 从任意 API 地址拉取模型列表
export const fetchModelsFrom = (url, key) => apiFetch('/api/models/fetch', { method: 'POST', body: JSON.stringify({ url, key }) });
export const checkApiBalance = (url, key) => apiFetch('/api/balance/check', { method: 'POST', body: JSON.stringify({ url, key }) });
export const fetchChatModels = () => apiFetch('/api/models');

// 群聊
export const getGroups = () => apiFetch('/api/groups');
export const getGroup = (id) => apiFetch(`/api/groups/${id}`);
export const createGroup = (data) => apiFetch('/api/groups', { method: 'POST', body: JSON.stringify(data) });
export const updateGroup = (id, data) => apiFetch(`/api/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteGroup = (id) => apiFetch(`/api/groups/${id}`, { method: 'DELETE' });
export const getGroupMessages = (id, { limit = 80, beforeId } = {}) => {
  const q = new URLSearchParams({ limit: String(limit) });
  if (beforeId) q.set('beforeId', String(beforeId));
  return apiFetch(`/api/groups/${id}/messages?${q}`);
};
export const sendGroupMessage = (id, data) =>
  apiFetch(`/api/groups/${id}/messages`, { method: 'POST', body: JSON.stringify(data) });
export const triggerGroupAi = (id, data = {}) =>
  apiFetch(`/api/groups/${id}/trigger`, { method: 'POST', body: JSON.stringify(data) });
export const markGroupRead = (id) =>
  apiFetch(`/api/groups/${id}/read`, { method: 'POST', body: '{}' });
export const getGroupUnreadSummary = () =>
  apiFetch('/api/groups/unread-summary', { timeoutMs: 12000 });

// Wardrobe / Appearance
export const getWardrobe = (charId) => apiFetch(`/api/characters/${charId}/wardrobe`);
export const purchaseWardrobe = (charId, categories) =>
  apiFetch(`/api/characters/${charId}/wardrobe/purchase`, { method: 'POST', body: JSON.stringify({ categories }) });
export const addWardrobeItem = (charId, item) =>
  apiFetch(`/api/characters/${charId}/wardrobe/items`, { method: 'POST', body: JSON.stringify(item) });
export const updateWardrobeItem = (charId, itemId, item) =>
  apiFetch(`/api/characters/${charId}/wardrobe/items/${itemId}`, { method: 'PUT', body: JSON.stringify(item) });
export const deleteWardrobeItem = (charId, itemId) =>
  apiFetch(`/api/characters/${charId}/wardrobe/items/${itemId}`, { method: 'DELETE' });
export const getTodayOutfits = (charId, date) => {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  return apiFetch(`/api/characters/${charId}/outfits/today${q}`);
};
export const saveTodayOutfit = (charId, slot, outfit, date) =>
  apiFetch(`/api/characters/${charId}/outfits/today/${slot}`, { method: 'PUT', body: JSON.stringify({ outfit, date }) });
export const generateTodayOutfits = (charId, { date, force } = {}) =>
  apiFetch(`/api/characters/${charId}/outfits/generate-today`, { method: 'POST', body: JSON.stringify({ date, force }) });
export const getOutfitRecommendations = (charId) =>
  apiFetch(`/api/characters/${charId}/outfits/recommend`);
export const getAppearance = (charId) => apiFetch(`/api/characters/${charId}/appearance`);
export const saveAppearance = (charId, data) =>
  apiFetch(`/api/characters/${charId}/appearance`, { method: 'PUT', body: JSON.stringify(data) });

// Home monitor
export const getMonitor = (charId, room) => {
  const q = room ? `?room=${encodeURIComponent(room)}` : '';
  return apiFetch(`/api/characters/${charId}/monitor${q}`);
};
export const saveMonitorDescription = (charId, description) =>
  apiFetch(`/api/characters/${charId}/monitor/description`, {
    method: 'PUT',
    body: JSON.stringify({ description }),
  });
export const saveMonitorRoomScene = (charId, room, text) =>
  apiFetch(`/api/characters/${charId}/monitor/room-scene`, {
    method: 'PUT',
    body: JSON.stringify({ room, text }),
  });
export const clearMonitorRoomScene = (charId, room) =>
  apiFetch(`/api/characters/${charId}/monitor/room-scene`, {
    method: 'DELETE',
    body: JSON.stringify({ room }),
  });
export const clearMonitorDescription = (charId) =>
  apiFetch(`/api/characters/${charId}/monitor/description`, { method: 'DELETE' });
export const captureMonitor = (charId, mode = 'image', room) =>
  apiFetch(`/api/characters/${charId}/monitor/capture`, {
    method: 'POST',
    body: JSON.stringify({ mode, room }),
    timeoutMs: 15 * 60 * 1000,
  });

/* 用聊天 API 把简短居住环境扩成详细英文提示词 */
export const expandHomeEnvironment = (charId, raw) =>
  apiFetch(`/api/characters/${charId}/home-environment/expand`, {
    method: 'POST',
    body: JSON.stringify({ raw }),
    timeoutMs: 90 * 1000,
  });

// ===== 虚拟贴吧 =====
const TIEBA_TOKEN_KEY = 'nian_tieba_token';
const TIEBA_ACCOUNT_KEY = 'nian_tieba_account';

export function getTiebaToken() {
  try { return localStorage.getItem(TIEBA_TOKEN_KEY) || ''; } catch { return ''; }
}

export function setTiebaToken(token) {
  try {
    if (token) localStorage.setItem(TIEBA_TOKEN_KEY, token);
    else localStorage.removeItem(TIEBA_TOKEN_KEY);
  } catch {}
}

export function getTiebaAccountCache() {
  try {
    const raw = localStorage.getItem(TIEBA_ACCOUNT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setTiebaAccountCache(account) {
  try {
    if (account) localStorage.setItem(TIEBA_ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(TIEBA_ACCOUNT_KEY);
  } catch {}
}

function tiebaHeaders() {
  const t = getTiebaToken();
  return t ? { 'X-Tieba-Token': t } : {};
}

function rememberTiebaSession(data) {
  if (data?.token) setTiebaToken(data.token);
  if (data?.account) setTiebaAccountCache(data.account);
  return data;
}

export const tiebaMe = () => apiFetch('/api/tieba/me', { headers: tiebaHeaders() });

export async function tiebaSetup(payload) {
  const data = await apiFetch('/api/tieba/setup', {
    method: 'POST',
    headers: tiebaHeaders(),
    body: JSON.stringify(payload || {}),
  });
  return rememberTiebaSession(data);
}

export async function tiebaUpdateMe(payload) {
  const data = await apiFetch('/api/tieba/me', {
    method: 'PATCH',
    headers: tiebaHeaders(),
    body: JSON.stringify(payload || {}),
  });
  if (data?.account) setTiebaAccountCache(data.account);
  return data;
}

export async function tiebaRegister(username, password, extra = {}) {
  const data = await apiFetch('/api/tieba/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, ...extra }),
  });
  return rememberTiebaSession(data);
}

export async function tiebaLogin(username, password) {
  const data = await apiFetch('/api/tieba/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  return rememberTiebaSession(data);
}

export async function tiebaLogout() {
  try {
    await apiFetch('/api/tieba/logout', { method: 'POST', headers: tiebaHeaders(), body: '{}' });
  } finally {
    setTiebaToken('');
    setTiebaAccountCache(null);
  }
}

export const tiebaListBars = (q = '') =>
  apiFetch(`/api/tieba/bars${q ? `?q=${encodeURIComponent(q)}` : ''}`, { headers: tiebaHeaders() });

export const tiebaGetBar = (id) =>
  apiFetch(`/api/tieba/bars/${id}`, { headers: tiebaHeaders() });

export const tiebaCreateBar = (data) =>
  apiFetch('/api/tieba/bars', {
    method: 'POST',
    headers: tiebaHeaders(),
    body: JSON.stringify(data || {}),
  });

export const tiebaListThreads = (barId, { limit = 30, offset = 0 } = {}) =>
  apiFetch(`/api/tieba/bars/${barId}/threads?limit=${limit}&offset=${offset}`, { headers: tiebaHeaders() });

export const tiebaCreateThread = (barId, data) =>
  apiFetch(`/api/tieba/bars/${barId}/threads`, {
    method: 'POST',
    headers: tiebaHeaders(),
    body: JSON.stringify(data || {}),
  });

export const tiebaGetThread = (id, { limit = 50, offset = 0 } = {}) =>
  apiFetch(`/api/tieba/threads/${id}?limit=${limit}&offset=${offset}`, { headers: tiebaHeaders() });

export const tiebaReply = (threadId, content) =>
  apiFetch(`/api/tieba/threads/${threadId}/replies`, {
    method: 'POST',
    headers: tiebaHeaders(),
    body: JSON.stringify({ content }),
  });

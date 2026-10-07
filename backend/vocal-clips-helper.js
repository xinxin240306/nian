/**
 * 角色拟声库：用户上传的呼吸/喘息/哼唧等短音频。
 * AI 写「拟声：类型」→ 抽一条 → 语音气泡或听筒里串播。
 * 拟声是这张嘴的口声，不进 MiniMax，也不走环境音效。
 */

const VOCAL_CLIP_MAX = 36;

const VOCAL_KIND_GROUPS = [
  { id: 'daily', label: '日常' },
  { id: 'intimate', label: '亲密' },
  { id: 'other', label: '其他' },
];

const VOCAL_KINDS = [
  { id: 'breath', label: '呼吸', group: 'daily', scene: '安静、刚醒、贴得很近时的气息' },
  { id: 'pant', label: '喘息', group: 'daily', scene: '跑步、爬楼、紧张，不是情欲' },
  { id: 'sigh', label: '叹气', group: 'daily', scene: '无奈、放松、日常叹气' },
  { id: 'laugh', label: '轻笑', group: 'daily', scene: '短笑、憋笑' },
  { id: 'moan', label: '轻吟', group: 'daily', scene: '累、舒服、非情欲的哼' },
  { id: 'hmm', label: '嗯哼', group: 'daily', scene: '应一声、想事情' },
  { id: 'gulp', label: '吞咽', group: 'daily', scene: '紧张咽口水' },
  { id: 'cough', label: '咳嗽', group: 'daily', scene: '清嗓、真咳' },
  { id: 'sob', label: '抽泣', group: 'daily', scene: '哭腔、哽住' },
  { id: 'kiss', label: '亲吻', group: 'daily', scene: '短吻声' },
  { id: 'nsfw_pant_soft', label: '前戏喘', group: 'intimate', scene: '亲吻爱抚、刚开始，慢、不急，气息只乱一点点' },
  { id: 'nsfw_pant', label: '急促喘', group: 'intimate', scene: '已经动起来、呼吸乱，还没到最狠' },
  { id: 'nsfw_pant_hard', label: '剧烈喘', group: 'intimate', scene: '快到了、用力、喘不过气' },
  { id: 'nsfw_hum', label: '哼唧', group: 'intimate', scene: '忍着、被逗、不敢出声，鼻音小哼' },
  { id: 'nsfw_moan', label: '娇吟', group: 'intimate', scene: '有声音的吟，不是纯喘气' },
  { id: 'nsfw_whimper', label: '呜咽', group: 'intimate', scene: '受不住、过载、带一点哭腔' },
  { id: 'nsfw_climax', label: '高潮', group: 'intimate', scene: '到了那一下，极少用' },
  { id: 'nsfw_afterglow', label: '余韵叹', group: 'intimate', scene: '高潮之后那口长气、缓过来。不要和高潮叫床用同一条' },
  { id: 'custom', label: '自定义', group: 'other', scene: '' },
];

const KIND_IDS = new Set(VOCAL_KINDS.map((k) => k.id));

const KIND_ALIASES = {
  色喘: 'nsfw_pant',
  急促喘: 'nsfw_pant',
  急喘: 'nsfw_pant',
  前戏喘: 'nsfw_pant_soft',
  慢喘: 'nsfw_pant_soft',
  轻喘: 'nsfw_pant_soft',
  软喘: 'nsfw_pant_soft',
  剧烈喘: 'nsfw_pant_hard',
  猛喘: 'nsfw_pant_hard',
  狠喘: 'nsfw_pant_hard',
  哼唧: 'nsfw_hum',
  娇吟: 'nsfw_moan',
  呜咽: 'nsfw_whimper',
  高潮: 'nsfw_climax',
  余韵: 'nsfw_afterglow',
  余韵叹: 'nsfw_afterglow',
  事后叹: 'nsfw_afterglow',
  呼吸: 'breath',
  喘息: 'pant',
  叹气: 'sigh',
  轻笑: 'laugh',
  轻吟: 'moan',
  嗯哼: 'hmm',
  吞咽: 'gulp',
  咳嗽: 'cough',
  抽泣: 'sob',
  亲吻: 'kiss',
  自定义: 'custom',
  foreplay: 'nsfw_pant_soft',
  softpant: 'nsfw_pant_soft',
  hardpant: 'nsfw_pant_hard',
  afterglow: 'nsfw_afterglow',
  climax: 'nsfw_climax',
};

const KIND_FALLBACKS = {
  nsfw_pant_soft: ['nsfw_pant_soft', 'nsfw_pant'],
  nsfw_pant: ['nsfw_pant', 'nsfw_pant_soft', 'nsfw_pant_hard'],
  nsfw_pant_hard: ['nsfw_pant_hard', 'nsfw_pant'],
  nsfw_hum: ['nsfw_hum', 'hmm', 'nsfw_whimper'],
  nsfw_moan: ['nsfw_moan', 'moan'],
  nsfw_whimper: ['nsfw_whimper', 'nsfw_hum', 'sob'],
  nsfw_afterglow: ['nsfw_afterglow', 'sigh'],
  nsfw_climax: ['nsfw_climax'],
  sigh: ['sigh', 'nsfw_afterglow'],
};

const COOLDOWN_MS = {
  nsfw_climax: 45000,
  nsfw_afterglow: 18000,
  nsfw_pant_hard: 10000,
  nsfw_pant: 8000,
  nsfw_pant_soft: 6000,
  nsfw_hum: 6000,
};

const vocalCooldownByChar = new Map();
const callBreathByChar = new Map();
const BREATH_BED_KINDS = new Set([
  'breath', 'nsfw_pant_soft', 'nsfw_pant', 'nsfw_pant_hard',
  'nsfw_hum', 'nsfw_moan', 'nsfw_whimper', 'nsfw_climax', 'nsfw_afterglow',
]);

const VOCAL_DIRECTIVE_RE = /(?:^|\n)\s*(?:拟声[：:]\s*|VOCAL:\s*|VOICECLIP:\s*)([^\n]+)/i;
const VOCAL_DIRECTIVE_STRIP_RE = /(?:^|\n)\s*(?:拟声[：:]\s*|VOCAL:\s*|VOICECLIP:\s*)[^\n]+/gi;

function clipUid() {
  return `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function kindLabel(kind) {
  return VOCAL_KINDS.find((k) => k.id === kind)?.label || '自定义';
}

function normalizeKind(raw) {
  const k = String(raw || '').trim().toLowerCase().replace(/[\s_\-]+/g, '');
  if (!k) return 'custom';
  if (KIND_IDS.has(String(raw || '').trim().toLowerCase())) {
    return String(raw).trim().toLowerCase();
  }
  const compact = String(raw || '').trim().toLowerCase();
  if (KIND_IDS.has(compact)) return compact;
  if (KIND_ALIASES[k]) return KIND_ALIASES[k];
  if (KIND_ALIASES[compact]) return KIND_ALIASES[compact];
  const byLabel = VOCAL_KINDS.find((item) => item.label === String(raw || '').trim());
  return byLabel ? byLabel.id : 'custom';
}

function parseVocalClips(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw || '[]'); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const url = String(item?.url || '').trim();
    if (!url) continue;
    const id = String(item?.id || clipUid()).slice(0, 40);
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = normalizeKind(item?.kind);
    let name = String(item?.name || item?.label || '').trim().slice(0, 24);
    if (name === '色喘' && kind === 'nsfw_pant') name = '急促喘';
    const duration = Math.max(0, Math.min(120, Number(item?.duration) || 0));
    // 缺省开启；显式 0/false/'0' 才关闭
    const enabled = !(item?.enabled === 0 || item?.enabled === false || item?.enabled === '0');
    out.push({
      id,
      url,
      kind,
      name: name || kindLabel(kind),
      duration,
      enabled: enabled ? 1 : 0,
    });
    if (out.length >= VOCAL_CLIP_MAX) break;
  }
  return out;
}

function vocalClipsToJson(clips) {
  return JSON.stringify(parseVocalClips(clips));
}

function clipsByKind(charOrClips, kind) {
  const list = Array.isArray(charOrClips)
    ? parseVocalClips(charOrClips)
    : parseVocalClips(charOrClips?.vocal_clips);
  const k = normalizeKind(kind);
  return list.filter((c) => c.kind === k && c.enabled !== 0);
}

function pickVocalClip(charOrClips, kind) {
  const list = clipsByKind(charOrClips, kind);
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function pickVocalClipResolved(charOrClips, kind) {
  const wanted = normalizeKind(kind);
  const chain = KIND_FALLBACKS[wanted] || [wanted];
  for (const k of chain) {
    const clip = pickVocalClip(charOrClips, k);
    if (clip) return clip;
  }
  return null;
}

function summarizeVocalClips(charOrClips) {
  const list = Array.isArray(charOrClips)
    ? parseVocalClips(charOrClips)
    : parseVocalClips(charOrClips?.vocal_clips);
  const enabled = list.filter((c) => c.enabled !== 0);
  if (!enabled.length) return '';
  const counts = {};
  for (const c of enabled) counts[c.kind] = (counts[c.kind] || 0) + 1;
  return VOCAL_KINDS
    .filter((k) => counts[k.id])
    .map((k) => `${k.label}×${counts[k.id]}`)
    .join('、');
}

function availableVocalKinds(charOrClips) {
  const list = Array.isArray(charOrClips)
    ? parseVocalClips(charOrClips)
    : parseVocalClips(charOrClips?.vocal_clips);
  const have = new Set(list.filter((c) => c.enabled !== 0).map((c) => c.kind));
  return VOCAL_KINDS.filter((k) => have.has(k.id));
}

function normalizePlace(raw, kind) {
  const p = String(raw || '').trim().toLowerCase();
  if (/^(前|before|lead|先)$/i.test(p)) return 'before';
  if (/^(只|solo|整轮|仅)$/i.test(p)) return 'solo';
  if (/^(后|after|tail|再)$/i.test(p)) return 'after';
  if (kind === 'nsfw_afterglow' || kind === 'sigh') return 'after';
  if (kind === 'nsfw_climax') return 'solo';
  return 'after';
}

function extractVocalDirective(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const m = raw.match(VOCAL_DIRECTIVE_RE);
  if (!m) return null;
  let body = String(m[1] || '').trim();
  if (!body || /^(无|none|null|-)$/i.test(body)) return null;
  let placeRaw = '';
  const durOrPlace = body.match(/[|｜]\s*([^\n|｜]+)\s*$/);
  if (durOrPlace) {
    placeRaw = durOrPlace[1].trim();
    body = body.slice(0, durOrPlace.index).trim();
  }
  const kind = normalizeKind(body);
  if (kind === 'custom' && !KIND_IDS.has(String(body || '').trim().toLowerCase()) && !KIND_ALIASES[String(body || '').trim().toLowerCase().replace(/[\s_\-]+/g, '')]) {
    const hit = VOCAL_KINDS.find((k) => k.label === body);
    if (!hit) return null;
  }
  return { kind, place: normalizePlace(placeRaw, kind) };
}

function stripVocalDirective(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(VOCAL_DIRECTIVE_STRIP_RE, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function stripVocalOnomatopoeia(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/(?:^|\n)\s*[哈啊嗯唔呼嗬嘶]+(?:[.…。\s哈啊嗯唔呼嗬嘶—～~!！]*)+$/gm, '')
    .replace(/[（(]?(?:哈啊+|啊嗯+|嗯啊+|唔嗯+|呼—+|嗬+)[）)]?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function mapTextSegments(segments, fallbackText, mapper) {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length && fallbackText) {
    const cleaned = mapper(fallbackText);
    return cleaned ? [{ type: 'text', content: cleaned }] : [];
  }
  return list.map((seg) => {
    if (!seg || seg.type === 'emoji' || seg.type === 'image' || seg.type === 'video'
      || seg.type === 'voice' || seg.type === 'location' || seg.type === 'link' || seg.type === 'web_card') {
      return seg;
    }
    return { ...seg, content: mapper(seg.content) };
  }).filter((seg) => {
    if (!seg) return false;
    if (seg.type === 'emoji' || seg.type === 'image' || seg.type === 'video'
      || seg.type === 'voice' || seg.type === 'location' || seg.type === 'link' || seg.type === 'web_card') return true;
    return !!String(seg.content || '').trim();
  });
}

function stripVocalDirectivesFromSegments(segments, fallbackText = '') {
  return mapTextSegments(segments, fallbackText, stripVocalDirective);
}

function stripVocalOnomatopoeiaFromSegments(segments, fallbackText = '') {
  return mapTextSegments(segments, fallbackText, stripVocalOnomatopoeia);
}

function cooldownKey(characterId) {
  return Number(characterId);
}

function isVocalOnCooldown(characterId, kind) {
  const rec = vocalCooldownByChar.get(cooldownKey(characterId));
  if (!rec) return false;
  const wait = COOLDOWN_MS[kind] || 8000;
  if (rec.kind === kind && Date.now() - (rec.at || 0) < wait) return true;
  if (Date.now() - (rec.at || 0) < 3500) return true;
  return false;
}

function markVocalPlayed(characterId, kind) {
  vocalCooldownByChar.set(cooldownKey(characterId), { kind, at: Date.now() });
}

function resolveVocalPlay(char, rawText, cleanText) {
  const spec = extractVocalDirective(rawText) || extractVocalDirective(cleanText);
  if (!spec || !char) return null;
  const clip = pickVocalClipResolved(char, spec.kind);
  if (!clip) return null;
  if (isVocalOnCooldown(char.id, clip.kind)) return null;
  return { spec, clip };
}

function prepareVocalReply({ char, segments, rawText, fallbackText, skip } = {}) {
  const stripped = stripVocalDirectivesFromSegments(segments, rawText || fallbackText);
  // 拟声插入已停用：只剥指令，不再抽素材、不再进听筒/气泡
  void char;
  void skip;
  return { segments: stripped, play: null };
}

function encodeVocalVoiceContent({ url, duration, kind, forVoiceCall, breathBed, volume }) {
  return JSON.stringify({
    voice: true,
    vocal: true,
    breathBed: !!breathBed,
    kind: String(kind || ''),
    url: String(url || ''),
    duration: Math.max(1, Math.min(60, Math.round(Number(duration) || 1))),
    transcript: breathBed ? '' : (forVoiceCall ? '' : '……'),
    volume: Number.isFinite(Number(volume)) ? Number(volume) : undefined,
  });
}

function pickBreathBedClip(char) {
  return pickVocalClip(char, 'breath') || pickVocalClip(char, 'nsfw_pant_soft');
}

function getCallBreathBed(characterId) {
  const s = callBreathByChar.get(Number(characterId));
  if (!s) return null;
  if (Date.now() - (s.at || 0) > 6 * 3600 * 1000) {
    callBreathByChar.delete(Number(characterId));
    return null;
  }
  return s;
}

function rememberCallBreathBed(characterId, clip) {
  if (characterId == null || !clip?.url) return;
  callBreathByChar.set(Number(characterId), {
    url: String(clip.url),
    kind: clip.kind,
    volume: 0.24,
    at: Date.now(),
  });
}

function clearCallBreathBed(characterId) {
  if (characterId == null) return;
  callBreathByChar.delete(Number(characterId));
}

function makeBreathBedMessage({ characterId, char, deliveryStatus = 'sent', isDreamMode } = {}) {
  if (isDreamMode || characterId == null) return null;
  if (getCallBreathBed(characterId)) return null;
  const clip = pickBreathBedClip(char);
  if (!clip?.url) return null;
  const duration = Math.max(1, Math.min(60, Math.round(Number(clip.duration) || 2)));
  const content = encodeVocalVoiceContent({
    url: clip.url,
    duration,
    kind: clip.kind,
    forVoiceCall: true,
    breathBed: true,
    volume: 0.24,
  });
  const db = require('./db');
  const now = new Date().toISOString();
  const status = deliveryStatus || 'sent';
  let id;
  try {
    id = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read, delivery_status) VALUES (?,?,?,?,?,?,0,?)`
    ).run(characterId, 'assistant', content, 'voice', now, 0, status).lastInsertRowid;
  } catch {
    id = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,0)`
    ).run(characterId, 'assistant', content, 'voice', now, 0).lastInsertRowid;
    try { db.prepare(`UPDATE messages SET delivery_status=? WHERE id=?`).run(status, id); } catch {}
  }
  try {
    db.prepare(`UPDATE messages SET media_meta=? WHERE id=?`)
      .run(JSON.stringify({ hideChat: true, breathBed: true }), id);
  } catch {}
  rememberCallBreathBed(characterId, clip);
  return {
    id,
    role: 'assistant',
    type: 'voice',
    content,
    timestamp: now,
    voice_duration: duration,
    breathBed: true,
    media_meta: JSON.stringify({ hideChat: true, breathBed: true }),
  };
}

function saveVocalClipMessage({ characterId, clip, spec, isDreamMode, deliveryStatus = 'sent', forVoiceCall }) {
  if (isDreamMode || !clip?.url) return null;
  const now = new Date().toISOString();
  const status = deliveryStatus || 'sent';
  const duration = Math.max(1, Math.min(60, Math.round(Number(clip.duration) || 1)));
  const content = encodeVocalVoiceContent({
    url: clip.url,
    duration,
    kind: clip.kind,
    forVoiceCall,
  });
  const db = require('./db');
  let id;
  try {
    id = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read, delivery_status) VALUES (?,?,?,?,?,?,0,?)`
    ).run(characterId, 'assistant', content, 'voice', now, 0, status).lastInsertRowid;
  } catch {
    id = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,0)`
    ).run(characterId, 'assistant', content, 'voice', now, 0).lastInsertRowid;
    try { db.prepare(`UPDATE messages SET delivery_status=? WHERE id=?`).run(status, id); } catch {}
  }
  return {
    id,
    role: 'assistant',
    type: 'voice',
    content,
    timestamp: now,
    voice_duration: duration,
    place: spec?.place || 'after',
  };
}

function isSpeechLikeMessage(msg) {
  if (!msg || (msg.type !== 'text' && msg.type !== 'voice')) return false;
  const raw = String(msg.content || '').trim();
  if (!raw) return false;
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j?.sfx || j?.score || j?.vocal || j?.ambience || j?.breathBed || j?.texture) return false;
    } catch {}
  }
  return true;
}

function insertVocalMessages(aiMessages, vocalMsgs) {
  if (!Array.isArray(aiMessages) || !vocalMsgs?.length) return;
  for (const msg of vocalMsgs) {
    if (!msg) continue;
    if (msg.breathBed || msg.texture) {
      aiMessages.push(msg);
      continue;
    }
    const place = msg.place || 'after';
    if (place === 'before') {
      const idx = aiMessages.findIndex((m) => isSpeechLikeMessage(m));
      if (idx < 0) aiMessages.push(msg);
      else aiMessages.splice(idx, 0, msg);
    } else {
      let lastSpeech = -1;
      for (let i = 0; i < aiMessages.length; i++) {
        if (isSpeechLikeMessage(aiMessages[i])) lastSpeech = i;
      }
      if (lastSpeech < 0) aiMessages.push(msg);
      else aiMessages.splice(lastSpeech + 1, 0, msg);
    }
  }
}

function attachVocalClipMessages(opts = {}) {
  // 拟声插入已停用
  void opts;
  return [];
}

function buildVocalClipPromptSection(char, { forVoiceCall } = {}) {
  // 拟声能力已停用：不向模型注入任何相关说明，免得反过来教它写「拟声：」
  void char;
  void forVoiceCall;
  return '';
}

module.exports = {
  VOCAL_CLIP_MAX,
  VOCAL_KINDS,
  VOCAL_KIND_GROUPS,
  parseVocalClips,
  vocalClipsToJson,
  clipsByKind,
  pickVocalClip,
  pickVocalClipResolved,
  kindLabel,
  normalizeKind,
  summarizeVocalClips,
  availableVocalKinds,
  extractVocalDirective,
  stripVocalDirective,
  stripVocalDirectivesFromSegments,
  prepareVocalReply,
  attachVocalClipMessages,
  insertVocalMessages,
  buildVocalClipPromptSection,
  makeBreathBedMessage,
  getCallBreathBed,
  clearCallBreathBed,
};

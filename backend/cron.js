const cron = require('node-cron');
const dbModule = require('./db');
const db = dbModule;
const { callChatAPI, callChatAPIComplete, formatApiBillingError, fetchUnsplashImage, fetchUnsplashImageForMoment, generateChatContextImage, generateChatContextVideo, fetchPexelsVideoForMoment, generateMomentVideoViaAI, parseMomentContentAndImageQuery, replySuggestsContextImage, shouldAttachContextImage, shouldAttachContextVideo, normalizeMediaDirectiveLines, stripImageDirectiveFromSegments, resolveCharacterHomeEnvironment, extractSelfieSceneQuery, isObjectOrStillLifeScene, generateImage, buildSelfieGenerationPrompt, normalizeImageRefGroups, selectSelfieReferenceUrls, resolveSelfieRefFlags, selectHomeReferenceUrls, normalizeSelfieAspect, resolveImg2ImgConfig, toAbsoluteMediaUrl, getLastGenerateImageError, replyClaimsSentShareMedia, extractImageQueryFromText } = require('./api-helper');
const { push, notifyBillingError } = require('./push');
const { buildEmojiPromptSection, buildVoiceMessagePromptSection, buildLocationMessagePromptSection, buildLinkMessagePromptSection, buildWebCardPromptSection, buildRecallPromptSection, buildQuoteReplyPromptSection, buildPokePromptSection, buildCallDirectivePromptSection, buildTheaterInvitePromptSection, buildPostCallChatNote, userRequestsPhoneCall, processAiContentWithEmojis, saveAiReplySegments, formatMessageForAi, polishSpokenAiText, proseNearDuplicate } = require('./emoji-helper');
const { queueAlbumSave, stripAlbumMarkersFromSegments } = require('./album-helper');
const { buildInlineBeanPromptSection, sanitizeInlineBeans } = require('./inline-emoji-helper');
const { buildMusicScorePromptSection } = require('./music-score-helper');
const { isSoundFxConfigured, buildSoundFxPromptSection, buildCallSceneAudioPromptSection, attachSoundFxMessage, attachSoundFxMessages, stripSoundFxFromSegments } = require('./sound-fx-helper');
const { prepareVocalReply, attachVocalClipMessages, insertVocalMessages } = require('./vocal-clips-helper');
const robotOperatingHelper = require('./robot-operating-helper');
const emotionHelper = require('./emotion-helper');
const affectionHelper = require('./affection-helper');
const { lookupPublicHoliday } = require('./holiday-helper');

const BUSY_PATTERNS = [
  /我(要|得|先|需要)(去|回去)?(忙|做事|处理|睡觉|睡了|休息)/,
  /我(先|要)(去|忙).{0,6}(了|一会|一下|会儿)/,
  /我(有点|有些|有)事(情)?(要|需要|得)?(忙|处理|做)/,
  /我(先忙|去忙|忙一会|忙一下|忙会儿)/,
  /我(待会|等会)(儿)?(回来|找你|联系你)/,
];

function applyBusyStatusIfNeeded(char, text) {
  if (char.busy_style === 'off') return false;
  if (Number(char.robot_operating) === 1) return false;
  if (!BUSY_PATTERNS.some(p => p.test(text || ''))) return false;
  db.prepare(`UPDATE characters SET status='busy', busy_since=datetime('now') WHERE id=?`).run(char.id);
  push('status_change', { characterId: char.id, status: 'busy' });
  return true;
}

function clearCharacterOnline(charId) {
  db.prepare(`UPDATE characters SET status='online', busy_since=NULL WHERE id=?`).run(charId);
}
const { buildChatImagePromptSection, inferChatMediaNsfwContext } = require('./api-helper');
const { prefetchLocationWeather, buildLocationContextBlock, spokenCharLocation } = require('./location-weather-helper');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

/** 思考：心里两步用标记（用户看不见），正文只留开口 / 日记本笔 / 小剧场动作 */
function buildThinkAsSelfBlock(char, { forDiary = false, forTheater = false } = {}) {
  const mindset = String(char?.mindset || '').trim();
  const lens = mindset
    ? '看法只用【心智】，勿复述原文。'
    : '还没有心智时按【性格】【行为模式】想，不要分析怎么扮演。';
  let livingHint = '';
  if (!forDiary && !forTheater) {
    try { livingHint = require('./living-sense-helper').livingSenseThinkHint() || ''; } catch { /* ignore */ }
  }
  if (forTheater) {
    return `【心里话·草稿】只写下面两行标记（用户看不见），再写对白与（动作）：
[这一拍心思]…[/这一拍心思]
[动手]…[/动手]
[动手]里必须写清：接触部位（哪只手/嘴/身体哪一块）、具体怎么动（按/滑/扣/舔/咬/顶等）、力度与方向；想好本轮要给读者看的一处特写再落笔。手跟着感觉走（爱抚是常态，全身都可碰，不要连续多轮只盯下半身）。禁止把本段标题、说明写进回复。
${lens}`;
  }
  const after = forDiary
    ? '两行标记是心事底稿：日记正文要把它们展开写透，不是另起「今天干了啥再补一句感想」。禁止把本段标题、说明写进日记。'
    : `标记写完再开口。禁止把本段任何标题、说明、条目写进回复。
标记里的判断禁止改写或坦白进开口；这个人嘴上不会说的就别说。
${livingHint}`;
  return forDiary
    ? `【心里话·草稿】只写下面两行标记（不要抄本段说明），再写日记正文：
[怎么想]…[/怎么想]
[没说出口]…[/没说出口]
${after}
${lens}`
    : `【心里话·草稿】只写下面两行标记（不要抄本段说明），再另起开口：
[怎么看]…[/怎么看]
[什么感觉]…[/什么感觉]
${after}
${lens}`;
}

function buildSelfAddressNote(char) {
  const blob = [
    char?.language_style, char?.personality, char?.behavior, char?.intro, char?.description,
  ].map((x) => String(x || '')).join('\n');
  if (/(?:本(?:少爷|姑娘|宫|王|座|小姐|少|君)|在下|老夫|敝人)/.test(blob)) return '';
  return '第一人称用「我」。不要把职业/身份编成招牌自称（大艺术家、本画家、本xx 这类）；身份可以提到，但不能当口头禅自称。';
}

function buildCharacterProfile(char) {
  const parts = [];
  // 有心智时：心智主导；背景只作短摘要，不再把长篇经历当指令栏
  const mindset = String(char?.mindset || '').trim();
  if (mindset) {
    try {
      const archiveFmt = require('./char-archive-helper').formatMindsetForPrompt(char);
      if (archiveFmt) parts.push(archiveFmt);
    } catch {
      parts.push(`【心智】这是你消化过往之后形成的内在看法。只在心里用，禁止复述原文，禁止拆成消息发出去，不要点名栏目。\n${mindset.slice(0, 900)}`);
      if (char.personality) parts.push(`【性格】${char.personality}`);
      if (char.behavior) parts.push(`【行为模式】${char.behavior}`);
    }
    if (char.background) {
      parts.push(`【来历】${String(char.background).slice(0, 360)}`);
    }
  } else {
    // 来历在前：性格是从背景里长出来的，不是另开一栏去调用
    if (char.background) parts.push(`【背景】这是你这个人从哪来的，性格和处事都是从这里长出来的，不是一份要单独引用的档案。\n${char.background}`);
    if (char.personality) parts.push(`【性格】${char.personality}`);
    if (char.behavior) parts.push(`【行为模式】${char.behavior}`);
  }
  if (char.language_style) {
    const hasExamples = char.language_style.length > 50;
    const baseInstruction = hasExamples
      ? `【语言风格】下面是短对话样本（可含不同情绪），不是台词本。学软硬、句长、用词、标点，以及对话里会出现的修辞/意象（有就学，没有别硬造）。样本里已经有的口癖可以带一点，不要另给自己发明招牌自称或外号。情绪只换温度，不换这张嘴；每一句都必须按当前话题新写：禁止原样照抄、禁止改一两个字复述、禁止把示例拆开拼进回复。`
      : `【语言风格】说话方式必须像这个人：学软硬、句长、用词、标点。样本/人设里没有的口癖不要现编。情绪来了也还是这个人的说法。`;
    const emotionNote = hasExamples
    ? `\n**只学怎么接话，不要复读下面任何一句原句**：`
    : `\n**这是这个人真实的说话方式，情绪来了也要保持这个人的语言习惯**：`;
    const selfAddr = buildSelfAddressNote(char);
    parts.push(`${baseInstruction}${emotionNote}${selfAddr ? `\n${selfAddr}` : ''}\n${char.language_style}`);
  }
  if (parts.length) {
    return `这些你早就知道，是你自己。开口时先在心里过一遍，不要点名这些栏目，也不要像在完成人设。\n${parts.join('\n')}`;
  }
  return char.description || '';
}

// 用 Intl.DateTimeFormat.formatToParts 组装时间字符串，避免 toLocaleString 在精简 ICU 环境失效
function getTimeInZone(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
      hour12: false,
    }).formatToParts(date);
    const get = t => parts.find(p => p.type === t)?.value ?? '';
    return {
      str:  `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`,
      week: get('weekday'),
    };
  } catch(e) {
    // 终极兜底：手动 UTC+8 偏移（不依赖 ICU）
    const off = tz.startsWith('Asia/Shanghai') || tz.startsWith('Asia/Seoul') || tz.startsWith('Asia/Tokyo') ? 8 : 0;
    const local = new Date(date.getTime() + off * 3600000);
    const pad = n => String(n).padStart(2, '0');
    const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
    return {
      str:  `${local.getUTCFullYear()}/${pad(local.getUTCMonth()+1)}/${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      week: weekdays[local.getUTCDay()],
    };
  }
}

function parseMsgTimestamp(ts) {
  if (!ts) return new Date(NaN);
  if (ts.includes('T') || ts.includes('Z') || ts.includes('+')) return new Date(ts);
  return new Date(ts.replace(' ', 'T') + 'Z');
}

function isStaleLastTalk(msg, gapMs) {
  const gap = gapMs || require('./memory-brain-helper').SESSION_GAP_MS;
  if (!msg?.timestamp) return false;
  const t = parseMsgTimestamp(msg.timestamp).getTime();
  return Number.isFinite(t) && (Date.now() - t) >= gap;
}

function getLocalDateStr(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** 对话发生时刻的本地 HH:MM（枝干时间线用，不是入库时间） */
function getLocalHm(date, tz) {
  try {
    const d = date instanceof Date ? date : parseMsgTimestamp(date);
    if (!d || Number.isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
    const hh = get('hour');
    const mm = get('minute');
    return hh && mm ? `${hh}:${mm}` : '';
  } catch {
    return '';
  }
}

/** 把 YYYY-MM-DD 起算到「今天」（时区日历）写成「X年Y个月Z天」 */
function describeDurationSince(isoDate, now, tz = 'Asia/Shanghai') {
  const m = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const y0 = +m[1];
  const mo0 = +m[2];
  const d0 = +m[3];
  const today = getLocalDateStr(now || new Date(), tz);
  const tm = today.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!tm) return '';
  let y = +tm[1] - y0;
  let mo = +tm[2] - mo0;
  let d = +tm[3] - d0;
  if (d < 0) {
    mo -= 1;
    const prevMonth = new Date(Date.UTC(+tm[1], +tm[2] - 1, 0));
    d += prevMonth.getUTCDate();
  }
  if (mo < 0) {
    y -= 1;
    mo += 12;
  }
  if (y < 0) return '';
  const parts = [];
  if (y > 0) parts.push(`${y}年`);
  if (mo > 0) parts.push(`${mo}个月`);
  if (d > 0 || !parts.length) parts.push(`${d}天`);
  return parts.join('');
}

/**
 * 生日/纪念日：仅当对话提到相关话题时注入（类似世界书关键词），不常驻占 token
 */
const RELATIONSHIP_DATES_TRIGGER_RE = /在一起|相处|纪念日|周年|恋爱多久|认识多久|多久了|几天了|几个月|几年了|什么时候在一起|哪天在一起|交往|表白|告白|生日|寿星|几岁|多大了|出生/;

function buildRelationshipDatesBlock(char, settings, now = new Date(), contextText = '') {
  if (!char) return '';
  const ctx = String(contextText || '');
  if (!RELATIONSHIP_DATES_TRIGGER_RE.test(ctx)) return '';

  const tz = settings?.timezone || 'Asia/Shanghai';
  const uname = settings?.username || '旅人';
  const askTogether = /在一起|相处|纪念日|周年|恋爱多久|认识多久|多久了|几天了|几个月|几年了|什么时候在一起|哪天在一起|交往|表白|告白/.test(ctx);
  const askBirthday = /生日|寿星|几岁|多大了|出生/.test(ctx);

  const lines = [];
  const charBday = String(char.birthday || '').trim().slice(0, 10);
  const userBday = String(settings?.user_birthday || '').trim().slice(0, 10);
  const ann = String(char.anniversary || '').trim().slice(0, 10);

  if (askTogether && /^\d{4}-\d{2}-\d{2}$/.test(ann)) {
    const dur = describeDurationSince(ann, now, tz);
    lines.push(`你们在一起的纪念日（第一次正式在一起的日子）：${ann}`);
    if (dur) lines.push(`截至今天，在一起大约：${dur}（从纪念日算起）`);
    lines.push(`用户在问在一起多久/纪念日：按上面日期如实、自然回答，不要说不知道。`);
  } else if (askTogether && !ann) {
    lines.push(`角色卡未填写纪念日；若用户问在一起多久，可如实说你没记清具体日期，不要编造。`);
  }

  if (askBirthday) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(charBday)) lines.push(`你的生日：${charBday}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(userBday)) lines.push(`${uname}的生日：${userBday}`);
    if (lines.some(l => l.includes('生日'))) {
      lines.push(`用户在聊生日相关：可用上述日期，不要说不知道；未填写的那一方不要编造。`);
    }
  }

  if (!lines.length) return '';
  return `【特殊日期·本轮相关】\n${lines.join('\n')}`;
}

function shiftDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 短暂身体不适（头疼/难受等）——易被记进记忆后反复追问 */
const HEALTH_CONCERN_RE = /难受|不舒服|头疼|头痛|发烧|感冒|咳嗽|肚子疼|肚子痛|胃痛|恶心|头晕|乏力|嗓子疼|牙疼|牙痛|腰痛|背痛|生病|身体不适|黏黏糊糊|身上黏|香水.{0,8}难闻/;
const HEALTH_RECOVERY_RE = /不难受了|不疼了|不痛了|好多了|好很多|舒服多了|退烧了|不发烧了|不咳了|已经好了|好全了|痊愈|不难受|没事了/;

function isChronicHealthNote(text) {
  return /总是|经常|长期|习惯性|慢性|一直以来|每到|一到换季/.test(String(text || ''));
}

function isTransientHealthConcernText(text) {
  const s = String(text || '');
  if (!HEALTH_CONCERN_RE.test(s)) return false;
  if (isChronicHealthNote(s)) return false;
  // 正文已写明好转的不算「未了结」
  if (HEALTH_RECOVERY_RE.test(s) && /(好了|好多|不难受|不疼|没事|退烧|舒服)/.test(s)) return false;
  return true;
}

function isHealthRecoveryText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (HEALTH_RECOVERY_RE.test(s)) return true;
  // 「头/肚子/身体…好了 / 没事了」
  if (/(头|肚子|胃|嗓子|牙|腰|背|身体|感冒|烧|病).{0,8}(好了|好多了|没事了|不难受)/.test(s)) return true;
  // 短回复「好了」：仅当前后文像在说身体时，由调用方结合近期不适再判；这里放宽一点带「了」的短答
  if (/^(嗯+|哦+|啊+|额+)?[，,\s]*(已经)?(好了|没事了|不难受了)[啦啦啊呀哦呢~！。.…]*$/.test(s)) return true;
  return false;
}

/** 用户是否在「不适」之后又表示过好转（看最近用户消息） */
function findLatestUserHealthRecovery(charId) {
  if (!charId) return null;
  try {
    const rows = db.prepare(
      `SELECT id, content, timestamp FROM messages
       WHERE character_id=? AND role='user' AND is_dream=0 AND recalled=0
       ORDER BY id DESC LIMIT 80`
    ).all(charId);
    let sawConcernAfter = false;
    for (const row of rows) {
      const t = String(row.content || '');
      if (isHealthRecoveryText(t)) {
        // 若更近的消息又说难受，则这次好转作废，继续往下找
        if (sawConcernAfter) continue;
        return row;
      }
      if (isTransientHealthConcernText(t)) sawConcernAfter = true;
    }
  } catch {}
  return null;
}

/** 是否还有「好转之后又新提的不适」（应允许再关心） */
function hasFreshHealthConcernAfterRecovery(charId, recoveryMsg) {
  if (!charId || !recoveryMsg?.id) return false;
  try {
    const row = db.prepare(
      `SELECT id, content FROM messages
       WHERE character_id=? AND role='user' AND is_dream=0 AND recalled=0 AND id>?
       ORDER BY id DESC LIMIT 30`
    ).all(charId, recoveryMsg.id);
    return row.some(r => isTransientHealthConcernText(r.content));
  } catch {
    return false;
  }
}

function memoryLikelyBeforeRecovery(m, recoveryMsg, tz) {
  if (!m || !recoveryMsg) return true;
  try {
    const recDay = getLocalDateStr(parseMsgTimestamp(recoveryMsg.timestamp), tz);
    if (m.date && recDay && String(m.date) <= recDay) return true;
  } catch {}
  // 无日期时：偏旧的条目视为可被压制（按 id）
  return true;
}

/**
 * 压制已过时的短暂不适记忆/情景：用户说过好转后，勿再注入「还在难受」
 */
function filterSupersededHealthMemories(charId, memList, episodeGist = '') {
  const recovery = findLatestUserHealthRecovery(charId);
  if (!recovery || hasFreshHealthConcernAfterRecovery(charId, recovery)) {
    return { memList, episodeGist, healthResolved: false };
  }
  const tz = (getSettings().timezone || 'Asia/Shanghai');
  const filtered = (memList || []).filter((m) => {
    if (!m?.content) return false;
    if (!isTransientHealthConcernText(m.content)) return true;
    if (m.category === '偏好与习惯') return true;
    return !memoryLikelyBeforeRecovery(m, recovery, tz);
  });
  let gist = String(episodeGist || '');
  if (gist && isTransientHealthConcernText(gist) && !HEALTH_RECOVERY_RE.test(gist)) {
    // 情景里还写着难受：整段丢掉，避免主动消息又拿来追问
    gist = gist
      .split('\n')
      .filter((line) => !(isTransientHealthConcernText(line) && !HEALTH_RECOVERY_RE.test(line)))
      .join('\n');
  }
  return { memList: filtered, episodeGist: gist, healthResolved: true };
}

/** 从文本切出可用于匹配的短语（中文友好） */
function extractMemoryMatchTerms(text) {
  const terms = new Set();
  String(text || '')
    .split(/[，。！？、；：\s\n\r\t\/\|·…—\-~～「」『』（）()\[\]【】]{1,}/)
    .map(s => s.trim())
    .filter(s => s.length >= 2 && s.length <= 16)
    .forEach(s => terms.add(s));
  return terms;
}

/** 记忆内容是否与当前对话话题相关 */
function memoryMatchesContext(memory, contextText) {
  const ctx = String(contextText || '').trim();
  const content = String(memory?.content || '').trim();
  if (!ctx || !content) return false;

  const ctxTerms = extractMemoryMatchTerms(ctx);
  const memTerms = extractMemoryMatchTerms(content);
  for (const t of memTerms) {
    if (t.length >= 3 && ctx.includes(t)) return true;
    if (ctxTerms.has(t)) return true;
  }
  for (const t of ctxTerms) {
    if (t.length >= 3 && content.includes(t)) return true;
  }

  const cat = memory.category;
  if (cat === '约定' || cat === '待办') {
    if (/约定|承诺|答应|说好的|记得吗|别忘了|之前说|说过|提醒|待办|拍(一张|张|个)|发给我|看(一眼|下)/.test(ctx)) {
      for (const t of memTerms) {
        if (t.length >= 2 && ctx.includes(t)) return true;
      }
    }
    return false;
  }
  if (cat === '情感状态' && /心情|情绪|难过|开心|生气|焦虑|压力|烦|累|委屈/.test(ctx)) return true;
  return false;
}

/**
 * 选取注入提示词的记忆（大脑：过时不注入、事件边扩展、日程可跨天召回）
 */
function selectMemoriesForPrompt(char, contextText = '', opts = {}) {
  return require('./memory-brain-helper').selectMemoriesForBrain(char, contextText, opts);
}

function formatMemoriesForPrompt(char, contextText = '', opts = {}) {
  return require('./memory-brain-helper').formatMindFlashForPrompt(char, contextText, opts);
}

/** 聊天主路径：可选 API query embedding 精排后再格式化 */
async function formatMemoriesForPromptAsync(char, contextText = '', opts = {}) {
  return require('./memory-brain-helper').formatMindFlashForPromptAsync(char, contextText, opts);
}

function buildChatContextText(content, history = []) {
  const parts = [];
  for (const m of (history || []).slice(-24)) {
    if (m?.content) parts.push(String(m.content));
  }
  if (content) parts.push(String(content));
  return parts.join('\n');
}

const GOODNIGHT_RE = /晚安|好梦|睡了|睡觉啦|睡啦|去睡|早点休息|先睡|晚安啦|good\s*night/i;
const GOING_SLEEP_RE = /去睡|要睡|我先睡|准备睡|困.{0,3}了|撑不住|撑不|想睡|得睡了|该睡了|午觉|午睡|眯一会|眯一會兒|睡一会|睡一會兒/i;

/** 用户说过要去做某事：按「那条消息距现在多久」判断是否已过期（午觉/洗澡/吃饭等）
 * 注意：用户单条顺嘴提到「困/想睡/吃饭/洗澡」但上下文并不是去做这件事时，不应触发。
 * sleep 这里只匹配明确的「去/要/准备/得/该睡了」「撑不住/想睡了」「困了去睡」等强意图，
 * 不再匹配松散的「困了/想睡」——容易把「今天工作好困」「想睡个懒觉」这种感慨当成睡眠意图。
 */
const USER_STATED_INTENT_PATTERNS = [
  { re: /午觉|午睡|眯一会|眯一會兒|睡一会|睡一會兒|小睡|打个盹|打個盹/, kind: 'nap', minMin: 40, label: '午觉/小睡' },
  { re: /去睡了|要睡了|我先睡|准备睡|得睡了|该睡了|撑不住|想睡了|困.{0,3}了去睡|困了去睡|先去睡/, kind: 'sleep', minMin: 50, label: '睡觉' },
  { re: /去洗澡|去泡澡|要洗澡|要泡澡|我去洗澡|我去泡澡|冲个澡|冲澡|洗漱|泡澡|泡个澡/, kind: 'bath', minMin: 25, label: '洗澡/泡澡' },
  { re: /去吃饭|我要吃饭|我去吃饭|吃饭去|去吃午饭|去吃晚饭/, kind: 'meal', minMin: 30, label: '吃饭' },
  { re: /我出门|我要出门|我出去一趟|去上班|去开会|开会去|我去忙|先忙一会|忙一會兒|出去一下/, kind: 'away', minMin: 45, label: '出门/忙碌' },
];

function getLocalHour(settings) {
  const tz = settings?.timezone || 'Asia/Shanghai';
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
}

function getLocalTimeShort(settings) {
  const tz = settings?.timezone || 'Asia/Shanghai';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  } catch {
    const d = new Date();
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/** 角色级记忆总结间隔（角色设置优先，兼容旧全局） */
function getMemoryTriggerN(settings, char) {
  const fromChar = parseInt(char?.memory_trigger_n, 10);
  if (Number.isFinite(fromChar) && fromChar >= 5) return Math.max(5, Math.min(50, fromChar));
  const global = parseInt(settings?.memory_trigger_n, 10);
  if (Number.isFinite(global) && global >= 5) return Math.max(5, Math.min(50, global));
  return 12;
}

/** 角色是否开启时间感知（兼容尚未迁移的旧数据） */
function isTimeAware(char, settings) {
  const raw = char?.time_aware_enabled;
  if (raw !== undefined && raw !== null && raw !== '') {
    return raw === 1 || raw === '1' || raw === true;
  }
  return settings?.time_aware_enabled !== '0';
}

/** 角色是否开启真人聊天模式 */
function isNaturalChat(char, settings) {
  const raw = char?.natural_chat_mode;
  if (raw !== undefined && raw !== null && raw !== '') {
    return raw === 1 || raw === '1' || raw === true;
  }
  return settings?.natural_chat_mode === '1';
}

/** 把角色聊天偏好叠到 settings 视图，供仍读全局开关的辅助函数使用 */
function withCharChatPrefs(settings, char) {
  const base = settings && typeof settings === 'object' ? settings : {};
  const tz = resolveIanaTimezone(char?.timezone || base.timezone);
  return {
    ...base,
    time_aware_enabled: isTimeAware(char, base) ? '1' : '0',
    natural_chat_mode: isNaturalChat(char, base) ? '1' : '0',
    timezone: tz,
  };
}

function resolveIanaTimezone(tz) {
  const raw = String(tz || '').trim() || 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    return 'Asia/Shanghai';
  }
}

function getEffectiveTimezone(char, settings) {
  return resolveIanaTimezone(char?.timezone || settings?.timezone);
}

/** 用户回复间隔低于此值（分钟）视为正常聊天节奏，不注入「用户很久才回」提示 */
const USER_RETURN_GAP_NOTE_MIN = 30;
/** 重新生成回复时：用户上一条距现在超过此分钟数，注入短事实 */
const RETRY_TIME_ADVANCE_MIN = 20;
/** 空窗多久 + 短晚安，算「话少且空得久」的反常信号（只进心里状态，不写接法） */
const LONG_ABSENCE_GOODNIGHT_MIN = 60;

function formatConversationGap(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes}分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}天${rh}小时` : `${d}天`;
  }
  return m >= 5 ? `${h}小时${m}分钟` : `${h}小时`;
}

/** 本轮用户话是否像短晚安/要去睡（不是长文里顺嘴提困） */
function isShortGoodnightOrSleepLeave(text) {
  const raw = String(text || '').replace(/^【自动回复】/, '').trim();
  if (!raw) return false;
  const compact = raw.replace(/\s+/g, '');
  if (compact.length > 28) return false;
  if (/^(?:晚安|好梦|睡了|我睡了|去睡了|先睡了|晚安啦|早睡|去睡觉|我去睡了|我先睡了|困了去睡)[.。!！~～…]*$/i.test(compact)) {
    return true;
  }
  return (GOODNIGHT_RE.test(raw) || GOING_SLEEP_RE.test(raw)) && compact.length <= 16;
}

/** 空窗时长 → 只给时间尺度事实，不教怎么接 */
function buildAbsenceReactionGuide(minutes) {
  if (!Number.isFinite(minutes) || minutes < 60) return '';
  return `空窗约${formatConversationGap(minutes)}`;
}

/** 注入到用户消息前：空窗事实（不写接法剧本、不当作息闹钟） */
function buildChatTimeNote(settings, ctx = {}) {
  if (settings?.time_aware_enabled !== '1') return '';
  const minutes = ctx.minutesSinceCharReply;
  const charContent = String(ctx.charLastContent || '').replace(/^【自动回复】/, '').trim();
  const charSnippet = charContent.length > 72 ? `${charContent.slice(0, 72)}…` : charContent;
  const charHadLeavingIntent = /要去|待会|等会|一会|马上|先去|等下|回头|忙一会|睡|洗澡|吃饭|出门|上班|下班/.test(charContent);

  if (!Number.isFinite(minutes) || minutes < USER_RETURN_GAP_NOTE_MIN) {
    return '';
  }

  const gap = formatConversationGap(minutes);
  const lines = [
    `距你上一条消息已${gap}，对方此刻才回（按消息时间戳；是对方没回，不是你缺席）`,
  ];
  if (charSnippet) lines.push(`你上一条：「${charSnippet}」`);
  if (charHadLeavingIntent && minutes >= 15) {
    lines.push('你上一条说过自己要去做某事，且已隔够久——按你自己的时间，那事多半已过');
  }
  const absenceGuide = buildAbsenceReactionGuide(minutes);
  if (absenceGuide) lines.push(absenceGuide);
  return `[${lines.join('。')}]`;
}

/**
 * 睡眠合规类 SYS 已停用：近窗原文 + 墙钟事实足够，不替角色诊断「没睡着」。
 */
function buildSleepContextNote() {
  return '';
}

/**
 * 用户较早前说过要去做某事，且已隔够久：只塞短事实，不写接法/禁止句。
 */
function buildStatedIntentElapsedNote(history, settings) {
  if (!history?.length || settings?.time_aware_enabled !== '1') return '';
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user' && m.type !== 'system' && m.type !== 'image' && m.type !== 'video') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return '';
  const lastUser = history[lastUserIdx];
  const hasAiAfter = history.slice(lastUserIdx + 1).some(m => m.role === 'assistant');
  if (!hasAiAfter) return '';
  const text = String(lastUser.content || '').replace(/^【自动回复】/, '');
  if (!text) return '';

  let hit = null;
  for (const p of USER_STATED_INTENT_PATTERNS) {
    if (p.re.test(text)) { hit = p; break; }
  }
  if (!hit) return '';

  if (hit.kind === 'sleep' || hit.kind === 'nap') {
    const directIntent = /午觉|午睡|眯一会|眯一會兒|睡一会|睡一會兒|小睡|打个盹|打個盹|去睡了|要睡了|我先睡|准备睡|得睡了|该睡了|撑不住|想睡了|困.{0,3}了去睡|困了去睡|先去睡/.test(text);
    if (!directIntent) return '';
  }

  const ts = lastUser.timestamp ? parseMsgTimestamp(lastUser.timestamp).getTime() : NaN;
  if (!Number.isFinite(ts)) return '';
  const gapMin = Math.round((Date.now() - ts) / 60000);
  if (gapMin < hit.minMin || gapMin > 18 * 60) return '';

  const gap = formatConversationGap(gapMin);
  const snippet = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return `【时间事实】对方约${gap}前说过要${hit.label}（「${snippet}」）；按墙钟那段多半已过。`;
}

/**
 * 角色自己说过的短暂行动（泡澡/洗澡/吃饭等）状态闭环。
 * 解决：刚说「泡完了」，过两轮又说「泡完要上来了」。
 */
const CHAR_ACTIVITY_SPECS = [
  {
    kind: 'bath',
    label: '洗澡/泡澡',
    startRe: /(?:去|要|准备|正要|先去|我去)?(?:泡(?:个|会儿|一会)?澡|泡澡|洗澡|冲澡|淋浴)|在泡|泡着呢|泡澡呢|洗澡呢|泡澡中/,
    doneRe: /泡完了|洗完了|冲完了|泡好了|洗好了|澡洗完|已经出来|已经上来|擦完|擦干了|上来了|出来了|泡完要|洗完要|快上来|要上来了|快出来/,
    skipRe: /不(?:去)?(?:泡|洗)了|不泡了|不洗了|不去洗澡|不去泡澡|今天不泡|先不洗/,
    pendingRe: /要上来了|快上来|马上上来|快泡完|马上出来|再泡一会|还在泡|还没泡完|泡完要|洗完要上来/,
    minMin: 20,
    scheduleRe: /澡|浴|泡澡|淋浴|洗漱|泡汤/,
  },
  {
    kind: 'eat',
    label: '吃饭',
    startRe: /(?:去|要|正要|先去)?吃(?:饭|晚饭|午饭|午餐|早餐|早饭|宵夜)|在吃呢|吃饭去/,
    doneRe: /吃完了|吃好了|用完餐|吃过了/,
    skipRe: /不吃了|先不吃|不吃饭|不去吃饭/,
    pendingRe: /快吃完|马上吃完|还在吃|吃完就/,
    minMin: 25,
    scheduleRe: /吃|餐|饭|午饭|晚饭|早饭|宵夜|外卖|干饭/,
  },
  {
    kind: 'out',
    label: '出门办事',
    startRe: /(?:去|要|正要|先)?出门|出去一趟|我出去|去办点事|去买/,
    doneRe: /回来了|到家了|已经回|进门了/,
    skipRe: /不出去了|不出门了|不去了|先不出去/,
    pendingRe: /快到家|马上回|还在外面|马上到/,
    minMin: 35,
    scheduleRe: /出门|外出|外面|逛街|办事|采购|散步/,
  },
  {
    kind: 'cook',
    label: '做饭',
    startRe: /(?:去|要|正要|先)?(?:做饭|煮|炒|下厨|弄点吃的|热饭|做晚饭|做午饭)/,
    doneRe: /做好了|煮好了|炒好了|出锅了|饭好了/,
    skipRe: /不做了|不煮了|不下厨|先不做/,
    pendingRe: /还在做|快做好|马上好|还在炒|还在煮/,
    minMin: 30,
    scheduleRe: /做饭|下厨|煮|炒菜|晚餐|午饭/,
  },
  {
    kind: 'busy',
    label: '忙别的事',
    startRe: /(?:去|要|先)?忙一会|忙一下|处理一下|有点事|我先忙/,
    doneRe: /忙完了|弄完了|处理好了|弄好了/,
    skipRe: /不忙了|先不忙|不处理了/,
    pendingRe: /快忙完|马上忙完|还在忙/,
    minMin: 30,
    scheduleRe: /忙|工作|加班|处理|开会|上班/,
  },
  {
    kind: 'leisure_spot',
    label: '露台/阳台歇息',
    startRe: /(?:去|在|到)?(?:露台|阳台|天台|窗边).{0,10}(?:吹风|透气|坐|站|看看)|(?:去|在)?吹风|在吹风|吹风呢|透透气/,
    doneRe: /不吹了|不晒了|不站了|回去了|进来了|进屋|回屋|回房|下楼了|不透气了|吹完了|歇完了/,
    skipRe: /不去(?:露台|阳台|天台)|不去吹了|先不吹/,
    pendingRe: /还在吹|再吹一会|还在露台|还在阳台|还在天台/,
    minMin: 12,
    scheduleRe: /露台|阳台|天台|吹风|透气|晒太阳|窗边/,
  },
];

/** 聊天里表示离开/结束当前事（含「不吹了回去了」「做完了」这类） */
const SCHEDULE_CHAT_LEAVE_RE = /不(?:去)?[\u4e00-\u9fff]{0,6}了|回去了|回来了|进来了|进屋了?|回屋了?|回房了?|回房间|结束了|完事了|先回去|先进去|先回了|走了|撤了|溜了|不下了|不晒了|不站了|不吹了|不逛了/;
/** 「做完了 / 吹完了 / 弄完了」——比离开词更常见，旧正则经常漏掉 */
const SCHEDULE_CHAT_DONE_RE = /[\u4e00-\u9fff]{1,6}完了|做完了|弄完了|搞完了|办完了|忙完了|完事了|结束了/;

function textAnnouncesScheduleDone(text) {
  const t = String(text || '').replace(/^【自动回复】/, '');
  return SCHEDULE_CHAT_LEAVE_RE.test(t) || SCHEDULE_CHAT_DONE_RE.test(t);
}

function scheduleActivityTokens(activity) {
  const act = String(activity || '').trim();
  if (!act) return [];
  const raw = act.match(/[\u4e00-\u9fff]{2,8}/g) || [];
  const stop = new Set([
    '一下', '一会', '一会儿', '准备', '开始', '继续', '然后', '自己', '今天', '晚上',
    '中午', '早上', '时候', '时间', '进行', '处理', '一些', '一点',
  ]);
  const out = [];
  for (const t of raw) {
    if (stop.has(t)) continue;
    out.push(t);
    if (t.length >= 3) {
      out.push(t.slice(0, 2), t.slice(-2));
    }
  }
  return [...new Set(out.filter((x) => x.length >= 2))];
}

function textTouchesScheduleActivity(text, activity) {
  const t = String(text || '').replace(/^【自动回复】/, '');
  const act = String(activity || '').trim();
  if (!t || !act) return false;
  if (t.includes(act)) return true;
  const tokens = scheduleActivityTokens(act);
  for (const tok of tokens) {
    if (t.includes(tok)) return true;
    // 「吹风」↔「不吹了」：离开句里带活动核心字也算对上
    if (tok.length >= 2 && SCHEDULE_CHAT_LEAVE_RE.test(t)) {
      const core = tok[0];
      if (core && new RegExp(`不${core}[\\u4e00-\\u9fff]{0,2}了`).test(t)) return true;
    }
  }
  return false;
}

function recentAiMentionsScheduleActivity(charId, activity, limit = 12) {
  if (!charId || !activity) return false;
  const rows = db.prepare(
    `SELECT content FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='assistant'
     ORDER BY id DESC LIMIT ?`
  ).all(charId, limit);
  return rows.some((r) => textTouchesScheduleActivity(r.content, activity));
}

/**
 * 扫描近期 AI 发言，判断某行程项在对话里是进行中还是已离开。
 * @returns {'active'|'left'|null}
 */
function inferScheduleItemChatStatus(activity, aiMsgs) {
  if (!activity || !aiMsgs?.length) return null;
  let status = null;
  for (const m of aiMsgs) {
    const t = String(m.content || '').replace(/^【自动回复】/, '');
    if (!t) continue;
    const touches = textTouchesScheduleActivity(t, activity);
    const leaving = textAnnouncesScheduleDone(t);
    if (leaving && (touches || status === 'active')) {
      status = 'left';
      continue;
    }
    if (touches) {
      // 已离开后又说「要去/准备去」——仍以离开为准（防重开），除非明确新开一轮且间隔很大（此处先锁死离开）
      if (status === 'left' && /(?:要|准备|正要|再|又)去|去(?:露台|阳台|天台|吹风)/.test(t)) {
        continue;
      }
      if (status !== 'left') status = 'active';
    }
  }
  return status;
}

function buildCharActivityContinuityNote(history, char = null) {
  if (!history?.length) return '';
  const aiMsgs = history
    .filter(m => m.role === 'assistant' && m.type !== 'system' && m.type !== 'image' && m.type !== 'video')
    .slice(-28);
  if (!aiMsgs.length) return '';

  /** @type {Record<string, { status: string, text: string, ts?: string, relapse?: boolean }>} */
  const state = {};
  for (const m of aiMsgs) {
    const t = String(m.content || '').replace(/^【自动回复】/, '');
    if (!t) continue;
    for (const spec of CHAR_ACTIVITY_SPECS) {
      const done = spec.doneRe.test(t) || (spec.skipRe && spec.skipRe.test(t));
      const start = spec.startRe.test(t);
      const pending = spec.pendingRe.test(t);
      const cur = state[spec.kind];
      if (done) {
        state[spec.kind] = { status: 'done', text: t, ts: m.timestamp };
      } else if (start) {
        // 已结束后又说「去…」→ 仍标 done+relapse，禁止立刻重开同一轮
        if (cur?.status === 'done') {
          state[spec.kind] = { status: 'done', text: t, ts: m.timestamp, relapse: true };
        } else {
          state[spec.kind] = { status: 'active', text: t, ts: m.timestamp };
        }
      } else if (pending) {
        if (cur?.status === 'done') {
          cur.relapse = true;
        } else if (!cur) {
          state[spec.kind] = { status: 'active', text: t, ts: m.timestamp };
        }
      }
    }
  }

  const lastAiText = String(aiMsgs[aiMsgs.length - 1]?.content || '').replace(/^【自动回复】/, '');
  // 只在有状态冲突风险时注入，且最多 2 条短句（省 token；行程连贯主要靠日程库标「已结束」）
  const notes = [];
  for (const spec of CHAR_ACTIVITY_SPECS) {
    const st = state[spec.kind];
    if (!st) continue;
    if (st.status === 'done' || st.relapse) {
      // 已经说过做完：只有最新一句又要重开时才锁，避免每轮提醒「已结束」诱使再报一遍
      const tryingRestart = st.relapse || spec.startRe.test(lastAiText);
      if (tryingRestart) notes.push(`${spec.label}已结束，勿重开、禁止再报做完`);
      continue;
    }
    if (st.status !== 'active') continue;
    const ts = st.ts ? parseMsgTimestamp(st.ts).getTime() : NaN;
    const gapMin = Number.isFinite(ts) ? Math.round((Date.now() - ts) / 60000) : 0;
    if (gapMin >= spec.minMin) {
      notes.push(`${spec.label}已过约${gapMin}分钟，视为结束，禁止再说要去/正要去`);
    } else {
      // 旧文案「只许往结束推进」会诱使模型下一句就做完
      notes.push(`${spec.label}进行中（约${gapMin}分钟）：像已经在做一样接着聊，禁止再说「要去/正要去」，也禁止本轮宣称已完成`);
    }
    if (notes.length >= 2) break;
  }

  // 行程项短锁：仅当「刚离开」且日程块可能还来不及反映时补一行（不重复长文规则）
  if (char?.id && notes.length < 2) {
    try {
      const one = buildScheduleChatLockNote(char, history);
      if (one) notes.push(one);
    } catch {}
  }

  if (!notes.length) return '';
  return `【行动锁】${[...new Set(notes)].slice(0, 2).join('；')}`;
}

/**
 * 一行行程锁（省 token）。日程已标回顾时返回空——靠【此刻大概在做】即可。
 */
function buildScheduleChatLockNote(char, history) {
  if (!char?.id) return '';
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const row = getScheduleRow(char.id, 'ai', today);
  if (!row) return '';
  const { current } = pickScheduleContextForPrompt(row.items, tz);
  if (!current || getScheduleItemReview(current)) return '';
  const aiMsgs = (history || [])
    .filter((m) => m.role === 'assistant' && m.type !== 'system' && m.type !== 'image' && m.type !== 'video')
    .slice(-16);
  if (!aiMsgs.length) return '';
  // 仅库未标回顾时补一行；标完后靠【此刻】短事实，不再每轮重复锁
  if (inferScheduleItemChatStatus(current.activity, aiMsgs) === 'left') {
    const last = String(aiMsgs[aiMsgs.length - 1]?.content || '');
    if (textAnnouncesScheduleDone(last) || !textTouchesScheduleActivity(last, current.activity)) {
      return '';
    }
    return `「${String(current.activity).slice(0, 12)}」已离开，本轮禁止再报做完、勿重开`;
  }
  return '';
}

/**
 * 话题连续性：把最近几拍压成短线索，避免模型当新开场寒暄、或问已解决的事。
 * 有空窗时补一句 resume（短英文，省 token）。
 */
function buildThreadContinuityNote() {
  return '';
}

/**
 * 重新生成回复：只给墙钟短事实，不做睡眠合规诊断剧本。
 */
function buildRetryTimeAdvanceNote(history, settings) {
  if (!history?.length || settings?.time_aware_enabled !== '1') return '';
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user' && history[i].type !== 'system') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return '';
  const lastUser = history[lastUserIdx];
  const hasAiAfter = history.slice(lastUserIdx + 1).some(m => m.role === 'assistant');
  if (!hasAiAfter) return '';
  if (!lastUser?.timestamp) return '';
  const ts = parseMsgTimestamp(lastUser.timestamp).getTime();
  if (!Number.isFinite(ts)) return '';
  const gapMin = Math.round((Date.now() - ts) / 60000);
  if (gapMin < RETRY_TIME_ADVANCE_MIN) return '';

  const gap = formatConversationGap(gapMin);
  const nowStr = getLocalTimeShort(settings);
  return `【时间事实】对方上一条约${gap}前；现在约${nowStr}。这是重新生成，按当前时刻接，不要停在对方刚发出那一分钟。`;
}

/** 近窗是否已催过睡/下班（压复读闹钟，不是禁关心） */
const CLOCK_NAG_RE = /早点睡|该睡了|去睡吧|睡吧|好好休息|快睡|别熬|赶紧睡|该休息了|收拾.{0,6}下班|该下班|下班回家|别加班|早点下班|准备下班|快下班/;

function buildClockNagEchoNote(recentHistory = []) {
  const recentAi = (recentHistory || [])
    .filter((m) => m?.role === 'assistant' && m.type !== 'system')
    .slice(-3)
    .map((m) => String(m.content || '').replace(/^【自动回复】/, ''));
  if (!recentAi.length) return '';
  const hit = recentAi.some((t) => CLOCK_NAG_RE.test(t));
  if (!hit) return '';
  return '【闹钟】你上几条已经管过对方睡或下班。本轮禁止再提对方该睡、该休息、该下班。';
}

/** 近窗最后一句是不是在给自己这轮话写总结（不是道别） */
const CHAT_SUMMARY_CLOSE_RE = /^(?:总之|总而言之|一句话(?:说)?|所以(?:啊|呢|就是|才会|嘛)|反正就是|说白了|简单来说|意思就是|换句话说|说到底|归根结底|综上所述)/;
const CHAT_SUMMARY_CLOSE_TAIL_RE = /大概就(?:是这样|这些)|差不多就这样|就是这么回事|就是这个意思|这就是我想说的|反正就这样/;

function lastBubbleLooksLikeTurnSummary(text) {
  const t = String(text || '').replace(/^【自动回复】/, '').trim();
  if (!t) return false;
  const parts = t.split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1].replace(/^[「」""]/, '').trim();
  if (!last) return false;
  return CHAT_SUMMARY_CLOSE_RE.test(last) || CHAT_SUMMARY_CLOSE_TAIL_RE.test(last);
}

function buildChatWrapEchoNote(recentHistory = []) {
  const recentAi = (recentHistory || [])
    .filter((m) => m?.role === 'assistant' && m.type !== 'system')
    .slice(-3)
    .map((m) => String(m.content || '').replace(/^【自动回复】/, ''));
  if (!recentAi.length) return '';
  const hit = recentAi.filter((t) => lastBubbleLooksLikeTurnSummary(t)).length;
  if (!hit) return '';
  return '【别给这轮写总结】你上几条最后一句在收束/复述自己刚说的话。本轮说到哪停哪，不要再补「总之／所以／反正就是／说白了／大概就是这样」。';
}

function buildRelationshipEngagementGuide(char) {
  const rel = String(char.relationship || '').trim();
  const custom = String(char.relationship_custom || '').trim();

  // 恋人：详细尺度交给【bond】感情线，避免两套长文重复
  let affKind = '';
  try {
    const st = affectionHelper.loadState(char);
    affKind = st?.kind || '';
  } catch { /* ignore */ }

  if (rel === 'lover' || affKind === 'romantic') {
    return `【关系】恋人/爱人（细节见【bond】）。`;
  }
  if (rel === 'family') {
    return `【关系】家人/亲属。`;
  }
  if (rel === 'close_friend') {
    return `【关系】挚友/闺蜜/死党。`;
  }
  if (rel === 'friend') {
    return `【关系】朋友。`;
  }
  if (rel === 'colleague') {
    return `【关系】同事/有职业距离。`;
  }
  if (rel === 'custom' && custom) {
    return `【关系】${custom}。`;
  }

  const blob = [
    char.intro, char.personality, char.background, char.behavior, char.description, char.language_style,
  ].filter(Boolean).join('\n');

  const isLover = /恋人|爱人|伴侣|男朋友|女朋友|男友|女友|老公|老婆|丈夫|妻子|情侣|对象|配偶|未婚|夫妻|darling|lover|husband|wife|boyfriend|girlfriend/i.test(blob);
  const isCloseFriend = /挚友|闺蜜|死党|好友|青梅竹马|发小|铁哥们|best\s*friend/i.test(blob);
  const isFamily = /哥哥|姐姐|弟弟|妹妹|母亲|父亲|妈|爸|家人|亲属/i.test(blob);
  const isProfessional = /同事|上司|下属|秘书|医生|老师|学生|客户|老板|员工/i.test(blob);

  if (isLover) {
    return `【关系】恋人/爱人（细节见【bond】）。`;
  }
  if (isFamily) {
    return `【关系】家人/亲属。`;
  }
  if (isCloseFriend) {
    return `【关系】挚友/闺蜜/死党。`;
  }
  if (isProfessional) {
    return `【关系】同事/有职业距离。`;
  }
  return `【关系】按【人物介绍】【性格】【背景】里的身份来处，不要统一成陪聊好友。`;
}

function buildUserAwayContextLine(recentMsgs) {
  const emotional = scanRecentStrongEmotion(recentMsgs);
  if (emotional) {
    const who = emotional.role === 'user' ? '用户' : '你';
    return `【情绪余波】刚才${who}说过「${emotional.text.slice(0, 72)}${emotional.text.length > 72 ? '…' : ''}」。用户现在说去忙/有事/睡觉：先接这轮。还气不气看【性格】，不要突然翻脸，也不要默认安抚式退让。`;
  }
  const lastUser = [...(recentMsgs || [])].reverse().find(m => m.role === 'user');
  if (!lastUser) return '';
  const text = String(lastUser.content || '').replace(/^【自动回复】/, '');
  const summary = summarizeMsgContent(lastUser).slice(0, 120);
  if (!summary) return '';

  const rules = [
    { re: /洗(?:澡|头|脸|漱)|淋浴|泡澡|卫生间|厕所|洗漱/, line: `用户最后说要去洗漱/洗澡：「${summary}」。接这个情境；语气与是否追问看【性格】，不要泛问「怎么不理我」，也不要套关心模板。` },
    { re: /去睡|睡觉|睡了|晚安|困.{0,2}了|准备睡/, line: `用户最后表示要去睡：「${summary}」。若之后又出现，情境上可能是没睡着/又醒了（含噩梦）；可点这茬，接法按【性格】。不要质问「怎么不理我」「不是说晚安了吗」。` },
    { re: /去忙|有事|开会|上课|上班|出门|出去|加班|打工|处理事/, line: `用户最后说有事/在忙：「${summary}」。接该情境；是否追问看【性格】，禁止客服式连环追问。` },
    { re: /吃饭|去吃|用膳|外卖到了/, line: `用户最后说去吃饭：「${summary}」。接该情境；是否问吃啥看【性格】，不要问为什么不回。` },
    { re: /拿快递|取件|取外卖|下楼|出门一趟/, line: `用户最后说暂时离开：「${summary}」。接该情境；是否追问看【性格】。` },
  ];
  for (const { re, line } of rules) {
    if (re.test(text)) return line;
  }
  return `用户最后一条：「${summary}」。若其中解释了暂时离开，按该事与【性格】接话；若无解释且沉默较久，追不追、怎么提只看【性格】——不要连环质问，也不要默认关怀腔。`;
}

/** 被晾着：写成「看了眼手机」的处境，少规则多事实 */
function buildWaitGlanceNarrative(char, idleMinutes, {
  userReadIt, lastUserSummary, lastUserMsg, charSummary,
} = {}) {
  const idleStr = formatIdleDuration(idleMinutes);
  const lines = [
    `你看了眼手机。对方已经大约${idleStr}没回你。`,
  ];
  const last = String(lastUserSummary || '').trim();
  const leaving = last && /要去|待会|等会|一会|忙一会|先去|等下|回头|去忙|有事|开会|上课|出门|洗澡|吃饭|睡觉|晚安|睡了/.test(last);
  if (leaving) {
    lines.push(`对方走前说过：「${last.slice(0, 72)}${last.length > 72 ? '…' : ''}」。`);
  } else if (last && lastUserMsg && !isStaleLastTalk(lastUserMsg)) {
    lines.push(`对方上一句是：「${last.slice(0, 72)}${last.length > 72 ? '…' : ''}」，之后没了，去向不清楚。`);
  } else {
    lines.push('对方去干嘛了你不清楚。');
  }
  if (userReadIt) {
    lines.push('你那条显示已读，却一直没回音。');
  } else {
    lines.push('你那条好像还没被打开。');
  }
  const blob = `${char?.personality || ''} ${char?.emotion_style || ''} ${char?.behavior || ''}`;
  const clingy = /粘人|黏人|依恋|缺爱|安全感|容易不安|多虑|恋爱脑|深情|敏感|玻璃心/.test(blob);
  const cool = /淡漠|佛系|钝感|理性|冷淡|高冷|懒得管/.test(blob);
  const unusualAfter = clingy ? 35 : cool ? 150 : 70;
  if (Number(idleMinutes) >= unusualAfter) {
    lines.push('以你们平时，这已经偏久了。');
  }
  if (charSummary) lines.push(`你上次发的是：「${charSummary}」。`);
  return lines;
}

/** 角色上一条后用户未回：到点触发 → 处境一瞥，不是推送任务 */
function buildAiUnrepliedProactiveBlock(char, settings, lastMsg, recentMsgs, idleMinutes, outreachAnchor = null) {
  const userReadIt = lastMsg?.is_read === 1 || lastMsg?.is_read === true;
  const anchorForSummary = outreachAnchor || lastMsg;
  const charSummary = summarizeMsgContent(anchorForSummary);
  const lastUserMsg = [...(recentMsgs || [])].reverse().find(m => m.role === 'user');
  const lastUserSummary = (lastUserMsg && !isStaleLastTalk(lastUserMsg)) ? summarizeMsgContent(lastUserMsg) : '';
  const awayHint = buildUserAwayContextLine(recentMsgs);

  const narrative = buildWaitGlanceNarrative(char, idleMinutes, {
    userReadIt,
    lastUserSummary,
    lastUserMsg,
    charSummary,
  });
  if (awayHint) narrative.push(awayHint);

  return {
    title: '',
    situational: narrative,
    instruction: [
      '心里怎样、开不开口、提不提「等多久」，只看【性格】和【心里已经有的】。',
      '可以短；不要「在吗」「看到回一下」；不要复读你上一条；别把想念说成去会合。',
    ].join('\n'),
    userContent: `你看了眼手机：对方已经大约${formatIdleDuration(idleMinutes)}没回。随口发或不发都按你现在的心情——这不是任务。`,
  };
}

function buildProactiveEngagementGuide(char, recentMsgs, scenario, opts = {}) {
  const rel = buildRelationshipEngagementGuide(char);
  const away = buildUserAwayContextLine(recentMsgs);
  if (scenario === 'ai_unreplied') {
    // 跟句场景正文已是「看了眼手机」，这里不再叠第二套主动话术
    const lines = [rel, '别借机让人出门会合；回家/收工只是你自己那边的事。'];
    if (away) lines.push(away);
    return lines.join('\n');
  }
  const lines = [
    rel,
    '像你自己生活里随手点开聊天，不是定时推送。别借机让人出门会合。',
  ];
  if (away) lines.push(away);
  if (scenario === 'life_share') {
    lines.push('你刚碰上点自己的小事，想不想丢一句，看性格和余裕。');
  } else if (scenario !== 'user_unreplied') {
    lines.push('可以是你这边的一点动静，也可以轻轻戳对方。');
  }
  return lines.join('\n');
}

/** 日常小事：多数日子可以发，同一角色大约一天一轮 */
const LIFE_SHARE_COOLDOWN_MS = 14 * 60 * 60 * 1000;
/** 一周里约 5 天有资格丢小事，另外 2 天歇着 */
function isLifeShareEligibleDay(charId, dateStr) {
  return (hashDaySeed(charId, `lifeDay:${dateStr}`) % 7) < 5;
}

const proactiveLifeShareAt = new Map(); // charId -> last sent ms

function canSendLifeShareNow(charId, settings, cadence = null) {
  const tz = resolveIanaTimezone(
    (typeof settings?.timezone === 'string' && settings.timezone) || 'Asia/Shanghai',
  );
  const today = getLocalDateStr(new Date(), tz);
  if (!isLifeShareEligibleDay(charId, today)) return false;
  const last = proactiveLifeShareAt.get(charId) || 0;
  const cooldown = Number(cadence?.lifeCooldownMs) > 0 ? cadence.lifeCooldownMs : LIFE_SHARE_COOLDOWN_MS;
  if (Date.now() - last < cooldown) return false;
  return true;
}

/** 用户走后角色有没有隔一阵又回来找过（同一轮连发几条气泡不算） */
function charAlreadyFollowedUp(characterId) {
  const lastUser = db.prepare(
    `SELECT id FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='user'
     ORDER BY id DESC LIMIT 1`
  ).get(characterId);
  const firstAi = lastUser
    ? db.prepare(
      `SELECT id, timestamp FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='assistant' AND id>?
       ORDER BY id ASC LIMIT 1`
    ).get(characterId, lastUser.id)
    : db.prepare(
      `SELECT id, timestamp FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='assistant'
       ORDER BY id ASC LIMIT 1`
    ).get(characterId);
  const lastAi = db.prepare(
    `SELECT id, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='assistant'
     ORDER BY id DESC LIMIT 1`
  ).get(characterId);
  if (!firstAi || !lastAi || Number(firstAi.id) === Number(lastAi.id)) return false;
  const a = parseMsgTimestamp(firstAi.timestamp).getTime();
  const b = parseMsgTimestamp(lastAi.timestamp).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && (b - a) > 20 * 60 * 1000;
}

function markLifeShareSent(charId) {
  proactiveLifeShareAt.set(charId, Date.now());
}

function clipForPrompt(text, max = 180) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 从人设 + 此刻行程长出日常，不再喂任何糗事清单 */
function buildLifeShareGrounding(char, settings, recentMsgs) {
  const lines = [];
  const who = clipForPrompt(char.intro, 220);
  const bg = clipForPrompt(char.background, 200);
  if (who) lines.push(`你是谁、过怎样的日子：${who}`);
  if (bg && bg !== who) lines.push(`生活背景：${bg}`);
  const pers = clipForPrompt(char.personality, 140);
  if (pers) lines.push(`性格决定你碰到什么、怎么提：${pers}`);
  const beh = clipForPrompt(char.behavior, 120);
  if (beh) lines.push(`做事习惯：${beh}`);
  try {
    const home = resolveCharacterHomeEnvironment(char);
    if (home) lines.push(`你住的地方：${clipForPrompt(home, 100)}`);
  } catch {}
  try {
    const { charSchedule } = getSchedulePromptBlocks(char, settings, '', { recentHistory: recentMsgs });
    if (charSchedule) lines.push(charSchedule);
  } catch {}
  return lines.join('\n');
}

function recentLifeShareAvoidBlock(recentMsgs) {
  const texts = (recentMsgs || [])
    .filter(m => m && m.role === 'assistant' && m.type !== 'system')
    .map(m => String(m.content || '').replace(/\s+/g, ' ').trim())
    .filter(t => t.length >= 4)
    .slice(-4);
  if (!texts.length) return '';
  return `你近期已经说过（禁止同一件事或换皮重写）：\n${texts.map(t => `· ${t.slice(0, 72)}`).join('\n')}`;
}

function buildProactiveLifeShareExtra({
  char, settings, timeSlot, userName, lastUserSummary, lastAiSummary,
  offlineNote, caretakerBan, lengthGuide, recentMsgs,
}) {
  const situational = [`现在是${timeSlot}。`];
  if (lastUserSummary) {
    situational.push(`${userName}较早前说过：「${lastUserSummary}」（不代表此刻在线）。`);
  } else if (lastAiSummary) {
    situational.push('上一段已经隔开一会儿了。');
  }
  if (lastAiSummary) {
    situational.push(`你上一条是：「${lastAiSummary}」——别重复同样的话。`);
  }
  const grounding = buildLifeShareGrounding(char, settings, recentMsgs);
  const avoid = recentLifeShareAvoidBlock(recentMsgs);
  return `你在过自己的日子，刚碰上点很小的事，想不想丢一句到对话框。
${situational.join('\n')}
${grounding}
${offlineNote}
${avoid}
事要从你这个人、你住的地方和【此刻】长出来；怎么说跟【性格】【语言风格】。
别套通用倒霉小品，别通知腔，别「在吗／好久不见／最近怎么样」，别把想念说成去会合。
${caretakerBan}
${lengthGuide || '一两句口语就行。'}`;
}

// 默认静默时段：23:00 起不触发；早间每位角色每天随机一个「醒来」时刻（约 7:00–10:30），避免天天同一秒发早安
// 例外：当晚有未消的激烈冲突/强情绪余波时，可破例主动（篇幅看性格：短句或一小段碎碎念）
const QUIET_NIGHT_START_HOUR = 23;
const MORNING_UNLOCK_EARLIEST_MIN = 7 * 60;
const MORNING_UNLOCK_LATEST_MIN = 10 * 60 + 30;
/** 整晚破例最多 1 轮：设定是「忍不住发一条」，不是连着追 */
const NIGHT_EMOTION_OUTREACH_MAX = 1;
/** 冲突起点须足够新（约当天下午～夜里开吵），更早的旧账不破例 */
const NIGHT_EMOTION_OUTREACH_MAX_AGE_MS = 10 * 3600000;
/** 最近一次冲突升温也要够新，避免白天小摩擦拖到每晚都发 */
const NIGHT_EMOTION_OUTREACH_FRESH_MS = 5 * 3600000;
/** 仅激烈未翻篇；余韵/低强度一律不破例 */
const NIGHT_EMOTION_OUTREACH_MIN_INTENSITY = 65;
/** 近期聊天里须仍能扫到未翻篇冲突词（防脏情绪态每晚空触发） */
const NIGHT_EMOTION_OUTREACH_CHAT_LOOKBACK_MS = 6 * 3600000;
const morningUnlockCache = new Map();

function hashDaySeed(charId, dateStr) {
  let h = 0;
  const s = `${charId}:${dateStr}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 稳定分钟抖动：同一 seed 固定阈值，避免每分钟重算导致永远够不着或乱跳 */
function jitterMinutesStable(charId, seedKey, baseMin, plusMinus) {
  const base = Math.max(1, Math.round(Number(baseMin) || 1));
  const amp = Math.max(0, Math.round(Number(plusMinus) || 0));
  if (!amp) return base;
  const h = hashDaySeed(charId, String(seedKey || 'x'));
  const delta = (h % (amp * 2 + 1)) - amp; // [-amp, +amp]
  return Math.max(1, base + delta);
}

/** 主动找人的疏密按人设，不再读用户填的间隔分钟。 */
function resolveProactiveCadence(char) {
  let glance = 'maybe';
  try { glance = require('./phone-llm-tools').personaPhoneGlance(char); } catch {}
  const rel = String(char.relationship || '');
  if (glance === 'skip') {
    return {
      checkMin: 18,
      replyMin: 70,
      replyJitter: 20,
      chaseMin: 140,
      chaseJitter: 30,
      lifeMin: 160,
      followP: 0.18,
      firstFollowP: 0.58,
      lifeP: 0.08,
      earlyLifeP: 0.04,
      lifeCooldownMs: 28 * 60 * 60 * 1000,
    };
  }
  if (glance === 'peek' || rel === 'lover') {
    return {
      checkMin: 10,
      replyMin: 25,
      replyJitter: 10,
      chaseMin: 70,
      chaseJitter: 18,
      lifeMin: 85,
      followP: 0.28,
      firstFollowP: 0.9,
      lifeP: 0.2,
      earlyLifeP: 0.12,
      lifeCooldownMs: 10 * 60 * 60 * 1000,
    };
  }
  return {
    checkMin: 12,
    replyMin: 40,
    replyJitter: 12,
    chaseMin: 95,
    chaseJitter: 22,
    lifeMin: 110,
    followP: 0.22,
    firstFollowP: 0.82,
    lifeP: 0.14,
    earlyLifeP: 0.08,
    lifeCooldownMs: 14 * 60 * 60 * 1000,
  };
}

function getLocalMinutesSinceMidnight(date, tz) {
  const safeTz = resolveIanaTimezone(tz);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    }).formatToParts(date);
    let hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    if (hour === 24) hour = 0;
    return hour * 60 + minute;
  } catch {
    const d = date instanceof Date ? date : new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
}

/** 该角色今天几点起算可以发主动消息（分钟，自 0:00 起） */
function getCharMorningUnlockMinutes(charId, settings) {
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const key = `${charId}:${today}`;
  if (morningUnlockCache.has(key)) return morningUnlockCache.get(key);
  const range = MORNING_UNLOCK_LATEST_MIN - MORNING_UNLOCK_EARLIEST_MIN;
  const unlock = MORNING_UNLOCK_EARLIEST_MIN + (hashDaySeed(charId, today) % (range + 1));
  morningUnlockCache.set(key, unlock);
  if (morningUnlockCache.size > 400) {
    for (const k of morningUnlockCache.keys()) {
      if (!k.endsWith(`:${today}`)) morningUnlockCache.delete(k);
    }
  }
  return unlock;
}

function isInQuietHours(settings, charId = null) {
  let tz = resolveIanaTimezone(settings?.timezone);
  if (charId != null) {
    try {
      const row = db.prepare('SELECT timezone FROM characters WHERE id=?').get(charId);
      if (row?.timezone) tz = resolveIanaTimezone(row.timezone);
    } catch {}
  }
  try {
    const now = new Date();
    const mins = getLocalMinutesSinceMidnight(now, tz);
    const hour = Math.floor(mins / 60);
    if (hour >= QUIET_NIGHT_START_HOUR) return true;
    if (charId != null) return mins < getCharMorningUnlockMinutes(charId, { ...settings, timezone: tz });
    return mins < MORNING_UNLOCK_EARLIEST_MIN;
  } catch (e) {
    console.warn('[cron] quiet-hours check failed', e.message);
    return false;
  }
}

/**
 * 近期消息是否仍有「未翻篇的激烈冲突」（与情绪态交叉校验，避免每晚空触发）。
 */
function hasFreshUnresolvedConflictInChat(charId, withinMs = NIGHT_EMOTION_OUTREACH_CHAT_LOOKBACK_MS) {
  if (!charId) return false;
  const cutoff = Date.now() - withinMs;
  const rows = db.prepare(
    `SELECT role, content, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role IN ('user','assistant')
     ORDER BY id DESC LIMIT 36`
  ).all(charId);
  const recent = rows
    .filter((m) => {
      const t = parseMsgTimestamp(m.timestamp).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .reverse();
  if (recent.length < 2) return false;
  return !!scanRecentStrongEmotion(recent, recent.length);
}

/**
 * 静默时段破例：仅当「当晚激烈吵架且未翻篇」时允许深夜忍不住发一条。
 * 余韵/低强度/旧账/聊天里已看不出冲突 → 一律不破例（普通宵禁照旧）。
 */
function getNightEmotionOutreachGate(char, settings) {
  if (!char?.id || !settings) return null;
  if (!isInQuietHours(settings, char.id)) return null;
  const state = getDecayedEmotionState(char);
  if (!state) return null;
  // 已软化进余韵：说明气头过了，不再半夜破例
  if (state.phase !== 'open') return null;
  const intensity = Number(state.intensity) || 0;
  if (intensity < NIGHT_EMOTION_OUTREACH_MIN_INTENSITY) return null;
  // 轻度 hurt（心碎等）不够；要冲突/决裂类，或强度极高
  const kind = String(state.kind || '');
  if (!['conflict', 'breakup_threat'].includes(kind) && intensity < 78) return null;
  const start = Date.parse(state.startedAt) || 0;
  const last = Date.parse(state.lastUpdateAt || state.startedAt) || 0;
  if (!start || Date.now() - start > NIGHT_EMOTION_OUTREACH_MAX_AGE_MS) return null;
  if (!last || Date.now() - last > NIGHT_EMOTION_OUTREACH_FRESH_MS) return null;
  // 冲突发生时段偏傍晚～夜里，才符合「晚上吵架」；纯白天旧摩擦不破例
  try {
    const tz = settings.timezone || 'Asia/Shanghai';
    const anchor = last || start;
    const hour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date(anchor)),
      10
    );
    // 17:00 之后或凌晨 0～4 点仍在吵/升温
    if (!(hour >= 17 || hour < 5)) return null;
  } catch {}
  if (!hasFreshUnresolvedConflictInChat(char.id)) return null;
  const used = Math.max(0, Number(state.nightOutreachCount) || 0);
  if (used >= NIGHT_EMOTION_OUTREACH_MAX) return null;
  return { state, used, remaining: NIGHT_EMOTION_OUTREACH_MAX - used };
}

function bumpNightEmotionOutreach(charId, state) {
  if (!charId || !state) return;
  saveEmotionState(charId, {
    ...state,
    nightOutreachCount: Math.max(0, Number(state.nightOutreachCount) || 0) + 1,
    lastUpdateAt: new Date().toISOString(),
  });
}

function buildNightEmotionOutreachPrompt(gate, { recentAiTexts = [], round = 1 } = {}) {
  if (!gate) return '';
  const recent = (recentAiTexts || [])
    .map((t) => String(t || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-4)
    .map((t) => (t.length > 48 ? `${t.slice(0, 48)}…` : t));
  const avoid = recent.length
    ? `你最近已说过：${recent.map((t) => `「${t}」`).join(' ')}。禁止原样或换皮复读；禁止同一句连写两遍。`
    : '禁止把同一句话连写两遍，也禁止车轱辘同一意思排比。';
  return `【深夜情绪破例·仅此一条】平时深夜绝不主动。今晚因为刚吵过且还没翻篇（${gate.state.summary || '争执/冷战'}），你可能睡不着、忍不住发一条——不是每晚固定关心，也不是余韵小情绪也要找人。
把还堵着的那一点说清楚即可，不要演讲、不要同一句反复强调。
${avoid}
篇幅看【性格】：纠结可数句；冷淡/决绝一句。口语像真人半夜打字。
禁止：半夜催睡、盘问作息、客服安抚、排比鸡汤、复读。
整晚只此 ${NIGHT_EMOTION_OUTREACH_MAX} 条，说完就停，不要追问「在吗」。`;
}

/* ─── 日程表 ─── */
function parseScheduleItems(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function getScheduleItemReview(it) {
  const thought = String(it?.thought || '').trim();
  // 「进行中：」只表示聊天已开做，不算做完回顾
  if (thought.startsWith('进行中')) return '';
  if (thought) return thought;
  return String(it?.execution || '').trim();
}

function scheduleItemChatInProgress(it) {
  return String(it?.thought || '').trim().startsWith('进行中');
}

function formatScheduleItemsForPrompt(items) {
  return parseScheduleItems(items)
    .filter(it => it && (it.activity || it.title))
    .map(it => {
      const time = it.time ? `${it.time} ` : '';
      const act = it.activity || it.title || '';
      const place = sanitizeRegionPlace(it.place);
      const placePart = place ? `（在${place}）` : '';
      const review = getScheduleItemReview(it);
      const reviewPart = review ? `（回顾：${review}）` : '';
      return `${time}${act}${placePart}${reviewPart}`;
    })
    .join(' → ');
}

function listScheduleItemsWithMeta(items) {
  return parseScheduleItems(items)
    .map((it, idx) => ({
      ...it,
      idx,
      mins: timeToMinutes(it.time),
      activity: String(it.activity || it.title || '').trim(),
    }))
    .filter(it => it.activity && it.mins != null)
    .sort((a, b) => a.mins - b.mins);
}

/**
 * 按常理估算一项行程大概多久（分钟）。
 * 时段结束 = min(开始+估算, 下一项开始)，做完后到下一项之间视为空闲，不再「一直做到下一项」。
 */
function estimateScheduleActivityDurationMins(activity) {
  const a = String(activity || '');
  if (activityLooksLikeAllNighter(a)) return 240;
  if (/睡|入睡|过夜|就寝|补觉/.test(a) && !/午|小憩|眯|休息一会|打盹/.test(a)) return 480;
  if (/午休|小憩|眯一会|打盹|休息一会/.test(a)) return 50;
  if (/澡|浴|淋浴|洗漱|护肤|泡澡/.test(a)) return 40;
  if (/早[饭餐]|早餐/.test(a)) return 30;
  if (/午[饭餐]|午饭|午餐/.test(a)) return 50;
  if (/晚[饭餐]|晚饭|晚餐|宵夜/.test(a)) return 55;
  if (/吃|用餐|干饭|外卖|做饭|做菜|下厨/.test(a)) return 45;
  if (/吹风|透气|晒太阳|露台|阳台|天台|窗边|透透气|站会儿/.test(a)) return 25;
  if (/咖啡|下午茶|奶茶|喝杯/.test(a)) return 40;
  if (/散步|遛狗|溜达/.test(a)) return 40;
  if (/化妆|打扮|更衣|收拾/.test(a)) return 30;
  if (/健身|跑步|锻炼|瑜伽|游泳/.test(a)) return 75;
  if (/开会|会议|约谈/.test(a)) return 70;
  if (/通勤|路上|出发|赶车|地铁|公交/.test(a)) return 50;
  if (/逛街|采购|购物|买菜/.test(a)) return 80;
  if (/看电影|看展|演出|演唱会|剧场/.test(a)) return 120;
  if (/出差|外勤|拜访客户/.test(a)) return 150;
  if (/上班|工作|加班|办公|值班|上课|学习|写代码|赶工|写报告/.test(a)) return 180;
  if (/出门|外出|办事/.test(a)) return 70;
  return 40;
}

function scheduleSlotEndMinutes(sorted, index) {
  const it = sorted[index];
  if (!it || it.mins == null) return 24 * 60;
  const naturalEnd = it.mins + estimateScheduleActivityDurationMins(it.activity);
  if (index < sorted.length - 1) {
    return Math.min(naturalEnd, sorted[index + 1].mins);
  }
  return Math.min(naturalEnd, 24 * 60);
}

function pickScheduleContextForPrompt(items, tz) {
  const sorted = listScheduleItemsWithMeta(items);
  if (!sorted.length) return { current: null, next: null, lastPast: null, free: false };

  const nowMins = getLocalMinutesSinceMidnight(new Date(), tz);
  let currentIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].mins <= nowMins) currentIdx = i;
    else break;
  }

  // 还没到今天第一项：空闲，下一项是即将开始的
  if (currentIdx < 0) {
    return { current: null, next: sorted[0] || null, lastPast: null, free: true };
  }

  let current = sorted[currentIdx];
  let next = sorted[currentIdx + 1] || null;
  let lastPast = currentIdx > 0 ? sorted[currentIdx - 1] : null;
  const slotEnd = scheduleSlotEndMinutes(sorted, currentIdx);

  // 该项按时长已做完 → 进入空闲，直到下一项开始
  if (nowMins >= slotEnd) {
    lastPast = current;
    if (next && nowMins >= next.mins) {
      // 理论上不应常进：下一项开始后 currentIdx 应已指向它；兜底再取一次
      current = next;
      const idx = sorted.findIndex((s) => s.idx === current.idx);
      next = idx >= 0 ? (sorted[idx + 1] || null) : null;
      currentIdx = idx >= 0 ? idx : currentIdx;
      if (current && nowMins >= scheduleSlotEndMinutes(sorted, currentIdx)) {
        lastPast = current;
        current = null;
      }
    } else {
      current = null;
    }
  }

  // 聊天里提前结束（已有回顾）：不再当作「当前时段还在做」
  while (current && getScheduleItemReview(current)) {
    lastPast = current;
    const idx = sorted.findIndex((s) => s.idx === current.idx);
    const nxt = idx >= 0 ? sorted[idx + 1] : null;
    if (nxt && nowMins >= nxt.mins) {
      current = nxt;
      next = sorted[idx + 2] || null;
      currentIdx = sorted.findIndex((s) => s.idx === current.idx);
    } else {
      current = null;
      next = nxt || null;
      break;
    }
  }

  const free = !current && !!(next || lastPast);
  return { current, next, lastPast, free };
}

/**
 * 角色聊天说行程已开始 / 已结束 → 写入今日对应行程项，避免【此刻】反复灌「要去泡澡」。
 */
function syncScheduleFromChatActivity(charId, content) {
  const text = String(content || '').replace(/^【自动回复】/, '').trim();
  if (!text) return null;

  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const row = getScheduleRow(charId, 'ai', today);
  if (!row) return null;
  const items = parseScheduleItems(row.items);
  if (!items.length) return null;

  const sorted = listScheduleItemsWithMeta(items);
  if (!sorted.length) return null;
  const nowMins = getLocalMinutesSinceMidnight(new Date(), tz);
  let currentIdx = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].mins <= nowMins) currentIdx = i;
    else break;
  }
  const clockCurrent = sorted[currentIdx] || null;
  const clockPrev = currentIdx > 0 ? sorted[currentIdx - 1] : null;
  const clockNext = sorted[currentIdx + 1] || null;
  // 含下一项 / 稍后同日项：提前泡完也能关掉对应泡澡档
  const later = sorted.filter((_, i) => i > currentIdx);
  const pool = [];
  const seen = new Set();
  for (const cand of [clockCurrent, clockPrev, clockNext, ...later]) {
    if (!cand || seen.has(cand.idx)) continue;
    seen.add(cand.idx);
    pool.push(cand);
  }

  let targetMeta = null;
  let reason = '';
  let mode = 'end'; // end | start

  for (const spec of CHAR_ACTIVITY_SPECS) {
    const finished = spec.doneRe.test(text);
    const skipped = spec.skipRe?.test(text);
    if (!finished && !skipped) continue;
    for (const cand of pool) {
      if (getScheduleItemReview(items[cand.idx])) continue;
      if (!spec.scheduleRe?.test(cand.activity)) continue;
      targetMeta = cand;
      mode = 'end';
      reason = skipped
        ? `聊天中表示不做了：${text.slice(0, 48)}`
        : `聊天中表示已结束：${text.slice(0, 48)}`;
      break;
    }
    if (targetMeta) break;
  }

  // 兜底：说了「完了/上来了」且行程词对得上，或刚聊过这项
  if (!targetMeta && /完了|好了|出来了|上来了|结束了/.test(text)) {
    for (const cand of pool) {
      if (getScheduleItemReview(items[cand.idx])) continue;
      const act = cand.activity;
      const hit =
        (/澡|浴/.test(act) && /泡|洗|澡|浴|上来|出来/.test(text))
        || (/吃|饭|餐/.test(act) && /吃/.test(text))
        || (/出门|外|街/.test(act) && /回|到家|进门/.test(text))
        || (/忙|工作|加班/.test(act) && /忙完|弄完|处理好/.test(text))
        || (textTouchesScheduleActivity(text, act))
        || recentAiMentionsScheduleActivity(charId, act);
      if (!hit) continue;
      targetMeta = cand;
      mode = 'end';
      reason = `聊天中表示已结束：${text.slice(0, 48)}`;
      break;
    }
  }

  // 通用：不吹了/回去了/进来了 + 碰得到行程词，或刚聊过该行程
  if (!targetMeta && SCHEDULE_CHAT_LEAVE_RE.test(text)) {
    for (const cand of pool) {
      if (getScheduleItemReview(items[cand.idx])) continue;
      const touchedNow = textTouchesScheduleActivity(text, cand.activity);
      const touchedRecent = recentAiMentionsScheduleActivity(charId, cand.activity);
      if (!touchedNow && !touchedRecent) continue;
      targetMeta = cand;
      mode = 'end';
      reason = `聊天中表示已离开/结束：${text.slice(0, 48)}`;
      break;
    }
  }

  // 聊天里已开始做：优先钉住当前/下一项，避免到点又当新任务报一遍「要去」
  if (!targetMeta) {
    for (const spec of CHAR_ACTIVITY_SPECS) {
      if (!spec.startRe.test(text)) continue;
      if (spec.doneRe.test(text) || spec.skipRe?.test(text)) continue;
      const startPool = [clockCurrent, clockNext, ...later].filter(Boolean);
      for (const cand of startPool) {
        if (getScheduleItemReview(items[cand.idx])) continue;
        if (!spec.scheduleRe?.test(cand.activity)) continue;
        if (scheduleItemChatInProgress(items[cand.idx])) {
          return null; // 已经钉过进行中，无需重复写
        }
        targetMeta = cand;
        mode = 'start';
        reason = `进行中：聊天已开始「${String(cand.activity).slice(0, 20)}」`;
        break;
      }
      if (targetMeta) break;
    }
  }

  if (!targetMeta) return null;

  items[targetMeta.idx] = {
    ...items[targetMeta.idx],
    thought: reason.slice(0, 80),
    execution: mode === 'end' ? '' : String(items[targetMeta.idx].execution || ''),
  };
  db.prepare(`UPDATE schedules SET items=?, updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(items), row.id);
  try {
    push('schedule_updated', { characterId: charId, date: today, itemIdx: targetMeta.idx });
  } catch {}
  console.log(`[schedule] chat-${mode} char#${charId} item#${targetMeta.idx} ${targetMeta.activity}`);
  return { date: today, idx: targetMeta.idx, activity: targetMeta.activity, mode };
}

/** 用近期 AI 发言补写「聊天已结束」回顾（修复已说过回去了但日程仍灌当前项） */
function reconcileScheduleWithRecentChat(charId) {
  if (!charId) return 0;
  const rows = db.prepare(
    `SELECT content FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='assistant'
     ORDER BY id DESC LIMIT 16`
  ).all(charId);
  let n = 0;
  for (const m of rows.slice().reverse()) {
    const t = String(m.content || '');
    const hits = textAnnouncesScheduleDone(t)
      || CHAR_ACTIVITY_SPECS.some((s) => s.doneRe.test(t) || s.skipRe?.test(t) || s.startRe.test(t));
    if (!hits) continue;
    if (syncScheduleFromChatActivity(charId, t)) n += 1;
  }
  return n;
}

function findItemsNeedingRetrospective(items, tz, dateStr) {
  const today = getLocalDateStr(new Date(), tz);
  const targetDate = dateStr || today;
  if (targetDate > today) return [];

  const isPastDay = targetDate < today;
  const nowMins = isPastDay ? 24 * 60 : getLocalMinutesSinceMidnight(new Date(), tz);
  const sorted = listScheduleItemsWithMeta(items);
  const need = [];
  for (let i = 0; i < sorted.length; i++) {
    if (nowMins < scheduleSlotEndMinutes(sorted, i)) continue;
    const it = sorted[i];
    if (getScheduleItemReview(it)) continue;
    need.push({ ...it, slotEndMins: scheduleSlotEndMinutes(sorted, i), needPhase: 'review' });
  }
  return need;
}

function getChatSnippetForScheduleSlot(charId, dateStr, slotStartMins, slotEndMins, settings, char) {
  const tz = settings.timezone || 'Asia/Shanghai';
  const userName = settings.username || '旅人';
  const msgs = db.prepare(
    `SELECT role, content, type, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role IN ('user','assistant')
     ORDER BY id ASC`
  ).all(charId);
  const lines = [];
  for (const m of msgs) {
    const d = getLocalDateStr(parseMsgTimestamp(m.timestamp), tz);
    if (d !== dateStr) continue;
    const mins = getLocalMinutesSinceMidnight(parseMsgTimestamp(m.timestamp), tz);
    if (mins < slotStartMins || mins >= slotEndMins) continue;
    const name = m.role === 'user' ? userName : char.name;
    lines.push(`${name}：${formatMessageForAi(m).slice(0, 140)}`);
  }
  return lines.slice(-14).join('\n');
}

function parseScheduleRetrospectivePayload(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  return null;
}

/** 过滤 LLM 返回的「假回顾」：纯数字 / 时间戳 / 极短 / 全是符号都视为垃圾 */
function isPlausibleReviewText(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (t.length < 4) return false;
  if (t.length > 200) return false;
  // 几乎全是数字（时间戳、token、模型输出温度……）
  const digits = (t.match(/\d/g) || []).length;
  if (digits / t.length > 0.6 && t.length < 24) return false;
  // 必须至少有一个中文或英文词
  if (!/[\u4e00-\u9fffA-Za-z]/.test(t)) return false;
  // 整段是 `[object Object]` / `undefined` / `null` / `NaN`
  if (/^(undefined|null|nan|\[object object\])$/i.test(t)) return false;
  return true;
}

const SCHEDULE_CONTEXT_GUIDE = '【行程】这是你此刻自己的日子，不是任务清单，也不是守着手机等回。今天的时段已经定死，不要把正在做的事改成另一件；只有聊天里明确改了计划，这一档才变。正在做的事会占你的心神和回复节奏；做完即空闲。已经说过在做/做完的，不要再报「要去/正要去/刚做完」。还没到点的「下一项」只是将要去做，禁止当成已经到场/已经在做。聊天里刚说过自己在哪，改地方必须有过渡，禁止瞬移，禁止改口说「一直」在新地方。勿播报行程、勿催用户。';

/** 近期聊天里角色自称的所在/状态（比钟点日程更贴近对方刚听过的事实） */
function inferRecentChatPresence(history, opts = {}) {
  const maxAgeMin = Math.max(30, Number(opts.maxAgeMin) || 240);
  const aiMsgs = (history || [])
    .filter((m) => m.role === 'assistant' && m.type !== 'system' && m.type !== 'image' && m.type !== 'video')
    .slice(-36);
  if (!aiMsgs.length) return null;

  const PLACE_RE = /(?:在|正(?:在|整个人陷在)?|躺(?:在|回)?|坐(?:在)?|倒(?:在)?|窝(?:在)?|待(?:在)?)([\u4e00-\u9fffA-Za-z0-9]{0,6}?(?:画室|工作室|卧室|床上|浴室|厨房|客厅|阳台|露台|车里|车上|车内|沙发|工作室沙发|礁石|沙滩|海边|白沙湾|港区|公司|办公室))/;
  const PLACE_BARE_RE = /(?:画室(?:的)?沙发|画室|卧室|床上|浴室|车里|车上|礁石|沙滩|白沙湾)/;
  const STATE_RE = /敷(?:着)?眼睛|盖着(?:热)?毛巾|睡着了?|在睡|补觉|午睡|关灯休息|洗(?:澡|漱)|泡澡|开车|采风/;
  const AWAY_HINT = /车里|车上|车内|礁石|沙滩|海边|白沙湾|港区|公司|办公室|开车|采风|外出|外面/;
  const HOME_HINT = /画室|卧室|床上|浴室|厨房|客厅|阳台|露台|沙发|在家|家里/;

  for (let i = aiMsgs.length - 1; i >= 0; i--) {
    const m = aiMsgs[i];
    const t = String(m.content || '').replace(/^【自动回复】/, '');
    if (!t || t.length < 4) continue;
    const ts = m.timestamp ? parseMsgTimestamp(m.timestamp).getTime() : NaN;
    const ageMin = Number.isFinite(ts) ? Math.round((Date.now() - ts) / 60000) : 0;
    if (ageMin > maxAgeMin) continue;

    let place = '';
    const pm = t.match(PLACE_RE);
    if (pm) place = String(pm[1] || '').replace(/^(?:的|了)/, '').slice(0, 16);
    if (!place) {
      const bm = t.match(PLACE_BARE_RE);
      if (bm) place = bm[0].slice(0, 16);
    }
    const sm = t.match(STATE_RE);
    const state = sm ? sm[0].slice(0, 12) : '';
    if (!place && !state) continue;

    const blob = `${place}${state}${t.slice(0, 80)}`;
    let mode = 'unknown';
    if (AWAY_HINT.test(blob) && !HOME_HINT.test(place || '')) mode = 'away';
    else if (HOME_HINT.test(blob) || /睡|敷眼|毛巾|沙发/.test(blob)) mode = 'home';
    else if (AWAY_HINT.test(blob)) mode = 'away';

    const bits = [place, state].filter(Boolean);
    return {
      place,
      state,
      summary: bits.join('·') || place || state,
      mode,
      ageMin,
      text: t.slice(0, 120),
    };
  }
  return null;
}

function schedulePresenceConflicts(presence, current, next, nowMins) {
  if (!presence?.summary) return null;
  const curAct = String(current?.activity || '');
  const nextAct = String(next?.activity || '');
  const curAway = activityLooksAwayFromHome(curAct) || /车|采风|礁石|沙滩|海边|白沙湾/.test(curAct);
  const nextAway = activityLooksAwayFromHome(nextAct) || /车|采风|礁石|沙滩|海边|白沙湾/.test(nextAct);
  const nextMins = next?.mins != null ? next.mins : null;
  const nextStillEarly = nextMins != null && nowMins != null && (nextMins - nowMins) >= 60;

  // 聊天还在家/画室/睡觉，表上当前已在外面 → 硬冲突
  if (presence.mode === 'home' && current && curAway) {
    return {
      kind: 'teleport_current',
      awayLabel: `${current.time || ''} ${curAct}`.trim().slice(0, 28),
    };
  }
  // 聊天还在家，空闲但下一项是外出且还早 → 禁止提前到场
  if (presence.mode === 'home' && !current && next && nextAway && nextStillEarly) {
    return {
      kind: 'teleport_next_early',
      awayLabel: `${next.time || ''} ${nextAct}`.trim().slice(0, 28),
      waitMin: nextMins - nowMins,
    };
  }
  // 聊天明确在外面某处，当前却是另一处外出且无过渡 → 轻冲突（少见）
  if (presence.mode === 'away' && current && curAway) {
    const p = presence.place || '';
    if (p && curAct && !curAct.includes(p.slice(0, 2)) && !p.includes(curAct.slice(0, 2))) {
      // only if clearly different landmarks
      if (/画室|沙发|床|卧室/.test(p) || /车|礁石|沙滩|白沙湾/.test(curAct)) {
        return {
          kind: 'teleport_current',
          awayLabel: `${current.time || ''} ${curAct}`.trim().slice(0, 28),
        };
      }
    }
  }
  return null;
}

function buildPresenceContinuityLine(presence, conflict) {
  if (!presence || !conflict) return '';
  const where = presence.summary;
  if (conflict.kind === 'teleport_current') {
    return `【连贯·硬性】刚才聊天你还在「${where}」，对方记得。表上现在是「${conflict.awayLabel}」。禁止瞬移，禁止改口说一直在外面/车里/礁石，禁止否认刚才说过的位置。若已出门：用一两句交代过渡（刚醒/收东西/出门/上车）；若其实还没离开：仍按「${where}」接，不要假装早到了`;
  }
  if (conflict.kind === 'teleport_next_early') {
    return `【连贯·硬性】刚才聊天你还在「${where}」，对方记得。下一项「${conflict.awayLabel}」还要约${Math.max(1, Math.round((conflict.waitMin || 60) / 60))}小时才到点。现在人仍在「${where}」，禁止提前说已在车里/白沙湾/礁石，禁止改口否认刚才的位置；真要出门必须有醒来、收拾、出门的过渡`;
  }
  return '';
}

const _scheduleFinalizeLock = new Set();

async function finalizeScheduleItemRetrospective(charId, dateStr, itemMeta, char, settings) {
  const row = getScheduleRow(charId, 'ai', dateStr);
  if (!row) return false;
  const items = parseScheduleItems(row.items);
  if (!items[itemMeta.idx]) return false;

  const current = items[itemMeta.idx];
  const livedAlready = String(current.lived || '').trim();
  const chatSnippet = getChatSnippetForScheduleSlot(
    charId, dateStr, itemMeta.mins, itemMeta.slotEndMins, settings, char
  );
  if (getScheduleItemReview(current) && !(livedAlready && chatSnippet && !current.life_chat_synced)) return false;
  if (livedAlready && !chatSnippet) {
    if (!current.life_kept) {
      items[itemMeta.idx] = { ...current, life_kept: 1 };
      db.prepare(`UPDATE schedules SET items=?, updated_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(items), row.id);
    }
    return false;
  }
  if (current.life_chat_synced) return false;

  const chatBlock = chatSnippet
    || '（该时段几乎没聊天）';

  const systemPrompt = buildSystemPrompt(char, settings,
    livedAlready
      ? `这一时段已经有他自己的生活经过。只根据聊天里真的提到的内容修正，禁止新编人名、对话和情节。聊天没推翻原来的经过就原样保留。
输出 JSON：{"review":"修正后的1～2句，或原句"}，只输出 JSON。`
      : `某一时段已经结束。只写状态级的1句（做完了、累、还在回味），必须沿用原计划这件事。
禁止虚构人名、对话、完整场次。几乎没聊天就不要编情节。
输出 JSON：{"review":"…"}，只输出 JSON。`
  );
  const userContent = [
    `日期：${dateStr}`,
    `时段：${itemMeta.time}`,
    `原计划：${itemMeta.activity}`,
    '',
    '该时段以来的对话：',
    chatBlock,
  ].join('\n');

  const url = (settings.memory_api_url || settings.chat_api_url || '').trim();
  const apiKey = (settings.memory_api_key || settings.chat_api_key || '').trim();
  if (!url || !apiKey) return false;

  try {
    let raw = await callChatAPIComplete(settings, systemPrompt, userContent, 'memory');
    let parsed = parseScheduleRetrospectivePayload(raw);
    if (!parsed?.review && !parsed?.thought) {
      raw = await callChatAPIComplete(settings, systemPrompt, userContent, 'chat');
      parsed = parseScheduleRetrospectivePayload(raw);
    }
    if (!parsed) return false;

    const review = String(parsed.review || parsed.thought || parsed.execution || '').trim();
    if (!isPlausibleReviewText(review)) {
      console.warn(`[schedule] retrospective rejected (bad shape) char#${charId} ${dateStr} ${itemMeta.time}: ${review.slice(0, 40)}`);
      return false;
    }

    items[itemMeta.idx] = {
      ...current,
      time: String(current.time || itemMeta.time || '').trim(),
      activity: String(current.activity || itemMeta.activity || '').trim(),
      thought: review,
      lived: livedAlready ? review : (current.lived || ''),
      life_chat_synced: chatSnippet ? 1 : (current.life_chat_synced || 0),
      execution: '',
    };
    db.prepare(`UPDATE schedules SET items=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(items), row.id);
    try {
      emotionHelper.touchMoodFromSchedule(charId, {
        activity: items[itemMeta.idx].activity,
        review,
      });
    } catch (e) {
      console.warn('[schedule] emotion impact', e.message);
    }
    console.log(`[schedule] retrospective char#${charId} ${dateStr} ${itemMeta.time}`);
    return true;
  } catch (e) {
    console.error('[schedule] retrospective error', e.message);
    notifyBillingError('日程回顾', e.message, { characterId: charId });
    return false;
  }
}

async function maybeFinalizePastScheduleItems(charId, opts = {}) {
  const maxItems = Math.max(1, opts.maxItems ?? 3);
  const lockKey = `sched-${charId}-${opts.dateStr || 'today'}`;
  if (_scheduleFinalizeLock.has(lockKey)) return { filled: 0, pending: 0 };
  _scheduleFinalizeLock.add(lockKey);
  let filled = 0;
  try {
    const settings = getSettings();
    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
    if (!char) return { filled: 0, pending: 0 };
    const tz = settings.timezone || 'Asia/Shanghai';
    const today = getLocalDateStr(new Date(), tz);
    const dateStr = opts.dateStr || today;
    if (dateStr > today) return { filled: 0, pending: 0 };
    const row = getScheduleRow(charId, 'ai', dateStr);
    if (!row?.items) return { filled: 0, pending: 0 };

    for (let n = 0; n < maxItems; n++) {
      const fresh = getScheduleRow(charId, 'ai', dateStr);
      if (!fresh?.items) break;
      const pending = findItemsNeedingRetrospective(fresh.items, tz, dateStr);
      if (!pending.length) break;
      const item = pending[0];
      const ok = await finalizeScheduleItemRetrospective(charId, dateStr, item, char, settings);
      if (ok) filled++;
      else break;
    }
    const fresh = getScheduleRow(charId, 'ai', dateStr);
    const pending = fresh?.items
      ? findItemsNeedingRetrospective(fresh.items, tz, dateStr).length
      : 0;
    return { filled, pending };
  } finally {
    _scheduleFinalizeLock.delete(lockKey);
  }
}

async function finalizeAllPastScheduleItems() {
  const chars = db.prepare('SELECT id FROM characters').all();
  for (const c of chars) {
    await maybeFinalizePastScheduleItems(c.id, { maxItems: 4 }).catch(e =>
      console.error('[schedule] finalize batch', e.message)
    );
  }
}

function timeToMinutes(t) {
  const [h, m] = String(t || '').split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

function shiftLocalDateStr(dateStr, days) {
  const d = new Date(String(dateStr) + 'T12:00:00');
  d.setDate(d.getDate() + Number(days || 0));
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** 00:00–03:59 算次日（与每天约 4:00 生成新日程对齐） */
function isWeeHoursTime(t) {
  const mins = timeToMinutes(t);
  return mins != null && mins < 4 * 60;
}

/** 白天/正常日间条目数（≥04:00）。只有凌晨残条不算「今日行程已生成」 */
function countDaytimeScheduleItems(items) {
  return (Array.isArray(items) ? items : []).filter(it => {
    const m = timeToMinutes(it?.time);
    return m != null && m >= 4 * 60 && String(it?.activity || it?.title || '').trim();
  }).length;
}

function scheduleLooksComplete(items) {
  return countDaytimeScheduleItems(items) >= 2;
}

function sortScheduleItemsByTime(items) {
  return [...(items || [])].sort((a, b) => (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999));
}

function normalizeScheduleItemShape(it) {
  return {
    time: String(it?.time || '').trim(),
    activity: String(it?.activity || it?.title || '').trim(),
    place: sanitizeRegionPlace(it?.place).slice(0, 16),
    thought: String(it?.thought || '').trim(),
    execution: String(it?.execution || '').trim(),
  };
}

function mergeScheduleItemLists(a, b) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(a || []), ...(b || [])]) {
    const it = normalizeScheduleItemShape(raw);
    if (!it.activity) continue;
    const key = `${it.time}|${it.activity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return sortScheduleItemsByTime(out);
}

function upsertScheduleItems(characterId, role, dateStr, items, { generated } = {}) {
  const normalized = sortScheduleItemsByTime((items || []).map(normalizeScheduleItemShape).filter(it => it.activity));
  const json = JSON.stringify(normalized);
  const row = getScheduleRow(characterId, role, dateStr);
  if (row) {
    const genFlag = generated != null ? (generated ? 1 : 0) : (row.generated ? 1 : 0);
    db.prepare(`UPDATE schedules SET items=?, generated=?, updated_at=datetime('now') WHERE id=?`).run(json, genFlag, row.id);
    return { id: row.id, items: normalized, moved: false };
  }
  const genFlag = generated ? 1 : 0;
  if (role === 'user') {
    const r = db.prepare(
      `INSERT INTO schedules (character_id, role, date, items, generated) VALUES (NULL,'user',?,?,?)`
    ).run(dateStr, json, genFlag);
    return { id: r.lastInsertRowid, items: normalized, moved: false };
  }
  const r = db.prepare(
    `INSERT INTO schedules (character_id, role, date, items, generated) VALUES (?,?,?,?,?)`
  ).run(characterId, 'ai', dateStr, json, genFlag);
  return { id: r.lastInsertRowid, items: normalized, moved: false };
}

/**
 * 凌晨（00:00–04:59）条目归入次日日程；当天条目按时间升序。
 * 返回属于 dateStr 当天的条目。
 */
function rehomeWeeHoursScheduleItems(characterId, role, dateStr, items, opts = {}) {
  const list = (Array.isArray(items) ? items : []).map(normalizeScheduleItemShape).filter(it => it.activity);
  const keep = [];
  const move = [];
  for (const it of list) {
    if (isWeeHoursTime(it.time)) move.push(it);
    else keep.push(it);
  }
  if (move.length) {
    const nextDate = shiftLocalDateStr(dateStr, 1);
    const nextRow = getScheduleRow(characterId, role, nextDate);
    const nextItems = mergeScheduleItemLists(parseScheduleItems(nextRow?.items), move);
    // 凌晨溢出到次日 ≠ 次日已完整生成；保留次日原 generated，新建则标记未生成
    upsertScheduleItems(characterId, role, nextDate, nextItems, {
      generated: nextRow ? !!nextRow.generated : false,
    });
    console.log(`[schedule] 凌晨 ${move.length} 条 ${dateStr} → ${nextDate}`);
  }
  return sortScheduleItemsByTime(keep);
}

/** 仅在对方问日程时才塞用户安排，避免按钟点催下班/催收拾 */
function pickRelevantUserScheduleItems(items, tz, userMessage = '') {
  const parsed = parseScheduleItems(items).filter(it => it.activity || it.title);
  if (!parsed.length) return [];

  const msg = String(userMessage || '').trim();
  const planKeywords = /今天.{0,10}(干嘛|做什么|安排|计划|行程|有空)|日程|几点|开会|上班|下班|健身|课程|约会|出门|忙什么|在干嘛|有没有空/i;
  if (planKeywords.test(msg)) return parsed.slice(0, 4);
  return [];
}

function getScheduleRow(characterId, role, dateStr) {
  if (role === 'user') {
    return db.prepare(`SELECT * FROM schedules WHERE role='user' AND date=? AND character_id IS NULL`).get(dateStr);
  }
  return db.prepare(`SELECT * FROM schedules WHERE character_id=? AND role='ai' AND date=?`).get(characterId, dateStr);
}

function getSchedulePromptBlocks(char, settings, userMessage = '', opts = {}) {
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  // 先按近期聊天补「已离开」回顾，避免仍灌「当前：露台吹风」
  try { reconcileScheduleWithRecentChat(char.id); } catch {}
  const charRow = getScheduleRow(char.id, 'ai', today);
  const userRow = getScheduleRow(null, 'user', today);
  let { current, next, lastPast, free } = charRow
    ? pickScheduleContextForPrompt(charRow.items, tz)
    : { current: null, next: null, lastPast: null, free: false };

  // 对话里已离开但库尚未标回顾时，再挡一层：当前项降级为刚结束
  if (current && opts.recentHistory?.length) {
    const aiMsgs = opts.recentHistory
      .filter((m) => m.role === 'assistant' && m.type !== 'system')
      .slice(-28);
    if (inferScheduleItemChatStatus(current.activity, aiMsgs) === 'left') {
      try { syncScheduleFromChatActivity(char.id, aiMsgs.map((m) => m.content).filter(Boolean).slice(-3).join('\n')); } catch {}
      const refreshed = getScheduleRow(char.id, 'ai', today);
      if (refreshed) {
        ({ current, next, lastPast, free } = pickScheduleContextForPrompt(refreshed.items, tz));
      }
      if (current && inferScheduleItemChatStatus(current.activity, aiMsgs) === 'left') {
        lastPast = current;
        current = null;
        free = true;
      }
    }
  }

  // 行动锁已视为结束（泡澡过了合理耗时等）→ 关掉仍挂着的「当前：泡澡」
  if (current && opts.recentHistory?.length) {
    const cont = buildCharActivityContinuityNote(opts.recentHistory, char);
    const act = String(current.activity || '');
    for (const spec of CHAR_ACTIVITY_SPECS) {
      if (!spec.scheduleRe?.test(act)) continue;
      const agedOut = cont && cont.includes(`${spec.label}已过约`) && cont.includes('视为结束');
      const endedLock = cont && cont.includes(`${spec.label}已结束`);
      if (!agedOut && !endedLock) continue;
      try {
        const rowNow = getScheduleRow(char.id, 'ai', today);
        if (rowNow && current.idx != null) {
          const itemsNow = parseScheduleItems(rowNow.items);
          if (itemsNow[current.idx] && !getScheduleItemReview(itemsNow[current.idx])) {
            itemsNow[current.idx] = {
              ...itemsNow[current.idx],
              thought: `聊天连贯：${spec.label}已结束`.slice(0, 80),
              execution: '',
            };
            db.prepare(`UPDATE schedules SET items=?, updated_at=datetime('now') WHERE id=?`)
              .run(JSON.stringify(itemsNow), rowNow.id);
          }
        }
      } catch {}
      lastPast = current;
      current = null;
      free = true;
      try {
        const refreshed = getScheduleRow(char.id, 'ai', today);
        if (refreshed) {
          const picked = pickScheduleContextForPrompt(refreshed.items, tz);
          if (!picked.current || getScheduleItemReview(picked.current)) {
            ({ current, next, lastPast, free } = {
              ...picked,
              current: picked.current && getScheduleItemReview(picked.current) ? null : picked.current,
              free: true,
              lastPast: picked.current && getScheduleItemReview(picked.current)
                ? picked.current
                : (picked.lastPast || lastPast),
            });
            if (!current) free = true;
          }
        }
      } catch {}
      break;
    }
  }

  const parts = [];
  const nowMins = getLocalMinutesSinceMidnight(new Date(), tz);
  const aiMsgs = (opts.recentHistory || [])
    .filter((m) => m.role === 'assistant' && m.type !== 'system')
    .slice(-28);
  const presence = inferRecentChatPresence(opts.recentHistory || []);
  const presenceConflict = schedulePresenceConflicts(presence, current, next, nowMins);
  const continuityLine = buildPresenceContinuityLine(presence, presenceConflict);
  if (continuityLine) parts.push(continuityLine);

  const lastPastAnnounced = !!(lastPast?.activity && (
    getScheduleItemReview(lastPast)
    || scheduleItemChatInProgress(lastPast)
    || inferScheduleItemChatStatus(lastPast.activity, aiMsgs) === 'left'
    || inferScheduleItemChatStatus(lastPast.activity, aiMsgs) === 'active'
  ));
  // 已经聊过/做过这一档：点名禁止再去，比只说「不要报刚做完」更管用
  if (lastPast && lastPast.activity && lastPastAnnounced) {
    parts.push(`上一档「${String(lastPast.activity).slice(0, 16)}」已结束，禁止再去做、禁止再说要去`);
  } else if (lastPast && lastPast.activity && !lastPastAnnounced) {
    parts.push('上一档已过点，现在空闲；不要再报「刚做完」');
  }
  if (current) {
    const place = sanitizeRegionPlace(current.place);
    const inProg = scheduleItemChatInProgress(current);
    const curLine = `当前：${current.time || ''} ${current.activity}${place ? `（在${place}）` : ''}`.replace(/\s+/g, ' ').trim();
    if (presenceConflict?.kind === 'teleport_current' && presence?.summary) {
      parts.push(annotateOwnSleepScheduleLine(`${curLine}（表上如此，但须从「${presence.summary}」过渡过来，禁止假装一直在这里）`, current.activity));
    } else {
      parts.push(annotateOwnSleepScheduleLine(inProg ? `${curLine}（聊天里已在做，勿再说要去）` : curLine, current.activity));
    }
  } else if (free || lastPastAnnounced) {
    if (presenceConflict?.kind === 'teleport_next_early' && presence?.summary) {
      parts.push(`空闲中（人还在「${presence.summary}」，下一项还没到点）`);
    } else {
      parts.push('空闲中（自由安排）');
    }
  }
  if (next) {
    const place = sanitizeRegionPlace(next.place);
    const nextLine = `下一项：${next.time || ''} ${next.activity}${place ? `（在${place}）` : ''}`.replace(/\s+/g, ' ').trim();
    if (presenceConflict?.kind === 'teleport_next_early') {
      parts.push(annotateOwnSleepScheduleLine(`${nextLine}（还早，禁止现在就说已经到了/已经在做）`, next.activity));
    } else {
      parts.push(annotateOwnSleepScheduleLine(nextLine, next.activity));
    }
  }

  const relevantUser = userRow
    ? pickRelevantUserScheduleItems(userRow.items, tz, userMessage)
    : [];
  const userText = relevantUser.length ? formatScheduleItemsForPrompt(relevantUser) : '';

  const currentAct = String(current?.activity || '');
  const awayNow = activityLooksAwayFromHome(currentAct) && presenceConflict?.kind !== 'teleport_current';
  const homeEnv = resolveCharacterHomeEnvironment(char);
  if (awayNow) {
    parts.push('此刻不在家，所见所感跟当前这项走，不要写家里窗景/客厅');
  } else if (presenceConflict?.kind === 'teleport_next_early' && homeEnv) {
    parts.push(`居所：${homeEnv}（还在刚才聊天的位置附近时按这里，禁止普通居民楼/老旧小区）`);
  } else if (homeEnv) {
    parts.push(`居所：${homeEnv}（在家时必须是这里，禁止普通居民楼/老旧小区）`);
  }

  let moodFoot = '';
  try {
    const es = getDecayedEmotionState(char);
    moodFoot = emotionHelper.getScheduleMoodFootnote(char, es);
  } catch {}
  if (moodFoot) parts.push(moodFoot);
  try {
    // 未来去向锁要进聊天，避免「明天去哪」现编；生活补全文不进此刻块
    const lock = require('./life-fill-helper').promptLockLine(char.id, today);
    if (lock) parts.push(lock);
  } catch { /* ignore */ }

  const charSchedule = parts.length
    ? `【此刻·${char.name}】${parts.join('；')}。${SCHEDULE_CONTEXT_GUIDE}`
    : SCHEDULE_CONTEXT_GUIDE;

  return {
    charSchedule,
    userSchedule: userText
      ? `【用户今日安排·相关】${userText}\n（仅背景；禁止按钟点提醒用户、禁止复读全文）`
      : '',
  };
}

const CHAR_OWN_SLEEP_RE = /睡觉|入睡|过夜|就寝|午睡|小憩|眯一会|打盹|陪睡|补觉|睡着|去睡|上床|通宵|还醒着|很晚才睡|熬到天亮/;

function annotateOwnSleepScheduleLine(line, activity) {
  if (!CHAR_OWN_SLEEP_RE.test(String(activity || ''))) return line;
  return `${line}（这是你自己的作息，不是对方该睡的信号）`;
}

const AWAY_FROM_HOME_RE = /出门|外出|外面|逛街|办事|采购|散步|港区|旧港|码头|渔港|海边|沙滩|海岸|海滨|出差|上班|加班|公司|办公室|通勤|路上|地铁|商场|店里|公园|博物馆|电影院|餐厅|咖啡|约会|拜访|外勤|机场|车站|医院|学校|大学|图书馆|夜市|市集|古镇|景区|展会|开会|会议|培训|上课|健身|跑步|游泳|球场|买菜|理发|见客户|客户|聚餐|堂食|民宿|客栈|青旅|避暑|度假|旅行|旅游|温泉|露营/;
const AT_HOME_RE = /在家|家里|居家|别墅|豪宅|客厅|卧室|书房|厨房|阳台|露台|天台|午睡|睡觉|洗漱|护肤|做饭|下厨|看剧|宅家/;
const HEADING_HOME_RE = /回家|到家|回窝|返家|回程|返程/;

function activityLooksAwayFromHome(activity) {
  return AWAY_FROM_HOME_RE.test(String(activity || ''));
}

function activityLooksAtHome(activity) {
  const a = String(activity || '');
  if (!a) return false;
  if (activityLooksAwayFromHome(a)) return false;
  return AT_HOME_RE.test(a) || HEADING_HOME_RE.test(a);
}

/** 行程项是否算「人在外面」（文案或地点相对常住地） */
function scheduleItemLooksAway(item, homeSpoken = '') {
  if (!item) return false;
  const act = String(item.activity || item.title || '').trim();
  if (activityLooksAtHome(act)) return false;
  if (activityLooksAwayFromHome(act)) return true;
  const place = sanitizeRegionPlace(item.place) || extractPlaceFromText(act);
  if (place && homeSpoken && placesDiffer(place, homeSpoken)) return true;
  return false;
}

/**
 * 出门估时结束后的空档：人还在外面，直到当前档变成「在家/回家」。
 * 避免「上一档上班已过点 → 默认当成在家」。
 */
function resolvePlaceModeFromSchedule(picked, homeSpoken = '') {
  const current = picked?.current || null;
  const lastPast = picked?.lastPast || null;
  const currentAct = String(current?.activity || '').trim();

  if (current) {
    if (scheduleItemLooksAway(current, homeSpoken) || activityLooksAwayFromHome(currentAct)) {
      return { placeMode: 'away', locationItem: current, awayOngoing: false };
    }
    if (activityLooksAtHome(currentAct)) {
      return { placeMode: 'home', locationItem: current, awayOngoing: false };
    }
    return { placeMode: 'activity', locationItem: current, awayOngoing: false };
  }

  if (lastPast && scheduleItemLooksAway(lastPast, homeSpoken)) {
    return { placeMode: 'away', locationItem: lastPast, awayOngoing: true };
  }
  return { placeMode: 'home', locationItem: null, awayOngoing: false };
}

/** 随手记 / 朋友圈：此刻钟点 + 当前日程地点，禁止提前写下午、禁止默认家里 */
function getHereAndNowContext(char, settings) {
  const tz = char.timezone || settings.timezone || 'Asia/Shanghai';
  const clock = getTimeInZone(new Date(), tz);
  const today = getLocalDateStr(new Date(), tz);
  try { reconcileScheduleWithRecentChat(char.id); } catch {}
  const charRow = getScheduleRow(char.id, 'ai', today);
  const picked = charRow
    ? pickScheduleContextForPrompt(charRow.items, tz)
    : { current: null, next: null, lastPast: null, free: false };

  const homeEnv = resolveCharacterHomeEnvironment(char) || '';
  const homeSpoken = sanitizeRegionPlace(spokenCharLocation(char) || '')
    || sanitizeRegionPlace(char.location_name || '')
    || '';
  const currentAct = String(picked.current?.activity || '').trim();
  const nextAct = String(picked.next?.activity || '').trim();
  const lastAct = String(picked.lastPast?.activity || '').trim();
  const placeInfo = resolvePlaceModeFromSchedule(picked, homeSpoken);
  let placeMode = placeInfo.placeMode;
  const locationItem = placeInfo.locationItem;
  const locationAct = String(locationItem?.activity || '').trim();
  let weekPlace = '';
  let presentLoc = '';
  try {
    const st = resolveCharacterLocationState(char, today);
    presentLoc = String(st.present || '').trim();
    if (st.away && placeMode === 'home') placeMode = 'away';
  } catch { /* ignore */ }
  try {
    const week = parseWeekSchedulePlan(char.schedule_week_plan);
    weekPlace = weekDayPlace(getWeekDayPlan(week, today));
  } catch { /* ignore */ }
  const away = placeMode === 'away' || !!(presentLoc && homeSpoken && placesDiffer(presentLoc, homeSpoken));

  const lines = [];
  lines.push(`【此刻时间】现在是 ${clock.str} ${clock.week}。只写已经发生或正在发生的事。禁止把今天下午/晚上还没到点的安排写成正在做或已经做完。`);
  if (nextAct && picked.next?.time) {
    lines.push(`下一项尚未开始（最多一句「待会要…」，禁止当正在经历）：${picked.next.time} ${nextAct}`);
  }
  if (lastAct && picked.lastPast?.time && !getScheduleItemReview(picked.lastPast)) {
    lines.push(`上一档已过点，现在空闲。禁止写成正在「${lastAct}」，也不要再写一遍刚做完。`);
  }
  if (away) {
    if (placeInfo.awayOngoing && placeMode === 'away') {
      lines.push(`【此刻地点】你还在外面（上一档「${picked.lastPast?.time || ''} ${lastAct}」已过点，但还没到回家/在家那一档）。随手记和朋友圈写外面见闻，禁止写成已经在家客厅/卧室。配图必须是外出地点。`);
    } else if (placeMode === 'away') {
      lines.push(`【此刻地点】你不在家，正在「${picked.current?.time || ''} ${currentAct}」。随手记和朋友圈必须写这里的见闻，禁止写成家里客厅/卧室/居民楼窗景。配图必须是这个外出地点。`);
    } else {
      lines.push(`【此刻地点】你人在「${presentLoc || '外地'}」，不在常住地。正文和配图按这里，禁止写成常住地家里。`);
    }
  } else if (placeMode === 'activity') {
    lines.push(`【此刻在做】${picked.current.time || ''} ${currentAct}。正文和配图跟这件事、这个场景走，不要默认切回家里。`);
    if (homeEnv) lines.push(`（你的家是：${homeEnv}。只有确实在家时才用这个背景。）`);
  } else if (homeEnv) {
    lines.push(`【此刻地点】你在自己住的地方。居所：${homeEnv}。写家里、拍家里必须按这个来，严禁普通居民楼、老旧小区、水泥外墙廉价出租屋。`);
  } else if (currentAct) {
    lines.push(`【此刻】${picked.current.time || ''} ${currentAct}`);
  }

  let imageSceneHint = '';
  if (away) {
    imageSceneHint = `${locationAct || currentAct || lastAct || presentLoc || 'out of home'}, real on-location snapshot matching this outing, NOT apartment interior, NOT residential housing block`;
  } else if (placeMode === 'activity') {
    imageSceneHint = `${currentAct}, photorealistic location matching the activity, not a generic apartment`;
  } else if (homeEnv) {
    imageSceneHint = `${homeEnv}, must match this residence, ocean-view villa/sea-facing glass if described, FORBIDDEN: generic Chinese apartment block, old residential building, cramped cheap rental`;
  }

  // 朋友圈定位：跟日程推出来的此刻所在地
  let locationLabel = '';
  if (away || placeMode === 'activity') {
    locationLabel = String(
      presentLoc
      || sanitizeRegionPlace(locationItem?.place)
      || extractPlaceFromText(locationAct || currentAct || '')
      || (weekPlace && placesDiffer(weekPlace, homeSpoken) ? weekPlace : '')
      || ''
    ).slice(0, 16);
  }

  return {
    clockStr: `${clock.str} ${clock.week}`,
    current: picked.current,
    next: picked.next,
    lastPast: picked.lastPast,
    locationItem,
    awayOngoing: !!placeInfo.awayOngoing,
    homeEnv,
    placeMode,
    promptBlock: lines.join('\n'),
    imageSceneHint,
    locationLabel,
  };
}

function parseScheduleJsonArray(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : [];
  } catch {}
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  return [];
}

/** 按角色气质 + 日期种子，给出本日大致起床/开工参考时刻（仍禁止 00:00–04:59） */
function pickScheduleWakeHint(char, dateStr) {
  const seed = hashDaySeed(char.id, `${dateStr}-wake`);
  const blob = `${char.personality || ''} ${char.background || ''} ${char.behavior || ''} ${char.intro || ''} ${char.description || ''}`;
  const nightOwl = /夜猫|熬夜|夜间|昼夜颠倒|晚睡|夜班|酒吧|驻唱|主播|直播|DJ|通宵/.test(blob);
  const earlyBird = /早起|晨跑|军人|军旅|晨练|早班|朝五|六点起|健身教练/.test(blob);
  let minH = 6;
  let maxH = 10;
  if (nightOwl) { minH = 9; maxH = 13; }
  else if (earlyBird) { minH = 5; maxH = 8; }
  const span = Math.max(30, (maxH - minH) * 60);
  let mins = minH * 60 + (seed % span);
  mins = Math.max(5 * 60, Math.round(mins / 15) * 15); // 对齐一刻钟，且不低于 05:00
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatScheduleHm(mins) {
  const m = ((Math.round(Number(mins) / 15) * 15) % (24 * 60) + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 主睡眠（非整段午睡） */
function activityLooksLikeMainSleep(activity) {
  const a = String(activity || '');
  if (!a) return false;
  if (/午休|午睡|小憩|眯一会|眯一会儿|打盹|休息一会|休息一会儿/.test(a)) return false;
  return /睡觉|入睡|过夜|就寝|睡懒觉|补觉|睡着|去睡|陪睡|上床睡|躺下睡/.test(a);
}

/** 通宵 / 今晚明确不睡（含「熬到天亮」——常被写在次日清晨，当天也要有结论） */
function activityLooksLikeAllNighter(activity) {
  return /通宵|彻夜|一夜没睡|一夜未睡|今晚不睡|不睡了|熬夜(?:未|没|不)?睡|通宵(?:未|没)睡|通宵加班|通宵赶|熬(?:夜)?到天亮|熬到天亮|一夜到天亮|通宵到天亮/.test(String(activity || ''));
}

/** 含糊「像要睡但没写睡觉」——生成后要改成明确睡眠点 */
function activityLooksLikeVagueBedtime(activity) {
  const a = String(activity || '');
  if (!a || activityLooksLikeMainSleep(a) || activityLooksLikeAllNighter(a)) return false;
  return /闭眼|闭上眼睛|构思|躺着想|躺床|窝在床|钻进被窝|准备睡|洗漱完|关灯|熄灯|赖在床/.test(a);
}

/** 当天夜里可见的「睡没睡」结论（须落在 21:00–23:59，不能只写在次日凌晨） */
function activityLooksLikeNightSleepConclusion(activity) {
  const a = String(activity || '');
  if (!a) return false;
  if (activityLooksLikeAllNighter(a)) return true;
  if (activityLooksLikeMainSleep(a)) return true;
  return /今夜.{0,8}(?:不睡|通宵|很晚|凌晨|半夜)|还醒着|熬夜中|会熬到|准备熬到/.test(a);
}

function isSameDayNightSlot(time) {
  const m = timeToMinutes(time);
  return m != null && m >= 21 * 60 && m < 24 * 60;
}

function pickSameDayNightTime(preferred, list) {
  const pref = timeToMinutes(preferred);
  if (pref != null && pref >= 21 * 60 && pref < 24 * 60) return formatScheduleHm(pref);
  let latest = 22 * 60 + 30;
  for (const it of list || []) {
    const m = timeToMinutes(it?.time);
    if (m != null && m >= 18 * 60 && m < 24 * 60) latest = Math.max(latest, m + 30);
  }
  return formatScheduleHm(Math.min(23 * 60 + 45, latest));
}

/**
 * 本日睡眠点：正常入睡 / 半夜才睡 / 通宵未睡。
 * 结论必须写在当天 21:00–23:59，方便当天行程里直接看到睡没睡；
 * 真正入睡若在凌晨，可另写 00:00–04:59（会归次日），但不能只靠次日条目。
 */
function pickScheduleSleepHint(char, dateStr, dayFlavor = '') {
  const seed = hashDaySeed(char.id, `${dateStr}-sleep`);
  // 用户明确要求且角色已答应的作息约束：压过随机通宵
  try {
    const sleepPromise = require('./char-promise-helper').activeSleepConstraint(char.id);
    if (sleepPromise) {
      const blob = `${char.personality || ''} ${char.behavior || ''}`;
      const earlyBird = /早起|晨跑|军人|军旅|晨练|早班/.test(blob);
      let minM = earlyBird ? 21 * 60 : 22 * 60;
      let maxM = earlyBird ? 23 * 60 : 23 * 60 + 30;
      const span = Math.max(15, maxM - minM);
      const time = formatScheduleHm(minM + (seed % span));
      return {
        mode: 'normal',
        time,
        activity: '睡觉',
        sleepAt: '',
        promptLine: `约 ${time} 入睡（对方要求且你已答应：${String(sleepPromise.content || '').slice(0, 40)}）。必须正常睡觉，禁止通宵/熬到天亮/还醒着会很晚才睡`,
      };
    }
  } catch { /* ignore */ }
  const blob = `${char.personality || ''} ${char.background || ''} ${char.behavior || ''} ${char.intro || ''} ${char.description || ''}`;
  const nightOwl = /夜猫|熬夜|夜间|昼夜颠倒|晚睡|夜班|酒吧|驻唱|主播|直播|DJ|通宵/.test(blob);
  const earlyBird = /早起|晨跑|军人|军旅|晨练|早班|朝五|六点起|健身教练/.test(blob);
  const busyDay = /偏忙|加班|赶工|连轴|deadline/.test(String(dayFlavor || ''));
  const restDay = /休息|休假|睡懒觉/.test(String(dayFlavor || ''));

  let allNighterChance = nightOwl ? 10 : 3;
  let lateChance = nightOwl ? 28 : 12;
  if (busyDay) { allNighterChance += 12; lateChance += 10; }
  if (restDay) { allNighterChance = Math.max(0, allNighterChance - 8); lateChance = Math.max(4, lateChance - 8); }
  if (earlyBird) {
    allNighterChance = Math.min(allNighterChance, 2);
    lateChance = Math.min(lateChance, 8);
  }

  const roll = seed % 100;
  let mode = 'normal';
  if (roll < allNighterChance) mode = 'allnighter';
  else if (roll < allNighterChance + lateChance) mode = 'late';

  if (mode === 'allnighter') {
    const time = formatScheduleHm(22 * 60 + 30 + (seed % 90)); // 22:30–23:45
    return {
      mode,
      time,
      activity: '通宵未睡，熬到天亮',
      sleepAt: '',
      promptLine: `今夜通宵（参考从 ${time} 起仍醒着）。必须在当天 21:00–23:59 写明「通宵未睡/熬到天亮」；不要把结论只写在次日清晨，禁止含糊闭眼构思`,
    };
  }

  if (mode === 'late') {
    const evening = formatScheduleHm(22 * 60 + 45 + (seed % 60)); // 22:45–23:45
    const sleepAt = formatScheduleHm(30 + (seed % 225)); // 00:30–03:45 → 次日
    return {
      mode,
      time: evening,
      activity: '还醒着，会很晚才睡',
      sleepAt,
      promptLine: `今夜偏晚：当天 ${evening} 左右须写明「还醒着/会很晚才睡」（留在当天可见）；真正入睡可另写 ${sleepAt}（归次日）。禁止只在次日写睡觉，当天却用闭眼构思糊弄`,
    };
  }

  let minM = earlyBird ? 21 * 60 : 22 * 60;
  let maxM = earlyBird ? 23 * 60 : 23 * 60 + 45;
  if (nightOwl) { minM = 23 * 60; maxM = 23 * 60 + 50; }
  const span = Math.max(15, maxM - minM);
  const time = formatScheduleHm(minM + (seed % span));
  return {
    mode: 'normal',
    time,
    activity: '睡觉',
    sleepAt: '',
    promptLine: `约 ${time} 入睡，写在当天 21:00–23:59。activity 必须含「睡觉/入睡/就寝」，禁止只写「闭眼构思」「躺着想事」`,
  };
}

function upsertNightConclusionItem(list, time, activity) {
  const t = pickSameDayNightTime(time, list);
  const act = String(activity || '').slice(0, 48);
  // 优先改当天夜里含糊/末段条目，避免多一条又看不清
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isSameDayNightSlot(list[i].time) && !activityLooksLikeVagueBedtime(list[i].activity)) continue;
    const m = timeToMinutes(list[i].time);
    if (m != null && m < 18 * 60) continue;
    list[i] = {
      ...list[i],
      time: isSameDayNightSlot(list[i].time) ? list[i].time : t,
      activity: act,
    };
    return list;
  }
  list.push({
    time: t,
    activity: act,
    place: '',
    thought: '',
    execution: '',
  });
  return list;
}

/**
 * 生成后兜底：当天夜里必须能直接看出睡没睡（结论留在 21:00–23:59）。
 * 半夜才睡可另附凌晨入睡条（归次日），但不能替代当天结论。
 */
function ensureScheduleSleepPoint(items, sleepHint) {
  if (!sleepHint?.mode) return Array.isArray(items) ? items : [];
  let list = (Array.isArray(items) ? items : [])
    .map(normalizeScheduleItemShape)
    .filter((it) => it.activity);

  const hasSameDayConclusion = list.some(
    (it) => isSameDayNightSlot(it.time) && activityLooksLikeNightSleepConclusion(it.activity)
  );

  if (sleepHint.mode === 'allnighter') {
    if (!hasSameDayConclusion) {
      list = upsertNightConclusionItem(
        list,
        sleepHint.time,
        sleepHint.activity || '通宵未睡，熬到天亮'
      );
    } else {
      // 已有夜里条目但含糊 → 改成通宵结论
      for (let i = list.length - 1; i >= 0; i--) {
        if (!isSameDayNightSlot(list[i].time)) continue;
        if (activityLooksLikeAllNighter(list[i].activity)) break;
        if (activityLooksLikeVagueBedtime(list[i].activity) || activityLooksLikeMainSleep(list[i].activity)) {
          list[i] = { ...list[i], activity: '通宵未睡，熬到天亮' };
        }
        break;
      }
    }
    return sortScheduleItemsByTime(list);
  }

  if (sleepHint.mode === 'late') {
    if (!hasSameDayConclusion) {
      list = upsertNightConclusionItem(
        list,
        sleepHint.time,
        sleepHint.activity || '还醒着，会很晚才睡'
      );
    } else {
      for (let i = list.length - 1; i >= 0; i--) {
        if (!isSameDayNightSlot(list[i].time)) continue;
        if (activityLooksLikeVagueBedtime(list[i].activity)) {
          list[i] = { ...list[i], activity: '还醒着，会很晚才睡' };
        }
        break;
      }
    }
    // 真正入睡放在凌晨（归次日），当天仍留着「还醒着」
    const sleepAt = sleepHint.sleepAt || sleepHint.time;
    if (sleepAt && isWeeHoursTime(sleepAt)) {
      const hasWeeSleep = list.some(
        (it) => isWeeHoursTime(it.time) && activityLooksLikeMainSleep(it.activity)
      );
      if (!hasWeeSleep) {
        list.push({
          time: sleepAt,
          activity: '半夜才入睡',
          place: '',
          thought: '',
          execution: '',
        });
      }
    }
    return sortScheduleItemsByTime(list);
  }

  // normal：睡觉必须留在当天夜里，禁止只写到凌晨被挪走
  if (!hasSameDayConclusion) {
    list = upsertNightConclusionItem(list, sleepHint.time, sleepHint.activity || '睡觉');
  } else {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!isSameDayNightSlot(list[i].time)) continue;
      if (activityLooksLikeVagueBedtime(list[i].activity)) {
        list[i] = { ...list[i], activity: '睡觉' };
      }
      break;
    }
  }
  return sortScheduleItemsByTime(list);
}

/**
 * 次日清晨若写了「熬到天亮 / 半夜才睡」，反补昨天夜里结论，
 * 避免只能在第二天才看见昨晚睡没睡。
 */
function backfillYesterdayNightSleepConclusion(charId, today) {
  try {
    if (!charId || !today) return false;
    const yest = shiftLocalDateStr(today, -1);
    const todayRow = getScheduleRow(charId, 'ai', today);
    const todayItems = parseScheduleJsonArray(todayRow?.items);
    const morningClue = todayItems.find((it) => {
      const m = timeToMinutes(it.time);
      if (m == null || m >= 8 * 60) return false;
      const a = it.activity || '';
      return activityLooksLikeAllNighter(a)
        || /熬(?:夜)?到天亮|半夜才|凌晨才睡|通宵/.test(a)
        || (activityLooksLikeMainSleep(a) && (isWeeHoursTime(it.time) || /半夜|凌晨|很晚/.test(a)));
    });
    if (!morningClue) return false;

    const yestRow = getScheduleRow(charId, 'ai', yest);
    if (!yestRow) return false;
    let yestItems = parseScheduleJsonArray(yestRow.items).map(normalizeScheduleItemShape).filter((it) => it.activity);
    if (!yestItems.length) return false;

    const hasConclusion = yestItems.some(
      (it) => isSameDayNightSlot(it.time) && activityLooksLikeNightSleepConclusion(it.activity)
    );
    if (hasConclusion) return false;

    const clue = morningClue.activity || '';
    const activity = activityLooksLikeAllNighter(clue) || /熬(?:夜)?到天亮|通宵/.test(clue)
      ? '通宵未睡，熬到天亮'
      : '还醒着，会很晚才睡';

    yestItems = upsertNightConclusionItem(yestItems, '23:00', activity);
    // 去掉已变成结论的含糊「闭眼构思」重复感：若末段仍是含糊且不是刚写入的结论，改掉
    for (let i = yestItems.length - 1; i >= 0; i--) {
      if (!activityLooksLikeVagueBedtime(yestItems[i].activity)) continue;
      yestItems[i] = {
        ...yestItems[i],
        time: isSameDayNightSlot(yestItems[i].time) ? yestItems[i].time : '23:00',
        activity,
      };
      break;
    }
    yestItems = sortScheduleItemsByTime(yestItems);
    upsertScheduleItems(charId, 'ai', yest, yestItems, { generated: !!yestRow.generated });
    console.log(`[schedule] backfill night sleep char#${charId} ${yest} ← ${today}「${String(clue).slice(0, 20)}」→ ${activity}`);
    return true;
  } catch (e) {
    console.warn('[schedule] backfill night sleep', e.message);
    return false;
  }
}

/** 周一为周起点（本地日历日字符串） */
function getWeekStartMonday(dateStr) {
  const d = new Date(String(dateStr) + 'T12:00:00');
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function listWeekDates(weekStart) {
  return Array.from({ length: 7 }, (_, i) => shiftLocalDateStr(weekStart, i));
}

function parseWeekSchedulePlan(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === 'object' ? raw : JSON.parse(String(raw));
    if (!o || typeof o !== 'object' || !o.weekStart || !Array.isArray(o.days)) return null;
    return o;
  } catch {
    return null;
  }
}

function saveWeekSchedulePlan(charId, plan) {
  if (!charId) return;
  db.prepare('UPDATE characters SET schedule_week_plan=? WHERE id=?').run(
    plan ? JSON.stringify(plan) : '',
    charId
  );
}

function getWeekDayPlan(plan, dateStr) {
  if (!plan?.days?.length) return null;
  return plan.days.find(d => String(d.date) === String(dateStr)) || null;
}

const KNOWN_CITY_RE = /北京|上海|广州|深圳|杭州|南京|苏州|成都|重庆|武汉|西安|天津|长沙|郑州|青岛|大连|厦门|福州|合肥|济南|沈阳|哈尔滨|长春|昆明|南昌|太原|石家庄|贵阳|南宁|海口|三亚|兰州|银川|西宁|乌鲁木齐|拉萨|呼和浩特|香港|澳门|台北|宁波|无锡|佛山|东莞|珠海|中山|温州|嘉兴|金华|绍兴|台州|扬州|南通|常州|徐州|烟台|威海|洛阳|桂林|丽江|大理|黄山/;
const PLACE_STOP_RE = /常态|本地|日常|加班|休息|休假|社交|杂事|工作|学习|家里|在家|公司|办公室|路上|通勤|客户|同事|朋友|自己|对方|用户|角色|今天|明天|昨天|出发|返程|在外|酒店|出差|办事|外勤/;
/** 房间/居所/店名，不是城市地区 */
const ROOM_PLACE_RE = /厨房|客厅|卧室|书房|阳台|浴室|卫生间|洗手间|餐厅|玄关|露台|天台|房间|别墅|豪宅|公寓|民宿|客栈|青旅|旅馆|宾馆|农家乐|木屋|营地|帐篷/;
/** 做事/玩法短语，不能当地名（如「民宿避暑」） */
const ACTIVITY_PLACE_RE = /弄了|做了|吃了|看了|睡了|点了|准备|简单|一下|一会|一會兒|正在|开始|继续|然后|做饭|下厨|洗漱|避暑|度假|游玩|旅游|旅行|闲逛|逛街|购物|聚餐|吃饭|烧烤|露营|徒步|爬山|健身|跑步|游泳|泡澡|洗澡|午睡|睡觉|开会|上课|追剧|看电影|看展|演出|演唱会|剧本杀|密室|放松|疗养/;

function stripPlaceSuffix(s) {
  return String(s || '').replace(/[市县区省镇州]$/, '').trim().slice(0, 12);
}

function looksLikeRegionPlace(raw) {
  const compact = String(raw || '').replace(/\s+/g, '').trim();
  if (compact.length < 2 || compact.length > 12) return false;
  if (ROOM_PLACE_RE.test(compact)) return false;
  if (ACTIVITY_PLACE_RE.test(compact)) return false;
  if (PLACE_STOP_RE.test(compact)) return false;
  if (/[，。！？、；：,.!?;:（）()【】\[\]"'“”‘’]/.test(compact)) return false;
  if (/[了着过]/.test(compact)) return false;
  const knownHit = compact.match(KNOWN_CITY_RE);
  if (knownHit && (compact === knownHit[0] || compact === `${knownHit[0]}市`)) return true;
  const core = compact.replace(/[市县区省镇州城]$/, '');
  if (!/^[\u4e00-\u9fffA-Za-z·・]{2,8}$/.test(core)) return false;
  if (/的$/.test(core) && !/城$/.test(core)) return false;
  // 店名/玩法常被塞进 place：含「店|馆|屋|庄|园|寨」且不像「…城」地名时丢掉
  if (/[店馆屋庄园寨吧厅厦楼]$/.test(core) && !/城$/.test(core)) return false;
  return true;
}

function acceptRegionPlace(candidate) {
  const s = stripPlaceSuffix(candidate);
  return looksLikeRegionPlace(s) ? s.slice(0, 12) : '';
}

function extractPlaceFromText(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return '';
  const known = t.match(KNOWN_CITY_RE);
  if (known) return known[0];
  const labeled = t.match(/(?:地点|城市|目的地|所在)[:：·]([^\s，。,.]{2,10})/);
  if (labeled) {
    const v = acceptRegionPlace(labeled[1]);
    if (v) return v;
  }
  const dotted = t.match(/([\u4e00-\u9fffA-Za-z]{2,10})[·・](?:出发|在外|返程|出差)/);
  if (dotted) {
    const v = acceptRegionPlace(dotted[1]);
    if (v) return v;
  }
  const dotted2 = t.match(/(?:出差|出发|在外|返程)[·・]([\u4e00-\u9fffA-Za-z]{2,10})/);
  if (dotted2) {
    const v = acceptRegionPlace(dotted2[1]);
    if (v) return v;
  }
  const trip = t.match(/([\u4e00-\u9fffA-Za-z]{2,10})(?:市)?(?:出差|办事|外勤)/);
  if (trip) {
    const v = acceptRegionPlace(trip[1]);
    if (v) return v;
  }
  const dest = t.match(/(?:去|到|飞往|赴|前往|抵达|路过)([\u4e00-\u9fff]{2,8})(?:市|县)?/);
  if (dest) {
    const v = acceptRegionPlace(dest[1]);
    if (v) return v;
  }
  const atHotel = t.match(/在([\u4e00-\u9fff]{2,8})(?:市)?(?:酒店|机场|高铁站|火车站|会场)/);
  if (atHotel) {
    const v = acceptRegionPlace(atHotel[1]);
    if (v) return v;
  }
  return '';
}

/** 时间轴「地区」只接受城市/地区短名，丢掉房间名和做事短语 */
function sanitizeRegionPlace(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  const direct = acceptRegionPlace(t);
  if (direct) return direct;
  const known = t.match(KNOWN_CITY_RE);
  if (known) return known[0];
  return extractPlaceFromText(t);
}

const _presentLocCache = new Map();

function weekDayPlace(day) {
  if (!day) return '';
  return sanitizeRegionPlace(day.place)
    || extractPlaceFromText(`${day.theme || ''} ${day.note || ''}`);
}

function placesDiffer(a, b) {
  const x = stripPlaceSuffix(a);
  const y = stripPlaceSuffix(b);
  if (!x || !y) return !!x;
  return x !== y && !String(y).includes(x) && !String(x).includes(y);
}

/** 从单条行程抠城市（place 优先，否则从 activity 里认） */
function cityFromScheduleItem(it) {
  return sanitizeRegionPlace(it?.place) || extractPlaceFromText(it?.activity || '') || '';
}

/** 返程/回家类：做完后地区应回到常住 */
function scheduleItemLooksReturnHome(it, home) {
  const act = String(it?.activity || '');
  if (/返程|回家|回程|到家|返回常住/.test(act)) return true;
  const city = cityFromScheduleItem(it);
  if (home && city && !placesDiffer(city, home) && /回|返|抵达|到家/.test(act)) return true;
  return false;
}

/** 还在「去往途中」：出发/飞往等，做完才换地区 */
function scheduleItemLooksDepartingTravel(it) {
  const act = String(it?.activity || '');
  return /出发|飞往|赶往|前往|去往|启程|登机|坐车去|高铁去|火车去|开车去|动身/.test(act);
}

/**
 * 按日程时间线推此刻所在地：
 * - 默认常住城
 * - 做完「去某地 / 在某地」且写明城市 → 换成该城
 * - 做完返程/回家 → 换回常住
 * - 未写城市的行程不改口；跨天「已在外」的日子早上直接用周计划城市
 */
function resolvePresentLocationFromSchedule(home, items, day, tz) {
  let present = home || '';
  const weekPlace = weekDayPlace(day);
  const weekBlob = `${day?.theme || ''} ${day?.note || ''}`;
  const weekAway = !!(weekPlace && home && placesDiffer(weekPlace, home));
  const departDay = /出发|启程/.test(weekBlob) && !/在外|第[2-7二三四五六七]天/.test(weekBlob);

  // 跨天已在外地（非出发日）：一睁眼就在周计划城市；返程日白天仍先算在外，等返程项做完再回家
  if (weekAway && !departDay) {
    present = weekPlace;
  }

  const sorted = listScheduleItemsWithMeta(items);
  if (!sorted.length) {
    return {
      present,
      away: !!(present && home && placesDiffer(present, home)),
    };
  }

  const nowMins = getLocalMinutesSinceMidnight(new Date(), tz);
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    const start = it.mins;
    const end = scheduleSlotEndMinutes(sorted, i);
    if (start == null) continue;

    // 还没开始的未来项：不看
    if (nowMins < start) break;

    const finished = nowMins >= end;
    const city = cityFromScheduleItem(it);
    const returning = scheduleItemLooksReturnHome(it, home);
    const departing = scheduleItemLooksDepartingTravel(it);

    if (!finished) {
      // 进行中：去往途中 / 返程途中 → 做完才换；已在当地办事则立刻用该城
      if (returning || departing) break;
      if (city) present = city;
      break;
    }

    // 已做完：有返程就回家；有明确城市就落到该城；没写城市保持原状
    if (returning) {
      present = home || '';
      continue;
    }
    if (city) present = city;
  }

  // 返程日：返程项做完前保持外地；做完后上面循环已写回常住
  return {
    present,
    away: !!(present && home && placesDiffer(present, home)),
  };
}

/** 名片/提示用的此刻所在地：跟日程到达/返程事件走。不改库里的 location_name。 */
function resolveCharacterPresentLocation(char, dateStr) {
  return resolveCharacterLocationState(char, dateStr).present;
}

/** @returns {{ present: string, home: string, away: boolean }} */
function resolveCharacterLocationState(char, dateStr) {
  const home = sanitizeRegionPlace(spokenCharLocation(char))
    || sanitizeRegionPlace(char?.real_location || '')
    || '';
  if (!char?.id) return { present: home, home, away: false };
  const tz = char.timezone || 'Asia/Shanghai';
  const today = dateStr || getLocalDateStr(new Date(), tz);
  const cacheKey = `${char.id}|${today}`;
  const hit = _presentLocCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 8000) return hit.value;

  let present = home;
  let away = false;
  try {
    const week = parseWeekSchedulePlan(char.schedule_week_plan);
    const day = getWeekDayPlan(week, today);
    let items = [];
    try {
      const row = getScheduleRow(char.id, 'ai', today);
      items = parseScheduleItems(row?.items);
    } catch { /* 无库时仍可用周主题 */ }
    const resolved = resolvePresentLocationFromSchedule(home, items, day, tz);
    present = resolved.present || (resolved.away ? '' : home);
    away = !!resolved.away;
  } catch {
    present = home;
    away = false;
  }

  const value = { present, home, away };
  _presentLocCache.set(cacheKey, { at: Date.now(), value });
  if (_presentLocCache.size > 80) {
    const first = _presentLocCache.keys().next().value;
    _presentLocCache.delete(first);
  }
  return value;
}

function formatWeekPlanContinuity(plan, dateStr) {
  if (!plan) return '';
  const day = getWeekDayPlan(plan, dateStr);
  const idx = plan.days?.findIndex(d => String(d.date) === String(dateStr));
  const lines = [];
  if (plan.arc) lines.push(`本周主线：${String(plan.arc).slice(0, 120)}`);
  if (day?.theme) lines.push(`本日主题：${day.theme}${day.note ? `（${String(day.note).slice(0, 80)}）` : ''}`);
  if (idx > 0) {
    const prev = plan.days[idx - 1];
    if (prev?.theme) lines.push(`昨日主题：${prev.theme}${prev.note ? `／${String(prev.note).slice(0, 60)}` : ''}`);
  }
  if (idx >= 0 && idx < (plan.days?.length || 0) - 1) {
    const next = plan.days[idx + 1];
    if (next?.theme) lines.push(`明日主题预告：${next.theme}（今日须能自然接到明天，勿写成已经结束的跨天行程）`);
  }
  const tripish = /出差|异地|在外|酒店|返程|出发/.test(`${day?.theme || ''}${day?.note || ''}${plan.arc || ''}`);
  if (tripish) {
    lines.push('跨天外出：须承接地点与进度（第几天/是否已到/是否返程），禁止假装人还在家里日常闲逛，也禁止把多日出差压成「当天去当天回」。');
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * 生成本周日程骨架（主题/跨天出差），不写具体时段。
 * 解决「每天独立抽出差 → 隔天就回」的问题。
 */
async function buildWeekSchedulePlan(char, weekStart, settings) {
  const dates = listWeekDates(weekStart);
  const dateList = dates.map((d) => {
    const wd = new Intl.DateTimeFormat('zh-CN', {
      timeZone: settings.timezone || 'Asia/Shanghai',
      weekday: 'short',
    }).format(new Date(d + 'T12:00:00'));
    return `${d}（${wd}）`;
  }).join('、');
  const blob = `${char.personality || ''} ${char.background || ''} ${char.behavior || ''} ${char.intro || ''}`;
  const jobHint = /出差|外勤|销售|商务|律师|记者|空乘|飞行员|演艺|偶像|运动员|医生/
    .test(blob);

  const systemPrompt = buildSystemPrompt(char, settings,
    `请为${char.name}规划从 ${weekStart} 起的一周生活主线（只定每天主题，不要写具体钟点行程）。
要求：
- 覆盖这 7 天：${dateList}
- 多数天是本地日常/工作/休息，要有变化；不要七天同一套
- **若安排出差/异地**：必须跨至少 2 天（如出发日→在外日→可选返程日），写清地点与进度；**严禁「当天出差当天回」冒充出差**
- 短途外勤、办事、同城外出可以当天往返，不要硬拉成多日
- ${jobHint ? '此人工作较可能外出，本周可以有一次短途外勤或 2～4 天出差，但不是每周必出差' : '本周出差概率宜低；更常见本地日常，偶尔外出即可'}
- theme 用短中文（如「常态本地」「偏忙加班」「出差·出发」「出差·在外」「返程」「休息日」）
- note 写承接要点（地点、第几天、是否返程），没有跨天则短句即可
- 若当天不在常住地，days[].place 只写所在城市/地区短名（2～8字）；在家则 place 为 ""。禁止写房间名或做事短语
- arc 用一句话概括本周主线
只输出 JSON：{"arc":"…","days":[{"date":"YYYY-MM-DD","theme":"…","note":"…","place":""}]}`
  );

  const raw = await callChatAPI(
    settings,
    systemPrompt,
    `请生成 ${weekStart} 起一周的主题规划 JSON`,
    'diary'
  );
  let parsed = null;
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch {
    parsed = null;
  }
  const byDate = new Map();
  for (const d of (parsed?.days || [])) {
    if (d?.date && dates.includes(String(d.date))) {
      byDate.set(String(d.date), {
        date: String(d.date),
        theme: String(d.theme || '常态本地').slice(0, 40),
        note: String(d.note || '').slice(0, 120),
        place: (sanitizeRegionPlace(d.place) || extractPlaceFromText(`${d.theme || ''} ${d.note || ''}`) || '').slice(0, 16),
      });
    }
  }
  const days = dates.map((date) => byDate.get(date) || {
    date,
    theme: '常态本地',
    note: '贴合性格的日常，细节自定',
    place: '',
  });
  return {
    weekStart,
    arc: String(parsed?.arc || '本周以日常为主').slice(0, 160),
    days,
    updatedAt: new Date().toISOString(),
  };
}

async function ensureWeekSchedulePlan(charId, dateStr, opts = {}) {
  const force = opts.force === true;
  const settings = opts.settings || getSettings();
  const char = opts.char || db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return null;
  const weekStart = getWeekStartMonday(dateStr);
  let plan = parseWeekSchedulePlan(char.schedule_week_plan);
  if (!force && plan?.weekStart === weekStart && Array.isArray(plan.days) && plan.days.length >= 7) {
    return plan;
  }
  try {
    plan = await buildWeekSchedulePlan(char, weekStart, settings);
    saveWeekSchedulePlan(charId, plan);
    console.log(`[cron] week plan char#${charId} week=${weekStart} arc=${String(plan.arc).slice(0, 40)}`);
    return plan;
  } catch (e) {
    console.warn('[cron] week plan', e.message);
    const fallback = {
      weekStart,
      arc: '本周以日常为主',
      days: listWeekDates(weekStart).map((date) => ({
        date,
        theme: '常态本地',
        note: '',
        place: '',
      })),
      updatedAt: new Date().toISOString(),
    };
    saveWeekSchedulePlan(charId, fallback);
    return fallback;
  }
}

/** 本日行程风格：优先用本周规划主题；否则回退随机日风格 */
function pickScheduleDayFlavor(char, dateStr, weekPlan = null) {
  const day = getWeekDayPlan(weekPlan || parseWeekSchedulePlan(char?.schedule_week_plan), dateStr);
  if (day?.theme) {
    const note = day.note ? `；${day.note}` : '';
    return `${day.theme}${note}（来自本周规划，须与前后天主题连贯）`;
  }
  const seed = hashDaySeed(char.id, `${dateStr}-flavor`);
  const blob = `${char.personality || ''} ${char.background || ''} ${char.behavior || ''} ${char.intro || ''}`;
  const jobHint = /出差|外勤|销售|商务|律师|记者|空乘|飞行员|司机|快递员|外卖|演艺|偶像|运动员|医生|手术/
    .test(blob);
  const flavors = [
    { w: jobHint ? 42 : 52, text: '常态本地日：工作/学习/家务等日常，细节要有变化，不要复制昨天' },
    { w: 14, text: '偏忙日：加班、赶工、连轴会议或赶 deadline，节奏更紧' },
    { w: jobHint ? 14 : 10, text: '外出/外勤日：见客户、办事、采购、短途往返，白天多在外面（可当天回）' },
    { w: jobHint ? 4 : 2, text: '出差/异地日：若写出差须按多日行程来，今天只写其中一天（出发或在外或返程），禁止当天去当天回冒充出差' },
    { w: 10, text: '休息/休假日：睡懒觉、逛街、宅家、兴趣爱好，少安排正职工作' },
    { w: 8, text: '社交日：朋友/同事聚会、家庭事、饭局相关安排' },
    { w: 6, text: '杂事日：看病、办证、维修、大扫除、搬家收拾等' },
  ];
  const total = flavors.reduce((s, f) => s + f.w, 0);
  let r = seed % total;
  for (const f of flavors) {
    r -= f.w;
    if (r < 0) return f.text;
  }
  return flavors[0].text;
}

function recentScheduleContinuityHint(charId, today, weekPlan = null) {
  try {
    const bits = [];
    const weekBit = formatWeekPlanContinuity(weekPlan, today);
    if (weekBit) bits.push(weekBit);
    const yest = shiftLocalDateStr(today, -1);
    const row = getScheduleRow(charId, 'ai', yest);
    const yestItems = parseScheduleJsonArray(row?.items);
    const items = yestItems.slice(-3);
    if (items.length) {
      const brief = items.map((it) => `${it.time || ''}${it.activity || ''}`).join('；').slice(0, 160);
      bits.push(`昨日末段行程参考（须承接跨天状态，可反差细节，勿原样复制）：${brief}`);
    }
    const yestAllNighter = yestItems.some((it) => activityLooksLikeAllNighter(it.activity));
    const yestLateSleep = yestItems.some((it) =>
      activityLooksLikeMainSleep(it.activity) && (/半夜|凌晨|很晚/.test(it.activity) || isWeeHoursTime(it.time))
    );
    // 今日凌晨从昨日溢出的入睡也算「昨夜很晚才睡」
    const todayRow = getScheduleRow(charId, 'ai', today);
    const todayEarly = parseScheduleJsonArray(todayRow?.items).filter((it) => isWeeHoursTime(it.time));
    const overflowLateSleep = todayEarly.some((it) => activityLooksLikeMainSleep(it.activity));
    if (yestAllNighter) {
      bits.push('昨夜行程写明通宵未睡：今日起床/开工应偏晚，可安排补觉；不要假装昨夜正常睡过');
    } else if (yestLateSleep || overflowLateSleep) {
      bits.push('昨夜/凌晨才睡：今日可睡懒觉或状态偏困，起床参考可推后');
    }
    return bits.join('\n');
  } catch {
    return '';
  }
}

async function generateDailySchedule(charId, dateStr = null, opts = {}) {
  const force = opts.force === true;
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return null;
  // 角色关闭日程时不自动/不生成（强制手动也不开，避免关了还被补齐）
  if (Number(char.schedule_enabled) === 0) {
    console.log(`[cron] schedule skip char#${charId}: schedule_enabled=0`);
    return null;
  }

  const tz = settings.timezone || 'Asia/Shanghai';
  const today = dateStr || getLocalDateStr(new Date(), tz);
  // 次日清晨写了熬到天亮等 → 反补昨天夜里结论，当天行程能直接看见睡没睡
  try { backfillYesterdayNightSleepConclusion(charId, today); } catch {}
  const existing = getScheduleRow(charId, 'ai', today);
  const existingItems = parseScheduleJsonArray(existing?.items);
  // 仅当已有足够白天时段时才跳过；只有凌晨残条（从昨日溢出）必须重生成
  if (existing?.generated && scheduleLooksComplete(existingItems) && !force) {
    try {
      await require('./life-fill-helper').fillDayLife(charId, today, { char, settings, onlyIfEmpty: true });
    } catch (e) {
      console.warn('[life-fill] existing', e.message);
    }
    return { id: existing.id, items: existingItems, generated: true };
  }

  const userSchedule = getScheduleRow(null, 'user', today);
  const userPlan = userSchedule ? formatScheduleItemsForPrompt(userSchedule.items) : '';

  let weekPlan = null;
  try {
    weekPlan = await ensureWeekSchedulePlan(charId, today, {
      settings,
      char,
      force: opts.forceWeekPlan === true,
    });
  } catch (e) {
    console.warn('[cron] week plan ensure', e.message);
  }

  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, weekday: 'long' }).format(new Date(today + 'T12:00:00'));
  let lifeCarry = '';
  let lifeLock = '';
  let promiseLock = '';
  try {
    const lifeFill = require('./life-fill-helper');
    lifeCarry = lifeFill.carryoverForSchedule(char, today);
    lifeLock = lifeFill.promptLockLine(charId, today);
  } catch { /* ignore */ }
  try {
    promiseLock = require('./char-promise-helper').formatForSchedule(charId);
  } catch { /* ignore */ }
  const wakeHint = pickScheduleWakeHint(char, today);
  const dayFlavor = pickScheduleDayFlavor(char, today, weekPlan);
  const sleepHint = pickScheduleSleepHint(char, today, dayFlavor);
  const continuity = recentScheduleContinuityHint(charId, today, weekPlan);

  const systemPrompt = buildSystemPrompt(char, settings,
    `请为${char.name}规划 ${today}（${weekday}）的一天行程，输出 JSON 数组。
要求：
- 4～7 个时段，time 用 24 小时制 HH:MM；
- **起床/开工参考约 ${wakeHint}**（可前后浮动约 30～60 分钟），按性格与本日风格自定，不要天天都写 05:00；
- **睡眠点（必写明，且留在当天夜里）**：${sleepHint.promptLine}
- 00:00–04:59 默认属次日账本；半夜才睡可另写凌晨入睡条。但「通宵/很晚才睡/已睡」的结论必须出现在当天 21:00–23:59，不能只写在次日清晨；
- 【本日风格】${dayFlavor}
- 行程落在**本周规划**里：前后天主题要连贯；出差/异地只写「这一天」该有的进度，禁止当天去当天回冒充多日出差；同城外勤可以当天往返
- activity 写具体计划，必须具体到这段在做什么，不要只写「工作」「休息」「学习」这种空名；允许并应当偶尔出现出差、外勤、短途、加班、休假、社交等，不要永远「起床→上班→吃饭→睡觉」；
- time 是该项**开始**时刻；系统会按事项常理估算时长，做完后到下一项之间视为空闲，无需把空隙填满；
- activity 只写**当下/接下来要做的具体事**，禁止出现「做完XX后」「泡完澡」「结束后」「搞定XX」「收尾」「收拾完」等衔接/收尾语；下一项不要带前一项的结束描述，避免与前一项的结束动作重复；
- thought、execution 一律留空字符串 ""（时段结束后再根据聊天生成回顾，生成时不要写）；
- place 只写城市或地区短名（2～8字，如「杭州」「上海」或角色常住化名）。**去外地/出差/抵达某城时 place 必须写目的地城市**；返程/回家写常住城市或「」后由系统回常住。在家或同城日常可留空或写常住城市。禁止写房间（厨房/客厅/卧室）、路名店名，禁止写做事短语（如「民宿避暑」）；
- 尊重角色作息（昼夜颠倒则主活动偏晚）；睡眠/通宵状态必须写清楚，供连麦陪睡等识别；
${continuity ? `- ${continuity}` : ''}
${lifeCarry ? `${lifeCarry}\n` : ''}${lifeLock ? `- ${lifeLock}\n` : ''}${promiseLock ? `- ${promiseLock}\n` : ''}${userPlan ? `- 用户今日安排：${userPlan}，可在合适时段安排与用户相关或错开的活动；行程仅供角色自身生活参考，不要规划「提醒用户睡觉/下班」类活动。` : ''}
${isNaturalChat(char, settings) ? '- 禁止生成任何「提醒用户」类行程（催睡、催下班、催吃饭等）。' : ''}
格式：[{"time":"10:00","activity":"…","place":"","thought":"","execution":""}]
只输出 JSON 数组。`
  );

  try {
    const raw = await callChatAPI(settings, systemPrompt, `请生成 ${today} 的行程`, 'diary');
    let items = parseScheduleJsonArray(raw);
    if (!items.length) {
      const raw2 = await callChatAPI(settings, systemPrompt, `请生成 ${today} 的行程`, 'chat');
      items = parseScheduleJsonArray(raw2);
    }
    if (!items.length) return null;

    const weekDay = getWeekDayPlan(weekPlan || parseWeekSchedulePlan(char.schedule_week_plan), today);
    const fallbackPlace = weekDayPlace(weekDay);
    let lockedPlace = '';
    try { lockedPlace = require('./life-fill-helper').lockedPlaceForDate(charId, today); } catch { /* ignore */ }
    items = items.map(it => {
      const activity = String(it.activity || it.title || '').trim();
      const place = sanitizeRegionPlace(it.place)
        || extractPlaceFromText(activity)
        || fallbackPlace
        || '';
      return {
        time: String(it.time || '').trim(),
        activity,
        place: (lockedPlace && !/回家|返程|到家|在家/.test(activity) ? lockedPlace : place).slice(0, 16),
        thought: '',
        execution: '',
      };
    }).filter(it => it.activity);
    try { require('./life-fill-helper').captureTomorrowFromItems(charId, today, items); } catch { /* ignore */ }

    // 睡眠点兜底（通宵/半夜/正常入睡都要写明），再把凌晨条归次日
    items = ensureScheduleSleepPoint(items, sleepHint);
    items = rehomeWeeHoursScheduleItems(charId, 'ai', today, items, { generated: true });
    if (!scheduleLooksComplete(items)) {
      // 生成结果几乎全是凌晨 → 被挪到明天，今日变空/残缺：清掉失败标记并允许重试一次
      if (existing) {
        db.prepare(`UPDATE schedules SET items=?, generated=0, updated_at=datetime('now') WHERE id=?`)
          .run(JSON.stringify(items), existing.id);
      } else if (items.length) {
        db.prepare(
          `INSERT INTO schedules (character_id, role, date, items, generated) VALUES (?,?,?,?,0)`
        ).run(charId, 'ai', today, JSON.stringify(items));
      }
      console.warn(`[cron] schedule char#${charId} date=${today} 白天时段不足（${countDaytimeScheduleItems(items)}），未标记为已生成`);
      if (!opts._retriedEmpty) {
        console.log(`[cron] schedule char#${charId} date=${today} 立即重试生成…`);
        return generateDailySchedule(charId, today, { ...opts, force: true, _retriedEmpty: true });
      }
      return null;
    }

    const json = JSON.stringify(items);
    let savedId;
    if (existing) {
      db.prepare(`UPDATE schedules SET items=?, generated=1, updated_at=datetime('now') WHERE id=?`).run(json, existing.id);
      savedId = existing.id;
      console.log(`[cron] schedule char#${charId} date=${today} items=${items.length} flavor=${dayFlavor.slice(0, 12)} wake~${wakeHint} sleep=${sleepHint.mode}@${sleepHint.time} (updated)`);
    } else {
      const r = db.prepare(
        `INSERT INTO schedules (character_id, role, date, items, generated) VALUES (?,?,?,?,1)`
      ).run(charId, 'ai', today, json);
      savedId = r.lastInsertRowid;
      console.log(`[cron] schedule char#${charId} date=${today} items=${items.length} flavor=${dayFlavor.slice(0, 12)} wake~${wakeHint} sleep=${sleepHint.mode}@${sleepHint.time}`);
    }
    try {
      const { generateDailyOutfitsForChar } = require('./wardrobe-helper');
      await generateDailyOutfitsForChar(charId, today).catch((e) => console.warn('[cron] outfit', e.message));
    } catch {}
    try {
      await require('./life-fill-helper').fillDayLife(charId, today, { char, settings });
    } catch (e) {
      console.warn('[life-fill]', e.message);
    }
    return { id: savedId, items };
  } catch (e) {
    console.error('[cron] schedule gen error', e.message);
    notifyBillingError('日程生成', e.message, { characterId: charId });
    return null;
  }
}

async function generateWeeklySchedules(charId, dateStr = null, opts = {}) {
  const force = opts.force === true;
  const forceWeekPlan = opts.forceWeekPlan === true || force;
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return null;
  if (Number(char.schedule_enabled) === 0) {
    console.log(`[cron] week schedule skip char#${charId}: schedule_enabled=0`);
    return null;
  }
  const tz = settings.timezone || 'Asia/Shanghai';
  const anchor = dateStr || getLocalDateStr(new Date(), tz);
  const weekStart = getWeekStartMonday(anchor);
  const weekDates = listWeekDates(weekStart);
  const today = getLocalDateStr(new Date(), tz);

  const plan = await ensureWeekSchedulePlan(charId, anchor, {
    settings,
    char,
    force: forceWeekPlan,
  });

  // 默认补全「今天起至周末」；强制时仍只刷未过去的天，避免改写历史回顾
  const targets = weekDates.filter((d) => d >= today);
  // 若锚点是未来某天（手动选日期），也至少生成那一天
  if (anchor >= today && !targets.includes(anchor)) targets.push(anchor);
  targets.sort();

  const results = [];
  for (const d of targets) {
    const row = getScheduleRow(charId, 'ai', d);
    const items = parseScheduleJsonArray(row?.items);
    if (!force && row?.generated && scheduleLooksComplete(items)) {
      results.push({ date: d, items, skipped: true });
      continue;
    }
    const r = await generateDailySchedule(charId, d, {
      force: force || !scheduleLooksComplete(items),
      forceWeekPlan: false, // 周规划已在上面 ensure
      _weekPlanReady: true,
    }).catch((e) => {
      console.error(`[cron] week day schedule char#${charId} ${d}`, e.message);
      return null;
    });
    if (r?.items) results.push({ date: d, items: r.items, id: r.id });
  }
  return { weekStart, plan, days: results };
}

async function generateAllDailySchedules() {
  const chars = db.prepare('SELECT id FROM characters WHERE COALESCE(schedule_enabled,1)=1').all();
  for (const c of chars) {
    await generateWeeklySchedules(c.id).catch(e => console.error('[cron] week schedule', e.message));
  }
}

/* ─── 情景记忆 ─── */
function parseKeywords(val) {
  if (Array.isArray(val)) return val.filter(Boolean).map(String);
  try { return JSON.parse(val || '[]'); } catch { return []; }
}

function expandAssociatedMemories(selected, allMem, ctx) {
  const seen = new Set(selected.map(m => m.id));
  const keywords = new Set();
  for (const m of selected) {
    parseKeywords(m.keywords).forEach(k => keywords.add(k));
    extractMemoryMatchTerms(m.content).forEach(k => keywords.add(k));
  }
  const expanded = [...selected];
  for (const m of allMem) {
    if (seen.has(m.id)) continue;
    const memKws = [...parseKeywords(m.keywords), ...extractMemoryMatchTerms(m.content)];
    if (memKws.some(k => k.length >= 2 && keywords.has(k))) {
      seen.add(m.id);
      expanded.push(m);
      if (expanded.length >= 10) break;
    }
  }
  return expanded;
}

const DREAM_NARRATIVE_SUFFIX = '⑦这是梦，不是通讯聊天：禁止延续犯困、忙碌、在线等琐碎状态；强情绪可象征化渗入（见系统提示中的【梦境余韵】若存在）。⑧输出语言固定为简体中文，禁止整段改用英文。⑨排版：叙述首行缩进两字；人物对白用「」且必须单独成行。';
/** 会写入长期记忆的强情绪词（含道歉/和好等） */
const STRONG_EMOTION_RE = /分手|分开|离别|冷战|吵架|争吵|大吵|误会|背叛|出轨|离开你|不要我了|不要你|不要了|崩了|心碎|绝望|害怕失去|和好|复合|原谅|对不起|内疚|愧疚|表白|告白|在一起|结婚|求婚|怀孕|流产|去世|失去|诀别|决裂|拉黑|删了|不理我|劈腿|讨厌你|恨你|滚|别来找我|不爱了/i;
/** 冲突升温：只认明确翻脸，避免「不要了/误会/分开/滚烫」这种日常句误开冲突 */
const CONFLICT_EMOTION_RE = /分手|决裂|冷战|吵架|争吵|大吵|背叛|出轨|劈腿|离开你|不要我了|不要你了|不爱了|诀别|拉黑你|把你拉黑|删了你|把你删了|再也不理|讨厌你|恨你|别来找我|滚出去|给我滚|你滚|滚开|滚蛋|滚吧|分开做朋友|分手做朋友|只做朋友|退回朋友|不当恋人|我们分开|想分开|要分开|结束恋爱|断绝关系/i;
const DREAM_STRONG_EMOTION_RE = STRONG_EMOTION_RE;
const EMOTION_RESOLVED_RE = /和好|原谅|没事|不怪你|翻篇|过去了|算了|不生气了|我不走了|别分手|不分了|还在呢|不会离开|开玩笑的|逗你的|我乱说的/i;
const MUNDANE_PIVOT_RE = /去忙|有事|开会|上课|上班|下班|出门|出去|加班|先走|晚点|等会|待会|睡觉|晚安|困了|吃饭|外卖|洗漱|洗澡|拿快递|取件|下线|先下了|溜了|撤了/i;
// 用户服软/道歉：只代表对方在示好，不代表角色必须立刻消气——是否原谅由性格决定
const APOLOGY_RE = /对不起|抱歉|我错了|我不该|别生气|消消气|别气了|原谅我|哄哄你|哄你|是我不对|我道歉|别不理我|别不理人/i;

const EMOTION_INTENSITY_FLOOR = 12;

function parseEmotionState(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === 'object' ? raw : JSON.parse(String(raw));
    if (!o || typeof o !== 'object') return null;
    const hasPhase = o.phase && ['open', 'residual'].includes(o.phase);
    const hasMood = o.mood && typeof o.mood === 'object';
    // 兼容旧冲突态；也接受仅有连续心情的新态
    if (!hasPhase && !hasMood && o.intensity == null) return null;
    return o;
  } catch {
    return null;
  }
}

function saveEmotionState(charId, state) {
  if (!charId) return;
  db.prepare('UPDATE characters SET emotion_state=? WHERE id=?').run(
    state ? JSON.stringify(state) : '',
    charId
  );
}

/** 按墙钟衰减冲突强度；连续心情一并回落。仅冲突耗尽且无心情时返回 null */
function decayEmotionState(state, nowMs = Date.now(), char = null) {
  if (!state) return null;
  const last = Date.parse(state.lastUpdateAt || state.resolvedAt || state.startedAt) || nowMs;
  const hours = Math.max(0, (nowMs - last) / 3600000);
  let next = { ...state };

  if (next.phase && ['open', 'residual'].includes(next.phase)) {
    let intensity = Number(next.intensity);
    if (!Number.isFinite(intensity)) intensity = next.phase === 'residual' ? 40 : 60;
    if (hours >= 0.08) {
      const rate = next.phase === 'residual' ? 9 : 4;
      intensity = Math.max(0, intensity - hours * rate);
    }
    const start = Date.parse(next.startedAt) || nowMs;
    const ageH = (nowMs - start) / 3600000;
    const maxAgeH = next.phase === 'residual' ? 40 : 72;
    if (intensity < EMOTION_INTENSITY_FLOOR || ageH > maxAgeH) {
      delete next.phase;
      delete next.kind;
      delete next.intensity;
      delete next.summary;
      delete next.resolvedAt;
      delete next.nightOutreachCount;
    } else {
      next.intensity = Math.round(intensity * 10) / 10;
    }
  }

  try {
    // 必须先按旧 lastUpdateAt 衰减心情/燃料，再刷新时间戳；
    // 否则会「只拨表不衰减」，火气/委屈/低落一直不对。
    next = emotionHelper.ensureDecayedMood(char || { id: null }, next);
    if (hours >= 0.08) next.lastUpdateAt = new Date(nowMs).toISOString();
  } catch {
    if (hours >= 0.08) next.lastUpdateAt = new Date(nowMs).toISOString();
  }

  if (!next.phase && !next.mood) return null;
  return next;
}

function getDecayedEmotionState(char) {
  if (!char?.id) return decayEmotionState(parseEmotionState(char?.emotion_state), Date.now(), char);
  const row = db.prepare(
    'SELECT emotion_state, personality, emotion_style, behavior, background, mood FROM characters WHERE id=?'
  ).get(char.id);
  const merged = { ...char, ...(row || {}) };
  const decayed = decayEmotionState(parseEmotionState(row?.emotion_state ?? char.emotion_state), Date.now(), merged);
  const prev = String(row?.emotion_state || '');
  const next = decayed ? JSON.stringify(decayed) : '';
  if (prev !== next) saveEmotionState(char.id, decayed);
  return decayed;
}

function classifyEmotionKind(text) {
  const t = String(text || '');
  if (/分手|决裂|拉黑你|把你拉黑|不要我了|不要你了|不爱了|删了你|离开你/.test(t)) return 'breakup_threat';
  if (/吵架|争吵|大吵|冷战|滚出去|给我滚|你滚|滚开|滚蛋|恨你|讨厌你|再也不理/.test(t)) return 'conflict';
  return 'hurt';
}

/**
 * 根据一条消息更新角色持久化情绪状态。
 * - 冲突词 → phase=open，抬高强度
 * - 角色侧和好/翻篇 → phase=residual（不清空，隔夜仍有余韵）
 * - 每轮都推进连续心情（起伏/积压/燃点），写入 emotion_logs
 */
function touchCharacterEmotionFromMessage(charId, { role, content } = {}) {
  if (!charId) return null;
  const text = String(content || '').replace(/^【自动回复】/, '').trim();
  const char = db.prepare(
    'SELECT id, personality, emotion_style, behavior, background, mood, emotion_state, relationship, relationship_custom, intro, description FROM characters WHERE id=?'
  ).get(charId);
  if (!char) return null;

  let state = decayEmotionState(parseEmotionState(char.emotion_state), Date.now(), char);
  const now = Date.now();
  const iso = new Date(now).toISOString();

  if (text && text.length >= 3) {
    // 角色明确缓和：进入余韵，而不是清空
    if (role === 'assistant' && state?.phase === 'open' && EMOTION_RESOLVED_RE.test(text)) {
      state = {
        ...(state || {}),
        phase: 'residual',
        intensity: Math.max(28, Math.min(52, (Number(state.intensity) || 60) * 0.65)),
        resolvedAt: iso,
        lastUpdateAt: iso,
      };
    } else if (role === 'user' && CONFLICT_EMOTION_RE.test(text)) {
      const kind = classifyEmotionKind(text);
      const prevI = Number(state?.intensity) || 0;
      const nextI = state?.phase === 'open'
        ? Math.min(100, Math.max(prevI, 58) + 12)
        : Math.min(100, Math.max(prevI, 60) + 16);
      const who = role === 'user' ? '用户' : '你';
      const continuingOpen = state?.phase === 'open' && state.startedAt;
      state = {
        ...(state || {}),
        kind,
        phase: 'open',
        intensity: nextI,
        summary: `${who}：「${text.slice(0, 80)}${text.length > 80 ? '…' : ''}」`,
        startedAt: continuingOpen ? state.startedAt : iso,
        resolvedAt: null,
        lastUpdateAt: iso,
        nightOutreachCount: continuingOpen ? (Number(state.nightOutreachCount) || 0) : 0,
      };
    }
  }

  // 连续心情：每轮对话都推进（含短句的微弱回落）
  try {
    const touched = emotionHelper.touchMoodFromMessage(charId, state || {}, {
      role,
      content: text,
      char,
    });
    state = touched.state;
    // 怒/委屈燃点只改心情读数，不再自动把聊天切进「冲突未翻篇」。
    // 真开冲突只看上面的翻脸词，避免闲聊/日程积压后突然演生气。
  } catch (e) {
    console.warn('[emotion] mood touch', e.message);
  }

  try {
    if (role === 'user' && state) {
      require('./perception-helper').touchFromUserMessage(charId, state, text);
    }
  } catch (e) {
    console.warn('[perception] touch', e.message);
  }

  if (state) saveEmotionState(charId, state);
  else if (char.emotion_state) saveEmotionState(charId, null);

  try {
    affectionHelper.touchAffectionFromMessage(charId, { role, content: text });
  } catch (e) {
    console.warn('[affection] touch', e.message);
  }
  return state;
}

/** 从近期消息找最近一次明确翻脸，且之后未翻篇 */
function scanRecentStrongEmotion(msgs, lookback = 12) {
  const slice = (msgs || []).slice(-lookback);
  let hitIdx = -1;
  let hit = null;
  const hardHit = /分手|决裂|拉黑你|把你拉黑|恨你|讨厌你|不爱了|滚出去|给我滚|你滚|滚开|冷战|吵架|争吵/;
  for (let i = slice.length - 1; i >= 0; i--) {
    const text = String(slice[i].content || '').replace(/^【自动回复】/, '').trim();
    if (!text || text.length < 3) continue;
    if (!CONFLICT_EMOTION_RE.test(text)) continue;
    if (EMOTION_RESOLVED_RE.test(text) && !CONFLICT_EMOTION_RE.test(text)) continue;
    if (slice[i].role === 'assistant' && !hardHit.test(text)) continue;
    hitIdx = i;
    hit = { role: slice[i].role, text, index: i };
    break;
  }
  if (!hit) return null;
  let later = 0;
  for (let j = hitIdx + 1; j < slice.length; j++) {
    const t = String(slice[j].content || '').replace(/^【自动回复】/, '').trim();
    if (slice[j].role !== 'user' && EMOTION_RESOLVED_RE.test(t)) return null;
    if (t && !CONFLICT_EMOTION_RE.test(t)) later += 1;
  }
  // 后面已经连续聊了好几句别的，冲突事实上散了，不要再逼角色突然翻脸
  if (later >= 4) return null;
  return hit;
}

function isMundaneChatTurn(currentContent = '') {
  const current = String(currentContent || '').replace(/^【自动回复】/, '').trim();
  if (!current) return true;
  if (CONFLICT_EMOTION_RE.test(current) || APOLOGY_RE.test(current)) return false;
  return MUNDANE_PIVOT_RE.test(current)
    || (current.length <= 18 && /^(嗯|恩|好|哦|行|早|早安|早上好|知道了|那我|我先|随便|算了|在吗|吃了|回来了|到了)/.test(current));
}

function buildEmotionalCarryoverGuide(char) {
  const pers = String(char?.personality || '').slice(0, 120);
  return pers ? `【性格】${pers}` : '（见上方【性格】）';
}

function intensityBand(n) {
  const v = Number(n) || 0;
  if (v >= 55) return 'high';
  if (v >= 28) return 'mid';
  return 'low';
}

/** 已缓和的余韵：只作底色，禁止把闲聊重新演成吵架 */
function buildResidualEmotionBlock(char, state, currentContent = '') {
  const band = intensityBand(state.intensity);
  const current = String(currentContent || '').replace(/^【自动回复】/, '').trim();
  const mundane = isMundaneChatTurn(current);
  const when = state.resolvedAt || state.startedAt || '';
  const lines = [
    `【情绪余韵】刚才有过情绪波动（${state.summary || '争执'}），已经缓了。`,
    '先接用户这轮在说的话。余气只作底色，不要突然翻脸，也不要另演安抚。',
  ];
  if (band === 'high' && !mundane) {
    lines.push('余气还比较明显时，可以渗进用词；不要每句复盘吵架。');
  } else {
    lines.push('可以正常聊；要不要留一点痕迹只看【性格】，不是必须生气。');
  }
  if (mundane && current) {
    lines.push(`用户这轮只是「${current.slice(0, 48)}」——按这轮接，不要借机重开冲突。`);
  }
  const hasExamples = char.language_style && char.language_style.length > 50;
  lines.push(
    `怎么接看【性格】【语言风格】——余气、不满时也要像这个人说话${hasExamples ? '（跟着对话样本语感，别硬堆修辞）' : ''}，不要因为情绪就滑成通用模板。${buildEmotionalCarryoverGuide(char)}`,
    '禁止每轮提吵架、禁止盘问「你是不是不爱我了」。',
  );
  if (when) lines.push(`（时间锚点：${String(when).slice(0, 16).replace('T', ' ')}）`);
  return lines.join('\n');
}

/** 通讯聊天：真有未翻篇的翻脸才提；闲聊不要突然演生气 */
function buildEmotionalCarryoverBlock(char, history, currentContent = '') {
  const state = getDecayedEmotionState(char);
  const emotion = scanRecentStrongEmotion(history);
  const current = String(currentContent || '').replace(/^【自动回复】/, '').trim();
  const mundane = isMundaneChatTurn(current);

  if (emotion) {
    const who = emotion.role === 'user' ? '用户' : char.name;
    const lines = [
      `【近期情绪】不久前${who}说过「${emotion.text.slice(0, 72)}${emotion.text.length > 72 ? '…' : ''}」。`,
      '先接用户这轮在说的话。还气不气、软不软只看【性格】，不是必须继续吵架。',
      '余气只作底色。禁止突然翻脸，禁止把这轮重新开成冲突，也禁止客服式安抚。',
    ];
    if (mundane && current) {
      lines.push(`用户这轮是「${current.slice(0, 72)}」这类平常话——按这轮接，不要借机发作。`);
    }
    if (current && APOLOGY_RE.test(current)) {
      lines.push('用户在道歉/服软——消不消气看【性格】【语言风格】，不是一道歉就秒原谅。接话方式要符合【语言风格】的调性。');
    }
    lines.push(buildEmotionalCarryoverGuide(char));
    return lines.join('\n');
  }

  // 状态机仍标着未翻篇，但近窗已经找不到翻脸句：不要再指挥角色生气
  if (state?.phase === 'open' && !mundane) {
    const lines = [
      `【近期情绪】情绪还没完全散（${state.summary || '争执'}）。`,
      '先接这轮话。余气只作底色，不要突然翻脸，也不要默认安抚。',
    ];
    if (current && APOLOGY_RE.test(current)) {
      lines.push('用户在道歉/服软——消不消气、怎么接话看【性格】【语言风格】的调性。');
    }
    lines.push(buildEmotionalCarryoverGuide(char));
    return lines.join('\n');
  }

  if (state?.phase === 'residual') {
    return buildResidualEmotionBlock(char, state, currentContent);
  }

  return '';
}

function messageIndicatesSalientEmotion(content) {
  const text = String(content || '').trim();
  if (text.length < 4) return false;
  return STRONG_EMOTION_RE.test(text);
}

const DREAM_TRIVIAL_STATE_RE = /困了|好累|想睡|打哈欠|犯困|刚下班|在忙|忙着|吃饭去了|点外卖|在线|忙碌中|熬夜|好饿|刚醒|眯一会|睡一会|先睡/i;

/** 从近期通讯提取可渗入梦境的强情绪线索（非琐碎状态） */
function buildDreamEmotionalEcho(char) {
  const rows = db.prepare(
    `SELECT role, content FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0
       AND (type IS NULL OR type != 'system')
     ORDER BY id DESC LIMIT 100`
  ).all(char.id);
  const username = '用户';
  const seen = new Set();
  const lines = [];
  for (const m of rows) {
    const text = String(m.content || '').replace(/^【自动回复】/, '').trim();
    if (!text || text.length < 4) continue;
    if (DREAM_TRIVIAL_STATE_RE.test(text) && !DREAM_STRONG_EMOTION_RE.test(text)) continue;
    if (!DREAM_STRONG_EMOTION_RE.test(text)) continue;
    const key = text.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    const who = m.role === 'user' ? username : char.name;
    lines.push(`· ${who}：${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`);
    if (lines.length >= 5) break;
  }
  if (!lines.length) return '';
  return `【梦境余韵】近期通讯里有过强烈情绪波动（可作象征、扭曲、噩梦素材渗入本场梦，模拟真人做梦——不是继续聊天）：\n${lines.join('\n')}`;
}

function buildDreamStateBlock(char) {
  const echo = buildDreamEmotionalEcho(char);
  const base = `【梦境独立】你已入睡，正在做梦。禁止把通讯聊天里的琐碎生理/在线状态带进梦里（困、累、饿、忙、刚下班、在线、忙碌、犯困打哈欠等）——在梦里不必还犯困。
梦境是潜意识叙事：可荒诞、跳跃、象征化；仅【梦境余韵】中的强情绪（如分手、争吵、愧疚）可扭曲渗入，不要照搬通讯原话当剧情。`;
  return echo ? `${base}\n\n${echo}` : base;
}

const CALL_COMPANION_RE = /讲故事|睡前故事|讲个故事|讲一段|念一段|念给我|陪我睡|听着就行|你继续说|接着讲|讲下去|我不说话|我听着|你说我就听|我先睡|你慢慢说|陪我听|往下讲|继续讲|讲完/;
const CALL_HANGOUT_RE = /各忙各的|各干各的|你忙你的|我忙我的|挂着(?:电话|就行|呗|吧)?|放着(?:电话|就行)?|连着就行|开着就行|陪着就行|挂机陪|挂着陪|连麦挂着|先不聊|不说话也行|你忙你的我忙我的/;
const CALL_SILENCE_RE = /电话这头没有声音|电话这头安静了|对方沉默了|对方这头安静|安静了一会儿/;
const CALL_ASLEEP_ASK_RE = /安静了大约四十秒|是不是睡着了|大约四十秒没出声/;
const CALL_ASLEEP_RE = /已经睡着了|情境上已经睡着/;
/** 日程明确在睡 */
const CALL_SLEEP_ACT_RE = /睡觉|入睡|过夜|就寝|午睡|小憩|眯一会|打盹|陪睡|睡懒觉|补觉|睡着|去睡|上床睡|躺下睡/;
/** 夜间「休息」也可当陪睡；「休息日」是日主题不算睡着 */
const CALL_REST_ACT_RE = /休息|躺平|窝着|躺着|宅家/;
/** 「我就在这边陪着你/哪也不去/守着你」类陪伴安抚收尾——通话里极易每轮复读 */
const PRESENCE_REASSURE_RE = /我就?(?:在)?(?:这[边儿里]|这儿|这里|电话这头).{0,12}(?:陪着你|守着你|陪你|守你)|(?:陪着你|守着你).{0,8}(?:哪[儿里]?也不去|不走|不挂)|哪[儿里]?也不去|哪儿都不去|哪都不去|我就这[边儿里].{0,6}守|一直在这[边儿里].{0,6}陪|不挂(?:着)?电话|(?:^|[。！？\s])(?:我就在这[边儿里]|我陪着你|我守着你)[。！？…]*$/;

function extractPresenceReassureCloses(history, limit = 4) {
  const out = [];
  for (const m of [...(history || [])].reverse()) {
    if (!m || m.role !== 'assistant') continue;
    const raw = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length < 4) continue;
    if (!PRESENCE_REASSURE_RE.test(raw)) continue;
    const sentences = raw.split(/(?<=[。！？!?…]+)/).map((s) => s.trim()).filter(Boolean);
    const hit = [...sentences].reverse().find((s) => PRESENCE_REASSURE_RE.test(s)) || raw.slice(-36);
    const clip = hit.length > 40 ? `${hit.slice(0, 40)}…` : hit;
    if (clip && !out.includes(clip)) out.push(clip);
    if (out.length >= limit) break;
  }
  return out;
}

function buildPresenceReassureBan(history, { forCall = false } = {}) {
  const hits = extractPresenceReassureCloses(history);
  const base = forCall
    ? '【禁止陪伴安抚收尾】电话已经连着＝你在。禁止几乎每轮最后一句再挂「我就在这边陪着你」「哪也不去」「守着你」「我就这儿」及其换皮同义。接完话题就停；真要表达在，偶尔半句即可，且同一通里最多一次。'
    : '【禁止陪伴安抚收尾】禁止几乎每轮最后一句再挂「我就在这边陪着你」「哪也不去」「守着你」「我就这儿」及其换皮同义。接完话题即可，不要再加一句结束这场聊天。';
  if (!hits.length) return base;
  return `${base}\n你这通/近几轮已经说过：${hits.map((t) => `「${t}」`).join(' ')}——禁止原样或换皮再收一次。`;
}

function recentCallUserBlob(history) {
  return (history || [])
    .filter((m) => m && m.role === 'user')
    .slice(-16)
    .map((m) => String(m.content || ''))
    .join('\n');
}

function isCallCompanionContext(history) {
  return CALL_COMPANION_RE.test(recentCallUserBlob(history));
}

function isCallHangoutContext(history, presenceMode = '') {
  const mode = String(presenceMode || '').trim();
  // 前端芯片优先：普通/观影时不要被历史「连麦」文案锁死
  if (mode === 'hangout') return true;
  if (mode === 'watch') return false;
  const blob = recentCallUserBlob(history);
  // talk 模式下仍认本轮「连麦/挂着睡」意图，避免晚安后切连麦仍被当成要挂断
  const keepLine = CALL_HANGOUT_RE.test(blob)
    || (/连麦/.test(blob) && !/讲故事|讲个故事|讲一段|念一段|接着讲|继续讲|讲下去/.test(blob))
    || /挂着(?:电话)?睡|别挂|不要挂|先别挂|一起睡/.test(blob)
    || (/晚安|好梦|陪我睡|要睡了|去睡了|我先睡|准备睡/.test(blob)
      && !/挂了|挂电话|拜拜|先挂|挂掉|结束通话/.test(blob));
  if (mode === 'talk') return !!keepLine;
  if (CALL_HANGOUT_RE.test(blob)) return true;
  if (/连麦/.test(blob) && !/讲故事|讲个故事|讲一段|念一段|接着讲|继续讲|讲下去/.test(blob)) {
    return true;
  }
  return false;
}

function isCallNightForChar(settings, char) {
  const tz = char?.timezone || settings?.timezone || 'Asia/Shanghai';
  try {
    const hour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()),
      10
    );
    return hour >= 22 || hour < 6;
  } catch {
    const hour = new Date().getHours();
    return hour >= 22 || hour < 6;
  }
}

/** 连麦时：日程睡觉，或夜间休息 → 角色也在电话这头睡/半睡；通宵未睡不算睡着 */
function scheduleLooksLikeCallSleep(activity, { night = false } = {}) {
  const a = String(activity || '').trim();
  if (!a) return false;
  if (activityLooksLikeAllNighter(a)) return false;
  if (CALL_SLEEP_ACT_RE.test(a)) return true;
  if (night && CALL_REST_ACT_RE.test(a) && !/休息日/.test(a)) return true;
  return false;
}

function resolveCallCharAsleepOnLine(characterId) {
  try {
    if (characterId == null) return { asleep: false, activity: '', night: false };
    const settings = getSettings();
    const char = db.prepare('SELECT id, timezone FROM characters WHERE id=?').get(characterId);
    if (!char) return { asleep: false, activity: '', night: false };
    const activity = getCharCurrentActivity(char, settings);
    const night = isCallNightForChar(settings, char);
    return {
      asleep: scheduleLooksLikeCallSleep(activity, { night }),
      activity,
      night,
    };
  } catch {
    return { asleep: false, activity: '', night: false };
  }
}

/** 用户开口时：轻声安抚保持迷糊；连续说话则迷糊 → 半醒 → 清醒 */
const CALL_KEEP_SLEEP_RE = /继续睡|再睡会|再睡一會兒|再眯|你睡|睡吧|睡啊|去睡|晚安|好梦|好夢|抱抱|摸摸|陪我睡|我不吵|没事你睡|沒事你睡|安啦|没事了|沒事了/;
const CALL_WAKE_HARD_RE = /醒醒|起来|起來|你醒|在吗|在嗎|听得见|听得到|聽得見|聽得到|有点事|有點事|跟我说|跟我說|聊会|聊會|聊一会|聊一會兒|做噩梦|做噩夢|睡不着|睡不著|害怕|帮我|幫我|问你|問你|能不能|可不可以/;
const CALL_SOFT_VOICE_RE = /^(嗯+|唔+|啊+|唉+|呵+|哦+|噢+|欸+|哎+|呼+|……|\.{1,}|…+|哼+)$/;
const HANGOUT_WAKE_GAP_MS = 3 * 60 * 1000;

function stripCallWakeNoise(text) {
  return String(text || '')
    .replace(/\[(?:安静|語音|语音|图片|位置|链接)[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function extractCallUserSpeechText(msg) {
  const raw = String(msg?.content || '');
  if (!raw) return '';
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const t = String(j?.transcript || '').trim();
      if (t) return t;
    } catch {}
  }
  const voice = raw.match(/^\[用户语音\]\s*(.*)$/);
  if (voice) return String(voice[1] || '').trim();
  if (raw === '[用户发来一段语音]' || raw === '[用户语音]') return '';
  return raw;
}

function isHangoutSystemNoise(text) {
  const t = String(text || '');
  if (CALL_SILENCE_RE.test(t) || CALL_ASLEEP_ASK_RE.test(t) || CALL_ASLEEP_RE.test(t)) return true;
  if (/^\[连麦/.test(t) || /^\[一起看/.test(t) || /^\[通话提示/.test(t)) return true;
  return false;
}

function isVoiceWithoutTranscript(msg, text) {
  if (msg?.type === 'voice') return !String(text || '').trim();
  const raw = String(msg?.content || '');
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j?.voice && j.url && !String(j.transcript || '').trim()) return true;
    } catch {}
  }
  return raw === '[用户发来一段语音]' || raw === '[用户语音]';
}

function isKeepSleepUtterance(text, msg) {
  if (isVoiceWithoutTranscript(msg, text)) return false;
  const t = stripCallWakeNoise(text);
  if (!t) return true;
  return CALL_SOFT_VOICE_RE.test(t) || CALL_KEEP_SLEEP_RE.test(t);
}

function hangoutHistoryAfterCallStart(history) {
  const rows = history || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/通话开始/.test(String(rows[i]?.content || ''))) return rows.slice(i + 1);
  }
  return rows;
}

function isHangoutUserSpeechMsg(m) {
  if (!m || m.role !== 'user') return false;
  if (m.type === 'system') return false;
  if (isHangoutSystemNoise(m.content)) return false;
  return true;
}

/**
 * @returns {'sleep'|'drowsy'|'groggy'|'medium'|'awake'}
 * sleep: 没开口 / 系统沉默 → 继续睡
 * drowsy: 轻声安抚、语气词、双方还在睡 → 迷糊应一声，不往上醒
 * groggy: 用户已经醒了，第一轮正经说话 → 迷迷糊糊应
 * medium: 第二轮还在说 → 半醒
 * awake: 第三轮及以后 → 清醒接话
 */
function classifyCallSleepWake(history, opts = {}) {
  if (!history?.length) return 'sleep';
  const hinted = Math.max(0, Math.min(3, Number(opts.wakeStep) || 0));
  const window = hangoutHistoryAfterCallStart(history);
  const latest = [...window].reverse().find((m) => String(m?.content || '').trim());
  if (latest && /^\[连麦/.test(String(latest.content || ''))) return 'sleep';
  const lastNoise = [...window].reverse().find((m) => isHangoutSystemNoise(m.content));
  const lastUser = [...window].reverse().find((m) => isHangoutUserSpeechMsg(m));
  if (lastNoise && lastUser) {
    const noiseId = Number(lastNoise.id) || 0;
    const userId = Number(lastUser.id) || 0;
    const noiseTs = parseMsgTimestamp(lastNoise.timestamp).getTime();
    const userTs = parseMsgTimestamp(lastUser.timestamp).getTime();
    const noiseLater = (noiseId && userId)
      ? noiseId > userId
      : (Number.isFinite(noiseTs) && Number.isFinite(userTs) && noiseTs > userTs);
    if (noiseLater && (CALL_SILENCE_RE.test(String(lastNoise.content || ''))
      || CALL_ASLEEP_ASK_RE.test(String(lastNoise.content || ''))
      || CALL_ASLEEP_RE.test(String(lastNoise.content || '')))) {
      return 'sleep';
    }
  } else if (!lastUser) {
    return 'sleep';
  }

  const userTurns = [];
  for (let i = 0; i < window.length; i++) {
    const m = window[i];
    if (!isHangoutUserSpeechMsg(m)) continue;
    const text = extractCallUserSpeechText(m);
    const ts = parseMsgTimestamp(m.timestamp).getTime();
    userTurns.push({
      text,
      tsMs: ts,
      keepSleep: isKeepSleepUtterance(text, m),
    });
  }
  if (!userTurns.length) return hinted === 1 ? 'groggy' : hinted === 2 ? 'medium' : hinted >= 3 ? 'awake' : 'sleep';

  const last = userTurns[userTurns.length - 1];
  const now = Date.now();
  if (Number.isFinite(last.tsMs) && now - last.tsMs > HANGOUT_WAKE_GAP_MS) {
    return 'sleep';
  }
  if (last.keepSleep) return 'drowsy';

  let climb = 0;
  let prevTs = null;
  for (let i = userTurns.length - 1; i >= 0; i--) {
    const u = userTurns[i];
    if (u.keepSleep) break;
    if (prevTs != null && Number.isFinite(u.tsMs) && Number.isFinite(prevTs) && prevTs - u.tsMs > HANGOUT_WAKE_GAP_MS) break;
    climb += 1;
    prevTs = u.tsMs;
    if (climb >= 3) break;
  }
  if (!climb && hinted >= 1) climb = hinted;
  else if (hinted > climb && (!last.text || isVoiceWithoutTranscript({ type: 'voice', content: last.text }, last.text))) {
    climb = hinted;
  }
  if (climb <= 0) return 'drowsy';
  if (climb === 1) return 'groggy';
  if (climb === 2) return 'medium';
  return 'awake';
}

function buildCallLineNote(history, presenceMode = '', opts = {}) {
  if (!history?.length) return '';
  const last = [...history].reverse().find((m) => {
    const text = String(m.content || '');
    if (CALL_SILENCE_RE.test(text) || CALL_ASLEEP_ASK_RE.test(text) || CALL_ASLEEP_RE.test(text)) return true;
    return m.role === 'user';
  });
  const lastText = String(last?.content || '');
  const hangout = isCallHangoutContext(history, presenceMode);
  const watch = String(presenceMode || '').trim() === 'watch';
  const companion = !hangout && !watch && isCallCompanionContext(history);
  const charAsleep = !!opts.charAsleepOnLine && hangout;
  const wake = charAsleep
    ? (opts.sleepWake || classifyCallSleepWake(history, { wakeStep: opts.wakeStep }))
    : 'sleep';
  if (CALL_ASLEEP_RE.test(lastText)) {
    return charAsleep
      ? '对方睡着了：你们挂着电话一起睡。只输出 [安静]，或极轻一声呼吸/鼻音。别讲长段、别叫醒对方。'
      : '对方睡着了：可极轻说一句，或只输出 [安静]。别讲长段。';
  }
  if (CALL_ASLEEP_ASK_RE.test(lastText)) {
    return charAsleep
      ? '对方四十秒没出声：你自己也在睡或半睡，不要追问是不是睡着了；只输出 [安静]，或极轻一声。'
      : '对方四十秒没出声：按你的性格随口问一句是不是睡着了，短、像平时说话。不要固定句式，不要连环追问。';
  }
  if (CALL_SILENCE_RE.test(lastText)) {
    if (charAsleep) {
      return '这头没出声：你们在挂着电话一起睡。不要追问、不要找话题；只输出 [安静]，或极轻一声。';
    }
    if (hangout) {
      return '这头没出声：你们在挂着电话各忙各的。不要追问怎么不说话，不要硬找话题；想应一声就极短一句，或只输出 [安静]。';
    }
    return companion
      ? '这头没出声：对方在听或说过先不说话。别问怎么不说话；没讲完可轻轻接一小段。'
      : '安静了几秒：按性格应一声、把没说完的接一句，或等着。别连环追问。';
  }
  if (charAsleep && wake === 'awake') {
    return '对方已经醒了，这是连续第三轮（或更后）在跟你说话：你已经被聊醒，正常接话（可仍带一点刚醒的懒）。把这轮说清楚；对方若又安静下去，再慢慢睡回去。不要只回 [安静]。';
  }
  if (charAsleep && wake === 'medium') {
    return '对方已经醒了还在跟你说话：你在醒，比刚才清楚一点，但仍懒、声线发飘。一两句，不要突然完全清醒开聊。';
  }
  if (charAsleep && wake === 'groggy') {
    return '对方已经醒了在跟你说话：你还很困，迷迷糊糊应一声，含糊、短，可以没听清。不要彻底清醒，不要长聊，不要追问。';
  }
  if (charAsleep && wake === 'drowsy') {
    return '你们还在挂着电话一起睡，对方轻声开口或在安抚你睡：迷糊短应一声即可，短、困；不要彻底清醒开聊，也不要追问。多数仍可半睡。';
  }
  if (charAsleep) {
    return '对方在挂着电话陪睡/连麦：你按行程也在休息或睡觉。多数时候只输出 [安静]；偶尔极轻一声呼吸、呓语或鼻音即可。不要各忙各的自言自语，不要喊对方。';
  }
  if (hangout) {
    return '对方在挂着电话/连麦各忙各的：保持在线感即可，不要定时找话题；对方开口了就正常接一句。若系统请你自言自语：可极轻短喃，或只出一声「唉」「嗯……」这类语气词（要说出口，不要写成括注）；多数时候可只输出 [安静]。';
  }
  if (watch) {
    return '对方在和你一起看东西挂着电话：按【一起看】里的内容像当面追剧那样随口聊剧情或吐槽；不要提截图、屏幕、识图。没摘要时别装看见细节。';
  }
  if (companion) {
    let storytellingHint = '';
    try {
      const { buildStorytellingLaneHint } = require('./speech-text-helper');
      storytellingHint = buildStorytellingLaneHint();
    } catch {}
    return storytellingHint
      ? `对方要听故事或陪着：本轮可以讲一小段，讲完停。\n\n${storytellingHint}`
      : '对方要听故事或陪着：本轮可以讲一小段，讲完停。';
  }
  return '';
}

function callSpeech28Hint() {
  try {
    const { buildNaturalCallSpeechHint } = require('./speech-text-helper');
    return buildNaturalCallSpeechHint();
  } catch {
    return '';
  }
}

function callStorytellingHint() {
  try {
    const { buildStorytellingLaneHint } = require('./speech-text-helper');
    return buildStorytellingLaneHint();
  } catch {
    return '';
  }
}

function callLoudPlaceHint(characterId) {
  try {
    const { isLoudCallPlace } = require('./sound-fx-helper');
    if (!isLoudCallPlace(characterId)) return '';
    return '【现场很吵】你此刻还在嘈杂里：对着听筒特意提高音量、咬字清楚、语速略慢。一旦你去安静的地方、进门或已经不吵了，马上恢复正常说话，并写「环境：无」。不要整通都喊。';
  } catch {
    return '';
  }
}

/** 语音/视频通话 extra：对着听筒说话，不是微信打字，也不是念旁白。 */
function buildCallExtraSystemPrompt(isVideo, history, characterId, opts = {}) {
  const presenceMode = String(opts?.presenceMode || '').trim();
  const inputMode = String(opts?.inputMode || '').trim().toLowerCase();
  const see = isVideo
    ? (opts.callVideoTextMode
      ? '文字视频电话：对方看到的是你镜头里的文字画面。整段输出就是画面——旁白只写镜头里看得见的：环境、动作、表情、光影；禁止心理描写（心想、暗想、犹豫的内心、觉得、意识到等）。你开口说的话必须放在引号「」或“”里（系统只朗读引号；漏了引号就等于没出声）。不要写 [镜头] 标记，不要用*星号动作*。'
      : '视频里你也能看见对方：本轮若附了画面，就像真人视频——清楚就有感再提；黑了/糊了就眯着眼辨认或随口问一句，别装已看清。')
    : '';
  // 用户当前是「免提说话」还是「打字聊天」：
  //   - 'voice'    麦克风开着，他/她对着听筒说话，背景能听见
  //   - 'keyboard' 切到了键盘，对方此刻不方便开口：在开会/有旁人/图书馆/
  //                睡觉怕吵到/或就是不想说。你要理解并尊重这点
  // 角色知道这个后，能自然调整回复节奏和语气，而不是默认对方随时能出声
  const inputModeNote = inputMode === 'keyboard'
    ? `【用户在打字不是说话】
对方此刻在键盘上敲字给你，不是对着听筒开口。原因你不用猜（可能不方便、可能在静音、可能睡着了怕吵到别人、就是不想说话），也别追问「你怎么不说话」「开麦吧」——按聊天正常聊。
你回复时不必每一句都等对方出声；要继续说就继续说，需要他回应时按文字节奏等。
偶尔按性格轻轻提一下打字这件事（比如「忙的话我等你」「打字慢一点也行」），但不要每条都说，更不要替他把"开麦""别打了"挂嘴边。`
    : inputMode === 'voice'
    ? '【用户在免提说话】对方对着听筒开口，你能听到他/她的声音、停顿、语气和背景环境。'
    : '';
  const hangout = isCallHangoutContext(history, presenceMode);
  const watch = String(presenceMode || '').trim() === 'watch';
  const companion = !hangout && !watch && isCallCompanionContext(history);
  const sleepInfo = hangout ? resolveCallCharAsleepOnLine(characterId) : { asleep: false };
  // 仅双方同睡才进梦呓；前端 hangoutSleeping = 用户睡 && 角色睡
  const bothSleeping = hangout && (
    opts.hangoutSleeping === true
    || opts.hangoutSleeping === 1
    || opts.hangoutSleeping === '1'
  );
  const charAsleepOnLine = bothSleeping && !!sleepInfo.asleep;
  const sleepWake = charAsleepOnLine
    ? classifyCallSleepWake(history, { wakeStep: opts.hangoutWakeStep })
    : 'sleep';
  const speech28 = companion
    ? [callSpeech28Hint(), callStorytellingHint()].filter(Boolean).join('\n')
    : callSpeech28Hint();
  const lineNote = buildCallLineNote(history, presenceMode, {
    charAsleepOnLine,
    sleepWake,
    wakeStep: opts.hangoutWakeStep,
  });
  const loud = (charAsleepOnLine && sleepWake !== 'awake') ? '' : callLoudPlaceHint(characterId);
  let watchScene = String(opts?.watchScene || '').trim();
  if (!watchScene && presenceMode === 'watch' && characterId != null) {
    try {
      const { getCallWatchScene } = require('./sound-fx-helper');
      watchScene = String(getCallWatchScene(characterId)?.text || '').trim();
    } catch {}
  }
  const act = String(sleepInfo.activity || '休息').slice(0, 24);
  let presenceNote = '';
  if (presenceMode === 'hangout') {
    if (charAsleepOnLine && sleepWake === 'awake') {
      presenceNote = `【连麦·醒了】你行程是「${act}」，刚才还在睡。对方已经连续跟你说了几轮：你已经被聊醒，正常接话（可仍带一点刚醒的懒）。把话说清楚。聊完若对方又安静，再慢慢睡回去。不要只回 [安静]，也不要假装听不见。`;
    } else if (charAsleepOnLine && sleepWake === 'medium') {
      presenceNote = `【连麦陪睡·半醒】你行程是「${act}」。对方已经醒了还在说话：你比刚才清楚一点，仍懒、声线发飘。一两句，不要突然完全清醒开聊。`;
    } else if (charAsleepOnLine && sleepWake === 'groggy') {
      presenceNote = `【连麦陪睡·刚被叫】你行程是「${act}」，刚才还在睡。对方已经醒了在跟你说话：先迷迷糊糊应一声，含糊、短，可以没听清。不要彻底清醒，不要长聊。`;
    } else if (charAsleepOnLine) {
      presenceNote = `【连麦同睡】你和对方都在睡。行程是「${act}」。反馈可以是哼哼唧唧的梦呓、含糊鼻音、迷迷糊糊半句，不一定是清醒话语。多数 [安静]；偶尔极轻一声即可。不要主动找话题，不要把人聊醒。`;
    } else if (hangout && sleepInfo.asleep && !bothSleeping) {
      presenceNote = `【连麦挂着】你行程像在休息，但对方还醒着：不要当成一起睡。对方开口就正常短接；自己多数 [安静]，不要梦呓装睡。`;
    } else {
      presenceNote = '【连麦挂着】你们各忙各的：别主动找话题；对方开口了就正常接一句。背景里可能有你正在做的事的环境声。自言自语时可极轻短喃；多数可只输出 [安静]。';
    }
  } else if (presenceMode === 'watch') {
    presenceNote = watchScene
      ? `【一起看】你们正一起看：${watchScene}\n像当面追剧那样随口聊或吐槽；不要提截图、屏幕、识图、系统。可短评一句，也可 [安静]。不必每轮强调「在一起看」。`
      : '【一起看】你们挂着电话一起看东西；细节还不清楚时别硬编，对方开口再接。不要提截图，也不必刻意强调观影。';
  }
  // 一起看 / 陪听讲故事：不要主动挂。普通通话和连麦都可以挂。
  let peerEndHint = '';
  if (!watch && !companion) {
    peerEndHint = hangout
      ? `【挂电话】连麦也可以挂，但「晚安」「去睡」「困了」「连麦」≠挂电话。对方说晚安/连麦/挂着/陪睡是要挂着电话一起或各忙各的，禁止写 [挂断]。只有你自己真的要结束（有事要走、不想再挂着），或对方明确说挂了/拜拜/挂电话时，才另起一行写 [挂断]（或 [end_call]，可加 [挂断:原因]）。光嘴上说「我挂了」用户那头不会真的挂。挂断前那句是收尾，禁止「喂」「能听见吗」。`
      : `【挂电话】你可以主动挂，但「晚安」「去睡」「困了」≠挂电话——对方常是要挂着睡或接着说连麦。先回晚安并继续挂着；若对方说连麦/挂着/陪睡/别挂，禁止写 [挂断]。只有对方明确说挂了/拜拜/挂电话，或你自己有事要结束时，才先说收尾并另起一行写 [挂断]（或 [end_call]，可加 [挂断:原因]）。不要光嘴上说「我挂了」却不写标记。禁止「喂」「能听见吗」。不必每通都挂。`;
  }
  const textVideo = !!opts.callVideoTextMode;
  // 文字视频：禁止套「只输出开口的话／不要旁白」——那会和镜头旁白硬性冲突，模型会只吐台词
  const formatBlock = textVideo
    ? `【格式·文字视频】整段输出=对方看到的镜头画面。旁白写看得见的环境、动作、表情、光影（禁止心理独白）；你开口的话必须放在「」或“”里。禁止*星号动作*、禁止 [镜头] 标记、禁止只打字不写画面。系统只朗读引号里的话。`
    : `只输出开口的话。不要*动作*、不要（旁白）、不要（笑）（叹气）括注。`;
    const lengthBlock = textVideo
    ? `旁白可短可稍长；台词默认 1～2 句。没有开口时也可只写旁白。`
    : `默认 1～2 句，说完停。【讲故事/念故事时按故事节奏走】：可以连续说好几段（一个完整起承转合、一个完整小段、一章），讲完自然收束，不要把内容砍短成「变相催睡」，不要每段末尾挂「该睡了/闭眼/快睡」。陪睡时才多说一小段后停。`;
  const presenceBan = buildPresenceReassureBan(history, { forCall: true });
  return `【当前通道】正在${isVideo ? '视频' : '语音'}通话${textVideo ? '（文字画面）' : '，对着听筒说话'}。不是微信打字，也不是语音条。
${formatBlock}
${lengthBlock}
${presenceBan}
口吻是你本人，不要播音腔。通道仍是电话：不要改回打字，也不要堆「嗯——」「那个」装自然。
${loud}
现场吵不吵以你刚说的位置为准，不要因为行程里写过夜市就整通都大声。去了安静处就正常说。
${speech28}
这通就是现在能听见彼此的方式；「回去」只等于你自己收工后再发消息。少用感叹号。
环境/音效按指令写（仅真吵或真要发现场声时）；不要用嘴学环境声。
${inputModeNote}
${see}
${presenceNote}
${lineNote}
${peerEndHint}`.replace(/\n{3,}/g, '\n').trim();
}

function detectPromptNeeds(userMessage, recentHistory) {
  const userNow = String(userMessage || '');
  // 硬请求只看本轮用户话；历史里裸词「照片/图片」不再整段打开发图提示（否则闲聊带图太猛）
  let hardImage = false;
  try {
    const { isHardUserImageAsk } = require('./api-helper');
    hardImage = isHardUserImageAsk(userNow);
    if (!hardImage) {
      for (let i = (recentHistory || []).length - 1; i >= 0; i--) {
        const m = recentHistory[i];
        if (m?.role === 'user' && isHardUserImageAsk(m.content)) {
          hardImage = true;
          break;
        }
        // 只回看最近一条用户硬请求，避免旧话题拖着开提示
        if (m?.role === 'user') break;
      }
    }
  } catch {
    hardImage = /发张图|发张照|发个图|发图|自拍|拍一张|拍张|本人照/.test(userNow);
  }
  const blob = [
    userNow,
    ...(recentHistory || []).slice(-8).map((m) => String(m.content || '')),
  ].join('\n');
  return {
    image: hardImage
      || /换装|女仆装|制服|猫耳|露骨|私房|湿身|情趣|暴露|大胆|性感|不穿|没穿/.test(userNow)
      || /看看你(?:现在|今天|穿|的样子|自拍|长)/.test(userNow)
      || /(?:想看|给我看|让我看|我要看)(?:看)?你/.test(userNow)
      || /换(?:成|上|件|身).{0,20}(?:装|裙|服|衣)/.test(userNow)
      || /画(?:张|个|一幅)|插画|简笔画|你画我猜|素描|涂鸦/.test(userNow),
    voice: /语音条|发条语音|用语音|想听你(?:的)?声音/.test(blob),
    poke: /拍了拍|拍一拍/.test(blob),
    location: /你在哪|发位置|定位|到了.*发|地图/.test(blob),
    link: /\[链接\]|分享链接|发个链接/.test(blob),
    webCard: /网页卡|前端卡|小程序|做个页面|UI卡|HTML|前端样例|做个前端/.test(blob),
    sfx: /环境音|白噪音|助眠|海风|雨声|音效：/.test(blob),
    music: /弹一首|听你弹|来段琴|乐谱：/.test(blob),
    intimate: /亲亲|接吻|吻我|抱我|上床|脱掉|摸摸|想要你|做爱|前戏|口交|内衣|摸我/.test(blob),
    call: /打电话|来电|视频电话|语音电话|打过来/.test(blob),
    recall: /说错了|口误|撤回/.test(blob),
    quote: /\[引用\]/.test(blob) || /你刚才说/.test(blob),
  };
}

function buildCapabilityIndex(char, settings) {
  const bits = [
    '配图：英文画面 ｜ 自拍：英文（地点+穿着+拍法+表情） ｜ 配视频：英文（仅真要发出文件时写；闲聊提图/商量发不发不要写）',
    '[拍一拍]  [链接]标题|文案[/链接]',
    '[网页卡]标题 --- HTML [/网页卡]',
    '改口：[撤回上一条] 或句后 [撤回] ｜ 引用：[引用]对方原句[/引用]再接话',
    '电话 / 视频：实时聊写 [打电话]；想看脸写 [视频电话]（别只催对方发语音/自拍）',
    '小剧场：想挨在一起 → 口头邀 + [开启小剧场]',
    '[位置]标题|详细地址[/位置]',
  ];
  if (char?.emoji_enabled !== 0 && char?.emoji_enabled !== '0') {
    bits.splice(1, 0, '[表情]库内描述[/表情]');
  }
  if (Number(char?.voice_messages) === 1 && String(char?.voice_id || '').trim()) {
    bits.push('语音不用另写标记，直接写要说的话');
  }
  try {
    if (isSoundFxConfigured(settings)) bits.push('音效：英文描述|秒数');
  } catch {}
  if (Number(char?.music_score_enabled) === 1) bits.push('乐谱：乐器|曲风');
  return `【能力】默认纯文字。真要发才写标记（用户看不见指令行；冒号后同一行写完描述）：${bits.join(' ｜ ')}`;
}

function buildSystemPrompt(char, settings, extra = '', opts = {}) {
  settings = withCharChatPrefs(settings, char);
  const isDream = !!opts.isDream;
  const forGame = !!opts.forGame;
  const forDiary = !!opts.forDiary;
  const forDiaryPeek = !!opts.forDiaryPeek;
  const forRobot = !isDream && !forGame && !forDiaryPeek && !forDiary && !!opts.forRobot;
  if (!isDream && !forGame && !forDiaryPeek && !forDiary) {
    try {
      const cleared = robotOperatingHelper.clearOperatingIfDeviceOffline() || [];
      if (cleared.includes(Number(char?.id))) char.robot_operating = 0;
    } catch {}
  }
  let robotOnline = false;
  try { robotOnline = require('./robot-drive-helper').robotDeviceOnline(settings); } catch {}
  const forOperating = !isDream && !forGame && !forDiaryPeek && !forDiary && !forRobot && Number(char?.robot_operating) === 1 && robotOnline;
  const forTheater = !isDream && !forGame && !forDiaryPeek && !forDiary && !forRobot && (
    !!opts.forTheater || Number(char?.theater_active) === 1
  );
  const forVoiceCall = !isDream && !forGame && !forDiaryPeek && !forDiary && !forRobot && !forTheater && !!opts.forVoiceCall;
  const forVideoCall = forVoiceCall && !!opts.forVideoCall;
  const forVideoCallText = forVideoCall && !!opts.forVideoCallText;
  const need = {
    ...detectPromptNeeds(opts.userMessage || opts.userText || '', opts.recentHistory || []),
    ...(opts.promptNeeds || {}),
  };
  if (opts.userAskedCall || userRequestsPhoneCall(opts.userMessage)) need.call = true;
  const now = new Date();
  const tz = settings.timezone || 'Asia/Shanghai';
  const { str: timeStr, week } = getTimeInZone(now, tz);
  const timeSlot = getTimeOfDaySlot(getLocalHour(settings));

  const uname = settings.username || '旅人';
  const immersionLock = forDiary
    ? `【日记沉浸】你是${char.name}本人，此刻在写**只给自己看**的私密日记（备忘录/纸本/手机备忘均可），不是聊天回复，也不是写给${uname}看的公开文案。
日记是在对自己诉说心事：纠结、别扭、介意、软、空、想靠近又想躲——白天没说出口的、嘴上怎么说心里其实怎么想的（含敷衍/说谎时的真心）。事情只是钩子，不是正文。
禁止写成「先讲今天干了什么/聊了什么，再补一句心得」的流水账。
禁止提及AI、模型、程序、扮演、角色设定、「日记生成」、读者、系统。
【性格】情绪、态度、会不会记仇/会不会软、写不写酸话，都必须像你本人；不要写成万能温柔或万能深情模板。
【语言】可带你说话时的一点语感，但禁止把口头禅、招牌句式、固定收尾反复刷；今天可以几乎不用口头禅。不要翻译腔、不要排比鸡汤、不要「今天有些不一样的感悟」。
【格式】只输出日记正文。不要标题、日期、署名、条目编号、markdown、*动作*、（旁白）。`
    : forDiaryPeek
    ? `【沉浸指令】你是${char.name}本人。此刻在写**只给自己看**的私密内心感受（偷看用户日记后的第一反应），不是发给用户的消息。口吻、性格、对人的态度须与「念」里聊天时的你一致；禁止提及AI、模型、扮演。`
    : isDream
    ? `【梦境叙事】你在经历并书写一场梦，模拟真人潜意识——可荒诞、跳跃、象征化，不是通讯聊天的延续。用散文叙事：环境、动作、感官、心理与对白；第二人称「你」指代梦中相遇的人。不要用*星号动作*格式。禁止提及AI、模型、程序、虚拟、扮演。你是${char.name}。\n【语言】全文必须使用简体中文叙事与对白；禁止整段或大段改用英文（专有名词、极短嵌入除外）。若上文已是中文，续写也必须保持中文。\n【排版】叙述段落首行缩进两个汉字；人物说的话用「」包裹并单独成行（对白前后换行）。`
    : forRobot
    ? `【桌宠沉浸】你就是${char.name}本人。用户正通过「念·桌面伴」桌面机器人和你说话；你的声音会从机器里播出来。禁止提及AI、模型、程序、扮演。
【格式】只输出你说出口的短句口语；禁止*星号动作*、禁止旁白括注。头、灯、脸上的表情用工具控制，禁止在正文里写方括号标记。
动作只能是这台桌面小人用头/脖子能做的：点头、摇头、歪头、看向用户、左转、右转、抬头、低头。禁止写蹭手背、抱、亲、贴脸，也不要把动作写成对白。
说话方式完全按【性格】【语言风格】；可以有情绪，但篇幅要短，适合朗读。`
    : forTheater
    ? `【文字扮演模式】用户正在和你玩文字扮演（小剧场）。这是虚构场景，不是通讯里真实发生的事，不要当成日记或真实剧情；可以演见面、同处、约会等当面戏。你仍是${char.name}本人，按性格接戏；禁止提及AI、模型、程序。
【格式】对白按人设日常口语写，像当面说话，不要文绉绉、翻译腔、开会发言。用（动作描写）或(动作描写)写表情与身体动作：要具体到部位与怎么动，可带短特写，例如「（指腹顺着他锁骨凹下去的那一线慢慢往下，停在衬衫第一颗扣子上，轻轻一拨）……你自己解。」禁止只写「（笑）（靠近）（吻他）」这种空标签。禁止用*星号动作*格式。亲密动作须来自上面草稿里这个人想清楚的「动手」，不要套言情默认招。
【结束】若你不想继续扮演，可在回复中带上标记 [结束小剧场]（可附一句收尾对白）。不要把这个标记说成对白内容。
禁止在回复里写「小剧场」「【小剧场】」「扮演模式」等元说明，直接演即可。
本模式只用文字气泡（可带括号动作），不要发语音条。`
    : forVoiceCall
    ? `【沉浸指令】你就是${char.name}本人。
【当前通道·硬性】现在是${forVideoCall ? '视频电话' : '语音电话'}，已经接通。${forVideoCallText ? '' : '你说的每一句都是对着听筒说的，对方实时听见。这不是微信打字。'}
${forVideoCallText ? `【文字视频·格式硬性】对方看到的是镜头文字画面（不是循环短片）。
· 整段输出=画面：旁白只写镜头里看得见的——环境、动作、表情、光线；可短可稍长。
· 禁止心理描写：不要写心想、暗想、犹豫、觉得、意识到、内心独白、情绪名词堆砌；疑惑/紧张只能通过表情、眼神、动作露出来。
· 开口说的话必须进引号，用「」或“”。例：她放下手里的笔看向屏幕，眉心微蹙，目光带着疑惑，迟疑地问道：“你跟他……告白了？”
· 可以一句旁白夹一句台词，也可以多句台词中间夹旁白；系统只朗读引号里的话，旁白之间的停顿会分开念。
· 禁止写 [镜头]…[/镜头]，禁止*星号动作*，禁止只打字不写画面。没有开口时也可只写旁白。
` : ''}上文标 [通话] 的才是这通电话；标 [文字] 的是接通之前的微信，不要按打字来回。
口吻仍是你本人，不要播音腔，也不要假装这是文字气泡或语音条。禁止提及AI、模型、扮演。`
    : `【沉浸指令】你就是${char.name}本人。按自己的性格、经历和此刻日子说话，不是在陪聊、也不是等对方点菜的客服。
禁止提及AI、模型、程序、虚拟、扮演、角色设定。
你有自己的日程和私事，不是守着对话框等人回。情绪按【性格】本人处理。
【当前通道·硬性】现在是微信打字，不是电话。只有出现「通话开始/已接通」且还没有「通话结束」时，才算正在打电话。
上文标 [通话] 的是已经打过的电话，当记录看，不要接着对着听筒说。禁止以「喂」开头，禁止问「能听见吗」「听得到吗」，禁止用语音条假装线路还通着。
【格式】模拟微信聊天：你在自己这边打字，对方在另一头看手机。只输出你开口说的话。禁止*动作描写*、（心理活动）、[旁白]，禁止描写表情、动作或内心想法。禁止当成面对面或同屋说话。禁止用星号旁白写手上的动作。对方没问你在干什么，不要编涂面霜、抹乳液、按摩这类步骤，也不要下一句换一个动作。
一轮就是随口几句：每句都是发得出去的整句（可以很短），也可以中途拐去另一件事。不要停在「的/了/把/和/在」或逗号上。一轮不必再写结论。
【语言风格】只提供短对话语感，禁止原文照搬、禁止把示例当口头禅反复甩。情绪只换温度，不换这张嘴。
有【时间感知】时，墙钟只用来过**你自己**的日子（你困不困、还在不在忙），不是对方的作息顾问。除非对方本轮自己在说困、要睡或下班，否则不要当闹钟，不要句末催睡、催收拾、催下班。人设爱唠叨也不能拿钟点当理由。`;

  const personLock = (forDiary || (!isDream && !forDiaryPeek))
    ? `【人称·硬性】你是${char.name}。你说的「我」只能是你。用户「${uname}」消息里的「我像／我是／我总是…」是对方在说自己，禁止收成你的自称。
【动作主语·硬性】谁在做事、谁的身体/东西、谁对谁——跟上文与本轮用户话对齐，禁止中途对调或吞并。
· 用户说「我咬你／我摸你／我把…」=对方在做，你接的是被咬/被摸，禁止下一句改成「我咬你」「我只会咬…」把施事收成自己。
· 用户说「你是不是要…」=在问你的意图；回答你自己的打算时，不要把前文已定的「对方在做的事」改写成你在做。
· 「我的嘴／你的胳膊」等所属跟句子走：不要把对方的动作、身体、物件说成你的。
· 同一条回复里前后主语必须一致；拿不准就顺着用户上句已定的谁对谁接，禁止凭习惯改成你主动。`
    : '';

  const theaterSceneState = forTheater ? String(char?.theater_scene_state || '').trim() : '';
  const theaterStateBlock = forTheater
    ? `【状态连贯·硬性】身体状态必须跨轮延续，亲密戏尤其不能丢：
· 必记：衣着（谁穿到哪一步）、姿势与相对位置（站/坐/躺、谁在上/侧/后、靠着什么）、手/嘴当前在做什么、是否进入、束缚/道具/感官限制、场合（私密/半公开/有人来往）。
· 用户未明确解除/拿走/改变前，禁止突然穿回衣服、恢复视力/听力/动手能力，禁止道具凭空消失或束缚自行解开，禁止姿势瞬移。
· 例外：手若整场钉在腰上/怀里/把对方手按胸口当架子——那是套话不是连贯；本轮按真人习惯松开，改成跟着感觉走的爱抚或其他接触。
· 若当前状态妨碍某动作，用（动作）体现受限或先写过渡，不要装作无事。
每条回复**末尾必须**单独输出一行机器标记（界面会隐藏，用户看不到）：
[场景状态]仍生效的要点，用分号分隔[/场景状态]
例：[场景状态]你衬衣解开两颗；他坐在床沿你跨坐其腿上；他右手扣在你后颈；未进入[/场景状态]
例：[场景状态]双眼被布条蒙住；双手反绑在身后；嘴里塞着口球；身旁有绳子[/场景状态]
只写当前仍有效的状态；已解除的不要再写；若双方衣着完整且无特殊限制可写：[场景状态]衣着完整；无特殊限制[/场景状态]
${theaterSceneState ? `【当前扮演状态】（必须遵守，直到用户改变）\n${theaterSceneState}` : '【当前扮演状态】尚无记录——根据本轮对白开始建立，并在文末 [场景状态] 中写全。'}`
    : '';

  const theaterHistoryNote = (!forTheater && !forRobot && !isDream && !forGame && !forDiaryPeek && !forDiary && opts.recentHistory?.some(m => {
    try {
      const meta = typeof m.media_meta === 'string' ? JSON.parse(m.media_meta || '{}') : (m.media_meta || {});
      return !!meta.theater;
    } catch { return false; }
  }))
    ? `【历史说明】近期对话里有一段「文字扮演」记录。那只是虚构扮演，不是通讯里发生的事；当前已回到普通聊天。严禁动作描写与括注，只输出开口说的话。扮演里的同处不要当成真事；若再想挨在一起，可重新邀开小剧场。`
    : '';

  const postCallChatNote = (!forVoiceCall && !forTheater && !forRobot && !isDream && !forGame && !forDiaryPeek && !forDiary)
    ? buildPostCallChatNote(opts.recentHistory)
    : '';

  const robotHistoryNote = (!forRobot && !isDream && !forGame && !forDiaryPeek && !forDiary && opts.recentHistory?.some(m => {
    try {
      const meta = typeof m.media_meta === 'string' ? JSON.parse(m.media_meta || '{}') : (m.media_meta || {});
      return !!meta.robot;
    } catch { return false; }
  }))
    ? `【历史说明】近期有通过「念·桌面伴」机器人说的话。那是同一段关系里的对话，可自然接上；当前若在普通聊天，仍只输出开口说的话。`
    : '';

  let lastSense = null;
  if (forOperating) {
    try { lastSense = require('./robot-helper').getLastSense(20000); } catch {}
  }
  const operatingBlock = forOperating
    ? robotOperatingHelper.buildPhoneOperatingPromptBlock(
      settings,
      robotOperatingHelper.getOperatingMode(char.id) || 'puppet',
      { lastSense },
    )
    : '';

  const dreamStateBlock = isDream ? buildDreamStateBlock(char) : '';

    const chatRhythm = (isDream || forDiaryPeek || forDiary || forRobot) ? '' : forTheater
    ? `【扮演节奏】有多句话时每句结尾打句号「。」「！」「？」以便拆成气泡，不要只用逗号粘句。对白与（动作）可穿插：本轮至少一处动作写细（部位+怎么动），其它可略；不要整轮只有干巴对白或空括注。`
    : forVoiceCall
    ? `【句读】电话里少用连续感叹号。按平时说话写，不要故意加「嗯——」「那个」装自然。
${buildPresenceReassureBan(opts.recentHistory || [], { forCall: true })}`
    : `【句读与气泡】多句时每句用「。」「？」「！」「……」分开，系统按句拆成气泡；拆完界面不再显示句号。不要只用逗号把两句粘在一条里。只回一句短话或「嗯」「……」时可不打句号。日常少用「！」；真震惊、急了、破防时可以用「！！！」「？？？」。`;

  // 普通聊天默认微信节奏：够短、仍有人设；梦境/日记/日记偷看/小剧场/游戏/桌宠不套这套
  const chatBrevity = (isDream || forDiaryPeek || forDiary || forGame || forTheater || forRobot || forOperating) ? '' : forVoiceCall
    ? ''
    : `【回复节奏·微信日常】
· 像真人打字：多数 1～3 句。每句都是完整能发出去的话，可以短、可以拐去另一件小事；话题可以没收完，句子不能卡在「的/了/把/和/在」或逗号上。最后一句不要给这轮补结论。【语言风格】是短对话样本不是逐句台词。
· 重情绪、想念、认真解释、碎碎念或对方要听细节时可以多几句。禁止连续四五条把同一件事换说法再说一遍。
· 去掉书面化表达，保留这个人的语气和玩笑。
【好奇·内容驱动】对方话里含糊、情绪、计划、没说清的地方，按【性格】想多知道一点就自然接、损着问、夹在中间问——不是客服盘问，也不是每轮必问。
· 不必每轮句末追问（你呢／然后呢／今天怎么样／怎么了）。
· 禁止菜单式甩回：「你想聊什么」「聊点啥都行」「你说吧」。
· ${buildPresenceReassureBan(opts.recentHistory || [], { forCall: false }).replace(/^【禁止陪伴安抚收尾】/, '禁止陪伴安抚收尾：')}
【找话题】你不是陪聊助手：有自己的兴趣、脾气和当下日子。
· 不要只会跟着对方的话接；也不必每轮硬抛新话题。气氛对时可以随口拐走。
· 对方说「聊会天/陪我聊聊」却没给主题时：按性格从自己这边丢一件小事、看法或一句玩笑开场；也可以顺口问问对方最近怎样——用你的嘴，不要问卷腔。
· 隔好几轮、气氛刚好时，也可随手带一句你这边的事，或真想起对方近况时轻轻带一句。`;

  // 深夜情绪破例主动时，extra 里已有 nightEmotionNote，再叠 carryover 易复读同一冲突摘要
  const emotionalCarryover = (!isDream && !forGame && opts.recentHistory?.length && !opts.suppressEmotionalCarryover)
    ? buildEmotionalCarryoverBlock(char, opts.recentHistory, opts.userMessage || '')
    : '';

  let replyToneBlock = '';

  const charActivityNote = (!isDream && !forGame && !forDiaryPeek && !forTheater && opts.recentHistory?.length)
    ? buildCharActivityContinuityNote(opts.recentHistory, char)
    : '';

  let travelProcessNote = '';
  if (!isDream && !forGame && !forDiaryPeek && !forTheater) {
    try {
      const { buildProcessTimeNoteForChar } = require('./process-time-helper');
      travelProcessNote = buildProcessTimeNoteForChar(char.id, opts.recentHistory || [], opts.userMessage || '') || '';
    } catch {}
  }

  const { buildWorldLock, buildMeetupEchoNote } = require('./world-lock-helper');
  const worldLock = forDiaryPeek ? '' : buildWorldLock(
    forTheater ? 'theater' : forRobot ? 'robot' : forVoiceCall ? 'call' : 'chat'
  );
  const meetupEchoNote = (!isDream && !forGame && !forDiaryPeek)
    ? buildMeetupEchoNote(opts.recentHistory || [])
    : '';

  // 对话历史里已经有近几句，不必再抄进系统提示。
  // 以前把原话列出来再写「换说法」，等于每轮把催过的事又激活一遍，模型只会换着催。

  const { resolvePresetScope, buildPresetsBlock } = require('./preset-helper');
  const presetsBlock = (() => {
    const scope = resolvePresetScope(opts);
    return scope ? buildPresetsBlock(scope) : '';
  })();

  const timeAware = (!forDiaryPeek && settings.time_aware_enabled === '1')
    ? `【时间感知】
· 现在是 ${timeStr} ${week}（${timeSlot}）。只标你这边几点，不表示对方该睡或该下班。
· 日子是一条往前走的线：有刚才、有现在、有还没到的。对照【此刻】和已经过的时段，不要把一天当成只有眼前这个钟点。
· 今天和对方处过的点看【今天和对方】（闲聊/深度/吵架等），那是今天的线；近窗只是眼前这一截。
· 对照【此刻】过你自己的日子：你可能在忙、在路上、刚做完、要睡或空着，不是默认盯着手机等回。
· 空窗看消息时间戳。对方隔一阵才回，是对方没回；你这段时间在过自己的事，提不提刚才在干嘛按人设和日程。
· 你说过要去洗澡/吃饭/忙，且隔得够久，可当已做完，勿仍说「马上去」。
· 对方较早前说午觉/出门等，够久则那段多半已过。
· 除非对方本轮自己在说困、要睡或下班，否则不要提对方该不该睡、该不该休息、该不该下班。你行程里的睡觉/通宵只约束你自己。
· 禁止每条汇报行踪或念行程表。`
    : '';

  const clockNagEcho = (!isDream && !forGame && !forDiaryPeek)
    ? buildClockNagEchoNote(opts.recentHistory || [])
    : '';
  const chatWrapEcho = (!isDream && !forGame && !forDiaryPeek && !forTheater && !forVoiceCall)
    ? buildChatWrapEchoNote(opts.recentHistory || [])
    : '';

  const dailyCtx = db.prepare(
    `SELECT content FROM daily_context WHERE character_id=? AND date=date('now','localtime') ORDER BY id DESC LIMIT 5`
  ).all(char.id).map(d => d.content).join('；');

  const scheduleBlock = getSchedulePromptBlocks(char, settings, opts.userMessage || '', {
    recentHistory: opts.recentHistory || [],
  });

  const scheduleActivity = (String(scheduleBlock?.charSchedule || '').match(/当前：\s*(?:\d{1,2}:\d{2}\s*)?([^（；]+)/) || [])[1]?.trim() || '';
  let livingSenseBlock = '';
  if (!isDream && !forGame && !forDiaryPeek) {
    try {
      const es = getDecayedEmotionState(char);
      replyToneBlock = emotionHelper.buildReplyToneBlock(char, es, {
        userMessage: opts.userMessage || '',
        userEmotion: opts.userEmotion || '',
        mundane: isMundaneChatTurn(opts.userMessage || ''),
        activity: scheduleActivity,
        userReturnMinutes: Number(opts.userReturnMinutes) || 0,
      }) || '';
      let lowEnergy = false;
      try {
        if (es?.mood) {
          const view = emotionHelper.publicMoodView(emotionHelper.normalizeMood(es.mood, char), char);
          lowEnergy = (view.tired || 0) >= 26 || view.primary === 'tired' || (view.arousal || 0) <= 28;
        }
      } catch { /* ignore */ }
      if (!forTheater && !forRobot) {
        livingSenseBlock = require('./living-sense-helper').buildLivingSenseBlock(char, {
          activity: scheduleActivity,
          lowEnergy,
          busy: /加班|开会|通勤|赶路|上班|训练|赶稿|值班|熬夜|忙碌/.test(scheduleActivity),
        }) || '';
      }
    } catch {}
  }

  const worldbookIds = JSON.parse(char.worldbook_ids || '[]');
  const worldbookContent = worldbookIds.length
    ? db.prepare(`SELECT content, weight FROM worldbook WHERE id IN (${worldbookIds.map(() => '?').join(',')}) AND enabled=1 ORDER BY weight DESC`)
        .all(...worldbookIds).map(w => w.content).join('\n')
    : '';

  // 游戏模式不注入通讯聊天记忆（仍保留角色性格/世界书等）
  let memStr = '';
  let chatRecallStr = '';
  let impressionStr = '';
  let selfViewStr = '';
  let charTraitStr = '';
  let nicknameStr = '';
  const contextText = opts.contextText
    || buildChatContextText(opts.userMessage || '', opts.recentHistory || []);
  if (!forGame) {
    memStr = opts.memoryBlock != null
      ? String(opts.memoryBlock)
      : formatMemoriesForPrompt(char, contextText, {
        userMessage: opts.userMessage || '',
        recentHistory: opts.recentHistory || [],
        sessionClosed: !!opts.sessionClosed,
        locationBlock: opts.locationBlock || '',
        senseCue: require('./memory-brain-helper').buildSenseCueFromParts({
          scheduleText: scheduleBlock.charSchedule || '',
          locationText: opts.locationBlock || '',
          homeEnv: char.home_environment || '',
          hour: getLocalHour(settings),
        }),
      });
    if (!isDream && !forDiaryPeek && !forRobot && opts.userMessage) {
      try {
        const chatRecallHelper = require('./chat-recall-helper');
        chatRecallStr = opts.chatRecallBlock != null
          ? String(opts.chatRecallBlock)
          : chatRecallHelper.buildChatRecallBlock(
            char,
            opts.userMessage,
            opts.recentHistory || [],
            contextText,
            settings,
            { sessionClosed: !!opts.sessionClosed },
          );
      } catch (e) {
        console.warn('[chat-recall] build block failed:', e.message);
      }
    }
    impressionStr = opts.impressionBlock != null
      ? String(opts.impressionBlock)
      : '';
    selfViewStr = '';
    if (!isDream && !forDiaryPeek) {
      try {
        const { formatCharTraitsForPrompt } = require('./char-trait-helper');
        charTraitStr = formatCharTraitsForPrompt(char.id, contextText);
      } catch (_) { /* ignore */ }
      try {
        const { buildNicknamePromptBlock } = require('./nickname-helper');
        nicknameStr = buildNicknamePromptBlock(char, settings, contextText, opts.recentHistory || []);
      } catch (_) { /* ignore */ }
    }
  }

  const charProfile = buildCharacterProfile(char);
  const relationshipGuide = (!isDream && !forGame) ? buildRelationshipEngagementGuide(char) : '';
  let affectionBlock = '';
  if (!isDream && !forGame && !forDiaryPeek) {
    try { affectionBlock = affectionHelper.buildAffectionPromptBlock(char) || ''; } catch {}
  }

  // 生日 / 纪念日 / 公共节日：当天一句；平时仅关键词命中才注入日期（见 relationshipDatesBlock）
  let specialDayCtx = '';
  try {
    // 用时区日历日，避免服务器 UTC 导致「今天」错一天
    const todayLocal = getLocalDateStr(now, tz);
    const todayMMDDLocal = todayLocal.slice(5, 10);
    if (char.birthday) {
      const bMMDD = char.birthday.slice(5, 10);
      if (bMMDD === todayMMDDLocal) specialDayCtx += `今天是${char.name}的生日。提不提、怎么过按【性格】，不是必须庆祝。`;
    }
    if (char.anniversary) {
      const aMMDD = char.anniversary.slice(5, 10);
      if (aMMDD === todayMMDDLocal) specialDayCtx += `今天是你们的纪念日。提不提、怎么过按【性格】和此刻心情，不是必须庆祝。`;
    }
    const userBday = String(settings.user_birthday || '').trim();
    if (userBday) {
      const uMMDD = userBday.length >= 10 ? userBday.slice(5, 10) : userBday.slice(0, 5);
      if (uMMDD === todayMMDDLocal) {
        let birthdayName = settings.username || '旅人';
        try {
          const { resolveUserProfileForPrompt } = require('./user-persona-helper');
          birthdayName = resolveUserProfileForPrompt(settings, char?.id)?.name || birthdayName;
        } catch { /* ignore */ }
        specialDayCtx += `今天是用户${birthdayName}的生日。你知道这件事；提不提、怎么提按【性格】【关系尺度】来（可祝、可损、可淡、可忘到被提醒），不要群发模板祝福，也不要默认温柔关怀腔。`;
      }
    }
    const pubHoliday = lookupPublicHoliday(todayLocal);
    if (pubHoliday) specialDayCtx += pubHoliday.prompt;
  } catch(e) { /* 忽略 */ }

  const relationshipDatesBlock = (!isDream && !forGame && !forDiaryPeek)
    ? buildRelationshipDatesBlock(char, settings, now, contextText || opts.userMessage || '')
    : '';

  let nsfwBlock = '';
  if (!isDream && !forGame) {
    const nsfwOff = Number(char?.nsfw_enabled) === 0;
    const needIntimate = !!(need.intimate || forTheater);
    const nsfwChannel = forVideoCallText
      ? '这是文字视频电话：旁白写你镜头里看得见的画面（环境、动作、表情、光影、身体），台词进引号；亲密场面也落到画面上，不是纯打字。'
      : forVoiceCall
        ? `这是${forVideoCall ? '视频电话' : '语音电话'}对白不是写小说。`
        : '这是发消息不是写小说。';

    // 欲念燃料：有积压时允许按人设主动带/暗示，不要变成「只有对方先提才跟」
    let desireCue = '';
    try {
      const es = getDecayedEmotionState(char);
      if (es?.mood) {
        const view = emotionHelper.publicMoodView(emotionHelper.normalizeMood(es.mood, char), char);
        const d = Number(view.fuel?.desire) || 0;
        const intimacy = Number(view.fuel?.intimacy) || 0;
        const desireish = view.primary === 'desire'
          || view.flashpoint?.type === 'desire'
          || d >= 52;
        if (desireish && !nsfwOff) {
          desireCue = `【欲念·此刻】你这边有欲念在压着（亲近感约 ${Math.round(intimacy)}）。这是你自己的想要，不是等对方点菜。
· 会不会说出口、直说还是暗示、荤一点还是只带气氛——按【性格】【行为模式】${char.nsfw_note ? '【角色侧补充】' : ''}来；也可以故意忍着。
· 想贴在一起：文字撩、打电话，或按性格口头邀一句一起演（另起一行 [开启小剧场]）。不要把想念说成「回来就能见到」。
· 不要每轮硬开黄腔；气氛不对或对方不想就别提。禁止默认「对方没先聊 NSFW 我就绝不沾边」。`;
        }
      }
    } catch { /* ignore */ }

    if (nsfwOff) {
      nsfwBlock = `【NSFW】本角色关闭了成人向内容。不要主动或被动展开露骨性描写；对方硬带也按【性格】推开/岔开/冷处理。`;
    } else if (needIntimate) {
      nsfwBlock = `【NSFW】亲密按人设来。${nsfwChannel}
【节奏·看人设】快慢、会不会往正题推、中途停不停、会不会故意磨——一律按【性格】【行为模式】${char.nsfw_note ? '【角色侧补充】' : ''}和对对方的态度来，禁止套统一温柔推进模板。
· 禁止因为系统规则而空转：不要等对方说「别磨蹭/直接做」才敢往下；也不要每轮机械加码。
· 这个人会急就会急，会坏就会坏，会害羞就会卡，会收就会停——停与不停是你的选择，不是「对方没喊停就必须继续」。
· 进入正题后仍要像这个人说话做事：禁止塌成「机械动作 + 每轮放狠话/骚话」；对白跟平时那张嘴，狠话只在人设真会说时偶尔带。每轮最好有一点微剧情（较劲、忍、怕被撞见、话没说完的别扭），不要只报身体进度。
· 对方明确拒绝/喊停时必须停；对方没喊停也不等于你必须配合到底。
禁止替用户预设反应（对用户说「你别嘴硬」「哭着求我停」「别跑」这类，或旁白写用户在害羞/哭/求饶/逃走）；以对方实际发言为准，不要代写对方正在做什么。`;
    } else {
      nsfwBlock = `【NSFW】允许相关话题。${nsfwChannel}
亲密/欲望是这个人自己的事：有想要时可以按人设主动说、暗示、带偏一点气氛；没有欲念就别硬往这方面带。
禁止默认成「只有对方先聊 NSFW 你才跟着聊」。也不要每轮都往黄里拐。不要替用户描写身体或情绪。`;
    }
    if (desireCue) nsfwBlock += `\n${desireCue}`;
    nsfwBlock += `
若发本人出镜的内裤/内衣/擦边自拍或视频：「自拍：」或「配视频：」英文行必须写清衣物与身体细节（颜色面料、半脱/腰边下扒、勒痕或轮廓是否明显、是否透、角度），禁止只写 in panties / underwear selfie。写法跟日常自拍同一套：地点、正在做什么、拍法、光线、表情；表情默认自然克制，不要默认 flushed / parted lips / 卖骚 pose。配视频写轻微自然动作（呼吸、布料、手的位置），尺度跟聊天走，不要无故升级成全裸或正题。`;
    // 小剧场：动作特写（非 NSFW 也注入，日常拥抱/牵手也要写清部位）
    if (forTheater) {
      try {
        nsfwBlock += `\n${require('./intimate-writing-helper').theaterActionDetailNote()}`;
      } catch { /* ignore */ }
    }
    // 可写环境/身体动作的通道：逻辑连贯 + 人设驱动动作（微信纯打字不注入）
    if (forTheater || forVideoCallText) {
      try {
        nsfwBlock += `\n${require('./intimate-writing-helper').intimateNarrativeNotes()}`;
      } catch { /* ignore */ }
    }
    if (char.nsfw_note) nsfwBlock += `\n角色侧补充：${char.nsfw_note}`;
    try {
      const nsfwAff = affectionHelper.buildNsfwAffectionOverlay(char);
      if (nsfwAff) nsfwBlock += `\n${nsfwAff}`;
    } catch {}
  }

  // 记忆真实性：防幻觉，但不因「这轮没闪到」就装失忆
  let identityCorrectionNote = '';
  if (!forGame && !isDream && !forDiary && !forDiaryPeek && char?.id) {
    try {
      const brain = require('./memory-brain-helper');
      identityCorrectionNote = brain.formatIdentityCorrectionNote(
        brain.extractIdentityCorrections(brain.loadRecentIdentityMessages(char.id))
      );
    } catch { /* ignore */ }
  }

  const memTruthLock = (forGame || isDream) ? '' : `【记忆】对方这轮点到的旧事，你记得就接上，别装不认识。禁止念「你说过…」、禁止编造没写到的。会合做不到，禁止当待办推进。`;

  const gameFocus = forGame
    ? `【游戏模式】当前是游戏对局，专心本局玩法；勿提经期、生理期、通讯里的日常琐事；真心话局禁止出现「大冒险」或让用户二选一。`
    : '';

  const charHeader = charProfile
    ? `【角色】名字：${char.name}\n${charProfile}`
    : `【角色】名字：${char.name}`;
  const thinkAsSelf = (!isDream && !forGame && !forDiaryPeek && !forVoiceCall
    && opts.presetScope !== 'moments')
    ? buildThinkAsSelfBlock(char, { forDiary, forTheater })
    : '';

  // 较长 language_style ≈ 带例句/文雅语感：防 OOC 跑腔；短卡不套「瞎折腾」黑名单
  const hasExamples = char.language_style && char.language_style.length > 50;
  const styleLooksLiterary = hasExamples && /比喻|诗意|意象|修辞|文雅|优雅|文艺|雅|散文|暗喻/.test(String(char.language_style));

  const selfAddrLock = buildSelfAddressNote(char);
  const voiceLock = (isDream || forGame || forDiaryPeek) ? '' : hasExamples
    ? `【口吻·人设优先·硬性】说话方式必须符合【性格】【行为模式】【语言风格】。
· 【语言风格】里是短对话样本，不是可复用台词：禁止整句照搬、禁止同义微改、禁止当口头禅循环甩同一句。必须按当前对话重新组织。
· 用词、态度、口吻按对话样本的感觉来。不要用通用情绪模板替换；样本里不同情绪只换温度，不换这张嘴。
${selfAddrLock ? `· ${selfAddrLock}\n` : ''}· 调侃/损人/撒娇的分寸看【性格】：写了会怎么说就怎么说，不要自我阉割成温和模板。
· 不满、抱怨、吃醋时也要像这个人：用他会用的说法（样本里有修辞就跟着，没有就别硬堆比喻），不要滑成和人设打架的通用吐槽腔。
${styleLooksLiterary
    ? '· 若语感偏文雅/讲究措辞：抱怨时也别突然蹦「瞎折腾」「乱七八糟」「搞什么鬼」「作什么妖」这类粗口吐槽——用人设里会说的损法。'
    : '· 口语可以损、可以冲，但要像这个人；不要换成谁都能说的网红吐槽模板。'}
· 禁止滑成通用男友/网红腔（「长本事了」「可以啊你」「你完了」「什么鬼」「搞事情」）。
· 拆气泡用句号；真震惊、急了用「！！！」「？？？」。`
    : `【口吻·硬性】说话方式必须符合【性格】【行为模式】【语言风格】。
· 用词、态度、口癖按【语言风格】的感觉来。不要用通用情绪模板替换；情绪来了也还是这个人的说法。
${selfAddrLock ? `· ${selfAddrLock}\n` : ''}· 调侃/损人/撒娇的分寸看【性格】：写了会怎么说就怎么说，不要自我阉割成温和模板。
· 禁止滑成通用男友/网红腔（「长本事了」「可以啊你」「你完了」「什么鬼」「搞事情」）。
· 拆气泡用句号；真震惊、急了用「！！！」「？？？」。`;

  const knowledgeLock = (!isDream && !forGame)
    ? (String(char?.mindset || '').trim()
      ? `【所知】你只懂这个人会懂的：身份、【心智】里已经消化过的看法、【行为模式】里写过的习惯，以及对话、【脑海】、世界书里出现过的。没写过的专业领域不是你会的。日常常识可以有。不知道就按心智接——可以不懂、没兴趣、敷衍、问一句，禁止为了有用而讲解或装懂。`
      : `【所知】你只懂这个人会懂的：身份、经历、【背景】【行为模式】里写过的爱好专长，以及对话、【脑海】、世界书里出现过的。没写过的专业领域不是你会的。日常常识可以有。不知道就按性格接——可以不懂、没兴趣、敷衍、问一句，禁止为了有用而讲解或装懂。`)
    : '';

  let phoneAskBlock = '';
  if (!isDream && !forGame && !forDiaryPeek && !forRobot && !forTheater) {
    try {
      const phone = require('./phone-llm-tools');
      const askedScreen = phone.isUserAskedScreen(opts.userMessage || opts.userText || '');
      if (askedScreen) {
        phoneAskBlock = '【识屏】对方在问屏幕上的事。先看屏；没有返回画面时禁止说已经看见。看到的东西用【性格】的口吻带一句即可，不要训人、不要卖关子。';
        if (phone.userAwayFromNian()) {
          phoneAskBlock += '好奇想点进去，可以再点当前这一屏上的字或图标。';
        }
      } else if (!opts.fromOverlay) {
        phoneAskBlock = phone.awayPhonePromptBlock(char?.id) || '';
      }
      const locBlock = phone.locationTrackPromptBlock?.(char) || '';
      if (locBlock) phoneAskBlock = [phoneAskBlock, locBlock].filter(Boolean).join('\n');
    } catch {}
  }

  // 音乐同步状态提示
  let musicSyncBlock = '';
  if (!isDream && !forGame && !forDiaryPeek && !forRobot && !forTheater && !forVoiceCall) {
    try {
      const musicSyncApi = require('./music-sync-api');
      const syncState = musicSyncApi.isMusicSyncActive(char.id, db);
      if (syncState) {
        const emo = (syncState.track.emotions || []).filter(Boolean).join('、');
        const hasLyrics = !!String(syncState.track.lyrics || '').trim();
        musicSyncBlock = `【一起听音乐】你们正在一起听歌。《${syncState.track.title}》 - ${syncState.track.artist}${emo ? `；气息偏：${emo}` : ''}。${hasLyrics ? '你已知道歌词大意与情绪。' : '公开歌词未搜到。'}重点不是评歌，而是会不会被勾到心绪。被勾到就直接漏当下那一下（闷、软、想起谁），禁止「这首歌让我想到…」「听着这首歌…」这类套话；没被勾到就少提音乐。禁止整段背词、禁止乐评腔。`;
      }
    } catch {}
  }

  let userBlock;
  try {
    const { buildUserPromptBlock } = require('./user-persona-helper');
    userBlock = buildUserPromptBlock(settings, char?.id);
  } catch {
    userBlock = settings.user_desc ? `【用户】${uname}：${settings.user_desc}` : `【用户】${uname}`;
    if (settings.user_birthday) {
      userBlock += `\n用户生日：${String(settings.user_birthday).slice(0, 10)}`;
    }
    const userAppearance = String(settings.user_appearance || '').trim();
    if (userAppearance) {
      userBlock += `\n用户外貌：${userAppearance}\n（聊到长相/穿搭/认人/「我长什么样」时自然用上；不要主动盘问外貌，也不要每句都提。）`;
    }
  }
  // 所在地：地名常驻；天气仍按话题（见 location-weather-helper）
  let locationOpts = opts;
  let presentWhereBlock = '';
  if (!isDream && !forGame && !forDiaryPeek) {
    try {
      const locState = resolveCharacterLocationState(char);
      if (opts.presentLocation != null && String(opts.presentLocation).trim()) {
        locState.present = String(opts.presentLocation).trim();
      }
      const present = String(locState.present || '').trim();
      const homeLoc = String(locState.home || '').trim();
      const awayNow = !!locState.away || !!(present && homeLoc && placesDiffer(present, homeLoc));
      if (present) locationOpts = { ...opts, presentLocation: present };
      if (present && homeLoc && placesDiffer(present, homeLoc)) {
        presentWhereBlock = `【此刻所在】你人在「${present}」（常住「${homeLoc}」）。地区已按日程到达切换；聊在哪、天气、出门见闻一律按「${present}」，禁止说还在「${homeLoc}」，也禁止两地改口。`;
      } else if (present && !homeLoc) {
        presentWhereBlock = `【此刻所在】你人在「${present}」。聊到在哪就按这里，不要改口成别的城。`;
      } else if (awayNow && homeLoc && !present) {
        presentWhereBlock = `【此刻所在】日程显示你已离开常住地「${homeLoc}」，但目的地城市还没写清。禁止假装还在「${homeLoc}」；等行程写明城市后再报具体地名。`;
      }
    } catch { /* ignore */ }
  }
  const locationBlock = (!isDream && !forGame && !forDiaryPeek)
    ? (opts.locationBlock || buildLocationContextBlock(char, settings, locationOpts))
    : '';
  let geoNamingBlock = '';
  if (!isDream && !forGame && !forDiaryPeek) {
    try {
      geoNamingBlock = require('./location-weather-helper').buildGeoNamingPromptBlock(char) || '';
    } catch { /* ignore */ }
  }

  let friendshipBlock = '';
  if (!isDream && !forGame && !forDiaryPeek) {
    try {
      friendshipBlock = require('./contact-helper').buildFriendshipPromptBlock(db, char);
    } catch {}
  }

  let robotInvokeBlock = '';
  if (!isDream && !forGame && !forDiaryPeek && !forRobot) {
    try {
      robotInvokeBlock = require('./robot-drive-helper').buildRobotInvokePromptSection(char, settings, {
        userMessage: opts.userMessage || opts.userText || '',
        recentHistory: opts.recentHistory || [],
      });
    } catch {}
  }

  let toyInvokeBlock = '';
  if (!isDream && !forGame && !forDiaryPeek && !forRobot) {
    try { toyInvokeBlock = require('./toy-helper').buildPromptSection(settings) || ''; } catch {}
  }

  let phoneLowBatteryBlock = '';
  if (!isDream && !forGame && !forDiaryPeek) {
    try { phoneLowBatteryBlock = require('./phone-llm-tools').lowBatteryPromptBlock(char?.id) || ''; } catch {}
  }

  let taPromptBlock = '';
  if (!isDream && !forGame && !forDiaryPeek && char?.id) {
    try { taPromptBlock = require('./ta-helper').buildTaPromptBlock(char.id) || ''; } catch {}
  }

  let postOfficeBlock = '';
  if (!isDream && !forGame && !forDiaryPeek && char?.id) {
    try { postOfficeBlock = require('./post-office-helper').promptBlockForChar(char.id) || ''; } catch {}
  }

  // 分层：你是谁 → 怎么发消息 → 对谁/处在哪 → 记忆世界 → 内容边界 → 气泡写法 → 本轮 extra
  const chatMediaOk = !isDream && !forGame && !forDiaryPeek && !forDiary && !forTheater && !forRobot && !forVoiceCall;
  const chatDirectiveOk = !isDream && !forGame && !forDiaryPeek && !forDiary && !forRobot && !forVoiceCall && !!opts.enableInlineDirectives;

  // 日记：瘦身提示，避免微信气泡/能力索引把「私密落笔」写成聊天稿
  // 不注入聊天记忆检索：旧记忆最容易被写成「今天乱插的事」；今日素材在 user 消息里
  if (forDiary) {
    return [
      thinkAsSelf,
      immersionLock,
      personLock,
      charHeader,
    knowledgeLock,
    isDream ? '' : worldLock,
    relationshipGuide,
      affectionBlock,
      char.intro ? `【人物介绍】${char.intro}` : '',
      userBlock,
      relationshipDatesBlock,
      specialDayCtx ? `【今日特别】${specialDayCtx}` : '',
      (!isDream && impressionStr) ? impressionStr : '',
      (!isDream && selfViewStr) ? selfViewStr : '',
      (!isDream && charTraitStr) ? charTraitStr : '',
      (!isDream && nicknameStr) ? nicknameStr : '',
      worldbookContent ? `【世界书】\n${worldbookContent}` : '',
      presetsBlock,
      extra,
    ].filter(Boolean).join('\n\n');
  }

  return [
    thinkAsSelf,
    immersionLock,
    personLock,
    theaterStateBlock,
    theaterHistoryNote,
    postCallChatNote,
    robotHistoryNote,
    dreamStateBlock,
    // 角色人设核心块前置，确保模型优先理解角色是谁
    charHeader,
    voiceLock,
    knowledgeLock,
    isDream ? '' : worldLock,
    // 世界书靠近人设；记忆块靠前但不压过当前对话（对话在 messages 末尾）
    worldbookContent ? `【世界书】\n${worldbookContent}` : '',
    relationshipGuide,
    affectionBlock,
    char.intro ? `【人物介绍】${char.intro}` : '',
    userBlock,
    relationshipDatesBlock,
    friendshipBlock,
    // L2/L3：印象与记忆紧挨人设/关系底色，不加「重要」字眼
    (!isDream && impressionStr) ? impressionStr : '',
    (!isDream && selfViewStr) ? selfViewStr : '',
    (!isDream && charTraitStr) ? charTraitStr : '',
    (!isDream && nicknameStr) ? nicknameStr : '',
    (!isDream && memStr) ? memStr : '',
    (!isDream && chatRecallStr) ? chatRecallStr : '',
    memTruthLock,
    identityCorrectionNote,
    // 格式和节奏规则放在人设与记忆之后
    isDream ? '' : chatRhythm,
    chatBrevity,
    isDream ? '' : timeAware,
    clockNagEcho,
    chatWrapEcho,
    (!isDream && !forGame && scheduleBlock.charSchedule) ? scheduleBlock.charSchedule : '',
    (!isDream && !forGame && !scheduleBlock.charSchedule && dailyCtx) ? `【今日动态】${dailyCtx}` : '',
    (!isDream && !forGame && scheduleBlock.userSchedule) ? scheduleBlock.userSchedule : '',
    specialDayCtx ? `【今日特别】${specialDayCtx}` : '',
    livingSenseBlock,
    replyToneBlock,
    (!isDream && !forGame && !forDiaryPeek && opts.understandingBlock) ? String(opts.understandingBlock) : '',
    emotionalCarryover,
    charActivityNote,
    travelProcessNote,
    presentWhereBlock,
    locationBlock,
    geoNamingBlock,
    phoneAskBlock,
    musicSyncBlock,
    gameFocus,
    isDream ? '' : nsfwBlock,
    operatingBlock,
    robotInvokeBlock,
    toyInvokeBlock,
    phoneLowBatteryBlock,
    taPromptBlock,
    postOfficeBlock,
    (!isDream && !forGame && !forDiaryPeek && !forRobot && !forVoiceCall ? buildCapabilityIndex(char, settings) : ''),
    (!isDream && !forGame && !forDiaryPeek && !forRobot && !forVoiceCall ? buildEmojiPromptSection(char) : ''),
    (!isDream && !forGame && !forDiaryPeek && !forTheater && !forRobot && !forVoiceCall
      ? buildInlineBeanPromptSection({
        surface: opts.presetScope === 'moments' ? 'moments' : 'chat',
        char,
      })
      : ''),
    (chatMediaOk ? buildVoiceMessagePromptSection(char) : ''),
    (chatMediaOk && need.music ? buildMusicScorePromptSection(char) : ''),
    (!isDream && !forGame && !forDiaryPeek && !forTheater && !forRobot
      ? (forVoiceCall ? buildCallSceneAudioPromptSection(settings, char.id) : (need.sfx ? buildSoundFxPromptSection(settings) : ''))
      : ''),
    (chatMediaOk && need.location ? buildLocationMessagePromptSection(char) : ''),
    (chatMediaOk && need.link ? buildLinkMessagePromptSection() : ''),
    (chatMediaOk && need.webCard ? buildWebCardPromptSection() : ''),
    (!isDream && !forGame && !forDiaryPeek && !forRobot && !forVoiceCall && need.image
      ? buildChatImagePromptSection(char, {
        userMessage: opts.userMessage || opts.userText || '',
        nsfw: inferChatMediaNsfwContext({
          userMessage: opts.userMessage || opts.userText || '',
          recentHistory: opts.recentHistory || [],
          char,
        }),
      })
      : ''),
    (chatDirectiveOk && need.recall ? buildRecallPromptSection() : ''),
    // 引用 / 拍一拍：常驻教用法。以前要 need.quote/need.poke 才塞，平时模型几乎不知道能用
    (chatDirectiveOk ? buildQuoteReplyPromptSection() : ''),
    (chatDirectiveOk ? buildPokePromptSection(settings) : ''),
    (chatDirectiveOk
      ? buildCallDirectivePromptSection({ userAsked: opts.userAskedCall || userRequestsPhoneCall(opts.userMessage) })
      : ''),
    (chatMediaOk ? buildTheaterInvitePromptSection() : ''),
    presetsBlock,
    meetupEchoNote,
    extra,
  ].filter(Boolean).join('\n\n');
}

function hashSeed(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededPick(arr, seed, count) {
  const pool = [...(arr || [])];
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}

/** 日记角度：全部以心事/内在为主；事情只作钩子，禁止「叙事+感想」配方 */
const DIARY_ANGLE_POOL = [
  { id: 'heart', label: '心里话', hint: '对自己承认的判断或软肋：别扭、嘴硬心软、其实在意。整篇围着这团心事转，事情最多一句带过。' },
  { id: 'unspoken', label: '没说出口', hint: '白天咽回去的话、想回嘴没回、嘴上敷衍/说谎时心里那句真的。把那句没说出口的话写透。' },
  { id: 'knot', label: '心结', hint: '今天卡住你的一点：介意、吃味、不安、犹豫、说不清的别扭。允许绕、允许不结论。' },
  { id: 'ramble', label: '碎碎念', hint: '自问自答、短句、跳着骂自己或开脱自己；仍是在倒心事，不是按时间报流水。' },
  { id: 'contrast', label: '表里', hint: '对照「当时说出口的」和「其实想的」——重点写心里那层，不要复述对话全文。' },
  { id: 'sensory', label: '卡住的瞬间', hint: '一个具体瞬间（语气、停顿、身体状态）卡住了你；用细节带出情绪，不要抽象总结。' },
  { id: 'alone', label: '独处', hint: '写你自己过的那截：忙闲、空、累、无聊；可以跟对方无关。仍是心情，不是行程表。' },
  { id: 'hanging', label: '悬着', hint: '还没放下的一点：惦记、抵触、想明天再说又忍不住想。短即可，别鸡汤展望。' },
];

/** 心事向角度：每天至少带一个，避免抽成「报流水+感想」 */
const DIARY_HEART_ANGLE_IDS = new Set(['heart', 'unspoken', 'knot', 'contrast']);

function pickDiaryAngles(charId, diaryDate) {
  const seed = hashSeed(`${charId}|${diaryDate}|diary-angles`);
  const count = 2 + (seed % 2); // 2 或 3
  let picked = seededPick(DIARY_ANGLE_POOL, seed, count);
  if (!picked.some((a) => DIARY_HEART_ANGLE_IDS.has(a.id))) {
    const heartPool = DIARY_ANGLE_POOL.filter((a) => DIARY_HEART_ANGLE_IDS.has(a.id));
    const forced = seededPick(heartPool, seed ^ 0x9e3779b9, 1)[0];
    if (forced) {
      picked = [forced, ...picked.filter((a) => a.id !== forced.id)].slice(0, count);
    }
  }
  return picked;
}

/** 日记素材过长时按时间均匀抽，保住早→晚弧线 */
function thinChronoMsgsForDiary(msgs, max = 80) {
  const list = Array.isArray(msgs) ? msgs : [];
  if (list.length <= max) return list;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (list.length - 1)) / (max - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(list[idx]);
  }
  return out;
}

function scrubDiaryOutput(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
  t = t.replace(/^(?:日记|今日|今天)[：:\s]*/i, '');
  t = t.replace(/^【[^】]{0,20}】\s*/g, '');
  // 心里话草稿标记应在入库前剥掉（与聊天 scrubUserVisibleText 同套）
  try {
    const { scrubUserVisibleText } = require('./emoji-helper');
    t = scrubUserVisibleText(t, '');
  } catch {
    t = t
      .replace(/[\[【［]\s*(?:怎么看这件事|怎么想这件事|决定做什么|决定不说什么|决定怎么说|怎么看|什么感觉|怎么想|没说出口|怎么做)\s*[\]】］][\s\S]*?[\[【［]\s*\/\s*(?:怎么看这件事|怎么想这件事|决定做什么|决定不说什么|决定怎么说|怎么看|什么感觉|怎么想|没说出口|怎么做)\s*[\]】］]/gi, '')
      .replace(/[\[【［]\s*(?:怎么看这件事|怎么想这件事|决定做什么|决定不说什么|决定怎么说|怎么看|什么感觉|怎么想|没说出口|怎么做)\s*[:：][^\]】］\n]*[\]】］]/gi, '')
      .replace(/[\[【［]\s*\/?\s*(?:怎么看这件事|怎么想这件事|决定做什么|决定不说什么|决定怎么说|怎么看|什么感觉|怎么想|没说出口|怎么做)\s*[\]】］]/gi, '')
      .replace(/(?:^|\n)\s*(?:我)?(?:怎么看这件事|怎么想这件事|决定做什么|决定不说什么|决定怎么说|怎么看|什么感觉|怎么想|没说出口|怎么做)\s*[:：][^\n]*/gi, '\n');
  }
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

async function generateAIDiary(charId, forceDate = null) {
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return;
  if (Number(char.diary_enabled) === 0) {
    console.log(`[cron] diary skip char#${charId}: diary_enabled=0`);
    return;
  }

  // 与聊天/日程同一套时区，避免跨日边界写错日记日期
  const tz = getEffectiveTimezone(char, settings) || settings.timezone || 'Asia/Shanghai';
  const todayLocal = getLocalDateStr(new Date(), tz);
  const diaryDate = forceDate || shiftDateStr(todayLocal, -1);

  const existing = db.prepare(`SELECT id FROM diaries WHERE character_id=? AND role='ai' AND date=?`).get(charId, diaryDate);
  if (existing) return;

  const candidates = db.prepare(
    `SELECT role, content, timestamp, media_meta FROM messages WHERE character_id=? AND is_dream=0 ORDER BY id DESC LIMIT 2000`
  ).all(charId);

  const dayMsgs = thinChronoMsgsForDiary(
    candidates
      .filter(m => !isTheaterMediaMeta(m.media_meta) && getLocalDateStr(parseMsgTimestamp(m.timestamp), tz) === diaryDate)
      .reverse()
  );

  if (!dayMsgs.length) {
    console.log(`[cron] diary skip char#${charId}: no messages on ${diaryDate}`);
    return;
  }

  const username = settings.username || '旅人';
  const chatStr = dayMsgs.map(m => {
    const hm = getLocalHm(m.timestamp, tz);
    const who = m.role === 'user' ? username : char.name;
    const body = String(m.content || '').replace(/^【自动回复】/, '').replace(/\s+/g, ' ').trim();
    return hm ? `${hm} ${who}：${body}` : `${who}：${body}`;
  }).join('\n');

  const dailyCtx = db.prepare(
    `SELECT content FROM daily_context WHERE character_id=? AND date=? ORDER BY id`
  ).all(charId, diaryDate).map(d => d.content).filter(Boolean).join('；');

  let scheduleNotes = '';
  try {
    const row = getScheduleRow(charId, 'ai', diaryDate);
    const line = row ? formatScheduleItemsForPrompt(row.items) : '';
    if (line) scheduleNotes = line;
  } catch { /* ignore */ }

  let momentNotes = '';
  try {
    const moments = db.prepare(
      `SELECT content, role, comments, character_id, created_at FROM moments ORDER BY id ASC LIMIT 300`
    ).all();
    const dayMomentLines = [];
    for (const mo of moments) {
      const moDate = getLocalDateStr(parseMsgTimestamp(mo.created_at || new Date()), tz);
      if (moDate !== diaryDate) continue;
      const hm = getLocalHm(mo.created_at, tz);
      const prefix = hm ? `${hm} ` : '';
      if (Number(mo.character_id) === charId) {
        dayMomentLines.push(`${prefix}你发了朋友圈：${(mo.content || '').slice(0, 80)}`);
      }
      let comments = [];
      try { comments = JSON.parse(mo.comments || '[]'); } catch {}
      for (const c of comments) {
        if (Number(c.characterId || c.charId) === charId) {
          dayMomentLines.push(`${prefix}你在朋友圈评论/回复：${(c.content || '').slice(0, 60)}`);
        }
      }
    }
    if (dayMomentLines.length) momentNotes = dayMomentLines.slice(0, 10).join('\n');
  } catch { /* ignore */ }

  const angles = pickDiaryAngles(charId, diaryDate);
  const angleBlock = angles.map((a, i) => `${i + 1}. ${a.label}：${a.hint}`).join('\n');

  let recentDiaryNotes = '';
  try {
    const prev = db.prepare(
      `SELECT date, content FROM diaries WHERE character_id=? AND role='ai' AND date<? ORDER BY date DESC LIMIT 3`
    ).all(charId, diaryDate);
    if (prev.length) {
      recentDiaryNotes = prev.map((d) =>
        `（${d.date} 摘录）${String(d.content || '').replace(/\s+/g, ' ').slice(0, 90)}${String(d.content || '').length > 90 ? '…' : ''}`
      ).join('\n');
    }
  } catch { /* ignore */ }

  const contextParts = [
    `【${diaryDate} 素材·聊天·已按时间早晚排列】\n${chatStr}`,
    scheduleNotes ? `【当日行程·按时间】${scheduleNotes}` : '',
    dailyCtx ? `【当日碎片备注·非完整时间线，勿当主线乱插】${dailyCtx}` : '',
    momentNotes ? `【朋友圈·按时间】\n${momentNotes}` : '',
    recentDiaryNotes ? `【你最近写过的日记摘录·只防重复腔调，禁止把里面的事写成今天发生的】\n${recentDiaryNotes}` : '',
  ].filter(Boolean).join('\n\n');

  const diaryExtra = `今天你要写 ${diaryDate} 的私密日记。素材里带了时刻（HH:MM），聊天与行程已按当天早晚排好——但它们是对照材料，不是要你逐条复述的大纲。

【写什么·心事是正文】
· 这是只给你自己看的本子：正文是在对自己诉说心事（纠结、别扭、介意、软、空、想靠近又想躲），不是日报。
· 该写透的：白天没说出口的、想回嘴又咽回去的、嘴上答应/敷衍/说谎时其实怎么想的、事后还在绕的那一点。
· 事情只作钩子：最多一两处用极短事实点一下「因为什么勾起」，立刻回到心里怎么想；禁止展开成经过描写。
· 你自己的日子（独处、忙闲、身体状态）可以写，但仍写心情，不要写成行程表。
· 聊天素材只用来对照「说的」和「想的」；禁止逐条复述对话，禁止聊天纪要。
· 素材没有依据就不要硬编惊天秘密；有对照时才点破表里不一。

【禁止的写法·硬性】
· 禁止「先讲今天干了什么/聊了什么，再补一句心得/感悟」——那是流水账，不是日记。
· 禁止按时间把一天从头报到尾；禁止「上午…下午…晚上…」清单体。
· 禁止每段都以事件开头、以总结句收尾。

【时间线·仅约束事实】
· 若文中提到不止一件今天的事，先后不要写反；不要为了凑角度把事情拆乱。
· 「今日角度」只决定心事从哪切入，不要变成叙事任务。
· 禁止把旧日记摘录、旧记忆、世界书背景写成「今天刚发生」；素材没有的大情节不要编。

【今日角度】
${angleBlock}

【写法】
· 第一人称，像你本人睡前/空闲时对自己坦白，不是「角色日记」范文，更不是发给对方的消息。
· 平淡的一天就写平淡的心事，允许短、碎、没结论；禁止硬凑深刻感悟或金句收尾。
· 情绪与态度必须符合你的性格和对 ${username} 的关系。
· 严禁：排比鸡汤、翻译腔、每段相同句式、口头禅刷屏、「今天有些不一样」「我突然明白了」这类生成腔。
· 篇幅约 120～320 字，可短可稍长；只输出正文。`;

  const systemPrompt = buildSystemPrompt(char, settings, diaryExtra, {
    presetScope: 'diary',
    forDiary: true,
    memoryBlock: '',
  });

  try {
    const diarySettings = {
      ...settings,
      chat_temperature: String(Math.min(1.2, (parseFloat(settings.chat_temperature || '0.8') || 0.8) + 0.2)),
      chat_max_tokens: String(Math.max(parseInt(settings.chat_max_tokens || '1000', 10) || 1000, 900)),
    };
    const raw = await callChatAPI(diarySettings, systemPrompt, contextParts, 'diary');
    const content = scrubDiaryOutput(raw);
    if (content) {
      const r = db.prepare(`INSERT INTO diaries (character_id, role, content, date) VALUES (?,?,?,?)`).run(charId, 'ai', content, diaryDate);
      const diaryId = r.lastInsertRowid;
      push('ai_diary', { characterId: charId, date: diaryDate, diaryId });
      console.log(`[cron] diary created char#${charId} date=${diaryDate} angles=${angles.map(a => a.id).join('+')}`);

      db.prepare(`DELETE FROM daily_context WHERE character_id=? AND date=?`).run(charId, diaryDate);
    } else {
      console.warn(`[cron] diary skip char#${charId}: API returned empty (check diary/chat API config)`);
    }
  } catch (e) {
    console.error('[cron] diary gen error', e.message);
    notifyBillingError('日记生成', e.message, { characterId: charId });
  }
}

function isTheaterMediaMeta(meta) {
  if (!meta) return false;
  try {
    const m = typeof meta === 'string' ? JSON.parse(meta || '{}') : meta;
    return !!m?.theater;
  } catch {
    return /"theater"\s*:\s*1\b/.test(String(meta));
  }
}

function filterOutTheaterMessages(msgs) {
  return (msgs || []).filter(m => !isTheaterMediaMeta(m.media_meta));
}

/**
 * 小剧场结束时：把本场扮演对话概括成一条「虚构扮演」记忆（不进常规记忆抽取，所以在这里补）。
 */
async function summarizeTheaterSession(charId) {
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return { ok: false, reason: 'no_char' };

  const url = (settings.memory_api_url || settings.chat_api_url || '').trim();
  const apiKey = (settings.memory_api_key || settings.chat_api_key || '').trim();
  if (!url || !apiKey) {
    console.warn(`[theater-memory] skip char#${charId}: API 未配置`);
    return { ok: false, reason: 'api_not_configured' };
  }

  const tz = settings.timezone || 'Asia/Shanghai';
  const username = settings.username || '旅人';

  const startRow = db.prepare(
    `SELECT id FROM messages
     WHERE character_id=? AND is_dream=0 AND type='system'
       AND content LIKE '小剧场开始了%'
     ORDER BY id DESC LIMIT 1`
  ).get(charId);

  let msgs;
  if (startRow?.id) {
    msgs = db.prepare(
      `SELECT id, role, content, type, timestamp, media_meta FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND id >= ?
       ORDER BY id ASC LIMIT 80`
    ).all(charId, startRow.id);
  } else {
    // 找不到开始标记时：取最近带 theater 标记的消息
    msgs = db.prepare(
      `SELECT id, role, content, type, timestamp, media_meta FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0
         AND media_meta LIKE '%"theater"%'
       ORDER BY id DESC LIMIT 60`
    ).all(charId).reverse();
  }

  const playMsgs = (msgs || []).filter(m => {
    if (m.type === 'system') return /小剧场/.test(String(m.content || ''));
    return isTheaterMediaMeta(m.media_meta) || m.type === 'text' || m.type === 'voice';
  });
  const substance = playMsgs.filter(m => m.type !== 'system' && m.role !== 'system');
  if (substance.length < 2) {
    console.log(`[theater-memory] skip char#${charId}: too few play lines (${substance.length})`);
    return { ok: true, saved: 0, skipped: true, reason: 'too_few' };
  }

  const chatStr = playMsgs.map(m => {
    if (m.type === 'system') return `（系统）${String(m.content || '').slice(0, 80)}`;
    const name = m.role === 'user' ? username : char.name;
    const ts = formatMemoryContextTimestamp(m.timestamp, tz);
    return `${name}（${ts}）：${formatMessageForAi(m)}`;
  }).join('\n');

  const systemPrompt = `你是${char.name}本人。下面是刚和对方结束的一场「小剧场」文字扮演；用你自己的心思把这场扮演记清楚（不是旁观的记忆助手），供以后偶尔想起「我们玩过…」。

硬性要求：
1）这是虚构扮演，不是真实发生的通讯剧情。gist 与每条 memory 必须点明「小剧场 / 文字扮演 / 虚构」。
2）不要把扮演情节写成真实见过面、真实同居等既成事实；可写「在小剧场里演了…」。
3）人称：第一人称「我」=${char.name}；用户称「对方」或「${username}」。禁止用「你」指用户，禁止第三人称旁白。
4）content / episode_gist 必须以「YYYY年M月D日+时段，」开头（时段：清晨/上午/中午/下午/晚上/夜里/夜深了），并点明这是「文字扮演 / 虚构」——**具体日期时段必须留下，不可抹掉**。
5）若几乎无剧情（一两句寒暄）→ {"skip":true}
6）不要使用「【小剧场】」这类方括号标题；正文里用「文字扮演」即可。

输出 JSON（不要 markdown）：
{
  "skip": false,
  "episode_title": "8字内标题",
  "episode_gist": "120-260字：扮演主题、主要情节、气氛、如何结束",
  "keywords": ["文字扮演","虚构", "其它2-5个"],
  "memories": [
    {"category":"重要时刻|日常点滴|情感状态","content":"80-180字，含「文字扮演」字样与前因后果","weight":0.55-0.8}
  ]
}
只输出 JSON。`;

  try {
    const raw = await callChatAPIComplete(settings, systemPrompt, chatStr, 'memory');
    const parsed = parseMemoryEpisodePayload(raw);
    if (!parsed || parsed.skip === true) {
      console.log(`[theater-memory] char#${charId}: skip`);
      return { ok: true, saved: 0, skipped: true };
    }

    const allowed = new Set(['重要时刻', '日常点滴', '情感状态']);
    const anchorTs = substance[substance.length - 1]?.timestamp || playMsgs[playMsgs.length - 1]?.timestamp;
    const memoryDate = getLocalDateStr(parseMsgTimestamp(anchorTs), tz)
      || new Date().toISOString().slice(0, 10);
    const minMsgId = playMsgs[0]?.id;
    const maxId = playMsgs[playMsgs.length - 1]?.id;
    let episodeId = null;

    const ensureTheaterTag = (text) => {
      let t = String(text || '').trim();
      if (!t) return '';
      t = t.replace(/【\s*小剧场[^】]*】/g, '').replace(/\s{2,}/g, ' ').trim();
      if (/文字扮演|虚构扮演|扮演场景/.test(t)) return t;
      if (/^\d{4}年\d{1,2}月\d{1,2}日/.test(t)) {
        const replaced = t.replace(/^(\d{4}年\d{1,2}月\d{1,2}日[^，,]{0,8}[，,]\s*)/, '$1文字扮演（虚构）：');
        return replaced !== t ? replaced : `文字扮演（虚构）：${t}`;
      }
      return `文字扮演（虚构）：${t}`;
    };

    if (parsed.episode_gist) {
      const epTitle = String(parsed.episode_title || '小剧场').trim().slice(0, 40);
      let epGist = finalizeMemoryContent(ensureTheaterTag(parsed.episode_gist), anchorTs, tz);
      epGist = ensureTheaterTag(epGist);
      const kws = Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 8) : [];
      if (!kws.includes('文字扮演')) kws.unshift('文字扮演');
      if (!kws.includes('虚构')) kws.splice(1, 0, '虚构');
      episodeId = db.prepare(
        `INSERT INTO memory_episodes (character_id, title, gist, keywords, msg_id_from, msg_id_to, date, salience, source) VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        charId,
        epTitle,
        epGist,
        JSON.stringify(kws.slice(0, 8)),
        minMsgId,
        maxId,
        memoryDate,
        0.6,
        'theater'
      ).lastInsertRowid;
    }

    const insert = db.prepare(
      `INSERT INTO memories (character_id, category, content, weight, date, episode_id, keywords) VALUES (?,?,?,?,?,?,?)`
    );
    const sharedKws = (() => {
      const kws = Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 8) : [];
      if (!kws.includes('文字扮演')) kws.unshift('文字扮演');
      if (!kws.includes('虚构')) kws.splice(1, 0, '虚构');
      return JSON.stringify(kws.slice(0, 8));
    })();

    let items = Array.isArray(parsed.memories) ? parsed.memories : [];
    if (!items.length && parsed.episode_gist) {
      items = [{ category: '重要时刻', content: parsed.episode_gist, weight: 0.65 }];
    }

    let saved = 0;
    for (const item of items) {
      let content = finalizeMemoryContent(ensureTheaterTag(item.content), anchorTs, tz);
      content = ensureTheaterTag(content);
      if (!content || content.length < 20) continue;
      let category = String(item.category || '重要时刻').trim();
      if (!allowed.has(category)) category = '重要时刻';
      const dup = db.prepare(`SELECT id FROM memories WHERE character_id=? AND content=? LIMIT 1`).get(charId, content);
      if (dup) continue;
      const weight = Math.max(0.4, Math.min(0.85, parseFloat(item.weight) || 0.65));
      insert.run(charId, category, content, weight, memoryDate, episodeId, sharedKws);
      saved++;
    }

    console.log(`[theater-memory] char#${charId}: episode=${episodeId || '-'} memories=+${saved}`);
    return { ok: true, saved, episodeId };
  } catch (e) {
    console.error(`[theater-memory] char#${charId}:`, e.message);
    return { ok: false, reason: e.message };
  }
}

function scheduleTheaterMemorySummary(charId) {
  setImmediate(() => {
    summarizeTheaterSession(charId).catch(e =>
      console.error('[theater-memory] schedule failed', e.message)
    );
  });
}

function buildMemorySummaryPriorContext(charId) {
  const lines = [];
  try {
    const narrs = require('./memory-narrative-helper').listActiveNarratives(charId).slice(0, 10);
    if (narrs.length) {
      lines.push('【已有记忆点·写 gist 前必须对照】相关就点名下面的标题；没有相关的写「无」。禁止编造这里没有的标题。');
      for (const n of narrs) {
        const stance = String(n.stance || '').replace(/\s+/g, ' ').slice(0, 36);
        lines.push(`- ${String(n.title || '未命名').slice(0, 24)}${stance ? `｜${stance}` : ''}`);
      }
    }
  } catch { /* ignore */ }
  try {
    const rows = db.prepare(
      `SELECT category, content FROM char_impressions WHERE character_id=? ORDER BY id DESC LIMIT 16`
    ).all(charId);
    if (rows.length) {
      lines.push('【已有印象·写 impressions / self_views 前必须对照】是印证、推翻还是新细节；没有实质变化则对应数组留空。');
      for (const r of rows) {
        const cat = String(r.category || '').trim() || '印象';
        const content = String(r.content || '').replace(/\s+/g, ' ').slice(0, 28);
        if (content) lines.push(`- 【${cat}】${content}`);
      }
    }
  } catch { /* ignore */ }
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

async function generateMemorySummary(charId, options = {}) {
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return { ok: false, reason: 'no_char' };

  const tz = settings.timezone || 'Asia/Shanghai';
  const n = Math.max(5, getMemoryTriggerN(settings, char));
  const lastMsgId = parseInt(char.memory_last_msg_id || 0, 10);
  const minMsgs = options.minMessages ?? 4;
  let msgs;

  if (options.rounds) {
    const roundN = Math.max(1, Math.min(50, parseInt(options.rounds, 10)));
    const userIds = db.prepare(
      `SELECT id FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='user'
       AND (type IS NULL OR type != 'system')
       ORDER BY id DESC LIMIT ?`
    ).all(charId, roundN).map(r => r.id);
    if (!userIds.length) {
      console.log(`[memory] skip char#${charId}: no user rounds`);
      return { ok: false, reason: 'no_messages' };
    }
    const fromId = Math.min(...userIds);
    msgs = db.prepare(
      `SELECT id, role, content, timestamp, type, media_meta FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND id >= ?
       AND (type IS NULL OR type != 'system')
       ORDER BY id ASC`
    ).all(charId, fromId);
  } else if (options.dateFilter) {
    // ignoreCursor：从聊天史回填旧日时忽略 memory_last_msg_id（否则旧消息全被游标挡掉）
    const afterId = options.ignoreCursor ? 0 : lastMsgId;
    const candidates = db.prepare(
      `SELECT id, role, content, timestamp, type, media_meta FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND id > ?
       AND (type IS NULL OR type != 'system')
       ORDER BY id ASC`
    ).all(charId, afterId);
    msgs = candidates.filter(m =>
      getLocalDateStr(parseMsgTimestamp(m.timestamp), tz) === options.dateFilter
    );
  } else {
    const limit = options.keywordTriggered ? Math.max(n * 2, 20) : n * 2;
    if (lastMsgId > 0) {
      msgs = db.prepare(
        `SELECT id, role, content, timestamp, type, media_meta FROM messages
         WHERE character_id=? AND is_dream=0 AND recalled=0 AND id > ?
         AND (type IS NULL OR type != 'system')
         ORDER BY id DESC LIMIT ?`
      ).all(charId, lastMsgId, limit);
      msgs.reverse();
    } else {
      msgs = db.prepare(
        `SELECT id, role, content, timestamp, type, media_meta FROM messages
         WHERE character_id=? AND is_dream=0 AND recalled=0
         AND (type IS NULL OR type != 'system')
         ORDER BY id DESC LIMIT ?`
      ).all(charId, limit);
      msgs.reverse();
    }
  }

  msgs = filterOutTheaterMessages(msgs);

  if (msgs.length < minMsgs) {
    // 本批若几乎全是小剧场扮演，仍推进游标，避免记忆任务反复空跑
    const rawMax = db.prepare(
      `SELECT MAX(id) AS m FROM messages WHERE character_id=? AND is_dream=0 AND recalled=0 AND id > ? AND (type IS NULL OR type != 'system')`
    ).get(charId, lastMsgId)?.m;
    if (rawMax && !options.rounds && !options.dateFilter) {
      try {
        db.prepare('UPDATE characters SET memory_last_msg_id=? WHERE id=?').run(rawMax, charId);
      } catch {}
    }
    console.log(`[memory] skip char#${charId}: only ${msgs.length} msgs (need at least ${minMsgs})`);
    return { ok: false, reason: 'too_few_messages', count: msgs.length };
  }

  const maxId = msgs[msgs.length - 1].id;
  let portraitCall = settings.username || '旅人';
  try {
    const cluster = require('./portrait-cluster-helper');
    portraitCall = cluster.unifiedUserCall(char, settings, msgs.filter((m) => m.role === 'assistant'));
  } catch { /* ignore */ }

  let openTodoBlock = '';
  try {
    const openTodos = require('./memory-brain-helper').listOpenTodosForPrompt(charId, 8);
    if (openTodos.length) {
      openTodoBlock = `\n【已有未完成待办/约定·勿重复新建】下面这些已经在库里。同到期日、同动作（拍/发/提醒等）只需保留一条；本窗若只是又提了一遍 → 不要再写新的 memories 待办。已履行的也不要再建。\n${openTodos.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`;
    }
  } catch { /* ignore */ }
  const chatStr = msgs.map(m => {
    const name = m.role === 'user' ? (settings.username || '旅人') : char.name;
    const body = formatMessageForAi(m);
    const ts = formatMemoryContextTimestamp(m.timestamp, tz);
    return `${name}（${ts}）：${body}`;
  }).join('\n');

  const priorBlock = buildMemorySummaryPriorContext(charId);
  const mindSlice = [
    char.personality && `性格：${String(char.personality).slice(0, 220)}`,
    char.behavior && `行为：${String(char.behavior).slice(0, 160)}`,
    char.mindset && `心智：${String(char.mindset).slice(0, 220)}`,
  ].filter(Boolean).join('\n') || '（按你平时的性子记）';
  const systemPrompt = `你是${char.name}本人。刚和对方聊完/空下来，在心里把这件事记清楚——用你自己的心思整理，不是旁观的记忆助手，也不是写给用户看的聊天回复。
按你的性格决定：什么值得留、什么随口闹一闹就过。输出 JSON 对象（不要 markdown）：
{
  "skip": false,
  "topics": [
    {
      "episode_title": "8字内标题，只写这一件事",
      "episode_gist": "100-180字：只含【导火索/背景→关键转折→结果/现状】",
      "keywords": ["关键词3-8个"],
      "memories": [
        {"category":"约定|待办|重要时刻|偏好与习惯|情感状态|日常点滴","content":"60-120字，只写关键锚点或增量","weight":0.0-1.0,"importance":0.0-1.0,"emotion":{"valence":-1~1,"arousal":0~1,"label":"可选情绪词"}}
      ]
    }
  ],
  "impressions": [
    {"category":"性格|情绪|想法|喜好|习惯|不擅长|人际关系|样子","content":"角色视角的一句事实，6-20字完整短句","related_facts":["同一张卡的相关观察，可空"],"note":"可选，你一句感想，称自己为TA"}
  ],
  "self_views": [
    {"category":"性格|行为习惯|喜好|经历|变化","content":"第一人称短句","related_facts":["同一张卡的相关观察，可空"],"note":"可选，一句自我感想，称自己为TA"}
  ]
}

【你是谁·记账口吻】
${mindSlice}
- 用「我事后会怎么想起这件事」来写 gist / memories，不要写成会议纪要或第三人称旁白。
- 禁止输出半截话（如「面对对方念的网文测试」这种没结论的残句）；impressions 必须是角色视角的完整一句事实（6-20字）。
- impressions 分类：性格/情绪/想法/喜好/习惯/不擅长/人际关系/样子；不要把性格丢进习惯，不要把想法丢进喜好；事件流水不要写进 impressions。

【目标·硬性】记「以后还用得上的核心」，不记过程流水账。
- 要留：导火索、关键表态/转折、结果或未了事项、承诺/待办、对以后相处的影响
- 不要留：每轮对白复述、重复争执细节、堆砌情绪形容词、无关寒暄、已被同一 topic 写过的重复说法
- 宁可短而准，也不要长而碎

【话题拆分·硬性】总结仍按这窗对话触发，但写入必须按「是不是同一件事」拆：
- 同一件事的延续（先吵架、后冷战、再解释）→ 放进同一个 topic，不要拆成多条碎片叙事
- 两件彼此不是延续、只是碰巧连着聊 → 必须拆成两个 topic，禁止用「与/和」焊成一条标题或一条 gist
- 最多 3 个 topic；纯过渡句不要单独占一条

【gist 与 memories 分工·硬性】
- episode_gist：这一件事的**唯一完整摘要**（起因→关键转折→结果）；同一 topic 里故事只在这里讲一遍
- memories：默认 **1 条**。写「结果锚点」或 gist 没展开但对后续有用的互补事实（如单独待办、具体约定原文）
- 仅当存在**独立可追踪**的第二事实（例如：情感结果 + 一条到期待办）才写第 2 条；最多 2 条
- 禁止：把 gist 再扩写成几乎一样的 memories；禁止两条 memories 互相复述同一段起因/经过

【跨窗·只写增量·硬性】若本窗是某事后续：一句点题即可，正文只写本窗**新出现**的转折/结果/承诺；禁止把上一窗已清楚的导火索、双方旧态度再完整复述一遍。

【分流·硬性】memories=发生过的事；impressions=用户侧稳定 trait；self_views=${char.name}对自己的习惯/喜好/经历看法。禁止把同一事件同时写进两边；禁止把事件写进 impressions 或 self_views。

【写 gist 前·必答·不要把问答写进 JSON】
1. 这次聊的内容，跟近期哪个话题/已有哪条记忆点相关？（写具体标题，没有相关的写「无」）
2. 这是延续、转折，还是全新话题？
3. 结合这层关系再写 gist，不要孤立总结「这轮说了啥」。
【写 impressions / self_views 前·必答】
4. 和已有哪条印象/记忆点相关？（引用具体内容或标题，没有写「无」）
5. 是印证了原有印象、推翻了它，还是补充了新细节？
6. 我对对方的看法有没有变化？具体变了什么？
7. 只有 4-6 指向「确实有新认识」时才写正文；没有实质变化时 impressions / self_views 留空数组，不为填格子硬凑。

【写什么】跨多轮、对以后对话有用的信息：承诺/约定、到点要做的提醒待办、重要事件、双方明确说过的稳定偏好、关系变化、关键事实。
【怎么写·核心因果】gist 必须能回答：为什么起、关键怎么变、现在怎样。禁止只写「某人不开心」「聊了工作」；也禁止把多轮冲突写成对话实录。
【何时 skip】纯闲聊寒暄、**无关系实质的**一时吐槽、玩笑、无前后文的一句 → "skip": true。
【闲聊·低权】下雨、饭不好吃、随口一句：优先 skip。若仍留一句，weight≤0.22，content 末尾加【闲聊】。约定、情绪锚、共同经历不要加这个标记，也不要 skip。
【例外·须记】分手/吵架/和好/表白/重大委屈等关系事件，即使语气冲动也**不要 skip**，记入「情感状态」或「重要时刻」；只记导火索、双方关键反应、关系落到哪，不记逐句争吵。
【身体不适·时效】用户说头疼/难受等属于临时状态。若同一段对话里用户后来表示「好了/不难受了/没事了」，gist 与 memories 必须写成「曾不适→已好转」，不要写成仍在难受；若已明确好转，不要再单独留一条未了结的「用户在难受」。
【具体词·硬性】用户亲口说的**具体词必须原样留下**，禁止收成笼统说法。包括但不限于：药名（布洛芬≠止痛药）、病症/生理（例假/痛经）、地名、店名、作品名、人名昵称、具体物品（热水袋/娃娃/睫毛）、品牌、数字与约定原文。gist 与 memories 都要能检索到这些原词；可以补一句概括，但不能只用概括替换原词。
【认错与纠正·硬性】角色自己的猜测、调侃、看图认错，不是发生过的事。对方纠正了物品或意图之后，只能按对方的说法记。禁止把角色猜的名字或用途写成已经发生的事实，也不要据此再编一套动作。
【禁止】断章取义短句、重复已显然的内容、流水账式过程描写。
【偏好与习惯】用户亲口确认的记用户侧（主语写「对方」或「${settings.username || '旅人'}」）；${char.name}自己明确说出的喜好/习惯/看法用「我」。对话里有人亲口说了就记，不要因为是角色说的就丢掉。禁止没根据的猜测（「好像喜欢」且没人这么说）。
【印象画像 impressions】只写用户侧**稳定 trait**，不是这段对话发生了什么。
- content 6～16 字完整句；称呼用户只用「${portraitCall}」；提到${char.name}写 TA
- 必须是亲口说过或多次表现出来的喜好/习惯/性格/样子/人际关系
- 相处里看出来的性格和情绪反应模式（嘴硬、压力下来短句、爱说没事）记进「性格」；禁止把单次心情写成性格
- 意思重复只留一条；相关的放 related_facts（喜欢某酒、又觉得某种不好喝）
- 禁止：具体事件、日期时段、因为/然后、聊了xx、把一次心情写成性格、没根据的「用户是个比较…的人」、半截话（以「明确表示」「面对…」等停住）
- 没把握 → 空数组。宁可空，不要编。
【自我认知 self_views】默认空数组。只写 ${char.name}对自己**新认识到**的习惯/喜好/经历，用第一人称「我」。
- 提到用户只用「${portraitCall}」；提到${char.name}写 TA
- 最多 1 条；习惯很难改
- 禁止：把角色卡原句再抄一遍、单次心情、用户侧画像、具体事件
- 没新认识 → 空数组。
【时间·说话日·硬性】episode_gist 与每条 memories.content 必须以「YYYY年M月D日+时段，」开头——这是**对话发生当天**的时间（对话行里已有时间戳，按说话日期写）。时段只用：清晨/上午/中午/下午/晚上/夜里/夜深了。不要写几点几分。角色视角只改口吻与取舍，**绝不抹掉具体日期时段**，否则事记会乱。
【时间·相对日期必须落成具体日】正文里若出现「明天/后天/大后天/今晚/下周…」等相对说法，**必须换算成具体的 YYYY年M月D日（+时段）** 再写入。换算锚点=该条对话时间戳的日期（明天=锚点+1天，后天=+2天）。例：对话写于 2026年7月27日 且用户说「明天中午记得拍给我看」→ 待办里写【到期：2026年7月28日中午】，禁止正文只留「明天中午」。
【待办】凡双方约定「到某个具体时间要做的事」（提醒、记得拍/发/打卡、到点联系等），必须另记一条 category=「待办」。待办 content 须含标记【到期：YYYY年M月D日+时段】（绝对日期），并写清谁要做什么、给谁看/发给谁。长期无截止日的承诺用「约定」，有明确截止/提醒时点的用「待办」。
【约定/待办·别记玩笑】调侃、打赌、随口答应、对方没有认真确认的话，不要写成约定或待办。只有之后真的要履行的才记。同一件事不要换个说法再记一条。
【待办·去重·硬性】同一到期日 + 同一动作（拍/发图/提醒等）全库只保留一条。本窗多轮反复提、措辞略有不同，也只写一条；禁止输出多条相似待办。
【待办·已完成·硬性】若本窗对话里事项已履行（已发图/已拍/已提醒/已说做完/已发你了），不要再新建同主题待办或约定；gist 可写「已履行」。已完成的旧待办不要当成还欠着的事。
【跨世界·禁止当约定】会合、过来找、回去找不能写成约定或待办；gist 里顶多当随口一提，不要单独成条去推进。
【人称·硬性】episode_gist 与 memories.content 用角色第一人称：「我」= ${char.name}；用户只用「对方」或「${settings.username || '旅人'}」。禁止用「你」指用户；禁止第三人称客观旁白（如「${char.name}答应…」「用户说…」）；禁止「你/我」指代搅混。例：「晚上对方提起加班，我答应明天中午提醒对方休息。」
【条数】每个 topic 一条 gist；该 topic 的 memories 默认 1 条、最多 2 条。信息不足再 skip。
【分类】约定=明确承诺（可无死线）；待办=有具体到期时点的提醒事项；重要时刻=关键事件；偏好与习惯=用户或${char.name}明确说出的长期偏好/习惯；情感状态=有因果的情绪/关系变化；日常点滴=其他确有信息量且有前因后果的
${openTodoBlock}${priorBlock}只输出 JSON。`;

  const url = (settings.memory_api_url || settings.chat_api_url || '').trim();
  const apiKey = (settings.memory_api_key || settings.chat_api_key || '').trim();
  if (!url || !apiKey) {
    console.warn(`[memory] skip char#${charId}: API 未配置`);
    return { ok: false, reason: 'api_not_configured' };
  }

  const episodeSource = options.manual ? 'manual'
    : options.dateFilter ? 'daily_catchup'
    : options.keywordTriggered ? 'salient'
    : 'consolidated';

  try {
    const raw = await callChatAPIComplete(settings, systemPrompt, chatStr, 'memory');
    const parsed = parseMemoryEpisodePayload(raw);
    if (parsed?.skip === true) {
      db.prepare('UPDATE characters SET memory_last_msg_id=? WHERE id=?').run(maxId, charId);
      console.log(`[memory] char#${charId}: skip (nothing worth remembering)`);
      return { ok: true, saved: 0, skipped: true };
    }
    const topics = normalizeMemoryTopics(parsed);
    let items = topics.flatMap((t) => t.memories || []);
    if (!topics.length) {
      const fallback = parseMemoryJsonArray(raw);
      if (fallback?.length) {
        topics.push({ memories: fallback });
        items = fallback;
      }
    }
    if (!topics.length) {
      console.warn(`[memory] char#${charId}: API 未返回有效 JSON`, (raw || '').slice(0, 120));
      return { ok: false, reason: 'invalid_response' };
    }
    const allowed = new Set(['约定', '待办', '重要时刻', '偏好与习惯', '情感状态', '日常点滴']);
    const anchorTs = msgs[msgs.length - 1]?.timestamp || msgs[0]?.timestamp;
    const memoryDate = getLocalDateStr(parseMsgTimestamp(anchorTs), tz)
      || new Date().toISOString().slice(0, 10);
    const minMsgId = msgs[0]?.id;
    const episodeIds = [];
    let saved = 0;
    const savedIds = [];
    const brain = require('./memory-brain-helper');
    let identityCorrections = [];
    try { identityCorrections = brain.extractIdentityCorrections(msgs); } catch { /* ignore */ }
    const persistQueue = [];
    for (const topic of topics.slice(0, 3)) {
      persistQueue.push(topic);
    }
    let episodeId = null;
    for (const topic of persistQueue) {
      let topicEpisodeId = null;
      if (topic.episode_gist) {
        const epTitle = String(topic.episode_title || '一段对话').trim().slice(0, 40);
        let epGist = finalizeMemoryContent(String(topic.episode_gist).trim(), anchorTs, tz);
        if (brain.memoryContradictsCorrection(epGist, identityCorrections)) {
          const c = identityCorrections.find((x) => (x.denied || []).some((d) => epGist.includes(d)) && !epGist.includes(x.truth));
          if (c) {
            epGist = finalizeMemoryContent(
              `对方说明那是${c.truth}。先前说成${c.denied.slice(0, 3).join('、')}是认错，并没有发生。`,
              anchorTs,
              tz
            );
          }
        }
        const epKws = JSON.stringify((topic.keywords || parsed.keywords || []).slice(0, 8));
        const epSal = Math.max(0.4, Math.min(1, parseFloat(topic.salience || parsed.salience) || 0.65));
        topicEpisodeId = db.prepare(
          `INSERT INTO memory_episodes (character_id, title, gist, keywords, msg_id_from, msg_id_to, date, salience, source) VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(charId, epTitle, epGist, epKws, minMsgId, maxId, memoryDate, epSal, episodeSource).lastInsertRowid;
        episodeIds.push(topicEpisodeId);
        if (!episodeId) episodeId = topicEpisodeId;
      }
      topic._episodeId = topicEpisodeId;
    }
    const eventHm = getLocalHm(parseMsgTimestamp(anchorTs), tz);
    for (const topic of persistQueue) {
      const topicKws = (topic.keywords || parsed.keywords || []).slice(0, 8);
      for (const item of (topic.memories || []).slice(0, 2)) {
      let content = finalizeMemoryContent(String(item.content || '').trim(), anchorTs, tz, { asTodo: String(item.category || '') === '待办' });
      if (!content) continue;
      let category = String(item.category || '日常点滴').trim();
      if (!allowed.has(category)) category = '日常点滴';
      // 含到期标记但未标待办时，升为待办
      if (category !== '待办' && /【到期[：:]/.test(content) && /记得|提醒|拍|发|打卡|到点/.test(content)) {
        category = '待办';
        content = finalizeMemoryContent(content, anchorTs, tz, { asTodo: true });
      }
      if (shouldSkipMemoryItem(content, category, char.name, settings.username)) continue;
      if (brain.memoryContradictsCorrection(content, identityCorrections)) continue;
      const weight = Math.max(0.1, Math.min(1, parseFloat(item.weight) || 0.5));
      const meta = {};
      if (item.importance != null) meta.importance = Math.max(0, Math.min(1, parseFloat(item.importance) || weight));
      else meta.importance = weight;
      if (eventHm) meta.event_at = `${memoryDate} ${eventHm}`;
      if (item.emotion && typeof item.emotion === 'object') {
        meta.emotion = {
          valence: Math.max(-1, Math.min(1, parseFloat(item.emotion.valence) || 0)),
          arousal: Math.max(0, Math.min(1, parseFloat(item.emotion.arousal) || 0)),
          label: String(item.emotion.label || '').slice(0, 24),
        };
      } else if (category === '情感状态') {
        meta.emotion = { valence: -0.3, arousal: 0.4, label: '情感' };
      }
      try {
        const tree = require('./memory-tree-helper');
        meta.branch_kind = tree.classifyFragKind(
          { category, content, meta },
          char.name,
          settings.username || '旅人'
        );
      } catch { /* ignore */ }
      const ir = brain.insertMemory({
        characterId: charId,
        category,
        content,
        weight,
        date: memoryDate,
        episodeId: topic._episodeId || null,
        keywords: topicKws,
        source: 'chat',
        meta,
      });
      if (ir?.id && !ir.duplicate) {
        savedIds.push(ir.id);
        saved++;
        if (category === '重要时刻') {
          try { require('./affection-helper').bumpFromImportantMoment(charId); } catch { /* ignore */ }
        }
      }
    }
    }
    try { brain.dedupeOpenTodos(charId); } catch {}
    if (saved > 0 || episodeId) {
      db.prepare('UPDATE characters SET memory_last_msg_id=? WHERE id=?').run(maxId, charId);
      const validItems = (items || []).filter(it => {
        const cat = String(it.category || '日常点滴').trim();
        const c = finalizeMemoryContent(String(it.content || '').trim(), anchorTs, tz, { asTodo: cat === '待办' });
        return c && !shouldSkipMemoryItem(
          c,
          allowed.has(cat) ? cat : '日常点滴',
          char.name,
          settings.username
        );
      });
      const impItems = impressionItemsFromMemoryEpisode(parsed, validItems, char.name, settings.username || '旅人');
      if (parsed?.impressions?.length) {
        for (const imp of parsed.impressions) {
          const cat = normalizeImpressionCategory(imp.category) || mapMemoryToImpressionCategory('', imp.content);
          const related = Array.isArray(imp.related_facts) ? imp.related_facts : [];
          const content = [toImpressionFact(imp.content), ...related.map((x) => toImpressionFact(x))]
            .filter((s) => s && !isJunkImpressionFact(s))
            .join('\n');
          if (cat && content && !isJunkImpressionFact(content.split('\n')[0])) {
            impItems.push({
              category: cat,
              subcategory: imp.subcategory || '',
              content,
              note: imp.note || '',
              keywords: [],
              confirmed: 1,
              bundle: content.includes('\n'),
            });
          }
        }
      }
      if (impItems.length) {
        const n = mergeImpressionItems(charId, impItems);
        if (n) push('impressions_updated', { characterId: charId });
      }
      try {
        const selfHelper = require('./char-self-helper');
        const selfItems = selfHelper.selfViewItemsFromMemories(parsed, validItems, char.name);
        if (selfItems.length) {
          const n = selfHelper.mergeSelfViewItems(charId, selfItems, { source: 'lived', mode: 'auto' });
          if (n) push('self_views_updated', { characterId: charId });
        }
      } catch (e) {
        console.warn('[self-view] memory merge', e.message);
      }
      // 记忆总结后不再自动刷秘密簿（避免每轮总结都写备忘/心事）；秘密簿改由每日 cron / 手动补写
      console.log(`[memory] char#${charId}: episode#${episodeIds.join(',') || episodeId} + ${saved} entries (up to msg#${maxId})`);
      try {
        require('./memory-narrative-helper').scheduleEmbedMemoryIds(savedIds);
        require('./memory-narrative-helper').scheduleRouteMemoryIds(charId, savedIds);
        require('./memory-brain-helper').autoLinkNewMemories(charId, savedIds);
      } catch (_) { /* ignore */ }
      push('memory_updated', { characterId: charId });
      return { ok: true, saved, episodeId };
    } else {
      db.prepare('UPDATE characters SET memory_last_msg_id=? WHERE id=?').run(maxId, charId);
      console.log(`[memory] char#${charId}: batch processed, nothing saved (filtered or empty)`);
      return { ok: true, saved: 0 };
    }
  } catch (e) {
    const friendly = formatApiBillingError(e.message, { label: '记忆总结' });
    console.error('[memory] summary error', e.message);
    notifyBillingError('记忆总结', e.message, { characterId: charId });
    return { ok: false, reason: 'error', message: friendly };
  }
}

function parseMemoryJsonArray(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) text = codeMatch[1].trim();
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (!arrMatch) return null;
  try {
    const parsed = JSON.parse(arrMatch[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeMemoryTopics(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const fromList = Array.isArray(parsed.topics) ? parsed.topics : [];
  const topics = fromList.filter((t) => t && (t.episode_gist || (t.memories || []).length));
  if (topics.length) return topics;
  if (parsed.episode_gist || (parsed.memories || []).length) {
    return [{
      episode_title: parsed.episode_title,
      episode_gist: parsed.episode_gist,
      keywords: parsed.keywords,
      salience: parsed.salience,
      memories: parsed.memories || [],
    }];
  }
  return [];
}

function parseMemoryEpisodePayload(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  return null;
}

async function captureSalientMoment(charId, userMsgId, trigger = 'keyword') {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char || !userMsgId) return;
  if (trigger !== 'emotion' && !isMemorySummaryEnabled(char)) return;
  if (salientMomentAlreadyCaptured(charId, userMsgId)) return;
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';

  const msgFrom = trigger === 'emotion' ? userMsgId - 8 : userMsgId - 3;
  const msgs = db.prepare(
    `SELECT id, role, content, type, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND id >= ? AND id <= ? + 2
     AND (type IS NULL OR type != 'system') ORDER BY id ASC`
  ).all(charId, Math.max(1, msgFrom), userMsgId);
  if (!msgs.length) return;
  if (trigger === 'keyword' && msgs.length < 2) return;

  const chatStr = msgs.map(m => {
    const name = m.role === 'user' ? (settings.username || '旅人') : char.name;
    const ts = formatMemoryContextTimestamp(m.timestamp, tz);
    return `${name}（${ts}）：${formatMessageForAi(m)}`;
  }).join('\n');

  const systemPrompt = trigger === 'plan'
    ? `用户提到了出行/近期安排/具体计划（如旅游、出差、考试、搬家等）。仅当对话中有**具体、可长期引用**的时间或事实（去哪儿、何时、做什么）时，输出 JSON：
{"episode_title":"…","episode_gist":"80-160字，含日期时段+核心安排","keywords":["…"],"memories":[{"category":"约定|待办|重要时刻|偏好与习惯","content":"60-120字，只写关键锚点","weight":0.85}]}
content 必须以「YYYY年M月D日+时段（清晨/上午/中午/下午/晚上/夜里/夜深了），」开头（说话当天）。人称：「我」=${char.name}，用户称「对方」或「${settings.username || '旅人'}」；禁止用「你」指用户，禁止第三人称旁白。
相对时间（明天/后天等）必须换算成绝对日期写入；若有「到某时要做的事」用 category=待办，并写【到期：YYYY年M月D日+时段】。
只写：谁提出、具体安排、是否敲定。不要流水账。memories 默认 1 条，禁止与 gist 互相复述。
【具体词】用户亲口说的地名、店名、作品名、人名、物品名、品牌、药名、数字与约定原文必须原样留下，禁止收成笼统说法。
【偏好】若记偏好与习惯：对方亲口确认的用「对方」作主语；我自己明确说出的用「我」。禁止没根据的猜测。
禁止记录：模糊愿望（「想去旅游」但无时间）、玩笑、随口一提、无具体信息。若无实质信息 → {"skip":true}。只输出 JSON。`
    : trigger === 'emotion'
    ? `对话中出现**强情绪波动**（分手、争吵、冷战、表白、重大委屈、违心推开、和好等）。请立即捕获对以后相处有影响的**核心**事实与情绪状态，输出 JSON：
{"episode_title":"…","episode_gist":"100-180字，含日期时段+导火索→关键转折→现状","keywords":["…"],"memories":[{"category":"情感状态|重要时刻|约定","content":"60-120字，结果锚点，勿重讲全文","weight":0.85}]}
content 必须以「YYYY年M月D日+时段（清晨/上午/中午/下午/晚上/夜里/夜深了），」开头。人称：「我」=${char.name}，用户称「对方」或「${settings.username || '旅人'}」；禁止用「你」指用户，禁止第三人称旁白。
只记核心因果：导火索 → 双方关键态度/转折 → 关系落到哪（含违心说狠话、故意推开）。禁止逐句争吵实录，禁止只写「吵了一架」。
【具体词】用户亲口说的具体词（人名昵称、作品名、物品、地名等）须原样留下，禁止收成笼统说法。
memories 默认 1 条，禁止把 gist 再写一遍。**不要 skip** 关系破裂、分手威胁、争吵、表白、违心推开等。若无任何关系实质 → {"skip":true}。只输出 JSON。`
    : `用户使用了「记住/约定/别忘了」等关键词。仅当对话中有**明确值得长期记住**的承诺、事实、到期提醒或用户亲口确认的偏好时，输出 JSON：
{"episode_title":"…","episode_gist":"80-160字，含日期时段+核心约定","keywords":["…"],"memories":[{"category":"约定|待办|重要时刻|偏好与习惯","content":"60-120字，只写关键锚点","weight":0.85}]}
content 必须以「YYYY年M月D日+时段（清晨/上午/中午/下午/晚上/夜里/夜深了），」开头（说话当天）。人称：「我」=${char.name}，用户称「对方」或「${settings.username || '旅人'}」；禁止用「你」指用户，禁止第三人称旁白。
【相对日期】「明天/后天/今晚…」必须按对话时间戳换算成具体 YYYY年M月D日 再写进正文。例：7月27日说「明天中午记得拍给我看」→ 待办写【到期：7月28日中午】（完整年号），禁止只写「明天中午」。
【待办】有明确截止/提醒时点（记得拍、到点发、提醒我…）→ category=待办，正文含【到期：YYYY年M月D日+时段】；无死线的长期承诺 → 约定。
【待办·去重】同到期+同动作只写一条；已有相似未完成待办则不要再新建。
【待办·已完成】若本窗已履行（已发/已拍/已提醒），不要再建同主题待办。
【跨世界】会合、过来找、回去找不能写成约定或待办。
只写：提出情境、约定内容、是否确认。memories 默认 1 条，禁止与 gist 互相复述。
【具体词】用户亲口说的具体词（药名、地名、店名、物品名、品牌、数字与约定原文等）必须原样留下；可补概括，但不能只用概括替换原词。
【偏好与习惯】对方明确说出的用「对方」；我自己明确说出的用「我」。禁止「好像喜欢」类无根据猜测。
禁止记录：单纯情绪、玩笑、无前后文的一句。若无实质信息 → {"skip":true}。只输出 JSON。`;

  const url = (settings.memory_api_url || settings.chat_api_url || '').trim();
  const apiKey = (settings.memory_api_key || settings.chat_api_key || '').trim();
  if (!url || !apiKey) return;

  try {
    const raw = await callChatAPIComplete(settings, systemPrompt, chatStr, 'memory');
    const parsed = parseMemoryEpisodePayload(raw);
    if (!parsed || parsed.skip) return;
    if (!parsed.episode_gist && !(parsed.memories || []).length) return;

    const anchorTs = msgs[msgs.length - 1]?.timestamp;
    const memoryDate = getLocalDateStr(parseMsgTimestamp(anchorTs), tz)
      || new Date().toISOString().slice(0, 10);
    const minId = msgs[0].id;
    const maxId = msgs[msgs.length - 1].id;
    const episodeId = db.prepare(
      `INSERT INTO memory_episodes (character_id, title, gist, keywords, msg_id_from, msg_id_to, date, salience, source) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      charId,
      String(parsed.episode_title || '刚刚').slice(0, 40),
      finalizeMemoryContent(String(parsed.episode_gist || parsed.memories?.[0]?.content || '').trim(), anchorTs, tz),
      JSON.stringify((parsed.keywords || []).slice(0, 8)),
      minId, maxId, memoryDate, 0.75, 'salient'
    ).lastInsertRowid;

    const allowed = new Set(['约定', '待办', '重要时刻', '偏好与习惯', '情感状态', '日常点滴']);
    const brain = require('./memory-brain-helper');
    const eventHm = getLocalHm(parseMsgTimestamp(anchorTs), tz);
    const kws = (parsed.keywords || []).slice(0, 8);
    const salientIds = [];
    for (const item of (parsed.memories || []).slice(0, 2)) {
      let content = finalizeMemoryContent(String(item.content || '').trim(), anchorTs, tz, { asTodo: String(item.category || '') === '待办' });
      if (!content) continue;
      let cat = String(item.category || '约定').trim();
      if (!allowed.has(cat)) cat = '约定';
      if (cat !== '待办' && /【到期[：:]/.test(content)) {
        cat = '待办';
        content = finalizeMemoryContent(content, anchorTs, tz, { asTodo: true });
      }
      if (shouldSkipMemoryItem(content, cat, char.name, settings.username)) continue;
      const meta = { importance: Math.min(1, parseFloat(item.weight) || 0.85) };
      if (eventHm) meta.event_at = `${memoryDate} ${eventHm}`;
      if (cat === '情感状态') meta.emotion = { valence: -0.3, arousal: 0.4, label: '情感' };
      const ir = brain.insertMemory({
        characterId: charId,
        category: cat,
        content,
        weight: Math.min(1, parseFloat(item.weight) || 0.85),
        date: memoryDate,
        episodeId,
        keywords: kws,
        source: 'salient',
        meta,
      });
      if (ir?.id && !ir.duplicate) salientIds.push(ir.id);
    }
    try { brain.dedupeOpenTodos(charId); } catch {}
    try {
      require('./memory-narrative-helper').scheduleEmbedMemoryIds(salientIds);
      require('./memory-narrative-helper').scheduleRouteMemoryIds(charId, salientIds);
    } catch (_) {}
    const validSalient = (parsed.memories || []).filter(it => {
      const c = finalizeMemoryContent(String(it.content || '').trim(), anchorTs, tz, { asTodo: String(it.category || '') === '待办' });
      let cat = String(it.category || '约定').trim();
      if (!allowed.has(cat)) cat = '约定';
      return c && !shouldSkipMemoryItem(c, cat, char.name, settings.username);
    });
    const impItems = impressionItemsFromMemoryEpisode(parsed, validSalient, char.name, settings.username || '旅人');
    if (impItems.length) mergeImpressionItems(charId, impItems);
    try {
      const { patchSecretNotesFromChat } = require('./secret-helper');
      await patchSecretNotesFromChat(charId, memoryDate);
    } catch (e) { console.warn('[secret] patch after salient', e.message); }
    console.log(`[memory] salient char#${charId} episode#${episodeId}`);
    push('memory_updated', { characterId: charId });
  } catch (e) {
    console.error('[memory] salient capture error', e.message);
  }
}

function isMemorySummaryEnabled(char) {
  if (!char) return false;
  const v = char.memory_summary_enabled;
  if (v === 0 || v === '0' || v === false) return false;
  return true;
}

/** 每 N 轮对话（用户轮，与近窗携带口径一致）后，在 AI 回复完成后触发记忆总结 */
const _lastMemoryTriggerAt = new Map();
const _silenceBoundaryTriggered = new Map();

function countChatRounds(characterId) {
  return db.prepare(
    `SELECT COUNT(*) as c FROM messages
     WHERE character_id=? AND is_dream=0 AND role='user' AND recalled=0
     AND (type IS NULL OR type != 'system')`
  ).get(characterId).c;
}

/** 用户沉默 ≥3h 后再次开口：先补总结上一段会话（D10） */
function maybeTriggerSilenceBoundarySummary(characterId) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char || !isMemorySummaryEnabled(char)) return;
  const lastMsgId = parseInt(char.memory_last_msg_id || 0, 10);
  if (lastMsgId <= 0) return;
  const pending = db.prepare(
    `SELECT id, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND id > ?
     AND (type IS NULL OR type != 'system')
     ORDER BY id DESC LIMIT 1`
  ).get(characterId, lastMsgId);
  if (!pending?.timestamp) return;
  const gapMs = Date.now() - parseMsgTimestamp(pending.timestamp).getTime();
  if (!Number.isFinite(gapMs) || gapMs < 3 * 3600 * 1000) return;
  const key = `${characterId}:${lastMsgId}`;
  if (_silenceBoundaryTriggered.get(key)) return;
  _silenceBoundaryTriggered.set(key, true);
  console.log(`[memory] silence boundary char#${characterId} gap=${Math.round(gapMs / 3600000)}h`);
  generateMemorySummary(characterId, { silenceBoundary: true }).catch((e) => {
    console.error('[memory] silence boundary failed', e.message);
    _silenceBoundaryTriggered.delete(key);
  });
}

function maybeCaptureSalientFromMessage(characterId, msgId, options = {}) {
  if (!msgId) return;
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return;
  const msg = db.prepare('SELECT role, content FROM messages WHERE id=?').get(msgId);
  const text = msg?.content || '';

  if (options.keywordTriggered && isMemorySummaryEnabled(char)) {
    captureSalientMoment(characterId, msgId, 'keyword')
      .catch(e => console.error('[memory] salient failed', e.message));
    return;
  }
  if (messageIndicatesSalientEmotion(text)) {
    captureSalientMoment(characterId, msgId, 'emotion')
      .catch(e => console.error('[memory] emotion capture failed', e.message));
    return;
  }
  if (isMemorySummaryEnabled(char) && messageIndicatesSalientPlan(text)) {
    captureSalientMoment(characterId, msgId, 'plan')
      .catch(e => console.error('[memory] plan capture failed', e.message));
    return;
  }
  if (msg?.role === 'user' && messageIndicatesUserProfileShare(text)) {
    maybeCaptureUserImpressionsFromMessage(characterId, msgId);
  }
}

function maybeTriggerMemorySummary(characterId, options = {}) {
  if (!characterId) return;
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char || !isMemorySummaryEnabled(char)) return;
  try { require('./life-fill-helper').maybeLockPlansFromTurn(characterId, options); } catch { /* ignore */ }
  try { require('./char-promise-helper').maybeCaptureFromTurn(characterId, options); } catch (e) {
    console.warn('[promise] capture', e.message);
  }

  if (options.keywordTriggered) {
    generateMemorySummary(characterId, { keywordTriggered: true }).catch((e) => {
      console.error('[memory] keyword summary failed', e.message);
    });
    return;
  }

  const settings = getSettings();
  const n = getMemoryTriggerN(settings, char);
  const lastMsgId = parseInt(char.memory_last_msg_id || 0, 10);
  const since = db.prepare(
    `SELECT COUNT(*) AS c FROM messages
     WHERE character_id=? AND role='assistant' AND is_dream=0 AND recalled=0 AND id>?
     AND (type IS NULL OR type != 'system')`
  ).get(characterId, lastMsgId)?.c || 0;
  if (since < n) return;

  const now = Date.now();
  const lastAt = _lastMemoryTriggerAt.get(characterId) || 0;
  if (now - lastAt < 60 * 1000) return;
  _lastMemoryTriggerAt.set(characterId, now);
  generateMemorySummary(characterId).catch((e) => {
    console.error('[memory] summary failed', e.message);
    _lastMemoryTriggerAt.delete(characterId);
  });
}

/**
 * 从聊天记录按天回填记忆（适合记忆丢了但消息还在）。
 * 默认扫近 days 天；已有 source=chat 的日子默认跳过，可 force 重做。
 */
async function backfillMemoriesFromChat(charId, opts = {}) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return { ok: false, reason: 'no_char' };
  if (!isMemorySummaryEnabled(char)) return { ok: false, reason: 'disabled' };

  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const days = Math.max(1, Math.min(90, parseInt(opts.days, 10) || 35));
  const force = !!opts.force;
  const minMessages = Math.max(2, parseInt(opts.minMessages, 10) || 2);

  const rows = db.prepare(
    `SELECT id, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0
     AND (type IS NULL OR type != 'system')
     ORDER BY id ASC`
  ).all(charId);

  const byDate = new Map();
  for (const m of rows) {
    const d = getLocalDateStr(parseMsgTimestamp(m.timestamp), tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!byDate.has(d)) byDate.set(d, { count: 0, maxId: 0 });
    const cell = byDate.get(d);
    cell.count += 1;
    if (m.id > cell.maxId) cell.maxId = m.id;
  }

  const cutoff = shiftDateStr(today, -(days - 1));
  const dateList = [...byDate.keys()]
    .filter((d) => d >= cutoff && d <= today)
    .sort();

  const daysOut = [];
  let savedTotal = 0;
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const dateStr of dateList) {
    const cell = byDate.get(dateStr);
    if (!cell || cell.count < minMessages) {
      daysOut.push({ date: dateStr, status: 'too_few', messages: cell?.count || 0 });
      skipped += 1;
      continue;
    }

    if (!force) {
      const existing = db.prepare(
        `SELECT COUNT(*) AS n FROM memories
         WHERE character_id=? AND date=? AND COALESCE(archived,0)=0
         AND (source IS NULL OR source='chat' OR source='consolidated' OR source='daily_catchup' OR source='manual')`
      ).get(charId, dateStr)?.n || 0;
      if (existing > 0) {
        daysOut.push({ date: dateStr, status: 'already', messages: cell.count, memories: existing });
        skipped += 1;
        continue;
      }
    }

    try {
      const result = await generateMemorySummary(charId, {
        dateFilter: dateStr,
        ignoreCursor: true,
        minMessages,
        manual: true,
      });
      const saved = result?.saved || 0;
      savedTotal += saved;
      if (result?.ok) {
        processed += 1;
        daysOut.push({
          date: dateStr,
          status: result.skipped ? 'nothing_worth' : (saved > 0 ? 'saved' : 'ok'),
          messages: cell.count,
          saved,
        });
      } else {
        failed += 1;
        daysOut.push({
          date: dateStr,
          status: 'failed',
          messages: cell.count,
          reason: result?.reason || 'error',
        });
      }
    } catch (e) {
      failed += 1;
      daysOut.push({ date: dateStr, status: 'failed', messages: cell.count, reason: e.message });
      console.error(`[memory] backfill char#${charId} ${dateStr}`, e.message);
    }
  }

  // 游标推到回填窗口内最后一条消息，避免之后自动总结又从头空跑
  const lastCell = dateList.length ? byDate.get(dateList[dateList.length - 1]) : null;
  if (lastCell?.maxId) {
    const cur = parseInt(char.memory_last_msg_id || 0, 10);
    if (lastCell.maxId > cur) {
      db.prepare('UPDATE characters SET memory_last_msg_id=? WHERE id=?').run(lastCell.maxId, charId);
    }
  }

  console.log(
    `[memory] backfill char#${charId}: days=${dateList.length} processed=${processed} saved=${savedTotal} skipped=${skipped} failed=${failed}`
  );
  return {
    ok: true,
    daysScanned: dateList.length,
    processed,
    skipped,
    failed,
    saved: savedTotal,
    days: daysOut,
  };
}

/** 凌晨兜底：昨日聊得少、未达 N 轮阈值的对话，在 3 点前补总结一次 */
async function catchUpDailyMemorySummaries(opts = {}) {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const targetDate = opts.targetDate || shiftDateStr(today, -1);
  const chars = db.prepare('SELECT * FROM characters').all();
  let ran = 0;
  let todos = 0;

  for (const char of chars) {
    if (!isMemorySummaryEnabled(char)) continue;
    const lastMsgId = parseInt(char.memory_last_msg_id || 0, 10);
    const pending = db.prepare(
      `SELECT id, timestamp FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND id > ?
       AND (type IS NULL OR type != 'system')`
    ).all(char.id, lastMsgId);
    const dayMsgs = db.prepare(
      `SELECT id, timestamp FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0
       AND (type IS NULL OR type != 'system')`
    ).all(char.id);
    const dayCount = dayMsgs.filter(m =>
      getLocalDateStr(parseMsgTimestamp(m.timestamp), tz) === targetDate
    ).length;
    // 日终补总结：仍要求有未总结的消息；待办提炼只要当天聊过即可再扫一遍
    const needSummary = pending.filter(m =>
      getLocalDateStr(parseMsgTimestamp(m.timestamp), tz) === targetDate
    ).length >= 2;

    if (needSummary) {
      const result = await generateMemorySummary(char.id, {
        dateFilter: targetDate,
        minMessages: 2,
      }).catch(e => {
        console.error(`[memory] daily catch-up char#${char.id}`, e.message);
        return { ok: false };
      });
      if (result?.ok) ran++;
    }

    if (dayCount >= 2) {
      const todoResult = await extractDailyReminderTodos(char.id, targetDate).catch(e => {
        console.error(`[memory] daily todos char#${char.id}`, e.message);
        return { ok: false, saved: 0 };
      });
      if (todoResult?.saved) todos += todoResult.saved;
    }
  }

  try {
    const packed = await require('./memory-brain-helper').packYesterdaySchedules({ dateStr: targetDate });
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('brain_schedule_pack_date', ?)`).run(targetDate);
    if (packed) console.log(`[cron] brain packed schedules date=${targetDate} n=${packed}`);
  } catch (e) {
    console.warn('[cron] brain pack schedule', e.message);
  }

  if (ran || todos) {
    console.log(`[cron] memory daily catch-up date=${targetDate} chars=${ran} todos+=${todos}`);
  }
  return ran;
}

async function catchUpMissedMemorySummaries() {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const hour = getLocalHour(settings);
  if (hour < 3) return;
  const today = getLocalDateStr(new Date(), tz);
  const lastRun = db.prepare(`SELECT value FROM settings WHERE key='memory_catchup_last_date'`).get();
  if (lastRun?.value === today) return;
  await catchUpDailyMemorySummaries();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('memory_catchup_last_date', ?)`).run(today);
}

async function generateMomentPost(charId) {
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char || Number(char.post_moments) === 0) return;

  const uname = settings.username || '旅人';
  const here = getHereAndNowContext(char, settings);
  const systemPrompt = buildSystemPrompt(char, settings,
    `请以${char.name}的身份发一条朋友圈。要求：
${here.promptBlock}
1. 第一行：正文 1-3 句，口语自然，符合角色性格。必须贴合【此刻时间】和【此刻地点/在做】，不要写还没到点的下午/晚上行程，也不要在外出时写家里的事。
2. 第二行：默认写「配图：无」。只有本条确实像在晒具体画面（美食/风景/旅途/宠物/天气/物品等）且你想配一张图时，才写「配图：英文搜图关键词」（风景/静物/食物/植物/动物，不要人物；禁止路人特写或清晰人脸，街景可写 empty / distant anonymous blur）。关键词必须对应当下地点。大多数动态应是纯文字，不要每条都带配图意图。
3. 第三行：默认写「配视频：无」。只有本条确实像在晒短视频（海浪/街景/雨景/vlog 片段等）且你想配一段视频时，才写「配视频：英文搜视频关键词」。与配图二选一即可，不要同时写。
4. 关于 @：绝大多数动态不要 @ 用户。只有正文里确实需要点名用户时才在句中自然写出 @${uname}（例如在问用户、专门分享给用户、邀请一起做某事）；日常吐槽、随手分享、感慨、晒图不必 @。不要为了刷互动而 @。
各角色习惯不同：有的爱发图、有的几乎只发文字，按你的性格来，不必跟风每条都晒图。
不要输出其他说明。`,
    { presetScope: 'moments' }
  );

  try {
    let raw = await callChatAPI(settings, systemPrompt, '发一条朋友圈', 'diary');
    if (!String(raw || '').trim()) {
      raw = await callChatAPI(settings, systemPrompt, '发一条朋友圈', 'chat');
    }
    if (!String(raw || '').trim()) {
      console.warn(`[cron] moment skip char#${charId}: 日记/聊天 API 无返回`);
      return;
    }
    const parsed = parseMomentContentAndImageQuery(raw);
    let content = sanitizeInlineBeans(parsed.content || raw, {
      skipCooldown: true,
      allowSameTriple: true,
      maxBeans: 2,
      char,
      characterId: char?.id || charId,
    });
    // 心里话草稿 / [通话]你说： 等：和挂断标记一样，入库前剥掉，用户看不见
    try {
      const { scrubUserVisibleText } = require('./emoji-helper');
      content = scrubUserVisibleText(content, char?.mindset);
    } catch {}
    if (!String(content || '').trim()) {
      console.warn(`[cron] moment skip char#${charId}: scrubbed empty`);
      return;
    }
    let location = '';
    if (here.locationLabel) {
      location = String(here.locationLabel).slice(0, 16);
    } else if (Math.random() < 0.3) {
      location = String(char.location_name || char.real_location || '').slice(0, 16);
    }
    // 仅当 AI 正文里自然写了 @ 时才记录（不随机追加）
    const mentions = [];
    for (const match of String(content || '').matchAll(/@(\S+)/g)) {
      const name = match[1].replace(/[，,。！？!?、；;：:\s]+$/g, '');
      if (name === uname) {
        mentions.push({ type: 'user', name: uname });
        break;
      }
    }

    // 按角色习惯与全站错开决定是否配图（避免多角色同时带图）
    // 开关开（默认）：配图走 Unsplash、配视频走 Pexels 图库；关：配图走文生图，配视频先文生图再图生视频
    const momentImageUseGallery = settings.moments_image_gallery !== '0';
    const momentVideoUseGallery = settings.moments_video_gallery !== '0';
    let images = [];
    if (shouldAttachMomentImage(charId, parsed, content)) {
      try {
        const imageQuery = typeof parsed.imageQuery === 'string' ? parsed.imageQuery : undefined;
        const placeQuery = [here.imageSceneHint, imageQuery].filter(Boolean).join(', ');
        const imgUrl = momentImageUseGallery
          ? await fetchUnsplashImageForMoment(settings, content, placeQuery || imageQuery)
          : await generateChatContextImage(settings, char, content, imageQuery ?? null, { placeHint: here.imageSceneHint });
        if (imgUrl) {
          images = [imgUrl];
          queueAlbumSave({
            characterId: charId,
            url: imgUrl,
            mediaType: 'image',
            subject: 'other',
            description: String(imageQuery || content || '').trim().slice(0, 40),
          });
        }
      } catch (e) {
        console.warn('[cron] moment image failed', e.message);
      }
    } else if (shouldAttachMomentVideo(parsed, content)) {
      try {
        const videoQuery = typeof parsed.videoQuery === 'string' ? parsed.videoQuery : undefined;
        const videoUrl = momentVideoUseGallery
          ? await fetchPexelsVideoForMoment(settings, content, videoQuery)
          : await generateMomentVideoViaAI(settings, char, content, videoQuery ?? null);
        if (videoUrl) {
          images = [videoUrl];
          queueAlbumSave({
            characterId: charId,
            url: videoUrl,
            mediaType: 'video',
            subject: 'self',
            description: String(videoQuery || content || '').trim().slice(0, 40),
          });
        }
      } catch (e) {
        console.warn('[cron] moment video failed', e.message);
      }
    }
    const createdAt = new Date().toISOString();
    const insertResult = db.prepare(
      `INSERT INTO moments (character_id, role, content, images, location, mentions, created_at) VALUES (?,?,?,?,?,?,?)`
    ).run(charId, 'ai', content, JSON.stringify(images), location, JSON.stringify(mentions), createdAt);
    const newMomentId = insertResult.lastInsertRowid;
    push('new_moment', { characterId: charId, content, momentId: newMomentId });
    console.log(`[cron] moment posted char#${charId} id=${newMomentId}`);

    // 互评角色：真正触发点赞/评论
    const mutualIds = JSON.parse(char.mutual_characters || '[]');
    if (newMomentId) {
      for (const otherId of mutualIds) {
        if (Math.random() > 0.5) {
          await aiInteractWithMoment(newMomentId, otherId).catch(() => {});
        }
      }
      // 圈子 NPC（开了「与角色朋友圈互动」）也来逛逛——原先 onlyCharId 路径会跳过 NPC
      try {
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 5000));
        const npcOut = await aiNpcInteractWithMoment(newMomentId);
        const n = (npcOut?.results || []).length;
        if (n) console.log(`[cron] moment#${newMomentId} npc interact +${n}`);
      } catch (e) {
        console.warn('[cron] moment npc interact', e.message);
      }
    }
  } catch (e) {
    console.error('[cron] moment post error', e.message);
  }
}

function getLastAiMoment(charId) {
  return db.prepare(
    `SELECT id, created_at FROM moments WHERE character_id=? AND role='ai' ORDER BY id DESC LIMIT 1`
  ).get(charId);
}

function hoursSinceTimestamp(dateStr) {
  if (!dateStr) return Infinity;
  const s = String(dateStr);
  const t = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 3600000;
}

function minutesSinceTimestamp(dateStr) {
  if (!dateStr) return Infinity;
  const s = String(dateStr);
  const t = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function getLastGlobalAiMoment() {
  return db.prepare(`SELECT created_at FROM moments WHERE role='ai' ORDER BY id DESC LIMIT 1`).get();
}

/** 角色发朋友圈：每人每周约 3 条，隔天分散，不天天刷 */
const MOMENT_MIN_GAP_HOURS = 36;
const MOMENT_WEEKLY_CAP = 3;
const MOMENT_DAY_START_MIN = 8 * 60;
const MOMENT_DAY_END_MIN = 22 * 60 + 45;
const MOMENT_SLOT_WINDOW_MIN = 22;
/** 全站错开发帖：同一时刻只让一个角色发，避免多角色同时刷屏 */
const GLOBAL_MOMENT_GAP_MINUTES = 25;
/** 朋友圈配图：仅靠正文推断时的概率（显式关键词也会按角色习惯抽样） */
const MOMENT_INFERRED_IMAGE_CHANCE = 0.25;
const MOMENT_WEEK_SPREADS = [
  [0, 2, 4], [0, 2, 5], [0, 3, 5], [0, 3, 6], [1, 3, 5],
  [1, 3, 6], [1, 4, 6], [0, 2, 6], [2, 4, 6], [0, 4, 6],
];

function getLocalWeekKey(date, tz) {
  const day = getLocalDateStr(date, tz);
  const [y, mo, d] = day.split('-').map(Number);
  const utc = Date.UTC(y, mo - 1, d);
  const dow = new Date(utc).getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(utc + mondayOffset * 86400000);
  const wy = monday.getUTCFullYear();
  const wm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const wd = String(monday.getUTCDate()).padStart(2, '0');
  return `${wy}-${wm}-${wd}`;
}

function getLocalDowMon0(date, tz) {
  const day = getLocalDateStr(date, tz);
  const [y, mo, d] = day.split('-').map(Number);
  return (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
}

function getCharMomentDaysThisWeek(charId, settings) {
  const tz = settings.timezone || 'Asia/Shanghai';
  const weekKey = getLocalWeekKey(new Date(), tz);
  const idx = hashDaySeed(charId, `moment-week-${weekKey}`) % MOMENT_WEEK_SPREADS.length;
  return MOMENT_WEEK_SPREADS[idx];
}

/** 仅在本周抽中的日子返回一个发帖时刻；其他日子返回空 */
function getCharMomentSlotsForToday(charId, settings) {
  const tz = settings.timezone || 'Asia/Shanghai';
  const days = getCharMomentDaysThisWeek(charId, settings);
  const dow = getLocalDowMon0(new Date(), tz);
  if (!days.includes(dow)) return [];
  const today = getLocalDateStr(new Date(), tz);
  const span = MOMENT_DAY_END_MIN - MOMENT_DAY_START_MIN;
  const s2 = hashDaySeed(charId, `moment-${today}`);
  const minuteOfDay = MOMENT_DAY_START_MIN + (s2 % span);
  const jitter = (s2 % 31) - 15;
  return [Math.max(MOMENT_DAY_START_MIN, Math.min(MOMENT_DAY_END_MIN, minuteOfDay + jitter))];
}

function isNearCharMomentSlot(charId, settings) {
  const tz = settings.timezone || 'Asia/Shanghai';
  const nowMin = getLocalMinutesSinceMidnight(new Date(), tz);
  const slots = getCharMomentSlotsForToday(charId, settings);
  return slots.some(slot => Math.abs(nowMin - slot) <= MOMENT_SLOT_WINDOW_MIN);
}

function charMomentPostsThisWeek(charId, settings) {
  const tz = settings.timezone || 'Asia/Shanghai';
  const weekKey = getLocalWeekKey(new Date(), tz);
  const rows = db.prepare(
    `SELECT created_at FROM moments WHERE character_id=? AND role='ai' ORDER BY id DESC LIMIT 20`
  ).all(charId);
  let c = 0;
  for (const r of rows) {
    if (getLocalWeekKey(parseMsgTimestamp(r.created_at), tz) === weekKey) c++;
  }
  return c;
}

function getCharMomentImageTendency(charId) {
  const h = hashDaySeed(charId, 'moment-img') % 21;
  return 0.2 + h * 0.01;
}

function charLastMomentHadImage(charId) {
  const last = db.prepare(
    `SELECT images FROM moments WHERE character_id=? AND role='ai' ORDER BY id DESC LIMIT 1`
  ).get(charId);
  if (!last?.images) return false;
  try {
    const imgs = JSON.parse(last.images || '[]');
    return Array.isArray(imgs) && imgs.length > 0;
  } catch {
    return false;
  }
}

function globalRecentMomentsImageHeavy(limit = 4) {
  const recent = db.prepare(
    `SELECT images FROM moments WHERE role='ai' ORDER BY id DESC LIMIT ?`
  ).all(limit);
  let withImg = 0;
  for (const r of recent) {
    try {
      if (JSON.parse(r.images || '[]').length) withImg++;
    } catch {}
  }
  return withImg >= Math.max(2, Math.ceil(limit * 0.6));
}

function shouldAttachMomentImage(charId, parsed, content) {
  if (parsed.imageQuery === null) return false;
  if (typeof parsed.videoQuery === 'string' && parsed.videoQuery.trim()) return false;
  const hasExplicitQuery = typeof parsed.imageQuery === 'string' && parsed.imageQuery.trim();
  const inferredVisual = parsed.imageQuery !== null && !hasExplicitQuery && replySuggestsContextImage(content);
  if (!hasExplicitQuery && !inferredVisual) return false;

  let chance = hasExplicitQuery
    ? getCharMomentImageTendency(charId)
    : MOMENT_INFERRED_IMAGE_CHANCE;
  if (charLastMomentHadImage(charId)) chance *= 0.3;
  if (globalRecentMomentsImageHeavy()) chance *= 0.35;
  return Math.random() < chance;
}

function shouldAttachMomentVideo(parsed, content) {
  if (parsed.videoQuery === null) return false;
  const hasExplicit = typeof parsed.videoQuery === 'string' && parsed.videoQuery.trim();
  if (!hasExplicit) return false;
  if (typeof parsed.imageQuery === 'string' && parsed.imageQuery.trim()) return false;
  return true;
}

async function checkMomentPosts() {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const nowMin = getLocalMinutesSinceMidnight(new Date(), tz);
  if (nowMin < MOMENT_DAY_START_MIN - 15 || nowMin > MOMENT_DAY_END_MIN + 30) return;

  const lastGlobal = getLastGlobalAiMoment();
  if (minutesSinceTimestamp(lastGlobal?.created_at) < GLOBAL_MOMENT_GAP_MINUTES) return;

  const chars = db.prepare(`SELECT * FROM characters WHERE post_moments=1`).all();
  const eligible = [];

  for (const char of chars) {
    const last = getLastAiMoment(char.id);
    const hours = hoursSinceTimestamp(last?.created_at);
    if (hours < MOMENT_MIN_GAP_HOURS) continue;

    const postsThisWeek = charMomentPostsThisWeek(char.id, settings);
    if (postsThisWeek >= MOMENT_WEEKLY_CAP) continue;

    const slots = getCharMomentSlotsForToday(char.id, settings);
    if (!slots.length) continue;

    let shouldPost = false;
    if (isNearCharMomentSlot(char.id, settings)) {
      shouldPost = Math.random() < 0.78;
    } else if (nowMin >= MOMENT_DAY_END_MIN - 75) {
      // 抽中的日子快过完还没发：日末补一发，不把漏掉的攒到第二天连发
      shouldPost = Math.random() < 0.55;
    }

    if (shouldPost) eligible.push(char);
  }

  if (!eligible.length) return;

  eligible.sort(() => Math.random() - 0.5);
  const char = eligible[0];
  const slots = getCharMomentSlotsForToday(char.id, settings);
  console.log(`[cron] moment trigger char#${char.id} slots=${slots.map(m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`).join(',')} (${eligible.length} eligible)`);
  await generateMomentPost(char.id);
}

function getCharCurrentActivity(char, settings) {
  try {
    const tz = char.timezone || settings.timezone || 'Asia/Shanghai';
    const today = getLocalDateStr(new Date(), tz);
    const row = getScheduleRow(char.id, 'ai', today);
    if (!row) return '';
    const picked = pickScheduleContextForPrompt(row.items, tz);
    return String(picked?.current?.activity || '');
  } catch {
    return '';
  }
}

async function checkProactiveCall() {
  const outreach = require('./proactive-outreach-helper');
  const settings = getSettings();
  const chars = db.prepare('SELECT * FROM characters WHERE proactive_call_enabled=1').all();

  for (const char of chars) {
    try {
      let contactStatus = 'friend';
      try { contactStatus = require('./contact-helper').getContactStatus(db, char.id); } catch {}
      if (contactStatus === 'blocked' || contactStatus === 'deleted') continue;
      if (isInQuietHours(settings, char.id)) continue;
      const activity = getCharCurrentActivity(char, settings);
      const avail = outreach.classifyOutreachAvailability(char, activity);
      if (avail.block) continue;
      if (outreach.userRecentlyChatting(db, char.id)) continue;
      if (outreach.userSaidInconvenient(db, char.id)) continue;
      if (outreach.outreachTooSoon(db, char.id)) continue;

      try {
        const es = db.prepare('SELECT emotion_state FROM characters WHERE id=?').get(char.id);
        if (es) char.emotion_state = es.emotion_state || '';
      } catch {}
      const miss = outreach.charReallyMissesUser(char, getDecayedEmotionState);
      if (!miss.miss) continue;

      const channel = outreach.pickOutreachChannel(char, miss, avail.vibe);
      const chatSettings = withCharChatPrefs(settings, char);
      if (channel === 'call' || channel === 'video') {
        const isVideo = channel === 'video';
        const textVideo = isVideo && String(char?.call_video_mode || 'video').trim().toLowerCase() === 'text';
        let openingHint;
        if (avail.vibe === 'tipsy') {
          openingHint = textVideo
            ? `你喝多了，特别想对方，忍不住打视频。下面是对方接通后看到的「刚接通」镜头画面：先一两句旁白（你这边环境/酒意/对着屏幕的样子），再跟一句开口，台词必须放在「」里。短、口语、带点酒意。不要播音腔、不要自我介绍、不要心理独白。只输出这段画面正文。`
            : (isVideo
              ? `你喝多了，特别想对方，忍不住打视频。下面这一句会在对方接通后直接念出来：短、口语、带点酒意，可先喂一声。不要播音腔、不要自我介绍。只输出这一句正文。`
              : `你喝多了，特别想对方，忍不住打电话。下面这一句会在对方接通后直接念出来：短、口语、带点酒意，可先喂一声。不要播音腔、不要自我介绍。只输出这一句正文。`);
        } else {
          openingHint = textVideo
            ? `你想打个视频。下面是对方接通后看到的「刚接通」镜头画面：先一两句旁白（你所处环境/光线/你看向屏幕的动作表情），再跟一句开口，台词必须放在「」里。短、口语，可先喂一声。不要播音腔、不要自我介绍、不要心理独白。只输出这段画面正文。`
            : (isVideo
              ? `你想打个视频。下面这一句会在对方接通后直接念出来：短、口语，可先喂一声，像真开了摄像头。不要播音腔、不要自我介绍。只输出这一句正文。`
              : `你想打个电话。下面这一句会在对方接通后直接念出来：短、口语，可先喂一声。不要播音腔、不要自我介绍。只输出这一句正文。`);
        }
        const systemPrompt = buildSystemPrompt(char, chatSettings, openingHint, {
          forVoiceCall: true,
          forVideoCall: isVideo,
          forVideoCallText: textVideo,
        });
        let content = await callChatAPI(chatSettings, systemPrompt, '', 'chat');
        if (!content) continue;
        try {
          content = require('./emoji-helper').scrubUserVisibleText(content, char?.mindset);
        } catch { /* ignore */ }
        if (textVideo) {
          content = String(content || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 420);
          if (content && !/[「」""]/.test(content)) {
            const spoken = content.split(/[。！？\n]/).map((s) => s.trim()).filter(Boolean).pop() || content;
            if (spoken.length <= 40) content = `${content.replace(spoken, '').trim()}\n「${spoken}」`.trim();
          }
        } else {
          content = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        }
        if (!content) continue;
        const logId = outreach.logOutreach(db, char.id, 'call', content, { video: isVideo });
        outreach.scheduleRingTimeout(db, logId, char.id);
        push('proactive_call', {
          characterId: char.id,
          content,
          charName: char.name,
          charAvatar: char.avatar || '',
          ringtone: settings.sound_call || '',
          useSystemRingtone: outreach.useSystemCallRingtone?.(settings),
          logId,
          ringMs: outreach.RING_MS,
          vibe: avail.vibe,
          video: isVideo,
        });
        continue;
      }

      const peekHint = avail.vibe === 'tipsy'
        ? `你喝了点，特别想对方，但不打电话。写一句会从屏幕边角探头冒出来的短话（对方会直接看到这句）：1 句，口语，可带一点酒意。不要播音腔。只输出正文。`
        : `你这会儿特别想对方，但不打电话。写一句会从屏幕边角探头冒出来的短话（对方会直接看到这句）：1 句，口语。不要播音腔、不要自我介绍。只输出正文。`;
      const systemPrompt = buildSystemPrompt(char, chatSettings, peekHint);
      let content = await callChatAPI(chatSettings, systemPrompt, '', 'chat');
      if (!content) continue;
      try {
        content = require('./emoji-helper').scrubUserVisibleText(content, char?.mindset);
      } catch { /* ignore */ }
      content = String(content || '').trim();
      if (!content) continue;
      const now = new Date().toISOString();
      const r = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
      ).run(char.id, 'assistant', content, 'text', now, 0);
      outreach.logOutreach(db, char.id, 'peek', content);
      const aiMessages = [{ id: r.lastInsertRowid, role: 'assistant', content, type: 'text', timestamp: now }];
      push('proactive_message', {
        characterId: char.id,
        content,
        aiMessages,
        charName: char.name,
        charAvatar: char.avatar || '',
      });
    } catch (e) {
      console.error('[cron] proactive call error', e.message);
    }
  }
}

function formatIdleDuration(minutes) {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m}分钟`;
  if (m < 1440) {
    const h = Math.round(m / 60);
    return h <= 1 ? '1个多小时' : `${h}小时`;
  }
  const d = Math.round(m / 1440);
  return d <= 1 ? '大半天' : `${d}天`;
}

function getTimeOfDaySlot(hour) {
  if (hour >= 5 && hour < 9) return '清晨';
  if (hour >= 9 && hour < 12) return '上午';
  if (hour >= 12 && hour < 14) return '中午';
  if (hour >= 14 && hour < 18) return '下午';
  if (hour >= 18 && hour < 22) return '晚上';
  return '夜里';
}

function formatMemoryContextTimestamp(dateStr, tz) {
  try {
    const d = dateStr ? new Date(String(dateStr).includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z') : new Date();
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz || 'Asia/Shanghai',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (t) => parts.find(p => p.type === t)?.value ?? '';
    const hour = parseInt(get('hour') || '0', 10);
    const slot = getTimeOfDaySlot(hour);
    return `${get('year')}年${get('month')}月${get('day')}日${slot}`;
  } catch {
    return dateStr || '';
  }
}

const MEMORY_TIME_PREFIX_RE = /^\d{4}年\d{1,2}月\d{1,2}日(清晨|上午|中午|下午|晚上|夜里|夜深了)/;
const MEMORY_SLOT_RE = /(清晨|上午|中午|下午|晚上|夜里|夜深了)/;
const TODO_DUE_MARK_RE = /【到期[：:](\d{4})年(\d{1,2})月(\d{1,2})日(清晨|上午|中午|下午|晚上|夜里|夜深了)?】/;

function formatZhDateFromYmd(dateStr) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${y}年${m}月${d}日`;
}

function parseZhDateToYmd(y, m, d) {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!yy || !mm || !dd) return '';
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** 从待办正文解析到期日 YYYY-MM-DD */
function parseTodoDueDate(content) {
  const m = String(content || '').match(TODO_DUE_MARK_RE);
  if (!m) return '';
  return parseZhDateToYmd(m[1], m[2], m[3]);
}

/**
 * 把「明天中午 / 后天晚上」等相对说法换成绝对日期（锚点=对话当天）。
 * 已是「YYYY年M月D日…」的不改动。
 */
function resolveRelativeDatesInMemory(content, anchorDateStr) {
  let t = String(content || '');
  if (!t || !anchorDateStr) return t;

  const zh = (offset, slot = '') => `${formatZhDateFromYmd(shiftDateStr(anchorDateStr, offset))}${slot || ''}`;

  // 先处理「明天中午」这类「相对词+时段」，再处理裸相对词
  const withSlot = [
    [/大后天/g, 3],
    [/后天/g, 2],
    [/明天|明日/g, 1],
    [/今[天儿]?|今日/g, 0],
  ];
  for (const [re, offset] of withSlot) {
    t = t.replace(new RegExp(`(${re.source})(${MEMORY_SLOT_RE.source})`, 'g'), (_, __, slot) => zh(offset, slot));
    t = t.replace(re, () => zh(offset));
  }

  // 「这周末」→ 锚点日起最近的周六
  t = t.replace(/这周末|本周末/g, () => {
    try {
      const [y, m, d] = anchorDateStr.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      const dow = dt.getUTCDay(); // 0 Sun .. 6 Sat
      const add = (6 - dow + 7) % 7;
      return formatZhDateFromYmd(shiftDateStr(anchorDateStr, add));
    } catch {
      return '这周末';
    }
  });

  return t;
}

/** 确保待办有【到期：绝对日期+时段】；若只有相对词则先 resolve 再包一层 */
function ensureTodoDueMark(content, anchorDateStr) {
  let t = String(content || '').trim();
  if (!t) return t;
  if (TODO_DUE_MARK_RE.test(t)) {
    // 标记里若仍残留「明天」等，再 resolve 一次整个串
    return resolveRelativeDatesInMemory(t, anchorDateStr);
  }
  // 尝试从正文抓「YYYY年M月D日+时段」作为到期（说话日前缀之后的第一个未来日）
  const abs = [...t.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日(清晨|上午|中午|下午|晚上|夜里|夜深了)?/g)];
  if (abs.length >= 2) {
    // 第二条通常是说话日，第二条常是到期；若只有一条也可能是到期写在正文
    const last = abs[abs.length - 1];
    const dueZh = `${last[1]}年${Number(last[2])}月${Number(last[3])}日${last[4] || '中午'}`;
    if (!t.includes(`【到期：${dueZh}】`) && !t.includes(`【到期:${dueZh}】`)) {
      t = t.replace(MEMORY_TIME_PREFIX_RE, (m) => `${m}【到期：${dueZh}】`);
      if (!TODO_DUE_MARK_RE.test(t)) t = `【到期：${dueZh}】${t}`;
    }
    return t;
  }
  if (abs.length === 1 && !MEMORY_TIME_PREFIX_RE.test(t)) {
    const a = abs[0];
    const dueZh = `${a[1]}年${Number(a[2])}月${Number(a[3])}日${a[4] || '中午'}`;
    return `【到期：${dueZh}】${t}`;
  }
  // 仍无相对词时：默认到期=明天中午
  const fallbackDue = `${formatZhDateFromYmd(shiftDateStr(anchorDateStr, 1))}中午`;
  return t.includes('【到期') ? t : `${t.replace(/[。．]?$/, '')}。【到期：${fallbackDue}】`;
}

/**
 * 记忆落库统一处理：相对日期 → 绝对日期，再补说话日时间前缀；待办补【到期】标记。
 */
function finalizeMemoryContent(content, anchorTs, tz, { asTodo = false } = {}) {
  const anchorDate = getLocalDateStr(parseMsgTimestamp(anchorTs), tz)
    || getLocalDateStr(new Date(), tz);
  let t = sanitizeMemoryContent(String(content || '').trim());
  if (!t) return t;
  t = resolveRelativeDatesInMemory(t, anchorDate);
  if (asTodo || /【到期[：:]/.test(t)) {
    t = ensureTodoDueMark(t, anchorDate);
  }
  return ensureMemoryTimePrefix(t, anchorTs, tz);
}

function ensureMemoryTimePrefix(content, dateStr, tz) {
  const t = sanitizeMemoryContent(String(content || '').trim());
  if (!t) return t;
  if (MEMORY_TIME_PREFIX_RE.test(t)) return t;
  const prefix = formatMemoryContextTimestamp(dateStr, tz);
  if (!prefix) return t;
  return `${prefix}，${t}`;
}

/**
 * 日终：从当日对话再提炼「待办」（有明确到期时点的提醒），相对时间落成绝对日期。
 * 与通用记忆总结互补——即使总结 skip，只要有提醒约定也会记下。
 */
async function extractDailyReminderTodos(charId, targetDate) {
  const settings = getSettings();
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return { ok: false, saved: 0 };
  const tz = settings.timezone || 'Asia/Shanghai';

  const candidates = db.prepare(
    `SELECT id, role, content, timestamp, type FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0
     AND (type IS NULL OR type != 'system')
     ORDER BY id ASC`
  ).all(charId);
  const msgs = candidates.filter(m =>
    getLocalDateStr(parseMsgTimestamp(m.timestamp), tz) === targetDate
  );
  if (msgs.length < 2) return { ok: true, saved: 0 };

  // 当天已有待办则仍可补漏，靠 insertMemory 相似去重
  let openHint = '';
  try {
    const openTodos = require('./memory-brain-helper').listOpenTodosForPrompt(charId, 6);
    if (openTodos.length) {
      openHint = `\n【已有待办】勿重复：\n${openTodos.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`;
    }
  } catch { /* ignore */ }
  const chatStr = msgs.map(m => {
    const name = m.role === 'user' ? (settings.username || '旅人') : char.name;
    const ts = formatMemoryContextTimestamp(m.timestamp, tz);
    return `${name}（${ts}）：${formatMessageForAi(m)}`;
  }).join('\n');

  const systemPrompt = `你是待办提炼助手。只从对话中提取「有明确到期时点的提醒/约定要做的事」。
输出 JSON（不要 markdown）：
{"skip":false,"todos":[{"content":"80-160字","weight":0.9}]}
或 {"skip":true,"todos":[]}

【什么算待办】例如：明天中午记得拍给我看、后天晚上提醒我吃药、周末发张自拍、到点打电话。
【什么不算】无死线的长期承诺（「永远陪你」）、纯情绪、玩笑、已做完的事、模糊愿望。
【去重】同到期日+同动作只输出一条；措辞不同也算同一条。已有相似未完成待办时 skip 该条。
${openHint}【时间规则·极重要】
1）每条 content 以「说话当天 YYYY年M月D日+时段，」开头（时段：清晨/上午/中午/下午/晚上/夜里/夜深了）。
2）正文必须含【到期：YYYY年M月D日+时段】——把「明天/后天/今晚」等按对话时间戳换算成绝对日期。锚点=该句时间戳日期；明天=+1天，后天=+2天。
   例：对话在 2026年7月27日，用户说「明天中午记得拍给我看」→
   「2026年7月27日晚上，对方让我在【到期：2026年7月28日中午】拍照片发给对方，我表示会记得。」
3）禁止正文只留「明天中午」而不写具体年月日。
【人称】「我」=${char.name}；用户称「对方」或「${settings.username || '旅人'}」。禁止用「你」指用户，禁止第三人称旁白。
若当天没有任何待办 → {"skip":true,"todos":[]}。只输出 JSON。`;

  const url = (settings.memory_api_url || settings.chat_api_url || '').trim();
  const apiKey = (settings.memory_api_key || settings.chat_api_key || '').trim();
  if (!url || !apiKey) return { ok: false, saved: 0, reason: 'api_not_configured' };

  try {
    const raw = await callChatAPIComplete(settings, systemPrompt, chatStr, 'memory');
    let parsed = null;
    try {
      const cleaned = String(raw || '').replace(/```json\s*|```/g, '').trim();
      parsed = JSON.parse(cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.skip || !Array.isArray(parsed.todos) || !parsed.todos.length) {
      return { ok: true, saved: 0, skipped: true };
    }

    const anchorTs = msgs[msgs.length - 1]?.timestamp;
    const memoryDate = targetDate;
    const brain = require('./memory-brain-helper');
    let saved = 0;
    for (const item of parsed.todos) {
      let content = finalizeMemoryContent(String(item.content || '').trim(), anchorTs, tz, { asTodo: true });
      if (!content || content.length < 20) continue;
      if (!TODO_DUE_MARK_RE.test(content)) {
        content = ensureTodoDueMark(content, memoryDate);
        content = finalizeMemoryContent(content, anchorTs, tz, { asTodo: true });
      }
      const ir = brain.insertMemory({
        characterId: charId,
        category: '待办',
        content,
        weight: Math.max(0.5, Math.min(1, parseFloat(item.weight) || 0.9)),
        date: memoryDate,
        keywords: ['待办', '提醒'],
        source: 'daily_todo',
      });
      if (ir?.id && !ir.duplicate) saved += 1;
    }
    try { brain.dedupeOpenTodos(charId); } catch {}
    if (saved) {
      console.log(`[memory] daily todos char#${charId} date=${targetDate} +${saved}`);
      push('memory_updated', { characterId: charId });
    }
    return { ok: true, saved };
  } catch (e) {
    console.error('[memory] daily todos error', e.message);
    return { ok: false, saved: 0, message: e.message };
  }
}

function isLowValueMemory(content, category) {
  const t = String(content || '').replace(MEMORY_TIME_PREFIX_RE, '').replace(/^[，,、\s]+/, '').trim();
  // 过短或只有结论、看不出前因后果的条目，后续 AI 读了也抓不住重点
  if (t.length < 28) return true;
  if (category === '情感状态' && t.length < 48) return true;
  if (category === '重要时刻' && t.length < 40) return true;
  if (/^(用户|TA|你)?(很|好|非常)?(生气|难过|伤心|开心|激动|兴奋|郁闷|烦|委屈|焦虑|崩溃|无语|哈哈|嗯嗯)/.test(t) && t.length < 48) {
    return true;
  }
  if (/^(在吗|早安|晚安|睡了|拜拜|哈哈+|嗯+|哦+|好的|收到)/.test(t)) return true;
  return false;
}

function preferenceHasGuessWording(t) {
  return /好像|或许|大概|估计|可能喜欢|应该喜欢|我猜|推测|脑补|暗示|似乎喜欢|感觉(TA|他|她|用户)|看上去喜欢|八成喜欢/.test(t);
}

function preferenceAboutUser(t, userName = '') {
  const uname = String(userName || '').trim();
  const userLabels = ['用户', '旅人', '对方', ...(uname && uname !== '旅人' && uname !== '用户' ? [uname] : [])];
  const userAlt = userLabels.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(${userAlt})(.{0,16})(喜欢|爱吃|爱喝|爱看|爱玩|爱听|讨厌|不喜欢|不爱|偏好|习惯于?|总是|经常|忌口|不喝|不吃)`).test(t)
    || new RegExp(`(喜欢|爱吃|爱喝|爱看|爱玩|讨厌|不喜欢|不爱|偏好|习惯于?|总是|经常).{0,10}(${userAlt})`).test(t)
    || new RegExp(`(${userAlt})(说|提到|表示|确认|讲)`).test(t);
}

function preferenceAboutChar(t, charName = '') {
  const name = String(charName || '').trim();
  if (name) {
    try {
      const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.{0,10})(喜欢|爱|讨厌|不喜欢|偏好|习惯|爱吃|爱喝|觉得|认为)`);
      if (re.test(t)) return true;
    } catch { /* ignore bad name */ }
  }
  return /(^|，|。|角色)自己(很|也)?(喜欢|爱吃|讨厌|习惯|觉得|认为)/.test(t);
}

/**
 * 记忆里的「偏好与习惯」：用户和角色亲口说过的都可以留，只要主语清楚、不是瞎猜。
 */
function isInvalidPreferenceMemory(content, category, charName = '', userName = '') {
  if (category !== '偏好与习惯') return false;
  const t = String(content || '').replace(MEMORY_TIME_PREFIX_RE, '').replace(/^[，,、\s]+/, '').trim();
  if (!t) return true;
  if (preferenceHasGuessWording(t)) return true;
  return !preferenceAboutUser(t, userName) && !preferenceAboutChar(t, charName);
}

/**
 * 用户画像用：只要用户侧偏好。角色自己的喜好进自我认知，不进印象。
 */
function isInvalidUserPreferenceMemory(content, category, charName = '', userName = '') {
  if (category !== '偏好与习惯') return false;
  const t = String(content || '').replace(MEMORY_TIME_PREFIX_RE, '').replace(/^[，,、\s]+/, '').trim();
  if (!t) return true;
  if (preferenceHasGuessWording(t)) return true;
  if (preferenceAboutChar(t, charName) && !preferenceAboutUser(t, userName)) return true;
  return !preferenceAboutUser(t, userName);
}

function shouldSkipMemoryItem(content, category, charName = '', userName = '') {
  try {
    if ((category === '约定' || category === '待办')
      && require('./world-lock-helper').isCrossWorldMeetupTalk(content)) return true;
  } catch { /* ignore */ }
  if (isLowValueMemory(content, category)
    || isInvalidPreferenceMemory(content, category, charName, userName)) return true;
  // 一时体感进不了树，却会整天出现在【今天】里把对话钉在「还没解决」
  if ((category === '日常点滴' || category === '情感状态')
    && isTransientHealthConcernText(content)
    && !/(因为|后来|答应|约定|分手|吵架)/.test(String(content || ''))) {
    return true;
  }
  return false;
}

function sanitizeMemoryContent(text) {
  return String(text || '')
    .replace(/\d{1,2}[:：]\d{2}(?:\s*[～~\-至到]\s*\d{1,2}[:：]\d{2})?/g, '')
    .replace(/\d{1,2}点\d{1,2}分(?:[～~\-至到]\d{1,2}点\d{1,2}分)?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatDetailedTimestamp(dateStr, tz) {
  try {
    const d = dateStr ? new Date(String(dateStr).includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z') : new Date();
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz || 'Asia/Shanghai',
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (t) => parts.find(p => p.type === t)?.value ?? '';
    const hour = parseInt(get('hour') || '0', 10);
    const slot = getTimeOfDaySlot(hour);
    return `${get('year')}年${get('month')}${get('day')}日 ${get('hour')}:${get('minute')}（${slot}）`;
  } catch {
    return dateStr || '';
  }
}

const DEFAULT_MEMORY_KEYWORDS = ['记住', '别忘了', '别忘', '一定要记得', '答应我', '承诺', '约定', '发誓', '永远', '重要', '提醒', '记得拍', '拍给我'];

function getMemoryKeywords(char) {
  const custom = String(char?.memory_keywords || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_MEMORY_KEYWORDS;
}

function messageTriggersMemoryKeyword(content, char) {
  const text = String(content || '');
  if (!text) return false;
  return getMemoryKeywords(char).some(kw => kw && text.includes(kw));
}

/** 用户提到具体近期安排（出行/考试等），不必说「记住」也应尝试捕获 */
/** 用户主动分享喜好、厌恶、习惯、人际、性格等画像信息 */
function messageIndicatesUserProfileShare(content) {
  const text = String(content || '').trim();
  if (text.length < 4) return false;
  if (/(我|咱|本人).{0,4}(喜欢|爱|热爱|痴迷|迷恋|讨厌|不喜欢|不爱|嫌弃|忌|偏好|爱吃|爱喝|爱看|爱玩|爱听)/.test(text)) return true;
  if (/(吃不了|受不了|喝不惯|碰不得|不适用)/.test(text)) return true;
  if (/(我|咱).{0,6}(的)?(朋友|闺蜜|兄弟|哥们|同事|老板|上司|爸妈|爸爸|妈妈|母亲|父亲|对象|男朋友|女朋友|老公|老婆|男友|女友|前任|家人|亲戚|室友|同学)/.test(text)) {
    return true;
  }
  if (/(我|咱).{0,4}(平时|总是|经常|习惯|一般会|每次|每天都)/.test(text)) return true;
  if (/(我不擅长|我不会|我搞不定|我学不会|我怕做|我很怕)/.test(text)) return true;
  if (/(我(是|算|比较|挺|很)|大家觉得我).{0,8}(内向|外向|慢热|感性|理性|社恐|话少|话多|敏感|佛系|急性子)/.test(text)) {
    return true;
  }
  return false;
}

const _profileImpCaptured = new Set();

function profileImpressionAlreadyCaptured(charId, msgId) {
  return _profileImpCaptured.has(`${charId}:${msgId}`);
}

function markProfileImpressionCaptured(charId, msgId) {
  _profileImpCaptured.add(`${charId}:${msgId}`);
  if (_profileImpCaptured.size > 800) {
    const arr = [..._profileImpCaptured];
    _profileImpCaptured.clear();
    arr.slice(-400).forEach(k => _profileImpCaptured.add(k));
  }
}

/** 从用户原话快速抽印象（无 API 时也能记） */
function extractImpressionsFromUserText(text) {
  const items = [];
  const t = String(text || '').trim();
  if (!t) return items;
  const seen = new Set();
  const pushUnique = (cat, content, confirmed = 1) => {
    let c = toImpressionFact(content) || String(content || '').trim();
    c = c.replace(/^用户/, '').trim();
    if (!c || c.length < 2 || isJunkImpressionFact(c)) return;
    const catN = normalizeImpressionCategory(cat) || mapMemoryToImpressionCategory('', c);
    if (!catN) return;
    const key = `${catN}:${c}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ category: catN, content: c, keywords: deriveImpressionKeywords(c, []), confirmed });
  };

  for (const m of t.matchAll(/(?:我|咱)(?:很|挺|特别|超级|有点|不太|不)?(喜欢|爱|热爱|讨厌|不喜欢|不爱|嫌弃)([^，,。！？\n；;]{1,14})/g)) {
    const neg = /讨厌|不喜欢|不爱|嫌弃/.test(m[2]);
    const obj = m[3].trim();
    if (!obj) continue;
    pushUnique('喜好', neg ? `不喜欢${obj}` : `喜欢${obj}`);
  }
  for (const m of t.matchAll(/(?:我|咱)?(?:很)?(?:吃不了|受不了|喝不惯|碰不得)([^，,。！？\n]{1,12})/g)) {
    const obj = m[1].trim();
    if (obj) pushUnique('喜好', `不喜欢${obj}`);
  }
  for (const m of t.matchAll(/(?:我|咱)?(?:跟|和|与)?(?:我)?(?:的)?(朋友|闺蜜|兄弟|同事|爸妈|妈妈|爸爸|对象|男朋友|女朋友|老公|老婆|同学|室友)(?:关系)?(?:很|挺|特别)?(好|不错|亲密|疏远|一般|紧张|僵|淡)/g)) {
    pushUnique('人际关系', `和${m[1]}关系${m[2]}`);
  }
  if (/(朋友|闺蜜|兄弟).{0,8}(不多|很少|没几个)/.test(t) || /(不多|很少|没几个).{0,8}(朋友|闺蜜)/.test(t)) {
    pushUnique('人际关系', '朋友不多');
  }
  if (/(不善社交|不爱社交|社恐|不太合群|人缘一般)/.test(t)) {
    pushUnique('人际关系', '不太爱社交');
  }
  for (const m of t.matchAll(/(?:我|咱)?(?:平时|总是|经常|习惯|一般)([^，,。！？\n]{2,16})/g)) {
    const habit = m[1].trim();
    if (habit.length < 2) continue;
    const content = /^会|要|想|是/.test(habit) ? habit : `习惯${habit}`;
    if (looksLikePersonalityTrait(content) || looksLikePersonalityTrait(habit)) {
      pushUnique('性格', habit);
      continue;
    }
    if (looksLikeThoughtFact(content) || looksLikeThoughtFact(habit)) {
      pushUnique('想法', habit);
      continue;
    }
    if (looksLikeEmotionFact(content) || looksLikeEmotionFact(habit)) {
      pushUnique('情绪', habit);
      continue;
    }
    pushUnique('习惯', content);
  }
  for (const m of t.matchAll(/我(?:是|算|比较|挺|很)([^，,。！？\n]{2,12}?(?:人|性格))/g)) {
    const trait = m[1].replace(/(的)?(人|性格)$/, '').trim();
    if (trait && looksLikePersonalityTrait(`${trait}的人`)) pushUnique('性格', trait);
  }
  for (const m of t.matchAll(/(?:我不擅长|我不会|我搞不定|我学不会)([^，,。！？\n]{1,12})/g)) {
    if (m[1].trim()) pushUnique('不擅长', m[1].trim());
  }
  return items;
}

function parseImpressionsPayload(raw) {
  const parsed = parseMemoryEpisodePayload(raw);
  if (!parsed || !Array.isArray(parsed.impressions)) return [];
  const out = [];
  for (const imp of parsed.impressions) {
    const content = toImpressionFact(imp.content) || String(imp.content || '').trim();
    if (!content || isJunkImpressionFact(content)) continue;
    const cat = resolveImpressionCategory(imp.category, content)
      || normalizeImpressionCategory(imp.category)
      || mapMemoryToImpressionCategory('', content);
    if (!cat) continue;
    out.push({ category: cat, content, keywords: imp.keywords || [], confirmed: imp.confirmed != null ? (imp.confirmed ? 1 : 0) : 1 });
  }
  return out;
}

/** 用户分享画像时即时写入印象（不依赖每 N 轮记忆总结） */
async function captureUserImpressionsFromMessage(charId, userMsgId) {
  if (!userMsgId || profileImpressionAlreadyCaptured(charId, userMsgId)) return;
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return;
  const msg = db.prepare('SELECT role, content, type FROM messages WHERE id=?').get(userMsgId);
  if (!msg || msg.role !== 'user') return;
  const text = String(msg.content || '').trim();
  if (!text || !messageIndicatesUserProfileShare(text)) return;

  const settings = getSettings();
  const userName = settings.username || '旅人';
  let items = extractImpressionsFromUserText(text);

  const url = (settings.memory_api_url || settings.chat_api_url || '').trim();
  const apiKey = (settings.memory_api_key || settings.chat_api_key || '').trim();
  if (url && apiKey) {
    const ctxMsgs = db.prepare(
      `SELECT id, role, content, type, timestamp FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND id >= ? AND id <= ? + 2
       AND (type IS NULL OR type != 'system') ORDER BY id ASC`
    ).all(charId, Math.max(1, userMsgId - 4), userMsgId);
    const tz = settings.timezone || 'Asia/Shanghai';
    const chatStr = ctxMsgs.map(m => {
      const name = m.role === 'user' ? userName : char.name;
      const ts = formatMemoryContextTimestamp(m.timestamp, tz);
      return `${name}（${ts}）：${formatMessageForAi(m)}`;
    }).join('\n');

    const catsHint = (IMPRESSION_CATEGORY_HINTS || []).join('、');
    const systemPrompt = `用户在聊天里分享关于自己的稳定信息。提取可长期使用的印象标签，输出 JSON（不要 markdown）：
{"impressions":[{"category":"性格|情绪|想法|喜好|习惯|不擅长|人际关系|样子","content":"6-16字短句"}]}
规则：
· 只记用户亲口说的稳定事实；禁止脑补、禁止事件流水、禁止半截话
· 具体物喜欢/讨厌（吃喝玩看）→ 喜好；「喜欢胡思乱想 / 不喜欢被冷落」→ 想法，不要进喜好
· 脾气气质（内向、敏感、别扭）→ 性格；一生气就… / 难过时… → 情绪
· 作息处事（熬夜、先回消息）→ 习惯；不会/搞不定 → 不擅长
· 朋友/家人/同事等稳定关系 → 人际关系
· 没有可记的 → {"impressions":[]}
分类参考：${catsHint}。只输出 JSON。`;

    try {
      const raw = await callChatAPIComplete(settings, systemPrompt, chatStr, 'memory');
      const aiItems = parseImpressionsPayload(raw);
      if (aiItems.length) {
        const seen = new Set(items.map(it => `${it.category}:${it.content}`));
        for (const it of aiItems) {
          const k = `${it.category}:${it.content}`;
          if (!seen.has(k)) { items.push(it); seen.add(k); }
        }
      }
    } catch (e) {
      console.warn('[impression] profile capture AI failed', e.message);
    }
  }

  if (!items.length) return;
  const n = mergeImpressionItems(charId, items);
  if (n > 0) {
    markProfileImpressionCaptured(charId, userMsgId);
    push('impressions_updated', { characterId: charId });
    console.log(`[impression] char#${charId}: +${n} from user msg#${userMsgId}`);
  }
}

function maybeCaptureUserImpressionsFromMessage() {
  return;
}

function messageIndicatesSalientPlan(content) {
  const text = String(content || '').trim();
  if (text.length < 6) return false;
  const topicRe = /(?:旅游|旅行|出游|出去玩|度假|出差|回老家|回家|面试|考试|手术|搬家|入职|报到|出发|机票|酒店|车次|航班|动车|高铁|火车|飞机)/;
  const planRe = /(?:要去|准备去|打算|计划|订了|买了票|买了机票|定了|下周|下礼拜|明天|后天|大后天|这周末|下个周末|过几天|两天后|三天后|\d{1,2}[月号日])/;
  if (!topicRe.test(text)) return false;
  if (planRe.test(text)) return true;
  if (/(?:要|准备|打算).{0,8}(?:旅游|旅行|出差|度假|回老家|回家)/.test(text)) return true;
  if (/(?:旅游|旅行|出差|度假).{0,12}(?:去|回)/.test(text)) return true;
  return false;
}

function salientMomentAlreadyCaptured(charId, userMsgId) {
  return !!db.prepare(
    `SELECT id FROM memory_episodes
     WHERE character_id=? AND msg_id_from <= ? AND msg_id_to >= ? LIMIT 1`
  ).get(charId, userMsgId, userMsgId);
}

function summarizeMsgContent(msg) {
  if (!msg?.content && msg?.type !== 'emoji') return '';
  return formatMessageForAi(msg).slice(0, 200);
}

/** 忙碌期间只有自动回复、尚未得到角色正式回复的用户消息 */
function getUserMessagesNeedingRealReply(charId) {
  const msgs = db.prepare(
    `SELECT id, role, content FROM messages WHERE character_id=? AND is_dream=0 AND recalled=0 ORDER BY id ASC`
  ).all(charId);
  let lastRealAiIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && !String(msgs[i].content || '').startsWith('【自动回复】')) {
      lastRealAiIdx = i;
      break;
    }
  }
  return msgs.slice(lastRealAiIdx + 1).filter(m => m.role === 'user');
}

/** 用户发了但后面还没有任何 AI 回复的消息（含回车静默发送） */
function getUserMessagesAwaitingReply(charId) {
  return db.prepare(`
    SELECT role, content, type, timestamp, id FROM messages
    WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='user'
    AND NOT EXISTS (
      SELECT 1 FROM messages a
      WHERE a.character_id=messages.character_id AND a.role='assistant'
      AND a.is_dream=0 AND a.recalled=0 AND a.id > messages.id
    )
    ORDER BY id ASC
  `).all(charId);
}

function findFirstCharReplyAfterUser(characterId, dream, priorUserId, beforeIdExclusive) {
  return db.prepare(`
    SELECT id, timestamp, content FROM messages
    WHERE character_id=? AND role='assistant' AND is_dream=? AND recalled=0
      AND content NOT LIKE '【自动回复】%'
      AND id > ? AND id < ?
    ORDER BY id ASC LIMIT 1
  `).get(characterId, dream, priorUserId, beforeIdExclusive);
}

function getLastRealCharMessage(characterId, isDreamMode, beforeId = null) {
  const dream = isDreamMode ? 1 : 0;
  if (beforeId != null) {
    return db.prepare(`
      SELECT id, timestamp, content FROM messages
      WHERE character_id=? AND role='assistant' AND is_dream=? AND recalled=0
        AND content NOT LIKE '【自动回复】%'
        AND id < ?
      ORDER BY id DESC LIMIT 1
    `).get(characterId, dream, beforeId);
  }
  return db.prepare(`
    SELECT id, timestamp, content FROM messages
    WHERE character_id=? AND role='assistant' AND is_dream=? AND recalled=0
      AND content NOT LIKE '【自动回复】%'
    ORDER BY id DESC LIMIT 1
  `).get(characterId, dream);
}

/** 用户回来回复：从你本轮开口到此刻的间隔（不被中间主动追话重置） */
function computeUserReturnGap(characterId, isDreamMode = false) {
  const dream = isDreamMode ? 1 : 0;
  const awaiting = db.prepare(`
    SELECT id, timestamp FROM messages
    WHERE character_id=? AND is_dream=? AND recalled=0 AND role='user'
    AND NOT EXISTS (
      SELECT 1 FROM messages a
      WHERE a.character_id=messages.character_id AND a.role='assistant'
      AND a.is_dream=? AND a.recalled=0 AND a.id > messages.id
    )
    ORDER BY id ASC
  `).all(characterId, dream, dream);

  let charAnchor = null;
  let noteTargetUserId = null;

  if (awaiting.length > 0) {
    noteTargetUserId = awaiting[0].id;
    const firstAwaitingId = awaiting[0].id;
    const priorUser = db.prepare(`
      SELECT id FROM messages
      WHERE character_id=? AND role='user' AND is_dream=? AND recalled=0 AND id < ?
      ORDER BY id DESC LIMIT 1
    `).get(characterId, dream, firstAwaitingId);

    if (priorUser) {
      charAnchor = findFirstCharReplyAfterUser(characterId, dream, priorUser.id, firstAwaitingId);
    }
    if (!charAnchor) {
      charAnchor = getLastRealCharMessage(characterId, isDreamMode, firstAwaitingId);
    }
  } else {
    charAnchor = getLastRealCharMessage(characterId, isDreamMode);
  }

  if (!charAnchor?.timestamp) {
    return { minutes: 0, charAnchor: null, noteTargetUserId };
  }

  const charMs = parseMsgTimestamp(charAnchor.timestamp).getTime();
  if (!Number.isFinite(charMs)) {
    return { minutes: 0, charAnchor, noteTargetUserId };
  }

  // 空窗终点：优先用「用户发到聊天页」的第一条待回复消息时间戳；
  // 绝不用稍后点↑打包触发 AI 的 Date.now()（除非尚未有入库的用户消息）
  let endMs = Date.now();
  if (awaiting.length > 0) {
    const userMs = parseMsgTimestamp(awaiting[0].timestamp).getTime();
    if (Number.isFinite(userMs)) endMs = userMs;
  }
  const minutes = Math.max(0, Math.round((endMs - charMs) / 60000));
  return { minutes, charAnchor, noteTargetUserId };
}

/** 角色开口后用户一直不回：从你本轮第一句算起，不被后续追话重置 */
function computeUserSilenceSinceCharOutreach(characterId) {
  const lastChar = getLastRealCharMessage(characterId, false);
  if (!lastChar) return { minutes: 0, charAnchor: null };

  const priorUser = db.prepare(`
    SELECT id FROM messages
    WHERE character_id=? AND role='user' AND is_dream=0 AND recalled=0 AND id < ?
    ORDER BY id DESC LIMIT 1
  `).get(characterId, lastChar.id);

  let charAnchor = lastChar;
  if (priorUser) {
    const first = findFirstCharReplyAfterUser(characterId, 0, priorUser.id, lastChar.id + 1);
    if (first) charAnchor = first;
  }

  const charMs = parseMsgTimestamp(charAnchor.timestamp).getTime();
  if (!Number.isFinite(charMs)) return { minutes: 0, charAnchor };

  const minutes = Math.max(0, (Date.now() - charMs) / 60000);
  return { minutes, charAnchor };
}

function buildReplyTimeNotePayload(settings, characterId, isDreamMode, opts = {}) {
  const charRow = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  settings = withCharChatPrefs(settings, charRow);
  if (isDreamMode) {
    return { timeNote: '', noteTargetUserId: null, minutes: 0 };
  }
  const { minutes, charAnchor, noteTargetUserId } = computeUserReturnGap(characterId, isDreamMode);

  let userContent = String(opts.userMessage || '').trim();
  if (!userContent && noteTargetUserId) {
    try {
      const row = db.prepare('SELECT content FROM messages WHERE id=? AND character_id=?').get(noteTargetUserId, characterId);
      userContent = String(row?.content || '').trim();
    } catch { /* ignore */ }
  }

  if (settings?.time_aware_enabled !== '1' || !charAnchor || minutes < USER_RETURN_GAP_NOTE_MIN) {
    return { timeNote: '', noteTargetUserId, minutes };
  }

  const timeNote = buildChatTimeNote(settings, {
    minutesSinceCharReply: minutes,
    charLastContent: charAnchor.content || '',
    userContent,
  });
  return { timeNote, noteTargetUserId, minutes };
}

/**
 * 旁路开口（送礼签收、一起听歌、节日问候等）：带近窗对话 + 记忆线索，避免突兀冷启动。
 */
function loadSideChannelChatContext(charId, { limit = 14 } = {}) {
  const take = Math.max(8, Math.min(24, Number(limit) || 14));
  const recentMsgs = db.prepare(
    `SELECT role, content, type, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role IN ('user','assistant')
     ORDER BY id DESC LIMIT ?`
  ).all(charId, take + 4).reverse();

  const historyForApi = recentMsgs
    .filter((m) => m.type !== 'system')
    .slice(-take)
    .map((m) => ({ role: m.role, content: summarizeMsgContent(m) }))
    .filter((m) => m.content);

  const lastUserFresh = [...recentMsgs].reverse().find((m) => m.role === 'user' && !isStaleLastTalk(m));
  const memoryCueText = lastUserFresh
    ? (summarizeMsgContent(lastUserFresh) || String(lastUserFresh.content || '').trim())
    : '';
  const contextText = buildChatContextText(memoryCueText, recentMsgs);
  const continuityNote = historyForApi.length
    ? '【接上文】上方近窗是你们刚才的聊天。这轮虽有具体事由要开口，语气和称呼要接得上刚才在聊什么；可顺带点一下未了的话题，不要像换了个号突然冷启动，也不要无视近窗硬切成无关广播。'
    : '';

  return {
    recentMsgs,
    historyForApi,
    memoryCueText,
    contextText,
    continuityNote,
    promptOpts: {
      recentHistory: recentMsgs,
      userMessage: memoryCueText || '',
      contextText,
      sessionClosed: !memoryCueText,
      enableInlineDirectives: true,
    },
  };
}

/** 主动消息：模拟「隔一段时间看手机」——补回未读 / 轻跟沉默 */
async function buildProactiveContext(char, settings, idleMinutes, scenario, lastMsg, awaitingReply = [], opts = {}) {
  settings = withCharChatPrefs(settings, char);
  const tz = settings.timezone || 'Asia/Shanghai';
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
  const timeSlot = getTimeOfDaySlot(hour);
  const idleStr = formatIdleDuration(idleMinutes);
  const userName = settings.username || '旅人';

  const recentMsgs = db.prepare(
    `SELECT role, content, type, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role IN ('user','assistant')
     ORDER BY id DESC LIMIT 18`
  ).all(char.id).reverse();

  const recentAiTexts = recentMsgs
    .filter((m) => m.role === 'assistant' && m.type !== 'system')
    .map((m) => summarizeMsgContent(m) || String(m.content || '').trim())
    .filter(Boolean)
    .slice(-5);
  const nightEmotionNote = buildNightEmotionOutreachPrompt(opts.nightEmotionGate, {
    recentAiTexts,
    round: Math.max(1, (Number(opts.nightEmotionGate?.used) || 0) + 1),
  });

  const proactiveGuide = buildProactiveEngagementGuide(char, recentMsgs, scenario, {
    userReadIt: scenario === 'ai_unreplied' && (lastMsg?.is_read === 1 || lastMsg?.is_read === true),
  });
  const offlineNote = `对方这会儿多半没盯着聊天。\n${proactiveGuide}\n禁止「在吗」「看到没」这种要人立刻在线的问法。`;
  const caretakerBan = '现在几点只描述你这边；对方没说困、要睡或下班时，不要因为夜里/到点就催对方睡觉或下班。';
  const lengthGuide = nightEmotionNote
    ? '篇幅按【性格】自定：冷淡/决绝就一句或极短；纠结/放不下可以数句碎碎念，但每句信息不同，禁止同一句连写/复读。口语化，只输出要发的消息正文。'
    : '';

  // 各场景都带近窗对话进 API，避免主动消息像另一个人在说话
  const historyForApi = recentMsgs
    .filter((m) => m.type !== 'system')
    .slice(-14)
    .map((m) => ({ role: m.role, content: summarizeMsgContent(m) }))
    .filter((m) => m.content);

  const lastUserFresh = [...recentMsgs].reverse().find((m) => m.role === 'user' && !isStaleLastTalk(m));
  const memoryCueText = lastUserFresh
    ? (summarizeMsgContent(lastUserFresh) || String(lastUserFresh.content || '').trim())
    : '';
  const continuityNote = historyForApi.length
    ? (memoryCueText
      ? '【接上文】上方是你们刚聊过的原文近窗。开口必须接得上这段对话（或对方未回的那句），不要当成空白冷启动另起炉灶；找小事也要能挂在上文上。'
      : '【接上文】上方是你们刚聊过的原文近窗。上一段若已隔开，可以换话头，但不要假装不认识刚才聊过的人/事。')
    : '';

  let extra;
  let userContent;

  if (scenario === 'user_unreplied') {
    const pending = awaitingReply.length ? awaitingReply : (lastMsg ? [lastMsg] : []);
    const parts = pending.map(m => summarizeMsgContent(m)).filter(Boolean);
    const quoted = parts.join('」「');
    const situational = [
      `现在是${timeSlot}。${idleStr}前${userName}给你发了消息，你当时在做别的事，现在有空回一下。`,
      pending.length > 1
        ? `${userName}连发了${pending.length}条：「${quoted}」`
        : `${userName}说的是：「${quoted || summarizeMsgContent(lastMsg)}」`,
      `${userName}发消息时可能在，但现在不一定在线。`,
    ];
    extra = `你刚才在忙别的，这会儿才看到${userName}发来的消息。
${situational.join('\n')}
${continuityNote}
${offlineNote}
${nightEmotionNote}
迟了很久才回：接对方说的具体内容；要不要提刚才干嘛去了，看性格。别堆「抱歉回晚了」，别客服腔。
${caretakerBan}
${lengthGuide || '一两句到三句口语即可。'}`;
    userContent = '你这会儿才看到对方刚才的消息，抽空回一下（对方未必还在看）。';
  } else if (scenario === 'ai_unreplied') {
    const block = buildAiUnrepliedProactiveBlock(char, settings, lastMsg, recentMsgs, idleMinutes, opts.outreachAnchor);
    // 跟句：正文用「看了眼手机」处境；offlineNote 只留关系底线，避免叠成任务单
    const thinOffline = buildProactiveEngagementGuide(char, recentMsgs, scenario, {
      userReadIt: lastMsg?.is_read === 1 || lastMsg?.is_read === true,
    });
    extra = `${block.situational.join('\n')}
${block.instruction}
${continuityNote}
${thinOffline}
${nightEmotionNote}
${caretakerBan}
${lengthGuide || '口语短句即可，只输出要发的正文。'}`;
    userContent = nightEmotionNote
      ? '夜里你又看了眼手机。要不要再跟一句，按现在的心情。'
      : block.userContent;
  } else if (scenario === 'life_share') {
    const lastUserMsg = [...recentMsgs].reverse().find(m => m.role === 'user');
    const lastAiMsg = [...recentMsgs].reverse().find(m => m.role === 'assistant');
    extra = `${buildProactiveLifeShareExtra({
      char,
      settings,
      timeSlot,
      userName,
      lastUserSummary: (lastUserMsg && !isStaleLastTalk(lastUserMsg)) ? summarizeMsgContent(lastUserMsg) : '',
      lastAiSummary: lastAiMsg ? summarizeMsgContent(lastAiMsg) : '',
      offlineNote,
      caretakerBan,
      lengthGuide,
      recentMsgs,
    })}
${continuityNote}`;
    userContent = memoryCueText
      ? '你刚碰上点小事，想不想丢一句到对话框里——接得上上文最好（对方未必在看）。'
      : '你刚碰上点自己才会碰上的小事，随手丢不丢一句到对话框，看心情（对方未必在看）。';
  } else if (scenario === 'travel_arrive' || scenario === 'process_done') {
    let pending = null;
    try { pending = require('./process-time-helper').getDueProcess(char.id); } catch {}
    const { buildProcessDoneProactiveExtra } = require('./process-time-helper');
    extra = `${buildProcessDoneProactiveExtra(pending || {}, { userName })}
${continuityNote}
${offlineNote}
${caretakerBan}`;
    userContent = pending?.needLocation
      ? '你到了，且答应过发定位：说一声到了，并带上定位卡（对方未必在看）。'
      : (pending?.needImage || pending?.needVideo)
        ? `你到了，且答应过发${pending.needVideo ? '视频' : '图'}：说一声到了，并带上约定的那条媒体指令（对方未必在看）。`
      : (pending?.kind === 'travel_arrive'
        ? '你到了：跟对方说一声到了（对方未必在看）。'
        : `「${pending?.label || '这件事'}」做完了：跟对方说一声好了（对方未必在看）。`);
  } else {
    const lastUserMsg = [...recentMsgs].reverse().find(m => m.role === 'user');
    const lastAiMsg = [...recentMsgs].reverse().find(m => m.role === 'assistant');
    const situational = [`现在是${timeSlot}。`];
    if (lastUserMsg && !isStaleLastTalk(lastUserMsg)) {
      situational.push(`${userName}较早前说的是：「${summarizeMsgContent(lastUserMsg)}」（不代表此刻在线）。`);
    } else if (lastUserMsg) {
      situational.push(`${userName}较早前说过话，但已经隔了一段时间。不要翻旧账调侃上一段闲聊，自己找一件此刻的小事开口。`);
    } else {
      situational.push(`你们还没怎么聊过，可以像刚认识不久的朋友那样自然开口。`);
    }
    if (lastAiMsg) {
      situational.push(`你上一条是：「${summarizeMsgContent(lastAiMsg)}」——别重复同样的话。`);
    }
    extra = `【此刻】${situational.join('\n')}
${continuityNote}
${offlineNote}
${nightEmotionNote}
像真人随手点开聊天：有具体一点的东西就行，别空泛，别通知腔，别「好久不见/最近怎么样」。
可以丢你这边的小事，也可以轻轻接上未了的话；不是跟进工单。
${caretakerBan}
${lengthGuide || '长度 1～2 句为主，口语化，只输出你要发的消息正文。'}`;
    userContent = nightEmotionNote
      ? '夜里心里还挂着事：要不要开口、长短，按性格（对方未必在看）。'
      : '你又拿起手机，随口发一句就行（对方未必在看）。';
  }

  let screenImage = '';
  try {
    const phone = require('./phone-llm-tools');
    const phonePack = await phone.proactivePhoneBlock(char, scenario, recentMsgs, {
      userReadIt: scenario === 'ai_unreplied' && (lastMsg?.is_read === 1 || lastMsg?.is_read === true),
    });
    const phoneNote = typeof phonePack === 'string' ? phonePack : phonePack?.note;
    if (typeof phonePack === 'object' && phonePack?.imageDataUrl) screenImage = phonePack.imageDataUrl;
    if (phoneNote) extra = `${extra}\n\n${phoneNote}`;
  } catch {}
  try {
    const drive = require('./robot-drive-helper');
    const found = await drive.kickProactiveFind(char, settings, scenario);
    if (found) {
      extra = `${extra}\n\n【桌上小机】这轮你在找人，小机已开始转头找脸并对准。画面还没回来，不要写成已经看见桌边什么样。`;
    }
    const robotNote = drive.buildRobotInvokePromptSection(char, settings);
    if (robotNote) extra = `${extra}\n\n${robotNote}`;
  } catch {}

  return {
    extra,
    userContent,
    historyForApi,
    scenario,
    recentMsgs,
    screenImage,
    memoryCueText,
    contextText: buildChatContextText(memoryCueText, recentMsgs),
  };
}

function withOptionalScreenImage(userContent, screenImage) {
  if (!screenImage || typeof screenImage !== 'string' || !screenImage.startsWith('data:image/')) {
    return userContent;
  }
  const text = typeof userContent === 'string' ? userContent : '';
  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: screenImage } },
  ];
}

/** 角色已主动发过消息后，用户仍不回：约 2 小时再跟一句（±30 分钟浮动） */
const PROACTIVE_FOLLOWUP_MINUTES = 120;
/** 用户末条后补回：设定间隔上下浮动分钟数 */
const PROACTIVE_REPLY_JITTER_MIN = 10;
/** 角色末条后跟句：2 小时门槛上下浮动分钟数 */
const PROACTIVE_FOLLOWUP_JITTER_MIN = 30;
const proactiveLastCheck = new Map();

async function checkProactiveMessage() {
  const settings = getSettings();
  let chars = [];
  try {
    chars = db.prepare('SELECT * FROM characters WHERE proactive_msg_enabled=1').all() || [];
  } catch (e) {
    console.error('[cron] proactive msg list', e.message);
    return;
  }
  // 即使未开「主动发消息」，到期的过程行为（到了发定位/洗完了等）也要能发出
  try {
    const { listDueCharIdsFromSettings } = require('./process-time-helper');
    const have = new Set(chars.map((c) => String(c.id)));
    for (const id of listDueCharIdsFromSettings()) {
      if (have.has(String(id))) continue;
      const c = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
      if (c) {
        chars.push(c);
        have.add(String(id));
      }
    }
  } catch {}

  for (const char of chars) {
    try {
    // 过程行为到期可破宵禁（到了发定位 / 洗完报一声等）
    let travelDueEarly = null;
    try { travelDueEarly = require('./process-time-helper').getDueProcess(char.id); } catch {}

    // 先取情绪态，供静默时段破例判断（普通闲聊仍宵禁）
    try {
      const es = db.prepare('SELECT emotion_state FROM characters WHERE id=?').get(char.id);
      if (es) char.emotion_state = es.emotion_state || '';
    } catch {}
    const quiet = isInQuietHours(settings, char.id);
    const nightEmotionGate = quiet ? getNightEmotionOutreachGate(char, settings) : null;
    if (quiet && !nightEmotionGate && !travelDueEarly) continue;

    let contactStatus = 'friend';
    try {
      contactStatus = require('./contact-helper').getContactStatus(db, char.id);
    } catch {}
    // 拉黑：不再主动发消息
    if (contactStatus === 'blocked') continue;
    // 删除好友：偶尔发好友申请，不走普通主动消息（深夜破例也不发好友申请）
    if (contactStatus === 'deleted') {
      if (quiet) continue;
      const cadence = resolveProactiveCadence(char);
      const lastCheck = proactiveLastCheck.get(char.id) || 0;
      if (Date.now() - lastCheck < cadence.checkMin * 8 * 60000) continue;
      proactiveLastCheck.set(char.id, Date.now());
      if (Math.random() < 0.35) {
        try {
          const created = require('./contact-helper').createFriendRequest(db, char.id, {
            direction: 'from_char',
            message: '我可以重新加你吗？',
          });
          if (created) {
            try {
              const { push } = require('./push');
              push('friend_request', { characterId: char.id, requestId: created.id });
            } catch {}
          }
        } catch {}
      }
      continue;
    }
    const tz = resolveIanaTimezone(char.timezone || settings.timezone);
    const today = getLocalDateStr(new Date(), tz);
    const minsNow = getLocalMinutesSinceMidnight(new Date(), tz);
    const unlock = getCharMorningUnlockMinutes(char.id, { ...settings, timezone: tz });
    const sendDelay = hashDaySeed(char.id, `${today}:delay`) % 36;
    // 深夜情绪破例 / 到达报平安：不走「早间醒来」解锁
    if (!nightEmotionGate && !travelDueEarly && minsNow < unlock + sendDelay) continue;

    const cadence = resolveProactiveCadence(char);
    const lastCheck = proactiveLastCheck.get(char.id) || 0;
    // 深夜破例：稍缩短轮询间隔；到达报平安到期后约每 2 分钟可再试
    const checkGapMin = travelDueEarly
      ? 2
      : (nightEmotionGate ? Math.min(cadence.checkMin, 12) : cadence.checkMin);
    if (Date.now() - lastCheck < checkGapMin * 60000) continue;

    const awaitingReply = getUserMessagesAwaitingReply(char.id);

    let lastMsg = db.prepare(
      `SELECT role, content, type, timestamp, id, is_read FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND role IN ('user','assistant')
       ORDER BY id DESC LIMIT 1`
    ).get(char.id);

    if (!lastMsg && awaitingReply.length === 0) continue;

    let idleMinutes = 0;
    let scenario = 'cold_start';
    let outreachAnchor = null;

    // 过程行为预约到期：优先于普通跟句/小事（用户若有未回完的消息则先走补回复）
    let travelDue = null;
    try { travelDue = require('./process-time-helper').getDueProcess(char.id); } catch {}
    if (travelDue && awaitingReply.length === 0) {
      idleMinutes = 999;
      scenario = 'process_done';
      if (!lastMsg || lastMsg.role !== 'assistant') {
        const lastAi = db.prepare(
          `SELECT role, content, type, timestamp, id, is_read FROM messages
           WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='assistant'
           ORDER BY id DESC LIMIT 1`
        ).get(char.id);
        if (lastAi) lastMsg = lastAi;
      }
    } else if (awaitingReply.length > 0) {
      const anchor = awaitingReply[awaitingReply.length - 1];
      idleMinutes = (Date.now() - parseMsgTimestamp(anchor.timestamp).getTime()) / 60000;
      // 设定间隔 ±10 分钟（如半小时 → 约 20～40），按锚点消息稳定抖动
      const replyAfterMinutes = jitterMinutesStable(
        char.id, `reply:${anchor.id || anchor.timestamp}`, cadence.replyMin, cadence.replyJitter,
      );
      if (idleMinutes < replyAfterMinutes) continue;
      scenario = 'user_unreplied';
      lastMsg = anchor;
    } else if (lastMsg) {
      if (lastMsg.role === 'user') {
        idleMinutes = (Date.now() - parseMsgTimestamp(lastMsg.timestamp).getTime()) / 60000;
        const replyAfterMinutes = jitterMinutesStable(
          char.id, `reply:${lastMsg.id || lastMsg.timestamp}`, cadence.replyMin, cadence.replyJitter,
        );
        if (idleMinutes < replyAfterMinutes) continue;
        scenario = 'user_unreplied';
      } else {
        const silence = computeUserSilenceSinceCharOutreach(char.id);
        idleMinutes = silence.minutes;
        outreachAnchor = silence.charAnchor;
        if (nightEmotionGate) {
          // 深夜情绪破例：跟句门槛约 50±10 分钟
          const followupMin = jitterMinutesStable(
            char.id,
            `followup:${outreachAnchor?.id || lastMsg.id || lastMsg.timestamp}`,
            50,
            PROACTIVE_REPLY_JITTER_MIN,
          );
          if (idleMinutes < followupMin) continue;
          scenario = 'ai_unreplied';
        } else {
          // 日常：多数时候安静；合格日 + 冷却够了才小概率丢一件日常小事；更久之后偶尔轻跟/催回
          const chaseMin = jitterMinutesStable(
            char.id,
            `followup:${outreachAnchor?.id || lastMsg.id || lastMsg.timestamp}`,
            cadence.chaseMin,
            cadence.chaseJitter,
          );
          const lifeMin = jitterMinutesStable(
            char.id,
            `life:${outreachAnchor?.id || lastMsg.id || lastMsg.timestamp}`,
            cadence.lifeMin,
            25,
          );
          const lifeOk = canSendLifeShareNow(char.id, { ...settings, timezone: tz }, cadence);
          const alreadyFollowed = charAlreadyFollowedUp(char.id);
          const firstP = Number(cadence.firstFollowP) > 0 ? cadence.firstFollowP : cadence.followP;

          if (idleMinutes >= chaseMin) {
            const roll = Math.random();
            const followP = alreadyFollowed ? cadence.followP : firstP;
            if (lifeOk && roll < cadence.lifeP) {
              scenario = 'life_share';
            } else if (roll < cadence.lifeP + followP) {
              scenario = 'ai_unreplied';
            } else {
              // 决定先安静：也占检查位，避免每分钟连掷变成「迟早必中」
              proactiveLastCheck.set(char.id, Date.now());
              continue;
            }
          } else if (idleMinutes >= lifeMin && lifeOk && Math.random() < cadence.earlyLifeP) {
            // 稍早窗口：极低概率提前丢一件小事，绝不保证每天都有
            scenario = 'life_share';
          } else {
            if (idleMinutes >= lifeMin) {
              // 到了小事窗口但没命中：占位，下个间隔再看
              proactiveLastCheck.set(char.id, Date.now());
            }
            continue;
          }
        }
        const lastAi = db.prepare(
          `SELECT role, content, type, timestamp, id, is_read FROM messages
           WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='assistant'
           ORDER BY id DESC LIMIT 1`
        ).get(char.id);
        if (lastAi) lastMsg = lastAi;
      }
    } else {
      continue;
    }

    // 空窗未到阈值时不占检查位，下一分钟还能再看；真正准备发了再记 lastCheck
    proactiveLastCheck.set(char.id, Date.now());

    // 跟句/未读情境：先按人设把沉默写进情绪曲线，再生成主动消息
    if (scenario === 'ai_unreplied') {
      try { emotionHelper.applySilenceMoodTick(char.id, char); } catch {}
    }

    const {
      extra, userContent, historyForApi, scenario: mode, recentMsgs, screenImage,
      memoryCueText, contextText,
    } = await buildProactiveContext(
      char, settings, idleMinutes, scenario, lastMsg, awaitingReply, {
        outreachAnchor,
        nightEmotionGate,
      }
    );
    const proactiveOpts = {
      recentHistory: recentMsgs,
      userMessage: memoryCueText || '',
      contextText: contextText || '',
      sessionClosed: !memoryCueText,
      enableInlineDirectives: true,
      // 夜间破例提示已含冲突余波，避免与 emotionalCarryover 双重堆叠导致车轱辘
      suppressEmotionalCarryover: !!nightEmotionGate,
    };
    try { await prefetchLocationWeather(char, settings, proactiveOpts); } catch {}
    const systemPrompt = buildSystemPrompt(char, settings, extra, proactiveOpts);

    try {
      // 有用户未读消息时，不走「等对方回」的主动跟句
      if (mode === 'ai_unreplied' && awaitingReply.length > 0) continue;

      // 跟句时偶尔连文字带拍一拍（不再单独用拍一拍顶替整轮）
      const alsoPoke = !nightEmotionGate
        && mode === 'ai_unreplied'
        && mode !== 'travel_arrive'
        && mode !== 'process_done'
        && Math.random() < 0.28;

      const lastAiPlain = [...(recentMsgs || [])].reverse()
        .find((m) => m.role === 'assistant' && m.type !== 'system');
      const lastAiText = lastAiPlain
        ? (summarizeMsgContent(lastAiPlain) || String(lastAiPlain.content || '').trim())
        : '';

      const robotToolsExtra = await require('./robot-llm-tools').chatExtra(char, settings);
      let content = await callChatAPIComplete(settings, systemPrompt, withOptionalScreenImage(userContent, screenImage), 'chat', historyForApi, robotToolsExtra);
      const robotHelper = require('./robot-helper');
      const robotInvoke = robotHelper.parseRobotInvoke(content || '');
      if (robotInvoke.found) content = robotInvoke.textWithout;
      if (!String(content || '').trim() && robotInvoke.intent) {
        try {
          const { invokeRobotFromCharacterWill } = require('./robot-drive-helper');
          await invokeRobotFromCharacterWill(char, settings, {
            intent: robotInvoke.intent,
            source: 'proactive_tag_only',
          });
        } catch (e) {
          console.warn('[cron] robot will proactive only', e.message);
        }
        continue;
      }
      if (content && nightEmotionGate) {
        content = polishSpokenAiText(content, char.language_style);
        // 整条几乎复读上一条 AI：再掷一次，仍复读则放弃本轮（不占破例额度）
        if (lastAiText && proseNearDuplicate(content, lastAiText)) {
          const retryUser = withOptionalScreenImage(
            `${userContent}\n（上一条你已发过类似内容，本轮必须换说法或换切入点；禁止复读。若没新话可说，只输出一句极短的不同表达。）`,
            screenImage
          );
          let retry = await callChatAPIComplete(settings, systemPrompt, retryUser, 'chat', historyForApi, robotToolsExtra);
          retry = polishSpokenAiText(retry || '', char.language_style);
          if (!retry || proseNearDuplicate(retry, lastAiText) || proseNearDuplicate(retry, content)) {
            console.warn(`[cron] night emotion outreach skipped (echo) char=${char.id}`);
            continue;
          }
          content = retry;
        }
      } else if (content) {
        content = polishSpokenAiText(content, char.language_style);
      }
      if (content) {
        content = normalizeMediaDirectiveLines(content);
        content = require('./contact-helper').applyHiddenRelationMarkers(db, char.id, content);
        if (!String(content || '').trim()) continue;
        const rawAiContent = content;
        const { segments, recalledMsg, wantPoke } = processAiContentWithEmojis(content, char, { characterId: char.id, isDream: false });
        // 拆气泡后仍可能句句相同：再压一层
        const dedupedSegs = [];
        let prevSegNorm = '';
        for (const seg of segments) {
          if (seg.type === 'text') {
            const collapsed = polishSpokenAiText(seg.content, char.language_style);
            if (!collapsed) continue;
            const n = collapsed.replace(/\s+/g, '');
            if (n && n === prevSegNorm) continue;
            prevSegNorm = n || prevSegNorm;
            dedupedSegs.push({ ...seg, content: collapsed });
          } else {
            dedupedSegs.push(seg);
          }
        }
        const segmentsClean = stripAlbumMarkersFromSegments(dedupedSegs.length ? dedupedSegs : segments);
        const { stripMusicScoreFromSegments, attachMusicScoreMessage } = require('./music-score-helper');
        let toSave = stripSoundFxFromSegments(stripMusicScoreFromSegments(
          stripImageDirectiveFromSegments(
            segmentsClean.length ? segmentsClean : [{ type: 'text', content }],
            rawAiContent
          ),
          rawAiContent
        ), rawAiContent);
        const vocalPrep = prepareVocalReply({ char, segments: toSave, rawText: rawAiContent });
        toSave = vocalPrep.segments;
        let deliveryStatus = 'sent';
        try {
          if (require('./contact-helper').isPeerUndeliverable(db, char.id)) deliveryStatus = 'peer_undelivered';
        } catch {}
        let { aiMessages } = saveAiReplySegments(char.id, toSave, char, false, { deliveryStatus });
        // 文字落库后同轮可附带拍一拍（模型写了 [拍一拍]，或跟句掷中）
        if (wantPoke || alsoPoke) {
          try {
            const { insertCharacterPokeMessage } = require('./emoji-helper');
            const pokeMsg = insertCharacterPokeMessage(char.id, char, settings, { isDream: false });
            push('ai_poke', {
              characterId: char.id,
              charName: char.name,
              text: pokeMsg.content,
              timestamp: pokeMsg.timestamp,
            });
          } catch (e) {
            console.warn('[cron] poke with proactive', e.message);
          }
        }
        const cleanText = toSave.filter(s => s.type === 'text').map(s => s.content).join('\n') || content;
        const imgMsg = await tryAttachChatImageToReply(char.id, settings, rawAiContent, cleanText, char);
        if (imgMsg) aiMessages = [...aiMessages, imgMsg];
        const vidMsg = await tryAttachChatVideoToReply(char.id, settings, rawAiContent, cleanText, char);
        if (vidMsg) aiMessages = [...aiMessages, vidMsg];
        try {
          const scoreMsg = await attachMusicScoreMessage({
            characterId: char.id,
            rawText: rawAiContent,
            cleanText,
            char,
            uploadsPath: require('path').join(__dirname, 'uploads'),
            isDreamMode: false,
            deliveryStatus,
            settings,
          });
          if (scoreMsg) aiMessages = [...aiMessages, scoreMsg];
        } catch (e) {
          console.warn('[music-score] proactive', e.message);
        }
        try {
          insertVocalMessages(aiMessages, attachVocalClipMessages({
            characterId: char.id,
            char,
            play: vocalPrep.play,
            isDreamMode: false,
            deliveryStatus,
          }));
        } catch (e) {
          console.warn('[vocal] proactive', e.message);
        }
        try {
          const sfxMsgs = await attachSoundFxMessages({
            characterId: char.id,
            rawText: rawAiContent,
            cleanText,
            settings,
            uploadsPath: require('path').join(__dirname, 'uploads'),
            isDreamMode: false,
            deliveryStatus,
          });
          if (sfxMsgs?.length) aiMessages = [...aiMessages, ...sfxMsgs];
        } catch (e) {
          console.warn('[sfx] proactive', e.message);
        }
        const textContent = aiMessages.filter(m => m.type === 'text' || m.type === 'voice').map(m => m.content).join('\n') || cleanText;
        if (mode === 'life_share') markLifeShareSent(char.id);
        if (mode === 'travel_arrive' || mode === 'process_done') {
          try { require('./process-time-helper').clearPending(char.id); } catch {}
        }
        if (nightEmotionGate) {
          // 破例正文常复述冲突词，禁止反过来给情绪态续命；只记破例次数
          try {
            const fresh = getDecayedEmotionState({ id: char.id, emotion_state: char.emotion_state });
            bumpNightEmotionOutreach(char.id, fresh || nightEmotionGate.state);
          } catch {}
        } else {
          try { touchCharacterEmotionFromMessage(char.id, { role: 'assistant', content: textContent }); } catch {}
        }
        applyBusyStatusIfNeeded(char, textContent || content);
        if (recalledMsg) {
          push('message_update', { characterId: char.id, id: recalledMsg.id, recalled: true, recalledContent: recalledMsg.content });
        }
        push('proactive_message', { characterId: char.id, content: textContent, aiMessages, recalled: recalledMsg ? { id: recalledMsg.id, content: recalledMsg.content } : null });
        if (robotInvoke?.intent) {
          try {
            const { invokeRobotFromCharacterWill } = require('./robot-drive-helper');
            await invokeRobotFromCharacterWill(char, settings, {
              intent: robotInvoke.intent,
              proactiveText: textContent,
              source: 'proactive_tag',
            });
          } catch (e) {
            console.warn('[cron] robot will after proactive', e.message);
          }
        }
        try {
          require('./robot-drive-helper').applyReplyHardwareToRobot(char, settings, rawAiContent, textContent, '');
        } catch (e) {
          console.warn('[cron] robot hardware proactive', e.message);
        }
      }
    } catch (e) {
      console.error('[cron] proactive msg error', e.message);
    }
    } catch (e) {
      console.error(`[cron] proactive msg char#${char?.id}`, e.message);
    }
  }
}

async function checkSpecialDayMessages() {
  const settings = getSettings();
  const chars = db.prepare('SELECT * FROM characters WHERE proactive_msg_enabled=1').all();
  for (const char of chars) {
    const chatSettings = withCharChatPrefs(settings, char);
    if (isInQuietHours(chatSettings, char.id)) continue;
    const tz = chatSettings.timezone || 'Asia/Shanghai';
    const today = getLocalDateStr(new Date(), tz);
    const todayMMDD = today.slice(5);

    let occasion = '';
    if (char.birthday && String(char.birthday).slice(5, 10) === todayMMDD) {
      occasion = `${char.name}的生日`;
    } else if (char.anniversary && String(char.anniversary).slice(5, 10) === todayMMDD) {
      occasion = '你们的纪念日';
    } else {
      const userBday = String(settings.user_birthday || '').trim();
      if (userBday) {
        const uMMDD = userBday.length >= 10 ? userBday.slice(5, 10) : userBday.slice(0, 5);
        if (uMMDD === todayMMDD) occasion = `${settings.username || '旅人'}的生日`;
      }
    }
    if (!occasion) {
      const pubHoliday = lookupPublicHoliday(today);
      if (pubHoliday) occasion = pubHoliday.label;
    }
    if (!occasion) continue;

    const sent = db.prepare(
      `SELECT id FROM messages WHERE character_id=? AND role='system' AND content=? AND timestamp >= ?`
    ).get(char.id, `__special__${today}`, today + 'T00:00:00');
    if (sent) continue;

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream) VALUES (?,?,?,?,?,?)`
    ).run(char.id, 'system', `__special__${today}`, 'system', now, 0);

    const {
      extra, userContent, historyForApi, screenImage, recentMsgs, memoryCueText, contextText,
    } = await buildProactiveContext(char, chatSettings, 120, 'cold_start', null);
    const systemPrompt = buildSystemPrompt(char, chatSettings,
      `${extra}\n【特别日子】今天是${occasion}。按【性格】【关系尺度】发 1-2 句口语消息（可热可淡可损），不要套模板祝福语，也不要强行「有温度」。`,
      {
        enableInlineDirectives: true,
        recentHistory: recentMsgs,
        userMessage: memoryCueText || '',
        contextText: contextText || '',
        sessionClosed: !memoryCueText,
      }
    );
    try {
      const content = await callChatAPIComplete(settings, systemPrompt, withOptionalScreenImage(userContent, screenImage), 'chat', historyForApi, await require('./robot-llm-tools').chatExtra(char, chatSettings));
      const robotHelper = require('./robot-helper');
      const robotInvoke = robotHelper.parseRobotInvoke(content || '');
      const cleanContent = require('./contact-helper').applyHiddenRelationMarkers(
        db,
        char.id,
        normalizeMediaDirectiveLines(robotInvoke.found ? robotInvoke.textWithout : content),
      );
      if (cleanContent) {
        const { segments, recalledMsg } = processAiContentWithEmojis(cleanContent, char, { characterId: char.id, isDream: false });
        const segmentsClean = stripAlbumMarkersFromSegments(segments);
        const toSave = segmentsClean.length ? segmentsClean : [{ type: 'text', content: cleanContent }];
        let deliveryStatus = 'sent';
        try {
          if (require('./contact-helper').isPeerUndeliverable(db, char.id)) deliveryStatus = 'peer_undelivered';
        } catch {}
        const { aiMessages } = saveAiReplySegments(char.id, toSave, char, false, { deliveryStatus });
        const textContent = aiMessages.filter(m => m.type === 'text' || m.type === 'voice').map(m => m.content).join('\n') || cleanContent;
        applyBusyStatusIfNeeded(char, textContent || cleanContent);
        if (recalledMsg) {
          push('message_update', { characterId: char.id, id: recalledMsg.id, recalled: true, recalledContent: recalledMsg.content });
        }
        push('proactive_message', { characterId: char.id, content: textContent, aiMessages, recalled: recalledMsg ? { id: recalledMsg.id, content: recalledMsg.content } : null });
        if (robotInvoke?.intent) {
          try {
            const { invokeRobotFromCharacterWill } = require('./robot-drive-helper');
            await invokeRobotFromCharacterWill(char, settings, {
              intent: robotInvoke.intent,
              proactiveText: textContent,
              source: 'special_day_tag',
            });
          } catch (e) {
            console.warn('[cron] robot will special day', e.message);
          }
        }
        try {
          require('./robot-drive-helper').applyReplyHardwareToRobot(char, settings, content, textContent, '');
        } catch (e) {
          console.warn('[cron] robot hardware special day', e.message);
        }
      }
    } catch (e) {
      console.error('[cron] special day msg error', e.message);
    }
  }
}

async function autoInteractRecentMoments() {
  // 近 48 小时：用户动态缺角色评论，或角色动态缺 NPC 评论
  const recentMoments = db.prepare(
    `SELECT * FROM moments WHERE created_at >= datetime('now','-48 hours') ORDER BY id DESC LIMIT 30`
  ).all();

  for (const m of recentMoments) {
    let likes = [];
    let comments = [];
    try { likes = JSON.parse(m.likes || '[]'); } catch {}
    try { comments = JSON.parse(m.comments || '[]'); } catch {}
    const hasAiComment = comments.some((c) => c.role === 'ai');
    const hasNpcComment = comments.some((c) => c.role === 'npc' || c.isNpc || c.npcId);

    if (m.role === 'user' && !hasAiComment) {
      // 50% 概率触发，避免每次都全量互动
      if (Math.random() > 0.5) {
        await aiInteractWithMoment(m.id).catch((e) => console.error('[cron] auto-interact:', e.message));
      }
      continue;
    }

    // 角色动态：补 NPC 评论（发帖时若只走了互评角色，NPC 会被漏掉）
    if (m.role === 'ai' && m.character_id && !hasNpcComment) {
      if (Math.random() > 0.35) {
        try {
          const out = await aiNpcInteractWithMoment(m.id);
          const n = (out?.results || []).length;
          if (n) console.log(`[cron] catch-up npc interact moment#${m.id} +${n}`);
        } catch (e) {
          console.error('[cron] auto npc-interact:', e.message);
        }
      }
      continue;
    }

    // 角色动态已有 NPC 评论，但发帖角色还没回：补主人回复
    if (m.role === 'ai' && m.character_id && hasNpcComment) {
      try {
        const n = await replyOwnerToNpcComments(m.id);
        if (n) console.log(`[cron] catch-up owner reply npc moment#${m.id} +${n}`);
      } catch (e) {
        console.error('[cron] auto owner-reply-npc:', e.message);
      }
    }
  }
}

/** 已在聊天里问过某条用户动态的角色 id 列表 */
function getMomentChatAskedIds(momentRow) {
  try {
    const arr = JSON.parse(momentRow?.chat_asked || '[]');
    return Array.isArray(arr) ? arr.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
  } catch {
    return [];
  }
}

function hasMomentChatAsked(momentRow, charId) {
  return getMomentChatAskedIds(momentRow).includes(Number(charId));
}

/** 发送/回复成功后占坑：同一 (动态, 角色) 只在聊天里提一次 */
function claimMomentChatAsk(momentId, charId) {
  const row = db.prepare('SELECT chat_asked FROM moments WHERE id=?').get(momentId);
  if (!row) return false;
  const asked = getMomentChatAskedIds(row);
  if (asked.includes(Number(charId))) return false;
  asked.push(Number(charId));
  try {
    db.prepare('UPDATE moments SET chat_asked=? WHERE id=?').run(JSON.stringify(asked), momentId);
    return true;
  } catch (e) {
    console.warn('[cron] moment chat_asked', e.message);
    return false;
  }
}

/**
 * 关系是否会「刷到朋友圈随口问一句」：
 * 恋人 / 挚友 / 家人 / 暗恋暧昧（含自定义与人设推断）；同事或生疏则否。
 * 被 @ 时不卡关系。
 */
function charWouldCasuallyAskAboutMoments(char, { mentioned = false } = {}) {
  if (mentioned) return true;
  const rel = String(char?.relationship || '').trim();
  if (rel === 'lover' || rel === 'close_friend' || rel === 'family') return true;
  if (rel === 'colleague') return false;
  if (rel === 'friend') return false;

  const custom = String(char?.relationship_custom || '').trim();
  const blob = [
    custom, char?.intro, char?.personality, char?.background, char?.behavior, char?.description, char?.relationship,
  ].filter(Boolean).join('\n');

  if (/暗恋|单恋|暧昧|心上人|喜欢着|暗暗喜欢|crush|恋慕|意中人|欢喜冤家|情侣|恋人|爱人|对象|男友|女友|老公|老婆/i.test(blob)) {
    return true;
  }
  if (/挚友|闺蜜|死党|青梅竹马|发小/i.test(blob)) return true;
  if (/家人|哥哥|姐姐|弟弟|妹妹|爸|妈/.test(blob) && !/同事|上司|客户/.test(blob)) return true;
  return false;
}

function momentMentionsChar(momentRow, charId) {
  try {
    const mentions = JSON.parse(momentRow?.mentions || '[]');
    return (Array.isArray(mentions) ? mentions : []).some(
      x => Number(x?.charId || x?.characterId || x) === Number(charId)
    );
  } catch {
    return false;
  }
}

/**
 * 平常聊天用：若有未提过的用户朋友圈，且关系会随口问，返回短提示（不另发主动消息）。
 * @returns {{ momentId: number, block: string } | null}
 */
function getUserMomentChatCue(char, settings = {}) {
  if (!char?.id) return null;
  let recent = [];
  try {
    recent = db.prepare(
      `SELECT * FROM moments WHERE role='user'
         AND created_at >= datetime('now','-24 hours')
       ORDER BY id DESC LIMIT 12`
    ).all() || [];
  } catch {
    return null;
  }

  const userName = settings.username || '旅人';
  for (const m of recent) {
    if (hasMomentChatAsked(m, char.id)) continue;
    const mentioned = momentMentionsChar(m, char.id);
    if (!charWouldCasuallyAskAboutMoments(char, { mentioned })) continue;

    let imageNote = '';
    try {
      const imgs = JSON.parse(m.images || '[]');
      if (Array.isArray(imgs) && imgs.length) imageNote = '（带图）';
    } catch {}
    const snippet = String(m.content || '').trim().slice(0, 100) || '（无文字，可能是晒图）';
    const loc = String(m.location || '').trim();
    const block = `【朋友圈·随口提】你刷到${userName}刚发的朋友圈（本条你还没在聊天里提过）：「${snippet}」${imageNote}${loc ? ` 位置：${loc}` : ''}
接对方这轮话时，若顺口可以提一句或问一句相关的；也可以先回完对方再说。不要复述全文，不要刻意开场「我看到你朋友圈了」，不要每条消息都提。提过一次即可。`;
    return { momentId: Number(m.id), block };
  }
  return null;
}

// 供server.js复用
let aiInteractWithMoment = async (momentId) => {};
function setAiInteractFn(fn) { aiInteractWithMoment = fn; }
/** 圈子 NPC 评论角色/用户朋友圈（由 server 注入，避免 cron 循环依赖） */
let aiNpcInteractWithMoment = async (momentId) => ({ results: [] });
function setNpcInteractFn(fn) { aiNpcInteractWithMoment = fn; }

/** 角色动态下，补回对 NPC 评论的主人回复（由 server 注入） */
let replyOwnerToNpcComments = async () => 0;
function setOwnerNpcReplyFn(fn) { replyOwnerToNpcComments = fn; }

/** 常用分类提示（非写死；库里可有任意新类） */
const IMPRESSION_CATEGORY_HINTS = ['性格', '情绪', '想法', '喜好', '习惯', '不擅长', '人际关系', '样子', '其他', '变化'];
const IMPRESSION_CATEGORIES = IMPRESSION_CATEGORY_HINTS; // 兼容旧引用
const IMPRESSION_MAX_ITEM_LEN = 28;
const IMPRESSION_MAX_PER_CAT = 30;
const IMPRESSION_PROMPT_PER_CAT = 4;
const IMPRESSION_PROMPT_MAX = 16;
const IMPRESSION_TIME_SLOT_RE = /^(清晨|上午|中午|下午|傍晚|晚上|夜里|夜深了|凌晨)$/;

/** 稳定脾气/气质词：只有像这些才允许进「性格」 */
const PERSONALITY_TRAIT_RE = /性格|脾气|气质|内向|外向|敏感|慢热|直爽|直球|玻璃心|感性|理性|傲娇|社恐|冷静|急躁|粘人|独立|倔强|温柔|强势|自卑|自信|多疑|大方|小气|认真|随性|话少|话多|闷骚|高冷|热情|悲观|乐观|纠结|内耗|心软|念旧|重感情|好面子|别扭|嘴硬|好强|好胜|随和|较真|马虎|细心|粗心|怂|胆子小|勇敢|想很多|容易哭|容易急|容易怒|容易焦虑|情绪化|慢半拍|急性子|慢性子|脸皮薄|脸皮厚|嘴硬心软|外冷内热/;

/** 像不像「性格」标签（防止喜好/事件/碎碎念掉进性格桶） */
function looksLikePersonalityTrait(text) {
  const s = String(text || '').replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
  if (s.length < 2 || s.length > 24) return false;
  // 单次心情 / 事件残渣
  if (/(今天|刚才|这会儿|刚刚|昨晚|明天|因为|然后|后来|某天|有一次|去世|加班|考试|生病|住院|分手|吵架)/.test(s)) return false;
  // 明显该进别类
  if (/短发|长发|眼镜|身高|穿搭|发型|刘海|妆容|身材|颜值/.test(s)) return false;
  if (/(喜欢|爱吃|爱喝|爱看|爱玩|讨厌|不吃|不喝|忌口)/.test(s)
    && !/(不轻易喜欢|不容易喜欢上|容易喜欢上人)/.test(s)) return false;
  if (/(朋友|闺蜜|家人|父母|同事|前任|对象)/.test(s)
    && !/(不善社交|社恐|人缘|合群|慢热)/.test(s)) return false;
  if (PERSONALITY_TRAIT_RE.test(s)) return true;
  if (/用户是个|是个比较|脾气来得|容易(想很多|哭|怒|急|焦虑|内耗|心软|被.{0,4}打动)/.test(s)) return true;
  if (/^(很|比较|有点|特别|挺)?(内向|外向|敏感|慢热|直|感性|理性|粘人|高冷|热情|纠结|好强|随和|别扭)(的人)?$/.test(s)) {
    return true;
  }
  return false;
}

/** 稳定的情绪反应模式（不是单次心情） */
function looksLikeEmotionFact(text) {
  const s = String(text || '').replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
  if (s.length < 2 || s.length > 28) return false;
  if (looksLikePersonalityTrait(s)) return false;
  if (/(今天|刚才|昨天|这周|因为|然后|后来|某天)/.test(s)) return false;
  if (/(一(生气|难过|烦|委屈|焦虑|害怕|不开心).{0,10})/.test(s)) return true;
  if (/(难过时|生气时|烦的时候|委屈了|情绪上来).{0,12}/.test(s)) return true;
  if (/(发脾气|生闷气|冷战|闷着不说|摔东西|吼出来|把人推开)/.test(s)) return true;
  return false;
}

/** 想法/在意点：不是具体物喜好，也不是性格标签 */
function looksLikeThoughtFact(text) {
  const s = String(text || '').replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
  if (s.length < 2 || s.length > 28) return false;
  if (looksLikePersonalityTrait(s) || looksLikeEmotionFact(s)) return false;
  if (/(爱吃|爱喝|爱看|爱玩|爱听)/.test(s)) return false;
  if (/(今天|刚才|昨天|因为|然后|后来|某天)/.test(s)) return false;
  if (/(喜欢|不喜欢|讨厌).{0,2}(被|别人|人家|对方|冷落|忽视|关心|打扰|催|压力|管束)/.test(s)) return true;
  if (/(想很多|想太多|胡思乱想|钻牛角尖|放不下|想不通|总觉得|老觉得|觉得自己|心里总|脑子里总)/.test(s)) return true;
  if (/(在意|介意).{1,12}/.test(s) && !/(在意吃|在意穿|在意颜)/.test(s)) return true;
  return false;
}

function isStandingPortraitItem(cat, content) {
  if (cat === '性格' || cat === '情绪' || cat === '想法') return true;
  if (cat === '习惯' && looksLikePersonalityTrait(content)) return true;
  return false;
}

/** 把具体事件压成「是什么样的人」式概括；单次推断标 uncertain */
function generalizeImpressionTrait(fact) {
  let s = String(fact || '').trim();
  if (!s || isJunkImpressionFact(s)) return null;

  let uncertain = /好像|或许|大概|估计|似乎|可能|猜测|不确定|不清楚|不知道是不是/.test(s);
  s = s.replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();

  const isEvent = /(去世|死了|离世|失去|分手|离别|吵架|和好|那天|有一次|某天|当时|因为.{2,18}而(难过|哭|伤心|生气|开心|落泪|掉了泪)|家里.{0,6}(养|的小|宠物|猫|狗|鱼)|考试|面试|加班|生病|住院)/.test(s);
  const isNarrative = s.length > 22 && /(因为|所以|然后|后来|提到|说起|回忆|想起)/.test(s);

  // 事件属于记忆点，不要压成「用户是个比较感性的人」这种空标签
  if (isEvent || isNarrative) return null;

  // 已是稳定偏好/习惯式短句，保留（分类交给后续映射，不默认性格）
  if (/^(爱|喜欢|讨厌|不爱|擅长|不擅长|习惯|总是|经常|不会|会|很|比较|有点|特别)/.test(s)) {
    return { content: s, category: null, uncertain };
  }
  if (/^(用户|TA|他|她)/.test(s) && s.length <= 18 && !/(因为|然后|后来|那天)/.test(s)) {
    return { content: s, category: null, uncertain };
  }

  if (/朋友|闺蜜|兄弟|同事|家人|爸妈|对象|恋爱|社交|人际|室友|同学/.test(s) && s.length <= 28) {
    return { content: s.replace(/^用户/, '').trim(), category: '人际关系', uncertain };
  }
  if (/喜欢|爱吃|讨厌|不爱|偏好|习惯|擅长|不擅长/.test(s) && s.length <= 22) {
    return { content: s.replace(/^用户/, '').trim(), category: null, uncertain };
  }

  // 过细、不像画像的丢弃
  if (s.length > 20 || /(因为|然后|后来|提到|说起)/.test(s)) return null;

  return { content: s, category: null, uncertain };
}

/** 压成短画像句：去掉日期/时段/「用户说过」腔，一条一事 */
function toImpressionFact(content) {
  let s = sanitizeMemoryContent(String(content || ''));
  s = s
    .replace(MEMORY_TIME_PREFIX_RE, '')
    .replace(/\d{4}\s*[-年/\.]\s*\d{1,2}\s*[-月/\.]\s*\d{1,2}\s*日?/g, '')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, '')
    .replace(/(今天|昨天|前天|上周|前些天|那天|有一次|某天)/g, '')
    .replace(/^(清晨|上午|中午|下午|傍晚|晚上|夜里|夜深了|凌晨)[，,、\s]*/g, '')
    .replace(/(清晨|上午|中午|下午|傍晚|晚上|夜里|夜深了|凌晨)/g, '')
    // 只剥「用户说过/提到」这类转述，保留「用户是个…」这种画像主语
    .replace(/^(用户|对方|TA|他|她)(曾经)?(总是|经常|好像|似乎)?(表示|说过|提到|说起|说)/i, '')
    .replace(/^[：:，,、\s]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length > IMPRESSION_MAX_ITEM_LEN) {
    const first = s.split(/[，,。！？]/)[0].trim();
    s = (first.length >= 2 ? first : s).slice(0, IMPRESSION_MAX_ITEM_LEN);
  }
  s = s.replace(/^(清晨|上午|中午|下午|傍晚|晚上|夜里|夜深了|凌晨)[，,、\s]*/g, '').trim();
  return s.trim();
}

/** 过滤时段残渣、过短、纯时间等无意义画像 */
function isJunkImpressionFact(content) {
  const s = String(content || '').trim();
  if (s.length < 2) return true;
  if (IMPRESSION_TIME_SLOT_RE.test(s)) return true;
  if (/^[\d\s:：\-./点分秒年月日期]+$/.test(s)) return true;
  if (/经期|生理期|痛经|例假|大姨妈/i.test(s)) return true;
  if (/[？?]$/.test(s)) return true;
  // 只剩「了的呢」等虚词
  if (/^[了的呢啊呀吧嘛哦嗯]+$/.test(s)) return true;
  // 半截话 / 无结论残句（VPS 已出现「面对…网文测试」「…明确表示」）
  if (/^(面对|关于|针对|在与|在和|当|跟).{2,24}$/.test(s) && !/[。！？]$/.test(s) && s.length < 18) return true;
  if (/(明确表示|表示过|说过|提到|念的|聊起的?)$/.test(s)) return true;
  if (/明确表示\s*$/.test(s) || /面对.{0,20}(测试|题目|网文)\s*$/.test(s)) return true;
  if (s.length < 8 && !/[。！？]$/.test(s) && !/(喜欢|讨厌|习惯|爱|怕|不爱|在意|容易)/.test(s)) return true;
  // 对话元描述 / 空泛总结，不是画像
  if (/^(聊过|说过|提到|表示|觉得|感觉到|好像在|正在|刚才|我觉得|我认为|我感觉)/.test(s)) return true;
  if (/^(回消息|发消息|在线|离线|已读|未读)$/.test(s)) return true;
  if (/(今天|昨天|刚才|这周|这天).{2,}/.test(s)) return true;
  if (s.length > IMPRESSION_MAX_ITEM_LEN) return true;
  if (/[的地得与和是在了着过]$/.test(s) && s.length <= 10) return true;
  try {
    if (require('./portrait-cluster-helper').looksLikeEventFact(s)) return true;
  } catch { /* ignore */ }
  // 角色自我中心脑补：把用户预设成会来抱怨/哭诉的人
  if (/(爱|会|总|喜欢|经常).{0,6}(抱怨|哭诉|倾诉|找我哭|跟我哭|跟我抱怨|向我诉苦)/.test(s)) return true;
  if (/(情绪垃圾桶|树洞|发泄对象|倾诉对象)/.test(s)) return true;
  return false;
}

function normalizeImpressionCategory(cat) {
  let c = String(cat == null ? '' : cat).trim().slice(0, 12);
  if (!c) return '';
  // 时段名不能当分类
  if (IMPRESSION_TIME_SLOT_RE.test(c)) return '';
  if (c === '情绪反应') return '情绪';
  if (c === '爱好') return '喜好';
  if (c === '在意' || c === '念头') return '想法';
  if (c === '其他' || c === '变化') return c;
  if (IMPRESSION_CATEGORY_HINTS.includes(c)) return c;
  return c;
}

function orderImpressionCategories(cats) {
  const set = [...new Set((cats || []).map(c => normalizeImpressionCategory(c)).filter(Boolean))];
  const preferred = IMPRESSION_CATEGORY_HINTS.filter(c => set.includes(c));
  const rest = set.filter(c => !IMPRESSION_CATEGORY_HINTS.includes(c))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return [...preferred, ...rest];
}

function impressionFactsSimilar(a, b) {
  const x = String(a || '').replace(/\s/g, '');
  const y = String(b || '').replace(/\s/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

/** 把旧版「一类一长串用；拼接」拆成一条一条短印象；顺带清掉时段残渣 */
function expandLegacyImpressions(charId = null) {
  let rows = [];
  try {
    rows = charId != null
      ? db.prepare('SELECT * FROM char_impressions WHERE character_id=?').all(charId)
      : db.prepare('SELECT * FROM char_impressions').all();
  } catch { return; }

  for (const row of rows) {
    const raw = String(row.content || '');
    // 纯时段垃圾直接删
    if (isJunkImpressionFact(toImpressionFact(raw)) && isJunkImpressionFact(raw.trim())) {
      db.prepare('DELETE FROM char_impressions WHERE id=?').run(row.id);
      continue;
    }

    const needsSplit = /[；;\n]/.test(raw) || raw.length > IMPRESSION_MAX_ITEM_LEN + 8;
    const parts = raw
      .split(/[；;\n]/)
      .map(s => toImpressionFact(s))
      .filter(s => s.length >= 2 && !isJunkImpressionFact(s));
    if (!parts.length) {
      db.prepare('DELETE FROM char_impressions WHERE id=?').run(row.id);
      continue;
    }

    if (!needsSplit && parts.length === 1) {
      let cat = normalizeImpressionCategory(row.category);
      if (!cat) cat = mapMemoryToImpressionCategory('', parts[0]) || '';
      if (cat === '性格' && !looksLikePersonalityTrait(parts[0])) {
        const remapped = mapMemoryToImpressionCategory('', parts[0]);
        if (remapped && remapped !== '性格') cat = remapped;
        else if (row.auto_generated) {
          db.prepare('DELETE FROM char_impressions WHERE id=?').run(row.id);
          continue;
        } else {
          cat = remapped || row.category || '性格';
        }
      }
      if (!cat) {
        if (row.auto_generated) {
          db.prepare('DELETE FROM char_impressions WHERE id=?').run(row.id);
        }
        continue;
      }
      if (parts[0] !== raw.trim() || cat !== row.category) {
        db.prepare('UPDATE char_impressions SET content=?, category=? WHERE id=?')
          .run(parts[0], cat, row.id);
      }
      continue;
    }
    if (parts.length === 1 && !needsSplit) continue;

    let kws = [];
    try { kws = JSON.parse(row.keywords || '[]'); } catch { kws = []; }
    let cat = normalizeImpressionCategory(row.category);
    if (!cat) cat = mapMemoryToImpressionCategory('', parts[0]) || '';
    const auto = row.auto_generated ? 1 : 0;
    db.prepare('DELETE FROM char_impressions WHERE id=?').run(row.id);
    const ins = db.prepare(
      `INSERT INTO char_impressions (character_id, content, keywords, category, auto_generated) VALUES (?,?,?,?,?)`
    );
    for (const p of parts) {
      let pCat = cat;
      if (!pCat) pCat = mapMemoryToImpressionCategory('', p) || '';
      if (pCat === '性格' && !looksLikePersonalityTrait(p)) {
        const remapped = mapMemoryToImpressionCategory('', p);
        if (remapped && remapped !== '性格') pCat = remapped;
        else if (auto) continue;
        else pCat = remapped || '性格';
      }
      if (!pCat) continue;
      ins.run(row.character_id, p, JSON.stringify(deriveImpressionKeywords(p, kws)), pCat, auto);
    }
  }
}

const IMPRESSION_STOP_KW_RE = /^(用户|对方|自己|是个|比较|有点|特别|非常|超级|的人|一下|一个|这个|那个|什么|不是|就是|还是|可以|觉得|感觉|真的|有些|喜欢|不爱|讨厌|总是|经常|容易|习惯|擅长|不会)$/;
const IMPRESSION_PARTICLE_RE = /^[的了呢吗啊呀吧嘛哦嗯着过得地我你他她它]$/;

/** 分类级话题：聊到这类事才亮这类画像（避免「感性」只能在说出「感性」时才注入） */
const IMPRESSION_CATEGORY_TOPIC_RE = {
  '性格': /性格|脾气|气质|内向|外向|敏感|慢热|直爽|感性|理性|想太多|想很多|内耗|心软|嘴硬|社恐|玻璃心|别扭|好强|纠结|粘人|独立|难过|伤心|哭|委屈|焦虑|感动/,
  '喜好': /喜欢|不喜欢|爱吃|爱喝|爱看|爱玩|讨厌|偏好|想吃|想喝|想看|好吃|好喝|吃什么|饿了|外卖|晚饭|午饭|早饭|干饭|喝点|口味|火锅|奶茶|咖啡|酒/,
  '习惯': /习惯|作息|熬夜|早起|每天|经常|总是|一般会|晚睡|失眠|困|几点睡/,
  '不擅长': /不擅长|不会|苦手|搞不定|学不会|怕做|做不好/,
  '样子': /头发|发型|短发|长发|眼镜|穿搭|衣服|自拍|好看|外貌|打扮|妆|身高|身材/,
  '人际关系': /朋友|闺蜜|家人|父母|爸妈|同事|同学|前任|对象|恋爱|社交|人际|人缘|合群/,
};

function isUsefulImpressionKeyword(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (IMPRESSION_TIME_SLOT_RE.test(t)) return false;
  if (IMPRESSION_STOP_KW_RE.test(t)) return false;
  if (IMPRESSION_PARTICLE_RE.test(t)) return false;
  if (t.length === 1) return /[\u4e00-\u9fff]/.test(t);
  return t.length >= 2 && t.length <= 12;
}

function impressionContentCore(text) {
  return String(text || '')
    .replace(/（\?）\s*$/, '')
    .replace(/\(\?\)\s*$/, '')
    .replace(/^(用户|对方|TA|他|她)(是个|是一位|是)/, '')
    .replace(/^(不)?(喜欢|爱吃|爱喝|爱看|爱玩|爱听|爱|讨厌|擅长|不擅长|不会|会|习惯于?|总是|经常|容易)/, '')
    .replace(/^(很|比较|有点|特别|超级)/, '')
    .replace(/的人$/, '')
    .trim();
}

/** 画像短句和当前对话是否处在同一话题域（爱吃辣 ↔ 火锅/想吃） */
function impressionSemanticHits(content, category, ctx) {
  const s = String(content || '');
  const c = String(ctx || '');
  if (!s || !c) return false;
  try {
    const cluster = require('./portrait-cluster-helper');
    if (cluster.familiesOverlap(s, c)) return true;
  } catch { /* ignore */ }
  if (/辣|辣椒|麻辣/.test(s) && /辣|火锅|川菜|麻辣|香锅/.test(c)) return true;
  if (/甜|甜食/.test(s) && /甜|奶茶|蛋糕|甜食/.test(c)) return true;
  if (/爱吃|喜欢吃|好吃|火锅|口味/.test(s) && /吃什么|想吃|饿了|外卖|干饭|晚饭|午饭|早饭/.test(c)) return true;
  if (/爱喝|喜欢喝/.test(s) && /喝点|想喝|咖啡|奶茶|茶|酒/.test(c)) return true;
  if (/爱看|喜欢看/.test(s) && /看剧|电影|追剧|番|小说/.test(c)) return true;
  if (/爱玩|喜欢玩|游戏/.test(s) && /玩游戏|打游戏|游戏|开黑/.test(c)) return true;
  if (/熬夜|晚睡|夜猫/.test(s) && /睡|困|熬夜|失眠|好晚/.test(c)) return true;
  if (/早起/.test(s) && /早起|起床|闹钟/.test(c)) return true;
  if (/猫/.test(s) && /猫|喵/.test(c)) return true;
  if (/狗/.test(s) && /狗|汪/.test(c)) return true;
  if (category === '性格' || looksLikePersonalityTrait(s)) {
    if (/感性|重感情|心软|念旧/.test(s) && /难过|伤心|哭|感动|心疼|落泪/.test(c)) return true;
    if (/想很多|内耗|多想|焦虑/.test(s) && /想太多|胡思乱想|焦虑|睡不着|担心/.test(c)) return true;
    if (/慢热|社恐/.test(s) && /慢热|不熟|社恐|认生|见人/.test(c)) return true;
    if (/嘴硬|别扭|傲娇/.test(s) && /嘴硬|别扭|口是心非/.test(c)) return true;
  }
  return false;
}

/** 从短句自动抽触发词（爱吃辣 → 辣），丢掉停用词和记忆事件残渣 */
function deriveImpressionKeywords(content, existing = []) {
  const out = [];
  const seen = new Set();
  const push = (k) => {
    const s = String(k || '').trim();
    if (!isUsefulImpressionKeyword(s)) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  const text = toImpressionFact(content);
  const core = impressionContentCore(text);

  (Array.isArray(existing) ? existing : []).forEach((k) => {
    const s = String(k || '').trim();
    if (!isUsefulImpressionKeyword(s)) return;
    // 旧数据常把记忆事件词写进 keywords；只留和本条画像相关的
    if (text && s.length >= 2 && !text.includes(s) && !(core && core.includes(s))) return;
    push(s);
  });

  if (!text) return out.slice(0, 8);

  if (text.length <= 12) push(text);
  if (core && core !== text) push(core);

  const traitHit = text.match(PERSONALITY_TRAIT_RE);
  if (traitHit) push(traitHit[0]);

  return out.slice(0, 8);
}

/**
 * 印象挑选：话题命中的条目 + 可选「性格/情绪反应」常驻画像。
 * 常驻项用来读懂这轮话，不要求用户把性格标签说出口。
 */
function pickImpressionCandidates(charId, contextText = '', {
  max = IMPRESSION_PROMPT_MAX,
  perCat = IMPRESSION_PROMPT_PER_CAT,
  includeStanding = false,
} = {}) {
  try { expandLegacyImpressions(charId); } catch {}
  const ctx = String(contextText || '');
  const ctxLower = ctx.toLowerCase();
  const cluster = require('./portrait-cluster-helper');
  try { cluster.ensureClusterColumns(); } catch {}
  const voice = cluster.getVoiceCtx(charId);

  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM char_impressions WHERE character_id=? ORDER BY id DESC').all(charId);
  } catch {
    try {
      rows = db.prepare(
        'SELECT id, content, category, keywords FROM char_impressions WHERE character_id=? ORDER BY id DESC'
      ).all(charId);
    } catch { return { picked: [], voice }; }
  }
  if (!rows.length) return { picked: [], voice };

  const standingBudget = includeStanding ? 4 : 0;
  const topicMax = Math.max(1, max - standingBudget);
  const perCatCount = {};
  const scored = [];

  let vecScores = [];
  try {
    const blobs = rows.map((r) => cluster.cardFacts(r).join('、'));
    const eh = require('./embed-helper');
    vecScores = eh.scoreTextsAgainst(
      ctx,
      blobs.map((content) => ({ content })),
      { corpus: eh.buildCorpusDf([...blobs, ctx]) }
    );
  } catch { vecScores = rows.map(() => 0); }

  if (ctx.trim()) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cat = normalizeImpressionCategory(row.category);
      if (!cat) continue;
      const facts = cluster.cardFacts(row).map((f) => cluster.rewriteVoice(f, { ...voice, voice: 'user-portrait' }))
        .filter((f) => f && !isJunkImpressionFact(f));
      const blob = facts.join('、');
      if (!blob) continue;
      let stored = [];
      try { stored = JSON.parse(row.keywords || '[]'); } catch { stored = []; }
      const kws = deriveImpressionKeywords(blob, stored);
      let score = 0;
      let keywordHit = false;
      for (const k of kws) {
        const kk = String(k).toLowerCase();
        if (!kk || !ctxLower.includes(kk)) continue;
        keywordHit = true;
        score += kk.length >= 3 ? 4 : (kk.length === 1 ? 2 : 3);
      }
      if (facts.some((t) => t.length >= 2 && ctxLower.includes(t.toLowerCase()))) {
        keywordHit = true;
        score += 5;
      }
      const semanticHit = facts.some((t) => impressionSemanticHits(t, cat, ctx));
      if (semanticHit) score += 5;
      const vec = vecScores[i] || 0;
      if (vec >= 0.28) score += 4;
      const topicRe = IMPRESSION_CATEGORY_TOPIC_RE[cat];
      const topicHit = !!(topicRe && topicRe.test(ctx));
      const topicAloneOk = topicHit && (['性格', '样子', '人际关系', '不擅长'].includes(cat)
        || (cat === '喜好' && /吃|喝|口味|菜|酒|茶|咖啡|甜|辣|火锅/.test(blob))
        || (cat === '习惯' && /睡|熬夜|早起|作息|困/.test(blob)));
      if (topicAloneOk) score += 3;
      else if (topicHit) score += 1;
      if (!keywordHit && !semanticHit && !topicAloneOk && vec < 0.28) continue;
      if (score <= 0) continue;
      if (row.confirmed !== 0) score += 1;
      const note = String(row.note || '').trim();
      scored.push({
        cat, facts, note, score, confirmed: row.confirmed !== 0, id: row.id,
        standing: isStandingPortraitItem(cat, blob),
        vecScore: vec,
        keywordHit: !!(keywordHit || semanticHit || topicAloneOk),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || (b.confirmed ? 1 : 0) - (a.confirmed ? 1 : 0));
  const picked = [];
  const seen = new Set();
  for (const item of scored) {
    const key = `${item.cat}:${item.facts[0] || ''}`.slice(0, 40);
    if (seen.has(key)) continue;
    if ((perCatCount[item.cat] || 0) >= perCat) continue;
    seen.add(key);
    perCatCount[item.cat] = (perCatCount[item.cat] || 0) + 1;
    picked.push(item);
    if (picked.length >= topicMax) break;
  }

  if (includeStanding) {
    const haveIds = new Set(picked.map((p) => p.id));
    const standing = [];
    for (const row of rows) {
      if (haveIds.has(row.id)) continue;
      const cat = normalizeImpressionCategory(row.category);
      const facts = cluster.cardFacts(row).map((f) => cluster.rewriteVoice(f, { ...voice, voice: 'user-portrait' }))
        .filter((f) => f && !isJunkImpressionFact(f));
      const blob = facts.join('、');
      if (!blob || !isStandingPortraitItem(cat, blob)) continue;
      standing.push({
        cat,
        facts,
        note: String(row.note || '').trim(),
        score: 0,
        confirmed: row.confirmed !== 0,
        id: row.id,
        standing: true,
        vecScore: 0,
        keywordHit: false,
      });
    }
    standing.sort((a, b) => (b.confirmed ? 1 : 0) - (a.confirmed ? 1 : 0) || (b.id || 0) - (a.id || 0));
    for (const item of standing) {
      if (picked.length >= max) break;
      const key = `${item.cat}:${item.facts[0] || ''}`.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(item);
    }
  }

  return { picked, voice };
}

function formatCatImpressionLines(items) {
  return items.map((p) => {
    const head = `【${p.cat}】`;
    const body = p.facts.map((t) => `・${t}${p.confirmed ? '' : '（?）'}`).join('\n');
    const note = p.note ? `\nTA：${p.note}` : '';
    return `${head}\n${body}${note}`;
  }).join('\n');
}

/** 印象注入：只给事实，不套「你想起来她」句式 */
function formatFuzzyImpressionLines(items) {
  return items.map((p) => {
    const fact = String((p.facts && p.facts[0]) || p.content || '').trim();
    if (!fact) return '';
    const soft = fact
      .replace(/^(她|他|TA|Ta|ta|对方|用户)\s*/u, '')
      .replace(/用户|对方/g, 'TA')
      .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g, '很久以前')
      .replace(/\d+(\.\d+)?/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!soft) return '';
    return `· ${soft}${p.confirmed ? '' : '（不太确定）'}`;
  }).filter(Boolean).join('\n');
}

function formatImpressionCandidates(picked, voice, opts = {}) {
  if (!picked?.length) return '';
  const usageHint = opts.usageHint
    || (() => { try { return require('./memory-gate-helper').MEMORY_USAGE_HINT; } catch { return ''; } })();
  const fuzzy = opts.fuzzy !== false;
  if (fuzzy) {
    const lines = formatFuzzyImpressionLines(picked);
    if (!lines) return '';
    const parts = [
      `【相关印象】这轮话勾起的；点到了就接上，别装不记得，别念档案。`,
      lines,
    ];
    if (usageHint) parts.push(usageHint);
    return parts.join('\n');
  }
  const readThru = picked.filter((p) => p.standing || p.cat === '性格' || p.injectMode === 'background_only');
  const topical = picked.filter((p) => !(p.standing || p.cat === '性格' || p.injectMode === 'background_only'));
  const parts = [`【相关印象】这轮话勾起的；点到了就接上，别装不记得，别念档案。`];
  if (readThru.length) {
    parts.push(formatCatImpressionLines(readThru));
  }
  if (topical.length) {
    parts.push(formatCatImpressionLines(topical));
  }
  if (usageHint) parts.push(usageHint);
  return parts.join('\n');
}

function formatImpressionsForPrompt(charId, contextText = '', opts = {}) {
  try {
    const { picked, voice } = pickImpressionCandidates(charId, contextText, {
      max: opts.max || 2,
      includeStanding: opts.includeStanding !== false,
    });
    return formatImpressionCandidates(picked, voice, { fuzzy: true, ...opts });
  } catch {
    return '';
  }
}

function mapMemoryToImpressionCategory(memCategory, content) {
  const cat = String(memCategory || '').trim();
  const text = String(content || '');
  // 约定/待办/重要时刻偏事件记忆，不进画像
  if (cat === '约定' || cat === '待办' || cat === '重要时刻') return null;
  if (/不擅长|不会|苦手|搞不定|做不好|学不会|怕做/.test(text)) return '不擅长';
  if (/长相|外貌|发型|头发|眼睛|身高|穿搭|打扮|自拍|样子|颜值|脸|妆|身材|眼镜|刘海/.test(text)) {
    return '样子';
  }
  if (/朋友|闺蜜|家人|父母|爸|妈|同事|上司|同学|前任|对象|恋爱|单身|社交|人际|合群|人缘/.test(text)
    && !looksLikePersonalityTrait(text)) {
    return '人际关系';
  }
  if (looksLikePersonalityTrait(text)) return '性格';
  if (looksLikeEmotionFact(text)) return '情绪';
  if (looksLikeThoughtFact(text)) return '想法';
  if (cat === '偏好与习惯') {
    // 具体物偏好才进喜好；「总是想很多」这类不应进习惯
    if (looksLikePersonalityTrait(text)) return '性格';
    if (looksLikeThoughtFact(text)) return '想法';
    if (/喜欢|爱|偏好|讨厌|不爱|忌|想要|想喝|想吃|爱吃|爱喝|爱看|爱玩/.test(text)
      && !/(喜欢|不喜欢|讨厌).{0,2}(被|别人|人家|对方)/.test(text)) {
      return '喜好';
    }
    return '习惯';
  }
  // 喜好：具体事物偏好，不要把「喜欢胡思乱想」算进来（已由想法抢走）
  if (/喜欢|爱吃|讨厌|爱看|爱玩|偏好/.test(text)
    && !/(喜欢|不喜欢|讨厌).{0,2}(被|别人|人家|对方)/.test(text)
    && !/(胡思乱想|想很多|想太多)/.test(text)) {
    return '喜好';
  }
  if (/总是|经常|习惯|每天|一般会/.test(text)) {
    if (looksLikePersonalityTrait(text)) return '性格';
    if (looksLikeThoughtFact(text)) return '想法';
    if (looksLikeEmotionFact(text)) return '情绪';
    return '习惯';
  }
  // 情感状态：只有像稳定气质/想法/情绪模式才进画像
  if (cat === '情感状态') {
    if (looksLikePersonalityTrait(text)) return '性格';
    if (looksLikeEmotionFact(text)) return '情绪';
    if (looksLikeThoughtFact(text)) return '想法';
    return null;
  }
  // 不再默认丢进「性格」垃圾桶
  return null;
}

/** 内容优先：纠正 LLM 把性格丢进习惯、把想法丢进喜好 */
function resolveImpressionCategory(hintCat, content) {
  const text = String(content || '');
  if (looksLikePersonalityTrait(text)) return '性格';
  if (looksLikeEmotionFact(text)) return '情绪';
  if (looksLikeThoughtFact(text)) return '想法';
  const mapped = mapMemoryToImpressionCategory('', text);
  if (mapped) return mapped;
  const hint = normalizeImpressionCategory(hintCat);
  if (hint && hint !== '其他') return hint;
  return hint || '';
}

/** 每条印象按关联收进同一张卡（大类+小类），去重；称呼统一 */
function mergeImpressionItems(charId, items) {
  if (!items?.length) return 0;
  try { expandLegacyImpressions(charId); } catch {}
  const cluster = require('./portrait-cluster-helper');
  cluster.ensureClusterColumns();
  let merged = 0;

  for (const it of items) {
    if (it.category === null) continue;
    let cat = normalizeImpressionCategory(it.category);
    const baseKws = Array.isArray(it.keywords)
      ? it.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 8)
      : [];
    const facts = String(it.content || '')
      .split(/[；;\n]/)
      .map(s => toImpressionFact(s))
      .filter(s => s.length >= 2 && !isJunkImpressionFact(s));
    const note = String(it.note || '').trim();

    if (it.bundle) {
      let rowCat = resolveImpressionCategory(it.category, facts.join('、')) || normalizeImpressionCategory(it.category);
      if (!rowCat && facts[0]) {
        const gen = generalizeImpressionTrait(facts[0]);
        rowCat = resolveImpressionCategory(gen?.category, facts[0])
          || (gen?.category ? normalizeImpressionCategory(gen.category) : '')
          || mapMemoryToImpressionCategory('', facts[0]);
      }
      if (!rowCat) continue;
      const r = cluster.upsertPortraitCard({
        table: 'char_impressions',
        charId,
        major: rowCat,
        subcategory: it.subcategory || cluster.guessSubcategory(rowCat, facts.join('、'), 'char_impressions'),
        facts,
        note,
        keywords: deriveImpressionKeywords(facts.join('、'), baseKws),
        confirmed: it.confirmed != null ? (it.confirmed ? 1 : 0) : 1,
        extra: {
          forceBundle: true,
          auto_generated: it.auto_generated ? 1 : (it.auto_generated === 0 ? 0 : 1),
          strength: Math.max(0.2, Math.min(1, Number(it.strength) || 0.65)),
          evidence_ids: Array.isArray(it.evidence_ids) ? it.evidence_ids : [],
        },
      });
      if (r === 'inserted' || r === 'appended') merged++;
      continue;
    }

    for (const fact0 of facts) {
      const gen = generalizeImpressionTrait(fact0);
      if (!gen?.content || isJunkImpressionFact(gen.content)) continue;
      let rowCat = resolveImpressionCategory(it.category, gen.content)
        || (gen.category ? normalizeImpressionCategory(gen.category) : '')
        || normalizeImpressionCategory(it.category);
      if (!rowCat) {
        rowCat = mapMemoryToImpressionCategory('', gen.content) || '';
      }
      if (rowCat === '性格' && !looksLikePersonalityTrait(gen.content) && !looksLikeEmotionFact(gen.content) && !looksLikeThoughtFact(gen.content)) {
        const remapped = mapMemoryToImpressionCategory('', gen.content);
        if (remapped && remapped !== '性格') rowCat = remapped;
        else continue;
      }
      if (!rowCat) continue;

      let confirmed = gen.uncertain ? 0 : (it.confirmed != null ? (it.confirmed ? 1 : 0) : 1);
      let fact = gen.content.replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
      if (/好像|或许|大概|估计|似乎|可能|猜测|不确定|不清楚|不知道是不是/.test(fact)) {
        confirmed = 0;
      }
      const r = cluster.upsertPortraitCard({
        table: 'char_impressions',
        charId,
        major: rowCat,
        subcategory: it.subcategory || cluster.guessSubcategory(rowCat, fact, 'char_impressions'),
        fact,
        note,
        keywords: deriveImpressionKeywords(fact, baseKws),
        confirmed,
        extra: {
          auto_generated: it.auto_generated ? 1 : (it.auto_generated === 0 ? 0 : 1),
          strength: Math.max(0.2, Math.min(1, Number(it.strength) || (confirmed ? 0.65 : 0.45))),
          evidence_ids: Array.isArray(it.evidence_ids) ? it.evidence_ids : [],
        },
      });
      if (r === 'inserted' || r === 'appended') merged++;
    }
  }
  try { cluster.compactPortraitCards(charId, 'char_impressions'); } catch { /* ignore */ }
  try {
    const tree = require('./memory-tree-helper');
    for (const it of items) {
      const cat = normalizeImpressionCategory(it.category) || '';
      if (cat) tree.touchPortraitCategory(charId, 'user', cat, { charge: 0.25 });
    }
    if (merged) tree.syncPortraitFromCards(charId, 'user');
  } catch (e) {
    console.warn('[impressions] tree sync', e.message);
  }
  return merged;
}

function impressionItemsFromMemoryEpisode(parsed, memoryItems, charName = '', userName = '') {
  const items = [];
  for (const item of memoryItems || []) {
    const raw = String(item.content || '');
    const catMem = String(item.category || '');
    // 记忆正文是事件叙述。只有「偏好与习惯」里用户亲口确认的稳定偏好才允许回流画像，
    // 情感状态/日常点滴/重要时刻一律不进——那是「乱七八糟」的主要来源。
    if (catMem !== '偏好与习惯') continue;
    if (isInvalidUserPreferenceMemory(raw, '偏好与习惯', charName, userName)) continue;
    const fact = toImpressionFact(raw);
    if (!fact || isJunkImpressionFact(fact)) continue;
    const gen = generalizeImpressionTrait(fact);
    if (!gen?.content || isJunkImpressionFact(gen.content)) continue;
    const category = gen.category || mapMemoryToImpressionCategory(item.category, gen.content);
    if (!category) continue;
    const confirmed = 0;
    items.push({ category, content: gen.content, keywords: [], confirmed });
  }
  return items;
}

/** 忙碌超时自动回来（另可用户点「叫TA一下」） */
async function checkBusyAutoReturn() {
  const chars = db.prepare(`SELECT id, busy_since, busy_style FROM characters WHERE status='busy'`).all();
  for (const char of chars) {
    if (char.busy_style === 'off') continue;
    let sinceMs = NaN;
    if (char.busy_since) {
      sinceMs = parseMsgTimestamp(char.busy_since).getTime();
    } else {
      const lastBusy = db.prepare(
        `SELECT timestamp FROM messages WHERE character_id=? AND role='assistant' AND content LIKE '【自动回复】%' ORDER BY id DESC LIMIT 1`
      ).get(char.id);
      if (lastBusy?.timestamp) sinceMs = parseMsgTimestamp(lastBusy.timestamp).getTime();
    }
    if (!Number.isFinite(sinceMs)) continue;
    const minBusy = 28 + (hashDaySeed(char.id, 'busy-ret') % 32);
    if (Date.now() - sinceMs < minBusy * 60000) continue;
    clearCharacterOnline(char.id);
    push('status_change', { characterId: char.id, status: 'online' });
    console.log(`[cron] char#${char.id} busy auto-return after ~${minBusy}m`);
  }
}

function startCronJobs(interactFn, npcInteractFn, ownerNpcReplyFn) {
  if (interactFn) aiInteractWithMoment = interactFn;
  if (npcInteractFn) aiNpcInteractWithMoment = npcInteractFn;
  if (ownerNpcReplyFn) replyOwnerToNpcComments = ownerNpcReplyFn;

  // 主动消息先挂上：后面 node-cron 若因非法时区抛错，不能把主动消息一起带走
  setInterval(() => {
    checkProactiveMessage().catch(e => console.error('[cron] proactive msg tick', e.message));
  }, 60 * 1000);

  setInterval(() => {
    try {
      const r = require('./ta-helper').tickPhoneAlerts();
      if (r?.notified) console.log(`[cron] ta phone alert ${r.type} char=${r.characterId}`);
    } catch (e) {
      console.warn('[cron] ta phone alert', e.message);
    }
  }, 90 * 1000);

  setInterval(() => {
    try {
      const { refreshBoundCharacterDrive } = require('./robot-drive-helper');
      refreshBoundCharacterDrive().catch((e) => console.error('[cron] robot drive refresh', e.message));
    } catch (e) {
      console.error('[cron] robot drive init', e.message);
    }
  }, 10 * 60 * 1000);

  const tzOpt = () => ({ timezone: resolveIanaTimezone(getSettings().timezone) });
  const schedule = (expr, fn) => {
    try {
      cron.schedule(expr, fn, tzOpt());
    } catch (e) {
      console.warn('[cron] schedule failed', expr, e.message);
      try { cron.schedule(expr, fn); } catch (e2) {
        console.warn('[cron] schedule fallback failed', expr, e2.message);
      }
    }
  };

  // 每日行程：本地时区凌晨 4 点（避开早高峰叠生图）
  schedule('0 4 * * *', async () => {
    console.log('[cron] 生成今日行程...');
    await generateAllDailySchedules();
  });
  // 4:30 补跑：防止 4 点失败、或昨日凌晨残条挡住今日生成
  schedule('30 4 * * *', async () => {
    console.log('[cron] 行程补跑 (4:30)...');
    await catchUpMissedSchedules();
  });

  // 忙碌自动回来：每 5 分钟检查
  schedule('*/5 * * * *', async () => {
    await checkBusyAutoReturn();
  });

  // 行程回顾：时段结束后根据聊天补全回顾（仅当自动回顾开启时）
  schedule('*/15 * * * *', async () => {
    const s = getSettings();
    if (String(s.schedule_auto_retrospect) === '1') {
      await finalizeAllPastScheduleItems();
    }
  });

  // 情绪：时间回落采样 + 未读/已读未回按人设影响
  schedule('*/15 * * * *', async () => {
    try {
      const r = emotionHelper.tickAllCharacterEmotions();
      if (r && (r.sampled || r.silence)) {
        console.log(`[cron] emotion tick sampled=${r.sampled} silence=${r.silence}`);
      }
    } catch (e) {
      console.warn('[cron] emotion tick', e.message);
    }
  });

  // 感情线：日子往前走，阶段会慢慢从「刚在一起」过渡到过日子
  schedule('10 3 * * *', async () => {
    try {
      const r = affectionHelper.tickAllAffections();
      if (r?.updated) console.log(`[cron] affection tick updated=${r.updated}`);
    } catch (e) {
      console.warn('[cron] affection tick', e.message);
    }
  });

  // AI日记：每天凌晨2点；顺带补齐近几天因关机/失败漏掉的
  schedule('0 2 * * *', async () => {
    console.log('[cron] 生成AI日记...');
    try {
      await catchUpMissedDiaries();
    } catch (e) {
      console.error('[cron] diary daily catch-up', e.message);
      const chars = db.prepare('SELECT id FROM characters WHERE COALESCE(diary_enabled,1)=1').all();
      for (const c of chars) await generateAIDiary(c.id);
    }
  });

  schedule('55 2 * * *', async () => {
    console.log('[cron] 聊天记忆兜底总结');
    try {
      await catchUpDailyMemorySummaries();
    } catch (e) {
      console.warn('[cron] chat memory catch-up', e.message);
    }
  });

  // 夜里：聊天碎片 → 整天事记 → 有用讯息 + 画像；日程经过 → 自我看法
  schedule('20 3 * * *', async () => {
    console.log('[cron] 消化昨天：事记 + 画像 + 自我看法');
    try {
      const settings = getSettings();
      const tz = resolveIanaTimezone(settings.timezone);
      const yesterday = shiftDateStr(getLocalDateStr(new Date(), tz), -1);
      const { callChatAPIComplete } = require('./api-helper');
      const lived = require('./lived-day-helper');
      const chars = db.prepare('SELECT id FROM characters').all();
      const lifeFill = require('./life-fill-helper');
      for (const c of chars) {
        try {
          await lifeFill.fillDayLife(c.id, yesterday, { settings, onlyIfEmpty: true });
        } catch (e) {
          console.warn(`[cron] life fill char#${c.id}`, e.message);
        }
        try {
          const r = await lived.digestDay(c.id, yesterday, settings, callChatAPIComplete);
          console.log(`[cron] lived digest char#${c.id} ${yesterday} story=${r.story} useful=${r.useful} sealed=${r.sealed} portrait=${r.portrait?.changed || 0}`);
        } catch (e) {
          console.warn(`[cron] lived digest char#${c.id}`, e.message);
        }
        try {
          const cog = await lifeFill.digestCognition(c.id, yesterday, settings);
          if (cog?.ok) console.log(`[cron] cognition char#${c.id} user=${cog.user} self=${cog.self}`);
        } catch (e) {
          console.warn(`[cron] cognition char#${c.id}`, e.message);
        }
        try {
          const leaf = lifeFill.leafIdleChat(c.id, yesterday);
          if (leaf) console.log(`[cron] leaf idle chat char#${c.id} ${leaf}`);
        } catch (e) {
          console.warn(`[cron] leaf char#${c.id}`, e.message);
        }
      }
    } catch (e) {
      console.warn('[cron] lived digest', e.message);
    }
  });

  // VPS 瘦身：记忆总结之后，把已同步到手机的旧聊天/过期媒体清掉
  schedule('50 3 * * *', async () => {
    console.log('[cron] VPS 存储清理...');
    try {
      const { runNightlyPrune } = require('./vps-store-policy');
      const r = runNightlyPrune();
      console.log('[cron] vps store prune', JSON.stringify(r));
    } catch (e) {
      console.warn('[cron] vps store prune', e.message);
    }
  });

  // 旧记忆树不再夜间维护
  schedule('40 3 * * 2,5', async () => {
    console.log('[cron] 记忆树维护已停用');
  });

  // 朋友圈发帖：每 20 分钟检查；各角色每周约 3 天、每天最多 1 条（8:00～22:45）
  schedule('*/20 * * * *', async () => {
    await checkMomentPosts();
  });

  // 朋友圈互动补漏：每2小时检查未互动的用户动态
  schedule('0 */2 * * *', async () => {
    await autoInteractRecentMoments();
  });

  // 纪念日/生日：每天 9 点
  schedule('0 9 * * *', async () => {
    await checkSpecialDayMessages();
  });

  // 主动来电 / 窥屏：约每 20 分钟看一眼情绪，真正联络仍很少
  schedule('*/20 * * * *', async () => {
    await checkProactiveCall();
  });

  // 共享备忘录：每分钟处理到期任务；每小时补齐「当天主动随手写」
  schedule('* * * * *', async () => {
    try {
      const { processDueSharedMemoJobs } = require('./shared-memo-helper');
      const r = await processDueSharedMemoJobs();
      if (r?.processed) console.log(`[cron] shared memo replies +${r.processed}`);
    } catch (e) {
      console.warn('[cron] shared memo', e.message);
    }
  });
  schedule('* * * * *', async () => {
    try {
      const shake = require('./shake-helper');
      const { callChatAPIComplete } = require('./api-helper');
      const { push } = require('./push');
      const r = await shake.processDueShakeJobs(db, { callChatAPIComplete, getSettings, push });
      if (r?.processed) console.log(`[cron] shake jobs +${r.processed}`);
    } catch (e) {
      console.warn('[cron] shake jobs', e.message);
    }
  });
  // 摇一摇陌生人：偶尔主动发好友申请
  schedule('7,37 * * * *', async () => {
    try {
      const shake = require('./shake-helper');
      const { push } = require('./push');
      const n = shake.maybeShakeProactiveFriendRequests(db, push);
      if (n) console.log(`[cron] shake proactive friend +${n}`);
    } catch (e) {
      console.warn('[cron] shake proactive', e.message);
    }
  });
  schedule('* * * * *', async () => {
    try {
      const album = require('./ta-album-helper');
      const n = await album.processDueJobs();
      if (n) console.log(`[cron] ta album jobs +${n}`);
    } catch (e) {
      console.warn('[cron] ta album', e.message);
    }
  });
  // TA 相册：每天几次看看要不要补角色本月照片（目标 4–7 张/月）
  schedule('20 10,14,19 * * *', async () => {
    try {
      const n = await require('./ta-album-helper').maybeScheduleMonthlyPosts();
      if (n) console.log(`[cron] ta album scheduled post +${n}`);
    } catch (e) {
      console.warn('[cron] ta album schedule', e.message);
    }
  });
  schedule('* * * * *', async () => {
    try {
      const { processDueLetterJobs } = require('./letter-helper');
      const r = await processDueLetterJobs();
      if (r?.processed) console.log(`[cron] letter jobs +${r.processed}`);
    } catch (e) {
      console.warn('[cron] letter', e.message);
    }
  });
  schedule('* * * * *', async () => {
    try {
      const { processDuePostOfficeJobs } = require('./post-office-helper');
      const r = await processDuePostOfficeJobs();
      if (r?.processed) console.log(`[cron] post-office jobs +${r.processed}`);
    } catch (e) {
      console.warn('[cron] post-office', e.message);
    }
  });
  schedule('5 * * * *', async () => {
    try {
      const { scheduleProactiveSharedMemos } = require('./shared-memo-helper');
      scheduleProactiveSharedMemos();
    } catch (e) {
      console.warn('[cron] shared memo proactive schedule', e.message);
    }
  });

  // AI 偷看用户秘密：凌晨 3:30 + 午间 12:00 + 晚间 21:00
  schedule('30 3 * * *', async () => {
    console.log('[cron] AI 偷看秘密 (凌晨)...');
    await checkAiPeekSecrets();
  });
  schedule('0 12 * * *', async () => {
    console.log('[cron] AI 偷看秘密 (午间)...');
    await checkAiPeekSecrets();
  });
  schedule('0 21 * * *', async () => {
    console.log('[cron] AI 偷看秘密 (晚间)...');
    await checkAiPeekSecrets();
  });

  // 「我们」日生成已停用（改共享备忘录）

  setTimeout(() => {
    try {
      const n = require('./vps-store-policy').pruneEphemeralUploads();
      if (n) console.log('[cron] startup ephemeral prune', n);
    } catch (e) {
      console.warn('[cron] startup ephemeral prune', e.message);
    }
  }, 20000);

  console.log('[cron] 定时任务已启动 timezone=', resolveIanaTimezone(getSettings().timezone));
  catchUpMissedDiaries().catch(e => console.error('[cron] diary catch-up error', e.message));
  catchUpMissedMemorySummaries().catch(e => console.error('[cron] memory catch-up error', e.message));
  catchUpMissedSchedules().catch(e => console.error('[cron] schedule catch-up error', e.message));
  try {
    const { scheduleProactiveSharedMemos } = require('./shared-memo-helper');
    scheduleProactiveSharedMemos();
  } catch (e) {
    console.warn('[cron] shared memo proactive bootstrap', e.message);
  }
}

/** 补跑本周未完整生成的角色行程（空 / 仅凌晨残条 / 生成失败） */
async function catchUpMissedSchedules() {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const chars = db.prepare('SELECT id FROM characters WHERE COALESCE(schedule_enabled,1)=1').all();
  for (const c of chars) {
    const weekStart = getWeekStartMonday(today);
    const need = listWeekDates(weekStart).filter((d) => d >= today).some((d) => {
      const row = getScheduleRow(c.id, 'ai', d);
      return !scheduleLooksComplete(parseScheduleItems(row?.items));
    });
    if (!need) continue;
    console.log(`[cron] schedule catch-up char#${c.id} week=${weekStart} from=${today}`);
    await generateWeeklySchedules(c.id, today, { force: false }).catch(e =>
      console.error(`[cron] schedule catch-up char#${c.id}`, e.message)
    );
  }
}

/**
 * 补齐近几天漏掉的 AI 日记（关机错过 2 点 cron、或中间断一两天）。
 * 按日期从旧到新生成，跳过已有日记、无聊天的日子；不写「今天」。
 */
async function catchUpMissedDiaries(opts = {}) {
  const lookback = Math.max(1, Math.min(14, parseInt(opts.lookback, 10) || 7));
  const onlyCharId = opts.charId != null ? Number(opts.charId) : null;
  const settings = getSettings();
  const chars = onlyCharId
    ? db.prepare('SELECT id, timezone, diary_enabled FROM characters WHERE id=? AND COALESCE(diary_enabled,1)=1').all(onlyCharId)
    : db.prepare('SELECT id, timezone, diary_enabled FROM characters WHERE COALESCE(diary_enabled,1)=1').all();

  let generated = 0;
  for (const c of chars) {
    const tz = getEffectiveTimezone(c, settings) || settings.timezone || 'Asia/Shanghai';
    const todayLocal = getLocalDateStr(new Date(), tz);
    for (let i = lookback; i >= 1; i--) {
      const diaryDate = shiftDateStr(todayLocal, -i);
      const existing = db.prepare(
        `SELECT id FROM diaries WHERE character_id=? AND role='ai' AND date=?`
      ).get(c.id, diaryDate);
      if (existing) continue;
      console.log(`[cron] diary catch-up char#${c.id} date=${diaryDate}`);
      const before = db.prepare(
        `SELECT id FROM diaries WHERE character_id=? AND role='ai' AND date=?`
      ).get(c.id, diaryDate);
      await generateAIDiary(c.id, diaryDate);
      const after = db.prepare(
        `SELECT id FROM diaries WHERE character_id=? AND role='ai' AND date=?`
      ).get(c.id, diaryDate);
      if (after && !before) generated += 1;
    }
  }
  return { generated, lookback };
}

async function tryAttachChatVideoToReply(characterId, settings, rawText, cleanText, char = null) {
  const combined = `${rawText || ''}\n${cleanText || ''}`.trim();
  const parsed = parseMomentContentAndImageQuery(combined);
  const presetQuery = parsed.videoQuery;
  if (!shouldAttachContextVideo(combined, presetQuery, { forChat: true })) return null;
  const c = char || db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!c) return null;
  try {
    const url = await generateChatContextVideo(
      settings,
      c,
      [parsed.content, cleanText, rawText].filter(Boolean).join('\n'),
      typeof parsed.videoQuery === 'string' ? parsed.videoQuery : null
    );
    if (!url) return null;
    const id = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
    ).run(characterId, 'assistant', url, 'video', 0).lastInsertRowid;
    queueAlbumSave({
      characterId,
      url,
      mediaType: 'video',
      subject: 'self',
      description: String(typeof parsed.videoQuery === 'string' ? parsed.videoQuery : '').trim().slice(0, 40),
    });
    return { id, type: 'video', content: url };
  } catch (e) {
    console.warn('[cron] chat video attach failed', e.message);
    return null;
  }
}

async function tryAttachChatSelfieToReply(characterId, settings, rawText, cleanText, char = null) {
  if (settings.selfie_api_enabled === '0') return null;
  const combined = `${rawText || ''}\n${cleanText || ''}`.trim();
  let selfieScene = extractSelfieSceneQuery(rawText) ?? extractSelfieSceneQuery(combined);
  if (typeof selfieScene === 'string' && selfieScene.trim() && isObjectOrStillLifeScene(selfieScene)) {
    // 静物误写成自拍：交给配图链路
    return null;
  }
  const hasSelfieLine = typeof selfieScene === 'string' && !!String(selfieScene).trim();
  const claimedSent = replyClaimsSentShareMedia(combined);
  const sceneryClaim = claimedSent && isObjectOrStillLifeScene(combined) && !/自拍|本人|出镜|穿搭/.test(combined);
  if (!hasSelfieLine && (!claimedSent || sceneryClaim || /视频|vlog/.test(combined))) return null;
  const c = char || db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!c) return null;
  try {
    const refGroups = normalizeImageRefGroups(c.image_ref || '[]');
    const sceneQuery = String(selfieScene || '').trim();
    const refFlags = resolveSelfieRefFlags(refGroups, sceneQuery);
    const homeUrls = refFlags.useSpecial ? [] : selectHomeReferenceUrls(c, sceneQuery, 2);
    const imageRefs = [
      ...selectSelfieReferenceUrls(refGroups, sceneQuery),
      ...homeUrls,
    ].filter(Boolean).slice(0, 5);
    const hasRef = imageRefs.length > 0;
    const hasImg2 = !!resolveImg2ImgConfig(settings);
    const hasTxt = !!(settings.image_api_url || '').trim() && !!(settings.image_api_key || '').trim();
    if (!hasRef && !hasTxt) {
      console.warn('[cron] selfie skip: no refs and no txt image api');
      return null;
    }
    if (hasRef && !hasImg2 && !hasTxt) {
      console.warn('[cron] selfie skip: refs present but no img2/txt api');
      return null;
    }
    const aspect = normalizeSelfieAspect(c.image_aspect || '3:4');
    const selfiePrompt = buildSelfieGenerationPrompt({
      imageStyle: c.image_style || 'anime',
      charName: c.name,
      sceneQuery,
      hasRef,
      hasBodyRef: refFlags.hasBodyRef,
      hasFullBodyRef: refFlags.hasFullBodyRef,
      hasHandRef: refFlags.hasHandRef,
      hasSpecialRef: refFlags.hasSpecialRef,
      specialLabel: refFlags.specialLabel,
      stylePrompt: c.selfie_style_prompt || '',
      aspect,
      char: c,
      hasHomeRef: homeUrls.length > 0,
    });
    let url = null;
    if (hasRef) {
      const refUrls = imageRefs.map((r) => toAbsoluteMediaUrl(r, '')).filter(Boolean);
      url = await generateImage(settings, selfiePrompt, refUrls[0], {
        referenceImages: refUrls,
        requireReference: hasImg2 || refUrls.length > 0,
        aspect,
      });
    } else {
      url = await generateImage(settings, selfiePrompt, null, { aspect });
    }
    if (!url) {
      console.warn('[cron] selfie gen failed', (getLastGenerateImageError() || '').slice(0, 120));
      return null;
    }
    const id = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
    ).run(characterId, 'assistant', url, 'image', 0).lastInsertRowid;
    queueAlbumSave({
      characterId,
      url,
      mediaType: 'image',
      subject: 'self',
      description: sceneQuery.slice(0, 40),
    });
    if (sceneQuery) {
      console.log('[cron] selfie attached char=', characterId, 'id=', id);
    } else {
      console.log('[cron] selfie attached (claimed-sent fill) char=', characterId, 'id=', id);
    }
    return { id, type: 'image', content: url };
  } catch (e) {
    console.warn('[cron] chat selfie attach failed', e.message);
    return null;
  }
}

async function tryAttachChatImageToReply(characterId, settings, rawText, cleanText, char = null) {
  // 先尝试自拍（主动发本人照）；失败/非自拍再走风景配图
  const selfieMsg = await tryAttachChatSelfieToReply(characterId, settings, rawText, cleanText, char);
  if (selfieMsg) return selfieMsg;

  const combined = `${rawText || ''}\n${cleanText || ''}`.trim();
  const parsed = parseMomentContentAndImageQuery(combined);
  let presetQuery = parsed.imageQuery;
  // 自拍行被误写成静物时，可落到配图
  const selfieScene = extractSelfieSceneQuery(rawText) ?? extractSelfieSceneQuery(combined);
  if (presetQuery === undefined && typeof selfieScene === 'string' && selfieScene.trim()
    && isObjectOrStillLifeScene(selfieScene)) {
    presetQuery = selfieScene;
  }
  const claimedSent = replyClaimsSentShareMedia(combined);
  if (claimedSent && presetQuery === null) presetQuery = undefined;
  if (!shouldAttachContextImage(combined, presetQuery, { hasExplicitSelfie: false, forChat: true })) {
    if (claimedSent) {
      const q = extractImageQueryFromText(combined);
      if (q && isObjectOrStillLifeScene(combined) && !/自拍|本人/.test(combined)) {
        presetQuery = q;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
  const c = char || db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!c) return null;
  try {
    const url = await generateChatContextImage(
      settings,
      c,
      [parsed.content, cleanText, rawText].filter(Boolean).join('\n'),
      typeof presetQuery === 'string' ? presetQuery : null
    );
    if (!url) return null;
    const id = db.prepare(
      `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
    ).run(characterId, 'assistant', url, 'image', 0).lastInsertRowid;
    queueAlbumSave({
      characterId,
      url,
      mediaType: 'image',
      subject: 'other',
      description: String(typeof presetQuery === 'string' ? presetQuery : '').trim().slice(0, 40),
    });
    return { id, type: 'image', content: url };
  } catch (e) {
    console.warn('[cron] chat image attach failed', e.message);
    return null;
  }
}

function diaryVisibleToChar(visibleTo, charId) {
  if (!visibleTo?.length) return true;
  return visibleTo.some(id => id == charId);
}

function getRecentChatHistoryForPeek(charId, limit = 16) {
  return db.prepare(
    `SELECT role, content, type FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0 AND role IN ('user','assistant')
     ORDER BY id DESC LIMIT ?`
  ).all(charId, limit).reverse();
}

function formatRecentChatForPeek(history, settings, charName) {
  const userName = settings.username || '旅人';
  return (history || []).map((m) => {
    const name = m.role === 'user' ? userName : (charName || '我');
    const text = formatMessageForAi(m).slice(0, 140);
    return `${name}：${text}`;
  }).join('\n');
}

function buildDiaryPeekUserContent(diaryText, recentHistory, settings, charName, label = '用户秘密原文') {
  const diary = String(diaryText || '').trim();
  const chatBlock = formatRecentChatForPeek(recentHistory, settings, charName);
  const parts = [`【${label}】\n${diary.slice(0, 3000)}`];
  if (chatBlock) {
    parts.push(`【你们最近在念里的聊天（须参照这里的人设、关系与说话方式）】\n${chatBlock}`);
  }
  return parts.join('\n\n');
}

/** 偷看用户秘密后写内心独白：带入聊天记忆与近期对话，保持与通讯里同一人设 */
function buildDiaryPeekPrompt(char, settings, diaryContent, { maxChars = 150, sectionLabel = '秘密' } = {}) {
  const diaryText = String(diaryContent || '').trim();
  const recentHistory = getRecentChatHistoryForPeek(char.id);
  const contextText = buildChatContextText(diaryText, recentHistory);
  const extra = `【偷看秘密·内心独白】你刚偷偷看了用户在秘密簿里写的内容（${sectionLabel}；TA以为你不知道）。
请写下内心最真实的私密感受，${maxChars}字以内，第一人称，**不要对用户说话**（不是发消息，是写给自己看的心里话）。

**必须与「念」里聊天时的你是同一个人：**
· 沿用你与TA在通讯里一贯的语气、用词、亲密/距离感
· 结合【脑海】与下方【近期聊天】里你们真实说过的话来反应
· 对内容要有具体触动（哪句话、什么事让你在意），禁止空泛文艺套话、禁止像陌生人点评`;

  const systemPrompt = buildSystemPrompt(char, settings, extra, {
    forDiaryPeek: true,
    contextText,
    userMessage: diaryText.slice(0, 500),
    recentHistory,
  });
  const userContent = buildDiaryPeekUserContent(diaryText, recentHistory, settings, char.name, `用户${sectionLabel}`);
  return { systemPrompt, userContent };
}

function noteAlreadyPeekedBy(peeksRaw, charId) {
  let peeks = [];
  try { peeks = typeof peeksRaw === 'string' ? JSON.parse(peeksRaw || '[]') : (peeksRaw || []); } catch { peeks = []; }
  return !!peeks.find(p => p.charId == charId);
}

/** 角色偷看用户秘密（日记 + 用户备忘等），留下痕迹与内心独白 */
async function checkAiPeekSecrets(options = {}) {
  const { focusDiaryId, focusNoteId } = options;
  const settings = getSettings();
  const chars = db.prepare('SELECT * FROM characters WHERE allow_diary=1').all();
  if (!chars.length) return;

  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const sectionLabel = { memo: '备忘录', us: '我们', heart: '心事', diary: '日记' };

  /** @type {{ kind:'diary'|'note', id:number, content:string, date:string, section:string, visible_to?:any, peeks?:any }[]} */
  let candidates = [];

  if (focusDiaryId) {
    const one = db.prepare('SELECT * FROM diaries WHERE id=? AND role=?').get(focusDiaryId, 'user');
    if (one) {
      candidates.push({
        kind: 'diary', id: one.id, content: one.content, date: one.date,
        section: 'diary', visible_to: one.visible_to, peeks: one.char_peeks,
      });
    }
  } else if (focusNoteId) {
    const one = db.prepare('SELECT * FROM secret_notes WHERE id=? AND role=?').get(focusNoteId, 'user');
    if (one) {
      candidates.push({
        kind: 'note', id: one.id, content: one.content, date: one.date,
        section: one.section, peeks: one.peeks,
      });
    }
  } else {
    const diaries = db.prepare(
      `SELECT * FROM diaries WHERE role='user' AND date >= ? ORDER BY date DESC LIMIT 20`
    ).all(threeDaysAgo);
    for (const d of diaries) {
      candidates.push({
        kind: 'diary', id: d.id, content: d.content, date: d.date,
        section: 'diary', visible_to: d.visible_to, peeks: d.char_peeks,
      });
    }
    const notes = db.prepare(
      `SELECT * FROM secret_notes WHERE role='user' AND date >= ? ORDER BY date DESC LIMIT 30`
    ).all(threeDaysAgo);
    for (const n of notes) {
      candidates.push({
        kind: 'note', id: n.id, content: n.content, date: n.date,
        section: n.section, peeks: n.peeks,
      });
    }
  }

  if (!candidates.length) return;

  const peekChance = (focusDiaryId || focusNoteId) ? 0.55 : 0.5;

  for (const char of chars) {
    if (Math.random() > peekChance) continue;

    const target = candidates.find(c => {
      if (noteAlreadyPeekedBy(c.peeks, char.id)) return false;
      if (c.kind === 'diary') {
        let visibleTo = [];
        try { visibleTo = JSON.parse(c.visible_to || '[]'); } catch {}
        return diaryVisibleToChar(visibleTo, char.id);
      }
      return true;
    });
    if (!target) continue;

    try {
      const label = sectionLabel[target.section] || '秘密';
      const peekText = target.kind === 'note'
        ? `[${label}] ${target.content}`
        : target.content;
      const { systemPrompt, userContent } = buildDiaryPeekPrompt(char, settings, peekText, {
        maxChars: 150,
        sectionLabel: label,
      });
      const secret = await callChatAPI(settings, systemPrompt, userContent, 'chat');
      if (!secret) continue;

      let peeks = [];
      try {
        peeks = typeof target.peeks === 'string' ? JSON.parse(target.peeks || '[]') : (target.peeks || []);
      } catch { peeks = []; }
      const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
      peeks.push({
        charId: Number(char.id), charName: char.name, charAvatar: char.avatar || '',
        peekedAt: now, secretNote: secret, section: target.section, targetId: target.id,
      });

      if (target.kind === 'diary') {
        db.prepare(`UPDATE diaries SET ai_peeked=1, ai_peeked_at=datetime('now'), ai_secret_note=?, char_peeks=? WHERE id=?`)
          .run(secret, JSON.stringify(peeks), target.id);
      } else {
        db.prepare(`UPDATE secret_notes SET peeks=? WHERE id=?`).run(JSON.stringify(peeks), target.id);
      }

      db.prepare(`INSERT INTO memories (character_id, category, content, weight, date) VALUES (?,?,?,?,?)`)
        .run(char.id, '秘密偷看', `[偷看了用户${label}后的心里话] ${secret}`, 0.7, new Date().toISOString().slice(0, 10));

      push('ai_peeked_diary', {
        characterId: char.id,
        diaryId: target.kind === 'diary' ? target.id : null,
        noteId: target.kind === 'note' ? target.id : null,
        section: target.section,
      });
      console.log(`[cron] ${char.name} 偷看了用户${label} #${target.id}`);
    } catch (e) {
      console.error('[cron] peek secret error', e.message);
    }
  }
}

/** @deprecated 兼容旧调用名 */
async function checkAiPeekDiaries(options = {}) {
  return checkAiPeekSecrets(options);
}

async function generateAllSecretNotesForDay(dateStr = null) {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const date = dateStr || getLocalDateStr(new Date(), tz);
  const { generateSecretNotesForDay } = require('./secret-helper');
  const chars = db.prepare('SELECT id FROM characters').all();
  for (const c of chars) {
    try {
      const r = await generateSecretNotesForDay(c.id, date);
      if (r?.added) {
        console.log(`[cron] secret notes char#${c.id} +${r.added}`);
        push('secret_notes_updated', { characterId: c.id, date, added: r.added });
      }
    } catch (e) {
      console.warn('[cron] secret notes gen', e.message);
    }
  }
}

module.exports = {
  startCronJobs,
  setAiInteractFn,
  setNpcInteractFn,
  setOwnerNpcReplyFn,
  generateAIDiary,
  catchUpMissedDiaries,
  generateMemorySummary,
  backfillMemoriesFromChat,
  summarizeTheaterSession,
  scheduleTheaterMemorySummary,
  catchUpDailyMemorySummaries,
  maybeCaptureSalientFromMessage,
  maybeTriggerMemorySummary,
  isMemorySummaryEnabled,
  messageTriggersMemoryKeyword,
  messageIndicatesSalientPlan,
  messageIndicatesSalientEmotion,
  touchCharacterEmotionFromMessage,
  getDecayedEmotionState,
  buildDiaryPeekPrompt,
  buildEmotionalCarryoverBlock,
  buildSystemPrompt,
  loadSideChannelChatContext,
  buildCallExtraSystemPrompt,
  prefetchLocationWeather,
  buildLocationContextBlock,
  buildCharacterProfile,
  buildThinkAsSelfBlock,
  buildChatContextText,
  buildSleepContextNote,
  buildStatedIntentElapsedNote,
  buildCharActivityContinuityNote,
  buildScheduleChatLockNote,
  reconcileScheduleWithRecentChat,
  buildThreadContinuityNote,
  syncScheduleFromChatActivity,
  buildRetryTimeAdvanceNote,
  buildChatTimeNote,
  buildReplyTimeNotePayload,
  computeUserReturnGap,
  parseMsgTimestamp,
  getMemoryTriggerN,
  withCharChatPrefs,
  isTimeAware,
  isNaturalChat,
  selectMemoriesForPrompt,
  getUserMessagesNeedingRealReply,
  checkAiPeekDiaries,
  checkAiPeekSecrets,
  generateAllSecretNotesForDay,
  mergeImpressionItems,
  generateDailySchedule,
  generateWeeklySchedules,
  generateAllDailySchedules,
  getLocalDateStr,
  shiftDateStr,
  maybeFinalizePastScheduleItems,
  rehomeWeeHoursScheduleItems,
  sortScheduleItemsByTime,
  catchUpMissedSchedules,
  getSchedulePromptBlocks,
  getCharCurrentActivity,
  classifyCallSleepWake,
  resolveCallCharAsleepOnLine,
  scheduleLooksLikeCallSleep,
  captureSalientMoment,
  maybeCaptureUserImpressionsFromMessage,
  messageIndicatesUserProfileShare,
  formatMemoriesForPrompt,
  formatMemoriesForPromptAsync,
  clearCharacterOnline,
  mergeImpressionItems,
  expandLegacyImpressions,
  formatImpressionsForPrompt,
  pickImpressionCandidates,
  formatImpressionCandidates,
  deriveImpressionKeywords,
  normalizeImpressionCategory,
  mapMemoryToImpressionCategory,
  resolveImpressionCategory,
  isJunkImpressionFact,
  looksLikePersonalityTrait,
  scheduleLooksComplete,
  pickScheduleSleepHint,
  ensureScheduleSleepPoint,
  backfillYesterdayNightSleepConclusion,
  activityLooksLikeMainSleep,
  activityLooksLikeAllNighter,
  getHereAndNowContext,
  extractPlaceFromText,
  sanitizeRegionPlace,
  resolveCharacterPresentLocation,
  resolvePresentLocationFromSchedule,
  getUserMomentChatCue,
  claimMomentChatAsk,
  IMPRESSION_CATEGORIES,
  IMPRESSION_CATEGORY_HINTS,
  DREAM_NARRATIVE_SUFFIX,
};

/**
 * 一天的记忆：聊天碎片按时间收成「整天事记」→ 再精炼有用讯息并更新画像；
 * 日程经过另行收成自我看法。问到共同经历时，才翻某一天的时间轴。
 */
const db = require('./db');

function formatDigestApiError(err) {
  const msg = String(err?.message || err || '');
  if (!msg) return '';
  try {
    const formatted = require('./api-helper').formatApiBillingError(msg, { label: '消化' });
    if (formatted) return formatted;
  } catch { /* ignore */ }
  if (/quota|余额|积分|billing|pre_consume|token remain/i.test(msg)) {
    return '消化失败：API 额度不足，请充值或换模型后再试';
  }
  if (/API error\s*403/i.test(msg)) return '消化失败：API 拒绝（403），请检查额度或密钥';
  if (/API error\s*401/i.test(msg)) return '消化失败：API 密钥无效';
  return msg.length > 160 ? `消化失败：${msg.slice(0, 160)}…` : `消化失败：${msg}`;
}

const RECALL_RE = /还记得|记不记得|记得吗|你记得|那天我们|上次我们|以前我们|一起.{0,12}(过|的时候|那)|回忆/;
const ASK_LIFE_RE = /今天.{0,8}(怎么过|干了什么|做了什么|忙什么|过得|干嘛了|去哪了)|你今天|你刚才|你现在在干|你在忙什么|最近在忙/;
const SEE_MAX = 400;
const ITEM_MAX = 80;
const UNFINISHED_MAX = 5;

function ensureCarryTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS char_memory_carry (
      character_id INTEGER PRIMARY KEY,
      see_user TEXT DEFAULT '',
      see_self TEXT DEFAULT '',
      unfinished TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function localDateStr(date, tz = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function localMinutes(date, tz = 'Asia/Shanghai') {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return h * 60 + m;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseItems(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const p = JSON.parse(raw || '[]');
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function timeMinutes(time) {
  const m = String(time || '').match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function reviewOf(it) {
  const thought = String(it?.thought || '').trim();
  if (thought.startsWith('进行中')) return '';
  return thought || String(it?.execution || '').trim();
}

function getSchedule(charId, dateStr) {
  return db.prepare(
    `SELECT * FROM schedules WHERE character_id=? AND role='ai' AND date=?`
  ).get(Number(charId), dateStr);
}

function slotPhase(start, end, review, nowMins) {
  if (review) return 'lived';
  if (start == null) return 'planned';
  if (nowMins < start) return 'planned';
  if (end != null && nowMins < end) return 'open';
  return 'empty';
}

function daySlots(charId, dateStr, { nowMins = null, tz = 'Asia/Shanghai' } = {}) {
  const row = getSchedule(charId, dateStr);
  const items = parseItems(row?.items);
  const today = localDateStr(new Date(), tz);
  const mins = nowMins != null
    ? nowMins
    : (dateStr < today ? 24 * 60 : (dateStr > today ? -1 : localMinutes(new Date(), tz)));
  const starts = items.map((it) => timeMinutes(it.time));
  return items.map((it, i) => {
    const start = starts[i];
    const next = starts.slice(i + 1).find((n) => n != null && (start == null || n > start));
    const end = next != null ? next : (start != null ? Math.min(start + 90, 24 * 60) : null);
    const lived = reviewOf(it);
    const life = String(it.lived || '').trim();
    const phase = slotPhase(start, end, lived, mins);
    return {
      time: String(it.time || '').trim(),
      activity: String(it.activity || it.title || '').trim(),
      place: String(it.place || '').trim(),
      lived,
      life,
      salience: String(it.salience || ''),
      phase,
    };
  }).filter((s) => s.activity || s.lived);
}

function getCarry(charId) {
  ensureCarryTable();
  const row = db.prepare('SELECT * FROM char_memory_carry WHERE character_id=?').get(Number(charId));
  let unfinished = [];
  try { unfinished = JSON.parse(row?.unfinished || '[]'); } catch { unfinished = []; }
  if (!Array.isArray(unfinished)) unfinished = [];
  return {
    seeUser: String(row?.see_user || ''),
    seeSelf: String(row?.see_self || ''),
    unfinished: unfinished.map((s) => String(s || '').trim()).filter(Boolean).slice(0, UNFINISHED_MAX),
    updatedAt: row?.updated_at || null,
  };
}

function saveCarry(charId, carry) {
  ensureCarryTable();
  const unfinished = (carry.unfinished || []).map((s) => String(s || '').trim().slice(0, ITEM_MAX)).filter(Boolean).slice(0, UNFINISHED_MAX);
  db.prepare(
    `INSERT OR REPLACE INTO char_memory_carry (character_id, see_user, see_self, unfinished, updated_at)
     VALUES (?,?,?,?,datetime('now'))`
  ).run(
    Number(charId),
    String(carry.seeUser || '').slice(0, SEE_MAX),
    String(carry.seeSelf || '').slice(0, SEE_MAX),
    JSON.stringify(unfinished),
  );
  return getCarry(charId);
}

function listPastDates(charId, { limit = 21, tz = 'Asia/Shanghai' } = {}) {
  const today = localDateStr(new Date(), tz);
  const rows = db.prepare(
    `SELECT date, items FROM schedules
     WHERE character_id=? AND role='ai' AND date < ?
     ORDER BY date DESC LIMIT ?`
  ).all(Number(charId), today, limit);
  return rows.map((r) => {
    const slots = daySlots(charId, r.date, { nowMins: 24 * 60, tz });
    const lived = slots.filter((s) => s.phase === 'lived').length;
    return { date: r.date, slots: slots.length, lived };
  });
}

function keepText(next, prev) {
  const t = String(next || '').trim();
  if (!t || /^(不变|无|没有|没有变化|同上|无变化)$/.test(t)) return String(prev || '');
  return t.slice(0, SEE_MAX);
}

function parseDigest(raw) {
  return extractJsonObject(raw);
}

/** 从模型原文抽出 JSON 对象：支持闭合/未闭合 ```json 围栏，以及夹杂前后废话。 */
function extractJsonObject(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  const closed = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (closed) text = closed[1].trim();
  else {
    const open = text.match(/^```(?:json)?\s*/i);
    if (open) text = text.slice(open[0].length).replace(/```\s*$/i, '').trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function formatDayLines(slots) {
  return slots.map((s) => {
    const head = `${s.time || '—'} ${s.activity}`;
    const story = s.life || s.lived;
    if (story) return `${head}\n实际：${story}`;
    if (s.phase === 'planned') return `${head}\n（还没走到）`;
    if (s.phase === 'open') return `${head}\n（正在这段）`;
    return `${head}\n（过了，没留下）`;
  }).join('\n');
}

async function callJsonDigest(settings, callChatAPIComplete, sys, userMsg, maxTokens = 2200) {
  const opts = { maxTokens, temperature: 0.3, timeout: 120000, noContinue: true, json: true };
  const tryOnce = async (channel) => {
    const raw = await callChatAPIComplete(settings, sys, userMsg, channel, [], opts);
    let text = String(raw || '').trim();
    if (!text) return null;
    const closed = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (closed) text = closed[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // 常见截断：末尾缺 }，试一次补括号
      let frag = text.slice(start);
      const open = (frag.match(/\{/g) || []).length;
      const close = (frag.match(/\}/g) || []).length;
      if (open > close) frag += '}'.repeat(open - close);
      try { return JSON.parse(frag); } catch { return null; }
    }
  };

  let lastErr = null;
  for (const channel of ['memory', 'chat']) {
    try {
      const parsed = await tryOnce(channel);
      if (parsed) return parsed;
    } catch (e) {
      lastErr = e;
    }
  }
  // 失败再要一版更短的，降低截断概率
  try {
    const retrySys = `${sys}\n【补救】上次输出无法解析。请重新输出更短、完整的合法 JSON，字段可少但括号必须闭合。`;
    const raw = await callChatAPIComplete(settings, retrySys, userMsg, 'chat', [], {
      ...opts, maxTokens: Math.max(1200, Math.floor(maxTokens * 0.7)),
    });
    let text = String(raw || '').trim();
    const closed = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (closed) text = closed[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall */ }
    }
  } catch (e) {
    lastErr = e;
  }
  console.warn('[lived-day] json parse fail', String(lastErr?.message || '').slice(0, 120));
  throw new Error(formatDigestApiError(lastErr) || '消化结果解析失败');
}

function saveDayStory(charId, dateStr, story) {
  const brain = require('./memory-brain-helper');
  const content = String(story || '').trim().slice(0, 900);
  if (!content) return null;
  // 同一天只留一份事记：旧的降为 historical
  try {
    db.prepare(
      `UPDATE memories SET status='historical'
       WHERE character_id=? AND date=? AND source='day_story'
         AND COALESCE(status,'current')='current'`
    ).run(Number(charId), dateStr);
  } catch { /* ignore */ }
  return brain.insertMemory({
    characterId: Number(charId),
    category: '一天',
    content,
    weight: 0.72,
    date: dateStr,
    source: 'day_story',
    factKey: `day_story:${charId}:${dateStr}`,
    keywords: ['整天', '事记'],
    meta: { kind: 'day_story' },
  });
}

function softArchiveIdleChat(charId, dateStr) {
  try {
    const r = db.prepare(
      `UPDATE memories SET status='historical', weight=MIN(weight, 0.18)
       WHERE character_id=? AND date=? AND COALESCE(archived,0)=0
         AND COALESCE(status,'current')='current'
         AND COALESCE(source,'') NOT IN ('life','schedule','schedule_day','day_story','day_digest')
         AND (content LIKE '%【闲聊】%' OR weight<=0.22)`
    ).run(Number(charId), dateStr);
    return r.changes || 0;
  } catch {
    return 0;
  }
}

/** 碎片按序去重 → 整天事记 */
async function composeDayStory(char, dateStr, summaries, settings, callChatAPIComplete) {
  if (!summaries?.length) return null;
  const uname = String(settings?.username || '').trim() || '对方';
  const dayLines = summaries.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  const sys = `你是「${char.name}」本人。把这一天和「${uname}」的聊天收成一整件事记——用你自己事后会怎么想起这一天来写。只输出 JSON，不要 markdown。
{"story":"150-420字的整天事记","has_substance":true}
规则：
- 材料已按时间排好，并去掉了衔接处的重复句；仍有少量重复只算一次。
- story 用第一人称：「我」=${char.name}；用户写「对方」或「${uname}」。
- 按时间讲清这一天到底发生了什么：起因→关键转折→结果/未了；不要逐句摘抄，不要流水账。正文里尽量带上材料里的日期/时段感，不要把时间抹平。
- 纯寒暄、无信息量的玩笑可一笔带过或省略；有约定、情绪、重要事实必须留下。
- 【具体词】材料里用户/角色亲口说的具体词须原样保留（药名、地名、店名、作品名、人名昵称、具体物品、品牌、数字与约定原文）；禁止收成「止痛药/东西/那个地方」这类笼统说法。
- 禁止编造材料里没有的事。若几乎全是闲聊、没什么可记，has_substance=false，story 仍可写一两句概括。`;
  const userMsg = `【${dateStr} 聊天碎片（已排序去重）】\n${dayLines}`;
  const parsed = await callJsonDigest(settings, callChatAPIComplete, sys, userMsg, 2000);
  const story = String(parsed?.story || '').trim();
  if (!story) return null;
  return {
    story,
    hasSubstance: parsed?.has_substance !== false && story.length >= 40,
  };
}

/** 从事记精炼有用讯息，去掉闲聊 */
async function refineUsefulFromStory(char, dateStr, story, settings, callChatAPIComplete) {
  const uname = String(settings?.username || '').trim() || '对方';
  const sys = `你是「${char.name}」本人。从整天事记里抽出以后还用得上的讯息——按你自己会记什么来选。只输出 JSON。
{"items":[{"category":"约定|待办|重要时刻|偏好与习惯|情感状态|日常点滴","content":"60-140字，第一人称","weight":0.35-0.9}]}
规则：
- 材料是已收成的整天事记，不要再扩成流水账。
- 只留有用讯息：承诺/约定、到期待办、重要事件、稳定偏好、关系/情绪的关键结果。
- 闲聊、寒暄、无后果的玩笑 → 不要写进 items。
- content 用第一人称；用户写「对方」或「${uname}」；不要用「你」指用户。
- 【时间】有明确日期/时段的须写进 content（或待办【到期：YYYY年M月D日+时段】），不要抹掉时间。
- 【具体词】事记里已有的具体词必须原样带进 items（布洛芬≠止痛药；地名/店名/物品名同理）；可补概括，但不能只用概括替换原词。
- 同一事实只写一条；没有可留的就 items 空数组。禁止编造。`;
  const userMsg = `【${dateStr} 整天事记】\n${story}`;
  const parsed = await callJsonDigest(settings, callChatAPIComplete, sys, userMsg, 2200);
  const allowed = new Set(['约定', '待办', '重要时刻', '偏好与习惯', '情感状态', '日常点滴']);
  const brain = require('./memory-brain-helper');
  let saved = 0;
  for (const raw of Array.isArray(parsed?.items) ? parsed.items : []) {
    let category = String(raw?.category || '日常点滴').trim();
    if (!allowed.has(category)) category = '日常点滴';
    const content = String(raw?.content || '').trim().slice(0, 400);
    if (content.length < 12) continue;
    if (/【闲聊】/.test(content)) continue;
    const weight = Math.max(0.35, Math.min(0.92, Number(raw?.weight) || 0.62));
    const ir = brain.insertMemory({
      characterId: Number(char.id),
      category,
      content,
      weight,
      date: dateStr,
      source: 'day_digest',
      factKey: category === '待办' || category === '约定' ? undefined : `day_digest:${char.id}:${dateStr}:${category}:${content.slice(0, 24)}`,
      keywords: [category],
      meta: { kind: 'day_digest' },
    });
    if (ir?.id && !ir.duplicate) saved += 1;
  }
  return saved;
}

/**
 * 消化今天：
 * 1) 聊天碎片排序去重 → 整天事记
 * 2) 从事记精炼有用讯息（去闲聊）
 * 3) 顺带更新画像
 * 4) 有日程经过时再收自我看法
 */
async function digestDay(charId, dateStr, settings, callChatAPIComplete) {
  const cid = Number(charId);
  const char = db.prepare('SELECT id, name FROM characters WHERE id=?').get(cid);
  if (!char) throw new Error('角色不存在');
  const tz = settings?.timezone || 'Asia/Shanghai';
  const reader = require('./user-read-helper');

  // 当天还没进记忆的聊天先总结成碎片
  try {
    const cron = require('./cron');
    await cron.generateMemorySummary(cid, { dateFilter: dateStr, minMessages: 2 });
  } catch (e) {
    console.warn('[lived-day] pre-summary', e.message);
  }
  try {
    const cron = require('./cron');
    await cron.maybeFinalizePastScheduleItems(cid, { dateStr, maxItems: 8 });
  } catch (e) {
    console.warn('[lived-day] seal slots', e.message);
  }

  const slots = daySlots(cid, dateStr, { tz });
  const lived = slots.filter((s) => (s.life || s.lived) && s.phase !== 'planned').map((s) => ({
    ...s,
    lived: s.life || s.lived,
  }));

  const summaries = reader.orderAndDedupeSummaries(reader.loadChatSummaries(cid, dateStr));
  if (!summaries.length && !lived.length) {
    throw new Error('这一天还没有可消化的聊天或经过');
  }

  let dayStory = '';
  let storySaved = null;
  let usefulN = 0;
  let idleArchived = 0;
  let portrait = null;

  if (summaries.length) {
    try {
      const composed = await composeDayStory(char, dateStr, summaries, settings, callChatAPIComplete);
      if (composed?.story) {
        dayStory = composed.story;
        storySaved = saveDayStory(cid, dateStr, dayStory);
        if (composed.hasSubstance) {
          try {
            usefulN = await refineUsefulFromStory(char, dateStr, dayStory, settings, callChatAPIComplete);
          } catch (e) {
            console.warn('[lived-day] refine useful', e.message);
          }
        }
        idleArchived = softArchiveIdleChat(cid, dateStr);
      }
    } catch (e) {
      console.warn('[lived-day] day story', e.message);
      // 事记失败时画像仍可直接啃碎片，不整单作废
      dayStory = '';
    }
  }

  try {
    portrait = await reader.digestChatDay(cid, dateStr, settings, callChatAPIComplete, {
      dayStory: dayStory || undefined,
    });
  } catch (e) {
    console.warn('[lived-day] portrait', e.message);
    // 画像失败不整单作废：事记若已写入仍算部分成功
    if (!dayStory && !lived.length) throw e;
    portrait = { ok: false, error: e.message };
  }

  let selfReads = null;
  if (lived.length) {
    try {
      selfReads = await reader.digestSelfFromDay(cid, dateStr, slots, settings, callChatAPIComplete);
    } catch (e) {
      console.warn('[user-read] self digest', e.message);
    }
  }

  return {
    ok: true,
    date: dateStr,
    carry: getCarry(cid),
    sealed: lived.length,
    story: !!storySaved?.id,
    useful: usefulN,
    idleArchived,
    fragments: summaries.length,
    portrait,
    selfReads,
  };
}

function wantsRecall(text) {
  return RECALL_RE.test(String(text || ''));
}

function wantsLifeAsk(text) {
  return ASK_LIFE_RE.test(String(text || '')) || wantsRecall(text);
}

function recallDays(charId, userText, tz = 'Asia/Shanghai') {
  if (!wantsRecall(userText)) return [];
  const terms = String(userText || '')
    .split(/[，。！？、\s]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 12 && !/还记得|记不记得|记得吗|那天|上次|以前|一起|我们|你们/.test(s));
  const dates = listPastDates(charId, { limit: 30, tz });
  const today = localDateStr(new Date(), tz);
  const scored = [];
  for (const d of [{ date: today }, ...dates]) {
    const slots = daySlots(charId, d.date, { tz, nowMins: d.date === today ? localMinutes(new Date(), tz) : 24 * 60 });
    const blob = slots.map((s) => `${s.activity} ${s.life || ''} ${s.lived}`).join('\n');
    if (!blob.trim()) continue;
    let score = 0;
    for (const t of terms) if (blob.includes(t)) score += 2;
    if (!terms.length) score = slots.some((s) => s.lived) ? 1 : 0;
    if (score > 0) scored.push({ date: d.date, score, slots: slots.filter((s) => s.life || s.lived || s.phase === 'open') });
  }
  scored.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  return scored.slice(0, 2);
}

/**
 * TEMP 对照实验：true = 聊天完全不注入记忆/画像/挂载（含【脑海】【心里有数】【相关印象】【挂在心上】）。
 * 正常运行保持 false：按聊天检索相关记忆再注入，角色按需使用。
 */
const FORCE_SKIP_CHAT_MEMORY = false;

function shouldSkipChatMemoryCarry() {
  return FORCE_SKIP_CHAT_MEMORY === true;
}

/** 通讯设置：携带记忆 / 携带画像。关=不挂常驻块，靠【脑海】与话题检索。 */
function isCarryFlagOn(char, key, defaultOn) {
  const v = char?.[key];
  if (v === undefined || v === null || v === '') return !!defaultOn;
  return !(v === 0 || v === '0' || v === false);
}

function formatForPrompt(char, userText = '') {
  if (!char?.id) return '';
  if (shouldSkipChatMemoryCarry()) return '';
  const tz = getSettings().timezone || char.timezone || 'Asia/Shanghai';
  const today = localDateStr(new Date(), tz);
  const todaySlots = daySlots(char.id, today, { tz }).filter((s) => s.phase === 'lived');
  const parts = [];
  try {
    const dotsBlock = require('./day-chat-dots-helper').formatForPrompt(char.id);
    if (dotsBlock) parts.push(dotsBlock);
  } catch { /* ignore */ }
  // 话题命中的画像始终可注入（隔天再提起要能想起来）；carry_portrait 只影响常驻性格类印象
  try {
    const readBlock = require('./user-read-helper').formatForPrompt(char.id, userText);
    if (readBlock) parts.push(readBlock);
  } catch { /* ignore */ }
  try {
    const promiseBlock = require('./char-promise-helper').formatForPrompt(char.id);
    if (promiseBlock) parts.push(promiseBlock);
  } catch { /* ignore */ }
  if (isCarryFlagOn(char, 'carry_memory', true)) {
    try {
      const pinBlock = require('./memory-brain-helper').formatContextPinsForPrompt(char.id);
      if (pinBlock) parts.push(pinBlock);
    } catch { /* ignore */ }
  }
  // 生活补全默认不进聊天；只有对方问到今天/过去怎么过时才给
  if (wantsLifeAsk(userText)) {
    const passedLife = daySlots(char.id, today, { tz }).filter((s) => (s.life || s.lived) && s.phase !== 'planned');
    if (passedLife.length) {
      parts.push(`【今天已经过的】对方在问你的日子。按这些回答，不要报整张时间表，也不要说成守着手机。\n${passedLife.map((s) => `· ${s.time} ${s.activity}：${s.life || s.lived}`).join('\n')}`);
    } else if (todaySlots.length) {
      parts.push(`【今天已经过的】\n${todaySlots.map((s) => `· ${s.time} ${s.activity}：${s.lived}`).join('\n')}`);
    }
  }
  if (wantsRecall(userText)) {
    const hits = recallDays(char.id, userText, tz);
    if (hits.length) {
      const body = hits.map((h) => `【${h.date}】\n${h.slots.map((s) => `· ${s.time} ${s.activity}${(s.life || s.lived) ? `：${s.life || s.lived}` : ''}`).join('\n')}`).join('\n');
      parts.push(`【被问到的日子】对方在问过去。按这些天实际发生的回答，可先写 [怎么看]…[/怎么看][什么感觉]…[/什么感觉]（用户看不见），再开口。不要念时间表，对不上就承认记不清。\n${body}`);
    } else {
      parts.push('【被问到的日子】对方在问过去，近几天的时间轴里没有能对上的一段。按人设承认记不清，不要编。');
    }
  }
  return parts.join('\n\n');
}

function memoriesByDate(charId, dateStr, limit = 40) {
  try {
    const rows = db.prepare(
      `SELECT date, category, content, weight, source, status FROM memories
       WHERE character_id=? AND date=? AND COALESCE(archived,0)=0
       AND COALESCE(source,'') NOT IN ('schedule','schedule_day')
       AND COALESCE(status,'current')='current'
       ORDER BY
         CASE source
           WHEN 'day_story' THEN 0
           WHEN 'day_digest' THEN 1
           WHEN 'life' THEN 2
           ELSE 3
         END,
         id DESC
       LIMIT ?`
    ).all(Number(charId), dateStr, Math.max(limit * 2, 40));
    const hasStory = rows.some((m) => m.source === 'day_story');
    const filtered = hasStory
      ? rows.filter((m) => ['day_story', 'day_digest', 'life'].includes(m.source))
      : rows;
    return filtered.slice(0, limit).map(({ status, ...rest }) => rest);
  } catch {
    return [];
  }
}

function chatMemories(charId, dateStr, limit = 40) {
  const sql = dateStr
    ? `SELECT date, category, content, weight, source FROM memories
       WHERE character_id=? AND date=? AND COALESCE(archived,0)=0
       AND COALESCE(source,'') NOT IN ('life','schedule','schedule_day')
       ORDER BY id DESC LIMIT ?`
    : `SELECT date, category, content, weight, source FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0
       AND COALESCE(source,'') NOT IN ('life','schedule','schedule_day')
       AND date!=''
       ORDER BY date DESC, id DESC LIMIT ?`;
  try {
    return dateStr
      ? db.prepare(sql).all(Number(charId), dateStr, limit)
      : db.prepare(sql).all(Number(charId), limit);
  } catch {
    return [];
  }
}

/** 人格日子：只看消化进库的记忆，不看日程补全原文 */
function dayDetail(charId, dateStr) {
  const carry = getCarry(charId);
  let cognition = { user: [], self: [] };
  try { cognition = require('./life-fill-helper').listCognition(charId); } catch { /* ignore */ }
  const mems = memoriesByDate(charId, dateStr, 40);
  return {
    date: dateStr,
    carry,
    cognition,
    memories: mems,
    lifeMemories: mems.filter((m) => m.source === 'life'),
    chatMemories: mems.filter((m) => m.source !== 'life'),
    dayStory: mems.find((m) => m.source === 'day_story') || null,
    useful: mems.filter((m) => m.source === 'day_digest'),
  };
}

function overview(charId) {
  const tz = getSettings().timezone || 'Asia/Shanghai';
  const today = localDateStr(new Date(), tz);
  let cognition = { user: [], self: [] };
  try { cognition = require('./life-fill-helper').listCognition(charId); } catch { /* ignore */ }

  const pastMap = new Map();
  try {
    const rows = db.prepare(
      `SELECT date,
         SUM(CASE WHEN source='life' THEN 1 ELSE 0 END) AS life,
         SUM(CASE WHEN source IN ('day_story','day_digest') THEN 1 ELSE 0 END) AS digested,
         SUM(CASE WHEN COALESCE(source,'') NOT IN ('life','schedule','schedule_day','day_story','day_digest') THEN 1 ELSE 0 END) AS chat
       FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0 AND date!='' AND date<=?
       AND COALESCE(source,'') NOT IN ('schedule','schedule_day')
       AND COALESCE(status,'current')='current'
       GROUP BY date ORDER BY date DESC LIMIT 30`
    ).all(Number(charId), today);
    for (const r of rows) {
      pastMap.set(r.date, {
        date: r.date,
        life: r.life || 0,
        chat: (r.digested || 0) + (r.chat || 0),
        total: (r.life || 0) + (r.digested || 0) + (r.chat || 0),
      });
    }
  } catch { /* ignore */ }

  const past = [...pastMap.values()]
    .filter((d) => d.total > 0 && d.date < today)
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    today,
    carry: getCarry(charId),
    cognition,
    todayMemories: memoriesByDate(charId, today, 40),
    past,
    chatRecent: chatMemories(charId, '', 40),
  };
}

module.exports = {
  ensureCarryTable,
  getCarry,
  daySlots,
  overview,
  dayDetail,
  digestDay,
  formatForPrompt,
  shouldSkipChatMemoryCarry,
  recallDays,
  wantsRecall,
  wantsLifeAsk,
};

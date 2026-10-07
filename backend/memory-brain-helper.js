/**
 * 角色记忆大脑：近窗按用户轮数、日程入经历、过时事实、事件连边、脑海闪过注入。
 * 分类名保留；不引入五维坐标系。
 */
const db = require('./db');

const HEALTH_BODY_RE = /头疼|头痛|头晕|难受|不舒服|生病|感冒|发烧|咳嗽|嗓子|拉肚子|过敏|失眠/;
/** 用药/生理期：只有对方这句已经在说药或例假，才把俗称和药名绑在一起 */
const HEALTH_MED_CUE_RE = /布洛芬|止痛药|退烧药|感冒药|消炎药|吃了?.{0,6}药|吃药|服药|药效|例假|姨妈|月经|痛经|生理期/;
const HEALTH_MED_EXPAND = ' 布洛芬 止痛药 吃药 药 例假 姨妈 痛经 生理期 肚子难受';

function expandHealthRetrievalCue(text) {
  const t = String(text || '');
  if (!t.trim()) return t;
  // 「头疼」常常是烦、累，不是在说三天前那颗药。没点到药名就不要把药名塞进检索。
  if (!HEALTH_MED_CUE_RE.test(t)) return t;
  return `${t}${HEALTH_MED_EXPAND}`;
}

function isMedOrCycleMemory(m) {
  const blob = String(m?.content || '');
  return HEALTH_MED_CUE_RE.test(blob) || /止痛|痛经|例假|姨妈|吃药|药效/.test(blob);
}

function isRecentHealthOrMedMemory(m, todayStr) {
  const blob = `${m?.category || ''} ${m?.content || ''}`;
  if (!HEALTH_MED_CUE_RE.test(blob) && !/止痛|痛经|例假|姨妈|吃药|药效/.test(blob)) return false;
  const d = String(m?.date || '').slice(0, 10);
  if (!d || !todayStr) return true;
  // 近两天身体/用药事实，对方再提起时优先捞上来
  try {
    const pa = d.split('-').map(Number);
    const pb = todayStr.split('-').map(Number);
    const da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
    const db_ = Date.UTC(pb[0], pb[1] - 1, pb[2]);
    const days = Math.round((db_ - da) / 86400000);
    return days >= 0 && days <= 2;
  } catch {
    return true;
  }
}
const HEALTH_RECOVERY_RE = /好[了點点]|好多了|不难受|没事了|已经好|不疼了|退烧|痊愈|恢复了/i;
const FLASH_MAX = 2;
/** 送给理解层的脑海候选可略多于最终注入条数（一簇 gist + 细节） */
const FLASH_CANDIDATE_CAP = 6;
const CLUSTER_DETAIL_MAX = 2;
const PREF_KNOW_SLOTS = 3;
const DUE_TODO_SLOTS = 3;
/** 闲聊零携带：相关度门槛抬高，擦边不闪 */
const VEC_MIN_SCORE = 0.45;
const LINK_EXPAND_CAP = 4;
/** 同一条记忆进入【脑海】后的冷却，避免每轮都闪同一句偏好/旧事 */
const FLASH_REPEAT_COOLDOWN_MS = 5 * 60 * 1000;  // 5分钟（原30分钟太长，导致短期记忆差）
const _recentMindFlashAt = new Map(); // charId -> Map(memoryId -> ts)

/** 关掉常驻默记/偶然闪回：闲聊不背书包，话题命中才检索 */
const CARRY_PREF_KNOW_IN_CHAT = false;
const CARRY_INCIDENTAL_FLASH = false;
const TODO_TALK_RE = /约定|承诺|答应|说好的|记得吗|别忘了|之前说|说过|提醒|待办|到期|到点/;

/** 本轮焦点：context 末尾才是当前用户话，用它打分避免捞到更早无关话题 */
function latestFocusText(contextText) {
  const ctx = String(contextText || '').trim();
  if (!ctx) return '';
  const parts = ctx.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  const tail = parts.slice(-3).join('\n');
  return (tail.length >= 8 ? tail : ctx).slice(-400);
}

/* ── 角色语料缓存：算 idf 用。语料越全，口水词被压得越平，打分越准 ── */
const _corpusCache = new Map();
const CORPUS_TTL_MS = 10 * 60 * 1000;

/** 角色的全部记忆文本（碎片 + 记忆点），供相关度打分算词频 */
function getCharCorpus(charId) {
  const id = Number(charId);
  const hit = _corpusCache.get(id);
  if (hit && Date.now() - hit.at < CORPUS_TTL_MS) return hit.corpus;
  let texts = [];
  try {
    texts = db.prepare(
      `SELECT content FROM memories WHERE character_id=? AND COALESCE(archived,0)=0 ORDER BY id DESC LIMIT 800`
    ).all(id).map((r) => r.content);
    const narr = db.prepare(
      `SELECT content FROM memory_narratives WHERE character_id=? LIMIT 200`
    ).all(id).map((r) => r.content);
    texts = texts.concat(narr);
  } catch { /* 迁移中 */ }
  const corpus = require('./embed-helper').buildCorpusDf(texts);
  _corpusCache.set(id, { corpus, at: Date.now() });
  return corpus;
}

function invalidateCharCorpus(charId) {
  _corpusCache.delete(Number(charId));
}
/** 主动找人等用的「上次说话已久」阈值。聊天近窗按轮数带全文，不再用这个切掉上一场原文。 */
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;
const SESSION_STOP_TERMS = new Set([
  '今天', '昨天', '前天', '上午', '下午', '晚上', '刚才', '现在',
  '真的', '就是', '还是', '然后', '这个', '那个', '我们', '你们',
  '自己', '一下', '一点', '什么', '怎么', '可以', '没有', '不是',
  '知道', '觉得', '因为', '所以', '但是', '如果', '已经', '还没',
]);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function getLocalDateStr(date, tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date || new Date());
}

function shiftDateStr(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function parseKeywords(val) {
  if (Array.isArray(val)) return val.filter(Boolean).map(String);
  try { return JSON.parse(val || '[]'); } catch { return []; }
}

function daysBetweenYmd(a, b) {
  const pa = String(a || '').slice(0, 10);
  const pb = String(b || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pa) || !/^\d{4}-\d{2}-\d{2}$/.test(pb)) return 99;
  const da = Date.UTC(+pa.slice(0, 4), +pa.slice(5, 7) - 1, +pa.slice(8, 10));
  const db = Date.UTC(+pb.slice(0, 4), +pb.slice(5, 7) - 1, +pb.slice(8, 10));
  return Math.round((db - da) / 86400000);
}

function weekdayZh(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y) return '';
  return '日一二三四五六'[new Date(y, m - 1, d).getDay()];
}

function formatZhDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd || '';
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

function relativeDayLabel(ymd, today) {
  const diff = daysBetweenYmd(ymd, today);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff > 2 && diff <= 6) return `周${weekdayZh(ymd)}`;
  return formatZhDate(ymd);
}

function isSystemMsg(m) {
  return String(m?.type || 'text') === 'system';
}

function isUserRound(m) {
  return m && m.role === 'user' && !isSystemMsg(m) && !m.recalled;
}

/** 角色设置「聊天携带对话轮数」= 用户轮数，不是气泡条数。 */
function getChatContextRounds(char, settings) {
  const rounds = parseInt(char?.chat_context_rounds, 10);
  if (Number.isFinite(rounds) && rounds > 0) return Math.max(3, Math.min(50, rounds));
  const fallback = parseInt(settings?.memory_carry_count || '18', 10);
  return Math.max(3, Math.min(50, Number.isFinite(fallback) ? fallback : 18));
}

/**
 * 从最新往回取，数满 N 个用户对话轮（系统气泡不占配额，但仍保留落在窗口内的）。
 */
function loadChatContextHistory(characterId, isDream, rounds, opts = {}) {
  const n = Math.max(3, Math.min(50, parseInt(rounds, 10) || 18));
  const fetchLimit = Math.min(400, Math.max(48, n * 10));
  const dreamFlag = isDream ? 1 : 0;
  const cols = opts.columns
    || 'id, role, content, type, timestamp, media_meta, location, is_dream, recalled, recalled_content, recall_seen';
  const rows = db.prepare(
    `SELECT ${cols} FROM messages
     WHERE character_id=? AND is_dream=? AND (recalled=0 OR (recalled=1 AND role='user'))
     ORDER BY id DESC LIMIT ?`
  ).all(characterId, dreamFlag, fetchLimit);

  const kept = [];
  let userRounds = 0;
  for (const m of rows) {
    if (m.recalled && m.role === 'user') {
      const t = parseMessageTime(m.timestamp);
      if (Number.isFinite(t) && Date.now() - t > 6 * 3600 * 1000) continue;
    }
    kept.push(m);
    if (isUserRound(m)) {
      userRounds += 1;
      if (userRounds >= n) break;
    }
  }
  return kept.reverse();
}

function parseMessageTime(ts) {
  if (!ts) return NaN;
  if (ts instanceof Date) return ts.getTime();
  const s = String(ts);
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : NaN;
}

function findSessionCutIndex(history, gapMs = SESSION_GAP_MS) {
  if (!Array.isArray(history) || history.length < 2) return 0;
  let cut = 0;
  for (let i = 1; i < history.length; i++) {
    const a = parseMessageTime(history[i - 1].timestamp);
    const b = parseMessageTime(history[i].timestamp);
    if (Number.isFinite(a) && Number.isFinite(b) && (b - a) >= gapMs) cut = i;
  }
  return cut;
}

function splitChatSessions(history, gapMs = SESSION_GAP_MS) {
  const rows = Array.isArray(history) ? history : [];
  const cut = findSessionCutIndex(rows, gapMs);
  let gapBefore = 0;
  if (cut > 0) {
    const a = parseMessageTime(rows[cut - 1].timestamp);
    const b = parseMessageTime(rows[cut].timestamp);
    if (Number.isFinite(a) && Number.isFinite(b)) gapBefore = b - a;
  }
  return {
    previous: rows.slice(0, cut),
    current: rows.slice(cut),
    cut,
    gapBefore,
    closed: cut > 0,
  };
}

function currentSessionHistory(history, gapMs = SESSION_GAP_MS) {
  return splitChatSessions(history, gapMs).current;
}

function isPinnedMemoryCategory(cat) {
  return cat === '待办' || cat === '约定' || cat === '偏好与习惯';
}

function distinctiveTermHit(sourceText, ctx) {
  const ctxStr = String(ctx || '').trim();
  if (!ctxStr) return false;
  const terms = [...extractMatchTerms(sourceText)].filter((t) => t.length >= 2 && !SESSION_STOP_TERMS.has(t));
  return terms.some((t) => ctxStr.includes(t));
}

function inferFactKey(category, content, extra = {}) {
  if (extra.factKey) return String(extra.factKey).slice(0, 120);
  const text = String(content || '');
  if (extra.source === 'schedule' || extra.source === 'schedule_day') {
    return extra.factKey || '';
  }
  if (HEALTH_BODY_RE.test(text) && (category === '日常点滴' || category === '情感状态')) {
    return 'health:transient';
  }
  if (category === '偏好与习惯') {
    const stem = text.replace(/\d{4}年\d{1,2}月\d{1,2}日[^，,]{0,8}[，,]?\s*/, '')
      .replace(/用户|旅人|自己|角色/g, '')
      .replace(/\s+/g, '')
      .slice(0, 24);
    if (stem.length >= 4) return `pref:${stem}`;
  }
  if (category === '待办' || category === '约定') {
    const due = parseTodoDueDate(text) || 'nodue';
    const stem = todoActionStem(text);
    if (stem.length >= 2) return `todo:${due}:${stem}`.slice(0, 120);
  }
  return '';
}

/** 待办动作主干：去掉日期/到期标记/虚词，留下拍/发/提醒等 */
function todoActionStem(content) {
  let t = String(content || '');
  t = t.replace(/【到期[：:][^】]+】/g, '');
  t = t.replace(/\d{4}年\d{1,2}月\d{1,2}日[^，,]{0,10}[，,]?\s*/g, '');
  const acts = t.match(/拍(?:照|自拍|张图|张照|一张|个照)?|发(?:张|个|条|段)?(?:图|照片|图片|自拍|视频|定位|位置)?|自拍|打卡|提醒|吃药|买菜|回消息|打电话|联系|交作业|提交|起床|睡觉|起床|到点/g);
  if (acts?.length) return [...new Set(acts.map((a) => a.slice(0, 8)))].slice(0, 4).join('+');
  t = t
    .replace(/用户|旅人|自己|角色|表示|答应|记得|会|要|让|说|的|了|在|和|与|给|把|向|对|再|就|也|都|很|非常/g, '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''“”‘’（）()\d.…·]/g, '');
  return t.slice(0, 18);
}

function todosAreSimilar(a, b) {
  const ca = String(a || '');
  const cb = String(b || '');
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const dueA = parseTodoDueDate(ca);
  const dueB = parseTodoDueDate(cb);
  if (dueA && dueB && dueA !== dueB) return false;
  const stemA = todoActionStem(ca);
  const stemB = todoActionStem(cb);
  if (!stemA || !stemB) return false;
  if (stemA === stemB) return true;
  if (stemA.includes(stemB) || stemB.includes(stemA)) return true;
  const partsA = stemA.split('+').filter(Boolean);
  const partsB = stemB.split('+').filter(Boolean);
  if (partsA.length && partsB.length) {
    const hit = partsA.filter((p) => partsB.some((q) => q.includes(p) || p.includes(q)));
    if (hit.length >= 1 && (partsA.length <= 2 || hit.length / Math.min(partsA.length, partsB.length) >= 0.5)) {
      return true;
    }
  }
  // 去日期后正文短重叠
  const strip = (s) => s
    .replace(/【到期[：:][^】]+】/g, '')
    .replace(/\d{4}年\d{1,2}月\d{1,2}日[^，,]{0,10}[，,]?\s*/g, '')
    .replace(/\s+/g, '');
  const sa = strip(ca);
  const sb = strip(cb);
  if (sa.length >= 10 && sb.length >= 10) {
    const head = sa.slice(0, 16);
    if (sb.includes(head) || sa.includes(sb.slice(0, 16))) return true;
  }
  return false;
}

function findSimilarOpenTodo(characterId, content, category = '待办') {
  const cats = category === '约定' ? ['约定', '待办'] : ['待办', '约定'];
  const rows = db.prepare(
    `SELECT id, content, category, weight FROM memories
     WHERE character_id=? AND category IN (${cats.map(() => '?').join(',')})
       AND COALESCE(status,'current')='current'
       AND COALESCE(resolved,0)=0
       AND COALESCE(archived,0)=0
     ORDER BY id DESC LIMIT 40`
  ).all(characterId, ...cats);
  for (const row of rows) {
    if (todosAreSimilar(content, row.content)) return row;
  }
  return null;
}

/** 合并库里已有的相似待办：同到期+同动作只留最新/最长一条 */
function dedupeOpenTodos(characterId) {
  if (!characterId) return 0;
  const rows = db.prepare(
    `SELECT id, content, category, weight, date FROM memories
     WHERE character_id=? AND category IN ('待办','约定')
       AND COALESCE(status,'current')='current'
       AND COALESCE(resolved,0)=0
       AND COALESCE(archived,0)=0
     ORDER BY id ASC`
  ).all(characterId);
  if (rows.length < 2) return 0;
  let closed = 0;
  const keep = [];
  for (const row of rows) {
    const twin = keep.find((k) => todosAreSimilar(k.content, row.content));
    if (!twin) {
      keep.push(row);
      continue;
    }
    // 留更长或更新的；另一条标 historical
    const preferNew = String(row.content || '').length >= String(twin.content || '').length;
    const drop = preferNew ? twin : row;
    const stay = preferNew ? row : twin;
    try {
      db.prepare(
        `UPDATE memories SET status='historical', resolved=1 WHERE id=?`
      ).run(drop.id);
      closed += 1;
      if (preferNew) {
        const idx = keep.indexOf(twin);
        if (idx >= 0) keep[idx] = stay;
      }
    } catch (e) {
      console.warn('[brain] dedupe todo', e.message);
    }
  }
  if (closed) {
    try { invalidateCharCorpus(characterId); } catch {}
    console.log(`[brain] dedupeOpenTodos char#${characterId} closed=${closed}`);
  }
  return closed;
}

function listOpenTodosForPrompt(characterId, limit = 8) {
  try { dedupeOpenTodos(characterId); } catch {}
  const rows = db.prepare(
    `SELECT content FROM memories
     WHERE character_id=? AND category IN ('待办','约定')
       AND COALESCE(status,'current')='current'
       AND COALESCE(resolved,0)=0
       AND COALESCE(archived,0)=0
     ORDER BY id DESC LIMIT ?`
  ).all(characterId, limit);
  return rows.map((r) => String(r.content || '').trim()).filter(Boolean);
}

/**
 * 当前 = 今天还在用的，或还没结束的约定/习惯。
 * 过了夜的情节收成过时，不再跟「正在发生」放在一池。
 */
function settlePassedCurrentMemories(characterId, todayStr) {
  if (!characterId || !todayStr) return 0;
  try {
    const r = db.prepare(
      `UPDATE memories SET status='historical'
       WHERE character_id=?
         AND COALESCE(archived,0)=0
         AND COALESCE(status,'current')='current'
         AND COALESCE(resolved,0)=0
         AND category NOT IN ('约定','待办','偏好与习惯','重要时刻')
         AND (
           (COALESCE(date,'')!='' AND date<?)
           OR (
             COALESCE(date,'')=''
             AND substr(COALESCE(created_at,''),1,10)!=''
             AND substr(created_at,1,10)<?
           )
         )`
    ).run(Number(characterId), todayStr, todayStr);
    let n = r.changes || 0;
    const standingPromise = /以后|永远|每天|一直|长期|随时|无论/;
    const rows = db.prepare(
      `SELECT id, category, content, date FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0
         AND COALESCE(status,'current')='current'
         AND COALESCE(resolved,0)=0
         AND category IN ('待办','约定')`
    ).all(Number(characterId));
    for (const row of rows) {
      const due = row.category === '待办' ? (parseTodoDueDate(row.content) || String(row.date || '').slice(0, 10)) : '';
      const expiredTodo = row.category === '待办' && due && due < todayStr;
      const fadedPromise = row.category === '约定'
        && String(row.date || '') !== ''
        && String(row.date) < todayStr
        && !standingPromise.test(String(row.content || ''));
      if (!expiredTodo && !fadedPromise) continue;
      db.prepare(`UPDATE memories SET status='historical', resolved=1 WHERE id=?`).run(row.id);
      n += 1;
    }
    const restored = db.prepare(
      `UPDATE memories SET status='current', resolved=0
       WHERE character_id=? AND category='重要时刻'
         AND COALESCE(archived,0)=0 AND COALESCE(status,'current')='historical'`
    ).run(Number(characterId));
    n += restored.changes || 0;
    return n;
  } catch (e) {
    console.warn('[brain] settle passed', e.message);
    return 0;
  }
}

function settleAllPassedCurrentMemories() {
  const settings = getSettings();
  const todayStr = getLocalDateStr(new Date(), settings.timezone || 'Asia/Shanghai');
  const chars = db.prepare('SELECT id FROM characters').all();
  let n = 0;
  for (const c of chars) {
    n += settlePassedCurrentMemories(c.id, todayStr);
    try { n += applyIdentityCorrections(c.id); } catch { /* ignore */ }
  }
  return n;
}

const IDENTITY_GENERIC_RE = /^(什么|怎么|这个|那个|东西|图片|颜色|配色|逻辑|感觉|样子|水平|意思|这种|专属)$/;

function cleanIdentityTerm(raw) {
  let t = String(raw || '').replace(/\s+/g, '').replace(/\[[^\]]{1,8}\]/g, '');
  t = t.replace(/(怎么|如何|到底|究竟|好吧|好不好).*/, '');
  t = t.replace(/(好吧|啊|呀|呢|哦|嘛|吧|了|的|呀)+$/g, '');
  const cut = t.split('的').pop();
  if (cut && cut.length >= 2) t = cut;
  t = t.replace(/^(这个|那个)/, '');
  if (t.length < 2 || t.length > 8) return '';
  if (IDENTITY_GENERIC_RE.test(t)) return '';
  return t;
}

/** 对方纠正「这是什么」之后，角色先前猜的叫法不再当成事实 */
function extractIdentityCorrections(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const found = [];
  const guessRes = [
    /原来是(?:你的|我的)?([^，。！？!?\s]{2,8})/g,
    /是不是([^，。！？!?\s]{2,8})/g,
    /([\u4e00-\u9fff]{2,4})一模一样/g,
  ];
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.role !== 'user') continue;
    const text = String(list[i].content || '');
    const truths = [];
    for (const re of [
      /这是([^，。！？!?\n]{1,18})/g,
      /我说的(?:是)?([^，。！？!?\n]{1,18})/g,
      /我的意思是(?:这个|那个)?([^，。！？!?\n]{1,18})/g,
    ]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const term = cleanIdentityTerm(m[1]);
        if (term) truths.push(term);
      }
    }
    if (!truths.length) continue;
    const denied = new Set();
    const prior = list.slice(Math.max(0, i - 16), i).filter((x) => x?.role === 'assistant');
    for (const a of prior) {
      const t = String(a.content || '');
      for (const re of guessRes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(t))) {
          const term = cleanIdentityTerm(m[1]);
          if (!term || /去|到|这|确认|偷偷|到底/.test(term)) continue;
          if (truths.some((f) => term.includes(f) || f.includes(term))) continue;
          denied.add(term);
        }
      }
    }
    if (!denied.size) continue;
    for (const truth of truths) found.push({ truth, denied: [...denied] });
  }
  const map = new Map();
  for (const c of found) {
    const set = map.get(c.truth) || new Set();
    for (const d of c.denied) set.add(d);
    map.set(c.truth, set);
  }
  return [...map.entries()].map(([truth, denied]) => ({ truth, denied: [...denied] }));
}

function memoryContradictsCorrection(content, corrections) {
  const text = String(content || '');
  if (!text || !corrections?.length) return false;
  for (const c of corrections) {
    if (!c?.truth || text.includes(c.truth)) continue;
    if ((c.denied || []).some((d) => d && text.includes(d))) return true;
    // 认成化妆品之后编出来的涂抹/试色，不是另一件真事
    if ((c.denied || []).some((d) => /妆|化妆|腮红/.test(d))
      && /美妆实验|脸部试色|抹面霜|涂乳液|手部按摩/.test(text)) return true;
  }
  return false;
}

function loadRecentIdentityMessages(characterId) {
  if (!characterId) return [];
  try {
    const settings = getSettings();
    const todayStr = getLocalDateStr(new Date(), settings.timezone || 'Asia/Shanghai');
    const startUtc = new Date(`${todayStr}T00:00:00+08:00`).toISOString();
    return db.prepare(
      `SELECT role, content FROM messages
       WHERE character_id=? AND COALESCE(recalled,0)=0 AND COALESCE(is_dream,0)=0
         AND role IN ('user','assistant') AND timestamp>=?
       ORDER BY id ASC`
    ).all(characterId, startUtc);
  } catch {
    return [];
  }
}

function formatIdentityCorrectionNote(corrections) {
  if (!corrections?.length) return '';
  const lines = corrections.slice(-3).map((c) => {
    const deny = (c.denied || []).slice(0, 4).join('、');
    return `对方已经说明那是「${c.truth}」，不是${deny}。之后都按「${c.truth}」理解。禁止沿用猜错的叫法，禁止把猜测写成已经发生的事，也不要顺着猜错的名字再编动作。`;
  });
  return `【对方纠正·硬性】\n${lines.join('\n')}`;
}

/**
 * 把「猜错又被对方纠正」的当前记忆收成过时，并在当天摘要末尾补上纠正。
 * 只动近两天，避免误伤更早的稳定说法。
 */
function applyIdentityCorrections(characterId) {
  if (!characterId) return 0;
  const corrections = extractIdentityCorrections(loadRecentIdentityMessages(characterId));
  if (!corrections.length) return 0;
  const settings = getSettings();
  const todayStr = getLocalDateStr(new Date(), settings.timezone || 'Asia/Shanghai');
  const since = shiftDateStr(todayStr, -1);
  let n = 0;
  try {
    const rows = db.prepare(
      `SELECT id, content FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0
         AND COALESCE(status,'current')='current'
         AND date!='' AND date>=?`
    ).all(characterId, since);
    for (const r of rows) {
      if (!memoryContradictsCorrection(r.content, corrections)) continue;
      db.prepare(`UPDATE memories SET status='historical' WHERE id=?`).run(r.id);
      n += 1;
    }
  } catch (e) {
    console.warn('[brain] identity memory', e.message);
  }
  try {
    const eps = db.prepare(
      `SELECT id, gist FROM memory_episodes
       WHERE character_id=? AND date!='' AND date>=?`
    ).all(characterId, since);
    for (const ep of eps) {
      const gist = String(ep.gist || '');
      if (!gist || gist.includes('对方已纠正') || !memoryContradictsCorrection(gist, corrections)) continue;
      const c = corrections.find((x) => (x.denied || []).some((d) => gist.includes(d)) && !gist.includes(x.truth));
      if (!c) continue;
      const note = `（对方已纠正：那是${c.truth}，${c.denied.slice(0, 3).join('、')}是认错，并没有发生。）`;
      const room = Math.max(0, 520 - note.length);
      db.prepare(`UPDATE memory_episodes SET gist=? WHERE id=?`).run(`${gist.slice(0, room)}${note}`, ep.id);
      n += 1;
    }
  } catch (e) {
    console.warn('[brain] identity episode', e.message);
  }
  if (n) console.log(`[brain] identity corrections char#${characterId} ${n}`);
  return n;
}

function markHistoricalByFactKey(characterId, factKey, exceptId = null) {
  if (!factKey) return [];
  const rows = db.prepare(
    `SELECT id FROM memories WHERE character_id=? AND fact_key=? AND COALESCE(status,'current')='current'`
  ).all(characterId, factKey);
  const ids = [];
  for (const r of rows) {
    if (exceptId && Number(r.id) === Number(exceptId)) continue;
    db.prepare(`UPDATE memories SET status='historical' WHERE id=?`).run(r.id);
    ids.push(r.id);
  }
  return ids;
}

function addMemoryLink(characterId, fromId, toId, type) {
  if (!fromId || !toId || fromId === toId) return false;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO memory_links (character_id, from_id, to_id, type) VALUES (?,?,?,?)`
    ).run(characterId, fromId, toId, type);
    return true;
  } catch {
    return false;
  }
}

function parseMemoryMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function memorySalience(m) {
  const meta = parseMemoryMeta(m?.meta);
  const importance = Number(meta.importance ?? m?.weight ?? 0.5);
  const valence = Math.abs(Number(meta.emotion?.valence ?? 0));
  const arousal = Number(meta.emotion?.arousal ?? 0);
  // 用户侧常提会涨 mention_count → 更容易浮现
  const mentions = Math.min(24, Math.max(0, Number(meta.mention_count) || 0));
  const mentionBoost = Math.log1p(mentions) / Math.log1p(24); // 0~1
  return importance * 0.48 + valence * 0.18 + arousal * 0.12 + mentionBoost * 0.22;
}

/**
 * 用户聊到相关记忆 → 记一次提及并略涨权（每天每条最多 +1）。
 * 浮现仍由检索决定；涨权影响以后更容易浮到【脑海】。
 */
function bumpMemoriesHitByUserTalk(charId, userText, memoryRows = []) {
  const raw = String(userText || '').trim();
  if (!charId || raw.length < 2) return 0;
  const list = Array.isArray(memoryRows) ? memoryRows.filter(Boolean) : [];
  if (!list.length) return 0;
  let today = '';
  try {
    today = getLocalDateStr(new Date(), getSettings().timezone || 'Asia/Shanghai');
  } catch {
    today = new Date().toISOString().slice(0, 10);
  }
  let n = 0;
  const upd = db.prepare(`UPDATE memories SET weight=?, meta=? WHERE id=? AND character_id=?`);
  for (const m of list) {
    if (!m?.id) continue;
    if (!(utteranceHitsMemory(m, raw) || memoryMatchesContext(m, raw) || distinctiveTermHit(m.content, raw))) {
      continue;
    }
    const meta = parseMemoryMeta(m.meta);
    if (String(meta.last_mention_date || '') === today) continue;
    meta.mention_count = Math.min(99, (Number(meta.mention_count) || 0) + 1);
    meta.last_mention_date = today;
    const prevW = Math.max(0.1, Math.min(1, Number(m.weight) || Number(meta.importance) || 0.5));
    const nextW = Math.min(1, prevW + 0.035);
    meta.importance = Math.min(1, Math.max(Number(meta.importance) || prevW, nextW));
    const metaStr = JSON.stringify(meta);
    try {
      upd.run(nextW, metaStr, m.id, charId);
      m.weight = nextW;
      m.meta = metaStr;
      n += 1;
    } catch { /* ignore */ }
  }
  return n;
}

function memoryDecayFactor(m, todayStr) {
  const d = String(m?.date || m?.created_at || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !todayStr) return 1;
  const pa = d.split('-').map(Number);
  const pb = todayStr.split('-').map(Number);
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  const days = Math.max(0, Math.round((db - da) / 86400000));
  // 约定和习惯要留得久。当天的事过几天就不应再跟今天抢，不然旧情节会被说成正在发生。
  const cat = String(m?.category || '');
  const slow = cat === '约定' || cat === '待办' || cat === '偏好与习惯';
  return Math.exp(-days / (slow ? 45 : 8));
}

function insertMemory(opts) {
  const characterId = opts.characterId;
  const category = String(opts.category || '日常点滴').trim() || '日常点滴';
  const content = String(opts.content || '').trim();
  if (!characterId || !content) return null;
  const weight = Math.max(0.1, Math.min(1, Number(opts.weight) || 0.5));
  const date = String(opts.date || getLocalDateStr(new Date())).slice(0, 10);
  const episodeId = opts.episodeId || null;
  const keywords = JSON.stringify(parseKeywords(opts.keywords).slice(0, 8));
  const source = String(opts.source || 'chat').slice(0, 32);
  const factKey = inferFactKey(category, content, { ...opts, source });
  const status = opts.status || 'current';
  const metaObj = opts.meta && typeof opts.meta === 'object' ? { ...opts.meta } : {};
  if (metaObj.importance == null) metaObj.importance = weight;
  if (!metaObj.mood_label) {
    try {
      const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
      metaObj.mood_label = require('./emotion-helper').officialMoodZhFromChar(char);
    } catch { /* ignore */ }
  }
  const meta = JSON.stringify(metaObj);

  const dup = db.prepare(
    `SELECT id FROM memories WHERE character_id=? AND content=? LIMIT 1`
  ).get(characterId, content);
  if (dup) return { id: dup.id, duplicate: true };

  // 待办/约定：同到期+同动作视为重复，不新建；必要时用更完整正文覆盖旧条
  if (category === '待办' || category === '约定') {
    const similar = findSimilarOpenTodo(characterId, content, category);
    if (similar?.id) {
      const oldLen = String(similar.content || '').length;
      const newLen = content.length;
      if (newLen > oldLen + 12) {
        try {
          db.prepare(`UPDATE memories SET content=?, weight=?, fact_key=? WHERE id=?`)
            .run(content, Math.max(weight, Number(similar.weight) || 0.5), factKey || '', similar.id);
          if (factKey) markHistoricalByFactKey(characterId, factKey, similar.id);
          invalidateCharCorpus(characterId);
        } catch (e) {
          console.warn('[brain] refresh similar todo', e.message);
        }
      }
      return { id: similar.id, duplicate: true, similar: true };
    }
  }

  const r = db.prepare(
    `INSERT INTO memories (character_id, category, content, weight, date, episode_id, keywords, embedding, archived, resolved, fact_key, status, source, meta)
     VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?,?)`
  ).run(
    characterId, category, content, weight, date, episodeId, keywords, '',
    factKey || '', status, source, meta
  );
  const id = r.lastInsertRowid;
  if (factKey && status === 'current') {
    const oldIds = markHistoricalByFactKey(characterId, factKey, id);
    for (const oldId of oldIds) addMemoryLink(characterId, id, oldId, 'supersedes');
  }
  try {
    require('./memory-narrative-helper').scheduleEmbedMemoryIds([id]);
  } catch { /* ignore */ }
  invalidateCharCorpus(characterId); // 语料变了，idf 得重算
  return { id, factKey, superseded: true };
}

function applyHealthSupersession(characterId) {
  try {
    const rows = db.prepare(
      `SELECT id, content FROM messages
       WHERE character_id=? AND role='user' AND is_dream=0 AND recalled=0
       ORDER BY id DESC LIMIT 80`
    ).all(characterId);
    let sawConcernAfter = false;
    let recovered = false;
    for (const row of rows) {
      const t = String(row.content || '');
      if (HEALTH_RECOVERY_RE.test(t) && !sawConcernAfter) {
        recovered = true;
        break;
      }
      if (HEALTH_BODY_RE.test(t)) sawConcernAfter = true;
    }
    if (!recovered) return false;
    const hits = db.prepare(
      `SELECT id, content FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0 AND COALESCE(status,'current')='current'`
    ).all(characterId);
    let n = 0;
    for (const m of hits) {
      if (!HEALTH_BODY_RE.test(m.content || '')) continue;
      if (HEALTH_RECOVERY_RE.test(m.content || '')) continue;
      db.prepare(`UPDATE memories SET status='historical', fact_key=CASE WHEN fact_key='' OR fact_key IS NULL THEN 'health:transient' ELSE fact_key END WHERE id=?`)
        .run(m.id);
      n += 1;
    }
    return n > 0;
  } catch {
    return false;
  }
}

/**
 * 待办/约定履行收尾：对话里已发图/已说做完/已提醒 → 标 historical + resolved，避免脑海反复提。
 */
function resolveCompletedTodos(characterId, opts = {}) {
  if (!characterId) return 0;
  const open = db.prepare(
    `SELECT id, content, category FROM memories
     WHERE character_id=? AND category IN ('待办','约定')
       AND COALESCE(status,'current')='current'
       AND COALESCE(resolved,0)=0
       AND COALESCE(archived,0)=0
     ORDER BY id DESC LIMIT 40`
  ).all(characterId);
  if (!open.length) return 0;

  const recent = Array.isArray(opts.recentMessages) && opts.recentMessages.length
    ? opts.recentMessages
    : db.prepare(
      `SELECT role, content, type FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND (type IS NULL OR type NOT IN ('system'))
       ORDER BY id DESC LIMIT 36`
    ).all(characterId).reverse();

  const blob = [
    String(opts.aiContent || ''),
    ...recent.map((m) => String(m.content || '')),
  ].join('\n');
  const sentMedia = !!opts.sentImage || !!opts.sentVideo
    || recent.some((m) => m.role === 'assistant' && (m.type === 'image' || m.type === 'video'))
    || /发你了|发给你了|拍好了|录好了|发过去了|发完了|发了/.test(blob);
  const doneTalk = /做完了|弄完了|办完了|搞定了|已经.{0,6}(?:发|拍|做|弄|提醒)|提醒过了|说过了|发过了|拍过了/.test(blob);

  let closed = 0;
  for (const row of open) {
    const content = String(row.content || '');
    const terms = [...extractMatchTerms(content)]
      .filter((t) => t.length >= 2 && !SESSION_STOP_TERMS.has(t))
      .slice(0, 8);
    const overlap = terms.length
      ? terms.filter((t) => blob.includes(t)).length / terms.length
      : 0;
    const mediaTodo = /拍|发|自拍|图|照片|视频|打卡|提醒/.test(content);
    const shouldClose = (mediaTodo && sentMedia && overlap >= 0.25)
      || (doneTalk && overlap >= 0.35)
      || (sentMedia && mediaTodo && /【到期/.test(content) && overlap >= 0.15);
    if (!shouldClose) continue;
    try {
      db.prepare(
        `UPDATE memories SET status='historical', resolved=1 WHERE id=?`
      ).run(row.id);
      closed += 1;
    } catch (e) {
      console.warn('[brain] resolve todo', e.message);
    }
  }
  if (closed) {
    try { invalidateCharCorpus(characterId); } catch {}
  }
  return closed;
}

function parseScheduleItems(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function getScheduleItemReview(it) {
  const thought = String(it?.thought || '').trim();
  if (thought) return thought;
  return String(it?.execution || '').trim();
}

/** 只有印象深刻的生活片段才进记忆，普通行程不记 */
function writeScheduleItemMemory(charId, dateStr, item, idx) {
  const activity = String(item?.activity || item?.title || '').trim();
  if (!activity) return null;
  const salient = String(item?.salience || '').toLowerCase() === 'high' || item?._force;
  if (!salient) return null;
  const review = String(item?.lived || '').trim() || getScheduleItemReview(item);
  if (!review) return null;
  const time = String(item.time || '').trim();
  const factKey = `life:${charId}:${dateStr}:${time || idx}`;
  const zh = formatZhDate(dateStr);
  const body = review
    ? `${zh}${time ? time : ''}，自己「${activity}」：${review}`
    : `${zh}${time ? time : ''}，自己按日程过了「${activity}」。`;
  const ir = insertMemory({
    characterId: charId,
    category: '日常点滴',
    content: body.slice(0, 400),
    weight: 0.58,
    date: dateStr,
    source: 'life',
    factKey,
    keywords: [activity].filter(Boolean),
  });
  if (ir?.id) autoLinkNewMemories(charId, [ir.id]);
  return ir;
}

function writeScheduleDayEpisode(charId, dateStr) {
  const row = db.prepare(
    `SELECT items FROM schedules WHERE character_id=? AND role='ai' AND date=?`
  ).get(charId, dateStr);
  if (!row?.items) return { ok: false, reason: 'no_schedule' };
  const already = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE character_id=? AND date=? AND source='life' AND COALESCE(archived,0)=0`
  ).get(charId, dateStr)?.n || 0;
  if (already > 0) return { ok: true, reason: 'already', count: already };
  const items = parseScheduleItems(row.items);
  const salient = items
    .map((it, idx) => ({ it, idx }))
    .filter((x) => String(x.it?.salience || '').toLowerCase() === 'high' && String(x.it?.lived || '').trim());
  const ids = [];
  for (const x of salient) {
    const ir = writeScheduleItemMemory(charId, dateStr, x.it, x.idx);
    if (ir?.id) ids.push(ir.id);
  }
  if (ids.length) autoLinkNewMemories(charId, ids);
  return { ok: ids.length > 0, reason: ids.length ? 'salient' : 'no_salient', count: ids.length };
}

async function packYesterdaySchedules(opts = {}) {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const target = opts.dateStr || shiftDateStr(today, -1);
  const chars = db.prepare('SELECT id FROM characters').all();
  let n = 0;
  for (const c of chars) {
    try {
      const r = writeScheduleDayEpisode(c.id, target);
      if (r?.ok) n += 1;
    } catch (e) {
      console.warn('[brain] pack schedule', c.id, e.message);
    }
  }
  if (n) console.log(`[brain] packed schedule days=${n} date=${target}`);
  return n;
}

function wantsPastLife(contextText) {
  const ctx = String(contextText || '');
  return /(前几天|这几天|最近几天|最近在忙|最近干嘛|最近做什么|昨天|昨晚|前日|前天|那天|那晚|过得|怎么过|干了什么|做了什么|忙什么|加班|日程|行程|你去哪)/.test(ctx);
}

/** 硬线索：身体/药、问过去、谈约定待办——才值得开检索 */
function hasHardMemoryCue(contextText) {
  const ctx = String(contextText || '');
  if (!ctx.trim()) return false;
  if (HEALTH_MED_CUE_RE.test(ctx) || HEALTH_BODY_RE.test(ctx)) return true;
  if (wantsPastLife(ctx)) return true;
  if (TODO_TALK_RE.test(ctx)) return true;
  try {
    const lived = require('./lived-day-helper');
    if (lived.wantsLifeAsk?.(ctx) || lived.wantsRecall?.(ctx)) return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * 闲聊零携带：无硬线索且与库里条目无明显词重叠时，整段不检索。
 * 有硬线索或命中关键词才打开记忆注入。
 */
function shouldRetrieveMemoriesForChat(char, contextText) {
  const ctx = String(contextText || '').trim();
  if (!ctx) return false;
  if (hasHardMemoryCue(ctx)) return true;
  const focus = latestFocusText(ctx) || ctx;
  if (focus.length < 4) return false;
  try {
    const cues = require('./memory-gate-helper').lastClusterCues(char.id) || [];
    for (const cue of cues) {
      const t = String(cue || '').trim();
      if (t.length >= 2 && (focus.includes(t) || distinctiveTermHit(t, focus))) return true;
    }
  } catch { /* ignore */ }
  try {
    const rows = db.prepare(
      `SELECT content, category, keywords FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0
         AND COALESCE(status,'current') NOT IN ('archived')
       ORDER BY id DESC LIMIT 80`
    ).all(char.id);
    for (const m of rows) {
      if (memoryMatchesContext(m, focus) || distinctiveTermHit(m.content, focus)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

function extractMatchTerms(text) {
  const terms = new Set();
  String(text || '')
    .split(/[，。！？、；：\s\n\r\t\/\|·…—\-~～「」『』（）()\[\]【】]{1,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 16)
    .forEach((s) => terms.add(s));
  return terms;
}

function utteranceHitsMemory(m, rawText) {
  const raw = String(rawText || '');
  if (!raw.trim() || !m) return false;
  return memoryMatchesContext(m, raw) || distinctiveTermHit(m.content, raw);
}

/** 没再提那件事、也过了近两天的吃药/例假，不要因为一句身体抱怨被捞回来 */
function medMemoryStaleForUtterance(m, todayStr, rawText) {
  if (!isMedOrCycleMemory(m)) return false;
  const raw = String(rawText || '');
  if (HEALTH_MED_CUE_RE.test(raw)) return false;
  if (utteranceHitsMemory(m, raw)) return false;
  if (isRecentHealthOrMedMemory(m, todayStr)) return false;
  return true;
}

function memoryMatchesContext(memory, contextText) {
  const ctx = String(contextText || '').trim();
  const content = String(memory?.content || '').trim();
  if (!ctx || !content) return false;
  const ctxTerms = extractMatchTerms(ctx);
  const memTerms = extractMatchTerms(content);
  for (const t of memTerms) {
    if (t.length >= 3 && ctx.includes(t)) return true;
    if (ctxTerms.has(t)) return true;
  }
  for (const t of ctxTerms) {
    if (t.length >= 3 && content.includes(t)) return true;
  }
  const cat = memory.category;
  if (cat === '约定' || cat === '待办') {
    if (/约定|承诺|答应|说好的|记得吗|别忘了|之前说|说过|提醒|待办/.test(ctx)) return true;
  }
  if (cat === '情感状态' && /心情|情绪|难过|开心|生气|焦虑|压力|烦|累|委屈/.test(ctx)) return true;
  if (memory.source === 'schedule' || memory.source === 'schedule_day' || memory.source === 'life') {
    if (wantsPastLife(ctx)) return true;
  }
  // 偏好不再「永远匹配」：否则会每轮进脑海，角色反复提同一句喜欢/习惯
  return false;
}

function parseTodoDueDate(content) {
  const m = String(content || '').match(/【到期[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

function expandByLinks(characterId, selected, allMem, cap = LINK_EXPAND_CAP) {
  const seen = new Set(selected.map((m) => m.id));
  const out = [...selected];
  const ids = selected.map((m) => m.id);
  if (!ids.length) return out;
  const placeholders = ids.map(() => '?').join(',');
  let rows = [];
  try {
    // 只扩同一事件；弱 related 容易把无关话题焊进同一轮
    rows = db.prepare(
      `SELECT from_id, to_id, type FROM memory_links
       WHERE character_id=? AND type='same_event'
         AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`
    ).all(characterId, ...ids, ...ids);
  } catch {
    return out;
  }
  const byId = new Map(allMem.map((m) => [m.id, m]));
  for (const row of rows) {
    if (out.length >= selected.length + cap) break;
    const other = ids.includes(row.from_id) ? row.to_id : row.from_id;
    if (seen.has(other)) continue;
    const mem = byId.get(other);
    if (!mem || Number(mem.archived) === 1) continue;
    seen.add(other);
    out.push(mem);
  }
  return out;
}

function narrativeMemberIds(narrative) {
  try {
    return require('./memory-tree-helper').collectTreeLinkedIds(narrative);
  } catch {
    return new Set();
  }
}

/** 有记忆点用记忆点，否则 episode / same_event，再否则单条 */
function assignMemoryClusters(selected, narratives = []) {
  const map = new Map();
  for (const n of narratives || []) {
    if (!n?.id) continue;
    const cid = `narr:${n.id}`;
    for (const id of narrativeMemberIds(n)) map.set(Number(id), cid);
  }
  for (const m of selected || []) {
    if (!m?.id || map.has(Number(m.id))) continue;
    if (m.episode_id) map.set(Number(m.id), `ep:${m.episode_id}`);
  }
  const leftover = [...(selected || [])].filter((m) => m?.id && !map.has(Number(m.id)));
  if (leftover.length >= 2) {
    const ids = leftover.map((m) => Number(m.id));
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (x) => {
      let p = parent.get(x);
      while (p !== parent.get(p)) {
        parent.set(p, parent.get(parent.get(p)));
        p = parent.get(p);
      }
      return p;
    };
    const union = (a, b) => {
      const pa = find(a);
      const pb = find(b);
      if (pa !== pb) parent.set(pa, pb);
    };
    try {
      const charId = leftover[0].character_id;
      if (charId && ids.length) {
        const ph = ids.map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT from_id, to_id FROM memory_links
           WHERE character_id=? AND type='same_event'
             AND from_id IN (${ph}) AND to_id IN (${ph})`
        ).all(charId, ...ids, ...ids);
        for (const row of rows) union(Number(row.from_id), Number(row.to_id));
      }
    } catch { /* ignore */ }
    const size = new Map();
    for (const id of ids) {
      const r = find(id);
      size.set(r, (size.get(r) || 0) + 1);
    }
    for (const m of leftover) {
      const root = find(Number(m.id));
      map.set(Number(m.id), (size.get(root) || 1) > 1 ? `evt:${root}` : `mem:${m.id}`);
    }
  }
  for (const m of leftover) {
    if (!map.has(Number(m.id))) map.set(Number(m.id), `mem:${m.id}`);
  }
  return map;
}

function clusterIdForFlash(c, memCluster) {
  if (!c) return '';
  if (c.clusterId) return String(c.clusterId);
  if (c.kind === 'episode' || String(c.key || '').startsWith('ep:')) return `ep:${c.id}`;
  if (c.kind === 'narrative' || String(c.key || '').startsWith('narr:')) return `narr:${c.id}`;
  if (c.kind === 'memory' && c.id != null && memCluster) {
    return memCluster.get(Number(c.id)) || `mem:${c.id}`;
  }
  return String(c.key || '');
}

function buildClusterKeyMap(flashCandidates = [], narratives = [], selected = []) {
  const memCluster = assignMemoryClusters(selected, narratives);
  const map = new Map();
  for (const n of narratives || []) {
    if (n?.id) map.set(`narr:${n.id}`, `narr:${n.id}`);
  }
  for (const c of flashCandidates || []) {
    const key = c.key || (c.kind === 'memory' ? `mem:${c.id}` : '');
    if (!key) continue;
    const cid = clusterIdForFlash(c, memCluster);
    c.clusterId = cid;
    map.set(key, cid);
  }
  for (const [memId, cid] of memCluster) {
    map.set(`mem:${memId}`, cid);
  }
  return map;
}

function autoLinkNewMemories(characterId, newIds) {
  const ids = [...new Set((newIds || []).map(Number).filter(Boolean))];
  if (ids.length < 1) return 0;
  let linked = 0;
  try {
    const rows = ids.map((id) => db.prepare(
      `SELECT id, content, date, episode_id, embedding, keywords FROM memories WHERE id=?`
    ).get(id)).filter(Boolean);
    const recent = db.prepare(
      `SELECT id, content, date, episode_id, embedding, keywords FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0
       ORDER BY id DESC LIMIT 40`
    ).all(characterId);
    const { scoreTextsAgainst } = require('./embed-helper');
    const corpus = getCharCorpus(characterId);
    for (const a of rows) {
      const others = recent.filter((b) => b.id !== a.id);
      if (!others.length) continue;
      const scores = scoreTextsAgainst(a.content, others, { corpus });
      others.forEach((b, i) => {
        if (a.episode_id && b.episode_id && a.episode_id === b.episode_id) {
          addMemoryLink(characterId, a.id, b.id, 'same_event');
          linked += 1;
          return;
        }
        const s = scores[i] || 0;
        if (s >= 0.55) {
          addMemoryLink(characterId, a.id, b.id, 'same_event');
          linked += 1;
        } else if (s >= 0.35 && a.date !== b.date) {
          addMemoryLink(characterId, a.id, b.id, 'related');
          linked += 1;
        }
      });
    }
  } catch (e) {
    console.warn('[brain] autoLink', e.message);
  }
  return linked;
}

function selectMemoriesForBrain(char, contextText = '', opts = {}) {
  applyHealthSupersession(char.id);
  settlePassedCurrentMemories(char.id, getLocalDateStr(new Date(), getSettings().timezone || 'Asia/Shanghai'));
  try { applyIdentityCorrections(char.id); } catch { /* ignore */ }
  try { resolveCompletedTodos(char.id, { aiContent: contextText }); } catch {}
  try { dedupeOpenTodos(char.id); } catch {}
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const todayStr = getLocalDateStr(new Date(), tz);
  const queryEmb = opts.queryEmb || null;
  const ctx = String(contextText || '').trim();
  const pastAsk = wantsPastLife(ctx);

  let moodValence = 0;
  try {
    const es = typeof char.emotion_state === 'string' ? JSON.parse(char.emotion_state || '{}') : (char.emotion_state || {});
    moodValence = Number(es.mood?.valence) || 0;
  } catch { /* ignore */ }

  const allMem = db.prepare(
    `SELECT * FROM memories WHERE character_id=? AND COALESCE(archived,0)=0 ORDER BY id DESC`
  ).all(char.id);

  const rawFocusEarly = latestFocusText(ctx) || ctx;
  const mutedIds = new Set(getMutedContextIds(char.id));
  const live = allMem.filter((m) => {
    if (mutedIds.has(Number(m.id))) return false;
    const st = String(m.status || 'current');
    if (Number(m.resolved) === 1) return pastAsk;
    if (st === 'historical') {
      if (pastAsk) return true;
      // 过时的药/例假：对方没点名，就不要因为一句「头疼」再捞回来
      if (isMedOrCycleMemory(m) && !HEALTH_MED_CUE_RE.test(rawFocusEarly)) return false;
      return utteranceHitsMemory(m, rawFocusEarly);
    }
    return st !== 'archived';
  });

  // 用户这轮话点到的记忆：涨提及次数（影响以后浮现权重）
  try {
    if (rawFocusEarly && rawFocusEarly.length >= 2) {
      bumpMemoriesHitByUserTalk(char.id, rawFocusEarly, live);
    }
  } catch { /* ignore */ }

  const selected = [];
  const seen = new Set();
  const add = (m) => {
    if (!m || seen.has(m.id)) return;
    seen.add(m.id);
    selected.push(m);
  };

  // 偏好：默认不常驻注入；仅话题命中时由脑海闪回带出
  const prefKnow = CARRY_PREF_KNOW_IN_CHAT
    ? live
      .filter((m) => m.category === '偏好与习惯')
      .sort((a, b) => memorySalience(b) - memorySalience(a))
      .slice(0, PREF_KNOW_SLOTS)
    : [];

  // 到期待办：只有本轮在谈约定/待办或内容对得上才入选，禁止闲聊无条件塞入
  if (TODO_TALK_RE.test(ctx) || hasHardMemoryCue(ctx)) {
    live.filter((m) => m.category === '待办' && Number(m.resolved) !== 1)
      .map((m) => ({ m, due: parseTodoDueDate(m.content) }))
      .filter((x) => x.due && x.due <= todayStr)
      .filter((x) => TODO_TALK_RE.test(ctx) || memoryMatchesContext(x.m, ctx) || distinctiveTermHit(x.m.content, ctx))
      .sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .slice(0, DUE_TODO_SLOTS)
      .forEach(({ m }) => add(m));
  }

  if (ctx) {
    const rawFocus = latestFocusText(ctx) || ctx;
    const focus = expandHealthRetrievalCue(rawFocus);
    const healthCue = HEALTH_MED_CUE_RE.test(rawFocus) || HEALTH_BODY_RE.test(rawFocus);
    const pool = live.filter((m) => !seen.has(m.id));
    // 对方刚提用药/例假/身体：近两天相关条先入选，避免「布洛芬」对不上库里的「止痛药」
    if (healthCue) {
      live.filter((m) => !seen.has(m.id) && isRecentHealthOrMedMemory(m, todayStr))
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, 3)
        .forEach(add);
    }
    let vecScores = [];
    try {
      vecScores = require('./embed-helper').scoreTextsAgainst(focus, pool, {
        queryEmb,
        corpus: getCharCorpus(char.id),
      });
    } catch { vecScores = pool.map(() => 0); }

    const scored = pool
      .map((m, idx) => {
        const vecScore = vecScores[idx] || 0;
        const kwHit = memoryMatchesContext(m, focus);
        const isSched = m.source === 'schedule' || m.source === 'schedule_day';
        const memDay = String(m.date || '').slice(0, 10);
        // 今天刚结束的行程闲聊不闪，避免「做完了」隔几轮再报
        if (isSched && !pastAsk && memDay === todayStr) {
          return { m, score: 0, kwHit: false, vecScore: 0, skip: true };
        }
        if (medMemoryStaleForUtterance(m, todayStr, rawFocus)) {
          return { m, score: 0, kwHit: false, vecScore: 0, skip: true };
        }
        const scheduleBoost = isSched && pastAsk ? 0.2 : 0;
        let score = Math.max(vecScore, kwHit ? 0.38 : 0) + memorySalience(m) * memoryDecayFactor(m, todayStr) * 0.35 + scheduleBoost;
        if (healthCue && isRecentHealthOrMedMemory(m, todayStr)) score += 0.22;
        // 偏好要更贴当前话才闪，避免擦边相关就提「闻味道」之类
        if (m.category === '偏好与习惯') {
          if (!kwHit && vecScore < 0.42) {
            return { m, score: 0, kwHit: false, vecScore, skip: true };
          }
          score *= 0.85;
        }
        if (m.category === '情感状态') {
          const memVal = Number(parseMemoryMeta(m.meta).emotion?.valence);
          if (Number.isFinite(memVal) && ((memVal >= 0 && moodValence >= 0) || (memVal < 0 && moodValence < 0))) {
            score *= 1.15;
          }
        }
        return { m, score, kwHit, vecScore };
      })
      .filter((x) => !x.skip && (x.kwHit || x.vecScore >= VEC_MIN_SCORE || ((x.m.source === 'schedule' || x.m.source === 'schedule_day') && pastAsk && x.score >= 0.2) || (healthCue && isRecentHealthOrMedMemory(x.m, todayStr))))
      .sort((a, b) => b.score - a.score);

    let contextCount = 0;
    for (const { m } of scored) {
      if (contextCount >= 4) break;
      add(m);
      contextCount += 1;
    }
  } else if (pastAsk) {
    live.filter((m) => m.source === 'schedule' || m.source === 'schedule_day')
      .slice(0, 3)
      .forEach(add);
  }

  const episodeIds = new Set(selected.filter((m) => m.episode_id).map((m) => m.episode_id));
  for (const m of live) {
    if (seen.has(m.id)) continue;
    if (m.episode_id && episodeIds.has(m.episode_id)) add(m);
  }

  const expanded = expandByLinks(char.id, selected, live);

  const recentEpisodes = db.prepare(
    `SELECT * FROM memory_episodes WHERE character_id=? ORDER BY id DESC LIMIT 10`
  ).all(char.id);
  let episodeGist = '';
  if (recentEpisodes.length && ctx) {
    const cue = expandHealthRetrievalCue(ctx);
    const matched = recentEpisodes.filter((ep) => {
      const kws = parseKeywords(ep.keywords);
      return kws.some((k) => k.length >= 2 && cue.includes(k))
        || memoryMatchesContext({ content: ep.gist, category: '日常点滴', source: ep.source }, cue)
        || (HEALTH_MED_CUE_RE.test(ctx) && HEALTH_MED_CUE_RE.test(ep.gist || ''));
    });
    const pick = matched.slice(0, 2);
    episodeGist = pick.map((ep) => ep.gist).join('\n');
    expanded._episodeGists = pick.map((ep) => ({ id: ep.id, gist: ep.gist }));
  }

  expanded._episodeGist = episodeGist;
  if (!expanded._episodeGists) expanded._episodeGists = [];
  expanded._prefKnow = prefKnow;
  expanded._healthResolved = live.some((m) => m.fact_key === 'health:transient' && m.status === 'historical')
    && !live.some((m) => m.fact_key === 'health:transient' && String(m.status || 'current') === 'current');

  try {
    const narrativeHelper = require('./memory-narrative-helper');
    expanded._narratives = narrativeHelper.selectNarrativesForPrompt(char.id, ctx);
  } catch {
    expanded._narratives = [];
  }
  return expanded;
}

function stripMemoryDatePrefix(content) {
  return String(content || '')
    .replace(/^\d{4}年\d{1,2}月\d{1,2}日[^，,]{0,10}[，,]?\s*/, '')
    .trim();
}

function getIncidentalFlashChance(char) {
  const n = parseInt(char?.memory_flash_chance, 10);
  // 默认略降：偶然闪回是「可漏可不漏」，不宜太常塞进无关旧事
  if (!Number.isFinite(n)) return 10;
  return Math.max(0, Math.min(100, n));
}

function getLocalHourInTz(tz = 'Asia/Shanghai') {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
}

function buildSenseCueFromParts({ scheduleText = '', locationText = '', homeEnv = '', hour = -1 } = {}) {
  const parts = [];
  const sched = String(scheduleText || '');
  const cur = sched.match(/当前：([^；。]+)/);
  if (cur) parts.push(cur[1].replace(/空闲中（自由安排）/g, '').trim());
  const home = sched.match(/居所：([^（；。]+)/);
  if (home) parts.push(home[1].trim());
  else if (homeEnv) parts.push(String(homeEnv).trim());
  const loc = String(locationText || '');
  const w = loc.match(/小雨|中雨|大雨|暴雨|雪|晴|阴|多云|刮风|降温|闷热|寒冷|炎热|潮湿/);
  if (w) parts.push(w[0]);
  if (hour >= 0) {
    if (hour < 5) parts.push('深夜');
    else if (hour < 8) parts.push('清晨');
    else if (hour < 11) parts.push('上午');
    else if (hour < 14) parts.push('中午');
    else if (hour < 18) parts.push('下午');
    else if (hour < 22) parts.push('晚上');
    else parts.push('夜里');
  }
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function collectSenseCue(char, opts = {}) {
  if (opts.senseCue) return String(opts.senseCue).trim();
  const settings = getSettings();
  let scheduleText = '';
  try {
    const cron = require('./cron');
    const blocks = cron.getSchedulePromptBlocks(char, settings, opts.userMessage || '', {
      recentHistory: opts.recentHistory || [],
    });
    scheduleText = String(blocks.charSchedule || '');
  } catch { /* ignore */ }
  return buildSenseCueFromParts({
    scheduleText,
    locationText: opts.locationBlock || '',
    homeEnv: char.home_environment || '',
    hour: getLocalHourInTz(settings.timezone || char.timezone || 'Asia/Shanghai'),
  });
}

function cueHasAnchor(cue) {
  const t = String(cue || '').replace(/清晨|上午|中午|下午|晚上|夜里|深夜/g, '').trim();
  return t.length >= 4;
}

const _incidentalFlashAt = new Map();

function canAttemptIncidental(charId, cueKey, chance) {
  if (chance <= 0) return false;
  const now = Date.now();
  const prev = _incidentalFlashAt.get(charId);
  if (prev) {
    if (now - prev.ts < 12 * 60 * 1000) return false;
    if (prev.key === cueKey && now - prev.ts < 40 * 60 * 1000) return false;
  }
  return Math.random() * 100 < chance;
}

function markIncidentalUsed(charId, cueKey) {
  _incidentalFlashAt.set(charId, { key: cueKey, ts: Date.now() });
}

function isLongTermMemory(m, todayStr) {
  const day = String(m?.date || m?.created_at || '').slice(0, 10);
  if (day && day < todayStr) return true;
  return ['重要时刻', '秘密/心事', '约定'].includes(m?.category);
}

function isFreshStamp(ts) {
  const t = parseMessageTime(ts);
  return Number.isFinite(t) && (Date.now() - t) < 3 * 3600 * 1000;
}

function pickIncidentalFlash(char, cue, opts = {}) {
  const settings = getSettings();
  const tz = settings.timezone || char.timezone || 'Asia/Shanghai';
  const todayStr = getLocalDateStr(new Date(), tz);
  const chance = getIncidentalFlashChance(char);
  const cueKey = String(cue || '').slice(0, 32);
  if (!cueHasAnchor(cue) || !canAttemptIncidental(char.id, cueKey, chance)) return null;

  const skipIds = new Set(opts.skipMemoryIds || []);
  const skipNarr = new Set(opts.skipNarrativeIds || []);
  const chatCtx = String(opts.contextText || '');
  const candidates = [];

  const allMem = db.prepare(
    `SELECT * FROM memories WHERE character_id=? AND COALESCE(archived,0)=0 ORDER BY id DESC LIMIT 200`
  ).all(char.id);
  const { scoreTextsAgainst } = require('./embed-helper');
  const corpus = getCharCorpus(char.id);
  let memVecs = [];
  try { memVecs = scoreTextsAgainst(cue, allMem, { corpus }); } catch { memVecs = allMem.map(() => 0); }

  allMem.forEach((m, mi) => {
    if (skipIds.has(m.id)) return;
    const st = String(m.status || 'current');
    if (st === 'historical' || st === 'archived') return;
    if (!isLongTermMemory(m, todayStr)) return;
    if (chatCtx && distinctiveTermHit(m.content, chatCtx)) return;
    const vec = memVecs[mi] || 0;
    const kw = distinctiveTermHit(m.content, cue);
    if (!kw && vec < 0.30) return;
    candidates.push({
      kind: 'mem',
      m,
      score: Math.max(vec, kw ? 0.40 : 0) + memorySalience(m) * 0.2,
    });
  });

  try {
    const narrs = require('./memory-narrative-helper').listActiveNarratives(char.id);
    const tree = require('./memory-tree-helper');
    const usable = narrs.filter((n) => !skipNarr.has(n.id) && !tree.isFallen(n)
      && !(isFreshStamp(n.created_at) && isFreshStamp(n.content_updated_at || n.created_at)));
    const blobs = usable.map((n) => ({
      content: `${n.title || ''} ${n.stance || ''} ${String(n.content || '').slice(0, 220)}`,
      embedding: n.embedding,
    }));
    const narrVecs = scoreTextsAgainst(cue, blobs, { corpus });
    usable.forEach((n, i) => {
      const blob = blobs[i].content;
      if (chatCtx && distinctiveTermHit(blob, chatCtx)) return;
      const vec = narrVecs[i] || 0;
      const kw = distinctiveTermHit(blob, cue);
      if (!kw && vec < 0.30) return;
      candidates.push({ kind: 'narr', n, score: Math.max(vec, kw ? 0.42 : 0) });
    });
  } catch { /* ignore */ }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.30) return null;
  markIncidentalUsed(char.id, cueKey);

  if (best.kind === 'mem') {
    return {
      cue,
      line: toMindFlashLine(best.m, todayStr, char.name, settings.username || '旅人'),
    };
  }
  const title = String(best.n.title || '').trim();
  const stance = String(best.n.stance || best.n.content || '').replace(/\s+/g, ' ').trim().slice(0, 72);
  return { cue, line: [title, stance].filter(Boolean).join(' · ').slice(0, 90) };
}

/** 脑海人称：存稿「我」=角色、用户=对方；旧稿第三人称角色名→「你」。禁止用「自己」——模型会把对方的「自己」读成角色。 */
function bindFlashPersons(text, charName, username) {
  let body = String(text || '');
  if (!body) return '';
  const user = username || '旅人';
  // 旧第三人称存稿：角色名 → 你（聊天系统里你=角色）
  if (charName) body = body.split(charName).join('你');
  if (user) body = body.split(user).join('对方');
  body = body.replace(/用户/g, '对方');
  // 新第一人称存稿保留「我」——【脑海】是心里闪过的私货，第一人称更贴；不要把「我」改成「你」以免和旧稿搅在一起
  body = body.replace(/对方(.{0,8})自己/g, '对方$1TA');
  body = body.replace(/第三人称客观叙述[：:]?/g, '');
  body = body.replace(/人称·硬性[：:]?/g, '');
  return body;
}

function toMindFlashLine(mem, todayStr, charName, username) {
  let body = bindFlashPersons(stripMemoryDatePrefix(mem.content || mem.gist || ''), charName, username);
  if (!body) return '';
  const cat = String(mem.category || '');
  // 偏好/关系/心事是「一直知道」的事，不要加「三天前」——加了就像在念日记
  const ongoing = cat === '偏好与习惯' || cat === '人物关系' || cat === '秘密/心事'
    || cat === '待办' || cat === '约定';
  if (ongoing) return body.replace(/\s+/g, ' ').slice(0, 90);
  const when = relativeDayLabel(String(mem.date || '').slice(0, 10), todayStr);
  const line = when && when !== '今天' ? `${when}，${body}` : body;
  return line.replace(/\s+/g, ' ').slice(0, 90);
}

/** 闪回：系统筛出 → 心里当背景 → 心里草稿再决定说不说 */
function flashExpressionHint(custom) {
  if (custom) return String(custom);
  try {
    return require('./memory-gate-helper').MEMORY_USAGE_HINT;
  } catch {
    return `对方点到的旧事要能接上，别装不记得；别念「你说过…」，别编没写到的。`;
  }
}

function recentFlashMap(charId) {
  let m = _recentMindFlashAt.get(Number(charId));
  if (!m) {
    m = new Map();
    _recentMindFlashAt.set(Number(charId), m);
  }
  return m;
}

function wasRecentlyFlashed(charId, memId) {
  const ts = recentFlashMap(charId).get(Number(memId));
  if (!ts) return false;
  return Date.now() - ts < FLASH_REPEAT_COOLDOWN_MS;
}

function collectFlashCandidates(char, selected, opts = {}) {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const todayStr = getLocalDateStr(new Date(), tz);
  const username = settings.username || '旅人';
  const ctx = String(opts.contextText || '');
  const rawFocus = latestFocusText(ctx) || ctx;
  const focus = expandHealthRetrievalCue(rawFocus);
  const healthCue = HEALTH_MED_CUE_RE.test(rawFocus) || HEALTH_BODY_RE.test(rawFocus);
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const text = String(item.text || '').trim();
    if (!text || text.length < 4) return;
    try {
      if (require('./world-lock-helper').isCrossWorldMeetupTalk(text)) return;
    } catch { /* ignore */ }
    const key = text.slice(0, 24);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...item, text });
  };

  let continueIds = opts.continueClusterIds;
  if (!(continueIds instanceof Set)) {
    try { continueIds = require('./memory-gate-helper').lastSpokenClusters(char.id); }
    catch { continueIds = new Set(); }
  }
  const memCluster = assignMemoryClusters(selected, selected?._narratives || []);
  const mems = [...(selected || [])].filter((m) => m && m.content);
  let vecScores = [];
  try {
    if (focus && mems.length) {
      vecScores = require('./embed-helper').scoreTextsAgainst(focus, mems, {
        corpus: getCharCorpus(char.id),
      });
    }
  } catch { vecScores = mems.map(() => 0); }

  // 硬伤：原先只按 salience 排序，高权重旧事会把当下相关（例假/布洛芬）挤出【脑海】
  const ranked = mems
    .map((m, idx) => {
      const vecScore = vecScores[idx] || 0;
      const kwHit = memoryMatchesContext(m, focus) || distinctiveTermHit(m.content, focus);
      const healthHit = healthCue && isRecentHealthOrMedMemory(m, todayStr);
      let score = Math.max(vecScore, kwHit ? 0.42 : 0) + memorySalience(m) * memoryDecayFactor(m, todayStr) * 0.2;
      if (healthHit) score += 0.55;
      if (kwHit) score += 0.15;
      return { m, score, kwHit, healthHit, vecScore };
    })
    .sort((a, b) => b.score - a.score);

  // 本轮在谈身体/药：只钉近两天、或对方这句确实点到的那条。不要见「头疼」就翻出旧药。
  if (healthCue) {
    const pinned = ranked.find((x) => x.healthHit)
      || ranked.find((x) => x.kwHit && isMedOrCycleMemory(x.m) && utteranceHitsMemory(x.m, rawFocus));
    if (pinned) {
      const strongEnough = pinned.kwHit || pinned.vecScore >= 0.3 || pinned.healthHit;
      if (strongEnough || !wasRecentlyFlashed(char.id, pinned.m.id)) {
        const line = toMindFlashLine(pinned.m, todayStr, char.name, username);
        if (line) {
          push({
            key: `mem:${pinned.m.id}`,
            id: pinned.m.id,
            block: '脑海',
            kind: 'memory',
            clusterId: memCluster.get(Number(pinned.m.id)) || `mem:${pinned.m.id}`,
            text: line,
            score: pinned.score + 1,
            vecScore: pinned.vecScore || 0,
            kwHit: !!pinned.kwHit,
          });
        }
      }
    }
  }

  const seedCid = ranked[0]
    ? (memCluster.get(Number(ranked[0].m.id)) || `mem:${ranked[0].m.id}`)
    : '';
  const rankedByCluster = seedCid
    ? [...ranked.filter((x) => (memCluster.get(Number(x.m.id)) || `mem:${x.m.id}`) === seedCid),
      ...ranked.filter((x) => (memCluster.get(Number(x.m.id)) || `mem:${x.m.id}`) !== seedCid)]
    : ranked;

  const episodes = Array.isArray(selected?._episodeGists) && selected._episodeGists.length
    ? selected._episodeGists
    : String(selected?._episodeGist || '').split('\n').filter(Boolean).map((gist, i) => ({ id: `g${i}`, gist }));
  for (const ep of episodes) {
    const gist = String(ep.gist || '');
    if (healthCue && !HEALTH_MED_CUE_RE.test(gist) && !HEALTH_BODY_RE.test(gist) && !/肚子疼|肚子/.test(gist)) {
      continue;
    }
    const epCid = `ep:${ep.id}`;
    if (seedCid.startsWith('ep:') && seedCid !== epCid) continue;
    if (seedCid.startsWith('narr:')) {
      const uses = mems.some((m) => (memCluster.get(Number(m.id)) === seedCid)
        && String(m.episode_id) === String(ep.id));
      if (!uses) continue;
    }
    const line = bindFlashPersons(stripMemoryDatePrefix(gist), char.name, username);
    if (!line) continue;
    push({
      key: epCid,
      id: ep.id,
      block: '脑海',
      kind: 'episode',
      clusterId: epCid,
      text: line.slice(0, 90),
      score: 1.0,
      vecScore: 0.55,
      kwHit: true,
    });
  }

  for (const { m, score, kwHit, vecScore } of rankedByCluster) {
    if (out.length >= FLASH_CANDIDATE_CAP) break;
    if (medMemoryStaleForUtterance(m, todayStr, rawFocus)) continue;
    const cid = memCluster.get(Number(m.id)) || `mem:${m.id}`;
    if (wasRecentlyFlashed(char.id, m.id) && !continueIds.has(cid)) {
      const strong = distinctiveTermHit(m.content, ctx) || memoryMatchesContext(m, ctx) || vecScore >= 0.4;
      if (!strong) continue;
    }
    const line = toMindFlashLine(m, todayStr, char.name, username);
    if (!line) continue;
    push({
      key: `mem:${m.id}`,
      id: m.id,
      block: '脑海',
      kind: 'memory',
      clusterId: cid,
      text: line,
      score,
      vecScore: vecScore || 0,
      kwHit: !!kwHit,
    });
  }
  return out.slice(0, FLASH_CANDIDATE_CAP);
}

function markFlashed(charId, memIds) {
  const map = recentFlashMap(charId);
  const now = Date.now();
  for (const id of memIds || []) {
    if (id != null) map.set(Number(id), now);
  }
  // 顺手清过期，避免无限涨
  for (const [id, ts] of map) {
    if (now - ts > FLASH_REPEAT_COOLDOWN_MS * 3) map.delete(id);
  }
}

/**
 * 短期记忆：只在这一轮用得上时才注入今天的碎片。
 * 刚聊过的内容已经在对话窗口里；把当天全部碎片每轮再贴一遍，等于把早上的吐槽整天吊着。
 */
function formatShortTermBlock(charId, todayStr, charName, username, contextText = '') {
  const ctx = String(contextText || '').trim();
  if (!ctx) return { text: '', keys: [] };
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, category, content, date, created_at FROM memories
       WHERE character_id=? AND date=? AND COALESCE(archived,0)=0
         AND COALESCE(status,'current')!='historical'
       ORDER BY id ASC LIMIT 12`
    ).all(charId, todayStr);
  } catch { return { text: '', keys: [] }; }
  if (rows.length < 2) return { text: '', keys: [] };

  const recapToday = /今天.{0,10}(聊|说|干了|发生)|早上.{0,8}(说|聊)|还记得今天|今天都/.test(ctx);
  let picked = rows;
  if (!recapToday) {
    try {
      const eh = require('./embed-helper');
      const focus = latestFocusText(ctx) || ctx;
      const scores = eh.scoreTextsAgainst(focus, rows, { corpus: getCharCorpus(charId) });
      const top = Math.max(0, ...scores);
      picked = rows.filter((_, i) => eh.passRelevance(scores[i] || 0, top, { floor: 0.45 }));
    } catch {
      picked = [];
    }
  }
  if (!picked.length) return { text: '', keys: [] };

  const lines = [];
  const keys = [];
  const seen = new Set();
  for (const m of picked.slice(0, recapToday ? 6 : 3)) {
    const body = bindFlashPersons(stripMemoryDatePrefix(m.content || ''), charName, username);
    if (!body) continue;
    try {
      if (require('./world-lock-helper').isCrossWorldMeetupTalk(body)) continue;
    } catch { /* ignore */ }
    const key = body.slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    const time = extractMemoryTime(m) || String(m.created_at || '').slice(11, 16);
    lines.push(`· ${time ? `${time} ` : ''}${body.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  if (!lines.length) return { text: '', keys: [] };
  return {
    text: `【今天】${lines.join('\n')}`,
    keys,
  };
}

function compactNarrativeGist(n, charName, username) {
  const title = String(n?.title || n?.stance || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const body = bindFlashPersons(stripMemoryDatePrefix(String(n?.content || '')), charName, username)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (title && body && !body.startsWith(title)) return `${title}：${body}`;
  return body || title;
}

function formatMindFlashBlock(char, selected, opts = {}) {
  const settings = getSettings();
  const tz = settings.timezone || 'Asia/Shanghai';
  const todayStr = getLocalDateStr(new Date(), tz);
  const username = settings.username || '旅人';
  const flashes = [];
  const bgFlashes = [];
  const flashedIds = [];
  const seen = new Set();
  const sayHint = flashExpressionHint(opts.memoryUsageHint);
  const clusterCarry = opts.clusterCarry !== false;
  const eventsMax = Number.isFinite(Number(opts.maxSpeakFlashes))
    ? Math.max(0, Number(opts.maxSpeakFlashes))
    : FLASH_MAX;
  const detailMax = Number.isFinite(Number(opts.clusterDetailMax))
    ? Math.max(0, Number(opts.clusterDetailMax))
    : CLUSTER_DETAIL_MAX;
  const maxSpeak = clusterCarry ? Math.max(eventsMax, eventsMax * (1 + detailMax)) : eventsMax;
  const pushFlash = (text, into) => {
    const t = String(text || '').trim();
    if (!t || t.length < 4) return false;
    try {
      if (require('./world-lock-helper').isCrossWorldMeetupTalk(t)) return false;
    } catch { /* ignore */ }
    const key = t.slice(0, 24);
    if (seen.has(key)) return false;
    seen.add(key);
    into.push(t);
    return true;
  };

  // 当天碎片交给【今天】那块按顺序讲；这里先占位，免得【脑海】把同样的话再闪一遍
  let shortTerm = { text: '', keys: [] };
  try {
    shortTerm = formatShortTermBlock(char.id, todayStr, char.name, username, opts.contextText || '');
  } catch { /* ignore */ }
  shortTerm.keys.forEach((k) => seen.add(k));

  let narrs = selected._narratives || [];
  const usableNarrativeIds = opts.usableNarrativeIds instanceof Set ? opts.usableNarrativeIds : null;
  const backgroundNarrativeIds = opts.backgroundNarrativeIds instanceof Set ? opts.backgroundNarrativeIds : null;
  if (usableNarrativeIds || backgroundNarrativeIds) {
    narrs = narrs.filter((n) => {
      const id = n.id;
      if (usableNarrativeIds && (usableNarrativeIds.has(id) || usableNarrativeIds.has(String(id)))) return true;
      if (backgroundNarrativeIds && (backgroundNarrativeIds.has(id) || backgroundNarrativeIds.has(String(id)))) return true;
      return false;
    });
  }
  const narrSpeak = usableNarrativeIds
    ? narrs.filter((n) => usableNarrativeIds.has(n.id) || usableNarrativeIds.has(String(n.id)))
    : (clusterCarry ? (narrs || []).slice(0, eventsMax) : narrs);
  const narrBg = backgroundNarrativeIds
    ? narrs.filter((n) => backgroundNarrativeIds.has(n.id) || backgroundNarrativeIds.has(String(n.id)))
    : [];
  let narrativeBlock = '';
  if (narrSpeak.length && !clusterCarry) {
    try {
      narrativeBlock = require('./memory-narrative-helper').formatNarrativeInjection(
        narrSpeak,
        opts.contextText || '',
      );
    } catch { /* ignore */ }
  }

  const usableFlashKeys = opts.usableFlashKeys instanceof Set ? opts.usableFlashKeys : null;
  const backgroundFlashKeys = opts.backgroundFlashKeys instanceof Set ? opts.backgroundFlashKeys : null;
  const flashCandidates = collectFlashCandidates(char, selected, opts);

  if (clusterCarry && narrSpeak.length) {
    for (const n of narrSpeak.slice(0, eventsMax)) {
      const gist = compactNarrativeGist(n, char.name, username);
      if (gist) pushFlash(gist, flashes);
    }
  }

  const takeFlash = (c, into, cap) => {
    if (into.length >= cap) return false;
    if (!pushFlash(c.text, into)) return false;
    if (c.kind === 'memory' && c.id != null && Number.isFinite(Number(c.id))) flashedIds.push(c.id);
    return true;
  };

  const seedCid = flashCandidates.find((c) => c.clusterId)?.clusterId
    || (narrSpeak[0] ? `narr:${narrSpeak[0].id}` : '');
  const sameCluster = (c) => !seedCid || !c.clusterId || c.clusterId === seedCid
    || (narrSpeak[0] && c.clusterId === `narr:${narrSpeak[0].id}`);

  if (usableFlashKeys) {
    const gists = flashCandidates.filter((c) => usableFlashKeys.has(c.key) && c.kind === 'episode' && sameCluster(c));
    const details = flashCandidates.filter((c) => usableFlashKeys.has(c.key) && c.kind === 'memory' && sameCluster(c));
    for (const c of gists) takeFlash(c, flashes, maxSpeak);
    let detailCount = 0;
    for (const c of details) {
      if (detailCount >= detailMax) break;
      if (takeFlash(c, flashes, maxSpeak)) detailCount += 1;
    }
    for (const c of flashCandidates) {
      if (usableFlashKeys.has(c.key)) continue;
      if (backgroundFlashKeys && backgroundFlashKeys.has(c.key) && bgFlashes.length < 2) {
        pushFlash(c.text, bgFlashes);
      }
    }
  } else {
    const gists = flashCandidates.filter((c) => c.kind === 'episode' && sameCluster(c));
    const details = flashCandidates.filter((c) => c.kind === 'memory' && sameCluster(c));
    for (const c of gists) takeFlash(c, flashes, maxSpeak);
    let detailCount = 0;
    for (const c of details) {
      if (detailCount >= detailMax) break;
      if (takeFlash(c, flashes, maxSpeak)) detailCount += 1;
    }
  }
  if (flashedIds.length) markFlashed(char.id, flashedIds);

  let prefKnowPart = '';
  const prefKnow = Array.isArray(selected._prefKnow) ? selected._prefKnow : [];
  if (prefKnow.length) {
    const lines = [];
    const flashBodies = new Set([...flashes, ...bgFlashes].map((f) => f.slice(0, 20)));
    for (const m of prefKnow) {
      const line = bindFlashPersons(stripMemoryDatePrefix(m.content || ''), char.name, username)
        .replace(/\s+/g, ' ')
        .slice(0, 72);
      if (!line || line.length < 4) continue;
      if (flashBodies.has(line.slice(0, 20))) continue;
      lines.push(`· ${line}`);
    }
    if (lines.length) {
      prefKnowPart = `【对方偏好·默记】心里知道即可，用来调整语气/态度。对方本轮没在说这件事时，不要主动点名翻出来；禁止「你说过喜欢…」念稿，禁止反复提亲密细节。
${lines.join('\n')}`;
    }
  }

  // 潜意识：可影响语气，禁止明说
  if (narrBg.length) {
    try {
      const soft = narrBg.map((n) => {
        const t = String(n.stance || n.title || n.content || '').replace(/\s+/g, ' ').slice(0, 48);
        return t ? `· ${t}` : '';
      }).filter(Boolean);
      if (soft.length) bgFlashes.push(...soft.map((s) => s.replace(/^·\s*/, '')));
    } catch { /* ignore */ }
  }

  let bgPart = '';
  if (bgFlashes.length) {
    bgPart = `【心里有数】隐约记得这些，只影响语气和态度，这轮不要主动提起或点名翻旧账。
${bgFlashes.map((f) => `· ${f}`).join('\n')}`;
  }

  let flashPart = '';
  if (flashes.length) {
    flashPart = `【脑海】对方这轮话勾起的旧事（系统已筛过）：
${flashes.map((f) => `· ${f}`).join('\n')}`;
    if (selected._healthResolved) {
      flashPart += '\n【身体】对方说过已经没事了；除非这轮又主动提身体不舒服，否则不要再问还难受吗。';
    }
  }

  let incidentalPart = '';
  if (selected._incidental?.line) {
    try {
      if (require('./world-lock-helper').isCrossWorldMeetupTalk(selected._incidental.line)) {
        selected._incidental = null;
      }
    } catch { /* ignore */ }
  }
  if (selected._incidental?.line) {
    const cue = String(selected._incidental.cue || '眼前这件事').slice(0, 32);
    incidentalPart = `【偶然闪回】不是对方提起的。你在「${cue}」时心里轻轻掠过：
· ${selected._incidental.line}
可提可不提：真的顺口才漏半句，不要求嵌进；禁止「忽然想起」开场、禁止当主线、禁止复读原文，也别跟【对方偏好·默记】连着翻。`;
  }

  const shortTermPart = shortTerm.text;
  if (!narrativeBlock && !flashPart && !incidentalPart && !shortTermPart && !prefKnowPart && !bgPart) return '';
  const parts = [shortTermPart, prefKnowPart, bgPart, narrativeBlock, flashPart, incidentalPart].filter(Boolean);
  if (flashPart || incidentalPart || prefKnowPart || narrativeBlock || bgPart) parts.push(sayHint);
  return parts.join('\n\n');
}

function attachIncidentalFlash(char, selected, contextText, opts = {}) {
  if (!CARRY_INCIDENTAL_FLASH) {
    selected._incidental = null;
    return selected;
  }
  try {
    const cue = collectSenseCue(char, { ...opts, contextText });
    selected._incidental = pickIncidentalFlash(char, cue, {
      contextText,
      skipMemoryIds: (selected || []).map((m) => m.id),
      skipNarrativeIds: (selected._narratives || []).map((n) => n.id),
    });
  } catch {
    selected._incidental = null;
  }
  return selected;
}

function formatMindFlashForPrompt(char, contextText = '', opts = {}) {
  try {
    if (require('./lived-day-helper').shouldSkipChatMemoryCarry()) return '';
  } catch { /* ignore */ }
  const parts = [];
  try {
    const lived = require('./lived-day-helper').formatForPrompt(char, opts.userMessage || contextText);
    if (lived) parts.push(lived);
  } catch (e) {
    console.warn('[lived-day] prompt', e.message);
  }
  const ctx = String(contextText || opts.userMessage || '').trim();
  if (!shouldRetrieveMemoriesForChat(char, ctx)) {
    return parts.filter(Boolean).join('\n\n');
  }
  try {
    const selected = selectMemoriesForBrain(char, contextText, opts);
    attachIncidentalFlash(char, selected, contextText, opts);
    const flash = formatMindFlashBlock(char, selected, { ...opts, contextText });
    if (flash) parts.push(flash);
  } catch (e) {
    console.warn('[brain] mind flash', e.message);
  }
  return parts.filter(Boolean).join('\n\n');
}

async function prepareMindFlashForPromptAsync(char, contextText = '', opts = {}) {
  const ctx = String(contextText || opts.userMessage || '').trim();
  if (!shouldRetrieveMemoriesForChat(char, ctx)) {
    return { selected: Object.assign([], { _narratives: [], _prefKnow: [], _incidental: null }), flashCandidates: [], narratives: [] };
  }
  let continueIds = new Set();
  let forceNarrIds = [];
  try {
    const gate = require('./memory-gate-helper');
    continueIds = gate.lastSpokenClusters(char.id);
    forceNarrIds = [...continueIds]
      .filter((k) => String(k).startsWith('narr:'))
      .map((k) => Number(String(k).slice(5)))
      .filter(Boolean);
  } catch { /* ignore */ }
  let queryEmb = null;
  const focus = latestFocusText(contextText) || contextText;
  try {
    queryEmb = await require('./embed-helper').embedText(focus || '', getSettings());
  } catch { /* lexical */ }
  const selected = selectMemoriesForBrain(char, contextText, { ...opts, queryEmb });
  try {
    const narrativeHelper = require('./memory-narrative-helper');
    selected._narratives = await narrativeHelper.selectNarrativesForPromptAsync(char.id, focus || contextText, {
      forceIds: forceNarrIds,
    });
  } catch { /* keep sync */ }
  attachIncidentalFlash(char, selected, contextText, opts);
  const flashCandidates = collectFlashCandidates(char, selected, {
    ...opts,
    contextText,
    continueClusterIds: continueIds,
  });
  const clusterByKey = buildClusterKeyMap(flashCandidates, selected._narratives || [], selected);
  return {
    selected,
    flashCandidates,
    narratives: selected._narratives || [],
    clusterByKey,
  };
}

async function formatMindFlashForPromptAsync(char, contextText = '', opts = {}) {
  try {
    if (require('./lived-day-helper').shouldSkipChatMemoryCarry()) return '';
  } catch { /* ignore */ }
  const parts = [];
  try {
    const lived = require('./lived-day-helper').formatForPrompt(char, opts.userMessage || contextText);
    if (lived) parts.push(lived);
  } catch (e) {
    console.warn('[lived-day] prompt async', e.message);
  }
  const ctx = String(contextText || opts.userMessage || '').trim();
  if (!shouldRetrieveMemoriesForChat(char, ctx)) {
    return parts.filter(Boolean).join('\n\n');
  }
  try {
    const prepared = await prepareMindFlashForPromptAsync(char, contextText, opts);
    const flash = formatMindFlashBlock(char, prepared.selected, { ...opts, contextText });
    if (flash) parts.push(flash);
  } catch (e) {
    console.warn('[brain] mind flash async', e.message);
    try {
      const selected = selectMemoriesForBrain(char, contextText, opts);
      attachIncidentalFlash(char, selected, contextText, opts);
      const flash = formatMindFlashBlock(char, selected, { ...opts, contextText });
      if (flash) parts.push(flash);
    } catch { /* ignore */ }
  }
  return parts.filter(Boolean).join('\n\n');
}

const CONTEXT_PIN_KEY = 'brain_context_pins';
const CONTEXT_PIN_MAX = 8;

function loadContextPinMap() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(CONTEXT_PIN_KEY);
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveContextPinMap(map) {
  const json = JSON.stringify(map || {});
  try {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(CONTEXT_PIN_KEY, json);
  } catch (e) {
    try {
      const exists = db.prepare('SELECT key FROM settings WHERE key=?').get(CONTEXT_PIN_KEY);
      if (exists) db.prepare('UPDATE settings SET value=? WHERE key=?').run(json, CONTEXT_PIN_KEY);
      else db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').run(CONTEXT_PIN_KEY, json);
    } catch (e2) {
      console.warn('[brain] context pins save', e2.message);
    }
  }
}

function blankHang() {
  return { forced: [], muted: [] };
}

function readHang(charId) {
  const raw = loadContextPinMap()[String(charId)];
  if (Array.isArray(raw)) return { forced: raw.map(Number).filter((n) => n > 0), muted: [] };
  if (!raw || typeof raw !== 'object') return blankHang();
  const forced = [...new Set((raw.forced || []).map(Number).filter((n) => n > 0))].slice(0, CONTEXT_PIN_MAX);
  const muted = [...new Set((raw.muted || []).map(Number).filter((n) => n > 0))];
  return { forced, muted: muted.filter((id) => !forced.includes(id)) };
}

function writeHang(charId, hang) {
  const map = loadContextPinMap();
  const forced = [...new Set((hang.forced || []).map(Number).filter((n) => n > 0))].slice(0, CONTEXT_PIN_MAX);
  const muted = [...new Set((hang.muted || []).map(Number).filter((n) => n > 0 && !forced.includes(n)))];
  map[String(charId)] = { forced, muted };
  saveContextPinMap(map);
  return readHang(charId);
}

function pinRow(r, hang) {
  return {
    id: r.id,
    category: r.category || '',
    date: r.date || '',
    status: r.status || 'current',
    hang,
    content: String(r.content || '').replace(/\s+/g, ' ').trim(),
  };
}

function rowsByIds(charId, ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, category, date, status, content FROM memories
     WHERE character_id=? AND id IN (${ph}) AND COALESCE(archived,0)=0`
  ).all(Number(charId), ...ids);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function standingContextRows(charId) {
  return db.prepare(
    `SELECT id, category, date, status, content FROM memories
     WHERE character_id=? AND COALESCE(archived,0)=0
       AND COALESCE(resolved,0)=0
       AND COALESCE(status,'current')='current'
       AND category IN ('约定','重要时刻')
     ORDER BY CASE category WHEN '重要时刻' THEN 0 ELSE 1 END, id DESC`
  ).all(Number(charId));
}

function getMutedContextIds(charId) {
  return readHang(charId).muted;
}

function getContextHang(charId) {
  const hang = readHang(charId);
  const muted = new Set(hang.muted);
  const forcedIds = new Set(hang.forced);
  const every = rowsByIds(charId, hang.forced).map((r) => pinRow(r, 'every'));
  const relevant = standingContextRows(charId)
    .filter((r) => !muted.has(Number(r.id)) && !forcedIds.has(Number(r.id)))
    .map((r) => pinRow(r, 'relevant'));
  return { every, relevant, maxEvery: CONTEXT_PIN_MAX };
}

function listContextPins(charId) {
  return getContextHang(charId).every;
}

function mutateContextPins(charId, action, id, replaceId) {
  const hang = readHang(charId);
  const mid = Number(id);
  const rid = Number(replaceId);
  if (action === 'remove') {
    if (hang.forced.includes(mid)) hang.forced = hang.forced.filter((x) => x !== mid);
    else if (!hang.muted.includes(mid)) hang.muted.push(mid);
    writeHang(charId, hang);
    return getContextHang(charId);
  }
  if (action === 'replace') {
    if (!rid) return getContextHang(charId);
    hang.forced = hang.forced.filter((x) => x !== mid);
    if (!hang.muted.includes(mid)) hang.muted.push(mid);
    hang.muted = hang.muted.filter((x) => x !== rid);
    if (!hang.forced.includes(rid)) {
      if (hang.forced.length >= CONTEXT_PIN_MAX) {
        const err = new Error(`每轮最多挂 ${CONTEXT_PIN_MAX} 条`);
        err.code = 'PIN_FULL';
        throw err;
      }
      hang.forced.push(rid);
    }
    writeHang(charId, hang);
    return getContextHang(charId);
  }
  if (action === 'add') {
    if (hang.forced.includes(mid)) return getContextHang(charId);
    if (hang.forced.length >= CONTEXT_PIN_MAX) {
      const err = new Error(`每轮最多挂 ${CONTEXT_PIN_MAX} 条`);
      err.code = 'PIN_FULL';
      throw err;
    }
    hang.muted = hang.muted.filter((x) => x !== mid);
    hang.forced.push(mid);
    writeHang(charId, hang);
    return getContextHang(charId);
  }
  return getContextHang(charId);
}

function searchContextPinCandidates(charId, q, limit = 30) {
  const n = Math.min(40, Math.max(1, Number(limit) || 30));
  const query = String(q || '').replace(/[%_]/g, '').trim().slice(0, 40);
  const hang = readHang(charId);
  const pinned = new Set(hang.forced);
  const rows = query
    ? db.prepare(
      `SELECT id, category, date, status, content FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0 AND content LIKE ?
       ORDER BY id DESC LIMIT ?`
    ).all(Number(charId), `%${query}%`, n)
    : db.prepare(
      `SELECT id, category, date, status, content FROM memories
       WHERE character_id=? AND COALESCE(archived,0)=0
       ORDER BY id DESC LIMIT ?`
    ).all(Number(charId), n);
  return rows.map((r) => pinRow(r, pinned.has(Number(r.id)) ? 'every' : '')).map((r) => ({
    ...r,
    pinned: pinned.has(Number(r.id)),
  }));
}

function formatContextPinsForPrompt(charId) {
  const pins = listContextPins(charId);
  if (!pins.length) return '';
  const lines = pins.map((p) => `· [${p.category || '记忆'}] ${p.content.slice(0, 180)}`);
  return `【挂在心上】下面几条是特意留在心上的，不是刚发生的事。聊到相关时可以自然带着，不要逐条复述，也不要说成此刻正在发生。没写在这里的旧约定和旧时刻，不要当成一直挂在嘴边。\n${lines.join('\n')}`;
}

function getBrainNow(charId) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return null;
  const settings = getSettings();
  const rounds = getChatContextRounds(char, settings);
  const history = loadChatContextHistory(charId, 0, rounds);
  const userTurns = history.filter(isUserRound).length;
  let schedule = '';
  try {
    const cron = require('./cron');
    const blocks = cron.getSchedulePromptBlocks(char, settings, '', { recentHistory: history });
    schedule = String(blocks.charSchedule || '').replace(/^【此刻·[^\n]+】\s*/, '').trim();
  } catch { /* ignore */ }
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const todayMem = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE character_id=? AND date=? AND COALESCE(archived,0)=0`
  ).get(charId, today)?.n || 0;
  let affection = null;
  try {
    affection = require('./affection-helper').getBrainAffection(charId);
  } catch { /* ignore */ }
  return {
    rounds,
    windowMessages: history.length,
    windowUserTurns: userTurns,
    today,
    todayMemories: todayMem,
    schedule,
    affection,
    preview: history.slice(-6).map((m) => ({
      role: m.role,
      type: m.type || 'text',
      text: String(m.content || '').replace(/\s+/g, ' ').slice(0, 80),
    })),
    contextHang: getContextHang(charId),
  };
}

function memDay(m) {
  return String(m?.date || m?.created_at || '').slice(0, 10);
}

function sortByDay(rows) {
  return [...(rows || [])].sort((a, b) => {
    const da = memDay(a);
    const db = memDay(b);
    if (da !== db) return da.localeCompare(db);
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
}

function dateSpanOf(rows) {
  const days = sortByDay(rows).map(memDay).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!days.length) return { dateFrom: '', dateTo: '', label: '' };
  const dateFrom = days[0];
  const dateTo = days[days.length - 1];
  return {
    dateFrom,
    dateTo,
    label: dateFrom === dateTo ? dateFrom : `${dateFrom} → ${dateTo}`,
  };
}

function parseLinkedIds(raw) {
  if (Array.isArray(raw)) return raw.map(Number).filter((n) => Number.isFinite(n));
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function inferMoodLabel(valence, label) {
  try {
    const eh = require('./emotion-helper');
    if (label && eh.witherChargeForPrimary(label) > 0) return eh.officialMoodZh(label);
  } catch { /* ignore */ }
  const v = Number(valence);
  if (!Number.isFinite(v)) return '';
  if (v >= 0.45) return '开心';
  if (v >= 0.15) return '暖洋洋';
  if (v <= -0.45) return '有点低落';
  if (v <= -0.15) return '别扭';
  return '平静';
}

function extractMemoryTime(mOrCreatedAt, maybeMeta) {
  // 兼容旧调用 extractMemoryTime(createdAt) 与新调用 extractMemoryTime(memoryRow)
  let createdAt = mOrCreatedAt;
  let meta = maybeMeta;
  if (mOrCreatedAt && typeof mOrCreatedAt === 'object') {
    createdAt = mOrCreatedAt.created_at;
    meta = parseMemoryMeta(mOrCreatedAt.meta);
    // 优先：对话发生时刻（总结写入时存进 meta.event_at）
    const eventAt = String(meta.event_at || '').trim();
    const hmFromEvent = eventAt.match(/(?:T|\s)(\d{2}):(\d{2})/);
    if (hmFromEvent) return `${hmFromEvent[1]}:${hmFromEvent[2]}`;
    // 次选：正文里的时段词（旧碎片没有 event_at）
    const slot = String(mOrCreatedAt.content || '').match(
      /^\d{4}年\d{1,2}月\d{1,2}日(清晨|上午|中午|下午|晚上|夜里|夜深了)/
    );
    if (slot) return slot[1];
  }
  const raw = String(createdAt || '');
  const m = raw.match(/(?:T|\s)(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  return '';
}

function mapMemoryStage(m) {
  const meta = parseMemoryMeta(m?.meta);
  const emotion = meta.emotion || {};
  const valence = Number(emotion.valence);
  return {
    id: m.id,
    date: memDay(m),
    time: extractMemoryTime(m),
    category: m.category || '',
    content: m.content || '',
    source: m.source || '',
    mood: inferMoodLabel(valence, meta.mood_label || emotion.label),
    moodValence: Number.isFinite(valence) ? valence : null,
  };
}

function loadMemoriesByIds(ids) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) return [];
  return db.prepare(
    `SELECT id, category, content, date, created_at, source, episode_id, meta
     FROM memories WHERE id IN (${list.map(() => '?').join(',')})`
  ).all(...list);
}

function isLeafRow(row) {
  return !!(row && String(row.fallen_at || '').trim());
}

function limbSizeOf(stageCount, twigCount) {
  const w = (Number(stageCount) || 0) + (Number(twigCount) || 0) * 1.5;
  if (w >= 8) return 'thick';
  if (w >= 3) return 'mid';
  return 'thin';
}

function personaTrunk(charId) {
  const char = db.prepare('SELECT name, personality, behavior FROM characters WHERE id=?').get(charId);
  const title = String(char?.name || '').trim() || '人格';
  const gist = String(char?.personality || char?.behavior || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return { kind: 'persona', title, gist };
}

function getBrainExperiences(charId) {
  const living = [];
  const fallen = [];

  try {
    const narrativeHelper = require('./memory-narrative-helper');
    const tree = require('./memory-tree-helper');
    const narratives = db.prepare(
      `SELECT * FROM memory_narratives WHERE character_id=? ORDER BY id DESC LIMIT 80`
    ).all(charId);

    for (const n of narratives) {
      try {
        const summary = tree.treeSummary(n);
        const branches = tree.listBranches(n.id);
        const branchIds = branches.flatMap((b) => tree.parseIds(b.linked_memory_ids));
        const linked = loadMemoriesByIds([
          ...parseLinkedIds(n.linked_memory_ids),
          ...branchIds,
        ]);
        const span = dateSpanOf(linked);
        const createdDay = String(n.created_at || '').slice(0, 10);
        const updatedAt = String(n.content_updated_at || n.created_at || '').slice(0, 10);
        const startedAt = span.dateFrom || createdDay || updatedAt;
        const fallenOff = isLeafRow(n);
        const livingTwigs = branches.filter((b) => {
          if (isLeafRow(b) || b.component_key === 'core' || b.type === 'core') return false;
          const nk = summary.kind || 'event';
          if (nk === 'user' || nk === 'self') {
            return (Number(b.touch_count) || 0) > 0 || tree.parseIds(b.linked_memory_ids).length > 0;
          }
          return true;
        });
        const item = {
          kind: 'narrative',
          id: n.id,
          title: n.title || '未命名',
          gist: String(n.stance || n.content || '').slice(0, 280),
          status: fallenOff ? 'fallen' : n.status,
          dirty: narrativeHelper.isDirty(n),
          dateFrom: startedAt,
          dateTo: span.dateTo || updatedAt || startedAt,
          startedAt,
          updatedAt: updatedAt || startedAt,
          stageCount: summary.stageCount,
          branchCount: livingTwigs.length,
          tier: summary.tier,
          treeKind: summary.kind || 'event',
          treeKindLabel: summary.kindLabel || '事件',
          source: 'narrative',
          leaf: fallenOff,
          moodLabel: n.mood_label || '',
          stance: n.stance || '',
          fallenAt: n.fallen_at || '',
          limb: limbSizeOf(summary.stageCount, livingTwigs.length),
          sequelOf: Number(n.sequel_of) || 0,
          twigs: livingTwigs.map((b) => ({
            id: b.id,
            title: b.name || '细枝',
            stageCount: tree.parseIds(b.linked_memory_ids).length,
            tier: b.tier || 'hot',
          })),
        };
        (fallenOff ? fallen : living).push(item);
        for (const b of branches) {
          if (!isLeafRow(b)) continue;
          fallen.push({
            kind: 'branch',
            id: b.id,
            parentId: n.id,
            title: b.name || '细枝',
            gist: `来自「${n.title || '未命名'}」`,
            status: 'fallen',
            dirty: false,
            dateFrom: String(b.last_touched_at || b.created_at || '').slice(0, 10),
            dateTo: String(b.fallen_at || b.last_touched_at || '').slice(0, 10),
            startedAt: String(b.created_at || '').slice(0, 10),
            updatedAt: String(b.fallen_at || '').slice(0, 10),
            stageCount: tree.parseIds(b.linked_memory_ids).length,
            branchCount: 0,
            tier: 'dormant',
            source: 'branch',
            leaf: true,
            moodLabel: b.mood_label || '',
            parentTitle: n.title || '未命名',
            fallenAt: b.fallen_at || '',
          });
        }
      } catch (e) {
        console.warn('[brain] narrative', n.id, e.message);
      }
    }
  } catch (e) {
    console.warn('[brain] narratives', e.message);
  }

  living.sort((a, b) => {
    const wa = (a.stageCount || 0) + (a.branchCount || 0) * 1.5;
    const wb = (b.stageCount || 0) + (b.branchCount || 0) * 1.5;
    if (wb !== wa) return wb - wa;
    return String(b.startedAt || '').localeCompare(String(a.startedAt || '')) || ((b.id || 0) - (a.id || 0));
  });
  fallen.sort((a, b) =>
    String(b.fallenAt || b.updatedAt || '').localeCompare(String(a.fallenAt || a.updatedAt || ''))
    || ((b.id || 0) - (a.id || 0))
  );
  let edges = [];
  try {
    const tree = require('./memory-tree-helper');
    if (living.length >= 2) {
      try {
        const existing = tree.listNarrativeLinks(charId, { livingIds: living.map((x) => x.id) });
        if (!existing.length) tree.rebuildNarrativeLinks(charId);
      } catch { /* ignore */ }
    }
    edges = tree.listNarrativeLinks(charId, { livingIds: living.map((x) => x.id) });
  } catch (e) {
    console.warn('[brain] narrative edges', e.message);
  }

  return {
    trunk: personaTrunk(charId),
    items: [...living.slice(0, 70), ...fallen.slice(0, 40)],
    edges,
    kinds: ['event', 'daily', 'affection', 'user', 'self'],
  };
}

function buildNarrativeSubgraph(n, branches, related) {
  const hubKey = `narrative:${n.id}`;
  const nodes = [{
    kind: 'narrative',
    id: n.id,
    nodeKey: hubKey,
    title: n.title || '未命名',
    role: 'hub',
    treeKind: n.treeKind || 'event',
    treeKindLabel: n.treeKindLabel || '事件',
    stageCount: (n.stages || []).length,
    tier: n.tier || 'hot',
  }];
  const edges = [];

  // 延续链节点：找前传和续集
  const tree = require('./memory-tree-helper');
  const charId = n.characterId || 0;
  if (n.sequelOf) {
    // 前传
    const prequel = db.prepare(
      `SELECT * FROM memory_narratives WHERE id=? AND character_id=?`
    ).get(Number(n.sequelOf), charId);
    if (prequel) {
      const pk = `narrative:${prequel.id}`;
      nodes.push({
        kind: 'narrative',
        id: prequel.id,
        nodeKey: pk,
        title: prequel.title || '前传',
        role: 'sequel-prev',
        treeKind: n.treeKind || 'event',
        treeKindLabel: n.treeKindLabel || '事件',
        stageCount: 0,
        tier: prequel.tier || 'cool',
      });
      edges.push({ from: pk, to: hubKey, type: 'sequel' });
    }
  }
  // 找以本话题为前传的续集
  const sequels = db.prepare(
    `SELECT * FROM memory_narratives WHERE sequel_of=? AND character_id=? LIMIT 4`
  ).all(Number(n.id), charId);
  for (const sq of sequels) {
    const sqKey = `narrative:${sq.id}`;
    nodes.push({
      kind: 'narrative',
      id: sq.id,
      nodeKey: sqKey,
      title: sq.title || '续集',
      role: 'sequel-next',
      treeKind: n.treeKind || 'event',
      treeKindLabel: n.treeKindLabel || '事件',
      stageCount: 0,
      tier: sq.tier || 'cool',
    });
    edges.push({ from: hubKey, to: sqKey, type: 'sequel' });
  }

  // 细枝节点（分支）
  for (const b of branches || []) {
    if (b.fallen) continue;
    const twigKey = `branch:${b.id}`;
    nodes.push({
      kind: 'branch',
      id: b.id,
      nodeKey: twigKey,
      parentId: n.id,
      title: b.name || '细枝',
      role: 'twig',
      treeKind: n.treeKind || 'event',
      treeKindLabel: n.treeKindLabel || '事件',
      stageCount: b.stageCount || (b.stages || []).length,
      tier: b.tier || 'hot',
    });
    edges.push({ from: hubKey, to: twigKey, type: 'twig' });
  }
  // 相关话题节点
  for (const r of related || []) {
    const relKey = `narrative:${r.id}`;
    nodes.push({
      kind: 'narrative',
      id: r.id,
      nodeKey: relKey,
      title: r.title || '相关话题',
      role: 'related',
      treeKind: r.treeKind || 'event',
      treeKindLabel: r.treeKindLabel || '事件',
      stageCount: r.stageCount || 0,
      tier: r.tier || 'hot',
    });
    edges.push({
      from: hubKey,
      to: relKey,
      type: r.linkType || 'related',
    });
  }
  return { nodes, edges };
}

function getExperienceDetail(charId, kind, id) {
  const kid = parseInt(id, 10);
  if (kind === 'branch') {
    const tree = require('./memory-tree-helper');
    const b = tree.getBranch(kid);
    if (!b || Number(b.character_id) !== Number(charId)) return null;
    const parent = db.prepare(
      `SELECT * FROM memory_narratives WHERE id=? AND character_id=?`
    ).get(b.narrative_id, charId);
    const stages = sortByDay(loadMemoriesByIds(tree.parseIds(b.linked_memory_ids))).map(mapMemoryStage);
    const span = dateSpanOf(stages);
    const startedAt = span.dateFrom || String(b.created_at || '').slice(0, 10);
    const pk = parent ? tree.getNarrativeKind(parent) : 'event';
    return {
      kind: 'branch',
      id: b.id,
      parentId: b.narrative_id,
      parentTitle: parent?.title || '话题',
      title: b.name || '细枝',
      gist: parent ? `属于「${parent.title || '未命名'}」` : '',
      status: isLeafRow(b) ? 'fallen' : 'active',
      dirty: false,
      dateFrom: startedAt,
      dateTo: span.dateTo || startedAt,
      startedAt,
      updatedAt: String(b.last_touched_at || b.created_at || '').slice(0, 10),
      stages,
      branches: [],
      tier: b.tier || 'hot',
      treeKind: pk,
      treeKindLabel: tree.KIND_LABEL[pk] || '事件',
      moodLabel: b.mood_label || '',
      stance: '',
      leaf: isLeafRow(b),
      hasGraph: false,
      graph: null,
    };
  }
  if (kind === 'narrative') {
    const n = db.prepare(
      `SELECT * FROM memory_narratives WHERE id=? AND character_id=?`
    ).get(kid, charId);
    if (!n) return null;
    const tree = require('./memory-tree-helper');
    const trunkStages = sortByDay(loadMemoriesByIds(parseLinkedIds(n.linked_memory_ids)));
    const branches = tree.listBranches(n.id).map((b) => ({
      id: b.id,
      key: b.component_key,
      name: b.name,
      type: b.type,
      tier: b.tier || 'hot',
      salience: Number(b.salience) || 0,
      fallen: !!(b.fallen_at || '').trim(),
      moodLabel: b.mood_label || '',
      stageCount: tree.parseIds(b.linked_memory_ids).length,
      stages: sortByDay(loadMemoriesByIds(tree.parseIds(b.linked_memory_ids))).map(mapMemoryStage),
    }));
    const allStages = [
      ...trunkStages,
      ...branches.flatMap((b) => b.stages.map((s) => ({ ...s, date: s.date }))),
    ];
    const span = dateSpanOf(allStages.length ? allStages : trunkStages);
    const createdDay = String(n.created_at || '').slice(0, 10);
    const updatedAt = String(n.content_updated_at || n.created_at || '').slice(0, 10);
    const startedAt = span.dateFrom || createdDay || updatedAt;
    const summary = tree.treeSummary(n);

    const relatedRaw = tree.listRelatedNarrativeIds(n.id, charId);
    const related = [];
    for (const r of relatedRaw.slice(0, 8)) {
      const row = db.prepare(
        `SELECT * FROM memory_narratives WHERE id=? AND character_id=?`
      ).get(r.id, charId);
      if (!row || isLeafRow(row)) continue;
      const rs = tree.treeSummary(row);
      related.push({
        id: row.id,
        title: row.title || '相关话题',
        linkType: r.type || 'related',
        score: r.score,
        treeKind: rs.kind || 'event',
        treeKindLabel: rs.kindLabel || '事件',
        stageCount: rs.stageCount,
        tier: rs.tier || 'hot',
        gist: String(row.stance || row.content || '').slice(0, 120),
      });
    }

    const livingBranches = branches.filter((b) => !b.fallen && b.key !== 'core' && b.type !== 'core');
    const detailBase = {
      kind: 'narrative',
      id: n.id,
      title: n.title || '未命名',
      gist: n.content || '',
      status: isLeafRow(n) ? 'fallen' : n.status,
      dirty: require('./memory-narrative-helper').isDirty(n),
      dateFrom: startedAt,
      dateTo: span.dateTo || updatedAt || startedAt,
      dateLabel: span.label || startedAt,
      startedAt,
      updatedAt: updatedAt || startedAt,
      stages: trunkStages.map(mapMemoryStage),
      components: summary.components,
      branches,
      related,
      tier: summary.tier,
      treeKind: summary.kind || 'event',
      treeKindLabel: summary.kindLabel || '事件',
      emotionCharge: summary.emotionCharge,
      moodLabel: n.mood_label || '',
      stance: n.stance || '',
      leaf: isLeafRow(n),
    };
    const hasGraph = livingBranches.length > 0 || related.length > 0;
    detailBase.hasGraph = hasGraph;
    detailBase.characterId = charId;
    detailBase.sequelOf = Number(n.sequel_of) || 0;
    detailBase.graph = hasGraph
      ? buildNarrativeSubgraph(detailBase, livingBranches, related)
      : null;
    return detailBase;
  }

  const e = db.prepare(
    `SELECT * FROM memory_episodes WHERE id=? AND character_id=?`
  ).get(kid, charId);
  if (!e) return null;
  let stages = sortByDay(db.prepare(
    `SELECT id, category, content, date, created_at, source, meta
     FROM memories WHERE character_id=? AND episode_id=? AND COALESCE(archived,0)=0`
  ).all(charId, kid));
  if (!stages.length && e.date) {
    stages = sortByDay(db.prepare(
      `SELECT id, category, content, date, created_at, source, meta
       FROM memories WHERE character_id=? AND date=? AND source IN ('schedule','schedule_day')
       AND COALESCE(archived,0)=0`
    ).all(charId, e.date));
  }
  const span = dateSpanOf(stages.length ? stages : [{ date: e.date || e.created_at }]);
  const startedAt = span.dateFrom || e.date || String(e.created_at || '').slice(0, 10);
  const updatedAt = span.dateTo || startedAt;
  return {
    kind: 'episode',
    id: e.id,
    title: e.title || '一段经历',
    gist: e.gist || '',
    status: e.source === 'schedule_day' ? '那天做过' : (e.source || ''),
    dateFrom: startedAt,
    dateTo: updatedAt,
    dateLabel: span.label || startedAt,
    startedAt,
    updatedAt,
    stages: stages.map(mapMemoryStage),
    branches: [],
    hasGraph: false,
    graph: null,
  };
}

function getBrainTidy(charId) {
  try {
    const settings = getSettings();
    settlePassedCurrentMemories(charId, getLocalDateStr(new Date(), settings.timezone || 'Asia/Shanghai'));
    applyIdentityCorrections(charId);
  } catch { /* ignore */ }
  const historical = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE character_id=? AND COALESCE(status,'current')='historical'`
  ).get(charId)?.n || 0;
  const archived = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE character_id=? AND COALESCE(archived,0)=1`
  ).get(charId)?.n || 0;
  const current = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE character_id=? AND COALESCE(archived,0)=0 AND COALESCE(status,'current')='current'`
  ).get(charId)?.n || 0;
  let dirty = 0;
  try {
    const { collectDirtyAndStale } = require('./memory-narrative-helper');
    const debts = collectDirtyAndStale(charId) || {};
    dirty = (debts.dirty?.length || 0) + (debts.sealReview?.length || 0) + (debts.stale?.length || 0);
  } catch { /* ignore */ }
  const lastPack = db.prepare(
    `SELECT value FROM settings WHERE key='brain_schedule_pack_date'`
  ).get()?.value || '';
  const links = db.prepare(
    `SELECT COUNT(*) AS n FROM memory_links WHERE character_id=?`
  ).get(charId)?.n || 0;
  return { current, historical, archived, dirtyNarratives: dirty, lastPack, links };
}

module.exports = {
  SESSION_GAP_MS,
  getCharCorpus,
  invalidateCharCorpus,
  formatShortTermBlock,
  getChatContextRounds,
  loadChatContextHistory,
  splitChatSessions,
  currentSessionHistory,
  parseMessageTime,
  insertMemory,
  inferFactKey,
  applyHealthSupersession,
  resolveCompletedTodos,
  dedupeOpenTodos,
  findSimilarOpenTodo,
  todosAreSimilar,
  listOpenTodosForPrompt,
  writeScheduleItemMemory,
  writeScheduleDayEpisode,
  packYesterdaySchedules,
  autoLinkNewMemories,
  addMemoryLink,
  bumpMemoriesHitByUserTalk,
  memorySalience,
  selectMemoriesForBrain,
  shouldRetrieveMemoriesForChat,
  hasHardMemoryCue,
  collectFlashCandidates,
  buildClusterKeyMap,
  assignMemoryClusters,
  CLUSTER_DETAIL_MAX,
  prepareMindFlashForPromptAsync,
  formatMindFlashBlock,
  formatMindFlashForPrompt,
  formatMindFlashForPromptAsync,
  buildSenseCueFromParts,
  getIncidentalFlashChance,
  wantsPastLife,
  getBrainNow,
  listContextPins,
  getContextHang,
  mutateContextPins,
  searchContextPinCandidates,
  formatContextPinsForPrompt,
  getBrainExperiences,
  getExperienceDetail,
  getBrainTidy,
  settlePassedCurrentMemories,
  settleAllPassedCurrentMemories,
  extractIdentityCorrections,
  memoryContradictsCorrection,
  loadRecentIdentityMessages,
  formatIdentityCorrectionNote,
  applyIdentityCorrections,
  getLocalDateStr,
  shiftDateStr,
};

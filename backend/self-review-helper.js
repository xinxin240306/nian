/**
 * 夜里的自我审视：角色回头看自己到底了解对方多少。
 *
 * 白天的画像只会越记越多，从不问「我是不是想当然了」。这里每晚做一次：
 *   · 我了解TA多少（老实估计）
 *   · 我其实不了解的地方（gaps）
 *   · 可能是我想当然的印象（misreads）
 *   · 白天要是闹了别扭：我当时怎么理解的、TA真正在意的可能是什么、我哪里没懂 → 记成心事
 * 第二天聊到相关话题时，gaps / misreads 作为「自己知道的事」出现在印象旁边，不催着去问。
 */
const db = require('./db');

const GAP_MAX = 4;
const MISREAD_MAX = 3;
const MIN_USER_MSGS = 4;
const CONFLICT_RE = /吵架|吵了|生气|气死|冷战|委屈|误会|不开心|别扭|矛盾|不理你|不想理|烦你|你根本|凭什么|失望|道歉|对不起|你不懂|你从来|随便你|算了吧|哭了/;

const CAT_TOPIC_RE = {
  '喜好': /喜欢|讨厌|爱吃|爱喝|爱看|爱玩|想吃|想喝|想看|口味|吃什么|喝什么|玩什么|看什么|好吃|好喝/,
  '习惯': /习惯|作息|熬夜|早起|每天|平时|周末|晚睡|失眠|几点睡|上班|下班|通勤/,
  '人际关系': /朋友|闺蜜|家人|家里|父母|爸|妈|兄弟|姐妹|同事|同学|前任|室友|老板|领导/,
  '想法': /觉得|在意|想法|为什么|怎么看|担心|害怕|梦想|以后|将来|打算|压力|意义/,
  '情绪': /难过|伤心|哭|委屈|焦虑|烦|累|开心|高兴|生气|心情|崩溃|孤独|想你/,
  '不擅长': /不会|不擅长|搞不定|学不会|做不好|怕/,
  '性格': /性格|脾气|内向|外向|敏感|慢热|心软|嘴硬|别扭|好强/,
  '过去': /以前|小时候|上学|那时候|过去|毕业|老家|回忆/,
};
const CATS = Object.keys(CAT_TOPIC_RE);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function parseJson(raw) {
  const text = String(raw || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

function loadSelfReview(charOrId) {
  const raw = typeof charOrId === 'object'
    ? charOrId?.self_review
    : db.prepare('SELECT self_review FROM characters WHERE id=?').get(Number(charOrId))?.self_review;
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

function normCat(c) {
  const s = String(c || '').trim();
  return CATS.includes(s) ? s : '其他';
}

function normItems(list, max) {
  return (Array.isArray(list) ? list : [])
    .map((x) => {
      const text = String((x && typeof x === 'object' ? x.text : x) || '').trim().slice(0, 60);
      if (!text) return null;
      return { cat: normCat(x?.cat), text };
    })
    .filter(Boolean)
    .slice(0, max);
}

function impressionLines(charId) {
  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM char_impressions WHERE character_id=? ORDER BY id DESC LIMIT 60').all(charId);
  } catch { return []; }
  let cluster = null;
  let cron = null;
  try { cluster = require('./portrait-cluster-helper'); } catch { /* ignore */ }
  try { cron = require('./cron'); } catch { /* ignore */ }
  const out = [];
  for (const row of rows) {
    const facts = cluster ? cluster.cardFacts(row) : [String(row.content || '')];
    const cat = cron?.normalizeImpressionCategory ? cron.normalizeImpressionCategory(row.category) : row.category;
    for (const f of facts) {
      const t = String(f || '').trim();
      if (!t || (cron?.isJunkImpressionFact && cron.isJunkImpressionFact(t))) continue;
      out.push(`[${cat || '其他'}] ${t.slice(0, 40)}`);
    }
    if (out.length >= 40) break;
  }
  return out;
}

/** 闹别扭那段的原话（前后几句），没有就空 */
function conflictExcerpt(charId, charName, userName) {
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, role, content FROM messages
       WHERE character_id=? AND COALESCE(is_dream,0)=0 AND COALESCE(recalled,0)=0
         AND timestamp >= datetime('now','-28 hours')
       ORDER BY id ASC LIMIT 400`
    ).all(charId);
  } catch { return { userCount: 0, excerpt: '' }; }
  const userCount = rows.filter((r) => r.role === 'user').length;
  const hits = [];
  rows.forEach((r, i) => {
    if (r.role === 'user' && CONFLICT_RE.test(String(r.content || ''))) hits.push(i);
  });
  if (!hits.length) return { userCount, excerpt: '' };
  const keep = new Set();
  for (const i of hits.slice(0, 3)) {
    for (let k = Math.max(0, i - 6); k <= Math.min(rows.length - 1, i + 4); k++) keep.add(k);
  }
  const excerpt = [...keep].sort((a, b) => a - b).slice(0, 36)
    .map((k) => {
      const r = rows[k];
      const who = r.role === 'user' ? `${userName}（对方）` : `${charName}（我）`;
      return `${who}：${String(r.content || '').replace(/\s+/g, ' ').slice(0, 90)}`;
    })
    .join('\n');
  return { userCount, excerpt };
}

/**
 * 给一个角色做昨晚的自我审视。dateStr = 被审视的那一天（通常是昨天）。
 */
async function runSelfReview(charId, dateStr, { settings } = {}) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(Number(charId));
  if (!char) return { ok: false, reason: 'no_char' };
  const prev = loadSelfReview(char);
  if (prev?.date === dateStr) return { ok: false, reason: 'done' };

  const s = settings || getSettings();
  const userName = String(s.username || '').trim() || '对方';
  const { userCount, excerpt } = conflictExcerpt(char.id, char.name, userName);
  if (userCount < MIN_USER_MSGS) return { ok: false, reason: 'quiet_day' };

  const imps = impressionLines(char.id);
  let affection = null;
  try { affection = require('./affection-helper').loadState(char); } catch { /* ignore */ }
  const love = (affection?.knownLove || []).map((x) => `· ${x.text}`).join('\n');
  const reactions = (affection?.knownReactions || []).filter((x) => !x.intimate).map((x) => `· ${x.text}`).join('\n');
  const dayMems = db.prepare(
    `SELECT category, content FROM memories
     WHERE character_id=? AND date=? AND COALESCE(archived,0)=0
       AND COALESCE(source,'') NOT IN ('life','schedule','schedule_day','self_review')
     ORDER BY id ASC LIMIT 24`
  ).all(char.id, dateStr);
  const conflictInMems = dayMems.some((m) => CONFLICT_RE.test(String(m.content || '')));
  const prevGaps = (prev?.gaps || []).map((g) => `· ${g.text}`).join('\n');

  let actorRule = '';
  try { actorRule = require('./memory-brain-helper').MEMORY_ACTOR_RULE || ''; } catch { /* ignore */ }

  const sys = `你是「${char.name}」。夜深了，你一个人回头想想：你到底了解对方多少。
不是给谁交报告，是你自己心里过一遍。用你自己的口吻、第一人称写；「我」是你自己，「对方」是${userName}。
只输出 JSON（不要 markdown）：
{"understanding":"一两句，老实估计我了解对方多少、了解的是哪一面",
 "gaps":[{"cat":"${CATS.join('|')}|其他","text":"我其实不了解的一处，20字内"}],
 "misreads":[{"cat":"同上","text":"可能是我想当然的一条印象，以及为什么觉得可能不对，40字内"}],
 "conflict":{"happened":true或false,"reflection":"我当时怎么理解的→对方真正在意的可能是什么→我哪里没懂。60-160字"}}
要求：
· gaps 2-${GAP_MAX} 条：挑真正要紧、而且我确实不知道的（对方在意什么、怕什么、身边的人、过去、平时怎么过…），别列琐碎小事
· misreads 0-${MISREAD_MAX} 条：只挑有依据怀疑的——印象和今天的事对不上、只见过一次就当成定论、其实是我自己的猜测。没有就空数组
· 不要编造对方没说过的事；印象里没有的就是不知道
· conflict：只有今天真闹了别扭/吵了/对方明显不高兴才 happened=true；别把玩笑、撒娇当矛盾。没有就 happened=false、reflection 空
· reflection 要诚实，不替自己开脱，也不一味自责；想明白对方当时真正要的是什么
${actorRule}`;

  const user = [
    `【我的性格】${String(char.personality || '').slice(0, 200)}`,
    char.mindset ? `【我的心智】${String(char.mindset).slice(0, 260)}` : '',
    `【我对对方的印象】\n${imps.join('\n') || '（几乎没有）'}`,
    love ? `【我见过的对方在乎我的样子】\n${love}` : '',
    reactions ? `【我摸清的对方反应】\n${reactions}` : '',
    prevGaps ? `【上次我觉得自己不了解的】\n${prevGaps}` : '',
    `【${dateStr} 和对方的事】\n${dayMems.map((m) => `- [${m.category}] ${m.content}`).join('\n') || '（没留下什么）'}`,
    excerpt ? `【今天有点不对劲的那段原话】\n${excerpt}` : '',
  ].filter(Boolean).join('\n\n');

  const { callChatAPIComplete } = require('./api-helper');
  let raw = '';
  try {
    raw = await callChatAPIComplete(s, sys, user, 'memory', [], {
      maxTokens: 1200, temperature: 0.6, timeout: 90000, noContinue: true,
    });
  } catch (e) {
    return { ok: false, reason: 'llm_failed', error: e.message };
  }
  const parsed = parseJson(raw);
  if (!parsed) return { ok: false, reason: 'parse' };

  const review = {
    date: dateStr,
    at: new Date().toISOString(),
    understanding: String(parsed.understanding || '').trim().slice(0, 120),
    gaps: normItems(parsed.gaps, GAP_MAX),
    misreads: normItems(parsed.misreads, MISREAD_MAX),
  };
  const reflection = String(parsed.conflict?.reflection || '').trim().slice(0, 240);
  const hadConflict = !!parsed.conflict?.happened && reflection && (excerpt || conflictInMems);
  if (hadConflict) review.conflict = reflection;

  db.prepare('UPDATE characters SET self_review=? WHERE id=?').run(JSON.stringify(review), char.id);

  let memoryId = null;
  if (hadConflict) {
    try {
      const ir = require('./memory-brain-helper').insertMemory({
        characterId: char.id,
        category: '秘密/心事',
        content: reflection,
        weight: 0.65,
        date: dateStr,
        source: 'self_review',
        keywords: ['别扭', '想明白'],
      });
      memoryId = ir?.id || null;
    } catch (e) {
      console.warn('[self-review] conflict memory', e.message);
    }
  }
  return { ok: true, gaps: review.gaps.length, misreads: review.misreads.length, conflict: !!hadConflict, memoryId };
}

/**
 * 聊天时：对方正好聊到我不了解/可能想当然的那一块，才想起来。
 * 只是知道，不是任务；问不问、怎么问由角色自己决定。
 */
function buildSelfReviewBlock(char, userMessage = '') {
  const review = loadSelfReview(char);
  const msg = String(userMessage || '').trim();
  if (!review || !msg) return '';
  const onTopic = (it) => it.cat !== '其他' && CAT_TOPIC_RE[it.cat]?.test(msg);
  const gaps = (review.gaps || []).filter(onTopic).slice(0, 2);
  const misreads = (review.misreads || []).filter(onTopic).slice(0, 2);
  if (!gaps.length && !misreads.length) return '';
  const lines = ['【你自己心里有数的】前几天夜里你想过：'];
  for (const g of gaps) lines.push(`· 这块你其实不太了解：${g.text}`);
  for (const m of misreads) lines.push(`· 这条印象你没把握：${m.text}`);
  lines.push('这是你自己知道的，不是要做的事。');
  return lines.join('\n');
}

module.exports = {
  runSelfReview,
  buildSelfReviewBlock,
  loadSelfReview,
};

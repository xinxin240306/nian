/** 当天时间轴：汇总角色某日各路事件，生成可读总结 */

const db = require('./db');
const { callChatAPIComplete, formatApiBillingError } = require('./api-helper');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function cronUtils() {
  const cron = require('./cron');
  const brain = require('./memory-brain-helper');
  return {
    getLocalDateStr: cron.getLocalDateStr,
    parseMsgTimestamp: cron.parseMsgTimestamp,
    shiftDateStr: typeof cron.shiftDateStr === 'function' ? cron.shiftDateStr : brain.shiftDateStr,
  };
}

function ensureDayTimelinesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_timelines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      summary TEXT DEFAULT '',
      beats TEXT DEFAULT '[]',
      source_meta TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(character_id, date)
    )
  `);
}

function clip(text, n = 120) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function sanitizeBeatPlace(raw) {
  try {
    const fn = require('./cron').sanitizeRegionPlace;
    if (typeof fn === 'function') return String(fn(raw) || '').slice(0, 16);
  } catch {}
  const t = String(raw || '').trim();
  if (/厨房|客厅|卧室|书房|弄了|做了|简单/.test(t)) return '';
  return t.slice(0, 16);
}

function gatherDayMaterials(characterId, dateStr, settings) {
  const { getLocalDateStr, parseMsgTimestamp } = cronUtils();
  const tz = settings.timezone || 'Asia/Shanghai';
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) return null;
  const username = settings.username || '旅人';

  // 聊天（主线）
  const candidates = db.prepare(
    `SELECT role, content, type, timestamp FROM messages
     WHERE character_id=? AND is_dream=0 AND recalled=0
     ORDER BY id DESC LIMIT 2500`
  ).all(characterId);
  const dayMsgs = candidates
    .filter(m => getLocalDateStr(parseMsgTimestamp(m.timestamp), tz) === dateStr)
    .reverse();
  const chatLines = dayMsgs
    .filter(m => !m.type || m.type === 'text' || m.type === 'mixed' || m.type === 'voice')
    .map(m => {
      const who = m.role === 'user' ? username : char.name;
      const body = String(m.content || '')
        .replace(/^【自动回复】/, '')
        .replace(/\[引用\][\s\S]*?\[\/引用\]/g, '')
        .trim();
      return body ? `${who}：${clip(body, 160)}` : '';
    })
    .filter(Boolean);
  // 最多约 80 条，字数再截
  let chatStr = chatLines.slice(-80).join('\n');
  if (chatStr.length > 9000) chatStr = chatStr.slice(-9000);

  // 日程
  const schedRows = db.prepare(
    `SELECT role, items FROM schedules WHERE date=? AND (
      (role='ai' AND character_id=?) OR role='user'
    )`
  ).all(dateStr, characterId);
  const scheduleLines = [];
  for (const row of schedRows) {
    let items = [];
    try { items = JSON.parse(row.items || '[]'); } catch { items = []; }
    const label = row.role === 'user' ? '用户安排' : `${char.name}行程`;
    for (const it of items) {
      const time = String(it.time || '').trim();
      const act = String(it.activity || it.title || '').trim();
      const place = String(it.place || it.location || '').trim();
      const thought = String(it.thought || it.execution || '').trim();
      if (!act) continue;
      const placePart = place ? `[${place}] ` : '';
      scheduleLines.push(
        thought
          ? `${label} ${time} ${placePart}${act}（回顾：${clip(thought, 80)}）`
          : `${label} ${time} ${placePart}${act}`
      );
    }
  }

  // daily_context
  const dailyCtx = db.prepare(
    `SELECT content FROM daily_context WHERE character_id=? AND date=? ORDER BY id`
  ).all(characterId, dateStr).map(d => d.content).filter(Boolean);

  // 随手记
  const memoLines = [];
  try {
    const book = db.prepare(
      `SELECT id FROM shared_memo_books WHERE character_id=? LIMIT 1`
    ).get(characterId);
    if (book) {
      const entries = db.prepare(
        `SELECT role, content, visible_at FROM shared_memo_entries
         WHERE book_id=? AND status='visible' AND substr(visible_at,1,10)=?
         ORDER BY datetime(visible_at) ASC, id ASC`
      ).all(book.id, dateStr);
      for (const e of entries) {
        const who = e.role === 'ai' ? char.name : username;
        const t = String(e.visible_at || '').slice(11, 16);
        memoLines.push(`随手记 ${t || ''} ${who}：${clip(e.content, 100)}`);
      }
    }
  } catch { /* ignore */ }

  // 朋友圈
  const momentLines = [];
  try {
    const moments = db.prepare(
      `SELECT content, role, comments, character_id, created_at FROM moments ORDER BY id DESC LIMIT 200`
    ).all();
    for (const mo of moments) {
      const moDate = getLocalDateStr(parseMsgTimestamp(mo.created_at || new Date()), tz);
      if (moDate !== dateStr) continue;
      if (Number(mo.character_id) === characterId) {
        momentLines.push(`${char.name}发了朋友圈：${clip(mo.content, 80)}`);
      }
      let comments = [];
      try { comments = JSON.parse(mo.comments || '[]'); } catch {}
      for (const c of comments) {
        if (Number(c.characterId || c.charId) === characterId) {
          momentLines.push(`${char.name}在朋友圈评论：${clip(c.content, 60)}`);
        }
      }
      if (momentLines.length >= 10) break;
    }
  } catch { /* ignore */ }

  // 通话
  const callLines = [];
  try {
    const calls = db.prepare(
      `SELECT duration, transcript, created_at FROM call_logs WHERE character_id=? ORDER BY id DESC LIMIT 40`
    ).all(characterId);
    for (const c of calls) {
      const d = getLocalDateStr(parseMsgTimestamp(c.created_at || new Date()), tz);
      if (d !== dateStr) continue;
      const mins = Math.max(1, Math.round((c.duration || 0) / 60));
      callLines.push(
        `通话约 ${mins} 分钟${c.transcript ? `：${clip(c.transcript, 120)}` : ''}`
      );
      if (callLines.length >= 5) break;
    }
  } catch { /* ignore */ }

  // 记忆（补充）
  const memLines = [];
  try {
    const mems = db.prepare(
      `SELECT category, content FROM memories WHERE character_id=? AND date=? ORDER BY id DESC LIMIT 12`
    ).all(characterId, dateStr);
    for (const m of mems) {
      memLines.push(`[${m.category || '记忆'}] ${clip(m.content, 100)}`);
    }
  } catch { /* ignore */ }

  const hasAny = chatLines.length || scheduleLines.length || dailyCtx.length
    || memoLines.length || momentLines.length || callLines.length || memLines.length;

  return {
    char,
    username,
    hasAny: !!hasAny,
    counts: {
      chat: chatLines.length,
      schedule: scheduleLines.length,
      dailyContext: dailyCtx.length,
      memo: memoLines.length,
      moments: momentLines.length,
      calls: callLines.length,
      memories: memLines.length,
    },
    promptParts: [
      chatStr ? `【${dateStr} 聊天】\n${chatStr}` : '',
      scheduleLines.length ? `【日程】\n${scheduleLines.join('\n')}` : '',
      dailyCtx.length ? `【当日动态】${dailyCtx.join('；')}` : '',
      memoLines.length ? `【随手记】\n${memoLines.join('\n')}` : '',
      momentLines.length ? `【朋友圈】\n${momentLines.join('\n')}` : '',
      callLines.length ? `【通话】\n${callLines.join('\n')}` : '',
      memLines.length ? `【记忆摘录·仅作补充】\n${memLines.join('\n')}` : '',
    ].filter(Boolean),
  };
}

function parseTimelineJson(raw) {
  let parsed = null;
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : raw);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    const text = String(raw || '').trim();
    return {
      summary: text.slice(0, 800) || '',
      beats: [],
    };
  }
  const summary = String(parsed.summary || parsed.text || '').trim().slice(0, 1200);
  let beats = Array.isArray(parsed.beats) ? parsed.beats : [];
  beats = beats.map((b) => {
    if (typeof b === 'string') return { time: '', place: '', text: b.trim().slice(0, 120) };
    return {
      time: String(b?.time || '').trim().slice(0, 16),
      place: sanitizeBeatPlace(b?.place || b?.location),
      text: String(b?.text || b?.content || '').trim().slice(0, 120),
    };
  }).filter(b => b.text).slice(0, 8);
  return { summary, beats };
}

async function generateDayTimeline(characterId, dateStr, { force = false } = {}) {
  ensureDayTimelinesTable();
  const settings = getSettings();
  const { getLocalDateStr } = cronUtils();
  const tz = settings.timezone || 'Asia/Shanghai';
  const day = String(dateStr || getLocalDateStr(new Date(), tz)).slice(0, 10);

  if (!force) {
    const cached = db.prepare(
      `SELECT summary, beats, source_meta, updated_at FROM day_timelines WHERE character_id=? AND date=?`
    ).get(characterId, day);
    if (cached?.summary) {
      let beats = [];
      let meta = {};
      try { beats = JSON.parse(cached.beats || '[]'); } catch {}
      try { meta = JSON.parse(cached.source_meta || '{}'); } catch {}
      return {
        characterId,
        date: day,
        summary: cached.summary,
        beats,
        sourceMeta: meta,
        updatedAt: cached.updated_at,
        cached: true,
      };
    }
  }

  const materials = gatherDayMaterials(characterId, day, settings);
  if (!materials) {
    const err = new Error('角色不存在');
    err.status = 404;
    throw err;
  }
  if (!materials.hasAny) {
    return {
      characterId,
      date: day,
      summary: '',
      beats: [],
      sourceMeta: materials.counts,
      updatedAt: null,
      cached: false,
      empty: true,
      message: '这一天几乎没有可汇总的记录',
    };
  }

  const systemPrompt = `你是「当天时间轴」总结助手。根据材料，用第三人称写清 ${day} 这一天与「${materials.char.name}」相关的事。
要求：
1) 读完 summary 就能知道当天大致发生了什么（情绪、关键事件、安排、随手互动都可写）。
2) 不要逐句复述聊天，不要编造材料里没有的事。
3) 全文简体中文。summary 约 200～400 字。
4) beats 为 3～8 个要点，按大致时间顺序；time 可用「上午/下午/晚上」或 HH:MM，也可空。
5) place 只写城市/地区短名（2～8字）。出差/外出当天务必写；在家可写常驻地或留空。禁止写房间名或做事短语。
6) 只输出 JSON：{"summary":"…","beats":[{"time":"…","place":"…","text":"…"}]}`;

  const userContent = materials.promptParts.join('\n\n');
  let raw = await callChatAPIComplete(settings, systemPrompt, userContent, 'memory');
  if (!raw) raw = await callChatAPIComplete(settings, systemPrompt, userContent, 'diary');
  if (!raw) raw = await callChatAPIComplete(settings, systemPrompt, userContent, 'chat');
  if (!raw) {
    const err = new Error('生成失败，请检查记忆/日记/聊天 API 配置');
    err.status = 500;
    throw err;
  }

  const { summary, beats } = parseTimelineJson(raw);
  if (!summary) {
    const err = new Error('未能解析总结内容');
    err.status = 500;
    throw err;
  }

  const meta = materials.counts;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`
    INSERT INTO day_timelines (character_id, date, summary, beats, source_meta, updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(character_id, date) DO UPDATE SET
      summary=excluded.summary,
      beats=excluded.beats,
      source_meta=excluded.source_meta,
      updated_at=excluded.updated_at
  `).run(characterId, day, summary, JSON.stringify(beats), JSON.stringify(meta), now);

  return {
    characterId,
    date: day,
    summary,
    beats,
    sourceMeta: meta,
    updatedAt: now,
    cached: false,
  };
}

function getCachedDayTimeline(characterId, dateStr) {
  ensureDayTimelinesTable();
  const settings = getSettings();
  const { getLocalDateStr } = cronUtils();
  const day = String(dateStr || getLocalDateStr(new Date(), settings.timezone || 'Asia/Shanghai')).slice(0, 10);
  const cached = db.prepare(
    `SELECT summary, beats, source_meta, updated_at FROM day_timelines WHERE character_id=? AND date=?`
  ).get(characterId, day);
  if (!cached?.summary) {
    return { characterId, date: day, summary: '', beats: [], cached: false, empty: true };
  }
  let beats = [];
  let meta = {};
  try { beats = JSON.parse(cached.beats || '[]'); } catch {}
  try { meta = JSON.parse(cached.source_meta || '{}'); } catch {}
  return {
    characterId,
    date: day,
    summary: cached.summary,
    beats,
    sourceMeta: meta,
    updatedAt: cached.updated_at,
    cached: true,
  };
}

/** 用户是否在追问「某天发生了什么」一类回忆话题（非行程安排） */
const DAY_RECALL_ASK_RE =
  /(发生了什么|发生过什么|过得怎么样|过得怎样|怎么过的|怎么度过|干了什么|做了什么|聊了什么|聊了啥|干嘛了|做啥了|干了啥|做了啥|还记得|记得吗|记不记得|回忆一下|回想一下|那天.*(怎么样|怎样|啥|什么)|那晚.*(怎么样|怎样)|一起.*(干|做|聊)了|前几天|这几天|最近几天|最近在忙|最近干嘛|最近做什么|忙什么了)/;

function shouldInjectDayRecall(userMessage = '', opts = {}) {
  if (opts.isDream || opts.forGame || opts.forDiaryPeek) return false;
  const msg = String(userMessage || '').trim();
  if (!msg) return false;
  if (!DAY_RECALL_ASK_RE.test(msg)) return false;
  // 「今天干嘛/有空吗」偏行程，不走回忆轴
  if (/今天|今日|今儿/.test(msg) && /(干嘛|做什么|安排|计划|行程|有空|忙不忙|在干嘛)/.test(msg)
    && !/(发生|过得|记得|回忆|干了|做了|聊了)/.test(msg)) {
    return false;
  }
  return true;
}

function formatZhLabel(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd || '';
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 从用户话里解析要回忆的日期（本地日 YYYY-MM-DD）。
 * 优先显式日期 / 相对词；「那天」可从近期历史里找日期线索。
 */
function resolveDayRecallDate(userMessage, settings = {}, recentHistory = []) {
  const { getLocalDateStr, shiftDateStr } = (() => {
    const cron = require('./cron');
    return {
      getLocalDateStr: cron.getLocalDateStr,
      shiftDateStr: (dateStr, days) => {
        if (typeof cron.shiftDateStr === 'function') return cron.shiftDateStr(dateStr, days);
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d + days));
        return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
      },
    };
  })();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const msg = String(userMessage || '');

  const iso = msg.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const zhFull = msg.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (zhFull) {
    return `${zhFull[1]}-${String(zhFull[2]).padStart(2, '0')}-${String(zhFull[3]).padStart(2, '0')}`;
  }

  const zhMd = msg.match(/(\d{1,2})月(\d{1,2})日/);
  if (zhMd) {
    const y = Number(today.slice(0, 4));
    let cand = `${y}-${String(zhMd[1]).padStart(2, '0')}-${String(zhMd[2]).padStart(2, '0')}`;
    if (cand > today) {
      cand = `${y - 1}-${String(zhMd[1]).padStart(2, '0')}-${String(zhMd[2]).padStart(2, '0')}`;
    }
    return cand;
  }

  if (/大前天/.test(msg)) return shiftDateStr(today, -3);
  if (/前天/.test(msg)) return shiftDateStr(today, -2);
  if (/昨天|昨晚|昨日/.test(msg)) return shiftDateStr(today, -1);
  if (/今天|今日|今儿|今早|今晚/.test(msg)) return today;
  if (/前几天|这几天|最近几天|最近在忙|最近干嘛|最近做什么/.test(msg)) {
    return shiftDateStr(today, -1);
  }

  // 「那天/那晚」：从本句或近期对话里找日期
  if (/那天|那晚|那一天/.test(msg)) {
    const scan = [msg, ...(recentHistory || []).slice(-12).map(m => m.content || '')].join('\n');
    const fromHist = scan.match(/(\d{4})-(\d{2})-(\d{2})/)
      || scan.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (fromHist) {
      if (fromHist[0].includes('-')) return `${fromHist[1]}-${fromHist[2]}-${fromHist[3]}`;
      return `${fromHist[1]}-${String(fromHist[2]).padStart(2, '0')}-${String(fromHist[3]).padStart(2, '0')}`;
    }
    const md = scan.match(/(\d{1,2})月(\d{1,2})日/);
    if (md) {
      const y = Number(today.slice(0, 4));
      let cand = `${y}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
      if (cand > today) cand = `${y - 1}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
      return cand;
    }
    // 默认回落到昨天，避免完全无锚点
    return shiftDateStr(today, -1);
  }

  // 有回忆问法但没点明日期 → 默认昨天
  if (DAY_RECALL_ASK_RE.test(msg)) return shiftDateStr(today, -1);
  return '';
}

function buildDayRecallPromptBlock(timeline, dateStr) {
  const label = formatZhLabel(dateStr);
  if (!timeline || timeline.empty || !timeline.summary) {
    return `【当日回忆】用户在问起 ${label || '那天'} 发生了什么，但你这边几乎没有可回忆的素材。
请用第一人称、像在努力回想的语气简短回应：可以说那天印象不深或只记得模糊片段；不要编造具体事件；可以轻轻反问对方还记得什么。`;
  }

  const beats = Array.isArray(timeline.beats) ? timeline.beats : [];
  const beatLines = beats.slice(0, 6).map((b) => {
    const t = String(b.time || '').trim();
    const place = String(b.place || '').trim();
    const text = String(b.text || '').trim();
    const head = [t, place].filter(Boolean).join(' ');
    return head ? `- ${head} ${text}` : `- ${text}`;
  }).filter(l => l.length > 2);

  return `【当日回忆素材·仅供你参考，勿照念】日期：${label}
摘要：${String(timeline.summary || '').slice(0, 600)}
${beatLines.length ? `要点（挑选着用，勿逐条报）：\n${beatLines.join('\n')}` : ''}

【回忆语气】用户在问起这一天。请用第一人称、像在回忆的口吻自然聊：
1) 只挑一两件最有感觉的事轻轻提起，点到为止；不要按时间线把要点一滴不漏说完；
2) 可以带点情绪或细节，并反问对方记不记得某一点，一起回忆；
3) 素材里没有的事不要编；不要变成播报员或日记复述。`;
}

/**
 * 用户问起某天时：读缓存或现场生成时间轴，返回可拼进 extraSystemPrompt 的块。
 */
async function prefetchDayRecallForChat(characterId, settings, userMessage, opts = {}) {
  if (!shouldInjectDayRecall(userMessage, opts)) return '';
  const { getLocalDateStr, shiftDateStr } = cronUtils();
  const tz = settings.timezone || 'Asia/Shanghai';
  const today = getLocalDateStr(new Date(), tz);
  const msg = String(userMessage || '');
  const vagueRecent = /前几天|这几天|最近几天|最近在忙|最近干嘛|最近做什么/.test(msg)
    && !/昨天|昨晚|前天|大前天|今天/.test(msg);

  const dates = vagueRecent
    ? [shiftDateStr(today, -1), shiftDateStr(today, -2), shiftDateStr(today, -3)]
    : [resolveDayRecallDate(userMessage, settings, opts.recentHistory || [])].filter(Boolean);
  if (!dates.length) return '';

  const blocks = [];
  for (const dateStr of dates) {
    let timeline = getCachedDayTimeline(characterId, dateStr);
    if (!timeline?.summary) {
      try {
        timeline = await generateDayTimeline(characterId, dateStr, { force: false });
      } catch (e) {
        console.warn('[timeline] chat recall generate failed:', e.message);
        timeline = { empty: true, summary: '' };
      }
    }
    if (timeline?.summary) blocks.push(buildDayRecallPromptBlock(timeline, dateStr));
  }
  if (!blocks.length) {
    return buildDayRecallPromptBlock({ empty: true, summary: '' }, dates[0]);
  }
  if (vagueRecent && blocks.length > 1) {
    return `【近日回忆素材·仅供你参考，勿照念】用户在问最近几天。从下面挑一两件有感觉的轻轻提起，不要按日期报流水账。\n\n${blocks.join('\n\n')}`;
  }
  return blocks[0];
}

module.exports = {
  ensureDayTimelinesTable,
  gatherDayMaterials,
  generateDayTimeline,
  getCachedDayTimeline,
  formatApiBillingError,
  shouldInjectDayRecall,
  resolveDayRecallDate,
  buildDayRecallPromptBlock,
  prefetchDayRecallForChat,
};

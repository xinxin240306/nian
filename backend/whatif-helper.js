/** 「如果」情景模拟：无大纲，按用户行动即兴展开，背景驱动随机事件 */
const db = require('./db');
const dreamHelper = require('./dream-helper');
const { formatApiBillingError } = require('./api-helper');
const series = require('./series-helper');

const CHAPTER_NO = 1;

function getBook(bookId) {
  const book = series.getBook(bookId);
  if (!book) throw new Error('情景不存在');
  if (book.mode !== 'whatif') throw new Error('这不是「如果」情景');
  return book;
}

function publicBook(bookId) {
  return getBook(bookId);
}

function listTurns(bookId, chapterNo = CHAPTER_NO) {
  return db.prepare(
    `SELECT * FROM series_turns WHERE book_id=? AND chapter_no=? ORDER BY id ASC`,
  ).all(bookId, chapterNo).map((r) => ({
    ...r,
    meta: series.parseJson(r.meta, {}),
  }));
}

function addTurn(bookId, chapterNo, kind, content, meta = {}) {
  const r = db.prepare(
    `INSERT INTO series_turns (book_id, chapter_no, kind, content, meta) VALUES (?,?,?,?,?)`,
  ).run(bookId, chapterNo, kind, String(content || '').trim(), JSON.stringify(meta || {}));
  return {
    id: r.lastInsertRowid,
    book_id: bookId,
    chapter_no: chapterNo,
    kind,
    content: String(content || '').trim(),
    meta,
  };
}

function recentTurnsText(turns, limit = 14) {
  const slice = (turns || []).slice(-limit);
  return slice.map((t) => {
    const label = ({
      narration: '剧情',
      user: '用户',
      char: '同伴',
      system: '插曲',
    })[t.kind] || t.kind;
    const note = t.kind === 'user'
      ? '\n（心声/心想/括号内心仅用户自知，他人听不见）'
      : '';
    return `【${label}】${t.content}${note}`;
  }).join('\n\n');
}

function readSessionMeta(ch) {
  return series.parseJson(ch?.quest_state, {
    user_turns: 0,
    last_event_turn: 0,
  });
}

function saveSessionMeta(chId, meta) {
  db.prepare(`UPDATE series_chapters SET quest_state=? WHERE id=?`).run(
    JSON.stringify(meta || {}),
    chId,
  );
}

function countUserTurns(turns) {
  return (turns || []).filter((t) => t.kind === 'user').length;
}

function shouldInjectEvent(userTurns, lastEventTurn) {
  if (userTurns < 2) return false;
  const gap = userTurns - (lastEventTurn || 0);
  if (gap < 2) return false;
  if (gap >= 5) return Math.random() < 0.9;
  if (gap >= 3) return Math.random() < 0.55;
  return Math.random() < 0.32;
}

function buildBasePrompt(book, char) {
  const settings = series.getSettings();
  const userName = String(settings.username || '你').trim() || '你';
  const core = series.charCoreForSeries(char);
  const bg = String(book.whatif_background || '').trim();
  const premise = String(book.user_premise || '').trim();
  const styleLine = series.styleText(book.style, book.style_customs || book.style_custom, book.genres);
  return `【如果·情景模拟】
这是开放式的「如果…会怎样」互动情景，没有预设大纲或通关任务。
背景设定：${bg}
前提（如果）：${premise}
用户：${userName}（以本人身份进入情景，性格与聊天一致）
同伴：${core.name}｜性格：${core.personality}
外貌：${core.appearance}
${series.speechStyleBlock(core.name, core.speech)}
${styleLine ? `文风：${styleLine}` : ''}

规则：
- 完全根据用户行动即兴展开，不要替用户做决定或代写用户台词
- 旁白客观写环境与他人；同伴对白用「」；心声/括号内心他人听不见
- 与背景和「如果」前提一致，可合理补细节，但不要跳出设定
- 不要解释这是游戏/AI；不要写【系统】任务面板
- 节奏留白：每回合收在需用户接手的节点，不要一次演完大段剧情`;
}

function memoryBlock(bookId) {
  const rows = db.prepare(`
    SELECT content, chapter_no, kind FROM series_memories
    WHERE book_id=? AND kind IN ('plot','char')
    ORDER BY id DESC LIMIT 18
  `).all(bookId);
  if (!rows.length) return '';
  const lines = rows.slice().reverse().map((r) => `- ${r.content}`).join('\n');
  return `【已发生事实·须延续】\n${lines}`;
}

async function extractMemories(bookId, turns) {
  const playTurns = (turns || []).filter((t) => ['narration', 'user', 'char', 'system'].includes(t.kind));
  if (playTurns.length < 3 || playTurns.length % 2 !== 0) return;
  const settings = series.getSettings();
  try {
    series.requireSeriesApi(settings);
  } catch {
    return;
  }
  const slice = recentTurnsText(playTurns, 16);
  const system = `你是情景记忆官。从回合中提取可延续事实，只输出 JSON：
{"plot":["环境与事件事实…"],"char":["同伴言行/态度…"]}
每条≤36字，各最多4条；没有则空数组。禁止编造未发生内容。`;
  try {
    const raw = await series.chatLong(settings, system, slice, {
      maxTokens: 500, continueRounds: 0, targetMin: 0, format: 'json', emptyRetries: 0,
    });
    const obj = series.extractJsonObject(raw) || {};
    for (const f of (Array.isArray(obj.plot) ? obj.plot : []).slice(0, 4)) {
      const t = String(f || '').trim().slice(0, 80);
      if (!t) continue;
      const hit = db.prepare(
        `SELECT id FROM series_memories WHERE book_id=? AND content=? LIMIT 1`,
      ).get(bookId, t);
      if (!hit) {
        db.prepare(
          `INSERT INTO series_memories (book_id, content, chapter_no, kind, pinned) VALUES (?,?,?,?,?)`,
        ).run(bookId, t, CHAPTER_NO, 'plot', 0);
      }
    }
    for (const f of (Array.isArray(obj.char) ? obj.char : []).slice(0, 4)) {
      const t = String(f || '').trim().slice(0, 80);
      if (!t) continue;
      const hit = db.prepare(
        `SELECT id FROM series_memories WHERE book_id=? AND content=? LIMIT 1`,
      ).get(bookId, t);
      if (!hit) {
        db.prepare(
          `INSERT INTO series_memories (book_id, content, chapter_no, kind, pinned) VALUES (?,?,?,?,?)`,
        ).run(bookId, t, CHAPTER_NO, 'char', 0);
      }
    }
    const soft = db.prepare(`
      SELECT id FROM series_memories WHERE book_id=? AND pinned=0 ORDER BY id DESC
    `).all(bookId);
    if (soft.length > 40) {
      const drop = soft.slice(40).map((r) => r.id);
      db.prepare(`DELETE FROM series_memories WHERE id IN (${drop.map(() => '?').join(',')})`).run(...drop);
    }
  } catch (e) {
    console.warn('[whatif] memory', e.message);
  }
}

async function pickEventSeed(book, char, settings, recent) {
  const bg = String(book.whatif_background || '').trim();
  const system = `你是情景编剧。根据背景与近期剧情，想一个自然、不突兀的随机插曲（小事件/意外/偶遇/环境变化）。
只输出 JSON：{"title":"四字到十字标题","hint":"给写手的方向，30～60字"}
要求：贴合背景，能推动局面但不抢戏，不要灾难级转折，不要直接解决核心矛盾。`;
  const user = `背景：${bg}
前提：${book.user_premise || ''}
近期：
${recent}`;
  try {
    const raw = await series.chatLong(settings, system, user, {
      maxTokens: 280, continueRounds: 0, targetMin: 0, format: 'json', emptyRetries: 0,
    });
    const obj = series.extractJsonObject(raw);
    if (obj?.title && obj?.hint) {
      return { title: String(obj.title).trim().slice(0, 24), hint: String(obj.hint).trim().slice(0, 120) };
    }
  } catch (_) { /* fallback */ }
  const fallbacks = [
    { title: '小插曲', hint: '环境里出现一点意外变化，给场面新压力' },
    { title: '偶遇', hint: '路过的人或旧识带来一点信息或尴尬' },
    { title: '天气变化', hint: '天气或光线突变，影响当下行动' },
    { title: '小麻烦', hint: '一件不大不小的麻烦打断当前节奏' },
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

function getPlayState(bookId) {
  const book = publicBook(bookId);
  const ch = series.getChapter(bookId, CHAPTER_NO);
  if (!ch) throw new Error('章节不存在');
  return {
    book,
    chapter: {
      id: ch.id,
      book_id: ch.book_id,
      chapter_no: ch.chapter_no,
      title: ch.title,
      status: ch.status,
      updated_at: ch.updated_at,
    },
    turns: listTurns(bookId, CHAPTER_NO),
  };
}

async function startPlay(bookId, { force = false } = {}) {
  const book = getBook(bookId);
  const bg = String(book.whatif_background || '').trim();
  const premise = String(book.user_premise || '').trim();
  if (!bg) throw new Error('请填写背景设定');
  if (!premise) throw new Error('请填写「如果」前提');

  const ch = series.getChapter(bookId, CHAPTER_NO);
  if (!ch) throw new Error('章节不存在');
  if (ch.status === 'playing' && listTurns(bookId).length && !force) {
    return getPlayState(bookId);
  }

  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const settings = series.getSettings();
  series.requireSeriesApi(settings);

  if (force) {
    db.prepare('DELETE FROM series_turns WHERE book_id=? AND chapter_no=?').run(bookId, CHAPTER_NO);
    try {
      db.prepare(`DELETE FROM series_memories WHERE book_id=?`).run(bookId);
    } catch (_) { /* ignore */ }
    saveSessionMeta(ch.id, { user_turns: 0, last_event_turn: 0 });
  }

  db.prepare(`
    UPDATE series_chapters SET status='generating', outline='', content='', quest_state='{}', updated_at=datetime('now')
    WHERE id=?
  `).run(ch.id);

  const base = buildBasePrompt(book, char);
  const prompt = `${base}

写开场。根据「如果」前提自然切入，建立时间地点、氛围与两人关系基调。
输出 JSON（不要 markdown）：
{"narration":"开场旁白 200～500 字","char":"同伴第一句（可无，有则 40～160 字）"}
要求：不要一次演完；停在让用户能接手的节点；同伴若在场上可有对白。`;

  let obj = null;
  try {
    const raw = await series.chatLong(settings, prompt, '请写开场。', {
      maxTokens: 1400, continueRounds: 1, targetMin: 120, format: 'json', emptyRetries: 1,
    });
    obj = series.extractJsonObject(raw);
  } catch (e) {
    db.prepare(`UPDATE series_chapters SET status='pending' WHERE id=?`).run(ch.id);
    throw new Error(formatApiBillingError(e.message, { label: '如果' }) || e.message || '开场生成失败');
  }

  const narration = dreamHelper.formatDreamProse(String(obj?.narration || '').trim());
  const charLine = dreamHelper.formatDreamProse(String(obj?.char || '').trim());
  if (!narration) {
    db.prepare(`UPDATE series_chapters SET status='pending' WHERE id=?`).run(ch.id);
    throw new Error('开场生成为空，请重试');
  }

  addTurn(bookId, CHAPTER_NO, 'narration', narration, { type: 'opening' });
  if (charLine) addTurn(bookId, CHAPTER_NO, 'char', charLine, { type: 'opening' });

  db.prepare(`
    UPDATE series_chapters SET status='playing', updated_at=datetime('now') WHERE id=?
  `).run(ch.id);
  db.prepare(`UPDATE series_books SET status='writing', updated_at=datetime('now') WHERE id=?`).run(bookId);
  series.touchBook(bookId);

  return getPlayState(bookId);
}

async function userPlayTurn(bookId, { text = '' } = {}) {
  const content = String(text || '').trim();
  if (!content) throw new Error('请输入内容');
  if (content.length > 2000) throw new Error('一次不要写太长');

  const book = getBook(bookId);
  const ch = series.getChapter(bookId, CHAPTER_NO);
  if (!ch) throw new Error('章节不存在');
  if (ch.status !== 'playing') throw new Error('请先开始情景');

  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const settings = series.getSettings();
  series.requireSeriesApi(settings);

  const turns = listTurns(bookId, CHAPTER_NO);
  const turnIdBefore = turns.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  const rollback = () => {
    try {
      db.prepare(
        `DELETE FROM series_turns WHERE book_id=? AND chapter_no=? AND id>?`,
      ).run(bookId, CHAPTER_NO, turnIdBefore);
    } catch (_) { /* ignore */ }
  };

  addTurn(bookId, CHAPTER_NO, 'user', content, {});
  const session = readSessionMeta(ch);
  session.user_turns = countUserTurns(listTurns(bookId, CHAPTER_NO));
  saveSessionMeta(ch.id, session);

  const recent = recentTurnsText(turns.concat([{ kind: 'user', content }]), 12);
  const mem = memoryBlock(bookId);
  const base = buildBasePrompt(book, char);

  let eventBlock = '';
  if (shouldInjectEvent(session.user_turns, session.last_event_turn)) {
    const seed = await pickEventSeed(book, char, settings, recent);
    eventBlock = `【本回合随机插曲·须自然融入】${seed.title}：${seed.hint}
写法：先回应用户行动，再让插曲从环境里长出来；不要单独写「突然系统提示」口吻。`;
    session.last_event_turn = session.user_turns;
    saveSessionMeta(ch.id, session);
  }

  const ctx = `${mem ? `${mem}\n` : ''}近期回合：
${recent}

用户刚才说/做：${content}
【心声隔离】心声/心想/括号内心仅用户自知；同伴与旁人听不见，勿写破。`;

  let route = { focus: 'narration' };
  try {
    const routeRaw = await series.chatLong(settings, `${base}
根据用户行动只输出短 JSON：
{"focus":"char|narration"}
规则：同伴在场且适合接话用 char；否则 narration（同伴可写在旁白里）。`, ctx, {
      maxTokens: 120, continueRounds: 0, targetMin: 0, format: 'json', emptyRetries: 0,
    });
    const parsed = series.extractJsonObject(routeRaw);
    if (parsed?.focus === 'char') route.focus = 'char';
  } catch (_) { /* default narration */ }

  const noRetell = '【禁止复述】不要复述用户原文；用户尝试可被拦、失手或只做到一半。';
  const noThoughts = '【心声隔离】心声/括号内心他人听不见。';

  let body = '';
  try {
    if (route.focus === 'char') {
      body = await series.chatLong(settings, `${base}
【同伴卡】只写${char.name}的现场言行 200～600 字。不要 JSON，不要写用户台词。
${noRetell}
${noThoughts}
${eventBlock}
按性格反应，可主动抛话，但不要替用户做决定。收在需用户接手的节点。`, ctx, {
        maxTokens: 2000, continueRounds: 3, targetMin: 100, format: 'prose', emptyRetries: 1,
      });
    } else {
      body = await series.chatLong(settings, `${base}
【剧情卡】写现场旁白/环境与他人 220～650 字。不要 JSON，不要写用户台词。
${noRetell}
${noThoughts}
${eventBlock}
${char.name}可在场（写进旁白）；客观叙述，留白给用户接手。`, ctx, {
        maxTokens: 2200, continueRounds: 3, targetMin: 100, format: 'prose', emptyRetries: 1,
      });
    }
  } catch (e) {
    rollback();
    throw new Error(formatApiBillingError(e.message, { label: '如果' }) || e.message || '续写失败');
  }

  body = dreamHelper.formatDreamProse(String(body || '').trim());
  if (!body) {
    rollback();
    throw new Error('续写为空，请重试');
  }

  if (route.focus === 'char') {
    addTurn(bookId, CHAPTER_NO, 'char', body, { event: !!eventBlock });
  } else {
    addTurn(bookId, CHAPTER_NO, 'narration', body, { event: !!eventBlock });
  }

  const allTurns = listTurns(bookId, CHAPTER_NO);
  extractMemories(bookId, allTurns).catch(() => {});
  series.touchBook(bookId);
  db.prepare(`UPDATE series_chapters SET updated_at=datetime('now') WHERE id=?`).run(ch.id);

  return {
    turns: allTurns,
    last: allTurns[allTurns.length - 1] || null,
    chapter: getPlayState(bookId).chapter,
    event_injected: !!eventBlock,
  };
}

module.exports = {
  getPlayState,
  startPlay,
  userPlayTurn,
};

/**
 * 时空·幻象：角色视角的一次性幻想短篇（一起做某事），无大纲、不分章。
 */
const db = require('./db');
const seriesHelper = require('./series-helper');
const dreamHelper = require('./dream-helper');

const TARGET_MIN = 2600;
const TARGET_MAX = 4200;
const TARGET_IDEAL = 3200;

function loadBook(bookId) {
  const book = seriesHelper.getBook(bookId, { includeSecrets: true });
  if (!book) throw new Error('幻象不存在');
  if (book.mode !== 'illusion') throw new Error('这不是幻象');
  return book;
}

function loadChar(characterId) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(Number(characterId));
  if (!char) throw new Error('角色不存在');
  return char;
}

function userRecentBlock(characterId) {
  try {
    const helper = require('./user-read-helper');
    const rows = helper.listReads(characterId, 'user') || [];
    const recent = rows.filter((r) => r.section === 'recent' && r.judgment).slice(0, 8);
    const facts = rows.filter((r) => r.section !== 'recent' && r.judgment).slice(0, 8);
    const parts = [];
    if (recent.length) {
      parts.push(`【你眼里对方最近在干嘛】\n${recent.map((r) => `· ${r.judgment}`).join('\n')}`);
    }
    if (facts.length) {
      parts.push(`【你眼里这个人】\n${facts.map((r) => `· ${r.judgment}`).join('\n')}`);
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

function userProfileBlock(settings, characterId) {
  try {
    return require('./user-persona-helper').buildUserPromptBlock(settings, characterId) || '';
  } catch {
    const name = String(settings?.username || '旅人').trim() || '旅人';
    return `【用户】${name}`;
  }
}

function relationHint(char) {
  const bits = [
    char.relationship,
    char.relationship_desc,
    char.mindset,
  ].map((x) => String(x || '').trim()).filter(Boolean);
  return bits.length ? bits.join('\n').slice(0, 800) : '';
}

function buildPrompt(book, char, settings) {
  const core = seriesHelper.charCoreForSeries(char);
  const user = userProfileBlock(settings, char.id);
  const recent = userRecentBlock(char.id);
  const premise = String(book.user_premise || '').trim();
  const style = seriesHelper.styleText(
    book.style,
    book.style_customs || book.style_custom,
    ['healing'],
    '',
  );
  const speech = seriesHelper.speechStyleBlock(core.name, core.speech);
  const rel = relationHint(char);
  const seed = premise
    ? `【这次幻想的事】必须围绕「${premise}」展开。可以补过程与细节，不要另换成完全不相干的一件事。`
    : `【这次幻想的事】用户没指定。请按你对对方的了解（尤其是最近在干嘛、你们怎么相处）自己生出一件「想和对方一起做」的具体事：逛街、做饭、吹头发、等下班、窝在沙发、出门办事……要日常、可触摸，不要史诗任务。`;

  return `你就是「${core.name}」。这是你脑子里的一场幻象：你在幻想和对方一起做某件事。一次性写完，不是剧集、不是穿越、不是互动游戏，不要大纲、不要分章、不要「第x章」。

【专用】只遵守本提示。禁止套用聊天短回复、禁止说自己是 AI、禁止第四墙。
【人称】全文用第一人称「我」（${core.name}）。对方用用户的名字来称呼。这是你的脑内戏，可以比现实更敢想一点，但仍是「一起做事」的过程，不是旁观小说、不是你单方面独白演讲。
【性格】按下面的性格与说话方式写：可以别扭、淡、损、懒、黏、凶，不要写成万能温柔保姆文。动作和对白都要像这个人。
【性格】${core.personality}
【外貌】${core.appearance}
${speech ? `${speech}\n` : ''}${rel ? `【你们】${rel}\n` : ''}${user}
${recent ? `\n${recent}\n` : ''}
${seed}
${style ? `【文笔】${style}` : ''}

【结构】从一个念头开始（为什么会想到这件事），把这件事在脑内从头走到尾：出门/动手/相处中的别扭或亲密、对方的反应（按你对TA的印象去猜）、收束。不要清单式罗列「我们做了A然后B」。
【字数】约 ${TARGET_IDEAL} 汉字（允许 ${TARGET_MIN}～${TARGET_MAX}）。必须写完并自然收束；不够会接写，你也尽量一次写满。
【输出】只输出正文。不要标题、不要 JSON、不要「幻象开始」标签。`;
}

function maybeTitleFromContent(content, fallback) {
  const first = String(content || '').trim().split(/\n+/)[0] || '';
  const m = first.match(/^[《「](.{2,24})[》」]\s*$/);
  if (m) return m[1].trim();
  return fallback;
}

async function generateStory(bookId, { force = false } = {}) {
  const book = loadBook(bookId);
  const ch = seriesHelper.getChapter(bookId, 1);
  if (!ch) throw new Error('幻象正文槽不存在');
  if (!force && ch.status === 'done' && String(ch.content || '').trim()) {
    return seriesHelper.getBook(bookId);
  }

  const settings = seriesHelper.getSettings();
  seriesHelper.requireSeriesApi(settings, 'series');
  const char = loadChar(book.character_id);

  db.prepare(
    `UPDATE series_books SET status='writing', updated_at=datetime('now') WHERE id=?`
  ).run(bookId);
  db.prepare(
    `UPDATE series_chapters SET status='generating', updated_at=datetime('now') WHERE book_id=? AND chapter_no=1`
  ).run(bookId);

  const sys = buildPrompt(book, char, settings);
  const userMsg = force
    ? '请重新写完整场幻象正文，不要复述上一版。只输出正文。'
    : '请现在写出这场完整幻象。只输出正文。';

  let content = '';
  try {
    content = await seriesHelper.chatLong(settings, sys, userMsg, {
      maxTokens: 4500,
      continueRounds: 8,
      targetMin: TARGET_MIN,
      emptyRetries: 2,
      format: 'prose',
      rejectCutOff: true,
      apiType: 'series',
    });
  } catch (e) {
    db.prepare(
      `UPDATE series_chapters SET status='pending', content='', updated_at=datetime('now') WHERE book_id=? AND chapter_no=1`
    ).run(bookId);
    db.prepare(
      `UPDATE series_books SET status='setup', updated_at=datetime('now') WHERE id=? AND status='writing'`
    ).run(bookId);
    throw new Error(e.message || '幻象生成失败');
  }

  content = String(content || '').trim();
  if (!content) {
    db.prepare(
      `UPDATE series_chapters SET status='pending', content='', updated_at=datetime('now') WHERE book_id=? AND chapter_no=1`
    ).run(bookId);
    db.prepare(
      `UPDATE series_books SET status='setup', updated_at=datetime('now') WHERE id=? AND status='writing'`
    ).run(bookId);
    throw new Error('幻象正文为空，请重试或换时空模型');
  }

  try {
    content = dreamHelper.formatDreamProse(content);
  } catch { /* ignore */ }

  const fallbackTitle = String(book.title || '').trim() || String(book.user_premise || '').trim().slice(0, 24) || `幻象·${char.name}`;
  const title = maybeTitleFromContent(content, fallbackTitle).slice(0, 80);

  db.prepare(
    `UPDATE series_chapters SET title=?, content=?, status='done', updated_at=datetime('now') WHERE book_id=? AND chapter_no=1`
  ).run(title, content, bookId);
  db.prepare(
    `UPDATE series_books SET title=?, status='done', updated_at=datetime('now') WHERE id=?`
  ).run(title, bookId);

  return seriesHelper.getBook(bookId);
}

module.exports = {
  generateStory,
  TARGET_MIN,
  TARGET_IDEAL,
};

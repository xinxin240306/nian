/** 聊天内游戏管家 — AI 逻辑 */

const TRUTH_DAILY = [
  '你最近一次心动是因为什么？',
  '说一件你其实有点不好意思承认的小癖好。',
  '你理想中完美的一天是怎样的？',
  '你觉得自己最大的优点和缺点各是什么？',
  '说一个你不敢轻易尝试的事。',
  '你最喜欢被怎样夸奖？',
  '你压力最大时通常会怎么做？',
  '说一件让你特别有安全感的事。',
];

const TRUTH_NSFW = [
  '你最喜欢被摸哪个部位？具体说器官或位置。',
  '说一个你想和对方做的性爱姿势。',
  '你更想让对方舔你的哪里，或者你想舔对方哪里？',
  '说一个你想试但还没说出口的羞耻玩法。',
  '做爱时你喜欢开灯被看着，还是关灯？为什么？',
  '你接受拍照或录像吗？尺度到哪里？',
  '说一个你偷偷搜过的色情关键词或题材。',
];

const PIC_WORDS = [
  '猫', '狗', '苹果', '太阳', '雨伞', '自行车', '蛋糕', '飞机', '鱼', '花',
  '手机', '书', '月亮', '星星', '房子', '树', '汽车', '冰淇淋', '帽子', '鞋子',
  '钢琴', '吉他', '咖啡', '奶茶', '兔子', '熊猫', '蝴蝶', '彩虹', '气球', '钥匙',
];

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** 从词库随机抽词，避免总落在「苹果」等高频词 */
function pickPictionaryWord(exclude = []) {
  const banned = new Set([...(exclude || []).map(w => String(w).trim()).filter(Boolean)]);
  const pool = PIC_WORDS.filter(w => !banned.has(w));
  const list = pool.length ? pool : PIC_WORDS;
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  return shuffled[0];
}

function pickTruthQuestionMixed(nsfwEnabled) {
  const useNsfw = nsfwEnabled && Math.random() < 0.45;
  const pool = useNsfw ? TRUTH_NSFW : TRUTH_DAILY;
  return pickRandom(pool);
}

function buildPictionaryDrawPrompt(word) {
  return [
    `Amateur pictionary doodle of "${word}"`,
    'child-like crayon sketch on white paper',
    'messy hand-drawn lines, rough proportions',
    'simple cartoon, intentionally imperfect and vague',
    'no text, no labels, no photorealism',
    'looks like a quick guessing-game drawing',
  ].join(', ');
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function parseYesNo(raw) {
  const t = String(raw || '').trim();
  const first = t.split('\n')[0] || '';
  if (/^(否|不是|不对|没有|No|no)/i.test(first)) return { answer: '否', note: t };
  if (/^(是|对|没错|Yes|yes)/i.test(first)) return { answer: '是', note: t };
  if (/否|不是|不对/.test(first)) return { answer: '否', note: t };
  return { answer: '是', note: t };
}

function parseJudgeResult(raw) {
  const t = String(raw || '').trim();
  const first = (t.split('\n')[0] || '').trim();
  const correct = /^(对|正确|猜对|是的|没错|正确)/.test(first)
    || (/正确|猜对/.test(first) && !/不/.test(first.slice(0, 4)));
  const wrong = /^(错|不对|不正确|猜错|不是)/.test(first) || /不正确|猜错|不对/.test(first);
  return { correct: wrong ? false : correct, reason: t };
}

function parsePassFail(raw) {
  const rawText = String(raw || '').trim();
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const first = lines[0] || '';
  const pass = !/不通过|未通过|不过关|不合格|不行|不够|拒绝/.test(first)
    && (/通过|合格|可以|过关|OK|ok|✓/.test(first) || !first);
  let reason = '';
  if (!pass) {
    reason = lines.slice(1).join('\n').trim();
    if (!reason) reason = first.replace(/^不通过[：:，,\s]*/, '').trim();
    if (!reason || reason === first) reason = '回答不够具体或没有正面回应题目';
  }
  return { pass, reason, comment: rawText };
}

function formatMemoryLine({ gameName, word, winner, stake, charName, username, note }) {
  const date = new Date().toISOString().slice(0, 10);
  const userLabel = username || '用户';
  if (note) return `${date} ${gameName}${word ? `，词是『${word}』` : ''}，${note}`;
  if (!winner) return `${date} ${gameName}${word ? `，词是『${word}』` : ''}`;
  const winnerText = winner === 'user'
    ? `${userLabel}胜`
    : winner === 'char'
      ? `${charName}胜`
      : '平局';
  const oweSide = winner === 'user' ? charName : winner === 'char' ? userLabel : '';
  const oweText = oweSide && stake ? `${oweSide}欠：${stake}` : (stake ? `赌注：${stake}` : '');
  const wordPart = word ? `，词是『${word}』` : '';
  const tail = oweText ? `，${oweText}` : '';
  return `${date} ${gameName}${wordPart}，${winnerText}${tail}`;
}

async function charReactToTruth(deps, settings, char, question, userAnswer, passed) {
  const systemPrompt = `你是角色「${char.name}」，刚和用户玩真心话。
题目：${question}
用户回答：${userAnswer}
${passed ? '你觉得回答真诚、可以过关。' : '你觉得回答有点敷衍或避重就轻。'}
请用 2-3 句口语回应（可追问、吐槽或安慰），符合性格。不要宣布谁赢谁输，不要提赌注。只输出回应本身。`;
  const raw = await safeComplete(deps, systemPrompt, '请回应');
  return String(raw || (passed ? '嗯，我知道了。' : '这回答有点水啊…')).trim().slice(0, 400);
}

async function safeComplete(deps, systemPrompt, userContent) {
  const { settings, callChatAPIComplete } = deps;
  try {
    const r = await callChatAPIComplete(settings, systemPrompt, userContent, 'chat');
    if (r) return r;
  } catch (e) { console.error('[game-butler chat]', e.message); }
  try {
    const r = await callChatAPIComplete(settings, systemPrompt, userContent, 'memory');
    if (r) return r;
  } catch (e) { console.error('[game-butler memory]', e.message); }
  return null;
}

async function pickSecretWord(deps, char, settings, exclude = []) {
  const fallback = pickPictionaryWord(exclude);
  const systemPrompt = `你是你画我猜的词库助手。请想一个常见名词（动物、食物、物品），2-4 个汉字。
要求：不要重复这些词：${[...exclude, '苹果', '猫', '狗'].filter(Boolean).join('、') || '无'}。
只输出 JSON：{"word":"词"}`;
  const raw = await safeComplete(deps, systemPrompt, '请出一个词');
  const parsed = parseJsonObject(raw);
  const word = parsed?.word ? String(parsed.word).trim().slice(0, 12) : '';
  if (word && !exclude.includes(word)) return word;
  return fallback;
}

async function pickTenQSecret(deps, char, settings) {
  const systemPrompt = `你是十问猜谜游戏的出题方。请在心里想一个人、动物或常见物品（2-6字），不要告诉用户。
只输出 JSON：{"secret":"谜底","category":"人物|动物|物品"}`;
  const raw = await safeComplete(deps, systemPrompt, '请想一个谜底');
  const parsed = parseJsonObject(raw);
  if (parsed?.secret) return { secret: String(parsed.secret).trim().slice(0, 20), category: parsed.category || '物品' };
  const word = pickRandom(PIC_WORDS);
  return { secret: word, category: '物品' };
}

async function generatePictionaryDraw(deps, settings, word) {
  const { generateImage } = deps;
  const prompt = buildPictionaryDrawPrompt(word);
  const url = await generateImage(settings, prompt);
  return url || null;
}

/** 从角色自然回复里摘一个用于结算展示的猜词（完整回复仍参与裁判） */
function pickGuessLabelFromReply(reply) {
  const t = String(reply || '').trim();
  if (!t) return '';
  const patterns = [
    /猜(?:测?)?(?:是|的)?[「『""]?([^」』""!。！？\n,，；;]{1,12})/,
    /(?:像|是|看着像)[「『""]?([^」』""!。！？\n,，；;]{1,12})/,
    /[「『"]([^」』""]{1,12})[」』"]/,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return t.replace(/\s/g, '').slice(0, 12);
}

async function judgeGuess(deps, settings, char, word, guess) {
  const systemPrompt = `你是你画我猜的裁判。答案词是「${word}」。用户猜的是「${guess}」。
同义词、近义词、常见别称也算猜对（如「猫咪」=「猫」）。
只输出 JSON：{"correct":true或false,"reason":"一句话说明"}`;
  const raw = await safeComplete(deps, systemPrompt, `答案：${word}\n猜测：${guess}`);
  const parsed = parseJsonObject(raw);
  if (parsed && typeof parsed.correct === 'boolean') {
    return { correct: parsed.correct, reason: parsed.reason || '' };
  }
  const norm = s => String(s || '').replace(/\s/g, '');
  const simple = norm(word) === norm(guess)
    || norm(guess).includes(norm(word))
    || norm(word).includes(norm(guess));
  return { correct: simple, reason: simple ? '猜对了！' : '不对哦，再想想？' };
}

async function answerTenQ(deps, settings, secret, question, questionsLeft) {
  const systemPrompt = `你是十问猜谜的答题机器（中立裁判，不是任何角色）。系统设定的谜底是「${secret}」（禁止透露）。
用户只能用是/否题。你必须只回答「是」或「否」，可加半句简短说明（不超过15字）。
还剩 ${questionsLeft} 次提问机会。`;
  const raw = await safeComplete(deps, systemPrompt, question);
  const { answer, note } = parseYesNo(raw);
  return { answer, reply: note || answer, questionsLeft };
}

async function charAskTenQ(deps, settings, char, secret, qaHistory, questionsLeft) {
  const hist = (qaHistory || []).map(h => `问：${h.q}\n答：${h.a}`).join('\n');
  const systemPrompt = `你是角色「${char.name}」，正在玩十问猜谜，你是提问方。
系统里有一个你不能告诉用户的谜底（你不需要知道它是什么，只需根据用户的「是/否」回答缩小范围）。
${hist ? `已有问答：\n${hist}\n` : ''}还剩 ${questionsLeft} 次提问机会。
请提出一个新的、是非题形式的问题（一句话，15-40字）。不要猜测答案，不要直接说出谜底。`;
  const raw = await safeComplete(deps, systemPrompt, hist ? '请继续提问' : '请提出第一个问题');
  return String(raw || '它是活的吗？').trim().slice(0, 80);
}

function buildHiddenRevealLog(entries, secret, label = '谜底') {
  if (!entries?.length && !secret) return '';
  const lines = ['🎮 游戏助手：本局封存记录揭晓'];
  for (const e of entries) {
    lines.push(`· 问：${e.question}`);
    lines.push(`  答：${e.answer}`);
  }
  if (secret) lines.push(`${label}：「${secret}」`);
  return lines.join('\n');
}

async function judgeTenQGuess(deps, settings, char, secret, guess) {
  const systemPrompt = `十问猜谜裁判。谜底是「${secret}」，用户猜测「${guess}」。同义词算对。
只输出 JSON：{"correct":true或false,"reason":"一句话"}`;
  const raw = await safeComplete(deps, systemPrompt, `谜底：${secret}\n猜测：${guess}`);
  const parsed = parseJsonObject(raw);
  if (parsed && typeof parsed.correct === 'boolean') {
    return { correct: parsed.correct, reason: parsed.reason || '' };
  }
  return judgeGuess(deps, settings, char, secret, guess);
}

async function generateQuizQuestion(deps, settings, char, username, target) {
  const aboutUser = target === 'user';
  const systemPrompt = aboutUser
    ? `你是游戏管家，出一道关于用户「${username || '用户'}」的选择题，考验角色是否了解用户。
题目格式：${username || '用户'}……？不要出答案。
只输出 JSON：{"question":"题目一句话"}`
    : `你是游戏管家，出一道关于角色「${char.name}」的选择题，考验用户是否了解TA。
题目格式：${char.name}……？或「TA……？」不要出答案。
只输出 JSON：{"question":"题目一句话"}`;
  const raw = await safeComplete(deps, systemPrompt, '请出题');
  const parsed = parseJsonObject(raw);
  if (parsed?.question) return String(parsed.question).trim();
  return aboutUser
    ? `${username || '用户'}最爱吃的水果是？`
    : `${char.name}最放松的时候通常在做什么？`;
}

async function charAnswerAboutUser(deps, settings, char, username, question) {
  const systemPrompt = `你是角色「${char.name}」，正在玩「谁更了解谁」。请回答关于用户「${username || '用户'}」的问题。
根据你对用户的了解作答，2-3句，口语自然，只输出答案本身。`;
  const raw = await safeComplete(deps, systemPrompt, question);
  return String(raw || '……').trim().slice(0, 300);
}

async function charJudgeAboutChar(deps, settings, char, question, userAnswer) {
  const systemPrompt = `你是角色「${char.name}」，判断用户对你了解多少。
题目：${question}
用户的回答：${userAnswer}
第一行必须是「对」或「错」。第二行起简短说明（可选）。同义词、意思接近算对。`;
  const raw = await safeComplete(deps, systemPrompt, '请判断');
  return parseJudgeResult(raw);
}

async function charAnswerTruth(deps, settings, char, question) {
  const systemPrompt = `你是角色「${char.name}」，正在玩真心话。请坦诚回答，2-4句，符合性格，只输出回答本身。`;
  const raw = await safeComplete(deps, systemPrompt, question);
  return String(raw || '……').trim().slice(0, 400);
}

async function charJudgeTruth(deps, settings, char, question, userAnswer) {
  const systemPrompt = `你是角色「${char.name}」，真心话评判者。
题目：${question}
用户回答：${userAnswer}
第一行必须是「通过」或「不通过」。若不通过，第二行起说明原因。`;
  const raw = await safeComplete(deps, systemPrompt, '请评判');
  return parsePassFail(raw);
}

module.exports = {
  pickRandom,
  pickPictionaryWord,
  pickTruthQuestionMixed,
  pickSecretWord,
  pickTenQSecret,
  generatePictionaryDraw,
  pickGuessLabelFromReply,
  judgeGuess,
  answerTenQ,
  charAskTenQ,
  judgeTenQGuess,
  buildHiddenRevealLog,
  generateQuizQuestion,
  charAnswerAboutUser,
  charJudgeAboutChar,
  charAnswerTruth,
  charJudgeTruth,
  charReactToTruth,
  formatMemoryLine,
};

/** 预设作用域：按场景注入全局/自定义规则 */
const db = require('./db');

const PRESET_SCOPE_LABELS = {
  chat: '聊天',
  diary: '日记',
  memo: '随手记',
  game: '游戏',
  reader: '阅读',
  moments: '朋友圈',
};

const ALL_SCOPES = Object.keys(PRESET_SCOPE_LABELS);

const GLOBAL_DEFAULT_SCOPES = ['chat', 'diary', 'memo', 'game', 'reader', 'moments'];

function parsePresetScopes(raw, type) {
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        return arr.filter(s => ALL_SCOPES.includes(s));
      }
    } catch { /* fall through */ }
  }
  if (type === 'jailbreak' || type === 'banned_content' || type === 'no_preach') {
    return [...GLOBAL_DEFAULT_SCOPES];
  }
  return ['chat'];
}

function getPresetsForScope(scope) {
  if (!scope || !ALL_SCOPES.includes(scope)) return '';
  const rows = db.prepare(
    `SELECT content, type, scopes FROM presets WHERE enabled=1 ORDER BY id`
  ).all();
  return rows
    .filter(p => parsePresetScopes(p.scopes, p.type).includes(scope))
    .map(p => String(p.content || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function buildPresetsBlock(scope) {
  const raw = getPresetsForScope(scope);
  if (!raw) return '';
  return `【用户预设·禁则】下面列出的说法这轮不要出现。
口吻、节奏、心情仍按【性格】【行为模式】【语言风格】。撞上禁词或禁句式，换成这个人自己的说法，打趣和温度留着。不要为了躲开这些词把话放平。预设正文里若写「最重要」「压过一切」，只约束这些禁则，不改这个人怎么说话。
${raw}`;
}

function appendPresetsToPrompt(basePrompt, scope) {
  const block = buildPresetsBlock(scope);
  if (!block) return basePrompt || '';
  return basePrompt ? `${basePrompt}\n\n${block}` : block;
}

function systemTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('\n');
}

const PRESET_MARK = '【用户预设·禁则】';
const CLOSER_MARK = '【这轮收尾·硬性】';

/** 从系统提示里取出预设段。聊天记录排在系统提示后面，只放末尾等于没开。 */
function extractPresetsBlock(systemText) {
  const s = String(systemText || '');
  const start = s.indexOf(PRESET_MARK);
  if (start < 0) return '';
  let rest = s.slice(start).trim();
  const next = rest.indexOf(`\n\n${CLOSER_MARK}`);
  if (next >= 0) rest = rest.slice(0, next).trim();
  return rest;
}

/** 系统提示里的预设整段拿掉，避免和开口前那一条各占一份上下文。 */
function stripPresetsBlock(systemText) {
  const s = String(systemText || '');
  const start = s.indexOf(PRESET_MARK);
  if (start < 0) return s;
  const closerAt = s.indexOf(`\n\n${CLOSER_MARK}`, start);
  const head = s.slice(0, start).replace(/\n+$/, '');
  if (closerAt >= 0) {
    const tail = s.slice(closerAt + 2);
    return head ? `${head}\n\n${tail}` : tail;
  }
  return head;
}

function stripPresetsFromContent(content) {
  if (typeof content === 'string') return stripPresetsBlock(content);
  if (!Array.isArray(content)) return content;
  return content.map((p) => {
    if (typeof p === 'string') return stripPresetsBlock(p);
    if (p && typeof p.text === 'string' && p.text.includes(PRESET_MARK)) {
      return { ...p, text: stripPresetsBlock(p.text) };
    }
    return p;
  });
}

/**
 * 预设从系统提示末尾挪到最后一条用户消息之前，全文只留这一份。
 * 历史仍在系统提示后面时，只放末尾等于没开。
 */
function pinPresetsOnMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const block = extractPresetsBlock(systemTextOf(messages[0]?.content));
  const already = messages.slice(1).some((m) => (
    m && m.role === 'system' && String(m.content || '').includes(PRESET_MARK)
  ));
  if (messages[0] && (block || systemTextOf(messages[0].content).includes(PRESET_MARK))) {
    messages[0] = { ...messages[0], content: stripPresetsFromContent(messages[0].content) };
  }
  if (!block || already) return messages;
  const pin = {
    role: 'system',
    content: `${block}\n这段在聊天记录之后，开口前还看得到。先接对方最后一句，用这个人的嘴说。不要复述这段。`,
  };
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i]?.role === 'user') { lastUser = i; break; }
  }
  if (lastUser > 0) messages.splice(lastUser, 0, pin);
  else messages.push(pin);
  return messages;
}

function resolvePresetScope(opts = {}) {
  if (opts.isDream) return null;
  if (opts.presetScope && ALL_SCOPES.includes(opts.presetScope)) return opts.presetScope;
  if (opts.forGame) return 'game';
  if (opts.forDiaryPeek) return 'diary';
  return 'chat';
}

module.exports = {
  PRESET_SCOPE_LABELS,
  ALL_SCOPES,
  GLOBAL_DEFAULT_SCOPES,
  parsePresetScopes,
  getPresetsForScope,
  buildPresetsBlock,
  appendPresetsToPrompt,
  extractPresetsBlock,
  pinPresetsOnMessages,
  resolvePresetScope,
};

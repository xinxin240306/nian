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
  if (scope === 'chat') {
    return `【用户预设·必须遵守】以下是用户为本轮对话启用的规则，须逐条执行。与上文其他说明冲突时以本段为准。
唯一例外：不得违背【角色】中【性格】【行为模式】【语言风格】的人格底线——该拒绝、顶嘴、冷战、顶回去时仍须按人设来，不要变成百依百顺。
${raw}`;
  }
  return `【用户预设·必须遵守】以下约束须执行（不得违背人设与格式要求）：\n${raw}`;
}

function appendPresetsToPrompt(basePrompt, scope) {
  const block = buildPresetsBlock(scope);
  if (!block) return basePrompt || '';
  return basePrompt ? `${basePrompt}\n\n${block}` : block;
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
  resolvePresetScope,
};

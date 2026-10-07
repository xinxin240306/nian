/**
 * 穿越原创：生成大纲前的编剧问诊（构思结果不对用户展示）
 */
const db = require('./db');
const series = require('./series-helper');
const { callChatAPIComplete } = require('./api-helper');

const TABOO_PRESETS = [
  { id: 'no_restore', label: '亡国公主/复国模板' },
  { id: 'no_detective', label: '刑侦探案当主线' },
  { id: 'no_raid_home', label: '抄家查封开局' },
  { id: 'no_interrogation_loop', label: '连章审讯/坐牢' },
  { id: 'no_pregnancy', label: '怀孕/生子情节' },
  { id: 'no_be', label: 'BE 结局' },
  { id: 'no_nsfw', label: '露骨床戏' },
  { id: 'no_incest', label: '近亲/师生禁忌' },
  { id: 'no_substitute', label: '替身/白月光梗' },
  { id: 'no_amnesia', label: '失忆梗' },
  { id: 'no_betrayal_loop', label: '反复背叛误会' },
  { id: 'no_gore', label: '过度血腥描写' },
];

const QUESTION_POOL = [
  {
    id: 'romance_engine',
    genres: ['romance', 'sweet', 'angst', 'romance_nsfw'],
    text: '感情线你更想怎么推进？',
    type: 'single',
    options: ['慢热试探', '开局就有张力', '误会拉扯', '双向暗恋', '契约/联姻开局', '虐后必须甜'],
  },
  {
    id: 'palace_board',
    genres: ['palace', 'historical', 'family'],
    text: '这本更偏哪一盘？',
    type: 'single',
    options: ['后宫宫斗', '朝堂权谋', '侯府宅斗', '宫斗与朝堂交织'],
  },
  {
    id: 'palace_stakes',
    genres: ['palace', 'historical'],
    text: '权谋/宫斗里，核心在争什么？',
    type: 'single',
    options: ['圣宠与位份', '储位与皇嗣', '家族存亡', '联姻局', '朝堂站队', '边关军权'],
  },
  {
    id: 'mystery_focus',
    genres: ['mystery', 'thriller'],
    text: '悬疑线你最在意哪类？',
    type: 'single',
    options: ['查真相但慢揭示', '连环事件压迫', '密室/封闭空间', '身份反转', '旧案翻案', '谍报与双面'],
  },
  {
    id: 'horror_style',
    genres: ['horror', 'folklore', 'infinite'],
    text: '恐怖/怪谈气质偏向？',
    type: 'single',
    options: ['心理压迫', '规则怪谈', '民俗志怪', '生存逃生', '未知实体', '不必解释真相'],
  },
  {
    id: 'apocalypse_focus',
    genres: ['apocalypse', 'infinite'],
    text: '末日/副本压力主要来自？',
    type: 'single',
    options: ['资源匮乏', '人心互害', '怪物威胁', '规则惩罚', '组织操控', '寻找出路'],
  },
  {
    id: 'workplace_conflict',
    genres: ['workplace', 'urban', 'entertainment', 'medical'],
    text: '都市/职场冲突更想围绕？',
    type: 'single',
    options: ['项目生死', '舆论与人设', '上下级博弈', '家族资源', '理想与现实', '医疗伦理抉择'],
  },
  {
    id: 'wuxia_axis',
    genres: ['wuxia', 'fantasy', 'ability'],
    text: '武侠/奇幻主轴更偏？',
    type: 'single',
    options: ['江湖恩怨', '门派权争', '寻宝秘境', '修炼破境', '家国边关', '神魔规则'],
  },
  {
    id: 'revenge_tone',
    genres: ['revenge', 'rebirth'],
    text: '复仇/逆袭你想爽在哪？',
    type: 'single',
    options: ['打脸翻盘', '布局多年', '身份反转', '证据碾压', '以牙还牙', '放下与和解'],
  },
  {
    id: 'healing_pace',
    genres: ['healing', 'farming', 'campus'],
    text: '日常/治愈向节奏？',
    type: 'single',
    options: ['慢生活经营', '小确幸堆积', '邻里人情', '成长蜕变', '轻喜剧', '淡淡遗憾也可'],
  },
  {
    id: 'opening_scene',
    genres: [],
    always: true,
    text: '第一幕更想从哪种场面切入？',
    type: 'single',
    options: ['突发事件砸脸', '日常被打破', '被迫入局', '重逢/初见', '危机逃亡', '典礼/宴会'],
  },
  {
    id: 'tone',
    genres: [],
    always: true,
    text: '整体气质你更偏向？',
    type: 'single',
    options: ['偏甜', '偏虐', '悬疑压迫', '热血爽快', '治愈日常', '黑暗沉重'],
  },
  {
    id: 'ending',
    genres: [],
    always: true,
    text: '能接受的结局方向（可多选）',
    type: 'multi',
    options: ['HE', '开放式', 'BE 也可', '不必强行收束'],
  },
];

function parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function storySourceType(book) {
  const src = parseJson(book?.story_source, {});
  return ['title', 'upload', 'original'].includes(src?.type) ? src.type : 'original';
}

function needsScreenwriter(book) {
  // 穿越原创改由创建页「故事想法」直接注入大纲，不再单独编剧问诊
  return false;
}

function getScreenwriterStatus(book) {
  const stored = String(book?.screenwriter_status || '').trim();
  if (stored) return stored;
  return needsScreenwriter(book) ? 'pending' : 'skipped';
}

function buildQuestions(book) {
  const genres = Array.isArray(book.genres) ? book.genres : [];
  const genreSet = new Set(genres);
  const picked = [];
  const used = new Set();

  for (const q of QUESTION_POOL) {
    if (q.always) continue;
    const hit = (q.genres || []).some((g) => genreSet.has(g));
    if (!hit) continue;
    picked.push(q);
    used.add(q.id);
    if (picked.length >= 4) break;
  }

  for (const q of QUESTION_POOL) {
    if (!q.always || used.has(q.id)) continue;
    picked.push(q);
    used.add(q.id);
  }

  return {
    taboo_presets: TABOO_PRESETS,
    questions: picked.map((q) => {
      let options = q.options || [];
      const board = series.resolveIntrigueBoard(book);
      if (q.id === 'opening_scene' && board === 'domestic') {
        options = ['入府见各房', '宴会受冷落', '被迫入局', '重逢/初见', '主母立规矩', '典礼/寿宴'];
      } else if (q.id === 'opening_scene' && board === 'harem') {
        options = ['入宫分位份', '寿宴受冷落', '被迫入局', '重逢/初见', '贵妃立规矩', '典礼/选秀'];
      }
      if (q.id === 'palace_stakes' && board === 'domestic') {
        options = ['管家权与对牌', '亲事与人选', '嫡庶名节', '嫁妆与家产', '各房站队', '府内流言'];
      } else if (q.id === 'palace_stakes' && board === 'harem') {
        options = ['圣宠与位份', '子嗣与抚养', '后宫站队', '名节栽赃', '外戚借势', '联姻局'];
      } else if (q.id === 'palace_stakes' && board === 'ministerial') {
        options = ['相位与党争', '清党名单', '科举门生', '军功封赏', '联姻站队', '通商漕运'];
      }
      return {
        id: q.id,
        text: q.text,
        type: q.type,
        options,
      };
    }),
    genres_label: series.genreText(book.genres, book.genres_custom),
    era_label: series.resolveEra(book.era, book.era_custom),
    hint: '回答会用来在后台构思故事，不会把剧情梗概展示给你。',
  };
}

function formatAnswersForPrompt(questions, answers) {
  const map = Object.fromEntries((questions || []).map((q) => [q.id, q]));
  const lines = [];
  for (const [id, val] of Object.entries(answers || {})) {
    const q = map[id];
    if (!q) continue;
    const label = Array.isArray(val) ? val.join('、') : String(val || '').trim();
    if (!label) continue;
    lines.push(`${q.text} → ${label}`);
  }
  return lines.join('\n');
}

function resolveTaboos(selectedIds, customText) {
  const presetMap = Object.fromEntries(TABOO_PRESETS.map((t) => [t.id, t.label]));
  const fromPresets = (selectedIds || [])
    .map((id) => presetMap[id] || '')
    .filter(Boolean);
  const custom = String(customText || '')
    .split(/[；;，,\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  return [...new Set([...fromPresets, ...custom])].slice(0, 24);
}

async function generateStoryBrief(book, { answers, taboos }) {
  const settings = series.getSettings();
  series.requireSeriesApi(settings);
  const questions = buildQuestions(book).questions;
  const answerBlock = formatAnswersForPrompt(questions, answers);
  const prefs = series.normalizeRolePrefs(book.role_prefs || {});
  const prefsLine = [
    prefs.user_brief ? `用户期望身份：${prefs.user_brief}` : '',
    prefs.char_brief ? `同伴期望身份：${prefs.char_brief}` : '',
    prefs.user_lead_lock ? '用户锁定女主位' : '',
    prefs.char_lead_lock ? '同伴锁定男主位' : '',
  ].filter(Boolean).join('；');

  const sys = `你是长篇小说编剧。根据用户选的类型、背景、问卷与忌口，构思一本完整连续长篇的故事方案。
只输出合法 JSON，不要 markdown，不要向用户解释。
字段：logline(一句话)、synopsis(150字内完整走向)、core_conflict(核心矛盾)、relationship_arc(人物关系线)、opening_hook(开局场面)、ending_tone(结局气质)、must_avoid(数组，忌口再强调)、hook_engine(本局主线钩子，要具体，禁止亡国复国万能模板)`;

  const intrigueLine = series.intriguePlotEngineBlock(book);
  const board = series.resolveIntrigueBoard(book);
  const hookHint = board === 'domestic'
    ? 'opening_hook 须是内宅场面（入府、寿宴、立规矩）；hook_engine 须是嫡庶/亲事/管家权类人情矛盾。'
    : board === 'harem'
      ? 'opening_hook 须是后宫场面（入宫、位份、寿宴、恩宠）；hook_engine 须是位份/圣宠/站队类人情矛盾。'
      : board === 'ministerial'
        ? 'opening_hook 须是朝堂/世家场面（上朝、联姻、清党风波）；hook_engine 须是党争/站队/权柄易手。'
        : board
          ? 'opening_hook 须是人情权谋场面；hook_engine 须写清谁和谁争什么筹码。'
          : '';

  const user = `类型：${series.genreText(book.genres, book.genres_custom)}
背景：${series.resolveEra(book.era, book.era_custom)}
篇幅：${book.total_chapters} 章
${prefsLine ? `身份偏好：${prefsLine}\n` : ''}${intrigueLine ? `${intrigueLine}\n` : ''}${hookHint ? `${hookHint}\n` : ''}
【问卷】
${answerBlock || '（用户未答）'}
【忌口·必须遵守】
${[...(taboos || []), ...(board ? ['抄家查封开局', '连章入狱审讯', '刑侦找真凶当全书主线'] : [])].filter((v, i, a) => a.indexOf(v) === i).join('；') || '（无）'}
硬性：synopsis 与 hook_engine 必须具体（谁、什么局面、什么代价），禁止「立冲突」「卷入核心事件」等空话。`;

  let raw = await callChatAPIComplete(settings, sys, user, 'memory');
  if (!raw) raw = await callChatAPIComplete(settings, sys, user, 'chat');
  const brief = series.extractJsonObject(raw || '{}');
  if (!brief || typeof brief !== 'object') {
    throw new Error('编剧构思失败，请重试');
  }
  return {
    logline: String(brief.logline || '').trim().slice(0, 200),
    synopsis: String(brief.synopsis || '').trim().slice(0, 600),
    core_conflict: String(brief.core_conflict || '').trim().slice(0, 300),
    relationship_arc: String(brief.relationship_arc || '').trim().slice(0, 300),
    opening_hook: String(brief.opening_hook || '').trim().slice(0, 200),
    ending_tone: String(brief.ending_tone || '').trim().slice(0, 120),
    hook_engine: String(brief.hook_engine || '').trim().slice(0, 300),
    must_avoid: Array.isArray(brief.must_avoid) ? brief.must_avoid.map(String).slice(0, 12) : [],
    answers,
    created_at: new Date().toISOString(),
  };
}

function screenwriterBriefBlock(book) {
  const brief = parseJson(book?.story_brief, null);
  const taboos = parseJson(book?.story_taboos, []);
  if (!brief && !taboos.length) return '';

  const lines = ['【编剧构思·引擎专用·用户未看过·硬性落实】'];
  if (brief?.hook_engine) lines.push(`本局主线钩子：${brief.hook_engine}`);
  if (brief?.logline) lines.push(`Logline：${brief.logline}`);
  if (brief?.synopsis) lines.push(`故事走向：${brief.synopsis}`);
  if (brief?.core_conflict) lines.push(`核心矛盾：${brief.core_conflict}`);
  if (brief?.relationship_arc) lines.push(`关系线：${brief.relationship_arc}`);
  if (brief?.opening_hook) lines.push(`开局场面：${brief.opening_hook}`);
  if (brief?.ending_tone) lines.push(`结局气质：${brief.ending_tone}`);

  const allTaboos = [...new Set([
    ...taboos,
    ...(Array.isArray(brief?.must_avoid) ? brief.must_avoid : []),
  ])].filter(Boolean);
  if (allTaboos.length) {
    lines.push(`【用户忌口·禁止出现】${allTaboos.join('；')}`);
  }
  return lines.join('\n');
}

function getQuestions(bookId) {
  const book = series.getBook(bookId);
  if (!book) throw new Error('剧本不存在');
  if (!needsScreenwriter(book)) {
    return { needed: false, status: getScreenwriterStatus(book) };
  }
  return {
    needed: true,
    status: getScreenwriterStatus(book),
    ...buildQuestions(book),
  };
}

async function submitAnswers(bookId, payload = {}) {
  const book = series.getBook(bookId);
  if (!book) throw new Error('剧本不存在');
  if (!needsScreenwriter(book)) {
    db.prepare(`UPDATE series_books SET screenwriter_status='skipped', updated_at=datetime('now') WHERE id=?`).run(bookId);
    return { ok: true, skipped: true };
  }

  const taboos = resolveTaboos(payload.taboo_ids, payload.taboo_custom);
  const answers = payload.answers && typeof payload.answers === 'object' ? payload.answers : {};

  const brief = await generateStoryBrief(book, { answers, taboos });
  db.prepare(`
    UPDATE series_books SET story_brief=?, story_taboos=?, screenwriter_status='done', updated_at=datetime('now') WHERE id=?
  `).run(JSON.stringify(brief), JSON.stringify(taboos), bookId);

  return { ok: true, status: 'done' };
}

function skipScreenwriter(bookId) {
  const row = db.prepare('SELECT * FROM series_books WHERE id=?').get(bookId);
  if (!row) throw new Error('剧本不存在');
  db.prepare(`UPDATE series_books SET screenwriter_status='skipped', updated_at=datetime('now') WHERE id=?`).run(bookId);
  return { ok: true, status: 'skipped' };
}

module.exports = {
  TABOO_PRESETS,
  needsScreenwriter,
  getScreenwriterStatus,
  buildQuestions,
  getQuestions,
  submitAnswers,
  skipScreenwriter,
  screenwriterBriefBlock,
};

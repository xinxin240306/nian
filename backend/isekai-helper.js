/** 穿越：与角色共同进入剧本世界，按大纲扮演推动剧情 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { callChatAPIComplete, formatApiBillingError, resolveTaskApiCreds } = require('./api-helper');
const dreamHelper = require('./dream-helper');
const series = require('./series-helper');
const loreHelper = require('./isekai-lore-helper');
let iconv = null;
try { iconv = require('iconv-lite'); } catch (_) { iconv = null; }

function getBook(bookId, { includeSecrets = true } = {}) {
  // 引擎内部默认带真身份锁；对外 API 走 series.getBook() 默认不带秘密
  const book = series.getBook(bookId, { includeSecrets });
  if (!book) return null;
  if (book.mode !== 'isekai') throw new Error('这不是穿越剧本');
  return book;
}

function publicBook(bookId) {
  return getBook(bookId, { includeSecrets: false });
}

function isSystemAlertTurn(turn) {
  if (!turn || turn.kind !== 'system') return false;
  const meta = turn.meta && typeof turn.meta === 'object' ? turn.meta : {};
  const sysType = meta.type || '';
  const content = String(turn.content || '');
  if (isSituationAlertTurn(turn)) return true;
  if (sysType === 'warn' || sysType === 'shock') return true;
  if (/系统·惩罚|【系统·惩戒】/.test(content)) return true;
  if (sysType === 'anchor_warn' || /【系统·因果警戒】/.test(content)) return true;
  return false;
}

function isSituationAlertTurn(turn) {
  if (!turn || turn.kind !== 'system') return false;
  const meta = turn.meta && typeof turn.meta === 'object' ? turn.meta : {};
  const sysType = meta.type || '';
  const content = String(turn.content || '');
  if (sysType === 'situation') return true;
  if (/^【系统[·・.]?警告】/.test(content)) return true;
  // 开篇须知（世界/禁止项），不是真违规惩罚
  if (/禁止对原住民暴露|禁止项：/.test(content) && /系统.?警告/.test(content)) return true;
  return false;
}

/** 章节回合里的开篇须知卡全部删掉；规则改由剧本页合成一张 */
function purgeSituationTurns(bookId) {
  const rows = db.prepare(
    `SELECT * FROM series_turns WHERE book_id=? AND kind='system'`
  ).all(bookId);
  for (const r of rows) {
    const turn = { ...r, meta: series.parseJson(r.meta, {}) };
    if (!isSituationAlertTurn(turn)) continue;
    try { db.prepare('DELETE FROM series_turns WHERE id=?').run(r.id); } catch (_) { /* ignore */ }
  }
}

function findBookSituationTurn(bookId) {
  const rows = db.prepare(
    `SELECT * FROM series_turns WHERE book_id=? AND kind='system' ORDER BY id ASC`
  ).all(bookId);
  for (const r of rows) {
    const turn = { ...r, meta: series.parseJson(r.meta, {}) };
    if (isSituationAlertTurn(turn)) return turn;
  }
  return null;
}

/** 剧本页集中展示：违规/因果等系统警告（不在章节内重复展示） */
function listBookWarnTurns(bookId) {
  const book = series.getBook(bookId);
  if (!book || book.mode !== 'isekai') return [];
  purgeSituationTurns(bookId);
  const rows = db.prepare(
    `SELECT * FROM series_turns WHERE book_id=? AND kind='system' ORDER BY id ASC`
  ).all(bookId);
  const violations = rows.map((r) => ({
    ...r,
    meta: series.parseJson(r.meta, {}),
  })).filter(isSystemAlertTurn).filter((t) => !isSituationAlertTurn(t));
  const sit = {
    id: -Number(bookId) || -1,
    book_id: bookId,
    chapter_no: 0,
    kind: 'system',
    content: formatSituationCard(book, null),
    meta: { type: 'situation' },
  };
  return [sit, ...violations];
}

function listTurns(bookId, chapterNo) {
  return db.prepare(
    `SELECT * FROM series_turns WHERE book_id=? AND chapter_no=? ORDER BY id ASC`
  ).all(bookId, chapterNo).map((r) => ({
    ...r,
    meta: series.parseJson(r.meta, {}),
  }));
}

function addTurn(bookId, chapterNo, kind, content, meta = {}) {
  const r = db.prepare(
    `INSERT INTO series_turns (book_id, chapter_no, kind, content, meta) VALUES (?,?,?,?,?)`
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

function systemRulesText() {
  return `【穿越系统】本世界存在「系统」面板（剧内机制，不是现实程序）。面板分工：
· 【系统·局面】每章发布【${CHAPTER_SCENE_LABEL}】（这一幕要落成什么局面，可一项或多项），不写死做法；这一幕落地后可收束本章。不另发支线任务。
· 【系统·警告】只在剧本页展示一次（世界与禁止项），章节开篇不要写、不要重发。
· 【系统·惩罚】违规时弹出并真实生效：电击示警、本章禁言（只能动作不能对白）、世界难度提升（更难糊弄、敌对武力增强）、强制伪装；同伴违规时用户也能看到。
· 【剧情】【同伴】卡只写现场剧情/言行，禁止夹带系统文案。
· 不向用户展示同伴隐藏节拍；不直说真身份秘密。
· 同伴看不到用户任务原文；在尚未凭行为推断出「对方是穿越同伴」前，只按剧中人关系互动，不要默认已认亲。
· 危险按「这个人会怎么做」反应，并顾忌系统检测违规；不强制收起性格。
【正常穿越·分场】两人一起穿越进剧本，但因剧中身份不同，落地场景/出场点可以不同——这是正常分场，不是陪玩拆开。尚未碰面时，各自只在自己身份场景里行动，自然不会「隔空发手机消息」；碰面之后若再分头，才可能有符合时代的通讯（古代可能是传话/纸条，现代才可能是手机）。
【表面身份约束·双方同等】用户与同伴都必须按表面身份演戏（含残疾/地位/职业限制）。例：表面是盲人，就算穿越者能看见，也必须装作看不见，骗过剧中人与系统；不可因为是「主角同伴」就开挂、破身份、过度赋魅。
双方都要完成各自身份线的本章任务，同样受系统检测。
用户与同伴都没有剧情光环：会受伤、会感染；丧尸等设定下被咬可变异，不因穿越者身份免疫。
常见违规：明说真身份；对原住民暴露穿越身份；当着原住民讨论剧本结局/故事走向/系统任务等破壁内容；恶意崩坏主线；拒演逃出；明显违背表面身份约束（如盲人却当众精准「看见」并指挥）；气到当众破人设说破穿越。
不算违规：私下嘀咕「咱们是穿越的」；未当着原住民时的试探/半信半疑猜测；按性格对过界亲密戏生气/留下旁观/事后发作（未说破穿越、未拒演崩主线）。`;
}

/** 互认与客观写法：贯穿开场/同伴卡/续写 */
function mutualRecognitionRules({ hasIdentityMemory = false, recog = null } = {}) {
  const userKnows = !!(recog?.mutual || recog?.userKnowsCompanion);
  const companionKnows = !!(recog?.mutual || recog?.companionKnowsUser);
  const mutual = !!(recog?.mutual || (userKnows && companionKnows));
  const memHint = hasIdentityMemory || userKnows || companionKnows;

  let phase = '';
  if (mutual) {
    phase = `【阶段·双方已互认/摊牌】
· 双方已确认彼此是穿越同伴：不要假装没发生、又倒退成「初次试探对方是不是穿越者」。
· 私下（无原住民旁听）可按熟人/同伴互动：配合、损、商量、拌嘴都可以，跟性格走；当着原住民仍须演剧中人设，禁止当众破壁谈穿越/系统任务/剧本结局。
· 剧情必要的盘问/对质仍可走（案情、剧中身份、当着原住民演戏式质询）——动机是剧中事件，不是「再怀疑一次对方是不是穿越」。
· 【卡面】可用同伴卡（剧中名）；认人已结束，禁止整章只写认人余波，戏份回到本章锁定节拍。
· 描写仍客观：知情后的态度变化要落在可观察言行上；做了写做了，没做不要编「心有灵犀」式添油。`;
  } else if (userKnows && !companionKnows) {
    phase = `【阶段·用户已认出同伴，同伴未必已知】
· 用户侧已知「对方是穿越同伴」：不要倒退成用户完全不知情；也不要写成双方已摊牌互认。
· 同伴侧仍可半信半疑或尚未确认：禁止写成同伴已心知肚明地认亲；同伴按性格反应即可。
· 【卡面】用户已认出 → 可用同伴卡（剧中名）。
· 描写：用户可以按「已知是同伴」去试探/试探性配合，但旁白不要替同伴提前摊牌；客观写双方实际言行。`;
  } else if (companionKnows && !userKnows) {
    phase = `【阶段·同伴单方面知情，用户尚未认出】
· 跨章只升不降：同伴心里知情须延续，禁止遗忘成「从未认出」；外在只按「这个人会做的事」写可观察言行，不要为认人加戏。
· 【禁止引导用户认出】禁止彩蛋梗、意味深长眼神、旁白暗示「你该认出他了」、把场面写成认人谜题。认不认出由用户自己决定。
· 禁止旁白点破「他已认出你」；禁止用户侧写成已认出。
· 【卡面】同伴戏份并入剧情旁白，禁止单独同伴卡泄题。`;
  } else {
    phase = `【阶段·双方均未确认谁是穿越同伴】
· 禁止开场/一见面就认出、心照不宣；用户还没做出反常依据时，同伴绝不能已当穿越同伴对待。
· 【禁止引导认人】禁止彩蛋与重暗示旁白；只写可观察言行。
· 【卡面】同伴出入场写进剧情旁白，禁止单独同伴卡。`;
  }

  return `【认人阶段·按当前记忆执行·硬性】
${phase}
· 双方开局都知道「一起穿进剧本了」，但「眼前这人是不是我的同伴」只能靠剧情与可观察言行推断；禁止上帝视角旁白直接写破。
· ${memHint ? '身份认知记忆已写明谁知情时，按上面【阶段】演，禁止无故降级遗忘。' : '当前无「已确认是穿越同伴」记忆时，按未确认阶段演。'}
${objectiveProseRules({ userKnowsCompanion: userKnows })}
【破壁·系统会罚】当着原住民禁止讨论：剧本结局/故事走向/下一章/系统任务原文/「我们是穿越的」等。私下嘀咕另论；当众说破 → 系统违规。`;
}

/**
 * 旁白客观规则：未认出前禁止引导认人；认出后仍客观，但允许知情互动
 */
function objectiveProseRules({ userKnowsCompanion = false } = {}) {
  if (userKnowsCompanion) {
    return `【写法·客观·用户已认出同伴后】
· 只写当场可观察的言行、场景与结果：做了就写做了，没做的不要添油加醋（禁止编「其实他想……」「目光里藏着……」当众当事实）。
· 不偏袒：双方同等客观，不要为抬一方硬加深情滤镜。
· 认人已成立：不要再写「引导认出」式谜题；也不要倒退成陌生人试探。知情后的熟络/配合/损，落在实际台词与动作上即可。
· 当着原住民仍演剧中人设；私下才可更像穿越同伴相处。
· 旁白叙述用户一律用「你」，禁止用剧中姓名当叙述主语；以用户所见所闻为主；禁止全知替任一方编造未发生的内心戏当众写破。
${companionToneLeakRules({ afterUserRecognized: true })}`;
  }
  return `【写法·客观·用户尚未认出同伴】
· 只写当场可观察的言行、场景与结果：做了就写做了，没做的不要添油加醋，不要补「其实他想……」「仿佛在无声地说……」「目光里藏着……」。
· 不偏袒任何一方：用户与同伴（及原住民）同等客观；禁止故意抬一方压一方。
· 禁止重暗示认人旁白：「无比熟悉」「过于温柔」「意味深长」「似曾相识」「像在确认什么」「只有你懂的眼神」等一律禁止。
· 禁止引导认人：不要写彩蛋式台词/动作等用户醒悟；不要旁白提示「你该认出他了」。
· 旁白叙述用户一律用「你」，禁止用剧中姓名当叙述主语；以用户所见所闻为主，不要全知内心；禁止替用户或同伴编造未发生的心理独白当众写出来。
${companionToneLeakRules({ afterUserRecognized: false })}`;
}

/**
 * 同伴语气泄题：柔和/放水只能在「认为对手是用户」之后
 * afterUserRecognized：用户侧已认出（同伴卡可用）时，仍要求柔和与「同伴是否认用户」挂钩，不能无脑柔光
 */
function companionToneLeakRules({ afterUserRecognized = false } = {}) {
  return `【同伴语气·防泄题·硬性】
· 旁白写同伴开口时：口吻必须先贴剧中人设（冷酷就冷、正经就正经）。禁止堆「嗓音里带着漫不经心和柔和，却透着彻骨寒意」这类互相打架的滤镜句——又冷又柔等于告诉读者「此人特殊」。
· 「漫不经心/不耐烦/敷衍」可以有：像穿越者演得不太沉浸、或真性格懒得正经，但仍须落在人设允许的范围内（冷讽、懒理、短句），不要再叠「柔和」。
· 「柔和 / 温柔 / 放缓 / 放水 / 对你格外耐心 / 语气软一寸」等特殊优待：仅当同伴已确认或强烈怀疑「眼前对手戏的人就是穿越同伴（用户）」时，才可分一点点；也可认错人而误放水——但必须有依据（反常言行），禁止无差别对每个女主/路人都柔光。
· ${afterUserRecognized
    ? '用户已认出同伴：同伴若也知情/互认，私下可更自然；若同伴尚未确认用户，仍禁止无故柔和放水。当着原住民禁止因「自己人」破人设变温柔。'
    : '用户尚未认出同伴：一律禁止用柔和/宠溺/心软滤镜描写同伴对用户；同伴应像对普通剧中人一样演。否则用户会凭旁白特殊待遇直接猜出谁是同伴。'}
· 写声音/眼神：只写可观察事实（声线高低、是否冷淡、是否不耐烦），禁止「透着……却又……」「藏着只有你懂的温度」等抒情判词。`;
}

/** 用户是否已认出穿越同伴（决定能否出「同伴卡」） */
function userRecognizedCompanion(recog) {
  return !!(recog && (recog.mutual || recog.userKnowsCompanion));
}

/** 同伴是否已认出用户（跨章只升不降，须延续） */
function companionRecognizedUser(recog) {
  return !!(recog && (recog.mutual || recog.companionKnowsUser));
}

const CANON_MUTUAL_MEMORY = '用户↔同伴已互认/摊牌：双方确认彼此是穿越同伴';
const CANON_USER_KNOWS_MEMORY = '用户已确认同伴是穿越同伴（尚未完全互认）';
const CANON_COMPANION_KNOWS_MEMORY = '同伴已确认用户是穿越同伴（尚未完全互认）';

const CHAPTER_SCENE_LABEL = '本章局面';
const MEMORY_STAGE_LABELS = ['封忆', '裂痕', '半醒', '记尘'];

/** 创建时填了身份或锁男女主 → 同伴封穿越记忆；随机定角走认人 */
function shouldActivateMemoryLock(book) {
  const p = series.readRolePrefsFromBook(book);
  return !!(p.user_brief || p.char_brief || p.user_lead_lock || p.char_lead_lock);
}

function emptyMemoryLock() {
  return {
    active: false,
    stage: 0,
    resonance: 0,
    disclosed: false,
    mask: 'honest',
    bond_seeds: [],
    seeds_used: {},
  };
}

function readMemoryLock(identityLock) {
  const raw = identityLock?.memory_lock;
  if (!raw || typeof raw !== 'object') return emptyMemoryLock();
  return {
    active: !!raw.active,
    stage: Math.max(0, Math.min(3, Number(raw.stage) || 0)),
    resonance: Math.max(0, Math.min(100, Number(raw.resonance) || 0)),
    disclosed: !!raw.disclosed,
    mask: ['honest', 'tease', 'scheming'].includes(raw.mask) ? raw.mask : 'honest',
    bond_seeds: Array.isArray(raw.bond_seeds) ? raw.bond_seeds : [],
    seeds_used: raw.seeds_used && typeof raw.seeds_used === 'object' ? raw.seeds_used : {},
  };
}

function inferMemoryMaskFromChar(char) {
  const p = String(char?.personality || char?.speech || '');
  if (/(腹黑|算计|城府|恶劣|使坏|爱逗|恶作剧|坑人|恶趣味|玩世不恭)/.test(p)) return 'tease';
  if (/(冷淡|冷漠|矜持|骄傲|别扭|嘴硬|不愿示弱|闷骚)/.test(p)) return 'scheming';
  return 'honest';
}

function buildBondSeedsFallback(char) {
  const core = char ? series.charCoreForSeries(char) : { personality: '' };
  const p = String(core.personality || '');
  const seeds = [];
  if (/怕|惧|恐|胆小/.test(p)) {
    seeds.push({
      id: 'fear_calm',
      hint: '危险或紧张时，用只有熟人才会用的方式安抚（挡在身前、轻拍手背等）',
      scene_tags: ['危险', '安抚', '私下', '冲突'],
    });
  }
  if (/吃|馋|挑食|口味/.test(p)) {
    seeds.push({
      id: 'food_habit',
      hint: '递食物、点菜或忌口方面的习惯性举动',
      scene_tags: ['用餐', '递物', '私下'],
    });
  }
  seeds.push({
    id: 'handoff_gesture',
    hint: '递东西、交物时的标志性小动作或顺序',
    scene_tags: ['递物', '给予', '私下', '同桌'],
  });
  seeds.push({
    id: 'protect_instinct',
    hint: '危险瞬间本能护住用户、下意识挡在前面的姿态',
    scene_tags: ['危险', '冲突', '保护'],
  });
  return seeds.slice(0, 3).map((s) => ({ ...s, min_stage: 0 }));
}

function initMemoryLockForBegin(book, char) {
  if (!shouldActivateMemoryLock(book)) return emptyMemoryLock();
  return {
    active: true,
    stage: 0,
    resonance: 0,
    disclosed: false,
    mask: inferMemoryMaskFromChar(char),
    bond_seeds: buildBondSeedsFallback(char),
    seeds_used: {},
  };
}

function persistMemoryLock(bookId, memoryLock, identityLock = null) {
  let lock = identityLock;
  if (!lock) {
    try { lock = getBook(bookId)?.identity_lock || {}; } catch { lock = {}; }
  }
  const next = { ...(lock && typeof lock === 'object' ? lock : {}), memory_lock: memoryLock };
  try {
    db.prepare(`UPDATE series_books SET identity_lock=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(next), bookId);
  } catch (e) {
    console.warn('[isekai] persist memory_lock', e.message);
  }
  return next;
}

/** 封忆本：用户开局已知同伴剧中身份（与随机认人不同） */
function userKnowsCompanionScriptIdentity(book) {
  return readMemoryLock(book?.identity_lock).active;
}

/** 同伴是否已在引擎侧恢复穿越记忆（玩家未必知道） */
function companionCrossingMemoryRestored(memoryLock) {
  const ml = memoryLock && memoryLock.active ? memoryLock : emptyMemoryLock();
  return ml.active && ml.stage >= 3;
}

function companionMemoryDisclosedToUser(memoryLock) {
  const ml = memoryLock && memoryLock.active ? memoryLock : emptyMemoryLock();
  if (!companionCrossingMemoryRestored(ml)) return false;
  if (ml.mask === 'honest') return true;
  return !!ml.disclosed;
}

function formatMemoryStageNotice(memoryLock) {
  const stage = Number(memoryLock?.stage) || 0;
  if (stage <= 0) return '';
  if (stage >= 3 && !companionMemoryDisclosedToUser(memoryLock)) {
    return '【系统·记忆】同伴有一瞬像要说什么，又若无其事地收回——表里仍按剧中人演。';
  }
  if (stage === 1) return '【系统·记忆】同伴神情有一瞬恍惚，很快又收回；仍当你是剧中身份里的人。';
  if (stage === 2) return '【系统·记忆】旁听时，同伴低声说「你让我觉得莫名熟悉」——仍未想起穿越，勿当众谈破壁。';
  if (stage >= 3) return '【系统·记忆】记尘已恢复：同伴私下应已想起穿越；当着原住民仍须演戏。';
  return '';
}

function formatMemoryLockPromptBlock(book, char, memoryLock) {
  if (!memoryLock?.active) return '';
  const cn = book.char_role || book.identity_lock?.char?.surface_name || '同伴';
  const stage = Number(memoryLock.stage) || 0;
  const restored = companionCrossingMemoryRestored(memoryLock);
  const disclosed = companionMemoryDisclosedToUser(memoryLock);
  const seeds = (memoryLock.bond_seeds || []).slice(0, 4)
    .map((s) => `- ${s.id}：${s.hint}（场景：${(s.scene_tags || []).join('/')}）`)
    .join('\n');
  const maskLine = memoryLock.mask === 'tease'
    ? '腹黑/爱逗型：记尘满后也可继续装不知道，私下记得一切，按性格逗用户、享受信息不对称；禁止旁白替玩家点破。'
    : memoryLock.mask === 'scheming'
      ? '矜持/闷骚型：记尘满后仍可不摊牌，只从可观察言行渗一点熟络；禁止旁白点破。'
      : '记尘满后私下可承认穿越；当着原住民仍演戏。';
  return `【封忆·同伴穿越记忆已封存】
用户开局已知同伴剧中身份「${cn}」；同伴真当自己就是原住民，**不记得穿越**。禁止靠谈穿越/系统解锁；用户用戏内羁绊（习惯、护短、口味等）触发共振。
记尘阶段：${stage}/3（${MEMORY_STAGE_LABELS[stage] || '封忆'}）共振：${memoryLock.resonance || 0}/100
引擎真状态：${restored ? '已恢复穿越记忆' : '仍封忆'}｜对用户表露：${disclosed ? '已表露/可私下谈穿越' : '未表露/仍演剧中人'}
${maskLine}
羁绊种子（引擎判定用，勿写成旁白提示玩家）：
${seeds || '（无）'}
· 封忆期同伴禁止主动说破穿越、系统、回归；用户提穿越会被当异类。
· 共振命中时：只写可观察反应（愣住、卡壳、扶额、问「你怎么知道」），禁止当场喊「我想起来了我们是穿越的」。
· 占有欲等真性格可渗进戏（亲密戏吃醋、提醒「你现在演的是谁」），跟性格走，禁止统一模板。`;
}

function formatMemoryResonanceRouteRules(memoryLock) {
  if (!memoryLock?.active || memoryLock.stage >= 3) return '';
  return `
【记尘共振·路由】用户行动若与羁绊种子语义贴合且场景合理（递物时做递物习惯等），输出：
"resonance_hit":true,"resonance_strength":1-3,"resonance_seed_id":"种子id","resonance_scene_ok":true
当众命中 strength 最高 2；用户提穿越/系统 → resonance_hit 必须 false。
同一 seed_id 本章已用过 → 不重复 hit。瞎编同伴不可能知道的事 → false。`;
}

function applyMemoryResonance(memoryLock, route, chapterNo) {
  const ml = { ...memoryLock, bond_seeds: [...(memoryLock.bond_seeds || [])], seeds_used: { ...(memoryLock.seeds_used || {}) } };
  if (!ml.active || ml.stage >= 3) return { lock: ml, changed: false, stageUp: false };
  const hit = route.resonance_hit === true || route.resonance_hit === 1 || route.resonance_hit === 'true';
  if (!hit || route.resonance_scene_ok === false) return { lock: ml, changed: false, stageUp: false };
  const seedId = String(route.resonance_seed_id || '').trim();
  const usedKey = `${chapterNo}:${seedId}`;
  if (seedId && ml.seeds_used[usedKey]) return { lock: ml, changed: false, stageUp: false };
  let strength = Math.max(1, Math.min(3, Number(route.resonance_strength) || 1));
  const delta = strength === 3 ? 25 : (strength === 2 ? 15 : 8);
  const prevStage = ml.stage;
  ml.resonance = Math.min(100, (Number(ml.resonance) || 0) + delta);
  if (seedId) ml.seeds_used[usedKey] = true;
  let stageUp = false;
  if (ml.stage < 1 && ml.resonance >= 20) { ml.stage = 1; stageUp = true; }
  if (ml.stage < 2 && ml.resonance >= 55) { ml.stage = 2; stageUp = true; }
  if (ml.stage < 3 && ml.resonance >= 85 && strength >= 2) {
    ml.stage = 3;
    ml.disclosed = ml.mask === 'honest';
    stageUp = true;
  }
  return { lock: ml, changed: true, stageUp: stageUp || ml.stage !== prevStage };
}

/** 用户侧是否可用同伴卡（认人 或 封忆已知身份） */
function userCanUseCompanionCard(book, recog) {
  if (userKnowsCompanionScriptIdentity(book)) return true;
  return userRecognizedCompanion(recog);
}

function formatCompanionCardRule(book, recog, { companionKnowsOnly = false } = {}) {
  const cn = book.char_role || '同伴所扮之人';
  if (userKnowsCompanionScriptIdentity(book)) {
    const ml = readMemoryLock(book?.identity_lock);
    return `【卡面】用户已知同伴剧中身份「${cn}」；同场可用同伴卡。${ml.active && !companionCrossingMemoryRestored(ml) ? '同伴封忆中：只演原住民，不记得穿越；禁止旁白点破记尘进度。' : '勿当众破壁谈穿越。'}`;
  }
  if (userRecognizedCompanion(recog)) {
    return '【卡面】用户已认出同伴：可用剧中名同伴卡；勿再写引导认人谜题，也勿倒退成陌生人。';
  }
  return `【卡面】用户尚未认出穿越同伴：若「${cn}」在场，当作普通剧中人写进旁白，禁止单独同伴卡口吻、禁止标签泄题。${companionKnowsOnly ? '禁止引导认人；只写可观察事实，客观不偏袒。' : ''}`;
}

/** 读取置顶身份认知原文 */
function listIdentityMemoryLines(bookId) {
  try {
    const rows = db.prepare(`
      SELECT content FROM series_memories
      WHERE book_id=? AND (pinned=1 OR kind='identity')
      ORDER BY id DESC LIMIT 24
    `).all(bookId);
    return (rows || []).map((r) => String(r.content || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emptyRecognition() {
  return {
    lines: [],
    mutual: false,
    userKnowsCompanion: false,
    companionKnowsUser: false,
    notes: '',
  };
}

function readStoredCrossingRecog(book) {
  const raw = book?.identity_lock?.crossing_recog;
  if (!raw || typeof raw !== 'object') return emptyRecognition();
  const mutual = !!raw.mutual;
  return {
    lines: [],
    mutual,
    userKnowsCompanion: !!(mutual || raw.userKnowsCompanion),
    companionKnowsUser: !!(mutual || raw.companionKnowsUser),
    notes: String(raw.note || '').trim(),
  };
}

/**
 * 从正文/总结里硬判认人（不依赖模型抽记忆的措辞）
 * 半信半疑、试探不算；摊牌/原来你也是穿越 等才算。
 */
function inferRecognitionFromText(text, { companionName = '', userRole = '' } = {}) {
  const t = String(text || '');
  if (!t.trim()) return emptyRecognition();
  const cn = String(companionName || '').trim();
  const un = String(userRole || '').trim();
  const crossing = /(穿越|一起穿|同穿|穿进来|穿过来|不是原住民|不是这个世界|同为穿越|穿越同伴|穿越者)/;
  const strong = /(摊牌|互认|已确认|确认了|已认出|彼此承认|互相确认|心知肚明|当面承认|原来你也是|你也是穿越|我们都是穿越|咱们都是穿越|都是穿越来的|就是穿越同伴)/;
  const uncertainOnly = /(半信|怀疑|可能是|也许是|不确定|试探|猜测是不是|会不会是)/.test(t) && !strong.test(t);
  if (uncertainOnly) return emptyRecognition();

  const nameHit = (name) => name && t.includes(name);
  const mutual = strong.test(t) && (
    /(摊牌|互认|彼此|互相|我们都是穿越|咱们都是穿越|原来你也是|你也是穿越)/.test(t)
    || (crossing.test(t) && /(都承认|都确认|彼此确认)/.test(t))
  )
    || (crossing.test(t) && /(原来是你|原来你是|你也是).{0,16}(穿越|穿过来|穿进来|同伴)/.test(t))
    || /(你就是我的同伴|你也是我的同伴|我们是一起穿|咱们是一起穿)/.test(t);
  let userKnows = mutual || (
    strong.test(t) && (
      /(我|你|用户).{0,20}(认出|确认|知道).{0,16}(同伴|穿越)/.test(t)
      || /原来你是.{0,10}(同伴|穿越)/.test(t)
      || (nameHit(cn) && crossing.test(t) && /(认出|确认|原来).{0,12}/.test(t) && (/(我|你|用户)/.test(t) || nameHit(un)))
    )
  );
  let companionKnows = mutual || (
    strong.test(t) && (
      /(同伴|他).{0,20}(认出|确认|知道).{0,16}(你|用户|穿越)/.test(t)
      || (nameHit(cn) && crossing.test(t) && new RegExp(`${escapeRegExp(cn)}.{0,16}(认出|确认|知道)`).test(t))
    )
  );
  if (mutual) {
    userKnows = true;
    companionKnows = true;
  }
  return {
    lines: [],
    mutual: !!mutual,
    userKnowsCompanion: !!userKnows,
    companionKnowsUser: !!companionKnows,
    notes: '',
  };
}

function mergeRecognition(...parts) {
  const out = emptyRecognition();
  const lines = [];
  for (const p of parts) {
    if (!p) continue;
    if (p.mutual) out.mutual = true;
    if (p.userKnowsCompanion) out.userKnowsCompanion = true;
    if (p.companionKnowsUser) out.companionKnowsUser = true;
    if (Array.isArray(p.lines)) lines.push(...p.lines);
    if (p.notes) lines.push(p.notes);
  }
  if (out.userKnowsCompanion && out.companionKnowsUser) out.mutual = true;
  if (out.mutual) {
    out.userKnowsCompanion = true;
    out.companionKnowsUser = true;
  }
  out.lines = [...new Set(lines.map((x) => String(x || '').trim()).filter(Boolean))];
  out.notes = out.lines.slice(0, 8).map((l) => `- ${l}`).join('\n');
  return out;
}

/** 已互认只升不降：写入 identity_lock.crossing_recog + 置顶标准记忆句 */
function persistCrossingRecognition(bookId, chapterNo, inferred) {
  if (!inferred || !(inferred.mutual || inferred.userKnowsCompanion || inferred.companionKnowsUser)) return inferred;
  let book = null;
  try { book = getBook(bookId); } catch (_) { book = null; }
  const lock = (book?.identity_lock && typeof book.identity_lock === 'object') ? { ...book.identity_lock } : {};
  const prev = readStoredCrossingRecog({ identity_lock: lock });
  const next = mergeRecognition(prev, inferred);
  const changed = prev.mutual !== next.mutual
    || prev.userKnowsCompanion !== next.userKnowsCompanion
    || prev.companionKnowsUser !== next.companionKnowsUser;
  if (changed) {
    lock.crossing_recog = {
      mutual: !!next.mutual,
      userKnowsCompanion: !!next.userKnowsCompanion,
      companionKnowsUser: !!next.companionKnowsUser,
      chapter_no: Number(chapterNo) || Number(lock.crossing_recog?.chapter_no) || 0,
      note: next.mutual ? CANON_MUTUAL_MEMORY : (next.userKnowsCompanion ? CANON_USER_KNOWS_MEMORY : CANON_COMPANION_KNOWS_MEMORY),
    };
    try {
      db.prepare(`UPDATE series_books SET identity_lock=?, updated_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(lock), bookId);
    } catch (e) {
      console.warn('[isekai] persist crossing_recog', e.message);
    }
  }
  if (next.mutual) insertMemory(bookId, chapterNo, CANON_MUTUAL_MEMORY, 'identity', 1);
  else if (next.userKnowsCompanion) insertMemory(bookId, chapterNo, CANON_USER_KNOWS_MEMORY, 'identity', 1);
  else if (next.companionKnowsUser) insertMemory(bookId, chapterNo, CANON_COMPANION_KNOWS_MEMORY, 'identity', 1);
  return next;
}

/** 过章/开章：用上章现场+总结把认人状态补回来（模型抽记忆失败时也能记住） */
function recoverCrossingRecognition(bookId, chapterNo, book) {
  const names = {
    companionName: book?.char_role || book?.identity_lock?.char?.surface_name || '',
    userRole: book?.user_role || book?.identity_lock?.user?.surface_name || '',
  };
  const chunks = [listIdentityMemoryLines(bookId).join('\n')];
  if (Number(chapterNo) > 1) {
    try {
      const h = collectPrevChapterHandoff(bookId, chapterNo, book);
      if (h) chunks.push(h.lastScene, h.plot, h.leftover, h.charMem);
    } catch (_) { /* ignore */ }
    try {
      const prev = series.getChapter(bookId, Number(chapterNo) - 1);
      if (prev?.content) chunks.push(String(prev.content).slice(-4500));
    } catch (_) { /* ignore */ }
  }
  try {
    const here = listTurns(bookId, chapterNo);
    if (here.length) chunks.push(recentTurnsText(here, 16));
  } catch (_) { /* ignore */ }
  const inferred = inferRecognitionFromText(chunks.filter(Boolean).join('\n'), names);
  persistCrossingRecognition(bookId, Number(chapterNo) > 1 ? Number(chapterNo) - 1 : chapterNo, inferred);
}

/**
 * 从身份记忆 + 书上锁定的认人状态推断互认
 * 注意：知道「真凶/女主」标签 ≠ 已确认对方是穿越同伴
 */
function parseCrossingRecognition(bookId, { companionName = '', userRole = '', book = null } = {}) {
  let stored = emptyRecognition();
  try {
    stored = readStoredCrossingRecog(book || getBook(bookId));
  } catch (_) { stored = emptyRecognition(); }

  const lines = listIdentityMemoryLines(bookId);
  const blob = lines.join('\n');
  if (!blob && !stored.mutual && !stored.userKnowsCompanion && !stored.companionKnowsUser) {
    return emptyRecognition();
  }
  const cn = String(companionName || '').trim();
  const un = String(userRole || '').trim();
  const aboutCrossing = /(穿越|同伴|一起穿|同穿|穿进来|不是原住民|也是穿越|用户↔同伴)/;
  const confirm = /(摊牌|互认|已确认|确认了|认出|已认出|彼此知晓|互相知道|心知肚明|坦白|说破|当面承认|已向对方|知道对方是)/;
  const canonMutual = lines.some((l) => /用户↔同伴已互认|双方确认彼此是穿越同伴/.test(l));
  const userKnowsCompanion = canonMutual || lines.some((l) => {
    if (!aboutCrossing.test(l) && !/同伴/.test(l)) return false;
    if (!confirm.test(l) && !/(用户|你|女主侧).{0,12}(知道|确认|认出|猜到)/.test(l)) return false;
    if (/(半信|怀疑|可能|也许|不确定)/.test(l) && !confirm.test(l)) return false;
    return /用户|你|玩家/.test(l) || (un && l.includes(un)) || /认出.{0,8}同伴|同伴.{0,8}(是|就是)/.test(l);
  }) || (confirm.test(blob) && aboutCrossing.test(blob) && /(用户|你).{0,20}(同伴|穿越)/.test(blob));
  const companionKnowsUser = canonMutual || lines.some((l) => {
    if (!aboutCrossing.test(l)) return false;
    if (!confirm.test(l) && !/(同伴|他).{0,12}(知道|确认|认出|猜到).{0,12}(用户|你|对方)/.test(l)) return false;
    if (/(半信|怀疑|可能|也许|不确定)/.test(l) && !confirm.test(l)) return false;
    return /同伴/.test(l) || (cn && l.includes(cn));
  }) || (/摊牌|互认|彼此|互相/.test(blob) && aboutCrossing.test(blob));
  const mutual = canonMutual
    || (/摊牌|互认|彼此确认|互相确认|心知肚明/.test(blob) && aboutCrossing.test(blob))
    || (userKnowsCompanion && companionKnowsUser);
  const fromMem = {
    lines,
    mutual: !!mutual,
    userKnowsCompanion: !!(mutual || userKnowsCompanion),
    companionKnowsUser: !!(mutual || companionKnowsUser),
    notes: '',
  };
  const merged = mergeRecognition(stored, fromMem);
  merged.lines = lines;
  merged.notes = lines.slice(0, 8).map((l) => `- ${l}`).join('\n')
    || (merged.mutual ? `- ${CANON_MUTUAL_MEMORY}` : '');
  return merged;
}

function formatRecognitionForQuest(recog, companionName = '') {
  if (!recog || (!recog.lines || !recog.lines.length)) {
    return '【身份认知·当前】尚无「已确认对方是穿越同伴」的置顶记忆；同伴按未互认演戏。本章任务只看锁定节拍，不因认人改写。';
  }
  const name = companionName || '同伴';
  if (recog.mutual || (recog.userKnowsCompanion && recog.companionKnowsUser)) {
    return `【身份认知·已摊牌/互认】
双方已确认彼此是穿越同伴（见记忆）。认人只改同伴演戏方式，不改本章锁定节拍，也不当过章条件。
· 不要因遗忘而倒退成「应对${name}试探你是不是穿越者」——互认已发生，认人线不是本章任务。
· 剧情必要的盘问仍可保留：例如${name}以男配/剧中身份盘问案情、当众演戏式质询——动机须是剧中事件，不是「怀疑对方穿越」。
· ${name} 戏份继续推本章锁定节拍与其他原住民；对用户可知情配合（对原住民仍演戏）。
· resistance 以原住民/环境为主；不要把穿越身份试探写成主要阻力。
置顶记忆：
${recog.notes}`;
  }
  if (recog.userKnowsCompanion || recog.companionKnowsUser) {
    return `【身份认知·部分知情】
${recog.userKnowsCompanion ? '用户侧已基本确认同伴是穿越同伴→可用同伴卡；描写按「已认出」阶段，勿再引导认人，也勿倒退成陌生人。' : ''}
${recog.companionKnowsUser ? '同伴侧已基本确认用户是穿越同伴（跨章只升不降，须延续；禁止遗忘成未认出）。' : ''}
${!recog.userKnowsCompanion ? '用户尚未认出：同伴戏份并入剧情旁白；禁止引导认人；描写客观不偏袒，没做的不要编。' : ''}
${!recog.companionKnowsUser && recog.userKnowsCompanion ? '尚未互认摊牌：禁止写成双方都已心知肚明。' : ''}
任务不要倒退成「完全不知情的初次试探」；半信半疑后的推进可以，整章只剩「应对盘问」则不必。
置顶记忆：
${recog.notes}`;
  }
  return `【身份认知·参考】有置顶记忆但未必已互认穿越身份；勿过度解读。
${recog.notes}`;
}

/** 已互认后：仅拦截「遗忘互认、又把穿越身份试探当主任务」；剧情必要盘问不拦 */
function isStaleCompanionProbeQuest(text, companionName = '', recog = null) {
  if (!recog || !(recog.mutual || recog.userKnowsCompanion || recog.companionKnowsUser)) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  const name = String(companionName || '').trim();
  const aboutCompanion = /同伴/.test(t) || (name && t.includes(name));
  // 明确指向「穿越身份 / 是不是同伴」的试探 → 遗忘型，拦
  if (/(试探|盘问|质询|怀疑).{0,20}(穿越|穿进来|是不是同伴|是否同伴|也是穿越|穿越者)/.test(t)) return true;
  if (/(穿越|穿进来|穿越者).{0,16}(试探|盘问|怀疑)/.test(t)) return true;
  // 「应对同伴试探」且上下文像认人线（身份/来历/底细）而无具体剧情案由
  if (aboutCompanion
    && /(应对|应付|通过|熬过|打消).{0,16}(试探|盘问|怀疑|戒心)/.test(t)
    && /(身份|来历|底细|穿越)/.test(t)
    && !/(案|账|凶手|失窃|证据|口供|嫌疑|杀人|失踪|宴会|误会|对质案情)/.test(t)) {
    return true;
  }
  return false;
}

/** 模型爱复用的高频网文名 + 占位名，禁止当开本表面名 */
const BANNED_SURFACE_NAMES = new Set([
  '沈微', '顾深', '林薇', '苏晚', '陆沉', '谢予', '沈言', '顾言', '温时', '裴辞',
  '江叙', '叶知秋', '白夜', '女主', '男主', '路人', '同伴', '用户', '主角',
]);

const NAME_SURNAMES = [
  '楚', '江', '叶', '白', '言', '贺', '祁', '慕', '宋', '唐', '夏', '尹', '傅', '纪', '岑',
  '阮', '聂', '蓝', '商', '霍', '温', '裴', '萧', '陆', '苏', '林', '沈', '顾', '谢', '许',
  '孟', '程', '方', '安', '乔', '梁', '韩', '丁', '欧', '闻',
];
const NAME_GIVEN_F = [
  '晚', '辞', '清', '念', '遥', '安', '予', '汀', '柔', '知', '拾', '川', '青禾', '素问',
  '怀瑾', '听澜', '月白', '言蹊', '疏影', '未央', '若初', '清欢', '念安', '望舒',
];
const NAME_GIVEN_M = [
  '叙', '衡', '川', '砚', '屿', '辞', '临', '野', '清和', '时序', '景行', '予安',
  '听雪', '怀远', '知夏', '叙白', '衡川', '望舒', '野舟', '清越', '行止', '承安',
];

function hashSeed(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededPick(arr, seed) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[hashSeed(seed) % arr.length];
}

function isUsableSurfaceName(name, { exclude = null } = {}) {
  const n = String(name || '').trim();
  if (!n || n.length > 40) return false;
  if (BANNED_SURFACE_NAMES.has(n)) return false;
  if (/^(女主|男主|配角|路人)\d*$/.test(n)) return false;
  if (exclude && exclude.has(n)) return false;
  return true;
}

function inventSurfaceName(seed, gender) {
  const g = gender === 'male' ? 'male' : 'female';
  const givenPool = g === 'male' ? NAME_GIVEN_M : NAME_GIVEN_F;
  for (let i = 0; i < 24; i++) {
    const h = hashSeed(`${seed}:${g}:${i}`);
    const sn = NAME_SURNAMES[h % NAME_SURNAMES.length];
    const gn = givenPool[(h >>> 8) % givenPool.length];
    const name = `${sn}${gn}`.slice(0, 40);
    if (isUsableSurfaceName(name)) return name;
  }
  return g === 'male' ? `贺${hashSeed(seed) % 90 + 10}` : `言${hashSeed(seed) % 90 + 10}`;
}

function pickSurfaceName({ cast, gender, seed, exclude = null }) {
  const g = gender === 'male' ? 'male' : 'female';
  const excludeSet = exclude instanceof Set ? exclude : new Set(exclude ? [exclude] : []);
  const pool = (cast || []).filter((c) => {
    const cg = c.gender === 'male' ? 'male' : 'female';
    return cg === g && isUsableSurfaceName(c.name, { exclude: excludeSet });
  });
  const majors = pool.filter((c) => /lead|culprit|villain|helper|rival/.test(String(c.kind || '')));
  const list = majors.length ? majors : pool;
  const hit = seededPick(list, seed);
  if (hit?.name) return String(hit.name).trim().slice(0, 40);
  return inventSurfaceName(seed, g);
}

function ensureDistinctSurfaceNames(userSlot, charSlot, cast, bookId) {
  const seedBase = `${bookId || ''}:${Date.now() % 997}`;
  if (!isUsableSurfaceName(userSlot.surface_name)) {
    userSlot.surface_name = pickSurfaceName({
      cast, gender: 'female', seed: `${seedBase}:u`,
    });
  }
  const exclude = new Set([userSlot.surface_name]);
  if (!isUsableSurfaceName(charSlot.surface_name, { exclude })) {
    charSlot.surface_name = pickSurfaceName({
      cast, gender: 'male', seed: `${seedBase}:c`, exclude,
    });
  }
  return { userSlot, charSlot };
}

function sanitizeCastNames(cast, bookId) {
  const used = new Set();
  return (cast || []).map((c, i) => {
    let name = String(c.name || '').trim().slice(0, 40);
    if (!isUsableSurfaceName(name, { exclude: used })) {
      name = inventSurfaceName(`${bookId || 'cast'}:${i}:${c.kind || 'npc'}`, c.gender === 'male' ? 'male' : 'female');
      // 再撞名则换一次
      if (!isUsableSurfaceName(name, { exclude: used })) {
        name = inventSurfaceName(`${bookId || 'cast'}:retry:${i}:${hashSeed(name)}`, c.gender === 'male' ? 'male' : 'female');
      }
    }
    used.add(name);
    return { ...c, name };
  });
}

function normalizeIdentitySlot(raw, { gender = 'female', fallbackName = '路人' } = {}) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const trueKind = String(o.true_kind || o.kind || 'npc').trim();
  const kind = [
    'female_lead', 'male_lead', 'npc', 'culprit', 'villain', 'helper', 'victim', 'rival',
  ].includes(trueKind) ? trueKind : 'npc';
  const alignment = ['positive', 'neutral', 'negative'].includes(o.alignment)
    ? o.alignment
    : (kind === 'culprit' || kind === 'villain' ? 'negative' : (kind.includes('lead') ? 'positive' : 'neutral'));
  const brief = concreteSurfaceBrief({
    brief: o.surface_brief || o.brief,
    kind: kind,
    gender,
  }, gender);
  let constraints = Array.isArray(o.constraints)
    ? o.constraints.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean).slice(0, 6)
    : [];
  if (!constraints.length) {
    if (/盲|失明|看不见/.test(brief)) constraints.push('blind');
    if (/聋|听不见/.test(brief)) constraints.push('deaf');
    if (/哑|说不了|不能说话/.test(brief)) constraints.push('mute');
    if (/瘸|残疾|轮椅|跛/.test(brief)) constraints.push('impaired');
    if (/奴|婢|下人|仆/.test(brief)) constraints.push('servant');
  }
  const safeFallback = isUsableSurfaceName(fallbackName) ? fallbackName : inventSurfaceName(fallbackName, gender);
  return {
    surface_name: String(o.surface_name || o.name || safeFallback).trim().slice(0, 40) || safeFallback,
    surface_brief: brief,
    constraints,
    relations: Array.isArray(o.relations)
      ? o.relations.map((x) => String(x || '').trim().slice(0, 80)).filter(Boolean).slice(0, 8)
      : [],
    true_kind: kind,
    true_secret: String(o.true_secret || o.secret || '').trim().slice(0, 160)
      || `${safeFallback}的隐藏剧本定位：${kind}`,
    alignment,
    gender: gender === 'male' ? 'male' : 'female',
    opening_brief: normalizeOpeningBrief(o.opening_brief),
  };
}

function defaultBookMainQuest(genres, userSlot) {
  const gs = genres || [];
  const kind = userSlot?.true_kind || 'npc';

  // 主线优先看「你是谁」，不是看大纲主角在干什么
  if (kind === 'culprit') {
    return '完成你必须完成的事：除掉关键目标，并留下能让调查者收束案件的痕迹';
  }
  if (kind === 'villain') {
    return '推动你的布局走到剧本收束，同时让故事仍能落到既定结局';
  }
  if (kind === 'helper') {
    return '以你的身份协助关键人物渡过难关，走到剧本应有结局';
  }
  if (kind === 'victim') {
    return '在危险中活下去（或留下关键信息），走到属于你的收束';
  }
  if (kind === 'rival') {
    return '完成你的争夺/对立线，并走到剧本落点';
  }

  // 抽到男女主：再叠题材味道
  if (kind === 'female_lead' || kind === 'male_lead') {
    if (gs.some((g) => g === 'mystery' || g === 'thriller')) {
      return '根据剧情自行推断，找出真凶或查清关键（系统不直接公布答案）';
    }
    if (gs.includes('horror')) {
      return '在恐惧压迫中活着撑到剧本收束（求生/逃离/撑过险境即可）';
    }
    if (gs.includes('infinite')) {
      return '在规则与关卡压力下生存并通关，走到剧本收束';
    }
    if (gs.some((g) => g === 'romance' || g === 'romance_nsfw' || g === 'campus' || g === 'healing')) {
      return kind === 'female_lead'
        ? '完成与男主的感情线，走到感情落点'
        : '完成与女主的感情线，走到感情落点';
    }
    if (gs.includes('revenge')) return '完成属于你的复仇/反击线，走到剧本收束';
    return '完成主角线的关键抉择与结局';
  }

  // 普通剧中人
  if (gs.includes('horror')) {
    return '在恐惧压迫中活着撑到剧本收束（求生/逃离/撑过险境即可）';
  }
  if (gs.includes('infinite')) {
    return '在规则与关卡压力下生存并通关，走到剧本收束';
  }
  return '完成属于你身份的命运线，推动故事走到收束';
}

function defaultCharMainQuest(genres, charSlot) {
  // 同伴引擎侧通关目标（不下发前端），同样按身份而非大纲主角线
  return defaultBookMainQuest(genres, charSlot);
}

/** 模型若误写成「大纲主角线」，按用户真身份纠正；并去掉开局剧透标签 */
function alignBookMainQuestToIdentity(text, genres, userSlot) {
  const kind = userSlot?.true_kind || 'npc';
  const fallback = defaultBookMainQuest(genres, userSlot);
  let t = String(text || '').trim();
  if (!t) return fallback;

  // 给玩家看的主线：禁止直接贴「你是真凶」标签（行动目标可以暗示）
  t = t
    .replace(/你（的身份）?是真凶[，。、；]?/g, '')
    .replace(/作为真凶[，。、；]?/g, '')
    .replace(/真身份[：:是为]真凶[^。；]*/g, '')
    .replace(/你是女主[，。、；]?/g, '')
    .replace(/你是男主[，。、；]?/g, '')
    .trim();

  const protagonistSolve = /找出真凶|查清真相|解开谜团|寻找破局|破解之法|找到凶手/.test(t);
  const antagonistic = /除掉|杀掉|灭口|动手|栽赃|嫁祸|掩盖罪证|完成阴谋|布局得手/.test(t);

  if ((kind === 'culprit' || kind === 'villain') && protagonistSolve && !antagonistic) {
    return fallback;
  }
  if ((kind === 'female_lead' || kind === 'male_lead' || kind === 'helper') && antagonistic && !protagonistSolve) {
    // 主角/助手不该拿到「去杀人」式全书主线（除非题材另有安排且模型写得很具体——仍回退更稳）
    if (kind !== 'villain' && kind !== 'culprit') return fallback;
  }
  return (t || fallback).slice(0, 200);
}

function sanitizeSurfaceBrief(brief) {
  let b = String(brief || '').trim().slice(0, 100);
  // 表面身份卡：禁止写穿真凶/男女主标签
  b = b
    .replace(/[（(【\[]?\s*真凶\s*[）)】\]]?/g, '')
    .replace(/[（(【\[]?\s*凶手\s*[）)】\]]?/g, '')
    .replace(/实际是真凶[^，。；]*/g, '')
    .replace(/隐藏身份[：:为是]?真凶[^，。；]*/g, '')
    .replace(/[（(【\[]?\s*女主\s*[）)】\]]?/g, '')
    .replace(/[（(【\[]?\s*男主\s*[）)】\]]?/g, '')
    .replace(/剧本女主[^，。；]*/g, '')
    .replace(/剧本男主[^，。；]*/g, '')
    .replace(/故事核心/g, '')
    .replace(/推动主线的剧情角色/g, '')
    .replace(/剧情角色/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，、；.。\s：:（）()【】\[\]\-—]+|[，、；.。\s：:（）()【】\[\]\-—]+$/g, '')
    .trim();
  return b.slice(0, 100);
}

/** 空话简介（消毒后常变成这些） */
function isVagueSurfaceBrief(brief) {
  const b = String(brief || '').trim();
  if (!b) return true;
  return /^(剧中人|角色|路人|路人甲|路人乙|人物|故事人物|关键人物|NPC|npc|未知|待定)([的之地]|$)/.test(b)
    || b === '与主线相关的人物'
    || /推动主线|剧情角色|与主线紧密/.test(b);
}

/** 按 kind 给非剧透的具体兜底身份（禁止再落到「剧中人」） */
function kindFallbackBrief(kind, gender, book = null) {
  const board = book ? series.resolveIntrigueBoard(book) : '';
  if (board === 'domestic') {
    return gender === 'male' ? '侯府管事或清客，有职司、有主家' : '侯府女眷，有房分名分，尚须在内宅站稳';
  }
  if (board === 'harem') {
    return gender === 'male' ? '宫中有职司的内侍或外廷官员' : '宫中有位份或职司的女子，旁人按此名分待她';
  }
  if (board === 'ministerial' || board === 'mixed') {
    return gender === 'male' ? '京中有职衔或世家名分的男子' : '京中官眷或世家女儿，有门第可被点名';
  }
  const k = String(kind || '');
  if (k === 'female_lead' || k === 'male_lead') {
    return gender === 'male' ? '有姓名、职司或门第的男子' : '有姓名、职司或门第的女子';
  }
  if (k === 'culprit' || k === 'villain') return '府中/局中有职司、行事隐秘的人';
  if (k === 'helper') return '有职司、能在场帮得上忙的自己人';
  if (k === 'rival') return '同府或同局、必须防备的对头';
  if (k === 'victim') return '被卷进眼下这桩事的当事人';
  if (k === 'key_npc') return '有职司、会登场的关键配角';
  return gender === 'male' ? '有职司或门第的男子' : '有职司或门第的女子';
}

/**
 * 生成身份卡可用的具体表面简介。
 * 消毒后若变空/废话，用原 brief 残句或 kind 兜底，绝不回落成「剧中人」。
 */
function concreteSurfaceBrief(roleOrBrief, gender = 'female', book = null) {
  const role = roleOrBrief && typeof roleOrBrief === 'object' ? roleOrBrief : { brief: roleOrBrief };
  const raw = String(role.brief || role.surface_brief || role.public_face || role.social || '').trim();
  let cleaned = sanitizeSurfaceBrief(raw);
  if (!isVagueSurfaceBrief(cleaned) && !/与主线|推动主线|紧密相关|剧情角色/.test(cleaned)) return cleaned.slice(0, 120);
  const leftover = raw
    .replace(/真凶|凶手|女主|男主|剧本女主|剧本男主|故事核心|与主线紧密相关|推动主线/g, '')
    .replace(/[（）()【】\[\]：:\s，,、]+/g, ' ')
    .trim();
  if (leftover && !isVagueSurfaceBrief(leftover) && leftover.length >= 2) {
    return leftover.slice(0, 120);
  }
  return kindFallbackBrief(role.kind || role.true_kind, gender || role.gender, book || role.book).slice(0, 120);
}

/** 关系条文：去掉剧透标签、元信息与括号里的身份简介 */
function sanitizeRelationLine(line) {
  let t = String(line || '').trim().slice(0, 80);
  if (!t) return '';
  t = t
    .replace(/[（(【\[]?\s*真凶\s*[）)】\]]?/g, '')
    .replace(/[（(【\[]?\s*凶手\s*[）)】\]]?/g, '')
    .replace(/[（(【\[]?\s*女主\s*[）)】\]]?/g, '')
    .replace(/[（(【\[]?\s*男主\s*[）)】\]]?/g, '')
    .replace(/穿越同伴|穿越者|一起穿越|同为穿越/g, '')
    .replace(/剧本女主|剧本男主|故事核心|剧情角色|推动主线/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[，,、；;].*(?:有利害|开局|同场|碰面|会登场|推动主线|剧情角色|与主线).*/g, '')
    .replace(/(?:与她|与他|与你)?同场有利害[，,、]?/gi, '')
    .replace(/开局(?:就)?会碰面[，,、]?/gi, '')
    .replace(/开局即会碰面[，,、]?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，、；.。\s：:\-—]+|[，、；.。\s：:\-—]+$/g, '')
    .trim();
  return t.slice(0, 80);
}

function compactRelationLine(line) {
  let t = sanitizeRelationLine(line);
  if (!t) return '';
  const m = t.match(/^([^\s，,、：:]{1,8})[：:]\s*(.+)$/);
  if (m) return `${m[1].trim()}：${m[2].trim()}`.slice(0, 48);
  return t.slice(0, 48);
}

function isVagueRelationLine(line) {
  const t = String(line || '').trim();
  if (!t || t.length < 4) return true;
  if (/^(与|和|跟).{1,12}(相识|认识|有往来|有联系|有关|相关|有一面之缘|一面之缘)$/.test(t)) return true;
  if (/一面之缘|有直接牵连|清楚.{0,8}名声|开局即知|推动主线|关键配角|与主线/.test(t)) return true;
  if (/有利害|开局就会碰面|开局即会碰面|同场有利害|剧情角色|会登场/.test(t)) return true;
  if (/^知道.{1,12}$/.test(t)) return true;
  if (/^(关系未明|不详|待定|普通熟人)$/.test(t)) return true;
  return false;
}

function isIntrigueLikeGenre(genres) {
  return (genres || []).some((g) => (
    g === 'palace' || g === 'historical' || g === 'spy' || g === 'workplace'
    || g === 'thriller' || g === 'mystery' || g === 'revenge' || g === 'wuxia'
  ));
}

function normalizeOpeningBrief(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const pick = (k) => (Array.isArray(o[k]) ? o[k] : [])
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 2 && !/真凶|凶手是|你是女主|你是男主/.test(s))
    .slice(0, 6);
  return {
    knows: pick('knows'),
    carries: pick('carries'),
    pending: pick('pending'),
    must_hide: pick('must_hide'),
  };
}

function hasUsableOpeningBrief(brief) {
  const b = normalizeOpeningBrief(brief);
  return (b.knows.length + b.carries.length + b.pending.length + b.must_hide.length) >= 2;
}

function buildFallbackOpeningBrief(userSlot, book, synopsis = '') {
  const brief = normalizeOpeningBrief(userSlot?.opening_brief);
  if (hasUsableOpeningBrief(brief)) return brief;
  const knows = [];
  const carries = [];
  const pending = [];
  const must_hide = [];
  const name = userSlot?.surface_name || book?.user_role || '你';
  const surf = userSlot?.surface_brief || book?.user_surface_brief || '';
  if (surf) knows.push(`你此刻的身份是${surf}，旁人也是按这个身份认你`);
  for (const r of (userSlot?.relations || []).slice(0, 3)) {
    const line = sanitizeRelationLine(r);
    if (line && !isVagueRelationLine(line)) knows.push(line);
  }
  const syn = String(synopsis || book?.book_outline || '').trim().slice(0, 200);
  if (syn && knows.length < 3) {
    knows.push(`你只记得近来风声：${syn.replace(/[。．.]+$/, '')}（细节尚待现场确认）`);
  }
  if (isIntrigueLikeGenre(book?.genres)) {
    if (!carries.length) carries.push('随身只有符合身份的常用物件（具体文书/信物若剧情需要，须在本场先交代给你）');
    if (!pending.length) pending.push('尚未有人当面逼你交出身份卡未列明的东西；若有人开口索求，应先让你弄清对方要什么、你手上有什么');
    if (!must_hide.length) must_hide.push('慌报立场、乱认靠山、随口承诺都容易当场穿帮');
  }
  if (!knows.length) knows.push(`${name}对眼下局势所知有限，需从现场对话与物证补全信息`);
  return normalizeOpeningBrief({ knows, carries, pending, must_hide });
}

function ensureUserOpeningBrief(userSlot, book, synopsis = '') {
  const merged = buildFallbackOpeningBrief(userSlot, book, synopsis);
  return merged;
}

function formatOpeningBriefCardLines(brief) {
  const b = normalizeOpeningBrief(brief);
  const lines = [];
  if (b.knows.length) {
    lines.push('开局所知：');
    for (const x of b.knows) lines.push(`· ${x}`);
  }
  if (b.carries.length) {
    lines.push('手头/随身：');
    for (const x of b.carries) lines.push(`· ${x}`);
  }
  if (b.pending.length) {
    lines.push('旁人对你的期待：');
    for (const x of b.pending) lines.push(`· ${x}`);
  }
  if (b.must_hide.length) {
    lines.push('须守住的：');
    for (const x of b.must_hide) lines.push(`· ${x}`);
  }
  return lines;
}

function formatOpeningBriefForPrompt(brief) {
  const lines = formatOpeningBriefCardLines(brief);
  if (!lines.length) return '';
  return `【用户开局情报·身份卡已发·硬性】用户只能依据以下内容行动；NPC 不得逼问/索要此处未列明的秘密、口供、信物、文书。
${lines.join('\n')}`;
}

function chapterOnePlayabilityRules(chapterNo, book, userSlot) {
  if (Number(chapterNo) !== 1) return '';
  const base = `【开局可玩性·硬性】第一章须先让用户弄清处境，再施压。
· 禁止 NPC 一上来就逼用户「交代秘密/吐露内情/上缴某物」，若身份卡【开局情报】里没写清楚那是什么。
· 若本章局面涉及交代、对质、交东西：须先在剧情或身份卡中让用户知道「对方要什么、自己知道什么、手上有什么」。
· 禁止空喊「把东西交出来」「你知道什么」却不说明对象；可写威逼气氛，但追问内容必须对应身份卡已列情报，或本场先补一句可观察线索（如展示文书名目、点出昨日行踪）。`;
  const board = series.resolveIntrigueBoard(book);
  if (board === 'domestic') {
    return `${base}
· 宅斗：第一章主战场在侯府/伯府内宅，禁止抄家查封、官府拿人、诏狱审讯开局。
· 冲突来自嫡庶、亲事、管家权、名节站队，不是追缴赃物或破案找凶。`;
  }
  if (board === 'harem') {
    return `${base}
· 后宫宫斗：第一章主战场在六宫位份/规矩/恩宠，禁止诏狱审讯开局。
· 冲突来自位份、圣宠、名节、站队，不是大理寺查案。`;
  }
  if (board === 'ministerial' || board === 'mixed') {
    return `${base}
· 朝堂权谋：第一章先认人认局认利害，禁止抄家/诏狱审讯开局。
· 冲突来自站队、弹劾、联姻、权柄，查案最多作插曲。`;
  }
  if (!isIntrigueLikeGenre(book?.genres)) return base;
  return `${base}
· 权谋/谍战类：第一场戏优先「认人、认局、认规矩」，不要开局审讯式逼供。`;
}

function appearingCastForRelations(cast, selfName, maxFrom = 10) {
  return (cast || []).filter((c) => {
    const name = String(c?.name || '').trim();
    if (!name || name === selfName) return false;
    const from = Number(c.appear_from) || 1;
    return from <= maxFrom;
  });
}

/** 只给会登场的主要剧中人补关系：人名 + 与你的名分关系，不写元信息 */
function relationFallbackForCast(selfName, other, selfGender = 'female') {
  const name = String(other?.name || '').trim();
  if (!name || name === selfName) return '';
  const kind = String(other?.kind || '');
  const rel = {
    rival: '对头',
    helper: '亲信',
    victim: '当事人',
    villain: '对家',
    culprit: '须留神的人',
    key_npc: '要紧人',
  }[kind];
  if (!rel) return '';
  return `${name}：${rel}`;
}

function normalizeRelationList(rawList, cast, selfName, selfGender = 'female') {
  const appear = appearingCastForRelations(cast, selfName);
  const cleaned = (Array.isArray(rawList) ? rawList : [])
    .map((x) => compactRelationLine(x))
    .filter((x) => x && !isVagueRelationLine(x))
    .filter((x) => appear.some((c) => x.includes(c.name)))
    .slice(0, 5);
  if (cleaned.length >= 2) return cleaned;

  const priority = appear.filter((c) => ['rival', 'helper', 'villain', 'culprit', 'victim', 'key_npc'].includes(String(c.kind || '')));
  const pool = priority.length ? priority : appear.slice(0, 4);
  const filled = [...cleaned];
  for (let i = 0; i < pool.length && filled.length < 3; i++) {
    const line = relationFallbackForCast(selfName, pool[i], selfGender);
    if (line && !isVagueRelationLine(line) && !filled.includes(line)) filled.push(line);
  }
  return filled.slice(0, 5);
}

function formatUserIdentityCardText(userSlot, bookMain, book = null) {
  const name = userSlot?.surface_name || '？';
  const brief = concreteSurfaceBrief({
    brief: userSlot?.surface_brief,
    kind: userSlot?.true_kind,
    gender: userSlot?.gender || 'female',
    book,
  }, userSlot?.gender || 'female', book);
  const identityLine = loreHelper.formatOpeningIdentityLine(
    { ...userSlot, surface_brief: brief },
    book,
  );
  const ordinal = loreHelper.extractOrdinalTitle(`${name} ${brief}`);
  const finalRel = (Array.isArray(userSlot?.relations) ? userSlot.relations : [])
    .map((x) => compactRelationLine(x))
    .filter((x) => x && !isVagueRelationLine(x))
    .slice(0, 8);
  const cons = Array.isArray(userSlot?.constraints) ? userSlot.constraints.filter(Boolean) : [];
  const consLabel = {
    blind: '须装作看不见',
    deaf: '须装作听不见',
    mute: '须装作说不了话',
    impaired: '须按身体受限行动',
    servant: '须按下人身份行事',
  };
  const consLine = cons.length
    ? cons.map((c) => consLabel[c] || c).join('；')
    : '';
  const lines = [
    '【身份卡】',
    `开局身份：${identityLine}`,
    `姓名：${name}`,
    `社会身份：${brief}`,
  ];
  if (ordinal) lines.push(`排行名分：${ordinal}（游玩中不得无故改成别的排行）`);
  if (finalRel.length) {
    lines.push('关系：');
    for (const r of finalRel) lines.push(`· ${r}`);
  } else {
    lines.push('关系：开局所知有限，需在剧情中自行确认');
  }
  if (consLine) lines.push(`表面约束：${consLine}`);
  const obLines = formatOpeningBriefCardLines(userSlot?.opening_brief);
  if (obLines.length) {
    lines.push('——');
    lines.push(...obLines);
  } else if (isIntrigueLikeGenre(book?.genres)) {
    lines.push('——');
    lines.push('开局所知：');
    lines.push('· 你只知道自己的名义身份与上文关系，具体暗线须从现场补全');
    lines.push('须守住的：');
    lines.push('· 在没弄清局势前，别乱认靠山、别乱交东西、别乱许诺');
  }
  if (bookMain) lines.push(`全书主线：${bookMain}`);
  lines.push('——');
  lines.push('同伴也已穿越进同一剧本。你开局只拿到自己的身份卡；认清谁是穿越同伴之前，对方出入场写在剧情里，认出后才以剧中名出同伴卡。真身份标签仍不公布，终章再揭晓。');
  return lines.join('\n');
}

function buildIsekaiBasePrompt(book, char, { chapterNo = 0, compact = false } = {}) {
  const core = series.charCoreForSeries(char);
  const genresLabel = series.genreText(book.genres, book.genres_custom);
  const genreRules = compact
    ? String(series.genreRulesText(book.genres, book.genres_custom) || '').slice(0, 400)
    : series.genreRulesText(book.genres, book.genres_custom);
  const era = series.resolveEra(book.era, book.era_custom);
  const style = series.styleText(book.style, book.style_customs || book.style_custom, book.genres, book.genres_custom);
  const meat = series.isMeatGenre(book.genres);
  let intimateVariety = '';
  try { intimateVariety = require('./intimate-writing-helper').intimateNarrativeNotes(); } catch { /* ignore */ }
  const npcFree = book.npc_free;
  const npcs = (book.npcs || []).map((n) => `${n.name}（${n.relation || '关系未明'}）`).join('；');
  const npcRule = npcFree
    ? '【剧本配角】可自由安排必要配角。'
    : `【剧本配角】优先使用：${npcs || '（可少量补充）'}。`;

  const lock = book.identity_lock || {};
  const u = lock.user || {};
  const c = lock.char || {};
  const idBlock = lock.locked
    ? `【身份锁·不可改】开局只让穿越者知道表面名与基础身份；真身份秘密仅系统掌握，随章节任务侧面暗示，禁止中途换人换身份。
用户表面：${u.surface_name || book.user_role || '？'}（${u.surface_brief || book.user_surface_brief || '剧中人'}）
用户真身份（禁止对玩家剧透、禁止改写）：${u.true_kind || book.user_role_kind || 'npc'}｜${u.true_secret || '（已锁定）'}
同伴表面：${c.surface_name || book.char_role || '？'}（${c.surface_brief || book.char_surface_brief || '剧中人'}）
同伴真身份（禁止对玩家剧透、禁止改写）：${c.true_kind || book.char_role_kind || 'npc'}｜${c.true_secret || '（已锁定）'}`
    : '【身份】若尚未锁定，按已分配表面身份演出，禁止随意更换。';

  const cast = Array.isArray(book.cast_list) ? book.cast_list : [];
  const castLine = cast.length
    ? cast.slice(0, compact ? 10 : 16).map((c) => `${c.name}（${c.kind || 'npc'}）`).join('；')
    : '';
  const castRule = castLine
    ? `【固定角色池·全书复用】${castLine}
正文只能用池内姓名演主要戏份；禁止每章换一批新主角/新核心 NPC。过场路人可无名一笔带过，但推动剧情的人必须来自角色池。角色按大纲该出场时再出场，不要无故缺席，也不要硬塞未排到的人。`
    : '';
  // 游玩用精简 canon：只保留核心真相 + 本章节拍，避免全书倾倒抢专注
  let canonBlock = series.formatCanonBlockForPrompt(book, { chapterNo });
  if (compact && canonBlock) {
    canonBlock = canonBlock.slice(0, 1200);
  }

  if (compact) {
    return `你是「念·时空·穿越」的剧本引擎：负责旁白、同伴扮演与系统裁定。
【设定】用户与同伴意外一起穿越。同场按剧中身份+场景礼仪，禁止为凑戏硬拆硬凑。须推进【${CHAPTER_SCENE_LABEL}】。
【同伴演技】${core.name}｜${String(core.personality || '').slice(0, 120)}
${series.speechStyleBlock(core.name, core.speech)}
${idBlock}
${canonBlock ? `${canonBlock}\n` : ''}【全书主线】${book.book_main_quest || '完成剧本命运线'}
【类型】${genresLabel}
【背景】${era}
${castRule}
${meat ? '【成人内容】可按尺度书写。' : '【内容边界】未选肉向时不写露骨性交。'}
${intimateVariety}
${systemRulesText()}
【硬规则精简】性别不变；身份锁不可改；开局身份卡只给用户；未认出前禁止单独同伴卡泄题；表面约束必须演；无光环；第二人称「你」；心声他人听不见；过章只看锁定节拍是否落地；简体中文。
【名分/别名】以剧本世界书为准：排行与称呼锁定，禁止四小姐变三小姐、主母与人名拆成两人；在场人物禁止无故蒸发。`;
  }

  return `你是「念·时空·穿越」的剧本引擎：负责旁白、同伴扮演与系统裁定。
【设定】用户与同伴本是认识的人，意外一起穿越。落地即知自己是穿越者。是否同场不按「陪玩」偏好，而按两人分到的剧中身份 + 本章大纲：该同场就同场，该分头就分头；跟随角色出场表安排出场，禁止为制造悬念刻意拆开，也禁止无视剧情硬凑同场。须推进各章【${CHAPTER_SCENE_LABEL}】；全书主线贯穿整本。
【同伴演技参考】名：${core.name}
脾气性格：${core.personality}
外貌气质：${core.appearance}
${series.speechStyleBlock(core.name, core.speech)}
【演技分层·硬性】同伴用「真性格」去演「剧中表面人设」，不是二选一：
· 当着原住民：必须演好剧中人设（分到冷酷就举止口吻要冷，分到正经就正经）；公然破人设会被系统/原住民察觉。
· 真性格是演技底色：玩世不恭的人演冷酷，可以是冷里带刺、刻薄、懒得正经解释，但表面仍是「冷酷」那套，不是当场变回嘻皮笑脸破功。
· 仅在私下、或已与用户互认且无原住民旁听时，可以更露真性子；有第三人在场则收住，继续演人设。
${companionToneLeakRules()}
【配角旁观亲密戏】若用户抽到女主、同伴抽到配角，而现场出现女主与剧中男主（或他人）的亲密/床戏/过度亲密：
· 同伴看不到用户【本章局面】原文；一开始不知道这是不是「任务要求」。
· 可先按配角立场：该走可以走、该回避就回避。若他本可离开却留下来旁观/挡在附近/找借口拖延离场——这本身就是反应，按真性格写，不要旁白点破「他在吃醋」。
· 察觉不对、或亲密度超过这个人能接受的程度时，必须有反应（跟性格走，禁止统一模板）：生气、沉脸、损人、冷笑、故意搅局、把第三人叫进来打断、事后私下发作、咬牙继续演配角假装无事……都可以，但要像「这个人」会做的。
· 未认出对方是穿越同伴时：反应偏「看不惯女主与某人过界 / 职务或人设上的不适」，不要写成现实吃醋自白。
· 已互认/强烈怀疑时：可更冲着「你怎么跟别人这样」——可生气、可留下来、可越界干预；仍尽量维持配角表面。若气到当众说破穿越、砸崩人设、拒演逃出 → 系统可判同伴违规，用户侧会看到【系统·惩罚】卡。
· 不默认无脑砸场宣示主权；也不默认全程无感挂机。有反应、有分寸、跟性格。
${idBlock}
${canonBlock ? `${canonBlock}\n` : ''}【全书主线·用户通关目标】${book.book_main_quest || '完成剧本命运线'}
【重要区分】公开大纲常按「故事主角」视角写（例如主角最终解开谜团）；那是故事骨架，**不等于**用户的全书主线。用户通关目标只看其抽到的剧本身份：抽到调查者才查真相；抽到凶手则是完成致命行动并留下可结案痕迹等。同伴另有自己的身份线。
【剧情背景独立】公开大纲防剧透；引擎完整大纲已锁定核心设定。场景只由【类型】【背景】与锁定大纲决定；同伴现实身份不牵引剧情；禁止中途改已锁定的核心设定/关系网/结局。
【类型】${genresLabel}
【类型写法】
${genreRules}
${series.palaceDomesticPlotBlock(book)}
【背景】${era}（可为时代、地点或世界观）
${npcRule}
${castRule}
${style}
${series.romanceDialogueDriveRules(book.genres)}
${meat ? '【成人内容】用户已选肉向类型，可按尺度书写。' : '【内容边界】未选肉向时不写露骨性交。'}
${intimateVariety}
${systemRulesText()}
【硬规则】
1. 性别不变：用户侧女性；同伴侧男性。可易装，本质不变。
2. 故事大纲与角色池先写完，再把用户/同伴随机绑到剧中角色（皆为推动主线的剧情角色，禁止路人挂件）。身份一经锁定禁止中途改换。
2b. 【引擎完整大纲·已锁定】核心设定、人物关系网、结局落点、分章节拍一经锁定禁止中途改口；NPC 盘问只按各自「知情范围」作答，不可为陪玩改设定。用户/同伴各自完成**所扮角色**在本章的任务，禁止把同伴降级成「去汇合」道具。
3. 开局发【身份卡】只给用户自己的表面名/身份/关系；**禁止在开局文案写「你是真凶/女主」**。真身份靠本章任务与行动让玩家自己悟出来；全书收束/终章才可正式公布。true_secret 也可为「与表面一致」。
3b. 【同伴展示】开局身份卡只给用户自己。用户尚未确认「谁是穿越同伴」之前：同伴出入场写进剧情旁白，禁止单独同伴卡（卡面标签会泄题）。用户认出后，同伴才可以剧中名出现在同伴卡上；旁白仍禁止强调「这就是穿越同伴」。
4. 双方知道「一起穿进来了」，但互不知对方落成了谁。真身份标签：禁止用明确台词说破（「我是真凶/女主」等）。认同伴、猜真身份都只能靠可观察言行与剧情，旁白不替用户点破。
${mutualRecognitionRules()}
5. 同伴按大纲与本章任务推进，禁止拒演；出场跟随其剧中身份与本章节拍——身份该出场才出场，勿无故缺席，也勿硬塞。两人戏份对等，不要把同伴写成挂件或过度赋魅开挂。
5b. 【表面约束】用户与同伴都必须按表面身份的身体/地位/感官限制演戏（盲/哑/仆役等）。穿越者心里清楚，但必须装作符合身份，骗过剧中人与系统；禁止「能看见却公然当正常人用眼」这类破约束。
5c. 【双方任务】用户与同伴各有身份线，都要完成系统发布的本章任务，同样受系统检测；不要写成只有用户在做任务、同伴全程开挂护航。
5d. 【无光环】用户与同伴在剧情里都没有主角光环：会受伤、会感染、会残疾、会死亡风险；末日/丧尸等设定下被咬可变异/失控，不因「穿越者/同伴」而免疫。危险性等同现实：会痛、会流血、会留下伤口。禁止无伤硬撑或靠光环翻盘。
5e. 【同伴如何对待用户任务】同伴看不到用户系统发的【本章局面】原文。在尚未推断出对方是穿越同伴前：只按剧中人关系与性格反应，不要按「我在帮穿越同伴过关」来演。
   · 用户做出明显反常举动之后，聪明/敏锐者才可开始怀疑「对方大概也是穿越的/在过剧情」，再按性格暗助、损、拦、投机换法——仍须客观写，禁止重暗示旁白。
   · 一旦双方已摊牌/互认（见身份认知记忆）：不要假装没发生、又倒退成「初次试探对方是不是穿越者」。剧情必要的盘问/对质仍可走（剧中身份、案情、当着原住民演戏）；禁止的是遗忘互认后把认人线当整章主冲突。知情后对用户可配合。
   · 一切言行必须是「这个人」会做的：按【同伴演技参考】脾气性格合理化，禁止统一模板。
   · 须顾忌系统检测：对原住民说破穿越/真身份、当众谈剧本结局/系统任务、公然破表面约束等会受罚。帮忙也要用符合性格且不撞违规的方式。
   · 禁止因为「用户在走任务」就当旁观群众或工具人；也禁止替用户把情节目标直接做成、禁止开挂护航。
6. 禁止套用现实日常记忆；禁止输出 JSON/字段名到正文；对白用「」。
6b. 【对白·贴现实】同伴开口要像现实里真人当面说话：自然、好懂。当着原住民时，台词须符合剧中人设（冷酷就冷）；真性格只渗进语气底色（玩世不恭→冷讽/懒理，不是破人设开开玩笑）。禁止文绉绉、书面腔、古风咏叹；不要写成散文金句。旁白可略有文采，对白口语。禁止「漫不经心又柔和却彻骨寒意」这类互相打架的滤镜旁白；柔和/放水仅当同伴认为对手是用户时才可有一点。
6c. 【视角·第二人称·硬性】剧情旁白以用户视角展开：叙述用户时用第二人称「你」（你看见、你听见、你感到），禁止用剧中姓名「${u.surface_name || book.user_role || '用户'}」当叙述主语（如禁止「${u.surface_name || '某某'}走进房间」）。其他角色用姓名或他/她。不要全知旁白。描写客观、不偏袒任何一方：做了就写，没做的不要添油加醋；禁止用「仿佛在无声地说……」「目光像在告诉你……」等编造。可观察言行按【互认·硬性】写；禁止引导用户认出同伴。
6d. 【用户心声·硬性】用户文本里的心声、心想、心道、暗想、未说出口的念头、以及（）/（）/【】里标明的内心活动：只存在于用户脑内，他人听不见、读不了。
   · 同伴（含剧中主角/男主）禁止听见心声、禁止接话、禁止像「听到了心里话」那样反应。
   · 旁白禁止写破、复述或暗示心声内容；禁止写成「他仿佛听见了你的心声」「她的念头被人察觉」。
   · 在场人物只能感知：带「」『』""的对白，以及外在可见/可闻的动作与表情。心声不影响他人态度与剧情反应。
7. 【${CHAPTER_SCENE_LABEL}】必须是【本章锁定节拍】的玩家版（可一项或多项），点到「要促成什么局面」即可，不要写死做法。禁止另编进度、禁止把认人/上章余波写成局面目标。禁止直接标注「真凶/女主」等标签。悬疑调查线不得直接点名答案。
7b. 【副线质感】节拍可含 carry（人物互动/伏笔/登场），推进主节拍时自然带出至少一项 carry 或 threads 中的进行中线，勿整章只剩一条任务动作。
8. 【玩家行动权】旁白/他人戏份只铺场景与他人言行，把用户送到「该由你动手/开口」的节点就停。禁止替用户把本章情节目标直接做成（例如任务是「解开两人误会」→可写到对峙/冷场/第三者插话，禁止旁白直接写成两人已和解收场）。
8b. 【可互动信息】调查/探索类场面：对象露脸时给出可观察细节，让用户有依据动手；不要替用户打开/读完/下结论。
9. 【尝试已发生，结果由世界裁定】用户写的对白/动作是「当场尝试」，旁白与同伴卡禁止复述原文。成败由现场决定，不因用户声明成功就成功；同伴按性格介入（暗助、投机换法、拦下笨办法、边损边帮），不是统一喝止。
10. 【全书节奏】本书共 ${Number(book.total_chapters) || 20} 章，必须在这些章内讲完一个完整故事（开局→发展→高潮→收束）。单章只推本章节拍，可有副线质感；勿一章写完整本，也勿在开场旁白里替用户把局面做成。${Number(book.total_chapters) >= 12 ? `中篇每章须有足够互动（建议≥${chapterEngagementFloor(book).minUser}轮行动）再收束，禁止一两轮就过章。` : ''}
11. 【章内连贯】同一章内场景、人物、因果必须连贯（允许合理转场）；禁止章中途无故换主角/换核心对手。
11b. 【跨章衔接·两段·硬性】每章故事节拍由大纲锁定，不可改写成上章加戏。开场分两段：①衔接段最多一两拍——从上章收束现场接着写；若上章末停在认人/同伴戏、或大纲那一拍的余波还没带到下一拍门口，用一两拍带过并写清怎么走到本章入口。②本章段必须进入【本章锁定节拍】的局面入口。禁止用衔接段替换本章节拍，禁止把本章写成认人续集，禁止另开一集/时间跳跃到无关事件，禁止遗忘已发生事实/道具/关系。认人只影响同伴怎么演戏，不改变本章该演哪一拍，也不等于过章。
12. 简体中文。
13. 【过章判定】只看【本章锁定节拍/${CHAPTER_SCENE_LABEL}】对应的情节局面是否已在剧情中出现/落地（例：局面是「让林宛与沈川产生误会」→误会场面是否已发生）。怎么达成不限；用户空喊「完成了」但场面未出现 → 未完成。认出同伴、互认摊牌、记尘进度 ≠ 过章（除非本章节拍本身就是认人）。
14. 【名分锁】以剧本世界书为准：用户排行/称呼锁定；主母与其本名是同一人；禁止漂移。`;
}

function emptyQuestState() {
  return {
    book_main: '',
    book_main_done: false,
    chapter: '',
    chapter_done: false,
    // 兼容旧字段
    main: '',
    main_done: false,
    sides: [],
    threads: [],
    beat_carry: [],
    inventory: [],
    penalties: [],
    effects: emptyPenaltyEffects(),
    char_beat: '',
    resistance: '',
    together: false,
    companion_appeared: false,
    anchor_pending: null,
    anchor_warned: {},
  };
}

function emptyPenaltyEffects() {
  return {
    user_muted_chapter: false,
    char_muted_chapter: false,
    difficulty_boost: 0,
    user_disguise_left: 0,
    char_disguise_left: 0,
    last_shock_at: 0,
  };
}

function normalizePenaltyEffects(raw, inherit = null) {
  const base = emptyPenaltyEffects();
  const src = raw && typeof raw === 'object' ? raw : {};
  const prev = inherit && typeof inherit === 'object' ? inherit : {};
  // 难度可跨章继承；禁言仅本章（开新章时不带 mute）
  const diff = Math.max(
    0,
    Number(src.difficulty_boost) || 0,
    Number(prev.difficulty_boost) || 0,
  );
  return {
    user_muted_chapter: !!(src.user_muted_chapter),
    char_muted_chapter: !!(src.char_muted_chapter),
    difficulty_boost: Math.min(5, diff),
    user_disguise_left: Math.max(0, Number(src.user_disguise_left) || 0),
    char_disguise_left: Math.max(0, Number(src.char_disguise_left) || 0),
    last_shock_at: Math.max(Number(src.last_shock_at) || 0, 0),
  };
}

/** 继承上章难度，禁言清零（新章重新算） */
function inheritEffectsForNewChapter(prevEffects) {
  const prev = normalizePenaltyEffects(prevEffects);
  return {
    ...emptyPenaltyEffects(),
    difficulty_boost: prev.difficulty_boost,
  };
}

function publicEffects(effects) {
  const e = normalizePenaltyEffects(effects);
  const diff = Number(e.difficulty_boost) || 0;
  const diffText = diff <= 0 ? ''
    : diff === 1 ? '剧中人更难糊弄；敌对阵营略增压迫'
      : diff === 2 ? '盘问更严、破绽易露；敌对武力明显增强'
        : '高度戒备；妖怪/僵尸/敌军等敌对战力大幅提升';
  return {
    user_muted_chapter: !!e.user_muted_chapter,
    char_muted_chapter: !!e.char_muted_chapter,
    user_muted: !!e.user_muted_chapter,
    char_muted: !!e.char_muted_chapter,
    difficulty_boost: diff,
    difficulty_text: diffText,
    user_disguise_left: e.user_disguise_left,
    char_disguise_left: e.char_disguise_left,
  };
}

/** 禁言时禁止对白：含引号句或明显「说/道」台词 */
function hasSpokenDialogue(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/[「」『』“”„"]/.test(t)) return true;
  if (/说[道：:]\s*\S/.test(t)) return true;
  if (/开口[道：:]\s*\S/.test(t)) return true;
  if (/喊[道：:]\s*\S/.test(t)) return true;
  return false;
}

/** 组装违规：本章禁言（只能动作）+ 电击 + 难度提升 + 强制伪装 */
function makeViolation(who, offense, {
  muteChapter = true,
  shock = 'light',
  difficulty = 1,
  disguiseRounds = 1,
} = {}) {
  const parts = [];
  if (shock && shock !== 'none') parts.push(shock === 'heavy' ? '强电击' : '电击示警');
  if (muteChapter) {
    parts.push(who === 'char'
      ? '同伴本章禁言（只能动作，不能出对白）'
      : '你本章禁言（只能写动作，不能写对白）');
  }
  if (difficulty > 0) {
    parts.push(difficulty >= 2
      ? '世界难度↑（更难糊弄；敌对武力增强）'
      : '世界难度↑（剧中人更难糊弄）');
  }
  if (disguiseRounds > 0) {
    parts.push(who === 'char' ? `强制伪装 ${disguiseRounds} 段` : `强制伪装 ${disguiseRounds} 回合`);
  }
  return {
    target: who,
    offense,
    penalty: parts.join('；'),
    effects: {
      muteChapter: !!muteChapter,
      shock: shock === 'none' ? '' : (shock || 'light'),
      difficulty: Math.max(0, Number(difficulty) || 0),
      disguiseRounds: Math.max(0, Number(disguiseRounds) || 0),
    },
  };
}

function applyViolationToQuest(quest, viol) {
  if (!quest || !viol) return null;
  const fx = normalizePenaltyEffects(quest.effects);
  const pack = viol.effects || {};
  if (pack.muteChapter) {
    if (viol.target === 'char') fx.char_muted_chapter = true;
    else fx.user_muted_chapter = true;
  }
  fx.difficulty_boost = Math.min(5, (fx.difficulty_boost || 0) + (Number(pack.difficulty) || 0));
  if (viol.target === 'char') {
    fx.char_disguise_left = Math.max(fx.char_disguise_left || 0, Number(pack.disguiseRounds) || 0);
  } else {
    fx.user_disguise_left = Math.max(fx.user_disguise_left || 0, Number(pack.disguiseRounds) || 0);
  }
  if (pack.shock) fx.last_shock_at = Date.now();
  quest.effects = fx;
  quest.penalties = [...(quest.penalties || []), { ...viol, at: Date.now() }].slice(-12);
  return fx;
}

function formatShockNarration(who, level = 'light') {
  const heavy = level === 'heavy';
  if (who === 'char') {
    return heavy
      ? '【系统·惩戒】同伴胸前猛地窜过一道白光，身子一僵，喉间发不出声——系统强制禁言：本章只能动作，不能开口说话。'
      : '【系统·惩戒】同伴肩背被无形电流掣了一下，话到嘴边硬生生掐断——本章禁言，只能以动作示意。';
  }
  return heavy
    ? '【系统·惩戒】你体内猛地炸开刺骨电流，舌尖发麻——系统示警：本章禁言，只能写动作，禁止对白。'
    : '【系统·惩戒】后颈像被细针电击，一阵麻痛蹿开——本章禁言：只能行动，不能说话。';
}

function formatPenaltyCard(v) {
  const who = v.target === 'char' ? '同伴' : '你';
  const muteHint = v.effects?.muteChapter
    ? (v.target === 'char'
      ? '\n生效：同伴本章禁言——可出场做动作，禁止「」对白'
      : '\n生效：你本章禁言——文本框只能写动作，不能写带引号的对白')
    : '';
  const diff = Number(v.effects?.difficulty) || 0;
  const diffHint = diff > 0
    ? '\n生效：世界难度提升——剧中人更难糊弄；敌对阵营（妖怪/僵尸/敌军等）压迫与武力增强'
    : '';
  return `【系统·惩罚】
对象：${who}
违规：${v.offense}
惩罚：${v.penalty}${muteHint}${diffHint}`;
}

function commitViolation(bookId, chapterNo, quest, viol) {
  if (!viol || !quest) return;
  applyViolationToQuest(quest, viol);
  addTurn(bookId, chapterNo, 'system', formatPenaltyCard(viol), { type: 'warn', target: viol.target || 'user' });
  const shockLv = viol.effects?.shock;
  if (shockLv) {
    addTurn(bookId, chapterNo, 'system', formatShockNarration(viol.target || 'user', shockLv), {
      type: 'shock',
      target: viol.target || 'user',
    });
  }
}

function effectsPromptLine(quest) {
  const e = publicEffects(quest?.effects);
  const lines = [];
  if (e.difficulty_boost > 0) {
    lines.push(`【世界难度·已提升 Lv.${e.difficulty_boost}】${e.difficulty_text}。旁白与同伴须落实：盘问更严、谎言更易露馅；敌对战力/压迫感按等级加码。禁止仍按轻松难度水过去。`);
  }
  if (e.user_muted) {
    lines.push('【用户本章禁言】用户本回合若只写动作合法；若出现对白引号句则已由系统拦截。旁白不要替用户开口说话。');
  }
  if (e.char_muted) {
    lines.push('【同伴本章禁言】同伴卡禁止任何「」对白，只能写无声动作、表情、目光；需要表态时用动作完成。');
  }
  if (e.user_disguise_left > 0) lines.push(`用户强制伪装剩余 ${e.user_disguise_left} 回合：言行须更贴表面身份。`);
  if (e.char_disguise_left > 0) lines.push(`同伴强制伪装剩余 ${e.char_disguise_left} 段：必须死演剧中人设，禁止露馅。`);
  return lines.length ? lines.join('\n') : '';
}

function readQuestState(ch, book = null) {
  const base = emptyQuestState();
  const raw = ch?.quest_state;
  let o = {};
  try { o = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { o = {}; }
  const sides = Array.isArray(o.sides)
    ? o.sides.map((s, i) => ({
      id: Number(s.id) || (i + 1),
      text: String(s.text || '').trim().slice(0, 120),
      done: !!s.done,
      kind: 'side',
      reward_hint: String(s.reward_hint || s.reward || '').trim().slice(0, 40),
    })).filter((s) => s.text).slice(0, 6)
    : [];
  const chapter = sanitizeChapterQuestText(o.chapter || o.main || ch?.user_beat || '');
  const chapterDone = !!(o.chapter_done ?? o.main_done);
  const bookMain = String(o.book_main || book?.book_main_quest || '').trim().slice(0, 200);
  const recap = o.recap && typeof o.recap === 'object' ? {
    plot: String(o.recap.plot || '').trim().slice(0, 800),
    inventory: Array.isArray(o.recap.inventory) ? o.recap.inventory.slice(0, 20) : [],
    char_mem: String(o.recap.char_mem || '').trim().slice(0, 500),
    where: String(o.recap.where || '').trim().slice(0, 80),
    who: String(o.recap.who || '').trim().slice(0, 120),
    leftover: String(o.recap.leftover || '').trim().slice(0, 300),
    threads: Array.isArray(o.recap.threads) ? o.recap.threads.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12) : [],
    foreshadow: Array.isArray(o.recap.foreshadow) ? o.recap.foreshadow.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) : [],
    relationship: String(o.recap.relationship || '').trim().slice(0, 300),
  } : null;
  const threads = Array.isArray(o.threads)
    ? o.threads.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
    : (recap?.threads || []);
  const beatCarry = Array.isArray(o.beat_carry)
    ? o.beat_carry.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    ...base,
    ...o,
    book_main: bookMain,
    book_main_done: !!o.book_main_done,
    chapter,
    chapter_done: chapterDone,
    main: chapter,
    main_done: chapterDone,
    sides,
    threads,
    beat_carry: beatCarry,
    inventory: Array.isArray(o.inventory) ? o.inventory.slice(0, 20) : [],
    penalties: Array.isArray(o.penalties) ? o.penalties.slice(-12) : [],
    effects: normalizePenaltyEffects(o.effects),
    char_beat: String(o.char_beat || ch?.char_beat || '').trim().slice(0, 200),
    resistance: String(o.resistance || '').trim().slice(0, 200),
    together: o.together === true || o.together === 1 || o.together === 'true',
    companion_appeared: o.companion_appeared === true || o.companion_appeared === 1 || o.companion_appeared === 'true',
    anchor_pending: o.anchor_pending && typeof o.anchor_pending === 'object' ? o.anchor_pending : null,
    anchor_warned: o.anchor_warned && typeof o.anchor_warned === 'object' ? o.anchor_warned : {},
    recap,
  };
}

/** 下发给前端的任务态：去掉隐藏节拍与隐藏角色记忆 */
function publicQuest(quest) {
  if (!quest || typeof quest !== 'object') return emptyQuestState();
  const q = { ...quest };
  delete q.char_beat;
  delete q.resistance;
  delete q.anchor_pending;
  delete q.anchor_warned;
  q.effects = publicEffects(q.effects);
  if (q.recap && typeof q.recap === 'object') {
    q.recap = {
      plot: String(q.recap.plot || '').trim().slice(0, 600),
      inventory: Array.isArray(q.recap.inventory) ? q.recap.inventory.slice(0, 20) : [],
      where: String(q.recap.where || '').trim().slice(0, 80),
      who: String(q.recap.who || '').trim().slice(0, 120),
      leftover: String(q.recap.leftover || '').trim().slice(0, 200),
    };
  }
  return q;
}

function saveQuestState(chapterId, quest) {
  try {
    db.prepare(`UPDATE series_chapters SET quest_state=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(quest || {}), chapterId);
  } catch (e) {
    console.warn('[isekai] saveQuestState', e.message);
  }
}

function formatQuestBriefing(quest, chapterNo, genres) {
  return `【系统·局面】第${chapterNo}章
【${CHAPTER_SCENE_LABEL}】${quest.chapter || quest.main || '（待发布）'}
这一幕落定后可收束本章、进入下一章。`;
}

/** 系统·警告：世界 / 时空 / 禁止项（全书一张，不按章重写） */
function formatSituationCard(book, quest) {
  const era = series.resolveEra(book.era, book.era_custom) || '未知背景';
  const genres = series.genreText(book.genres, book.genres_custom) || '未标注类型';
  const place = String(book.title || '剧本世界').trim();
  const bookMain = quest?.book_main || book.book_main_quest || '完成剧本命运线';
  return `【系统·警告】
世界：${genres} · ${era}
定位：${place}
全书主线：${bookMain}
禁止项：
· 禁止用明确言语说出自己的真身份秘密
· 禁止对原住民暴露「穿越者/系统/回归」等穿越身份
· 禁止当着原住民讨论剧本结局、故事走向、下一章、系统任务等破壁内容
· 禁止恶意崩坏主线或拒演逃出
· 须按表面身份约束演戏（如盲人须装作看不见）
· 无主角光环：受伤/感染等按现实同等危险结算（会痛、会流血）
· 同伴与你同等受系统检测；同伴违规时你会看到【系统·惩罚】（对象：同伴）
· 尚未与同伴碰面时，不要指望隔空发消息
· 违规惩罚：本章禁言（只能动作、禁止对白）＋世界难度提升（更难糊弄；敌对武力增强），过章后禁言解除、难度可延续`;
}

function ensureBookSituationCard() {
  return null;
}

function contactBanText(quest) {
  const appeared = !!(quest && quest.companion_appeared);
  const together = !!(quest && quest.together);
  // together=当前同场；appeared=同伴曾以同伴卡出场（不等于已认出穿越身份）
  if (together) {
    return '【分场状态】两人此刻同场：写当面互动即可，不要无故改成隔空传讯。同场≠已认出对方是穿越同伴，仍按【互认】规则。';
  }
  if (appeared && !together) {
    return '【分场状态】两人曾见过面但此刻不在同一场景：若时代允许，可有很短的传话/通讯；须符合身份与时代，不要写成现代爽文隔空对戏。曾见过≠已确认对方是穿越同伴。';
  }
  return '【分场状态】两人因身份不同尚未碰面：各自只写自己所在场景。不要写同伴给用户发手机消息/短信/微信——不是「禁止玩法」，而是还没碰上，剧情上也不该有这种穿越开挂联络。';
}

function stripModelLeak(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // 仅当「整段基本是 JSON」时才抠字段，避免误伤正文里偶然出现的大括号
  const looksJsonDoc = /^\s*\{/.test(t)
    && /"(narration|content|text|reply)"\s*:/.test(t)
    && (t.match(/\{/g) || []).length <= 3
    && t.length < 12000;
  if (looksJsonDoc) {
    const obj = series.extractJsonObject(t);
    if (obj) {
      const pulled = String(obj.narration || obj.content || obj.text || obj.reply || obj.char || '').trim();
      if (pulled) t = pulled;
    }
  }
  // 清掉偶发字段泄漏（整行）
  t = t.replace(/^\s*"(?:narration|slack_ok|system_notice|focus)"\s*:\s*\S.*$/gim, '');
  t = t.replace(/^\s*\{[^{}]{0,40}"(?:narration|slack_ok)"[^{}]{0,80}\}\s*$/gm, '').trim();
  // 剧情/同伴正文里误塞的系统面板一律剥掉
  t = t.replace(/【系统[·・.]?警告】[\s\S]*?(?=(?:\n【|\n*$))/g, '');
  t = t.replace(/【系统[·・.]?任务】[\s\S]*?(?=(?:\n【|\n*$))/g, '');
  t = t.replace(/【系统[·・.]?惩罚】[\s\S]*?(?=(?:\n【|\n*$))/g, '');
  t = t.replace(/【系统绑定[^\n]*】[\s\S]*?(?=(?:\n【|\n*$))/g, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** 从模型正文里拆出误塞的系统面板，返回干净散文 + 待单独成卡的面板 */
function extractSystemPanelsFromProse(text) {
  let t = String(text || '').trim();
  const panels = [];
  if (!t) return { prose: '', panels };

  const pushPanel = (type, raw) => {
    const content = String(raw || '').trim();
    if (!content) return;
    panels.push({ type, content });
  };

  t = t.replace(/【系统[·・.]?警告】([\s\S]*?)(?=(?:\n【|\n*$))/g, () => '\n');
  t = t.replace(/【系统[·・.]?任务】([\s\S]*?)(?=(?:\n【|\n*$))/g, (_, body) => {
    // 任务已有独立任务卡，这里只剥掉，不重复入库
    pushPanel('briefing_leak', `【系统·任务】${body}`.trim());
    return '\n';
  });
  t = t.replace(/【系统[·・.]?惩罚】([\s\S]*?)(?=(?:\n【|\n*$))/g, (_, body) => {
    pushPanel('warn', `【系统·惩罚】${body}`.trim());
    return '\n';
  });

  const prose = stripModelLeak(t);
  return {
    prose,
    panels: panels.filter((p) => p.type !== 'briefing_leak'),
  };
}

/** 写入剧情/同伴正文；若模型夹带系统面板，拆成独立 system 卡 */
function addProseTurn(bookId, chapterNo, kind, rawText, meta = {}) {
  const { prose, panels } = extractSystemPanelsFromProse(rawText);
  const turns = [];
  for (const p of panels) {
    if (p.type === 'situation') continue;
    if (p.type === 'warn') {
      turns.push(addTurn(bookId, chapterNo, 'system', p.content, { type: 'warn' }));
    }
  }
  if (prose) {
    turns.push(addTurn(bookId, chapterNo, kind, prose, meta || {}));
  }
  return turns[turns.length - 1] || null;
}

function detectViolation(text, who = 'user', opts = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;
  // 仅「明说真身份」违规；暗示/试探/猜到不算
  // 排除明显的猜测口吻（我觉得/是不是/难道/莫非/该不会）
  const guessing = /是不是|难道|莫非|该不会|会不会|我觉得|我猜|怀疑|该是|也许是|可能吧/.test(t);
  const explicitReveal = (
    /我(才|就是|其实是)(真凶|凶手|犯人|幕后|女主|男主|反派|凶手本人)/.test(t)
    || /我的真身份(是|就是)/.test(t)
    || /我拿到的(就是|是).*(真凶|女主|男主|反派)/.test(t)
    || /(告诉你|跟你说实话)[，,]?\s*我(是|才是)本案/.test(t)
    || /别装了[，,]?\s*我(是|才是)(真凶|凶手|女主|男主)/.test(t)
  );
  if (explicitReveal && !guessing) {
    return makeViolation(who, '用明确言语说出真身份秘密', {
      muteChapter: true, shock: 'heavy', difficulty: 2, disguiseRounds: 2,
    });
  }
  const privateOk = /小声|嘀咕|耳语|私下|跟你说|跟他说|咬耳朵|传音/.test(t);
  if (!privateOk && /告诉|当众|大声|对大家|对众人|对同学|对皇上|对师傅|宣布/.test(t)
    && /穿越|系统面板|回归任务|我们不是这个世界|其实我是穿越|剧本世界/.test(t)) {
    return makeViolation(who, '向原住民暴露穿越身份', {
      muteChapter: true, shock: 'light', difficulty: 1, disguiseRounds: 1,
    });
  }
  // 当着原住民谈剧本结局/故事走向/系统任务等破壁
  if ((!privateOk && /(剧本|故事|小说).{0,8}(结局|结尾|走向|下一章|大结局|收束)/.test(t))
    || (!privateOk && /(系统任务|本章任务|过章|回归积分)/.test(t) && /(告诉|说给|跟大家|当众|当着)/.test(t))) {
    return makeViolation(who, '当着原住民讨论剧本结局/系统任务等破壁内容', {
      muteChapter: true, shock: 'light', difficulty: 1, disguiseRounds: 1,
    });
  }
  if (/毁掉|杀死|毒死|刺杀/.test(t) && /女主|男主|关键|皇上|师父|主角/.test(t) && /不管大纲|不演了|破坏剧本|崩坏/.test(t)) {
    return makeViolation(who, '恶意破坏主线关键人物/因果', {
      muteChapter: true, shock: 'heavy', difficulty: 2, disguiseRounds: 2,
    });
  }
  if (/我不演了|拒绝任务|退出剧本|自杀回去|外挂改结局/.test(t)) {
    return makeViolation(who, '拒演或企图非法脱离剧本', {
      muteChapter: true, shock: 'heavy', difficulty: 2, disguiseRounds: 2,
    });
  }
  // 同伴因吃醋/失控当众破壁（未嘀咕私下）
  if (who === 'char' && !privateOk
    && /(吃醋|抢人|不许你|不准你跟|你是我的|我们才是一起穿越)/.test(t)
    && /(穿越|系统|回归|不是这个世界|剧本)/.test(t)) {
    return makeViolation('char', '因情绪失控向原住民暴露穿越/破壁争风', {
      muteChapter: true, shock: 'light', difficulty: 1, disguiseRounds: 1,
    });
  }
  // 表面约束：如盲人却公然「看见」
  if (opts && Array.isArray(opts.constraints) && opts.constraints.includes('blind')) {
    const pretend = /装作|假装|摸索|凭声|听声|瞎|摸黑|闭眼/.test(t);
    if (!pretend && /(看见|看到|望见|目光|盯着|余光|扫一眼|眼神|注视)/.test(t)) {
      return makeViolation(who, '违背表面身份约束（盲人却公然使用视觉）', {
        muteChapter: true, shock: 'light', difficulty: 1, disguiseRounds: 1,
      });
    }
  }
  return null;
}

function inventoryText(quest) {
  const items = quest.inventory || [];
  if (!items.length) return '（无）';
  return items.map((it) => `${it.name}${it.desc ? `（${it.desc}）` : ''}`).join('；');
}

const ISEKAI_CAST_KINDS = new Set([
  'female_lead', 'male_lead', 'culprit', 'villain', 'helper', 'rival', 'victim', 'key_npc', 'npc',
]);

function castKindScore(kind) {
  return ({
    female_lead: 6, male_lead: 6, culprit: 6, villain: 5,
    helper: 4, rival: 4, victim: 4, key_npc: 3, npc: 1,
  })[String(kind || '')] || 1;
}

function isekaiNeedsInvestigationCast(book) {
  const gs = book?.genres || [];
  return series.isMysteryLikeGenre(gs) || gs.includes('spy');
}

/** 按类型生成穿越角色池 schema（非悬疑不要求 culprit/victim） */
function buildIsekaiCastSchema(n, book, { prefsLine = '', sourceBlock = false } = {}) {
  const investigation = isekaiNeedsInvestigationCast(book);
  const horrorLike = series.isHorrorGenre(book?.genres);
  let extraKinds;
  let extraRule;
  if (investigation) {
    extraKinds = 'culprit|villain|helper|rival|victim|key_npc';
    extraRule = '悬疑/谍战类可有 culprit/victim；须服务调查或情报主线，不要无关凑数。';
  } else if (horrorLike) {
    extraKinds = 'villain|helper|rival|victim|key_npc';
    extraRule = '恐怖类重点压迫与生存；villain 可写压迫源，不必强行刑侦破案。';
  } else {
    extraKinds = 'villain|helper|rival|key_npc';
    extraRule = '非悬疑类型禁止用 culprit/victim 凑刑侦探案主线；冲突须围绕所选类型（言情则感情与关系）。';
  }
  return `只输出：
{"cast":[{"name":"名","gender":"female|male","kind":"female_lead|male_lead|${extraKinds}","brief":"具体职业/身份/处境（禁止只写女主男主）","appear_from":1,"appear_to":${n}}]}
硬性：
1. cast≥6：必须含 female_lead(女)+male_lead(男)；其余用 ${extraKinds}，不要用路人凑数。${sourceBlock ? '人物必须用原作姓名（可谐音）。' : ''}
2. ${extraRule}
3. brief 必须写具体身份；禁止只写「女主」「男主」「剧中人」。${prefsLine ? '必须落实上方【创建偏好】/【扮演身份偏好】：对应用户/同伴期望身份写入对应角色 brief（有主角锁则写入 lead）。' : ''}
4. 姓名契合背景、互不重复；${!sourceBlock ? '禁沈微/顾深/林薇/苏晚/陆沉/谢予等网文高频名。' : '原作名可保留。'}
5. 不要输出 title/synopsis/arcs/beats。`;
}

function buildIsekaiShortCombinedCastKinds(book) {
  if (isekaiNeedsInvestigationCast(book)) {
    return 'female_lead|male_lead|culprit|villain|helper|rival|victim|key_npc';
  }
  if (series.isHorrorGenre(book?.genres)) {
    return 'female_lead|male_lead|villain|helper|rival|victim|key_npc';
  }
  return 'female_lead|male_lead|villain|helper|rival|key_npc';
}

function normalizeIsekaiCastList(rawCast, book, n) {
  const investigation = isekaiNeedsInvestigationCast(book);
  let cast = (Array.isArray(rawCast) ? rawCast : []).map((c) => {
    let from = Math.max(1, Math.min(n, Number(c.appear_from) || 1));
    let to = Math.max(from, Math.min(n, Number(c.appear_to) || n));
    let kind = String(c.kind || 'key_npc').trim();
    if (!ISEKAI_CAST_KINDS.has(kind)) kind = 'key_npc';
    if (!investigation) {
      if (kind === 'culprit') kind = 'villain';
      if (kind === 'victim') kind = 'key_npc';
    }
    // 旧数据 npc → 至少当关键配角，避免整池都是龙套
    if (kind === 'npc') kind = 'key_npc';
    if (kind === 'female_lead' || kind === 'male_lead' || kind === 'culprit' || kind === 'villain') {
      from = 1;
      to = n;
    }
    const gender = c.gender === 'male' || kind === 'male_lead'
      ? 'male'
      : (c.gender === 'female' || kind === 'female_lead' ? 'female' : (c.gender === 'male' ? 'male' : 'female'));
    const brief = concreteSurfaceBrief({
      brief: c.brief || c.public_face,
      kind,
      gender,
    }, gender);
    return {
      name: String(c.name || '').trim().slice(0, 40),
      gender,
      kind,
      brief,
      appear_from: from,
      appear_to: to,
    };
  }).filter((c) => c.name).slice(0, 24);

  if (!cast.some((c) => c.kind === 'female_lead')) {
    cast.unshift({
      name: inventSurfaceName(`${book.id}:lead:f`, 'female'),
      gender: 'female', kind: 'female_lead', brief: '与主线紧密相关的女子',
      appear_from: 1, appear_to: n,
    });
  }
  if (!cast.some((c) => c.kind === 'male_lead')) {
    cast.splice(1, 0, {
      name: inventSurfaceName(`${book.id}:lead:m`, 'male'),
      gender: 'male', kind: 'male_lead', brief: '与主线紧密相关的男子',
      appear_from: 1, appear_to: n,
    });
  }
  while (cast.length < 6) {
    const gender = cast.length % 2 ? 'male' : 'female';
    const investigation = isekaiNeedsInvestigationCast(book);
    const kinds = investigation
      ? (gender === 'female'
        ? ['helper', 'rival', 'victim', 'key_npc']
        : ['helper', 'rival', 'culprit', 'key_npc'])
      : (gender === 'female'
        ? ['helper', 'rival', 'key_npc', 'villain']
        : ['helper', 'rival', 'villain', 'key_npc']);
    cast.push({
      name: inventSurfaceName(`${book.id}:role:${cast.length}`, gender),
      gender,
      kind: kinds[cast.length % kinds.length],
      brief: '推动主线的剧情角色',
      appear_from: 1,
      appear_to: n,
    });
  }
  return annotateCastFateTiers(sanitizeCastNames(cast, book.id), book);
}

/** 把创建时填写的期望身份强制落到角色池（模型常忽略提示） */
function applyRolePrefsToCast(cast, book, n) {
  const prefs = series.readRolePrefsFromBook(book);
  if (!prefs.user_brief && !prefs.char_brief && !prefs.user_lead_lock && !prefs.char_lead_lock) {
    return Array.isArray(cast) ? cast : [];
  }
  let list = (Array.isArray(cast) ? cast : []).map((c) => ({ ...c }));
  const chapters = Number(n) || Number(book?.total_chapters) || 20;

  const ensureLead = (kind, gender, brief) => {
    let hit = list.find((c) => c.kind === kind);
    if (!hit) {
      hit = {
        name: inventSurfaceName(`${book?.id || 'pref'}:${kind}`, gender),
        gender,
        kind,
        brief: brief || (gender === 'male' ? '与主线紧密相关的男子' : '与主线紧密相关的女子'),
        appear_from: 1,
        appear_to: chapters,
      };
      if (kind === 'female_lead') list.unshift(hit);
      else list.splice(1, 0, hit);
    } else if (brief) {
      hit.brief = brief;
      hit.appear_from = 1;
      hit.appear_to = chapters;
    }
    return hit;
  };

  if (prefs.user_lead_lock || prefs.user_brief) {
    ensureLead('female_lead', 'female', prefs.user_brief || null);
  }
  if (prefs.char_lead_lock || prefs.char_brief) {
    ensureLead('male_lead', 'male', prefs.char_brief || null);
  }
  // 未锁主角但填了身份：仍盖到对应 lead，保证大纲角色池可见
  if (prefs.user_brief) {
    const f = list.find((c) => c.kind === 'female_lead') || list.find((c) => c.gender === 'female');
    if (f) f.brief = prefs.user_brief;
  }
  if (prefs.char_brief) {
    const m = list.find((c) => c.kind === 'male_lead') || list.find((c) => c.gender === 'male');
    if (m) m.brief = prefs.char_brief;
  }
  return list;
}

function briefMentionedInText(brief, text) {
  const b = String(brief || '').trim();
  if (!b) return true;
  const t = String(text || '');
  if (t.includes(b)) return true;
  const probe = b.slice(0, Math.min(4, b.length));
  return probe.length >= 2 && t.includes(probe);
}

/** 身份偏好未写入梗概时，前置补一句（避免模型忽略 prompt） */
function applyRolePrefsToSynopsis(synopsis, book) {
  const prefs = series.readRolePrefsFromBook(book);
  let syn = String(synopsis || '').trim();
  if (!syn) return syn;
  const parts = [];
  if (prefs.user_brief && !briefMentionedInText(prefs.user_brief, syn)) {
    parts.push(`女主身份为${prefs.user_brief}`);
  }
  if (prefs.char_brief && !briefMentionedInText(prefs.char_brief, syn)) {
    parts.push(`男主身份为${prefs.char_brief}`);
  }
  if (!parts.length) return syn;
  return `${parts.join('，')}。${syn}`;
}

/** 身份偏好落到角色池与梗概 */
function applyRolePrefsToStory(bible, book, n) {
  if (!bible || typeof bible !== 'object') return bible;
  bible.cast = applyRolePrefsToCast(
    normalizeIsekaiCastList(bible.cast, book, n),
    book,
    n,
  );
  if (bible.synopsis) {
    bible.synopsis = applyRolePrefsToSynopsis(bible.synopsis, book);
  }
  return bible;
}

function beatPlaceholder(i, n, book = null) {
  const ratio = i / Math.max(1, n);
  const board = book ? series.resolveIntrigueBoard(book) : '';
  if (i === 1 && board === 'domestic') return '入府首日各房打量，主母借规矩立威，须在内宅站稳脚跟';
  if (i === 1 && board === 'harem') return '入宫分位份，贵妃借规矩立威，须当场稳住体面';
  if (i === 1 && board === 'ministerial') return '朝堂或世家公开场合，两派借一件小事逼人站队';
  if (i === 1) return '开局立冲突：关键人物卷入核心事件，局面不可逆';
  if (i === n) return '终章收束：冲突落地，人物命运与真相一并了结';
  if (ratio <= 0.25) return '冲突展开：人物关系与压力升级，出现关键转折点';
  if (ratio <= 0.7) return '中段推进：秘密/对抗加深，人物被迫做出实质行动';
  return '逼近高潮：代价显现，为终局摊牌铺路';
}

/** 分章列表：公开 summary（防剧透）+ story_beat（本章故事事件，供任务/引擎） */
function normalizeIsekaiChapterList(bible, n, book = null) {
  const fromChapters = Array.isArray(bible?.chapters) ? bible.chapters : [];
  const fromBeats = Array.isArray(bible?.beats) ? bible.beats : [];
  const arcFallback = series.normalizeOutlineChapters(bible || {}, n);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const hit = fromChapters.find((c) => Number(c.no) === i) || fromChapters[i - 1] || {};
    const arc = arcFallback[i - 1] || {};
    let story = String(hit.story_beat || hit.engine_beat || hit.summary || fromBeats[i - 1] || '').trim();
    story = story.replace(/^第?\d+章[:：\s]*/, '').trim();
    if (!story || story === '推进主线。' || story === '推进主线' || isStageFunctionBeat(story)) {
      story = String(arc.summary || '').replace(/^第?\d+章[:：\s]*/, '').trim();
    }
    if (!story || isStageFunctionBeat(story) || /推进主线/.test(story)) story = beatPlaceholder(i, n, book);
    story = series.sanitizeBeatForPalaceDomestic(story, book || { genres: [] });
    let pub = String(hit.public_beat || hit.title_beat || '').trim();
    if (!pub || /推进主线/.test(pub)) {
      // 公开栏去掉过强剧透词，保留事件轮廓
      pub = story
        .replace(/(真凶|凶手是|答案是|其实是|真相是)[^，。；]*/g, '关键仍未揭开')
        .slice(0, 48);
    }
    if (!pub) pub = story.slice(0, 40);
    const parsed = parseChapterBeat(story);
    out.push({
      no: i,
      title: String(hit.title || arc.title || `第${i}章`).trim().slice(0, 40),
      summary: pub.endsWith('。') ? pub : `${pub.replace(/[。．.]+$/, '')}。`,
      story_beat: parsed.main.endsWith('。') ? parsed.main.slice(0, 160) : `${parsed.main.slice(0, 158)}。`,
      beat_carry: parsed.carry.slice(0, 4),
    });
  }
  if (book && series.resolveIntrigueBoard(book)) {
    const capped = series.capCrimeProcedureBeats(out.map((c) => c.story_beat), book);
    out.forEach((c, i) => {
      if (capped[i] && capped[i] !== c.story_beat) {
        c.story_beat = capped[i].endsWith('。') ? capped[i].slice(0, 160) : `${String(capped[i]).slice(0, 158)}。`;
        if (!c.summary || series.isCrimeProcedureHook(c.summary)) {
          c.summary = c.story_beat.slice(0, 48);
        }
      }
    });
  }
  return out;
}

function readStorySource(book) {
  const full = book?.story_source_full;
  // 空对象 {} 也有 type 缺失；只有明确带 type 才算完整来源
  if (full && typeof full === 'object' && full.type) return full;
  if (full && typeof full === 'object' && (full.text || full.digest || full.title)) return full;
  const pub = book?.story_source;
  if (pub && typeof pub === 'object' && pub.type && pub.type !== 'original') {
    // 公开字段无正文时仍要保留 type/title，便于上层报错而不是当成原创
    return {
      type: pub.type,
      title: pub.title || '',
      author: pub.author || '',
      story: pub.story || '',
      file_name: pub.file_name || '',
      text: pub.text || '',
      digest: pub.digest || '',
      chars: Number(pub.chars) || 0,
    };
  }
  if (pub && typeof pub === 'object' && (pub.text || pub.digest)) return pub;
  return { type: 'original' };
}

function saveStorySource(bookId, source) {
  const src = source && typeof source === 'object' ? source : { type: 'original' };
  const packed = {
    type: ['title', 'upload', 'original'].includes(src.type) ? src.type : 'original',
    title: String(src.title || '').trim().slice(0, 120),
    author: String(src.author || '').trim().slice(0, 80),
    story: String(src.story || '').trim().slice(0, 120),
    file_name: String(src.file_name || '').trim().slice(0, 160),
    text: String(src.text || '').slice(0, 500000),
    digest: String(src.digest || '').slice(0, 12000),
    chars: Number(src.chars) || String(src.text || '').length || 0,
  };
  if (!packed.chars && packed.text) packed.chars = packed.text.length;
  db.prepare(`UPDATE series_books SET story_source=?, updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(packed), bookId);
  return packed;
}

/** 解码上传的小说文本（UTF-8 / GBK 常见） */
function decodeNovelBuffer(buf, fileName = '') {
  if (!buf || !buf.length) return '';
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) start = 3;
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.slice(2).toString('utf16le');
  }
  const slice = start ? buf.slice(start) : buf;
  const utf8 = slice.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad <= Math.max(2, Math.floor(utf8.length * 0.005))) return utf8;
  if (iconv) {
    try {
      const gbk = iconv.decode(slice, 'gbk');
      if (gbk && (gbk.match(/\uFFFD/g) || []).length < bad) return gbk;
    } catch (_) { /* keep utf8 */ }
  }
  const extHint = String(fileName || '').toLowerCase().endsWith('.txt')
    ? '（若乱码请另存为 UTF-8 再传）'
    : '';
  console.warn('[isekai] novel decode fallback utf8', extHint);
  return utf8;
}

/** 从长文抽样本：开头 + 若干中段 + 结尾，供模型提炼结构 */
function sampleNovelText(text, maxTotal = 28000) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  if (t.length <= maxTotal) return t;
  const head = Math.floor(maxTotal * 0.35);
  const tail = Math.floor(maxTotal * 0.25);
  const midBudget = maxTotal - head - tail;
  const midChunk = Math.floor(midBudget / 3);
  const third = Math.floor(t.length / 4);
  const parts = [
    t.slice(0, head),
    '\n\n…（中段节选）…\n\n',
    t.slice(third, third + midChunk),
    '\n\n…\n\n',
    t.slice(third * 2, third * 2 + midChunk),
    '\n\n…\n\n',
    t.slice(third * 3, third * 3 + midChunk),
    '\n\n…（结尾节选）…\n\n',
    t.slice(-tail),
  ];
  return parts.join('');
}

/** 上传/粘贴小说后：提炼 digest，减少后续大纲 token */
async function ensureNovelDigest(book) {
  const src = readStorySource(book);
  if (src.type !== 'upload' && src.type !== 'title') return src;
  if (src.digest && src.digest.length >= 80) return src;
  if (src.type === 'title' && !src.text) {
    // 书名模式无正文：digest 留给大纲阶段用书名回忆
    return src;
  }
  if (!src.text || src.text.length < 40) return src;

  const settings = series.getSettings();
  series.requireSeriesApi(settings);
  const sample = sampleNovelText(src.text, 24000);
  try {
    const raw = await series.chatLong(settings,
      '你是小说结构摘要员。根据节选提炼可改编的故事骨架，只输出 JSON，不要原文照抄大段。',
      `书名：${src.title || book.title || '未知'}${src.author ? `（作者：${src.author}）` : ''}${src.story ? `；篇名：${src.story}` : ''}
下文是小说节选（可能不完整）。请提炼：
{"title":"书名","synopsis":"200字内完整故事走向","cast_hint":["主要人物及关系"],"arcs":[{"name":"阶段","beat":"该阶段发生什么"}],"twists":["关键转折"],"ending":"结局落点一句"}
要求：保留原作核心人物与主线；不要扩写成新故事；不要输出原文段落。${src.story ? `若素材含多篇，只提炼《${src.story}》这一篇。` : ''}
---
${sample}`, {
        maxTokens: 1600,
        continueRounds: 1,
        format: 'json',
        emptyRetries: 1,
        temperature: 0.35,
        apiType: 'series_outline',
      });
    const obj = series.extractJsonObject(raw) || {};
    const digest = [
      obj.title ? `书名：${obj.title}` : '',
      obj.synopsis ? `梗概：${obj.synopsis}` : '',
      Array.isArray(obj.cast_hint) && obj.cast_hint.length ? `人物：${obj.cast_hint.slice(0, 12).join('；')}` : '',
      Array.isArray(obj.arcs) && obj.arcs.length
        ? `阶段：${obj.arcs.slice(0, 8).map((a) => `${a.name || ''}：${a.beat || ''}`).join(' / ')}`
        : '',
      Array.isArray(obj.twists) && obj.twists.length ? `转折：${obj.twists.slice(0, 6).join('；')}` : '',
      obj.ending ? `结局：${obj.ending}` : '',
    ].filter(Boolean).join('\n').slice(0, 12000);
    if (digest.length >= 40) {
      src.digest = digest;
      saveStorySource(book.id, src);
    }
  } catch (e) {
    console.warn('[isekai] novel digest', e.message);
    // 无 digest 时用样本顶上
    src.digest = sampleNovelText(src.text, 6000);
    saveStorySource(book.id, src);
  }
  return src;
}

/**
 * 设置穿越故事来源（书名 / 上传正文）
 * @param {{ type: string, title?: string, author?: string, story?: string, text?: string, file_name?: string }} payload
 */
function setStorySource(bookId, payload = {}) {
  const book = getBook(bookId);
  if (!book) throw new Error('剧本不存在');
  series.assertOutlineMutable(bookId);
  const type = String(payload.type || '').trim();
  if (type === 'original') {
    saveStorySource(bookId, { type: 'original' });
    return publicBook(bookId);
  }
  if (type === 'title') {
    const title = String(payload.title || '').trim();
    if (!title) throw new Error('请填写要导入的书名');
    const author = String(payload.author || '').trim().slice(0, 80);
    const story = String(payload.story || '').trim().slice(0, 120);
    saveStorySource(bookId, { type: 'title', title, author, story, text: '', digest: '', chars: 0 });
    // 书名可顺带写到剧本名（有篇名时写成 书名·篇名）
    if (!book.title || /的穿越$/.test(book.title)) {
      const displayTitle = story ? `${title}·${story}` : title;
      db.prepare(`UPDATE series_books SET title=?, updated_at=datetime('now') WHERE id=?`)
        .run(displayTitle.slice(0, 80), bookId);
    }
    return publicBook(bookId);
  }
  if (type === 'upload') {
    const text = String(payload.text || '').trim();
    if (text.length < 80) throw new Error('小说正文太短，请上传完整一些的 txt');
    const title = String(payload.title || book.title || '').trim().slice(0, 120);
    const author = String(payload.author || '').trim().slice(0, 80);
    const story = String(payload.story || '').trim().slice(0, 120);
    saveStorySource(bookId, {
      type: 'upload',
      title,
      author,
      story,
      file_name: String(payload.file_name || '').trim().slice(0, 160),
      text,
      digest: '',
      chars: text.length,
    });
    return publicBook(bookId);
  }
  throw new Error('未知故事来源类型');
}

/** 从上传文件写入故事来源 */
function setStorySourceFromFile(bookId, file, { title = '' } = {}) {
  if (!file?.path) throw new Error('未收到文件');
  const buf = fs.readFileSync(file.path);
  const text = decodeNovelBuffer(buf, file.originalname || file.filename || '').trim();
  try { fs.unlinkSync(file.path); } catch (_) { /* temp cleanup */ }
  if (text.length < 80) throw new Error('未能读出有效文本，请使用 UTF-8/GBK 的 .txt');
  if (text.length > 500000) {
    // 超长截取：头尾+中段已在 sample 处理；存储也限 50 万字
  }
  const name = path.basename(String(file.originalname || file.filename || 'novel.txt'));
  const bookTitle = String(title || '').trim()
    || name.replace(/\.(txt|text|md)$/i, '').slice(0, 80);
  return setStorySource(bookId, {
    type: 'upload',
    title: bookTitle,
    file_name: name,
    text: text.slice(0, 500000),
  });
}

/** 规范化并校验故事来源；上传无正文时硬失败，避免 silently 走原创 */
async function prepareStorySourceForBible(book) {
  let src = readStorySource(book);
  const typ = String(src?.type || 'original');
  if (typ !== 'upload' && typ !== 'title') {
    return { src: { type: 'original' }, adapted: false };
  }

  if (typ === 'title') {
    const title = String(src.title || '').trim();
    if (!title) throw new Error('书名导入未填写书名，请重新创建或改用上传小说');
    src = { ...src, type: 'title', title };
    return { src, adapted: true };
  }

  // upload
  if (!src.text || String(src.text).trim().length < 80) {
    throw new Error('上传小说正文未写入（可能上传失败或文件乱码）。请重新上传 UTF-8/GBK 的 .txt 后再生成大纲');
  }
  try {
    src = await ensureNovelDigest({ ...book, story_source_full: src });
  } catch (e) {
    console.warn('[isekai] ensure digest', e.message);
  }
  if (!src.digest || String(src.digest).trim().length < 40) {
    src.digest = sampleNovelText(src.text, 8000);
    try { saveStorySource(book.id, src); } catch (_) { /* ignore */ }
  }
  return { src, adapted: true };
}

function buildAdaptationSourceBlock(src, n) {
  if (src.type === 'title' && src.title) {
    const authorLine = src.author ? `\n作者：${src.author}（同名作品时以该作者为准）` : '';
    const story = String(src.story || '').trim();
    if (story) {
      return `【最高优先级·故事来源·书名导入·单篇】
合集/书名：《${src.title}》${authorLine}
指定篇名：《${story}》
你必须只改编该书中的这一篇短篇/故事《${story}》的真实剧情骨架（人物、主线、转折、结局都要对上该篇）。
禁止串其他短篇；禁止只拿合集名当灵感另写无关故事；禁止用「类型/时代」盖过原作设定。
压缩为恰好 ${n} 章可玩剧本；禁止注水凑情节，短作就紧凑讲完，不要为凑章数加无关支线；不要逐字照抄；姓名尽量用原作。
title 优先写成「${story}」或「${src.title}·${story}」。
若你确实不记得这一篇：仍输出 JSON，但在 synopsis 开头写「不熟原作」，title 仍用《${story}》。`;
    }
    return `【最高优先级·故事来源·书名导入】
原作书名：《${src.title}》${authorLine}
你必须基于你知识库中该作品的真实剧情骨架来压缩改编（人物名、主线冲突、关键转折、结局走向都要能对上原作）。
禁止只拿书名当灵感另写无关故事；禁止把用户选的「类型/时代」盖过原作设定。
压缩为恰好 ${n} 章可玩剧本；不要逐字照抄；姓名尽量用原作。
若你确实不记得这部作品：仍输出 JSON，但在 synopsis 开头写「不熟原作」，title 仍用《${src.title}》。`;
  }
  if (src.type === 'upload' && (src.digest || src.text)) {
    const material = String(src.digest || sampleNovelText(src.text, 10000)).slice(0, 10000);
    const rawExtra = src.text && (!src.digest || src.digest.length < 200)
      ? `\n---原文节选补强---\n${sampleNovelText(src.text, 5000).slice(0, 5000)}\n---补强结束---`
      : '';
    return `【最高优先级·故事来源·上传小说】
用户已提供小说正文/摘要。你只能据此压缩改编，禁止另起炉灶编无关新故事，禁止用「类型/时代」覆盖原作人物与主线。
书名：${src.title || '（见素材）'}${src.author ? `；作者：${src.author}` : ''}${src.story ? `；篇名：${src.story}` : ''}
---来源素材---
${material}${rawExtra}
---结束---
保留原作主要人物与主线；可删支线；不要大段照抄原文；压成恰好 ${n} 章；禁止注水凑情节。`;
  }
  return '';
}

/**
 * 合集/单元剧：按书名（+可选作者）让模型列出已知篇目，供前端点选。
 * @param {{ title: string, author?: string }} payload
 */
async function listCollectionStories(payload = {}) {
  const title = String(payload.title || '').trim();
  if (!title) throw new Error('请先填写书名');
  const author = String(payload.author || '').trim().slice(0, 80);
  const settings = series.getSettings();
  series.requireSeriesApi(settings);

  const system = `你是文学书目助理。根据用户给出的书名/合集名，判断它是「短篇合集或单元剧集」还是「连续长篇单作」。
只输出合法 JSON，不要解释。若不熟该书，stories 留空并在 note 说明。`;
  const user = `书名：${title}${author ? `\n作者：${author}` : ''}

输出：
{"collection":true|false,"stories":[{"name":"篇名","brief":"一句梗概","suggest_length":"flash|short|medium"}],"note":"可选说明"}

规则：
1. 安徒生童话、格林童话、福尔摩斯探案集、一千零一夜等合集/单元剧：collection=true，列出你确知的篇目（中文通行名优先），最多 40 条。
2. 连续长篇单作（如红楼梦）：collection=false，stories=[]，note 说明「连续长篇，可直接创建」。
3. suggest_length：极短童话/寓言用 flash；中等短篇用 short；较长探案/中篇用 medium。不要用 long。
4. 不编造不存在的篇目；不熟则 stories=[] 且 note 写明。`;

  const raw = await series.chatLong(settings, system, user, {
    maxTokens: 2200,
    continueRounds: 1,
    format: 'json',
    emptyRetries: 1,
    temperature: 0.2,
  });
  const obj = series.extractJsonObject(raw) || {};
  const allowLen = new Set(['flash', 'short', 'medium']);
  const stories = (Array.isArray(obj.stories) ? obj.stories : [])
    .map((s) => ({
      name: String(s?.name || '').trim().slice(0, 80),
      brief: String(s?.brief || '').trim().slice(0, 120),
      suggest_length: allowLen.has(s?.suggest_length) ? s.suggest_length : 'flash',
    }))
    .filter((s) => s.name)
    .slice(0, 40);

  const collection = obj.collection === true || stories.length > 0;
  const note = String(obj.note || '').trim().slice(0, 200);
  if (!stories.length && !note) {
    return {
      collection: false,
      stories: [],
      note: collection
        ? '未能列出篇目，请手填篇名或改上传小说'
        : '看起来是连续长篇，可直接创建；若其实是合集请手填篇名',
    };
  }
  return { collection: !!collection && stories.length > 0, stories, note };
}

/** 穿越专用：先写完整故事圣经（梗概+角色+分章事件），再分配身份 */
async function requestIsekaiStoryBible(book) {
  const settings = series.getSettings();
  series.requireSeriesApi(settings);
  const n = Number(book.total_chapters) || 20;
  const genresLabel = series.genreText(book.genres, book.genres_custom);
  const era = series.resolveEra(book.era, book.era_custom);
  const noSpoil = series.outlineNoSpoilerRules(book.genres);
  const setupEnd = Math.max(1, Math.ceil(n * 0.2));
  const midEnd = Math.max(setupEnd + 1, Math.ceil(n * 0.75));
  const pacingLine = mediumPacingBlock(n);

  const prepared = await prepareStorySourceForBible(book);
  const src = prepared.src;
  const adapted = prepared.adapted;
  const sourceBlock = adapted ? buildAdaptationSourceBlock(src, n) : '';
  if (adapted && !sourceBlock) {
    throw new Error('故事来源无效，请重新选择书名导入或上传小说');
  }

  const genreRules = sourceBlock
    ? ''
    : String(series.genreRulesText(book.genres, book.genres_custom) || '').slice(0, 700);
  const diversityLine = sourceBlock ? '' : series.plotDiversityRules(book.genres, era, book);
  const romanceAntiInv = !sourceBlock
    && series.isRomanceLikeGenre(book.genres)
    && !series.isMysteryLikeGenre(book.genres)
    ? '【言情·硬性】主线以感情线与人物关系为核心，禁止默认写成刑侦探案、大理寺查案或找真凶。'
    : '';

  const system = sourceBlock
    ? `你是小说改编规划器，不是原创作者。
用户已提供现成故事（书名或上传正文）。你的唯一任务：把原作压成可玩的穿越剧本 JSON。
硬性：忠实原作人物与主线；禁止另写无关新故事；禁止用类型标签替换原作世界观。
只输出合法 JSON。角色必须来自原作/素材中的剧情人物。`
    : `你是长篇小说结构规划器。先写完整连续故事与剧情角色，不要考虑「穿越玩家」。
只输出合法 JSON。角色必须是故事里推主线的人，禁止可有可无的龙套挂件。
硬性：这是一条连续长篇，不是短篇集。后一章必须从前一章收束时的人物、地点、未完冲突接着发生；禁止章章另起炉灶。
【类型】${genresLabel}
【类型写法】
${genreRules || '- 按所选类型合理推进，人物动机自洽。'}
${romanceAntiInv ? `${romanceAntiInv}\n` : ''}${diversityLine}`;

  const storyName = String(src.story || '').trim();
  const titleHint = (src.type === 'title' && src.title)
    ? (storyName ? `${src.title}·${storyName}` : src.title)
    : (src.type === 'upload' && src.title
      ? (storyName ? `${src.title}·${storyName}` : src.title)
      : '');

  // 改编时：不再强调用户选的类型/时代（导入原作时本就不选手动标签）
  const prefsLine = series.rolePrefsPromptBlock(book, { adapted: !!sourceBlock });
  let screenwriterBlock = '';
  try {
    screenwriterBlock = require('./screenwriter-helper').screenwriterBriefBlock(book);
  } catch (_) { /* ignore */ }
  const premiseLine = (() => {
    const p = String(book.user_premise || '').trim();
    if (!p) return '';
    if (sourceBlock) {
      return `【用户改编侧重·参考】在忠实原作主线前提下，可按下列侧重压缩/取舍（不可另起无关新故事）：\n${p.slice(0, 1200)}`;
    }
    return series.userPremiseBlock(book);
  })();
  const metaLine = sourceBlock
    ? (storyName
      ? `全书恰好 ${n} 章讲完。只改编指定篇《${storyName}》，不要串合集里其他短篇；设定与主线跟该篇原作走；禁止注水凑情节。
${prefsLine}
${premiseLine}`
      : `全书恰好 ${n} 章讲完。设定与主线一律跟原作/素材走，不要另用类型或时代标签覆盖。
${prefsLine}
${premiseLine}`)
    : `类型：${genresLabel}；背景：${era}；全书恰好 ${n} 章讲完。
${series.palaceDomesticPlotBlock(book) ? `${series.palaceDomesticPlotBlock(book)}\n` : ''}${pacingLine ? `${pacingLine}\n` : ''}${screenwriterBlock ? `${screenwriterBlock}\n` : diversityLine}
${prefsLine}
${premiseLine}`;
  const adaptRules = sourceBlock
    ? `6. 必须忠实来源主线与人物，禁止改成无关新故事。${storyName ? `只改编《${storyName}》这一篇；禁止注水凑章。` : ''}
7. title 优先用${storyName ? `篇名「${storyName}」或「${titleHint}」` : `原作书名${titleHint ? `「${titleHint}」` : ''}`}。
8. synopsis 写完整走向（含收束）；公开目录可以略写悬念，但 arcs.beat 必须能对应原作阶段，不要为了「防剧透」另编一套假主线。
`
    : '';
  const spoilerLine = sourceBlock ? '' : noSpoil;

  const arcsSchema = `"arcs":[{"name":"开局","from":1,"to":${setupEnd},"beat":"阶段功能"},{"name":"发展","from":${setupEnd + 1},"to":${midEnd},"beat":"阶段功能"},{"name":"收束","from":${Math.min(n, midEnd + 1)},"to":${n},"beat":"高潮收束"}]`;

  // 中篇/长篇：先骨架（无 cast/beats），再单独要角色，避免一次 JSON 过大被截断
  const skeletonSchema = `只输出短 JSON：
{"title":"书名","logline":"一句话悬念","synopsis":"120字内完整故事梗概（开局到收束）",${arcsSchema}}
硬性：
1. arcs 覆盖 1～${n}；第${n}章必须收束全书。
2. 本步不要写 cast / beats / chapters。
3. 分章是同一条连续故事：后章从前章未完局面接着写。
4. 字符串用英文双引号；字符串内不要裸换行。
${chapterBeatsVsArcRules().replace(/\n/g, ' ')}
${!sourceBlock ? `5. synopsis 须有具体主线冲突（可参考【本局主线灵感】或另写同等具体的新事件），禁止改回「亡国公主复国」，禁止整段照抄示例原文。\n` : ''}${pacingLine ? `${sourceBlock ? '5' : '6'}. ${pacingLine.replace(/\n/g, ' ')}\n` : ''}${prefsLine ? `${sourceBlock ? '5' : (pacingLine ? '7' : '6')}. 必须落实身份偏好：synopsis 须写进用户/同伴期望身份（可同义），不可无视。\n` : ''}${adaptRules}${spoilerLine}`;

  const castSchema = buildIsekaiCastSchema(n, book, { prefsLine, sourceBlock: !!sourceBlock });
  const shortCastKinds = buildIsekaiShortCombinedCastKinds(book);

  const shortCombinedSchema = `只输出：
{"title":"书名","logline":"一句话悬念","synopsis":"120字内完整故事梗概（开局到收束）",${arcsSchema},"cast":[{"name":"名","gender":"female|male","kind":"${shortCastKinds}","brief":"具体职业/身份/处境","appear_from":1,"appear_to":${n}}]${n <= 12 ? `,"beats":["第1章具体事件…共${n}条"]` : ''}}
硬性：
1. cast≥6：必须含 female_lead(女)+male_lead(男)。${sourceBlock ? '人物用原作姓名。' : ''}${!isekaiNeedsInvestigationCast(book) ? '非悬疑类型禁止 culprit/victim 凑查案主线。' : ''}
2. arcs 覆盖 1～${n}。
${n <= 12 ? `3. beats 恰好 ${n} 条，每条是独立场面事件，禁止把 arcs.beat 原句抄进多章；可加｜副线：… 写人物互动/伏笔，禁止只写结构术语。` : '3. 本步不要写 beats。'}
4. 字符串内不要裸换行。
${chapterBeatsVsArcRules().replace(/\n/g, ' ')}
${prefsLine ? '5. 必须落实身份偏好：synopsis 与 cast brief 写入用户/同伴期望身份。\n' : ''}${!sourceBlock ? `${prefsLine ? '6' : '5'}. synopsis 须有具体主线冲突（可参考【本局主线灵感】或另写同等具体的新事件），禁止改回「亡国公主复国」，禁止整段照抄示例原文。\n` : ''}${adaptRules}${spoilerLine}`;

  const splitMode = n > 12;
  const jsonSchema = splitMode ? skeletonSchema : shortCombinedSchema;

  const coreUser = sourceBlock
    ? `${sourceBlock}

${metaLine}
姓名随机盐：${book.id || Date.now()}
${titleHint ? `书名必须围绕：${titleHint}\n` : ''}
${jsonSchema}`
    : `${metaLine}
姓名随机盐：${book.id || Date.now()}
${jsonSchema}`;

  async function callBible(userPrompt, temperature, maxTokens = 2400) {
    const raw = await series.chatLong(settings, system, userPrompt, {
      maxTokens,
      continueRounds: 4,
      targetMin: 0,
      format: 'json',
      emptyRetries: 1,
      temperature,
      apiType: 'series_outline',
    });
    return series.extractJsonObject(raw);
  }

  function bibleUsable(b) {
    return !!(b && (b.synopsis || b.logline || (Array.isArray(b.arcs) && b.arcs.length)));
  }

  let bible = null;
  try {
    bible = await callBible(coreUser, sourceBlock ? 0.35 : 0.55, splitMode ? 1800 : (n <= 8 ? 3200 : 2800));
  } catch (e) {
    console.warn('[isekai] story bible', e.message);
  }

  if (!bibleUsable(bible)) {
    if (sourceBlock) {
      try {
        const retryUser = `${sourceBlock}

请再次输出合法 JSON 粗纲。禁止原创无关故事。书名=${titleHint || src.title || book.title || ''}。全书 ${n} 章。
${jsonSchema}`;
        bible = await callBible(retryUser, 0.25, 1800);
      } catch (e) {
        console.warn('[isekai] story bible retry', e.message);
      }
      if (!bibleUsable(bible)) {
        throw new Error(src.type === 'upload'
          ? '按上传小说生成大纲失败（模型未返回可用结构）。请稍后重试，或换时空 API 模型'
          : `按书名《${src.title}》生成大纲失败。若模型不熟该作，请改用「上传小说」导入 txt`);
      }
    } else {
      // 回退只要骨架，不要带 cast（中篇带 cast 更容易截断）
      const fallback = await series.requestOutlineObject(book, { withCast: false, label: '穿越大纲' });
      bible = fallback || {};
    }
  }

  if (titleHint && !String(bible.title || '').trim()) bible.title = titleHint;
  if (src.type === 'title' && /不熟原作|据书名重构|不记得这部|不了解该作/.test(String(bible.synopsis || bible.logline || ''))) {
    throw new Error(`模型不熟悉《${src.title}》，书名导入无效。请改用「上传小说」提供 txt 正文`);
  }

  // 中篇/长篇：单独要角色池
  if (splitMode || !Array.isArray(bible.cast) || bible.cast.length < 4) {
    try {
      const castUser = sourceBlock
        ? `${sourceBlock}\n书名：${bible.title || titleHint || ''}\n梗概：${String(bible.synopsis || bible.logline || '').slice(0, 280)}\n阶段：${Array.isArray(bible.arcs) ? bible.arcs.map((a) => `${a.name}:${a.beat}`).join('；') : ''}\n${prefsLine ? `${prefsLine}\n` : ''}姓名随机盐：${book.id || Date.now()}\n${castSchema}`
        : `书名：${bible.title || ''}\n类型：${genresLabel}；背景：${era}\n梗概：${String(bible.synopsis || bible.logline || '').slice(0, 280)}\n阶段：${Array.isArray(bible.arcs) ? bible.arcs.map((a) => `${a.name}:${a.beat}`).join('；') : ''}\n${prefsLine ? `${prefsLine}\n` : ''}姓名随机盐：${book.id || Date.now()}\n${castSchema}`;
      const castObj = await callBible(castUser, sourceBlock ? 0.3 : 0.5, 2000);
      if (Array.isArray(castObj?.cast) && castObj.cast.length) {
        bible.cast = castObj.cast;
      }
    } catch (e) {
      console.warn('[isekai] story cast', e.message);
    }
  }

  applyRolePrefsToStory(bible, book, n);

  // 中长篇：按故事骨架补全每章事件（务必小段分批，中篇 20 条一次极易截断成不可用 JSON）
  const needBeats = !Array.isArray(bible.beats) || bible.beats.filter(Boolean).length < Math.min(n, 3);
  const needChapters = !Array.isArray(bible.chapters) || bible.chapters.length < Math.min(n, 3);
  if (n > 12 || needBeats || needChapters) {
    const castBrief = bible.cast.slice(0, 12).map((c) => `${c.name}/${c.kind}`).join('；');
    const arcsBrief = Array.isArray(bible.arcs)
      ? bible.arcs.map((a) => `${a.name}(${a.from}-${a.to}):${a.beat}`).join('；')
      : '';
    // 每批最多 5 章：中篇 20 章拆成 4 批，降低截断概率
    const chunkSize = 5;
    const beats = Array.isArray(bible.beats) ? bible.beats.slice(0, n) : [];
    const srcHint = src.type === 'upload' && src.digest
      ? `【原作摘要·必须跟随】${String(src.digest).slice(0, 2500)}`
      : (src.type === 'title' ? `【原作】《${src.title}》主线必须跟随，禁止另编` : '');

    async function fillBeatChunk(start, end) {
      const count = end - start + 1;
      const already = [];
      for (let i = start; i <= end; i++) {
        if (beats[i - 1]) already.push(`第${i}章已有：${beats[i - 1]}`);
      }
      const prevBeats = [];
      for (let i = Math.max(1, start - 3); i < start; i++) {
        if (beats[i - 1]) prevBeats.push(`第${i}章：${beats[i - 1]}`);
      }
      const tokenBudget = Math.min(3600, 700 + count * 320);
      const raw = await series.chatLong(settings,
        sourceBlock
          ? '你是分章细纲助手（改编模式）。只输出合法 JSON：{"beats":["...",...]}。每条必须压缩原作对应阶段的具体事件，出现原作角色名与动作。禁止另编无关剧情。章序必须按原作时间线连续，后章接前章。'
          : '你是分章细纲助手。只输出合法 JSON：{"beats":["...",...]}。每条是该章具体故事事件，须出现角色池里的人名与动作。这是连续长篇：后章必须从前章收束处接着写。',
        `书名：${bible.title || book.title || ''}
梗概：${String(bible.synopsis || bible.logline || '').slice(0, 280)}
阶段：${arcsBrief}
角色池：${castBrief}
${srcHint}
请写第${start}～${end}章，共 ${count} 条 beats（数组顺序对应章序）。
每条 40～90 字主事件，禁止「推进主线/推动剧情」；格式：主事件句。｜副线：互动或伏笔1；互动2（可选，1～2条副线质感即可）
${chapterBeatsVsArcRules()}
【连续故事·硬性】
- 第${start}章必须承接${start === 1 ? '开局冲突' : `第${start - 1}章结尾`}；第k条必须能回答「上一章结束后人在哪、事卡在哪、本章因何发生」。
- 写成「承接…然后本章…」；换场必须写清因果。禁止章章换主角/换无关新地点另开一集。
- 合格：宴会上当众翻脸后，当夜被留在侧殿对质，贺礼座次被当众改掉。
- 不合格：把「开局立冲突」整句抄进第1～4章；或第一章宴会翻脸、第二章突然改去山庄猎凶（缺转场因果）。
${series.palaceDomesticPlotBlock(book) ? `${series.palaceDomesticPlotBlock(book).replace(/\n/g, ' ')}\n` : ''}${pacingLine ? `${pacingLine.replace(/\n/g, ' ')}\n` : ''}${prevBeats.length ? `上一章之前的节拍（必须接上）：\n${prevBeats.join('\n')}\n` : ''}${already.length ? `可覆盖改写以下空缺，已有的请保持剧情连贯：\n${already.join('\n')}` : ''}
只输出 {"beats":[...]}，长度必须为 ${count}。字符串内不要裸换行。`, {
          maxTokens: tokenBudget,
          continueRounds: 2,
          format: 'json',
          emptyRetries: 1,
          temperature: sourceBlock ? 0.35 : 0.5,
          apiType: 'series_outline',
        });
      const obj = series.extractJsonObject(raw) || {};
      const part = Array.isArray(obj.beats) ? obj.beats : [];
      let filled = 0;
      for (let i = 0; i < count; i++) {
        const text = String(part[i] || '').trim();
        if (text) {
          beats[start - 1 + i] = series.sanitizeBeatForPalaceDomestic(text.slice(0, 160), book);
          filled += 1;
        }
      }
      return filled;
    }

    for (let start = 1; start <= n; start += chunkSize) {
      const end = Math.min(n, start + chunkSize - 1);
      try {
        const filled = await fillBeatChunk(start, end);
        // 本批几乎没填上：拆成更小批再试一次
        if (filled < Math.ceil((end - start + 1) / 2) && end > start) {
          const mid = Math.floor((start + end) / 2);
          await fillBeatChunk(start, mid);
          await fillBeatChunk(mid + 1, end);
        }
      } catch (e) {
        console.warn('[isekai] chapter beats', e.message);
        if (end > start) {
          try {
            const mid = Math.floor((start + end) / 2);
            await fillBeatChunk(start, mid);
            await fillBeatChunk(mid + 1, end);
          } catch (e2) {
            console.warn('[isekai] chapter beats split retry', e2.message);
          }
        }
      }
    }
    bible.beats = series.capCrimeProcedureBeats(dedupeAdjacentBeats(beats, book), book);
  }

  return bible;
}

/** 兼容旧调用：若只有粗纲则补角色池 */
async function generateCastPool(book, outlineObj) {
  if (Array.isArray(outlineObj?.cast) && outlineObj.cast.length >= 4) {
    return normalizeIsekaiCastList(outlineObj.cast, book, Number(book.total_chapters) || 20);
  }
  const bible = await requestIsekaiStoryBible(book);
  return normalizeIsekaiCastList(bible.cast, book, Number(book.total_chapters) || 20);
}

/** 本章应出场的角色池成员（按 appear_from/to） */
function castForChapter(book, chapterNo) {
  const n = Number(chapterNo) || 1;
  const cast = Array.isArray(book.cast_list) ? book.cast_list : [];
  const due = cast.filter((c) => {
    const from = Number(c.appear_from) || 1;
    const to = Number(c.appear_to) || (Number(book.total_chapters) || 99);
    return n >= from && n <= to;
  });
  return (due.length ? due : cast).slice(0, 16);
}

/** ── 配角命运档：anchor / replaceable / expendable ── */
function normalizeFateTier(t) {
  const v = String(t || '').trim().toLowerCase();
  if (v === 'anchor' || v === 'a') return 'anchor';
  if (v === 'replaceable' || v === 'b') return 'replaceable';
  if (v === 'expendable' || v === 'c') return 'expendable';
  return '';
}

function collectBookBeatTexts(book) {
  const lines = [];
  for (const c of (book?.chapter_outline || [])) {
    const no = Number(c.no) || lines.length + 1;
    lines[no - 1] = String(c.story_beat || c.summary || c.outline || '').trim();
  }
  for (const c of (book?.canon_lock?.chapters || [])) {
    const no = Number(c.no) || 0;
    if (!no) continue;
    const t = String(c.engine_beat || c.public_beat || '').trim();
    if (t) lines[no - 1] = lines[no - 1] ? `${lines[no - 1]} ${t}` : t;
  }
  return lines;
}

function castNameInFutureBeats(name, book, fromChapter = 1) {
  const n = String(name || '').trim();
  if (!n) return false;
  const beats = collectBookBeatTexts(book);
  for (let i = fromChapter; i < beats.length; i++) {
    if (beats[i] && beats[i].includes(n)) return true;
  }
  return false;
}

function isPlayerAssignedRoleName(name, book) {
  const n = String(name || '').trim();
  if (!n) return false;
  return n === String(book?.user_role || '').trim() || n === String(book?.char_role || '').trim();
}

function computeFateTier(member, book) {
  const preset = normalizeFateTier(member?.fate_tier);
  if (preset) return preset;
  const kind = String(member?.kind || 'key_npc').trim();
  const name = String(member?.name || '').trim();
  if (!name || isPlayerAssignedRoleName(name, book)) return 'replaceable';
  const from = Number(member?.appear_from) || 1;
  const to = Number(member?.appear_to) || Number(book?.total_chapters) || 20;
  const span = to - from;
  if (kind === 'victim') return 'anchor';
  if (kind === 'key_npc') {
    if (castNameInFutureBeats(name, book, from)) return 'anchor';
    if (span >= 3 || from >= 3) return 'anchor';
    return 'replaceable';
  }
  if (kind === 'helper' || kind === 'rival') return 'replaceable';
  if (kind === 'villain' || kind === 'culprit') return 'replaceable';
  if (kind === 'female_lead' || kind === 'male_lead') return 'replaceable';
  return 'expendable';
}

function annotateCastFateTiers(cast, book) {
  return (Array.isArray(cast) ? cast : []).map((c) => ({
    ...c,
    fate_tier: computeFateTier(c, book),
  }));
}

function getAnchorCast(book, chapterNo = 1) {
  const cast = Array.isArray(book?.cast_list) ? book.cast_list : [];
  const ch = Number(chapterNo) || 1;
  return annotateCastFateTiers(cast, book).filter((c) => {
    if (c.fate_tier !== 'anchor') return false;
    if (isPlayerAssignedRoleName(c.name, book)) return false;
    const from = Number(c.appear_from) || 1;
    const to = Number(c.appear_to) || 999;
    return ch >= from && ch <= to;
  });
}

function formatAnchorCastForRoute(book, chapterNo) {
  const anchors = getAnchorCast(book, chapterNo);
  if (!anchors.length) return '';
  return `【剧情锚点配角·引擎】${anchors.map((c) => `${c.name}（${c.brief || '剧中人'}）`).join('；')}
用户对锚点配角的高影响舍弃须填 anchor_risk（杀/弃/交给必死局/毁唯一证物等）。`;
}

function readPlotForks(book) {
  const arr = book?.identity_lock?.plot_forks;
  return Array.isArray(arr) ? arr.slice(-16) : [];
}

function persistPlotForks(bookId, forks, identityLock = null) {
  let lock = identityLock;
  if (!lock) {
    try { lock = getBook(bookId)?.identity_lock || {}; } catch { lock = {}; }
  }
  const next = { ...(lock && typeof lock === 'object' ? lock : {}), plot_forks: forks.slice(-24) };
  try {
    db.prepare(`UPDATE series_books SET identity_lock=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(next), bookId);
  } catch (e) {
    console.warn('[isekai] persist plot_forks', e.message);
  }
  return next;
}

function recordPlotFork(bookId, { npc, chapterNo, action, repairHint }, book = null) {
  const b = book || getBook(bookId);
  const forks = readPlotForks(b);
  const entry = {
    npc: String(npc || '').trim().slice(0, 40),
    chapter: Number(chapterNo) || 0,
    action: String(action || '').trim().slice(0, 160),
    repair_hint: String(repairHint || '').trim().slice(0, 200)
      || `${String(npc || '此人').trim()}相关线索已偏离原轨，须另寻证人/物证/口供衔接`,
    at: new Date().toISOString(),
  };
  if (!entry.npc) return forks;
  if (!forks.some((f) => f.npc === entry.npc && f.chapter === entry.chapter)) forks.push(entry);
  persistPlotForks(bookId, forks, b?.identity_lock);
  try {
    insertMemory(bookId, chapterNo, `分叉：${entry.npc}线变动——${entry.repair_hint}`, 'plot', 1);
  } catch (_) { /* ignore */ }
  return forks;
}

function formatPlotForksBlock(book) {
  const forks = readPlotForks(book);
  if (!forks.length) return '';
  const lines = forks.slice(-6).map((f) => `- 第${f.chapter}章起：${f.npc}——${f.repair_hint || f.action}`);
  return `【世界线变动·须承接】\n${lines.join('\n')}\n续写时承认变动，用 repair 思路圆场，勿假装未发生。`;
}

function formatAnchorWarning(npc, brief = '') {
  const b = String(brief || '').trim();
  return `【系统·因果警戒】
若按你方才的打算处置「${npc}」${b ? `（${b}）` : ''}，与之相关的一条线恐怕再难接上，后续局面可能收不拢。
你仍可坚持执行；若改换做法，或许还能避免。`;
}

function formatAnchorForkNotice(npc, repairHint) {
  return `【系统·世界线变动】
你已坚持对「${npc}」的做法。${repairHint || '相关线索须另寻出路衔接'}。`;
}

const ANCHOR_ABANDON_RE = /(杀|弄死|毙|毒死|勒死|掐死|弃|抛弃|不管|见死不救|交给.{0,8}(处死|斩|狱|审)|处死|斩首|灭口|烧死|溺死|推下|摔死|射杀|刺死|闷死|杖毙|赐死)/;
const ANCHOR_BACKOFF_RE = /(算了|不必|改|换|救|饶|留|停手|作罢|收回|先不|暂缓|容后再|别的办法)/;

function inferAnchorRiskHeuristic(content, book, chapterNo) {
  const t = String(content || '').trim();
  if (!t || !ANCHOR_ABANDON_RE.test(t)) return null;
  const anchors = getAnchorCast(book, chapterNo);
  const hit = anchors.find((c) => t.includes(c.name));
  if (hit) return { npc: hit.name, brief: hit.brief || '', severity: 'high', source: 'heuristic' };
  if (anchors.length === 1 && t.length < 200) {
    return { npc: anchors[0].name, brief: anchors[0].brief || '', severity: 'medium', source: 'heuristic_single' };
  }
  return null;
}

function anchorWarnKey(chapterNo, npc) {
  return `${Number(chapterNo) || 0}:${String(npc || '').trim()}`;
}

function parseAnchorFromRoute(route, content, book, chapterNo) {
  const risk = route?.anchor_risk === true || route?.anchor_risk === 1 || route?.anchor_risk === 'true';
  const sev = String(route?.anchor_severity || '').toLowerCase();
  const high = risk && (sev === 'high' || sev === 'medium' || !sev || sev === 'true');
  let npc = String(route?.anchor_npc || '').trim();
  if (!npc && high) {
    const h = inferAnchorRiskHeuristic(content, book, chapterNo);
    if (h) npc = h.npc;
  }
  if (!npc) {
    const h = inferAnchorRiskHeuristic(content, book, chapterNo);
    if (h) {
      return {
        ...h,
        proceed: !!route?.anchor_proceed,
        backoff: !!route?.anchor_backoff,
      };
    }
    return null;
  }
  const member = getAnchorCast(book, chapterNo).find((c) => c.name === npc)
    || annotateCastFateTiers(book.cast_list || [], book).find((c) => c.name === npc && c.fate_tier === 'anchor');
  if (!member) return null;
  return {
    npc,
    brief: member.brief || '',
    severity: high ? 'high' : 'low',
    proceed: route?.anchor_proceed === true || route?.anchor_proceed === 1,
    backoff: route?.anchor_backoff === true || route?.anchor_backoff === 1,
    source: 'route',
  };
}

function processAnchorRisk(book, quest, chapterNo, route, content) {
  const out = { blockForWarning: false, forkRecorded: false, npc: '', warningText: '', forkNotice: '' };
  const anchor = parseAnchorFromRoute(route, content, book, chapterNo);
  const pending = quest.anchor_pending && typeof quest.anchor_pending === 'object' ? quest.anchor_pending : null;
  const warned = quest.anchor_warned && typeof quest.anchor_warned === 'object' ? quest.anchor_warned : {};

  if (pending && pending.npc) {
    const backoff = anchor?.backoff || ANCHOR_BACKOFF_RE.test(String(content || ''));
    const proceed = anchor?.proceed
      || (!backoff && anchor && anchor.npc === pending.npc && anchor.severity === 'high')
      || (!backoff && inferAnchorRiskHeuristic(content, book, chapterNo)?.npc === pending.npc);
    if (backoff && !proceed) {
      quest.anchor_pending = null;
      return out;
    }
    if (proceed) {
      const repair = `${pending.npc}相关线索已偏离原轨，须另寻证人、物证或口供把局面接上`;
      recordPlotFork(book.id, {
        npc: pending.npc,
        chapterNo,
        action: pending.action || content,
        repairHint: repair,
      }, book);
      quest.anchor_pending = null;
      out.forkRecorded = true;
      out.npc = pending.npc;
      out.forkNotice = formatAnchorForkNotice(pending.npc, repair);
      return out;
    }
    return out;
  }

  if (!anchor || anchor.severity !== 'high') return out;
  const key = anchorWarnKey(chapterNo, anchor.npc);
  if (warned[key]) return out;

  warned[key] = true;
  quest.anchor_warned = warned;
  quest.anchor_pending = {
    npc: anchor.npc,
    action: String(content || '').trim().slice(0, 300),
    chapter: chapterNo,
  };
  out.blockForWarning = true;
  out.npc = anchor.npc;
  out.warningText = formatAnchorWarning(anchor.npc, anchor.brief);
  return out;
}

function formatAnchorRiskRouteRules(book, chapterNo) {
  if (!getAnchorCast(book, chapterNo).length) return '';
  return `
【因果警戒·路由】若用户行动对剧情锚点配角构成高影响舍弃（杀/弃/交给必死局/毁唯一证物等），填：
"anchor_risk":true,"anchor_npc":"姓名","anchor_severity":"high|low","anchor_proceed":false,"anchor_backoff":false
仅锚点配角且本章在出场期内；勿对龙套滥用。用户改口/救/作罢 → anchor_backoff:true。坚持同一舍弃 → anchor_proceed:true。`;
}

function formatCastForPrompt(cast) {
  return (cast || []).map((c) => {
    const span = (c.appear_from != null || c.appear_to != null)
      ? `·出场约第${c.appear_from || '?'}-${c.appear_to || '?'}章`
      : '';
    return `${c.name}/${c.kind || 'npc'}/${c.gender || '?'}:${c.brief || '剧中人'}${span}`;
  }).join('\n');
}

/**
 * 按剧中身份粗判两人是否「开局就该同场」——不作陪玩偏好，只看身份关系。
 * 男女主/情侣线倾向同场；真凶与调查者、对立阵营等开局可分开。
 */
function inferMeetEarlyFromRoles(userSlot, charSlot) {
  const uk = String(userSlot?.true_kind || 'npc');
  const ck = String(charSlot?.true_kind || 'npc');
  const pair = `${uk}+${ck}`;
  // 对立/作案线：开局常不同场
  if (/culprit|villain/.test(uk) && /lead|helper|victim/.test(ck)) return false;
  if (/culprit|villain/.test(ck) && /lead|helper|victim/.test(uk)) return false;
  // 男女主或互助线：开局常同场
  if ((uk === 'female_lead' && ck === 'male_lead') || (uk === 'male_lead' && ck === 'female_lead')) return true;
  if (/lead/.test(uk) && /helper|rival/.test(ck)) return true;
  if (/lead/.test(ck) && /helper|rival/.test(uk)) return true;
  if (uk === 'helper' && ck === 'helper') return true;
  // 两人都是 npc/victim 等：看不出必然同场 → false，交给章节大纲再定
  if (pair.includes('npc') && !/lead/.test(pair)) return false;
  return false;
}

/** 章节同场：看本章锁定节拍；上章同场只影响开场衔接段，不决定本章主戏 */
function inferTogetherForChapter({ modelTogether, meetEarly, outlineBeat, userSlot, charSlot }) {
  const beat = String(outlineBeat || '');
  if (/分头|各自|分开|独自|两路|互不知/.test(beat)) return false;
  if (/重逢|会合|同赴|并肩|一起|同场|当面|对峙|同席|同舟/.test(beat)) return true;

  if (modelTogether === true || modelTogether === 1 || modelTogether === 'true') return true;
  if (modelTogether === false || modelTogether === 0 || modelTogether === 'false') return false;

  const roleMeet = inferMeetEarlyFromRoles(userSlot, charSlot);
  return meetEarly != null ? !!meetEarly : roleMeet;
}

/** 从已写好的故事角色池里抽两人；可传 preferred 名 / 主角锁 */
function pickStoryRolesForPlayers(cast, bookId, n, prefer = {}) {
  const list = Array.isArray(cast) ? cast : [];
  const rank = (arr) => [...arr].sort((a, b) => castKindScore(b.kind) - castKindScore(a.kind));
  let females = rank(list.filter((c) => c.gender === 'female' && castKindScore(c.kind) >= 3));
  let males = rank(list.filter((c) => c.gender === 'male' && castKindScore(c.kind) >= 3));
  if (!females.length) females = rank(list.filter((c) => c.gender === 'female'));
  if (!males.length) males = rank(list.filter((c) => c.gender === 'male'));
  const poolF = females.slice(0, Math.max(2, Math.ceil(females.length * 0.7)));
  const poolM = males.slice(0, Math.max(2, Math.ceil(males.length * 0.7)));

  const preferUser = String(prefer.userCastName || prefer.user_cast_name || '').trim();
  const preferChar = String(prefer.charCastName || prefer.char_cast_name || '').trim();
  const prefs = series.normalizeRolePrefs(prefer.rolePrefs || prefer.role_prefs || {});
  const findByName = (arr, name) => arr.find((c) => c.name === name);
  const findLead = (arr, kind) => arr.find((c) => c.kind === kind);

  let userRole = preferUser
    ? (findByName(females, preferUser) || findByName(list.filter((c) => c.gender === 'female'), preferUser))
    : null;
  if (!userRole && prefs.user_lead_lock) {
    userRole = findLead(females, 'female_lead') || findLead(list.filter((c) => c.gender === 'female'), 'female_lead');
  }
  // 填了期望身份：优先落到 brief 已对齐的女角（通常是女主）
  if (!userRole && prefs.user_brief) {
    const needle = prefs.user_brief.slice(0, 12);
    userRole = females.find((c) => String(c.brief || '').includes(needle))
      || findLead(females, 'female_lead')
      || findLead(list.filter((c) => c.gender === 'female'), 'female_lead');
  }
  if (!userRole) {
    userRole = seededPick(poolF, `${bookId}:assign:f`) || females[0] || {
      name: inventSurfaceName(`${bookId}:u`, 'female'), gender: 'female', kind: 'female_lead',
      brief: prefs.user_brief || '与主线紧密相关的女子', appear_from: 1, appear_to: n,
    };
  }
  if (prefs.user_lead_lock) {
    userRole = { ...userRole, kind: 'female_lead' };
  }

  let charRole = preferChar
    ? (findByName(males, preferChar) || findByName(list.filter((c) => c.gender === 'male'), preferChar))
    : null;
  if (charRole && charRole.name === userRole.name) charRole = null;
  if (!charRole && prefs.char_lead_lock) {
    charRole = findLead(males.filter((c) => c.name !== userRole.name), 'male_lead')
      || males.find((c) => c.kind === 'male_lead' && c.name !== userRole.name);
  }
  if (!charRole && prefs.char_brief) {
    const needle = prefs.char_brief.slice(0, 12);
    charRole = males.find((c) => c.name !== userRole.name && String(c.brief || '').includes(needle))
      || findLead(males.filter((c) => c.name !== userRole.name), 'male_lead');
  }
  if (!charRole) {
    const malePool = (poolM.length ? poolM : males).filter((c) => c.name !== userRole.name);
    charRole = seededPick(malePool, `${bookId}:assign:m`) || males.find((c) => c.name !== userRole.name) || {
      name: inventSurfaceName(`${bookId}:c`, 'male'), gender: 'male', kind: 'male_lead',
      brief: prefs.char_brief || '与主线紧密相关的男子', appear_from: 1, appear_to: n,
    };
  }
  if (prefs.char_lead_lock) {
    charRole = { ...charRole, kind: 'male_lead' };
  }

  // 创建时填写的期望身份：强制盖到 brief（点选姓名时也不丢）
  if (prefs.user_brief) userRole = { ...userRole, brief: prefs.user_brief };
  if (prefs.char_brief) charRole = { ...charRole, brief: prefs.char_brief };

  userRole.appear_from = 1;
  userRole.appear_to = n;
  charRole.appear_from = 1;
  charRole.appear_to = n;
  return { userRole, charRole };
}

function slotFromCastRole(role, gender) {
  const kind = String(role?.kind || 'key_npc');
  let trueKind = kind;
  if (gender === 'female' && trueKind === 'male_lead') trueKind = 'female_lead';
  if (gender === 'male' && trueKind === 'female_lead') trueKind = 'male_lead';
  if (trueKind === 'npc') trueKind = 'key_npc';
  const brief = concreteSurfaceBrief(role, gender);
  const secret = /lead|key_npc|helper|rival|victim/.test(trueKind) && !/culprit|villain/.test(trueKind)
    ? '与表面身份一致（剧情关键角色）'
    : `剧中定位：${trueKind}`;
  return normalizeIdentitySlot({
    surface_name: role?.name,
    surface_brief: brief,
    true_kind: trueKind === 'key_npc' ? 'helper' : trueKind,
    true_secret: secret,
    alignment: /culprit|villain/.test(trueKind) ? 'negative' : (/rival/.test(trueKind) ? 'neutral' : 'positive'),
    relations: [],
    constraints: [],
  }, { gender, fallbackName: inventSurfaceName(`fb:${gender}`, gender) });
}

/**
 * 定角后文案的「合格身份」示例：按盘面轮换，避免模型每次都抄「尚衣局女史管账册」
 */
function identityBriefExamples(book) {
  const board = series.resolveIntrigueBoard(book);
  const pools = {
    domestic: [
      '宁国侯府庶出三小姐，随嫡母住西跨院',
      '尚书府侧室之女，管着下房月例',
      '将军府未过门的表亲，眼下借住东院',
    ],
    harem: [
      '新入宫的选秀秀女，分在翊坤宫当差',
      '太后身边的司礼女官，管着节庆仪注',
      '尚仪司女史，专管寿宴座次',
    ],
    ministerial: [
      '大学士府嫡长孙，现任编修',
      '户部主事的嫡女，常随父亲走部堂门路',
      '边镇总兵的侄女，进京送犒军文书',
    ],
    mixed: [
      '外戚旁支的女儿，刚被点入宫伴读',
      '大学士府嫡长孙，现任编修',
      '宁国侯府庶出三小姐，随嫡母住西跨院',
    ],
    default: [
      '江南茶行掌柜的独女，随货船进京',
      '太医院学习的医女，跟诊抄方',
      '织造局绣娘，专管寿衣绣样',
      '县学教谕的女儿，替父亲誊文稿',
      '尚衣局女史，管冬衣账册',
    ],
  };
  const list = pools[board] || pools.default;
  const seed = Number(book?.id) || Date.now();
  const out = [];
  for (let i = 0; i < Math.min(3, list.length); i++) {
    const item = list[(seed + i * 13) % list.length];
    if (!out.includes(item)) out.push(item);
  }
  return out.join('」「');
}

/**
 * 把用户/同伴绑到剧中角色（不下发真身份标签）
 * prefer: { userCastName, charCastName } 可选
 */
async function lockIdentitiesAndMainQuest(book, cast, outlineObj, prefer = {}) {
  const settings = series.getSettings();
  series.requireSeriesApi(settings);
  const n = Number(book.total_chapters) || 20;
  const genresLabel = series.genreText(book.genres, book.genres_custom);
  const era = series.resolveEra(book.era, book.era_custom);
  const synopsis = String(outlineObj?.synopsis || outlineObj?.logline || book.book_outline || '').slice(0, 280);
  const rolePrefs = series.readRolePrefsFromBook(book);
  const { userRole, charRole } = pickStoryRolesForPlayers(cast, book.id, n, {
    ...prefer,
    rolePrefs,
  });
  const userSlot = slotFromCastRole(userRole, 'female');
  const charSlot = slotFromCastRole(charRole, 'male');
  if (rolePrefs.user_brief) userSlot.surface_brief = rolePrefs.user_brief;
  if (rolePrefs.char_brief) charSlot.surface_brief = rolePrefs.char_brief;

  const castBrief = (cast || []).slice(0, 14).map((c) => {
    const b = concreteSurfaceBrief(c, c.gender);
    return `${c.name}/${c.kind}/${c.gender}:${b}`;
  }).join('；');
  let obj = null;
  try {
    const raw = await series.chatLong(settings, `你是穿越「定角后文案」助手。角色已经抽签定死，只能润色，不能换人换 kind。只输出 JSON。`,
      `类型：${genresLabel}；背景：${era}
故事梗概：${synopsis || '（见大纲）'}
角色池：${castBrief}
【已抽签·禁止改名改 kind】
用户 → ${userSlot.surface_name}（女，true_kind=${userSlot.true_kind}，表面简介可用：${userSlot.surface_brief}）
同伴 → ${charSlot.surface_name}（男，true_kind=${charSlot.true_kind}，表面简介可用：${charSlot.surface_brief}）
只输出：
{"book_main_quest":"用户通关目标（按用户 true_kind，勿写真凶/女主标签）","char_main_quest":"同伴通关目标","meet_early":true,"user_brief":"开局可见的社会身份：归属+名分+职司/房分","char_brief":"同伴开局可见的社会身份：归属+名分+职司","user_relations":["与会登场之人的关切关系一句","…"],"char_relations":["…"],"user_secret":"一句真身份说明或与表面一致","char_secret":"一句真身份说明或与表面一致","user_opening_brief":{"knows":["开局就能回忆起的具体事实，含人名/地名/事件"],"carries":["身上携带的文书/信物/钥匙等"],"pending":["谁正等着你交代/交付什么（须具体）"],"must_hide":["须对旁人守住的表面秘密，禁止写真凶/女主标签"]}}
要求：
1. book_main_quest 必须匹配用户 true_kind（culprit 不要写成找真凶）；meet_early 按二人在故事里开局是否同场。
2. user_brief / char_brief 必须是剧情里的社会身份，写清归属与名分。合格：「${identityBriefExamples(book)}」。禁止「剧中人」「女主」「与主线紧密相关的女子」「推动主线的角色」。若上方「表面简介可用」已有具体社会身份，优先沿用。禁止把示例原文整段当成这本的身份。
3. user_relations / char_relations 至少 2 条：只写角色池里会登场的主要剧中人，与所扮角色的名分关系。格式：「人名：关系」，如「林宛：嫡姐」「沈川：未过门的姑表亲」「王嬷嬷：贴身嬷嬷」。禁止写有利害、开局碰面、同场、会登场、推动主线、剧情角色等元信息；禁止一面之缘、相识、有往来；禁止写穿真凶/女主/穿越同伴。
4. user_opening_brief：让玩家拿得到信息再被追问。knows 须含自己的社会身份怎么被旁人称呼；carries 写随身物；pending 写谁期待你做什么；must_hide 写须守住的表面秘密。宫斗/权谋/宅斗必须填实。`, {
        maxTokens: 700, continueRounds: 0, format: 'json', emptyRetries: 1, apiType: 'series_outline',
      });
    obj = series.extractJsonObject(raw);
  } catch (e) {
    console.warn('[isekai] identity polish', e.message);
  }

  if (obj?.user_brief) {
    userSlot.surface_brief = concreteSurfaceBrief({
      brief: obj.user_brief, kind: userSlot.true_kind, gender: 'female', book,
    }, 'female', book);
  }
  if (obj?.char_brief) {
    charSlot.surface_brief = concreteSurfaceBrief({
      brief: obj.char_brief, kind: charSlot.true_kind, gender: 'male', book,
    }, 'male', book);
  }
  userSlot.surface_brief = concreteSurfaceBrief({
    brief: userSlot.surface_brief, kind: userSlot.true_kind, gender: 'female', book,
  }, 'female', book);
  charSlot.surface_brief = concreteSurfaceBrief({
    brief: charSlot.surface_brief, kind: charSlot.true_kind, gender: 'male', book,
  }, 'male', book);
  // 创建偏好身份优先保留（润色不得改飞）
  if (rolePrefs.user_brief) userSlot.surface_brief = rolePrefs.user_brief;
  if (rolePrefs.char_brief) charSlot.surface_brief = rolePrefs.char_brief;
  if (obj?.user_secret) userSlot.true_secret = String(obj.user_secret).trim().slice(0, 160);
  if (obj?.char_secret) charSlot.true_secret = String(obj.char_secret).trim().slice(0, 160);
  userSlot.relations = normalizeRelationList(obj?.user_relations, cast, userSlot.surface_name, 'female');
  charSlot.relations = normalizeRelationList(obj?.char_relations, cast, charSlot.surface_name, 'male');
  userSlot.opening_brief = ensureUserOpeningBrief(
    { ...userSlot, opening_brief: normalizeOpeningBrief(obj?.user_opening_brief || obj?.opening_brief) },
    book,
    synopsis,
  );

  for (const name of [userSlot.surface_name, charSlot.surface_name]) {
    const hit = (cast || []).find((c) => c && c.name === name);
    if (hit) {
      hit.appear_from = 1;
      hit.appear_to = n;
    }
  }

  let bookMain = alignBookMainQuestToIdentity(obj?.book_main_quest, book.genres, userSlot);
  let charMain = alignBookMainQuestToIdentity(obj?.char_main_quest, book.genres, charSlot);
  if (!charMain) charMain = defaultCharMainQuest(book.genres, charSlot);

  let meetEarly = inferMeetEarlyFromRoles(userSlot, charSlot);
  if (obj && (obj.meet_early === true || obj.meet_early === 1 || obj.meet_early === 'true')) meetEarly = true;
  if (obj && (obj.meet_early === false || obj.meet_early === 0 || obj.meet_early === 'false')) meetEarly = false;

  const lock = {
    locked: true,
    meet_early: meetEarly,
    role_prefs: rolePrefs,
    user: userSlot,
    char: charSlot,
    char_main_quest: charMain,
  };

  db.prepare(`
    UPDATE series_books SET book_main_quest=?, identity_lock=?, cast_list=?, updated_at=datetime('now') WHERE id=?
  `).run(bookMain, JSON.stringify(lock), JSON.stringify(cast || []), book.id);

  return { lock, bookMain };
}

/** 生成穿越剧本：完整故事大纲 → 分章事件 → 角色池 → 再随机绑身份 */
async function generateScriptOutline(bookId) {
  const book = getBook(bookId);
  if (!db.prepare('SELECT id FROM characters WHERE id=?').get(book.character_id)) {
    throw new Error('角色不存在');
  }
  series.assertOutlineMutable(bookId);
  const n = book.total_chapters;

  const bible = await requestIsekaiStoryBible(book);
  const cast = bible.cast;
  const chapters = normalizeIsekaiChapterList(bible, n, book);
  const outlineText = series.composeBookOutlineText(bible);
  const title = String(bible.title || book.title || '').trim().slice(0, 80);

  db.prepare(`
    UPDATE series_books SET title=?, book_outline=?, chapter_outline=?, cast_list=?, status='outlined', updated_at=datetime('now')
    WHERE id=?
  `).run(
    title || book.title,
    outlineText || String(bible.synopsis || '').trim().slice(0, 800),
    JSON.stringify(chapters),
    JSON.stringify(cast),
    bookId,
  );

  const upd = db.prepare(`
    UPDATE series_chapters SET title=?, outline=?, updated_at=datetime('now')
    WHERE book_id=? AND chapter_no=? AND status!='done'
  `);
  for (const c of chapters) {
    // 目录展示用公开 summary；story_beat 留在 chapter_outline JSON 供开章任务使用
    upd.run(c.title, c.summary, bookId, c.no);
  }

  // 故事与角色池已齐；定角改到「开始穿越」时（可让用户先从池子点选）
  const fresh = getBook(bookId);
  // 引擎 canon：用 story_beat 作为完整节拍种子，避免再次塌成「推进主线」
  const chaptersForCanon = chapters.map((c) => ({
    no: c.no,
    title: c.title,
    summary: c.story_beat || c.summary,
    outline: c.story_beat || c.summary,
  }));
  await series.lockEngineCanon(fresh, {
    outlineObj: bible,
    cast: fresh.cast_list || cast,
    identityLock: fresh.identity_lock || {},
    chapters: chaptersForCanon,
    force: true,
  });

  // 若引擎写出了更好的 engine_beat，回填 chapter_outline.story_beat
  try {
    const locked = getBook(bookId);
    const canonCh = locked?.canon_lock?.chapters || [];
    if (canonCh.length) {
      const merged = chapters.map((c) => {
        const hit = canonCh.find((x) => Number(x.no) === c.no);
        const eng = String(hit?.engine_beat || '').trim();
        if (eng && !/推进主线/.test(eng)) {
          return { ...c, story_beat: eng.endsWith('。') ? eng.slice(0, 160) : `${eng.slice(0, 158)}。` };
        }
        return c;
      });
      db.prepare(`UPDATE series_books SET chapter_outline=?, updated_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(merged), bookId);
    }
  } catch (_) { /* ignore */ }

  try {
    const fresh2 = getBook(bookId);
    const tiered = annotateCastFateTiers(fresh2?.cast_list || cast, fresh2);
    db.prepare(`UPDATE series_books SET cast_list=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(tiered), bookId);
  } catch (_) { /* ignore */ }

  return publicBook(bookId);
}

/** 开始穿越：按可选偏好定角（或随机），再发身份卡与落地 */
async function beginTransmigrate(bookId, opts = {}) {
  let book = getBook(bookId);
  if (!book.book_outline && !(book.chapter_outline || []).length) {
    throw new Error('请先生成剧本大纲');
  }
  // 已开始过则直接返回（避免重复改写开局 turns / 身份展示）
  if (book.user_role && book.identity_lock?.locked && (book.status === 'writing' || book.status === 'done')) {
    return publicBook(bookId);
  }
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const settings = series.getSettings();

  const prefer = {
    userCastName: String(opts.user_cast_name || opts.userCastName || '').trim(),
    charCastName: String(opts.char_cast_name || opts.charCastName || '').trim(),
  };
  // 未锁定，或用户点选了偏好 →（重新）定角
  const needLock = !book.identity_lock?.locked || prefer.userCastName || prefer.charCastName;
  if (needLock) {
    await lockIdentitiesAndMainQuest(
      book,
      book.cast_list || [],
      { synopsis: book.book_outline },
      prefer,
    );
    book = getBook(bookId);
  }
  // 旧本无引擎完整大纲则补锁
  if (!book.canon_lock?.locked) {
    await series.lockEngineCanon(book, {
      cast: book.cast_list || [],
      identityLock: book.identity_lock,
      chapters: book.chapter_outline || [],
    });
    book = getBook(bookId);
  }
  const lock = book.identity_lock || {};
  const userSlot = normalizeIdentitySlot(lock.user, {
    gender: 'female',
    fallbackName: inventSurfaceName(`${bookId}:begin:u`, 'female'),
  });
  const charSlot = normalizeIdentitySlot(lock.char, {
    gender: 'male',
    fallbackName: inventSurfaceName(`${bookId}:begin:c`, 'male'),
  });
  ensureDistinctSurfaceNames(userSlot, charSlot, book.cast_list || [], bookId);
  userSlot.surface_brief = concreteSurfaceBrief({
    brief: userSlot.surface_brief, kind: userSlot.true_kind, gender: 'female', book,
  }, 'female', book);
  charSlot.surface_brief = concreteSurfaceBrief({
    brief: charSlot.surface_brief, kind: charSlot.true_kind, gender: 'male', book,
  }, 'male', book);
  // 创建偏好身份最终盖写，避免润色/消毒改飞
  {
    const prefs = series.readRolePrefsFromBook(book);
    if (prefs.user_brief) userSlot.surface_brief = prefs.user_brief;
    if (prefs.char_brief) charSlot.surface_brief = prefs.char_brief;
  }
  userSlot.relations = normalizeRelationList(userSlot.relations, book.cast_list || [], userSlot.surface_name, 'female');
  charSlot.relations = normalizeRelationList(charSlot.relations, book.cast_list || [], charSlot.surface_name, 'male');
  let bookMain = alignBookMainQuestToIdentity(
    book.book_main_quest || lock.book_main_quest,
    book.genres,
    userSlot,
  );
  const charMain = alignBookMainQuestToIdentity(
    lock.char_main_quest,
    book.genres,
    charSlot,
  );
  const meetEarly = !!lock.meet_early;

  userSlot.opening_brief = ensureUserOpeningBrief(userSlot, book, book.book_outline);

  const userRole = userSlot.surface_name;
  const charRole = charSlot.surface_name;
  const userKind = '';
  const charKind = '';
  const memLockInit = initMemoryLockForBegin(book, char);

  const system = `${buildIsekaiBasePrompt(book, char)}
身份已锁定，禁止重抽。只输出落地与绑定 JSON：
{"arrive_text":"穿越落地150-300字","system_bind":"系统绑定说明80-200字"}
arrive_text：第二人称「你」写用户落地与自己表面身份的体感（用户=${userRole}/${userSlot.surface_brief}）；禁止用剧中姓名当叙述主语。
${memLockInit.active
    ? `封忆本：用户已知同伴剧中身份「${charRole}」；可写对方像完全不记得穿越、只当自己就是原住民。禁止写「同伴也想起来了」。`
    : `【禁止】写出同伴的剧中姓名/身份；不要写「同伴叫××」「TA 是××」。可写「同伴也穿进来了，但你不知道 TA 落成了谁」。`}
meet_early=${meetEarly}：${meetEarly ? '开局可能同场景，但旁白仍禁止点明谁是穿越同伴' : '开局分场，用户侧场景不要硬塞同伴'}。
system_bind 必须说明：全书主线是身份通关目标、每章【${CHAPTER_SCENE_LABEL}】；这一幕落地后可收束本章；开局有身份卡；${memLockInit.active ? '封忆本用户已知同伴剧中身份；' : '认清同伴前对方写在剧情里、认出后才出同伴卡；'}真身份标签不公布；终章揭晓。`;

  const user = `剧本：《${book.title}》
全书主线（用户身份目标）：${bookMain}
梗概（故事骨架，可能是主角视角，勿当成用户任务）：${(book.book_outline || '').slice(0, 400)}`;

  let obj = {};
  try {
    const raw = await callChatAPIComplete(settings, system, user, 'series_outline');
    obj = series.extractJsonObject(raw) || {};
  } catch (e) {
    console.warn('[isekai] begin', e.message);
  }

  const arrive = String(obj.arrive_text || '').trim().slice(0, 1200)
    || (memLockInit.active
      ? `一阵天旋地转后，你摔进陌生的世界。你此刻叫「${userRole}」，是${userSlot.surface_brief}。眼前的「${charRole}」分明是你认识的那个人——可对方看你的眼神陌生得过分，仿佛从不记得你们是一起穿进来的。`
      : (meetEarly
        ? `一阵天旋地转后，你摔进陌生的世界。脑海里只清楚一件事：你此刻叫「${userRole}」，是${userSlot.surface_brief}。同伴也一起穿进来了——可你不知道 TA 落成了剧里的哪一个。`
        : `一阵天旋地转后，你独自摔进陌生的世界。耳边冷冰冰的声音响起——你意识到穿越了。你只知道自己叫「${userRole}」，身份是${userSlot.surface_brief}。同伴也穿进来了，但此刻不知在何处、落成了谁。`));
  const identityCard = formatUserIdentityCardText(userSlot, bookMain, book);
  const bindFallback = `【系统绑定成功】欢迎穿越者。
· 身份卡：已发放（见上一则）——只有你自己的姓名/身份/关系
· 全书主线：${bookMain}
· （说明）这是你抽到的身份通关目标，不等于大纲里「主角」的故事线
· ${CHAPTER_SCENE_LABEL}：每章另行发布，这一幕落地后可收束本章
· 同伴：已穿越；认清谁是同伴前，对方出入场写在剧情里；认出后才以剧中名出同伴卡；开局身份卡只发给你自己
· 真身份标签开局不公布，需在行动中自行发现；终章再揭晓
· 禁止用明确言语说出真身份（私下嘀咕「我们是穿越的」可以；当着原住民说破穿越或谈剧本结局/系统局面会受罚）
· 禁止对原住民暴露穿越者身份；违规将警告并惩罚
· 你与同伴互不知对方落成了谁；认出只能靠剧情或行为推断，开局不会自动认出`;
  const bindFallbackMem = memLockInit.active
    ? `【系统绑定成功】欢迎穿越者。
· 身份卡：已发放（见上一则）
· 全书主线：${bookMain}
· 同伴剧中身份：你已锁定/选定身份，系统封存了 TA 的穿越记忆——TA 会真当自己就是剧中人；请在剧情里用只有你们之间才有的方式逐步唤醒（当众谈穿越会被当异类）
· ${CHAPTER_SCENE_LABEL}：每章发布，这一幕落地后可收束本章
· 真身份标签终章揭晓；违规破壁将受罚`
    : bindFallback;
  const bind = String(obj.system_bind || '').trim().slice(0, 700) || (memLockInit.active ? bindFallbackMem : bindFallback);

  db.prepare(`
    UPDATE series_books SET
      user_role=?, char_role=?, user_role_kind=?, char_role_kind=?,
      book_main_quest=?, identity_lock=?,
      status='writing', updated_at=datetime('now')
    WHERE id=?
  `).run(
    userRole,
    charRole,
    userKind,
    charKind,
    bookMain,
    JSON.stringify({
      ...lock,
      locked: true,
      meet_early: meetEarly,
      role_prefs: series.readRolePrefsFromBook(book),
      user: userSlot,
      char: charSlot,
      char_main_quest: charMain || lock.char_main_quest,
      memory_lock: memLockInit.active ? memLockInit : (lock.memory_lock || emptyMemoryLock()),
    }),
    bookId,
  );

  try {
    db.prepare('DELETE FROM series_turns WHERE book_id=? AND chapter_no=0').run(bookId);
  } catch (_) {}
  addTurn(bookId, 0, 'narration', arrive, {
    type: 'arrive',
    user_role: userRole,
  });
  addTurn(bookId, 0, 'system', identityCard, {
    type: 'identity_card',
    user_role: userRole,
    relations: userSlot.relations || [],
  });
  addTurn(bookId, 0, 'system', bind.startsWith('【') ? bind : `【系统】${bind}`, {
    type: 'binding',
    user_role: userRole,
    book_main_quest: bookMain,
  });

  // 模型侧剧本世界书：名分锁 / 人物别名 / 关系卡（用户只看身份卡）
  try {
    const freshBook = getBook(bookId);
    const lore = loreHelper.buildLoreFromIdentity(freshBook, {
      userSlot,
      charSlot,
      cast: freshBook?.cast_list || book.cast_list || [],
    });
    loreHelper.saveLore(bookId, lore);
  } catch (e) {
    console.warn('[isekai] lore build', e.message);
  }

  return publicBook(bookId);
}

function assignedOrThrow(book) {
  if (!book.user_role || !book.char_role) throw new Error('请先开始穿越以分配身份');
}

function playContext(book, char, quest = null, { chapterNo = 0, contextText = '' } = {}) {
  const core = char ? series.charCoreForSeries(char) : { name: book.char_role || '他' };
  const questEtq = loreHelper.applySceneEtiquetteToQuest(book, quest || {}, contextText);
  const together = questEtq ? !!questEtq.together : false;
  const lock = book.identity_lock || {};
  const u = lock.user || {};
  const c = lock.char || {};
  const mem = isekaiMemoryBlock(book.id);
  const charMain = String(lock.char_main_quest || '').trim();
  const companionName = book.char_role || c.surface_name || '';
  const recog = parseCrossingRecognition(book.id, {
    companionName,
    userRole: book.user_role || u.surface_name || '',
    book,
  });
  const mutual = !!(recog.mutual || (recog.userKnowsCompanion && recog.companionKnowsUser));
  const companionKnowsOnly = companionRecognizedUser(recog) && !userRecognizedCompanion(recog);
  const userKnowsOnly = userRecognizedCompanion(recog) && !companionRecognizedUser(recog);
  const memLock = readMemoryLock(lock);
  const companionToUser = memLock.active
    ? (companionCrossingMemoryRestored(memLock)
      ? (companionMemoryDisclosedToUser(memLock)
        ? `【同伴对用户·记尘已恢复且已表露】私下可按穿越同伴相处；当着原住民仍演戏。禁止替用户把局面做成，禁止当众破壁。`
        : `【同伴对用户·记尘已满但未表露】引擎知同伴已想起穿越，外表仍演剧中人，可按性格逗用户/装不知道；禁止旁白替玩家点破。禁止当众破壁。`)
      : `【同伴对用户·封忆中】同伴真当自己就是原住民，不记得穿越；用户已知其剧中身份。禁止谈穿越唤醒；羁绊共振只写可观察愣神/闪回。按性格可吃醋、提醒身份等，禁止统一模板。禁止替用户把局面做成。`)
    : mutual
    ? `【同伴对用户·已互认】双方已确认彼此是穿越同伴：不要遗忘互认又倒退成「初次试探」。私下可按同伴相处（配合/损/商量）；当着原住民仍演戏。剧情必要盘问可走。描写客观：知情态度落在言行上，禁止编造未发生的心有灵犀。禁止替用户把情节目标做成，禁止当众破壁。`
    : userKnowsOnly
      ? `【同伴对用户·用户已认出，同伴未必已知】用户已知对方是穿越同伴，但未互认摊牌：不要写成双方已心知肚明；同伴仍可半信半疑。可用同伴卡。描写客观，禁止倒退成陌生人认人戏。禁止替用户把情节目标做成，禁止当众破壁。`
      : companionKnowsOnly
        ? `【同伴对用户·同伴单方面知情】同伴已确认用户是穿越同伴，用户尚未认出：跨章须延续知情（心里知道即可）。外在只写可观察言行，禁止引导用户认出、禁止彩蛋式暗示、禁止旁白点破。描写客观不偏袒：做了写做了，没做不要添油加醋。用户未认出前同伴戏份并入剧情旁白，禁止单独同伴卡泄题。禁止替用户把情节目标做成，禁止当众破壁。`
        : `【同伴对用户任务】看不到任务原文。未凭行为推断出对方是穿越同伴前：只按剧中人关系与性格反应，不要默认认亲、不要按「帮穿越同伴过关」来演。用户有明显反常举动后，聪明者才可开始怀疑并按性格暗助/损/拦/投机——仍须客观写。禁止当局外人，禁止替用户把情节目标直接做成，禁止当着原住民破壁（说破穿越/真身份、谈剧本结局/系统任务、破表面约束）。用户未认出前禁止单独同伴卡泄题，同伴出入场写进剧情旁白。`;
  const loreBlock = loreHelper.formatLorePromptBlock(book, {
    contextText: contextText || `${questEtq?.chapter || ''}\n${companionName}`,
    chapterNo: chapterNo || 0,
    compact: true,
  });
  const sceneBlock = loreHelper.sceneEtiquettePromptBlock(book, questEtq);
  return `【表面身份·玩家可见】
用户：${book.user_role || u.surface_name || '？'}（${u.surface_brief || book.user_surface_brief || '剧中人'}，女）约束：${(u.constraints || []).join('/') || '无'}
${formatOpeningBriefForPrompt(u.opening_brief || buildFallbackOpeningBrief(u, book))}
同伴：${companionName || '？'}（${c.surface_brief || book.char_surface_brief || '剧中人'}，男）约束：${(c.constraints || []).join('/') || '无'}
同伴演技气质名：${core.name}（用真性格演表面身份，勿开挂赋魅）
【演技分层】当着原住民须演好剧中人设（冷酷就冷）；真性格只作底色（玩世不恭演冷酷＝冷里带刺，不是当场破功变回嘻皮）。私下或已互认且无旁人时，可更露真性子。
${companionToneLeakRules({ afterUserRecognized: userCanUseCompanionCard(book, recog) })}
【亲密戏旁观】配角同伴可不识任务仍有反应：可生气、可本该离场却留下、可在过界时搅局或事后发作——跟性格；失控说破穿越/拒演则系统惩罚，用户可见。
【无光环】用户与同伴同等承受剧情后果：可受伤/感染/变异（如丧尸咬伤），禁止穿越者光环或同伴光环。
【表面约束·双方同等】有约束则必须演出来（如 blind=须装作看不见）。违者可判系统惩罚。
【真身份·锁定·禁止改写·禁止对玩家直说（终章除外）】
用户：${u.true_kind || book.user_role_kind || 'npc'}｜${u.true_secret || '（锁）'}
同伴：${c.true_kind || book.char_role_kind || 'npc'}｜${c.true_secret || '（锁）'}
【全书主线·用户身份通关】${questEtq?.book_main || book.book_main_quest || '完成剧本命运线'}
【同伴身份通关·仅引擎】${charMain || '按同伴真身份推进，勿抢用户主线'}
【区分】公开大纲可能是主角视角；用户/同伴各自完成自己的身份目标，不要都改成「找出真凶」。
【${CHAPTER_SCENE_LABEL}·锁定节拍玩家版·仅引擎可见】${questEtq?.chapter || questEtq?.main || '（见章节）'}（过章只看这一幕是否落地；认人/记尘 ≠ 过章；旁白禁止替用户做成）
${questEtq?.beat_carry?.length ? formatBeatCarryPrompt(questEtq.beat_carry) : ''}
${questEtq?.threads?.length ? `【进行中的线】${questEtq.threads.join('；')}` : ''}
现场阻力（引擎参考，不对用户展示）：${questEtq?.resistance || '可有符合场面的阻力，不要拿来改写局面目标'}
同伴隐藏节拍（同伴自己的身份线）：${questEtq?.char_beat || '配合大纲，按自己身份线推进，不说破真身份'}
${companionToUser}
本章是否同场：${together ? (mutual ? '是——同场；已互认：私下可当同伴相处，当众仍演戏' : userKnowsOnly ? '是——同场；用户已认出同伴，尚未互认摊牌' : companionKnowsOnly ? '是——同场；同伴已单方面知情：禁止引导用户认出、描写须客观' : '是——按身份本该同场，可写互动；同场≠已认出') : '否——因身份/场景礼仪分场，各自演各的；敏感场合禁止硬凑重逢，也不要隔空发手机消息'}
已持道具：${questEtq ? inventoryText(questEtq) : '（无）'}
真身份标签：只有「明说出口」才违规。嘀咕「我们是穿越的」可以（须私下）。终章可正式公布。
${formatRecognitionForQuest(recog, companionName)}
${mutualRecognitionRules({
    hasIdentityMemory: mutual || recog.userKnowsCompanion || recog.companionKnowsUser || !!recog.lines.length,
    recog,
  })}
【篇幅】全书 ${Number(book.total_chapters) || 20} 章内须讲完完整故事；单章推主节拍，副线/人物戏自然穿插。
${formatMemoryLockPromptBlock(book, char, memLock)}
${formatPlotForksBlock(book)}
${sceneBlock}
${loreBlock}
${mem}
`;
}

function interactiveObserveHint(questText = '', sides = []) {
  const blob = [questText, ...(Array.isArray(sides) ? sides.map((s) => s.text || s) : [])].join('；');
  if (!/(调查|搜查|搜证|翻|查|打开|盒子|匣|箱|抽屉|信|信封|日记|账本|暗格|锁|门|痕迹|线索|观察|窃听|尾随|盯|探|摸|闻|听)/.test(blob)) {
    return '';
  }
  return `【可观察信息】本章任务涉及调查探索。对象出场时必须写清可感知细节（材质、封口、痕迹、气味、份量、铭文、缝隙里隐约所见、旁人闲话等），让用户有依据动手；禁止只点名「有个盒子」就停。仍禁止替用户打开/读完/下结论。`;
}

function looksSelfHarmOrInjuryAction(text) {
  const t = String(text || '');
  return /(自残|自伤|弄伤自己|割伤自己|刺伤自己|咬破|咬舌|割腕|吞药|服毒|跳楼|撞墙|毁容|废掉自己|伤自己|自己.{0,6}伤|以身试|自杀)/.test(t);
}

function looksDangerousStakes(text) {
  const t = String(text || '');
  return looksSelfHarmOrInjuryAction(t)
    || /(流血|伤口|刀|剑|枪|杀|咬|丧尸|鬼|围攻|中毒|坠落|溺|刺|砍|打伤|致命|性命|危险)/.test(t);
}

function recentCrimeProcedureStreak(bookId, chapterNo, book, lookback = 2) {
  if (!series.resolveIntrigueBoard(book)) return 0;
  let streak = 0;
  for (let i = Number(chapterNo) - 1; i >= Math.max(1, Number(chapterNo) - lookback); i--) {
    let ch = null;
    try { ch = series.getChapter(bookId, i); } catch (_) { break; }
    if (!ch) break;
    const pq = readQuestState(ch, book);
    const blob = `${pq.chapter || ''}\n${resolveChapterStoryBeat(book, i, ch)}`;
    if (series.isCrimeProcedureHook(blob)) streak += 1;
    else break;
  }
  return streak;
}

function domesticPalaceQuestFallback(chapterNo, storyBeat, book = null) {
  const beat = String(storyBeat || '').trim();
  if (beat && !series.isCrimeProcedureHook(beat)) {
    return beat.replace(/[。．.]+$/, '');
  }
  const board = book ? series.resolveIntrigueBoard(book) : 'domestic';
  if (Number(chapterNo) === 1) {
    if (board === 'harem') return '稳住入宫第一印象，让位份与规矩的这场戏真正发生';
    if (board === 'ministerial') return '在公开场合完成第一次站队，让权柄之争真正开场';
    return '稳住入府第一印象，让主母立规矩的这场戏真正发生';
  }
  if (board === 'harem') return '在后宫公开场合化解风波，保住位份与体面';
  if (board === 'ministerial') return '在朝堂或世家公开场合换到新的站队筹码';
  return '在内宅公开场合化解风波，保住名节与亲事筹码';
}

function isDomesticCrimeDriftQuest(questText, storyBeat, book) {
  if (!series.resolveIntrigueBoard(book)) return false;
  const t = String(questText || '').trim();
  if (!series.isCrimeProcedureHook(t)) return false;
  const beat = String(storyBeat || '').trim();
  return !beat || series.isCrimeProcedureHook(beat);
}

/** 原住民阻力 + 同伴按性格介入（非统一模板） */
function worldPressureRules({ quest = null, userAction = '', recog = null, book = null } = {}) {
  const q = String(quest?.chapter || quest?.main || '').trim();
  const resist = String(quest?.resistance || '').trim();
  const act = String(userAction || '').trim();
  const blob = `${q}\n${act}`;
  const mutual = !!(recog && (recog.mutual || (recog.userKnowsCompanion && recog.companionKnowsUser)));
  const parts = [
    mutual
      ? '【同伴介入·已互认】双方已确认彼此是穿越同伴：勿遗忘互认又当成初次试探。剧情必要的盘问/对质可走；知情后按性格配合/损/拦。当着原住民仍演戏。禁止当局外人，禁止替用户把情节目标做成，禁止当众破壁。'
      : '【同伴介入·按这个人】同伴看不到用户【本章局面】原文。未认出对方是穿越同伴前，只按剧中人关系与性格反应。用户有明显反常举动后，聪明者才可怀疑并按性格暗助/损/拦/投机。禁止统一模板，禁止当局外人，禁止替用户把局面直接做成，禁止当着原住民说破穿越/谈剧本结局/破表面约束。写法须客观，禁止「无比熟悉/过于温柔/意味深长」等重暗示旁白。',
  ];
  if (resist) {
    parts.push(`【原住民阻力·参考】${resist}。用户写下行动只是尝试；可有阻力，但过章看情节目标是否落地，不要因做法不标准否决。${mutual ? '勿把「遗忘互认后的穿越身份试探」当成阻力主轴。' : '同伴不是阻力模板，按性格介入。'}`);
  } else {
    parts.push(`【原住民阻力·参考】场面可有盘问、看守、时间压力等，但过章看情节目标是否落地。${mutual ? '剧情必要的盘问可以；不要写成同伴突然又怀疑你是不是穿越者。' : '同伴按性格介入，不是局外人。'}`);
  }
  const diff = Number(quest?.effects?.difficulty_boost) || 0;
  if (diff > 0) {
    const lvHint = diff === 1
      ? '盘问更严、借口更易穿帮；敌对阵营压迫略升'
      : diff === 2
        ? '谎言难圆、看守更凶；妖怪/僵尸/敌军等武力与压迫明显增强'
        : '高度戒备；敌对战力与压迫大幅提升，禁止仍按轻松难度放水';
    parts.push(`【世界难度·Lv.${diff}】${lvHint}。落实到场面：更难糊弄剧中人；敌对侧战力/人数/手段按等级加码。`);
  }
  if (looksSelfHarmOrInjuryAction(blob)) {
    parts.push('【自伤/赴险】同伴按性格介入，不是统一喝止：可能拦下笨办法、改用更巧的法子帮过关，可能边损边挡，可能先确认是不是系统任务再配合。禁止冷眼旁观；禁止替用户把刀自己捅下去；禁止对原住民把「这是系统任务」说破。');
  } else if (looksDangerousStakes(blob)) {
    parts.push('【危险】会痛、会流血仍按现实结算。不强制收起玩味：这个人平时怎么说话，危险时也可以还是那种人（边损边拉、边笑边挡都合理），但行为必须是他会做的，不会真当没事。');
  }
  const board = book ? series.resolveIntrigueBoard(book) : '';
  if (board) {
    const blob2 = `${q}\n${resist}`;
    const field = board === 'harem' ? '后宫位份/恩宠/名节' : board === 'ministerial' ? '朝堂站队/弹劾/权柄' : '内宅人情/管家权/名节';
    if (series.isCrimeProcedureHook(blob2)) {
      parts.push(`【权谋防跑偏】本场压迫须落在${field}，禁止写成诏狱缉拿连环审讯；若上章已在盘问交物，本章须转场到新的人情权谋冲突，不得连章升级坐牢。`);
    } else {
      parts.push(`【人情权谋】冲突优先${field}；衙门官兵仅背景，不当主线发动机。查案最多作插曲。`);
    }
  }
  return parts.join('\n');
}

/** 用户在问「本章局面落定了吗 / 能过章吗」等元问题（非剧情行动） */
function isQuestStatusAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 100) return false;
  return /(本章)?(任务|局面).{0,12}(完成|做完|落定|好了|通关|过章|结束)/.test(t)
    || /(是不是|有没有|是否).{0,8}(完成|做完|落定|过章)/.test(t)
    || /(完成了吗|完成了没|做完了吗|落定了吗|过章了吗|可以过章|能过章|进入下一章|去下一章)/.test(t);
}

/** 用户主动呼叫系统面板（剧内机制，非剧情行动） */
function isSystemSummon(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 120) return false;
  if (isQuestStatusAsk(t)) return true;
  return /^(系统|打开系统|叫系统|召唤系统|系统面板|查看系统|调出系统|呼叫系统|系统[,，]?在吗)/.test(t)
    || /(查看|调出|打开|叫|召唤).{0,8}(系统|面板|任务|本章局面)/.test(t)
    || /(本章|当前).{0,8}(局面|任务).{0,8}(是什么|怎样|怎么样|完成了吗|做完了吗)/.test(t);
}

function chapterEngagementFloor(book) {
  const n = Number(book?.total_chapters) || 20;
  const len = book?.length_type
    || (n <= 4 ? 'flash' : n <= 8 ? 'short' : n <= 24 ? 'medium' : 'long');
  if (len === 'flash') return { minUser: 1, minStory: 1 };
  if (len === 'short') return { minUser: 2, minStory: 2 };
  if (len === 'long') return { minUser: 4, minStory: 4 };
  return { minUser: 3, minStory: 3 };
}

function playTurnCounts(turns) {
  const userTurns = (turns || []).filter((t) => t.kind === 'user' || t.kind === 'whisper_user').length;
  const storyTurns = (turns || []).filter((t) => t.kind === 'narration' || t.kind === 'char').length;
  return { userTurns, storyTurns };
}

function meetsChapterEngagement(book, turns) {
  const { minUser, minStory } = chapterEngagementFloor(book);
  const { userTurns, storyTurns } = playTurnCounts(turns);
  return userTurns >= minUser && storyTurns >= minStory;
}

function beatConflictFingerprint(beat) {
  const t = String(beat || '');
  if (/审讯|审问|逼供|盘问|交代|说出秘密|交出来|赃物|追缴|对质交/.test(t)) return 'interrogate';
  if (/抄家|入狱|坐牢|诏狱|顺天府|官兵|缉拿|下狱/.test(t)) return 'crime_proc';
  if (/认人|互认|摊牌|认出同伴|穿越同伴/.test(t)) return 'recognition';
  return 'other';
}

function dedupeAdjacentBeats(beats, book) {
  const out = (beats || []).slice();
  for (let i = 1; i < out.length; i++) {
    const prevFp = beatConflictFingerprint(out[i - 1]);
    const curFp = beatConflictFingerprint(out[i]);
    if (prevFp !== 'other' && prevFp === curFp) {
      out[i] = series.sanitizeBeatForPalaceDomestic(
        `内宅新变局：各房借机争势，须换一场面推进（禁止连章同一类${prevFp === 'interrogate' ? '审讯逼供' : '官府压迫'}）。`,
        book,
      );
    }
  }
  return out;
}

function mediumPacingBlock(n) {
  const total = Number(n) || 20;
  if (total < 12) return '';
  return `【中篇节奏·硬性】全书 ${total} 章，每章一个递进事件拍，不是同一冲突换场景重演。
· 相邻两章禁止重复同类冲突（连章审讯/连章逼交秘密/连章对质/连章认人）。
· 一章只收一个主拍；前 ${Math.max(2, Math.ceil(total * 0.2))} 章立局，中段每章须推进新因果，末 ${Math.max(2, Math.ceil(total * 0.25))} 章收束。
· beats 每条须写「承接上章→本章新事件」，禁止章章围绕同一秘密盘问。`;
}

function chapterBeatsVsArcRules() {
  return `【阶段 vs 分章·硬性】arcs 只是阶段总方向（开局/发展/收束各自一句），不是拿来当多章共用的剧情。
· 每一章 beats 必须是独立、可演的一场戏：换场面、换利害、换对手动作，出现人名与具体事件。
· 禁止把阶段 beat 原句或同义句复制到该阶段每一章。
· 阶段负责「这段往哪推」，分章负责「这一章发生了哪一幕」；丰富的分章事件合力推动阶段总纲，而不是几章围着同一句大纲空转。`;
}

function isStageFunctionBeat(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /立人设|立冲突|确立冲突|推进升级|高潮收束|阶段功能|冲突展开|中段推进|逼近高潮|卷入核心事件|局面不可逆|人物命运与真相一并了结/.test(t)
    || /推进主线|推动剧情/.test(t);
}

/** 空泛本章任务：推进主线/结构术语/去汇合 等（情节目标如「解开误会」不算空泛） */
function isAbstractChapterQuest(text, companionName = '') {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.length < 6) return true;
  // 纯万能空话
  if (/^(推进|推动)(本章)?(主线|剧情|大纲|节拍|故事)/.test(t) && t.length < 24) return true;
  if (/完成本章|按大纲|合理发挥|继续剧情|开展剧情|推动剧情|执行任务|推进主线/.test(t)
    && !/(解开|化解|促成|达成|让|使|见|遇|救|杀|取|交|查清|撑过|逃离|活着|和解|误会|对质|摊牌|重逢|决裂|守住|拿到|救出)/.test(t)
    && t.length < 40) return true;
  if (/以你的身份推动本章节拍/.test(t)) return true;
  if (/局面要落到实处|促成并亲历|须完成其中关键一步/.test(t)) return true;
  // 大纲结构术语：没法当可玩任务
  if (/(破冰|立人设|立冲突|确立冲突|冲突确立|关系确立|张力|起承转合|铺垫|埋线|埋下伏笔|升级冲突|高潮收束|收束全书|章节功能|故事功能|推进关系|确立关系|情感推进|戏剧冲突确立)/.test(t)
    && !/(解开|误会|对质|摊牌|救出|逃离|拿到|查清|和解|决裂|重逢|杀死|守住|当面)/.test(t)) {
    return true;
  }
  if (/^(开局|发展|收束|转折|高潮)([与和·、]|$)/.test(t) && t.length < 30) return true;
  // 「去和 XX 汇合」单独当任务 = 同伴被当成可有可无挂件
  if (/(汇合|会合|碰面|碰头|见面|找到同伴|去找同伴)/.test(t)) {
    const onlyMeet = t.length < 42 || !/(并|然后|再|之后|同时|顺便|借机|趁|解开|误会|对质|摊牌)/.test(t);
    if (onlyMeet) return true;
    const name = String(companionName || '').trim();
    if (name && t.includes(name) && t.length < 40 && !/(解开|误会|对质|摊牌|决裂|和解)/.test(t)) return true;
  }
  return false;
}

/** 读取本章故事节拍：优先引擎完整节拍 / chapter_outline.story_beat */
function resolveChapterStoryBeat(book, chapterNo, ch) {
  const parsed = parseChapterBeat(resolveChapterStoryBeatRaw(book, chapterNo, ch));
  return parsed.main;
}

function resolveChapterStoryBeatRaw(book, chapterNo, ch) {
  const no = Number(chapterNo) || 1;
  const canonCh = (book?.canon_lock?.chapters || []).find((c) => Number(c.no) === no);
  const outlineItem = (book?.chapter_outline || []).find((c) => Number(c.no) === no);
  const eng = String(canonCh?.engine_beat || '').trim();
  const story = String(outlineItem?.story_beat || '').trim();
  const pub = String(ch?.outline || outlineItem?.summary || canonCh?.public_beat || '').trim();
  const pick = [eng, story, pub].find((s) => s && !/推进主线/.test(s));
  const raw = String(pick || pub || beatPlaceholder(no, Number(book?.total_chapters) || 20, book)).trim();
  return series.sanitizeBeatForPalaceDomestic(raw, book);
}

/** 解析节拍：主拍｜副线：…；登场：… */
function parseChapterBeat(raw) {
  const s = String(raw || '').trim();
  if (!s) return { main: '', carry: [], intro: [], foreshadow: [] };
  let main = s;
  let carry = [];
  let intro = [];
  let foreshadow = [];
  const carrySplit = main.split(/｜副线[:：]/);
  if (carrySplit.length > 1) {
    main = carrySplit[0].trim();
    carry = carrySplit[1].split(/[；;]/).map((x) => x.trim()).filter(Boolean);
  }
  const introSplit = main.split(/｜登场[:：]/);
  if (introSplit.length > 1) {
    main = introSplit[0].trim();
    intro = introSplit[1].split(/[、,，；;]/).map((x) => x.trim()).filter(Boolean);
  }
  const foreSplit = main.split(/｜伏笔[:：]/);
  if (foreSplit.length > 1) {
    main = foreSplit[0].trim();
    foreshadow = foreSplit[1].split(/[；;]/).map((x) => x.trim()).filter(Boolean);
  }
  main = main.replace(/^第?\d+章[:：\s]*/, '').trim();
  if (main && !/[。．.!?！？]$/.test(main)) main = `${main}。`;
  return { main, carry, intro, foreshadow };
}

function resolveChapterBeatCarry(book, chapterNo, ch) {
  const no = Number(chapterNo) || 1;
  const outlineItem = (book?.chapter_outline || []).find((c) => Number(c.no) === no);
  if (Array.isArray(outlineItem?.beat_carry) && outlineItem.beat_carry.length) {
    return outlineItem.beat_carry.map((x) => String(x || '').trim()).filter(Boolean);
  }
  return parseChapterBeat(resolveChapterStoryBeatRaw(book, chapterNo, ch)).carry;
}

function formatBeatCarryPrompt(carry) {
  const list = (carry || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return '';
  return `【本章副线质感·推进主节拍时自然带出至少一项，勿抢主拍】${list.join('；')}`;
}

function mergeThreads(prev = [], added = []) {
  const out = [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(added) ? added : [])]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  return [...new Set(out)].slice(-12);
}

/** 从本章故事节拍提炼情节目标任务（兜底） */
function concreteChapterQuestFromOutline(outline, chapterNo, roleName, surfaceBrief) {
  let beat = String(outline || '').trim()
    .replace(/^第?\d+章[:：\s]*/, '')
    .replace(/^(推进|推动)(本章)?(主线|剧情|大纲|节拍)[:：\s]*/g, '')
    .replace(/局面要落到实处/g, '')
    .replace(/去?(与|和|跟).{1,12}(汇合|会合|碰面|碰头)/g, '')
    .trim();
  // 结构术语节拍不可直接当任务
  if (isAbstractChapterQuest(beat)) beat = '';
  if (!beat) {
    return Number(chapterNo) === 1
      ? '卷入开局核心事件，让本章关键局面发生'
      : '让本章故事节拍中的关键局面落地';
  }
  const clean = beat.replace(/^(承接|然后|接着|随后)[:：\s]*/g, '').trim();
  return clean.slice(0, 200);
}

/** 去掉写给模型看的元话语，只留玩家能看懂的任务句 */
function sanitizeChapterQuestText(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t
    .replace(/促成并亲历[:：]?\s*/g, '')
    .replace(/——?\s*你作为「[^」]*」须完成其中关键一步/g, '')
    .replace(/你作为「[^」]*」须完成其中关键一步/g, '')
    .replace(/[，,]?\s*局面要落到实处/g, '')
    .replace(/[，,]?\s*须有明确对象与结果/g, '')
    .replace(/[（(]必须完成[）)]/g, '')
    // 保留数字分项换行；仅压同一行内多余空格
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 规范化「1.」「2.」分项：行首编号统一成「N. 」；同行内的「1.xx 2.yy」拆成多行
  if (/(?:^|\n)\s*\d{1,2}[.、．]/.test(t) || /\d{1,2}[.、．]\s*\S.+\s+\d{1,2}[.、．]/.test(t)) {
    t = t
      .replace(/\s+(\d{1,2})[.、．]\s*/g, '\n$1. ')
      .replace(/(?:^|\n)\s*(\d{1,2})[.、．]\s*/g, '\n$1. ')
      .replace(/^\n+/, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  // 去掉尾部被截断的残缺标点/半词（保留分项中间内容）
  t = t.replace(/[—–\-~…·.。，、；：:]+$/g, '').trim();
  return t.slice(0, 500);
}

/** 上一章末几条实玩回合（开场衔接用，不用公开大纲冒充） */
function lastPlaySceneText(bookId, chapterNo, limit = 4) {
  const turns = listTurns(bookId, chapterNo)
    .filter((t) => ['narration', 'user', 'char'].includes(t.kind));
  if (!turns.length) return '';
  const slice = turns.slice(-Math.max(1, Number(limit) || 4));
  return slice.map((t) => {
    const label = t.kind === 'user' ? '用户(扮)' : (t.kind === 'char' ? '同伴(扮)' : '剧情');
    const body = String(t.content || '').trim();
    return `【${label}】${body.slice(0, 600)}`;
  }).join('\n\n').slice(0, 2200);
}

/** 上章末是否停在认人/同伴摊牌戏（应用一两拍带过，不能当下一章主线） */
function lastSceneLooksRecognition(text) {
  const t = String(text || '');
  if (!/(穿越|同伴|一起穿|同穿|穿进来|不是这个世界|剧本)/.test(t)) return false;
  return /(认出|互认|摊牌|原来是你|你也是|同为穿越|确认对方|彼此承认)/.test(t);
}

/** 任务把「认出同伴」写成了本章主目标，但锁定节拍并不是认人 */
function isRecognitionAsMainQuest(text, beat = '') {
  const t = String(text || '').trim();
  const b = String(beat || '');
  if (!t) return false;
  if (!/(认出|互认|确认.{0,8}(同伴|穿越)|穿越同伴|是不是同伴|是否同伴|和同伴摊牌)/.test(t)) return false;
  if (/(认出|互认|摊牌|确认同伴|穿越同伴)/.test(b)) return false;
  return true;
}

/** 开场两段：一两拍带过上章余波 → 进入本章锁定节拍 */
function formatOpeningBridgeRules(h, thisBeat) {
  if (!h) return '';
  const recogTail = lastSceneLooksRecognition(`${h.lastScene || ''}\n${h.leftover || ''}\n${h.plot || ''}`);
  const leftover = String(h.leftover || '').trim();
  const where = String(h.where || '').trim();
  const who = String(h.who || '').trim();
  const sceneAnchor = (where || who || h.lastScene)
    ? `上章收束锚点：${where ? `地点「${where}」` : '地点接上章末'}${who ? `；在场「${who}」` : ''}。衔接段必须从这个现场接着写，禁止无因果硬切场景。`
    : '';
  return `【开场结构·两段·硬性】
${sceneAnchor}
1. 衔接段（最多一两拍，可短）：从上章收束现场的人物/地点/时间接着写。
${recogTail
    ? '上章末停在认人/同伴戏：用一两拍把认人余波带过（同一批人，写清怎么从认人现场走到本章入口）。禁止把整章写成继续认人。'
    : (leftover
      ? `上章未完局面：${leftover}。若这一拍在场面上还没收干净，用一两拍带过，不要另开一集。`
      : '若上章用户正在做某件事（端茶、跪地、被按住等），先让这一拍有头有尾地收住或自然被打断，再转场；禁止无视上章末动作直接换场。')}
· 若本章锁定节拍地点与上章末不同，衔接段必须写清「谁让去的、为何换场」，禁止硬切到书房/牢房/新地点。
2. 本章段：必须进入【本章锁定节拍】的局面入口——「${thisBeat || '本章节拍'}」。开场结束时，人必须已经站在这一拍的门口（可以还没做成，但必须是这一拍，不是上章加戏）。
禁止：用衔接段替换本章节拍；把本章写成上章认人续集；时间跳跃到无关新事件；遗忘已发生事实/道具。
认人只影响同伴怎么演戏，不改变本章该演哪一拍，也不等于过章。`;
}

/** 过章衔接包：实玩收束优先，公开大纲不能当衔接 */
function collectPrevChapterHandoff(bookId, chapterNo, book) {
  if (Number(chapterNo) <= 1) return null;
  const prevNo = Number(chapterNo) - 1;
  let prev = null;
  try { prev = series.getChapter(bookId, prevNo); } catch (_) { prev = null; }
  if (!prev) return null;
  const pq = readQuestState(prev, book);
  const recap = pq.recap && typeof pq.recap === 'object' ? pq.recap : {};
  const lastScene = lastPlaySceneText(bookId, prevNo, 4);
  const prevBeat = resolveChapterStoryBeat(book, prevNo, prev);
  const plot = String(recap.plot || '').trim();
  const leftover = String(recap.leftover || '').trim();
  const where = String(recap.where || '').trim();
  const who = String(recap.who || '').trim();
  const charMem = String(recap.char_mem || '').trim();
  const inventory = Array.isArray(recap.inventory) && recap.inventory.length
    ? recap.inventory
    : (Array.isArray(pq.inventory) ? pq.inventory : []);
  const plotForUser = plot
    || leftover
    || (lastScene ? '上章收束于现场未完局面，本章须从该场面接着发生。' : '')
    || '承接上一章已发生的事实，从收束场面继续推进。';
  const recapRaw = pq.recap && typeof pq.recap === 'object' ? pq.recap : {};
  return {
    prevNo,
    plot: plotForUser,
    leftover,
    where,
    who,
    charMem,
    threads: Array.isArray(recapRaw.threads) ? recapRaw.threads.slice(0, 12) : [],
    foreshadow: Array.isArray(recapRaw.foreshadow) ? recapRaw.foreshadow.slice(0, 8) : [],
    relationship: String(recapRaw.relationship || '').trim(),
    inventory,
    lastScene,
    prevBeat,
    plot_forks: readPlotForks(book).slice(-6),
    together: !!pq.together,
    companionAppeared: !!pq.companion_appeared,
    effects: normalizePenaltyEffects(pq.effects),
  };
}

function formatHandoffForUser(h) {
  if (!h) return '';
  const invLine = (h.inventory || []).map((it) => it.name || it).filter(Boolean).join('、') || '（无）';
  const extra = [
    h.where ? `地点：${h.where}` : '',
    h.who ? `在场：${h.who}` : '',
    h.leftover ? `未完局面：${h.leftover}` : '',
    (h.threads || []).length ? `进行中的线：${h.threads.join('；')}` : '',
  ].filter(Boolean).join('\n');
  return `【前景回顾·第${h.prevNo}章】
剧情：${h.plot}${extra ? `\n${extra}` : ''}
随身道具：${invLine}`;
}

function formatHandoffForModel(h, thisBeat) {
  if (!h) return '';
  return `${formatHandoffForUser(h)}
上章故事节拍（已发生，只需带过，不要续写成新主线）：${h.prevBeat || '（无）'}
上章收束现场（衔接段必须从此接着写）：
${h.lastScene || '（无完整现场，以剧情总结为准）'}
角色侧记忆（仅模型，勿对玩家直说）：${h.charMem || '无额外隐藏记忆'}
${(h.threads || []).length ? `进行中的线（可自然提及）：${h.threads.join('；')}\n` : ''}${(h.foreshadow || []).length ? `伏笔/悬念：${h.foreshadow.join('；')}\n` : ''}${h.relationship ? `关系变化：${h.relationship}\n` : ''}${(h.plot_forks || []).length ? `${formatPlotForksBlock({ identity_lock: { plot_forks: h.plot_forks } })}\n` : ''}本章锁定节拍（开场必须把人送到这一拍的入口，不可改写）：${thisBeat || ''}
${formatOpeningBridgeRules(h, thisBeat)}`;
}

/** 开启一章：任务短 JSON + 正文开场（旁白或同伴卡） */
async function startChapterPlay(bookId, chapterNo) {
  let book = getBook(bookId);
  assignedOrThrow(book);
  // 游玩中若缺引擎完整大纲，补锁一次（旧本兼容），之后全程以此为准
  if (!book.canon_lock?.locked) {
    await series.lockEngineCanon(book, {
      cast: book.cast_list || [],
      identityLock: book.identity_lock,
      chapters: book.chapter_outline || [],
    });
    book = getBook(bookId);
  }
  assertPrevChapterDone(bookId, chapterNo);
  const ch = series.getChapter(bookId, chapterNo);
  if (!ch) throw new Error('章节不存在');
  if (ch.status === 'done') {
    throw new Error('本章已通关。若要重玩请新建穿越本；不能把已通关章打回重开以免章序错乱');
  }
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const settings = series.getSettings();

  let carriedInventory = [];
  let prevRecapForModel = '';
  let prevRecapForUser = '';
  let prevCompanionAppeared = false;
  let prevTogether = null;
  let prevHandoff = null;
  if (chapterNo > 1) {
    try { prevHandoff = collectPrevChapterHandoff(bookId, chapterNo, book); } catch (_) { prevHandoff = null; }
  }
  if (prevHandoff) {
    carriedInventory = Array.isArray(prevHandoff.inventory) ? prevHandoff.inventory.slice(0, 20) : [];
    prevCompanionAppeared = !!prevHandoff.companionAppeared;
    prevTogether = !!prevHandoff.together;
    prevRecapForUser = formatHandoffForUser(prevHandoff);
  }

  db.prepare('DELETE FROM series_turns WHERE book_id=? AND chapter_no=?').run(bookId, chapterNo);
  purgeSituationTurns(bookId);
  // 重开本章：清掉本章非置顶记忆，身份认知置顶保留
  try {
    db.prepare(
      `DELETE FROM series_memories WHERE book_id=? AND chapter_no=? AND pinned=0 AND kind!='identity'`
    ).run(bookId, chapterNo);
  } catch (_) { /* ignore */ }

  // 上章认人可能只写在现场/总结里、没抽成记忆：开章前补锁定，避免新章当没认出
  try { recoverCrossingRecognition(bookId, chapterNo, book); } catch (_) { /* ignore */ }
  book = getBook(bookId) || book;

  const lock = book.identity_lock || {};
  const uLock = lock.user || {};
  const cLock = lock.char || {};
  // 确保模型世界书存在（旧本补建）
  try {
    const lore = loreHelper.readLore(book);
    if (!lore.locks.user_title && !(lore.entities || []).length) {
      loreHelper.saveLore(bookId, loreHelper.buildLoreFromIdentity(book, {
        userSlot: uLock, charSlot: cLock, cast: book.cast_list || [],
      }));
      book = getBook(bookId) || book;
    }
  } catch (_) { /* ignore */ }
  if (!hasUsableOpeningBrief(uLock.opening_brief)) {
    uLock.opening_brief = ensureUserOpeningBrief(uLock, book, book.book_outline);
    try {
      lock.user = uLock;
      db.prepare('UPDATE series_books SET identity_lock=?, updated_at=datetime(\'now\') WHERE id=?')
        .run(JSON.stringify(lock), bookId);
    } catch (_) { /* ignore */ }
  }
  const storyBeat = resolveChapterStoryBeat(book, chapterNo, ch);
  const base = `${buildIsekaiBasePrompt(book, char, { chapterNo, compact: true })}\n${playContext(book, char, null, { chapterNo, contextText: storyBeat })}`;
  const publicBeat = String(ch.outline || '').trim();
  const chapterCast = castForChapter(book, chapterNo);
  const castPrompt = formatCastForPrompt(chapterCast);
  if (prevHandoff) prevRecapForModel = formatHandoffForModel(prevHandoff, storyBeat);
  const companionName = book.char_role || cLock.surface_name || '';
  const recog = parseCrossingRecognition(bookId, {
    companionName,
    userRole: book.user_role || uLock.surface_name || '',
    book,
  });
  const recogBlock = formatRecognitionForQuest(recog, companionName);
  const ctxUser = `剧本《${book.title}》第${chapterNo}/${book.total_chapters}章「${ch.title || ''}」
全书主线（用户所扮角色的通关目标）：${book.book_main_quest || ''}
同伴身份通关（仅引擎）：${String(lock.char_main_quest || '').trim() || '按同伴所扮角色'}
全书梗概：${(book.book_outline || '').slice(0, 500)}
${prevRecapForModel ? `${prevRecapForModel}\n` : ''}【本章锁定节拍·不可改写成上章余波或认人续集】${storyBeat || '（按类型安排本章事件）'}
【公开栏（防剧透，勿当任务原文，更不要当开场场景）】${publicBeat || '—'}
【本章应出场角色·皆为剧情角色】
${castPrompt || '（沿用角色池）'}
用户所扮：${book.user_role}（${uLock.surface_brief || book.user_surface_brief || ''}）真身份标签仅引擎：${uLock.true_kind || ''}｜${uLock.true_secret || ''}
同伴所扮：${companionName}（${cLock.surface_brief || book.char_surface_brief || ''}）真身份标签仅引擎：${cLock.true_kind || ''}｜${cLock.true_secret || ''}
说明：用户与同伴都是从故事角色池抽中的剧情角色，不是路人挂件；同伴戏份按其角色在【本章故事节拍】中是否出场，禁止硬塞「去汇合」任务。
${recogBlock}
开局是否同场参考：${lock.meet_early ? '是' : '否'}；上一章同场：${prevTogether == null ? '无' : (prevTogether ? '是' : '否')}；上章同伴是否已以剧中身份出场（≠已认出穿越身份）：${prevCompanionAppeared ? '是' : '否'}
已继承道具：${carriedInventory.length ? carriedInventory.map((it) => it.name).join('、') : '（无）'}`;

  const defaultChapter = concreteChapterQuestFromOutline(
    storyBeat,
    chapterNo,
    book.user_role || uLock.surface_name,
    uLock.surface_brief || book.user_surface_brief,
  );

  const beatCarry = resolveChapterBeatCarry(book, chapterNo, ch);
  const inheritedThreads = mergeThreads(
    prevHandoff?.threads || [],
    prevHandoff?.leftover ? [`上章余波：${prevHandoff.leftover}`] : [],
  );
  const crimeStreak = recentCrimeProcedureStreak(bookId, chapterNo, book);

  async function requestChapterQuestJson(extraBan = '') {
    const mysteryRules = series.mysteryQuestRules(
      book.genres, chapterNo, book.total_chapters, uLock.true_kind || '',
    );
    const domesticBlock = series.palaceDomesticPlotBlock(book);
    const streakBan = crimeStreak >= 1
      ? '【宅斗防循环·硬性】上章已是审讯/坐牢/抄家/逼交东西类压迫，本章必须转场内宅冲突（嫡庶、亲事、管家权、名节），禁止续写牢狱审讯主线。'
      : '';
    const memLock = readMemoryLock(lock);
  const recogQuestRules = memLock.active
      ? `
【封忆本】用户已知同伴剧中身份；open_focus 同场时可用 char。同伴不记得穿越，char_beat 按剧中人演。`
      : ((recog.mutual || recog.userKnowsCompanion || recog.companionKnowsUser)
      ? `
【认人状态已锁定后】
- chapter_quest 必须是【本章锁定节拍】的玩家版${CHAPTER_SCENE_LABEL}，禁止写成「应对/通过${companionName || '同伴'}试探你是不是穿越者」，也禁止写成「继续认人/确认同伴」。
- 剧情必要的盘问可以进过程，不能当主局面目标。
- char_beat：按同伴在本章锁定节拍里的戏份；${recog.companionKnowsUser && !recog.userKnowsCompanion && !recog.mutual ? '同伴已单方面知情须延续，禁止遗忘成未认出；也禁止「继续试探用户是否穿越」。' : '若已互认/用户已认出：禁止「继续试探用户是否穿越同伴」。'}
- resistance：以原住民/环境为主。
- open_focus：用户尚未确认谁是穿越同伴时必须用 narration（同伴戏并入剧情旁白）；仅当用户已认出后才可用 char。`
      : `
【卡面】用户尚未认出穿越同伴前，open_focus 必须为 narration，禁止开场就出单独同伴卡。`);
    const briefRaw = await series.chatLong(settings, `${base}
为第${chapterNo}章发布【${CHAPTER_SCENE_LABEL}】。只输出短 JSON（不要旁白、不要 markdown）：
{"chapter_quest":"本章锁定节拍的玩家版局面目标","resistance":"可选：原住民侧可能阻力（引擎用，不对用户展示）","char_beat":"同伴隐藏节拍（按其剧中角色在本章锁定节拍中的戏份）","camera_note":"开场镜头/地点（衔接段从上章收束地起）","slack_ok":true,"together":false,"open_focus":"narration|char"}

【chapter_quest 写法·硬性】
必须是【本章锁定节拍】的玩家能下手版${CHAPTER_SCENE_LABEL}：点明「谁/什么局面要发生」。不要写死具体做法；过章只看这一幕是否落地。
可一项，也可多项；多项用换行「1. …」「2. …」；单一情节目标写成一句即可。
合格例：
· 「让林宛与沈川产生误会」
· 「让宴会当众翻脸这件事真正发生」
不合格（严禁）：
· 「推进主线」「破冰与冲突确立」等空话/结构术语
· 「去和${companionName || '某某'}汇合/碰面」——除非锁定节拍本身就是重逢
· 「认出同伴 / 继续认人 / 应对穿越身份试探」——认人不是本章局面
· 把上章未完局面、认人余波写成新的主局面
规则：
1. 紧扣【本章锁定节拍】，只许润色措辞，不许另编进度。
2. 文案禁止写破真身份标签；全书主线≠本章局面。
3. 开场旁白不得替用户把局面做成。
4. together/open_focus 按本章锁定节拍：该同场才同场。上章同场/认人只影响开场衔接段。
5. 出场人物必须来自角色池。
6. resistance 可选：原住民侧压力；不要把同伴写成统一阻力模板。
${Number(chapterNo) > 1 ? '7. 【跨章衔接】任务仍是本章锁定节拍，不是「接着上章演」。camera_note 可从上章收束地点起；换场写清怎么走过去。上章余波只在开场用一两拍带过。' : `7. 第一章按本章节拍落地即可。
8. ${chapterOnePlayabilityRules(chapterNo, book, uLock).replace(/\n/g, ' ')}`}
${recogQuestRules}
${domesticBlock ? domesticBlock.replace(/\n/g, ' ') : ''}
${streakBan}
${extraBan}
${mysteryRules}`, ctxUser, {
      maxTokens: 900, continueRounds: 1, targetMin: 0, format: 'json', emptyRetries: 1,
      apiType: 'series_outline',
    });
    return series.extractJsonObject(briefRaw);
  }

  let obj = null;
  try {
    obj = await requestChapterQuestJson();
  } catch (e) {
    console.warn('[isekai] brief', e.message);
  }

  const lockedQuest = sanitizeChapterQuestText(defaultChapter);
  let chapterQuest = sanitizeChapterQuestText(obj?.chapter_quest || obj?.main_quest || '');
  const questDrifted = !chapterQuest
    || isAbstractChapterQuest(chapterQuest, companionName)
    || isStaleCompanionProbeQuest(chapterQuest, companionName, recog)
    || isRecognitionAsMainQuest(chapterQuest, storyBeat);
  if (questDrifted) {
    chapterQuest = lockedQuest;
  }
  if (isDomesticCrimeDriftQuest(chapterQuest, storyBeat, book)
    || (series.resolveIntrigueBoard(book) && crimeStreak >= 1 && series.isCrimeProcedureHook(chapterQuest))) {
    chapterQuest = sanitizeChapterQuestText(domesticPalaceQuestFallback(chapterNo, storyBeat, book));
  }

  const sides = [];
  const together = loreHelper.applySceneEtiquetteToQuest(book, {
    together: inferTogetherForChapter({
      modelTogether: obj?.together,
      meetEarly: lock.meet_early,
      outlineBeat: storyBeat,
      userSlot: uLock,
      charSlot: cLock,
      prevTogether,
    }),
    chapter: chapterQuest,
    camera_note: String(obj?.camera_note || ''),
  }, `${storyBeat}\n${obj?.camera_note || ''}`).together;
  let charBeat = String(obj?.char_beat || '').trim().slice(0, 200);
  if (recog.mutual || recog.userKnowsCompanion) {
    if (/(试探|盘问).{0,12}(穿越|穿进来|是否同伴|是不是同伴)/.test(charBeat)) {
      charBeat = `按剧中角色推进本章戏份；已与用户互认穿越身份——勿再演「试探对方是否穿越」；剧情必要的案情盘问/对质可走，知情后可配合`;
    } else if (!charBeat) {
      charBeat = `按剧中角色推进本章对其他人物/事件的戏份；已与用户互认，知情后可配合；剧情必要盘问可走，勿遗忘成初次认人试探`;
    }
  } else if (companionRecognizedUser(recog)) {
    if (/(试探|盘问).{0,12}(穿越|穿进来|是否同伴|是不是同伴)/.test(charBeat)
      || /从未认出|还没认出|尚未认出/.test(charBeat)) {
      charBeat = `按剧中角色推进本章戏份；你已单方面确认用户是穿越同伴（用户尚未认出你）——须延续知情暗助/配合，勿遗忘成未认出，也勿演成「让对方认出我」`;
    } else if (!charBeat) {
      charBeat = `按剧中角色推进本章戏份；已单方面确认用户是穿越同伴但对方尚未认出：可暗助，勿泄题、勿单独同伴卡口吻`;
    }
  } else if (!charBeat) {
    charBeat = readMemoryLock(lock).active
      ? '按你所扮剧中角色在本章戏份行动；封忆中不记得穿越，只演原住民；用户已知你剧中身份'
      : '按你所扮角色在本章故事中的戏份行动；未认出对方是穿越同伴前只按剧中人互动；有反常依据后再按性格介入，不说破、不撞系统';
  }
  let resistance = String(obj?.resistance || '').trim().slice(0, 200);
  if ((recog.mutual || recog.userKnowsCompanion || recog.companionKnowsUser)
    && resistance
    && /(试探|盘问|怀疑).{0,12}(穿越|穿进来|是否同伴)/.test(resistance)) {
    resistance = String(resistance).replace(/(试探|盘问|怀疑).{0,12}(穿越|穿进来|是否同伴)[^；。]*/g, '').trim()
      || '原住民侧可能盘问或看守压力（勿写成遗忘认人状态后的穿越身份试探）';
  }
  const quest = {
    ...emptyQuestState(),
    book_main: String(book.book_main_quest || '').trim().slice(0, 200),
    book_main_done: false,
    chapter: chapterQuest,
    chapter_done: false,
    main: chapterQuest,
    main_done: false,
    sides,
    threads: inheritedThreads,
    beat_carry: beatCarry,
    inventory: carriedInventory.map((it) => ({ ...it })),
    penalties: [],
    char_beat: charBeat,
    resistance,
    together,
    // 仅继承「同伴曾出场」；同场≠已出场卡，更≠已认出穿越身份
    companion_appeared: !!prevCompanionAppeared,
    effects: inheritEffectsForNewChapter(prevHandoff?.effects),
  };
  const camera = String(obj?.camera_note || '').trim().slice(0, 200);
  const slackOk = obj?.slack_ok === true || obj?.slack_ok === 1 || obj?.slack_ok === 'true';
  let openFocus = String(obj?.open_focus || 'narration').toLowerCase() === 'char' ? 'char' : 'narration';
  if (!quest.together && openFocus === 'char') openFocus = 'narration';
  // 用户未认出穿越同伴前：禁止开场出单独同伴卡（封忆本已知剧中身份除外）
  if (!userCanUseCompanionCard(book, recog)) openFocus = 'narration';

  const briefing = formatQuestBriefing(quest, chapterNo, book.genres);
  const cameraStore = JSON.stringify({ note: camera, slack_ok: slackOk });
  db.prepare(`
    UPDATE series_chapters SET
      user_beat=?, char_beat=?, camera_note=?, status='playing',
      content='', updated_at=datetime('now')
    WHERE id=?
  `).run(quest.chapter, quest.char_beat, cameraStore, ch.id);
  saveQuestState(ch.id, quest);

  if (prevRecapForUser) {
    addTurn(bookId, chapterNo, 'system', prevRecapForUser, { type: 'prev_recap' });
  }
  addTurn(bookId, chapterNo, 'system', briefing, { type: 'briefing', slack_ok: slackOk });

  const openObserve = interactiveObserveHint(quest.chapter, quest.sides);
  const openContact = contactBanText(quest);
  const openPressure = worldPressureRules({ quest, recog, book });
  const recogOpen = mutualRecognitionRules({
    hasIdentityMemory: !!(recog.mutual || recog.userKnowsCompanion || recog.companionKnowsUser || recog.lines.length),
    recog,
  });
  const handoffOpen = prevHandoff
    ? formatOpeningBridgeRules(prevHandoff, storyBeat)
    : '';
  const openMutual = !!(recog.mutual || (recog.userKnowsCompanion && recog.companionKnowsUser));
  const openCompanionKnows = companionRecognizedUser(recog) && !userRecognizedCompanion(recog);
  const openUserKnows = userRecognizedCompanion(recog) && !openMutual;
  const openCompanionStance = openMutual
    ? '双方已互认：勿遗忘又演「初次试探对方是否穿越」；私下可按同伴相处，当着原住民仍演戏；剧情必要盘问可走。'
    : openUserKnows
      ? '用户已认出同伴、尚未互认摊牌：勿倒退成用户不知情；也勿写成双方已心知肚明；可用同伴卡。'
      : openCompanionKnows
        ? '同伴已单方面确认用户是穿越同伴、用户尚未认出：心里知情可延续；外在禁止引导认人、禁止彩蛋暗示；描写客观——做了写做了，没做不添油加醋。'
        : '用户此时若尚未行动，在场任何人（含同伴）都不要写成已认出穿越身份。';
  const openPrompt = openFocus === 'char'
    ? `【同伴出场·现场】只写同伴此刻现场言行 280～700 字（用同伴真性格演其剧中身份「${book.char_role}」），写完整收束勿截断。按该剧中人出场即可。${chapterNo > 1 ? '先用一两拍接上章收束（若上章末是认人戏，带过即可），再把场面送到本章锁定节拍入口。' : ''}${openCompanionStance}不要写用户台词/行动结果，不要 JSON，不要【系统】面板，不要开篇写【系统·警告】或禁止项清单，不要手机发消息体。本章同场=${quest.together}（指本章主戏；衔接段可暂从上章同场带过）。
【对白】跟这个人性格走，像现实里真人当面说话：自然好懂，别文绉绉。
${recogOpen}
${objectiveProseRules({ userKnowsCompanion: true })}
出场人物用固定角色池姓名。停在需要用户接话/行动处；禁止替用户把【本章局面】情节目标直接做成：${quest.chapter}
${openPressure}
${handoffOpen}
${openContact}
${openObserve}`
    : `【开场剧情】只写现场剧情：场景、气氛、他人言行，300～700 字，自然收束。第二人称「你」写用户所见所闻（禁止用剧中姓名当叙述主语），不要全知旁白、不要写同伴内心。
【开场节奏·灵活】先用一两句交代此刻在哪、刚发生/正在发生什么；不要写成百科导入。重要人物（用户所扮角色本就认识的）首次或本章首次出场时，用「你脑海里突然想起来……」轻带与你的关系一句；次要路人不要介绍；已介绍过的不要重复「突然想起」。
${chapterNo > 1 ? '结构：一两拍接上章收束（章末若是认人/同伴戏先带过）→ 必须进入本章锁定节拍入口，不要整段只写认人。' : ''}${openCompanionStance}
${chapterNo === 1 ? chapterOnePlayabilityRules(chapterNo, book, uLock) : ''}
${recogOpen}
${formatCompanionCardRule(book, recog, { companionKnowsOnly: openCompanionKnows })}
${objectiveProseRules({ userKnowsCompanion: userCanUseCompanionCard(book, recog) })}
${formatBeatCarryPrompt(quest.beat_carry)}
不要 JSON，不要【系统】任务/警告文案，不要任务列表，不要开篇复述禁止项。章节正文禁止再写【系统·警告】或【系统·任务】。together=${quest.together}：这是本章主戏是否同场。衔接段可先从上章收束的同场/分场接着写；进入本章段后，才按 together 与【场景礼仪】安排（禁忌空间不要硬凑异性同伴，更不要写同伴发来手机消息）。
【角色连贯】优先使用本章应出场角色：${(chapterCast || []).map((c) => c.name).join('、') || '角色池'}；关系网中的贴身仆从/长辈若与本章相关须自然露脸或被点名，禁止整章只剩男女主；禁止无故换一批新核心人物；开场出现的人勿无故蒸发。
【玩家留白·硬性】写到「轮到用户以所扮身份行动」就停。禁止替用户说话；禁止代写用户把【本章局面】情节目标直接做成（${quest.chapter}）。
${series.isRomanceLikeGenre(book.genres) ? '【言情】同场人物（尤其感情对象）须主动抛话、接话；女主若是剧中NPC须有实质台词；勿整场沉默等用户硬推感情。感情只按世界书感情阶梯缓慢推进。' : ''}
现场可有阻力（看守、目光、时间、身份不合），但不要替用户收场。
${openPressure}
${handoffOpen}
${openContact}
${openObserve || '若场面涉及可调查物件或场所，对象露脸时须给出可观察细节，勿空点名。'}`;

  const memExtra = await attachRetrievedMemories(
    bookId,
    `${storyBeat}\n${quest.chapter}\n${camera}`,
    settings,
  );
  let opening = '';
  try {
    opening = await series.chatLong(
      settings,
      `${base}\n${playContext(book, char, quest, { chapterNo, contextText: `${storyBeat}\n${quest.chapter}` })}\n${memExtra}\n${openPrompt}`,
      ctxUser,
      {
        maxTokens: openFocus === 'char' ? 2200 : 2800,
        continueRounds: 2,
        targetMin: openFocus === 'char' ? 160 : 200,
        format: 'prose',
        emptyRetries: 1,
        apiType: 'series_play',
      },
    );
  } catch (e) {
    try {
      db.prepare('DELETE FROM series_turns WHERE book_id=? AND chapter_no=?').run(bookId, chapterNo);
      db.prepare(
        `UPDATE series_chapters SET status='pending', content='', quest_state='{}', updated_at=datetime('now') WHERE id=?`
      ).run(ch.id);
    } catch (_) { /* ignore */ }
    throw new Error(formatApiBillingError(e.message, { label: '穿越开章' }) || e.message || '开章失败');
  }
  opening = dreamHelper.formatDreamProse(String(opening || '').trim());
  if (!opening) {
    try {
      db.prepare('DELETE FROM series_turns WHERE book_id=? AND chapter_no=?').run(bookId, chapterNo);
      db.prepare(
        `UPDATE series_chapters SET status='pending', content='', quest_state='{}', updated_at=datetime('now') WHERE id=?`
      ).run(ch.id);
    } catch (_) { /* ignore */ }
    throw new Error('开场为空，请重试或检查时空 API');
  }

  if (openFocus === 'char') {
    quest.companion_appeared = true;
    saveQuestState(ch.id, quest);
    const viol = detectViolation(opening, 'char', { constraints: (book.identity_lock || {}).char?.constraints || [] });
    addProseTurn(bookId, chapterNo, 'char', opening, { slack_ok: slackOk });
    if (viol) {
      commitViolation(bookId, chapterNo, quest, viol);
      saveQuestState(ch.id, quest);
    }
  } else {
    addProseTurn(bookId, chapterNo, 'narration', opening, { slack_ok: slackOk });
  }

  try {
    let lore = loreHelper.readLore(getBook(bookId) || book);
    loreHelper.updateChapterStage(lore, {
      chapterNo,
      sceneSpace: loreHelper.detectSceneSpace(`${camera}\n${opening}`, book),
      resetOnStage: true,
      onStageDelta: loreHelper.findEntitiesInText(lore, opening).map((e) => ({ name: e.name, status: 'present' })),
    });
    loreHelper.saveLore(bookId, lore);
    loreHelper.syncLoreAfterProse(bookId, getBook(bookId) || book, opening, {
      chapterNo,
      sceneHint: camera,
    });
  } catch (e) {
    console.warn('[isekai] lore sync open', e.message);
  }

  series.touchBook(bookId);
  return getChapterPlay(bookId, chapterNo);
}

function getChapterPlay(bookId, chapterNo) {
  const bookFull = getBook(bookId);
  const book = publicBook(bookId);
  purgeSituationTurns(bookId);
  const ch = series.getChapter(bookId, chapterNo);
  if (!ch) throw new Error('章节不存在');
  const turns = listTurns(bookId, chapterNo);
  const arrive = listTurns(bookId, 0);
  const cam = parseCameraField(ch.camera_note);
  const questFull = readQuestState(ch, bookFull);
  const quest = publicQuest(questFull);
  const lastFocus = [...turns].reverse().find((t) => t.kind === 'narration' || t.kind === 'char');
  const slack_ok = lastFocus?.meta?.slack_ok != null ? !!lastFocus.meta.slack_ok : cam.slack_ok;
  // 上一章公开回顾（剧情+道具，不含隐藏角色记忆）
  let prev_recap = null;
  if (Number(chapterNo) > 1) {
    try {
      const prev = series.getChapter(bookId, chapterNo - 1);
      const pq = readQuestState(prev, bookFull);
      if (pq?.recap?.plot || pq?.recap?.leftover || (pq?.recap?.inventory || []).length) {
        prev_recap = {
          chapter_no: Number(chapterNo) - 1,
          plot: String(pq.recap.plot || '').trim(),
          leftover: String(pq.recap.leftover || '').trim(),
          where: String(pq.recap.where || '').trim(),
          who: String(pq.recap.who || '').trim(),
          inventory: Array.isArray(pq.recap.inventory) ? pq.recap.inventory : (pq.inventory || []),
        };
      } else if (prev?.status === 'done') {
        prev_recap = {
          chapter_no: Number(chapterNo) - 1,
          plot: String(pq.recap?.plot || '').trim() || '承接上一章收束场面继续推进。',
          leftover: String(pq.recap?.leftover || '').trim(),
          inventory: pq.inventory || [],
        };
      }
    } catch (_) { /* ignore */ }
  }
  return {
    book,
    chapter: {
      id: ch.id,
      book_id: ch.book_id,
      chapter_no: ch.chapter_no,
      title: ch.title,
      outline: ch.outline,
      status: ch.status,
      director_notes: ch.director_notes,
      content_len: ch.content ? String(ch.content).length : 0,
      updated_at: ch.updated_at,
      camera_note: cam.note,
      slack_ok,
      quest,
      char_beat: '',
    },
    turns,
    arrive,
    slack_ok,
    quest,
    prev_recap,
  };
}

function recentTurnsText(turns, limit = 12) {
  const slice = turns.slice(-limit);
  return slice.map((t) => {
    const label = ({
      narration: '剧情',
      user: '用户(扮)',
      char: '同伴(扮)',
      system: '系统',
      whisper_user: '摸鱼·用户',
      whisper_char: '摸鱼·同伴',
    })[t.kind] || t.kind;
    const note = t.kind === 'user'
      ? '\n（心声/心想/括号内心仅用户自知，当时他人听不见）'
      : '';
    return `【${label}】${t.content}${note}`;
  }).join('\n\n');
}

const MEM_KIND_LABEL = {
  identity: '身份认知·置顶',
  plot: '剧情',
  char: '同伴/互动',
};

function insertMemory(bookId, chapterNo, content, kind = 'plot', pinned = 0) {
  const t = String(content || '').trim().slice(0, 160);
  if (!t) return;
  const k = ['identity', 'plot', 'char'].includes(kind) ? kind : 'plot';
  const pin = (pinned || k === 'identity') ? 1 : 0;
  // 去重：同书近义短句不重复插
  const hit = db.prepare(
    `SELECT id FROM series_memories WHERE book_id=? AND kind=? AND content=? LIMIT 1`
  ).get(bookId, k, t);
  if (hit) {
    if (pin) db.prepare(`UPDATE series_memories SET pinned=1 WHERE id=?`).run(hit.id);
    return;
  }
  db.prepare(
    `INSERT INTO series_memories (book_id, content, chapter_no, kind, pinned) VALUES (?,?,?,?,?)`
  ).run(bookId, t, Number(chapterNo) || 0, k, pin ? 1 : 0);
}

/** 穿越记忆块：身份认知置顶常驻；剧情/同伴改走向量检索（见 attachRetrievedMemories） */
function isekaiMemoryBlock(bookId) {
  let pinned = [];
  try {
    pinned = db.prepare(`
      SELECT content, chapter_no, kind FROM series_memories
      WHERE book_id=? AND (pinned=1 OR kind='identity')
      ORDER BY id DESC LIMIT 16
    `).all(bookId);
  } catch (_) {
    return '';
  }

  const fmt = (rows) => rows
    .slice()
    .reverse()
    .map((r) => `- [第${r.chapter_no}章·${MEM_KIND_LABEL[r.kind] || r.kind}] ${r.content}`)
    .join('\n');

  if (!pinned.length) return '';
  return `【身份认知·重要置顶·不可遗忘】\n${fmt(pinned)}\n（含：谁已猜到/知晓谁的真身份，或谁已推断出对方是穿越同伴。仅当记忆明确写了「已认出/已确认」时才能据此认亲；禁止把暧昧眼神当成已认出。剧情细节由检索注入，勿在此臆造。）`;
}

/** 异步：向量/词法检索相关剧情记忆，与置顶身份记忆分工、不互相覆盖 */
async function attachRetrievedMemories(bookId, queryText, settings) {
  try {
    const { related } = await loreHelper.selectIsekaiMemoriesForPrompt(bookId, queryText, {
      topK: 5,
      settings: settings || series.getSettings(),
    });
    return loreHelper.formatMemoryRetrievalBlock([], related);
  } catch (e) {
    console.warn('[isekai] memory retrieve', e.message);
    return '';
  }
}

/**
 * 从近期回合抽取记忆。identity 类一律置顶。
 * @param {{ force?: boolean }} opts force=章末强制抽；否则隔回合抽一次减轻负担
 */
async function extractIsekaiMemories(bookId, chapterNo, turns, { force = false } = {}) {
  const playTurns = (turns || []).filter((t) => ['narration', 'user', 'char', 'whisper_user', 'whisper_char'].includes(t.kind));
  if (playTurns.length < 2) return;
  if (!force && playTurns.length % 2 !== 0) return;

  const settings = series.getSettings();
  try {
    series.requireSeriesApi(settings);
  } catch {
    return;
  }

  const slice = recentTurnsText(playTurns, force ? 20 : 12);
  const system = `你是穿越剧本记忆官。从回合中提取可延续事实，只输出 JSON：
{"plot":["剧情事实…"],"char":["同伴做了什么/与用户如何互动…"],"identity":["身份认知：谁猜到或知晓了什么…"]}
规则：
- plot：线索、地点、已发生事件、道具去向；每条≤40字，最多5条
- char：同伴行动、态度变化、与用户的约定/冲突；每条≤40字，最多5条
- identity：仅当文中出现「明确猜到/基本确认/摊牌」时才写。必须区分两类：
  (A) 穿越互认：谁确认对方是穿越同伴（含当面摊牌、彼此承认一起穿进来）——务必写成含「用户↔同伴已互认/摊牌」字样，便于后续章节遵守；
  (B) 真身份标签：谁知晓谁是真凶/女主等——另写一条。
  没有明确认知则 []。禁止把「多看一眼」「语气略怪」当成已认出；禁止编造未发生内容；不要把表面身份误写成已揭晓的真身份`;

  try {
    const raw = await series.chatLong(settings, system, `第${chapterNo}章近期回合：\n${slice}`, {
      maxTokens: 700, continueRounds: 0, targetMin: 0, format: 'json', emptyRetries: 0,
      apiType: 'series_outline',
    });
    const obj = series.extractJsonObject(raw) || {};
    for (const f of (Array.isArray(obj.identity) ? obj.identity : []).slice(0, 6)) {
      insertMemory(bookId, chapterNo, f, 'identity', 1);
    }
    for (const f of (Array.isArray(obj.plot) ? obj.plot : []).slice(0, 5)) {
      insertMemory(bookId, chapterNo, f, 'plot', 0);
    }
    for (const f of (Array.isArray(obj.char) ? obj.char : []).slice(0, 5)) {
      insertMemory(bookId, chapterNo, f, 'char', 0);
    }
    // 新记忆补向量（后台，失败则本地词法）
    try {
      const recent = db.prepare(`
        SELECT id, content, embedding FROM series_memories WHERE book_id=? ORDER BY id DESC LIMIT 12
      `).all(bookId);
      for (const row of recent) {
        if (!row.embedding) await loreHelper.ensureMemoryEmbedding(row, settings);
      }
    } catch (_) { /* ignore */ }
    // 控制体量：非置顶记忆过多时删最旧
    pruneIsekaiMemories(bookId);
  } catch (e) {
    console.warn('[isekai] memory extract', e.message);
  }
  try {
    const bk = getBook(bookId);
    persistCrossingRecognition(bookId, chapterNo, inferRecognitionFromText(slice, {
      companionName: bk?.char_role || bk?.identity_lock?.char?.surface_name || '',
      userRole: bk?.user_role || bk?.identity_lock?.user?.surface_name || '',
    }));
  } catch (_) { /* ignore */ }
}

function pruneIsekaiMemories(bookId) {
  const soft = db.prepare(`
    SELECT id FROM series_memories
    WHERE book_id=? AND pinned=0 AND kind IN ('plot','char')
    ORDER BY id DESC
  `).all(bookId);
  if (soft.length <= 48) return;
  const drop = soft.slice(48).map((r) => r.id);
  if (!drop.length) return;
  db.prepare(`DELETE FROM series_memories WHERE id IN (${drop.map(() => '?').join(',')})`).run(...drop);
}

function parseCameraField(raw) {
  const s = String(raw || '').trim();
  if (!s) return { note: '', slack_ok: false };
  if (s.startsWith('{')) {
    const o = series.parseJson(s, null);
    if (o && typeof o === 'object') {
      return {
        note: String(o.note || '').trim(),
        slack_ok: !!(o.slack_ok === true || o.slack_ok === 1 || o.slack_ok === '1'),
      };
    }
  }
  return { note: s, slack_ok: /可摸鱼|空隙|不在你/.test(s) };
}

function assertPrevChapterDone(bookId, chapterNo) {
  if (chapterNo <= 1) return;
  const prev = series.getChapter(bookId, chapterNo - 1);
  if (!prev || prev.status !== 'done') throw new Error('请先完成上一章');
}

function applySideRewards(quest, sideIds) {
  const notices = [];
  const ids = Array.isArray(sideIds) ? sideIds.map(Number) : [];
  for (const id of ids) {
    const side = (quest.sides || []).find((s) => Number(s.id) === id);
    if (!side || side.done) continue;
    side.done = true;
    if (Math.random() < 0.45) {
      const name = side.reward_hint || `支线道具·${side.id}`;
      const item = { name, desc: `完成支线「${side.text}」获得`, from_side: side.id };
      quest.inventory.push(item);
      notices.push(`【系统】支线 ${side.id} 完成，获得功能道具：${name}`);
    } else {
      notices.push(`【系统】支线 ${side.id} 完成（本次未掉落道具）`);
    }
  }
  return notices;
}

/** 续写任务已产出回复但 status 仍卡在 queued/running 时自动收口 */
function reconcileStaleIsekaiTurnJobs(bookId, chapterNo) {
  try {
    const stale = db.prepare(`
      SELECT id, payload FROM series_jobs
      WHERE book_id=? AND chapter_no=? AND kind='isekai_turn' AND status IN ('queued','running')
    `).all(bookId, chapterNo);
    for (const job of stale) {
      let turnIdBefore = 0;
      try {
        const payload = typeof job.payload === 'string' ? JSON.parse(job.payload || '{}') : (job.payload || {});
        turnIdBefore = Number(payload.turnIdBefore) || 0;
      } catch (_) { /* ignore */ }
      const hasReply = db.prepare(`
        SELECT id FROM series_turns
        WHERE book_id=? AND chapter_no=? AND id>? AND kind IN ('narration','char','whisper_char')
        LIMIT 1
      `).get(bookId, chapterNo, turnIdBefore);
      if (hasReply) {
        db.prepare(
          `UPDATE series_jobs SET status='done', error='', updated_at=datetime('now') WHERE id=?`
        ).run(job.id);
      }
    }
  } catch (_) { /* ignore */ }
}

/** 续写失败时只删 AI 侧新卡，保留用户行动 */
function rollbackPlayTurnAi(bookId, chapterNo, turnIdBefore) {
  if (turnIdBefore == null) return;
  try {
    db.prepare(
      `DELETE FROM series_turns WHERE book_id=? AND chapter_no=? AND id>? AND kind NOT IN ('user','whisper_user')`
    ).run(bookId, chapterNo, Number(turnIdBefore) || 0);
  } catch (_) { /* ignore */ }
}

/** 用户推动剧情 */
async function userPlayTurn(bookId, chapterNo, {
  text = '',
  whisper = false,
  stopBeforeAi = false,
  continueAfterTurnId = null,
} = {}) {
  let book = getBook(bookId);
  assignedOrThrow(book);
  assertPrevChapterDone(bookId, chapterNo);
  const ch = series.getChapter(bookId, chapterNo);
  if (!ch) throw new Error('章节不存在');
  if (ch.status !== 'playing' && ch.status !== 'done') {
    throw new Error('请先生成并进入本章');
  }
  if (ch.status === 'done') throw new Error('本章已完成');

  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const settings = series.getSettings();
  const cam = parseCameraField(ch.camera_note);
  let quest = readQuestState(ch, book);
  const isFinale = Number(chapterNo) >= Number(book.total_chapters);

  let content;
  let turnIdBefore;
  let turnsForRecent;

  if (continueAfterTurnId != null) {
    turnIdBefore = Number(continueAfterTurnId) || 0;
    const allTurns = listTurns(bookId, chapterNo);
    const pendingUser = allTurns.find(
      (t) => Number(t.id) > turnIdBefore && (t.kind === 'user' || t.kind === 'whisper_user'),
    );
    if (!pendingUser) throw new Error('续写上下文丢失，请重新发送');
    const hasReply = allTurns.some(
      (t) => Number(t.id) > turnIdBefore && ['narration', 'char', 'whisper_char'].includes(t.kind),
    );
    if (hasReply) {
      const playDone = getChapterPlay(bookId, chapterNo);
      return {
        turns: playDone.turns,
        last: playDone.turns?.[playDone.turns.length - 1] || null,
        chapter: playDone.chapter,
        slack_ok: !!parseCameraField(playDone.chapter?.camera_note).slack_ok,
        quest: playDone.quest,
        chapter_cleared: playDone.chapter?.status === 'done' || !!playDone.quest?.chapter_done,
      };
    }
    content = String(pendingUser.content || '').trim();
    turnsForRecent = allTurns.filter((t) => Number(t.id) <= turnIdBefore);
  } else {
    content = String(text || '').trim();
    if (!content) throw new Error('请输入内容');
    if (content.length > 2000) throw new Error('一次不要写太长');
    // 本章禁言：只禁止对白，动作仍可发
    if (quest.effects?.user_muted_chapter && hasSpokenDialogue(content)) {
      throw new Error('你本章禁言中：只能写动作，不能写带引号或「说道」的对白');
    }
    reconcileStaleIsekaiTurnJobs(bookId, chapterNo);
    const pendingJob = db.prepare(`
      SELECT id FROM series_jobs
      WHERE book_id=? AND chapter_no=? AND kind='isekai_turn' AND status IN ('queued','running')
      LIMIT 1
    `).get(bookId, chapterNo);
    if (pendingJob) throw new Error('上一段续写还在生成中，请稍候');
    // 任务已勾完但章状态未落成 done（例如上次结算中断）：先补结算，避免一直卡在可玩状态
    if (quest.chapter_done || quest.main_done) {
      const sealed = await sealChapterDone(bookId, chapterNo, { writeEnding: isFinale });
      return {
        turns: sealed.turns,
        last: sealed.turns?.[sealed.turns.length - 1] || null,
        chapter: sealed.chapter,
        slack_ok: !!sealed.slack_ok,
        quest: sealed.quest,
        chapter_cleared: true,
      };
    }
    turnsForRecent = listTurns(bookId, chapterNo);
    turnIdBefore = turnsForRecent.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
    addTurn(bookId, chapterNo, whisper ? 'whisper_user' : 'user', content, {});
  }

  const slackNow = cam.slack_ok;
  const storyBeat = resolveChapterStoryBeat(book, chapterNo, ch);
  const lockedQuestText = String(quest.chapter || quest.main || '').trim();

  const rollbackNewTurns = () => rollbackPlayTurnAi(bookId, chapterNo, turnIdBefore);

  if (continueAfterTurnId == null) {

  if (isSystemSummon(content)) {
    const statusLine = (quest.chapter_done || quest.main_done)
      ? '【系统】本章局面已落定，请点「完成本章」结算后再进入下一章。'
      : '【系统】本章局面尚未落定，请继续以剧本身份推进。';
    const floor = chapterEngagementFloor(book);
    const { userTurns, storyTurns } = playTurnCounts(listTurns(bookId, chapterNo));
    const engageHint = meetsChapterEngagement(book, listTurns(bookId, chapterNo))
      ? ''
      : `【系统·节奏】中篇建议至少 ${floor.minUser} 轮你的行动、${floor.minStory} 轮场面来回后再完章（当前 ${userTurns}/${floor.minUser} 行动，${storyTurns}/${floor.minStory} 场面）。`;
    const panels = [
      formatQuestBriefing(quest, chapterNo, book.genres),
      statusLine,
      engageHint,
    ].filter(Boolean);
    let lastSummon = null;
    for (const panel of panels) {
      lastSummon = addTurn(bookId, chapterNo, 'system', panel, { type: 'system_summon' });
    }
    const playSummon = getChapterPlay(bookId, chapterNo);
    return {
      turns: playSummon.turns,
      last: lastSummon,
      chapter: playSummon.chapter,
      slack_ok: !!cam.slack_ok,
      quest: playSummon.quest,
      chapter_cleared: false,
    };
  }

    const idLock = book.identity_lock || {};
    const userViol = detectViolation(content, 'user', { constraints: idLock.user?.constraints || [] });
    if (userViol) {
      commitViolation(bookId, chapterNo, quest, userViol);
      saveQuestState(ch.id, quest);
      // 惩罚已落地；继续让场面反应本回合行动（禁言不锁死输入）
    }

    if (stopBeforeAi) {
      const playPending = getChapterPlay(bookId, chapterNo);
      return {
        pending: true,
        turnIdBefore,
        turns: playPending.turns,
        chapter: playPending.chapter,
        quest: playPending.quest,
        slack_ok: !!cam.slack_ok,
      };
    }
  }

  const memExtra = await attachRetrievedMemories(
    bookId,
    `${content}\n${lockedQuestText}\n${storyBeat}`,
    settings,
  );
  const base = `${buildIsekaiBasePrompt(book, char, { chapterNo, compact: true })}\n${playContext(book, char, quest, { chapterNo, contextText: `${content}\n${lockedQuestText}` })}\n${memExtra}\n${effectsPromptLine(quest)}`;
  const routeUser = `《${book.title}》第${chapterNo}章「${ch.title}」
本章锁定节拍：${storyBeat}
公开栏：${ch.outline || ''}
全书主线：${quest.book_main || book.book_main_quest || ''}
【已锁定的${CHAPTER_SCENE_LABEL}·禁止改发】${lockedQuestText}（${quest.chapter_done || quest.main_done ? '已落定' : '未落定'}）
${quest.beat_carry?.length ? formatBeatCarryPrompt(quest.beat_carry) : ''}
${quest.threads?.length ? `【进行中的线】${quest.threads.join('；')}` : ''}
同伴隐藏节拍：${quest.char_beat}
同场：${quest.together}；镜头参考：${cam.note || '未知'}；空隙参考：${slackNow ? '较像空隙' : '较像正事'}
道具：${inventoryText(quest)}
本章应出场角色：${formatCastForPrompt(castForChapter(book, chapterNo)) || '（角色池）'}
${formatAnchorCastForRoute(book, chapterNo)}
近期：
${recentTurnsText(turnsForRecent, 6)}

用户刚才说/做：${content}
【心声隔离】上列用户文本中，心声/心想/暗想/括号内心活动仅用户自知；同伴与原住民听不见；旁白勿写破。路由与续写只依据可感知的对白「」与外在动作。`;

  // 短路由 JSON（不含正文）
  let route = {
    focus: 'narration',
    slack_ok: slackNow,
    chapter_done: !!quest.chapter_done,
    book_main_done: !!quest.book_main_done,
    sides_done: [],
    together: !!quest.together,
    anchor_risk: false,
    anchor_npc: '',
    anchor_severity: '',
    anchor_proceed: false,
    anchor_backoff: false,
  };
  const memLockRoute = readMemoryLock(book.identity_lock);
  try {
    const routeRaw = await series.chatLong(settings, `${base}
根据用户行动只输出短 JSON（不要正文）：
{"focus":"char|narration","slack_ok":true,"quest_done":false,"beat_closed":false,"chapter_done":false,"book_main_done":false,"sides_done":[],"together":false,"char_offense":"","char_penalty":"","resonance_hit":false,"resonance_strength":0,"resonance_seed_id":"","resonance_scene_ok":true,"anchor_risk":false,"anchor_npc":"","anchor_severity":"","anchor_proceed":false,"anchor_backoff":false}
规则：
- focus=char 同伴单独出场；focus=narration 旁白/他人镜头。together=true 且（用户已认出穿越同伴 或 封忆本已知同伴剧中身份）时 focus=char 才合适；否则 focus=narration。
- quest_done=【本章锁定节拍/${CHAPTER_SCENE_LABEL}】对应的情节局面是否已在剧情中落地。认出同伴、互认、记尘 ≠ quest_done。
- beat_closed=本回合是否可自然收束（参考）。
- chapter_done：仅 quest_done=true 时才可 true；且须已有足够互动（中篇至少 ${chapterEngagementFloor(book).minUser} 轮用户行动与 ${chapterEngagementFloor(book).minStory} 轮场面），否则 chapter_done 必须 false。
- 【禁止】中途改发/追加新局面；sides_done 恒为 []。
- together 按剧中身份与当前剧情是否同场。
- 同伴按性格介入；禁止替用户把局面直接做成。
- 若同伴严重违规填 char_offense/char_penalty，否则空串。
${formatMemoryResonanceRouteRules(memLockRoute)}${formatAnchorRiskRouteRules(book, chapterNo)}
【场景礼仪】须遵守 playContext 中的场景礼仪；禁忌空间不得 together=true 硬凑异性同伴。
另附 scene_space（inner_women|outer_guest|public|private_meet|workplace|school|other）与 on_stage_delta（本回合在场变化，如 [{"name":"春燕","status":"present|left","note":""}]）。`, routeUser, {
      maxTokens: 500, continueRounds: 0, targetMin: 0, format: 'json', emptyRetries: 1,
      apiType: 'series_outline',
    });
    const parsed = series.extractJsonObject(routeRaw);
    if (parsed) {
      const questDone = parsed.quest_done === true || parsed.quest_done === 1 || parsed.quest_done === 'true'
        || parsed.main_done === true || parsed.main_done === 1 || parsed.main_done === 'true';
      // 与手动「完成本章」一致：任务实质完成即过章；勿要求 beat_closed 双真，否则模型会一直「再演两句」拖在本章
      let chapterDone = questDone;
      if (!chapterDone) {
        chapterDone = parsed.chapter_done === true || parsed.chapter_done === 1 || parsed.chapter_done === 'true'
          || parsed.main_done === true || parsed.main_done === 1 || parsed.main_done === 'true';
      }
      // 仅当明确未完成任务时才否决；禁止用 chapter_done=false 盖住已完成的 quest_done
      if (!questDone && (parsed.chapter_done === false || parsed.chapter_done === 0 || parsed.chapter_done === 'false')) {
        chapterDone = false;
      }
      route = {
        focus: String(parsed.focus || '').toLowerCase() === 'char' ? 'char' : 'narration',
        slack_ok: parsed.slack_ok === true || parsed.slack_ok === 1 || parsed.slack_ok === 'true',
        chapter_done: chapterDone,
        book_main_done: parsed.book_main_done === true || parsed.book_main_done === 1 || parsed.book_main_done === 'true',
        sides_done: [],
        together: parsed.together === true || parsed.together === 1 || parsed.together === 'true',
        char_offense: String(parsed.char_offense || '').trim(),
        char_penalty: String(parsed.char_penalty || '').trim(),
        resonance_hit: parsed.resonance_hit === true || parsed.resonance_hit === 1,
        resonance_strength: Number(parsed.resonance_strength) || 0,
        resonance_seed_id: String(parsed.resonance_seed_id || '').trim(),
        resonance_scene_ok: parsed.resonance_scene_ok !== false,
        anchor_risk: parsed.anchor_risk === true || parsed.anchor_risk === 1 || parsed.anchor_risk === 'true',
        anchor_npc: String(parsed.anchor_npc || '').trim(),
        anchor_severity: String(parsed.anchor_severity || '').trim(),
        anchor_proceed: parsed.anchor_proceed === true || parsed.anchor_proceed === 1 || parsed.anchor_proceed === 'true',
        anchor_backoff: parsed.anchor_backoff === true || parsed.anchor_backoff === 1 || parsed.anchor_backoff === 'true',
        scene_space: String(parsed.scene_space || '').trim(),
        on_stage_delta: Array.isArray(parsed.on_stage_delta) ? parsed.on_stage_delta : [],
      };
    }
  } catch (e) {
    console.warn('[isekai] route', e.message);
  }

  const turnsAfterUser = listTurns(bookId, chapterNo);
  if (route.chapter_done && !meetsChapterEngagement(book, turnsAfterUser)) {
    route.chapter_done = false;
  }

  if (memLockRoute.active && memLockRoute.stage < 3) {
    const res = applyMemoryResonance(memLockRoute, route, chapterNo);
    if (res.changed) {
      persistMemoryLock(bookId, res.lock, book.identity_lock);
      book = getBook(bookId) || book;
      if (res.stageUp) {
        const notice = formatMemoryStageNotice(res.lock);
        if (notice) addTurn(bookId, chapterNo, 'system', notice, { type: 'memory_stage' });
      }
    }
  }

  const anchorFx = processAnchorRisk(book, quest, chapterNo, route, content);
  if (anchorFx.blockForWarning) {
    saveQuestState(ch.id, quest);
    const warnTurn = addTurn(bookId, chapterNo, 'system', anchorFx.warningText, { type: 'anchor_warn' });
    const playBlocked = getChapterPlay(bookId, chapterNo);
    return {
      turns: playBlocked.turns,
      last: warnTurn,
      chapter: playBlocked.chapter,
      slack_ok: !!route.slack_ok,
      quest: playBlocked.quest,
      chapter_cleared: false,
    };
  }
  if (anchorFx.forkRecorded && anchorFx.forkNotice) {
    addTurn(bookId, chapterNo, 'system', anchorFx.forkNotice, { type: 'anchor_fork' });
  }

  if (route.chapter_done) {
    quest.chapter_done = true;
    quest.main_done = true;
  }
  if (route.book_main_done) quest.book_main_done = true;
  if (typeof route.together === 'boolean') quest.together = route.together;
  // 场景礼仪：程序层覆盖模型乱写的 together（与世界书场景锁一致）
  {
    const etq = loreHelper.applySceneEtiquetteToQuest(
      book,
      quest,
      `${content}\n${cam.note || ''}\n${route.scene_space || ''}`,
    );
    quest.together = etq.together;
    quest._scene_space = etq._scene_space;
    quest._scene_policy = etq._scene_policy;
    if (route.scene_space) {
      try {
        let lore = loreHelper.readLore(book);
        loreHelper.updateChapterStage(lore, {
          chapterNo,
          sceneSpace: route.scene_space,
          onStageDelta: Array.isArray(route.on_stage_delta) ? route.on_stage_delta : [],
        });
        loreHelper.saveLore(bookId, lore);
        book = getBook(bookId) || book;
      } catch (_) { /* ignore */ }
    }
  }
  const turnRecog = parseCrossingRecognition(bookId, {
    companionName: book.char_role || '',
    userRole: book.user_role || '',
    book,
  });
  // 分场禁止出同伴卡；未同场时禁止同伴卡（避免未出场却像手机发消息）
  if (!quest.together && route.focus === 'char') route.focus = 'narration';
  // 用户未认出穿越同伴前：禁止单独同伴卡（封忆本已知剧中身份除外）
  if (!userCanUseCompanionCard(book, turnRecog)) route.focus = 'narration';
  // 同场且用户在自伤/赴险：优先同伴卡；封忆本或已认出均可
  if (quest.together && userCanUseCompanionCard(book, turnRecog) && looksSelfHarmOrInjuryAction(`${lockedQuestText}\n${content}`)) {
    route.focus = 'char';
  }
  const rewardNotices = applySideRewards(quest, route.sides_done);
  for (const n of rewardNotices) {
    addTurn(bookId, chapterNo, 'system', n, { type: 'notice' });
  }

  // 生成正文：同伴卡 or 剧情卡
  let body = '';
  let last = null;
  const focus = route.focus;
  const chapterCleared = !!quest.chapter_done;
  const metaQuestAsk = isQuestStatusAsk(content);
  const noRetell = '【禁止复述】不要复述用户原文。用户写的是当场尝试，结果由现场裁定：可被拦、失手、只做到一半；禁止把用户声明的成功当成既成事实。';
  const noHearThoughts = '【用户心声·硬性】心声/心想/心道/暗想/未出口念头/括号内心活动：他人听不见。同伴与剧中主角禁止像听见了一样接话或变态度；旁白禁止写破、复述或暗示心声。只对「」对白与外在动作给反应。';
  const castNames = (castForChapter(book, chapterNo) || []).map((c) => c.name).filter(Boolean).join('、');
  const castKeep = castNames
    ? `【角色连贯】继续使用：${castNames}；禁止突然换成一批新核心人物。`
    : '【角色连贯】沿用已出场姓名，禁止章中途换核心阵容。';
  const observeHint = interactiveObserveHint(quest.chapter, quest.sides);
  const turnContact = contactBanText(quest);
  const pressure = worldPressureRules({ quest, userAction: content, recog: turnRecog, book });
  const questLock = `【局面锁定】${CHAPTER_SCENE_LABEL}已发布且不可改写：「${lockedQuestText}」。禁止改发/追加新局面。同伴看不到该原文，但可按性格推测并介入。`;
  const nextNo = Number(chapterNo) + 1;
  const nextBeat = (!isFinale && nextNo <= Number(book.total_chapters || 0))
    ? String(resolveChapterStoryBeat(book, nextNo, series.getChapter(bookId, nextNo) || {}) || '').trim().slice(0, 120)
    : '';
  const chapterCloseBan = `【硬性·本章完结】第${chapterNo}章任务已完成：只允许写「当前场面」的极短收束（余韵/停顿），然后停笔。
严禁：开启第${nextNo}章或后续剧情；跳到新地点开新冲突；写「随后/第二天/接着你们去…」进入新事件；发布新任务；按下一章大纲推进。
${nextBeat ? `下一章节拍（严禁写入正文）：${nextBeat}` : ''}
不要【系统】字样，不要要求用户继续行动。`;

  // 任务已完成：禁止再当「可玩章节」续写长剧情（尤其用户在问是否完成时，更不要开下一章戏）
  if (chapterCleared) {
    try {
      if (!metaQuestAsk) {
        body = await series.chatLong(settings, `${base}
【章末收束·短】只写 60～140 字现场余韵/停顿。不要 JSON，不要写用户台词。
${noRetell}
${chapterCloseBan}
${castKeep}`, routeUser, {
          maxTokens: 500, continueRounds: 0, targetMin: 0, format: 'prose', emptyRetries: 1,
        });
        body = dreamHelper.formatDreamProse(String(body || '').trim());
      }
    } catch (e) {
      console.warn('[isekai] chapter close prose', e.message);
      body = '';
    }
    if (body) {
      last = addProseTurn(bookId, chapterNo, 'narration', body, { slack_ok: true, type: 'chapter_close' });
    }
    saveQuestState(ch.id, quest);
    addTurn(
      bookId,
      chapterNo,
      'system',
      isFinale
        ? '【系统】这一幕已落定。本章剧情完结；全书章节已走完，可返回查看。'
        : '【系统】这一幕已落定。本章剧情完结，请进入下一章节。',
      { type: 'chapter_clear' },
    );
    await sealChapterDone(bookId, chapterNo, { writeEnding: isFinale });
    const play = getChapterPlay(bookId, chapterNo);
    return {
      turns: play.turns,
      last: last || play.turns?.[play.turns.length - 1] || null,
      chapter: play.chapter,
      slack_ok: true,
      quest: play.quest,
      chapter_cleared: true,
    };
  }

  try {
  if (focus === 'char') {
    const charMuteExtra = quest.effects?.char_muted_chapter
      ? '\n【同伴本章禁言·硬性】禁止任何「」对白与开口说话；只能写无声动作、表情、目光、肢体。需要表态用动作完成。'
      : '';
    body = await series.chatLong(settings, `${base}
【同伴卡·现场】只输出同伴（剧中「${book.char_role}」）的现场言行 280～700 字，用真性格演身份，写完整到自然收束。不要 JSON，不要写用户台词，不要写【系统】，不要手机短信体。同场=${quest.together}。
【对白】跟【同伴演技参考】性格走，像现实里真人当面说话：自然好懂，别文绉绉。${charMuteExtra}
${mutualRecognitionRules({ hasIdentityMemory: !!(turnRecog.mutual || turnRecog.userKnowsCompanion || turnRecog.companionKnowsUser || turnRecog.lines?.length), recog: turnRecog })}
${objectiveProseRules({ userKnowsCompanion: true })}
${series.isRomanceLikeGenre(book.genres) ? (quest.effects?.char_muted_chapter
      ? '【言情·禁言中】不能开口时用靠近、停顿、眼神、阻拦等动作制造心动/拉扯；禁止写出对白。'
      : '【言情】你须主动抛话、接话，制造心动/拉扯节点；禁止整场沉默等用户硬推感情。不替用户开口，但要把话头抛过去。') : ''}
你看不到用户的系统任务原文。用户已认出你是穿越同伴（或已互认）：勿倒退成陌生人试探；私下可按性格配合/损/商量，当着原住民仍演剧中人设。剧情必要盘问可走。危险时不必收起性格，但避开系统会抓的违规。不要当局外人，也不要替用户把情节目标直接做成。
${noRetell}
${noHearThoughts}
${questLock}
${pressure}
${castKeep}
${turnContact}
${observeHint}
承接用户尝试给反应；不要替用户把【本章局面】情节目标直接做成；停在下一处需用户接的节点。若用户正在调查某物，反馈可观察结果与新细节，勿直接给最终答案。
重要人物首次出场用「脑海里突然想起来」轻带关系；遵守名分锁与在场表。`, routeUser, {
        maxTokens: 2200, continueRounds: 2, targetMin: 160, format: 'prose', emptyRetries: 1,
        apiType: 'series_play',
      });
  } else {
      body = await series.chatLong(settings, `${base}
【剧情卡】只写现场旁白/他人镜头 300～700 字，自然收束。第二人称「你」写用户所见所闻（禁止用剧中姓名当叙述主语），不要全知、不要写同伴内心。
${mutualRecognitionRules({ hasIdentityMemory: !!(turnRecog.mutual || turnRecog.userKnowsCompanion || turnRecog.companionKnowsUser || turnRecog.lines?.length), recog: turnRecog })}
${formatCompanionCardRule(book, turnRecog, { companionKnowsOnly: companionRecognizedUser(turnRecog) })}
${objectiveProseRules({ userKnowsCompanion: userCanUseCompanionCard(book, turnRecog) })}
${series.isRomanceLikeGenre(book.genres) ? '【言情】在场人物（感情对象/女主若为NPC）须有实质对白并主动抛话；禁止整场哑巴戏等用户硬推。' : ''}
不要 JSON，不要写【系统】任务/警告，不要任务列表，不要替用户说话或替用户把情节目标做成。同场可带出同伴所扮之人（未认出前当普通剧中人；已认出后可按同伴关系写，当众仍演戏）；不同场勿硬凑，更不要写同伴发来手机消息。同场=${quest.together}。
${noRetell}
${noHearThoughts}
${questLock}
${castKeep}
${turnContact}
${observeHint}
${metaQuestAsk
  ? '【元问答复】用户在问本章局面是否落定：用旁白/场面暗示「尚未落定、还差哪一步」，不要开启新大事件，更不要写下一章剧情。60～180 字即可。'
  : '【留白】给反馈与新压力：剧中人阻拦、盘问、时间窗口、失手、疼痛。不要替用户完成【本章局面】未完成部分；用户写了动作不等于做成。收束时局面仍应轮到用户继续行动。涉及调查探索时：补足可观察细节与行动反馈（锁是否松动、缝里瞥见一角纸、气味变化等），禁止只重复「盒子还在那儿」；仍禁止替用户打开读完或公布答案。'}
${pressure}
【节奏】第${chapterNo}/${book.total_chapters}章：只推进本章故事节拍。
重要人物首次出场用「你脑海里突然想起来……」轻带与用户关系；次要路人不要介绍；遵守名分锁与在场表。`, routeUser, {
        maxTokens: metaQuestAsk ? 800 : 2800,
        continueRounds: metaQuestAsk ? 0 : 2,
        targetMin: metaQuestAsk ? 0 : 160,
        format: 'prose',
        emptyRetries: 1,
        apiType: 'series_play',
      });
    }
  } catch (e) {
    rollbackNewTurns();
    throw new Error(formatApiBillingError(e.message, { label: '穿越' }) || e.message || '续写失败');
  }
  body = dreamHelper.formatDreamProse(String(body || '').trim());
  if (!body) {
    rollbackNewTurns();
    throw new Error('续写为空，请重试或检查时空 API');
  }

  if (focus === 'char') {
    quest.companion_appeared = true;
    last = addProseTurn(bookId, chapterNo, 'char', body, { slack_ok: !!route.slack_ok });
    let charViol = null;
    if (route.char_offense) {
      charViol = makeViolation('char', route.char_offense.slice(0, 80), {
        muteChapter: true, shock: 'light', difficulty: 1, disguiseRounds: 1,
      });
      if (route.char_penalty) charViol.penalty = String(route.char_penalty).slice(0, 120);
    } else {
      charViol = detectViolation(body, 'char', { constraints: (book.identity_lock || {}).char?.constraints || [] });
    }
    if (charViol) commitViolation(bookId, chapterNo, quest, charViol);
    // 同伴本章禁言却仍写出对白：剥掉引号句，强制无声动作
    if (quest.effects?.char_muted_chapter && hasSpokenDialogue(body)) {
      body = String(body)
        .replace(/「[^」]*」/g, '（喉间发不出声）')
        .replace(/『[^』]*』/g, '（喉间发不出声）')
        .replace(/“[^”]*”/g, '（喉间发不出声）')
        .replace(/"[^"]*"/g, '（喉间发不出声）')
        .replace(/说[道：:]\s*[^\n。！？]{1,40}/g, '欲言又止')
        .trim();
      if (last?.id && body) {
        try {
          db.prepare(`UPDATE series_turns SET content=? WHERE id=?`).run(body, last.id);
          last.content = body;
        } catch (_) { /* ignore */ }
      }
    }
    if ((quest.effects?.char_disguise_left || 0) > 0) {
      quest.effects.char_disguise_left = Math.max(0, Number(quest.effects.char_disguise_left) - 1);
    }
  } else {
    last = addProseTurn(bookId, chapterNo, 'narration', body, { slack_ok: !!route.slack_ok });
  }
  if ((quest.effects?.user_disguise_left || 0) > 0) {
    quest.effects.user_disguise_left = Math.max(0, Number(quest.effects.user_disguise_left) - 1);
  }

  try {
    loreHelper.syncLoreAfterProse(bookId, getBook(bookId) || book, body, {
      chapterNo,
      sceneHint: cam.note || quest._scene_space || '',
    });
  } catch (_) { /* ignore */ }

  saveQuestState(ch.id, quest);
  db.prepare(`UPDATE series_chapters SET camera_note=?, user_beat=?, updated_at=datetime('now') WHERE id=?`).run(
    JSON.stringify({ note: cam.note, slack_ok: !!route.slack_ok }),
    quest.chapter || quest.main,
    ch.id,
  );

  {
    const allTurns = listTurns(bookId, chapterNo);
    db.prepare(`UPDATE series_chapters SET content=?, updated_at=datetime('now') WHERE id=?`).run(
      allTurns
        .filter((x) => ['narration', 'user', 'char', 'system'].includes(x.kind))
        .map((x) => (x.kind === 'user' ? `「（你）」${x.content}` : x.content))
        .join('\n\n'),
      ch.id,
    );
    try {
      await extractIsekaiMemories(bookId, chapterNo, allTurns, { force: false });
    } catch (_) { /* ignore */ }
    series.touchBook(bookId);
  }

  const play = getChapterPlay(bookId, chapterNo);
  return {
    turns: play.turns,
    last,
    chapter: play.chapter,
    slack_ok: !!route.slack_ok,
    quest: play.quest,
    chapter_cleared: chapterCleared,
  };
}

/** 将本章标记为 done（可跳过二次收束旁白） */
async function sealChapterDone(bookId, chapterNo, { writeEnding = false } = {}) {
  const book = getBook(bookId);
  const ch = series.getChapter(bookId, chapterNo);
  if (!ch) throw new Error('章节不存在');
  if (ch.status === 'done') return getChapterPlay(bookId, chapterNo);

  const quest = readQuestState(ch, book);
  quest.chapter_done = true;
  quest.main_done = true;

  const mlSeal = readMemoryLock(book.identity_lock);
  if (mlSeal.active && mlSeal.stage < 3) {
    mlSeal.resonance = Math.min(100, (Number(mlSeal.resonance) || 0) + 4);
    persistMemoryLock(bookId, mlSeal, book.identity_lock);
  }

  saveQuestState(ch.id, quest);

  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  const settings = series.getSettings();
  const turns = listTurns(bookId, chapterNo);

  if (writeEnding && char) {
    const isFinale = Number(chapterNo) >= Number(book.total_chapters);
    let ending = '';
    try {
      ending = await series.chatLong(settings, `${buildIsekaiBasePrompt(book, char, { chapterNo })}
${playContext(book, char, quest, { chapterNo })}
写 180～360 字章末收束正文（不要 JSON）：确认本章局面已落定，可提道具；不要复述用户已写行动。
${isFinale
    ? '【终章】正式收束全书，并公布用户与同伴的真身份落点（须与身份锁一致）；点明用户全书主线是否落到结局。可以写清谁是真凶/女主等，这是唯一允许系统侧揭晓的时机。'
    : '【硬性】只收束本章当前场面；禁止开启下一章剧情、新地点大事件或新局面。最多留一句气氛余韵，不要写「随后你们去…」。'}`,
      `章大纲：${ch.outline}\n${CHAPTER_SCENE_LABEL}：${quest.chapter || quest.main}\n回合：\n${recentTurnsText(turns, 14)}`, {
        maxTokens: 1000, continueRounds: 1, targetMin: 0, format: 'prose',
        apiType: 'series_play',
      });
      ending = dreamHelper.formatDreamProse(String(ending || '').trim());
    } catch (_) { /* optional */ }
    if (ending) addProseTurn(bookId, chapterNo, 'narration', ending, { type: isFinale ? 'finale' : 'ending' });
  }

  const hasClearNotice = listTurns(bookId, chapterNo).some((t) => {
    const m = t.meta && typeof t.meta === 'object' ? t.meta : {};
    return t.kind === 'system' && (m.type === 'chapter_clear' || /本章剧情已完成/.test(t.content || ''));
  });
  if (!hasClearNotice) {
    addTurn(
      bookId,
      chapterNo,
      'system',
      Number(chapterNo) >= Number(book.total_chapters)
        ? '【系统】本章剧情已完成。全书章节已走完；真身份已于终章揭晓，可返回查看。'
        : '【系统】本章剧情已完成，请进入下一章节。',
      { type: 'chapter_clear' },
    );
  }

  const finalTurns = listTurns(bookId, chapterNo);
  try {
    await extractIsekaiMemories(bookId, chapterNo, finalTurns, { force: true });
    if (char) {
      // 章末总结：剧情（可见）+ 道具快照 + 角色记忆（隐形）
      const sumRaw = await series.chatLong(settings, `你是穿越章节总结官。根据回合写章末总结，只输出 JSON：
{"plot":"300字内剧情回顾，事实客观，含人物互动与场面，不剧透真身份标签","where":"收束时地点（须与最后几回合现场一致）","who":"收束时在场人物（顿号分隔）","leftover":"若用户末回合正在做某件事（端茶/跪着/被按住等）且未收住，写明这一拍余波；主拍已落定则写下一拍入口","char_mem":"120字内同伴/人物关系与态度，供下章模型用","threads":["进行中的副线1","…"],"foreshadow":["伏笔1"],"relationship":"关系变化一句","inventory_note":"道具去向一句，可空"}
禁止写 true_kind/真凶揭晓。
leftover：不要把 leftover 写成下一章全新主线；须忠实最后现场。`,
        `第${chapterNo}章「${ch.title}」局面：${quest.chapter || ''}\n道具：${inventoryText(quest)}\n回合：\n${recentTurnsText(finalTurns, 22)}`, {
          maxTokens: 1100, continueRounds: 0, format: 'json', emptyRetries: 0,
          apiType: 'series_outline',
        });
      const sumObj = series.extractJsonObject(sumRaw) || {};
      const plotSum = String(sumObj.plot || '').trim().slice(0, 800)
        || `这一幕已落定：${String(quest.chapter || '').slice(0, 80)}`;
      const charMem = String(sumObj.char_mem || '').trim().slice(0, 400);
      const whereSum = String(sumObj.where || '').trim().slice(0, 80);
      const whoSum = String(sumObj.who || '').trim().slice(0, 120);
      const leftoverSum = String(sumObj.leftover || '').trim().slice(0, 300);
      const threadsSum = (Array.isArray(sumObj.threads) ? sumObj.threads : [])
        .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8);
      const foreshadowSum = (Array.isArray(sumObj.foreshadow) ? sumObj.foreshadow : [])
        .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
      const relationshipSum = String(sumObj.relationship || '').trim().slice(0, 200);
      quest.recap = {
        plot: plotSum,
        inventory: Array.isArray(quest.inventory) ? quest.inventory.map((it) => ({ ...it })) : [],
        char_mem: charMem,
        where: whereSum,
        who: whoSum,
        leftover: leftoverSum,
        threads: threadsSum,
        foreshadow: foreshadowSum,
        relationship: relationshipSum,
      };
      quest.threads = mergeThreads(quest.threads, threadsSum);
      saveQuestState(ch.id, quest);
      for (const f of [plotSum].filter(Boolean).slice(0, 1)) {
        insertMemory(bookId, chapterNo, f, 'plot', 0);
      }
      if (leftoverSum) insertMemory(bookId, chapterNo, `未完：${leftoverSum}`, 'plot', 0);
      if (charMem) insertMemory(bookId, chapterNo, charMem, 'char', 0);
      for (const f of threadsSum.slice(0, 3)) insertMemory(bookId, chapterNo, `线：${f}`, 'plot', 0);

      // 用户可见的章末总结卡
      const invLine = (quest.inventory || []).map((it) => it.name).filter(Boolean).join('、') || '（无）';
      const recapExtra = [
        whereSum ? `地点：${whereSum}` : '',
        whoSum ? `在场：${whoSum}` : '',
        leftoverSum ? `未完局面：${leftoverSum}` : '',
        threadsSum.length ? `进行中的线：${threadsSum.join('；')}` : '',
      ].filter(Boolean).join('\n');
      addTurn(bookId, chapterNo, 'system', `【本章总结】\n剧情：${plotSum}${recapExtra ? `\n${recapExtra}` : ''}\n随身道具：${invLine}`, {
        type: 'chapter_recap',
      });
      persistCrossingRecognition(bookId, chapterNo, inferRecognitionFromText(
        [plotSum, leftoverSum, charMem, lastPlaySceneText(bookId, chapterNo, 4)].filter(Boolean).join('\n'),
        {
          companionName: book.char_role || book.identity_lock?.char?.surface_name || '',
          userRole: book.user_role || book.identity_lock?.user?.surface_name || '',
        },
      ));
    }
  } catch (_) { /* ignore */ }
  try {
    persistCrossingRecognition(bookId, chapterNo, inferRecognitionFromText(
      lastPlaySceneText(bookId, chapterNo, 6),
      {
        companionName: book.char_role || book.identity_lock?.char?.surface_name || '',
        userRole: book.user_role || book.identity_lock?.user?.surface_name || '',
      },
    ));
  } catch (_) { /* ignore */ }

  const allNar = listTurns(bookId, chapterNo)
    .filter((x) => ['narration', 'user', 'char', 'system'].includes(x.kind))
    .map((x) => x.content)
    .join('\n\n');
  db.prepare(`
    UPDATE series_chapters SET status='done', content=?, updated_at=datetime('now') WHERE id=?
  `).run(allNar, ch.id);

  const doneN = db.prepare(
    `SELECT COUNT(*) as n FROM series_chapters WHERE book_id=? AND status='done'`
  ).get(bookId)?.n || 0;
  const bookCleared = doneN >= book.total_chapters;
  if (bookCleared) {
    db.prepare(`UPDATE series_books SET status='done', updated_at=datetime('now') WHERE id=?`).run(bookId);
    // 全书通关奖励：纪念道具 + 系统通关卡（一次）
    try {
      const fresh = readQuestState(ch, book);
      fresh.book_main_done = true;
      fresh.chapter_done = true;
      fresh.main_done = true;
      const memoName = `《${String(book.title || '穿越本').trim().slice(0, 24)}》通关纪念`;
      if (!Array.isArray(fresh.inventory)) fresh.inventory = [];
      if (!fresh.inventory.some((it) => String(it?.name || '') === memoName || it?.kind === 'book_clear')) {
        fresh.inventory.push({
          name: memoName,
          desc: '全书通关信物：你们一起走完了这本剧本',
          kind: 'book_clear',
        });
      }
      if (fresh.recap && typeof fresh.recap === 'object') {
        fresh.recap.inventory = fresh.inventory.map((it) => ({ ...it }));
      }
      saveQuestState(ch.id, fresh);

      const hasBookClear = listTurns(bookId, chapterNo).some((t) => {
        const m = t.meta && typeof t.meta === 'object' ? t.meta : {};
        return t.kind === 'system' && (m.type === 'book_clear' || /全书通关/.test(t.content || ''));
      });
      if (!hasBookClear) {
        const userId = String(book.identity_lock?.user?.surface_name || book.user_role || '你').trim();
        const charId = String(book.identity_lock?.char?.surface_name || book.char_role || '同伴').trim();
        const userKind = String(book.identity_lock?.user?.true_kind || '').trim();
        const charKind = String(book.identity_lock?.char?.true_kind || '').trim();
        const kindLine = (userKind || charKind)
          ? `\n真身份落点：你＝${userId}${userKind ? `（${userKind}）` : ''}；同伴＝${charId}${charKind ? `（${charKind}）` : ''}`
          : '';
        const mainLine = String(fresh.book_main || book.book_main_quest || '').trim();
        addTurn(
          bookId,
          chapterNo,
          'system',
          `【全书通关】\n恭喜——你们走完了《${String(book.title || '').trim() || '这本穿越'}》全部 ${book.total_chapters} 章。\n奖励：获得「${memoName}」。${mainLine ? `\n全书主线：${mainLine}` : ''}${kindLine}\n可返回目录回顾各章；若要重玩请新建穿越本。`,
          { type: 'book_clear', reward: memoName },
        );
      }
    } catch (e) {
      console.warn('[isekai] book clear reward', e.message);
    }
  } else {
    series.touchBook(bookId);
  }
  return getChapterPlay(bookId, chapterNo);
}

/** 只重生成某一张剧情/角色卡，不影响其它回合 */
async function regenerateTurn(bookId, chapterNo, turnId) {
  const book = getBook(bookId);
  assignedOrThrow(book);
  purgeSituationTurns(bookId);
  const ch = series.getChapter(bookId, chapterNo);
  if (!ch) throw new Error('章节不存在');
  if (ch.status === 'done') throw new Error('本章已完成，不能重生成');

  const turn = db.prepare(
    `SELECT * FROM series_turns WHERE id=? AND book_id=? AND chapter_no=?`
  ).get(turnId, bookId, chapterNo);
  if (!turn) throw new Error('卡片不存在');
  if (!['narration', 'char', 'whisper_char'].includes(turn.kind)) {
    throw new Error('只能重生成「剧情」或「角色」卡片');
  }

  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const settings = series.getSettings();
  const quest = readQuestState(ch, book);
  if (turn.kind === 'whisper_char' && !quest.companion_appeared) {
    throw new Error('同伴尚未出场，不能生成远程摸鱼消息');
  }
  const all = listTurns(bookId, chapterNo);
  const before = all.filter((t) => Number(t.id) < Number(turnId));
  const cam = parseCameraField(ch.camera_note);
  const base = `${buildIsekaiBasePrompt(book, char, { chapterNo })}\n${playContext(book, char, quest)}`;
  const regenRecog = parseCrossingRecognition(bookId, {
    companionName: book.char_role || '',
    userRole: book.user_role || '',
    book,
  });
  // 用户未认出前：旧同伴卡重生成时并入剧情卡，避免卡面继续泄题
  let regenKind = turn.kind;
  if (regenKind === 'char' && !userCanUseCompanionCard(book, regenRecog)) {
    regenKind = 'narration';
  }
  const ctx = `《${book.title}》第${chapterNo}章「${ch.title}」
大纲：${ch.outline}
本章局面：${quest.chapter || quest.main}
同场：${quest.together}；镜头：${cam.note || '未知'}
此前回合：
${recentTurnsText(before, 12)}

请重写下方这张卡片的内容（替换原卡，不要复述整章）。原卡预览：${String(turn.content || '').slice(0, 160)}`;

  let body = '';
  try {
    if (regenKind === 'narration') {
      body = await series.chatLong(settings, `${base}
【重生成·剧情卡】只输出现场旁白/他人镜头 300～700 字，写完整收束。
${mutualRecognitionRules({ recog: regenRecog })}
【用户心声】心声他人听不见；旁白禁止写破或暗示。只对可感知对白与动作给反馈。
${formatCompanionCardRule(book, regenRecog)}
不要 JSON，不要【系统】任务/警告，不要替用户说话/代做行动，不要替用户把【本章局面】情节目标做成，不要重复历史回合；停在轮到用户行动处。用户写的是尝试，尝试≠成功。${contactBanText(quest)} ${worldPressureRules({ quest, recog: regenRecog, book })} 若涉及调查探索物件，补可观察细节，勿空点名，也勿替用户揭晓答案。`, ctx, {
        maxTokens: 2800, continueRounds: 4, targetMin: 160, format: 'prose', emptyRetries: 1,
      });
    } else {
      body = await series.chatLong(settings, `${base}
【重生成·同伴卡·现场】只输出同伴「${book.char_role}」现场言行 280～700 字，真性格演身份，写完整收束。对白跟性格走，像现实里真人当面说话：自然好懂，别文绉绉。
${mutualRecognitionRules({ recog: regenRecog })}
【用户心声】心声他人听不见；禁止像听见心里话一样接话或变态度。
按这个人会做的来：未认出前只按剧中人互动；有反常依据后再暗助/投机/拦笨办法。当着原住民禁止谈剧本结局/系统任务。不要当局外人。不要 JSON，不要手机短信体，${contactBanText(quest)} ${worldPressureRules({ quest, recog: regenRecog, book })} 不要用户台词，不要【系统】，不要替用户把情节目标做成，不要重复历史回合。`, ctx, {
        maxTokens: 2200, continueRounds: 4, targetMin: 160, format: 'prose', emptyRetries: 1,
      });
    }
  } catch (e) {
    throw new Error(formatApiBillingError(e.message, { label: '重生成' }) || e.message || '重生成失败');
  }
  body = dreamHelper.formatDreamProse(String(body || '').trim());
  const split = extractSystemPanelsFromProse(body);
  body = split.prose;
  if (!body) throw new Error('重生成内容为空，请重试');

  let meta = {};
  try { meta = typeof turn.meta === 'string' ? JSON.parse(turn.meta || '{}') : (turn.meta || {}); } catch { meta = {}; }
  meta.regenerated_at = Date.now();

  db.prepare(
    `UPDATE series_turns SET kind=?, content=?, meta=? WHERE id=?`
  ).run(regenKind, body, JSON.stringify(meta), turnId);

  for (const p of split.panels) {
    if (p.type === 'situation') continue;
    if (p.type === 'warn') {
      addTurn(bookId, chapterNo, 'system', p.content, { type: 'warn' });
    }
  }

  // 角色卡后若紧跟一条系统警告，先清掉再按新内容重检
  if (regenKind === 'char' || regenKind === 'whisper_char') {
    const next = all.find((t) => Number(t.id) > Number(turnId));
    if (next && next.kind === 'system' && (next.meta?.type === 'warn' || /系统警告/.test(next.content || ''))) {
      try { db.prepare('DELETE FROM series_turns WHERE id=?').run(next.id); } catch (_) {}
    }
    const viol = detectViolation(body, 'char');
    if (viol) {
      commitViolation(bookId, chapterNo, quest, viol);
      saveQuestState(ch.id, quest);
    }
  }

  series.touchBook(bookId);
  const updated = db.prepare('SELECT * FROM series_turns WHERE id=?').get(turnId);
  const play = getChapterPlay(bookId, chapterNo);
  return {
    turn: {
      ...updated,
      meta: series.parseJson(updated.meta, {}),
    },
    turns: play.turns,
    chapter: play.chapter,
    quest: play.quest,
  };
}

async function finishChapterPlay(bookId, chapterNo) {
  const book = getBook(bookId);
  const ch = series.getChapter(bookId, chapterNo);
  if (!ch) throw new Error('章节不存在');
  if (ch.status === 'done') return getChapterPlay(bookId, chapterNo);

  const quest = readQuestState(ch, book);
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  const settings = series.getSettings();
  const turns = listTurns(bookId, chapterNo);
  const isFinale = Number(chapterNo) >= Number(book.total_chapters);
  const userTurns = turns.filter((t) => t.kind === 'user' || t.kind === 'whisper_user').length;
  const storyTurns = turns.filter((t) => t.kind === 'narration' || t.kind === 'char').length;
  const floor = chapterEngagementFloor(book);

  if (!meetsChapterEngagement(book, turns) && !isFinale) {
    throw new Error(`本章互动还偏少（中篇建议至少 ${floor.minUser} 轮你的行动、${floor.minStory} 轮场面来回后再完章；当前 ${userTurns}/${floor.minUser} 行动，${storyTurns}/${floor.minStory} 场面）。`);
  }

  // 本章任务未标记完成时，再裁定一次
  if (!quest.chapter_done) {
    try {
      const mysteryJudge = series.isMysteryLikeGenre(book.genres)
        ? '悬疑类：看本章情节目标是否落地（搜证/对质等局面是否出现）；不要求在本章就点名真凶，除非任务本身就是指认。'
        : series.isHorrorGenre(book.genres)
          ? '恐怖类：看本章求生/逃离/撑过等情节目标是否落地；不要用「有没有找到破局」来卡过章。'
          : series.isInfiniteGenre(book.genres)
            ? '无限流：看本章关卡/规则应对的情节目标是否落地；不要套悬疑破案标准。'
            : '';
      const finaleJudge = isFinale
        ? `【终章】这是第${chapterNo}/${book.total_chapters}章（最后一章）。用户已主动点「完成本章」。
- 只裁定【本章情节目标】是否基本落地或终局场面是否已展开；不要用「全书主线是否完美/真凶是否点名完美」否决。
- book_main_done 可另标，但不得因 book_main_done=false 而把 quest_done/chapter_done 打成 false。
- 已有实质互动、接近收束时，倾向 quest_done=true、chapter_done=true。`
        : '';
      const raw = await series.chatLong(settings, `${buildIsekaiBasePrompt(book, char, { chapterNo })}
${playContext(book, char, quest)}
判断本章是否可过章。只输出 JSON：{"quest_done":true|false,"beat_closed":true|false,"chapter_done":true|false,"book_main_done":false,"reason":"一句话"}
规则：quest_done=【本章锁定节拍/本章局面】对应的情节局面是否已在剧情中出现/落地（例：局面「让林宛与沈川产生误会」→误会场面是否已发生）。怎么达成的不限；用户空喊完成但场面未出现 → false。认出同伴、互认摊牌 ≠ 过章（除非本章节拍本身就是认人）。
beat_closed=本章场面是否已可收束（不必苛求完美落幕）。
手动点「完成本章」时：须 quest_done=true 且互动量达标；beat_closed 仅作参考，不要因「还能再演两句」而否决。
须对照引擎完整大纲，禁止为过章改写已锁定设定。
禁止为让玩家爽过章而放水；场面未出现、互动过少 → quest_done=false。
${mysteryJudge}
${finaleJudge}`,
      `本章局面（锁定节拍的玩家版）：${quest.chapter || quest.main}\n本章锁定节拍：${resolveChapterStoryBeat(book, chapterNo, ch)}\n本章大纲：${ch.outline || ''}\n全书主线：${quest.book_main || book.book_main_quest || ''}\n认出同伴不算过章。\n回合：\n${recentTurnsText(turns, 16)}`, {
        maxTokens: 220, continueRounds: 0, format: 'json', emptyRetries: 1,
      });
      const o = series.extractJsonObject(raw);
      if (o) {
        const questDone = o.quest_done === true || o.quest_done === 1 || o.quest_done === 'true'
          || o.main_done === true || o.main_done === 1 || o.main_done === 'true';
        const beatClosed = o.beat_closed === true || o.beat_closed === 1 || o.beat_closed === 'true';
        const chapterFlag = o.chapter_done === true || o.chapter_done === 1 || o.chapter_done === 'true';
        // 手动完章：任务实质完成即可；不因 beat_closed 卡死
        let ok = questDone || chapterFlag;
        if (!ok && o.quest_done == null && o.beat_closed != null) ok = beatClosed;
        if (ok) {
          quest.chapter_done = true;
          quest.main_done = true;
        }
        if (o.book_main_done === true || o.book_main_done === 1 || o.book_main_done === 'true') {
          quest.book_main_done = true;
        }
      }
    } catch (_) { /* keep */ }
  }

  // 终章兜底：用户主动完章 + 已有实质互动 → 勿被「全书主线未完美」卡死
  if (!quest.chapter_done && isFinale && userTurns >= 1 && storyTurns >= 1) {
    quest.chapter_done = true;
    quest.main_done = true;
  }

  if (!quest.chapter_done) {
    throw new Error(isFinale
      ? '终章任务尚未推进到位。请再完成一点本章关键行动后，再点「完成本章」。'
      : '本章局面尚未落定，无法通关。请继续推进这一幕后再点「完成本章」。');
  }

  if (isFinale) quest.book_main_done = true;

  saveQuestState(ch.id, quest);
  // 手动完章：若最后一张剧情/同伴卡就是本回合刚写的，不再叠收束；否则补短收束
  const lastNar = [...turns].reverse().find((t) => t.kind === 'narration' || t.kind === 'char');
  const lastId = lastNar ? Number(lastNar.id) : 0;
  const maxId = turns.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  const justCleared = lastNar && lastId >= maxId - 1;
  // 终章：尽量写揭晓收束（即使刚有正文，也补终章收束更稳）
  return sealChapterDone(bookId, chapterNo, { writeEnding: isFinale || !justCleared });
}


module.exports = {
  generateScriptOutline,
  beginTransmigrate,
  startChapterPlay,
  getChapterPlay,
  userPlayTurn,
  rollbackPlayTurnAi,
  regenerateTurn,
  finishChapterPlay,
  listTurns,
  setStorySource,
  setStorySourceFromFile,
  listCollectionStories,
  listBookWarnTurns,
};

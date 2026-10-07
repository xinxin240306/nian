/** 剧集：平行世界长篇小说连载（仅用角色性格+外貌，记忆隔离） */
const db = require('./db');
const { callChatAPIComplete, formatApiBillingError, resolveTaskApiCreds } = require('./api-helper');
const dreamHelper = require('./dream-helper');

const LENGTH_CHAPTERS = { flash: 4, short: 8, medium: 20, long: 40 };
const LENGTH_LABELS = { flash: '极短', short: '短篇', medium: '中篇', long: '长篇' };

const GENRE_OPTIONS = [
  { key: 'mystery', label: '悬疑推理' },
  { key: 'romance', label: '言情' },
  { key: 'sweet', label: '甜宠' },
  { key: 'angst', label: '虐恋' },
  { key: 'horror', label: '恐怖' },
  { key: 'folklore', label: '志怪神话' },
  { key: 'infinite', label: '无限流' },
  { key: 'apocalypse', label: '末日求生' },
  { key: 'urban', label: '都市' },
  { key: 'workplace', label: '职场商战' },
  { key: 'entertainment', label: '娱乐圈' },
  { key: 'family', label: '豪门世家' },
  { key: 'palace', label: '宫斗权谋' },
  { key: 'historical', label: '历史权谋' },
  { key: 'wuxia', label: '武侠仙侠' },
  { key: 'farming', label: '种田经营' },
  { key: 'rebirth', label: '重生逆袭' },
  { key: 'ability', label: '异能超能' },
  { key: 'campus', label: '校园' },
  { key: 'medical', label: '医疗职场' },
  { key: 'spy', label: '谍战' },
  { key: 'adventure', label: '探险冒险' },
  { key: 'revenge', label: '复仇爽文' },
  { key: 'healing', label: '治愈日常' },
  { key: 'abnormal', label: '病娇/偏执' },
  { key: 'scifi', label: '科幻' },
  { key: 'steampunk', label: '蒸汽朋克' },
  { key: 'fantasy', label: '奇幻魔法' },
  { key: 'thriller', label: '惊悚犯罪' },
  { key: 'custom', label: '自定义' },
];

/** 类型写作指引（尤其肉文要写清楚，避免模型当聊天 NSFW 去「克制」） */
const GENRE_RULES = {
  mystery: '悬疑推理：线索、误导、真相揭示要可回溯；少靠灵异糊弄。公开大纲/梗概只写悬念与调查推进，不写凶手与完整答案。',
  romance: '言情：以感情线为核心，拉扯与心动为主；不写露骨性爱（亲吻拥抱可有）。感情戏靠对白与互动推进，男主/感情对象须主动抛话接话，勿干等女主/用户硬推；女主若为剧中NPC须有实质台词与态度。主线场景要多样，禁止默认亡国公主复国。',
  sweet: '甜宠：互动偏甜、偏陪伴与宠溺，冲突点到为止，少虐心长痛。宠溺与拌嘴都要落到对白，对方主动开口，勿整场沉默等用户填空。',
  angst: '虐恋：误会、错位与拉扯要疼，但人物动机仍自洽；收束须有情感落点，忌无意义反复虐。拉扯靠对白交锋与质问，双方都要开口，勿只写气氛让用户单方面推进。疼点来自立场/谎言/任务冲突，禁止只会「复国二选一殉情」。',
  romance_nsfw: '言情（可肉）：主线仍是感情与人物关系；情节需要时可写完整、具体的性爱场面（前戏、身体反应、交合过程可直白），但不要章章只有床戏、不要丢掉感情推进。床戏前后仍须有对白与情感互动，对方主动。',
  nsfw: '纯肉文：以情欲与性爱为主菜。每章应有明确情欲推进或完整床戏；允许并鼓励露骨描写（身体部位、动作、触感、体液、高潮等直白书写），剧情只为欲望张力与场景服务；不要用「一夜过去」「事后」跳过关键过程，不要写成清水言情。',
  horror: '恐怖：压迫感、未知与身体/心理恐惧；气氛优先于解释。可以始终不解释、不破案、不破局——求生/逃离/撑过险境即可。公开大纲不剧透实体真身（若有）。',
  folklore: '志怪神话：鬼狐神怪、因果报应与民间传说气质；超自然规则要前后一致，忌现代硬科幻解释。',
  infinite: '无限流：副本/关卡/规则怪谈结构；生存与通关压力为主，解密为辅。公开大纲不剧透通关公式与最终规则漏洞。',
  apocalypse: '末日求生：资源、信任与生存压力优先；秩序崩坏后的人性与协作冲突要落地，忌无脑开挂横推。',
  urban: '都市：当代生活质感、职场或社会关系冲突真实可感。',
  workplace: '职场商战：项目、利益、上下级与竞品博弈要具体；胜负有铺垫，忌空喊励志。',
  entertainment: '娱乐圈：通告、舆情、资源与人设压力真实；镜头前后反差可有，忌无脑一路爆红。',
  family: '豪门世家：继承、联姻、旁支与舆论压力；规矩与利害要写清，对话藏机锋。',
  palace: '宫斗权谋：人与人的恩宠、站队、名节与权柄之争；对话暗藏机锋。后宫戏写宫斗（位份、子嗣、圣宠），前朝戏写权谋（相位、军权、党争）——按背景择一或交织，但主轴始终是人情博弈，不是刑侦探案。查案最多作插曲，禁止当全书发动机。若实为宅斗/内宅，主战场在侯府伯府嫡庶后宅。',
  historical: '历史权谋：朝堂/军政/世家之间的利益与站队博弈；制度与称谓忌穿帮。主线须具体到某一局（科举、清党、通商、储位、军功等），写清谁压谁、谁翻盘，禁止万能「复国」模板，禁止把权谋写成连环查案。',
  wuxia: '武侠仙侠：江湖/修真规矩、招式与因果分明，避免现代口语穿帮。',
  farming: '种田经营：生产、经营与人际互助要具体可感；成长靠积累，忌一夜暴富开挂。',
  rebirth: '重生逆袭：信息差与改命布局要合理；打脸有铺垫，忌全知开挂碾压所有人。',
  ability: '异能超能：能力边界与代价要前后一致；冲突围绕能力规则展开，忌无限升级无约束。',
  campus: '校园：年龄感、同学关系与青春张力；勿写成社会油腻腔。',
  medical: '医疗职场：病例、值班与责任压力要专业可信；救人戏有步骤，忌神仙医术秒愈。',
  spy: '谍战：身份伪装、情报交换与信任崩塌；危险感持续，忌一上来全盘揭露。',
  adventure: '探险冒险：未知地带、补给与同伴协作；发现与险境交替，地图/线索要可跟。',
  revenge: '复仇爽文：布局反击要解气，打脸有铺垫，忌无脑开挂。',
  healing: '治愈日常：节奏舒缓，细节温暖，冲突点到为止。',
  abnormal: '病娇/偏执：占有与失控感要立得住，但人物动机仍要自洽。',
  scifi: '科幻：设定规则一致，技术/社会推演说得通。',
  steampunk: '蒸汽朋克：机械、蒸汽与阶级社会质感统一；发明有代价，忌现代电子产品乱入。',
  fantasy: '奇幻魔法：魔法体系或种族规则前后一致。',
  thriller: '惊悚犯罪：危险逼近感、追查与反杀节奏紧。公开大纲/梗概不点明主谋与收网关键。',
};

/** 大纲防套路：避免言情/宫斗/权谋总塌成「亡国公主复国」 */
const PLOT_DIVERSITY_HOOKS = {
  palace: [
    '选秀入宫的小门第女官，卷进两派储位情报战',
    '太后身边的女史发现先帝遗诏被人调包',
    '边镇和亲的公主其实是替身，原公主还在京中',
    '冷宫废妃被政敌利用，借她翻盘夺权',
    '新帝登基后清洗外戚，女主是被点名的外戚旁支',
    '宫宴联姻局，双方都在替家族刺探',
    '女官掌尚衣局账册，发现军饷被挪进后宫工程',
    '贵妃与皇后争协理六宫之权，借赏花宴立威',
    '尚仪司女官发现寿宴仪注被人改了座次',
    '御药房学习的医女，被两宫同时点名问诊',
    '宫女替主子藏私信，信却落到对家宫妃手里',
    '新帝选秀名册少了一房外戚的女儿，当场翻脸',
  ],
  historical: [
    '科举放榜夜爆出替考案，牵连半个部堂',
    '边军缺饷哗变前夜，监军要在三日里压住火线',
    '商路被世家垄断，新晋盐商联手破局',
    '清党名单提前泄露，被点名的人要反制诬告',
    '和谈使者被扣，必须带着假情报活着回去',
    '储君夺嫡公开化，史官要决定记哪一版「真相」',
    '黄河决口问责，工部官员与地方官互甩锅',
    '通商开埠谈判桌上，翻译握着能改条约的一字之差',
  ],
  angst: [
    '青梅竹马各为其主，必须在同一局棋里互挖墙脚',
    '一方为保对方撒谎成仇，真相晚到却改不回已做的伤害',
    '联姻是假、任务是真，假夫妻在任务里动了真情却不能说',
    '救命恩人其实是仇家余党，知情后仍要并肩撑过危局',
    '一方选择「成全」却做成二次伤害，另一方要决定是否原谅',
    '旧案翻供当晚，证人与审讯者发现彼此是旧爱',
    '战争停火日重逢，两人曾互相以为对方已死',
    '为救第三人不得不牺牲对方名誉，事后无法解释',
  ],
  romance: [
    '对家律所/对家商行的谈判桌上日久生情',
    '同住合租却各怀秘密项目，被迫合伙才能过关',
    '前任婚礼上当伴郎伴娘，连环乌龙把人推回一起',
    '互相讨厌的同事被派去外地出差一周',
    '笔友/匿名电台主播线下相认，人设对不上号',
    '家族联姻对象是死对头，要演恩爱给长辈看',
    '救人后被缠上的「麻烦精」其实握着她缺的线索',
    '旧同学同学会上重逢，当年错位告白的真相浮出',
  ],
  romance_ancient: [
    '家族联姻对象是死对头，要演恩爱给长辈看',
    '上元灯会认错人，面具摘下来才发现是世仇家的',
    '她替兄长走入赘协议，协议外动了真情',
    '同窗书友京中重逢，当年未说出口的话被第三人捅破',
    '救人后被缠上的「麻烦精」其实握着她缺的婚书',
    '对家商行的货船上被迫同行三日',
    '替嫁当晚原定新娘逃走，两人要演到拜堂结束',
    '诗会唱和成了把柄，两边家长逼着给名分',
  ],
  farming: [
    '开春分地，旁支抢了她名下那块水田',
    '新开的豆腐坊被对家散谣说用了脏水',
    '村里修渠要占地，她得在族里争到水口',
    '丰收年被强派纳贡，要靠经营把缺口补上',
  ],
  wuxia: [
    '同门比武点名对上，输了要被赶出山门',
    '商队护卫路上发现镖旗被人掉了包',
    '旧伤复发当夜，仇家余党找上门讨债',
    '门规逼她联姻外派，她要在三日里找到抗命的名目',
  ],
  family: [
    '遗嘱公开日，旁支被指定继承但附带苛刻条件',
    '联姻宴上爆出私生子女认亲',
    '族产被掏空，小辈要在长辈眼皮底下查账',
    '嫡庶之争不是夺权而是争夺「谁能离开这座宅子」',
    '族规逼婚，当事人联手找合法漏洞脱身',
    '家主昏迷，代理掌权者与真继承人互相掣肘',
  ],
  palace_domestic: [
    '嫡母寿宴上分桌，庶女发现座次与庚帖被人调换',
    '老夫人病中赏簪，各房嬷嬷争管家权与对牌',
    '庶女嫁妆单少了一间铺子，要在内宅查清谁动的账',
    '表哥来提亲，各房借机塞人、换媒、毁名节',
    '主母借「学规矩」之名罚跪，实为逼交库房钥匙',
    '妾室生子，正房与侧室在族谱序齿上暗中较劲',
    '府里闹鬼传言，其实是有人借鬼神夺管事权',
    '赏花宴上摔碎御赐瓷，各房互相指认要背锅',
  ],
  palace_harem: [
    '新入宫的秀女被分到皇后阵营，却意外得宠引贵妃忌惮',
    '太后寿宴上位份座次被人做手脚，当众失了体面',
    '皇子坠马风波，各宫争相「照料」实则争抚养权',
    '敬事房记档被人篡改，恩宠夜变成栽赃名节的刀',
    '宫女攀高枝告密，引发两宫太监体系互咬',
    '选秀前夜秀女名册被换，背后是两派外戚抢联姻',
  ],
  palace_ministerial: [
    '科举舞弊案爆发，主考官与宰相门生互相甩锅',
    '户部亏空案上朝，女主家被迫在清流与权臣间站队',
    '边关大捷后封赏名单少了一脉，引发军功派反弹',
    '和亲使团出发前夜，礼部与兵部为随行人员撕破脸',
    '御史台连折弹劾，宰相借联姻局反将东宫一军',
    '漕运改道触动江南世家利益，朝堂分成两派清算',
  ],
  revenge: [
    '被诬贪腐的人用公开听证会翻案，而不是私刑复仇',
    '商业窃密反杀：用合法合规把对手逼到悬崖',
    '校园/职场霸凌证据链，靠程序正义而不是血债血偿',
    '替父洗冤却发现父亲并非全白，要决定公开到哪一步',
  ],
};

function hashSeed(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 钩子是否偏刑侦探案/抄家审讯（言情宅斗等非悬疑类型应过滤） */
function isInvestigationHook(text) {
  return isCrimeProcedureHook(text);
}

/** 刑侦/抄家/坐牢/追缴证物式钩子 */
function isCrimeProcedureHook(text) {
  return /投毒|真凶|揪出|查案|破案|缉凶|大理寺|连环.*案|凶手|刑侦|侦探|验尸|审案|抄家|查封|入(?:了)?狱|坐牢|关押|审讯|审问|诏狱|天牢|顺天府|赃物|追缴|逼供|缉拿|下狱|收监|对质交|交出.*证|夺证|衙(?:门|役)|官兵围|钦差拿人/.test(String(text || ''));
}

/** 是否偏宅斗内宅（侯府伯府嫡庶），而非皇宫前朝刑侦 */
function isPalaceDomesticStory(bookOrGenres, genresCustom = '', era = '') {
  return resolveIntrigueBoard(bookOrGenres, genresCustom, era) === 'domestic';
}

/** 宫斗/权谋/宅斗盘面：harem | ministerial | domestic | mixed | '' */
function resolveIntrigueBoard(bookOrGenres, genresCustom = '', era = '') {
  const gs = Array.isArray(bookOrGenres) ? bookOrGenres : (bookOrGenres?.genres || []);
  const custom = String(genresCustom || bookOrGenres?.genres_custom || '').trim();
  const eraText = String(era || bookOrGenres?.era || bookOrGenres?.era_custom || '').trim();
  let boardAnswer = '';
  if (bookOrGenres && typeof bookOrGenres === 'object') {
    try {
      const brief = typeof bookOrGenres.story_brief === 'string'
        ? JSON.parse(bookOrGenres.story_brief)
        : bookOrGenres.story_brief;
      boardAnswer = String(brief?.answers?.palace_board || '').trim();
    } catch (_) { /* ignore */ }
  }
  if (/侯府宅斗|宅斗/.test(boardAnswer)) return 'domestic';
  if (/朝堂权谋/.test(boardAnswer) && !/交织/.test(boardAnswer)) return 'ministerial';
  if (/后宫宫斗/.test(boardAnswer) && !/交织/.test(boardAnswer)) return 'harem';
  if (/交织/.test(boardAnswer)) return 'mixed';
  const blob = `${custom} ${eraText}`;
  const hasPalace = gs.includes('palace') || /皇宫|后宫|宫斗|架空王朝/.test(blob);
  const hasHist = gs.includes('historical') || /朝堂|权臣|军政|前朝/.test(blob);
  const hasFamily = gs.includes('family');
  if (/宅斗|内宅|后宅|侯府|伯府|将军府|尚书府|嫡庶|闺阁|深宅/.test(blob)) return 'domestic';
  if (hasFamily && (hasPalace || hasHist || gs.includes('romance') || gs.includes('sweet') || gs.includes('angst'))) {
    return 'domestic';
  }
  if (hasPalace && /府|宅|内宅|侯|伯|世家|闺/.test(blob) && !/宫|皇宫|后宫|前朝|朝堂|殿/.test(blob)) {
    return 'domestic';
  }
  if (/后宫|选秀|妃嫔|贵妃|皇后|六宫|位份|圣宠/.test(blob) && !/朝堂|权臣|前朝/.test(blob)) return 'harem';
  if (/朝堂|权臣|前朝|相位|清党|储位|军权/.test(blob) && !/后宫|选秀|妃嫔/.test(blob)) return 'ministerial';
  if (hasPalace && hasHist) return 'mixed';
  if (hasPalace) return 'harem';
  if (hasHist) return 'ministerial';
  return '';
}

function intrigueBeatFallback(board) {
  if (board === 'domestic') return '内宅突发风波，各房借人情与规矩争管家权、名节或亲事筹码。';
  if (board === 'ministerial') return '朝堂上两派为名分与利害当众较劲，须当场站队或反制。';
  if (board === 'mixed') return '宫中人情与朝堂站队绞在一处，须借一场公开局面换筹码。';
  return '后宫位份与恩宠之争公开化，须当场稳住体面并反制对手。';
}

function intriguePlotEngineBlock(book) {
  const board = resolveIntrigueBoard(book);
  if (!board) return '';
  const n = Number(book?.total_chapters) || 20;
  const crimeCap = Math.max(1, Math.floor(n * 0.15));
  const boardLine = {
    domestic: '盘面=侯府/伯府宅斗。主战场在内宅：嫡庶、主母、老夫人、管家嬷嬷、妾室、嫁妆、仆婢、亲事、分家产、名节、各房站队。',
    harem: '盘面=后宫宫斗。主战场在六宫：位份、圣宠、子嗣、敬事房、太监宫女体系、外戚借宫中势。',
    ministerial: '盘面=朝堂权谋。主战场在前朝：相位、清党、科举、军功、通商、储位、门生座主、联姻站队。',
    mixed: '盘面=宫斗与朝堂交织。后宫人情与前朝权柄互相借力，但仍是人与人的站队，不是两套刑侦案。',
  }[board];
  return `【人情权谋引擎·硬性·按盘面生成】
${boardLine}
· 主轴必须是人与人的权谋争斗：拉拢、反噬、名节、站队、情报、联姻、恩宠/权柄易手。每一章推进「谁压了谁、谁换了筹码」，禁止章章围着同一句秘密盘问打转。
· 刑侦/抄家/诏狱/审讯可以当小插曲，但全书这类节拍合计不得超过 ${crimeCap} 章（约一成半），且不得开局、不得连章。花费三分之一篇幅搞查案/坐牢 = 写歪了。
· 禁止把全书发动机写成「交东西→再审→再坐牢」。
· 外部官兵/衙门/大理寺最多背景一句，不能当主线。`;
}

function palaceDomesticPlotBlock(book) {
  return intriguePlotEngineBlock(book);
}

function sanitizeBeatForPalaceDomestic(beat, book) {
  const t = String(beat || '').trim();
  const board = resolveIntrigueBoard(book);
  if (!t || !board) return t;
  if (isCrimeProcedureHook(t) && /抄家|诏狱|坐牢|下狱|官兵围|钦差拿人/.test(t)) {
    return intrigueBeatFallback(board);
  }
  return t;
}

/** 全书刑侦节拍超配额或连章时，把多余的改回人情权谋 */
function capCrimeProcedureBeats(beats, book) {
  const board = resolveIntrigueBoard(book);
  const list = Array.isArray(beats) ? beats.slice() : [];
  if (!board || !list.length) return list;
  const n = list.length;
  const cap = Math.max(1, Math.floor(n * 0.15));
  let used = 0;
  let prevCrime = false;
  return list.map((raw, i) => {
    let t = String(raw || '').trim();
    if (!t) return t;
    const crime = isCrimeProcedureHook(t);
    const openingCrime = i === 0 && crime;
    const overCap = crime && used >= cap;
    const streak = crime && prevCrime;
    if (openingCrime || overCap || streak) {
      t = intrigueBeatFallback(board);
      prevCrime = false;
      return t;
    }
    if (crime) used += 1;
    prevCrime = crime;
    return t;
  });
}

/** 言情/甜宠等为主、且未选悬疑惊悚谍战 */
function isRomancePrimaryGenre(genres) {
  const gs = genres || [];
  if (!isRomanceLikeGenre(gs)) return false;
  return !isMysteryLikeGenre(gs) && !gs.includes('spy') && !gs.includes('thriller');
}

function eraLooksAncient(eraText) {
  return /古代|王朝|皇宫|明朝|清朝|唐朝|宋朝|民国|中世纪/.test(String(eraText || ''));
}

/**
 * 大纲多样性：按类型给灵感钩子，避免高频塌缩；时代标签不等于宫斗
 * bookOrSeed: book 对象或任意种子字符串
 */
function plotDiversityRules(genres, era, bookOrSeed = '') {
  const gs = Array.isArray(genres) ? genres : [];
  const eraText = String(era || '').trim();
  const seedSrc = (bookOrSeed && typeof bookOrSeed === 'object')
    ? `${bookOrSeed.id || ''}:${bookOrSeed.title || ''}:${(bookOrSeed.genres || []).join(',')}:${eraText}`
    : String(bookOrSeed || '');
  const seed = hashSeed(seedSrc || `${Date.now()}`);

  const needsAntiRestore = gs.some((g) => (
    g === 'palace' || g === 'historical' || g === 'angst' || g === 'romance'
    || g === 'romance_nsfw' || g === 'sweet' || g === 'family' || g === 'revenge'
  )) || eraLooksAncient(eraText);

  if (!needsAntiRestore && !gs.length) return '';

  const romancePrimary = isRomancePrimaryGenre(gs);
  const intrigueBoard = resolveIntrigueBoard(bookOrSeed);
  const ancient = eraLooksAncient(eraText);
  const banParts = [
    '【防套路·硬性】禁止默认写成「亡国公主/流亡皇嗣 → 复国」；禁止结局只在「复国成功男主死 / 复国失败女主死」两选一里打转。',
    '女主身份应具体多样（女官、医女、商人、侧妃、替身、间谍、世家旁支、新贵、庶女、宫女、女史、将门女、绣娘、书童等），不要总是「亡国公主」。',
    romancePrimary
      ? '言情/甜宠为主时：主线以感情线与人物关系为核心；禁止默认写成刑侦探案、大理寺查案、找真凶。冲突可来自误会、立场、联姻局、家族阻挠、任务与真心拉扯等。'
      : '主线冲突要换成具体局面（联姻局、储位、通商、边饷、科举、和谈、夺嫡情报战、节庆仪典、名节赏罚等），复国最多当背景一句，不得当全书唯一引擎。',
    '虐恋/言情可以疼或甜，但疼点应来自立场错位、谎言代价、任务冲突，而不是反复复国牺牲。',
  ];
  if (intrigueBoard) {
    banParts.push(intriguePlotEngineBlock(typeof bookOrSeed === 'object' ? bookOrSeed : { genres: gs, era: eraText, genres_custom: '' }));
  }
  const ban = banParts.join('\n');

  // 时代标签 ≠ 类型：架空古代可以是言情/种田/武侠，不要仅因「古代」就塞宫斗钩子
  const poolKeys = [];
  if (intrigueBoard === 'domestic') poolKeys.push('palace_domestic');
  else if (intrigueBoard === 'harem') poolKeys.push('palace_harem');
  else if (intrigueBoard === 'ministerial') poolKeys.push('palace_ministerial');
  else if (intrigueBoard === 'mixed') poolKeys.push('palace_harem', 'palace_ministerial');
  else {
    if (gs.includes('palace') || /皇宫内苑|架空王朝/.test(eraText)) poolKeys.push('palace');
    if (gs.includes('historical') || /朝堂|前朝|军政/.test(eraText)) poolKeys.push('historical');
  }
  if (gs.includes('angst')) poolKeys.push('angst');
  if (gs.includes('romance') || gs.includes('romance_nsfw') || gs.includes('sweet')) {
    poolKeys.push(ancient ? 'romance_ancient' : 'romance');
  }
  if (gs.includes('family') && intrigueBoard !== 'domestic') poolKeys.push('family');
  if (gs.includes('revenge')) poolKeys.push('revenge');
  if (gs.includes('farming')) poolKeys.push('farming');
  if (gs.includes('wuxia')) poolKeys.push('wuxia');
  if (!poolKeys.length && needsAntiRestore) {
    poolKeys.push(ancient ? 'romance_ancient' : 'romance', 'angst');
  }

  const hookPoolFilter = romancePrimary && !isMysteryLikeGenre(gs)
    ? (list) => list.filter((h) => !isInvestigationHook(h))
    : (list) => list;

  const hooks = [];
  for (const k of poolKeys) {
    const list = hookPoolFilter(PLOT_DIVERSITY_HOOKS[k] || []);
    if (list.length) hooks.push(list[(seed + hooks.length * 17) % list.length]);
  }
  const allPools = hookPoolFilter(poolKeys.flatMap((k) => PLOT_DIVERSITY_HOOKS[k] || []));
  if (allPools.length > 1) {
    const extra = allPools[(seed >>> 8) % allPools.length];
    if (extra && !hooks.includes(extra)) hooks.push(extra);
  }

  const hookLine = hooks.length
    ? `【本局主线灵感·从下列任选其一改写，或另写同等具体的不同事件；禁止整段照抄示例原文，禁止改回亡国复国】\n${hooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : '';

  return `${ban}\n${hookLine}`.trim();
}

/** 背景预设：时代或地点/世界观均可；存库字段仍为 era */
const ERA_PRESETS = [
  // 时代
  '现代', '上世纪八九十年代', '民国', '清朝', '明朝', '唐朝', '宋朝',
  '架空古代', '架空王朝', '欧洲中世纪', '维多利亚时代',
  '未来科幻', '赛博朋克', '末日废土', '星际',
  // 地点 / 场景气质
  '一线都市', '小县城', '江南水乡', '北国边塞', '海岛渔村', '山城古镇',
  '皇宫内苑', '封闭山庄', '海上游轮', '学院城', '深山古寺', '沙漠绿洲',
  '地下城迷宫', '规则怪谈空间',
  // 世界观
  '都市重生', '灵异现代', '修真界', '西幻大陆', '哈利波特背景',
];

const CHAPTER_TARGET_MIN = 2600;
const CHAPTER_TARGET_MAX = 3400;
const CHAPTER_TARGET_IDEAL = 3000;

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw || '');
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** style_custom 列存 JSON 数组 [{title,text}]；兼容旧版纯文本 */
function normalizeStyleCustoms(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => ({
        title: String(x?.title || '').trim().slice(0, 40),
        text: String(x?.text || x || '').trim().slice(0, 2000),
      }))
      .filter((x) => x.text)
      .slice(0, 20);
  }
  if (raw && typeof raw === 'object') {
    const text = String(raw.text || '').trim();
    return text ? [{ title: String(raw.title || '').trim().slice(0, 40), text: text.slice(0, 2000) }] : [];
  }
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    const arr = parseJson(s, null);
    if (Array.isArray(arr)) return normalizeStyleCustoms(arr);
  }
  return [{ title: '', text: s.slice(0, 2000) }];
}

/** 穿越创建时的身份偏好（表面职业 + 是否锁定男女主） */
function normalizeRolePrefs(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    user_brief: String(o.user_brief || o.user_role || '').trim().slice(0, 120),
    char_brief: String(o.char_brief || o.char_role || '').trim().slice(0, 120),
    user_lead_lock: !!(o.user_lead_lock === true || o.user_lead_lock === 1 || o.user_lead_lock === '1'),
    char_lead_lock: !!(o.char_lead_lock === true || o.char_lead_lock === 1 || o.char_lead_lock === '1'),
  };
}

function readRolePrefsFromBook(bookOrLock) {
  const lock = bookOrLock?.identity_lock && typeof bookOrLock.identity_lock === 'object'
    ? bookOrLock.identity_lock
    : (bookOrLock && typeof bookOrLock === 'object' && (bookOrLock.role_prefs || bookOrLock.user_lead_lock != null)
      ? bookOrLock
      : {});
  const fromLock = lock.role_prefs && typeof lock.role_prefs === 'object' ? lock.role_prefs : lock;
  return normalizeRolePrefs(fromLock);
}

function rolePrefsPromptBlock(book, { adapted = false } = {}) {
  const p = readRolePrefsFromBook(book);
  if (!p.user_brief && !p.char_brief && !p.user_lead_lock && !p.char_lead_lock) return '';
  const lines = adapted
    ? ['【扮演身份偏好·硬性】在忠实原作主线前提下必须落实：']
    : ['【创建偏好·硬性】必须落实，禁止忽略或另起无关身份：'];
  if (p.user_brief) {
    lines.push(adapted
      ? `· 用户穿越后表面身份/职业必须是「${p.user_brief}」（女）；优先绑定原作中最接近的女角色，其 brief 写此身份。`
      : `· 用户侧表面身份/职业必须是「${p.user_brief}」（女）；synopsis 与 female_lead.brief（或用户将扮演的女角 brief）须与此一致或同义，不可写成别的职业。`);
  }
  if (p.char_brief) {
    lines.push(adapted
      ? `· 同伴穿越后表面身份/职业必须是「${p.char_brief}」（男）；优先绑定原作中最接近的男角色，其 brief 写此身份。`
      : `· 同伴侧表面身份/职业必须是「${p.char_brief}」（男）；synopsis 与 male_lead.brief（或同伴将扮演的男角 brief）须与此一致或同义。`);
  }
  if (p.user_lead_lock && p.char_lead_lock) {
    lines.push('· 双方锁定主角：用户=female_lead，同伴=male_lead；brief 与期望身份对齐。');
  } else if (p.user_lead_lock) {
    lines.push('· 用户锁定女主（female_lead）；同伴不锁定，可为男配/对手等，勿强行男主。');
  } else if (p.char_lead_lock) {
    lines.push('· 同伴锁定男主（male_lead）；用户不锁定，可为女配/真凶等，勿强行女主。');
  } else if (p.user_brief || p.char_brief) {
    lines.push('· 未开主角锁：仍须把上述身份写进角色池与梗概；定角时再分配到具体姓名。');
  } else {
    lines.push('· 双方不锁定主角：可从剧情角色中分配，不必是男女主。');
  }
  return lines.join('\n');
}

function serializeBook(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  const styleCustoms = normalizeStyleCustoms(row.style_custom);
  const lock = parseJson(row.identity_lock, {});
  const canon = parseJson(row.canon_lock, {});
  const castRaw = parseJson(row.cast_list, []);
  // 公开接口只给姓名/性别/出场区间；kind（女主/男主）会削弱悬念
  const castPublic = (Array.isArray(castRaw) ? castRaw : []).map((c) => {
    const rawBrief = String(c?.brief || '').trim().slice(0, 120);
    // 公开池不剧透 kind 标签；简介去掉女主/真凶等词后若空则留空（前端用姓名点选）
    let brief = rawBrief
      .replace(/[（(【\[]?\s*(真凶|凶手|女主|男主)\s*[）)】\]]?/g, '')
      .replace(/剧本女主[^，。；]*/g, '')
      .replace(/剧本男主[^，。；]*/g, '')
      .replace(/故事核心/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 120);
    if (/^(剧中人|角色|路人|NPC|npc)$/i.test(brief)) brief = '';
    return {
      name: String(c?.name || '').trim().slice(0, 40),
      gender: c?.gender === 'male' ? 'male' : 'female',
      brief,
      appear_from: c?.appear_from != null ? Number(c.appear_from) : undefined,
      appear_to: c?.appear_to != null ? Number(c.appear_to) : undefined,
    };
  }).filter((c) => c.name);
  const out = {
    ...row,
    mode: row.mode === 'isekai' ? 'isekai'
      : row.mode === 'whatif' ? 'whatif'
        : row.mode === 'illusion' ? 'illusion'
          : 'series',
    whatif_background: String(row.whatif_background || '').trim(),
    genres: parseJson(row.genres, []),
    npcs: parseJson(row.npcs, []),
    cast_list: includeSecrets ? castRaw : castPublic,
    chapter_outline: parseJson(row.chapter_outline, []),
    style_customs: styleCustoms,
    // 兼容旧前端：拼成一段
    style_custom: styleCustoms.map((x) => (x.title ? `【${x.title}】${x.text}` : x.text)).join('\n'),
    npc_free: Number(row.npc_free) === 1,
    roles_blind: Number(row.roles_blind) === 1,
    total_chapters: Number(row.total_chapters) || LENGTH_CHAPTERS.medium,
    book_main_quest: String(row.book_main_quest || '').trim(),
    user_surface_brief: String(lock?.user?.surface_brief || '').trim(),
    char_surface_brief: String(lock?.char?.surface_brief || '').trim(),
    identity_locked: !!(lock && lock.locked),
    canon_locked: !!(canon && canon.locked),
  };
  // 故事来源：前端只看类型/书名，不回传全文
  {
    const src = parseJson(row.story_source, {});
    const typ = ['title', 'upload', 'original'].includes(src?.type) ? src.type : 'original';
    out.story_source = {
      type: typ,
      title: String(src?.title || '').trim().slice(0, 120),
      author: String(src?.author || '').trim().slice(0, 80),
      story: String(src?.story || '').trim().slice(0, 120),
      file_name: String(src?.file_name || '').trim().slice(0, 160),
      chars: Number(src?.chars) || (src?.text ? String(src.text).length : 0),
      has_text: !!(src?.text || src?.digest),
      has_digest: !!String(src?.digest || '').trim(),
    };
  }
  // 真身份秘密与引擎完整大纲绝不下发前端
  delete out.identity_lock;
  delete out.canon_lock;
  delete out.user_role_kind;
  delete out.char_role_kind;
  delete out.story_brief;
  out.screenwriter_status = String(row.screenwriter_status || '').trim();
  out.story_taboos = parseJson(row.story_taboos, []);
  if (out.mode === 'isekai') {
    const prefs = normalizeRolePrefs(lock?.role_prefs);
    out.role_prefs = prefs;
    out.user_lead_lock = prefs.user_lead_lock;
    out.char_lead_lock = prefs.char_lead_lock;
  }
  if (includeSecrets) {
    out.identity_lock = lock && typeof lock === 'object' ? lock : {};
    out.canon_lock = canon && typeof canon === 'object' ? canon : {};
    out.lore_book = parseJson(row.lore_book, {});
    out.user_role_kind = String(row.user_role_kind || '').trim();
    out.char_role_kind = String(row.char_role_kind || '').trim();
    out.cast_list = castRaw;
    out.story_source_full = parseJson(row.story_source, {});
  } else if (out.mode === 'isekai') {
    // 穿越：开局身份卡只给用户自己；同伴剧中名可用于同伴气泡标签，但不进身份卡
    const begun = !!(String(row.user_role || '').trim()
      && (row.status === 'writing' || row.status === 'done'));
    out.isekai_begun = begun;
    out.companion_identity_hidden = true;
    const prefs = out.role_prefs || normalizeRolePrefs(lock?.role_prefs);
    if (!begun) {
      // 开始穿越前：不提前泄露定角结果；但回传创建时填写的期望身份
      out.user_role = '';
      out.char_role = '';
      out.user_surface_brief = prefs.user_brief || '';
      out.char_surface_brief = prefs.char_brief || '';
      out.user_identity_card = null;
    } else {
      const u = lock?.user || {};
      const c = lock?.char || {};
      out.user_surface_brief = String(u.surface_brief || out.user_surface_brief || '').trim();
      out.char_surface_brief = String(c.surface_brief || out.char_surface_brief || '').trim();
      // char_role 保留：同伴卡标签用剧中名；身份卡仍只展示用户侧
      out.user_identity_card = {
        name: String(row.user_role || u.surface_name || '').trim(),
        brief: String(u.surface_brief || '').trim() || '（身份待补充）',
        relations: Array.isArray(u.relations)
          ? u.relations
            .map((x) => String(x || '').trim()
              .replace(/[（(][^）)]*[）)]/g, '')
              .replace(/[，,、；;].*(?:有利害|开局|同场|碰面|会登场|推动主线|剧情角色|与主线).*/g, '')
              .replace(/(?:与她|与他|与你)?同场有利害[，,、]?/gi, '')
              .replace(/开局(?:就)?会碰面[，,、]?/gi, '')
              .trim())
            .filter((x) => x
              && !/^(与|和|跟).{1,12}(相识|认识|有往来|有联系|有一面之缘|一面之缘)$/.test(x)
              && !/一面之缘|有直接牵连|清楚.{0,8}名声|开局即知|推动主线|与主线|剧情角色|有利害|开局就会碰面|同场有利害|会登场/.test(x)
              && !/^知道.{1,12}$/.test(x))
            .slice(0, 8)
          : [],
        constraints: Array.isArray(u.constraints)
          ? u.constraints.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
          : [],
        opening_brief: (() => {
          const raw = u.opening_brief;
          if (!raw || typeof raw !== 'object') return {};
          const pick = (k) => (Array.isArray(raw[k]) ? raw[k] : [])
            .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
          return { knows: pick('knows'), carries: pick('carries'), pending: pick('pending'), must_hide: pick('must_hide') };
        })(),
      };
    }
  }
  return out;
}

function serializeChapter(row) {
  if (!row) return null;
  return { ...row };
}

function charCoreForSeries(char) {
  const personality = String(char.personality || char.intro || '').trim();
  const appearance = String(char.description || '').trim();
  const speech = String(char.language_style || '').trim();
  return {
    name: char.name || '他',
    personality: personality || '（未填写性格，按名字气质合理发挥）',
    appearance: appearance || '（未填写外貌，按常见男主形象合理发挥，勿与名字气质冲突）',
    speech: speech || '',
  };
}

/**
 * 语言示例只供学「调性」，严禁当台词库照搬。
 * 聊天侧 cron 已有同类约束；剧集/穿越此前只写了「说话气质参考」导致模型整句抄示例。
 */
function speechStyleBlock(name, speech) {
  const samples = String(speech || '').trim();
  if (!samples) return '';
  const who = String(name || '他').trim() || '他';
  return `【说话方式·仅学调性·禁止照搬】
以下是体现${who}说话调性的参考例句（句长、软硬、用词、口头禅密度、标点习惯）。
它们不是台词库、不是可复用金句：
· 禁止原样照抄、禁止轻微改字复述、禁止把示例句拆开拼进对白；
· 禁止在一章里反复回响示例中的原句或半句；
· 每次对白必须按当下场景、身份、情绪重新组织，只保留相似语气，不保留示例原文。
· 调性≠文绉绉：即使参考例句偏文艺，现场对白也要像现实里真人当面说的话；跟性格走，但别写成书面腔/散文金句。
参考例句（只学语气，禁止照抄）：
${samples.slice(0, 1200)}`;
}

/** 用户自写梗概：有则强制大纲据此展开 */
function userPremiseBlock(book) {
  const p = String(book?.user_premise || '').trim();
  if (!p) return '';
  return `【用户给定梗概·硬性】必须据此展开，不得另起一套主线；可补细节与节奏，不可改核心冲突/关键人物关系/结局方向：
${p.slice(0, 1200)}`;
}

/** 已从可选列表移除，旧书仍可能带这些 key */
const GENRE_LABEL_LEGACY = {
  romance_nsfw: '言情（可肉）',
  nsfw: '纯肉文',
};

function genreText(genres, genresCustom) {
  const labels = [];
  for (const g of genres || []) {
    if (g === 'custom') continue;
    const hit = GENRE_OPTIONS.find((x) => x.key === g);
    if (hit) labels.push(hit.label);
    else if (GENRE_LABEL_LEGACY[g]) labels.push(GENRE_LABEL_LEGACY[g]);
  }
  const custom = String(genresCustom || '').trim();
  if (custom) labels.push(custom);
  return labels.length ? labels.join('、') : '原创故事';
}

function genreRulesText(genres, genresCustom) {
  const lines = [];
  let wantsMeat = false;
  let pureMeat = false;
  for (const g of genres || []) {
    if (GENRE_RULES[g]) lines.push(`- ${GENRE_RULES[g]}`);
    if (g === 'romance_nsfw') wantsMeat = true;
    if (g === 'nsfw') { wantsMeat = true; pureMeat = true; }
  }
  const custom = String(genresCustom || '').trim();
  if (custom) lines.push(`- 自定义类型要求：${custom}`);
  if (!lines.length) lines.push('- 按原创长篇小说合理推进，人物动机自洽。');

  if (pureMeat) {
    lines.push('- 【肉文尺度】本章必须出现情欲或性爱相关实质描写（非一笔带过）；禁止用省略号/「事后」跳过交合过程；禁止突然改口说不能写成人内容。');
  } else if (wantsMeat) {
    lines.push('- 【可肉尺度】情节走到亲密时可完整写性爱；未到时机则先写感情与张力，不要为肉而肉，也不要在该写时突然删节。');
  } else if ((genres || []).includes('romance')) {
    lines.push('- 【清水言情】不写性交与露骨生殖器描写；吻戏拥抱可以。');
  }
  return lines.join('\n');
}

function isRomanceLikeGenre(genres) {
  return (genres || []).some((g) => (
    g === 'romance' || g === 'romance_nsfw' || g === 'sweet' || g === 'angst'
  ));
}

/** 言情：对方主动开口，勿干等用户硬推感情线 */
function romanceDialogueDriveRules(genres) {
  if (!isRomanceLikeGenre(genres)) return '';
  return `【言情·互动驱动·硬性】感情戏不能干等用户硬推。
· 男主/感情对象须主动开口：抛话、接话、试探心意、吃醋、关心、拌嘴、邀约——同场段落里要有实质对白往来，禁止长时间只「看着对方/沉默对视」等用户填空。
· 若女主是用户扮演：禁止替用户说出口的话，但对方与配角必须把话头抛过来（提问、冲突、暧昧试探、表白边缘），给用户自然接话点；禁止整场哑巴戏。
· 若女主是剧中 NPC（用户另有身份）：女主必须有自己的台词、态度与主动性，推动感情线，禁止成挂件。
· 旁白可写氛围，但感情推进主要靠对白与互动，不要只靠内心戏描写代替开口。`;
}

function isMeatGenre(genres) {
  return (genres || []).some((g) => g === 'nsfw' || g === 'romance_nsfw');
}

/** 悬疑/恐怖/惊悚等：公开梗概与分章大纲不得剧透答案 */
function isSpoilerSensitiveGenre(genres) {
  return (genres || []).some((g) => (
    g === 'mystery' || g === 'horror' || g === 'thriller' || g === 'infinite'
  ));
}

function isMysteryLikeGenre(genres) {
  return (genres || []).some((g) => g === 'mystery' || g === 'thriller');
}

function isHorrorGenre(genres) {
  return (genres || []).includes('horror');
}

function isInfiniteGenre(genres) {
  return (genres || []).includes('infinite');
}

function outlineNoSpoilerRules(genres) {
  if (!isSpoilerSensitiveGenre(genres)) return '';
  const lines = [
    '【防剧透·硬性】本类型梗概/一句话/arcs/分章摘要都是给读者看的目录，禁止写穿答案：',
  ];
  if (isMysteryLikeGenre(genres)) {
    lines.push('- 悬疑/惊悚：禁止点明凶手、主谋、完整答案；公开大纲只写调查推进与悬念。全书通关可以是「找出真凶/查清关键」，但答案本身不下公开大纲。');
  }
  if (isHorrorGenre(genres)) {
    lines.push('- 恐怖：禁止剧透鬼/实体真身、诅咒真正来源（若故事有的话）。气氛与压迫优先于解释；**不要默认全书必须「破局/找真相」**——通关可以是撑过今夜、逃离险境、活着走到收束，也可以始终未知、不解释。');
  }
  if (isInfiniteGenre(genres)) {
    lines.push('- 无限流：禁止剧透通关公式与最终规则漏洞；主题是生存/通关，不要硬套悬疑破案。');
  }
  lines.push('- 只写悬念、冲突、压迫升级与收束气氛；功能语可用，不给答案本身。');
  lines.push('写作引擎自会在正文里圆上逻辑，大纲里不要剧透。');
  return lines.join('\n');
}

/** 穿越任务文案：按题材防剧透；必须跟本章故事节拍 + 用户真身份，禁止万能模板 */
function mysteryQuestRules(genres, chapterNo, totalChapters, trueKind = '') {
  if (!isSpoilerSensitiveGenre(genres)) return '';
  const n = Math.max(1, Number(chapterNo) || 1);
  const total = Math.max(n, Number(totalChapters) || n);
  const ratio = n / total;
  const kind = String(trueKind || '').trim();

  if (isHorrorGenre(genres) && !isMysteryLikeGenre(genres)) {
    return `【恐怖节奏】
全书主线以恐惧压迫与求生/逃离为主，**禁止章章写成「找真相/完成破局」**。
本章任务写成服务【本章故事节拍】的情节目标（如撑过今夜、逃离某处），不要写死具体步骤。
禁止把任务写成「去和同伴汇合」凑戏。`;
  }
  if (isInfiniteGenre(genres) && !isMysteryLikeGenre(genres)) {
    return `【无限流节奏】
全书主线是通关/生存；本章任务跟副本节拍写成情节目标，禁止套「找出真凶/破局」万能模板，也不要写死通关步骤。
禁止把任务写成「去和同伴汇合」凑戏。`;
  }

  if (/culprit|villain/.test(kind)) {
    return `【悬疑·身份视角=${kind}】
用户不是调查者。本章任务应是该身份在【本章故事节拍】里该促成的情节局面（布局/灭口/栽赃/掩盖/推进阴谋等），写成目标即可，不要写死具体操作步骤。
**禁止**写成「找出真凶/搜集线索破案」。任务文案不要写破「你是真凶」标签。`;
  }
  if (kind && !/lead/.test(kind)) {
    return `【悬疑·身份视角=${kind}】
本章任务服务该身份在【本章故事节拍】中的情节局面，不要强行改成全书「找真凶」主线，也不要写死步骤。
禁止用「去和某某汇合」当唯一任务。`;
  }

  let phase;
  if (ratio <= 0.4) {
    phase = '前中期：禁止把本章任务写成终局「指认真凶/完成破局」；但也禁止无视大纲、章章套「搜集一条线索」。写成当章情节目标即可。';
  } else if (ratio <= 0.75) {
    phase = '中后期：可写排查、对质、逼近真相的情节目标；仍禁止在任务里点名答案，也不要写死步骤。';
  } else {
    phase = '收束窗口：若本章大纲已到揭晓，任务可写「完成指认/摊牌」类情节目标，仍不点明是谁。';
  }
  return `【悬疑防剧透·调查者视角】
若用户是调查线身份，全书主线才是找真凶/查清关键；本章任务仍必须服务【本章故事节拍】，写成情节目标，不要写死具体做法。
${phase}
禁止在 chapter_quest 里写「凶手是××」；禁止用「去和同伴汇合」替换故事节拍。`;
}

/** 题材 → 默认文风底色（多题材时按优先级取第一个命中） */
const GENRE_DEFAULT_STYLE = {
  nsfw: 'romantic',
  romance_nsfw: 'romantic',
  romance: 'romantic',
  sweet: 'gentle',
  angst: 'dark',
  horror: 'dark',
  thriller: 'dark',
  abnormal: 'dark',
  revenge: 'dark',
  apocalypse: 'dark',
  spy: 'dark',
  mystery: 'witty',
  infinite: 'epic',
  adventure: 'epic',
  scifi: 'epic',
  steampunk: 'epic',
  fantasy: 'surreal',
  folklore: 'surreal',
  ability: 'surreal',
  wuxia: 'poetic',
  palace: 'poetic',
  historical: 'poetic',
  healing: 'gentle',
  campus: 'gentle',
  farming: 'gentle',
  medical: 'gentle',
  urban: 'witty',
  workplace: 'witty',
  entertainment: 'witty',
  family: 'witty',
  rebirth: 'witty',
};

const GENRE_STYLE_PRIORITY = [
  'nsfw', 'romance_nsfw', 'horror', 'thriller', 'abnormal', 'revenge', 'angst', 'apocalypse', 'spy',
  'mystery', 'infinite', 'adventure', 'fantasy', 'folklore', 'ability', 'scifi', 'steampunk',
  'wuxia', 'palace', 'historical',
  'healing', 'sweet', 'campus', 'farming', 'medical',
  'urban', 'workplace', 'entertainment', 'family', 'rebirth', 'romance',
];

function styleKeyFromGenres(genres, genresCustom) {
  const gs = Array.isArray(genres) ? genres : [];
  for (const g of GENRE_STYLE_PRIORITY) {
    if (gs.includes(g) && GENRE_DEFAULT_STYLE[g]) return GENRE_DEFAULT_STYLE[g];
  }
  if (String(genresCustom || '').trim()) return 'romantic';
  return 'romantic';
}

function isGenreAutoStyle(style) {
  const s = String(style || '').trim();
  return !s || s === 'genre' || s === 'auto' || s === 'default' || s === '题材默认';
}

function styleText(style, styleCustoms, genres, genresCustom) {
  const customs = normalizeStyleCustoms(styleCustoms);
  let baseKey = style === 'custom' ? 'custom' : (style || 'genre');
  let autoNote = '';
  if (baseKey !== 'custom' && isGenreAutoStyle(baseKey)) {
    baseKey = styleKeyFromGenres(genres, genresCustom);
    autoNote = '（已按所选题材自动匹配文风底色）';
  }
  let base;
  if (baseKey === 'custom') {
    base = customs.length
      ? '文笔风格（必须严格遵守下列挂载文风）：'
      : '文笔风格：文学散文，细腻生动。';
  } else {
    base = dreamHelper.resolveDreamStyleText({ style: baseKey, styleCustom: '' }) + autoNote;
  }
  if (!customs.length) return base;
  const extra = customs.map((c, i) => {
    const label = c.title || `挂载文风${i + 1}`;
    return `【${label}】${c.text}`;
  }).join('\n');
  return `${base}\n${extra}`;
}

function resolveEra(era, eraCustom) {
  const base = String(era || '').trim();
  const custom = String(eraCustom || '').trim();
  if (!base || base === '自定义' || base === 'custom') return custom || '架空';
  if (custom) {
    // 预设与自定义叠加；自定义已包含在预设串里时不重复
    if (base.includes(custom)) return base;
    return `${base} · ${custom}`;
  }
  return base || '现代';
}

/** 背景说明：时代或地点/世界观，供提示词使用 */
function backgroundPromptLine(era, eraCustom) {
  const bg = resolveEra(era, eraCustom);
  return `【背景】${bg}（可为时代、地点或世界观）——器物、称谓、制度、生活细节必须符合该背景，禁止明显穿帮。`;
}

function buildSeriesSystemPrompt(book, char, { chapterNo = 0 } = {}) {
  const core = charCoreForSeries(char);
  const userName = String(getSettings()?.username || '旅人').trim() || '旅人';
  const genresLabel = genreText(book.genres, book.genres_custom);
  const genreRules = genreRulesText(book.genres, book.genres_custom);
  const style = styleText(book.style, book.style_customs || book.style_custom, book.genres, book.genres_custom);
  const npcFree = book.npc_free;
  const npcs = (book.npcs || []).map((n) => `${n.name}（${n.relation || '关系未明'}）`).join('；');
  const npcRule = npcFree
    ? '【NPC】可自由补充必要配角；配角勿抢男女主戏份。'
    : `【NPC】禁止擅自发明新配角。仅可使用名单：${npcs || '（暂无，尽量只用男女主推动）'}。`;
  const meat = isMeatGenre(book.genres);
  const canonBlock = formatCanonBlockForPrompt(book, { chapterNo });
  const premise = userPremiseBlock(book);

  return `你是「念·剧集」专用的长篇小说作者。这不是通讯聊天，也不是角色陪聊。
【专用提示】只遵守本提示词与本剧集设定。禁止套用日常聊天人设、记忆、日程、朋友圈、经期、忙碌状态、主动消息规则；禁止用聊天式短回复；禁止说「我是AI不能写」。
【平行世界】剧情背景、世界观、主线场景只由本剧集类型与背景（时代或地点）决定，任意原创；不要受角色真身职业/身世影响。
【姓名硬性·不改名只改身份】男主姓名固定为「${core.name}」，女主姓名固定为「${userName}」。禁止另起新名、禁止用身份头衔替换姓名当称呼主体（可说「调查员${core.name}」，不可改叫别的名字）。char_role / user_role 只表示本剧职业或社会身份。
角色卡只提供「脾气性格 / 外貌气质 / 说话方式」——用于写他怎么演本剧身份。禁止沿用现实背景、家人、财产、既有恋爱史与聊天记忆；身世与职业按本剧身份重写，姓名不变。
【男女主身份】男主「${core.name}」：${book.char_role || '男主'}。女主「${userName}」：${book.user_role || '女主'}（可女扮男装，性别仍为女）。禁止把男女主写成配角。
【角色卡·男主·演技参考】名：${core.name}
脾气性格：${core.personality}
外貌气质：${core.appearance}
${speechStyleBlock(core.name, core.speech)}
${canonBlock ? `${canonBlock}\n` : ''}${premise ? `${premise}\n` : ''}【类型】${genresLabel}
【类型写法】
${genreRules}
${backgroundPromptLine(book.era, book.era_custom)}
${npcRule}
${style}
${romanceDialogueDriveRules(book.genres)}
${meat ? '【成人内容许可】本剧集用户已选择肉向类型：允许并需要按类型尺度书写成年男女合意的情色/性爱内容；不要自我审查成清水，也不要写成低俗辱骂堆砌。' : '【内容边界】未选肉向类型时，不写露骨性交。'}
【排版】简体中文长篇；叙述分段；对白用「」且尽量单独成行；不用*星号动作*；禁止提及AI、模型、程序、虚拟、扮演、系统。
【视角】第三人称小说体，交替写男女主心理与行动；叙述与对白里称呼男女主须用固定姓名。
【对白·贴现实】男女主与配角开口都要像现实里真人当面说话：自然、好懂，跟性格与身份走。禁止文绉绉、书面腔、古风咏叹、为「深沉」硬堆辞藻；可以损、可以暧昧、可以留白，但要用这个人平时会说出口的说法，不要写成散文金句。旁白可略有文采，对白口语。男主台词须按本章情境新写；语言示例原句一律不得出现在正文（含同义微改）。女主侧若由用户扮演则不替她开口，但男主与配角须主动把话头抛给她。`;
}

/** 取出助手正文：兼容 content 数组 / 思考标签；不把 reasoning 当正文 */
function extractAssistantText(data) {
  const msg = data?.choices?.[0]?.message || {};
  let c = msg.content;
  if (Array.isArray(c)) {
    c = c.map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      return String(p.text || p.content || p.value || '');
    }).join('');
  }
  c = String(c || '').trim();
  if (!c && typeof msg.refusal === 'string') c = msg.refusal.trim();
  // 去思考块（中转常见）
  c = c.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  c = c.replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '');
  c = c.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '');
  // 仅当「未配对的 </think>」且前面更像思考/很短前缀时才剥；禁止见标签就砍掉整段前文（会表现为剧情开头失踪）
  if (/<\/think>/i.test(c) && !/<think\b/i.test(c)) {
    const m = c.match(/^([\s\S]*?)<\/think>\s*/i);
    if (m) {
      const before = String(m[1] || '').trim();
      const after = c.slice(m[0].length).trim();
      const beforeLooksReason = !before
        || before.length < 80
        || /^(思考|推理|分析|reason|thinking|ok|好的|用户)/i.test(before)
        || !/[\u4e00-\u9fff]{20,}/.test(before);
      if (after && beforeLooksReason) c = after;
      else c = c.replace(/<\/think>/gi, '');
    }
  }
  return c.trim();
}

function proseLooksCutOff(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const open = (t.match(/「/g) || []).length;
  const close = (t.match(/」/g) || []).length;
  if (open > close) return true;
  // 未闭合的 Markdown/代码块少见，但也算截断信号
  if ((t.match(/```/g) || []).length % 2 === 1) return true;
  if (/[，、；,;：:]$/.test(t)) return true;
  // 破折/省略单独收尾且无句末标点 → 更像写到一半
  if (/[——…−–-]{1,6}$/.test(t) && !/[。！？!?」』]/.test(t.slice(-8))) return true;
  // 句号/问叹/闭引号收束 → 形态上完整
  if (/[。！？!?…]["」』”’）)\]]*$/.test(t)) return false;
  if (/[」』]$/.test(t)) return false;
  // 停在汉字/英文/数字中间，几乎一定是断了
  if (/[\u4e00-\u9fffA-Za-z0-9]$/.test(t)) return true;
  return false;
}

/** 统计大致汉字量（去空白） */
function proseCharCount(text) {
  return String(text || '').replace(/\s/g, '').length;
}

/**
 * 接写时合并增量：处理「整段重写」「带前文重复」「纯增量」三种常见返回
 * @returns {{ content: string, appended: boolean }}
 */
function mergeContinuedProse(prev, piece) {
  const a = String(prev || '');
  let b = String(piece || '').trim();
  if (!b) return { content: a, appended: false };

  // 新文几乎以旧文开头 → 只取增量
  const head = a.slice(0, Math.min(80, a.length));
  if (head && b.startsWith(head)) {
    // 必须确认新文覆盖了旧文主体，才能按「全文重写后的增量」切片；否则 b.slice(a.length) 会把开头切没
    if (b.length >= a.length) {
      const rest = b.slice(a.length).replace(/^\s+/, '');
      if (rest) return { content: a + rest, appended: true };
      if (b.length > a.length + 40) return { content: b, appended: true };
      return { content: a, appended: false };
    }
    // 新文更短但同开头：多半是残段重述，保留旧文
    return { content: a, appended: false };
  }

  // 旧文尾部与新文头部重叠（模型回放了最后一两句）
  const tailLen = Math.min(120, a.length, b.length);
  for (let n = tailLen; n >= 24; n -= 1) {
    const tail = a.slice(-n);
    // 只认「新文开头就回放尾部」，避免正文中间碰巧撞上尾句把前面整段丢掉
    const idx = b.indexOf(tail);
    if (idx >= 0 && idx < 24) {
      const rest = b.slice(idx + tail.length).replace(/^\s+/, '');
      if (rest) return { content: a + rest, appended: true };
    }
  }

  // 完整重写：必须明显更长、收束更好，且与旧文开头有重合，才允许整段替换（防止接写成「从半截开场」盖掉前文）
  const shareHead = (() => {
    if (!a || a.length < 40) return true; // 旧文极短时允许替换
    const h = a.slice(0, Math.min(40, a.length));
    if (b.startsWith(h)) return true;
    // 允许新文前 120 字内出现旧文开头（偶发前置旁白）
    return b.slice(0, 120).includes(h.slice(0, 24));
  })();
  if (shareHead && b.length > a.length * 1.15 && !proseLooksCutOff(b)) {
    return { content: b, appended: true };
  }
  // 旧文明显截断、新文完整且保留开头 → 采用新文
  if (shareHead && proseLooksCutOff(a) && !proseLooksCutOff(b) && b.length >= Math.min(a.length, 400)) {
    return { content: b, appended: true };
  }

  // 默认拼接（模型按「不要重复上文」只回增量）
  return { content: a + b, appended: true };
}

async function chatLong(settings, systemPrompt, userContent, {
  history = [],
  maxTokens = 4500,
  continueRounds = 4,
  targetMin = 0,
  emptyRetries = 2,
  /** prose=小说正文接写；json=只要结构化输出，禁止散文接写/排版改写 */
  format = 'prose',
  temperature: temperatureOverride = null,
  /** 为 true 时：接写耗尽后若仍半截/过短则抛错，避免把残章当成功 */
  rejectCutOff = false,
  /** series | series_outline(按量) | series_play(按次/游玩) */
  apiType = 'series',
} = {}) {
  const slot = ['series_outline', 'series_play', 'series'].includes(apiType) ? apiType : 'series';
  const { url, apiKey, model } = resolveTaskApiCreds(settings, slot);
  if (!url || !apiKey) throw new Error('请先在「设置 → 时空 API」填写地址与 Key');
  if (!model) {
    throw new Error(slot === 'series_outline'
      ? '请先填写时空「大纲模型」（或通用模型）'
      : slot === 'series_play'
        ? '请先填写时空「游玩模型」（或通用模型）'
        : '请先在「设置 → 时空 API」填写模型');
  }

  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  const temperature = temperatureOverride != null
    ? Number(temperatureOverride)
    : parseFloat(settings.series_temperature || settings.chat_temperature || '0.85');
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const h of history) {
    messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content });
  }
  if (userContent) messages.push({ role: 'user', content: userContent });

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const wantJson = format === 'json';

  async function oneShot(msgs, tokens) {
    const body = JSON.stringify({
      model,
      messages: msgs,
      temperature,
      max_tokens: tokens,
      stream: false,
    });
    async function tryFetch(apiUrl) {
      const resp = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        timeout: 180000,
      });
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`API error ${resp.status}: ${err.slice(0, 240)}`);
      }
      return resp.json();
    }
    try {
      return await tryFetch(baseUrl);
    } catch (e1) {
      if (!baseUrl.endsWith('/v1')) return tryFetch(`${baseUrl}/v1`);
      throw e1;
    }
  }

  // 部分模型写肉文会直接空回复，空则换个温度重试
  let data = null;
  let content = '';
  let reason = '';
  for (let attempt = 0; attempt <= emptyRetries; attempt++) {
    const msgs = attempt === 0
      ? messages
      : [
          ...messages.slice(0, 1),
          ...messages.slice(1),
          {
            role: 'user',
            content: wantJson
              ? '（上一次返回为空。请只输出完整 JSON 对象，不要解释、不要 markdown。）'
              : '（上一次返回为空。请直接输出小说正文，不要拒绝、不要道歉、不要只回标点。）',
          },
        ];
    data = await oneShot(msgs, maxTokens);
    content = extractAssistantText(data);
    reason = data.choices?.[0]?.finish_reason || '';
    if (content && content.replace(/\s/g, '').length >= (wantJson ? 8 : 20)) break;
  }
  if (!content) throw new Error('剧集模型返回空内容（可换模型或检查是否拦截成人内容）');

  // 要散文却回了 JSON 包裹：先抠出正文再走接写
  if (!wantJson && /^\s*\{/.test(content) && /"(narration|content|text|reply)"\s*:/.test(content)) {
    const obj = extractJsonObject(content);
    if (obj) {
      const pulled = String(obj.narration || obj.content || obj.text || obj.reply || obj.char || '').trim();
      if (pulled) content = pulled;
    }
  }

  const jsonLooksComplete = (text) => {
    const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = t.indexOf('{');
    if (start < 0) return false;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return true;
      }
    }
    return false;
  };

  const looksIncomplete = (text, fr) => {
    const t = String(text || '').trim();
    if (!t) return true;
    if (wantJson) {
      if (fr === 'length') return !jsonLooksComplete(t);
      return !jsonLooksComplete(t);
    }
    // length=被 max_tokens 截断；stop 时也可能半句就停——按文本形态判断
    if (fr === 'length') return true;
    return proseLooksCutOff(t);
  };

  const maxRounds = wantJson ? Math.min(Math.max(continueRounds, 2), 5) : continueRounds;
  for (let i = 0; i < maxRounds; i++) {
    const tooShort = !wantJson && targetMin > 0 && proseCharCount(content) < targetMin;
    if (!looksIncomplete(content, reason) && !tooShort) break;

    const contTokens = wantJson
      ? Math.min(maxTokens, 1600)
      : Math.min(Math.max(maxTokens, 2000), 6000);
    const contMsgs = [
      {
        role: 'system',
        content: wantJson
          ? `${systemPrompt}\n【接写】上一段 JSON 被截断。请从断点无缝续写剩余 JSON，不要重复已输出部分，不要加解释。`
          : `${systemPrompt}\n【接写】上一段正文在半句/半段处被截断（常因长度上限）。只从断点往后续写到自然收束；禁止重复上文，禁止另起一篇新章。`,
      },
      ...messages.slice(1),
      { role: 'assistant', content },
      {
        role: 'user',
        content: wantJson
          ? '（请从断点继续补全 JSON，不要重复上文，不要 markdown）'
          : (tooShort
            ? `（请无缝接写。当前约 ${proseCharCount(content)} 字，目标至少 ${targetMin} 字；不要重复上文，写到本章完整收束。）`
            : '（上一段明显没写完。请从最后一个字之后无缝接写到句段收束；不要重复上文，不要从头再写。）'),
      },
    ];
    let contData = null;
    try {
      contData = await oneShot(contMsgs, contTokens);
    } catch (e) {
      console.warn('[series] chatLong continue fail', e.message);
      // 接写网络失败时再试一轮整段重写，而不是直接放弃
      break;
    }
    const piece = extractAssistantText(contData);
    reason = contData?.choices?.[0]?.finish_reason || '';
    if (!piece) continue; // 空片再试下一轮，勿直接 break 放弃
    if (wantJson) {
      content += piece;
      if (jsonLooksComplete(content)) break;
      continue;
    }
    const merged = mergeContinuedProse(content, piece);
    if (!merged.appended) continue;
    content = merged.content;
    if (proseCharCount(content) >= CHAPTER_TARGET_MAX + 400
      && !proseLooksCutOff(content)
      && reason !== 'length') {
      break;
    }
  }

  // 仍像半截或明显过短：整段重掷（比干接更稳）
  const stillBad = () => {
    if (wantJson) return !jsonLooksComplete(content);
    if (proseLooksCutOff(content) || reason === 'length') return true;
    if (targetMin > 0 && proseCharCount(content) < Math.floor(targetMin * 0.72)) return true;
    return false;
  };
  if (!wantJson && stillBad()) {
    try {
      const retryTokens = Math.min(Math.max(maxTokens, 5000), 8192);
      const retryData = await oneShot([
        ...messages,
        {
          role: 'user',
          content: targetMin > 0
            ? `（上一条正文不完整或过短。请重新输出完整一章正文，约 ${targetMin}～${CHAPTER_TARGET_MAX} 字，写到自然收束，不要半句截断，不要 JSON，不要章节标题。）`
            : '（上一条正文停在半句。请重新输出完整一段，写到自然收束，不要半句截断，不要 JSON。）',
        },
      ], retryTokens);
      let retryText = extractAssistantText(retryData);
      let retryReason = retryData?.choices?.[0]?.finish_reason || '';
      // 重掷仍被 length 截断时，再接一轮
      if (retryText && (retryReason === 'length' || proseLooksCutOff(retryText))) {
        try {
          const more = await oneShot([
            ...messages,
            { role: 'assistant', content: retryText },
            { role: 'user', content: '（请从断点无缝接写到完整收束，不要重复上文。）' },
          ], Math.min(retryTokens, 6000));
          const morePiece = extractAssistantText(more);
          retryReason = more?.choices?.[0]?.finish_reason || retryReason;
          if (morePiece) {
            const m = mergeContinuedProse(retryText, morePiece);
            retryText = m.content;
          }
        } catch (_) { /* keep retryText */ }
      }
      const retryCount = proseCharCount(retryText);
      const oldCount = proseCharCount(content);
      const retryBetter = retryText && !proseLooksCutOff(retryText)
        && retryCount >= Math.max(40, Math.floor(oldCount * 0.85));
      const retryLongerComplete = retryText && retryCount > oldCount + 80 && (
        !proseLooksCutOff(retryText) || retryCount > oldCount * 1.3
      );
      if (retryBetter || retryLongerComplete) {
        content = retryText;
        reason = retryReason;
      }
    } catch (e) {
      console.warn('[series] chatLong rewrite retry', e.message);
    }
  }

  if (rejectCutOff && stillBad()) {
    const n = proseCharCount(content);
    throw new Error(
      wantJson
        ? '模型返回的 JSON 不完整（可能被截断），请重试或换时空模型'
        : `章节正文仍不完整（约 ${n} 字${proseLooksCutOff(content) || reason === 'length' ? '，末尾像被截断' : '，短于目标'}）。请重试「整章重写」，或换更稳的时空模型/提高输出长度`,
    );
  }

  // JSON 绝不能走梦境排版（会在引号旁插换行，破坏结构）
  return wantJson ? content : dreamHelper.formatDreamProse(content);
}

function listBooks(characterId = null, mode = null) {
  const modeFilter = mode === 'isekai' || mode === 'series' || mode === 'whatif' || mode === 'illusion' ? mode : null;
  let rows;
  if (characterId && modeFilter) {
    rows = db.prepare(`
      SELECT b.*, c.name as char_name, c.avatar as char_avatar
      FROM series_books b
      LEFT JOIN characters c ON c.id = b.character_id
      WHERE b.character_id=? AND COALESCE(b.mode,'series')=?
      ORDER BY b.updated_at DESC, b.id DESC
    `).all(characterId, modeFilter);
  } else if (characterId) {
    rows = db.prepare(`
      SELECT b.*, c.name as char_name, c.avatar as char_avatar
      FROM series_books b
      LEFT JOIN characters c ON c.id = b.character_id
      WHERE b.character_id=?
      ORDER BY b.updated_at DESC, b.id DESC
    `).all(characterId);
  } else if (modeFilter) {
    rows = db.prepare(`
      SELECT b.*, c.name as char_name, c.avatar as char_avatar
      FROM series_books b
      LEFT JOIN characters c ON c.id = b.character_id
      WHERE COALESCE(b.mode,'series')=?
      ORDER BY b.updated_at DESC, b.id DESC
    `).all(modeFilter);
  } else {
    rows = db.prepare(`
      SELECT b.*, c.name as char_name, c.avatar as char_avatar
      FROM series_books b
      LEFT JOIN characters c ON c.id = b.character_id
      ORDER BY b.updated_at DESC, b.id DESC
    `).all();
  }
  return rows.map((r) => {
    const book = serializeBook(r);
    const done = db.prepare(
      `SELECT COUNT(*) as n FROM series_chapters WHERE book_id=? AND status='done'`
    ).get(r.id)?.n || 0;
    const generating = db.prepare(
      `SELECT COUNT(*) as n FROM series_chapters WHERE book_id=? AND status='generating'`
    ).get(r.id)?.n || 0;
    const extra = {};
    if (book.mode === 'illusion') {
      extra.illusion_ready = done > 0;
      extra.illusion_generating = generating > 0;
      extra.illusion_len = db.prepare(
        `SELECT CASE WHEN content IS NULL OR content='' THEN 0 ELSE length(content) END as n
         FROM series_chapters WHERE book_id=? AND chapter_no=1`
      ).get(r.id)?.n || 0;
    }
    return { ...book, chapters_done: done, has_generating: generating > 0, ...extra };
  });
}

function getBook(bookId, { includeSecrets = false } = {}) {
  const row = db.prepare(`
    SELECT b.*, c.name as char_name, c.avatar as char_avatar,
      c.personality as char_personality, c.description as char_description,
      c.language_style as char_language_style, c.intro as char_intro
    FROM series_books b
    LEFT JOIN characters c ON c.id = b.character_id
    WHERE b.id=?
  `).get(bookId);
  if (!row) return null;
  const book = serializeBook(row, { includeSecrets });
  const chapters = db.prepare(
    `SELECT id, book_id, chapter_no, title, outline, status, director_notes, updated_at,
      CASE WHEN content IS NULL OR content='' THEN 0 ELSE length(content) END as content_len
     FROM series_chapters WHERE book_id=? ORDER BY chapter_no ASC`
  ).all(bookId);
  // 公开接口不下发 identity 类记忆（含真身份认知）
  const memories = includeSecrets
    ? db.prepare(
      `SELECT id, content, chapter_no, kind, pinned, created_at FROM series_memories WHERE book_id=? ORDER BY id DESC LIMIT 40`
    ).all(bookId)
    : db.prepare(
      `SELECT id, content, chapter_no, kind, pinned, created_at FROM series_memories
       WHERE book_id=? AND COALESCE(kind,'plot')!='identity' ORDER BY id DESC LIMIT 40`
    ).all(bookId);
  if (book.mode === 'whatif') {
    const ch0 = chapters[0];
    const turnN = db.prepare(
      `SELECT COUNT(*) as n FROM series_turns WHERE book_id=? AND chapter_no=1`
    ).get(bookId)?.n || 0;
    book.whatif_started = turnN > 0 && ch0 && ['playing', 'done'].includes(ch0.status);
    book.whatif_turn_count = turnN;
  }
  if (book.mode === 'illusion') {
    const ch0 = chapters[0];
    book.illusion_ready = !!(ch0 && ch0.status === 'done' && Number(ch0.content_len) > 0);
    book.illusion_generating = !!(ch0 && ch0.status === 'generating');
    book.illusion_len = Number(ch0?.content_len) || 0;
  }
  return { ...book, chapters: chapters.map(serializeChapter), memories };
}

function getChapter(bookId, chapterNo) {
  const row = db.prepare(
    `SELECT * FROM series_chapters WHERE book_id=? AND chapter_no=?`
  ).get(bookId, chapterNo);
  return serializeChapter(row);
}

function createBook(payload = {}) {
  const characterId = Number(payload.character_id);
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!char) throw new Error('角色不存在');

  if (payload.mode === 'illusion') {
    const userPremise = String(payload.user_premise || '').trim().slice(0, 1200);
    const styleCustoms = normalizeStyleCustoms(
      payload.style_customs != null ? payload.style_customs : payload.style_custom,
    );
    const title = String(payload.title || '').trim().slice(0, 80)
      || userPremise.slice(0, 24)
      || `幻象·${char.name}`;
    const r = db.prepare(`
      INSERT INTO series_books (
        character_id, mode, title, genres, genres_custom, era, era_custom,
        char_role, user_role, roles_blind, npc_free, npcs,
        length_type, total_chapters, style, style_custom, status, book_outline, chapter_outline,
        cast_list, char_role_kind, user_role_kind, story_source, user_premise, identity_lock, whatif_background
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      characterId,
      'illusion',
      title,
      '[]',
      '',
      '幻象',
      '',
      '',
      '',
      0,
      1,
      '[]',
      'flash',
      1,
      String(payload.style || 'gentle').trim().slice(0, 40),
      JSON.stringify(styleCustoms),
      'setup',
      '',
      '[]',
      '[]',
      '',
      '',
      JSON.stringify({ type: 'illusion' }),
      userPremise,
      '{}',
      '',
    );
    const bookId = r.lastInsertRowid;
    db.prepare(`
      INSERT INTO series_chapters (book_id, chapter_no, title, outline, content, status)
      VALUES (?,?,?,?,?,?)
    `).run(bookId, 1, '幻象', '', '', 'pending');
    touchBook(bookId);
    return getBook(bookId);
  }

  if (payload.mode === 'whatif') {
    const whatifBackground = String(payload.whatif_background || '').trim().slice(0, 2000);
    const userPremise = String(payload.user_premise || '').trim().slice(0, 1200);
    if (!whatifBackground) throw new Error('请填写背景设定');
    if (!userPremise) throw new Error('请填写「如果」前提');
    const styleCustoms = normalizeStyleCustoms(
      payload.style_customs != null ? payload.style_customs : payload.style_custom,
    );
    const title = String(payload.title || '').trim().slice(0, 80)
      || userPremise.slice(0, 36)
      || `如果·${char.name}`;
    const r = db.prepare(`
      INSERT INTO series_books (
        character_id, mode, title, genres, genres_custom, era, era_custom,
        char_role, user_role, roles_blind, npc_free, npcs,
        length_type, total_chapters, style, style_custom, status, book_outline, chapter_outline,
        cast_list, char_role_kind, user_role_kind, story_source, user_premise, identity_lock, whatif_background
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      characterId,
      'whatif',
      title,
      '[]',
      '',
      '情景',
      whatifBackground.slice(0, 120),
      '',
      '',
      0,
      1,
      '[]',
      'flash',
      1,
      String(payload.style || 'genre').trim().slice(0, 40),
      JSON.stringify(styleCustoms),
      'setup',
      '',
      '[]',
      '[]',
      '',
      '',
      JSON.stringify({ type: 'whatif' }),
      userPremise,
      '{}',
      whatifBackground,
    );
    const bookId = r.lastInsertRowid;
    db.prepare(`
      INSERT INTO series_chapters (book_id, chapter_no, title, outline, content, status)
      VALUES (?,?,?,?,?,?)
    `).run(bookId, 1, '如果', '', '', 'pending');
    touchBook(bookId);
    return getBook(bookId);
  }

  const lengthType = ['flash', 'short', 'medium', 'long'].includes(payload.length_type)
    ? payload.length_type
    : 'medium';
  const total = LENGTH_CHAPTERS[lengthType];
  const genres = Array.isArray(payload.genres) ? payload.genres.filter(Boolean).slice(0, 8) : [];
  const npcs = Array.isArray(payload.npcs)
    ? payload.npcs
      .map((n) => ({
        name: String(n.name || '').trim().slice(0, 40),
        relation: String(n.relation || '').trim().slice(0, 80),
      }))
      .filter((n) => n.name)
      .slice(0, 30)
    : [];
  const npcFree = payload.npc_free === false || payload.npc_free === 0 || payload.npc_free === '0' ? 0 : 1;
  const mode = payload.mode === 'isekai' ? 'isekai' : 'series';
  const rolesBlind = mode === 'isekai'
    ? (!(String(payload.user_role || '').trim() || String(payload.char_role || '').trim()) ? 1 : 0)
    : (payload.roles_blind === true || payload.roles_blind === 1 || payload.roles_blind === '1' ? 1 : 0);
  const styleCustoms = normalizeStyleCustoms(
    payload.style_customs != null ? payload.style_customs : payload.style_custom
  );
  // 穿越可选：书名导入 / 上传小说（正文稍后可补）
  let storySource = { type: 'original' };
  if (mode === 'isekai' && payload.story_source && typeof payload.story_source === 'object') {
    const t = String(payload.story_source.type || 'original').trim();
    if (t === 'title' || t === 'upload') {
      storySource = {
        type: t,
        title: String(payload.story_source.title || payload.title || '').trim().slice(0, 120),
        author: String(payload.story_source.author || '').trim().slice(0, 80),
        story: String(payload.story_source.story || '').trim().slice(0, 120),
        file_name: String(payload.story_source.file_name || '').trim().slice(0, 160),
        text: String(payload.story_source.text || '').slice(0, 500000),
        digest: String(payload.story_source.digest || '').slice(0, 12000),
        chars: 0,
      };
      storySource.chars = storySource.text.length || Number(payload.story_source.chars) || 0;
    }
  }
  const title = String(payload.title || '').trim().slice(0, 80)
    || (storySource.type === 'title' && storySource.title
      ? String(storySource.title).slice(0, 80)
      : '')
    || (mode === 'isekai' ? `与${char.name}的穿越` : `与${char.name}的剧集`);

  const userPremise = String(payload.user_premise || '').trim().slice(0, 1200);

  const isekaiPrefs = mode === 'isekai'
    ? normalizeRolePrefs({
      user_brief: payload.user_role,
      char_brief: payload.char_role,
      user_lead_lock: payload.user_lead_lock,
      char_lead_lock: payload.char_lead_lock,
    })
    : null;
  const identityLockInit = isekaiPrefs
    ? JSON.stringify({ role_prefs: isekaiPrefs })
    : '{}';

  const r = db.prepare(`
    INSERT INTO series_books (
      character_id, mode, title, genres, genres_custom, era, era_custom,
      char_role, user_role, roles_blind, npc_free, npcs,
      length_type, total_chapters, style, style_custom, status, book_outline, chapter_outline,
      cast_list, char_role_kind, user_role_kind, story_source, user_premise, identity_lock
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    characterId,
    mode,
    title,
    JSON.stringify(genres),
    String(payload.genres_custom || '').trim().slice(0, 200),
    String(payload.era || '现代').trim().slice(0, 80),
    String(payload.era_custom || '').trim().slice(0, 120),
    mode === 'isekai' ? '' : String(payload.char_role || '').trim().slice(0, 120),
    mode === 'isekai' ? '' : String(payload.user_role || '').trim().slice(0, 120),
    rolesBlind,
    npcFree,
    JSON.stringify(npcs),
    lengthType,
    total,
    String(payload.style || 'genre').trim().slice(0, 40),
    JSON.stringify(styleCustoms),
    'setup',
    '',
    '[]',
    '[]',
    '',
    '',
    JSON.stringify(storySource),
    userPremise,
    identityLockInit,
  );

  const bookId = r.lastInsertRowid;
  const ins = db.prepare(`
    INSERT INTO series_chapters (book_id, chapter_no, title, outline, content, status)
    VALUES (?,?,?,?,?,?)
  `);
  for (let i = 1; i <= total; i++) {
    ins.run(bookId, i, `第${i}章`, '', '', 'pending');
  }
  touchBook(bookId);
  return getBook(bookId);
}

function touchBook(bookId) {
  db.prepare(`UPDATE series_books SET updated_at=datetime('now') WHERE id=?`).run(bookId);
}

function updateBook(bookId, patch = {}) {
  const row = db.prepare('SELECT * FROM series_books WHERE id=?').get(bookId);
  if (!row) throw new Error('剧集不存在');
  const book = serializeBook(row);
  const next = {
    title: patch.title != null ? String(patch.title).trim().slice(0, 80) : book.title,
    genres: patch.genres != null ? patch.genres : book.genres,
    genres_custom: patch.genres_custom != null ? String(patch.genres_custom).trim().slice(0, 200) : book.genres_custom,
    era: patch.era != null ? String(patch.era).trim().slice(0, 80) : book.era,
    era_custom: patch.era_custom != null ? String(patch.era_custom).trim().slice(0, 120) : book.era_custom,
    char_role: patch.char_role != null ? String(patch.char_role).trim().slice(0, 120) : book.char_role,
    user_role: patch.user_role != null ? String(patch.user_role).trim().slice(0, 120) : book.user_role,
    npc_free: patch.npc_free != null
      ? (patch.npc_free === false || patch.npc_free === 0 || patch.npc_free === '0' ? 0 : 1)
      : (book.npc_free ? 1 : 0),
    npcs: patch.npcs != null ? patch.npcs : book.npcs,
    style: patch.style != null ? String(patch.style).trim().slice(0, 40) : book.style,
    style_customs: patch.style_customs != null
      ? normalizeStyleCustoms(patch.style_customs)
      : (patch.style_custom != null
        ? normalizeStyleCustoms(patch.style_custom)
        : (book.style_customs || [])),
    user_premise: patch.user_premise != null
      ? String(patch.user_premise).trim().slice(0, 1200)
      : (book.user_premise || ''),
    whatif_background: patch.whatif_background != null
      ? String(patch.whatif_background).trim().slice(0, 2000)
      : (book.whatif_background || ''),
    status: (() => {
      if (patch.status == null) return book.status;
      const st = String(patch.status).trim().slice(0, 40);
      // 禁止客户端随意改写进度态
      const allowed = ['setup'];
      if (!allowed.includes(st)) return book.status;
      return st;
    })(),
  };
  const setWhatifBg = book.mode === 'whatif' && book.status === 'setup'
    ? ', whatif_background=?'
    : '';
  db.prepare(`
    UPDATE series_books SET
      title=?, genres=?, genres_custom=?, era=?, era_custom=?,
      char_role=?, user_role=?, npc_free=?, npcs=?,
      style=?, style_custom=?, user_premise=?, status=?, updated_at=datetime('now')${setWhatifBg}
    WHERE id=?
  `).run(
    ...[
      next.title,
      JSON.stringify(Array.isArray(next.genres) ? next.genres : []),
      next.genres_custom || '',
      next.era || '现代',
      next.era_custom || '',
      next.char_role || '',
      next.user_role || '',
      next.npc_free,
      JSON.stringify(Array.isArray(next.npcs) ? next.npcs : []),
      next.style || 'genre',
      JSON.stringify(next.style_customs || []),
      next.user_premise || '',
      next.status || book.status,
      ...(setWhatifBg ? [next.whatif_background || ''] : []),
      bookId,
    ],
  );
  return getBook(bookId);
}

function deleteBook(bookId) {
  try { db.prepare('DELETE FROM series_turns WHERE book_id=?').run(bookId); } catch (_) {}
  try { db.prepare('DELETE FROM series_jobs WHERE book_id=?').run(bookId); } catch (_) {}
  db.prepare('DELETE FROM series_memories WHERE book_id=?').run(bookId);
  db.prepare('DELETE FROM series_chapters WHERE book_id=?').run(bookId);
  db.prepare('DELETE FROM series_books WHERE id=?').run(bookId);
  return { ok: true };
}

async function generateBlindRoles(bookId) {
  const book = getBook(bookId);
  if (!book) throw new Error('剧集不存在');
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const settings = getSettings();
  const core = charCoreForSeries(char);
  const genres = genreText(book.genres, book.genres_custom);
  const era = resolveEra(book.era, book.era_custom);
  const userName = String(settings.username || '旅人').trim() || '旅人';
  const premise = userPremiseBlock(book);
  const system = `你为长篇小说分配男女主「身份/职业」，不改姓名。只输出 JSON：{"char_role":"男主身份","user_role":"女主身份","title_hint":"可选书名灵感"}。
硬性：
1. 男主姓名已固定为「${core.name}」，女主姓名已固定为「${userName}」——禁止在 char_role/user_role 里写新名字或「某某·身份」这种改名写法，只写身份/职业（如「禁术调查员」「女扮男装的书童」）。
2. 男主=角色侧，女主=用户侧；性别不变。女主可「女扮男装」身份，但本质仍是女主。
3. 身份要贴合类型「${genres}」与背景「${era}」（时代或地点均可），有戏剧冲突。禁止配角身份。
${premise ? `${premise}\n若梗概已暗示身份，优先沿用其方向。` : ''}`;
  const user = `男主气质参考——名：${core.name}（姓名勿改）；性格：${core.personality}；外貌：${core.appearance}
女主名：${userName}（姓名勿改）`;
  let raw;
  try {
    raw = await callChatAPIComplete(settings, system, user, 'series');
  } catch (e) {
    throw new Error(formatApiBillingError(e.message, { label: '剧集' }) || e.message || '盲盒失败');
  }
  if (!raw) {
    const cred = resolveTaskApiCreds(settings, 'series');
    if (!cred.url || !cred.apiKey || !cred.model) {
      throw new Error('请先在设置中配置剧集 API（地址、Key、模型）');
    }
    throw new Error('盲盒失败：模型返回空内容');
  }
  const m = String(raw).match(/\{[\s\S]*\}/);
  let obj = {};
  try { obj = JSON.parse(m ? m[0] : raw); } catch { obj = {}; }
  const charRole = String(obj.char_role || '').trim().slice(0, 120);
  const userRole = String(obj.user_role || '').trim().slice(0, 120);
  if (!charRole || !userRole) throw new Error('盲盒结果无效，请重试');
  // 去掉模型误塞的姓名前缀（如「顾深·调查员」「叫某某的法医」）
  const stripNamePrefix = (role, names) => {
    let s = String(role || '').trim();
    for (const n of names) {
      const name = String(n || '').trim();
      if (!name) continue;
      s = s.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[·•\\-—:：\\s]+`), '');
      s = s.replace(new RegExp(`^叫?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}的`), '');
    }
    return s.trim() || String(role || '').trim();
  };
  const patch = {
    char_role: stripNamePrefix(charRole, [core.name]),
    user_role: stripNamePrefix(userRole, [userName]),
  };
  if (!book.title || book.title.startsWith('与')) {
    const hint = String(obj.title_hint || '').trim().slice(0, 80);
    if (hint) patch.title = hint;
  }
  db.prepare(`UPDATE series_books SET roles_blind=1 WHERE id=?`).run(bookId);
  return updateBook(bookId, patch);
}

function ensureRoles(book) {
  if (!String(book.char_role || '').trim() || !String(book.user_role || '').trim()) {
    throw new Error('请先填写或盲盒生成男女主身份');
  }
}

function requireSeriesApi(settings = getSettings(), purpose = 'series') {
  const slot = purpose === 'outline' ? 'series_outline'
    : purpose === 'play' ? 'series_play'
      : 'series';
  const { url, apiKey, model } = resolveTaskApiCreds(settings, slot);
  if (!url || !apiKey || !model) {
    throw new Error('请先在「设置 → 时空 API」填写地址、Key，并至少配置「通用 / 大纲 / 游玩」之一的模型（不走聊天 API）');
  }
  return { url, apiKey, model };
}

/** 字符串字面量内的裸换行/控制符 → 转义（模型常见坏 JSON） */
function escapeRawControlsInJsonStrings(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch.charCodeAt(0) < 32) continue;
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/** 宽松修补：单引号键/值、尾逗号、全角冒号等 */
function softenJsonText(text) {
  let s = String(text || '');
  s = s.replace(/^\uFEFF/, '');
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  s = s.replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"').replace(/[\u2018\u2019\u201a\u201b]/g, "'");
  s = s.replace(/：/g, ':');
  // { 'key': 'val' } / { key: "val" } → 双引号键
  s = s.replace(/([{,]\s*)'([^'\\]+)'(\s*:)/g, '$1"$2"$3');
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  // 值侧单引号字符串（粗修，足够应付大纲短字段）
  s = s.replace(/:(\s*)'([^'\\]*)'/g, ':$1"$2"');
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return s;
}

function tryParseJsonLoose(text) {
  const tryParse = (t) => {
    try { return JSON.parse(t); } catch (_) { return null; }
  };
  let s = String(text || '').trim();
  if (!s) return null;
  let ok = tryParse(s) || tryParse(escapeRawControlsInJsonStrings(s));
  if (ok) return ok;
  const soft = softenJsonText(s);
  ok = tryParse(soft) || tryParse(escapeRawControlsInJsonStrings(soft));
  if (ok) return ok;

  // 截断补括号（忽略字符串内计数误差时的兜底）
  let repaired = escapeRawControlsInJsonStrings(soft || s)
    .replace(/,\s*"[^"]*$/, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/,\s*$/, '');
  let openCurly = 0;
  let openSquare = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') openCurly += 1;
    else if (ch === '}') openCurly -= 1;
    else if (ch === '[') openSquare += 1;
    else if (ch === ']') openSquare -= 1;
  }
  while (openSquare > 0) { repaired += ']'; openSquare -= 1; }
  while (openCurly > 0) { repaired += '}'; openCurly -= 1; }
  return tryParse(repaired);
}

/** 从模型输出里抠 JSON（去 code fence、截断时尽量补全） */
function extractJsonObject(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = softenJsonText(s);
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  let start = -1;
  if (objStart >= 0 && (arrStart < 0 || objStart <= arrStart)) start = objStart;
  else if (arrStart >= 0) start = arrStart;
  if (start < 0) return null;
  s = s.slice(start);

  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const slice = end >= 0 ? s.slice(0, end + 1) : s;
  let parsed = tryParseJsonLoose(slice) || tryParseJsonLoose(s);
  if (!parsed) return null;

  if (Array.isArray(parsed)) {
    const firstObj = parsed.find((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (firstObj) parsed = firstObj;
    else if (parsed.every((x) => typeof x === 'string')) parsed = { beats: parsed };
    else return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return normalizeOutlineFieldAliases(parsed);
}

/** 中英字段名兼容，减少「有 JSON 但判不可用」 */
function normalizeOutlineFieldAliases(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  const alias = [
    ['title', ['书名', '标题', 'name', '剧名', '剧本名']],
    ['logline', ['一句话', '悬念', '一句话悬念', 'log_line']],
    ['synopsis', ['梗概', '简介', '大纲', '故事梗概', 'summary', 'overview', '剧情']],
    ['arcs', ['阶段', '篇章', 'arcs_list', '结构']],
    ['beats', ['节拍', '分章要点', 'chapter_beats']],
    ['chapters', ['分章', '章节', 'chapter_list']],
  ];
  for (const [canonical, keys] of alias) {
    if (out[canonical] != null && out[canonical] !== '') continue;
    for (const k of keys) {
      if (out[k] != null && out[k] !== '') {
        out[canonical] = out[k];
        break;
      }
    }
  }
  if (typeof out.arcs === 'string' && out.arcs.trim()) {
    out.synopsis = out.synopsis || out.arcs;
    delete out.arcs;
  }
  if (typeof out.beats === 'string' && out.beats.trim()) {
    out.beats = out.beats.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  }
  return out;
}

function outlineHasUsableBody(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.synopsis || obj.logline || obj.title) return true;
  if (Array.isArray(obj.arcs) && obj.arcs.length) return true;
  if (Array.isArray(obj.beats) && obj.beats.length) return true;
  if (Array.isArray(obj.chapters) && obj.chapters.length) return true;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.replace(/\s/g, '').length >= 20) {
      obj.synopsis = obj.synopsis || v.slice(0, 200);
      return true;
    }
  }
  return false;
}

function buildNovelOutlineUserPrompt(book, { withCast = false, compact = false } = {}) {
  const n = book.total_chapters;
  const len = LENGTH_LABELS[book.length_type] || '中篇';
  const genresLabel = genreText(book.genres, book.genres_custom);
  const era = resolveEra(book.era, book.era_custom);
  const isIk = book.mode === 'isekai';
  const premise = userPremiseBlock(book);
  const nameLock = !isIk
    ? `男女主姓名固定：男主「${String(book.char_name || '').trim() || '角色原名'}」、女主「${String(getSettings()?.username || '旅人').trim() || '旅人'}」；大纲只改身份/处境，禁止另起新名。`
    : '';

  const noSpoil = outlineNoSpoilerRules(book.genres);
  const diversity = plotDiversityRules(book.genres, era, book);
  const prefsLine = isIk ? rolePrefsPromptBlock(book) : '';
  const synHint = isMysteryLikeGenre(book.genres)
    ? '只写悬念与冲突，勿写凶手/答案/结局揭秘'
    : isHorrorGenre(book.genres)
      ? '只写压迫与未知气氛，勿剧透实体真身；不必写成破案破局'
      : isInfiniteGenre(book.genres)
        ? '只写关卡压力与悬念，勿写通关公式'
        : '主线冲突与走向（可含结局气氛，勿写成完整细纲）';

  if (compact) {
    const setupEnd = Math.max(1, Math.ceil(n * 0.2));
    const midEnd = Math.max(setupEnd + 1, Math.ceil(n * 0.75));
    return `「${len}」恰好${n}章完整故事粗纲。类型：${genresLabel}；背景：${era}（时代或地点）。
${nameLock}
${premise ? `${premise}\n` : ''}${prefsLine ? `${prefsLine}\n` : ''}${diversity ? `${diversity}\n` : ''}只输出一个可 JSON.parse 的对象，禁止 markdown/解释/对白：
{"title":"书名","logline":"一句话悬念","synopsis":"80字内梗概（${synHint}；须能在${n}章内收束；若有用户梗概须与之同向）","arcs":[{"name":"开局","from":1,"to":${setupEnd},"beat":"立人设与核心冲突"},{"name":"发展","from":${setupEnd + 1},"to":${midEnd},"beat":"推进升级与转折"},{"name":"收束","from":${Math.min(n, midEnd + 1)},"to":${n},"beat":"高潮并收束全书主线"}]}
要求：arcs 覆盖 1～${n}；第${n}章必须有结局功能；不要 beats/chapters/cast；字段值用英文双引号，字符串内不要未转义换行。
${noSpoil}`;
  }

  const castBlock = withCast
    ? `,\n  "cast":[{"name":"角色名","gender":"female|male","kind":"female_lead|male_lead|npc","brief":"一句话身份"}]`
    : '';
  const castRule = withCast
    ? `- cast 至少 6 人，含 1 female_lead + 1 male_lead，其余 npc；gender 与 kind 一致\n`
    : '';
  const setupEnd = Math.max(1, Math.ceil(n * 0.2));
  const midEnd = Math.max(setupEnd + 1, Math.ceil(n * 0.75));
  return `请写「${len}」小说粗纲：全书恰好 ${n} 章，必须在这 ${n} 章内讲完一个完整故事。类型：${genresLabel}；背景：${era}（时代或地点）。只要结构，不要细纲/正文。
${nameLock}
${premise ? `${premise}\n` : ''}${prefsLine ? `${prefsLine}\n` : ''}${diversity ? `${diversity}\n` : ''}只输出一个 JSON 对象（可被 JSON.parse），不要 markdown，不要解释：
{
  "title":"书名",
  "logline":"一句话悬念（不剧透答案）",
  "synopsis":"全书梗概，120字内；${synHint}；冲突与收束都要落在${n}章内；若有用户梗概须压缩同向改写，勿另起炉灶",
  "arcs":[
    {"name":"开局","from":1,"to":${setupEnd},"beat":"立人设与核心冲突"},
    {"name":"发展","from":${setupEnd + 1},"to":${midEnd},"beat":"推进升级与转折"},
    {"name":"收束","from":${Math.min(n, midEnd + 1)},"to":${n},"beat":"高潮并收束全书主线"}
  ]${castBlock}
}
硬性要求：
- arcs 用 3～6 段覆盖 1～${n} 章；写阶段功能，不写场面
- 前约 20% 立冲突，中段推进与转折，末约 25% 高潮并收束；第 ${n} 章必须具备结局功能，禁止「未完待续」式悬空
- 不要输出 beats/chapters（系统会按 arcs 生成分章）
- 禁止对白、分镜、心理描写
- 起承转合完整，类型主题贯穿
- 剧情背景按类型与背景（时代或地点）任意原创，不要受角色真身职业/身世影响；${!isIk ? '姓名固定不改' : '穿越可另有剧中名'}
- 字符串用英文双引号；字符串内换行请写成 \\n
${castRule}${noSpoil}`;
}

/** 大纲专用短系统提示：避免套用超长叙事人设导致模型写散文 */
function buildOutlineSystemPrompt(book) {
  const genresLabel = genreText(book.genres, book.genres_custom);
  // 大纲阶段只要类型要点，避免多选题材时规则过长挤占输出
  const genreRules = String(genreRulesText(book.genres, book.genres_custom) || '').slice(0, 700);
  const era = resolveEra(book.era, book.era_custom);
  const noSpoil = outlineNoSpoilerRules(book.genres);
  const n = Number(book.total_chapters) || LENGTH_CHAPTERS.medium;
  const premise = userPremiseBlock(book);
  const diversity = plotDiversityRules(book.genres, era, book);
  return `你是小说结构规划器，不是小说正文作者。
【任务】只输出合法 JSON 粗纲对象（短小完整即可，不要写分章细纲）。
【类型】${genresLabel}
【类型写法】
${genreRules}
【背景】${era}（可为时代、地点或世界观）
【篇幅硬性】全书恰好约 ${n} 章，必须在这 ${n} 章内讲完一个完整故事（开局→发展→高潮→收束）。禁止写成「还需续集才完结」；禁止前半只铺垫、末章仍悬空。
${premise ? `${premise}\n` : ''}${diversity ? `${diversity}\n` : ''}${noSpoil}
【禁止】markdown 代码块外的解释、样章、对白、细纲场面；禁止输出 JSON 以外的任何文字；禁止输出 chapters/beats 长数组。
【格式】顶层必须是 { ... }；键名与字符串一律英文双引号；字符串内不要裸换行。`;
}

async function requestOutlineObject(book, { withCast = false, label = '时空大纲' } = {}) {
  const settings = getSettings();
  requireSeriesApi(settings);
  const system = buildOutlineSystemPrompt(book);
  const n = Number(book.total_chapters) || LENGTH_CHAPTERS.medium;
  const genresLabel = genreText(book.genres, book.genres_custom);
  const era = resolveEra(book.era, book.era_custom);
  const setupEnd = Math.max(1, Math.ceil(n * 0.2));
  const midEnd = Math.max(setupEnd + 1, Math.ceil(n * 0.75));

  // 中篇/长篇优先极短 JSON，再逐步放宽；token 随篇幅略增；带 cast 放到最后且可选
  const tok = (base) => (n >= 40 ? base + 800 : n >= 20 ? base + 500 : base);
  const attempts = [
    { kind: 'minimal', maxTokens: tok(1200) },
    { kind: 'compact', maxTokens: tok(1800) },
    { kind: 'full', withCast: false, maxTokens: tok(2400) },
  ];
  // 仅在明确要求 withCast 时追加一轮（角色可后补，不要挡骨架）
  if (withCast) attempts.push({ kind: 'full', withCast: true, maxTokens: tok(3000) });
  let lastPreview = '';
  let lastRaw = '';

  const accept = (raw) => {
    const obj = extractJsonObject(raw);
    if (obj && outlineHasUsableBody(obj)) return obj;
    return null;
  };

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    let user = '';
    if (a.kind === 'minimal') {
      const premise = userPremiseBlock(book);
      const prefsLine = book.mode === 'isekai' ? rolePrefsPromptBlock(book) : '';
      user = `类型：${genresLabel}；背景：${era}；共${n}章。
${premise ? `${premise}\n` : ''}${prefsLine ? `${prefsLine}\n` : ''}只输出这一行结构的 JSON（不要 markdown/解释，不要 chapters）：
{"title":"书名","logline":"一句话","synopsis":"80字梗概","arcs":[{"name":"开局","from":1,"to":${setupEnd},"beat":"立冲突"},{"name":"发展","from":${setupEnd + 1},"to":${midEnd},"beat":"升级转折"},{"name":"收束","from":${Math.min(n, midEnd + 1)},"to":${n},"beat":"高潮收束"}]}`;
    } else {
      user = buildNovelOutlineUserPrompt(book, {
        withCast: !!a.withCast,
        compact: a.kind === 'compact',
      });
    }
    let raw = '';
    try {
      raw = await chatLong(settings, system, user, {
        maxTokens: a.maxTokens,
        continueRounds: 3,
        targetMin: 0,
        emptyRetries: 1,
        format: 'json',
        temperature: 0.45,
      });
    } catch (e) {
      lastPreview = String(e.message || '').slice(0, 120);
      if (i === attempts.length - 1 && !lastRaw) {
        throw new Error(formatApiBillingError(e.message, { label }) || e.message || '大纲生成失败');
      }
      continue;
    }
    lastRaw = raw;
    lastPreview = String(raw || '').replace(/\s+/g, ' ').slice(0, 160);
    const obj = accept(raw);
    if (obj) return obj;
    console.warn(`[series] outline parse miss attempt=${a.kind} preview=${lastPreview}`);
  }

  // 最后一轮：把坏输出交给模型改写成合法 JSON
  if (lastRaw && String(lastRaw).trim().length >= 8) {
    try {
      const fixed = await chatLong(
        settings,
        '你是 JSON 修复器。只输出一个合法 JSON 对象，不要解释，不要 markdown。不要输出 chapters/beats。',
        `把下面内容改成可 JSON.parse 的短大纲对象，字段只用：title,logline,synopsis,arcs(数组，含 name/from/to/beat)。共${n}章，arcs 覆盖 1～${n}。\n---\n${String(lastRaw).slice(0, 2800)}`,
        {
          maxTokens: tok(1400),
          continueRounds: 2,
          targetMin: 0,
          emptyRetries: 1,
          format: 'json',
          temperature: 0.2,
        },
      );
      const obj = accept(fixed);
      if (obj) return obj;
      lastPreview = String(fixed || '').replace(/\s+/g, ' ').slice(0, 160);
    } catch (e) {
      console.warn('[series] outline repair failed', e.message);
    }
  }

  // 最后兜底：用本地三段 arcs 骨架，避免中篇因模型 JSON 翻车整本失败
  console.warn(`[series] outline all attempts failed, using local skeleton. preview=${lastPreview}`);
  const premiseText = String(book.user_premise || '').trim();
  return {
    title: String(book.title || `${genresLabel}故事`).trim().slice(0, 40) || '未名故事',
    logline: premiseText
      ? premiseText.replace(/\s+/g, ' ').slice(0, 40)
      : `${genresLabel}背景下的命运纠葛`,
    synopsis: premiseText
      ? premiseText.replace(/\s+/g, ' ').slice(0, 200)
      : `在「${era}」背景下，关键人物卷入核心冲突，历经试炼与抉择，于第${n}章收束命运。`,
    arcs: [
      { name: '开局', from: 1, to: setupEnd, beat: '立人设与核心冲突' },
      { name: '发展', from: setupEnd + 1, to: midEnd, beat: '推进升级与转折' },
      { name: '收束', from: Math.min(n, midEnd + 1), to: n, beat: '高潮并收束全书主线' },
    ],
  };
}

function chaptersFromArcs(arcs, n) {
  const list = Array.isArray(arcs) ? arcs : [];
  const out = [];
  for (let i = 1; i <= n; i++) {
    const arc = list.find((a) => {
      const from = Number(a.from) || 1;
      const to = Number(a.to) || n;
      return i >= from && i <= to;
    }) || list[Math.min(list.length - 1, Math.floor(((i - 1) / n) * list.length))] || null;
    let beat = String(arc?.beat || arc?.name || '').trim().slice(0, 28);
    if (!beat || beat === '推进主线') {
      const ratio = i / Math.max(1, n);
      if (i === n) beat = '高潮收束，了结全书主线';
      else if (ratio <= 0.2) beat = '立冲突与人物关系';
      else if (ratio <= 0.75) beat = '冲突升级与关键转折';
      else beat = '逼近高潮并铺收束';
    }
    out.push({ no: i, title: `第${i}章`, summary: beat.endsWith('。') ? beat : `${beat}。` });
  }
  return out;
}

function normalizeOutlineChapters(obj, n) {
  // 优先 beats 字符串数组（更抗截断）
  if (Array.isArray(obj?.beats) && obj.beats.length) {
    const chapters = obj.beats.map((b, i) => ({
      no: i + 1,
      title: `第${i + 1}章`,
      summary: String(b || '').replace(/^第?\d+章[:：\s]*/, '').trim().slice(0, 40) || '推进主线。',
    }));
    while (chapters.length < n) {
      const i = chapters.length + 1;
      chapters.push({ no: i, title: `第${i}章`, summary: '推进主线。' });
    }
    return chapters.slice(0, n);
  }

  let chapters = Array.isArray(obj?.chapters) ? obj.chapters : [];
  chapters = chapters
    .map((c, i) => ({
      no: Number(c.no) || i + 1,
      title: String(c.title || `第${i + 1}章`).trim().slice(0, 40),
      summary: String(c.summary || '').trim().slice(0, 40),
    }))
    .slice(0, n);

  // 模型只给了部分章：用 arcs 补全，而不是整本失败
  if (chapters.length < Math.min(n, 3) && Array.isArray(obj?.arcs) && obj.arcs.length) {
    return chaptersFromArcs(obj.arcs, n);
  }
  if (chapters.length < n && Array.isArray(obj?.arcs) && obj.arcs.length) {
    const filled = chaptersFromArcs(obj.arcs, n);
    for (let i = 0; i < n; i++) {
      if (!chapters[i] || !chapters[i].summary) chapters[i] = filled[i];
      else chapters[i] = { ...filled[i], ...chapters[i], no: i + 1 };
    }
    return chapters.slice(0, n);
  }
  while (chapters.length < n) {
    const i = chapters.length + 1;
    chapters.push({ no: i, title: `第${i}章`, summary: '推进主线。' });
  }
  return chapters;
}

function composeBookOutlineText(obj) {
  const logline = String(obj.logline || '').trim();
  const synopsis = String(obj.synopsis || '').trim();
  const arcs = Array.isArray(obj.arcs) ? obj.arcs : [];
  const arcLines = arcs.map((a) => {
    const name = String(a.name || '阶段').trim();
    const from = a.from != null ? a.from : '';
    const to = a.to != null ? a.to : '';
    const span = from !== '' && to !== '' ? `（第${from}-${to}章）` : '';
    const beat = String(a.beat || '').trim();
    return `· ${name}${span}：${beat}`;
  }).filter((l) => l.length > 4);
  const parts = [];
  if (logline) parts.push(`【一句话】${logline}`);
  if (synopsis) parts.push(`【梗概】${synopsis}`);
  if (arcLines.length) parts.push(`【阶段】\n${arcLines.join('\n')}`);
  return parts.join('\n\n').slice(0, 2000);
}

/**
 * 引擎完整大纲（含真相）：只给模型，不下发前端。
 * 用户侧仍用 book_outline / chapter_outline（悬疑防剧透版）。
 */
function normalizeCanonLock(raw, book, cast, identityLock) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const n = Number(book?.total_chapters) || 20;
  const truth = o.truth && typeof o.truth === 'object' ? o.truth : {};
  const chapters = Array.isArray(o.chapters) ? o.chapters : [];
  const castSec = Array.isArray(o.cast) ? o.cast : [];
  const rel = Array.isArray(truth.relationships) ? truth.relationships : [];
  const lockU = identityLock?.user || {};
  const lockC = identityLock?.char || {};

  const normCh = [];
  for (let i = 1; i <= n; i++) {
    const hit = chapters.find((c) => Number(c.no) === i) || chapters[i - 1] || {};
    normCh.push({
      no: i,
      public_beat: String(hit.public_beat || hit.beat || '').trim().slice(0, 80),
      engine_beat: String(hit.engine_beat || hit.full_beat || hit.beat || '').trim().slice(0, 160),
      reveal: String(hit.reveal || '').trim().slice(0, 120),
      hold: String(hit.hold || '').trim().slice(0, 120),
    });
  }

  let castOut = castSec.map((c) => ({
    name: String(c.name || '').trim().slice(0, 40),
    public_face: String(c.public_face || c.brief || '').trim().slice(0, 80),
    secret: String(c.secret || c.true_role || '').trim().slice(0, 120),
    knows: String(c.knows || '').trim().slice(0, 100),
  })).filter((c) => c.name);

  if (!castOut.length && Array.isArray(cast)) {
    castOut = cast.slice(0, 16).map((c) => ({
      name: String(c.name || '').trim().slice(0, 40),
      public_face: String(c.brief || '').trim().slice(0, 80),
      secret: String(c.kind || 'npc').trim().slice(0, 120),
      knows: '',
    })).filter((c) => c.name);
  }

  return {
    locked: true,
    world: String(o.world || '').trim().slice(0, 200),
    synopsis_full: String(o.synopsis_full || o.synopsis || '').trim().slice(0, 600),
    truth: {
      core: String(truth.core || '').trim().slice(0, 200),
      culprit_or_key: String(truth.culprit_or_key || truth.culprit || '').trim().slice(0, 120),
      motive: String(truth.motive || '').trim().slice(0, 160),
      method_or_mechanism: String(truth.method_or_mechanism || truth.method || '').trim().slice(0, 160),
      key_evidence: (Array.isArray(truth.key_evidence) ? truth.key_evidence : [])
        .map((x) => String(x || '').trim().slice(0, 80)).filter(Boolean).slice(0, 8),
      red_herrings: (Array.isArray(truth.red_herrings) ? truth.red_herrings : [])
        .map((x) => String(x || '').trim().slice(0, 80)).filter(Boolean).slice(0, 6),
      relationships: rel.map((r) => ({
        a: String(r.a || r.from || '').trim().slice(0, 40),
        b: String(r.b || r.to || '').trim().slice(0, 40),
        rel: String(r.rel || r.relation || '').trim().slice(0, 80),
      })).filter((r) => r.a && r.b).slice(0, 20),
      ending: String(truth.ending || '').trim().slice(0, 200),
    },
    player_bind: {
      user_surface: String(lockU.surface_name || book?.user_role || '').trim(),
      user_true: `${lockU.true_kind || ''}｜${lockU.true_secret || ''}`.trim(),
      char_surface: String(lockC.surface_name || book?.char_role || '').trim(),
      char_true: `${lockC.true_kind || ''}｜${lockC.true_secret || ''}`.trim(),
    },
    cast: castOut.slice(0, 20),
    chapters: normCh,
  };
}

function formatCanonBlockForPrompt(book, { chapterNo = 0 } = {}) {
  const canon = book?.canon_lock;
  if (!canon || !canon.locked) return '';
  const t = canon.truth || {};
  const rel = (t.relationships || []).slice(0, 12)
    .map((r) => `${r.a}↔${r.b}：${r.rel}`).join('；');
  const evidence = (t.key_evidence || []).join('；');
  const herring = (t.red_herrings || []).join('；');
  const castLines = (canon.cast || []).slice(0, 12)
    .map((c) => `- ${c.name}｜表面：${c.public_face || '—'}｜秘密：${c.secret || '—'}｜知情：${c.knows || '—'}`)
    .join('\n');
  const chNo = Number(chapterNo) || 0;
  let chapterLine = '';
  if (chNo > 0) {
    const ch = (canon.chapters || []).find((c) => Number(c.no) === chNo);
    if (ch) {
      const prevCh = chNo > 1
        ? (canon.chapters || []).find((c) => Number(c.no) === chNo - 1)
        : null;
      chapterLine = `【本章引擎节拍·第${chNo}章·锁定必须演到】
完整节拍：${ch.engine_beat || ch.public_beat || '（按大纲）'}
本章可露出：${ch.reveal || '按剧情推进线索'}
本章禁止揭晓：${ch.hold || '终局答案与未到时机的关键反转'}${prevCh ? `
【上一章引擎节拍·已发生】${prevCh.engine_beat || prevCh.public_beat || ''}
开场可用一两拍从上章收束带过（章末若是认人/同伴戏，先把余波带过），然后必须进入本章引擎节拍。禁止把上一章节拍续写成本章，禁止用认人戏替换本章节拍。` : ''}`;
    }
  } else {
    chapterLine = `【分章引擎节拍·摘要】\n${(canon.chapters || []).slice(0, 24).map((c) =>
      `第${c.no}章：${c.engine_beat || c.public_beat || ''}`
    ).filter((l) => l.length > 6).join('\n')}`.slice(0, 1800);
  }
  const pb = canon.player_bind || {};
  return `【引擎完整大纲·已锁定·禁止改写】
世界观：${canon.world || '（见梗概）'}
完整梗概：${canon.synopsis_full || '（见公开大纲，引擎侧已定结局方向）'}
核心设定：${t.core || '（按类型自洽，一经写出不得改口）'}
关键人物/压迫源或关键（悬疑才是真凶）：${t.culprit_or_key || '（已定；恐怖可为空/压迫源）'}
动机：${t.motive || '—'}
手法/机制：${t.method_or_mechanism || '—'}
关键物证：${evidence || '—'}
误导：${herring || '—'}
人物关系网：${rel || '—'}
结局落点：${t.ending || '—'}
穿越者绑定：用户表面=${pb.user_surface || '？'}｜真=${pb.user_true || '锁'}；同伴表面=${pb.char_surface || '？'}｜真=${pb.char_true || '锁'}
角色秘密表：
${castLines || '（见角色池）'}
${chapterLine}
【硬性】以上为全书标准答案。NPC 知情范围按「knows」与身份；玩家盘问可得其该知道的信息，不可因陪玩改凶手/改关系/改结局。禁止前后矛盾。`;
}

async function lockEngineCanon(book, {
  outlineObj = null,
  cast = null,
  identityLock = null,
  chapters = null,
  force = false,
} = {}) {
  // 已锁定则永不重写——游玩中设定不能飘；仅大纲阶段 force 才允许换一份新真相
  if (book?.canon_lock?.locked && !force) {
    return book.canon_lock;
  }
  const settings = getSettings();
  requireSeriesApi(settings);
  const n = Number(book.total_chapters) || 20;
  const genresLabel = genreText(book.genres, book.genres_custom);
  const era = resolveEra(book.era, book.era_custom);
  const spoil = isSpoilerSensitiveGenre(book.genres);
  const mysteryLike = isMysteryLikeGenre(book.genres);
  const horrorLike = isHorrorGenre(book.genres);
  const infiniteLike = isInfiniteGenre(book.genres);
  const publicOutline = String(book.book_outline || outlineObj?.synopsis || '').slice(0, 500);
  const publicCh = (chapters || book.chapter_outline || []).slice(0, n)
    .map((c) => `第${c.no || c.chapter_no}章 ${c.title || ''}：${c.summary || c.outline || ''}`)
    .join('\n');
  const castBrief = (cast || book.cast_list || []).slice(0, 14)
    .map((c) => `${c.name}/${c.kind || 'npc'}/${c.gender || '?'}:${c.brief || ''}`)
    .join('；');
  const idLock = identityLock || book.identity_lock || {};
  const u = idLock.user || {};
  const ch = idLock.char || {};
  const idBrief = idLock.locked
    ? `用户真身份=${u.true_kind}|${u.true_secret}；同伴真身份=${ch.true_kind}|${ch.true_secret}；表面名用户=${u.surface_name}同伴=${ch.surface_name}`
    : `男女主：${book.char_role || ''} / ${book.user_role || ''}`;

  const romancePrimary = isRomancePrimaryGenre(book.genres) && !mysteryLike;
  const truthHint = mysteryLike
    ? '悬疑/惊悚：必须写明真凶或关键机制、动机、物证、误导与人物关系网。'
    : romancePrimary
      ? '言情：核心冲突围绕感情、误会与关系抉择；culprit_or_key 写关系关键或误会源头，不要写成刑侦破案。'
      : horrorLike
        ? '恐怖：写明压迫来源与危险机制即可；可不设人间真凶，也不必强行安排可破解之法；结局可以是逃离/撑过/未知残留。'
        : infiniteLike
          ? '无限流：写明副本规则与通关条件（引擎侧），人物关系与结局落点；不要硬写成悬疑破案。'
          : '按类型写明核心冲突、关键人物真实关系与结局落点。';

  const system = `你是剧本「引擎完整大纲」策划。只输出合法 JSON。
这份大纲只给写作引擎，必须含完整设定真相，写完即锁定，游玩中不得改口。
${truthHint}
若已给出穿越者真身份，设定必须与之自洽（例如某人是 culprit 则 culprit_or_key 应对上；若真身份写「与表面一致」则不要硬塞隐藏凶手）。`;

  const user = `类型：${genresLabel}；背景：${era}；共${n}章
公开梗概（防剧透版，勿矛盾）：${publicOutline || '（无）'}
公开分章（摘要，勿逐字照抄成长文）：
${String(publicCh || '（无）').slice(0, 1800)}
角色池：${castBrief || '（无）'}
身份锁：${idBrief}
只输出短 JSON（不要 markdown，不要逐章长文）：
{"world":"世界观","synopsis_full":"含真相与结局方向的完整梗概≤300字","truth":{"core":"核心真相","culprit_or_key":"真凶或关键（恐怖可写压迫源/无）","motive":"动机","method_or_mechanism":"手法/机制","key_evidence":["物证"],"red_herrings":["误导"],"relationships":[{"a":"名","b":"名","rel":"关系"}],"ending":"结局落点"},"cast":[{"name":"名","public_face":"表面","secret":"秘密定位（可与表面一致）","knows":"知情范围"}]}
要求：人物名尽量用角色池；**本步不要输出 chapters 数组**（分章节拍已由公开大纲锁定）。字符串内不要裸换行。`;

  let obj = null;
  try {
    const raw = await chatLong(settings, system, user, {
      maxTokens: 2200,
      continueRounds: 3,
      targetMin: 0,
      format: 'json',
      emptyRetries: 1,
      apiType: 'series_outline',
    });
    obj = extractJsonObject(raw);
  } catch (e) {
    console.warn('[series] lockEngineCanon', e.message);
  }

  const canon = normalizeCanonLock(obj, book, cast || book.cast_list, idLock);
  // 用已有公开/故事节拍填 chapters，避免中篇一次要 20 条被截断
  const seedCh = (chapters || book.chapter_outline || []);
  for (let i = 1; i <= n; i++) {
    const slot = canon.chapters[i - 1] || { no: i };
    const hit = seedCh.find((c) => Number(c.no || c.chapter_no) === i) || seedCh[i - 1] || {};
    const story = String(hit.story_beat || hit.summary || hit.outline || '').trim();
    if (!slot.engine_beat) slot.engine_beat = story.slice(0, 160);
    if (!slot.public_beat) slot.public_beat = String(hit.summary || hit.public_beat || story).trim().slice(0, 80);
    slot.no = i;
    canon.chapters[i - 1] = slot;
  }
  // 兜底：至少有一句核心设定
  if (!canon.truth.core) {
    canon.truth.core = mysteryLike
      ? '凶手与关键机制已在引擎侧定死，正文须前后一致，不得改口。'
      : horrorLike
        ? '压迫来源与危险机制已定；可不解释破局，正文须前后一致。'
        : '核心冲突与结局落点已定，正文须前后一致。';
  }
  if (!canon.synopsis_full) {
    canon.synopsis_full = publicOutline.slice(0, 400) || canon.truth.core;
  }

  db.prepare(`
    UPDATE series_books SET canon_lock=?, updated_at=datetime('now') WHERE id=?
  `).run(JSON.stringify(canon), book.id);

  return canon;
}

/** 已开写/开玩后禁止重生成大纲（公开版与引擎真相一并锁死） */
function assertOutlineMutable(bookId) {
  const row = db.prepare(`
    SELECT 1 AS ok FROM series_chapters
    WHERE book_id=? AND status IN ('playing','done','generating')
    LIMIT 1
  `).get(bookId);
  if (row) {
    throw new Error('已开始游玩，公开大纲与引擎真相已锁定，不能重新生成');
  }
}

async function generateBookOutline(bookId) {
  const book = getBook(bookId);
  if (!book) throw new Error('剧集不存在');
  if (book.mode === 'isekai') throw new Error('穿越剧本请用穿越大纲接口');
  assertOutlineMutable(bookId);
  ensureRoles(book);
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const n = book.total_chapters;
  const obj = await requestOutlineObject(book, { withCast: false, label: '时空大纲' });
  const chapters = normalizeOutlineChapters(obj, n);
  const outlineText = composeBookOutlineText(obj);
  const title = String(obj.title || book.title || '').trim().slice(0, 80);

  db.prepare(`
    UPDATE series_books SET title=?, book_outline=?, chapter_outline=?, status='outlined', updated_at=datetime('now')
    WHERE id=?
  `).run(title || book.title, outlineText || String(obj.synopsis || '').trim().slice(0, 800), JSON.stringify(chapters), bookId);

  const upd = db.prepare(`
    UPDATE series_chapters SET title=?, outline=?, updated_at=datetime('now')
    WHERE book_id=? AND chapter_no=? AND status!='done'
  `);
  for (const c of chapters) {
    upd.run(c.title, c.summary, bookId, c.no);
  }

  // 引擎完整大纲（含真相）锁定，不下发前端；大纲阶段允许 force 换新真相
  const fresh = getBook(bookId, { includeSecrets: true });
  await lockEngineCanon(fresh, { outlineObj: obj, chapters, force: true });

  return getBook(bookId);
}

function seriesMemoryBlock(bookId) {
  const rows = db.prepare(
    `SELECT content, chapter_no, kind, pinned FROM series_memories WHERE book_id=? ORDER BY pinned DESC, id DESC LIMIT 28`
  ).all(bookId);
  if (!rows.length) return '';
  return `【剧集内既有设定/记忆（仅本剧集）】\n${rows.map((r) => {
    const tag = r.kind && r.kind !== 'plot' ? `·${r.kind}` : '';
    const pin = Number(r.pinned) === 1 ? '★' : '';
    return `- ${pin}[第${r.chapter_no}章${tag}] ${r.content}`;
  }).join('\n')}`;
}

function recentChaptersBlock(bookId, beforeNo, take = 2) {
  const rows = db.prepare(`
    SELECT chapter_no, title, content FROM series_chapters
    WHERE book_id=? AND chapter_no<? AND status='done' AND content!=''
    ORDER BY chapter_no DESC LIMIT ?
  `).all(bookId, beforeNo, take);
  if (!rows.length) return '';
  rows.reverse();
  return rows.map((r) => {
    const body = String(r.content || '');
    const clip = body.length > 1800 ? `……${body.slice(-1800)}` : body;
    return `【第${r.chapter_no}章·${r.title} 节选】\n${clip}`;
  }).join('\n\n');
}

async function extractSeriesMemories(bookId, chapterNo, content) {
  const settings = getSettings();
  const system = `从小说章节中提取可延续的设定事实（人名关系、地点、关键道具、已发生重大事件）。
只输出 JSON：{"facts":["……","……"]}，最多 6 条，每条≤40字。不要评价，不要剧透未发生内容。`;
  try {
    const raw = await callChatAPIComplete(
      settings,
      system,
      `第${chapterNo}章正文：\n${String(content || '').slice(0, 3500)}`,
      'series',
    );
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    let obj = {};
    try { obj = JSON.parse(m ? m[0] : raw); } catch { obj = {}; }
    const facts = Array.isArray(obj.facts) ? obj.facts : [];
    const ins = db.prepare(
      `INSERT INTO series_memories (book_id, content, chapter_no, kind, pinned) VALUES (?,?,?,?,0)`
    );
    for (const f of facts.slice(0, 6)) {
      const t = String(f || '').trim().slice(0, 120);
      if (t) ins.run(bookId, t, chapterNo, 'plot');
    }
  } catch {
    /* 记忆提取失败不阻断正文 */
  }
}

async function generateChapter(bookId, chapterNo, { direction = '', force = false } = {}) {
  let book = getBook(bookId, { includeSecrets: true });
  if (!book) throw new Error('剧集不存在');
  if (book.mode === 'isekai') throw new Error('穿越剧本请用穿越写章接口');
  ensureRoles(book);
  if (!book.book_outline && !(book.chapter_outline || []).length) {
    throw new Error('请先生成整本大纲');
  }
  // 旧本缺引擎完整大纲时补锁，避免写章过程中设定漂移
  if (!book.canon_lock?.locked) {
    await lockEngineCanon(book, { chapters: book.chapter_outline || [] });
    book = getBook(bookId, { includeSecrets: true });
  }
  const ch = getChapter(bookId, chapterNo);
  if (!ch) throw new Error('章节不存在');
  if (ch.status === 'done' && ch.content && !force) {
    throw new Error('本章已生成；若正文被截断请点「整章重写」，或用导演批示');
  }
  if (chapterNo > 1) {
    const prev = getChapter(bookId, chapterNo - 1);
    if (!prev || prev.status !== 'done' || !prev.content) {
      throw new Error('请先完成上一章');
    }
  }

  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const settings = getSettings();
  const system = buildSeriesSystemPrompt(book, char, { chapterNo });
  const outlineItem = (book.chapter_outline || []).find((c) => Number(c.no) === Number(chapterNo));
  const chapterOutline = String(direction || ch.outline || outlineItem?.summary || '').trim();
  const mem = seriesMemoryBlock(bookId);
  const recent = recentChaptersBlock(bookId, chapterNo, 2);

  const meatNote = (book.genres || []).includes('nsfw')
    ? '【本章肉文要求】须含实质情欲/性爱描写，过程写全，禁止「一夜无话」式跳过。'
    : (book.genres || []).includes('romance_nsfw')
      ? '【本章可肉】若大纲走到亲密，把床戏写具体；若未到时机则推进感情张力即可。'
      : '';

  const user = `请撰写《${book.title}》第${chapterNo}章「${ch.title || outlineItem?.title || ''}」。
【全书梗概】${book.book_outline || '（见分章大纲）'}
【本章大纲】${chapterOutline || '按全书节奏自然推进'}
${mem ? `${mem}\n` : ''}${recent ? `${recent}\n` : ''}${meatNote ? `${meatNote}\n` : ''}
【字数】正文约 ${CHAPTER_TARGET_IDEAL} 汉字（允许 ${CHAPTER_TARGET_MIN}～${CHAPTER_TARGET_MAX}）。必须写完完整一章并自然收束；若输出长度不够系统会自动接写，你也尽量一次写满。
【对白】像现实里真人当面说话：自然好懂，跟性格走；禁止文绉绉、书面腔、散文金句。男主台词按本章情境新写；禁止照搬或改写语言示例里的原句。女主若由用户扮演：不替她开口，但男主与在场人物须主动抛话，给她接话点，勿整场沉默等用户硬推感情。
只输出小说正文，不要章节序号标题行，不要作者旁白或写作说明。`;

  db.prepare(
    `UPDATE series_chapters SET status='generating', updated_at=datetime('now') WHERE id=?`
  ).run(ch.id);

  let content;
  try {
    // 中文约 1～2 token/字；3000 字章需要更高 max_tokens，并强制拒绝半截落库
    content = await chatLong(settings, system, user, {
      maxTokens: 8192,
      continueRounds: 8,
      targetMin: CHAPTER_TARGET_MIN,
      rejectCutOff: true,
      emptyRetries: 2,
    });
  } catch (e) {
    // force 重写失败时保留旧正文，避免读章变空
    const fallbackStatus = (force && ch.content) ? 'done' : 'pending';
    db.prepare(
      `UPDATE series_chapters SET status=?, updated_at=datetime('now') WHERE id=?`
    ).run(fallbackStatus, ch.id);
    throw new Error(formatApiBillingError(e.message, { label: '剧集' }) || e.message || '生成失败');
  }

  if (!content || proseCharCount(content) < 400 || proseLooksCutOff(content)) {
    const fallbackStatus = (force && ch.content) ? 'done' : 'pending';
    db.prepare(
      `UPDATE series_chapters SET status=?, updated_at=datetime('now') WHERE id=?`
    ).run(fallbackStatus, ch.id);
    throw new Error('生成内容过短或不完整（疑似截断），请点「整章重写」重试');
  }

  const dirNote = String(direction || '').trim().slice(0, 500);
  db.prepare(`
    UPDATE series_chapters SET content=?, outline=?, status='done',
      director_notes=CASE WHEN ?!='' THEN ? ELSE director_notes END,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    content,
    chapterOutline || ch.outline,
    dirNote, dirNote,
    ch.id,
  );

  db.prepare(`UPDATE series_books SET status='writing', updated_at=datetime('now') WHERE id=?`).run(bookId);
  const doneN = db.prepare(
    `SELECT COUNT(*) as n FROM series_chapters WHERE book_id=? AND status='done'`
  ).get(bookId)?.n || 0;
  if (doneN >= book.total_chapters) {
    db.prepare(`UPDATE series_books SET status='done', updated_at=datetime('now') WHERE id=?`).run(bookId);
  }

  await extractSeriesMemories(bookId, chapterNo, content);
  return getChapter(bookId, chapterNo);
}

async function directorRewrite(bookId, chapterNo, feedback) {
  const note = String(feedback || '').trim();
  if (!note) throw new Error('请写明导演批示');
  const book = getBook(bookId, { includeSecrets: true });
  if (!book) throw new Error('剧集不存在');
  if (book.mode === 'isekai') throw new Error('穿越剧本请用穿越接口');
  const ch = getChapter(bookId, chapterNo);
  if (!ch || !ch.content) throw new Error('本章尚无正文可改');
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(book.character_id);
  if (!char) throw new Error('角色不存在');
  const settings = getSettings();
  const system = buildSeriesSystemPrompt(book, char, { chapterNo });
  const mem = seriesMemoryBlock(bookId);
  // 只给提纲式摘要，避免把「半截原文」喂回去导致越改越断
  const prevDigest = String(ch.content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
  const user = `导演要求重写第${chapterNo}章「${ch.title}」。
【导演批示】${note}
【原章大纲】${ch.outline || ''}
${mem ? `${mem}\n` : ''}
【原文要点（仅供对照，不要续写半截原文，必须整章重写完整）】
${prevDigest}${String(ch.content || '').length > 900 ? '…' : ''}

请按批示与大纲**从头重写完整一章**，约 ${CHAPTER_TARGET_IDEAL} 汉字（${CHAPTER_TARGET_MIN}～${CHAPTER_TARGET_MAX}），写到自然收束；只输出正文，不要标题，不要解释。`;

  db.prepare(
    `UPDATE series_chapters SET status='generating', director_notes=?, updated_at=datetime('now') WHERE id=?`
  ).run(note.slice(0, 500), ch.id);

  let content;
  try {
    content = await chatLong(settings, system, user, {
      maxTokens: 8192,
      continueRounds: 8,
      targetMin: CHAPTER_TARGET_MIN,
      rejectCutOff: true,
      emptyRetries: 2,
    });
  } catch (e) {
    db.prepare(
      `UPDATE series_chapters SET status='done', updated_at=datetime('now') WHERE id=?`
    ).run(ch.id);
    throw new Error(formatApiBillingError(e.message, { label: '剧集导演' }) || e.message || '重写失败');
  }

  if (!content || proseCharCount(content) < 400 || proseLooksCutOff(content)) {
    db.prepare(
      `UPDATE series_chapters SET status='done', updated_at=datetime('now') WHERE id=?`
    ).run(ch.id);
    throw new Error('重写结果仍不完整（疑似截断），请再试一次或换模型');
  }

  db.prepare(`
    UPDATE series_chapters SET content=?, status='done', director_notes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(content, note.slice(0, 500), ch.id);
  touchBook(bookId);
  await extractSeriesMemories(bookId, chapterNo, content);
  return getChapter(bookId, chapterNo);
}

function updateChapterMeta(bookId, chapterNo, { title, outline } = {}) {
  const ch = getChapter(bookId, chapterNo);
  if (!ch) throw new Error('章节不存在');
  db.prepare(`
    UPDATE series_chapters SET
      title=COALESCE(?, title),
      outline=COALESCE(?, outline),
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    title != null ? String(title).trim().slice(0, 60) : null,
    outline != null ? String(outline).trim().slice(0, 500) : null,
    ch.id,
  );
  touchBook(bookId);
  return getChapter(bookId, chapterNo);
}

module.exports = {
  LENGTH_CHAPTERS,
  LENGTH_LABELS,
  GENRE_OPTIONS,
  ERA_PRESETS,
  GENRE_RULES,
  listBooks,
  getBook,
  getChapter,
  createBook,
  updateBook,
  deleteBook,
  generateBlindRoles,
  generateBookOutline,
  generateChapter,
  directorRewrite,
  updateChapterMeta,
  // shared with isekai
  getSettings,
  chatLong,
  charCoreForSeries,
  speechStyleBlock,
  genreText,
  genreRulesText,
  styleText,
  styleKeyFromGenres,
  isGenreAutoStyle,
  resolveEra,
  backgroundPromptLine,
  isMeatGenre,
  isRomanceLikeGenre,
  romanceDialogueDriveRules,
  isSpoilerSensitiveGenre,
  isMysteryLikeGenre,
  isHorrorGenre,
  isInfiniteGenre,
  outlineNoSpoilerRules,
  plotDiversityRules,
  userPremiseBlock,
  isPalaceDomesticStory,
  resolveIntrigueBoard,
  intriguePlotEngineBlock,
  palaceDomesticPlotBlock,
  isCrimeProcedureHook,
  sanitizeBeatForPalaceDomestic,
  capCrimeProcedureBeats,
  normalizeRolePrefs,
  readRolePrefsFromBook,
  rolePrefsPromptBlock,
  mysteryQuestRules,
  normalizeStyleCustoms,
  parseJson,
  touchBook,
  buildSeriesSystemPrompt,
  buildOutlineSystemPrompt,
  buildNovelOutlineUserPrompt,
  requestOutlineObject,
  normalizeOutlineChapters,
  composeBookOutlineText,
  extractJsonObject,
  requireSeriesApi,
  assertOutlineMutable,
  lockEngineCanon,
  formatCanonBlockForPrompt,
  CHAPTER_TARGET_IDEAL,
};

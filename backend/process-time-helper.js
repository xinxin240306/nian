/**
 * 行为过程时间：禁止「刚开始下一句就做完」；到合理耗时后再主动报完成。
 * 覆盖：出门到了发定位、洗澡、吃饭、忙事、做饭等。
 */
const db = require('./db');

const SETTINGS_KEY = 'process_time_pending';
const LEGACY_SETTINGS_KEY = 'travel_arrive_pending';

const LOC_MARK_RE = /\[\s*(?:发送\s*)?位置\s*\]|【\s*(?:发送\s*)?位置\s*】/;
const USER_ARRIVE_LOC_RE = /到了.{0,12}(?:发|给).{0,6}(?:定位|位置)|到了.{0,8}(?:告诉|跟我说|报个)|(?:发|给).{0,4}(?:定位|位置).{0,8}到了|(?:到了|抵达|到地方).{0,10}(?:发|甩).{0,4}(?:定位|位置)|到了之后.{0,10}(?:定位|位置)|到了再(?:发|给我)/;
/** 到家/之后再发图视频：本轮禁止立刻发卡 */
const USER_DEFER_MEDIA_RE = /(?:到了|到家|回家|回去|到地方|之后|晚点|一会儿|一会|等(?:我|着)?).{0,16}(?:再|才).{0,10}(?:发|给|甩|拍).{0,12}(?:图|照片|图片|相片|自拍|视频|小视频)|(?:发|给|甩|拍).{0,8}(?:图|照片|图片|相片|自拍|视频).{0,12}(?:到了|到家|回家|回去|到地方|之后)|(?:回家|到家|回去).{0,10}(?:发|拍|给).{0,8}(?:图|照片|图片|相片|自拍|视频)|回家再(?:发|拍)|到家再(?:发|拍)/;
const USER_ASK_GO_RE = /出去|出门|去一趟|去办|去买|去逛|你去|你先去|你出去|走一趟/;
/** 真出门/出发；排除「扫地出门」「请出门」等比喻 */
const CHAR_DEPART_RE = /(?:我)?(?:先)?(?:出去(?:一趟|一下|了)?|(?<!扫地)(?<![请轰赶踢滚拒闭])出门(?:了)?|出发(?:了)?|在路上了?|溜了)|去办(?:点|件)?事|去买(?:点|个)?|去逛|这就出门|这就出发/;
/** 宣称「我到了」；排除「剪到了手 / 想到了 / 游到了」等「V到了」 */
const CHAR_ARRIVE_RE = /(?<![剪想说游送堵走跑飞开拿找摸碰撞看听闻感认记算得做弄搞买带穿戴装写读画问提聊轮赶连碰真])(?:我)?(?:已经)?(?:到了|到地方了|到目的地|到啦|到咯|到这儿了|到这里了|到家了)|(?:^|[。！？!?\n])\s*(?:到了|到啦|到咯)(?![手路岸头底])|抵达(?:了)?(?!梦)/m;
/** 角色可在回复里自报耗时： [过程:洗澡|25分钟] 或 【过程：加班｜40】（入库前必须剥掉） */
const PROCESS_TAG_RE = /[\[【［]\s*过程\s*[:：]\s*([^\]】］|／/]+?)\s*[|｜/]\s*(?:约)?(\d{1,3})\s*(?:分钟|分|min)?\s*[\]】］]/i;
/** 无分钟 / 写坏的过程标签、以及整段泄漏的【过程时间】系统块 */
const PROCESS_TAG_LOOSE_RE = /[\[【［]\s*过程(?:时间)?\s*[:：][^\]】］\n]{0,40}[\]】］]?/gi;
const PROCESS_NOTE_LEAK_RE = /【\s*过程时间[^】]{0,12}】[^\n]*/g;
const OPEN_PROCESS_HINT_RE = /(?:我)?(?:去|要去|先去|正要|准备去|出门|出去|忙一会|处理一下|去弄|去办|去洗|去吃|去睡|去看|去打|去跑|去买|敷面膜|(?:去|在)护肤|打扫|收拾)|在路上|出发了/;

/** 只认「做完了」这类完工句，不要把口语「好了好了」当成做完 */
const GENERIC_DONE_RE = /做[好完]了|弄[好完]了|处理[好完]了|搞定了|结束了|回来了|已经好了|已经完了|弄妥了/;
const GENERIC_SOFTEN = [
  [/已经完了/g, '还在弄'],
  [/做完了/g, '还在做'],
  [/做好了/g, '还在做'],
  [/弄完了/g, '还在弄'],
  [/弄好了/g, '还在弄'],
  [/处理好了/g, '还在处理'],
  [/搞定了/g, '还没搞定'],
  [/已经好了/g, '还没好'],
  [/结束了/g, '还没结束'],
  [/(?<![不没])回来了/g, '还没回来'],
];
/** 「好了好了好了」是安抚/接话，不是报完工 */
const CONVERSATIONAL_OK_RE = /^(?:好了){2,}[啊呀啦哦嗯吧呐嘛！!。.~～…]*$/;

/** @typedef {{ kind: string, label: string, startRe: RegExp, doneRe: RegExp, skipRe?: RegExp, userAskRe?: RegExp, delayMin: [number, number], needLocation?: boolean, soften?: Array<[RegExp, string]> }} ProcessKind */

/** @type {ProcessKind[]} */
const PROCESS_KINDS = [
  {
    kind: 'travel_arrive',
    label: '出门/在路上',
    startRe: CHAR_DEPART_RE,
    doneRe: CHAR_ARRIVE_RE,
    skipRe: /不出去了|不出门了|不去了|先不出去/,
    userAskRe: USER_ARRIVE_LOC_RE,
    delayMin: [22, 38],
    needLocation: true,
    soften: [
      [/我(?:已经)?到了[啦咯啊]?/g, '我还在路上'],
      [/已经到了/g, '还在路上'],
      [/((?:^|[。！？!?\n])\s*)到了[啦咯啊]?(?=[。！？!?\n]|$)/gm, '$1在路上了'],
      [/到地方了|到目的地了?/g, '还在路上'],
      [/抵达了?/g, '出发了'],
    ],
  },
  {
    kind: 'bath',
    label: '洗澡/泡澡',
    startRe: /(?:去|要|准备|正要|先去|我去)?(?:泡(?:个|会儿|一会)?澡|泡澡|洗澡|冲澡|淋浴)|在泡|泡着呢|泡澡呢|洗澡呢|泡澡中/,
    doneRe: /泡完了|洗完了|冲完了|泡好了|洗好了|澡洗完|已经出来|已经上来|擦完|擦干了/,
    skipRe: /不(?:去)?(?:泡|洗)了|不泡了|不洗了|不去洗澡|不去泡澡/,
    userAskRe: /(?:洗|泡)完.{0,8}(?:告诉|跟我说|回我|说一声|找我)|洗完了.{0,4}(?:告诉|叫)|泡完.{0,4}(?:告诉|叫)/,
    delayMin: [18, 32],
    soften: [
      [/泡完了/g, '还在泡'],
      [/洗完了/g, '还在洗'],
      [/冲完了/g, '还在冲'],
      [/已经上来了?/g, '还没好'],
      [/已经出来了?/g, '还没出来'],
    ],
  },
  {
    kind: 'eat',
    label: '吃饭',
    startRe: /(?:去|要|正要|先去)?吃(?:饭|晚饭|午饭|午餐|早餐|早饭|宵夜)|在吃呢|吃饭去|我去干饭/,
    doneRe: /吃完了|吃好了|用完餐|吃过了/,
    skipRe: /不吃了|先不吃|不吃饭|不去吃饭/,
    userAskRe: /吃完.{0,8}(?:告诉|跟我说|回我|说一声)|吃好了.{0,4}(?:告诉|叫)/,
    delayMin: [20, 35],
    soften: [
      [/吃完了/g, '还在吃'],
      [/吃好了/g, '还在吃'],
      [/用完餐了?/g, '还在吃'],
    ],
  },
  {
    kind: 'cook',
    label: '做饭/下厨',
    startRe: /(?:去|要|正要|先)?(?:做饭|煮|炒|下厨|弄点吃的|热饭|做晚饭|做午饭)/,
    doneRe: /做好了|煮好了|炒好了|出锅了|饭好了|弄好了吃的/,
    skipRe: /不做了|不煮了|不下厨|先不做/,
    userAskRe: /(?:做|煮|炒)好.{0,8}(?:告诉|跟我说|回我|说一声|发|拍)|饭好了.{0,4}(?:告诉|叫)/,
    delayMin: [25, 45],
    soften: [
      [/做好了/g, '还在做'],
      [/煮好了/g, '还在煮'],
      [/炒好了/g, '还在炒'],
      [/出锅了/g, '还没好'],
      [/饭好了/g, '还在做'],
    ],
  },
  {
    kind: 'busy',
    label: '忙别的事',
    startRe: /(?:去|要|先)?忙一会|忙一下|处理一下|有点事|我先忙|我去弄|先去弄/,
    doneRe: /忙完了|弄完了|处理好了|弄好了|搞定了/,
    skipRe: /不忙了|先不忙|不处理了/,
    userAskRe: /忙完.{0,8}(?:告诉|跟我说|回我|说一声|找我)|弄完.{0,6}(?:告诉|回我)/,
    delayMin: [25, 45],
    soften: [
      [/忙完了/g, '还在忙'],
      [/弄完了/g, '还在弄'],
      [/处理好了/g, '还在处理'],
      [/搞定了/g, '还没好'],
    ],
  },
  {
    kind: 'leisure',
    label: '歇一会',
    startRe: /(?:去|在|到)?(?:露台|阳台|天台|窗边).{0,10}(?:吹风|透气|坐|站)|(?:去|在)?吹风|透透气|我去躺一会|眯一会/,
    doneRe: /不吹了|不晒了|回来了|进来了|进屋|回屋|眯完了|躺好了/,
    skipRe: /不去(?:露台|阳台)|不去吹了|先不躺/,
    userAskRe: /(?:吹|躺|眯)完.{0,8}(?:告诉|回我|说一声)/,
    delayMin: [12, 22],
    soften: [
      [/不吹了/g, '还在吹'],
      [/回来了/g, '还在外面'],
      [/眯完了/g, '还在眯'],
    ],
  },
  {
    kind: 'sleep',
    label: '睡觉/小睡',
    startRe: /(?:去|要|准备|正要|先)?(?:睡了|睡觉|午觉|午睡|小睡|打个盹|眯一会|我先睡|困了去睡)/,
    doneRe: /醒了|睡醒了|起来了|午睡完|眯完了|睡好了/,
    skipRe: /不睡了|先不睡|还不困/,
    userAskRe: /(?:睡|眯)完.{0,8}(?:告诉|回我|说一声)|醒了.{0,4}(?:告诉|叫)/,
    delayMin: [40, 90],
    soften: [
      // 长词在前；不要裸匹配「醒了」，否则「睡醒了/等…醒了再说」会被撕成「还在睡」
      [/睡醒了/g, '还没醒'],
      [/(?<!睡)醒了/g, '还在睡'],
      [/起来了/g, '还在躺着'],
      [/午睡完了?/g, '还在午睡'],
      [/眯完了/g, '还在眯'],
      [/睡好了/g, '还在睡'],
    ],
  },
  {
    kind: 'work',
    label: '工作/加班',
    startRe: /(?:去|要|先|正)?(?:加班|赶工|改稿|写代码|开会|处理工作|办公|上班去|去公司|在开会)/,
    doneRe: /加完班|忙完工作|开完会|下班了|弄完工作|处理完工作/,
    skipRe: /不加了|先不加班|不开会了/,
    userAskRe: /(?:加|开|忙)完.{0,8}(?:告诉|回我|说一声)|下班.{0,4}(?:告诉|叫)/,
    delayMin: [35, 75],
    soften: [
      [/加完班了?/g, '还在加班'],
      [/开完会了?/g, '还在开会'],
      [/下班了/g, '还没下班'],
      [/忙完工作了?/g, '还在忙'],
    ],
  },
  {
    kind: 'study',
    label: '学习/复习',
    startRe: /(?:去|要|先|正)?(?:看书|复习|写作业|学习|刷题|备课|读一会书)/,
    doneRe: /看完了|复习完|写完作业|学完了|刷完题|读完了/,
    skipRe: /不学了|先不看|不复习了/,
    userAskRe: /(?:看|学|写|刷)完.{0,8}(?:告诉|回我|说一声)/,
    delayMin: [25, 55],
    soften: [
      [/看完了/g, '还在看'],
      [/复习完了?/g, '还在复习'],
      [/写完作业了?/g, '还在写'],
      [/学完了/g, '还在学'],
      [/刷完题了?/g, '还在刷'],
    ],
  },
  {
    kind: 'game',
    label: '打游戏',
    startRe: /(?:去|要|先|正)?(?:打游戏|开一把|上分|开黑|玩会游戏|游戏去)/,
    doneRe: /打完了|玩完了|下了|这把完了|不玩了下线/,
    skipRe: /不打了|先不玩|不开了/,
    userAskRe: /(?:打|玩)完.{0,8}(?:告诉|回我|说一声)|下了.{0,4}(?:告诉|叫)/,
    delayMin: [20, 50],
    soften: [
      [/打完了/g, '还在打'],
      [/玩完了/g, '还在玩'],
      [/这把完了/g, '还在打'],
      [/下了/g, '还没下'],
    ],
  },
  {
    kind: 'exercise',
    label: '运动/锻炼',
    startRe: /(?:去|要|先|正)?(?:跑步|健身|锻炼|练一下|去健身房|拉伸|打球|游泳)/,
    doneRe: /跑完了|练完了|锻炼完|游完了|打完球|健身完/,
    skipRe: /不跑了|不练了|先不锻炼/,
    userAskRe: /(?:跑|练|游|锻炼)完.{0,8}(?:告诉|回我|说一声)/,
    delayMin: [25, 55],
    soften: [
      [/跑完了/g, '还在跑'],
      [/练完了/g, '还在练'],
      [/锻炼完了?/g, '还在锻炼'],
      [/游完了/g, '还在游'],
      [/健身完了?/g, '还在健身'],
    ],
  },
  {
    kind: 'skincare',
    label: '护肤/洗漱',
    startRe: /(?:去|要去|先去|正要|准备|正在|在)(?:护肤|敷面膜|洗脸|洗漱|刷牙|化妆|卸妆)|(?:护肤|敷面膜|洗脸|洗漱|化妆|卸妆)(?:去了|呢|中)/,
    doneRe: /护完肤|敷完了|洗完脸|洗漱完|化好妆|卸完妆|刷完牙/,
    skipRe: /不护了|先不敷|不化了/,
    userAskRe: /(?:护|敷|洗漱|化|卸)完.{0,8}(?:告诉|回我|说一声)/,
    delayMin: [12, 28],
    soften: [
      [/护完肤了?/g, '还在护肤'],
      [/敷完了/g, '还在敷'],
      [/洗完脸了?/g, '还在洗'],
      [/洗漱完了?/g, '还在洗漱'],
      [/化好妆了?/g, '还在化'],
      [/卸完妆了?/g, '还在卸'],
    ],
  },
  {
    kind: 'clean',
    label: '打扫/收拾',
    startRe: /(?:去|要|先|正)?(?:打扫|收拾|清理|洗碗|洗衣|晾衣服|大扫除)/,
    doneRe: /打扫完|收拾完|清理完|洗完碗|洗完衣服|晾完了/,
    skipRe: /不收拾了|先不扫|不洗了/,
    userAskRe: /(?:打扫|收拾|清理|洗)完.{0,8}(?:告诉|回我|说一声)/,
    delayMin: [20, 45],
    soften: [
      [/打扫完了?/g, '还在打扫'],
      [/收拾完了?/g, '还在收拾'],
      [/清理完了?/g, '还在清理'],
      [/洗完碗了?/g, '还在洗'],
      [/洗完衣服了?/g, '还在洗'],
    ],
  },
  {
    kind: 'watch',
    label: '看剧/电影',
    startRe: /(?:去|要|先|正)?(?:看剧|追剧|看电影|刷剧|看一集|看会电视)/,
    doneRe: /看完了|剧看完|这集完了|电影看完|不看了/,
    skipRe: /不看了|先不追|不看剧/,
    userAskRe: /看完.{0,8}(?:告诉|回我|说一声)/,
    delayMin: [25, 55],
    soften: [
      [/看完了/g, '还在看'],
      [/剧看完了?/g, '还在看'],
      [/这集完了/g, '还在看'],
      [/电影看完了?/g, '还在看'],
    ],
  },
  {
    kind: 'shop',
    label: '逛街/采购',
    startRe: /(?:去|要|先|正)?(?:逛街|采购|买菜|逛超市|去商场|去便利店买)/,
    doneRe: /逛完了|买完了|采购完|从超市回|买好了回来/,
    skipRe: /不逛了|不去买|先不采购/,
    userAskRe: /(?:逛|买|采购)完.{0,8}(?:告诉|回我|说一声)/,
    delayMin: [30, 60],
    soften: [
      [/逛完了/g, '还在逛'],
      [/买完了/g, '还在买'],
      [/采购完了?/g, '还在采购'],
      [/买好了回来了?/g, '还在外面'],
    ],
  },
];

function loadPendingMap() {
  try {
    let row = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY);
    if (!row?.value) {
      row = db.prepare('SELECT value FROM settings WHERE key=?').get(LEGACY_SETTINGS_KEY);
    }
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePendingMap(map) {
  const json = JSON.stringify(map || {});
  try {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(SETTINGS_KEY, json);
  } catch (e) {
    try {
      const exists = db.prepare('SELECT key FROM settings WHERE key=?').get(SETTINGS_KEY);
      if (exists) db.prepare('UPDATE settings SET value=? WHERE key=?').run(json, SETTINGS_KEY);
      else db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').run(SETTINGS_KEY, json);
    } catch (e2) {
      console.warn('[process-time] save', e2.message);
    }
  }
  // 清掉旧 key，避免双份
  try { db.prepare('DELETE FROM settings WHERE key=?').run(LEGACY_SETTINGS_KEY); } catch {}
}

function pickDelayMs(kind, userText, aiText) {
  const blob = `${userText || ''} ${aiText || ''}`;
  let [lo, hi] = kind.delayMin || [20, 35];
  if (kind.kind === 'travel_arrive') {
    if (/楼下|附近|便利店|驿站|快递柜|门口|街口|旁边|一趟就回/.test(blob)) {
      lo = 12; hi = 20;
    } else if (/机场|高铁|火车站|另一边|城南|城北|郊区|远一点|开车|打车去很远/.test(blob)) {
      lo = 45; hi = 70;
    } else if (/逛街|办事|医院|商场|公司|上班|开会/.test(blob)) {
      lo = 28; hi = 48;
    }
  }
  if (/马上|很快|几分钟|一小会|一会儿就/.test(blob)) {
    lo = Math.max(8, Math.floor(lo * 0.6));
    hi = Math.max(lo + 4, Math.floor(hi * 0.65));
  }
  if (/半小时|久一点|得一会|得一会儿/.test(blob)) {
    lo = Math.floor(lo * 1.25);
    hi = Math.floor(hi * 1.35);
  }
  const span = Math.max(1, hi - lo);
  return (lo + Math.floor(Math.random() * (span + 1))) * 60 * 1000;
}

function userWantsArriveLocation(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (USER_ARRIVE_LOC_RE.test(t)) return true;
  if (USER_ASK_GO_RE.test(t) && /(?:定位|位置)/.test(t) && /到了|抵达|到地方/.test(t)) return true;
  return false;
}

function userWantsDeferredMedia(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return USER_DEFER_MEDIA_RE.test(t);
}

function deferredMediaKind(text) {
  const t = String(text || '');
  const wantVideo = /视频|小视频|vlog/i.test(t);
  const wantImage = /图|照片|图片|相片|自拍/.test(t);
  return { wantImage: wantImage || (!wantVideo && userWantsDeferredMedia(t)), wantVideo };
}

function recentUserAskedArriveLocation(history, userMessage) {
  if (userWantsArriveLocation(userMessage)) return true;
  return (history || [])
    .filter((m) => m.role === 'user' && m.type !== 'system')
    .slice(-6)
    .some((m) => userWantsArriveLocation(m.content));
}

function recentUserAskedDeferredMedia(history, userMessage) {
  if (userWantsDeferredMedia(userMessage)) return true;
  return (history || [])
    .filter((m) => m.role === 'user' && m.type !== 'system')
    .slice(-6)
    .some((m) => userWantsDeferredMedia(m.content));
}

/** 剥掉配图/自拍/配视频指令行（延后发时防本轮秒发） */
function stripMediaDirectiveLines(text) {
  return String(text || '')
    .replace(/^\s*(?:配图|自拍|配视频|音效)\s*[:：][^\n]*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 梦境/叙事里的「去/抵达」不是真出门 */
function looksLikeDreamOrFiction(text) {
  const t = String(text || '');
  return /梦境|梦里|入梦|做梦|这场梦|梦中|梦到|醒来发现是梦|抵达梦/.test(t);
}

function charJustDeparted(text) {
  const t = String(text || '').replace(/^【自动回复】/, '');
  if (!t) return false;
  if (looksLikeDreamOrFiction(t)) return false;
  if (CHAR_ARRIVE_RE.test(t) && !/还没到|没到|快到|马上到|快到了/.test(t)) return false;
  return CHAR_DEPART_RE.test(t);
}

function charClaimsArrived(text) {
  const t = String(text || '').replace(/^【自动回复】/, '');
  if (!t) return false;
  if (looksLikeDreamOrFiction(t)) return false;
  if (/还没到|没到呢|快到了|马上到|快到|在路上/.test(t)) return false;
  // 「等你到了」「你到了吗」不是角色自己宣称已到
  return CHAR_ARRIVE_RE.test(maskDeferredCompletionSpans(t));
}

function getPending(charId) {
  const row = loadPendingMap()[String(charId)];
  if (!row || !row.dueAt) return null;
  // 兼容旧字段：无 kind 视为 travel_arrive
  if (!row.kind) row.kind = 'travel_arrive';
  return row;
}

function normalizeSourceMsgIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => parseInt(x, 10)).filter((n) => n > 0))].slice(0, 24);
}

function setPending(charId, payload) {
  const map = loadPendingMap();
  map[String(charId)] = {
    kind: payload.kind || 'generic',
    label: String(payload.label || '').slice(0, 20),
    dueAt: payload.dueAt,
    dest: String(payload.dest || '').slice(0, 40),
    tip: String(payload.tip || '').slice(0, 80),
    needLocation: !!payload.needLocation,
    needImage: !!payload.needImage,
    needVideo: !!payload.needVideo,
    silent: !!payload.silent,
    donePattern: String(payload.donePattern || '').slice(0, 120),
    sourceMsgIds: normalizeSourceMsgIds(payload.sourceMsgIds),
    createdAt: Date.now(),
  };
  savePendingMap(map);
}

function parseProcessTag(text) {
  const m = String(text || '').match(PROCESS_TAG_RE);
  if (!m) return null;
  const label = String(m[1] || '').replace(/\s+/g, '').slice(0, 20);
  let minutes = parseInt(m[2], 10);
  if (!label || !Number.isFinite(minutes)) return null;
  minutes = Math.max(8, Math.min(180, minutes));
  return { label, minutes, raw: m[0] };
}

function stripProcessTags(text) {
  return String(text || '')
    .replace(PROCESS_TAG_RE, '')
    .replace(PROCESS_TAG_LOOSE_RE, '')
    .replace(PROCESS_NOTE_LEAK_RE, '')
    .replace(/^\s*【\s*主动[·・.]?(?:到达报平安|到了|事情做完了)[^】]*】\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeOpenProcess(text) {
  const t = String(text || '').replace(/^【自动回复】/, '');
  if (!t || t.length < 2) return false;
  if (isMetaOrTechTalk(t)) return false;
  if (looksLikeDreamOrFiction(t)) return false;
  if (GENERIC_DONE_RE.test(t) && !OPEN_PROCESS_HINT_RE.test(t)) return false;
  return OPEN_PROCESS_HINT_RE.test(t);
}

/** 对方在吐槽 App / 让修东西：那是闲聊，不是角色生活里要去做的事 */
function isMetaOrTechTalk(...texts) {
  const blob = texts.map((x) => String(x || '')).join('\n');
  return /系统崩|系统坏|系统挂|修一下|修bug|修\s*bug|帮我修|编程|代码|报错|接口|服务器|后端|前端|重启|部署|app\s*崩|软件崩/i.test(blob);
}

/** 用模型判断「在做什么 + 大约多久」（识别不到正则种类时的兜底） */
async function estimateProcessWithLlm(settings, userText, aiText) {
  if (!settings) return null;
  const ask = `根据角色刚说的话，判断是否开始了一件需要真实耗时的事（洗澡、出门、吃饭、睡觉、加班、学习、游戏、运动、护肤、打扫、看剧、逛街、办事等）。
用户：「${String(userText || '').slice(0, 80)}」
角色：「${String(aiText || '').slice(0, 160)}」
只输出一行 JSON，不要解释：
若在做事：{"active":true,"label":"短中文名","minutes":数字}
若不在做事或只是闲聊：{"active":false}
minutes 须符合常识（洗澡18-35，吃饭20-40，睡觉40-120，出门办事25-60，加班30-90，游戏20-50，护肤12-30）。`;
  try {
    const { callChatAPI } = require('./api-helper');
    const raw = await callChatAPI(settings, '你是时间常识助手，只输出JSON。', ask, 'diary');
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    if (!o || o.active !== true) return null;
    const label = String(o.label || '').trim().slice(0, 20);
    let minutes = parseInt(o.minutes, 10);
    if (!label || !Number.isFinite(minutes)) return null;
    minutes = Math.max(8, Math.min(180, minutes));
    return { label, minutes, kind: 'custom' };
  } catch (e) {
    console.warn('[process-time] llm estimate', e.message);
    return null;
  }
}

function resolveKindForPending(kindName) {
  return PROCESS_KINDS.find((k) => k.kind === kindName) || null;
}

function pendingDoneRe(pending, kind) {
  if (kind?.doneRe) return kind.doneRe;
  const pat = String(pending?.donePattern || '').trim();
  if (pat) {
    try { return new RegExp(pat, 'i'); } catch { /* fallthrough */ }
  }
  return GENERIC_DONE_RE;
}

function clearPending(charId) {
  const map = loadPendingMap();
  if (!map[String(charId)]) return;
  delete map[String(charId)];
  savePendingMap(map);
}

function messageLooksLikePendingStart(text, pending) {
  const t = String(text || '').replace(/^【自动回复】/, '');
  if (!t || !pending) return false;
  const kind = resolveKindForPending(pending.kind)
    || (pending.kind === 'custom' ? makeCustomKind(pending.label, 20) : null);
  if (kind?.startRe && kind.startRe.test(t)) return true;
  const label = String(pending.label || '').trim();
  if (label.length >= 2 && t.includes(label)) return true;
  if (pending.kind === 'custom' && OPEN_PROCESS_HINT_RE.test(t)) return true;
  return false;
}

/** 开始做事的那几条还在、且仍像在做这件事 */
function pendingStartStillPresent(charId, pending) {
  if (!charId || !pending) return false;
  const ids = normalizeSourceMsgIds(pending.sourceMsgIds);
  if (!ids.length) return true;
  const ph = ids.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT content FROM messages WHERE character_id=? AND recalled=0 AND id IN (${ph})`
    ).all(charId, ...ids);
  } catch {
    return true;
  }
  const blob = rows.map((r) => String(r.content || '')).join('\n');
  if (!blob.trim()) return false;
  return messageLooksLikePendingStart(blob, pending);
}

/** 开始语已不在聊天里：取消待办，后面不会再推「做完了」 */
function clearPendingIfStartRemoved(charId) {
  const pending = getPending(charId);
  if (!pending) return false;
  if (pendingStartStillPresent(charId, pending)) return false;
  clearPending(charId);
  return true;
}

/**
 * 删/撤/改气泡之后调用。
 * 有 sourceMsgIds 时看开始语还在不在；旧待办则：删掉的正文像开始语就取消。
 */
function onAssistantMessagesChanged(charId, { droppedContents = [], remainingContent = '' } = {}) {
  if (!charId) return false;
  const pending = getPending(charId);
  if (!pending) return false;
  if (normalizeSourceMsgIds(pending.sourceMsgIds).length) {
    return clearPendingIfStartRemoved(charId);
  }
  const dropped = (droppedContents || []).map((x) => String(x || '')).filter(Boolean);
  if (!dropped.some((t) => messageLooksLikePendingStart(t, pending))) return false;
  if (remainingContent && messageLooksLikePendingStart(remainingContent, pending)) return false;
  clearPending(charId);
  return true;
}

function pendingLooksLikeNarrative(row) {
  if (!row) return false;
  return /梦/.test(String(row.dest || '')) || /梦/.test(String(row.label || ''));
}

function getDueProcess(charId) {
  const row = getPending(charId);
  if (!row) return null;
  if (pendingLooksLikeNarrative(row)) {
    clearPending(charId);
    return null;
  }
  if (!pendingStartStillPresent(charId, row)) {
    clearPending(charId);
    return null;
  }
  if (Date.now() < Number(row.dueAt || 0)) return null;
  // silent：只用于过程锁，到期后清掉、不主动刷「做完了」
  if (row.silent) {
    clearPending(charId);
    return null;
  }
  return row;
}

/** @deprecated 别名 */
function getDueTravelArrive(charId) {
  const row = getDueProcess(charId);
  if (!row) return null;
  if (row.kind && row.kind !== 'travel_arrive') return row; // 其它到期行为也走同一主动通道
  return row;
}

function sanitizeDest(raw) {
  const s = String(raw || '').replace(/之后|再发|发定位|定位|一下|一趟|了$/g, '').slice(0, 12);
  if (!s || /梦|虚构|剧情/.test(s)) return '';
  return s;
}

function guessDest(userText, aiText) {
  const blob = String(userText || '');
  const m = blob.match(/(?:去|到|往)\s*([^\s，。！？,.!?]{2,12})/);
  if (m) {
    const d = sanitizeDest(m[1]);
    if (d) return d;
  }
  const a = String(aiText || '').match(/(?:去|到)\s*([^\s，。！？,.!?]{2,10})/);
  if (a) return sanitizeDest(a[1]);
  return '';
}

function detectKindFromTexts(userText, aiText) {
  const u = String(userText || '');
  const a = String(aiText || '');
  if (looksLikeDreamOrFiction(a) && !userWantsArriveLocation(u)) return null;
  if (userWantsArriveLocation(u) || (USER_ASK_GO_RE.test(u) && /定位|位置/.test(u))) {
    return PROCESS_KINDS.find((k) => k.kind === 'travel_arrive');
  }
  for (const kind of PROCESS_KINDS) {
    if (kind.kind === 'travel_arrive') continue;
    const userAsked = kind.userAskRe && kind.userAskRe.test(u);
    const started = kind.startRe.test(a) || kind.startRe.test(u);
    if (userAsked && (started || /好|行|嗯|去了|这就|马上/.test(a))) return kind;
    if (started && /(?:完|好)(?:了)?(?:再)?(?:告诉|跟你说|回你|找你|说一声)/.test(a)) return kind;
  }
  if (charJustDeparted(a) && recentUserAskedArriveLocation([{ role: 'user', content: u }], u)) {
    return PROCESS_KINDS.find((k) => k.kind === 'travel_arrive');
  }
  // 角色自己开启耗时行为（即使同轮误写了「做完」也先认作该行为，交给 strip 淡化）
  for (const kind of PROCESS_KINDS) {
    if (kind.kind === 'travel_arrive') continue;
    if (kind.startRe.test(a)) return kind;
  }
  if (charJustDeparted(a)) {
    return PROCESS_KINDS.find((k) => k.kind === 'travel_arrive');
  }
  return null;
}

function shouldProactiveCallback(kind, userText, aiText) {
  if (!kind) return false;
  const u = String(userText || '');
  const a = String(aiText || '');
  if (kind.kind === 'travel_arrive') {
    if (userWantsArriveLocation(u)) return true;
    if (kind.userAskRe && kind.userAskRe.test(u)) return true;
    if (/(?:到了|抵达).{0,10}(?:告诉|跟你说|回你|说一声|发(?:个)?定位)/.test(a)) return true;
    return false;
  }
  if (kind.userAskRe && kind.userAskRe.test(u)) return true;
  if (/(?:完|好)(?:了)?(?:再)?(?:告诉|跟你说|回你|找你|说一声)/.test(a)) return true;
  if (/(?:完|好)(?:了)?(?:再)?(?:告诉|跟我说|回我|找我|说一声)/.test(u)) return true;
  return false;
}

/**
 * 「等我睡醒了再说」「等你下班了回来」是预约/谈对方，不是角色宣称自己此刻已做完。
 * 用掩码去掉这些片段后再查 doneRe / 做 soften，避免气泡被改成「等你还没下班回来」。
 */
const DONE_CLAIM_WORDS = '睡醒了|醒了|起来了|午睡完了?|眯完了|睡好了|做完了|弄完了|吃完了|洗完了|泡完了|忙完了|处理好了|搞定了|加完班了?|开完会了?|忙完工作了?|弄完工作了?|处理完工作了?|下班了|完了|好了|到了|回来了|下了';
const DEFERRED_DONE_SPAN_RE = new RegExp(
  `等(?:我|他|她|你|您|TA|对方|着)?[^。！？\\n]{0,12}(?:${DONE_CLAIM_WORDS}).{0,10}(?:再|才|就|告诉|回|找|说|联系|发|叫|回来|到家)?`
  + `|等(?:我|他|她|你|您|TA|对方)[^。！？\\n]{0,12}(?:睡醒了?|醒来|醒了|起来了?|做完|弄完|吃完|洗完|泡完|忙完|加完班|开完会|下班|到了|回来)`
  + `|(?:睡醒了|醒了|起来了|做完了|弄完了|吃完了|洗完了|忙完了|处理好了|搞定了|下班了|加完班了?|好了|完了|到了|下了).{0,2}再(?:说|聊|回|找|联系|告诉|发)`
  // 谈对方完工：「你下班了吗」≠ 角色自己下班
  + `|(?:你|您|对方)(?:还)?[^。！？\\n]{0,8}(?:${DONE_CLAIM_WORDS})`,
  'g'
);

function maskDeferredCompletionSpans(text) {
  return String(text || '').replace(DEFERRED_DONE_SPAN_RE, (m) => '　'.repeat([...m].length));
}

function applySoftenProtected(text, softenPairs) {
  const slots = [];
  let out = String(text || '').replace(DEFERRED_DONE_SPAN_RE, (m) => {
    const i = slots.length;
    slots.push(m);
    return `\u0000D${i}\u0000`;
  });
  for (const [re, to] of softenPairs) {
    out = out.replace(re, to);
  }
  return out.replace(/\u0000D(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

function claimsDoneTooSoon(kind, text, pending = null) {
  const t = String(text || '').replace(/^【自动回复】/, '');
  if (!t || !kind) return false;
  if (kind.skipRe && kind.skipRe.test(t)) return false;
  if (CONVERSATIONAL_OK_RE.test(t.replace(/\s+/g, ''))) return false;
  if (kind.kind === 'travel_arrive') return charClaimsArrived(t);
  const doneRe = pendingDoneRe(pending, kind);
  const probe = maskDeferredCompletionSpans(t);
  return doneRe.test(probe) && !/还没|快|马上|还在/.test(t);
}

function makeCustomKind(label, minutes) {
  const m = Math.max(8, Math.min(180, Number(minutes) || 25));
  return {
    kind: 'custom',
    label: String(label || '做事').slice(0, 20),
    startRe: OPEN_PROCESS_HINT_RE,
    doneRe: GENERIC_DONE_RE,
    soften: GENERIC_SOFTEN,
    delayMin: [m, m],
  };
}

function userAsksProcessProgress(userMessage) {
  return /还要多久|还有多久|还要几|还得几|什么时候好|什么时候完|什么时候到|好了没|完了没|到了没|洗好没|吃好没|弄好没|做好没|好了吗|完了吗|到了吗|好了没有|还没好吗|多久才|要多久/.test(String(userMessage || ''));
}

function progressTone(leftMin) {
  const n = Math.max(1, Number(leftMin) || 1);
  if (n <= 5) return '就快好了';
  if (n <= 15) return '还要一小会儿';
  if (n <= 40) return '还得再过一阵';
  return '还早着';
}

function ongoingProcessNote({ label, travel, dest, needLocation, userAsks, leftMin, mediaLock }) {
  const ask = userAsks
    ? `对方在问进度：口语说「${progressTone(leftMin)}」即可，不要报精确分钟或倒计时。`
    : '聊天照常接话。禁止主动提还要多久、倒计时、还差几分钟、快做完了；对方没问进度就当没这回事。';
  const media = mediaLock ? String(mediaLock) : '';
  if (needLocation || travel) {
    const d = dest ? `（往${dest}）` : '';
    const loc = needLocation ? '禁止说已到，禁止发到达定位。' : '禁止说已到。';
    return `【过程时间·硬性】你还在路上${d}。${loc}${media}${ask}`;
  }
  return `【过程时间·硬性】你还在「${label}」中，禁止宣称已经做完/好了/完了。${media}${ask}`;
}

/**
 * 系统提示：当前若有进行中行为 / 用户刚要求「做完再说」
 */
function buildProcessTimeNoteForChar(charId, history, userMessage) {
  const u = String(userMessage || '');
  const userAsks = userAsksProcessProgress(u);
  let stored = getPending(charId);
  if (stored && !pendingStartStillPresent(charId, stored)) {
    clearPending(charId);
    stored = null;
  }
  if (stored && Date.now() < Number(stored.dueAt || 0)) {
    const leftMin = Math.max(1, Math.round((Number(stored.dueAt) - Date.now()) / 60000));
    const mediaLock = (stored.needImage || stored.needVideo)
      ? `禁止本轮写「配图：」「自拍：」「配视频：」或假装已发出${stored.needVideo ? '视频' : '图'}。`
      : '';
    return ongoingProcessNote({
      label: stored.label || '这件事',
      travel: stored.kind === 'travel_arrive',
      dest: stored.dest || '',
      needLocation: !!stored.needLocation,
      userAsks,
      leftMin,
      mediaLock,
    });
  }
  if (stored && Date.now() >= Number(stored.dueAt || 0)) {
    if (stored.needLocation) {
      return `【过程时间】先前答应到了发定位，现在该到了：说到了，并发[位置]短标题|详细地址[/位置]。`;
    }
    if (stored.needImage || stored.needVideo) {
      const line = stored.needVideo ? '「配视频：英文画面」' : '「配图：英文画面」或「自拍：英文画面」（本人出镜才用自拍）';
      return `【过程时间】先前答应到家/之后再发${stored.needVideo ? '视频' : '图'}，现在该发了：口语带一句，末尾另起一行写${line}。`;
    }
    if (stored.kind === 'travel_arrive') {
      return `【过程时间】按路程现在该到了：可以自然说一声到了，不要假装还在路上。`;
    }
    return `【过程时间】你的「${stored.label || '事'}」按耗时该结束了：可以自然说一声好了/完了，不要假装还在做。`;
  }

  // 用户本轮刚要求「做完/到了再…」
  if (userWantsArriveLocation(u)) {
    return `【过程时间·硬性】用户要你「到了再」发定位：本轮只能答应或说刚出门，禁止已到+定位卡。路程需要真实时间。不要报还有多久到。`;
  }
  if (userWantsDeferredMedia(u) || recentUserAskedDeferredMedia(history, userMessage)) {
    const { wantVideo } = deferredMediaKind(u || String((history || []).slice(-1)[0]?.content || ''));
    const what = wantVideo ? '视频' : '图/照片';
    return `【过程时间·硬性】用户要你「到家/之后再」发${what}：本轮只能答应或说在路上/还没到家，禁止本轮写「配图：」「自拍：」「配视频：」或假装已发出。到了/到家后再另发。不要报还有多久。`;
  }
  for (const kind of PROCESS_KINDS) {
    if (kind.kind === 'travel_arrive') continue;
    if (kind.userAskRe && kind.userAskRe.test(u)) {
      return `【过程时间·硬性】用户要你「${kind.label}完了再」联系：本轮只能答应或说正要去/刚开始，禁止同一条里写已经做完。不要报还要多久。`;
    }
  }

  // 对话里刚开始、尚未预约时的短锁（出门不在这里点名，避免梦境/叙事误报）
  const aiMsgs = (history || [])
    .filter((m) => m.role === 'assistant' && m.type !== 'system')
    .slice(-8);
  for (const kind of PROCESS_KINDS) {
    if (kind.kind === 'travel_arrive') continue;
    let startTs = NaN;
    let done = false;
    for (const m of aiMsgs) {
      const t = String(m.content || '');
      if (looksLikeDreamOrFiction(t)) continue;
      if (kind.doneRe.test(t) || (kind.skipRe && kind.skipRe.test(t))) {
        done = true;
        startTs = NaN;
        continue;
      }
      if (kind.startRe.test(t)) {
        done = false;
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : NaN;
        startTs = Number.isFinite(ts) ? ts : Date.now();
      }
    }
    if (done || !Number.isFinite(startTs)) continue;
    const gapMin = Math.round((Date.now() - startTs) / 60000);
    const minNeed = Math.floor((kind.delayMin[0] || 15) * 0.7);
    if (gapMin < minNeed) {
      return ongoingProcessNote({
        label: kind.label,
        userAsks,
        leftMin: Math.max(1, minNeed - gapMin),
      });
    }
  }
  return '';
}

/** @deprecated */
function buildTravelProcessNoteForChar(charId, history, userMessage) {
  return buildProcessTimeNoteForChar(charId, history, userMessage);
}

function buildTravelProcessNote(history, userMessage) {
  return buildProcessTimeNoteForChar(null, history, userMessage);
}

/**
 * 回复后：若开启了耗时行为，预约「做完再报」
 * 优先：角色自报 [过程:…] → 正则种类 → 模型估算分钟数
 */
async function maybeScheduleProcess(charId, userMessage, aiContent, history = [], opts = {}) {
  if (!charId) return null;
  const ai = String(aiContent || '');
  if (isMetaOrTechTalk(userMessage, ai)) return null;
  if (looksLikeDreamOrFiction(ai) || looksLikeDreamOrFiction(userMessage)) return null;
  const tag = parseProcessTag(ai);
  let kind = detectKindFromTexts(userMessage, ai);
  let minutesOverride = tag ? tag.minutes : null;

  if (tag && !kind) {
    kind = makeCustomKind(tag.label, tag.minutes);
  } else if (tag && kind) {
    kind = { ...kind, label: tag.label || kind.label, delayMin: [tag.minutes, tag.minutes] };
  }

  // 用户约定「到家再发图/视频」：角色答应了就上锁（不必真说出「出门」）
  const deferMediaAsk = recentUserAskedDeferredMedia(history, userMessage);
  if (!kind && deferMediaAsk) {
    const agreed = /好|行|嗯|可以|成|到了.{0,4}发|到家.{0,4}发|回去.{0,4}发|记得|等会|一会儿|回家|到家|回去/.test(ai);
    const heading = /回家|到家|回去|在路上|出门|出发/.test(ai);
    if (agreed || heading) {
      kind = makeCustomKind('回家后再发', 28);
      minutesOverride = 28;
    }
  }

  if (!kind && looksLikeOpenProcess(ai)) {
    const settings = opts.settings || null;
    if (settings) {
      const est = await estimateProcessWithLlm(settings, userMessage, ai);
      if (est) {
        kind = makeCustomKind(est.label, est.minutes);
        minutesOverride = est.minutes;
      }
    }
  }
  if (!kind) return null;

  // 本轮已宣称完成且带定位（旅行）→ 清掉
  if (claimsDoneTooSoon(kind, ai) && (kind.kind !== 'travel_arrive' || LOC_MARK_RE.test(ai))) {
    if (kind.kind === 'travel_arrive' && charClaimsArrived(ai) && LOC_MARK_RE.test(ai)) {
      clearPending(charId);
      return null;
    }
    if (kind.kind !== 'travel_arrive' && kind.doneRe.test(ai) && !kind.startRe.test(ai)) {
      clearPending(charId);
      return null;
    }
  }

  // 旅行：有「到了发定位」约定时走定位预约；角色自己说出门也至少上过程锁（silent）
  if (kind.kind === 'travel_arrive') {
    const wantLoc = recentUserAskedArriveLocation(history, userMessage);
    const departing = charJustDeparted(ai) || /好|行|嗯|记得|到了就|到了发|到了告诉/.test(ai);
    const userPush = userWantsArriveLocation(userMessage) && USER_ASK_GO_RE.test(String(userMessage || ''));
    if (wantLoc) {
      if (!departing && !userPush) return null;
    } else if (!charJustDeparted(ai)) {
      return null;
    }
  } else {
    // 其它：角色一开始做事就锁真实耗时（默认可静默到期，有人要求「做完告诉我」才主动报）
    const started = kind.startRe.test(ai) || !!tag || kind.kind === 'custom';
    const agreed = /好|行|嗯|去了|这就|马上|等会|一会儿|记得/.test(ai);
    const userAsked = kind.userAskRe && kind.userAskRe.test(String(userMessage || ''));
    if (!started && !(userAsked && agreed)) return null;
    if (claimsDoneTooSoon(kind, ai) && !started) {
      clearPending(charId);
      return null;
    }
  }

  const existing = getPending(charId);
  if (existing && Date.now() < Number(existing.dueAt || 0)
    && (existing.kind === kind.kind || (existing.kind === 'custom' && kind.kind === 'custom' && existing.label === kind.label))) {
    // 已有锁时补上延后发图约定
    if (recentUserAskedDeferredMedia(history, userMessage) && !(existing.needImage || existing.needVideo)) {
      const { wantImage, wantVideo } = deferredMediaKind(userMessage);
      setPending(charId, {
        ...existing,
        needImage: wantImage || existing.needImage,
        needVideo: wantVideo || existing.needVideo,
        tip: wantVideo ? '到家发视频' : '到家发图',
        silent: false,
      });
      return getPending(charId);
    }
    return existing;
  }

  const delay = minutesOverride != null
    ? Math.max(8, Math.min(180, minutesOverride)) * 60 * 1000
    : pickDelayMs(kind, userMessage, ai);
  const dueAt = Date.now() + delay;
  const proactive = shouldProactiveCallback(kind, userMessage, ai);
  const travelWithLoc = kind.kind === 'travel_arrive' && recentUserAskedArriveLocation(history, userMessage);
  const deferMedia = recentUserAskedDeferredMedia(history, userMessage);
  const mediaBits = deferMedia ? deferredMediaKind(userMessage) : { wantImage: false, wantVideo: false };
  setPending(charId, {
    kind: kind.kind,
    label: kind.label,
    dueAt,
    dest: kind.kind === 'travel_arrive' ? guessDest(userMessage, ai) : '',
    tip: travelWithLoc
      ? '到了发定位'
      : (mediaBits.wantVideo ? '到家发视频' : mediaBits.wantImage ? '到家发图' : `${kind.label}做完报一声`),
    needLocation: !!(kind.needLocation && travelWithLoc),
    needImage: !!mediaBits.wantImage,
    needVideo: !!mediaBits.wantVideo,
    // 无「做完告诉我」时 silent：只挡秒完，到期不刷主动消息；有约定或旅行定位/延后发图则主动报
    silent: !(proactive || travelWithLoc || deferMedia),
    donePattern: kind.kind === 'custom' ? String(GENERIC_DONE_RE.source) : '',
    sourceMsgIds: opts.sourceMsgIds,
  });
  // 开始语所在气泡若当轮已撤回/没落库，立刻取消，避免空待办到点还报完
  if (normalizeSourceMsgIds(opts.sourceMsgIds).length) {
    clearPendingIfStartRemoved(charId);
  }
  const stored = getPending(charId);
  if (stored) {
    console.log(`[process-time] scheduled char=${charId} kind=${kind.kind} in ~${Math.round(delay / 60000)}min proactive=${proactive || travelWithLoc}`);
  }
  return stored;
}

/** @deprecated */
async function maybeScheduleTravelArrive(charId, userMessage, aiContent, history = [], opts = {}) {
  return maybeScheduleProcess(charId, userMessage, aiContent, history, opts);
}

/**
 * 过早完成：淡化「做完了」表述；旅行额外剥定位卡；延后发图/视频剥媒体指令行
 */
function stripPrematureProcess(content, { charId, userMessage, history } = {}) {
  let text = String(content || '');
  if (!text) return text;

  const pending = charId ? getPending(charId) : null;
  const tooEarly = pending && Date.now() < Number(pending.dueAt || 0);
  const deferMediaNow = recentUserAskedDeferredMedia(history, userMessage)
    || !!(pending && tooEarly && (pending.needImage || pending.needVideo));

  if (pending && Date.now() >= Number(pending.dueAt || 0)) {
    return stripProcessTags(text);
  }

  // 推断本轮相关 kind（含自定义 pending）
  let kind = null;
  if (pending) {
    kind = resolveKindForPending(pending.kind)
      || (pending.kind === 'custom'
        ? makeCustomKind(pending.label, Math.round((Number(pending.dueAt) - Date.now()) / 60000) || 20)
        : null);
  }
  if (!kind) kind = detectKindFromTexts(userMessage, text);
  if (!kind && recentUserAskedArriveLocation(history, userMessage)) {
    kind = PROCESS_KINDS.find((k) => k.kind === 'travel_arrive');
  }
  if (!kind && !tooEarly) {
    const u = String(userMessage || '');
    for (const k of PROCESS_KINDS) {
      if (k.userAskRe && k.userAskRe.test(u)) {
        kind = k;
        break;
      }
    }
  }

  // 延后发图/视频：无论是否已锁行程，本轮都剥掉媒体指令行
  if (deferMediaNow) {
    text = stripMediaDirectiveLines(text);
  }

  // 无 kind 也剥掉自报标签，避免露馅
  if (!kind) return stripProcessTags(text);

  const startedThisTurn = kind.startRe.test(text) || !!parseProcessTag(text);
  const forceEarly = tooEarly
    || startedThisTurn
    || (kind.userAskRe && kind.userAskRe.test(String(userMessage || '')))
    || (kind.kind === 'travel_arrive' && recentUserAskedArriveLocation(history, userMessage));
  if (!forceEarly) return stripProcessTags(text);

  const hasDone = claimsDoneTooSoon(kind, text, pending);
  const hasLoc = kind.needLocation && (LOC_MARK_RE.test(text) || /\[\s*\/\s*(?:发送\s*)?位置\s*\]/.test(text));
  const hasMediaLine = /^\s*(?:配图|自拍|配视频)\s*[:：]/im.test(text);
  // 仅淡化「此刻已完成」的宣称；「等…醒了再说」等预约句原样保留
  if (!hasDone && !hasLoc && !hasMediaLine) return stripProcessTags(text);

  if (hasLoc) {
    text = text
      .replace(/\[\s*位置\s*\][\s\S]*?\[\s*\/\s*位置\s*\]/gi, '')
      .replace(/【\s*位置\s*】[\s\S]*?【\s*\/\s*位置\s*】/gi, '')
      .replace(/\[\s*(?:发送\s*)?位置\s*[:：][^\]]*\]/gi, '')
      .replace(/【\s*(?:发送\s*)?位置\s*[:：][^】]*】/gi, '')
      .replace(/\[\s*\/\s*(?:发送\s*)?位置\s*\]/gi, '')
      .replace(/【\s*\/\s*(?:发送\s*)?位置\s*】/gi, '');
  }
  if (hasMediaLine || deferMediaNow) {
    text = stripMediaDirectiveLines(text);
  }
  const soften = kind.soften || GENERIC_SOFTEN;
  text = applySoftenProtected(text, soften);
  return stripProcessTags(text).replace(/\n{3,}/g, '\n\n').trim();
}

/** @deprecated */
function stripPrematureArrivalLocation(content, opts) {
  return stripPrematureProcess(content, opts);
}

function buildProcessDoneProactiveExtra(pending, { userName } = {}) {
  const name = userName || '对方';
  const kind = resolveKindForPending(pending?.kind) || null;
  const isTravel = kind?.kind === 'travel_arrive' || pending?.kind === 'travel_arrive';
  if (pending?.needLocation) {
    const dest = pending?.dest ? `目的地大概是「${pending.dest}」` : '你先前答应去的地方';
    return `【过程时间·到了】
你先前答应${name}：到了之后发定位。按路程现在该到了。
${dest}。
这轮要发出去两样：一两句口语说你到了（按性格，别写成汇报）；另起一行定位卡 [位置]短标题|详细地址[/位置]（细到路/地标，不要只写城市）。没有定位卡系统发不出去。
别再说在路上/还没到；别约见面；别输出【过程时间】、[过程:…] 等标记。`;
  }
  if (pending?.needImage || pending?.needVideo) {
    const what = pending.needVideo ? '视频' : '图';
    const line = pending.needVideo
      ? '「配视频：英文画面描述」'
      : '「配图：英文画面」或「自拍：英文画面」（本人出镜才用自拍）';
    return `【过程时间·到家发${what}】
你先前答应${name}：到家/之后再发${what}。按路程现在该到了。
这轮要发出去两样：一两句口语说你到了/到家了；末尾另起一行写${line}（系统会真发出去）。
别再说在路上；别约见面；别输出过程系统标记。`;
  }
  if (isTravel) {
    const dest = pending?.dest ? `（往「${pending.dest}」那边）` : '';
    return `【过程时间·到了】
你先前出门了${dest}。按路程现在该到了。
用一两句口语跟${name}说一声到了（按性格），可带一句近况，别写成汇报。
别再说在路上；别约见面；别输出过程系统标记。`;
  }
  const label = pending?.label || kind?.label || '这件事';
  return `【过程时间·做完了】
你先前在「${label}」。按真实耗时现在该结束了。
用一两句口语跟${name}说一声好了/完了（按性格），可带一句近况，别写成汇报。
别再说「正要去/还在做」；别约见面；别输出过程系统标记。`;
}

/** @deprecated */
function buildTravelArriveProactiveExtra(pending, opts) {
  return buildProcessDoneProactiveExtra(pending, opts);
}

/** 提示词常驻短规则（默认不再注入，避免每轮强调过程/抵达） */
function buildProcessTimePromptRule() {
  return '';
}

function listDueCharIdsFromSettings() {
  const map = loadPendingMap();
  const now = Date.now();
  const ids = [];
  for (const [id, row] of Object.entries(map)) {
    if (!row?.dueAt || now < Number(row.dueAt)) continue;
    if (!pendingStartStillPresent(id, row)) {
      try { clearPending(id); } catch {}
      continue;
    }
    if (row.silent || pendingLooksLikeNarrative(row)) {
      // 到期静默项 / 梦境误报直接清掉
      try { clearPending(id); } catch {}
      continue;
    }
    ids.push(id);
  }
  return ids;
}

module.exports = {
  PROCESS_KINDS,
  userWantsArriveLocation,
  userWantsDeferredMedia,
  recentUserAskedArriveLocation,
  recentUserAskedDeferredMedia,
  deferredMediaKind,
  buildProcessTimeNoteForChar,
  buildTravelProcessNote,
  buildTravelProcessNoteForChar,
  maybeScheduleProcess,
  maybeScheduleTravelArrive,
  stripPrematureProcess,
  stripPrematureArrivalLocation,
  stripProcessTags,
  stripMediaDirectiveLines,
  parseProcessTag,
  getPending,
  getDueProcess,
  getDueTravelArrive,
  clearPending,
  clearPendingIfStartRemoved,
  onAssistantMessagesChanged,
  buildProcessDoneProactiveExtra,
  buildTravelArriveProactiveExtra,
  buildProcessTimePromptRule,
  listDueCharIdsFromSettings,
};

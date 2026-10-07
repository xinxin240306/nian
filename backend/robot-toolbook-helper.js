/**
 * 桌宠工具：角色主动调用走 chat tools；回复里的 [桌宠:…] 仅作内部/兜底解析。
 * 工具书给系统匹配用户问法，不整本塞进角色提示词。
 * 灯/头由语气编译层补，不必靠角色背标记。
 */

const { ROBOT_INVOKE_ALIASES } = (() => {
  // 避免循环依赖：标签别名在本文件自洽一份，与 robot-helper 保持同步
  const aliases = {
    看一眼: 'peek', 看看: 'peek', 扫一眼: 'peek', 瞄一眼: 'peek', peek: 'peek',
    说句话: 'chat', 说话: 'chat', 聊一句: 'chat', 说一句: 'chat', chat: 'chat',
    逗你: 'tease', 逗: 'tease', 皮一下: 'tease', tease: 'tease',
    安静看: 'silent', 不说话: 'silent', 只看: 'silent', 只看不言: 'silent', 只看不说: 'silent', silent: 'silent',
    记住这一幕: 'peek_remember', 记住: 'peek_remember', 拍一张: 'peek_remember', snapshot: 'peek_remember',
    想你了: 'comfort', 想念: 'comfort', comfort: 'comfort',
    找人: 'find', 找你: 'find', 找我: 'find', 找一下: 'find', 找一找: 'find', 找到你: 'find',
    find: 'find', find_user: 'find', locate: 'find',
    跟着: 'follow', 一直跟着: 'follow', 跟着我: 'follow', 跟着用户: 'follow',
    跟着转: 'follow', follow: 'follow', track: 'follow',
    别跟着: 'unfollow', 不要跟着: 'unfollow', 停下跟着: 'unfollow', 停止跟着: 'unfollow',
    取消跟着: 'unfollow', unfollow: 'unfollow', stop_follow: 'unfollow',
  };
  return { ROBOT_INVOKE_ALIASES: aliases };
})();

/** @typedef {{ id: string, tag: string, label: string, when: string, patterns: RegExp[] }} RobotTool */

/** 工具书（给系统匹配用，不整本塞进角色提示词） */
const ROBOT_TOOLBOOK = [
  {
    id: 'unfollow',
    tag: '[桌宠:别跟着]',
    label: '停下跟着',
    when: '不要小机再跟人转头',
    patterns: [
      /别跟着/, /不要跟着/, /别再跟/, /停下跟着/, /停止跟着/, /取消跟着/,
      /别一直盯/, /不用跟着/,
    ],
  },
  {
    id: 'follow',
    tag: '[桌宠:跟着]',
    label: '一直跟着',
    when: '要小机持续用人脸跟着转头',
    patterns: [
      /一直跟着/, /跟着(?:我|你|用户)?转/, /让小机跟着/, /盯着(?:我|你)看/,
      /持续跟/, /跟着(?:我|你)挪/,
    ],
  },
  {
    id: 'find',
    tag: '[桌宠:找人]',
    label: '找人',
    when: '不知道用户在哪、或想确认人在不在桌边——小机会转头看一圈找人脸并对准；开了认人再判断是不是你',
    patterns: [
      /找(?:找)?你/, /找(?:找)?我/, /找人/, /找一下你/, /找一找你/, /找一下我/, /你人呢/,
      /人在不在/, /你在不在/, /在不在(?:桌边|旁边|那儿|那里|跟前)/,
      /看看你人/, /看看你在不在/, /看看人在不在/,
      /确认(?:你|人)在/, /人还在吗/, /你还在吗/, /还在桌边吗/,
      /(?:小机|桌宠|桌上|镜头|摄像头).{0,12}(?:找|确认)/,
      /借(?:小机|它|机器).{0,8}找/,
    ],
  },
  {
    id: 'peek_remember',
    tag: '[桌宠:记住这一幕]',
    label: '看一眼并记住',
    when: '看一眼并悄悄记下',
    patterns: [
      /记住这一幕/, /拍一张/, /悄悄拍/, /记下这一幕/,
    ],
  },
  {
    id: 'silent',
    tag: '[桌宠:只看不言]',
    label: '只看不言',
    when: '只看不说话',
    patterns: [
      /只看不言/, /只看不说/, /安静看/, /不说话只看/,
    ],
  },
  {
    id: 'peek',
    tag: '[桌宠:看一眼]',
    label: '看一眼环境',
    when: '看用户/桌边（截图识图，不找脸）',
    patterns: [
      /看一眼/, /瞄一眼/, /扫一眼/, /看你一眼/, /看一下你/,
      /看看你(?:$|[。！？…!?，,啊呀呢吧嘛了么吗～~一眼]|现在|什么样|在干|干嘛|旁边|那边)/,
      /想看看你/, /让我看看你/, /我想看看你/,
      /看你现在/, /看你什么样/,
      /看看(?:周围|环境|桌边|那边|你那边)/,
      /看周围一眼/, /看那边一眼/,
      /(?:小机|桌宠|桌上|镜头|摄像头).{0,12}(?:看|瞄|扫|拍)/,
      /借(?:小机|它|机器).{0,10}看/,
      /用(?:小机|它|机器|镜头|摄像头).{0,8}看/,
      /透过(?:小机|镜头|摄像头)/,
      /开(?:一下)?(?:镜头|摄像头)/,
    ],
  },
  {
    id: 'tease',
    tag: '[桌宠:逗你]',
    label: '逗一下',
    when: '想逗对方',
    patterns: [/逗你一下/, /皮一下/, /吓你一下/, /逗逗你/],
  },
  {
    id: 'comfort',
    tag: '[桌宠:想你了]',
    label: '想念靠近',
    when: '想念、想靠近说一句',
    patterns: [
      /想你了.*(?:靠近|看看|小机|桌边)/,
      /(?:靠近|小机|桌边).{0,6}想你/,
    ],
  },
  {
    id: 'chat',
    tag: '[桌宠:说句话]',
    label: '说句话',
    when: '从喇叭说一两句',
    patterns: [
      /从喇叭/,
      /(?:小机|桌宠|桌上).{0,8}(?:说|开口|喊)/,
      /借(?:小机|它).{0,6}说/,
    ],
  },
];

const OPEN = '[\\[【［]';
const CLOSE = '[\\]】］]';
const TAG_RE = new RegExp(`${OPEN}\\s*桌宠\\s*[：:]\\s*([^\\]】］\\n]+?)\\s*${CLOSE}`, 'gi');
const TAG_UNCLOSED_RE = new RegExp(`${OPEN}\\s*桌宠\\s*[：:]\\s*([^\\]】］\\n]{1,40})\\s*$`, 'gim');

function resolveTagValue(raw) {
  const key = String(raw || '').trim();
  const low = key.toLowerCase();
  return ROBOT_INVOKE_ALIASES[low] || ROBOT_INVOKE_ALIASES[key] || null;
}

function stripDeskTags(text) {
  return String(text || '')
    .replace(TAG_RE, '')
    .replace(TAG_UNCLOSED_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从角色回复解析调用：只认 [桌宠:…]，不扫自然语言用意。
 * @returns {{ intent: string|null, textWithout: string, found: boolean, source: 'tag'|null, tool: RobotTool|null }}
 */
function resolveRobotIntentFromText(rawText) {
  const raw = String(rawText || '');
  let tagIntent = null;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(raw)) !== null) {
    tagIntent = resolveTagValue(m[1]) || 'chat';
  }
  TAG_UNCLOSED_RE.lastIndex = 0;
  while ((m = TAG_UNCLOSED_RE.exec(raw)) !== null) {
    tagIntent = resolveTagValue(m[1]) || tagIntent || 'chat';
  }

  const textWithout = stripDeskTags(raw);
  if (tagIntent) {
    const tool = ROBOT_TOOLBOOK.find((t) => t.id === tagIntent) || null;
    return { intent: tagIntent, textWithout, found: true, source: 'tag', tool };
  }
  return { intent: null, textWithout, found: false, source: null, tool: null };
}

/**
 * 用户这句话要小机做什么。和角色回复匹配分开：
 * 用户下的指令由服务端直接调，不等人设对词，也不写进聊天提示词。
 *
 * deferChat：先开镜头，等图到了再让角色回话（peek/find/拍照）。
 * immediate：当下就执行，角色仍正常回（跟着/别跟着）。
 * post：等角色这轮话说完再执行（喇叭说、逗、靠近）。
 */
const USER_ASK_TOOLS = [
  {
    id: 'unfollow',
    when: 'immediate',
    patterns: [
      /别跟着/, /不要跟着/, /别再跟/, /停下跟着/, /停止跟着/, /取消跟着/,
      /别一直盯/, /不用跟着/, /不要(?:再)?盯着我/,
    ],
  },
  {
    id: 'follow',
    when: 'immediate',
    patterns: [
      /跟着我/, /一直跟着/, /盯着我(?:看|转)?/, /用人脸跟/,
      /让(?:小机|它|桌宠|桌上).{0,6}跟着/, /转头跟着/,
    ],
  },
  {
    id: 'find',
    when: 'defer',
    patterns: [
      /找我/, /找找我/, /找一下我/, /找我一下/, /帮我找(?:一下|找)?/, /把我找(?:到|出来)?/, /镜头对准我/,
      /对着我/, /我(?:人)?在哪/, /你找(?:找|一下)?我/, /找人/, /对准我/,
    ],
  },
  {
    id: 'peek_remember',
    when: 'defer',
    patterns: [
      /记住这一幕/, /拍我一张/, /给我拍(?:一)?张/, /拍(?:一)?张照(?:看)?我/,
    ],
  },
  {
    id: 'peek',
    when: 'defer',
    patterns: [
      /看得见(?:我|吗)/, /看到我了?吗/, /看见我/, /看得到(?:我|吗)/,
      /你能看(?:见|到)(?:我|吗)/, /能看见(?:我|吗)/, /看看我(?:一眼|一下)?/, /看我一眼/,
      /用小机看(?:看)?我/, /开镜头看(?:看)?我/, /帮我看一眼/,
    ],
  },
  {
    id: 'chat',
    when: 'post',
    patterns: [
      /用喇叭/, /从喇叭/, /喇叭说/,
      /让(?:小机|桌宠|它|桌上).{0,8}(?:说|开口|喊)/,
      /从小机说/, /桌上那台说/,
    ],
  },
  {
    id: 'tease',
    when: 'post',
    patterns: [/逗我一下/, /吓我一下/, /皮一下/],
  },
];

function resolveRobotIntentFromUserAsk(userText) {
  const probe = String(userText || '').replace(/\s+/g, '');
  if (!probe) return { intent: null, when: null, found: false };
  try {
    if (require('./phone-llm-tools').isPhoneTopicAsk(probe)) {
      return { intent: null, when: null, found: false };
    }
  } catch {}
  for (const tool of USER_ASK_TOOLS) {
    for (const re of tool.patterns) {
      if (re.test(probe) || re.test(String(userText || ''))) {
        return { intent: tool.id, when: tool.when, found: true };
      }
    }
  }
  return { intent: null, when: null, found: false };
}

function userAskedRobotToLook(userText) {
  const hit = resolveRobotIntentFromUserAsk(userText);
  return hit.found && (hit.when === 'defer');
}

/** 给调试/文档用的短表（不进提示词） */
function listRobotToolsBrief() {
  return ROBOT_TOOLBOOK.map((t) => ({
    id: t.id,
    tag: t.tag,
    label: t.label,
    when: t.when,
  }));
}

/**
 * 像世界书关键词：从用户话 / 近窗文本里匹配该注入哪些工具说明。
 * 不整本塞进提示词；没命中则返回空。
 */
function matchToolsForPrompt(text) {
  const raw = String(text || '');
  const probe = raw.replace(/\s+/g, '');
  if (!probe) return [];
  const hits = [];
  for (const tool of ROBOT_TOOLBOOK) {
    for (const re of tool.patterns) {
      if (re.test(probe) || re.test(raw)) {
        hits.push(tool);
        break;
      }
    }
  }
  // 灯/舵机不在桌宠 toolbook 里，用轻量关键词补
  if (/灯|亮一下|闪一下|发光|关灯/.test(raw)) {
    hits.push({
      id: 'led',
      tag: '[灯光:粉 0.8]',
      label: '控灯',
      when: '亮灯/关灯',
      patterns: [],
    });
  }
  if (/转头|转个头|点头|摇头|歪头|抬头|低头|看左|看右|往左|往右|舵机/.test(raw)) {
    hits.push({
      id: 'servo',
      tag: '[舵机:看左边]',
      label: '转头',
      when: '转头/点头',
      patterns: [],
    });
  }
  if (/换脸|小机脸|电子脸|表情脸|换个表情/.test(raw)) {
    hits.push({
      id: 'face',
      tag: '[表情:happy]',
      label: '换脸',
      when: '换小机表情',
      patterns: [],
    });
  }
  return hits;
}

/**
 * 拼进聊天 system 的短工具条：只列命中项。
 * @returns {string}
 */
function buildSemanticToolPrompt(text, opts = {}) {
  const hits = matchToolsForPrompt(text);
  if (!hits.length) return '';
  const max = Math.max(1, Math.min(4, Number(opts.max) || 3));
  const lines = hits.slice(0, max).map((t) => t.label);
  return `【小机·可用】${lines.join('、')}（调用对应工具，不要写标记）`;
}

/** 近窗/本轮是否在聊小机相关（用于决定要不要给极短种子） */
function textMentionsRobot(text) {
  return /小机|桌宠|桌上|机器人|镜头|摄像头|喇叭|舵机|念·桌面|stack.?chan/i.test(String(text || ''));
}

module.exports = {
  ROBOT_TOOLBOOK,
  ROBOT_INVOKE_ALIASES,
  resolveRobotIntentFromText,
  stripDeskTags,
  listRobotToolsBrief,
  userAskedRobotToLook,
  resolveRobotIntentFromUserAsk,
  USER_ASK_TOOLS,
  matchToolsForPrompt,
  buildSemanticToolPrompt,
  textMentionsRobot,
};

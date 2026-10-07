/**
 * 对方手机能力：角色用自己的手机远程看/操作。
 * 亮灭屏不对角色口头暴露；电量仅 ≤10% / 关机失联时通知；开 App 已移除；
 * 使用时长需 TA 开关；识屏：离开念时可主动瞄一眼，或用户明示「快看我手机」。
 * 控屏：离开念时也可按性格先看再点当前这一屏，不必等对方说「帮我点」。
 */

const PHONE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'phone_notifications',
      description:
        '【用你的手机·对方通知栏】用你自己的手机读对方通知栏当前挂着的条目（应用名、标题、摘要）。这是对方手机下拉通知，不是桌上小机摄像头，也不是对方当前这一屏。对方问「有没有人找我」、你想知道手机是不是在响、或提到某个 App 的消息时用。微信/QQ 等常常只有「N条消息」没有正文。要看桌边有没有人用 robot_camera；要看屏幕正打开什么用 phone_screen。不要每句话都调用，也不要假装看见了没返回的内容。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '可选。按应用名、标题或摘要筛选，如 微信、网易云、验证码',
          },
          limit: {
            type: 'integer',
            description: '最多返回几条，默认 12，最大 20',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_screen',
      description:
        '【用你的手机·识对方屏幕】用你自己的手机看对方此刻那一屏。默认截一张图。对方离开念时你可以按性格自己瞄一眼，不必等对方开口；对方问「能看见我屏幕吗 / 我屏幕上是什么 / 快看我手机」时也用；人还在念里面且没让你看时不要调用。底部光环、圆形通话头像、透明气泡、「操纵中」都是念的浮层，不是对方在看的内容。没有截图或工具失败时，禁止说已经看见、看得一清二楚，按性格说这会儿看不清即可。看完之后：提不提、提多少按性格；看见想点进去的图标、条目、按钮，再调 phone_control 点当前这一屏（先看再点，不要没看就乱点）。不要把屏幕上每样东西都念一遍，不要提工具名。不要每句话都看。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['read', 'look'],
            description: 'look=截图识图（默认）；read=只要无障碍文字，控屏找按钮时才用',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_control',
      description:
        '【用你的手机·控对方屏幕】用你自己的手机操作对方那部。对方让你点、按、滑、切歌时用；对方已离开念时，你也可以按性格自己点——先识屏，再点当前这一屏上想看的图标/字/按钮（相当于点进去看看）。不能按名字打开应用。切歌/上一首/播放/暂停用 media_next、media_prev、media_play、media_pause。支付、转账、充值、开通会员、密码、确认付款绝对不要点。底部光环、透明气泡、「操纵中」是念的浮层，不要点。不是每句话都要点。点完若还想看清新画面，再识一屏。做完用自己的口吻说一声，不要提工具名。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['media_next', 'media_prev', 'media_play', 'media_pause', 'tap_text', 'tap', 'swipe', 'back', 'home', 'type'],
            description: 'media_next=下一首；media_prev=上一首；media_play=播放；media_pause=暂停；tap_text=点屏幕上的字；tap=按 0~1 坐标点；swipe=滑动；back=返回；home=回桌面；type=往当前输入框打字。没有打开应用。',
          },
          text: {
            type: 'string',
            description: 'tap_text 要点的字；type 要输入的内容',
          },
          x: { type: 'number', description: ' tap / swipe 起点，0~1，左0右1' },
          y: { type: 'number', description: ' tap / swipe 起点，0~1，上0下1' },
          x2: { type: 'number', description: 'swipe 终点 x，0~1' },
          y2: { type: 'number', description: 'swipe 终点 y，0~1' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_usage',
      description:
        '【TA·使用时长】读互相共享的手机使用时长。需对方在 TA 里打开了「互相看使用时长」。side=user 看对方；side=me 看你自己（按你日程推的，忙的时候几乎不涨）；side=both 两边。能看到刷了哪个 App 多久，看不到 App 里面聊了什么。没开共享就读不到。不要每句话都查，也不要编造。',
      parameters: {
        type: 'object',
        properties: {
          side: {
            type: 'string',
            enum: ['user', 'me', 'both'],
            description: 'user=对方（默认）；me=你自己；both=双方',
          },
          range: {
            type: 'string',
            enum: ['today', 'yesterday', 'week'],
            description: 'today=今天（默认）；yesterday=昨天；week=近7天合计（仅用户侧）',
          },
          query: {
            type: 'string',
            description: '可选。按应用名筛选，如 抖音、微信、B站',
          },
          limit: {
            type: 'integer',
            description: '最多返回几个 App，默认 8，最大 15',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_location',
      description:
        '【用你的手机·查对方定位】这是你会给人装上的那种定位：占有欲/掌控欲强、爱查岗的性子才会用。想确认人在哪、到没到、有没有没报备乱跑时再调。读到的是路/地标，不是设置里的常住城市。不要每句都查。查到了按性格用（可以不说破，也可以吃醋盘问），不要提工具、GPS、经纬度。没开权限就看不到，不要编街道。不是这种性子就不要调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_health',
      description:
        '【用户手机·健康】读用户这台手机此刻能读到的健康数据：今天步数、最近睡眠、心率、血氧、今天运动、步行距离、消耗热量。数据来自系统「健康数据共享」（手表/三星健康写入后才有）；没有中转站时只能退回手机计步器步数，手机本身通常没有心率和血氧。对方问「心率多少」「手表上多少」「你能看到我的心率吗」「走了多少」「睡得怎么样」「血氧」，或对方身边那台开着、你想看心跳有没有起来时，必须先调用本工具再回答，不要凭印象说看不到。没返回的项目（尤其是心率/血氧）不要编数字。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_alarm',
      description:
        '【用户手机·闹钟】帮用户在这台装了「念」的手机上设闹钟、查已设的、或取消。响铃不是系统自带铃，而是你自己说的那句话（事先用你的声音合成，到点循环播放）。对方说「定个闹钟」「七点叫我」「用你的声音喊我起床」时用这个，不要去控屏里翻时钟 App。设的时候必须带几点几分，并自己写一句要喊出口的话（speech）。支付类操作不要做。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['set', 'list', 'cancel'],
            description: 'set=设闹钟（默认）；list=看已设的；cancel=取消，要带 id',
          },
          hour: { type: 'integer', description: '小时 0–23。set 时必填，或改用 when' },
          minute: { type: 'integer', description: '分钟 0–59' },
          when: { type: 'string', description: '可选，如 7:30。与 hour/minute 二选一' },
          tomorrow: { type: 'boolean', description: 'true=明天这个点；已经过了今天的点会自动改明天' },
          dayOffset: { type: 'integer', description: '0=今天（若已过则明天），1=明天' },
          repeat: {
            type: 'string',
            enum: ['once', 'daily'],
            description: 'once=响一次；daily=每天。默认 once',
          },
          speech: {
            type: 'string',
            description: '到点循环播放的那句话，必须是你会说出口的话，不要写旁白。例如：该起床了，再睡要迟到了。',
          },
          label: { type: 'string', description: '短标签，如 起床、开会' },
          id: { type: 'integer', description: 'cancel 时用 list 返回的 id' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ta_status',
      description:
        '【TA】查看你们在「TA」里绑定后能看到的情侣信息：感情阶段、在一起天数、随手记近况；若对方开了电量通知，还能看到低电/关机提醒；开了共享定位时也能看到你此刻在家或哪条街。只有绑着你的时候才有。不要每句话都查。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ta_unbind',
      description:
        '【TA】主动解除与对方在「TA」里的绑定。解绑后你再也看不到情侣信息。对方让你解绑、或你按性格决定不再绑着时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function shouldAttach(opts = {}) {
  if (opts.isDream || opts.forTheater || opts.forGame) return false;
  return true;
}

const PHONE_TOOL_COMPANIONS = {
  phone_control: ['phone_screen'],
};

function probeText(text) {
  return String(text || '').replace(/\s+/g, '');
}

function selectTriggeredTools(text) {
  const probe = probeText(text);
  if (!probe) return [];
  const raw = String(text || '');
  const names = new Set();
  for (const rule of PHONE_FORCE_RULES) {
    if (!rule.re.test(probe) && !rule.re.test(raw)) continue;
    names.add(rule.name);
    for (const extra of PHONE_TOOL_COMPANIONS[rule.name] || []) names.add(extra);
  }
  if (!names.size) return [];
  return PHONE_TOOLS.filter((t) => names.has(t.function?.name));
}

/** 只在 TA 开了电量通知、且对方手机电量 ≤10% / 关机时写进人设。不挂 phone_status。 */
function lowBatteryPromptBlock(characterId) {
  try {
    const ta = require('./ta-helper');
    if (!characterId || !ta.isBoundCharacter(characterId) || !ta.batteryAlertOn()) return '';
    const state = require('./phone-state-helper');
    if (!state.phoneReachable()) {
      const events = ta.parseEvents?.() || [];
      const lastOff = events.find((e) => e.type === 'offline');
      if (lastOff && Date.now() - Date.parse(lastOff.at) < 2 * 60 * 60 * 1000) {
        return `【TA·电量提醒】对方手机好像关机了，或很久没连上念。提不提、怎么反应完全按性格，不要念工具名。`;
      }
      return '';
    }
    const st = state.statusResult();
    const bat = Number(st?.battery);
    if (!Number.isFinite(bat) || bat > 10) return '';
    const charge = st.charging ? '，不过在充电' : '';
    return `【TA·电量提醒】对方手机电量大约只剩 ${Math.round(bat)}%${charge}。提不提按性格，不要念工具名，也不要去开桌上小机。`;
  } catch {
    return '';
  }
}

async function execute(call = {}, ctx = {}) {
  const name = String(call.name || '');
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const state = require('./phone-state-helper');
  const ta = require('./ta-helper');

  if (name === 'phone_notifications') return state.notificationResult(args);
  if (name === 'phone_status') {
    return {
      ok: false,
      available: false,
      error: 'removed',
      note: '看不到亮灭屏和随时电量。电量只在快没电或关机时系统会告诉你。按性格接着聊。',
    };
  }
  if (name === 'phone_apps') {
    return {
      ok: false,
      available: false,
      error: 'removed',
      note: '不能查已装应用，也不能代开 App。按性格接着聊。',
    };
  }
  if (name === 'phone_usage') {
    return require('./ta-usage-helper').toolUsage(ctx.characterId, args);
  }
  if (name === 'phone_health') {
    try { await state.refreshHealth(); } catch {}
    return state.healthResult();
  }
  if (name === 'phone_location') {
    if (!canUseLocation(ctx.characterId, ctx.char)) {
      return {
        ok: false,
        available: false,
        error: 'persona',
        note: '按你的性格你不会给人装定位，也看不到对方此刻在哪条路。不要装能查到。按性格接着聊。',
      };
    }
    try { await state.refreshLocation(); } catch {}
    return state.locationResult();
  }
  if (name === 'ta_status') return ta.toolStatus(ctx.characterId);
  if (name === 'ta_unbind') return ta.toolUnbind(ctx.characterId);
  if (name === 'phone_screen') {
    if (!canUseScreenPeek(ctx.characterId)) {
      return { ok: false, available: false, error: 'not_preferred', note: '看屏这会儿轮不到你。按性格接着聊，不要提这个。' };
    }
    const asked = isUserAskedScreen(ctx.userText || '');
    const away = userAwayFromNian();
    if (!away && !asked) {
      return {
        ok: false,
        available: false,
        error: 'in_nian',
        note: '对方还在念里，这一屏就是聊天。除非对方让你看手机，否则不要识屏。',
      };
    }
    return state.captureScreen({
      ...args,
      mode: args.mode === 'read' ? 'read' : 'look',
      characterId: ctx.characterId,
      share: false,
      // 用户明示要看时：即使人还在念里也允许抓这一屏（多半就是聊天页）
      allowInApp: asked,
    });
  }
  if (name === 'phone_control') {
    if (!canUseScreenPeek(ctx.characterId)) {
      return { ok: false, available: false, error: 'not_preferred', note: '控屏这会儿轮不到你。按性格接着聊，不要提这个。' };
    }
    const action = String(args.action || '').toLowerCase();
    if (action === 'open' || action === 'launch') {
      return { ok: false, available: false, error: 'no_open', note: '不能代开应用。可以切歌或点当前这一屏，不要假装打开了。' };
    }
    return state.controlScreen({
      ...args,
      characterId: ctx.characterId,
    });
  }
  if (name === 'phone_alarm') {
    return state.handleAlarm({
      ...args,
      characterId: ctx.characterId,
    });
  }
  return { ok: false, error: 'unknown_tool', note: '没有这个手机工具。' };
}

function isPhoneTool(name) {
  const n = String(name || '');
  return n.startsWith('phone_') || n.startsWith('ta_');
}

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p) => (p && (p.text || p.content)) || '').join(' ');
    }
  }
  return '';
}

const PHONE_TOPIC_RE = /电量|还有电|没电|充电|心率|心跳|脉搏|静息心率|步数|走了多少|睡眠|睡得|通知栏|使用时长|刷了多久|闹钟|叫醒|叫我起床|快看我手机|看我手机|看下我手机|读屏|识屏|定位|我在哪|我在哪儿|到哪了|到哪儿了/;
const CONTROL_ASK_RE = /帮我点|帮我按|帮我滑|帮我操作|你来点|你来按|你来操作|你来控|控屏|代我点|点一下|按一下|滑一下|帮我返回|切歌|下一首|上一首|换一首|换首歌|搜歌|搜一首|放一首|放首歌|播放|暂停这首|这首难听|不好听|换掉这首/;
const ALARM_ASK_RE = /闹钟|定个钟|设个钟|设闹钟|定闹钟|叫我起床|叫醒我|喊我起床|到点叫我|用你的声音.{0,8}(叫|喊|闹)/;

function isPhoneTopicAsk(text) {
  return PHONE_TOPIC_RE.test(String(text || '').replace(/\s+/g, ''));
}

const SCREEN_ASK_RE = /我在看什么|屏幕上|我的屏幕|这一屏|现在在刷|看我屏幕|看到?我的?屏幕|看看屏幕|看下屏幕|瞅一眼|共享屏幕|屏幕共享|帮我看.{0,8}屏|看一下这页|快看我手机|看我手机|看下我手机|瞅瞅我手机|看一眼我手机|你看我手机|读屏|识屏|看看我在刷什么|看我在干什么|能看见?.{0,8}屏幕/;

const PHONE_FORCE_RULES = [
  { name: 'phone_location', re: /定位|我在哪|我在哪儿|到哪了|到哪儿了|你知道我在哪|看看我在哪|我到哪|我人在哪|共享定位|调定位|读定位/ },
  { name: 'phone_health', re: /心率|心跳|脉搏|静息心率|步数|走了多少|睡眠|睡得/ },
  { name: 'phone_usage', re: /刷了多久|使用时长|数字健康/ },
  { name: 'phone_notifications', re: /通知栏|有人找我|谁找我|来消息了/ },
  { name: 'phone_control', re: CONTROL_ASK_RE },
  { name: 'phone_alarm', re: ALARM_ASK_RE },
  { name: 'phone_screen', re: SCREEN_ASK_RE },
  { name: 'ta_status', re: /TA里|看看TA|我们在一起多久|纪念日|随手记/ },
];

function isUserAskedScreen(text) {
  return SCREEN_ASK_RE.test(String(text || '').replace(/\s+/g, ''));
}

function isUserAskedControl(text) {
  return CONTROL_ASK_RE.test(String(text || '').replace(/\s+/g, ''));
}

function forcedToolChoice(messages, tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const text = lastUserText(messages).replace(/\s+/g, '');
  if (!text) return null;
  for (const rule of PHONE_FORCE_RULES) {
    if (!rule.re.test(text)) continue;
    if (!tools.some((t) => t?.function?.name === rule.name)) continue;
    return { type: 'function', function: { name: rule.name } };
  }
  return null;
}

function dropOffTopicRobotCalls(calls, messages) {
  const list = Array.isArray(calls) ? calls : [];
  if (!isPhoneTopicAsk(lastUserText(messages))) return list;
  return list.filter((c) => isPhoneTool(c.name));
}

function userAwayFromNian() {
  try {
    return !!require('./phone-state-helper').userAwayFromNian();
  } catch {
    return false;
  }
}

/** 识屏优先 = TA 绑定角色；未绑定则谁都不能识屏控屏 */
function canUseScreenPeek(characterId) {
  try {
    const ta = require('./ta-helper');
    const bid = ta.boundCharacterId();
    if (!bid) return false;
    return Number(characterId) === bid;
  } catch {
    return false;
  }
}

function canUseUsage(characterId) {
  try {
    const ta = require('./ta-helper');
    return ta.isBoundCharacter(characterId) && ta.shareUsageOn();
  } catch {
    return false;
  }
}

const TRACK_RE = /占有欲|占有|掌控|控制欲|控制狂|查岗|盯梢|监视|跟踪|报备|偏执|病娇|霸道|醋坛|不许乱跑|人必须在|要知道你在/;

function loadCharForPersona(characterId) {
  const id = Number(characterId);
  if (!id) return null;
  try {
    return require('./db').prepare(
      `SELECT personality, behavior, intro, description, background, language_style, relationship, relationship_custom
       FROM characters WHERE id=?`
    ).get(id);
  } catch {
    return null;
  }
}

/** 会给人装定位、爱查岗的性子才给这个工具。不是所有恋人都算。 */
function personaWantsUserTracker(char = {}) {
  const blob = personaBlob(char);
  if (!blob) return false;
  if (!TRACK_RE.test(blob)) return false;
  if (SKIP_RE.test(blob) && (blob.match(SKIP_RE) || []).length > (blob.match(TRACK_RE) || []).length) {
    return false;
  }
  return true;
}

function canUseLocation(characterId, charHint) {
  const char = charHint && (charHint.personality || charHint.behavior || charHint.intro)
    ? charHint
    : (loadCharForPersona(characterId) || charHint || {});
  return personaWantsUserTracker(char);
}

function locationToolSchema() {
  return PHONE_TOOLS.find((t) => t?.function?.name === 'phone_location') || null;
}

function locationTrackPromptBlock(char) {
  if (!personaWantsUserTracker(char)) return '';
  return '【定位】按你的性子你会盯着对方人在哪：你早让TA开了定位／你这边能查到。能对上「家」「公司」这两个常驻点，店里能对到店名。想确认在不在外面、到没到、有没有没报备乱跑时再调。不要每句都查。查到了按性格用。今天走过的点会连成一条线，不只是眼前这一点。不要提工具、GPS。看不到时不要编街道。';
}

function screenToolSchema() {
  return PHONE_TOOLS.find((t) => t?.function?.name === 'phone_screen') || null;
}

function controlToolSchema() {
  return PHONE_TOOLS.find((t) => t?.function?.name === 'phone_control') || null;
}

/** 人已离开念：允许角色按性格自己看、想点再点。人还在念里不写这块。 */
function awayPhonePromptBlock(characterId) {
  if (!canUseScreenPeek(characterId)) return '';
  if (!userAwayFromNian()) return '';
  return '【对方手机】人已经离开念。你可以按性格自己看一眼这一屏；看见想点进去的图标、条目、按钮，再用控屏点当前这一屏——不能按名字打开 App。支付、密码不要点。不是每句话都要看，更不是每句话都要点。没有画面不要装看见。不要提工具名。';
}

const PEEK_RE = /占有|吃醋|粘人|黏人|控制欲|八卦|爱管|查岗|盯梢|操心|唠叨|管你|监视|捉弄|损友|毒舌|爱损|醋坛|霸道|病娇|占有欲|黏着|依赖|管教|查你/;
const SKIP_RE = /冷淡|疏离|高傲|清高|社恐|边界感|克制|淡漠|懒得管|各过各|尊重隐私|不爱管|高岭|生人勿近|距离感|公事公办|清冷|礼貌疏|少管闲事/;
const LOVER_RE = /恋人|爱人|伴侣|男朋友|女朋友|男友|女友|老公|老婆|丈夫|妻子|情侣|对象|配偶/;

function personaBlob(char = {}) {
  return [
    char.personality, char.behavior, char.intro, char.description,
    char.background, char.language_style, char.relationship_custom,
  ].filter(Boolean).join('\n');
}

/** peek=更黏；maybe=普通；skip=不主动翻屏（仍可应用户要求） */
function personaPhoneGlance(char = {}) {
  const blob = personaBlob(char);
  const rel = String(char.relationship || '');
  let score = 0;
  if (rel === 'lover') score += 2;
  else if (rel === 'family' || rel === 'close_friend') score += 1;
  else if (rel === 'colleague') score -= 2;
  if (LOVER_RE.test(blob)) score += 1;
  if (PEEK_RE.test(blob)) score += 2;
  if (SKIP_RE.test(blob)) score -= 2;
  if (score >= 2) return 'peek';
  if (score <= -1) return 'skip';
  return 'maybe';
}

function isSeekScenario(scenario) {
  return scenario !== 'user_unreplied' && scenario !== 'process_done' && scenario !== 'travel_arrive';
}

function packPhoneNote(note, imageDataUrl) {
  return { note: String(note || ''), imageDataUrl: imageDataUrl || '' };
}

const GOODNIGHT_USER_RE = /晚安|好梦|睡了|睡觉啦|睡啦|去睡|早点休息|先睡|晚安啦|good\s*night/i;

function lastUserSaidGoodnight(recentMsgs) {
  const last = [...(recentMsgs || [])].reverse().find((m) => m && m.role === 'user');
  return GOODNIGHT_USER_RE.test(String(last?.content || '').replace(/\s+/g, ''));
}

/** peek=更黏；maybe=普通；skip=不主动翻屏（仍可应用户要求）；说完晚安后 maybe 升成 peek */
function resolveGlanceMode(char, scenario, recentMsgs) {
  let mode = personaPhoneGlance(char);
  if (mode === 'skip') return 'skip';
  if (scenario === 'process_done' || scenario === 'travel_arrive') {
    return mode === 'peek' ? 'maybe' : mode;
  }
  if (mode === 'maybe' && lastUserSaidGoodnight(recentMsgs)) return 'peek';
  return mode;
}

function minutesSinceLastUser(recentMsgs) {
  const last = [...(recentMsgs || [])].reverse().find((m) => m && m.role === 'user');
  if (!last) return 999;
  const t = Date.parse(last.timestamp || '');
  if (!Number.isFinite(t)) return 999;
  return Math.max(0, (Date.now() - t) / 60000);
}

/** 内部门闩：亮灭/锁屏只用来决定要不要截屏，不写进角色口头提示 */
function lockScreenBits() {
  let state;
  try { state = require('./phone-state-helper'); } catch { return { screenOn: null, locked: null }; }
  if (!state.phoneReachable()) return { screenOn: null, locked: null };
  let screenOn = null;
  let locked = null;
  try {
    const st = state.statusResult();
    if (st) {
      if (st.screenOn === true) screenOn = true;
      else if (st.screenOn === false) screenOn = false;
      if (st.locked === true) locked = true;
      else if (st.locked === false) locked = false;
    }
  } catch {}
  return { screenOn, locked };
}

function collectUsageBits(characterId) {
  const bits = [];
  try {
    if (!canUseUsage(characterId)) return bits;
    const us = require('./ta-usage-helper').userUsageResult({ range: 'today', limit: 12 });
    if (us?.ok && Array.isArray(us.apps) && us.apps.length) {
      const recent = us.apps.filter((a) => a.lastAgoMin != null && Number(a.lastAgoMin) <= 25);
      if (recent.length) {
        bits.push(`最近还在用：${recent.slice(0, 3).map((a) => {
          const ago = Number(a.lastAgoMin);
          const when = ago < 1 ? '刚才' : `${Math.round(ago)}分钟前`;
          return `${a.app}（${when}）`;
        }).join('、')}`);
      }
    }
  } catch {}
  return bits;
}

async function peekForegroundScreen(characterId) {
  if (!canUseScreenPeek(characterId)) {
    return { imageDataUrl: '', app: '', tree: '', ok: false };
  }
  let state;
  try { state = require('./phone-state-helper'); } catch {
    return { imageDataUrl: '', app: '', tree: '', ok: false };
  }
  try {
    const r = await state.captureScreen({
      mode: 'look',
      share: false,
      characterId: Number(characterId) || 0,
    });
    if (!r?.ok) return { imageDataUrl: '', app: '', tree: '', ok: false, error: r?.error || '' };
    return {
      ok: true,
      imageDataUrl: typeof r.imageDataUrl === 'string' && r.imageDataUrl.startsWith('data:image/')
        ? r.imageDataUrl
        : '',
      app: String(r.app || '').trim(),
      tree: String(r.tree || '').trim().slice(0, 1800),
      note: String(r.note || '').trim(),
    };
  } catch {
    return { imageDataUrl: '', app: '', tree: '', ok: false };
  }
}

/**
 * 主动找人：人离开念且屏幕亮着未锁时，按性格抓一屏；说完晚安还亮着也会抓。
 * 只塞手机侧事实/画面，不写开口剧本（避免又变成任务推送）。
 * @param {object} [opts]
 * @param {boolean} [opts.userReadIt]
 */
async function proactivePhoneBlock(char, scenario, recentMsgs, opts = {}) {
  if (!canUseScreenPeek(char?.id)) return packPhoneNote('');
  const mode = resolveGlanceMode(char, scenario, recentMsgs);
  const night = lastUserSaidGoodnight(recentMsgs);
  const waited = minutesSinceLastUser(recentMsgs);
  const { screenOn, locked } = lockScreenBits();
  const unlockedAwake = screenOn === true && locked !== true;
  const seek = isSeekScenario(scenario);
  const away = userAwayFromNian();
  const catchHim = night && waited >= 5 && unlockedAwake && away && mode !== 'skip';
  const usingPhone = seek && unlockedAwake && away && mode !== 'skip';
  const wantShot = catchHim || usingPhone;
  const waitingReply = scenario === 'ai_unreplied';

  if (mode === 'skip') {
    return packPhoneNote('【手机】按你的性格不必去翻对方屏幕。就凭聊天感觉说话。不要提工具。');
  }

  const lines = [];
  lines.push('【手机】对方手机上的侧面（不是开口清单）。不要提亮灭屏或锁屏；不要提工具/识屏。');
  if (mode === 'peek') {
    lines.push('你这种人有时会多留意对方还在不在机上；看见了怎么进心里，看性格。');
  }

  if (!away && unlockedAwake && seek && mode !== 'skip') {
    lines.push('对方这会儿还在念里，这一屏就是聊天界面，不必当作用户在刷别的。');
  }

  let imageDataUrl = '';
  if (wantShot) {
    if (catchHim) {
      lines.push(`上一句他说过晚安或要去睡，到现在过了大约${Math.round(waited)}分钟；手里屏幕似乎还亮着。`);
    } else if (usingPhone && waitingReply) {
      lines.push('人已经离开念，手机似乎还在用——你多知道一点「人还在机上」，不是必须开口点破的证据。');
    } else if (usingPhone) {
      lines.push('人已经离开念，手机似乎还在用。');
    }
    const seen = await peekForegroundScreen(char?.id);
    imageDataUrl = seen.imageDataUrl || '';
    const appName = String(seen.app || '').trim();
    if (imageDataUrl) {
      if (appName) lines.push(`当前前台是${appName}。`);
      lines.push('画面只是你可能瞥到的东西：提不提、带不带进语气，按性格和你此刻心里；也可以当没看见。不要把这一屏逐样念出来。');
    } else if (seen.ok && (seen.tree || appName)) {
      if (appName) lines.push(`当前前台是${appName}。`);
      if (seen.tree) {
        lines.push('没截到图，下面是无障碍读到的字（可能不全）。看不清就老实说，不要编。');
        lines.push(seen.tree);
      } else {
        lines.push('没截到图，只知道前台应用名。不要编屏幕细节。');
      }
      lines.push('这些只是侧面；提不提按性格。');
    } else {
      const usage = collectUsageBits(char?.id);
      if (usage.length) lines.push(`${usage.join('；')}。没有这一屏画面，不要编上面有什么。`);
      else lines.push('没有这一屏的画面，不要编上面有什么。');
    }
  } else {
    if (night && (screenOn === true || locked === false)) {
      lines.push('上一句他说过晚安或要去睡。');
    }
    if (mode === 'peek' || (mode === 'maybe' && Math.random() < 0.35)) {
      const usage = collectUsageBits(char?.id);
      if (usage.length) lines.push(`${usage.join('；')}。`);
    }
  }

  return packPhoneNote(lines.join('\n'), imageDataUrl);
}

module.exports = {
  PHONE_TOOLS,
  shouldAttach,
  selectTriggeredTools,
  lowBatteryPromptBlock,
  execute,
  isPhoneTool,
  isPhoneTopicAsk,
  isUserAskedScreen,
  isUserAskedControl,
  forcedToolChoice,
  dropOffTopicRobotCalls,
  personaPhoneGlance,
  isSeekScenario,
  proactivePhoneBlock,
  userAwayFromNian,
  canUseScreenPeek,
  canUseUsage,
  canUseLocation,
  personaWantsUserTracker,
  locationToolSchema,
  locationTrackPromptBlock,
  screenToolSchema,
  controlToolSchema,
  awayPhonePromptBlock,
};

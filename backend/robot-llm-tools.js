/**
 * 小机能力：标准 Chat Completions tools（Function Calling）。
 * 小机开机在线才把 schema 挂进当轮；没开机不挂。
 * 角色认知：用自己的手机远程操作对方桌上那台。不在人设里教 [桌宠:…] 格式。
 * 为了少改执行链，tool_calls 会转成内部仍认识的旧标记，再交给现有队列。
 */

const ROBOT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'music_control',
      description:
        '【音乐控制】控制系统音乐播放器：切歌或播放/暂停。仅在一起听歌时可用。只有当前歌真的顶到你不适、或用户同意换歌时再用 next。不要因为「不好听」当评委切歌。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['next', 'previous', 'play_pause'],
            description: 'next=下一首；previous=上一首；play_pause=播放/暂停',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'robot_camera',
      description:
        '【用你的手机·对方桌上小机】用你自己的手机远程看对方桌边：面前有没有人、脸和环境。动的是对方桌上那台，不是你手机屏幕，也不是通知栏，更不是对方手机电量/心率。拍面前（不转头）用 peek；人可能不在镜头里、要转头扫一圈找脸用 find；看一眼并记下用 snapshot；只看不从喇叭说话用 watch_quietly。对方问的是手机电量、心率、通知、屏幕上在看什么时，不要调用本工具。想知道对方手机上在刷哪个 App、屏幕上有什么字，改用 phone_screen。画面稍后才会回来，不必等结果再说话。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['peek', 'find', 'snapshot', 'watch_quietly'],
            description: 'peek=拍面前；find=转头找人；snapshot=看一眼并记住；watch_quietly=只看不言',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'robot_follow',
      description:
        '【用你的手机·对方桌上小机】用你自己的手机让对方桌上那台用人脸持续跟着转头，或停下来。管的是那台的脖子，不是你手机、也不是对方手机。默认不会一直跟。只有你明确想盯着坐在桌边的人、或对方让你跟着时才打开。',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'true=开始跟着，false=停止跟着' },
        },
        required: ['enabled'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'robot_speaker',
      description:
        '【用你的手机·对方桌上小机】用你自己的手机让这句话从对方桌上那台喇叭说出来，或带着逗/靠近做桌边互动。不是你手机扬声器，也不是聊天气泡。普通聊天里想让桌上那台出声时调用 talk。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['talk', 'tease', 'comfort'],
            description: 'talk=喇叭说这轮的话；tease=逗一下；comfort=想念靠近说一句',
          },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'robot_head',
      description:
        '【用你的手机·对方桌上小机】用你自己的手机控制对方桌上那台的头/脖子：点头、摇头、歪头，或转到某个方向。只能做头和脖子做得到的动作，不要用来表示抱、亲、蹭。左右转头 yaw 左负右正；pitch 约 28 为正视。可以只给 gesture，不必填数字。',
      parameters: {
        type: 'object',
        properties: {
          gesture: {
            type: 'string',
            enum: ['nod', 'shake', 'tilt', 'look_user', 'look_left', 'look_right', 'look_up', 'look_down'],
            description: '点头/摇头/歪头/看向用户/左/右/上/下',
          },
          yaw: { type: 'number', description: '水平角，左负右正，可选' },
          pitch: { type: 'number', description: '俯仰角，约 28 为正视，可选' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'robot_light',
      description: '【用你的手机·对方桌上小机】用你自己的手机控制对方桌上那台的灯光颜色、亮度或关掉。不是你手机闪光灯。不要动不动闪瞎眼的满亮。',
      parameters: {
        type: 'object',
        properties: {
          off: { type: 'boolean', description: 'true=关灯' },
          color: { type: 'string', description: '颜色名或 hex，如 粉、金、蓝、#ff88aa' },
          brightness: { type: 'number', description: '0 到 1，建议 0.4～0.8' },
          hz: { type: 'number', description: '闪烁频率，0 或不填为常亮' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'robot_face',
      description: '【用你的手机·对方桌上小机】用你自己的手机换对方桌上那台电子屏上的表情脸。这是桌上那张脸，不是聊天表情包，也不是对方手机壁纸。',
      parameters: {
        type: 'object',
        properties: {
          emotion: {
            type: 'string',
            enum: ['happy', 'sad', 'angry', 'shy', 'surprised', 'neutral', 'sleepy', 'love'],
            description: '小机脸上的表情',
          },
        },
        required: ['emotion'],
      },
    },
  },
];

const CAMERA_ZH = {
  peek: '看一眼',
  find: '找人',
  snapshot: '记住这一幕',
  watch_quietly: '只看不言',
};
const SPEAKER_ZH = { talk: '说句话', tease: '逗你', comfort: '想你了' };
const GESTURE_ZH = {
  nod: '点头',
  shake: '摇头',
  tilt: '歪头',
  look_user: '看向用户',
  look_left: '看左边',
  look_right: '看右边',
  look_up: '抬头',
  look_down: '低头',
};

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(String(raw));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function parseToolCalls(message) {
  const out = [];
  if (!message || typeof message !== 'object') return out;
  const list = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const item of list) {
    const fn = item?.function || item;
    const name = String(fn?.name || item?.name || '').trim();
    if (!name) continue;
    out.push({
      id: String(item.id || `call_${out.length}`),
      name,
      args: parseArgs(fn?.arguments || item?.arguments || item?.input),
    });
  }
  if (!out.length && message.function_call?.name) {
    out.push({
      id: 'call_legacy',
      name: String(message.function_call.name),
      args: parseArgs(message.function_call.arguments),
    });
  }
  return out;
}

function encodeToolCallsAsLegacyTags(calls) {
  const bits = [];
  for (const c of calls || []) {
    const a = c.args || {};
    if (c.name === 'music_control') {
      // music_control 不编码为标记，需要实际执行
      continue;
    } else if (c.name === 'robot_camera') {
      bits.push(`[桌宠:${CAMERA_ZH[a.action] || '看一眼'}]`);
    } else if (c.name === 'robot_follow') {
      bits.push(a.enabled === false || a.enabled === 'false' ? '[桌宠:别跟着]' : '[桌宠:跟着]');
    } else if (c.name === 'robot_speaker') {
      bits.push(`[桌宠:${SPEAKER_ZH[a.mode] || '说句话'}]`);
    } else if (c.name === 'robot_head') {
      const hasAngle = a.yaw != null && a.yaw !== '' || a.pitch != null && a.pitch !== '';
      if (hasAngle) {
        const yaw = Number(a.yaw);
        const pitch = Number(a.pitch);
        bits.push(`[舵机:${Number.isFinite(yaw) ? yaw : 0},${Number.isFinite(pitch) ? pitch : 28}]`);
      } else if (a.gesture) {
        const zh = GESTURE_ZH[a.gesture] || String(a.gesture);
        bits.push(`[舵机:${zh}]`);
        bits.push(`[动作:${zh}]`);
      }
    } else if (c.name === 'robot_light') {
      if (a.off === true || a.off === 'true') bits.push('[灯光:关]');
      else {
        const col = String(a.color || '粉').trim() || '粉';
        let spec = col;
        if (a.brightness != null && a.brightness !== '') spec += ` 亮度=${a.brightness}`;
        if (a.hz != null && Number(a.hz) > 0) spec += ` ${a.hz}`;
        bits.push(`[灯光:${spec}]`);
      }
    } else if (c.name === 'robot_face' && a.emotion) {
      bits.push(`[表情:${a.emotion}]`);
    }
  }
  return bits.join('');
}

function mergeContentWithToolTags(content, calls) {
  const text = String(content || '').trim();
  const tags = encodeToolCallsAsLegacyTags(calls);
  if (!tags) return text;
  if (!text) return tags;
  if (text.includes('[桌宠:') || text.includes('[舵机:') || text.includes('[灯光:') || text.includes('[动作:')) {
    return `${text}${tags}`;
  }
  return `${text}\n${tags}`;
}

function shouldAttachRobotTools(char, settings, opts = {}) {
  if (opts.isDream || opts.forTheater || opts.forGame) return false;
  
  // 特殊情况：音乐同步时，即使小机离线也要提供 music_control 工具
  if (opts.isMusicSync) {
    return true;
  }
  
  if (String(settings?.robot_enabled || '0') !== '1') return false;
  try {
    const drive = require('./robot-drive-helper');
    if (!drive.canCharacterUseRobot(char, settings)) return false;
    // 小机没开机/不在线时不要把镜头工具塞给模型，否则「能看到吗」会去开一台不存在的机器。
    if (!drive.robotDeviceOnline(settings)) return false;
    return true;
  } catch {
    return false;
  }
}

function flattenTriggerText(opts = {}) {
  const bits = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) bits.push(v.trim());
    else if (Array.isArray(v)) {
      const s = v.map((p) => (p && (p.text || p.content)) || '').join(' ').trim();
      if (s) bits.push(s);
    }
  };
  push(opts.userMessage);
  push(opts.userText);
  if (!bits.length && Array.isArray(opts.recentHistory)) {
    for (let i = opts.recentHistory.length - 1; i >= 0; i--) {
      const m = opts.recentHistory[i];
      if (m?.role === 'user') {
        push(m.content);
        break;
      }
    }
  }
  return bits.join('\n');
}

function mergeToolSchemas(list) {
  const seen = new Set();
  const out = [];
  for (const t of list || []) {
    const n = t?.function?.name;
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
  }
  return out;
}

async function toolsForChat(char, settings, opts = {}) {
  try { require('./robot-operating-helper').clearOperatingIfDeviceOffline(); } catch {}
  const out = [];
  const text = flattenTriggerText(opts);
  
  // 开机在线：整份小机工具挂上，角色想调就 tool_calls。没开机：不挂。
  // 特殊情况：音乐同步时，只挂 music_control 工具
  if (shouldAttachRobotTools(char, settings, opts)) {
    if (opts.isMusicSync) {
      // 音乐同步场景：只提供 music_control 工具
      const musicControlTool = ROBOT_TOOLS.find(t => t.function.name === 'music_control');
      if (musicControlTool) out.push(musicControlTool);
    } else {
      // 正常场景：提供所有小机工具
      out.push(...ROBOT_TOOLS);
    }
  }
  
  try {
    const phone = require('./phone-llm-tools');
    if (phone.shouldAttach(opts)) {
      const canPeek = phone.canUseScreenPeek(char?.id);
      const canUsage = phone.canUseUsage?.(char?.id);
      const canLoc = phone.canUseLocation?.(char?.id, char);
      const askedScreen = phone.isUserAskedScreen(text);
      const filterPhone = (t) => {
        const n = t?.function?.name;
        if (n === 'phone_apps' || n === 'phone_status') return false;
        if (n === 'phone_location') return !!canLoc;
        if (n === 'phone_usage' || n === 'ta_status' || n === 'ta_unbind') {
          if (n === 'phone_usage') return !!canUsage;
          return !!canPeek;
        }
        if (n === 'phone_screen' || n === 'phone_control') {
          if (!canPeek) return false;
          if (n === 'phone_screen') return phone.userAwayFromNian() || askedScreen;
          return phone.userAwayFromNian() || phone.isUserAskedControl(text);
        }
        return true;
      };
      if (opts.forcePhoneTools) {
        out.push(...phone.PHONE_TOOLS.filter(filterPhone));
      } else {
        const triggered = phone.selectTriggeredTools(text).filter(filterPhone);
        out.push(...triggered);
        if (canLoc) {
          const locTool = phone.locationToolSchema?.() || phone.PHONE_TOOLS.find((t) => t?.function?.name === 'phone_location');
          if (locTool && !out.some((t) => t?.function?.name === 'phone_location')) out.push(locTool);
        }
        if (canPeek && (phone.userAwayFromNian() || askedScreen)) {
          const screen = phone.screenToolSchema();
          if (screen) out.push(screen);
        }
        if (canPeek && phone.userAwayFromNian()) {
          const control = phone.controlToolSchema();
          if (control) out.push(control);
        }
      }
    }
  } catch {}
  try {
    const mcp = require('./mcp-client-helper');
    const mcpSchemas = await mcp.schemasForChat(() => settings, opts);
    if (mcpSchemas?.length) out.push(...mcpSchemas);
  } catch (e) {
    console.warn('[chat-tools] mcp', e.message);
  }
  try {
    const toy = require('./toy-helper');
    const toySchemas = toy.toolsForChat(settings, opts);
    if (toySchemas?.length) {
      out.push(...toySchemas);
      try {
        const phone = require('./phone-llm-tools');
        const health = phone.PHONE_TOOLS.find((t) => t?.function?.name === 'phone_health');
        if (health) out.push(health);
      } catch {}
    }
  } catch (e) {
    console.warn('[chat-tools] toy', e.message);
  }
  // 注：通话结束通过正文里的 [挂断]/[end_call] tag 触发（见 emoji-helper.extractEndCallDirective），
  // 这里是文本 tag 解析流程，本项目的 tool_calls 当前不被执行，所以不挂 schema。
  const merged = mergeToolSchemas(out);
  if (merged.length) {
    console.log('[chat-tools] attach', merged.map((t) => t.function?.name).join(','));
  }
  return merged.length ? merged : null;
}

async function chatExtra(char, settings, opts = {}) {
  const tools = await toolsForChat(char, settings, opts);
  return tools ? { tools, characterId: Number(char?.id) || 0 } : {};
}

function toolFollowUpPayload(calls) {
  const actions = (calls || []).map((c) => c.name);
  const hasMusicControl = actions.includes('music_control');
  
  return JSON.stringify({
    ok: true,
    queued: true,
    note: hasMusicControl 
      ? '已帮你切歌。请用你自己的口吻继续说话，不要提工具名或函数名。'
      : '已交给小机执行。请用你自己的口吻继续说话，不要提工具名或函数名。',
    actions,
  });
}

module.exports = {
  ROBOT_TOOLS,
  parseToolCalls,
  encodeToolCallsAsLegacyTags,
  mergeContentWithToolTags,
  shouldAttachRobotTools,
  toolsForChat,
  chatExtra,
  toolFollowUpPayload,
};

/**
 * 啵啵贝 Pro：角色用自己的手机，经对方手机蓝牙去调档位。
 * 当前档位每轮写入提示词；硬件几乎不回报体感，轻重刻度来自设置。
 */

const TOY_WAIT_MS = 8000;
const STALE_MS = 25000;

const MAX_STEP_SEC = 120;
const MAX_STEPS = 8;
const MAX_RAMP_SEC = 30;
/** 角色换档默认缓滑秒数；写 ramp:0 才跳变 */
const DEFAULT_RAMP_SEC = 2;

const TOY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'toy_touch',
      description:
        '【用你的手机·对方身边】用你自己的手机调对方身边那台。吮吸(suction)和震动(vibration)是两条独立通道：可以只开一个、也可以两个档位不一样（例如吸 20、震 55）。微电(electric)也是单独的。都是 0～100 连续旋钮。换档默认缓滑；要跳变写 ramp:0。feel=gentle/medium/strong/stop 会把吸和震拧成同一档，只是粗略快捷——精细控制请分别填数字。可用 steps 排时间线。听对方反应，怎么拧按【性格】。没气氛、对方也没让碰时不要调用。不要在回复里写工具名。',
      parameters: {
        type: 'object',
        properties: {
          feel: {
            type: 'string',
            enum: ['gentle', 'medium', 'strong', 'stop'],
            description: '粗略快捷：会同时把吸和震设成同一轻重。若吸、震要不同，或只动其中一个，不要用 feel，直接分别填 suction / vibration。',
          },
          suction: { type: 'integer', description: '吮吸 0～100。可单独调；不填则保持当前吮吸。' },
          vibration: { type: 'integer', description: '震动 0～100。可单独调，可与吮吸不同；不填则保持当前震动。' },
          electric: { type: 'integer', description: '微电 0～100。不填则保持。要过电必须单独填，feel 不会带动微电。' },
          ramp: {
            type: 'number',
            description: '秒。从当前档滑到目标档的时间，像拧滑块。默认约 2 秒；0=立刻跳变；慢慢升/降可写 3～8。单次最长 30 秒。',
          },
          duration: { type: 'number', description: '秒。到达目标并稳住后：>0 则再过这么久自动全停；0 或不填一直维持。有 steps 时忽略顶层 duration。' },
          steps: {
            type: 'array',
            description:
              '时间线。每段可写 0～100 通道或 feel，以及 ramp（滑过去多久）、duration（到档后稳住多久再下一段）。最多 8 段。',
            items: {
              type: 'object',
              properties: {
                feel: {
                  type: 'string',
                  enum: ['gentle', 'medium', 'strong', 'stop'],
                  description: '粗略快捷。精细请用数字。',
                },
                suction: { type: 'integer', description: '本段吮吸 0～100' },
                vibration: { type: 'integer', description: '本段震动 0～100' },
                electric: { type: 'integer', description: '本段微电 0～100（需对方开微电）' },
                ramp: { type: 'number', description: '滑到本段目标的秒数。默认约 2；0=跳变。' },
                duration: { type: 'number', description: '到档后稳住的秒数。非末段：再切下一段；末段：再全停。' },
              },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toy_stop',
      description:
        '【用你的手机·对方身边】停下对方身边那台所有通道，并取消未走完的时间线/缓滑。想收手、或按性格决定停的时候用。不是系统强制：对方喊停你听不听，按【性格】。不要在回复里写工具名。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

let _last = {
  at: 0,
  connected: false,
  ready: false,
  name: '',
  address: '',
  suction: 0,
  vibration: 0,
  electric: 0,
  battery: -1,
  phase: '',
  error: '',
};

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(x)));
}

function on(v) {
  return v === true || v === 1 || v === '1';
}

function getSettingsFn() {
  try {
    return require('./db').prepare('SELECT key, value FROM settings').all()
      .reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
  } catch {
    return {};
  }
}

function config(settings) {
  const s = settings || getSettingsFn();
  return {
    enabled: on(s.toy_enabled),
    electric: on(s.toy_electric),
    hrFollow: on(s.toy_hr_follow),
    gentle: clamp(s.toy_feel_gentle, 1, 100) || 20,
    medium: clamp(s.toy_feel_medium, 1, 100) || 45,
    strong: clamp(s.toy_feel_strong, 1, 100) || 70,
  };
}

const LIVE_HR_MS = 3 * 60 * 1000;
const HR_FAST = 120;
const HR_TOO_FAST = 145;
let _hrBase = { bpm: null, at: 0 };

function heartAgeLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 20000) return '刚才';
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}秒前`;
  return `${Math.max(1, Math.round(ms / 60000))}分钟前`;
}

function readHeart() {
  try {
    const h = require('./phone-state-helper').healthResult() || {};
    const bpm = Number(h.heartRateBpm);
    if (!h.ok || !Number.isFinite(bpm) || bpm < 20 || bpm > 250) {
      return { available: false, live: false, bpm: null, note: '' };
    }
    const source = String(h.heartRateSource || '');
    const atMs = Number(h.heartRateAtMs);
    const timed = Number.isFinite(atMs) && atMs > 0;
    const ageMs = timed ? Date.now() - atMs : null;
    const live = source === 'latest' && timed && ageMs != null && ageMs >= 0 && ageMs <= LIVE_HR_MS;
    return {
      available: true,
      live,
      bpm: Math.round(bpm),
      min: Number.isFinite(Number(h.heartRateMin)) ? Math.round(Number(h.heartRateMin)) : null,
      max: Number.isFinite(Number(h.heartRateMax)) ? Math.round(Number(h.heartRateMax)) : null,
      source,
      ageMs,
      timed,
    };
  } catch {
    return { available: false, live: false, bpm: null, note: '' };
  }
}

function noteHeartBaseline(heart, st) {
  if (!st || (!st.connected && !st.ready)) {
    _hrBase = { bpm: null, at: 0 };
    return;
  }
  if (heart.live && !_hrBase.bpm) {
    _hrBase = { bpm: heart.bpm, at: Date.now() };
  }
}

function heartPromptLine(heart, cfg) {
  if (!heart.available) {
    return '这会儿读不到心率（多半没戴表，或还没把心率授权给念）。不要编数字，也不要靠猜心跳来加码。';
  }
  const age = heartAgeLabel(heart.ageMs);
  if (heart.source === 'resting') {
    return `只有静息心率大约 ${heart.bpm}，不是这会儿的跳动。不要当成正在加快。`;
  }
  if (heart.source === 'avg') {
    return `只有一段平均心率大约 ${heart.bpm}，不是这几秒的反应。不要当成正在加快。`;
  }
  if (!heart.live) {
    const when = age ? `（${age}）` : '';
    return `上次心率大约 ${heart.bpm}${when}，别当成这几秒的反应。没有新读数就不要编。`;
  }
  const bits = [`心率这会儿大约 ${heart.bpm}${age ? `（${age}）` : ''}`];
  if (_hrBase.bpm && heart.bpm >= _hrBase.bpm + 8) bits.push(`刚连上时大约 ${_hrBase.bpm}，比刚开始快了`);
  else if (_hrBase.bpm && heart.bpm <= _hrBase.bpm - 8) bits.push(`刚连上时大约 ${_hrBase.bpm}，比刚开始慢了`);
  else if (_hrBase.bpm) bits.push(`刚连上时大约 ${_hrBase.bpm}`);
  bits.push('这是手表最近一次写入，不是心电图');
  if (cfg.hrFollow && heart.bpm >= HR_TOO_FAST) bits.push('已经很快，不要再加压，该停或改轻');
  else if (cfg.hrFollow && heart.bpm >= HR_FAST) bits.push('偏快了，不要再往重里拧');
  return `${bits.join('。')}。`;
}

function heartResultNote(heart) {
  if (!heart.available) return '这会儿没有心率读数，不要编。';
  if (heart.live) return `这会儿心率大约 ${heart.bpm}。`;
  if (heart.source === 'resting') return `只有静息心率大约 ${heart.bpm}，不是这会儿的跳动。`;
  const age = heartAgeLabel(heart.ageMs);
  return `上次心率大约 ${heart.bpm}${age ? `（${age}）` : ''}，别当成这几秒的反应。`;
}

function applyHeartCap(cmd, cfg, heart, current) {
  if (!cmd || cmd.action === 'stop' || !cfg.hrFollow || !heart.live) return cmd;
  let max = 100;
  if (heart.bpm >= HR_TOO_FAST) max = cfg.gentle;
  else if (heart.bpm >= HR_FAST) max = cfg.medium;
  else return cmd;
  let capped = false;
  for (const k of ['suction', 'vibration', 'electric']) {
    if (cmd[k] == null) continue;
    const cur = clamp(current[k], 0, 100);
    if (cmd[k] <= cur) continue;
    const next = Math.min(cmd[k], Math.max(cur, max));
    if (next < cmd[k]) {
      cmd[k] = next;
      capped = true;
    }
  }
  if (capped) cmd._heartCapped = max;
  return cmd;
}


function ingest(body = {}) {
  _last = {
    at: Date.now(),
    connected: !!body.connected,
    ready: !!body.ready,
    name: String(body.name || '').slice(0, 40),
    address: String(body.address || '').slice(0, 40),
    suction: clamp(body.suction, 0, 100),
    vibration: clamp(body.vibration, 0, 100),
    electric: clamp(body.electric, 0, 100),
    battery: Number.isFinite(Number(body.battery)) ? Number(body.battery) : -1,
    phase: String(body.phase || '').slice(0, 40),
    error: String(body.error || '').slice(0, 80),
  };
  if (!_last.connected && !_last.ready) _hrBase = { bpm: null, at: 0 };
  return _last;
}

function live() {
  if (!_last.at || Date.now() - _last.at > STALE_MS) {
    return { ..._last, connected: false, ready: false, stale: true };
  }
  return { ..._last, stale: false };
}

function isToyTool(name) {
  const n = String(name || '');
  return n === 'toy_touch' || n === 'toy_stop';
}

function shouldAttach(settings, opts = {}) {
  if (opts.isDream || opts.forTheater || opts.forGame) return false;
  if (!config(settings).enabled) return false;
  // 没连上就不挂工具/说明，平常不用时不常驻
  const st = live();
  return !!(st.connected || st.ready);
}

function toolsForChat(settings, opts = {}) {
  if (!shouldAttach(settings, opts)) return [];
  return TOY_TOOLS;
}

function levelLabel(n, cfg) {
  const v = clamp(n, 0, 100);
  if (v <= 0) return '关着';
  if (v <= cfg.gentle) return `轻（${v}）`;
  if (v <= cfg.medium) return `中（${v}）`;
  return `重（${v}）`;
}

function buildPromptSection(settings) {
  const cfg = config(settings);
  if (!cfg.enabled) return '';
  const st = live();
  if (!st.connected && !st.ready) return '';
  const bits = [
    `吮吸 ${levelLabel(st.suction, cfg)}`,
    `震动 ${levelLabel(st.vibration, cfg)}`,
    cfg.electric ? `微电 ${levelLabel(st.electric, cfg)}` : '微电关着，不要用',
  ];
  if (st.battery >= 0) bits.push(`电量大约 ${st.battery}%`);
  const heart = cfg.hrFollow ? readHeart() : { available: false, live: false, bpm: null };
  if (cfg.hrFollow) noteHeartBaseline(heart, st);
  const react = '听对方话里的反应，怎么拧完全按【性格】：可以顺着改轻/停，也可以故意不听、加码、逗对方。硬件感觉不到身体，只能靠对方说的话和气氛。';
  return [
    `【对方身边】你自己的手机连着对方身边那台（已连上；${bits.join('，')}）。`,
    `轻大约 ${cfg.gentle}，中大约 ${cfg.medium}，重大约 ${cfg.strong}——这只是对方的参考刻度；0～100 任意数都行。吮吸和震动可单独开、也可两档不同（例如吸轻震重）。`,
    cfg.hrFollow ? heartPromptLine(heart, cfg) : '',
    cfg.electric
      ? `吸、震、微电三条独立通道，可分开拧、档位可不同。换档默认缓滑；要跳变写 ramp:0。feel 会把吸和震拧成一样，要不同就分别填数字。想碰用 toy_touch；时间线用 steps。${react}没让你碰、也不是这种气氛时不要主动拧。不要在回复里写工具名。`
      : `吸和震可单独拧、档位可不同；feel 会把两者拧成一样。换档默认缓滑。时间线用 steps。${react}没让你碰、也不是这种气氛时不要主动拧。不要在回复里写工具名。`,
  ].filter(Boolean).join('\n');
}

function clampRamp(n, fallback) {
  if (n === null || n === undefined || n === '') return fallback;
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return fallback;
  return Math.min(MAX_RAMP_SEC, x);
}

/** 把一段 feel/通道参数收成可下发的档位（数字已解析；未指定的通道不写入，留给机端 merge） */
function resolveStepPatch(raw, cfg, rampFallback = DEFAULT_RAMP_SEC) {
  const step = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const feel = feelLevel(step.feel, cfg);
  const hasChannel = step.suction != null || step.vibration != null || step.electric != null;
  if (String(step.feel || '').toLowerCase() === 'stop' || feel === 0) {
    out.suction = 0;
    out.vibration = 0;
    out.electric = 0;
    out.stop = true;
    out.ramp = clampRamp(step.ramp, 0);
  } else {
    if (feel != null && !hasChannel) {
      out.suction = feel;
      out.vibration = feel;
    }
    if (step.suction != null) out.suction = clamp(step.suction, 0, 100);
    if (step.vibration != null) out.vibration = clamp(step.vibration, 0, 100);
    if (cfg.electric && step.electric != null) out.electric = clamp(step.electric, 0, 100);
    out.ramp = clampRamp(step.ramp, rampFallback);
  }
  const dur = Number(step.duration);
  if (Number.isFinite(dur) && dur > 0) out.duration = Math.min(MAX_STEP_SEC, dur);
  return out;
}

function normalizeSteps(args, cfg) {
  const raw = Array.isArray(args?.steps) ? args.steps.slice(0, MAX_STEPS) : [];
  const topRamp = clampRamp(args?.ramp, DEFAULT_RAMP_SEC);
  const steps = [];
  for (const item of raw) {
    const patch = resolveStepPatch(
      { ...item, ramp: item?.ramp != null ? item.ramp : topRamp },
      cfg,
      topRamp,
    );
    if (patch.suction == null && patch.vibration == null && patch.electric == null && !patch.stop) continue;
    steps.push(patch);
  }
  return steps;
}

function summarizeSteps(steps, cfg) {
  if (!steps?.length) return '';
  return steps.map((s, i) => {
    const bits = [];
    if (s.stop || (s.suction === 0 && s.vibration === 0 && (s.electric == null || s.electric === 0))) {
      bits.push('停');
    } else {
      if (s.suction != null) bits.push(`吸${levelLabel(s.suction, cfg)}`);
      if (s.vibration != null) bits.push(`震${levelLabel(s.vibration, cfg)}`);
      if (cfg.electric && s.electric != null) bits.push(`电${levelLabel(s.electric, cfg)}`);
    }
    const slide = s.ramp > 0 ? `滑${s.ramp}秒` : '跳变';
    const hold = s.duration ? `稳住${s.duration}秒` : (i === steps.length - 1 ? '维持' : '立刻下一段');
    return `${i + 1}) ${bits.join('·') || '保持'}（${slide}·${hold}）`;
  }).join(' → ');
}

function feelLevel(feel, cfg) {
  const f = String(feel || '').toLowerCase();
  if (f === 'stop' || f === 'off' || f === '0') return 0;
  if (f === 'gentle' || f === 'light' || f === 'soft') return cfg.gentle;
  if (f === 'medium' || f === 'normal') return cfg.medium;
  if (f === 'strong' || f === 'hard' || f === 'intense') return cfg.strong;
  return null;
}

async function execute(call = {}, ctx = {}) {
  const name = String(call.name || '');
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const settings = ctx.settings || getSettingsFn();
  const cfg = config(settings);
  if (!cfg.enabled) {
    return { ok: false, error: 'disabled', note: '对方还没打开这个。按性格接着聊，不要假装已经碰到。' };
  }
  const state = require('./phone-state-helper');
  if (!state.phoneReachable()) {
    return { ok: false, error: 'no_phone', note: '对方手机这会儿没连上念。不要假装已经碰到。' };
  }
  const cmd = { type: 'toy', action: name === 'toy_stop' ? 'stop' : 'set' };
  const heart = cfg.hrFollow ? readHeart() : { available: false, live: false, bpm: null };
  if (cfg.hrFollow) noteHeartBaseline(heart, live());
  const current = live();

  if (name === 'toy_stop' || String(args.feel || '').toLowerCase() === 'stop') {
    cmd.action = 'stop';
    cmd.suction = 0;
    cmd.vibration = 0;
    cmd.electric = 0;
    cmd.ramp = 0;
  } else {
    const topRamp = clampRamp(args.ramp, DEFAULT_RAMP_SEC);
    let steps = normalizeSteps(args, cfg);
    if (cfg.hrFollow && steps.length) {
      steps = steps.map((s) => {
        if (s.stop) return s;
        const capped = applyHeartCap({ ...s, action: 'set' }, cfg, heart, current);
        const heartCapped = capped._heartCapped;
        delete capped._heartCapped;
        delete capped.action;
        if (heartCapped != null) cmd._heartCapped = heartCapped;
        return capped;
      });
    }
    if (steps.length >= 2 || (steps.length === 1 && Array.isArray(args.steps))) {
      cmd.steps = steps.map((s) => {
        const o = {};
        if (s.stop) {
          o.suction = 0;
          o.vibration = 0;
          o.electric = 0;
          o.ramp = s.ramp != null ? s.ramp : 0;
        } else {
          if (s.suction != null) o.suction = s.suction;
          if (s.vibration != null) o.vibration = s.vibration;
          if (s.electric != null) o.electric = s.electric;
          o.ramp = s.ramp != null ? s.ramp : topRamp;
        }
        if (s.duration) o.duration = s.duration;
        return o;
      });
      const first = steps[0];
      if (first.stop) {
        cmd.action = 'stop';
        cmd.suction = 0;
        cmd.vibration = 0;
        cmd.electric = 0;
        cmd.ramp = first.ramp != null ? first.ramp : 0;
      } else {
        if (first.suction != null) cmd.suction = first.suction;
        if (first.vibration != null) cmd.vibration = first.vibration;
        if (first.electric != null) cmd.electric = first.electric;
        cmd.ramp = first.ramp != null ? first.ramp : topRamp;
      }
      cmd._stepsSummary = summarizeSteps(steps, cfg);
    } else {
      const patch = steps[0] || resolveStepPatch(args, cfg, topRamp);
      if (patch.stop || (patch.suction === 0 && patch.vibration === 0 && patch.electric === 0
        && String(args.feel || '').toLowerCase() === 'stop')) {
        cmd.action = 'stop';
        cmd.suction = 0;
        cmd.vibration = 0;
        cmd.electric = 0;
        cmd.ramp = patch.ramp != null ? patch.ramp : 0;
      } else {
        if (patch.suction != null) cmd.suction = patch.suction;
        if (patch.vibration != null) cmd.vibration = patch.vibration;
        if (patch.electric != null) cmd.electric = patch.electric;
        cmd.ramp = patch.ramp != null ? patch.ramp : topRamp;
        if (patch.duration) cmd.duration = patch.duration;
        else {
          const dur = Number(args.duration);
          if (Number.isFinite(dur) && dur > 0) cmd.duration = Math.min(MAX_STEP_SEC, dur);
        }
      }
      if (cfg.hrFollow) applyHeartCap(cmd, cfg, heart, current);
    }
  }
  const heartCapped = cmd._heartCapped;
  delete cmd._heartCapped;
  const stepsSummary = cmd._stepsSummary;
  delete cmd._stepsSummary;

  const crypto = require('crypto');
  const requestId = crypto.randomBytes(12).toString('hex');
  cmd.requestId = requestId;
  state.enqueueCommand(cmd);
  try { require('./push').broadcast?.({ type: 'phone_command', command: 'toy', ...cmd }); } catch {}
  const result = await state.waitPhone(requestId, TOY_WAIT_MS);
  if (heartCapped != null) cmd._heartCapped = heartCapped;
  if (stepsSummary) cmd._stepsSummary = stepsSummary;
  return formatResult(result, cfg, cmd, heart);
}

function formatResult(result, cfg, cmd, heart) {
  heart = heart && heart.available != null ? heart : readHeart();
  if (!result) {
    return {
      ok: false,
      error: 'timeout',
      note: '手机没回。可能念在后台被杀掉，或还没连上那台。不要假装已经碰到。',
    };
  }
  if (result.ok === false) {
    const err = result.error || 'failed';
    const note = err === 'not_connected' || err === 'not_ready'
      ? '还没连上对方身边那台。让对方先在念的设置里扫到并连上，并关掉官方 FUNF。不要假装已经碰到。'
      : err === 'bluetooth_off'
        ? '对方手机蓝牙没开。不要假装已经碰到。'
        : '这会儿没调成。不要假装已经碰到。';
    return { ok: false, error: err, note };
  }
  if (result.ready || result.connected) {
    ingest(result);
  }
  const st = live();
  const s = result.suction != null ? result.suction : (cmd.suction != null ? cmd.suction : st.suction);
  const v = result.vibration != null ? result.vibration : (cmd.vibration != null ? cmd.vibration : st.vibration);
  const e = result.electric != null ? result.electric : st.electric;
  ingest({ ...st, ...result, suction: s, vibration: v, electric: e, connected: true, ready: result.ready !== false });
  const now = live();
  const capNote = cmd && cmd._heartCapped != null
    ? `心跳已经很快，这次没再往上拧，最多到 ${levelLabel(cmd._heartCapped, cfg)}。`
    : '';
  const seqNote = cmd && cmd._stepsSummary
    ? `已按时间线开跑：${cmd._stepsSummary}。手机端会缓滑并自动切档，不必等下一轮再调。`
    : `已经调到：吮吸 ${levelLabel(now.suction, cfg)}，震动 ${levelLabel(now.vibration, cfg)}${cfg.electric ? `，微电 ${levelLabel(now.electric, cfg)}` : ''}${cmd && cmd.ramp > 0 ? `（约 ${cmd.ramp} 秒缓滑到位）` : ''}。`;
  return {
    ok: true,
    suction: now.suction,
    vibration: now.vibration,
    electric: cfg.electric ? now.electric : 0,
    heartRateBpm: cfg.hrFollow && heart.live ? heart.bpm : null,
    note: `${seqNote}${cfg.hrFollow ? heartResultNote(heart) : ''}${capNote}用自己的口吻继续，不要提工具名。`,
  };
}

/** 不强制调档：听不听、加还是减，完全按角色性格。 */
function forcedToolChoice() {
  return null;
}

module.exports = {
  TOY_TOOLS,
  ingest,
  live,
  isToyTool,
  shouldAttach,
  toolsForChat,
  buildPromptSection,
  execute,
  forcedToolChoice,
  config,
};

/**
 * 今日相处气候：压缩「对方今天过成什么样」给角色当感知，不是情绪任务单。
 * 有信号才输出；平淡日保持短/空，避免每轮灌心理分析。
 */
const db = require('./db');

function getSettings() {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function localDateStr(date, tz = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date instanceof Date ? date : new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function parseMsgTimestamp(ts) {
  if (!ts) return new Date(NaN);
  if (ts.includes('T') || ts.includes('Z') || ts.includes('+')) return new Date(ts);
  return new Date(String(ts).replace(' ', 'T') + 'Z');
}

function localHour(date, tz = 'Asia/Shanghai') {
  try {
    const d = date instanceof Date ? date : parseMsgTimestamp(date);
    if (!d || Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', hour12: false,
    }).formatToParts(d);
    return Number(parts.find((p) => p.type === 'hour')?.value || 0);
  } catch {
    return null;
  }
}

function slotOfHour(h) {
  if (h == null || !Number.isFinite(h)) return 'other';
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 24) return 'evening';
  return 'night';
}

const SLOT_LABEL = {
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
  night: '夜里',
  other: '',
};

function plainUserText(content) {
  let t = String(content || '').replace(/^【自动回复】/, '').trim();
  if (!t) return '';
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      t = String(j?.transcript || j?.text || '').trim();
    } catch { /* ignore */ }
  }
  const voice = t.match(/^\[用户语音\]\s*(.*)$/);
  if (voice) t = String(voice[1] || '').trim();
  if (t === '[用户发来一段语音]' || t === '[用户语音]') return '';
  // 纯媒体/系统味：不计入气候
  if (/^\[(图片|视频|语音|表情|拍一拍|位置|文件)/.test(t) && t.length < 40) return '';
  return t.slice(0, 240);
}

/** 粗分：正 / 负 / 平淡短 / 中性长 —— 只服务轨迹，不做诊断 */
function scoreUserTurn(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let tone = 'neutral';
  let weight = 0.35;
  if (/分手|不要你|不爱了|滚|去死|拉黑|恨你|讨厌你|恶心/.test(t)) {
    tone = 'hostile'; weight = 0.95;
  } else if (/我生气了|气死|火大|烦死|别冷战|你别理我|不想理你|无语死/.test(t)) {
    tone = 'cold'; weight = 0.82;
  } else if (/委屈|难过|想哭|崩溃|心凉|失望|心酸/.test(t)) {
    tone = 'hurt'; weight = 0.78;
  } else if (/累|困|没劲|撑不住|压力|焦虑|郁闷|难受|不想说话/.test(t)) {
    tone = 'low'; weight = 0.65;
  } else if (/喜欢你|爱你|想你|抱抱|辛苦了|谢谢|开心|哈哈|嘻嘻|太好了/.test(t)) {
    tone = 'warm'; weight = 0.7;
  } else if (/对不起|抱歉|我错了|别生气|原谅|哄你/.test(t)) {
    tone = 'soft'; weight = 0.6;
  } else if (t.length <= 8 && /^(嗯+|恩+|哦+|噢+|好+|行|ok|OK|嗯嗯|哦哦|……|\.{2,}|…+)$/i.test(t)) {
    tone = 'brief'; weight = 0.45;
  } else if (t.length <= 4) {
    tone = 'brief'; weight = 0.4;
  }
  return { tone, weight, len: t.length };
}

function tonePolarity(tone) {
  if (tone === 'warm' || tone === 'soft') return 1;
  if (tone === 'hostile' || tone === 'cold' || tone === 'hurt' || tone === 'low') return -1;
  if (tone === 'brief') return -0.35;
  return 0;
}

function loadTodayUserTurns(characterId, { tz, today } = {}) {
  const settings = getSettings();
  const zone = tz || settings.timezone || 'Asia/Shanghai';
  const day = today || localDateStr(new Date(), zone);
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { day, zone, turns: [] };

  // 多取一些，用本地日历日过滤（timestamp 多为 UTC 存法）
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, content, timestamp FROM messages
       WHERE character_id=? AND role='user' AND COALESCE(is_dream,0)=0 AND COALESCE(recalled,0)=0
         AND (type IS NULL OR type NOT IN ('system'))
       ORDER BY id DESC LIMIT 80`
    ).all(cid);
  } catch {
    return { day, zone, turns: [] };
  }

  const turns = [];
  for (const row of rows.reverse()) {
    const dt = parseMsgTimestamp(row.timestamp);
    if (Number.isNaN(dt.getTime())) continue;
    if (localDateStr(dt, zone) !== day) continue;
    const text = plainUserText(row.content);
    const scored = scoreUserTurn(text);
    if (!scored) continue;
    const hour = localHour(dt, zone);
    turns.push({
      id: row.id,
      hour,
      slot: slotOfHour(hour),
      text: text.slice(0, 80),
      ...scored,
    });
  }
  return { day, zone, turns };
}

function summarizeSlot(turns) {
  if (!turns.length) return null;
  let pol = 0;
  let wSum = 0;
  let briefN = 0;
  let warmN = 0;
  let negN = 0;
  for (const t of turns) {
    const w = t.weight || 0.35;
    pol += tonePolarity(t.tone) * w;
    wSum += w;
    if (t.tone === 'brief') briefN += 1;
    if (t.tone === 'warm' || t.tone === 'soft') warmN += 1;
    if (tonePolarity(t.tone) < 0 && t.tone !== 'brief') negN += 1;
  }
  const avg = wSum ? pol / wSum : 0;
  const briefRatio = briefN / turns.length;
  let label = '平常';
  if (negN >= 2 || avg <= -0.45) label = '偏冷/闹情绪';
  else if (briefRatio >= 0.55 && turns.length >= 2) label = '话少/应付';
  else if (warmN >= 2 || avg >= 0.4) label = '还亲近';
  else if (briefRatio >= 0.35) label = '偏短';
  return { label, avg, count: turns.length, briefRatio, negN, warmN };
}

/**
 * @returns {{ overall: string, trajectory: string, signal: boolean, userCount: number, unfinishedHint: string }}
 */
function computePeerClimate(characterId, opts = {}) {
  const { day, zone, turns } = loadTodayUserTurns(characterId, opts);
  const empty = {
    day,
    zone,
    overall: '',
    trajectory: '',
    signal: false,
    userCount: 0,
    unfinishedHint: '',
    slots: {},
  };
  if (turns.length < 2) return { ...empty, userCount: turns.length };

  const bySlot = { morning: [], afternoon: [], evening: [], night: [] };
  for (const t of turns) {
    if (bySlot[t.slot]) bySlot[t.slot].push(t);
  }
  const slotSummaries = {};
  for (const [k, list] of Object.entries(bySlot)) {
    const s = summarizeSlot(list);
    if (s) slotSummaries[k] = s;
  }

  const overallSum = summarizeSlot(turns);
  let overall = overallSum?.label || '平常';

  // 轨迹：按有内容的时段顺序比首尾
  const ordered = ['morning', 'afternoon', 'evening', 'night']
    .map((k) => (slotSummaries[k] ? { k, ...slotSummaries[k] } : null))
    .filter(Boolean);
  let trajectory = '';
  if (ordered.length >= 2) {
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const delta = (last.avg || 0) - (first.avg || 0);
    const firstOk = first.label === '还亲近' || first.label === '平常' || first.label === '偏短';
    const lastCold = /冷|闹|话少|应付/.test(last.label);
    const firstCold = /冷|闹|话少|应付/.test(first.label);
    const lastOk = last.label === '还亲近' || last.label === '平常';
    if (firstOk && lastCold && (delta <= -0.25 || last.negN >= 1 || last.briefRatio >= 0.5)) {
      trajectory = `${SLOT_LABEL[first.k] || '先前'}还${first.label === '还亲近' ? '亲近' : '正常'} → ${SLOT_LABEL[last.k] || '后来'}变得${last.label}`;
    } else if (firstCold && lastOk && delta >= 0.25) {
      trajectory = `${SLOT_LABEL[first.k] || '先前'}偏沉 → ${SLOT_LABEL[last.k] || '后来'}缓了一些`;
    } else if (ordered.every((s) => /冷|闹|话少|应付/.test(s.label)) && turns.length >= 4) {
      trajectory = '今天大部分时候都偏冷/话少';
      overall = overallSum?.label?.includes('冷') ? overall : '一整天都没怎么好好说话';
    } else if (ordered.every((s) => s.label === '还亲近') && turns.length >= 3) {
      trajectory = '今天整体还亲近';
    }
  } else if (turns.length >= 5 && /冷|闹|话少|应付|一整天/.test(overall)) {
    trajectory = '今天到目前为止都偏这个调';
  }

  const lastFew = turns.slice(-4);
  const recentCold = lastFew.filter((t) => tonePolarity(t.tone) < 0).length;
  let unfinishedHint = '';
  if (recentCold >= 2 || /冷|闹|一整天/.test(overall) || /→/.test(trajectory)) {
    unfinishedHint = '这股劲好像还没说开';
  }

  // 信号门：太平淡就不灌，避免套子
  const signal = !!(
    trajectory
    || /冷|闹|话少|应付|一整天/.test(overall)
    || (turns.length >= 6 && overallSum.briefRatio >= 0.5)
    || overallSum.negN >= 2
  );

  return {
    day,
    zone,
    overall: signal ? overall : '',
    trajectory: signal ? trajectory : '',
    signal,
    userCount: turns.length,
    unfinishedHint: signal ? unfinishedHint : '',
    slots: slotSummaries,
  };
}

function formatPeerClimateForPrompt(climate) {
  if (!climate?.signal) return '';
  const lines = ['【今天和对方】（你隐约感觉到的相处气候，不是通知，也不是待办）'];
  if (climate.overall) lines.push(`整体：${climate.overall}`);
  if (climate.trajectory) lines.push(`轨迹：${climate.trajectory}`);
  if (climate.unfinishedHint) lines.push(`未了：${climate.unfinishedHint}`);
  lines.push('提不提、怎么提看【性格】和你自己现在的状态；可以惦记但不说。');
  return lines.join('\n');
}

module.exports = {
  computePeerClimate,
  formatPeerClimateForPrompt,
  loadTodayUserTurns,
  scoreUserTurn,
};

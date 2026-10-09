/**
 * 角色连续情绪系统：起伏积压、燃点爆发、时间回落、历史曲线。
 * 与 cron.js 里冲突态 (phase/intensity) 共存，嵌在 emotion_state.mood 中。
 */
const db = require('./db');

const PRIMARY_LABELS = {
  calm: '平静',
  happy: '开心',
  warm: '暖洋洋',
  low: '有点低落',
  hurt: '委屈',
  angry: '生气',
  anxious: '忐忑',
  lonely: '孤单',
  tired: '疲惫',
  excited: '兴奋',
  bitter: '别扭',
  longing: '思念',
  desire: '欲念',
  intimate: '亲近',
};

const MOOD_EMOJI = {
  calm: '😌',
  happy: '😊',
  warm: '🌸',
  low: '🌧️',
  hurt: '😢',
  angry: '💢',
  anxious: '😟',
  lonely: '🌙',
  tired: '😴',
  excited: '✨',
  bitter: '😑',
  longing: '💭',
  desire: '🔥',
  intimate: '💗',
};

/** 恋人/暧昧等更近的关系：欲望与惦念更敏感 */
function isCloseRelationship(char = {}) {
  const blob = [
    char.relationship, char.relationship_custom, char.personality,
    char.intro, char.background, char.behavior, char.description,
  ].map((x) => String(x || '')).join(' ');
  return /恋人|爱人|伴侣|男朋友|女朋友|男友|女友|老公|老婆|丈夫|妻子|情侣|对象|配偶|未婚|夫妻|暗恋|单恋|暧昧|心上人|crush|lover|darling|boyfriend|girlfriend|husband|wife/i.test(blob);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/** 从人设推基线与燃点阈值；基线随感情线阶段略抬（D21，图表中线仍用 valence=0 平静） */
function getAffectionBaselineOffset(char = {}) {
  try {
    const state = require('./affection-helper').loadState(char);
    if (!state?.stage) return 0;
    const offsets = {
      new: 0, warming: 2.5, settling: 5, settled: 7.5, deep: 10,
      strained: -4, cooling: -6,
      distant: 0, familiar: 1, close: 2, bonded: 3,
    };
    return offsets[state.stage] ?? 0;
  } catch {
    return 0;
  }
}

function deriveTemperament(char = {}) {
  const blob = `${char.personality || ''} ${char.emotion_style || ''} ${char.behavior || ''} ${char.background || ''}`;
  const has = (re) => re.test(blob);
  const close = isCloseRelationship(char);

  let baseline = 8;
  let angerGain = 1;
  let hurtGain = 1;
  let lowGain = 1;
  let yearningGain = 1; // 亲密值上空窗时「惦念压」涨速
  let desireGain = close ? 1.05 : 0.55;
  let intimacyGain = close ? 1.1 : 0.75;
  let recovery = 1;
  let angerThreshold = 72;
  let hurtThreshold = 78;
  let lowThreshold = 82;
  let desireThreshold = close ? 84 : 92;
  let intimacyThreshold = 80;
  let yearningThreshold = 70; // 惦念压触「思念上头」（须亲密够）

  if (has(/乐观|开朗|活泼|乐天|阳光|爽朗/)) baseline += 14;
  if (has(/悲观|阴郁|忧郁|消沉|内耗|敏感玻璃/)) baseline -= 12;
  if (has(/粘人|黏人|依恋|缺爱|安全感差|容易不安|恋爱脑|深情|专一/)) {
    baseline -= 4;
    hurtGain += 0.35;
    hurtThreshold -= 8;
    yearningGain += 0.5;
    yearningThreshold -= 12;
    intimacyGain += 0.25;
  }
  if (has(/易怒|暴躁|火爆|脾气大|暴脾气|一点就着|炸毛/)) {
    angerGain += 0.55;
    angerThreshold -= 18;
  }
  if (has(/记仇|倔强|别扭|要面子|嘴硬|冷淡|高冷/)) {
    recovery -= 0.35;
    angerGain += 0.15;
    intimacyGain -= 0.15;
  }
  if (has(/好哄|心软|怕吵架|耳根软|容易原谅|温柔|柔和|温和|体贴|细腻/)) {
    recovery += 0.45;
    angerThreshold += 8;
    intimacyGain += 0.2;
  }
  if (has(/玻璃心|敏感|委屈|多虑|想太多/)) {
    hurtGain += 0.45;
    lowGain += 0.25;
    hurtThreshold -= 12;
    yearningGain += 0.2;
  }
  if (has(/淡漠|理性|冷静|佛系|钝感/)) {
    angerGain -= 0.25;
    hurtGain -= 0.2;
    yearningGain -= 0.35;
    desireGain -= 0.3;
    recovery += 0.15;
    angerThreshold += 10;
    yearningThreshold += 10;
  }
  if (has(/内耗|自我否定|挫败|完美主义|焦虑/)) {
    lowGain += 0.4;
    lowThreshold -= 10;
    baseline -= 6;
  }
  if (has(/色气|撩人|会撩|饥渴|占有欲|黏糊|浪|骚|欲念重|好色/)) {
    desireGain += 0.55;
    desireThreshold -= 14;
  }
  if (has(/清冷|禁欲|害羞|纯情|脸皮薄|社恐|内向/)) {
    desireGain -= 0.25;
    desireThreshold += 10;
    intimacyThreshold += 6;
  }
  if (has(/薄情|花心|渣|玩世|无情/)) {
    intimacyGain -= 0.35;
    yearningGain -= 0.2;
  }

  baseline += getAffectionBaselineOffset(char);

  return {
    baseline: clamp(baseline, -25, 35),
    angerGain: clamp(angerGain, 0.4, 2.2),
    hurtGain: clamp(hurtGain, 0.4, 2.2),
    lowGain: clamp(lowGain, 0.4, 2.2),
    yearningGain: clamp(yearningGain, 0.35, 2.3),
    desireGain: clamp(desireGain, 0.2, 2.3),
    intimacyGain: clamp(intimacyGain, 0.3, 2.2),
    recovery: clamp(recovery, 0.35, 1.8),
    angerThreshold: clamp(angerThreshold, 45, 92),
    hurtThreshold: clamp(hurtThreshold, 50, 95),
    lowThreshold: clamp(lowThreshold, 55, 95),
    desireThreshold: clamp(desireThreshold, 55, 96),
    intimacyThreshold: clamp(intimacyThreshold, 55, 95),
    yearningThreshold: clamp(yearningThreshold, 48, 94),
    closeRelationship: close,
  };
}

/** 按人设分配「用户情绪 / 自身心情 / 日程处境」对回复语气的权重（三者之和为 1） */
function deriveEmotionInfluenceWeights(char = {}) {
  const blob = `${char.personality || ''} ${char.emotion_style || ''} ${char.behavior || ''} ${char.background || ''}`;
  const has = (re) => re.test(blob);
  const close = isCloseRelationship(char);

  let userW = 0.44;
  let selfW = 0.36;
  let schedW = 0.20;

  if (has(/粘人|黏人|依恋|缺爱|安全感差|容易不安|恋爱脑|深情|玻璃心|敏感|好哄|心软|共情|体贴|温柔|柔和|温和|细腻/)) {
    userW += 0.14; selfW -= 0.10;
  }
  if (has(/淡漠|理性|冷静|佛系|钝感|高冷|冷淡|记仇|倔强|要面子|嘴硬/)) {
    userW -= 0.12; selfW += 0.12;
  }
  if (has(/工作狂|事业|职业|规律|自律|计划|忙碌|社畜/)) {
    schedW += 0.10; selfW -= 0.05;
  }
  if (close) userW += 0.06;
  if (has(/易怒|暴躁|火爆|脾气大/)) {
    selfW += 0.06; userW -= 0.04;
  }

  userW = clamp(userW, 0.22, 0.62);
  selfW = clamp(selfW, 0.22, 0.58);
  schedW = clamp(schedW, 0.08, 0.32);
  const sum = userW + selfW + schedW;
  return {
    user: round1(userW / sum),
    self: round1(selfW / sum),
    schedule: round1(schedW / sum),
  };
}

/** 从用户本轮消息推断其情绪倾向（供语气优先级使用，不写入角色数值） */
function inferUserEmotionFromMessage(text) {
  const t = String(text || '').replace(/^【自动回复】/, '').trim();
  if (!t || t.length < 2) return null;

  let tone = 'neutral';
  let intensity = 0.35;
  let label = '平常';
  const signals = [];

  const bump = (nextTone, nextLabel, str, inc = 0.22) => {
    if (inc > intensity) {
      tone = nextTone;
      label = nextLabel;
      intensity = inc;
    }
    signals.push(str);
  };

  if (/分手|不要你|不爱了|滚出去|去死|拉黑你|恨你|讨厌你|废物|恶心死/.test(t)) {
    bump('hostile', '带刺/发火', '攻击性话语', 0.88);
  } else if (/对不起|抱歉|我错了|别生气|原谅我|哄你/.test(t)) {
    bump('apologetic', '示好/道歉', '在缓和', 0.62);
  } else if (/我生气了|气死我了|火大了|烦死了|别冷战|你别理我/.test(t)) {
    bump('angry', '生气/烦躁', '表达不满', 0.78);
  } else if (/委屈|难过|心酸|想哭|崩溃|绝望|好痛|心凉|失望|无语/.test(t)) {
    bump('hurt', '难过/委屈', '情绪低落', 0.76);
  } else if (/累|困|没劲|不想动|撑不住|压力|焦虑|郁闷|难受/.test(t)) {
    bump('low', '疲惫/低压', '状态不佳', 0.68);
  } else if (/喜欢你|爱你|想你|抱抱|辛苦了|谢谢|开心|哈哈|嘻嘻|太好了|真棒/.test(t)) {
    bump('warm', '开心/亲近', '正向互动', 0.72);
  } else if (/？|\?|吗$|呢$|能不能|可不可以|帮/.test(t) && t.length < 40) {
    bump('curious', '询问/试探', '在提问', 0.42);
  } else if (t.length <= 6 && /^嗯|哦|好|行|ok|OK|…|\.{2,}$/.test(t)) {
    bump('brief', '简短/平淡', '话不多', 0.38);
  }

  if (tone === 'neutral') return null;
  return { tone, label, intensity: round1(intensity), signals: signals.slice(0, 3) };
}

function defaultMood(char) {
  const t = deriveTemperament(char);
  return {
    valence: t.baseline,
    arousal: 28,
    primary: 'calm',
    fuel: { anger: 0, hurt: 0, low: 0, desire: 0, intimacy: t.closeRelationship ? 18 : 8 },
    yearning: 0, // 亲密值上的惦念压，不是独立燃料
    flashpoint: null,
    label: 'calm',
    note: '',
    baseline: t.baseline,
    lastSampleAt: null,
  };
}

/** 惦念压不能脱离亲密：亲密太低时自动压扁 */
function clampYearningToIntimacy(yearning, intimacy) {
  const cap = Math.max(0, Number(intimacy) || 0) * 1.05 + 8;
  return clamp(Number(yearning) || 0, 0, Math.min(100, cap));
}

function normalizeMood(raw, char) {
  const base = defaultMood(char);
  if (!raw || typeof raw !== 'object') return base;
  const fuel = raw.fuel && typeof raw.fuel === 'object' ? raw.fuel : {};
  const intimacy = clamp(
    Number.isFinite(Number(fuel.intimacy)) ? Number(fuel.intimacy) : base.fuel.intimacy,
    0,
    100,
  );
  // 兼容旧存档：曾把思念写成 fuel.longing
  const legacyLonging = Number(fuel.longing);
  const yearningRaw = Number.isFinite(Number(raw.yearning))
    ? Number(raw.yearning)
    : (Number.isFinite(legacyLonging) ? legacyLonging : 0);
  return {
    valence: clamp(Number(raw.valence) || base.valence, -100, 100),
    arousal: clamp(Number(raw.arousal) || base.arousal, 0, 100),
    primary: PRIMARY_LABELS[raw.primary] ? raw.primary : base.primary,
    fuel: {
      anger: clamp(Number(fuel.anger) || 0, 0, 100),
      hurt: clamp(Number(fuel.hurt) || 0, 0, 100),
      low: clamp(Number(fuel.low) || 0, 0, 100),
      desire: clamp(Number(fuel.desire) || 0, 0, 100),
      intimacy,
    },
    yearning: clampYearningToIntimacy(yearningRaw, intimacy),
    flashpoint: raw.flashpoint && typeof raw.flashpoint === 'object' ? raw.flashpoint : null,
    label: String(raw.label || base.label),
    note: String(raw.note || ''),
    baseline: Number.isFinite(Number(raw.baseline)) ? Number(raw.baseline) : base.baseline,
    lastSampleAt: raw.lastSampleAt || null,
    lastSilenceAt: raw.lastSilenceAt || null,
    lastSilenceKind: raw.lastSilenceKind || null,
    silenceHeardUser: !!raw.silenceHeardUser,
  };
}

function maxNegFuel(fuel = {}) {
  return Math.max(fuel.anger || 0, fuel.hurt || 0, fuel.low || 0);
}

function maxBondFuel(mood = {}) {
  const fuel = mood.fuel || mood;
  return Math.max(fuel.desire || 0, fuel.intimacy || 0, mood.yearning || 0);
}

function pickPrimary(mood) {
  const { valence: v, arousal: a, fuel, flashpoint, yearning } = mood;
  const y = Number(yearning) || 0;
  const anger = fuel.anger || 0;
  const hurt = fuel.hurt || 0;
  const low = fuel.low || 0;
  const hot = flashpointStillHot(mood);
  const negMax = Math.max(anger, hurt, low);
  // 燃点优先；未爆时也按积压认主心情，避免燃料已经不低了面板还钉着平静
  if ((hot && flashpoint?.type === 'anger') || (anger >= 38 && anger >= hurt && anger >= low && a >= 28)) return 'angry';
  if ((hot && flashpoint?.type === 'hurt') || (hurt >= 34 && hurt >= anger && v < 12)) return 'hurt';
  if ((hot && flashpoint?.type === 'breakdown') || (low >= 38 && low >= anger && low >= hurt)) return 'low';
  if ((hot && flashpoint?.type === 'desire') || (fuel.desire >= 58 && a >= 40 && fuel.intimacy >= 22 && anger < 36)) return 'desire';
  if ((hot && flashpoint?.type === 'longing') || (y >= 48 && fuel.intimacy >= 22 && anger < 32 && hurt < 34 && v > -36)) return 'longing';
  if ((hot && flashpoint?.type === 'intimacy') || (fuel.intimacy >= 72 && y < 42 && v >= 14 && a >= 28 && fuel.desire < 52 && negMax < 28)) return 'intimate';
  if (v >= 32 && a >= 52 && negMax < 24) return 'excited';
  if (v >= 24 && negMax < 22) return a >= 38 ? 'happy' : 'warm';
  if (v <= -28 && a >= 46) return 'anxious';
  if (v <= -22) return hurt >= low ? 'hurt' : 'low';
  if (v <= -10 && a <= 36) return (y >= 32 && fuel.intimacy >= 20) ? 'longing' : 'lonely';
  if (a <= 22 && v < 12) return 'tired';
  if (anger >= 22 || hurt >= 24) return 'bitter';
  if (y >= 40 && fuel.intimacy >= 22 && y >= (fuel.desire || 0)) return 'longing';
  if (fuel.desire >= 42) return 'desire';
  return 'calm';
}

/** 对内稳定 key：英文 primary（不用「火气/欲念压着」等软中文当标签） */
function softLabel(mood) {
  const primary = mood.primary || pickPrimary(mood);
  return PRIMARY_LABELS[primary] ? primary : 'calm';
}

/** 对外展示：只给 emoji */
function moodDisplayString(mood) {
  return MOOD_EMOJI[softLabel(mood)] || '😌';
}

/** 从当前状态取最多 topK 个英文心情 id（记忆点 mood_tags / 注入用） */
function topMoodTags(mood, topK = 3) {
  const m = mood && typeof mood === 'object' ? mood : {};
  const fuel = m.fuel || {};
  const primary = softLabel(m);
  const scored = [
    { id: 'angry', v: Number(fuel.anger) || 0 },
    { id: 'hurt', v: Number(fuel.hurt) || 0 },
    { id: 'low', v: Number(fuel.low) || 0 },
    { id: 'desire', v: Number(fuel.desire) || 0 },
    { id: 'intimate', v: Number(fuel.intimacy) || 0 },
    { id: 'longing', v: Number(m.yearning) || 0 },
    { id: 'happy', v: Math.max(0, Number(m.valence) || 0) },
    { id: 'anxious', v: (Number(m.arousal) || 0) >= 50 && (Number(m.valence) || 0) <= -10 ? (Number(m.arousal) || 0) : 0 },
    { id: 'tired', v: (Number(m.arousal) || 0) <= 22 ? (40 - (Number(m.arousal) || 0)) : 0 },
  ];
  if (m.flashpoint && flashpointStillHot(m)) {
    const fpMap = {
      anger: 'angry', hurt: 'hurt', breakdown: 'low',
      longing: 'longing', desire: 'desire', intimacy: 'intimate',
    };
    const fpId = fpMap[m.flashpoint.type];
    if (fpId) {
      const hit = scored.find((x) => x.id === fpId);
      if (hit) hit.v = Math.max(hit.v, 90);
    }
  }
  scored.sort((a, b) => b.v - a.v);
  const out = [];
  const seen = new Set();
  const push = (id) => {
    if (!id || seen.has(id) || !MOOD_EMOJI[id]) return;
    seen.add(id);
    out.push(id);
  };
  push(primary);
  for (const s of scored) {
    if (out.length >= topK) break;
    if (s.v < (['angry', 'hurt', 'low'].includes(s.id) ? 22 : 24) && s.id !== primary) continue;
    push(s.id);
  }
  if (!out.length) push('calm');
  return out.slice(0, topK);
}

function moodTagsToEmoji(tags) {
  return (tags || []).map((id) => MOOD_EMOJI[id]).filter(Boolean).join('') || '😌';
}

/** 分析一条消息对情绪的软冲击（不含精确数字展示） */
function scoreMessageImpact(text, role) {
  const t = String(text || '').replace(/^【自动回复】/, '').trim();
  if (!t || t.length < 2) return null;

  let dV = 0;
  let dA = 0;
  let dAnger = 0;
  let dHurt = 0;
  let dLow = 0;
  let dYearning = 0;
  let dDesire = 0;
  let dIntimacy = 0;
  let note = '';

  const hit = (re, w = 1) => (re.test(t) ? w : 0);

  // 负向先判：吵架里常出现「今晚别…」「你硬要…」「你想要怎样」等，绝不能先被暧昧词抢走
  const insult = hit(/滚|废物|烦死了|闭嘴|讨厌你|恨你|没用|恶心|去死|别来找我|拉黑你/, 1);
  const cold = hit(/随便你|爱怎样怎样|关我什么事|不想理你|懒得理|你爱谁谁/, 1);
  const blame = hit(/都怪你|你总是|你从来不|又搞砸|太让我失望|对你失望/, 1);
  const fail = hit(/搞砸了|失败了|没做好|压力好大|好焦虑|好郁闷|好难受|好难过|好委屈|想哭了|哭了/, 1);
  const threat = hit(/分手|不要你了|不爱了|决裂|冷战|吵架|大吵|吵一架|别跟我说|别说话|滚远点/, 1);
  const quarrelCue = hit(
    /吵架|生气|火大|吵什么|你怎么这样|过分|委屈|不理你|不理我|冷战|吵完|别跟我吵|吵起来|气死|怒了|翻脸|恼了|气坏/,
    1
  );
  const hasConflict = !!(insult || cold || blame || fail || threat || quarrelCue);

  // 正向亲近（冲突话里若同时出现「原谅」等，仍允许微弱示好，但不盖过冲突 note）
  const warm = hit(/喜欢你|爱你|想你|抱抱|辛苦了|做得好|真棒|骄傲|谢谢|感谢|陪你|在呢|不走|原谅我|哄哄|心疼/, 1);
  const praise = hit(/厉害|好棒|太好了|开心|哈哈|嘻嘻|可爱|漂亮|帅|真棒|优秀/, 1);
  const missApart = hit(/思念|惦念|挂念|想念|多久没见|好久没见|什么时候见|想见你|好想见面|好想你/, 1);
  const missSoft = hit(/想你/, 1);
  // 暧昧：去掉「今晚/硬/湿/身体/想要/忍不住/摸摸」等吵架/日常误伤词
  const flirty = !hasConflict && hit(
    /亲亲|吻你|亲一下|抱紧|靠近点|靠过来|脸红|心跳加速|撩我|色色|贴贴|睡觉觉|好烫|想抱你|想亲亲/,
    1
  );

  if (warm && !hasConflict) {
    dV += 8 * warm; dA += 3; dAnger -= 8; dHurt -= 10; dLow -= 6;
    dIntimacy += 5; dDesire += 1;
    note = '被温柔/肯定接住了';
  } else if (warm && hasConflict) {
    // 吵里夹着示好：只略松火气，不写成暧昧
    dAnger -= 2; dHurt -= 1; dIntimacy += 1;
  }
  if (praise && !hasConflict) {
    dV += 7 * praise; dA += 5; dLow -= 5; dIntimacy += 2;
    note = note || '气氛变轻了';
  }
  if (missApart && !hasConflict) {
    dYearning += 11; dV += 2; dA += 3; dIntimacy += 3; dDesire += 1;
    note = note || '惦念被撩起来了';
  } else if (missSoft && warm && !hasConflict) {
    dYearning -= 5; dDesire += 0.8; dIntimacy += 3;
  } else if (missSoft && !hasConflict) {
    dYearning += 6; dIntimacy += 2; dDesire += 0.6;
    note = note || '有点惦念';
  }
  if (flirty) {
    dDesire += 7; dA += 6; dIntimacy += 3; dV += 3; dYearning -= 1;
    note = note || '气氛往暧昧里偏了';
  }

  // 角色台词不回写负向燃料（D22）；用户侧负向照常计
  if (role !== 'assistant') {
    if (insult) {
      dV -= 11; dA += 14; dAnger += 12; dHurt += 8;
      dIntimacy -= 10; dDesire -= 6; dYearning += 2;
      note = '对方的话很刺';
    }
    if (cold) {
      dV -= 6; dA += 5; dHurt += 8; dAnger += 5;
      dIntimacy -= 6; dYearning += 4; dDesire -= 3;
      note = note || '感到被晾着';
    }
    if (blame) {
      dV -= 8; dA += 8; dHurt += 9; dAnger += 6; dLow += 5;
      dIntimacy -= 4;
      note = note || '被指责戳到了';
    }
    if (fail) {
      dV -= 5; dA += 4; dLow += 9; dHurt += 3;
      note = note || '挫败感在堆';
    }
    if (threat || quarrelCue) {
      dV -= 14; dA += 18; dAnger += 15; dHurt += 12;
      dIntimacy -= 12; dDesire -= 8; dYearning += 5;
      note = '冲突在升温';
    }
  } else if (hasConflict) {
    // 角色自己在吵：欲望/暧昧不应被台词里的误伤词拱起来
    dDesire = Math.min(dDesire, 0);
  }

  // 道歉：示好不等于立刻翻篇，只给软恢复信号
  if (/对不起|抱歉|我错了|别生气|消消气|原谅我|哄你/.test(t)) {
    dAnger -= 6;
    dHurt -= 4;
    dA -= 4;
    dV += 3;
    dIntimacy += 3;
    note = note || '有人在示好，火气松了一点点';
  }

  // 角色台词不再大幅回写亲密/欲念燃料：越演越烫会把读数顶死、台词也越容易复读
  if (role === 'assistant' && !hasConflict) {
    if (/开心|高兴|哈哈/.test(t)) { dV += 2; dA += 1; dIntimacy += 0.3; }
    if (/想你|思念|惦念|挂念/.test(t)) { dYearning += 0.6; dIntimacy += 0.4; }
    if (/想抱你|想亲亲|脸红|心跳加速|好烫|靠近点|抱紧/.test(t)) {
      dDesire += 0.5; dA += 1; dIntimacy += 0.3;
    }
  }

  // 没有明确负向时，委屈/低落应往下漏，避免闲聊越积越高
  if (!insult && !cold && !blame && !fail && !threat && !quarrelCue) {
    dHurt -= 1.4;
    dLow -= 1.2;
  }

  // 平淡短句：仍有微弱起伏，保证每轮曲线能动一点
  const totalAbs = Math.abs(dV) + Math.abs(dAnger) + Math.abs(dHurt) + Math.abs(dLow)
    + Math.abs(dYearning) + Math.abs(dDesire) + Math.abs(dIntimacy);
  if (totalAbs < 3) {
    const micro = 0.6 + (t.length % 5) * 0.15;
    if (t.length <= 8) {
      return {
        dV: micro * 0.5, dA: -0.4, dAnger: -0.5, dHurt: -0.4, dLow: -0.3,
        dYearning: -0.2, dDesire: -0.25, dIntimacy: 0.15,
        note: '', soft: true,
      };
    }
    return {
      dV: micro * 0.35, dA: -0.25, dAnger: -0.35, dHurt: -0.3, dLow: -0.25,
      dYearning: -0.15, dDesire: -0.2, dIntimacy: 0.1,
      note: '', soft: true,
    };
  }

  return { dV, dA, dAnger, dHurt, dLow, dYearning, dDesire, dIntimacy, note, soft: false };
}

/** 已结束的日程对心情的影响；只认计划/回顾里明确出现的体验，不凭职业武断。 */
function scoreScheduleImpact(activity, review) {
  const act = String(activity || '').trim();
  const result = String(review || '').trim();
  const text = `${act} ${result}`;
  if (!text.trim()) return null;

  let dV = 0;
  let dA = 0;
  let dAnger = 0;
  let dHurt = 0;
  let dLow = 0;
  let note = '';

  const unwanted = /不想|不愿|不情愿|被迫|不得不|硬着头皮|勉强|厌烦|讨厌|排斥/.test(text);
  const irritated = /烦躁|烦闷|恼火|窝火|生气|火大|抓狂|憋屈/.test(text);
  const setback = /失败|搞砸|不顺|受挫|挨骂|批评|返工|出错|压力|焦虑|紧张/.test(text);
  const tired = /疲惫|累坏|很累|劳累|筋疲力尽|加班|赶工|熬夜|通宵|夜班|值班|开会|通勤|赶路|上班|训练|赶稿|备课/.test(text);
  const relaxed = /放松|轻松|舒展|休息得不错|睡得很好|惬意|平静下来/.test(text);
  const pleased = !/不开心|没开心|并不开心|不高兴/.test(text)
    && /开心|高兴|愉快|享受|有趣|顺利|满意|成就感|喜欢|期待|惊喜/.test(text);

  if (unwanted) {
    dV -= 6; dA += 6; dAnger += 8; dLow += 2;
    note = `日程「${act.slice(0, 28)}」并不是自己想做的，烦躁在往上积`;
  }
  if (irritated) {
    dV -= 6; dA += 8; dAnger += 10;
    note = note || `日程「${act.slice(0, 28)}」让心里有些烦躁`;
  }
  if (setback) {
    dV -= 6; dA += 4; dLow += 8; dHurt += 2;
    note = note || `日程「${act.slice(0, 28)}」不太顺，挫败感留了下来`;
  }
  if (tired) {
    dV -= 4; dA -= 12; dLow += 8;
    note = note || `日程「${act.slice(0, 28)}」耗着精力，这会儿提不起劲`;
  }
  if (relaxed) {
    dV += 5; dA -= 5; dAnger -= 4; dHurt -= 3; dLow -= 6;
    note = note || `日程「${act.slice(0, 28)}」让心情松了下来`;
  }
  if (pleased) {
    dV += 7; dA += 3; dAnger -= 3; dLow -= 5;
    note = note || `日程「${act.slice(0, 28)}」带来了好心情`;
  }

  const total = Math.abs(dV) + Math.abs(dA) + Math.abs(dAnger)
    + Math.abs(dHurt) + Math.abs(dLow);
  if (total < 1) return null;
  return {
    dV, dA, dAnger, dHurt, dLow,
    dYearning: 0, dDesire: 0, dIntimacy: 0,
    note,
    soft: total < 8,
  };
}

/** 余温/冲突中：负面冲击放大，正面恢复变慢 —— 才会「慢慢降又被戳起来」 */
function amplifyImpactForAfterglow(impact, phase, intensity) {
  if (!impact || !phase) return impact;
  const open = phase === 'open';
  const residual = phase === 'residual';
  if (!open && !residual) return impact;
  const heat = clamp((Number(intensity) || 40) / 100, 0.25, 1);
  const negAmp = open ? (1.12 + heat * 0.22) : (1.08 + heat * 0.32);
  const posDamp = open ? 0.68 : 0.78;
  const next = { ...impact };
  if (next.dV < 0) next.dV *= negAmp;
  else if (next.dV > 0) next.dV *= posDamp;
  if (next.dAnger > 0) next.dAnger *= negAmp;
  else next.dAnger *= open ? 0.7 : 0.85;
  if (next.dHurt > 0) next.dHurt *= negAmp;
  else next.dHurt *= open ? 0.7 : 0.85;
  if (next.dLow > 0) next.dLow *= (residual ? negAmp * 0.9 : 1);
  // 冲突中：亲近/欲望更难涨，思念可能憋着涨；开吵时欲望直接压掉，防误标暧昧
  if (next.dIntimacy > 0) next.dIntimacy *= open ? 0.45 : 0.65;
  else if (next.dIntimacy < 0) next.dIntimacy *= negAmp;
  if (next.dDesire > 0) next.dDesire *= open ? 0 : 0.55;
  else if (next.dDesire < 0) next.dDesire *= 1.1;
  if (next.dYearning > 0) next.dYearning *= residual ? 1.15 : 1.05;
  if (open && /暧昧|撩|心动|脸红/.test(String(next.note || ''))) {
    next.note = '冲突在升温';
    next.dDesire = Math.min(0, Number(next.dDesire) || 0);
  }
  if (!next.soft && next.dV < -2) {
    next.note = next.note
      || (residual ? '余温还在，又被戳到了' : '火上浇油');
  }
  // 余韵里一句带刺也可能重新拱火（仍非瞬间满格）
  if (residual && next.soft === false && (next.dAnger > 3 || next.dHurt > 4 || next.dV < -6)) {
    next.rekindle = true;
  }
  return next;
}

function applyImpact(mood, impact, temper, nowIso) {
  if (!impact) return { mood, changed: false, flashed: null, dipped: false, rekindle: false };

  const next = {
    ...mood,
    fuel: { ...mood.fuel },
    flashpoint: mood.flashpoint ? { ...mood.flashpoint } : null,
  };
  const prevValence = next.valence;

  const gainA = impact.dAnger > 0 ? temper.angerGain : temper.recovery;
  const gainH = impact.dHurt > 0 ? temper.hurtGain : temper.recovery;
  const gainL = impact.dLow > 0 ? temper.lowGain : temper.recovery;
  const gainY = impact.dYearning > 0 ? temper.yearningGain : temper.recovery;
  const gainD = impact.dDesire > 0 ? temper.desireGain : temper.recovery;
  const gainI = impact.dIntimacy > 0 ? temper.intimacyGain : temper.recovery * 0.9;

  next.valence = clamp(next.valence + impact.dV * (impact.dV < 0 ? 1 : temper.recovery * 0.85), -100, 100);
  next.arousal = clamp(next.arousal + impact.dA, 0, 100);
  next.fuel.anger = clamp(next.fuel.anger + (impact.dAnger || 0) * gainA, 0, 100);
  next.fuel.hurt = clamp(next.fuel.hurt + (impact.dHurt || 0) * gainH, 0, 100);
  next.fuel.low = clamp(next.fuel.low + (impact.dLow || 0) * gainL, 0, 100);
  next.fuel.desire = clamp(next.fuel.desire + (impact.dDesire || 0) * gainD, 0, 100);
  next.fuel.intimacy = clamp(next.fuel.intimacy + (impact.dIntimacy || 0) * gainI, 0, 100);
  next.yearning = clampYearningToIntimacy(
    (Number(next.yearning) || 0) + (impact.dYearning || 0) * gainY,
    next.fuel.intimacy,
  );

  // 惦念压高且亲密够时，微微拱欲望（幅度小，避免长期顶满）
  if (next.yearning >= 58 && next.fuel.intimacy >= 32 && (impact.dYearning || 0) > 0) {
    next.fuel.desire = clamp(next.fuel.desire + 0.6 * temper.desireGain, 0, 100);
  }
  if (next.fuel.intimacy < 18 && next.fuel.desire > 40) {
    next.fuel.desire = clamp(next.fuel.desire - 2, 0, 100);
  }

  if (impact.note && !impact.soft) next.note = impact.note.slice(0, 80);

  let flashed = null;
  // 燃点：积压够了才爆，不会一句就炸（除非冲击极大且阈值很低）
  if (!next.flashpoint || cooledFlashpoint(next.flashpoint, nowIso)) {
    if (next.fuel.anger >= temper.angerThreshold && next.arousal >= 48) {
      flashed = { type: 'anger', at: nowIso, note: next.note || '火气压不住了' };
      next.flashpoint = flashed;
      next.valence = clamp(next.valence - 10, -100, 100);
      next.arousal = clamp(next.arousal + 14, 0, 100);
      next.fuel.anger = clamp(next.fuel.anger - 22, 18, 100);
    } else if (next.fuel.hurt >= temper.hurtThreshold) {
      flashed = { type: 'hurt', at: nowIso, note: next.note || '委屈破防了' };
      next.flashpoint = flashed;
      next.valence = clamp(next.valence - 11, -100, 100);
      next.arousal = clamp(next.arousal + 8, 0, 100);
      next.fuel.hurt = clamp(next.fuel.hurt - 18, 15, 100);
    } else if (next.fuel.low >= temper.lowThreshold && next.valence <= -15) {
      flashed = { type: 'breakdown', at: nowIso, note: next.note || '积压的低落垮下来了' };
      next.flashpoint = flashed;
      next.valence = clamp(next.valence - 8, -100, 100);
      next.arousal = clamp(next.arousal - 6, 0, 100);
      next.fuel.low = clamp(next.fuel.low - 16, 16, 100);
    } else if (
      next.fuel.desire >= temper.desireThreshold
      && next.fuel.intimacy >= 30
      && next.arousal >= 42
      && next.fuel.anger < 55
    ) {
      flashed = { type: 'desire', at: nowIso, note: next.note || '欲念压不住了' };
      next.flashpoint = flashed;
      next.arousal = clamp(next.arousal + 14, 0, 100);
      next.valence = clamp(next.valence + 4, -100, 100);
      next.fuel.desire = clamp(next.fuel.desire - 16, 38, 100);
    } else if (
      next.yearning >= temper.yearningThreshold
      && next.fuel.intimacy >= 28
      && next.fuel.anger < 50
      && next.fuel.hurt < 55
    ) {
      flashed = { type: 'longing', at: nowIso, note: next.note || '思念涌上来了' };
      next.flashpoint = flashed;
      next.arousal = clamp(next.arousal + 8, 0, 100);
      next.valence = clamp(next.valence - 4, -100, 100);
      next.yearning = clampYearningToIntimacy(next.yearning - 14, next.fuel.intimacy);
    } else if (
      next.fuel.intimacy >= temper.intimacyThreshold
      && next.yearning < 40
      && (impact.dIntimacy || 0) > 2
      && next.valence >= 10
      && next.fuel.anger < 40
    ) {
      flashed = { type: 'intimacy', at: nowIso, note: next.note || '亲近感一下子满了' };
      next.flashpoint = flashed;
      next.valence = clamp(next.valence + 6, -100, 100);
      next.arousal = clamp(next.arousal + 6, 0, 100);
      next.fuel.intimacy = clamp(next.fuel.intimacy - 10, 45, 100);
      next.yearning = clampYearningToIntimacy(next.yearning, next.fuel.intimacy);
    }
  }

  const dipped = !flashed && (prevValence - next.valence) >= 8 && next.valence <= -8;
  if (dipped && !next.note) next.note = '心情明显沉了一截';

  next.primary = pickPrimary(next);
  next.label = softLabel(next);
  return {
    mood: next,
    changed: true,
    flashed,
    dipped,
    rekindle: !!impact.rekindle,
  };
}

function cooledFlashpoint(fp, nowIso) {
  if (!fp?.at) return true;
  const ageH = (Date.parse(nowIso) - Date.parse(fp.at)) / 3600000;
  return ageH >= 2.5;
}

/** 燃点是否还「烫」——标题/展示用，避免燃料已回落仍写「怒意上头」 */
function flashpointStillHot(mood, nowIso = new Date().toISOString()) {
  const fp = mood?.flashpoint;
  if (!fp?.at) return false;
  const ageMin = (Date.parse(nowIso) - Date.parse(fp.at)) / 60000;
  if (!Number.isFinite(ageMin) || ageMin > 50) return false;
  const fuel = mood.fuel || {};
  const y = Number(mood.yearning) || 0;
  if (fp.type === 'anger') return (fuel.anger || 0) >= 24;
  if (fp.type === 'hurt') return (fuel.hurt || 0) >= 20;
  if (fp.type === 'breakdown') return (fuel.low || 0) >= 24;
  if (fp.type === 'desire') return (fuel.desire || 0) >= 34;
  if (fp.type === 'intimacy') return (fuel.intimacy || 0) >= 40;
  if (fp.type === 'longing') return y >= 36 && (fuel.intimacy || 0) >= 22;
  return ageMin < 20;
}

/** 单条负面燃料向 0 回落：越高回落越快（模拟人类情绪自然平复） */
function decayFuelTowardZero(value, hours, baseRate, recovery) {
  const v = Number(value) || 0;
  if (v <= 0 || hours <= 0) return 0;
  const accel = 1 + (v / 48) * (v / 48);
  const drop = hours * baseRate * recovery * accel;
  return clamp(v - drop, 0, 100);
}

/** 随时间向基线回落，燃点冷却，积压缓慢消散 */
function decayMood(mood, char, nowMs = Date.now(), lastUpdateIso) {
  const m = normalizeMood(mood, char);
  const last = Date.parse(lastUpdateIso || m.lastSampleAt) || nowMs;
  const hours = Math.max(0, (nowMs - last) / 3600000);
  if (hours < 0.03) return m;

  const temper = deriveTemperament(char);
  const baseline = Number.isFinite(m.baseline) ? m.baseline : temper.baseline;
  const nowIso = new Date(nowMs).toISOString();
  const negMax = maxNegFuel(m.fuel);
  const calming = !flashpointStillHot(m, nowIso) && negMax < 42;
  const calmBoost = calming ? 1.45 : 1;
  // 还在被晾着：别把刚积的窝火/委屈先衰减没了
  const silenceHold = m.lastSilenceKind ? 0.28 : 1;

  // 效价：离基线越远，每小时拉回越快（趋向平静，而非永久偏负）
  const gap = m.valence - baseline;
  const valenceRate = (9 + Math.abs(gap) * 0.12) * temper.recovery * calmBoost;
  m.valence = clamp(m.valence - gap * clamp(hours * valenceRate / 100, 0, 0.92), -100, 100);

  // 唤醒度：白天回到日常；夜里往更低的精神走，累的时候才像没劲
  let arousalBase = 26;
  try {
    const tz = char?.timezone || 'Asia/Shanghai';
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false,
    }).format(new Date(nowMs)));
    if (hour >= 23 || hour < 7) arousalBase = 16;
  } catch {}
  m.arousal = clamp(
    m.arousal + (arousalBase - m.arousal) * clamp(hours * (7.5 * temper.recovery * calmBoost) / 100, 0, 0.88),
    12,
    100,
  );

  m.fuel.anger = decayFuelTowardZero(m.fuel.anger, hours, 5.8 * calmBoost * silenceHold, temper.recovery);
  // 委屈/低落回落更快；心情已近平静时再加一档，避免数值还顶着
  const nearCalm = Math.abs(m.valence) < 14 && !flashpointStillHot(m, nowIso);
  const stuckBoost = nearCalm && (m.fuel.hurt > 22 || m.fuel.low > 22) && !m.lastSilenceKind ? 1.7 : 1;
  m.fuel.hurt = decayFuelTowardZero(m.fuel.hurt, hours, 6.6 * calmBoost * stuckBoost * silenceHold, temper.recovery);
  m.fuel.low = decayFuelTowardZero(m.fuel.low, hours, 6.2 * calmBoost * stuckBoost * silenceHold, temper.recovery);
  m.fuel.desire = decayFuelTowardZero(m.fuel.desire, hours, 6.8 * calmBoost, temper.recovery);
  m.fuel.intimacy = clamp(m.fuel.intimacy - hours * (1.8 * temper.recovery), 0, 100);
  // 空窗：亲密还在时惦念压会涨；亲密掉了惦念也跟着塌
  const idleBoost = hours >= 1.5 && m.fuel.intimacy >= 26
    ? hours * (temper.closeRelationship ? 0.85 : 0.35) * temper.yearningGain
      * clamp(m.fuel.intimacy / 55, 0.3, 1)
    : 0;
  const yearningDecay = hours * (2.2 * temper.recovery);
  m.yearning = clampYearningToIntimacy(m.yearning - yearningDecay + idleBoost, m.fuel.intimacy);
  // 空窗略拱欲念：只在恋人/暧昧且已较久未聊时，且幅度很小
  if (idleBoost > 1 && temper.closeRelationship && m.fuel.intimacy >= 35 && hours >= 6) {
    m.fuel.desire = clamp(m.fuel.desire + hours * 0.04 * temper.desireGain, 0, 100);
  }

  if (m.flashpoint && cooledFlashpoint(m.flashpoint, new Date(nowMs).toISOString())) {
    if (hours >= 1.2) m.flashpoint = null;
  }

  m.primary = pickPrimary(m);
  m.label = softLabel(m);
  const quiet = Math.abs(m.valence - baseline) < 6
    && maxNegFuel(m.fuel) < 12
    && maxBondFuel(m) < 18;
  if (quiet) m.note = '';
  return m;
}

function appendEmotionLog(charId, mood, source = 'chat', summary = '', opts = {}) {
  if (!charId || !mood) return;
  try {
    const now = new Date().toISOString();
    const last = db.prepare(
      'SELECT ts, valence FROM emotion_logs WHERE character_id=? ORDER BY id DESC LIMIT 1'
    ).get(charId);
    const force = opts.force || ['flashpoint', 'dip', 'silence_unread', 'silence_read', 'rekindle'].includes(source);
    // 聊天轮次几乎都记；其它来源仍节流
    if (last && !force) {
      const dtMin = (Date.parse(now) - Date.parse(last.ts)) / 60000;
      const dV = Math.abs((Number(mood.valence) || 0) - (Number(last.valence) || 0));
      const isChat = source === 'chat_user' || source === 'chat_ai';
      if (isChat) {
        if (dtMin < 0.15 && dV < 0.4) return;
      } else if (dtMin < 2 && dV < 2.5) {
        return;
      }
    }
    let flashTag = mood.flashpoint?.type || '';
    if (opts.eventKind === 'dip') flashTag = flashTag || 'dip';
    if (opts.eventKind === 'rekindle') flashTag = flashTag || 'rekindle';
    const vals = [
      charId,
      now,
      round1(mood.valence),
      round1(mood.arousal),
      mood.primary || 'calm',
      mood.label || softLabel(mood),
      round1(mood.fuel?.anger || 0),
      round1(mood.fuel?.hurt || 0),
      round1(mood.fuel?.low || 0),
      round1(mood.yearning || 0),
      round1(mood.fuel?.desire || 0),
      round1(mood.fuel?.intimacy || 0),
      flashTag,
      source,
      String(summary || mood.note || '').slice(0, 120),
    ];
    try {
      db.prepare(`
        INSERT INTO emotion_logs
          (character_id, ts, valence, arousal, primary_tag, label,
           fuel_anger, fuel_hurt, fuel_low, fuel_longing, fuel_desire, fuel_intimacy,
           flashpoint, source, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...vals);
    } catch {
      db.prepare(`
        INSERT INTO emotion_logs
          (character_id, ts, valence, arousal, primary_tag, label, fuel_anger, fuel_hurt, fuel_low, flashpoint, source, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vals[0], vals[1], vals[2], vals[3], vals[4], vals[5],
        vals[6], vals[7], vals[8], vals[12], vals[13], vals[14],
      );
    }
    mood.lastSampleAt = now;
  } catch (e) {
    console.warn('[emotion] log', e.message);
  }
}

function syncCharacterMoodLabel(charId, mood) {
  if (!charId || !mood) return;
  try {
    const label = moodDisplayString(mood);
    db.prepare('UPDATE characters SET mood=? WHERE id=?').run(label, charId);
    try {
      const { push } = require('./push');
      push('character_update', { characterId: charId, mood: label });
    } catch {}
    // 心情映到绑定的小机脸（不覆盖当轮对话表情）
    try {
      require('./robot-helper').syncFaceFromCharacterMood(charId, mood);
    } catch {}
  } catch {}
}

/**
 * 每轮对话更新连续情绪。返回更新后的 mood。
 * state 为完整 emotion_state 对象（可含 phase）。
 */
function touchMoodFromMessage(charId, state, { role, content, char } = {}) {
  const row = char || db.prepare(
    'SELECT id, personality, emotion_style, behavior, background, mood, relationship, relationship_custom, intro, description FROM characters WHERE id=?'
  ).get(charId);
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  let nextState = state && typeof state === 'object' ? { ...state } : {};
  let mood = decayMood(nextState.mood, row, nowMs, nextState.lastUpdateAt || nextState.mood?.lastSampleAt);
  mood.baseline = deriveTemperament(row).baseline;

  let impact = scoreMessageImpact(content, role);
  impact = amplifyImpactForAfterglow(impact, nextState.phase, nextState.intensity);
  const temper = deriveTemperament(row);
  const silenceHeld = !!(mood.lastSilenceKind) && (
    (mood.fuel?.hurt || 0) >= 12
    || (mood.fuel?.low || 0) >= 12
    || (mood.yearning || 0) >= 20
    || (mood.fuel?.anger || 0) >= 12
  );
  // 被晾后回来：先别把积下来的心情冲平（含闲聊里那点委屈泄漏），这轮回复还要用
  if (role === 'user' && silenceHeld && impact) {
    const apology = /对不起|抱歉|我错了|别生气|消消气|原谅我|哄你/.test(String(content || ''));
    if (!apology) {
      impact = {
        ...impact,
        dV: (impact.dV || 0) > 0 ? (impact.dV || 0) * 0.18 : impact.dV,
        dA: (impact.dA || 0) < 0 ? (impact.dA || 0) * 0.2 : impact.dA,
        dAnger: Math.min(impact.dAnger || 0, 0) * 0.12,
        dHurt: Math.min(impact.dHurt || 0, 0) * 0.12,
        dLow: Math.min(impact.dLow || 0, 0) * 0.12,
        dYearning: Math.min(0, impact.dYearning || 0) * 0.2,
      };
    }
  }
  const { mood: applied, flashed, dipped, rekindle } = applyImpact(mood, impact, temper, nowIso);
  mood = applied;

  // 冲突态：只有这轮确实在拱火，才微抬火气；闲聊不再越聊越怒
  if (nextState.phase === 'open' && (impact?.dAnger || 0) > 0) {
    mood.fuel.anger = clamp(mood.fuel.anger + 1.2, 0, 100);
    mood.arousal = clamp(mood.arousal + 2, 0, 100);
    mood.fuel.intimacy = clamp(mood.fuel.intimacy - 1, 0, 100);
  }

  // 用户主动说话：当面接住，亲密上的惦念压略回落。刚被晾过的第一句只松一点。
  if (role === 'user' && !impact?.soft && !silenceHeld) {
    mood.yearning = clampYearningToIntimacy(mood.yearning - 3.5 * temper.recovery, mood.fuel.intimacy);
  } else if (role === 'user' && silenceHeld) {
    mood.yearning = clampYearningToIntimacy(mood.yearning - 0.8 * temper.recovery, mood.fuel.intimacy);
    mood.silenceHeardUser = true;
  }
  // 角色自己追问/抱怨时不要清「被晾」——否则用户一开口就像没事。
  // 用户回来并被接住一轮之后，再清，避免后面每句都在演被晾。
  if (role === 'assistant' && mood.lastSilenceKind && mood.silenceHeardUser) {
    mood.lastSilenceKind = null;
    mood.silenceHeardUser = false;
  }

  // 余温再起：residual 被戳 → 可回到 open（强度从余韵抬起，不是满格炸）
  let didRekindle = false;
  if (rekindle && nextState.phase === 'residual') {
    const prevI = Number(nextState.intensity) || 32;
    nextState.phase = 'open';
    nextState.kind = nextState.kind || 'conflict';
    nextState.intensity = Math.min(88, Math.max(prevI, 42) + 10);
    nextState.resolvedAt = null;
    nextState.summary = nextState.summary || mood.note || '余温再起';
    mood.note = mood.note || '余温被再次拱起来了';
    didRekindle = true;
  }

  nextState.mood = mood;
  nextState.lastUpdateAt = nowIso;
  if (!nextState.startedAt) nextState.startedAt = nowIso;

  let source = role === 'user' ? 'chat_user' : 'chat_ai';
  let eventKind = '';
  if (flashed) {
    source = 'flashpoint';
    eventKind = 'flashpoint';
  } else if (didRekindle) {
    source = 'rekindle';
    eventKind = 'rekindle';
  } else if (dipped) {
    source = 'dip';
    eventKind = 'dip';
  }
  appendEmotionLog(charId, mood, source, mood.note, { force: true, eventKind });
  syncCharacterMoodLabel(charId, mood);
  syncDriveFromMoodLonging(charId, mood);

  return { state: nextState, mood, flashed, dipped, rekindle: didRekindle };
}

/** 日程结束并生成回顾后，把明确的愉快/抗拒/烦躁/疲惫等写回连续心情。 */
function touchMoodFromSchedule(charId, { activity, review, char } = {}) {
  if (!charId) return null;
  const row = char || db.prepare(
    'SELECT id, personality, emotion_style, behavior, background, mood, emotion_state, relationship, relationship_custom, intro, description FROM characters WHERE id=?'
  ).get(charId);
  if (!row) return null;
  const impact = scoreScheduleImpact(activity, review);
  if (!impact) return null;

  let state = {};
  try {
    state = row.emotion_state
      ? (typeof row.emotion_state === 'object' ? row.emotion_state : JSON.parse(String(row.emotion_state)))
      : {};
  } catch {
    state = {};
  }
  const nowIso = new Date().toISOString();
  let mood = decayMood(state.mood, row, Date.now(), state.lastUpdateAt || state.mood?.lastSampleAt);
  const applied = applyImpact(mood, impact, deriveTemperament(row), nowIso);
  mood = applied.mood;
  state = { ...state, mood, lastUpdateAt: nowIso };
  if (!state.startedAt) state.startedAt = nowIso;

  appendEmotionLog(
    charId,
    mood,
    applied.flashed ? 'flashpoint' : 'schedule',
    mood.note,
    { force: true, eventKind: applied.flashed ? 'flashpoint' : 'schedule' },
  );
  db.prepare('UPDATE characters SET emotion_state=? WHERE id=?').run(JSON.stringify(state), charId);
  syncCharacterMoodLabel(charId, mood);
  syncDriveFromMoodLonging(charId, mood);
  return { state, mood, flashed: applied.flashed, dipped: applied.dipped };
}

/** 把亲密上的惦念压轻度同步到桌宠 drive.longing */
function syncDriveFromMoodLonging(charId, mood) {
  if (!charId || !mood) return;
  try {
    const driveHelper = require('./robot-drive-helper');
    const drive = driveHelper.getInnerDrive({ id: charId });
    const target = Number(mood.yearning) || 0;
    const blended = drive.longing * 0.65 + target * 0.35;
    if (Math.abs(blended - drive.longing) < 1.5) return;
    drive.longing = clamp(blended, 0, 100);
    driveHelper.saveInnerDrive(charId, drive);
  } catch {}
}

/** 未读 / 已读未回：按人设决定敏感度与情绪走向 */
function scoreSilenceImpact(kind, idleMinutes, char) {
  const temper = deriveTemperament(char);
  const blob = `${char?.personality || ''} ${char?.emotion_style || ''} ${char?.behavior || ''}`;
  const has = (re) => re.test(blob);
  let sens = 1;
  if (has(/粘人|黏人|依恋|缺爱|安全感差|容易不安|多虑|恋爱脑|深情/)) sens += 0.55;
  if (has(/淡漠|佛系|钝感|理性|冷淡|高冷/)) sens -= 0.45;
  if (has(/要面子|倔强|记仇|易怒|暴躁/)) sens += 0.2;
  if (has(/好哄|心软|乐观|开朗|温柔|柔和|体贴/)) sens -= 0.15;
  sens = clamp(sens, 0.25, 1.9);

  const hours = idleMinutes / 60;
  // 未读：更偏担心/低落；已读未回 / 人在刷手机：更偏委屈/窝火（看人设）
  const unread = kind === 'unread';
  const phoneIgnore = kind === 'phone_ignore';
  const scale = clamp(Math.log10(1 + hours * 2) * (phoneIgnore ? 9 : 8), 2.2, 20) * sens;

  let dV = -scale * (unread ? 0.55 : 0.75);
  let dA = unread ? scale * 0.25 : scale * 0.45;
  let dAnger = 0;
  let dHurt = 0;
  let dLow = 0;
  let dYearning = scale * (temper.closeRelationship ? 0.7 : 0.35);
  let dDesire = temper.closeRelationship ? scale * 0.12 : 0;
  let dIntimacy = -scale * 0.15;
  let note = '';

  if (unread) {
    dLow += scale * 0.55;
    dHurt += scale * 0.25;
    dYearning += scale * 0.35;
    if (has(/粘人|黏人|缺爱|安全感|恋爱脑|深情/)) {
      dHurt += scale * 0.35;
      dLow += scale * 0.2;
      dYearning += scale * 0.4;
      note = '主动消息一直未读，心里发空又惦记';
    } else if (has(/淡漠|佛系|钝感/)) {
      dV *= 0.35;
      dLow *= 0.4;
      dYearning *= 0.35;
      note = '未读也还好，没太放在心上';
    } else {
      note = '消息还没人看，心情悄悄沉了点，也有点惦念';
    }
  } else {
    // 已读未回 / 人在刷手机没理
    const sting = phoneIgnore ? 1.25 : 1;
    if (has(/易怒|暴躁|要面子|倔强|记仇/)) {
      dAnger += scale * 0.7 * sting;
      dHurt += scale * 0.35 * sting;
      dYearning += scale * 0.2;
      note = phoneIgnore
        ? '人就在手机上却不理你，火气和面子都挂着'
        : '明明已读却不回，火气和面子都挂着';
    } else if (has(/粘人|黏人|缺爱|安全感|敏感|玻璃心|恋爱脑/)) {
      dHurt += scale * 0.75 * sting;
      dLow += scale * 0.4;
      dAnger += scale * 0.28 * sting;
      dYearning += scale * 0.45;
      note = phoneIgnore
        ? '看着对方在刷手机不理你，委屈和窝火往上冒'
        : '已读未回，委屈和惦念往上冒';
    } else if (has(/淡漠|佛系|钝感|理性/)) {
      dV *= 0.4;
      dHurt += scale * 0.2 * sting;
      dAnger += scale * 0.12;
      dYearning *= 0.4;
      note = phoneIgnore
        ? '对方在刷手机，略有察觉但不深究'
        : '已读未回，略有察觉但不深究';
    } else {
      dHurt += scale * 0.5 * sting;
      dAnger += scale * 0.38 * sting;
      dLow += scale * 0.2;
      dYearning += scale * 0.25;
      note = phoneIgnore
        ? '人就在手机上却不回你，心里不是滋味，也有点窝火'
        : '已读未回，心里有点不是滋味';
    }
    if (temper.closeRelationship && !has(/淡漠|佛系|钝感/)) {
      dHurt += scale * 0.22;
      dAnger += scale * 0.18;
      dYearning = Math.min(dYearning, scale * 0.45);
    }
  }

  return {
    dV, dA, dAnger, dHurt, dLow, dYearning, dDesire, dIntimacy,
    note,
    soft: scale < 3.5,
    silenceKind: kind,
  };
}

/**
 * 定时检视沉默：主动消息未读 / 已读未回 → 按人设改心情。
 * 节流存在 mood.lastSilenceAt / lastSilenceKind。
 */
function applySilenceMoodTick(charId, charRow = null) {
  if (!charId) return null;
  const char = charRow || db.prepare(
    'SELECT id, personality, emotion_style, behavior, background, mood, emotion_state, relationship, relationship_custom, intro, description FROM characters WHERE id=?'
  ).get(charId);
  if (!char) return null;

  const lastAi = db.prepare(`
    SELECT id, content, timestamp, is_read FROM messages
    WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='assistant'
      AND type NOT IN ('system')
    ORDER BY id DESC LIMIT 1
  `).get(charId);
  if (!lastAi) return null;

  const lastUserAfter = db.prepare(`
    SELECT id FROM messages
    WHERE character_id=? AND is_dream=0 AND recalled=0 AND role='user'
      AND type NOT IN ('system') AND id>?
    ORDER BY id ASC LIMIT 1
  `).get(charId, lastAi.id);
  if (lastUserAfter) return null; // 已有回复，不算沉默

  const idleMinutes = Math.max(0, (Date.now() - Date.parse(lastAi.timestamp)) / 60000);
  if (idleMinutes < 25) return null; // 太短不计入

  let phoneIgnore = false;
  try { phoneIgnore = !!require('./phone-llm-tools').userAwayFromNian(); } catch {}
  const read = lastAi.is_read === 1 || lastAi.is_read === true || phoneIgnore;
  const kind = phoneIgnore ? 'phone_ignore' : (read ? 'read_no_reply' : 'unread');
  // 未读至少约 40 分钟；已读未回 / 人在刷手机约 25 分钟起算
  if (!read && idleMinutes < 40) return null;

  let state = null;
  try {
    const raw = char.emotion_state;
    state = raw ? (typeof raw === 'object' ? raw : JSON.parse(String(raw))) : {};
  } catch {
    state = {};
  }
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let mood = decayMood(state.mood, char, nowMs, state.lastUpdateAt || state.mood?.lastSampleAt);

  const lastSilenceAt = Date.parse(mood.lastSilenceAt) || 0;
  const gapMin = (nowMs - lastSilenceAt) / 60000;
  // 同一种沉默至少隔 45 分钟再叠一层，避免刷屏抬情绪
  if (mood.lastSilenceKind === kind && gapMin < 45) return null;
  if (gapMin < 20) return null;

  const impact = scoreSilenceImpact(kind, idleMinutes, char);
  const temper = deriveTemperament(char);
  const amplified = amplifyImpactForAfterglow(impact, state.phase, state.intensity);
  const { mood: applied, flashed, dipped } = applyImpact(mood, amplified, temper, nowIso);
  mood = applied;
  mood.lastSilenceAt = nowIso;
  mood.lastSilenceKind = kind;

  state.mood = mood;
  state.lastUpdateAt = nowIso;
  if (!state.startedAt) state.startedAt = nowIso;

  if (flashed && state.phase !== 'open' && ['anger', 'hurt', 'breakdown'].includes(flashed.type)) {
    state.phase = 'open';
    state.kind = flashed.type === 'anger' ? 'conflict' : 'hurt';
    state.intensity = Math.max(Number(state.intensity) || 0, flashed.type === 'anger' ? 58 : 48);
    state.summary = mood.note || '沉默里积出来的情绪';
    state.resolvedAt = null;
  }

  const source = kind === 'unread' ? 'silence_unread' : (kind === 'phone_ignore' ? 'silence_phone' : 'silence_read');
  appendEmotionLog(charId, mood, flashed ? 'flashpoint' : (dipped ? 'dip' : source), mood.note, {
    force: true,
    eventKind: flashed ? 'flashpoint' : (dipped ? 'dip' : 'silence'),
  });
  syncCharacterMoodLabel(charId, mood);
  syncDriveFromMoodLonging(charId, mood);
  db.prepare('UPDATE characters SET emotion_state=? WHERE id=?').run(JSON.stringify(state), charId);
  return { state, mood, kind, idleMinutes };
}

/** 全角色：时间衰减采样 + 沉默情绪 */
function tickAllCharacterEmotions() {
  let chars = [];
  try {
    chars = db.prepare('SELECT id, personality, emotion_style, behavior, background, mood, emotion_state, relationship, relationship_custom, intro, description FROM characters').all() || [];
  } catch {
    return { sampled: 0, silence: 0 };
  }
  let sampled = 0;
  let silence = 0;
  for (const char of chars) {
    try {
      let state = null;
      try {
        state = char.emotion_state
          ? (typeof char.emotion_state === 'object' ? char.emotion_state : JSON.parse(String(char.emotion_state)))
          : null;
      } catch {
        state = null;
      }
      if (state?.mood) {
        state = ensureDecayedMood(char, state);
        const before = state.mood.lastSampleAt;
        state = sampleMoodIfStale(char.id, state, char);
        if (state.mood.lastSampleAt !== before) {
          db.prepare('UPDATE characters SET emotion_state=? WHERE id=?').run(JSON.stringify(state), char.id);
          sampled += 1;
        } else {
          db.prepare('UPDATE characters SET emotion_state=? WHERE id=?').run(JSON.stringify(state), char.id);
        }
        try {
          require('./robot-helper').syncFaceFromCharacterMood(char.id, state.mood, { char });
        } catch {}
      }
      const sil = applySilenceMoodTick(char.id, char);
      if (sil) silence += 1;
    } catch (e) {
      console.warn('[emotion] tick char', char.id, e.message);
    }
  }
  return { sampled, silence };
}

/** 仅时间衰减（读 API / 进提示词时） */
function ensureDecayedMood(char, state) {
  const nowMs = Date.now();
  let next = state && typeof state === 'object' ? { ...state } : {};
  const mood = decayMood(next.mood, char, nowMs, next.lastUpdateAt || next.mood?.lastSampleAt);
  next.mood = mood;
  return next;
}

/** 读情绪页时：超过约 15 分钟补一个时间点，让折线能随时间走动 */
function sampleMoodIfStale(charId, state, char) {
  if (!charId || !state?.mood) return state;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const lastSample = Date.parse(state.mood.lastSampleAt) || 0;
  if (lastSample && nowMs - lastSample <= 15 * 60000) return state;
  const next = { ...state, mood: { ...state.mood }, lastUpdateAt: nowIso };
  appendEmotionLog(charId, next.mood, 'time', '随时间缓下来');
  return next;
}

function decorateEmotionHistory(rows) {
  return (rows || []).map((row) => ({
    ...row,
    felt: feltValenceFromRow(row),
  }));
}

function getEmotionHistory(charId, { hours = 48, limit = 120 } = {}) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  try {
    return decorateEmotionHistory(db.prepare(`
      SELECT id, ts, valence, arousal, primary_tag, label,
             fuel_anger, fuel_hurt, fuel_low, fuel_longing, fuel_desire, fuel_intimacy,
             flashpoint, source, summary
      FROM emotion_logs
      WHERE character_id=? AND ts>=?
      ORDER BY ts ASC
      LIMIT ?
    `).all(charId, since, limit));
  } catch {
    // 旧库尚未迁移新列时回退
    try {
      return decorateEmotionHistory(db.prepare(`
        SELECT id, ts, valence, arousal, primary_tag, label, fuel_anger, fuel_hurt, fuel_low, flashpoint, source, summary
        FROM emotion_logs
        WHERE character_id=? AND ts>=?
        ORDER BY ts ASC
        LIMIT ?
      `).all(charId, since, limit));
    } catch {
      return [];
    }
  }
}

const EVENT_TITLES = {
  anger: '怒意燃点',
  hurt: '委屈破防',
  breakdown: '低落垮塌',
  longing: '思念燃点',
  desire: '欲望燃点',
  intimacy: '亲近涌起',
  dip: '情绪骤降',
  rise: '情绪上扬',
  rekindle: '余温再起',
  silence_unread: '未读积压',
  silence_read: '已读未回',
  phone_ignore: '刷手机没理',
};

/** 面板曲线用的「体感心情」：效价再叠火气/委屈/低落，避免燃料已经动了线还贴着平静 */
function feltValenceFromRow(row = {}) {
  const v = Number(row.valence) || 0;
  const anger = Number(row.fuel_anger) || 0;
  const hurt = Number(row.fuel_hurt) || 0;
  const low = Number(row.fuel_low) || 0;
  const yearning = Number(row.fuel_longing ?? row.yearning) || 0;
  return round1(clamp(
    v
    - anger * 0.34
    - hurt * 0.30
    - low * 0.22
    - Math.max(0, yearning - 38) * 0.10,
    -100,
    100,
  ));
}

/** 从一条日志推负面/正面坐标（0–100） */
function moodAxesFromRow(row) {
  const v = Number(row.valence) || 0;
  const anger = Number(row.fuel_anger) || 0;
  const hurt = Number(row.fuel_hurt) || 0;
  const low = Number(row.fuel_low) || 0;
  const intimacy = Number(row.fuel_intimacy) || 0;
  const desire = Number(row.fuel_desire) || 0;
  const peakNeg = Math.max(anger, hurt, low);
  const avgNeg = (anger + hurt + low) / 3;
  const valenceNeg = Math.max(0, -v);
  const neg = clamp(peakNeg * 0.55 + avgNeg * 0.30 + valenceNeg * 0.15, 0, 100);
  const pos = clamp(Math.max(Math.max(0, v), intimacy * 0.55 + desire * 0.2), 0, 100);
  return { neg: round1(neg), pos: round1(pos) };
}

function describeEvent(row, { swing = null } = {}) {
  const fp = String(row.flashpoint || '');
  const src = String(row.source || '');
  let type = null;
  if (['anger', 'hurt', 'breakdown', 'longing', 'desire', 'intimacy'].includes(fp)) type = fp;
  else if (fp === 'rekindle' || src === 'rekindle') type = 'rekindle';
  else if (fp === 'dip' || src === 'dip') type = 'dip';
    else if (src === 'silence_unread') type = 'silence_unread';
    else if (src === 'silence_read') type = 'silence_read';
    else if (src === 'silence_phone' || fp === 'phone_ignore') type = 'phone_ignore';
  else if (swing === 'dip') type = 'dip';
  else if (swing === 'rise') type = 'rise';
  else {
    return null;
  }

  const title = EVENT_TITLES[type] || '情绪波动';
  const when = formatLocalDateTime(row.ts);
  const axes = moodAxesFromRow(row);
  const reason = String(row.summary || '').trim() || buildEventDetailText(type, row);
  const primaryTag = String(row.primary_tag || '').trim();
  const labelEn = PRIMARY_LABELS[primaryTag]
    ? primaryTag
    : promptSafeMoodLabel({ label: row.label || primaryTag });
  return {
    id: row.id,
    ts: row.ts,
    type,
    title,
    when,
    label: MOOD_EMOJI[labelEn] || moodTagsToEmoji([labelEn]),
    labelId: labelEn,
    summary: row.summary || '',
    reason,
    valence: round1(row.valence),
    felt: feltValenceFromRow(row),
    neg: axes.neg,
    pos: axes.pos,
    primary: row.primary_tag || '',
    fuel: {
      anger: Math.round(Number(row.fuel_anger) || 0),
      hurt: Math.round(Number(row.fuel_hurt) || 0),
      low: Math.round(Number(row.fuel_low) || 0),
      desire: Math.round(Number(row.fuel_desire) || 0),
      intimacy: Math.round(Number(row.fuel_intimacy) || 0),
    },
    yearning: Math.round(Number(row.fuel_longing) || 0),
    source: src,
    detail: reason,
  };
}

function buildEventDetailText(type, row) {
  const note = String(row.summary || '').trim();
  const label = String(row.label || '').trim();
  if (type === 'anger') {
    return note || `火气积到燃点，情绪标签变成「${label || '生气'}」。之后余温还会在，再被戳可能继续起伏。`;
  }
  if (type === 'hurt') {
    return note || `委屈积压破防，心情落到「${label || '委屈'}」。缓和需要时间，也会被一句话重新拱起来。`;
  }
  if (type === 'breakdown') {
    return note || `低落积压垮了一截，呈现「${label || '有点低落'}」。不是瞬间没事，会慢慢回，也会再沉。`;
  }
  if (type === 'longing') {
    return note || `亲密里的惦念压到燃点，呈现「${label || '思念'}」。会渗进语气；被接住后才会慢慢松，亲密本身不会瞬间归零。`;
  }
  if (type === 'desire') {
    return note || `欲念积压到燃点，呈现「${label || '欲念'}」。可以按人设渗进语气，或主动暗示/带一句亲密；不是立刻失控，也不是只能等对方先提。`;
  }
  if (type === 'intimacy') {
    return note || `亲近感一下子涌上来，呈现「${label || '亲近'}」。语气可更软或更黏，但仍看性格，不是统一撒娇。`;
  }
  if (type === 'rekindle') {
    return note || '本来冲突余温在往下走，又被对话戳到，情绪重新拱起来了。';
  }
  if (type === 'silence_unread') {
    return note || '主动消息一直未读：按人设可能发空、惦念、不安或几乎不在意，曲线已跟着动。';
  }
  if (type === 'silence_read') {
    return note || '消息已读却未回：按人设可能委屈、微怒、惦念或淡淡带过，曲线已跟着动。';
  }
  if (type === 'phone_ignore') {
    return note || '人在刷手机却不理：按人设可能窝火、委屈、空落或懒得给好脸色，不是只有惦念。';
  }
  if (type === 'rise') {
    return note || `心情明显抬升到「${label || '偏暖'}」附近。`;
  }
  return note || `心情明显沉到「${label || '低落'}」附近。`;
}

/** 显著起伏阈值：落差/上升够大才记点，避免挤成一堆 */
const SWING_THRESHOLD = 14;

function getEmotionEvents(charId, { hours = 168, limit = 24 } = {}) {
  const history = getEmotionHistory(charId, { hours, limit: 240 });
  const events = [];
  const seen = new Set();

  const pushEv = (ev) => {
    if (!ev || seen.has(ev.id)) return;
    seen.add(ev.id);
    events.push(ev);
  };

  // 明确燃点 / 垮塌 / 余温再起
  for (const row of history) {
    const fp = String(row.flashpoint || '');
    const src = String(row.source || '');
    const isFlash = ['anger', 'hurt', 'breakdown', 'longing', 'desire', 'intimacy'].includes(fp)
      || src === 'flashpoint'
      || src === 'rekindle'
      || fp === 'rekindle';
    if (!isFlash) continue;
    pushEv(describeEvent(row));
  }

  // 相对前一点：大幅下落或大幅上扬（含沉默导致的大跳）
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const cur = history[i];
    if (seen.has(cur.id)) continue;
    const delta = feltValenceFromRow(cur) - feltValenceFromRow(prev);
    if (Math.abs(delta) < SWING_THRESHOLD) continue;
    const swing = delta < 0 ? 'dip' : 'rise';
    const summary = String(cur.summary || '').trim()
      || (swing === 'dip' ? '这一段心情明显往下沉了' : '这一段心情明显抬了起来');
    const fake = { ...cur, flashpoint: swing === 'dip' ? (cur.flashpoint || 'dip') : (cur.flashpoint || ''), source: cur.source || swing, summary };
    pushEv(describeEvent(fake, { swing }));
  }

  // 时间上太近的点合并：保留 |valence| 更大的
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const deduped = [];
  for (const ev of events) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(Date.parse(ev.ts) - Date.parse(last.ts)) < 12 * 60000) {
      const lastMag = Math.abs(Number(last.valence) || 0);
      const curMag = Math.abs(Number(ev.valence) || 0);
      if (curMag >= lastMag) deduped[deduped.length - 1] = ev;
      continue;
    }
    deduped.push(ev);
  }
  deduped.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return deduped.slice(0, limit);
}

function getEmotionTz() {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key='timezone'`).get();
    return String(row?.value || 'Asia/Shanghai');
  } catch {
    return 'Asia/Shanghai';
  }
}

/** 情绪日志存 UTC，展示必须换成本地时区，否则起伏时间会偏 8 小时 */
function formatLocalDateTime(iso, tz = getEmotionTz()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const g = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
  } catch {
    return String(iso || '').slice(0, 16).replace('T', ' ');
  }
}

function publicMoodView(mood, char) {
  const m = normalizeMood(mood, char);
  const temper = deriveTemperament(char);
  const negMax = maxNegFuel(m.fuel);
  const bondMax = maxBondFuel(m);
  const maxFuel = Math.max(negMax, bondMax);
  // 「开心」是当前正向心情的直观读数，不另存一份会与 valence 漂移的燃料。
  // 亲近感只在心情本身不负向时提供少量暖意，避免高亲密掩盖生气/委屈。
  const joy = clamp(
    Math.max(0, m.valence) + (m.valence >= 0 ? m.fuel.intimacy * 0.12 : 0),
    0,
    100,
  );
  const warm = clamp(
    m.valence >= 6 && m.arousal < 58
      ? Math.max(0, m.valence) * 1.15 + (m.fuel.intimacy * 0.08)
      : Math.max(0, m.valence) * 0.35,
    0,
    100,
  );
  const anxious = clamp(
    m.valence <= 8
      ? (m.arousal - 26) * 0.85 + Math.max(0, -m.valence) * 0.4
      : (m.arousal - 55) * 0.4,
    0,
    100,
  );
  const tired = clamp(
    (38 - m.arousal) * 1.4 + (m.fuel.low * 0.18),
    0,
    100,
  );
  const hot = flashpointStillHot(m);
  let buildup = 'steady';
  if (hot && m.flashpoint) buildup = 'flash';
  else if (maxFuel >= 65) buildup = 'near_flash';
  else if (maxFuel >= 40) buildup = 'building';
  else if (maxFuel >= 18) buildup = 'mild';

  const tags = topMoodTags(m, 3);
  const primary = softLabel(m);
  return {
    label: PRIMARY_LABELS[primary] || primary,
    primary,
    tags,
    emoji: moodTagsToEmoji(tags),
    display: moodDisplayString(m),
    note: m.note || '',
    buildup,
    flashpoint: hot && m.flashpoint
      ? { type: m.flashpoint.type, at: m.flashpoint.at, note: m.flashpoint.note || '' }
      : null,
    valence: round1(m.valence),
    arousal: round1(m.arousal),
    baseline: round1(m.baseline),
    joy: Math.round(joy),
    warm: Math.round(warm),
    anxious: Math.round(anxious),
    tired: Math.round(tired),
    fuel: {
      anger: Math.round(m.fuel.anger),
      hurt: Math.round(m.fuel.hurt),
      low: Math.round(m.fuel.low),
      desire: Math.round(m.fuel.desire),
      intimacy: Math.round(m.fuel.intimacy),
    },
    yearning: Math.round(m.yearning || 0),
    thresholds: {
      anger: Math.round(temper.angerThreshold),
      hurt: Math.round(temper.hurtThreshold),
      low: Math.round(temper.lowThreshold),
      desire: Math.round(temper.desireThreshold),
      intimacy: Math.round(temper.intimacyThreshold),
      yearning: Math.round(temper.yearningThreshold),
    },
  };
}

/** 注入 prompt：英文 mood id，禁止中文花词复读 */
function promptSafeMoodLabel(view = {}) {
  const primary = String(view.primary || view.label || 'calm').trim();
  if (PRIMARY_LABELS[primary]) return primary;
  const raw = primary;
  if (/怒|火气|生气|angry|hostile/i.test(raw)) return 'angry';
  if (/委屈|破防|hurt/i.test(raw)) return 'hurt';
  if (/低落|沉|low|breakdown/i.test(raw)) return 'low';
  if (/欲念|欲望|desire/i.test(raw)) return 'desire';
  if (/思念|惦念|longing/i.test(raw)) return 'longing';
  if (/亲近|intimate/i.test(raw)) return 'intimate';
  if (/开心|happy/i.test(raw)) return 'happy';
  if (/暖|warm/i.test(raw)) return 'warm';
  if (/忐忑|anxious/i.test(raw)) return 'anxious';
  if (/疲惫|tired/i.test(raw)) return 'tired';
  if (/兴奋|excited/i.test(raw)) return 'excited';
  if (/别扭|bitter/i.test(raw)) return 'bitter';
  if (/孤单|lonely/i.test(raw)) return 'lonely';
  return 'calm';
}

/** 人设软硬：用于口吻/心情块门控——禁的是 AI 客服接情绪，不是角色自己的温柔 */
const SOFT_PERSONA_RE = /温柔|柔和|温和|细腻|体贴|软萌|好说话|好脾气|暖心|会哄|照顾人|亲切|柔情|心软|共情|好哄/;
const SHARP_PERSONA_RE = /毒舌|损人|爱损|冷淡|高冷|暴躁|火爆|刻薄|刺|嘴贱|阴阳|呛人|凶巴巴/;

function characterToneProfile(char = {}) {
  const blob = `${char.personality || ''} ${char.emotion_style || ''} ${char.behavior || ''} ${char.language_style || ''} ${char.intro || ''}`;
  const soft = SOFT_PERSONA_RE.test(blob);
  const sharp = SHARP_PERSONA_RE.test(blob);
  return { soft, sharp, blob };
}

function buildReplyToneBlock(char, state, opts = {}) {
  if (!char) return '';
  const hasExamples = char.language_style && char.language_style.length > 50;
  const tone = characterToneProfile(char);
  const softHint = tone.soft
    ? '人设偏温柔/软：可以轻声、给人留台阶、话软一点——但必须是你这个人的温柔，不是客服腔。'
    : tone.sharp
      ? '人设偏冲/淡：可以别扭、淡、损、懒得给好脸色。'
      : '可以别扭、淡、损、懒得给好脸色，也可以轻声软一点——看【性格】。';
  const lines = [
    `【心里已经有的】这是你现在自己的心情，会渗进这轮怎么说。按【性格】带出来：${softHint}也可以压着不说。不要报心情，不要切成心理咨询/万能陪伴式安抚，也不要因为对方开口就瞬间没事。${hasExamples ? '语感仍是你的，别照抄例句。' : ''}`,
  ];

  const userMsg = String(opts.userMessage || '').trim();
  const inferred = inferUserEmotionFromMessage(userMsg);
  const sensed = String(opts.userEmotion || '').trim();

  if (!state?.mood) {
    lines.push('没有积着的心情：正常接这轮，不要硬演情绪。');
    return lines.join('\n');
  }

  const m = normalizeMood(state.mood, char);
  const view = publicMoodView(m, char);
  const draining = /加班|熬夜|通宵|夜班|值班|开会|通勤|赶路|上班|训练|赶稿|备课|很累|疲惫/.test(String(opts.activity || ''));
  const lowEnergy = view.tired >= 26 || view.primary === 'tired' || view.arousal <= 28 || draining;
  const silenceHeld = !!(m.lastSilenceKind) && (
    (view.fuel?.hurt || 0) >= 12
    || (view.fuel?.low || 0) >= 12
    || (view.yearning || 0) >= 20
    || (view.fuel?.anger || 0) >= 12
  );
  const longReturn = Number(opts.userReturnMinutes) >= 25;
  const lingeringIgnore = silenceHeld || (longReturn && (
    (view.fuel?.hurt || 0) >= 10
    || (view.fuel?.anger || 0) >= 10
    || (view.yearning || 0) >= 18
  ));
  const phoneTalk = /屏幕|手机|电量|心率|充电|闹钟|通知|数据线/.test(userMsg);
  const mundane = (!lingeringIgnore && !!opts.mundane)
    || (!lingeringIgnore && phoneTalk);

  if (!mundane && inferred && inferred.tone !== 'brief' && inferred.tone !== 'curious') {
    const id = promptSafeMoodLabel({ primary: inferred.tone || inferred.label, label: inferred.label });
    if (id !== 'angry' || /我生气了|气死我了|火大了|烦死了|恨你|讨厌你/.test(userMsg)) {
      lines.push(`对方这轮偏 ${id}，接的时候要看见，但你自己的反应仍按性格，不要跟着演同一种。`);
      lines.push(tone.soft
        ? '对方情绪不好：用你自己的温柔短接一下就好（可以轻声、可以先顺着说一句），禁止滑成「我理解你的感受」「你的情绪是被允许的」「有什么都可以跟我说」这类 AI 接情绪。'
        : '对方情绪不好：用你这个人会有的反应接（可以损一句再问、可以别扭地递台阶、也可以淡一句），禁止突然切成心理咨询/万能陪伴腔。');
    }
  } else if (!mundane && sensed && sensed !== 'neutral' && sensed !== 'angry') {
    lines.push(`对方这轮偏 ${sensed}，接的时候要看见，反应按性格。`);
    if (/sad|hurt|anxious|lonely|低落|难过|委屈|不安|孤单/.test(sensed)) {
      lines.push(tone.soft
        ? '看见对方的情绪，用你自己的温柔接；禁止 AI 客服式安抚话术。'
        : '看见对方的情绪，用性格接；禁止切成万能陪伴/心理咨询腔。');
    }
  }

  if (lowEnergy) lines.push('身子或脑子发沉，没多少精神。');
  if (lingeringIgnore) {
    const waited = m.lastSilenceKind === 'phone_ignore'
      ? '你知道对方在刷手机，却隔了很久才理你'
      : m.lastSilenceKind === 'read_no_reply'
        ? '对方看过，却隔了很久才回来'
        : '对方隔了很久才理你';
    lines.push(`${waited}。这已经进你自己的心情，不是一条任务。爱也会委屈、别扭、窝火、空落或懒得给好脸色——看【性格】，对方开口不会自动翻篇。`);
    const um = userMsg.replace(/\s+/g, '');
    if (/晚安|好梦|睡了|去睡|先睡/.test(um) && um.length <= 28) {
      lines.push('对方晾了很久才回，话又极短。这点不对劲已经进心里了。');
    }
  }

  const primary = view.primary || 'calm';
  const anger = view.fuel?.anger || 0;
  const hurt = view.fuel?.hurt || 0;
  const low = view.fuel?.low || 0;
  const yearning = view.yearning || 0;

  if (primary === 'angry' || anger >= 22) {
    if (!(mundane && anger < 58 && !lingeringIgnore)) lines.push('火气还在。怎么带出来是你这个人的脾气。');
  } else if (primary === 'bitter' || (anger >= 14 && hurt >= 14)) {
    lines.push('心里别扭着，没那么快顺。');
  } else if (primary === 'hurt' || hurt >= 22) {
    lines.push('还有委屈，没过去。');
  } else if (primary === 'lonely' || primary === 'anxious') {
    lines.push(primary === 'anxious' ? '心里不安。' : '有点空落。');
  } else if (!lingeringIgnore && (primary === 'low' || low >= 32)) {
    lines.push('心里发空，提不太起劲。');
  } else if (lingeringIgnore && (primary === 'longing' || yearning >= 36) && anger < 22 && hurt < 22) {
    lines.push('惦念和别扭叠着。别把惦念说成去会合。');
  } else if (!lingeringIgnore && (primary === 'longing' || yearning >= 48)) {
    lines.push('心里惦着对方。别把惦念说成去会合。');
  } else if (!lowEnergy && !lingeringIgnore && (primary === 'happy' || primary === 'excited' || primary === 'warm')) {
    lines.push('心里松一点。');
  } else if (!lowEnergy && !lingeringIgnore && primary === 'desire') {
    lines.push('欲念在压着。说不说、怎么说按性格来——不必等对方先开黄腔。想贴在一起可邀小剧场，不要说回来就能见到。');
  } else if (!lowEnergy && !lingeringIgnore && (Number(view.fuel?.desire) || 0) >= 52) {
    lines.push('心里有点想要。带不带出来看性格；想亲近可邀小剧场。');
  } else if (!lowEnergy && !lingeringIgnore && primary === 'calm') {
    lines.push('心里没什么特别压着的。');
  }

  return lines.join('\n');
}

/** 注入 system prompt：英文心情 id（只反映，不指挥表演） */
function buildMoodPromptBlock(char, state) {
  if (!state?.mood) return '';
  const m = normalizeMood(state.mood, char);
  const view = publicMoodView(m, char);
  const tags = (view.tags || [view.primary || 'calm']).join(' · ');
  const lines = [
    `【mood】${tags}${view.buildup && view.buildup !== 'steady' ? ` (${view.buildup})` : ''}`,
    'These mood ids should color how you talk this turn — length, energy, warmth — following the character card. Do not recite the ids. Do not snap into a generic angry or whiny script; stay this person.',
  ];
  if (state.phase === 'residual') {
    lines.push('note: conflict afterglow — keep residue only if the character would.');
  }
  if (view.flashpoint) {
    lines.push(`note: recent flashpoint=${view.flashpoint.type} — residue by character; no instant reset, no customer-service soothe.`);
  }
  if (m.lastSilenceKind === 'unread') {
    lines.push('note: leftover from being left unread — still colors this turn; love is not an instant reset.');
  } else if (m.lastSilenceKind === 'read_no_reply') {
    lines.push('note: leftover from read-without-reply — still colors this turn; not instantly fine.');
  } else if (m.lastSilenceKind === 'phone_ignore') {
    lines.push('note: leftover from being ignored while they were on the phone — still colors this turn; love is not an instant reset.');
  }
  // Cross-world constraint for longing
  const yearningVal = Number(m.yearning) || 0;
  if (yearningVal >= 45 && /longing/.test(tags)) {
    lines.push('note: longing can color tone; closeness = messages/call/theater, not coming over.');
  }
  const desireVal = Number(m.fuel?.desire) || 0;
  if ((view.primary === 'desire' || view.flashpoint?.type === 'desire' || desireVal >= 52) && Number(char?.nsfw_enabled) !== 0) {
    lines.push('note: desire is yours — hint/tease by character ok; for closeness invite theater RP ([开启小剧场]), never real meetup/come-over. Do not force every turn.');
  }
  return lines.join('\n');
}

/** 日程生成不再吃心情（计划表中性；怎么做留给执行/聊天） */
function getScheduleEmotionFlavor() {
  return '';
}

/** 近 7 天心情均值，供感情线 tick 调制（D18） */
function getMoodTrend7d(charId) {
  if (!charId) return 0;
  try {
    const rows = db.prepare(
      `SELECT valence, ts FROM emotion_logs WHERE character_id=? ORDER BY id DESC LIMIT 150`
    ).all(charId);
    if (!rows.length) return 0;
    const cutoff = Date.now() - 7 * 86400000;
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      const t = Date.parse(r.ts);
      if (Number.isFinite(t) && t < cutoff) break;
      sum += Number(r.valence) || 0;
      n += 1;
    }
    return n ? sum / n : 0;
  } catch {
    return 0;
  }
}

function getMoodTrendMod(charId) {
  return clamp(getMoodTrend7d(charId) / 250, -0.2, 0.2);
}

/** 此刻日程块：不再塞中文心情花词（语气块已有英文 mood） */
function getScheduleMoodFootnote() {
  return '';
}

/** 官方心情词 → 记忆更耐忘的程度（0–1）。刻骨的慢枯，平淡的先掉。 */
const WITHER_CHARGE_BY_PRIMARY = {
  calm: 0.08,
  tired: 0.20,
  happy: 0.36,
  warm: 0.42,
  excited: 0.48,
  intimate: 0.52,
  anxious: 0.55,
  bitter: 0.58,
  low: 0.52,
  lonely: 0.62,
  desire: 0.68,
  longing: 0.74,
  hurt: 0.84,
  angry: 0.90,
};

const ZH_TO_PRIMARY = Object.fromEntries(
  Object.entries(PRIMARY_LABELS).map(([id, zh]) => [zh, id])
);

function officialMoodId(primaryOrZh) {
  const raw = String(primaryOrZh || '').trim();
  if (PRIMARY_LABELS[raw]) return raw;
  if (ZH_TO_PRIMARY[raw]) return ZH_TO_PRIMARY[raw];
  return 'calm';
}

function officialMoodZh(primaryOrZh) {
  return PRIMARY_LABELS[officialMoodId(primaryOrZh)] || '平静';
}

function witherChargeForPrimary(primaryOrZh) {
  if (!primaryOrZh) return 0;
  const id = officialMoodId(primaryOrZh);
  if (!PRIMARY_LABELS[String(primaryOrZh).trim()] && !ZH_TO_PRIMARY[String(primaryOrZh).trim()]) {
    return 0;
  }
  return WITHER_CHARGE_BY_PRIMARY[id] ?? 0.35;
}

function moodFromCharRow(char) {
  if (!char) return defaultMood({});
  let state = {};
  try {
    state = char.emotion_state
      ? (typeof char.emotion_state === 'object' ? char.emotion_state : JSON.parse(String(char.emotion_state)))
      : {};
  } catch {
    state = {};
  }
  return ensureDecayedMood(char, state).mood;
}

function officialMoodZhFromChar(char) {
  return officialMoodZh(softLabel(moodFromCharRow(char)));
}

module.exports = {
  PRIMARY_LABELS,
  MOOD_EMOJI,
  WITHER_CHARGE_BY_PRIMARY,
  officialMoodId,
  officialMoodZh,
  officialMoodZhFromChar,
  witherChargeForPrimary,
  deriveTemperament,
  deriveEmotionInfluenceWeights,
  inferUserEmotionFromMessage,
  defaultMood,
  normalizeMood,
  decayMood,
  touchMoodFromMessage,
  ensureDecayedMood,
  appendEmotionLog,
  getEmotionHistory,
  getEmotionEvents,
  publicMoodView,
  buildMoodPromptBlock,
  buildReplyToneBlock,
  getScheduleEmotionFlavor,
  getScheduleMoodFootnote,
  moodDisplayString,
  softLabel,
  characterToneProfile,
  SOFT_PERSONA_RE,
  topMoodTags,
  moodTagsToEmoji,
  scoreMessageImpact,
  scoreScheduleImpact,
  touchMoodFromSchedule,
  getMoodTrend7d,
  getMoodTrendMod,
  sampleMoodIfStale,
  syncCharacterMoodLabel,
  applySilenceMoodTick,
  tickAllCharacterEmotions,
  scoreSilenceImpact,
  amplifyImpactForAfterglow,
  feltValenceFromRow,
  isCloseRelationship,
  syncDriveFromMoodLonging,
};

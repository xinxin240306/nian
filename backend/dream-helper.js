/** 梦境叙事：规则块、开场提示、排版后处理 */

const ERA_PRESETS = ['架空古代', '现代都市', '未来科幻', '奇幻异世界', '民国旧时光', '西幻中世纪', '赛博朋克'];

const STYLE_PRESETS = {
  romantic: '文笔风格：浪漫抒情，善用感官描写，情感细腻，字里行间含情。',
  poetic: '文笔风格：意境古风，语言清雅简练，多用意象与留白，有古典诗意。',
  // 超现实 ≈ 文学超现实主义/魔幻：画面可跳跃、梦境感、隐喻强，不是「科幻设定」本身
  surreal: '文笔风格：超现实，意象可跳跃、时空可错位，偏梦境与魔幻隐喻；感官非常规，少写实因果解释，多象征与荒诞美感。',
  dark: '文笔风格：黑暗叙事，气氛压抑沉重，擅长心理与命运感。',
  gentle: '文笔风格：温柔细腻，平静如水，日常小事也能触动人心。',
  epic: '文笔风格：史诗长卷感，场面开阔，节奏有张有弛，偶有宏大比喻。',
  witty: '文笔风格：轻俏机敏，对白有锋芒，叙述干净利落，少煽情。',
};

const FORMAT_RULES = `【排版硬性要求】
1. 叙述段落首行相当于缩进两个汉字（可用全角空格「　　」起段，或自然分段）。
2. 凡人物说出口的话，必须用中文引号「」包裹，且对白单独成行：对白前换行、对白后换行；不要把对白嵌在叙述句中间。
3. 叙述与对白交替清晰；不要用*星号动作*或【系统】标签。`;

function normalizeDreamConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const freedom = ['free', 'semi', 'guided'].includes(c.freedom) ? c.freedom : 'free';
  const tone = c.tone === 'reality' || c.tone === '现实' ? 'reality' : 'dream';
  const styleKey = c.style || 'romantic';
  return {
    charRole: String(c.charRole || '').trim().slice(0, 80),
    userRole: String(c.userRole || '').trim().slice(0, 80),
    background: String(c.background || '').trim().slice(0, 8000),
    era: String(c.era || '架空古代').trim().slice(0, 80),
    mask: !!(c.mask === true || c.mask === 1 || c.mask === '1'),
    style: styleKey,
    styleCustom: String(c.styleCustom || '').trim().slice(0, 2000),
    freedom,
    tone,
  };
}

function resolveDreamStyleText(configOrStyle, styleCustom = '') {
  if (typeof configOrStyle === 'object' && configOrStyle) {
    const c = normalizeDreamConfig(configOrStyle);
    if (c.style === 'custom') {
      return c.styleCustom
        ? `文笔风格（必须严格遵守）：${c.styleCustom}`
        : '文笔风格：文学散文，细腻生动。';
    }
    const base = STYLE_PRESETS[c.style] || STYLE_PRESETS.romantic;
    return base;
  }
  const s = String(configOrStyle || '').trim();
  if (s) return s.startsWith('文笔') ? s : `文笔风格：${s}`;
  if (styleCustom) return `文笔风格（必须严格遵守）：${styleCustom}`;
  return STYLE_PRESETS.romantic;
}

function maskRuleText(masked) {
  if (!masked) return '';
  return '【面具】对方（与你互动的人）戴着面具或容貌被梦遮蔽：你必然认不出对方是谁。只会隐隐觉得此人有点熟悉，却怎么也想不起真实身份。禁止喊出其现实姓名、禁止识破、禁止突然「看穿」。可写试探、疑惑、熟悉感，但不可确认身份。';
}

function freedomRuleText(freedom) {
  if (freedom === 'semi') {
    return '【自由度·半自由】你负责场景与角色侧叙事。轮到对方行动时，用户会先给出简短意图；系统会另文扩写「对方」的行动与对白。你只写自己的反应与后续，绝不替对方做主。';
  }
  if (freedom === 'guided') {
    return '【自由度·选项】剧情以分支推进。用户将从选项中择一行动；你根据所选继续书写角色侧，使不同选择走向明显不同的氛围与后果。';
  }
  return '【自由度·自由】用户亲自书写自己的行动与对白；你只写自己的言行、感受与环境，绝不替用户行动或说话。';
}

function toneRuleText(tone) {
  if (tone === 'reality') {
    return '【基调·现实】按接近现实的因果与生活逻辑推进：动机、后果、环境细节要说得通；少用超自然跳切，除非设定本身允许。语气可文学，但事件要「像真的发生过」。';
  }
  return '【基调·梦境】偏潜意识梦境感：事件可以不合日常逻辑、意象跳跃、象征化，但不要胡乱到完全离谱或无意义堆砌；仍要有情绪连贯与可读节奏。';
}

function sceneRuleText(config) {
  const c = normalizeDreamConfig(config);
  const parts = [];
  if (c.era) parts.push(`时代/世界观气质：${c.era}（长篇角色扮演须符合该时代的器物、称谓、生活细节）。`);
  if (c.charRole) parts.push(`你在梦中的身份：${c.charRole}。`);
  if (c.userRole) parts.push(`与你互动之人的身份：${c.userRole}。`);
  if (c.background) {
    parts.push(`已定前提/前景摘要（须在此基础上展开，勿推翻）：\n${c.background}`);
  }
  return parts.length ? `【梦境设定】\n${parts.join('\n')}` : '';
}

/** 注入 send / trigger-ai 的梦境附加系统提示 */
function buildDreamExtraSystemPrompt({ dreamMask = false, dreamStyle = '', dreamConfig = null, freedom = null } = {}) {
  const cfg = normalizeDreamConfig(dreamConfig || {});
  if (freedom) cfg.freedom = freedom;
  if (dreamMask) cfg.mask = true;
  const styleNote = resolveDreamStyleText(dreamStyle || cfg);
  let intimateNote = '';
  try { intimateNote = require('./intimate-writing-helper').intimateNarrativeNotes(); } catch { /* ignore */ }
  const parts = [
    '当前处于梦境长篇叙事模式（不是通讯聊天）。',
    '用散文叙事：环境、动作、感官、心理与对白；第二人称「你」可指代梦中相遇的人，或用第三人称写对方；自己可用第一/第三人称。',
    '禁止提及AI、模型、程序、虚拟、扮演。禁止延续犯困、忙碌、在线等通讯琐碎状态。',
    '全文简体中文；每次回复宜充实（约400～1200字）。可在完整段落结束后停顿等人互动，但绝不可在句子或对白中间截断。',
    FORMAT_RULES,
    intimateNote,
    resolveDreamStyleText(cfg),
    styleNote && styleNote !== resolveDreamStyleText(cfg) ? styleNote : '',
    maskRuleText(cfg.mask),
    toneRuleText(cfg.tone),
    freedomRuleText(cfg.freedom),
    sceneRuleText(cfg),
  ].filter(Boolean);
  return parts.join('\n');
}

function buildDreamOpenPrompt(config) {
  const c = normalizeDreamConfig(config);
  const parts = ['[新梦境开始。请直接进入长篇开场，不要复述本指令。]'];
  parts.push('要求：写一大段开场（约500～900字），建立时代氛围、场景与人物心境。');
  if (c.background) {
    parts.push('已有前提/前景如下，请据此自然展开，不要另起炉灶推翻：');
    parts.push(c.background);
  } else {
    parts.push(`没有额外前提：请根据时代「${c.era || '未知时空'}」自动生成合理的背景开场，并埋下可互动的契机。`);
  }
  if (c.charRole) parts.push(`你在梦中的身份：${c.charRole}。`);
  if (c.userRole) {
    parts.push(c.mask
      ? `将与你相遇的人身份为「${c.userRole}」，但你认不出对方是谁，只觉熟悉。对方可以已在场或即将入场。`
      : `将与你相遇的人身份为「${c.userRole}」；可已在场或即将入场。`);
  } else if (c.mask) {
    parts.push('当那个人出现时，你认不出对方，只觉得有点熟悉。');
  }
  parts.push(FORMAT_RULES);
  parts.push(resolveDreamStyleText(c));
  parts.push(toneRuleText(c.tone));
  parts.push('开场结束时自然停在「需要对方行动/回应」的节拍上，不要替对方做决定。');
  return parts.join('\n');
}

function buildExpandUserPrompt(cue, config) {
  const c = normalizeDreamConfig(config);
  return `[半自由模式·扩写用户行动]
用户只给了简短意图，请扩写成「梦中对方」这一侧的一段叙述（动作+必要对白），文风必须符合设定，内容不偏离用户意图，不要美化成另一套剧情。
只输出扩写正文，不要写角色的反应，不要解释。
用户意图：${String(cue || '').trim()}
${sceneRuleText(c)}
${resolveDreamStyleText(c)}
${FORMAT_RULES}`;
}

function buildChoicesPrompt(config) {
  const c = normalizeDreamConfig(config);
  return `[选项模式]
根据当前梦境最新情节，给出用户此刻可采取的三个行动选项。
要求：三个选项彼此不同，会导向不同气氛或结局走向；每项是一句简短行动/台词意图（≤40字）；不要剧透长文。
只输出 JSON：{"choices":["…","…","…"]}
${sceneRuleText(c)}
${resolveDreamStyleText(c)}`;
}

/** 让对白单独成行，便于前端首行缩进渲染 */
function formatDreamProse(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  // 叙述中的开引号前换行
  t = t.replace(/([^\n「"\s])(\s*)([「"])/g, '$1\n$3');
  // 闭引号后若直接跟叙述，换行
  t = t.replace(/([」"])([^\n」"\s])/g, '$1\n$2');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

module.exports = {
  ERA_PRESETS,
  STYLE_PRESETS,
  FORMAT_RULES,
  normalizeDreamConfig,
  resolveDreamStyleText,
  buildDreamExtraSystemPrompt,
  buildDreamOpenPrompt,
  buildExpandUserPrompt,
  buildChoicesPrompt,
  formatDreamProse,
  maskRuleText,
};

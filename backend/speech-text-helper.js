/**
 * 朗读前的文本净化。
 *
 * TTS 只该念「开口说出来的那句话」。系统标记、链接、emoji 都不是台词——
 * 它们进了合成，小机就会一字一句念出「中括号 emotion U R L h t t p s 冒号」。
 * 小机那条链路尤其容易中招：兼容层会把 [表情:…][emotionUrl:…][NIAN_SCREEN:{…}]
 * 附在回复末尾，由 MCP 网关 TTS 播放。
 */

/** [NIAN_SCREEN:{…}]：值是 JSON，不能按「到第一个右括号为止」剥 */
const SCREEN_TAG_RE = /[[【［]\s*NIAN_SCREEN\s*[:：][\s\S]*?\}\s*[\]】］]?/gi;
const META_TAG_RE = /[[【［]\s*(?:emotionUrl|emotion_url|NIAN_SCREEN|screen)\s*[:：][^\]】］\n]*[\]】］]?/gi;
const DIRECTIVE_TAG_RE = /[[【［]\s*(?:表情|情绪|emotion|动作|动作指令|motion|灯光|灯|LED|led|舵机|伺服|servo|桌宠|配图|配视频|自拍|引用|撤回|拍一拍|打电话|语音电话|视频电话|视频通话|来电|场景状态|镜头|乐谱|语速|语气)\s*[:：][^\]】］\n]*[\]】］]?/gi;
const SPEED_TAG_RE = /[[【［]\s*语速\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)\s*[\]】］]/i;
/** [语气:调侃]：模型自己标的这句话怎么说，优先级高于关键词猜测 */
const TONE_TAG_RE = /[[【［]\s*语气\s*[:：]\s*([^\]】］\n]{1,12}?)\s*[\]】］]/i;
const PAREN_DIRECTIVE_RE = /[（(]\s*(?:表情|情绪|动作|灯光|舵机|桌宠)\s*[:：][^）)\n]{0,40}[）)]/gi;
/** [开心] [语音] 这类短标记一律不是台词 */
const SHORT_BRACKET_RE = /[[【［]\s*[^[\]【】［］\n]{1,12}\s*[\]】］]/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s，。！？；：、）)】」』"']+/gi;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{20E3}]/gu;
/** *动作* 或 （小声）这类旁白：小机是「开口说话」，念旁白很怪 */
const STAR_ASIDE_RE = /\*{1,3}[^*\n]{1,60}\*{1,3}/g;
const PAREN_ASIDE_RE = /[（(][^（()）\n]{0,60}[）)]/g;
/** Speech 2.8 语气词标签：念出来就是表演腔，日常/电话都剥掉 */
const SPEECH_ACT_TAG_RE = /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi;
/** 剩下这些符号 TTS 会挨个读出来 */
const NOISE_CHARS_RE = /[*_~`#|<>^\\{}[\]【】［］]/g;

/** 讲故事分饰标记（已不鼓励使用；若模型仍写出则解析并极轻处理） */
const VOICE_LANE_OPEN = '软声|软|细声|尖声|撒娇|cute|soft|沉声|沉|粗声|厚声|低沉|deep|low|bass';
const VOICE_LANE_BLOCK_RE = new RegExp(
  `\\[\\s*(${VOICE_LANE_OPEN})\\s*\\]([\\s\\S]*?)\\[\\s*\\/\\s*(?:${VOICE_LANE_OPEN})\\s*\\]`,
  'gi',
);
const VOICE_LANE_ORPHAN_RE = new RegExp(
  `\\[\\s*\\/?\\s*(?:${VOICE_LANE_OPEN})\\s*\\]`,
  'gi',
);

const SOFT_LANE_RE = /^(?:软声|软|细声|尖声|撒娇|cute|soft)$/i;
const DEEP_LANE_RE = /^(?:沉声|沉|粗声|厚声|低沉|deep|low|bass)$/i;

function extractSpeechRateTag(text) {
  const m = String(text || '').match(SPEED_TAG_RE);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0.7, Math.min(1.25, n));
}

/** 取出模型标注的语气词；没标返回空串 */
function extractToneTag(text) {
  const m = String(text || '').match(TONE_TAG_RE);
  return m ? String(m[1] || '').trim() : '';
}

function normalizeVoiceLane(raw) {
  const k = String(raw || '').trim();
  if (SOFT_LANE_RE.test(k)) return 'soft';
  if (DEEP_LANE_RE.test(k)) return 'deep';
  return 'normal';
}

/** 展示/转写时去掉分饰标记，避免用户看见 [软声] */
function stripVoiceLaneTags(text) {
  return String(text || '')
    .replace(VOICE_LANE_BLOCK_RE, '$2')
    .replace(VOICE_LANE_ORPHAN_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 按 [软声]…[/软声] / [沉声]…[/沉声] 切成朗读段。
 * 无标记时整段 normal。
 */
function extractVoiceLaneSegments(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const parts = [];
  let last = 0;
  VOICE_LANE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = VOICE_LANE_BLOCK_RE.exec(raw))) {
    if (m.index > last) {
      const mid = raw.slice(last, m.index);
      if (mid.trim()) parts.push({ lane: 'normal', text: mid });
    }
    const lane = normalizeVoiceLane(m[1]);
    const body = String(m[2] || '');
    if (body.trim()) parts.push({ lane, text: body });
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    const tail = raw.slice(last);
    if (tail.trim()) parts.push({ lane: 'normal', text: tail });
  }
  if (!parts.length) {
    const cleaned = stripVoiceLaneTags(raw);
    return cleaned.trim() ? [{ lane: 'normal', text: cleaned }] : [];
  }
  return parts.map((p) => ({
    lane: p.lane,
    text: stripVoiceLaneTags(p.text),
  })).filter((p) => String(p.text || '').trim());
}

function voiceLaneNeedsSplit(text) {
  const segs = extractVoiceLaneSegments(text);
  return segs.length > 1 || (segs.length === 1 && segs[0].lane !== 'normal');
}

/** 软声/沉声只做极轻对比；不要抬 happy、不要大幅变调（听感容易成配音） */
function voiceLaneProsody(lane) {
  switch (String(lane || '')) {
    case 'soft':
      return { pitch: 1, speedMul: 0.98, preferEmotion: '' };
    case 'deep':
      return { pitch: -2, speedMul: 0.97, preferEmotion: '' };
    default:
      return { pitch: 0, speedMul: 1, preferEmotion: '' };
  }
}

/**
 * @param {string} text
 * @param {{ dropAsides?: boolean, keepSpeechActs?: boolean }} [opts]
 *   dropAsides：连 *动作*／（旁白）一起去掉，给小机喇叭用；手机端语音通话保留旁白文字。
 *   keepSpeechActs：speech-2.8 的 (sighs)/(laughs) 是语气标记，不要剥。
 * @returns {string} 只剩台词；一句台词都不剩时返回空串（调用方应跳过合成）
 */
function sanitizeForSpeech(text, opts = {}) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  if (!t.trim()) return '';

  // 分饰标记只指导音色，不能念出来
  t = stripVoiceLaneTags(t);

  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(SCREEN_TAG_RE, ' ');
  t = t.replace(META_TAG_RE, ' ');
  t = t.replace(/\[\s*镜头\s*\][\s\S]*?\[\s*\/\s*镜头\s*\]/gi, ' ');
  t = t.replace(/\[\s*镜头\s*\][\s\S]*$/i, ' ');
  t = t.replace(/\[\s*\/\s*镜头\s*\]/gi, ' ');
  t = t.replace(DIRECTIVE_TAG_RE, ' ');
  t = t.replace(PAREN_DIRECTIVE_RE, ' ');
  t = t.replace(URL_RE, ' ');
  if (opts.dropAsides) {
    t = t.replace(STAR_ASIDE_RE, ' ');
    t = t.replace(PAREN_ASIDE_RE, ' ');
  }
  if (!opts.keepSpeechActs) t = t.replace(SPEECH_ACT_TAG_RE, ' ');
  t = t.replace(SHORT_BRACKET_RE, ' ');
  t = t.replace(EMOJI_RE, '');
  // 用空串而不是空格：中文里「好呀~我在呢」不该被劈成「好呀 我在呢」
  t = t.replace(NOISE_CHARS_RE, '');

  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/ ([，。！？；：、」』）】])/g, '$1')
    .trim();

  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  return t;
}

/**
 * 通话 / 语音条：像真人说话，不要表演腔。
 */
function buildSpeechDeliveryHint(_model) {
  return `【说话像人】
· 像跟熟人说话：短、松、有停顿；别朗诵、别播音、别演情绪。
· 不要写 (laughs)(sighs)(chuckle)(emm) 这类英文表演标记，合成会念成演出来的笑/叹。
· 不要用 [软声][沉声] 变腔；电话和日常语音就用平常那条嗓子。
· 笑、叹写进口语即可（哈哈、嘿嘿、噗、呵、唉、嗐、嗯——）。
· 犹豫别写 emmm、hmm 这类字母，合成会一个个念字母；写「嗯——」「呃……」「唔」。
${buildToneTagHint()}`.trim();
}

/**
 * 语气标注：合成端只能从字面猜，「烦死了」「有病吧」猜出来永远是真怒。
 * 这句是不是玩笑，只有写这句话的你知道，所以由你来标。
 */
function buildToneTagHint() {
  return `· 平常说话不要标语气。只有嘴上骂其实在开玩笑时，在句首写 [语气:调侃]（用户看不到），不标会被读成真的翻脸。
· 真生气才标 [语气:生气]，真难过才标 [语气:难过]。温柔/认真/开心/无奈这些日常口吻不要标。`;
}

/** 电话专用：像真人一样说话，少量语气词 OK，但别堆 */
function buildNaturalCallSpeechHint() {
  return `【电话怎么说】
· 像平时拿着手机跟熟人说话：短、松、有停顿；别朗诵、别播音、别演情绪。
· 偶尔一两个自然语气词 / 拉长音是可以的，真人讲话就这种节奏。例如：开头的「诶」「嗯」「噢」；中间的「那个」「就是说」「反正」「对吧」；句尾的「嗯——」「呃……」；拉长的「行吧——」「好好好——」。按你此刻接话的情绪自然带出，不要刻意也不要堆。

  · 写法提示（不要照搬）：
    - 拉长用「——」（两个 em 破折号），例如「行吧——」「诶——」；「……」是断句停顿，不是拉长。
    - 拉长音最多 4～6 字内，例如「行吧——」「好的——」「嗯——」，不要写「行吧————————————————」。
    - 一句最多 1～2 个语气/拉长元素；连着两三个用就成了「演」了，禁止「那个——就是——嗯——就是说——」这种堆。
    - 不要每句都开头挂「嗯」「那个」；正常聊天里大多数句子还是没有这些的。
    - 笑、叹写进口语即可（哈哈、嘿嘿、噗、呵、唉、嗐）。

· 禁止 (laughs)(sighs)(chuckle)(emm) 这类英文表演标记，合成会念成演出来的笑/叹；中文里直接写「哈」「叹」这种口语动词就行。
· 平常电话不要用 [软声][沉声] 变腔。只有讲故事里幼崽/软角色那一两句对白，才可以轻轻用一下 [软声]，别整段奶声表演。
· 犹豫别写 emmm、hmm，合成会念字母；写「嗯——」「呃……」「唔」。
${buildToneTagHint()}`.trim();
}

/**
 * 讲故事 / 陪听：平常嗓子讲故事；幼崽/软角色可以轻轻软一点，但不要演成儿童剧。
 */
function buildStorytellingLaneHint() {
  return `【讲故事】你正在讲故事或念故事。

· 整体用跟平时打电话一样的嗓子：自然、松一点，不要朗诵、不要播音腔、不要儿童剧/配音表演。
· 故事里幼崽、小动物、软软的角色开口时，可以稍微软一点、轻一点——像真人轻声学两句，不是假声配音。偶而用 [软声]…[/软声] 包那一句对白即可；旁白、成年人、叙述一律不要软声。
· 软可以，假不行：禁止叠词轰炸（「你你你」）、禁止句句「呀/呢/啊/哦」、禁止句句感叹号、禁止装喘、禁止尖声奶声喊叫。正常例子：小狐狸说「我有点怕……」；夸张禁止：「你你你怎么不会呀！！」。
· 稳重/年长角色如需区分，偶而用 [沉声]…[/沉声]，同样只要一点点，不要装老人腔。
· 题材按用户偏好、场景和人设自己挑；讲过的可以再讲，也可以换新的。
· 讲一个完整小段或一个起承转合后自然停，不要砍成「变相催睡」，也不要每段末尾挂「该睡了/闭眼/快睡」。`.trim();
}

module.exports = {
  sanitizeForSpeech,
  extractSpeechRateTag,
  extractToneTag,
  normalizeVoiceLane,
  stripVoiceLaneTags,
  extractVoiceLaneSegments,
  voiceLaneNeedsSplit,
  voiceLaneProsody,
  buildSpeechDeliveryHint,
  buildNaturalCallSpeechHint,
  buildStorytellingLaneHint,
  buildToneTagHint,
};


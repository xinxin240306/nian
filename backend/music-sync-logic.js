/**
 * 音乐同步决策引擎
 * 决定何时被歌「勾到心绪」而开口（不是评歌）
 */

// 触发概率：略低，偏「偶发被勾到」而不是每首歌都点评
const COMMENT_CONFIG = {
  baseProbability: 0.35,
  // 有歌词 / 伤感·怀旧·浪漫等易勾心绪时的加成
  hookBoost: 0.25,
  minSongInterval: 1,
  minTimeInterval: 30000,
};

const HOOK_MOODS = new Set(['悲伤', '怀旧', '浪漫', '平静']);
const HOOK_EMOTION_RE = /伤感|悲伤|难过|思念|孤独|怀旧|温柔|浪漫|离别|想你|心跳|安静/;

// 风格检测关键词
const GENRE_KEYWORDS = {
  '流行': ['流行', '情歌', 'pop'],
  '民谣': ['民谣', '吉他', 'folk', '民歌'],
  '摇滚': ['摇滚', 'rock', '金属', 'metal'],
  '说唱': ['说唱', 'rap', 'hip-hop', 'hiphop'],
  '轻音乐': ['轻音乐', '纯音乐', '钢琴', 'piano', 'instrumental'],
  '电音': ['电音', 'edm', 'electronic', 'house'],
  '古风': ['古风', '古典', '二胡', '琵琶'],
  '爵士': ['爵士', 'jazz'],
  '蓝调': ['蓝调', 'blues'],
};

// 情绪检测关键词
const MOOD_KEYWORDS = {
  '欢快': ['欢快', '快乐', '开心', '活力', '青春', '阳光'],
  '悲伤': ['悲伤', '伤感', '难过', '眼泪', '离别', '分手', '孤独'],
  '平静': ['平静', '安静', '舒缓', '温柔', '轻柔'],
  '激昂': ['激昂', '激情', '燃', '热血', '澎湃'],
  '浪漫': ['浪漫', '爱情', '甜蜜', '温馨'],
  '怀旧': ['怀旧', '回忆', '青春', '岁月', '时光'],
};

/**
 * 检测歌曲风格
 */
function detectGenre(track) {
  const text = `${track.title} ${track.artist} ${track.album || ''}`.toLowerCase();
  
  for (const [genre, keywords] of Object.entries(GENRE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) {
        return genre;
      }
    }
  }
  
  return '未知';
}

/**
 * 检测歌曲情绪
 */
function detectMood(track) {
  const text = `${track.title}`.toLowerCase();
  
  for (const [mood, keywords] of Object.entries(MOOD_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) {
        return mood;
      }
    }
  }
  
  return '中性';
}

/**
 * 决定是否应该评论这首歌
 */
function shouldCommentOnTrack(track, context) {
  const {
    songIndex = 0,
    lastCommentIndex = -1,
    lastCommentTime = null,
    recentGenres = [],
    recentMoods = [],
    characterMusicPreference = {}
  } = context;
  
  const now = Date.now();
  const currentGenre = detectGenre(track);
  const currentMood = detectMood(track);
  
  console.log('[music-sync] 📊 决策引擎分析');
  console.log('[music-sync] 当前歌曲索引:', songIndex);
  console.log('[music-sync] 上次评论索引:', lastCommentIndex);
  console.log('[music-sync] 歌曲间隔:', songIndex - lastCommentIndex);
  console.log('[music-sync] 检测风格:', currentGenre);
  console.log('[music-sync] 检测情绪:', currentMood);
  
  // 规则1: 第一首歌必评论
  if (songIndex === 0) {
    console.log('[music-sync] ✅ 决策结果: 应该评论（第一首歌）');
    return { should: true, reason: 'firstSong' };
  }
  
  // 规则2: 最少间隔检查
  const songGap = songIndex - lastCommentIndex;
  console.log('[music-sync] 检查间隔要求: 当前间隔', songGap, '首，要求', COMMENT_CONFIG.minSongInterval, '首');
  if (songGap < COMMENT_CONFIG.minSongInterval) {
    console.log('[music-sync] ❌ 决策结果: 不评论（间隔太短，才', songGap, '首）');
    return { should: false, reason: 'tooSoon' };
  }
  
  // 规则3: 时间间隔太短
  if (lastCommentTime && now - lastCommentTime < COMMENT_CONFIG.minTimeInterval) {
    const elapsed = Math.floor((now - lastCommentTime) / 1000);
    const required = Math.floor(COMMENT_CONFIG.minTimeInterval / 1000);
    console.log('[music-sync] 检查时间要求: 已过', elapsed, '秒，要求', required, '秒');
    console.log('[music-sync] ❌ 决策结果: 不评论（时间太短）');
    return { should: false, reason: 'tooFast' };
  }
  
  console.log('[music-sync] ✅ 通过基础间隔检查，继续评估...');
  
  // 规则4: 喜欢的歌手（必评论）
  const favoriteArtists = characterMusicPreference.favoriteArtists || [];
  if (favoriteArtists.length > 0) {
    console.log('[music-sync] 检查喜欢的歌手:', favoriteArtists);
    for (const artist of favoriteArtists) {
      if (track.artist && track.artist.includes(artist)) {
        console.log('[music-sync] ✅ 决策结果: 应该评论（喜欢的歌手:', artist, '）');
        return { should: true, reason: 'favoriteArtist' };
      }
    }
  }
  
  // 规则5: 风格突变
  if (recentGenres.length > 0 && recentGenres[0] !== currentGenre && currentGenre !== '未知') {
    const prevGenre = recentGenres[0];
    console.log('[music-sync] 检查风格变化:', prevGenre, '→', currentGenre);
    // 只在明显风格变化时评论
    if (prevGenre !== '未知' && prevGenre !== currentGenre) {
      console.log('[music-sync] ✅ 决策结果: 应该评论（风格突变）');
      return { should: true, reason: 'genreChange', from: prevGenre, to: currentGenre };
    }
  }
  
  // 规则6: 情绪突变
  if (recentMoods.length > 0 && recentMoods[0] !== currentMood && currentMood !== '中性') {
    const prevMood = recentMoods[0];
    console.log('[music-sync] 检查情绪变化:', prevMood, '→', currentMood);
    if (prevMood !== '中性' && prevMood !== currentMood) {
      console.log('[music-sync] ✅ 决策结果: 应该评论（情绪突变）');
      return { should: true, reason: 'moodChange', from: prevMood, to: currentMood };
    }
  }
  
  // 规则7: 不喜欢的风格（建议切歌）
  const dislikedGenres = characterMusicPreference.dislikedGenres || [];
  if (dislikedGenres.includes(currentGenre)) {
    console.log('[music-sync] ✅ 决策结果: 应该评论（不喜欢的风格，建议切歌）');
    return { should: true, reason: 'disliked' };
  }
  
  // 规则8: 易勾心绪时提高开口概率（有歌词 / 情绪气息偏沉）
  let prob = COMMENT_CONFIG.baseProbability;
  const emos = Array.isArray(track.emotions) ? track.emotions.join(' ') : '';
  const hasLyrics = !!String(track.lyrics || '').trim();
  if (hasLyrics || HOOK_MOODS.has(currentMood) || HOOK_EMOTION_RE.test(emos)) {
    prob = Math.min(0.75, prob + COMMENT_CONFIG.hookBoost);
  }

  const random = Math.random();
  console.log('[music-sync] 心绪触发: 掷骰子', random.toFixed(2), 'vs 概率', prob.toFixed(2));
  if (random < prob) {
    console.log('[music-sync] ✅ 决策结果: 被勾到，开口');
    return { should: true, reason: hasLyrics || HOOK_EMOTION_RE.test(emos) ? 'hooked' : 'random' };
  }

  console.log('[music-sync] ❌ 决策结果: 没被勾到，沉默');
  return { should: false, reason: 'skip' };
}

/**
 * 根据原因选择评论类型
 */
function selectCommentType(reason) {
  const typeMap = {
    firstSong: 'brief',
    favoriteArtist: 'excited',
    genreChange: 'observation',
    moodChange: 'question',
    disliked: 'suggest_skip',
    hooked: 'detailed',
    random: Math.random() < 0.4 ? 'detailed' : 'brief',
  };
  
  return typeMap[reason] || 'brief';
}

/**
 * 构建「被歌勾到心绪」的提示（不是评歌）
 */
function buildMusicCommentPrompt(track, reason, commentType, preference) {
  let prompt = `【场景】你和用户正一起听歌。不是要你当乐评人，也不是要你夸这首歌好不好听。\n`;
  prompt += `【当前播放】《${track.title}》 - ${track.artist}\n`;

  const emotions = Array.isArray(track.emotions) ? track.emotions.filter(Boolean) : [];
  if (emotions.length) {
    prompt += `【这首歌的情绪气息】${emotions.join('、')}\n`;
  }

  const lyrics = String(track.lyrics || '').trim();
  if (lyrics) {
    const lines = lyrics.split('\n').filter(Boolean);
    const head = lines.slice(0, 10).join('\n');
    const mid = lines.slice(Math.floor(lines.length / 2), Math.floor(lines.length / 2) + 8).join('\n');
    prompt += `\n【歌词（你已听进心里）】\n${head}\n`;
    if (mid && mid !== head) prompt += `...\n${mid}\n`;
  } else {
    prompt += `\n【歌词】公开歌词没搜到，只能靠歌名和氛围感受。\n`;
  }

  prompt += `\n【你要做什么】\n`;
  prompt += `只有当歌词或情绪**真的勾到你**时才开口：心绪被扯一下、想起某个人/某段事/和用户的什么、忽然安静、忽然委屈、忽然想靠近。\n`;
  prompt += `若没什么感觉，宁可只回极短的一声「嗯…」「……」或几乎不说，也不要硬评「好听/不好听」。\n`;

  if (preference.favoriteArtists && preference.favoriteArtists.length > 0) {
    prompt += `\n【你平时爱听】${preference.favoriteArtists.join('、')}`;
    if (preference.dislikedGenres?.length) prompt += `；不太吃：${preference.dislikedGenres.join('、')}`;
    prompt += `\n`;
  }

  prompt += `\n【这次心绪怎么落】\n`;
  switch (commentType) {
    case 'brief':
      prompt += `- 被轻轻碰到：一句就够，像自言自语。例：「……有点闷。」「突然想你了。」不要提「这首歌」。\n`;
      break;
    case 'excited':
      prompt += `- 是你喜欢的嗓子/熟悉的人：兴奋落在人身上，别空夸歌。例：「一听就是他……心里一软。」\n`;
      break;
    case 'observation':
    case 'question':
      prompt += `- 气氛变了，你心里也跟着晃：按性格问一句用户，或只说自己的感觉。不要点评曲风，不要说「这首歌好……」。\n`;
      if (reason.from && reason.to) prompt += `- 氛围从「${reason.from}」到「${reason.to}」\n`;
      break;
    case 'suggest_skip':
      prompt += `- 这首真的顶到你不适：可以说「有点冲，心里毛」；真受不了再用 music_control 下一首。不要像挑刺评委。\n`;
      break;
    case 'detailed':
      prompt += `- 被扎到较深：直接说牵起的情绪/画面/和用户有关的一点私心。短，像贴耳边。禁止「这首歌让我想到」起头。\n`;
      break;
    default:
      prompt += `- 按性格自然反应即可。\n`;
  }

  prompt += `\n【硬性】\n`;
  prompt += `- ❌ 禁止乐评腔：「这首歌讲的是…」「编曲很好」「旋律好听」\n`;
  prompt += `- ❌ 禁止整段背词；最多轻轻点一句意思或半句印象\n`;
  prompt += `- ❌ 禁止套话开场：「这首歌让我想到…」「听着这首歌…」「歌词让我想起…」「氛围好（伤感/治愈）」\n`;
  prompt += `- ❌ 禁止无视你们刚才在聊什么，突然像换了个频道空评歌\n`;
  prompt += `- ✅ 像微信随口漏一句：可以突然卡住、自言自语、只说半截情绪，不解释「为什么因为这首歌」\n`;
  prompt += `- ✅ 若牵起和用户有关的近事/旧事，轻轻带即可，不要硬焊无关记忆\n`;
  prompt += `- ✅ 1～2 句，第一人称，像真人被戳到，不是写作文\n`;

  return prompt;
}

module.exports = {
  detectGenre,
  detectMood,
  shouldCommentOnTrack,
  selectCommentType,
  buildMusicCommentPrompt,
  COMMENT_CONFIG,
};

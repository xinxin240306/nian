/**
 * 音乐同步 API 处理模块
 * 负责处理音乐同步通知、AI评论决策等
 */

const { callChatAPIComplete, buildHistoryApiMessages } = require('./api-helper');
const { buildSystemPrompt } = require('./cron');
const musicSyncLogic = require('./music-sync-logic');

/**
 * 获取角色音乐偏好
 */
function getCharacterMusicPreference(characterId, db) {
  const fallback = {
    favoriteGenres: ['流行', '民谣', '轻音乐'],
    dislikedGenres: ['重金属', 'Death Metal'],
    favoriteArtists: [],
    dislikedArtists: [],
    personalityTraits: {
      adventurous: 0.3,
      nostalgic: 0.7,
      lyricFocused: 0.8,
      moodSensitive: 0.9
    }
  };
  try {
    const char = db.prepare('SELECT music_preference FROM characters WHERE id=?').get(characterId);
    if (!char?.music_preference) return fallback;
    try {
      return { ...fallback, ...JSON.parse(char.music_preference) };
    } catch {
      return fallback;
    }
  } catch (e) {
    // 旧库缺 music_preference 列时会炸；回退默认，别把 SQLite 英文甩到 toast
    console.warn('[music-sync] music_preference unavailable:', e.message);
    return fallback;
  }
}

/**
 * 获取音乐同步状态
 */
function getMusicSyncState(userId, characterId, db) {
  const state = db.prepare(
    `SELECT * FROM music_sync_state WHERE user_id=? AND character_id=?`
  ).get(userId, characterId);
  
  return state || null;
}

/**
 * 检查角色是否正在音乐同步（用于系统提示词）
 */
function isMusicSyncActive(characterId, db) {
  const userId = 1; // TODO: 支持多用户时需要传入真实userId
  const state = getMusicSyncState(userId, characterId, db);
  
  if (!state) return null;
  
  // 检查最近是否有更新（5分钟内算活跃）
  const lastUpdate = state.updated_at ? new Date(state.updated_at).getTime() : 0;
  const now = Date.now();
  const isActive = (now - lastUpdate) < 5 * 60 * 1000; // 5分钟
  
  if (!isActive) return null;
  
  return {
    track: {
      title: state.track_title || '',
      artist: state.track_artist || '',
      album: state.track_album || '',
      lyrics: state.track_lyrics || '',
      emotions: String(state.track_emotions || '').split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
    },
    isPlaying: !!state.is_playing
  };
}

/**
 * 更新音乐同步状态
 */
function updateMusicSyncState(userId, characterId, track, db) {
  const now = new Date().toISOString();
  
  // 获取当前状态
  const current = getMusicSyncState(userId, characterId, db);
  const newSongIndex = current ? current.song_index + 1 : 0;
  const lyrics = String(track.lyrics || '').slice(0, 4000);
  const emotions = Array.isArray(track.emotions)
    ? track.emotions.join('、')
    : String(track.emotions || '');

  const baseArgs = [
    userId, characterId,
    track.title || '',
    track.artist || '',
    track.album || '',
    track.positionMs || 0,
    track.durationMs || 0,
    track.isPlaying ? 1 : 0,
    newSongIndex,
    now,
  ];

  try {
    db.prepare(`
      INSERT INTO music_sync_state (
        user_id, character_id, track_title, track_artist, track_album,
        position_ms, duration_ms, is_playing, song_index, updated_at,
        track_lyrics, track_emotions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, character_id) DO UPDATE SET
        track_title=excluded.track_title,
        track_artist=excluded.track_artist,
        track_album=excluded.track_album,
        position_ms=excluded.position_ms,
        duration_ms=excluded.duration_ms,
        is_playing=excluded.is_playing,
        song_index=excluded.song_index,
        updated_at=excluded.updated_at,
        track_lyrics=excluded.track_lyrics,
        track_emotions=excluded.track_emotions
    `).run(...baseArgs, lyrics, emotions);
  } catch (e) {
    // 旧库还没加歌词列时回退
    console.warn('[music-sync] state write with lyrics failed, fallback', e.message);
    db.prepare(`
      INSERT INTO music_sync_state (
        user_id, character_id, track_title, track_artist, track_album,
        position_ms, duration_ms, is_playing, song_index, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, character_id) DO UPDATE SET
        track_title=excluded.track_title,
        track_artist=excluded.track_artist,
        track_album=excluded.track_album,
        position_ms=excluded.position_ms,
        duration_ms=excluded.duration_ms,
        is_playing=excluded.is_playing,
        song_index=excluded.song_index,
        updated_at=excluded.updated_at
    `).run(...baseArgs);
  }
  
  return newSongIndex;
}

/**
 * 更新最后评论时间
 */
function updateLastCommentTime(userId, characterId, songIndex, db) {
  const now = new Date().toISOString();
  
  db.prepare(`
    UPDATE music_sync_state
    SET last_comment_index=?, last_comment_time=?
    WHERE user_id=? AND character_id=?
  `).run(songIndex, now, userId, characterId);
}

/**
 * 记录播放历史
 */
function recordPlayHistory(userId, characterId, track, durationMs, db) {
  const now = new Date().toISOString();
  
  db.prepare(`
    INSERT INTO music_sync_history (
      user_id, character_id, track_title, track_artist,
      play_duration_ms, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId, characterId,
    track.title || '',
    track.artist || '',
    durationMs || 0,
    now
  );
}

/**
 * 获取最近的音乐上下文
 */
function getRecentMusicContext(userId, characterId, db, limit = 5) {
  const state = getMusicSyncState(userId, characterId, db);
  
  if (!state) {
    return {
      songIndex: 0,
      lastCommentIndex: -1,
      lastCommentTime: null,
      recentGenres: [],
      recentMoods: []
    };
  }
  
  // 获取最近播放的歌曲
  const recentTracks = db.prepare(`
    SELECT track_title, track_artist
    FROM music_sync_history
    WHERE user_id=? AND character_id=?
    ORDER BY id DESC LIMIT ?
  `).all(userId, characterId, limit);
  
  const recentGenres = recentTracks.map(t => 
    musicSyncLogic.detectGenre({ title: t.track_title, artist: t.track_artist })
  );
  
  const recentMoods = recentTracks.map(t =>
    musicSyncLogic.detectMood({ title: t.track_title, artist: t.track_artist })
  );
  
  return {
    songIndex: state.song_index,
    lastCommentIndex: state.last_comment_index,
    lastCommentTime: state.last_comment_time ? new Date(state.last_comment_time).getTime() : null,
    recentGenres,
    recentMoods
  };
}

/**
 * 处理音乐同步通知
 */
async function handleMusicSyncNotify(req, res, db, getSettings, aiClient = null) {
  const { characterId, track } = req.body;
  const userId = 1; // TODO: 从session获取真实用户ID
  
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('[music-sync] 🎵 收到音乐同步通知');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('[music-sync] 时间:', new Date().toLocaleString('zh-CN'));
  console.log('[music-sync] 角色ID:', characterId);
  console.log('[music-sync] 用户ID:', userId);
  console.log('[music-sync] 歌曲信息:');
  console.log('  - 标题:', track?.title || '无');
  console.log('  - 艺术家:', track?.artist || '无');
  console.log('  - 专辑:', track?.album || '无');
  console.log('  - 播放状态:', track?.isPlaying ? '播放中' : '已暂停');
  console.log('  - 时长:', track?.durationMs ? `${Math.floor(track.durationMs / 1000)}秒` : '未知');
  
  if (!characterId || !track) {
    console.log('[music-sync] ❌ 参数缺失，拒绝处理');
    return res.status(400).json({ error: 'Missing characterId or track' });
  }
  
  if (!track.title || track.title === '未知') {
    console.log('[music-sync] ⚠️ 歌曲信息不完整（标题为空或未知），拒绝处理');
    return res.json({ commented: false, reason: 'noTrackInfo' });
  }
  
  console.log('[music-sync] ✅ 参数校验通过，开始处理...\n');
  
  try {
    // 0. 按歌名搜歌词+情绪（VIP 多数仍能拿到词）
    console.log('[music-sync] 步骤0: 搜索歌词与情绪...');
    let enriched = track;
    try {
      const musicLinkHelper = require('./music-link-helper');
      const lyricInfo = await musicLinkHelper.enrichTrackWithLyrics(track);
      enriched = {
        ...track,
        title: lyricInfo.title || track.title,
        artist: lyricInfo.artist || track.artist,
        album: lyricInfo.album || track.album,
        lyrics: lyricInfo.lyrics || '',
        emotions: lyricInfo.emotions || [],
        songId: lyricInfo.songId || '',
        lyricsFound: !!lyricInfo.lyricsFound,
      };
      console.log('[music-sync] 歌词:', enriched.lyricsFound ? `已找到（${enriched.lyrics.length}字）` : '未找到');
      console.log('[music-sync] 情绪:', (enriched.emotions || []).join('、') || '无');
    } catch (e) {
      console.warn('[music-sync] 歌词 enrichment 失败', e.message);
    }

    // 1. 更新同步状态
    console.log('[music-sync] 步骤1: 更新同步状态...');
    const newSongIndex = updateMusicSyncState(userId, characterId, enriched, db);
    console.log('[music-sync] ✅ 当前歌曲索引:', newSongIndex);
    
    // 2. 记录播放历史
    console.log('[music-sync] 步骤2: 记录播放历史...');
    recordPlayHistory(userId, characterId, enriched, enriched.durationMs || 0, db);
    console.log('[music-sync] ✅ 播放历史已记录');
    
    // 3. 获取角色音乐偏好
    console.log('[music-sync] 步骤3: 获取角色音乐偏好...');
    const preference = getCharacterMusicPreference(characterId, db);
    console.log('[music-sync] 角色偏好:', preference);
    
    // 4. 获取最近音乐上下文
    console.log('[music-sync] 步骤4: 获取最近音乐上下文...');
    const context = getRecentMusicContext(userId, characterId, db);
    context.songIndex = newSongIndex;
    context.characterMusicPreference = preference;
    console.log('[music-sync] 上下文:', {
      songIndex: context.songIndex,
      lastCommentIndex: context.lastCommentIndex,
      lastCommentTime: context.lastCommentTime,
      timeSinceLastComment: context.lastCommentTime ? Date.now() - context.lastCommentTime : null
    });
    
    // 5. 决策是否评论
    console.log('[music-sync] 步骤5: AI决策是否评论...');
    const decision = musicSyncLogic.shouldCommentOnTrack(enriched, context);
    
    console.log('[music-sync] 决策结果:', { 
      should: decision.should, 
      reason: decision.reason, 
      songIndex: newSongIndex,
      详细原因: decision.should ? '通过所有检查' : getDecisionReasonText(decision.reason)
    });
    
    if (!decision.should) {
      // 不评论，直接返回
      console.log('[music-sync] ⏭️ 跳过评论，原因:', getDecisionReasonText(decision.reason));
      return res.json({
        commented: false,
        reason: decision.reason,
        songIndex: newSongIndex
      });
    }
    
    // 6. 生成AI评论
    console.log('[music-sync] 🎵 决策通过！准备调用AI评论');
    const commentType = musicSyncLogic.selectCommentType(decision.reason);
    console.log('[music-sync] 评论类型:', commentType);
    
    const prompt = musicSyncLogic.buildMusicCommentPrompt(
      enriched,
      decision,
      commentType,
      preference
    );
    console.log('[music-sync] 提示词已生成, 长度:', prompt.length);
    
    // 7. 调用AI生成评论
    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
    if (!char) {
      return res.status(404).json({ error: 'Character not found' });
    }
    
    const settings = getSettings();
    let aiComment = '';
    let musicControlAction = null;
    
    try {
      console.log('[music-sync] 🤖 开始调用AI...');
      const result = await callAIForMusicComment(char, settings, prompt, aiClient);
      aiComment = result.comment;
      musicControlAction = result.musicControl;
      console.log('[music-sync] ✅ AI响应成功, 评论长度:', aiComment?.length, '切歌:', musicControlAction);
    } catch (e) {
      console.error('[music-sync] ❌ AI调用失败:', e.message);
      return res.json({
        commented: false,
        reason: 'ai_failed',
        error: e.message,
        songIndex: newSongIndex
      });
    }
    
    if (!aiComment) {
      return res.json({
        commented: false,
        reason: 'empty_response',
        songIndex: newSongIndex
      });
    }
    
    // 8. 保存AI评论到消息表
    const now = new Date().toISOString();
    const aiMsgId = db.prepare(`
      INSERT INTO messages (character_id, role, content, type, timestamp, is_dream)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(characterId, 'assistant', aiComment, 'text', now, 0).lastInsertRowid;
    
    // 9. 更新最后评论时间
    updateLastCommentTime(userId, characterId, newSongIndex, db);

    // 推到聊天页，避免前端只靠本地事件漏刷
    try {
      const { push } = require('./push');
      const aiMessages = [{
        id: aiMsgId,
        role: 'assistant',
        content: aiComment,
        type: 'text',
        timestamp: now,
      }];
      push('proactive_message', {
        characterId: Number(characterId),
        content: aiComment,
        aiMessages,
        charName: char.name,
        charAvatar: char.avatar || '',
        musicSync: true,
      });
      if (musicControlAction) {
        push('music_control_request', {
          characterId: Number(characterId),
          action: musicControlAction,
        });
      }
    } catch (e) {
      console.warn('[music-sync] push failed', e.message);
    }
    
    // 10. 如果AI调用了music_control工具，执行媒体控制
    if (musicControlAction) {
      console.log('[music-sync] 🎶 AI请求音乐控制:', musicControlAction);
    }
    
    console.log('[music-sync] ✅ 处理完成，返回AI评论');
    console.log('[music-sync] ===== 结束 =====');
    
    // 返回成功
    return res.json({
      commented: true,
      aiMessage: {
        id: aiMsgId,
        content: aiComment,
        type: commentType,
        reason: decision.reason
      },
      musicControl: musicControlAction,
      songIndex: newSongIndex
    });
    
  } catch (e) {
    console.error('[music-sync] ❌ 处理异常:', e);
    console.error('[music-sync] Stack:', e.stack);
    return res.status(500).json({ error: e.message });
  }
}

/**
 * 辅助函数：解释决策原因
 */
function getDecisionReasonText(reason) {
  const reasonMap = {
    tooSoon: '间隔歌曲太少',
    tooFast: '距上次开口太近',
    random: '随机未勾到',
    skip: '没被勾到',
    hooked: '歌词/情绪勾到心绪',
    noTrackInfo: '歌曲信息不完整',
    paused: '音乐已暂停',
  };
  return reasonMap[reason] || reason;
}

/**
 * 调用AI生成音乐评论
 */
async function callAIForMusicComment(char, settings, prompt, aiClient = null) {
  let sidePack = {
    historyForApi: [],
    continuityNote: '',
    promptOpts: { enableInlineDirectives: true },
  };
  try {
    const cron = require('./cron');
    if (typeof cron.loadSideChannelChatContext === 'function') {
      sidePack = cron.loadSideChannelChatContext(char.id);
    }
  } catch {}

  const personaBits = [char.personality, char.language_style, char.behavior]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((s) => (s.length > 180 ? `${s.slice(0, 180)}…` : s));
  const personaBlock = personaBits.length
    ? `\n【你是谁】\n${personaBits.join('\n')}\n开口必须符合以上性格与说话方式。\n`
    : '';

  const musicExtra = [
    '【一起听音乐·随口】你们正在一起听歌。不是评歌。只有真的被勾到才开口：心里一紧、忽然软、想起谁、想贴过去——直接说当下那一下，不要解释因果。',
    sidePack.continuityNote,
    '若被勾起的心绪和近窗对话或【脑海】里的事对得上，可以轻轻带一句；对不上就只说当下那一下，禁止硬焊无关旧事。',
    '禁止套话：「这首歌让我想到…」「听着这首歌…」「歌词让我想起…」「氛围好伤感」。禁止乐评腔。没感觉就极短或几乎不说。',
  ].filter(Boolean).join('\n');

  let systemPrompt = `你是${char.name}。你和用户正在一起听歌。
${personaBlock}
${musicExtra}

【可用工具】
真的顶得慌才可切歌：
- music_control({ action: "next" })
- music_control({ action: "previous" })
- music_control({ action: "play_pause" })
不要因为「不好听」就当评委切歌。`;

  try {
    if (typeof buildSystemPrompt === 'function') {
      systemPrompt = buildSystemPrompt(char, settings, `${musicExtra}

【可用工具】
真的顶得慌才可切歌：music_control next / previous / play_pause。不要因为「不好听」就当评委切歌。
禁止套话与乐评腔；没感觉就极短或几乎不说。`, sidePack.promptOpts || { enableInlineDirectives: true });
    }
  } catch (e) {
    console.warn('[music-sync] buildSystemPrompt fallback', e.message);
  }
  
  try {
    console.log('[music-sync] 步骤7.1: 获取工具定义...');
    // 获取 music_control 工具定义
    const robotTools = require('./robot-llm-tools');
    const tools = await robotTools.toolsForChat(char, settings, { isMusicSync: true });
    
    console.log('[music-sync] 🔧 工具数量:', tools?.length);
    if (tools && tools.length > 0) {
      console.log('[music-sync] 🔧 工具列表:', tools.map(t => t.function?.name));
      console.log('[music-sync] ✅ music_control 工具已注入');
    } else {
      console.warn('[music-sync] ⚠️ 没有获取到任何工具！');
    }
    
    console.log('[music-sync] 步骤7.2: 调用AI API...');
    // 调用API（带工具支持 + 近窗对话）
    const response = await callChatAPIComplete(
      settings,
      systemPrompt,
      prompt,
      'chat',
      sidePack.historyForApi || [],
      { tools, characterId: char.id }
    );
    
    console.log('[music-sync] 📥 AI原始响应:', JSON.stringify(response).slice(0, 200));
    
    // 检查是否调用了 music_control 工具
    let musicControlAction = null;
    if (response && typeof response === 'object') {
      console.log('[music-sync] 检查工具调用...');
      if (response.toolCalls) {
        console.log('[music-sync] 发现 toolCalls:', response.toolCalls.length, '个');
        const musicControlCall = response.toolCalls.find(call => call.name === 'music_control');
        if (musicControlCall && musicControlCall.args?.action) {
          musicControlAction = musicControlCall.args.action;
          console.log('[music-sync] ✅ AI调用了 music_control:', musicControlAction);
        }
      }
    }
    
    const comment = typeof response === 'string' 
      ? response.trim() 
      : String(response?.content || response?.text || '').trim();
    
    console.log('[music-sync] ✅ AI评论内容长度:', comment.length);
    
    return {
      comment,
      musicControl: musicControlAction
    };
  } catch (e) {
    console.error('[music-sync] ❌ AI调用异常:', e.message);
    console.error('[music-sync] 异常堆栈:', e.stack);
    throw e;
  }
}

module.exports = {
  handleMusicSyncNotify,
  getCharacterMusicPreference,
  getMusicSyncState,
  isMusicSyncActive,
  updateMusicSyncState,
  getRecentMusicContext,
  recordPlayHistory,
};

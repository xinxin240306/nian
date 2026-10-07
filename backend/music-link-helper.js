/**
 * 音乐链接解析：让角色"听懂"音乐，用情感和记忆回应
 * 
 * 核心理念：不是让AI复述歌词，而是：
 * 1. 提取歌曲的情感内核（氛围、情绪、场景）
 * 2. 结合角色记忆（第一次见面、共同经历）
 * 3. 用回忆式、情感化的方式回应
 */

const nodeFetch = require('node-fetch');
const { URL } = require('url');

const MUSIC_PLATFORMS = {
  netease: {
    name: '网易云音乐',
    patterns: [
      /music\.163\.com\/song\?id=(\d+)/,
      /music\.163\.com\/#\/song\?id=(\d+)/,
      /163cn\.tv\/([A-Za-z0-9]+)/,
    ],
    api: 'https://music.163.com/api/song/detail',
  },
  qq: {
    name: 'QQ音乐',
    patterns: [
      /y\.qq\.com\/n\/ryqq\/songDetail\/([A-Za-z0-9]+)/,
      /c\.y\.qq\.com\/base\/fcgi-bin\/u\?__=([A-Za-z0-9]+)/,
    ],
    api: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
  },
};

/** 检测消息中是否包含音乐链接 */
function detectMusicLink(text) {
  const content = String(text || '');
  for (const [platform, config] of Object.entries(MUSIC_PLATFORMS)) {
    for (const pattern of config.patterns) {
      const match = content.match(pattern);
      if (match) {
        return { platform, id: match[1], config };
      }
    }
  }
  return null;
}

/** 从 QQ 音乐获取歌曲信息（songmid） */
async function fetchQQMusic(songmid) {
  const mid = String(songmid || '').trim();
  if (!mid) return null;
  try {
    // 短链 / 分享页：先跟跳转拿最终 mid
    let resolvedMid = mid;
    if (/^[A-Za-z0-9]{4,12}$/.test(mid) && mid.length < 14) {
      try {
        const probe = await nodeFetch(`https://c.y.qq.com/base/fcgi-bin/u?__=${encodeURIComponent(mid)}`, {
          timeout: 6000,
          redirect: 'manual',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        const loc = probe.headers?.get?.('location') || '';
        const m = loc.match(/songDetail\/([A-Za-z0-9]+)/) || loc.match(/songmid=([A-Za-z0-9]+)/i);
        if (m) resolvedMid = m[1];
      } catch { /* 用原 mid 继续 */ }
    }

    const payload = {
      comm: { ct: 24, cv: 0 },
      songinfo: {
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail_yqq',
        param: { song_mid: resolvedMid },
      },
    };
    const response = await nodeFetch(
      `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify(payload))}`,
      {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://y.qq.com/',
        },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const track = data?.songinfo?.data?.track_info;
    if (!track?.name) return null;

    const albumMid = track.album?.mid || '';
    const cover = albumMid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`
      : '';

    let lyrics = '';
    try {
      const lyricRes = await nodeFetch(
        `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(resolvedMid)}&format=json&nobase64=1`,
        {
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Referer: 'https://y.qq.com/',
          },
        }
      );
      if (lyricRes.ok) {
        const lyricData = await lyricRes.json();
        lyrics = lyricData?.lyric || '';
      }
    } catch (e) {
      console.warn('[music-link] QQ 歌词获取失败', e.message);
    }

    const artists = Array.isArray(track.singer)
      ? track.singer.map((s) => s?.name).filter(Boolean).join('/')
      : '';

    return {
      title: track.name,
      artist: artists || '未知歌手',
      album: track.album?.name || '',
      cover,
      duration: Math.round(Number(track.interval) || 0),
      lyrics: cleanLyrics(lyrics),
      platform: 'QQ音乐',
      url: `https://y.qq.com/n/ryqq/songDetail/${resolvedMid}`,
    };
  } catch (e) {
    console.warn('[music-link] QQ 音乐解析失败', e.message);
    return null;
  }
}

/** 从网易云获取歌曲信息 */
async function fetchNeteaseMusic(id) {
  try {
    const response = await nodeFetch(`https://music.163.com/api/song/detail?ids=[${id}]`, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/',
      },
    });
    
    if (!response.ok) return null;
    const data = await response.json();
    const song = data?.songs?.[0];
    if (!song) return null;

    // 获取歌词
    let lyrics = '';
    try {
      const lyricRes = await nodeFetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://music.163.com/',
        },
      });
      if (lyricRes.ok) {
        const lyricData = await lyricRes.json();
        lyrics = lyricData?.lrc?.lyric || '';
      }
    } catch (e) {
      console.warn('[music-link] 歌词获取失败', e.message);
    }

    return {
      title: song.name,
      artist: song.artists?.map(a => a.name).join('/') || '未知歌手',
      album: song.album?.name || '',
      cover: song.album?.picUrl || song.album?.blurPicUrl || '',
      duration: Math.round((song.duration || 0) / 1000),
      lyrics: cleanLyrics(lyrics),
      platform: '网易云音乐',
      url: `https://music.163.com/song?id=${id}`,
    };
  } catch (e) {
    console.warn('[music-link] 网易云解析失败', e.message);
    return null;
  }
}

/** 清理歌词（去掉时间戳、空行） */
function cleanLyrics(raw) {
  if (!raw) return '';
  return String(raw)
    .split('\n')
    .map(line => line.replace(/^\[\d{2}:\d{2}\.\d{2,3}\]/, '').trim())
    .filter(line => line && !line.startsWith('[by:') && !line.startsWith('[ti:') && !line.startsWith('[ar:'))
    .join('\n')
    .trim()
    .slice(0, 2000); // 限制长度
}

/**
 * 按歌名+歌手在网易云搜索，取最匹配的一首 id。
 * VIP 歌多数仍能搜到词；音频是否可播与歌词接口无关。
 */
async function searchNeteaseSongId(title, artist = '') {
  const q = [String(title || '').trim(), String(artist || '').trim()].filter(Boolean).join(' ');
  if (!q) return null;
  try {
    const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&offset=0&total=true&limit=8`;
    const response = await nodeFetch(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/',
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const songs = data?.result?.songs || [];
    if (!songs.length) return null;

    const titleNorm = String(title || '').trim().toLowerCase();
    const artistNorm = String(artist || '').trim().toLowerCase();
    let best = songs[0];
    let bestScore = -1;
    for (const s of songs) {
      let score = 0;
      const sn = String(s.name || '').toLowerCase();
      const an = (s.artists || []).map((a) => String(a.name || '').toLowerCase()).join('/');
      if (titleNorm && sn === titleNorm) score += 5;
      else if (titleNorm && sn.includes(titleNorm)) score += 3;
      else if (titleNorm && titleNorm.includes(sn)) score += 2;
      if (artistNorm && an.includes(artistNorm)) score += 4;
      else if (artistNorm && artistNorm.split(/[/,&、]/).some((p) => p && an.includes(p.trim()))) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best?.id != null ? String(best.id) : null;
  } catch (e) {
    console.warn('[music-link] search failed', e.message);
    return null;
  }
}

/**
 * 一起听歌：只有通知栏歌名时，搜歌词 + 情绪，喂给角色。
 */
async function enrichTrackWithLyrics(track = {}) {
  const title = String(track.title || '').trim();
  const artist = String(track.artist || '').trim();
  const base = {
    title,
    artist,
    album: String(track.album || '').trim(),
    lyrics: '',
    emotions: [],
    songId: '',
    lyricsFound: false,
  };
  if (!title || title === '未知') return base;

  const id = await searchNeteaseSongId(title, artist);
  if (!id) {
    base.emotions = analyzeMusicEmotion('', title);
    return base;
  }
  base.songId = id;
  const info = await fetchNeteaseMusic(id);
  if (!info) {
    base.emotions = analyzeMusicEmotion('', title);
    return base;
  }
  base.lyrics = String(info.lyrics || '').trim();
  base.lyricsFound = !!base.lyrics;
  base.emotions = analyzeMusicEmotion(base.lyrics, info.title || title);
  if (info.title) base.title = info.title;
  if (info.artist) base.artist = info.artist;
  if (info.album) base.album = info.album;
  return base;
}

/** 分析歌曲情感（从歌词中提取情绪关键词） */
function analyzeMusicEmotion(lyrics, title) {
  const text = `${title} ${lyrics}`.toLowerCase();
  
  const emotions = [];
  
  // 情感关键词映射
  const emotionKeywords = {
    温柔: ['温柔', '轻轻', '慢慢', '柔软', '微风', '月光', '细雨'],
    思念: ['想', '念', '回忆', '从前', '曾经', '那时', '还记得'],
    孤独: ['孤独', '一个人', '寂寞', '独自', '空荡', '冷清'],
    心动: ['心动', '喜欢', '靠近', '怦然', '悸动', '脸红'],
    伤感: ['离开', '再见', '失去', '眼泪', '哭', '痛', '散了'],
    治愈: ['温暖', '拥抱', '陪伴', '在身边', '阳光', '笑容'],
    激昂: ['奔跑', '追逐', '飞翔', '勇敢', '燃烧', '梦想'],
    平静: ['安静', '沉默', '静静', '平静', '淡然', '云淡风轻'],
  };

  for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
    const hasKeyword = keywords.some(kw => text.includes(kw));
    if (hasKeyword) emotions.push(emotion);
  }

  return emotions.length ? emotions : ['温柔'];
}

/** 
 * 格式化音乐信息给AI
 * 关键：不直接展示歌词，而是提取情感内核
 */
function formatMusicForAI(musicInfo, characterMemories = null) {
  if (!musicInfo) return null;

  const emotions = analyzeMusicEmotion(musicInfo.lyrics, musicInfo.title);
  
  // 提取歌词的核心意境（前3句+高潮部分）
  const lyricsLines = musicInfo.lyrics.split('\n').filter(Boolean);
  const opening = lyricsLines.slice(0, 3).join('\n');
  const climax = lyricsLines.slice(Math.floor(lyricsLines.length / 2), Math.floor(lyricsLines.length / 2) + 3).join('\n');
  
  return {
    type: 'music_share',
    title: musicInfo.title,
    artist: musicInfo.artist,
    album: musicInfo.album,
    emotions: emotions,
    lyricsPreview: opening,
    lyricsClimax: climax,
    fullLyrics: musicInfo.lyrics,
    cover: musicInfo.cover,
    platform: musicInfo.platform,
    url: musicInfo.url,
  };
}

/**
 * 生成AI理解的音乐上下文
 * 这段文字会注入到消息中，让AI"感受"音乐而不是复述
 */
function buildMusicContext(musicInfo, characterId = null) {
  if (!musicInfo) return '';

  const emotions = musicInfo.emotions?.join('、') || '温柔';
  
  // 核心：让AI感受音乐，而不是分析歌词
  const context = [
    `【用户分享了一首歌】`,
    `歌名：《${musicInfo.title}》 - ${musicInfo.artist}`,
    `氛围：${emotions}`,
    ``,
    `# 你能感受到的：`,
    `- 前奏响起时的氛围（${emotions}）`,
    `- 歌词里的情绪片段（不要复述，用你自己的感受回应）`,
    ``,
    `# 回应方式（重要）：`,
    `1. **不要复述歌词**，不要说"这首歌讲的是..."`,
    `2. **用回忆式语言**：想起某个瞬间、某种感觉`,
    `3. **结合你们的故事**：第一次见面、一起经历的事`,
    `4. **情感化回应**：比如"听到前奏就想起..."、"这个旋律让我想到..."`,
    ``,
    `# 歌词氛围片段（仅供感受，不要引用）：`,
    `${musicInfo.lyricsPreview || ''}`,
    ``,
    `...`,
    ``,
    `${musicInfo.lyricsClimax || ''}`,
  ].join('\n');

  return context;
}

/** 
 * 将音乐链接转换为富文本消息
 * 用户看到的是歌曲卡片，AI看到的是情感化描述
 */
async function enrichMessageWithMusic(message, characterId = null) {
  const content = String(message?.content || '');
  const detected = detectMusicLink(content);
  
  if (!detected) return null;

  let musicInfo = null;

  if (detected.platform === 'netease') {
    musicInfo = await fetchNeteaseMusic(detected.id);
  } else if (detected.platform === 'qq') {
    musicInfo = await fetchQQMusic(detected.id);
  }

  if (!musicInfo) return null;

  const formatted = formatMusicForAI(musicInfo, characterId);
  const aiContext = buildMusicContext(formatted, characterId);

  return {
    // 用户看到的（原消息+卡片）
    userMessage: message,
    musicCard: formatted,
    
    // AI看到的（情感化描述）
    aiContext: aiContext,
    
    // 元数据
    rawMusicInfo: musicInfo,
  };
}

/** 检查角色是否启用音乐分享功能 */
function isMusicShareEnabled(settings) {
  // 默认启用
  return String(settings?.music_share_enabled || '1') === '1';
}

module.exports = {
  detectMusicLink,
  fetchNeteaseMusic,
  fetchQQMusic,
  searchNeteaseSongId,
  enrichTrackWithLyrics,
  formatMusicForAI,
  buildMusicContext,
  enrichMessageWithMusic,
  analyzeMusicEmotion,
  isMusicShareEnabled,
  cleanLyrics,
};

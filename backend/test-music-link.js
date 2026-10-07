/**
 * 测试音乐链接解析功能
 */

const musicLinkHelper = require('./music-link-helper');

async function testNetease() {
  console.log('测试网易云音乐链接解析...\n');
  
  // 测试链接检测
  const testUrls = [
    'https://music.163.com/song?id=1901371647',
    '听这首歌 https://music.163.com/#/song?id=1901371647',
    '分享: 晴天 http://163cn.tv/abc123',
  ];
  
  for (const url of testUrls) {
    const detected = musicLinkHelper.detectMusicLink(url);
    console.log('检测链接:', url);
    console.log('结果:', detected ? `✓ ${detected.platform} - ${detected.id}` : '✗ 未检测到');
    console.log('');
  }
  
  // 测试实际解析（需要网络）
  console.log('测试实际解析网易云音乐...\n');
  try {
    const musicInfo = await musicLinkHelper.fetchNeteaseMusic('1901371647');
    if (musicInfo) {
      console.log('✓ 解析成功:');
      console.log('  歌名:', musicInfo.title);
      console.log('  歌手:', musicInfo.artist);
      console.log('  专辑:', musicInfo.album);
      console.log('  时长:', musicInfo.duration + 's');
      console.log('  歌词片段:', musicInfo.lyrics.slice(0, 100) + '...');
      console.log('');
      
      // 测试情感分析
      const emotions = musicLinkHelper.analyzeMusicEmotion(musicInfo.lyrics, musicInfo.title);
      console.log('  情感分析:', emotions.join('、'));
      console.log('');
      
      // 测试格式化
      const formatted = musicLinkHelper.formatMusicForAI(musicInfo);
      console.log('  格式化结果:');
      console.log('    标题:', formatted.title);
      console.log('    情绪:', formatted.emotions.join('、'));
      console.log('    前奏歌词:', formatted.lyricsPreview.slice(0, 50) + '...');
      console.log('');
      
      // 测试AI上下文
      const aiContext = musicLinkHelper.buildMusicContext(formatted);
      console.log('  AI看到的上下文:');
      console.log(aiContext.slice(0, 300) + '...');
    } else {
      console.log('✗ 解析失败');
    }
  } catch (e) {
    console.error('✗ 解析出错:', e.message);
  }
}

async function testEnrichment() {
  console.log('\n\n测试消息enrichment...\n');
  
  const message = {
    content: '听听这首歌 https://music.163.com/song?id=1901371647',
  };
  
  try {
    const enriched = await musicLinkHelper.enrichMessageWithMusic(message, 1);
    if (enriched) {
      console.log('✓ Enrichment成功:');
      console.log('  用户消息:', enriched.userMessage.content);
      console.log('  音乐卡片:', enriched.musicCard);
      console.log('  AI上下文长度:', enriched.aiContext.length);
    } else {
      console.log('✗ 未检测到音乐链接');
    }
  } catch (e) {
    console.error('✗ Enrichment出错:', e.message);
  }
}

// 运行测试
if (require.main === module) {
  (async () => {
    await testNetease();
    await testEnrichment();
  })();
}

module.exports = { testNetease, testEnrichment };

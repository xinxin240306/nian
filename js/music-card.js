/**
 * 音乐卡片渲染模块
 * 在聊天界面中显示音乐分享卡片
 */

/**
 * 构建音乐卡片HTML
 * @param {Object} musicCard - 音乐卡片数据
 * @returns {string} HTML字符串
 */
export function buildMusicCardHtml(musicCard) {
  if (!musicCard || musicCard.type !== 'music_share') return '';
  
  const {
    title = '未知歌曲',
    artist = '未知歌手',
    album = '',
    cover = '',
    emotions = [],
    platform = '音乐平台',
    url = '#',
  } = musicCard;
  
  const emotionTags = emotions.slice(0, 4).map(e => 
    `<span class="music-emotion-tag">${escapeHtml(e)}</span>`
  ).join('');
  
  const coverImg = cover 
    ? `<img class="music-card-cover" src="${escapeHtml(cover)}" alt="封面" loading="lazy" />`
    : `<div class="music-card-cover" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);"></div>`;
  
  return `
    <div class="music-card" data-music-url="${escapeHtml(url)}" onclick="window.openMusicLink(this)">
      <div class="music-card-platform">${escapeHtml(platform)}</div>
      ${coverImg}
      <div class="music-card-info">
        <div class="music-card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="music-card-artist" title="${escapeHtml(artist)}">${escapeHtml(artist)}</div>
        ${emotionTags ? `<div class="music-card-emotions">${emotionTags}</div>` : ''}
      </div>
      <svg class="music-card-icon" viewBox="0 0 24 24" fill="white">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
      </svg>
    </div>
  `;
}

/**
 * 打开音乐链接
 * @param {HTMLElement} element - 音乐卡片元素
 */
window.openMusicLink = function(element) {
  const url = element.getAttribute('data-music-url');
  if (!url || url === '#') return;
  
  // 如果是原生App，使用原生方法打开
  if (typeof window.openExternalUrl === 'function') {
    window.openExternalUrl(url);
  } else {
    // 否则在新标签页打开
    window.open(url, '_blank');
  }
};

/**
 * 转义HTML特殊字符
 * @param {string} text - 需要转义的文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 在消息中注入音乐卡片
 * @param {HTMLElement} bubbleElement - 气泡元素
 * @param {Object} messageData - 消息数据
 */
export function injectMusicCard(bubbleElement, messageData) {
  if (!messageData.musicCard) return;
  
  const cardHtml = buildMusicCardHtml(messageData.musicCard);
  if (!cardHtml) return;
  
  // 找到消息内容容器
  const contentEl = bubbleElement.querySelector('.bubble-content') 
    || bubbleElement.querySelector('.message-content')
    || bubbleElement;
  
  // 创建临时容器
  const temp = document.createElement('div');
  temp.innerHTML = cardHtml;
  const cardElement = temp.firstElementChild;
  
  // 如果是用户消息，插入到文本前面
  if (messageData.role === 'user') {
    contentEl.insertBefore(cardElement, contentEl.firstChild);
  } else {
    // AI消息插入到文本后面
    contentEl.appendChild(cardElement);
  }
}

/**
 * 批量处理消息中的音乐卡片
 * @param {Array} messages - 消息列表
 */
export function hydrateMusicCards(messages) {
  if (!Array.isArray(messages)) return;
  
  messages.forEach(msg => {
    if (!msg.musicCard) return;
    
    const bubbleEl = document.querySelector(`.bubble-wrap[data-msg-id="${msg.id}"]`);
    if (!bubbleEl) return;
    
    // 避免重复注入
    if (bubbleEl.querySelector('.music-card')) return;
    
    injectMusicCard(bubbleEl, msg);
  });
}

// 导出给外部使用
window.buildMusicCardHtml = buildMusicCardHtml;
window.injectMusicCard = injectMusicCard;
window.hydrateMusicCards = hydrateMusicCards;

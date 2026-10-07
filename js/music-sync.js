/**
 * 音乐同步功能 - 前端模块
 * 用于"一起听音乐"功能
 */

import { hydrateMusicCards } from './music-card.js';
import { apiFetch } from './api.js';

let musicSyncActive = false;
let currentCharacterId = null;
let pollingTimer = null;
let lastTrackSignature = '';

/**
 * 初始化音乐同步功能
 */
export function initMusicSync() {
  console.log('[music-sync] ===== 初始化音乐同步模块 =====');
  
  // 如果之前有同步状态，恢复
  const savedState = localStorage.getItem('musicSyncActive');
  if (savedState) {
    try {
      const { active, characterId } = JSON.parse(savedState);
      console.log('[music-sync] 发现保存的状态:', { active, characterId });
      if (active && characterId) {
        console.log('[music-sync] 恢复音乐同步...');
        startMusicSync(characterId);
      }
    } catch (e) {
      console.warn('[music-sync] 恢复状态失败:', e);
    }
  } else {
    console.log('[music-sync] 无保存状态');
  }
  
  // 监听native回调（Android App）
  window.onMusicTrackChanged = function(trackJsonStr) {
    handleTrackChanged(trackJsonStr);
  };
  console.log('[music-sync] ✅ Native回调已注册: window.onMusicTrackChanged');
  console.log('[music-sync] ===== 初始化完成 =====');
  console.log('');
  console.log('💡 使用提示：');
  console.log('1. 点击聊天页面菜单中的【一起听音乐】按钮');
  console.log('2. 打开音乐播放器（网易云、QQ音乐等）');
  console.log('3. 播放歌曲并切换到下一首');
  console.log('4. 观察此处的调试日志');
  console.log('');
}

/**
 * 开始音乐同步
 */
export async function startMusicSync(characterId) {
  if (musicSyncActive && currentCharacterId === characterId) {
    console.log('[music-sync] already active');
    return;
  }
  
  musicSyncActive = true;
  currentCharacterId = characterId;
  
  // 保存状态
  localStorage.setItem('musicSyncActive', JSON.stringify({
    active: true,
    characterId
  }));
  
  // 检测环境：Native App 还是 PWA
  const isNativeApp = window.Capacitor?.isNativePlatform?.() || false;
  
  console.log('[music-sync] ===== 音乐同步启动诊断 =====');
  console.log('[music-sync] 环境检测:', {
    isNativeApp,
    hasCapacitor: !!window.Capacitor,
    hasMusicSyncBridge: !!window.MusicSync,
    hasMusicSyncStart: !!(window.MusicSync?.start),
    hasMediaSession: 'mediaSession' in navigator
  });
  
  if (isNativeApp) {
    // Android Native: 启动MediaSessionMonitor
    try {
      if (window.MusicSync?.start) {
        window.MusicSync.start(Number(characterId) || 0);
        console.log('[music-sync] ✅ native monitor started');
        window.showToast?.('一起听歌已开启：请确认已开「通知使用权」，并在网易云/QQ音乐里切到下一首');
        // 权限若未开，native 会跳设置且不轮询；几秒后仍无曲目则提示
        setTimeout(() => {
          if (!musicSyncActive || Number(currentCharacterId) !== Number(characterId)) return;
          try {
            const raw = window.MusicSync?.getCurrentTrack?.();
            const cur = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
            if (!cur?.title && !lastTrackSignature) {
              window.showToast?.('还没读到正在播的歌：去系统设置打开念的通知使用权，再切一首歌');
              updateMusicSyncBar({ title: '等待读到歌曲…', artist: '检查通知权限', status: 'connecting' });
            }
          } catch {}
        }, 8000);
      } else {
        console.warn('[music-sync] ❌ native bridge not available');
        console.log('[music-sync] window.MusicSync:', window.MusicSync);
        showMusicSyncError('Native功能不可用，请更新App版本');
        stopMusicSync();
        return;
      }
    } catch (e) {
      console.error('[music-sync] ❌ native start failed', e);
      showMusicSyncError('启动失败: ' + e.message);
      stopMusicSync();
      return;
    }
  } else {
    // PWA: 使用Media Session API轮询（功能受限）
    console.log('[music-sync] ⚠️ PWA mode, using polling (功能受限)');
    console.log('[music-sync] PWA模式只能检测当前页面的Media Session');
    console.log('[music-sync] 无法检测到其他App（如网易云音乐）的播放状态');
    console.log('[music-sync] 建议使用Android App获得完整功能');
    startPolling();
  }
  
  // 显示同步状态栏
  updateMusicSyncBar({ title: '正在连接...', artist: '', status: 'connecting' });
  console.log('[music-sync] ===== 诊断结束 =====');
}

/**
 * 停止音乐同步
 */
export function stopMusicSync() {
  if (!musicSyncActive) return;
  
  musicSyncActive = false;
  currentCharacterId = null;
  lastTrackSignature = '';
  
  // 清除状态
  localStorage.removeItem('musicSyncActive');
  
  // 停止native监控
  const isNativeApp = window.Capacitor?.isNativePlatform?.() || false;
  if (isNativeApp && window.MusicSync?.stop) {
    try {
      window.MusicSync.stop();
      console.log('[music-sync] native monitor stopped');
    } catch (e) {
      console.error('[music-sync] native stop failed', e);
    }
  }
  
  // 停止PWA轮询
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  
  // 移除状态栏
  removeMusicSyncBar();
}

/**
 * PWA轮询模式（功能受限，仅作fallback）
 */
function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  
  pollingTimer = setInterval(async () => {
    try {
      // PWA只能读取当前页面设置的Media Session
      // 无法读取其他App的播放状态
      if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
        const meta = navigator.mediaSession.metadata;
        const track = {
          title: meta.title || '',
          artist: meta.artist || '',
          album: meta.album || '',
          isPlaying: true, // PWA无法准确判断播放状态
          timestamp: Date.now()
        };
        
        const signature = `${track.title}|${track.artist}`;
        if (signature !== lastTrackSignature && signature !== '|') {
          lastTrackSignature = signature;
          await sendTrackToBackend(track);
          updateMusicSyncBar(track);
        }
      }
    } catch (e) {
      console.warn('[music-sync] polling failed', e);
    }
  }, 3000); // 每3秒轮询一次
}

/**
 * 处理曲目变化（Native回调）
 */
function handleTrackChanged(trackJsonStr) {
  console.log('[music-sync] ===== 收到歌曲变化回调 =====');
  console.log('[music-sync] Raw JSON:', trackJsonStr);
  
  if (!musicSyncActive) {
    console.warn('[music-sync] ❌ 音乐同步未激活，忽略回调');
    return;
  }
  
  try {
    const track = JSON.parse(trackJsonStr);
    console.log('[music-sync] ✅ 解析成功:', {
      title: track.title,
      artist: track.artist,
      album: track.album,
      isPlaying: track.isPlaying
    });
    
    const signature = `${track.title}|${track.artist}`;
    console.log('[music-sync] 歌曲签名:', signature);
    console.log('[music-sync] 上次签名:', lastTrackSignature);
    
    if (signature === lastTrackSignature) {
      console.log('[music-sync] ⚠️ 相同歌曲，跳过（未检测到切歌）');
      return;
    }
    
    if (!track.title || track.title === '未知') {
      console.warn('[music-sync] ⚠️ 歌曲信息不完整，跳过');
      return;
    }
    
    lastTrackSignature = signature;
    console.log('[music-sync] ✅ 检测到新歌曲，准备发送到后端');
    
    // 发送到后端
    sendTrackToBackend(track);
    
    // 更新UI
    updateMusicSyncBar(track);
    console.log('[music-sync] ===== 处理完成 =====');
  } catch (e) {
    console.error('[music-sync] ❌ 处理失败:', e);
    console.error('[music-sync] Stack:', e.stack);
  }
}

/**
 * 发送曲目到后端（触发AI评论决策）
 */
async function sendTrackToBackend(track) {
  if (!currentCharacterId) {
    console.error('[music-sync] ❌ 没有 characterId，无法发送');
    return;
  }
  
  console.log('[music-sync] ===== 发送到后端 =====');
  console.log('[music-sync] 目标角色ID:', currentCharacterId);
  console.log('[music-sync] 歌曲信息:', track);
  
  try {
    const requestBody = {
      characterId: currentCharacterId,
      track
    };
    console.log('[music-sync] 请求体:', JSON.stringify(requestBody, null, 2));
    
    const result = await apiFetch('/api/music-sync/notify', {
      method: 'POST',
      body: JSON.stringify(requestBody),
      timeoutMs: 120000,
    });
    console.log('[music-sync] ✅ 后端响应:', result);
    
    if (result.error) {
      console.error('[music-sync] ❌ 后端返回错误:', result.error);
      return;
    }
    
    // 如果AI评论了，刷新聊天气泡
    if (result.commented && result.aiMessage) {
      console.log('[music-sync] 🎵 AI发表了评论！');
      console.log('[music-sync] 评论内容:', result.aiMessage.content);
      console.log('[music-sync] 评论类型:', result.aiMessage.type);
      
      // 触发聊天页面刷新（通过自定义事件）
      window.dispatchEvent(new CustomEvent('musicSyncComment', {
        detail: {
          characterId: Number(currentCharacterId),
          message: result.aiMessage
        }
      }));
    } else {
      console.log('[music-sync] ℹ️ AI决定不评论');
      console.log('[music-sync] 原因:', result.reason || '未知');
    }
    
    // 如果AI调用了 music_control 工具切歌
    if (result.musicControl) {
      console.log('[music-sync] 🎶 AI请求音乐控制:', result.musicControl);
      handleMusicControlFromAI(result.musicControl);
    }
    
    console.log('[music-sync] ===== 发送完成 =====');
  } catch (e) {
    console.error('[music-sync] ❌ 发送失败:', e);
    console.error('[music-sync] 错误详情:', e.message);
    console.error('[music-sync] Stack:', e.stack);
    
    // 检查网络连接
    if (!navigator.onLine) {
      console.error('[music-sync] ⚠️ 网络已断开');
      showMusicSyncError('网络连接失败');
    } else {
      showMusicSyncError(
        /no such column/i.test(String(e?.message || ''))
          ? '一起听歌需要更新服务端数据库，请重启后端后再试'
          : (e?.message || '同步失败，请检查服务器地址')
      );
    }
  }
}

/**
 * 处理AI发起的音乐控制
 */
export async function handleMusicControlFromAI(action) {
  const isNativeApp = window.Capacitor?.isNativePlatform?.() || false;
  
  if (!isNativeApp) {
    console.warn('[music-sync] music control not available in PWA');
    return;
  }
  
  try {
    // 通过Shizuku插件发送媒体控制命令
    if (window.Shizuku?.sendMediaControl) {
      const result = await window.Shizuku.sendMediaControl({ action });
      console.log('[music-sync] media control result:', result);
      
      if (result.success) {
        // 显示提示（可选）
        const actionText = { next: '下一首', previous: '上一首', play_pause: '播放/暂停' };
        window.showToast?.(`已切换到${actionText[action] || action}`);
      }
    } else {
      console.warn('[music-sync] Shizuku plugin not available');
    }
  } catch (e) {
    console.error('[music-sync] music control failed', e);
  }
}

/**
 * 更新音乐同步状态（顶栏图标模式）
 */
function updateMusicSyncBar(track) {
  let icon = document.getElementById('chat-music-sync-icon');
  
  if (!icon) {
    // 创建音乐图标按钮
    icon = document.createElement('button');
    icon.id = 'chat-music-sync-icon';
    icon.type = 'button';
    icon.className = 'topbar-action music-sync-icon-btn';
    icon.title = '一起听音乐中';
    icon.onclick = toggleMusicSyncPopup;
    icon.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18V5l12-2v13"></path>
        <circle cx="6" cy="18" r="3"></circle>
        <circle cx="18" cy="16" r="3"></circle>
      </svg>
      <span class="music-sync-pulse-dot"></span>
    `;
    
    // 插入到顶栏设置按钮之前
    const topbarActions = document.querySelector('#chat-topbar .topbar-actions');
    const settingsBtn = topbarActions?.querySelector('button[onclick="openChatSettings()"]');
    if (topbarActions && settingsBtn) {
      topbarActions.insertBefore(icon, settingsBtn);
    }
  }
  
  // 更新图标状态和提示
  const status = track.status || 'playing';
  const title = track.title || '未知歌曲';
  const artist = track.artist || '未知艺术家';
  
  let tooltip = '一起听音乐中';
  if (status === 'connecting') {
    tooltip = '正在连接...';
    icon.classList.add('music-sync-connecting');
  } else if (status === 'paused') {
    tooltip = '音乐已暂停';
    icon.classList.add('music-sync-paused');
  } else {
    tooltip = `正在播放：${title} - ${artist}`;
    icon.classList.remove('music-sync-connecting', 'music-sync-paused');
  }
  
  icon.title = tooltip;
  icon.dataset.track = JSON.stringify({ title, artist, status });
}

/**
 * 移除音乐同步图标
 */
function removeMusicSyncBar() {
  const icon = document.getElementById('chat-music-sync-icon');
  if (icon) {
    icon.style.opacity = '0';
    icon.style.transform = 'scale(0.8)';
    setTimeout(() => {
      icon.remove();
      // 关闭弹窗（如果打开）
      const popup = document.getElementById('music-sync-popup');
      if (popup) popup.remove();
    }, 200);
  }
}

/**
 * 切换音乐同步弹窗
 */
function toggleMusicSyncPopup() {
  let popup = document.getElementById('music-sync-popup');
  
  if (popup) {
    // 关闭弹窗
    popup.classList.add('music-sync-popup-closing');
    setTimeout(() => popup.remove(), 200);
    return;
  }
  
  // 创建弹窗
  const icon = document.getElementById('chat-music-sync-icon');
  const trackData = icon?.dataset.track ? JSON.parse(icon.dataset.track) : {};
  const { title = '未知歌曲', artist = '未知艺术家', status = 'playing' } = trackData;
  
  let statusText = '正在播放';
  let statusIcon = '🎵';
  if (status === 'connecting') {
    statusText = '正在连接';
    statusIcon = '⏳';
  } else if (status === 'paused') {
    statusText = '已暂停';
    statusIcon = '⏸️';
  }
  
  popup = document.createElement('div');
  popup.id = 'music-sync-popup';
  popup.className = 'music-sync-popup';
  popup.innerHTML = `
    <div class="music-sync-popup-header">
      <div class="music-sync-popup-icon">${statusIcon}</div>
      <div class="music-sync-popup-title">一起听音乐</div>
    </div>
    <div class="music-sync-popup-content">
      <div class="music-sync-popup-status">${statusText}</div>
      <div class="music-sync-popup-track">
        <div class="music-sync-popup-track-title">${escapeHtml(title)}</div>
        <div class="music-sync-popup-track-artist">${escapeHtml(artist)}</div>
      </div>
    </div>
    <div class="music-sync-popup-actions">
      <button type="button" class="btn btn-ghost btn-sm" onclick="closeMusicSyncFromPopup()">停止同步</button>
    </div>
  `;
  
  document.body.appendChild(popup);
  
  // 点击外部关闭
  setTimeout(() => {
    document.addEventListener('click', closePopupOnClickOutside, { once: true });
  }, 100);
}

function closePopupOnClickOutside(e) {
  const popup = document.getElementById('music-sync-popup');
  const icon = document.getElementById('chat-music-sync-icon');
  if (popup && !popup.contains(e.target) && e.target !== icon && !icon?.contains(e.target)) {
    toggleMusicSyncPopup();
  }
}

/**
 * 构建音乐同步状态栏HTML
 */
export function buildMusicSyncBarHtml(track) {
  const status = track.status || 'playing';
  const title = track.title || '未知歌曲';
  const artist = track.artist || '未知艺术家';
  
  let statusIcon = '🎵';
  let statusText = '一起听音乐中';
  
  if (status === 'connecting') {
    statusIcon = '⏳';
    statusText = '正在连接...';
  } else if (status === 'paused') {
    statusIcon = '⏸️';
    statusText = '暂停中';
  }
  
  return `
    <div class="music-sync-icon">${statusIcon}</div>
    <div class="music-sync-info">
      <div class="music-sync-status">${statusText}</div>
      <div class="music-sync-track">
        <span class="music-sync-title">${escapeHtml(title)}</span>
        ${artist ? `<span class="music-sync-artist"> - ${escapeHtml(artist)}</span>` : ''}
      </div>
    </div>
    <button class="music-sync-close" onclick="closeMusicSync()">✕</button>
  `;
}

/**
 * 显示错误提示
 */
function showMusicSyncError(message) {
  window.showToast?.(message);
}

/**
 * HTML转义
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * 全局函数：关闭音乐同步
 */
window.closeMusicSync = function() {
  if (confirm('确定要停止一起听音乐吗？')) {
    stopMusicSync();
  }
};

/**
 * 从弹窗关闭音乐同步
 */
window.closeMusicSyncFromPopup = function() {
  toggleMusicSyncPopup(); // 先关闭弹窗
  setTimeout(() => {
    if (confirm('确定要停止一起听音乐吗？')) {
      stopMusicSync();
    }
  }, 250);
};

/**
 * 检查是否正在同步
 */
export function isMusicSyncActive() {
  return musicSyncActive;
}

/**
 * 获取当前同步的角色ID
 */
export function getCurrentSyncCharacterId() {
  return currentCharacterId;
}

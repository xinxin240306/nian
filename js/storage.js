/* ===== 本地存储层 ===== */

const PREFIX = 'nian_';

export function lsGet(key, defaultVal = null) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    if (v === null) return defaultVal;
    return JSON.parse(v);
  } catch { return defaultVal; }
}

export function lsSet(key, val) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch {}
}

export function lsDel(key) {
  localStorage.removeItem(PREFIX + key);
}

// 当前激活角色
export const getActiveCharId = () => lsGet('active_char_id', null);
export const setActiveCharId = (id) => lsSet('active_char_id', id);

// 通讯内设置缓存（按角色分开存：每个角色的气泡/背景/时间戳样式互不影响）
const CHAT_SETTINGS_DEFAULTS = {
  bubbleFontSizePx: 15,
  bubbleFontSize: 'medium',
  bubbleSizePct: 100,
  bubbleFont: 'sans',
  bubbleTextColor: 'black',
  bubbleGapPx: 5,
  timestampStyle: 'relative',
  timestampPosition: 'divider',
  readTagColor: 'black',
  showLocation: true,
  enterSend: false,
  videoCallLook: 'auto',
  videoCallLookSec: 12,
  avatarRadius: 50,
  bgType: 'gradient',
  bgValue: '',
};
// 旧版默认 showLocation:false，后来才接到工具栏隐藏逻辑，导致已保存设置的用户点「+」看不到「位置」。
// 启动时做一次迁移，把历史 false 纠正为 true；之后用户可在通讯设置里自行关闭。
function migrateShowLocationOnce() {
  if (lsGet('migrated_show_location_v1', false)) return;
  try {
    const prefix = PREFIX + 'chat_settings';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      try {
        const val = JSON.parse(localStorage.getItem(key));
        if (val && typeof val === 'object' && val.showLocation === false) {
          val.showLocation = true;
          localStorage.setItem(key, JSON.stringify(val));
        }
      } catch {}
    }
  } catch {}
  lsSet('migrated_show_location_v1', true);
}

// 不传 charId：读写旧版全局设置（迁移期兜底 + 头像等跨角色共用字段用它）
// 传 charId：优先读该角色自己保存过的设置；若该角色还没单独存过，兜底回退到旧版全局设置的「气泡样式」，
//           但绝不继承全局/别人的聊天壁纸（否则摇一摇新朋友会看起来像进了旧角色的聊天页）。
export const getChatSettings = (charId) => {
  migrateShowLocationOnce();
  let own = null;
  if (charId != null) {
    own = lsGet(`chat_settings_${charId}`, null);
  }
  const global = lsGet('chat_settings', null);
  if (own) return { ...CHAT_SETTINGS_DEFAULTS, ...own };
  if (charId != null) {
    if (global && typeof global === 'object') {
      const { bgType, bgValue, bgColor, ...rest } = global;
      return { ...CHAT_SETTINGS_DEFAULTS, ...rest };
    }
    return { ...CHAT_SETTINGS_DEFAULTS };
  }
  if (!global) return { ...CHAT_SETTINGS_DEFAULTS };
  return { ...CHAT_SETTINGS_DEFAULTS, ...global };
};
export const saveChatSettings = (v, charId) => {
  if (charId != null) lsSet(`chat_settings_${charId}`, v);
  else lsSet('chat_settings', v);
};

// 主题色缓存
export const getThemeColor = () => lsGet('theme_color', '#c9a0dc');
export const saveThemeColor = (c) => lsSet('theme_color', c);

// 背景设置缓存
export const getBgSettings = () => lsGet('bg_settings', { type: 'particle', value: '' });
export const saveBgSettings = (v) => lsSet('bg_settings', v);

// 秘密书架 · 书本封面（localStorage，key 如 shelf:user / shelf:ai:3 / shelf:shared:12 / toc:ai:3:diary）
export const getSecretBookCovers = () => lsGet('secret_book_covers', {});
export const setSecretBookCover = (key, url) => {
  const covers = getSecretBookCovers();
  if (url) covers[key] = url;
  else delete covers[key];
  lsSet('secret_book_covers', covers);
};
export const removeSecretBookCover = (key) => setSecretBookCover(key, null);

// 秘密本自定义显示名（shelf 级）
export const getSecretBookTitles = () => lsGet('secret_book_titles', {});
export const setSecretBookTitle = (key, title) => {
  const titles = getSecretBookTitles();
  const t = String(title || '').trim();
  if (t) titles[key] = t.slice(0, 64);
  else delete titles[key];
  lsSet('secret_book_titles', titles);
};
export const removeSecretBookTitle = (key) => setSecretBookTitle(key, null);

// 保存到桌面 / PWA 图标（URL 以服务端 settings.pwa_icon 为准，localStorage 仅作缓存）
export const getPwaIcon = () => lsGet('pwa_icon', '') || '';
export const savePwaIcon = (url) => { if (url) lsSet('pwa_icon', url); else lsDel('pwa_icon'); };

// 多条攒发消息队列
export const getPendingMessages = (charId) => lsGet(`pending_msgs_${charId}`, []);
export const savePendingMessages = (charId, msgs) => lsSet(`pending_msgs_${charId}`, msgs);

// 置顶角色
export const getPinnedCharIds = () => lsGet('pinned_char_ids', []);
export const savePinnedCharIds = (ids) => lsSet('pinned_char_ids', ids);
export const togglePinnedChar = (charId) => {
  const ids = getPinnedCharIds().map(String);
  const s = String(charId);
  const i = ids.indexOf(s);
  if (i >= 0) ids.splice(i, 1);
  else ids.unshift(s);
  savePinnedCharIds(ids);
  return ids.includes(s);
};

// 语音转文字展开状态
export const getVoiceTranscriptOpenMap = () => lsGet('voice_transcript_open', {});
export const setVoiceTranscriptOpen = (msgId, open) => {
  const map = getVoiceTranscriptOpenMap();
  const k = String(msgId);
  if (open) map[k] = 1;
  else delete map[k];
  lsSet('voice_transcript_open', map);
};

// 情绪状态词
export const getRelationStatus = (charId) => lsGet(`relation_${charId}`, '');
export const saveRelationStatus = (charId, status) => lsSet(`relation_${charId}`, status);

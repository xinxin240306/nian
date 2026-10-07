/* ===== 秘密簿 — 书架 + 分区 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import {
  ensureInlineEmojis,
  lookupInlineEmoji,
  openSystemEmojiOverlay,
  insertInlineEmojiAtCursor,
  renderInlineEmojiHtml,
} from '../inline-emoji.js';
import { pickCropAndUpload } from '../media-crop.js';
import { getSecretBookCovers, setSecretBookCover, removeSecretBookCover, getSecretBookTitles, setSecretBookTitle, lsGet, lsSet, lsDel } from '../storage.js';
import {
  PAPER_COLORS, PAPER_PATTERNS, FLIP_EFFECTS, DIARY_PAPERS, getPaperFonts, resolvePaperFont,
  resolvePaperAppearance, applyDiarySheetStyle,
  loadBookPaperSettings, saveBookPaperSettings, getBookPaperKey, getFlipDurationMs,
  isDiaryCustomBg, normalizePaperSettings, parseStoredPaper,
} from '../diary-paper.js';
import { ICON_MORE, ICON_BEAUTIFY, ICON_PLUS, ICON_TRASH, ICON_SETTINGS } from '../ui-icons.js';
ensureInlineEmojis().catch(() => {});

// view: 'shelf' | 'toc' | 'section' | 'shared'
let _view = 'shelf';
let _currentBook = null; // { type:'user'|'ai', charId, charName, charAvatar }
let _sharedBook = null; // { id, character_id, char_name, char_avatar, title }
let _section = 'diary'; // diary | user
let _editingId = null;
let _readingPages = []; // flip entries { title, content, peeks?, ... } — 通常只有当前这一篇
let _readingIdx = 0;
let _sliceIdx = 0;
let _sliceCount = 1;
let _slicePageH = 0;
let _renderedEntryKey = '';
let _readingActive = false;
let _readingTitleBackup = '';
let _flipDir = 1; // 1=下一页 -1=上一页
let _smDraft = { images: [], emojis: [] };
let _smWriting = false;
let _smCachedEntries = [];
let _smSessionByBook = new Map(); // bookId -> { book, entries, at }
let _shelfCache = null; // { diaries, sharedBooks, at }

function rememberSmSession(bookId, { book, entries } = {}) {
  if (!bookId) return;
  const prev = _smSessionByBook.get(Number(bookId)) || {};
  _smSessionByBook.set(Number(bookId), {
    book: book || prev.book || null,
    entries: entries != null ? entries : (prev.entries || []),
    at: Date.now(),
  });
}

function invalidateSmSession(bookId) {
  if (bookId == null) {
    _smSessionByBook.clear();
    _shelfCache = null;
    return;
  }
  _smSessionByBook.delete(Number(bookId));
  if (_shelfCache) _shelfCache.at = 0; // 强制下次书架刷新计数
}

function slimImageForCache(u) {
  const s = String(u || '').trim();
  if (!s || s.startsWith('data:')) return '';
  if (s.length > 400) return '';
  return s;
}

function slimSmEntryForCache(e) {
  if (!e) return e;
  const rawImgs = Array.isArray(e.images) ? e.images.filter(Boolean) : [];
  const img = slimImageForCache(rawImgs[0]);
  return {
    id: e.id,
    book_id: e.book_id,
    role: e.role,
    type: e.type,
    content: String(e.content || '').slice(0, 160),
    visible_at: e.visible_at,
    created_at: e.created_at,
    images: img ? [img] : [],
    emojis: Array.isArray(e.emojis) ? e.emojis.slice(0, 2) : [],
    annotations: [],
    _hasImage: !!(img || rawImgs.length || e._hasImage),
    _lite: 1,
  };
}

function slimSmBookForCache(book) {
  if (!book?.id) return null;
  return {
    id: book.id,
    character_id: book.character_id,
    title: book.title,
    char_name: book.char_name,
    char_avatar: book.char_avatar,
  };
}
let _smReadingDateKey = '';
let _smMarkSel = null;
let _smMarkSelectionBound = false;
let _phoneMemoEditId = null;

/* ─── 随手记本地缓存：历史天落盘，打开只刷今天 ─── */
function smPastCacheKey(bookId) {
  return `sm_past_entries_${bookId}`;
}

function readSmPastCache(bookId) {
  if (!bookId) return null;
  const raw = lsGet(smPastCacheKey(bookId), null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.past)) return null;
  return raw;
}

function writeSmPastCache(bookId, { past, today, todayAtSync, book } = {}) {
  if (!bookId) return;
  try {
    const prev = readSmPastCache(bookId) || {};
    const slimPast = (Array.isArray(past) ? past : []).map(slimSmEntryForCache);
    const slimToday = (Array.isArray(today) ? today : []).map(slimSmEntryForCache);
    lsSet(smPastCacheKey(bookId), {
      past: slimPast,
      today: slimToday,
      todayAtSync: String(todayAtSync || sharedMemoLocalToday()).slice(0, 10),
      book: slimSmBookForCache(book) || prev.book || null,
      savedAt: Date.now(),
    });
  } catch {
    // localStorage 满了就放弃落盘，不影响使用
  }
}

function clearSmPastCache(bookId) {
  if (!bookId) return;
  try { lsDel(smPastCacheKey(bookId)); } catch {}
  invalidateSmSession(bookId);
}

function upsertSmEntryInList(list, entry) {
  if (!entry?.id) return Array.isArray(list) ? list.slice() : [];
  const out = Array.isArray(list) ? list.slice() : [];
  const i = out.findIndex((e) => Number(e.id) === Number(entry.id));
  if (i >= 0) out[i] = preferRicherSmEntry(entry, out[i]);
  else out.push(entry);
  return out;
}

function smEntryImageCount(e) {
  return (Array.isArray(e?.images) ? e.images : []).filter(Boolean).length;
}

function smEntryIsLite(e) {
  return e?._lite === 1 || e?._lite === true;
}

/** 完整条目优先，避免目录精简版把原图/正文盖掉 */
function preferRicherSmEntry(next, prev) {
  if (!prev) return next;
  if (!next) return prev;
  const nextLite = smEntryIsLite(next);
  const prevLite = smEntryIsLite(prev);
  if (nextLite && !prevLite) return prev;
  if (!nextLite && prevLite) return next;
  const nextImgs = smEntryImageCount(next);
  const prevImgs = smEntryImageCount(prev);
  if (nextImgs !== prevImgs) return nextImgs > prevImgs ? next : prev;
  const nextLen = String(next.content || '').length;
  const prevLen = String(prev.content || '').length;
  if (nextLen !== prevLen) return nextLen > prevLen ? next : prev;
  const nextAnn = Array.isArray(next.annotations) ? next.annotations.length : 0;
  const prevAnn = Array.isArray(prev.annotations) ? prev.annotations.length : 0;
  if (nextAnn !== prevAnn) return nextAnn > prevAnn ? next : prev;
  return next;
}

function mergeSmEntriesById(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const e of list || []) {
      if (e?.id == null) continue;
      const id = Number(e.id);
      map.set(id, preferRicherSmEntry(e, map.get(id)));
    }
  }
  return [...map.values()].sort((a, b) => {
    const ta = String(a.visible_at || a.created_at || '');
    const tb = String(b.visible_at || b.created_at || '');
    return ta.localeCompare(tb) || (Number(a.id) - Number(b.id));
  });
}

/**
 * 有历史缓存时只请求今天（或跨日后的增量）；首次/强制才拉全量。
 */
async function loadSharedMemoEntriesSmart(bookId, { forceFull = false } = {}) {
  const today = sharedMemoLocalToday();
  const cache = !forceFull ? readSmPastCache(bookId) : null;
  const bookMeta = _sharedBook?.id === Number(bookId) ? _sharedBook : cache?.book;

  if (cache?.past && cache.todayAtSync) {
    try {
      if (cache.todayAtSync === today) {
        const todayEntries = await api.getSharedMemoEntries(bookId, { since: today });
        const merged = mergeSmEntriesById(cache.past, todayEntries);
        writeSmPastCache(bookId, {
          past: cache.past,
          today: todayEntries,
          todayAtSync: today,
          book: bookMeta,
        });
        return merged;
      }
      // 跨日：把「昨天当今天」的那段补进历史，再只留今天在线上
      const recent = await api.getSharedMemoEntries(bookId, { since: cache.todayAtSync });
      const promotedPast = mergeSmEntriesById(
        (cache.past || []).filter((e) => sharedMemoEntryDate(e) < today),
        (cache.today || []).filter((e) => sharedMemoEntryDate(e) < today),
        (recent || []).filter((e) => sharedMemoEntryDate(e) < today),
      );
      const todayEntries = (recent || []).filter((e) => sharedMemoEntryDate(e) >= today);
      writeSmPastCache(bookId, {
        past: promotedPast,
        today: todayEntries,
        todayAtSync: today,
        book: bookMeta,
      });
      return mergeSmEntriesById(promotedPast, todayEntries);
    } catch (e) {
      console.warn('[shared-memo] incremental load failed, fallback full', e?.message || e);
    }
  }

  const all = await api.getSharedMemoEntries(bookId);
  const past = (all || []).filter((e) => sharedMemoEntryDate(e) < today);
  const todayEntries = (all || []).filter((e) => sharedMemoEntryDate(e) >= today);
  writeSmPastCache(bookId, { past, today: todayEntries, todayAtSync: today, book: bookMeta });
  return all || [];
}

/** 写入/批注后：用返回条目或只刷今天更新内存+历史缓存 */
async function refreshSharedMemoAfterWrite({ entry, forceFull = false } = {}) {
  if (!_sharedBook?.id) return;
  const today = sharedMemoLocalToday();
  if (forceFull) {
    _smCachedEntries = mergeSmEntriesById(
      _smCachedEntries,
      await loadSharedMemoEntriesSmart(_sharedBook.id, { forceFull: true }),
    );
    rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
    return;
  }
  if (entry?.id) {
    _smCachedEntries = upsertSmEntryInList(_smCachedEntries, entry);
    const d = sharedMemoEntryDate(entry);
    const cache = readSmPastCache(_sharedBook.id) || { past: [], today: [], todayAtSync: today };
    if (d < today) {
      writeSmPastCache(_sharedBook.id, {
        past: upsertSmEntryInList(cache.past || [], entry),
        today: cache.today || [],
        todayAtSync: cache.todayAtSync || today,
        book: _sharedBook,
      });
      rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
      if (_shelfCache) _shelfCache.at = 0;
      return; // 历史天只改本地，不重拉全本
    }
    // 今天：已有完整条目时直接写本地缓存，避免再等一轮列表请求卡住纸页
    const todayPrev = (cache.todayAtSync === today ? (cache.today || []) : [])
      .filter((e) => sharedMemoEntryDate(e) >= today);
    writeSmPastCache(_sharedBook.id, {
      past: (cache.past || []).filter((e) => sharedMemoEntryDate(e) < today),
      today: upsertSmEntryInList(todayPrev, entry),
      todayAtSync: today,
      book: _sharedBook,
    });
    rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
    if (_shelfCache) _shelfCache.at = 0;
    return;
  }
  try {
    const todayEntries = await api.getSharedMemoEntries(_sharedBook.id, { since: today });
    const past = (_smCachedEntries || []).filter((e) => sharedMemoEntryDate(e) < today);
    const cache = readSmPastCache(_sharedBook.id);
    const pastSrc = (past.length ? past : (cache?.past || []))
      .filter((e) => sharedMemoEntryDate(e) < today);
    _smCachedEntries = mergeSmEntriesById(_smCachedEntries, pastSrc, todayEntries);
    writeSmPastCache(_sharedBook.id, {
      past: pastSrc,
      today: todayEntries,
      todayAtSync: today,
      book: _sharedBook,
    });
  } catch {
    _smCachedEntries = mergeSmEntriesById(
      _smCachedEntries,
      await loadSharedMemoEntriesSmart(_sharedBook.id, { forceFull: true }),
    );
  }
  rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
  if (_shelfCache) _shelfCache.at = 0;
}

const BOOK_COLORS = ['#c9a0dc','#e8a0c4','#a0b8e8','#d4b896','#9fd4b8','#c9b8e8'];

function secretBookCoverKey(kind, ...parts) {
  return [kind, ...parts.map(p => String(p ?? ''))].join(':');
}

function resolveSecretBookCoverHtml(coverKey, avatar, emoji) {
  const custom = getSecretBookCovers()[coverKey];
  if (custom) return `<img class="secret-book-cover-img" src="${escapeHtml(custom)}" alt="">`;
  if (avatar) return `<img class="secret-book-cover-img" src="${escapeHtml(avatar)}" alt="">`;
  return `<div class="secret-book-cover-fallback">${emoji}</div>`;
}

function secretBookCoverEditBtn(coverKey) {
  const safe = coverKey.replace(/'/g, "\\'");
  const hasCustom = !!getSecretBookCovers()[coverKey];
  return `<div class="secret-notebook-cover-tools">
    <button type="button" class="secret-book-cover-edit" title="换封面"
      onclick="event.stopPropagation();pickSecretBookCover('${safe}')">🖼</button>${
    hasCustom ? `<button type="button" class="secret-book-cover-reset" title="恢复默认封面"
      onclick="event.stopPropagation();resetSecretBookCover('${safe}')">↺</button>` : ''
  }</div>`;
}

function wrapSecretBook(coverKey, color, innerButtonHtml) {
  return `<div class="secret-book-wrap" style="--book-color:${color || 'var(--theme)'}">
    ${innerButtonHtml}
  </div>`;
}

function secretCurrentShelfCoverKey() {
  if (_sharedBook) return secretBookCoverKey('shelf', 'shared', _sharedBook.id);
  if (!_currentBook) return null;
  const ownerId = _currentBook.type === 'user' ? 'user' : _currentBook.charId;
  return secretBookCoverKey('shelf', _currentBook.type, ownerId);
}

function secretCurrentTitleKey() {
  if (_sharedBook) return null;
  if (!_currentBook) return null;
  const ownerId = _currentBook.type === 'user' ? 'user' : _currentBook.charId;
  return `shelf:${_currentBook.type}:${ownerId}`;
}

function secretBookDisplayTitle(bookLike) {
  // 随手记对象（无 type 字段）
  if (bookLike && bookLike.id != null && bookLike.type == null && (bookLike.character_id != null || bookLike.char_name != null || bookLike.title != null)) {
    return sharedMemoDisplayTitle(bookLike);
  }
  const b = bookLike || _currentBook;
  if (!b) return '秘密';
  const ownerId = b.type === 'user' ? 'user' : b.charId;
  const key = `shelf:${b.type}:${ownerId}`;
  const custom = getSecretBookTitles()[key];
  if (custom) return custom;
  return b.charName || (b.type === 'user' ? '我的秘密' : '秘密');
}

async function refreshSecretBookViews() {
  if (_view === 'shelf') await showShelf();
  else if (_view === 'toc') await showSectionToc();
}

window.pickSecretBookCover = async function(coverKey) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,image/gif,image/webp';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { window.showToast?.('图片不能超过 4MB'); return; }
    try {
      const result = await pickCropAndUpload(file, { title: '裁剪书封面', aspect: 3 / 4 });
      if (!result?.url) return;
      setSecretBookCover(coverKey, result.url);
      window.showToast?.('封面已更换');
      await refreshSecretBookViews();
    } catch (e) {
      window.showToast?.(e.message || '上传失败');
    }
  };
  input.click();
};

window.resetSecretBookCover = async function(coverKey) {
  removeSecretBookCover(coverKey);
  window.showToast?.('已恢复默认封面');
  await refreshSecretBookViews();
};

const SECTION_META = {
  diary: { label: '日记', icon: '📔' },
  memo:  { label: '备忘录', icon: '📝' },
  us:    { label: '我们', icon: '💞' },
  heart: { label: '心事', icon: '💭' },
};

function userSections() { return ['diary', 'memo']; }
function aiSections() { return ['diary']; }
const SECTION_HINTS = {
  diary: '按月份折叠，点日期翻开；写太长可在页内往下划',
  memo: '像手机备忘录，不限格式，想写什么都行',
  us: '（已改为随手记）',
  heart: '（已停用）',
};

window.initDiaryPage = async function() {
  const page = document.getElementById('diary-page');
  const initBook = window._secretBookInit || null;
  window._secretBookInit = null;

  if (page.dataset.shellBuilt !== 'secret-ui-v8') {
  page.innerHTML = `
    <div class="topbar secret-topbar" id="diary-topbar">
      <button type="button" class="topbar-back topbar-nav-back" id="diary-back-btn" onclick="diaryGoBack()" title="返回"></button>
      <div class="topbar-title" id="diary-topbar-title">🔐 秘密</div>
      <div class="topbar-actions" id="diary-topbar-actions">
        <div id="diary-reading-extra" class="topbar-actions diary-reading-extra" style="display:none"></div>
        <button type="button" class="topbar-action" id="diary-beautify-btn" onclick="openShelfBeautifyPick()" title="美化" style="display:none">${ICON_BEAUTIFY}</button>
        <button type="button" class="topbar-action" id="diary-paper-settings-btn" onclick="openSecretPaperSettings()" title="纸张设置" style="display:none">${ICON_SETTINGS}</button>
        <button type="button" class="topbar-action topbar-action-danger" id="diary-del-btn" onclick="openShelfDeletePick()" title="删除随手记" style="display:none">${ICON_TRASH}</button>
        <button type="button" class="topbar-action" id="diary-add-btn" onclick="diaryAddEntry()" title="写一篇" style="display:none">${ICON_PLUS}</button>
      </div>
    </div>
    <div class="scroll-area secret-page-scroll" id="diary-content"></div>

    <div id="diary-edit-overlay" class="overlay fullscreen" style="z-index:200">
      <div class="sheet-full" id="diary-edit-sheet" style="background:var(--diary-paper-bg,var(--chrome-white,#ededed))">
        <div class="sheet-full-topbar secret-sheet-topbar">
          <button type="button" class="topbar-back topbar-nav-back" onclick="closeDiaryEdit()" title="返回"></button>
          <div class="sheet-full-title" id="diary-edit-modal-title">写日记</div>
          <div class="topbar-actions">
            <button type="button" class="topbar-action" onclick="openSecretPaperSettings()" title="纸张设置">${ICON_SETTINGS}</button>
            <button type="button" class="topbar-save" onclick="saveDiaryEntry()" title="保存"></button>
          </div>
        </div>
        <div class="secret-edit-body">
          <input type="date" class="input secret-edit-field" id="diary-date-input">
          <input type="text" class="input secret-edit-field" id="diary-title-input" placeholder="标题（选填）…">
          <textarea class="input secret-edit-textarea" id="diary-content-input" placeholder="记录今天…"></textarea>
          <div id="shared-memo-edit-media" class="shared-memo-edit-media" style="display:none">
            <div class="shared-memo-draft" id="shared-memo-draft"></div>
            <div class="shared-memo-toolbar">
              <button type="button" class="shared-memo-tool-btn" onclick="(function(){const el=document.getElementById('shared-memo-image-input');if(el){el.value='';el.click();}})()" title="贴图">🖼</button>
              <button type="button" class="shared-memo-tool-btn" onclick="openSharedMemoEmojiPick()" title="表情包">☺</button>
              <span class="shared-memo-tool-hint">贴图 / 表情 · 跟字迹挤在一起就行</span>
            </div>
          </div>
          <div id="diary-visible-wrap" class="secret-visible-wrap">
            <div class="secret-visible-label">🔒 谁能偷看这篇（不选则仅自己）</div>
            <div id="diary-visible-chars" class="secret-visible-chars"></div>
          </div>
        </div>
        <input type="file" id="diary-bg-upload" accept="image/*" style="display:none" onchange="applyCustomDiaryBg(this)">
      </div>
    </div>

    <div id="diary-view-overlay" class="overlay fullscreen secret-reader-docked" style="z-index:40">
      <div class="sheet-full secret-flip-stage" id="diary-view-sheet">
        <div class="sheet-full-topbar secret-sheet-topbar" id="diary-view-topbar" hidden>
          <button type="button" class="topbar-back topbar-nav-back" onclick="closeDiaryView()" title="返回"></button>
          <div class="sheet-full-title" id="diary-view-modal-title"></div>
          <div class="topbar-actions" id="diary-view-actions"></div>
        </div>
        <div class="secret-flip-nav" id="secret-flip-nav" hidden>
          <button type="button" class="secret-flip-btn" onclick="secretFlipPrev()" aria-label="上一页" title="上一页">‹</button>
          <span id="secret-flip-indicator" class="secret-flip-indicator"></span>
          <button type="button" class="secret-flip-btn" onclick="secretFlipNext()" aria-label="下一页" title="下一页">›</button>
        </div>
        <div class="secret-flip-viewport" id="secret-flip-viewport">
          <div class="secret-flip-stack">
            <div class="secret-flip-under" id="secret-flip-under" aria-hidden="true"></div>
            <div class="secret-flip-page" id="secret-flip-page">
              <div class="secret-flip-curl" aria-hidden="true"></div>
              <div class="sheet-full-body secret-flip-body">
                <div id="diary-view-content" class="secret-flip-content"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="secret-paper-settings-overlay" class="overlay fullscreen" style="z-index:220">
      <div class="sheet-full secret-paper-settings-sheet">
        <div class="sheet-full-topbar secret-sheet-topbar">
          <button type="button" class="topbar-back topbar-nav-back" onclick="closeSecretPaperSettings()" title="返回"></button>
          <div class="sheet-full-title">纸张设置</div>
          <button type="button" class="topbar-save" onclick="closeSecretPaperSettings()" title="完成"></button>
        </div>
        <div class="secret-paper-settings-body scroll-area scroll-area-native settings-panel-cards">
        <div class="secret-paper-scope-hint">仅对本本生效 · 颜色 / 纹样 / 翻开互不捆绑</div>

        <div class="form-group">
        <div class="input-label">纸张颜色</div>
        <div class="secret-paper-swatch-row" id="secret-paper-color-list"></div>
        <div class="secret-paper-color-tools">
          <label class="secret-paper-tool-btn">取色
            <input type="color" id="secret-paper-color-picker" value="#faf6ee" oninput="setSecretPaperColor(this.value)">
          </label>
          <button type="button" class="secret-paper-tool-btn" onclick="document.getElementById('diary-bg-upload').click()">上传图片</button>
        </div>
        </div>

        <div class="form-group">
        <div class="input-label">纸张样式</div>
        <div class="tag-list" id="secret-paper-pattern-list"></div>
        </div>

        <div class="form-group">
        <div class="input-label">翻开效果</div>
        <div class="tag-list" id="secret-paper-flip-list"></div>
        </div>

        <div id="secret-paper-voice-settings" class="form-group" style="display:none">
          <div class="input-label">字体样式 · 我的字迹</div>
          <div class="secret-paper-font-list" id="secret-paper-user-font-list"></div>
          <div class="input-label" style="margin-top:10px">字体样式 · TA的字迹</div>
          <div class="secret-paper-font-list" id="secret-paper-ai-font-list"></div>
          <div class="secret-paper-ink-row" style="margin-top:10px">
            <label class="secret-paper-tool-btn">我的墨色
              <input type="color" id="secret-paper-user-ink" value="#3a3228" oninput="setSecretPaperUserInk(this.value)">
            </label>
            <label class="secret-paper-tool-btn">TA的墨色
              <input type="color" id="secret-paper-ai-ink" value="#5a4a78" oninput="setSecretPaperAiInk(this.value)">
            </label>
          </div>
          <div class="secret-paper-size-row" style="margin-top:12px">
            <label class="secret-paper-size-label">我的字号
              <input type="range" id="secret-paper-user-size" min="13" max="22" step="1" value="16"
                oninput="setSecretPaperUserFontSize(this.value);document.getElementById('secret-paper-user-size-val').textContent=this.value+'px'">
              <span id="secret-paper-user-size-val">16px</span>
            </label>
            <label class="secret-paper-size-label">TA的字号
              <input type="range" id="secret-paper-ai-size" min="13" max="22" step="1" value="16"
                oninput="setSecretPaperAiFontSize(this.value);document.getElementById('secret-paper-ai-size-val').textContent=this.value+'px'">
              <span id="secret-paper-ai-size-val">16px</span>
            </label>
          </div>
          <div class="input-label" style="margin-top:14px">批注颜色</div>
          <div class="secret-paper-ink-row secret-paper-mark-colors">
            <label class="secret-paper-tool-btn">圈词
              <input type="color" id="secret-paper-mark-circle" value="#c45c5c" oninput="setSecretPaperMarkColor('markCircle',this.value)">
            </label>
            <label class="secret-paper-tool-btn">划掉
              <input type="color" id="secret-paper-mark-strike" value="#8b5a2b" oninput="setSecretPaperMarkColor('markStrike',this.value)">
            </label>
            <label class="secret-paper-tool-btn">划线
              <input type="color" id="secret-paper-mark-line" value="#2a6f9e" oninput="setSecretPaperMarkColor('markLine',this.value)">
            </label>
            <label class="secret-paper-tool-btn">旁注
              <input type="color" id="secret-paper-mark-note" value="#6b4ea0" oninput="setSecretPaperMarkColor('markNote',this.value)">
            </label>
          </div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:6px">同页用字迹区分；长按选词可圈/划/旁注，会存到本子里</div>
        </div>
        </div>
      </div>
    </div>

    <div id="memo-edit-overlay" class="overlay fullscreen" style="z-index:205">
      <div class="sheet-full" style="background:var(--chrome-white,#ededed)">
        <div class="sheet-full-topbar secret-sheet-topbar">
          <button type="button" class="topbar-back topbar-nav-back" onclick="closePhoneMemoEditor()" title="返回"></button>
          <div class="sheet-full-title">备忘录</div>
          <button type="button" class="topbar-save" onclick="savePhoneMemo()" title="保存"></button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:12px 16px">
          <textarea class="input" id="memo-content-input"
            style="min-height:calc(100vh - 140px);resize:none;font-size:15px;line-height:1.75;
              border:none;background:transparent;box-shadow:none;padding:0"
            placeholder="想写什么都行，不限格式…"></textarea>
        </div>
        <div style="padding:8px 16px 20px;display:flex;align-items:center;justify-content:space-between">
          <button type="button" class="btn btn-ghost btn-sm" id="memo-delete-btn" style="color:#e57373;display:none" onclick="deletePhoneMemo()">删除</button>
          <span style="font-size:11px;color:var(--text-secondary)" id="memo-edit-time"></span>
        </div>
      </div>
    </div>

    <div id="secret-note-edit-overlay" class="overlay center" style="z-index:210" onclick="if(event.target===this)closeSecretNoteEdit()">
      <div class="modal" style="max-width:360px;width:90%" onclick="event.stopPropagation()">
        <div class="modal-title" id="secret-note-edit-title">添加短条</div>
        <input type="text" class="input" id="secret-note-title" placeholder="见面后想做的事，如：一起看《花样年华》" style="margin:10px 0;display:none">
        <textarea class="input" id="secret-note-content" rows="3" placeholder="一句话…" style="margin:10px 0"></textarea>
        <input type="datetime-local" class="input" id="secret-note-at" style="margin-bottom:12px">
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="closeSecretNoteEdit()">取消</button>
          <button class="btn btn-primary btn-sm" onclick="saveSecretNoteEdit()">保存</button>
        </div>
      </div>
    </div>

    <div id="shared-memo-char-pick" class="overlay fullscreen" style="z-index:220;display:none">
      <div class="sheet-full">
        <div class="sheet-full-topbar secret-sheet-topbar">
          <button type="button" class="topbar-back topbar-nav-back" onclick="closeSharedMemoCharPick()" title="返回"></button>
          <div class="sheet-full-title">添加随手记</div>
          <div style="width:42px"></div>
        </div>
        <div class="sheet-full-body settings-panel-cards" style="padding-top:16px">
          <div class="secret-paper-scope-hint">选一个角色，和他开一本共用的随手记。每个角色只能有一本。</div>
          <div id="shared-memo-char-list" class="shared-memo-char-grid"></div>
        </div>
      </div>
    </div>

    <div id="secret-shelf-pick" class="overlay fullscreen" style="z-index:225;display:none">
      <div class="sheet-full">
        <div class="sheet-full-topbar secret-sheet-topbar">
          <button type="button" class="topbar-back topbar-nav-back" onclick="closeShelfPick()" title="返回"></button>
          <div class="sheet-full-title" id="secret-shelf-pick-title">选择</div>
          <div style="width:42px"></div>
        </div>
        <div class="sheet-full-body settings-panel-cards" style="padding-top:16px">
          <div class="secret-paper-scope-hint" id="secret-shelf-pick-hint"></div>
          <div id="secret-shelf-pick-list" class="shared-memo-char-grid"></div>
        </div>
      </div>
    </div>

    <div id="secret-beautify-overlay" class="overlay fullscreen" style="z-index:230;display:none">
      <div class="sheet-full">
        <div class="sheet-full-topbar secret-sheet-topbar">
          <button type="button" class="topbar-back topbar-nav-back" onclick="closeSecretBeautify()" title="返回"></button>
          <div class="sheet-full-title">美化</div>
          <button type="button" class="topbar-save" onclick="saveSecretBeautify()" title="保存"></button>
        </div>
        <div class="sheet-full-body settings-panel-cards" style="padding-top:16px">
          <div class="form-group">
            <label class="input-label">名称</label>
            <input type="text" class="input" id="secret-beautify-title" maxlength="64" placeholder="和TA的随手记">
          </div>
          <div class="form-group">
            <label class="input-label">封面</label>
            <div class="secret-beautify-cover-row">
              <div class="secret-beautify-cover-preview" id="secret-beautify-cover-preview"></div>
              <div class="secret-beautify-cover-actions">
                <button type="button" class="btn btn-ghost btn-sm" onclick="pickSecretBeautifyCover()">换封面</button>
                <button type="button" class="btn btn-ghost btn-sm" id="secret-beautify-cover-reset" onclick="resetSecretBeautifyCover()" style="display:none">恢复默认</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="shared-memo-emoji-pick" class="overlay center" style="z-index:240;display:none" onclick="if(event.target===this)closeSharedMemoEmojiPick()">
      <div class="modal" style="max-width:380px;width:92%;max-height:70vh;display:flex;flex-direction:column" onclick="event.stopPropagation()">
        <div class="modal-title">选表情包</div>
        <div id="shared-memo-emoji-cats" style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0"></div>
        <div id="shared-memo-emoji-grid" style="flex:1;overflow:auto;display:grid;grid-template-columns:repeat(5,1fr);gap:8px;min-height:120px"></div>
        <div style="display:flex;justify-content:flex-end;margin-top:12px">
          <button class="btn btn-ghost btn-sm" onclick="closeSharedMemoEmojiPick()">关闭</button>
        </div>
      </div>
    </div>
    <input type="file" id="shared-memo-image-input" accept="image/*" style="display:none" onchange="onSharedMemoImagePicked(this)">
  `;
  page.dataset.shellBuilt = 'secret-ui-v8';
  }

  if (initBook?.type === 'shared' && initBook.bookId) {
    await openSharedMemoBook(initBook.bookId);
  } else if (initBook?.type === 'ai' && initBook.charId) {
    if (initBook.section === 'user') {
      window._memoryInitTab = 'portrait';
      window.navigateTo?.('memory');
      return;
    }
    await openDiaryBook('ai', initBook.charId, initBook.charName || '', initBook.charAvatar || '');
    if (initBook.section && initBook.section !== 'us') await openSecretSection(initBook.section);
  } else {
    await showShelf();
  }
};

async function showShelf() {
  _view = 'shelf';
  _currentBook = null;
  _sharedBook = null;
  _beautifyContext = null;
  const backBtn = document.getElementById('diary-back-btn');
  backBtn.onclick = () => window.goBack?.();
  backBtn.style.display = '';
  const addBtn = document.getElementById('diary-add-btn');
  addBtn.style.display = 'none';
  const settingsBtn = document.getElementById('diary-paper-settings-btn');
  if (settingsBtn) settingsBtn.style.display = 'none';
  // 主页点进秘密后的顶栏：美化（随手记已迁到 TA）
  const delBtn = document.getElementById('diary-del-btn');
  if (delBtn) {
    delBtn.style.display = 'none';
  }
  const beautifyBtn = document.getElementById('diary-beautify-btn');
  if (beautifyBtn) {
    beautifyBtn.style.display = '';
    beautifyBtn.title = '美化';
    beautifyBtn.onclick = () => window.openShelfBeautifyPick();
  }
  document.getElementById('diary-topbar-title').textContent = '🔐 秘密';

  const content = document.getElementById('diary-content');
  content.style.background = '';
  content.style.minHeight = '';
  content.style.position = '';
  const oldPat = content.querySelector('.secret-paper-pattern');
  if (oldPat) oldPat.remove();

  const cacheFresh = _shelfCache && (Date.now() - (_shelfCache.at || 0) < 30_000);
  if (_shelfCache?.diaries && _shelfCache?.sharedBooks) {
    paintShelf(_shelfCache.diaries, _shelfCache.sharedBooks);
    if (cacheFresh) return;
  } else {
    content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  }

  try {
    const chars = window.getAppCharacters?.() || [];
    void chars;
    const [allDiaries] = await Promise.all([
      api.getDiaries({ meta: '1' }),
    ]);
    _shelfCache = { diaries: allDiaries, sharedBooks: [], at: Date.now() };
    paintShelf(allDiaries, []);
  } catch (e) {
    if (!_shelfCache) {
      content.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message)}</div></div>`;
    }
  }
}

function paintShelf(allDiaries, sharedBooks) {
  const content = document.getElementById('diary-content');
  if (!content || _view !== 'shelf') return;
  const chars = window.getFriendCharacters?.() || window.getAppCharacters?.() || [];
  const userDiaryCount = (allDiaries || []).filter(d => d.role === 'user' && !d.character_id).length;

  let html = `<div class="secret-home">
      <div class="secret-home-hero">
        <div class="secret-home-kicker">SECRET</div>
        <div class="secret-home-title">秘密书架</div>
        <div class="secret-home-desc">封面与名称可在右上角美化 · 点开本子翻页阅读</div>
      </div>`;
  html += `<div class="secret-section-label">秘密本</div>`;
  html += `<div class="secret-notebook-grid">`;
  html += buildBookCard({
    type: 'user', charId: null, charName: '我的秘密', charAvatar: null,
    count: userDiaryCount, color: BOOK_COLORS[0],
  });
  chars.forEach((c, i) => {
    const dCount = (allDiaries || []).filter(d => d.role === 'ai' && d.character_id == c.id).length;
    html += buildBookCard({
      type: 'ai', charId: c.id, charName: c.name, charAvatar: c.avatar,
      count: dCount, color: BOOK_COLORS[(i + 1) % BOOK_COLORS.length],
    });
  });
  html += `</div></div>`;
  content.innerHTML = html;
}

function buildSharedMemoCard(book, color) {
  const name = escapeHtml(sharedMemoDisplayTitle(book));
  const coverKey = secretBookCoverKey('shelf', 'shared', book.id);
  const coverImg = resolveSecretBookCoverHtml(coverKey, book.char_avatar, '📝');
  return `
    <div class="secret-notebook-card" style="--book-color:${color}">
      <button type="button" class="secret-notebook" onclick="openSharedMemoBook(${book.id})">
        <div class="secret-notebook-cover">${coverImg}</div>
        <div class="secret-notebook-body">
          <div class="secret-notebook-title">${name}</div>
          <div class="secret-notebook-meta">${book.entry_count || 0} 条 · 随手记</div>
        </div>
      </button>
    </div>
  `;
}

function sharedMemoDisplayTitle(book) {
  const name = book?.char_name || 'TA';
  const raw = String(book?.title || '').trim();
  // 旧默认名带「备忘」的忽略；其余自定义名（含「和xx的随手记」）原样显示
  if (raw && !/备忘/.test(raw)) return raw;
  return `和${name}的随手记`;
}

function buildBookCard({ type, charId, charName, charAvatar, count, color }) {
  const label = type === 'ai' ? 'TA的秘密' : '我的秘密';
  const safeName = escapeHtml(charName).replace(/'/g, "\\'");
  const clickFn = `openDiaryBook('${type}', ${charId || 'null'}, '${safeName}', '${charAvatar || ''}')`;
  const coverKey = secretBookCoverKey('shelf', type, type === 'user' ? 'user' : charId);
  const emoji = type === 'user' ? '🔐' : '📖';
  const coverImg = resolveSecretBookCoverHtml(coverKey, charAvatar, emoji);
  const title = secretBookDisplayTitle({ type, charId, charName });
  return `
    <div class="secret-notebook-card" style="--book-color:${color}">
      <button type="button" class="secret-notebook" onclick="${clickFn}">
        <div class="secret-notebook-cover">${coverImg}</div>
        <div class="secret-notebook-body">
          <div class="secret-notebook-title">${escapeHtml(title)}</div>
          <div class="secret-notebook-meta">${count} 篇 · ${label}</div>
        </div>
      </button>
    </div>
  `;
}

window.openDiaryBook = async function(type, charId, charName, charAvatar) {
  _currentBook = { type, charId, charName, charAvatar };
  const sections = type === 'user' ? userSections() : aiSections();
  if (!sections.includes(_section)) _section = 'diary';

  const backBtn = document.getElementById('diary-back-btn');
  backBtn.onclick = diaryGoBack;
  backBtn.style.display = '';

  await showSectionToc();
};

async function showSectionToc() {
  _view = 'toc';
  if (!_currentBook) return showShelf();
  const { type, charName } = _currentBook;
  const sections = type === 'user' ? userSections() : aiSections();

  document.getElementById('diary-add-btn').style.display = 'none';
  const settingsBtn = document.getElementById('diary-paper-settings-btn');
  if (settingsBtn) settingsBtn.style.display = 'none';
  const delBtn = document.getElementById('diary-del-btn');
  if (delBtn) delBtn.style.display = 'none';
  const beautifyBtn = document.getElementById('diary-beautify-btn');
  if (beautifyBtn) beautifyBtn.style.display = 'none';
  document.getElementById('diary-topbar-title').textContent =
    secretBookDisplayTitle(_currentBook);

  const content = document.getElementById('diary-content');
  content.style.background = '';
  content.style.minHeight = '';
  content.style.position = '';
  const oldPat = content.querySelector('.secret-paper-pattern');
  if (oldPat) oldPat.remove();

  let html = `<div class="secret-home">
    <div class="secret-home-hero">
      <div class="secret-home-kicker">CHAPTERS</div>
      <div class="secret-home-title">${escapeHtml(secretBookDisplayTitle(_currentBook))}</div>
      <div class="secret-home-desc">选择一个分区翻开 · 右上角可美化封面与名称</div>
    </div>
    <div class="secret-notebook-grid">`;
  const ownerId = _currentBook.type === 'user' ? 'user' : _currentBook.charId;
  sections.forEach((s, i) => {
    const m = SECTION_META[s];
    const coverKey = secretBookCoverKey('toc', _currentBook.type, ownerId, s);
    const coverImg = resolveSecretBookCoverHtml(coverKey, '', m.icon);
    html += `
    <div class="secret-notebook-card" style="--book-color:${BOOK_COLORS[i % BOOK_COLORS.length]}">
      <button type="button" class="secret-notebook" onclick="openSecretSection('${s}')">
        <div class="secret-notebook-cover">${coverImg}</div>
        <div class="secret-notebook-body">
          <div class="secret-notebook-title">${escapeHtml(m.label)}</div>
          <div class="secret-notebook-meta">${escapeHtml(SECTION_HINTS[s] || '')}</div>
        </div>
      </button>
    </div>`;
  });
  html += `</div></div>`;
  content.innerHTML = html;
}

window.openSecretSection = async function(sec) {
  if (!_currentBook) return;
  if (sec === 'user' && _currentBook.type === 'ai') {
    window._memoryInitTab = 'portrait';
    window.navigateTo?.('memory');
    return;
  }
  const sections = _currentBook.type === 'user' ? userSections() : aiSections();
  if (!sections.includes(sec)) sec = 'diary';
  _section = sec;
  _view = 'section';
  const name = secretBookDisplayTitle(_currentBook);
  const label = SECTION_META[sec]?.label || sec;
  document.getElementById('diary-topbar-title').textContent = `${name} · ${label}`;
  const settingsBtn = document.getElementById('diary-paper-settings-btn');
  if (settingsBtn) settingsBtn.style.display = sec === 'memo' ? 'none' : '';
  const beautifyBtn = document.getElementById('diary-beautify-btn');
  if (beautifyBtn) beautifyBtn.style.display = 'none';
  const delBtn = document.getElementById('diary-del-btn');
  if (delBtn) delBtn.style.display = 'none';
  updateAddBtn();
  await renderBookSection();
};

function updateAddBtn() {
  const addBtn = document.getElementById('diary-add-btn');
  const delBtn = document.getElementById('diary-del-btn');
  const beautifyBtn = document.getElementById('diary-beautify-btn');
  const onShared = _view === 'shared' && !!_sharedBook;
  // 美化 / 删除只在「主页→秘密」书架顶栏；点进随手记或秘密本后不再显示
  if (_view === 'shelf') {
    if (beautifyBtn) {
      beautifyBtn.style.display = '';
      beautifyBtn.onclick = () => window.openShelfBeautifyPick();
    }
    if (delBtn) delBtn.style.display = 'none';
  } else {
    if (beautifyBtn) beautifyBtn.style.display = 'none';
    if (delBtn) delBtn.style.display = 'none';
  }
  // 阅读某一天/某一篇时，写入已改为直接点内容区触发，顶栏「+」不再重复出现
  if (_readingActive) {
    if (addBtn) addBtn.style.display = 'none';
    return;
  }
  if (onShared) {
    addBtn.style.display = '';
    addBtn.innerHTML = ICON_PLUS;
    addBtn.title = '写随手记';
    addBtn.onclick = () => window.openSharedMemoWrite();
    return;
  }
  if (!_currentBook || _view !== 'section') { addBtn.style.display = 'none'; return; }
  const { type } = _currentBook;
  if (type === 'user' && _section === 'diary') {
    addBtn.style.display = '';
    addBtn.innerHTML = ICON_PLUS;
    addBtn.title = '写日记';
    addBtn.onclick = () => diaryAddEntry();
  } else if (type === 'user' && _section === 'memo') {
    addBtn.style.display = '';
    addBtn.innerHTML = ICON_PLUS;
    addBtn.title = '新建备忘录';
    addBtn.onclick = () => openPhoneMemoEditor(null);
  } else if (type === 'ai' && _section === 'diary') {
    addBtn.style.display = '';
    addBtn.textContent = '↻';
    addBtn.title = '补齐缺失日记';
    addBtn.onclick = manualGenerateAiDiary;
  } else {
    addBtn.style.display = 'none';
  }
}

window.switchSecretSection = async function(sec) {
  await openSecretSection(sec);
};

async function renderBookSection() {
  const content = document.getElementById('diary-content');
  content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

  try {
    if (_section === 'us' || _section === 'heart') {
      _section = 'diary';
    }
    let body = '';
    if (_section === 'diary') body = await renderDiaryListHtml();
    else if (_section === 'memo') body = await renderPhoneMemoListHtml();

    content.innerHTML = `<div class="secret-section-body" style="position:relative;z-index:1">
      <div class="secret-open-desk">
        <div class="secret-open-book is-list">
          <div class="secret-open-book-binding" aria-hidden="true"></div>
          <div class="secret-open-book-sheet">
            <div class="secret-section-hint">${escapeHtml(SECTION_HINTS[_section] || '')}</div>
            ${body}
          </div>
        </div>
      </div>
    </div>`;
    content.style.position = 'relative';
    content.style.minHeight = '100%';
    if (_section === 'memo') {
      content.style.background = '';
    } else {
      // 列表用木质桌面底，纸张效果留给点开后的打开本子
      content.style.background = '#d9cbb8';
      const oldPat = content.querySelector('.secret-paper-pattern');
      if (oldPat) oldPat.remove();
    }
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
  }
}

async function renderDiaryListHtml() {
  const { type, charId } = _currentBook;
  let entries;
  if (type === 'user') {
    entries = (await api.getDiaries({ role: 'user' })).filter(d => !d.character_id);
  } else {
    entries = await api.getDiaries({ charId, role: 'ai' });
  }
  if (!entries.length) {
    return type === 'user'
      ? `<div class="empty-state"><div class="empty-icon">📒</div><div class="empty-text">还没有日记<br>点右上角「＋」开始写</div></div>`
      : `<div class="empty-state"><div class="empty-icon">📔</div><div class="empty-text">TA还没有写日记<br>每天凌晨 2 点自动生成</div>
          <button class="btn btn-primary btn-sm" style="margin-top:16px" onclick="manualGenerateAiDiary()">补齐缺失日记</button></div>`;
  }

  const groups = {};
  entries.forEach(d => {
    const ym = d.date?.slice(0, 7) || '未知';
    (groups[ym] = groups[ym] || []).push(d);
  });

  const collapsedMonths = getDiaryCollapsedMonths();
  let html = '';
  Object.keys(groups).sort((a, b) => b.localeCompare(a)).forEach(ym => {
    const [y, m] = ym.split('-');
    const open = !collapsedMonths.has(ym);
    const count = groups[ym].length;
    html += `<div class="secret-month-section" data-ym="${ym}">
      <div class="secret-month-header" onclick="toggleDiaryMonth('${ym}')">
        <span class="secret-month-chevron" style="transform:rotate(${open ? 90 : 0}deg)">›</span>
        <span>${y}年${parseInt(m, 10)}月</span>
        <span class="secret-month-count">${count} 篇</span>
      </div>
      <div class="settings-group secret-month-body" style="display:${open ? '' : 'none'}">`;
    groups[ym].forEach(d => {
      const clickFn = type === 'user' ? `openDiaryEntry(${d.id})` : `peekDiaryEntry(${d.id})`;
      html += `
        <div class="settings-row" onclick="${clickFn}" style="cursor:pointer">
          <div style="flex:1">
            <div style="font-size:14px;color:var(--text-primary);font-family:'Noto Serif SC',serif">${d.date?.slice(5) || d.date}${d.title ? ' · ' + escapeHtml(d.title) : ''}</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px">${escapeHtml((d.content || '').slice(0, 50))}${d.content?.length > 50 ? '…' : ''}</div>
          </div>
          <div style="color:var(--text-secondary);font-size:18px">${type === 'user' ? '›' : (d.user_peeked ? '✓' : '📖')}</div>
        </div>`;
    });
    html += `</div></div>`;
  });
  return html;
}

/** 手机式备忘录：按时间倒序，点进全屏编辑 */
async function renderPhoneMemoListHtml() {
  const notes = await api.getSecretNotes({ charId: 0, role: 'user', section: 'memo' });
  if (!notes.length) {
    return `<div class="empty-state"><div class="empty-icon">📝</div>
      <div class="empty-text">还没有备忘录<br>点右上角「＋」新建，不限格式</div></div>`;
  }
  notes.sort((a, b) => String(b.note_at || b.date || '').localeCompare(String(a.note_at || a.date || '')));
  return `<div class="phone-memo-list">${notes.map(n => {
    const text = String(n.content || '').trim();
    const lines = text.split('\n');
    const title = (lines[0] || '无标题').slice(0, 48);
    const preview = (lines.slice(1).join(' ').trim() || text).slice(0, 100);
    const time = (n.note_at || n.date || '').replace('T', ' ').slice(0, 16);
    return `<button type="button" class="phone-memo-card" onclick="openPhoneMemoEditor(${n.id})">
      <div class="phone-memo-card-title">${escapeHtml(title)}</div>
      <div class="phone-memo-card-preview">${escapeHtml(preview)}</div>
      <div class="phone-memo-card-time">${escapeHtml(time)}</div>
    </button>`;
  }).join('')}</div>`;
}

window.openPhoneMemoEditor = async function(id = null) {
  _phoneMemoEditId = id;
  const ta = document.getElementById('memo-content-input');
  const delBtn = document.getElementById('memo-delete-btn');
  const timeEl = document.getElementById('memo-edit-time');
  if (!ta) return;
  if (id == null) {
    ta.value = '';
    if (delBtn) delBtn.style.display = 'none';
    if (timeEl) timeEl.textContent = '';
  } else {
    try {
      const notes = await api.getSecretNotes({ charId: 0, role: 'user', section: 'memo' });
      const n = notes.find(x => x.id === id);
      if (!n) return;
      ta.value = n.content || '';
      if (delBtn) delBtn.style.display = '';
      if (timeEl) timeEl.textContent = (n.note_at || n.date || '').replace('T', ' ').slice(0, 16);
    } catch (e) {
      window.showToast?.(e.message || '加载失败');
      return;
    }
  }
  document.getElementById('memo-edit-overlay')?.classList.add('active');
  ta.focus();
};

window.closePhoneMemoEditor = function() {
  document.getElementById('memo-edit-overlay')?.classList.remove('active');
  _phoneMemoEditId = null;
};

window.savePhoneMemo = async function() {
  const content = document.getElementById('memo-content-input')?.value || '';
  if (!content.trim()) {
    window.showToast?.('写点内容吧');
    return;
  }
  const now = new Date();
  const noteAt = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const date = noteAt.slice(0, 10);
  try {
    if (_phoneMemoEditId) {
      await api.updateSecretNote(_phoneMemoEditId, { content: content.trim(), noteAt, date });
    } else {
      await api.createSecretNote({
        characterId: 0, role: 'user', section: 'memo', content: content.trim(), noteAt, date, confirmed: 1,
      });
    }
    closePhoneMemoEditor();
    window.showToast?.('已保存');
    if (_currentBook?.type === 'user' && _section === 'memo') await renderBookSection();
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.deletePhoneMemo = async function() {
  if (!_phoneMemoEditId || !confirm('删除这条备忘录？')) return;
  try {
    await api.deleteSecretNote(_phoneMemoEditId);
    closePhoneMemoEditor();
    window.showToast?.('已删除');
    if (_currentBook?.type === 'user' && _section === 'memo') await renderBookSection();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

function getDiaryCollapsedMonths() {
  try { return new Set(JSON.parse(localStorage.getItem('nian_diary_collapsed_months') || '[]')); }
  catch { return new Set(); }
}

window.toggleDiaryMonth = function(ym) {
  const set = getDiaryCollapsedMonths();
  const section = document.querySelector(`.secret-month-section[data-ym="${ym}"]`);
  if (!section) return;
  const body = section.querySelector('.secret-month-body');
  const chev = section.querySelector('.secret-month-chevron');
  const open = body && body.style.display === 'none';
  if (body) body.style.display = open ? '' : 'none';
  if (chev) chev.style.transform = `rotate(${open ? 90 : 0}deg)`;
  if (open) set.delete(ym); else set.add(ym);
  try { localStorage.setItem('nian_diary_collapsed_months', JSON.stringify([...set])); } catch {}
}

function noteDateKey(n) {
  return n.date || (n.note_at || '').slice(0, 10) || '未知';
}

/** 备忘录 / 心事：与日记相同的「月份折叠 → 点日期进入」；同日内容合在一页 */
function renderNotesByMonthHtml(notes, section, type) {
  const icon = SECTION_META[section]?.icon || '📝';
  const emptyHint = section === 'memo'
    ? (type === 'user' ? '还没有待办，点右上角「＋」添加' : '暂无备忘')
    : '还没有心事<br>只有情绪很强烈时才会写下；可点「✦」补写';
  if (!notes.length) {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div>
      <div class="empty-text">${emptyHint}</div></div>`;
  }

  const byDate = {};
  notes.forEach(n => {
    const d = noteDateKey(n);
    (byDate[d] = byDate[d] || []).push(n);
  });

  const groups = {};
  Object.keys(byDate).forEach(d => {
    const ym = d.slice(0, 7) || '未知';
    (groups[ym] = groups[ym] || []).push(d);
  });
  Object.keys(groups).forEach(ym => groups[ym].sort((a, b) => b.localeCompare(a)));

  const collapsedMonths = getNotesCollapsedMonths(section);
  let html = '';
  Object.keys(groups).sort((a, b) => b.localeCompare(a)).forEach(ym => {
    const [y, m] = ym.split('-');
    const open = !collapsedMonths.has(ym);
    const dayCount = groups[ym].length;
    html += `<div class="secret-month-section" data-ym="${ym}" data-notes-section="${section}">
      <div class="secret-month-header" onclick="toggleNotesMonth('${section}','${ym}')">
        <span class="secret-month-chevron" style="transform:rotate(${open ? 90 : 0}deg)">›</span>
        <span>${y === '未知' ? '未知' : `${y}年${parseInt(m, 10)}月`}</span>
        <span class="secret-month-count">${dayCount} 天</span>
      </div>
      <div class="settings-group secret-month-body" style="display:${open ? '' : 'none'}">`;
    groups[ym].forEach(d => {
      const items = byDate[d];
      const first = items[0];
      let preview = String(first?.content || '').replace(/\n/g, ' ');
      if (section === 'memo') {
        const done = items.filter(n => Number(n.confirmed) === 1).length;
        preview = `${items.length} 条 · ${preview}`;
        if (done) preview = `${items.length} 条（完成 ${done}） · ${String(first?.content || '').replace(/\n/g, ' ')}`;
      } else {
        preview = items.length > 1
          ? `${items.length} 则 · ${preview}`
          : preview;
      }
      const dateLabel = d.length >= 10 ? d.slice(5) : d;
      html += `
        <div class="settings-row" onclick="openSecretNotesByDate('${section}','${d}')" style="cursor:pointer">
          <div style="flex:1">
            <div style="font-size:14px;color:var(--text-primary);font-family:'Noto Serif SC',serif">${escapeHtml(dateLabel)}</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px">${escapeHtml(preview.slice(0, 56))}${preview.length > 56 ? '…' : ''}</div>
          </div>
          <div style="color:var(--text-secondary);font-size:18px">›</div>
        </div>`;
    });
    html += `</div></div>`;
  });
  return html;
}

function getNotesCollapsedMonths(section) {
  try { return new Set(JSON.parse(localStorage.getItem(`nian_${section}_collapsed_months`) || '[]')); }
  catch { return new Set(); }
}

window.toggleNotesMonth = function(section, ym) {
  const set = getNotesCollapsedMonths(section);
  const sectionEl = document.querySelector(`.secret-month-section[data-ym="${ym}"][data-notes-section="${section}"]`);
  if (!sectionEl) return;
  const body = sectionEl.querySelector('.secret-month-body');
  const chev = sectionEl.querySelector('.secret-month-chevron');
  const open = body && body.style.display === 'none';
  if (body) body.style.display = open ? '' : 'none';
  if (chev) chev.style.transform = `rotate(${open ? 90 : 0}deg)`;
  if (open) set.delete(ym); else set.add(ym);
  try { localStorage.setItem(`nian_${section}_collapsed_months`, JSON.stringify([...set])); } catch {}
};

async function renderSecretNotesHtml(section) {
  const { type, charId } = _currentBook;
  const params = type === 'user'
    ? { charId: 0, role: 'user', section }
    : { charId, role: 'ai', section };
  const notes = await api.getSecretNotes(params);

  if (section === 'memo' || section === 'heart') {
    return renderNotesByMonthHtml(notes, section, type);
  }

  if (section === 'us') {
    if (!notes.length) {
      return `<div class="empty-state"><div class="empty-icon">💞</div>
        <div class="empty-text">见面后想一起做的共同心愿<br>如「一起看《花样年华》」，点开看幻想和原因<br>不是下班陪聊这类线上日常<br>${type === 'user' ? '点右上角「＋」添加' : '可点「✦」根据记忆补写'}</div></div>`;
    }
    return `<div class="secret-wish-list">${notes.map(n => {
      const raw = String(n.content || '');
      const nl = raw.indexOf('\n');
      let title = (nl >= 0 ? raw.slice(0, nl) : raw).trim();
      const detail = nl >= 0 ? raw.slice(nl + 1).trim() : '';
      title = title.replace(/^[【\[]\s*|\s*[】\]]$/g, '');
      const titleShow = title ? `【${title}】` : '【…】';
      return `<div class="secret-wish-card" data-note-id="${n.id}">
        <button type="button" class="secret-todo-del secret-wish-del" onclick="event.stopPropagation();deleteSecretNoteEntry(${n.id})" title="删除">×</button>
        <button type="button" class="secret-wish-head" onclick="toggleWishExpand(this)">
          <span class="secret-wish-title">${escapeHtml(titleShow)}</span>
          <span class="secret-wish-chevron">›</span>
        </button>
        <div class="secret-wish-detail" hidden>${detail ? escapeHtml(detail) : '<span style="opacity:.55">（还没有展开的幻想）</span>'}</div>
      </div>`;
    }).join('')}</div>`;
  }

  // fallback list
  if (!notes.length) {
    return `<div class="empty-state"><div class="empty-icon">${SECTION_META[section]?.icon || '📝'}</div>
      <div class="empty-text">暂无短条</div></div>`;
  }
  return `<div class="settings-group">${notes.map(n => {
    const time = (n.note_at || n.date || '').replace('T', ' ').slice(0, 16);
    return `<div class="settings-row" style="cursor:pointer" onclick="openSecretNotePage(${n.id}, '${section}')">
      <div style="flex:1"><div style="font-size:14px">${escapeHtml(n.content)}</div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${escapeHtml(time)}</div></div>
    </div>`;
  }).join('')}</div>`;
}

window.toggleWishExpand = function(btn) {
  const card = btn?.closest?.('.secret-wish-card');
  if (!card) return;
  const detail = card.querySelector('.secret-wish-detail');
  const chev = card.querySelector('.secret-wish-chevron');
  if (!detail) return;
  const open = detail.hasAttribute('hidden');
  if (open) detail.removeAttribute('hidden');
  else detail.setAttribute('hidden', '');
  card.classList.toggle('is-open', open);
  if (chev) chev.style.transform = open ? 'rotate(90deg)' : '';
};

window.openSecretNotesByDate = async function(section, dateKey) {
  const { type, charId } = _currentBook || {};
  if (!type) return;
  const params = type === 'user'
    ? { charId: 0, role: 'user', section }
    : { charId, role: 'ai', section };
  try {
    const notes = await api.getSecretNotes(params);
    const dayNotes = notes.filter(n => noteDateKey(n) === dateKey)
      .sort((a, b) => String(a.note_at || '').localeCompare(String(b.note_at || '')));
    if (!dayNotes.length) return;
    const label = SECTION_META[section]?.label || '秘密';

    // 同一天合在一页纸上
    const blocks = dayNotes.map(n => {
      const body = String(n.content || '').trim();
      if (section === 'memo') {
        const done = Number(n.confirmed) === 1;
        return `${done ? '●' : '○'} ${body}`;
      }
      return body;
    });
    const content = blocks.join(section === 'heart' ? '\n\n············\n\n' : '\n\n');
    const peeks = type === 'user'
      ? dayNotes.flatMap(n => Array.isArray(n.peeks) ? n.peeks : [])
      : null;

    await openFlipReader([{
      title: `${label} · ${dateKey}`,
      content,
      peeks,
      noteId: dayNotes[0].id,
      sectionLabel: label,
      actionsHtml: type === 'user' || type === 'ai'
        ? `<button type="button" class="topbar-action topbar-action-danger" onclick="deleteSecretNotesOfDate('${section}','${dateKey}')" title="删除本日">${ICON_TRASH}</button>`
        : '',
    }], 0);
  } catch (e) {
    window.showToast?.(e.message || '打开失败');
  }
};

window.deleteSecretNotesOfDate = async function(section, dateKey) {
  if (!confirm(`删除 ${dateKey} 的全部${SECTION_META[section]?.label || ''}？`)) return;
  const { type, charId } = _currentBook || {};
  const params = type === 'user'
    ? { charId: 0, role: 'user', section }
    : { charId, role: 'ai', section };
  try {
    const notes = await api.getSecretNotes(params);
    const dayNotes = notes.filter(n => noteDateKey(n) === dateKey);
    for (const n of dayNotes) {
      await api.deleteSecretNote(n.id);
    }
    document.getElementById('diary-view-overlay')?.classList.remove('active');
    window.showToast?.('已删除');
    await renderBookSection();
  } catch (e) { window.showToast?.(e.message); }
};

window.toggleSecretMemoDone = async function(id, done) {
  try {
    await api.updateSecretNote(id, { confirmed: done ? 1 : 0 });
    const inReader = document.getElementById('diary-view-overlay')?.classList.contains('active');
    if (inReader && _readingPages[_readingIdx]?.noteId === id) {
      const page = _readingPages[_readingIdx];
      const body = String(page.content || '').replace(/^[●○][^\n]*\n\n/, '');
      page.content = `${done ? '● 已完成' : '○ 待办'}\n\n${body}`;
      page.actionsHtml = `
        <button type="button" class="topbar-action" onclick="toggleSecretMemoDone(${id}, ${done ? 0 : 1})" title="${done ? '取消完成' : '勾选完成'}">${done ? '○' : '●'}</button>
        <button type="button" class="topbar-action topbar-action-danger" onclick="deleteSecretNoteEntry(${id})" title="删除">${ICON_TRASH}</button>`;
      await showReadingPage(false);
    }
    if (_view === 'section') await renderBookSection();
  } catch (e) { window.showToast?.(e.message || '更新失败'); }
};

let _notePressTimer = null;
let _notePressId = null;
window.secretNotePressStart = function(id, ev) {
  if (ev?.pointerType === 'mouse' && ev.button !== 0) return;
  if (ev?.target?.closest?.('button')) return;
  _notePressId = id;
  clearTimeout(_notePressTimer);
  _notePressTimer = setTimeout(() => {
    if (_notePressId === id) deleteSecretNoteEntry(id);
  }, 650);
};
window.secretNotePressEnd = function() {
  clearTimeout(_notePressTimer);
  _notePressTimer = null;
  _notePressId = null;
};

function diaryGoBack() {
  if (_readingActive || document.getElementById('diary-view-overlay')?.classList.contains('active')) {
    closeDiaryView();
    return;
  }
  if (_view === 'shared') {
    if (window._secretBackTo === 'ta') {
      window._secretBackTo = null;
      window.navigateBackTo?.('ta') || window.goBack?.();
      return;
    }
    showShelf();
  }
  else if (_view === 'section') showSectionToc();
  else if (_view === 'toc') showShelf();
  else window.goBack?.();
}
window.diaryGoBack = diaryGoBack;

window.manualGenerateAiDiary = async function() {
  const charId = _currentBook?.charId || window.getActiveCharId?.();
  if (!charId) return;
  try {
    window.showToast?.('正在补齐缺失日记…');
    const r = await api.generateAiDiary(charId, { backfill: true, lookback: 7 });
    if (r.skipped) window.showToast?.('该日期已有日记');
    else if (r.generated > 0) window.showToast?.(r.message || `已补齐 ${r.generated} 篇`);
    else window.showToast?.(r.message || '近几天日记已齐全');
    if (_currentBook?.type === 'ai') await renderBookSection();
  } catch (e) {
    window.showToast?.(e.message || '生成失败');
  }
};

window.manualGenerateSecretNotes = async function() {
  const charId = _currentBook?.charId;
  if (!charId) return;
  try {
    window.showToast?.('正在根据记忆生成…');
    const r = await api.generateSecretNotes({ charId, force: true });
    window.showToast?.(r.ok ? `已写入 ${r.added || 0} 条` : (r.reason || '未生成'));
    await renderBookSection();
  } catch (e) {
    window.showToast?.(e.message || '生成失败');
  }
};

window.diaryAddEntry = async function() {
  if (_currentBook?.type !== 'user' || _section !== 'diary') return;
  _editingId = null;
  setSharedMemoEditMode(false);
  document.getElementById('diary-edit-modal-title').textContent = '写日记';
  document.getElementById('diary-date-input').value = new Date().toISOString().slice(0, 10);
  document.getElementById('diary-title-input').value = '';
  document.getElementById('diary-content-input').value = '';
  await _loadVisibleCharsUI([]);
  applyEditPaperStyle(getActivePaperSettings());
  document.getElementById('diary-edit-overlay').classList.add('active');
};

async function _loadVisibleCharsUI(selectedIds) {
  const chars = window.getFriendCharacters?.() || window.getAppCharacters?.() || [];
  document.getElementById('diary-visible-chars').innerHTML = chars.map(c => `
    <div class="tag${selectedIds.includes(c.id) || selectedIds.includes(String(c.id)) ? ' active' : ''}"
      data-char-id="${c.id}" onclick="this.classList.toggle('active')"
      style="display:flex;align-items:center;gap:6px;padding:5px 12px">
      ${c.avatar ? `<img src="${c.avatar}" style="width:18px;height:18px;border-radius:50%;object-fit:cover">` : ''}
      <span>${escapeHtml(c.name)}</span>
    </div>
  `).join('') || '<span style="font-size:12px;color:var(--text-secondary)">暂无好友</span>';
}

function getCharDiaryBg(charId) {
  const c = (window.getAppCharacters?.() || []).find(x => String(x.id) === String(charId));
  return c?.diary_bg || 'blank';
}

function getActivePaperSettings() {
  // 每本书 / 每个分区 / 每本随手记各自一份纸张，互不影响
  if ((_view === 'shared' || _sharedBook) && _sharedBook) {
    return loadBookPaperSettings('shared', _sharedBook.id, 'memo');
  }
  if (_currentBook) {
    const saved = loadBookPaperSettings(_currentBook.type, _currentBook.charId, _section);
    // 这本书这个分区还没单独存过：AI 角色本子可回退到角色资料默认纸张（不是全局）
    const key = getBookPaperKey(_currentBook.type, _currentBook.charId, _section);
    let hasOwn = false;
    try { hasOwn = !!localStorage.getItem(key); } catch {}
    if (!hasOwn && _currentBook.type === 'ai') {
      return parseStoredPaper(getCharDiaryBg(_currentBook.charId));
    }
    return saved;
  }
  // 没有任何打开的本子时只读兜底，不写回
  return parseStoredPaper('blank');
}

function patchActivePaperSettings(partial) {
  const next = normalizePaperSettings({ ...getActivePaperSettings(), ...partial });
  if ((_view === 'shared' || _sharedBook) && _sharedBook) {
    saveBookPaperSettings('shared', _sharedBook.id, 'memo', next);
  } else if (_currentBook) {
    saveBookPaperSettings(_currentBook.type, _currentBook.charId, _section, next);
  }
  // 没有打开的本子时不写任何全局 key，避免「改一本、全部跟着变」
  return next;
}

function applyDiaryViewStyle(settings) {
  const sheet = document.getElementById('diary-view-sheet');
  const page = document.getElementById('secret-flip-page');
  const content = document.getElementById('diary-view-content');
  const s = settings || getActivePaperSettings();
  const appearance = resolvePaperAppearance(s);
  // 外层舞台用桌面底，打开的本子铺在中间
  if (sheet) {
    sheet.style.background = '#d9cbb8';
    sheet.style.backgroundImage = '';
  }
  // 纸张颜色/纹样铺在整页书页上（满高），不要只铺在正文高度的 inset 上，否则下半截空白
  const sheetPage = content?.querySelector?.('.shared-memo-paper-sheet')
    || content?.querySelector?.('.secret-open-book-sheet');
  const paperSurface = sheetPage || content?.querySelector?.('.secret-page-clip') || page;
  if (paperSurface) applyDiarySheetStyle(paperSurface, content, s, { keepTopbar: true });

  const inset = content?.querySelector?.('.secret-inset-paper, .shared-memo-paper-body');
  if (inset) {
    inset.querySelectorAll(':scope > .secret-paper-pattern').forEach(el => el.remove());
    inset.style.background = 'transparent';
    inset.style.backgroundImage = '';
    inset.style.color = appearance.textColor || '#3a3228';
    inset.style.position = 'relative';
    inset.style.zIndex = '1';
  }
  sheet?.setAttribute('data-flip', s.flip || 'realistic');
  page?.setAttribute('data-flip', s.flip || 'realistic');
}

function applyEditPaperStyle(settings) {
  const s = settings || getActivePaperSettings();
  _currentPaper = s;
  const appearance = resolvePaperAppearance(s);
  const extra = EDIT_PAPER_EXTRA[appearance.pattern] || EDIT_PAPER_EXTRA.none || EDIT_PAPER_EXTRA.blank;
  const sheet = document.getElementById('diary-edit-sheet');
  const textarea = document.getElementById('diary-content-input');
  applyDiarySheetStyle(sheet, textarea, s, { keepTopbar: true });
  // 写随手记/日记的顶栏必须保持不透明，纸张样式再怎么换也不能透出去；
  // 用 !important 内联强制兜底，避免被任何纸张/主题样式意外带透明
  const editTopbar = sheet?.querySelector('.sheet-full-topbar, .secret-sheet-topbar');
  if (editTopbar) {
    const isDark = document.documentElement.getAttribute('data-color-scheme') === 'dark';
    editTopbar.style.setProperty('background', isDark ? '#1e1824' : '#ededed', 'important');
    editTopbar.style.setProperty('backdrop-filter', 'none', 'important');
    editTopbar.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
  }
  if (textarea) {
    if (s.pattern && s.pattern !== 'none' && extra?.textarea?.startsWith?.('repeating')) {
      textarea.style.background = extra.textarea;
    } else {
      textarea.style.background = 'rgba(255,255,255,0.22)';
    }
    textarea.style.lineHeight = extra?.lineHeight || '1.9';
    const font = resolvePaperFont(s.userFont);
    textarea.style.setProperty('font-family', font.family, 'important');
    const ink = s.userInk || appearance.textColor || '#3a3228';
    textarea.style.setProperty('color', ink, 'important');
  }
}

function renderPeekTraces(peeks, { diaryId, noteId, sectionLabel } = {}) {
  const tracesEl = document.getElementById('diary-peek-traces');
  if (!tracesEl) return;
  if (!peeks?.length) {
    tracesEl.innerHTML = '';
    return;
  }
  tracesEl.innerHTML = `
    <div class="secret-peek-heading">— 偷看过这篇${sectionLabel || '秘密'}的人 —</div>
    ${peeks.map(p => {
      const sec = p.section ? (SECTION_META[p.section]?.label || p.section) : '';
      const saveFn = diaryId
        ? `savePeekNoteToMemory(${diaryId}, ${p.charId}, \`${String(p.secretNote || '').replace(/`/g, "'")}\`, this)`
        : `saveSecretPeekNoteToMemory(${noteId}, ${p.charId}, \`${String(p.secretNote || '').replace(/`/g, "'")}\`, this)`;
      return `
      <div class="secret-peek-card">
        <div class="secret-peek-card-head">
          ${p.charAvatar
            ? `<img src="${p.charAvatar}" class="secret-peek-avatar" alt="">`
            : `<div class="secret-peek-avatar secret-peek-avatar-fallback">👤</div>`}
          <div>
            <span class="secret-peek-name">${escapeHtml(p.charName)}</span>
            <span class="secret-peek-meta">看了${sec || '秘密'} · ${p.peekedAt || ''}</span>
          </div>
        </div>
        ${p.secretNote
          ? `<div class="secret-peek-note">
              <div class="secret-peek-note-label">💭 TA看完后的心里话</div>
              <div class="secret-peek-note-text">"${escapeHtml(p.secretNote)}"</div>
            </div>
            <button class="btn btn-ghost btn-sm secret-peek-save" onclick="${saveFn}">存入TA的记忆</button>`
          : ''}
      </div>`;
    }).join('')}`;
}

function dockSecretReaderOverlay() {
  const overlay = document.getElementById('diary-view-overlay');
  const topbar = document.getElementById('diary-topbar');
  if (!overlay || !topbar) return;
  const bottom = Math.ceil(topbar.getBoundingClientRect().bottom);
  overlay.style.top = `${bottom}px`;
  overlay.style.height = `calc(100dvh - ${bottom}px - 2px)`;
  overlay.style.bottom = '2px';
}

function syncReadingSecretTopbar(page) {
  const titleEl = document.getElementById('diary-topbar-title');
  const extra = document.getElementById('diary-reading-extra');
  if (titleEl && page?.title) titleEl.textContent = page.title;
  if (extra) {
    const html = page?.actionsHtml || '';
    extra.innerHTML = html;
    extra.style.display = html ? 'flex' : 'none';
  }
  // 阅读时不显示书架上的美化/删除
  const beautifyBtn = document.getElementById('diary-beautify-btn');
  const delBtn = document.getElementById('diary-del-btn');
  if (beautifyBtn) beautifyBtn.style.display = 'none';
  if (delBtn) delBtn.style.display = 'none';
  updateAddBtn();
  const paperBtn = document.getElementById('diary-paper-settings-btn');
  if (paperBtn) paperBtn.style.display = '';
}

function clearReadingSecretTopbar() {
  const extra = document.getElementById('diary-reading-extra');
  if (extra) {
    extra.innerHTML = '';
    extra.style.display = 'none';
  }
  if (_readingTitleBackup) {
    const titleEl = document.getElementById('diary-topbar-title');
    if (titleEl) titleEl.textContent = _readingTitleBackup;
  }
  _readingTitleBackup = '';
  updateAddBtn();
}

function readingEntryKey(page) {
  if (!page) return '';
  return `${page.diaryId || ''}|${page.noteId || ''}|${page.dateKey || ''}|${page.title || ''}|${String(page.content || page.plainContent || '').slice(0, 40)}`;
}


function isSharedMemoComposerOpen() {
  const composer = document.getElementById('shared-memo-inline-composer');
  return !!(composer && composer.style.display !== 'none');
}

/** 输入框不能放在带 transform 的纸页切片里，否则软键盘关掉后会留下假焦点、再点不弹键盘 */
function dockSharedMemoComposerForKeyboard() {
  const composer = document.getElementById('shared-memo-inline-composer');
  if (!composer) return;
  const clip = document.querySelector('#diary-view-content .secret-page-clip');
  const sheet = clip?.parentElement;
  if (!sheet) return;
  if (!document.getElementById('shared-memo-composer-home')) {
    const marker = document.createElement('div');
    marker.id = 'shared-memo-composer-home';
    marker.hidden = true;
    composer.parentElement?.insertBefore(marker, composer);
  }
  if (composer.parentElement !== sheet) sheet.appendChild(composer);
  composer.classList.add('is-kb-docked');
}

function undockSharedMemoComposer() {
  const composer = document.getElementById('shared-memo-inline-composer');
  const marker = document.getElementById('shared-memo-composer-home');
  if (!composer) return;
  composer.classList.remove('is-kb-docked');
  if (marker?.parentElement) {
    marker.parentElement.insertBefore(composer, marker);
    marker.remove();
  }
}

function bindSharedMemoKeyboardRecover(ta) {
  if (!ta || ta.dataset.kbRecoverBound) return;
  ta.dataset.kbRecoverBound = '1';
  const softKbVisible = () => {
    const vv = window.visualViewport;
    if (!vv) return false;
    return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) > 80;
  };
  const recover = () => {
    if (softKbVisible()) return;
    try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
    if (document.activeElement === ta && !softKbVisible()) {
      ta.blur();
      requestAnimationFrame(() => {
        try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
      });
    }
  };
  ta.addEventListener('pointerup', () => recover());
  ta.addEventListener('click', () => recover());
}

function applyContentSlice(animateTransform = false) {
  const inner = document.getElementById('secret-page-inner');
  const clip = document.querySelector('#diary-view-content .secret-page-clip');
  if (!inner || !clip) return;

  const pageH = clip.clientHeight || _slicePageH;
  _slicePageH = pageH;
  if (pageH <= 0) return;
  const totalH = inner.scrollHeight;
  _sliceCount = Math.max(1, Math.ceil(totalH / pageH - 0.02));
  _sliceIdx = Math.max(0, Math.min(_sliceIdx, _sliceCount - 1));
  const y = -(_sliceIdx * pageH);
  if (animateTransform) {
    inner.style.transition = 'transform .28s ease';
  } else {
    inner.style.transition = 'none';
  }
  inner.style.transform = `translateY(${y}px)`;
  // 秘密本等同篇分页靠左右滑动；底栏默认隐藏
  const nav = document.getElementById('secret-flip-nav');
  if (nav) nav.hidden = true;
  const ind = document.getElementById('secret-flip-indicator');
  if (ind) ind.textContent = '';
}

async function openFlipReader(pages, startIdx = 0) {
  _readingPages = pages;
  _readingIdx = Math.max(0, Math.min(startIdx, pages.length - 1));
  _sliceIdx = 0;
  _sliceCount = 1;
  _renderedEntryKey = '';
  _readingActive = true;
  const titleEl = document.getElementById('diary-topbar-title');
  _readingTitleBackup = titleEl?.textContent || '';
  const overlay = document.getElementById('diary-view-overlay');
  dockSecretReaderOverlay();
  overlay.classList.add('active');
  document.getElementById('diary-content')?.classList.add('secret-content-dimmed');
  try {
    await showReadingPage(false);
  } catch (e) {
    overlay.classList.remove('active');
    document.getElementById('diary-content')?.classList.remove('secret-content-dimmed');
    _readingActive = false;
    throw e;
  }
  // 图片加载后重新量高
  requestAnimationFrame(() => {
    applyContentSlice(false);
    setTimeout(() => applyContentSlice(false), 120);
  });
}

async function showReadingPage(animate = true) {
  const page = _readingPages[_readingIdx];
  if (!page) return;
  const flipEl = document.getElementById('secret-flip-page');
  const underEl = document.getElementById('secret-flip-under');
  const paper = getActivePaperSettings();
  const flipMode = paper.flip || 'realistic';
  const duration = getFlipDurationMs(flipMode);
  const outMs = Math.round(duration * 0.55);
  const entryKey = readingEntryKey(page);
  const onlySliceChange = entryKey && entryKey === _renderedEntryKey && document.getElementById('secret-page-inner');

  if (animate && flipEl && duration > 0) {
    flipEl.classList.remove(
      'flip-in', 'flip-in-back', 'flip-out', 'flip-out-back',
      'cover-in', 'cover-in-back', 'cover-out', 'cover-out-back',
      'slide-in', 'slide-in-back', 'slide-out', 'slide-out-back'
    );
    const prefix = flipMode === 'cover' ? 'cover' : (flipMode === 'slide' ? 'slide' : 'flip');
    flipEl.classList.add(_flipDir > 0 ? `${prefix}-out` : `${prefix}-out-back`);
    if (underEl && flipMode === 'realistic') {
      underEl.classList.add('is-peeking');
      underEl.textContent = onlySliceChange
        ? `第 ${_sliceIdx + 1 + _flipDir} 页`
        : String(page.content || page.plainContent || '').slice(0, 80);
    }
    await new Promise(r => setTimeout(r, outMs));
  }

  const titleHidden = document.getElementById('diary-view-modal-title');
  if (titleHidden) titleHidden.textContent = page.title || '';
  syncReadingSecretTopbar(page);

  if (!onlySliceChange) {
    const viewContent = document.getElementById('diary-view-content');
    let innerHtml;
    if (page.contentHtml) {
      innerHtml = page.contentHtml.includes('secret-inset-paper') || page.contentHtml.includes('shared-memo-paper-body')
        ? page.contentHtml
        : `<div class="secret-inset-paper">${page.contentHtml}</div>`;
    } else {
      innerHtml = `<div class="secret-inset-paper secret-inset-plain">${renderInlineEmojiHtml(escapeHtml(page.content || '').replace(/\n/g, '<br>'))}</div>`;
    }
    if (page.sharedMemo) {
      viewContent.innerHTML = `<div class="shared-memo-paper-sheet">
        <div class="secret-page-clip">
          <div class="secret-page-inner" id="secret-page-inner">
            ${innerHtml}
            <div id="diary-peek-traces" class="secret-peek-traces"></div>
          </div>
        </div>
      </div>
      <div id="sm-mark-dock" class="sm-mark-dock" style="display:none" onclick="event.stopPropagation()">
        <div class="sm-mark-dock-hint" id="sm-mark-toolbar-hint">点正文里的字选中，再点下方方式；已批的词可再点开写旁注</div>
        <div class="sm-mark-dock-quote" id="sm-mark-dock-quote" style="display:none"></div>
        <div class="sm-mark-toolbar-btns">
          <button type="button" data-mark="circle" onclick="pickSharedMemoMarkTool('circle')">圈词</button>
          <button type="button" data-mark="strike" onclick="pickSharedMemoMarkTool('strike')">划掉</button>
          <button type="button" data-mark="line" onclick="pickSharedMemoMarkTool('line')">划线</button>
          <button type="button" data-mark="note" onclick="pickSharedMemoMarkTool('note')">旁注</button>
          <button type="button" class="sm-mark-dock-done" onclick="hideSharedMemoMarkToolbar()">完成</button>
        </div>
      </div>
      <div id="sm-mark-note-sheet" class="sm-mark-note-sheet" style="display:none" onclick="event.stopPropagation()">
        <div class="sm-mark-note-sheet-title">写旁注</div>
        <input type="text" id="sm-mark-note-sheet-input" maxlength="80" placeholder="写一句旁注…">
        <div class="sm-mark-note-sheet-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="closeSharedMemoNoteSheet(false)">取消</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="closeSharedMemoNoteSheet(true)">保存</button>
        </div>
      </div>`;
    } else {
      viewContent.innerHTML = `<div class="secret-open-book secret-open-book-reader">
        <div class="secret-open-book-binding" aria-hidden="true"></div>
        <div class="secret-open-book-sheet">
          <div class="secret-page-clip">
            <div class="secret-page-inner" id="secret-page-inner">
              ${innerHtml}
              <div id="diary-peek-traces" class="secret-peek-traces"></div>
            </div>
          </div>
        </div>
      </div>`;
    }
    viewContent.style.whiteSpace = 'normal';
    _renderedEntryKey = entryKey;
    _sliceIdx = 0;

    if (page.peeks) {
      renderPeekTraces(page.peeks, {
        diaryId: page.diaryId,
        noteId: page.noteId,
        sectionLabel: page.sectionLabel,
      });
    }
    applyDiaryViewStyle(paper);
    applyContentSlice(false);
    if (page.sharedMemo) {
      setupSharedMemoMarkSelection();
      prepareSharedMemoTapTokens();
    }
  } else {
    applyContentSlice(false);
  }

  if (underEl) {
    underEl.classList.remove('is-peeking');
    underEl.textContent = '';
  }

  if (animate && flipEl && duration > 0) {
    const prefix = flipMode === 'cover' ? 'cover' : (flipMode === 'slide' ? 'slide' : 'flip');
    flipEl.classList.remove(`${prefix}-out`, `${prefix}-out-back`);
    flipEl.classList.add(_flipDir > 0 ? `${prefix}-in` : `${prefix}-in-back`);
  }
}

window.secretFlipPrev = async function() {
  if (_sliceIdx <= 0) return;
  _flipDir = -1;
  _sliceIdx--;
  await showReadingPage(true);
};
window.secretFlipNext = async function() {
  if (_sliceIdx >= _sliceCount - 1) return;
  _flipDir = 1;
  _sliceIdx++;
  await showReadingPage(true);
};

window.openDiaryEntry = async function(id) {
  try {
    const all = await api.getDiaries({ role: 'user' });
    const d = all.find(x => x.id === id && !x.character_id);
    if (!d) return;
    await openFlipReader([{
      title: d.date + (d.title ? ' · ' + d.title : ''),
      content: d.content,
      peeks: Array.isArray(d.char_peeks) ? d.char_peeks : [],
      diaryId: d.id,
      sectionLabel: '日记',
      actionsHtml: `
        <button type="button" class="topbar-action" title="编辑" onclick="editDiaryEntry(${d.id})">${ICON_MORE}</button>
        <button type="button" class="topbar-action topbar-action-danger" title="删除" onclick="deleteDiaryEntry(${d.id})">${ICON_TRASH}</button>`,
    }], 0);
  } catch {}
};

window.editDiaryEntry = async function(id) {
  _editingId = id;
  document.getElementById('diary-view-overlay').classList.remove('active');
  try {
    const all = await api.getDiaries({ role: 'user' });
    const d = all.find(x => x.id === id);
    if (!d) return;
    setSharedMemoEditMode(false);
    document.getElementById('diary-edit-modal-title').textContent = '编辑日记';
    document.getElementById('diary-date-input').value = d.date;
    document.getElementById('diary-title-input').value = d.title || '';
    document.getElementById('diary-content-input').value = d.content;
    const visibleIds = Array.isArray(d.visible_to) ? d.visible_to : [];
    await _loadVisibleCharsUI(visibleIds);
    applyEditPaperStyle(getActivePaperSettings());
    document.getElementById('diary-edit-overlay').classList.add('active');
  } catch {}
};

window.saveDiaryEntry = async function() {
  if (_smWriting) return saveSharedMemoFromEdit();
  const date = document.getElementById('diary-date-input').value;
  const title = document.getElementById('diary-title-input').value.trim();
  const content = document.getElementById('diary-content-input').value.trim();
  if (!content) { window.showToast?.('内容不能为空'); return; }
  const visibleTags = document.querySelectorAll('#diary-visible-chars .tag.active');
  const visible_to = Array.from(visibleTags).map(t => parseInt(t.dataset.charId, 10));
  try {
    if (_editingId) {
      await api.updateDiary(_editingId, { title, content, visible_to });
    } else {
      await api.createDiary({ role: 'user', title, content, date, visible_to });
    }
    document.getElementById('diary-edit-overlay').classList.remove('active');
    window.showToast?.('已保存');
    if (_currentBook) await renderBookSection();
  } catch (e) { window.showToast?.(e.message || '保存失败'); }
};

window.closeDiaryEdit = function() {
  document.getElementById('diary-edit-overlay').classList.remove('active');
  setSharedMemoEditMode(false);
};

window.deleteDiaryEntry = async function(id) {
  if (!confirm('确定删除这篇日记？')) return;
  try {
    await api.deleteDiary(id);
    document.getElementById('diary-view-overlay').classList.remove('active');
    window.showToast?.('已删除');
    if (_currentBook) await renderBookSection();
  } catch {}
};

window.closeDiaryView = function() {
  document.getElementById('diary-view-overlay')?.classList.remove('active');
  document.getElementById('diary-content')?.classList.remove('secret-content-dimmed');
  _readingPages = [];
  _readingActive = false;
  _renderedEntryKey = '';
  _sliceIdx = 0;
  _sliceCount = 1;
  _smReadingDateKey = '';
  clearReadingSecretTopbar();
  // 退出日页后立刻重画目录，避免底下被 dim 掉后只剩空底色
  if (_view === 'shared' && _sharedBook) {
    paintSharedMemoList(_smCachedEntries || []);
  }
};

window.peekDiaryEntry = async function(id) {
  window.showToast?.('悄悄翻开…');
  await new Promise(r => setTimeout(r, 400));
  try {
    await api.peekDiary(id, { by: 'user' });
    const all = await api.getDiaries({ charId: _currentBook?.charId, role: 'ai' });
    const d = all.find(x => x.id === id);
    if (!d) return;
    await openFlipReader([{
      title: `[偷看] ${d.date}${d.title ? ' · ' + d.title : ''}`,
      content: d.content,
    }], 0);
    if (_currentBook) await renderBookSection();
  } catch (e) { window.showToast?.(e.message || '加载失败'); }
};

window.openSecretNotePage = async function(id, section) {
  const { type, charId } = _currentBook || {};
  const params = type === 'user'
    ? { charId: 0, role: 'user', section }
    : { charId, role: 'ai', section };
  const notes = await api.getSecretNotes(params);
  const n = notes.find(x => x.id === id);
  if (!n) return;
  const label = SECTION_META[section]?.label || '秘密';
  const time = (n.note_at || n.date || '').replace('T', ' ').slice(0, 16);
  await openFlipReader([{
    title: `${label} · ${time}`,
    content: n.content,
    peeks: type === 'user' ? (Array.isArray(n.peeks) ? n.peeks : []) : null,
    noteId: n.id,
    sectionLabel: label,
    actionsHtml: type === 'user' || type === 'ai'
      ? `<button type="button" class="topbar-action topbar-action-danger" onclick="deleteSecretNoteEntry(${n.id})" title="删除">${ICON_TRASH}</button>`
      : '',
  }], 0);
};

window.deleteSecretNoteEntry = async function(id) {
  if (!confirm('删除这条？')) return;
  try {
    await api.deleteSecretNote(id);
    document.getElementById('diary-view-overlay').classList.remove('active');
    window.showToast?.('已删除');
    await renderBookSection();
  } catch (e) { window.showToast?.(e.message); }
};

let _secretNoteEditId = null;
window.openSecretNoteEdit = function(id = null) {
  _secretNoteEditId = id;
  const isUs = _section === 'us';
  document.getElementById('secret-note-edit-title').textContent =
    isUs ? '添加「我们」' : '添加短条';
  const titleEl = document.getElementById('secret-note-title');
  const ta = document.getElementById('secret-note-content');
  titleEl.style.display = isUs ? '' : 'none';
  titleEl.value = '';
  titleEl.placeholder = '见面后：一起看《花样年华》 / 去那家店…';
  ta.value = '';
  ta.rows = isUs ? 4 : 3;
  ta.placeholder = isUs
    ? '幻想画面 + 为什么想见面后一起做这件事…'
    : '一句话…';
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  document.getElementById('secret-note-at').value = local;
  document.getElementById('secret-note-edit-overlay').classList.add('active');
};
window.closeSecretNoteEdit = function() {
  document.getElementById('secret-note-edit-overlay').classList.remove('active');
};
window.saveSecretNoteEdit = async function() {
  const isUs = _section === 'us';
  const title = document.getElementById('secret-note-title')?.value?.trim() || '';
  const body = document.getElementById('secret-note-content').value.trim();
  let content = body;
  if (isUs) {
    if (!title && !body) { window.showToast?.('请填写见面后想一起做的事'); return; }
    let t = String(title || '').trim().replace(/^[【\[]\s*|\s*[】\]]$/g, '');
    if (!t) t = '见面后想一起做的事';
    content = body ? `${t}\n${body}` : t;
  } else if (!content) {
    window.showToast?.('请填写内容'); return;
  }
  const atRaw = document.getElementById('secret-note-at').value;
  const noteAt = atRaw ? atRaw.replace('T', ' ') : undefined;
  const date = (noteAt || new Date().toISOString()).slice(0, 10);
  const isUser = _currentBook?.type === 'user';
  try {
    await api.createSecretNote({
      characterId: isUser ? 0 : _currentBook.charId,
      role: isUser ? 'user' : 'ai',
      section: _section,
      content,
      noteAt,
      date,
      source: 'manual',
    });
    closeSecretNoteEdit();
    window.showToast?.('已保存');
    await renderBookSection();
  } catch (e) { window.showToast?.(e.message || '保存失败'); }
};

// ── 纸张设置（颜色 / 样式 / 翻开，互不捆绑） ──
const EDIT_PAPER_EXTRA = {
  none: { textarea: 'rgba(255,255,255,0.22)', lineHeight: '1.9' },
  blank: { textarea: 'rgba(255,255,255,0.22)', lineHeight: '1.9' },
  ruled: { textarea: 'repeating-linear-gradient(transparent,transparent 31px,#c8d8e8 31px,#c8d8e8 32px)', lineHeight: '2' },
  grid: { textarea: 'repeating-linear-gradient(#dde6f0 0,#dde6f0 1px,transparent 1px,transparent 32px),repeating-linear-gradient(90deg,#dde6f0 0,#dde6f0 1px,transparent 1px,transparent 32px)', lineHeight: '2' },
  dots: { textarea: 'rgba(255,255,255,0.22)', lineHeight: '1.9' },
  stripes: { textarea: 'rgba(255,255,255,0.22)', lineHeight: '1.9' },
};
let _currentPaper = parseStoredPaper('blank');

function refreshPaperAppearance() {
  const s = getActivePaperSettings();
  _currentPaper = s;
  if (document.getElementById('diary-edit-overlay')?.classList.contains('active')) {
    applyEditPaperStyle(s);
  }
  const content = document.getElementById('diary-content');
  if ((_view === 'section' || _view === 'shared') && content) {
    if (_section === 'memo' && _view === 'section') {
      content.style.background = '';
    } else {
      content.style.background = '#d9cbb8';
      const oldPat = content.querySelector('.secret-paper-pattern');
      if (oldPat) oldPat.remove();
    }
  }
  if (document.getElementById('diary-view-overlay')?.classList.contains('active')) {
    applyDiaryViewStyle(s);
    const page = _readingPages[_readingIdx];
    if (page?.dateKey && _view === 'shared') {
      const dayEntries = groupSharedMemoByDate(_smCachedEntries || [])[page.dateKey] || [];
      const canContinue = page.dateKey === sharedMemoLocalToday();
      page.contentHtml = `<div class="shared-memo-paper-body secret-inset-paper">${sharedMemoDayBodyHtml(dayEntries)}${canContinue ? sharedMemoInlineComposerHtml() : ''}</div>`;
      page.sharedMemo = true;
      _renderedEntryKey = '';
      showReadingPage(false);
    } else {
      applyContentSlice(false);
    }
  }
  renderSecretPaperSettingsUI();
}

function renderSecretPaperSettingsUI() {
  const s = getActivePaperSettings();
  const colorList = document.getElementById('secret-paper-color-list');
  const patternList = document.getElementById('secret-paper-pattern-list');
  const flipList = document.getElementById('secret-paper-flip-list');
  const picker = document.getElementById('secret-paper-color-picker');
  if (!colorList) return;

  const customUrl = (() => { try { return localStorage.getItem('diary_custom_bg') || ''; } catch { return ''; } })();
  const colorSelected = s.color;
  colorList.innerHTML = PAPER_COLORS.map(c => {
    const active = colorSelected === c.id;
    return `<button type="button" class="secret-paper-swatch${active ? ' active' : ''}" title="${c.label}"
      style="background:${c.bg}" onclick="setSecretPaperColor('${c.id}')"><span>${c.label}</span></button>`;
  }).join('') + (customUrl ? `<button type="button" class="secret-paper-swatch${isDiaryCustomBg(colorSelected) ? ' active' : ''}" title="已上传"
      style="background:url('${customUrl.replace(/'/g, '')}') center/cover" onclick="setSecretPaperColor('${customUrl.replace(/'/g, '')}')"><span>图片</span></button>` : '');

  if (picker) {
    if (/^#[0-9a-fA-F]{6}$/.test(colorSelected)) picker.value = colorSelected;
    else if (PAPER_COLORS.find(c => c.id === colorSelected)) picker.value = PAPER_COLORS.find(c => c.id === colorSelected).bg;
  }

  patternList.innerHTML = PAPER_PATTERNS.map(p =>
    `<div class="tag${s.pattern === p.id ? ' active' : ''}" onclick="setSecretPaperPattern('${p.id}')">${p.label}</div>`
  ).join('');

  flipList.innerHTML = FLIP_EFFECTS.map(f =>
    `<div class="tag${s.flip === f.id ? ' active' : ''}" onclick="setSecretPaperFlip('${f.id}')">${f.label}</div>`
  ).join('');

  const voiceEl = document.getElementById('secret-paper-voice-settings');
  const showVoice = _view === 'shared' || !!_sharedBook;
  if (voiceEl) voiceEl.style.display = showVoice ? '' : 'none';
  if (showVoice) {
    const fonts = getPaperFonts();
    const userFontList = document.getElementById('secret-paper-user-font-list');
    const aiFontList = document.getElementById('secret-paper-ai-font-list');
    const userInk = document.getElementById('secret-paper-user-ink');
    const aiInk = document.getElementById('secret-paper-ai-ink');
    if (userFontList) {
      userFontList.innerHTML = fonts.map(f =>
        `<button type="button" class="secret-paper-font-tag${f.id === 'hand' || f.custom ? ' is-hand' : ''}${s.userFont === f.id ? ' active' : ''}"
          style="font-family:${f.family}" onclick="setSecretPaperUserFont('${f.id}')">${escapeHtml(f.label)}</button>`
      ).join('');
    }
    if (aiFontList) {
      aiFontList.innerHTML = fonts.map(f =>
        `<button type="button" class="secret-paper-font-tag${f.id === 'hand' || f.custom ? ' is-hand' : ''}${s.aiFont === f.id ? ' active' : ''}"
          style="font-family:${f.family}" onclick="setSecretPaperAiFont('${f.id}')">${escapeHtml(f.label)}</button>`
      ).join('');
    }
    const appearance = resolvePaperAppearance(s);
    if (userInk) userInk.value = s.userInk || appearance.textColor || '#3a3228';
    if (aiInk) aiInk.value = s.aiInk || '#5a4a78';
    const userSize = document.getElementById('secret-paper-user-size');
    const aiSize = document.getElementById('secret-paper-ai-size');
    const userSizeVal = document.getElementById('secret-paper-user-size-val');
    const aiSizeVal = document.getElementById('secret-paper-ai-size-val');
    if (userSize) userSize.value = String(s.userFontSize || 16);
    if (aiSize) aiSize.value = String(s.aiFontSize || 16);
    if (userSizeVal) userSizeVal.textContent = `${s.userFontSize || 16}px`;
    if (aiSizeVal) aiSizeVal.textContent = `${s.aiFontSize || 16}px`;
    const markMap = {
      'secret-paper-mark-circle': s.markCircle,
      'secret-paper-mark-strike': s.markStrike,
      'secret-paper-mark-line': s.markLine,
      'secret-paper-mark-note': s.markNote,
    };
    for (const [id, val] of Object.entries(markMap)) {
      const el = document.getElementById(id);
      if (el && val) el.value = val;
    }
  }
}

window.openSecretPaperSettings = function() {
  if (!_currentBook && _view !== 'section' && _view !== 'shared') {
    // 编辑/阅读中仍可开
    if (!document.getElementById('diary-edit-overlay')?.classList.contains('active')
      && !document.getElementById('diary-view-overlay')?.classList.contains('active')) {
      window.showToast?.('请先打开一本书');
      return;
    }
  }
  renderSecretPaperSettingsUI();
  document.getElementById('secret-paper-settings-overlay')?.classList.add('active');
};

window.closeSecretPaperSettings = function() {
  document.getElementById('secret-paper-settings-overlay')?.classList.remove('active');
};

window.setSecretPaperColor = function(color) {
  patchActivePaperSettings({ color });
  if (isDiaryCustomBg(color)) {
    try { localStorage.setItem('diary_custom_bg', color); } catch {}
  }
  refreshPaperAppearance();
};

window.setSecretPaperPattern = function(pattern) {
  patchActivePaperSettings({ pattern });
  refreshPaperAppearance();
};

window.setSecretPaperFlip = function(flip) {
  patchActivePaperSettings({ flip });
  refreshPaperAppearance();
};

window.setSecretPaperUserFont = function(userFont) {
  patchActivePaperSettings({ userFont });
  refreshPaperAppearance();
};

window.setSecretPaperAiFont = function(aiFont) {
  patchActivePaperSettings({ aiFont });
  refreshPaperAppearance();
};

window.setSecretPaperUserInk = function(userInk) {
  patchActivePaperSettings({ userInk });
  refreshPaperAppearance();
};

window.setSecretPaperAiInk = function(aiInk) {
  patchActivePaperSettings({ aiInk });
  refreshPaperAppearance();
};

window.setSecretPaperUserFontSize = function(v) {
  patchActivePaperSettings({ userFontSize: Number(v) });
  refreshPaperAppearance();
};

window.setSecretPaperAiFontSize = function(v) {
  patchActivePaperSettings({ aiFontSize: Number(v) });
  refreshPaperAppearance();
};

window.setSecretPaperMarkColor = function(key, value) {
  if (!['markCircle', 'markStrike', 'markLine', 'markNote'].includes(key)) return;
  patchActivePaperSettings({ [key]: value });
  refreshPaperAppearance();
};

window.applyCustomDiaryBg = async function(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const result = await pickCropAndUpload(file, { title: '裁剪秘密簿背景', aspect: 3 / 4 });
    if (!result?.url) { window.showToast?.('未选择图片'); return; }
    localStorage.setItem('diary_custom_bg', result.url);
    setSecretPaperColor(result.url);
    window.showToast?.('已应用自定义背景');
  } catch (e) {
    console.warn('[paper] custom upload', e);
    window.showToast?.(e.message || '上传失败');
  }
  input.value = '';
};

/** 兼容旧调用名 */
window.selectDiaryPaper = function(id) {
  if (id === 'custom') {
    const url = localStorage.getItem('diary_custom_bg');
    if (url) setSecretPaperColor(url);
    return;
  }
  const legacy = DIARY_PAPERS.find(p => p.id === id);
  if (legacy) {
    const colorId = PAPER_COLORS.some(c => c.id === legacy.id)
      ? legacy.id
      : (legacy.id === 'ruled' || legacy.id === 'dots' ? 'cream' : legacy.id === 'grid' ? 'sky' : 'blank');
    patchActivePaperSettings({ color: colorId, pattern: legacy.pattern || 'none' });
    refreshPaperAppearance();
    return;
  }
  setSecretPaperColor(id);
};

// 阅读器左右滑翻页（触控 + 鼠标拖）；纵向滑动忽略
(function bindFlipSwipe() {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  function readerActive() {
    return !!document.getElementById('diary-view-overlay')?.classList.contains('active');
  }
  function onStart(x, y) {
    if (!readerActive()) return;
    tracking = true;
    startX = x;
    startY = y;
  }
  function onEnd(x, y) {
    if (!tracking || !readerActive()) { tracking = false; return; }
    tracking = false;
    const dx = x - startX;
    const dy = y - startY;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0) window.secretFlipNext?.();
    else window.secretFlipPrev?.();
  }

  function isReaderTypingTarget(el) {
    return !!el?.closest?.(
      'button, a, input, textarea, .topbar-action, #shared-memo-inline-composer, #sm-mark-note-editor, #sm-mark-dock, #sm-mark-note-sheet, .sm-tok'
    );
  }
  function isSharedMemoMarking() {
    const dock = document.getElementById('sm-mark-dock');
    return !!(dock && dock.style.display !== 'none' && _smMarkSel);
  }

  document.addEventListener('touchstart', (e) => {
    if (isReaderTypingTarget(e.target) || isSharedMemoMarking()) return;
    const t = e.touches[0];
    if (t) onStart(t.clientX, t.clientY);
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (isReaderTypingTarget(e.target) || isSharedMemoMarking()) { tracking = false; return; }
    const t = e.changedTouches[0];
    if (t) onEnd(t.clientX, t.clientY);
  }, { passive: true });

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (!e.target?.closest?.('#diary-view-overlay.secret-reader-docked, #diary-view-overlay.active')) return;
    if (isReaderTypingTarget(e.target) || isSharedMemoMarking()) return;
    onStart(e.clientX, e.clientY);
  });
  document.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') return;
    if (isSharedMemoMarking()) { tracking = false; return; }
    onEnd(e.clientX, e.clientY);
  });

  // 键盘弹出常触发 resize；此时再 dock/切片会改父级尺寸与 transform，
  // 把软键盘打掉，且输入框常仍保持 focus → 再点一次也不会重新弹键盘。
  const onReaderViewportChange = () => {
    if (!readerActive()) return;
    if (isSharedMemoComposerOpen()) return;
    if (document.activeElement?.closest?.(
      '#shared-memo-inline-composer, #sm-mark-note-editor, #diary-view-overlay textarea, #diary-view-overlay input'
    )) return;
    dockSecretReaderOverlay();
    applyContentSlice(false);
  };
  window.addEventListener('resize', onReaderViewportChange);
  window.visualViewport?.addEventListener('resize', onReaderViewportChange);
  window.visualViewport?.addEventListener('scroll', onReaderViewportChange);
})();

window.savePeekNoteToMemory = async function(diaryId, charId, secretNote, btn) {
  try {
    btn.disabled = true;
    btn.textContent = '存入中…';
    await api.savePeekToMemory(diaryId, { charId, secretNote });
    btn.textContent = '✓ 已存入记忆';
    window.showToast?.('心里话已存入TA的记忆');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '存入TA的记忆';
    window.showToast?.(e.message || '存入失败');
  }
};

window.saveSecretPeekNoteToMemory = async function(noteId, charId, secretNote, btn) {
  try {
    btn.disabled = true;
    btn.textContent = '存入中…';
    await api.saveSecretPeekToMemory(noteId, { charId, secretNote });
    btn.textContent = '✓ 已存入记忆';
    window.showToast?.('心里话已存入TA的记忆');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '存入TA的记忆';
    window.showToast?.(e.message || '存入失败');
  }
};

/* ===== 共享备忘录 ===== */
let _beautifyCoverUrl = null; // null=未改, ''=恢复默认, string=新封面
let _beautifyDirtyCover = false;
/** 从书架顶栏选中的美化对象（不依赖已打开的本子） */
let _beautifyContext = null;
let _shelfPickMode = ''; // beautify | delete

function sharedMemoCoverKey(bookId) {
  return secretBookCoverKey('shelf', 'shared', bookId);
}

function beautifyTarget() {
  if (_beautifyContext) return _beautifyContext;
  if (_sharedBook) {
    return {
      kind: 'shared',
      bookId: _sharedBook.id,
      coverKey: sharedMemoCoverKey(_sharedBook.id),
      avatar: _sharedBook.char_avatar,
      emoji: '📝',
      title: sharedMemoDisplayTitle(_sharedBook),
    };
  }
  if (_currentBook) {
    const ownerId = _currentBook.type === 'user' ? 'user' : _currentBook.charId;
    return {
      kind: 'secret',
      type: _currentBook.type,
      charId: _currentBook.charId,
      charName: _currentBook.charName,
      charAvatar: _currentBook.charAvatar,
      coverKey: secretBookCoverKey('shelf', _currentBook.type, ownerId),
      avatar: _currentBook.charAvatar,
      emoji: _currentBook.type === 'user' ? '🔐' : '📖',
      title: secretBookDisplayTitle(_currentBook),
      titleKey: `shelf:${_currentBook.type}:${ownerId}`,
    };
  }
  return null;
}

function openShelfPickOverlay(title, hint, listHtml) {
  document.getElementById('secret-shelf-pick-title').textContent = title;
  document.getElementById('secret-shelf-pick-hint').textContent = hint;
  document.getElementById('secret-shelf-pick-list').innerHTML = listHtml;
  const el = document.getElementById('secret-shelf-pick');
  el.style.display = 'flex';
  el.classList.add('active');
}

window.closeShelfPick = function() {
  const el = document.getElementById('secret-shelf-pick');
  el?.classList.remove('active');
  if (el) el.style.display = 'none';
  _shelfPickMode = '';
};

window.openShelfBeautifyPick = async function() {
  if (_view !== 'shelf') {
    await showShelf();
  }
  _shelfPickMode = 'beautify';
  let sharedBooks = [];
  try { sharedBooks = await api.getSharedMemos(); } catch {}
  const chars = window.getFriendCharacters?.() || window.getAppCharacters?.() || [];
  const friendIds = new Set(chars.map((c) => Number(c.id)));
  const items = [];

  items.push({
    key: 'secret:user',
    label: secretBookDisplayTitle({ type: 'user', charId: null, charName: '我的秘密' }),
    hint: '秘密本',
    avatar: '',
    emoji: '🔐',
    onclick: `pickShelfBeautifySecret(${JSON.stringify({ type: 'user', charId: null, charName: '我的秘密', charAvatar: '' })})`,
  });
  chars.forEach(c => {
    items.push({
      key: `secret:ai:${c.id}`,
      label: secretBookDisplayTitle({ type: 'ai', charId: c.id, charName: c.name }),
      hint: '秘密本',
      avatar: c.avatar || '',
      emoji: '📖',
      onclick: `pickShelfBeautifySecret(${JSON.stringify({ type: 'ai', charId: c.id, charName: c.name, charAvatar: c.avatar || '' })})`,
    });
  });
  sharedBooks.filter((b) => friendIds.has(Number(b.character_id))).forEach(b => {
    items.push({
      key: `shared:${b.id}`,
      label: sharedMemoDisplayTitle(b),
      hint: '随手记',
      avatar: b.char_avatar || '',
      emoji: '📝',
      onclick: `pickShelfBeautifyShared(${b.id})`,
    });
  });

  const listHtml = items.map(it => {
    const av = it.avatar
      ? `<img src="${escapeHtml(it.avatar)}" alt="">`
      : `<span class="shared-memo-char-fallback">${it.emoji}</span>`;
    return `<button type="button" class="shared-memo-char-card" onclick='${it.onclick}'>
      <div class="shared-memo-char-avatar">${av}</div>
      <div class="shared-memo-char-info">
        <div class="shared-memo-char-name">${escapeHtml(it.label)}</div>
        <div class="shared-memo-char-hint">${escapeHtml(it.hint)}</div>
      </div>
      <span class="shared-memo-char-chevron">›</span>
    </button>`;
  }).join('');

  openShelfPickOverlay('美化', '选一本秘密本或随手记，改名称和封面', listHtml);
};

window.openShelfDeletePick = async function() {
  if (_view !== 'shelf') {
    await showShelf();
  }
  _shelfPickMode = 'delete';
  let sharedBooks = [];
  try { sharedBooks = await api.getSharedMemos(); } catch {}
  if (!sharedBooks.length) {
    window.showToast?.('还没有随手记可删');
    return;
  }
  const listHtml = sharedBooks.map(b => {
    const av = b.char_avatar
      ? `<img src="${escapeHtml(b.char_avatar)}" alt="">`
      : `<span class="shared-memo-char-fallback">📝</span>`;
    return `<button type="button" class="shared-memo-char-card" onclick="confirmDeleteSharedMemoBook(${b.id});closeShelfPick()">
      <div class="shared-memo-char-avatar">${av}</div>
      <div class="shared-memo-char-info">
        <div class="shared-memo-char-name">${escapeHtml(sharedMemoDisplayTitle(b))}</div>
        <div class="shared-memo-char-hint">${b.entry_count || 0} 条 · 删除整本</div>
      </div>
      <span class="shared-memo-char-chevron">›</span>
    </button>`;
  }).join('');
  openShelfPickOverlay('删除随手记', '选一本要删除的随手记（不可恢复）', listHtml);
};

window.pickShelfBeautifySecret = function(payload) {
  closeShelfPick();
  const type = payload?.type || 'user';
  const charId = payload?.charId ?? null;
  const charName = payload?.charName || (type === 'user' ? '我的秘密' : '秘密');
  const charAvatar = payload?.charAvatar || '';
  const ownerId = type === 'user' ? 'user' : charId;
  _beautifyContext = {
    kind: 'secret',
    type,
    charId,
    charName,
    charAvatar,
    coverKey: secretBookCoverKey('shelf', type, ownerId),
    avatar: charAvatar,
    emoji: type === 'user' ? '🔐' : '📖',
    title: secretBookDisplayTitle({ type, charId, charName }),
    titleKey: `shelf:${type}:${ownerId}`,
  };
  window.openSecretBeautify();
};

window.pickShelfBeautifyShared = async function(bookId) {
  closeShelfPick();
  try {
    const book = await api.getSharedMemo(bookId);
    _beautifyContext = {
      kind: 'shared',
      bookId: book.id,
      coverKey: sharedMemoCoverKey(book.id),
      avatar: book.char_avatar,
      emoji: '📝',
      title: sharedMemoDisplayTitle(book),
      book,
    };
    window.openSecretBeautify();
  } catch (e) {
    window.showToast?.(e.message || '打开失败');
  }
};

function renderBeautifyCoverPreview(target) {
  const preview = document.getElementById('secret-beautify-cover-preview');
  const resetBtn = document.getElementById('secret-beautify-cover-reset');
  if (!preview || !target) return;
  if (_beautifyDirtyCover) {
    if (_beautifyCoverUrl) {
      preview.innerHTML = `<img class="secret-book-cover-img" src="${escapeHtml(_beautifyCoverUrl)}" alt="">`;
    } else {
      preview.innerHTML = target.avatar
        ? `<img class="secret-book-cover-img" src="${escapeHtml(target.avatar)}" alt="">`
        : `<div class="secret-book-cover-fallback">${target.emoji}</div>`;
    }
  } else {
    preview.innerHTML = resolveSecretBookCoverHtml(target.coverKey, target.avatar, target.emoji);
  }
  const hasCustom = _beautifyDirtyCover ? !!_beautifyCoverUrl : !!getSecretBookCovers()[target.coverKey];
  if (resetBtn) resetBtn.style.display = hasCustom ? '' : 'none';
}

window.openSecretBeautify = function() {
  const target = beautifyTarget();
  if (!target) {
    window.openShelfBeautifyPick?.();
    return;
  }
  _beautifyCoverUrl = null;
  _beautifyDirtyCover = false;
  const titleEl = document.getElementById('secret-beautify-title');
  if (titleEl) {
    titleEl.value = target.title;
    titleEl.placeholder = target.kind === 'shared' ? '和TA的随手记' : '秘密本名称';
  }
  renderBeautifyCoverPreview(target);
  const el = document.getElementById('secret-beautify-overlay');
  el.style.display = 'flex';
  el.classList.add('active');
};

window.closeSecretBeautify = function() {
  const el = document.getElementById('secret-beautify-overlay');
  el.classList.remove('active');
  el.style.display = 'none';
  _beautifyCoverUrl = null;
  _beautifyDirtyCover = false;
  _beautifyContext = null;
};

window.pickSecretBeautifyCover = async function() {
  const target = beautifyTarget();
  if (!target) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,image/gif,image/webp';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { window.showToast?.('图片不能超过 4MB'); return; }
    try {
      const result = await pickCropAndUpload(file, { title: '裁剪封面', aspect: 3 / 4 });
      if (!result?.url) return;
      _beautifyCoverUrl = result.url;
      _beautifyDirtyCover = true;
      renderBeautifyCoverPreview(target);
    } catch (e) {
      window.showToast?.(e.message || '上传失败');
    }
  };
  input.click();
};

window.resetSecretBeautifyCover = function() {
  const target = beautifyTarget();
  if (!target) return;
  _beautifyCoverUrl = '';
  _beautifyDirtyCover = true;
  renderBeautifyCoverPreview(target);
};

window.saveSecretBeautify = async function() {
  const target = beautifyTarget();
  if (!target) return;
  const title = String(document.getElementById('secret-beautify-title')?.value || '').trim();
  if (!title) {
    window.showToast?.('名称不能为空');
    return;
  }
  try {
    if (target.kind === 'shared') {
      const bookId = target.bookId || _sharedBook?.id;
      if (!bookId) throw new Error('找不到随手记');
      const updated = await api.updateSharedMemo(bookId, { title });
      if (_sharedBook && Number(_sharedBook.id) === Number(bookId)) {
        _sharedBook = updated ? { ..._sharedBook, ...updated } : { ..._sharedBook, title };
      }
    } else if (target.kind === 'secret') {
      const titleKey = target.titleKey || `shelf:${target.type}:${target.type === 'user' ? 'user' : target.charId}`;
      setSecretBookTitle(titleKey, title);
    }

    if (_beautifyDirtyCover && target.coverKey) {
      if (_beautifyCoverUrl) setSecretBookCover(target.coverKey, _beautifyCoverUrl);
      else removeSecretBookCover(target.coverKey);
    }

    closeSecretBeautify();
    window.showToast?.('已保存');
    if (_view === 'shelf') await showShelf();
    else if (_sharedBook && _view === 'shared') {
      document.getElementById('diary-topbar-title').textContent = sharedMemoDisplayTitle(_sharedBook);
      await renderSharedMemoView();
    } else if (_currentBook && _view === 'toc') {
      await showSectionToc();
    } else if (_currentBook && _view === 'section') {
      const label = SECTION_META[_section]?.label || _section;
      document.getElementById('diary-topbar-title').textContent = `${secretBookDisplayTitle(_currentBook)} · ${label}`;
      await renderBookSection();
    }
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.openSharedMemoCharPick = function() {
  const chars = window.getFriendCharacters?.() || window.getAppCharacters?.() || [];
  const list = document.getElementById('shared-memo-char-list');
  if (!chars.length) {
    window.showToast?.('请先添加好友');
    return;
  }
  list.innerHTML = chars.map(c => {
    const av = c.avatar
      ? `<img src="${escapeHtml(c.avatar)}" alt="">`
      : '<span class="shared-memo-char-fallback">👤</span>';
    return `<button type="button" class="shared-memo-char-card" onclick="createOrOpenSharedMemo(${c.id})">
      <div class="shared-memo-char-avatar">${av}</div>
      <div class="shared-memo-char-info">
        <div class="shared-memo-char-name">${escapeHtml(c.name)}</div>
        <div class="shared-memo-char-hint">开一本「和${escapeHtml(c.name)}的随手记」</div>
      </div>
      <span class="shared-memo-char-chevron">›</span>
    </button>`;
  }).join('');
  const el = document.getElementById('shared-memo-char-pick');
  el.style.display = 'flex';
  el.classList.add('active');
};

window.closeSharedMemoCharPick = function() {
  const el = document.getElementById('shared-memo-char-pick');
  el.classList.remove('active');
  el.style.display = 'none';
};

window.createOrOpenSharedMemo = async function(characterId) {
  try {
    closeSharedMemoCharPick();
    window.showToast?.('打开中…');
    const book = await api.createSharedMemo({ characterId });
    await openSharedMemoBook(book.id);
  } catch (e) {
    window.showToast?.(e.message || '打开失败');
  }
};

function enterSharedMemoChrome(book) {
  _sharedBook = book;
  _currentBook = null;
  _view = 'shared';
  _smDraft = { images: [], emojis: [] };
  const backBtn = document.getElementById('diary-back-btn');
  if (backBtn) backBtn.onclick = diaryGoBack;
  const settingsBtn = document.getElementById('diary-paper-settings-btn');
  if (settingsBtn) settingsBtn.style.display = '';
  const titleEl = document.getElementById('diary-topbar-title');
  if (titleEl) titleEl.textContent = sharedMemoDisplayTitle(book);
  updateAddBtn();
}

function quickSharedMemoEntries(bookId) {
  const id = Number(bookId);
  const today = sharedMemoLocalToday();
  const sess = _smSessionByBook.get(id);
  const disk = readSmPastCache(id);
  const diskToday = disk?.todayAtSync === today ? (disk.today || []) : [];
  return mergeSmEntriesById(disk?.past || [], diskToday, sess?.entries || []);
}

window.openSharedMemoBook = async function(bookId) {
  try {
    const id = Number(bookId);
    const sess = _smSessionByBook.get(id);
    const shelfBook = (_shelfCache?.sharedBooks || []).find(b => Number(b.id) === id);
    const disk = readSmPastCache(id);
    const quickBook = sess?.book || shelfBook || disk?.book || { id, title: '随手记' };
    const quickEntries = quickSharedMemoEntries(id);

    enterSharedMemoChrome(quickBook);
    _smCachedEntries = quickEntries;
    rememberSmSession(id, { book: quickBook, entries: quickEntries });
    // 立刻画出书桌/空状态，避免紫色底 + loading 闪一下
    paintSharedMemoList(quickEntries);

    const refresh = async () => {
      if (!quickBook.character_id) {
        try {
          const book = await api.getSharedMemo(id);
          if (_sharedBook?.id === id && _view === 'shared') {
            _sharedBook = book;
            const titleEl = document.getElementById('diary-topbar-title');
            if (titleEl) titleEl.textContent = sharedMemoDisplayTitle(book);
            rememberSmSession(id, { book });
          }
        } catch {}
      }
      const entries = await loadSharedMemoEntriesSmart(id);
      if (_sharedBook?.id !== id || _view !== 'shared') return;
      _smCachedEntries = mergeSmEntriesById(_smCachedEntries, entries);
      rememberSmSession(id, { book: _sharedBook, entries: _smCachedEntries });
      writeSmPastCache(id, {
        past: (_smCachedEntries || []).filter((e) => sharedMemoEntryDate(e) < sharedMemoLocalToday()),
        today: (_smCachedEntries || []).filter((e) => sharedMemoEntryDate(e) >= sharedMemoLocalToday()),
        todayAtSync: sharedMemoLocalToday(),
        book: _sharedBook,
      });
      paintSharedMemoList(_smCachedEntries);
    };
    refresh().catch((e) => {
      if (!quickEntries.length) {
        window.showToast?.(e.message || '加载失败');
        showShelf();
      }
    });
  } catch (e) {
    window.showToast?.(e.message || '加载失败');
    showShelf();
  }
};

function sharedMemoEntryDate(entry) {
  return String(entry.visible_at || entry.created_at || '').slice(0, 10) || '未知';
}

function sharedMemoPreview(entry) {
  let text = String(entry.content || '')
    .replace(/\[em\|[^\]|]+\|[^\]]*\]/g, ' ')
    .replace(/\[表情\][\s\S]*?\[\/表情\]/g, ' ')
    .replace(/【表情】[\s\S]*?【\/表情】/g, ' ')
    .replace(/\[表情[:：][^\]\n]+\]/g, ' ')
    .replace(/【表情[:：][^】\n]+】/g, ' ')
    .replace(/\[表情包\][「『"'【\[]*[^」』"'】\]\n]+[」』"'】\]]?/g, ' ')
    .replace(/【表情包】[「『"'【\[]*[^」』"'】\]\n]+[」』"'】\]]?/g, ' ')
    .replace(/\[发送表情包：[^\]\n]+\]/g, ' ')
    .replace(/\[\s*配图\s*[:：]?[^\]]*\]/gi, ' ')
    .replace(/\[\s*配图\s*\]\s*/gi, ' ')
    .replace(/(?:配图[：:]\s*|IMAGE:\s*)[^\n]*/gi, ' ')
    .replace(/配图提示词\s*[：:][^\n]*/gi, ' ')
    .replace(/(?:photorealistic|shot on smartphone|documentary realism|NOT anime|scene:\s*)[^\n]*/gi, ' ')
    .replace(/\[\s*图片(?:\s*[×xX]\s*\d+)?\s*\]/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 已知小黄豆码剥掉，避免目录露出 [微笑]
  text = text.replace(/\[([^\[\]\n]{1,20})\]/g, (full, code) => {
    if (/^em\|/i.test(code)) return ' ';
    return lookupInlineEmoji(code) ? ' ' : full;
  }).replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 50) + (text.length > 50 ? '…' : '');
  const bits = [];
  if ((entry.images || []).length) bits.push(`[图片×${entry.images.length}]`);
  if ((entry.emojis || []).length) bits.push(`[表情×${entry.emojis.length}]`);
  return bits.join(' ') || '（空）';
}

function getSharedMemoCollapsedMonths() {
  try { return new Set(JSON.parse(localStorage.getItem('nian_shared_memo_collapsed_months') || '[]')); }
  catch { return new Set(); }
}

window.toggleSharedMemoMonth = function(ym) {
  const set = getSharedMemoCollapsedMonths();
  const section = document.querySelector(`.secret-month-section[data-ym="${ym}"][data-shared-memo]`);
  if (!section) return;
  const body = section.querySelector('.secret-month-body');
  const chev = section.querySelector('.secret-month-chevron');
  const open = body && body.style.display === 'none';
  if (body) body.style.display = open ? '' : 'none';
  if (chev) chev.style.transform = `rotate(${open ? 90 : 0}deg)`;
  if (open) set.delete(ym); else set.add(ym);
  try { localStorage.setItem('nian_shared_memo_collapsed_months', JSON.stringify([...set])); } catch {}
};

function groupSharedMemoByDate(entries) {
  const byDate = {};
  entries.forEach(e => {
    const d = sharedMemoEntryDate(e);
    (byDate[d] = byDate[d] || []).push(e);
  });
  Object.keys(byDate).forEach(d => {
    byDate[d].sort((a, b) => {
      const ta = String(a.visible_at || a.created_at || '');
      const tb = String(b.visible_at || b.created_at || '');
      return ta.localeCompare(tb) || (a.id - b.id);
    });
  });
  return byDate;
}

function renderSharedMemoListHtml(entries) {
  if (!entries.length) {
    return `<div class="empty-state"><div class="empty-icon">✎</div>
      <div class="empty-text">这页还是空白的<br>点右上角随手划几笔——风景、心情、刚拍的都行<br>TA 偶尔也会塞一张随手拍过来</div></div>`;
  }

  const byDate = groupSharedMemoByDate(entries);
  const groups = {};
  Object.keys(byDate).forEach(d => {
    const ym = d.slice(0, 7) || '未知';
    (groups[ym] = groups[ym] || []).push(d);
  });
  Object.keys(groups).forEach(ym => groups[ym].sort((a, b) => b.localeCompare(a)));

  const collapsedMonths = getSharedMemoCollapsedMonths();
  const todayYm = sharedMemoLocalToday().slice(0, 7);
  // 当前月默认展开，避免「刚写的今天」被折进折叠月份里看不见
  if (collapsedMonths.has(todayYm)) collapsedMonths.delete(todayYm);

  let html = '';
  Object.keys(groups).sort((a, b) => b.localeCompare(a)).forEach(ym => {
    const [y, m] = ym.split('-');
    const open = !collapsedMonths.has(ym);
    const dayCount = groups[ym].length;
    html += `<div class="secret-month-section" data-ym="${ym}" data-shared-memo>
      <div class="secret-month-header" onclick="toggleSharedMemoMonth('${ym}')">
        <span class="secret-month-chevron" style="transform:rotate(${open ? 90 : 0}deg)">›</span>
        <span>${y === '未知' ? '未知' : `${y}年${parseInt(m, 10)}月`}</span>
        <span class="secret-month-count">${dayCount} 天</span>
      </div>
      <div class="settings-group secret-month-body" style="display:${open ? '' : 'none'}">`;
    groups[ym].forEach(d => {
      const items = byDate[d];
      const last = items[items.length - 1] || items[0];
      const preview = sharedMemoPreview(last);
      const dateLabel = d.length >= 10 ? d.slice(5).replace('-', '/') : d;
      const countHint = items.length > 1 ? `${items.length} 笔` : '一笔';
      const thumbRaw = (last?.images || []).find(Boolean)
        || items.map(e => (e.images || [])[0]).find(Boolean)
        || '';
      const thumb = sharedMemoMediaUrl(thumbRaw);
      const thumbHtml = thumb
        ? `<img class="shared-memo-day-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" onerror="this.remove()">`
        : '';
      html += `
        <div class="shared-memo-day-card">
          <button type="button" class="shared-memo-day-main" onclick="openSharedMemoDay('${d}')">
            <div class="shared-memo-day-date">${escapeHtml(dateLabel)}</div>
            <div class="shared-memo-day-meta">${escapeHtml(countHint)}</div>
            <div class="shared-memo-day-preview">${escapeHtml(preview)}</div>
            ${thumbHtml}
          </button>
          <button type="button" class="shared-memo-day-del" title="撕掉这一天"
            onclick="deleteSharedMemoDay('${d}')">${ICON_TRASH}</button>
        </div>`;
    });
    html += `</div></div>`;
  });
  return html;
}

function paintSharedMemoList(entries) {
  const content = document.getElementById('diary-content');
  if (!content || !_sharedBook) return;
  const charName = escapeHtml(_sharedBook.char_name || 'TA');
  const body = renderSharedMemoListHtml(entries || []);
  content.innerHTML = `<div class="secret-section-body shared-memo-section">
    <div class="secret-open-desk">
      <div class="secret-open-book is-list">
        <div class="secret-open-book-binding" aria-hidden="true"></div>
        <div class="secret-open-book-sheet">
          <div class="shared-memo-hero">
            <div class="shared-memo-hero-title">${escapeHtml(sharedMemoDisplayTitle(_sharedBook))}</div>
            <div class="shared-memo-hero-desc">和 ${charName} 乱写乱贴 · 同一天叠在一页纸上</div>
          </div>
          ${body}
        </div>
      </div>
    </div>
  </div>`;
  content.style.background = '#d9cbb8';
  content.style.position = 'relative';
  content.style.minHeight = '100%';
}

async function renderSharedMemoView() {
  if (!_sharedBook) return showShelf();
  const content = document.getElementById('diary-content');
  content.style.background = '';
  content.style.position = 'relative';
  content.style.minHeight = '100%';
  const oldPat = content.querySelector('.secret-paper-pattern');
  if (oldPat) oldPat.remove();

  // 表情库延后到打开某一天再拉；目录列表不需要

  // 有历史缓存 / 会话缓存：先立刻画出列表，再只拉今天
  const today = sharedMemoLocalToday();
  const disk = readSmPastCache(_sharedBook.id);
  const sess = _smSessionByBook.get(Number(_sharedBook.id));
  if (sess?.entries?.length || disk?.past?.length || disk?.today?.length) {
    const quick = mergeSmEntriesById(
      disk?.past || [],
      disk?.todayAtSync === today ? (disk.today || []) : [],
      sess?.entries || [],
      (_smCachedEntries || []).filter((e) => sharedMemoEntryDate(e) >= today),
    );
    _smCachedEntries = quick;
    paintSharedMemoList(quick);
  } else {
    content.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  }

  let entries = [];
  try {
    entries = await loadSharedMemoEntriesSmart(_sharedBook.id);
  } catch (e) {
    if (!disk?.past?.length && !sess?.entries?.length) {
      content.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
    }
    return;
  }
  _smCachedEntries = mergeSmEntriesById(_smCachedEntries, entries);
  rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
  paintSharedMemoList(_smCachedEntries);
}

let _emojiDescLookup = null; // Map desc -> url

async function ensureEmojiDescLookup() {
  if (_emojiDescLookup) return _emojiDescLookup;
  const map = new Map();
  try {
    const cats = await api.getEmojiCategories();
    for (const c of cats || []) {
      for (const e of c.emojis || []) {
        const desc = String(e.description || '').trim();
        const url = e.url || (e.filename ? `/uploads/${e.filename}` : '');
        if (!desc || !url) continue;
        map.set(desc, url);
        map.set(desc.toLowerCase(), url);
      }
    }
  } catch {}
  _emojiDescLookup = map;
  return map;
}

function normalizeEmojiDescClient(desc) {
  return String(desc || '')
    .trim()
    .replace(/^[\s「『"'【\[]+|[\s」』"'】\]]+$/g, '');
}

function lookupEmojiUrl(desc, entryEmojis = []) {
  const d = normalizeEmojiDescClient(desc);
  if (!d) return '';
  // 优先用本条自带的 emojis 字段
  for (const em of entryEmojis || []) {
    const ed = normalizeEmojiDescClient(em.description || em.desc || '');
    if (ed && (ed === d || ed.includes(d) || d.includes(ed)) && em.url) return em.url;
  }
  if (_emojiDescLookup) {
    if (_emojiDescLookup.has(d)) return _emojiDescLookup.get(d);
    if (_emojiDescLookup.has(d.toLowerCase())) return _emojiDescLookup.get(d.toLowerCase());
    for (const [k, url] of _emojiDescLookup) {
      if (k.includes(d) || d.includes(k)) return url;
    }
  }
  return '';
}

/** 把正文里的表情标记与独立 emojis 字段渲染成跟文字同行的表情图 */
function sharedMemoFlowHtml(entry, paper) {
  let raw = String(entry.content || '');
  const entryEmojis = entry.emojis || [];

  // 把各种残留的文字标记先转成 [em|url|desc]，再统一渲染；找不到图时丢掉标记，绝不露出方括号
  const replaceMark = (desc) => {
    const d = normalizeEmojiDescClient(desc);
    const url = lookupEmojiUrl(d, entryEmojis);
    if (url) return `[em|${url}|${d}]`;
    return '';
  };
  // 历史残留的配图指令/占位：绝不原样露出
  raw = raw
    .replace(/\[\s*配图\s*[:：][^\]]*\]/gi, '')
    .replace(/\[\s*配图\s*\]\s*[^\n]*/gi, '')
    .replace(/【\s*配图\s*[:：]?[^】]*】/gi, '')
    .replace(/(?:^|\n)\s*(?:配图[：:]\s*|IMAGE:\s*)[^\n]*/gi, '\n')
    .replace(/(?:配图[：:]\s*|IMAGE:\s*)[^\n]*\s*$/gi, '')
    .replace(/配图提示词\s*[：:][^\n]*/gi, '')
    .replace(/(?:^|\n)\s*(?:photorealistic|shot on smartphone|documentary realism|NOT anime|NOT illustration|real-world photograph|scene:\s*)[^\n]*/gi, '\n')
    .replace(/\[\s*图片(?:\s*[×xX]\s*\d+)?\s*\]/g, '')
    .replace(/\[表情\]([\s\S]*?)\[\/表情\]/g, (_, d) => replaceMark(d))
    .replace(/【表情】([\s\S]*?)【\/表情】/g, (_, d) => replaceMark(d))
    .replace(/\[表情[:：]([^\]\n]+)\]/g, (_, d) => replaceMark(d))
    .replace(/【表情[:：]([^】\n]+)】/g, (_, d) => replaceMark(d))
    .replace(/\[表情包\][「『"'【\[]*([^」』"'】\]\n]+)[」』"'】\]]?/g, (_, d) => replaceMark(d))
    .replace(/【表情包】[「『"'【\[]*([^」』"'】\]\n]+)[」』"'】\]]?/g, (_, d) => replaceMark(d))
    .replace(/\[发送表情包：([^\]\n]+)\]/g, (_, d) => replaceMark(d))
    .replace(/\[表情\]([^\n\]]+)/g, (_, d) => replaceMark(d));

  // 系统小黄豆 [微笑] → [em|url|desc]，渲染时按 URL 区分尺寸
  raw = raw.replace(/\[([^\[\]\n]{1,20})\]/g, (full, code) => {
    if (/^em\|/i.test(code)) return full;
    const hit = lookupInlineEmoji(code);
    if (!hit) return full;
    return '[em|' + hit.url + '|' + hit.code + ']';
  });

  const parts = [];
  const re = /\[em\|([^\]|]+)\|([^\]]*)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    if (m.index > last) parts.push({ type: 'text', value: raw.slice(last, m.index) });
    parts.push({ type: 'em', url: m[1], desc: m[2] || '' });
    last = m.index + m[0].length;
  }
  if (last < raw.length) parts.push({ type: 'text', value: raw.slice(last) });
  if (!parts.length && !raw) parts.push({ type: 'text', value: '' });

  // 旧数据：独立 emojis 数组里还有正文没引用过的，追加在文末
  const leftover = entryEmojis.filter(em => {
    const u = em.url || '';
    return u && !raw.includes(`[em|${u}|`);
  });
  leftover.forEach(em => parts.push({ type: 'em', url: em.url, desc: em.description || '' }));

  const isInlineBeanUrl = (url) => /\/inline-emoji\//i.test(String(url || ''));

  return parts.map(p => {
    if (p.type === 'em') {
      const cls = isInlineBeanUrl(p.url) ? 'shared-memo-inline-emoji' : 'shared-memo-inline-sticker';
      return `<img class="${cls}" src="${escapeHtml(p.url)}" alt="${escapeHtml(p.desc)}" title="${escapeHtml(p.desc)}">`;
    }
    return applySharedMemoAnnotationsHtml(p.value, entry.annotations || [], paper, raw);
  }).join('');
}

function markColorForType(type, paper, override) {
  if (override && /^#[0-9a-fA-F]{6}$/.test(override)) return override;
  const map = {
    circle: paper?.markCircle || '#c45c5c',
    strike: paper?.markStrike || '#8b5a2b',
    line: paper?.markLine || '#2a6f9e',
    note: paper?.markNote || '#6b4ea0',
  };
  return map[type] || '#c45c5c';
}

/** 随手记图片地址：纠正带主机的 /uploads，去掉无效值 */
function sharedMemoMediaUrl(url) {
  let u = String(url || '').trim();
  if (!u || u === 'null' || u === 'undefined') return '';
  if (u.startsWith('data:image/')) return u;
  u = u.replace(/\\/g, '/');
  try {
    if (/^https?:\/\//i.test(u)) {
      const parsed = new URL(u, typeof location !== 'undefined' ? location.origin : 'http://localhost');
      if (parsed.pathname.includes('/uploads/')) {
        const i = parsed.pathname.indexOf('/uploads/');
        return parsed.pathname.slice(i) + (parsed.search || '');
      }
      return u;
    }
  } catch {}
  if (u.includes('/uploads/')) {
    const i = u.indexOf('/uploads/');
    return u.slice(i).split(/[#]/)[0];
  }
  if (u.startsWith('uploads/')) return `/${u}`;
  if (u.startsWith('/uploads/')) return u;
  if (/^[\w.-]+\.(png|jpe?g|gif|webp|bmp)$/i.test(u)) return `/uploads/${u}`;
  return '';
}

/** 被批词在正文里的行位：仅「多行且落在中间」才需要引线拉到外面 */
function sharedMemoQuoteLineInfo(fullText, quote) {
  const raw = String(fullText || '');
  const q = String(quote || '');
  const lines = raw.length ? raw.split('\n') : [''];
  const totalLines = Math.max(1, lines.length);
  const idx = q ? raw.indexOf(q) : -1;
  let lineIndex = 0;
  if (idx >= 0) {
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      const end = pos + lines[i].length;
      if (idx >= pos && idx <= end) {
        lineIndex = i;
        break;
      }
      pos = end + 1;
    }
  }
  const onFirst = lineIndex <= 0;
  const onLast = lineIndex >= totalLines - 1;
  // 正文够长（≥3 行）且被批处在中间 → 用引线；首行/末行或内容不长 → 不用
  const needLeader = totalLines >= 3 && !onFirst && !onLast;
  return { lineIndex, totalLines, onFirst, onLast, needLeader };
}

function applySharedMemoAnnotationsHtml(text, annotations, paper, fullText) {
  let html = escapeHtml(text);
  const sourceText = fullText != null ? String(fullText) : String(text || '');
  const marks = [...(annotations || [])]
    .filter((a) => a?.quote && ['circle', 'strike', 'line', 'note'].includes(a.type))
    .sort((a, b) => String(b.quote).length - String(a.quote).length);
  let midLeaderCount = 0;
  for (const a of marks) {
    const q = escapeHtml(String(a.quote));
    if (!q) continue;
    const idx = html.indexOf(q);
    if (idx < 0) continue;
    const color = markColorForType(a.type, paper, a.color);
    const noteRaw = String(a.note || '').trim();
    const byAi = a.by === 'ai';
    let callout = '';
    if (noteRaw) {
      const info = sharedMemoQuoteLineInfo(sourceText, a.quote);
      const tilt = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 5);
      // 旁注字迹跟批注作者一致（TA用 aiFont，我用 userFont），不继承被批正文
      const noteFontId = byAi ? (paper?.aiFont || 'serif') : (paper?.userFont || 'serif');
      const noteFontFamily = resolvePaperFont(noteFontId).family;
      const noteBaseSize = byAi ? (paper?.aiFontSize || 16) : (paper?.userFontSize || 16);
      const noteFontSize = Math.max(10, Math.round(noteBaseSize * 0.78));
      const noteSpan = `<span class="sm-mark-note-text" style="--sm-tilt:${tilt.toFixed(1)}deg;font-family:${noteFontFamily};font-size:${noteFontSize}px">${escapeHtml(noteRaw)}</span>`;
      let side;
      let withLeader = false;
      if (info.needLeader) {
        // 夹在中间：引到外侧，用引线连上（上下/侧面轮换）
        withLeader = true;
        side = ['side', 'above', 'below'][midLeaderCount % 3];
        midLeaderCount += 1;
      } else if (info.onFirst && !info.onLast) {
        side = 'above';
      } else if (info.onLast && !info.onFirst) {
        side = 'below';
      } else {
        // 一两行：贴在上方即可，不引线
        side = 'above';
      }
      let inner;
      if (withLeader) {
        const lineStyle = ['straight', 'dots', 'wavy'][Math.floor(Math.random() * 3)];
        const lineSpan = `<span class="sm-mark-callout-line sm-mark-line-${lineStyle}" aria-hidden="true"></span>`;
        inner = side === 'above' ? `${noteSpan}${lineSpan}` : `${lineSpan}${noteSpan}`;
      } else {
        inner = noteSpan;
      }
      const leaderClass = withLeader ? ' has-leader' : ' no-leader';
      callout = `<span class="sm-mark-callout sm-mark-callout-${side}${leaderClass}" style="--sm-mark-color:${color};font-family:${noteFontFamily}" aria-label="${escapeHtml(noteRaw)}">${inner}</span>`;
    }
    const annId = escapeHtml(String(a.id || ''));
    const wrap = `<span class="sm-mark sm-mark-${a.type}${noteRaw ? ' has-callout' : ''}" style="--sm-mark-color:${color}" title="${escapeHtml(noteRaw || '点这里写旁注')}" data-ann-id="${annId}" data-ann-by="${byAi ? 'ai' : 'user'}" data-ann-type="${escapeHtml(a.type)}" data-ann-quote="${escapeHtml(String(a.quote || ''))}" data-ann-note="${escapeHtml(noteRaw)}">${q}${callout}</span>`;
    html = html.slice(0, idx) + wrap + html.slice(idx + q.length);
  }
  return html.replace(/\n/g, '<br>');
}

function sharedMemoEntryBlockHtml(entry, paper) {
  const isUser = entry.role === 'user';
  const isAiReact = !isUser && entry.reply_to_id != null;
  const isAiProactive = !isUser && entry.reply_to_id == null;
  const fontId = isUser ? (paper?.userFont || 'serif') : (paper?.aiFont || 'serif');
  const fontFamily = resolvePaperFont(fontId).family;
  const fontSize = isUser ? (paper?.userFontSize || 16) : (paper?.aiFontSize || 16);
  const appearance = resolvePaperAppearance(paper);
  const ink = isUser
    ? (paper.userInk || appearance.textColor || '#3a3228')
    : (paper.aiInk || '#4a3a68');
  const who = isUser ? '你' : (_sharedBook?.char_name || 'TA');
  const flow = sharedMemoFlowHtml(entry, paper);
  const imgs = (entry.images || []).map(u => sharedMemoMediaUrl(u)).filter(Boolean).map(u =>
    `<span class="shared-memo-polaroid"><img class="shared-memo-page-media" src="${escapeHtml(u)}" alt="" loading="lazy" onclick="event.stopPropagation();window.open?.(this.src)"></span>`
  ).join('');
  const roleClass = isUser
    ? 'is-user'
    : (isAiReact ? 'is-ai is-ai-react' : 'is-ai is-ai-proactive');
  return `
    <div class="shared-memo-entry-block ${roleClass}" data-entry-id="${entry.id}"
      style="font-family:${fontFamily};font-size:${fontSize}px;color:${ink}">
      <span class="shared-memo-entry-who">— ${escapeHtml(who)}</span>
      <span class="shared-memo-flow" data-entry-id="${entry.id}">${flow}</span>
      ${imgs ? `<div class="shared-memo-page-media-row">${imgs}</div>` : ''}
    </div>`;
}

function sharedMemoDayBodyHtml(dayEntries) {
  const paper = getActivePaperSettings();
  return `<div class="shared-memo-day-page">${dayEntries.map(e => sharedMemoEntryBlockHtml(e, paper)).join('')}</div>`;
}

function buildSharedMemoDayPage(dateKey, dayEntries) {
  const canContinue = dateKey === sharedMemoLocalToday();
  const dateLabel = dateKey.length >= 10 ? dateKey.slice(5) : dateKey;
  const plain = (dayEntries || []).map(e => e.content || sharedMemoPreview(e)).join('\n');
  const actionParts = [];
  if ((dayEntries || []).length) {
    actionParts.push(`<button type="button" class="topbar-action topbar-action-danger" onclick="deleteSharedMemoDay('${dateKey}')" title="删除这一天">${ICON_TRASH}</button>`);
  }
  const bodyHtml = sharedMemoDayBodyHtml(dayEntries || []);
  const contentHtml = `<div class="shared-memo-paper-body secret-inset-paper">${bodyHtml}${canContinue ? sharedMemoInlineComposerHtml() : ''}</div>`;
  return {
    title: dateLabel || '今天',
    dateKey,
    sharedMemo: true,
    content: plain,
    plainContent: plain,
    contentHtml,
    actionsHtml: actionParts.join(''),
  };
}

async function presentSharedMemoDay(dateKey, dayEntries) {
  const canContinue = dateKey === sharedMemoLocalToday();
  if (!(dayEntries || []).length && !canContinue) return false;
  const page = buildSharedMemoDayPage(dateKey, dayEntries);
  _smReadingDateKey = dateKey;
  const overlay = document.getElementById('diary-view-overlay');
  const already = overlay?.classList.contains('active') && _readingPages?.[0]?.dateKey === dateKey;
  if (already) {
    _readingPages[0] = page;
    await showReadingPage(false);
  } else {
    await openFlipReader([page], 0);
  }
  return true;
}

window.openSharedMemoDay = async function(dateKey) {
  if (!_sharedBook || !dateKey) return;
  ensureEmojiDescLookup().catch(() => {});
  const cached = (groupSharedMemoByDate(_smCachedEntries || [])[dateKey] || []).slice();
  const canContinue = dateKey === sharedMemoLocalToday();
  if (cached.length || canContinue) {
    await presentSharedMemoDay(dateKey, cached);
  }

  try {
    const dayEntries = await api.getSharedMemoEntries(_sharedBook.id, { date: dateKey });
    _smCachedEntries = mergeSmEntriesById(_smCachedEntries, dayEntries);
    rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
    if (_view !== 'shared') return;
    if (_smReadingDateKey && _smReadingDateKey !== dateKey) return;
    // 用合并后的当天条目重绘，避免接口短暂返回空数组把已有内容盖成空白纸
    const mergedDay = (groupSharedMemoByDate(_smCachedEntries || [])[dateKey] || []).slice();
    if (mergedDay.length || canContinue) {
      await presentSharedMemoDay(dateKey, mergedDay);
    }
  } catch {
    if (!cached.length && !canContinue) {
      window.showToast?.('这一天加载失败');
    }
  }
};

function sharedMemoInlineComposerHtml() {
  return `
    <div id="shared-memo-inline-composer" class="shared-memo-inline-composer" style="display:none" onclick="event.stopPropagation()">
      <textarea id="sm-inline-input" class="shared-memo-inline-input" rows="3" placeholder="就在这页接着写…"></textarea>
      <div class="shared-memo-draft" id="sm-inline-draft"></div>
      <div class="shared-memo-inline-tools">
        <button type="button" class="shared-memo-tool-btn" onclick="(function(){const el=document.getElementById('shared-memo-image-input');if(el){el.value='';el.click();}})()" title="贴图">🖼</button>
        <button type="button" class="shared-memo-tool-btn" onclick="openSharedMemoEmojiPick()" title="表情包">☺</button>
        <span class="shared-memo-tool-hint">贴图 / 表情</span>
        <div class="shared-memo-inline-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="collapseSharedMemoComposer()">收起</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="saveSharedMemoInline()">保存</button>
        </div>
      </div>
    </div>
    <button type="button" class="shared-memo-tap-hint" id="shared-memo-tap-hint" onclick="event.stopPropagation();expandSharedMemoComposer()">……点这儿再划两笔</button>`;
}

function sharedMemoLocalToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

window.continueSharedMemoWrite = function() {
  expandSharedMemoComposer();
};

window.expandSharedMemoComposer = function() {
  if (!_sharedBook) return;
  const page = _readingPages[_readingIdx];
  if (!page?.sharedMemo || page.dateKey !== sharedMemoLocalToday()) {
    if (_view === 'shared') {
      openSharedMemoDay(sharedMemoLocalToday()).then(() => {
        setTimeout(() => expandSharedMemoComposer(), 80);
      });
    }
    return;
  }
  if (!_smDraft) _smDraft = { images: [], emojis: [] };
  if (!_smDraft.images) _smDraft.images = [];
  const composer = document.getElementById('shared-memo-inline-composer');
  const hint = document.getElementById('shared-memo-tap-hint');
  if (composer) composer.style.display = '';
  if (hint) hint.style.display = 'none';
  refreshSharedMemoDraft();
  const ta = document.getElementById('sm-inline-input');
  if (ta) {
    const paper = getActivePaperSettings();
    const font = resolvePaperFont(paper.userFont);
    ta.style.fontFamily = font.family;
    ta.style.fontSize = `${paper.userFontSize || 16}px`;
    ta.style.color = paper.userInk || '#3a3228';
    ta.setAttribute('inputmode', 'text');
    ta.removeAttribute('readonly');
    bindSharedMemoKeyboardRecover(ta);
  }
  // 先切片，再把输入区挪出 transform 层，最后 focus（避免假焦点导致再点不弹键盘）
  void composer?.offsetHeight;
  applyContentSlice(false);
  _sliceIdx = Math.max(0, (_sliceCount || 1) - 1);
  applyContentSlice(false);
  dockSharedMemoComposerForKeyboard();
  requestAnimationFrame(() => {
    try { ta?.focus?.({ preventScroll: true }); } catch { ta?.focus?.(); }
  });
};

window.collapseSharedMemoComposer = function() {
  const composer = document.getElementById('shared-memo-inline-composer');
  const hint = document.getElementById('shared-memo-tap-hint');
  const ta = document.getElementById('sm-inline-input');
  try { ta?.blur?.(); } catch { /* ignore */ }
  undockSharedMemoComposer();
  if (composer) composer.style.display = 'none';
  if (hint) hint.style.display = '';
  if (ta) ta.value = '';
  _smDraft = { images: [], emojis: [] };
  refreshSharedMemoDraft();
  requestAnimationFrame(() => applyContentSlice(true));
};

window.saveSharedMemoInline = async function() {
  if (!_sharedBook || window._smInlineSaving) return;
  const text = document.getElementById('sm-inline-input')?.value || '';
  const emojis = [];
  const re = /\[em\|([^\]|]+)\|([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text))) {
    emojis.push({ url: m[1], description: m[2] || '' });
  }
  const images = [...(_smDraft.images || [])];
  if (!text.trim() && !images.length && !emojis.length) {
    window.showToast?.('写点内容、图片或表情吧');
    return;
  }
  const today = sharedMemoLocalToday();
  const nowIso = new Date().toISOString();
  const tempId = -Date.now();
  const payload = { content: text, images, emojis };
  const optimistic = {
    id: tempId,
    book_id: _sharedBook.id,
    role: 'user',
    content: text,
    images,
    emojis,
    annotations: [],
    visible_at: nowIso,
    created_at: nowIso,
    status: 'visible',
  };
  window._smInlineSaving = true;
  try {
    // 先立刻写进纸页，再等接口，避免「保存后卡住空白」
    _smDraft = { images: [], emojis: [] };
    const ta = document.getElementById('sm-inline-input');
    if (ta) ta.value = '';
    refreshSharedMemoDraft();
    _smCachedEntries = upsertSmEntryInList(_smCachedEntries, optimistic);
    rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
    await presentSharedMemoDay(today, groupSharedMemoByDate(_smCachedEntries)[today] || []);
    requestAnimationFrame(() => expandSharedMemoComposer());

    const res = await api.createSharedMemoEntry(_sharedBook.id, payload);
    _smCachedEntries = (_smCachedEntries || []).filter((e) => Number(e.id) !== tempId);
    if (res?.entry) await refreshSharedMemoAfterWrite({ entry: res.entry });
    else await refreshSharedMemoAfterWrite();
    if (_view === 'shared' && _smReadingDateKey === today) {
      await presentSharedMemoDay(today, groupSharedMemoByDate(_smCachedEntries)[today] || []);
      requestAnimationFrame(() => expandSharedMemoComposer());
    }
    window.showToast?.('已写入，可继续写；TA 随后会回你');
  } catch (e) {
    _smCachedEntries = (_smCachedEntries || []).filter((e0) => Number(e0.id) !== tempId);
    if (_view === 'shared') {
      await presentSharedMemoDay(today, groupSharedMemoByDate(_smCachedEntries)[today] || []).catch(() => {});
    }
    window.showToast?.(e.message || '保存失败');
  } finally {
    window._smInlineSaving = false;
  }
};

/** 把正文拆成可点选的字/词，避免手机网页长按选字 */
function prepareSharedMemoTapTokens() {
  document.querySelectorAll('.shared-memo-flow').forEach((flow) => {
    if (flow.dataset.tokReady === '1') return;
    const entryId = Number(
      flow.dataset.entryId || flow.closest('.shared-memo-entry-block')?.dataset?.entryId || 0
    );
    if (!entryId) return;
    let idx = 0;
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 1) {
        if (node.classList?.contains('sm-mark')
          || node.classList?.contains('sm-mark-callout')
          || node.classList?.contains('sm-mark-note-text')
          || node.classList?.contains('sm-tok')
          || node.closest?.('#shared-memo-inline-composer')) {
          return;
        }
        [...node.childNodes].forEach(walk);
        return;
      }
      if (node.nodeType !== 3) return;
      const text = node.textContent || '';
      if (!text) return;
      if (node.parentElement?.closest?.('.sm-mark, .sm-mark-callout, .sm-mark-note-text, .sm-tok')) return;
      const parts = text.match(/[\u4e00-\u9fff]|[a-zA-Z0-9]+|./g) || [];
      if (!parts.length) return;
      const frag = document.createDocumentFragment();
      for (const p of parts) {
        if (/^\s+$/.test(p)) {
          frag.appendChild(document.createTextNode(p));
          continue;
        }
        const span = document.createElement('span');
        span.className = 'sm-tok';
        span.dataset.idx = String(idx++);
        span.dataset.entryId = String(entryId);
        span.textContent = p;
        frag.appendChild(span);
      }
      node.parentNode?.replaceChild(frag, node);
    };
    walk(flow);
    flow.dataset.tokReady = '1';
  });
}

function showSharedMemoMarkDock() {
  const dock = document.getElementById('sm-mark-dock');
  if (dock) dock.style.display = 'flex';
  document.getElementById('diary-view-overlay')?.classList.add('sm-marking');
  updateSharedMemoMarkHint();
  updateSharedMemoDockQuote();
}

function updateSharedMemoDockQuote() {
  const el = document.getElementById('sm-mark-dock-quote');
  if (!el) return;
  const q = String(_smMarkSel?.quote || '').trim();
  if (!q) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = '';
  el.textContent = `已选：${q.length > 24 ? `${q.slice(0, 24)}…` : q}`;
}

function refreshSharedMemoTokHighlight() {
  document.querySelectorAll('.sm-tok.is-picked').forEach((el) => el.classList.remove('is-picked'));
  if (!_smMarkSel?.entryId || _smMarkSel.a == null || _smMarkSel.b == null) return;
  const lo = Math.min(_smMarkSel.a, _smMarkSel.b);
  const hi = Math.max(_smMarkSel.a, _smMarkSel.b);
  document.querySelectorAll(`.sm-tok[data-entry-id="${_smMarkSel.entryId}"]`).forEach((tok) => {
    const i = Number(tok.dataset.idx);
    if (i >= lo && i <= hi) tok.classList.add('is-picked');
  });
}

function syncQuoteFromSharedMemoTokens() {
  if (!_smMarkSel?.entryId || _smMarkSel.a == null || _smMarkSel.b == null) {
    if (_smMarkSel) _smMarkSel.quote = '';
    updateSharedMemoDockQuote();
    updateSharedMemoMarkHint();
    return;
  }
  const lo = Math.min(_smMarkSel.a, _smMarkSel.b);
  const hi = Math.max(_smMarkSel.a, _smMarkSel.b);
  const toks = [...document.querySelectorAll(`.sm-tok[data-entry-id="${_smMarkSel.entryId}"]`)]
    .filter((t) => {
      const i = Number(t.dataset.idx);
      return i >= lo && i <= hi;
    })
    .sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx));
  _smMarkSel.quote = toks.map((t) => t.textContent || '').join('').trim();
  refreshSharedMemoTokHighlight();
  updateSharedMemoDockQuote();
  updateSharedMemoMarkHint();
}

function onSharedMemoTokenTap(tok) {
  const entryId = Number(tok.dataset.entryId);
  const idx = Number(tok.dataset.idx);
  if (!entryId || !Number.isFinite(idx)) return;
  closeSharedMemoNoteSheet(false);
  document.querySelectorAll('.shared-memo-entry-block.is-marking').forEach((el) => el.classList.remove('is-marking'));
  tok.closest('.shared-memo-entry-block')?.classList?.add('is-marking');
  if (!_smMarkSel || Number(_smMarkSel.entryId) !== entryId) {
    _smMarkSel = { entryId, a: idx, b: idx, pendingType: '' };
  } else if (_smMarkSel.a === idx && _smMarkSel.b === idx) {
    // 再点同一字：取消选中
    hideSharedMemoMarkToolbar();
    return;
  } else {
    // 扩展到点到的字（连续区间）
    _smMarkSel.b = idx;
  }
  document.querySelectorAll('.sm-mark-toolbar-btns button.active').forEach((b) => b.classList.remove('active'));
  syncQuoteFromSharedMemoTokens();
  showSharedMemoMarkDock();
}

function setupSharedMemoMarkSelection() {
  if (_smMarkSelectionBound) return;
  _smMarkSelectionBound = true;

  document.addEventListener('click', (e) => {
    if (!document.getElementById('diary-view-overlay')?.classList.contains('active')) return;
    if (e.target?.closest?.('#sm-mark-dock, #sm-mark-note-sheet, #sm-mark-note-editor')) return;
    if (e.target?.closest?.('#shared-memo-inline-composer')) {
      hideSharedMemoMarkToolbar();
      closeSharedMemoNoteSheet(false);
      return;
    }
    const markEl = e.target?.closest?.('.sm-mark');
    if (markEl && markEl.closest?.('.shared-memo-paper-body') && !e.target?.closest?.('.sm-tok')) {
      e.stopPropagation();
      e.preventDefault();
      hideSharedMemoMarkToolbar();
      openSharedMemoNoteEditor(markEl);
      return;
    }
    const tok = e.target?.closest?.('.sm-tok');
    if (tok && tok.closest?.('.shared-memo-paper-body')) {
      e.stopPropagation();
      e.preventDefault();
      onSharedMemoTokenTap(tok);
      return;
    }
    // 点空白：收起（点在纸面上非字时）
    if (!e.target?.closest?.('.shared-memo-paper-body')) {
      hideSharedMemoMarkToolbar();
      closeSharedMemoNoteSheet(false);
    }
  }, true);
}

function hideSharedMemoMarkToolbar() {
  const dock = document.getElementById('sm-mark-dock');
  if (dock) dock.style.display = 'none';
  document.getElementById('diary-view-overlay')?.classList.remove('sm-marking');
  document.querySelectorAll('.shared-memo-entry-block.is-marking').forEach((el) => el.classList.remove('is-marking'));
  document.querySelectorAll('.sm-tok.is-picked').forEach((el) => el.classList.remove('is-picked'));
  document.querySelectorAll('.sm-mark-toolbar-btns button.active').forEach((b) => b.classList.remove('active'));
  const quoteEl = document.getElementById('sm-mark-dock-quote');
  if (quoteEl) {
    quoteEl.style.display = 'none';
    quoteEl.textContent = '';
  }
  try { window.getSelection()?.removeAllRanges?.(); } catch {}
  _smMarkSel = null;
  updateSharedMemoMarkHint();
}

function updateSharedMemoMarkHint() {
  const hint = document.getElementById('sm-mark-toolbar-hint');
  if (!hint) return;
  if (!_smMarkSel) {
    hint.textContent = '点正文里的字选中，再点下方方式；已批的词可再点开写旁注';
    return;
  }
  const q = String(_smMarkSel.quote || '').trim();
  if (q) {
    hint.textContent = '可再点相邻字扩大选区，然后点圈词 / 划掉 / 划线 / 旁注';
  } else {
    hint.textContent = '点正文里的字开始选';
  }
}

window.pickSharedMemoMarkTool = function(type) {
  if (!_smMarkSel?.entryId) {
    window.showToast?.('先点正文里要批的字');
    return;
  }
  if (!['circle', 'strike', 'line', 'note'].includes(type)) return;
  closeSharedMemoNoteSheet(false);
  syncQuoteFromSharedMemoTokens();
  if (!String(_smMarkSel.quote || '').trim()) {
    window.showToast?.('先点选要批的字');
    return;
  }
  if (String(_smMarkSel.quote).trim().length > 40) {
    window.showToast?.('选太长了，少点几个字');
    return;
  }
  _smMarkSel.pendingType = type;
  document.querySelectorAll('.sm-mark-toolbar-btns button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mark === type);
  });
  // 一点即批，不再要长按选字 / 二次确认
  window.confirmSharedMemoMark?.();
};

/** 关闭旁注内联输入；save=true 时提交（兼容旧浮动框） */
function closeSharedMemoNoteEditor(save) {
  const ed = document.getElementById('sm-mark-note-editor');
  if (!ed) return;
  const input = ed.querySelector('input');
  const payload = ed._smNotePayload;
  ed.remove();
  if (!save || !payload || !input) return;
  const note = String(input.value || '').trim().slice(0, 80);
  if (note === String(payload.existingNote || '').trim()) return;
  saveSharedMemoAnnotationNote(payload, note);
}

window.closeSharedMemoNoteSheet = function(save) {
  const sheet = document.getElementById('sm-mark-note-sheet');
  if (!sheet || sheet.style.display === 'none') {
    closeSharedMemoNoteEditor(save);
    return;
  }
  const input = document.getElementById('sm-mark-note-sheet-input');
  const payload = sheet._smNotePayload;
  const note = String(input?.value || '').trim().slice(0, 80);
  sheet.style.display = 'none';
  sheet._smNotePayload = null;
  if (input) input.value = '';
  if (!save || !payload) return;
  if (note === String(payload.existingNote || '').trim()) return;
  saveSharedMemoAnnotationNote(payload, note);
};

function openSharedMemoNoteSheet(payload) {
  const sheet = document.getElementById('sm-mark-note-sheet');
  const input = document.getElementById('sm-mark-note-sheet-input');
  if (!sheet || !input || !payload) return;
  closeSharedMemoNoteEditor(false);
  hideSharedMemoMarkToolbar();
  sheet._smNotePayload = payload;
  input.value = String(payload.existingNote || '');
  sheet.style.display = 'flex';
  try {
    const paper = getActivePaperSettings();
    const font = resolvePaperFont(paper?.userFont || 'serif');
    if (font?.family) input.style.fontFamily = font.family;
  } catch {}
  setTimeout(() => {
    input.focus();
    input.select?.();
  }, 40);
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      window.closeSharedMemoNoteSheet(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      window.closeSharedMemoNoteSheet(false);
    }
  };
}

async function saveSharedMemoAnnotationNote(payload, note) {
  if (!_sharedBook || !payload?.entryId || !payload?.quote) return;
  const paper = getActivePaperSettings();
  const type = payload.type || 'note';
  const color = payload.color || markColorForType(type, paper);
  try {
    const res = await api.patchSharedMemoEntry(_sharedBook.id, payload.entryId, {
      annotation: {
        id: payload.id || undefined,
        type,
        quote: payload.quote,
        note,
        color,
        by: 'user',
      },
    });
    window.showToast?.(note ? '已旁注' : '已更新批注');
    if (res?.entry) await refreshSharedMemoAfterWrite({ entry: res.entry });
    else await refreshSharedMemoAfterWrite();
    const dateKey = _smReadingDateKey || sharedMemoLocalToday();
    await openSharedMemoDay(dateKey);
  } catch (e) {
    window.showToast?.(e.message || '旁注失败');
  }
}

/** 在圈词/划线处写旁注：底部输入条，不再飘在字旁边 */
function openSharedMemoNoteEditor(markEl) {
  if (!markEl) return;
  const entryId = Number(
    markEl.closest('.shared-memo-entry-block')?.dataset?.entryId
    || markEl.closest('.shared-memo-flow')?.dataset?.entryId
  );
  const quote = markEl.dataset.annQuote || '';
  const type = markEl.dataset.annType || 'note';
  const id = markEl.dataset.annId || '';
  const existing = markEl.dataset.annNote || '';
  if (!entryId || !quote) {
    window.showToast?.('找不到这段批注');
    return;
  }
  openSharedMemoNoteSheet({
    entryId,
    id,
    type,
    quote,
    existingNote: existing,
    color: (markEl.style.getPropertyValue('--sm-mark-color') || '').trim(),
  });
}

window.confirmSharedMemoMark = async function() {
  if (!_sharedBook || !_smMarkSel?.entryId || !_smMarkSel?.pendingType) return;
  syncQuoteFromSharedMemoTokens();
  let quote = String(_smMarkSel.quote || '').trim();
  if (!quote) {
    window.showToast?.('先点选要批的字');
    return;
  }
  if (quote.length > 40) {
    window.showToast?.('选太长了，少点几个字');
    return;
  }
  const type = _smMarkSel.pendingType;
  const entryId = _smMarkSel.entryId;
  const paper = getActivePaperSettings();
  const color = markColorForType(type, paper);
  const openNoteAfter = type === 'note';
  try {
    const res = await api.patchSharedMemoEntry(_sharedBook.id, entryId, {
      annotation: { type, quote, note: '', color, by: 'user' },
    });
    window.showToast?.(openNoteAfter ? '已标记，接着写旁注' : '已批注');
    hideSharedMemoMarkToolbar();
    if (res?.entry) await refreshSharedMemoAfterWrite({ entry: res.entry });
    else await refreshSharedMemoAfterWrite();
    const dateKey = _smReadingDateKey || sharedMemoLocalToday();
    await openSharedMemoDay(dateKey);
    if (openNoteAfter) {
      setTimeout(() => {
        const marks = document.querySelectorAll(`.shared-memo-entry-block[data-entry-id="${entryId}"] .sm-mark`);
        let target = null;
        for (const m of marks) {
          if (m.dataset.annQuote === quote && m.dataset.annType === type) {
            target = m;
            break;
          }
        }
        if (target) openSharedMemoNoteEditor(target);
        else {
          openSharedMemoNoteSheet({
            entryId, id: '', type, quote, existingNote: '', color,
          });
        }
      }, 50);
    }
  } catch (e) {
    window.showToast?.(e.message || '批注失败');
  }
};

/** @deprecated 兼容旧调用 */
window.applySharedMemoMark = function(type) {
  pickSharedMemoMarkTool(type);
};

window.deleteSharedMemoEntry = async function(entryId) {
  if (!_sharedBook) return;
  if (!confirm('确定删除这条？')) return;
  try {
    await api.deleteSharedMemoEntry(_sharedBook.id, entryId);
    document.getElementById('diary-view-overlay')?.classList.remove('active');
    window.showToast?.('已删除');
    const today = sharedMemoLocalToday();
    _smCachedEntries = (_smCachedEntries || []).filter((e) => Number(e.id) !== Number(entryId));
    const cache = readSmPastCache(_sharedBook.id);
    if (cache?.past) {
      writeSmPastCache(_sharedBook.id, {
        past: cache.past.filter((e) => Number(e.id) !== Number(entryId)),
        todayAtSync: cache.todayAtSync || today,
      });
    }
    rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
    if (_shelfCache) _shelfCache.at = 0;
    await renderSharedMemoView();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

window.deleteSharedMemoDay = async function(dateKey) {
  if (!_sharedBook || !dateKey) return;
  const label = dateKey.length >= 10 ? dateKey.slice(5) : dateKey;
  if (!confirm(`删除 ${label}（${dateKey}）这一天的全部随手记？`)) return;
  try {
    await api.deleteSharedMemoDay(_sharedBook.id, dateKey);
    document.getElementById('diary-view-overlay')?.classList.remove('active');
    window.showToast?.('已删除本日');
    const today = sharedMemoLocalToday();
    _smCachedEntries = (_smCachedEntries || []).filter((e) => sharedMemoEntryDate(e) !== dateKey);
    const cache = readSmPastCache(_sharedBook.id);
    if (cache?.past) {
      writeSmPastCache(_sharedBook.id, {
        past: cache.past.filter((e) => sharedMemoEntryDate(e) !== dateKey),
        todayAtSync: cache.todayAtSync || today,
      });
    }
    rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
    if (_shelfCache) _shelfCache.at = 0;
    await renderSharedMemoView();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

window.confirmDeleteSharedMemoBook = async function(bookId) {
  const id = bookId || _sharedBook?.id;
  if (!id) return;
  let name = _sharedBook?.char_name || _sharedBook?.title || '这本随手记';
  if (!bookId || !_sharedBook) {
    try {
      const books = await api.getSharedMemos();
      const b = books.find(x => Number(x.id) === Number(id));
      if (b) name = b.char_name || b.title || name;
    } catch {}
  }
  if (!confirm(`删除和「${name}」的整本随手记？\n里面的所有记录都会清空，且之后可重新添加。`)) return;
  try {
    await api.deleteSharedMemo(id);
    clearSmPastCache(id);
    if (_sharedBook && Number(_sharedBook.id) === Number(id)) {
      _sharedBook = null;
      _smCachedEntries = [];
      document.getElementById('diary-view-overlay')?.classList.remove('active');
    }
    window.showToast?.('已删除');
    await showShelf();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

function setSharedMemoEditMode(on) {
  _smWriting = !!on;
  const dateEl = document.getElementById('diary-date-input');
  const titleEl = document.getElementById('diary-title-input');
  const visWrap = document.getElementById('diary-visible-wrap');
  const media = document.getElementById('shared-memo-edit-media');
  if (dateEl) dateEl.style.display = on ? 'none' : '';
  if (titleEl) titleEl.style.display = on ? 'none' : '';
  if (visWrap) visWrap.style.display = on ? 'none' : '';
  if (media) media.style.display = on ? '' : 'none';
  const ta = document.getElementById('diary-content-input');
  if (ta && !on) ta.placeholder = '记录今天…';
}

window.openSharedMemoWrite = function() {
  if (!_sharedBook) return;
  const overlay = document.getElementById('diary-view-overlay');
  const page = _readingPages[_readingIdx];
  if (overlay?.classList.contains('active') && page?.sharedMemo && page.dateKey === sharedMemoLocalToday()) {
    expandSharedMemoComposer();
    return;
  }
  openSharedMemoDay(sharedMemoLocalToday()).then(() => {
    setTimeout(() => expandSharedMemoComposer(), 100);
  });
};

function renderSharedMemoDraftHtml() {
  // 表情已写入正文标记；草稿区只预览图片
  const bits = [];
  (_smDraft.images || []).forEach((url, i) => {
    bits.push(`<span class="shared-memo-chip"><img src="${url}" alt=""><button type="button" onclick="removeSharedMemoDraftImage(${i})">×</button></span>`);
  });
  return bits.join('') || '';
}

function refreshSharedMemoDraft() {
  const html = renderSharedMemoDraftHtml();
  const el = document.getElementById('shared-memo-draft');
  if (el) el.innerHTML = html;
  const inline = document.getElementById('sm-inline-draft');
  if (inline) inline.innerHTML = html;
}

window.removeSharedMemoDraftImage = function(i) {
  _smDraft.images.splice(i, 1);
  refreshSharedMemoDraft();
};
window.removeSharedMemoDraftEmoji = function(i) {
  _smDraft.emojis.splice(i, 1);
  refreshSharedMemoDraft();
};

function insertSharedMemoEmojiAtCursor(url, desc) {
  const ta = document.getElementById('sm-inline-input')
    || document.getElementById('diary-content-input');
  if (!ta) return;
  const marker = `[em|${url}|${String(desc || '').replace(/[\[\]|]/g, '')}]`;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  ta.value = before + marker + after;
  const pos = start + marker.length;
  ta.focus();
  try { ta.setSelectionRange(pos, pos); } catch {}
}

window.onSharedMemoImagePicked = async function(input) {
  const file = input.files?.[0];
  if (!file) return;
  // 立刻清空，避免取消/卡住后再选同一张没反应
  input.value = '';
  try {
    const result = await pickCropAndUpload(file, { title: '插入图片', aspect: null });
    if (!result?.url) return;
    _smDraft.images.push(result.url);
    refreshSharedMemoDraft();
  } catch (e) {
    window.showToast?.(e.message || '上传失败');
  }
};

window.openSharedMemoEmojiPick = async function() {
  // 页内接着写优先 sm-inline-input；全屏编辑才用 diary-content-input
  const input = document.getElementById('sm-inline-input')
    || document.getElementById('diary-content-input')
    || document.getElementById('memo-content-input')
    || document.getElementById('secret-note-content');
  await openSystemEmojiOverlay({
    targetInput: input,
    includeStickers: true,
    onPickBean: (code) => {
      if (input) insertInlineEmojiAtCursor(input, code);
    },
    stickerPick: (url, desc) => {
      insertSharedMemoEmojiAtCursor(url, desc || '');
    },
  });
};

window.selectSharedMemoEmojiCat = function(idx) {
  const cats = window._smEmojiCats || [];
  const cat = cats[idx];
  document.querySelectorAll('#shared-memo-emoji-cats .tag').forEach((t, i) => t.classList.toggle('active', i === idx));
  const grid = document.getElementById('shared-memo-emoji-grid');
  const emojis = cat?.emojis || [];
  if (!emojis.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;color:var(--text-secondary);font-size:13px">这个分类还没有表情</div>';
    return;
  }
  grid.innerHTML = emojis.map(em => {
    const url = em.url || `/uploads/${em.filename}`;
    const desc = escapeHtml(em.description || '');
    return `<button type="button" class="shared-memo-emoji-pick-btn" title="${desc}"
      data-url="${escapeHtml(url)}" data-desc="${desc}"
      onclick="pickSharedMemoEmoji(this)">
      <img src="${url}" alt="${desc}">
    </button>`;
  }).join('');
};

window.pickSharedMemoEmoji = function(btn) {
  const url = btn?.dataset?.url;
  if (!url) return;
  // 插到光标处，跟文字同一行；要另起一行先回车
  insertSharedMemoEmojiAtCursor(url, btn.dataset.desc || '');
  closeSharedMemoEmojiPick();
};

window.closeSharedMemoEmojiPick = function() {
  const el = document.getElementById('shared-memo-emoji-pick');
  el.classList.remove('active');
  el.style.display = 'none';
};

async function saveSharedMemoFromEdit() {
  if (!_sharedBook || window._smInlineSaving) return;
  const text = document.getElementById('diary-content-input')?.value || '';
  // 正文里的 [em|…] 标记解析成 emojis 数组，同时保留标记方便原位显示
  const emojis = [];
  const re = /\[em\|([^\]|]+)\|([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text))) {
    emojis.push({ url: m[1], description: m[2] || '' });
  }
  if (!text.trim() && !_smDraft.images.length && !emojis.length) {
    window.showToast?.('写点内容、图片或表情吧');
    return;
  }
  const images = [..._smDraft.images];
  const today = sharedMemoLocalToday();
  const nowIso = new Date().toISOString();
  const tempId = -Date.now();
  const payload = { content: text, images, emojis };
  const optimistic = {
    id: tempId,
    book_id: _sharedBook.id,
    role: 'user',
    content: text,
    images,
    emojis,
    annotations: [],
    visible_at: nowIso,
    created_at: nowIso,
    status: 'visible',
  };
  window._smInlineSaving = true;
  try {
    _smDraft = { images: [], emojis: [] };
    document.getElementById('diary-edit-overlay').classList.remove('active');
    setSharedMemoEditMode(false);
    _smCachedEntries = upsertSmEntryInList(_smCachedEntries, optimistic);
    rememberSmSession(_sharedBook.id, { book: _sharedBook, entries: _smCachedEntries });
    paintSharedMemoList(_smCachedEntries);
    await presentSharedMemoDay(today, groupSharedMemoByDate(_smCachedEntries)[today] || []);

    const res = await api.createSharedMemoEntry(_sharedBook.id, payload);
    _smCachedEntries = (_smCachedEntries || []).filter((e) => Number(e.id) !== tempId);
    if (res?.entry) await refreshSharedMemoAfterWrite({ entry: res.entry });
    else await refreshSharedMemoAfterWrite();
    if (_view === 'shared') {
      paintSharedMemoList(_smCachedEntries);
      await presentSharedMemoDay(today, groupSharedMemoByDate(_smCachedEntries)[today] || []);
    }
    window.showToast?.('已写入今天这一页，可继续写；TA 随后会回你');
  } catch (e) {
    _smCachedEntries = (_smCachedEntries || []).filter((e0) => Number(e0.id) !== tempId);
    window.showToast?.(e.message || '保存失败');
  } finally {
    window._smInlineSaving = false;
  }
}

window.onSharedMemoUpdated = function(data) {
  const bid = Number(data?.bookId);
  if (bid) {
    // 推送到达：会话仍可用，但书架计数可能变了
    if (_shelfCache) _shelfCache.at = 0;
  }
  if (_view === 'shared' && _sharedBook && bid === Number(_sharedBook.id)) {
    refreshSharedMemoAfterWrite().then(async () => {
      const overlay = document.getElementById('diary-view-overlay');
      const today = sharedMemoLocalToday();
      const entryDay = (_smCachedEntries || []).find((e) => Number(e.id) === Number(data?.entryId));
      const entryDate = entryDay ? sharedMemoEntryDate(entryDay) : '';
      if (overlay?.classList.contains('active') && _smReadingDateKey) {
        const jumpToday = entryDate === today && _smReadingDateKey !== today;
        await openSharedMemoDay(jumpToday ? today : _smReadingDateKey);
      } else {
        paintSharedMemoList(_smCachedEntries);
      }
    }).catch(() => renderSharedMemoView());
  } else if (_view === 'shelf') {
    showShelf();
  }
};

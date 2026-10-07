/* ===== 一起阅读页 ===== */
import * as api from '../api.js';
import { escapeHtml, splitAiSegments } from '../memory.js';

// ─── 常量 ───
const STORAGE_KEY = 'reader_books_v1';
const CHUNK_TARGET = 520;   // 目标每段字数
const HISTORY_KEEP = 16;    // 保留最近几条对话做上下文

// ─── 状态 ───
let _charId   = null;
let _charName = '';
let _charAvatar = '';
let _book     = null;   // 当前打开的书
let _typing   = false;

// ─── 数据层 ───
function allBooks() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveAllBooks(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
}
function charBooks() {
  return allBooks().filter(b => String(b.charId) === String(_charId));
}
function upsertBook(book) {
  const list = allBooks();
  const idx  = list.findIndex(b => b.id === book.id);
  if (idx >= 0) list[idx] = book;
  else list.unshift(book);
  saveAllBooks(list);
}
function deleteBook(bookId) {
  saveAllBooks(allBooks().filter(b => b.id !== bookId));
}

// ─── 文本切块 ───
function chunkText(raw) {
  // 先按空行分段落
  const paras = raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';

  for (const para of paras) {
    // 单段太长则按句子切
    if (para.length > CHUNK_TARGET * 1.6) {
      const sentences = para.split(/(?<=[。！？…～~]+)/).map(s => s.trim()).filter(Boolean);
      for (const s of sentences) {
        if ((cur + s).length > CHUNK_TARGET && cur) {
          chunks.push(cur.trim());
          cur = s;
        } else {
          cur += (cur ? '' : '') + s;
        }
      }
    } else {
      if ((cur + '\n\n' + para).length > CHUNK_TARGET && cur) {
        chunks.push(cur.trim());
        cur = para;
      } else {
        cur = cur ? cur + '\n\n' + para : para;
      }
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [raw.trim()];
}

// ─── 页面入口 ───
window.initReaderPage = function() {
  _charId   = window.getActiveCharId?.();
  const chars = window.getAppCharacters?.() || [];
  const char = chars.find(c => c.id == _charId) || chars[0];
  if (char) { _charId = char.id; _charName = char.name; _charAvatar = char.avatar || ''; }

  // 如果正在读某本书，恢复阅读视图
  if (_book && String(_book.charId) === String(_charId)) {
    renderReadingView();
    return;
  }
  _book = null;
  renderLibrary();
};

// ═══════════════════════════════════════
// 书库视图
// ═══════════════════════════════════════
function renderLibrary() {
  const page = document.getElementById('reader-page');
  const books = charBooks();
  const chars = window.getAppCharacters?.() || [];

  page.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%">
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
        <div class="topbar-title" style="font-family:'Noto Serif SC',serif">📖 一起阅读</div>
        <div id="reader-char-pick"
          onclick="openReaderCharPicker()"
          style="font-size:12px;color:var(--theme);padding:4px 8px;cursor:pointer;
            max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${escapeHtml(_charName || '选角色')}
        </div>
      </div>

      <div class="scroll-area" style="flex:1;padding:16px 14px">
        <div style="font-size:12px;color:var(--text-secondary);padding:0 2px 12px;letter-spacing:1px">
          与 <strong style="color:var(--theme)">${escapeHtml(_charName || '角色')}</strong> 共读
        </div>

        <!-- 添加书籍卡片 -->
        <div onclick="openAddBook()" style="cursor:pointer;border-radius:14px;padding:18px 16px;margin-bottom:14px;
          border:1.5px dashed var(--border);display:flex;align-items:center;gap:12px;
          background:var(--bg-glass);transition:border-color .2s"
          onmouseenter="this.style.borderColor='var(--theme)'" onmouseleave="this.style.borderColor='var(--border)'">
          <div style="font-size:32px">＋</div>
          <div>
            <div style="font-size:14px;font-weight:600;color:var(--text-primary)">添加书籍</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">粘贴文本或上传 .txt 文件</div>
          </div>
        </div>

        ${books.length ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            ${books.map(bookCardHtml).join('')}
          </div>
        ` : `
          <div style="text-align:center;padding:48px 24px;color:var(--text-secondary)">
            <div style="font-size:44px;margin-bottom:12px">📚</div>
            <div style="font-size:14px">${_charName ? `还没有和${escapeHtml(_charName)}共读的书，来添加第一本吧` : '请先选择一个角色开始共读'}</div>
          </div>
        `}
      </div>
    </div>

    <!-- 角色选择器 -->
    <div id="reader-char-overlay" class="overlay" onclick="this.classList.remove('active')">
      <div class="sheet" onclick="event.stopPropagation()">
        <div class="sheet-handle"></div>
        <div class="sheet-title">选择共读角色</div>
        <div style="padding:8px 16px 16px">
          ${chars.length ? chars.map(c => `
            <div class="settings-row" onclick="selectReaderChar(${c.id},'${escapeHtml(c.name)}','${escapeHtml(c.avatar||'')}')"
              style="cursor:pointer">
              ${c.avatar
                ? `<img src="${escapeHtml(c.avatar)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover">`
                : `<div style="width:36px;height:36px;border-radius:50%;background:var(--theme-light);display:flex;align-items:center;justify-content:center;font-size:16px">${escapeHtml(c.name.slice(0,1))}</div>`}
              <div style="flex:1"><div style="font-size:14px">${escapeHtml(c.name)}</div></div>
              ${String(_charId) === String(c.id) ? '<div style="color:var(--theme)">✓</div>' : ''}
            </div>`).join('')
          : '<div style="color:var(--text-secondary);font-size:14px;padding:12px 0">还没有角色，请先创建</div>'}
        </div>
      </div>
    </div>

    <!-- 添加书籍弹窗 -->
    <div id="reader-add-overlay" class="overlay center" onclick="if(event.target===this)closeAddBook()">
      <div class="modal" style="width:calc(100% - 32px);max-width:440px" onclick="event.stopPropagation()">
        <div class="modal-title">添加书籍</div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
          <div class="form-group">
            <label class="input-label">书名</label>
            <input class="input" id="reader-title-input" placeholder="请输入书名或标题…" style="margin-top:4px">
          </div>
          <div class="form-group">
            <label class="input-label">正文内容</label>
            <textarea class="input" id="reader-text-input" style="min-height:120px;margin-top:4px;font-size:13px;line-height:1.7"
              placeholder="在此粘贴小说或文章正文…"></textarea>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('reader-file-input').click()">📂 从文件导入</button>
            <input type="file" id="reader-file-input" accept=".txt" style="display:none" onchange="handleReaderFile(event)">
            <span id="reader-file-name" style="font-size:12px;color:var(--text-secondary)"></span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost btn-sm" onclick="closeAddBook()">取消</button>
          <button class="btn btn-primary btn-sm" onclick="confirmAddBook()">开始共读</button>
        </div>
      </div>
    </div>
  `;
}

function bookCardHtml(book) {
  const pct = book.chunks.length > 1 ? Math.round(book.progress / (book.chunks.length - 1) * 100) : 100;
  const done = book.progress >= book.chunks.length - 1;
  return `
    <div style="cursor:pointer;border-radius:14px;padding:14px 12px;
      background:var(--bg-glass);border:1px solid var(--border);
      display:flex;flex-direction:column;gap:6px;position:relative;overflow:hidden"
      onclick="openBook('${book.id}')">
      <div style="position:absolute;top:0;left:0;height:3px;width:${pct}%;background:var(--theme);border-radius:3px 0 0 0;transition:width .3s"></div>
      <div style="font-size:22px;margin-bottom:2px">📖</div>
      <div style="font-size:13px;font-weight:600;color:var(--text-primary);line-height:1.4;word-break:break-all;
        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
        ${escapeHtml(book.title)}
      </div>
      <div style="font-size:11px;color:var(--text-secondary)">
        ${done ? '✓ 已读完' : `第 ${book.progress + 1} / ${book.chunks.length} 段`}
      </div>
      <div onclick="event.stopPropagation();deleteBookConfirm('${book.id}')"
        style="position:absolute;top:8px;right:8px;color:var(--text-secondary);font-size:16px;padding:2px 4px;cursor:pointer">×</div>
    </div>`;
}

window.openReaderCharPicker = function() {
  document.getElementById('reader-char-overlay')?.classList.add('active');
};

window.selectReaderChar = function(id, name, avatar) {
  _charId   = id;
  _charName = name;
  _charAvatar = avatar;
  // 切换角色时清除当前书（书是按角色隔离的）
  _book = null;
  document.getElementById('reader-char-overlay')?.classList.remove('active');
  renderLibrary();
};

window.openAddBook = function() {
  if (!_charId) { window.showToast?.('请先选择共读角色'); openReaderCharPicker(); return; }
  document.getElementById('reader-add-overlay').classList.add('active');
  setTimeout(() => document.getElementById('reader-title-input')?.focus(), 100);
};
window.closeAddBook = function() {
  document.getElementById('reader-add-overlay')?.classList.remove('active');
};

window.handleReaderFile = function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const text = ev.target.result || '';
    const ta = document.getElementById('reader-text-input');
    if (ta) ta.value = text;
    const titleIn = document.getElementById('reader-title-input');
    if (titleIn && !titleIn.value.trim()) {
      titleIn.value = file.name.replace(/\.txt$/i, '');
    }
    const fn = document.getElementById('reader-file-name');
    if (fn) fn.textContent = file.name;
  };
  reader.readAsText(file, 'utf-8');
  e.target.value = '';
};

window.confirmAddBook = function() {
  const title = document.getElementById('reader-title-input')?.value.trim();
  const rawText = document.getElementById('reader-text-input')?.value.trim();
  if (!title) { window.showToast?.('请输入书名'); return; }
  if (!rawText || rawText.length < 10) { window.showToast?.('请输入正文内容'); return; }

  const chunks = chunkText(rawText);
  const book = {
    id: Date.now().toString(),
    charId: _charId,
    title,
    chunks,
    progress: 0,
    history: [],
    addedAt: Date.now(),
  };
  upsertBook(book);
  closeAddBook();
  openBook(book.id);
};

window.deleteBookConfirm = function(bookId) {
  const book = allBooks().find(b => b.id === bookId);
  if (!book) return;
  if (!confirm(`确定删除《${book.title}》的阅读记录？`)) return;
  deleteBook(bookId);
  if (_book?.id === bookId) _book = null;
  renderLibrary();
};

window.openBook = function(bookId) {
  const book = allBooks().find(b => b.id === bookId);
  if (!book) return;
  _book = JSON.parse(JSON.stringify(book)); // deep copy
  renderReadingView();
  // 首次进入当前段（没有对话记录时）自动触发角色反应
  const historyForChunk = (_book.history || []).filter(h => h.chunkIdx === _book.progress);
  if (!historyForChunk.length) {
    setTimeout(() => aiReactToPage(), 400);
  }
};

// ═══════════════════════════════════════
// 阅读视图
// ═══════════════════════════════════════
function renderReadingView() {
  if (!_book) { renderLibrary(); return; }
  const page = document.getElementById('reader-page');
  const { title, chunks, progress } = _book;
  const chunk = chunks[progress] || '';
  const total = chunks.length;
  const isLast = progress >= total - 1;

  page.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%">
      <!-- 顶栏 -->
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="leaveReading()" title="返回"></button>
        <div style="flex:1;min-width:0;text-align:center">
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px">
            ${escapeHtml(title)}
          </div>
          <div style="font-size:11px;color:var(--text-secondary)">第 ${progress + 1} / ${total} 段</div>
        </div>
        <div style="width:40px"></div>
      </div>

      <!-- 主体：上文本 + 下聊天 -->
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">

        <!-- 文本区 -->
        <div class="scroll-area" id="reader-text-area" style="
          flex:0 0 auto;max-height:42vh;
          padding:16px 18px 12px;
          font-family:'Noto Serif SC',Georgia,serif;
          font-size:15px;line-height:2;
          color:var(--text-primary);
          border-bottom:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-secondary);letter-spacing:3px;margin-bottom:10px;text-align:center">
            ─ 第 ${progress + 1} 段 ─
          </div>
          ${chunk.split('\n').map(l => l.trim() ? `<p style="text-indent:2em;margin:0 0 .4em">${escapeHtml(l)}</p>` : '<br>').join('')}
        </div>

        <!-- 角色 + 聊天区 -->
        <div class="scroll-area" id="reader-chat-area" style="flex:1;padding:10px 14px 4px">
          ${buildChatHistory()}
          <div id="reader-typing" style="display:none;padding:6px 0">
            ${charBubble(`<span style="display:flex;gap:4px;align-items:center">
              <span style="width:5px;height:5px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .0s both;display:inline-block"></span>
              <span style="width:5px;height:5px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .4s both;display:inline-block"></span>
              <span style="width:5px;height:5px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .8s both;display:inline-block"></span>
            </span>`, true)}
          </div>
        </div>
      </div>

      <!-- 输入栏 -->
      <div style="padding:8px 12px;padding-bottom:max(8px,var(--sab));
        background:var(--bg-glass);backdrop-filter:blur(20px);border-top:1px solid var(--border);flex-shrink:0">
        <div style="display:flex;gap:8px;align-items:center">
          <textarea id="reader-input" class="chat-input" placeholder="和${escapeHtml(_charName)}聊聊这段…" rows="1"
            style="flex:1" oninput="autoResize(this)" onkeydown="handleReaderKey(event)"></textarea>
          <div class="chat-send-btn" onclick="sendReaderMessage()" title="发送">↑</div>
          <div class="chat-send-btn" onclick="readerNextPage()" title="${isLast ? '已是最后一段' : '下一段'}"
            style="background:${isLast ? 'var(--bg-glass)' : 'var(--theme)'};color:${isLast ? 'var(--text-secondary)' : '#fff'}">
            ${isLast ? '末' : '›'}
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);text-align:center;padding:3px 0 0">
          ${isLast ? '已到最后一段' : `还剩 ${total - progress - 1} 段`}
        </div>
      </div>
    </div>
  `;
  scrollChatToBottom();
}

function charBubble(contentHtml, raw = false) {
  const avatar = _charAvatar
    ? `<img src="${escapeHtml(_charAvatar)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0">`
    : `<div style="width:28px;height:28px;border-radius:50%;background:var(--theme-light);display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0">${escapeHtml((_charName||'?').slice(0,1))}</div>`;
  const inner = raw ? contentHtml : escapeHtml(contentHtml);
  return `<div style="display:flex;gap:8px;align-items:flex-end;margin:6px 0">
    ${avatar}
    <div style="max-width:78%;background:var(--bg-glass);border:1px solid var(--border);
      border-radius:16px 16px 16px 4px;padding:9px 13px;font-size:14px;line-height:1.65;
      color:var(--text-primary)">${inner}</div>
  </div>`;
}

function userBubble(text) {
  return `<div style="display:flex;justify-content:flex-end;margin:6px 0">
    <div style="max-width:75%;background:var(--theme);color:#fff;
      border-radius:16px 16px 4px 16px;padding:9px 13px;font-size:14px;line-height:1.65">
      ${escapeHtml(text)}
    </div>
  </div>`;
}

function buildChatHistory() {
  if (!_book) return '';
  return (_book.history || []).map(m => m.role === 'user' ? userBubble(m.content) : charBubble(m.content)).join('');
}

function updateReaderTextPanel() {
  if (!_book) return;
  const { title, chunks, progress } = _book;
  const chunk = chunks[progress] || '';
  const total = chunks.length;
  const isLast = progress >= total - 1;

  const titleEl = document.querySelector('#reader-page .topbar-title div:first-child');
  const subEl = document.querySelector('#reader-page .topbar-title div:last-child');
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = `第 ${progress + 1} / ${total} 段`;

  const textArea = document.getElementById('reader-text-area');
  if (textArea) {
    textArea.innerHTML = `
      <div style="font-size:11px;color:var(--text-secondary);letter-spacing:3px;margin-bottom:10px;text-align:center">
        ─ 第 ${progress + 1} 段 ─
      </div>
      ${chunk.split('\n').map(l => l.trim() ? `<p style="text-indent:2em;margin:0 0 .4em">${escapeHtml(l)}</p>` : '<br>').join('')}
    `;
  }

  const nextBtn = document.querySelector('#reader-page .chat-send-btn[title*="段"]');
  if (nextBtn) {
    nextBtn.title = isLast ? '已是最后一段' : '下一段';
    nextBtn.style.background = isLast ? 'var(--bg-glass)' : 'var(--theme)';
    nextBtn.style.color = isLast ? 'var(--text-secondary)' : '#fff';
    nextBtn.textContent = isLast ? '末' : '›';
  }

  const hint = document.querySelector('#reader-page .chat-input-area div:last-child');
  if (hint) {
    hint.textContent = isLast ? '已到最后一段' : `还剩 ${total - progress - 1} 段`;
  }
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    const el = document.getElementById('reader-chat-area');
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function appendChatBubble(role, text) {
  const area = document.getElementById('reader-chat-area');
  if (!area) return;
  const typing = document.getElementById('reader-typing');
  const html = role === 'user' ? userBubble(text) : charBubble(text);
  if (typing) typing.insertAdjacentHTML('beforebegin', html);
  else area.insertAdjacentHTML('beforeend', html);
  scrollChatToBottom();
}

function setTyping(on) {
  const el = document.getElementById('reader-typing');
  if (el) el.style.display = on ? '' : 'none';
  scrollChatToBottom();
}

// ─── AI 反应 ───
async function aiReactToPage(userMessage = '') {
  if (_typing || !_book) return;
  _typing = true;
  setTyping(true);

  const { title, chunks, progress, history } = _book;
  const pageText = chunks[progress] || '';

  // Build context for API
  const contextMsg = userMessage
    ? `【正在读《${title}》第${progress + 1}段】\n${pageText}\n\n【我说】${userMessage}`
    : `【正在读《${title}》第${progress + 1}段，刚翻到这里】\n${pageText}`;

  // Recent history (last HISTORY_KEEP messages across all chunks) as conversation history
  const apiHistory = (history || []).slice(-HISTORY_KEEP).map(h => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: h.content,
  }));

  try {
    const r = await api.playGame({
      gameType: 'reader',
      charId: _charId,
      userInput: contextMsg,
      history: apiHistory,
    });
    setTyping(false);
    if (r.reply) {
      const segments = splitAiSegments(r.reply);
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) {
          setTyping(true);
          await new Promise(res => setTimeout(res, Math.min(Math.max(segments[i].length * 45, 600), 2000)));
          setTyping(false);
        }
        appendChatBubble('ai', segments[i]);
      }
      _book.history = _book.history || [];
      _book.history.push({ role: 'ai', content: r.reply, chunkIdx: progress });
      upsertBook(_book);
    }
  } catch(e) {
    setTyping(false);
    appendChatBubble('ai', `（${e.message || '出了点问题，稍后再试'}）`);
  }
  _typing = false;
}

// ─── 用户消息 ───
window.sendReaderMessage = async function() {
  const input = document.getElementById('reader-input');
  const text = input?.value.trim();
  if (!text || _typing) return;
  input.value = '';
  input.style.height = '';

  appendChatBubble('user', text);
  _book.history = _book.history || [];
  _book.history.push({ role: 'user', content: text, chunkIdx: _book.progress });
  upsertBook(_book);

  await aiReactToPage(text);
};

window.handleReaderKey = function(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    window.sendReaderMessage();
  }
};

// ─── 翻页 ───
window.readerNextPage = async function() {
  if (!_book || _typing) return;
  if (_book.progress >= _book.chunks.length - 1) {
    window.showToast?.('已经是最后一段了');
    return;
  }
  _book.progress += 1;
  upsertBook(_book);
  updateReaderTextPanel();
  // 自动触发角色对新段落的反应（不重建聊天区）
  setTimeout(() => aiReactToPage(), 300);
};

window.leaveReading = function() {
  // 保留 _book 状态，下次进来恢复
  window.goBack();
};


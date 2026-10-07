/* ===== 游戏大厅 ===== */
import * as api from '../api.js';
import { escapeHtml, splitAiSegments } from '../memory.js';
import { initSyncAnswer, bindSyncAnswerGlobals } from '../games/sync-answer.js';
import { initTruthGame, bindTruthGlobals } from '../games/truth.js';
import { initGomoku, getGomokuSaveState, restoreGomokuState, destroyGomoku } from '../games/gomoku.js';

// ────────────────────────────────────
// 游戏目录
// ────────────────────────────────────
const GAMES = [
  { id:'truth_dare', name:'真心话', desc:'掷骰抽题，系统出题，通过/不通过', emoji:'💬', color:'#f5a6c9', tip:'掷骰子抽题，回答后由对方判定通过与否' },
  { id:'gomoku',     name:'五子棋',       desc:'15×15 标准无禁手，交叉点落子，对战或双人', emoji:'⚫', color:'#c4a574', tip:'点交叉点落子，连成五子即胜' },
  { id:'ludo',       name:'飞行棋',       desc:'掷骰前进，落特殊格触发小游戏', emoji:'🎯', color:'#ffd166', tip:'点骰子开始，祝你好运！' },
  { id:'pictionary', name:'你画我猜',     desc:'上传画作AI识图猜，或AI逐笔描述你猜', emoji:'🎨', color:'#a6f5c9', tip:'选择你要做画者还是猜测者' },
  { id:'sync_answer', name:'默契翻牌',    desc:'懂你、懂TA、猜彼此；同时写答案再一起翻开', emoji:'🎭', color:'#d4a6f5', tip:'同时写答案，再一起翻开看默契' },
  { id:'twenty_q',   name:'二十问猜谜',   desc:'TA心里想一样东西，用20问猜出', emoji:'🔍', color:'#a6c9f5', tip:'说"开始"，然后用是非题猜' },
  { id:'story',      name:'故事接龙',     desc:'轮流各写几句，共同创作故事', emoji:'📖', color:'#c9a6f5', tip:'说"开始"，TA先写开头' },
  { id:'rpg',        name:'文字RPG',      desc:'TA主持剧情，你做选择', emoji:'⚔️', color:'#f5c9a6', tip:'说"开始"，TA描述场景并给选项' },
  { id:'quiz',       name:'谁更了解谁',   desc:'TA出题考你，测了解程度', emoji:'💡', color:'#e6f5a6', tip:'说"开始"，TA出第一题' },
];

// ────────────────────────────────────
// 共同清单 — 见面后想一起做的事，不是待办打勾
// ────────────────────────────────────
const LIST_CATS = [
  { id: 'all',    label: '全部',       emoji: '📋', tint: '#c9a0dc' },
  { id: 'place',  label: '想去的地方', emoji: '🗺️', tint: '#74b9ff' },
  { id: 'movie',  label: '想看的电影', emoji: '🎬', tint: '#a29bfe' },
  { id: 'book',   label: '想看的书',   emoji: '📚', tint: '#fdcb6e' },
  { id: 'food',   label: '想吃的',     emoji: '🍜', tint: '#ff7675' },
  { id: 'todo',   label: '想做的事',   emoji: '✨', tint: '#55efc4' },
  { id: 'music',  label: '想听的音乐', emoji: '🎵', tint: '#fd79a8' },
];

let _listItems   = [];
let _listCat     = 'all';
let _listBusy    = false;
let _listDrawId  = null;
let _listExpanded = new Set();
let _listLoadedFor = null;
let _listSaveTimer = null;

function listKey() { return `shared_list_${_charId}`; }

function normalizeListItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text || '').trim();
  if (!text) return null;
  return {
    id: String(raw.id || Date.now()),
    text: text.slice(0, 40),
    note: String(raw.note || '').trim().slice(0, 120),
    cat: LIST_CATS.some(c => c.id === raw.cat && c.id !== 'all') ? raw.cat : 'todo',
    done: !!raw.done,
    by: raw.by === 'ai' ? 'ai' : 'user',
    at: Number(raw.at) || Date.now(),
    doneAt: raw.doneAt || null,
    aiReact: String(raw.aiReact || '').trim().slice(0, 160),
  };
}

function readLocalListItems() {
  try {
    const raw = JSON.parse(localStorage.getItem(listKey()) || '[]');
    return (Array.isArray(raw) ? raw : []).map(normalizeListItem).filter(Boolean);
  } catch { return []; }
}

function loadListItems() {
  // 同步路径：优先用内存缓存；若尚未从服务端拉过则先读本地
  if (_listLoadedFor === _charId && Array.isArray(_listItems)) return;
  _listItems = readLocalListItems();
}

async function loadListItemsAsync() {
  if (!_charId) { _listItems = []; return; }
  try {
    const data = await api.getSharedList(_charId);
    const serverItems = (Array.isArray(data?.items) ? data.items : []).map(normalizeListItem).filter(Boolean);
    const localItems = readLocalListItems();
    // 服务端为空且本地有旧数据时，迁移上去
    if (!serverItems.length && localItems.length) {
      _listItems = localItems;
      await api.saveSharedList(_charId, _listItems);
    } else {
      _listItems = serverItems;
      try { localStorage.setItem(listKey(), JSON.stringify(_listItems)); } catch {}
    }
    _listLoadedFor = _charId;
  } catch {
    _listItems = readLocalListItems();
    _listLoadedFor = _charId;
  }
}

function saveListItems() {
  try { localStorage.setItem(listKey(), JSON.stringify(_listItems)); } catch {}
  if (!_charId) return;
  if (_listSaveTimer) clearTimeout(_listSaveTimer);
  _listSaveTimer = setTimeout(() => {
    api.saveSharedList(_charId, _listItems).catch(() => {});
  }, 200);
}

function listCatMeta(catId) {
  return LIST_CATS.find(c => c.id === catId) || LIST_CATS.find(c => c.id === 'todo');
}

window.openSharedList = async function() {
  if (!_charId) { window.showToast?.('请先选择角色'); return; }
  _listCat = 'all';
  _listDrawId = null;
  hideAllSessions();
  setGamesViewMode('session');
  document.getElementById('list-session').style.display = 'flex';
  const btn = document.getElementById('list-suggest-btn');
  if (btn) btn.textContent = `${_charName} 来推荐`;
  renderList();
  await loadListItemsAsync();
  renderList();
};

window.closeSharedList = function() {
  document.getElementById('list-session').style.display = 'none';
  _listDrawId = null;
  setGamesViewMode('lobby');
};

window.switchListCat = function(cat) {
  _listCat = cat;
  _listDrawId = null;
  renderList();
};

window.toggleListNoteField = function() {
  const row = document.getElementById('list-note-row');
  if (!row) return;
  const open = row.style.display === 'none';
  row.style.display = open ? '' : 'none';
  if (open) document.getElementById('list-note-input')?.focus();
};

window.toggleListCardExpand = function(id) {
  if (_listExpanded.has(id)) _listExpanded.delete(id);
  else _listExpanded.add(id);
  renderList();
};

function parseListSuggestLine(line) {
  const clean = String(line || '').replace(/^[-·•\d.、]+\s*/, '').trim();
  if (!clean) return null;
  const pipe = clean.indexOf('|');
  if (pipe >= 0) {
    const text = clean.slice(0, pipe).trim();
    const note = clean.slice(pipe + 1).trim();
    if (text.length >= 2) return { text: text.slice(0, 40), note: note.slice(0, 120) };
  }
  const paren = clean.match(/^(.+?)（([^）]{2,})）$/);
  if (paren) return { text: paren[1].trim().slice(0, 40), note: paren[2].trim().slice(0, 120) };
  if (clean.length >= 2 && clean.length <= 40) return { text: clean, note: '' };
  return null;
}

function renderList() {
  const el = document.getElementById('list-body');
  if (!el) return;

  LIST_CATS.forEach(c => {
    const tab = document.getElementById(`list-tab-${c.id}`);
    if (!tab) return;
    const active = c.id === _listCat;
    tab.style.color = active ? 'var(--theme)' : 'var(--text-secondary)';
    tab.style.borderBottomColor = active ? 'var(--theme)' : 'transparent';
    tab.style.fontWeight = active ? '600' : '400';
  });

  const visible = _listCat === 'all' ? _listItems : _listItems.filter(i => i.cat === _listCat);
  const undone = visible.filter(i => !i.done);
  const done = visible.filter(i => i.done);
  const undoneAll = _listItems.filter(i => !i.done);

  if (!visible.length) {
    el.innerHTML = `<div class="shared-list-empty">
      <div class="shared-list-empty-icon">📋</div>
      <div class="shared-list-empty-title">还没有想一起做的事</div>
      <div class="shared-list-empty-hint">见面后才做的那种——看展、旅行、一起看完某部电影…<br>不是线上陪聊日常</div>
    </div>`;
    return;
  }

  let html = '';
  if (undoneAll.length) {
    html += `<div class="shared-list-stats">还有 <b>${undoneAll.length}</b> 件想一起实现</div>`;
  }

  if (_listDrawId && visible.some(i => i.id === _listDrawId)) {
    const drawn = visible.find(i => i.id === _listDrawId);
    if (drawn) {
      const meta = listCatMeta(drawn.cat);
      html += `<div class="shared-list-draw-banner">
        <div class="shared-list-draw-label">🎲 今天就这个？</div>
        <div class="shared-list-draw-text">${escapeHtml(drawn.text)}</div>
        <div class="shared-list-draw-meta">${meta.emoji} ${meta.label}${drawn.note ? ' · ' + escapeHtml(drawn.note) : ''}</div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="_listDrawId=null;renderList()">收起</button>
      </div>`;
    }
  }

  function cardHtml(item) {
    const meta = listCatMeta(item.cat);
    const byAi = item.by === 'ai';
    const expanded = _listExpanded.has(item.id) || !!item.aiReact;
    const hasExtra = !!(item.note || item.aiReact);
    const isDrawn = item.id === _listDrawId;
    return `<div class="shared-list-card${item.done ? ' is-done' : ''}${isDrawn ? ' is-drawn' : ''}" style="--list-tint:${meta.tint}">
      <button type="button" class="shared-list-check" onclick="toggleListItem('${item.id}')" aria-label="${item.done ? '标记未完成' : '标记完成'}">
        ${item.done ? '✓' : ''}
      </button>
      <div class="shared-list-card-main">
        <div class="shared-list-card-head${hasExtra ? ' is-clickable' : ''}" ${hasExtra ? `onclick="toggleListCardExpand('${item.id}')"` : ''}>
          <div class="shared-list-card-title">${escapeHtml(item.text)}</div>
          <div class="shared-list-card-meta">
            ${meta.emoji} ${meta.label}
            ${byAi ? ` · ${escapeHtml(_charName)}推荐` : ''}
            ${item.done && item.doneAt ? ` · ${String(item.doneAt).slice(0, 10)}` : ''}
            ${hasExtra ? `<span class="shared-list-chevron${expanded ? ' open' : ''}">›</span>` : ''}
          </div>
        </div>
        ${expanded && item.note ? `<div class="shared-list-card-note">${escapeHtml(item.note)}</div>` : ''}
        ${expanded && item.aiReact ? `<div class="shared-list-card-react">${escapeHtml(_charName)}：${escapeHtml(item.aiReact)}</div>` : ''}
      </div>
      <button type="button" class="secret-todo-del" onclick="deleteListItem('${item.id}')" title="删除">×</button>
    </div>`;
  }

  html += `<div class="shared-list-section-label">想一起做的</div>`;
  html += undone.map(cardHtml).join('');
  if (done.length) {
    html += `<div class="shared-list-section-label shared-list-section-done">已经实现的 ${done.length} 件</div>`;
    html += done.map(cardHtml).join('');
  }
  el.innerHTML = html;
}

window.addListItem = function() {
  const input = document.getElementById('list-input');
  const noteInput = document.getElementById('list-note-input');
  const catSel = document.getElementById('list-cat-sel');
  const text = input?.value.trim();
  if (!text) { window.showToast?.('写一件见面后想一起做的事'); return; }
  const cat = catSel?.value || 'todo';
  const note = noteInput?.value?.trim() || '';
  loadListItems();
  _listItems.unshift(normalizeListItem({
    id: Date.now().toString(),
    text, note, cat, done: false, by: 'user', at: Date.now(),
  }));
  saveListItems();
  if (input) input.value = '';
  if (noteInput) noteInput.value = '';
  const noteRow = document.getElementById('list-note-row');
  if (noteRow) noteRow.style.display = 'none';
  _listDrawId = null;
  renderList();
  window.showToast?.('已加入清单');
};

window.toggleListItem = function(id) {
  loadListItems();
  const item = _listItems.find(i => i.id === id);
  if (!item) return;
  item.done = !item.done;
  if (item.done) {
    item.doneAt = new Date().toISOString().slice(0, 10);
    _listExpanded.add(id);
    if (!item.aiReact) aiReactListComplete(item);
  } else {
    item.doneAt = null;
    item.aiReact = '';
  }
  saveListItems();
  renderList();
  if (item.done) window.showToast?.('记下了 ✓');
};

window.deleteListItem = function(id) {
  if (!confirm('从清单里删掉这项？')) return;
  loadListItems();
  _listItems = _listItems.filter(i => i.id !== id);
  if (_listDrawId === id) _listDrawId = null;
  _listExpanded.delete(id);
  saveListItems();
  renderList();
};

window.drawRandomListItem = function() {
  loadListItems();
  const pool = _listItems.filter(i => !i.done && (_listCat === 'all' || i.cat === _listCat));
  if (!pool.length) {
    window.showToast?.(_listCat === 'all' ? '清单都实现啦' : '这个分类没有可抽的项');
    return;
  }
  const item = pool[Math.floor(Math.random() * pool.length)];
  _listDrawId = item.id;
  _listExpanded.add(item.id);
  renderList();
};

async function aiReactListComplete(item) {
  if (!_charId || !item?.done) return;
  const meta = listCatMeta(item.cat);
  try {
    const r = await api.playGame({
      gameType: 'list_react',
      charId: _charId,
      userInput: `分类：${meta.label}\n条目：${item.text}${item.note ? `\n备注：${item.note}` : ''}`,
      history: [],
    });
    const react = String(r?.reply || '').trim().slice(0, 160);
    if (!react) return;
    loadListItems();
    const row = _listItems.find(i => i.id === item.id);
    if (row && row.done) {
      row.aiReact = react;
      saveListItems();
      renderList();
    }
  } catch { /* 静默失败 */ }
}

window.aiSuggestListItems = async function() {
  if (_listBusy) return;
  if (!_charId) { window.showToast?.('请先选择角色'); return; }
  _listBusy = true;
  const btn = document.getElementById('list-suggest-btn');
  if (btn) { btn.textContent = '想象中…'; btn.disabled = true; }

  const curCat = _listCat === 'all' ? 'todo' : _listCat;
  const catMeta = listCatMeta(curCat);
  const existing = _listItems.filter(i => i.cat === curCat).map(i => i.text).join('、');

  try {
    const r = await api.playGame({
      gameType: 'list_suggest',
      charId: _charId,
      userInput: `清单分类：${catMeta.label}\n已有条目：${existing || '暂无'}\n请推荐 3-5 条新的条目。`,
      history: [],
    });
    const raw = r?.reply || '';
    const lines = raw.split('\n').map(parseListSuggestLine).filter(Boolean);
    if (!lines.length) { window.showToast?.('没有获取到推荐'); return; }
    loadListItems();
    const existingTexts = new Set(_listItems.map(i => i.text));
    let added = 0;
    for (const line of lines) {
      if (!existingTexts.has(line.text)) {
        _listItems.unshift(normalizeListItem({
          id: (Date.now() + added).toString(),
          text: line.text,
          note: line.note,
          cat: curCat,
          done: false,
          by: 'ai',
          at: Date.now(),
        }));
        existingTexts.add(line.text);
        added++;
      }
    }
    saveListItems();
    renderList();
    window.showToast?.(`${_charName} 推荐了 ${added} 条`);
  } catch (e) {
    window.showToast?.(e.message || '推荐失败');
  } finally {
    _listBusy = false;
    if (btn) { btn.textContent = `${_charName} 来推荐`; btn.disabled = false; }
  }
};

// ────────────────────────────────────
// 状态
// ────────────────────────────────────
let _currentGame = null;
let _gameHistory = [];
let _charId = null;
let _charName = '';
let _charAvatar = '';
let _isTyping = false;

function gamePlayCtx() {
  return {
    get charName() { return _charName; },
    get userName() { return (window.getAppSettings?.() || {}).username || '你'; },
    get charAvatar() { return _charAvatar; },
    get charId() { return _charId; },
    playGame: (data) => api.playGame(data),
  };
}

function gomokuPlayCtx() {
  return {
    get charName() { return _charName; },
    get userName() { return (window.getAppSettings?.() || {}).username || '你'; },
    get charId() { return _charId; },
    playGame: (data) => api.playGame(data),
    onMove: () => {
      if (_gomokuActive && !_gomokuResultSaved) saveGameProgress();
    },
    onResult: async (resultText) => {
      if (_gomokuResultSaved) return;
      _gomokuResultSaved = true;
      await saveGameResultMemory(`五子棋：${resultText}`);
      clearGameSave();
    },
  };
}

let _ludo = null;
let _gomokuActive = false;
let _gomokuResultSaved = false;

// 默契翻牌：近期题目去重
let _syncRecentQuestions = [];

// 你画我猜状态
let _picMode = null;
let _picHistory = [];
let _picCanvas = null;
let _picCtx = null;
let _picDrawing = false;
let _picLastX = 0;
let _picLastY = 0;

// 对话游戏 UI 日志（用于存档恢复）
let _sessionLog = [];
let _picSessionLog = [];
let _ludoResultSaved = false;

const GAME_SAVE_KEY = 'nian_game_progress';

function setGamesViewMode(mode) {
  const topbar = document.getElementById('games-lobby-topbar');
  const lobby = document.getElementById('games-lobby');
  if (topbar) topbar.style.display = mode === 'lobby' ? '' : 'none';
  if (lobby && mode === 'session') lobby.style.display = 'none';
  if (lobby && mode === 'lobby') lobby.style.display = '';
}

/** 自定义确认弹窗（替代 confirm，PWA 内更稳定） */
function showGameConfirm({ title, body, okText = '确定', cancelText = '取消', onOk, onCancel }) {
  let overlay = document.getElementById('game-confirm-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'game-confirm-overlay';
    overlay.className = 'overlay center';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('active'); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal" style="width:calc(100% - 32px);max-width:360px" onclick="event.stopPropagation()">
      <div class="modal-title">${escapeHtml(title || '提示')}</div>
      <div class="modal-body" style="font-size:14px;line-height:1.6;color:var(--text-secondary)">${escapeHtml(body || '')}</div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" id="game-confirm-cancel">${escapeHtml(cancelText)}</button>
        <button class="btn btn-primary btn-sm" id="game-confirm-ok">${escapeHtml(okText)}</button>
      </div>
    </div>`;
  overlay.classList.add('active');
  overlay.querySelector('#game-confirm-ok').onclick = () => {
    overlay.classList.remove('active');
    onOk?.();
  };
  overlay.querySelector('#game-confirm-cancel').onclick = () => {
    overlay.classList.remove('active');
    onCancel?.();
  };
}

function showGameConfirmAsync(opts) {
  return new Promise(resolve => {
    showGameConfirm({
      ...opts,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function getGameSave() {
  try {
    const raw = localStorage.getItem(GAME_SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveGameProgress() {
  if (!_charId) return;
  const gameId = _currentGame?.id || (_ludo ? 'ludo' : _picMode ? 'pictionary' : _gomokuActive ? 'gomoku' : null);
  if (!gameId) return;
  const gameName = _currentGame?.name || (gameId === 'ludo' ? '飞行棋' : gameId === 'gomoku' ? '五子棋' : '你画我猜');
  localStorage.setItem(GAME_SAVE_KEY, JSON.stringify({
    charId: _charId,
    charName: _charName,
    charAvatar: _charAvatar,
    gameId,
    gameName,
    gameHistory: _gameHistory,
    sessionLog: _sessionLog,
    ludo: _ludo,
    picMode: _picMode,
    picHistory: _picHistory,
    picSessionLog: _picSessionLog,
    gomoku: gameId === 'gomoku' ? getGomokuSaveState() : null,
    savedAt: Date.now(),
  }));
}

function clearGameSave() {
  localStorage.removeItem(GAME_SAVE_KEY);
}

function hasActiveGameProgress() {
  if (_ludo?.phase === 'mini' && _ludo.miniGameHistory?.length > 0) return true;
  if (_ludo && (_ludo.playerPos > 0 || _ludo.aiPos > 0 || (_ludo.log && _ludo.log.length > 0))) return true;
  if (_picMode && (_picHistory.length > 0 || _picSessionLog.length > 1)) return true;
  if (_gomokuActive) {
    const s = getGomokuSaveState();
    if (s?.moves?.length > 0 && !s.winner) return true;
  }
  if (_currentGame && (_gameHistory.length > 0 || _sessionLog.length > 1)) return true;
  return false;
}

function isLudoFinished() {
  return _ludo && (_ludo.playerPos >= LUDO_SIZE - 1 || _ludo.aiPos >= LUDO_SIZE - 1);
}

function isGomokuFinished() {
  if (!_gomokuActive) return false;
  const s = getGomokuSaveState();
  return !!(s?.winner);
}

function finishGameSession() {
  hideAllSessions();
  setGamesViewMode('lobby');
  _currentGame = null;
  _gameHistory = [];
  _sessionLog = [];
  _ludo = null;
  _picMode = null;
  _picHistory = [];
  _picSessionLog = [];
  _ludoResultSaved = false;
  if (_gomokuActive) destroyGomoku();
  _gomokuActive = false;
  _gomokuResultSaved = false;
  syncGamesLobbyChar();
}

function promptExitToLobby() {
  if (hasActiveGameProgress() && !isLudoFinished() && !isGomokuFinished()) {
    showGameConfirm({
      title: '保存进度',
      body: '游戏还没结束，是否保存进度？下次可以继续。',
      okText: '保存并退出',
      cancelText: '不保存',
      onOk: () => {
        saveGameProgress();
        window.showToast?.('进度已保存，下次可继续');
        finishGameSession();
      },
      onCancel: () => {
        clearGameSave();
        finishGameSession();
      },
    });
    return;
  }
  clearGameSave();
  finishGameSession();
}

window.handleGameBack = function() {
  if (_ludo?.phase === 'mini') {
    showGameConfirm({
      title: '退出小游戏',
      body: '结束当前小游戏并返回棋盘？',
      okText: '返回棋盘',
      cancelText: '继续玩',
      onOk: () => endLudoMini(),
    });
    return;
  }
  promptExitToLobby();
};

function promptExitGame() {
  promptExitToLobby();
}

async function promptResumeIfSaved(clickedGameId) {
  const save = getGameSave();
  if (!save || Number(save.charId) !== Number(_charId)) return false;

  const when = save.savedAt ? new Date(save.savedAt).toLocaleString('zh-CN') : '';
  const sameGame = !clickedGameId || save.gameId === clickedGameId;

  if (!sameGame) {
    const yes = await showGameConfirmAsync({
      title: '继续游戏',
      body: `你还有未结束的「${save.gameName}」${when ? '（' + when + '）' : ''}，要先继续那个吗？`,
      okText: '继续存档',
      cancelText: '放弃，玩新的',
    });
    if (yes) {
      restoreGameProgress(save);
      return true;
    }
    clearGameSave();
    return false;
  }

  const yes = await showGameConfirmAsync({
    title: '继续游戏',
    body: `发现未结束的「${save.gameName}」${when ? '（' + when + '）' : ''}，是否继续？`,
    okText: '继续',
    cancelText: '新开局',
  });
  if (yes) {
    restoreGameProgress(save);
    return true;
  }
  clearGameSave();
  return false;
}

async function checkResumeGame() {
  if (_currentGame || _ludo || _picMode) return;
  const lobby = document.getElementById('games-lobby');
  if (lobby && lobby.style.display === 'none') return;
  await promptResumeIfSaved(null);
}

function restoreGameProgress(save) {
  _charName = save.charName || _charName;
  _charAvatar = save.charAvatar || _charAvatar;
  hideAllSessions();
  setGamesViewMode('session');

  if (save.gameId === 'ludo' && save.ludo) {
    _currentGame = GAMES.find(g => g.id === 'ludo');
    _ludo = save.ludo;
    _ludoResultSaved = false;
    document.getElementById('ludo-session').style.display = 'flex';
    renderLudo();
    return;
  }

  if (save.gameId === 'pictionary' && save.picMode) {
    _currentGame = GAMES.find(g => g.id === 'pictionary');
    _picMode = save.picMode;
    _picHistory = save.picHistory || [];
    _picSessionLog = save.picSessionLog || [];
    document.getElementById('pic-session').style.display = 'flex';
    if (_picMode === 'draw') renderPicDrawMode();
    else renderPicGuessMode();
    const el = document.getElementById('pic-msgs');
    if (el) {
      el.innerHTML = '';
      _picSessionLog.forEach(m => appendPicMsg(m.role, m.content, true));
    }
    return;
  }

  if (save.gameId === 'gomoku') {
    _currentGame = GAMES.find(g => g.id === 'gomoku');
    _gomokuActive = true;
    _gomokuResultSaved = false;
    restoreGomokuState(save.gomoku, gomokuPlayCtx());
    return;
  }

  _currentGame = GAMES.find(g => g.id === save.gameId);
  if (!_currentGame) { clearGameSave(); return; }
  _gameHistory = save.gameHistory || [];
  _sessionLog = save.sessionLog || [];
  document.getElementById('game-session').style.display = 'flex';
  document.getElementById('game-session-title').textContent = _currentGame.emoji + ' ' + _currentGame.name;
  document.getElementById('game-session-sub').textContent = '与 ' + _charName + ' 对战';
  document.getElementById('game-tip').textContent = _currentGame.tip;
  const msgs = document.getElementById('game-msgs');
  if (msgs) {
    msgs.innerHTML = '';
    _sessionLog.forEach(m => appendGameMsg(m.role, m.content, null, true));
  }
  document.getElementById('game-input').value = '';
}

async function saveGameResultMemory(resultText) {
  if (!_charId) return;
  try {
    await api.summarizeGameMemory({
      charId: _charId,
      gameType: _currentGame?.id || 'game',
      gameName: _currentGame?.name || '游戏',
      history: _gameHistory,
      mode: 'result',
      resultText,
    });
    window.showToast?.('游戏结果已记入记忆');
  } catch (e) {
    window.showToast?.('记入记忆失败：' + (e.message || ''));
  }
}

function showTruthDareMemoryEditor(summary, category) {
  let overlay = document.getElementById('game-memory-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'game-memory-overlay';
    overlay.className = 'overlay center';
    overlay.onclick = (e) => { if (e.target === overlay) closeGameMemoryEditor(false); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal" style="width:calc(100% - 32px);max-width:420px" onclick="event.stopPropagation()">
      <div class="modal-title">真心话 · 记入记忆</div>
      <div class="modal-body">
        <div class="form-group">
          <label class="input-label">分类</label>
          <select class="input" id="game-memory-cat">
            <option value="重要时刻" ${category === '重要时刻' ? 'selected' : ''}>重要时刻</option>
            <option value="日常点滴">日常点滴</option>
            <option value="情感状态">情感状态</option>
            <option value="秘密/心事">秘密/心事</option>
          </select>
        </div>
        <div class="form-group">
          <label class="input-label">总结（可编辑）</label>
          <textarea class="input" id="game-memory-text" style="min-height:120px;line-height:1.6"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" onclick="closeGameMemoryEditor(false)">跳过</button>
        <button class="btn btn-primary btn-sm" onclick="saveTruthDareMemory()">保存到记忆</button>
      </div>
    </div>`;
  overlay.classList.add('active');
  const ta = document.getElementById('game-memory-text');
  if (ta) ta.value = summary || '';
}

window.closeGameMemoryEditor = function() {
  document.getElementById('game-memory-overlay')?.classList.remove('active');
  clearGameSave();
  finishGameSession();
};

window.saveTruthDareMemory = async function() {
  const text = document.getElementById('game-memory-text')?.value.trim();
  const category = document.getElementById('game-memory-cat')?.value || '重要时刻';
  if (!text) { window.showToast?.('请填写总结内容'); return; }
  try {
    await api.createMemory({
      characterId: _charId,
      category,
      content: text,
      weight: category === '重要时刻' ? 0.75 : 0.6,
    });
    window.showToast?.('已保存到记忆，可在记忆页继续编辑');
    closeGameMemoryEditor();
  } catch (e) {
    window.showToast?.('保存失败：' + e.message);
  }
};

function buildLocalGameSummary(history) {
  const settings = window.getAppSettings?.() || {};
  const uname = settings.username || '我';
  const lines = (history || []).slice(-10)
    .filter(h => h && h.content)
    .map(h => {
      const who = h.role === 'user' ? uname : _charName;
      return `${who}：${String(h.content).slice(0, 60)}`;
    });
  if (!lines.length) return `和${_charName}玩了一局真心话。`;
  return `和${_charName}的真心话：${lines.join('；')}`.slice(0, 500);
}

window.endDialogGame = async function() {
  if (!_currentGame) return;
  if (_currentGame.id === 'truth_dare') {
    showGameConfirm({
      title: '结束游戏',
      body: '本局真心话结束了，是否将游戏内容总结记入角色记忆？',
      okText: '总结并记入',
      cancelText: '直接结束',
      onOk: async () => {
        window.showToast?.('正在生成总结…');
        try {
          const r = await api.summarizeGameMemory({
            charId: _charId,
            gameType: 'truth_dare',
            gameName: '真心话',
            history: _gameHistory,
            mode: 'summary',
          });
          if (r.fallback) window.showToast?.('API 不可用，已生成本地草稿，可编辑后保存');
          showTruthDareMemoryEditor(r.summary, r.category);
        } catch (e) {
          window.showToast?.('生成总结失败，已生成本地草稿');
          showTruthDareMemoryEditor(buildLocalGameSummary(_gameHistory), '重要时刻');
        }
      },
      onCancel: () => {
        clearGameSave();
        finishGameSession();
      },
    });
    return;
  }
  clearGameSave();
  await saveGameResultMemory(`${_currentGame.name}对局结束`);
  finishGameSession();
};

window.finishLudoGame = async function(restart) {
  if (!_ludo) return;
  if (!_ludoResultSaved) {
    _ludoResultSaved = true;
    const winner = _ludo.playerPos >= LUDO_SIZE - 1 ? '你赢了' : `${_charName} 赢了`;
    await saveGameResultMemory(`飞行棋：${winner}`);
  }
  clearGameSave();
  if (restart) startGame('ludo');
  else finishGameSession();
};

// ────────────────────────────────────
// 入口
// ────────────────────────────────────
let _gamesPageBuilt = false;

window.initGamesPage = async function() {
  const page = document.getElementById('games-page');
  const prevCharId = _charId;
  _charId = window.getActiveCharId?.();
  const chars = window.getFriendCharacters?.() || window.getAppCharacters?.() || [];
  const char = chars.find(c => c.id == _charId) || chars[0];
  if (char) { _charId = char.id; _charName = char.name; _charAvatar = char.avatar || ''; }
  if (prevCharId !== _charId) {
    _listLoadedFor = null;
    _listItems = [];
  }

  if (!_gamesPageBuilt) {
  page.innerHTML = `
    <div class="topbar" id="games-lobby-topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">🎮 游戏</div>
      <div id="game-char-pick" style="font-size:12px;color:var(--theme);padding:4px 8px;cursor:pointer;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" onclick="pickGameChar()">${_charName||'选角色'}</div>
    </div>

    <!-- 大厅 -->
    <div class="scroll-area" id="games-lobby" style="padding:16px 12px">
      <div style="font-size:12px;color:var(--text-secondary);padding:0 4px 12px;letter-spacing:1px">与 <strong style="color:var(--theme)">${escapeHtml(_charName||'角色')}</strong> 一起</div>

      <!-- 共同清单入口（全宽卡片） -->
      <div onclick="openSharedList()" style="cursor:pointer;border-radius:14px;padding:16px 18px;margin-bottom:12px;
        background:linear-gradient(135deg,rgba(160,200,255,0.15),rgba(200,160,255,0.12));
        border:1px solid rgba(160,180,255,0.35);display:flex;align-items:center;gap:14px;
        transition:transform .15s"
        ontouchstart="this.style.transform='scale(.98)'" ontouchend="this.style.transform=''"
        onmousedown="this.style.transform='scale(.98)'" onmouseup="this.style.transform=''">
        <div style="font-size:34px">📋</div>
        <div style="flex:1">
          <div style="font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:3px">共同清单</div>
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">见面后想一起做的事 · 可写原因 · 随机抽一条 · 实现了 TA 会回应</div>
        </div>
        <div style="color:var(--text-secondary);font-size:18px">›</div>
      </div>

      <div style="font-size:11px;color:var(--text-secondary);padding:0 4px 8px;letter-spacing:1px">游戏</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${GAMES.map(g => `
          <div onclick="startGame('${g.id}')" style="cursor:pointer;border-radius:14px;padding:16px 14px;
            background:${g.color}22;border:1px solid ${g.color}55;transition:transform .15s"
            ontouchstart="this.style.transform='scale(.96)'" ontouchend="this.style.transform=''"
            onmousedown="this.style.transform='scale(.96)'" onmouseup="this.style.transform=''">
            <div style="font-size:28px;margin-bottom:8px">${g.emoji}</div>
            <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:4px">${g.name}</div>
            <div style="font-size:11px;color:var(--text-secondary);line-height:1.5">${g.desc}</div>
          </div>`).join('')}
      </div>
    </div>

    <!-- 通用对话式游戏界面 -->
    <div id="game-session" style="display:none;height:100%;flex-direction:column">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="handleGameBack()" title="返回"></button>
        <div style="flex:1">
          <div id="game-session-title" style="font-size:14px;font-weight:600"></div>
          <div id="game-session-sub" style="font-size:11px;color:var(--text-secondary)"></div>
        </div>
        <div class="topbar-back" onclick="endDialogGame()" style="font-size:12px;color:var(--text-secondary);margin-right:4px">结束</div>
        <div class="topbar-back" onclick="restartGame()" style="font-size:12px;color:var(--text-secondary)">重开</div>
      </div>
      <div class="scroll-area" id="game-msgs" style="padding:12px;flex:1"></div>
      <div style="padding:8px 12px;padding-bottom:max(8px,var(--sab));background:var(--bg-glass);backdrop-filter:blur(20px);border-top:1px solid var(--border)">
        <div style="display:flex;gap:8px;align-items:center">
          <input class="input" id="game-input" placeholder="输入…" style="flex:1;font-size:14px" onkeydown="if(event.key==='Enter')sendGameMsg()">
          <div class="chat-send-btn" onclick="sendGameMsg()">↑</div>
        </div>
        <div id="game-tip" style="font-size:11px;color:var(--text-secondary);text-align:center;padding:4px 0 0"></div>
      </div>
    </div>

    <!-- 飞行棋界面 -->
    <div id="ludo-session" style="display:none;height:100%;flex-direction:column">
      <div class="sheet-full-topbar" id="ludo-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="handleGameBack()" title="返回"></button>
        <div style="flex:1;font-size:14px;font-weight:600">🎯 飞行棋</div>
        <div class="topbar-back" onclick="startGame('ludo')" style="font-size:12px;color:var(--text-secondary)">重开</div>
      </div>
      <div class="sheet-full-topbar" id="ludo-mini-topbar" style="display:none">
        <button type="button" class="topbar-back topbar-nav-back" onclick="handleGameBack()" title="返回"></button>
        <div style="flex:1;font-size:14px;font-weight:600">✨ 小游戏</div>
      </div>
      <div class="scroll-area" style="flex:1;padding:12px" id="ludo-content"></div>
    </div>

    <!-- 五子棋界面 -->
    <div id="gomoku-session" style="display:none;height:100%;flex-direction:column">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="handleGameBack()" title="返回"></button>
        <div style="flex:1;font-size:14px;font-weight:600">⚫ 五子棋</div>
        <div class="topbar-back" onclick="startGame('gomoku')" style="font-size:12px;color:var(--text-secondary)">重开</div>
      </div>
      <div id="gomoku-content" style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column"></div>
    </div>

    <!-- 你画我猜界面 -->
    <div id="pic-session" style="display:none;height:100%;flex-direction:column">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="handleGameBack()" title="返回"></button>
        <div style="flex:1;font-size:14px;font-weight:600" id="pic-title">🎨 你画我猜</div>
        <div class="topbar-back" onclick="startGame('pictionary')" style="font-size:12px;color:var(--text-secondary)">重开</div>
      </div>
      <div id="pic-content" style="flex:1;overflow-y:auto;display:flex;flex-direction:column"></div>
    </div>

    <!-- 默契翻牌 -->
    <div id="sync-session" style="display:none;height:100%;flex-direction:column">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="handleGameBack()" title="返回"></button>
        <div style="flex:1;font-size:14px;font-weight:600">🎭 默契翻牌</div>
        <div class="topbar-back" onclick="openGameTopicsPanel(window.getActiveCharId?.())" style="font-size:12px;color:var(--text-secondary);margin-right:4px">话题</div>
        <div class="topbar-back" onclick="startGame('sync_answer')" style="font-size:12px;color:var(--text-secondary)">重开</div>
      </div>
      <div class="scroll-area" style="flex:1" id="sync-content"></div>
    </div>

    <!-- 真心话 -->
    <div id="truth-session" style="display:none;height:100%;flex-direction:column">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="handleGameBack()" title="返回"></button>
        <div style="flex:1;font-size:14px;font-weight:600">💬 真心话</div>
        <div class="topbar-back" onclick="openGameTopicsPanel(window.getActiveCharId?.())" style="font-size:12px;color:var(--text-secondary);margin-right:4px">话题</div>
        <div class="topbar-back" onclick="startGame('truth_dare')" style="font-size:12px;color:var(--text-secondary)">重开</div>
      </div>
      <div class="scroll-area" style="flex:1" id="truth-content"></div>
    </div>

    <!-- 共同清单界面 -->
    <div id="list-session" style="display:none;height:100%;flex-direction:column">
      <div class="sheet-full-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="closeSharedList()" title="返回"></button>
        <div style="flex:1;font-size:14px;font-weight:600">📋 共同清单</div>
        <div id="list-draw-btn" onclick="drawRandomListItem()"
          style="font-size:12px;color:var(--text-secondary);padding:4px 6px;cursor:pointer;white-space:nowrap">🎲 抽一条</div>
        <div id="list-suggest-btn" onclick="aiSuggestListItems()"
          style="font-size:12px;color:var(--theme);padding:4px 8px;cursor:pointer;white-space:nowrap">
          ${escapeHtml(_charName||'角色')} 来推荐
        </div>
      </div>

      <!-- 分类标签 -->
      <div style="display:flex;overflow-x:auto;border-bottom:1px solid var(--border);flex-shrink:0;padding:0 8px;gap:0;-webkit-overflow-scrolling:touch;scrollbar-width:none">
        ${LIST_CATS.map(c => `
          <div id="list-tab-${c.id}" onclick="switchListCat('${c.id}')"
            style="padding:9px 12px;font-size:12px;cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent;transition:color .15s;
              color:${c.id==='all'?'var(--theme)':'var(--text-secondary)'};
              font-weight:${c.id==='all'?'600':'400'};
              border-bottom-color:${c.id==='all'?'var(--theme)':'transparent'}">
            ${c.emoji} ${c.label}
          </div>`).join('')}
      </div>

      <!-- 列表体 -->
      <div class="scroll-area" id="list-body" style="flex:1;padding:0 16px"></div>

      <!-- 添加栏 -->
      <div style="padding:8px 12px;padding-bottom:max(8px,var(--sab));background:var(--bg-glass);backdrop-filter:blur(20px);border-top:1px solid var(--border);flex-shrink:0">
        <div id="list-note-row" style="display:none;margin-bottom:8px">
          <input id="list-note-input" class="input" placeholder="为什么想、见面后幻想一句…（选填）" style="width:100%;font-size:13px">
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="list-cat-sel" class="input" style="width:90px;flex-shrink:0;font-size:13px;padding:6px 8px">
            ${LIST_CATS.filter(c=>c.id!=='all').map(c=>`<option value="${c.id}">${c.emoji} ${c.label}</option>`).join('')}
          </select>
          <input id="list-input" class="input" placeholder="见面后想一起…" style="flex:1;font-size:14px"
            onkeydown="if(event.key==='Enter')addListItem()">
          <div class="topbar-back" onclick="toggleListNoteField()" title="加一句为什么想" style="font-size:12px;color:var(--text-secondary);flex-shrink:0">备注</div>
          <div class="chat-send-btn" onclick="addListItem()" style="flex-shrink:0">+</div>
        </div>
      </div>
    </div>

    <!-- 角色选择 -->
    <div id="game-char-overlay" class="overlay" onclick="this.classList.remove('active')">
      <div class="sheet" onclick="event.stopPropagation()">
        <div class="sheet-handle"></div>
        <div class="sheet-title">选择角色</div>
        <div id="game-char-list" style="padding:8px 16px 16px"></div>
      </div>
    </div>
  `;
  _gamesPageBuilt = true;
  bindSyncAnswerGlobals({
    get charName() { return _charName; },
    get charAvatar() { return _charAvatar; },
    get charId() { return _charId; },
    playGame: (data) => api.playGame(data),
    getRecentQuestions: () => _syncRecentQuestions,
    pushQuestion: (q) => { _syncRecentQuestions.push(q); if (_syncRecentQuestions.length > 12) _syncRecentQuestions.shift(); },
  });
  bindTruthGlobals(gamePlayCtx());
  }

  syncGamesLobbyChar();
  await checkResumeGame();
};

function syncGamesLobbyChar() {
  const pick = document.getElementById('game-char-pick');
  if (pick) pick.textContent = _charName || '选角色';
  const sub = document.querySelector('#games-lobby > div:first-child');
  if (sub) sub.innerHTML = `与 <strong style="color:var(--theme)">${escapeHtml(_charName || '角色')}</strong> 一起玩`;
}

// ────────────────────────────────────
// 游戏路由
// ────────────────────────────────────
window.startGame = async function(gameId) {
  if (!_charId) { window.showToast?.('请先选择角色'); pickGameChar(); return; }
  if (await promptResumeIfSaved(gameId)) return;

  hideAllSessions();
  setGamesViewMode('session');
  _currentGame = GAMES.find(x => x.id === gameId);

  if (gameId === 'ludo') { initLudo(); return; }
  if (gameId === 'gomoku') {
    _gomokuActive = true;
    _gomokuResultSaved = false;
    _currentGame = GAMES.find(x => x.id === 'gomoku');
    initGomoku(gomokuPlayCtx());
    return;
  }
  if (gameId === 'pictionary') { initPictionary(); return; }
  if (gameId === 'sync_answer') {
    _syncRecentQuestions = [];
    _currentGame = GAMES.find(x => x.id === 'sync_answer');
    initSyncAnswer({
      ...gamePlayCtx(),
      contentMode: 'daily',
      getRecentQuestions: () => _syncRecentQuestions,
      pushQuestion: (q) => { _syncRecentQuestions.push(q); if (_syncRecentQuestions.length > 12) _syncRecentQuestions.shift(); },
    });
    return;
  }
  if (gameId === 'truth_dare') {
    _currentGame = GAMES.find(x => x.id === 'truth_dare');
    initTruthGame({ ...gamePlayCtx(), contentMode: 'daily' });
    return;
  }

  // 通用对话游戏
  _gameHistory = [];
  _sessionLog = [];
  document.getElementById('game-session').style.display = 'flex';
  document.getElementById('game-session-title').textContent = _currentGame.emoji + ' ' + _currentGame.name;
  document.getElementById('game-session-sub').textContent = '与 ' + _charName + ' 对战';
  document.getElementById('game-tip').textContent = _currentGame.tip;
  document.getElementById('game-msgs').innerHTML = '';
  document.getElementById('game-input').value = '';
  appendGameMsg('system', `${_currentGame.name} 开始`);
  const startMsg = '开始游戏';
  askAI(startMsg);
};

window.exitGame = promptExitGame;

window.restartGame = function() {
  if (_currentGame?.id === 'truth_dare' && _gameHistory.length > 0) {
    showGameConfirm({
      title: '重开游戏',
      body: '重开将放弃本局进度，是否继续？',
      okText: '重开',
      cancelText: '取消',
      onOk: () => {
        clearGameSave();
        if (_currentGame) startGame(_currentGame.id);
      },
    });
    return;
  }
  clearGameSave();
  if (_currentGame) startGame(_currentGame.id);
};

function hideAllSessions() {
  ['game-session','ludo-session','gomoku-session','pic-session','sync-session','truth-session','list-session'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const miniBar = document.getElementById('ludo-mini-topbar');
  const ludoBar = document.getElementById('ludo-topbar');
  if (miniBar) miniBar.style.display = 'none';
  if (ludoBar) ludoBar.style.display = '';
}

// ══════════════════════════════════════
// 飞行棋
// ══════════════════════════════════════
const LUDO_SIZE = 32;
const LUDO_SPECIAL = {
  4:  { type:'truth',   label:'💬', color:'#f5a6c9', name:'真心话' },
  8:  { type:'truth',   label:'💬', color:'#f5a6c9', name:'真心话' },
  12: { type:'forward', label:'⭐', color:'#ffd166', name:'+3步' },
  16: { type:'riddle',  label:'❓', color:'#a6c9f5', name:'谜题' },
  20: { type:'back',    label:'💣', color:'#e57373', name:'-3步' },
  24: { type:'truth',   label:'💬', color:'#f5a6c9', name:'真心话' },
  28: { type:'truth',   label:'💬', color:'#f5a6c9', name:'真心话' },
};

function initLudo() {
  _ludo = {
    playerPos: 0, aiPos: 0,
    playerTurn: true,
    phase: 'roll',
    miniGameHistory: [],
    miniApiHistory: [],
    _typing: false,
    log: [],
  };
  _ludoResultSaved = false;
  _currentGame = GAMES.find(g => g.id === 'ludo');
  document.getElementById('ludo-session').style.display = 'flex';
  renderLudo();
}

function renderLudo() {
  const el = document.getElementById('ludo-content');
  if (!el || !_ludo) return;
  const { playerPos, aiPos, playerTurn, phase, log, miniGameHistory } = _ludo;
  const done = playerPos >= LUDO_SIZE || aiPos >= LUDO_SIZE;

  const ludoBar = document.getElementById('ludo-topbar');
  const miniBar = document.getElementById('ludo-mini-topbar');
  if (ludoBar && miniBar) {
    const inMini = phase === 'mini';
    ludoBar.style.display = inMini ? 'none' : '';
    miniBar.style.display = inMini ? 'flex' : 'none';
  }

  if (phase === 'mini') {
    const msgs = miniGameHistory.map(m => {
      const isUser = m.role === 'user';
      return isUser
        ? `<div style="text-align:right;margin:6px 0"><span style="background:var(--theme);color:#fff;border-radius:12px;padding:6px 12px;font-size:13px;display:inline-block;max-width:80%">${escapeHtml(m.content)}</span></div>`
        : `<div style="margin:6px 0;display:flex;gap:8px;align-items:flex-start">
            ${_charAvatar?`<img src="${escapeHtml(_charAvatar)}" style="width:26px;height:26px;border-radius:50%;object-fit:cover;flex-shrink:0">`:`<div style="width:26px;height:26px;border-radius:50%;background:var(--theme-light);display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0">${escapeHtml(_charName.slice(0,1))}</div>`}
            <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:12px;padding:8px 12px;font-size:13px;max-width:80%;line-height:1.6">${escapeHtml(m.content)}</div>
           </div>`;
    }).join('');
    const typingHtml = _ludo._typing ? `<div style="margin:6px 0;display:flex;gap:8px;align-items:flex-end">
      <div style="width:26px;height:26px;border-radius:50%;background:var(--theme-light);flex-shrink:0"></div>
      <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:12px;padding:8px 12px;display:flex;gap:4px">
        <span style="width:5px;height:5px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .0s both;display:inline-block"></span>
        <span style="width:5px;height:5px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .4s both;display:inline-block"></span>
        <span style="width:5px;height:5px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .8s both;display:inline-block"></span>
      </div>
    </div>` : '';
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:0">
        <div style="flex:1;overflow-y:auto;padding:4px 0">${msgs}${typingHtml}</div>
        <div style="padding-top:10px;border-top:1px solid var(--border);margin-top:8px">
          <div style="display:flex;gap:8px">
            <input class="input" id="ludo-mini-input" placeholder="回答…" style="flex:1;font-size:13px" onkeydown="if(event.key==='Enter')sendLudoMini()">
            <button class="btn btn-primary btn-sm" onclick="sendLudoMini()">发送</button>
          </div>
        </div>
      </div>`;
    el.scrollTop = el.scrollHeight;
    if (!_ludo._typing) document.getElementById('ludo-mini-input')?.focus();
    return;
  }

  // 棋盘：蛇形布局，每行8格
  const COLS = 8;
  const rows = [];
  for (let i = 0; i < LUDO_SIZE; i++) rows.push(i);

  const rowCount = Math.ceil(LUDO_SIZE / COLS);
  let boardHtml = '<div style="display:grid;grid-template-columns:repeat(8,1fr);gap:3px;margin-bottom:12px">';
  for (let r = 0; r < rowCount; r++) {
    const rowSquares = r % 2 === 0
      ? rows.slice(r*COLS, r*COLS+COLS)
      : rows.slice(r*COLS, r*COLS+COLS).reverse();
    for (const sq of rowSquares) {
      const sp = LUDO_SPECIAL[sq+1]; // 1-indexed
      const isPlayer = playerPos === sq;
      const isAi = aiPos === sq;
      const isFinish = sq === LUDO_SIZE - 1;
      const bg = isFinish ? '#ffd700' : sp ? sp.color + '44' : 'var(--bg-glass)';
      const border = isFinish ? '2px solid #ffd700' : sp ? `1.5px solid ${sp.color}88` : '1px solid var(--border)';
      boardHtml += `<div style="
        aspect-ratio:1;border-radius:6px;background:${bg};border:${border};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        font-size:10px;position:relative;overflow:hidden">
        <div style="font-size:9px;color:var(--text-secondary);line-height:1">${sq+1===LUDO_SIZE?'🏁':sq+1}</div>
        ${sp ? `<div style="font-size:11px">${sp.label}</div>` : ''}
        ${isFinish&&!sp ? '<div style="font-size:14px">🏁</div>' : ''}
        <div style="display:flex;gap:1px;flex-wrap:wrap;justify-content:center;position:absolute;bottom:1px">
          ${isPlayer ? `<span style="font-size:14px">🔵</span>` : ''}
          ${isAi ? `<span style="font-size:14px">🔴</span>` : ''}
        </div>
      </div>`;
    }
  }
  boardHtml += '</div>';

  // 玩家状态
  const playerPct = Math.round(playerPos / (LUDO_SIZE-1) * 100);
  const aiPct = Math.round(aiPos / (LUDO_SIZE-1) * 100);

  const statusHtml = `
    <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:12px;padding:10px 14px;margin-bottom:10px;display:flex;gap:12px">
      <div style="flex:1;text-align:center">
        <div style="font-size:22px">🔵</div>
        <div style="font-size:12px;color:var(--text-primary);margin:2px 0">你</div>
        <div style="font-size:11px;color:var(--text-secondary)">第 ${playerPos+1} 格（${playerPct}%）</div>
      </div>
      <div style="flex:1;text-align:center">
        <div style="font-size:22px">🔴</div>
        <div style="font-size:12px;color:var(--text-primary);margin:2px 0">${escapeHtml(_charName)}</div>
        <div style="font-size:11px;color:var(--text-secondary)">第 ${aiPos+1} 格（${aiPct}%）</div>
      </div>
    </div>`;

  // 日志
  const logHtml = log.slice(-4).map(l =>
    `<div style="font-size:12px;color:var(--text-secondary);padding:2px 0">${l}</div>`
  ).join('');

  // 操作按钮
  let actionHtml = '';
  if (done) {
    const winner = playerPos >= LUDO_SIZE ? '你赢了！🎉' : `${_charName} 赢了！`;
    actionHtml = `<div style="text-align:center;padding:20px 0">
      <div style="font-size:28px;margin-bottom:8px">${playerPos >= LUDO_SIZE ? '🏆' : '🥈'}</div>
      <div style="font-size:18px;font-weight:600;color:var(--text-primary)">${winner}</div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="finishLudoGame(true)">再来一局</button>
        <button class="btn btn-ghost" onclick="finishLudoGame(false)">返回大厅</button>
      </div>
    </div>`;
    if (!_ludoResultSaved) {
      _ludoResultSaved = true;
      const w = playerPos >= LUDO_SIZE ? '你赢了' : `${_charName} 赢了`;
      saveGameResultMemory(`飞行棋：${w}`);
    }
  } else if (phase === 'roll' && playerTurn) {
    actionHtml = `<button class="btn btn-primary" style="width:100%;font-size:16px;padding:14px" onclick="ludoRoll()">🎲 掷骰子</button>`;
  } else if (phase === 'roll' && !playerTurn) {
    actionHtml = `<button class="btn btn-ghost" style="width:100%;font-size:14px" onclick="ludoAiTurn()">让 ${escapeHtml(_charName)} 掷骰子</button>`;
  }

  el.innerHTML = boardHtml + statusHtml +
    (logHtml ? `<div style="padding:6px 8px;background:var(--bg-glass);border:1px solid var(--border);border-radius:8px;margin-bottom:10px">${logHtml}</div>` : '') +
    actionHtml;
}

window.ludoRoll = async function() {
  if (!_ludo || _ludo.phase !== 'roll' || !_ludo.playerTurn) return;
  const dice = Math.floor(Math.random() * 6) + 1;
  const prev = _ludo.playerPos;
  _ludo.playerPos = Math.min(prev + dice, LUDO_SIZE - 1);
  _ludo.log.push(`🔵 你掷出了 ${dice}，从第${prev+1}格走到第${_ludo.playerPos+1}格`);

  await checkLudoSpecial('player');
};

window.ludoAiTurn = async function() {
  if (!_ludo || _ludo.phase !== 'roll' || _ludo.playerTurn) return;
  const dice = Math.floor(Math.random() * 6) + 1;
  const prev = _ludo.aiPos;
  _ludo.aiPos = Math.min(prev + dice, LUDO_SIZE - 1);
  _ludo.log.push(`🔴 ${_charName} 掷出了 ${dice}，从第${prev+1}格走到第${_ludo.aiPos+1}格`);
  renderLudo();

  await checkLudoSpecial('ai');
};

function ludoMiniGameType(sq) {
  return sq?.type === 'riddle' ? 'ludo_riddle' : 'ludo_truth';
}

async function appendLudoMiniAi(fullText) {
  if (!_ludo) return;
  _ludo.miniApiHistory = _ludo.miniApiHistory || [];
  _ludo.miniApiHistory.push({ role: 'assistant', content: fullText });
  const segments = splitAiSegments(fullText);
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      _ludo._typing = true;
      renderLudo();
      const delay = Math.min(Math.max(segments[i].length * 40, 600), 2200);
      await new Promise(r => setTimeout(r, delay));
      _ludo._typing = false;
    }
    _ludo.miniGameHistory.push({ role: 'assistant', content: segments[i] });
    renderLudo();
  }
}

async function checkLudoSpecial(who) {
  const pos = who === 'player' ? _ludo.playerPos : _ludo.aiPos;
  const sq = LUDO_SPECIAL[pos + 1]; // 1-indexed

  if (sq) {
    _ludo.log.push(`${who==='player'?'🔵 你':'🔴 '+_charName}落在了【${sq.name}】格！`);

    if (sq.type === 'forward') {
      const delta = 3;
      if (who === 'player') _ludo.playerPos = Math.min(_ludo.playerPos + delta, LUDO_SIZE-1);
      else _ludo.aiPos = Math.min(_ludo.aiPos + delta, LUDO_SIZE-1);
      _ludo.log.push(`✨ 前进 ${delta} 步！`);
      _ludo.playerTurn = !_ludo.playerTurn;
      renderLudo();
    } else if (sq.type === 'back') {
      const delta = 3;
      if (who === 'player') _ludo.playerPos = Math.max(_ludo.playerPos - delta, 0);
      else _ludo.aiPos = Math.max(_ludo.aiPos - delta, 0);
      _ludo.log.push(`💣 后退 ${delta} 步！`);
      _ludo.playerTurn = !_ludo.playerTurn;
      renderLudo();
    } else {
      _ludo.phase = 'mini';
      _ludo.miniGameHistory = [];
      _ludo.miniApiHistory = [];
      _ludo._typing = true;
      renderLudo();
      const gameType = ludoMiniGameType(sq);
      try {
        const r = await api.playGame({ gameType, charId: _charId, userInput: '触发了特殊格子', history: [] });
        _ludo._typing = false;
        if (r.reply) await appendLudoMiniAi(r.reply);
        else renderLudo();
      } catch(e) { _ludo._typing = false; endLudoMini(); }
    }
  } else {
    _ludo.playerTurn = !_ludo.playerTurn;
    // 检查胜利
    if (_ludo.playerPos >= LUDO_SIZE-1 || _ludo.aiPos >= LUDO_SIZE-1) _ludo.phase = 'done';
    renderLudo();
  }
}

window.sendLudoMini = async function() {
  const input = document.getElementById('ludo-mini-input');
  const text = input?.value.trim();
  if (!text || _ludo?._typing) return;
  input.value = '';
  _ludo.miniGameHistory.push({ role: 'user', content: text });
  _ludo.miniApiHistory = _ludo.miniApiHistory || [];
  _ludo.miniApiHistory.push({ role: 'user', content: text });
  renderLudo();

  const sq = LUDO_SPECIAL[(_ludo.playerTurn ? _ludo.playerPos : _ludo.aiPos) + 1];
  const gameType = ludoMiniGameType(sq);
  _ludo._typing = true;
  renderLudo();
  try {
    const r = await api.playGame({
      gameType,
      charId: _charId,
      userInput: text,
      history: (_ludo.miniApiHistory || []).slice(-6),
    });
    _ludo._typing = false;
    if (r.reply) await appendLudoMiniAi(r.reply);
    else renderLudo();
  } catch(e) {
    _ludo._typing = false;
    renderLudo();
    window.showToast?.(e.message);
  }
};

window.endLudoMini = function() {
  if (!_ludo) return;
  _ludo.phase = 'roll';
  _ludo.miniGameHistory = [];
  _ludo.miniApiHistory = [];
  _ludo._typing = false;
  _ludo.playerTurn = !_ludo.playerTurn;
  if (_ludo.playerPos >= LUDO_SIZE-1 || _ludo.aiPos >= LUDO_SIZE-1) _ludo.phase = 'done';
  renderLudo();
};

// ══════════════════════════════════════
// 你画我猜
// ══════════════════════════════════════
function initPictionary() {
  _picMode = null;
  _picHistory = [];
  _picSessionLog = [];
  _currentGame = GAMES.find(g => g.id === 'pictionary');
  document.getElementById('pic-session').style.display = 'flex';
  renderPicModeSelect();
}

function renderPicModeSelect() {
  const el = document.getElementById('pic-content');
  el.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:16px">
      <div style="font-size:40px">🎨</div>
      <div style="font-size:16px;font-weight:600;color:var(--text-primary)">选择模式</div>
      <div style="width:100%;max-width:320px;display:flex;flex-direction:column;gap:12px">
        <div onclick="startPicMode('draw')" style="cursor:pointer;background:var(--bg-glass);border:1px solid var(--border);border-radius:14px;padding:16px 20px;transition:border-color .2s" onmouseenter="this.style.borderColor='var(--theme)'" onmouseleave="this.style.borderColor='var(--border)'">
          <div style="font-size:18px;margin-bottom:6px">🖼️ 我上传画，TA来猜</div>
          <div style="font-size:12px;color:var(--text-secondary)">上传你的画作，${escapeHtml(_charName)}用 AI 识图来猜</div>
        </div>
        <div onclick="startPicMode('guess')" style="cursor:pointer;background:var(--bg-glass);border:1px solid var(--border);border-radius:14px;padding:16px 20px;transition:border-color .2s" onmouseenter="this.style.borderColor='var(--theme)'" onmouseleave="this.style.borderColor='var(--border)'">
          <div style="font-size:18px;margin-bottom:6px">🔎 TA来描述，我来猜</div>
          <div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(_charName)}逐步描述画面，你来猜是什么</div>
        </div>
      </div>
    </div>`;
}

window.startPicMode = async function(mode) {
  _picMode = mode;
  _picHistory = [];

  if (mode === 'draw') {
    renderPicDrawMode();
  } else {
    renderPicGuessMode();
    // AI先开始描述
    await picAskAI('开始游戏，想好词语，开始逐步描述', 'pictionary_ai');
  }
};

function renderPicDrawMode() {
  const el = document.getElementById('pic-content');
  document.getElementById('pic-title').textContent = '🎨 你画我猜 — 我上传画';
  el.innerHTML = `
    <div style="padding:12px;background:var(--bg-glass);border-bottom:1px solid var(--border)">
      <div style="font-size:13px;color:var(--text-secondary)">上传你的画作，${escapeHtml(_charName)}会通过识图来猜是什么</div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:12px" id="pic-msgs"></div>
    <div style="padding:8px 12px;padding-bottom:max(8px,var(--sab));border-top:1px solid var(--border);background:var(--bg-glass)">
      <div id="pic-preview" style="display:none;margin-bottom:8px;text-align:center">
        <img id="pic-preview-img" style="max-width:100%;max-height:160px;border-radius:10px;border:1px solid var(--border)">
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <label class="btn btn-ghost btn-sm" style="flex-shrink:0;cursor:pointer">
          📷 选图
          <input type="file" accept="image/*" style="display:none" onchange="picSelectImage(this)">
        </label>
        <input class="input" id="pic-hint" placeholder="可选：给点提示…" style="flex:1;font-size:14px">
        <div class="chat-send-btn" onclick="picSubmitDrawing()" style="flex-shrink:0">↑</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:11px;color:var(--text-secondary)">支持相册或拍照上传</div>
        <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="startPicMode('draw')">换图重开</button>
      </div>
    </div>`;
  _picPendingUrl = '';
  appendPicMsg('system', '上传你的画作，让 TA 来猜！');
}

let _picPendingUrl = '';

window.picSelectImage = async function(input) {
  const file = input?.files?.[0];
  if (!file) return;
  input.value = '';
  try {
    window.showToast?.('上传中…');
    const r = await api.uploadFile(file);
    _picPendingUrl = r.url || r.path || '';
    const preview = document.getElementById('pic-preview');
    const img = document.getElementById('pic-preview-img');
    if (preview && img && _picPendingUrl) {
      img.src = _picPendingUrl;
      preview.style.display = 'block';
    }
    window.showToast?.('已选图，点 ↑ 让 TA 猜');
  } catch (e) {
    window.showToast?.(e.message || '上传失败');
  }
};

window.picSubmitDrawing = async function() {
  if (_isTyping) return;
  if (!_picPendingUrl) { window.showToast?.('请先上传画作'); return; }
  const hint = document.getElementById('pic-hint')?.value.trim() || '';
  appendPicMsg('user', hint ? `[画作] ${hint}` : '[上传了画作]');
  const preview = document.getElementById('pic-msgs');
  if (preview) {
    preview.insertAdjacentHTML('beforeend', `<div style="display:flex;justify-content:flex-end;margin:6px 0"><img src="${escapeHtml(_picPendingUrl)}" style="max-width:60%;max-height:180px;border-radius:12px;border:1px solid var(--border)"></div>`);
    preview.scrollTop = preview.scrollHeight;
  }
  const userText = hint || '看看我画的这是什么？';
  _picHistory.push({ role: 'user', content: userText });
  await picAskAI(userText, 'pictionary_guess', _picPendingUrl);
  _picPendingUrl = '';
  const prevBox = document.getElementById('pic-preview');
  if (prevBox) prevBox.style.display = 'none';
  const hintEl = document.getElementById('pic-hint');
  if (hintEl) hintEl.value = '';
};

function renderPicGuessMode() {
  const el = document.getElementById('pic-content');
  document.getElementById('pic-title').textContent = '🎨 你画我猜 — TA来描述';
  el.innerHTML = `
    <div style="padding:12px;background:var(--bg-glass);border-bottom:1px solid var(--border)">
      <div style="font-size:13px;color:var(--text-secondary)">${escapeHtml(_charName)}正在"画"，根据描述猜出是什么</div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:12px" id="pic-msgs"></div>
    <div style="padding:8px 12px;padding-bottom:max(8px,var(--sab));border-top:1px solid var(--border);background:var(--bg-glass)">
      <div style="display:flex;gap:8px;align-items:center">
        <input class="input" id="pic-input" placeholder="猜一个词…" style="flex:1;font-size:14px" onkeydown="if(event.key==='Enter')sendPicMsg()">
        <div class="chat-send-btn" onclick="sendPicMsg()">↑</div>
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;text-align:center">根据TA的"笔触"描述来猜</div>
    </div>`;
}

function appendPicMsg(role, content, skipLog) {
  const el = document.getElementById('pic-msgs');
  if (!el) return;
  if (!skipLog) _picSessionLog.push({ role, content });
  if (role === 'system') {
    el.insertAdjacentHTML('beforeend', `<div style="text-align:center;font-size:11px;color:var(--text-secondary);padding:6px 0">— ${escapeHtml(content)} —</div>`);
  } else if (role === 'user') {
    el.insertAdjacentHTML('beforeend', `<div style="display:flex;justify-content:flex-end;margin:6px 0"><div style="max-width:76%;background:var(--theme);color:#fff;border-radius:16px 16px 4px 16px;padding:10px 14px;font-size:14px;line-height:1.6">${escapeHtml(content)}</div></div>`);
  } else {
    el.insertAdjacentHTML('beforeend', `<div style="display:flex;gap:8px;align-items:flex-end;margin:6px 0">
      <div style="width:30px;height:30px;border-radius:50%;background:var(--theme-light);flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center">
        ${_charAvatar?`<img src="${escapeHtml(_charAvatar)}" style="width:100%;height:100%;object-fit:cover">`:`<span style="font-size:12px">${escapeHtml(_charName.slice(0,1))}</span>`}
      </div>
      <div style="max-width:76%;background:var(--bg-glass);border:1px solid var(--border);border-radius:16px 16px 16px 4px;padding:10px 14px;font-size:14px;line-height:1.6">${escapeHtml(content)}</div>
    </div>`);
  }
  el.scrollTop = el.scrollHeight;
}

window.sendPicMsg = async function() {
  const input = document.getElementById('pic-input');
  const text = input?.value.trim();
  if (!text || _isTyping) return;
  input.value = '';
  appendPicMsg('user', text);
  _picHistory.push({ role: 'user', content: text });
  await picAskAI(text, _picMode === 'draw' ? 'pictionary_guess' : 'pictionary_ai');
};

async function picAskAI(userText, gameType, imageUrl) {
  _isTyping = true;
  const typingId = showGameTypingBubble('pic-msgs');
  try {
    const payload = { gameType, charId: _charId, userInput: userText, history: _picHistory.slice(-10) };
    if (imageUrl) payload.imageUrl = imageUrl;
    const r = await api.playGame(payload);
    if (typingId) document.getElementById(typingId)?.remove();
    if (r.reply) {
      _picHistory.push({ role: 'assistant', content: r.reply });
      await renderSegmentedAiReply(r.reply, (seg) => appendPicMsg('ai', seg), 'pic-msgs');
    }
  } catch(e) {
    if (typingId) document.getElementById(typingId)?.remove();
    appendPicMsg('system', '出错了：' + e.message);
  }
  _isTyping = false;
}

// ══════════════════════════════════════
// 通用对话游戏
// ══════════════════════════════════════

function showGameTypingBubble(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return null;
  const typingId = 'game-typing-' + Date.now();
  el.insertAdjacentHTML('beforeend', `<div id="${typingId}" style="display:flex;gap:10px;align-items:flex-end;margin-bottom:12px">
    <div style="width:34px;height:34px;border-radius:50%;background:var(--theme-light);flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center">
      ${_charAvatar?`<img src="${escapeHtml(_charAvatar)}" style="width:100%;height:100%;object-fit:cover">`:`<span style="font-size:14px">${escapeHtml(_charName.slice(0,1))}</span>`}
    </div>
    <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:16px 16px 16px 4px;padding:10px 14px;display:flex;gap:4px">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .0s both;display:inline-block"></span>
      <span style="width:6px;height:6px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .4s both;display:inline-block"></span>
      <span style="width:6px;height:6px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .8s both;display:inline-block"></span>
    </div>
  </div>`);
  el.scrollTop = el.scrollHeight;
  return typingId;
}

async function renderSegmentedAiReply(fullText, appendBubble, containerId) {
  const segments = splitAiSegments(fullText);
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      const tid = showGameTypingBubble(containerId);
      const delay = Math.min(Math.max(segments[i].length * 40, 600), 2200);
      await new Promise(r => setTimeout(r, delay));
      if (tid) document.getElementById(tid)?.remove();
    }
    appendBubble(segments[i]);
  }
}

window.sendGameMsg = async function() {
  const input = document.getElementById('game-input');
  const text = input?.value.trim();
  if (!text || _isTyping) return;
  input.value = '';
  appendGameMsg('user', text);
  await askAI(text);
};

async function askAI(userText) {
  _isTyping = true;
  document.getElementById('game-input').disabled = true;

  const typingId = 'gt-' + Date.now();
  const el = document.getElementById('game-msgs');
  if (el) {
    const d = document.createElement('div');
    d.id = typingId;
    d.style.cssText = 'display:flex;gap:10px;align-items:flex-end;margin-bottom:12px';
    d.innerHTML = `
      <div style="width:34px;height:34px;border-radius:50%;background:var(--theme-light);flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center">
        ${_charAvatar?`<img src="${escapeHtml(_charAvatar)}" style="width:100%;height:100%;object-fit:cover">`:`<span>${escapeHtml(_charName.slice(0,1))}</span>`}
      </div>
      <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:16px 16px 16px 4px;padding:10px 14px;display:flex;gap:4px">
        <span style="width:6px;height:6px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .0s both;display:inline-block"></span>
        <span style="width:6px;height:6px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .4s both;display:inline-block"></span>
        <span style="width:6px;height:6px;border-radius:50%;background:var(--text-secondary);animation:typing-dot 1.2s infinite .8s both;display:inline-block"></span>
      </div>`;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  try {
    const r = await api.playGame({ gameType: _currentGame.id, charId: _charId, userInput: userText, history: _gameHistory.slice(-18) });
    document.getElementById(typingId)?.remove();
    if (r.reply) {
      _gameHistory.push({ role: 'user', content: userText });
      _gameHistory.push({ role: 'assistant', content: r.reply });
      await renderSegmentedAiReply(r.reply, (seg) => appendGameMsg('ai', seg), 'game-msgs');
    }
  } catch(e) {
    document.getElementById(typingId)?.remove();
    appendGameMsg('error', e.message);
  }

  _isTyping = false;
  const inp = document.getElementById('game-input');
  if (inp) { inp.disabled = false; inp.focus(); }
}

function appendGameMsg(role, content, id, skipLog) {
  const msgs = document.getElementById('game-msgs');
  if (!msgs) return;
  if (!skipLog) _sessionLog.push({ role, content });
  let html = '';
  if (role === 'system') {
    html = `<div style="text-align:center;font-size:11px;color:var(--text-secondary);padding:8px 0;margin-bottom:4px">— ${escapeHtml(content)} —</div>`;
  } else if (role === 'user') {
    html = `<div style="display:flex;justify-content:flex-end;margin-bottom:12px"><div style="max-width:75%;background:var(--theme);color:#fff;border-radius:16px 16px 4px 16px;padding:10px 14px;font-size:14px;line-height:1.6">${escapeHtml(content)}</div></div>`;
  } else if (role === 'ai') {
    html = `<div style="display:flex;gap:10px;align-items:flex-end;margin-bottom:12px">
      <div style="width:34px;height:34px;border-radius:50%;background:var(--theme-light);flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center">
        ${_charAvatar?`<img src="${escapeHtml(_charAvatar)}" style="width:100%;height:100%;object-fit:cover">`:`<span style="font-size:14px">${escapeHtml(_charName.slice(0,1))}</span>`}
      </div>
      <div style="max-width:78%;background:var(--bg-glass);border:1px solid var(--border);border-radius:16px 16px 16px 4px;padding:10px 14px;font-size:14px;line-height:1.6;color:var(--text-primary)">${escapeHtml(content)}</div>
    </div>`;
  } else if (role === 'error') {
    html = `<div style="text-align:center;font-size:12px;color:#e57373;padding:4px 0">${escapeHtml(content)}</div>`;
  }
  if (id) {
    const d = document.createElement('div');
    d.id = id;
    d.innerHTML = html;
    msgs.appendChild(d);
  } else {
    msgs.insertAdjacentHTML('beforeend', html);
  }
  msgs.scrollTop = msgs.scrollHeight;
}

// ══════════════════════════════════════
// 选角色
// ══════════════════════════════════════
window.pickGameChar = function() {
  const chars = window.getFriendCharacters?.() || window.getAppCharacters?.() || [];
  if (!chars.length) { window.showToast?.('还没有好友'); return; }
  document.getElementById('game-char-list').innerHTML = chars.map(c => `
    <div class="settings-row" onclick="selectGameChar(${c.id},'${escapeHtml(c.name)}','${c.avatar||''}')" style="cursor:pointer">
      ${c.avatar?`<img src="${escapeHtml(c.avatar)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover">`:`<div style="width:36px;height:36px;border-radius:50%;background:var(--theme-light);display:flex;align-items:center;justify-content:center;font-size:16px">${escapeHtml(c.name.slice(0,1))}</div>`}
      <div style="flex:1"><div style="font-size:14px">${escapeHtml(c.name)}</div></div>
      ${_charId==c.id?'<div style="color:var(--theme)">✓</div>':''}
    </div>`).join('');
  document.getElementById('game-char-overlay').classList.add('active');
};

window.selectGameChar = function(id, name, avatar) {
  if (_charId !== id) {
    _listLoadedFor = null;
    _listItems = [];
  }
  _charId = id; _charName = name; _charAvatar = avatar;
  document.getElementById('game-char-overlay').classList.remove('active');
  syncGamesLobbyChar();
  checkResumeGame();
};

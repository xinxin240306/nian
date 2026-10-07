/* 聊天内游戏管家（方案 C）— 掷骰定先手 · 封存答案 */
import * as api from './api.js';
import { escapeHtml } from './memory.js';

const GAMES = [
  { id: 'pictionary', name: '你画我猜', emoji: '🎨', desc: '掷骰定先后；你画时角色识图猜，角色画时你文字猜' },
  { id: 'ten_q', name: '十问猜谜', emoji: '🔍', desc: '掷骰定提问方，10 次是/否机会猜谜底' },
  { id: 'truth', name: '真心话', emoji: '💬', desc: '掷骰定谁先答，答完角色会回应，无输赢' },
  { id: 'quiz', name: '谁更了解谁', emoji: '💡', desc: '共 3 题，测默契，不计赌注输赢' },
];

const GAME_NAMES = {
  pictionary: '你画我猜',
  ten_q: '十问猜谜',
  truth: '真心话',
  quiz: '谁更了解谁',
};

let _hooks = null;
let _state = null;
let _busy = false;

function stateKey(charId) {
  return `game_butler_${charId}`;
}

function loadState(charId) {
  try {
    const raw = localStorage.getItem(stateKey(charId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveState() {
  if (!_state?.charId) return;
  try {
    localStorage.setItem(stateKey(_state.charId), JSON.stringify(_state));
  } catch {}
}

function clearState(charId) {
  try { localStorage.removeItem(stateKey(charId || _state?.charId)); } catch {}
  _state = null;
  updateBar();
}

function rollDice() {
  return Math.floor(Math.random() * 6) + 1;
}

function userName() {
  return _hooks?.getUserName?.() || '你';
}

function charName() {
  return _hooks?.getChar?.()?.name || 'TA';
}

function roleLabel(who) {
  return who === 'user' ? userName() : charName();
}

function updateBar() {
  const bar = document.getElementById('game-butler-bar');
  const nameEl = document.getElementById('game-butler-bar-name');
  const textEl = document.getElementById('game-butler-bar-text');
  const diceBtn = document.getElementById('game-butler-dice-btn');
  if (!bar) return;
  if (!_state?.active) {
    bar.style.display = 'none';
    if (diceBtn) diceBtn.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  if (diceBtn) diceBtn.style.display = _state.phase === 'dice' ? 'inline-flex' : 'none';

  if (nameEl) nameEl.textContent = GAME_NAMES[_state.game] || '游戏';

  const stake = _state.stake ? ` · 赌注：${_state.stake}` : '';
  let hint = '进行中';
  if (_state.phase === 'dice') hint = '请掷骰子决定谁先';
  else if (_state.game === 'pictionary') {
    if (_state.phase === 'upload_draw') hint = '请发一张画到聊天';
    else if (_state.guesser === 'user') {
      const left = _state.guessesLeft ?? 0;
      hint = left > 0 ? `你来猜 · 还剩 ${left} 次` : '你来猜';
    } else hint = `${charName()} 来猜`;
  } else if (_state.game === 'ten_q') {
    hint = _state.guesser === 'user'
      ? `你来提问 · 还剩 ${_state.questionsLeft ?? 10} 次`
      : `用 是/否 回答 · 还剩 ${_state.questionsLeft ?? 10} 次`;
  } else if (_state.game === 'truth') {
    hint = _state.phase === 'answer' ? '请回答真心话' : '等待中…';
  }   else if (_state.game === 'quiz') {
    const r = _state.quizRound || 1;
    const t = _state.quizTotal || 3;
    hint = _state.phase === 'answer' ? `第 ${r}/${t} 题 · 请回答` : (_state.phase === 'judge' ? `第 ${r}/${t} 题 · 请判定 TA 的回答` : '等待中…');
  }
  if (textEl) textEl.textContent = hint + stake;
}

async function renderServerMessages(messages = []) {
  if (!_hooks || !messages.length) return;
  for (const m of messages) {
    if (m.role === 'system' || m.type === 'system') {
      (_hooks.displaySystem || _hooks.appendSystem)(m.content);
    } else if (m.type === 'image') {
      await (_hooks.displayCharImage || _hooks.appendCharImage)(m.content);
    } else {
      await (_hooks.displayCharText || _hooks.appendCharText)(m.content);
    }
  }
}

function displayHiddenEntry(entry) {
  if (!_hooks?.displayHiddenButler || !entry) return;
  _hooks.displayHiddenButler(entry.question, entry.answer);
  if (!_state.hiddenLog) _state.hiddenLog = [];
  _state.hiddenLog.push(entry);
  saveState();
}

function showQuizJudgePopup() {
  let overlay = document.getElementById('game-quiz-judge-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'game-quiz-judge-overlay';
    overlay.className = 'overlay center';
    overlay.style.cssText = 'display:none;z-index:10002;background:rgba(0,0,0,0.45)';
    overlay.innerHTML = `
      <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:16px;padding:24px;max-width:320px;width:88%;text-align:center" onclick="event.stopPropagation()">
        <div style="font-size:15px;font-weight:600;margin-bottom:8px">TA 的回答对吗？</div>
        <div id="game-quiz-judge-hint" style="font-size:12px;color:var(--text-secondary);margin-bottom:20px;line-height:1.5"></div>
        <div style="display:flex;gap:12px;justify-content:center">
          <button type="button" class="btn btn-primary" id="game-quiz-judge-yes" style="flex:1">对</button>
          <button type="button" class="btn btn-ghost" id="game-quiz-judge-no" style="flex:1">错</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }
  const hint = document.getElementById('game-quiz-judge-hint');
  if (hint) hint.textContent = _state?.charAnswer ? `TA 说：${_state.charAnswer.slice(0, 80)}` : '';
  overlay.style.display = 'flex';
  return new Promise(resolve => {
    const close = (val) => { overlay.style.display = 'none'; resolve(val); };
    document.getElementById('game-quiz-judge-yes').onclick = () => close(true);
    document.getElementById('game-quiz-judge-no').onclick = () => close(false);
  });
}

function showPrivateWordPopup(word, title) {
  let overlay = document.getElementById('game-private-word-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'game-private-word-overlay';
    overlay.className = 'overlay center';
    overlay.style.cssText = 'z-index:10003;background:rgba(0,0,0,0.5)';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:16px;padding:24px;max-width:320px;width:88%;text-align:center" onclick="event.stopPropagation()">
      <div style="font-size:14px;color:var(--text-secondary);margin-bottom:8px">${escapeHtml(title)}</div>
      <div style="font-size:28px;font-weight:700;color:var(--theme);margin:16px 0;letter-spacing:4px">${escapeHtml(word)}</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:20px;line-height:1.5">仅你可见，请勿告诉 TA，局结束后会公布</div>
      <button type="button" class="btn btn-primary" style="width:100%" id="game-private-word-ok">知道了</button>
    </div>`;
  overlay.style.display = 'flex';
  return new Promise(resolve => {
    document.getElementById('game-private-word-ok').onclick = () => {
      overlay.style.display = 'none';
      resolve();
    };
  });
}

function showUserSecretInput() {
  let overlay = document.getElementById('game-user-secret-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'game-user-secret-overlay';
    overlay.className = 'overlay center';
    overlay.style.cssText = 'z-index:10003;background:rgba(0,0,0,0.5)';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:16px;padding:24px;max-width:320px;width:88%" onclick="event.stopPropagation()">
      <div style="font-size:15px;font-weight:600;margin-bottom:8px;text-align:center">你心里想一个谜底</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:14px;line-height:1.5;text-align:center">人物、动物或物品，2-6 个字。仅你可见，${escapeHtml(charName())} 不会知道。</div>
      <input id="game-user-secret-input" type="text" maxlength="20" placeholder="例如：苹果"
        style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:15px;margin-bottom:14px">
      <button type="button" class="btn btn-primary" style="width:100%" id="game-user-secret-ok">确定</button>
    </div>`;
  overlay.style.display = 'flex';
  return new Promise(resolve => {
    const input = document.getElementById('game-user-secret-input');
    setTimeout(() => input?.focus(), 100);
    document.getElementById('game-user-secret-ok').onclick = () => {
      const v = input?.value?.trim();
      if (!v) { window.showToast?.('请输入谜底'); return; }
      overlay.style.display = 'none';
      resolve(v);
    };
  });
}

async function finishGame() {
  clearState(_state?.charId);
  updateBar();
}

async function beginGameAfterDice() {
  const charId = _state.charId;
  const stake = _state.stake;
  const first = _state.firstPlayer;
  const gameId = _state.game;

  _hooks.showTyping(true);
  try {
    if (gameId === 'pictionary') {
      _state.guesser = first;
      _state.drawer = first === 'user' ? 'char' : 'user';
      _state.maxGuesses = 5;
      _state.guessesLeft = 5;

      const r = await api.gameButler({
        action: 'pictionary_start', charId,
        payload: { drawer: _state.drawer, recentWords: _state.recentWords || [] },
      });
      _state.word = r.word;
      _state.recentWords = [...(_state.recentWords || []), r.word].slice(-8);
      if (_state.drawer === 'user') {
        _state.phase = 'upload_draw';
        await renderServerMessages(r.messages);
        await showPrivateWordPopup(r.word, '你要画的是');
      } else {
        _state.phase = 'guess';
        await renderServerMessages(r.messages);
      }
    } else if (gameId === 'ten_q') {
      _state.guesser = first;
      _state.questionsLeft = 10;
      _state.hiddenLog = [];
      _state.qaHistory = [];

      if (first === 'char') {
        const secret = await showUserSecretInput();
        _state.secret = secret;
        const r = await api.gameButler({
          action: 'ten_q_start', charId,
          payload: { guesser: 'char', userSecret: secret },
        });
        _state.charQuestion = r.charQuestion;
        _state.phase = 'char_qa';
        await renderServerMessages(r.messages);
      } else {
        const r = await api.gameButler({
          action: 'ten_q_start', charId,
          payload: { guesser: 'user' },
        });
        _state.secret = r.secret;
        _state.phase = 'user_ask';
        await renderServerMessages(r.messages);
      }
    } else if (gameId === 'truth') {
      const answerer = first;
      const r = await api.gameButler({
        action: 'truth_start', charId,
        payload: { answerer },
      });
      _state.question = r.question;
      _state.target = r.target;
      if (r.target === 'user') {
        _state.phase = 'answer';
        await renderServerMessages(r.messages);
      } else {
        await renderServerMessages(r.messages);
        const fin = await api.gameButler({ action: 'truth_finish_char', charId, payload: {} });
        await renderServerMessages(fin.messages);
        await finishGame();
        return;
      }
    } else if (gameId === 'quiz') {
      const subject = first;
      _state.quizTotal = 3;
      _state.quizRound = 1;
      _state.quizScoreUser = 0;
      _state.quizScoreChar = 0;
      _state.quizSubject = subject;
      const r = await api.gameButler({
        action: 'quiz_start', charId,
        payload: { subject },
      });
      _state.question = r.question;
      _state.target = r.target;
      _state.charAnswer = r.charAnswer || '';
      await renderServerMessages(r.messages);
      if (r.target === 'user') {
        _state.phase = 'judge';
        _hooks.showTyping(false);
        const correct = await showQuizJudgePopup();
        _hooks.showTyping(true);
        await handleQuizUserJudge(correct);
        return;
      }
      _state.phase = 'answer';
    }
    saveState();
    updateBar();
  } catch (e) {
    window.showToast?.(e.message || '游戏启动失败');
    clearState(charId);
  } finally {
    _hooks.showTyping(false);
  }
}

async function startGame(gameId, stake) {
  const charId = _hooks?.getCharId?.();
  if (!charId || _busy) return;

  _state = {
    active: true,
    charId,
    game: gameId,
    stake: stake || '',
    phase: 'dice',
    hiddenLog: [],
    qaHistory: [],
  };
  saveState();
  updateBar();

  await _hooks.appendSystem(`🎮 游戏助手：开始「${GAME_NAMES[gameId]}」${stake ? `，赌注：${stake}` : ''}。掷骰子吧，点数大的一方先手（负责猜/问/被考）`);
}

window.gameButlerRollDice = async function() {
  if (!_state?.active || _state.phase !== 'dice' || _busy) return;
  _busy = true;
  try {
    const uRoll = rollDice();
    const cRoll = rollDice();
    if (uRoll === cRoll) {
      await _hooks.displaySystem(`🎮 游戏助手：🎲 ${userName()} ${uRoll} · ${charName()} ${cRoll} · 平局，再掷一次！`);
      return;
    }
    const first = uRoll > cRoll ? 'user' : 'char';
    _state.userRoll = uRoll;
    _state.charRoll = cRoll;
    _state.firstPlayer = first;
    _state.phase = 'rolling';
    saveState();

    const roleHint = {
      pictionary: '猜',
      ten_q: '提问',
      truth: '先回答',
      quiz: '被考',
    }[_state.game] || '先手';

    await _hooks.appendSystem(
      `🎮 游戏助手：🎲 ${userName()} ${uRoll} · ${charName()} ${cRoll} · ${roleLabel(first)} 先手（${roleHint}）`
    );
    await beginGameAfterDice();
  } finally {
    _busy = false;
  }
};

async function handleQuizUserJudge(correct) {
  const charId = _state.charId;
  const fin = await api.gameButler({
    action: 'quiz_finish_user', charId,
    payload: {
      correct,
      round: _state.quizRound,
      totalRounds: _state.quizTotal,
      scoreChar: _state.quizScoreChar,
    },
  });
  await renderServerMessages(fin.messages);
  if (fin.finished) {
    await finishGame();
    return;
  }
  _state.quizScoreChar = fin.scoreChar ?? _state.quizScoreChar;
  _state.quizRound = (_state.quizRound || 1) + 1;
  const nextSubject = fin.nextSubject || 'char';
  const r = await api.gameButler({
    action: 'quiz_start', charId,
    payload: { subject: nextSubject },
  });
  _state.question = r.question;
  _state.target = r.target;
  _state.charAnswer = r.charAnswer || '';
  await renderServerMessages(r.messages);
  if (r.target === 'user') {
    _state.phase = 'judge';
    _hooks.showTyping(false);
    const ok = await showQuizJudgePopup();
    _hooks.showTyping(true);
    await handleQuizUserJudge(ok);
  } else {
    _state.phase = 'answer';
    saveState();
    updateBar();
  }
}

async function handleQuizCharAnswer(text) {
  const charId = _state.charId;
  const r = await api.gameButler({
    action: 'quiz_judge_char', charId,
    payload: {
      question: _state.question,
      answer: text,
      round: _state.quizRound,
      totalRounds: _state.quizTotal,
      scoreUser: _state.quizScoreUser,
    },
  });
  await renderServerMessages(r.messages);
  if (r.finished) {
    await finishGame();
    return;
  }
  _state.quizScoreUser = r.scoreUser ?? _state.quizScoreUser;
  _state.quizRound = (_state.quizRound || 1) + 1;
  const nextSubject = r.nextSubject || 'user';
  const next = await api.gameButler({
    action: 'quiz_start', charId,
    payload: { subject: nextSubject },
  });
  _state.question = next.question;
  _state.target = next.target;
  _state.charAnswer = next.charAnswer || '';
  await renderServerMessages(next.messages);
  if (next.target === 'user') {
    _state.phase = 'judge';
    _hooks.showTyping(false);
    const correct = await showQuizJudgePopup();
    _hooks.showTyping(true);
    await handleQuizUserJudge(correct);
  } else {
    _state.phase = 'answer';
    saveState();
    updateBar();
  }
}

async function handleUserMessage(text) {
  if (!_state?.active || !_hooks || _busy) return false;
  const charId = _hooks.getCharId();
  if (Number(charId) !== Number(_state.charId)) return false;

  if (_state.phase === 'dice') {
    window.showToast?.('请先掷骰子');
    return true;
  }

  _busy = true;
  await _hooks.showUserMessage(text);
  _hooks.showTyping(true);

  try {
    if (_state.game === 'pictionary' && _state.phase === 'guess' && _state.guesser === 'user') {
      const leftBefore = _state.guessesLeft ?? 0;
      const r = await api.gameButler({
        action: 'pictionary_judge',
        charId,
        payload: {
          word: _state.word,
          guess: text,
          stake: _state.stake,
          guessesLeft: Math.max(0, leftBefore - 1),
        },
      });
      await renderServerMessages(r.messages);
      if (r.finished) {
        await finishGame();
      } else {
        _state.guessesLeft = r.guessesLeft ?? leftBefore - 1;
        saveState();
        updateBar();
      }
    } else if (_state.game === 'ten_q' && _state.phase === 'user_ask' && _state.guesser === 'user') {
      const r = await api.gameButler({
        action: 'ten_q_ask',
        charId,
        payload: {
          secret: _state.secret,
          question: text,
          questionsLeft: _state.questionsLeft,
          stake: _state.stake,
          hiddenLog: _state.hiddenLog || [],
        },
      });
      _state.questionsLeft = r.questionsLeft ?? _state.questionsLeft;
      if (r.hidden && r.hiddenEntry) displayHiddenEntry(r.hiddenEntry);
      saveState();
      updateBar();
      if (r.messages?.length) await renderServerMessages(r.messages);
      if (r.finished) await finishGame();
    } else if (_state.game === 'ten_q' && _state.phase === 'char_qa' && _state.guesser === 'char') {
      const r = await api.gameButler({
        action: 'ten_q_char_turn',
        charId,
        payload: {
          secret: _state.secret,
          question: _state.charQuestion,
          userAnswer: text,
          questionsLeft: _state.questionsLeft,
          qaHistory: _state.qaHistory,
          stake: _state.stake,
        },
      });
      if (_state.charQuestion) {
        _state.qaHistory.push({ q: _state.charQuestion, a: text });
      }
      _state.questionsLeft = r.questionsLeft ?? _state.questionsLeft;
      _state.charQuestion = r.charQuestion || '';
      saveState();
      updateBar();
      await renderServerMessages(r.messages || []);
      if (r.finished) await finishGame();
    } else if (_state.game === 'truth' && _state.phase === 'answer') {
      const r = await api.gameButler({
        action: 'truth_judge',
        charId,
        payload: { question: _state.question, answer: text },
      });
      await renderServerMessages(r.messages);
      await finishGame();
    } else if (_state.game === 'quiz' && _state.phase === 'answer') {
      await handleQuizCharAnswer(text);
    } else if (_state.phase === 'upload_draw') {
      window.showToast?.('请先发送一张图片作为画');
      return true;
    } else {
      return false;
    }
    return true;
  } catch (e) {
    window.showToast?.(e.message || '游戏处理失败');
    return true;
  } finally {
    _hooks.showTyping(false);
    _busy = false;
  }
}

export async function onGameButlerImageUpload(imageUrl) {
  if (!_state?.active || _state.game !== 'pictionary' || _state.phase !== 'upload_draw') return false;
  if (_busy) return true;
  _busy = true;
  const charId = _state.charId;
  _hooks?.showTyping(true);
  try {
    await _hooks.showUserMessage?.('[图片]', 'image', imageUrl);
    const r = await api.gameButler({
      action: 'pictionary_char_guess',
      charId,
      payload: { word: _state.word, imageUrl, stake: _state.stake },
    });
    await renderServerMessages(r.messages);
    await finishGame();
    return true;
  } catch (e) {
    window.showToast?.(e.message || '猜画失败');
    return true;
  } finally {
    _hooks?.showTyping(false);
    _busy = false;
  }
}

export function bindGameButler(hooks) {
  _hooks = hooks;
}

export function isGameButlerActive(forCharId) {
  if (!_state?.active) {
    const cid = forCharId ?? _hooks?.getCharId?.();
    if (cid) {
      const saved = loadState(cid);
      if (saved?.active) {
        _state = saved;
        updateBar();
      }
    }
  }
  return _state?.active && Number(_state.charId) === Number(forCharId ?? _hooks?.getCharId?.());
}

export function restoreGameButlerBar(forCharId) {
  const saved = loadState(forCharId);
  if (saved?.active) {
    _state = saved;
    updateBar();
  } else {
    _state = null;
    updateBar();
  }
}

export async function onGameButlerUserSend(text) {
  if (!isGameButlerActive()) return false;
  return handleUserMessage(text);
}

window.exitGameButler = function() {
  if (!_state?.active) return;
  if (!confirm('确定退出当前游戏吗？')) return;
  clearState();
  _hooks?.appendSystem?.('🎮 游戏助手：游戏已取消');
  window.showToast?.('已退出游戏');
};

window.openGameButlerPanel = function() {
  const charId = _hooks?.getCharId?.();
  if (!charId) { window.showToast?.('请先选择角色'); return; }
  if (_hooks?.isDream?.()) { window.showToast?.('梦境中不可用'); return; }
  if (isGameButlerActive(charId)) {
    window.showToast?.('已有进行中的游戏');
    return;
  }
  // 与小剧场互斥
  if (document.getElementById('theater-bar')?.style.display === 'flex'
    || typeof window.isTheaterActiveNow === 'function' && window.isTheaterActiveNow()) {
    window.showToast?.('请先结束小剧场');
    return;
  }
  if (typeof window.setChatToolbarOpen === 'function') window.setChatToolbarOpen(false);
  else {
    const tb = document.getElementById('chat-toolbar');
    if (tb) tb.style.display = 'none';
    document.getElementById('chat-plus-btn')?.classList.remove('is-open');
  }
  window.closeEmojiPanel?.();
  document.getElementById('game-butler-overlay').style.display = 'flex';
};

window.closeGameButlerPanel = function() {
  document.getElementById('game-butler-overlay').style.display = 'none';
  window._gameButlerStakeGame = null;
  document.getElementById('game-butler-stake-step').style.display = 'none';
  document.getElementById('game-butler-pick-step').style.display = 'block';
};

window.pickGameButlerGame = function(gameId) {
  window._gameButlerStakeGame = gameId;
  document.getElementById('game-butler-pick-step').style.display = 'none';
  document.getElementById('game-butler-stake-step').style.display = 'block';
  const g = GAMES.find(x => x.id === gameId);
  const title = document.getElementById('game-butler-stake-title');
  if (title && g) title.textContent = `${g.emoji} ${g.name}`;
  const input = document.getElementById('game-butler-stake-input');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 100); }
};

window.confirmGameButlerStake = async function() {
  const gameId = window._gameButlerStakeGame;
  const stake = document.getElementById('game-butler-stake-input')?.value?.trim() || '';
  if (!gameId) return;
  window.closeGameButlerPanel();
  await startGame(gameId, stake);
};

export function initGameButlerUI() {
  const list = document.getElementById('game-butler-list');
  if (!list) return;
  list.innerHTML = GAMES.map(g => `
    <div onclick="pickGameButlerGame('${g.id}')" style="padding:14px;margin-bottom:10px;background:var(--bg-glass);border:1px solid var(--border);border-radius:14px;cursor:pointer">
      <div style="font-size:22px;margin-bottom:6px">${g.emoji}</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:4px">${escapeHtml(g.name)}</div>
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">${escapeHtml(g.desc)}</div>
    </div>`).join('');
}

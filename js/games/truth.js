/* 真心话 — 日常/NSFW · 掷骰 · 系统题库 · 通过/不通过 · 局内闲聊 */

import { pickTruthQuestion } from './truth-questions.js';
import { addGameTopic } from '../game-topics.js';

let _ctx = null;
let _contentMode = 'daily';
let _phase = 'roll';
let _busy = false;
let _userRoll = 0;
let _charRoll = 0;
let _activeRole = 'user';
let _question = '';
let _lastAnswer = '';
let _lastJudgeReason = '';
let _usedQuestions = [];
let _chatMessages = [];

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function charName() { return _ctx?.charName || 'TA'; }
function userName() { return _ctx?.userName || '你'; }

function judgeRole() { return _activeRole === 'user' ? 'char' : 'user'; }

function rollDice() {
  return Math.floor(Math.random() * 6) + 1;
}

function parseJudgeResult(text) {
  const raw = String(text || '').trim();
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const first = lines[0] || '';
  const pass = !/不通过|未通过|不过关|不合格|不行|不够|拒绝/.test(first)
    && (/通过|合格|可以|过关|OK|ok|✓/.test(first) || !first);
  let reason = '';
  if (!pass) {
    reason = lines.slice(1).join('\n').trim();
    if (!reason) reason = first.replace(/^不通过[：:，,\s]*/, '').trim();
    if (!reason || reason === first) reason = '回答不够具体或没有正面回应题目';
  }
  return { pass, reason };
}

function appendTruthChat(role, content) {
  const text = String(content || '').trim();
  if (!text) return;
  _chatMessages.push({ role, content: text });
  if (_chatMessages.length > 80) _chatMessages.shift();
}

function buildTruthChatContext() {
  const parts = [];
  if (_question) parts.push(`当前题目：${_question}`);
  if (_lastAnswer) parts.push(`最近回答（${_activeRole === 'user' ? userName() : charName()}）：${_lastAnswer}`);
  if (_lastJudgeReason) parts.push(`最近评判：${_lastJudgeReason}`);
  const recent = _chatMessages.slice(-16);
  if (recent.length) {
    parts.push('闲聊记录：');
    recent.forEach(m => {
      const who = m.role === 'user' ? userName() : (m.role === 'assistant' ? charName() : '系统');
      parts.push(`${who}：${m.content}`);
    });
  }
  return parts.join('\n');
}

function renderChatBlock() {
  const msgs = _chatMessages.map(m => {
    if (m.role === 'system') {
      return `<div style="font-size:12px;color:var(--text-secondary);text-align:center;margin:8px 0;line-height:1.5">${escapeHtml(m.content)}</div>`;
    }
    const isUser = m.role === 'user';
    return `<div style="margin-bottom:8px;display:flex;${isUser ? 'justify-content:flex-end' : 'justify-content:flex-start'}">
      <div style="max-width:88%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.55;
        ${isUser ? 'background:var(--theme);color:#fff;border-bottom-right-radius:4px' : 'background:var(--bg-secondary);color:var(--text-primary);border-bottom-left-radius:4px'}">
        ${escapeHtml(m.content)}
      </div>
    </div>`;
  }).join('');

  return `
    <div style="margin:0 12px 16px;padding:12px;background:var(--bg-glass);border:1px solid var(--border);border-radius:14px">
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">💭 局内闲聊 · 可一直聊</div>
      <div id="truth-chat-log" style="max-height:200px;overflow-y:auto;margin-bottom:8px;min-height:${msgs ? '40px' : '0'}">${msgs || '<div style="font-size:12px;color:var(--text-secondary);text-align:center;padding:8px">顺着题目和回答聊…</div>'}</div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <textarea id="truth-chat-input" class="input" rows="2" placeholder="顺着聊…" style="flex:1;font-size:13px;resize:none"></textarea>
        <button class="btn btn-primary btn-sm" style="flex-shrink:0" onclick="truthSendChat()" ${_busy ? 'disabled' : ''}>发送</button>
      </div>
    </div>`;
}

function scrollTruthChat() {
  requestAnimationFrame(() => {
    const log = document.getElementById('truth-chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  });
}

function drawQuestion() {
  _question = pickTruthQuestion(_contentMode, _usedQuestions);
  _usedQuestions.push(_question);
  if (_usedQuestions.length > 24) _usedQuestions.shift();
  _lastAnswer = '';
}

function setActiveFromRolls() {
  if (_userRoll < _charRoll) _activeRole = 'user';
  else if (_charRoll < _userRoll) _activeRole = 'char';
  else _activeRole = Math.random() < 0.5 ? 'user' : 'char';
}

function renderTruth() {
  const el = document.getElementById('truth-content');
  if (!el) return;

  const cn = escapeHtml(charName());
  const un = escapeHtml(userName());
  const avatar = _ctx?.charAvatar || '';
  const modeLabel = _contentMode === 'nsfw' ? '🔞 NSFW向' : '🌸 日常向';

  if (_phase === 'roll') {
    el.innerHTML = `
      <div style="padding:32px 20px;text-align:center">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">${modeLabel}</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:20px">先掷骰子，点数小的一方先抽题</div>
        <button class="btn btn-primary" style="min-width:180px" onclick="truthRollDice()" ${_busy ? 'disabled' : ''}>🎲 一起掷骰子</button>
      </div>`;
    return;
  }

  if (_phase === 'rolling') {
    el.innerHTML = `<div style="text-align:center;padding:48px 24px;color:var(--text-secondary)">掷骰中…</div>`;
    return;
  }

  const activeLabel = _activeRole === 'user' ? un : cn;

  let actionBlock = '';
  if (_phase === 'answer') {
    const failHint = _lastJudgeReason
      ? `<div style="padding:10px 12px;background:rgba(224,85,85,0.12);border:1px solid rgba(224,85,85,0.25);border-radius:10px;font-size:13px;line-height:1.6;margin-bottom:10px;color:#e05555"><strong>未通过：</strong>${escapeHtml(_lastJudgeReason)}</div>`
      : '';
    if (_activeRole === 'user') {
      actionBlock = `
        ${failHint}
        <textarea id="truth-answer-input" class="input" rows="4" placeholder="写下你的回答…" style="width:100%;font-size:14px;resize:none;box-sizing:border-box"></textarea>
        <button class="btn btn-primary btn-sm" style="width:100%;margin-top:10px" onclick="truthSubmitAnswer()" ${_busy ? 'disabled' : ''}>提交回答</button>`;
    } else {
      actionBlock = `${failHint}<div style="font-size:14px;color:var(--text-secondary);line-height:1.7">${cn} 正在回答…</div>`;
    }
  } else if (_phase === 'judge') {
    if (judgeRole() === 'user') {
      actionBlock = `
        <div style="padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:10px;font-size:14px;line-height:1.65;margin-bottom:12px">${escapeHtml(_lastAnswer)}</div>
        <textarea id="truth-judge-reason" class="input" rows="2" placeholder="若不通过，请写明原因（通过可留空）" style="width:100%;font-size:13px;resize:none;box-sizing:border-box;margin-bottom:10px"></textarea>
        <div style="display:flex;gap:10px">
          <button class="btn btn-primary btn-sm" style="flex:1" onclick="truthUserJudge(true)" ${_busy ? 'disabled' : ''}>✓ 通过</button>
          <button class="btn btn-ghost btn-sm" style="flex:1" onclick="truthUserJudge(false)" ${_busy ? 'disabled' : ''}>✗ 不通过</button>
        </div>`;
    } else {
      actionBlock = `<div style="font-size:14px;color:var(--text-secondary)">${cn} 正在评判…</div>`;
    }
  }

  el.innerHTML = `
    <div style="padding:12px 16px 0;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:rgba(180,140,255,0.15);color:var(--theme)">${modeLabel}</span>
      <span style="font-size:12px;color:var(--text-secondary)">${un} 🎲${_userRoll} · ${cn} 🎲${_charRoll}</span>
    </div>

    <div style="margin:12px;padding:16px;background:var(--bg-glass);border:1px solid var(--border);border-radius:14px">
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">💬 系统题目 · 回答者：${activeLabel}</div>
      <div style="font-size:15px;line-height:1.65;font-weight:500;color:var(--text-primary)">${escapeHtml(_question)}</div>
    </div>

    <div style="padding:0 12px 12px">
      ${actionBlock}
    </div>

    ${_phase === 'judge' && judgeRole() === 'char' ? `
      <div style="padding:0 12px 12px;display:flex;gap:8px;align-items:flex-start">
        <span style="width:28px;height:28px;border-radius:50%;background:var(--theme-light);overflow:hidden;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          ${avatar ? `<img src="${escapeHtml(avatar)}" style="width:100%;height:100%;object-fit:cover">` : cn.slice(0, 1)}
        </span>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.6">等待 ${cn} 评判你的回答…</div>
      </div>` : ''}

    ${renderChatBlock()}
  `;
  scrollTruthChat();
}

async function fetchCharAnswer() {
  const r = await _ctx.playGame({
    gameType: 'truth_answer',
    charId: _ctx.charId,
    contentMode: _contentMode,
    userInput: `题目：${_question}\n请以角色身份坦诚回答。`,
    history: [],
  });
  return (r?.reply || '').trim();
}

async function fetchCharJudge() {
  const r = await _ctx.playGame({
    gameType: 'truth_judge',
    charId: _ctx.charId,
    contentMode: _contentMode,
    userInput: `题目：${_question}\n${userName()}的回答：${_lastAnswer}\n请评判是否通过；若不通过必须写明原因。`,
    history: [],
  });
  return parseJudgeResult(r?.reply || '');
}

async function fetchChatReply(userText) {
  const hist = _chatMessages.filter(m => m.role !== 'system').slice(-14).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));
  const r = await _ctx.playGame({
    gameType: 'truth_chat',
    charId: _ctx.charId,
    contentMode: _contentMode,
    userInput: userText,
    history: hist,
    gameContext: buildTruthChatContext(),
  });
  return (r?.reply || '').trim();
}

function handleJudgeResult(pass, reason, judgeName) {
  if (pass) {
    recordTruthTopic();
    _lastJudgeReason = '';
    appendTruthChat('system', `${judgeName}：通过`);
    window.showToast?.(`${judgeName}：通过 · 已收录到游戏话题`);
    afterPass();
  } else {
    _lastJudgeReason = reason || '回答未通过';
    appendTruthChat('system', `${judgeName}：不通过。原因：${_lastJudgeReason}`);
    window.showToast?.(`${judgeName}：不通过 — ${_lastJudgeReason}`);
    afterFail();
  }
}

function swapActive() {
  _activeRole = _activeRole === 'user' ? 'char' : 'user';
}

function recordTruthTopic() {
  if (!_ctx?.charId || !_question || !_lastAnswer) return;
  addGameTopic(_ctx.charId, {
    game: 'truth_dare',
    mode: _contentMode,
    question: _question,
    userAnswer: _activeRole === 'user' ? _lastAnswer : '',
    charAnswer: _activeRole === 'char' ? _lastAnswer : '',
    userName: userName(),
    charName: charName(),
  });
}

function afterPass() {
  swapActive();
  drawQuestion();
  _phase = 'answer';
  appendTruthChat('system', `—— 换 ${_activeRole === 'user' ? userName() : charName()} 抽题 ——`);
  renderTruth();
  if (_activeRole === 'char') beginCharAnswer();
}

function afterFail() {
  _phase = 'answer';
  renderTruth();
  if (_activeRole === 'char') beginCharAnswer();
}

async function beginCharAnswer() {
  _busy = true;
  renderTruth();
  try {
    _lastAnswer = await fetchCharAnswer();
    if (!_lastAnswer) throw new Error('回答生成失败');
    appendTruthChat('assistant', _lastAnswer);
    _phase = 'judge';
    renderTruth();
    if (judgeRole() === 'char') {
      const { pass, reason } = await fetchCharJudge();
      handleJudgeResult(pass, reason, charName());
    }
  } catch (e) {
    window.showToast?.(e.message || '生成失败');
    _phase = 'answer';
    renderTruth();
  } finally {
    _busy = false;
    renderTruth();
  }
}

export function initTruthGame(ctx) {
  _ctx = ctx;
  _contentMode = ctx.contentMode || 'daily';
  _phase = 'roll';
  _busy = false;
  _userRoll = 0;
  _charRoll = 0;
  _usedQuestions = [];
  _lastAnswer = '';
  _lastJudgeReason = '';
  _chatMessages = [];
  document.getElementById('truth-session').style.display = 'flex';
  renderTruth();
}

export function bindTruthGlobals(ctx) {
  _ctx = ctx;

  window.truthRollDice = async function() {
    if (_busy || _phase !== 'roll') return;
    _busy = true;
    _phase = 'rolling';
    renderTruth();
    await new Promise(r => setTimeout(r, 700));
    _userRoll = rollDice();
    _charRoll = rollDice();
    setActiveFromRolls();
    drawQuestion();
    _phase = 'answer';
    _busy = false;
    appendTruthChat('system', `🎲 ${userName()} ${_userRoll} · ${charName()} ${_charRoll} · ${_activeRole === 'user' ? userName() : charName()} 先抽题`);
    renderTruth();
    window.showToast?.(`${_activeRole === 'user' ? userName() : charName()} 点数更小，先抽题`);
    if (_activeRole === 'char') beginCharAnswer();
  };

  window.truthSubmitAnswer = async function() {
    if (_busy || _phase !== 'answer' || _activeRole !== 'user') return;
    const text = document.getElementById('truth-answer-input')?.value.trim();
    if (!text) { window.showToast?.('请先回答'); return; }
    _lastAnswer = text;
    appendTruthChat('user', text);
    _phase = 'judge';
    renderTruth();
    if (judgeRole() === 'char') {
      _busy = true;
      renderTruth();
      try {
        const { pass, reason } = await fetchCharJudge();
        handleJudgeResult(pass, reason, charName());
      } catch (e) {
        window.showToast?.(e.message || '评判失败');
      } finally {
        _busy = false;
        renderTruth();
      }
    }
  };

  window.truthUserJudge = function(pass) {
    if (_busy || _phase !== 'judge' || judgeRole() !== 'user') return;
    if (pass) {
      handleJudgeResult(true, '', userName());
      return;
    }
    const reason = document.getElementById('truth-judge-reason')?.value.trim();
    if (!reason) { window.showToast?.('不通过必须写明原因'); return; }
    handleJudgeResult(false, reason, userName());
  };

  window.truthSendChat = async function() {
    if (_busy) return;
    const input = document.getElementById('truth-chat-input');
    const text = input?.value.trim();
    if (!text) return;
    input.value = '';
    appendTruthChat('user', text);
    _busy = true;
    renderTruth();
    try {
      const reply = await fetchChatReply(text);
      if (reply) appendTruthChat('assistant', reply);
    } catch (e) {
      window.showToast?.(e.message || '发送失败');
    } finally {
      _busy = false;
      renderTruth();
    }
  };
}

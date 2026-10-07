import { pickNsfwKinkHint } from './truth-questions.js';
import { addGameTopic } from '../game-topics.js';

const CATEGORIES = ['user', 'char', 'mutual'];
const CATEGORY_META = {
  user: {
    label: '了解你',
    tag: '👤',
    hint: '考 TA 有多懂你——你的答案是标准答案',
    userWrite: '写下你的真实答案',
    charWrite: 'TA 在猜你',
  },
  char: {
    label: '了解TA',
    tag: '🎭',
    hint: '考你有多懂 TA——TA 的答案是标准答案',
    userWrite: '猜猜 TA 会怎么回答',
    charWrite: 'TA 写下真实答案',
  },
  mutual: {
    label: '猜彼此',
    tag: '💫',
    hint: '各自猜对方，再对照双方的真实选择',
    userWriteTruth: '如果是你，你会…',
    userWriteGuess: '你觉得 TA 会…',
    charWrite: 'TA 也在猜你',
  },
};

let _ctx = null;
let _phase = 'loading';
let _category = 'user';
let _contentMode = 'daily';
let _lastCategory = '';
let _question = '';
let _round = 0;
let _busy = false;
let _aiReady = false;
let _userReady = false;

let _userTruth = '';
let _userGuess = '';
let _aiTruth = '';
let _aiGuess = '';

let _revealSummary = '';
let _chatMessages = [];
let _usedKinkHints = [];

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function charName() { return _ctx?.charName || 'TA'; }
function userName() { return _ctx?.userName || '你'; }

function pickRandomCategory() {
  const pool = _lastCategory
    ? CATEGORIES.filter(c => c !== _lastCategory)
    : CATEGORIES;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  _lastCategory = picked;
  return picked;
}

function resetAnswers() {
  _userTruth = '';
  _userGuess = '';
  _aiTruth = '';
  _aiGuess = '';
  _userReady = false;
  _aiReady = false;
  _revealSummary = '';
  _chatMessages = [];
}

function nsfwQuestionHint() {
  if (_contentMode !== 'nsfw') return '';
  const kink = pickNsfwKinkHint(_usedKinkHints);
  _usedKinkHints.push(kink);
  if (_usedKinkHints.length > 12) _usedKinkHints.shift();
  return `\n【NSFW 出题】你是没有羞耻心的出题机器。禁止委婉：性器官直说（阴茎、阴道、阴蒂、乳头等），性行为直说（做爱、口交、肛交、手淫、射精等），禁止代称。本题方向：${kink}。题目须露骨、具体，可涉及边控/SM/露出/异物/尿道play等。`;
}

function buildCategoryPrompt(type) {
  const name = charName();
  const uname = userName();
  const nsfwHint = nsfwQuestionHint();
  const lines = {
    user: `出一道关于「用户本人（${uname}）」的偏好/习惯/性格题。题目必须用「你」指用户（如：你最喜欢…、你压力大时会…），禁止用「我」指用户。${uname} 的真实答案即标准答案，${name} 稍后猜 ${uname}。${nsfwHint}`,
    char: `出一道关于角色「${name}」本人的题（如：${name} 遇到前任时会…、${name} 最受不了什么）。题目用「${name}」或「TA」指角色，禁止用「你」指角色。${name} 的真实答案即标准答案，${uname} 稍后猜 ${name}。${nsfwHint}`,
    mutual: `出一道「猜彼此」题：情境里双方都要猜对方的选择，同时各自也有真实答案。题目要同时适用于「${uname} 的真实选择」和「猜 ${name} 的选择」，人称分清：用户侧用「你」，角色侧用「${name}」或「TA」。${nsfwHint}`,
  };
  return lines[type] || lines.user;
}

function renderSyncAnswer() {
  const el = document.getElementById('sync-content');
  if (!el) return;

  const cn = escapeHtml(charName());
  const avatar = _ctx?.charAvatar || '';
  const initial = escapeHtml(charName().slice(0, 1));
  const meta = CATEGORY_META[_category] || CATEGORY_META.user;
  const modeLabel = _contentMode === 'nsfw' ? '🔞 NSFW' : '🌸 日常';

  if (_phase === 'loading') {
    el.innerHTML = `<div style="text-align:center;padding:48px 24px;color:var(--text-secondary)">
      <div style="font-size:32px;margin-bottom:12px">🎭</div>
      <div>旁白出题中…</div>
    </div>`;
    return;
  }

  const blur = _phase !== 'revealed' && _phase !== 'chatting';
  const charSideText = !_aiReady
    ? (_phase === 'writing' ? '书写中…' : '…')
    : _category === 'user'
      ? _aiGuess
      : _category === 'char'
        ? _aiTruth
        : `${_aiGuess ? `猜你：${_aiGuess}` : ''}${_aiGuess && _aiTruth ? '\n' : ''}${_aiTruth ? `自己会：${_aiTruth}` : ''}`;

  let userFields = '';
  if (_phase === 'writing') {
    if (_category === 'mutual') {
      userFields = `
        <textarea id="sync-user-truth" class="input" placeholder="${meta.userWriteTruth}" rows="2" style="width:100%;font-size:13px;resize:none;box-sizing:border-box;margin-bottom:6px"></textarea>
        <textarea id="sync-user-guess" class="input" placeholder="${meta.userWriteGuess}" rows="2" style="width:100%;font-size:13px;resize:none;box-sizing:border-box"></textarea>
      `;
    } else {
      userFields = `<textarea id="sync-user-input" class="input" placeholder="${meta.userWrite}" rows="3" style="width:100%;font-size:14px;resize:none;box-sizing:border-box"></textarea>`;
    }
    userFields += `<button class="btn btn-primary btn-sm" style="width:100%;margin-top:8px" onclick="syncSubmitUser()" ${_userReady ? 'disabled' : ''}>${_userReady ? '✓ 已写好' : '写好了'}</button>`;
  } else {
    const userDisplay = _category === 'mutual'
      ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">你的真实</div><div style="margin-bottom:8px">${escapeHtml(_userTruth)}</div>
         <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">你猜 TA</div><div>${escapeHtml(_userGuess)}</div>`
      : _category === 'user'
        ? escapeHtml(_userTruth)
        : escapeHtml(_userGuess);
    userFields = `<div style="font-size:14px;line-height:1.6;${blur && _userReady ? 'filter:blur(6px);user-select:none;color:var(--text-secondary)' : 'color:var(--text-primary)'}">${_userReady ? userDisplay : '…'}</div>
      ${_phase === 'ready' && _userReady ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:6px">已封存 ✓</div>' : ''}`;
  }

  let revealBlock = '';
  if (_phase === 'revealed' || _phase === 'chatting') {
    revealBlock = buildRevealPanel(cn, avatar, initial);
  }

  let chatBlock = '';
  if (_phase === 'chatting') {
    chatBlock = `
      <div style="margin:0 12px 8px;padding:10px 12px;background:var(--bg-glass);border:1px solid var(--border);border-radius:12px;max-height:220px;overflow-y:auto" id="sync-chat-log">
        ${_chatMessages.map(m => `
          <div style="margin-bottom:8px;display:flex;${m.role === 'user' ? 'justify-content:flex-end' : 'justify-content:flex-start'}">
            <div style="max-width:88%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.55;
              ${m.role === 'user' ? 'background:var(--theme);color:#fff;border-bottom-right-radius:4px' : 'background:var(--bg-secondary);color:var(--text-primary);border-bottom-left-radius:4px'}">
              ${escapeHtml(m.content)}
            </div>
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;padding:0 12px 16px;align-items:flex-end">
        <textarea id="sync-chat-input" class="input" placeholder="接着聊…" rows="2" style="flex:1;font-size:14px;resize:none"></textarea>
        <button class="btn btn-primary btn-sm" style="flex-shrink:0" onclick="syncSendChat()" ${_busy ? 'disabled' : ''}>发送</button>
      </div>
    `;
  }

  el.innerHTML = `
    <div style="padding:16px;margin:12px;background:linear-gradient(135deg,rgba(200,160,255,0.12),rgba(160,200,255,0.1));border:1px solid rgba(180,160,255,0.35);border-radius:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--text-secondary);letter-spacing:1px">🎙️ 旁白 · 第 ${_round} 题</span>
        <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:rgba(180,140,255,0.2);color:var(--theme)">${meta.tag} ${meta.label}</span>
        <span style="font-size:11px;padding:2px 8px;border-radius:99px;background:rgba(255,255,255,0.06);color:var(--text-secondary)">${modeLabel}</span>
      </div>
      <div style="font-size:15px;line-height:1.65;color:var(--text-primary);font-weight:500;margin-bottom:6px">${escapeHtml(_question)}</div>
      <div style="font-size:12px;color:var(--text-secondary)">${meta.hint}</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 12px">
      <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:12px;padding:12px;min-height:120px">
        <div style="font-size:12px;color:var(--theme);margin-bottom:8px;font-weight:600">你的答案</div>
        ${userFields}
      </div>
      <div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:12px;padding:12px;min-height:120px">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;font-weight:600;display:flex;align-items:center;gap:6px">
          <span style="width:20px;height:20px;border-radius:50%;background:var(--theme-light);overflow:hidden;display:inline-flex;align-items:center;justify-content:center;font-size:10px">
            ${avatar ? `<img src="${escapeHtml(avatar)}" style="width:100%;height:100%;object-fit:cover">` : initial}
          </span>
          ${cn}
        </div>
        <div style="font-size:13px;line-height:1.6;white-space:pre-wrap;${blur ? 'filter:blur(6px);user-select:none;color:var(--text-secondary)' : 'color:var(--text-primary)'}">${escapeHtml(charSideText)}</div>
        ${_phase === 'ready' && _aiReady ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:6px">已封存 ✓</div>' : ''}
      </div>
    </div>

    ${_phase === 'ready' ? `
      <div style="padding:16px 12px;text-align:center">
        <button class="btn btn-primary" style="min-width:160px;font-size:15px" onclick="syncReveal()">一起翻开 ✨</button>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:8px">双方答案已写好，点击同时公开</div>
      </div>
    ` : ''}

    ${revealBlock}

    ${_phase === 'revealed' ? `
      <div style="padding:8px 12px 12px;text-align:center;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="syncStartChat()">💬 接着聊</button>
        <button class="btn btn-ghost btn-sm" onclick="syncNextRound()">下一题 →</button>
      </div>
    ` : ''}

    ${chatBlock}

    ${_phase === 'chatting' ? `
      <div style="padding:4px 12px 16px;text-align:center">
        <button class="btn btn-ghost btn-sm" onclick="syncNextRound()">聊够了，下一题 →</button>
      </div>
    ` : ''}
  `;

  if (_phase === 'chatting') {
    const log = document.getElementById('sync-chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  }
}

function buildRevealPanel(cn, avatar, initial) {
  let compareHtml = '';
  if (_category === 'user') {
    compareHtml = `
      <div style="font-size:13px;line-height:1.7">
        <div><strong>你的真实答案：</strong>${escapeHtml(_userTruth)}</div>
        <div style="margin-top:8px"><strong>${cn} 猜你：</strong>${escapeHtml(_aiGuess)}</div>
      </div>`;
  } else if (_category === 'char') {
    compareHtml = `
      <div style="font-size:13px;line-height:1.7">
        <div><strong>${cn} 的真实答案：</strong>${escapeHtml(_aiTruth)}</div>
        <div style="margin-top:8px"><strong>你猜 TA：</strong>${escapeHtml(_userGuess)}</div>
      </div>`;
  } else {
    compareHtml = `
      <div style="font-size:13px;line-height:1.7;display:grid;gap:10px">
        <div style="padding:10px;background:rgba(255,255,255,0.04);border-radius:8px">
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">关于 ${cn}</div>
          <div>真实：${escapeHtml(_aiTruth)}</div>
          <div style="margin-top:4px">你猜：${escapeHtml(_userGuess)}</div>
        </div>
        <div style="padding:10px;background:rgba(255,255,255,0.04);border-radius:8px">
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">关于你</div>
          <div>真实：${escapeHtml(_userTruth)}</div>
          <div style="margin-top:4px">${cn} 猜：${escapeHtml(_aiGuess)}</div>
        </div>
      </div>`;
  }

  return `
    <div style="margin:12px;padding:14px;background:var(--bg-glass);border:1px solid var(--border);border-radius:12px">
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px">📊 翻牌结果</div>
      ${compareHtml}
      ${_revealSummary ? `
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-start">
          <span style="width:28px;height:28px;border-radius:50%;background:var(--theme-light);overflow:hidden;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            ${avatar ? `<img src="${escapeHtml(avatar)}" style="width:100%;height:100%;object-fit:cover">` : initial}
          </span>
          <div style="font-size:14px;line-height:1.65;color:var(--text-primary)">${escapeHtml(_revealSummary)}</div>
        </div>
      ` : ''}
    </div>`;
}

function buildRevealContext() {
  const name = charName();
  const uname = userName();
  if (_category === 'user') {
    return `类别：了解用户\n题目：${_question}\n${uname}真实答案：${_userTruth}\n${name}猜测${uname}：${_aiGuess}`;
  }
  if (_category === 'char') {
    return `类别：了解角色\n题目：${_question}\n${name}真实答案：${_aiTruth}\n${uname}猜测${name}：${_userGuess}`;
  }
  return `类别：猜彼此\n题目：${_question}\n${uname}真实：${_userTruth}；${uname}猜${name}：${_userGuess}\n${name}真实：${_aiTruth}；${name}猜${uname}：${_aiGuess}`;
}

function recordSyncTopic() {
  if (!_ctx?.charId || !_question) return;
  const un = userName();
  const cn = charName();
  let userAnswer = '';
  let charAnswer = '';
  if (_category === 'user') {
    userAnswer = _userTruth;
    charAnswer = _aiGuess;
  } else if (_category === 'char') {
    userAnswer = _userGuess;
    charAnswer = _aiTruth;
  } else {
    userAnswer = `真实：${_userTruth}；猜${cn}：${_userGuess}`;
    charAnswer = `真实：${_aiTruth}；猜${un}：${_aiGuess}`;
  }
  addGameTopic(_ctx.charId, {
    game: 'sync_answer',
    mode: _contentMode,
    question: _question,
    userAnswer,
    charAnswer,
    userName: un,
    charName: cn,
    category: CATEGORY_META[_category]?.label || '',
  });
}

async function fetchQuestion() {
  _phase = 'loading';
  renderSyncAnswer();
  const prev = _ctx.getRecentQuestions?.() || [];
  const avoid = prev.length ? `\n避免与这些重复：${prev.slice(-6).join('；')}` : '';
  const r = await _ctx.playGame({
    gameType: 'sync_answer_question',
    charId: _ctx.charId,
    contentMode: _contentMode,
    userInput: `【题目类别：${CATEGORY_META[_category].label}】\n${buildCategoryPrompt(_category)}${_round <= 1 ? '\n开始游戏，出第一题' : `\n出第 ${_round} 题`}${avoid}`,
    history: [],
  });
  _question = (r?.reply || '').trim().replace(/^["「]|["」]$/g, '').replace(/^题目[：:]\s*/, '');
  if (!_question) throw new Error('没有获取到题目');
  _ctx.pushQuestion?.(_question);
}

async function fetchAiAnswers() {
  const name = charName();
  const uname = userName();
  const q = `题目：${_question}`;

  if (_category === 'user') {
    const r = await _ctx.playGame({
      gameType: 'sync_answer_write',
      charId: _ctx.charId,
      contentMode: _contentMode,
      userInput: `${q}\n【模式：猜用户】请猜测「${uname}」会怎么回答。用「你…」或第三人称指用户，禁止用「我」指用户（一句话，5-25字）`,
      history: [],
    });
    _aiGuess = (r?.reply || '').trim();
    _aiReady = !!_aiGuess;
    return;
  }

  if (_category === 'char') {
    const r = await _ctx.playGame({
      gameType: 'sync_answer_write',
      charId: _ctx.charId,
      contentMode: _contentMode,
      userInput: `${q}\n【模式：角色真答案】以角色「${name}」的第一人称写「我…」的真实答案（标准答案，一句话）`,
      history: [],
    });
    _aiTruth = (r?.reply || '').trim();
    _aiReady = !!_aiTruth;
    return;
  }

  const [guessR, truthR] = await Promise.all([
    _ctx.playGame({
      gameType: 'sync_answer_write',
      charId: _ctx.charId,
      contentMode: _contentMode,
      userInput: `${q}\n【模式：猜用户】猜猜「${uname}」在这道题里的真实选择。用「你…」指用户，禁止「我」指用户（一句话）`,
      history: [],
    }),
    _ctx.playGame({
      gameType: 'sync_answer_write',
      charId: _ctx.charId,
      contentMode: _contentMode,
      userInput: `${q}\n【模式：角色真答案】若是角色「${name}」，用第一人称「我…」写真实选择（与用户猜你无关，一句话）`,
      history: [],
    }),
  ]);
  _aiGuess = (guessR?.reply || '').trim();
  _aiTruth = (truthR?.reply || '').trim();
  _aiReady = !!_aiGuess && !!_aiTruth;
}

async function fetchReaction() {
  const r = await _ctx.playGame({
    gameType: 'sync_answer_react',
    charId: _ctx.charId,
    contentMode: _contentMode,
    userInput: `${buildRevealContext()}\n请根据翻牌结果给反应（2-4句）。分清「你」指${userName()}、「我」指${charName()}；不要判断对错`,
    history: [],
  });
  _revealSummary = (r?.reply || '').trim();
}

async function fetchChatReply(userText) {
  const hist = _chatMessages.slice(-14).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));
  const r = await _ctx.playGame({
    gameType: 'sync_answer_chat',
    charId: _ctx.charId,
    contentMode: _contentMode,
    userInput: userText,
    history: hist,
    gameContext: buildRevealContext(),
  });
  return (r?.reply || '').trim();
}

export function initSyncAnswer(ctx) {
  _ctx = ctx;
  _contentMode = ctx.contentMode || 'daily';
  _usedKinkHints = [];
  _phase = 'loading';
  _round = 0;
  _busy = false;
  _lastCategory = '';
  resetAnswers();
  document.getElementById('sync-session').style.display = 'flex';
  syncNextRound();
}

export function bindSyncAnswerGlobals(ctx) {
  _ctx = ctx;

  window.syncSubmitUser = function() {
    if (_busy || _phase !== 'writing' || _userReady) return;

    if (_category === 'mutual') {
      const truth = document.getElementById('sync-user-truth')?.value.trim();
      const guess = document.getElementById('sync-user-guess')?.value.trim();
      if (!truth || !guess) { window.showToast?.('请填写「你的真实」和「你猜 TA」'); return; }
      _userTruth = truth;
      _userGuess = guess;
    } else if (_category === 'user') {
      const text = document.getElementById('sync-user-input')?.value.trim();
      if (!text) { window.showToast?.('先写下你的真实答案'); return; }
      _userTruth = text;
    } else {
      const text = document.getElementById('sync-user-input')?.value.trim();
      if (!text) { window.showToast?.('先写下你的猜测'); return; }
      _userGuess = text;
    }

    _userReady = true;
    renderSyncAnswer();
    if (_aiReady) {
      _phase = 'ready';
      renderSyncAnswer();
    }
  };

  window.syncReveal = async function() {
    if (_busy || _phase !== 'ready') return;
    _busy = true;
    _phase = 'revealed';
    renderSyncAnswer();
    try {
      await fetchReaction();
    } catch (e) {
      _revealSummary = '（反应生成失败：' + e.message + '）';
    }
    recordSyncTopic();
    window.showToast?.('已收录到游戏话题');
    _busy = false;
    renderSyncAnswer();
  };

  window.syncStartChat = function() {
    if (_phase !== 'revealed') return;
    _phase = 'chatting';
    renderSyncAnswer();
  };

  window.syncSendChat = async function() {
    if (_busy || _phase !== 'chatting') return;
    const input = document.getElementById('sync-chat-input');
    const text = input?.value.trim();
    if (!text) return;
    input.value = '';
    _chatMessages.push({ role: 'user', content: text });
    _busy = true;
    renderSyncAnswer();
    try {
      const reply = await fetchChatReply(text);
      if (reply) _chatMessages.push({ role: 'assistant', content: reply });
    } catch (e) {
      window.showToast?.(e.message || '发送失败');
    }
    _busy = false;
    renderSyncAnswer();
  };

  window.syncNextRound = async function() {
    if (_busy) return;
    _busy = true;
    _round++;
    _category = pickRandomCategory();
    resetAnswers();
    _phase = 'loading';
    renderSyncAnswer();
    try {
      await fetchQuestion();
      _phase = 'writing';
      renderSyncAnswer();
      fetchAiAnswers().then(() => {
        if (_userReady) _phase = 'ready';
        renderSyncAnswer();
      }).catch(e => {
        window.showToast?.(e.message || 'AI 答案失败');
      });
    } catch (e) {
      window.showToast?.(e.message || '出题失败');
      _phase = 'writing';
      _question = _category === 'char'
        ? `${charName()} 压力大时最先做什么？`
        : _category === 'mutual'
          ? '世界末日只能带一样东西，你觉得对方会带什么？'
          : '你最喜欢吃的零食是？';
      renderSyncAnswer();
    } finally {
      _busy = false;
    }
  };
}

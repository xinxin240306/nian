/* 五子棋 — 标准无禁手 · 15×15 · 交叉点落子 · 精确五连判定 · 对战 AI
 * 旁白：事件触发 + 配额冷却（默认安静/偶尔）；闲聊：用户开口才答 */

const SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

const DENSITY_KEY = 'nian_gomoku_density';
const DENSITY_OPTS = {
  quiet: { label: '安静', maxBanter: 0, cooldown: 99, llmChance: 0 },
  occasional: { label: '偶尔', maxBanter: 5, cooldown: 4, llmChance: 0.28 },
  chatty: { label: '话多', maxBanter: 9, cooldown: 2, llmChance: 0.5 },
};

const BANTER_TEMPLATES = {
  open: ['开了。', '慢慢来。', '我看着。', '嗯，开始吧。'],
  block: ['挡得好。', '差一点。', '这手稳。', '嗯，看见了。'],
  threat: ['有点紧了。', '局面活了。', '认真一点。', '这手有味道。'],
  undo: ['改一手也行。', '嗯，重来。', '没事。'],
  end_win: ['这局你赢了。', '漂亮，是你的。', '下得漂亮。'],
  end_lose: ['这局我赢了。', '下完了。', '再来一局？'],
  end_draw: ['和了。', '谁也没压过谁。', '平手也不错。'],
};

let _ctx = null;
let _board = null;
let _moves = [];
let _turn = BLACK;
let _playerColor = BLACK;
let _mode = 'ai'; // ai | local
let _winner = null;
let _winLine = null;
let _lastMove = null;
let _busy = false;
let _hover = null;
let _canvas = null;
let _dpr = 1;
let _cell = 0;
let _pad = 0;
let _thinkingTimer = null;

let _density = 'occasional';
let _chatMsgs = []; // { role, content, kind }
let _chatBusy = false;
let _banterCount = 0;
let _lastBanterAtMove = -999;
let _shellReady = false;
let _chatHistory = []; // for LLM continuity

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function charName() { return _ctx?.charName || 'TA'; }
function userName() { return _ctx?.userName || '你'; }

function loadDensity() {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    if (v && DENSITY_OPTS[v]) return v;
  } catch {}
  return 'occasional';
}

function saveDensity(v) {
  _density = DENSITY_OPTS[v] ? v : 'occasional';
  try { localStorage.setItem(DENSITY_KEY, _density); } catch {}
}

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
}

function cloneBoard(b) {
  return b.map(row => row.slice());
}

function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function countLine(board, r, c, dr, dc, color) {
  let len = 1;
  let r1 = r, c1 = c, r2 = r, c2 = c;
  let nr = r + dr, nc = c + dc;
  while (inBounds(nr, nc) && board[nr][nc] === color) {
    len++; r2 = nr; c2 = nc;
    nr += dr; nc += dc;
  }
  nr = r - dr; nc = c - dc;
  while (inBounds(nr, nc) && board[nr][nc] === color) {
    len++; r1 = nr; c1 = nc;
    nr -= dr; nc -= dc;
  }
  return { len, r1, c1, r2, c2 };
}

/** 精确五连：某方向 ≥5 即胜（无禁手） */
export function checkWinAt(board, r, c) {
  const color = board[r]?.[c];
  if (!color) return null;
  for (const [dr, dc] of DIRS) {
    const { len, r1, c1, r2, c2 } = countLine(board, r, c, dr, dc, color);
    if (len >= 5) {
      const line = [];
      let cr = r1, cc = c1;
      while (true) {
        line.push({ r: cr, c: cc });
        if (cr === r2 && cc === c2) break;
        cr += dr; cc += dc;
      }
      return { color, line };
    }
  }
  return null;
}

function isBoardFull(board) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === EMPTY) return false;
    }
  }
  return true;
}

function opponent(color) {
  return color === BLACK ? WHITE : BLACK;
}

function colorLabel(color) {
  if (color === BLACK) return '黑棋';
  if (color === WHITE) return '白棋';
  return '';
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── 评价 / AI ─────────────────────────────────────────

function scorePattern(counts, openEnds) {
  if (counts >= 5) return 100000;
  if (counts === 4) {
    if (openEnds === 2) return 10000;
    if (openEnds === 1) return 1000;
    return 0;
  }
  if (counts === 3) {
    if (openEnds === 2) return 500;
    if (openEnds === 1) return 50;
    return 0;
  }
  if (counts === 2) {
    if (openEnds === 2) return 50;
    if (openEnds === 1) return 10;
    return 0;
  }
  if (counts === 1 && openEnds === 2) return 5;
  return 0;
}

function evaluatePoint(board, r, c, color) {
  if (board[r][c] !== EMPTY) return -1;
  let total = 0;
  for (const [dr, dc] of DIRS) {
    let count = 1;
    let open = 0;
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc) && board[nr][nc] === color) {
      count++; nr += dr; nc += dc;
    }
    if (inBounds(nr, nc) && board[nr][nc] === EMPTY) open++;
    nr = r - dr; nc = c - dc;
    while (inBounds(nr, nc) && board[nr][nc] === color) {
      count++; nr -= dr; nc -= dc;
    }
    if (inBounds(nr, nc) && board[nr][nc] === EMPTY) open++;
    total += scorePattern(count, open);
  }
  const mid = (SIZE - 1) / 2;
  const dist = Math.abs(r - mid) + Math.abs(c - mid);
  total += Math.max(0, 14 - dist);
  return total;
}

/** 落子后该点形成的进攻分（不含中心偏置） */
function attackScoreAt(board, r, c, color) {
  let total = 0;
  for (const [dr, dc] of DIRS) {
    const { len } = countLine(board, r, c, dr, dc, color);
    let open = 0;
    const ends = [];
    // 两端
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc) && board[nr][nc] === color) { nr += dr; nc += dc; }
    if (inBounds(nr, nc) && board[nr][nc] === EMPTY) open++;
    nr = r - dr; nc = c - dc;
    while (inBounds(nr, nc) && board[nr][nc] === color) { nr -= dr; nc -= dc; }
    if (inBounds(nr, nc) && board[nr][nc] === EMPTY) open++;
    ends.push(open);
    total += scorePattern(len, open);
  }
  return total;
}

function getCandidateMoves(board, radius = 2) {
  const marked = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const moves = [];
  let hasStone = false;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === EMPTY) continue;
      hasStone = true;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = r + dr, nc = c + dc;
          if (!inBounds(nr, nc) || board[nr][nc] !== EMPTY || marked[nr][nc]) continue;
          marked[nr][nc] = true;
          moves.push({ r: nr, c: nc });
        }
      }
    }
  }
  if (!hasStone) return [{ r: 7, c: 7 }];
  return moves;
}

function findImmediateWin(board, color) {
  for (const m of getCandidateMoves(board, 2)) {
    board[m.r][m.c] = color;
    const win = checkWinAt(board, m.r, m.c);
    board[m.r][m.c] = EMPTY;
    if (win) return m;
  }
  return null;
}

function pickAiMove(board, aiColor) {
  const human = opponent(aiColor);
  const winNow = findImmediateWin(board, aiColor);
  if (winNow) return winNow;
  const block = findImmediateWin(board, human);
  if (block) return block;
  const cands = getCandidateMoves(board, 2);
  let best = null;
  let bestScore = -Infinity;
  for (const m of cands) {
    const attack = evaluatePoint(board, m.r, m.c, aiColor);
    const defend = evaluatePoint(board, m.r, m.c, human);
    const score = attack * 1.1 + defend;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best || { r: 7, c: 7 };
}

// ─── 旁白 / 闲聊 ───────────────────────────────────────

function canBanter() {
  if (_mode !== 'ai') return false;
  const cfg = DENSITY_OPTS[_density] || DENSITY_OPTS.occasional;
  if (cfg.maxBanter <= 0) return false;
  if (_banterCount >= cfg.maxBanter) return false;
  if (_moves.length - _lastBanterAtMove < cfg.cooldown) return false;
  return true;
}

function pushChat(role, content, kind = 'chat') {
  const text = String(content || '').trim().slice(0, 80);
  if (!text) return;
  _chatMsgs.push({ role, content: text, kind });
  if (_chatMsgs.length > 40) _chatMsgs.shift();
  if (kind === 'chat') {
    _chatHistory.push({ role: role === 'user' ? 'user' : 'assistant', content: text });
    if (_chatHistory.length > 12) _chatHistory = _chatHistory.slice(-12);
  }
  renderChatLog();
}

function gameContextText(eventKey) {
  const you = colorLabel(_playerColor);
  const ta = colorLabel(opponent(_playerColor));
  const result = !_winner ? '进行中'
    : _winner === 'draw' ? '和棋'
      : _winner === _playerColor ? '用户获胜' : `${charName()}获胜`;
  return [
    `对局：五子棋 15×15 无禁手`,
    `用户执${you}，${charName()}执${ta}`,
    `已下 ${_moves.length} 手`,
    `事件：${eventKey || '闲聊'}`,
    `结果：${result}`,
    `旁白密度：${DENSITY_OPTS[_density]?.label || '偶尔'}`,
  ].join('\n');
}

async function speakBanter(eventKey) {
  if (!canBanter() && !String(eventKey || '').startsWith('end_')) return;
  // 终局不受冷却限制，但仍受密度：安静档用模板且仅终局一句
  const cfg = DENSITY_OPTS[_density] || DENSITY_OPTS.occasional;
  const isEnd = String(eventKey || '').startsWith('end_');
  if (_mode !== 'ai') return;
  if (cfg.maxBanter <= 0 && !isEnd) return;
  if (!isEnd && _banterCount >= cfg.maxBanter) return;
  if (!isEnd && _moves.length - _lastBanterAtMove < cfg.cooldown) return;

  _banterCount += 1;
  _lastBanterAtMove = _moves.length;

  const templates = BANTER_TEMPLATES[eventKey] || BANTER_TEMPLATES.threat;
  let line = pick(templates);

  const useLlm = _ctx?.playGame && _ctx?.charId && Math.random() < (isEnd ? Math.max(cfg.llmChance, 0.45) : cfg.llmChance);
  if (useLlm) {
    try {
      const r = await _ctx.playGame({
        gameType: 'gomoku_banter',
        charId: _ctx.charId,
        userInput: `请对事件「${eventKey}」说一句旁白`,
        gameContext: gameContextText(eventKey),
        history: [],
      });
      const reply = String(r?.reply || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (reply && !/完了|垃圾|菜鸡|弱智|去死|废物/.test(reply)) line = reply;
    } catch { /* 用模板 */ }
  }

  pushChat('assistant', line, 'banter');
}

function detectMoveEvent(r, c, color, blockedThreat) {
  if (_moves.length === 1) return 'open';
  if (blockedThreat) return 'block';
  const atk = attackScoreAt(_board, r, c, color);
  if (atk >= 500) return 'threat'; // 活三及以上
  return null;
}

/** 落子前：该空位是否是对方的必赢点 */
function wasWinningSquare(board, r, c, forColor) {
  if (board[r][c] !== EMPTY) return false;
  board[r][c] = forColor;
  const win = checkWinAt(board, r, c);
  board[r][c] = EMPTY;
  return !!win;
}

// ─── 对局逻辑 ──────────────────────────────────────────

function resetBanterState() {
  _banterCount = 0;
  _lastBanterAtMove = -999;
  _chatMsgs = [];
  _chatHistory = [];
  _chatBusy = false;
}

function resetGame(opts = {}) {
  clearTimeout(_thinkingTimer);
  _board = emptyBoard();
  _moves = [];
  _turn = BLACK;
  _winner = null;
  _winLine = null;
  _lastMove = null;
  _busy = false;
  _hover = null;
  if (opts.mode) _mode = opts.mode;
  if (opts.playerColor) _playerColor = opts.playerColor;
  if (opts.clearChat !== false) resetBanterState();
}

function applyMove(r, c) {
  if (_winner || _board[r][c] !== EMPTY) return false;
  const color = _turn;
  const opp = opponent(color);
  const blockedThreat = wasWinningSquare(_board, r, c, opp);

  _board[r][c] = color;
  _moves.push({ r, c, color });
  _lastMove = { r, c };

  const win = checkWinAt(_board, r, c);
  if (win) {
    _winner = win.color;
    _winLine = win.line;
    _ctx?.onMove?.();
    return { ok: true, event: null, blockedThreat };
  }
  if (isBoardFull(_board)) {
    _winner = 'draw';
    _ctx?.onMove?.();
    return { ok: true, event: null, blockedThreat };
  }
  _turn = opponent(_turn);
  _ctx?.onMove?.();
  const event = detectMoveEvent(r, c, color, blockedThreat);
  return { ok: true, event, blockedThreat };
}

function undoMove() {
  if (_busy || !_moves.length) return;
  clearTimeout(_thinkingTimer);
  _busy = false;
  if (_mode === 'ai' && _moves.length >= 1) {
    const last = _moves[_moves.length - 1];
    if (last.color !== _playerColor && _moves.length >= 2) {
      popOne();
    }
  }
  popOne();
  _winner = null;
  _winLine = null;
  updateStatus();
  drawBoard();
  updateActionButtons();
  maybeAiTurn();
  if (_mode === 'ai' && canBanter()) speakBanter('undo');
}

function popOne() {
  const m = _moves.pop();
  if (!m) return;
  _board[m.r][m.c] = EMPTY;
  _lastMove = _moves.length ? { r: _moves[_moves.length - 1].r, c: _moves[_moves.length - 1].c } : null;
  _turn = m.color;
}

function isPlayerTurn() {
  if (_winner) return false;
  if (_mode === 'local') return true;
  return _turn === _playerColor;
}

function maybeAiTurn() {
  if (_mode !== 'ai' || _winner || _turn === _playerColor || _busy) return;
  _busy = true;
  updateStatus();
  updateActionButtons();
  _thinkingTimer = setTimeout(async () => {
    const move = pickAiMove(_board, opponent(_playerColor));
    const result = applyMove(move.r, move.c);
    _busy = false;
    updateStatus();
    drawBoard();
    updateActionButtons();
    if (_winner) {
      await finishWithBanter();
      return;
    }
    if (result?.event) speakBanter(result.event);
  }, 280 + Math.random() * 220);
}

async function finishWithBanter() {
  let key = 'end_draw';
  let text = '和棋';
  if (_winner === 'draw') {
    key = 'end_draw';
    text = '和棋';
  } else if (_mode === 'local') {
    text = `${colorLabel(_winner)}获胜`;
    key = 'end_win';
  } else if (_winner === _playerColor) {
    key = 'end_win';
    text = '你赢了';
  } else {
    key = 'end_lose';
    text = `${charName()} 赢了`;
  }
  updateStatus();
  updateActionButtons();
  if (_mode === 'ai' && _density !== 'quiet') await speakBanter(key);
  else if (_mode === 'ai' && _density === 'quiet') {
    // 安静档终局仍给一句极短模板，不调模型
    pushChat('assistant', pick(BANTER_TEMPLATES[key]), 'banter');
  }
  _ctx?.onResult?.(text);
}

function onGameEnd() {
  finishWithBanter();
}

// ─── 画布 ──────────────────────────────────────────────

function layoutMetrics(cssSize) {
  _pad = cssSize * 0.06;
  _cell = (cssSize - _pad * 2) / (SIZE - 1);
}

function stoneToXY(r, c) {
  return { x: _pad + c * _cell, y: _pad + r * _cell };
}

function xyToStone(x, y) {
  const c = Math.round((x - _pad) / _cell);
  const r = Math.round((y - _pad) / _cell);
  if (!inBounds(r, c)) return null;
  const { x: sx, y: sy } = stoneToXY(r, c);
  if (Math.hypot(x - sx, y - sy) > _cell * 0.42) return null;
  return { r, c };
}

function drawBoard() {
  if (!_canvas) return;
  const ctx = _canvas.getContext('2d');
  const cssW = _canvas.clientWidth;
  const cssH = _canvas.clientHeight;
  const size = Math.min(cssW, cssH);
  _dpr = Math.min(window.devicePixelRatio || 1, 2);
  _canvas.width = Math.round(size * _dpr);
  _canvas.height = Math.round(size * _dpr);
  _canvas.style.width = size + 'px';
  _canvas.style.height = size + 'px';
  ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
  layoutMetrics(size);

  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, '#e8c992');
  bg.addColorStop(0.5, '#d4a574');
  bg.addColorStop(1, '#c9956c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(60,40,20,0.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const { x, y } = stoneToXY(i, i);
    ctx.beginPath();
    ctx.moveTo(_pad, y);
    ctx.lineTo(_pad + (SIZE - 1) * _cell, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, _pad);
    ctx.lineTo(x, _pad + (SIZE - 1) * _cell);
    ctx.stroke();
  }

  const stars = [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]];
  ctx.fillStyle = 'rgba(50,30,15,0.7)';
  for (const [r, c] of stars) {
    const { x, y } = stoneToXY(r, c);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.5, _cell * 0.08), 0, Math.PI * 2);
    ctx.fill();
  }

  if (_hover && isPlayerTurn() && !_busy && _board[_hover.r][_hover.c] === EMPTY) {
    const { x, y } = stoneToXY(_hover.r, _hover.c);
    ctx.beginPath();
    ctx.arc(x, y, _cell * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = _turn === BLACK ? 'rgba(20,20,20,0.25)' : 'rgba(255,255,255,0.45)';
    ctx.fill();
  }

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (_board[r][c]) drawStone(ctx, r, c, _board[r][c]);
    }
  }

  if (_lastMove) {
    const { x, y } = stoneToXY(_lastMove.r, _lastMove.c);
    ctx.fillStyle = '#e74c3c';
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, _cell * 0.1), 0, Math.PI * 2);
    ctx.fill();
  }

  if (_winLine?.length) {
    ctx.strokeStyle = 'rgba(231,76,60,0.9)';
    ctx.lineWidth = Math.max(2.5, _cell * 0.12);
    ctx.lineCap = 'round';
    ctx.beginPath();
    _winLine.forEach((p, i) => {
      const { x, y } = stoneToXY(p.r, p.c);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function drawStone(ctx, r, c, color) {
  const { x, y } = stoneToXY(r, c);
  const rad = _cell * 0.42;
  const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.35, rad * 0.1, x, y, rad);
  if (color === BLACK) {
    g.addColorStop(0, '#666');
    g.addColorStop(0.55, '#222');
    g.addColorStop(1, '#0a0a0a');
  } else {
    g.addColorStop(0, '#fff');
    g.addColorStop(0.6, '#f0f0f0');
    g.addColorStop(1, '#c8c8c8');
  }
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  if (color === WHITE) {
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function canvasPos(e) {
  const rect = _canvas.getBoundingClientRect();
  const touch = e.touches?.[0] || e.changedTouches?.[0];
  const clientX = touch ? touch.clientX : e.clientX;
  const clientY = touch ? touch.clientY : e.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function onPointerMove(e) {
  if (!_canvas || !isPlayerTurn() || _busy) {
    _hover = null;
    return;
  }
  const { x, y } = canvasPos(e);
  _hover = xyToStone(x, y);
  drawBoard();
}

function onPointerLeave() {
  _hover = null;
  drawBoard();
}

async function onPointerDown(e) {
  if (!_canvas || !isPlayerTurn() || _busy || _winner) return;
  e.preventDefault();
  const { x, y } = canvasPos(e);
  const pos = xyToStone(x, y);
  if (!pos || _board[pos.r][pos.c] !== EMPTY) return;
  const result = applyMove(pos.r, pos.c);
  updateStatus();
  drawBoard();
  updateActionButtons();
  if (_winner) {
    await finishWithBanter();
    return;
  }
  if (result?.event) speakBanter(result.event);
  maybeAiTurn();
}

// ─── UI（壳不整页重刷，避免打断输入） ───────────────────

function statusText() {
  if (_winner === 'draw') return '和棋 · 棋盘已满';
  if (_winner) {
    if (_mode === 'local') return `${colorLabel(_winner)} 连成五子，获胜！`;
    return _winner === _playerColor
      ? `你（${colorLabel(_winner)}）获胜！`
      : `${escapeHtml(charName())}（${colorLabel(_winner)}）获胜！`;
  }
  if (_busy) return `${escapeHtml(charName())} 思考中…`;
  if (_mode === 'local') return `轮到 ${colorLabel(_turn)} · 第 ${_moves.length + 1} 手`;
  if (_turn === _playerColor) return `你的回合（${colorLabel(_turn)}）· 点交叉点落子`;
  return `等待 ${escapeHtml(charName())}…`;
}

function updateStatus() {
  const el = document.getElementById('gomoku-status');
  if (el) el.innerHTML = statusText();
}

function updateActionButtons() {
  const undo = document.getElementById('gomoku-undo-btn');
  if (undo) undo.disabled = !(_moves.length && !_busy);
  const again = document.getElementById('gomoku-again-btn');
  if (again) again.style.display = _winner ? '' : 'none';
}

function renderChatLog() {
  const log = document.getElementById('gomoku-chat-log');
  if (!log) return;
  if (!_chatMsgs.length) {
    log.innerHTML = `<div style="font-size:11px;color:var(--text-secondary);text-align:center;padding:6px 0;line-height:1.5">默认安静下棋；只有关键时刻才出声，想聊再打字</div>`;
    return;
  }
  log.innerHTML = _chatMsgs.slice(-8).map(m => {
    if (m.role === 'user') {
      return `<div style="text-align:right;margin:4px 0"><span style="display:inline-block;max-width:90%;background:var(--theme);color:#fff;border-radius:10px 10px 4px 10px;padding:5px 10px;font-size:12px;line-height:1.45">${escapeHtml(m.content)}</span></div>`;
    }
    const muted = m.kind === 'banter' ? 'opacity:.92' : '';
    return `<div style="margin:4px 0;${muted}"><span style="display:inline-block;max-width:90%;background:var(--bg-glass);border:1px solid var(--border);border-radius:10px 10px 10px 4px;padding:5px 10px;font-size:12px;line-height:1.45;color:var(--text-primary)">${escapeHtml(charName())}：${escapeHtml(m.content)}</span></div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
}

function densityButtonsHtml() {
  return Object.entries(DENSITY_OPTS).map(([k, v]) => {
    const on = _density === k;
    return `<button type="button" class="btn ${on ? 'btn-primary' : 'btn-ghost'} btn-sm" style="padding:4px 8px;font-size:11px" onclick="gomokuSetDensity('${k}')">${v.label}</button>`;
  }).join('');
}

function ensurePlayShell() {
  const el = document.getElementById('gomoku-content');
  if (!el) return;
  const youColor = _mode === 'ai' ? colorLabel(_playerColor) : '';
  const aiColor = _mode === 'ai' ? colorLabel(opponent(_playerColor)) : '';
  const showChat = _mode === 'ai';

  el.innerHTML = `
    <div style="padding:8px 12px 0;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;gap:6px">
      <div style="display:flex;gap:8px;flex-shrink:0">
        <div style="flex:1;background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;padding:6px 8px;text-align:center">
          <div style="font-size:16px">${_mode === 'ai' && _playerColor === BLACK ? '⚫' : (_mode === 'local' ? '⚫' : '⚪')}</div>
          <div style="font-size:11px;color:var(--text-primary)">${_mode === 'ai' ? escapeHtml(userName()) : '黑棋'}</div>
          <div style="font-size:10px;color:var(--text-secondary)">${_mode === 'ai' ? youColor : ''}</div>
        </div>
        <div style="flex:1;background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;padding:6px 8px;text-align:center">
          <div style="font-size:16px">${_mode === 'ai' && _playerColor === WHITE ? '⚫' : '⚪'}</div>
          <div style="font-size:11px;color:var(--text-primary)">${_mode === 'ai' ? escapeHtml(charName()) : '白棋'}</div>
          <div style="font-size:10px;color:var(--text-secondary)">${_mode === 'ai' ? aiColor : ''}</div>
        </div>
      </div>

      <div id="gomoku-status" style="font-size:13px;color:var(--text-primary);text-align:center;min-height:18px;font-weight:500;flex-shrink:0"></div>

      <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 2px">
        <canvas id="gomoku-canvas" style="max-width:100%;max-height:100%;touch-action:none;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.12)"></canvas>
      </div>

      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;align-items:center;flex-shrink:0">
        <button type="button" class="btn btn-ghost btn-sm" id="gomoku-undo-btn" onclick="gomokuUndo()">悔棋</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="gomokuRestart()">重开</button>
        <button type="button" class="btn btn-primary btn-sm" id="gomoku-again-btn" style="display:none" onclick="gomokuRestart()">再来一局</button>
      </div>

      ${showChat ? `
      <div style="flex-shrink:0;border-top:1px solid var(--border);padding-top:6px;padding-bottom:max(6px,var(--sab))">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">
          <div style="font-size:11px;color:var(--text-secondary)">旁白</div>
          <div style="display:flex;gap:4px" id="gomoku-density-btns">${densityButtonsHtml()}</div>
        </div>
        <div id="gomoku-chat-log" style="max-height:88px;overflow-y:auto;margin-bottom:6px"></div>
        <div style="display:flex;gap:6px;align-items:center">
          <input class="input" id="gomoku-chat-input" placeholder="想聊再说…" style="flex:1;font-size:13px;padding:8px 10px"
            onkeydown="if(event.key==='Enter')gomokuSendChat()">
          <button type="button" class="btn btn-primary btn-sm" id="gomoku-chat-send" onclick="gomokuSendChat()">发送</button>
        </div>
      </div>` : `
      <div style="font-size:11px;color:var(--text-secondary);text-align:center;padding-bottom:max(8px,var(--sab));line-height:1.4;flex-shrink:0">
        标准无禁手 · 15×15 · 交叉点落子
      </div>`}
    </div>`;

  _shellReady = true;
  _canvas = document.getElementById('gomoku-canvas');
  if (_canvas) {
    const box = _canvas.parentElement;
    const side = Math.min(box.clientWidth || 320, box.clientHeight || 280, showChat ? 360 : 420);
    _canvas.style.width = side + 'px';
    _canvas.style.height = side + 'px';
    _canvas.onpointermove = onPointerMove;
    _canvas.onpointerleave = onPointerLeave;
    _canvas.onpointerdown = onPointerDown;
  }
  updateStatus();
  updateActionButtons();
  drawBoard();
  if (showChat) renderChatLog();
}

function showSetup() {
  _shellReady = false;
  const el = document.getElementById('gomoku-content');
  if (!el) return;
  _density = loadDensity();
  el.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:14px">
      <div style="font-size:40px">⚫⚪</div>
      <div style="font-size:16px;font-weight:600;color:var(--text-primary)">五子棋</div>
      <div style="font-size:12px;color:var(--text-secondary);text-align:center;line-height:1.6;max-width:280px">
        15×15 标准棋盘 · 无禁手规则<br>落在交叉点上，连成五子获胜
      </div>
      <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap">
        ${densityButtonsHtml()}
      </div>
      <div style="font-size:11px;color:var(--text-secondary);text-align:center">旁白密度 · 默认「偶尔」，对局中也可改</div>
      <div style="width:100%;max-width:300px;display:flex;flex-direction:column;gap:10px;margin-top:4px">
        <button type="button" class="btn btn-primary" style="width:100%;padding:12px" onclick="gomokuStart('ai',1)">
          对战 ${escapeHtml(charName())} · 我执黑（先手）
        </button>
        <button type="button" class="btn btn-ghost" style="width:100%;padding:12px" onclick="gomokuStart('ai',2)">
          对战 ${escapeHtml(charName())} · 我执白（后手）
        </button>
        <button type="button" class="btn btn-ghost" style="width:100%;padding:12px" onclick="gomokuStart('local',1)">
          双人对弈（同屏）
        </button>
      </div>
    </div>`;
}

function refreshDensityButtons() {
  const box = document.getElementById('gomoku-density-btns');
  if (box) box.innerHTML = densityButtonsHtml();
  else if (!_shellReady) showSetup();
}

export function getGomokuSaveState() {
  if (!_board) return null;
  return {
    board: cloneBoard(_board),
    moves: _moves.slice(),
    turn: _turn,
    playerColor: _playerColor,
    mode: _mode,
    winner: _winner,
    winLine: _winLine ? _winLine.map(p => ({ ...p })) : null,
    lastMove: _lastMove ? { ..._lastMove } : null,
    density: _density,
    chatMsgs: _chatMsgs.slice(-20),
    banterCount: _banterCount,
    lastBanterAtMove: _lastBanterAtMove,
  };
}

export function restoreGomokuState(save, ctx) {
  _ctx = ctx;
  _density = save?.density && DENSITY_OPTS[save.density] ? save.density : loadDensity();
  if (!save?.board) {
    showSetup();
    return;
  }
  _board = cloneBoard(save.board);
  _moves = Array.isArray(save.moves) ? save.moves.slice() : [];
  _turn = save.turn || BLACK;
  _playerColor = save.playerColor || BLACK;
  _mode = save.mode || 'ai';
  _winner = save.winner || null;
  _winLine = save.winLine || null;
  _lastMove = save.lastMove || null;
  _chatMsgs = Array.isArray(save.chatMsgs) ? save.chatMsgs.slice() : [];
  _banterCount = Number(save.banterCount) || 0;
  _lastBanterAtMove = Number.isFinite(save.lastBanterAtMove) ? save.lastBanterAtMove : -999;
  _busy = false;
  document.getElementById('gomoku-session').style.display = 'flex';
  ensurePlayShell();
  maybeAiTurn();
}

export function initGomoku(ctx) {
  _ctx = ctx;
  clearTimeout(_thinkingTimer);
  _density = loadDensity();
  resetGame();
  _shellReady = false;
  document.getElementById('gomoku-session').style.display = 'flex';
  showSetup();

  window.gomokuStart = function(mode, playerColor) {
    resetGame({ mode, playerColor: Number(playerColor) || BLACK });
    ensurePlayShell();
    maybeAiTurn();
  };

  window.gomokuUndo = function() {
    undoMove();
    _ctx?.onMove?.();
  };

  window.gomokuRestart = function() {
    resetBanterState();
    showSetup();
  };

  window.gomokuSetDensity = function(v) {
    saveDensity(v);
    refreshDensityButtons();
    if (_shellReady) {
      const box = document.getElementById('gomoku-density-btns');
      if (box) box.innerHTML = densityButtonsHtml();
    } else {
      showSetup();
    }
    window.showToast?.(`旁白：${DENSITY_OPTS[_density].label}`);
  };

  window.gomokuSendChat = async function() {
    if (_mode !== 'ai' || _chatBusy) return;
    const input = document.getElementById('gomoku-chat-input');
    const text = input?.value.trim();
    if (!text) return;
    if (input) input.value = '';
    pushChat('user', text, 'chat');
    if (!_ctx?.playGame || !_ctx?.charId) {
      pushChat('assistant', '……', 'chat');
      return;
    }
    _chatBusy = true;
    const sendBtn = document.getElementById('gomoku-chat-send');
    if (sendBtn) sendBtn.disabled = true;
    try {
      const r = await _ctx.playGame({
        gameType: 'gomoku_chat',
        charId: _ctx.charId,
        userInput: text,
        gameContext: gameContextText('chat'),
        history: _chatHistory.slice(0, -1).slice(-8),
      });
      let reply = String(r?.reply || '').trim().slice(0, 80);
      if (!reply) reply = '嗯。';
      pushChat('assistant', reply, 'chat');
    } catch (e) {
      pushChat('assistant', '（这句没说上）', 'chat');
      window.showToast?.(e.message || '发送失败');
    } finally {
      _chatBusy = false;
      if (sendBtn) sendBtn.disabled = false;
      document.getElementById('gomoku-chat-input')?.focus();
    }
  };

  if (!window._gomokuResizeBound) {
    window._gomokuResizeBound = true;
    window.addEventListener('resize', () => {
      if (_canvas && document.getElementById('gomoku-session')?.style.display === 'flex') {
        drawBoard();
      }
    });
  }
}

export function destroyGomoku() {
  clearTimeout(_thinkingTimer);
  _busy = false;
  _chatBusy = false;
  _canvas = null;
  _board = null;
  _shellReady = false;
}

/* ===== 剧集页：平行世界长篇连载 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';

let _bookId = null;
let _book = null;
let _charId = null;
let _busy = false;
let _meta = null;
let _mode = 'series'; // series | isekai | whatif | illusion
let _playNo = null;
let _isekaiLastTurnId = 0;
let _isekaiTurnPending = false;
let _whatifLastTurnId = 0;

const STYLE_OPTIONS = [
  { key: 'genre', label: '题材默认' },
  { key: 'romantic', label: '浪漫抒情' },
  { key: 'poetic', label: '意境古风' },
  { key: 'surreal', label: '超现实' },
  { key: 'dark', label: '黑暗叙事' },
  { key: 'gentle', label: '温柔细腻' },
  { key: 'epic', label: '史诗长卷' },
  { key: 'witty', label: '轻俏机敏' },
  { key: 'custom', label: '自定义' },
];

const LENGTH_OPTIONS = [
  { key: 'flash', label: '极短', sub: '约 4 章' },
  { key: 'short', label: '短篇', sub: '约 8 章' },
  { key: 'medium', label: '中篇', sub: '约 20 章' },
  { key: 'long', label: '长篇', sub: '约 40 章' },
];

const GENRE_FALLBACK = [
  { key: 'mystery', label: '悬疑推理' },
  { key: 'romance', label: '言情' },
  { key: 'sweet', label: '甜宠' },
  { key: 'angst', label: '虐恋' },
  { key: 'horror', label: '恐怖' },
  { key: 'folklore', label: '志怪神话' },
  { key: 'infinite', label: '无限流' },
  { key: 'apocalypse', label: '末日求生' },
  { key: 'urban', label: '都市' },
  { key: 'workplace', label: '职场商战' },
  { key: 'entertainment', label: '娱乐圈' },
  { key: 'family', label: '豪门世家' },
  { key: 'palace', label: '宫斗权谋' },
  { key: 'historical', label: '历史权谋' },
  { key: 'wuxia', label: '武侠仙侠' },
  { key: 'farming', label: '种田经营' },
  { key: 'rebirth', label: '重生逆袭' },
  { key: 'ability', label: '异能超能' },
  { key: 'campus', label: '校园' },
  { key: 'medical', label: '医疗职场' },
  { key: 'spy', label: '谍战' },
  { key: 'adventure', label: '探险冒险' },
  { key: 'revenge', label: '复仇爽文' },
  { key: 'healing', label: '治愈日常' },
  { key: 'abnormal', label: '病娇/偏执' },
  { key: 'scifi', label: '科幻' },
  { key: 'steampunk', label: '蒸汽朋克' },
  { key: 'fantasy', label: '奇幻魔法' },
  { key: 'thriller', label: '惊悚犯罪' },
  { key: 'custom', label: '自定义' },
];

const ERA_FALLBACK = [
  // 时代
  '现代', '上世纪八九十年代', '民国', '清朝', '明朝', '唐朝', '宋朝',
  '架空古代', '架空王朝', '欧洲中世纪', '维多利亚时代',
  '未来科幻', '赛博朋克', '末日废土', '星际',
  // 地点 / 场景气质
  '一线都市', '小县城', '江南水乡', '北国边塞', '海岛渔村', '山城古镇',
  '皇宫内苑', '封闭山庄', '海上游轮', '学院城', '深山古寺', '沙漠绿洲',
  '地下城迷宫', '规则怪谈空间',
  // 世界观
  '都市重生', '灵异现代', '修真界', '西幻大陆', '哈利波特背景',
];

async function ensureMeta(force = false) {
  if (_meta && !force) return _meta;
  try {
    _meta = await api.getSeriesMeta();
  } catch {
    _meta = {
      genres: GENRE_FALLBACK,
      eras: ERA_FALLBACK,
      lengths: { flash: 4, short: 8, medium: 20, long: 40 },
      lengthLabels: { flash: '极短', short: '短篇', medium: '中篇', long: '长篇' },
      apiReady: false,
    };
  }
  return _meta;
}

function apiWarnHtml() {
  if (_meta?.apiReady) return '';
  return `<div class="series-api-warn" onclick="navigateTo('settings')">
    尚未配置「时空 API」。大纲/写章只走时空专用接口，不走聊天 API。点此去设置填写地址、Key、模型。
  </div>`;
}

function setBusy(on, tip = '') {
  _busy = !!on;
  const mask = document.getElementById('series-busy-mask');
  if (!mask) return;
  mask.style.display = on ? 'flex' : 'none';
  const t = document.getElementById('series-busy-tip');
  if (t) t.textContent = tip || '生成中，请稍候…';
}

function busyMaskHtml() {
  return `<div id="series-busy-mask" class="series-busy-mask" style="display:none">
    <div class="series-busy-card">
      <div class="loading-spinner"></div>
      <div id="series-busy-tip">生成中，请稍候…</div>
      <div class="series-busy-sub">长文可能需要一两分钟</div>
    </div>
  </div>`;
}

function lengthLabel(type) {
  const n = _meta?.lengths?.[type] || { flash: 4, short: 8, medium: 20, long: 40 }[type];
  const name = _meta?.lengthLabels?.[type] || LENGTH_OPTIONS.find((x) => x.key === type)?.label || type;
  return `${name} · ${n} 章`;
}

function statusLabel(st) {
  return ({ setup: '设定中', outlining: '大纲生成中', outlined: '大纲已成', writing: '连载中', done: '已完结' })[st] || st;
}

function iseScreenwriterPending(book) {
  return false;
}

function iseNeedsScreenwriterOnCreate() {
  return false;
}

function isAsyncJobResult(res) {
  return !!(res && res.async && res.job);
}

/** 离开详情页后仍跟踪后台任务（WS 推送 + 轮询兜底） */
const _pendingJobs = new Map(); // jobId -> { bookId, kind, chapterNo }
const _seenJobEvents = new Set(); // `${jobId}:${status}`
let _jobPollTimer = null;

function trackSeriesJob(job) {
  if (!job || job.id == null) return;
  const id = Number(job.id);
  _pendingJobs.set(id, {
    bookId: Number(job.book_id ?? job.bookId),
    kind: job.kind,
    chapterNo: Number(job.chapter_no ?? job.chapterNo) || 0,
  });
  ensureJobPoller();
}

function rememberJobEvent(jobId, status) {
  if (jobId == null || !status) return false;
  const key = `${jobId}:${status}`;
  if (_seenJobEvents.has(key)) return true;
  _seenJobEvents.add(key);
  if (_seenJobEvents.size > 80) {
    const first = _seenJobEvents.values().next().value;
    _seenJobEvents.delete(first);
  }
  if (status === 'done' || status === 'error') _pendingJobs.delete(Number(jobId));
  return false;
}

function ensureJobPoller() {
  if (_jobPollTimer) return;
  _jobPollTimer = setInterval(() => {
    pollPendingSeriesJobs().catch(() => {});
  }, 4000);
  // 立刻查一次
  pollPendingSeriesJobs().catch(() => {});
}

function stopJobPollerIfIdle() {
  if (_pendingJobs.size) return;
  if (_jobPollTimer) {
    clearInterval(_jobPollTimer);
    _jobPollTimer = null;
  }
}

async function pollPendingSeriesJobs() {
  if (!_pendingJobs.size) {
    stopJobPollerIfIdle();
    return;
  }
  for (const [jobId, meta] of [..._pendingJobs.entries()]) {
    try {
      const job = await api.getSeriesJob(jobId);
      if (!job || (job.status !== 'done' && job.status !== 'error')) continue;
      if (_seenJobEvents.has(`${jobId}:${job.status}`)) {
        _pendingJobs.delete(jobId);
        continue;
      }
      const message = job.status === 'done'
        ? ({
          outline: '剧集大纲已完成',
          isekai_outline: '穿越大纲已完成',
          isekai_begin: '身份分配已完成',
          isekai_start: `第 ${meta.chapterNo || job.chapter_no || ''} 章开场已生成`,
          isekai_turn: `第 ${meta.chapterNo || job.chapter_no || ''} 章续写已完成`,
          chapter: `第 ${meta.chapterNo || job.chapter_no || ''} 章已写完`,
          director: '导演重写已完成',
          illusion: '幻象已写完',
        })[job.kind || meta.kind] || '时空任务已完成'
        : `${({
          outline: '剧集大纲',
          isekai_outline: '穿越大纲',
          isekai_begin: '开始穿越',
          isekai_start: '穿越开章',
          isekai_turn: '穿越续写',
          chapter: '剧集章节',
          director: '导演重写',
          illusion: '幻象',
        })[job.kind || meta.kind] || '时空任务'}失败：${job.error || '未知错误'}`;
      applySeriesJobEvent({
        jobId,
        bookId: meta.bookId || job.book_id,
        chapterNo: meta.chapterNo || job.chapter_no,
        kind: job.kind || meta.kind,
        status: job.status,
        error: job.error || '',
        message,
      }, { fromPoll: true });
    } catch (_) { /* 下次再试 */ }
  }
  stopJobPollerIfIdle();
}

async function refreshSeriesBookListQuiet() {
  const list = document.getElementById('series-book-list');
  if (!list || !document.getElementById('series-page')?.classList.contains('active')) return;
  try {
    const books = await api.listSeries(null, _mode);
    const title = modeLabel(_mode);
    if (!books.length) {
      list.innerHTML = `<div class="empty-state" style="padding:24px 0"><div class="empty-text">还没有${title}<br>选一位角色开始</div></div>`;
      return;
    }
    list.innerHTML = books.map((b) => `
      <div class="series-book-row" onclick="openSeriesBook(${b.id})">
        <div class="series-book-main">
          <div class="series-book-title">${escapeHtml(b.title || '未命名')}</div>
          <div class="series-book-meta">${escapeHtml(b.char_name || '角色')} · ${seriesBookListMeta(b)}</div>
        </div>
        <div class="series-book-go">›</div>
      </div>
    `).join('');
    // 列表里若有生成中，继续轮询
    for (const b of books) {
      if (b.status === 'outlining' || b.status === 'writing' || b.has_generating) {
        resumeJobsForBook(b.id).catch(() => {});
      }
    }
  } catch (_) { /* ignore */ }
}

async function resumeJobsForBook(bookId) {
  try {
    const jobs = await api.getSeriesJobs(bookId);
    for (const j of jobs || []) {
      if (j.status === 'queued' || j.status === 'running') trackSeriesJob(j);
    }
  } catch (_) { /* ignore */ }
}

function applySeriesJobEvent(data, { fromPoll = false } = {}) {
  const bookId = Number(data?.bookId);
  if (!bookId) return;
  if (data.jobId != null && (data.status === 'done' || data.status === 'error')) {
    if (rememberJobEvent(data.jobId, data.status)) return;
  }

  if (data?.status === 'error' && data?.message) {
    window._seriesLastError = String(data.message);
    window._seriesLastErrorBookId = bookId;
  } else if (data?.status === 'done') {
    if (Number(window._seriesLastErrorBookId) === bookId) window._seriesLastError = '';
    if (data.kind === 'isekai_start' && data.chapterNo != null && Number(_bookId) === bookId) {
      window.showToast?.(`第 ${data.chapterNo} 章开场已生成，可点「进入」`);
    }
    if (data.kind === 'isekai_turn' && Number(_bookId) === bookId && Number(_playNo) === Number(data.chapterNo)) {
      refreshIsekaiPlayAfterTurnJob(data).catch?.(() => {});
    }
  }

  if (data?.status === 'error' && data.kind === 'isekai_turn' && Number(_bookId) === bookId && Number(_playNo) === Number(data.chapterNo)) {
    clearIsekaiTurnPendingState();
  }

  const pageActive = document.getElementById('series-page')?.classList.contains('active');
  if (pageActive && _bookId && Number(_bookId) === bookId) {
    // 正在玩某一章时：其它章预生成完成不要踢回目录
    if (_playNo != null) {
      if (data.kind === 'isekai_begin') {
        _playNo = null;
        openSeriesBook(_bookId).catch?.(() => {});
      } else if (data.kind === 'isekai_start' && Number(data.chapterNo) === Number(_playNo)) {
        // 当前章开场刚生成完，若还在进章流程可刷新目录态，但不强制打断输入
        // 保持 _playNo；仅在未进入游玩视图时刷新
        if (!document.getElementById('isekai-play-scroll')) {
          openSeriesBook(_bookId).catch?.(() => {});
        }
      }
      // 其它任务：只通知，不刷新打断
    } else {
      openSeriesBook(_bookId).catch?.(() => {});
    }
  } else if (pageActive && document.getElementById('series-book-list')) {
    refreshSeriesBookListQuiet();
  }

  // 轮询补通知（WS 路径由 app.js 统一通知，避免重复）
  if (fromPoll && data?.message) {
    if (data.status === 'error') window.showToast?.(String(data.message));
    else window.showSystemNotify?.(String(data.message));
  }
}

window.onSeriesJob = function onSeriesJob(data) {
  applySeriesJobEvent(data, { fromPoll: false });
};

function modeLabel(mode) {
  if (mode === 'isekai') return '穿越';
  if (mode === 'whatif') return '如果';
  if (mode === 'illusion') return '幻象';
  return '剧集';
}

function parseSeriesMode(mode) {
  if (mode === 'isekai' || mode === 'whatif' || mode === 'illusion') return mode;
  return 'series';
}

function seriesBookListMeta(b) {
  if (b.mode === 'whatif' || _mode === 'whatif') {
    return `${b.whatif_started ? `进行中 · ${b.whatif_turn_count || 0} 回合` : '未开始'} · ${statusLabel(b.status)}`;
  }
  if (b.mode === 'illusion' || _mode === 'illusion') {
    if (b.illusion_generating || b.status === 'writing' || b.has_generating) return '生成中…';
    if (b.illusion_ready) return `${b.illusion_len || 0} 字 · 已写成`;
    return '未生成';
  }
  return `${lengthLabel(b.length_type)} · ${b.chapters_done || 0}/${b.total_chapters} 章 · ${statusLabel(b.status)}`;
}

/* ─── 时空首页：选剧集 / 穿越 ─── */
window.initSeriesPage = async function initSeriesPage() {
  _bookId = null;
  _book = null;
  _charId = null;
  _playNo = null;
  await ensureMeta(true);

  const page = document.getElementById('series-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title">时空</div>
      <div class="topbar-action" style="width:40px"></div>
    </div>
    <div class="scroll-area series-home">
      <div class="series-hero">
        <div class="series-hero-title">时空</div>
        <div class="series-hero-sub">平行世界 · 剧集旁观、穿越进剧本、「如果」情景，或读一场角色脑内的幻象</div>
      </div>
      ${apiWarnHtml()}
      <div class="series-mode-grid">
        <button type="button" class="series-mode-card" onclick="openSeriesModeHome('series')">
          <div class="series-mode-icon">🎬</div>
          <div class="series-mode-name">剧集</div>
          <div class="series-mode-desc">AI 写长篇，你主要阅读；姓名不变，只换身份（可自填或盲盒）</div>
        </button>
        <button type="button" class="series-mode-card" onclick="openSeriesModeHome('isekai')">
          <div class="series-mode-icon">🌀</div>
          <div class="series-mode-name">穿越</div>
          <div class="series-mode-desc">和 TA 掉进剧本世界一起演；主线不在你们身上时可以摸鱼</div>
        </button>
        <button type="button" class="series-mode-card" onclick="openSeriesModeHome('whatif')">
          <div class="series-mode-icon">💭</div>
          <div class="series-mode-name">如果</div>
          <div class="series-mode-desc">自定背景与「如果…」前提，无大纲，一切随你的反应展开</div>
        </button>
        <button type="button" class="series-mode-card" onclick="openSeriesModeHome('illusion')">
          <div class="series-mode-icon">🫧</div>
          <div class="series-mode-name">幻象</div>
          <div class="series-mode-desc">TA 脑内幻想和你一起做事；一次写成几千字小故事，不分章</div>
        </button>
      </div>
    </div>
    ${busyMaskHtml()}
  `;
};

window.openSeriesModeHome = async function openSeriesModeHome(mode) {
  _mode = parseSeriesMode(mode);
  _bookId = null;
  _book = null;
  await ensureMeta();
  const isIk = _mode === 'isekai';
  const isWhatif = _mode === 'whatif';
  const isIllusion = _mode === 'illusion';
  const modeTitle = modeLabel(_mode);

  const page = document.getElementById('series-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="initSeriesPage()" title="返回"></button>
      <div class="topbar-title">${modeTitle}</div>
      <div class="topbar-action" style="width:40px"></div>
    </div>
    <div class="scroll-area series-home">
      <div class="series-hero">
        <div class="series-hero-title">${modeTitle}</div>
        <div class="series-hero-sub">${isIllusion
          ? '角色视角的幻想小故事 · 一次写完 · 不分章'
          : isWhatif
          ? '情景模拟 · 无预设大纲 · 背景驱动随机插曲'
          : isIk
            ? '意外穿越进剧本 · 演完任务才能离开 · 身份穿越后揭晓'
            : '平行世界长篇 · 只用性格与外貌 · 记忆不串戏'}</div>
      </div>
      <div class="series-sec-label">和谁${isIllusion ? '开幻象' : isWhatif ? '开如果' : isIk ? '穿越' : '开剧集'}</div>
      <div class="series-char-grid" id="series-char-grid"><div class="loading"><div class="loading-spinner"></div></div></div>
      <div class="series-sec-label" style="margin-top:20px">已有${modeTitle}</div>
      <div id="series-book-list"><div class="loading"><div class="loading-spinner"></div></div></div>
    </div>
    ${busyMaskHtml()}
  `;

  const chars = window.getFriendCharacters?.() || window.getAppCharacters?.() || [];
  const grid = document.getElementById('series-char-grid');
  if (!chars.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🌌</div>
      <div class="empty-text">还没有好友<br>先加好友后再开${modeTitle}</div>
      <button class="btn btn-primary btn-sm" style="margin-top:16px" onclick="window.navigateTo?.('contacts')">去通讯录</button>
    </div>`;
  } else {
    grid.innerHTML = chars.map((c) => {
      const av = c.avatar
        ? `<img class="series-char-avatar" src="${escapeHtml(c.avatar)}" alt="">`
        : `<div class="series-char-avatar-ph">${isIllusion ? '🫧' : isWhatif ? '💭' : isIk ? '🌀' : '🎬'}</div>`;
      return `<button type="button" class="series-char-card" onclick="openSeriesNewSetup(${c.id})">
        ${av}
        <div class="series-char-name">${escapeHtml(c.name)}</div>
        <div class="series-char-hint">${isIllusion ? '新幻象' : isWhatif ? '新如果' : isIk ? '新穿越' : '开新剧集'}</div>
      </button>`;
    }).join('');
  }

  try {
    const books = await api.listSeries(null, _mode);
    const friendIds = new Set(chars.map((c) => Number(c.id)));
    const visibleBooks = (books || []).filter((b) => friendIds.has(Number(b.character_id)));
    const list = document.getElementById('series-book-list');
    if (!visibleBooks.length) {
      list.innerHTML = `<div class="empty-state" style="padding:24px 0"><div class="empty-text">还没有${modeTitle}<br>选一位好友开始</div></div>`;
    } else {
      list.innerHTML = visibleBooks.map((b) => `
        <div class="series-book-row" onclick="openSeriesBook(${b.id})">
          <div class="series-book-main">
            <div class="series-book-title">${escapeHtml(b.title || '未命名')}</div>
            <div class="series-book-meta">${escapeHtml(b.char_name || '角色')} · ${seriesBookListMeta(b)}</div>
          </div>
          <div class="series-book-go">›</div>
        </div>
      `).join('');
      for (const b of visibleBooks) {
        if (b.status === 'outlining' || b.status === 'writing' || b.has_generating) resumeJobsForBook(b.id).catch(() => {});
      }
    }
  } catch (e) {
    document.getElementById('series-book-list').innerHTML =
      `<div class="empty-text" style="padding:12px;color:var(--text-secondary)">${escapeHtml(e.message || '加载失败')}</div>`;
  }
};

/* ─── 新建设定 ─── */
window.openSeriesNewSetup = async function openSeriesNewSetup(charId) {
  const friends = window.getFriendCharacters?.() || [];
  const isFriend = friends.some((c) => Number(c.id) === Number(charId));
  if (!isFriend) {
    window.showToast?.('加好友后才能开启时空');
    return;
  }
  _charId = charId;
  await ensureMeta();
  const isIk = _mode === 'isekai';
  const isWhatif = _mode === 'whatif';
  const isIllusion = _mode === 'illusion';
  const char = (window.getFriendCharacters?.() || window.getAppCharacters?.() || []).find((c) => c.id === charId);

  if (isIllusion) {
    const page = document.getElementById('series-page');
    page.innerHTML = `
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="openSeriesModeHome('illusion')" title="返回"></button>
        <div class="topbar-title">新幻象 · ${escapeHtml(char?.name || '')}</div>
        <div class="topbar-action" style="width:40px"></div>
      </div>
      <div class="scroll-area series-setup" id="series-setup">
        <div class="series-hint">「幻象」是${escapeHtml(char?.name || 'TA')}脑内的一场幻想：想象和你一起做某件事。一次生成整篇几千字小故事，没有大纲、也不分章。会参考你的近况和TA对你的印象。</div>
        <div class="series-field">
          <label class="input-label">想一起做什么（可留空）</label>
          <div class="series-mini" style="margin-bottom:8px">例如：一起逛街、帮你吹头发、等你下班。留空则由${escapeHtml(char?.name || 'TA')}按对你的了解自己想。</div>
          <textarea class="input" id="ss-premise" rows="4" placeholder="一起……"></textarea>
        </div>
        <div class="series-field">
          <label class="input-label">标题（可留空）</label>
          <input class="input" id="ss-title" placeholder="留空则用幻想内容自动命名">
        </div>
        <div class="series-field">
          <div class="series-label">文风底色（可选）</div>
          <div class="series-chips series-chips-wrap" id="ss-style">
            ${STYLE_OPTIONS.map((s, i) => `
              <button type="button" class="series-chip ${s.key === 'gentle' ? 'active' : ''}" data-val="${s.key}" onclick="seriesPickChip('ss-style',this)">${s.label}</button>
            `).join('')}
          </div>
        </div>
        <button type="button" class="btn btn-primary" style="width:100%;margin:8px 0 28px" onclick="seriesCreateBook()">生成这场幻象</button>
      </div>
      ${busyMaskHtml()}
    `;
    return;
  }

  if (isWhatif) {
    const page = document.getElementById('series-page');
    page.innerHTML = `
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="openSeriesModeHome('whatif')" title="返回"></button>
        <div class="topbar-title">新如果 · ${escapeHtml(char?.name || '')}</div>
        <div class="topbar-action" style="width:40px"></div>
      </div>
      <div class="scroll-area series-setup" id="series-setup">
        <div class="series-hint">「如果」是开放式情景模拟：没有大纲和章节任务，一切根据你的行动即兴展开；系统会按背景偶尔插入随机插曲推动局面。</div>
        <div class="series-field">
          <label class="input-label">背景设定</label>
          <div class="series-mini" style="margin-bottom:8px">时间、地点、世界规则、人物关系基调等。例：高中母校，2015 年秋天，你们仍是同班同学。</div>
          <textarea class="input" id="ss-whatif-bg" rows="4" placeholder="填写情景所在的背景…"></textarea>
        </div>
        <div class="series-field">
          <label class="input-label">如果…（故事前言）</label>
          <div class="series-mini" style="margin-bottom:8px">整段情景的「如果」前提。例：如果我和${escapeHtml(char?.name || 'TA')}一起回到上学的时候。</div>
          <textarea class="input" id="ss-premise" rows="4" placeholder="如果我和${escapeHtml(char?.name || 'TA')}……"></textarea>
        </div>
        <div class="series-field">
          <label class="input-label">标题（可留空）</label>
          <input class="input" id="ss-title" placeholder="留空则用「如果」前提自动命名">
        </div>
        <div class="series-field">
          <div class="series-label">文风底色（可选）</div>
          <div class="series-chips series-chips-wrap" id="ss-style">
            ${STYLE_OPTIONS.map((s, i) => `
              <button type="button" class="series-chip ${i === 0 ? 'active' : ''}" data-val="${s.key}" onclick="seriesPickChip('ss-style',this)">${s.label}</button>
            `).join('')}
          </div>
        </div>
        <button type="button" class="btn btn-primary" style="width:100%;margin:8px 0 28px" onclick="seriesCreateBook()">创建并开始</button>
      </div>
      ${busyMaskHtml()}
    `;
    return;
  }

  const genres = _meta.genres || GENRE_FALLBACK;
  const eras = _meta.eras || ERA_FALLBACK;

  const page = document.getElementById('series-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="openSeriesModeHome('${_mode}')" title="返回"></button>
      <div class="topbar-title">新${modeLabel(_mode)} · ${escapeHtml(char?.name || '')}</div>
      <div class="topbar-action" style="width:40px"></div>
    </div>
    <div class="scroll-area series-setup" id="series-setup">
      <div class="series-hint">${isIk
        ? '穿越：可填期望身份、可选锁定男女主；也可大纲后从角色池点选。性别不变。'
        : '剧集：平行世界，只用 TA 的性格与外貌。姓名不变，只换剧中身份；你固定女主，TA 固定男主；可女扮男装。'}</div>

      ${isIk ? `
      <div class="series-field">
        <div class="series-label">故事来源</div>
        <div class="series-chips" id="ss-source">
          <button type="button" class="series-chip active" data-val="original" onclick="seriesPickChip('ss-source',this);seriesSourceToggle()">AI 原创</button>
          <button type="button" class="series-chip" data-val="title" onclick="seriesPickChip('ss-source',this);seriesSourceToggle()">书名导入</button>
          <button type="button" class="series-chip" data-val="upload" onclick="seriesPickChip('ss-source',this);seriesSourceToggle()">上传小说</button>
        </div>
        <div class="series-mini" style="margin-top:6px">书名导入只适合模型很熟的名作；合集可点「拉取篇目」再选一篇。可填作者区分重名。不熟会失败并提示你改上传。冷门本请直接上传 txt。书名导入与上传均跟原作走，不必选手动类型和背景。</div>
        <div id="ss-source-title-box" style="display:none;margin-top:10px">
          <label class="input-label">原作书名</label>
          <input class="input" id="ss-novel-title" placeholder="例如：红楼梦 / 安徒生童话…">
          <label class="input-label" style="margin-top:8px">作者（可选，重名时用来区分）</label>
          <input class="input" id="ss-novel-author" placeholder="例如：曹雪芹 / 安徒生…">
          <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
            <button type="button" class="btn btn-ghost btn-sm" id="ss-list-stories-btn" onclick="seriesListStories()">拉取篇目</button>
            <span class="series-mini" id="ss-list-stories-tip">合集/单元剧可拉出名篇列表再点选</span>
          </div>
          <div id="ss-story-list" class="series-chips series-chips-wrap" style="display:none;margin-top:10px"></div>
          <label class="input-label" style="margin-top:8px">篇名（可选，合集时填写或从上方点选）</label>
          <input class="input" id="ss-novel-story" placeholder="例如：海的女儿 / 丑小鸭…">
        </div>
        <div id="ss-source-upload-box" style="display:none;margin-top:10px">
          <label class="input-label">上传 .txt / .md（UTF-8 或 GBK）</label>
          <input class="input" type="file" id="ss-novel-file" accept=".txt,.text,.md,text/plain">
          <input class="input" id="ss-novel-title-upload" placeholder="书名（可留空，默认用文件名）" style="margin-top:8px">
        </div>
      </div>` : ''}

      <div class="series-field">
        <div class="series-label">篇幅</div>
        <div class="series-chips" id="ss-length">
          ${LENGTH_OPTIONS.map((o) => `
            <button type="button" class="series-chip ${o.key === 'medium' ? 'active' : ''}" data-val="${o.key}" onclick="seriesPickChip('ss-length',this)">
              ${o.label}<span>${o.sub}</span>
            </button>`).join('')}
        </div>
        <div class="series-mini" id="ss-length-import-hint" style="display:none;margin-top:6px">导入选的是压成几章可玩，不是原作篇幅；单篇童话可用极短，勿硬凑中长篇。</div>
      </div>

      <div id="ss-genre-era-wrap">
      <div class="series-field">
        <div class="series-label">类型（可多选叠加）</div>
        <div class="series-mini" style="margin-bottom:8px">预设可多选；下方自定义可与预设叠加，例如「悬疑 + 校园怪谈」。</div>
        <div class="series-chips series-chips-wrap" id="ss-genres">
          ${genres.filter((g) => g.key !== 'custom').map((g) => `
            <button type="button" class="series-chip" data-val="${escapeHtml(g.key)}" onclick="seriesToggleChip(this)">${escapeHtml(g.label)}</button>
          `).join('')}
        </div>
        <input class="input" id="ss-genres-custom" placeholder="自定义类型补充（可与上方叠加）…" style="margin-top:8px">
      </div>

      <div class="series-field">
        <div class="series-label">背景（时代或地点，可多选叠加）</div>
        <div class="series-mini" style="margin-bottom:8px">可选时代、地点；多选会叠加。下方自定义也可叠在预设上，例如「明朝 · 江南水乡」。</div>
        <div class="series-chips series-chips-wrap" id="ss-era">
          ${eras.filter((e) => e !== '自定义').map((e, i) => `
            <button type="button" class="series-chip ${i === 0 ? 'active' : ''}" data-val="${escapeHtml(e)}" onclick="seriesToggleChip(this)">${escapeHtml(e)}</button>
          `).join('')}
        </div>
        <input class="input" id="ss-era-custom" placeholder="自定义背景补充（可与上方叠加）…" style="margin-top:8px">
      </div>

      ${isIk ? `
      <div class="series-field">
        <label class="input-label">故事想法（可选）</label>
        <div class="series-mini" style="margin-bottom:8px">生成大纲时会读这里的建议：主线、关系、忌口、节奏等。不填则完全由 AI 按类型原创。</div>
        <textarea class="input" id="ss-premise" rows="4" placeholder="例如：慢热试探、不要失忆替身；她是新来的女官，他是冷面侍卫，宫宴投毒卷进储位之争……"></textarea>
      </div>` : ''}
      </div>

      ${isIk ? `
      <div class="series-field">
        <div class="series-label">扮演身份（可选）</div>
        <div class="series-mini">填写后大纲与定角会尽量按此生成；留空则由 AI 决定。性别不变：你女、TA 男。</div>
        <label class="input-label">TA · 剧中身份</label>
        <input class="input" id="ss-char-role" placeholder="例如：禁术调查员 / 冷面侍卫 / 权臣世子…">
        <label class="input-label" style="margin-top:8px">你 · 剧中身份</label>
        <input class="input" id="ss-user-role" placeholder="例如：新晋女官 / 医女 / 侧妃…（可女扮男装身份）">
        <div class="series-row-between" style="margin-top:12px">
          <div>
            <div class="series-label" style="margin:0">你锁定女主</div>
            <div class="series-mini">开=固定剧本女主；关=随机身份</div>
          </div>
          <label class="toggle"><input type="checkbox" id="ss-user-lead"><span class="toggle-slider"></span></label>
        </div>
        <div class="series-row-between" style="margin-top:10px">
          <div>
            <div class="series-label" style="margin:0">TA 锁定男主</div>
            <div class="series-mini">开=固定剧本男主；关=随机身份</div>
          </div>
          <label class="toggle"><input type="checkbox" id="ss-char-lead"><span class="toggle-slider"></span></label>
        </div>
        <div class="series-mini" style="margin-top:8px">都开=固定男女主；只开一侧=该侧主角、另一侧随机；都关=双方随机（可能是配角/真凶等）。</div>
      </div>` : `
      <div class="series-field">
        <div class="series-label">扮演身份</div>
        <div class="series-mini">姓名不变：TA 仍叫原名，你仍叫设置里的用户名；这里只填剧中身份/职业。</div>
        <div class="series-row-between">
          <span class="series-mini">盲盒（AI 决定身份）</span>
          <label class="toggle"><input type="checkbox" id="ss-blind"><span class="toggle-slider"></span></label>
        </div>
        <label class="input-label">TA · 男主身份</label>
        <input class="input" id="ss-char-role" placeholder="例如：禁术调查员 / 落魄世子…（不要改名）">
        <label class="input-label" style="margin-top:8px">你 · 女主身份（可女扮男）</label>
        <input class="input" id="ss-user-role" placeholder="例如：新晋法医 / 女扮男装的书童…（不要改名）">
      </div>`}

      <div class="series-field">
        <div class="series-row-between">
          <div>
            <div class="series-label" style="margin:0">NPC 自由补充</div>
            <div class="series-mini">关掉则只能用下方名单</div>
          </div>
          <label class="toggle"><input type="checkbox" id="ss-npc-free" checked><span class="toggle-slider"></span></label>
        </div>
        <div id="ss-npc-box" style="display:none;margin-top:10px">
          <div id="ss-npc-list"></div>
          <button type="button" class="btn btn-ghost btn-sm" onclick="seriesAddNpcRow()">＋ 添加 NPC</button>
        </div>
      </div>

      <div class="series-field">
        <div class="series-label">文风底色（同梦境）</div>
        <div class="series-chips series-chips-wrap" id="ss-style">
          ${STYLE_OPTIONS.map((s, i) => `
            <button type="button" class="series-chip ${i === 0 ? 'active' : ''}" data-val="${s.key}" onclick="seriesPickChip('ss-style',this)">${s.label}</button>
          `).join('')}
        </div>
        <div class="series-mini" style="margin-top:6px">默认「题材默认」：按所选类型自动匹配（言情/甜宠→浪漫或温柔、恐怖/惊悚/末日→黑暗、奇幻/志怪→超现实、武侠/宫斗/历史→古风等）。「超现实」= 意象跳跃、梦境/魔幻隐喻，不是科幻设定本身。</div>
        <div class="series-mini" style="margin:10px 0 6px">挂载文风（可多条叠加，选「自定义」时至少一条）</div>
        <div id="ss-style-list"></div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="seriesAddStyleRow()">＋ 添加文风</button>
      </div>

      <div class="series-field">
        <label class="input-label">${isIk ? '剧本名' : '剧集名'}（可留空，大纲时生成）</label>
        <input class="input" id="ss-title" placeholder="和${escapeHtml(char?.name || 'TA')}的${isIk ? '穿越' : '剧集'}">
      </div>

      ${!isIk ? `
      <div class="series-field" id="ss-premise-wrap">
        <label class="input-label">故事梗概（可选）</label>
        <div class="series-mini" style="margin-bottom:8px">自己写主线想法；模型会据此生成大纲与分章。不填则完全由 AI 原创。</div>
        <textarea class="input" id="ss-premise" rows="4" placeholder="例如：她是新来的女官，他是冷面侍卫；一场宫宴投毒把两人卷进储位情报战……"></textarea>
      </div>` : ''}

      <button type="button" class="btn btn-primary" style="width:100%;margin:8px 0 28px" onclick="seriesCreateBook()">${isIk ? '创建并生成大纲' : '创建并生成大纲'}</button>
    </div>
    ${busyMaskHtml()}
  `;

  document.getElementById('ss-npc-free')?.addEventListener('change', (e) => {
    document.getElementById('ss-npc-box').style.display = e.target.checked ? 'none' : 'block';
  });
  document.getElementById('ss-blind')?.addEventListener('change', (e) => {
    const dis = e.target.checked;
    const a = document.getElementById('ss-char-role');
    const b = document.getElementById('ss-user-role');
    if (a) a.disabled = dis;
    if (b) b.disabled = dis;
  });
};

window.seriesPickChip = function seriesPickChip(groupId, el) {
  document.querySelectorAll(`#${groupId} .series-chip`).forEach((c) => c.classList.remove('active'));
  el.classList.add('active');
};

window.seriesToggleChip = function seriesToggleChip(el) {
  el.classList.toggle('active');
};

window.seriesEraCustomToggle = function seriesEraCustomToggle() {
  // 自定义输入常显，可与预设叠加；保留函数以免旧 onclick 报错
  const inp = document.getElementById('ss-era-custom');
  if (inp) inp.style.display = 'block';
};

window.seriesSourceToggle = function seriesSourceToggle() {
  const v = document.querySelector('#ss-source .series-chip.active')?.dataset?.val || 'original';
  const titleBox = document.getElementById('ss-source-title-box');
  const uploadBox = document.getElementById('ss-source-upload-box');
  const genreEra = document.getElementById('ss-genre-era-wrap');
  const lengthHint = document.getElementById('ss-length-import-hint');
  const fromSource = v === 'title' || v === 'upload';
  if (titleBox) titleBox.style.display = v === 'title' ? 'block' : 'none';
  if (uploadBox) uploadBox.style.display = v === 'upload' ? 'block' : 'none';
  // 书名导入 / 上传小说跟原作走，不必选手动类型与背景
  if (genreEra) genreEra.style.display = fromSource ? 'none' : '';
  if (lengthHint) lengthHint.style.display = fromSource ? 'block' : 'none';
  if (v !== 'title') clearStoryList();
};

function clearStoryList() {
  window._listedStories = [];
  const list = document.getElementById('ss-story-list');
  if (list) {
    list.innerHTML = '';
    list.style.display = 'none';
  }
  const tip = document.getElementById('ss-list-stories-tip');
  if (tip) tip.textContent = '合集/单元剧可拉出名篇列表再点选';
}

function applySuggestLength(len) {
  const key = ['flash', 'short', 'medium', 'long'].includes(len) ? len : '';
  if (!key) return;
  const btn = document.querySelector(`#ss-length .series-chip[data-val="${key}"]`);
  if (btn) seriesPickChip('ss-length', btn);
}

window.seriesListStories = async function seriesListStories() {
  const title = document.getElementById('ss-novel-title')?.value?.trim() || '';
  if (!title) {
    window.showToast?.('请先填写书名');
    return;
  }
  const author = document.getElementById('ss-novel-author')?.value?.trim() || '';
  const btn = document.getElementById('ss-list-stories-btn');
  const tip = document.getElementById('ss-list-stories-tip');
  const list = document.getElementById('ss-story-list');
  if (btn) btn.disabled = true;
  if (tip) tip.textContent = '正在拉取篇目…';
  try {
    const res = await api.isekaiListStories({ title, author });
    const stories = Array.isArray(res?.stories) ? res.stories : [];
    window._listedStories = stories;
    if (!list) return;
    if (!stories.length) {
      list.innerHTML = '';
      list.style.display = 'none';
      const note = res?.note || '未能列出篇目，可手填篇名或直接创建';
      if (tip) tip.textContent = note;
      window.showToast?.(note);
      return;
    }
    list.style.display = 'flex';
    list.innerHTML = stories.map((s, i) => {
      const name = escapeHtml(s.name || '');
      const brief = escapeHtml(s.brief || '');
      return `<button type="button" class="series-chip" data-story-idx="${i}" title="${brief}" onclick="seriesPickListedStory(${i})">${name}</button>`;
    }).join('');
    if (tip) tip.textContent = `共 ${stories.length} 篇，点选填入篇名`;
  } catch (e) {
    window._listedStories = [];
    clearStoryList();
    window.showToast?.(e.message || '拉取篇目失败');
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.seriesPickListedStory = function seriesPickListedStory(idx) {
  const s = window._listedStories?.[idx];
  if (!s?.name) return;
  const inp = document.getElementById('ss-novel-story');
  if (inp) inp.value = s.name;
  document.querySelectorAll('#ss-story-list .series-chip').forEach((c) => {
    c.classList.toggle('active', Number(c.dataset.storyIdx) === Number(idx));
  });
  applySuggestLength(s.suggest_length || 'flash');
};

window.seriesAddNpcRow = function seriesAddNpcRow(name = '', relation = '') {
  const list = document.getElementById('ss-npc-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'series-npc-row';
  row.innerHTML = `
    <input class="input" data-npc-name placeholder="名字" value="${escapeHtml(name)}">
    <input class="input" data-npc-rel placeholder="身份/关系" value="${escapeHtml(relation)}">
    <button type="button" class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()">删</button>`;
  list.appendChild(row);
};

window.seriesAddStyleRow = function seriesAddStyleRow(title = '', text = '') {
  const list = document.getElementById('ss-style-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'series-style-row';
  row.innerHTML = `
    <input class="input" data-style-title placeholder="备注名（可选）" value="${escapeHtml(title)}">
    <textarea class="input" data-style-text rows="2" placeholder="文风要求，例如：对白冷淡短句、感官偏触觉…">${escapeHtml(text)}</textarea>
    <button type="button" class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()">删</button>`;
  list.appendChild(row);
};

function collectNpcs() {
  return [...document.querySelectorAll('#ss-npc-list .series-npc-row')].map((row) => ({
    name: row.querySelector('[data-npc-name]')?.value?.trim() || '',
    relation: row.querySelector('[data-npc-rel]')?.value?.trim() || '',
  })).filter((n) => n.name);
}

function collectStyleCustoms() {
  return [...document.querySelectorAll('#ss-style-list .series-style-row')].map((row) => ({
    title: row.querySelector('[data-style-title]')?.value?.trim() || '',
    text: row.querySelector('[data-style-text]')?.value?.trim() || '',
  })).filter((s) => s.text);
}

window.seriesCreateBook = async function seriesCreateBook() {
  if (_busy) return;
  const isIk = _mode === 'isekai';
  const isWhatif = _mode === 'whatif';
  const isIllusion = _mode === 'illusion';

  if (isIllusion) {
    const user_premise = document.getElementById('ss-premise')?.value?.trim() || '';
    const title = document.getElementById('ss-title')?.value?.trim() || '';
    const style = document.querySelector('#ss-style .series-chip.active')?.dataset?.val || 'gentle';
    setBusy(true, '创建幻象…');
    try {
      const book = await api.createSeriesBook({
        character_id: _charId,
        mode: 'illusion',
        title,
        user_premise,
        style,
      });
      const res = await api.illusionGenerate(book.id, { async: true });
      if (isAsyncJobResult(res)) {
        trackSeriesJob(res.job);
        window.showToast?.('幻象后台生成中，可先离开');
      }
      await openSeriesBook(book.id);
    } catch (e) {
      window.showToast?.(e.message || '创建失败');
    } finally {
      setBusy(false);
    }
    return;
  }

  if (isWhatif) {
    const whatif_background = document.getElementById('ss-whatif-bg')?.value?.trim() || '';
    const user_premise = document.getElementById('ss-premise')?.value?.trim() || '';
    const title = document.getElementById('ss-title')?.value?.trim() || '';
    const style = document.querySelector('#ss-style .series-chip.active')?.dataset?.val || 'genre';
    if (!whatif_background) {
      window.showToast?.('请填写背景设定');
      return;
    }
    if (!user_premise) {
      window.showToast?.('请填写「如果」前提');
      return;
    }
    setBusy(true, '创建情景…');
    try {
      const book = await api.createSeriesBook({
        character_id: _charId,
        mode: 'whatif',
        title,
        whatif_background,
        user_premise,
        style,
      });
      window.showToast?.('情景已创建');
      await openSeriesBook(book.id);
    } catch (e) {
      window.showToast?.(e.message || '创建失败');
    } finally {
      setBusy(false);
    }
    return;
  }

  const length_type = document.querySelector('#ss-length .series-chip.active')?.dataset?.val || 'medium';
  const genres = [...document.querySelectorAll('#ss-genres .series-chip.active')]
    .map((el) => el.dataset.val)
    .filter((v) => v && v !== 'custom');
  const genres_custom = document.getElementById('ss-genres-custom')?.value?.trim() || '';
  const eraSelected = [...document.querySelectorAll('#ss-era .series-chip.active')]
    .map((el) => el.dataset.val)
    .filter((v) => v && v !== '自定义' && v !== 'custom');
  const era_custom = document.getElementById('ss-era-custom')?.value?.trim() || '';
  const era = eraSelected.length ? eraSelected.join(' · ') : (era_custom ? '自定义' : '现代');
  const style = document.querySelector('#ss-style .series-chip.active')?.dataset?.val || 'genre';
  const style_customs = collectStyleCustoms();
  const blind = !!document.getElementById('ss-blind')?.checked;
  const npc_free = !!document.getElementById('ss-npc-free')?.checked;
  let char_role = document.getElementById('ss-char-role')?.value?.trim() || '';
  let user_role = document.getElementById('ss-user-role')?.value?.trim() || '';
  const user_lead_lock = isIk ? !!document.getElementById('ss-user-lead')?.checked : false;
  const char_lead_lock = isIk ? !!document.getElementById('ss-char-lead')?.checked : false;
  const sourceType = isIk
    ? (document.querySelector('#ss-source .series-chip.active')?.dataset?.val || 'original')
    : 'original';
  const novelTitle = document.getElementById('ss-novel-title')?.value?.trim() || '';
  const novelAuthor = document.getElementById('ss-novel-author')?.value?.trim() || '';
  const novelStory = document.getElementById('ss-novel-story')?.value?.trim() || '';
  const novelTitleUpload = document.getElementById('ss-novel-title-upload')?.value?.trim() || '';
  const novelFile = document.getElementById('ss-novel-file')?.files?.[0] || null;
  let bookTitle = document.getElementById('ss-title')?.value?.trim() || '';
  const user_premise = document.getElementById('ss-premise')?.value?.trim() || '';
  const fromSource = isIk && (sourceType === 'title' || sourceType === 'upload');

  if (!fromSource && !genres.length && !genres_custom) {
    window.showToast?.('请至少选一种类型，或填写自定义类型');
    return;
  }
  if (style === 'custom' && !style_customs.length) {
    window.showToast?.('选了自定义文风，请至少挂载一条');
    return;
  }
  if (!fromSource && !eraSelected.length && !era_custom) {
    window.showToast?.('请至少选一个背景，或填写自定义背景');
    return;
  }
  if (!isIk && !blind && (!char_role || !user_role)) {
    window.showToast?.('请填写男女主身份，或打开盲盒');
    return;
  }
  if (isIk && sourceType === 'title' && !novelTitle) {
    window.showToast?.('请填写要导入的书名');
    return;
  }
  if (isIk && sourceType === 'upload' && !novelFile) {
    window.showToast?.('请选择要上传的小说 txt');
    return;
  }
  if (isIk && sourceType === 'title' && !bookTitle) {
    bookTitle = novelStory ? `${novelTitle}·${novelStory}` : novelTitle;
  }
  if (isIk && sourceType === 'upload' && !bookTitle) {
    bookTitle = novelTitleUpload || String(novelFile?.name || '').replace(/\.(txt|text|md)$/i, '');
  }

  setBusy(true, isIk ? '创建穿越剧本…' : '创建剧集…');
  try {
    const createPayload = {
      character_id: _charId,
      mode: _mode,
      title: bookTitle,
      length_type,
      genres: fromSource ? [] : genres,
      genres_custom: fromSource ? '' : genres_custom,
      era: fromSource ? '原作' : era,
      era_custom: fromSource ? '' : era_custom,
      char_role: char_role,
      user_role: user_role,
      roles_blind: isIk ? (!user_role && !char_role) : blind,
      user_lead_lock: isIk ? user_lead_lock : undefined,
      char_lead_lock: isIk ? char_lead_lock : undefined,
      npc_free,
      npcs: collectNpcs(),
      style,
      style_customs,
      user_premise: user_premise,
    };
    if (isIk && sourceType === 'title') {
      createPayload.story_source = {
        type: 'title',
        title: novelTitle,
        author: novelAuthor,
        story: novelStory,
      };
    } else if (isIk && sourceType === 'upload') {
      createPayload.story_source = {
        type: 'upload',
        title: novelTitleUpload || bookTitle,
        file_name: novelFile.name,
      };
    }

    let book = await api.createSeriesBook(createPayload);

    if (isIk && sourceType === 'upload' && novelFile) {
      setBusy(true, '上传并解析小说…');
      book = await api.isekaiUploadNovel(book.id, novelFile, novelTitleUpload || bookTitle);
      const src = book?.story_source || {};
      if (!src.has_text && !(Number(src.chars) > 0)) {
        throw new Error('小说上传后未读到正文，请另存为 UTF-8/GBK 的 .txt 再试');
      }
    } else if (isIk && sourceType === 'title') {
      // 再写一次来源，确保落库（create 已带也可）
      book = await api.isekaiSetStorySource(book.id, {
        type: 'title',
        title: novelTitle,
        author: novelAuthor,
        story: novelStory,
      });
    }

    if (!isIk && blind) {
      setBusy(true, '盲盒抽取身份…');
      book = await api.seriesBlindRoles(book.id);
    }

    // 大纲后台跑：入队后即可离开，不阻塞在详情页
    setBusy(true, isIk && sourceType !== 'original' ? '按原作生成穿越大纲…' : (isIk ? '生成剧本大纲…' : '生成大纲…'));
    const outlineRes = isIk
      ? await api.isekaiGenerateOutline(book.id, { async: true })
      : await api.seriesGenerateOutline(book.id, { async: true });
    if (isAsyncJobResult(outlineRes)) {
      trackSeriesJob(outlineRes.job);
      window.showToast?.(sourceType === 'original'
        ? '大纲已在后台生成，可先离开，完成后会通知你'
        : '已按导入故事在后台生成大纲，可先离开');
    } else {
      window.showToast?.(isIk ? '剧本大纲已生成' : '大纲已生成');
    }
    await openSeriesBook(book.id);
  } catch (e) {
    window.showToast?.(e.message || '创建失败');
  } finally {
    setBusy(false);
  }
};

/* ─── 编剧问诊（穿越原创） ─── */
async function renderScreenwriterPage() {
  const page = document.getElementById('series-page');
  if (!page || !_book) return;
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let data;
  try {
    data = await api.getScreenwriterQuestions(_book.id);
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
    return;
  }
  if (!data.needed) {
    renderIsekaiBook();
    return;
  }

  const genres = data.genres_label || bookGenresDisplay(_book);
  const era = data.era_label || bookEraDisplay(_book);

  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="openSeriesModeHome('isekai')" title="返回"></button>
      <div class="topbar-title">编剧问诊</div>
      <div class="topbar-actions"></div>
    </div>
    <div class="scroll-area series-setup" id="sw-form">
      <div class="series-mini" style="margin:12px 0 16px;line-height:1.6">
        根据你选的 <strong>${escapeHtml(genres)}</strong>${era ? ` · ${escapeHtml(era)}` : ''} 问几个问题。
        构思结果<strong>不会展示给你</strong>，只用于后台生成大纲。
      </div>

      ${(data.questions || []).map((q) => `
        <div class="series-field" data-sw-q="${escapeHtml(q.id)}">
          <div class="series-label">${escapeHtml(q.text)}</div>
          ${q.type === 'multi'
            ? `<div class="series-chips series-chips-wrap sw-multi" data-qid="${escapeHtml(q.id)}">
                ${(q.options || []).map((opt) => `
                  <button type="button" class="series-chip" data-val="${escapeHtml(opt)}" onclick="this.classList.toggle('active')">${escapeHtml(opt)}</button>
                `).join('')}
              </div>`
            : `<div class="series-chips series-chips-wrap sw-single" data-qid="${escapeHtml(q.id)}">
                ${(q.options || []).map((opt) => `
                  <button type="button" class="series-chip" data-val="${escapeHtml(opt)}" onclick="screenwriterPickSingle(this)">${escapeHtml(opt)}</button>
                `).join('')}
              </div>`}
        </div>
      `).join('')}

      <div class="series-field">
        <div class="series-label">忌口（这本绝对不要什么）</div>
        <div class="series-chips series-chips-wrap" id="sw-taboos">
          ${(data.taboo_presets || []).map((t) => `
            <button type="button" class="series-chip" data-taboo-id="${escapeHtml(t.id)}" onclick="this.classList.toggle('active')">${escapeHtml(t.label)}</button>
          `).join('')}
        </div>
        <textarea class="input" id="sw-taboo-custom" rows="2" style="margin-top:8px" placeholder="还可自填，如：不要师生恋、不要失忆、不要怀孕…"></textarea>
      </div>

      <div class="series-mini" style="margin:8px 0 20px;color:var(--text-secondary)">
        与上一本太像？在忌口里写上「不要和上一本一样的××」也行。
      </div>

      <button type="button" class="btn btn-primary" style="width:100%;margin-bottom:8px" onclick="screenwriterSubmit()">确认并生成大纲</button>
      <button type="button" class="btn btn-ghost" style="width:100%;margin-bottom:28px" onclick="screenwriterSkip()">跳过问诊，直接生成</button>
    </div>
    ${busyMaskHtml()}
  `;
}

window.screenwriterPickSingle = function(el) {
  const wrap = el?.closest('.sw-single');
  if (!wrap) return;
  wrap.querySelectorAll('.series-chip').forEach((c) => c.classList.remove('active'));
  el.classList.add('active');
};

function collectScreenwriterAnswers(questions) {
  const answers = {};
  for (const q of questions || []) {
    const wrap = document.querySelector(`[data-sw-q="${q.id}"]`);
    if (!wrap) continue;
    if (q.type === 'multi') {
      const vals = [...wrap.querySelectorAll('.series-chip.active')].map((el) => el.dataset.val).filter(Boolean);
      if (vals.length) answers[q.id] = vals;
    } else {
      const hit = wrap.querySelector('.series-chip.active');
      if (hit?.dataset?.val) answers[q.id] = hit.dataset.val;
    }
  }
  return answers;
}

window.screenwriterSubmit = async function screenwriterSubmit() {
  if (_busy || !_book?.id) return;
  setBusy(true, '编剧构思中…');
  try {
    const qData = await api.getScreenwriterQuestions(_book.id);
    const answers = collectScreenwriterAnswers(qData.questions);
    const taboo_ids = [...document.querySelectorAll('#sw-taboos .series-chip.active')]
      .map((el) => el.dataset.tabooId).filter(Boolean);
    const taboo_custom = document.getElementById('sw-taboo-custom')?.value?.trim() || '';

    await api.submitScreenwriter(_book.id, { answers, taboo_ids, taboo_custom });

    setBusy(true, '生成剧本大纲…');
    const outlineRes = await api.isekaiGenerateOutline(_book.id, { async: true });
    if (isAsyncJobResult(outlineRes)) {
      trackSeriesJob(outlineRes.job);
      window.showToast?.('已根据你的选择构思故事，大纲后台生成中…');
    } else {
      window.showToast?.('剧本大纲已生成');
    }
    _book = await api.getSeriesBook(_book.id);
    renderIsekaiBook();
  } catch (e) {
    window.showToast?.(e.message || '提交失败');
  } finally {
    setBusy(false);
  }
};

window.screenwriterSkip = async function screenwriterSkip() {
  if (_busy || !_book?.id) return;
  setBusy(true, '跳过中…');
  try {
    await api.skipScreenwriter(_book.id);
    _book = await api.getSeriesBook(_book.id);
    window.showToast?.('已跳过编剧问诊');
    renderIsekaiBook();
  } catch (e) {
    window.showToast?.(e.message || '操作失败');
  } finally {
    setBusy(false);
  }
};

/* ─── 详情 / 章列表 ─── */
window.openSeriesBook = async function openSeriesBook(bookId) {
  _bookId = bookId;
  setBusy(true, '加载中…');
  try {
    _book = await api.getSeriesBook(bookId);
  } catch (e) {
    setBusy(false);
    window.showToast?.(e.message || '加载失败');
    return;
  }
  setBusy(false);
  _charId = _book.character_id;
  _mode = parseSeriesMode(_book.mode);
  // 进入详情时接上未完成的后台任务（离开页面也不会丢）
  resumeJobsForBook(bookId).catch(() => {});
  if (_mode === 'illusion') {
    await renderIllusionBook();
    return;
  }
  if (_mode === 'whatif') {
    renderWhatifBook();
    return;
  }
  if (_mode === 'isekai') {
    renderIsekaiBook();
    return;
  }

  const page = document.getElementById('series-page');
  const genres = bookGenresDisplay(_book);
  const era = bookEraDisplay(_book);
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="openSeriesModeHome('series')" title="返回"></button>
      <div class="topbar-title">${escapeHtml(_book.title || '剧集')}</div>
      <button type="button" class="topbar-action" onclick="seriesDeleteBook()" title="删除">删</button>
    </div>
    <div class="scroll-area series-detail">
      <div class="series-detail-head">
        <div class="series-detail-meta">${escapeHtml(_book.char_name || '')} · ${escapeHtml(lengthLabel(_book.length_type))} · ${statusLabel(_book.status)}</div>
        <div class="series-detail-roles">男主「${escapeHtml(_book.char_name || 'TA')}」：${escapeHtml(_book.char_role || '—')}<br>女主：${escapeHtml(_book.user_role || '—')}（姓名用设置里的用户名，不改名）</div>
        <div class="series-detail-tags">${escapeHtml(era)}${genres ? (era ? ' · ' : '') + escapeHtml(genres) : ''}</div>
        ${_book.user_premise ? `<div class="series-mini" style="margin-top:8px"><b>你的梗概</b>：${escapeHtml(_book.user_premise)}</div>` : ''}
        ${renderSpoilerOutlineBlock(_book)}
        ${_book.status === 'outlining' ? `<div class="series-mini" style="margin-top:8px">大纲后台生成中…可先离开</div>` : ''}
        ${!_book.book_outline && window._seriesLastError && Number(window._seriesLastErrorBookId) === Number(_book.id) ? `<div class="series-api-warn" style="margin-top:10px">${escapeHtml(window._seriesLastError)}</div>` : ''}
        ${!_book.book_outline && _book.status !== 'outlining' ? `<button type="button" class="btn btn-primary btn-sm" onclick="seriesRegenOutline()">生成大纲</button>` : ''}
      </div>
      <div class="series-sec-label">章节</div>
      <div class="series-chapter-list">
        ${(_book.chapters || []).map((ch) => {
          const done = ch.status === 'done';
          const gen = ch.status === 'generating';
          return `<div class="series-chapter-row ${done ? 'is-done' : ''}">
            <div class="series-chapter-main" onclick="openSeriesChapter(${ch.chapter_no})">
              <div class="series-chapter-no">第 ${ch.chapter_no} 章</div>
              <div class="series-chapter-title">${escapeHtml(ch.title || '')}</div>
              <div class="series-chapter-sub">${done ? `${ch.content_len || 0} 字` : gen ? '后台生成中…' : escapeHtml((ch.outline || '').slice(0, 48) || '待写')}</div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation();seriesStartChapter(${ch.chapter_no})">
              ${done ? '阅读' : gen ? '生成中' : '生成'}
            </button>
          </div>`;
        }).join('')}
      </div>
    </div>
    ${busyMaskHtml()}
  `;
};

function kindLabel(kind) {
  if (kind === 'female_lead') return '女主';
  if (kind === 'male_lead') return '男主';
  if (kind === 'npc') return 'NPC';
  return '未分配';
}

/** 全书梗概 / 阶段总纲：通关前隐藏，避免剧透 */
function renderSpoilerOutlineBlock(book) {
  const outline = String(book?.book_outline || '').trim();
  if (!outline) return '';
  if (book.status === 'done') {
    return `<div class="series-synopsis">${escapeHtml(outline)}</div>
        <div class="series-mini" style="margin-top:6px">通关后公开的全书梗概与阶段总纲。</div>`;
  }
  return `<div class="series-mini" style="margin-top:8px">全书梗概与阶段总纲已生成，通关后可查看。</div>`;
}

/** 详情页：背景预设 + 自定义叠加 */
function bookEraDisplay(book) {
  const base = String(book?.era || '').trim();
  const custom = String(book?.era_custom || '').trim();
  if (!base || base === '自定义' || base === 'custom') return custom;
  if (custom && !base.includes(custom)) return `${base} · ${custom}`;
  return base;
}

/** 详情页：类型预设标签 + 自定义叠加 */
function bookGenresDisplay(book) {
  const map = {
    romance_nsfw: '言情（可肉）',
    nsfw: '纯肉文',
    ...Object.fromEntries((_meta.genres || GENRE_FALLBACK).map((g) => [g.key, g.label])),
  };
  const labels = (Array.isArray(book?.genres) ? book.genres : [])
    .filter((g) => g && g !== 'custom')
    .map((g) => map[g] || g);
  const custom = String(book?.genres_custom || '').trim();
  if (custom) labels.push(custom);
  return labels.join(' · ');
}

async function renderIllusionBook() {
  const page = document.getElementById('series-page');
  const generating = !!(_book.illusion_generating || _book.status === 'writing' || _book.has_generating);
  const ready = !!_book.illusion_ready;
  let content = '';
  if (ready && !generating) {
    try {
      const ch = await api.getSeriesChapter(_bookId, 1);
      content = String(ch?.content || '');
    } catch { /* ignore */ }
  }
  const charCount = content.replace(/\s/g, '').length;
  const paras = formatSeriesProse(content);
  const err = window._seriesLastError && Number(window._seriesLastErrorBookId) === Number(_book.id)
    ? `<div class="series-api-warn" style="margin-top:10px">${escapeHtml(window._seriesLastError)}</div>`
    : '';
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="openSeriesModeHome('illusion')" title="返回"></button>
      <div class="topbar-title">${escapeHtml(_book.title || '幻象')}</div>
      <button type="button" class="topbar-action" onclick="seriesDeleteBook()" title="删除">删</button>
    </div>
    <div class="scroll-area series-reader" id="series-reader">
      <div class="series-detail-head" style="margin-bottom:12px">
        <div class="series-detail-meta">${escapeHtml(_book.char_name || '')} · 幻象${charCount ? ` · ${charCount} 字` : ''}</div>
        ${_book.user_premise ? `<div class="series-mini" style="margin-top:8px"><b>一起做</b>：${escapeHtml(_book.user_premise)}</div>` : '<div class="series-mini" style="margin-top:8px">TA 自己想的一场「和你一起」的幻想</div>'}
        ${generating ? `<div class="series-mini" style="margin-top:8px">后台生成中…可先离开，写完会通知</div>` : ''}
        ${err}
      </div>
      ${content ? `<article class="series-prose">${paras}</article>` : (!generating ? `<div class="empty-state" style="padding:32px 0"><div class="empty-text">还没有正文</div></div>` : '')}
      <div class="series-reader-nav" style="flex-wrap:wrap;gap:8px;margin-top:16px">
        ${generating
          ? `<button type="button" class="btn btn-ghost" disabled>生成中…</button>`
          : content
            ? `<button type="button" class="btn btn-ghost" onclick="illusionRewrite()">重写这场幻象</button>`
            : `<button type="button" class="btn btn-primary" onclick="illusionRewrite()">生成幻象</button>`}
      </div>
    </div>
    ${busyMaskHtml()}
  `;
}

window.illusionRewrite = async function illusionRewrite() {
  if (!_bookId || _busy) return;
  const had = !!_book?.illusion_ready;
  if (had && !confirm('重写这场幻象？旧文会被替换。')) return;
  try {
    setBusy(true, had ? '重写幻象…' : '生成幻象…');
    const res = await api.illusionGenerate(_bookId, { force: true, async: true });
    setBusy(false);
    if (isAsyncJobResult(res)) {
      trackSeriesJob(res.job);
      window.showToast?.('幻象后台生成中，可先离开');
      await openSeriesBook(_bookId);
      return;
    }
    window.showToast?.('已写完');
    await openSeriesBook(_bookId);
  } catch (e) {
    setBusy(false);
    window.showToast?.(e.message || '生成失败');
  }
};

function renderWhatifBook() {
  const page = document.getElementById('series-page');
  const started = !!_book.whatif_started;
  const ch = (_book.chapters || [])[0];
  const playing = ch?.status === 'playing';
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="openSeriesModeHome('whatif')" title="返回"></button>
      <div class="topbar-title">${escapeHtml(_book.title || '如果')}</div>
      <button type="button" class="topbar-action" onclick="seriesDeleteBook()" title="删除">删</button>
    </div>
    <div class="scroll-area series-detail">
      <div class="series-detail-head">
        <div class="series-detail-meta">${escapeHtml(_book.char_name || '')} · 如果 · ${statusLabel(_book.status)}</div>
        <div class="series-mini" style="margin-top:10px"><b>背景</b>：${escapeHtml(_book.whatif_background || '')}</div>
        <div class="series-mini" style="margin-top:8px"><b>如果</b>：${escapeHtml(_book.user_premise || '')}</div>
        <div class="series-mini" style="margin-top:12px">无大纲、无章节任务；根据你的行动即兴展开，背景会驱动随机插曲。</div>
        ${started
          ? `<button type="button" class="btn btn-primary" style="margin-top:16px;width:100%" onclick="openWhatifPlay()">${playing ? '继续情景' : '进入情景'}</button>
             <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px;width:100%" onclick="whatifRestart()">重新开始（清空进度）</button>`
          : `<button type="button" class="btn btn-primary" style="margin-top:16px;width:100%" onclick="whatifStartNow()">开始情景</button>`}
      </div>
    </div>
    ${busyMaskHtml()}
  `;
}

window.whatifStartNow = async function whatifStartNow() {
  if (!_bookId || _busy) return;
  setBusy(true, '生成开场…');
  try {
    await api.whatifStart(_bookId, {});
    window.showToast?.('情景已开始');
    await openWhatifPlay();
  } catch (e) {
    window.showToast?.(e.message || '开始失败');
  } finally {
    setBusy(false);
  }
};

window.whatifRestart = async function whatifRestart() {
  if (!_bookId || _busy) return;
  if (!confirm('重新开始会清空当前所有回合，确定？')) return;
  setBusy(true, '重新生成开场…');
  try {
    await api.whatifStart(_bookId, { force: true });
    window.showToast?.('已重新开始');
    await openWhatifPlay();
  } catch (e) {
    window.showToast?.(e.message || '失败');
  } finally {
    setBusy(false);
  }
};

function renderWhatifTurnHtml(t) {
  const charName = _book?.char_name || '同伴';
  const label = ({
    narration: '剧情',
    user: '你',
    char: charName,
    system: '插曲',
  })[t.kind] || t.kind;
  const body = escapeHtml(String(t.content || '')).replace(/\n/g, '<br>');
  if (!body) return '';
  return `<div class="isekai-turn isekai-turn-${escapeHtml(t.kind)}" data-turn-id="${Number(t.id) || ''}">
    <div class="isekai-turn-head"><div class="isekai-turn-label">${escapeHtml(label)}</div></div>
    <div class="isekai-turn-body">${body}</div>
  </div>`;
}

function appendWhatifTurns(turns) {
  const box = document.getElementById('whatif-turns');
  if (!box) return;
  const news = (turns || []).filter((t) => Number(t.id) > Number(_whatifLastTurnId || 0));
  if (!news.length) return;
  for (const t of news) {
    box.insertAdjacentHTML('beforeend', renderWhatifTurnHtml(t));
    const id = Number(t.id) || 0;
    if (id > _whatifLastTurnId) _whatifLastTurnId = id;
  }
  const sc = document.getElementById('whatif-play-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

window.openWhatifPlay = async function openWhatifPlay() {
  if (!_bookId || _busy) return;
  setBusy(true, '加载情景…');
  let data;
  try {
    const fresh = await api.getSeriesBook(_bookId);
    if (fresh) _book = fresh;
    if (!_book?.whatif_started) {
      setBusy(false);
      window.showToast?.('请先点「开始情景」');
      return;
    }
    data = await api.whatifGetPlay(_bookId);
    _book = data.book || _book;
  } catch (e) {
    setBusy(false);
    window.showToast?.(e.message || '加载失败');
    return;
  }
  setBusy(false);
  renderWhatifPlay(data);
};

function renderWhatifPlay(data) {
  const turns = data.turns || [];
  _whatifLastTurnId = Math.max(0, ...turns.map((t) => Number(t.id) || 0));
  const page = document.getElementById('series-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="leaveWhatifPlay()" title="返回"></button>
      <div class="topbar-title">${escapeHtml(_book.title || '如果')}</div>
      <div class="topbar-action" style="width:40px"></div>
    </div>
    <div class="scroll-area isekai-play" id="whatif-play-scroll">
      <div class="isekai-rolebar">
        <div class="series-mini"><b>如果</b>：${escapeHtml(_book.user_premise || '')}</div>
        <div class="series-mini" style="margin-top:6px"><b>背景</b>：${escapeHtml(_book.whatif_background || '')}</div>
        <div class="series-mini" style="margin-top:6px">与 ${escapeHtml(_book.char_name || 'TA')} 即兴演绎 · 进度自动保存</div>
      </div>
      <div id="whatif-turns">${turns.map(renderWhatifTurnHtml).join('')}</div>
      <div class="isekai-compose" id="whatif-compose">
        <textarea class="input" id="whatif-input" rows="3" placeholder="行动、对白、内心…一切随你"></textarea>
        <div class="isekai-compose-actions">
          <button type="button" class="btn btn-primary btn-sm" onclick="whatifSend()">发送</button>
        </div>
        <div class="series-mini">没有固定任务；系统会按背景偶尔插入随机插曲推动剧情。</div>
      </div>
    </div>
    ${busyMaskHtml()}
  `;
  const sc = document.getElementById('whatif-play-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

window.leaveWhatifPlay = function leaveWhatifPlay() {
  window.showToast?.('进度已保存，可随时继续');
  openSeriesBook(_bookId);
};

window.whatifSend = async function whatifSend() {
  if (!_bookId || _busy) return;
  const input = document.getElementById('whatif-input');
  const text = input?.value?.trim() || '';
  if (!text) {
    window.showToast?.('先写点什么');
    return;
  }
  setBusy(true, '续写中…');
  const beforeId = _whatifLastTurnId;
  try {
    const data = await api.whatifTurn(_bookId, { text });
    if (input) input.value = '';
    _whatifLastTurnId = beforeId;
    appendWhatifTurns(data.turns || []);
    if (data.event_injected) window.showToast?.('随机插曲已融入剧情');
  } catch (e) {
    window.showToast?.(e.message || '失败');
  } finally {
    setBusy(false);
  }
};

function sanitizeIdCardRelationLine(r) {
  return String(r || '').trim()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[，,、；;].*(?:有利害|开局|同场|碰面|会登场|推动主线|剧情角色|与主线).*/g, '')
    .replace(/(?:与她|与他|与你)?同场有利害[，,、]?/gi, '')
    .replace(/开局(?:就)?会碰面[，,、]?/gi, '')
    .trim();
}

function renderIsekaiIdCardInner(book) {
  if (!book) return '';
  const assigned = !!(book.isekai_begun || book.user_role);
  const card = book.user_identity_card || null;
  if (!assigned || !card) return '';
  const cardBrief = (card?.brief || book.user_surface_brief || '').trim() || '（身份待补充）';
  const ob = card?.opening_brief || {};
  const obSection = (label, items) => {
    const list = (items || []).map((x) => String(x || '').trim()).filter(Boolean);
    if (!list.length) return '';
    return `<div class="isekai-id-card-rel"><span>${escapeHtml(label)}</span><ul>${list.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`;
  };
  return `
      <div class="isekai-id-card">
        <div class="isekai-id-card-row"><span>姓名</span>${escapeHtml(card.name || book.user_role || '')}</div>
        <div class="isekai-id-card-row"><span>社会身份</span>${escapeHtml(cardBrief)}</div>
        ${(() => {
          const rels = (card.relations || [])
            .map((r) => sanitizeIdCardRelationLine(r))
            .filter((r) => r
              && !/^(与|和|跟).{1,12}(相识|认识|有往来|有联系|有一面之缘|一面之缘)$/.test(r)
              && !/一面之缘|有直接牵连|清楚.{0,8}名声|开局即知|推动主线|与主线|剧情角色|有利害|开局就会碰面|同场有利害|会登场/.test(r)
              && !/^知道.{1,12}$/.test(r));
          if (!rels.length) {
            return `<div class="isekai-id-card-rel"><span>关系</span><ul><li>暂无，剧情里再认人</li></ul></div>`;
          }
          return `<div class="isekai-id-card-rel"><span>关系</span><ul>${rels.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`;
        })()}
        ${obSection('开局所知', ob.knows)}
        ${obSection('手头/随身', ob.carries)}
        ${obSection('旁人期待', ob.pending)}
        ${obSection('须守住', ob.must_hide)}
        <div class="series-mini" style="margin-top:8px">社会身份是旁人认你的名分；关系只列主要剧中人与你的名分联系。真身份标签终章揭晓。</div>
      </div>`;
}

function isBookSituationTurn(t) {
  const meta = t?.meta && typeof t.meta === 'object' ? t.meta : {};
  const content = String(t?.content || '');
  return t?.kind === 'system' && (
    meta.type === 'situation'
    || /^【系统[·・.]?警告】/.test(content)
    || (/禁止对原住民暴露|禁止项：/.test(content) && /系统.?警告/.test(content))
  );
}

function dedupeWarnTurns(turns) {
  const seen = new Map();
  let situationBucket = null;
  for (const t of turns || []) {
    const isSit = isBookSituationTurn(t);
    const key = isSit
      ? 'book-situation'
      : String(t.content || '').trim().replace(/\s+/g, ' ').slice(0, 240);
    if (!key) continue;
    const ch = Number(t.chapter_no) || 0;
    if (isSit && situationBucket) {
      if (ch && !situationBucket.chapters.includes(ch)) situationBucket.chapters.push(ch);
      continue;
    }
    const entry = seen.get(key) || { turn: t, chapters: [] };
    if (ch && !entry.chapters.includes(ch)) entry.chapters.push(ch);
    seen.set(key, entry);
    if (isSit) situationBucket = entry;
  }
  return [...seen.values()].sort((a, b) => {
    const ai = Math.min(...(a.chapters.length ? a.chapters : [0]));
    const bi = Math.min(...(b.chapters.length ? b.chapters : [0]));
    return ai - bi;
  });
}

function renderIsekaiBookCapsules(book) {
  const assigned = !!(book?.isekai_begun || book.user_role);
  if (!assigned) return '';
  const idInner = renderIsekaiIdCardInner(book);
  const deduped = dedupeWarnTurns(book?.warn_turns || []);
  const violationCount = deduped.filter(({ turn }) => isIsekaiViolationTurn(turn)).length;
  const warnLabel = violationCount
    ? `系统警告 · ${violationCount}`
    : (deduped.length ? `系统提示 · ${deduped.length}` : '系统警告');
  const warnPanel = deduped.length
    ? deduped.map(({ turn, chapters }) => {
        const sit = isBookSituationTurn(turn);
        const chHint = !sit && chapters.length
          ? `<div class="series-mini" style="margin:6px 0 2px">出现于：第 ${chapters.join('、')} 章</div>`
          : '';
        return chHint + renderTurnHtml(turn);
      }).join('')
    : '<div class="series-mini">暂无记录。本章若违规会直接在章节里弹出。</div>';
  return `
        <div class="isekai-capsule-row">
          ${idInner ? `<button type="button" class="isekai-capsule" data-capsule="id-card" onclick="toggleIsekaiCapsule('id-card')">身份卡</button>` : ''}
          <button type="button" class="isekai-capsule" data-capsule="warns" onclick="toggleIsekaiCapsule('warns')">${escapeHtml(warnLabel)}</button>
        </div>
        ${idInner ? `<div id="isekai-capsule-id-card" class="isekai-capsule-panel">${idInner}</div>` : ''}
        <div id="isekai-capsule-warns" class="isekai-capsule-panel isekai-warn-zone--book">${warnPanel}</div>`;
}

window.toggleIsekaiCapsule = function toggleIsekaiCapsule(key) {
  const panel = document.getElementById(`isekai-capsule-${key}`);
  const btn = document.querySelector(`.isekai-capsule[data-capsule="${key}"]`);
  if (!panel) return;
  const open = !panel.classList.contains('is-open');
  document.querySelectorAll('.isekai-capsule-panel.is-open').forEach((el) => el.classList.remove('is-open'));
  document.querySelectorAll('.isekai-capsule.active').forEach((el) => el.classList.remove('active'));
  if (open) {
    panel.classList.add('is-open');
    if (btn) btn.classList.add('active');
  }
};

function isIsekaiWarnTurn(t) {
  const meta = t?.meta && typeof t.meta === 'object' ? t.meta : {};
  const sysType = meta.type || '';
  const content = String(t?.content || '');
  const isSituation = t.kind === 'system' && (sysType === 'situation' || /^【系统[·・.]?警告】/.test(content));
  const isPenalty = t.kind === 'system' && !isSituation
    && (sysType === 'warn' || sysType === 'shock' || /系统·惩罚|【系统·惩戒】/.test(content));
  const isAnchorWarn = t.kind === 'system' && (sysType === 'anchor_warn' || /【系统·因果警戒】/.test(content));
  return isSituation || isPenalty || isAnchorWarn;
}

/** 章节内只弹出真实违规（惩罚/因果），不重复展示每章雷同的「局面警告」 */
function isIsekaiViolationTurn(t) {
  if (isBookSituationTurn(t)) return false;
  const meta = t?.meta && typeof t.meta === 'object' ? t.meta : {};
  const sysType = meta.type || '';
  const content = String(t?.content || '');
  if (sysType === 'warn' || sysType === 'shock') return true;
  if (/系统·惩罚|【系统·惩戒】/.test(content)) return true;
  if (sysType === 'anchor_warn' || /【系统·因果警戒】/.test(content)) return true;
  return false;
}

function filterTurnsForChapterPlay(turns) {
  return (turns || []).filter((t) => !isIsekaiWarnTurn(t) || isIsekaiViolationTurn(t));
}

function partitionIsekaiTurns(turns) {
  const warns = [];
  const rest = [];
  for (const t of turns || []) {
    if (isIsekaiWarnTurn(t)) warns.push(t);
    else rest.push(t);
  }
  return { warns, rest };
}

function filterArriveForPlay(arrive) {
  return (arrive || []).filter((t) => {
    const meta = t?.meta?.type || '';
    if (meta === 'identity_card') return false;
    if (isBookSituationTurn(t) && !isIsekaiViolationTurn(t)) return false;
    return true;
  });
}

function renderIsekaiBook() {
  const page = document.getElementById('series-page');
  const genres = bookGenresDisplay(_book);
  const era = bookEraDisplay(_book);
  const assigned = !!(_book.isekai_begun || _book.user_role);
  const hasOutline = !!(_book.book_outline && String(_book.book_outline).trim())
    || ['outlined', 'writing', 'done'].includes(_book.status);
  const errHtml = window._seriesLastError && Number(window._seriesLastErrorBookId) === Number(_book.id)
    ? `<div class="series-api-warn" style="margin-top:10px">${escapeHtml(window._seriesLastError)}</div>`
    : '';
  const prefs = _book.role_prefs || {};
  const prefsHtml = (!assigned && (prefs.user_brief || prefs.char_brief || prefs.user_lead_lock || prefs.char_lead_lock)) ? `
          <div class="series-mini" style="margin-top:10px">创建创建 创建偏好：
            你${prefs.user_lead_lock ? '·锁定女主' : ''}
            ${prefs.user_brief ? `「${escapeHtml(prefs.user_brief)}」` : (prefs.user_lead_lock ? '' : '·随机')}
            · TA${prefs.char_lead_lock ? '·锁定男主' : ''}
            ${prefs.char_brief ? `「${escapeHtml(prefs.char_brief)}」` : (prefs.char_lead_lock ? '' : '·随机')}
          </div>` : '';

  const castList = Array.isArray(_book.cast_list) ? _book.cast_list : [];
  const castPickHtml = (!assigned && hasOutline) ? `
          <div class="series-field" style="margin-top:14px" id="isekai-cast-pick">
            <div class="series-label">剧中角色（可选）</div>
            <div class="series-mini">从角色池点选你与同伴要扮演的人；不选则开始时随机（会尊重上方主角锁与身份偏好）。性别不变：你选女角，同伴选男角。</div>
            ${prefsHtml}
            <div class="series-mini" style="margin:10px 0 6px">你（女）</div>
            <div class="series-chips series-chips-wrap" id="isekai-pick-user">
              <button type="button" class="series-chip active" data-cast-name="" onclick="isekaiPickCast('user', this)">随机</button>
              ${castList.filter((c) => c.gender === 'female').map((c) => `
                <button type="button" class="series-chip" data-cast-name="${escapeHtml(c.name)}" title="${escapeHtml(c.brief || '')}" onclick="isekaiPickCast('user', this)">${escapeHtml(c.name)}${c.brief ? `<span>${escapeHtml(c.brief)}</span>` : ''}</button>
              `).join('')}
            </div>
            <div class="series-mini" style="margin:10px 0 6px">同伴（男）</div>
            <div class="series-chips series-chips-wrap" id="isekai-pick-char">
              <button type="button" class="series-chip active" data-cast-name="" onclick="isekaiPickCast('char', this)">随机</button>
              ${castList.filter((c) => c.gender === 'male').map((c) => `
                <button type="button" class="series-chip" data-cast-name="${escapeHtml(c.name)}" title="${escapeHtml(c.brief || '')}" onclick="isekaiPickCast('char', this)">${escapeHtml(c.name)}${c.brief ? `<span>${escapeHtml(c.brief)}</span>` : ''}</button>
              `).join('')}
            </div>
            <div class="series-mini" id="isekai-cast-pick-tip" style="margin-top:8px">当前：你随机 · 同伴随机</div>
            <button type="button" class="btn btn-primary" style="margin-top:12px;width:100%" onclick="isekaiBeginNow()">开始穿越</button>
          </div>` : '';

  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="openSeriesModeHome('isekai')" title="返回"></button>
      <div class="topbar-title">${escapeHtml(_book.title || '穿越')}</div>
      <button type="button" class="topbar-action" onclick="seriesDeleteBook()" title="删除">删</button>
    </div>
    <div class="scroll-area series-detail">
      <div class="series-detail-head">
        <div class="series-detail-meta">${escapeHtml(_book.char_name || '')} · 穿越 · ${escapeHtml(lengthLabel(_book.length_type))} · ${statusLabel(_book.status)}</div>
        ${(() => {
          const src = _book.story_source || {};
          const adapted = src.type === 'title' || src.type === 'upload';
          if (adapted) return '';
          return `<div class="series-detail-tags">${escapeHtml(era)}${genres ? (era ? ' · ' : '') + escapeHtml(genres) : ''}</div>`;
        })()}
        ${(() => {
          const src = _book.story_source || {};
          if (src.type === 'title' && src.title) {
            const story = src.story ? ` · ${escapeHtml(src.story)}` : '';
            const author = src.author ? ` · ${escapeHtml(src.author)}` : '';
            return `<div class="series-mini" style="margin-top:6px">故事来源：书名导入《${escapeHtml(src.title)}》${story}${author}</div>`;
          }
          if (src.type === 'upload') {
            const ok = src.has_text || Number(src.chars) > 0;
            return `<div class="series-mini" style="margin-top:6px">故事来源：上传小说${src.title ? `《${escapeHtml(src.title)}》` : ''}${src.file_name ? `（${escapeHtml(src.file_name)}）` : ''}${src.chars ? ` · ${src.chars} 字` : ''}${ok ? '' : ' · ⚠️ 正文未写入，请新建并重传'}</div>`;
          }
          return '';
        })()}
        ${_book.user_premise ? `<div class="series-mini" style="margin-top:8px"><b>故事想法</b>：${escapeHtml(_book.user_premise)}</div>` : ''}
        ${renderSpoilerOutlineBlock(_book)}
        ${_book.status === 'outlining' ? `<div class="series-mini" style="margin-top:8px">剧本大纲后台生成中…可先离开</div>` : ''}
        ${errHtml}
        ${!_book.book_outline && _book.status !== 'outlining' ? `<button type="button" class="btn btn-primary btn-sm" onclick="isekaiRegenOutline()">生成剧本大纲</button>` : ''}
        ${_book.book_main_quest ? `<div class="series-synopsis" style="margin-top:10px"><strong>全书主线</strong><br>${escapeHtml(_book.book_main_quest)}</div>` : ''}
        ${renderIsekaiBookCapsules(_book)}
        ${castPickHtml || (hasOutline ? `
          <div class="series-mini" style="margin-top:10px">大纲已写好；点「开始穿越」分配身份</div>
          <button type="button" class="btn btn-primary" style="margin-top:12px;width:100%" onclick="isekaiBeginNow()">开始穿越</button>
        ` : `
          <div class="series-mini" style="margin-top:10px">生成大纲后，可从角色池点选剧中身份（也可不选，随机）</div>
        `)}
      </div>
      ${hasOutline ? `
      <div class="series-sec-label">章节</div>
      ${!assigned
        ? `<div class="series-mini" style="margin-bottom:8px">先开始穿越，再点右侧「生成」预开场</div>`
        : `<div class="series-mini" style="margin-bottom:8px">右侧「生成」后台写开场；违规会在章节内直接提示</div>`}
      <div class="series-chapter-list">
        ${(_book.chapters || []).map((ch) => {
          const done = ch.status === 'done';
          const playing = ch.status === 'playing';
          const gen = ch.status === 'generating';
          const ready = done || playing;
          const sub = !assigned
            ? escapeHtml((ch.outline || '').slice(0, 48) || '大纲已成 · 待穿越')
            : (done ? '已通关 · 可回顾' : gen ? '开场后台生成中…' : playing ? '开场已就绪 · 可进入' : escapeHtml((ch.outline || '').slice(0, 48) || '待生成开场'));
          const rightBtn = !assigned
            ? '待解锁'
            : (gen ? '重试' : ready ? (done ? '回顾' : '进入') : '生成');
          const rightClick = !assigned
            ? `openIsekaiPlay(${ch.chapter_no})`
            : (ready
              ? `openIsekaiPlay(${ch.chapter_no})`
              : `isekaiGenerateChapter(${ch.chapter_no}${gen ? ', true' : ''})`);
          return `<div class="series-chapter-row ${done ? 'is-done' : ''}${ready && !done ? ' is-ready' : ''}${!assigned ? ' is-locked' : ''}">
            <div class="series-chapter-main" onclick="openIsekaiPlay(${ch.chapter_no})">
              <div class="series-chapter-no">第 ${ch.chapter_no} 章</div>
              <div class="series-chapter-title">${escapeHtml(ch.title || '')}</div>
              <div class="series-chapter-sub">${sub}</div>
            </div>
            <div class="series-chapter-actions">
              ${ready && assigned && !done ? `<button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation();isekaiGenerateChapter(${ch.chapter_no}, true)" title="重新生成开场会清空本章进度">再生成</button>` : ''}
              <button type="button" class="btn ${ready ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="event.stopPropagation();${rightClick}">
                ${rightBtn}
              </button>
            </div>
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>
    ${busyMaskHtml()}
  `;
}

window.isekaiRegenOutline = async function isekaiRegenOutline() {
  if (!_bookId || _busy) return;
  try {
    const src = _book?.story_source || {};
    if (src.type === 'upload' && !src.has_text && !(Number(src.chars) > 0)) {
      window.showToast?.('这部穿越标记了上传小说，但正文为空。请新建一本并重新上传 txt');
      return;
    }
    if (src.type === 'title' && !src.title) {
      window.showToast?.('书名为空，请新建时重新填写书名，或改用上传小说');
      return;
    }
    const res = await api.isekaiGenerateOutline(_bookId, { async: true });
    if (isAsyncJobResult(res)) {
      trackSeriesJob(res.job);
      window.showToast?.(src.type === 'original'
        ? '大纲后台生成中，可先离开'
        : '正在按导入故事生成大纲，可先离开');
    } else {
      window.showToast?.('大纲已生成');
    }
    await openSeriesBook(_bookId);
  } catch (e) {
    window.showToast?.(e.message || '失败');
  }
};

window.isekaiPickCast = function isekaiPickCast(side, el) {
  if (!el) return;
  const name = el.dataset.castName || '';
  const groupId = side === 'char' ? 'isekai-pick-char' : 'isekai-pick-user';
  const otherId = side === 'char' ? 'isekai-pick-user' : 'isekai-pick-char';
  document.querySelectorAll(`#${groupId} .series-chip`).forEach((c) => c.classList.remove('active'));
  el.classList.add('active');
  // 互斥：另一侧若选了同名，打回随机
  if (name) {
    const otherActive = document.querySelector(`#${otherId} .series-chip.active`);
    if (otherActive && otherActive.dataset.castName === name) {
      const rand = document.querySelector(`#${otherId} .series-chip[data-cast-name=""]`);
      document.querySelectorAll(`#${otherId} .series-chip`).forEach((c) => c.classList.remove('active'));
      if (rand) rand.classList.add('active');
      window.showToast?.('你和同伴不能选同一个人');
    }
  }
  const u = document.querySelector('#isekai-pick-user .series-chip.active')?.dataset?.castName || '';
  const c = document.querySelector('#isekai-pick-char .series-chip.active')?.dataset?.castName || '';
  const tip = document.getElementById('isekai-cast-pick-tip');
  if (tip) tip.textContent = `当前：你 ${u || '随机'} · 同伴 ${c || '随机'}`;
};

window.isekaiBeginNow = async function isekaiBeginNow() {
  if (!_bookId || _busy) return;
  const userCast = document.querySelector('#isekai-pick-user .series-chip.active')?.dataset?.castName || '';
  const charCast = document.querySelector('#isekai-pick-char .series-chip.active')?.dataset?.castName || '';
  if (userCast && charCast && userCast === charCast) {
    window.showToast?.('你和同伴不能选同一个人');
    return;
  }
  try {
    setBusy(true, '正在穿越…');
    const res = await api.isekaiBegin(_bookId, {
      async: true,
      user_cast_name: userCast || undefined,
      char_cast_name: charCast || undefined,
    });
    if (isAsyncJobResult(res)) {
      trackSeriesJob(res.job);
      setBusy(false);
      window.showToast?.('正在后台分配身份，完成后可点各章「生成」');
      await openSeriesBook(_bookId);
      return;
    }
    _book = res;
    setBusy(false);
    window.showToast?.('已落入剧本世界，可点第 1 章「生成」开场');
    await openSeriesBook(_bookId);
  } catch (e) {
    setBusy(false);
    window.showToast?.(e.message || '穿越失败');
  }
};

/** 后台预生成穿越章开场（不自动进入） */
window.isekaiGenerateChapter = async function isekaiGenerateChapter(no, force = false) {
  if (!_bookId || _busy) return;
  if (!_book?.isekai_begun && !_book?.user_role) {
    try { _book = await api.getSeriesBook(_bookId); } catch (_) {}
  }
  if (!_book?.isekai_begun && !_book?.user_role) {
    window.showToast?.('请先点「开始穿越」发放身份卡');
    return;
  }
  const ch = (_book?.chapters || []).find((c) => Number(c.chapter_no) === Number(no));
  if (ch?.status === 'generating' && !force) {
    window.showToast?.('开场正在后台生成，请稍候');
    return;
  }
  if (ch?.status === 'done') {
    window.showToast?.('本章已通关，不能重开。若要重玩请新建穿越本');
    return;
  }
  if (force && ch?.status === 'playing') {
    if (!confirm(`重新生成第 ${no} 章开场？本章已有进度会被清空。`)) return;
  }
  try {
    setBusy(true, `第 ${no} 章开场排队…`);
    const started = await api.isekaiStartChapter(_bookId, no, { force: !!force || ch?.status === 'generating', async: true });
    setBusy(false);
    if (isAsyncJobResult(started)) {
      trackSeriesJob(started.job);
      window.showToast?.(`第 ${no} 章开场后台生成中，可先离开`);
      await openSeriesBook(_bookId);
      return;
    }
    window.showToast?.(`第 ${no} 章开场已就绪，可点进入`);
    await openSeriesBook(_bookId);
  } catch (e) {
    setBusy(false);
    window.showToast?.(e.message || '生成失败');
    try { await openSeriesBook(_bookId); } catch (_) {}
  }
};

function stripIsekaiLeakClient(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  const looksJsonDoc = /^\s*\{/.test(t)
    && /"(narration|content|text|reply)"\s*:/.test(t)
    && t.length < 12000;
  if (looksJsonDoc) {
    try {
      const o = JSON.parse(t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
      const pulled = String(o.narration || o.content || o.text || o.reply || '').trim();
      if (pulled) t = pulled;
    } catch (_) { /* keep */ }
  }
  t = t.replace(/^\s*"(?:narration|slack_ok|system_notice|focus)"\s*:\s*\S.*$/gim, '').trim();
  return t;
}

/** 旧数据：剧情卡里夹着系统面板时，渲染前拆成多张虚拟卡 */
function expandMixedTurn(t) {
  const meta = t.meta && typeof t.meta === 'object' ? t.meta : {};
  if (!['narration', 'char', 'whisper_char'].includes(t.kind)) return [t];
  const raw = String(t.content || '');
  if (!/【系统[·・.]?(警告|任务|惩罚)】/.test(raw)) return [t];
  const panels = [];
  let prose = raw;
  prose = prose.replace(/【系统[·・.]?警告】([\s\S]*?)(?=(?:\n【|\n*$))/g, () => '\n');
  prose = prose.replace(/【系统[·・.]?任务】([\s\S]*?)(?=(?:\n【|\n*$))/g, () => '\n');
  prose = prose.replace(/【系统[·・.]?惩罚】([\s\S]*?)(?=(?:\n【|\n*$))/g, (_, body) => {
    panels.push({
      kind: 'system',
      content: `【系统·惩罚】${body}`.trim(),
      meta: { type: 'warn' },
      id: t.id,
    });
    return '\n';
  });
  prose = stripIsekaiLeakClient(prose).replace(/\n{3,}/g, '\n\n').trim();
  const out = [];
  // 系统面板先于剧情展示更清晰
  out.push(...panels);
  if (prose) out.push({ ...t, content: prose, meta });
  return out.length ? out : [t];
}

function updateIsekaiComposePending(on) {
  const compose = document.getElementById('isekai-compose');
  if (!compose) return;
  let banner = compose.querySelector('.isekai-turn-pending-banner');
  const sendBtn = compose.querySelector('[onclick="isekaiSend()"]');
  if (on) {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'isekai-turn-pending-banner series-mini';
      banner.style.marginBottom = '8px';
      banner.textContent = '续写生成中…可先离开，完成后会通知你';
      compose.insertBefore(banner, compose.firstChild);
    }
    if (sendBtn) sendBtn.disabled = true;
  } else {
    banner?.remove();
    if (sendBtn) sendBtn.disabled = false;
  }
}

function applyIsekaiTurnQuestUi(data) {
  const quest = data?.quest || data?.chapter?.quest;
  const compose = document.getElementById('isekai-compose');
  if (compose && quest?.effects) {
    const ta = document.getElementById('isekai-input');
    let ban = compose.querySelector('.isekai-mute-banner');
    if (quest.effects.user_muted) {
      if (ta) ta.placeholder = '禁言中…只写动作（不要对白）';
      if (!ban) {
        ban = document.createElement('div');
        ban.className = 'isekai-mute-banner';
        ban.style.marginBottom = '8px';
        compose.insertBefore(ban, compose.firstChild);
      }
      ban.textContent = '本章禁言：只能写动作，不能写带引号或「说道」的对白。';
    } else if (ban) {
      ban.remove();
      if (ta) ta.placeholder = '以剧本身份行动/说话…系统会检测违规';
    }
  }
  const sealed = data?.chapter?.status === 'done';
  if (sealed) {
    window.showToast?.('本章已完成，可进入下一章');
    applyIsekaiChapterClearedUi(data.chapter?.chapter_no || _playNo);
  } else if (quest?.chapter_done || quest?.main_done) {
    window.showToast?.('本章情节已落定，请点「完成本章」结算后再进入下一章');
    const finishBtn = document.querySelector('#isekai-compose .btn[onclick="isekaiFinishChapter()"]');
    finishBtn?.classList.add('btn-primary');
    finishBtn?.classList.remove('btn-ghost');
  }
}

function clearIsekaiTurnPendingState() {
  _isekaiTurnPending = false;
  updateIsekaiComposePending(false);
}

async function syncIsekaiTurnPendingFromJobs() {
  if (!_bookId || !_playNo) return;
  try {
    const jobs = await api.getSeriesJobs(_bookId);
    const pending = (jobs || []).find(
      (j) => j.kind === 'isekai_turn'
        && Number(j.chapter_no) === Number(_playNo)
        && (j.status === 'queued' || j.status === 'running'),
    );
    if (pending) {
      _isekaiTurnPending = true;
      trackSeriesJob(pending);
      updateIsekaiComposePending(true);
    } else {
      clearIsekaiTurnPendingState();
    }
  } catch (_) { /* ignore */ }
}

async function refreshIsekaiPlayAfterTurnJob(data) {
  if (!_bookId || !_playNo || Number(_playNo) !== Number(data?.chapterNo)) return;
  clearIsekaiTurnPendingState();
  if (!document.getElementById('isekai-play-scroll')) return;
  try {
    const playData = await api.isekaiGetChapter(_bookId, _playNo);
    appendIsekaiTurns(playData.turns || []);
    applyIsekaiTurnQuestUi(playData);
  } catch (_) { /* ignore */ }
}

function appendIsekaiTurns(turns) {
  const mainBox = document.getElementById('isekai-turns');
  if (!mainBox) return;
  const news = filterTurnsForChapterPlay(turns).filter((t) => Number(t.id) > Number(_isekaiLastTurnId || 0));
  if (!news.length) return;
  mainBox.insertAdjacentHTML('beforeend', renderTurnsHtml(news));
  for (const t of news) {
    const id = Number(t.id) || 0;
    if (id > _isekaiLastTurnId) _isekaiLastTurnId = id;
  }
  const sc = document.getElementById('isekai-play-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

function renderTurnHtml(t) {
  const meta = t.meta && typeof t.meta === 'object' ? t.meta : {};
  const sysType = meta.type || '';
  const isSituation = t.kind === 'system' && (sysType === 'situation' || /^【系统[·・.]?警告】/.test(String(t.content || '')));
  const isPenalty = t.kind === 'system' && !isSituation && (sysType === 'warn' || sysType === 'shock' || /系统·惩罚|【系统·惩戒】/.test(String(t.content || '')));
  const isWarn = isPenalty;
  const isClear = t.kind === 'system' && (sysType === 'chapter_clear' || sysType === 'book_clear' || /本章剧情已完成|全书通关/.test(t.content || ''));
  const isRecap = t.kind === 'system' && (sysType === 'prev_recap' || sysType === 'chapter_recap');
  const isAnchorWarn = t.kind === 'system' && (sysType === 'anchor_warn' || /【系统·因果警戒】/.test(String(t.content || '')));
  const isAnchorFork = t.kind === 'system' && (sysType === 'anchor_fork' || /【系统·世界线变动】/.test(String(t.content || '')));
  const canRegen = t.id && ['narration', 'char', 'whisper_char'].includes(t.kind);
  const cls = [
    'isekai-turn',
    `isekai-turn-${escapeHtml(t.kind)}`,
    isWarn ? 'is-warn' : '',
    isClear ? 'is-clear' : '',
    sysType === 'binding' ? 'is-bind' : '',
    sysType === 'identity_card' ? 'is-id-card' : '',
    isSituation ? 'is-situation' : '',
    isRecap ? 'is-recap' : '',
    isAnchorWarn ? 'is-anchor-warn' : '',
    isAnchorFork ? 'is-anchor-fork' : '',
    sysType === 'book_clear' ? 'is-book-clear' : '',
  ].filter(Boolean).join(' ');
  // 同伴气泡用剧中名；身份卡仍不展示同伴侧
  const charName = _book?.char_role || '同伴';
  const label = t.kind === 'system'
    ? (isSituation ? '系统·警告'
      : isPenalty ? '系统·惩罚'
      : sysType === 'briefing' ? '系统·局面'
      : sysType === 'identity_card' ? '身份卡'
      : sysType === 'binding' ? '系统绑定'
      : sysType === 'chapter_clear' ? '系统·过章'
      : sysType === 'book_clear' ? '系统·通关'
      : sysType === 'prev_recap' ? '前情提要'
      : sysType === 'memory_stage' ? '系统·记忆'
      : sysType === 'anchor_warn' || isAnchorWarn ? '系统·因果'
      : sysType === 'anchor_fork' || isAnchorFork ? '系统·世界线'
      : sysType === 'chapter_recap' ? '本章总结'
      : sysType === 'notice' ? '系统' : '系统')
    : ({
      narration: '剧情',
      user: '你',
      char: charName,
      whisper_user: '摸鱼·你',
      whisper_char: `摸鱼·${charName}`,
    })[t.kind] || t.kind;
  // 开章任务 briefing 已用独立任务卡展示，避免重复
  if (t.kind === 'system' && sysType === 'briefing') return '';
  // 身份卡改在章节顶栏固定展示，不再作为回合卡重复出现
  if (t.kind === 'system' && sysType === 'identity_card') return '';
  let content = String(t.content || '');
  // 标签已写明类型时，去掉正文里的重复标题行
  if (isSituation) content = content.replace(/^【系统[·・.]?警告】\s*/m, '');
  if (isPenalty) content = content.replace(/^【系统[·・.]?惩罚】\s*/m, '');
  if (isAnchorWarn) content = content.replace(/^【系统·因果警戒】\s*/m, '');
  if (isAnchorFork) content = content.replace(/^【系统·世界线变动】\s*/m, '');
  if (sysType === 'binding') content = content.replace(/^【系统绑定[^\n]*】\s*/m, '');
  const body = escapeHtml(stripIsekaiLeakClient(content)).replace(/\n/g, '<br>');
  if (!body) return '';
  const regenBtn = canRegen
    ? `<button type="button" class="isekai-regen-btn" onclick="event.stopPropagation();isekaiRegenTurn(${Number(t.id)})" title="只重生成这张卡">重生成</button>`
    : '';
  return `<div class="${cls}" data-turn-id="${Number(t.id) || ''}"><div class="isekai-turn-head"><div class="isekai-turn-label">${escapeHtml(label)}</div>${regenBtn}</div><div class="isekai-turn-body">${body}</div></div>`;
}

function renderTurnsHtml(turns) {
  return filterTurnsForChapterPlay((turns || []).flatMap(expandMixedTurn)).map(renderTurnHtml).join('');
}

window.openIsekaiPlay = async function openIsekaiPlay(no) {
  if (!_bookId || _busy) return;
  setBusy(true, '进入章节…');
  let data;
  try {
    // 进章前刷新目录，避免本地缓存仍显示上一章未通关
    try {
      const fresh = await api.getSeriesBook(_bookId);
      if (fresh) _book = fresh;
    } catch (_) { /* keep */ }
    if (!_book?.isekai_begun && !_book?.user_role) {
      setBusy(false);
      window.showToast?.('请先点「开始穿越」发放身份卡');
      return;
    }
    if (Number(no) > 1) {
      const prev = (_book.chapters || []).find((c) => Number(c.chapter_no) === Number(no) - 1);
      if (!prev || prev.status !== 'done') {
        setBusy(false);
        window.showToast?.('请先完成上一章（可提前生成开场，但要按顺序玩）');
        return;
      }
    }
    data = await api.isekaiGetChapter(_bookId, no);
    const st = data.chapter?.status;
    if (st === 'generating') {
      setBusy(false);
      window.showToast?.('开场还在生成，请稍候；卡住可点「生成」重试');
      return;
    }
    if (st === 'pending' || !data.turns?.length) {
      setBusy(false);
      window.showToast?.('请先点右侧「生成」预写开场');
      return;
    }
    _book = data.book || _book;
    _playNo = no;
  } catch (e) {
    setBusy(false);
    _playNo = null;
    window.showToast?.(e.message || '进入失败');
    return;
  }
  setBusy(false);
  renderIsekaiPlay(data);
};

function renderIsekaiPlay(data) {
  const ch = data.chapter || {};
  const turns = data.turns || [];
  const arriveRaw = (Number(ch.chapter_no) === 1 ? (data.arrive || []) : []);
  const arrive = filterArriveForPlay(arriveRaw);
  const done = ch.status === 'done';
  const quest = data.quest || ch.quest || null;
  const questDonePending = !done && !!(quest?.chapter_done || quest?.main_done);
  const together = quest?.together;
  _isekaiLastTurnId = Math.max(0, ...turns.map((t) => Number(t.id) || 0), ...arriveRaw.map((t) => Number(t.id) || 0));
  if (done) markIsekaiChapterDoneLocal(ch.chapter_no);
  const page = document.getElementById('series-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="leaveIsekaiPlay()" title="返回"></button>
      <div class="topbar-title">第 ${ch.chapter_no} 章 · ${escapeHtml(ch.title || '')}</div>
      <div class="topbar-action" style="width:40px"></div>
    </div>
    <div class="scroll-area isekai-play" id="isekai-play-scroll">
      <div class="isekai-rolebar">
        你：${escapeHtml(_book.user_role || '')}${_book.user_surface_brief ? `（${escapeHtml(_book.user_surface_brief)}）` : ''}
        <div class="series-mini" style="margin-top:4px">${together === false ? '本章按剧中身份分场。' : together ? '本章可能同场。' : ''}进度自动保存。</div>
      </div>
      ${arrive.length ? `<div class="isekai-arrive">${renderTurnsHtml(arrive)}</div>` : ''}
      <div id="isekai-turns">${renderTurnsHtml(filterTurnsForChapterPlay(turns))}</div>
      ${done ? isekaiDoneTipHtml(ch.chapter_no) : `
      <div class="isekai-compose" id="isekai-compose">
        ${questDonePending ? '<div class="series-mini" style="margin-bottom:8px">本章情节已落定，点「完成本章」结算后即可进入下一章。</div>' : ''}
        ${quest?.effects?.user_muted ? `<div class="isekai-mute-banner" style="margin-bottom:8px">本章禁言：只能写动作，不能写带引号或「说道」的对白。</div>` : ''}
        <textarea class="input" id="isekai-input" rows="3" placeholder="${quest?.effects?.user_muted ? '禁言中…只写动作（不要对白）' : '以剧本身份行动/说话…系统会检测违规'}"></textarea>
        <div class="isekai-compose-actions">
          <button type="button" class="btn ${questDonePending ? 'btn-ghost' : 'btn-primary'} btn-sm" onclick="isekaiSend()">发送</button>
          <button type="button" class="btn ${questDonePending ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="isekaiFinishChapter()">完成本章</button>
        </div>
        <div class="series-mini">违规会电击示警、本章禁言，并提升世界难度；同伴违规你也能看到惩罚卡。</div>
      </div>`}
    </div>
    ${busyMaskHtml()}
  `;
  const sc = document.getElementById('isekai-play-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
  syncIsekaiTurnPendingFromJobs().catch?.(() => {});
}

window.leaveIsekaiPlay = function leaveIsekaiPlay() {
  _playNo = null;
  window.showToast?.('进度已保存，可随时继续');
  openSeriesBook(_bookId);
};

window.isekaiRegenTurn = async function isekaiRegenTurn(turnId) {
  if (!_bookId || !_playNo || _busy || !turnId) return;
  setBusy(true, '重生成这张卡…');
  try {
    const data = await api.isekaiRegenerateTurn(_bookId, _playNo, turnId);
    const mainBox = document.getElementById('isekai-turns');
    if (mainBox && Array.isArray(data.turns)) {
      const sc = document.getElementById('isekai-play-scroll');
      const keepBottom = sc ? (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80) : true;
      mainBox.innerHTML = renderTurnsHtml(filterTurnsForChapterPlay(data.turns));
      _isekaiLastTurnId = Math.max(0, ...data.turns.map((x) => Number(x.id) || 0));
      if (sc && keepBottom) sc.scrollTop = sc.scrollHeight;
    }
    window.showToast?.('已重生成这张卡');
  } catch (e) {
    window.showToast?.(e.message || '重生成失败');
  } finally {
    setBusy(false);
  }
};

/** 过章后同步本地目录状态，避免「进入下一章」仍判定上一章未完成 */
function markIsekaiChapterDoneLocal(chapterNo) {
  const no = Number(chapterNo);
  if (!_book || !no) return;
  if (!Array.isArray(_book.chapters)) _book.chapters = [];
  const ch = _book.chapters.find((c) => Number(c.chapter_no) === no);
  if (ch) ch.status = 'done';
  else _book.chapters.push({ chapter_no: no, status: 'done' });
}

function isekaiDoneTipHtml(chapterNo) {
  const no = Number(chapterNo) || _playNo || 1;
  const total = Number(_book?.total_chapters) || 0;
  const hasNext = total ? no < total : true;
  const bookDone = !hasNext || _book?.status === 'done';
  if (bookDone) {
    return `<div class="isekai-done-tip" id="isekai-done-tip" style="padding:16px 0">
      <div class="series-mini" style="margin-bottom:10px"><strong>全书通关</strong>——这本剧本已全部走完。通关纪念已写入本章总结/道具，可返回目录回顾。</div>
      <div class="isekai-compose-actions">
        <button type="button" class="btn btn-primary btn-sm" onclick="leaveIsekaiPlay()">返回目录</button>
      </div>
    </div>`;
  }
  return `<div class="isekai-done-tip" id="isekai-done-tip" style="padding:16px 0">
    <div class="series-mini" style="margin-bottom:10px">本章剧情已完成，请进入下一章节。</div>
    <div class="isekai-compose-actions">
      <button type="button" class="btn btn-primary btn-sm" onclick="isekaiGoNextChapter()">进入下一章</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="leaveIsekaiPlay()">返回目录</button>
    </div>
  </div>`;
}

function applyIsekaiChapterClearedUi(chapterNo) {
  markIsekaiChapterDoneLocal(chapterNo);
  const compose = document.getElementById('isekai-compose');
  if (compose) {
    compose.outerHTML = isekaiDoneTipHtml(chapterNo);
  } else if (!document.getElementById('isekai-done-tip')) {
    const box = document.getElementById('isekai-turns');
    box?.insertAdjacentHTML('afterend', isekaiDoneTipHtml(chapterNo));
  }
  const sc = document.getElementById('isekai-play-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

window.isekaiGoNextChapter = async function isekaiGoNextChapter() {
  if (!_bookId || _busy) return;
  const cur = Number(_playNo) || 0;
  if (!cur) return;
  const next = cur + 1;
  setBusy(true, '进入下一章…');
  try {
    // 若任务已勾完但章状态未落库，先强制结算
    const curMeta = (_book?.chapters || []).find((c) => Number(c.chapter_no) === cur);
    if (!curMeta || curMeta.status !== 'done') {
      try {
        const sealed = await api.isekaiFinishChapter(_bookId, cur);
        markIsekaiChapterDoneLocal(cur);
        if (sealed?.book) _book = { ..._book, ...sealed.book, chapters: sealed.book.chapters || _book.chapters };
      } catch (e) {
        window.showToast?.(e.message || '请先完成本章');
        return;
      }
    }
    try {
      const fresh = await api.getSeriesBook(_bookId);
      if (fresh) _book = fresh;
    } catch (_) { /* 用本地已同步状态即可 */ }
    markIsekaiChapterDoneLocal(cur);

    const nextCh = (_book?.chapters || []).find((c) => Number(c.chapter_no) === next);
    if (!nextCh) {
      window.showToast?.('没有下一章了');
      return;
    }
    if (nextCh.status === 'pending' || nextCh.status === 'generating') {
      window.showToast?.(nextCh.status === 'generating'
        ? '下一章开场还在生成，请稍候或回目录查看'
        : '请先回目录，给下一章点「生成」预写开场');
      _playNo = null;
      setBusy(false);
      await openSeriesBook(_bookId);
      return;
    }
    // openIsekaiPlay 自身会占 busy，先释放避免被 _busy 守卫直接 return
    _playNo = null;
    setBusy(false);
    await openIsekaiPlay(next);
  } finally {
    setBusy(false);
  }
};

window.isekaiSend = async function isekaiSend() {
  if (!_bookId || !_playNo || _busy) return;
  await syncIsekaiTurnPendingFromJobs();
  if (_isekaiTurnPending) {
    window.showToast?.('上一段续写还在生成中，请稍候');
    return;
  }
  const input = document.getElementById('isekai-input');
  const text = input?.value?.trim() || '';
  if (!text) {
    window.showToast?.('先写点什么');
    return;
  }
  // 客户端轻检：本章禁言时拦截对白（与后端规则对齐）
  const questCardFx = (() => {
    try {
      const ban = document.querySelector('#isekai-compose .isekai-mute-banner');
      return !!ban && /本章禁言/.test(ban.textContent || '');
    } catch { return false; }
  })();
  if (questCardFx && /[「」『』“”"]/.test(text)) {
    window.showToast?.('本章禁言：只能写动作，不能写对白');
    return;
  }
  const beforeId = _isekaiLastTurnId;
  try {
    const data = await api.isekaiTurn(_bookId, _playNo, { text });
    if (input) input.value = '';
    _isekaiLastTurnId = beforeId;
    appendIsekaiTurns(data.turns || []);
    applyIsekaiTurnQuestUi(data);
    if (isAsyncJobResult(data)) {
      _isekaiTurnPending = true;
      updateIsekaiComposePending(true);
      trackSeriesJob(data.job);
      window.showToast?.('续写后台进行中，可先去聊天或别处');
      return;
    }
  } catch (e) {
    window.showToast?.(e.message || '失败');
  }
};

window.isekaiFinishChapter = async function isekaiFinishChapter() {
  if (!_bookId || !_playNo || _busy) return;
  const isFinale = Number(_playNo) >= Number(_book?.total_chapters || 0);
  if (!confirm(isFinale ? '确认完结终章？会写全书收束并结算通关。' : '确认完成本章？会写一段收束。')) return;
  setBusy(true, isFinale ? '结算全书…' : '结算本章…');
  try {
    const data = await api.isekaiFinishChapter(_bookId, _playNo);
    markIsekaiChapterDoneLocal(data.chapter?.chapter_no || _playNo);
    if (data?.book) _book = { ..._book, ...data.book, chapters: data.book.chapters || _book.chapters };
    window.showToast?.(data?.book?.status === 'done' || isFinale ? '全书通关' : '本章完成');
    renderIsekaiPlay(data);
  } catch (e) {
    window.showToast?.(e.message || '失败');
  } finally {
    setBusy(false);
  }
};

window.seriesDeleteBook = async function seriesDeleteBook() {
  if (!_bookId) return;
  const label = modeLabel(_mode);
  if (!confirm(`删除这本${label}？章节与进度都会清空。`)) return;
  try {
    await api.deleteSeriesBook(_bookId);
    window.showToast?.('已删除');
    openSeriesModeHome(_mode);
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

window.seriesRegenOutline = async function seriesRegenOutline() {
  if (!_bookId || _busy) return;
  try {
    const res = await api.seriesGenerateOutline(_bookId, { async: true });
    if (isAsyncJobResult(res)) {
      trackSeriesJob(res.job);
      window.showToast?.('大纲后台生成中，可先离开');
    } else {
      window.showToast?.('大纲已生成');
    }
    await openSeriesBook(_bookId);
  } catch (e) {
    window.showToast?.(e.message || '失败');
  }
};

window.seriesStartChapter = async function seriesStartChapter(no) {
  if (!_bookId || _busy) return;
  const ch = (_book?.chapters || []).find((c) => c.chapter_no === no);
  if (ch?.status === 'done') {
    openSeriesChapter(no);
    return;
  }
  if (ch?.status === 'generating') {
    window.showToast?.('本章正在后台生成，请稍候');
    return;
  }
  // 第 1–2 章直接生成；其后可选手写走向
  let direction = '';
  if (no >= 3) {
    direction = await seriesAskDirection(no, ch?.outline || '');
    if (direction === null) return; // 取消
  }
  try {
    const res = await api.seriesGenerateChapter(_bookId, no, { direction, async: true });
    if (isAsyncJobResult(res)) {
      trackSeriesJob(res.job);
      window.showToast?.(`第 ${no} 章已在后台写，可先离开，完成后会通知`);
      await openSeriesBook(_bookId);
      return;
    }
    window.showToast?.(`第 ${no} 章已完成`);
    await openSeriesChapter(no);
  } catch (e) {
    window.showToast?.(e.message || '生成失败');
    await openSeriesBook(_bookId);
  }
};

function seriesAskDirection(no, preset) {
  return new Promise((resolve) => {
    const host = document.getElementById('series-page');
    const wrap = document.createElement('div');
    wrap.className = 'series-modal-mask';
    wrap.innerHTML = `
      <div class="series-modal">
        <div class="series-modal-title">第 ${no} 章走向</div>
        <div class="series-modal-sub">可写大纲或大致走向；留空则按整本大纲自动写</div>
        <textarea class="input" id="series-dir-input" rows="5" placeholder="例如：两人被迫同行，夜里起疑…">${escapeHtml(preset || '')}</textarea>
        <div class="series-modal-actions">
          <button type="button" class="btn btn-ghost" data-act="cancel">取消</button>
          <button type="button" class="btn btn-ghost" data-act="auto">交给模型</button>
          <button type="button" class="btn btn-primary" data-act="ok">按此生成</button>
        </div>
      </div>`;
    host.appendChild(wrap);
    const close = (val) => { wrap.remove(); resolve(val); };
    wrap.querySelector('[data-act="cancel"]').onclick = () => close(null);
    wrap.querySelector('[data-act="auto"]').onclick = () => close('');
    wrap.querySelector('[data-act="ok"]').onclick = () => {
      close(document.getElementById('series-dir-input')?.value?.trim() || '');
    };
  });
}

/* ─── 阅读 + 导演 ─── */
window.openSeriesChapter = async function openSeriesChapter(no) {
  if (!_bookId) return;
  setBusy(true, '加载章节…');
  let ch;
  try {
    ch = await api.getSeriesChapter(_bookId, no);
    _book = await api.getSeriesBook(_bookId);
  } catch (e) {
    setBusy(false);
    window.showToast?.(e.message || '加载失败');
    return;
  }
  setBusy(false);

  if (!ch.content) {
    seriesStartChapter(no);
    return;
  }

  const page = document.getElementById('series-page');
  const paras = formatSeriesProse(ch.content);
  const total = _book?.total_chapters || 0;
  const charCount = (ch.content || '').replace(/\s/g, '').length;
  // 末尾停在汉字/逗号等，或明显短于目标 → 提示可能被截断
  const maybeCut = /[\u4e00-\u9fffA-Za-z0-9，、；,;：:]$/.test(String(ch.content || '').trim())
    || charCount < 1800;
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="openSeriesBook(${_bookId})" title="返回"></button>
      <div class="topbar-title">第 ${no} 章 · ${escapeHtml(ch.title || '')}</div>
      <button type="button" class="topbar-action" onclick="seriesOpenDirector(${no})" title="导演">导</button>
    </div>
    <div class="scroll-area series-reader" id="series-reader">
      <div class="series-reader-meta">${charCount} 字${ch.director_notes ? ' · 经导演改写' : ''}${maybeCut ? ' · 疑似未写完' : ''}</div>
      ${maybeCut ? `<div class="series-mini" style="margin:8px 0 12px">正文可能被截断。可点下方「整章重写」；或开导演说明哪里不对。</div>` : ''}
      <article class="series-prose">${paras}</article>
      <div class="series-reader-nav" style="flex-wrap:wrap;gap:8px">
        ${no > 1 ? `<button type="button" class="btn btn-ghost" onclick="openSeriesChapter(${no - 1})">上一章</button>` : '<span></span>'}
        <button type="button" class="btn btn-ghost" onclick="seriesRewriteChapter(${no})">整章重写</button>
        ${no < total ? `<button type="button" class="btn btn-primary" onclick="seriesStartChapter(${no + 1})">${
          (_book.chapters || []).find((c) => c.chapter_no === no + 1)?.status === 'done' ? '下一章' : '写下一章'
        }</button>` : `<button type="button" class="btn btn-ghost" onclick="openSeriesBook(${_bookId})">回到目录</button>`}
      </div>
    </div>
    ${busyMaskHtml()}
  `;
};

/** 强制重写本章（用于截断章；不走「已生成不能再写」限制） */
window.seriesRewriteChapter = async function seriesRewriteChapter(no) {
  if (!_bookId || _busy) return;
  if (!confirm(`整章重写第 ${no} 章？会按大纲重新生成完整正文（旧文将被替换）。`)) return;
  try {
    setBusy(true, `重写第 ${no} 章…`);
    const res = await api.seriesGenerateChapter(_bookId, no, { force: true, async: true });
    setBusy(false);
    if (isAsyncJobResult(res)) {
      trackSeriesJob(res.job);
      window.showToast?.(`第 ${no} 章整章重写已在后台进行`);
      await openSeriesBook(_bookId);
      return;
    }
    window.showToast?.('已重写完成');
    await openSeriesChapter(no);
  } catch (e) {
    setBusy(false);
    window.showToast?.(e.message || '重写失败');
  }
};

function formatSeriesProse(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  t = t.replace(/([^\n「"\s])(\s*)([「"])/g, '$1\n$3');
  t = t.replace(/([」"])([^\n」"\s])/g, '$1\n$2');
  return t.split(/\n+/).filter(Boolean).map((line) => {
    const s = line.trim();
    if (/^[「"]/.test(s)) return `<p class="series-dialog">${escapeHtml(s)}</p>`;
    return `<p>${escapeHtml(s)}</p>`;
  }).join('');
}

window.seriesOpenDirector = function seriesOpenDirector(no) {
  const host = document.getElementById('series-page');
  const wrap = document.createElement('div');
  wrap.className = 'series-modal-mask';
  wrap.innerHTML = `
    <div class="series-modal">
      <div class="series-modal-title">导演</div>
      <div class="series-modal-sub">说说哪里不对、想怎么改，会按批示重写本章</div>
      <textarea class="input" id="series-director-input" rows="5" placeholder="例如：男主太油了，收一点；高潮再晚两段；女主别哭…"></textarea>
      <div class="series-modal-actions">
        <button type="button" class="btn btn-ghost" data-act="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-act="ok">按批示重写</button>
      </div>
    </div>`;
  host.appendChild(wrap);
  wrap.querySelector('[data-act="cancel"]').onclick = () => wrap.remove();
  wrap.querySelector('[data-act="ok"]').onclick = async () => {
    const feedback = document.getElementById('series-director-input')?.value?.trim() || '';
    if (!feedback) {
      window.showToast?.('请先写批示');
      return;
    }
    wrap.remove();
    try {
      const res = await api.seriesDirectorRewrite(_bookId, no, feedback);
      if (isAsyncJobResult(res)) {
        trackSeriesJob(res.job);
        window.showToast?.('导演重写已在后台进行，可先离开');
        await openSeriesBook(_bookId);
        return;
      }
      window.showToast?.('已按导演批示重写');
      await openSeriesChapter(no);
    } catch (e) {
      window.showToast?.(e.message || '重写失败');
    }
  };
};

/* ===== 记忆管理页 ===== */
import * as api from '../api.js';
import { renderMemoryHTML, getCategoryInfo, CATEGORIES, escapeHtml, formatMemoryDateLabel } from '../memory.js';

let allMemories    = [];
let allNarratives  = [];
let editingMemId   = null;
let _memTab        = 'now'; // 'now' | 'exp' | 'memory' | 'butler' | 'portrait' | 'self' | 'leaves' | 'archive'
let _butlerBusy    = false;
let _prunePlan     = null; // 修剪预览方案，确认后才 apply
let _lastButlerItems = [];
let _memFilterDate = '';
let _memFilterCat  = 'all';
let _narrativeBusy = false;
let _expFilter = 'all'; // 'active' | 'all'
let _memCatBarOpen = false;
let _allExpItems = [];
let _expEdges = [];
let _expKindFilter = 'all'; // all | event | daily | affection | user | self
let _expShowAllNodes = false;
/** 日子页：记忆点图谱 | 按日事记（曾误只挂事记，记忆点入口丢了） */
let _expSurface = 'topics'; // topics | lived
let _detailCache = null; // 详情缓存（修剪/返回用）
let _detailView = 'timeline';
let _detailReturnHub = null;
let _treeTrunk = null;
let _pageMode = 'brain'; // 'brain' | 'short'
/** 根图谱：选中节点 key、画布变换 */
let _graphSelectedKey = null;
let _graphPan = { x: 0, y: 0, scale: 1 };
let _graphCanvasSize = { w: 640, h: 640 };
let _graphGesture = null;
let _graphDidDrag = false;
/** 详情 hub 视图的画布变换（与根图谱 pan/zoom 独立） */
let _hubPan = { x: 0, y: 0, scale: 1 };
let _hubCanvasSize = { w: 480, h: 400 };
let _hubGesture = null;
let _hubDidDrag = false;

function getTodayDateStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function memoryMatchesDate(mem, dateStr) {
  if (!dateStr) return true;
  const d = String(mem.date || mem.created_at || '').slice(0, 10);
  return d === dateStr;
}

function shiftMemDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function getActiveChar() {
  const charId = window.getActiveCharId?.();
  const chars = window.getAppCharacters?.() || [];
  return chars.find(x => String(x.id) === String(charId)) || chars[0] || null;
}

function charDisplayName(c) {
  return String(c?.display_name || c?.name || 'TA').trim();
}

window.initMemoryPage = async function() {
  const charId = window.getActiveCharId?.();
  _pageMode = window._memoryMode === 'short' ? 'short' : 'brain';
  window._memoryMode = null;
  _memTab = window._memoryInitTab || (_pageMode === 'short' ? 'memory' : 'exp');
  window._memoryInitTab = null;
  if (_memTab === 'narrative') _memTab = 'exp';
  if (_memTab === 'impression') _memTab = 'portrait';
  if (_pageMode === 'short') _memTab = 'memory';
  _expFilter = 'all';

  const c = getActiveChar();
  const page = document.getElementById('memory-page');
  page.innerHTML = `
    <div class="brain-shell">
      <div class="topbar brain-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
        <div class="brain-topbar-center">
          <div class="brain-topbar-title">${escapeHtml(charDisplayName(c))} 的人格</div>
          <div class="brain-topbar-sub">消化后的日子 · 看法</div>
        </div>
        <button type="button" class="brain-portrait-btn" onclick="switchMemTab('portrait')" title="用户画像">
          ${c?.avatar
            ? `<img src="${escapeHtml(c.avatar)}" alt="">`
            : `<span>${escapeHtml(charDisplayName(c).slice(0, 1))}</span>`}
        </button>
      </div>

      <nav class="brain-nav" role="tablist">
        <button type="button" class="brain-nav-item active" id="memtab-now" role="tab" onclick="switchMemTab('now')">
          <span class="brain-nav-icon">⚡</span>此刻
        </button>
        <button type="button" class="brain-nav-item" id="memtab-exp" role="tab" onclick="switchMemTab('exp')">
          <span class="brain-nav-icon">📅</span>记忆点
        </button>
        <button type="button" class="brain-nav-item" id="memtab-leaves" role="tab" onclick="switchMemTab('leaves')">
          <span class="brain-nav-icon">🍂</span>落叶
        </button>
        <button type="button" class="brain-nav-item" id="memtab-archive" role="tab" onclick="switchMemTab('archive')">
          <span class="brain-nav-icon">📂</span>档案
        </button>
        <button type="button" class="brain-nav-item" id="memtab-memory" role="tab" onclick="switchMemTab('memory')">
          <span class="brain-nav-icon">🧩</span>碎片
        </button>
        <button type="button" class="brain-nav-item" id="memtab-butler" role="tab" onclick="switchMemTab('butler')">
          <span class="brain-nav-icon">🧹</span>整理
        </button>
        <button type="button" class="brain-nav-item" id="memtab-portrait" role="tab" onclick="switchMemTab('portrait')">
          <span class="brain-nav-icon">🪞</span>画像
        </button>
        <button type="button" class="brain-nav-item" id="memtab-self" role="tab" onclick="switchMemTab('self')">
          <span class="brain-nav-icon">💭</span>自我
        </button>
      </nav>

      <!-- 此刻 -->
      <div id="mem-panel-now" class="brain-panel active" role="tabpanel">
        <div class="brain-scroll" id="brain-now-list">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>

      <!-- 记忆点 -->
      <div id="mem-panel-exp" class="brain-panel" role="tabpanel">
        <div class="brain-scroll" id="brain-exp-list">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>

      <!-- 落叶 -->
      <div id="mem-panel-leaves" class="brain-panel" role="tabpanel">
        <div class="brain-scroll" id="brain-leaves-list">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>

      <!-- 人生档案 -->
      <div id="mem-panel-archive" class="brain-panel" role="tabpanel">
        <div class="brain-scroll" id="brain-archive-list">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>

      <!-- 原始碎片 -->
      <div id="mem-panel-memory" class="brain-panel" role="tabpanel">
        <p class="brain-frag-hint">单条写入的原始记录，供核对与编辑；跨天同一件事在「记忆点」里。</p>
        <div class="brain-date-bar">
          <button type="button" class="btn btn-ghost btn-sm" onclick="shiftMemoryDate(-1)">‹</button>
          <input type="date" class="input" id="mem-date-filter" style="width:auto;padding:4px 8px;font-size:13px"
            onchange="onMemoryDateChange(this.value)">
          <button type="button" class="btn btn-ghost btn-sm" onclick="shiftMemoryDate(1)">›</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="resetMemoryDateToday()">今天</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="showAllMemoryDates()">全部</button>
          <span class="brain-date-count" id="mem-date-count"></span>
          <button type="button" class="btn btn-ghost btn-sm" id="mem-cat-toggle" onclick="toggleMemCatBar()">类型筛选</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="openAddMemory()">＋</button>
        </div>
        <div class="brain-cat-pills brain-cat-pills--collapsed" id="mem-filter-bar">
          <button type="button" class="brain-cat-pill active" data-cat="all" onclick="filterMemory('all',this)">全部</button>
          ${Object.entries(CATEGORIES).map(([cat, info]) =>
            `<button type="button" class="brain-cat-pill" data-cat="${cat}" onclick="filterMemory('${cat}',this)">${info.icon} ${cat}</button>`
          ).join('')}
        </div>
        <div class="brain-scroll" id="memory-list" style="padding:8px 0 32px">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>

      <!-- 记忆点面板（旧入口，隐藏） -->
      <div id="mem-panel-narrative" style="display:none"></div>

      <!-- 整理 -->
      <div id="mem-panel-butler" class="brain-panel" role="tabpanel">
        <div class="brain-scroll">
          <div id="brain-tidy-stats" class="brain-butler-stats"></div>
          <div class="brain-butler-hero">
            <div class="brain-butler-avatar">🤖</div>
            <div class="brain-butler-info">
              <div class="brain-butler-name">记忆管家</div>
              <div class="brain-butler-desc">整理碎片、修剪过并的话题、补算话题连线、诊断漏记与矛盾</div>
            </div>
          </div>
          <div class="brain-pending-hint" id="brain-day-pending"></div>
          <div class="brain-action-grid">
            <button type="button" class="btn btn-primary" onclick="runDayConsolidate()">🌙 睡前整理（碎片→话题→挂图）</button>
            <button type="button" class="btn btn-primary" onclick="runMemoryTreePrune()">✂️ 修剪话题（先预览）</button>
            <button type="button" class="btn btn-ghost" onclick="rebuildTopicLinks()">🔗 补算话题连线</button>
            <button type="button" class="btn btn-ghost" onclick="runNarrativeMaintain(true)">补挂剩余碎片</button>
            <button type="button" class="btn btn-ghost" onclick="runMemoryButlerClean()">🧹 查重与纠错</button>
            <button type="button" class="btn btn-ghost" onclick="butlerClearAllMemories()">清空记忆</button>
          </div>
          <div class="brain-action-full">
            <button type="button" class="btn btn-ghost" onclick="backfillMemoriesFromChat()">📜 从聊天回填（约一个月）</button>
          </div>
          <textarea class="input brain-complaint" id="butler-complaint" rows="3"
            placeholder="可选：描述具体问题，例如：&#10;· 角色好像忘了我们约好的事&#10;· 记忆太碎、有重复&#10;· 某条记忆断章取义"></textarea>
          <div class="brain-action-full">
            <button type="button" class="btn btn-ghost" onclick="runMemoryButler()">请管家诊断（针对上方问题）</button>
          </div>
          <div id="butler-result">
            <div class="empty-state" style="padding:24px 0">
              <div class="empty-icon">🤖</div>
              <div class="empty-text" style="font-size:13px;line-height:1.6">填写上方问题后点「请管家诊断」<br>管家会结合最近聊天和全部记忆，找出可能的问题条目</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 画像 -->
      <div id="mem-panel-portrait" class="brain-panel" role="tabpanel">
        <div class="brain-scroll" id="brain-portrait-list">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>

      <!-- 自我认知 -->
      <div id="mem-panel-self" class="brain-panel" role="tabpanel">
        <div class="brain-scroll" id="brain-self-list">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>

      <!-- 记忆点详情 -->
      <div id="narrative-detail-overlay" class="overlay fullscreen brain-story-overlay" onclick="closeStoryDetail()">
        <div class="brain-story-sheet" onclick="event.stopPropagation()">
          <div class="brain-story-head">
            <button type="button" class="brain-story-back" onclick="storyDetailBack()" aria-label="返回">←</button>
            <div class="brain-story-head-main">
              <div class="brain-story-title" id="narrative-detail-title">记忆点</div>
              <div class="brain-story-meta" id="narrative-detail-meta"></div>
            </div>
            <span class="brain-story-status" id="narrative-detail-status"></span>
          </div>
          <div class="brain-story-body" id="narrative-detail-body"></div>
          <div class="brain-story-foot" id="narrative-detail-footer"></div>
        </div>
      </div>

      <!-- 记忆 添加/编辑 弹窗 -->
      <div id="memory-edit-overlay" class="overlay center" onclick="this.classList.remove('active')">
        <div class="modal" style="width:calc(100% - 32px);max-width:440px" onclick="event.stopPropagation()">
          <div class="modal-title" id="mem-modal-title">添加记忆</div>
          <div class="modal-body">
            <div class="form-group">
              <label class="input-label">分类</label>
              <select class="input" id="mem-category">
                ${Object.keys(CATEGORIES).map(cat => `<option value="${cat}">${cat}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="input-label">内容</label>
              <textarea class="input" id="mem-content" style="min-height:80px" placeholder="记忆内容…"></textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('memory-edit-overlay').classList.remove('active')">取消</button>
            <button class="btn btn-primary btn-sm" onclick="saveMemory()">保存</button>
          </div>
        </div>
      </div>

      <!-- 印象 添加/编辑 弹窗 -->
      <div id="brain-imp-edit-overlay" class="overlay center" onclick="this.classList.remove('active')">
        <div class="modal" style="width:calc(100% - 32px);max-width:380px" onclick="event.stopPropagation()">
          <div class="modal-title" id="brain-imp-modal-title">编辑印象</div>
          <div class="modal-body">
            <textarea class="input" id="brain-imp-content" rows="4" placeholder="角色视角的一句事实，一行一条。&#10;如：喜欢喝青梅酒&#10;容易想很多"></textarea>
            <input type="text" class="input" id="brain-imp-category" placeholder="大类" style="margin-top:8px" oninput="onBrainImpCatInput(this.value)">
            <div class="brain-imp-cats" id="brain-imp-cats"></div>
            <input type="text" class="input" id="brain-imp-note" placeholder="TA 的一句感想（可选）" style="margin-top:8px">
            <input type="text" class="input" id="brain-imp-keywords" placeholder="关键词，逗号分隔" style="margin-top:8px">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:10px;color:var(--text-secondary)">
              <input type="checkbox" id="brain-imp-confirmed"> 已确认（去掉「（?）」）
            </label>
          </div>
          <div class="modal-footer" style="justify-content:space-between">
            <button type="button" class="btn btn-ghost btn-sm" id="brain-imp-del-btn" style="color:#e57373;display:none" onclick="deleteBrainImpCurrent()">删除</button>
            <div style="display:flex;gap:8px;margin-left:auto">
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('brain-imp-edit-overlay').classList.remove('active')">取消</button>
              <button type="button" class="btn btn-primary btn-sm" onclick="saveBrainImpEntry()">保存</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 自我认知 添加/编辑 弹窗 -->
      <div id="brain-self-edit-overlay" class="overlay center" onclick="this.classList.remove('active')">
        <div class="modal" style="width:calc(100% - 32px);max-width:380px" onclick="event.stopPropagation()">
          <div class="modal-title" id="brain-self-modal-title">编辑自我认知</div>
          <div class="modal-body">
            <textarea class="input" id="brain-self-content" rows="4" placeholder="第一人称，一行一条。相关联的写在一张卡里。"></textarea>
            <input type="text" class="input" id="brain-self-category" placeholder="大类" style="margin-top:8px" oninput="onBrainSelfCatInput(this.value)">
            <div class="brain-imp-cats" id="brain-self-cats"></div>
            <input type="text" class="input" id="brain-self-note" placeholder="TA 的一句感想（可选）" style="margin-top:8px">
            <input type="text" class="input" id="brain-self-keywords" placeholder="关键词，逗号分隔" style="margin-top:8px">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:10px;color:var(--text-secondary)">
              <input type="checkbox" id="brain-self-confirmed"> 已确认（去掉「（?）」）
            </label>
          </div>
          <div class="modal-footer" style="justify-content:space-between">
            <button type="button" class="btn btn-ghost btn-sm" id="brain-self-del-btn" style="color:#e57373;display:none" onclick="deleteBrainSelfCurrent()">删除</button>
            <div style="display:flex;gap:8px;margin-left:auto">
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('brain-self-edit-overlay').classList.remove('active')">取消</button>
              <button type="button" class="btn btn-primary btn-sm" onclick="saveBrainSelfEntry()">保存</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 档案经历 添加/编辑 弹窗 -->
      <div id="brain-archive-edit-overlay" class="overlay center" onclick="this.classList.remove('active')">
        <div class="modal" style="width:calc(100% - 32px);max-width:420px" onclick="event.stopPropagation()">
          <div class="modal-title" id="brain-archive-modal-title">添加经历</div>
          <div class="modal-body">
            <label class="input-label">阶段</label>
            <div class="brain-imp-cats" id="brain-archive-stages"></div>
            <input type="text" class="input" id="brain-archive-stage" placeholder="或自定义阶段" style="margin-top:8px" oninput="onBrainArchiveStageInput(this.value)">
            <label class="input-label" style="margin-top:12px">标题（可选）</label>
            <input type="text" class="input" id="brain-archive-title" placeholder="如：第一次离家" maxlength="40">
            <label class="input-label" style="margin-top:12px">经历</label>
            <textarea class="input" id="brain-archive-content" rows="5" placeholder="写这段阶段里发生过的事。尽量写事实，少写「于是我变成了……」这类结论；结论留给一键消化。"></textarea>
          </div>
          <div class="modal-footer" style="justify-content:space-between">
            <button type="button" class="btn btn-ghost btn-sm" id="brain-archive-del-btn" style="color:#e57373;display:none" onclick="deleteBrainArchiveCurrent()">删除</button>
            <div style="display:flex;gap:8px;margin-left:auto">
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('brain-archive-edit-overlay').classList.remove('active')">取消</button>
              <button type="button" class="btn btn-primary btn-sm" onclick="saveBrainArchiveEntry()">保存</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 对用户的判断 -->
      <div id="user-read-edit-overlay" class="overlay center" onclick="this.classList.remove('active')">
        <div class="modal" style="width:calc(100% - 32px);max-width:420px" onclick="event.stopPropagation()">
          <div class="modal-title" id="user-read-modal-title">添加判断</div>
          <div class="modal-body">
            <label class="input-label">放在哪</label>
            <div class="brain-imp-cats" id="user-read-sections"></div>
            <label class="input-label" style="margin-top:12px">哪一类</label>
            <div class="brain-imp-cats" id="user-read-cats"></div>
            <label class="input-label" style="margin-top:12px" id="user-read-judgment-label">判断</label>
            <textarea class="input" id="user-read-judgment" rows="2" maxlength="56" placeholder="现在怎么看对方，一句。例如：嘴上说随便，其实在等我先开口"></textarea>
            <label class="input-label" style="margin-top:12px" id="user-read-reason-label">当时为什么这么认为</label>
            <textarea class="input" id="user-read-reason" rows="4" maxlength="220" placeholder="当时怎么看、什么感觉、为什么收成这一句。不贴聊天原文。"></textarea>
          </div>
          <div class="modal-footer" style="justify-content:space-between">
            <button type="button" class="btn btn-ghost btn-sm" id="user-read-del-btn" style="color:#e57373;display:none" onclick="deleteUserReadCurrent()">删除</button>
            <div style="display:flex;gap:8px;margin-left:auto">
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('user-read-edit-overlay').classList.remove('active')">取消</button>
              <button type="button" class="btn btn-primary btn-sm" onclick="saveUserRead()">保存</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  if (_pageMode === 'short') {
    const title = document.querySelector('#memory-page .brain-topbar-title');
    const sub = document.querySelector('#memory-page .brain-topbar-sub');
    if (title) title.textContent = `${charDisplayName(c)} 的记忆`;
    if (sub) sub.textContent = '当天碎片 · 短期记忆 · 晚上会进人格';
    document.querySelector('#memory-page .brain-nav')?.style.setProperty('display', 'none');
    document.querySelector('#memory-page .brain-portrait-btn')?.style.setProperty('display', 'none');
    const hint = document.querySelector('#memory-page .brain-frag-hint');
    if (hint) hint.textContent = '当天总结进库的碎片。还没经过夜里睡觉整理，属于短期记忆。';
  } else {
    document.getElementById('memtab-memory')?.style.setProperty('display', 'none');
    document.getElementById('memtab-butler')?.style.setProperty('display', 'none');
  }

  switchMemTab(_memTab);
};

window.openSecretUserPortrait = function() {
  switchMemTab('portrait');
};

/* ─── 标签切换 ─── */
window.switchMemTab = function(tab) {
  if (tab === 'impression') tab = 'portrait';
  if (tab === 'narrative') tab = 'exp';
  _memTab = tab;

  ['now', 'exp', 'memory', 'butler', 'portrait', 'self', 'leaves', 'archive'].forEach(t => {
    document.getElementById(`memtab-${t}`)?.classList.toggle('active', tab === t);
    document.getElementById(`mem-panel-${t}`)?.classList.toggle('active', tab === t);
  });

  if (tab === 'memory') {
    if (_pageMode === 'short') {
      _memFilterDate = getTodayDateStr();
      const dateInput = document.getElementById('mem-date-filter');
      if (dateInput) dateInput.value = _memFilterDate;
    } else {
      _memFilterDate = '';
      const dateInput = document.getElementById('mem-date-filter');
      if (dateInput) dateInput.value = '';
    }
    _memFilterCat = 'all';
    _memCatBarOpen = false;
    const bar = document.getElementById('mem-filter-bar');
    const catBtn = document.getElementById('mem-cat-toggle');
    if (bar) bar.classList.add('brain-cat-pills--collapsed');
    if (catBtn) catBtn.classList.remove('active');
    loadMemories('all');
  } else if (tab === 'now') {
    loadBrainNow();
  } else if (tab === 'exp') {
    if (_expSurface === 'lived') loadLivedMemory();
    else loadBrainExperiences();
  } else if (tab === 'leaves') {
    loadFallenLeaves();
  } else if (tab === 'butler') {
    loadBrainTidy();
    loadDayPending();
  } else if (tab === 'portrait') {
    loadBrainPortrait();
  } else if (tab === 'self') {
    loadBrainSelf();
  } else if (tab === 'archive') {
    loadBrainArchive();
  }
};

function renderAffectionCard(aff) {
  if (!aff) {
    return `
      <div class="brain-card">
        <div class="brain-card-head">
          <span class="brain-card-label">感情线</span>
          <span class="brain-card-action" onclick="rebuildBrainAffection()">刷新</span>
        </div>
        <div class="brain-card-body">还没有对这段关系的态度。聊几句、或点刷新，会根据已有聊天和关系设定收一版。</div>
      </div>`;
  }
  const dayBits = [];
  if (aff.kind === 'romantic' && aff.daysTogether) dayBits.push(`在一起 ${aff.daysTogether} 天`);
  if (aff.daysKnown) dayBits.push(`认识 ${aff.daysKnown} 天`);
  const meters = [];
  if (aff.favor != null || aff.attachment != null) {
    meters.push(`好感 ${aff.favor ?? aff.attachment}`);
  }
  if (aff.disappointment != null) meters.push(`失望 ${aff.disappointment}`);
  if (aff.loyaltyHigh) meters.push('专一');
  const chips = (aff.settled || []).map(
    (s) => `<span class="brain-chip">${escapeHtml(s)}</span>`
  ).join('');
  const tender = (aff.stillTender || []).length
    ? `<div class="brain-card-meta">性格渗入：${escapeHtml(aff.stillTender.join('；'))}</div>`
    : '';
  const hist = (aff.history || []).slice(-3).map((h) => escapeHtml(`${h.at || ''} ${h.text || ''}`.trim())).filter(Boolean);
  return `
    <div class="brain-card">
      <div class="brain-card-head">
        <span class="brain-card-label">感情线</span>
        <span class="brain-card-action" onclick="rebuildBrainAffection()">刷新</span>
      </div>
      <div class="brain-card-title">${escapeHtml(aff.stageLabel || '相处中')}</div>
      ${dayBits.length ? `<div class="brain-card-meta">${escapeHtml(dayBits.join(' · '))}</div>` : ''}
      ${meters.length ? `<div class="brain-card-meta">${escapeHtml(meters.join(' · '))}</div>` : ''}
      ${chips ? `<div class="brain-chip-row">${chips}</div>` : ''}
      ${tender}
      ${hist.length ? `<div class="brain-card-meta">${hist.join(' · ')}</div>` : ''}
      <div class="brain-card-meta" style="margin-top:8px;opacity:0.75">类型黏、温度会动 · 专一先积失望再拖好感</div>
    </div>`;
}

function renderMoodCard(moodData) {
  const mood = moodData?.mood || {};
  const label = mood.emoji || mood.display || '😌';
  const note = mood.note || '';
  const BUILDUP_ZH = {
    steady: '',
    mild: '微微积着',
    building: '有积压',
    near_flash: '接近燃点',
    flash: '刚过燃点',
  };
  const buildupParts = [];
  const bu = BUILDUP_ZH[mood.buildup] || '';
  if (bu) buildupParts.push(bu);
  if (moodData?.conflict?.phase === 'open') buildupParts.push('还有未翻篇的冲突余波');
  else if (moodData?.conflict?.phase === 'residual') buildupParts.push('冲突已缓，余温还在');
  const buildup = buildupParts.join(' · ');
  const sub = [buildup, note].filter(Boolean).join(' · ') || '点击查看详细心情曲线';
  return `
    <div class="brain-card brain-card--tap" onclick="openEmotionFromBrain()">
      <div class="brain-card-head">
        <span class="brain-card-label">此刻心情</span>
        <span class="brain-mood-arrow">›</span>
      </div>
      <div class="brain-mood-display">${escapeHtml(label)}</div>
      <div class="brain-mood-sub">${escapeHtml(sub)}</div>
    </div>`;
}

window.openEmotionFromBrain = function() {
  window.openEmotionPanel?.();
};

async function loadBrainNow() {
  const charId = window.getActiveCharId?.();
  const box = document.getElementById('brain-now-list');
  if (!box) return;
  if (!charId) {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  box.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const [snap, emotion, tidy] = await Promise.all([
      api.getBrainNow(charId),
      api.getCharEmotion(charId, 2).catch(() => null),
      api.getBrainTidy(charId).catch(() => null),
    ]);
    const preview = (snap.preview || []).map((m) => {
      const isUser = m.role === 'user';
      return `<div class="brain-preview-msg">
        <span class="brain-preview-who brain-preview-who--${isUser ? 'user' : 'ai'}">${isUser ? '你' : 'TA'}</span>
        <span class="brain-preview-text">${escapeHtml(m.text || '')}</span>
      </div>`;
    }).join('');
    const expCount = tidy?.current ?? snap.todayMemories ?? 0;
    box.innerHTML = `
      <div class="brain-stats-row">
        <div class="brain-stat">
          <div class="brain-stat-val">${snap.rounds}</div>
          <div class="brain-stat-label">近窗轮数</div>
        </div>
        <div class="brain-stat">
          <div class="brain-stat-val">${snap.todayMemories || 0}</div>
          <div class="brain-stat-label">今日碎片</div>
        </div>
        <div class="brain-stat">
          <div class="brain-stat-val">${expCount}</div>
          <div class="brain-stat-label">记忆总量</div>
        </div>
      </div>
      ${renderContextPinCard(snap.contextHang)}
      ${renderMoodCard(emotion)}
      ${renderAffectionCard(snap.affection)}
      <div class="brain-card">
        <div class="brain-card-head">
          <span class="brain-card-label">近窗</span>
        </div>
        <div class="brain-card-body">携带 ${snap.rounds} 轮对话原文</div>
        <div class="brain-card-meta">窗口内 ${snap.windowUserTurns} 轮用户发言 / ${snap.windowMessages} 条消息</div>
      </div>
      <div class="brain-card">
        <div class="brain-card-head">
          <span class="brain-card-label">窗口最近几句</span>
        </div>
        <div class="brain-preview-list">${preview || '<div class="brain-card-meta">还没有对话</div>'}</div>
      </div>
    `;
  } catch {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
  }
}

function renderContextPinRows(rows) {
  return (rows || []).map((p) => `
    <div class="brain-pin-row">
      <div class="brain-pin-main">
        <div class="brain-card-meta" style="margin-top:0">${escapeHtml(p.category || '记忆')}${p.date ? ` · ${escapeHtml(p.date)}` : ''}${p.hang === 'every' ? ' · 每轮带着' : ''}</div>
        <div class="brain-pin-text">${escapeHtml(String(p.content || '').slice(0, 96))}</div>
      </div>
      <div class="brain-pin-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick="openContextPinPicker(${Number(p.id)})">换成</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="removeContextPin(${Number(p.id)})">拿下</button>
      </div>
    </div>`).join('');
}

function renderContextPinCard(hang) {
  const every = hang?.every || [];
  const relevant = hang?.relevant || [];
  const everyHtml = every.length
    ? renderContextPinRows(every)
    : '<div class="brain-card-meta">还没有每轮都带着的。点右上角可以挂上一条。</div>';
  const relevantHtml = relevant.length
    ? renderContextPinRows(relevant)
    : '<div class="brain-card-meta">没有还留在当前里的约定或重要时刻。</div>';
  return `
    <div class="brain-card">
      <div class="brain-card-head">
        <span class="brain-card-label">挂在上下文</span>
        <span class="brain-card-action" onclick="openContextPinPicker(0)">挂上一条</span>
      </div>
      <div class="brain-card-meta">约定和重要时刻不会每轮自动塞进聊天。下面先列出还留在当前里、聊到相关时会被想起来的。拿下后不再进上下文，记忆还在。换成或挂上的那条，之后每轮都会带着。</div>
      <div class="brain-card-meta" style="margin-top:10px">每轮带着</div>
      ${everyHtml}
      <div class="brain-card-meta" style="margin-top:10px">聊到才想起来</div>
      ${relevantHtml}
    </div>`;
}

let _pinReplaceId = 0;

function closeContextPinPicker() {
  document.getElementById('brain-pin-sheet')?.remove();
}

async function fillContextPinCandidates(q) {
  const charId = window.getActiveCharId?.();
  const box = document.getElementById('brain-pin-candidates');
  if (!charId || !box) return;
  box.innerHTML = '<div class="brain-card-meta">查找中…</div>';
  try {
    const data = await api.searchContextPinCandidates(charId, q || '');
    const items = data?.items || [];
    if (!items.length) {
      box.innerHTML = '<div class="brain-card-meta">没有对上的记忆</div>';
      return;
    }
    box.innerHTML = items.map((p) => `
      <button type="button" class="brain-pin-row" style="width:100%;text-align:left;background:transparent;border-left:0;border-right:0;border-top:0;color:inherit;cursor:pointer" onclick="chooseContextPin(${Number(p.id)})">
        <div class="brain-pin-main">
          <div class="brain-card-meta" style="margin-top:0">${escapeHtml(p.category || '记忆')}${p.date ? ` · ${escapeHtml(p.date)}` : ''}${p.pinned ? ' · 已挂' : ''}</div>
          <div class="brain-pin-text">${escapeHtml(String(p.content || '').slice(0, 96))}</div>
        </div>
      </button>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="brain-card-meta">${escapeHtml(e.message || '查找失败')}</div>`;
  }
}

window.openContextPinPicker = function(replaceId) {
  _pinReplaceId = Number(replaceId) || 0;
  closeContextPinPicker();
  const sheet = document.createElement('div');
  sheet.id = 'brain-pin-sheet';
  sheet.className = 'brain-pin-sheet';
  sheet.innerHTML = `
    <div class="brain-pin-panel" onclick="event.stopPropagation()">
      <div class="brain-card-head">
        <span class="brain-card-label">${_pinReplaceId ? '换成另一条' : '挂上一条记忆'}</span>
        <span class="brain-card-action" onclick="closeContextPinPicker()">关闭</span>
      </div>
      <div class="brain-pin-search">
        <input id="brain-pin-q" class="input" placeholder="搜记忆内容" />
        <button type="button" class="btn btn-ghost btn-sm" onclick="searchContextPinCandidates()">查找</button>
      </div>
      <div id="brain-pin-candidates"></div>
    </div>`;
  sheet.addEventListener('click', closeContextPinPicker);
  document.body.appendChild(sheet);
  const input = document.getElementById('brain-pin-q');
  input?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') window.searchContextPinCandidates();
  });
  fillContextPinCandidates('');
};

window.closeContextPinPicker = closeContextPinPicker;
window.searchContextPinCandidates = function() {
  fillContextPinCandidates(document.getElementById('brain-pin-q')?.value || '');
};

window.chooseContextPin = async function(id) {
  const charId = window.getActiveCharId?.();
  if (!charId || !id) return;
  try {
    if (_pinReplaceId) {
      await api.mutateContextPin(charId, { action: 'replace', id: _pinReplaceId, replaceId: id });
    } else {
      await api.mutateContextPin(charId, { action: 'add', id });
    }
    closeContextPinPicker();
    window.showToast?.(_pinReplaceId ? '已换成这条，之后每轮都会带着' : '已挂进上下文，之后每轮都会带着');
    loadBrainNow();
  } catch (e) {
    window.showToast?.(e.message || '没挂上');
  }
};

window.removeContextPin = async function(id) {
  const charId = window.getActiveCharId?.();
  if (!charId || !id) return;
  try {
    await api.mutateContextPin(charId, { action: 'remove', id });
    window.showToast?.('已从上下文拿下');
    loadBrainNow();
  } catch (e) {
    window.showToast?.(e.message || '没拿下来');
  }
};

window.rebuildBrainAffection = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  try {
    await api.rebuildBrainAffection(charId);
    window.showToast?.('感情线已按已有聊天重算');
    loadBrainNow();
  } catch (e) {
    window.showToast?.(e.message || '刷新失败');
  }
};

function formatPointDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd || '';
  return `${Number(m[2])}月${Number(m[3])}日`;
}

function formatPointDateRange(from, to) {
  if (!from && !to) return '时间未记清';
  if (!to || from === to) return formatPointDate(from);
  return `${formatPointDate(from)} — ${formatPointDate(to)}`;
}

function ingestExpPayload(data) {
  if (Array.isArray(data)) {
    _treeTrunk = null;
    _allExpItems = data;
    _expEdges = [];
    return;
  }
  _treeTrunk = data?.trunk || null;
  _allExpItems = Array.isArray(data?.items) ? data.items : [];
  _expEdges = Array.isArray(data?.edges) ? data.edges : [];
}

const KIND_FILTER_LABELS = {
  all: '全部',
  event: '事件',
  daily: '日常',
  affection: '感情',
  user: '用户',
  self: '自我',
};

function livingTopicNodes() {
  return _allExpItems.filter((n) => n.kind === 'narrative' && classifyExpItem(n) !== 'fallen');
}

function filteredTopicNodes() {
  let nodes = livingTopicNodes();
  if (_expKindFilter !== 'all') {
    nodes = nodes.filter((n) => n.treeKind === _expKindFilter);
  }
  if (!_expShowAllNodes && nodes.length > 25) {
    const hot = nodes.filter((n) => n.tier === 'hot' || n.tier === 'warm' || n.dirty);
    const rest = nodes.filter((n) => !(n.tier === 'hot' || n.tier === 'warm' || n.dirty));
    nodes = [...hot, ...rest].slice(0, 25);
  }
  return nodes;
}

function graphNodeKey(n) {
  if (n?.nodeKey) return String(n.nodeKey);
  return `${n?.kind === 'branch' ? 'branch' : 'narrative'}:${n?.id}`;
}

function graphCardSize(width, { hub = false, fullWidth = false } = {}) {
  if (fullWidth) {
    return { w: Math.max(200, width - 24), h: hub ? 78 : 70 };
  }
  const cols = width >= 360 ? 2 : 1;
  const gap = 10;
  const w = cols === 1
    ? Math.max(200, width - 24)
    : Math.floor((width - 24 - gap) / 2);
  return { w, h: hub ? 78 : 68, cols, gap };
}

/**
 * Hub 子图布局：
 * - 延续链节点：竖形排列在 hub 上方（sequel-prev）/ 下方（sequel-next），从小到大排列
 * - 分支节点：横向小卡片，排列在 hub 两侧
 * - 相关话题节点：更小的卡，横向排在分支下方
 *
 * 最终画布宽高自适应。
 */
function layoutHubGraphNodes(nodes, width) {
  const padX = 12;
  const padY = 14;
  const gapY = 20;   // 竖向间距（主链）
  const gapX = 10;    // 横向间距（分支/相关）
  const hubGap = 28; // hub 和分支行之间的间距

  // 卡片尺寸（按层级递减）
  function cardDim(role) {
    if (role === 'hub')         return { w: Math.max(200, width - padX * 2), h: 80 };
    if (role === 'sequel-prev') return { w: Math.max(160, width - padX * 2), h: 62 };
    if (role === 'sequel-next') return { w: Math.max(150, width - padX * 2), h: 58 };
    if (role === 'twig')        return { w: Math.min(136, Math.floor((width - padX * 2) / 2.4)), h: 58 };
    return                         { w: Math.min(120, Math.floor((width - padX * 2) / 2.8)), h: 52 };
  }

  const hub    = nodes.find((n) => n.role === 'hub') || null;
  const prequels = nodes.filter((n) => n.role === 'sequel-prev')
    .sort((a, b) => a.id - b.id); // id 小 = 更早
  const sequels  = nodes.filter((n) => n.role === 'sequel-next')
    .sort((a, b) => a.id - b.id); // id 小 = 更早
  const twigs    = nodes.filter((n) => n.role === 'twig');
  const related  = nodes.filter((n) => n.role === 'related');

  if (!hub) {
    return layoutSpatialGraphNodes(nodes, { width: Math.max(width, 480), height: 420 });
  }

  const hubDim = cardDim('hub');
  const placed = [];

  // 中心横坐标
  const cx = padX + (width - padX * 2) / 2;

  // 前传链：竖排在上方，从上到下，越来越小
  let curY = padY;
  for (const n of prequels) {
    const dim = cardDim(n.role);
    placed.push({ ...n, x: cx - dim.w / 2, y: curY, w: dim.w, h: dim.h });
    curY += dim.h + gapY;
  }

  // Hub 本身：在前传链下方
  const hubY = curY;
  placed.push({ ...hub, x: cx - hubDim.w / 2, y: hubY, w: hubDim.w, h: hubDim.h });
  curY = hubY + hubDim.h;

  // 续集链：竖排在 hub 下方
  for (const n of sequels) {
    const dim = cardDim(n.role);
    placed.push({ ...n, x: cx - dim.w / 2, y: curY, w: dim.w, h: dim.h });
    curY += dim.h + gapY;
  }

  const trunkBottom = curY;
  curY += hubGap;

  // 分支（twig）：两列横排，从 hub 的中心向两侧展开
  if (twigs.length) {
    const cols = 2;
    const twigDim = cardDim('twig');
    const twigRowH = twigDim.h + 4;
    const twigRows = Math.ceil(twigs.length / cols);
    for (let i = 0; i < twigs.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // 左列偏左，右列偏右
      const xOff = col === 0
        ? padX
        : width - padX - twigDim.w;
      placed.push({
        ...twigs[i],
        x: xOff,
        y: curY + row * twigRowH,
        w: twigDim.w,
        h: twigDim.h,
      });
    }
    curY += twigs.length > 0 ? Math.ceil(twigs.length / 2) * twigRowH : 0;
  }

  curY += 8;

  // 相关话题：更小，两列横排
  if (related.length) {
    const relDim = cardDim('related');
    const relRowH = relDim.h + 4;
    const relCols = 2;
    for (let i = 0; i < related.length; i++) {
      const col = i % relCols;
      const row = Math.floor(i / relCols);
      const xOff = col === 0 ? padX : width - padX - relDim.w;
      placed.push({
        ...related[i],
        x: xOff,
        y: curY + row * relRowH,
        w: relDim.w,
        h: relDim.h,
      });
    }
    curY += Math.ceil(related.length / 2) * relRowH;
  }

  const contentH = Math.max(trunkBottom, curY) + padY;
  return { placed, width, height: Math.max(contentH, 240) };
}

/**
 * 根图谱空间布局：按关联力导向散开，方便连线阅读。
 * 返回的 x/y 是卡片左上角。
 */
function layoutSpatialGraphNodes(nodes, { width = 640, height = 640, edges = [] } = {}) {
  const n = nodes.length;
  if (!n) return { placed: [], width, height };
  const cardW = 148;
  const cardH = 72;
  const cx = width / 2;
  const cy = height / 2;
  const pts = nodes.map((node, i) => {
    const ang = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
    const ring = 90 + (i % 3) * 42 + Math.min(120, n * 4);
    return {
      ...node,
      _px: cx + Math.cos(ang) * ring,
      _py: cy + Math.sin(ang) * ring,
      w: cardW,
      h: cardH,
    };
  });
  const keyIndex = new Map(pts.map((p, i) => [graphNodeKey(p), i]));
  const links = [];
  for (const e of edges || []) {
    const ia = keyIndex.get(`narrative:${e.from}`)
      ?? keyIndex.get(String(e.from))
      ?? keyIndex.get(e.from);
    const ib = keyIndex.get(`narrative:${e.to}`)
      ?? keyIndex.get(String(e.to))
      ?? keyIndex.get(e.to);
    if (ia == null || ib == null || ia === ib) continue;
    links.push([ia, ib]);
  }
  // 简单力导向：斥力 + 连线拉力 + 向中心
  for (let iter = 0; iter < 48; iter++) {
    const cool = 1 - iter / 48;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pts[i]._px - pts[j]._px;
        let dy = pts[i]._py - pts[j]._py;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minD = 168;
        if (dist < minD) {
          const f = ((minD - dist) / minD) * 14 * cool;
          dx = (dx / dist) * f;
          dy = (dy / dist) * f;
          pts[i]._px += dx;
          pts[i]._py += dy;
          pts[j]._px -= dx;
          pts[j]._py -= dy;
        }
      }
    }
    for (const [ia, ib] of links) {
      let dx = pts[ib]._px - pts[ia]._px;
      let dy = pts[ib]._py - pts[ia]._py;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ideal = 200;
      const f = ((dist - ideal) / dist) * 0.08 * cool;
      pts[ia]._px += dx * f;
      pts[ia]._py += dy * f;
      pts[ib]._px -= dx * f;
      pts[ib]._py -= dy * f;
    }
    for (const p of pts) {
      p._px += (cx - p._px) * 0.012;
      p._py += (cy - p._py) * 0.012;
    }
  }
  // 归一到画布内边距
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p._px - cardW / 2);
    minY = Math.min(minY, p._py - cardH / 2);
    maxX = Math.max(maxX, p._px + cardW / 2);
    maxY = Math.max(maxY, p._py + cardH / 2);
  }
  const pad = 36;
  const contentW = Math.max(width, maxX - minX + pad * 2);
  const contentH = Math.max(height, maxY - minY + pad * 2);
  const ox = pad - minX;
  const oy = pad - minY;
  const placed = pts.map((p) => ({
    ...p,
    x: p._px - cardW / 2 + ox,
    y: p._py - cardH / 2 + oy,
    w: cardW,
    h: cardH,
  }));
  return { placed, width: contentW, height: contentH };
}

function renderGraphCard(n, opts = {}) {
  const st = pointStatusInfo(n);
  const kindBadge = n.treeKindLabel
    ? `<span class="brain-point-badge brain-point-badge--kind">${escapeHtml(n.treeKindLabel)}</span>`
    : '';
  const role = opts.role || n.role || '';
  const limb = n.limb ? `brain-graph-node--limb-${n.limb}` : '';
  const key = graphNodeKey(n);
  const selected = _graphSelectedKey && _graphSelectedKey === key;
  const neighbor = _graphSelectedKey && opts.neighborKeys?.has(key);
  const cls = [
    'brain-graph-node',
    role ? `brain-graph-node--${role}` : '',
    limb,
    st.cls === 'dirty' ? 'brain-graph-node--dirty' : '',
    selected ? 'brain-graph-node--selected' : '',
    neighbor ? 'brain-graph-node--neighbor' : '',
    _graphSelectedKey && !selected && !neighbor ? 'brain-graph-node--dim' : '',
  ].filter(Boolean).join(' ');
  const metaBits = [];
  if (n.stageCount) metaBits.push(`${n.stageCount} 片段`);
  if (n.branchCount || (n.twigs && n.twigs.length)) {
    metaBits.push(`${n.branchCount || n.twigs.length} 细枝`);
  }
  const tier = n.kind === 'narrative' || n.kind === 'branch' ? tierLabel(n.tier) : '';
  if (tier) metaBits.push(tier);
  if (st.label && st.label !== '收束') metaBits.push(st.label);
  const kind = n.kind === 'branch' ? 'branch' : 'narrative';
  const openId = n.id;
  const interactive = opts.interactive !== false;
  // hub 节点在 hub 视图里已经是当前话题，不重复打开
  const isCurrentHub = opts.mode === 'hub' && role === 'hub';
  // 把当前 hub id 作为 fromId，子节点点击后再返回时能回到上级
  const hubFromId = opts.hubId ? Number(opts.hubId) : 0;
  const onclick = !isCurrentHub && interactive
    ? (opts.mode === 'hub'
        ? `openLinkedExperience('${kind}',${openId},${hubFromId})`
        : `onGraphNodeTap('${kind}',${openId},${opts.root ? 'true' : 'false'})`)
    : (interactive ? `openLinkedExperience('${kind}',${openId},${hubFromId})` : '');
  const w = Math.round(n.w || 140);
  const h = Math.round(n.h || 70);
  return `
    <button type="button" class="${cls}" data-node-key="${escapeHtml(key)}"
      style="left:${Math.round(n.x || 0)}px;top:${Math.round(n.y || 0)}px;width:${w}px;min-height:${h}px"
      onclick="event.stopPropagation();${onclick}">
      <div class="brain-graph-node-accent" aria-hidden="true"></div>
      <div class="brain-graph-node-body">
        <div class="brain-graph-node-top">
          <div class="brain-graph-node-title">${escapeHtml(n.title || '未命名')}</div>
          <div class="brain-graph-node-badges">${kindBadge}</div>
        </div>
        ${metaBits.length ? `<div class="brain-graph-node-meta">${metaBits.map(escapeHtml).join(' · ')}</div>` : ''}
      </div>
    </button>`;
}

function buildGraphEdgePaths(placed, edges, { hasHub = false, width = 400 } = {}) {
  const byKey = new Map(placed.map((n) => [graphNodeKey(n), n]));
  const byId = new Map(placed.map((n) => [Number(n.id), n]));
  const resolveEdgeEnd = (ref) => {
    if (ref == null) return null;
    const s = String(ref);
    if (byKey.has(s)) return byKey.get(s);
    if (byKey.has(`narrative:${s}`)) return byKey.get(`narrative:${s}`);
    if (/^\d+$/.test(s)) return byId.get(Number(s)) || null;
    return null;
  };
  return (edges || [])
    .map((e) => {
      const a = resolveEdgeEnd(e.from);
      const b = resolveEdgeEnd(e.to);
      if (!a || !b) return '';
      const aw = a.w || 140;
      const ah = a.h || 70;
      const bw = b.w || 140;
      const bh = b.h || 70;
      let x1;
      let y1;
      let x2;
      let y2;
      let mx;
      let my;
      if (hasHub) {
        const aIsHub = a.role === 'hub';
        const bIsHub = b.role === 'hub';
        if (aIsHub || bIsHub) {
          const top = aIsHub ? a : b;
          const bot = aIsHub ? b : a;
          x1 = top.x + (top.w || aw) / 2;
          y1 = top.y + (top.h || ah);
          x2 = bot.x + (bot.w || bw) / 2;
          y2 = bot.y;
          mx = (x1 + x2) / 2;
          my = (y1 + y2) / 2;
        } else {
          // sequel-prev / sequel-next 顺序链：竖线
          const aIsSeq = a.role === 'sequel-prev' || a.role === 'sequel-next';
          const bIsSeq = b.role === 'sequel-prev' || b.role === 'sequel-next';
          if (aIsSeq && bIsSeq) {
            x1 = a.x + aw / 2;
            y1 = a.y + (a.h || ah);
            x2 = b.x + bw / 2;
            y2 = b.y;
            mx = (x1 + x2) / 2;
            my = (y1 + y2) / 2;
          } else {
            x1 = a.x + aw / 2;
            y1 = a.y + ah / 2;
            x2 = b.x + bw / 2;
            y2 = b.y + bh / 2;
            mx = (x1 + x2) / 2;
            my = (y1 + y2) / 2 - 8;
          }
        }
      } else {
        // 中心到中心的柔和曲线
        x1 = a.x + aw / 2;
        y1 = a.y + ah / 2;
        x2 = b.x + bw / 2;
        y2 = b.y + bh / 2;
        const dx = x2 - x1;
        const dy = y2 - y1;
        mx = (x1 + x2) / 2 - dy * 0.12;
        my = (y1 + y2) / 2 + dx * 0.08;
      }
      const fromKey = graphNodeKey(a);
      const toKey = graphNodeKey(b);
      const edgeType = e.type || (hasHub ? 'twig' : 'related');
      const active = _graphSelectedKey
        && (_graphSelectedKey === fromKey || _graphSelectedKey === toKey);
      const dim = _graphSelectedKey && !active;
      const cls = [
        'brain-graph-edge',
        `brain-graph-edge--${edgeType}`,
        active ? 'brain-graph-edge--active' : '',
        dim ? 'brain-graph-edge--dim' : '',
      ].filter(Boolean).join(' ');
      return `<path class="${cls}" data-from="${escapeHtml(fromKey)}" data-to="${escapeHtml(toKey)}" data-edge-type="${escapeHtml(edgeType)}" d="M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}" />`;
    })
    .join('');
}

function neighborKeysForSelection(edges, selectedKey) {
  const set = new Set();
  if (!selectedKey) return set;
  for (const e of edges || []) {
    const a = String(e.from).includes(':') ? String(e.from) : `narrative:${e.from}`;
    const b = String(e.to).includes(':') ? String(e.to) : `narrative:${e.to}`;
    if (a === selectedKey) set.add(b);
    if (b === selectedKey) set.add(a);
  }
  return set;
}

function renderTopicGraph(nodes, edges, {
  width = 340,
  height = 420,
  emptyText = '还没有话题卡片',
  hubId = null,
  zoomable = false,
  mode = 'root', // 'root' | 'hub'
} = {}) {
  if (!nodes.length) {
    return `<div class="empty-state"><div class="empty-icon">🕸</div>
      <div class="empty-text">${escapeHtml(emptyText)}<br><span style="font-size:12px;color:var(--text-secondary)">睡前整理后会把碎片收成话题卡</span></div>
    </div>`;
  }
  const hasHub = hubId != null || nodes.some((n) => n.role === 'hub');
  const layout = hasHub
    ? layoutHubGraphNodes(nodes, width)
    : layoutSpatialGraphNodes(nodes, {
      width: Math.max(560, width * 1.6),
      height: Math.max(560, height * 1.4),
      edges,
    });
  const placed = layout.placed;
  const canvasW = Math.ceil(layout.width || width);
  const canvasH = Math.ceil(layout.height || height);
  const isHub = mode === 'hub';
  if (isHub) {
    _hubCanvasSize = { w: canvasW, h: canvasH };
  } else {
    _graphCanvasSize = { w: canvasW, h: canvasH };
  }
  const neighborKeys = neighborKeysForSelection(edges, _graphSelectedKey);
  const lines = buildGraphEdgePaths(placed, edges, { hasHub, width: canvasW });
  const cards = placed.map((n) => renderGraphCard(n, {
    hubId: hubId,
    role: n.role,
    root: zoomable && !hasHub,
    interactive: zoomable && (mode === 'hub' || !hasHub),
    neighborKeys,
    mode,
  })).join('');
  const graphInner = `
    <div class="brain-memory-graph ${hasHub ? 'brain-memory-graph--hub' : 'brain-memory-graph--root'}"
      style="width:${canvasW}px;height:${canvasH}px">
      <svg class="brain-graph-svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}" preserveAspectRatio="xMidYMid meet">${lines}</svg>
      ${cards}
    </div>`;
  if (!zoomable) return graphInner;

  const vpId   = isHub ? 'hub-graph-viewport' : 'brain-graph-viewport';
  const cnvsId = isHub ? 'hub-graph-canvas'    : 'brain-graph-canvas';
  const pan    = isHub ? _hubPan : _graphPan;
  const { x, y, scale } = pan;
  const hintText = isHub
    ? '双指缩放 · 拖动画布 · 点击卡片跳转'
    : '双指缩放 · 拖动画布 · 点选卡片再点一次打开';

  if (isHub) {
    return `
    <div class="brain-graph-viewport brain-graph-viewport--hub" id="${vpId}"
      onpointerdown="onHubGraphPointerDown(event)"
      onpointermove="onHubGraphPointerMove(event)"
      onpointerup="onHubGraphPointerUp(event)"
      onpointercancel="onHubGraphPointerUp(event)"
      onclick="onHubGraphViewportClick(event)">
      <div class="brain-graph-viewport-hint">${hintText}</div>
      <div class="brain-graph-canvas" id="${cnvsId}"
        style="width:${canvasW}px;height:${canvasH}px;transform:translate(${x}px,${y}px) scale(${scale});transform-origin:0 0">
        ${graphInner}
      </div>
    </div>`;
  }
  return `
    <div class="brain-graph-viewport" id="${vpId}"
      onpointerdown="onGraphPointerDown(event)"
      onpointermove="onGraphPointerMove(event)"
      onpointerup="onGraphPointerUp(event)"
      onpointercancel="onGraphPointerUp(event)"
      onclick="onGraphViewportClick(event)">
      <div class="brain-graph-viewport-hint">${hintText}</div>
      <div class="brain-graph-canvas" id="${cnvsId}"
        style="width:${canvasW}px;height:${canvasH}px;transform:translate(${x}px,${y}px) scale(${scale});transform-origin:0 0">
        ${graphInner}
      </div>
    </div>`;
}

let _graphTransformScheduled = false;

function applyGraphTransform() {
  if (_graphTransformScheduled) return;
  _graphTransformScheduled = true;
  requestAnimationFrame(() => {
    _graphTransformScheduled = false;
    const el = document.getElementById('brain-graph-canvas');
    if (!el) return;
    const { x, y, scale } = _graphPan;
    el.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
  });
}

function clampGraphScale(s) {
  return Math.min(2.6, Math.max(0.35, s));
}

function centerGraphInViewport() {
  const vp = document.getElementById('brain-graph-viewport');
  if (!vp) return;
  const vw = vp.clientWidth || 320;
  const vh = vp.clientHeight || 420;
  const fit = Math.min(vw / _graphCanvasSize.w, vh / _graphCanvasSize.h, 1) * 0.92;
  _graphPan.scale = clampGraphScale(fit);
  _graphPan.x = (vw - _graphCanvasSize.w * _graphPan.scale) / 2;
  _graphPan.y = (vh - _graphCanvasSize.h * _graphPan.scale) / 2;
  applyGraphTransform();
}

function attachGraphWheelListeners() {
  const mainVp = document.getElementById('brain-graph-viewport');
  if (mainVp && !mainVp._wheelAttached) {
    mainVp.addEventListener('wheel', window.onGraphWheel, { passive: false });
    mainVp._wheelAttached = true;
  }
  const hubVp = document.getElementById('hub-graph-viewport');
  if (hubVp && !hubVp._wheelAttached) {
    hubVp.addEventListener('wheel', window.onHubGraphWheel, { passive: false });
    hubVp._wheelAttached = true;
  }
}

function applyGraphSelectionStyles() {
  const root = document.getElementById('brain-graph-viewport')
    || document.querySelector('.brain-memory-graph--root');
  if (!root) return;
  const nodes = filteredTopicNodes();
  const idSet = new Set(nodes.map((n) => Number(n.id)));
  const edges = (_expEdges || []).filter((e) => idSet.has(Number(e.from)) && idSet.has(Number(e.to)));
  const neighbors = neighborKeysForSelection(edges, _graphSelectedKey);
  root.querySelectorAll('.brain-graph-node').forEach((el) => {
    const key = el.getAttribute('data-node-key') || '';
    const selected = !!_graphSelectedKey && key === _graphSelectedKey;
    const neighbor = neighbors.has(key);
    el.classList.toggle('brain-graph-node--selected', selected);
    el.classList.toggle('brain-graph-node--neighbor', !!_graphSelectedKey && neighbor);
    el.classList.toggle('brain-graph-node--dim', !!_graphSelectedKey && !selected && !neighbor);
  });
  root.querySelectorAll('.brain-graph-edge').forEach((el) => {
    const from = el.getAttribute('data-from') || '';
    const to = el.getAttribute('data-to') || '';
    const active = !!_graphSelectedKey && (from === _graphSelectedKey || to === _graphSelectedKey);
    el.classList.toggle('brain-graph-edge--active', active);
    el.classList.toggle('brain-graph-edge--dim', !!_graphSelectedKey && !active);
  });
}

window.onGraphViewportClick = function(ev) {
  if (ev.target?.closest?.('.brain-graph-node')) return;
  if (_graphDidDrag) {
    _graphDidDrag = false;
    return;
  }
  if (_graphSelectedKey) {
    _graphSelectedKey = null;
    applyGraphSelectionStyles();
  }
};

window.onGraphNodeTap = function(kind, id, isRoot) {
  const key = `${kind === 'branch' ? 'branch' : 'narrative'}:${id}`;
  if (!isRoot) {
    return window.openLinkedExperience(kind, id);
  }
  if (_graphSelectedKey === key) {
    _graphSelectedKey = null;
    return window.openLinkedExperience(kind, id);
  }
  _graphSelectedKey = key;
  applyGraphSelectionStyles();
};

window.onGraphPointerDown = function(ev) {
  const vp = document.getElementById('brain-graph-viewport');
  if (!vp) return;
  if (ev.target?.closest?.('.brain-graph-node')) return;
  ev.preventDefault();
  _graphDidDrag = false;
  try {
    vp.setPointerCapture(ev.pointerId);
  } catch (e) {
    // setPointerCapture might fail, continue anyway
  }
  const g = _graphGesture || { pointers: new Map() };
  g.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (g.pointers.size === 1) {
    g.mode = 'pan';
    g.startPan = { ..._graphPan };
    g.origin = { x: ev.clientX, y: ev.clientY };
  } else if (g.pointers.size >= 2) {
    const pts = [...g.pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    g.mode = 'pinch';
    g.startDist = Math.sqrt(dx * dx + dy * dy) || 1;
    g.startScale = _graphPan.scale;
    g.startPan = { ..._graphPan };
    g.mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }
  _graphGesture = g;
};

window.onGraphPointerMove = function(ev) {
  const g = _graphGesture;
  if (!g?.pointers?.has(ev.pointerId)) return;
  ev.preventDefault();
  g.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (g.mode === 'pan' && g.pointers.size === 1) {
    const dx = ev.clientX - g.origin.x;
    const dy = ev.clientY - g.origin.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) _graphDidDrag = true;
    _graphPan.x = g.startPan.x + dx;
    _graphPan.y = g.startPan.y + dy;
    applyGraphTransform();
    return;
  }
  if (g.mode === 'pinch' && g.pointers.size >= 2) {
    _graphDidDrag = true;
    const pts = [...g.pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const nextScale = clampGraphScale(g.startScale * (dist / g.startDist));
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const vp = document.getElementById('brain-graph-viewport');
    const rect = vp?.getBoundingClientRect();
    if (rect) {
      const lx = mid.x - rect.left;
      const ly = mid.y - rect.top;
      const worldX = (lx - g.startPan.x) / g.startScale;
      const worldY = (ly - g.startPan.y) / g.startScale;
      _graphPan.scale = nextScale;
      _graphPan.x = lx - worldX * nextScale;
      _graphPan.y = ly - worldY * nextScale;
    } else {
      _graphPan.scale = nextScale;
    }
    applyGraphTransform();
  }
};

window.onGraphPointerUp = function(ev) {
  const g = _graphGesture;
  if (!g) return;
  const vp = document.getElementById('brain-graph-viewport');
  try {
    vp?.releasePointerCapture(ev.pointerId);
  } catch (e) {
    // releasePointerCapture might fail, continue anyway
  }
  g.pointers.delete(ev.pointerId);
  if (g.pointers.size === 0) {
    _graphGesture = null;
  } else if (g.pointers.size === 1) {
    const pt = [...g.pointers.values()][0];
    g.mode = 'pan';
    g.startPan = { ..._graphPan };
    g.origin = { x: pt.x, y: pt.y };
  }
};

window.onGraphWheel = function(ev) {
  ev.preventDefault();
  const vp = document.getElementById('brain-graph-viewport');
  if (!vp) return;
  const rect = vp.getBoundingClientRect();
  const lx = ev.clientX - rect.left;
  const ly = ev.clientY - rect.top;
  const before = _graphPan.scale;
  const next = clampGraphScale(before * (ev.deltaY > 0 ? 0.9 : 1.1));
  const worldX = (lx - _graphPan.x) / before;
  const worldY = (ly - _graphPan.y) / before;
  _graphPan.scale = next;
  _graphPan.x = lx - worldX * next;
  _graphPan.y = ly - worldY * next;
  applyGraphTransform();
};

function renderExpSurfacePills() {
  return `<div class="brain-kind-pills" style="margin-bottom:8px">
    <button type="button" class="brain-cat-pill ${_expSurface === 'topics' ? 'active' : ''}" onclick="switchExpSurface('topics')">记忆点</button>
    <button type="button" class="brain-cat-pill ${_expSurface === 'lived' ? 'active' : ''}" onclick="switchExpSurface('lived')">事记</button>
  </div>`;
}

window.switchExpSurface = function(surface) {
  _expSurface = surface === 'lived' ? 'lived' : 'topics';
  if (_expSurface === 'lived') loadLivedMemory();
  else loadBrainExperiences();
};

function renderExpList(opts = {}) {
  const list = document.getElementById('brain-exp-list');
  if (!list) return;
  const keepPan = !!opts.keepPan;
  const allLiving = livingTopicNodes();
  const nodes = filteredTopicNodes();
  const idSet = new Set(nodes.map((n) => Number(n.id)));
  const edges = (_expEdges || []).filter((e) => idSet.has(Number(e.from)) && idSet.has(Number(e.to)));
  const hidden = Math.max(0, allLiving.length - nodes.length);
  const pills = Object.entries(KIND_FILTER_LABELS).map(([k, label]) =>
    `<button type="button" class="brain-cat-pill ${_expKindFilter === k ? 'active' : ''}" onclick="filterExpKind('${k}')">${label}</button>`
  ).join('');
  const hint = `${renderExpSurfacePills()}
    <p class="brain-hint">跨天同一件事会收成记忆点，有关联的会连线。双指缩放拖动画布；点选卡片高亮连线，再点一次打开时间线。
    <button type="button" class="btn btn-ghost btn-sm" onclick="switchMemTab('butler')">整理</button></p>
    <div class="brain-kind-pills">${pills}</div>`;

  if (!allLiving.length) {
    list.innerHTML = hint + `
      <div class="empty-state"><div class="empty-icon">🕸</div>
        <div class="empty-text">还没有记忆点<br><span style="font-size:12px;color:var(--text-secondary)">聊天碎片晚上会整理进这里；也可在「整理」里归入记忆点</span></div>
      </div>`;
    return;
  }

  const w = Math.max(280, Math.min(480, (list.clientWidth || 340) - 4));
  let more = '';
  if (hidden > 0 && !_expShowAllNodes) {
    more = `<div class="brain-graph-more"><button type="button" class="btn btn-ghost btn-sm" onclick="expandExpGraph()">还有 ${hidden} 个话题，展开全部</button></div>`;
  } else if (_expShowAllNodes && allLiving.length > 25) {
    more = `<div class="brain-graph-more"><button type="button" class="btn btn-ghost btn-sm" onclick="collapseExpGraph()">收起为热门话题</button></div>`;
  }
  if (!keepPan) {
    _graphSelectedKey = null;
    _graphPan = { x: 0, y: 0, scale: 1 };
  }
  list.innerHTML = hint + renderTopicGraph(nodes, edges, {
    width: w,
    height: Math.max(420, (list.clientHeight || 480) - 80),
    zoomable: true,
  }) + more;
  if (!keepPan) {
    requestAnimationFrame(() => {
      centerGraphInViewport();
      attachGraphWheelListeners();
    });
  } else {
    applyGraphTransform();
    requestAnimationFrame(() => attachGraphWheelListeners());
  }
}

window.filterExpKind = function(kind) {
  _expKindFilter = kind || 'all';
  _expShowAllNodes = false;
  renderExpList();
};

window.expandExpGraph = function() {
  _expShowAllNodes = true;
  renderExpList();
};

window.collapseExpGraph = function() {
  _expShowAllNodes = false;
  renderExpList();
};

window.rebuildTopicLinks = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  try {
    const r = await api.rebuildNarrativeLinks(charId);
    window.showToast?.(`话题连线已更新（${r.links || 0}）`);
    _allExpItems = [];
    loadBrainExperiences();
  } catch (e) {
    window.showToast?.(e.message || '补算失败');
  }
};

function pointStatusInfo(n) {
  if (n.leaf || n.status === 'fallen') {
    return { label: '落叶', cls: 'closed' };
  }
  if (n.dirty) return { label: '待消化', cls: 'dirty' };
  if (n.status === 'closed') return { label: '收束', cls: 'settled' };
  return { label: '生长', cls: 'active' };
}

function moodToneClass(valence) {
  const v = Number(valence);
  if (!Number.isFinite(v)) return 'neutral';
  if (v >= 0.15) return 'warm';
  if (v <= -0.15) return 'cool';
  return 'neutral';
}

function classifyExpItem(n) {
  if (n.leaf || n.status === 'fallen') return 'fallen';
  if (n.dirty) return 'dirty';
  return 'active';
}

function tierLabel(tier) {
  if (tier === 'warm') return '温';
  if (tier === 'cool') return '凉';
  if (tier === 'dormant') return '休眠';
  if (tier === 'hot') return '热';
  return '';
}

function renderExpCard(n) {
  const st = pointStatusInfo(n);
  const range = formatPointDateRange(n.startedAt || n.dateFrom, n.dateTo);
  const stages = Number(n.stageCount) || 0;
  const twigs = Array.isArray(n.twigs) ? n.twigs : [];
  const limb = n.limb || 'mid';
  const cardCls = [
    'brain-point-card',
    'brain-limb',
    `brain-limb--${limb}`,
    st.cls === 'dirty' ? 'brain-point-card--dirty' : '',
  ].filter(Boolean).join(' ');
  const tier = n.kind === 'narrative' ? tierLabel(n.tier) : '';
  const openKind = n.kind === 'branch' ? 'branch' : 'narrative';
  const openId = n.id;
  const mood = n.moodLabel ? `<span class="brain-point-dot">·</span><span>${escapeHtml(n.moodLabel)}</span>` : '';
  const stance = String(n.stance || n.gist || '').trim();
  const kindBadge = n.treeKindLabel
    ? `<span class="brain-point-badge brain-point-badge--kind">${escapeHtml(n.treeKindLabel)}</span>`
    : '';
  const twigHtml = twigs.length
    ? `<div class="brain-limb-twigs">${twigs.map((t) =>
      `<span class="brain-limb-twig">${escapeHtml(t.title || '细枝')}</span>`
    ).join('')}</div>`
    : '';
  return `
    <div class="${cardCls}" onclick="openExperienceDetail('${openKind}',${openId})">
      <div class="brain-point-accent"></div>
      <div class="brain-point-main">
        <div class="brain-point-top">
          <div class="brain-point-title">${escapeHtml(n.title || '未命名')}</div>
          <div class="brain-point-badges">
            ${kindBadge}
            ${st.label !== '收束' ? `<span class="brain-point-badge brain-point-badge--${st.cls}">${st.label}</span>` : ''}
          </div>
        </div>
        ${stance ? `<div class="brain-point-stance">${escapeHtml(stance)}</div>` : ''}
        ${twigHtml}
        <div class="brain-point-meta">
          <span>${escapeHtml(range)}</span>
          ${stages ? `<span class="brain-point-dot">·</span><span>${stages} 片段</span>` : ''}
          ${twigs.length ? `<span class="brain-point-dot">·</span><span>${twigs.length} 细枝</span>` : ''}
          ${tier ? `<span class="brain-point-dot">·</span><span>${tier}</span>` : ''}
          ${mood}
        </div>
      </div>
    </div>`;
}

function filterExpItems(items, filter) {
  if (filter === 'active') {
    return items.filter((n) => {
      const c = classifyExpItem(n);
      return c === 'dirty' || c === 'active' || c === 'episode';
    });
  }
  return items.filter((n) => classifyExpItem(n) !== 'fallen');
}

async function loadFallenLeaves() {
  const list = document.getElementById('brain-leaves-list');
  if (!list) return;
  const charId = window.getActiveCharId?.();
  if (!charId) {
    list.innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  try {
    if (!_allExpItems.length) ingestExpPayload(await api.getBrainExperiences(charId));
  } catch {
    list.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
    return;
  }
  const leaves = _allExpItems.filter((n) => classifyExpItem(n) === 'fallen');
  const hint = `<p class="brain-hint">掉下来的想不起来，聊天里不会带。你可以翻、可以删。再讲同一件事会重新发芽。</p>`;
  if (!leaves.length) {
    list.innerHTML = hint + `<div class="empty-state"><div class="empty-icon">🍂</div><div class="empty-text">还没有落叶</div></div>`;
    return;
  }
  list.innerHTML = hint + leaves.map((n) => {
    const card = renderExpCard(n);
    const del = n.kind === 'branch'
      ? `<button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation();deleteLeafBranch(${n.id})">删除</button>`
      : `<button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation();deleteNarrativeVol(${n.id})">删除</button>`;
    return `<div class="brain-leaf-row">${card}<div class="brain-leaf-actions">${del}</div></div>`;
  }).join('');
}

window.deleteLeafBranch = async function(id) {
  if (!confirm('从落叶堆删掉这根细枝？')) return;
  try {
    await api.deleteMemoryBranch(id);
    window.showToast?.('已删除');
    _allExpItems = [];
    loadFallenLeaves();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

function renderStoryTimeline(stages) {
  if (!stages.length) {
    return `
      <div class="brain-story-empty">
        <div class="brain-story-empty-icon">🕰</div>
        <div>还没有挂上阶段碎片</div>
        <div class="brain-story-empty-sub">整理里「归入记忆点」后，会按时间排在这里</div>
      </div>`;
  }
  return `<div class="schedule-timeline brain-story-timeline">${stages.map((s) => {
    const moodCls = moodToneClass(s.moodValence);
    const mood = String(s.mood || '').trim();
    const time = s.time || '—';
    const dateShort = formatPointDate(s.date);
    return `
      <div class="schedule-item brain-story-item">
        <div class="schedule-time-col">
          <div class="schedule-time-dot"></div>
          <div class="schedule-time">${escapeHtml(time)}</div>
          <div class="brain-story-date">${escapeHtml(dateShort)}</div>
        </div>
        <div class="schedule-card brain-story-beat">
          <div class="brain-story-beat-head">
            ${mood ? `<span class="brain-story-mood brain-story-mood--${moodCls}">${escapeHtml(mood)}</span>` : ''}
            ${s.category ? `<span class="brain-story-cat">${escapeHtml(s.category)}</span>` : ''}
          </div>
          <div class="brain-story-beat-text">${escapeHtml(s.content || '')}</div>
        </div>
      </div>`;
  }).join('')}</div>`;
}

window.closeStoryDetail = function() {
  document.getElementById('narrative-detail-overlay')?.classList.remove('active');
  _detailCache = null;
  _detailView = 'timeline';
  _detailReturnHub = null;
};

window.storyDetailBack = function() {
  window.closeStoryDetail();
};

window.filterExpView = function(filter) {
  _expFilter = filter;
  renderExpList();
};

window.toggleMemCatBar = function() {
  _memCatBarOpen = !_memCatBarOpen;
  const bar = document.getElementById('mem-filter-bar');
  const btn = document.getElementById('mem-cat-toggle');
  if (bar) bar.classList.toggle('brain-cat-pills--collapsed', !_memCatBarOpen);
  if (btn) btn.classList.toggle('active', _memCatBarOpen);
};

async function loadBrainExperiences() {
  const charId = window.getActiveCharId?.();
  const list = document.getElementById('brain-exp-list');
  if (!list) return;
  _expSurface = 'topics';
  if (!charId) {
    list.innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  list.innerHTML = `${renderExpSurfacePills()}<p class="brain-hint">记忆点与连线。</p><div class="loading"><div class="loading-spinner"></div></div>`;
  try {
    const data = await api.getBrainExperiences(charId);
    try {
      ingestExpPayload(data);
      renderExpList();
    } catch (innerErr) {
      console.error('[brain-exp] render failed', innerErr);
      throw innerErr;
    }
  } catch (e) {
    console.error('[brain-exp] load failed', e);
    _allExpItems = [];
    _treeTrunk = null;
    list.innerHTML = `${renderExpSurfacePills()}<div class="empty-state"><div class="empty-icon">🕸</div>
      <div class="empty-text">图谱加载失败<br><span style="font-size:12px;color:var(--text-secondary)">${escapeHtml(e?.message || String(e))}</span><br>
      <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="loadBrainExperiences()">重试</button></div>
    </div>`;
  }
}
window.loadBrainExperiences = loadBrainExperiences;

async function loadBrainTidy() {
  const charId = window.getActiveCharId?.();
  const el = document.getElementById('brain-tidy-stats');
  if (!el || !charId) return;
  try {
    const t = await api.getBrainTidy(charId);
    const pills = [
      `当前 ${t.current || 0}`,
      `过时 ${t.historical || 0}`,
      `归档 ${t.archived || 0}`,
      `事件边 ${t.links || 0}`,
      `待消化 ${t.dirtyNarratives || 0}`,
    ];
    if (t.lastPack) pills.push(`上次打包 ${t.lastPack}`);
    el.innerHTML = pills.map(p => `<span class="brain-butler-stat">${escapeHtml(p)}</span>`).join('');
  } catch {
    el.innerHTML = '';
  }
}

async function loadNarratives() {
  const charId = window.getActiveCharId?.();
  const list = document.getElementById('narrative-list');
  if (!list) return;
  if (!charId) {
    list.innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  try {
    allNarratives = await api.getMemoryNarratives(charId);
    renderNarrativeList();
  } catch {
    list.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
  }
}

function renderNarrativeList() {
  const list = document.getElementById('narrative-list');
  if (!list) return;
  if (!allNarratives.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📌</div><div class="empty-text">暂无记忆点<br><span style="font-size:12px;color:var(--text-secondary)">碎片积累后可点「归入记忆点」，或等夜间自动归拢</span></div></div>`;
    return;
  }
  list.innerHTML = allNarratives.map(n => {
    const status = (n.leaf || n.status === 'fallen' || n.status === 'closed') ? '落叶' : (n.dirty ? '待消化' : '进行中');
    const statusColor = n.status === 'closed' ? 'var(--text-secondary)' : (n.dirty ? '#c4783a' : 'var(--theme)');
    const preview = String(n.content || '').replace(/\s+/g, ' ').slice(0, 90);
    return `
      <div class="memory-card" style="cursor:pointer" onclick="openNarrativeDetail(${n.id})">
        <div style="display:flex;align-items:flex-start;gap:8px">
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <div class="memory-category" style="color:var(--theme)">📌 ${escapeHtml(n.title || '未命名')}</div>
              <span style="font-size:11px;color:${statusColor}">${status}</span>
              <span style="font-size:11px;color:var(--text-secondary)">链 ${n.linked_count || 0}</span>
            </div>
            <div class="memory-content">${escapeHtml(preview)}${preview.length >= 90 ? '…' : ''}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

window.openNarrativeDetail = function(id) {
  return window.openExperienceDetail('narrative', id);
};

function fillExperienceHeader(n, kind) {
  const titleEl = document.getElementById('narrative-detail-title');
  const metaEl = document.getElementById('narrative-detail-meta');
  const statusEl = document.getElementById('narrative-detail-status');
  const st = pointStatusInfo(n);
  if (titleEl) titleEl.textContent = n.title || (kind === 'branch' ? '细枝' : '话题');
  if (metaEl) metaEl.textContent = formatPointDateRange(n.startedAt || n.dateFrom, n.dateTo || n.updatedAt);
  if (statusEl) {
    statusEl.textContent = st.label;
    statusEl.className = `brain-story-status brain-story-status--${st.cls}`;
  }
}

function renderExperienceLinks(n) {
  const twigs = (Array.isArray(n.branches) ? n.branches : []).filter(
    (b) => !b.fallen && b.key !== 'core' && b.type !== 'core'
  );
  // 从大话题点进相关小话题时：不要再把上级大话题当「相关卡片」露出来（避免 A→B→又见 A）
  const fromId = _detailReturnHub != null ? Number(_detailReturnHub) : null;
  const related = (Array.isArray(n.related) ? n.related : [])
    .filter((r) => fromId == null || Number(r.id) !== fromId);
  if (!twigs.length && !related.length) return '';
  const twigChips = twigs.length
    ? `<div class="brain-story-links-block">
        <div class="brain-story-links-label">细枝</div>
        <div class="brain-story-chips">${twigs.map((b) =>
          `<button type="button" class="brain-story-chip" onclick="openLinkedExperience('branch',${b.id},${n.id})">${escapeHtml(b.name || '细枝')}</button>`
        ).join('')}</div>
      </div>`
    : '';
  const relChips = related.length
    ? `<div class="brain-story-links-block">
        <div class="brain-story-links-label">相关话题</div>
        <div class="brain-story-chips">${related.map((r) =>
          `<button type="button" class="brain-story-chip brain-story-chip--related" onclick="openLinkedExperience('narrative',${r.id},${n.id})">${escapeHtml(r.title || '相关')}</button>`
        ).join('')}</div>
      </div>`
    : '';
  return `<div class="brain-story-links">${twigChips}${relChips}</div>`;
}

function renderExperienceTimelineBody(n, kind, opts = {}) {
  const gist = String(n.stance || n.gist || '').trim();
  const isNarrative = kind === 'narrative';
  const isBranch = kind === 'branch';
  const kindLine = (isNarrative || isBranch) && n.treeKindLabel
    ? `<div class="brain-tree-temp">${escapeHtml(n.treeKindLabel)}${isBranch ? '细枝' : '话题'}</div>`
    : '';
  const moodLine = n.moodLabel
    ? `<div class="brain-tree-temp">心情 ${escapeHtml(n.moodLabel)}</div>`
    : '';
  const gistBlock = gist
    ? `<div class="brain-story-gist">
        <div class="brain-story-gist-label">${isNarrative ? '这个话题现在怎么看' : (isBranch ? '所属' : '梗概')}</div>
        <div class="brain-story-gist-text">${escapeHtml(gist)}</div>
      </div>`
    : '';
  const tierBit = (isNarrative || isBranch) && n.tier
    ? `<div class="brain-tree-temp">温度 ${escapeHtml(tierLabel(n.tier))}${n.emotionCharge > 0.35 ? ' · 心情较重，枯得慢' : ''}</div>`
    : '';
  // 子图谱已经展示过分支/相关话题，下面链接块重复就别再列
  const links = (isNarrative && !opts.skipLinks) ? renderExperienceLinks(n) : '';
  let timeline = '';
  if (isNarrative) {
    timeline += `<div class="brain-story-section-label">话题时间线</div>${renderStoryTimeline(n.stages || [])}`;
  } else if (isBranch) {
    timeline += `<div class="brain-story-section-label">细枝时间线</div>${renderStoryTimeline(n.stages || [])}`;
  } else {
    timeline += `<div class="brain-story-section-label">挂上的碎片</div>${renderStoryTimeline(n.stages || [])}`;
  }
  return `${kindLine}${gistBlock}${moodLine}${tierBit}${links}${timeline}`;
}

function renderExperienceFooter(n, kind) {
  const isNarrative = kind === 'narrative';
  const realDel = isNarrative
    ? `<button class="btn btn-danger btn-sm" onclick="deleteNarrativeVol(${n.id})">删除</button>`
    : '';
  const totalStages = (n.stages || []).length
    + (Array.isArray(n.branches) ? n.branches.reduce((s, b) => s + (b.fallen ? 0 : (b.stages || []).length || Number(b.stageCount) || 0), 0) : 0);
  const twigN = Array.isArray(n.branches) ? n.branches.filter((b) => !b.fallen).length : 0;
  const canPrune = isNarrative && n.treeKind !== 'user' && n.treeKind !== 'self'
    && (totalStages >= 10 || twigN >= 5);
  const pruneBtn = canPrune
    ? `<button class="btn btn-ghost btn-sm" onclick="runMemoryTreePruneOne(${n.id})">✂️ 修剪这个话题</button>`
    : '';
  // 从上级话题点进来时：用「返回」代替再露一次上级卡片
  const backBtn = _detailReturnHub != null
    ? `<button class="btn btn-ghost btn-sm" onclick="backToParentTopic()">← 返回上级话题</button>`
    : '';
  return `
    ${backBtn}
    ${pruneBtn}
    ${realDel}
    <button class="btn btn-primary btn-sm" onclick="closeStoryDetail()">关闭</button>
  `;
}

function paintDetailTimeline(n, kind) {
  const bodyEl = document.getElementById('narrative-detail-body');
  const footEl = document.getElementById('narrative-detail-footer');
  if (!bodyEl) return;
  _detailView = 'timeline';
  fillExperienceHeader(n, kind);
  // 重置 hub 图谱状态，确保每次进入详情都是初始位置
  _hubPan = { x: 0, y: 0, scale: 1 };
  _hubCanvasSize = { w: 480, h: 400 };
  _hubGesture = null;
  _hubDidDrag = false;

  // 如果有子图谱（延续链+分支+相关话题），先渲染图谱视图
  let graphSection = '';
  const hasSubgraph = n.hasGraph && n.graph && n.graph.nodes && n.graph.nodes.length > 1;
  if (hasSubgraph) {
    graphSection = renderHubSubgraph(n.graph, n.id) + `
      <div class="brain-story-section-label">话题时间线</div>`;
  }

  bodyEl.innerHTML = graphSection + renderExperienceTimelineBody(n, kind, { skipLinks: hasSubgraph });
  if (footEl) footEl.innerHTML = renderExperienceFooter(n, kind);

  // 居中 hub 子图画布
  if (n.hasGraph && n.graph && n.graph.nodes.length > 1) {
    requestAnimationFrame(() => {
      centerHubGraphInViewport();
      attachGraphWheelListeners();
    });
  }
}

/** 渲染 hub 子图谱（在详情内，带独立 pan/zoom） */
function renderHubSubgraph(graph, hubId) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const width = Math.min(480, window.innerWidth - 32);
  return renderTopicGraph(nodes, edges, {
    width,
    height: 420,
    emptyText: '',
    hubId,
    zoomable: true,
    mode: 'hub',
  });
}

function centerHubGraphInViewport() {
  const vp = document.getElementById('hub-graph-viewport');
  if (!vp) return;
  const vw = vp.clientWidth || 320;
  const vh = vp.clientHeight || 380;
  const fit = Math.min(vw / _hubCanvasSize.w, vh / _hubCanvasSize.h, 1) * 0.92;
  _hubPan.scale = Math.min(2.6, Math.max(0.35, fit));
  _hubPan.x = (vw - _hubCanvasSize.w * _hubPan.scale) / 2;
  _hubPan.y = (vh - _hubCanvasSize.h * _hubPan.scale) / 2;
  applyHubGraphTransform();
}

let _hubTransformScheduled = false;

function applyHubGraphTransform() {
  if (_hubTransformScheduled) return;
  _hubTransformScheduled = true;
  requestAnimationFrame(() => {
    _hubTransformScheduled = false;
    const el = document.getElementById('hub-graph-canvas');
    if (!el) return;
    const { x, y, scale } = _hubPan;
    el.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
  });
}

window.onHubGraphWheel = function(ev) {
  ev.preventDefault();
  const vp = document.getElementById('hub-graph-viewport');
  if (!vp) return;
  const rect = vp.getBoundingClientRect();
  const lx = ev.clientX - rect.left;
  const ly = ev.clientY - rect.top;
  const before = _hubPan.scale;
  const next = Math.min(2.6, Math.max(0.35, before * (ev.deltaY > 0 ? 0.9 : 1.1)));
  const worldX = (lx - _hubPan.x) / before;
  const worldY = (ly - _hubPan.y) / before;
  _hubPan.scale = next;
  _hubPan.x = lx - worldX * next;
  _hubPan.y = ly - worldY * next;
  applyHubGraphTransform();
};

window.onHubGraphPointerDown = function(ev) {
  const vp = document.getElementById('hub-graph-viewport');
  if (!vp) return;
  if (ev.target?.closest?.('.brain-graph-node')) return;
  ev.preventDefault();
  _hubDidDrag = false;
  try {
    vp.setPointerCapture(ev.pointerId);
  } catch (e) {
    // setPointerCapture might fail, continue anyway
  }
  const g = _hubGesture || { pointers: new Map() };
  g.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (g.pointers.size === 1) {
    g.mode = 'pan';
    g.startPan = { ..._hubPan };
    g.origin = { x: ev.clientX, y: ev.clientY };
  } else if (g.pointers.size >= 2) {
    const pts = [...g.pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    g.mode = 'pinch';
    g.startDist = Math.sqrt(dx * dx + dy * dy) || 1;
    g.startScale = _hubPan.scale;
    g.startPan = { ..._hubPan };
    g.mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }
  _hubGesture = g;
};

window.onHubGraphPointerMove = function(ev) {
  const g = _hubGesture;
  if (!g?.pointers?.has(ev.pointerId)) return;
  ev.preventDefault();
  g.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (g.mode === 'pan' && g.pointers.size === 1) {
    const dx = ev.clientX - g.origin.x;
    const dy = ev.clientY - g.origin.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) _hubDidDrag = true;
    _hubPan.x = g.startPan.x + dx;
    _hubPan.y = g.startPan.y + dy;
    applyHubGraphTransform();
    return;
  }
  if (g.mode === 'pinch' && g.pointers.size >= 2) {
    _hubDidDrag = true;
    const pts = [...g.pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const nextScale = Math.min(2.6, Math.max(0.35, g.startScale * (dist / g.startDist)));
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const vp = document.getElementById('hub-graph-viewport');
    const rect = vp?.getBoundingClientRect();
    if (rect) {
      const lx = mid.x - rect.left;
      const ly = mid.y - rect.top;
      const worldX = (lx - g.startPan.x) / g.startScale;
      const worldY = (ly - g.startPan.y) / g.startScale;
      _hubPan.scale = nextScale;
      _hubPan.x = lx - worldX * nextScale;
      _hubPan.y = ly - worldY * nextScale;
    } else {
      _hubPan.scale = nextScale;
    }
    applyHubGraphTransform();
  }
};

window.onHubGraphPointerUp = function(ev) {
  const g = _hubGesture;
  if (!g) return;
  const vp = document.getElementById('hub-graph-viewport');
  try {
    vp?.releasePointerCapture(ev.pointerId);
  } catch (e) {
    // releasePointerCapture might fail, continue anyway
  }
  g.pointers.delete(ev.pointerId);
  if (g.pointers.size === 0) {
    _hubGesture = null;
  } else if (g.pointers.size === 1) {
    const pt = [...g.pointers.values()][0];
    g.mode = 'pan';
    g.startPan = { ..._hubPan };
    g.origin = { x: pt.x, y: pt.y };
  }
};

window.onHubGraphViewportClick = function(ev) {
  if (ev.target?.closest?.('.brain-graph-node')) return;
  if (_hubDidDrag) { _hubDidDrag = false; return; }
};

/**
 * 相关 / 细枝：只进时间线。
 * fromId = 从哪个话题点进来的；用来隐藏回指上级，避免小话题里又套出大话题。
 */
window.openLinkedExperience = function(kind, id, fromId) {
  const from = fromId != null && fromId !== '' ? Number(fromId) : null;
  return window.openExperienceDetail(kind || 'narrative', id, {
    view: 'timeline',
    fromId: Number.isFinite(from) ? from : null,
  });
};

window.openSubgraphNode = function(kind, id) {
  return window.openLinkedExperience(kind, id);
};

window.showExperienceTimeline = function(id) {
  return window.openExperienceDetail('narrative', id, { view: 'timeline' });
};

window.backToParentTopic = async function() {
  const parentId = _detailReturnHub;
  if (parentId == null) return;
  _detailReturnHub = null;
  await window.openExperienceDetail('narrative', parentId, { view: 'timeline' });
};

window.backToDetailGraph = async function() {
  return window.backToParentTopic();
};

window.openExperienceDetail = async function(kind, id, opts = {}) {
  const overlay = document.getElementById('narrative-detail-overlay');
  const bodyEl = document.getElementById('narrative-detail-body');
  const footEl = document.getElementById('narrative-detail-footer');
  const metaEl = document.getElementById('narrative-detail-meta');
  const statusEl = document.getElementById('narrative-detail-status');
  if (!overlay || !bodyEl) return;
  const charId = window.getActiveCharId?.();
  if (opts && typeof opts === 'object') {
    if (opts.fromId != null) _detailReturnHub = Number(opts.fromId);
    else if (opts.returnHub != null) _detailReturnHub = Number(opts.returnHub);
    else if (!opts.keepFrom) _detailReturnHub = null;
  } else {
    _detailReturnHub = null;
  }
  bodyEl.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  if (metaEl) metaEl.textContent = '';
  if (statusEl) {
    statusEl.textContent = '';
    statusEl.className = 'brain-story-status';
  }
  overlay.classList.add('active');
  try {
    const n = await api.getBrainExperience(charId, kind || 'narrative', id);
    if (!n) throw new Error('empty');
    const k = kind || n.kind || 'narrative';
    if (k === 'narrative') {
      _detailCache = n;
    }
    // 一律时间线；不再进「子图卡片」以免大↔小互相套娃
    paintDetailTimeline(n, k);
  } catch {
    bodyEl.innerHTML = '<div class="brain-story-empty"><div>加载失败</div></div>';
    if (footEl) footEl.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="closeStoryDetail()">关闭</button>`;
  }
};

window.closeNarrativeVol = async function(id) {
  try {
    await api.closeMemoryNarrative(id);
    window.showToast?.('已收束此枝');
    document.getElementById('narrative-detail-overlay')?.classList.remove('active');
    loadNarratives();
    loadBrainExperiences();
    loadBrainTidy();
  } catch (e) {
    window.showToast?.(e.message || '收束失败');
  }
};

window.deleteNarrativeVol = async function(id) {
  if (!confirm('删掉这个话题？碎片记忆仍保留。')) return;
  try {
    await api.deleteMemoryNarrative(id);
    document.getElementById('narrative-detail-overlay')?.classList.remove('active');
    loadNarratives();
    loadBrainExperiences();
    loadFallenLeaves();
    loadBrainTidy();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

/** 待整理的碎片提示 */
async function loadDayPending() {
  const box = document.getElementById('brain-day-pending');
  if (!box) return;
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  try {
    const r = await api.getMemoryDayPending(charId);
    if (!r.total) {
      box.textContent = '碎片都已经整理进话题图谱了。';
      box.className = 'brain-pending-hint is-clean';
      return;
    }
    const days = (r.days || []).map(d => `${d.day}(${d.count})`).join('、');
    box.textContent = `还有 ${r.total} 条碎片没挂上话题，分布在：${days}`;
    box.className = 'brain-pending-hint is-pending';
  } catch {
    box.textContent = '';
  }
}

/** 睡前整理：碎片 → 记忆点 → 挂树 */
window.runDayConsolidate = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId || _narrativeBusy) return;
  _narrativeBusy = true;
  window.showToast?.('整理中：连接碎片、去重、分割话题…');
  try {
    const r = await api.consolidateMemoryDay(charId);
    window.showToast?.(r.message || '整理完成');
    await loadNarratives();
    await loadBrainExperiences();
    await loadBrainTidy();
    await loadDayPending();
  } catch (e) {
    window.showToast?.(e.message || '整理失败');
  } finally {
    _narrativeBusy = false;
  }
};

/** 渲染修剪预览，等用户确认才 apply */
function renderPrunePreview(r) {
  const el = document.getElementById('butler-result');
  if (!el) return;
  if (!r?.plan || !r.proposed?.length) {
    el.innerHTML = `<div class="empty-state" style="padding:24px 0">
      <div class="empty-icon">✂️</div>
      <div class="empty-text" style="font-size:13px;line-height:1.6">${escapeHtml(r?.message || '没有可预览的修剪方案')}</div>
    </div>`;
    return;
  }
  _prunePlan = r.plan;
  const removedLines = (r.removed || []).map((x) =>
    `· 拆掉「${escapeHtml(x.title)}」（${x.stages || 0} 片段 / ${x.twigs || 0} 细枝）`
  ).join('<br>');
  const proposedLines = (r.proposed || []).map((t) => {
    const days = (t.days || []).length ? escapeHtml((t.days || []).join('、')) : '';
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border,rgba(0,0,0,.06))">
      <div style="font-size:13px;font-weight:500">${escapeHtml(t.title || '未命名')}
        <span style="font-size:11px;color:var(--text-secondary);font-weight:400"> · ${escapeHtml(t.kindLabel || '')} · ${t.fragCount || 0} 条</span>
      </div>
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-top:2px">${escapeHtml(t.summary || '')}</div>
      ${days ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${days}</div>` : ''}
    </div>`;
  }).join('');
  el.innerHTML = `<div class="brain-issue-card" style="margin-top:8px">
    <div style="font-size:13px;font-weight:500;margin-bottom:6px">修剪预览（尚未改树）</div>
    <div style="font-size:13px;line-height:1.6;margin-bottom:10px">${escapeHtml(r.message || '')}</div>
    <div style="font-size:12px;color:var(--text-secondary);line-height:1.7;margin-bottom:10px">${removedLines}</div>
    <div style="font-size:12px;font-weight:500;margin-bottom:4px">将长出的话题</div>
    <div style="margin-bottom:12px">${proposedLines}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" class="btn btn-primary btn-sm" onclick="confirmMemoryTreePrune()">确认修剪</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="cancelMemoryTreePrune()">取消</button>
    </div>
  </div>`;
}

/** 管家修剪：先预览，不改库 */
window.runMemoryTreePrune = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId || _narrativeBusy) return;
  _narrativeBusy = true;
  _prunePlan = null;
  window.showToast?.('正在算出修剪方案…');
  try {
    const r = await api.pruneMemoryTrees(charId);
    if (!r.plan || !r.proposed?.length) {
      window.showToast?.(r.message || '没有需要修剪的枝');
      renderPrunePreview(r);
      return;
    }
    window.showToast?.('方案已出，请确认后再动手');
    renderPrunePreview(r);
  } catch (e) {
    window.showToast?.(e.message || '预览失败');
  } finally {
    _narrativeBusy = false;
  }
};

/** 详情页：只预览修剪当前话题 */
window.runMemoryTreePruneOne = async function(narrativeId) {
  const charId = window.getActiveCharId?.();
  if (!charId || _narrativeBusy || !narrativeId) return;
  _narrativeBusy = true;
  _prunePlan = null;
  window.showToast?.('正在算出这个话题的修剪方案…');
  try {
    const r = await api.pruneMemoryTrees(charId, { narrativeId });
    closeStoryDetail();
    switchMemTab('butler');
    if (!r.plan || !r.proposed?.length) {
      window.showToast?.(r.message || '没法修剪这个话题');
      renderPrunePreview(r);
      return;
    }
    window.showToast?.('方案已出，请确认后再动手');
    renderPrunePreview(r);
  } catch (e) {
    window.showToast?.(e.message || '预览失败');
  } finally {
    _narrativeBusy = false;
  }
};

window.cancelMemoryTreePrune = function() {
  _prunePlan = null;
  const el = document.getElementById('butler-result');
  if (el) {
    el.innerHTML = `<div class="empty-state" style="padding:24px 0">
      <div class="empty-icon">🤖</div>
      <div class="empty-text" style="font-size:13px;line-height:1.6">已取消修剪，树没有改动</div>
    </div>`;
  }
  window.showToast?.('已取消');
};

window.confirmMemoryTreePrune = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId || _narrativeBusy) return;
  if (!_prunePlan) {
    window.showToast?.('没有待确认的方案，请先预览');
    return;
  }
  _narrativeBusy = true;
  window.showToast?.('正在按方案修剪…');
  try {
    const r = await api.pruneMemoryTrees(charId, { apply: true, plan: _prunePlan });
    _prunePlan = null;
    window.showToast?.(r.message || '修剪完成');
    const el = document.getElementById('butler-result');
    if (el) {
      const lines = (r.removed || []).map((x) =>
        `· 已拆「${escapeHtml(x.title)}」`
      ).join('<br>');
      el.innerHTML = `<div class="brain-issue-card" style="margin-top:8px">
        <div style="font-size:13px;font-weight:500;margin-bottom:6px">修剪完成</div>
        <div style="font-size:13px;line-height:1.6;margin-bottom:8px">${escapeHtml(r.message || '')}</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.7">${lines}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:8px">新主枝 ${r.newTrunks || 0} · 续挂 ${r.continued || 0} · 支线 ${r.sideBranches || 0} · 共挂回 ${r.grafted || 0} 条</div>
      </div>`;
    }
    await loadNarratives();
    await loadBrainExperiences();
    await loadBrainTidy();
    await loadDayPending();
  } catch (e) {
    window.showToast?.(e.message || '修剪失败');
  } finally {
    _narrativeBusy = false;
  }
};

window.runNarrativeMaintain = async function(heavy) {
  const charId = window.getActiveCharId?.();
  if (!charId || _narrativeBusy) return;
  _narrativeBusy = true;
  window.showToast?.('补挂剩余碎片中…');
  try {
    const r = await api.runMemoryNarrative(charId, !!heavy);
    const g = r.graft || {};
    let tip;
    if (g.grafted) {
      tip = `挂上 ${g.grafted} 条（新枝干 ${g.newTrunks || 0}，支线 ${g.sideBranches || 0}，延续 ${g.continued || 0}）`;
    } else if (r.cluster?.created) {
      tip = '已新建记忆点';
    } else if (r.cluster?.merged) {
      tip = '已并入已有记忆点';
    } else if (r.triage?.linked) {
      tip = `分诊挂上 ${r.triage.linked} 条`;
    } else if (r.digest?.focus && r.digest.focus !== 'none') {
      tip = `已消化：${r.digest.focus}`;
    } else {
      const why = {
        pool_small: '剩下的碎片太少，凑不成一件事',
        rerank_reject: '剩下的碎片彼此不是同一件事',
        no_cluster: '剩下的碎片之间找不到关联',
        debt: '有记忆点待消化，这轮先不聚类',
      }[r.cluster?.reason];
      tip = why || '没有剩余碎片可挂了';
    }
    window.showToast?.(tip);
    await loadNarratives();
    await loadBrainExperiences();
    await loadBrainTidy();
    await loadDayPending();
  } catch (e) {
    window.showToast?.(e.message || '维护失败');
  } finally {
    _narrativeBusy = false;
  }
};

/* ═══════════════════════════════════════════
   记忆 tab
══════════════════════════════════════════════ */
async function loadMemories(cat) {
  const charId = window.getActiveCharId?.();
  if (!charId) {
    document.getElementById('memory-list').innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  try {
    allMemories = await api.getMemories(charId);
    renderMemoryList(cat);
  } catch {
    document.getElementById('memory-list').innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
  }
}

function renderMemoryList(cat) {
  const list = document.getElementById('memory-list');
  if (!list) return;
  _memFilterCat = cat;
  const byDate = allMemories.filter(m => memoryMatchesDate(m, _memFilterDate));
  const filtered = cat === 'all' ? byDate : byDate.filter(m => m.category === cat);
  const dateLabel = !_memFilterDate ? '全部日期' : (_memFilterDate === getTodayDateStr() ? '今天' : _memFilterDate);
  const otherCount = allMemories.length - byDate.length;
  const countHint = document.getElementById('mem-date-count');
  if (countHint) {
    countHint.textContent = _memFilterDate
      ? `${dateLabel} ${filtered.length} 条${otherCount > 0 ? ` · 其他日期还有 ${otherCount} 条` : ''}`
      : `共 ${filtered.length} 条`;
  }
  if (!filtered.length) {
    const extra = otherCount > 0
      ? `<span style="font-size:12px;color:var(--text-secondary)">不是丢了：其他日期还有 ${otherCount} 条，点上方「全部」能看见</span>`
      : `<span style="font-size:12px;color:var(--text-secondary)">可点「全部」查看其他日期，或去管家整理</span>`;
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🧠</div><div class="empty-text">${dateLabel} 暂无记忆条目<br>${extra}</div></div>`;
    return;
  }
  const sorted = [...filtered].sort((a, b) => {
    const da = String(a.date || a.created_at || '').slice(0, 10);
    const db = String(b.date || b.created_at || '').slice(0, 10);
    if (da !== db) return db.localeCompare(da);
    return (b.id || 0) - (a.id || 0);
  });
  let lastDate = '';
  list.innerHTML = sorted.map(mem => {
    const info = getCategoryInfo(mem.category);
    const memDate = String(mem.date || mem.created_at || '').slice(0, 10);
    let header = '';
    if (!_memFilterDate && memDate && memDate !== lastDate) {
      lastDate = memDate;
      header = `<div class="brain-date-header">${memDate}</div>`;
    }
    return `${header}
      <div class="brain-mem-item" data-id="${mem.id}" style="--mem-accent:${info.color}">
        <div class="brain-mem-top">
          <div class="brain-mem-main">
            <div class="brain-mem-cat" style="color:${info.color}">${info.icon} ${mem.category}</div>
            <div class="brain-mem-content">${escapeHtml(mem.content)}</div>
            <div class="brain-mem-date">${formatMemoryDateLabel(mem)}</div>
          </div>
          <div class="brain-mem-actions">
            <button type="button" class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:13px" title="编辑" onclick="editMemory(${mem.id})">✎</button>
            <button type="button" class="btn btn-danger btn-sm" style="padding:4px 8px;font-size:13px" title="删除" onclick="deleteMemory(${mem.id})">🗑</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

window.filterMemory = function(cat, el) {
  document.querySelectorAll('#mem-filter-bar [data-cat]').forEach(e => e.classList.remove('active'));
  el?.classList.add('active');
  renderMemoryList(cat);
};

window.onMemoryDateChange = function(dateStr) {
  _memFilterDate = dateStr || '';
  const dateInput = document.getElementById('mem-date-filter');
  if (dateInput) dateInput.value = _memFilterDate;
  renderMemoryList(_memFilterCat);
};

window.shiftMemoryDate = function(days) {
  const base = _memFilterDate || getTodayDateStr();
  _memFilterDate = shiftMemDate(base, days);
  const dateInput = document.getElementById('mem-date-filter');
  if (dateInput) dateInput.value = _memFilterDate;
  renderMemoryList(_memFilterCat);
};

window.resetMemoryDateToday = function() {
  window.onMemoryDateChange(getTodayDateStr());
};

window.showAllMemoryDates = function() {
  _memFilterDate = '';
  const dateInput = document.getElementById('mem-date-filter');
  if (dateInput) dateInput.value = '';
  renderMemoryList(_memFilterCat);
};

window.openAddMemory = function() {
  editingMemId = null;
  _editingLivedMem = false;
  document.getElementById('mem-modal-title').textContent = '添加记忆';
  document.getElementById('mem-content').value = '';
  document.getElementById('memory-edit-overlay').classList.add('active');
};

window.editMemory = function(id) {
  editingMemId = id;
  _editingLivedMem = false;
  const mem = allMemories.find(m => m.id === id);
  if (!mem) return;
  document.getElementById('mem-modal-title').textContent = '编辑记忆';
  ensureMemCategoryOption(mem.category);
  document.getElementById('mem-content').value = mem.content;
  document.getElementById('memory-edit-overlay').classList.add('active');
};

window.editLivedMemory = function(id) {
  const mem = findLivedMemory(id);
  if (!mem) {
    window.showToast?.('找不到这条事记');
    return;
  }
  editingMemId = Number(mem.id);
  _editingLivedMem = true;
  document.getElementById('mem-modal-title').textContent = mem.source === 'day_story' ? '编辑整天事记' : '编辑事记';
  ensureMemCategoryOption(mem.category || '日常点滴');
  document.getElementById('mem-content').value = mem.content || '';
  document.getElementById('memory-edit-overlay').classList.add('active');
};

window.saveMemory = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  const category = document.getElementById('mem-category').value;
  const content  = document.getElementById('mem-content').value.trim();
  if (!content) { window.showToast?.('内容不能为空'); return; }
  const fromLived = _editingLivedMem;
  try {
    if (editingMemId) {
      const existing = fromLived ? findLivedMemory(editingMemId) : allMemories.find((m) => m.id === editingMemId);
      const weight = CATEGORIES[category]?.weight
        || Number(existing?.weight)
        || 0.5;
      await api.updateMemory(editingMemId, { category, content, weight });
    } else {
      await api.createMemory({ characterId: charId, category, content, weight: CATEGORIES[category]?.weight || 0.5 });
    }
    document.getElementById('memory-edit-overlay').classList.remove('active');
    window.showToast?.('已保存');
    _editingLivedMem = false;
    if (fromLived || _expSurface === 'lived') await loadLivedMemory();
    else await loadMemories(_memFilterCat);
  } catch(e) { window.showToast?.(e.message); }
};

window.deleteMemory = async function(id) {
  if (!confirm('确定删除这条记忆？')) return;
  try {
    await api.deleteMemory(id);
    allMemories = allMemories.filter(m => m.id !== id);
    renderMemoryList(_memFilterCat);
    window.showToast?.('已删除');
  } catch(e) { window.showToast?.(e.message); }
};

window.deleteLivedMemory = async function(id) {
  if (!confirm('确定删除这条事记？')) return;
  try {
    await api.deleteMemory(id);
    window.showToast?.('已删除');
    await loadLivedMemory();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

/* ═══════════════════════════════════════════
   记忆管家 tab
══════════════════════════════════════════════ */
const BUTLER_ISSUE_LABELS = {
  not_injected: '未注入当前对话',
  conflict: '互相矛盾',
  duplicate: '重复记忆',
  vague: '内容模糊',
  outdated: '可能过时',
  wrong: '内容有误',
  missing: '缺失记忆',
};

const BUTLER_SUGGEST_LABELS = {
  edit: '建议修改',
  delete: '建议删除',
  merge: '建议合并',
  ignore: '可忽略',
  add_new: '建议新增',
};

function renderButlerResult(data) {
  const el = document.getElementById('butler-result');
  if (!el) return;

  const facts = data.systemFacts || {};
  let html = '';

  if (data.diagnosis) {
    html += `<div class="brain-result-block">
      <div class="brain-result-label">🤖 管家诊断</div>
      <div class="brain-result-text">${escapeHtml(data.diagnosis)}</div>
    </div>`;
  }

  if (data.causes?.length) {
    html += `<div class="brain-result-block">
      <div class="brain-result-label">可能原因</div>
      ${data.causes.map(c => `<div style="font-size:13px;padding:6px 0;border-bottom:1px solid var(--border)">· ${escapeHtml(c)}</div>`).join('')}
    </div>`;
  }

  if (facts.totalMemories != null) {
    html += `<div class="brain-butler-stats" style="margin-bottom:12px">
      <span class="brain-butler-stat">共 ${facts.totalMemories} 条</span>
      <span class="brain-butler-stat">注入 ${facts.injectedNow ?? data.injectedMemories?.length ?? 0} 条</span>
      <span class="brain-butler-stat">总结${facts.memorySummaryEnabled ? '开' : '关'}</span>
      ${facts.notInjectedNow > 0 ? `<span class="brain-butler-stat">${facts.notInjectedNow} 条未匹配</span>` : ''}
    </div>`;
  }

  if (data.injectedMemories?.length) {
    html += `<div class="brain-result-block">
      <div class="brain-result-label">当前会被注入的记忆</div>
      ${data.injectedMemories.map(m => `
        <div class="brain-inject-preview">
          <span style="color:var(--theme);font-size:11px">#${m.id} ${escapeHtml(m.category)}</span><br>${escapeHtml(m.content)}
        </div>`).join('')}
    </div>`;
  }

  if (data.items?.length) {
    _lastButlerItems = data.items.map(i => ({ ...i, _applied: false }));
    const actionable = _lastButlerItems.filter(i =>
      !i._applied && ['edit', 'delete', 'merge', 'add_new'].includes(i.suggestion) && (i.memory_id || i.suggested_content)
    );
    if (actionable.length) {
      html += `<div style="margin-bottom:10px" id="butler-apply-all-wrap">
        <button class="btn btn-primary btn-sm" id="butler-apply-all-btn" onclick="butlerApplyAll()">全部采纳（${actionable.length} 项）</button>
      </div>`;
    }
    html += `<div style="font-size:13px;font-weight:500;margin-bottom:8px">${data.mode === 'clean' ? '整理建议' : '问题记忆'}</div>`;
    html += `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">采纳后不会自动重诊；要再查请手动点上方诊断按钮</div>`;
    html += data.items.map((item, idx) => {
      const mem = item.memory;
      const sevColor = item.severity === 'high' ? '#e57373' : item.severity === 'medium' ? '#ffb74d' : 'var(--text-secondary)';
      const issueLabel = BUTLER_ISSUE_LABELS[item.issue_type] || item.issue_type || '待查';
      const sugLabel = BUTLER_SUGGEST_LABELS[item.suggestion] || item.suggestion || '';
      return `<div class="brain-issue-card" data-butler-idx="${idx}">
        <div class="brain-issue-tags">
          <span class="brain-issue-tag" style="background:${sevColor}22;color:${sevColor}">${issueLabel}</span>
          ${sugLabel ? `<span class="brain-issue-tag" style="background:color-mix(in srgb, var(--theme) 12%, transparent);color:var(--theme)">${sugLabel}</span>` : ''}
          ${item.memory_id ? `<span class="brain-issue-tag" style="background:rgba(0,0,0,0.06);color:var(--text-secondary)">#${item.memory_id}</span>` : ''}
        </div>
        ${item.title ? `<div style="font-size:14px;margin-bottom:4px;font-weight:500">${escapeHtml(item.title)}</div>` : ''}
        ${mem ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;padding:8px;background:rgba(0,0,0,0.06);border-radius:8px;line-height:1.5">${escapeHtml(mem.content)}</div>` : ''}
        <div style="font-size:13px;line-height:1.55;margin-bottom:8px">${escapeHtml(item.explanation || '')}</div>
        ${item.suggested_content ? `<div class="brain-inject-preview">建议：${escapeHtml(item.suggested_content)}</div>` : ''}
        <div class="butler-actions" style="display:flex;gap:6px;flex-wrap:wrap">
          ${item.suggestion === 'edit' && item.memory_id && item.suggested_content ? `<div class="btn btn-primary btn-sm" onclick="butlerApplyEdit(${idx})">采纳修改</div>` : ''}
          ${item.suggestion === 'merge' && item.memory_id && item.suggested_content ? `<div class="btn btn-primary btn-sm" onclick="butlerApplyMerge(${idx})">采纳合并</div>` : ''}
          ${item.memory_id && item.suggestion === 'delete' ? `<div class="btn btn-danger btn-sm" onclick="butlerDeleteMemory(${item.memory_id}, false, ${idx})">删除</div>` : ''}
          ${!item.memory_id && item.suggestion === 'add_new' && item.suggested_content ? `<div class="btn btn-primary btn-sm" onclick="butlerAddFromItem(${idx})">添加记忆</div>` : ''}
          ${item.memory_id && item.suggestion === 'edit' && !item.suggested_content ? `<div class="btn btn-ghost btn-sm" onclick="butlerEditMemory(${item.memory_id})">手动编辑</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  if (data.missing_suggestions?.length) {
    html += `<div style="margin-top:12px">
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">建议补充的记忆</div>
      ${data.missing_suggestions.map(s => `<div style="font-size:13px;padding:4px 0">· ${escapeHtml(s)}</div>`).join('')}
    </div>`;
  }

  if (data.tips?.length) {
    html += `<div class="brain-result-block">
      <div class="brain-result-label">管家建议</div>
      ${data.tips.map(t => `<div style="font-size:13px;line-height:1.6;padding:3px 0">💡 ${escapeHtml(t)}</div>`).join('')}
    </div>`;
  }

  el.innerHTML = html || '<div class="empty-state"><div class="empty-text">暂无诊断结果</div></div>';
}

function markButlerItemApplied(idx, label = '已采纳') {
  if (_lastButlerItems[idx]) _lastButlerItems[idx]._applied = true;
  const card = document.querySelector(`#butler-result .brain-issue-card[data-butler-idx="${idx}"]`);
  const actions = card?.querySelector('.butler-actions');
  if (actions) {
    actions.innerHTML = `<div style="font-size:12px;color:var(--theme)">✓ ${escapeHtml(label)}</div>`;
  }
  // 同步「全部采纳」剩余数量；清完则隐藏
  const left = _lastButlerItems.filter(i =>
    !i._applied && ['edit', 'delete', 'merge', 'add_new'].includes(i.suggestion) && (i.memory_id || i.suggested_content)
  ).length;
  const btn = document.getElementById('butler-apply-all-btn');
  const wrap = document.getElementById('butler-apply-all-wrap');
  if (btn) btn.textContent = `全部采纳（${left} 项）`;
  if (wrap && left <= 0) wrap.style.display = 'none';
}

window.butlerApplyEdit = async function(idx, silent = false) {
  const item = _lastButlerItems[idx];
  if (!item?.memory_id || !item.suggested_content || item._applied) return;
  const mem = item.memory || allMemories.find(m => m.id === item.memory_id);
  if (!mem) { window.showToast?.('记忆不存在'); return; }
  try {
    await api.updateMemory(item.memory_id, {
      category: mem.category,
      content: item.suggested_content,
      weight: mem.weight ?? 0.5,
    });
    markButlerItemApplied(idx, '已采纳修改');
    if (!silent) window.showToast?.('已采纳修改');
    // 后台刷新记忆列表，但不重跑管家诊断、不刷新结果区
    loadMemories(_memFilterCat).catch(() => {});
  } catch(e) { window.showToast?.(e.message); }
};

window.butlerApplyMerge = async function(idx, silent = false) {
  const item = _lastButlerItems[idx];
  if (!item?.memory_id || !item.suggested_content || item._applied) return;
  const mem = item.memory || allMemories.find(m => m.id === item.memory_id);
  if (!mem) return;
  const mergeIds = Array.isArray(item.merge_ids) ? item.merge_ids : [];
  try {
    await api.updateMemory(item.memory_id, {
      category: mem.category,
      content: item.suggested_content,
      weight: Math.max(mem.weight ?? 0.5, 0.7),
    });
    for (const mid of mergeIds) {
      if (mid && mid !== item.memory_id) await api.deleteMemory(mid);
    }
    markButlerItemApplied(idx, '已合并');
    if (!silent) window.showToast?.('已合并记忆');
    loadMemories(_memFilterCat).catch(() => {});
  } catch(e) { window.showToast?.(e.message); }
};

let _lastButlerMode = 'diagnose';

window.butlerApplyAll = async function() {
  const items = _lastButlerItems
    .map((i, idx) => ({ i, idx }))
    .filter(({ i }) =>
      !i._applied && (
        (i.suggestion === 'add_new' && i.suggested_content) ||
        (i.suggestion === 'delete' && i.memory_id) ||
        (i.suggestion === 'edit' && i.memory_id && i.suggested_content) ||
        (i.suggestion === 'merge' && i.memory_id && i.suggested_content)
      )
    );
  if (!items.length) return;
  if (!confirm(`确定采纳管家的 ${items.length} 条建议？`)) return;
  for (const { i, idx } of items) {
    if (i.suggestion === 'delete') await butlerDeleteMemory(i.memory_id, true, idx);
    else if (i.suggestion === 'add_new') await butlerAddFromItem(idx, true);
    else if (i.suggestion === 'edit') await butlerApplyEdit(idx, true);
    else if (i.suggestion === 'merge') await butlerApplyMerge(idx, true);
  }
  window.showToast?.('已全部采纳。如需再查，请手动点诊断');
};

window.butlerClearAllMemories = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  if (!confirm('确定清空该角色的全部记忆？此操作不可恢复。')) return;
  try {
    await api.clearMemories(charId);
    window.showToast?.('已清空记忆');
    await loadMemories(_memFilterCat);
    await loadBrainExperiences();
    await loadBrainTidy();
    await loadBrainNow();
  } catch(e) { window.showToast?.(e.message); }
};

let _backfillBusy = false;
window.backfillMemoriesFromChat = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId) { window.showToast?.('请先选择角色'); return; }
  if (_backfillBusy) { window.showToast?.('回填进行中，请稍候…'); return; }
  if (!confirm('将按天扫描近 35 天聊天，把值得记住的内容重新写成记忆。\n已有记忆的日子会跳过。\n可能要几分钟并消耗记忆 API，确定开始？')) return;
  _backfillBusy = true;
  const resultEl = document.getElementById('butler-result');
  if (resultEl) {
    resultEl.innerHTML = `<div style="padding:24px 0;text-align:center">
      <div class="loading-spinner" style="margin:0 auto 12px"></div>
      <div style="font-size:14px">正在从聊天记录按天回填记忆…</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:8px">一个月左右可能要几分钟，请不要关页面</div>
    </div>`;
  }
  window.showToast?.('开始回填，请稍候…');
  try {
    const result = await api.backfillChatMemories(charId, { days: 35 });
    window.showToast?.(result.message || `已写入 ${result.saved || 0} 条记忆`);
    if (resultEl) {
      const lines = (result.days || []).slice(-20).map((d) => {
        const tag = d.status === 'saved' ? `+${d.saved}` : d.status;
        return `<div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(d.date)} · ${escapeHtml(String(tag))} · ${d.messages || 0} 条消息</div>`;
      }).join('');
      resultEl.innerHTML = `<div class="memory-card">
        <div class="memory-category" style="color:var(--theme)">从聊天回填</div>
        <div class="memory-content">${escapeHtml(result.message || '')}</div>
        <div style="margin-top:10px">${lines || '<div class="memory-date">没有可处理的日期</div>'}</div>
        ${(result.days || []).length > 20 ? '<div class="memory-date">只显示最近 20 天明细</div>' : ''}
      </div>`;
    }
    await loadMemories(_memFilterCat);
    await loadBrainExperiences();
    await loadBrainTidy();
  } catch (e) {
    window.showToast?.(e.message || '回填失败');
    if (resultEl) {
      resultEl.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '回填失败')}</div></div>`;
    }
  } finally {
    _backfillBusy = false;
  }
};

window.runMemoryButlerClean = function() {
  runMemoryButler('请全面整理记忆库：合并重复、删碎片、修正断章取义，保留有日期上下文的完整表述', 'clean');
};

window.butlerEditMemory = function(id) {
  switchMemTab('memory');
  setTimeout(() => editMemory(id), 200);
};

window.butlerDeleteMemory = async function(id, skipConfirm = false, idx = -1) {
  if (!skipConfirm && !confirm('管家建议删除这条记忆，确定吗？')) return;
  try {
    await api.deleteMemory(id);
    if (idx >= 0) markButlerItemApplied(idx, '已删除');
    else {
      // 无 idx 时按 memory_id 找
      const found = _lastButlerItems.findIndex(i => Number(i.memory_id) === Number(id) && !i._applied);
      if (found >= 0) markButlerItemApplied(found, '已删除');
    }
    if (!skipConfirm) window.showToast?.('已删除');
    loadMemories(_memFilterCat).catch(() => {});
  } catch(e) { window.showToast?.(e.message); }
};

window.butlerAddFromItem = async function(idx, silent = false) {
  const item = _lastButlerItems[idx];
  if (!item?.suggested_content || item._applied) return;
  await butlerAddMemory(item.suggested_content, true);
  markButlerItemApplied(idx, '已添加');
  if (!silent) window.showToast?.('已添加记忆');
};

window.butlerAddMemory = async function(content, stayOnButler = false) {
  const charId = window.getActiveCharId?.();
  if (!charId || !content) return;
  try {
    await api.createMemory({ characterId: charId, category: '重要时刻', content, weight: 0.85 });
    if (!stayOnButler) {
      window.showToast?.('已添加记忆');
      switchMemTab('memory');
    } else {
      loadMemories(_memFilterCat).catch(() => {});
    }
  } catch(e) { window.showToast?.(e.message); }
};

window.runMemoryButler = async function(presetComplaint, mode = 'diagnose') {
  if (_butlerBusy) { window.showToast?.('管家正在分析，请稍候…'); return; }
  const charId = window.getActiveCharId?.();
  if (!charId) { window.showToast?.('请先选择角色'); return; }

  const complaint = typeof presetComplaint === 'string'
    ? presetComplaint
    : (document.getElementById('butler-complaint')?.value?.trim() ?? '');
  _lastButlerMode = mode;
  _butlerBusy = true;
  const resultEl = document.getElementById('butler-result');
  if (resultEl) {
    resultEl.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--text-secondary)">
      <div class="loading-spinner" style="margin:0 auto 12px"></div>
      <div style="font-size:14px">${mode === 'clean' ? '管家正在整理记忆库…' : '管家正在翻阅记忆和最近聊天…'}</div>
    </div>`;
  }

  try {
    const data = await api.auditMemories(charId, { complaint, mode });
    data.mode = mode;
    renderButlerResult(data);
  } catch(e) {
    if (resultEl) {
      resultEl.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '诊断失败')}</div></div>`;
    }
    window.showToast?.(e.message || '诊断失败');
  } finally {
    _butlerBusy = false;
  }
};

/* ═══════════════════════════════════════════
   用户画像 tab
══════════════════════════════════════════════ */
const IMP_CAT_HINTS = ['性格', '情绪', '想法', '喜好', '习惯', '不擅长', '人际关系', '样子', '其他'];
const IMP_CAT_ICON = {
  '性格': '🪞', '情绪': '🌧', '想法': '💭', '喜好': '💝', '习惯': '🔄',
  '不擅长': '🧩', '人际关系': '🤝', '样子': '📷', '其他': '📌',
};
const IMP_CAT_COLORS = {
  '性格': '#c9a0dc', '情绪': '#7eb8da', '想法': '#9b7ec8', '喜好': '#e8788a', '习惯': '#6a9fd4',
  '不擅长': '#a88bc8', '人际关系': '#6db88a', '样子': '#d4a574', '其他': '#8a8a8a',
};
const IMP_TIME_JUNK_RE = /^(清晨|上午|中午|下午|傍晚|晚上|夜里|夜深了|凌晨)$/;
let _brainImpEditId = null;
let _brainImpKnownCats = [...IMP_CAT_HINTS];
let _brainGenImpBusy = false;
let _brainTidyImpBusy = false;
let _allPortraitImps = [];
let _portraitFilterCat = 'all';

function orderImpCats(cats) {
  const set = [...new Set((cats || []).map(c => String(c || '').trim()).filter(Boolean))];
  const preferred = IMP_CAT_HINTS.filter(c => set.includes(c));
  const rest = set.filter(c => !IMP_CAT_HINTS.includes(c)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return [...preferred, ...rest];
}

function isJunkImpContent(s) {
  const t = String(s || '').trim();
  if (t.length < 2) return true;
  if (IMP_TIME_JUNK_RE.test(t)) return true;
  if (/^[\d\s:：\-./点分秒年月日期]+$/.test(t)) return true;
  if (/[？?]$/.test(t)) return true;
  if (/^(聊过|说过|提到|表示|好像在|正在|刚才|我觉得|我认为)/.test(t)) return true;
  if (/(因为|所以|然后|后来|那天|有一次|某天|聊了|讨论了)/.test(t)) return true;
  if (/(今天|昨天|刚才|这周|这天).{2,}/.test(t)) return true;
  if (t.length > 28) return true;
  if (/(爱|会|总|喜欢|经常).{0,6}(抱怨|哭诉|倾诉|找我哭|跟我哭|跟我抱怨|向我诉苦)/.test(t)) return true;
  if (/(情绪垃圾桶|树洞|发泄对象|倾诉对象)/.test(t)) return true;
  if (/[的地得与和是在了着过]$/.test(t) && t.length <= 10) return true;
  return false;
}

function looksLikeImpPersonality(s) {
  const t = String(s || '').replace(/（\?）\s*$/, '').trim();
  if (t.length < 2 || t.length > 24) return false;
  if (/(今天|刚才|因为|然后|后来|某天|加班|考试|生病)/.test(t)) return false;
  return /性格|脾气|气质|内向|外向|敏感|慢热|直爽|玻璃心|感性|理性|傲娇|社恐|冷静|急躁|粘人|独立|倔强|温柔|强势|纠结|内耗|心软|念旧|重感情|别扭|嘴硬|好强|随和|想很多|容易哭|容易急|用户是个|是个比较|外冷内热|嘴硬心软/.test(t);
}

function impCatAccent(cat) {
  return IMP_CAT_COLORS[cat] || 'var(--theme)';
}

function formatImpDisplayText(imp) {
  const unconfirmed = imp.confirmed === 0;
  let text = String(imp.content || '').replace(/（\?）\s*$/, '').trim();
  return { text, unconfirmed };
}

function renderPortraitHero(filtered, charName) {
  const pending = filtered.filter(i => i.confirmed === 0).length;
  return `
    <div class="portrait-mirror">
      <div class="portrait-mirror-glow"></div>
      <div class="portrait-mirror-inner">
        <div class="portrait-mirror-icon">🪞</div>
        <div class="portrait-mirror-title">${escapeHtml(charName)} 怎么看你</div>
        <div class="portrait-mirror-desc">角色视角的一句事实。只留站得住的短句；事件流水、半截话、脑补不进这里。相关联的收一张卡，重复只留一条。</div>
        <div class="portrait-mirror-stats">
          <span class="portrait-mirror-stat"><strong>${filtered.length}</strong> 张卡片</span>
          ${pending ? `<span class="portrait-mirror-dot">·</span><span class="portrait-mirror-stat portrait-mirror-stat--pending"><strong>${pending}</strong> 待确认</span>` : ''}
        </div>
        <div class="portrait-mirror-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="tidyBrainImpression()">🧹 整理</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="autoGenBrainImpression()">✦ 从聊天补充</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="openBrainImpEditor(null)">＋ 添加</button>
        </div>
      </div>
    </div>`;
}

function renderPortraitFilters(cats) {
  const allCats = ['all', ...orderImpCats(cats)];
  return `<div class="portrait-filter-scroll">
    ${allCats.map(cat => {
      if (cat === 'all') {
        return `<button type="button" class="portrait-filter${_portraitFilterCat === 'all' ? ' active' : ''}" onclick="filterPortraitCat('all',this)">全部</button>`;
      }
      return `<button type="button" class="portrait-filter${_portraitFilterCat === cat ? ' active' : ''}" onclick="filterPortraitCat('${escapeHtml(cat)}',this)">
        <span class="portrait-filter-icon">${IMP_CAT_ICON[cat] || '📌'}</span>${escapeHtml(cat)}
      </button>`;
    }).join('')}
  </div>`;
}

function renderPortraitStickerGrid(imps) {
  const list = _portraitFilterCat === 'all'
    ? imps
    : imps.filter(i => (String(i.category || '性格').trim() || '性格') === _portraitFilterCat);
  if (!list.length) {
    return `<div class="empty-state" style="padding:20px 0"><div class="empty-text">${_portraitFilterCat === 'all' ? '还没有怎么看你的句子' : '这个分类还没有条目'}</div></div>`;
  }
  return `<div class="portrait-sticker-grid" id="portrait-sticker-grid">${list.map(imp => {
    const cat = String(imp.category || '性格').trim() || '性格';
    const facts = Array.isArray(imp.facts) && imp.facts.length
      ? imp.facts
      : [String(imp.content || '').replace(/（\?）\s*$/, '').trim()].filter(Boolean);
    const unconfirmed = imp.confirmed === 0;
    const note = String(imp.note || '').trim();
    const accent = impCatAccent(cat);
    return `<div class="portrait-sticker${unconfirmed ? ' portrait-sticker--guess' : ''}" style="--sticker-accent:${accent}" onclick="openBrainImpEditor(${imp.id})">
      <div class="portrait-sticker-cat"><span>${IMP_CAT_ICON[cat] || '📌'}</span> ${escapeHtml(cat)}</div>
      <div class="portrait-sticker-facts">${facts.map(t => `<div class="portrait-sticker-text">${escapeHtml(String(t).replace(/（\?）\s*$/, ''))}</div>`).join('')}</div>
      ${note ? `<div class="portrait-sticker-note"><span>TA</span>${escapeHtml(note)}</div>` : ''}
      ${unconfirmed ? `<div class="portrait-sticker-foot">
        <span class="portrait-sticker-badge">推测</span>
        <button type="button" class="portrait-sticker-confirm" onclick="event.stopPropagation();confirmBrainImpression(${imp.id})">确认</button>
      </div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

async function loadBrainPortrait() {
  const charId = window.getActiveCharId?.();
  const box = document.getElementById('brain-portrait-list');
  if (!box) return;
  if (!charId) {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  box.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const imps = await api.getImpressions(charId);
    _allPortraitImps = Array.isArray(imps) ? imps : [];
    _portraitFilterCat = 'all';
    box.innerHTML = renderBrainPortraitHtml(_allPortraitImps);
  } catch {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
  }
}

function renderBrainPortraitHtml(imps) {
  const c = getActiveChar();
  const charName = charDisplayName(c);
  const filtered = imps || [];
  if (!filtered.length) {
    return `
      ${renderPortraitHero([], charName)}
      <div class="portrait-empty">
        <div class="portrait-empty-icon">✨</div>
        <div class="empty-text">还没有怎么看你的句子<br><span style="font-size:12px;color:var(--text-secondary)">聊几句或消化今天后会慢慢长出来；也可手动添加</span></div>
      </div>`;
  }
  const cats = orderImpCats(filtered.map(i => String(i.category || '性格').trim() || '性格'));
  _brainImpKnownCats = orderImpCats([...IMP_CAT_HINTS, ...cats]);
  return renderPortraitHero(filtered, charName)
    + renderPortraitFilters(cats)
    + renderPortraitStickerGrid(filtered);
}

window.filterPortraitCat = function(cat, el) {
  _portraitFilterCat = cat;
  document.querySelectorAll('#mem-panel-portrait .portrait-filter').forEach(b => b.classList.remove('active'));
  el?.classList.add('active');
  const grid = document.getElementById('portrait-sticker-grid');
  if (grid) {
    grid.outerHTML = renderPortraitStickerGrid(_allPortraitImps);
  } else {
    const box = document.getElementById('brain-portrait-list');
    if (box) box.innerHTML = renderBrainPortraitHtml(_allPortraitImps);
  }
};

function renderBrainImpCatChips(activeCat = '喜好') {
  const box = document.getElementById('brain-imp-cats');
  if (!box) return;
  const cats = orderImpCats([...IMP_CAT_HINTS, ..._brainImpKnownCats, activeCat]);
  box.innerHTML = cats.map(c =>
    `<button type="button" class="brain-cat-pill${c === activeCat ? ' active' : ''}" data-imp-pick="${escapeHtml(c)}" onclick="selectBrainImpCat(this)">${escapeHtml(c)}</button>`
  ).join('');
}

window.openBrainImpEditor = async function(id) {
  _brainImpEditId = id;
  document.getElementById('brain-imp-modal-title').textContent = id ? '编辑怎么看' : '添加怎么看';
  document.getElementById('brain-imp-content').value = '';
  document.getElementById('brain-imp-keywords').value = '';
  document.getElementById('brain-imp-note').value = '';
  document.getElementById('brain-imp-confirmed').checked = true;
  document.getElementById('brain-imp-del-btn').style.display = id ? '' : 'none';
  let activeCat = '喜好';
  const charId = window.getActiveCharId?.();
  if (id && charId) {
    try {
      const imps = await api.getImpressions(charId);
      const imp = imps.find(x => x.id === id);
      if (imp) {
        document.getElementById('brain-imp-content').value = (Array.isArray(imp.facts) && imp.facts.length
          ? imp.facts
          : [String(imp.content || '')]).map(t => String(t).replace(/（\?）\s*$/, '')).join('\n');
        activeCat = imp.category || '性格';
        document.getElementById('brain-imp-note').value = imp.note || '';
        const kws = (() => { try { return JSON.parse(imp.keywords || '[]'); } catch { return []; } })();
        document.getElementById('brain-imp-keywords').value = kws.join(', ');
        document.getElementById('brain-imp-confirmed').checked = imp.confirmed !== 0;
      }
    } catch {}
  }
  document.getElementById('brain-imp-category').value = activeCat;
  renderBrainImpCatChips(activeCat);
  document.getElementById('brain-imp-edit-overlay').classList.add('active');
};

window.selectBrainImpCat = function(el) {
  const cat = el?.dataset?.impPick || el?.textContent?.trim() || '性格';
  document.querySelectorAll('#brain-imp-cats .brain-cat-pill').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('brain-imp-category').value = cat;
};

window.onBrainImpCatInput = function(val) {
  const cat = String(val || '').trim() || '性格';
  document.querySelectorAll('#brain-imp-cats .brain-cat-pill').forEach(t => {
    t.classList.toggle('active', t.textContent === cat);
  });
};

window.saveBrainImpEntry = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  const content = document.getElementById('brain-imp-content')?.value?.trim();
  const category = (document.getElementById('brain-imp-category')?.value || '性格').trim().slice(0, 12) || '性格';
  const note = (document.getElementById('brain-imp-note')?.value || '').trim().slice(0, 36);
  const kwRaw = document.getElementById('brain-imp-keywords')?.value?.trim() || '';
  const keywords = kwRaw ? kwRaw.split(/[，,、\s]+/).map(k => k.trim()).filter(Boolean) : [];
  const confirmed = !!document.getElementById('brain-imp-confirmed')?.checked;
  if (!content) { window.showToast?.('请填写一句事实'); return; }
  if (isJunkImpContent(content)) { window.showToast?.('这不像角色视角的一句事实'); return; }
  try {
    if (_brainImpEditId) {
      await api.updateImpression(_brainImpEditId, { content, category, subcategory: '', note, keywords, confirmed: confirmed ? 1 : 0 });
    } else {
      await api.createImpression({ characterId: charId, content, category, subcategory: '', note, keywords, confirmed: confirmed ? 1 : 0 });
    }
    document.getElementById('brain-imp-edit-overlay').classList.remove('active');
    window.showToast?.('已保存');
    await loadBrainPortrait();
  } catch (e) { window.showToast?.(e.message || '保存失败'); }
};

window.deleteBrainImpCurrent = async function() {
  if (!_brainImpEditId || !confirm('删除这条印象？')) return;
  try {
    await api.deleteImpression(_brainImpEditId);
    document.getElementById('brain-imp-edit-overlay').classList.remove('active');
    await loadBrainPortrait();
  } catch (e) { window.showToast?.(e.message || '删除失败'); }
};

window.confirmBrainImpression = async function(id) {
  try {
    await api.updateImpression(id, { confirmed: 1 });
    window.showToast?.('已确认');
    await loadBrainPortrait();
  } catch (e) { window.showToast?.(e.message || '确认失败'); }
};

window.autoGenBrainImpression = async function() {
  if (_brainGenImpBusy) return;
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  _brainGenImpBusy = true;
  window.showToast?.('TA 正在从聊天补充…');
  try {
    const result = await api.generateImpressions(charId);
    window.showToast?.(result?.merged ? `补充了 ${result.merged} 张卡片 ✨` : '没有新的印象');
    await loadBrainPortrait();
  } catch (e) {
    window.showToast?.(e.message || '生成失败');
  } finally {
    _brainGenImpBusy = false;
  }
};

window.tidyBrainImpression = async function() {
  if (_brainTidyImpBusy) return;
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  if (!(_allPortraitImps || []).length) {
    window.showToast?.('还没有画像可整理');
    return;
  }
  _brainTidyImpBusy = true;
  window.showToast?.('正在整理画像…');
  try {
    const result = await api.tidyImpressions(charId);
    const before = Number(result?.before) || 0;
    const after = Number(result?.after) || 0;
    const tip = result?.summary
      || (before !== after ? `整理完成：${before} → ${after} 张` : '已整理，卡片数未变');
    window.showToast?.(tip);
    await loadBrainPortrait();
  } catch (e) {
    window.showToast?.(e.message || '整理失败');
  } finally {
    _brainTidyImpBusy = false;
  }
};

/* ═══════════════════════════════════════════
   自我认知 tab（角色怎么看自己）
══════════════════════════════════════════════ */
const SELF_CAT_HINTS = ['性格', '行为习惯', '喜好', '经历', '变化'];
const SELF_CAT_ICON = { '性格': '🪞', '行为习惯': '🌙', '喜好': '🤍', '经历': '🌱', '变化': '🫧' };
const SELF_CAT_COLORS = { '性格': '#c9a0dc', '行为习惯': '#7eb8da', '喜好': '#e8788a', '经历': '#8fbf88', '变化': '#9b7ec8' };
let _brainSelfEditId = null;
let _brainGenSelfBusy = false;
let _brainTidySelfBusy = false;
let _allSelfViews = [];
let _selfFilterCat = 'all';

function orderSelfCats(cats) {
  const set = [...new Set((cats || []).map(c => String(c || '').trim()).filter(Boolean))];
  const preferred = SELF_CAT_HINTS.filter(c => set.includes(c));
  const rest = set.filter(c => !SELF_CAT_HINTS.includes(c)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return [...preferred, ...rest];
}

function renderSelfHero(filtered, charName) {
  const lived = filtered.filter(i => i.source === 'lived' || i.source === 'manual').length;
  return `
    <div class="portrait-mirror portrait-mirror--self">
      <div class="portrait-mirror-glow"></div>
      <div class="portrait-mirror-inner">
        <div class="portrait-mirror-icon">💭</div>
        <div class="portrait-mirror-title">${escapeHtml(charName)} 眼中的自己</div>
        <div class="portrait-mirror-desc">第一人称记自己。意思重复的只留一条。角色本名写成 TA，提到你只用一种昵称。点「整理」可合并重复、修好断句。</div>
        <div class="portrait-mirror-stats">
          <span class="portrait-mirror-stat"><strong>${filtered.length}</strong> 张卡片</span>
          ${lived ? `<span class="portrait-mirror-dot">·</span><span class="portrait-mirror-stat"><strong>${lived}</strong> 从相处长出</span>` : ''}
        </div>
        <div class="portrait-mirror-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="tidyBrainSelf()">🧹 整理</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="autoGenBrainSelf()">✦ 从角色卡补充</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="openBrainSelfEditor(null)">＋ 添加</button>
        </div>
      </div>
    </div>`;
}

function renderSelfFilters(cats) {
  const allCats = ['all', ...orderSelfCats(cats)];
  return `<div class="portrait-filter-scroll">
    ${allCats.map(cat => {
      if (cat === 'all') {
        return `<button type="button" class="portrait-filter self-filter${_selfFilterCat === 'all' ? ' active' : ''}" onclick="filterSelfCat('all',this)">全部</button>`;
      }
      return `<button type="button" class="portrait-filter self-filter${_selfFilterCat === cat ? ' active' : ''}" onclick="filterSelfCat('${escapeHtml(cat)}',this)">
        <span class="portrait-filter-icon">${SELF_CAT_ICON[cat] || '📌'}</span>${escapeHtml(cat)}
      </button>`;
    }).join('')}
  </div>`;
}

function renderSelfStickerGrid(rows) {
  const list = _selfFilterCat === 'all'
    ? rows
    : rows.filter(i => (String(i.category || '行为习惯').trim() || '行为习惯') === _selfFilterCat);
  if (!list.length) {
    return `<div class="empty-state" style="padding:20px 0"><div class="empty-text">${_selfFilterCat === 'all' ? '还没有自我认知' : '这个分类还没有条目'}</div></div>`;
  }
  return `<div class="portrait-sticker-grid" id="self-sticker-grid">${list.map(row => {
    const cat = String(row.category || '行为习惯').trim() || '行为习惯';
    const facts = Array.isArray(row.facts) && row.facts.length
      ? row.facts
      : [String(row.content || '').replace(/（\?）\s*$/, '').trim()].filter(Boolean);
    const unconfirmed = row.confirmed === false || row.confirmed === 0;
    const source = row.source === 'card' ? '角色卡' : (row.source === 'manual' ? '手写' : '相处');
    const note = String(row.note || '').trim();
    const accent = SELF_CAT_COLORS[cat] || 'var(--theme)';
    return `<div class="portrait-sticker${unconfirmed ? ' portrait-sticker--guess' : ''}" style="--sticker-accent:${accent}" onclick="openBrainSelfEditor(${row.id})">
      <div class="portrait-sticker-cat"><span>${SELF_CAT_ICON[cat] || '📌'}</span> ${escapeHtml(cat)}</div>
      <div class="portrait-sticker-facts">${facts.map(t => `<div class="portrait-sticker-text">${escapeHtml(String(t).replace(/（\?）\s*$/, ''))}</div>`).join('')}</div>
      ${note ? `<div class="portrait-sticker-note"><span>TA</span>${escapeHtml(note)}</div>` : ''}
      <div class="portrait-sticker-foot">
        <span class="portrait-sticker-badge${row.source === 'lived' ? ' portrait-sticker-badge--lived' : ''}">${escapeHtml(source)}</span>
        ${unconfirmed ? `<button type="button" class="portrait-sticker-confirm" onclick="event.stopPropagation();confirmBrainSelf(${row.id})">确认</button>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderBrainSelfHtml(rows) {
  const c = getActiveChar();
  const charName = charDisplayName(c);
  const filtered = rows || [];
  if (!filtered.length) {
    return `
      ${renderSelfHero([], charName)}
      <div class="portrait-empty">
        <div class="portrait-empty-icon">💭</div>
        <div class="empty-text">还没有自我认知<br><span style="font-size:12px;color:var(--text-secondary)">点「从角色卡补充」发芽；新习惯要反复出现才会慢慢长出来</span></div>
      </div>`;
  }
  const cats = orderSelfCats(filtered.map(i => String(i.category || '行为习惯').trim() || '行为习惯'));
  return renderSelfHero(filtered, charName)
    + renderSelfFilters(cats)
    + renderSelfStickerGrid(filtered);
}

async function loadBrainSelf() {
  const charId = window.getActiveCharId?.();
  const box = document.getElementById('brain-self-list');
  if (!box) return;
  if (!charId) {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  box.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const rows = await api.getSelfViews(charId);
    _allSelfViews = Array.isArray(rows) ? rows : [];
    _selfFilterCat = 'all';
    box.innerHTML = renderBrainSelfHtml(_allSelfViews);
  } catch {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
  }
}

window.filterSelfCat = function(cat, el) {
  _selfFilterCat = cat;
  document.querySelectorAll('.self-filter').forEach(b => b.classList.remove('active'));
  el?.classList.add('active');
  const grid = document.getElementById('self-sticker-grid');
  if (grid) grid.outerHTML = renderSelfStickerGrid(_allSelfViews);
  else {
    const box = document.getElementById('brain-self-list');
    if (box) box.innerHTML = renderBrainSelfHtml(_allSelfViews);
  }
};

function renderBrainSelfCatChips(activeCat = '行为习惯') {
  const box = document.getElementById('brain-self-cats');
  if (!box) return;
  box.innerHTML = SELF_CAT_HINTS.map(c =>
    `<button type="button" class="brain-cat-pill${c === activeCat ? ' active' : ''}" data-self-pick="${escapeHtml(c)}" onclick="selectBrainSelfCat(this)">${escapeHtml(c)}</button>`
  ).join('');
}

window.openBrainSelfEditor = async function(id) {
  _brainSelfEditId = id;
  document.getElementById('brain-self-modal-title').textContent = id ? '编辑自我认知' : '添加自我认知';
  document.getElementById('brain-self-content').value = '';
  document.getElementById('brain-self-keywords').value = '';
  const noteEl = document.getElementById('brain-self-note');
  if (noteEl) noteEl.value = '';
  document.getElementById('brain-self-confirmed').checked = true;
  document.getElementById('brain-self-del-btn').style.display = id ? '' : 'none';
  let activeCat = '行为习惯';
  const charId = window.getActiveCharId?.();
  if (id && charId) {
    const row = (_allSelfViews || []).find(x => x.id === id);
    if (row) {
      document.getElementById('brain-self-content').value = (Array.isArray(row.facts) && row.facts.length
        ? row.facts
        : [String(row.content || '')]).map(t => String(t).replace(/（\?）\s*$/, '')).join('\n');
      activeCat = row.category || '行为习惯';
      if (noteEl) noteEl.value = row.note || '';
      const kws = Array.isArray(row.keywords) ? row.keywords : [];
      document.getElementById('brain-self-keywords').value = kws.join(', ');
      document.getElementById('brain-self-confirmed').checked = row.confirmed !== false && row.confirmed !== 0;
    }
  }
  document.getElementById('brain-self-category').value = activeCat;
  renderBrainSelfCatChips(activeCat);
  document.getElementById('brain-self-edit-overlay').classList.add('active');
};

window.selectBrainSelfCat = function(el) {
  const cat = el?.dataset?.selfPick || el?.textContent?.trim() || '行为习惯';
  document.querySelectorAll('#brain-self-cats .brain-cat-pill').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('brain-self-category').value = cat;
};

window.onBrainSelfCatInput = function(val) {
  const cat = String(val || '').trim() || '行为习惯';
  document.querySelectorAll('#brain-self-cats .brain-cat-pill').forEach(t => {
    t.classList.toggle('active', t.textContent === cat);
  });
};

window.saveBrainSelfEntry = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  const content = document.getElementById('brain-self-content')?.value?.trim();
  const category = (document.getElementById('brain-self-category')?.value || '行为习惯').trim().slice(0, 12) || '行为习惯';
  const note = (document.getElementById('brain-self-note')?.value || '').trim().slice(0, 36);
  const kwRaw = document.getElementById('brain-self-keywords')?.value?.trim() || '';
  const keywords = kwRaw ? kwRaw.split(/[，,、\s]+/).map(k => k.trim()).filter(Boolean) : [];
  const confirmed = !!document.getElementById('brain-self-confirmed')?.checked;
  if (!content) { window.showToast?.('请填写内容'); return; }
  try {
    if (_brainSelfEditId) {
      await api.updateSelfView(_brainSelfEditId, { content, category, subcategory: '', note, keywords, confirmed: confirmed ? 1 : 0 });
    } else {
      await api.createSelfView({ characterId: charId, content, category, subcategory: '', note, keywords, confirmed: confirmed ? 1 : 0, source: 'manual' });
    }
    document.getElementById('brain-self-edit-overlay').classList.remove('active');
    window.showToast?.('已保存');
    await loadBrainSelf();
  } catch (e) { window.showToast?.(e.message || '保存失败'); }
};

window.deleteBrainSelfCurrent = async function() {
  if (!_brainSelfEditId || !confirm('删除这条自我认知？')) return;
  try {
    await api.deleteSelfView(_brainSelfEditId);
    document.getElementById('brain-self-edit-overlay').classList.remove('active');
    await loadBrainSelf();
  } catch (e) { window.showToast?.(e.message || '删除失败'); }
};

window.confirmBrainSelf = async function(id) {
  try {
    await api.updateSelfView(id, { confirmed: 1 });
    window.showToast?.('已确认');
    await loadBrainSelf();
  } catch (e) { window.showToast?.(e.message || '确认失败'); }
};

window.autoGenBrainSelf = async function() {
  if (_brainGenSelfBusy) return;
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  _brainGenSelfBusy = true;
  window.showToast?.('正在从角色卡和相处里补充…');
  try {
    const result = await api.generateSelfViews(charId);
    const n = Number(result?.merged) || 0;
    window.showToast?.(n ? `补充了 ${n} 条` : '这次没有新条目');
    await loadBrainSelf();
  } catch (e) {
    window.showToast?.(e.message || '补充失败');
  } finally {
    _brainGenSelfBusy = false;
  }
};

window.tidyBrainSelf = async function() {
  if (_brainTidySelfBusy) return;
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  if (!(_allSelfViews || []).length) {
    window.showToast?.('还没有自我认知可整理');
    return;
  }
  _brainTidySelfBusy = true;
  window.showToast?.('正在整理自我认知…');
  try {
    const result = await api.tidySelfViews(charId);
    const before = Number(result?.before) || 0;
    const after = Number(result?.after) || 0;
    const tip = result?.summary
      || (before !== after ? `整理完成：${before} → ${after} 张` : '已整理，卡片数未变');
    window.showToast?.(tip);
    await loadBrainSelf();
  } catch (e) {
    window.showToast?.(e.message || '整理失败');
  } finally {
    _brainTidySelfBusy = false;
  }
};

/* ═══════════════════════════════════════════
   人生档案 tab（经历 → 一键消化成心智）
══════════════════════════════════════════════ */
const ARCHIVE_STAGE_DEFAULTS = ['童年', '少年', '青年', '成年', '相识前', '相识后', '其他'];
const ARCHIVE_STAGE_ICON = {
  '童年': '🌱', '少年': '🌿', '青年': '🌸', '成年': '🌲',
  '相识前': '🌫️', '相识后': '🔗', '其他': '📌',
};
const ARCHIVE_STAGE_COLORS = {
  '童年': '#8fbf88', '少年': '#7eb8da', '青年': '#e8788a', '成年': '#9b8f7a',
  '相识前': '#9b7ec8', '相识后': '#c9a07a', '其他': '#8a8a8a',
};
let _brainArchiveEditId = null;
let _brainDigestBusy = false;
let _allArchiveEntries = [];
let _archiveStages = ARCHIVE_STAGE_DEFAULTS.slice();
let _archiveMindset = null;
let _archiveFilterStage = 'all';

function orderArchiveStages(stages) {
  const set = [...new Set((stages || []).map(s => String(s || '').trim()).filter(Boolean))];
  const preferred = ARCHIVE_STAGE_DEFAULTS.filter(s => set.includes(s));
  const rest = set.filter(s => !ARCHIVE_STAGE_DEFAULTS.includes(s)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return [...preferred, ...rest];
}

function formatDigestTime(iso) {
  if (!iso) return '';
  const s = String(iso).replace('T', ' ').slice(0, 16);
  return s;
}

function renderArchiveHero(entries, mindset, charName) {
  const digested = !!(mindset?.mindset);
  const when = formatDigestTime(mindset?.digestedAt);
  return `
    <div class="portrait-mirror portrait-mirror--archive">
      <div class="portrait-mirror-glow"></div>
      <div class="portrait-mirror-inner">
        <div class="portrait-mirror-icon">📂</div>
        <div class="portrait-mirror-title">${escapeHtml(charName)} 的人生档案</div>
        <div class="portrait-mirror-desc">按阶段记下经历，再一键消化成心智。性格与行为会随之写回角色卡；聊天时以心智为主。</div>
        <div class="portrait-mirror-stats">
          <span class="portrait-mirror-stat"><strong>${entries.length}</strong> 条经历</span>
          ${digested
            ? `<span class="portrait-mirror-dot">·</span><span class="portrait-mirror-stat">心智已生成${when ? ` · ${escapeHtml(when)}` : ''}</span>`
            : `<span class="portrait-mirror-dot">·</span><span class="portrait-mirror-stat portrait-mirror-stat--pending">尚未消化</span>`}
        </div>
        <div class="portrait-mirror-actions">
          <button type="button" class="btn btn-primary btn-sm" onclick="digestBrainArchive()" ${entries.length ? '' : 'disabled'}>✦ 一键消化</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="openBrainArchiveEditor(null)">＋ 添加经历</button>
        </div>
      </div>
    </div>`;
}

function renderArchiveMindsetCard(mindset) {
  const text = String(mindset?.mindset || '').trim();
  if (!text) return '';
  const personality = String(mindset?.personality || '').trim();
  const behavior = String(mindset?.behavior || '').trim();
  return `
    <div class="archive-mindset-card">
      <div class="archive-mindset-label">心智</div>
      <div class="archive-mindset-body">${escapeHtml(text)}</div>
      ${personality ? `<div class="archive-mindset-sub"><span>性格</span>${escapeHtml(personality)}</div>` : ''}
      ${behavior ? `<div class="archive-mindset-sub"><span>行为</span>${escapeHtml(behavior)}</div>` : ''}
    </div>`;
}

function renderArchiveFilters(stages) {
  const all = ['all', ...orderArchiveStages(stages)];
  return `<div class="portrait-filter-scroll">
    ${all.map(stage => {
      if (stage === 'all') {
        return `<button type="button" class="portrait-filter archive-filter${_archiveFilterStage === 'all' ? ' active' : ''}" onclick="filterArchiveStage('all',this)">全部</button>`;
      }
      return `<button type="button" class="portrait-filter archive-filter${_archiveFilterStage === stage ? ' active' : ''}" onclick="filterArchiveStage('${escapeHtml(stage)}',this)">
        <span class="portrait-filter-icon">${ARCHIVE_STAGE_ICON[stage] || '📌'}</span>${escapeHtml(stage)}
      </button>`;
    }).join('')}
  </div>`;
}

function renderArchiveEntryGrid(rows) {
  const list = _archiveFilterStage === 'all'
    ? rows
    : rows.filter(e => (String(e.stage || '其他').trim() || '其他') === _archiveFilterStage);
  if (!list.length) {
    return `<div class="empty-state" style="padding:20px 0"><div class="empty-text">${_archiveFilterStage === 'all' ? '还没有经历' : '这个阶段还没有条目'}</div></div>`;
  }
  return `<div class="portrait-sticker-grid" id="archive-entry-grid">${list.map(row => {
    const stage = String(row.stage || '其他').trim() || '其他';
    const accent = ARCHIVE_STAGE_COLORS[stage] || 'var(--theme)';
    const title = String(row.title || '').trim();
    const content = String(row.content || '').trim();
    return `<div class="portrait-sticker" style="--sticker-accent:${accent}" onclick="openBrainArchiveEditor(${row.id})">
      <div class="portrait-sticker-cat"><span>${ARCHIVE_STAGE_ICON[stage] || '📌'}</span> ${escapeHtml(stage)}</div>
      ${title ? `<div class="archive-entry-title">${escapeHtml(title)}</div>` : ''}
      <div class="portrait-sticker-facts"><div class="portrait-sticker-text">${escapeHtml(content)}</div></div>
    </div>`;
  }).join('')}</div>`;
}

function renderBrainArchiveHtml(entries, mindset) {
  const c = getActiveChar();
  const charName = charDisplayName(c);
  const list = entries || [];
  if (!list.length) {
    return `
      ${renderArchiveHero([], mindset, charName)}
      <div class="portrait-empty">
        <div class="portrait-empty-icon">📂</div>
        <div class="empty-text">还没有人生档案<br><span style="font-size:12px;color:var(--text-secondary)">选一个阶段，记下经历；攒够后点「一键消化」生成心智</span></div>
      </div>`;
  }
  const stages = orderArchiveStages(list.map(e => String(e.stage || '其他').trim() || '其他'));
  return renderArchiveHero(list, mindset, charName)
    + renderArchiveMindsetCard(mindset)
    + renderArchiveFilters(stages)
    + renderArchiveEntryGrid(list);
}

async function loadBrainArchive() {
  const charId = window.getActiveCharId?.();
  const box = document.getElementById('brain-archive-list');
  if (!box) return;
  if (!charId) {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  box.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  _archiveFilterStage = 'all';
  try {
    const data = await api.getArchive(charId);
    _allArchiveEntries = data?.entries || [];
    _archiveStages = (data?.stages?.length ? data.stages : ARCHIVE_STAGE_DEFAULTS).slice();
    _archiveMindset = data?.mindset || null;
    box.innerHTML = renderBrainArchiveHtml(_allArchiveEntries, _archiveMindset);
  } catch {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
  }
}

window.filterArchiveStage = function(stage, el) {
  _archiveFilterStage = stage;
  document.querySelectorAll('.archive-filter').forEach(b => b.classList.remove('active'));
  el?.classList.add('active');
  const grid = document.getElementById('archive-entry-grid');
  if (grid) grid.outerHTML = renderArchiveEntryGrid(_allArchiveEntries);
  else {
    const box = document.getElementById('brain-archive-list');
    if (box) box.innerHTML = renderBrainArchiveHtml(_allArchiveEntries, _archiveMindset);
  }
};

function renderBrainArchiveStageChips(activeStage = '童年') {
  const box = document.getElementById('brain-archive-stages');
  if (!box) return;
  const stages = _archiveStages.length ? _archiveStages : ARCHIVE_STAGE_DEFAULTS;
  box.innerHTML = stages.map(s =>
    `<button type="button" class="brain-cat-pill${s === activeStage ? ' active' : ''}" data-archive-stage="${escapeHtml(s)}" onclick="selectBrainArchiveStage(this)">${escapeHtml(s)}</button>`
  ).join('');
}

window.openBrainArchiveEditor = function(id) {
  _brainArchiveEditId = id;
  document.getElementById('brain-archive-modal-title').textContent = id ? '编辑经历' : '添加经历';
  document.getElementById('brain-archive-title').value = '';
  document.getElementById('brain-archive-content').value = '';
  document.getElementById('brain-archive-del-btn').style.display = id ? '' : 'none';
  let activeStage = '童年';
  if (id) {
    const row = (_allArchiveEntries || []).find(x => x.id === id);
    if (row) {
      activeStage = row.stage || '童年';
      document.getElementById('brain-archive-title').value = row.title || '';
      document.getElementById('brain-archive-content').value = row.content || '';
    }
  }
  document.getElementById('brain-archive-stage').value = activeStage;
  renderBrainArchiveStageChips(activeStage);
  document.getElementById('brain-archive-edit-overlay').classList.add('active');
};

window.selectBrainArchiveStage = function(el) {
  const stage = el?.dataset?.archiveStage || el?.textContent?.trim() || '其他';
  document.querySelectorAll('#brain-archive-stages .brain-cat-pill').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('brain-archive-stage').value = stage;
};

window.onBrainArchiveStageInput = function(val) {
  const stage = String(val || '').trim() || '其他';
  document.querySelectorAll('#brain-archive-stages .brain-cat-pill').forEach(t => {
    t.classList.toggle('active', t.textContent === stage);
  });
};

window.saveBrainArchiveEntry = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  const stage = (document.getElementById('brain-archive-stage')?.value || '其他').trim().slice(0, 12) || '其他';
  const title = (document.getElementById('brain-archive-title')?.value || '').trim().slice(0, 40);
  const content = document.getElementById('brain-archive-content')?.value?.trim();
  if (!content) { window.showToast?.('请填写经历'); return; }
  try {
    if (_brainArchiveEditId) {
      await api.updateArchiveEntry(_brainArchiveEditId, { stage, title, content });
    } else {
      await api.createArchiveEntry({ characterId: charId, stage, title, content });
    }
    document.getElementById('brain-archive-edit-overlay').classList.remove('active');
    window.showToast?.('已保存');
    await loadBrainArchive();
  } catch (e) { window.showToast?.(e.message || '保存失败'); }
};

window.deleteBrainArchiveCurrent = async function() {
  if (!_brainArchiveEditId || !confirm('删除这条经历？')) return;
  try {
    await api.deleteArchiveEntry(_brainArchiveEditId);
    document.getElementById('brain-archive-edit-overlay').classList.remove('active');
    await loadBrainArchive();
  } catch (e) { window.showToast?.(e.message || '删除失败'); }
};

window.digestBrainArchive = async function() {
  if (_brainDigestBusy) return;
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  if (!(_allArchiveEntries || []).length) {
    window.showToast?.('请先添加至少一条经历');
    return;
  }
  if (_archiveMindset?.mindset && !confirm('将重新消化档案，并覆盖角色编辑里的性格与行为。继续？')) {
    return;
  }
  _brainDigestBusy = true;
  window.showToast?.('正在消化档案、生成心智…');
  try {
    const result = await api.digestArchive(charId);
    window.showToast?.(result?.mindset ? '心智已生成，性格与行为已写回' : '消化完成');
    try { await window.refreshAppData?.(); } catch { /* ignore */ }
    await loadBrainArchive();
  } catch (e) {
    window.showToast?.(e.message || '消化失败');
  } finally {
    _brainDigestBusy = false;
  }
};

/* ═══════════════════════════════════════════
   日子：消化后的记忆（不是日程原文）
══════════════════════════════════════════════ */
let _livedView = 'today';
let _livedData = null;
let _livedPastDate = '';
let _livedPastDay = null;
let _livedDigestBusy = false;
let _editingLivedMem = false;

function collectLivedMemories() {
  const rows = [];
  if (_livedData?.todayMemories?.length) rows.push(..._livedData.todayMemories);
  if (_livedPastDay?.memories?.length) rows.push(..._livedPastDay.memories);
  return rows;
}

function findLivedMemory(id) {
  const nid = Number(id);
  return collectLivedMemories().find((m) => Number(m.id) === nid) || null;
}

function ensureMemCategoryOption(cat) {
  const sel = document.getElementById('mem-category');
  if (!sel || !cat) return;
  const exists = [...sel.options].some((o) => o.value === cat);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    sel.appendChild(opt);
  }
  sel.value = cat;
}

function renderMemoryCards(rows, emptyText) {
  if (!rows?.length) {
    return `<div class="empty-state" style="padding:20px 0"><div class="empty-text">${emptyText}</div></div>`;
  }
  return rows.map((m) => {
    const label = m.source === 'day_story' ? '整天事记'
      : m.source === 'day_digest' ? (m.category || '有用讯息')
      : m.source === 'life' ? '自己的生活'
      : (m.category || '和你');
    const id = Number(m.id) || 0;
    const actions = id
      ? `<div class="brain-card-actions" style="display:flex;gap:4px;margin-left:auto">
          <button type="button" class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:13px" title="编辑" onclick="event.stopPropagation();editLivedMemory(${id})">✎</button>
          <button type="button" class="btn btn-danger btn-sm" style="padding:4px 8px;font-size:13px" title="删除" onclick="event.stopPropagation();deleteLivedMemory(${id})">🗑</button>
        </div>`
      : '';
    return `
    <div class="brain-card" data-mem-id="${id || ''}">
      <div class="brain-card-head">
        <span class="brain-card-label">${escapeHtml(label)}</span>
        ${m.date ? `<span class="brain-card-meta">${escapeHtml(m.date)}</span>` : ''}
        ${actions}
      </div>
      <div class="brain-card-body">${escapeHtml(m.content || '')}</div>
    </div>`;
  }).join('');
}

function renderLivedCarry(carry) {
  const c = carry || {};
  const unfinished = Array.isArray(c.unfinished) ? c.unfinished : [];
  if (!c.seeUser && !c.seeSelf && !unfinished.length) {
    return `<div class="empty-state" style="padding:20px 0"><div class="empty-text">还没有留下的看法<br><span style="font-size:12px;color:var(--text-secondary)">一天过完消化后才会写进这里</span></div></div>`;
  }
  return `
    <div class="brain-card"><div class="brain-card-label">我怎么看你</div><div class="brain-card-body">${escapeHtml(c.seeUser || '还没有')}</div></div>
    <div class="brain-card"><div class="brain-card-label">我怎么看自己</div><div class="brain-card-body">${escapeHtml(c.seeSelf || '还没有')}</div></div>
    <div class="brain-card"><div class="brain-card-label">还没过去的事</div><div class="brain-card-body">${unfinished.length ? unfinished.map((t) => escapeHtml(t)).join('<br>') : '没有'}</div></div>`;
}

function renderCognition(cog) {
  const user = cog?.user || [];
  const self = cog?.self || [];
  if (!user.length && !self.length) {
    return `<div class="empty-state" style="padding:20px 0"><div class="empty-text">还没有从日子里长出来的认识<br><span style="font-size:12px;color:var(--text-secondary)">夜里消化后会进这里</span></div></div>`;
  }
  const block = (title, rows) => {
    if (!rows.length) return '';
    return `<div class="brain-card-meta" style="margin:8px 0">${title}</div>` + rows.map((r) => `
      <div class="brain-card">
        <div class="brain-card-label">${escapeHtml(r.category || '')}</div>
        <div class="brain-card-body">${escapeHtml(r.content || '')}</div>
      </div>`).join('');
  };
  return block('对你', user) + block('对自己', self);
}

function renderLivedPastList(past) {
  if (!past?.length) {
    return `<div class="empty-state" style="padding:20px 0"><div class="empty-text">还没有以前消化过的日子</div></div>`;
  }
  return past.map((d) => `
    <button type="button" class="brain-card" style="width:100%;text-align:left" onclick="openLivedPast('${escapeHtml(d.date)}')">
      <div class="brain-card-head">
        <span class="brain-card-label">${escapeHtml(d.date)}</span>
        <span class="brain-card-meta">${d.total || ((d.life || 0) + (d.chat || 0))} 条记下了</span>
      </div>
    </button>`).join('');
}

function renderLivedMemory() {
  const data = _livedData || {};
  if (_livedView === 'carry' || _livedView === 'see') _livedView = 'today';
  const pills = [
    ['today', '今天'],
    ['past', '以前'],
  ].map(([id, label]) =>
    `<button type="button" class="brain-cat-pill ${_livedView === id ? 'active' : ''}" onclick="switchLivedView('${id}')">${label}</button>`
  ).join('');
  let body = '';
  if (_livedView === 'past' || _livedPastDate) {
    if (_livedPastDate) {
      const day = _livedPastDay || {};
      body = `<button type="button" class="btn btn-ghost btn-sm" onclick="closeLivedPast()">返回</button>
        <div class="brain-card-meta" style="margin:8px 0">${escapeHtml(_livedPastDate)}</div>
        ${renderMemoryCards(day.memories || [], '这天还没有消化进人格的记忆')}`;
    } else {
      body = renderLivedPastList(data.past);
    }
  } else {
    body = `<div class="brain-action-full" style="margin-bottom:10px">
      <button type="button" class="btn btn-primary btn-sm" onclick="digestLivedToday()">消化今天</button>
    </div>
    <p class="brain-frag-hint" style="margin:0 0 8px">把今天的聊天碎片按时间收成整天事记，去掉闲聊留下有用讯息，并更新画像里的「怎么看」。</p>
    ${renderMemoryCards(data.todayMemories, '今天还没有消化进人格的记忆')}`;
  }
  return `${renderExpSurfacePills()}<div class="brain-kind-pills">${pills}</div>${body}`;
}

async function loadLivedMemory() {
  const charId = window.getActiveCharId?.();
  const box = document.getElementById('brain-exp-list');
  if (!box) return;
  _expSurface = 'lived';
  if (!charId) {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  box.innerHTML = `${renderExpSurfacePills()}<div class="loading"><div class="loading-spinner"></div></div>`;
  try {
    _livedData = await api.getLivedMemory(charId);
    if (_livedPastDate) {
      _livedPastDay = await api.getLivedDay(charId, _livedPastDate);
    }
    box.innerHTML = renderLivedMemory();
  } catch {
    box.innerHTML = `${renderExpSurfacePills()}<div class="empty-state"><div class="empty-text">加载失败</div></div>`;
  }
}

window.switchLivedView = function(view) {
  _livedView = view;
  if (view !== 'past') {
    _livedPastDate = '';
    _livedPastDay = null;
  }
  const box = document.getElementById('brain-exp-list');
  if (box && _livedData) box.innerHTML = renderLivedMemory();
  else loadLivedMemory();
};

window.openLivedPast = async function(date) {
  const charId = window.getActiveCharId?.();
  if (!charId || !date) return;
  _livedView = 'past';
  _livedPastDate = date;
  try {
    const day = await api.getLivedDay(charId, date);
    _livedPastDay = day || null;
    const box = document.getElementById('brain-exp-list');
    if (box) box.innerHTML = renderLivedMemory();
  } catch (e) {
    window.showToast?.(e.message || '加载失败');
  }
};

window.closeLivedPast = function() {
  _livedPastDate = '';
  _livedPastDay = null;
  const box = document.getElementById('brain-exp-list');
  if (box) box.innerHTML = renderLivedMemory();
};

window.digestLivedToday = async function() {
  if (_livedDigestBusy) return;
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  _livedDigestBusy = true;
  window.showToast?.('正在收成整天事记…');
  try {
    const result = await api.digestLivedDay(charId, _livedData?.today || '');
    const bits = [];
    if (result?.story) bits.push('事记');
    if (result?.useful) bits.push(`有用 ${result.useful}`);
    if (result?.portrait?.changed) bits.push(`画像 ${result.portrait.changed}`);
    window.showToast?.(bits.length ? `已消化：${bits.join(' · ')}` : '已消化');
    _livedView = 'today';
    _livedData = await api.getLivedMemory(charId);
    if (result?.cognition && _livedData) _livedData.cognition = result.cognition;
    const box = document.getElementById('brain-exp-list');
    if (box) box.innerHTML = renderLivedMemory();
  } catch (e) {
    window.showToast?.(e.message || '消化失败');
  } finally {
    _livedDigestBusy = false;
  }
};

const USER_READ_FACT_CATS = ['性格', '喜恶', '行为习惯', '情绪反应', '人际关系', '其他'];
const USER_READ_RECENT_CATS = ['在忙', '计划', '烦心事', '状态', '其他'];
let _userReads = [];
let _userReadEditId = null;
let _userReadDigestBusy = false;
let _userReadSection = 'fact';
let _userReadTtlDays = 14;

function userReadCatsFor(section) {
  return section === 'recent' ? USER_READ_RECENT_CATS : USER_READ_FACT_CATS;
}

function renderUserReadSections(active = 'fact') {
  const box = document.getElementById('user-read-sections');
  if (!box) return;
  box.innerHTML = [['recent', '近况'], ['fact', '本人事实']].map(([id, label]) =>
    `<button type="button" class="brain-cat-pill${id === active ? ' active' : ''}" data-read-section="${id}" onclick="selectUserReadSection(this)">${label}</button>`
  ).join('');
}

function renderUserReadCats(active = '性格', section = _userReadSection) {
  const box = document.getElementById('user-read-cats');
  if (!box) return;
  const cats = userReadCatsFor(section);
  const pick = cats.includes(active) ? active : cats[0];
  box.innerHTML = cats.map((c) =>
    `<button type="button" class="brain-cat-pill${c === pick ? ' active' : ''}" data-read-cat="${escapeHtml(c)}" onclick="selectUserReadCat(this)">${escapeHtml(c)}</button>`
  ).join('');
  box.dataset.active = pick;
}

function formatReadSeen(d) {
  const m = String(d || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[1])}/${Number(m[2])}` : '';
}

function renderUserReadGroup(list, cats, { recent = false } = {}) {
  return cats.map((cat) => {
    const rows = list.filter((r) => r.category === cat);
    if (!rows.length) return '';
    const body = rows.map((r) => {
      const seen = recent ? formatReadSeen(r.last_seen) : '';
      return `
        <div class="user-read-line">
          <button type="button" class="user-read-edit" onclick="openUserReadEditor(${r.id})">改</button>
          <details>
            <summary>${escapeHtml(r.judgment)}${cat === '情绪反应' ? '<span class="user-read-badge">教训</span>' : ''}${r.bad_habit ? '<span class="user-read-badge">坏习惯</span>' : ''}${seen ? `<span class="user-read-badge">${escapeHtml(seen)} 提到</span>` : ''}</summary>
            <div class="user-read-reason">${r.reason ? escapeHtml(r.reason) : (cat === '情绪反应' ? '还没有记下那一次' : '还没有写下原因')}</div>
          </details>
        </div>`;
    }).join('');
    return `<section class="user-read-section">
      <div class="user-read-cat">${escapeHtml(cat)}</div>
      ${body}
    </section>`;
  }).join('');
}

function renderUserReadsHtml(items) {
  const c = getActiveChar();
  const name = charDisplayName(c);
  const list = items || [];
  const recent = list.filter((r) => r.section === 'recent');
  const facts = list.filter((r) => r.section !== 'recent');
  const recentHtml = recent.length
    ? renderUserReadGroup(recent, USER_READ_RECENT_CATS, { recent: true })
    : '<div class="user-read-empty">还没有近况</div>';
  const factHtml = facts.length
    ? renderUserReadGroup(facts, USER_READ_FACT_CATS)
    : '<div class="user-read-empty">还没有</div>';
  return `
    <div class="portrait-mirror">
      <div class="portrait-mirror-glow"></div>
      <div class="portrait-mirror-inner">
        <div class="portrait-mirror-icon">🪞</div>
        <div class="portrait-mirror-title">${escapeHtml(name)} 眼中的你</div>
        <div class="portrait-mirror-desc">每天凌晨把前一天的聊天总结按顺序理好、去掉重复，再消化进这里。近况 ${_userReadTtlDays} 天没再提起会自己收掉。情绪反应记的是相处教训，点开是哪一次学到的。</div>
        <div class="portrait-mirror-stats">
          <span class="portrait-mirror-stat">近况 <strong>${recent.length}</strong></span>
          <span class="portrait-mirror-dot">·</span>
          <span class="portrait-mirror-stat">事实 <strong>${facts.length}</strong></span>
        </div>
        <div class="portrait-mirror-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="digestUserReads()">消化今天</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="openUserReadEditor(null)">＋ 添加</button>
        </div>
      </div>
    </div>
    <div class="user-read-sheet">
      <div class="user-read-part-title">近况</div>
      ${recentHtml}
      <div class="user-read-part-title">本人事实</div>
      ${factHtml}
    </div>`;
}

async function loadUserReads() {
  const charId = window.getActiveCharId?.();
  const box = document.getElementById('brain-portrait-list');
  if (!box) return;
  if (!charId) {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">请先选择角色</div></div>';
    return;
  }
  box.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const data = await api.getUserReads(charId);
    _userReads = data?.items || [];
    if (Number(data?.recentTtlDays) > 0) _userReadTtlDays = Number(data.recentTtlDays);
    box.innerHTML = renderUserReadsHtml(_userReads);
  } catch {
    box.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
  }
}

function applyUserReadEditorHints(cat) {
  const j = document.getElementById('user-read-judgment');
  const r = document.getElementById('user-read-reason');
  const jl = document.getElementById('user-read-judgment-label');
  const rl = document.getElementById('user-read-reason-label');
  if (!j || !r) return;
  if (cat === '情绪反应') {
    if (jl) jl.textContent = '教训';
    if (rl) rl.textContent = '那一次怎么学到的';
    j.maxLength = 56;
    r.maxLength = 220;
    j.placeholder = '生气时要怎样、绝对不能怎样。例如：她生气时要放软语气好好哄，绝不能顺着她让她一个人冷静';
    r.placeholder = '哪一天因为什么惹她不高兴，当时她什么样，你怎么做的，结果怎样，所以以后要怎样。';
  } else {
    if (jl) jl.textContent = '判断';
    if (rl) rl.textContent = '当时为什么这么认为';
    j.maxLength = 48;
    r.maxLength = 180;
    j.placeholder = '现在怎么看对方，一句。例如：嘴上说随便，其实在等我先开口';
    r.placeholder = '当时怎么看、什么感觉、为什么收成这一句。不贴聊天原文。';
  }
}

window.selectUserReadCat = function(el) {
  const cat = el?.dataset?.readCat || '性格';
  document.querySelectorAll('#user-read-cats .brain-cat-pill').forEach((t) => t.classList.remove('active'));
  el?.classList.add('active');
  document.getElementById('user-read-cats').dataset.active = cat;
  applyUserReadEditorHints(cat);
};

window.selectUserReadSection = function(el) {
  _userReadSection = el?.dataset?.readSection === 'recent' ? 'recent' : 'fact';
  renderUserReadSections(_userReadSection);
  renderUserReadCats('', _userReadSection);
  applyUserReadEditorHints(document.getElementById('user-read-cats')?.dataset?.active || '');
};

window.openUserReadEditor = function(id) {
  _userReadEditId = id;
  document.getElementById('user-read-modal-title').textContent = id ? '编辑判断' : '添加判断';
  document.getElementById('user-read-judgment').value = '';
  document.getElementById('user-read-reason').value = '';
  document.getElementById('user-read-del-btn').style.display = id ? '' : 'none';
  let cat = '性格';
  _userReadSection = 'fact';
  if (id) {
    const row = (_userReads || []).find((x) => x.id === id);
    if (row) {
      _userReadSection = row.section === 'recent' ? 'recent' : 'fact';
      cat = row.category || '';
      document.getElementById('user-read-judgment').value = row.judgment || '';
      document.getElementById('user-read-reason').value = row.reason || '';
    }
  }
  renderUserReadSections(_userReadSection);
  renderUserReadCats(cat, _userReadSection);
  applyUserReadEditorHints(cat);
  document.getElementById('user-read-edit-overlay').classList.add('active');
};

window.saveUserRead = async function() {
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  const section = _userReadSection === 'recent' ? 'recent' : 'fact';
  const active = document.querySelector('#user-read-cats .brain-cat-pill.active')?.dataset?.readCat
    || document.getElementById('user-read-cats')?.dataset?.active
    || userReadCatsFor(section)[0];
  const judgment = document.getElementById('user-read-judgment')?.value?.trim();
  const reason = document.getElementById('user-read-reason')?.value?.trim() || '';
  if (!judgment) { window.showToast?.('请填写判断'); return; }
  try {
    if (_userReadEditId) await api.updateUserRead(_userReadEditId, { category: active, section, judgment, reason });
    else await api.createUserRead({ characterId: charId, category: active, section, judgment, reason });
    document.getElementById('user-read-edit-overlay').classList.remove('active');
    window.showToast?.('已保存');
    await loadUserReads();
  } catch (e) { window.showToast?.(e.message || '保存失败'); }
};

window.deleteUserReadCurrent = async function() {
  if (!_userReadEditId || !confirm('删除这条判断？')) return;
  try {
    await api.deleteUserRead(_userReadEditId);
    document.getElementById('user-read-edit-overlay').classList.remove('active');
    await loadUserReads();
  } catch (e) { window.showToast?.(e.message || '删除失败'); }
};

window.digestUserReads = async function() {
  if (_userReadDigestBusy) return;
  const charId = window.getActiveCharId?.();
  if (!charId) return;
  _userReadDigestBusy = true;
  window.showToast?.('正在把今天的聊天消化进画像…');
  try {
    const result = await api.digestUserReads(charId, '');
    const n = Number(result?.changed) || 0;
    const removed = Number(result?.removed) || 0;
    const selfN = Number(result?.selfChanged) || 0;
    if (result?.reason === 'no_chat') window.showToast?.('今天还没有聊天总结可消化');
    else if (n || removed || selfN) {
      const bits = [`画像更新 ${n} 条`];
      if (removed) bits.push(`收掉 ${removed} 条过去的近况`);
      if (selfN) bits.push(`对自己的看法 ${selfN} 条`);
      window.showToast?.(bits.join('，'));
    } else window.showToast?.('今天没有新的认识');
    await loadUserReads();
  } catch (e) {
    window.showToast?.(e.message || '消化失败');
  } finally {
    _userReadDigestBusy = false;
  }
};

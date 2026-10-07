/* ===== 日历页（月历 + 双心情贴 + 当日行程） ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import {
  ensureInlineEmojis,
  lookupInlineEmoji,
  openSystemEmojiOverlay,
} from '../inline-emoji.js';
import { getMonthInfo } from '../api.js';

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

function formatWeekday(dateStr) {
  const w = ['日', '一', '二', '三', '四', '五', '六'];
  const d = new Date(dateStr + 'T12:00:00');
  return `周${w[d.getDay()]}`;
}

function parseYearMonth(dateStr) {
  const [y, m] = String(dateStr || '').split('-').map(Number);
  return { year: y, month: m };
}

function monthLabel(year, month) {
  return `${year}年${month}月`;
}

function normalizeItem(it) {
  return {
    time: String(it?.time || '').trim(),
    activity: String(it?.activity || it?.title || '').trim(),
    place: sanitizeRegionPlace(it?.place),
    thought: String(it?.thought || '').trim(),
    execution: String(it?.execution || '').trim(),
  };
}

const PLACE_STOP_RE = /常态|本地|日常|加班|休息|休假|社交|杂事|工作|学习|家里|在家|公司|办公室|路上|通勤|客户|同事|朋友|自己|对方|用户|角色|今天|明天|昨天|出发|返程|在外|酒店|出差|办事|外勤/;
const KNOWN_CITY_RE = /北京|上海|广州|深圳|杭州|南京|苏州|成都|重庆|武汉|西安|天津|长沙|郑州|青岛|大连|厦门|福州|合肥|济南|沈阳|哈尔滨|长春|昆明|南昌|太原|石家庄|贵阳|南宁|海口|三亚|兰州|银川|西宁|乌鲁木齐|拉萨|呼和浩特|香港|澳门|台北|宁波|无锡|佛山|东莞|珠海|中山|温州|嘉兴|金华|绍兴|台州|扬州|南通|常州|徐州|烟台|威海|洛阳|桂林|丽江|大理|黄山/;
/** 房间/居所/店名，不是城市地区 */
const ROOM_PLACE_RE = /厨房|客厅|卧室|书房|阳台|浴室|卫生间|洗手间|餐厅|玄关|露台|天台|房间|别墅|豪宅|公寓|民宿|客栈|青旅|旅馆|宾馆|农家乐|木屋|营地|帐篷/;
/** 做事/玩法短语，不能当地名（如「民宿避暑」） */
const ACTIVITY_PLACE_RE = /弄了|做了|吃了|看了|睡了|点了|准备|简单|一下|一会|一會兒|正在|开始|继续|然后|做饭|下厨|洗漱|避暑|度假|游玩|旅游|旅行|闲逛|逛街|购物|聚餐|吃饭|烧烤|露营|徒步|爬山|健身|跑步|游泳|泡澡|洗澡|午睡|睡觉|开会|上课|追剧|看电影|看展|演出|演唱会|剧本杀|密室|放松|疗养/;

function stripPlaceSuffix(s) {
  return String(s || '').replace(/[市县区省镇州]$/, '').trim().slice(0, 12);
}

function looksLikeRegionPlace(raw) {
  const compact = String(raw || '').replace(/\s+/g, '').trim();
  if (compact.length < 2 || compact.length > 12) return false;
  if (ROOM_PLACE_RE.test(compact)) return false;
  if (ACTIVITY_PLACE_RE.test(compact)) return false;
  if (PLACE_STOP_RE.test(compact)) return false;
  if (/[，。！？、；：,.!?;:（）()【】\[\]"'“”‘’]/.test(compact)) return false;
  if (/[了着过]/.test(compact)) return false;
  const knownHit = compact.match(KNOWN_CITY_RE);
  if (knownHit && (compact === knownHit[0] || compact === `${knownHit[0]}市`)) return true;
  const core = compact.replace(/[市县区省镇州城]$/, '');
  if (!/^[\u4e00-\u9fffA-Za-z·・]{2,8}$/.test(core)) return false;
  if (/的$/.test(core) && !/城$/.test(core)) return false;
  if (/[店馆屋庄园寨吧厅厦楼]$/.test(core) && !/城$/.test(core)) return false;
  return true;
}

function acceptRegionPlace(candidate) {
  const s = stripPlaceSuffix(candidate);
  return looksLikeRegionPlace(s) ? s.slice(0, 12) : '';
}

function extractPlaceFromText(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return '';
  const known = t.match(KNOWN_CITY_RE);
  if (known) return known[0];
  const labeled = t.match(/(?:地点|城市|目的地|所在)[:：·]([^\s，。,.]{2,10})/);
  if (labeled) {
    const v = acceptRegionPlace(labeled[1]);
    if (v) return v;
  }
  const dotted = t.match(/([\u4e00-\u9fffA-Za-z]{2,10})[·・](?:出发|在外|返程|出差)/);
  if (dotted) {
    const v = acceptRegionPlace(dotted[1]);
    if (v) return v;
  }
  const dotted2 = t.match(/(?:出差|出发|在外|返程)[·・]([\u4e00-\u9fffA-Za-z]{2,10})/);
  if (dotted2) {
    const v = acceptRegionPlace(dotted2[1]);
    if (v) return v;
  }
  const trip = t.match(/([\u4e00-\u9fffA-Za-z]{2,10})(?:市)?(?:出差|办事|外勤)/);
  if (trip) {
    const v = acceptRegionPlace(trip[1]);
    if (v) return v;
  }
  const dest = t.match(/(?:去|到|飞往|赴|前往|抵达|路过)([\u4e00-\u9fff]{2,8})(?:市|县)?/);
  if (dest) {
    const v = acceptRegionPlace(dest[1]);
    if (v) return v;
  }
  const atHotel = t.match(/在([\u4e00-\u9fff]{2,8})(?:市)?(?:酒店|机场|高铁站|火车站|会场)/);
  if (atHotel) {
    const v = acceptRegionPlace(atHotel[1]);
    if (v) return v;
  }
  return '';
}

function sanitizeRegionPlace(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  const direct = acceptRegionPlace(t);
  if (direct) return direct;
  const known = t.match(KNOWN_CITY_RE);
  if (known) return known[0];
  return extractPlaceFromText(t);
}

function weekPlaceForDate(dateStr) {
  const char = _characters.find((c) => Number(c.id) === Number(_schedCharId));
  if (!char) return '';
  try {
    const plan = typeof char.schedule_week_plan === 'string'
      ? JSON.parse(char.schedule_week_plan || '')
      : char.schedule_week_plan;
    const day = plan?.days?.find((d) => String(d.date) === String(dateStr));
    const explicit = sanitizeRegionPlace(day?.place);
    if (explicit) return explicit;
    return extractPlaceFromText(`${day?.theme || ''} ${day?.note || ''}`);
  } catch {
    return '';
  }
}

function homePlaceForChar() {
  const char = _characters.find((c) => Number(c.id) === Number(_schedCharId));
  const present = sanitizeRegionPlace(char?.present_location);
  if (present) return present;
  return sanitizeRegionPlace(char?.location_name || '')
    || sanitizeRegionPlace(char?.real_location || '');
}

function resolveItemPlace(it, user = false) {
  const explicit = sanitizeRegionPlace(it?.place);
  if (explicit) return explicit;
  const fromText = extractPlaceFromText(it?.activity || '');
  if (fromText) return fromText;
  if (user) return '';
  const week = weekPlaceForDate(_schedDate);
  if (week) return week;
  // 同城日常才用常住；不要用常住城盖住「人在外地但 place 没写好」的空档
  return '';
}

function renderTimeCol(it, user = false) {
  const place = resolveItemPlace(it, user);
  return `
    <div class="schedule-time-col">
      <div class="schedule-time-dot${user ? ' schedule-time-dot--user' : ''}"></div>
      <div class="schedule-time">${escapeHtml(it.time || '—')}</div>
      ${place ? `<div class="schedule-place">${escapeHtml(place)}</div>` : ''}
    </div>`;
}

function timeToMinutes(t) {
  const [h, m] = String(t || '').split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

function sortScheduleItemsByTime(items) {
  return [...(items || [])].sort((a, b) => (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999));
}

function currentMinutes() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

function slotEndMinutes(items, idx) {
  const start = timeToMinutes(items[idx]?.time);
  if (start == null) return null;
  if (idx < items.length - 1) {
    const next = timeToMinutes(items[idx + 1]?.time);
    if (next != null) return next;
  }
  return Math.min(start + 120, 24 * 60);
}

const STATUS_LABELS = {
  upcoming: '即将到来',
  now: '进行中',
  past: '已结束',
};

function getUserItemStatus(item, items, idx, dateStr) {
  const today = localDateStr();
  if (dateStr > today) return 'upcoming';
  if (dateStr < today) return 'past';

  const now = currentMinutes();
  const start = timeToMinutes(item.time);
  const end = slotEndMinutes(items, idx);
  if (start == null) return 'upcoming';
  if (now < start) return 'upcoming';
  if (end != null && now < end) return 'now';
  return 'past';
}

function getItemStatus(item, items, idx, dateStr) {
  const today = localDateStr();
  if (dateStr > today) return 'upcoming';
  if (dateStr < today) return 'past';

  const now = currentMinutes();
  const start = timeToMinutes(item.time);
  const end = slotEndMinutes(items, idx);
  if (start == null) return 'upcoming';
  if (now < start) return 'upcoming';
  if (end != null && now < end) return 'now';
  return 'past';
}

let _schedTab = 'char';
let _schedDate = localDateStr();
let _schedCharId = null;
let _characters = [];
let _charItems = [];
let _userItems = [];
let _charGenerated = false;
let _generating = false;
let _calYear = new Date().getFullYear();
let _calMonth = new Date().getMonth() + 1;
let _moodDays = {}; // date -> { char?, user? }
let _moodsLoading = false;
let _calView = 'month'; // month | day
let _monthInfo = {}; // dateStr -> { lunar, holidays }
let _monthInfoLoading = false;

function beanImgHtml(code, cls = '') {
  if (!code) return '';
  const hit = lookupInlineEmoji(code);
  if (!hit) {
    return `<span class="cal-bean-fallback ${cls}" title="${escapeHtml(code)}">[${escapeHtml(code)}]</span>`;
  }
  return `<img class="cal-bean ${cls}" src="${escapeHtml(hit.url)}" alt="${escapeHtml(code)}" title="${escapeHtml(code)}" draggable="false">`;
}

function activeChar() {
  return _characters.find((c) => Number(c.id) === Number(_schedCharId)) || null;
}

function charAvatarHtml(char, cls = 'cal-top-av') {
  if (!char) {
    return `<div class="${cls} ${cls}--ph">?</div>`;
  }
  if (char.avatar) {
    return `<img class="${cls}" src="${escapeHtml(char.avatar)}" alt="">`;
  }
  return `<div class="${cls} ${cls}--ph">${escapeHtml((char.name || '?')[0])}</div>`;
}

function dayTitleText() {
  const today = localDateStr();
  const info = _monthInfo[_schedDate];
  const lunarLabel = info?.lunar?.label;
  const holidayLabel = info?.holidays?.[0]?.name;
  let title;
  if (_schedDate === today) {
    title = `今天 · ${formatWeekday(_schedDate)}`;
  } else {
    const [, m, d] = _schedDate.split('-');
    title = `${Number(m)}月${Number(d)}日 · ${formatWeekday(_schedDate)}`;
  }
  if (lunarLabel) title += ` · ${lunarLabel}`;
  if (holidayLabel) title += ` · ${holidayLabel}`;
  return title;
}

window.initSchedulePage = async function() {
  _schedDate = localDateStr();
  const ym = parseYearMonth(_schedDate);
  _calYear = ym.year;
  _calMonth = ym.month;
  _schedTab = window._scheduleInitTab || 'char';
  window._scheduleInitTab = null;
  _moodDays = {};
  _calView = 'month';
  _monthInfo = {};

  try {
    _characters = window.filterFullCharacters?.(await api.getCharacters()) || await api.getCharacters();
  } catch { _characters = []; }
  if (!_schedCharId && _characters.length) {
    _schedCharId = window.getActiveCharId?.() || _characters[0].id;
  }

  await ensureInlineEmojis().catch(() => {});

  const page = document.getElementById('schedule-page');
  page.innerHTML = `
    <div class="topbar" id="cal-topbar">
      <button type="button" class="topbar-back topbar-nav-back" id="cal-back-btn" onclick="onCalendarBack()" title="返回"></button>
      <div class="topbar-title" id="cal-top-title" style="font-family:'Noto Serif SC',serif">📅 日历</div>
      <div class="topbar-actions" id="cal-top-actions">
        <button type="button" class="topbar-action cal-top-char-btn" id="cal-top-char-btn" onclick="toggleCalCharSheet()" title="切换角色"></button>
      </div>
    </div>

    <div class="cal-char-sheet" id="cal-char-sheet" style="display:none" onclick="if(event.target===this)closeCalCharSheet()">
      <div class="cal-char-sheet-panel" onclick="event.stopPropagation()">
        <div class="cal-char-sheet-title">切换角色</div>
        <div class="cal-char-sheet-list" id="cal-char-sheet-list"></div>
      </div>
    </div>

    <div class="cal-view cal-view--month" id="cal-view-month">
      <div class="cal-month-bar">
        <button type="button" class="btn btn-ghost btn-sm" onclick="shiftCalendarMonth(-1)" aria-label="上月">‹</button>
        <div class="cal-month-label-group">
          <button type="button" class="cal-ym-btn" id="cal-month-btn" onclick="openCalYearMonthPicker()">${monthLabel(_calYear, _calMonth)}</button>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="shiftCalendarMonth(1)" aria-label="下月">›</button>
        <button type="button" class="btn btn-ghost btn-sm cal-today-btn" onclick="resetCalendarToday()">今天</button>
      </div>
      <div class="cal-weekdays" aria-hidden="true">
        <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
      </div>
      <div class="cal-grid" id="cal-grid"></div>
      <div class="cal-month-hint">点某一天查看行程与心情</div>
    </div>

    <div class="cal-view cal-view--day" id="cal-view-day" style="display:none">
      <div class="cal-mood-bar" id="cal-mood-bar"></div>

      <div class="schedule-tab-bar">
        <div id="schedtab-char" class="schedule-tab" onclick="switchScheduleTab('char')">🌸 角色行程</div>
        <div id="schedtab-user" class="schedule-tab" onclick="switchScheduleTab('user')">📒 我的安排</div>
      </div>

      <div id="sched-panel-char" class="schedule-panel">
        <div class="schedule-toolbar">
          <span class="schedule-hint" id="sched-char-hint">按周规划主线，每天凌晨自动补全今天到周末</span>
          <div class="schedule-toolbar-actions">
            <button type="button" class="btn btn-primary btn-sm" id="sched-gen-btn" onclick="generateCharSchedule()">✨ 生成本周</button>
          </div>
        </div>
        <div class="scroll-area schedule-scroll" id="sched-char-list">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>

      <div id="sched-panel-user" class="schedule-panel" style="display:none">
        <div class="schedule-user-intro">
          填好安排后，角色聊天时会读到「用户今日安排」，可以自然关心或提及。
        </div>
        <div class="schedule-toolbar">
          <span class="schedule-hint" id="sched-user-hint">轻点卡片可编辑 · 角色会看到你今天的安排</span>
          <div class="schedule-toolbar-actions">
            <button type="button" class="btn btn-primary btn-sm" onclick="openUserScheduleEditor()">＋ 添加一项</button>
          </div>
        </div>
        <div class="scroll-area schedule-scroll" id="sched-user-list">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>
    </div>
  `;

  switchScheduleTab(_schedTab, true);
  renderTopCharBtn();
  renderCharSheetList();
  showCalendarView('month');
  renderCalendarGrid();
  await Promise.all([loadMonthMoods(), loadMonthInfo()]);
};

function renderCalendarGrid() {
  const grid = document.getElementById('cal-grid');
  const label = document.getElementById('cal-month-btn');
  if (label) label.textContent = monthLabel(_calYear, _calMonth);
  if (!grid) return;

  const first = new Date(_calYear, _calMonth - 1, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(_calYear, _calMonth, 0).getDate();
  const today = localDateStr();
  const cells = [];

  for (let i = 0; i < startPad; i++) {
    cells.push('<div class="cal-cell cal-cell--empty"></div>');
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${_calYear}-${String(_calMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const moods = _moodDays[dateStr] || {};
    const info = _monthInfo[dateStr] || {};
    const isToday = dateStr === today;
    const hasMood = !!(moods.char?.emojiCode || moods.user?.emojiCode);
    const hasHoliday = !!(info.holidays?.length);
    // 农历：每月初一显示月份（带「正月/闰月」），其余日子只显日（初/十/廿/三十）
    const lunarDay = info.lunar?.day;
    const isFirstOfLunarMonth = lunarDay === 1;
    let lunarLabel = '';
    if (isFirstOfLunarMonth) {
      const monthChar = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'][Math.max(0, Math.min(11, (info.lunar?.month || 1) - 1))];
      lunarLabel = `${info.lunar?.isLeap ? '闰' : ''}${monthChar}月`;
    } else {
      lunarLabel = lunarDayLabel(lunarDay);
    }
    const holidayLabel = info.holidays?.[0]?.name || '';
    const charBean = moods.char?.emojiCode ? beanImgHtml(moods.char.emojiCode, 'cal-bean--char') : '';
    const userBean = moods.user?.emojiCode ? beanImgHtml(moods.user.emojiCode, 'cal-bean--user') : '';
    cells.push(`
      <button type="button" class="cal-cell${isToday ? ' is-today' : ''}${hasMood ? ' has-mood' : ''}${hasHoliday ? ' has-holiday' : ''}${isFirstOfLunarMonth ? ' is-lunar-first' : ''}"
        data-date="${dateStr}" onclick="openCalendarDay('${dateStr}')">
        <span class="cal-day-num">${day}</span>
        ${lunarLabel ? `<span class="cal-lunar-label">${escapeHtml(lunarLabel)}</span>` : ''}
        ${holidayLabel ? `<span class="cal-holiday-label">${escapeHtml(holidayLabel)}</span>` : ''}
        <span class="cal-beans">${charBean}${userBean}</span>
      </button>`);
  }

  grid.innerHTML = cells.join('');
}

/** 农历日 → 简短显示（初一以外的日只显「初/十/廿/三十」） */
function lunarDayLabel(d) {
  if (!d) return '';
  const CN = '一二三四五六七八九';
  if (d === 10) return '初十';
  if (d === 20) return '二十';
  if (d === 30) return '三十';
  const idx = (d - 1) % 10;
  if (d < 10) return '初' + CN[idx];
  if (d < 20) return '十' + CN[idx];
  return '廿' + CN[idx];
}

function renderTopCharBtn() {
  const btn = document.getElementById('cal-top-char-btn');
  if (!btn) return;
  const char = activeChar();
  btn.innerHTML = charAvatarHtml(char, 'cal-top-av');
  btn.title = char ? `当前：${char.name}` : '选择角色';
}

function renderCharSheetList() {
  const list = document.getElementById('cal-char-sheet-list');
  if (!list) return;
  if (!_characters.length) {
    list.innerHTML = `<div class="schedule-empty-hint">还没有角色</div>`;
    return;
  }
  list.innerHTML = _characters.map((c) => {
    const active = Number(c.id) === Number(_schedCharId);
    return `<button type="button" class="cal-char-sheet-item${active ? ' active' : ''}" onclick="selectScheduleChar(${c.id})">
      ${charAvatarHtml(c, 'cal-sheet-av')}
      <span>${escapeHtml(c.name)}</span>
      ${active ? '<span class="cal-char-sheet-check">✓</span>' : ''}
    </button>`;
  }).join('');
}

function showCalendarView(view) {
  _calView = view === 'day' ? 'day' : 'month';
  const monthEl = document.getElementById('cal-view-month');
  const dayEl = document.getElementById('cal-view-day');
  const title = document.getElementById('cal-top-title');
  if (monthEl) monthEl.style.display = _calView === 'month' ? '' : 'none';
  if (dayEl) dayEl.style.display = _calView === 'day' ? '' : 'none';
  if (title) {
    title.textContent = _calView === 'day' ? dayTitleText() : '📅 日历';
  }
  closeCalCharSheet();
}

window.onCalendarBack = function() {
  if (_calView === 'day') {
    showCalendarView('month');
    renderCalendarGrid();
    return;
  }
  window.goBack?.();
};

window.toggleCalCharSheet = function() {
  const sheet = document.getElementById('cal-char-sheet');
  if (!sheet) return;
  if (sheet.style.display === 'none') {
    renderCharSheetList();
    sheet.style.display = '';
  } else {
    sheet.style.display = 'none';
  }
};

window.closeCalCharSheet = function() {
  const sheet = document.getElementById('cal-char-sheet');
  if (sheet) sheet.style.display = 'none';
};

function renderMoodBar() {
  const el = document.getElementById('cal-mood-bar');
  if (!el) return;
  const moods = _moodDays[_schedDate] || {};
  const charName = activeChar()?.name || '角色';
  const charCode = moods.char?.emojiCode || '';
  const userCode = moods.user?.emojiCode || '';
  const charBean = charCode
    ? beanImgHtml(charCode, 'cal-bean--char cal-bean--lg')
    : '<span class="cal-bean-empty">未贴</span>';
  const userBean = userCode
    ? beanImgHtml(userCode, 'cal-bean--user cal-bean--lg')
    : '<span class="cal-bean-empty">未贴</span>';

  el.innerHTML = `
    <div class="cal-mood-slot">
      <div class="cal-mood-slot-label">${escapeHtml(charName)} 的心情</div>
      <div class="cal-mood-slot-body">
        ${charBean}
        <div class="cal-mood-slot-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="openCharMoodPicker()" ${_schedCharId ? '' : 'disabled'}>纠偏</button>
          ${charCode ? `<button type="button" class="btn btn-ghost btn-sm" onclick="clearCharMood()">清除</button>` : ''}
        </div>
      </div>
      <div class="cal-mood-slot-hint">睡前整理后自动贴 · 可手动纠偏</div>
    </div>
    <div class="cal-mood-slot">
      <div class="cal-mood-slot-label">我的心情</div>
      <div class="cal-mood-slot-body">
        ${userBean}
        <div class="cal-mood-slot-actions">
          <button type="button" class="btn btn-primary btn-sm" onclick="openUserMoodPicker()">贴心情</button>
          ${userCode ? `<button type="button" class="btn btn-ghost btn-sm" onclick="clearUserMood()">清除</button>` : ''}
        </div>
      </div>
    </div>`;
}

async function loadMonthInfo() {
  _monthInfoLoading = true;
  try {
    const data = await getMonthInfo(_calYear, _calMonth);
    _monthInfo = data?.days || {};
  } catch (e) {
    console.warn('[calendar] month info', e);
    _monthInfo = {};
  }
  _monthInfoLoading = false;
  renderCalendarGrid();
}

window.openCalYearMonthPicker = function() {
  const existing = document.getElementById('cal-ym-picker');
  if (existing) { existing.remove(); }
  const overlay = document.createElement('div');
  overlay.id = 'cal-ym-picker';
  overlay.className = 'overlay center active';
  overlay.style.zIndex = '10040';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const years = [];
  for (let y = _calYear - 10; y <= _calYear + 2; y++) years.push(y);
  const months = Array.from({ length: 12 }, (_, i) => i + 1);

  overlay.innerHTML = `
    <div class="modal cal-wheel-modal" onclick="event.stopPropagation()">
      <div class="modal-title" style="text-align:center">跳转到</div>
      <div class="cal-wheel-pane">
        <div class="cal-wheel-row">
          <div class="cal-wheel-mask"></div>
          <div class="cal-wheel" id="cal-wheel-year" data-kind="year">
            <div class="cal-wheel-list"></div>
          </div>
          <div class="cal-wheel" id="cal-wheel-month" data-kind="month">
            <div class="cal-wheel-list"></div>
          </div>
        </div>
        <div class="cal-wheel-footer">
          <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('cal-ym-picker').remove()">取消</button>
          <button type="button" class="btn btn-primary btn-sm" id="cal-wheel-go">跳转</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let pickedYear = _calYear;
  let pickedMonth = _calMonth;
  const yearList = overlay.querySelector('#cal-wheel-year .cal-wheel-list');
  const monthList = overlay.querySelector('#cal-wheel-month .cal-wheel-list');
  yearList.innerHTML = years.map(y => `<div class="cal-wheel-item" data-v="${y}">${y} 年</div>`).join('');
  monthList.innerHTML = months.map(m => `<div class="cal-wheel-item" data-v="${m}">${m} 月</div>`).join('');

  setupWheel(yearList, years.indexOf(_calYear), (i) => { pickedYear = years[i]; });
  setupWheel(monthList, months.indexOf(_calMonth), (i) => { pickedMonth = months[i]; });

  overlay.querySelector('#cal-wheel-go').onclick = () => {
    overlay.remove();
    _calYear = pickedYear;
    _calMonth = pickedMonth;
    const btn = document.getElementById('cal-month-btn');
    if (btn) btn.textContent = monthLabel(_calYear, _calMonth);
    renderCalendarGrid();
    loadMonthMoods();
    loadMonthInfo();
  };
};

function setupWheel(listEl, initialIndex, onChange) {
  const ITEM_H = 36;
  const pad = (initialIndex || 0) * ITEM_H;
  listEl.style.transform = `translateY(${ITEM_H * 2 - pad}px)`;
  listEl._wheelIndex = initialIndex || 0;

  function clamp(i) {
    const max = listEl.children.length - 1;
    return Math.max(0, Math.min(max, i));
  }
  function snap() {
    const idx = clamp(Math.round(-parseFloat(listEl.style.transform.replace(/[^\-0-9.]/g, '') || 0) / ITEM_H) + 2);
    listEl._wheelIndex = idx;
    listEl.style.transform = `translateY(${-idx * ITEM_H + ITEM_H * 2}px)`;
    listEl.style.transition = 'transform 0.18s ease-out';
    setTimeout(() => { listEl.style.transition = ''; }, 200);
    onChange(idx);
  }
  let dragging = false;
  let startY = 0;
  let startOffset = 0;

  listEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startOffset = parseFloat(listEl.style.transform.replace(/[^\-0-9.]/g, '') || 0);
    listEl.setPointerCapture(e.pointerId);
  });
  listEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    listEl.style.transform = `translateY(${startOffset + dy}px)`;
  });
  listEl.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    listEl.releasePointerCapture(e.pointerId);
    snap();
  });
  listEl.addEventListener('pointercancel', () => {
    if (!dragging) return;
    dragging = false;
    snap();
  });
  listEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cur = parseFloat(listEl.style.transform.replace(/[^\-0-9.]/g, '') || 0);
    const delta = e.deltaY > 0 ? ITEM_H : -ITEM_H;
    listEl.style.transform = `translateY(${cur - delta}px)`;
    clearTimeout(listEl._wheelT);
    listEl._wheelT = setTimeout(snap, 80);
  }, { passive: false });
}

async function loadMonthMoods() {
  _moodsLoading = true;
  try {
    const data = await api.getDayMoods({
      year: _calYear,
      month: _calMonth,
      characterId: _schedCharId || undefined,
    });
    _moodDays = data?.days && typeof data.days === 'object' ? data.days : {};
  } catch (e) {
    console.warn('[calendar] moods', e);
    _moodDays = {};
  }
  _moodsLoading = false;
  renderCalendarGrid();
  if (_calView === 'day') renderMoodBar();
}

window.shiftCalendarMonth = function(delta) {
  let y = _calYear;
  let m = _calMonth + delta;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  _calYear = y;
  _calMonth = m;
  const day = Number(String(_schedDate).slice(8, 10)) || 1;
  const maxDay = new Date(y, m, 0).getDate();
  _schedDate = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, maxDay)).padStart(2, '0')}`;
  renderCalendarGrid();
  loadMonthMoods();
  loadMonthInfo();
};

window.resetCalendarToday = function() {
  _schedDate = localDateStr();
  const ym = parseYearMonth(_schedDate);
  _calYear = ym.year;
  _calMonth = ym.month;
  showCalendarView('month');
  renderCalendarGrid();
  loadMonthMoods();
  loadMonthInfo();
};

window.openCalendarDay = async function(dateStr) {
  if (!dateStr) return;
  _schedDate = dateStr;
  const ym = parseYearMonth(dateStr);
  if (ym.year !== _calYear || ym.month !== _calMonth) {
    _calYear = ym.year;
    _calMonth = ym.month;
    await Promise.all([loadMonthMoods(), loadMonthInfo()]);
  }
  showCalendarView('day');
  renderMoodBar();
  await loadScheduleData();
};

window.selectCalendarDate = window.openCalendarDay;

window.openUserMoodPicker = async function() {
  await openSystemEmojiOverlay({
    includeStickers: false,
    onPickBean: async (code) => {
      try {
        const r = await api.saveDayMood({ date: _schedDate, emojiCode: code, owner: 'user' });
        if (!_moodDays[_schedDate]) _moodDays[_schedDate] = {};
        _moodDays[_schedDate].user = r.mood;
        renderCalendarGrid();
        renderMoodBar();
        window.showToast?.('已贴上我的心情');
      } catch (e) {
        window.showToast?.(e.message || '贴失败');
      }
    },
  });
};

window.openCharMoodPicker = async function() {
  if (!_schedCharId) return;
  await openSystemEmojiOverlay({
    includeStickers: false,
    onPickBean: async (code) => {
      try {
        const r = await api.saveDayMood({
          date: _schedDate,
          emojiCode: code,
          owner: 'char',
          characterId: _schedCharId,
        });
        if (!_moodDays[_schedDate]) _moodDays[_schedDate] = {};
        _moodDays[_schedDate].char = r.mood;
        renderCalendarGrid();
        renderMoodBar();
        window.showToast?.('已纠偏角色心情');
      } catch (e) {
        window.showToast?.(e.message || '保存失败');
      }
    },
  });
};

window.clearUserMood = async function() {
  try {
    await api.deleteDayMood({ owner: 'user', date: _schedDate });
    if (_moodDays[_schedDate]) delete _moodDays[_schedDate].user;
    renderCalendarGrid();
    renderMoodBar();
  } catch (e) {
    window.showToast?.(e.message || '清除失败');
  }
};

window.clearCharMood = async function() {
  if (!_schedCharId) return;
  try {
    await api.deleteDayMood({ owner: 'char', date: _schedDate, characterId: _schedCharId });
    if (_moodDays[_schedDate]) delete _moodDays[_schedDate].char;
    renderCalendarGrid();
    renderMoodBar();
  } catch (e) {
    window.showToast?.(e.message || '清除失败');
  }
};

window.switchScheduleTab = function(tab, skipLoad) {
  _schedTab = tab;
  document.querySelectorAll('.schedule-tab').forEach((el) => el.classList.remove('active'));
  document.getElementById(`schedtab-${tab}`)?.classList.add('active');
  const charPanel = document.getElementById('sched-panel-char');
  const userPanel = document.getElementById('sched-panel-user');
  if (charPanel) charPanel.style.display = tab === 'char' ? '' : 'none';
  if (userPanel) userPanel.style.display = tab === 'user' ? '' : 'none';
  if (!skipLoad && _calView === 'day') loadScheduleData();
};

window.selectScheduleChar = function(id) {
  _schedCharId = id;
  closeCalCharSheet();
  renderTopCharBtn();
  renderCharSheetList();
  loadMonthMoods();
  if (_calView === 'day') {
    renderMoodBar();
    loadCharSchedule();
  }
};

async function loadScheduleData() {
  await Promise.all([loadCharSchedule(), loadUserSchedule()]);
}

function updateCharToolbar() {
  const hint = document.getElementById('sched-char-hint');
  const genBtn = document.getElementById('sched-gen-btn');
  const isToday = _schedDate === localDateStr();

  if (hint) {
    if (!_charGenerated) {
      hint.textContent = isToday
        ? '今日尚未生成 · 点「生成今日」会生成今天的行程'
        : '这一天还没有行程 · 生成本周可以一次性安排本周多天';
    } else {
      hint.textContent = isToday
        ? '今日行程已生成 · 可再点「生成今日」刷新'
        : '这一天已有行程 · 生成本周可规划本周多天';
    }
  }
  if (genBtn) {
    genBtn.textContent = isToday ? '✨ 生成今日' : '✨ 生成本周';
  }
}

async function loadCharSchedule() {
  const list = document.getElementById('sched-char-list');
  if (!list) return;
  if (!_schedCharId) {
    list.innerHTML = `<div class="schedule-empty"><div class="schedule-empty-icon">🌸</div><div>选择角色查看行程</div></div>`;
    return;
  }
  list.innerHTML = `<div class="loading"><div class="loading-spinner"></div></div>`;
  try {
    const data = await api.getSchedule({ role: 'ai', charId: _schedCharId, date: _schedDate });
    _charItems = sortScheduleItemsByTime((data.items || []).map(normalizeItem));
    _charGenerated = !!data.generated;
    updateCharToolbar();
    renderCharTimeline();
  } catch (e) {
    list.innerHTML = `<div class="schedule-empty">${escapeHtml(e.message)}</div>`;
  }
}

async function loadUserSchedule() {
  const list = document.getElementById('sched-user-list');
  if (!list) return;
  list.innerHTML = `<div class="loading"><div class="loading-spinner"></div></div>`;
  try {
    const data = await api.getSchedule({ role: 'user', date: _schedDate });
    _userItems = sortScheduleItemsByTime((data.items || []).map(normalizeItem));
    renderUserTimeline();
  } catch (e) {
    list.innerHTML = `<div class="schedule-empty">${escapeHtml(e.message)}</div>`;
  }
}

function renderCharTimeline() {
  const list = document.getElementById('sched-char-list');
  if (!list) return;
  if (!_charItems.length) {
    list.innerHTML = `
      <div class="schedule-empty">
        <div class="schedule-empty-icon">📋</div>
        <div>还没有行程</div>
        <div class="schedule-empty-sub">点「生成本周」按周规划（出差可跨多天）</div>
      </div>`;
    return;
  }
  list.innerHTML = `<div class="schedule-timeline">${_charItems.map((it, idx) => {
    const status = getItemStatus(it, _charItems, idx, _schedDate);
    const statusClass = `schedule-item--${status}`;
    return `
      <div class="schedule-item ${statusClass}">
        ${renderTimeCol(it)}
        <div class="schedule-card">
          <div class="schedule-card-head">
            <div class="schedule-activity">${escapeHtml(it.activity)}</div>
            <span class="schedule-status-badge schedule-status-badge--${status}">${STATUS_LABELS[status]}</span>
          </div>
        </div>
      </div>`;
  }).join('')}</div>`;
}

function renderUserNoteBlock(it, idx, status) {
  const note = String(it.thought || '').trim();
  if (note) {
    return `
      <div class="schedule-review schedule-review--done schedule-review--user" onclick="event.stopPropagation()">
        <div class="schedule-review-label">备注</div>
        <div class="schedule-review-text" id="sched-user-note-text-${idx}">${escapeHtml(note)}</div>
        <button type="button" class="schedule-review-edit" title="编辑" onclick="event.stopPropagation(); toggleUserNoteEdit(${idx})">✎</button>
        <textarea class="input schedule-review-input" id="sched-user-note-input-${idx}" style="display:none"
          rows="2" placeholder="给自己留的小备注…"
          onchange="updateUserNote(${idx}, this.value)"
          onblur="onUserNoteBlur(${idx})">${escapeHtml(note)}</textarea>
      </div>`;
  }
  if (status === 'upcoming' || status === 'now') {
    return `<button type="button" class="schedule-note-add" onclick="event.stopPropagation(); openUserScheduleEditor(${idx})">+ 添加备注</button>`;
  }
  return '';
}

function renderUserTimeline() {
  const list = document.getElementById('sched-user-list');
  if (!list) return;
  const dateLabel = _schedDate === localDateStr() ? '今天' : '这天';
  if (!_userItems.length) {
    list.innerHTML = `
      <div class="schedule-empty">
        <div class="schedule-empty-icon">📒</div>
        <div>${dateLabel}还没安排</div>
        <div class="schedule-empty-sub">添加开会、健身、约会…角色会知道的</div>
        <button type="button" class="btn btn-primary btn-sm" style="margin-top:12px" onclick="openUserScheduleEditor()">添加第一项</button>
      </div>`;
    return;
  }
  list.innerHTML = `<div class="schedule-timeline schedule-timeline--user">${_userItems.map((it, idx) => {
    const status = getUserItemStatus(it, _userItems, idx, _schedDate);
    return `
    <div class="schedule-item schedule-item--user schedule-item--${status}">
      ${renderTimeCol(it, true)}
      <div class="schedule-card schedule-card--user" onclick="openUserScheduleEditor(${idx})">
        <div class="schedule-card-head">
          <div class="schedule-activity">${escapeHtml(it.activity)}</div>
          <span class="schedule-status-badge schedule-status-badge--${status} schedule-status-badge--user">${STATUS_LABELS[status]}</span>
        </div>
        ${renderUserNoteBlock(it, idx, status)}
        <div class="schedule-card-foot" onclick="event.stopPropagation()">
          <button type="button" class="schedule-card-action" title="编辑" onclick="openUserScheduleEditor(${idx})">✎ 编辑</button>
          <button type="button" class="schedule-card-action schedule-card-action--danger" title="删除" onclick="deleteUserItem(${idx})">🗑 删除</button>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

window.toggleUserNoteEdit = function(idx) {
  const text = document.getElementById(`sched-user-note-text-${idx}`);
  const input = document.getElementById(`sched-user-note-input-${idx}`);
  const btn = text?.closest('.schedule-review')?.querySelector('.schedule-review-edit');
  if (!text || !input) return;
  const editing = input.style.display !== 'none';
  if (editing) {
    input.style.display = 'none';
    text.style.display = '';
    text.textContent = _userItems[idx]?.thought || '';
    if (btn) btn.textContent = '编辑';
  } else {
    text.style.display = 'none';
    input.style.display = '';
    input.focus();
    if (btn) btn.textContent = '收起';
  }
};

window.updateUserNote = function(idx, val) {
  if (!_userItems[idx]) return;
  _userItems[idx].thought = val.trim();
};

window.onUserNoteBlur = async function(idx) {
  await saveUserSchedule();
  renderUserTimeline();
};

window.saveUserSchedule = async function() {
  try {
    await api.saveSchedule({ role: 'user', date: _schedDate, items: _userItems });
  } catch (e) { window.showToast?.(e.message); }
};

window.generateCharSchedule = async function() {
  if (!_schedCharId || _generating) return;
  _generating = true;
  const btn = document.getElementById('sched-gen-btn');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    const isToday = _schedDate === localDateStr();
    const force = _charItems.length > 0;
    // 当天只看今天，非当天按周规划
    const scope = isToday ? 'day' : 'week';
    const data = await api.generateSchedule(_schedCharId, { date: _schedDate, force, scope });
    _charItems = sortScheduleItemsByTime((data.items || []).map(normalizeItem));
    _charGenerated = true;
    const filled = (data.weekDays || []).filter((d) => (d.count || 0) > 0 && !d.skipped).length;
    const skipped = (data.weekDays || []).filter((d) => d.skipped).length;
    const arc = data.weekPlan?.arc ? `：${data.weekPlan.arc}` : '';
    window.showToast?.(
      isToday
        ? (_charItems.length > 0 ? '今日行程已生成' : '生成失败，请检查 API')
        : (filled || skipped
          ? `本周已规划${arc}${filled ? `，新填 ${filled} 天` : ''}${skipped ? `，跳过 ${skipped} 天` : ''}`
          : '行程已生成')
    );
    window.notifyMonitorScheduleUpdated?.({ characterId: _schedCharId, date: _schedDate });
    await loadCharSchedule();
  } catch (e) {
    window.showToast?.(e.message || '生成失败');
  } finally {
    _generating = false;
    updateCharToolbar();
  }
};

window.openUserScheduleEditor = function(editIdx = null) {
  const existing = editIdx != null ? _userItems[editIdx] : null;
  document.getElementById('sched-user-edit-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'sched-user-edit-overlay';
  overlay.className = 'overlay center active';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="modal schedule-edit-modal" onclick="event.stopPropagation()">
      <div class="modal-title">${existing ? '编辑安排' : '添加安排'}</div>
      <div class="modal-body">
        <div class="form-group">
          <label class="input-label">时间</label>
          <input type="time" class="input" id="sched-edit-time" value="${escapeHtml(existing?.time || '09:00')}">
        </div>
        <div class="form-group">
          <label class="input-label">做什么</label>
          <input class="input" id="sched-edit-activity" placeholder="如：下午开会、晚上健身"
            value="${escapeHtml(existing?.activity || '')}">
        </div>
        <div class="form-group">
          <label class="input-label">备注（可选）</label>
          <input class="input" id="sched-edit-note" placeholder="给自己留的小备注"
            value="${escapeHtml(existing?.thought || '')}">
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('sched-user-edit-overlay').remove()">取消</button>
        <button type="button" class="btn btn-primary" onclick="confirmUserScheduleEdit(${editIdx != null ? editIdx : 'null'})">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
};

window.confirmUserScheduleEdit = async function(editIdx) {
  const time = document.getElementById('sched-edit-time')?.value || '';
  const activity = document.getElementById('sched-edit-activity')?.value?.trim() || '';
  const thought = document.getElementById('sched-edit-note')?.value?.trim() || '';
  if (!activity) { window.showToast?.('请填写活动内容'); return; }
  const item = normalizeItem({ time, activity, thought });
  if (editIdx != null) _userItems[editIdx] = item;
  else _userItems.push(item);
  _userItems.sort((a, b) => (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999));
  document.getElementById('sched-user-edit-overlay')?.remove();
  await saveUserSchedule();
  renderUserTimeline();
};

window.deleteUserItem = async function(idx) {
  if (!confirm('删除这项安排？')) return;
  _userItems.splice(idx, 1);
  await saveUserSchedule();
  renderUserTimeline();
};

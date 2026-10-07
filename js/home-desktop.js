/* ===== 主页 iOS 风格图标桌面（网格 + 底栏 + 小组件） ===== */

/** 与通讯底栏同款：细描边 SVG */
const I = (path) =>
  `<svg class="home-icon-svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

export const HOME_APPS = [
  { key: 'diary',    name: '秘密', page: 'diary',
    icon: I('<path d="M7 3.5h8.5A2.5 2.5 0 0 1 18 6v14.2l-4.2-2.2L9.5 20.2V6A2.5 2.5 0 0 1 12 3.5"/><path d="M9.5 8h5M9.5 11.5h5"/>') },
  { key: 'ta',       name: 'TA', page: 'ta',
    icon: I('<path d="M12 20s-6.5-4.1-6.5-9a3.6 3.6 0 0 1 6.5-2.1A3.6 3.6 0 0 1 18.5 11c0 4.9-6.5 9-6.5 9z"/>') },
  { key: 'dream',    name: '梦境', page: 'dream',
    icon: I('<path d="M15.5 4.2A7.2 7.2 0 1 0 20 14.2 5.6 5.6 0 0 1 15.5 4.2z"/>') },
  { key: 'chat',     name: '通讯', page: 'contacts',
    icon: I('<path d="M4 12c0-4.4 3.8-8 8.5-8S21 7.6 21 12s-3.8 8-8.5 8c-1.1 0-2.2-.2-3.2-.6L4 21l1.4-3.8C4.5 15.9 4 14 4 12z"/>') },
  { key: 'reader',   name: '阅读', page: 'reader',
    icon: I('<path d="M4 5.5h6.2A3.3 3.3 0 0 1 13.5 8.8V19a2.4 2.4 0 0 0-2.2-1.3H4z"/><path d="M20 5.5h-6.2A3.3 3.3 0 0 0 10.5 8.8V19a2.4 2.4 0 0 1 2.2-1.3H20z"/>') },
  { key: 'schedule', name: '日历', page: 'schedule',
    icon: I('<rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M8 3.5v3.2M16 3.5v3.2M3.5 10h17"/>') },
  { key: 'album',    name: '相册', page: 'album',
    icon: I('<rect x="3.5" y="5.5" width="17" height="13.5" rx="2.2"/><circle cx="9" cy="10.5" r="1.6"/><path d="m7.5 16.5 3.2-3.4 2.4 2.4 2.8-3.2 3.1 4.2"/>') },
  { key: 'photostudio', name: '写真馆', page: 'photostudio',
    icon: I('<path d="M4.5 8.2h3.2l1.2-1.7h6.2l1.2 1.7h3.2v10.3H4.5z"/><circle cx="12" cy="13.2" r="3.2"/><path d="M17.2 9.6h.01"/>') },
  { key: 'wardrobe', name: '衣柜', page: 'wardrobe',
    icon: I('<path d="M5 4.5h14v15.5H5z"/><path d="M12 4.5v15.5"/><path d="M9.2 11.2a1.3 1.3 0 1 0 0 2.6"/><path d="M14.8 11.2a1.3 1.3 0 1 1 0 2.6"/><path d="M5 7.2h14"/>') },
  { key: 'monitor',  name: '监控', page: 'monitor',
    icon: I('<path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h8.6a2.2 2.2 0 0 1 2.2 2.2v6.6a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/><path d="m16.5 10.2 4 2.3-4 2.3z"/><path d="M8 19.5h5"/>') },
  { key: 'series',   name: '时空', page: 'series',
    icon: I('<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4M3.8 12h16.4"/><path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>') },
  { key: 'postoffice', name: '哆啦邮局', page: 'postoffice',
    icon: I('<path d="M4 7.5h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 7.5 12 13l8-5.5"/><path d="M8 4.5h8v3H8z"/>') },
  { key: 'games',    name: '游戏', page: 'games',
    icon: I('<path d="M7.2 9.2h9.6a4.2 4.2 0 0 1 4 5.4l-.6 2a3.2 3.2 0 0 1-3.1 2.3H6.9a3.2 3.2 0 0 1-3.1-2.3l-.6-2a4.2 4.2 0 0 1 4-5.4z"/><path d="M8.2 12.2v3.2M6.6 13.8h3.2M15.2 12.8h.1M17.2 14.6h.1"/>') },
  { key: 'robot',    name: 'toy', page: 'robot',
    icon: I('<rect x="6" y="8" width="12" height="10" rx="2.4"/><path d="M12 4.5v3.5M9 18v2M15 18v2M9.5 12.2h.1M14.5 12.2h.1"/>') },
  { key: 'mcp',      name: 'MCP', page: 'mcp',
    icon: I('<path d="M8 7h8v10H8z"/><path d="M10 10h4M10 13h4"/><path d="M4.5 9.5 7 12l-2.5 2.5M19.5 9.5 17 12l2.5 2.5"/>') },
  { key: 'brain',    name: '人格', page: 'memory',
    icon: I('<circle cx="12" cy="9" r="4.2"/><path d="M6.2 19.2c.8-3.2 3-5 5.8-5s5 1.8 5.8 5"/><path d="M12 4.8V3.2M8.2 6.2 7 5M15.8 6.2 17 5"/>') },
  { key: 'circle',   name: '圈子', page: 'circle',
    icon: I('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2"/>') },
  { key: 'tieba',    name: '贴吧', page: 'tieba',
    icon: I('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 12.5h8M8 16h5"/>') },
  { key: 'manage',   name: '管理', page: 'manage',
    icon: I('<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/><circle cx="8.5" cy="7" r="1.4" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="10.5" cy="17" r="1.4" fill="currentColor" stroke="none"/>') },
  { key: 'settings', name: '设置', page: 'settings',
    icon: I('<circle cx="12" cy="12" r="3.1"/><path d="M12 3.5v2.2M12 18.3v2.2M4.8 6.5l1.6 1.6M17.6 15.9l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.8 17.5l1.6-1.6M17.6 8.1l1.6-1.6"/>') },
];

/** 小组件目录：w/h 为网格格数 */
export const HOME_WIDGETS = [
  { type: 'clock',     name: '时钟',   desc: '多种样式可选', icon: '🕐', w: 2, h: 2 },
  { type: 'calendar',  name: '日历',   desc: '多种样式可选', icon: '📆', w: 2, h: 2 },
  { type: 'weather',   name: '天气',   desc: '所在地实况',   icon: '🌤️', w: 2, h: 2 },
  { type: 'photo',     name: '相册',   desc: '先调大小再裁剪添加', icon: '🖼️', w: 2, h: 2 },
  { type: 'character', name: '角色',   desc: '状态与心情',   icon: '✨', w: 2, h: 2 },
  { type: 'schedule',  name: '今日日程', desc: '接下来的安排', icon: '🗓️', w: 4, h: 2 },
  { type: 'notes',     name: '便签',   desc: '随手记一笔',   icon: '📝', w: 2, h: 2 },
];

const CLOCK_STYLES = [
  { id: 'classic', name: '经典', desc: '大时间 + 日期' },
  { id: 'analog',  name: '表盘', desc: '圆盘指针钟' },
  { id: 'poster',  name: '竖塔', desc: '时分上下叠' },
  { id: 'minimal', name: '极简', desc: '只显示时间' },
  { id: 'stack',   name: '叠层', desc: '日期在上' },
  { id: 'digital', name: '数码', desc: '等宽数字' },
  { id: 'glass',   name: '玻璃', desc: '磨砂胶囊' },
];

const CALENDAR_STYLES = [
  { id: 'classic', name: '经典', desc: '居中日期' },
  { id: 'month',   name: '月历', desc: '当月日期格' },
  { id: 'minimal', name: '极简', desc: '大数字侧栏' },
  { id: 'card', name: '卡片', desc: '色条标题' },
  { id: 'week', name: '周历', desc: '一周条带' },
  { id: 'circle', name: '圆环', desc: '日期圆盘' },
  { id: 'gradient', name: '渐变', desc: '主题色底' },
  { id: 'sidebar', name: '侧栏', desc: '竖条强调' },
  { id: 'poster', name: '海报', desc: '大字排版' },
];

const WEATHER_STYLES = [
  { id: 'classic', name: '经典', desc: '图标与温度' },
  { id: 'compact', name: '紧凑', desc: '单行概览' },
  { id: 'banner', name: '横幅', desc: '渐变色带' },
  { id: 'detail', name: '详情', desc: '体感与高低温' },
];

const WIDGET_MAP = Object.fromEntries(HOME_WIDGETS.map(w => [w.type, w]));
const APP_MAP = Object.fromEntries(HOME_APPS.map(a => [a.key, a]));
const DEFAULT_DOCK = ['diary', 'dream', 'chat', 'reader', 'schedule'];
const DEFAULT_GRID = ['ta', 'brain', 'circle', 'tieba', 'album', 'photostudio', 'wardrobe', 'monitor', 'series', 'postoffice', 'games', 'robot', 'mcp', 'manage', 'settings'];
const DOCK_SLOTS = 5;
const LONG_PRESS_MS = 420;
const PAGE_EDGE_PX = 48;

/** @type {(string|null)[]} */
let _grid = [];
/** @type {(string|null)[]} */
let _dock = [];
/** @type {Array<{id:string,type:string,page:number,col:number,row:number,w:number,h:number,text?:string}>} */
let _widgets = [];
let _pageIndex = 0;
let _editMode = false;
let _inited = false;
let _sheetMode = 'menu'; // menu | widgets
let _openFolderId = null;

let _pressTimer = null;
let _pressStart = null;
let _drag = null; // icon drag or widget drag
let _resize = null; // widget resize
let _swipe = null;
/** @type {Map<string, {at:number, data:object}>} */
const _weatherCache = new Map();
const WEATHER_CACHE_TTL_MS = 20 * 60 * 1000;
let _calendarStyleCallback = null;
let _calendarStyleWidgetId = null;

function getGridSize() {
  const n = parseInt(localStorage.getItem('beautify_home_grid') || '4', 10);
  return [4, 5, 6, 7].includes(n) ? n : 4;
}

function slotsPerPage() {
  const n = getGridSize();
  return n * n;
}

function normalizeKey(key) {
  return APP_MAP[key] ? key : null;
}

function folderUid() {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function isFolder(val) {
  return !!(val && typeof val === 'object' && val.type === 'folder' && Array.isArray(val.items));
}

function slotAppKey(val) {
  return typeof val === 'string' && APP_MAP[val] ? val : null;
}

function normalizeSlot(val) {
  if (!val) return null;
  if (typeof val === 'string') return normalizeKey(val);
  if (!isFolder(val)) return null;
  const items = [];
  for (const k of val.items || []) {
    const key = normalizeKey(k);
    if (key && !items.includes(key)) items.push(key);
  }
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  const name = typeof val.name === 'string' ? val.name.trim().slice(0, 12) : '';
  return {
    type: 'folder',
    id: String(val.id || folderUid()),
    name: name || '文件夹',
    items,
  };
}

function uid() {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function collectPresent(grid, dock = []) {
  const seen = new Set();
  for (const k of [...dock, ...grid]) {
    if (slotAppKey(k)) seen.add(k);
    else if (isFolder(k)) {
      for (const item of k.items) {
        if (APP_MAP[item]) seen.add(item);
      }
    }
  }
  return seen;
}

function ensureAllApps(grid, dock) {
  const seen = collectPresent(grid, dock);
  const missing = HOME_APPS.map(a => a.key).filter(k => !seen.has(k));
  if (!missing.length) return { grid, dock };
  const nextGrid = [...grid];
  for (const key of missing) {
    const empty = nextGrid.findIndex(s => !s);
    if (empty >= 0) nextGrid[empty] = key;
    else nextGrid.push(key);
  }
  return { grid: nextGrid, dock };
}

function getMinPageCount() {
  const n = parseInt(localStorage.getItem('beautify_home_min_pages') || '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function setMinPageCount(n) {
  localStorage.setItem('beautify_home_min_pages', String(Math.max(1, Math.floor(n) || 1)));
}

function pageHasContent(page, grid = _grid, widgets = _widgets) {
  const per = slotsPerPage();
  const base = page * per;
  for (let i = 0; i < per; i++) {
    if (grid[base + i]) return true;
  }
  return widgets.some(w => w.page === page);
}

function padGridToPages(grid, widgets = _widgets) {
  const per = slotsPerPage();
  const next = [...grid];
  const usedIcons = next.reduce((n, k) => n + (k ? 1 : 0), 0);
  const maxWidgetPage = widgets.reduce((m, w) => Math.max(m, w.page || 0), -1);
  // 编辑 / 拖拽中保留空白页；另外尊重用户「新建桌面」锁定的最少页数
  const keepEmpty = _editMode || !!_drag || !!_resize;
  const minPages = Math.max(
    1,
    Math.ceil(usedIcons / per) || 1,
    maxWidgetPage + 1,
    keepEmpty ? Math.ceil(next.length / per) || 1 : 1,
    getMinPageCount(),
  );
  const want = minPages * per;
  while (next.length < want) next.push(null);
  while (next.length % per !== 0) next.push(null);

  if (!keepEmpty) {
    // 去掉末尾完全空页，但不少于 minPages（含用户新建的桌面）
    while (next.length > minPages * per) {
      const page = next.length / per - 1;
      if (page !== Math.floor(page)) break;
      const tail = next.slice(next.length - per);
      const hasWidget = widgets.some(w => w.page === page);
      if (!hasWidget && tail.every(s => !s)) next.length -= per;
      else break;
    }
  }
  return next;
}

function migrateLegacyOrder(raw) {
  if (!Array.isArray(raw)) return null;
  const keys = raw.filter(k => APP_MAP[k]);
  if (!keys.length) return null;
  const dock = DEFAULT_DOCK.map(k => (keys.includes(k) ? k : null));
  const dockSet = new Set(dock.filter(Boolean));
  const grid = keys.filter(k => !dockSet.has(k));
  return { dock, grid };
}

function loadWidgets() {
  try {
    const raw = JSON.parse(localStorage.getItem('beautify_home_widgets') || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(w => {
      const def = WIDGET_MAP[w?.type];
      if (!def) return null;
      const n = getGridSize();
      const ww = Math.max(1, Math.min(n, Number(w.w) || def.w));
      const hh = Math.max(1, Math.min(n, Number(w.h) || def.h));
      return {
        id: String(w.id || uid()),
        type: def.type,
        page: Math.max(0, Number(w.page) || 0),
        col: Math.max(0, Math.min(n - ww, Number(w.col) || 0)),
        row: Math.max(0, Math.min(n - hh, Number(w.row) || 0)),
        w: ww,
        h: hh,
        text: typeof w.text === 'string' ? w.text : '',
        imageUrl: typeof w.imageUrl === 'string' ? w.imageUrl : '',
        bgUrl: def.type === 'calendar' && typeof w.bgUrl === 'string' ? w.bgUrl : '',
        calStyle: def.type === 'calendar' && CALENDAR_STYLES.some(s => s.id === w.calStyle) ? w.calStyle : 'classic',
        clockStyle: def.type === 'clock' && CLOCK_STYLES.some(s => s.id === w.clockStyle) ? w.clockStyle : 'classic',
        weatherPlace: def.type === 'weather' && typeof w.weatherPlace === 'string' ? w.weatherPlace : '',
        weatherStyle: def.type === 'weather' && WEATHER_STYLES.some(s => s.id === w.weatherStyle) ? w.weatherStyle : 'classic',
        opacity: Math.max(0.12, Math.min(1, Number(w.opacity) || 1)),
        textColor: ['auto', 'light', 'dark'].includes(w.textColor) ? w.textColor : 'auto',
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function firstFreeGridIndex(grid) {
  const occ = occupiedSlotSet();
  const len = Math.max(grid.length, slotsPerPage());
  for (let i = 0; i < len; i++) {
    if (!grid[i] && !occ.has(i)) return i;
  }
  return -1;
}

/** 底栏被清空过时，把默认五枚从桌面格里抽回底栏 */
function reclaimDock(grid, dock) {
  if ((dock || []).some(Boolean)) return { grid, dock };
  const present = collectPresent(grid, []);
  const nextGrid = [...grid];
  const nextDock = Array.from({ length: DOCK_SLOTS }, () => null);
  DEFAULT_DOCK.forEach((key, i) => {
    const idx = nextGrid.findIndex(s => slotAppKey(s) === key);
    if (idx >= 0) {
      nextDock[i] = nextGrid[idx];
      nextGrid[idx] = null;
    } else if (!present.has(key)) {
      nextDock[i] = key;
    }
  });
  return { grid: nextGrid, dock: nextDock };
}

function loadLayout() {
  _widgets = loadWidgets();
  try {
    const dockRaw = JSON.parse(localStorage.getItem('beautify_home_dock') || 'null');
    const gridRaw = JSON.parse(localStorage.getItem('beautify_home_grid_slots') || 'null');
    if (Array.isArray(dockRaw) || Array.isArray(gridRaw)) {
      let dock = Array.isArray(dockRaw) ? dockRaw.map(k => normalizeSlot(k)) : [...DEFAULT_DOCK];
      while (dock.length < DOCK_SLOTS) dock.push(null);
      dock = dock.slice(0, DOCK_SLOTS);
      let grid = Array.isArray(gridRaw) ? gridRaw.map(k => normalizeSlot(k)) : [...DEFAULT_GRID];
      ({ grid, dock } = reclaimDock(grid, dock));
      ({ grid, dock } = ensureAllApps(grid, dock));
      return { dock, grid: padGridToPages(grid, _widgets) };
    }
    const legacy = migrateLegacyOrder(JSON.parse(localStorage.getItem('beautify_home_order') || 'null'));
    if (legacy) {
      let { dock, grid } = ensureAllApps(legacy.grid, legacy.dock);
      ({ grid, dock } = reclaimDock(grid, dock));
      return { dock, grid: padGridToPages(grid, _widgets) };
    }
  } catch {}
  return { dock: [...DEFAULT_DOCK], grid: padGridToPages([...DEFAULT_GRID], _widgets) };
}

function saveLayout() {
  localStorage.setItem('beautify_home_dock', JSON.stringify(_dock));
  localStorage.setItem('beautify_home_grid_slots', JSON.stringify(_grid));
  localStorage.setItem('beautify_home_widgets', JSON.stringify(_widgets));
  setMinPageCount(Math.max(getMinPageCount(), pageCount()));
}

function pageCount() {
  return Math.max(1, Math.ceil(_grid.length / slotsPerPage()));
}

function clampPage(i) {
  return Math.max(0, Math.min(pageCount() - 1, i));
}

function getAppNames() {
  try { return JSON.parse(localStorage.getItem('beautify_app_names') || '{}'); } catch { return {}; }
}

function getAppIcons() {
  try { return JSON.parse(localStorage.getItem('beautify_app_icons') || '{}'); } catch { return {}; }
}

function hideLabels() {
  return localStorage.getItem('beautify_hide_labels') === '1';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function displayName(app) {
  const names = getAppNames();
  const legacy = app.key === 'album' ? names.worldbook : app.key === 'manage' ? names.preset : null;
  return names[app.key] || legacy || app.name;
}

function widgetSlotIndices(w, n = getGridSize()) {
  const per = n * n;
  const base = w.page * per;
  const slots = [];
  for (let r = 0; r < w.h; r++) {
    for (let c = 0; c < w.w; c++) {
      slots.push(base + (w.row + r) * n + (w.col + c));
    }
  }
  return slots;
}

function occupiedSlotSet(exceptId = null) {
  const set = new Set();
  for (const w of _widgets) {
    if (exceptId && w.id === exceptId) continue;
    for (const s of widgetSlotIndices(w)) set.add(s);
  }
  return set;
}

function originSlotOfWidget(w, n = getGridSize()) {
  return w.page * n * n + w.row * n + w.col;
}

function evacuateIconsFromSlots(slotList) {
  const freeTargets = [];
  const occ = occupiedSlotSet();
  for (let i = 0; i < Math.max(_grid.length, slotsPerPage()); i++) {
    if (!_grid[i] && !occ.has(i) && !slotList.includes(i)) freeTargets.push(i);
  }
  for (const s of slotList) {
    const key = _grid[s];
    if (!key) continue;
    _grid[s] = null;
    let dest = freeTargets.shift();
    if (dest == null) {
      dest = _grid.length;
      _grid.push(null);
      while (_grid.length % slotsPerPage() !== 0) _grid.push(null);
      freeTargets.push(...Array.from({ length: slotsPerPage() }, (_, i) => _grid.length - slotsPerPage() + i).filter(i => i !== dest && !_grid[i]));
    }
    while (_grid.length <= dest) _grid.push(null);
    _grid[dest] = key;
  }
}

function findFreeRect(page, w, h, exceptId = null) {
  const n = getGridSize();
  const per = n * n;
  const occ = occupiedSlotSet(exceptId);
  for (let row = 0; row <= n - h; row++) {
    for (let col = 0; col <= n - w; col++) {
      let ok = true;
      for (let r = 0; r < h && ok; r++) {
        for (let c = 0; c < w; c++) {
          const idx = page * per + (row + r) * n + (col + c);
          if (occ.has(idx) || _grid[idx]) { ok = false; break; }
        }
      }
      if (ok) return { page, col, row };
    }
  }
  return null;
}

function widgetFits(trial, exceptId = null) {
  const n = getGridSize();
  if (trial.w < 1 || trial.h < 1) return false;
  if (trial.col < 0 || trial.row < 0 || trial.col + trial.w > n || trial.row + trial.h > n) return false;
  const occ = occupiedSlotSet(exceptId);
  for (const s of widgetSlotIndices(trial)) {
    if (occ.has(s)) return false;
    if (_grid[s]) return false;
  }
  return true;
}

function getGridMetrics(page) {
  const gridEl = document.querySelector(`.home-page-sheet[data-page="${page}"] .home-page-grid`);
  if (!gridEl) return null;
  const rect = gridEl.getBoundingClientRect();
  const n = getGridSize();
  return { rect, n, cellW: rect.width / n, cellH: rect.height / n };
}

function computeResizeFromPoint(x, y, widget, axis) {
  const m = getGridMetrics(widget.page);
  if (!m) return null;
  const { rect, n, cellW, cellH } = m;
  const originX = rect.left + widget.col * cellW;
  const originY = rect.top + widget.row * cellH;
  let w = widget.w;
  let h = widget.h;
  if (axis === 'e' || axis === 'se') {
    w = Math.max(1, Math.min(n - widget.col, Math.ceil((x - originX) / cellW) || 1));
  }
  if (axis === 's' || axis === 'se') {
    h = Math.max(1, Math.min(n - widget.row, Math.ceil((y - originY) / cellH) || 1));
  }
  return { w, h };
}

function applyWidgetGridStyle(id) {
  const w = _widgets.find(x => x.id === id);
  const el = document.querySelector(`.home-widget[data-widget-id="${CSS.escape(id)}"]`);
  if (!w || !el) return;
  el.style.gridColumn = `${w.col + 1} / span ${w.w}`;
  el.style.gridRow = `${w.row + 1} / span ${w.h}`;
  const tag = el.querySelector('.home-widget-size-tag');
  if (tag) tag.textContent = `${w.w}×${w.h}`;
}

function ensurePageExists(page) {
  const per = slotsPerPage();
  const want = (page + 1) * per;
  while (_grid.length < want) _grid.push(null);
}

/* ─── render ─── */
function iconBadgesHtml(key, { badge = true } = {}) {
  if (!badge) return '';
  if (key === 'chat') {
    return '<span class="home-nav-badge home-badge--container home-chat-badge" id="home-chat-badge"></span>';
  }
  return '';
}

function iconInnerHtml(app, { badge = true } = {}) {
  const icons = getAppIcons();
  const url = icons[app.key] || (app.key === 'album' ? icons.worldbook : app.key === 'manage' ? icons.preset : null);
  const isSvg = String(app.icon || '').includes('<svg');
  const inner = url
    ? `<img src="${esc(url)}" alt="">`
    : isSvg
      ? `<span class="home-icon-glyph">${app.icon}</span>`
      : `<span class="home-icon-emoji">${esc(app.icon)}</span>`;
  return `<span class="home-icon-hit">
    <span class="home-icon-face${isSvg && !url ? ' home-icon-face--line' : ''}" data-icon-key="${esc(app.key)}" data-default-icon="${isSvg ? '' : esc(app.icon)}">${inner}</span>
    ${iconBadgesHtml(app.key, { badge })}
  </span>`;
}

function folderContainsChat(folder) {
  return isFolder(folder) && folder.items.includes('chat');
}

function miniIconHtml(key) {
  const app = APP_MAP[key];
  if (!app) return `<span class="home-folder-mini"></span>`;
  const icons = getAppIcons();
  const url = icons[app.key] || (app.key === 'album' ? icons.worldbook : app.key === 'manage' ? icons.preset : null);
  if (url) return `<span class="home-folder-mini"><img src="${esc(url)}" alt=""></span>`;
  if (String(app.icon || '').includes('<svg')) {
    return `<span class="home-folder-mini home-folder-mini--line">${app.icon}</span>`;
  }
  return `<span class="home-folder-mini">${esc(app.icon)}</span>`;
}

function renderFolder(folder, zone, slotIndex) {
  const labelHidden = hideLabels() ? ' style="display:none"' : '';
  const jiggle = _editMode ? ' jiggling' : '';
  const delay = Math.floor(Math.random() * 180);
  const minis = Array.from({ length: 9 }, (_, i) => miniIconHtml(folder.items[i])).join('');
  const badges = folderContainsChat(folder)
    ? '<span class="home-nav-badge home-badge--container home-chat-badge" id="home-chat-badge"></span>'
    : '';
  return `
    <div class="home-icon-slot" data-zone="${zone}" data-slot="${slotIndex}">
      <button type="button" class="home-icon home-icon--folder${jiggle}" data-folder-id="${esc(folder.id)}"
        data-zone="${zone}" data-slot="${slotIndex}"
        style="--jiggle-delay:${delay}"
        aria-label="${esc(folder.name)}">
        <span class="home-icon-hit">
          <span class="home-icon-face home-folder-face">${minis}</span>
          ${badges}
        </span>
        <span class="home-icon-label"${labelHidden}>${esc(folder.name)}</span>
      </button>
    </div>`;
}

function renderSlot(val, zone, slotIndex) {
  if (isFolder(val)) return renderFolder(val, zone, slotIndex);
  return renderIcon(slotAppKey(val), zone, slotIndex);
}

function renderIcon(key, zone, slotIndex) {
  if (!key || !APP_MAP[key]) {
    return `<div class="home-icon-slot" data-zone="${zone}" data-slot="${slotIndex}"></div>`;
  }
  const app = APP_MAP[key];
  const labelHidden = hideLabels() ? ' style="display:none"' : '';
  const jiggle = _editMode ? ' jiggling' : '';
  const delay = Math.floor(Math.random() * 180);
  return `
    <div class="home-icon-slot" data-zone="${zone}" data-slot="${slotIndex}">
      <button type="button" class="home-icon${jiggle}" data-app-key="${esc(key)}"
        data-zone="${zone}" data-slot="${slotIndex}"
        style="--jiggle-delay:${delay}"
        aria-label="${esc(displayName(app))}">
        ${iconInnerHtml(app)}
        <span class="home-icon-label" data-nav-key="${esc(key)}"${labelHidden}>${esc(displayName(app))}</span>
      </button>
    </div>`;
}

function migrateFloatPercent(rawTop, rawLeft) {
  // 旧版百分比相对顶部约 132px 窄带；现改为相对整页
  const band = 132;
  const sheet = document.querySelector('.home-page-sheet--home');
  const sheetH = Math.max(band + 80, sheet?.clientHeight || window.innerHeight || 700);
  const sheetW = Math.max(200, sheet?.clientWidth || window.innerWidth || 390);
  const topPx = (Number(rawTop) / 100) * band;
  const leftPx = (Number(rawLeft) / 100) * sheetW;
  return {
    left: Math.max(0, Math.min(86, (leftPx / sheetW) * 100)),
    top: Math.max(0, Math.min(88, (topPx / sheetH) * 100)),
  };
}

function getHeaderClockConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem('beautify_home_header_clock') || '{}');
    const style = CLOCK_STYLES.some(s => s.id === raw.style) ? raw.style : 'classic';
    let left = Number.isFinite(Number(raw.left)) ? Number(raw.left) : 4;
    let top = Number.isFinite(Number(raw.top)) ? Number(raw.top) : 3.5;
    if (raw.posV !== 2 && (raw.left != null || raw.top != null)) {
      const m = migrateFloatPercent(top, left);
      left = m.left;
      top = m.top;
      try {
        localStorage.setItem('beautify_home_header_clock', JSON.stringify({
          ...raw, left, top, posV: 2, style, hidden: !!raw.hidden,
        }));
      } catch {}
    }
    return {
      hidden: !!raw.hidden,
      style,
      left: Math.max(0, Math.min(86, left)),
      top: Math.max(0, Math.min(88, top)),
    };
  } catch {
    return { hidden: false, style: 'classic', left: 4, top: 3.5 };
  }
}

function saveHeaderClockConfig(cfg) {
  const prev = getHeaderClockConfig();
  const next = {
    hidden: cfg.hidden != null ? !!cfg.hidden : prev.hidden,
    style: CLOCK_STYLES.some(s => s.id === cfg.style) ? cfg.style : prev.style,
    left: Number.isFinite(Number(cfg.left)) ? Math.max(0, Math.min(86, Number(cfg.left))) : prev.left,
    top: Number.isFinite(Number(cfg.top)) ? Math.max(0, Math.min(88, Number(cfg.top))) : prev.top,
    posV: 2,
  };
  localStorage.setItem('beautify_home_header_clock', JSON.stringify(next));
  return next;
}

function getHeaderCharConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem('beautify_home_header_char') || '{}');
    let left = Number.isFinite(Number(raw.left)) ? Number(raw.left) : 58;
    let top = Number.isFinite(Number(raw.top)) ? Number(raw.top) : 4.5;
    if (raw.posV !== 2 && (raw.left != null || raw.top != null)) {
      const m = migrateFloatPercent(top, left);
      left = m.left;
      top = m.top;
      try {
        localStorage.setItem('beautify_home_header_char', JSON.stringify({
          ...raw, left, top, posV: 2, hidden: !!raw.hidden,
        }));
      } catch {}
    }
    return {
      hidden: !!raw.hidden,
      left: Math.max(0, Math.min(86, left)),
      top: Math.max(0, Math.min(88, top)),
    };
  } catch {
    return { hidden: false, left: 58, top: 4.5 };
  }
}

function saveHeaderCharConfig(cfg) {
  const prev = getHeaderCharConfig();
  const next = {
    hidden: cfg.hidden != null ? !!cfg.hidden : prev.hidden,
    left: Number.isFinite(Number(cfg.left)) ? Math.max(0, Math.min(86, Number(cfg.left))) : prev.left,
    top: Number.isFinite(Number(cfg.top)) ? Math.max(0, Math.min(88, Number(cfg.top))) : prev.top,
    posV: 2,
  };
  localStorage.setItem('beautify_home_header_char', JSON.stringify(next));
  return next;
}

/* ─── 已添加小组件的全局外观（编辑栏「设置」） ─── */
const HW_CHROME_KEY = 'beautify_home_widget_chrome';

function normalizeWidgetEffect(effect) {
  if (effect === 'frosted' || effect === 'none') return effect;
  return 'glass';
}

function normalizeWidgetTextColor(v) {
  return v === 'light' || v === 'dark' ? v : 'auto';
}

function getWidgetChrome() {
  try {
    const raw = JSON.parse(localStorage.getItem(HW_CHROME_KEY) || '{}');
    const opacity = Math.max(0.15, Math.min(1, Number(raw.opacity) || 1));
    const effect = normalizeWidgetEffect(raw.effect);
    const tone = raw.tone === 'dark' ? 'dark' : 'light';
    const clarity = Math.max(0, Math.min(1, Number(raw.clarity) ?? 0.55));
    const textColor = normalizeWidgetTextColor(raw.textColor);
    return { opacity, effect, tone, clarity, textColor };
  } catch {
    return { opacity: 1, effect: 'glass', tone: 'light', clarity: 0.55, textColor: 'auto' };
  }
}

function saveWidgetChrome(partial) {
  const next = { ...getWidgetChrome(), ...partial };
  next.opacity = Math.max(0.15, Math.min(1, Number(next.opacity) || 1));
  next.effect = normalizeWidgetEffect(next.effect);
  next.tone = next.tone === 'dark' ? 'dark' : 'light';
  next.clarity = Math.max(0, Math.min(1, Number(next.clarity) ?? 0.55));
  next.textColor = normalizeWidgetTextColor(next.textColor);
  localStorage.setItem(HW_CHROME_KEY, JSON.stringify(next));
  applyWidgetChrome(next);
  return next;
}

function applyWidgetChrome(cfg = getWidgetChrome()) {
  const root = document.getElementById('home-page') || document.documentElement;
  root.style.setProperty('--hw-chrome-opacity', String(cfg.opacity.toFixed(3)));
  root.style.setProperty('--hw-chrome-clarity', String(cfg.clarity.toFixed(3)));
  root.setAttribute('data-hw-effect', cfg.effect);
  root.setAttribute('data-hw-tone', cfg.tone);
  root.setAttribute('data-hw-fg', cfg.textColor || 'auto');
}

function analogAngles(now = new Date()) {
  const s = now.getSeconds() + now.getMilliseconds() / 1000;
  const m = now.getMinutes() + s / 60;
  const h = (now.getHours() % 12) + m / 60;
  return { hour: h * 30, min: m * 6, sec: s * 6 };
}

function buildMonthCells(now) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = new Date(y, m, 1);
  start.setDate(start.getDate() - start.getDay());
  const todayKey = now.toDateString();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      day: d.getDate(),
      muted: d.getMonth() !== m,
      isToday: d.toDateString() === todayKey,
    });
  }
  return cells;
}

function nowParts() {
  const now = new Date();
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekShort = ['日', '一', '二', '三', '四', '五', '六'];
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - now.getDay() + i);
    weekDays.push({
      label: weekShort[i],
      date: d.getDate(),
      isToday: d.toDateString() === now.toDateString(),
    });
  }
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return {
    hm: `${hh}:${mm}`,
    hh,
    mm,
    dateLine: `${now.getMonth() + 1}月${now.getDate()}日`,
    week: weeks[now.getDay()],
    day: String(now.getDate()),
    month: `${now.getMonth() + 1}月`,
    year: String(now.getFullYear()),
    weekDays,
    monthCells: buildMonthCells(now),
    analog: analogAngles(now),
  };
}

function analogFaceHtml(t) {
  const a = t.analog || analogAngles();
  const ticks = Array.from({ length: 12 }, (_, i) =>
    `<span class="hw-analog-tick-wrap" style="transform:rotate(${i * 30}deg)"><span class="hw-analog-tick${i % 3 === 0 ? ' is-major' : ''}"></span></span>`
  ).join('');
  return `<div class="hw-analog" data-hw-analog>
    <div class="hw-analog-face">
      ${ticks}
      <span class="hw-analog-num hw-analog-num--12">12</span>
      <span class="hw-analog-num hw-analog-num--3">3</span>
      <span class="hw-analog-num hw-analog-num--6">6</span>
      <span class="hw-analog-num hw-analog-num--9">9</span>
      <div class="hw-analog-hand hw-analog-hand--hour" data-hw-analog-hour style="transform:rotate(${a.hour}deg)"></div>
      <div class="hw-analog-hand hw-analog-hand--min" data-hw-analog-min style="transform:rotate(${a.min}deg)"></div>
      <div class="hw-analog-hand hw-analog-hand--sec" data-hw-analog-sec style="transform:rotate(${a.sec}deg)"></div>
      <div class="hw-analog-cap"></div>
    </div>
  </div>`;
}

function renderMonthCalendar(t, preview = false) {
  const weekShort = ['日', '一', '二', '三', '四', '五', '六'];
  const cells = (t.monthCells || []).map(c =>
    `<span class="hw-cal-mday${c.muted ? ' is-muted' : ''}${c.isToday ? ' is-today' : ''}">${c.day}</span>`
  ).join('');
  return `<div class="hw-cal hw-cal--month${preview ? ' hw-cal--preview' : ''}">
    <div class="hw-cal-month-head">${t.year}年${t.month}</div>
    <div class="hw-cal-month-dows">${weekShort.map(d => `<span>${d}</span>`).join('')}</div>
    <div class="hw-cal-month-grid">${cells}</div>
  </div>`;
}

function applyAnalogHands(now = new Date()) {
  const a = analogAngles(now);
  document.querySelectorAll('[data-hw-analog]').forEach(face => {
    const hour = face.querySelector('[data-hw-analog-hour]');
    const min = face.querySelector('[data-hw-analog-min]');
    const sec = face.querySelector('[data-hw-analog-sec]');
    if (hour) hour.style.transform = `rotate(${a.hour}deg)`;
    if (min) min.style.transform = `rotate(${a.min}deg)`;
    if (sec) sec.style.transform = `rotate(${a.sec}deg)`;
  });
}

function renderClockMarkup(style, t, { preview = false, header = false } = {}) {
  const s = CLOCK_STYLES.some(x => x.id === style) ? style : 'classic';
  const rootCls = [
    header ? 'home-clock-wrap' : 'hw-clock',
    `hw-clock--${s}`,
    header ? 'home-header-clock' : '',
    preview ? 'hw-clock--preview' : '',
  ].filter(Boolean).join(' ');
  const timeCls = header ? 'home-clock' : 'hw-clock-time';
  const dateCls = header ? 'home-date' : 'hw-clock-date';
  const timeAttr = preview ? '' : (header ? '' : ' data-hw-clock');
  const dateAttr = preview ? '' : (header ? ' data-hw-clock-date' : ' data-hw-clock-date');

  if (s === 'minimal') {
    return `<div class="${rootCls}" data-clock-style="${s}">
      <div class="${timeCls}"${timeAttr}>${t.hm}</div>
    </div>`;
  }
  if (s === 'stack') {
    return `<div class="${rootCls}" data-clock-style="${s}">
      <div class="${dateCls}"${dateAttr}>${t.dateLine} ${t.week}</div>
      <div class="${timeCls}"${timeAttr}>${t.hm}</div>
    </div>`;
  }
  if (s === 'digital') {
    return `<div class="${rootCls}" data-clock-style="${s}">
      <div class="${timeCls} hw-clock-digital"${timeAttr}>${t.hm}</div>
      <div class="${dateCls}"${dateAttr}>${t.dateLine} ${t.week}</div>
    </div>`;
  }
  if (s === 'glass') {
    return `<div class="${rootCls}" data-clock-style="${s}">
      <div class="hw-clock-glass-inner">
        <div class="${timeCls}"${timeAttr}>${t.hm}</div>
        <div class="${dateCls}"${dateAttr}>${t.dateLine} ${t.week}</div>
      </div>
    </div>`;
  }
  if (s === 'analog') {
    return `<div class="${rootCls}" data-clock-style="${s}">
      ${analogFaceHtml(t)}
      <div class="${dateCls}"${dateAttr}>${t.dateLine} ${t.week}</div>
    </div>`;
  }
  if (s === 'poster') {
    return `<div class="${rootCls}" data-clock-style="${s}">
      <div class="${dateCls} hw-clock-poster-date"${dateAttr}>${t.week}</div>
      <div class="hw-clock-tower">
        <span class="hw-clock-hh" data-hw-clock-hh>${t.hh}</span>
        <span class="hw-clock-colon" aria-hidden="true"></span>
        <span class="hw-clock-mm" data-hw-clock-mm>${t.mm}</span>
      </div>
      <div class="${dateCls}"${dateAttr}>${t.dateLine}</div>
    </div>`;
  }
  return `<div class="${rootCls}" data-clock-style="${s}">
    <div class="${timeCls}"${timeAttr}>${t.hm}</div>
    <div class="${dateCls}"${dateAttr}>${t.dateLine} ${t.week}</div>
  </div>`;
}

function renderClockPreview(style) {
  return renderClockMarkup(style, nowParts(), { preview: true });
}

function renderClockBody(w) {
  return renderClockMarkup(w.clockStyle || 'classic', nowParts());
}

function renderCalendarPreview(style) {
  const t = nowParts();
  if (style === 'month') return renderMonthCalendar(t, true);
  if (style === 'minimal') {
    return `<div class="hw-cal hw-cal--minimal hw-cal--preview">
      <div class="hw-cal-day">${t.day}</div>
      <div class="hw-cal-side"><div class="hw-cal-month">${t.month}</div><div class="hw-cal-week">${t.week}</div></div>
    </div>`;
  }
  if (style === 'card') {
    return `<div class="hw-cal hw-cal--card hw-cal--preview">
      <div class="hw-cal-card-head">${t.month} · ${t.week}</div>
      <div class="hw-cal-day">${t.day}</div>
    </div>`;
  }
  if (style === 'week') {
    return `<div class="hw-cal hw-cal--week hw-cal--preview">
      <div class="hw-cal-week-strip">${t.weekDays.map(d =>
        `<span class="hw-cal-wday${d.isToday ? ' is-today' : ''}"><b>${d.label}</b><i>${d.date}</i></span>`
      ).join('')}</div>
    </div>`;
  }
  if (style === 'circle') {
    return `<div class="hw-cal hw-cal--circle hw-cal--preview">
      <div class="hw-cal-circle-ring"><span class="hw-cal-day">${t.day}</span></div>
      <div class="hw-cal-circle-meta"><span>${t.month}</span><span>${t.week}</span></div>
    </div>`;
  }
  if (style === 'gradient') {
    return `<div class="hw-cal hw-cal--gradient hw-cal--preview">
      <div class="hw-cal-day">${t.day}</div>
      <div class="hw-cal-gradient-sub">${t.month} · ${t.week}</div>
    </div>`;
  }
  if (style === 'sidebar') {
    return `<div class="hw-cal hw-cal--sidebar hw-cal--preview">
      <div class="hw-cal-sidebar-bar"></div>
      <div class="hw-cal-sidebar-body"><div class="hw-cal-day">${t.day}</div><div class="hw-cal-month">${t.month}</div></div>
    </div>`;
  }
  if (style === 'poster') {
    return `<div class="hw-cal hw-cal--poster hw-cal--preview">
      <div class="hw-cal-poster-top">${t.year} · ${t.month}</div>
      <div class="hw-cal-day">${t.day}</div>
      <div class="hw-cal-poster-week">${t.week}</div>
    </div>`;
  }
  return `<div class="hw-cal hw-cal--classic hw-cal--preview">
    <div class="hw-cal-month">${t.month}</div>
    <div class="hw-cal-day">${t.day}</div>
    <div class="hw-cal-week">${t.week}</div>
  </div>`;
}

function renderCalendarBody(w) {
  const style = w.calStyle || 'classic';
  const t = nowParts();
  if (style === 'month') return renderMonthCalendar(t);
  if (style === 'minimal') {
    return `<div class="hw-cal hw-cal--minimal">
      <div class="hw-cal-day">${t.day}</div>
      <div class="hw-cal-side">
        <div class="hw-cal-month">${t.month}</div>
        <div class="hw-cal-week">${t.week}</div>
      </div>
    </div>`;
  }
  if (style === 'card') {
    return `<div class="hw-cal hw-cal--card">
      <div class="hw-cal-card-head"><span>${t.month}</span><span>${t.week}</span></div>
      <div class="hw-cal-day">${t.day}</div>
      <div class="hw-cal-card-foot">${t.year}</div>
    </div>`;
  }
  if (style === 'week') {
    return `<div class="hw-cal hw-cal--week">
      <div class="hw-cal-week-title">${t.month} ${t.day}日</div>
      <div class="hw-cal-week-strip">${t.weekDays.map(d =>
        `<span class="hw-cal-wday${d.isToday ? ' is-today' : ''}"><b>${d.label}</b><i>${d.date}</i></span>`
      ).join('')}</div>
    </div>`;
  }
  if (style === 'circle') {
    return `<div class="hw-cal hw-cal--circle">
      <div class="hw-cal-circle-ring"><span class="hw-cal-day">${t.day}</span></div>
      <div class="hw-cal-circle-meta"><span>${t.month}</span><span>${t.week}</span></div>
    </div>`;
  }
  if (style === 'gradient') {
    return `<div class="hw-cal hw-cal--gradient">
      <div class="hw-cal-day">${t.day}</div>
      <div class="hw-cal-gradient-sub">${t.month} · ${t.week}</div>
      <div class="hw-cal-gradient-year">${t.year}</div>
    </div>`;
  }
  if (style === 'sidebar') {
    return `<div class="hw-cal hw-cal--sidebar">
      <div class="hw-cal-sidebar-bar"></div>
      <div class="hw-cal-sidebar-body">
        <div class="hw-cal-day">${t.day}</div>
        <div class="hw-cal-month">${t.month}</div>
        <div class="hw-cal-week">${t.week}</div>
      </div>
    </div>`;
  }
  if (style === 'poster') {
    return `<div class="hw-cal hw-cal--poster">
      <div class="hw-cal-poster-top">${t.year} · ${t.month}</div>
      <div class="hw-cal-day">${t.day}</div>
      <div class="hw-cal-poster-week">${t.week}</div>
    </div>`;
  }
  return `<div class="hw-cal hw-cal--classic">
    <div class="hw-cal-month">${t.month}</div>
    <div class="hw-cal-day">${t.day}</div>
    <div class="hw-cal-week">${t.week}</div>
  </div>`;
}

function wmoEmoji(code) {
  const n = Number(code);
  if (n === 0) return '☀️';
  if (n <= 3) return '🌤️';
  if (n <= 48) return '🌫️';
  if (n <= 67) return '🌧️';
  if (n <= 77) return '❄️';
  if (n <= 82) return '🌦️';
  if (n >= 95) return '⛈️';
  return '🌡️';
}

function wmoShortLabel(code) {
  const labels = {
    0: '晴', 1: '大部晴', 2: '少云', 3: '多云',
    45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '小雨', 55: '中雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    71: '小雪', 73: '中雪', 75: '大雪',
    80: '阵雨', 81: '强阵雨', 82: '暴阵雨',
    95: '雷阵雨', 96: '雷阵雨', 99: '强雷雨',
  };
  const n = Number(code);
  if (labels[n]) return labels[n];
  if (n >= 51 && n < 70) return '有雨';
  if (n >= 71 && n < 80) return '有雪';
  if (n >= 80 && n < 90) return '阵雨';
  if (n >= 95) return '雷雨';
  return '—';
}

async function resolveWeatherPlace(widget) {
  const custom = String(widget?.weatherPlace || '').trim();
  if (custom) return custom;
  try {
    const api = await import('./api.js');
    const s = await api.getSettings();
    if (String(s?.user_location || '').trim()) return String(s.user_location).trim();
  } catch {}
  const chars = window.getAppCharacters?.() || [];
  const id = window.getActiveCharId?.();
  const char = chars.find(c => Number(c.id) === Number(id)) || chars[0];
  if (String(char?.location_name || '').trim()) return String(char.location_name).trim();
  return '北京';
}

async function fetchWeatherForPlace(place) {
  const raw = String(place || '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  const cached = _weatherCache.get(key);
  if (cached && Date.now() - cached.at < WEATHER_CACHE_TTL_MS) return cached.data;

  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(raw)}&count=1&language=zh&format=json`;
    const gr = await fetch(geoUrl);
    if (!gr.ok) throw new Error(`geocode ${gr.status}`);
    const g = await gr.json();
    const first = g?.results?.[0];
    if (!first?.latitude || !first?.longitude) return null;

    const q = new URLSearchParams({
      latitude: String(first.latitude),
      longitude: String(first.longitude),
      current: 'temperature_2m,apparent_temperature,weather_code',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
      forecast_days: '1',
    });
    const wr = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (!wr.ok) throw new Error(`weather ${wr.status}`);
    const w = await wr.json();
    const cur = w.current || {};
    const code = cur.weather_code ?? w.daily?.weather_code?.[0];
    const data = {
      place: raw,
      label: [first.name, first.admin1].filter(Boolean).join(' · ') || raw,
      temp: cur.temperature_2m,
      feels: cur.apparent_temperature,
      code,
      desc: wmoShortLabel(code),
      emoji: wmoEmoji(code),
      tmin: w.daily?.temperature_2m_min?.[0],
      tmax: w.daily?.temperature_2m_max?.[0],
      precipProb: w.daily?.precipitation_probability_max?.[0],
    };
    _weatherCache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    console.warn('[home-weather]', raw, err?.message);
    return null;
  }
}

function renderWeatherPreview(style) {
  if (style === 'compact') {
    return `<div class="hw-weather hw-weather--compact hw-weather--preview">
      <span class="hw-weather-icon">🌤️</span>
      <span class="hw-weather-temp">24°</span>
      <span class="hw-weather-desc">晴</span>
    </div>`;
  }
  if (style === 'banner') {
    return `<div class="hw-weather hw-weather--banner hw-weather--preview">
      <div class="hw-weather-banner-main">
        <span class="hw-weather-icon">☀️</span>
        <span class="hw-weather-temp">24°</span>
      </div>
      <div class="hw-weather-desc">晴 · 北京</div>
    </div>`;
  }
  if (style === 'detail') {
    return `<div class="hw-weather hw-weather--detail hw-weather--preview">
      <div class="hw-weather-main">
        <div class="hw-weather-icon">🌤️</div>
        <div class="hw-weather-temp">24°</div>
      </div>
      <div class="hw-weather-detail-row"><span>体感 26°</span><span>18~28°</span></div>
      <div class="hw-weather-place">北京</div>
    </div>`;
  }
  return `<div class="hw-weather hw-weather--preview">
    <div class="hw-weather-main">
      <div class="hw-weather-icon">🌤️</div>
      <div class="hw-weather-temp">24°</div>
    </div>
    <div class="hw-weather-desc">晴</div>
  </div>`;
}

function renderWeatherBody(w) {
  const style = w.weatherStyle || 'classic';
  const cls = style === 'classic' ? '' : ` hw-weather--${style}`;
  if (style === 'compact') {
    return `<div class="hw-weather hw-weather--compact${cls}" data-hw-weather="${esc(w.id)}">
      <span class="hw-weather-icon">🌤️</span>
      <span class="hw-weather-temp">--°</span>
      <span class="hw-weather-desc">加载中…</span>
    </div>`;
  }
  if (style === 'banner') {
    return `<div class="hw-weather hw-weather--banner${cls}" data-hw-weather="${esc(w.id)}">
      <div class="hw-weather-banner-main">
        <span class="hw-weather-icon">🌤️</span>
        <span class="hw-weather-temp">--°</span>
      </div>
      <div class="hw-weather-desc">加载中…</div>
      <div class="hw-weather-place"></div>
    </div>`;
  }
  if (style === 'detail') {
    return `<div class="hw-weather hw-weather--detail${cls}" data-hw-weather="${esc(w.id)}">
      <div class="hw-weather-main">
        <div class="hw-weather-icon">🌤️</div>
        <div class="hw-weather-temp">--°</div>
      </div>
      <div class="hw-weather-detail-row">
        <span class="hw-weather-feels">体感 --°</span>
        <span class="hw-weather-range">--~--°</span>
      </div>
      <div class="hw-weather-desc">加载中…</div>
      <div class="hw-weather-place"></div>
    </div>`;
  }
  return `<div class="hw-weather${cls}" data-hw-weather="${esc(w.id)}">
    <div class="hw-weather-main">
      <div class="hw-weather-icon">🌤️</div>
      <div class="hw-weather-temp">--°</div>
    </div>
    <div class="hw-weather-desc">加载中…</div>
    <div class="hw-weather-place"></div>
  </div>`;
}

function renderWidgetBody(w) {
  if (w.type === 'clock') {
    return renderClockBody(w);
  }
  if (w.type === 'calendar') {
    return renderCalendarBody(w);
  }
  if (w.type === 'weather') {
    return renderWeatherBody(w);
  }
  if (w.type === 'character') {
    const chars = window.getAppCharacters?.() || [];
    const id = window.getActiveCharId?.();
    const char = chars.find(c => Number(c.id) === Number(id)) || chars[0];
    if (!char) {
      return `<div class="hw-char"><div class="hw-char-empty">点击设置角色</div></div>`;
    }
    const avatar = char.avatar
      ? `<img class="hw-char-avatar" src="${esc(char.avatar)}" alt="">`
      : `<div class="hw-char-avatar hw-char-avatar--ph">✨</div>`;
    const st = char.status || 'online';
    const status = st === 'busy' ? '忙碌中' : st === 'offline' ? '离线' : '在线';
    const mood = String(char.mood || '').trim();
    const loc = String(char.present_location || '').trim();
    const sub = [status, loc, mood].filter(Boolean).join(' · ');
    return `<div class="hw-char">${avatar}<div class="hw-char-meta"><div class="hw-char-name">${esc(char.name)}</div><div class="hw-char-sub">${esc(sub)}</div></div></div>`;
  }
  if (w.type === 'schedule') {
    return `<div class="hw-schedule" data-hw-schedule="${esc(w.id)}"><div class="hw-schedule-title">今日日程</div><div class="hw-schedule-list">加载中…</div></div>`;
  }
  if (w.type === 'notes') {
    const text = w.text || '';
    return `<div class="hw-notes"><div class="hw-notes-label">便签</div><textarea class="hw-notes-input" data-hw-notes="${esc(w.id)}" placeholder="写点什么…" rows="4">${esc(text)}</textarea></div>`;
  }
  if (w.type === 'photo') {
    const url = w.imageUrl || '';
    if (url) {
      return `<div class="hw-photo" data-hw-photo="${esc(w.id)}">
        <img class="hw-photo-img" src="${esc(url)}" alt="" draggable="false">
      </div>`;
    }
    return `<div class="hw-photo hw-photo--empty">
      <span class="hw-photo-empty-ico">🖼️</span>
      <span class="hw-photo-empty-txt">调好大小后点此选图</span>
    </div>`;
  }
  return '';
}

function renderWidget(w) {
  const def = WIDGET_MAP[w.type];
  if (!def) return '';
  const jiggle = _editMode ? ' jiggling' : '';
  const delay = Math.floor(Math.random() * 180);
  const del = _editMode
    ? `<button type="button" class="home-widget-del" data-widget-del="${esc(w.id)}" aria-label="删除">−</button>`
    : '';
  const sizeTag = _editMode
    ? `<span class="home-widget-size-tag">${w.w}×${w.h}</span>`
    : '';
  const calStyleBtn = (_editMode && (w.type === 'calendar' || w.type === 'weather' || w.type === 'clock'))
    ? `<button type="button" class="home-widget-style" data-widget-style="${esc(w.id)}" data-style-kind="${esc(w.type)}" aria-label="换样式">◐</button>`
    : '';
  const resizeHandles = _editMode
    ? `<div class="home-widget-sides">
         <div class="home-widget-side home-widget-side--e">
           <button type="button" class="home-widget-size-btn" data-size-dim="w" data-size-delta="1" aria-label="加宽">＋</button>
           <button type="button" class="home-widget-size-btn" data-size-dim="w" data-size-delta="-1" aria-label="收窄">－</button>
         </div>
         <div class="home-widget-side home-widget-side--s">
           <button type="button" class="home-widget-size-btn" data-size-dim="h" data-size-delta="1" aria-label="加高">＋</button>
           <button type="button" class="home-widget-size-btn" data-size-dim="h" data-size-delta="-1" aria-label="压矮">－</button>
         </div>
       </div>`
    : '';
  const opacity = Math.max(0.12, Math.min(1, Number(w.opacity) || 1));
  const textColor = ['auto', 'light', 'dark'].includes(w.textColor) ? w.textColor : 'auto';
  const hasCalBg = w.type === 'calendar' && !!w.bgUrl;
  const customBgCls = hasCalBg ? ' home-widget--custom-bg' : '';
  const bgStyle = hasCalBg ? `;--hw-bg-image:url("${esc(w.bgUrl)}")` : '';
  return `
    <div class="home-widget home-widget--${esc(w.type)}${customBgCls}${jiggle}${_editMode ? ' home-widget--editing' : ''}"
      data-widget-id="${esc(w.id)}" data-widget-type="${esc(w.type)}" data-hw-text="${esc(textColor)}"
      style="grid-column:${w.col + 1}/span ${w.w};grid-row:${w.row + 1}/span ${w.h};--jiggle-delay:${delay};--hw-opacity:${opacity.toFixed(3)}${bgStyle}">
      ${del}${sizeTag}${calStyleBtn}${resizeHandles}
      <div class="home-widget-body">${renderWidgetBody(w)}</div>
    </div>`;
}

function renderDock() {
  const wrap = document.querySelector('.home-dock-wrap');
  if (wrap) wrap.hidden = false;
  const dockEl = document.getElementById('home-dock');
  if (!dockEl) return;
  while (_dock.length < DOCK_SLOTS) _dock.push(null);
  _dock = _dock.slice(0, DOCK_SLOTS);
  dockEl.innerHTML = Array.from({ length: DOCK_SLOTS }, (_, i) =>
    renderSlot(_dock[i] || null, 'dock', i)
  ).join('');
}

function renderPageHeader() {
  const t = nowParts();
  const clockCfg = getHeaderClockConfig();
  const charCfg = getHeaderCharConfig();
  const jiggle = _editMode ? ' jiggling' : '';
  const delay = Math.floor(Math.random() * 180);
  const clockEdit = _editMode && !clockCfg.hidden
    ? `<button type="button" class="home-widget-del home-header-clock-del" data-header-clock-del aria-label="删除首页时钟">−</button>
       <button type="button" class="home-widget-style home-header-clock-style" data-header-clock-style aria-label="换样式">◐</button>`
    : '';
  const charEdit = _editMode && !charCfg.hidden
    ? `<button type="button" class="home-widget-del" data-header-char-del aria-label="删除角色状态">−</button>`
    : '';
  const clockHtml = clockCfg.hidden
    ? ''
    : `<div class="home-float home-float--clock${jiggle}${_editMode ? ' home-float--editing' : ''}"
         data-float="clock" style="left:${clockCfg.left}%;top:${clockCfg.top}%;--jiggle-delay:${delay}">
        ${clockEdit}
        <div class="home-header-clock-host${_editMode ? ' home-header-clock-host--editing' : ''}" role="button" tabindex="0" aria-label="角色闹钟">
          ${renderClockMarkup(clockCfg.style, t, { header: true })}
        </div>
      </div>`;
  const charHtml = charCfg.hidden
    ? ''
    : `<div class="home-float home-float--char${jiggle}${_editMode ? ' home-float--editing' : ''}"
         data-float="char" style="left:${charCfg.left}%;top:${charCfg.top}%;--jiggle-delay:${delay + 40}">
        ${charEdit}
        <div class="home-char-corner" role="button" tabindex="0" aria-label="角色与衣柜">
          <div class="home-char-avatar-wrap">
            <img class="avatar avatar-sm home-char-avatar" src="" alt="" style="display:none">
            <div class="avatar avatar-sm home-char-avatar-placeholder"
                 style="font-size:14px;background:linear-gradient(135deg,var(--theme-light),rgba(255,255,255,0.3))">✨</div>
            <div class="status-dot home-status-dot" style="bottom:0;right:0;width:9px;height:9px;border-width:2px;display:none"></div>
          </div>
          <div class="home-char-meta">
            <div class="home-char-name">暂无角色</div>
            <div class="home-char-status-text"></div>
            <div class="home-char-mood" style="display:none"></div>
          </div>
        </div>
      </div>`;
  return `<div class="home-page-floats">${clockHtml}${charHtml}</div>`;
}

function renderPages() {
  const pagesEl = document.getElementById('home-pages');
  const dotsEl = document.getElementById('home-page-dots');
  if (!pagesEl) return;

  _grid = padGridToPages(_grid, _widgets);
  const per = slotsPerPage();
  const pages = pageCount();
  const n = getGridSize();
  const launcher = document.getElementById('home-launcher');
  if (launcher) launcher.dataset.grid = String(n);

  const occ = occupiedSlotSet();
  let html = '';
  for (let p = 0; p < pages; p++) {
    const cells = [];
    for (let i = 0; i < per; i++) {
      const idx = p * per + i;
      if (occ.has(idx)) {
        // 被小组件占用的格不放图标槽，但保留占位由 widget 的 grid-area 覆盖
        continue;
      }
      const row = Math.floor(i / n) + 1;
      const col = (i % n) + 1;
      cells.push(
        renderSlot(_grid[idx] || null, 'grid', idx)
          .replace('class="home-icon-slot"', `class="home-icon-slot" style="grid-column:${col};grid-row:${row}"`)
      );
    }
    const pageWidgets = _widgets.filter(w => w.page === p).map(renderWidget).join('');
    const isHome = p === 0;
    html += `<div class="home-page-sheet${isHome ? ' home-page-sheet--home' : ''}" data-page="${p}">
      ${isHome ? renderPageHeader() : ''}
      <div class="home-page-grid" style="grid-template-columns:repeat(${n},minmax(0,1fr));grid-template-rows:repeat(${n},minmax(0,1fr))">${cells.join('')}${pageWidgets}</div>
    </div>`;
  }
  pagesEl.innerHTML = html;
  pagesEl.style.width = `${pages * 100}%`;
  pagesEl.querySelectorAll('.home-page-sheet').forEach(sheet => {
    sheet.style.width = `${100 / pages}%`;
  });

  if (dotsEl) {
    if (pages <= 1) {
      dotsEl.innerHTML = '';
      dotsEl.hidden = true;
    } else {
      dotsEl.hidden = false;
      dotsEl.innerHTML = Array.from({ length: pages }, (_, i) =>
        `<span class="home-page-dot${i === _pageIndex ? ' active' : ''}" data-dot="${i}"></span>`
      ).join('');
    }
  }

  applyPageTransform(false);
  bindWidgetChrome();
  refreshScheduleWidgets();
  refreshWeatherWidgets();
  window.renderHomeChar?.();
  window.tickHomeClock?.();
}

function renderAll() {
  renderPages();
  renderDock();
  applyWidgetChrome();
  window.updateHomeChatBadge?.();
  window.updateMomentsBadges?.();
  applyHomeTextColor();
  if (_openFolderId) {
    const idx = findFolderIndex(_openFolderId);
    if (idx >= 0) renderOpenFolderGrid(_grid[idx]);
    else closeFolderOverlay();
  }
  if (_drag?.kind === 'icon') {
    const zone = _drag.lastZone || _drag.zone || 'grid';
    const still = _drag.folderId
      ? document.querySelector(`.home-icon[data-folder-id="${CSS.escape(_drag.folderId)}"]`)
      : (_drag.key
        ? (document.querySelector(`.home-icon[data-zone="${zone}"][data-app-key="${CSS.escape(_drag.key)}"]`)
          || document.querySelector(`.home-icon[data-app-key="${CSS.escape(_drag.key)}"]`))
        : null);
    if (still) {
      still.classList.add('dragging');
      still.classList.remove('jiggling');
    }
  }
  if (_drag?.kind === 'widget' && _drag.id) {
    const still = document.querySelector(`.home-widget[data-widget-id="${CSS.escape(_drag.id)}"]`);
    if (still) {
      still.classList.add('dragging');
      still.classList.remove('jiggling');
    }
  }
  if (_drag?.kind === 'float' && _drag.floatKind) {
    const still = document.querySelector(`.home-float[data-float="${CSS.escape(_drag.floatKind)}"]`);
    if (still) {
      still.classList.add('dragging');
      still.classList.remove('jiggling');
    }
  }
}

function applyHomeTextColor() {
  try {
    const color = localStorage.getItem('beautify_home_text_color');
    if (!color) return;
    document.querySelectorAll('.home-icon-label,.home-header-clock').forEach(el => { el.style.color = color; });
  } catch {}
}

function applyPageTransform(animate) {
  const pagesEl = document.getElementById('home-pages');
  if (!pagesEl) return;
  const pages = pageCount();
  const x = pages <= 1 ? 0 : -(_pageIndex / pages) * 100;
  pagesEl.style.transition = animate ? 'transform 0.32s cubic-bezier(0.22,1,0.36,1)' : 'none';
  pagesEl.style.transform = `translate3d(${x}%,0,0)`;
  document.querySelectorAll('.home-page-dot').forEach(dot => {
    dot.classList.toggle('active', Number(dot.dataset.dot) === _pageIndex);
  });
}

function goToPage(index, animate = true) {
  _pageIndex = clampPage(index);
  applyPageTransform(animate);
}

function bindWidgetChrome() {
  document.querySelectorAll('[data-hw-notes]').forEach(ta => {
    ta.addEventListener('pointerdown', e => e.stopPropagation());
    ta.addEventListener('click', e => e.stopPropagation());
    ta.addEventListener('change', () => {
      const id = ta.getAttribute('data-hw-notes');
      const w = _widgets.find(x => x.id === id);
      if (!w) return;
      w.text = ta.value.slice(0, 500);
      saveLayout();
    });
  });
  document.querySelectorAll('[data-widget-del]').forEach(btn => {
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.getAttribute('data-widget-del');
      _widgets = _widgets.filter(w => w.id !== id);
      saveLayout();
      renderAll();
      if (_editMode) document.querySelectorAll('.home-icon,.home-widget').forEach(el => el.classList.add('jiggling'));
    });
  });
  document.querySelectorAll('[data-widget-style]').forEach(btn => {
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.getAttribute('data-widget-style');
      const kind = btn.getAttribute('data-style-kind') || 'calendar';
      if (kind === 'weather') openWeatherStylePicker(null, id);
      else if (kind === 'clock') openClockStylePicker(null, id);
      else openCalendarStylePicker(null, id);
    });
  });
  document.querySelectorAll('[data-header-clock-del]').forEach(btn => {
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      saveHeaderClockConfig({ ...getHeaderClockConfig(), hidden: true });
      renderAll();
      if (_editMode) document.querySelectorAll('.home-icon,.home-widget,.home-float').forEach(el => el.classList.add('jiggling'));
      window.showToast?.('已删除首页时钟，可在添加菜单里恢复');
    });
  });
  document.querySelectorAll('[data-header-char-del]').forEach(btn => {
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      saveHeaderCharConfig({ ...getHeaderCharConfig(), hidden: true });
      renderAll();
      if (_editMode) document.querySelectorAll('.home-icon,.home-widget,.home-float').forEach(el => el.classList.add('jiggling'));
      window.showToast?.('已删除角色状态，可在添加菜单里恢复');
    });
  });
  document.querySelectorAll('[data-header-clock-style]').forEach(btn => {
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openClockStylePicker(null, null, { header: true });
    });
  });
  document.querySelectorAll('[data-size-dim]').forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      e.preventDefault?.();
      btn._sizeDown = pointerPos(e);
    });
    btn.addEventListener('pointerup', e => {
      e.stopPropagation();
      const down = btn._sizeDown;
      btn._sizeDown = null;
      if (!down) return;
      const pos = pointerPos(e);
      if (Math.hypot(pos.x - down.x, pos.y - down.y) > 14) return;
      const widget = btn.closest('.home-widget');
      if (!widget) return;
      stepWidgetSize(
        widget.dataset.widgetId,
        btn.getAttribute('data-size-dim'),
        Number(btn.getAttribute('data-size-delta')) || 0,
      );
    });
    btn.addEventListener('click', e => e.stopPropagation());
  });
}

async function refreshWeatherWidgets() {
  const nodes = document.querySelectorAll('[data-hw-weather]');
  if (!nodes.length) return;
  await Promise.all([...nodes].map(async (node) => {
    const id = node.getAttribute('data-hw-weather');
    const widget = _widgets.find(w => w.id === id);
    if (!widget) return;
    const place = await resolveWeatherPlace(widget);
    const data = await fetchWeatherForPlace(place);
    const iconEl = node.querySelector('.hw-weather-icon');
    const tempEl = node.querySelector('.hw-weather-temp');
    const descEl = node.querySelector('.hw-weather-desc');
    const placeEl = node.querySelector('.hw-weather-place');
    if (!data) {
      if (descEl) descEl.textContent = '暂无天气';
      if (placeEl) placeEl.textContent = place || '';
      if (tempEl) tempEl.textContent = '--°';
      return;
    }
    widget._weatherSnapshot = data;
    if (iconEl) iconEl.textContent = data.emoji || '🌤️';
    if (tempEl) tempEl.textContent = Number.isFinite(Number(data.temp)) ? `${Math.round(data.temp)}°` : '--°';
    const feelsEl = node.querySelector('.hw-weather-feels');
    const rangeEl = node.querySelector('.hw-weather-range');
    if (feelsEl) {
      feelsEl.textContent = Number.isFinite(Number(data.feels))
        ? `体感 ${Math.round(data.feels)}°`
        : '体感 --°';
    }
    if (rangeEl) {
      rangeEl.textContent = (Number.isFinite(Number(data.tmin)) && Number.isFinite(Number(data.tmax)))
        ? `${Math.round(data.tmin)}~${Math.round(data.tmax)}°`
        : '--~--°';
    }
    if (descEl) {
      if (widget.weatherStyle === 'detail' || widget.weatherStyle === 'banner') {
        descEl.textContent = data.desc || '';
      } else {
        const bits = [data.desc];
        if (Number.isFinite(Number(data.tmin)) && Number.isFinite(Number(data.tmax))) {
          bits.push(`${Math.round(data.tmin)}~${Math.round(data.tmax)}°`);
        }
        if (Number.isFinite(Number(data.precipProb)) && data.precipProb >= 30) {
          bits.push(`降水${Math.round(data.precipProb)}%`);
        }
        descEl.textContent = bits.filter(Boolean).join(' · ');
      }
    }
    if (placeEl) placeEl.textContent = data.label || data.place || place;
  }));
}

function openHomeWidgetsStyleSheet() {
  const cfg = getWidgetChrome();
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  const opacityPct = Math.round(cfg.opacity * 100);
  const clarityPct = Math.round(cfg.clarity * 100);
  const noChrome = cfg.effect === 'none';
  if (title) title.textContent = '小组件外观';
  if (menu) menu.hidden = true;
  if (widgets) {
    widgets.hidden = false;
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-hwchrome-back">‹ 关闭</button>
      <div class="settings-group" style="margin:12px 16px 20px">
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="settings-row-label">材质效果</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm ${cfg.effect === 'glass' ? 'btn-primary' : 'btn-ghost'}" data-hw-effect="glass">玻璃</button>
            <button type="button" class="btn btn-sm ${cfg.effect === 'frosted' ? 'btn-primary' : 'btn-ghost'}" data-hw-effect="frosted">磨砂</button>
            <button type="button" class="btn btn-sm ${noChrome ? 'btn-primary' : 'btn-ghost'}" data-hw-effect="none">无容器</button>
          </div>
          ${noChrome ? '<div style="font-size:11px;color:var(--text-secondary)">内容直接浮在壁纸上，无底、边与阴影。</div>' : ''}
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="settings-row-label">文字颜色</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm ${cfg.textColor === 'auto' ? 'btn-primary' : 'btn-ghost'}" data-hw-fg="auto">自动</button>
            <button type="button" class="btn btn-sm ${cfg.textColor === 'light' ? 'btn-primary' : 'btn-ghost'}" data-hw-fg="light">浅色</button>
            <button type="button" class="btn btn-sm ${cfg.textColor === 'dark' ? 'btn-primary' : 'btn-ghost'}" data-hw-fg="dark">深色</button>
          </div>
        </div>
        ${noChrome ? '' : `
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="settings-row-label">透明度 <span id="home-hwchrome-op-val">${opacityPct}%</span></div>
          <input type="range" id="home-hwchrome-opacity" min="15" max="100" value="${opacityPct}" style="width:100%">
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="settings-row-label">容器颜色</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm ${cfg.tone === 'light' ? 'btn-primary' : 'btn-ghost'}" data-hw-tone="light">白色</button>
            <button type="button" class="btn btn-sm ${cfg.tone === 'dark' ? 'btn-primary' : 'btn-ghost'}" data-hw-tone="dark">黑色</button>
          </div>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="settings-row-label">清晰度 <span id="home-hwchrome-cl-val">${clarityPct}%</span></div>
          <input type="range" id="home-hwchrome-clarity" min="0" max="100" value="${clarityPct}" style="width:100%">
          <div style="font-size:11px;color:var(--text-secondary)">越高越通透清晰，越低越实、雾感更强</div>
        </div>`}
        <button type="button" class="home-add-item" id="home-hwchrome-add" style="margin-top:8px">
          <span class="home-add-ico">🧩</span>
          <span class="home-add-text"><b>添加小组件</b><small>时钟、日历、天气、相册等</small></span>
        </button>
      </div>`;
    widgets.querySelector('#home-hwchrome-back')?.addEventListener('click', () => closeHomeAddSheet());
    widgets.querySelector('#home-hwchrome-add')?.addEventListener('click', () => openHomeAddSheet('widgets'));
    const opRange = widgets.querySelector('#home-hwchrome-opacity');
    const opVal = widgets.querySelector('#home-hwchrome-op-val');
    opRange?.addEventListener('input', () => {
      const pct = Number(opRange.value) || 100;
      if (opVal) opVal.textContent = `${pct}%`;
      saveWidgetChrome({ opacity: pct / 100 });
    });
    const clRange = widgets.querySelector('#home-hwchrome-clarity');
    const clVal = widgets.querySelector('#home-hwchrome-cl-val');
    clRange?.addEventListener('input', () => {
      const pct = Number(clRange.value) || 0;
      if (clVal) clVal.textContent = `${pct}%`;
      saveWidgetChrome({ clarity: pct / 100 });
    });
    widgets.querySelectorAll('[data-hw-effect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveWidgetChrome({ effect: btn.getAttribute('data-hw-effect') || 'glass' });
        openHomeWidgetsStyleSheet();
      });
    });
    widgets.querySelectorAll('[data-hw-tone]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveWidgetChrome({ tone: btn.getAttribute('data-hw-tone') || 'light' });
        openHomeWidgetsStyleSheet();
      });
    });
    widgets.querySelectorAll('[data-hw-fg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveWidgetChrome({ textColor: btn.getAttribute('data-hw-fg') || 'auto' });
        openHomeWidgetsStyleSheet();
      });
    });
  }
  el.classList.add('active');
}

function openClockStylePicker(onPick, widgetId = null, opts = {}) {
  const forHeader = !!opts.header;
  _calendarStyleCallback = onPick;
  _calendarStyleWidgetId = widgetId;
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (title) title.textContent = forHeader ? '首页时钟样式' : '时钟样式';
  if (menu) menu.hidden = true;
  if (widgets) {
    widgets.hidden = false;
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-clk-back">‹ 返回</button>
      <div class="home-cal-style-grid">
        ${CLOCK_STYLES.map(s => `
          <button type="button" class="home-cal-style-pick" data-clk-style="${s.id}">
            <div class="home-cal-style-preview home-cal-style-preview--clock">${renderClockPreview(s.id)}</div>
            <span class="home-cal-style-name">${s.name}</span>
            <span class="home-cal-style-desc">${s.desc}</span>
          </button>`).join('')}
      </div>`;
    widgets.querySelector('#home-clk-back')?.addEventListener('click', () => {
      _calendarStyleCallback = null;
      _calendarStyleWidgetId = null;
      if (forHeader || widgetId) closeHomeAddSheet();
      else openHomeAddSheet('widgets');
    });
    widgets.querySelectorAll('[data-clk-style]').forEach(btn => {
      btn.addEventListener('click', () => {
        const style = btn.getAttribute('data-clk-style');
        if (forHeader) {
          saveHeaderClockConfig({ ...getHeaderClockConfig(), style, hidden: false });
          closeHomeAddSheet();
          renderAll();
          if (_editMode) document.querySelectorAll('.home-icon,.home-widget').forEach(el => el.classList.add('jiggling'));
          window.showToast?.('首页时钟样式已更换');
          return;
        }
        if (_calendarStyleWidgetId) {
          const w = _widgets.find(x => x.id === _calendarStyleWidgetId);
          if (w) {
            w.clockStyle = style;
            saveLayout();
            renderAll();
            if (_editMode) document.querySelectorAll('.home-icon,.home-widget').forEach(el => el.classList.add('jiggling'));
          }
          _calendarStyleWidgetId = null;
          closeHomeAddSheet();
          window.showToast?.('时钟样式已更换');
        } else if (_calendarStyleCallback) {
          const cb = _calendarStyleCallback;
          _calendarStyleCallback = null;
          cb(style);
        }
      });
    });
  }
  el.classList.add('active');
}

function openCalendarStylePicker(onPick, widgetId = null) {
  _calendarStyleCallback = onPick;
  _calendarStyleWidgetId = widgetId;
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (title) title.textContent = '日历样式';
  if (menu) menu.hidden = true;
  if (widgets) {
    widgets.hidden = false;
    const existing = widgetId ? _widgets.find(x => x.id === widgetId) : null;
    const bgBar = widgetId ? `
      <div class="home-cal-bg-bar">
        <div class="home-cal-bg-bar-text">
          <b>容器外观</b>
          <small>${existing?.bgUrl ? '已设置自定义背景' : '可用图片替换玻璃容器'}</small>
        </div>
        <div class="home-cal-bg-bar-actions">
          <button type="button" class="home-cal-bg-btn" id="home-cal-bg-pick">上传图片</button>
          ${existing?.bgUrl ? '<button type="button" class="home-cal-bg-btn home-cal-bg-btn--ghost" id="home-cal-bg-clear">清除</button>' : ''}
        </div>
      </div>` : '';
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-cal-back">‹ 返回</button>
      ${bgBar}
      <div class="home-cal-style-grid">
        ${CALENDAR_STYLES.map(s => `
          <button type="button" class="home-cal-style-pick" data-cal-style="${s.id}">
            <div class="home-cal-style-preview">${renderCalendarPreview(s.id)}</div>
            <span class="home-cal-style-name">${s.name}</span>
            <span class="home-cal-style-desc">${s.desc}</span>
          </button>`).join('')}
      </div>`;
    widgets.querySelector('#home-cal-back')?.addEventListener('click', () => {
      _calendarStyleCallback = null;
      _calendarStyleWidgetId = null;
      if (widgetId) closeHomeAddSheet();
      else openHomeAddSheet('widgets');
    });
    widgets.querySelector('#home-cal-bg-pick')?.addEventListener('click', () => {
      closeHomeAddSheet();
      openCalendarBgPicker(widgetId);
    });
    widgets.querySelector('#home-cal-bg-clear')?.addEventListener('click', () => {
      setCalendarBgUrl(widgetId, '');
      window.showToast?.('已清除容器背景');
      openCalendarStylePicker(null, widgetId);
    });
    widgets.querySelectorAll('[data-cal-style]').forEach(btn => {
      btn.addEventListener('click', () => {
        const style = btn.getAttribute('data-cal-style');
        if (_calendarStyleWidgetId) {
          const w = _widgets.find(x => x.id === _calendarStyleWidgetId);
          if (w) {
            w.calStyle = style;
            saveLayout();
            renderAll();
            if (_editMode) document.querySelectorAll('.home-icon,.home-widget').forEach(el => el.classList.add('jiggling'));
          }
          _calendarStyleWidgetId = null;
          closeHomeAddSheet();
          window.showToast?.('日历样式已更换');
        } else if (_calendarStyleCallback) {
          const cb = _calendarStyleCallback;
          _calendarStyleCallback = null;
          cb(style);
        }
      });
    });
  }
  el.classList.add('active');
}

function openWeatherStylePicker(onPick, widgetId = null) {
  _calendarStyleCallback = onPick; // reuse callback slots
  _calendarStyleWidgetId = widgetId;
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (title) title.textContent = '天气样式';
  if (menu) menu.hidden = true;
  if (widgets) {
    widgets.hidden = false;
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-wx-back">‹ 返回</button>
      <div class="home-cal-style-grid">
        ${WEATHER_STYLES.map(s => `
          <button type="button" class="home-cal-style-pick" data-wx-style="${s.id}">
            <div class="home-cal-style-preview">${renderWeatherPreview(s.id)}</div>
            <span class="home-cal-style-name">${s.name}</span>
            <span class="home-cal-style-desc">${s.desc}</span>
          </button>`).join('')}
      </div>`;
    widgets.querySelector('#home-wx-back')?.addEventListener('click', () => {
      _calendarStyleCallback = null;
      _calendarStyleWidgetId = null;
      if (widgetId) closeHomeAddSheet();
      else openHomeAddSheet('widgets');
    });
    widgets.querySelectorAll('[data-wx-style]').forEach(btn => {
      btn.addEventListener('click', () => {
        const style = btn.getAttribute('data-wx-style');
        if (_calendarStyleWidgetId) {
          const w = _widgets.find(x => x.id === _calendarStyleWidgetId);
          if (w) {
            w.weatherStyle = style;
            saveLayout();
            renderAll();
            if (_editMode) document.querySelectorAll('.home-icon,.home-widget').forEach(el => el.classList.add('jiggling'));
          }
          _calendarStyleWidgetId = null;
          closeHomeAddSheet();
          window.showToast?.('天气样式已更换');
        } else if (_calendarStyleCallback) {
          const cb = _calendarStyleCallback;
          _calendarStyleCallback = null;
          cb(style);
        }
      });
    });
  }
  el.classList.add('active');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseAlarmList(raw) {
  let alarms = raw;
  if (typeof alarms === 'string') {
    try { alarms = JSON.parse(alarms); } catch { alarms = []; }
  }
  if (!Array.isArray(alarms)) return [];
  return alarms
    .filter(a => a && Number(a.id) > 0)
    .map(a => ({
      id: Number(a.id),
      hour: Number(a.hour) || 0,
      minute: Number(a.minute) || 0,
      repeat: a.repeat === 'daily' ? 'daily' : 'once',
      enabled: a.enabled !== false,
      name: String(a.name || ''),
      label: String(a.label || ''),
    }))
    .sort((a, b) => (a.hour - b.hour) || (a.minute - b.minute) || (a.id - b.id));
}

function renderAlarmRows(alarms) {
  if (!alarms.length) {
    return `<div class="home-alarm-empty">暂无角色闹钟<br><small>让角色帮你定一个吧</small></div>`;
  }
  return `<div class="home-alarm-list">${alarms.map(a => `
    <div class="home-alarm-row" data-alarm-id="${a.id}">
      <div class="home-alarm-time">${pad2(a.hour)}:${pad2(a.minute)}</div>
      <label class="toggle home-alarm-toggle" aria-label="开关闹钟">
        <input type="checkbox" data-alarm-toggle="${a.id}" ${a.enabled ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>`).join('')}</div>`;
}

async function openCharacterAlarmsSheet() {
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (title) title.textContent = '角色闹钟';
  if (menu) menu.hidden = true;
  if (widgets) {
    widgets.hidden = false;
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-alarm-back">‹ 关闭</button>
      <div class="home-alarm-body" id="home-alarm-body">
        <div class="home-alarm-loading">加载中…</div>
      </div>`;
    widgets.querySelector('#home-alarm-back')?.addEventListener('click', () => closeHomeAddSheet());
  }
  el.classList.add('active');

  const body = document.getElementById('home-alarm-body');
  if (!body) return;

  const bindToggles = (alarms) => {
    body.querySelectorAll('[data-alarm-toggle]').forEach(input => {
      input.addEventListener('change', async () => {
        const id = Number(input.getAttribute('data-alarm-toggle'));
        const on = !!input.checked;
        input.disabled = true;
        try {
          const { handleNativeAlarm } = await import('./app-permissions.js');
          const r = await handleNativeAlarm({ action: on ? 'enable' : 'disable', id });
          if (!r?.native) {
            input.checked = !on;
            window.showToast?.('角色闹钟仅在 App 中可用');
            return;
          }
          if (r.ok === false) {
            input.checked = !on;
            if (r.error === 'exact_alarm_off') window.showToast?.('请先开启精确闹钟权限');
            else window.showToast?.('开关失败');
            return;
          }
        } catch {
          input.checked = !on;
          window.showToast?.('开关失败');
        } finally {
          input.disabled = false;
        }
      });
    });
  };

  try {
    const { handleNativeAlarm } = await import('./app-permissions.js');
    const r = await handleNativeAlarm({ action: 'list' });
    if (!r?.native) {
      body.innerHTML = `<div class="home-alarm-empty">角色闹钟仅在 App 中可用<br><small>Web 端无法查看与开关</small></div>`;
      return;
    }
    if (r.ok === false && r.error === 'exact_alarm_off') {
      body.innerHTML = `<div class="home-alarm-empty">未开启精确闹钟权限<br><small>可在设置里打开「角色闹钟」权限</small></div>`;
      return;
    }
    const alarms = parseAlarmList(r.alarms);
    body.innerHTML = renderAlarmRows(alarms);
    bindToggles(alarms);
  } catch {
    body.innerHTML = `<div class="home-alarm-empty">加载失败</div>`;
  }
}

let _monthCalCursor = null; // Date at month start

function monthCalTitle(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function renderMonthCalendarGrid(cursor, selected) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startPad = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  const selKey = selected
    ? `${selected.getFullYear()}-${selected.getMonth()}-${selected.getDate()}`
    : '';
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push('<div class="home-month-cell home-month-cell--pad"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${month}-${day}`;
    const cls = [
      'home-month-cell',
      key === todayKey ? 'is-today' : '',
      key === selKey ? 'is-selected' : '',
    ].filter(Boolean).join(' ');
    cells.push(`<button type="button" class="${cls}" data-month-day="${day}">${day}</button>`);
  }
  while (cells.length % 7 !== 0) cells.push('<div class="home-month-cell home-month-cell--pad"></div>');
  const weekHead = ['日', '一', '二', '三', '四', '五', '六']
    .map(w => `<div class="home-month-weekday">${w}</div>`).join('');
  return `
    <div class="home-month-weekdays">${weekHead}</div>
    <div class="home-month-grid">${cells.join('')}</div>`;
}

function openMonthCalendarSheet() {
  if (!_monthCalCursor) {
    const n = new Date();
    _monthCalCursor = new Date(n.getFullYear(), n.getMonth(), 1);
  }
  let selected = new Date();
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (title) title.textContent = '日历';
  if (menu) menu.hidden = true;

  const paint = () => {
    if (!widgets) return;
    const cur = _monthCalCursor;
    const selLabel = `${selected.getMonth() + 1}月${selected.getDate()}日 · ${['周日','周一','周二','周三','周四','周五','周六'][selected.getDay()]}`;
    widgets.hidden = false;
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-month-back">‹ 关闭</button>
      <div class="home-month-cal">
        <div class="home-month-nav">
          <button type="button" class="home-month-nav-btn" id="home-month-prev" aria-label="上一月">‹</button>
          <div class="home-month-title">${monthCalTitle(cur)}</div>
          <button type="button" class="home-month-nav-btn" id="home-month-next" aria-label="下一月">›</button>
        </div>
        ${renderMonthCalendarGrid(cur, selected)}
        <div class="home-month-selected" id="home-month-selected">${selLabel}</div>
        <button type="button" class="home-month-today-btn" id="home-month-today">回到今天</button>
      </div>`;
    widgets.querySelector('#home-month-back')?.addEventListener('click', () => closeHomeAddSheet());
    widgets.querySelector('#home-month-prev')?.addEventListener('click', () => {
      _monthCalCursor = new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
      paint();
    });
    widgets.querySelector('#home-month-next')?.addEventListener('click', () => {
      _monthCalCursor = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      paint();
    });
    widgets.querySelector('#home-month-today')?.addEventListener('click', () => {
      const n = new Date();
      _monthCalCursor = new Date(n.getFullYear(), n.getMonth(), 1);
      selected = n;
      paint();
    });
    widgets.querySelectorAll('[data-month-day]').forEach(btn => {
      btn.addEventListener('click', () => {
        const day = Number(btn.getAttribute('data-month-day'));
        selected = new Date(cur.getFullYear(), cur.getMonth(), day);
        paint();
      });
    });
  };

  paint();
  el.classList.add('active');
}

async function refreshScheduleWidgets() {
  const nodes = document.querySelectorAll('[data-hw-schedule]');
  if (!nodes.length) return;
  const charId = window.getActiveCharId?.();
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let items = [];
  try {
    if (charId) {
      const api = await import('./api.js');
      const data = await api.getSchedule({ role: 'ai', charId, date });
      const list = Array.isArray(data) ? data : (data?.items || data?.schedules || []);
      items = (list || []).slice(0, 4);
    }
  } catch {}
  nodes.forEach(node => {
    const list = node.querySelector('.hw-schedule-list');
    if (!list) return;
    if (!charId) {
      list.innerHTML = '<div class="hw-schedule-empty">先选择角色</div>';
      return;
    }
    if (!items.length) {
      list.innerHTML = '<div class="hw-schedule-empty">今天暂无安排</div>';
      return;
    }
    list.innerHTML = items.map(it => {
      const title = esc(it.title || it.content || it.name || '日程');
      const time = esc(it.time || it.start_time || it.start || '');
      return `<div class="hw-schedule-item"><span class="hw-schedule-time">${time}</span><span class="hw-schedule-name">${title}</span></div>`;
    }).join('');
  });
}

let _lastWidgetDateKey = '';
export function tickWidgetClocks() {
  const t = nowParts();
  applyAnalogHands();
  document.querySelectorAll('[data-hw-clock]').forEach(el => { el.textContent = t.hm; });
  document.querySelectorAll('[data-hw-clock-hh]').forEach(el => { el.textContent = t.hh; });
  document.querySelectorAll('[data-hw-clock-mm]').forEach(el => { el.textContent = t.mm; });
  document.querySelectorAll('[data-hw-clock-date]').forEach(el => {
    const host = el.closest('[data-clock-style]');
    const style = host?.getAttribute('data-clock-style') || 'classic';
    if (style === 'poster' && el.classList.contains('hw-clock-poster-date')) {
      el.textContent = t.week;
    } else if (style === 'poster') {
      el.textContent = t.dateLine;
    } else if (style === 'stack' || style === 'classic' || style === 'digital' || style === 'glass' || style === 'analog') {
      el.textContent = `${t.dateLine} ${t.week}`;
    }
  });
  document.querySelectorAll('.home-widget--calendar .hw-cal-day').forEach((el, i) => {
    const widgets = _widgets.filter(w => w.type === 'calendar');
    const w = widgets[i];
    if (!w || w.calStyle === 'week' || w.calStyle === 'month') return;
    el.textContent = t.day;
  });
  document.querySelectorAll('.home-widget--calendar .hw-cal-month').forEach(el => { el.textContent = t.month; });
  document.querySelectorAll('.home-widget--calendar .hw-cal-week').forEach(el => { el.textContent = t.week; });
  const dateKey = `${t.year}-${t.month}-${t.day}`;
  if (!_lastWidgetDateKey) {
    _lastWidgetDateKey = dateKey;
  } else if (dateKey !== _lastWidgetDateKey) {
    _lastWidgetDateKey = dateKey;
    document.querySelectorAll('.hw-cal--month').forEach(el => {
      const preview = el.classList.contains('hw-cal--preview');
      el.outerHTML = renderMonthCalendar(t, preview);
    });
  }
}

function setEditMode(on) {
  const next = !!on;
  if (_editMode === next) {
    // 已在目标模式：避免重复 renderAll 打断正在进行的拖动
    const bar = document.getElementById('home-edit-bar');
    if (bar) bar.hidden = !_editMode;
    return;
  }
  _editMode = next;
  document.getElementById('home-page')?.classList.toggle('home-editing', _editMode);
  const bar = document.getElementById('home-edit-bar');
  if (bar) bar.hidden = !_editMode;
  const done = document.getElementById('home-edit-done');
  if (done) done.hidden = !_editMode;
  const addBtn = document.getElementById('home-edit-add');
  if (addBtn) addBtn.hidden = !_editMode;

  if (_editMode) {
    const per = slotsPerPage();
    // 编辑时至少保证当前页数，不再额外强制多一页（避免和「新建桌面」打架）
    while (_grid.length % per !== 0) _grid.push(null);
    if (_grid.length < per) {
      while (_grid.length < per) _grid.push(null);
    }
    renderAll();
  } else {
    // 退出编辑：按实际内容 + 用户锁定的最少页数收敛
    let lastUsed = 0;
    const pages = Math.ceil(_grid.length / slotsPerPage()) || 1;
    for (let p = 0; p < pages; p++) {
      if (pageHasContent(p)) lastUsed = p + 1;
    }
    setMinPageCount(Math.max(lastUsed, getMinPageCount(), 1));
    _grid = padGridToPages(_grid, _widgets);
    renderAll();
  }
  document.querySelectorAll('.home-icon,.home-widget,.home-float').forEach(el => {
    el.classList.toggle('jiggling', _editMode);
    if (_editMode) el.style.setProperty('--jiggle-delay', String(Math.floor(Math.random() * 180)));
  });
}

/* ─── 新建桌面 / 小组件 ─── */
function addBlankDesktop() {
  const per = slotsPerPage();
  // 先进入编辑，避免 render 时把空页清掉
  if (!_editMode) {
    _editMode = true;
    document.getElementById('home-page')?.classList.add('home-editing');
    const bar = document.getElementById('home-edit-bar');
    if (bar) bar.hidden = false;
    const done = document.getElementById('home-edit-done');
    if (done) done.hidden = false;
    const addBtn = document.getElementById('home-edit-add');
    if (addBtn) addBtn.hidden = false;
  }
  while (_grid.length % per !== 0) _grid.push(null);
  const newPage = _grid.length / per;
  for (let i = 0; i < per; i++) _grid.push(null);
  setMinPageCount(Math.max(getMinPageCount(), newPage + 1));
  saveLayout();
  renderAll();
  goToPage(newPage, true);
  document.querySelectorAll('.home-icon,.home-widget').forEach(el => {
    el.classList.add('jiggling');
    el.style.setProperty('--jiggle-delay', String(Math.floor(Math.random() * 180)));
  });
  window.showToast?.('已到新桌面，从上一页拖图标过来即可');
}

function addWidget(type, extras = {}) {
  const def = WIDGET_MAP[type];
  if (!def) return;

  if (type === 'calendar' && !extras.calStyle) {
    openCalendarStylePicker((style) => addWidget('calendar', { calStyle: style }));
    return;
  }
  if (type === 'clock' && !extras.clockStyle) {
    openClockStylePicker((style) => addWidget('clock', { clockStyle: style }));
    return;
  }
  if (type === 'weather' && !extras.weatherStyle) {
    openWeatherStylePicker((style) => addWidget('weather', { weatherStyle: style }));
    return;
  }

  const n = getGridSize();
  const sizes = [];
  if (type === 'calendar' && extras.calStyle === 'month') {
    sizes.push({ w: Math.min(4, n), h: Math.min(3, n) });
  }
  if (type === 'clock' && extras.clockStyle === 'poster') {
    sizes.push({ w: 2, h: Math.min(3, n) });
  }
  sizes.push({ w: def.w, h: def.h });

  let place = null;
  let size = sizes[0];
  for (const candidate of sizes) {
    place = findFreeRect(_pageIndex, candidate.w, candidate.h);
    if (!place) {
      for (let p = 0; p < pageCount(); p++) {
        place = findFreeRect(p, candidate.w, candidate.h);
        if (place) break;
      }
    }
    if (place) {
      size = candidate;
      break;
    }
  }
  if (!place) {
    const newPage = pageCount();
    ensurePageExists(newPage);
    size = sizes[0];
    place = findFreeRect(newPage, size.w, size.h) || { page: newPage, col: 0, row: 0 };
  }

  ensurePageExists(place.page);
  const widget = {
    id: uid(),
    type: def.type,
    page: place.page,
    col: place.col,
    row: place.row,
    w: size.w,
    h: size.h,
    text: '',
    imageUrl: '',
    bgUrl: '',
  };
  if (type === 'calendar') widget.calStyle = extras.calStyle || 'classic';
  if (type === 'clock') widget.clockStyle = extras.clockStyle || 'classic';
  if (type === 'weather') {
    widget.weatherPlace = '';
    widget.weatherStyle = extras.weatherStyle || 'classic';
  }
  const slots = widgetSlotIndices(widget);
  evacuateIconsFromSlots(slots);
  _widgets.push(widget);
  saveLayout();
  renderAll();
  goToPage(widget.page, true);
  setEditMode(true);
  closeHomeAddSheet();
  if (type === 'photo') {
    window.showToast?.('已添加相册：先调大小，再点空白相册选图裁剪');
  } else {
    window.showToast?.(`已添加「${def.name}」`);
  }
}

function ensureAddOverlay() {
  let el = document.getElementById('home-add-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'home-add-overlay';
  el.className = 'overlay';
  el.innerHTML = `
    <div class="sheet home-add-sheet" onclick="event.stopPropagation()">
      <div class="sheet-handle"></div>
      <div class="sheet-title" id="home-add-title">主屏幕</div>
      <div id="home-add-menu" class="home-add-menu"></div>
      <div id="home-add-widgets" class="home-add-widgets" hidden></div>
    </div>`;
  el.addEventListener('click', () => closeHomeAddSheet());
  document.body.appendChild(el);
  return el;
}

function openHomeAddSheet(mode = 'menu') {
  _sheetMode = mode;
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (mode === 'menu') {
    if (title) title.textContent = '主屏幕';
    if (menu) {
      menu.hidden = false;
      const headerHidden = getHeaderClockConfig().hidden;
      const charHidden = getHeaderCharConfig().hidden;
      menu.innerHTML = `
        <button type="button" class="home-add-item" data-home-action="widgets">
          <span class="home-add-ico">🧩</span>
          <span class="home-add-text"><b>添加小组件</b><small>时钟、日历、天气、相册、角色、日程等</small></span>
        </button>
        ${headerHidden ? `
        <button type="button" class="home-add-item" data-home-action="restore-clock">
          <span class="home-add-ico">🕐</span>
          <span class="home-add-text"><b>恢复首页时钟</b><small>可长按拖动位置</small></span>
        </button>` : ''}
        ${charHidden ? `
        <button type="button" class="home-add-item" data-home-action="restore-char">
          <span class="home-add-ico">✨</span>
          <span class="home-add-text"><b>恢复角色状态</b><small>可长按拖动位置</small></span>
        </button>` : ''}
        <button type="button" class="home-add-item" data-home-action="newpage">
          <span class="home-add-ico">📄</span>
          <span class="home-add-text"><b>新建桌面</b><small>在末尾添加一页空白主屏幕</small></span>
        </button>
        <button type="button" class="home-add-item" data-home-action="edit">
          <span class="home-add-ico">✨</span>
          <span class="home-add-text"><b>整理图标</b><small>长按拖动，可放到空白格</small></span>
        </button>`;
      menu.querySelectorAll('[data-home-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const act = btn.getAttribute('data-home-action');
          if (act === 'widgets') openHomeAddSheet('widgets');
          else if (act === 'restore-clock') {
            closeHomeAddSheet();
            openClockStylePicker(null, null, { header: true });
          }
          else if (act === 'restore-char') {
            closeHomeAddSheet();
            saveHeaderCharConfig({ ...getHeaderCharConfig(), hidden: false });
            renderAll();
            if (_editMode) document.querySelectorAll('.home-icon,.home-widget,.home-float').forEach(el => el.classList.add('jiggling'));
            window.showToast?.('已恢复角色状态');
          }
          else if (act === 'newpage') { closeHomeAddSheet(); addBlankDesktop(); }
          else if (act === 'edit') { closeHomeAddSheet(); setEditMode(true); }
        });
      });
    }
    if (widgets) widgets.hidden = true;
  } else {
    if (title) title.textContent = '添加小组件';
    if (menu) menu.hidden = true;
    if (widgets) {
      widgets.hidden = false;
      widgets.innerHTML = `
        <button type="button" class="home-add-back" id="home-add-back">‹ 返回</button>
        <div class="home-widget-grid">
          ${HOME_WIDGETS.map(w => `
            <button type="button" class="home-widget-pick" data-widget-type="${w.type}">
              <span class="home-widget-pick-ico">${w.icon}</span>
              <span class="home-widget-pick-name">${w.name}</span>
              <span class="home-widget-pick-desc">${w.desc} · ${w.w}×${w.h}</span>
            </button>`).join('')}
        </div>`;
      widgets.querySelector('#home-add-back')?.addEventListener('click', () => openHomeAddSheet('menu'));
      widgets.querySelectorAll('[data-widget-type]').forEach(btn => {
        btn.addEventListener('click', () => addWidget(btn.getAttribute('data-widget-type')));
      });
    }
  }
  el.classList.add('active');
}

function closeHomeAddSheet() {
  document.getElementById('home-add-overlay')?.classList.remove('active');
}

/** 系统返回：先关加号面板 / 文件夹 / 编辑模式 */
window.consumeHomeBack = function consumeHomeBack() {
  if (document.getElementById('home-add-overlay')?.classList.contains('active')) {
    closeHomeAddSheet();
    return true;
  }
  if (_openFolderId || document.getElementById('home-folder-overlay')?.classList.contains('active')) {
    closeFolderOverlay();
    return true;
  }
  if (_editMode) {
    setEditMode(false);
    return true;
  }
  return false;
};

/* ─── 图标文件夹 ─── */
function ensureFolderOverlay() {
  let el = document.getElementById('home-folder-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'home-folder-overlay';
  el.className = 'home-folder-overlay';
  el.innerHTML = `
    <div class="home-folder-card" data-folder-card>
      <input type="text" class="home-folder-name" id="home-folder-name" maxlength="12" enterkeyhint="done" aria-label="文件夹名称">
      <div class="home-folder-grid" id="home-folder-grid"></div>
    </div>`;
  el.addEventListener('pointerdown', (e) => {
    if (e.target === el) {
      e.stopPropagation();
      closeFolderOverlay();
    }
  });
  const nameEl = el.querySelector('#home-folder-name');
  nameEl.addEventListener('pointerdown', e => e.stopPropagation());
  nameEl.addEventListener('click', e => e.stopPropagation());
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameEl.blur();
    }
  });
  nameEl.addEventListener('change', saveOpenFolderName);
  nameEl.addEventListener('blur', saveOpenFolderName);
  document.getElementById('home-page')?.appendChild(el);
  return el;
}

function saveOpenFolderName() {
  if (!_openFolderId) return;
  const idx = findFolderIndex(_openFolderId);
  if (idx < 0) return;
  const nameEl = document.getElementById('home-folder-name');
  const name = String(nameEl?.value || '').trim().slice(0, 12) || '文件夹';
  _grid[idx].name = name;
  if (nameEl) nameEl.value = name;
  saveLayout();
  const label = document.querySelector(`.home-icon[data-folder-id="${CSS.escape(_openFolderId)}"] .home-icon-label`);
  if (label) label.textContent = name;
  const btn = document.querySelector(`.home-icon[data-folder-id="${CSS.escape(_openFolderId)}"]`);
  if (btn) btn.setAttribute('aria-label', name);
}

function renderOpenFolderGrid(folder) {
  const grid = document.getElementById('home-folder-grid');
  if (!grid || !folder) return;
  const jiggle = _editMode ? ' jiggling' : '';
  grid.innerHTML = folder.items.map((key) => {
    const app = APP_MAP[key];
    if (!app) return '';
    return `<button type="button" class="home-icon${jiggle}" data-app-key="${esc(key)}"
        data-folder-item="${esc(folder.id)}" aria-label="${esc(displayName(app))}">
        ${iconInnerHtml(app, { badge: key === 'chat' })}
        <span class="home-icon-label">${esc(displayName(app))}</span>
      </button>`;
  }).join('');
}

function openFolder(id, { focusName = false } = {}) {
  const idx = findFolderIndex(id);
  if (idx < 0) return;
  const folder = _grid[idx];
  _openFolderId = id;
  closeHomeAddSheet();
  const el = ensureFolderOverlay();
  const nameEl = document.getElementById('home-folder-name');
  if (nameEl) nameEl.value = folder.name || '文件夹';
  renderOpenFolderGrid(folder);
  el.classList.add('active');
  applyHomeTextColor();
  window.updateHomeChatBadge?.();
  window.updateMomentsBadges?.();
  if (focusName) {
    requestAnimationFrame(() => {
      nameEl?.focus();
      nameEl?.select();
    });
  }
}

function closeFolderOverlay() {
  saveOpenFolderName();
  _openFolderId = null;
  document.getElementById('home-folder-overlay')?.classList.remove('active');
}

/* ─── 相册小组件：选图 ─── */
let _photoPickWidgetId = null;
let _calBgPickWidgetId = null;

function setWidgetImage(widgetId, url) {
  const w = _widgets.find(x => x.id === widgetId);
  if (!w || !url) return;
  w.imageUrl = url;
  saveLayout();
  renderAll();
  if (_editMode) document.querySelectorAll('.home-icon,.home-widget').forEach(el => el.classList.add('jiggling'));
}

function setCalendarBgUrl(widgetId, url) {
  const w = _widgets.find(x => x.id === widgetId);
  if (!w || w.type !== 'calendar') return;
  w.bgUrl = typeof url === 'string' ? url : '';
  saveLayout();
  renderAll();
  if (_editMode) document.querySelectorAll('.home-icon,.home-widget').forEach(el => el.classList.add('jiggling'));
}

function ensureCalBgFileInput() {
  let input = document.getElementById('home-cal-bg-file-input');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.id = 'home-cal-bg-file-input';
  input.accept = 'image/*,image/gif,image/webp';
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    const widgetId = _calBgPickWidgetId;
    if (!file || !widgetId) return;
    const w = _widgets.find(x => x.id === widgetId);
    const aspect = Math.max(0.35, Math.min(3, (Number(w?.w) || 2) / (Number(w?.h) || 2)));
    try {
      window.showToast?.('上传中…');
      const { pickCropAndUpload } = await import('./media-crop.js');
      const result = await pickCropAndUpload(file, {
        title: `裁剪日历容器（${w?.w || 2}×${w?.h || 2}）`,
        aspect,
      });
      if (!result?.url) return;
      setCalendarBgUrl(widgetId, result.url);
      window.showToast?.('容器背景已更新');
    } catch (err) {
      window.showToast?.(err?.message || '上传失败');
    }
  });
  document.body.appendChild(input);
  return input;
}

function openCalendarBgPicker(widgetId) {
  _calBgPickWidgetId = widgetId;
  const w = _widgets.find(x => x.id === widgetId);
  const sizeHint = w ? `${w.w}×${w.h}` : '';
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (title) title.textContent = sizeHint ? `容器外观（${sizeHint}）` : '容器外观';
  if (widgets) widgets.hidden = true;
  if (menu) {
    menu.hidden = false;
    menu.innerHTML = `
      <p style="margin:4px 16px 12px;font-size:12px;color:var(--text-secondary);line-height:1.45">图片会铺满日历外框，请先调好小组件尺寸再裁剪。</p>
      <button type="button" class="home-add-item" data-cal-bg-src="phone">
        <span class="home-add-ico">📱</span>
        <span class="home-add-text"><b>手机相册</b><small>按日历比例裁剪后设为容器</small></span>
      </button>
      <button type="button" class="home-add-item" data-cal-bg-src="nian">
        <span class="home-add-ico">🖼️</span>
        <span class="home-add-text"><b>念相册</b><small>从角色相册里选一张图</small></span>
      </button>
      <button type="button" class="home-add-item" data-cal-bg-src="back">
        <span class="home-add-ico">‹</span>
        <span class="home-add-text"><b>返回样式</b><small>继续换日历布局</small></span>
      </button>`;
    menu.querySelector('[data-cal-bg-src="phone"]')?.addEventListener('click', () => {
      closeHomeAddSheet();
      ensureCalBgFileInput().click();
    });
    menu.querySelector('[data-cal-bg-src="nian"]')?.addEventListener('click', () => {
      openNianAlbumPickerForCalBg();
    });
    menu.querySelector('[data-cal-bg-src="back"]')?.addEventListener('click', () => {
      openCalendarStylePicker(null, widgetId);
    });
  }
  el.classList.add('active');
}

async function openNianAlbumPickerForCalBg() {
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (title) title.textContent = '念相册';
  if (menu) menu.hidden = true;
  if (!widgets) return;
  widgets.hidden = false;
  widgets.innerHTML = `
    <button type="button" class="home-add-back" id="home-cal-bg-back">‹ 返回</button>
    <div class="home-photo-picker-hint">加载角色相册…</div>`;
  widgets.querySelector('#home-cal-bg-back')?.addEventListener('click', () => openCalendarBgPicker(_calBgPickWidgetId));
  el.classList.add('active');

  const chars = window.getAppCharacters?.() || [];
  if (!chars.length) {
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-cal-bg-back">‹ 返回</button>
      <div class="home-photo-picker-hint">还没有角色相册</div>`;
    widgets.querySelector('#home-cal-bg-back')?.addEventListener('click', () => openCalendarBgPicker(_calBgPickWidgetId));
    return;
  }

  try {
    const api = await import('./api.js');
    const blocks = await Promise.all(chars.map(async (c) => {
      let items = [];
      try {
        items = await api.getAlbumItems(c.id, 'image');
      } catch {}
      const images = (Array.isArray(items) ? items : [])
        .filter(it => (it.media_type || 'image') === 'image' && it.url);
      if (!images.length) return '';
      return `
        <div class="home-photo-char">
          <div class="home-photo-char-name">${esc(c.name || '角色')}</div>
          <div class="home-photo-grid">
            ${images.slice(0, 24).map(it => `
              <button type="button" class="home-photo-thumb" data-cal-bg-url="${esc(it.url)}">
                <img src="${esc(it.url)}" alt="" loading="lazy">
              </button>`).join('')}
          </div>
        </div>`;
    }));
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-cal-bg-back">‹ 返回</button>
      ${blocks.filter(Boolean).join('') || '<div class="home-photo-picker-hint">相册里还没有图片</div>'}`;
    widgets.querySelector('#home-cal-bg-back')?.addEventListener('click', () => openCalendarBgPicker(_calBgPickWidgetId));
    widgets.querySelectorAll('[data-cal-bg-url]').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-cal-bg-url');
        if (!url || !_calBgPickWidgetId) return;
        setCalendarBgUrl(_calBgPickWidgetId, url);
        closeHomeAddSheet();
        window.showToast?.('容器背景已更新');
      });
    });
  } catch (err) {
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-cal-bg-back">‹ 返回</button>
      <div class="home-photo-picker-hint">${esc(err?.message || '加载失败')}</div>`;
    widgets.querySelector('#home-cal-bg-back')?.addEventListener('click', () => openCalendarBgPicker(_calBgPickWidgetId));
  }
}

function ensurePhotoFileInput() {
  let input = document.getElementById('home-photo-file-input');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.id = 'home-photo-file-input';
  input.accept = 'image/*,image/gif,image/webp';
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    const widgetId = _photoPickWidgetId;
    if (!file || !widgetId) return;
    const w = _widgets.find(x => x.id === widgetId);
    const aspect = Math.max(0.35, Math.min(3, (Number(w?.w) || 2) / (Number(w?.h) || 2)));
    try {
      window.showToast?.('上传中…');
      const { pickCropAndUpload } = await import('./media-crop.js');
      const result = await pickCropAndUpload(file, {
        title: `裁剪相册（${w?.w || 2}×${w?.h || 2}）`,
        aspect,
      });
      if (!result?.url) return;
      setWidgetImage(widgetId, result.url);
      window.showToast?.('图片已添加');
    } catch (err) {
      window.showToast?.(err?.message || '上传失败');
    }
  });
  document.body.appendChild(input);
  return input;
}

function openPhotoSourceSheet(widgetId) {
  _photoPickWidgetId = widgetId;
  const w = _widgets.find(x => x.id === widgetId);
  const sizeHint = w ? `${w.w}×${w.h}` : '';
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (title) title.textContent = sizeHint ? `选择图片（${sizeHint}）` : '选择图片';
  if (widgets) widgets.hidden = true;
  if (menu) {
    menu.hidden = false;
    menu.innerHTML = `
      <p style="margin:4px 16px 12px;font-size:12px;color:var(--text-secondary);line-height:1.45">将按当前相册大小 ${sizeHint || ''} 裁剪，请先在桌面上调好尺寸。</p>
      <button type="button" class="home-add-item" data-photo-src="phone">
        <span class="home-add-ico">📱</span>
        <span class="home-add-text"><b>手机相册</b><small>按小组件比例裁剪后添加</small></span>
      </button>
      <button type="button" class="home-add-item" data-photo-src="nian">
        <span class="home-add-ico">🖼️</span>
        <span class="home-add-text"><b>念相册</b><small>从角色相册里选一张图</small></span>
      </button>`;
    menu.querySelector('[data-photo-src="phone"]')?.addEventListener('click', () => {
      closeHomeAddSheet();
      ensurePhotoFileInput().click();
    });
    menu.querySelector('[data-photo-src="nian"]')?.addEventListener('click', () => {
      openNianAlbumPicker();
    });
  }
  el.classList.add('active');
}

async function openNianAlbumPicker() {
  const el = ensureAddOverlay();
  const title = document.getElementById('home-add-title');
  const menu = document.getElementById('home-add-menu');
  const widgets = document.getElementById('home-add-widgets');
  if (title) title.textContent = '念相册';
  if (menu) menu.hidden = true;
  if (!widgets) return;
  widgets.hidden = false;
  widgets.innerHTML = `
    <button type="button" class="home-add-back" id="home-photo-back">‹ 返回</button>
    <div class="home-photo-picker-hint">加载角色相册…</div>`;
  widgets.querySelector('#home-photo-back')?.addEventListener('click', () => openPhotoSourceSheet(_photoPickWidgetId));
  el.classList.add('active');

  const chars = window.getAppCharacters?.() || [];
  if (!chars.length) {
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-photo-back">‹ 返回</button>
      <div class="home-photo-picker-hint">还没有角色相册</div>`;
    widgets.querySelector('#home-photo-back')?.addEventListener('click', () => openPhotoSourceSheet(_photoPickWidgetId));
    return;
  }

  try {
    const api = await import('./api.js');
    const blocks = await Promise.all(chars.map(async (c) => {
      let items = [];
      try {
        items = await api.getAlbumItems(c.id, 'image');
      } catch {}
      const images = (Array.isArray(items) ? items : [])
        .filter(it => (it.media_type || 'image') === 'image' && it.url);
      if (!images.length) return '';
      return `
        <div class="home-photo-char">
          <div class="home-photo-char-name">${esc(c.name || '角色')}</div>
          <div class="home-photo-grid">
            ${images.map(it => `
              <button type="button" class="home-photo-tile" data-photo-url="${esc(it.url)}" title="${esc(it.description || '')}">
                <img src="${esc(it.url)}" alt="" loading="lazy">
              </button>`).join('')}
          </div>
        </div>`;
    }));
    const body = blocks.filter(Boolean).join('');
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-photo-back">‹ 返回</button>
      ${body || '<div class="home-photo-picker-hint">相册里还没有图片</div>'}`;
    widgets.querySelector('#home-photo-back')?.addEventListener('click', () => openPhotoSourceSheet(_photoPickWidgetId));
    widgets.querySelectorAll('[data-photo-url]').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-photo-url');
        closeHomeAddSheet();
        setWidgetImage(_photoPickWidgetId, url);
        window.showToast?.('已选用念相册图片');
      });
    });
  } catch (err) {
    widgets.innerHTML = `
      <button type="button" class="home-add-back" id="home-photo-back">‹ 返回</button>
      <div class="home-photo-picker-hint">${esc(err?.message || '加载失败')}</div>`;
    widgets.querySelector('#home-photo-back')?.addEventListener('click', () => openPhotoSourceSheet(_photoPickWidgetId));
  }
}

/* ─── pointer / drag ─── */
function clearPressTimer() {
  if (_pressTimer) {
    clearTimeout(_pressTimer);
    _pressTimer = null;
  }
}

function pointerPos(e) {
  if (e.touches?.[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  return { x: e.clientX, y: e.clientY };
}

function findIconFromEvent(e) {
  return e.target?.closest?.('.home-icon') || null;
}

function stepWidgetSize(id, dim, delta) {
  const w = _widgets.find(x => x.id === id);
  if (!w || !delta) return;
  const n = getGridSize();
  const trial = { ...w };
  if (dim === 'w') trial.w = Math.max(1, Math.min(n - w.col, w.w + delta));
  else if (dim === 'h') trial.h = Math.max(1, Math.min(n - w.row, w.h + delta));
  else return;
  if (trial.w === w.w && trial.h === w.h) return;

  const occ = occupiedSlotSet(w.id);
  const trialSlots = widgetSlotIndices(trial);
  if (trialSlots.some(s => occ.has(s))) {
    if (delta > 0) window.showToast?.('那边没空位了');
    return;
  }
  ensurePageExists(w.page);
  evacuateIconsFromSlots(trialSlots);
  w.w = trial.w;
  w.h = trial.h;
  saveLayout();
  renderAll();
  if (_editMode) {
    document.querySelectorAll('.home-icon,.home-widget').forEach(el => el.classList.add('jiggling'));
  }
  if (navigator.vibrate) try { navigator.vibrate(8); } catch {}
}

function startWidgetResizeById(id, axis = 'se', startPos = null) {
  const w = _widgets.find(x => x.id === id);
  if (!w) return;
  _resize = {
    id,
    axis: axis || 'se',
    startX: startPos?.x ?? null,
    startY: startPos?.y ?? null,
    startW: w.w,
    startH: w.h,
  };
  clearPressTimer();
  document.querySelector(`.home-widget[data-widget-id="${CSS.escape(id)}"]`)?.classList.add('home-widget--resizing');
  if (navigator.vibrate) try { navigator.vibrate(8); } catch {}
}

function updateWidgetResize(x, y) {
  if (!_resize) return;
  const w = _widgets.find(item => item.id === _resize.id);
  if (!w) return;

  let next = null;
  if (_resize.startX != null && _resize.startY != null) {
    const m = getGridMetrics(w.page);
    if (!m) return;
    const dw = Math.round((x - _resize.startX) / m.cellW);
    const dh = Math.round((y - _resize.startY) / m.cellH);
    let nw = _resize.startW;
    let nh = _resize.startH;
    if (_resize.axis === 'e' || _resize.axis === 'se') {
      nw = Math.max(1, Math.min(m.n - w.col, _resize.startW + dw));
    }
    if (_resize.axis === 's' || _resize.axis === 'se') {
      nh = Math.max(1, Math.min(m.n - w.row, _resize.startH + dh));
    }
    next = { w: nw, h: nh };
  } else {
    next = computeResizeFromPoint(x, y, w, _resize.axis);
  }
  if (!next) return;
  const trial = { ...w, w: next.w, h: next.h };
  if (trial.w === w.w && trial.h === w.h) return;
  if (!widgetFits(trial, w.id)) return;
  w.w = trial.w;
  w.h = trial.h;
  applyWidgetGridStyle(w.id);
}

function endWidgetResize() {
  if (!_resize) return;
  const id = _resize.id;
  document.querySelector(`.home-widget[data-widget-id="${CSS.escape(id)}"]`)?.classList.remove('home-widget--resizing');
  const w = _widgets.find(x => x.id === id);
  if (w) {
    const slots = widgetSlotIndices(w);
    evacuateIconsFromSlots(slots);
  }
  _resize = null;
  saveLayout();
  renderAll();
  if (_editMode) {
    document.querySelectorAll('.home-icon,.home-widget').forEach(el => el.classList.add('jiggling'));
  }
}

function findWidgetFromEvent(e) {
  if (e.target?.closest?.('.home-widget-del')
    || e.target?.closest?.('.home-widget-style')
    || e.target?.closest?.('[data-resize]')
    || e.target?.closest?.('[data-size-dim]')
    || e.target?.closest?.('.home-widget-sides')
    || e.target?.closest?.('.hw-notes-input')) return null;
  return e.target?.closest?.('.home-widget') || null;
}

function findFloatFromEvent(e) {
  if (e.target?.closest?.('.home-widget-del')
    || e.target?.closest?.('.home-widget-style')
    || e.target?.closest?.('[data-header-clock-del]')
    || e.target?.closest?.('[data-header-char-del]')
    || e.target?.closest?.('[data-header-clock-style]')) return null;
  const float = e.target?.closest?.('.home-float');
  if (!float) return null;
  // 角色角标在非编辑模式留给点击进衣柜；时钟允许长按拖动
  if (!_editMode && float.dataset.float === 'char' && e.target?.closest?.('.home-char-corner')) {
    return null;
  }
  return float;
}

function isBlankDesktopTarget(e) {
  if (findIconFromEvent(e) || findWidgetFromEvent(e) || findFloatFromEvent(e)) return false;
  if (e.target?.closest?.('#home-folder-overlay')) return false;
  if (e.target?.closest?.('.home-dock-wrap')) return false;
  if (e.target?.closest?.('.home-float')) return false;
  if (e.target?.closest?.('.home-edit-done') || e.target?.closest?.('.home-edit-add')) return false;
  return !!(e.target?.closest?.('#home-launcher') || e.target?.closest?.('#home-page'));
}

function getZoneArray(zone) {
  return zone === 'dock' ? _dock : _grid;
}

function findKeyLocation(key) {
  for (let i = 0; i < _grid.length; i++) {
    const s = _grid[i];
    if (s === key) return { zone: 'grid', index: i };
    if (isFolder(s) && s.items.includes(key)) {
      return { zone: 'folder', index: i, folderId: s.id, itemIndex: s.items.indexOf(key) };
    }
  }
  return null;
}

function findFolderIndex(id) {
  return _grid.findIndex(s => isFolder(s) && s.id === id);
}

function takeFromFolder(folderId, key) {
  const idx = findFolderIndex(folderId);
  if (idx < 0) return null;
  const folder = _grid[idx];
  if (!folder.items.includes(key)) return null;
  folder.items = folder.items.filter(k => k !== key);
  if (folder.items.length <= 1) {
    _grid[idx] = folder.items[0] || null;
  }
  return key;
}

function combineSlots(a, b) {
  const keysA = isFolder(a) ? [...a.items] : (slotAppKey(a) ? [a] : []);
  const keysB = isFolder(b) ? [...b.items] : (slotAppKey(b) ? [b] : []);
  const items = [];
  for (const k of [...keysA, ...keysB]) {
    if (k && APP_MAP[k] && !items.includes(k)) items.push(k);
  }
  if (items.length <= 1) return items[0] || null;
  const created = !isFolder(a) && !isFolder(b);
  const name = isFolder(a) ? a.name : (isFolder(b) ? b.name : '文件夹');
  const id = isFolder(a) ? a.id : (isFolder(b) ? b.id : folderUid());
  const folder = { type: 'folder', id, name: name || '文件夹', items };
  if (created && _drag) _drag.openedFolderId = folder.id;
  return folder;
}

function placeInFirstEmpty(val) {
  const slot = normalizeSlot(val);
  if (!slot) return -1;
  let dest = firstFreeGridIndex(_grid);
  if (dest < 0) {
    dest = _grid.length;
    _grid.push(slot);
    while (_grid.length % slotsPerPage() !== 0) _grid.push(null);
  } else {
    while (_grid.length <= dest) _grid.push(null);
    _grid[dest] = slot;
  }
  return dest;
}

function startIconDrag(icon, e) {
  const key = icon.dataset.appKey || null;
  const folderId = icon.dataset.folderId || null;
  if (!key && !folderId) return;
  const zone = icon.dataset.zone || 'grid';
  const slot = Number(icon.dataset.slot);
  const pos = pointerPos(e);
  const rect = icon.getBoundingClientRect();
  _drag = {
    kind: 'icon',
    key,
    folderId,
    zone,
    index: Number.isFinite(slot) ? slot : (key ? (findKeyLocation(key)?.index ?? -1) : findFolderIndex(folderId)),
    offsetX: pos.x - rect.left,
    offsetY: pos.y - rect.top,
    ghost: null,
    lastZone: zone === 'dock' ? 'dock' : 'grid',
    lastIndex: Number.isFinite(slot) ? slot : -1,
    stackZone: null,
    stackIndex: null,
    stackPending: null,
    stackAt: 0,
    openedFolderId: null,
    edgeDir: 0,
    edgeAt: 0,
  };
  icon.classList.add('dragging');
  icon.classList.remove('jiggling');
  const ghost = icon.cloneNode(true);
  ghost.classList.add('home-icon-ghost');
  ghost.classList.remove('jiggling', 'dragging');
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  document.body.appendChild(ghost);
  _drag.ghost = ghost;
  moveGhost(pos.x, pos.y);
}

function startFloatDrag(floatEl, e) {
  const kind = floatEl.dataset.float;
  if (kind !== 'clock' && kind !== 'char') return;
  const pos = pointerPos(e);
  const sheet = floatEl.closest('.home-page-sheet') || document.querySelector('.home-page-sheet--home');
  const rect = floatEl.getBoundingClientRect();
  // 相对整页拖动，不再限制在顶部窄带
  const bandRect = sheet?.getBoundingClientRect();
  _drag = {
    kind: 'float',
    floatKind: kind,
    offsetX: pos.x - rect.left,
    offsetY: pos.y - rect.top,
    ghost: null,
    sheetRect: bandRect ? {
      left: bandRect.left,
      top: bandRect.top,
      width: bandRect.width,
      height: bandRect.height,
    } : null,
  };
  floatEl.classList.add('dragging');
  floatEl.classList.remove('jiggling');
  const ghost = floatEl.cloneNode(true);
  ghost.classList.add('home-icon-ghost');
  ghost.classList.remove('jiggling', 'dragging');
  ghost.querySelectorAll('button').forEach((b) => b.remove());
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  document.body.appendChild(ghost);
  _drag.ghost = ghost;
  moveGhost(pos.x, pos.y);
}

function commitFloatDrag(pos) {
  if (!_drag || _drag.kind !== 'float' || !_drag.sheetRect) return;
  const sr = _drag.sheetRect;
  const leftPx = pos.x - _drag.offsetX - sr.left;
  const topPx = pos.y - _drag.offsetY - sr.top;
  const left = Math.max(0, Math.min(86, (leftPx / Math.max(1, sr.width)) * 100));
  const top = Math.max(0, Math.min(88, (topPx / Math.max(1, sr.height)) * 100));
  if (_drag.floatKind === 'clock') {
    saveHeaderClockConfig({ ...getHeaderClockConfig(), left, top });
  } else {
    saveHeaderCharConfig({ ...getHeaderCharConfig(), left, top });
  }
}

function startWidgetDrag(widgetEl, e) {
  const id = widgetEl.dataset.widgetId;
  const w = _widgets.find(x => x.id === id);
  if (!w) return;
  const pos = pointerPos(e);
  const rect = widgetEl.getBoundingClientRect();
  _drag = {
    kind: 'widget',
    id,
    offsetX: pos.x - rect.left,
    offsetY: pos.y - rect.top,
    ghost: null,
    lastPage: w.page,
    lastCol: w.col,
    lastRow: w.row,
    edgeDir: 0,
    edgeAt: 0,
  };
  widgetEl.classList.add('dragging');
  widgetEl.classList.remove('jiggling');
  const ghost = widgetEl.cloneNode(true);
  ghost.classList.add('home-icon-ghost');
  ghost.classList.remove('jiggling', 'dragging');
  ghost.querySelector('.home-widget-del')?.remove();
  ghost.querySelector('.home-widget-size-tag')?.remove();
  ghost.querySelector('.home-widget-style')?.remove();
  ghost.querySelector('.home-widget-sides')?.remove();
  ghost.querySelectorAll('[data-resize]').forEach(el => el.remove());
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  document.body.appendChild(ghost);
  _drag.ghost = ghost;
  moveGhost(pos.x, pos.y);
}

function moveGhost(x, y) {
  if (!_drag?.ghost) return;
  _drag.ghost.style.left = `${x - _drag.offsetX}px`;
  _drag.ghost.style.top = `${y - _drag.offsetY}px`;
}

function slotAtPoint(x, y) {
  const prev = _drag?.ghost?.style.visibility;
  if (_drag?.ghost) _drag.ghost.style.visibility = 'hidden';
  const el = document.elementFromPoint(x, y);
  if (_drag?.ghost) _drag.ghost.style.visibility = prev || '';

  const slot = el?.closest?.('.home-icon-slot');
  if (slot) {
    const zone = slot.dataset.zone;
    const index = Number(slot.dataset.slot);
    if ((zone === 'grid' || zone === 'dock') && Number.isFinite(index)) return { zone, index };
  }

  // 空白格 / 网格区域：按图标网格坐标换算落点
  const gridEl = el?.closest?.('.home-page-grid')
    || document.querySelector(`.home-page-sheet[data-page="${_pageIndex}"] .home-page-grid`);
  if (gridEl) {
    const page = Number(gridEl.closest('.home-page-sheet')?.dataset.page);
    const rect = gridEl.getBoundingClientRect();
    if (Number.isFinite(page) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const n = getGridSize();
      const col = Math.max(0, Math.min(n - 1, Math.floor(((x - rect.left) / rect.width) * n)));
      const row = Math.max(0, Math.min(n - 1, Math.floor(((y - rect.top) / rect.height) * n)));
      return { zone: 'grid', index: page * n * n + row * n + col, page, col, row };
    }
  }
  return null;
}

function clearStackHover() {
  document.querySelectorAll('.home-icon-slot--stack').forEach(el => el.classList.remove('home-icon-slot--stack'));
  if (_drag) {
    _drag.stackZone = null;
    _drag.stackIndex = null;
    _drag.stackPending = null;
    _drag.stackAt = 0;
  }
}

function setStackHover(index) {
  if (_drag.stackPending === index) {
    if (_drag.stackIndex !== index && Date.now() - (_drag.stackAt || 0) > 260) {
      _drag.stackIndex = index;
      _drag.stackZone = 'grid';
      document.querySelector(`.home-icon-slot[data-zone="grid"][data-slot="${index}"]`)?.classList.add('home-icon-slot--stack');
    }
    return;
  }
  document.querySelectorAll('.home-icon-slot--stack').forEach(el => el.classList.remove('home-icon-slot--stack'));
  _drag.stackPending = index;
  _drag.stackAt = Date.now();
  _drag.stackIndex = null;
  _drag.stackZone = null;
}

function mergeDraggedInto(index) {
  if (!_drag || index < 0) return false;
  const dst = _grid[index];
  if (!dst) return false;

  let srcVal = null;
  const srcZone = _drag.lastZone || _drag.zone || 'grid';
  if (_drag.lastIndex >= 0 && !(srcZone === 'grid' && _drag.lastIndex === index)) {
    if (srcZone === 'dock') {
      if (_drag.lastIndex >= 0 && _drag.lastIndex < DOCK_SLOTS) {
        srcVal = _dock[_drag.lastIndex];
        _dock[_drag.lastIndex] = null;
      }
    } else {
      srcVal = _grid[_drag.lastIndex];
      _grid[_drag.lastIndex] = null;
    }
  } else if (_drag.lastIndex < 0 && _drag.key) {
    srcVal = _drag.key;
  } else if (_drag.lastIndex < 0 && _drag.folderId) {
    const i = findFolderIndex(_drag.folderId);
    if (i >= 0 && i !== index) {
      srcVal = _grid[i];
      _grid[i] = null;
    }
  }
  if (!srcVal || srcVal === dst) return false;
  if (isFolder(srcVal) && srcZone === 'dock') return false;
  _grid[index] = combineSlots(dst, srcVal);
  return true;
}

function moveIconToSlot(targetZone, targetIndex) {
  if (!_drag || _drag.kind !== 'icon') return;
  if (targetZone !== 'grid' && targetZone !== 'dock') return;
  if (!Number.isFinite(targetIndex) || targetIndex < 0) return;
  if (targetZone === 'dock' && (targetIndex >= DOCK_SLOTS || _drag.folderId)) return;

  const srcZone = _drag.lastZone || _drag.zone || 'grid';
  const srcIndex = _drag.lastIndex;

  // 底栏 ↔ 桌面 / 底栏内：直接移动或互换（文件夹不能进底栏）
  if (targetZone === 'dock' || srcZone === 'dock') {
    clearStackHover();
    if (srcZone === targetZone && srcIndex === targetIndex) return;

    let srcVal = null;
    if (srcZone === 'dock' && srcIndex >= 0 && srcIndex < DOCK_SLOTS) {
      srcVal = _dock[srcIndex];
    } else if (srcZone === 'grid' && srcIndex >= 0) {
      while (_grid.length <= srcIndex) _grid.push(null);
      srcVal = _grid[srcIndex];
    } else if (_drag.key) {
      srcVal = _drag.key;
    } else if (_drag.folderId) {
      return;
    }
    if (!srcVal) return;
    if (targetZone === 'dock' && isFolder(srcVal)) return;

    while (_dock.length < DOCK_SLOTS) _dock.push(null);
    if (targetZone === 'grid') {
      const occ = occupiedSlotSet();
      // 互换时目标格上的图标会挪走，不占位冲突
      const dstPeek = _grid[targetIndex];
      if (occ.has(targetIndex) && !dstPeek) {
        return;
      }
      while (_grid.length <= targetIndex) _grid.push(null);
      // 底栏拖到桌面文件夹上：叠入文件夹，避免文件夹被换到底栏
      if (dstPeek && isFolder(dstPeek) && srcZone === 'dock' && !isFolder(srcVal)) {
        setStackHover(targetIndex);
        return;
      }
    }

    const dstArr = targetZone === 'dock' ? _dock : _grid;
    const srcArr = srcZone === 'dock' ? _dock : _grid;
    const displaced = dstArr[targetIndex] || null;
    // 文件夹不能进底栏（互换时也不行）
    if (displaced && isFolder(displaced) && (srcZone === 'dock' || targetZone === 'dock')) {
      clearStackHover();
      return;
    }

    if (srcZone === 'dock' || srcZone === 'grid') {
      if (srcIndex >= 0) srcArr[srcIndex] = null;
    }
    dstArr[targetIndex] = srcVal;

    if (displaced) {
      if (srcZone === 'dock' || srcZone === 'grid') {
        if (srcIndex >= 0) srcArr[srcIndex] = displaced;
        else placeInFirstEmpty(displaced);
      } else {
        placeInFirstEmpty(displaced);
      }
    }

    _drag.key = slotAppKey(srcVal) || _drag.key;
    _drag.folderId = isFolder(srcVal) ? srcVal.id : null;
    _drag.lastZone = targetZone;
    _drag.lastIndex = targetIndex;
    _drag.zone = targetZone;
    _drag.index = targetIndex;
    renderAll();
    return;
  }

  if (targetZone !== 'grid') return;
  const occ = occupiedSlotSet();
  if (occ.has(targetIndex)) {
    clearStackHover();
    return;
  }

  while (_grid.length <= targetIndex) _grid.push(null);

  const dstVal = _grid[targetIndex];
  const srcIdx = _drag.lastIndex;

  if (dstVal && srcIdx !== targetIndex) {
    const sameFolder = isFolder(dstVal) && _drag.folderId && dstVal.id === _drag.folderId;
    if (sameFolder) {
      clearStackHover();
      return;
    }
    setStackHover(targetIndex);
    return;
  }

  clearStackHover();
  if (srcIdx === targetIndex) return;
  if (dstVal) return;

  if (srcIdx >= 0) {
    const val = _grid[srcIdx];
    if (!val) return;
    _grid[srcIdx] = null;
    _grid[targetIndex] = val;
  } else if (_drag.key) {
    _grid[targetIndex] = _drag.key;
  } else if (_drag.folderId) {
    const i = findFolderIndex(_drag.folderId);
    if (i < 0) return;
    _grid[targetIndex] = _grid[i];
    if (i !== targetIndex) _grid[i] = null;
  } else {
    return;
  }
  _drag.lastZone = 'grid';
  _drag.lastIndex = targetIndex;
  _drag.zone = 'grid';
  _drag.index = targetIndex;
  renderAll();
}

function moveWidgetToCell(page, col, row) {
  if (!_drag || _drag.kind !== 'widget') return;
  const w = _widgets.find(x => x.id === _drag.id);
  if (!w) return;
  const n = getGridSize();
  const maxCol = n - w.w;
  const maxRow = n - w.h;
  const nextCol = Math.max(0, Math.min(maxCol, col));
  const nextRow = Math.max(0, Math.min(maxRow, row));
  if (w.page === page && w.col === nextCol && w.row === nextRow) return;

  // 目标矩形是否与其它小组件重叠
  const trial = { ...w, page, col: nextCol, row: nextRow };
  const trialSlots = widgetSlotIndices(trial);
  const occ = occupiedSlotSet(w.id);
  if (trialSlots.some(s => occ.has(s))) return;

  ensurePageExists(page);
  evacuateIconsFromSlots(trialSlots);
  w.page = page;
  w.col = nextCol;
  w.row = nextRow;
  _drag.lastPage = page;
  _drag.lastCol = nextCol;
  _drag.lastRow = nextRow;
  renderAll();
}

function maybeAutoPage(x) {
  if (!_drag) return;
  const launcher = document.getElementById('home-launcher');
  if (!launcher) return;
  const rect = launcher.getBoundingClientRect();
  const now = Date.now();
  let dir = 0;
  if (x < rect.left + PAGE_EDGE_PX) dir = -1;
  else if (x > rect.right - PAGE_EDGE_PX) dir = 1;
  if (dir === 0) { _drag.edgeDir = 0; return; }
  if (_drag.edgeDir !== dir) { _drag.edgeDir = dir; _drag.edgeAt = now; return; }
  if (now - _drag.edgeAt < 280) return;

  // 拖到右缘且已是末页：先扩一页空白桌面
  if (dir > 0 && _pageIndex >= pageCount() - 1) {
    const per = slotsPerPage();
    for (let i = 0; i < per; i++) _grid.push(null);
    setMinPageCount(Math.max(getMinPageCount(), pageCount()));
    renderAll();
  }
  const next = clampPage(_pageIndex + dir);
  if (next === _pageIndex) return;
  _drag.edgeAt = now;
  goToPage(next, true);
}

function endDrag() {
  if (!_drag) return;
  const lastPos = _drag._lastPos;
  if (_drag.kind === 'float') {
    if (lastPos) commitFloatDrag(lastPos);
  } else if (_drag.kind === 'icon' && _drag.stackIndex == null && _drag.stackPending != null
      && Date.now() - (_drag.stackAt || 0) > 260) {
    _drag.stackIndex = _drag.stackPending;
  }
  if (_drag.kind === 'icon' && _drag.stackIndex != null) {
    mergeDraggedInto(_drag.stackIndex);
  } else if (_drag.kind === 'icon' && _drag.lastIndex < 0) {
    if (_drag.key) placeInFirstEmpty(_drag.key);
  }
  const openedFolderId = _drag.kind === 'icon' ? _drag.openedFolderId : null;
  _drag.ghost?.remove();
  document.querySelectorAll('.home-icon.dragging,.home-widget.dragging,.home-float.dragging,.home-icon-slot--stack').forEach(el => {
    el.classList.remove('dragging', 'home-icon-slot--stack');
  });
  _drag = null;
  _grid = padGridToPages(_grid, _widgets);
  setMinPageCount(Math.max(getMinPageCount(), pageCount()));
  saveLayout();
  renderAll();
  if (_editMode) {
    document.querySelectorAll('.home-icon,.home-widget,.home-float').forEach(el => el.classList.add('jiggling'));
  }
  if (openedFolderId) openFolder(openedFolderId, { focusName: true });
}

function onPointerDown(e) {
  const home = document.getElementById('home-page');
  if (!home?.classList.contains('active')) return;
  if (document.getElementById('home-add-overlay')?.classList.contains('active')) return;

  const icon = findIconFromEvent(e);
  const widget = findWidgetFromEvent(e);
  const float = (!icon && !widget) ? findFloatFromEvent(e) : null;
  const pos = pointerPos(e);

  if (icon) {
    const appKey = icon.dataset.appKey || null;
    const folderId = icon.dataset.folderId || null;
    const folderItem = icon.dataset.folderItem || null;
    _pressStart = { x: pos.x, y: pos.y, icon, widget: null, float: null, blank: false, moved: false, opened: false };
    clearPressTimer();
    _pressTimer = setTimeout(() => {
      if (!_pressStart || _pressStart.moved) return;
      _pressStart.opened = true;
      if (!_editMode) setEditMode(true);
      let target = icon;
      if (!folderItem) {
        target = (folderId
          ? document.querySelector(`.home-icon[data-folder-id="${CSS.escape(folderId)}"]`)
          : document.querySelector(`.home-icon[data-app-key="${CSS.escape(appKey)}"]`)) || icon;
        if (target) _pressStart.icon = target;
      }
      try { target.setPointerCapture?.(e.pointerId); } catch {}
      startIconDrag(target, e);
      if (folderItem && appKey) {
        takeFromFolder(folderItem, appKey);
        closeFolderOverlay();
        if (_drag) {
          _drag.lastIndex = -1;
          _drag.index = -1;
        }
      }
      if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
    }, LONG_PRESS_MS);
  } else if (widget) {
    const widgetId = widget.dataset.widgetId;
    _pressStart = { x: pos.x, y: pos.y, icon: null, widget, widgetId, float: null, blank: false, moved: false, opened: false };
    clearPressTimer();
    _pressTimer = setTimeout(() => {
      if (!_pressStart || _pressStart.moved) return;
      _pressStart.opened = true;
      if (!_editMode) setEditMode(true);
      const live = document.querySelector(`.home-widget[data-widget-id="${CSS.escape(widgetId)}"]`);
      const target = live || widget;
      if (live) _pressStart.widget = live;
      try { target.setPointerCapture?.(e.pointerId); } catch {}
      startWidgetDrag(target, e);
      if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
    }, LONG_PRESS_MS);
  } else if (float) {
    const floatKind = float.dataset.float;
    _pressStart = { x: pos.x, y: pos.y, icon: null, widget: null, float, floatKind, blank: false, moved: false, opened: false };
    clearPressTimer();
    _pressTimer = setTimeout(() => {
      if (!_pressStart || _pressStart.moved) return;
      _pressStart.opened = true;
      const wasEditing = _editMode;
      if (!_editMode) setEditMode(true);
      const live = document.querySelector(`.home-float[data-float="${CSS.escape(floatKind)}"]`);
      const target = live || float;
      if (live) _pressStart.float = live;
      try { target.setPointerCapture?.(e.pointerId); } catch {}
      // 若刚进入编辑触发了重渲，用新节点开拖；已在编辑则原地拖
      startFloatDrag(target, wasEditing ? e : {
        ...e,
        clientX: e.clientX,
        clientY: e.clientY,
        touches: e.touches,
      });
      if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
    }, LONG_PRESS_MS);
  } else if (isBlankDesktopTarget(e)) {
    _pressStart = { x: pos.x, y: pos.y, icon: null, widget: null, float: null, blank: true, moved: false, opened: false };
    clearPressTimer();
    _pressTimer = setTimeout(() => {
      if (!_pressStart || _pressStart.moved) return;
      _pressStart.opened = true;
      if (navigator.vibrate) try { navigator.vibrate(10); } catch {}
      openHomeAddSheet('menu');
    }, LONG_PRESS_MS);
  } else {
    _pressStart = null;
  }

  _swipe = {
    x0: pos.x,
    y0: pos.y,
    dx: 0,
    active: false,
    // 点在时钟/角色浮层上时不抢滑动，方便长按拖动
    tracking: document.getElementById('home-folder-overlay')?.classList.contains('active')
      ? false
      : (!(icon || widget || float) || (!_editMode && !float)),
  };
}

function onPointerMove(e) {
  const pos = pointerPos(e);
  if (_pressStart && !_drag && !_resize) {
    if (Math.hypot(pos.x - _pressStart.x, pos.y - _pressStart.y) > 10) {
      _pressStart.moved = true;
      clearPressTimer();
      if (_pressStart.widget && _editMode && !_pressStart.opened) {
        _pressStart.opened = true;
        try { _pressStart.widget.setPointerCapture?.(e.pointerId); } catch {}
        startWidgetDrag(_pressStart.widget, e);
      } else if (_pressStart.float && _editMode && !_pressStart.opened) {
        _pressStart.opened = true;
        try { _pressStart.float.setPointerCapture?.(e.pointerId); } catch {}
        startFloatDrag(_pressStart.float, e);
      }
    }
  }

  if (_resize) {
    e.preventDefault?.();
    updateWidgetResize(pos.x, pos.y);
    return;
  }

  if (_drag) {
    e.preventDefault?.();
    _drag._lastPos = pos;
    moveGhost(pos.x, pos.y);
    if (_drag.kind === 'float') return;
    maybeAutoPage(pos.x);
    const hit = slotAtPoint(pos.x, pos.y);
    if (_drag.kind === 'icon' && hit) moveIconToSlot(hit.zone, hit.index);
    if (_drag.kind === 'widget' && hit) {
      const n = getGridSize();
      const page = hit.page != null ? hit.page : Math.floor(hit.index / (n * n));
      const local = hit.index % (n * n);
      const col = hit.col != null ? hit.col : (local % n);
      const row = hit.row != null ? hit.row : Math.floor(local / n);
      moveWidgetToCell(page, col, row);
    }
    return;
  }

  if (!_swipe?.tracking) return;
  const wrap = document.querySelector('.home-dock-wrap');
  if (wrap && !wrap.hidden) {
    const dock = document.getElementById('home-dock');
    if (dock) {
      const r = dock.getBoundingClientRect();
      if (pos.y >= r.top) { _swipe.tracking = false; return; }
    }
  }
  const dx = pos.x - _swipe.x0;
  const dy = pos.y - _swipe.y0;
  if (!_swipe.active) {
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
    if (Math.abs(dy) > Math.abs(dx)) { _swipe.tracking = false; return; }
    _swipe.active = true;
    clearPressTimer();
    if (_pressStart) _pressStart.moved = true;
  }
  _swipe.dx = dx;
  const pagesEl = document.getElementById('home-pages');
  const pages = pageCount();
  if (!pagesEl || pages <= 1) return;
  const base = -(_pageIndex / pages) * 100;
  const deltaPct = (dx / (pagesEl.parentElement?.clientWidth || window.innerWidth)) * (100 / pages);
  pagesEl.style.transition = 'none';
  pagesEl.style.transform = `translate3d(${base + deltaPct}%,0,0)`;
}

function onPointerUp(e) {
  clearPressTimer();
  if (_resize) {
    endWidgetResize();
    _swipe = null;
    _pressStart = null;
    return;
  }
  if (_drag) {
    endDrag();
    _swipe = null;
    _pressStart = null;
    return;
  }
  if (_swipe?.active) {
    const w = document.getElementById('home-launcher')?.clientWidth || window.innerWidth;
    const threshold = Math.min(80, w * 0.18);
    if (_swipe.dx <= -threshold) goToPage(_pageIndex + 1, true);
    else if (_swipe.dx >= threshold) goToPage(_pageIndex - 1, true);
    else applyPageTransform(true);
    _swipe = null;
    _pressStart = null;
    return;
  }

  const start = _pressStart;
  _pressStart = null;
  _swipe = null;
  if (!start || start.moved || start.opened) return;

  if (start.blank) {
    if (_editMode) setEditMode(false);
    return;
  }

  if (start.widget) {
    const type = start.widget.dataset.widgetType;
    if (_editMode) {
      if (type === 'photo') {
        const w = _widgets.find(x => x.id === start.widget.dataset.widgetId);
        if (w && !w.imageUrl) openPhotoSourceSheet(w.id);
      }
      return;
    }
    if (type === 'character') navigateFromHome(window.getActiveCharId?.() ? 'wardrobe' : 'character');
    else if (type === 'schedule') navigateFromHome('schedule');
    else if (type === 'photo') {
      const w = _widgets.find(x => x.id === start.widget.dataset.widgetId);
      if (w && !w.imageUrl) openPhotoSourceSheet(w.id);
    }
    else if (type === 'weather') {
      const w = _widgets.find(x => x.id === start.widget.dataset.widgetId);
      const snap = w?._weatherSnapshot;
      if (snap) {
        const bits = [`${snap.place} ${snap.desc}`, `${Math.round(snap.temp)}°`];
        if (Number.isFinite(Number(snap.tmin)) && Number.isFinite(Number(snap.tmax))) {
          bits.push(`今日 ${Math.round(snap.tmin)}~${Math.round(snap.tmax)}°`);
        }
        window.showToast?.(bits.join(' · '));
      }
    }
    else if (type === 'calendar') openMonthCalendarSheet();
    else if (type === 'clock') openCharacterAlarmsSheet();
    return;
  }

  const icon = start.icon;
  if (icon?.dataset.folderId) {
    openFolder(icon.dataset.folderId);
    return;
  }
  if (icon?.dataset.folderItem) {
    if (_editMode) return;
    const app = APP_MAP[icon.dataset.appKey];
    closeFolderOverlay();
    if (app) navigateFromHome(app.page);
    return;
  }
  if (!icon || _editMode) {
    if (_editMode && !findIconFromEvent(e) && !findWidgetFromEvent(e)) setEditMode(false);
    return;
  }
  const app = APP_MAP[icon.dataset.appKey];
  if (app) navigateFromHome(app.page);
}

/** 主页 pointerup 之后浏览器还会再派一次 click；此时页面已切走，会点到新页同一位置（例如设置里的「用户信息」→ 通讯「我」） */
function navigateFromHome(page) {
  if (!page) return;
  if (page === 'memory') {
    window._memoryMode = 'brain';
    window._memoryInitTab = 'exp';
  }
  if (page === 'wardrobe') {
    const cid = Number(window.getActiveCharId?.() || 0);
    if (!cid) {
      window.showToast?.('请先选择角色');
      page = 'character';
    } else {
      window._wardrobeCharId = cid;
    }
  }
  const shield = (ev) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  document.addEventListener('click', shield, true);
  setTimeout(() => document.removeEventListener('click', shield, true), 480);
  window.navigateTo?.(page);
}

function onPointerCancel() {
  clearPressTimer();
  if (_resize) endWidgetResize();
  if (_drag) endDrag();
  _pressStart = null;
  _swipe = null;
  applyPageTransform(true);
}

function bindEvents() {
  const home = document.getElementById('home-page');
  if (!home || home.dataset.launcherBound) return;
  home.dataset.launcherBound = '1';

  home.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);

  document.getElementById('home-edit-done')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setEditMode(false);
  });
  document.getElementById('home-edit-add')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openHomeWidgetsStyleSheet();
  });

  home.addEventListener('dragstart', e => e.preventDefault());
  home.addEventListener('contextmenu', e => {
    if (e.target.closest('.home-icon') || e.target.closest('.home-widget') || e.target.closest('.home-float') || e.target.closest('#home-launcher')) {
      e.preventDefault();
    }
  });
  home.addEventListener('click', e => {
    if (e.target.closest('.home-icon')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.target.closest('.home-char-corner')) {
      if (_editMode || _drag) return;
      window.navigateTo?.(window.getActiveCharId?.() ? 'wardrobe' : 'character');
    }
    if (e.target.closest('.home-header-clock-host')) {
      if (_editMode || _drag) return;
      openCharacterAlarmsSheet();
    }
  }, true);

  setInterval(tickWidgetClocks, 1000);
  setInterval(refreshWeatherWidgets, 30 * 60 * 1000);
}

export function initHomeDesktop() {
  const layout = loadLayout();
  _dock = layout.dock;
  _grid = layout.grid;
  _pageIndex = clampPage(_pageIndex);
  // 写回一次：清掉已下架图标（如朋友圈）在旧布局里的残留
  saveLayout();
  renderAll();
  bindEvents();
  _inited = true;
}

export function refreshHomeDesktop() {
  if (!_inited) {
    initHomeDesktop();
    return;
  }
  const layout = loadLayout();
  _dock = layout.dock;
  _grid = layout.grid;
  _widgets = loadWidgets();
  _pageIndex = clampPage(_pageIndex);
  renderAll();
}

export function setHomeGridSize(n) {
  const size = [4, 5, 6, 7].includes(Number(n)) ? Number(n) : 4;
  localStorage.setItem('beautify_home_grid', String(size));
  const keys = _grid.filter(Boolean);
  // 小组件按新网格钳制
  _widgets = _widgets.map(w => {
    const def = WIDGET_MAP[w.type];
    if (!def) return w;
    const ww = Math.max(1, Math.min(size, Number(w.w) || def.w));
    const hh = Math.max(1, Math.min(size, Number(w.h) || def.h));
    return {
      ...w,
      w: ww,
      h: hh,
      col: Math.max(0, Math.min(size - ww, w.col)),
      row: Math.max(0, Math.min(size - hh, w.row)),
    };
  });
  _grid = padGridToPages(keys, _widgets);
  _pageIndex = 0;
  saveLayout();
  renderAll();
}

window.initHomeDesktop = initHomeDesktop;
window.refreshHomeDesktop = refreshHomeDesktop;
window.setHomeGridSize = setHomeGridSize;
window.openHomeAddSheet = openHomeAddSheet;
window.openHomeWidgetsStyleSheet = openHomeWidgetsStyleSheet;
window.addHomeBlankDesktop = addBlankDesktop;
window.addHomeWidget = addWidget;

/**
 * 公共节日：只在服务端查「今天是不是节」，不把整表塞进 prompt。
 * 公历固定日 + 农历对照（1900–2100）；清明按节气近似公式。
 */

// 农历年大小月 / 闰月比特表（1900–2100）
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
];

const SOLAR_HOLIDAYS = {
  '02-14': { name: '情人节', kind: 'romance' },
  '05-01': { name: '劳动节', kind: 'public' },
  '10-01': { name: '国庆节', kind: 'public' },
  '12-25': { name: '圣诞节', kind: 'western' },
};

const LUNAR_FESTIVALS = [
  { month: 1, day: 1, name: '春节', kind: 'festival' },
  { month: 1, day: 15, name: '元宵节', kind: 'festival' },
  { month: 5, day: 5, name: '端午节', kind: 'festival' },
  { month: 7, day: 7, name: '七夕', kind: 'romance' },
  { month: 8, day: 15, name: '中秋节', kind: 'festival' },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function leapMonth(year) {
  const info = LUNAR_INFO[year - 1900];
  return info ? info & 0xf : 0;
}

function leapDays(year) {
  if (!leapMonth(year)) return 0;
  return (LUNAR_INFO[year - 1900] & 0x10000) ? 30 : 29;
}

function monthDays(year, month) {
  return (LUNAR_INFO[year - 1900] & (0x10000 >> month)) ? 30 : 29;
}

function yearDays(year) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) {
    sum += (LUNAR_INFO[year - 1900] & i) ? 1 : 0;
  }
  return sum + leapDays(year);
}

function solarToLunar(sy, sm, sd) {
  if (sy < 1900 || sy > 2100) return null;
  let offset = Math.round((Date.UTC(sy, sm - 1, sd) - Date.UTC(1900, 0, 31)) / 86400000);
  if (offset < 0) return null;
  let year = 1900;
  let temp = 0;
  for (; year < 2101 && offset > 0; year++) {
    temp = yearDays(year);
    offset -= temp;
  }
  if (offset < 0) {
    offset += temp;
    year -= 1;
  }
  const leap = leapMonth(year);
  let isLeap = false;
  let month = 1;
  for (; month < 13 && offset > 0; month++) {
    if (leap > 0 && month === leap + 1 && !isLeap) {
      month -= 1;
      isLeap = true;
      temp = leapDays(year);
    } else {
      temp = monthDays(year, month);
    }
    if (isLeap && month === leap + 1) isLeap = false;
    offset -= temp;
  }
  if (offset === 0 && leap > 0 && month === leap + 1) {
    if (isLeap) isLeap = false;
    else {
      isLeap = true;
      month -= 1;
    }
  }
  if (offset < 0) {
    offset += temp;
    month -= 1;
  }
  return { year, month, day: offset + 1, isLeap };
}

function shiftYmd(dateStr, days) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 2000–2099 清明（节气），约 4 月 4/5/6 日 */
function qingmingMd(year) {
  if (year < 1900 || year > 2100) return '';
  const y = year % 100;
  const c = year >= 2000 ? 4.81 : 5.59;
  const day = Math.floor(y * 0.2422 + c) - Math.floor(y / 4);
  if (day < 4 || day > 6) return '';
  return `04-${pad2(day)}`;
}

function holidaysOn(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return [];
  const year = +m[1];
  const month = +m[2];
  const day = +m[3];
  const mmdd = `${m[2]}-${m[3]}`;
  const out = [];

  if (mmdd && mmdd === qingmingMd(year)) {
    out.push({ name: '清明', kind: 'festival' });
  }

  const lunar = solarToLunar(year, month, day);
  if (lunar && !lunar.isLeap) {
    const hit = LUNAR_FESTIVALS.find(f => f.month === lunar.month && f.day === lunar.day);
    if (hit) out.push(hit);
  }

  const tomorrow = shiftYmd(`${year}-${pad2(month)}-${pad2(day)}`, 1);
  const tm = tomorrow.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (tm) {
    const next = solarToLunar(+tm[1], +tm[2], +tm[3]);
    if (next && !next.isLeap && next.month === 1 && next.day === 1) {
      out.push({ name: '除夕', kind: 'festival' });
    }
  }

  const solar = SOLAR_HOLIDAYS[mmdd];
  if (solar) out.push(solar);

  return out;
}

function holidayPromptLine(hits) {
  const label = hits.map(h => h.name).join('和');
  if (hits.some(h => h.kind === 'romance')) {
    return `今天是${label}。按【性格】【关系尺度】决定提不提、怎么提（可热可淡可损可不当回事），不要模板祝福或默认情话。`;
  }
  return `今天是${label}。按【性格】【关系尺度】自然提或不提，不要模板祝福，也不要默认过节腔。`;
}

function lookupPublicHoliday(dateStr) {
  const hits = holidaysOn(dateStr);
  if (!hits.length) return null;
  return {
    names: hits.map(h => h.name),
    label: hits.map(h => h.name).join('和'),
    kinds: [...new Set(hits.map(h => h.kind))],
    prompt: holidayPromptLine(hits),
  };
}

/** 将 YYYY-MM-DD 转农历对象（友好格式） */
function solarToLunarLocal(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const lunar = solarToLunar(+m[1], +m[2], +m[3]);
  if (!lunar) return null;
  const LUNAR_CHARS = '零一二三四五六七八九';
  const lunarYearStr = String(lunar.year).split('').map(d => LUNAR_CHARS[+d] || d).join('');
  const lunarMonthStr = lunar.isLeap ? `闰${LUNAR_CHARS[lunar.month] || lunar.month}` : LUNAR_CHARS[lunar.month] || lunar.month;
  const lunarDayStr = (() => {
    const d = lunar.day;
    if (d === 10) return '初十';
    if (d < 10) return '初' + LUNAR_CHARS[d];
    if (d < 20) return '十' + LUNAR_CHARS[d - 10];
    if (d === 20) return '二十';
    if (d < 30) return '廿' + LUNAR_CHARS[d - 20];
    return '三十';
  })();
  return {
    year: lunar.year,
    month: lunar.month,
    day: lunar.day,
    isLeap: lunar.isLeap,
    label: `${lunarYearStr}年${lunarMonthStr}月${lunarDayStr}`,
  };
}

module.exports = {
  lookupPublicHoliday,
  holidaysOn,
  solarToLunarLocal,
};

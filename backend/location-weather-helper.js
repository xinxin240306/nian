/**
 * 用户/角色所在地：地名常驻注入；天气按话题触发 + Open-Meteo（缓存）。
 */
const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./api-helper');

const WEATHER_CACHE_TTL_MS = 45 * 60 * 1000;
const GEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GEO_CACHE = 200;
const MAX_WEATHER_CACHE = 200;

/** @type {Map<string, { at: number, lat: number, lon: number, label: string }>} */
const _geoCache = new Map();
/** @type {Map<string, { at: number, summary: string }>} */
const _weatherCache = new Map();
/** in-flight dedupe */
const _weatherInflight = new Map();

function pruneTimedCache(map, maxSize, ttlMs) {
  const now = Date.now();
  for (const [k, v] of map) {
    if (now - (v?.at || 0) > ttlMs) map.delete(k);
  }
  while (map.size > maxSize) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

const LOCATION_TOPIC_RE = /城市|同城|天气|气温|下雨|下雪|雨天|雪天|带伞|出门|刮风|台风|暴雨|雾霾|阴天|晴天|冷不冷|热不热|多少度|当地|这边|那边|你那儿|你那边|我这边|我那儿|见个面|过来玩|来找你|去找你|在哪[里儿]|哪个城市|什么地方|回[去到]|出差|旅游|旅行/;

const WMO_LABELS = {
  0: '晴',
  1: '大体晴',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '强阵雨',
  82: '暴阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷阵雨伴冰雹',
};

function wmoLabel(code) {
  const n = Number(code);
  if (WMO_LABELS[n]) return WMO_LABELS[n];
  if (n >= 51 && n < 70) return '有雨';
  if (n >= 71 && n < 80) return '有雪';
  if (n >= 80 && n < 90) return '阵雨/阵雪';
  if (n >= 95) return '雷雨';
  return '天气不明';
}

function needsUmbrella(code, precipMm, precipProb) {
  const n = Number(code);
  if (Number(precipMm) >= 0.2) return true;
  if (Number(precipProb) >= 50) return true;
  return (n >= 51 && n <= 67) || (n >= 80 && n <= 82) || (n >= 95 && n <= 99);
}

function needsWarmHint(tempC) {
  const t = Number(tempC);
  return Number.isFinite(t) && t <= 8;
}

function isRealWorldMap(char) {
  return Number(char?.real_world_map) === 1;
}

/** 现实地图下是否说官方真名；未设时默认用真名 */
function useRealPlaceNames(char) {
  return Number(char?.real_place_names) !== 0;
}

/** 聊天里对外说的所在地：手填地名优先 */
function spokenCharLocation(char) {
  return String(char?.location_name || '').trim() || String(char?.real_location || '').trim();
}

/** 查天气/路网用的现实地点 */
function weatherLookupPlace(char) {
  return String(char?.real_location || '').trim() || String(char?.location_name || '').trim();
}

/** 对外说的家住址（化名城市版）；缺省时退回所在地名 */
function spokenHomeAddress(char) {
  return String(char?.home_address || '').trim()
    || spokenCharLocation(char);
}

/** 钉地图/开导航用的现实家住址；缺省时退回现实地区 */
function realHomeAddressLookup(char) {
  return String(char?.real_home_address || '').trim()
    || weatherLookupPlace(char);
}

function buildGeoNamingPromptBlock(char) {
  const home = String(char?.location_name || '').trim();
  const real = String(char?.real_location || '').trim();
  const homeAddr = String(char?.home_address || '').trim();
  const realHomeAddr = String(char?.real_home_address || '').trim();
  const homeAddrLine = homeAddr
    ? `你家对外住址是「${homeAddr}」${realHomeAddr && realHomeAddr !== homeAddr ? `（定位按「${realHomeAddr}」，嘴里不要说这个现实住址里的城市真名若已化名）` : ''}。说回家、发家里位置时用对外住址。`
    : '';
  if (isRealWorldMap(char)) {
    if (useRealPlaceNames(char)) {
      const liveLine = home
        ? `你住的那座城对外就叫「${home}」，禁止改口。`
        : (real ? `你住在「${real}」。` : '');
      return `【地图】按现实世界地图。城市、国家、路名、商圈、地标用官方真名，禁止魔都、帝都、羊城、鹏城、山城、蓉城这类俗称。${liveLine}${homeAddrLine}城市对照见世界书【地理对照】。除此之外提到的地方都按真名。`;
    }
    const homeLine = home ? `你住的城对外叫「${home}」，禁止改口。` : '';
    const hideReal = real ? `心里按「${real}」的路网走，嘴里不要说出这个现实城市名。` : '';
    return `【地图】按现实世界地图。只把城市改成化名，区、路、店、商圈、地铁站、地标用官方真名。禁止说出对照表里的现实城市名，也不要用魔都、帝都、羊城、鹏城、山城、蓉城这类俗称。同一城市只用【地理对照】里的那一个化名。${homeLine}${hideReal}${homeAddrLine}`;
  }
  const homeLine = home ? `你住的地方叫「${home}」。` : '';
  return `【地图】这是你自己的世界，地理从【世界书】和人设里补，不要套现实城市名和真实路网。${homeLine}${homeAddr ? `你家住址：${homeAddr}。` : ''}世界书没写过的地方按这个世界的语感顺口补，不要突然冒出上海、北京、纽约。`;
}

function extractPlaceNames(userLoc, charLoc) {
  const out = [];
  for (const raw of [userLoc, charLoc]) {
    const s = String(raw || '').trim();
    if (!s) continue;
    out.push(s);
    // 「上海市浦东」→ 也匹配「上海」
    const m = s.match(/^([\u4e00-\u9fff]{2,4}?)(市|省|区|县|州)?/);
    if (m && m[1] && m[1] !== s) out.push(m[1]);
  }
  return [...new Set(out.filter(p => p.length >= 2))];
}

function joinRecentAssistantText(recentHistory, limit = 8) {
  return (recentHistory || [])
    .filter(m => m && m.role === 'assistant')
    .slice(-limit)
    .map(m => String(m.content || '').replace(/^【自动回复】/, ''))
    .join('\n');
}

/**
 * 是否顺带注入天气（仍按话题，避免每轮拉天气）：
 * - 角色近期消息提到城市/天气/地名
 * - 或本轮用户消息聊到天气/城市
 * 地名本身改为常驻注入，见 buildLocationContextBlock。
 */
function shouldInjectLocationContext(opts = {}, userLoc = '', charLoc = '') {
  if (opts.isDream || opts.forGame || opts.forDiaryPeek) return false;
  const places = extractPlaceNames(userLoc, charLoc);
  const aiText = joinRecentAssistantText(opts.recentHistory);
  if (aiText) {
    if (LOCATION_TOPIC_RE.test(aiText)) return true;
    if (places.some(p => aiText.includes(p))) return true;
  }
  const userSide = `${opts.userMessage || ''}\n${opts.contextText || ''}`;
  if (userSide.trim()) {
    if (LOCATION_TOPIC_RE.test(userSide)) return true;
    if (places.some(p => userSide.includes(p))) return true;
  }
  return false;
}

function getCachedWeatherSummary(place) {
  const key = String(place || '').trim().toLowerCase();
  if (!key) return '';
  const hit = _weatherCache.get(key);
  if (!hit) return '';
  if (Date.now() - hit.at > WEATHER_CACHE_TTL_MS) return '';
  return hit.summary || '';
}

async function geocodePlace(place) {
  const key = String(place || '').trim().toLowerCase();
  if (!key) return null;
  const cached = _geoCache.get(key);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) {
    return { lat: cached.lat, lon: cached.lon, label: cached.label };
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=zh&format=json`;
  const r = await fetchWithTimeout(url, {
    timeout: 6000,
    headers: { 'User-Agent': 'NianApp/1.0 (personal use)' },
  });
  if (!r.ok) throw new Error(`geocode ${r.status}`);
  const data = await r.json();
  const first = data?.results?.[0];
  if (!first || !Number.isFinite(first.latitude) || !Number.isFinite(first.longitude)) return null;
  const label = [first.name, first.admin1, first.country].filter(Boolean).join(' · ');
  const entry = { at: Date.now(), lat: first.latitude, lon: first.longitude, label };
  _geoCache.set(key, entry);
  pruneTimedCache(_geoCache, MAX_GEO_CACHE, GEO_CACHE_TTL_MS);
  return { lat: entry.lat, lon: entry.lon, label: entry.label };
}

async function fetchWeatherSummaryForPlace(place) {
  const raw = String(place || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase();
  const cached = getCachedWeatherSummary(raw);
  if (cached) return cached;
  if (_weatherInflight.has(key)) return _weatherInflight.get(key);

  const job = (async () => {
    try {
      const geo = await geocodePlace(raw);
      if (!geo) return '';
      const q = new URLSearchParams({
        latitude: String(geo.lat),
        longitude: String(geo.lon),
        current: 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
        daily: 'precipitation_probability_max,weather_code,temperature_2m_max,temperature_2m_min',
        timezone: 'auto',
        forecast_days: '1',
      });
      const wr = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${q}`, {
        timeout: 6000,
        headers: { 'User-Agent': 'NianApp/1.0 (personal use)' },
      });
      if (!wr.ok) throw new Error(`weather ${wr.status}`);
      const w = await wr.json();
      const cur = w.current || {};
      const daily = w.daily || {};
      const code = cur.weather_code ?? daily.weather_code?.[0];
      const temp = cur.temperature_2m;
      const feels = cur.apparent_temperature;
      const precip = cur.precipitation;
      const precipProb = daily.precipitation_probability_max?.[0];
      const tmax = daily.temperature_2m_max?.[0];
      const tmin = daily.temperature_2m_min?.[0];
      const label = wmoLabel(code);
      const bits = [`${raw}（${geo.label || raw}）此刻：${label}`];
      if (Number.isFinite(Number(temp))) bits.push(`气温约${Math.round(temp)}℃`);
      if (Number.isFinite(Number(feels)) && Math.abs(Number(feels) - Number(temp)) >= 2) {
        bits.push(`体感约${Math.round(feels)}℃`);
      }
      if (Number.isFinite(Number(tmin)) && Number.isFinite(Number(tmax))) {
        bits.push(`今日${Math.round(tmin)}~${Math.round(tmax)}℃`);
      }
      if (Number.isFinite(Number(precipProb))) bits.push(`降水概率约${Math.round(precipProb)}%`);
      const tips = [];
      if (needsUmbrella(code, precip, precipProb)) tips.push('有雨');
      if (needsWarmHint(temp) || needsWarmHint(tmin)) tips.push('偏冷');
      let summary = bits.join('，');
      if (tips.length) summary += `，${tips.join('、')}`;
      _weatherCache.set(key, { at: Date.now(), summary });
      pruneTimedCache(_weatherCache, MAX_WEATHER_CACHE, WEATHER_CACHE_TTL_MS);
      return summary;
    } catch (e) {
      console.warn('[location-weather]', raw, e.message);
      return '';
    } finally {
      _weatherInflight.delete(key);
    }
  })();

  _weatherInflight.set(key, job);
  return job;
}

/** 聊天热路径：命中时预拉天气进缓存（失败忽略） */
async function prefetchLocationWeather(char, settings, opts = {}) {
  const userLoc = String(settings?.user_location || '').trim();
  const charSpoken = spokenCharLocation(char);
  const charWeather = weatherLookupPlace(char);
  const charMatch = [charSpoken, charWeather].filter(Boolean).join(' ');
  if (!userLoc && !charSpoken && !charWeather) return;
  if (!shouldInjectLocationContext(opts, userLoc, charMatch)) return;
  const places = [...new Set([userLoc, charWeather].filter(Boolean))];
  await Promise.all(places.map(p => fetchWeatherSummaryForPlace(p).catch(() => '')));
}

/** 同步拼装注入块：地名常驻；天气仍按话题（依赖缓存） */
function buildLocationContextBlock(char, settings, opts = {}) {
  if (opts.isDream || opts.forGame || opts.forDiaryPeek) return '';
  const userLoc = String(settings?.user_location || '').trim();
  const homeSpoken = spokenCharLocation(char);
  const charSpoken = String(opts.presentLocation || '').trim() || homeSpoken;
  const charWeatherPlace = weatherLookupPlace(char);
  const charMatch = [charSpoken, homeSpoken, charWeatherPlace].filter(Boolean).join(' ');
  if (!userLoc && !charSpoken && !charWeatherPlace) return '';

  const weatherOk = shouldInjectLocationContext(opts, userLoc, charMatch);
  const lines = weatherOk
    ? ['【所在地与天气】地名是常驻事实；天气仅本轮相关时参考。自然用上即可，勿整段复读，勿每句报地名/天气。']
    : ['【所在地】各自那边的事实。聊出门见闻、本地习惯时自然用；勿每句报地名。'];
  if (charSpoken && homeSpoken && charSpoken !== homeSpoken) {
    lines.push(`角色此刻所在地：${charSpoken}（常住地：${homeSpoken}；出差/外出期间对外地区以此刻为准）`);
  } else if (charSpoken) {
    lines.push(`角色所在地：${charSpoken}`);
  }
  if (userLoc) {
    lines.push(`用户所在地：${userLoc}`);
    lines.push('两边地名不同时不要默认同城。想挨在一起开小剧场；「回来」只等于各自回家后再聊。');
  }
  const userHome = String(settings?.user_home_address || '').trim();
  if (userHome) {
    lines.push(`用户家：${userHome}（说「我家/回家」或人在家里时可对上这个点）`);
  }
  const userWork = String(settings?.user_work_address || '').trim();
  if (userWork) {
    lines.push(`用户公司：${userWork}（说「公司/上班」或人在公司时可对上这个点）`);
  }
  if (weatherOk) {
    const userWeather = userLoc ? getCachedWeatherSummary(userLoc) : '';
    const charWeather = charWeatherPlace && charWeatherPlace !== userLoc
      ? getCachedWeatherSummary(charWeatherPlace)
      : '';
    if (userWeather) lines.push(`用户侧天气：${userWeather}`);
    if (charWeather) lines.push(`角色侧天气：${charWeather}`);
    if (!userWeather && !charWeather && (userLoc || charSpoken || charWeatherPlace)) {
      lines.push('（天气暂未取到，可只用地名，勿编造具体气温/降雨）');
    }
  }
  return lines.join('\n');
}

/** @type {Map<string, { at: number, lat: number, lng: number, label: string }>} */
const _nominatimCache = new Map();
let _nominatimGate = Promise.resolve();

function nominatimGate(fn) {
  const run = _nominatimGate.then(() => fn(), () => fn());
  _nominatimGate = run
    .then(() => new Promise((r) => setTimeout(r, 1100)))
    .catch(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}

function cityAliasPairs(char) {
  let pairs = [];
  try {
    pairs = require('./geo-worldbook-helper').parseAliasList(char?.geo_city_aliases);
  } catch {
    pairs = [];
  }
  const homeA = String(char?.location_name || '').trim();
  const homeR = String(char?.real_location || '').trim();
  if (homeA && homeR) pairs = [{ alias: homeA, real: homeR }, ...pairs];
  const addrA = String(char?.home_address || '').trim();
  const addrR = String(char?.real_home_address || '').trim();
  if (addrA && addrR) pairs = [{ alias: addrA, real: addrR }, ...pairs];
  return (pairs || [])
    .map((p) => ({ alias: String(p?.alias || '').trim(), real: String(p?.real || '').trim() }))
    .filter((p) => p.alias && p.real && p.alias !== p.real)
    .sort((a, b) => b.alias.length - a.alias.length);
}

function applyCityAliasToReal(text, char) {
  let out = String(text || '');
  const seen = new Set();
  for (const p of cityAliasPairs(char)) {
    if (seen.has(p.alias)) continue;
    seen.add(p.alias);
    if (out.includes(p.alias)) out = out.split(p.alias).join(p.real);
  }
  return out;
}

function locationSearchQuery(placeText, char) {
  let raw = applyCityAliasToReal(String(placeText || ''), char);
  const pipe = Math.max(raw.lastIndexOf('|'), raw.lastIndexOf('｜'));
  if (pipe >= 0) {
    const right = raw.slice(pipe + 1).trim();
    if (right && !/^(位置|这里|当前位置)$/.test(right)) raw = right;
  }
  return raw.replace(/[·•]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

const STREET_TOKEN_RE = /^(?:[\u4e00-\u9fffA-Za-z0-9]{1,20})(?:路|街|巷|胡同|大道|大街|马路|弄|里)$/;

function looksLikeStreet(t) {
  return STREET_TOKEN_RE.test(String(t || '').trim());
}

function looksLikeDistrict(t) {
  return /[区县镇]$/.test(String(t || '').trim());
}

function looksLikeCity(t) {
  const s = String(t || '').trim();
  if (!s || looksLikeStreet(s) || looksLikeDistrict(s)) return false;
  if (/[店馆坊铺吧屋厅厦楼园宫寺庙校站]$/.test(s)) return false;
  if (/[市州省]$/.test(s)) return true;
  return /^[\u4e00-\u9fff]{2,6}$/.test(s);
}

function normCityKey(t) {
  return String(t || '').replace(/[市州省]$/g, '').trim();
}

function extractStreetParts(query) {
  const raw = String(query || '').replace(/[|｜·•,，]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = raw.split(' ').filter((t) => t && !/^(位置|这里|当前位置)$/.test(t));
  let city = '';
  let district = '';
  let street = '';
  for (const t of tokens) {
    if (!city && looksLikeCity(t)) city = normCityKey(t);
    else if (!district && looksLikeDistrict(t)) district = t;
    else if (!street && looksLikeStreet(t)) street = t;
  }
  if (!street) {
    const m = raw.match(/([\u4e00-\u9fffA-Za-z0-9]{1,16}(?:路|街|巷|胡同|大道|大街|马路|弄))/);
    if (m) street = m[1];
  }
  if (!city && tokens[0] && !looksLikeStreet(tokens[0]) && !looksLikeDistrict(tokens[0])) {
    city = normCityKey(tokens[0]);
  }
  return { street, city, district, raw };
}

function hitPlaceBlob(hit) {
  const a = hit?.address || {};
  return [a.city, a.municipality, a.town, a.county, a.state, a.province, a.suburb,
    a.city_district, a.district, hit?.display_name].filter(Boolean).join(' ');
}

function cityMatchesHit(hit, city) {
  const want = normCityKey(city);
  if (!want) return true;
  const blob = hitPlaceBlob(hit);
  return blob.includes(want) || blob.includes(`${want}市`);
}

function streetHitScore(hit, city) {
  const type = String(hit?.type || hit?.addresstype || '');
  const cls = String(hit?.class || '');
  const addr = hit?.address || {};
  let n = Number(hit?.importance) || 0;
  if (city && cityMatchesHit(hit, city)) n += 20;
  else if (city) n -= 20;
  if (cls === 'highway' || type === 'road' || addr.road) n += 8;
  if (/residential|tertiary|secondary|primary|living_street|pedestrian|unclassified|service/.test(type)) n += 4;
  if (addr.house_number) n += 3;
  if (addr.suburb || addr.city_district || addr.district) n += 1;
  if (type === 'city' || type === 'administrative' || type === 'state' || cls === 'boundary' || cls === 'place') n -= 6;
  return n;
}

function pickStreetHit(hits, city) {
  if (!Array.isArray(hits) || !hits.length) return null;
  const inCity = city ? hits.filter((h) => cityMatchesHit(h, city)) : hits;
  const pool = inCity.length ? inCity : [];
  if (!pool.length) return null;
  return pool.slice().sort((a, b) => streetHitScore(b, city) - streetHitScore(a, city))[0] || pool[0];
}

async function nominatimFetchHits(params) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&accept-language=zh&${params}`;
  const r = await fetchWithTimeout(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'NianApp/1.0 (personal use)' },
  });
  if (!r.ok) throw new Error(`nominatim ${r.status}`);
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

function latLngToTile(lat, lng, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return {
    z: zoom,
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

async function nominatimSearch(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const m = q.match(/(-?\d{1,3}\.\d+)\s*[,，]\s*(-?\d{1,3}\.\d+)/);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng, label: q };
    }
  }
  const key = q.toLowerCase();
  const cached = _nominatimCache.get(key);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) {
    return { lat: cached.lat, lng: cached.lng, label: cached.label };
  }
  return nominatimGate(async () => {
    const again = _nominatimCache.get(key);
    if (again && Date.now() - again.at < GEO_CACHE_TTL_MS) {
      return { lat: again.lat, lng: again.lng, label: again.label };
    }
    const parts = extractStreetParts(q);
    const cityQ = [parts.city, parts.district].filter(Boolean).join('');
    const geoQ = [parts.city && `${parts.city}市`.replace(/市市$/, '市'), parts.district, parts.street]
      .filter(Boolean).join('');
    let hits = [];
    if (parts.street && parts.city) {
      try {
        hits = await nominatimFetchHits(
          `street=${encodeURIComponent(parts.street)}&city=${encodeURIComponent(parts.city)}`,
        );
      } catch { hits = []; }
    }
    if (!pickStreetHit(hits, parts.city) && geoQ) {
      try {
        hits = await nominatimFetchHits(`q=${encodeURIComponent(geoQ)}`);
      } catch { hits = []; }
    }
    if (!pickStreetHit(hits, parts.city) && cityQ && parts.street) {
      try {
        hits = await nominatimFetchHits(`q=${encodeURIComponent(`${cityQ}${parts.street}`)}`);
      } catch { hits = []; }
    }
    if (!pickStreetHit(hits, parts.city) && parts.city && parts.street) {
      try {
        hits = await nominatimFetchHits(
          `q=${encodeURIComponent(`${parts.city} ${parts.district || ''} ${parts.street}`.replace(/\s+/g, ' '))}&countrycodes=cn`,
        );
      } catch { hits = []; }
    }
    // 没写城市才允许整句搜；有城市绝不能只搜路名，否则会落到用户当前城市
    if (!pickStreetHit(hits, parts.city) && !parts.city && q) {
      try {
        hits = await nominatimFetchHits(`q=${encodeURIComponent(q)}`);
      } catch { hits = []; }
    }
    // 路查不到也要落到对方城市，不能让地图停在用户自己
    if (!pickStreetHit(hits, parts.city) && parts.city) {
      try {
        hits = await nominatimFetchHits(
          `q=${encodeURIComponent(`${parts.city}市${parts.district || ''}`)}&countrycodes=cn`,
        );
      } catch { hits = []; }
    }
    const first = pickStreetHit(hits, parts.city) || (parts.city ? null : (hits[0] || null));
    const lat = parseFloat(first?.lat);
    const lng = parseFloat(first?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const road = first?.address?.road || parts.street || '';
    const label = [parts.city, parts.district, road].filter(Boolean).join('') || String(first?.display_name || q);
    const entry = { at: Date.now(), lat, lng, label };
    _nominatimCache.set(key, entry);
    pruneTimedCache(_nominatimCache, MAX_GEO_CACHE, GEO_CACHE_TTL_MS);
    return { lat, lng, label };
  });
}

async function resolvePlaceCoords(placeText, char, hintLat, hintLng) {
  const la = Number(hintLat);
  const ln = Number(hintLng);
  if (Number.isFinite(la) && Number.isFinite(ln)) return { lat: la, lng: ln };
  const q = locationSearchQuery(placeText, char);
  if (!q) return null;
  return nominatimSearch(q);
}

function mapPreviewFilename(lat, lng, zoom = 17) {
  return `map_${Number(lat).toFixed(4)}_${Number(lng).toFixed(4)}_z${zoom}.png`;
}

async function fetchMapPreviewBuffer(lat, lng, zoom = 17) {
  const headers = { 'User-Agent': 'NianApp/1.0 (personal use)' };
  const staticUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=${zoom}&size=400x200&maptype=mapnik&markers=${lat},${lng},red-pushpin`;
  try {
    const r = await fetchWithTimeout(staticUrl, { timeout: 8000, headers });
    if (r.ok) {
      const buf = Buffer.from(await (typeof r.buffer === 'function' ? r.buffer() : r.arrayBuffer()));
      const ct = String(r.headers.get('content-type') || '');
      if (buf.length > 800 && /image\//i.test(ct)) return buf;
    }
  } catch { /* 改用单张瓦片 */ }
  const tile = latLngToTile(lat, lng, zoom);
  const tileUrl = `https://tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`;
  const tr = await fetchWithTimeout(tileUrl, { timeout: 8000, headers });
  if (!tr.ok) throw new Error(`tile ${tr.status}`);
  return Buffer.from(await (typeof tr.buffer === 'function' ? tr.buffer() : tr.arrayBuffer()));
}

async function buildMapPreview({ lat, lng, q, uploadsPath, char } = {}) {
  const query = locationSearchQuery(q, char) || String(q || '').trim();
  const parts = extractStreetParts(query);
  let la;
  let ln;
  // 卡片写了城市+街路：按显示城市查，不用单独路名/旧坐标（避免跑到用户当前城市）
  if (parts.city && (parts.street || parts.district)) {
    const geo = await nominatimSearch(query);
    if (geo) {
      la = geo.lat;
      ln = geo.lng;
    }
  }
  if (!Number.isFinite(la) || !Number.isFinite(ln)) {
    la = parseFloat(lat);
    ln = parseFloat(lng);
  }
  if (!Number.isFinite(la) || !Number.isFinite(ln)) {
    const geo = await nominatimSearch(query);
    if (!geo) return null;
    la = geo.lat;
    ln = geo.lng;
  }
  const zoom = 17;
  const dir = path.join(uploadsPath, 'map-preview');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = mapPreviewFilename(la, ln, zoom);
  const fp = path.join(dir, filename);
  if (!fs.existsSync(fp) || fs.statSync(fp).size < 400) {
    const buf = await fetchMapPreviewBuffer(la, ln, zoom);
    if (!buf?.length) return null;
    fs.writeFileSync(fp, buf);
  }
  return {
    url: `/uploads/map-preview/${filename}`,
    lat: la,
    lng: ln,
  };
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function standingPlacesFromSettings(settings) {
  const s = settings || {};
  const list = [];
  const homeLat = parseFloat(s.user_home_lat);
  const homeLng = parseFloat(s.user_home_lng);
  if (Number.isFinite(homeLat) && Number.isFinite(homeLng)) {
    list.push({
      key: 'home',
      label: '家',
      address: String(s.user_home_address || '').trim(),
      lat: homeLat,
      lng: homeLng,
    });
  }
  const workLat = parseFloat(s.user_work_lat);
  const workLng = parseFloat(s.user_work_lng);
  if (Number.isFinite(workLat) && Number.isFinite(workLng)) {
    list.push({
      key: 'work',
      label: '公司',
      address: String(s.user_work_address || '').trim(),
      lat: workLat,
      lng: workLng,
    });
  }
  return list;
}

function matchStandingPlace(lat, lng, settings, accuracyM = 0) {
  const radius = Math.max(80, Math.min(200, Number(accuracyM) * 1.8 || 80));
  let best = null;
  for (const p of standingPlacesFromSettings(settings)) {
    const dist = haversineM(lat, lng, p.lat, p.lng);
    if (dist <= radius && (!best || dist < best.dist)) best = { ...p, dist };
  }
  return best;
}

async function fetchNearbyNamedPoi(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  const q = `[out:json][timeout:8];
(
  node(around:70,${la},${ln})[name][shop];
  node(around:70,${la},${ln})[name][amenity];
  node(around:70,${la},${ln})[name][tourism];
  node(around:70,${la},${ln})[name][office];
  way(around:70,${la},${ln})[name][shop];
  way(around:70,${la},${ln})[name][amenity];
  way(around:70,${la},${ln})[name][office];
);
out center 24;`;
  const r = await fetchWithTimeout('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'User-Agent': 'NianApp/1.0 (personal use)',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: `data=${encodeURIComponent(q)}`,
    timeout: 9000,
  });
  if (!r.ok) throw new Error(`overpass ${r.status}`);
  const data = await r.json();
  const els = Array.isArray(data?.elements) ? data.elements : [];
  let best = null;
  for (const el of els) {
    const tags = el.tags || {};
    const name = String(tags['name:zh'] || tags.name || '').trim();
    if (!name || name.length < 2) continue;
    const plat = Number(el.lat ?? el.center?.lat);
    const plng = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(plat) || !Number.isFinite(plng)) continue;
    const dist = haversineM(la, ln, plat, plng);
    if (dist > 70) continue;
    const kind = tags.shop || tags.amenity || tags.tourism || tags.office || '';
    if (!best || dist < best.dist) best = { name, kind, dist };
  }
  return best;
}

async function reverseGeocodeCoords(lat, lng, opts = {}) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  const coordFallback = `${la.toFixed(5)}, ${ln.toFixed(5)}`;
  const key = `${la.toFixed(4)},${ln.toFixed(4)}`;
  const cached = _nominatimCache.get(`rev:${key}`);
  if (cached && Date.now() - cached.at < 3 * 60 * 60 * 1000) {
    return decorateStanding(cached.payload, la, ln, opts);
  }
  try {
    const payload = await nominatimGate(async () => {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${la}&lon=${ln}&accept-language=zh&zoom=19&addressdetails=1&extratags=1&namedetails=1`;
      const r = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'NianApp/1.0 (personal use)' },
        timeout: 10000,
      });
      if (!r.ok) throw new Error(`reverse ${r.status}`);
      const data = await r.json();
      const addr = data.address || {};
      const named = String(data.namedetails?.['name:zh'] || data.namedetails?.name || data.name || '').trim();
      const typeName = addr.amenity || addr.shop || addr.tourism || addr.leisure
        || addr.building || addr.office || addr.historic || addr.craft || '';
      const road = addr.road || addr.pedestrian || addr.footway || addr.path || addr.residential || '';
      const house = addr.house_number || '';
      const city = addr.city || addr.municipality || addr.town || addr.county || addr.state || '';
      const district = addr.city_district || addr.district || addr.suburb
        || addr.neighbourhood || addr.quarter || addr.village || '';
      let title = named && !/^\d/.test(named) ? named : '';
      if (!title && typeName && !/^(yes|residential|apartments)$/i.test(typeName)) title = typeName;
      if (!title && road) title = house ? `${road}${house}号` : road;
      if (!title && district) title = district;
      if (!title && city) title = city;
      const detailParts = [];
      if (city) detailParts.push(city);
      if (district && district !== city && district !== title) detailParts.push(district);
      if (road && !String(title).includes(road)) detailParts.push(house ? `${road}${house}号` : road);
      let detail = detailParts.join('·');
      if (!title) {
        const disp = String(data.display_name || '').split(/,\s*/).map((x) => x.trim()).filter(Boolean);
        title = disp[0] || coordFallback;
        if (!detail && disp.length > 1) detail = disp.slice(1, 4).join('·');
      }
      if (!detail) detail = [city, district].filter(Boolean).join('·') || '当前位置';
      const placeName = detail && detail !== title ? `${title}|${detail}` : title;
      return {
        placeName: placeName || coordFallback,
        title: title || coordFallback,
        detail: detail || '',
        road: road || '',
        city: city || '',
        district: district || '',
        poi: named || '',
        lat: la,
        lng: ln,
      };
    });
    try {
      const poi = await fetchNearbyNamedPoi(la, ln);
      if (poi?.name && (poi.dist <= 45 || !payload.poi)) {
        payload.poi = poi.name;
        payload.title = poi.name;
        payload.placeName = payload.detail && payload.detail !== poi.name
          ? `${poi.name}|${payload.detail}`
          : poi.name;
      }
    } catch (e) {
      console.warn('[nearby-poi]', e.message);
    }
    _nominatimCache.set(`rev:${key}`, { at: Date.now(), payload: { ...payload } });
    pruneTimedCache(_nominatimCache, MAX_GEO_CACHE, GEO_CACHE_TTL_MS);
    return decorateStanding(payload, la, ln, opts);
  } catch (e) {
    console.warn('[reverse-geocode]', e.message);
    return decorateStanding(
      { placeName: coordFallback, title: coordFallback, detail: '', lat: la, lng: ln },
      la, ln, opts,
    );
  }
}

function decorateStanding(payload, la, ln, opts = {}) {
  const out = { ...(payload || {}) };
  delete out.anchor;
  delete out.anchorLabel;
  delete out.anchorAddress;
  const settings = opts.settings || (() => {
    try {
      const db = require('./db');
      const rows = db.prepare('SELECT key, value FROM settings').all();
      const s = {};
      for (const r of rows) s[r.key] = r.value;
      return s;
    } catch { return {}; }
  })();
  const stand = matchStandingPlace(la, ln, settings, opts.accuracy);
  if (stand) {
    out.anchor = stand.key;
    out.anchorLabel = stand.label;
    out.anchorAddress = stand.address || '';
    out.poi = out.poi || out.title;
    out.title = stand.label;
    out.detail = stand.address || out.detail;
    out.placeName = stand.address ? `${stand.label}|${stand.address}` : stand.label;
  }
  return out;
}

async function attachLocationCoords(msgId, placeText, char, hintLat, hintLng) {
  if (!msgId) return null;
  try {
    const geo = await resolvePlaceCoords(placeText, char, hintLat, hintLng);
    if (!geo) return null;
    const db = require('./db');
    const row = db.prepare('SELECT media_meta FROM messages WHERE id=?').get(msgId);
    let meta = {};
    try { meta = JSON.parse(row?.media_meta || '{}') || {}; } catch { meta = {}; }
    meta.lat = geo.lat;
    meta.lng = geo.lng;
    db.prepare('UPDATE messages SET media_meta=? WHERE id=?').run(JSON.stringify(meta), msgId);
    return geo;
  } catch (e) {
    console.warn('[location-coords]', e.message);
    return null;
  }
}

module.exports = {
  shouldInjectLocationContext,
  prefetchLocationWeather,
  buildLocationContextBlock,
  fetchWeatherSummaryForPlace,
  getCachedWeatherSummary,
  isRealWorldMap,
  useRealPlaceNames,
  spokenCharLocation,
  weatherLookupPlace,
  spokenHomeAddress,
  realHomeAddressLookup,
  buildGeoNamingPromptBlock,
  applyCityAliasToReal,
  locationSearchQuery,
  nominatimSearch,
  resolvePlaceCoords,
  buildMapPreview,
  attachLocationCoords,
  reverseGeocodeCoords,
  matchStandingPlace,
  standingPlacesFromSettings,
};

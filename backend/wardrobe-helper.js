/**
 * 衣柜 · 外貌档案 · 今日穿搭
 */
const db = require('./db');

const WARDROBE_CATEGORIES = {
  tops: { label: '上装', purchaseCount: 2 },
  bottoms: { label: '下装', purchaseCount: 2 },
  outer: { label: '外套', purchaseCount: 1 },
  shoes: { label: '鞋履', purchaseCount: 1 },
  bags: { label: '包袋', purchaseCount: 1 },
  accessories: { label: '配饰', purchaseCount: 2 },
  hairstyle: { label: '发型', purchaseCount: 1 },
  suit: { label: '套装', purchaseCount: 1 },
  gown: { label: '礼服', purchaseCount: 1 },
  pajamas: { label: '睡衣', purchaseCount: 1 },
};

const OUTFIT_SLOTS = [
  { id: 'home', label: '居家' },
  { id: 'out', label: '外出' },
  { id: 'work', label: '工作' },
  { id: 'social', label: '社交' },
  { id: 'sport_bath', label: '运动/沐浴' },
  { id: 'sleep', label: '睡眠' },
];

const SLOT_INFER_RE = {
  sleep: /睡|卧床|小憩|nap|休息.*床/i,
  sport_bath: /运动|健身|跑步|瑜伽|游泳|洗澡|沐浴|泡澡|球类|训练/i,
  work: /工作|上班|办公|开会|学习|上课|备课|写稿|赶工|加班/i,
  social: /聚会|饭局|约会|见朋友|聚餐|晚宴|派对|社交|喝酒/i,
  out: /出门|外出|逛街|采购|办事|旅行|高铁|飞机|咖啡|探店/i,
};

const SEASON_LABELS = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

const FALLBACK_POOLS_BY_SEASON = {
  spring: {
    tops: ['浅蓝条纹衬衫', '米白薄针织', '浅灰卫衣', '粉色衬衫', '薄款开衫'],
    bottoms: ['卡其休闲裤', '直筒牛仔裤', '米色阔腿裤', '灰色西裤', '九分烟管裤'],
    outer: ['米色薄风衣', '牛仔夹克', '针织开衫外套', '薄款西装外套'],
    shoes: ['白色运动鞋', '黑色乐福鞋', '帆布鞋', '小白鞋'],
    bags: ['帆布托特包', '棕色皮质单肩包', '尼龙双肩包', '链条小包'],
    accessories: ['细银项链', '金属腕表', '丝巾', '珍珠耳钉', '皮质腰带'],
    hairstyle: ['自然披发', '低马尾', '半扎发', '侧分短发', '微卷长发'],
    pajamas: ['纯棉睡衣套装', '法兰绒睡衣', '丝质睡袍', '棉质家居服'],
  },
  summer: {
    tops: ['白色棉质短袖T恤', '条纹短袖衬衫', '亚麻宽松衬衫', '薄款背心', '无袖针织'],
    bottoms: ['牛仔短裤', '轻薄阔腿裤', '卡其五分裤', '亚麻休闲裤', 'A字半身裙'],
    outer: ['薄款防晒衬衫', '亚麻外搭开衫', '轻薄针织披肩'],
    shoes: ['白色帆布鞋', '凉鞋', '凉拖', '小白鞋', '草编平底鞋'],
    bags: ['草编托特包', '帆布单肩包', '尼龙双肩包', '链条小包'],
    accessories: ['细银项链', '太阳镜', '草编帽', '珍珠耳钉', '细手链'],
    hairstyle: ['清爽马尾', '丸子头', '自然披发', '侧分短发', '半扎发'],
    pajamas: ['薄棉短袖睡衣', '丝质睡裙', '冰丝睡衣套装', '透气棉质家居服'],
  },
  autumn: {
    tops: ['法兰绒衬衫', '套头卫衣', '高领薄针织', '格纹衬衫', '米色毛衣'],
    bottoms: ['深蓝直筒牛仔裤', '灯芯绒休闲裤', '格纹半身裙', '黑色直筒西裤', '卡其工装裤'],
    outer: ['驼色风衣', '麂皮夹克', '针织大衣', '薄款羽绒马甲', '牛仔外套'],
    shoes: ['棕色切尔西靴', '白色运动鞋', '黑色乐福鞋', '帆布鞋'],
    bags: ['黑色托特包', '棕色皮质单肩包', '尼龙双肩包', '链条小包'],
    accessories: ['细银项链', '金属腕表', '丝巾', '皮质腰带', '羊毛围巾'],
    hairstyle: ['自然披发', '低马尾', '半扎发', '微卷长发', '利落背头'],
    pajamas: ['棉质长袖睡衣套装', '法兰绒睡衣', '丝质睡袍', '针织家居服'],
  },
  winter: {
    tops: ['高领羊绒衫', '加厚卫衣', '羊毛针织衫', '保暖打底衫', '法兰绒衬衫'],
    bottoms: ['加绒牛仔裤', '羊毛西裤', '加厚休闲裤', '灯芯绒长裤', '灰色运动束脚裤'],
    outer: ['驼色羊毛大衣', '深灰羽绒服', '双排扣呢大衣', '黑色短款羽绒夹克', '皮草领大衣'],
    shoes: ['棕色切尔西靴', '加绒乐福鞋', '雪地靴', '黑色短靴'],
    bags: ['黑色托特包', '棕色皮质单肩包', '尼龙双肩包', '链条小包'],
    accessories: ['羊毛围巾', '皮质手套', '金属腕表', '针织帽', '珍珠耳钉'],
    hairstyle: ['自然披发', '低马尾', '半扎发', '利落背头', '微卷长发'],
    pajamas: ['加绒睡衣套装', '珊瑚绒睡衣', '羊绒家居服', '厚棉睡袍'],
  },
};

const SEASON_INAPPROPRIATE_RE = {
  spring: /羽绒|加厚|保暖|雪地靴|棉服|派克|皮草|羊绒大衣|羊毛大衣|凉拖|凉鞋|无袖|吊带|短裤|五分裤|草编/,
  summer: /羽绒|加厚|保暖|雪地靴|棉服|派克|皮草|羊绒|羊毛大衣|呢大衣|高领羊绒|针织帽|手套|围巾|切尔西靴|短靴/,
  autumn: /厚羽绒|雪地靴|凉拖|无袖|吊带|短裤|五分裤|草编凉鞋/,
  winter: /短袖(?!.*内搭)|吊带|无袖|凉鞋|凉拖|草编|短裤|五分裤|亚麻|防晒|薄款T恤/,
};

const BRAND_STYLES_DAILY = ['日常休闲', '基础通勤', 'COS 风', 'Uniqlo 风', 'A.P.C. 风'];
const BRAND_STYLES_QUIET = ['The Row 风', 'Loro Piana 风', 'Max Mara 风', 'The Row 风', 'Brunello Cucinelli 风', 'Toteme 风', 'Jil Sander 风'];
const BRAND_STYLES_FLASHY = ['Saint Laurent 风', 'Gucci 风', 'Balenciaga 风', 'Dior 风', 'Versace 风', 'Louis Vuitton 风'];
const WEIRD_STYLE_RE = /海洋|海浪|珊瑚|贝壳|杂技|马戏|小丑|星空|银河|赛博|精灵|魔法|暗黑系|甜美风|森系|学院风自创|人鱼|舞台/;

function parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function normalizeName(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

function parseAppearanceProfile(raw) {
  const o = parseJson(raw, {});
  return {
    height: String(o.height || '').trim(),
    build: String(o.build || '').trim(),
    hair_color: String(o.hair_color || '').trim(),
    hair_length: String(o.hair_length || '').trim(),
    eye_color: String(o.eye_color || '').trim(),
    skin_tone: String(o.skin_tone || '').trim(),
    piercings: String(o.piercings || '').trim(),
    marks: String(o.marks || '').trim(),
  };
}

function appearanceProfileToPrompt(profile) {
  if (!profile) return '';
  const bits = [];
  if (profile.height) bits.push(`height ${profile.height}, keep this adult height, long limbs, not short or compact`);
  if (profile.build) bits.push(`${profile.build} build`);
  if (profile.hair_color || profile.hair_length) {
    bits.push(`${profile.hair_length || ''} ${profile.hair_color || ''} hair`.trim());
  }
  if (profile.eye_color) bits.push(`${profile.eye_color} eyes`);
  if (profile.skin_tone) bits.push(`${profile.skin_tone} skin`);
  if (profile.piercings) bits.push(`piercings: ${profile.piercings}`);
  if (profile.marks) bits.push(`marks: ${profile.marks}`);
  return bits.join(', ');
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function getCurrentSeason(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

function seasonPromptText(season) {
  const map = {
    spring: '春季（3–5月）：薄外套、衬衫、针织，不要羽绒服/雪地靴/加厚棉服，也不要明显夏装（吊带短裤凉鞋）。',
    summer: '夏季（6–8月）：短袖、薄裤、凉鞋、防晒外搭，禁止羽绒服、羊毛大衣、羊绒、雪地靴、加厚保暖单品。',
    autumn: '秋季（9–11月）：风衣、薄针织、夹克、切尔西靴，不要厚羽绒/雪地靴，也不要吊带短裤凉鞋。',
    winter: '冬季（12–2月）：大衣、羽绒、高领针织、保暖裤、靴子，不要短袖外穿、吊带、短裤、凉鞋。',
  };
  return map[season] || map.spring;
}

function isSeasonAppropriate(name, season) {
  const re = SEASON_INAPPROPRIATE_RE[season];
  if (!re) return true;
  return !re.test(String(name || ''));
}

function categoryUsesSeasonTag(category) {
  return category !== 'bags' && category !== 'accessories' && category !== 'pajamas' && category !== 'hairstyle';
}

function tagsForCategory(category, season) {
  if (!categoryUsesSeasonTag(category)) return [];
  const label = SEASON_LABELS[season];
  return label ? [label] : [];
}

function stripSeasonTags(tags) {
  const drop = new Set(Object.values(SEASON_LABELS));
  return (Array.isArray(tags) ? tags : []).filter((t) => t && !drop.has(String(t)));
}

function fallbackPoolForSeason(category, season) {
  const pools = FALLBACK_POOLS_BY_SEASON[season] || FALLBACK_POOLS_BY_SEASON.spring;
  return pools[category] || FALLBACK_POOLS_BY_SEASON.spring[category] || ['基础单品'];
}

function pickFromPool(pool, seed, used) {
  const avail = pool.filter((x) => !used.has(normalizeName(x)));
  if (!avail.length) return null;
  return avail[seed % avail.length];
}

function inferDressPersona(char) {
  const blob = [
    char?.name, char?.intro, char?.personality, char?.background,
    char?.description, char?.behavior, char?.relationship,
  ].filter(Boolean).join('\n');
  const rich = /富[有裕豪]|有钱|豪门|名媛|总裁|继承人|名流|上流|财阀|世家|名利场|奢侈|名牌|别墅|私人飞机|名表|身家|阔少|太子|公主|贵妇|名门|财团|亿万|千万|富二代|豪宅/.test(blob);
  const flashy = /张扬|高调|招摇/.test(blob);
  const lowkey = /低调|内敛|朴素|简约/.test(blob);
  let vibe = 'daily';
  if (flashy) vibe = 'flashy';
  else if (rich || lowkey) vibe = 'quiet';
  return { blob: blob.slice(0, 900), rich, vibe };
}

function brandStylePool(persona) {
  if (persona.rich && persona.vibe === 'flashy') return BRAND_STYLES_FLASHY;
  if (persona.rich || persona.vibe === 'quiet') return BRAND_STYLES_QUIET;
  return BRAND_STYLES_DAILY;
}

function pickBrandStyle(seed, persona) {
  const pool = brandStylePool(persona || { rich: false, vibe: 'daily' });
  return pool[seed % pool.length];
}

function sanitizeBrandStyle(raw, persona, seed) {
  const s = String(raw || '').trim().slice(0, 24);
  if (!s || WEIRD_STYLE_RE.test(s) || /风风/.test(s)) return pickBrandStyle(seed, persona);
  if (persona?.rich && /简约风|休闲风|街头风|运动风|森系|甜美/.test(s) && !/Row|Piana|Mara|Herm|Gucci|Dior|Yves|Laurent|Vuitton|Celine|The Row|Max Mara/.test(s)) {
    return pickBrandStyle(seed, persona);
  }
  return s;
}

function listWardrobeItems(charId) {
  return db.prepare(
    'SELECT * FROM char_wardrobe_items WHERE character_id=? ORDER BY category, id'
  ).all(charId).map((row) => {
    const tags = parseJson(row.tags, []);
    return {
      ...row,
      tags: categoryUsesSeasonTag(row.category) ? tags : stripSeasonTags(tags),
    };
  });
}

function getExistingNames(charId) {
  return new Set(listWardrobeItems(charId).map((it) => normalizeName(it.name)));
}

function insertWardrobeItem(charId, item) {
  ensureImageUrlColumn();
  try {
    const r = db.prepare(
      `INSERT INTO char_wardrobe_items (character_id, category, name, brand_style, description, tags, source, image_url)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      charId,
      item.category,
      item.name,
      item.brand_style || '',
      item.description || '',
      JSON.stringify(item.tags || []),
      item.source || 'ai',
      item.image_url || '',
    );
    return { id: r.lastInsertRowid, ...item };
  } catch {
    const r = db.prepare(
      `INSERT INTO char_wardrobe_items (character_id, category, name, brand_style, description, tags, source)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      charId,
      item.category,
      item.name,
      item.brand_style || '',
      item.description || '',
      JSON.stringify(item.tags || []),
      item.source || 'ai',
    );
    return { id: r.lastInsertRowid, ...item };
  }
}

function ensureImageUrlColumn() {
  try {
    db.exec(`ALTER TABLE char_wardrobe_items ADD COLUMN image_url TEXT DEFAULT ''`);
  } catch { /* exists */ }
}

function generateFallbackItem(char, category, usedNames, idx = 0, persona, season) {
  let pool = fallbackPoolForSeason(category, season);
  if (categoryUsesSeasonTag(category)) {
    pool = pool.filter((n) => isSeasonAppropriate(n, season));
  }
  const seed = hashSeed(`${char.id}-${category}-${Date.now()}-${idx}`);
  const name = pickFromPool(pool, seed, usedNames);
  if (!name) return null;
  usedNames.add(normalizeName(name));
  return {
    category,
    name,
    brand_style: pickBrandStyle(seed, persona),
    description: '',
    tags: tagsForCategory(category, season),
    source: 'ai',
  };
}

function parseAiPurchaseJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : (parsed.items || []);
  } catch {}
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  return [];
}

async function purchaseWardrobeItems(charId, categories, { settings, callChatAPIComplete } = {}) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) throw new Error('角色不存在');
  const cats = (categories || []).filter((c) => WARDROBE_CATEGORIES[c]);
  if (!cats.length) throw new Error('请选择至少一个品类');

  const used = getExistingNames(charId);
  const need = [];
  for (const cat of cats) {
    const n = WARDROBE_CATEGORIES[cat].purchaseCount || 1;
    for (let i = 0; i < n; i++) need.push(cat);
  }

  const persona = inferDressPersona(char);
  const season = getCurrentSeason();
  const seasonLabel = SEASON_LABELS[season];
  const vibeText = persona.vibe === 'flashy' ? '张扬、有设计感、敢穿秀场款' : persona.vibe === 'quiet' ? '低调克制、面料和剪裁说话' : '日常舒适、能出门办事的成衣';
  const wealthText = persona.rich ? '经济宽裕，衣柜应对标现实世界名奢/静奢，brand_style 必须是真实品牌+「风」，例如 The Row 风、Loro Piana 风、Max Mara 风、Hermès 风、Saint Laurent 风。禁止自创「海洋风」「星空风」「杂技风」等主题名。' : '普通消费水平，用 COS / Uniqlo / A.P.C. / Massimo Dutti 等真实成衣品牌风，或写「日常休闲」「基础通勤」。';

  let aiItems = [];
  if (callChatAPIComplete && settings) {
    const existing = listWardrobeItems(charId).slice(-30).map((it) => `${it.category}:${it.name}`).join('；') || '（空）';
    const sys = `你是现实世界买手，只买这个人会真实穿着的衣服。只输出 JSON 数组，不要其它文字。每项字段：category,name,brand_style,description。
category 必须是 tops/bottoms/outer/shoes/bags/accessories/hairstyle 之一。
name 为中文单品名，必须是现实能买到的衣服，禁止主题戏服、海洋元素堆砌、舞台杂技、cos、魔法、赛博。
brand_style 只能是真实品牌风（The Row 风、Gucci 风）或穿衣方式（日常休闲、基础通勤），禁止自创风格名。
description【硬性】必须用角色第一人称「我」，只写我对**这件衣服本身**的看法：版型、面料、颜色、好不好穿、什么场合想穿、喜不喜欢这件。一两句中文口语。
禁止：导购说明、英文堆砌、写对用户/对方的想法、想见谁、想穿给谁看、想念、撒娇讨好等与衣服无关的话。
禁止与已有单品重名。
当前季节：${seasonLabel}季。上装/下装/外套/鞋履须符合：${seasonPromptText(season)}
包袋、配饰、发型不受季节限制，不要标春夏秋冬。`;
    const user = `角色：${char.name}
人设：
${persona.blob || '（未填写，按名字气质判断）'}
经济与穿衣判断：${wealthText}
穿衣性格：${vibeText}
季节要求：现在是${seasonLabel}季，上装/下装/外套/鞋履必须是${seasonLabel}季日常会穿的厚度与款式，严禁反季单品。包袋、配饰、发型不必按季节。
已有：${existing}
请生成 ${need.length} 件，按顺序对应品类：${need.join(', ')}`;
    try {
      const raw = await callChatAPIComplete(settings, sys, user, 'memory');
      aiItems = parseAiPurchaseJson(raw || '');
    } catch (e) {
      console.warn('[wardrobe] AI purchase fallback', e.message);
    }
  }

  const created = [];
  for (let i = 0; i < need.length; i++) {
    const cat = need[i];
    let item = null;
    const ai = aiItems[i];
    if (ai && ai.name && WARDROBE_CATEGORIES[ai.category || cat]) {
      const nm = String(ai.name).trim();
      const weirdName = /海洋|海浪|珊瑚|贝壳|杂技|马戏|小丑|人鱼|舞台|赛博|精灵|魔法/.test(nm);
      if (nm && !used.has(normalizeName(nm)) && !weirdName
        && (!categoryUsesSeasonTag(cat) || isSeasonAppropriate(nm, season))) {
        used.add(normalizeName(nm));
        item = {
          category: ai.category || cat,
          name: nm,
          brand_style: sanitizeBrandStyle(ai.brand_style, persona, hashSeed(nm)),
          description: String(ai.description || '').slice(0, 160),
          tags: tagsForCategory(ai.category || cat, season),
          source: 'ai',
        };
      }
    }
    if (!item) item = generateFallbackItem(char, cat, used, i, persona, season);
    if (!item) continue;
    created.push(insertWardrobeItem(charId, item));
  }
  return created;
}

function getDailyOutfits(charId, dateStr) {
  const rows = db.prepare(
    'SELECT * FROM char_daily_outfits WHERE character_id=? AND date=?'
  ).all(charId, dateStr);
  const map = {};
  for (const row of rows) {
    map[row.slot] = {
      ...parseJson(row.outfit_json, {}),
      source: row.source,
      updated_at: row.updated_at,
    };
  }
  return map;
}

function saveDailyOutfit(charId, dateStr, slot, outfit, source = 'user') {
  const json = JSON.stringify(outfit || {});
  const existing = db.prepare(
    'SELECT id FROM char_daily_outfits WHERE character_id=? AND date=? AND slot=?'
  ).get(charId, dateStr, slot);
  if (existing) {
    db.prepare(
      `UPDATE char_daily_outfits SET outfit_json=?, source=?, updated_at=datetime('now') WHERE id=?`
    ).run(json, source, existing.id);
  } else {
    db.prepare(
      `INSERT INTO char_daily_outfits (character_id, date, slot, outfit_json, source) VALUES (?,?,?,?,?)`
    ).run(charId, dateStr, slot, json, source);
  }
}

function itemById(items, id) {
  if (!id) return null;
  return items.find((it) => it.id === id) || null;
}

function buildOutfitSummary(outfit, items) {
  const parts = [];
  const add = (id) => {
    const it = itemById(items, id);
    if (it) parts.push(it.name);
  };
  add(outfit.hairstyle_item_id);
  add(outfit.suit_item_id);
  add(outfit.gown_item_id);
  // 有套装/礼服时不再叠加上下装名称，避免提示词打架
  if (!outfit.suit_item_id && !outfit.gown_item_id) {
    add(outfit.top_item_id);
    add(outfit.bottom_item_id);
  }
  add(outfit.outer_item_id);
  add(outfit.shoes_item_id);
  add(outfit.bag_item_id);
  (outfit.accessory_item_ids || []).forEach(add);
  return parts.join(' · ');
}

function buildOutfitPromptEn(outfit, items) {
  const bits = [];
  const add = (id) => {
    const it = itemById(items, id);
    if (!it) return;
    // 中文「我」感想不能进英文出图提示，只用单品名
    bits.push(it.name || it.brand_style || '');
  };
  add(outfit.hairstyle_item_id);
  add(outfit.suit_item_id);
  add(outfit.gown_item_id);
  if (!outfit.suit_item_id && !outfit.gown_item_id) {
    add(outfit.top_item_id);
    add(outfit.bottom_item_id);
  }
  add(outfit.outer_item_id);
  add(outfit.shoes_item_id);
  add(outfit.bag_item_id);
  (outfit.accessory_item_ids || []).forEach(add);
  return bits.join(', ');
}

function pickItemForSlot(items, category, seed, exclude = new Set(), season, giftBias = 0) {
  const seasonTag = season ? SEASON_LABELS[season] : '';
  let pool = items.filter((it) => it.category === category && !exclude.has(it.id));
  if (season && categoryUsesSeasonTag(category)) {
    const seasonal = pool.filter((it) => isSeasonAppropriate(it.name, season));
    if (seasonal.length) pool = seasonal;
    else if (seasonTag) {
      const tagged = pool.filter((it) => (it.tags || []).includes(seasonTag));
      if (tagged.length) pool = tagged;
    }
  }
  if (!pool.length) return null;
  const gifts = pool.filter((it) => it.source === 'gift');
  const bias = Math.max(0, Math.min(0.9, Number(giftBias) || 0));
  if (gifts.length && bias > 0 && (seed % 100) < Math.floor(bias * 100)) {
    const pick = gifts[seed % gifts.length];
    exclude.add(pick.id);
    return pick;
  }
  const pick = pool[seed % pool.length];
  exclude.add(pick.id);
  return pick;
}

/** 按性格决定「更爱穿用户送的衣服」的概率（不是必穿） */
function giftWearBiasForChar(char) {
  const blob = [
    char?.personality, char?.behavior, char?.relationship, char?.emotion_style, char?.intro,
  ].map((s) => String(s || '')).join('\n');
  if (/冷淡|疏离|独立|嫌麻烦|不在乎礼物|讨厌送礼|清高|拒收/.test(blob)) return 0.22;
  if (/恋爱脑|黏人|珍惜|感性|念旧|吃软|重感情|温柔|宠|依恋|会想念|重视对方|容易感动/.test(blob)) {
    return 0.72;
  }
  if (/傲娇|别扭|嘴硬|要面子/.test(blob)) return 0.48;
  return 0.4;
}

function composeOutfitForSlot(charId, slot, items, seedBase, season, char = null) {
  const exclude = new Set();
  const outfit = { accessory_item_ids: [] };
  const seed = (s) => hashSeed(`${seedBase}-${slot}-${s}`);
  const bias = giftWearBiasForChar(char || { id: charId });
  const pick = (cat, s) => pickItemForSlot(items, cat, seed(s), exclude, season, bias);

  if (slot === 'sleep') {
    outfit.top_item_id = pick('tops', 1)?.id || null;
    outfit.bottom_item_id = pick('bottoms', 2)?.id || null;
  } else if (slot === 'sport_bath') {
    outfit.top_item_id = pick('tops', 3)?.id || null;
    outfit.bottom_item_id = pick('bottoms', 4)?.id || null;
    outfit.shoes_item_id = pick('shoes', 5)?.id || null;
  } else if (slot === 'work') {
    outfit.hairstyle_item_id = pick('hairstyle', 6)?.id || null;
    outfit.top_item_id = pick('tops', 7)?.id || null;
    outfit.bottom_item_id = pick('bottoms', 8)?.id || null;
    outfit.outer_item_id = pick('outer', 9)?.id || null;
    outfit.shoes_item_id = pick('shoes', 10)?.id || null;
    outfit.bag_item_id = pick('bags', 11)?.id || null;
    const acc = pick('accessories', 12);
    if (acc) outfit.accessory_item_ids.push(acc.id);
  } else if (slot === 'social') {
    outfit.hairstyle_item_id = pick('hairstyle', 13)?.id || null;
    outfit.top_item_id = pick('tops', 14)?.id || null;
    outfit.bottom_item_id = pick('bottoms', 15)?.id || null;
    outfit.outer_item_id = pick('outer', 16)?.id || null;
    outfit.shoes_item_id = pick('shoes', 17)?.id || null;
    outfit.bag_item_id = pick('bags', 18)?.id || null;
    const acc = pick('accessories', 19);
    if (acc) outfit.accessory_item_ids.push(acc.id);
  } else if (slot === 'out') {
    outfit.top_item_id = pick('tops', 20)?.id || null;
    outfit.bottom_item_id = pick('bottoms', 21)?.id || null;
    outfit.outer_item_id = pick('outer', 22)?.id || null;
    outfit.shoes_item_id = pick('shoes', 23)?.id || null;
    outfit.bag_item_id = pick('bags', 24)?.id || null;
  } else {
    outfit.top_item_id = pick('tops', 25)?.id || null;
    outfit.bottom_item_id = pick('bottoms', 26)?.id || null;
    outfit.shoes_item_id = pick('shoes', 27)?.id || null;
  }

  outfit.summary_zh = buildOutfitSummary(outfit, items);
  outfit.outfit_prompt_en = buildOutfitPromptEn(outfit, items);
  return outfit;
}

function inferSlotFromActivity(activity) {
  const act = String(activity || '');
  for (const [slot, re] of Object.entries(SLOT_INFER_RE)) {
    if (re.test(act)) return slot;
  }
  return 'home';
}

function inferCurrentSlotFromSchedule(charId, dateStr) {
  try {
    const row = db.prepare(
      `SELECT items FROM schedules WHERE character_id=? AND role='ai' AND date=? ORDER BY id DESC LIMIT 1`
    ).get(charId, dateStr);
    const items = parseJson(row?.items, []);
    if (!Array.isArray(items) || !items.length) return 'home';
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    let current = items[0];
    for (const it of items) {
      const t = String(it.time || '12:00').match(/(\d{1,2}):(\d{2})/);
      if (!t) continue;
      const mins = parseInt(t[1], 10) * 60 + parseInt(t[2], 10);
      if (mins <= nowMins) current = it;
    }
    return inferSlotFromActivity(current.activity || current.title || '');
  } catch {
    return 'home';
  }
}

async function generateDailyOutfitsForChar(charId, dateStr, opts = {}) {
  const items = listWardrobeItems(charId);
  if (!items.length) return null;
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  const season = getCurrentSeason(new Date(`${dateStr}T12:00:00`));
  const seedBase = `${charId}-${dateStr}`;
  const result = {};
  for (const slot of OUTFIT_SLOTS) {
    const existing = db.prepare(
      'SELECT source FROM char_daily_outfits WHERE character_id=? AND date=? AND slot=?'
    ).get(charId, dateStr, slot.id);
    if (existing && existing.source === 'user' && !opts.force) continue;
    const outfit = composeOutfitForSlot(charId, slot.id, items, seedBase, season, char);
    saveDailyOutfit(charId, dateStr, slot.id, outfit, 'ai');
    result[slot.id] = outfit;
  }
  return result;
}

function resolveCurrentOutfit(charId, dateStr, slot) {
  const resolvedSlot = slot || inferCurrentSlotFromSchedule(charId, dateStr);
  const row = db.prepare(
    'SELECT outfit_json FROM char_daily_outfits WHERE character_id=? AND date=? AND slot=?'
  ).get(charId, dateStr, resolvedSlot);
  const outfit = parseJson(row?.outfit_json, null);
  if (!outfit) return { slot: resolvedSlot, outfit: null, summary: '', promptEn: '', wornItems: [] };
  const items = listWardrobeItems(charId);
  const wornItems = collectWornItems(outfit, items);
  const summary = outfit.summary_zh || buildOutfitSummary(outfit, items);
  const promptEn = outfit.outfit_prompt_en || buildOutfitPromptEn(outfit, items);
  return { slot: resolvedSlot, outfit, summary, promptEn, wornItems };
}

function collectWornItems(outfit, items) {
  if (!outfit) return [];
  const ids = [
    outfit.hairstyle_item_id,
    outfit.suit_item_id,
    outfit.gown_item_id,
    outfit.top_item_id,
    outfit.bottom_item_id,
    outfit.outer_item_id,
    outfit.shoes_item_id,
    outfit.bag_item_id,
    ...(outfit.accessory_item_ids || []),
  ].filter(Boolean);
  return ids.map((id) => itemById(items, id)).filter(Boolean);
}

function buildOutfitAppearanceHint(char, dateStr, slot, opts = {}) {
  if (!char?.id) return '';
  const profile = appearanceProfileToPrompt(parseAppearanceProfile(char.appearance_profile));
  const bits = [];
  if (profile) bits.push(profile);

  const override = opts.outfitOverride;
  const skipDaily = !!(opts.skipDailyOutfit || override?.skipDaily);
  if (skipDaily) {
    const phrase = String(override?.phrase || opts.outfitPhrase || '').trim();
    if (phrase) {
      bits.push(`wearing exactly: ${phrase}`);
      bits.push('ignore clothing in all reference photos including wardrobe item photos');
      bits.push('do not use today\'s daily wardrobe outfit');
    } else {
      bits.push('wear the outfit described in the scene prompt');
      bits.push('ignore clothing in all reference photos including wardrobe item photos');
      bits.push('do not use today\'s daily wardrobe outfit');
    }
    return bits.filter(Boolean).join('; ');
  }

  const { summary, promptEn, wornItems } = resolveCurrentOutfit(char.id, dateStr, slot);
  if (promptEn) {
    bits.push(`wearing exactly: ${promptEn}`);
    bits.push('ignore clothing in face reference photos, keep the specified outfit');
  } else if (summary) {
    bits.push(`wearing exactly: ${summary}`);
  }
  const giftedWorn = (wornItems || []).filter((it) => it.source === 'gift');
  if (giftedWorn.length) {
    bits.push(`gift from user (must keep): ${giftedWorn.map((g) => g.name).join(', ')}`);
  }
  if (!bits.length) return '';
  return bits.join('; ');
}

/** 从用户话 /「自拍：」行里抽出明确换装请求，避免被今日衣柜盖掉 */
function extractOutfitPhrase(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const clean = (s) => String(s || '')
    .replace(/(?:给我)?(?:发过来|发一张|发张|自拍一张|自拍|拍一张|拍张|看看|过来).*$/u, '')
    .replace(/^(?:换成|换上|换个|改穿|打扮成|穿成|穿上|穿着|穿)\s*/u, '')
    .trim();
  const m1 = t.match(/(?:换成|换上|换个|改穿|打扮成|穿成|穿上|穿着|穿)\s*([^，。！？；;\n「」『』【】]{2,48}?(?:装|裙|服|衣|制服|套装|睡衣|泳装|礼服|汉服|旗袍|cos(?:play)?))/i);
  if (m1?.[1]) {
    const p = clean(m1[1]);
    if (p) return p;
  }
  const m2 = t.match(/((?:猫耳|兽耳|兔耳)?[\u4e00-\u9fffA-Za-z]{0,8}?(?:女仆装|护士服|兔女郎|JK制服|洛丽塔|婚纱|汉服|旗袍|西装|泳装|睡衣|校服|和服))/i);
  if (m2?.[1]) {
    const p = clean(m2[1]);
    if (p) return p;
  }
  const m3 = t.match(/(?:wearing|dressed\s+(?:as|in)|in\s+a)\s+([^,]{3,60})/i);
  if (m3?.[1]) return m3[1].trim();
  return '';
}

/**
 * 用户明确要求换某身衣服拍照时返回 override；日常自拍仍走今日衣柜。
 * @returns {{ skipDaily: true, phrase: string } | null}
 */
function detectExplicitOutfitOverride({ userMessage = '', sceneQuery = '' } = {}) {
  const user = String(userMessage || '');
  const scene = String(sceneQuery || '');
  const costumeRe = /猫耳|兽耳|兔耳|女仆|maid|制服|JK|洛丽塔|lolita|礼服|泳装|睡衣|汉服|旗袍|cosplay|婚纱|护士服|兔女郎|和服|校服|盔甲|翅膀|西装裙|连衣裙|旗袍|jk裙/i;
  const changeIntent = /换(?:成|上|件|身|套)|穿上|改穿|打扮成|穿成|cos\s*成|扮成/i.test(user)
    || /(?:给我|帮我|想看你|想看).{0,16}(?:穿|换).{0,24}(?:装|裙|服|衣|制服|cos)/i.test(user)
    || /(?:穿|换).{0,20}(?:装|裙|服|衣|制服).{0,12}(?:发|拍|自拍|照|图|过来)/i.test(user)
    || (costumeRe.test(user) && /(?:发|拍|自拍|照|图|过来|看看)/i.test(user));
  const sceneCostume = costumeRe.test(scene)
    || /(?:wearing|dressed\s+(?:as|in)|in\s+a)\s+[^,]{3,40}(?:maid|uniform|dress|costume|outfit|kimono)/i.test(scene);

  if (!changeIntent && !sceneCostume) return null;

  const phrase = extractOutfitPhrase(user) || extractOutfitPhrase(scene);
  return { skipDaily: true, phrase: String(phrase || '').trim().slice(0, 120) };
}

/** 今日穿搭 → 聊天系统提示（让角色知道自己穿什么、哪件是用户送的） */
function buildOutfitChatPromptBlock(char, dateStr, opts = {}) {
  if (!char?.id) return '';
  const override = opts.outfitOverride || detectExplicitOutfitOverride({ userMessage: opts.userMessage || '' });
  if (override?.skipDaily) {
    const phrase = String(override.phrase || '').trim();
    return `本轮用户明确要求换特定服装拍照：${phrase || '按用户话里指定的那身'}。
写「自拍：」时必须按这身来写，禁止改回今日衣柜默认穿搭或白 T / casual outfit。拍完这张后，日常仍按今日穿搭。`;
  }
  const d = dateStr || (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  })();
  let resolved = resolveCurrentOutfit(char.id, d);
  if (!resolved.outfit) {
    try {
      // 今日尚未生成穿搭时现补一版，避免自拍/聊天完全无着装
      generateDailyOutfitsForChar(char.id, d);
      resolved = resolveCurrentOutfit(char.id, d);
    } catch {}
  }
  if (!resolved.summary && !resolved.promptEn) return '';
  const slotLabel = (OUTFIT_SLOTS.find((s) => s.id === resolved.slot) || {}).label || resolved.slot;
  const giftNames = (resolved.wornItems || [])
    .filter((it) => it.source === 'gift')
    .map((it) => it.name);
  const giftLine = giftNames.length
    ? `\n其中「${giftNames.join('」「')}」是用户寄来的礼物——你清楚是对方送的；聊到穿搭或发自拍时可以自然流露这一点，但不要每句都提。`
    : '';
  return `当前场合：${slotLabel}；这身：${resolved.summary || resolved.promptEn}${giftLine}
写「自拍：」时必须按这身具体穿着来写，禁止改成白 T / casual outfit 等套话。`;
}

function collectOutfitClothingRefUrls(charId, dateStr, slot) {
  const { wornItems } = resolveCurrentOutfit(charId, dateStr, slot);
  return (wornItems || [])
    .filter((it) => it.image_url)
    .map((it) => String(it.image_url).trim())
    .filter(Boolean)
    .slice(0, 3);
}

module.exports = {
  WARDROBE_CATEGORIES,
  OUTFIT_SLOTS,
  SEASON_LABELS,
  getCurrentSeason,
  parseAppearanceProfile,
  appearanceProfileToPrompt,
  listWardrobeItems,
  insertWardrobeItem,
  purchaseWardrobeItems,
  getDailyOutfits,
  saveDailyOutfit,
  generateDailyOutfitsForChar,
  resolveCurrentOutfit,
  inferCurrentSlotFromSchedule,
  buildOutfitAppearanceHint,
  buildOutfitChatPromptBlock,
  collectOutfitClothingRefUrls,
  detectExplicitOutfitOverride,
  extractOutfitPhrase,
  giftWearBiasForChar,
  buildOutfitSummary,
};

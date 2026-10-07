/**
 * 跨时空邮局：寄信件 / 服饰 / 摆件等，在途物流可见，签收后按类别落地。
 */
const db = require('./db');

const CATEGORIES = [
  { id: 'letter', label: '信件', needsImage: false, needsLetter: true },
  { id: 'clothing', label: '服饰', needsImage: true, needsLetter: false },
  { id: 'decor', label: '摆件', needsImage: true, needsLetter: false },
  { id: 'daily', label: '日常用品', needsImage: true, needsLetter: false },
  { id: 'food', label: '食物零食', needsImage: true, needsLetter: false },
  { id: 'other', label: '其他', needsImage: true, needsLetter: false },
];

const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

const { WARDROBE_CATEGORIES } = require('./wardrobe-helper');

const CLOTHING_SLOT_ORDER = ['tops', 'bottoms', 'outer', 'shoes', 'bags', 'accessories', 'hairstyle', 'suit', 'gown', 'pajamas'];
const CLOTHING_SLOTS = CLOTHING_SLOT_ORDER
  .filter((id) => WARDROBE_CATEGORIES[id])
  .map((id) => ({ id, label: WARDROBE_CATEGORIES[id].label }));

const LOGISTICS_TEMPLATES = [
  { code: 'accepted', text: '已揽收 · 离开你的时空' },
  { code: 'relay', text: '中继转运 · 跨时空邮路颠簸中' },
  { code: 'border', text: '抵达对方世界边境 · 清点包裹' },
  { code: 'out', text: '派送中 · 正在找人签收' },
  { code: 'delivered', text: '已签收' },
];

function getSettings() {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_office_parcels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      clothing_slot TEXT DEFAULT '',
      name TEXT DEFAULT '',
      note TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      letter_content TEXT DEFAULT '',
      letter_entry_id INTEGER DEFAULT NULL,
      wardrobe_item_id INTEGER DEFAULT NULL,
      status TEXT DEFAULT 'in_transit',
      logistics_json TEXT DEFAULT '[]',
      reaction_json TEXT DEFAULT '{}',
      posted_at TEXT DEFAULT (datetime('now')),
      deliver_at TEXT DEFAULT NULL,
      delivered_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS post_office_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parcel_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      kind TEXT DEFAULT 'deliver',
      run_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_po_parcels_char ON post_office_parcels(character_id, status);
    CREATE INDEX IF NOT EXISTS idx_po_jobs_due ON post_office_jobs(done, run_at);
  `);
  try {
    db.exec(`ALTER TABLE char_wardrobe_items ADD COLUMN image_url TEXT DEFAULT ''`);
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE post_office_parcels ADD COLUMN message TEXT DEFAULT ''`);
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE post_office_parcels ADD COLUMN notify_transit INTEGER DEFAULT 0`);
  } catch { /* already exists */ }
}

try { ensureTables(); } catch (e) {
  console.warn('[post-office] ensureTables', e.message);
}

function normalizeHourToken(h) {
  const n = parseInt(h, 10);
  if (!Number.isFinite(n)) return '00';
  if (n === 24) return '00';
  return String(Math.max(0, Math.min(23, n))).padStart(2, '0');
}

function sqlNow(tz) {
  const zone = tz || getSettings().timezone || 'Asia/Shanghai';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${normalizeHourToken(g('hour'))}:${g('minute')}:${g('second')}`;
  } catch {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }
}

function isoFromMs(ms, tz) {
  const zone = tz || getSettings().timezone || 'Asia/Shanghai';
  try {
    const d = new Date(ms);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const g = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${normalizeHourToken(g('hour'))}:${g('minute')}:${g('second')}`;
  } catch {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  }
}

function loadChar(id) {
  const cid = Number(id) || 0;
  if (!cid) return null;
  try {
    return db.prepare('SELECT * FROM characters WHERE id=?').get(cid) || null;
  } catch {
    return null;
  }
}

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw || '');
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function sampleTransitDelayMs(char) {
  const letter = require('./letter-helper');
  if (typeof letter.sampleTransitDelayMs === 'function') {
    return letter.sampleTransitDelayMs(char, { forReply: false });
  }
  const lo = Math.log(90 * 60 * 1000);
  const hi = Math.log(48 * 3600 * 1000);
  return Math.floor(Math.exp(lo + Math.random() * (hi - lo)));
}

/** 生成物流节点：前几个在送达前陆续出现，最后签收对齐 deliverAt */
function buildLogisticsPlan(postedMs, deliverMs) {
  const span = Math.max(30 * 60 * 1000, deliverMs - postedMs);
  const fracs = [0, 0.18 + Math.random() * 0.08, 0.45 + Math.random() * 0.1, 0.78 + Math.random() * 0.08, 1];
  return LOGISTICS_TEMPLATES.map((t, i) => ({
    code: t.code,
    text: t.text,
    at: isoFromMs(postedMs + Math.floor(span * fracs[i])),
  }));
}

function visibleLogistics(plan, status) {
  const now = sqlNow();
  const list = Array.isArray(plan) ? plan : [];
  const shown = list.filter((ev) => {
    if (ev.code === 'delivered') return status === 'delivered' || status === 'opened';
    return String(ev.at || '') <= now;
  });
  if (!shown.length && list[0]) return [{ ...list[0], at: list[0].at }];
  return shown;
}

function currentLogisticsHint(plan, status) {
  const shown = visibleLogistics(plan, status);
  if (!shown.length) return '刚投进邮筒';
  return shown[shown.length - 1].text || '在路上';
}

const AWAY_FROM_HOME_RE = /出门|外出|外面|逛街|办事|采购|散步|港区|旧港|码头|渔港|海边|沙滩|海岸|海滨|出差|上班|加班|公司|办公室|通勤|路上|地铁|商场|店里|公园|博物馆|电影院|餐厅|咖啡|约会|拜访|外勤|机场|车站|医院|学校|大学|图书馆|夜市|市集|古镇|景区|展会|开会|会议|培训|上课|健身|跑步|游泳|球场|买菜|理发|见客户|客户|聚餐|堂食/;
const AT_HOME_RE = /在家|家里|居家|别墅|豪宅|客厅|卧室|书房|厨房|阳台|露台|天台|午睡|睡觉|洗漱|护肤|做饭|下厨|看剧|宅家/;
const HEADING_HOME_RE = /回家|到家|回窝|返家|回程|返程/;

function timeToMinutes(t) {
  const [h, m] = String(t || '').split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  return h * 60 + (m || 0);
}

function shiftDateStr(dateStr, days) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function addMinutesToSql(sql, minutes) {
  const raw = String(sql || sqlNow());
  const date = raw.slice(0, 10);
  const time = raw.slice(11, 19) || '00:00:00';
  const [h, m] = time.split(':').map(Number);
  let total = (h || 0) * 60 + (m || 0) + Number(minutes || 0);
  let dayAdd = 0;
  while (total >= 24 * 60) { total -= 24 * 60; dayAdd += 1; }
  while (total < 0) { total += 24 * 60; dayAdd -= 1; }
  const nd = shiftDateStr(date, dayAdd);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${nd} ${hh}:${mm}:00`;
}

function activityLooksAtHome(activity) {
  const a = String(activity || '');
  if (!a) return false;
  if (AWAY_FROM_HOME_RE.test(a) && !HEADING_HOME_RE.test(a) && !AT_HOME_RE.test(a)) return false;
  return AT_HOME_RE.test(a) || HEADING_HOME_RE.test(a);
}

function charCanSignAtHome(char) {
  try {
    const cron = require('./cron');
    const here = cron.getHereAndNowContext?.(char, getSettings());
    if (!here) return true;
    return here.placeMode !== 'away';
  } catch {
    return true;
  }
}

function estimateNextHomeSql(char) {
  const now = sqlNow();
  const today = now.slice(0, 10);
  const nowMins = timeToMinutes(now.slice(11, 16));
  for (let d = 0; d <= 4; d++) {
    const date = shiftDateStr(today, d);
    let items = [];
    try {
      const row = db.prepare(
        `SELECT items FROM schedules WHERE character_id=? AND role='ai' AND date=?`
      ).get(char.id, date);
      items = JSON.parse(row?.items || '[]');
    } catch { items = []; }
    if (!Array.isArray(items)) continue;
    const sorted = items
      .map((it) => ({ ...it, mins: timeToMinutes(it.time) }))
      .filter((it) => it.mins != null && String(it.activity || it.title || '').trim())
      .sort((a, b) => a.mins - b.mins);
    for (const it of sorted) {
      if (d === 0 && nowMins != null && it.mins <= nowMins + 10) continue;
      if (activityLooksAtHome(it.activity || it.title)) {
        const pad = 15 + Math.floor(Math.random() * 40);
        const hh = String(Math.floor(it.mins / 60)).padStart(2, '0');
        const mm = String(it.mins % 60).padStart(2, '0');
        return addMinutesToSql(`${date} ${hh}:${mm}:00`, pad);
      }
    }
  }
  return isoFromMs(Date.now() + (2.5 + Math.random() * 3.5) * 3600 * 1000);
}

function parcelWaitingTooLong(parcel) {
  const posted = String(parcel?.posted_at || '').slice(0, 10);
  const today = sqlNow().slice(0, 10);
  if (!posted || !today) return false;
  const a = new Date(`${posted}T12:00:00`);
  const b = new Date(`${today}T12:00:00`);
  return Number.isFinite(a.getTime()) && (b - a) >= 7 * 24 * 3600 * 1000;
}

function deferParcelUntilHome(parcel) {
  const char = loadChar(parcel.character_id);
  const nextAt = char ? estimateNextHomeSql(char) : isoFromMs(Date.now() + 3 * 3600 * 1000);
  const floor = isoFromMs(Date.now() + 25 * 60 * 1000);
  const runAt = String(nextAt) > String(floor) ? nextAt : floor;
  const logistics = parseJson(parcel.logistics_json, []);
  logistics.push({
    code: 'missed',
    text: '派送未遇 · 收件人不在家，改约派送',
    at: sqlNow(),
  });
  const deliveredEv = logistics.find((e) => e.code === 'delivered');
  if (deliveredEv) deliveredEv.at = runAt;
  db.prepare(`UPDATE post_office_parcels SET logistics_json=?, deliver_at=? WHERE id=?`)
    .run(JSON.stringify(logistics), runAt, parcel.id);
  db.prepare(`UPDATE post_office_jobs SET run_at=? WHERE parcel_id=? AND kind='deliver' AND done=0`)
    .run(runAt, parcel.id);
  try {
    const { push } = require('./push');
    push('post_office_updated', {
      characterId: parcel.character_id,
      parcelId: parcel.id,
      event: 'missed',
      category: parcel.category,
      name: parcel.name,
    });
  } catch {}
  return { deferred: true, runAt };
}

function enqueueJob({ parcelId, characterId, kind, runAt }) {
  const r = db.prepare(`
    INSERT INTO post_office_jobs (parcel_id, character_id, kind, run_at, done)
    VALUES (?,?,?,?,0)
  `).run(parcelId, characterId, kind || 'deliver', runAt);
  return r.lastInsertRowid;
}

function publicReaction(raw) {
  const reaction = parseJson(typeof raw === 'string' ? raw : JSON.stringify(raw || {}), {});
  return {
    type: reaction.type || '',
    wardrobeItemId: reaction.wardrobeItemId || null,
    moment: reaction.moment
      ? { posted: !!reaction.moment.posted, content: reaction.moment.content || '' }
      : null,
    chatSent: !!reaction.chatSent,
  };
}

function publicParcel(row) {
  if (!row) return null;
  const logistics = parseJson(row.logistics_json, []);
  const cat = CATEGORY_MAP[row.category] || { id: row.category, label: row.category };
  return {
    id: row.id,
    character_id: row.character_id,
    category: row.category,
    categoryLabel: cat.label,
    clothing_slot: row.clothing_slot || '',
    name: row.name || '',
    note: row.note || '',
    message: row.message || '',
    notify_transit: Number(row.notify_transit) === 1,
    image_url: row.image_url || '',
    letter_content: row.status === 'in_transit' && row.category === 'letter'
      ? '' // 在途信件正文不提前剧透给「收件侧」；寄件人列表里单独处理
      : (row.letter_content || ''),
    letter_content_mine: row.letter_content || '',
    letter_entry_id: row.letter_entry_id || null,
    wardrobe_item_id: row.wardrobe_item_id || null,
    status: row.status,
    logistics: visibleLogistics(logistics, row.status),
    logisticsHint: currentLogisticsHint(logistics, row.status),
    reaction: publicReaction(row.reaction_json),
    posted_at: row.posted_at,
    delivered_at: row.delivered_at || null,
    created_at: row.created_at,
    // 故意不返回 deliver_at / 签收效果图（效果图只进朋友圈或主动消息）
  };
}

/** 寄件人看自己的在途信：仍可见自己写过的正文 */
function publicParcelForSender(row) {
  const pub = publicParcel(row);
  if (!pub) return null;
  if (row.category === 'letter') {
    pub.letter_content = row.letter_content || '';
  }
  return pub;
}

function createParcel({
  characterId,
  category,
  clothingSlot = '',
  name = '',
  note = '',
  message = '',
  notifyTransit = false,
  imageUrl = '',
  letterContent = '',
}) {
  ensureTables();
  const cid = Number(characterId);
  const cat = CATEGORY_MAP[category];
  if (!cid) throw new Error('请选择收件角色');
  if (!cat) throw new Error('请选择寄件类别');
  const char = loadChar(cid);
  if (!char) throw new Error('角色不存在');

  const letterText = String(letterContent || '').trim().slice(0, 4000);
  const itemName = String(name || '').trim().slice(0, 80);
  const itemNote = String(note || '').trim().slice(0, 500);
  const giftMessage = String(message || '').trim().slice(0, 500);
  const notifyOn = !!notifyTransit;
  const img = String(imageUrl || '').trim().slice(0, 500);

  if (cat.needsLetter) {
    if (!letterText) throw new Error('信不能空着');
  } else {
    if (!img) throw new Error('请上传实物照片');
    if (!itemName) throw new Error('请填写物品名称');
  }

  if (category === 'clothing') {
    const slotOk = CLOTHING_SLOTS.some((s) => s.id === clothingSlot);
    if (!slotOk) throw new Error('请选择服饰分类');
  }

  const delay = sampleTransitDelayMs(char);
  const nowMs = Date.now();
  const now = sqlNow();
  const deliverAt = isoFromMs(nowMs + delay);
  const logistics = buildLogisticsPlan(nowMs, nowMs + delay);

  let letterEntryId = null;
  let finalDeliverAt = deliverAt;
  let finalLogistics = logistics;

  if (category === 'letter') {
    const letter = require('./letter-helper');
    // 信件仍走信箱系统（回信/已读）；邮局包裹负责物流展示与统一寄件入口
    const posted = letter.postLetter({
      characterId: cid,
      content: letterText,
      role: 'user',
    });
    letterEntryId = posted?.id || null;
    if (letterEntryId) {
      const entry = db.prepare('SELECT deliver_at FROM letter_entries WHERE id=?').get(letterEntryId);
      if (entry?.deliver_at) {
        finalDeliverAt = entry.deliver_at;
        // 用信箱真实投递墙钟重排物流节点（仍不把 ETA 直接暴露给前端）
        const endMs = nowMs + Math.max(45 * 60 * 1000, delay);
        finalLogistics = buildLogisticsPlan(nowMs, endMs);
        finalLogistics[finalLogistics.length - 1].at = finalDeliverAt;
      }
    }
  }

  const displayName = category === 'letter'
    ? (itemName || '一封手写信')
    : itemName;

  const r = db.prepare(`
    INSERT INTO post_office_parcels (
      character_id, category, clothing_slot, name, note, message, notify_transit, image_url,
      letter_content, letter_entry_id, status, logistics_json, posted_at, deliver_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    cid,
    category,
    category === 'clothing' ? clothingSlot : '',
    displayName,
    itemNote,
    giftMessage,
    notifyOn ? 1 : 0,
    img,
    letterText,
    letterEntryId,
    'in_transit',
    JSON.stringify(finalLogistics),
    now,
    finalDeliverAt,
  );

  const parcelId = r.lastInsertRowid;
  enqueueJob({
    parcelId,
    characterId: cid,
    kind: 'deliver',
    runAt: finalDeliverAt,
  });

  const row = db.prepare('SELECT * FROM post_office_parcels WHERE id=?').get(parcelId);
  return publicParcelForSender(row);
}

function listParcels(characterId = null, { limit = 60 } = {}) {
  ensureTables();
  const lim = Math.max(1, Math.min(120, Number(limit) || 60));
  let rows;
  if (characterId) {
    rows = db.prepare(`
      SELECT p.*, c.name as char_name, c.avatar as char_avatar
      FROM post_office_parcels p
      LEFT JOIN characters c ON c.id = p.character_id
      WHERE p.character_id=?
      ORDER BY datetime(p.posted_at) DESC, p.id DESC
      LIMIT ?
    `).all(Number(characterId), lim);
  } else {
    rows = db.prepare(`
      SELECT p.*, c.name as char_name, c.avatar as char_avatar
      FROM post_office_parcels p
      LEFT JOIN characters c ON c.id = p.character_id
      ORDER BY datetime(p.posted_at) DESC, p.id DESC
      LIMIT ?
    `).all(lim);
  }
  return rows.map((row) => ({
    ...publicParcelForSender(row),
    char_name: row.char_name || '',
    char_avatar: row.char_avatar || '',
  }));
}

function getParcel(id) {
  ensureTables();
  const row = db.prepare(`
    SELECT p.*, c.name as char_name, c.avatar as char_avatar
    FROM post_office_parcels p
    LEFT JOIN characters c ON c.id = p.character_id
    WHERE p.id=?
  `).get(Number(id));
  if (!row) return null;
  return {
    ...publicParcelForSender(row),
    char_name: row.char_name || '',
    char_avatar: row.char_avatar || '',
  };
}

function shouldPostMoment(char, category) {
  if (Number(char?.post_moments) === 0) return false;
  const personality = `${char?.personality || ''} ${char?.behavior || ''} ${char?.language_style || ''}`;
  // 内敛 / 低调：较少发
  if (/内向|社恐|低调|不爱发|很少发朋友圈|隐私|寡言/.test(personality)) {
    return Math.random() < 0.25;
  }
  if (/晒|分享|外向|活泼|爱发|社交达人|炫耀/.test(personality)) {
    return Math.random() < 0.85;
  }
  if (category === 'food') return Math.random() < 0.7;
  if (category === 'decor') return Math.random() < 0.55;
  if (category === 'clothing') return Math.random() < 0.4;
  return Math.random() < 0.45;
}

function wardrobeInsertWithImage(charId, item) {
  ensureTables();
  const wardrobe = require('./wardrobe-helper');
  const created = wardrobe.insertWardrobeItem(charId, {
    ...item,
    source: item.source || 'gift',
  });
  if (item.image_url && created?.id) {
    try {
      db.prepare(`UPDATE char_wardrobe_items SET image_url=? WHERE id=? AND character_id=?`)
        .run(String(item.image_url).slice(0, 500), created.id, charId);
      created.image_url = item.image_url;
    } catch (e) {
      console.warn('[post-office] wardrobe image_url', e.message);
    }
  }
  return created;
}

/** 角色对用户寄来衣服的一两句感想，写入衣柜 description */
async function generateGiftClothingFeeling(char, parcel) {
  const giftName = String(parcel.name || '这件衣服').trim();
  const note = String(parcel.note || '').trim().slice(0, 120);
  const message = String(parcel.message || '').trim().slice(0, 120);
  const fallback = `你寄来的${giftName}，我很喜欢。想着是你挑的，会多穿几次。`;
  try {
    const settings = getSettings();
    const { callChatAPIComplete } = require('./api-helper');
    const sys = `你是角色「${char.name}」。用角色口吻写对一件用户寄来的衣服的感想。
要求：一两句中文，口语自然，可带一点情绪；不要标题，不要引号包裹全文，不要写成导购或物流说明。`;
    const user = `衣服名：${giftName}
${note ? `单品说明：${note}` : ''}
${message ? `对方留言：${message}` : ''}
人设摘要：${String(char.personality || char.behavior || char.intro || '').slice(0, 280) || '（未填）'}
请直接输出感想正文。`;
    const raw = String(await callChatAPIComplete(settings, sys, user, 'chat') || '').trim()
      .replace(/^["「『]|["」』]$/g, '')
      .slice(0, 160);
    return raw || fallback;
  } catch (e) {
    console.warn('[post-office] gift clothing feeling', e.message);
    return fallback;
  }
}

async function generateReceivePhoto(char, parcel) {
  const settings = getSettings();
  const { generateImage, selectSelfieReferenceUrls, buildCharacterAppearanceHint } = require('./api-helper');
  const cat = parcel.category;
  const giftName = parcel.name || cat;
  const giftNote = parcel.note || '';
  const home = String(char.home_environment || '').trim().slice(0, 200);

  let prompt = '';
  if (cat === 'clothing') {
    prompt = [
      `A portrait photo of ${char.name} wearing the gifted clothing item "${giftName}".`,
      giftNote ? `Item details: ${giftNote}.` : '',
      'Match the gift photo as closely as possible for the garment.',
      'Natural indoor light, candid, not fashion catalog.',
      buildCharacterAppearanceHint?.(char) || '',
    ].filter(Boolean).join(' ');
  } else if (cat === 'decor') {
    const withPerson = Math.random() < 0.55;
    prompt = withPerson
      ? `A cozy photo of ${char.name} with a small decorative gift "${giftName}" at home. ${home ? `Home vibe: ${home}.` : ''} Soft natural light, intimate keepsake moment.`
      : `A still life photo of a decorative gift "${giftName}" placed in ${char.name}'s home. ${home ? `Home: ${home}.` : ''} Warm ambient light, lived-in room.`;
  } else if (cat === 'food') {
    prompt = `A casual photo of ${char.name} with gifted food/snack "${giftName}". Homey, appetizing, candid phone photo.`;
  } else {
    prompt = `A candid photo related to a gift "${giftName}" received by ${char.name}. ${home ? `Setting: ${home}.` : ''} Natural light.`;
  }

  const refs = [];
  if (parcel.image_url) refs.push(parcel.image_url);
  try {
    const selfieRefs = selectSelfieReferenceUrls?.(char.image_ref, `${giftName} ${giftNote} outfit gift`) || [];
    for (const u of selfieRefs) {
      if (u && !refs.includes(u)) refs.push(u);
    }
  } catch {}
  if (char.avatar && !refs.includes(char.avatar)) refs.push(char.avatar);

  try {
    const result = await generateImage(settings, prompt, refs[0] || null, {
      aspect: '3:4',
      referenceImages: refs.slice(0, 3),
    });
    const url = typeof result === 'string' ? result : (result?.url || result?.image || '');
    return url || '';
  } catch (e) {
    console.warn('[post-office] receive photo', e.message);
    return '';
  }
}

async function maybePostGiftMoment(char, parcel, photoUrl) {
  if (!shouldPostMoment(char, parcel.category)) {
    return { posted: false, reason: 'persona_skip' };
  }
  const settings = getSettings();
  const { callChatAPIComplete } = require('./api-helper');
  const uname = settings.username || '旅人';
  const systemPrompt = [
    `你是${char.name}。刚收到一份哆啦邮局寄来的礼物，决定发一条朋友圈。`,
    char.personality ? `性格：${String(char.personality).slice(0, 300)}` : '',
    char.language_style ? `文风：${String(char.language_style).slice(0, 150)}` : '',
    '要求：1～3 句口语；可提礼物，不要写「AI」「系统」；不要报物流天数；不要 markdown。',
    `礼物：${parcel.name || parcel.category}${parcel.note ? `（${parcel.note}）` : ''}`,
    parcel.message ? `对方留言：${String(parcel.message).slice(0, 200)}` : '',
    `多数情况不必 @${uname}；只有很想点名时才自然写出。`,
  ].filter(Boolean).join('\n');

  let content = '';
  try {
    content = String(await callChatAPIComplete(settings, systemPrompt, '写朋友圈正文', 'chat') || '').trim();
  } catch (e) {
    console.warn('[post-office] moment text', e.message);
  }
  if (!content) {
    content = parcel.category === 'food'
      ? `今天的投喂到了：${parcel.name || '好吃的'}。`
      : `邮局送来一样东西：${parcel.name || '礼物'}。`;
  }
  content = content.replace(/^["「]|["」]$/g, '').slice(0, 280);

  const images = photoUrl ? [photoUrl] : [];
  const mentions = [];
  if (content.includes(`@${uname}`)) mentions.push({ type: 'user', name: uname });

  const createdAt = new Date().toISOString();
  const insertResult = db.prepare(
    `INSERT INTO moments (character_id, role, content, images, location, mentions, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(char.id, 'ai', content, JSON.stringify(images), '', JSON.stringify(mentions), createdAt);

  try {
    const { push } = require('./push');
    push('new_moment', { characterId: char.id, content, momentId: insertResult.lastInsertRowid });
  } catch {}

  return { posted: true, momentId: insertResult.lastInsertRowid, content };
}

async function saveReceivePhotoToAlbum(char, parcel, photo) {
  if (!photo) return;
  try {
    const album = require('./album-helper');
    await album.saveGeneratedMediaToAlbum({
      characterId: char.id,
      url: photo,
      mediaType: 'image',
      subject: parcel.category === 'decor' ? 'other' : 'self',
      description: parcel.category === 'clothing'
        ? `穿上寄来的${parcel.name || '衣服'}`.slice(0, 40)
        : `邮局礼物·${parcel.name || parcel.category}`.slice(0, 40),
    });
  } catch (e) {
    console.warn('[post-office] album', e.message);
  }
}

function insertGiftImageMessage(characterId, photoUrl, deliveryStatus) {
  const url = String(photoUrl || '').trim();
  if (!url) return null;
  try {
    let id;
    try {
      id = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read, delivery_status) VALUES (?,?,?,?,?,?,0,?)`
      ).run(characterId, 'assistant', url, 'image', new Date().toISOString(), 0, deliveryStatus || 'sent').lastInsertRowid;
    } catch {
      id = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, is_dream, is_read) VALUES (?,?,?,?,?,0)`
      ).run(characterId, 'assistant', url, 'image', 0).lastInsertRowid;
    }
    return { id, type: 'image', content: url };
  } catch (e) {
    console.warn('[post-office] chat image', e.message);
    return null;
  }
}

async function sendGiftReceivedChat(char, parcel, { photoUrl = '', postedMoment = false } = {}) {
  const settings = getSettings();
  const { callChatAPIComplete } = require('./api-helper');
  const { processAiContentWithEmojis, saveAiReplySegments } = require('./emoji-helper');
  const uname = settings.username || '旅人';
  const cat = CATEGORY_MAP[parcel.category] || { id: parcel.category, label: parcel.category };
  const attachPhoto = !postedMoment && !!photoUrl && parcel.category !== 'letter';

  let sidePack = {
    historyForApi: [],
    continuityNote: '',
    promptOpts: { enableInlineDirectives: true },
  };
  try {
    const cron = require('./cron');
    if (typeof cron.loadSideChannelChatContext === 'function') {
      sidePack = cron.loadSideChannelChatContext(char.id);
    }
  } catch {}

  const extra = [
    `【哆啦邮局·刚签收】你刚才在家签收了${uname}寄来的东西，现在主动给对方发消息。你本人已经拿到了，不是听说、不是物流通知。`,
    `签收内容：${cat.label}「${parcel.name || ''}」`,
    parcel.note ? `物品说明：${String(parcel.note).slice(0, 200)}` : '',
    parcel.message ? `对方留言：${String(parcel.message).slice(0, 200)}` : '',
    parcel.category === 'clothing' ? '已经放进衣柜了，可以试穿、吐槽或真心喜欢，按性格来。' : '',
    parcel.category === 'letter' ? '信已经到手里。聊天里可以提收到信，不要把信全文复述进气泡；回信走信纸。' : '',
    postedMoment ? '你已经发了朋友圈炫耀过了，聊天里点到即可，不要再长篇晒图。' : '',
    attachPhoto ? '你会同时发出一张现场照片（系统会附上图），正文里可以自然提拍给对方看，不要写「附图」「系统配图」，不要写[图片]标记。' : '这轮不要假装发了照片。',
    sidePack.continuityNote,
    '若近窗或【脑海】里刚聊到口味、穿搭、想要的东西、约定，签收时自然带一句，不要装第一次听说；也不要硬扯无关旧事。',
    '像真人刚拆完快递那样开口：1～4 句口语。禁止提 AI/系统/物流天数，禁止 markdown。',
  ].filter(Boolean).join('\n');

  let systemPrompt = extra;
  try {
    const cron = require('./cron');
    if (typeof cron.buildSystemPrompt === 'function') {
      systemPrompt = cron.buildSystemPrompt(char, settings, extra, sidePack.promptOpts || { enableInlineDirectives: true });
    }
  } catch (e) {
    console.warn('[post-office] gift chat prompt', e.message);
    systemPrompt = [
      `你是${char.name}。`,
      char.personality ? `性格：${String(char.personality).slice(0, 300)}` : '',
      char.language_style ? `文风：${String(char.language_style).slice(0, 150)}` : '',
      extra,
    ].filter(Boolean).join('\n');
  }

  let content = '';
  try {
    content = String(await callChatAPIComplete(
      settings,
      systemPrompt,
      '请给对方发一条刚签收后的主动消息（接得上近窗对话）。',
      'chat',
      sidePack.historyForApi || [],
    ) || '').trim();
  } catch (e) {
    console.warn('[post-office] gift chat', e.message);
  }
  content = content.replace(/\[(?:图片|自拍|配图)[^\]]*\]/g, '').replace(/^["「]|["」]$/g, '').trim();
  content = require('./contact-helper').applyHiddenRelationMarkers(db, char.id, content);
  if (!content) {
    if (parcel.category === 'letter') content = '信到了。拆开看了，过一会再写回你。';
    else if (parcel.category === 'clothing') content = `${parcel.name || '衣服'}到了，我拆开看了。`;
    else content = `${parcel.name || '东西'}到了，我刚签收。`;
  }

  const { segments } = processAiContentWithEmojis(content, char, { characterId: char.id, isDream: false });
  const toSave = (segments && segments.length) ? segments : [{ type: 'text', content }];
  let deliveryStatus = 'sent';
  try {
    if (require('./contact-helper').isPeerUndeliverable(db, char.id)) deliveryStatus = 'peer_undelivered';
  } catch {}
  let { aiMessages } = saveAiReplySegments(char.id, toSave, char, false, { deliveryStatus });
  if (attachPhoto) {
    const imgMsg = insertGiftImageMessage(char.id, photoUrl, deliveryStatus);
    if (imgMsg) aiMessages = [...(aiMessages || []), imgMsg];
  }
  const textContent = (aiMessages || [])
    .filter((m) => m.type === 'text' || m.type === 'voice')
    .map((m) => m.content)
    .join('\n') || content;
  try {
    const { push } = require('./push');
    push('proactive_message', { characterId: char.id, content: textContent, aiMessages: aiMessages || [] });
  } catch {}
  return { sent: true, text: textContent };
}

async function runGiftChat(parcelId) {
  const row = db.prepare('SELECT * FROM post_office_parcels WHERE id=?').get(parcelId);
  if (!row || row.status !== 'delivered') return null;
  const reaction = parseJson(row.reaction_json, {});
  if (reaction.chatSent) return null;
  const char = loadChar(row.character_id);
  if (!char) return null;
  const postedMoment = !!reaction.moment?.posted;
  const photoUrl = postedMoment ? '' : (reaction.effectPhoto || '');
  await sendGiftReceivedChat(char, row, { photoUrl, postedMoment });
  reaction.chatSent = true;
  delete reaction.effectPhoto;
  db.prepare(`UPDATE post_office_parcels SET reaction_json=? WHERE id=?`)
    .run(JSON.stringify(reaction), parcelId);
  try {
    const { push } = require('./push');
    push('post_office_updated', {
      characterId: char.id,
      parcelId,
      event: 'gift_chat',
      category: row.category,
      name: row.name,
    });
  } catch {}
  return { sent: true };
}

async function fulfillParcel(parcelId) {
  const row = db.prepare('SELECT * FROM post_office_parcels WHERE id=?').get(parcelId);
  if (!row || row.status !== 'in_transit') return null;
  const char = loadChar(row.character_id);
  if (!char) {
    db.prepare(`UPDATE post_office_parcels SET status='delivered', delivered_at=? WHERE id=?`)
      .run(sqlNow(), parcelId);
    return db.prepare('SELECT * FROM post_office_parcels WHERE id=?').get(parcelId);
  }

  if (!charCanSignAtHome(char) && !parcelWaitingTooLong(row)) {
    return deferParcelUntilHome(row);
  }

  const reaction = { type: row.category, wardrobeItemId: null, moment: null, chatSent: false, effectPhoto: '' };
  let wardrobeItemId = null;

  if (row.category === 'clothing') {
    const slot = row.clothing_slot || 'accessories';
    const feeling = await generateGiftClothingFeeling(char, row);
    const item = wardrobeInsertWithImage(char.id, {
      category: slot,
      name: row.name || '寄来的衣服',
      brand_style: '哆啦邮局',
      description: feeling,
      tags: ['♥', '礼物'],
      source: 'gift',
      image_url: row.image_url || '',
    });
    wardrobeItemId = item?.id || null;
    reaction.wardrobeItemId = wardrobeItemId;
    reaction.type = 'clothing';
  } else if (row.category === 'letter' && row.letter_entry_id) {
    try {
      require('./letter-helper').deliverLinkedLetterForParcel(char.id, row.letter_entry_id);
    } catch (e) {
      console.warn('[post-office] letter deliver', e.message);
    }
  }

  let photoUrl = '';
  if (row.category !== 'letter') {
    photoUrl = await generateReceivePhoto(char, row);
    if (photoUrl) {
      reaction.effectPhoto = photoUrl;
      await saveReceivePhotoToAlbum(char, row, photoUrl);
    }
    try {
      reaction.moment = await maybePostGiftMoment(char, row, photoUrl || '');
    } catch (e) {
      console.warn('[post-office] moment', e.message);
      reaction.moment = { posted: false, reason: e.message };
    }
  }

  const now = sqlNow();
  db.prepare(`
    UPDATE post_office_parcels
    SET status='delivered', delivered_at=?, wardrobe_item_id=?, reaction_json=?
    WHERE id=?
  `).run(now, wardrobeItemId, JSON.stringify(reaction), parcelId);

  enqueueJob({
    parcelId,
    characterId: char.id,
    kind: 'gift_chat',
    runAt: isoFromMs(Date.now() + (45 + Math.floor(Math.random() * 150)) * 1000),
  });

  const updated = db.prepare('SELECT * FROM post_office_parcels WHERE id=?').get(parcelId);
  try {
    const { push } = require('./push');
    push('post_office_updated', {
      characterId: char.id,
      parcelId,
      event: 'delivered',
      category: row.category,
      name: row.name,
    });
  } catch {}
  return updated;
}

let _jobBusy = false;

async function processDuePostOfficeJobs() {
  if (_jobBusy) return { processed: 0, skipped: true };
  _jobBusy = true;
  try {
    ensureTables();
    const now = sqlNow();
    const jobs = db.prepare(`
      SELECT * FROM post_office_jobs
      WHERE done=0 AND datetime(run_at) <= datetime(?)
      ORDER BY datetime(run_at) ASC
      LIMIT 6
    `).all(now);
    let processed = 0;
    for (const job of jobs) {
      db.prepare(`UPDATE post_office_jobs SET run_at=? WHERE id=? AND done=0`)
        .run(isoFromMs(Date.now() + 15 * 60 * 1000), job.id);
      try {
        if (job.kind === 'deliver') {
          const result = await fulfillParcel(job.parcel_id);
          if (result?.deferred) {
            continue;
          }
          db.prepare(`UPDATE post_office_jobs SET done=1 WHERE id=?`).run(job.id);
          processed += 1;
        } else if (job.kind === 'gift_chat') {
          await runGiftChat(job.parcel_id);
          db.prepare(`UPDATE post_office_jobs SET done=1 WHERE id=?`).run(job.id);
          processed += 1;
        } else {
          db.prepare(`UPDATE post_office_jobs SET done=1 WHERE id=?`).run(job.id);
        }
      } catch (e) {
        console.warn('[post-office] job', job.id, e.message);
        db.prepare(`UPDATE post_office_jobs SET run_at=? WHERE id=? AND done=0`)
          .run(isoFromMs(Date.now() + 25 * 60 * 1000), job.id);
      }
    }
    return { processed };
  } finally {
    _jobBusy = false;
  }
}

function meta() {
  return { categories: CATEGORIES, clothingSlots: CLOTHING_SLOTS };
}

function promptBlockForChar(characterId) {
  ensureTables();
  const cid = Number(characterId);
  if (!cid) return '';
  const inbound = db.prepare(`
    SELECT category, name, status, note, message FROM post_office_parcels
    WHERE character_id=? AND status='delivered'
    ORDER BY datetime(delivered_at) DESC, id DESC LIMIT 3
  `).all(cid);
  const transitNotify = db.prepare(`
    SELECT COUNT(*) as n FROM post_office_parcels
    WHERE character_id=? AND status='in_transit' AND COALESCE(notify_transit,0)=1
  `).get(cid);
  const lines = [];
  if (inbound.length) {
    const bits = inbound.map((p) => {
      const base = `${p.category}:${p.name || '包裹'}`;
      const msg = String(p.message || '').trim();
      const note = String(p.note || '').trim();
      const extras = [
        msg ? `留言「${msg.slice(0, 80)}」` : '',
        note ? `说明「${note.slice(0, 60)}」` : '',
      ].filter(Boolean).join('；');
      return extras ? `${base}（${extras}）` : base;
    });
    lines.push(`【哆啦邮局】最近签收：${bits.join('；')}。可按性格感谢/吐槽/试穿试用，不要提系统名。`);
  }
  if ((transitNotify?.n || 0) > 0) {
    lines.push(
      `【哆啦邮局】对方寄了东西，还在邮路上（共 ${transitNotify.n} 件）。你只知道「有东西在寄来」，不知道是什么、什么时候到；禁止猜内容、禁止说已收到。可偶尔随口提一句「听说有东西在路上」。`
    );
  }
  return lines.join('\n');
}

module.exports = {
  ensureTables,
  meta,
  CATEGORIES,
  CLOTHING_SLOTS,
  createParcel,
  listParcels,
  getParcel,
  processDuePostOfficeJobs,
  promptBlockForChar,
  publicParcel,
};

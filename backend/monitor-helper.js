/**
 * 居家监控：行程 + 衣柜 + 摄像头画面描述
 */
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { getHereAndNowContext, getLocalDateStr } = require('./cron');
const wardrobeHelper = require('./wardrobe-helper');
const {
  generateImage,
  generateImageToVideo,
  resolveImg2VideoConfig,
  getLastGenerateImageError,
  getLastGenerateVideoError,
  resolveCharacterHomeEnvironment,
  selectSelfieReferenceUrls,
  selectHomeReferenceUrls,
  buildHomeRefConsistencyPrompt,
  buildCharacterAppearanceHint,
  normalizeHomeRefs,
} = require('./api-helper');
const { saveGeneratedMediaToAlbum } = require('./album-helper');

const UPLOADS_DIR = path.join(__dirname, 'uploads');

const MONITOR_ROOMS = ['客厅', '卧室', '厨房', '书房', '阳台', '浴室', '玄关'];

const HOME_ROOM_KEYS = [
  { key: '卧室', re: /卧室|bedroom/i },
  { key: '客厅', re: /客厅|living\s*room|起居室/i },
  { key: '书房', re: /书房|study|工作室|studio/i },
  { key: '厨房', re: /厨房|kitchen|餐厅|dining/i },
  { key: '阳台', re: /阳台|露台|天台|balcony|terrace/i },
  { key: '浴室', re: /浴室|卫生间|洗手间|洗浴|泡澡|bath/i },
  { key: '玄关', re: /玄关|门厅|entry/i },
  { key: '衣帽间', re: /衣帽间|closet/i },
];

const ROOM_SET_DRESSING = {
  客厅: '沙发、茶几、电视墙',
  卧室: '床、床头柜、衣柜',
  厨房: '料理台、水槽、灶具',
  书房: '书桌、椅背、书架',
  阳台: '栏杆、盆栽、晾晒物',
  浴室: '洗手台、镜柜、毛巾架',
  玄关: '入户门、鞋柜、挂钩',
};

const ROOM_ITEM_DICT = {
  客厅: ['沙发', '茶几', '电视', '落地窗', '绿植', '地毯', '落地灯', '投影', '窗帘'],
  卧室: ['床', '床头柜', '衣柜', '窗帘', '梳妆', '书桌', '落地窗'],
  厨房: ['料理台', '水槽', '灶', '冰箱', '杯碟', '餐桌'],
  书房: ['书桌', '显示器', '台灯', '书架', '椅'],
  阳台: ['栏杆', '盆栽', '晾衣', '躺椅'],
  浴室: ['洗手台', '镜', '浴缸', '淋浴', '毛巾'],
  玄关: ['鞋柜', '挂钩', '入户门', '地毯'],
};

const ROOM_CAM_CH = {
  客厅: 'CH01', 卧室: 'CH02', 厨房: 'CH03', 书房: 'CH04',
  阳台: 'CH05', 浴室: 'CH06', 玄关: 'CH07',
};

const AWAY_RE = /出门|外出|外面|逛街|办事|采购|散步|出差|上班|加班|公司|办公室|通勤|路上|地铁|商场|店里|公园|博物馆|电影院|餐厅|咖啡|约会|拜访|外勤|机场|车站|医院|学校|大学|图书馆|夜市|市集|古镇|景区|展会|开会|会议|培训|上课|健身|跑步|游泳|球场|买菜|见客户|聚餐/;

/**
 * 取某个角色某天最近一次监控服装快照（无则 null）
 * 用途：决定监控画面里要不要重复描述服装——只描述变化的部分。
 */
function getLatestOutfitSnapshot(charId, dateStr) {
  if (!charId || !dateStr) return null;
  try {
    return db.prepare(
      `SELECT id, character_id, date, slot, outfit_json, outfit_summary, snapshot_at
         FROM char_monitor_outfit_snapshots
        WHERE character_id=? AND date=?
        ORDER BY id DESC LIMIT 1`
    ).get(charId, dateStr) || null;
  } catch {
    return null;
  }
}

/**
 * 写入一次新的监控服装快照。
 * - outfitJson 是 char_daily_outfits.outfit_json（同一结构）
 * - outfitSummary 是 buildOutfitSummary 出的精简中文
 * - slot 是 OUTFIT_SLOTS.id（居家/外出/工作等）
 */
function setOutfitSnapshot(charId, dateStr, slot, outfitJson, outfitSummary) {
  if (!charId || !dateStr) return null;
  const json = JSON.stringify(outfitJson || {});
  const summary = String(outfitSummary || '').trim();
  try {
    db.prepare(
      `INSERT INTO char_monitor_outfit_snapshots (character_id, date, slot, outfit_json, outfit_summary, snapshot_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(charId, dateStr, String(slot || ''), json, summary);
    return true;
  } catch (e) {
    console.error('[monitor] setOutfitSnapshot failed:', e?.message || e);
    return false;
  }
}

/**
 * 比较两份 outfit_json 判断是否同一套：
 * - 任一项单品 id 不同 → true（视为变化）
 * - 整套 id 完全一致 → false（视为无变化）
 * 没摘要或摘要为空也按 true 处理（首次进入有变化）
 */
function isOutfitJsonChanged(prevJson, curJson) {
  const normalize = (j) => {
    if (!j) return null;
    const o = typeof j === 'string' ? parseJson(j, null) : j;
    if (!o || typeof o !== 'object') return null;
    return {
      hairstyle: o.hairstyle_item_id || null,
      top: o.top_item_id || null,
      bottom: o.bottom_item_id || null,
      suit: o.suit_item_id || null,
      gown: o.gown_item_id || null,
      outer: o.outer_item_id || null,
      shoes: o.shoes_item_id || null,
      bag: o.bag_item_id || null,
      accessories: Array.isArray(o.accessory_item_ids) ? [...o.accessory_item_ids].sort() : [],
    };
  };
  const a = normalize(prevJson);
  const b = normalize(curJson);
  if (!a || !b) return true;
  for (const k of Object.keys(a)) {
    const av = a[k]; const bv = b[k];
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (JSON.stringify(av || []) !== JSON.stringify(bv || [])) return true;
    } else if ((av || null) !== (bv || null)) return true;
  }
  return false;
}

const OUTFIT_SLOT_LABELS = Object.fromEntries(
  (wardrobeHelper.OUTFIT_SLOTS || []).map((s) => [s.id, s.label]),
);

function parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function normalizeMonitorRoom(room) {
  const r = String(room || '').trim();
  if (!r || r === '家中') return '客厅';
  if (MONITOR_ROOMS.includes(r)) return r;
  if (r === '衣帽间') return '卧室';
  return '客厅';
}

function timeToMinutes(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function formatTimeRange(start, endMins) {
  const pad = (n) => String(n).padStart(2, '0');
  if (start == null) return '';
  const sh = Math.floor(start / 60);
  const sm = start % 60;
  if (endMins == null) return `${pad(sh)}:${pad(sm)}`;
  const eh = Math.floor(endMins / 60);
  const em = endMins % 60;
  return `${pad(sh)}:${pad(sm)} – ${pad(eh)}:${pad(em)}`;
}

function getMonitorRow(charId) {
  try {
    return db.prepare('SELECT * FROM char_monitor_plans WHERE character_id=?').get(charId);
  } catch {
    return null;
  }
}

function getCustomMonitorDescription(charId) {
  const row = getMonitorRow(charId);
  return String(row?.description || '').trim();
}

function getRoomScenesMap(charId) {
  const row = getMonitorRow(charId);
  const parsed = parseJson(row?.room_scenes, {});
  if (!parsed || typeof parsed !== 'object') return {};
  const out = {};
  for (const room of MONITOR_ROOMS) {
    const val = String(parsed[room] || '').trim();
    if (val) out[room] = val.slice(0, 1200);
  }
  return out;
}

function getEffectiveHomeDescription(char) {
  const custom = getCustomMonitorDescription(char.id);
  if (custom) return custom.slice(0, 800);
  return String(resolveCharacterHomeEnvironment(char) || '').trim().slice(0, 800);
}

const ROOM_WALL_DETAILS = {
  客厅: ['奶白墙', '浅米墙', '暖灰墙'],
  卧室: ['奶咖墙', '雾蓝墙', '浅木纹墙'],
  厨房: ['白瓷砖墙', '浅米瓷砖墙'],
  书房: ['白墙', '浅木墙', '深灰墙'],
  阳台: ['外墙米砖', '灰水泥墙'],
  浴室: ['浅灰瓷砖', '奶白瓷砖'],
  玄关: ['白墙', '原木护墙'],
};

const ROOM_FLOOR_DETAILS = {
  客厅: ['浅木地板', '暖色地砖', '灰木地板'],
  卧室: ['浅木地板', '暖木地板'],
  厨房: ['浅灰地砖', '米色防滑砖'],
  书房: ['深木地板', '浅木地板'],
  阳台: ['灰水泥地', '防滑地砖'],
  浴室: ['浅灰防滑砖', '奶白小方砖'],
  玄关: ['花砖', '深灰地砖'],
};

const ROOM_WINDOW_DETAILS = {
  客厅: ['落地窗半拉纱帘', '高窗透着巷子树影', '阳台门推开，能看见楼下街景'],
  卧室: ['飘窗台有半杯水', '窗帘半掩，街灯一格一格漏进来', '百叶帘漏进条状光'],
  厨房: ['小窗带一盆薄荷', '窗台搁着调料瓶'],
  书房: ['窗边一盆文竹', '窗外是阳台晾衣架', '窗户半开，纱帘轻动'],
  阳台: ['栏杆外是街口车流', '对面楼晾着衣服', '绿植架挡了大半视野'],
  浴室: ['磨砂小窗', '气窗透着楼道光'],
  玄关: ['门缝透着走廊冷光', '猫眼把走廊染成一圈'],
};

/* —— 活动 → 动作细节池 —— */
const ACTION_DETAIL_POOL = {
  cooking: ['右手翻锅铲，左手压着锅盖', '背对镜头，肩线随翻炒小幅度起伏', '抽油烟机嗡嗡响，蒸汽飘过她的肩头', '侧身切菜，刀和砧板有节奏地嗒嗒响', '弯腰从橱柜里取碗，衣摆随动作露出一截腰线'],
  cleaning: ['蹲在地上擦地板，膝盖往前挪', '踮脚去够柜顶的灰掸', '毛巾叠两折擦窗台，动作慢但规律', '拖把来回走，脚下拖出湿亮的一条', '拎着垃圾袋往玄关走，半转身瞥了镜头一眼'],
  resting: ['靠沙发扶手，半条腿蜷在坐垫上', '斜靠椅背，手里攥着手机，屏幕光映在下巴', '仰头枕着沙发靠背，眼睛半合', '趴在桌上，脸贴着叠好的手臂', '侧躺沙发，毯子滑到腰'],
  reading: ['盘腿坐沙发，书摊在膝头', '捧着书靠床头，指尖夹着书签', '翻页动作很慢，偶尔用笔在空白处划一道', '把书合在胸口，眼睛望着窗帘发呆', '趴在床上看书，下巴垫着一只枕头'],
  phone: ['拇指划屏节奏轻快', '点亮屏幕后停在某个聊天框很久没动', '手指打一行字又删掉', '把手机立在桌面上看视频，自己靠着椅背', '侧躺刷手机，屏幕光把整张脸照得雪白'],
  work: ['键盘敲得飞快，鼠标小幅度地抖', '一只手托腮，另一只手慢慢滚鼠标', '盯显示器皱眉，嘴唇抿成一条线', '面前摊开本子，写几行就停笔想一会儿', '把眼镜推上额顶，揉了一下鼻梁'],
  sleep: ['被子拉到下巴，呼吸慢而稳', '翻身时带动枕头轻微移位', '蜷成虾米状，手垫在脸下面', '仰卧，手搁在小腹上，胸口随呼吸均匀起伏', '侧身背对镜头，肩胛随呼吸小幅度起伏'],
  exercise: ['跟着节拍起伏，手臂划出一道弧', '身体折叠成一张弓，脊椎拉成一条直线', '盘腿坐在垫子中央，缓缓吐气，肩胛骨一张一收', '单腿支撑稳住重心，另一条腿在空中划出一道弧', '双手合十立于胸前，呼吸慢而均匀'],
  music: ['耳机线垂到胸前，随头微晃', '轻轻哼一段，闭着眼打拍子', '把音箱摆到窗台，自己盘腿坐地上听', '手指在膝盖上跟着节拍敲', '闭着眼，嘴唇轻轻动着跟唱'],
  dining: ['筷尖夹起一口，热气从碗里冒出来', '小口喝汤，勺子沿碗边刮一道', '一口一口慢嚼，眼神时不时飘向窗外', '用筷子戳了戳盘子，像在想什么', '把饭粒粘在嘴角，用舌尖抿回去'],
  bath: ['浴缸边沿搭着毛巾，蒸汽从门缝漫出来', '浴袍系带松松挽了一下', '头发用毛巾裹着，露出湿漉漉的颈', '浴室镜前只剩个模糊轮廓，水汽没散'],
  walkin: ['换鞋的动作停了一下，似乎听见什么', '手里拎着钥匙和购物袋', '低头看手机确认门锁没锁', '扶着门框回头望了一眼屋里'],
  default: ['身体微微动了动，重心从前脚换到后脚', '扶了一下桌沿，似乎准备起身', '指节轻轻扣桌面两下', '肩膀随一次深呼吸沉了一下'],
};

/**
 * 穿搭状态细节池：
 *  - cn：中文短句（拼进监控画面文字）
 *  - en：英文短语（拼进生图 prompt）
 *  - require：单品类别要求（has_top / has_outer / has_bottom 等），过滤"穿了却没有对应单品"的细节
 *  - vibe：'action' = 跟动作绑定的（袖口卷到肘、外套滑下）；'idle' = 静态的轻微松散（领口微敞）
 *  - weight：越高越容易被抽到
 *
 * 选条逻辑见 pickOutfitFocus()。每次监控根据「活动 + 当前 outfit + 上次细节」挑 1～2 条：
 *   - 同一身同个活动连续截图，会随机抽但避免跟上一次全重复 → 看到卷袖口 + 围裙袖口沾水 之类的微小变化
 *   - 切换活动（做饭 → 吃饭）时自然换词 → 看到卸围裙 / 袖口拉下来
 */
const OUTFIT_FOCUS_HINTS = {
  cooking: [
    { cn: '袖口卷起到肘下', en: 'sleeves casually rolled up to the elbows', require: 'has_top', weight: 3, vibe: 'action' },
    { cn: '围裙系在腰上，带子没打紧', en: 'apron loosely tied at the waist', require: 'has_outer', weight: 2, vibe: 'action' },
    { cn: '外套搭在椅背上，只剩衬衫单穿', en: 'outer draped over a chair back, just a shirt underneath', require: 'has_outer', weight: 2, vibe: 'action' },
    { cn: '袖口沾了一点油渍没擦', en: 'small grease smudge on the sleeve cuff', require: 'has_top', weight: 1, vibe: 'idle' },
    { cn: '前襟被蒸汽熏得微微打湿', en: 'steam-darkened front placket of the shirt', require: 'has_top', weight: 1, vibe: 'idle' },
  ],
  cleaning: [
    { cn: '袖口卷到肘上', en: 'sleeves rolled above the elbows', require: 'has_top', weight: 3, vibe: 'action' },
    { cn: '裤脚卷了半折', en: 'pants cuffs half-rolled', require: 'has_bottom', weight: 2, vibe: 'action' },
    { cn: '衣摆掖进裤腰', en: 'shirt hem tucked into waistband', require: 'has_top', weight: 2, vibe: 'action' },
    { cn: '头发随手挽了个低马尾', en: 'hair loosely pinned in a low ponytail', require: '', weight: 2, vibe: 'idle' },
    { cn: '手背蹭上了一块灰', en: 'dab of dust on the back of the hand', require: '', weight: 1, vibe: 'idle' },
  ],
  resting: [
    { cn: '领口松了两颗扣', en: 'collar unbuttoned two notches', require: 'has_top', weight: 2, vibe: 'idle' },
    { cn: '一只袖子滑到了小臂中段', en: 'one sleeve slipped down to mid-forearm', require: 'has_top', weight: 2, vibe: 'idle' },
    { cn: '衣摆从裤腰里扯出来一截', en: 'shirt hem half-untucked on one side', require: 'has_top', weight: 1, vibe: 'idle' },
    { cn: '袜子踩扁了跟', en: 'slippers half-stepped on at the heel', require: 'has_shoes', weight: 1, vibe: 'idle' },
  ],
  reading: [
    { cn: '外套不知什么时候从肩上滑到一边', en: 'outer half-slipped off one shoulder', require: 'has_outer', weight: 3, vibe: 'action' },
    { cn: '袖口蹭了一截到掌心', en: 'sleeve cuff bunched over the wrist', require: 'has_top', weight: 2, vibe: 'idle' },
    { cn: '领口松松地敞着', en: 'collar loose, slightly open', require: 'has_top', weight: 1, vibe: 'idle' },
  ],
  phone: [
    { cn: '外套一边好好穿着，另一边顺着椅子滑下来', en: 'outer worn on one side, slipped off the other onto the chair', require: 'has_outer', weight: 3, vibe: 'action' },
    { cn: '裤腿堆在脚踝', en: 'pants leg bunched at the ankle', require: 'has_bottom', weight: 1, vibe: 'idle' },
    { cn: '手指停在屏幕上方，袖口跟着垂下来', en: 'sleeve hanging loose as fingers hover above the screen', require: 'has_top', weight: 1, vibe: 'idle' },
  ],
  work: [
    { cn: '外套搭在椅背上', en: 'outer hung neatly on the back of the chair', require: 'has_outer', weight: 2, vibe: 'idle' },
    { cn: '袖口解开扣子挽上去', en: 'cuffs unbuttoned and folded back once', require: 'has_top', weight: 2, vibe: 'action' },
    { cn: '领带松开挂在领口', en: 'tie loosened at the collar', require: '', weight: 1, vibe: 'idle' },
  ],
  sleep: [
    { cn: '睡衣领口松松垮到锁骨', en: 'sleep shirt slipped off one shoulder at the collarbone', require: 'has_top', weight: 3, vibe: 'idle' },
    { cn: '袖子卷成一截堆在小臂上', en: 'sleep sleeves rumpled halfway up the forearm', require: 'has_top', weight: 2, vibe: 'idle' },
    { cn: '裤腰松了一圈，滑到了胯骨', en: 'sleep pants waistband slid down to the hip', require: 'has_bottom', weight: 1, vibe: 'idle' },
  ],
  exercise: [
    { cn: '外套早就甩到一边，只剩运动背心', en: 'outer tossed aside, just the tank top remains', require: 'has_top', weight: 3, vibe: 'action' },
    { cn: '运动后头发贴在后颈', en: 'hair damp against the nape from workout', require: '', weight: 2, vibe: 'idle' },
    { cn: '衣襟被汗打湿了一片', en: 'shirt hem dark with sweat', require: 'has_top', weight: 2, vibe: 'idle' },
  ],
  music: [
    { cn: '外套只挂在一侧肩头，随时要掉', en: 'outer hanging off one shoulder', require: 'has_outer', weight: 3, vibe: 'action' },
    { cn: '耳机线垂到胸前', en: 'earphone cord dangling down to the chest', require: '', weight: 2, vibe: 'idle' },
  ],
  dining: [
    { cn: '袖口卷起来方便吃饭', en: 'sleeves rolled up neatly before eating', require: 'has_top', weight: 3, vibe: 'action' },
    { cn: '嘴边擦了一下，领口沾了点汤渍', en: 'a faint soup spot near the collar', require: 'has_top', weight: 1, vibe: 'idle' },
  ],
  bath: [
    { cn: '浴袍领口松松敞着', en: 'robe collar loosely open after bathing', require: 'has_outer', weight: 3, vibe: 'idle' },
    { cn: '头发拿毛巾包着', en: 'hair wrapped in a towel', require: '', weight: 2, vibe: 'idle' },
  ],
  walkin: [
    { cn: '外套还没拉拉链', en: 'outer worn with zipper half-down', require: 'has_outer', weight: 3, vibe: 'action' },
    { cn: '鞋跟踩扁了', en: 'shoes half-stepped on at the heel', require: 'has_shoes', weight: 1, vibe: 'idle' },
  ],
  default: [
    { cn: '领口松了两颗扣', en: 'collar unbuttoned two notches', require: 'has_top', weight: 2, vibe: 'idle' },
    { cn: '袖口蹭到手腕，垂着', en: 'sleeve hanging loose over the wrist', require: 'has_top', weight: 1, vibe: 'idle' },
    { cn: '外套一边挂着另一边快要掉', en: 'outer half-on, half-off', require: 'has_outer', weight: 2, vibe: 'action' },
  ],
};

/**
 * 给当前 outfit+活动，挑 1～2 条「穿戴细节」。
 * 优先满足 require 条件（has_top / has_outer / has_bottom / has_shoes / 空 = 无所谓）。
 * 同一身连续截图会去重上一轮的 cn（避免反复复读同一句）；slot 变化或 outfit_json 变化会清缓存。
 */
const _recentFocusByChar = new Map();

function outfitHasCategory(curOutfitJson, requireKey) {
  if (!requireKey) return true;
  if (!curOutfitJson) return false;
  const o = typeof curOutfitJson === 'string' ? parseJson(curOutfitJson, null) : curOutfitJson;
  if (!o || typeof o !== 'object') return false;
  switch (requireKey) {
    case 'has_top':     return !!(o.top_item_id || o.suit_item_id || o.gown_item_id);
    case 'has_bottom':  return !!(o.bottom_item_id || o.suit_item_id || o.gown_item_id);
    case 'has_outer':   return !!o.outer_item_id;
    case 'has_shoes':   return !!o.shoes_item_id;
    case 'has_bag':     return !!o.bag_item_id;
    case 'has_hair':    return !!o.hairstyle_item_id;
    default:            return true;
  }
}

function pickOutfitFocus(curOutfitJson, activity, slot, charId) {
  const kind = activityKind(activity, '');
  const pool = OUTFIT_FOCUS_HINTS[kind] || OUTFIT_FOCUS_HINTS.default;
  const candidates = pool.filter((h) => outfitHasCategory(curOutfitJson, h.require));
  if (!candidates.length) return [];

  const cacheKey = `${charId}_${slot}_${kind}`;
  const recent = _recentFocusByChar.get(cacheKey);
  const filtered = recent
    ? candidates.filter((h) => !recent.includes(h.cn))
    : candidates;
  const finalPool = filtered.length ? filtered : candidates;

  // weight 加权抽一条 + 偶尔抽第二条（30% 概率）
  const pickOne = (pool) => {
    const total = pool.reduce((s, h) => s + (h.weight || 1), 0);
    let r = Math.random() * total;
    for (const h of pool) {
      r -= (h.weight || 1);
      if (r <= 0) return h;
    }
    return pool[pool.length - 1];
  };

  const first = pickOne(finalPool);
  const picks = [first];
  if (finalPool.length > 1 && Math.random() < 0.3) {
    const restPool = finalPool.filter((h) => h !== first);
    if (restPool.length) picks.push(pickOne(restPool));
  }

  // 滚去重窗口：保留最近 4 条，下次会避开
  const prev = recent || [];
  _recentFocusByChar.set(cacheKey, [...prev, ...picks.map((h) => h.cn)].slice(-4));

  return picks;
}

const HAND_OBJECT_HINTS = {
  cooking: ['手边搁着锅铲和抹布', '台面摆着半切的番茄', '调料瓶开盖放着'],
  cleaning: ['手里拧干的抹布', '拖把靠在墙边', '垃圾袋扎口放脚边'],
  reading: ['膝上摊开一本厚厚的书', '手边搁着一杯凉茶', '书签夹在食指与中指之间'],
  phone: ['手机举到脸侧', '手机立在桌上充电', '耳机线绕在指尖'],
  work: ['马克杯搁在键盘右侧', '笔横搁在本子中缝', '鼠标垫边缘被手指反复捏过'],
  sleep: ['手里虚握一只枕头角', '毯子只盖到腰', '被角被踢到床尾'],
  dining: ['筷子横搁在碗沿', '汤勺搁在汤碗里', '杯子端起来又放下'],
};

const ROOM_AMBIENT_DETAILS = {
  客厅: ['客厅有淡淡咖啡香', '茶几上摊着一本没收的书', '沙发靠垫被压出一个人形', '电视待机的小红点亮着', '窗帘被空调吹得微动'],
  卧室: ['床头柜上的台灯只开了一盏', '被子揉成一团堆在床尾', '衣柜门虚掩，露出一截衣架', '枕头上还有头发的压痕', '飘窗的坐垫还留着温度'],
  厨房: ['料理台上沾着水渍', '水龙头还滴答着', '微波炉里转着什么', '垃圾桶盖半开', '冰箱嗡嗡响，压缩机偶尔咯哒一声'],
  书房: ['显示器进入休眠，屏保缓慢漂移', '书架第二层被抽走一本，留下一个空档', '桌角摊着几张便签', '椅子被拉开半圈', '键盘缝隙里有几粒面包屑'],
  阳台: ['晾衣架上挂着刚洗的衣服', '盆栽的叶子被风吹得微动', '栏杆上搭着一只袜子', '地砖还有浇水后没干的水痕'],
  浴室: ['镜面有雾', '毛巾卷成一团搭在架上', '地漏边沿有一圈水', '洗手台上搁着挤了一半的牙膏', '浴缸边的防滑垫歪了'],
  玄关: ['鞋柜门半敞', '钥匙盘里少了一把', '门垫歪了半边', '墙上挂钩挂着帆布袋'],
};

const ROOM_EMPTY_DETAILS = {
  客厅: ['沙发上搭着没收的外套', '茶几上还搁着喝了一半的杯子', '电视暗屏反着落地窗外的街景', '地灯没关，光圈静静打在地板'],
  卧室: ['床铺皱成一团，像刚起身', '被子掀到一边', '窗帘没拉严，漏进一条街灯', '床头灯还在亮着', '衣柜门开了一道缝'],
  厨房: ['水龙头还滴答着', '料理台上摆着半截没用完的葱', '抽油烟机待机灯亮着', '垃圾袋扎好靠在脚边'],
  书房: ['显示器进入休眠', '椅子被推开像刚起身', '桌角还有半杯凉掉的咖啡', '笔斜搁在本子上'],
  阳台: ['晾衣架空着', '盆栽的土面有点干', '栏杆上还搭着一只袖子'],
  浴室: ['镜面有雾', '洗手台上水渍未干', '地漏边有水', '毛巾挂在门把手上'],
  玄关: ['鞋柜门敞着', '门口的拖鞋东一只西一只', '门垫翘起一角'],
};

const POSTURE_VARIANTS = {
  standing: ['立于画面中部', '站在取景范围正中', '重心放在左脚', '靠着门框站着', '背对镜头面朝窗'],
  sitting: ['坐姿', '盘腿坐在地上', '蜷在沙发上', '斜靠在椅背上', '侧坐床沿，一只脚垂下'],
  lying: ['半躺', '蜷在沙发上', '趴在桌上', '侧身背对镜头', '摊成大字躺在床上'],
  moving: ['在取景范围内走动', '来回踱了几步', '从画面一侧走向另一侧', '脚步从门口移到窗边'],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function lightingPhrase(clock) {
  const h = parseInt(String(clock || '12:00').split(':')[0], 10) || 12;
  if (h >= 5 && h < 8) return pick([
    '晨光弱，室内偏暗，窗缝漏进一条灰白',
    '天还没全亮，灰蓝调里只有窗边泛白',
    '晨曦刚透进来，家具拖着短影',
  ]);
  if (h >= 8 && h < 11) return pick([
    '上午自然光打进来，地面有斜长亮斑',
    '阳光从窗斜照到地板，光柱里浮着细尘',
    '日光铺满半间屋子，沙发脚那一片被晒得发烫似的',
  ]);
  if (h >= 11 && h < 16) return pick([
    '日间偏亮，白墙略过曝',
    '正午顶光，阴影压在家具脚下很短',
    '光从天顶直泻下来，陈设边沿有点晃眼',
  ]);
  if (h >= 16 && h < 18) return pick([
    '夕照斜入，家具拖出长影',
    '傍晚暖光从窗框滑进来，墙面被染成橙黄',
    '日落前最后一段斜光，茶几上落了一块橙红',
  ]);
  if (h >= 18 && h < 21) return pick([
    '窗外已暗，室内暖灯开着',
    '夜灯把整个屋子染成暖黄，窗外是冷蓝',
    '客厅大灯关了，只剩落地灯和电视背景光',
    '窗外是城市夜景，玻璃上反出屋内人影',
  ]);
  if (h >= 21 || h < 5) return pick([
    '夜间，局部灯光亮着，边角欠曝',
    '只有台灯那一点光，其余沉进暗里',
    '窗帘没拉严，远处霓虹把天花板染得微红微蓝',
    '走廊灯忘关了，从门缝挤进一线冷白',
  ]);
  return pick(['室内照度平常', '日光灯稳稳亮着', '光没什么特别，屋里看上去就是寻常白天']);
}

/** 取景总览：把房间、家具、墙地、窗外、氛围串成一段 */
function buildSetting(room, homeDesc, char, clock) {
  const set = visibleSetFromHome(homeDesc, room);
  const wall = pick(ROOM_WALL_DETAILS[room] || ['白墙']);
  const floor = pick(ROOM_FLOOR_DETAILS[room] || ['浅木地板']);
  const win = pick(ROOM_WINDOW_DETAILS[room] || []);
  const amb = pick(ROOM_AMBIENT_DETAILS[room] || []);
  const light = lightingPhrase(clock);
  
  // 尝试从家装参考图标签中提取窗外描述
  const windowViewHint = inferWindowViewFromHomeRefs(char);
  
  const parts = [
    `取景：${set}。${wall}衬底，${floor}反射着一层${light.endsWith('。') ? light.slice(0, -1) : light}的光`,
  ];
  if (win) parts.push(win);
  // 如果从参考图标签中提取到了窗外描述，补充进去
  if (windowViewHint) {
    parts.push(`窗外：${windowViewHint}`);
  }
  parts.push(amb);
  return parts.join('。') + '。';
}

/** 把动作活动归到几个大类，方便匹配细节池 */
function activityKind(activity, thought) {
  const a = String(activity || ''); const t = String(thought || '');
  const blob = `${a} ${t}`;
  if (/睡|小憩|nap|卧床|赖床|刚醒|起床/.test(blob)) return 'sleep';
  if (/做饭|下厨|煮|煎|炒|切菜|烧水|煮咖啡|泡茶|煎蛋|微波/.test(blob)) return 'cooking';
  if (/打扫|擦|拖|洗|收拾|整理|扔|倒垃圾|清洁|扫地/.test(blob)) return 'cleaning';
  if (/看剧|追剧|视频|电影|直播|综艺/.test(blob)) return 'phone';
  if (/刷|短视频|抖音|小红书|微博|朋友圈|聊天|回消息|发消息|摸鱼|看手机|回信|微信|短信/.test(blob)) return 'phone';
  if (/看书|读|翻页|书|小说/.test(blob)) return 'reading';
  if (/电脑|办公|工作|写|敲|改|邮件|方案|PPT|稿|剪辑|编程|码/.test(blob)) return 'work';
  if (/瑜伽|拉伸|深蹲|卷腹|跳|健身|跑步|锻炼|运动|做瑜伽|做操|跳绳|广场舞/.test(blob)) return 'exercise';
  if (/听歌|放歌|哼|音乐|耳机/.test(blob)) return 'music';
  if (/吃|喝|早餐|午餐|晚餐|饭|汤|咖啡|茶|泡面|宵夜/.test(blob)) return 'dining';
  if (/洗澡|沐浴|泡澡|洗漱|洗头|冲凉/.test(blob)) return 'bath';
  if (/出门|换鞋|锁门/.test(blob)) return 'walkin';
  return 'default';
}

/* 活动类型对应的"典型房间"，用于活动本身没明说地点时反推 */
const ACTIVITY_DEFAULT_ROOM = {
  sleep: '卧室',
  cooking: '厨房',
  cleaning: '客厅',
  reading: '客厅',
  phone: '客厅',
  work: '书房',
  exercise: '客厅',
  music: '客厅',
  dining: '厨房',
  bath: '浴室',
  walkin: '玄关',
};

function inferRoomFromActivity(activity, outfitSlot) {
  if (outfitSlot === 'sleep') return '卧室';
  const act = String(activity || '');
  for (const { key, re } of HOME_ROOM_KEYS) {
    if (re.test(act)) return key;
  }
  if (/睡|小憩|nap|卧床/.test(act)) return '卧室';
  if (/做饭|下厨|cook/i.test(act)) return '厨房';
  // 上面没匹配时，按活动类型用"典型房间"兜底
  return ACTIVITY_DEFAULT_ROOM[activityKind(activity, '')] || '';
}

function inferPostureKind(activity, outfitSlot) {
  const act = String(activity || '');
  if (outfitSlot === 'sleep' || /睡|小憩|nap|卧床|赖床/.test(act)) return 'lying';
  if (/瑜伽|拉伸|深蹲|卷腹|跳|健身|跑步|锻炼|运动|做瑜伽|做操/.test(act)) return 'moving';
  if (/坐|写|看|读|刷|玩|办公|工作|电脑|吃饭|喝|听歌/.test(act)) return 'sitting';
  if (/躺|趴|卧/.test(act)) return 'lying';
  if (/站|换鞋|收拾|打扫|拖|擦|做饭|切|煮/.test(act)) return 'standing';
  if (/走|来回|踱|去/.test(act)) return 'moving';
  return 'standing';
}

function outfitDetailHint(outfitSlot, outfitSummary, curOutfitJson, activity, charId) {
  // 用户没具体单品（"尚未搭配"）时，按 slot 给一句兜底；否则交给 pickOutfitFocus 用活动 + outfit 推细节。
  const s = String(outfitSummary || '').trim();
  if (!s || s === '尚未搭配' || s === '居家便装') {
    const bySlot = {
      sleep: '睡衣软软塌在肩上',
      home: '卫衣袖子推到手肘',
      out: '外套披着没拉拉链',
    };
    if (outfitSlot && bySlot[outfitSlot]) return bySlot[outfitSlot];
    return bySlot.home;
  }
  return '';
}

function buildEmptyRoomFeed(room, homeDesc, clock, away, char) {
  const setting = buildSetting(room, homeDesc, char, clock);
  const still = pick(ROOM_EMPTY_DETAILS[room] || ['陈设未动']);
  const tail = away ? pick(['屋内看不出有人回来的迹象', '房间是空的，灯也熄了']) : pick(['陈设原样，看不出刚有人走过', '本路无目标，屋内静着']);
  return [setting, still, tail].join('。');
}

/** 主体：把名字、姿态、服装、动作、身边物、视线/心理串成一段长实况 */
function describeTargetOnCam(charName, state, room) {
  const act = String(state.activity || '').trim();
  const thought = String(state.schedule_thought || '').trim();
  const hasOutfit = state.outfit_summary && state.outfit_summary !== '尚未搭配';
  const outfitChanged = state.outfit_changed !== false; // 缺省视为首次，描述具体单品
  // 没衣服：兜底用「居家便装」；没变化：跳过具体单品，但保留 1 条「穿戴细节」让画面有活气。
  const outfit = !hasOutfit ? '居家便装'
    : outfitChanged ? state.outfit_summary
    : '';
  // 细节：变了 → pickOutfitFocus 推几条；没变 → 用空 fallback，但首句会代为补一句免提
  let focusHints = [];
  if (Array.isArray(state.outfit_focus)) focusHints = state.outfit_focus;
  if (outfitChanged && hasOutfit && !focusHints.length) {
    // 兜底：从 pool 里随便抽一条，避免 outfit_changed=true 但画风里没任何单品描述
    focusHints = pickOutfitFocus(state.outfit_summary, act, state.outfit_slot, null);
  }
  const kind = activityKind(act, ''); // 活动类型只用活动名判断，不用 thought 干扰 dining/cooking 分类
  const thoughtKind = thought ? activityKind('', thought) : 'default'; // thought 参与心理描写分类
  const postureKind = inferPostureKind(act, state.outfit_slot);
  const posture = pick(POSTURE_VARIANTS[postureKind] || POSTURE_VARIANTS.standing);
  const headBits = [`画面中部是「${charName}」——${posture}`];
  if (outfit) {
    headBits.push(`着${outfit}`);
  } else if (focusHints.length) {
    // 同一身衣服：跳过单品名，直接用一条细节自然带出"袖口/外套/领口"状态
    headBits.push(focusHints[0].cn);
  } else {
    headBits.push(pick([
      '衣着与往常一样，无明显变化',
      '穿的还是平日那身',
      '衣服跟上午没什么两样',
      '身上仍是今天这一套',
    ]));
  }
  const bits = [headBits.join('，')];

  // 动作/事件
  const actionDetail = pick(ACTION_DETAIL_POOL[kind] || ACTION_DETAIL_POOL.default);
  if (act && kind !== 'sleep') {
    if (kind === 'cooking') bits.push(`正在${act || '下厨'}，${actionDetail}`);
    else if (kind === 'cleaning') bits.push(`在${act || '打扫'}，${actionDetail}`);
    else if (kind === 'reading') bits.push(`在看书，${actionDetail}`);
    else if (kind === 'phone') bits.push(`${act || '在看手机'}，${actionDetail}`);
    else if (kind === 'work') bits.push(`在${act || '忙着手头的事'}，${actionDetail}`);
    else if (kind === 'exercise') bits.push(`在${act || '活动身体'}，${actionDetail}`);
    else if (kind === 'music') bits.push(`${act || '听歌'}，${actionDetail}`);
    else if (kind === 'dining') bits.push(`在${act || '吃东西'}，${actionDetail}`);
    else if (kind === 'bath') bits.push(`${act || '在洗漱'}，${actionDetail}`);
    else if (kind === 'walkin') bits.push(`${act || '准备出门'}，${actionDetail}`);
    else bits.push(`正在${act}，${actionDetail}`);
  } else if (kind === 'sleep') {
    bits.push(actionDetail);
  } else if (act) {
    bits.push(`正在${act}。${actionDetail}`);
  } else {
    bits.push(actionDetail);
  }

  // 身边物
  const hand = pick(HAND_OBJECT_HINTS[kind] || ['']);
  if (hand) bits.push(hand);

  // 表情/视线/心理（从thought里抽一两个词）
  if (thought) {
    const tidy = thought.replace(/[。.！!？\?]+/g, '').slice(0, 36);
    bits.push(pick([
      `嘴角似乎在想着什么——「${tidy}」`,
      `眼神有点放空，像在琢磨一件事：「${tidy}」`,
      `手指敲了两下，大概在转一个念头：「${tidy}」`,
      `眉心松松的，神情像没在听声音，只想着：「${tidy}」`,
      `嘴唇微动，似乎在默念什么——「${tidy}」`,
    ]));
  } else {
    bits.push(pick([
      '目光落在画面外的某个地方，没在镜头这头',
      '呼吸很轻，胸腔小幅度起伏',
      '嘴唇抿成一条细线，没说话',
      '偏头看向窗外，没看镜头',
    ]));
  }

  bits.push('固定机位，无变焦。');
  return bits.join('。').replace(/。。+/g, '。').replace(/，\s*，/g, '，');
}

/** 居住环境只抽陈设名词，禁止把用户原文整段贴进监控画面 */
function visibleSetFromHome(homeDesc, room) {
  const blob = String(homeDesc || '');
  const dict = ROOM_ITEM_DICT[room] || [];
  const found = dict.filter((w) => blob.includes(w));
  if (found.length) return [...new Set(found)].slice(0, 5).join('、');
  return ROOM_SET_DRESSING[room] || `${room}常用陈设`;
}

/**
 * 从家装参考图标签中提取"窗外能看到什么"的描述
 * 比如：标签含"阳台能看到楼下街景"就提取出来用于监控画面
 */
function inferWindowViewFromHomeRefs(char) {
  if (!char) return '';
  try {
    const refs = normalizeHomeRefs(char?.home_refs) || [];
    // 从标签中寻找窗外/室外描述
    const windowViewPatterns = [
      /窗外[^\s，。]{0,30}/g,
      /阳台[^\s，。]{0,30}/g,
      /窗[外侧旁]?[^\s，。]{0,30}/g,
      /view[^\s，。]{0,30}/gi,
      /窗外.*?(?:街景|树|楼|云|天空|花园|山)/gi,
    ];
    const hits = [];
    for (const ref of refs) {
      const label = String(ref.label || '');
      for (const pattern of windowViewPatterns) {
        let m;
        while ((m = pattern.exec(label)) !== null) {
          const phrase = m[0].trim();
          if (phrase.length >= 4) hits.push(phrase);
        }
      }
    }
    // 去重取前两条
    const unique = [...new Set(hits)].slice(0, 2);
    return unique.join('；');
  } catch {
    return '';
  }
}

function buildCctvFeed(room, homeDesc, clock, { occupied, away, charName, state }, char) {
  if (away || !occupied) {
    return buildEmptyRoomFeed(room, homeDesc, clock, away, char);
  }
  const setting = buildSetting(room, homeDesc, char, clock);
  const body = describeTargetOnCam(charName, state, room);
  return `${setting}\n${body}`;
}

function buildCameraFeedNarrative(room, homeDesc, charName, inferredRoom, state, char) {
  const normalizedInferred = normalizeMonitorRoom(inferredRoom);
  const clock = state.clock || '12:00';
  const occupied = !!state.at_home && normalizedInferred === room;
  return buildCctvFeed(room, homeDesc, clock, {
    occupied,
    away: !state.at_home,
    charName,
    state,
  }, char);
}

function buildAllCameraScenes(char, state, customScenes) {
  const homeDesc = getEffectiveHomeDescription(char);
  const charName = String(char.display_name || char.name || 'TA').trim();
  const inferredRoom = normalizeMonitorRoom(state.inferred_room || state.room);
  const scenes = {};
  for (const room of MONITOR_ROOMS) {
    const custom = customScenes[room];
    if (custom) {
      scenes[room] = {
        text: custom,
        has_custom: true,
        auto: false,
      };
    } else {
      scenes[room] = {
        text: buildCameraFeedNarrative(room, homeDesc, charName, inferredRoom, state, char),
        has_custom: false,
        auto: true,
      };
    }
  }
  return scenes;
}

function purgeLegacyPlanFile(row) {
  if (!row?.filename) return;
  try {
    const fp = path.join(UPLOADS_DIR, row.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

function ensureMonitorRow(charId) {
  const cid = parseInt(charId, 10);
  if (!cid) return null;
  const existing = getMonitorRow(cid);
  if (!existing) {
    db.prepare(`
      INSERT INTO char_monitor_plans (character_id, filename, description, room_scenes, updated_at)
      VALUES (?, '', '', '{}', datetime('now'))
    `).run(cid);
  }
  return getMonitorRow(cid);
}

function saveMonitorDescription(charId, description) {
  const cid = parseInt(charId, 10);
  if (!cid) return null;
  const text = String(description || '').trim().slice(0, 800);
  const existing = getMonitorRow(cid);
  purgeLegacyPlanFile(existing);
  ensureMonitorRow(cid);
  db.prepare(`
    INSERT INTO char_monitor_plans (character_id, filename, description, room_scenes, updated_at)
    VALUES (?, '', ?, COALESCE((SELECT room_scenes FROM char_monitor_plans WHERE character_id=?), '{}'), datetime('now'))
    ON CONFLICT(character_id) DO UPDATE SET
      description=excluded.description,
      filename='',
      updated_at=datetime('now')
  `).run(cid, text, cid);
  return text;
}

function saveMonitorRoomScene(charId, room, text) {
  const cid = parseInt(charId, 10);
  const r = normalizeMonitorRoom(room);
  if (!cid || !MONITOR_ROOMS.includes(r)) return null;
  const val = String(text || '').trim().slice(0, 1200);
  if (!val) throw new Error('画面描述不能为空');
  ensureMonitorRow(cid);
  const scenes = getRoomScenesMap(cid);
  scenes[r] = val;
  db.prepare(`
    UPDATE char_monitor_plans SET room_scenes=?, updated_at=datetime('now') WHERE character_id=?
  `).run(JSON.stringify(scenes), cid);
  return { room: r, text: val };
}

function clearMonitorRoomScene(charId, room) {
  const cid = parseInt(charId, 10);
  const r = normalizeMonitorRoom(room);
  if (!cid || !MONITOR_ROOMS.includes(r)) return;
  const scenes = getRoomScenesMap(cid);
  delete scenes[r];
  db.prepare(`
    UPDATE char_monitor_plans SET room_scenes=?, updated_at=datetime('now') WHERE character_id=?
  `).run(JSON.stringify(scenes), cid);
}

function clearMonitorDescription(charId) {
  const cid = parseInt(charId, 10);
  if (!cid) return;
  const existing = getMonitorRow(cid);
  purgeLegacyPlanFile(existing);
  db.prepare('DELETE FROM char_monitor_plans WHERE character_id=?').run(cid);
}

function buildScheduleSlotMeta(items, current) {
  if (!current) return { status: 'idle', time_range: '', end_mins: null };
  const sorted = [...(items || [])].sort(
    (a, b) => (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999),
  );
  const idx = sorted.findIndex(
    (it) => String(it.time) === String(current.time) && String(it.activity) === String(current.activity),
  );
  const start = timeToMinutes(current.time);
  let end = null;
  if (idx >= 0 && idx < sorted.length - 1) {
    end = timeToMinutes(sorted[idx + 1].time);
  } else if (start != null) {
    end = Math.min(start + 120, 24 * 60);
  }
  return {
    status: 'now',
    time_range: formatTimeRange(start, end),
    end_mins: end,
  };
}

function buildMonitorState(char, opts = {}) {
  const settings = {};
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    for (const r of rows) settings[r.key] = r.value;
  } catch {}
  const tz = char.timezone || settings.timezone || 'Asia/Shanghai';
  const date = getLocalDateStr(new Date(), tz);
  const here = getHereAndNowContext(char, settings);
  const current = here.current || null;
  const activity = String(current?.activity || '').trim();
  const away = here.placeMode === 'away' || (activity && AWAY_RE.test(activity));

  const outfitSlot = wardrobeHelper.inferCurrentSlotFromSchedule(char.id, date);
  const outfit = wardrobeHelper.resolveCurrentOutfit(char.id, date, outfitSlot);
  const outfitSummary = String(outfit.summary || '').trim();
  const outfitSlotLabel = OUTFIT_SLOT_LABELS[outfitSlot] || outfitSlot || '';
  const curOutfitJson = outfit.outfit || null;
  const wornItems = outfit.wornItems || [];

  // 与上次监控快照对比：判断服装是否真的换了。
  // 没衣服 / 没快照 / 槽位变了 / 单品 id 变了 → 都视为「有变化」；只有整套单品完全一致才算无变化。
  let outfitChanged = true;
  if (curOutfitJson && outfitSummary && outfitSummary !== '尚未搭配') {
    const prev = getLatestOutfitSnapshot(char.id, date);
    if (prev && prev.slot === outfitSlot) {
      const prevJson = (() => { try { return JSON.parse(prev.outfit_json); } catch { return null; } })();
      outfitChanged = isOutfitJsonChanged(prevJson, curOutfitJson);
    }
  }
  // 顺手把这一次的服装写入快照，给下一次对比用。
  // outfitJson 必须克隆：resolveCurrentOutfit 返回的对象可能被后续链路改到。
  if (curOutfitJson && outfitSummary && outfitSummary !== '尚未搭配') {
    setOutfitSnapshot(char.id, date, outfitSlot, JSON.parse(JSON.stringify(curOutfitJson)), outfitSummary);
  }

  // 缓存细节去重：换了衣服 / 换了 slot 时把最近抽过的细节清掉，避免「同一句袖口卷」连续复读好几轮。
  if (outfitChanged) {
    for (const key of [..._recentFocusByChar.keys()]) {
      if (key.startsWith(`${char.id}_`)) _recentFocusByChar.delete(key);
    }
  }

  let inferredRoom = '';
  if (!away) {
    inferredRoom = inferRoomFromActivity(activity, outfitSlot);
    if (!inferredRoom && (here.placeMode === 'home' || !activity)) inferredRoom = '家中';
  }
  const normalizedInferred = away ? '' : normalizeMonitorRoom(inferredRoom);
  const viewRoom = normalizeMonitorRoom(opts.viewRoom || normalizedInferred || '客厅');

  const schedRow = db.prepare(
    'SELECT items FROM schedules WHERE character_id=? AND role=? AND date=?',
  ).get(char.id, 'ai', date);
  const items = parseJson(schedRow?.items, []);
  const slotMeta = buildScheduleSlotMeta(items, current);

  const now = new Date();
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  let statusLine = '';
  if (away) {
    statusLine = activity || '外出中';
  } else if (activity) {
    statusLine = inferredRoom ? `${inferredRoom} · ${activity}` : activity;
  } else if (inferredRoom) {
    statusLine = `${inferredRoom} · 在家`;
  } else {
    statusLine = '在家';
  }

  /* 外出目的/地点推断：从活动文案里挑地点关键词；返回「出差中 · 北京」「在公司 · 加班」之类 */
  const awayKindLabels = [
    { re: /出差/, label: '出差中' },
    { re: /上班|加班|公司|办公室|通勤/, label: '上班' },
    { re: /上学|上课|培训|大学|学校/, label: '上学中' },
    { re: /健身|锻炼|跑步|游泳|瑜伽|打球|球场/, label: '在锻炼' },
    { re: /买菜|超市|购物|逛街|商场|店里/, label: '在外面' },
    { re: /见客户|开会|会议|约|拜访|聚会|聚餐/, label: '在外面' },
    { re: /医院/, label: '在医院' },
    { re: /机场|车站|地铁|公交|路上/, label: '在路上' },
    { re: /公园|散步/, label: '在外面' },
    { re: /咖啡|餐厅|吃饭/, label: '在外面' },
  ];
  let awayDestination = '';
  if (away) {
    for (const { re, label } of awayKindLabels) {
      if (re.test(activity)) { awayDestination = label; break; }
    }
    if (!awayDestination) awayDestination = '外出中';
  }

  const customDescription = getCustomMonitorDescription(char.id);
  const homeDescription = getEffectiveHomeDescription(char);
  const customScenes = getRoomScenesMap(char.id);

  // 抽 1～2 条「穿戴细节」用于中文描述 + 生图 prompt；衣柜缺单品时细节池会自己过滤。
  const outfitFocus = (curOutfitJson && outfitSummary && outfitSummary !== '尚未搭配')
    ? pickOutfitFocus(curOutfitJson, activity, outfitSlot, char.id)
    : [];

  // 构建详细的穿搭描述：列出每个单品
  let outfitDetailText = '';
  if (wornItems.length > 0) {
    const parts = [];
    const topItem = wornItems.find(it => it.category === 'top' || it.category === 'suit' || it.category === 'gown');
    const bottomItem = wornItems.find(it => it.category === 'bottom' || it.category === 'suit' || it.category === 'gown');
    const outerItem = wornItems.find(it => it.category === 'outer');
    const shoesItem = wornItems.find(it => it.category === 'shoes');
    const bagItem = wornItems.find(it => it.category === 'bag');
    const hairItem = wornItems.find(it => it.category === 'hairstyle');
    const accessoryItems = wornItems.filter(it => it.category === 'accessory');
    
    if (topItem) parts.push(`上装：${topItem.name}`);
    if (bottomItem) parts.push(`下装：${bottomItem.name}`);
    if (outerItem) parts.push(`外套：${outerItem.name}`);
    if (shoesItem) parts.push(`鞋子：${shoesItem.name}`);
    if (bagItem) parts.push(`背包：${bagItem.name}`);
    if (hairItem) parts.push(`发型：${hairItem.name}`);
    if (accessoryItems.length) parts.push(`配饰：${accessoryItems.map(it => it.name).join('、')}`);
    
    outfitDetailText = parts.join('；');
  }

  const baseState = {
    at_home: !away,
    away,
    inferred_room: normalizedInferred,
    room: away ? '' : (inferredRoom || '家中'),
    activity: activity || (away ? '外出中' : '在家休息'),
    outfit_summary: outfitSummary || '尚未搭配',
    outfit_detail: outfitDetailText,
    outfit_items: wornItems.map(it => it.name).filter(Boolean),
    outfit_slot: outfitSlot,
    outfit_changed: outfitChanged,
    outfit_focus: outfitFocus,
    schedule_thought: String(current?.thought || '').trim(),
    clock,
  };

  const cameraScenes = buildAllCameraScenes(char, baseState, customScenes);
  const cameraScene = cameraScenes[viewRoom]?.text || '';

  return {
    date,
    clock,
    at_home: !away,
    away,
    room: away ? '' : (inferredRoom || '家中'),
    inferred_room: normalizedInferred,
    view_room: viewRoom,
    activity: activity || (away ? '外出中' : '在家休息'),
    outfit_slot: outfitSlot,
    outfit_slot_label: outfitSlotLabel,
    outfit_summary: outfitSummary || '尚未搭配',
    outfit_detail: outfitDetailText,
    outfit_items: wornItems.map(it => it.name).filter(Boolean),
    outfit_changed: outfitChanged,
    outfit_focus: outfitFocus,
    schedule_time: current?.time || '',
    schedule_thought: String(current?.thought || '').trim(),
    schedule_status: slotMeta.status,
    schedule_time_range: slotMeta.time_range,
    schedule_slot_end_mins: slotMeta.end_mins,
    status_line: statusLine,
    away_destination: awayDestination,
    home_environment: resolveCharacterHomeEnvironment(char) || '',
    home_description: homeDescription,
    custom_description: customDescription,
    has_custom_description: !!customDescription,
    monitor_rooms: MONITOR_ROOMS,
    camera_scene: cameraScene,
    camera_scenes: cameraScenes,
    has_schedule: items.length > 0,
    place_mode: here.placeMode,
    image_scene_hint: here.imageSceneHint || '',
  };
}

function buildMonitorCapturePrompt({ char, viewRoom, state, charInView, homeDesc }) {
  const set = visibleSetFromHome(homeDesc, viewRoom);
  const style = String(char?.image_style || 'anime') === 'real'
    ? 'photorealistic analog CCTV still'
    : 'anime scene framed as analog CCTV still';
  const appearance = charInView ? (buildCharacterAppearanceHint(char) || '') : '';
  const homeRefBit = buildHomeRefConsistencyPrompt(
    normalizeHomeRefs(char?.home_refs).length ? 1 : 0,
    viewRoom,
  );
  // 服装是否要在生图 prompt 里硬性指定：
  //   - 变了：直接给具体单品 summary（避免跟 wardrobe 漂移）
  //   - 没变：不写具体单品，让模型看 home_refs/face_refs 自己决定同一套衣服，避免反复"重画"同一身行头
  // 不论变没变，都把当前一段的「穿戴细节」（袖口卷 / 外套滑下）拼到 prompt 里——这才是一直在变的部分
  const outfitChanged = state.outfit_changed !== false;
  const focusBits = (charInView && Array.isArray(state.outfit_focus))
    ? state.outfit_focus.map((h) => h && h.en).filter(Boolean)
    : [];
  const focusPrompt = focusBits.length
    ? `clothing details: ${focusBits.join('; ')}`
    : '';
  const outfitPrompt = charInView
    ? (outfitChanged && state.outfit_summary && state.outfit_summary !== '尚未搭配'
        ? `wearing exactly: ${state.outfit_summary}`
        : state.outfit_slot === 'sleep'
          ? 'wearing sleepwear matching home reference'
          : 'wearing usual home clothes, match whatever is in face/home reference')
    : '';
  return [
    style,
    'home indoor security camera, ceiling-corner wide-angle fixed mount',
    'slightly grainy footage, mild digital noise, timestamp and channel overlay in corner',
    'no selfie, no portrait close-up, no cinematic bokeh, no beauty filter, no handheld phone photo',
    `camera watching ${viewRoom}, ${ROOM_CAM_CH[viewRoom] || 'CH00'}`,
    `visible furniture: ${set}`,
    homeDesc ? `interior layout must match this residence: ${String(homeDesc).slice(0, 140)}` : '',
    charInView
      ? `one person in middle distance, three-quarter or full body, ${state.activity || 'at home'}${outfitPrompt ? `, ${outfitPrompt}` : ''}`
      : 'empty room, no people, static furniture',
    charInView && focusPrompt ? focusPrompt : '',
    appearance,
    homeRefBit,
    '16:9 landscape',
  ].filter(Boolean).join(', ');
}

/**
 * 把居住环境的简短中文描述扩成详细英文 prompt 片段，
 * 用于后续自拍/视频监控截图时让模型生成匹配的内景。
 * 仅返回英文短文（不需要 JSON 包装），不会覆盖现有字段。
 */
async function buildHomeEnvironmentPrompt(input, settings, callChatAPIComplete) {
  const raw = String(input?.raw || '').trim()
    || String(input?.description || '').trim()
    || '';
  if (!raw) throw new Error('请先填写居住环境');
  if (!callChatAPIComplete) throw new Error('聊天 API 未配置');

  const refs = Array.isArray(input?.homeRefs)
    ? input.homeRefs.map((r, i) => {
        const label = String(r?.label || '').trim() || `参考图${i + 1}`;
        return `图${i + 1}（${label}）`;
      })
    : [];
  const refsHint = refs.length
    ? `\n\n附加参考：${refs.join('、')}。扩展提示词时把这些房间的视觉特点也带进去。`
    : '';

  const userMsg = `【用户写的简短居住环境描述】
${raw}${refsHint}

请扩展成一段连贯的英文室内场景描述，规则：
1. 只描述这个家本身的陈设、空间、光线氛围（沙发材质、墙面颜色、地板、窗外景观、灯光氛围），不要写人物；
2. 中文转成对应英文术语，不要硬译；
3. 控制在 120 词以内，长句为主，逗号分隔；
4. 不要加任何前缀/标签/JSON，直接输出英文描述本身；
5. 用户没提到的细节由你按整体氛围自然补足。`;

  const messages = [
    { role: 'system', content: 'You are an art director. Convert short home environment notes into concise English interior scene captions for image generation prompts. Output ONLY the caption, no preamble.' },
    { role: 'user', content: userMsg },
  ];
  const out = await callChatAPIComplete(settings, messages, { max_tokens: 380, temperature: 0.7 });
  if (!out) throw new Error('生成失败：模型未返回内容');
  return String(out).trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^Here is.*?:\s*/i, '')
    .replace(/^Caption:?\s*/i, '')
    .replace(/^Output:?\s*/i, '')
    .slice(0, 600);
}

async function captureMonitorMedia(charId, mode, settings, opts = {}) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) throw new Error('角色不存在');
  const viewRoom = normalizeMonitorRoom(opts.room);
  const state = buildMonitorState(char, { viewRoom });
  const publicBase = opts.publicBase || opts.reqBase || '';
  const charName = String(char.display_name || char.name || 'TA').trim();
  const stamp = `${charName} · ${state.clock}`;
  const homeDesc = state.home_description || state.home_environment || '';
  const charInView = state.at_home && state.inferred_room === viewRoom;
  const subject = charInView ? 'self' : 'other';
  const prompt = buildMonitorCapturePrompt({
    char, viewRoom, state, charInView, homeDesc,
  });

  const refUrls = [];
  if (charInView) {
    const faceRefs = selectSelfieReferenceUrls(char.image_ref) || [];
    if (faceRefs[0]) refUrls.push(faceRefs[0]);
  }
  const homeUrls = selectHomeReferenceUrls(char, `${viewRoom} 家里室内监控`, 2) || [];
  for (const u of homeUrls) {
    if (u && !refUrls.includes(u)) refUrls.push(u);
  }

  const genOpts = { aspect: '16:9', publicBase, reqBase: publicBase, referenceImages: refUrls };
  const stillUrl = await generateImage(settings, prompt, refUrls[0] || null, genOpts);
  if (!stillUrl) {
    throw new Error(getLastGenerateImageError() || '监控截屏生成失败');
  }

  let mediaUrl = stillUrl;
  if (mode === 'video') {
    if (!resolveImg2VideoConfig(settings)) {
      throw new Error('录屏需要图生视频 API，请先在设置里配置');
    }
    mediaUrl = await generateImageToVideo(settings, {
      prompt: 'static CCTV camera, no pan, no zoom, slight idle motion, analog grain, security footage',
      referenceImageUrl: stillUrl,
      aspect: '16:9',
      publicBase,
    });
    if (!mediaUrl) {
      throw new Error(getLastGenerateVideoError() || '监控录屏生成失败');
    }
  }

  const desc = charInView
    ? `监控截屏 · ${viewRoom} · ${state.status_line} · ${stamp}`.slice(0, 80)
    : `监控截屏 · ${viewRoom} · 无人 · ${stamp}`.slice(0, 80);
  const album = await saveGeneratedMediaToAlbum({
    characterId: charId,
    url: mediaUrl,
    mediaType: mode === 'video' ? 'video' : 'image',
    subject,
    description: desc,
  });

  return {
    ok: true,
    url: mediaUrl,
    album_id: album?.id || null,
    mode,
    state,
  };
}

module.exports = {
  MONITOR_ROOMS,
  buildMonitorState,
  getCustomMonitorDescription,
  getEffectiveHomeDescription,
  saveMonitorDescription,
  saveMonitorRoomScene,
  clearMonitorRoomScene,
  clearMonitorDescription,
  captureMonitorMedia,
  buildHomeEnvironmentPrompt,
  getLatestOutfitSnapshot,
  setOutfitSnapshot,
  isOutfitJsonChanged,
};

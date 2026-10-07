/**
 * 写真馆：定妆试穿 + 多背景合影后台任务
 */
const db = require('./db');
const { push } = require('./push');
const {
  generateImage,
  getLastGenerateImageError,
  normalizeImageRefGroups,
  toAbsoluteMediaUrl,
} = require('./api-helper');
const { queueAlbumSave } = require('./album-helper');
const wardrobe = require('./wardrobe-helper');

const MAX_CAST = 3;
const CAMERA_PRESETS = [
  { id: 'fuji', label: '富士', prompt: 'Fujifilm camera-roll color, gentle film grain, slightly muted tones' },
  { id: 'canon', label: '佳能', prompt: 'Canon DSLR candid portrait, natural skin texture, not beauty-retouched' },
  { id: 'sony', label: '索尼', prompt: 'Sony mirrorless documentary look, natural contrast, visible real skin detail' },
  { id: 'film', label: '胶片', prompt: '35mm film photo, organic grain, imperfect exposure, lived-in look' },
  { id: 'phone', label: '手机自然', prompt: 'casual smartphone camera-roll photo, slight noise, unedited' },
];

const LIGHT_MODES = [
  { id: 'background', label: '背景光源' },
  { id: 'pose', label: '姿势参考光源' },
  { id: 'custom', label: '自定义光源' },
];

const ASPECT_PRESETS = [
  { id: '3:4', label: '3:4 竖幅' },
  { id: '5:7', label: '5:7 竖幅' },
  { id: '9:16', label: '9:16 竖屏' },
  { id: '1:1', label: '1:1 方图' },
  { id: '7:5', label: '7:5 横幅（5×7 横放）' },
  { id: '4:3', label: '4:3 横幅' },
  { id: '16:9', label: '16:9 宽屏' },
];

const STYLE_PRESETS = [
  { id: 'real', label: '现实风' },
  { id: 'anime', label: '二次元风' },
];

/** 合影/试穿画风：现实风重点打掉 AI 油皮、磨皮、假人感 */
function stylePromptForShoot(styleId) {
  if (styleId === 'anime') {
    return [
      'anime 2D illustration, clean lineart, soft cel shading',
      'all people drawn in the SAME anime style, same line weight and shading language',
      'if a reference looks photoreal or 3D CGI, redraw that person as matching 2D anime while keeping identity',
      'single cohesive illustration in one scene, not stickers, not collage, not separate layers',
    ].join(', ');
  }
  return [
    'raw unedited photograph of real people, camera-roll authenticity',
    'real human skin with visible pores, fine peach fuzz, subtle freckles or uneven tone where natural',
    'matte to naturally oily mix like real skin, NEVER glossy plastic shine',
    'no beauty filter, no airbrushed skin, no porcelain doll face, no AI smooth face',
    'no HDR glow, no overprocessed portrait, no waxy subsurface scattering',
    'imperfect candid photo: slight asymmetry, natural under-eye texture, real fabric wrinkles',
    'not 3D render, not Unreal Engine, not Blender, not CGI character, not anime',
    'ALL subjects share the SAME photographic realism and skin material as a real user phone photo',
    'if any reference is 3D/CGI/game/anime, reinterpret as a living human photographed the same way',
    'single continuous exposure in one physical space, shared lighting and depth of field',
    'NOT collage, NOT cut-and-paste layers, NOT green-screen composite',
  ].join(', ');
}

function heightRelPrompt(heightRel) {
  const map = {
    same: 'user is about the same height as the character',
    shorter_0_5: 'user is half a head shorter than the character',
    shorter_1: 'user is one head shorter than the character',
    shorter_1_5: 'user is one and a half heads shorter than the character',
    shorter_2: 'user is two heads shorter than the character',
    taller_0_5: 'user is half a head taller than the character',
    taller_1: 'user is one head taller than the character',
  };
  return map[String(heightRel || '')] || '';
}

function resolveSessionStyle(session, shoot = {}) {
  return shoot.imageStyle || session?.imageStyle || 'real';
}

const STUDIO_EXTRA_CATEGORIES = {
  suit: { label: '套装', purchaseCount: 1 },
  gown: { label: '礼服', purchaseCount: 1 },
};

let _tablesReady = false;
let _pumping = false;
let _pumpGetSettings = null;
let _pumpPublicBase = '';

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photostudio_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'draft',
      character_ids TEXT DEFAULT '[]',
      user_json TEXT DEFAULT '{}',
      looks_json TEXT DEFAULT '{}',
      backgrounds_json TEXT DEFAULT '[]',
      shoots_json TEXT DEFAULT '[]',
      album_target TEXT DEFAULT '',
      image_style TEXT DEFAULT 'real',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS photostudio_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      payload TEXT DEFAULT '{}',
      result_url TEXT DEFAULT '',
      error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ta_studio_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      caption TEXT DEFAULT '',
      session_id INTEGER DEFAULT 0,
      job_id INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function ready() {
  if (_tablesReady) return;
  try {
    ensureTables();
    try {
      db.exec(`ALTER TABLE photostudio_sessions ADD COLUMN image_style TEXT DEFAULT 'real'`);
    } catch (_) { /* exists */ }
    _tablesReady = true;
  } catch (e) {
    console.warn('[photostudio] ensure tables', e.message);
  }
}

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || fallback;
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function meta() {
  const cats = {
    ...wardrobe.WARDROBE_CATEGORIES,
    ...STUDIO_EXTRA_CATEGORIES,
  };
  return {
    maxCast: MAX_CAST,
    categories: Object.entries(cats).map(([id, v]) => ({ id, label: v.label })),
    cameras: CAMERA_PRESETS,
    lightModes: LIGHT_MODES,
    aspects: ASPECT_PRESETS,
    styles: STYLE_PRESETS,
    builds: ['偏瘦', '标准', '偏丰满'],
    heightRels: [
      { id: 'same', label: '和角色差不多高' },
      { id: 'shorter_0_5', label: '比角色矮半个头' },
      { id: 'shorter_1', label: '比角色矮一个头' },
      { id: 'shorter_1_5', label: '比角色矮一个半头' },
      { id: 'shorter_2', label: '比角色矮两个头' },
      { id: 'taller_0_5', label: '比角色高半个头' },
      { id: 'taller_1', label: '比角色高一个头' },
    ],
  };
}

function serializeSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status || 'draft',
    characterIds: parseJson(row.character_ids, []).map(Number).filter(Boolean),
    user: parseJson(row.user_json, {}),
    looks: parseJson(row.looks_json, {}),
    backgrounds: parseJson(row.backgrounds_json, []),
    shoots: parseJson(row.shoots_json, []),
    albumTarget: row.album_target || '',
    imageStyle: row.image_style === 'anime' ? 'anime' : 'real',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    payload: parseJson(row.payload, {}),
    resultUrl: row.result_url || '',
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getSession(id) {
  ready();
  const row = db.prepare('SELECT * FROM photostudio_sessions WHERE id=?').get(Number(id) || 0);
  return serializeSession(row);
}

function listSessions(limit = 20) {
  ready();
  const lim = Math.min(50, Math.max(1, Number(limit) || 20));
  return db.prepare(
    `SELECT * FROM photostudio_sessions ORDER BY id DESC LIMIT ?`
  ).all(lim).map(serializeSession);
}

function createSession({ characterIds = [] } = {}) {
  ready();
  const ids = [...new Set((characterIds || []).map(Number).filter(Boolean))].slice(0, MAX_CAST);
  if (!ids.length) throw new Error('请至少选择一位角色');
  const r = db.prepare(
    `INSERT INTO photostudio_sessions (status, character_ids, user_json, looks_json, backgrounds_json, shoots_json)
     VALUES ('draft', ?, '{}', '{}', '[]', '[]')`
  ).run(JSON.stringify(ids));
  return getSession(r.lastInsertRowid);
}

function updateSession(id, patch = {}) {
  ready();
  const cur = getSession(id);
  if (!cur) throw new Error('场次不存在');

  let characterIds = cur.characterIds;
  if (patch.characterIds) {
    characterIds = [...new Set(patch.characterIds.map(Number).filter(Boolean))].slice(0, MAX_CAST);
    if (!characterIds.length) throw new Error('请至少选择一位角色');
  }

  const user = patch.user != null ? { ...cur.user, ...patch.user } : cur.user;
  const looks = patch.looks != null ? { ...cur.looks, ...patch.looks } : cur.looks;
  const backgrounds = patch.backgrounds != null ? patch.backgrounds : cur.backgrounds;
  const shoots = patch.shoots != null ? patch.shoots : cur.shoots;
  const albumTarget = patch.albumTarget != null ? String(patch.albumTarget || '') : cur.albumTarget;
  const imageStyle = patch.imageStyle != null
    ? (String(patch.imageStyle) === 'anime' ? 'anime' : 'real')
    : cur.imageStyle;
  const status = patch.status != null ? String(patch.status) : cur.status;

  db.prepare(
    `UPDATE photostudio_sessions
     SET character_ids=?, user_json=?, looks_json=?, backgrounds_json=?, shoots_json=?,
         album_target=?, image_style=?, status=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    JSON.stringify(characterIds),
    JSON.stringify(user || {}),
    JSON.stringify(looks || {}),
    JSON.stringify(backgrounds || []),
    JSON.stringify(shoots || []),
    albumTarget,
    imageStyle,
    status,
    cur.id,
  );
  return getSession(cur.id);
}

function getJob(id) {
  ready();
  return serializeJob(db.prepare('SELECT * FROM photostudio_jobs WHERE id=?').get(Number(id) || 0));
}

function listJobs(sessionId, limit = 40) {
  ready();
  const lim = Math.min(80, Math.max(1, Number(limit) || 40));
  return db.prepare(
    `SELECT * FROM photostudio_jobs WHERE session_id=? ORDER BY id DESC LIMIT ?`
  ).all(Number(sessionId) || 0, lim).map(serializeJob);
}

function enqueueJob(sessionId, kind, payload = {}) {
  ready();
  const r = db.prepare(
    `INSERT INTO photostudio_jobs (session_id, kind, status, payload) VALUES (?,?, 'queued', ?)`
  ).run(Number(sessionId), kind, JSON.stringify(payload || {}));
  return getJob(r.lastInsertRowid);
}

function setJobStatus(id, status, extra = {}) {
  ready();
  db.prepare(
    `UPDATE photostudio_jobs
     SET status=?, result_url=COALESCE(?, result_url), error=COALESCE(?, error), updated_at=datetime('now')
     WHERE id=?`
  ).run(status, extra.resultUrl ?? null, extra.error ?? null, id);
  const job = getJob(id);
  push('photostudio_job', {
    jobId: job.id,
    sessionId: job.sessionId,
    kind: job.kind,
    status: job.status,
    resultUrl: job.resultUrl,
    error: job.error,
    payload: job.payload,
  });
  return job;
}

function recoverStaleJobs() {
  ready();
  try {
    const stale = db.prepare(
      `SELECT id FROM photostudio_jobs WHERE status='running'`
    ).all();
    for (const row of stale) {
      setJobStatus(row.id, 'error', { error: '服务重启，任务中断，请重试' });
    }
  } catch (_) {}
}

function absUrl(url, publicBase) {
  const u = String(url || '').trim();
  if (!u) return '';
  try {
    return toAbsoluteMediaUrl(u, publicBase) || u;
  } catch {
    if (/^https?:\/\//i.test(u)) return u;
    if (publicBase && u.startsWith('/')) return `${String(publicBase).replace(/\/$/, '')}${u}`;
    return u;
  }
}

function cameraPrompt(cameraId) {
  const hit = CAMERA_PRESETS.find((c) => c.id === cameraId);
  return hit?.prompt || CAMERA_PRESETS[0].prompt;
}

function clothingPromptFromItems(items = []) {
  const bits = [];
  let hasHairstyle = false;
  let hasGarmentImage = false;
  for (const it of items) {
    const cat = it.category || '';
    const name = String(it.name || it.description || '').trim();
    const hasImg = !!(it.imageUrl || it.image_url);
    if (cat === 'hairstyle') {
      hasHairstyle = true;
      if (hasImg) {
        bits.push('match hairstyle cut/shape/length from the hairstyle reference image');
      } else if (name) {
        bits.push(`change only the hairstyle cut/shape/length to match: ${name}`);
      }
      continue;
    }
    if (hasImg) {
      hasGarmentImage = true;
      // 有图时不要用名字主导，否则模型会按文字另画一件，忽略上传图
      const label = cat === 'suit' ? 'suit set' : cat === 'gown' ? 'gown/dress' : (cat || 'garment');
      bits.push(`wear the exact ${label} from the clothing reference image (color, pattern, cut, details)`);
      continue;
    }
    if (!name) continue;
    if (cat === 'suit') bits.push(`wearing a coordinated suit set: ${name}`);
    else if (cat === 'gown') bits.push(`wearing a formal gown/dress: ${name}`);
    else bits.push(`${cat || 'clothing'}: ${name}`);
  }
  if (hasGarmentImage) {
    bits.push('clothing appearance must follow the clothing reference photo, not invent from the item name');
  }
  if (hasHairstyle) {
    bits.push('keep the original hair color from the face identity reference; do not recolor hair unless the hairstyle item name explicitly says a dye color');
  }
  return bits.join(', ');
}

const FACE_LOCK_PROMPT = [
  'FACE LOCK (highest priority): faces must stay identical to the face reference photos',
  'same face shape, eyes, nose, mouth, brows, skin tone, bone structure',
  'do not beautify, reinvent, age-shift, or swap faces',
  'outfit/hair/pose/background may change but faces are absolute immutable identity anchors',
].join(', ');

function collectFaceRefs(session, publicBase) {
  const out = [];
  if (session.user?.faceUrl) out.push(absUrl(session.user.faceUrl, publicBase));
  for (const cid of (session.characterIds || [])) {
    const look = session.looks?.[String(cid)] || session.looks?.[cid] || {};
    const lookFace = look.faceUrl || look.imageUrl;
    if (lookFace) {
      out.push(absUrl(lookFace, publicBase));
      continue;
    }
    const char = db.prepare('SELECT image_ref, avatar FROM characters WHERE id=?').get(Number(cid));
    const groups = normalizeImageRefGroups(char?.image_ref || '[]');
    for (const u of (groups.face || []).slice(0, 2)) out.push(absUrl(u, publicBase));
    if (!(groups.face || []).length && char?.avatar) out.push(absUrl(char.avatar, publicBase));
  }
  return [...new Set(out.filter(Boolean))];
}

function vibeLine(kind, name) {
  const n = name || 'TA';
  if (kind === 'char_ask') {
    const lines = [
      `${n}转了个圈：「这套怎么样？好看吗？」`,
      `${n}拍了拍衣角：「要不要再换一件？」`,
      `${n}对着镜子愣了一下：「……你觉得呢？」`,
    ];
    return lines[Math.floor(Math.random() * lines.length)];
  }
  const lines = [
    `${n}看了看你：「这身挺适合你的。」`,
    `${n}轻轻点头：「嗯，比刚才更像要去拍照的样子。」`,
    `${n}笑了一下：「定了这套吧，我喜欢。」`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

function subjectKey(subject) {
  if (subject === 'user') return 'user';
  return String(Number(subject) || subject || '');
}

async function runTryOnJob(job, settings, publicBase) {
  const session = getSession(job.sessionId);
  if (!session) throw new Error('场次不存在');
  const p = job.payload || {};
  const key = subjectKey(p.subject);
  const items = Array.isArray(p.items) ? p.items : [];
  const clothingUrls = items.map((it) => it.imageUrl || it.image_url).filter(Boolean);
  const refs = [];

  if (key === 'user') {
    if (!session.user?.faceUrl) throw new Error('请先上传用户脸部形象图');
    refs.push(absUrl(session.user.faceUrl, publicBase));
    if (session.user.bodyUrl) refs.push(absUrl(session.user.bodyUrl, publicBase));
  } else {
    const char = db.prepare('SELECT * FROM characters WHERE id=?').get(Number(key));
    if (!char) throw new Error('角色不存在');
    const groups = normalizeImageRefGroups(char.image_ref || '[]');
    for (const u of (groups.face || []).slice(0, 2)) refs.push(absUrl(u, publicBase));
    for (const u of (groups.body || []).slice(0, 1)) refs.push(absUrl(u, publicBase));
    if (!refs.length && char.avatar) refs.push(absUrl(char.avatar, publicBase));
    if (!refs.length) throw new Error('角色缺少形象参考图，请先在外貌页上传');
  }

  for (const u of clothingUrls.slice(0, 4)) refs.push(absUrl(u, publicBase));

  const who = key === 'user' ? 'the user' : 'the character';
  const heightRel = key === 'user' ? heightRelPrompt(session.user?.heightRel) : '';
  const build = key === 'user' ? (session.user.build || '') : '';
  const cloth = clothingPromptFromItems(items);
  const hasHair = items.some((it) => it.category === 'hairstyle');
  const styleId = resolveSessionStyle(session);
  const styleBit = stylePromptForShoot(styleId);
  const prompt = [
    FACE_LOCK_PROMPT,
    styleBit,
    `Fashion try-on portrait of ${who}.`,
    heightRel,
    build ? `body build: ${build}` : '',
    cloth ? `change outfit/hairstyle to match: ${cloth}` : 'keep a clean stylish outfit',
    hasHair
      ? 'If a hairstyle reference is provided, match cut and silhouette only; preserve the person\'s original hair color from face refs.'
      : '',
    clothingUrls.length
      ? 'Garment/hairstyle reference images define the clothing appearance; follow those images over any short item labels.'
      : '',
    'single person only, plain neutral studio backdrop, upright standing pose, mid-shot or full body',
    'clear face matching face references exactly, no second person, no watermark',
  ].filter(Boolean).join(' ');

  const url = await generateImage(settings, prompt, null, {
    referenceImages: [...new Set(refs.filter(Boolean))].slice(0, 5),
    requireReference: true,
    aspect: '3:4',
    publicBase,
  });
  if (!url) throw new Error(getLastGenerateImageError() || '试穿生图失败');

  const lookPatch = {
    [key]: {
      confirmedUrl: '',
      previewUrl: url,
      items,
      updatedAt: nowIso(),
    },
  };
  const prev = session.looks[key] || {};
  updateSession(session.id, {
    looks: {
      [key]: {
        ...prev,
        ...lookPatch[key],
        confirmedUrl: prev.confirmedUrl || '',
      },
    },
  });

  const charName = key === 'user'
    ? '你'
    : (db.prepare('SELECT name FROM characters WHERE id=?').get(Number(key))?.name || 'TA');
  return {
    resultUrl: url,
    vibe: key === 'user' ? vibeLine('user_done', charName) : vibeLine('char_ask', charName),
  };
}

function buildShootPrompt(session, shoot, bg) {
  const names = [];
  const outfitBits = [];
  for (const cid of session.characterIds) {
    const row = db.prepare('SELECT name FROM characters WHERE id=?').get(cid);
    if (row?.name) names.push(row.name);
    const look = session.looks[String(cid)] || session.looks[cid] || {};
    const cloth = clothingPromptFromItems(look.items || []);
    if (cloth) outfitBits.push(`${row?.name || 'character'} outfit lock: ${cloth}`);
  }
  names.push('the user');
  const userLook = session.looks.user || {};
  const userCloth = clothingPromptFromItems(userLook.items || []);
  if (userCloth) outfitBits.push(`user outfit lock: ${userCloth}`);
  const heightRel = heightRelPrompt(session.user?.heightRel);

  const light = shoot.lightMode || 'background';
  let lightBit = 'match lighting on people to the background environment light';
  if (light === 'pose') lightBit = 'match lighting on people to the pose reference photo';
  if (light === 'custom') lightBit = `custom lighting: ${shoot.lightCustom || 'soft natural light'}`;
  else if (shoot.lightCustom) lightBit += `; tweak: ${shoot.lightCustom}`;

  const poseBit = shoot.poseNote
    ? `pose/action: ${shoot.poseNote}`
    : (shoot.poseUrl ? 'match pose/composition from pose reference' : 'natural couple/group photo pose');

  const bgDesc = bg.description
    ? `place the people INTO the provided background reference photo (${bg.description}); keep the background scene recognizable`
    : 'place the people INTO the provided background reference photo; keep location, architecture, and scenery from that image';

  const styleId = resolveSessionStyle(session, shoot);
  const styleBit = stylePromptForShoot(styleId);

  return [
    FACE_LOCK_PROMPT,
    styleBit,
    `Group photo of ${names.join(' and ')} together in one frame.`,
    heightRel ? `${heightRel}; keep this relative height difference clear in the standing composition` : '',
    'Use face reference photos as absolute face identity for each person.',
    'Outfit/hairstyle follow the confirmed look and clothing references; do not invent new clothes from item names when clothing photos exist.',
    ...outfitBits,
    bgDesc,
    poseBit,
    lightBit,
    `camera look: ${cameraPrompt(shoot.camera)}`,
    shoot.extra ? `extra requirements: ${shoot.extra}` : '',
    'no watermark, no extra strangers',
  ].filter(Boolean).join(' ');
}

async function runShootJob(job, settings, publicBase) {
  const session = getSession(job.sessionId);
  if (!session) throw new Error('场次不存在');
  const p = job.payload || {};
  const bgId = p.bgId;
  const bg = (session.backgrounds || []).find((b) => String(b.id) === String(bgId));
  if (!bg?.url) throw new Error('背景不存在');
  const shoot = (session.shoots || []).find((s) => String(s.bgId) === String(bgId)) || p.shoot || {};

  const userLook = session.looks.user || {};
  const userUrl = userLook.confirmedUrl || userLook.previewUrl || session.user?.faceUrl;
  if (!userUrl) throw new Error('请先完成并确认用户定妆或上传形象');

  const faceRefs = collectFaceRefs(session, publicBase);
  const lookRefs = [];
  for (const cid of session.characterIds) {
    const look = session.looks[String(cid)] || session.looks[cid];
    const url = look?.confirmedUrl || look?.previewUrl;
    if (!url) throw new Error('请先完成并确认角色定妆');
    lookRefs.push(absUrl(url, publicBase));
  }
  lookRefs.push(absUrl(userUrl, publicBase));

  const clothRefs = [];
  for (const cid of session.characterIds) {
    const look = session.looks[String(cid)] || session.looks[cid] || {};
    for (const it of (look.items || [])) {
      const u = it.imageUrl || it.image_url;
      if (u) clothRefs.push(absUrl(u, publicBase));
    }
  }
  for (const it of (userLook.items || [])) {
    const u = it.imageUrl || it.image_url;
    if (u) clothRefs.push(absUrl(u, publicBase));
  }

  const bgRef = absUrl(bg.url, publicBase);
  const poseRef = shoot.poseUrl ? absUrl(shoot.poseUrl, publicBase) : '';
  const picked = [];
  const pushUnique = (url) => {
    if (!url || picked.includes(url)) return;
    picked.push(url);
  };

  // 脸 → 背景(必进) → 定妆 → 服饰 → 姿势；最多 5 张，背景不得被挤掉
  for (const f of faceRefs) {
    if (picked.length >= 3) break;
    pushUnique(f);
  }
  pushUnique(bgRef);
  for (const u of lookRefs) {
    if (picked.length >= 5) break;
    pushUnique(u);
  }
  for (const u of clothRefs) {
    if (picked.length >= 5) break;
    pushUnique(u);
  }
  if (picked.length < 5 && poseRef) pushUnique(poseRef);
  if (bgRef && !picked.includes(bgRef)) {
    if (picked.length >= 5) picked[picked.length - 1] = bgRef;
    else picked.push(bgRef);
  }
  const uniqRefs = picked.slice(0, 5);

  const prompt = buildShootPrompt(session, shoot, bg);
  const url = await generateImage(settings, prompt, null, {
    referenceImages: uniqRefs,
    requireReference: true,
    aspect: shoot.aspect || '3:4',
    publicBase,
  });
  if (!url) throw new Error(getLastGenerateImageError() || '合影生图失败');

  const target = session.albumTarget || p.albumTarget || '';
  const primaryCharId = session.characterIds[0];
  const caption = bg.description || '写真馆合影';

  if (target === 'nian' || target === 'both') {
    queueAlbumSave({
      characterId: primaryCharId,
      url,
      mediaType: 'image',
      subject: 'other',
      description: caption.slice(0, 80),
    });
  }
  if (target === 'ta' || target === 'both') {
    insertStudioPhoto({
      characterId: primaryCharId,
      url,
      caption,
      sessionId: session.id,
      jobId: job.id,
    });
  }

  updateSession(session.id, { status: 'shooting' });
  return { resultUrl: url };
}

async function processJob(jobRow, getSettings, publicBase) {
  const job = serializeJob(jobRow);
  setJobStatus(job.id, 'running');
  try {
    const settings = typeof getSettings === 'function' ? getSettings() : getSettings;
    let out;
    if (job.kind === 'tryon') out = await runTryOnJob(job, settings, publicBase);
    else if (job.kind === 'shoot') out = await runShootJob(job, settings, publicBase);
    else throw new Error(`未知任务类型: ${job.kind}`);

    // 把 vibe 写回 payload 便于前端展示
    if (out?.vibe) {
      ready();
      const payload = { ...(job.payload || {}), vibe: out.vibe };
      db.prepare(
        `UPDATE photostudio_jobs SET payload=?, updated_at=datetime('now') WHERE id=?`
      ).run(JSON.stringify(payload), job.id);
    }
    return setJobStatus(job.id, 'done', { resultUrl: out.resultUrl, error: '' });
  } catch (e) {
    console.warn('[photostudio] job failed', job.id, e.message);
    return setJobStatus(job.id, 'error', { error: e.message || '生成失败' });
  }
}

function pumpJobs(getSettings, publicBase) {
  if (typeof getSettings === 'function') _pumpGetSettings = getSettings;
  if (publicBase) _pumpPublicBase = String(publicBase);
  if (_pumping) return;
  _pumping = true;
  (async () => {
    try {
      ready();
      while (true) {
        const row = db.prepare(
          `SELECT * FROM photostudio_jobs WHERE status='queued' ORDER BY id ASC LIMIT 1`
        ).get();
        if (!row) break;
        const settingsFn = _pumpGetSettings || (() => {
          try {
            return Object.fromEntries(
              db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])
            );
          } catch {
            return {};
          }
        });
        await processJob(row, settingsFn, _pumpPublicBase || '');
      }
    } finally {
      _pumping = false;
    }
  })().catch((e) => {
    console.warn('[photostudio] pump', e.message);
    _pumping = false;
  });
}

function queueTryOn(sessionId, { subject, items }, ctx = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error('场次不存在');
  const key = subjectKey(subject);
  if (key === 'user' && !session.user?.faceUrl) throw new Error('请先上传用户脸部形象图');
  if (!Array.isArray(items) || !items.length) throw new Error('请选择或上传服饰');
  const job = enqueueJob(sessionId, 'tryon', { subject: key, items });
  pumpJobs(ctx.getSettings, ctx.publicBase);
  return job;
}

function confirmLook(sessionId, { subject, resultUrl, items }) {
  const session = getSession(sessionId);
  if (!session) throw new Error('场次不存在');
  const key = subjectKey(subject);
  const prev = session.looks[key] || {};
  let url = String(resultUrl || prev.previewUrl || '').trim();
  if (!url && key === 'user') url = String(session.user?.faceUrl || '').trim();
  if (!url && key !== 'user') {
    const char = db.prepare('SELECT image_ref, avatar FROM characters WHERE id=?').get(Number(key));
    const groups = normalizeImageRefGroups(char?.image_ref || '[]');
    url = String((groups.face || [])[0] || char?.avatar || '').trim();
  }
  if (!url) throw new Error('没有可确认的定妆图，请先试穿或上传形象');
  const nextItems = Array.isArray(items) ? items : (prev.items || []);
  updateSession(sessionId, {
    looks: {
      [key]: {
        ...prev,
        items: nextItems,
        previewUrl: prev.previewUrl || url,
        confirmedUrl: url,
        confirmedAt: nowIso(),
      },
    },
    status: 'dressed',
  });
  const charName = key === 'user'
    ? '你'
    : (db.prepare('SELECT name FROM characters WHERE id=?').get(Number(key))?.name || 'TA');
  return {
    session: getSession(sessionId),
    vibe: key === 'user' ? vibeLine('user_done', charName) : vibeLine('char_ask', charName),
  };
}

function queueShoot(sessionId, { albumTarget } = {}, ctx = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error('场次不存在');
  if (!session.backgrounds?.length) throw new Error('请先上传背景图');
  for (const cid of session.characterIds) {
    const look = session.looks[String(cid)] || session.looks[cid];
    if (!look?.confirmedUrl && !look?.previewUrl) throw new Error('请先确认角色定妆');
  }
  if (!session.looks.user?.confirmedUrl && !session.looks.user?.previewUrl && !session.user?.faceUrl) {
    throw new Error('请先确认用户定妆');
  }

  const target = albumTarget || session.albumTarget || 'nian';
  updateSession(sessionId, { albumTarget: target, status: 'shooting' });

  // 确保每张背景有拍摄单
  const shoots = [...(session.shoots || [])];
  for (const bg of session.backgrounds) {
    if (!shoots.some((s) => String(s.bgId) === String(bg.id))) {
      shoots.push({
        bgId: bg.id,
        poseUrl: '',
        poseNote: '',
        lightMode: 'background',
        lightCustom: '',
        camera: 'fuji',
        aspect: '3:4',
        extra: '',
      });
    }
  }
  updateSession(sessionId, { shoots });

  const jobs = [];
  for (const bg of session.backgrounds) {
    const shoot = {
      ...(shoots.find((s) => String(s.bgId) === String(bg.id)) || {}),
      imageStyle: session.imageStyle || 'real',
    };
    jobs.push(enqueueJob(sessionId, 'shoot', { bgId: bg.id, shoot, albumTarget: target }));
  }
  pumpJobs(ctx.getSettings, ctx.publicBase);
  return { session: getSession(sessionId), jobs };
}

function insertStudioPhoto({ characterId, url, caption = '', sessionId = 0, jobId = 0 }) {
  ready();
  const cid = Number(characterId) || 0;
  if (!cid || !url) throw new Error('缺少写真');
  const r = db.prepare(
    `INSERT INTO ta_studio_photos (character_id, url, caption, session_id, job_id)
     VALUES (?,?,?,?,?)`
  ).run(cid, String(url).trim(), String(caption || '').trim().slice(0, 200), Number(sessionId) || 0, Number(jobId) || 0);
  const photo = getStudioPhoto(r.lastInsertRowid);
  push('ta_studio_album_updated', { characterId: cid, photoId: photo.id });
  return photo;
}

function serializeStudioPhoto(row) {
  if (!row) return null;
  return {
    id: row.id,
    characterId: row.character_id,
    url: row.url,
    caption: row.caption || '',
    sessionId: row.session_id || 0,
    jobId: row.job_id || 0,
    createdAt: row.created_at,
  };
}

function getStudioPhoto(id) {
  ready();
  return serializeStudioPhoto(db.prepare('SELECT * FROM ta_studio_photos WHERE id=?').get(Number(id) || 0));
}

function listStudioPhotos(characterId, { limit = 60, beforeId = 0 } = {}) {
  ready();
  const cid = Number(characterId) || 0;
  const lim = Math.min(120, Math.max(1, Number(limit) || 60));
  const before = Number(beforeId) || 0;
  const rows = before > 0
    ? db.prepare(
      `SELECT * FROM ta_studio_photos WHERE character_id=? AND id<? ORDER BY id DESC LIMIT ?`
    ).all(cid, before, lim)
    : db.prepare(
      `SELECT * FROM ta_studio_photos WHERE character_id=? ORDER BY id DESC LIMIT ?`
    ).all(cid, lim);
  return rows.map(serializeStudioPhoto);
}

function snapshotStudioAlbum(characterId) {
  ready();
  const cid = Number(characterId) || 0;
  if (!cid) return { count: 0, latestUrl: '', latestAt: '' };
  const row = db.prepare(
    `SELECT COUNT(*) AS n,
            (SELECT url FROM ta_studio_photos WHERE character_id=? ORDER BY id DESC LIMIT 1) AS latestUrl,
            (SELECT created_at FROM ta_studio_photos WHERE character_id=? ORDER BY id DESC LIMIT 1) AS latestAt
     FROM ta_studio_photos WHERE character_id=?`
  ).get(cid, cid, cid);
  return {
    count: Number(row?.n) || 0,
    latestUrl: String(row?.latestUrl || ''),
    latestAt: String(row?.latestAt || ''),
  };
}

function deleteStudioPhoto(photoId, characterId) {
  ready();
  const row = db.prepare('SELECT * FROM ta_studio_photos WHERE id=?').get(Number(photoId) || 0);
  if (!row || Number(row.character_id) !== Number(characterId)) throw new Error('照片不存在');
  db.prepare('DELETE FROM ta_studio_photos WHERE id=?').run(row.id);
  push('ta_studio_album_updated', { characterId: Number(characterId), photoId: Number(photoId), action: 'delete' });
  return { ok: true };
}

function ensureStudioCategories() {
  // 让衣柜 API 也能返回套装/礼服
  Object.assign(wardrobe.WARDROBE_CATEGORIES, STUDIO_EXTRA_CATEGORIES);
}

ensureStudioCategories();
recoverStaleJobs();

module.exports = {
  meta,
  getSession,
  listSessions,
  createSession,
  updateSession,
  getJob,
  listJobs,
  queueTryOn,
  confirmLook,
  queueShoot,
  pumpJobs,
  recoverStaleJobs,
  listStudioPhotos,
  snapshotStudioAlbum,
  deleteStudioPhoto,
  insertStudioPhoto,
  getStudioPhoto,
  CAMERA_PRESETS,
  LIGHT_MODES,
  ASPECT_PRESETS,
  STYLE_PRESETS,
  STUDIO_EXTRA_CATEGORIES,
  MAX_CAST,
};

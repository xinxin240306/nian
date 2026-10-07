/**
 * 穿越·模型侧剧本世界书 + 场景礼仪 + 向量记忆检索
 * 与用户身份卡分工：身份卡给人看；本模块只给模型按需注入，防人设漂移。
 */
const db = require('./db');
const series = require('./series-helper');
const {
  buildCorpusDf,
  scoreTextsAgainst,
  passRelevance,
  embedText,
  parseStoredEmbedding,
} = require('./embed-helper');

function parseJson(raw, fallback) {
  return series.parseJson(raw, fallback);
}

function emptyLore() {
  return {
    version: 1,
    locks: {
      user_title: '',
      user_ordinal: '',
      user_surface_name: '',
    },
    entities: [],
    places: [],
    chapter_stage: {
      chapter_no: 0,
      scene_space: 'other',
      on_stage: [],
      introduced_ids: [],
    },
    bond: { stage: 0, heat: 0 },
    identity_events: [],
  };
}

function readLore(book) {
  const raw = book?.lore_book;
  if (raw && typeof raw === 'object') {
    return normalizeLore(raw);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return normalizeLore(parseJson(raw, emptyLore()));
  }
  return emptyLore();
}

function normalizeLore(raw) {
  const base = emptyLore();
  const o = raw && typeof raw === 'object' ? raw : {};
  const locks = o.locks && typeof o.locks === 'object' ? o.locks : {};
  base.locks = {
    user_title: String(locks.user_title || '').trim().slice(0, 80),
    user_ordinal: String(locks.user_ordinal || '').trim().slice(0, 40),
    user_surface_name: String(locks.user_surface_name || '').trim().slice(0, 40),
  };
  base.entities = (Array.isArray(o.entities) ? o.entities : []).map(normalizeEntity).filter((e) => e.name);
  base.places = (Array.isArray(o.places) ? o.places : []).map((p) => ({
    id: String(p.id || p.name || '').trim().slice(0, 40),
    name: String(p.name || '').trim().slice(0, 40),
    space: normalizeSceneSpace(p.space || p.scene_space || 'other'),
    note: String(p.note || '').trim().slice(0, 120),
  })).filter((p) => p.name);
  const cs = o.chapter_stage && typeof o.chapter_stage === 'object' ? o.chapter_stage : {};
  base.chapter_stage = {
    chapter_no: Number(cs.chapter_no) || 0,
    scene_space: normalizeSceneSpace(cs.scene_space || 'other'),
    on_stage: (Array.isArray(cs.on_stage) ? cs.on_stage : []).map((x) => ({
      id: String(x.id || x.name || '').trim().slice(0, 40),
      name: String(x.name || '').trim().slice(0, 40),
      status: x.status === 'left' ? 'left' : 'present',
      note: String(x.note || '').trim().slice(0, 80),
    })).filter((x) => x.name).slice(0, 16),
    introduced_ids: (Array.isArray(cs.introduced_ids) ? cs.introduced_ids : [])
      .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 40),
  };
  const bond = o.bond && typeof o.bond === 'object' ? o.bond : {};
  base.bond = {
    stage: Math.max(0, Math.min(5, Number(bond.stage) || 0)),
    heat: Math.max(0, Math.min(100, Number(bond.heat) || 0)),
  };
  base.identity_events = (Array.isArray(o.identity_events) ? o.identity_events : [])
    .map((e) => String(e || '').trim().slice(0, 120)).filter(Boolean).slice(0, 12);
  return base;
}

function normalizeEntity(e) {
  if (!e || typeof e !== 'object') return null;
  const name = String(e.name || '').trim().slice(0, 40);
  if (!name) return null;
  const aliases = (Array.isArray(e.aliases) ? e.aliases : [])
    .map((a) => String(a || '').trim().slice(0, 40)).filter(Boolean).slice(0, 8);
  return {
    id: String(e.id || name).trim().slice(0, 40) || name,
    name,
    aliases,
    kind: String(e.kind || 'npc').trim().slice(0, 24),
    relation_to_user: String(e.relation_to_user || e.relation || '').trim().slice(0, 120),
    know_user: e.know_user !== false,
    intro_hint: String(e.intro_hint || e.relation_to_user || '').trim().slice(0, 100),
    gender: e.gender === 'male' ? 'male' : (e.gender === 'female' ? 'female' : ''),
  };
}

function saveLore(bookId, lore) {
  const normalized = normalizeLore(lore);
  db.prepare(`UPDATE series_books SET lore_book=?, updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(normalized), bookId);
  return normalized;
}

/** 从身份锁/角色池/关系句搭建模型世界书（开始穿越时） */
function buildLoreFromIdentity(book, { userSlot, charSlot, cast } = {}) {
  const lore = emptyLore();
  const u = userSlot || book?.identity_lock?.user || {};
  const c = charSlot || book?.identity_lock?.char || {};
  const brief = String(u.surface_brief || book?.user_surface_brief || '').trim();
  const name = String(u.surface_name || book?.user_role || '').trim();
  lore.locks.user_surface_name = name;
  lore.locks.user_title = brief.slice(0, 80);
  const ordinal = extractOrdinalTitle(`${name} ${brief}`);
  if (ordinal) lore.locks.user_ordinal = ordinal;

  const entities = [];
  const seen = new Set();
  const addEnt = (ent) => {
    const e = normalizeEntity(ent);
    if (!e) return;
    const key = e.name;
    if (seen.has(key)) {
      const hit = entities.find((x) => x.name === key);
      if (hit) {
        for (const a of e.aliases) {
          if (!hit.aliases.includes(a)) hit.aliases.push(a);
        }
        if (!hit.relation_to_user && e.relation_to_user) hit.relation_to_user = e.relation_to_user;
        if (!hit.intro_hint && e.intro_hint) hit.intro_hint = e.intro_hint;
      }
      return;
    }
    seen.add(key);
    entities.push(e);
  };

  // 同伴剧中人：别名可含「男主」等，但主名固定
  if (c.surface_name) {
    addEnt({
      id: `char:${c.surface_name}`,
      name: c.surface_name,
      aliases: ['同伴所扮'],
      kind: c.true_kind || 'male_lead',
      gender: 'male',
      relation_to_user: String(c.surface_brief || '').slice(0, 80),
      intro_hint: `${c.surface_name}，${c.surface_brief || '剧中男子'}`,
      know_user: true,
    });
  }

  for (const line of (u.relations || [])) {
    const parsed = parseRelationLine(line);
    if (!parsed) continue;
    addEnt({
      id: `rel:${parsed.name}`,
      name: parsed.name,
      aliases: parsed.aliases,
      kind: 'relation',
      relation_to_user: parsed.rel,
      intro_hint: parsed.rel,
      know_user: true,
    });
  }

  for (const member of (cast || book?.cast_list || [])) {
    if (!member?.name || member.name === name) continue;
    addEnt({
      id: `cast:${member.name}`,
      name: member.name,
      aliases: [],
      kind: member.kind || 'key_npc',
      gender: member.gender === 'male' ? 'male' : 'female',
      relation_to_user: String(member.brief || '').slice(0, 80),
      intro_hint: String(member.brief || '').slice(0, 80),
      know_user: true,
    });
  }

  // 别名互指：主母 ↔ 具体人名（从关系句「王夫人是主母」类）
  mergeAliasPairs(entities);
  lore.entities = entities.slice(0, 36);

  const board = series.resolveIntrigueBoard(book);
  if (board === 'domestic' || board === 'harem') {
    lore.places.push(
      { id: 'inner', name: '内宅', space: 'inner_women', note: '女眷居所，异性无正当名目不得擅入' },
      { id: 'outer', name: '外院/花厅', space: 'outer_guest', note: '可会客' },
    );
  }

  lore.bond = { stage: 0, heat: 0 };
  return lore;
}

function extractOrdinalTitle(text) {
  const t = String(text || '');
  const m = t.match(/(第?[一二三四五六七八九十\d]+小姐|第?[一二三四五六七八九十\d]+公子|嫡长女|嫡次女|庶长女|庶次女|庶出?\s*[一二三四五六七八九十\d]?小姐)/);
  return m ? m[1].replace(/\s+/g, '') : '';
}

function parseRelationLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  // 「林宛是她嫡姐…」/「王夫人（主母）管着…」
  let name = '';
  const aliases = [];
  const m1 = s.match(/^([\u4e00-\u9fff·]{2,8})(?:（([^）]{1,12})）)?/);
  if (m1) {
    name = m1[1];
    if (m1[2]) aliases.push(m1[2]);
  }
  if (!name) {
    const m2 = s.match(/([\u4e00-\u9fff·]{2,8})/);
    if (m2) name = m2[1];
  }
  if (!name) return null;
  // 常见称呼别名
  if (/主母|嫡母/.test(s)) aliases.push('主母', '嫡母');
  if (/贴身丫鬟|贴身婢/.test(s)) aliases.push('贴身丫鬟');
  if (/嫡姐|嫡妹/.test(s)) aliases.push(...(s.match(/嫡[姐妹]/g) || []));
  return { name, aliases: [...new Set(aliases)], rel: s.slice(0, 100) };
}

function mergeAliasPairs(entities) {
  // 若 A 的 aliases 含 B 的 name，或关系文案把两者写成同一人，合并
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      const aAll = [a.name, ...a.aliases];
      const bAll = [b.name, ...b.aliases];
      const overlap = aAll.some((x) => bAll.includes(x));
      const aMentionsB = (a.relation_to_user || '').includes(b.name);
      const bMentionsA = (b.relation_to_user || '').includes(a.name);
      const sameRole = /主母|嫡母/.test(a.relation_to_user + b.relation_to_user)
        && /主母|嫡母/.test(a.name + a.aliases.join('') + b.name + b.aliases.join(''));
      if (overlap || sameRole || (aMentionsB && /主母|嫡母|就是/.test(a.relation_to_user))) {
        // 保留更像人名的为主名
        const keep = /夫人|小姐|公子|氏/.test(a.name) || a.name.length >= b.name.length ? a : b;
        const drop = keep === a ? b : a;
        for (const x of [drop.name, ...drop.aliases]) {
          if (x && !keep.aliases.includes(x) && x !== keep.name) keep.aliases.push(x);
        }
        if (!keep.relation_to_user) keep.relation_to_user = drop.relation_to_user;
        if (!keep.intro_hint) keep.intro_hint = drop.intro_hint;
        entities.splice(entities.indexOf(drop), 1);
        j = i;
      }
    }
  }
}

/* ─── 场景礼仪（按类型的现实空间逻辑） ─── */

const SCENE_SPACES = new Set([
  'inner_women', 'outer_guest', 'public', 'private_meet', 'workplace', 'school', 'other',
]);

function normalizeSceneSpace(s) {
  const v = String(s || '').trim();
  if (SCENE_SPACES.has(v)) return v;
  return detectSceneSpace(v) || 'other';
}

function detectSceneSpace(blob, book = null) {
  const t = String(blob || '');
  const board = book ? series.resolveIntrigueBoard(book) : '';
  if (/内宅|闺阁|厢房|女眷院|西跨院|东院女眷|寝殿|妃宫|六宫|后宅/.test(t)) return 'inner_women';
  if (/花厅|外院|正厅会客|前院|书房会客|外厢/.test(t)) return 'outer_guest';
  if (/密会|翻墙|夜会|私下|无人处|角落低声/.test(t)) return 'private_meet';
  if (/公司|办公室|会议室|工位/.test(t)) return 'workplace';
  if (/教室|校园|宿舍|操场/.test(t)) return 'school';
  if (/街|市集|朝堂|大殿|宴会|酒楼|公场|大观园外/.test(t)) return 'public';
  if (board === 'domestic' || board === 'harem') {
    // 默认宅斗/宫斗主战场偏女眷空间，但不明写则 other，避免误伤
    if (/府|宅|宫/.test(t) && /你|小姐|娘娘/.test(t)) return 'inner_women';
  }
  return 'other';
}

/**
 * 异性同伴是否允许「公开同场」
 * @returns {{ togetherOk: boolean, mode: 'open'|'stealth'|'split', reason: string }}
 */
function companionScenePolicy(book, sceneSpace, { companionGender = 'male', userGender = 'female' } = {}) {
  const space = normalizeSceneSpace(sceneSpace);
  const opposite = companionGender !== userGender;
  const board = series.resolveIntrigueBoard(book);
  const gs = book?.genres || [];

  if (!opposite) {
    return { togetherOk: true, mode: 'open', reason: '同性无额外空间禁忌' };
  }

  if (space === 'inner_women' && (board === 'domestic' || board === 'harem' || /古|朝|府|宫/.test(series.resolveEra(book?.era, book?.era_custom) || ''))) {
    return {
      togetherOk: false,
      mode: 'stealth',
      reason: '女眷私密空间：异性不得公开同场；若来找须传话/密会/避人，被撞见有名节后果',
    };
  }
  if (space === 'private_meet') {
    return {
      togetherOk: true,
      mode: 'stealth',
      reason: '私密密会：可同场但须避人耳目，禁止写成众目睽睽下的正常往来',
    };
  }
  if (space === 'school' && /宿舍/.test(String(book?.era_custom || ''))) {
    return { togetherOk: false, mode: 'split', reason: '异性宿舍不宜公开同场' };
  }
  if (space === 'workplace' && gs.includes('workplace')) {
    return { togetherOk: true, mode: 'open', reason: '职场公开场合可同场，须有公事名目' };
  }
  if (space === 'outer_guest' || space === 'public') {
    return { togetherOk: true, mode: 'open', reason: '公开/会客场合可同场，须符合身份名目' };
  }
  return { togetherOk: true, mode: 'open', reason: '无额外禁忌' };
}

function applySceneEtiquetteToQuest(book, quest, sceneHint = '') {
  const lore = readLore(book);
  const hint = sceneHint || quest?.camera_note || quest?.chapter || '';
  let space = detectSceneSpace(hint, book);
  if (lore.chapter_stage?.scene_space && lore.chapter_stage.scene_space !== 'other') {
    // 已锁定的本章场景优先，除非 hint 明确换场
    if (!/转去|移步|来到|出了|进了/.test(hint)) {
      space = lore.chapter_stage.scene_space;
    }
  }
  const policy = companionScenePolicy(book, space);
  const out = { ...(quest || {}), _scene_space: space, _scene_policy: policy };
  if (!policy.togetherOk && out.together) {
    out.together = false;
  }
  return out;
}

function sceneEtiquettePromptBlock(book, quest = null) {
  const space = quest?._scene_space || readLore(book).chapter_stage?.scene_space || 'other';
  const policy = quest?._scene_policy || companionScenePolicy(book, space);
  const lines = [
    '【场景礼仪·现实逻辑·硬性】',
    `当前空间：${space}｜同伴同场策略：${policy.mode}（${policy.reason}）`,
    '· 同场必须说得通：身份、场合、时代规矩；说不通则分场，同伴走自己的身份线。',
    '· 「闲不住来找用户」可以，但敏感场合只能传话/密会/避人；被原住民发现须有闲话或后果，禁止当没事。',
    '· 禁止为凑对手戏让异性同伴无故出现在禁忌空间。',
  ];
  return lines.join('\n');
}

/* ─── 按需注入世界书 ─── */

function findEntitiesInText(lore, text) {
  const t = String(text || '');
  if (!t) return [];
  const hits = [];
  for (const e of lore.entities || []) {
    const keys = [e.name, ...(e.aliases || [])].filter(Boolean);
    if (keys.some((k) => k.length >= 2 && t.includes(k))) hits.push(e);
  }
  return hits;
}

function formatLorePromptBlock(book, {
  contextText = '',
  chapterNo = 0,
  compact = true,
} = {}) {
  const lore = readLore(book);
  if (!lore.locks.user_title && !(lore.entities || []).length) return '';

  const parts = [];
  parts.push('【剧本世界书·模型专用·禁止改写锁】');
  const lockBits = [];
  if (lore.locks.user_surface_name) lockBits.push(`剧中名=${lore.locks.user_surface_name}`);
  if (lore.locks.user_title) lockBits.push(`开局身份=${lore.locks.user_title}`);
  if (lore.locks.user_ordinal) lockBits.push(`排行名分=${lore.locks.user_ordinal}（禁止改成别的排行，除非 identity_events 已记录变更）`);
  if (lockBits.length) parts.push(`名分锁：${lockBits.join('；')}`);
  if (lore.identity_events?.length) {
    parts.push(`身份变更记录：${lore.identity_events.join('；')}`);
  }

  const stage = lore.chapter_stage || {};
  if (Number(chapterNo) > 0 && Number(stage.chapter_no) === Number(chapterNo)) {
    const present = (stage.on_stage || []).filter((x) => x.status === 'present').map((x) => x.name);
    const left = (stage.on_stage || []).filter((x) => x.status === 'left').map((x) => `${x.name}${x.note ? `(${x.note})` : ''}`);
    parts.push(`本章在场：${present.length ? present.join('、') : '（尚未登记）'}`);
    if (left.length) parts.push(`已离场：${left.join('、')}（禁止无故蒸发后再当陌生人空降）`);
    parts.push(`场景：${stage.scene_space || 'other'}`);
  }

  const related = findEntitiesInText(lore, contextText);
  // 常驻：关系网里与用户强相关的前几人（贴身/父母/主母）
  const anchors = (lore.entities || []).filter((e) =>
    /贴身|丫鬟|主母|嫡母|父母|母亲|父亲|嫡姐|嫡妹|未婚夫|未婚夫/.test(`${e.relation_to_user}${e.aliases.join('')}${e.kind}`)
  ).slice(0, 4);
  const show = [];
  const seen = new Set();
  for (const e of [...related, ...anchors]) {
    if (seen.has(e.id || e.name)) continue;
    seen.add(e.id || e.name);
    show.push(e);
    if (show.length >= (compact ? 8 : 14)) break;
  }
  if (show.length) {
    parts.push('人物卡（别名=同一人，禁止拆成两个人）：');
    for (const e of show) {
      const al = e.aliases?.length ? `｜别名:${e.aliases.join('、')}` : '';
      parts.push(`- ${e.name}${al}｜${e.relation_to_user || e.intro_hint || e.kind}`);
    }
  }

  const needIntro = show.filter((e) =>
    e.know_user && e.intro_hint
    && !(stage.introduced_ids || []).includes(e.id)
    && !(stage.introduced_ids || []).includes(e.name)
  );
  if (needIntro.length) {
    parts.push('【出场回忆·硬性】以下是用户所扮角色本就认识、但本场尚未介绍过的人；其首次（或本章首次）出场时，用「你脑海里突然想起来……」轻带与用户关系一句，禁止说明书体括号堆设定；次要路人不要介绍；已介绍过的禁止重复「突然想起」。');
    for (const e of needIntro.slice(0, 5)) {
      parts.push(`· ${e.name} → ${e.intro_hint}`);
    }
  }

  if (lore.bond && (lore.bond.stage > 0 || lore.bond.heat > 0)) {
    parts.push(`感情阶梯：stage=${lore.bond.stage}/5 heat=${lore.bond.heat}（只允许缓慢递增，禁止无铺垫跳级表白/热恋）`);
  }

  return parts.join('\n');
}

function markIntroduced(lore, namesOrIds = []) {
  const ids = lore.chapter_stage.introduced_ids || [];
  for (const n of namesOrIds) {
    const s = String(n || '').trim();
    if (!s) continue;
    if (!ids.includes(s)) ids.push(s);
    const ent = (lore.entities || []).find((e) => e.name === s || e.id === s || (e.aliases || []).includes(s));
    if (ent && !ids.includes(ent.id)) ids.push(ent.id);
  }
  lore.chapter_stage.introduced_ids = ids.slice(0, 40);
  return lore;
}

function updateChapterStage(lore, {
  chapterNo,
  sceneSpace,
  onStageDelta,
  resetOnStage = false,
} = {}) {
  if (chapterNo != null) {
    if (Number(lore.chapter_stage.chapter_no) !== Number(chapterNo) || resetOnStage) {
      lore.chapter_stage.chapter_no = Number(chapterNo) || 0;
      if (resetOnStage) lore.chapter_stage.on_stage = [];
    }
  }
  if (sceneSpace) lore.chapter_stage.scene_space = normalizeSceneSpace(sceneSpace);
  if (Array.isArray(onStageDelta)) {
    for (const d of onStageDelta) {
      const name = String(d.name || '').trim();
      if (!name) continue;
      const status = d.status === 'left' ? 'left' : 'present';
      const note = String(d.note || '').trim().slice(0, 80);
      const list = lore.chapter_stage.on_stage;
      const hit = list.find((x) => x.name === name);
      if (hit) {
        hit.status = status;
        if (note) hit.note = note;
      } else {
        list.push({ id: name, name, status, note });
      }
    }
    lore.chapter_stage.on_stage = lore.chapter_stage.on_stage.slice(0, 16);
  }
  return lore;
}

function syncLoreAfterProse(bookId, book, prose, { chapterNo, sceneHint } = {}) {
  let lore = readLore(book);
  if (!lore.locks.user_title && !(lore.entities || []).length) {
    lore = buildLoreFromIdentity(book);
  }
  const space = detectSceneSpace(`${sceneHint || ''}\n${prose || ''}`, book);
  const mentioned = findEntitiesInText(lore, prose).map((e) => e.name);
  const delta = mentioned.map((name) => ({ name, status: 'present' }));
  updateChapterStage(lore, { chapterNo, sceneSpace: space, onStageDelta: delta });
  // 正文里出现「脑海里…想起」则记已介绍
  const introduced = [];
  for (const e of lore.entities || []) {
    const keys = [e.name, ...(e.aliases || [])];
    if (keys.some((k) => k && prose.includes(k)) && /脑海|想起|记起|记得/.test(prose)) {
      introduced.push(e.id || e.name);
    } else if (keys.some((k) => k && prose.includes(k)) && Number(chapterNo) === 1) {
      // 第一章露脸也算可介绍过，避免每段都「突然想起」
      if (new RegExp(`${keys.map(escapeRegExp).join('|')}.{0,20}(是你|你的|嫡|庶|丫鬟|主母)`).test(prose)) {
        introduced.push(e.id || e.name);
      }
    }
  }
  markIntroduced(lore, introduced);
  return saveLore(bookId, lore);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─── 向量 / 检索记忆（公共 embed-helper） ─── */

async function ensureMemoryEmbedding(row, settings) {
  if (!row?.id) return null;
  const existing = parseStoredEmbedding(row.embedding);
  if (existing?.vec?.length) return existing;
  const emb = await embedText(row.content, settings);
  try {
    db.prepare(`UPDATE series_memories SET embedding=? WHERE id=?`)
      .run(JSON.stringify(emb), row.id);
  } catch (_) { /* column may miss on old db mid-migration */ }
  return emb;
}

/**
 * 选取注入 prompt 的穿越记忆：
 * - 身份认知置顶：常驻（不走向量淘汰）
 * - 其余：向量/词法 Top-K + 关键词命中兜底
 * 与「世界书名分锁」不冲突：记忆不改写 locks。
 */
async function selectIsekaiMemoriesForPrompt(bookId, queryText, {
  topK = 5,
  settings = null,
} = {}) {
  const s = settings || series.getSettings();
  let pinned = [];
  let soft = [];
  try {
    pinned = db.prepare(`
      SELECT id, content, chapter_no, kind, pinned, embedding FROM series_memories
      WHERE book_id=? AND (pinned=1 OR kind='identity')
      ORDER BY id DESC LIMIT 16
    `).all(bookId);
    soft = db.prepare(`
      SELECT id, content, chapter_no, kind, pinned, embedding FROM series_memories
      WHERE book_id=? AND pinned=0 AND kind!='identity'
      ORDER BY id DESC LIMIT 80
    `).all(bookId);
  } catch (_) {
    pinned = db.prepare(`
      SELECT id, content, chapter_no, kind, pinned FROM series_memories
      WHERE book_id=? AND (pinned=1 OR kind='identity')
      ORDER BY id DESC LIMIT 16
    `).all(bookId);
    soft = db.prepare(`
      SELECT id, content, chapter_no, kind, pinned FROM series_memories
      WHERE book_id=? AND pinned=0 AND kind!='identity'
      ORDER BY id DESC LIMIT 40
    `).all(bookId);
  }

  const qEmb = await embedText(queryText || '', s);
  // 语料用整本书的设定条目，专有名词才拿得到高 idf，通用描述被压平
  const corpus = buildCorpusDf([...hard, ...soft].map((r) => r.content));
  const softScores = scoreTextsAgainst(queryText || '', soft, { queryEmb: qEmb, corpus });
  const scored = soft.map((row, i) => ({ row, score: softScores[i] || 0 }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score || 0;
  const picked = scored
    .filter((x) => passRelevance(x.score, top, { floor: 0.18 }))
    .slice(0, topK)
    .map((x) => x.row);

  // 后台补全 embedding（不阻塞）
  Promise.resolve().then(async () => {
    for (const row of picked.slice(0, 3)) {
      try { await ensureMemoryEmbedding(row, s); } catch (_) { /* ignore */ }
    }
  }).catch(() => {});

  return { pinned, related: picked };
}

function formatMemoryRetrievalBlock(pinned, related) {
  const fmt = (rows, label) => {
    if (!rows?.length) return '';
    return `${label}\n${rows.map((r) => `- [第${r.chapter_no || '?'}章·${r.kind || 'plot'}] ${r.content}`).join('\n')}`;
  };
  const parts = [];
  const p = fmt(pinned, '【身份认知·置顶·不可遗忘】');
  const r = fmt(related, '【相关剧情记忆·检索】');
  if (p) parts.push(p);
  if (r) parts.push(r);
  if (!parts.length) return '';
  return `【穿越记忆库·检索注入】\n${parts.join('\n')}`;
}

/** 用户身份卡开局身份行：写清「是什么人」 */
function formatOpeningIdentityLine(userSlot, book = null) {
  const name = String(userSlot?.surface_name || book?.user_role || '').trim() || '？';
  const brief = String(userSlot?.surface_brief || book?.user_surface_brief || '').trim();
  const ordinal = extractOrdinalTitle(`${name} ${brief}`);
  const bits = [name];
  if (brief) bits.push(brief);
  else if (ordinal) bits.push(ordinal);
  return bits.join(' · ');
}

module.exports = {
  emptyLore,
  readLore,
  saveLore,
  buildLoreFromIdentity,
  formatLorePromptBlock,
  syncLoreAfterProse,
  updateChapterStage,
  markIntroduced,
  detectSceneSpace,
  companionScenePolicy,
  applySceneEtiquetteToQuest,
  sceneEtiquettePromptBlock,
  selectIsekaiMemoriesForPrompt,
  formatMemoryRetrievalBlock,
  embedText,
  ensureMemoryEmbedding,
  formatOpeningIdentityLine,
  extractOrdinalTitle,
  findEntitiesInText,
};

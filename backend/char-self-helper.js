/** 角色自我认知：怎么看待自己的习惯 / 喜好 / 经历。角色卡是起点，相处会往上长。 */
const db = require('./db');

const SELF_CATEGORIES = ['行为习惯', '喜好', '经历', '性格', '变化', '其他'];
const MAX_PER_CAT = 10;
const MAX_LIVED_PER_CAT = 4;
const PROMPT_PER_CAT = { 行为习惯: 3, 喜好: 3, 经历: 2 };
const PROMPT_MAX = 8;
const CONTENT_MAX = 36;
const AUTO_STRENGTH_STEP = 0.1;
const NEW_LIVED_STRENGTH = 0.28;
const CONFIRM_STRENGTH = 0.62;
const CARD_TO_LIVED_STRENGTH = 0.72;
const REWRITE_STRENGTH = 0.85;
const LIVED_INSERT_COOLDOWN_DAYS = 3;
const LIVED_INSERT_WEEK_CAP = 2;
const PROMPT_UNCONFIRMED_MIN = 0.22;

const LEGACY_CAT_MAP = {
  习惯: '行为习惯',
  爱好: '喜好',
  喜欢: '喜好',
  不喜欢: '喜好',
  经验: '经历',
  性格: '性格',
  变化: '变化',
  其他: '其他',
};

function ensureSelfViewsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS char_self_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT '行为习惯',
      keywords TEXT DEFAULT '[]',
      source TEXT DEFAULT 'lived',
      auto_generated INTEGER DEFAULT 0,
      confirmed INTEGER DEFAULT 1,
      strength REAL DEFAULT 0.6,
      evidence_ids TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_char_self_views_char ON char_self_views(character_id)`);
}

function normalizeSelfCategory(cat) {
  const c = String(cat || '').trim();
  if (SELF_CATEGORIES.includes(c)) return c;
  if (LEGACY_CAT_MAP[c]) return LEGACY_CAT_MAP[c];
  if (/性格|脾气|气质/.test(c)) return '性格';
  if (/变化|变了|改变/.test(c)) return '变化';
  if (/习惯|作息|熬夜|早起|总是|经常/.test(c)) return '行为习惯';
  if (/喜|爱|讨厌/.test(c)) return '喜好';
  if (/经历|往事|关系|相处/.test(c)) return '经历';
  return '';
}

function parseKeywords(raw, content = '') {
  let kws = [];
  if (Array.isArray(raw)) kws = raw;
  else if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw || '[]');
      kws = Array.isArray(p) ? p : String(raw).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    } catch {
      kws = String(raw).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  const text = String(content || '').replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
  const seen = new Set();
  const out = [];
  const push = (k) => {
    const s = String(k || '').trim().slice(0, 20);
    if (!s || s.length < 2) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const k of kws) push(k);
  if (text.length >= 2 && text.length <= 16) push(text);
  const core = text
    .replace(/^(很|比较|特别|非常|有点|开始|渐渐)?(喜欢|爱吃|讨厌|习惯于?|总是|经常)/, '')
    .trim();
  if (core && core.length >= 2) push(core);
  return out.slice(0, 8);
}

function toSelfFact(s) {
  return String(s || '')
    .replace(/（\?）\s*$/, '')
    .replace(/\(\?\)\s*$/, '')
    .replace(/^[-・•]\s*/, '')
    .replace(/^自己(其实|也|会)?/, '我$1')
    .trim()
    .slice(0, CONTENT_MAX);
}

function isJunkSelfFact(s) {
  const t = String(s || '').trim();
  if (t.length < 2) return true;
  if (/^(清晨|上午|中午|下午|傍晚|晚上|夜里|夜深了|凌晨)$/.test(t)) return true;
  if (/^[\d\s:：\-./点分秒年月日期]+$/.test(t)) return true;
  if (/(AI|模型|扮演|系统提示|角色卡规定)/i.test(t)) return true;
  try {
    if (require('./portrait-cluster-helper').looksLikeEventFact(t)) return true;
  } catch { /* ignore */ }
  return false;
}

function factsSimilar(a, b) {
  const x = String(a || '').replace(/\s/g, '').replace(/（\?）$/, '');
  const y = String(b || '').replace(/\s/g, '').replace(/（\?）$/, '');
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

function todayToken() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function parseEvidence(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean).slice(0, 16);
  try {
    const p = JSON.parse(raw || '[]');
    return Array.isArray(p) ? p.map(String).filter(Boolean).slice(0, 16) : [];
  } catch {
    return [];
  }
}

function daysSince(iso) {
  const s = String(iso || '').trim();
  if (!s) return 999;
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  if (!Number.isFinite(t)) return 999;
  return (Date.now() - t) / 86400000;
}

function listSelfViews(characterId) {
  ensureSelfViewsTable();
  if (!characterId) return [];
  try {
    const cluster = require('./portrait-cluster-helper');
    cluster.ensureClusterColumns();
    cluster.compactPortraitCards(characterId, 'char_self_views');
    return db.prepare(
      `SELECT * FROM char_self_views WHERE character_id=? ORDER BY id DESC`
    ).all(characterId).map((r) => {
      const decorated = cluster.decorateCardRow(r, 'char_self_views');
      return {
        ...decorated,
        category: normalizeSelfCategory(r.category) || r.category || '行为习惯',
        keywords: parseKeywords(r.keywords, r.content),
        confirmed: r.confirmed !== 0 && r.confirmed !== '0',
        auto_generated: !!(r.auto_generated && r.auto_generated !== '0'),
        source: ['card', 'lived', 'manual'].includes(r.source) ? r.source : 'lived',
      };
    });
  } catch {
    return [];
  }
}

function insertSelfView(characterId, item = {}) {
  ensureSelfViewsTable();
  const cid = Number(characterId);
  const merged = mergeSelfViewItems(cid, [{ ...item, source: item.source || 'manual' }], {
    source: item.source || 'manual',
    mode: 'seed',
  });
  if (!merged) throw new Error('content required');
  const last = db.prepare('SELECT id FROM char_self_views WHERE character_id=? ORDER BY id DESC LIMIT 1').get(cid);
  return last?.id;
}

function updateSelfView(id, patch = {}) {
  ensureSelfViewsTable();
  const cluster = require('./portrait-cluster-helper');
  cluster.ensureClusterColumns();
  const row = db.prepare('SELECT * FROM char_self_views WHERE id=?').get(id);
  if (!row) return null;
  let facts = cluster.cardFacts(row);
  if (patch.content != null) {
    facts = String(patch.content).split(/\n/).map((s) => toSelfFact(s)).filter((s) => s && !isJunkSelfFact(s));
  }
  if (Array.isArray(patch.related_facts)) {
    facts = cluster.uniqueFacts([...facts, ...patch.related_facts]);
  }
  facts = cluster.uniqueFacts(facts);
  let ctx = null;
  try {
    ctx = cluster.getVoiceCtx(row.character_id);
    ctx.voice = 'self';
    facts = cluster.uniqueFacts(facts.map((f) => cluster.rewriteVoice(f, ctx)));
  } catch { /* ignore */ }
  let content = facts[0] || toSelfFact(patch.content) || String(row.content || '');
  let confirmed = patch.confirmed != null ? (patch.confirmed ? 1 : 0) : (row.confirmed ? 1 : 0);
  if (patch.confirmed === true || patch.confirmed === 1) {
    facts = facts.map((f) => f.replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim());
    content = (facts[0] || content).replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
    confirmed = 1;
  } else if (patch.confirmed === false || patch.confirmed === 0) {
    confirmed = 0;
  }
  const category = normalizeSelfCategory(patch.category ?? row.category) || row.category;
  const subcategory = '';
  let note = patch.note != null ? String(patch.note).trim().slice(0, 36) : (row.note || '');
  if (ctx) {
    try { note = cluster.rewriteNote(note, ctx); } catch { /* ignore */ }
  }
  const source = ['card', 'lived', 'manual'].includes(patch.source) ? patch.source : row.source;
  const baseKws = patch.keywords != null ? patch.keywords : row.keywords;
  const kws = JSON.stringify(parseKeywords(baseKws, content));
  db.prepare(
    `UPDATE char_self_views SET content=?, related_facts=?, category=?, subcategory=?, note=?, keywords=?, source=?, confirmed=?, topic_key=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    content, JSON.stringify(facts.slice(1)), category, subcategory, note, kws, source, confirmed,
    cluster.topicKeyOf(facts.join('、')), id
  );
  return { ok: true, confirmed, content, category, subcategory, note };
}

function deleteSelfView(id) {
  ensureSelfViewsTable();
  db.prepare('DELETE FROM char_self_views WHERE id=?').run(id);
  return { ok: true };
}

function trimCategory(charId, category) {
  const rows = db.prepare(
    `SELECT id, source, confirmed, strength FROM char_self_views WHERE character_id=? AND category=?`
  ).all(charId, category);
  const sticky = [];
  const lived = [];
  for (const r of rows) {
    if (r.source === 'card' || r.source === 'manual') sticky.push(r);
    else lived.push(r);
  }
  lived.sort((a, b) => {
    const sa = (Number(a.strength) || 0) + (a.confirmed ? 0.2 : 0);
    const sb = (Number(b.strength) || 0) + (b.confirmed ? 0.2 : 0);
    if (sa !== sb) return sa - sb;
    return a.id - b.id;
  });
  const drop = [];
  if (lived.length > MAX_LIVED_PER_CAT) {
    drop.push(...lived.slice(0, lived.length - MAX_LIVED_PER_CAT));
  }
  const remainLived = lived.length - drop.length;
  const overflow = sticky.length + remainLived - MAX_PER_CAT;
  if (overflow > 0) {
    const extra = lived.filter((r) => !drop.includes(r)).slice(0, overflow);
    drop.push(...extra);
  }
  if (!drop.length) return;
  db.prepare(`DELETE FROM char_self_views WHERE id IN (${drop.map(() => '?').join(',')})`).run(...drop.map((r) => r.id));
}

function canInsertLived(charId, cat, mode) {
  if (mode === 'seed') return true;
  const livedN = db.prepare(
    `SELECT COUNT(*) AS n FROM char_self_views WHERE character_id=? AND category=? AND source='lived'`
  ).get(charId, cat)?.n || 0;
  if (livedN >= MAX_LIVED_PER_CAT) return false;
  const weekN = db.prepare(
    `SELECT COUNT(*) AS n FROM char_self_views
     WHERE character_id=? AND source='lived' AND auto_generated=1
       AND created_at >= datetime('now', '-7 days')`
  ).get(charId)?.n || 0;
  if (weekN >= LIVED_INSERT_WEEK_CAP) return false;
  const last = db.prepare(
    `SELECT created_at FROM char_self_views
     WHERE character_id=? AND category=? AND source='lived' AND auto_generated=1
     ORDER BY id DESC LIMIT 1`
  ).get(charId, cat);
  if (last && daysSince(last.created_at) < LIVED_INSERT_COOLDOWN_DAYS) return false;
  if (mode === 'auto') {
    const today = todayToken();
    const todayN = db.prepare(
      `SELECT COUNT(*) AS n FROM char_self_views
       WHERE character_id=? AND source='lived' AND auto_generated=1
         AND substr(created_at,1,10)=?`
    ).get(charId, today)?.n || 0;
    if (todayN >= 1) return false;
  }
  return true;
}

function reinforceSelfView(hit, { fact, cat, incomingSource, evidenceToken, allowRewrite }) {
  const row = db.prepare('SELECT * FROM char_self_views WHERE id=?').get(hit.id);
  if (!row) return false;
  const ev = parseEvidence(row.evidence_ids);
  let strength = Number(row.strength) || 0.4;
  let changed = false;
  if (evidenceToken && !ev.includes(String(evidenceToken))) {
    ev.push(String(evidenceToken));
    strength = Math.min(1, strength + AUTO_STRENGTH_STEP);
    changed = true;
  }
  let confirmed = row.confirmed ? 1 : 0;
  if (!confirmed && strength >= CONFIRM_STRENGTH && ev.length >= 2) {
    confirmed = 1;
    changed = true;
  }
  let src = row.source;
  let content = String(row.content || '');
  const bareNew = String(fact || '').replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
  if (src === 'card' && incomingSource === 'lived') {
    if (strength >= CARD_TO_LIVED_STRENGTH && ev.length >= 3) {
      src = 'lived';
      changed = true;
      if (allowRewrite && confirmed && bareNew) content = confirmed ? bareNew : `${bareNew}（?）`;
    }
  } else if (src === 'lived' && allowRewrite && confirmed && strength >= REWRITE_STRENGTH && ev.length >= 4 && bareNew) {
    const next = confirmed ? bareNew : `${bareNew}（?）`;
    if (next !== content) {
      content = next;
      changed = true;
    }
  }
  if (confirmed && /（\?）/.test(content)) {
    content = content.replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
    changed = true;
  }
  if (!changed) return false;
  const kws = JSON.stringify(parseKeywords(row.keywords, content));
  db.prepare(
    `UPDATE char_self_views SET content=?, category=?, source=?, confirmed=?, strength=?, keywords=?, evidence_ids=?, updated_at=datetime('now') WHERE id=?`
  ).run(content, cat || row.category, src, confirmed, strength, kws, JSON.stringify(ev.slice(0, 16)), hit.id);
  hit.content = content;
  hit.source = src;
  hit.category = cat || row.category;
  return true;
}

function mergeSelfViewItems(charId, items, { source = 'lived', mode = 'auto' } = {}) {
  ensureSelfViewsTable();
  if (!charId || !items?.length) return 0;
  const cluster = require('./portrait-cluster-helper');
  cluster.ensureClusterColumns();
  let merged = 0;
  const slow = mode === 'auto' || mode === 'generate';

  for (const it of items) {
    const cat = normalizeSelfCategory(it.category);
    if (!cat) continue;
    const facts = String(it.content || '')
      .split(/[；;\n]/)
      .map((s) => toSelfFact(s))
      .filter((s) => s.length >= 2 && !isJunkSelfFact(s));
    const note = String(it.note || '').trim();
    const rowSource = ['card', 'lived', 'manual'].includes(it.source) ? it.source : source;
    if (it.bundle) {
      const absorbs = facts.some((f) => cluster.wouldAbsorb('char_self_views', charId, cat, f));
      if (!absorbs && rowSource === 'lived' && slow && !canInsertLived(charId, cat, mode)) continue;
      const r = cluster.upsertPortraitCard({
        table: 'char_self_views',
        charId,
        major: cat,
        subcategory: it.subcategory || cluster.guessSubcategory(cat, facts.join('、'), 'char_self_views'),
        facts,
        note,
        keywords: parseKeywords(it.keywords, facts.join('、')),
        confirmed: it.confirmed === 0 || it.confirmed === false || (slow && rowSource === 'lived') ? 0 : 1,
        extra: {
          forceBundle: true,
          source: rowSource,
          auto_generated: it.auto_generated != null ? (it.auto_generated ? 1 : 0) : (rowSource === 'manual' ? 0 : 1),
          strength: rowSource === 'lived' && slow ? NEW_LIVED_STRENGTH : (Number(it.strength) || 0.5),
        },
      });
      if (r === 'inserted' || r === 'appended') merged++;
      continue;
    }
    for (const fact0 of facts) {
      let confirmed = it.confirmed === 0 || it.confirmed === false ? 0 : 1;
      let fact = fact0.replace(/（\?）\s*$/, '').replace(/\(\?\)\s*$/, '').trim();
      if (/好像|或许|大概|似乎|可能|猜测/.test(fact)) confirmed = 0;
      if (slow && rowSource === 'lived') confirmed = 0;
      const absorbs = cluster.wouldAbsorb('char_self_views', charId, cat, fact);
      if (!absorbs && rowSource === 'lived' && slow && !canInsertLived(charId, cat, mode)) continue;
      const r = cluster.upsertPortraitCard({
        table: 'char_self_views',
        charId,
        major: cat,
        subcategory: it.subcategory || cluster.guessSubcategory(cat, fact, 'char_self_views'),
        fact,
        note,
        keywords: parseKeywords(it.keywords, fact),
        confirmed,
        extra: {
          source: rowSource,
          auto_generated: it.auto_generated != null ? (it.auto_generated ? 1 : 0) : (rowSource === 'manual' ? 0 : 1),
          strength: rowSource === 'lived' && slow ? NEW_LIVED_STRENGTH : (Number(it.strength) || 0.5),
        },
      });
      if (r === 'inserted' || r === 'appended') merged++;
      if (mode === 'auto' && rowSource === 'lived' && r === 'inserted') return merged;
    }
  }
  try { cluster.compactPortraitCards(charId, 'char_self_views'); } catch { /* ignore */ }
  try {
    const tree = require('./memory-tree-helper');
    for (const it of items) {
      const cat = normalizeSelfCategory(it.category);
      if (cat) tree.touchPortraitCategory(charId, 'self', cat, { charge: 0.25 });
    }
    if (merged) tree.syncPortraitFromCards(charId, 'self');
  } catch (e) {
    console.warn('[self-views] tree sync', e.message);
  }
  return merged;
}

function guessSelfCategory(content) {
  const t = String(content || '');
  if (/经历|这段|相处|关系里|认识后|在一起后|让自己|变得/.test(t)) return '经历';
  if (/以前会|现在会|开始会|变得更|变了/.test(t)) return '变化';
  if (/性格|脾气|内向|外向|敏感|慢热|别扭|嘴硬|好强|想很多|纠结|内耗/.test(t)) return '性格';
  if (/喜欢|爱吃|爱喝|爱看|爱玩|讨厌|不喜欢|爱听/.test(t)
    && !/(喜欢|不喜欢).{0,2}(被|别人|人家)/.test(t)) return '喜好';
  if (/习惯|总是|经常|每天|熬夜|早起|一般会|开始会/.test(t)) return '行为习惯';
  return '性格';
}

function parseSelfViewLines(text) {
  const items = [];
  let last = null;
  for (const line of String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const noteLine = line.match(/^(?:我|TA|感想)\s*[：:]\s*(.+)$/);
    if (noteLine && last) {
      last.note = toSelfFact(noteLine[1]);
      continue;
    }
    const tagged = line.match(/^[【\[]([^】\]]{1,16})[】\]]\s*[：:]?\s*(.+)$/);
    const coloned = !tagged && line.match(/^([\u4e00-\u9fff]{2,8})[：:]\s*(.+)$/);
    let cat = '';
    let cont = '';
    if (tagged || coloned) {
      const m = tagged || coloned;
      const rawCat = String(m[1] || '');
      const parts = rawCat.split(/[·・]/);
      cat = normalizeSelfCategory(parts[0]) || guessSelfCategory(m[2]);
      cont = toSelfFact(m[2]);
    } else {
      cont = toSelfFact(line.replace(/^[・\-–]\s*/, ''));
      cat = guessSelfCategory(cont);
    }
    if (!cont || isJunkSelfFact(cont) || cont.length > CONTENT_MAX + 4) continue;
    last = { category: cat, subcategory: '', content: cont.slice(0, CONTENT_MAX), keywords: [], source: 'lived' };
    items.push(last);
  }
  return items.slice(0, 8);
}

function selfViewItemsFromMemories(parsed, memoryItems, charName = '') {
  const items = [];
  for (const sv of parsed?.self_views || []) {
    const cat = normalizeSelfCategory(sv.category) || guessSelfCategory(sv.content);
    const content = toSelfFact(sv.content);
    if (!cat || !content || isJunkSelfFact(content)) continue;
    const related = Array.isArray(sv.related_facts) ? sv.related_facts : [];
    const blob = [content, ...related.map((x) => toSelfFact(x)).filter(Boolean)].join('\n');
    items.push({
      category: cat,
      subcategory: sv.subcategory || '',
      content: blob,
      note: sv.note || '',
      keywords: sv.keywords || [],
      source: 'lived',
      confirmed: 0,
      bundle: related.length > 0,
    });
  }
  return items.slice(0, 1);
}

/**
 * 聊天常驻一小段「现在的自己」。相处长出的条目优先，角色卡起点作底。
 */
function formatSelfViewsForPrompt(charId) {
  const rows = listSelfViews(charId);
  if (!rows.length) return '';
  const rank = (r) => {
    let s = Number(r.strength) || 0.5;
    if (r.source === 'lived') s += 2;
    else if (r.source === 'manual') s += 1.2;
    if (r.confirmed) s += 0.4;
    return s;
  };
  const picked = [];
  const perCat = {};
  const seen = new Set();
  const sorted = [...rows].sort((a, b) => rank(b) - rank(a));
  for (const row of sorted) {
    const cat = normalizeSelfCategory(row.category);
    if (!cat) continue;
    const text = toSelfFact(row.content);
    if (!text || isJunkSelfFact(text)) continue;
    const facts = (row.facts && row.facts.length) ? row.facts : [text];
    const key = facts[0].slice(0, 20);
    if (seen.has(key)) continue;
    if (!row.confirmed && (Number(row.strength) || 0) < PROMPT_UNCONFIRMED_MIN) continue;
    if ((perCat[cat] || 0) >= (PROMPT_PER_CAT[cat] || 3)) continue;
    seen.add(key);
    perCat[cat] = (perCat[cat] || 0) + 1;
    picked.push({ cat, sub: row.subcategory || '', facts, note: row.note || '', source: row.source, confirmed: !!row.confirmed });
    if (picked.length >= PROMPT_MAX) break;
  }
  if (!picked.length) return '';
  const lived = picked.some((p) => p.source === 'lived' || p.source === 'manual');
  let call = '';
  try { call = require('./portrait-cluster-helper').getVoiceCtx(charId).userCall || ''; } catch { call = ''; }
  const lines = SELF_CATEGORIES
    .map((cat) => {
      const bits = picked.filter((p) => p.cat === cat).map((p) => {
        const head = `【${cat}】`;
        const body = (p.facts || []).map((t) => `・${t}${p.confirmed ? '' : '（?）'}`).join('\n');
        const note = p.note ? `\n我：${p.note}` : '';
        return `${head}\n${body}${note}`;
      });
      return bits.length ? bits.join('\n') : '';
    })
    .filter(Boolean);
  const nickLock = call ? `提到对方只用「${call}」，不要写自己的本名。` : '提到对方只用一种昵称，不要写自己的本名。';
  const head = lived
    ? `【自我认知】这就是你现在对自己的认识，说话时按这个来，不要当清单念。${nickLock}带（?）的只是苗头。习惯很难改。`
    : `【自我认知】用第一人称「我」记。${nickLock}目前多半还停在角色卡的起点，不要整段复述人物介绍。`;
  return `${head}\n${lines.join('\n')}`;
}

function collectGenerateMaterials(charId) {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(charId);
  if (!char) return null;
  let traits = [];
  try {
    traits = require('./char-trait-helper').listTraits(charId).filter((t) => t.enabled !== false);
  } catch { traits = []; }
  const existing = listSelfViews(charId);
  const prefs = db.prepare(
    `SELECT content FROM memories WHERE character_id=? AND category='偏好与习惯' AND (archived IS NULL OR archived=0)
     ORDER BY id DESC LIMIT 10`
  ).all(charId);
  let stories = [];
  try {
    stories = db.prepare(
      `SELECT title, content FROM memory_narratives WHERE character_id=? AND (fallen_at IS NULL OR fallen_at='')
       ORDER BY id DESC LIMIT 5`
    ).all(charId);
  } catch { stories = []; }
  return { char, traits, existing, prefs, stories };
}

function buildGenerateUserMessage(char, settings, history, materials) {
  const name = char.name;
  const user = settings.username || '旅人';
  let portraitCall = user;
  try {
    portraitCall = require('./portrait-cluster-helper').unifiedUserCall(
      char, settings, (history || []).filter((m) => m.role === 'assistant')
    );
  } catch { /* ignore */ }
  const traitLines = (materials.traits || []).map((t) => `- [${t.category}] ${t.content}`).join('\n');
  const existLines = (materials.existing || []).slice(0, 16)
    .map((r) => {
      const facts = (r.facts && r.facts.length) ? r.facts : [toSelfFact(r.content)];
      const tag = r.category;
      return `- [${tag}/${r.source === 'card' ? '角色卡' : '相处'}] ${facts.join('；')}${r.note ? ` / 我：${r.note}` : ''}`;
    })
    .join('\n');
  const prefLines = (materials.prefs || []).map((p) => String(p.content || '').slice(0, 80)).join('\n');
  const storyLines = (materials.stories || []).map((s) => `- ${s.title || ''}：${String(s.content || '').slice(0, 60)}`).join('\n');
  const chatStr = (history || []).map((m) =>
    `${m.role === 'user' ? portraitCall : name}：${String(m.content || '').replace(/^【自动回复】/, '').slice(0, 200)}`
  ).join('\n');

  return `整理「${name}」此刻怎么看自己。角色卡是起点，相处会带来变化——但人物介绍里已经有的性格形容词不要再抄一遍。

【角色卡·起点】
性格：${String(char.personality || '').slice(0, 220)}
行为模式：${String(char.behavior || '').slice(0, 220)}
背景：${String(char.background || '').slice(0, 180)}
${traitLines ? `喜好与擅长：\n${traitLines}` : ''}

${existLines ? `【已有自我认知】\n${existLines}` : '【已有自我认知】还没有'}

${prefLines ? `【偏好记忆摘录】\n${prefLines}` : ''}
${storyLines ? `【记忆点摘录】\n${storyLines}` : ''}

对话：
${chatStr || '（对话很少，主要从角色卡抽出具体喜好/习惯，不要抄性格段）'}

每条单独一行，格式严格：【大类】短句
大类只能是：性格、行为习惯、喜好、经历、变化
不要再写小类。意思重复的只留一条。相关联的不要拆成多张卡。感想单独一行：TA：……

硬规则：
· 用第一人称「我」；提到用户只用「${portraitCall}」，不要换称呼
· 提到「${name}」一律写 TA，不要写角色本名
· 每条 8～24 字；最多 6 条；没把握就不写
· 只写具体事实（爱喝什么、作息、某段相处后的变化），禁止「我性格温柔」「我很特别」这类空话
· 习惯很难改：一次对话、一次整理都长不出一堆新习惯
· 已有自我认知能对上的，不要另写一条
· 禁止：用户侧画像、单次心情、日期时段、具体事件经过、AI/扮演字样`;
}

async function generateSelfViews(charId, settings, callChatAPIComplete) {
  const materials = collectGenerateMaterials(charId);
  if (!materials) throw new Error('角色不存在');
  const history = db.prepare(
    `SELECT role, content, type FROM messages WHERE character_id=? AND is_dream=0 AND recalled=0
     AND (type IS NULL OR type IN ('text','voice')) ORDER BY id DESC LIMIT 40`
  ).all(charId).reverse();
  const sysPrompt = `你在整理角色「${materials.char.name}」的自我认知。只输出短句标签，不要扮演聊天。`;
  const userMsg = buildGenerateUserMessage(materials.char, settings, history, materials);
  let raw = '';
  try { raw = await callChatAPIComplete(settings, sysPrompt, userMsg, 'memory'); } catch {}
  if (!raw) {
    raw = await callChatAPIComplete(settings, sysPrompt, userMsg, 'chat');
  }
  if (!raw) throw new Error('AI 未返回内容');
  const items = parseSelfViewLines(raw);
  if (!items.length) return { merged: 0, items: [], content: raw };
  const empty = !(materials.existing || []).length;
  const tagged = items.map((it) => ({
    ...it,
    source: empty ? 'card' : 'lived',
    confirmed: empty ? 1 : 0,
  }));
  const merged = mergeSelfViewItems(charId, tagged, {
    source: empty ? 'card' : 'lived',
    mode: empty ? 'seed' : 'generate',
  });
  return { merged, items: tagged, content: raw };
}

module.exports = {
  SELF_CATEGORIES,
  ensureSelfViewsTable,
  normalizeSelfCategory,
  listSelfViews,
  insertSelfView,
  updateSelfView,
  deleteSelfView,
  mergeSelfViewItems,
  parseSelfViewLines,
  selfViewItemsFromMemories,
  formatSelfViewsForPrompt,
  generateSelfViews,
};

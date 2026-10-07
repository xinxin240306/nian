/**
 * 现实地图下的城市化名：只化城市，路/区/店用真名。
 * 保存角色时生成「地理对照」世界书并绑到该角色。
 */

function parseAliasList(raw) {
  if (Array.isArray(raw)) return raw.map(normalizePair).filter(Boolean);
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.map(normalizePair).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizePair(p) {
  const alias = String(p?.alias || '').trim();
  const real = String(p?.real || '').trim();
  const note = String(p?.note || '').trim();
  if (!alias && !real) return null;
  return { alias: alias || real, real: real || alias, note };
}

function pairKey(p) {
  return `${String(p.alias || '').toLowerCase()}|${String(p.real || '').toLowerCase()}`;
}

function mergePairs(base, extra) {
  const out = [];
  const seen = new Set();
  for (const p of [...(base || []), ...(extra || [])]) {
    const n = normalizePair(p);
    if (!n) continue;
    const k = pairKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function upsertHomePair(list, char) {
  const spoken = String(char?.location_name || '').trim();
  const real = String(char?.real_location || '').trim();
  if (!spoken && !real) return list || [];
  const alias = spoken || real;
  const lookup = real || spoken;
  const next = (list || []).filter((p) => {
    if (lookup && p.real === lookup) return false;
    if (alias && p.alias === alias) return false;
    return true;
  });
  next.unshift({ alias, real: lookup, note: '常住' });
  return next;
}

function parsePairsFromWorldbook(content) {
  const extras = [];
  for (const line of String(content || '').split('\n')) {
    const m = line.trim().match(/^(.+?)\s*=\s*([^\s（(]+)(?:\s*[（(]([^）)]*)[）)])?$/);
    if (!m) continue;
    extras.push({
      alias: m[1].trim(),
      real: m[2].trim(),
      note: String(m[3] || '').trim(),
    });
  }
  return extras.map(normalizePair).filter(Boolean);
}

function buildGeoWorldbookContent(char, pairs) {
  const id = Number(char?.id) || 0;
  const mapOn = Number(char?.real_world_map) === 1;
  const realNames = Number(char?.real_place_names) !== 0;
  const spoken = String(char?.location_name || '').trim();
  const real = String(char?.real_location || '').trim();
  const lines = [`<!--nian-geo-char:${id}-->`, '【地理对照】'];

  if (!mapOn) {
    lines.push('地理由其它世界书和人设补，不要套现实城市和真实路网。');
    if (spoken) lines.push(`常住对外称呼：${spoken}`);
    const homeAddrOff = String(char?.home_address || '').trim();
    if (homeAddrOff) lines.push(`家的住址：${homeAddrOff}`);
    return lines.join('\n');
  }

  if (realNames) {
    lines.push('按现实世界地图。城市、路、区、店、地标用官方真名，禁止魔都、帝都、羊城、鹏城这类俗称。');
    lines.push('手填的常住对外称呼若与现实城市不同，聊天里优先用对外称呼。');
  } else {
    lines.push('按现实世界地图。城市对外只用化名；区、路、店、商圈、地铁站、地标一律用官方真名。');
    lines.push('禁止把对照表右侧的现实城市名说出口，也不要用魔都、帝都、羊城、鹏城、山城、蓉城这类俗称。');
    lines.push('同一城市全程只用对照表里的那一个化名。路网、距离、天气按右侧现实城市走。');
  }
  if (spoken) lines.push(`常住对外称呼：${spoken}`);
  if (real) {
    lines.push(`对应现实地区：${real}（查天气/走路网用；${realNames ? '若与对外称呼不同则聊天用对外称呼' : '嘴里说化名'}）`);
  }
  const homeAddr = String(char?.home_address || '').trim();
  const realHomeAddr = String(char?.real_home_address || '').trim();
  if (homeAddr) lines.push(`家的对外住址：${homeAddr}（说「我家/回家」时用这个称呼）`);
  if (realHomeAddr) {
    lines.push(`家的现实住址：${realHomeAddr}（发位置卡、钉地图、开导航用；${realNames ? '若与对外住址不同则聊天用对外住址' : '嘴里说对外住址'}）`);
  }

  const table = (pairs || []).filter((p) => p.alias && p.real);
  if (table.length) {
    lines.push('');
    lines.push('对照表：');
    for (const p of table) {
      const note = p.note ? `（${p.note}）` : '';
      if (p.alias === p.real) lines.push(`${p.alias}${note}`);
      else lines.push(`${p.alias} = ${p.real}${note}`);
    }
  }
  return lines.join('\n');
}

function geoWorldbookTitle(char) {
  const name = String(char?.name || '角色').trim() || '角色';
  return `地理对照 · ${name}（#${char.id}）`;
}

function bindWorldbook(db, charId, wbId) {
  const row = db.prepare('SELECT worldbook_ids FROM characters WHERE id=?').get(charId);
  let ids = [];
  try { ids = JSON.parse(row?.worldbook_ids || '[]'); } catch { ids = []; }
  const n = Number(wbId);
  if (!n) return;
  if (!ids.some((x) => Number(x) === n)) {
    ids.push(n);
    db.prepare('UPDATE characters SET worldbook_ids=? WHERE id=?').run(JSON.stringify(ids), charId);
  }
}

function syncGeoWorldbook(db, charId) {
  const id = Number(charId);
  if (!id) return null;
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
  if (!char) return null;

  let pairs = parseAliasList(char.geo_city_aliases);
  let wbId = Number(char.geo_worldbook_id) || 0;
  let row = wbId ? db.prepare('SELECT * FROM worldbook WHERE id=?').get(wbId) : null;
  if (!row) {
    row = db.prepare('SELECT * FROM worldbook WHERE content LIKE ?')
      .get(`%<!--nian-geo-char:${id}-->%`);
    wbId = row?.id || 0;
  }
  if (row?.content) {
    pairs = mergePairs(pairs, parsePairsFromWorldbook(row.content));
  }
  pairs = upsertHomePair(pairs, char);

  try {
    db.prepare('UPDATE characters SET geo_city_aliases=? WHERE id=?')
      .run(JSON.stringify(pairs), id);
  } catch { /* 列尚未迁移 */ }

  const mapOn = Number(char.real_world_map) === 1;
  const title = geoWorldbookTitle(char);
  const content = buildGeoWorldbookContent(char, pairs);
  const enabled = mapOn ? 1 : 0;

  if (row) {
    db.prepare('UPDATE worldbook SET title=?, content=?, enabled=?, weight=? WHERE id=?')
      .run(title, content, enabled, 5, row.id);
    wbId = row.id;
  } else if (mapOn) {
    const r = db.prepare('INSERT INTO worldbook (title, content, weight, enabled) VALUES (?,?,?,?)')
      .run(title, content, 5, 1);
    wbId = r.lastInsertRowid;
  }

  if (wbId) {
    try {
      db.prepare('UPDATE characters SET geo_worldbook_id=? WHERE id=?').run(wbId, id);
    } catch { /* 列尚未迁移 */ }
    if (mapOn) bindWorldbook(db, id, wbId);
  }
  return { wbId, pairs };
}

function syncAllGeoWorldbooks(db) {
  const rows = db.prepare('SELECT id, real_world_map, geo_worldbook_id FROM characters').all();
  let n = 0;
  for (const r of rows || []) {
    if (Number(r.real_world_map) !== 1) continue;
    const wbId = Number(r.geo_worldbook_id) || 0;
    const exists = wbId && db.prepare('SELECT id FROM worldbook WHERE id=?').get(wbId);
    if (exists) continue;
    try {
      if (syncGeoWorldbook(db, r.id)) n += 1;
    } catch (e) {
      console.warn('[geo-worldbook]', r.id, e.message);
    }
  }
  return n;
}

function deleteGeoWorldbook(db, charId) {
  const id = Number(charId);
  if (!id) return;
  const char = db.prepare('SELECT geo_worldbook_id FROM characters WHERE id=?').get(id);
  const wbId = Number(char?.geo_worldbook_id) || 0;
  if (wbId) {
    try { db.prepare('DELETE FROM worldbook WHERE id=?').run(wbId); } catch {}
  }
  try {
    const row = db.prepare('SELECT * FROM worldbook WHERE content LIKE ?')
      .get(`%<!--nian-geo-char:${id}-->%`);
    if (row?.id) db.prepare('DELETE FROM worldbook WHERE id=?').run(row.id);
  } catch {}
}

module.exports = {
  parseAliasList,
  upsertHomePair,
  buildGeoWorldbookContent,
  syncGeoWorldbook,
  syncAllGeoWorldbooks,
  deleteGeoWorldbook,
};

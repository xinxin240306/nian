/**
 * 完整备份 / 还原。按表带 id 写入，避免旧版「丢掉 id 再插入」把角色和聊天对不上。
 */
const TABLE_GROUPS = {
  characters: [
    'characters', 'character_album', 'char_traits',
    'char_wardrobe_items', 'char_daily_outfits', 'char_monitor_plans', 'char_monitor_outfit_snapshots',
    'char_impressions', 'char_self_views', 'char_archive_entries', 'char_memory_carry', 'char_user_reads',
    'user_contacts', 'friend_requests', 'shared_lists',
  ],
  messages: ['messages', 'call_logs'],
  memories: [
    'memories', 'memory_episodes', 'memory_narratives',
    'memory_narrative_branches', 'memory_links', 'memory_narrative_links',
    'schedules', 'day_timelines', 'day_chat_dots', 'day_mood_stickers', 'emotion_logs',
  ],
  diaries: [
    'diaries', 'secret_notes', 'secret_stickers',
    'shared_memo_books', 'shared_memo_entries', 'shared_memo_jobs',
    'letter_books', 'letter_entries', 'letter_jobs',
    'ta_album_photos', 'ta_album_comments', 'ta_album_jobs',
    'ta_studio_photos', 'photostudio_sessions', 'photostudio_jobs',
  ],
  moments: ['moments'],
  worldbook: ['worldbook'],
  presets: ['presets'],
  settings: ['settings'],
  series: ['series_books', 'series_chapters', 'series_memories', 'series_turns', 'series_jobs'],
  emoji: ['emoji_categories', 'emojis'],
  circles: [
    'circles', 'circle_npcs', 'circle_moments', 'circle_moment_comments',
    'circle_friends', 'circle_char_moments',
  ],
  group_chats: ['group_chats', 'group_messages'],
  tieba: ['tieba_accounts', 'tieba_sessions', 'tieba_bars', 'tieba_threads', 'tieba_posts'],
  music: ['music_sync_state', 'music_sync_history'],
};

/** 清除时按角色范围删除（有 character_id 列的表） */
const CHAR_SCOPED_CLEAR = {
  memories: [
    'memories', 'memory_episodes', 'memory_narratives', 'memory_narrative_branches',
    'memory_links', 'memory_narrative_links',
    'char_impressions', 'char_self_views', 'char_archive_entries', 'char_memory_carry', 'char_user_reads',
    'schedules', 'day_timelines', 'day_chat_dots', 'day_mood_stickers', 'emotion_logs',
  ],
  diaries: [
    'diaries', 'secret_notes', 'secret_stickers',
    'shared_memo_books', 'shared_memo_entries', 'shared_memo_jobs',
    'letter_books', 'letter_entries', 'letter_jobs',
    'ta_album_photos', 'ta_album_comments', 'ta_album_jobs',
    'ta_studio_photos', 'photostudio_sessions', 'photostudio_jobs',
  ],
};

/** 「清除全部」保留设置与预设（API Key / 主题等），其余内容表全清 */
const CLEAR_ALL_KEEP = new Set(['settings', 'presets', 'push_subscriptions']);

const IMPORT_ALIASES = {
  impressions: 'char_impressions',
  emoji_stickers: 'emojis',
};

const IMPORT_ORDER = [
  'characters', 'user_contacts', 'friend_requests',
  'worldbook', 'presets', 'settings',
  'emoji_categories', 'emojis',
  'messages', 'call_logs',
  'memories', 'memory_episodes', 'memory_narratives',
  'memory_narrative_branches', 'memory_links', 'memory_narrative_links',
  'schedules', 'day_timelines', 'day_chat_dots', 'day_mood_stickers', 'emotion_logs',
  'diaries', 'secret_notes', 'secret_stickers',
  'shared_memo_books', 'shared_memo_entries', 'shared_memo_jobs',
  'letter_books', 'letter_entries', 'letter_jobs',
  'ta_album_photos', 'ta_album_comments', 'ta_album_jobs',
  'ta_studio_photos', 'photostudio_sessions', 'photostudio_jobs',
  'moments', 'character_album',
  'char_traits', 'char_impressions', 'char_self_views', 'char_archive_entries', 'char_memory_carry', 'char_user_reads',
  'char_wardrobe_items', 'char_daily_outfits', 'char_monitor_plans', 'char_monitor_outfit_snapshots',
  'shared_lists',
  'series_books', 'series_chapters', 'series_memories', 'series_turns', 'series_jobs',
  'circles', 'circle_npcs', 'circle_moments', 'circle_moment_comments', 'circle_friends', 'circle_char_moments',
  'group_chats', 'group_messages',
  'tieba_accounts', 'tieba_bars', 'tieba_threads', 'tieba_posts', 'tieba_sessions',
  'music_sync_state', 'music_sync_history',
];

function getDb() {
  return require('./db');
}

function selectedTables(types) {
  const selected = (types || []).map((t) => String(t || '').trim()).filter(Boolean);
  const useAll = !selected.length || selected.includes('all');
  const names = new Set();
  if (useAll) {
    for (const list of Object.values(TABLE_GROUPS)) {
      for (const n of list) names.add(n);
    }
    return names;
  }
  for (const t of selected) {
    const list = TABLE_GROUPS[t];
    if (list) for (const n of list) names.add(n);
    else names.add(t);
  }
  return names;
}

function tableExists(name) {
  try {
    const row = getDb().prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    ).get(name);
    return !!row?.name;
  } catch {
    return false;
  }
}

function tableColumns(name) {
  try {
    const rows = getDb().prepare(`PRAGMA table_info(${name})`).all() || [];
    return new Set(rows.map((r) => r.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function dumpTable(name) {
  if (!tableExists(name)) return [];
  try {
    return getDb().prepare(`SELECT * FROM ${name}`).all() || [];
  } catch {
    return [];
  }
}

function buildExportData(types) {
  const data = {
    version: '2.0',
    exported_at: new Date().toISOString(),
    app: '念',
  };
  for (const name of selectedTables(types)) {
    const rows = dumpTable(name);
    if (rows.length) data[name] = rows;
  }
  return data;
}

function mergeExtraMessages(data, extra) {
  if (!Array.isArray(extra) || !extra.length) return data;
  const map = new Map();
  for (const row of data.messages || []) {
    const id = Number(row?.id);
    if (id > 0) map.set(id, row);
  }
  for (const row of extra) {
    const id = Number(row?.id);
    if (id <= 0 || map.has(id)) continue;
    map.set(id, row);
  }
  data.messages = [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
  return data;
}

function importTable(name, rows) {
  if (!rows?.length || !tableExists(name)) return 0;
  let cols = tableColumns(name);
  if (!cols.size && rows[0] && typeof rows[0] === 'object') {
    cols = new Set(Object.keys(rows[0]));
  }
  if (!cols.size) return 0;
  const db = getDb();
  let n = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const keys = Object.keys(row).filter((k) => cols.has(k));
    if (!keys.length) continue;
    const ph = keys.map(() => '?').join(',');
    db.prepare(
      `INSERT OR REPLACE INTO ${name} (${keys.join(',')}) VALUES (${ph})`
    ).run(...keys.map((k) => row[k]));
    n += 1;
  }
  return n;
}

function importBackupData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('无效的备份文件');
  }
  const counts = {};
  const pending = { ...data };
  if (pending.impressions && !pending.char_impressions) {
    pending.char_impressions = pending.impressions;
  }
  if (pending.emoji_stickers && !pending.emojis) {
    pending.emojis = pending.emoji_stickers;
  }
  for (const alias of Object.keys(IMPORT_ALIASES)) {
    const real = IMPORT_ALIASES[alias];
    if (pending[alias] && !pending[real]) pending[real] = pending[alias];
  }

  const seen = new Set();
  const queue = [...IMPORT_ORDER];
  for (const key of Object.keys(pending)) {
    if (Array.isArray(pending[key]) && !queue.includes(key) && tableExists(key)) {
      queue.push(key);
    }
  }
  for (const name of queue) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!Array.isArray(pending[name])) continue;
    counts[name] = importTable(name, pending[name]);
  }
  return { ok: true, counts };
}

function clearTable(name, characterId) {
  if (!tableExists(name)) return 0;
  const db = getDb();
  const cols = tableColumns(name);
  try {
    if (characterId != null && cols.has('character_id')) {
      const r = db.prepare(`DELETE FROM ${name} WHERE character_id=?`).run(characterId);
      return r?.changes || 0;
    }
    const r = db.prepare(`DELETE FROM ${name}`).run();
    return r?.changes || 0;
  } catch {
    return 0;
  }
}

function clearData(type, characterId) {
  const cleared = {};
  const cid = characterId != null && characterId !== '' ? Number(characterId) : null;
  const scopedCid = Number.isFinite(cid) && cid > 0 ? cid : null;

  if (type === 'memories') {
    for (const name of CHAR_SCOPED_CLEAR.memories) {
      cleared[name] = clearTable(name, scopedCid);
    }
  } else if (type === 'diaries') {
    for (const name of CHAR_SCOPED_CLEAR.diaries) {
      cleared[name] = clearTable(name, scopedCid);
    }
  } else if (type === 'cache') {
    cleared.daily_context = clearTable('daily_context', scopedCid);
  } else if (type === 'all') {
    const names = new Set();
    for (const list of Object.values(TABLE_GROUPS)) {
      for (const n of list) {
        if (!CLEAR_ALL_KEEP.has(n)) names.add(n);
      }
    }
    // 子表先删，角色最后删
    const ordered = [...IMPORT_ORDER].reverse().filter((n) => names.has(n));
    for (const n of names) {
      if (!ordered.includes(n)) ordered.push(n);
    }
    for (const name of ordered) {
      cleared[name] = clearTable(name, null);
    }
  }
  return cleared;
}

module.exports = {
  TABLE_GROUPS,
  buildExportData,
  mergeExtraMessages,
  importBackupData,
  clearData,
};

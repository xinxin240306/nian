const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'nian.db');
const BACKUP_DIR = path.join(__dirname, 'db_backups');
const MAX_BACKUPS = 10;

let db = null;
let SQL = null;

// Load or create database (synchronous wrapper around sql.js)
function getDB() {
  if (db) return db;
  throw new Error('DB not initialized. Call initDB() first.');
}

/** 备份一份带时间戳的库文件，并只保留最近 MAX_BACKUPS 份，防止 crash 循环把唯一数据文件写坏后无法找回 */
function backupDBFile(tagSuffix) {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `nian-${stamp}${tagSuffix ? '-' + tagSuffix : ''}.db`);
    fs.copyFileSync(DB_PATH, dest);
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(MAX_BACKUPS)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
    }
    return dest;
  } catch (e) {
    console.warn('[db] backup failed', e.message);
    return null;
  }
}

/** 找最近一份「看起来正常」的备份（characters 表非空），用于主库损坏/被清空时的兜底恢复 */
function findRecoverableBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return null;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files) {
      try {
        const data = fs.readFileSync(path.join(BACKUP_DIR, f));
        const testDb = new SQL.Database(data);
        const res = testDb.exec(`SELECT COUNT(*) FROM characters`);
        const count = res?.[0]?.values?.[0]?.[0] || 0;
        testDb.close();
        if (count > 0) return path.join(BACKUP_DIR, f);
      } catch { /* 这份备份也打不开/是坏的，试下一份 */ }
    }
  } catch (e) {
    console.warn('[db] scan backups failed', e.message);
  }
  return null;
}

async function initDB() {
  SQL = await require('sql.js')();

  if (fs.existsSync(DB_PATH + '-wal') || fs.existsSync(DB_PATH + '-shm')) {
    console.warn('[db] 发现 nian.db-wal/shm。sql.js 只读主库文件，未 checkpoint 的写入会丢。切回前请先停进程，让上一版把 WAL 合并进主库，不要先删 wal。');
  }

  // 每次启动前先把当前库文件快照一份（不管好坏）：即使这次启动读到的是被 crash 写坏/清空的文件，
  // 之前某次正常落盘的快照仍然留着，不会因为反复重启把恢复的可能性也抹掉
  backupDBFile('preboot');

  let loadedFresh = false;
  if (fs.existsSync(DB_PATH)) {
    let data = fs.readFileSync(DB_PATH);
    try {
      db = new SQL.Database(data);
      // 打开成功不代表数据完好——crash 写到一半的文件也可能被 sql.js 接受但表是空的；
      // 这里做个健康检查，明显异常（有 settings 却没有 characters 表数据且备份里有更好的版本）时尝试自动切换到最近的健康备份
      let charCount = -1;
      try {
        const res = db.exec(`SELECT COUNT(*) FROM characters`);
        charCount = res?.[0]?.values?.[0]?.[0] ?? -1;
      } catch { /* 表可能还不存在（全新库属正常），交给下面的建表逻辑处理 */ }
      if (charCount === 0) {
        const backup = findRecoverableBackup();
        if (backup) {
          console.warn(`[db] 当前数据库 characters 表为空，疑似被异常重启写坏，自动改用最近的健康备份: ${backup}`);
          db = new SQL.Database(fs.readFileSync(backup));
        }
      }
    } catch (e) {
      console.error('[db] 主库文件已损坏，无法解析:', e.message);
      const backup = findRecoverableBackup();
      if (backup) {
        console.warn(`[db] 改用最近的健康备份: ${backup}`);
        db = new SQL.Database(fs.readFileSync(backup));
      } else {
        console.error('[db] 没有可用备份，只能新建空库（这会丢失全部数据，请检查 db_backups 目录）');
        db = new SQL.Database();
        loadedFresh = true;
      }
    }
  } else {
    db = new SQL.Database();
    loadedFresh = true;
  }
  void loadedFresh;

  db.run(`PRAGMA foreign_keys = ON;`);

  db.run(`
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      intro TEXT DEFAULT '',
      opening TEXT DEFAULT '',
      language_style TEXT DEFAULT '',
      location_name TEXT DEFAULT '',
      real_location TEXT DEFAULT '',
      description TEXT DEFAULT '',
      voice_id TEXT DEFAULT '',
      memory_trigger_n INTEGER DEFAULT 10,
      busy_style TEXT DEFAULT 'gentle',
      allow_diary INTEGER DEFAULT 1,
      post_moments INTEGER DEFAULT 1,
      mutual_characters TEXT DEFAULT '[]',
      image_ref TEXT DEFAULT '[]',
      image_style TEXT DEFAULT 'anime',
      nsfw_enabled INTEGER DEFAULT 0,
      nsfw_tags TEXT DEFAULT '[]',
      nsfw_note TEXT DEFAULT '',
      dream_affects_memory INTEGER DEFAULT 0,
      birthday TEXT DEFAULT '',
      anniversary TEXT DEFAULT '',
      status TEXT DEFAULT 'online',
      mood TEXT DEFAULT '',
      voice_messages INTEGER DEFAULT 0,
      emoji_categories TEXT DEFAULT '[]',
      memory_weights TEXT DEFAULT '{}',
      worldbook_ids TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      recalled INTEGER DEFAULT 0,
      recalled_content TEXT DEFAULT '',
      timestamp TEXT DEFAULT (datetime('now')),
      location TEXT DEFAULT '',
      is_dream INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      weight REAL DEFAULT 0.5,
      date TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS diaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER,
      role TEXT NOT NULL,
      title TEXT DEFAULT '',
      content TEXT NOT NULL,
      date TEXT NOT NULL,
      visible_to TEXT DEFAULT '[]',
      ai_peeked INTEGER DEFAULT 0,
      ai_peeked_at TEXT DEFAULT '',
      ai_secret_note TEXT DEFAULT '',
      user_peeked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS moments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER,
      role TEXT NOT NULL,
      content TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      likes TEXT DEFAULT '[]',
      comments TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_moments_character ON moments(character_id);
    CREATE INDEX IF NOT EXISTS idx_moments_created ON moments(created_at);

    CREATE TABLE IF NOT EXISTS worldbook (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      content TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      type TEXT DEFAULT 'custom',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS emoji_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS emojis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER,
      role TEXT NOT NULL DEFAULT 'ai',
      date TEXT NOT NULL,
      items TEXT NOT NULL DEFAULT '[]',
      generated INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      gist TEXT NOT NULL,
      keywords TEXT DEFAULT '[]',
      msg_id_from INTEGER,
      msg_id_to INTEGER,
      date TEXT DEFAULT '',
      salience REAL DEFAULT 0.6,
      source TEXT DEFAULT 'consolidated',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      duration INTEGER DEFAULT 0,
      transcript TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS day_timelines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      summary TEXT DEFAULT '',
      beats TEXT DEFAULT '[]',
      source_meta TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(character_id, date)
    );

    CREATE TABLE IF NOT EXISTS series_books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      mode TEXT DEFAULT 'series',
      title TEXT DEFAULT '',
      genres TEXT DEFAULT '[]',
      genres_custom TEXT DEFAULT '',
      era TEXT DEFAULT '现代',
      era_custom TEXT DEFAULT '',
      char_role TEXT DEFAULT '',
      user_role TEXT DEFAULT '',
      char_role_kind TEXT DEFAULT '',
      user_role_kind TEXT DEFAULT '',
      cast_list TEXT DEFAULT '[]',
      roles_blind INTEGER DEFAULT 0,
      npc_free INTEGER DEFAULT 1,
      npcs TEXT DEFAULT '[]',
      length_type TEXT DEFAULT 'medium',
      total_chapters INTEGER DEFAULT 20,
      style TEXT DEFAULT 'romantic',
      style_custom TEXT DEFAULT '',
      book_outline TEXT DEFAULT '',
      chapter_outline TEXT DEFAULT '[]',
      status TEXT DEFAULT 'setup',
      user_premise TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS series_chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      chapter_no INTEGER NOT NULL,
      title TEXT DEFAULT '',
      outline TEXT DEFAULT '',
      content TEXT DEFAULT '',
      user_beat TEXT DEFAULT '',
      char_beat TEXT DEFAULT '',
      camera_note TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      director_notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(book_id, chapter_no)
    );

    CREATE TABLE IF NOT EXISTS series_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      chapter_no INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS series_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      chapter_no INTEGER NOT NULL,
      kind TEXT DEFAULT 'narration',
      content TEXT DEFAULT '',
      meta TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS char_impressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      keywords TEXT DEFAULT '[]',
      category TEXT DEFAULT 'general',
      auto_generated INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS secret_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      role TEXT DEFAULT 'ai',
      section TEXT NOT NULL,
      content TEXT NOT NULL,
      note_at TEXT NOT NULL,
      date TEXT NOT NULL,
      source TEXT DEFAULT 'auto',
      confirmed INTEGER DEFAULT 1,
      peeks TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS secret_stickers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_type TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      emoji_id INTEGER,
      unicode TEXT DEFAULT '',
      x REAL DEFAULT 0.5,
      y REAL DEFAULT 0.5,
      scale REAL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shared_memo_books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL UNIQUE,
      title TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shared_memo_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      role TEXT DEFAULT 'user',
      type TEXT DEFAULT 'text',
      content TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      emojis TEXT DEFAULT '[]',
      annotations TEXT DEFAULT '[]',
      reply_to_id INTEGER DEFAULT NULL,
      status TEXT DEFAULT 'visible',
      visible_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shared_memo_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      trigger_entry_id INTEGER,
      kind TEXT DEFAULT 'react',
      run_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS letter_books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL UNIQUE,
      title TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS letter_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      role TEXT DEFAULT 'user',
      content TEXT DEFAULT '',
      status TEXT DEFAULT 'in_transit',
      reply_to_id INTEGER DEFAULT NULL,
      posted_at TEXT DEFAULT (datetime('now')),
      deliver_at TEXT DEFAULT NULL,
      read_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS letter_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      entry_id INTEGER,
      kind TEXT DEFAULT 'deliver',
      run_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ta_album_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      url TEXT NOT NULL,
      caption TEXT DEFAULT '',
      taken_at TEXT DEFAULT '',
      location TEXT DEFAULT '',
      lat REAL,
      lng REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ta_album_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ta_album_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      photo_id INTEGER,
      kind TEXT DEFAULT 'comment',
      run_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      user_agent TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS character_album (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 新字段迁移（ADD COLUMN IF NOT EXISTS 在旧版 SQLite 不支持，用 try/catch）
  const migrations = [
    `ALTER TABLE characters ADD COLUMN memory_summary_enabled INTEGER DEFAULT 1`,
    `ALTER TABLE characters ADD COLUMN timezone_offset INTEGER DEFAULT 8`,
    `ALTER TABLE characters ADD COLUMN timezone_sync INTEGER DEFAULT 1`,
    `ALTER TABLE worldbook ADD COLUMN weight INTEGER DEFAULT 3`,
    `ALTER TABLE diaries ADD COLUMN char_peeks TEXT DEFAULT '[]'`,
    `ALTER TABLE characters ADD COLUMN personality TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN background TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN behavior TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN proactive_msg_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN proactive_msg_minutes INTEGER DEFAULT 60`,
    `ALTER TABLE characters ADD COLUMN proactive_call_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN mood TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN voice_messages INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN music_score_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE char_impressions ADD COLUMN auto_generated INTEGER DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN reply_to_id INTEGER DEFAULT NULL`,
    `ALTER TABLE messages ADD COLUMN reply_preview TEXT DEFAULT ''`,
    `ALTER TABLE moments ADD COLUMN location TEXT DEFAULT ''`,
    `ALTER TABLE moments ADD COLUMN mentions TEXT DEFAULT '[]'`,
    `ALTER TABLE moments ADD COLUMN chat_asked TEXT DEFAULT '[]'`,
    `ALTER TABLE characters ADD COLUMN poke_char_suffix TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN poke_user_suffix TEXT DEFAULT ''`,
    `ALTER TABLE messages ADD COLUMN is_read INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN emoji_enabled INTEGER DEFAULT 1`,
    `ALTER TABLE characters ADD COLUMN emoji_freq INTEGER DEFAULT 30`,
    `ALTER TABLE characters ADD COLUMN chat_context_rounds INTEGER DEFAULT 10`,
    `ALTER TABLE characters ADD COLUMN memory_keywords TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN memory_last_msg_id INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN relationship TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN relationship_custom TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN busy_since TEXT DEFAULT NULL`,
    `ALTER TABLE characters ADD COLUMN emotion_style TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN diary_bg TEXT DEFAULT 'default'`,
    `ALTER TABLE characters ADD COLUMN image_aspect TEXT DEFAULT '3:4'`,
    `ALTER TABLE characters ADD COLUMN video_aspect TEXT DEFAULT '9:16'`,
    `ALTER TABLE characters ADD COLUMN selfie_style_prompt TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN home_environment TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN home_refs TEXT DEFAULT '[]'`,
    `ALTER TABLE characters ADD COLUMN video_motion_prompt TEXT DEFAULT ''`,
    `ALTER TABLE messages ADD COLUMN media_meta TEXT DEFAULT ''`,
    `ALTER TABLE memories ADD COLUMN episode_id INTEGER DEFAULT NULL`,
    `ALTER TABLE memories ADD COLUMN keywords TEXT DEFAULT '[]'`,
    `ALTER TABLE character_album ADD COLUMN subject TEXT DEFAULT 'other'`,
    `ALTER TABLE char_impressions ADD COLUMN confirmed INTEGER DEFAULT 1`,
    `ALTER TABLE secret_notes ADD COLUMN peeks TEXT DEFAULT '[]'`,
    `ALTER TABLE presets ADD COLUMN scopes TEXT DEFAULT '["chat"]'`,
    `ALTER TABLE characters ADD COLUMN moments_cover TEXT DEFAULT ''`,
    `ALTER TABLE messages ADD COLUMN delivery_status TEXT DEFAULT 'sent'`,
    `ALTER TABLE shared_memo_entries ADD COLUMN annotations TEXT DEFAULT '[]'`,
    `ALTER TABLE characters ADD COLUMN nicknames TEXT DEFAULT '{"toChar":[],"toUser":[]}'`,
    `ALTER TABLE characters ADD COLUMN theater_active INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN theater_scene_state TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN emotion_state TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN diary_enabled INTEGER DEFAULT 1`,
    `ALTER TABLE characters ADD COLUMN schedule_enabled INTEGER DEFAULT 1`,
    `ALTER TABLE characters ADD COLUMN natural_chat_mode INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN time_aware_enabled INTEGER DEFAULT 1`,
    `ALTER TABLE characters ADD COLUMN timezone TEXT DEFAULT 'Asia/Shanghai'`,
    `ALTER TABLE characters ADD COLUMN proactive_call_interval_days INTEGER DEFAULT 7`,
    `ALTER TABLE characters ADD COLUMN source TEXT DEFAULT ''`,
    `ALTER TABLE series_books ADD COLUMN mode TEXT DEFAULT 'series'`,
    `ALTER TABLE series_books ADD COLUMN char_role_kind TEXT DEFAULT ''`,
    `ALTER TABLE series_books ADD COLUMN user_role_kind TEXT DEFAULT ''`,
    `ALTER TABLE series_books ADD COLUMN cast_list TEXT DEFAULT '[]'`,
    `ALTER TABLE series_chapters ADD COLUMN user_beat TEXT DEFAULT ''`,
    `ALTER TABLE series_chapters ADD COLUMN char_beat TEXT DEFAULT ''`,
    `ALTER TABLE series_chapters ADD COLUMN camera_note TEXT DEFAULT ''`,
    `ALTER TABLE series_chapters ADD COLUMN quest_state TEXT DEFAULT '{}'`,
    `ALTER TABLE series_books ADD COLUMN book_main_quest TEXT DEFAULT ''`,
    `ALTER TABLE series_books ADD COLUMN identity_lock TEXT DEFAULT '{}'`,
    `ALTER TABLE series_books ADD COLUMN canon_lock TEXT DEFAULT '{}'`,
    `ALTER TABLE series_books ADD COLUMN story_source TEXT DEFAULT '{}'`,
    `ALTER TABLE series_books ADD COLUMN user_premise TEXT DEFAULT ''`,
    `ALTER TABLE series_books ADD COLUMN whatif_background TEXT DEFAULT ''`,
    `ALTER TABLE series_books ADD COLUMN story_brief TEXT DEFAULT ''`,
    `ALTER TABLE series_books ADD COLUMN story_taboos TEXT DEFAULT '[]'`,
    `ALTER TABLE series_books ADD COLUMN screenwriter_status TEXT DEFAULT ''`,
    `ALTER TABLE series_memories ADD COLUMN kind TEXT DEFAULT 'plot'`,
    `ALTER TABLE series_memories ADD COLUMN pinned INTEGER DEFAULT 0`,
    `ALTER TABLE series_memories ADD COLUMN embedding TEXT DEFAULT ''`,
    `ALTER TABLE memories ADD COLUMN embedding TEXT DEFAULT ''`,
    `ALTER TABLE memories ADD COLUMN archived INTEGER DEFAULT 0`,
    `ALTER TABLE memories ADD COLUMN resolved INTEGER DEFAULT 0`,
    `ALTER TABLE memories ADD COLUMN consolidate_rejects INTEGER DEFAULT 0`,
    `ALTER TABLE series_books ADD COLUMN lore_book TEXT DEFAULT '{}'`,
    `UPDATE characters SET nsfw_enabled=1 WHERE COALESCE(nsfw_enabled,0)=0`,
    `ALTER TABLE characters ADD COLUMN mindset TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN mindset_digested_at TEXT DEFAULT NULL`,
    `ALTER TABLE characters ADD COLUMN appearance_profile TEXT DEFAULT '{}'`,
    `ALTER TABLE character_album ADD COLUMN note TEXT DEFAULT ''`,
    `ALTER TABLE character_album ADD COLUMN source TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN robot_emotions TEXT DEFAULT '{}'`,
    `ALTER TABLE characters ADD COLUMN robot_operating INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN robot_operating_since TEXT DEFAULT NULL`,
    `ALTER TABLE characters ADD COLUMN inner_drive_state TEXT DEFAULT ''`,
    `ALTER TABLE char_monitor_plans ADD COLUMN description TEXT DEFAULT ''`,
    `ALTER TABLE char_monitor_plans ADD COLUMN room_scenes TEXT DEFAULT '{}'`,
    `ALTER TABLE characters ADD COLUMN schedule_week_plan TEXT DEFAULT ''`,
    `ALTER TABLE emotion_logs ADD COLUMN fuel_longing REAL DEFAULT 0`,
    `ALTER TABLE emotion_logs ADD COLUMN fuel_desire REAL DEFAULT 0`,
    `ALTER TABLE emotion_logs ADD COLUMN fuel_intimacy REAL DEFAULT 0`,
    `ALTER TABLE memories ADD COLUMN fact_key TEXT DEFAULT ''`,
    `ALTER TABLE memories ADD COLUMN status TEXT DEFAULT 'current'`,
    `ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'chat'`,
    `ALTER TABLE characters ADD COLUMN affection_state TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN vocal_clips TEXT DEFAULT '[]'`,
    `ALTER TABLE characters ADD COLUMN voice_id_nsfw TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN call_video TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN call_video_mode TEXT DEFAULT 'video'`,
    `ALTER TABLE characters ADD COLUMN memory_flash_chance INTEGER DEFAULT 20`,
    `ALTER TABLE characters ADD COLUMN carry_memory INTEGER DEFAULT 1`,
    `ALTER TABLE characters ADD COLUMN carry_portrait INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN screen_chat_priority INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN real_world_map INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN real_place_names INTEGER DEFAULT 1`,
    `ALTER TABLE characters ADD COLUMN geo_worldbook_id INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN geo_city_aliases TEXT DEFAULT '[]'`,
    `ALTER TABLE characters ADD COLUMN home_address TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN real_home_address TEXT DEFAULT ''`,
    `ALTER TABLE memories ADD COLUMN meta TEXT DEFAULT ''`,
    `ALTER TABLE char_impressions ADD COLUMN strength REAL DEFAULT 0.6`,
    `ALTER TABLE char_impressions ADD COLUMN evidence_ids TEXT DEFAULT '[]'`,
    `ALTER TABLE char_impressions ADD COLUMN subcategory TEXT DEFAULT ''`,
    `ALTER TABLE char_impressions ADD COLUMN related_facts TEXT DEFAULT '[]'`,
    `ALTER TABLE char_impressions ADD COLUMN note TEXT DEFAULT ''`,
    `ALTER TABLE char_impressions ADD COLUMN topic_key TEXT DEFAULT ''`,
    `ALTER TABLE char_self_views ADD COLUMN subcategory TEXT DEFAULT ''`,
    `ALTER TABLE char_self_views ADD COLUMN related_facts TEXT DEFAULT '[]'`,
    `ALTER TABLE char_self_views ADD COLUMN note TEXT DEFAULT ''`,
    `ALTER TABLE char_self_views ADD COLUMN topic_key TEXT DEFAULT ''`,
    `ALTER TABLE memory_narratives ADD COLUMN components TEXT DEFAULT '[]'`,
    `ALTER TABLE memory_narratives ADD COLUMN kind TEXT DEFAULT 'event'`,
    `ALTER TABLE memory_narratives ADD COLUMN last_touched_at TEXT DEFAULT ''`,
    `ALTER TABLE memory_narratives ADD COLUMN touch_count INTEGER DEFAULT 0`,
    `ALTER TABLE memory_narratives ADD COLUMN salience REAL DEFAULT 0.7`,
    `ALTER TABLE memory_narratives ADD COLUMN tier TEXT DEFAULT 'hot'`,
    `ALTER TABLE memory_narratives ADD COLUMN emotion_charge REAL DEFAULT 0`,
    `ALTER TABLE memory_narratives ADD COLUMN pinned INTEGER DEFAULT 0`,
    `ALTER TABLE memory_narratives ADD COLUMN fallen_at TEXT DEFAULT ''`,
    `ALTER TABLE memory_narratives ADD COLUMN mood_label TEXT DEFAULT ''`,
    `ALTER TABLE memory_narratives ADD COLUMN stance TEXT DEFAULT ''`,
    `ALTER TABLE memory_narrative_branches ADD COLUMN fallen_at TEXT DEFAULT ''`,
    `ALTER TABLE memory_narrative_branches ADD COLUMN mood_label TEXT DEFAULT ''`,
    `ALTER TABLE messages ADD COLUMN recall_seen INTEGER DEFAULT 0`,
    `ALTER TABLE characters ADD COLUMN chat_model TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN group_talkativeness TEXT DEFAULT 'normal'`,
    `ALTER TABLE group_chats ADD COLUMN announcement TEXT DEFAULT ''`,
    `ALTER TABLE group_chats ADD COLUMN remark TEXT DEFAULT ''`,
    `ALTER TABLE group_chats ADD COLUMN muted INTEGER DEFAULT 0`,
    `ALTER TABLE group_chats ADD COLUMN show_member_names INTEGER DEFAULT 1`,
    `ALTER TABLE characters ADD COLUMN music_preference TEXT DEFAULT ''`,
    `ALTER TABLE characters ADD COLUMN circle_npc_id INTEGER DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS char_monitor_outfit_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      slot TEXT DEFAULT '',
      outfit_json TEXT NOT NULL,
      outfit_summary TEXT DEFAULT '',
      snapshot_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_monitor_outfit_snap_char_date ON char_monitor_outfit_snapshots(character_id, date, id)`,
  ];
  for (const m of migrations) {
    try { db.run(m); } catch(e) { /* 列已存在则忽略 */ }
  }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS group_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        member_ids TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        speaker_character_id INTEGER,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'text',
        timestamp TEXT DEFAULT (datetime('now')),
        reply_to_id INTEGER,
        is_read INTEGER DEFAULT 0,
        media_meta TEXT DEFAULT '',
        delivery_mode TEXT DEFAULT ''
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, id)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS memory_narratives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        title TEXT DEFAULT '',
        content TEXT NOT NULL,
        embedding TEXT DEFAULT '',
        linked_memory_ids TEXT DEFAULT '[]',
        status TEXT DEFAULT 'active',
        sequel_of INTEGER DEFAULT NULL,
        links_updated_at TEXT DEFAULT (datetime('now')),
        content_updated_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_memory_narratives_char ON memory_narratives(character_id, status)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS memory_narrative_branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        narrative_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        component_key TEXT NOT NULL,
        name TEXT DEFAULT '',
        type TEXT DEFAULT 'thing',
        linked_memory_ids TEXT DEFAULT '[]',
        last_touched_at TEXT DEFAULT '',
        touch_count INTEGER DEFAULT 0,
        salience REAL DEFAULT 0.65,
        tier TEXT DEFAULT 'hot',
        emotion_charge REAL DEFAULT 0,
        pinned INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(narrative_id, component_key)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_narrative_branches_narr ON memory_narrative_branches(narrative_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_narrative_branches_char ON memory_narrative_branches(character_id)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS memory_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(from_id, to_id, type)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_memory_links_char ON memory_links(character_id, type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_memories_fact ON memories(character_id, fact_key, status)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS memory_narrative_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'related',
        score REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(from_id, to_id, type)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_narrative_links_char ON memory_narrative_links(character_id, type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_narrative_links_from ON memory_narrative_links(from_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_narrative_links_to ON memory_narrative_links(to_id)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS char_wardrobe_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        brand_style TEXT DEFAULT '',
        description TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        source TEXT DEFAULT 'ai',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_char_wardrobe_char ON char_wardrobe_items(character_id)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS char_daily_outfits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        slot TEXT NOT NULL,
        outfit_json TEXT NOT NULL DEFAULT '{}',
        source TEXT DEFAULT 'ai',
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(character_id, date, slot)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_char_daily_outfits_char ON char_daily_outfits(character_id, date)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS char_monitor_plans (
        character_id INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) { /* ignore */ }

  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_shared_memo_entries_book ON shared_memo_entries(book_id, status, visible_at)`);
  } catch {}

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS char_traits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        category TEXT DEFAULT '喜好',
        keywords TEXT DEFAULT '[]',
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) { /* ignore */ }

  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_char_traits_char ON char_traits(character_id)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
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
    db.run(`CREATE INDEX IF NOT EXISTS idx_char_self_views_char ON char_self_views(character_id)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS char_archive_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        stage TEXT NOT NULL DEFAULT '其他',
        title TEXT DEFAULT '',
        content TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_char_archive_char ON char_archive_entries(character_id)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS char_memory_carry (
        character_id INTEGER PRIMARY KEY,
        see_user TEXT DEFAULT '',
        see_self TEXT DEFAULT '',
        unfinished TEXT DEFAULT '[]',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS char_user_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT '性格',
        judgment TEXT NOT NULL,
        reason TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_char_user_reads_char ON char_user_reads(character_id)`);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS series_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        chapter_no INTEGER NOT NULL,
        kind TEXT DEFAULT 'narration',
        content TEXT DEFAULT '',
        meta TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) { /* ignore */ }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS series_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        chapter_no INTEGER DEFAULT 0,
        kind TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        payload TEXT DEFAULT '{}',
        error TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) { /* ignore */ }

  // 音乐同步状态表
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS music_sync_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        track_title TEXT DEFAULT '',
        track_artist TEXT DEFAULT '',
        track_album TEXT DEFAULT '',
        position_ms INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        is_playing INTEGER DEFAULT 0,
        song_index INTEGER DEFAULT 0,
        last_comment_index INTEGER DEFAULT -1,
        last_comment_time TEXT DEFAULT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, character_id)
      )
    `);
  } catch (e) {
    console.warn('[db] music_sync_state', e.message);
  }
  try {
    db.run(`ALTER TABLE music_sync_state ADD COLUMN track_lyrics TEXT DEFAULT ''`);
  } catch (e) { /* exists */ }
  try {
    db.run(`ALTER TABLE music_sync_state ADD COLUMN track_emotions TEXT DEFAULT ''`);
  } catch (e) { /* exists */ }

  // 音乐播放历史表
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS music_sync_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        track_title TEXT NOT NULL,
        track_artist TEXT DEFAULT '',
        play_duration_ms INTEGER DEFAULT 0,
        timestamp TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    console.warn('[db] music_sync_history', e.message);
  }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS day_timelines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        summary TEXT DEFAULT '',
        beats TEXT DEFAULT '[]',
        source_meta TEXT DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(character_id, date)
      )
    `);
  } catch (e) {
    console.warn('[db] day_timelines', e.message);
  }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS day_chat_dots (
        character_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        dots TEXT DEFAULT '[]',
        last_msg_id INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (character_id, date)
      )
    `);
  } catch (e) {
    console.warn('[db] day_chat_dots', e.message);
  }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS day_mood_stickers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        owner TEXT NOT NULL,
        character_id INTEGER,
        emoji_code TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        note TEXT DEFAULT '',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_day_mood_char ON day_mood_stickers(character_id, date) WHERE owner = 'char'`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_day_mood_user ON day_mood_stickers(date) WHERE owner = 'user'`);
  } catch (e) {
    console.warn('[db] day_mood_stickers', e.message);
  }

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS emotion_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        valence REAL DEFAULT 0,
        arousal REAL DEFAULT 0,
        primary_tag TEXT DEFAULT 'calm',
        label TEXT DEFAULT '',
        fuel_anger REAL DEFAULT 0,
        fuel_hurt REAL DEFAULT 0,
        fuel_low REAL DEFAULT 0,
        fuel_longing REAL DEFAULT 0,
        fuel_desire REAL DEFAULT 0,
        fuel_intimacy REAL DEFAULT 0,
        flashpoint TEXT DEFAULT '',
        source TEXT DEFAULT '',
        summary TEXT DEFAULT ''
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_emotion_logs_char_ts ON emotion_logs(character_id, ts)`);
  } catch (e) {
    console.warn('[db] emotion_logs', e.message);
  }

  // 共同清单（按角色持久化，随完整备份导出）
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS shared_lists (
        character_id INTEGER PRIMARY KEY,
        items_json TEXT DEFAULT '[]',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    console.warn('[db] shared_lists', e.message);
  }

  try {
    // 用本模块的 prepare/get/run（sql.js 原生 Statement 没有 better-sqlite3 风格的 .get/.all）
    require('./contact-helper').ensureContactTables({
      exec: (sql) => { db.run(sql); },
      prepare: (sql) => ({
        run: (...args) => {
          const params = Array.isArray(args[0]) ? args[0] : args;
          return run(sql, params);
        },
        get: (...args) => {
          const params = Array.isArray(args[0]) ? args[0] : args;
          return get(sql, params);
        },
        all: (...args) => {
          const params = Array.isArray(args[0]) ? args[0] : args;
          return all(sql, params);
        },
      }),
    });
  } catch (e) {
    console.warn('[db] contact tables:', e.message);
  }

  try {
    const readFlag = db.prepare(`SELECT value FROM settings WHERE key='messages_is_read_backfill_v1'`).get();
    if (!readFlag) {
      db.run(`UPDATE messages SET is_read=1 WHERE is_read=0 OR is_read IS NULL`);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('messages_is_read_backfill_v1', '1')`);
    }
  } catch (e) { /* ignore */ }

  try {
    const presetScopeFlag = db.prepare(`SELECT value FROM settings WHERE key='preset_scopes_migrated_v1'`).get();
    if (!presetScopeFlag) {
      db.run(`UPDATE presets SET type='banned_content' WHERE type='no_preach'`);
      db.run(`UPDATE presets SET scopes='["chat","diary","memo","game","reader","moments"]' WHERE type IN ('jailbreak','banned_content')`);
      db.run(`UPDATE presets SET scopes='["chat"]' WHERE scopes IS NULL OR scopes='' OR scopes='[]'`);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('preset_scopes_migrated_v1', '1')`);
    }
  } catch (e) { /* ignore */ }

  // 一次性：为旧角色开启自动记忆总结（此前默认关导致用户以为功能坏了）
  try {
    const memOnFlag = db.prepare(`SELECT value FROM settings WHERE key='memory_summary_default_on_v1'`).get();
    if (!memOnFlag) {
      db.run(`UPDATE characters SET memory_summary_enabled=1 WHERE memory_summary_enabled=0 OR memory_summary_enabled IS NULL`);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('memory_summary_default_on_v1', '1')`);
    }
  } catch (e) { /* ignore */ }

  const defaults = [
    ['chat_api_url', ''], ['chat_api_key', ''], ['chat_model', 'gpt-4o'],
    ['chat_temperature', '0.8'], ['chat_max_tokens', '4000'],
    ['minimax_api_key', ''], ['minimax_group_id', ''], ['minimax_api_url', ''],
    ['elevenlabs_api_key', ''], ['elevenlabs_api_url', ''],
    ['sfx_vol_scene', '100'],
    ['sfx_vol_oneshot', '55'],
    ['sfx_vol_close', '20'],
    ['sfx_vol_duck', '80'],
    ['sfx_vol_call_voice', '115'],
    ['image_api_url', ''], ['image_api_key', ''],
    ['username', '旅人'], ['user_desc', ''], ['user_location', ''], ['user_birthday', ''], ['user_avatar', ''],
    ['user_selfie', ''], ['user_appearance', ''],
    ['user_gender', ''], ['user_home_address', ''], ['user_home_lat', ''], ['user_home_lng', ''],
    ['user_work_address', ''], ['user_work_lat', ''], ['user_work_lng', ''],
    ['user_persona_enabled', '0'], ['user_personas', '[]'],
    ['moments_cover', ''], ['moments_cover_crop', ''], ['moments_name_color', 'black'], ['nsfw_tags', '[]'], ['user_nsfw_note', ''], ['user_sm_role', ''],
    ['poke_user_suffix', ''],
    ['theme_color', '#c9a0dc'], ['theme_bg_type', 'gradient'], ['theme_bg_value', ''], ['pwa_icon', ''],
    ['sound_notify', ''], ['sound_call', ''], ['sound_call_system', '0'],
    ['bg_type', 'particle'], ['bg_value', ''], ['bg_overlay', 'none'], ['bg_overlay_amount', '50'], ['bg_crop', ''],
    ['timezone', 'Asia/Shanghai'], ['push_enabled', '0'],
    ['vapid_public_key', ''], ['vapid_private_key', ''], ['vapid_subject', 'mailto:nian@local.app'],
    ['proactive_msg_enabled', '1'], ['proactive_msg_hours', '24'],
    ['proactive_call_enabled', '0'], ['proactive_call_interval_days', '7'],
    ['proactive_call_max_per_period', '3'], ['busy_auto_reply_enabled', '1'],
    ['time_aware_enabled', '1'],
    ['selfie_api_enabled', '1'],
    ['natural_chat_mode', '0'],
    ['memory_trigger_n', '12'],
    ['perception_gap_hours', '6'],
    ['perception_decay_hours', '6'],
    ['understanding_timeout_ms', '3500'],
    ['color_scheme', 'auto'],
    ['diary_api_url', ''], ['diary_api_key', ''],
    ['memory_api_url', ''], ['memory_api_key', ''],
    ['dream_api_url', ''], ['dream_api_key', ''],
    ['series_api_url', ''], ['series_api_key', ''], ['series_model', ''],
    ['series_outline_model', ''], ['series_play_model', ''],
    ['series_embed_api_url', ''], ['series_embed_api_key', ''], ['series_embed_model', ''],
    ['embed_api_url', ''], ['embed_api_key', ''], ['embed_model', ''],
    ['github_token', ''], ['github_repo', ''],
    ['robot_enabled', '0'], ['robot_character_id', ''], ['robot_token', ''],
    ['robot_tts', '1'], ['robot_device_name', 'Stack-chan'],
    ['robot_presence_enabled', '1'],
    ['robot_expression_decay_sec', '12'],
    ['robot_drowsy_idle_sec', '180'],
    ['robot_face_track_enabled', '1'],
    ['robot_led_enabled', '1'],
    ['robot_led_max_brightness', '1'],
    ['robot_pitch_center', '45'],
    ['robot_mute', '0'],
    ['robot_screen_chat', '1'],
    ['phone_screen_chat', '1'],
    ['robot_sync_chat', '1'],
    ['robot_public_base_url', ''],
    ['robot_control_mode', 'mcp'],
    ['robot_mcp_base_url', 'http://127.0.0.1:8766'],
    ['robot_mcp_token', ''],
    ['toy_enabled', '0'],
    ['toy_electric', '1'],
    ['toy_feel_gentle', '20'],
    ['toy_feel_medium', '45'],
    ['toy_feel_strong', '70'],
    ['toy_hr_follow', '0'],
  ];
  for (const [k, v] of defaults) {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  }

  // 一次性：手表心率太稀，默认关掉「跟着心率走」
  const toyHrOff = db.prepare(`SELECT value FROM settings WHERE key='toy_hr_follow_off_v1'`).get();
  if (!toyHrOff) {
    try {
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('toy_hr_follow', '0')`);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('toy_hr_follow_off_v1', '1')`);
    } catch (e) { /* ignore */ }
  }

  // 一次性：旧「时空下向量」配置提升为全项目向量 API（保留 series_embed 兼容读写）
  const embedPromote = db.prepare(`SELECT value FROM settings WHERE key='embed_api_promote_v1'`).get();
  if (!embedPromote) {
    try {
      const getV = (k) => db.prepare(`SELECT value FROM settings WHERE key=?`).get(k)?.value || '';
      const setV = (k, v) => db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
      if (!String(getV('embed_api_url')).trim() && String(getV('series_embed_api_url')).trim()) {
        setV('embed_api_url', getV('series_embed_api_url'));
      }
      if (!String(getV('embed_api_key')).trim() && String(getV('series_embed_api_key')).trim()) {
        setV('embed_api_key', getV('series_embed_api_key'));
      }
      if (!String(getV('embed_model')).trim() && String(getV('series_embed_model')).trim()) {
        setV('embed_model', getV('series_embed_model'));
      }
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('embed_api_promote_v1', '1')`);
    } catch (e) { /* ignore */ }
  }

  // 一次性：桌宠屏默认显示回复台词（与禁言独立；禁言只关喇叭）
  const screenChatBump = db.prepare(`SELECT value FROM settings WHERE key='robot_screen_chat_on_v1'`).get();
  if (!screenChatBump) {
    try {
      db.run(`UPDATE settings SET value='1' WHERE key='robot_screen_chat'`);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('robot_screen_chat_on_v1', '1')`);
    } catch (e) { /* ignore */ }
  }

  // 一次性：移除已废弃的「推送豆豆眼 PNG」开关（ParamFace 只推 emotion 关键字）
  const qqFaceRemoved = db.prepare(`SELECT value FROM settings WHERE key='robot_qq_face_removed_v1'`).get();
  if (!qqFaceRemoved) {
    try {
      db.run(`DELETE FROM settings WHERE key='robot_qq_face'`);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('robot_qq_face_removed_v1', '1')`);
    } catch (e) { /* ignore */ }
  }

  // 一次性：角色主动控制走 MCP 网关
  const mcpModeBump = db.prepare(`SELECT value FROM settings WHERE key='robot_control_mode_mcp_v1'`).get();
  if (!mcpModeBump) {
    try {
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('robot_control_mode', 'mcp')`);
      db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('robot_mcp_base_url', 'http://127.0.0.1:8766')`);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('robot_control_mode_mcp_v1', '1')`);
    } catch (e) { /* ignore */ }
  }

  const toyElectricOn = db.prepare(`SELECT value FROM settings WHERE key='toy_electric_on_v1'`).get();
  if (!toyElectricOn) {
    try {
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('toy_electric', '1')`);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('toy_electric_on_v1', '1')`);
    } catch (e) { /* ignore */ }
  }

  // 一次性：移除已废弃的小智对讲模式
  const xiaozhiRemoved = db.prepare(`SELECT value FROM settings WHERE key='robot_xiaozhi_removed_v2'`).get();
  if (!xiaozhiRemoved) {
    try {
      db.run(`UPDATE settings SET value='mcp' WHERE key='robot_control_mode' AND lower(value)='xiaozhi'`);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('robot_xiaozhi_removed_v2', '1')`);
    } catch (e) { /* ignore */ }
  }

  // 强制将过低的 max_tokens 更新为 4000，避免回复截断
  const tokRow = db.prepare(`SELECT value FROM settings WHERE key='chat_max_tokens'`).get();
  if (!tokRow || parseInt(tokRow.value) < 4000) {
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('chat_max_tokens', '4000')`);
  }

  // 一次性：自动生成时段回顾默认关闭（用户手动点「补回顾」才生成）
  const autoRetro = db.prepare(`SELECT value FROM settings WHERE key='schedule_auto_retrospect'`).get();
  if (!autoRetro) {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('schedule_auto_retrospect', '0')`);
  }

  // 一次性：上下文默认 10→18，记忆总结 15→12，减轻「隔十轮又问」空档
  const ctxBump = db.prepare(`SELECT value FROM settings WHERE key='ctx_rounds_bump_v1'`).get();
  if (!ctxBump) {
    try {
      db.run(`UPDATE characters SET chat_context_rounds=18 WHERE chat_context_rounds IS NULL OR chat_context_rounds=10`);
      const memTrig = db.prepare(`SELECT value FROM settings WHERE key='memory_trigger_n'`).get();
      if (memTrig && String(memTrig.value) === '15') {
        db.run(`UPDATE settings SET value='12' WHERE key='memory_trigger_n'`);
      }
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ctx_rounds_bump_v1', '1')`);
    } catch (e) { /* ignore */ }
  }

  // 一次性：把「我」里的记忆间隔 / 真人聊天 / 时间感知落到各角色（之后按角色单独改）
  const chatPrefsMig = db.prepare(`SELECT value FROM settings WHERE key='char_chat_prefs_migrated_v1'`).get();
  if (!chatPrefsMig) {
    try {
      const g = (k, fallback) => {
        const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(k);
        return row?.value != null ? String(row.value) : fallback;
      };
      const timeAware = g('time_aware_enabled', '1') === '1' ? 1 : 0;
      const naturalChat = g('natural_chat_mode', '0') === '1' ? 1 : 0;
      let memN = parseInt(g('memory_trigger_n', '12'), 10);
      if (!Number.isFinite(memN) || memN < 5) memN = 12;
      if (memN > 50) memN = 50;
      db.prepare(
        `UPDATE characters SET time_aware_enabled=?, natural_chat_mode=?, memory_trigger_n=?`
      ).run(timeAware, naturalChat, memN);
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('char_chat_prefs_migrated_v1', '1')`);
    } catch (e) { /* ignore */ }
  }

  // 一次性：时区 / 主动联络从「我」落到角色；关掉全局总闸时同步关掉角色开关
  const contactPrefsMig = db.prepare(`SELECT value FROM settings WHERE key='char_contact_prefs_migrated_v1'`).get();
  if (!contactPrefsMig) {
    try {
      const g = (k, fallback) => {
        const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(k);
        return row?.value != null ? String(row.value) : fallback;
      };
      const tz = g('timezone', 'Asia/Shanghai') || 'Asia/Shanghai';
      let callDays = parseInt(g('proactive_call_interval_days', '7'), 10);
      if (!Number.isFinite(callDays) || callDays < 1) callDays = 7;
      if (callDays > 30) callDays = 30;
      db.prepare(`UPDATE characters SET timezone=?, proactive_call_interval_days=?`).run(tz, callDays);
      if (g('proactive_msg_enabled', '1') === '0') {
        db.run(`UPDATE characters SET proactive_msg_enabled=0`);
      }
      if (g('proactive_call_enabled', '0') !== '1') {
        db.run(`UPDATE characters SET proactive_call_enabled=0`);
      }
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('char_contact_prefs_migrated_v1', '1')`);
    } catch (e) { /* ignore */ }
  }

  saveDBSync();
  console.log('[db] 数据库初始化完成');
}

// ===== 持久化 =====
let _saveTimer = null;
let _saveInFlight = false;
let _saveQueued = false;
let _saveBatchDepth = 0;

function countCharactersSafe(database) {
  try {
    const res = database.exec('SELECT COUNT(*) FROM characters');
    return res?.[0]?.values?.[0]?.[0] ?? 0;
  } catch {
    return -1;
  }
}

function saveDBSync() {
  if (!db) return;
  // 内存库 characters 被掏空时，禁止覆盖磁盘上仍有角色的主库
  try {
    if (SQL && fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0) {
      const memChars = countCharactersSafe(db);
      if (memChars === 0) {
        const diskDb = new SQL.Database(fs.readFileSync(DB_PATH));
        const diskChars = countCharactersSafe(diskDb);
        diskDb.close();
        if (diskChars > 0) {
          console.error(`[db] 拒绝落盘：内存 characters=0，但磁盘仍有 ${diskChars} 个角色`);
          return;
        }
      }
    }
  } catch (e) {
    console.warn('[db] save guard', e.message);
  }
  const data = db.export();
  // 唯一临时文件名：避免 sync/async 落盘同时抢同一个 .tmp 导致 rename ENOENT
  const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.sync.tmp`;
  fs.writeFileSync(tmpPath, Buffer.from(data));
  try {
    fs.renameSync(tmpPath, DB_PATH);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

/** 合并短时间内的多次写入，避免每条消息都同步导出整库（会卡死 Node 事件循环） */
function scheduleSaveDB() {
  if (_saveBatchDepth > 0) return;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    void flushSaveDBAsync();
  }, 5000);
}

/** 异步落盘：export 仍同步，但 writeFile 不阻塞事件循环 */
async function flushSaveDBAsync() {
  if (!db) return;
  if (_saveInFlight) {
    _saveQueued = true;
    return;
  }
  _saveInFlight = true;
  try {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const data = db.export();
    await new Promise((r) => setImmediate(r));
    // 唯一临时文件名：避免与 saveDBSync 抢同一个 .tmp 导致 rename ENOENT
    const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.async.tmp`;
    await fs.promises.writeFile(tmpPath, Buffer.from(data));
    try {
      await fs.promises.rename(tmpPath, DB_PATH);
    } catch (e) {
      try { await fs.promises.unlink(tmpPath); } catch {}
      throw e;
    }
  } catch (e) {
    console.error('[db] save failed', e.message);
  } finally {
    _saveInFlight = false;
    if (_saveQueued) {
      _saveQueued = false;
      void flushSaveDBAsync();
    }
  }
}

function flushSaveDB() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  saveDBSync();
}

function beginSaveBatch() {
  _saveBatchDepth++;
}

function endSaveBatch() {
  if (_saveBatchDepth > 0) _saveBatchDepth--;
  if (_saveBatchDepth === 0) scheduleSaveDB();
}

// Auto-save every 30 seconds（异步，避免周期性卡死）
setInterval(() => { void flushSaveDBAsync(); }, 30000);

// 每 6 小时额外存一份「健康快照」备份，防的是逻辑 bug/误操作清空数据（而不只是进程被杀写坏文件）
setInterval(() => { backupDBFile('periodic'); }, 6 * 60 * 60 * 1000);

// Save on process exit
process.on('exit', () => { try { flushSaveDB(); } catch {} });
process.on('SIGINT', () => { flushSaveDB(); process.exit(0); });
process.on('SIGTERM', () => { flushSaveDB(); process.exit(0); });

// ===== Query helpers (synchronous) =====

function run(sql, params = []) {
  db.run(sql, params);
  const changes = typeof db.getRowsModified === 'function' ? db.getRowsModified() : 0;
  scheduleSaveDB();
  return { lastInsertRowid: getLastInsertId(), changes };
}

function getLastInsertId() {
  const res = db.exec('SELECT last_insert_rowid() as id');
  return res[0]?.values[0][0] || null;
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    stmt.free();
    const obj = {};
    cols.forEach((c, i) => obj[c] = vals[i]);
    return obj;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

function exec(sql) {
  db.run(sql);
}

// ===== Prepared statement emulation =====
function prepare(sql) {
  return {
    run: (...args) => {
      const params = Array.isArray(args[0]) ? args[0] : args;
      return run(sql, params);
    },
    get: (...args) => {
      const params = Array.isArray(args[0]) ? args[0] : args;
      return get(sql, params);
    },
    all: (...args) => {
      const params = Array.isArray(args[0]) ? args[0] : args;
      return all(sql, params);
    },
  };
}

module.exports = { initDB, run, get, all, exec, prepare, saveDB: flushSaveDB, beginSaveBatch, endSaveBatch, getDB: () => db, backupDBFile };

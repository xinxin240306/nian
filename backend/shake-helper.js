/** 摇一摇：生成陌生人角色、好友申请异步决定、主动申请 */

const contacts = require('./contact-helper');

function ensureShakeTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shake_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      character_id INTEGER NOT NULL,
      request_id INTEGER DEFAULT NULL,
      run_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  try { db.exec(`ALTER TABLE characters ADD COLUMN source TEXT DEFAULT ''`); } catch {}
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function delayMinutes(min, max) {
  const a = Math.max(0.5, Number(min) || 1);
  const b = Math.max(a, Number(max) || a);
  return a + Math.random() * (b - a);
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const FALLBACK_PERSONAS = [
  {
    name: '阿迟',
    gender: '男',
    intro: '刚晃过来的路人，看起来有点困。',
    personality: '慢热、话少、偶尔突然认真',
    language_style: '短句，口语，偶尔吐槽',
    background: '在附近晃荡，手机差点掉地上才和你对上。',
    behavior: '先观察再开口，不会一上来太热情',
    opening: '……你也在摇？',
  },
  {
    name: '南星',
    gender: '女',
    intro: '笑起来很亮的陌生人。',
    personality: '外向、好奇、有点八卦但不冒犯',
    language_style: '轻快，爱用语气词',
    background: '无聊瞎摇，结果真摇到人了。',
    behavior: '爱问问题，但尊重边界',
    opening: '哇真的有人！你好呀～',
  },
  {
    name: '顾晚',
    gender: '女',
    intro: '安静的夜猫子感。',
    personality: '内敛、细腻、防备心先开着',
    language_style: '克制，句子干净',
    background: '睡前随手摇了一下。',
    behavior: '先冷后暖，被逗开心才会多说',
    opening: '你好。是摇一摇吗。',
  },
  {
    name: '周野',
    gender: '男',
    intro: '像刚下课或刚下班的人。',
    personality: '直爽、好说话、有点糙',
    language_style: '大白话，偶尔开玩笑',
    background: '等人的空隙里摇着玩。',
    behavior: '聊得来就继续，不来就不硬撑',
    opening: '嘿，摇到你了。',
  },
];

function pickFallbackPersona() {
  return FALLBACK_PERSONAS[Math.floor(Math.random() * FALLBACK_PERSONAS.length)];
}

async function generateShakePersona({ callChatAPIComplete, settings }) {
  const system = `你是角色设定生成器。为「摇一摇」随机生成一个可聊天的陌生人角色。
要求：像现实里偶然碰到的人，不要名人/系统/AI人设；中文；不要血腥暴力设定。
只输出一个 JSON 对象，不要 markdown：
{"name":"2-4字中文名","gender":"男|女|其他","intro":"一句话简介","personality":"性格","language_style":"说话风格","background":"简短背景","behavior":"行为习惯","opening":"见面第一句（可空）"}`;
  const user = `随机来一个今天可能晃到的普通人。时间戳种子：${Date.now()}`;
  let raw = null;
  try {
    raw = await callChatAPIComplete(settings, system, user, 'chat');
  } catch (e) {
    console.warn('[shake] persona llm', e.message);
  }
  const j = parseJsonObject(raw) || {};
  const fb = pickFallbackPersona();
  const name = String(j.name || fb.name).trim().slice(0, 12) || fb.name;
  return {
    name,
    gender: String(j.gender || fb.gender || '').trim().slice(0, 8),
    intro: String(j.intro || fb.intro || '').trim().slice(0, 80),
    personality: String(j.personality || fb.personality || '').trim().slice(0, 200),
    language_style: String(j.language_style || fb.language_style || '').trim().slice(0, 120),
    background: String(j.background || fb.background || '').trim().slice(0, 240),
    behavior: String(j.behavior || fb.behavior || '').trim().slice(0, 200),
    opening: String(j.opening || fb.opening || '').trim().slice(0, 80),
  };
}

function insertShakeCharacter(db, persona) {
  ensureShakeTables(db);
  const description = [
    persona.personality && `【性格】${persona.personality}`,
    persona.background && `【背景】${persona.background}`,
    persona.behavior && `【行为模式】${persona.behavior}`,
  ].filter(Boolean).join('\n');
  const relationship = '陌生人（摇一摇认识）';
  const r = db.prepare(`
    INSERT INTO characters (
      name, avatar, intro, opening, language_style, location_name, real_location,
      description, personality, background, behavior, relationship, relationship_custom,
      voice_id, voice_messages, memory_trigger_n, memory_summary_enabled, busy_style,
      allow_diary, post_moments, mutual_characters, image_ref, image_style,
      nsfw_enabled, nsfw_tags, nsfw_note, dream_affects_memory, birthday, anniversary,
      status, emoji_categories, memory_weights, worldbook_ids,
      proactive_msg_enabled, proactive_msg_minutes, proactive_call_enabled, emoji_enabled
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    persona.name, '', persona.intro || '', persona.opening || '', persona.language_style || '',
    '', '',
    description, persona.personality || '', persona.background || '', persona.behavior || '',
    relationship, '',
    '', 0, 10, 1, 'gentle',
    0, 0, '[]', '[]', 'anime',
    1, '[]', '', 0, '', '',
    'online', '[]', '{}', '[]',
    0, 60, 0, 1
  );
  const id = r.lastInsertRowid;
  try {
    db.prepare('UPDATE characters SET source=?, relationship=?, emotion_style=? WHERE id=?')
      .run('shake', relationship, persona.gender ? `性别倾向：${persona.gender}` : '', id);
  } catch {
    try { db.prepare('UPDATE characters SET relationship=? WHERE id=?').run(relationship, id); } catch {}
  }
  contacts.ensureContactRow(db, id, contacts.STATUS.STRANGER);
  return db.prepare('SELECT * FROM characters WHERE id=?').get(id);
}

async function createShakeMeet(db, deps = {}) {
  ensureShakeTables(db);
  const { callChatAPIComplete, getSettings } = deps;
  const settings = typeof getSettings === 'function' ? getSettings() : {};
  const persona = await generateShakePersona({ callChatAPIComplete, settings });
  const row = insertShakeCharacter(db, persona);
  const enriched = contacts.enrichCharacter(db, row);
  return { character: enriched, persona };
}

function enqueueFriendDecideJob(db, characterId, requestId) {
  ensureShakeTables(db);
  const mins = delayMinutes(1.5, 8);
  const runAt = new Date(Date.now() + mins * 60000).toISOString();
  // 取消同角色未完成的决定任务
  try {
    db.prepare(
      `UPDATE shake_jobs SET done=1 WHERE kind='friend_decide' AND character_id=? AND done=0`
    ).run(characterId);
  } catch {}
  const r = db.prepare(
    `INSERT INTO shake_jobs (kind, character_id, request_id, run_at, done) VALUES (?,?,?,?,0)`
  ).run('friend_decide', characterId, requestId || null, runAt);
  return { id: r.lastInsertRowid, runAt };
}

function recentChatSnippet(db, characterId, limit = 12) {
  const rows = db.prepare(`
    SELECT role, content FROM messages
    WHERE character_id=? AND is_dream=0 AND recalled=0 AND role IN ('user','assistant')
    ORDER BY id DESC LIMIT ?
  `).all(characterId, limit).reverse();
  return rows.map((m) => {
    const who = m.role === 'user' ? '用户' : '你';
    return `${who}：${String(m.content || '').replace(/\s+/g, ' ').slice(0, 100)}`;
  }).join('\n');
}

async function decideFriendRequest(db, job, deps = {}) {
  const { callChatAPIComplete, getSettings, push } = deps;
  const req = db.prepare('SELECT * FROM friend_requests WHERE id=?').get(job.request_id);
  if (!req || req.status !== 'pending' || req.direction !== 'from_user') {
    return { skipped: true };
  }
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(job.character_id);
  if (!char) return { skipped: true };
  if (contacts.getContactStatus(db, char.id) === contacts.STATUS.FRIEND) {
    db.prepare(`UPDATE friend_requests SET status='accepted', responded_at=? WHERE id=?`)
      .run(new Date().toISOString(), req.id);
    return { accepted: true, alreadyFriend: true };
  }

  const settings = typeof getSettings === 'function' ? getSettings() : {};
  const chat = recentChatSnippet(db, char.id, 14);
  const system = `你在扮演角色「${char.name}」，根据性格与聊天感受，决定是否同意用户的好友申请。
只输出 JSON：{"decision":"accept"|"reject","reason":"一句对用户可见的短理由（中文，可温柔可直接）"}
倾向：聊得来、不讨厌就更可能同意；冷淡/防备性格可以拒绝；刚认识几乎没聊也可以犹豫后拒绝或勉强同意。`;
  const user = `性格：${char.personality || '未知'}
说话风格：${char.language_style || ''}
背景：${char.background || ''}
关系设定：${char.relationship || '陌生人'}
申请附言：${req.message || '我想加你为好友'}
近期聊天：
${chat || '（几乎还没聊过）'}`;

  let decision = 'accept';
  let reason = '';
  try {
    const raw = await callChatAPIComplete(settings, system, user, 'chat');
    const j = parseJsonObject(raw) || {};
    const d = String(j.decision || '').toLowerCase();
    if (d.startsWith('rej') || d === 'no' || d === '拒绝') decision = 'reject';
    else decision = 'accept';
    reason = String(j.reason || '').trim().slice(0, 80);
  } catch (e) {
    console.warn('[shake] decide llm', e.message);
    // 无模型时：聊过几句就同意，否则一半概率
    const msgCount = db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE character_id=? AND is_dream=0 AND recalled=0`
    ).get(char.id)?.n || 0;
    decision = msgCount >= 4 || Math.random() < 0.55 ? 'accept' : 'reject';
    reason = decision === 'accept' ? '好啊，加吧。' : '还不太熟，先这样聊就好。';
  }

  const t = new Date().toISOString();
  if (decision === 'accept') {
    contacts.addFriend(db, char.id);
    db.prepare(`UPDATE friend_requests SET status='accepted', responded_at=? WHERE id=?`).run(t, req.id);
    try {
      push?.('friend_request_result', {
        characterId: char.id,
        requestId: req.id,
        accepted: true,
        message: reason || `${char.name} 通过了你的好友申请`,
      });
    } catch {}
    return { accepted: true, reason };
  }

  db.prepare(`UPDATE friend_requests SET status='rejected', responded_at=? WHERE id=?`).run(t, req.id);
  try {
    push?.('friend_request_result', {
      characterId: char.id,
      requestId: req.id,
      accepted: false,
      message: reason || `${char.name} 婉拒了你的好友申请`,
    });
  } catch {}
  return { accepted: false, reason };
}

async function processDueShakeJobs(db, deps = {}) {
  ensureShakeTables(db);
  const nowIso = new Date().toISOString();
  const due = db.prepare(
    `SELECT * FROM shake_jobs WHERE done=0 AND run_at <= ? ORDER BY id ASC LIMIT 8`
  ).all(nowIso);
  let processed = 0;
  for (const job of due) {
    try {
      db.prepare('UPDATE shake_jobs SET done=1 WHERE id=?').run(job.id);
      if (job.kind === 'friend_decide') {
        await decideFriendRequest(db, job, deps);
        processed += 1;
      }
    } catch (e) {
      console.warn('[shake] job', job.id, e.message);
    }
  }
  return { processed };
}

/** 摇一摇陌生人：聊过几句后低概率主动加好友 */
function maybeShakeProactiveFriendRequests(db, push) {
  ensureShakeTables(db);
  const strangers = db.prepare(`
    SELECT c.id, c.name FROM characters c
    INNER JOIN user_contacts uc ON uc.character_id = c.id
    WHERE uc.status = 'stranger'
      AND COALESCE(c.source, '') = 'shake'
      AND COALESCE(uc.peer_status, 'ok') = 'ok'
  `).all();
  let n = 0;
  for (const c of strangers) {
    const msgCount = db.prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE character_id=? AND is_dream=0 AND recalled=0 AND role IN ('user','assistant')`
    ).get(c.id)?.n || 0;
    if (msgCount < 6) continue;
    if (Math.random() > 0.12) continue;
    const created = contacts.createFriendRequest(db, c.id, {
      direction: 'from_char',
      message: '加个好友？以后也好找你。',
    });
    if (created && !created.already) {
      n += 1;
      try {
        push?.('friend_request', { characterId: c.id, requestId: created.id });
      } catch {}
    }
  }
  return n;
}

module.exports = {
  ensureShakeTables,
  createShakeMeet,
  enqueueFriendDecideJob,
  processDueShakeJobs,
  maybeShakeProactiveFriendRequests,
  generateShakePersona,
};

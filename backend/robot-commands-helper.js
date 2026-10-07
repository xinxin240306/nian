/**
 * 桌宠下行指令队列：念 → 小机/桥接轮询拉取
 */

const db = require('./db');
const { push } = require('./push');
const { servoPayloadFromMotion } = require('./robot-helper');

/**
 * 只有真机（经 MCP 网关）做得到的：喇叭出声、开摄像头。
 * 念内置桥不得 ack 这些，否则角色的声音和视线永远送不出去。
 */
const DEVICE_COMMAND_TYPES = ['speak', 'glance', 'snapshot', 'load_face', 'reset_face', 'follow', 'listen'];
/** 念内置桥镜像进屏幕缓存、供插件轮询 /api/robot/screen 的 */
const SCREEN_COMMAND_TYPES = ['display', 'led', 'servo', 'refresh_settings'];

function normalizeTypeFilter(types) {
  if (!types) return null;
  const list = (Array.isArray(types) ? types : String(types).split(','))
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  return list.length ? list : null;
}

function ensureRobotCommandsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS robot_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      command_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      acked_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_robot_commands_pending
      ON robot_commands(character_id, status, id);
  `);
}

function enqueueCommand(characterId, commandType, payload = {}) {
  ensureRobotCommandsTable();
  const cid = parseInt(characterId, 10);
  if (!cid) return null;
  const type = String(commandType || '').trim();
  if (!type) return null;
  const json = JSON.stringify(payload && typeof payload === 'object' ? payload : {});
  const id = db.prepare(
    `INSERT INTO robot_commands (character_id, command_type, payload, status) VALUES (?,?,?,?)`
  ).run(cid, type, json, 'pending').lastInsertRowid;
  const row = db.prepare('SELECT * FROM robot_commands WHERE id=?').get(id);
  try {
    push('robot_command', {
      characterId: cid,
      commandId: id,
      commandType: type,
      payload: JSON.parse(row.payload || '{}'),
    });
  } catch {}
  // 内置桥在跑的话立刻推一次下行，别让这条指令干等下一次轮询
  try {
    require('./robot-mcp-bridge').kickRobotMcpBridge?.();
  } catch {}
  return row;
}

function enqueueMany(characterId, commands = []) {
  const out = [];
  for (const c of commands) {
    if (!c?.type) continue;
    const row = enqueueCommand(characterId, c.type, c.payload || {});
    if (row) out.push(row);
  }
  return out;
}

function getPendingCommands(characterId, limit = 20, opts = {}) {
  ensureRobotCommandsTable();
  const cid = parseInt(characterId, 10);
  if (!cid) return [];
  const types = normalizeTypeFilter(opts.types);
  const n = Math.max(1, Math.min(50, limit));
  const rows = types
    ? db.prepare(
      `SELECT id, character_id, command_type, payload, status, created_at
       FROM robot_commands WHERE character_id=? AND status='pending'
         AND command_type IN (${types.map(() => '?').join(',')})
       ORDER BY id ASC LIMIT ?`
    ).all(cid, ...types, n)
    : db.prepare(
      `SELECT id, character_id, command_type, payload, status, created_at
       FROM robot_commands WHERE character_id=? AND status='pending'
       ORDER BY id ASC LIMIT ?`
    ).all(cid, n);
  return rows.map((r) => ({
    id: r.id,
    characterId: r.character_id,
    type: r.command_type,
    payload: (() => {
      try { return JSON.parse(r.payload || '{}'); } catch { return {}; }
    })(),
    createdAt: r.created_at,
  }));
}

/**
 * @param {number[]} ids
 * @param {{ types?: string[] }} [opts] 限定只能 ack 这些类型，避免某个消费方
 *   把别人该做的指令一并勾掉（内置桥吞掉 speak/glance 就是这么来的）
 */
function ackCommands(ids = [], opts = {}) {
  ensureRobotCommandsTable();
  const now = new Date().toISOString();
  const types = normalizeTypeFilter(opts.types);
  let n = 0;
  for (const raw of ids) {
    const id = parseInt(raw, 10);
    if (!id) continue;
    const r = types
      ? db.prepare(
        `UPDATE robot_commands SET status='acked', acked_at=?
         WHERE id=? AND status='pending' AND command_type IN (${types.map(() => '?').join(',')})`
      ).run(now, id, ...types)
      : db.prepare(
        `UPDATE robot_commands SET status='acked', acked_at=? WHERE id=? AND status='pending'`
      ).run(now, id);
    n += r.changes || 0;
  }
  return n;
}

/**
 * 没人来取的指令不能永远 pending：小机离线一晚，第二天上线不该把积压的
 * 「想你」全补播一遍。超时标记 expired。
 */
function expireStalePending(maxAgeSec = 300) {
  ensureRobotCommandsTable();
  const sec = Math.max(30, Number(maxAgeSec) || 300);
  try {
    const r = db.prepare(
      `UPDATE robot_commands SET status='expired', acked_at=?
       WHERE status='pending' AND created_at < datetime('now', ?)`
    ).run(new Date().toISOString(), `-${sec} seconds`);
    return r.changes || 0;
  } catch {
    return 0;
  }
}

function pruneOldCommands(maxAgeDays = 7) {
  ensureRobotCommandsTable();
  try {
    db.prepare(
      `DELETE FROM robot_commands WHERE status IN ('acked','expired') AND acked_at < datetime('now', ?)`
    ).run(`-${maxAgeDays} days`);
  } catch {}
}

function enqueueSettingsRefresh(characterId) {
  return enqueueCommand(characterId, 'refresh_settings', { reason: 'settings_changed' });
}

function enqueueGlance(characterId, reason = 'outreach') {
  return enqueueCommand(characterId, 'glance', { reason });
}

function enqueueDisplay(characterId, payload) {
  return enqueueCommand(characterId, 'display', payload);
}

function enqueueSpeak(characterId, payload) {
  return enqueueCommand(characterId, 'speak', payload);
}

function enqueueSnapshot(characterId, payload) {
  return enqueueCommand(characterId, 'snapshot', payload);
}

function enqueueLoadFace(characterId, payload) {
  return enqueueCommand(characterId, 'load_face', payload);
}

function enqueueResetFace(characterId, payload = {}) {
  return enqueueCommand(characterId, 'reset_face', payload);
}

function enqueueLed(characterId, payload) {
  return enqueueCommand(characterId, 'led', payload);
}

function enqueueServo(characterId, payload) {
  return enqueueCommand(characterId, 'servo', payload);
}

/**
 * 从 parseRobotDirectives 结果生成灯光/舵机下行指令
 */
function hardwareCommandsFromParsed(parsed) {
  const out = [];
  if (!parsed || typeof parsed !== 'object') return out;
  if (parsed.led) out.push({ type: 'led', payload: parsed.led });
  if (parsed.servo) {
    out.push({ type: 'servo', payload: parsed.servo });
  } else {
    const servo = servoPayloadFromMotion(parsed);
    if (servo) out.push({ type: 'servo', payload: servo });
  }
  return out;
}

function enqueueHardwareFromParsed(characterId, parsed) {
  return enqueueMany(characterId, hardwareCommandsFromParsed(parsed));
}

module.exports = {
  DEVICE_COMMAND_TYPES,
  SCREEN_COMMAND_TYPES,
  ensureRobotCommandsTable,
  enqueueCommand,
  enqueueMany,
  getPendingCommands,
  ackCommands,
  expireStalePending,
  pruneOldCommands,
  enqueueSettingsRefresh,
  enqueueGlance,
  enqueueDisplay,
  enqueueSpeak,
  enqueueSnapshot,
  enqueueLoadFace,
  enqueueResetFace,
  enqueueLed,
  enqueueServo,
  hardwareCommandsFromParsed,
  enqueueHardwareFromParsed,
};

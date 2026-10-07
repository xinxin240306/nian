const fs = require('fs');
const path = require('path');
const initSqlJs = require('./node_modules/sql.js');

(async () => {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(path.join(__dirname, 'nian.db'));
  const db = new SQL.Database(buf);
  const keys = [
    'robot_enabled', 'robot_control_mode', 'robot_mcp_base_url', 'robot_character_id',
    'robot_token', 'public_base_url', 'robot_public_base_url', 'robot_device_name',
    'robot_face_track_enabled', 'robot_emotion_sense_enabled', 'robot_mcp_token',
  ];
  const q = db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`);
  q.bind(keys);
  console.log('SETTINGS');
  while (q.step()) {
    const r = q.getAsObject();
    const v = String(r.value || '');
    if (r.key === 'robot_token' || r.key === 'robot_mcp_token') {
      console.log(r.key, v ? `len=${v.length}` : '(empty)');
    } else {
      console.log(`${r.key} = ${v}`);
    }
  }
  q.free();

  try {
    const cmds = db.exec(
      "SELECT id, character_id, command_type, payload, status, created_at, acked_at FROM robot_commands ORDER BY id DESC LIMIT 20"
    );
    console.log('COMMANDS');
    if (cmds[0]) {
      console.log(cmds[0].columns.join(' | '));
      for (const row of cmds[0].values) {
        console.log(row.map((x) => (typeof x === 'string' && x.length > 120 ? `${x.slice(0, 120)}…` : x)).join(' | '));
      }
    } else {
      console.log('(empty table or no rows)');
    }
  } catch (e) {
    console.log('commands err', e.message);
  }
  db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

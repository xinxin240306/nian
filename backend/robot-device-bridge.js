/**
 * 桌宠设备桥：轮询指令队列、刷新屏幕状态、维持心跳
 */

const robotScreen = require('./robot-screen-helper');

let _timer = null;
let _running = false;

function resolvePublicBase(settings = {}, fallback = '') {
  const fromSet = String(settings.public_base_url || settings.robot_public_base_url || '').trim();
  if (fromSet) return fromSet.replace(/\/$/, '');
  const fb = String(fallback || '').trim();
  if (fb) return fb.replace(/\/$/, '');
  const port = Number(process.env.PORT) || 3000;
  return `http://127.0.0.1:${port}`;
}

function processCommand(cmd, characterId, publicBase) {
  const type = String(cmd?.type || '').trim();
  const p = cmd?.payload || {};
  if (type === 'display') {
    robotScreen.applyDisplayCommand(characterId, p, publicBase);
    return true;
  }
  if (type === 'led') {
    const cur = robotScreen.getScreen(characterId);
    robotScreen.setScreen(characterId, { ...cur, led: p, source: 'led' }, publicBase);
    return true;
  }
  if (type === 'servo') {
    const cur = robotScreen.getScreen(characterId);
    robotScreen.setScreen(characterId, {
      ...cur,
      servo: p,
      motion: p.motion || p.action || cur.motion,
      motionRaw: p.raw || p.motionRaw || cur.motionRaw,
      source: 'servo',
    }, publicBase);
    return true;
  }
  if (type === 'refresh_settings') {
    return false;
  }
  return false;
}

let _lastTtsPruneAt = 0;

/** 角色主动说话的 mp3 会落盘给插件下载，一小时清一次过期的 */
function maybePruneTts(deps) {
  if (Date.now() - _lastTtsPruneAt < 3600000) return;
  _lastTtsPruneAt = Date.now();
  try {
    deps?.robotDriveHelper?.pruneRobotSpeechFiles?.();
  } catch {}
}

async function tick(deps) {
  if (_running) return;
  _running = true;
  try {
    const {
      getSettings,
      robotCommands,
      robotDriveHelper,
      robotHelper,
      db,
      publicBaseFallback,
    } = deps;

    const settings = getSettings();
    if (String(settings.robot_enabled || '0') !== '1') return;

    const characterId = parseInt(settings.robot_character_id, 10);
    if (!characterId) return;

    const publicBase = resolvePublicBase(settings, publicBaseFallback);
    const token = String(settings.robot_token || '').trim();
    if (!token) return;

    const char = db.prepare('SELECT id, robot_emotions FROM characters WHERE id=?').get(characterId);
    if (!char) return;

    const face = robotHelper.buildFacePayload(settings, char.robot_emotions);
    const cur = robotScreen.getScreen(characterId);
    if (!cur.emotion && face.emotion) {
      robotScreen.setScreen(characterId, {
        emotion: face.emotion,
        source: cur.source || 'idle',
      }, publicBase);
    }

    // 只取自己处理得了的类型
    // 以前这里无条件 ack 全部，角色的声音和视线在 8 秒内被静默丢弃。
    const cmds = robotCommands.getPendingCommands(characterId, 30, {
      types: robotCommands.SCREEN_COMMAND_TYPES,
    });
    const mcpMode = String(settings.robot_control_mode || '').trim().toLowerCase() === 'mcp';
    const ackIds = [];
    for (const cmd of cmds) {
      if (!cmd?.id) continue;
      // refresh_settings 没有落地动作，但取到就算消费掉，不留在队列里
      const handled = processCommand(cmd, characterId, publicBase) || cmd.type === 'refresh_settings';
      if (!handled) continue;
      // MCP 模式下舵机/灯光由 MCP 桥 move_head / set_all_leds，这里只镜像屏幕、不抢 ack
      if (mcpMode && (cmd.type === 'servo' || cmd.type === 'led')) continue;
      ackIds.push(cmd.id);
    }
    if (ackIds.length) {
      robotCommands.ackCommands(ackIds, { types: robotCommands.SCREEN_COMMAND_TYPES });
    }

    const staleSec = Number(process.env.ROBOT_COMMAND_TTL_SEC) || 300;
    robotCommands.expireStalePending(staleSec);
    maybePruneTts(deps);
  } catch (e) {
    console.warn('[robot-bridge] tick', e.message);
  } finally {
    _running = false;
  }
}

function startRobotDeviceBridge(deps, opts = {}) {
  stopRobotDeviceBridge();
  const intervalMs = Math.max(3000, Number(opts.intervalMs) || Number(process.env.ROBOT_BRIDGE_INTERVAL_MS) || 8000);
  const enabled = opts.enabled !== false
    && String(process.env.ROBOT_BRIDGE_DISABLED || '0') !== '1'
    && String(process.env.ROBOT_BRIDGE_ENABLED || '1') !== '0';

  if (!enabled) {
    console.log('[robot-bridge] 未启动（ROBOT_BRIDGE_DISABLED=1 或 enabled=false）');
    return;
  }

  const run = () => { tick(deps).catch(() => {}); };
  run();
  _timer = setInterval(run, intervalMs);
  if (_timer.unref) _timer.unref();
  console.log(`[robot-bridge] 已启动，每 ${intervalMs}ms 轮询指令并刷新屏幕状态`);
}

function stopRobotDeviceBridge() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

function syncScreenFromChat(characterId, data, publicBase) {
  const id = parseInt(characterId, 10);
  if (!id || !data) return null;
  return robotScreen.applyChatResult(id, data, publicBase);
}

module.exports = {
  startRobotDeviceBridge,
  stopRobotDeviceBridge,
  syncScreenFromChat,
  resolvePublicBase,
  processCommand,
};

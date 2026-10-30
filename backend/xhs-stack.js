/**
 * 一键拉起三样：虚拟屏幕、小红书 MCP、画面桥。
 * 只在跑念后端的 Linux 上启动。程序路径不从请求里拿。
 */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const screen = require('./xhs-screen-helper');

const DISPLAY = ':99';
const SCREEN_URL = 'http://127.0.0.1:8767';
const MCP_URL = 'http://127.0.0.1:18060/mcp';
const MCP_PORT = 18060;
const SCREEN_PORT = 8767;

let _starting = null;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, env: process.env }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(String(stderr || err.message || cmd).trim().slice(0, 240));
        reject(e);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

function mcpCandidates() {
  return [
    process.env.XHS_MCP_BIN,
    '/usr/local/bin/xiaohongshu-mcp',
    '/usr/local/bin/xhs-mcp',
    path.join(__dirname, 'xiaohongshu-mcp'),
  ].filter(Boolean);
}

function findMcpBin() {
  for (const file of mcpCandidates()) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return '';
}

function logPath() {
  return path.join(os.tmpdir(), 'nian-xhs-stack.log');
}

function spawnDetached(cmd, args, env) {
  const log = fs.openSync(logPath(), 'a');
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ...env },
  });
  child.on('error', (err) => {
    try {
      fs.appendFileSync(logPath(), `\n启动 ${cmd} 失败：${err.message}\n`);
    } catch {}
  });
  child.unref();
  return child.pid;
}

async function displayUp() {
  try {
    await run('xdpyinfo', ['-display', DISPLAY]);
    return true;
  } catch {
    return false;
  }
}

function ensureScreenToken(getSettings, setSetting) {
  const current = String(getSettings()?.[screen.TOKEN_KEY] || '').trim();
  if (current.length >= 8) return current;
  const token = crypto.randomBytes(18).toString('hex');
  setSetting(screen.TOKEN_KEY, token);
  return token;
}

function rememberAddresses(getSettings, setSetting) {
  setSetting(screen.URL_KEY, SCREEN_URL);
  const mcp = require('./mcp-client-helper');
  const servers = mcp.loadServers(getSettings);
  const hit = servers.find((s) => String(s.url || '').replace(/\/+$/, '') === MCP_URL);
  if (!hit) {
    mcp.upsertServer(getSettings, setSetting, {
      name: '小红书',
      url: MCP_URL,
      enabled: true,
      token: '',
    });
  }
}

async function doStart(getSettings, setSetting) {
  if (process.platform !== 'linux') {
    const err = new Error('一键启动要在跑念后端的 Linux 云服务器上用。这台不是 Linux，虚拟屏幕起不来。');
    err.code = 'platform';
    throw err;
  }

  const started = [];
  const already = [];
  const token = ensureScreenToken(getSettings, setSetting);

  if (await displayUp()) {
    already.push('虚拟屏幕');
  } else {
    spawnDetached('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-ac'], { DISPLAY });
    started.push('虚拟屏幕');
  }

  if (await portOpen(SCREEN_PORT)) {
    already.push('画面桥');
  } else {
    spawnDetached(process.execPath, [path.join(__dirname, 'xhs-screen-bridge.js')], {
      DISPLAY,
      XHS_SCREEN_TOKEN: token,
      XHS_SCREEN_HOST: '127.0.0.1',
      XHS_SCREEN_PORT: String(SCREEN_PORT),
    });
    started.push('画面桥');
  }

  let mcpNote = '';
  if (await portOpen(MCP_PORT)) {
    already.push('小红书 MCP');
  } else {
    const bin = findMcpBin();
    if (!bin) {
      mcpNote = '没找到小红书 MCP 程序。放到 /usr/local/bin/xiaohongshu-mcp 后再按一次。';
    } else {
      spawnDetached(bin, [], { DISPLAY });
      started.push('小红书 MCP');
    }
  }

  await new Promise((r) => setTimeout(r, 800));
  const xvfbOk = await displayUp();
  const screenOk = await portOpen(SCREEN_PORT);
  const mcpOk = await portOpen(MCP_PORT);
  rememberAddresses(getSettings, setSetting);

  const lines = [];
  lines.push(xvfbOk ? '虚拟屏幕在跑。' : '虚拟屏幕没起来。这台机器要先装 Xvfb。');
  lines.push(screenOk ? '画面桥在跑，地址已填好。' : '画面桥没起来。');
  if (mcpOk) lines.push('小红书 MCP 在跑，MCP 页里已有「小红书」。');
  else if (mcpNote) lines.push(mcpNote);
  else lines.push('小红书 MCP 没起来。看临时目录里的 nian-xhs-stack.log。');
  if (xvfbOk && screenOk) lines.push('第一次登录时，刷新这页看画面。');

  return {
    ok: xvfbOk && screenOk,
    url: SCREEN_URL,
    mcpUrl: MCP_URL,
    hasToken: true,
    started,
    already,
    note: lines.join(''),
  };
}

function startAll(getSettings, setSetting) {
  if (_starting) return _starting;
  _starting = doStart(getSettings, setSetting).finally(() => {
    _starting = null;
  });
  return _starting;
}

module.exports = {
  startAll,
  SCREEN_URL,
  MCP_URL,
  findMcpBin,
};

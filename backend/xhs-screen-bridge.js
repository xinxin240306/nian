/**
 * 云端虚拟屏幕的看图 / 点按桥。
 * 和念的后端跑在同一台机器上，只听本机。念来取图、转发你点的位置。
 *
 *   DISPLAY=:99 XHS_SCREEN_TOKEN=一段长随机串 node xhs-screen-bridge.js
 *
 * 依赖：Xvfb 已经开着，并且装了 xdotool，以及 import / magick / scrot 其中之一。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOST = process.env.XHS_SCREEN_HOST || '127.0.0.1';
const PORT = Number(process.env.XHS_SCREEN_PORT || 8767);
const TOKEN = String(process.env.XHS_SCREEN_TOKEN || '').trim();
const DISPLAY = process.env.DISPLAY || ':99';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: 20000,
      env: { ...process.env, DISPLAY },
    }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(String(stderr || err.message || cmd).trim().slice(0, 300));
        e.code = err.code;
        reject(e);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function authorized(req) {
  const h = String(req.headers.authorization || '');
  return TOKEN && h === `Bearer ${TOKEN}`;
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

async function captureToFile(file) {
  const attempts = [
    ['import', ['-window', 'root', '-silent', file]],
    ['magick', ['import', '-window', 'root', file]],
    ['scrot', ['-o', file]],
  ];
  let last = null;
  for (const [cmd, args] of attempts) {
    try {
      await run(cmd, args);
      if (fs.existsSync(file) && fs.statSync(file).size > 32) return;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(last?.message || '截不到画面。确认虚拟屏幕开着，并装了 import 或 scrot。');
}

async function displaySize() {
  const out = await run('xdotool', ['getdisplaygeometry']);
  const [w, h] = String(out).trim().split(/\s+/).map((n) => Number(n));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) {
    throw new Error('读不到屏幕尺寸');
  }
  return { w, h };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) {
        reject(new Error('请求太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('点的位置不是有效数据'));
      }
    });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { error: '画面桥口令不对' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/shot') {
    const file = path.join(os.tmpdir(), `xhs-screen-${process.pid}.png`);
    await captureToFile(file);
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Content-Length': buf.length,
    });
    res.end(buf);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/click') {
    const body = await readBody(req);
    const x = Number(body.x);
    const y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      sendJson(res, 400, { error: '点的位置要落在画面里面' });
      return;
    }
    const { w, h } = await displaySize();
    const px = Math.round(x * (w - 1));
    const py = Math.round(y * (h - 1));
    await run('xdotool', ['mousemove', String(px), String(py), 'click', '1']);
    sendJson(res, 200, { ok: true, px, py, width: w, height: h });
    return;
  }
  sendJson(res, 404, { error: '没有这个接口' });
}

if (!TOKEN || TOKEN.length < 8) {
  console.error('请设置 XHS_SCREEN_TOKEN，至少 8 位。画面桥不对外网开放。');
  process.exit(1);
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) return;
    sendJson(res, 500, { error: e.message || '画面桥失败' });
  });
}).listen(PORT, HOST, () => {
  console.log(`[xhs-screen] ${HOST}:${PORT} DISPLAY=${DISPLAY}`);
});

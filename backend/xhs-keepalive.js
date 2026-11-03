/**
 * 登录还在时，隔一段时间打开一次登录状态，避免云端浏览器关掉后闲置太久被当成没登录。
 * 已经掉了就不再反复打开，等下一次扫码写入新的登录记录再开始。
 */

const fs = require('fs');
const path = require('path');

const TOUCH_MS = 45 * 60 * 1000;
const WATCH_MS = 10 * 60 * 1000;

let timer = null;
let seenMtime = 0;
let waitingLogin = true;

function cookieFile() {
  const candidates = [
    process.env.COOKIES_PATH,
    '/root/cookies.json',
    path.join(process.cwd(), 'cookies.json'),
  ].filter(Boolean);
  return candidates.find((file) => {
    try { return fs.existsSync(file); } catch { return false; }
  }) || '';
}

function arm(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    run().catch((e) => {
      console.warn('[xhs-keepalive]', e.message);
      arm(WATCH_MS);
    });
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
}

async function run() {
  const file = cookieFile();
  let enabled = false;
  try { enabled = require('./xhs-self-helper').enabled(getSettings()); } catch { enabled = false; }
  if (!file || !enabled) {
    arm(WATCH_MS);
    return;
  }
  const mtime = fs.statSync(file).mtimeMs;
  if (waitingLogin) {
    if (mtime !== seenMtime && seenMtime) {
      seenMtime = mtime;
      waitingLogin = false;
      console.log('[xhs-keepalive] 看到新的登录记录，45 分钟后确认一次');
      arm(TOUCH_MS);
      return;
    }
    seenMtime = mtime;
    arm(WATCH_MS);
    return;
  }
  const mcp = require('./mcp-client-helper');
  if (mcp.mcpBusy()) {
    arm(WATCH_MS);
    return;
  }
  const raw = await mcp.invokeTool(getSettings, 'check_login_status', {});
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw || '');
  const loggedIn = !/未登录/.test(text) && /已登录/.test(text);
  seenMtime = fs.statSync(file).mtimeMs;
  if (loggedIn) {
    console.log('[xhs-keepalive] 登录还在，45 分钟后再看一眼');
    arm(TOUCH_MS);
    return;
  }
  waitingLogin = true;
  console.log('[xhs-keepalive] 登录不在。扫码之后会再开始定时确认');
  arm(WATCH_MS);
}

function getSettings() {
  throw new Error('keepalive 还没接上');
}

function start(getSettingsFn) {
  getSettings = getSettingsFn;
  const file = cookieFile();
  if (file) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    seenMtime = fs.statSync(file).mtimeMs;
    waitingLogin = false;
    if (age >= 0 && age < 40 * 60 * 1000) {
      arm(Math.max(2 * 60 * 1000, TOUCH_MS - age));
      console.log('[xhs-keepalive] 登录记录还新，到点再确认');
      return;
    }
    arm(2 * 60 * 1000);
    console.log('[xhs-keepalive] 登录记录还在，先确认一次');
    return;
  }
  waitingLogin = true;
  arm(WATCH_MS);
  console.log('[xhs-keepalive] 现在不反复打开。扫码成功 45 分钟后开始确认');
}

module.exports = { start };

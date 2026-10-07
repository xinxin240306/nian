/**
 * 连麦陪睡清醒阶：迷糊 → 半醒 → 清醒
 */
const Module = require('module');
const path = require('path');

delete require.cache[require.resolve('./cron.js')];

const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'db' || id === './db') {
    return { prepare: () => ({ all: () => [], get: () => null, run: () => {} }) };
  }
  return originalRequire.apply(this, arguments);
};

const cron = require('./cron.js');
const classify = cron.classifyCallSleepWake;
const now = Date.now();
const ts = (secAgo) => new Date(now - secAgo * 1000).toISOString();

function u(content, secAgo, extra = {}) {
  return { role: 'user', type: extra.type || 'text', content, timestamp: ts(secAgo), id: extra.id || Math.round(now - secAgo * 1000) };
}

let failed = 0;
function check(label, history, expect, opts) {
  const got = classify(history, opts);
  const ok = got === expect;
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}  => ${got} (expect ${expect})`);
}

check('空历史继续睡', [], 'sleep');

check('轻声安抚保持迷糊', [
  u('[通话开始]', 40, { type: 'system' }),
  u('嗯', 5),
], 'drowsy');

check('继续睡不往上醒', [
  u('[通话开始]', 80, { type: 'system' }),
  u('你先睡吧，我不吵', 8),
], 'drowsy');

check('醒来第一轮正经说话 → 迷糊', [
  u('[通话开始]', 90, { type: 'system' }),
  u('你听得见吗，我睡不着', 6),
], 'groggy');

check('第二轮还在说 → 半醒', [
  u('[通话开始]', 120, { type: 'system' }),
  u('你听得见吗，我睡不着', 50),
  { role: 'assistant', content: '嗯……怎么了', timestamp: ts(40), id: 2 },
  u('做噩梦了，陪我说两句', 8),
], 'medium');

check('第三轮 → 清醒', [
  u('[通话开始]', 180, { type: 'system' }),
  u('你听得见吗', 70),
  { role: 'assistant', content: '嗯……', timestamp: ts(60), id: 2 },
  u('我睡不着', 40),
  { role: 'assistant', content: '怎么了……', timestamp: ts(30), id: 4 },
  u('能不能陪我说说话', 5),
], 'awake');

check('连麦自言自语不把人聊醒', [
  u('[通话开始]', 200, { type: 'system' }),
  u('你听得见吗', 80),
  u('[连麦挂着。若你此刻行程是睡觉/休息：对方若已安静，你继续睡。]', 2, { type: 'system' }),
], 'sleep');

check('超过三分钟安静后重置', [
  u('[通话开始]', 400, { type: 'system' }),
  u('你听得见吗，我睡不着', 200),
], 'sleep');

check('语音无转写仍算开口，可用前端阶', [
  u('[通话开始]', 30, { type: 'system' }),
  u(JSON.stringify({ voice: true, url: '/x.wav' }), 4, { type: 'voice' }),
], 'groggy', { wakeStep: 1 });

process.exit(failed ? 1 : 0);

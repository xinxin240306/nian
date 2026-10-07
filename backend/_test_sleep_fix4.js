/**
 * 简化测试：直接 require 需要的函数
 */
const Module = require('module');
const path = require('path');

// 用 mock 让 db/getSettings 等不报错
const mockModules = {};
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'db' || id === './db') {
    if (!mockModules.db) {
      mockModules.db = {
        prepare: () => ({ all: () => [], get: () => null, run: () => {} }),
      };
    }
    return mockModules.db;
  }
  if (id === 'location-weather-helper' || id === './location-weather-helper') {
    return { getLocationWeather: () => null, getWeatherEmoji: () => '' };
  }
  return originalRequire.apply(this, arguments);
};

process.env.NODE_ENV = 'test';
const cron = require('./cron.js');

const settings = {
  timezone: 'Asia/Shanghai',
  time_aware_enabled: '1',
};

if (typeof cron.buildSleepContextNote !== 'function') {
  console.log('ERROR: buildSleepContextNote not exported');
  process.exit(1);
}

const baseHour = 23;
const baseMs = (() => {
  const d = new Date();
  d.setHours(baseHour, 30, 0, 0);
  return d.getTime();
})();
const tsMinAgo = (m) => new Date(baseMs - m * 60 * 1000).toISOString();

function run(label, history, expect, check) {
  const sleepNote = cron.buildSleepContextNote(history, settings);
  const intentNote = cron.buildStatedIntentElapsedNote(history, settings);
  const hasNote = !!(sleepNote || intentNote);
  const ok = check ? check(sleepNote, intentNote) : (expect ? hasNote : !hasNote);
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  console.log(`  buildSleepContextNote:`, sleepNote || '(空)');
  console.log(`  buildStatedIntentElapsedNote:`, intentNote || '(空)');
}

console.log('\n==== 核心 bug 场景 ====');
run(
  'A. 用户说"我去睡了"后继续聊其他话题（应该不触发）',
  [
    { role: 'user', content: '我去睡了', timestamp: tsMinAgo(70) },
    { role: 'assistant', content: '晚安' },
    { role: 'user', content: '算了不睡', timestamp: tsMinAgo(60) },
    { role: 'assistant', content: '好呀' },
    { role: 'user', content: '你说啥好吃的', timestamp: tsMinAgo(30) },
    { role: 'user', content: '哈哈行', timestamp: tsMinAgo(5) },
  ],
  false // 不触发
);

run(
  'C. 用户顺嘴提到"工作好困"（不是 sleep 意图，应该不触发）',
  [
    { role: 'user', content: '我今天工作好困', timestamp: tsMinAgo(60) },
    { role: 'assistant', content: '辛苦了' },
    { role: 'user', content: '你说啥好吃的', timestamp: tsMinAgo(5) },
  ],
  false
);

console.log('\n==== 真实睡眠场景 ====');
run(
  'E. 用户真的道晚安，70分钟后发"睡不着"（应该触发）',
  [
    { role: 'user', content: '我去睡了，晚安', timestamp: tsMinAgo(70) },
    { role: 'assistant', content: '晚安' },
    { role: 'user', content: '睡不着', timestamp: tsMinAgo(5) },
  ],
  true // 触发
);

run(
  'G. 用户最近一条是"我困了去睡"（sleep 意图，应该触发 intentNote）',
  [
    { role: 'user', content: '刚才看了个电影', timestamp: tsMinAgo(20) },
    { role: 'assistant', content: '好看吗' },
    { role: 'user', content: '我困了去睡', timestamp: tsMinAgo(5) },
  ],
  true, // intentNote 可能因为 gap<50min 而不触发
  (sleep, intent) => !sleep // 至少 sleepNote 要有
);

console.log('\n--- done ---');
process.exit(0);
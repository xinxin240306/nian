/**
 * 调试场景 E
 */
const Module = require('module');
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

const baseHour = 23;
const baseMs = (() => {
  const d = new Date();
  d.setHours(baseHour, 30, 0, 0);
  return d.getTime();
})();
const tsMinAgo = (m) => new Date(baseMs - m * 60 * 1000).toISOString();

// 场景 E
const history = [
  { role: 'user', content: '我去睡了，晚安', timestamp: tsMinAgo(70) },
  { role: 'assistant', content: '晚安' },
  { role: 'user', content: '睡不着', timestamp: tsMinAgo(5) },
];

const prior = history.slice(0, -1); // 不含最后一条
const recent = prior.slice(-30);
console.log('recent:');
recent.forEach((m, i) => console.log(`  [${i}] ${m.role}: ${m.content}`));

// 模拟 findLastMatch
const findLastMatch = (pred) => {
  for (let i = recent.length - 1; i >= 0; i--) {
    const text = String(recent[i].content || '').replace(/^【自动回复】/, '');
    if (pred(recent[i], text)) {
      console.log(`  findLastMatch hit: [${i}] ${recent[i].role}: ${recent[i].content}`);
      return { msg: recent[i], text, idx: i };
    }
  }
  return null;
};

const GOODNIGHT_RE = /晚安|好梦|睡了|睡觉啦|睡啦|去睡|早点休息|先睡|晚安啦|good\s*night/i;
const lastGoodnightByUser = findLastMatch((m, text) => m.role === 'user' && GOODNIGHT_RE.test(text));
console.log('\nlastGoodnightByUser:', lastGoodnightByUser);

if (lastGoodnightByUser) {
  console.log('idx:', lastGoodnightByUser.idx);
  const slice = recent.slice(lastGoodnightByUser.idx + 1);
  console.log('slice after idx+1:', slice.map(m => `${m.role}: ${m.content}`));
  const sinceGoodnightUserMsgs = slice.filter(m => m.role === 'user').length;
  console.log('sinceGoodnightUserMsgs:', sinceGoodnightUserMsgs);
  console.log('sinceGoodnightUserMsgs < 2:', sinceGoodnightUserMsgs < 2);
}

console.log('\n=== 实际调用 ===');
const result = cron.buildSleepContextNote(history, { timezone: 'Asia/Shanghai', time_aware_enabled: '1' });
console.log('buildSleepContextNote result:', result || '(空)');
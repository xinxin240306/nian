/**
 * 测试 - 修复 hour 检测问题
 */
const Module = require('module');
const path = require('path');

// 清除缓存
delete require.cache[require.resolve('./cron.js')];

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

// Mock Date to be 23:30
const _RealDate = Date;
const fakeNow = (() => {
  const d = new _RealDate();
  d.setHours(23, 30, 0, 0);
  return d.getTime();
})();

global.Date = class extends _RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(fakeNow);
    } else {
      super(...args);
    }
  }
  static now() {
    return fakeNow;
  }
};

process.env.NODE_ENV = 'test';
const cron = require('./cron.js');

const settings = {
  timezone: 'Asia/Shanghai',
  time_aware_enabled: '1',
};

const tsMinAgo = (m) => new _RealDate(fakeNow - m * 60 * 1000).toISOString();

function run(label, history, expect) {
  const sleepNote = cron.buildSleepContextNote(history, settings);
  const intentNote = cron.buildStatedIntentElapsedNote(history, settings);
  const hasNote = !!(sleepNote || intentNote);
  const ok = expect ? hasNote : !hasNote;
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  console.log(`  buildSleepContextNote:`, sleepNote || '(空)');
  console.log(`  buildStatedIntentElapsedNote:`, intentNote || '(空)');
}

console.log('==== 核心 bug 场景 ====');
run('A. 用户说"我去睡了"后继续聊其他话题', [
  { role: 'user', content: '我去睡了', timestamp: tsMinAgo(70) },
  { role: 'assistant', content: '晚安' },
  { role: 'user', content: '算了不睡', timestamp: tsMinAgo(60) },
  { role: 'assistant', content: '好呀' },
  { role: 'user', content: '你说啥好吃的', timestamp: tsMinAgo(30) },
  { role: 'user', content: '哈哈行', timestamp: tsMinAgo(5) },
], false);

run('C. 用户顺嘴提到"工作好困"', [
  { role: 'user', content: '我今天工作好困', timestamp: tsMinAgo(60) },
  { role: 'assistant', content: '辛苦了' },
  { role: 'user', content: '你说啥好吃的', timestamp: tsMinAgo(5) },
], false);

console.log('\n==== 真实睡眠场景 ====');
run('E. 用户真的道晚安，70分钟后发"睡不着"', [
  { role: 'user', content: '我去睡了，晚安', timestamp: tsMinAgo(70) },
  { role: 'assistant', content: '晚安' },
  { role: 'user', content: '睡不着', timestamp: tsMinAgo(5) },
], true);

run('G. 用户最近一条是"我困了去睡"', [
  { role: 'user', content: '刚才看了个电影', timestamp: tsMinAgo(20) },
  { role: 'assistant', content: '好看吗' },
  { role: 'user', content: '我困了去睡', timestamp: tsMinAgo(5) },
], true);

console.log('\n--- done ---');
process.exit(0);
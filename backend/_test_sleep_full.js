/**
 * 测试 - 完整覆盖用户的实际场景
 */
const Module = require('module');
const path = require('path');

delete require.cache[require.resolve('./cron.js')];

const mockModules = {};
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'db' || id === './db') {
    if (!mockModules.db) {
      mockModules.db = { prepare: () => ({ all: () => [], get: () => null, run: () => {} }) };
    }
    return mockModules.db;
  }
  if (id === 'location-weather-helper' || id === './location-weather-helper') {
    return { getLocationWeather: () => null, getWeatherEmoji: () => '' };
  }
  return originalRequire.apply(this, arguments);
};

const _RealDate = Date;
const fakeNow = (() => {
  const d = new _RealDate();
  d.setHours(23, 30, 0, 0);
  return d.getTime();
})();
global.Date = class extends _RealDate {
  constructor(...args) {
    if (args.length === 0) super(fakeNow);
    else super(...args);
  }
  static now() { return fakeNow; }
};

process.env.NODE_ENV = 'test';
const cron = require('./cron.js');

const settings = { timezone: 'Asia/Shanghai', time_aware_enabled: '1' };
const tsMinAgo = (m) => new _RealDate(fakeNow - m * 60 * 1000).toISOString();

function test(label, history, expectSleep, expectIntent) {
  const sleepNote = cron.buildSleepContextNote(history, settings);
  const intentNote = cron.buildStatedIntentElapsedNote(history, settings);
  const hasSleep = !!sleepNote;
  const hasIntent = !!intentNote;
  const ok = (hasSleep === !!expectSleep) && (hasIntent === !!expectIntent);
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log(`  EXPECT sleep: ${expectSleep ? 'trigger' : 'no'}, got: ${hasSleep ? 'trigger' : 'no'}`);
    console.log(`  EXPECT intent: ${expectIntent ? 'trigger' : 'no'}, got: ${hasIntent ? 'trigger' : 'no'}`);
  }
}

console.log('==== 用户的实际 bug 场景 ====');

// 用户说"我去睡了"但还在继续聊
test('场景 1：用户说"我去睡了"后继续聊了几条别的', [
  { role: 'user', content: '我去睡了', timestamp: tsMinAgo(60) },
  { role: 'assistant', content: '晚安' },
  { role: 'user', content: '其实没睡', timestamp: tsMinAgo(50) },
  { role: 'assistant', content: '哈哈' },
  { role: 'user', content: '陪我聊会儿', timestamp: tsMinAgo(5) },
], false, false);

// 用户说"我去睡了"后又发了一句"画了个画"，然后 AI 回复
test('场景 2：用户继续聊画画等无关话题', [
  { role: 'user', content: '我去睡了', timestamp: tsMinAgo(60) },
  { role: 'assistant', content: '晚安' },
  { role: 'user', content: '画了个画', timestamp: tsMinAgo(50) },
  { role: 'assistant', content: '好看' },
  { role: 'user', content: '嗯嗯', timestamp: tsMinAgo(5) },
], false, false);

console.log('\n==== 真实睡眠场景（应该触发） ====');
test('场景 3：用户道晚安后真睡了，1小时后发"睡不着"', [
  { role: 'user', content: '我去睡了，晚安', timestamp: tsMinAgo(70) },
  { role: 'assistant', content: '晚安' },
  { role: 'user', content: '睡不着', timestamp: tsMinAgo(5) },
], true, false);

test('场景 4：用户道晚安+60min后发"醒了"', [
  { role: 'user', content: '晚安', timestamp: tsMinAgo(70) },
  { role: 'assistant', content: '嗯嗯晚安' },
  { role: 'user', content: '醒了', timestamp: tsMinAgo(5) },
], true, false);

console.log('\n==== 边界场景 ====');

// 用户顺嘴说困，没真的去睡
test('场景 5：用户说"今天工作好困"（感慨）', [
  { role: 'user', content: '今天工作好困', timestamp: tsMinAgo(60) },
  { role: 'assistant', content: '辛苦了' },
  { role: 'user', content: '你说啥好吃的', timestamp: tsMinAgo(5) },
], false, false);

// 凌晨 3 点，用户真睡了又醒了
test('场景 6：凌晨 3 点用户醒了（hour<7 走特殊分支）', [
  { role: 'user', content: '我去睡了', timestamp: tsMinAgo(60*4) },
  { role: 'assistant', content: '晚安' },
  { role: 'user', content: '醒了', timestamp: tsMinAgo(5) },
], true, false);  // 凌晨用户醒过来，应该触发"晚安后又出现"

console.log('\n--- done ---');
process.exit(0);
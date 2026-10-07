/**
 * 测试 cron.js 的修复 - 第2轮
 * 验证：真正的"晚安后又出现"场景仍能正确触发
 */

const cron = require('./cron.js');
const settings = {
  timezone: 'Asia/Shanghai',
  time_aware_enabled: '1',
};

// 构造深夜时间戳
const baseHour = 23;
const baseMs = (() => {
  const d = new Date();
  d.setHours(baseHour, 30, 0, 0);
  return d.getTime();
})();
const tsMinAgo = (m) => new Date(baseMs - m * 60 * 1000).toISOString();

console.log('=== 场景 E：用户真的道晚安，1小时后发新消息（深夜） ===');
const history5 = [
  { role: 'user', content: '我去睡了，晚安', timestamp: tsMinAgo(70), type: 'text' },
  { role: 'assistant', content: '晚安', timestamp: tsMinAgo(69), type: 'text' },
  // 用户真的睡了1小时
  { role: 'user', content: '睡不着', timestamp: tsMinAgo(5), type: 'text' },
];

console.log('--- buildSleepContextNote ---');
const sleepNote5 = cron.buildSleepContextNote(history5, settings);
console.log('结果：', sleepNote5 || '(空)');
console.log();

console.log('=== 场景 F：用户说"我先睡了"，1小时后又发新消息 ===');
const history6 = [
  { role: 'user', content: '我先睡了', timestamp: tsMinAgo(70), type: 'text' },
  { role: 'assistant', content: '好梦', timestamp: tsMinAgo(69), type: 'text' },
  { role: 'user', content: '睡不着', timestamp: tsMinAgo(5), type: 'text' },
];

console.log('--- buildSleepContextNote ---');
const sleepNote6 = cron.buildSleepContextNote(history6, settings);
console.log('结果：', sleepNote6 || '(空)');
console.log();

console.log('=== 场景 G：用户确实困了要去睡（最近一条就是意图） ===');
const history7 = [
  { role: 'user', content: '刚才看了个电影', timestamp: tsMinAgo(20), type: 'text' },
  { role: 'assistant', content: '好看吗', timestamp: tsMinAgo(19), type: 'text' },
  { role: 'user', content: '我困了去睡', timestamp: tsMinAgo(5), type: 'text' },
];

console.log('--- buildSleepContextNote ---');
const sleepNote7 = cron.buildSleepContextNote(history7, settings);
console.log('结果：', sleepNote7 || '(空)');
console.log('--- buildStatedIntentElapsedNote ---');
const intentNote7 = cron.buildStatedIntentElapsedNote(history7, settings);
console.log('结果：', intentNote7 || '(空 - 因为才5分钟没超50分钟阈值)');
console.log();

console.log('=== 场景 H：用户说"我困了去睡"，1小时后没新消息，AI re-roll ===');
const history8 = [
  { role: 'user', content: '我困了去睡', timestamp: tsMinAgo(60), type: 'text' },
  { role: 'assistant', content: '嗯嗯晚安', timestamp: tsMinAgo(59), type: 'text' },
  // 没有更多用户消息，AI 是最后一条——这是 re-roll 场景
];

console.log('--- buildStatedIntentElapsedNote ---');
const intentNote8 = cron.buildStatedIntentElapsedNote(history8, settings);
console.log('结果：', intentNote8 || '(空)');
/**
 * 测试 cron.js 的修复
 * 直接 require cron.js 然后通过模块导出访问
 */

// 拿到 cron 模块的源代码，提取内部函数
const fs = require('fs');
const path = require('path');
const cronPath = path.join(__dirname, 'cron.js');
const src = fs.readFileSync(cronPath, 'utf8');

// 把 cron.js 的 module.exports 临时替换为暴露这些函数
// 由于这些函数是 internal，我们用 vm 模块直接 eval
const Module = require('module');
const m = new Module(cronPath);
m.filename = cronPath;
m.paths = Module._nodeModulePaths(path.dirname(cronPath));

// 修补 require 让 cron.js 能找到它的依赖
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;

// 直接 require cron.js，看它有没有导出我们需要的函数
try {
  const cron = require('./cron.js');
  console.log('cron exports keys:', Object.keys(cron).filter(k => k.includes('leep') || k.includes('ntent') || k.includes('tated') || k.includes('Retry')));

  if (cron.buildSleepContextNote && cron.buildStatedIntentElapsedNote) {
    runTests(cron);
  } else {
    console.log('cron.js 没导出 buildSleepContextNote / buildStatedIntentElapsedNote');
  }
} catch (e) {
  console.error('require cron.js 失败：', e.message);
}

function runTests(cron) {
  const settings = {
    timezone: 'Asia/Shanghai',
    time_aware_enabled: '1',
  };
  const now = Date.now();
  const minutesAgo = (m) => new Date(now - m * 60 * 1000).toISOString();

  console.log('\n=== 场景 A：用户说"我去睡了"后继续聊其他话题（深夜） ===');
  console.log('时间：现在 23:30（深夜，hour=23）');
  console.log('history: 用户70分钟前说"我去睡了"→AI回复→用户60分钟前继续聊→用户30分钟前聊吃的→用户5分钟前说"哈哈行"');

  // 模拟深夜：调整时间戳让最后几条落在 23:00-06:00
  const baseHour = 23;
  const baseMs = (() => {
    const d = new Date();
    d.setHours(baseHour, 30, 0, 0);
    return d.getTime();
  })();
  const tsMinAgo = (m) => new Date(baseMs - m * 60 * 1000).toISOString();

  const history = [
    { role: 'user', content: '我去睡了', timestamp: tsMinAgo(70), type: 'text' },
    { role: 'assistant', content: '晚安呀', timestamp: tsMinAgo(69), type: 'text' },
    { role: 'user', content: '算了不睡，陪我聊会儿呗', timestamp: tsMinAgo(60), type: 'text' },
    { role: 'assistant', content: '好呀', timestamp: tsMinAgo(59), type: 'text' },
    { role: 'user', content: '你说啥好吃的', timestamp: tsMinAgo(30), type: 'text' },
    { role: 'assistant', content: '烤鱼', timestamp: tsMinAgo(29), type: 'text' },
    { role: 'user', content: '哈哈行', timestamp: tsMinAgo(5), type: 'text' },
  ];

  console.log('--- buildSleepContextNote ---');
  const sleepNote = cron.buildSleepContextNote(history, settings);
  console.log('结果：', sleepNote || '(空，正确：用户继续聊，没触发)');

  console.log('--- buildStatedIntentElapsedNote ---');
  const intentNote = cron.buildStatedIntentElapsedNote(history, settings);
  console.log('结果：', intentNote || '(空，正确：用户继续聊，没触发)');

  console.log('\n=== 场景 B：用户最新一条消息是 sleep 意图（深夜） ===');
  const history2 = [
    { role: 'user', content: '算了不睡', timestamp: tsMinAgo(30), type: 'text' },
    { role: 'assistant', content: '好呀', timestamp: tsMinAgo(29), type: 'text' },
    { role: 'user', content: '算了，我还是去睡了', timestamp: tsMinAgo(5), type: 'text' },
  ];

  console.log('--- buildSleepContextNote ---');
  const sleepNote2 = cron.buildSleepContextNote(history2, settings);
  console.log('结果：', sleepNote2 || '(空)');

  console.log('--- buildStatedIntentElapsedNote ---');
  const intentNote2 = cron.buildStatedIntentElapsedNote(history2, settings);
  console.log('结果：', intentNote2 || '(空)');

  console.log('\n=== 场景 C：用户上一条顺嘴提到"困"（不是 sleep 意图） ===');
  const history3 = [
    { role: 'user', content: '我今天工作好困', timestamp: tsMinAgo(60), type: 'text' },
    { role: 'assistant', content: '辛苦了', timestamp: tsMinAgo(59), type: 'text' },
    { role: 'user', content: '你说啥好吃的', timestamp: tsMinAgo(5), type: 'text' },
  ];

  console.log('--- buildSleepContextNote ---');
  const sleepNote3 = cron.buildSleepContextNote(history3, settings);
  console.log('结果：', sleepNote3 || '(空，正确：用户最近的消息不含 sleep 意图)');

  console.log('--- buildStatedIntentElapsedNote ---');
  const intentNote3 = cron.buildStatedIntentElapsedNote(history3, settings);
  console.log('结果：', intentNote3 || '(空，正确：正则在改严后不匹配"工作好困")');

  console.log('\n=== 场景 D：用户说"我去睡了"就停了，1小时后又发新消息（深夜） ===');
  const history4 = [
    { role: 'user', content: '我去睡了', timestamp: tsMinAgo(70), type: 'text' },
    { role: 'assistant', content: '晚安呀', timestamp: tsMinAgo(69), type: 'text' },
    // 用户停了1小时
    { role: 'user', content: '睡不着，还是聊会儿', timestamp: tsMinAgo(5), type: 'text' },
  ];

  console.log('--- buildSleepContextNote ---');
  const sleepNote4 = cron.buildSleepContextNote(history4, settings);
  console.log('结果：', sleepNote4 || '(空)');
  console.log('（这场景预期会触发，因为用户最新一条还在聊睡眠相关）');

  console.log('--- buildStatedIntentElapsedNote ---');
  const intentNote4 = cron.buildStatedIntentElapsedNote(history4, settings);
  console.log('结果：', intentNote4 || '(空)');
}
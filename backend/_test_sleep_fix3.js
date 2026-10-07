/**
 * 测试 - 不 require 整个 cron.js，只复制需要测试的函数
 * 直接用 vm 在沙箱里执行
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const cronSrc = fs.readFileSync(path.join(__dirname, 'cron.js'), 'utf8');

// 提取 buildSleepContextNote 函数
function extractFn(name) {
  const re = new RegExp(`function ${name}\\s*\\([\\s\\S]*?\\n\\}`, 'm');
  const m = cronSrc.match(re);
  if (!m) throw new Error(`Cannot find function ${name}`);
  return m[0];
}

// 提取 GOODNIGHT_RE / GOING_SLEEP_RE
function extractConst(name) {
  const re = new RegExp(`const ${name}\\s*=\\s*[^;]+;`);
  const m = cronSrc.match(re);
  if (!m) throw new Error(`Cannot find const ${name}`);
  return m[0];
}

// USER_STATED_INTENT_PATTERNS
function extractPatterns() {
  const m = cronSrc.match(/const USER_STATED_INTENT_PATTERNS = \[[\s\S]*?\];/);
  if (!m) throw new Error('Cannot find USER_STATED_INTENT_PATTERNS');
  return m[0];
}

// 提取其他依赖
function extractHelper(name) {
  const re = new RegExp(`function ${name}\\s*\\([\\s\\S]*?\\n\\}`, 'm');
  const m = cronSrc.match(re);
  return m ? m[0] : null;
}

// 提取完整的 buildStatedIntentElapsedNote 函数
const buildSleepSrc = extractFn('buildSleepContextNote');
const buildIntentSrc = extractFn('buildStatedIntentElapsedNote');
const buildRetrySrc = extractFn('buildRetryTimeAdvanceNote');
const goodnightRe = extractConst('GOODNIGHT_RE');
const goingSleepRe = extractConst('GOING_SLEEP_RE');
const userPatterns = extractPatterns();
const parseMsgTimestamp = extractHelper('parseMsgTimestamp');
const formatConversationGap = extractHelper('formatConversationGap');
const getLocalHour = extractHelper('getLocalHour');
const getLocalTimeShort = extractHelper('getLocalTimeShort');
const getSettings = extractHelper('getSettings');
const formatConversationGap2 = extractHelper('formatConversationGap');

// 在沙箱里跑
const sandbox = {
  console,
  Date,
  Math,
  Number,
  String,
  Array,
  JSON,
  parseInt,
  Object,
  isFinite,
  module: { exports: {} },
  exports: {},
};
sandbox.global = sandbox;
sandbox.module.exports = sandbox.exports;

const code = `
${goodnightRe}
${goingSleepRe}
${userPatterns}

${parseMsgTimestamp || 'function parseMsgTimestamp(){}'}
${formatConversationGap || 'function formatConversationGap(){return "";}'}
${getLocalHour || 'function getLocalHour(){return 23;}'}
${getLocalTimeShort || 'function getLocalTimeShort(){return "";}'}
${buildSleepSrc}
${buildIntentSrc}
${buildRetrySrc}

module.exports = { buildSleepContextNote, buildStatedIntentElapsedNote, buildRetryTimeAdvanceNote };
`;

vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { buildSleepContextNote, buildStatedIntentElapsedNote, buildRetryTimeAdvanceNote } = sandbox.module.exports;

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

function run(label, history, expectNote) {
  console.log(`\n=== ${label} ===`);
  const sleepNote = buildSleepContextNote(history, settings);
  const intentNote = buildStatedIntentElapsedNote(history, settings);
  console.log('  buildSleepContextNote:', sleepNote || '(空)');
  console.log('  buildStatedIntentElapsedNote:', intentNote || '(空)');
  if (expectNote) {
    console.log('  期望触发：', expectNote ? 'YES' : 'NO', '→', (sleepNote || intentNote) ? 'OK' : 'FAIL');
  }
}

// === 用户实际 bug 场景：用户说"我去睡了"但还在继续聊 ===
run(
  '场景 A：用户说"我去睡了"后继续聊其他话题（深夜 70min）',
  [
    { role: 'user', content: '我去睡了', timestamp: tsMinAgo(70), type: 'text' },
    { role: 'assistant', content: '晚安呀', timestamp: tsMinAgo(69), type: 'text' },
    { role: 'user', content: '算了不睡', timestamp: tsMinAgo(60), type: 'text' },
    { role: 'assistant', content: '好呀', timestamp: tsMinAgo(59), type: 'text' },
    { role: 'user', content: '你说啥好吃的', timestamp: tsMinAgo(30), type: 'text' },
    { role: 'assistant', content: '烤鱼', timestamp: tsMinAgo(29), type: 'text' },
    { role: 'user', content: '哈哈行', timestamp: tsMinAgo(5), type: 'text' },
  ],
  false,
);

// === 用户上一条顺嘴提到"困"，但还在聊别的 ===
run(
  '场景 C：用户最近一条消息顺嘴提到"工作好困"（深夜 60min）',
  [
    { role: 'user', content: '我今天工作好困', timestamp: tsMinAgo(60), type: 'text' },
    { role: 'assistant', content: '辛苦了', timestamp: tsMinAgo(59), type: 'text' },
    { role: 'user', content: '你说啥好吃的', timestamp: tsMinAgo(5), type: 'text' },
  ],
  false,
);

// === 用户确实道晚安+发新消息 ===
run(
  '场景 E：用户真的道晚安，70分钟后发"睡不着"（深夜）',
  [
    { role: 'user', content: '我去睡了，晚安', timestamp: tsMinAgo(70), type: 'text' },
    { role: 'assistant', content: '晚安', timestamp: tsMinAgo(69), type: 'text' },
    { role: 'user', content: '睡不着', timestamp: tsMinAgo(5), type: 'text' },
  ],
  null,
);

// === 用户最近一条是明确 sleep 意图 ===
run(
  '场景 G：用户最近一条是"我困了去睡"（深夜）',
  [
    { role: 'user', content: '刚才看了个电影', timestamp: tsMinAgo(20), type: 'text' },
    { role: 'assistant', content: '好看吗', timestamp: tsMinAgo(19), type: 'text' },
    { role: 'user', content: '我困了去睡', timestamp: tsMinAgo(5), type: 'text' },
  ],
  null,
);

// === 真实的"晚安后又出现"：用户真的去睡了 ===
run(
  '场景 I：用户真的去睡了（道晚安+60分钟后发"醒了一下"）',
  [
    { role: 'user', content: '我先睡了，晚安', timestamp: tsMinAgo(70), type: 'text' },
    { role: 'assistant', content: '晚安', timestamp: tsMinAgo(69), type: 'text' },
    { role: 'user', content: '醒了一下', timestamp: tsMinAgo(5), type: 'text' },
  ],
  null,
);

console.log('\n--- 测试结束 ---');
process.exit(0);
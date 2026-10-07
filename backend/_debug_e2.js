/**
 * 调试场景 E - 详细
 */
const Module = require('module');
const mockModules = {};
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
  return require.apply(this, arguments);
};
process.env.NODE_ENV = 'test';

// Monkey-patch cron.js to add logging
const fs = require('fs');
let cronSrc = fs.readFileSync('./cron.js', 'utf8');
// 在 buildSleepContextNote 函数开头加 console.log
cronSrc = cronSrc.replace(
  'function buildSleepContextNote(history, settings) {',
  `function buildSleepContextNote(history, settings) {
  console.log('[DEBUG buildSleepContextNote] history.length=', history.length);
  console.log('[DEBUG] prior =', history.slice(0, -1).map(m => m.role + ':' + m.content.slice(0,20)));
`
);

const vm = require('vm');
const sandbox = {
  console: {
    log: (...args) => console.log('[VM]', ...args),
    warn: console.warn,
    error: console.error,
  },
  Date, Math, Number, String, Array, JSON, parseInt, Object, isFinite,
  module: { exports: {} }, exports: {},
  require: Module.prototype.require.bind({}),
};
sandbox.global = sandbox;

const lines = cronSrc.split('\n');
const fnStart = lines.findIndex(l => l.includes('function buildSleepContextNote(history'));
const fnLines = [fnStart];
let brace = 0;
for (let i = fnStart; i < lines.length; i++) {
  for (const c of lines[i]) { if (c === '{') brace++; if (c === '}') brace--; }
  fnLines.push(i);
  if (brace === 0) break;
}
const fnSrc = lines.slice(fnStart, fnLines[fnLines.length - 1] + 1).join('\n');
// 提取依赖
const consts = cronSrc.match(/const GOODNIGHT_RE[\s\S]*?;/);
const fns = cronSrc.match(/function getLocalHour[\s\S]*?^}/m);
const vmScript = new vm.Script(`
${consts[0]}
${fns[0]}
${fnSrc}
`);
vmScript.runInContext(sandbox);
const { buildSleepContextNote } = sandbox.module.exports;

const baseHour = 23;
const baseMs = (() => {
  const d = new Date();
  d.setHours(baseHour, 30, 0, 0);
  return d.getTime();
})();
const tsMinAgo = (m) => new Date(baseMs - m * 60 * 1000).toISOString();

const history = [
  { role: 'user', content: '我去睡了，晚安', timestamp: tsMinAgo(70) },
  { role: 'assistant', content: '晚安' },
  { role: 'user', content: '睡不着', timestamp: tsMinAgo(5) },
];

console.log('\nCalling buildSleepContextNote...');
const result = buildSleepContextNote(history, { timezone: 'Asia/Shanghai', time_aware_enabled: '1' });
console.log('\nResult:', result || '(空)');
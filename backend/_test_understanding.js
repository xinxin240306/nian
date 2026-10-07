'use strict';

const assert = require('assert');
const perception = require('./perception-helper');
const understanding = require('./understanding-helper');

function testPerceptionSignals() {
  assert.ok(perception.signalFromMessage('心累') >= 16, 'fatigue should score');
  assert.ok(perception.signalFromMessage('没事，挺好的，晚安') >= 20, 'soft deny + goodnight should score');
  assert.ok(perception.signalFromMessage('嗯') >= 20, 'hedge should score');
  assert.ok(perception.hasUnderstandingCue('我今天好累，感觉心累', { score: 0 }));
  assert.ok(perception.hasUnderstandingCue('没事挺好的晚安', { score: 0 }));
  assert.ok(!perception.hasUnderstandingCue('周末去哪玩', { score: 10 }));
  assert.ok(perception.hasUnderstandingCue('周末去哪玩', { score: 45 }));
  const state = { mood: { valence: 0 } };
  perception.touchFromUserMessage(1, state, '嗯', Date.now());
  assert.ok(state.perception && state.perception.score > 0);
  assert.ok(state.perception.trend);
  const t0 = Date.now();
  const roll = { mood: {} };
  perception.touchFromUserMessage(1, roll, '嗯', t0);
  perception.touchFromUserMessage(1, roll, '还好', t0 + 7 * 3600 * 1000);
  assert.strictEqual(roll.perception.msgCount, 2, '6h is rolling decay, not a hard reset');
  assert.ok(roll.perception.score > 0);
  console.log('perception signals ok');
}

function testNormalizeFailOpen() {
  const flashes = [{ key: 'mem:12', text: '讨厌加班', block: '脑海' }];
  const narrs = [{ id: 3, title: '加班' }];
  const imps = [
    { id: 9, cat: '习惯', facts: ['跑两步就喘'] },
    { id: 8, cat: '性格', facts: ['嘴硬'], standing: true },
  ];
  const u = understanding.normalizeUnderstandingPayload({}, {
    flashCandidates: flashes,
    narratives: narrs,
    impressions: imps,
    perceptionSnap: { daily_anomaly_score: 12, anomaly_trend: '无异常' },
  });
  assert.strictEqual(u.suggested_strategy, '正常回应');
  assert.strictEqual(u.contradiction_type, '无');
  // 默认宁缺：事件 skip；性格画像可 background
  assert.strictEqual(u.impression_filter.find((x) => x.id === '9').mode, 'skip');
  assert.strictEqual(u.impression_filter.find((x) => x.id === '8').mode, 'background_only');
  assert.ok(u.memory_filter.every((x) => x.mode === 'skip'));
  assert.strictEqual(understanding.usableKeySet(u.memory_filter).size, 0);
  assert.ok(understanding.usableKeySet(u.impression_filter).has('8'));
  console.log('normalize fail-open ok');
}

function testNormalizeFilter() {
  const flashes = [{ key: 'mem:12', text: '讨厌加班', block: '脑海' }];
  const imps = [{ id: 9, cat: '习惯', facts: ['跑两步就喘'] }];
  const u = understanding.normalizeUnderstandingPayload({
    has_contradiction: true,
    contradiction_type: '反话',
    suggested_strategy: '侧面关心',
    inferred_emotion: '闷',
    impression_filter: [{ impression_id: '9', mode: 'skip', reason: '生理 vs 情绪' }],
    memory_filter: [{ memory_id: 'mem:12', block: '脑海', mode: 'skip', reason: '话题不相关' }],
  }, {
    flashCandidates: flashes,
    narratives: [],
    impressions: imps,
    perceptionSnap: { daily_anomaly_score: 15, anomaly_trend: '无异常' },
  });
  assert.strictEqual(u.has_contradiction, true);
  assert.strictEqual(u.suggested_strategy, '侧面关心');
  assert.strictEqual(u.impression_filter[0].mode, 'skip');
  assert.strictEqual(u.memory_filter[0].mode, 'skip');
  assert.strictEqual(understanding.usableKeySet(u.memory_filter).size, 0);
  const block = understanding.formatUnderstandingPromptBlock(u);
  assert.ok(block.includes('反话'));
  assert.ok(!block.includes('侧面关心'));
  const fit = understanding.normalizeUnderstandingPayload({
    portrait_fit: '符合',
    portrait_note: '嘴硬',
    suggested_strategy: '侧面关心',
  }, { flashCandidates: [], narratives: [], impressions: imps });
  assert.strictEqual(fit.portrait_fit, '符合');
  const fitBlock = understanding.formatUnderstandingPromptBlock(fit);
  assert.ok(fitBlock.includes('很像你认识的对方'));
  assert.ok(fitBlock.includes('嘴硬'));
  console.log('normalize filter ok');
}

function testSkip() {
  assert.strictEqual(understanding.shouldSkipUnderstanding({
    flashCandidates: [],
    narratives: [],
    impressions: [],
    userMessage: '周末去哪玩',
    perceptionSnap: { daily_anomaly_score: 8 },
  }), true);
  assert.strictEqual(understanding.shouldSkipUnderstanding({
    flashCandidates: [],
    narratives: [],
    impressions: [],
    userMessage: '我今天好累感觉心累',
    perceptionSnap: { daily_anomaly_score: 8 },
  }), false);
  assert.strictEqual(understanding.shouldSkipUnderstanding({
    flashCandidates: [{ key: 'mem:1' }],
    narratives: [],
    impressions: [],
    userMessage: '周末去哪玩',
    perceptionSnap: { daily_anomaly_score: 8 },
  }), false);
  assert.strictEqual(understanding.shouldSkipUnderstanding({
    flashCandidates: [],
    narratives: [],
    impressions: [{ id: 1, standing: true, cat: '性格' }],
    userMessage: '周末去哪玩',
    perceptionSnap: { daily_anomaly_score: 8 },
  }), true, 'standing portrait alone should not force extra call');
  console.log('skip rules ok');
}

function testParseJson() {
  const p = understanding.parseJsonObject('```json\n{"has_contradiction":true}\n```');
  assert.strictEqual(p.has_contradiction, true);
  console.log('parse json ok');
}

testPerceptionSignals();
testNormalizeFailOpen();
testNormalizeFilter();
testSkip();
testParseJson();
console.log('all understanding tests passed');
process.exit(0);

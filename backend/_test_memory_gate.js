'use strict';

const assert = require('assert');
const gate = require('./memory-gate-helper');
const understanding = require('./understanding-helper');

function testHardBypass() {
  assert.ok(gate.hardSpeakBypass('你还记得上次吗'));
  assert.ok(gate.hardSpeakBypass('你是不是忘了'));
  assert.ok(!gate.hardSpeakBypass('周末去哪玩'));
  console.log('hard bypass ok');
}

function testDualThreshold() {
  const cfg = gate.getConfig({});
  gate._stateForTest.clear();
  const ruled = gate.ruleAssignModes({
    charId: 99,
    userMessage: '加班好烦',
    flashCandidates: [
      { key: 'mem:1', vecScore: 0.7, kwHit: true, text: '讨厌加班' },
      { key: 'mem:2', vecScore: 0.5, kwHit: false, text: '吃过火锅' },
      { key: 'mem:3', vecScore: 0.2, kwHit: false, text: '养过猫' },
    ],
    narratives: [],
    impressions: [
      { id: 1, standing: true, cat: '性格', facts: ['嘴硬'], score: 0 },
      { id: 2, standing: false, cat: '习惯', facts: ['跑两步就喘'], score: 2, vecScore: 0.2 },
    ],
    cfg,
  });
  assert.strictEqual(ruled.modeById.get('mem:1'), 'usable_now');
  assert.strictEqual(ruled.modeById.get('mem:2'), 'background_only');
  assert.strictEqual(ruled.modeById.get('mem:3'), 'skip');
  assert.strictEqual(ruled.modeById.get('1'), 'background_only');
  assert.strictEqual(ruled.modeById.get('2'), 'skip');
  console.log('dual threshold ok');
}

function testBudget() {
  const cfg = gate.getConfig({});
  gate._stateForTest.clear();
  gate.beginTurn(7);
  gate.recordSpoken(7, ['mem:9']);
  for (let i = 0; i < 3; i++) gate.beginTurn(7);
  // 对方词命中：不因明说预算闷死
  const kwRuled = gate.ruleAssignModes({
    charId: 7,
    userMessage: '又加班了',
    flashCandidates: [{ key: 'mem:10', vecScore: 0.8, kwHit: true }],
    narratives: [],
    impressions: [],
    cfg,
  });
  assert.strictEqual(kwRuled.modeById.get('mem:10'), 'usable_now', 'kw hit survives budget');
  assert.ok(kwRuled.budgetExhausted);
  // 高分但无词命中：预算耗尽时降为 background
  const softRuled = gate.ruleAssignModes({
    charId: 7,
    userMessage: '今天好累',
    flashCandidates: [{ key: 'mem:11', vecScore: 0.8, kwHit: false }],
    narratives: [],
    impressions: [],
    cfg,
  });
  assert.strictEqual(softRuled.modeById.get('mem:11'), 'background_only', 'budget demotes non-kw speak');
  const forced = gate.ruleAssignModes({
    charId: 7,
    userMessage: '你还记得加班那次吗',
    flashCandidates: [{ key: 'mem:10', vecScore: 0.8, kwHit: true }],
    narratives: [],
    impressions: [],
    cfg,
  });
  assert.strictEqual(forced.modeById.get('mem:10'), 'usable_now', 'hard bypass ignores budget');
  console.log('budget ok');
}

function testFailOpenDefaults() {
  const flashes = [{ key: 'mem:12', text: '讨厌加班', block: '脑海' }];
  const imps = [{ id: 9, cat: '习惯', facts: ['跑两步就喘'] }, { id: 8, cat: '性格', facts: ['嘴硬'], standing: true }];
  const u = understanding.normalizeUnderstandingPayload({}, {
    flashCandidates: flashes,
    narratives: [],
    impressions: imps,
    perceptionSnap: { daily_anomaly_score: 12, anomaly_trend: '无异常' },
  });
  assert.strictEqual(u.impression_filter.find((x) => x.id === '9').mode, 'skip');
  assert.strictEqual(u.impression_filter.find((x) => x.id === '8').mode, 'background_only');
  assert.ok(u.memory_filter.every((x) => x.mode === 'skip'));
  console.log('fail-open defaults ok');
}

function testModelModeParse() {
  const flashes = [{ key: 'mem:12', text: '讨厌加班', block: '脑海' }];
  const imps = [{ id: 9, cat: '习惯', facts: ['跑两步就喘'] }];
  const u = understanding.normalizeUnderstandingPayload({
    impression_filter: [{ impression_id: '9', mode: 'skip', reason: '生理 vs 情绪' }],
    memory_filter: [{ memory_id: 'mem:12', block: '脑海', mode: 'background_only' }],
    allow_speak_memory: false,
  }, {
    flashCandidates: flashes,
    narratives: [],
    impressions: imps,
    perceptionSnap: {},
  });
  assert.strictEqual(u.impression_filter[0].mode, 'skip');
  assert.strictEqual(u.memory_filter[0].mode, 'background_only');
  assert.strictEqual(u.allow_speak_memory, false);
  console.log('model mode parse ok');
}

function testClusterCap() {
  const keep = gate.capSpeakClusters(
    new Set(['mem:1', 'mem:2', 'ep:9', 'mem:3']),
    new Map([['mem:1', 'ep:9'], ['mem:2', 'ep:9'], ['ep:9', 'ep:9'], ['mem:3', 'mem:3']]),
    1,
  );
  assert.ok(keep.has('mem:1') && keep.has('mem:2') && keep.has('ep:9'));
  assert.ok(!keep.has('mem:3'));
  console.log('cluster cap ok');
}

function testSameTopicContinue() {
  const cfg = gate.getConfig({});
  gate._stateForTest.clear();
  gate.beginTurn(4);
  gate.recordSpoken(4, ['mem:20', 'ep:8'], { clusterIds: ['ep:8'], cues: ['看展'] });
  gate.beginTurn(4);
  const ruled = gate.ruleAssignModes({
    charId: 4,
    userMessage: '那周六呢',
    flashCandidates: [
      { key: 'mem:20', clusterId: 'ep:8', vecScore: 0.35, kwHit: false, text: '约了看展' },
      { key: 'ep:8', clusterId: 'ep:8', vecScore: 0.35, kwHit: false, kind: 'episode' },
    ],
    narratives: [],
    impressions: [],
    cfg,
    clusterByKey: new Map([['mem:20', 'ep:8'], ['ep:8', 'ep:8']]),
  });
  assert.strictEqual(ruled.modeById.get('mem:20'), 'usable_now', 'same cluster continues below T_speak');
  assert.strictEqual(ruled.modeById.get('ep:8'), 'usable_now');
  const shifted = gate.ruleAssignModes({
    charId: 4,
    userMessage: '中午吃什么',
    flashCandidates: [
      { key: 'mem:20', clusterId: 'ep:8', vecScore: 0.1, kwHit: false },
    ],
    narratives: [],
    impressions: [],
    cfg,
    clusterByKey: new Map([['mem:20', 'ep:8']]),
  });
  assert.strictEqual(shifted.modeById.get('mem:20'), 'skip', 'topic shift drops cluster');
  console.log('same-topic continue ok');
}

testHardBypass();
testDualThreshold();
testBudget();
testFailOpenDefaults();
testModelModeParse();
testClusterCap();
testSameTopicContinue();
console.log('all memory-gate tests passed');
process.exit(0);

const assert = require('assert');
const cluster = require('./portrait-cluster-helper');
const self = require('./char-self-helper');

assert.strictEqual(cluster.slotIntimateCategory('亲密', '喜欢慢一点'), '亲密');
assert.strictEqual(cluster.slotIntimateCategory('喜好', '爱吃辣'), '');
assert.strictEqual(cluster.slotIntimateCategory('喜好', '那方面还比较生疏'), '亲密');
assert.strictEqual(cluster.slotIntimateCategory('喜好', '这道手艺还比较生疏'), '');
assert.strictEqual(cluster.slotIntimateCategory('喜好', '走路慢一点'), '');
assert.strictEqual(cluster.isIntimateKnowText('打针怕疼'), false);
assert.strictEqual(cluster.looksBrokenFact('那方面喜欢被抱着'), false);
assert.strictEqual(cluster.looksBrokenFact('吃的'), true);

const items = self.selfViewItemsFromMemories({
  self_views: [
    { category: '行为习惯', content: '我习惯熬夜' },
    { category: '亲密', content: '那方面我还比较生疏' },
  ],
}, [], '林');
assert.strictEqual(items.length, 2);
assert.strictEqual(items[0].category, '亲密');
assert.strictEqual(items[0].confirmed, 1);
assert.strictEqual(items[1].category, '行为习惯');

const onlyHabit = self.selfViewItemsFromMemories({
  self_views: [{ category: '喜好', content: '我爱喝美式' }],
}, [], '林');
assert.strictEqual(onlyHabit.length, 1);
assert.strictEqual(onlyHabit[0].category, '喜好');

console.log('intimate know ok');
process.exit(0);

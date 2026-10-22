'use strict';

const assert = require('assert');
const tree = require('./memory-tree-helper');

function frag(category, content) {
  return { category, content };
}

assert.strictEqual(
  tree.classifyFragKind(frag('情感状态', '晚上对方敷衍了我，我心里堵，后来故意冷淡。')),
  'affection',
  '有原因的委屈应进感情记忆点'
);
assert.strictEqual(
  tree.classifyFragKind(frag('重要时刻', '我因为对方没回消息而生气，于是不想理对方。')),
  'affection'
);
assert.strictEqual(
  tree.classifyFragKind(frag('日常点滴', '我头疼，不舒服，想躺一会。')),
  'event',
  '身体不适不是自己的关系负面情绪'
);
assert.strictEqual(
  tree.classifyFragKind(frag('情感状态', '对方说他因为加班很难过。')),
  'event',
  '只是对方难过，不是我的感受'
);
assert.notStrictEqual(
  tree.classifyFragKind(frag('偏好与习惯', '我喜欢冷淡一点的穿搭，因为你说过好看。')),
  'affection',
  '喜好不要被收成负面情绪记忆点'
);
assert.strictEqual(tree.utteranceShowsOwnNegativeEmotion('别来找我，我现在不想理你'), true);
assert.strictEqual(tree.utteranceShowsOwnNegativeEmotion('我现在很生气'), true);
assert.strictEqual(tree.utteranceShowsOwnNegativeEmotion('我很生气'), true);
assert.strictEqual(tree.utteranceShowsOwnNegativeEmotion('别生气'), false);
assert.strictEqual(tree.utteranceShowsOwnNegativeEmotion('不要生气'), false);
assert.strictEqual(tree.utteranceShowsOwnNegativeEmotion('我没生气'), false);
assert.strictEqual(tree.utteranceShowsOwnNegativeEmotion('哼'), false);
assert.strictEqual(tree.isOwnNegativeEmotionFrag('我有点难过', '情感状态'), false);

console.log('own emotion memory ok');

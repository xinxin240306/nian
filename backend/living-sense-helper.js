/**
 * 活人感感知包：阶段动机 + 今日相处气候 + 主场在自己日子。
 * 刻意写成「背景感知」，禁止任务化/剧本化，避免再套一层壳。
 */
function stageMotiveLine(aff) {
  if (!aff) return '';
  const kind = aff.kind || 'romantic';
  const stage = aff.stage || '';
  const d = Number(aff.disappointment) || 0;
  const cooling = !!aff.coolingThought;

  if (kind !== 'romantic') {
    if (stage === 'strained') return '眼下有点别扭：要不要说破、要不要退一步——按性格，不是必答题。';
    if (stage === 'bonded' || stage === 'close') return '已是熟人：过日子式相处即可，不必每轮证明感情。';
    if (stage === 'familiar') return '处熟了一些：可多一点随意，仍按人设分寸。';
    if (stage === 'distant') return '还在相互摸底：好奇或保留都可以，看性格。';
    return '';
  }

  if (cooling || stage === 'cooling') {
    return '心里在降温：靠近、冷淡或想退，都按性格与自尊，不是必须挽留。';
  }
  if (stage === 'strained' || d >= 45) {
    return '关系紧绷：在意的是界线与态度，不是反复验「你爱不爱我」。';
  }
  if (stage === 'new' || stage === 'warming') {
    return '还偏新：心里可能摸对方认真程度、相处节奏合不合——可放在心上，不必每轮验货。';
  }
  if (stage === 'settling') {
    return '磨合期：更在意日常合不合、摩擦怎么过；默认已是一对。';
  }
  if (stage === 'settled' || stage === 'deep') {
    return '已在过日子：默认信任。惦记可以有，不必反复宣示所有权。';
  }
  return '';
}

function selfLifeHint(opts = {}) {
  const activity = String(opts.activity || '').trim().slice(0, 40);
  const lowEnergy = !!opts.lowEnergy;
  const busy = !!opts.busy || /加班|开会|通勤|赶路|上班|训练|赶稿|值班|熬夜/.test(activity);
  const bits = [];
  if (activity) bits.push(`这会儿大概在：${activity}`);
  if (busy) bits.push('正占着手/脑子');
  if (lowEnergy) bits.push('人有点沉/累');
  if (!bits.length) return '对照【此刻】过你自己的事；空闲还是没空，你自己知道。';
  return bits.join('；');
}

/**
 * @param {object} char
 * @param {object} [opts]
 * @param {object|null} [opts.affection] getBrainAffection 结果
 * @param {object|null} [opts.climate] computePeerClimate 结果
 * @param {string} [opts.activity]
 * @param {boolean} [opts.lowEnergy]
 * @param {boolean} [opts.busy]
 */
function buildLivingSenseBlock(char, opts = {}) {
  if (!char?.id) return '';

  let aff = opts.affection;
  if (aff === undefined) {
    try { aff = require('./affection-helper').getBrainAffection(char.id); } catch { aff = null; }
  }

  let climate = opts.climate;
  if (climate === undefined) {
    try { climate = require('./peer-climate-helper').computePeerClimate(char.id); } catch { climate = null; }
  }

  const motive = stageMotiveLine(aff);
  const stageLabel = aff?.stageLabel || '';
  const hasClimate = !!(climate && climate.signal);
  const life = selfLifeHint(opts);
  const hasSelfSignal = !!(opts.activity || opts.lowEnergy || opts.busy);

  // 太平静：只留一句主场提醒，避免空壳套话堆砌
  if (!hasClimate && !motive && !hasSelfSignal) {
    return [
      '【过日子】主场是你自己的日子，聊天是顺手拿手机。',
      '察觉≠开口；累了/烦了可以少理。',
    ].join('\n');
  }

  const lines = [
    '【过日子】',
    '主场是你自己的世界；微信只是插进来的一条线。',
    `我这边：${life}`,
  ];

  if (stageLabel || motive) {
    lines.push(`感情阶段：${stageLabel || '相处中'}${motive ? `。${motive}` : ''}`);
  }

  if (hasClimate) {
    if (climate.overall) lines.push(`今天和对方：${climate.overall}`);
    if (climate.trajectory) lines.push(`轨迹：${climate.trajectory}`);
    if (climate.unfinishedHint) lines.push(`未了：${climate.unfinishedHint}`);
  }

  lines.push('察觉≠开口。先活在自己的状态里，再决定理不理手机——按【性格】。');

  return lines.join('\n');
}

/** 心里草稿：多想一层「日子/气候」，仍只两行标记，不增加可见套话 */
function livingSenseThinkHint() {
  return '【怎么看】里可带一句：我这边怎样、今天和对方怎样、这轮要不要理（续还是变了）。仍只写判断，禁止把说明抄进开口。';
}

module.exports = {
  stageMotiveLine,
  buildLivingSenseBlock,
  livingSenseThinkHint,
  selfLifeHint,
};

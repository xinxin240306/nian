const fs = require('fs');
const p = require('path').join(__dirname, 'emotion-helper.js');
let s = fs.readFileSync(p, 'utf8');

s = s.replace(/\bdLonging\b/g, 'dYearning');
s = s.replace(/temper\.longingGain/g, 'temper.yearningGain');
s = s.replace(/temper\.longingThreshold/g, 'temper.yearningThreshold');

s = s.replace(
  /const gainLg = impact\.dYearning > 0 \? temper\.yearningGain : temper\.recovery;/,
  'const gainY = impact.dYearning > 0 ? temper.yearningGain : temper.recovery;',
);

s = s.replace(
  /next\.fuel\.longing = clamp\(next\.fuel\.longing \+ \(impact\.dYearning \|\| 0\) \* gain(?:Lg|Y), 0, 100\);/,
  '/* yearning applied after intimacy */',
);

// Rebuild applyImpact fuel block if still broken
s = s.replace(
  `  next.fuel.anger = clamp(next.fuel.anger + (impact.dAnger || 0) * gainA, 0, 100);
  next.fuel.hurt = clamp(next.fuel.hurt + (impact.dHurt || 0) * gainH, 0, 100);
  next.fuel.low = clamp(next.fuel.low + (impact.dLow || 0) * gainL, 0, 100);
  /* yearning applied after intimacy */
  next.fuel.desire = clamp(next.fuel.desire + (impact.dDesire || 0) * gainD, 0, 100);
  next.fuel.intimacy = clamp(next.fuel.intimacy + (impact.dIntimacy || 0) * gainI, 0, 100);

  // 思念高时会微微拱欲望；亲近够才更容易燃起来
  if (next.fuel.longing >= 55 && (impact.dYearning || 0) > 0) {
    next.fuel.desire = clamp(next.fuel.desire + 1.2 * temper.desireGain, 0, 100);
  }`,
  `  next.fuel.anger = clamp(next.fuel.anger + (impact.dAnger || 0) * gainA, 0, 100);
  next.fuel.hurt = clamp(next.fuel.hurt + (impact.dHurt || 0) * gainH, 0, 100);
  next.fuel.low = clamp(next.fuel.low + (impact.dLow || 0) * gainL, 0, 100);
  next.fuel.desire = clamp(next.fuel.desire + (impact.dDesire || 0) * gainD, 0, 100);
  next.fuel.intimacy = clamp(next.fuel.intimacy + (impact.dIntimacy || 0) * gainI, 0, 100);
  next.yearning = clampYearningToIntimacy(
    (Number(next.yearning) || 0) + (impact.dYearning || 0) * gainY,
    next.fuel.intimacy,
  );

  // 惦念压高且亲密够时，微微拱欲望
  if (next.yearning >= 55 && next.fuel.intimacy >= 28 && (impact.dYearning || 0) > 0) {
    next.fuel.desire = clamp(next.fuel.desire + 1.2 * temper.desireGain, 0, 100);
  }`,
);

s = s.replace(
  `    } else if (
      next.fuel.longing >= temper.yearningThreshold
      && next.fuel.anger < 50
      && next.fuel.hurt < 55
    ) {
      flashed = { type: 'longing', at: nowIso, note: next.note || '思念涌上来了' };
      next.flashpoint = flashed;
      next.arousal = clamp(next.arousal + 8, 0, 100);
      next.valence = clamp(next.valence - 4, -100, 100);
      next.fuel.longing = clamp(next.fuel.longing - 14, 36, 100);
    } else if (
      next.fuel.intimacy >= temper.intimacyThreshold
      && (impact.dIntimacy || 0) > 2
      && next.valence >= 10
      && next.fuel.anger < 40
    ) {
      flashed = { type: 'intimacy', at: nowIso, note: next.note || '亲近感一下子满了' };
      next.flashpoint = flashed;
      next.valence = clamp(next.valence + 6, -100, 100);
      next.arousal = clamp(next.arousal + 6, 0, 100);
      next.fuel.intimacy = clamp(next.fuel.intimacy - 10, 45, 100);
    }`,
  `    } else if (
      next.yearning >= temper.yearningThreshold
      && next.fuel.intimacy >= 28
      && next.fuel.anger < 50
      && next.fuel.hurt < 55
    ) {
      flashed = { type: 'longing', at: nowIso, note: next.note || '思念涌上来了' };
      next.flashpoint = flashed;
      next.arousal = clamp(next.arousal + 8, 0, 100);
      next.valence = clamp(next.valence - 4, -100, 100);
      next.yearning = clampYearningToIntimacy(next.yearning - 14, next.fuel.intimacy);
    } else if (
      next.fuel.intimacy >= temper.intimacyThreshold
      && next.yearning < 40
      && (impact.dIntimacy || 0) > 2
      && next.valence >= 10
      && next.fuel.anger < 40
    ) {
      flashed = { type: 'intimacy', at: nowIso, note: next.note || '亲近感一下子满了' };
      next.flashpoint = flashed;
      next.valence = clamp(next.valence + 6, -100, 100);
      next.arousal = clamp(next.arousal + 6, 0, 100);
      next.fuel.intimacy = clamp(next.fuel.intimacy - 10, 45, 100);
      next.yearning = clampYearningToIntimacy(next.yearning, next.fuel.intimacy);
    }`,
);

s = s.replace(
  `  // 思念更慢消；欲望中速；亲密最慢掉（空窗时思念还会反涨一点）
  m.fuel.desire = clamp(m.fuel.desire - hours * (2.8 * temper.recovery), 0, 100);
  m.fuel.intimacy = clamp(m.fuel.intimacy - hours * (1.2 * temper.recovery), 0, 100);
  const longingDecay = hours * (1.5 * temper.recovery);
  // 空窗越久，思念越容易积（亲近关系更明显），再被衰减对冲
  const idleBoost = hours >= 0.8
    ? hours * (temper.closeRelationship ? 1.8 : 0.7) * temper.yearningGain
    : 0;
  m.fuel.longing = clamp(m.fuel.longing - longingDecay + idleBoost, 0, 100);
  if (idleBoost > 0.5 && m.fuel.intimacy >= 25 && hours >= 2) {
    m.fuel.desire = clamp(m.fuel.desire + hours * 0.35 * temper.desireGain, 0, 100);
  }

  if (m.flashpoint && cooledFlashpoint(m.flashpoint, new Date(nowMs).toISOString())) {
    // 燃点过后留余波，不立刻清空
    if (hours >= 1.2) m.flashpoint = null;
  }

  m.primary = pickPrimary(m);
  m.label = softLabel(m);
  const quiet = Math.abs(m.valence - baseline) < 6
    && maxNegFuel(m.fuel) < 12
    && maxBondFuel(m.fuel) < 18;
  if (quiet) m.note = '';
  return m;
}`,
  `  m.fuel.desire = clamp(m.fuel.desire - hours * (2.8 * temper.recovery), 0, 100);
  m.fuel.intimacy = clamp(m.fuel.intimacy - hours * (1.2 * temper.recovery), 0, 100);
  // 空窗：亲密还在时惦念压会涨；亲密掉了惦念也跟着塌
  const idleBoost = hours >= 0.8 && m.fuel.intimacy >= 18
    ? hours * (temper.closeRelationship ? 1.8 : 0.7) * temper.yearningGain
      * clamp(m.fuel.intimacy / 50, 0.35, 1.4)
    : 0;
  const yearningDecay = hours * (1.6 * temper.recovery);
  m.yearning = clampYearningToIntimacy(m.yearning - yearningDecay + idleBoost, m.fuel.intimacy);
  if (idleBoost > 0.5 && m.fuel.intimacy >= 25 && hours >= 2) {
    m.fuel.desire = clamp(m.fuel.desire + hours * 0.35 * temper.desireGain, 0, 100);
  }

  if (m.flashpoint && cooledFlashpoint(m.flashpoint, new Date(nowMs).toISOString())) {
    if (hours >= 1.2) m.flashpoint = null;
  }

  m.primary = pickPrimary(m);
  m.label = softLabel(m);
  const quiet = Math.abs(m.valence - baseline) < 6
    && maxNegFuel(m.fuel) < 12
    && maxBondFuel(m) < 18;
  if (quiet) m.note = '';
  return m;
}`,
);

// appendEmotionLog: store yearning in fuel_longing column for history
s = s.replace(
  '      round1(mood.fuel?.longing || 0),',
  '      round1(mood.yearning || 0),',
);

// touchMood: user chat reduces yearning
s = s.replace(
  `  // 用户主动说话：思念被当面接住，略回落
  if (role === 'user' && !impact?.soft) {
    mood.fuel.longing = clamp(mood.fuel.longing - 3.5 * temper.recovery, 0, 100);
  }`,
  `  // 用户主动说话：当面接住，亲密上的惦念压略回落
  if (role === 'user' && !impact?.soft) {
    mood.yearning = clampYearningToIntimacy(mood.yearning - 3.5 * temper.recovery, mood.fuel.intimacy);
  }`,
);

s = s.replace(
  `/** 把心情里的思念轻度同步到桌宠 drive.longing，两边别各跑各的 */
function syncDriveFromMoodLonging(charId, mood) {
  if (!charId || !mood?.fuel) return;
  try {
    const driveHelper = require('./robot-drive-helper');
    const drive = driveHelper.getInnerDrive({ id: charId });
    const target = Number(mood.fuel.longing) || 0;
    // 只朝心情方向缓拉，不覆盖桌宠自己的无聊/独处逻辑
    const blended = drive.longing * 0.65 + target * 0.35;
    if (Math.abs(blended - drive.longing) < 1.5) return;
    drive.longing = clamp(blended, 0, 100);
    driveHelper.saveInnerDrive(charId, drive);
  } catch {}
}`,
  `/** 把亲密上的惦念压轻度同步到桌宠 drive.longing */
function syncDriveFromMoodLonging(charId, mood) {
  if (!charId || !mood) return;
  try {
    const driveHelper = require('./robot-drive-helper');
    const drive = driveHelper.getInnerDrive({ id: charId });
    const target = Number(mood.yearning) || 0;
    const blended = drive.longing * 0.65 + target * 0.35;
    if (Math.abs(blended - drive.longing) < 1.5) return;
    drive.longing = clamp(blended, 0, 100);
    driveHelper.saveInnerDrive(charId, drive);
  } catch {}
}`,
);

// silence impact: dYearning already renamed; intimacy shouldn't drop as hard when yearning rises
s = s.replace(
  `  let dYearning = scale * (temper.closeRelationship ? 0.7 : 0.35);
  let dDesire = temper.closeRelationship ? scale * 0.12 : 0;
  let dIntimacy = -scale * 0.15;`,
  `  let dYearning = scale * (temper.closeRelationship ? 0.7 : 0.35);
  let dDesire = temper.closeRelationship ? scale * 0.12 : 0;
  // 空窗主要抬惦念压，亲密略掉但不塌（思念挂在亲密上）
  let dIntimacy = -scale * 0.08;`,
);

// describeEvent / publicMoodView / prompts
s = s.replace(
  `  } else if (row.primary_tag === 'longing' && Number(row.fuel_longing) >= 60) {
    type = 'longing';
  } else if (row.primary_tag === 'desire' && Number(row.fuel_desire) >= 60) {`,
  `  } else if (row.primary_tag === 'longing' && Number(row.fuel_longing) >= 60 && Number(row.fuel_intimacy) >= 25) {
    type = 'longing';
  } else if (row.primary_tag === 'desire' && Number(row.fuel_desire) >= 60) {`,
);

s = s.replace(
  `  if (type === 'longing') {
    return note || \`思念积压到燃点，呈现「\${label || '思念'}」。会渗进语气与惦念，见面/被接住后才会慢慢松。\`;
  }`,
  `  if (type === 'longing') {
    return note || \`亲密里的惦念压到燃点，呈现「\${label || '思念'}」。会渗进语气；见面/被接住后才会慢慢松，亲密本身不会瞬间归零。\`;
  }`,
);

s = s.replace(
  `    fuel: {
      anger: Math.round(m.fuel.anger),
      hurt: Math.round(m.fuel.hurt),
      low: Math.round(m.fuel.low),
      longing: Math.round(m.fuel.longing),
      desire: Math.round(m.fuel.desire),
      intimacy: Math.round(m.fuel.intimacy),
    },
    thresholds: {
      anger: Math.round(temper.angerThreshold),
      hurt: Math.round(temper.hurtThreshold),
      low: Math.round(temper.lowThreshold),
      longing: Math.round(temper.longingThreshold),
      desire: Math.round(temper.desireThreshold),
      intimacy: Math.round(temper.intimacyThreshold),
    },`,
  `    fuel: {
      anger: Math.round(m.fuel.anger),
      hurt: Math.round(m.fuel.hurt),
      low: Math.round(m.fuel.low),
      desire: Math.round(m.fuel.desire),
      intimacy: Math.round(m.fuel.intimacy),
    },
    yearning: Math.round(m.yearning || 0),
    thresholds: {
      anger: Math.round(temper.angerThreshold),
      hurt: Math.round(temper.hurtThreshold),
      low: Math.round(temper.lowThreshold),
      desire: Math.round(temper.desireThreshold),
      intimacy: Math.round(temper.intimacyThreshold),
      yearning: Math.round(temper.yearningThreshold),
    },`,
);

s = s.replace(
  `    if (ft === 'longing') buildup = '思念刚涌起';
    else if (ft === 'desire') buildup = '欲念刚涌起';
    else if (ft === 'intimacy') buildup = '亲近感刚涌起';
    else buildup = '刚过燃点';`,
  `    if (ft === 'longing') buildup = '亲密里的思念刚涌起';
    else if (ft === 'desire') buildup = '欲念刚涌起';
    else if (ft === 'intimacy') buildup = '亲近感刚涌起';
    else buildup = '刚过燃点';`,
);

s = s.replace(
  `    '思念、惦念、亲近感、欲望也会像火气一样慢慢积压与回落，并渗进语气——怎么表现完全看【性格】【关系尺度】，禁止统一撒娇或统一发情。',`,
  `    '亲密与欲望也会像火气一样积压与回落；思念/惦念是亲密在空窗时的一面，不是另开一条独立情绪——怎么表现完全看【性格】【关系尺度】，禁止统一撒娇或统一发情。',`,
);

s = s.replace(
  `  if (m.fuel.longing >= 45 && m.fuel.anger < 50) {
    lines.push(\`当前惦念/思念积压约偏\${m.fuel.longing >= 65 ? '高' : '中'}：可在语气里带一点挂念或口是心非，但禁止每句催回、禁止统一娇嗔。\`);
  }`,
  `  if ((m.yearning || 0) >= 40 && m.fuel.intimacy >= 25 && m.fuel.anger < 50) {
    lines.push(\`当前亲密里的惦念压约偏\${m.yearning >= 65 ? '高' : '中'}：可在语气里带一点挂念或口是心非，但禁止每句催回、禁止统一娇嗔。\`);
  }`,
);

s = s.replace(
  `  if (m.flashpoint?.type === 'longing' || m.primary === 'longing' || m.fuel.longing >= 55) {
    return '心里有惦念：日程可带一点走神、等消息、或想找人却又克制；勿写成无脑甜蜜约会日，除非人设就是这样';
  }`,
  `  if (m.flashpoint?.type === 'longing' || m.primary === 'longing' || ((m.yearning || 0) >= 50 && m.fuel.intimacy >= 28)) {
    return '心里有惦念（亲密的空窗面）：日程可带一点走神、等消息、或想找人却又克制；勿写成无脑甜蜜约会日，除非人设就是这样';
  }`,
);

// missApart note tweak in score
s = s.replace(
  `  if (missApart) {
    // 久别/见不到：思念往上拱；当面「想你」示好则略松
    dYearning += 11; dV += 2; dA += 3; dIntimacy += 3; dDesire += 3;
    note = note || '惦念被撩起来了';
  } else if (missSoft && warm) {
    dYearning -= 5; dDesire += 3; dIntimacy += 3;
  } else if (missSoft) {
    dYearning += 6; dIntimacy += 2; dDesire += 2;
    note = note || '有点惦念';
  }`,
  `  if (missApart) {
    // 久别：唤起亲密，同时抬惦念压（思念挂在亲密上）
    dYearning += 11; dV += 2; dA += 3; dIntimacy += 5; dDesire += 3;
    note = note || '惦念被撩起来了';
  } else if (missSoft && warm) {
    dYearning -= 6; dDesire += 3; dIntimacy += 4;
  } else if (missSoft) {
    dYearning += 6; dIntimacy += 3; dDesire += 2;
    note = note || '有点惦念';
  }`,
);

s = s.replace(
  `    if (/想你|思念|惦念|挂念|好想见面/.test(t)) { dYearning += 9; dA += 4; dIntimacy += 2; }`,
  `    if (/想你|思念|惦念|挂念|好想见面/.test(t)) { dYearning += 9; dA += 4; dIntimacy += 3; }`,
);

// event fuel still exposes longing from log column as yearning for UI detail
s = s.replace(
  `    fuel: {
      anger: Math.round(Number(row.fuel_anger) || 0),
      hurt: Math.round(Number(row.fuel_hurt) || 0),
      low: Math.round(Number(row.fuel_low) || 0),
      longing: Math.round(Number(row.fuel_longing) || 0),
      desire: Math.round(Number(row.fuel_desire) || 0),
      intimacy: Math.round(Number(row.fuel_intimacy) || 0),
    },`,
  `    fuel: {
      anger: Math.round(Number(row.fuel_anger) || 0),
      hurt: Math.round(Number(row.fuel_hurt) || 0),
      low: Math.round(Number(row.fuel_low) || 0),
      desire: Math.round(Number(row.fuel_desire) || 0),
      intimacy: Math.round(Number(row.fuel_intimacy) || 0),
    },
    yearning: Math.round(Number(row.fuel_longing) || 0),`,
);

fs.writeFileSync(p, s);
const left = (s.match(/fuel\.longing/g) || []).length;
const gainLg = (s.match(/gainLg/g) || []).length;
console.log('left fuel.longing=', left, 'gainLg=', gainLg);
console.log('yearning refs=', (s.match(/\byearning\b/g) || []).length);

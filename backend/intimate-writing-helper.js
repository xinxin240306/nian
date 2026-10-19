/**
 * 叙事向亲密戏：小剧场、梦境、穿越、文字视频。
 * 只约束连贯和「还是这个人」，不给动作节目单。
 */

const INTIMATE_LOGIC_NOTE = `【亲密·还是这个人】
先接上一拍：衣着、姿势、谁在碰谁、进到哪、场上已经有的东西、人在哪。别瞬移，别凭空把衣服穿好，别变出没有的道具。
够不到就先挪再碰。想换姿势、换过来弄，是这个人此刻想这么做，写清怎么换再继续；不要无故对调。
说话仍是平时那张嘴。可以有身体反应，但不要整段只报进度，也不要每轮换一套脏话说。手不必每轮报位置；腰、胸口、心跳不是默认动作。
半公开的地方就还是半公开。别改成刚好没人、门已经锁死。有人经过时停、躲还是继续，按性格。`;

const INTIMATE_ACTION_VARIETY_NOTE = '';

const THEATER_ACTION_DETAIL_NOTE = `【镜头】括号是摄像头。有接触时每轮一个：特写、远一点、或旁边的人。写具体，别写「（笑）（靠近）（继续）」。
对方自己的身体反应，对方没写的不要替对方定成事实。旁边的人可以有反应。`;

/** 从性格/行为里看这个人亲密时会怎么带，不必人设里写明「调教」 */
function intimateLeanLine(char = {}) {
  const blob = [
    char.personality, char.behavior, char.background, char.intro,
    char.emotion_style, char.nsfw_note, char.description,
  ].map((s) => String(s || '')).join('\n');
  if (!blob.trim()) return '人设太空，亲密就按此刻对话来，不要另套偏好。';
  const has = (re) => re.test(blob);
  const train = has(/调教|训诫|管教型|主奴|服从训练|S属性|Dom属性|\bDom\b|\bDomme\b|支配型|支配欲/);
  const lead = has(/强势|掌控|控制欲|爱命令|命令口吻|坏心眼|使坏|捉弄|不容拒绝|压迫感|看对方(?:慌|乱|听话)/);
  const led = has(/M属性|偏M|想被(?:带|欺负|命令|弄)|软萌|撒娇|依赖|听话就乖/);
  const shy = has(/害羞|纯情|脸皮薄|慢热|社恐|不经撩/);
  const gentle = has(/温柔|体贴|会哄|照顾人|心软/);
  const tease = has(/会撩|爱撩|色气|饥渴|玩心/);

  if (train) return '从人设看，这个人亲密时偏 S：会引导对方，想慢慢开发、往调教上带。看对方的反应收放，不要摆成固定流程。';
  if (lead) return '从人设看，这个人亲密时偏主导，会自己定节奏、把对方往自己想要的方向引。人设没有调教，就不要做成调教。';
  if (led && !lead) return '从人设看，这个人更想被带着，不太会自己把场面铺开。';
  if (shy && !tease && !lead) return '从人设看，这个人想要了也会慢、会别扭，不会突然变得很会引导。';
  if (gentle && !lead) return '从人设看，这个人更想把对方弄舒服，会盯着对方的反应，节奏偏慢。';
  if (tease) return '从人设看，这个人会主动把气氛带开。花样按这个人自己的方式，不是一份清单。';
  return '从人设里看不出固定的亲密偏好，就按这个人平时怎么对人，不要另套支配或调教。';
}

function intimateActionVarietyNote() {
  return INTIMATE_ACTION_VARIETY_NOTE;
}

function intimateLogicNote() {
  return INTIMATE_LOGIC_NOTE;
}

function intimateNarrativeNotes() {
  return INTIMATE_LOGIC_NOTE;
}

function theaterActionDetailNote() {
  return THEATER_ACTION_DETAIL_NOTE;
}

module.exports = {
  INTIMATE_ACTION_VARIETY_NOTE,
  INTIMATE_LOGIC_NOTE,
  THEATER_ACTION_DETAIL_NOTE,
  intimateActionVarietyNote,
  intimateLogicNote,
  intimateNarrativeNotes,
  theaterActionDetailNote,
  intimateLeanLine,
};

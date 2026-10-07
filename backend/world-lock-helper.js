'use strict';

/**
 * 跨世界：能通讯，不能会合。
 * 提示只写「现在怎么碰得见」，不堆禁止词——禁词表会把边界糊成「回来/见到」这种换皮。
 * 出口再滤掉会合口癖；小剧场除外。
 */
const CROSS_WORLD_MEETUP_RE = /奔现|当面见|线下见|约见面|什么时候见|几时见|周末出来|过来找[你我对方TA他她]|过去找[你我对方TA他她]|来找[你我对方TA他她]|去找[你我对方TA他她]|回去找[你我对方TA他她]|回来找[你我对方TA他她]|到你身边|到我身边|去你那边|去你那儿|去我这边|去我那儿|来你这边|来你这儿|来我这边|来我这儿|来我家|来我这|来玩|等你到身边|等我过去|等我过来|等你过来|等你过来找|等你来|你过来|你来找|你来呗|你到时候来|有空来|来接你|去接你|接你下班|接你回家|我去接|等我去找|等我来找|等[我你].{0,8}(回去|回来|过去|过来).{0,6}(找|见)[你我对方TA他她]/;

/** 「回来就能见到」这类换皮，不算回家收工 */
const MEETUP_EUPHEMISM_RE = /能见到你|见到你(?!的?(消息|字|回复))|看到你[了啦啊哦]|回来就能见|回来见|回来找|回去见|回去找|当面(?!戏)|到身边|过来陪|过来睡|来我这儿玩|等你回来.{0,10}(见|找)|等我回来.{0,10}(见|找)|回来看你|去看你|来看我/;

function normalizeMeetupScan(text) {
  return String(text || '')
    .replace(/明天见|回头见|待会见|再见了?|下次见/g, ' ')
    .replace(/见到你的?(消息|字|回复)|见你回复|看见消息|看到消息/g, ' ');
}

function isCrossWorldMeetupTalk(text) {
  const t = normalizeMeetupScan(text);
  if (!t.trim()) return false;
  return CROSS_WORLD_MEETUP_RE.test(t) || MEETUP_EUPHEMISM_RE.test(t);
}

function sentenceLooksMeetupLeak(s) {
  const raw = String(s || '').trim();
  if (!raw) return false;
  if (/开启小剧场|结束小剧场/.test(raw)) return false;
  return isCrossWorldMeetupTalk(raw);
}

function scrubMeetupLeakSpeech(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  if (!isCrossWorldMeetupTalk(raw)) return raw;
  const parts = raw
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？…!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pool = parts.length ? parts : [raw.trim()];
  const kept = pool.filter((p) => !sentenceLooksMeetupLeak(p));
  if (!kept.length) return '';
  return kept.join(kept.length > 1 && kept.every((s) => /[。！？…!?]$/.test(s)) ? '' : '\n');
}

function buildWorldLock(mode) {
  if (mode === 'diaryPeek') return '';
  if (mode === 'theater') {
    return '【小剧场】这一场里你们可以同处、约会、挨在一起；出戏后仍只是通讯，不要说等出戏了去会合。';
  }
  if (mode === 'robot') {
    return '【怎么碰见】桌上小机是眼睛和嘴。想对方：说话。想挨在一起：开小剧场。回家/收工只是你自己那边的事。';
  }
  if (mode === 'call') {
    return '【怎么碰见】这通就是你们现在能听见彼此的方式。想挨在一起开小剧场；「回去/回来」只等于你自己收工后再发消息。';
  }
  return `【怎么碰见】你们此刻靠消息和电话碰见：看见字、听见声。人不会到跟前。
「回去/回来」只等于你自己回家或收工后再聊。想挨在一起：口头邀一句，另起一行 [开启小剧场]。
随口说过的会合也当没说过；对方若提起，揭过接别的，不要解释为什么见不到。`;
}

/** 近窗已经把回家说成会合时，只说「当没说过」，不要再把见面词念一遍。 */
function buildMeetupEchoNote(recentHistory) {
  const blob = (recentHistory || [])
    .filter((m) => m && (m.role === 'assistant' || m.role === 'user'))
    .slice(-12)
    .map((m) => String(m.content || ''))
    .join('\n');
  if (!isCrossWorldMeetupTalk(blob)) return '';
  return '【纠偏】近窗若把回家/收工说成去会合、或把想见说成能见到，当没说过。本轮接别的话；想挨在一起只开小剧场。';
}

module.exports = {
  CROSS_WORLD_MEETUP_RE,
  MEETUP_EUPHEMISM_RE,
  isCrossWorldMeetupTalk,
  scrubMeetupLeakSpeech,
  buildWorldLock,
  buildMeetupEchoNote,
};

/* 游戏话题总结 — 真心话 / 默契翻牌 Q&A（不含局内闲聊） */

import { lsGet, lsSet } from './storage.js';

const MAX_TOPICS = 40;

function topicsKey(charId) {
  return `game_topics_${charId}`;
}

export function buildTopicSummary({
  game,
  question,
  userAnswer = '',
  charAnswer = '',
  userName = '你',
  charName = 'TA',
  category = '',
}) {
  const head = game === 'sync_answer'
    ? `【默契翻牌${category ? '·' + category : ''}】`
    : '【真心话】';
  const lines = [head, `问：${question}`];
  if (userAnswer) lines.push(`${userName}：${userAnswer}`);
  if (charAnswer) lines.push(`${charName}：${charAnswer}`);
  return lines.join('\n');
}

export function addGameTopic(charId, data) {
  if (!charId || !data?.question) return null;
  const userName = data.userName || '你';
  const charName = data.charName || 'TA';
  const summary = buildTopicSummary({
    game: data.game,
    question: data.question,
    userAnswer: data.userAnswer || '',
    charAnswer: data.charAnswer || '',
    userName,
    charName,
    category: data.category || '',
  });
  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    game: data.game,
    mode: data.mode || 'daily',
    question: data.question,
    userAnswer: data.userAnswer || '',
    charAnswer: data.charAnswer || '',
    category: data.category || '',
    summary,
    at: new Date().toISOString(),
  };
  const list = getGameTopics(charId);
  list.unshift(entry);
  if (list.length > MAX_TOPICS) list.length = MAX_TOPICS;
  lsSet(topicsKey(charId), list);
  return entry;
}

export function getGameTopics(charId) {
  if (!charId) return [];
  return lsGet(topicsKey(charId), []);
}

export function getGameTopic(charId, topicId) {
  return getGameTopics(charId).find(t => t.id === topicId) || null;
}

export function formatTopicLabel(topic) {
  if (!topic) return '';
  const gameLabel = topic.game === 'sync_answer' ? '默契翻牌' : '真心话';
  const q = String(topic.question || '').slice(0, 28);
  return `${gameLabel} · ${q}${topic.question?.length > 28 ? '…' : ''}`;
}

export function gameTopicGameName(game) {
  return game === 'sync_answer' ? '默契翻牌' : '真心话';
}

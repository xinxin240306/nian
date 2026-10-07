/**
 * 群聊编排：按角色话唠度筛选发言人，加权抽模式（等完整 / 并行 / 半句抢），
 * 每人独立模型调用；可选一条短反应链。
 */
const { callChatAPIComplete } = require('./api-helper');

const MAX_MAIN_REPLIES = 2;
const MAX_REACTION = 1;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
}

function parseMemberIds(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    return (Array.isArray(arr) ? arr : []).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function normalizeTalk(v) {
  const s = String(v || 'normal').trim().toLowerCase();
  if (['quiet', '少话', '沉闷', '0', 'low'].includes(s)) return 'quiet';
  if (['lively', '爱接话', '活跃', '2', 'high'].includes(s)) return 'lively';
  return 'normal';
}

function isCharBusy(char) {
  return char && char.status === 'busy' && String(char.busy_style || '') !== 'off';
}

function extractMentions(text, members) {
  const t = String(text || '');
  const hit = new Set();
  for (const m of members || []) {
    const name = String(m.name || '').trim();
    if (!name) continue;
    if (t.includes(`@${name}`) || t.includes(`＠${name}`)) hit.add(Number(m.id));
  }
  return hit;
}

function relevanceScore(char, userText) {
  const t = String(userText || '').toLowerCase();
  if (!t) return 0.3;
  let s = 0.25;
  const name = String(char.name || '');
  if (name && t.includes(name.toLowerCase())) s += 0.45;
  const bits = [
    char.personality, char.behavior, char.emotion_style, char.intro,
  ].map((x) => String(x || '')).join(' ');
  if (bits && t.length >= 2) {
    // 粗相关：用户句里的 2 字片段是否出现在人设里
    for (let i = 0; i < Math.min(t.length - 1, 24); i++) {
      const bi = t.slice(i, i + 2);
      if (bi.trim().length < 2) continue;
      if (bits.toLowerCase().includes(bi)) {
        s += 0.08;
        break;
      }
    }
  }
  if (/[?？]|吗|呢|怎|啥|谁|有没有|要不要/.test(t)) s += 0.12;
  return Math.min(1, s);
}

/**
 * 选出本轮主发言人（最多 2 人），已按优先顺序排列。
 */
function pickSpeakers(members, userText) {
  const mentions = extractMentions(userText, members);
  const scored = [];

  for (const char of members) {
    const talk = normalizeTalk(char.group_talkativeness);
    const busy = isCharBusy(char);
    const mentioned = mentions.has(Number(char.id));
    const rel = relevanceScore(char, userText);

    if (busy && !mentioned) continue;

    let willSpeak = false;
    let priority = 0;

    if (mentioned) {
      willSpeak = true;
      priority = 100 + (talk === 'lively' ? 5 : talk === 'quiet' ? 2 : 3);
    } else if (talk === 'quiet') {
      willSpeak = false;
    } else if (talk === 'lively') {
      if (busy) {
        willSpeak = false;
      } else {
        const p = 0.35 + rel * 0.55;
        willSpeak = Math.random() < p;
        priority = 40 + rel * 30;
      }
    } else {
      // normal：被问到 / 相关才回
      const asked = /[?？]|吗|呢|怎|啥|谁|有没有|要不要/.test(String(userText || ''));
      willSpeak = mentioned || (asked && rel >= 0.4) || (rel >= 0.55 && Math.random() < 0.45);
      priority = 20 + rel * 40;
    }

    if (willSpeak) scored.push({ char, priority, talk, mentioned });
  }

  scored.sort((a, b) => b.priority - a.priority);
  const picked = scored.slice(0, MAX_MAIN_REPLIES).map((x) => x.char);

  // 无人可回但有 @：强制被 @ 的人（即便 busy）
  if (!picked.length && mentions.size) {
    for (const char of members) {
      if (mentions.has(Number(char.id))) {
        picked.push(char);
        if (picked.length >= MAX_MAIN_REPLIES) break;
      }
    }
  }
  return picked;
}

/**
 * 按发言人话唠度加权抽模式。
 * wait_complete | parallel | half_interrupt
 */
function pickMode(speakers) {
  if (!speakers.length) return 'wait_complete';
  if (speakers.length === 1) {
    const talk = normalizeTalk(speakers[0].group_talkativeness);
    if (talk === 'lively' && Math.random() < 0.2) return 'half_interrupt';
    return 'wait_complete';
  }
  const talks = speakers.map((c) => normalizeTalk(c.group_talkativeness));
  const livelyN = talks.filter((t) => t === 'lively').length;
  const quietN = talks.filter((t) => t === 'quiet').length;

  let wWait = 40;
  let wParallel = 35;
  let wHalf = 25;
  if (quietN) {
    wWait = 70;
    wParallel = 25;
    wHalf = 5;
  } else if (livelyN >= 2) {
    wWait = 30;
    wParallel = 40;
    wHalf = 30;
  } else if (livelyN === 1) {
    wWait = 40;
    wParallel = 35;
    wHalf = 25;
  }

  const total = wWait + wParallel + wHalf;
  let r = Math.random() * total;
  if (r < wWait) return 'wait_complete';
  r -= wWait;
  if (r < wParallel) return 'parallel';
  return 'half_interrupt';
}

function formatTranscript(rows, memberMap, userName, opts = {}) {
  const lines = [];
  const cap = opts.limit || 40;
  const list = (rows || []).slice(-cap);
  for (const m of list) {
    if (m.role === 'user') {
      lines.push(`[${userName}] ${m.content}`);
    } else if (m.role === 'assistant') {
      const name = memberMap.get(Number(m.speaker_character_id))?.name || '成员';
      let content = String(m.content || '');
      if (opts.partialForId && Number(m.id) === Number(opts.partialForId) && opts.partialText != null) {
        content = String(opts.partialText);
      }
      lines.push(`[${name}] ${content}`);
    } else if (m.role === 'system') {
      lines.push(`[系统] ${m.content}`);
    }
  }
  return lines.join('\n');
}

function charSettings(settings, char) {
  const model = String(char?.chat_model || '').trim() || String(settings.chat_model || 'gpt-4o').trim();
  return { ...settings, chat_model: model };
}

function buildGroupExtra(char, members, userName, { isReaction, reactToName, reactToText, partialNote } = {}) {
  const others = (members || [])
    .filter((m) => Number(m.id) !== Number(char.id))
    .map((m) => m.name)
    .filter(Boolean);
  const talk = normalizeTalk(char.group_talkativeness);
  const talkHint = talk === 'quiet'
    ? '你话不多，没被点到或没必要时可以极短回复。'
    : talk === 'lively'
      ? '你比较爱接话，可以主动插一句，但仍要像真人，别复读。'
      : '有相关或被问到再开口，别每条都回。';

  let extra = `【群聊·微信群】你在群里，成员有：${userName}${others.length ? '、' + others.join('、') : ''}。
你只扮演${char.name}本人，只输出你自己要发的下一条群消息。
禁止替其他人说话，禁止写「角色名：」前缀，禁止*动作*、旁白、心理描写。
像微信群打字：短句、口语、可分条但本轮只输出你这一条气泡正文。
${talkHint}`;

  if (partialNote) {
    extra += `\n【打断】对方还在打字，你只看到了对方消息的一部分。按已看见的内容接话即可，不要假装听完后半句。`;
  }
  if (isReaction) {
    extra += `\n【反应】刚看到群友「${reactToName || '对方'}」说：「${String(reactToText || '').slice(0, 200)}」
用一句短话吐槽、附和、补刀或给建议；不要重复对方原话，不要开新话题长篇。`;
  }
  return extra;
}

function hesitationMs(char, mode) {
  const talk = normalizeTalk(char.group_talkativeness);
  let base;
  if (talk === 'lively') base = 400 + Math.random() * 900;
  else if (talk === 'quiet') base = 2200 + Math.random() * 2800;
  else base = 900 + Math.random() * 1600;
  if (mode === 'parallel') base *= 0.85;
  if (mode === 'half_interrupt' && talk === 'lively') base *= 0.7;
  return Math.round(base);
}

function typingDelayForText(text) {
  const n = String(text || '').length;
  return Math.min(4500, Math.round(600 + n * 45 + Math.random() * 400));
}

function insertGroupMessage(db, {
  groupId, role, speakerId = null, content, type = 'text', deliveryMode = '', replyToId = null,
  mediaMeta = '',
}) {
  let meta = '';
  if (mediaMeta != null && mediaMeta !== '') {
    meta = typeof mediaMeta === 'string' ? mediaMeta : JSON.stringify(mediaMeta);
  }
  const r = db.prepare(`
    INSERT INTO group_messages (group_id, role, speaker_character_id, content, type, reply_to_id, delivery_mode, media_meta, timestamp)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))
  `).run(
    groupId,
    role,
    speakerId,
    String(content || ''),
    type || 'text',
    replyToId,
    deliveryMode || '',
    meta,
  );
  db.prepare(`UPDATE group_chats SET updated_at=datetime('now') WHERE id=?`).run(groupId);
  return db.prepare('SELECT * FROM group_messages WHERE id=?').get(r.lastInsertRowid);
}

function loadGroupHistory(db, groupId, limit = 50) {
  return db.prepare(`
    SELECT * FROM group_messages WHERE group_id=? ORDER BY id DESC LIMIT ?
  `).all(groupId, limit).reverse();
}

function getGroupWithMembers(db, groupId) {
  const group = db.prepare('SELECT * FROM group_chats WHERE id=?').get(groupId);
  if (!group) return null;
  const ids = parseMemberIds(group.member_ids);
  const members = [];
  for (const id of ids) {
    const c = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
    if (c) members.push(c);
  }
  return { group, members, memberIds: ids };
}

async function generateSpeakerReply({
  db, char, members, settings, historyRows, buildSystemPrompt, withCharChatPrefs,
  userName, opts = {},
}) {
  const memberMap = new Map(members.map((m) => [Number(m.id), m]));
  const transcript = formatTranscript(historyRows, memberMap, userName, {
    partialForId: opts.partialForId,
    partialText: opts.partialText,
  });
  const chatSettings = withCharChatPrefs
    ? withCharChatPrefs(charSettings(settings, char), char)
    : charSettings(settings, char);

  const extra = buildGroupExtra(char, members, userName, opts);
  const systemPrompt = buildSystemPrompt(char, chatSettings, extra, {
    userMessage: opts.userText || '',
    recentHistory: [],
  });

  const historyMessages = [];
  if (transcript) {
    historyMessages.push({
      role: 'user',
      content: `以下是群聊最近消息（含名字标记）：\n${transcript}\n\n请以${char.name}的身份发送下一条群消息。`,
    });
  }

  const content = await callChatAPIComplete(
    chatSettings,
    systemPrompt,
    opts.userText
      ? `用户刚说：${opts.userText}\n请只输出你（${char.name}）要发的内容。`
      : `请只输出你（${char.name}）要发的内容。`,
    'chat',
    historyMessages,
  );

  let text = String(content || '').trim();
  text = text.replace(/^\[[^\]]+\]\s*/, '').replace(/^[^:：]{1,12}[:：]\s*/, '');
  if (!text) return null;
  return text;
}

function pushGroupMessage(push, groupId, row, extra = {}) {
  if (!push || !row) return;
  push('group_message', {
    groupId,
    message: row,
    speakerCharacterId: row.speaker_character_id,
    ...extra,
  });
}

function pushGroupTyping(push, groupId, characterId, typing) {
  if (!push) return;
  push('group_typing', { groupId, characterId, typing: !!typing });
}

/**
 * 用户发完后触发一轮群回复。异步推送气泡（带延迟），HTTP 先返回计划。
 */
async function orchestrateGroupReplies({
  db, groupId, userText, push, getSettings, buildSystemPrompt, withCharChatPrefs,
}) {
  const pack = getGroupWithMembers(db, groupId);
  if (!pack || !pack.members.length) return { ok: false, reason: 'no_members' };

  const settings = typeof getSettings === 'function' ? getSettings() : getSettings;
  const userName = settings.username || '旅人';
  const speakers = pickSpeakers(pack.members, userText);
  if (!speakers.length) return { ok: true, speakers: [], mode: null, skipped: true };

  const mode = pickMode(speakers);
  const historyBase = loadGroupHistory(db, groupId, 50);

  // 不阻塞 HTTP：后台跑完再推
  setImmediate(() => {
    runDelivery({
      db,
      groupId,
      pack,
      speakers,
      mode,
      userText,
      historyBase,
      settings,
      userName,
      push,
      buildSystemPrompt,
      withCharChatPrefs,
    }).catch((e) => console.warn('[group-chat]', e.message || e));
  });

  return {
    ok: true,
    mode,
    speakers: speakers.map((c) => ({ id: c.id, name: c.name })),
  };
}

async function runDelivery(ctx) {
  const {
    db, groupId, pack, speakers, mode, userText, historyBase, settings, userName,
    push, buildSystemPrompt, withCharChatPrefs,
  } = ctx;
  const { members } = pack;

  if (mode === 'parallel' && speakers.length >= 2) {
    await runParallel(ctx);
    return;
  }
  if (mode === 'half_interrupt' && speakers.length >= 2) {
    await runHalfInterrupt(ctx);
    return;
  }
  await runWaitComplete(ctx);
}

async function runWaitComplete(ctx) {
  const {
    db, groupId, pack, speakers, mode, userText, historyBase, settings, userName,
    push, buildSystemPrompt, withCharChatPrefs,
  } = ctx;
  let history = [...historyBase];

  for (const char of speakers) {
    const wait = hesitationMs(char, 'wait_complete');
    pushGroupTyping(push, groupId, char.id, true);
    await sleep(wait);

    let text;
    try {
      text = await generateSpeakerReply({
        db, char, members: pack.members, settings, historyRows: history,
        buildSystemPrompt, withCharChatPrefs, userName,
        opts: { userText },
      });
    } catch (e) {
      console.warn('[group-chat] gen', char.name, e.message);
      pushGroupTyping(push, groupId, char.id, false);
      continue;
    }
    pushGroupTyping(push, groupId, char.id, false);
    if (!text) continue;

    await sleep(typingDelayForText(text));
    const row = insertGroupMessage(db, {
      groupId, role: 'assistant', speakerId: char.id, content: text, deliveryMode: mode || 'wait_complete',
    });
    history.push(row);
    pushGroupMessage(push, groupId, row);
  }
}

async function runParallel(ctx) {
  const {
    db, groupId, pack, speakers, userText, historyBase, settings, userName,
    push, buildSystemPrompt, withCharChatPrefs,
  } = ctx;

  const gens = await Promise.all(speakers.map(async (char) => {
    pushGroupTyping(push, groupId, char.id, true);
    try {
      const text = await generateSpeakerReply({
        db, char, members: pack.members, settings, historyRows: historyBase,
        buildSystemPrompt, withCharChatPrefs, userName,
        opts: { userText },
      });
      return { char, text };
    } catch (e) {
      console.warn('[group-chat] parallel', char.name, e.message);
      return { char, text: null };
    }
  }));

  const delivered = [];
  const ordered = [...gens].sort((a, b) => {
    const ta = normalizeTalk(a.char.group_talkativeness);
    const tb = normalizeTalk(b.char.group_talkativeness);
    const rank = (t) => (t === 'lively' ? 0 : t === 'quiet' ? 2 : 1);
    return rank(ta) - rank(tb);
  });

  for (const item of ordered) {
    const { char, text } = item;
    if (!text) {
      pushGroupTyping(push, groupId, char.id, false);
      continue;
    }
    await sleep(hesitationMs(char, 'parallel'));
    pushGroupTyping(push, groupId, char.id, false);
    await sleep(Math.min(1800, typingDelayForText(text) * 0.45));
    const row = insertGroupMessage(db, {
      groupId, role: 'assistant', speakerId: char.id, content: text, deliveryMode: 'parallel',
    });
    delivered.push({ char, row, text });
    pushGroupMessage(push, groupId, row);
  }

  // 反应链：最多 1 条
  if (delivered.length >= 2 && Math.random() < 0.55) {
    const reactor = delivered.find((d) => normalizeTalk(d.char.group_talkativeness) === 'lively')
      || delivered[delivered.length - 1];
    const target = delivered.find((d) => d.char.id !== reactor.char.id) || delivered[0];
    if (reactor && target && reactor.char.id !== target.char.id) {
      await sleep(700 + Math.random() * 1200);
      pushGroupTyping(push, groupId, reactor.char.id, true);
      const history = loadGroupHistory(db, groupId, 50);
      let text;
      try {
        text = await generateSpeakerReply({
          db, char: reactor.char, members: pack.members, settings, historyRows: history,
          buildSystemPrompt, withCharChatPrefs, userName,
          opts: {
            userText,
            isReaction: true,
            reactToName: target.char.name,
            reactToText: target.text,
          },
        });
      } catch (e) {
        console.warn('[group-chat] reaction', e.message);
      }
      pushGroupTyping(push, groupId, reactor.char.id, false);
      if (text) {
        await sleep(400 + Math.random() * 600);
        const row = insertGroupMessage(db, {
          groupId,
          role: 'assistant',
          speakerId: reactor.char.id,
          content: text,
          deliveryMode: 'reaction',
          replyToId: target.row.id,
        });
        pushGroupMessage(push, groupId, row);
      }
    }
  }
}

async function runHalfInterrupt(ctx) {
  const {
    db, groupId, pack, speakers, userText, historyBase, settings, userName,
    push, buildSystemPrompt, withCharChatPrefs,
  } = ctx;

  const [primary, interrupter] = speakers;
  pushGroupTyping(push, groupId, primary.id, true);
  await sleep(hesitationMs(primary, 'half_interrupt'));

  let fullText;
  try {
    fullText = await generateSpeakerReply({
      db, char: primary, members: pack.members, settings, historyRows: historyBase,
      buildSystemPrompt, withCharChatPrefs, userName,
      opts: { userText },
    });
  } catch (e) {
    console.warn('[group-chat] half primary', e.message);
    pushGroupTyping(push, groupId, primary.id, false);
    return runWaitComplete({ ...ctx, speakers: speakers.slice(1), mode: 'wait_complete' });
  }

  if (!fullText) {
    pushGroupTyping(push, groupId, primary.id, false);
    return;
  }

  // 伪半句：先入库完整，前端可一次性看到；编排上 B 只用前缀生成
  const cut = Math.max(4, Math.floor(fullText.length * (0.35 + Math.random() * 0.2)));
  const prefix = fullText.slice(0, cut);
  const rest = fullText.slice(cut);

  const primaryRow = insertGroupMessage(db, {
    groupId, role: 'assistant', speakerId: primary.id, content: fullText, deliveryMode: 'half_interrupt',
  });
  // 先推「前缀观感」：用临时 content 推一次 typing 态不够，直接推完整消息但触发 B 用 prefix
  pushGroupTyping(push, groupId, primary.id, false);
  pushGroupMessage(push, groupId, primaryRow, { halfPrefix: prefix, halfRest: rest });

  if (interrupter) {
    pushGroupTyping(push, groupId, interrupter.id, true);
    await sleep(hesitationMs(interrupter, 'half_interrupt') * 0.6);
    const histForB = [
      ...historyBase,
      { ...primaryRow, content: prefix },
    ];
    let bText;
    try {
      bText = await generateSpeakerReply({
        db, char: interrupter, members: pack.members, settings, historyRows: histForB,
        buildSystemPrompt, withCharChatPrefs, userName,
        opts: {
          userText,
          partialNote: true,
          partialForId: primaryRow.id,
          partialText: prefix,
        },
      });
    } catch (e) {
      console.warn('[group-chat] half interrupt', e.message);
    }
    pushGroupTyping(push, groupId, interrupter.id, false);
    if (bText) {
      await sleep(300 + Math.random() * 500);
      const row = insertGroupMessage(db, {
        groupId, role: 'assistant', speakerId: interrupter.id, content: bText, deliveryMode: 'half_interrupt',
      });
      pushGroupMessage(push, groupId, row);
    }
  }
}

function defaultGroupTitle(members) {
  const names = (members || []).map((m) => m.name).filter(Boolean);
  if (names.length <= 3) return names.join('、') || '群聊';
  return `${names.slice(0, 3).join('、')}…`;
}

module.exports = {
  parseMemberIds,
  normalizeTalk,
  pickSpeakers,
  pickMode,
  getGroupWithMembers,
  loadGroupHistory,
  insertGroupMessage,
  orchestrateGroupReplies,
  defaultGroupTitle,
  pushGroupMessage,
  pushGroupTyping,
};

/** 一次性：把当前角色聊天会注入的系统提示导成文档。读库后立刻退出，避免碰持久化。 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outPath = path.join(root, '角色当前系统上下文.md');

function settingsFromDb(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function splitBlocks(prompt) {
  const parts = String(prompt || '').split(/\n\n+/);
  return parts.filter(Boolean);
}

(async () => {
  process.env.NIAN_DB_SKIP_BACKUP = '1';
  const db = require(path.join(root, 'backend', 'db'));
  await db.initDB();
  const cron = require(path.join(root, 'backend', 'cron'));
  const memoryBrain = require(path.join(root, 'backend', 'memory-brain-helper'));
  const robotTools = require(path.join(root, 'backend', 'robot-llm-tools'));
  let phone = null;
  try { phone = require(path.join(root, 'backend', 'phone-llm-tools')); } catch {}

  const settings = settingsFromDb(db);
  const chars = db.prepare('SELECT * FROM characters ORDER BY id').all();
  if (!chars.length) {
    fs.writeFileSync(outPath, '# 角色当前系统上下文\n\n库里没有角色。\n', 'utf8');
    process.exit(0);
  }

  const lastMsg = db.prepare(
    `SELECT character_id, content, timestamp FROM messages
     WHERE is_dream=0 AND recalled=0 AND role='user'
     ORDER BY id DESC LIMIT 1`
  ).get();
  const focusId = lastMsg?.character_id || chars[0].id;
  const char = chars.find((c) => c.id === focusId) || chars[0];

  const history = memoryBrain.loadChatContextHistory(char.id, false, memoryBrain.getChatContextRounds(char, settings));
  const lastUser = [...history].reverse().find((m) => m.role === 'user' && m.type !== 'system') || lastMsg;
  const userMessage = String(lastUser?.content || '').replace(/^【自动回复】/, '');

  const promptOpts = {
    isDream: false,
    contextText: cron.buildChatContextText(userMessage, history),
    userMessage,
    recentHistory: history,
    enableInlineDirectives: true,
  };

  const extraBits = [];
  try {
    const sleepNote = cron.buildSleepContextNote(history, settings);
    if (sleepNote) extraBits.push(sleepNote);
  } catch {}
  try {
    const intentNote = cron.buildStatedIntentElapsedNote(history, settings);
    if (intentNote) extraBits.push(intentNote);
  } catch {}
  const extra = extraBits.join('\n');

  const systemPrompt = cron.buildSystemPrompt(char, settings, extra, promptOpts);
  const blocks = splitBlocks(systemPrompt);
  const timePayload = cron.buildReplyTimeNotePayload(settings, char.id, false);
  const tools = robotTools.toolsForChat(char, settings, {
    userMessage,
    recentHistory: history,
  }) || [];

  const pending = (() => {
    try { return require(path.join(root, 'backend', 'process-time-helper')).getPending(char.id); }
    catch { return null; }
  })();

  const lines = [];
  lines.push(`# 角色当前系统上下文`);
  lines.push('');
  lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  lines.push(`> 角色：${char.name}（id=${char.id}）`);
  lines.push(`> 场景：普通聊天（不是梦境 / 小剧场 / 通话）`);
  lines.push(`> 用来触发记忆检索、过程时间、工具挂载的「本轮用户话」：${userMessage ? `「${userMessage.slice(0, 80)}${userMessage.length > 80 ? '…' : ''}」` : '（近期没有用户消息）'}`);
  lines.push('');
  lines.push('模型实际收到的是三块：**系统提示（下面全文）**、**近窗聊天记录**、以及命中时才挂上的 **tools（函数 schema，不写进人设正文）**。');
  lines.push('');
  lines.push(`系统提示约 ${systemPrompt.length} 字，拆成 ${blocks.length} 段。近窗 ${history.length} 条消息。本轮会挂上的工具：${tools.length ? tools.map((t) => t.function?.name).join('、') : '无（闲聊默认不塞整本手机/小机工具）'}。`);
  if (pending) {
    lines.push('');
    lines.push(`当前过程时间待办：kind=${pending.kind} label=${pending.label || ''} dest=${pending.dest || ''} silent=${pending.silent ? '是' : '否'} 到期=${pending.dueAt ? new Date(pending.dueAt).toLocaleString('zh-CN', { hour12: false }) : ''}`);
  } else {
    lines.push('');
    lines.push('当前没有进行中的过程时间待办，所以系统提示里**不应再出现常驻【过程时间】规则**。');
  }
  if (timePayload?.timeNote) {
    lines.push('');
    lines.push('另外会贴在某条用户消息上的空窗时间注（不是系统提示正文）：');
    lines.push('');
    lines.push('```');
    lines.push(String(timePayload.timeNote).trim());
    lines.push('```');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 目录（本轮实际注入的块）');
  lines.push('');
  blocks.forEach((b, i) => {
    const title = (b.match(/^【[^】]+】/) || ['（无标题段）'])[0];
    const head = title.replace(/\n[\s\S]*/, '');
    lines.push(`${i + 1}. ${head} · ${b.length} 字`);
  });
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 系统提示全文（角色这一轮真正看到的）');
  lines.push('');
  lines.push('```');
  lines.push(systemPrompt.replace(/```/g, '`ˋ`'));
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 近窗聊天（另作为 messages 发给模型，不是系统提示）');
  lines.push('');
  if (!history.length) {
    lines.push('（空）');
  } else {
    history.forEach((m) => {
      const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? char.name : m.role);
      const t = String(m.content || '').replace(/\s+/g, ' ').slice(0, 120);
      lines.push(`- [${m.timestamp || ''}] ${role}：${t}${String(m.content || '').length > 120 ? '…' : ''}`);
    });
  }
  if (tools.length) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 本轮挂上的 tools');
    lines.push('');
    tools.forEach((t) => {
      const fn = t.function || {};
      lines.push(`### ${fn.name}`);
      lines.push('');
      lines.push(String(fn.description || '').trim());
      lines.push('');
    });
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log('wrote', outPath, 'chars', systemPrompt.length, 'blocks', blocks.length);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 通话中角色可主动调的工具：
 * - peer_end_call：角色主动挂断当前正在 live 的通话，并把时长落到聊天页。
 * 仅在角色确实在通话中（用户拨给角色已接 / 角色拨给用户已接）才允许调用。
 */

const PEER_END_TOOL = {
  type: 'function',
  function: {
    name: 'peer_end_call',
    description:
      '【通话·你挂电话】你现在确实在跟用户通话中，想挂断时调这个（不是问句，不是建议，是真的要把这通电话关掉）。对方说「晚安/去睡/连麦/挂着/陪睡」时不要调——那是要挂着电话，不是要挂断；只有你自己真想结束，或对方明确说挂了/拜拜/挂电话时才调。调一次：聊天页会冒出一条「语音通话结束 · 时长」气泡，用户那头会从通话页直接收掉。挂完若还要补一句，用微信文字，不要发语音条，不要以「喂」开头，不要问「能听见吗」。不要再写系统行。不要提工具名。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '可选。你这会儿为啥要挂，方便后续记忆用；不要写给用户看',
        },
      },
    },
  },
};

const CALL_TOOLS = [PEER_END_TOOL];

function shouldAttach(opts = {}) {
  // 通话中才挂本工具：避免被无关请求触发。
  return !!opts.isVoiceCall;
}

async function execute(call = {}, ctx = {}) {
  const name = String(call.name || '');
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const characterId = Number(ctx.characterId) || 0;
  if (!characterId) {
    return { ok: false, error: 'no_character', note: '没角色 ID，不能挂电话。' };
  }
  if (name === 'peer_end_call') {
    const userText = String(ctx.userMessage || '');
    // 对方说晚安/连麦要挂着时，拒绝工具挂断（与正文 [挂断] 拦截一致）
    if (
      /连麦|挂着(?:电话)?|别挂|不要挂|先别挂|陪我睡|一起睡|挂机陪|晚安|好梦|要睡了|去睡了|我先睡|准备睡/.test(userText)
      && !(/挂了|挂电话|拜拜|先挂|挂掉|结束通话/.test(userText) && !/别挂|不要挂|先别挂/.test(userText))
    ) {
      return {
        ok: false,
        skipped: 'user_wants_keep_line',
        note: '对方说的是晚安/连麦/挂着睡，不是要挂电话。不要挂，继续通着；想结束等对方明确说挂了再调。',
      };
    }
    let db;
    try {
      const dbModule = require('./db');
      db = typeof dbModule.getDB === 'function' ? dbModule.getDB() : dbModule;
    } catch { db = null; }
    if (!db || typeof db.prepare !== 'function') {
      return { ok: false, error: 'no_db', note: '数据库没准备好。' };
    }
    try {
      const helper = require('./proactive-outreach-helper');
      return helper.resolvePeerEndCall(db, {
        characterId,
        reason: args.reason || '',
      });
    } catch (e) {
      return { ok: false, error: e.message || 'peer_end_failed', note: '挂电话失败，不要假装挂了。' };
    }
  }
  return { ok: false, error: 'unknown_tool', note: '没有这个通话工具。' };
}

module.exports = {
  CALL_TOOLS,
  PEER_END_TOOL,
  shouldAttach,
  execute,
};
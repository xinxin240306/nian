/**
 * 用户虚拟身份：关闭时全员用真实名片；开启后按绑定角色切换称呼/性别/描述。
 */
function parsePersonas(raw) {
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    return Array.isArray(list) ? list.filter((p) => p && typeof p === 'object') : [];
  } catch {
    return [];
  }
}

function normalizePersona(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id || '').trim() || `p_${Date.now().toString(36)}`;
  const name = String(p.name || '').trim();
  if (!name) return null;
  const gender = String(p.gender || '').trim();
  const desc = String(p.desc || '').trim();
  const birthday = String(p.birthday || '').trim();
  const appearance = String(p.appearance || '').trim();
  const characterIds = [...new Set(
    (Array.isArray(p.characterIds) ? p.characterIds : [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0)
  )];
  return { id, name, gender, desc, birthday, appearance, characterIds };
}

function listPersonas(settings) {
  return parsePersonas(settings?.user_personas)
    .map(normalizePersona)
    .filter(Boolean);
}

function isPersonaModeOn(settings) {
  return String(settings?.user_persona_enabled || '0') === '1';
}

/** 与某角色聊天时应使用的用户身份（虚拟命中则返回 persona，否则 null 表示真实） */
function resolvePersonaForCharacter(settings, characterId) {
  if (!isPersonaModeOn(settings)) return null;
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  return listPersonas(settings).find((p) => p.characterIds.includes(cid)) || null;
}

/** 组装【用户】提示块用的展示资料 */
function resolveUserProfileForPrompt(settings, characterId) {
  const realName = String(settings?.username || '旅人').trim() || '旅人';
  const realGender = String(settings?.user_gender || '').trim();
  const realDesc = String(settings?.user_desc || '').trim();
  const persona = resolvePersonaForCharacter(settings, characterId);
  if (!persona) {
    return {
      name: realName,
      gender: realGender,
      desc: realDesc,
      birthday: String(settings?.user_birthday || '').trim(),
      appearance: String(settings?.user_appearance || '').trim(),
      isPersona: false,
    };
  }
  return {
    name: persona.name || realName,
    gender: persona.gender || realGender,
    desc: persona.desc || '',
    birthday: String(persona.birthday || settings?.user_birthday || '').trim(),
    appearance: String(persona.appearance || settings?.user_appearance || '').trim(),
    isPersona: true,
  };
}

function buildUserPromptBlock(settings, characterId) {
  const u = resolveUserProfileForPrompt(settings, characterId);
  let block = u.desc ? `【用户】${u.name}：${u.desc}` : `【用户】${u.name}`;
  if (u.gender) block += `\n用户性别：${u.gender}`;
  if (u.birthday) block += `\n用户生日：${String(u.birthday).slice(0, 10)}`;
  if (u.appearance) {
    block += `\n用户外貌：${u.appearance}\n（聊到长相/穿搭/认人/「我长什么样」时自然用上；不要主动盘问外貌，也不要每句都提。）`;
  }
  if (u.isPersona) {
    block += `\n（对方在你这边用的是这套身份，称呼与认知按此来；不要拆穿「虚拟身份」设定本身。）`;
  }
  return block;
}

module.exports = {
  parsePersonas,
  normalizePersona,
  listPersonas,
  isPersonaModeOn,
  resolvePersonaForCharacter,
  resolveUserProfileForPrompt,
  buildUserPromptBlock,
};

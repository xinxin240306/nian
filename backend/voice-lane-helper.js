/**
 * 角色双音色：日常 voice_id / 低哑气声 voice_id_nsfw。
 * 拟声文件不进 MiniMax；这里只决定「这句话用哪条克隆音」。
 * 气声音色不限于 NSFW：亲密对白、欲望偏高、或原文本身露骨时可以用。
 */

const NSFW_SPEAK_RE = /做爱|上床|性爱|口交|手淫|插进来|射了|射出|内射|后入|湿了|硬了|想做|想睡你|要去了|去了啦|高潮|娇喘|色喘|啊嗯|嗯啊|哈啊|再深[一点入]|肉棒|鸡巴|小穴|阴蒂|乳头|射进来|含住/i;

function trimVoiceId(raw) {
  return String(raw || '').trim().slice(0, 200);
}

function parseEmotionState(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function explicitNsfwFlag(value) {
  if (value === false || value === 0 || value === '0') return false;
  if (value === true || value === 1 || value === '1' || value === 'nsfw') return true;
  return null;
}

/** 这句话要不要切到气声音色（没填第二条 ID 时仍返回 true，调用方再回落日常）。 */
function inferNsfwVoiceLane({ text, char, nsfw } = {}) {
  const flag = explicitNsfwFlag(nsfw);
  if (flag === false) return false;
  if (flag === true) return true;
  if (NSFW_SPEAK_RE.test(String(text || ''))) return true;

  const state = parseEmotionState(char?.emotion_state);
  const mood = state?.mood && typeof state.mood === 'object' ? state.mood : state;
  if (!mood) return false;
  const fuel = mood.fuel && typeof mood.fuel === 'object' ? mood.fuel : {};
  const desire = Number(fuel.desire) || 0;
  const intimacy = Number(fuel.intimacy) || 0;
  const primary = String(mood.primary || '').toLowerCase();
  if (desire >= 72) return true;
  if ((primary === 'desire' || primary === 'intimate') && (desire >= 50 || intimacy >= 70)) return true;
  return false;
}

function pickCharacterVoiceId(char, opts = {}) {
  const daily = trimVoiceId(char?.voice_id);
  const nsfwId = trimVoiceId(char?.voice_id_nsfw);
  const nsfw = inferNsfwVoiceLane({ text: opts.text, char, nsfw: opts.nsfw });
  if (nsfw && nsfwId) return { voiceId: nsfwId, lane: 'nsfw' };
  return { voiceId: daily, lane: 'daily' };
}

function hasCharacterVoice(char) {
  return !!(trimVoiceId(char?.voice_id) || trimVoiceId(char?.voice_id_nsfw));
}

module.exports = {
  trimVoiceId,
  inferNsfwVoiceLane,
  pickCharacterVoiceId,
  hasCharacterVoice,
};

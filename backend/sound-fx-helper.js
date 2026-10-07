/**
 * 环境音效：AI 写「音效：提示词」→ ElevenLabs Sound Effects → 语音气泡
 * 申请 Key：https://elevenlabs.io/app/settings/api-keys
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://api.elevenlabs.io';
const MIN_SEC = 0.5;
const MAX_SEC = 22;
const DEFAULT_SEC = 6;

function normalizeElevenBase(raw) {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) return DEFAULT_BASE;
  // 填了官方 /v1 或完整 sound-generation 地址时，去掉以免拼成 /v1/v1/...
  base = base.replace(/\/v1\/sound-generation(?:\?.*)?$/i, '');
  base = base.replace(/\/v1$/i, '');
  return base.replace(/\/+$/, '') || DEFAULT_BASE;
}

function getSfxSettings(settings) {
  const apiKey = String(settings?.elevenlabs_api_key || '').trim();
  const base = normalizeElevenBase(settings?.elevenlabs_api_url);
  return { apiKey, base };
}

function isSoundFxConfigured(settings) {
  return !!getSfxSettings(settings).apiKey;
}

function parseSoundSpec(body, defaults = {}) {
  let text = String(body || '').trim();
  if (!text) return null;
  let duration = defaults.duration || DEFAULT_SEC;
  const durMatch = text.match(/[|｜]\s*(\d+(?:\.\d+)?)\s*(?:s|sec|秒)?\s*$/i);
  if (durMatch) {
    duration = Math.max(MIN_SEC, Math.min(MAX_SEC, Number(durMatch[1])));
    text = text.slice(0, durMatch.index).trim();
  }
  if (!text) return null;
  if (/^(无|none|null|-|静|安静|停|stop)$/i.test(text)) {
    return { stop: true, prompt: '', duration: 0, loop: false, ambience: !!defaults.ambience };
  }
  const loop = defaults.loop === true || /循环|loop/i.test(text);
  return {
    prompt: text.slice(0, 400),
    duration,
    loop,
    ambience: !!defaults.ambience,
  };
}

function extractSoundFx(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const m = raw.match(/(?:^|\n)\s*(?:音效[：:]\s*|SFX:\s*|SOUND:\s*)([^\n]+)/i);
  return m ? parseSoundSpec(m[1], { duration: DEFAULT_SEC }) : null;
}

function extractAmbience(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const m = raw.match(/(?:^|\n)\s*(?:环境[：:]\s*|AMB:\s*|AMBIENCE:\s*)([^\n]+)/i);
  return m ? parseSoundSpec(m[1], { duration: 22, loop: true, ambience: true }) : null;
}

/** 通话中当前环境床：不靠模型每轮重写。挂断后清掉。 */
const callSceneByChar = new Map();
const callTextureByChar = new Map();
const callLeftLoudByChar = new Map();
const ambienceClipCache = new Map();
const STICKY_RE = /slime|mucus|gooey|viscous|sticky|smear|peel|gloop|黏液|粘液|拉丝|黏糊|糊状|水晶泥/i;

function sceneCharKey(characterId) {
  return Number(characterId);
}

function getCallScene(characterId) {
  const s = callSceneByChar.get(sceneCharKey(characterId));
  if (!s) return null;
  if (Date.now() - (s.at || 0) > 6 * 3600 * 1000) {
    callSceneByChar.delete(sceneCharKey(characterId));
    return null;
  }
  return s;
}

function resolveAmbienceVolume(prompt) {
  const t = String(prompt || '').toLowerCase();
  if (/夜市|地摊|大排档|地铁|商场|超市|机场|高铁|车站|健身房|busy|crowd|loud|night market|subway|mall|gym|station|motorbike/.test(t)) {
    return 0.44;
  }
  if (/暴雨|倾盆|大风|狂风|街上|马路|餐厅|食堂|堵车|heavy rain|thunder|strong wind|street|traffic|restaurant/.test(t)) {
    return 0.32;
  }
  if (/咖啡|厨房|公园|海边|沙滩|下雨|浴室|公交|开车|cafe|kitchen|park|ocean|beach|rain|bathroom|bus|car cabin/.test(t)) {
    return 0.20;
  }
  if (/睡觉|陪睡|图书馆|办公室|卧室|客厅|quiet|bedroom|library|office|room tone|living room|soft|fridge/.test(t)) {
    return 0.13;
  }
  return 0.22;
}

function rememberCallScene(characterId, scene) {
  if (characterId == null || !scene?.url) return;
  const prompt = String(scene.prompt || '');
  callSceneByChar.set(sceneCharKey(characterId), {
    prompt,
    url: String(scene.url),
    duration: Number(scene.duration) || 12,
    volume: Number.isFinite(Number(scene.volume)) ? Number(scene.volume) : resolveAmbienceVolume(prompt),
    at: Date.now(),
  });
}

/** 观影：角色侧「一起看」的剧情摘要（由截图私下游识图得到，不把图丢给角色） */
const callWatchSceneByChar = new Map();

function clearCallScene(characterId, { resetMove } = {}) {
  if (characterId == null) return;
  callSceneByChar.delete(sceneCharKey(characterId));
  callTextureByChar.delete(sceneCharKey(characterId));
  callWatchSceneByChar.delete(sceneCharKey(characterId));
  if (resetMove) callLeftLoudByChar.delete(sceneCharKey(characterId));
}

function getCallWatchScene(characterId) {
  const s = callWatchSceneByChar.get(sceneCharKey(characterId));
  if (!s) return null;
  if (Date.now() - (s.at || 0) > 6 * 3600 * 1000) {
    callWatchSceneByChar.delete(sceneCharKey(characterId));
    return null;
  }
  return s;
}

function rememberCallWatchScene(characterId, text) {
  const t = String(text || '').trim();
  if (characterId == null || !t) return;
  callWatchSceneByChar.set(sceneCharKey(characterId), { text: t.slice(0, 320), at: Date.now() });
}

function clearCallWatchScene(characterId) {
  if (characterId == null) return;
  callWatchSceneByChar.delete(sceneCharKey(characterId));
}

function isStickyTexturePrompt(prompt) {
  return STICKY_RE.test(String(prompt || ''));
}

function getCallTexture(characterId) {
  const s = callTextureByChar.get(sceneCharKey(characterId));
  if (!s) return null;
  if (Date.now() - (s.at || 0) > 6 * 3600 * 1000) {
    callTextureByChar.delete(sceneCharKey(characterId));
    return null;
  }
  return s;
}

function rememberCallTexture(characterId, scene) {
  if (characterId == null || !scene?.url) return;
  callTextureByChar.set(sceneCharKey(characterId), {
    prompt: String(scene.prompt || ''),
    url: String(scene.url),
    duration: Number(scene.duration) || 10,
    volume: Number.isFinite(Number(scene.volume)) ? Number(scene.volume) : 0.2,
    at: Date.now(),
  });
}

function promptKey(p) {
  return String(p || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\b(loop|and|the|with|of|a|an|to|in|on)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function promptsSimilar(a, b) {
  const ka = promptKey(a);
  const kb = promptKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.includes(kb) || kb.includes(ka)) return true;
  const wa = ka.split(' ').filter((w) => w.length > 2);
  const wb = kb.split(' ').filter((w) => w.length > 2);
  if (!wa.length || !wb.length) return false;
  const setB = new Set(wb);
  let n = 0;
  for (const w of wa) if (setB.has(w)) n++;
  return n / Math.min(wa.length, wb.length) >= 0.55;
}

const LOUD_AMBIENCE_RULES = [
  { re: /夜市|地摊|烧烤摊|路边摊|大排档/, prompt: 'busy night market crowd, sizzling food stalls, motorbikes passing, loud, loop' },
  { re: /暴雨|倾盆|雷雨/, prompt: 'heavy rain on street and windows, thunder far away, loop' },
  { re: /大风|风口|狂风|风很大/, prompt: 'strong wind outdoors, cloth flapping, distant traffic, loop' },
  { re: /地铁/, prompt: 'subway car rumble, passengers, occasional PA chime, loop' },
  { re: /公交|巴士/, prompt: 'bus interior road noise and passengers, loop' },
  { re: /堵车/, prompt: 'heavy traffic jam, horns and engines, loop' },
  { re: /餐厅|食堂|饭店/, prompt: 'busy restaurant room tone, dishes, chatter, loop' },
  { re: /街上|出门|步行|马路|逛街/, prompt: 'busy city street traffic, footsteps, wind, loop' },
  { re: /健身房|跑步机/, prompt: 'gym ambient, distant machines, loop' },
  { re: /商场|超市/, prompt: 'shopping mall ambience, distant music and crowd, loop' },
  { re: /机场|高铁站|火车站|车站/, prompt: 'transit hall, distant announcements, footsteps, loop' },
];

/** 刻意给对方听的现场/氛围声（不一定吵）：海浪、雨、风、白噪等 */
const SCENIC_AMBIENCE_RULES = [
  { re: /海浪|浪声|海水|海边|沙滩|听海/, prompt: 'ocean waves on a rocky beach, gentle sea wash, distant gulls, loop, no voices' },
  { re: /海风|海边风/, prompt: 'ocean wind on a shore at night, soft waves, loop, no voices' },
  { re: /雨声|下雨|听雨|小雨|中雨/, prompt: 'gentle rain on window and leaves, soft indoor room tone, loop, no voices' },
  { re: /雷雨|打雷/, prompt: 'rain with distant soft thunder, loop, no voices' },
  { re: /风声|听风|晚风/, prompt: 'soft wind through trees at night, leaves rustle, loop, no voices' },
  { re: /白噪|白噪音|白噪声|助眠/, prompt: 'soft looping white noise, gentle broadband hiss, sleep aid, no voices, loop' },
  { re: /虫鸣|蝉鸣|夜虫/, prompt: 'summer night insects, distant crickets, loop, no voices' },
  { re: /篝火|火堆|壁炉/, prompt: 'gentle campfire crackle, soft wood fire, loop, no voices' },
  { re: /流水|溪流|小河/, prompt: 'gentle stream water flowing over rocks, loop, no voices' },
];

const LOUD_AMBIENCE_HINT_RE = /夜市|地摊|烧烤|大排档|暴雨|倾盆|雷雨|大风|狂风|地铁|公交|巴士|堵车|餐厅|食堂|饭店|街上|马路|逛街|健身房|商场|超市|机场|高铁|车站|busy|crowd|loud|night market|subway|mall|gym|station|thunder|heavy rain|traffic|restaurant|motorbike|sizzling/i;
const SCENIC_AMBIENCE_HINT_RE = /海浪|浪声|海水|海边|沙滩|海风|雨声|下雨|听雨|风声|听风|白噪|助眠|虫鸣|蝉鸣|夜虫|篝火|火堆|壁炉|流水|溪流|ocean|wave|beach|sea|rain|wind|white\s*noise|cricket|campfire|stream|shore|gull/i;
/** 角色主动让对方听现场声 */
const SCENIC_OFFER_RE = /听(?:听|一下|下)?.{0,16}(海浪|浪声|海水|海风|雨声|雨|风声|白噪|虫鸣|篝火|流水)|听(?:我|这边|电话).{0,14}(海浪|浪|雨|风|海)|给你听.{0,10}(海浪|浪|雨|风)|把.{0,6}(海浪|浪声|雨声|风声).{0,8}(递|给|放)|(?:靠近|贴).{0,6}听筒.{0,10}(浪|雨|风|海)/;

/** 一次性物件声：铃铛、敲门等——走「音效：」短响，不垫循环 */
const ONESHOT_OFFER_RULES = [
  { re: /铃铛|小铃|摇铃|手铃/, prompt: 'small metal hand bell jingling clearly near the phone mic, bright ring, short, no voices', duration: 3 },
  { re: /风铃/, prompt: 'gentle metal wind chimes ringing softly near mic, short, no voices', duration: 4 },
  { re: /门铃/, prompt: 'doorbell chime ringing once or twice, short, no voices', duration: 2 },
  { re: /钟声|敲钟|座钟/, prompt: 'single clear bell toll nearby, short, no voices', duration: 3 },
  { re: /八音盒|音乐盒/, prompt: 'tiny music box tinkling a short melody near mic, no voices', duration: 6 },
  { re: /钥匙串|钥匙响|晃钥匙/, prompt: 'keys jingling on a keyring close to mic, short, no voices', duration: 2 },
  { re: /碰杯|干杯|玻璃杯碰/, prompt: 'two glasses clinking in a toast, short, no voices', duration: 2 },
  { re: /敲门|叩门|敲了敲/, prompt: 'knocking on a wooden door three times, short, no voices', duration: 2 },
  { re: /杯碰桌|放下杯子/, prompt: 'ceramic cup set on wood table, short clink, no voices', duration: 2 },
  { re: /打火机|点燃/, prompt: 'metal lighter flick and soft flame catch, short, no voices', duration: 2 },
];
const ONESHOT_OFFER_RE = /听(?:听|一下|下)?|给你听|摇(?:一下|给你)|递过来听|贴着听筒|听筒凑近|听这个|摇给你听|响给你听|放给你听/;
const ONESHOT_OBJECT_HINT_RE = /铃铛|小铃|风铃|门铃|钟声|八音盒|音乐盒|钥匙|碰杯|敲门|bell|chime|doorbell|music box|keys jingl|knock|clink|lighter/i;

function isLoudAmbiencePrompt(prompt) {
  return LOUD_AMBIENCE_HINT_RE.test(String(prompt || ''));
}

function isScenicAmbiencePrompt(prompt) {
  return SCENIC_AMBIENCE_HINT_RE.test(String(prompt || ''));
}

/** 通话允许垫的循环环境：吵闹现场，或刻意分享的氛围声 */
function isAllowedCallAmbience(prompt) {
  const p = String(prompt || '');
  return isLoudAmbiencePrompt(p) || isScenicAmbiencePrompt(p);
}

function markLeftLoudPlace(characterId) {
  if (characterId == null) return;
  callLeftLoudByChar.set(sceneCharKey(characterId), Date.now());
}

function hasLeftLoudPlace(characterId) {
  const t = callLeftLoudByChar.get(sceneCharKey(characterId));
  if (!t) return false;
  if (Date.now() - t > 6 * 3600 * 1000) {
    callLeftLoudByChar.delete(sceneCharKey(characterId));
    return false;
  }
  return true;
}

function markEnteredLoudPlace(characterId) {
  if (characterId == null) return;
  callLeftLoudByChar.delete(sceneCharKey(characterId));
}

/** 角色口头离开吵闹现场：去安静处、进门、不吵了 */
const LEAVE_LOUD_RE = /去(?:个|一个|那)?安静|换(?:个|一个)?(?:安静|清静|没人)|找(?:个|一个)?(?:安静|清静|没人|角落)|到安静|不吵了|安静多了|安静下来|太吵了.{0,16}(?:换|走|去|找)|这边太吵|这里太吵|先找个地方|换个地方|走开(?:点|一点)?|进(?:店|屋|门|楼|厕所|电梯)|到家了|到房间|进屋了/;
const ENTER_LOUD_RE = /又?(?:到了?|在)(?:街上|夜市|马路|地铁|食堂|商场|车站)|出来了.{0,8}(?:街|路|外面)|我出来了/;

function speechLeavesLoudPlace(text) {
  return LEAVE_LOUD_RE.test(String(text || ''));
}

function speechEntersLoudPlace(text) {
  return ENTER_LOUD_RE.test(String(text || ''));
}

function speechOffersScenicListen(text) {
  return SCENIC_OFFER_RE.test(String(text || ''));
}

function speechOffersOneshotListen(text) {
  const t = String(text || '');
  if (!ONESHOT_OFFER_RE.test(t)) return false;
  // 海浪等氛围优先走循环环境，不抢成短音效
  if (speechOffersScenicListen(t)) return false;
  return ONESHOT_OFFER_RULES.some((r) => r.re.test(t));
}

function isOneshotObjectPrompt(prompt) {
  return ONESHOT_OBJECT_HINT_RE.test(String(prompt || ''));
}

function inferCallOneshotSpec(text) {
  const t = String(text || '');
  for (const rule of ONESHOT_OFFER_RULES) {
    if (rule.re.test(t)) {
      return {
        prompt: rule.prompt,
        duration: Math.max(MIN_SEC, Math.min(MAX_SEC, Number(rule.duration) || 3)),
        loop: false,
        ambience: false,
      };
    }
  }
  return null;
}

function isLoudCallPlace(characterId) {
  const scene = characterId != null ? getCallScene(characterId) : null;
  return !!(scene && isLoudAmbiencePrompt(scene.prompt));
}

function inferCallAmbienceSpec({ sceneHint = '', homeEnv = '', recentText = '' } = {}) {
  const t = `${sceneHint}\n${homeEnv}\n${recentText}`;
  for (const rule of SCENIC_AMBIENCE_RULES) {
    if (rule.re.test(t)) {
      return { prompt: rule.prompt, duration: 22, loop: true, ambience: true };
    }
  }
  for (const rule of LOUD_AMBIENCE_RULES) {
    if (rule.re.test(t)) {
      return { prompt: rule.prompt, duration: 22, loop: true, ambience: true };
    }
  }
  return null;
}

function hiddenStopAmbienceMsg(characterId) {
  return {
    id: `amb_stop_${characterId}_${Date.now()}`,
    role: 'assistant',
    type: 'voice',
    content: JSON.stringify({
      voice: true,
      sfx: true,
      ambience: true,
      stop: true,
      url: '',
    }),
    timestamp: new Date().toISOString(),
    media_meta: JSON.stringify({ hideChat: true, ambience: true, stop: true }),
  };
}

function hiddenAmbienceClientMsg(characterId, spec, url, duration) {
  return {
    id: `amb_${characterId}_${Date.now()}`,
    role: 'assistant',
    type: 'voice',
    content: encodeSfxVoiceContent({
      url,
      duration,
      transcript: `现场 · ${String(spec.prompt || '').slice(0, 20)}`,
      prompt: spec.prompt,
      ambience: true,
    }),
    timestamp: new Date().toISOString(),
    voice_duration: duration,
    media_meta: JSON.stringify({ hideChat: true, ambience: true }),
  };
}

function hiddenTextureClientMsg(characterId, spec, url, duration) {
  return {
    id: `tex_${characterId}_${Date.now()}`,
    role: 'assistant',
    type: 'voice',
    content: encodeSfxVoiceContent({
      url,
      duration,
      transcript: `贴身 · ${String(spec.prompt || '').slice(0, 20)}`,
      prompt: spec.prompt,
      texture: true,
      volume: 0.2,
    }),
    timestamp: new Date().toISOString(),
    voice_duration: duration,
    media_meta: JSON.stringify({ hideChat: true, texture: true }),
  };
}

function stripSoundFxDirective(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/(?:^|\n)\s*(?:音效[：:]\s*|SFX:\s*|SOUND:\s*|环境[：:]\s*|AMB:\s*|AMBIENCE:\s*)[^\n]+/gi, '\n')
    .replace(/(?:音效[：:]\s*|SFX:\s*|SOUND:\s*|环境[：:]\s*|AMB:\s*|AMBIENCE:\s*)[^\n]+\s*$/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function stripSoundFxFromSegments(segments, fallbackText = '') {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length && fallbackText) {
    const cleaned = stripSoundFxDirective(fallbackText);
    return cleaned ? [{ type: 'text', content: cleaned }] : [];
  }
  return list.map((seg) => {
    if (!seg || seg.type === 'emoji' || seg.type === 'image' || seg.type === 'video'
      || seg.type === 'voice' || seg.type === 'location' || seg.type === 'link' || seg.type === 'web_card') {
      return seg;
    }
    return { ...seg, content: stripSoundFxDirective(seg.content) };
  }).filter((seg) => {
    if (!seg) return false;
    if (seg.type === 'emoji' || seg.type === 'image' || seg.type === 'video'
      || seg.type === 'voice' || seg.type === 'location' || seg.type === 'link' || seg.type === 'web_card') return true;
    return !!String(seg.content || '').trim();
  });
}

function encodeSfxVoiceContent({ url, duration, transcript, prompt, ambience, texture, volume }) {
  const p = String(prompt || '');
  const isTexture = !!texture;
  return JSON.stringify({
    voice: true,
    sfx: true,
    ambience: !!ambience && !isTexture,
    texture: isTexture,
    url: String(url || ''),
    duration: Math.max(1, Math.min(60, Math.round(Number(duration) || 1))),
    transcript: String(transcript || (isTexture ? '贴身' : (ambience ? '现场环境' : '环境音'))).slice(0, 80),
    prompt: p.slice(0, 160),
    volume: Number.isFinite(Number(volume))
      ? Number(volume)
      : (isTexture ? 0.2 : (ambience ? resolveAmbienceVolume(p) : undefined)),
  });
}

function sfxLabel(prompt) {
  const p = String(prompt || '').trim();
  if (!p) return '环境音';
  return `环境音 · ${p.slice(0, 24)}`;
}

async function generateSoundFx(settings, { prompt, duration, loop, promptInfluence } = {}) {
  const { apiKey, base } = getSfxSettings(settings);
  if (!apiKey) throw new Error('请先在设置里填写 ElevenLabs API Key');
  const text = String(prompt || '').trim();
  if (!text) throw new Error('音效描述为空');
  const sec = Math.max(MIN_SEC, Math.min(MAX_SEC, Number(duration) || DEFAULT_SEC));
  const influence = Number.isFinite(Number(promptInfluence))
    ? Math.max(0, Math.min(1, Number(promptInfluence)))
    : 0.45;
  const url = `${base}/v1/sound-generation?output_format=mp3_44100_128`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      duration_seconds: sec,
      prompt_influence: influence,
      loop: !!loop,
      model_id: 'eleven_text_to_sound_v2',
    }),
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    const errText = buf.toString('utf8').slice(0, 240);
    let detail = errText;
    try {
      const j = JSON.parse(errText);
      detail = (typeof j?.detail === 'string' ? j.detail : j?.detail?.message) || j?.message || errText;
    } catch { /* keep text */ }
    throw new Error(detail || `ElevenLabs 音效失败 HTTP ${resp.status}`);
  }
  if (buf.length < 80) throw new Error('ElevenLabs 返回的音频为空');
  return { buffer: buf, duration: Math.max(1, Math.round(sec)) };
}

function buildSoundFxPromptSection(settings) {
  if (!isSoundFxConfigured(settings)) return '';
  return `【环境音效·仅真要发声时】
- 默认不发。只有用户明确想听环境声（海风、浪、水、雨、雷、夜虫、白噪音/助眠等），或你此刻真的要递一段现场声，才在回复**末尾另起一行**写音效指令（用户看不到该行）。
- 单行格式：「音效：英文声音描述|秒数」
  · 描述要具体：声源 + 环境 + 远近。例：ocean wind on a rocky beach at night, waves hitting rocks, distant gulls
  · 秒数可选，0.5～22，默认 6。要循环可在描述里写 loop。
- 正例：「音效：gentle sea wind and small waves on wet sand|8」
- 正例：「音效：close-up water pouring into a ceramic cup, kitchen night」
- 正例：「音效：soft looping white noise, gentle broadband hiss, no voices, sleep aid|12」
- 正例：「音效：small metal hand bell jingling near mic, short, no voices|3」
- 贴身现场（布料、黏液摩擦）也走音效，不要用嘴学：
  · 「音效：close-up soft fabric rustle of clothes sliding on skin, short, no voices|2」
  · 「音效：close-up thick sticky slime smearing and peeling on skin, gooey viscous stretch, no water splash, no voices|10」
  · 黏液是糊、拉丝、粘住再撕开，不是水花、不是下雨、不是倒水。
- 不要写就写「音效：无」。不要把音效行写进正文对白。一次回复最多一条。
- 对方说「到家再发 / 之后再听」时本轮不要写音效行，只答应。
- 这是环境/物体声，不是你说话。`;
}

function buildCallSceneAudioPromptSection(settings, charId) {
  if (!isSoundFxConfigured(settings)) {
    return '【通话现场声】未配置音效 API：听筒里只有干净人声。不要用嘴模仿风声、吵闹或东西掉落。';
  }
  const cur = charId != null ? getCallScene(charId) : null;
  const tex = charId != null ? getCallTexture(charId) : null;
  const bed = cur?.prompt
    ? `听筒里正在垫现场声（「${String(cur.prompt).slice(0, 80)}」）。用户听得到，不要每轮再写「环境：」。
· 若是吵闹现场：还在吵里才大声慢说；说去安静处、进门或不吵了，立刻恢复正常说话，并写「环境：无」。
· 若是海浪/雨声等分享氛围：对方听得到就别反复提「你听」；要停就写「环境：无」。`
    : `默认听筒里不要垫循环环境音。
· 真在很吵的地方（夜市、地铁、马路、食堂、暴雨、商场）才写「环境：」。卧室、客厅、办公室、厨房这些安静处不要无故垫。
· 例外：你主动让对方听现场氛围（海浪、雨声、海风、白噪音、虫鸣等）时，必须另起一行写「环境：英文描述|22」，否则听筒里不会出声。例：环境：ocean waves on a rocky beach, gentle sea wash, loop, no voices|22`;
  const texNote = tex?.prompt
    ? `系统已在听筒里垫着黏液摩擦（「${String(tex.prompt).slice(0, 60)}」），轮到用户说话也不会停。不要每轮再写。`
    : '黏液摩擦写「音效：」后，系统会垫在听筒里循环，轮到用户说话也不停；不要每轮重写。';
  return `【通话现场声】
${bed}
· 换到很吵的地方、或突然特别吵时，末尾另起一行写「环境：英文现场描述|22」。
· 主动分享海浪/雨声等持续氛围时，写「环境：…|22」（不要只嘴上说「你听」）。
· 主动给对方听短物件声（铃铛、风铃、门铃、敲门、碰杯、钥匙串、八音盒等）写「音效：英文短事件|2～4」，不要写成「环境：」。例：音效：small metal hand bell jingling near mic, short, no voices|3
· 其它一次性声（东西掉了、关门、杯碰桌）同样「音效：…|2」。例：ceramic bowl dropping on wood floor, short impact
· ${texNote}
  例：close-up thick sticky slime smearing and peeling on skin, gooey viscous stretch, no water splash, no voices|10
· 黏液要糊、拉丝，不要生成水花。
· 禁止在对白里写「呼呼」「哗啦」「咕啾」代替现场声。`;
}

/**
 * @returns {Promise<{ id, type, content }|null>}
 */
async function saveGeneratedSfxMessage({
  characterId, spec, settings, uploadsPath, isDreamMode, deliveryStatus = 'sent',
}) {
  if (isDreamMode || !spec) return null;
  if (!isSoundFxConfigured(settings)) return null;

  let audio;
  try {
    audio = await generateSoundFx(settings, spec);
  } catch (e) {
    console.warn('[sfx] generate failed', e.message);
    return null;
  }
  if (!audio?.buffer?.length) return null;

  try {
    if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
    const filename = `sfx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp3`;
    fs.writeFileSync(path.join(uploadsPath, filename), audio.buffer);
    const url = `/uploads/${filename}`;
    const transcript = spec.texture
      ? `贴身 · ${String(spec.prompt || '').slice(0, 20)}`
      : (spec.ambience ? `现场 · ${String(spec.prompt || '').slice(0, 20)}` : sfxLabel(spec.prompt));
    const content = encodeSfxVoiceContent({
      url,
      duration: audio.duration,
      transcript,
      prompt: spec.prompt,
      ambience: !!spec.ambience,
      texture: !!spec.texture,
      volume: spec.texture ? 0.2 : undefined,
    });
    const db = require('./db');
    const now = new Date().toISOString();
    const status = deliveryStatus || 'sent';
    let id;
    try {
      id = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read, delivery_status) VALUES (?,?,?,?,?,?,0,?)`
      ).run(characterId, 'assistant', content, 'voice', now, 0, status).lastInsertRowid;
    } catch {
      id = db.prepare(
        `INSERT INTO messages (character_id, role, content, type, timestamp, is_dream, is_read) VALUES (?,?,?,?,?,?,0)`
      ).run(characterId, 'assistant', content, 'voice', now, 0).lastInsertRowid;
      try { db.prepare(`UPDATE messages SET delivery_status=? WHERE id=?`).run(status, id); } catch {}
    }
    if (spec.ambience || spec.texture) {
      try {
        db.prepare(`UPDATE messages SET media_meta=? WHERE id=?`)
          .run(JSON.stringify({ hideChat: true, ambience: !!spec.ambience, texture: !!spec.texture }), id);
      } catch {}
    }
    return {
      id,
      role: 'assistant',
      type: 'voice',
      content,
      timestamp: now,
      voice_duration: audio.duration,
      media_meta: (spec.ambience || spec.texture)
        ? JSON.stringify({ hideChat: true, ambience: !!spec.ambience, texture: !!spec.texture })
        : '',
    };
  } catch (e) {
    console.warn('[sfx] save failed', e.message);
    return null;
  }
}

async function attachSoundFxMessages(opts) {
  const raw = opts?.rawText || '';
  const clean = opts?.cleanText || '';
  const forVoiceCall = !!opts?.forVoiceCall;
  const specs = [];
  const amb = extractAmbience(raw) || extractAmbience(clean);
  const shot = extractSoundFx(raw) || extractSoundFx(clean);
  const current = forVoiceCall ? getCallScene(opts.characterId) : null;

  let ambSpec = amb;
  const out = [];
  const spoken = `${raw}\n${clean}`;
  if (forVoiceCall) {
    const leaving = speechLeavesLoudPlace(spoken) || !!(ambSpec && ambSpec.stop);
    const entering = (!!ambSpec && !ambSpec.stop && isLoudAmbiencePrompt(ambSpec.prompt))
      || speechEntersLoudPlace(spoken);
    const scenicOffer = (!!ambSpec && !ambSpec.stop && isScenicAmbiencePrompt(ambSpec.prompt))
      || speechOffersScenicListen(spoken);
    let stopped = false;
    const stopBed = (leftOnPurpose) => {
      if (stopped) return;
      clearCallScene(opts.characterId);
      if (leftOnPurpose) markLeftLoudPlace(opts.characterId);
      out.push(hiddenStopAmbienceMsg(opts.characterId));
      ambSpec = null;
      stopped = true;
    };

    if (leaving && !entering && !scenicOffer) stopBed(true);
    else if (ambSpec && !ambSpec.stop && !isAllowedCallAmbience(ambSpec.prompt)) {
      // 铃铛等短声误写成「环境：」→ 后面改走一次性音效
      if (!isOneshotObjectPrompt(ambSpec.prompt)) ambSpec = null;
    }

    if (entering) markEnteredLoudPlace(opts.characterId);

    if (ambSpec && current && promptsSimilar(ambSpec.prompt, current.prompt)) {
      ambSpec = null;
    } else if (!ambSpec && current && !stopped && hasLeftLoudPlace(opts.characterId)
      && isLoudAmbiencePrompt(current.prompt)) {
      // 这轮没写「环境：」不代表环境变了，只有角色自己说走开了才撤床（仅吵闹现场）
      stopBed(true);
    }
    // 现场吵不吵只认角色这轮说的话（「又到街上了」「我出来了」）。
    // 行程表里写过夜市不算数：那会让整通电话都按吵闹处合成，正是提示词要避免的。
    const bedStillOn = !!current && !stopped;
    if ((entering || scenicOffer) && !ambSpec && !bedStillOn) {
      ambSpec = inferCallAmbienceSpec({
        sceneHint: spoken,
        homeEnv: '',
        recentText: spoken,
      });
    }
  }

  let shotSpec = shot;
  if (shotSpec?.stop) shotSpec = null;
  // 通话里：铃铛等误写成「环境：」时降成一次性音效
  if (forVoiceCall && ambSpec && !ambSpec.stop && !isAllowedCallAmbience(ambSpec.prompt)
    && isOneshotObjectPrompt(ambSpec.prompt)) {
    if (!shotSpec) {
      shotSpec = {
        prompt: ambSpec.prompt,
        duration: Math.min(6, Math.max(2, Number(ambSpec.duration) || 3)),
        loop: false,
        ambience: false,
      };
    }
    ambSpec = null;
  }
  // 通话里把「海浪」类误写成一次性音效时，升成循环环境床
  if (forVoiceCall && shotSpec && !ambSpec && isScenicAmbiencePrompt(shotSpec.prompt)) {
    ambSpec = {
      prompt: shotSpec.prompt,
      duration: 22,
      loop: true,
      ambience: true,
    };
    shotSpec = null;
  }
  // 嘴上说「给你听铃铛」但没写音效行：自动补一条短音效
  if (forVoiceCall && !shotSpec && speechOffersOneshotListen(spoken)) {
    shotSpec = inferCallOneshotSpec(spoken);
  }
  if (forVoiceCall && shotSpec && isStickyTexturePrompt(shotSpec.prompt)) {
    const curTex = getCallTexture(opts.characterId);
    if (curTex && promptsSimilar(shotSpec.prompt, curTex.prompt)) {
      shotSpec = null;
    } else {
      shotSpec = {
        ...shotSpec,
        loop: true,
        duration: Math.max(8, Number(shotSpec.duration) || 10),
        ambience: false,
        texture: true,
      };
    }
  }

  if (ambSpec) specs.push(ambSpec);
  if (shotSpec) specs.push(shotSpec);
  if (!specs.length) return out;
  for (const spec of specs) {
    if (spec.ambience) {
      const cacheKey = promptKey(spec.prompt);
      const cached = cacheKey ? ambienceClipCache.get(cacheKey) : null;
      if (cached?.url) {
        rememberCallScene(opts.characterId, { prompt: spec.prompt, url: cached.url, duration: cached.duration });
        out.push(hiddenAmbienceClientMsg(opts.characterId, spec, cached.url, cached.duration));
        continue;
      }
    }
    if (spec.texture) {
      const cacheKey = `tex:${promptKey(spec.prompt)}`;
      const cached = cacheKey ? ambienceClipCache.get(cacheKey) : null;
      if (cached?.url) {
        rememberCallTexture(opts.characterId, { prompt: spec.prompt, url: cached.url, duration: cached.duration, volume: 0.2 });
        out.push(hiddenTextureClientMsg(opts.characterId, spec, cached.url, cached.duration));
        continue;
      }
    }
    const msg = await saveGeneratedSfxMessage({ ...opts, spec });
    if (msg) {
      out.push(msg);
      let url = '';
      try { url = JSON.parse(msg.content || '{}').url || ''; } catch {}
      if (url && spec.ambience) {
        rememberCallScene(opts.characterId, { prompt: spec.prompt, url, duration: spec.duration || msg.voice_duration });
        const cacheKey = promptKey(spec.prompt);
        if (cacheKey) ambienceClipCache.set(cacheKey, { url, duration: spec.duration || msg.voice_duration || 12 });
      }
      if (url && spec.texture) {
        rememberCallTexture(opts.characterId, { prompt: spec.prompt, url, duration: spec.duration || msg.voice_duration, volume: 0.2 });
        const cacheKey = `tex:${promptKey(spec.prompt)}`;
        if (cacheKey) ambienceClipCache.set(cacheKey, { url, duration: spec.duration || msg.voice_duration || 10 });
      }
    }
  }
  if (forVoiceCall && (out.some((m) => {
    try { return !!JSON.parse(m.content || '{}').texture; } catch { return false; }
  }) || getCallTexture(opts.characterId))) {
    try {
      const { makeBreathBedMessage } = require('./vocal-clips-helper');
      const bed = makeBreathBedMessage({
        characterId: opts.characterId,
        char: opts.char,
        deliveryStatus: opts.deliveryStatus,
        isDreamMode: opts.isDreamMode,
      });
      if (bed) out.push(bed);
    } catch (e) {
      console.warn('[vocal] breath bed', e.message);
    }
  }
  return out;
}

async function attachSoundFxMessage(opts) {
  const msgs = await attachSoundFxMessages(opts);
  return msgs[msgs.length - 1] || null;
}

const hangoutBedCache = new Map();

function charHangoutBlob(char, activity = '') {
  return [
    activity,
    char?.name, char?.intro, char?.personality, char?.background,
    char?.behavior, char?.description, char?.language_style, char?.occupation,
  ].map((x) => String(x || '')).join('\n');
}

/** 优先按角色当前行程推断环境音，其次才用人设 */
function inferHangoutBusySpec(char, activity = '') {
  const act = String(activity || '').trim();
  const blob = charHangoutBlob(char, act);
  if (/睡觉|入睡|午睡|小憩|打盹|陪睡|就寝|过夜|睡着|补觉/.test(act)) {
    return {
      kind: 'room',
      prompt: 'very soft quiet bedroom room tone, faint fabric rustle, extremely soft, no voices, no music, seamless loop|10',
      volume: 0.06,
    };
  }
  if (/画|插画|素描|美术|水彩|油画|速写|画画|绘画/.test(blob)) {
    return {
      kind: 'pencil',
      prompt: 'close soft pencil scratching on paper, quiet desk, continuous soft texture, no voices, no music, seamless ambient loop|10',
      volume: 0.09,
    };
  }
  if (/写|作家|小说|码字|编剧|文案|记者|编辑|备课|写作业|写报告/.test(blob)) {
    return {
      kind: 'keyboard',
      prompt: 'quiet laptop keyboard typing in a quiet room, soft continuous, no voices, no music, seamless loop|10',
      volume: 0.095,
    };
  }
  if (/程序|开发|代码|软件|工程师|IT|上班|职员|办公|文员|会计|工作|加班|开会/.test(blob)) {
    return {
      kind: 'keyboard',
      prompt: 'soft office keyboard typing, occasional mouse click, quiet room tone, continuous, no voices, no music, seamless loop|10',
      volume: 0.09,
    };
  }
  if (/做饭|厨房|厨师|烘焙|洗碗|切菜|下厨/.test(blob)) {
    return {
      kind: 'kitchen',
      prompt: 'quiet kitchen soft utensil clinks and distant fridge hum, continuous soft, no voices, no music, seamless loop|10',
      volume: 0.085,
    };
  }
  if (/缝纫|针线|编织|手工/.test(blob)) {
    return {
      kind: 'pencil',
      prompt: 'soft fabric rustle and quiet sewing handwork, close mic, continuous, no voices, no music, seamless loop|10',
      volume: 0.08,
    };
  }
  if (/读书|看书|阅读|图书馆/.test(blob)) {
    return {
      kind: 'room',
      prompt: 'very soft quiet reading room tone, occasional page turn, extremely soft, no voices, no music, seamless loop|10',
      volume: 0.07,
    };
  }
  return {
    kind: 'keyboard',
    prompt: 'soft quiet room tone with occasional paper rustle and faint keyboard, continuous soft texture, no voices, no music, seamless loop|10',
    volume: 0.085,
  };
}

/**
 * 连麦忙碌垫音：按角色当前活动生成一段可无缝循环的轻环境声。
 */
async function ensureHangoutBed(settings, char, uploadsPath, activity = '') {
  const act = String(activity || '').trim();
  const spec = inferHangoutBusySpec(char, act);
  const cid = Number(char?.id) || 0;
  const cacheKey = `${cid}:${act.slice(0, 24)}:${promptKey(spec.prompt)}`;
  const hit = hangoutBedCache.get(cacheKey);
  if (hit?.url) return { ...hit, volume: spec.volume, kind: spec.kind, procedural: spec.kind, activity: act };

  if (!isSoundFxConfigured(settings) || !uploadsPath) {
    return { ok: true, procedural: spec.kind, kind: spec.kind, volume: spec.volume, prompt: spec.prompt, activity: act };
  }

  try {
    const parsed = parseSoundSpec(spec.prompt, { duration: 10, loop: true, ambience: true });
    const audio = await generateSoundFx(settings, {
      prompt: parsed.prompt,
      duration: parsed.duration || 10,
      loop: true,
      promptInfluence: 0.35,
    });
    if (!audio?.buffer?.length) {
      return { ok: true, procedural: spec.kind, kind: spec.kind, volume: spec.volume, prompt: spec.prompt, activity: act };
    }
    if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
    const filename = `hangout_bed_${cid}_${Date.now().toString(36)}.mp3`;
    fs.writeFileSync(path.join(uploadsPath, filename), audio.buffer);
    const url = `/uploads/${filename}`;
    const out = {
      ok: true,
      url,
      duration: audio.duration,
      volume: spec.volume,
      kind: spec.kind,
      procedural: spec.kind,
      prompt: parsed.prompt,
      activity: act,
    };
    hangoutBedCache.set(cacheKey, out);
    return out;
  } catch (e) {
    console.warn('[sfx] hangout bed', e.message);
    return { ok: true, procedural: spec.kind, kind: spec.kind, volume: spec.volume, prompt: spec.prompt, activity: act };
  }
}

module.exports = {
  isSoundFxConfigured,
  extractSoundFx,
  extractAmbience,
  stripSoundFxDirective,
  stripSoundFxFromSegments,
  generateSoundFx,
  buildSoundFxPromptSection,
  buildCallSceneAudioPromptSection,
  attachSoundFxMessage,
  attachSoundFxMessages,
  getCallScene,
  getCallTexture,
  rememberCallScene,
  clearCallScene,
  getCallWatchScene,
  rememberCallWatchScene,
  clearCallWatchScene,
  isLoudAmbiencePrompt,
  isLoudCallPlace,
  inferHangoutBusySpec,
  ensureHangoutBed,
};

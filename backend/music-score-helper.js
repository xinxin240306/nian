/**
 * 角色「乐器演奏」：解析 AI 乐谱指令 → MiniMax 真乐器音频（失败则本地合成）→ 语音气泡
 * 格式示例：
 *   乐谱：钢琴|C4/4 E4/4 G4/4 C5/2|100
 *   [乐谱]乐器:吉他\n速度:90\n音符:C4/8 D4/8 E4/4[/乐谱]
 */
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 22050;
const MAX_DURATION_SEC = 28;
const MAX_NOTES = 64;

const INSTRUMENT_ALIASES = {
  钢琴: 'piano', piano: 'piano', 钢琴曲: 'piano',
  吉他: 'guitar', guitar: 'guitar', 木吉他: 'guitar', 电吉他: 'guitar',
  小提琴: 'violin', violin: 'violin',
  长笛: 'flute', flute: 'flute',
  竖琴: 'harp', harp: 'harp',
  古筝: 'guzheng', guzheng: 'guzheng',
  尤克里里: 'ukulele', ukulele: 'ukulele', uke: 'ukulele',
  萨克斯: 'sax', sax: 'sax', saxophone: 'sax',
  大提琴: 'cello', cello: 'cello',
};

const INSTRUMENT_LABELS = {
  piano: '钢琴', guitar: '吉他', violin: '小提琴', flute: '长笛',
  harp: '竖琴', guzheng: '古筝', ukulele: '尤克里里', sax: '萨克斯', cello: '大提琴',
};

const NOTE_CN = { 哆: 'C', 来: 'D', 咪: 'E', 发: 'F', 嗦: 'G', 索: 'G', 拉: 'A', 西: 'B', 蒂: 'B' };

function normalizeInstrument(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!key) return 'piano';
  for (const [k, v] of Object.entries(INSTRUMENT_ALIASES)) {
    if (key === k.toLowerCase() || key.includes(k.toLowerCase())) return v;
  }
  return 'piano';
}

function noteToFreq(name) {
  const m = String(name || '').trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = parseInt(m[3], 10);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
  if (base == null || !Number.isFinite(octave)) return null;
  const midi = (octave + 1) * 12 + base + acc;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function parseDurationToken(tok, defaultDur = 4) {
  const m = String(tok || '').match(/\/(\d+)/);
  if (!m) return defaultDur;
  const d = parseInt(m[1], 10);
  return [1, 2, 4, 8, 16, 32].includes(d) ? d : defaultDur;
}

function parseNoteToken(tok, defaultDur = 4) {
  const t = String(tok || '').trim();
  if (!t || t === '|' || t === '｜') return null;
  if (/^(R|r|-|休止|rest)$/i.test(t.split('/')[0])) {
    return { freq: 0, dur: parseDurationToken(t, defaultDur), rest: true };
  }
  // 中文简谱：哆4 / 来#5
  const cn = t.match(/^([哆来咪发嗦索拉西蒂])([#b]?)(\d)?(?:\/(\d+))?$/);
  if (cn) {
    const letter = NOTE_CN[cn[1]];
    const acc = cn[2] || '';
    const oct = cn[3] || '4';
    const dur = cn[4] ? parseInt(cn[4], 10) : defaultDur;
    const freq = noteToFreq(`${letter}${acc}${oct}`);
    if (!freq) return null;
    return { freq, dur: [1, 2, 4, 8, 16].includes(dur) ? dur : defaultDur, rest: false };
  }
  const m = t.match(/^([A-Ga-g][#b]?-?\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  const freq = noteToFreq(m[1]);
  if (!freq) return null;
  const dur = m[2] ? parseInt(m[2], 10) : defaultDur;
  return { freq, dur: [1, 2, 4, 8, 16, 32].includes(dur) ? dur : defaultDur, rest: false };
}

function parseNotesList(raw, defaultDur = 4) {
  const text = String(raw || '')
    .replace(/[|｜]/g, ' ')
    .replace(/[,，、;；]+/g, ' ')
    .trim();
  if (!text) return [];
  const tokens = text.split(/\s+/).filter(Boolean);
  const notes = [];
  for (const tok of tokens) {
    const n = parseNoteToken(tok, defaultDur);
    if (n) notes.push(n);
    if (notes.length >= MAX_NOTES) break;
  }
  return notes;
}

/** 从自由描述生成一段短旋律（保证总能出声） */
function melodyFromDescription(desc, instrument) {
  const scales = {
    piano: ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'E5', 'G4', 'E4', 'C4'],
    guitar: ['E3', 'G3', 'A3', 'B3', 'D4', 'E4', 'G4', 'E4', 'B3', 'G3'],
    violin: ['G3', 'A3', 'C4', 'D4', 'E4', 'G4', 'A4', 'G4', 'E4', 'D4'],
    flute: ['C5', 'D5', 'E5', 'G5', 'A5', 'G5', 'E5', 'D5', 'C5', 'A4'],
    harp: ['C4', 'E4', 'G4', 'B4', 'C5', 'B4', 'G4', 'E4', 'C4', 'G3'],
    guzheng: ['D4', 'E4', 'G4', 'A4', 'C5', 'A4', 'G4', 'E4', 'D4', 'A3'],
    ukulele: ['C4', 'E4', 'G4', 'A4', 'C5', 'A4', 'G4', 'E4'],
    sax: ['C4', 'D4', 'F4', 'G4', 'A4', 'G4', 'F4', 'D4', 'C4'],
    cello: ['C3', 'D3', 'E3', 'G3', 'A3', 'G3', 'E3', 'D3', 'C3'],
  };
  const scale = scales[instrument] || scales.piano;
  let h = 0;
  const s = String(desc || instrument);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const len = 8 + (h % 5);
  const notes = [];
  for (let i = 0; i < len; i++) {
    const idx = (h + i * 3) % scale.length;
    const dur = i === len - 1 ? 2 : (i % 3 === 2 ? 2 : 4);
    const freq = noteToFreq(scale[idx]);
    if (freq) notes.push({ freq, dur, rest: false });
  }
  return notes;
}

function extractBlockScore(text) {
  const m = String(text || '').match(/\[\s*乐谱\s*\]([\s\S]*?)\[\s*\/\s*乐谱\s*\]/i)
    || String(text || '').match(/\[\s*SCORE\s*\]([\s\S]*?)\[\s*\/\s*SCORE\s*\]/i);
  if (!m) return null;
  const body = m[1] || '';
  const inst = (body.match(/(?:乐器|instrument)\s*[:：]\s*([^\n]+)/i) || [])[1];
  const tempoRaw = (body.match(/(?:速度|tempo|bpm)\s*[:：]\s*(\d{2,3})/i) || [])[1];
  const notesRaw = (body.match(/(?:音符|notes|melody)\s*[:：]\s*([^\n]+)/i) || [])[1]
    || body.replace(/(?:乐器|instrument|速度|tempo|bpm)\s*[:：][^\n]+/gi, '').trim();
  return {
    instrument: normalizeInstrument(inst),
    tempo: Math.max(40, Math.min(200, parseInt(tempoRaw, 10) || 100)),
    notesRaw: String(notesRaw || '').trim(),
    title: '',
  };
}

function extractLineScore(text) {
  const m = String(text || '').match(/(?:^|\n)\s*(?:乐谱[：:]\s*|SCORE:\s*)([^\n]+)/i);
  if (!m) return null;
  const payload = m[1].trim();
  if (!payload || /^(无|none|null|-)$/i.test(payload)) return null;
  const parts = payload.split(/[|｜]/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  // 乐谱：钢琴|C4/4 E4/4|100
  // 乐谱：钢琴|温柔小夜曲
  let instrument = 'piano';
  let notesRaw = '';
  let tempo = 100;
  let title = '';
  if (parts.length === 1) {
    if (/[A-Ga-g]\d|哆|来|咪|发|嗦|拉|西/.test(parts[0])) {
      notesRaw = parts[0];
    } else if (INSTRUMENT_ALIASES[parts[0]] || INSTRUMENT_ALIASES[parts[0].toLowerCase()]) {
      instrument = normalizeInstrument(parts[0]);
      title = parts[0];
    } else {
      title = parts[0];
      instrument = normalizeInstrument(parts[0]);
    }
  } else {
    instrument = normalizeInstrument(parts[0]);
    notesRaw = parts[1] || '';
    if (parts[2] && /^\d{2,3}$/.test(parts[2])) tempo = parseInt(parts[2], 10);
    else if (parts[2]) title = parts[2];
    if (!/[A-Ga-g]\d|哆|来|咪|发|嗦|拉|西|\//.test(notesRaw)) {
      title = notesRaw || title;
      notesRaw = '';
    }
  }
  return {
    instrument,
    tempo: Math.max(40, Math.min(200, tempo || 100)),
    notesRaw,
    title: String(title || '').slice(0, 40),
  };
}

function extractMusicScore(text) {
  return extractBlockScore(text) || extractLineScore(text);
}

function stripMusicScoreDirective(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\[\s*乐谱\s*\][\s\S]*?\[\s*\/\s*乐谱\s*\]/gi, '')
    .replace(/\[\s*SCORE\s*\][\s\S]*?\[\s*\/\s*SCORE\s*\]/gi, '')
    .replace(/(?:^|\n)\s*(?:乐谱[：:]\s*|SCORE:\s*)[^\n]+/gi, '\n')
    .replace(/(?:乐谱[：:]\s*|SCORE:\s*)[^\n]+\s*$/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function stripMusicScoreFromSegments(segments, fallbackText = '') {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length && fallbackText) {
    const cleaned = stripMusicScoreDirective(fallbackText);
    return cleaned ? [{ type: 'text', content: cleaned }] : [];
  }
  return list.map((seg) => {
    if (!seg || seg.type === 'emoji' || seg.type === 'image' || seg.type === 'video'
      || seg.type === 'voice' || seg.type === 'location' || seg.type === 'link' || seg.type === 'web_card') {
      return seg;
    }
    return { ...seg, content: stripMusicScoreDirective(seg.content) };
  }).filter((seg) => {
    if (!seg) return false;
    if (seg.type === 'emoji' || seg.type === 'image' || seg.type === 'video'
      || seg.type === 'voice' || seg.type === 'location' || seg.type === 'link' || seg.type === 'web_card') return true;
    return !!String(seg.content || '').trim();
  });
}

function instrumentEnvelope(instrument, t, noteDur) {
  const d = Math.max(0.05, noteDur);
  if (instrument === 'piano' || instrument === 'guzheng' || instrument === 'harp' || instrument === 'ukulele') {
    const attack = 0.008;
    const decay = Math.min(0.35, d * 0.45);
    if (t < attack) return t / attack;
    const x = (t - attack) / Math.max(0.01, d - attack);
    return Math.exp(-x * (instrument === 'piano' ? 2.8 : 2.2)) * (1 - Math.min(1, x * 0.15));
  }
  if (instrument === 'guitar') {
    const attack = 0.012;
    if (t < attack) return t / attack;
    return Math.exp(-(t - attack) * 3.2);
  }
  // sustained: violin / flute / sax / cello
  const attack = instrument === 'flute' ? 0.04 : 0.06;
  const release = Math.min(0.18, d * 0.25);
  if (t < attack) return t / attack;
  if (t > d - release) return Math.max(0, (d - t) / release) * 0.85;
  return 0.85;
}

function instrumentWave(instrument, freq, t) {
  const w = 2 * Math.PI * freq * t;
  if (instrument === 'piano') {
    return 0.55 * Math.sin(w)
      + 0.28 * Math.sin(2 * w) * Math.exp(-t * 2.5)
      + 0.12 * Math.sin(3 * w) * Math.exp(-t * 4)
      + 0.06 * Math.sin(4 * w) * Math.exp(-t * 6);
  }
  if (instrument === 'guitar' || instrument === 'ukulele') {
    return 0.5 * Math.sin(w)
      + 0.3 * Math.sin(2 * w)
      + 0.12 * Math.sin(3 * w)
      + 0.08 * Math.sin(4 * w);
  }
  if (instrument === 'violin' || instrument === 'cello' || instrument === 'sax') {
    // soft saw-ish
    let s = 0;
    for (let h = 1; h <= 6; h++) s += Math.sin(h * w) / h;
    return s * 0.45;
  }
  if (instrument === 'flute') {
    return 0.7 * Math.sin(w) + 0.18 * Math.sin(2 * w) + 0.05 * Math.sin(3 * w);
  }
  if (instrument === 'harp' || instrument === 'guzheng') {
    return 0.48 * Math.sin(w)
      + 0.28 * Math.sin(2 * w) * Math.exp(-t * 1.8)
      + 0.14 * Math.sin(3 * w) * Math.exp(-t * 3)
      + 0.08 * Math.sin(5 * w) * Math.exp(-t * 5);
  }
  return Math.sin(w);
}

function synthesizeScoreWav(score) {
  const instrument = normalizeInstrument(score?.instrument);
  const tempo = Math.max(40, Math.min(200, Number(score?.tempo) || 100));
  let notes = parseNotesList(score?.notesRaw, 4);
  if (!notes.length) notes = melodyFromDescription(score?.title || score?.notesRaw || instrument, instrument);
  if (!notes.length) notes = melodyFromDescription(instrument, instrument);

  const beatSec = 60 / tempo;
  let totalSec = 0.08;
  for (const n of notes) totalSec += (4 / n.dur) * beatSec;
  totalSec = Math.min(MAX_DURATION_SEC, totalSec + 0.25);
  const nSamples = Math.floor(totalSec * SAMPLE_RATE);
  const samples = new Float32Array(nSamples);

  let cursor = Math.floor(0.04 * SAMPLE_RATE);
  for (const note of notes) {
    const noteDur = Math.min(4, (4 / note.dur) * beatSec);
    const noteSamples = Math.floor(noteDur * SAMPLE_RATE);
    if (!note.rest && note.freq > 0) {
      for (let i = 0; i < noteSamples; i++) {
        const t = i / SAMPLE_RATE;
        const idx = cursor + i;
        if (idx >= nSamples) break;
        const env = instrumentEnvelope(instrument, t, noteDur);
        samples[idx] += instrumentWave(instrument, note.freq, t) * env * 0.38;
      }
    }
    cursor += noteSamples;
    if (cursor >= nSamples) break;
  }

  // soft clip + fade out
  const fade = Math.floor(0.08 * SAMPLE_RATE);
  for (let i = 0; i < nSamples; i++) {
    let s = samples[i];
    s = Math.tanh(s * 1.4);
    if (i > nSamples - fade) s *= (nSamples - i) / fade;
    samples[i] = s;
  }

  const dataSize = nSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < nSamples; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((v * 32767) | 0, 44 + i * 2);
  }
  return {
    buffer: buf,
    duration: Math.max(1, Math.min(60, Math.round(totalSec))),
    instrument,
    label: INSTRUMENT_LABELS[instrument] || '乐器',
  };
}

function encodeScoreVoiceContent({ url, duration, transcript, instrument }) {
  return JSON.stringify({
    voice: true,
    score: true,
    url: String(url || ''),
    duration: Math.max(1, Math.min(180, Math.round(Number(duration) || 1))),
    transcript: String(transcript || '♪ 演奏').slice(0, 80),
    instrument: String(instrument || 'piano'),
  });
}

const INSTRUMENT_SOLO = {
  piano: 'A quiet unaccompanied piano solo. One person sits alone at a single acoustic grand piano in a small room and plays. Close-mic, dry intimate room. Realistic piano timbre only.',
  guitar: 'A quiet unaccompanied acoustic guitar solo. One person sits alone and fingerpicks a single steel-string guitar. Close-mic, no second guitar.',
  violin: 'A quiet unaccompanied violin solo. One person stands alone and bows a single violin. Intimate room, no piano accompaniment, no string section.',
  flute: 'A quiet unaccompanied concert flute solo. One person plays a single flute. Intimate studio, breathy and close, no harp or orchestra.',
  harp: 'A quiet unaccompanied concert harp solo. One person sits alone at a single harp and plays arpeggios. No orchestra, no choir pads.',
  guzheng: 'A quiet unaccompanied Chinese guzheng solo. One person sits alone and plucks a single guzheng. Traditional, no ensemble, no percussion.',
  ukulele: 'A quiet unaccompanied ukulele solo. One person sits alone and fingerpicks a single ukulele. Warm and close, no second uke, no claps.',
  sax: 'A quiet unaccompanied tenor saxophone solo. One person plays a single saxophone. Intimate and smoky, no jazz combo, no piano, no drums.',
  cello: 'A quiet unaccompanied cello solo. One person sits alone and bows a single cello. Warm close-mic, no piano, no string quartet.',
};

const SOLO_LOCK = [
  'This is NOT a song, NOT a band, NOT an ensemble, NOT a cinematic score, NOT a pop production.',
  'Instrumentation: only this one instrument. Absolutely nothing else is playing.',
  'Forbidden: drums, drum machine, 808, hi-hat, snare, percussion, claps, bass, bassline, orchestra, string section, synth pad, choir, vocals, singer, rap, second instrument, backing track, full mix.',
].join(' ');

const SFX_INSTRUMENT = {
  piano: 'close-up unaccompanied acoustic grand piano being played in a quiet small room, single piano only, realistic keys, no drums, no other instruments, no vocals',
  guitar: 'close-up unaccompanied acoustic guitar fingerpicking, one guitar only, quiet room, no drums, no bass, no vocals',
  violin: 'close-up unaccompanied solo violin being played, one violin only, intimate room, no piano, no orchestra, no vocals',
  flute: 'close-up unaccompanied concert flute being played, one flute only, breathy, no harp, no orchestra, no vocals',
  harp: 'close-up unaccompanied concert harp being played, one harp only, no orchestra, no vocals',
  guzheng: 'close-up unaccompanied Chinese guzheng being plucked, one zither only, no ensemble, no percussion, no vocals',
  ukulele: 'close-up unaccompanied ukulele fingerpicking, one ukulele only, no claps, no second instrument, no vocals',
  sax: 'close-up unaccompanied tenor saxophone solo, one saxophone only, no jazz band, no drums, no piano, no vocals',
  cello: 'close-up unaccompanied cello being played, one cello only, no piano, no quartet, no vocals',
};

function buildSfxInstrumentPrompt(score) {
  const inst = normalizeInstrument(score?.instrument);
  const base = SFX_INSTRUMENT[inst] || SFX_INSTRUMENT.piano;
  const title = String(score?.title || '').trim();
  const mood = title ? `, mood: ${title.slice(0, 40)}` : '';
  return `${base}${mood}`.slice(0, 400);
}

function buildInstrumentalPrompt(score) {
  const inst = normalizeInstrument(score?.instrument);
  const label = INSTRUMENT_LABELS[inst] || '钢琴';
  const scene = INSTRUMENT_SOLO[inst] || INSTRUMENT_SOLO.piano;
  const title = String(score?.title || '').trim();
  const notes = String(score?.notesRaw || '').trim();
  const tempo = Math.max(40, Math.min(200, Number(score?.tempo) || 100));
  const bits = [
    scene,
    `Genre: unaccompanied ${label} solo. A short 20 to 30 second performance as if the character is playing this instrument right next to you.`,
    SOLO_LOCK,
    `Tempo around ${tempo} BPM, still only the one instrument.`,
  ];
  if (title) bits.push(`Mood of this solo: ${title}. Do not add extra instruments to match the mood.`);
  if (notes && /[A-Ga-g]\d|哆|来|咪|发|嗦|拉|西/.test(notes)) {
    bits.push(`Play this short melody on that single instrument: ${notes.slice(0, 180)}.`);
  }
  return bits.join(' ').slice(0, 2000);
}

function loadScoreSettings(passed) {
  if (passed && typeof passed === 'object') return passed;
  try {
    const db = require('./db');
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function buildMusicScorePromptSection(char) {
  if (Number(char?.music_score_enabled) !== 1) return '';
  return `【乐器演奏·仅真弹时】
- 默认不演奏。只有用户明确要听你弹/你主动要弹一段时，才在回复**末尾另起一行**写乐谱指令（用户看不到该行）。
- 系统会用环境音接口生成一段该乐器的真实演奏片段（随机旋律，不是电子蜂鸣，也不是乐队合奏）。写乐器名和情绪即可。
- 单行格式：「乐谱：乐器|曲风」
  · 乐器：钢琴 / 吉他 / 小提琴 / 长笛 / 竖琴 / 古筝 / 尤克里里 / 萨克斯 / 大提琴
  · 曲风：中文描述即可，如「一段温柔的民谣尾奏」「雨夜钢琴小品」
- 正例：「乐谱：钢琴|雨夜温柔小品」
- 正例：「乐谱：吉他|一段温柔的民谣尾奏」
- 不要写就写「乐谱：无」。不要把乐谱行写进正文对白。一次回复最多一条乐谱。`;
}

/**
 * 从 AI 原文提取乐谱，优先 ElevenLabs 音效出真乐器，失败则本地合成，写入 uploads，插入 voice 消息
 * @returns {Promise<{ id, type, content }|null>}
 */
async function attachMusicScoreMessage({
  characterId, rawText, cleanText, char, uploadsPath, isDreamMode, deliveryStatus = 'sent', settings,
}) {
  if (isDreamMode) return null;
  if (Number(char?.music_score_enabled) !== 1) return null;
  const score = extractMusicScore(rawText) || extractMusicScore(cleanText);
  if (!score) return null;

  let audio = null;
  let ext = 'wav';
  const instrument = normalizeInstrument(score.instrument);
  const label = INSTRUMENT_LABELS[instrument] || '乐器';

  const s = loadScoreSettings(settings);
  try {
    const { isSoundFxConfigured, generateSoundFx } = require('./sound-fx-helper');
    if (isSoundFxConfigured(s)) {
      const sfx = await generateSoundFx(s, {
        prompt: buildSfxInstrumentPrompt(score),
        duration: 14,
        loop: false,
        promptInfluence: 0.7,
      });
      if (sfx?.buffer?.length) {
        audio = { buffer: sfx.buffer, duration: sfx.duration, instrument, label };
        ext = 'mp3';
        console.log('[music-score] ElevenLabs 乐器 bytes=%d dur=%s', sfx.buffer.length, sfx.duration);
      }
    }
  } catch (e) {
    console.warn('[music-score] ElevenLabs 乐器失败', e.message);
  }

  if (!audio?.buffer?.length) {
    try {
      audio = synthesizeScoreWav(score);
      ext = 'wav';
    } catch (e) {
      console.warn('[music-score] synthesize failed', e.message);
      return null;
    }
  }
  if (!audio?.buffer?.length) return null;

  try {
    if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
    const filename = `score_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
    fs.writeFileSync(path.join(uploadsPath, filename), audio.buffer);
    const url = `/uploads/${filename}`;
    const titleBit = score.title ? ` · ${String(score.title).slice(0, 20)}` : '';
    const transcript = `♪ ${audio.label}${titleBit}`;
    const content = encodeScoreVoiceContent({
      url,
      duration: audio.duration,
      transcript,
      instrument: audio.instrument,
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
    return {
      id,
      role: 'assistant',
      type: 'voice',
      content,
      timestamp: now,
      voice_duration: audio.duration,
    };
  } catch (e) {
    console.warn('[music-score] save failed', e.message);
    return null;
  }
}

module.exports = {
  extractMusicScore,
  stripMusicScoreDirective,
  stripMusicScoreFromSegments,
  synthesizeScoreWav,
  encodeScoreVoiceContent,
  buildMusicScorePromptSection,
  buildInstrumentalPrompt,
  buildSfxInstrumentPrompt,
  attachMusicScoreMessage,
  normalizeInstrument,
};

/* ===== toy：stackchan / bbtoy 配置面板 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { getApiBase, isNativeShell } from '../server-config.js';
import { glanceUserEmotion, emotionLabelZh } from '../robot-emotion-sense.js';
import { toyStatus, toyScan, toyConnect, toyDisconnect, toyApply } from '../app-permissions.js';

let _glanceBusy = false;
let _lastSensedUserEmotion = '';
let _lastFaceIdentity = '';
let _robotCmdPoll = null;
let _ledAnim = null;
let _deviceOnline = false;
let _toyPageTab = 'stackchan'; // stackchan | bbtoy

function applyLedPreview(led) {
  const stage = document.getElementById('robot-device-status');
  if (!stage) return;
  if (_ledAnim) {
    clearInterval(_ledAnim);
    _ledAnim = null;
  }
  if (!led || led.off) {
    stage.style.boxShadow = '';
    stage.style.borderColor = '';
    return;
  }
  const br = Number(led.brightness ?? 1);
  const r = Math.round((led.r || 0) * br);
  const g = Math.round((led.g || 0) * br);
  const b = Math.round((led.b || 0) * br);
  const hz = Number(led.frequencyHz) || 0;
  if (hz <= 0) {
    stage.style.boxShadow = `0 0 28px rgba(${r},${g},${b},0.9), inset 0 0 12px rgba(${r},${g},${b},0.25)`;
    stage.style.borderColor = `rgb(${r},${g},${b})`;
    return;
  }
  let on = true;
  const ms = Math.max(50, Math.round(500 / hz));
  _ledAnim = setInterval(() => {
    on = !on;
    if (on) {
      stage.style.boxShadow = `0 0 32px rgba(${r},${g},${b},0.95)`;
      stage.style.borderColor = `rgb(${r},${g},${b})`;
    } else {
      stage.style.boxShadow = `0 0 4px rgba(${r},${g},${b},0.15)`;
      stage.style.borderColor = `rgba(${r},${g},${b},0.35)`;
    }
  }, ms);
}

function applyServoPreview(servoOrMotion) {
  const raw = String(servoOrMotion?.raw || servoOrMotion?.motionRaw || '').trim();
  const motion = servoOrMotion?.motion || servoOrMotion?.action;
  if (motion && motion !== 'custom' && motion !== 'idle') {
    if (raw) setRobotSenseStatus(`舵机：${raw}`);
    else setRobotSenseStatus(`动作：${motion}`);
    return;
  }
  if (raw) setRobotSenseStatus(`舵机：${raw}`);
}

window.applyRobotFacePreview = function(data) {
  if (!data?.emotion) return;
  const bits = [data.emotion, data.motion && data.motion !== 'idle' ? data.motion : ''].filter(Boolean);
  if (bits.length) setRobotHwTestOut(`机身反应：${bits.join(' · ')}`);
};

function robotBaseUrl() {
  try {
    const base = getApiBase?.() || '';
    if (base) return base.replace(/\/$/, '');
  } catch {}
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin.replace(/\/$/, '');
  }
  return 'http://127.0.0.1:3000';
}

/** localhost / 局域网地址：小机在别的网上连不上 */
function isLoopbackOrPrivateOrigin(origin) {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host === '::1') return true;
    if (/^127\./.test(host) || host === '0.0.0.0') return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (host.endsWith('.local')) return true;
    return false;
  } catch {
    return true;
  }
}

function normalizePublicBase(raw) {
  let s = String(raw || '').trim().replace(/\/$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/$/, '');
}

function toWsOrigin(httpOrigin) {
  const s = String(httpOrigin || '').trim();
  if (s.startsWith('https://')) return `wss://${s.slice('https://'.length)}`;
  if (s.startsWith('http://')) return `ws://${s.slice('http://'.length)}`;
  return s;
}

/** 小机应连的公网根地址（不要填 localhost） */
function robotPublicOrigin(settings) {
  const saved = normalizePublicBase(settings?.robot_public_base_url);
  if (saved && !isLoopbackOrPrivateOrigin(saved)) return saved;
  const cur = robotBaseUrl();
  if (cur && !isLoopbackOrPrivateOrigin(cur)) return cur;
  return '';
}

function robotMediaUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:/i.test(u) || u.startsWith('data:')) return u;
  const base = robotBaseUrl();
  return u.startsWith('/') ? `${base}${u}` : `${base}/${u}`;
}

window.testRobotSnapshot = async function(ev) {
  const file = ev.target?.files?.[0];
  ev.target.value = '';
  const out = document.getElementById('robot-snapshot-out');
  if (!file) return;
  if (out) out.textContent = '上传并生成心得…';
  try {
    await window.saveRobotSettings?.();
    const charId = document.getElementById('robot-character-id')?.value || '';
    const context = String(document.getElementById('robot-snapshot-context')?.value || '').trim();
    const data = await api.robotSnapshot({ file, characterId: charId, context, facePresent: true });
    if (out) {
      out.textContent = [
        data.description || '已入库',
        data.note ? `心得：${data.note}` : '',
      ].filter(Boolean).join(' · ');
    }
    window.showToast?.('抓拍已写入角色相册');
  } catch (e) {
    if (out) out.textContent = e.message || '抓拍失败';
    window.showToast?.(e.message || '抓拍失败');
  }
};

function setRobotHwTestOut(text) {
  const el = document.getElementById('robot-hw-test-out');
  if (el) el.textContent = text || '';
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatSenseBrief(sense) {
  if (!sense) return '尚无识图结果';
  const emo = sense.emotion ? emotionLabelZh(sense.emotion) : '';
  const face = sense.facePresent ? '看见人脸' : '没看清人脸';
  const id = sense.faceIdentity && sense.faceIdentity !== 'none'
    ? ` · 认人 ${sense.faceIdentity}`
    : '';
  let t = '';
  const when = sense.at || sense.updatedAt || sense.ts || '';
  if (typeof when === 'number' && when > 0) {
    const d = new Date(when);
    t = ` · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  } else if (when) {
    t = ` · ${String(when).slice(11, 19)}`;
  }
  return `${face}${emo ? `「${emo}」` : ''}${id}${t}`;
}

function formatFaceTrackBrief(t) {
  if (!t) return '尚无找人结果';
  if (t.lastError) return `找人报错：${t.lastError}`;
  if (!t.facePresent) return `没检测到脸 · yaw ${t.yaw ?? '?'} / pitch ${t.pitch ?? '?'}`;
  return `检测到脸 · yaw ${t.yaw}° / pitch ${t.pitch}°${t.hasTarget ? ' · 已对准' : ''}`;
}

function previewFaceTrackAngles(t) {
  if (!t || t.yaw == null) return;
  setRobotHwTestOut(formatFaceTrackBrief(t));
}

window.testRobotDeviceListen = async function() {
  const charId = document.getElementById('robot-character-id')?.value || '';
  if (!charId) {
    window.showToast?.('请先选择角色');
    return;
  }
  setRobotHwTestOut('正在开麦聆听（说完停 3 秒自动上传）…');
  try {
    await window.saveRobotSettings?.();
    const data = await api.startRobotListen({ characterId: Number(charId), silence_ms: 3000 });
    const opened = !!(data.queued || data.ok);
    setRobotHwTestOut(
      opened
        ? '已让小机开麦（说完停 3 秒收音）。聊天页应出现「用户正对小机讲话」。'
        : (data.hint || '麦没打开')
    );
    window.showToast?.(opened ? '小机开麦中，请对着小机说话' : (data.hint || '麦没打开'));
  } catch (e) {
    setRobotHwTestOut(`开麦失败：${e.message || e}`);
    window.showToast?.(e.message || '开麦失败');
  }
};

window.testRobotDeviceCamera = async function() {
  const charId = document.getElementById('robot-character-id')?.value || '';
  if (!charId) {
    window.showToast?.('请先选择角色');
    return;
  }
  setRobotHwTestOut('正在下发机身摄像头测试…');
  try {
    await window.saveRobotSettings?.();
    const data = await api.testRobotCamera({ characterId: charId });
    const beforeAt = data.lastSense?.at || data.lastSense?.updatedAt || data.lastSense?.ts || '';
    setRobotHwTestOut(
      `${data.hint || '已排队'}${data.deviceOnline ? '' : '（离线）'} · 等待小机回帧…`
    );
    window.showToast?.(data.deviceOnline ? '已让小机开摄像头' : '指令已排队，小机离线');

    let latest = data.lastSense;
    for (let i = 0; i < 16; i++) {
      await sleepMs(1500);
      const st = await api.getRobotStatus();
      latest = st.lastSense || latest;
      const at = latest?.at || latest?.updatedAt || latest?.ts || '';
      if (at && at !== beforeAt) {
        setRobotHwTestOut(`摄像头 OK：${formatSenseBrief(latest)}`);
        if (latest.facePresent && latest.reaction) {
          setRobotHwTestOut(`机身情绪：${latest.reaction}`);
        } else if (latest.facePresent && latest.emotion) {
          setRobotHwTestOut(`机身情绪：${latest.emotion}`);
        }
        window.showToast?.('机身摄像头有回帧');
        return;
      }
      setRobotHwTestOut(`等待小机回帧…（${i + 1}/16）${data.deviceOnline ? '' : ' · 仍离线请先连小机'}`);
    }
    setRobotHwTestOut(
      `超时未收到新回帧。${formatSenseBrief(latest)}。检查：小机在线、插件已重载、vision_explain 指向念。`
    );
  } catch (e) {
    setRobotHwTestOut(e.message || '摄像头测试失败');
    window.showToast?.(e.message || '摄像头测试失败');
  }
};

window.testRobotDeviceFaceTrack = async function() {
  const charId = document.getElementById('robot-character-id')?.value || '';
  if (!charId) {
    window.showToast?.('请先选择角色');
    return;
  }
  setRobotHwTestOut('正在下发人脸追踪测试…');
  try {
    await window.saveRobotSettings?.();
    const data = await api.testRobotFaceTrack({ characterId: charId });
    const beforeAt = data.target?.updatedAt || 0;
    setRobotHwTestOut(
      `${data.hint || '已排队'}${data.faceTrackEnabled ? '' : '（日常开关关着，本次强制测）'} · 等待找人…`
    );
    window.showToast?.(data.deviceOnline ? '已让小机找人' : '指令已排队，小机离线');

    let latest = data.target;
    for (let i = 0; i < 16; i++) {
      await sleepMs(1500);
      latest = await api.getRobotFaceTrackTarget();
      const at = latest?.updatedAt || 0;
      if (at && at !== beforeAt) {
        setRobotHwTestOut(`人脸追踪 OK：${formatFaceTrackBrief(latest)}`);
        previewFaceTrackAngles(latest);
        window.showToast?.(latest.facePresent ? '找到脸并对准了' : '拍了帧但没检测到脸');
        return;
      }
      setRobotHwTestOut(`等待找人结果…（${i + 1}/16）${data.deviceOnline ? '' : ' · 仍离线请先连小机'}`);
    }
    setRobotHwTestOut(
      `超时未更新。${formatFaceTrackBrief(latest)}。检查：小机在线、摄像头工具、插件已重载。`
    );
  } catch (e) {
    setRobotHwTestOut(e.message || '人脸追踪测试失败');
    window.showToast?.(e.message || '人脸追踪测试失败');
  }
};

window.onRobotHeadSlider = function() {
  const yaw = document.getElementById('robot-head-yaw')?.value ?? '0';
  const pitch = document.getElementById('robot-head-pitch')?.value ?? '45';
  const out = document.getElementById('robot-head-val');
  if (out) out.textContent = `左右 ${yaw} · 俯仰 ${pitch}`;
};

window.testRobotHeadMove = async function() {
  const charId = document.getElementById('robot-character-id')?.value || '';
  if (!charId) {
    window.showToast?.('请先选择角色');
    return;
  }
  const yaw = Number(document.getElementById('robot-head-yaw')?.value);
  const pitch = Number(document.getElementById('robot-head-pitch')?.value);
  setRobotHwTestOut(`转到 yaw=${yaw} pitch=${pitch}…`);
  try {
    const data = await api.testRobotHead({ characterId: charId, yaw, pitch, device: true });
    setRobotHwTestOut(
      `${data.hint || '已排队'} · 机身 ${data.sent?.yaw},${data.sent?.pitch}`
      + `（角色逻辑角 ${data.logical?.yaw},${data.logical?.pitch}，平视校准 ${data.pitchCenter}）`
    );
    window.showToast?.(data.deviceOnline ? '已让小机转头' : '指令已排队，小机离线');
  } catch (e) {
    setRobotHwTestOut(e.message || '转头失败');
    window.showToast?.(e.message || '转头失败');
  }
};

window.saveRobotPitchCenterFromSlider = async function() {
  const pitch = Math.round(Number(document.getElementById('robot-head-pitch')?.value));
  if (!Number.isFinite(pitch)) return;
  const hidden = document.getElementById('robot-pitch-center');
  if (hidden) hidden.value = String(pitch);
  try {
    await window.saveRobotSettings?.({ quiet: true });
    setRobotHwTestOut(`已把平视记成 pitch=${pitch}。角色写 [舵机:0,28] 会转到这里。`);
    window.showToast?.(`平视已设为 ${pitch}`);
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.initRobotPage = async function() {
  if (_ledAnim) {
    clearInterval(_ledAnim);
    _ledAnim = null;
  }
  _glanceBusy = false;
  const page = document.getElementById('robot-page');
  if (!page) return;
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

  let settings = {};
  let chars = [];
  try {
    [settings, chars] = await Promise.all([
      api.getSettings(),
      api.getCharacters(),
    ]);
    chars = window.filterFullCharacters?.(chars) || chars;
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
    return;
  }

  try {
    renderRobotPage(page, settings, chars);
  } catch (e) {
    console.error('[robot] render failed', e);
    page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '页面渲染失败')}</div></div>`;
  }
};

function renderRobotPage(page, settings, chars) {
  const mcpBase = String(settings.robot_mcp_base_url || 'http://127.0.0.1:8766').trim() || 'http://127.0.0.1:8766';
  const mcpTokenSaved = String(settings.robot_mcp_token || '').trim();
  const enabled = settings.robot_enabled === '1';
  const charId = String(settings.robot_character_id || '');
  const token = String(settings.robot_token || '');
  const ttsOn = settings.robot_tts !== '0';
  const ttsRate = parseInt(settings.robot_tts_sample_rate, 10) || 16000;
  const ttsVolume = Number(settings.robot_tts_volume) > 0 ? Number(settings.robot_tts_volume) : 0.85;
  const ttsSpeed = Number(settings.robot_tts_speed) > 0 ? Number(settings.robot_tts_speed) : 1;
  const robotVolume = Number.isFinite(parseInt(settings.robot_volume, 10))
    ? Math.max(0, Math.min(100, parseInt(settings.robot_volume, 10)))
    : 70;
  const deviceName = settings.robot_device_name || 'Stack-chan';
  const presenceOn = settings.robot_presence_enabled !== '0';
  const muteOn = settings.robot_mute === '1';
  const syncChatOn = settings.robot_sync_chat !== '0';
  const faceTrackOn = settings.robot_face_track_enabled !== '0';
  const ledOn = settings.robot_led_enabled !== '0';
  const ledMax = Number(settings.robot_led_max_brightness) > 0
    ? Math.max(0.05, Math.min(1, Number(settings.robot_led_max_brightness)))
    : 1;
  const pitchCenter = Number.isFinite(Number(settings.robot_pitch_center))
    ? Math.max(5, Math.min(85, Math.round(Number(settings.robot_pitch_center))))
    : 45;
  const emotionSenseOn = settings.robot_emotion_sense_enabled === '1';
  const faceprintOn = settings.robot_faceprint_enabled === '1';
  const faceprintInfo = settings.faceprint || { enrolled: false, samples: 0 };
  const decaySec = Math.max(3, Math.min(120, parseInt(settings.robot_expression_decay_sec || '12', 10) || 12));
  const drowsySec = Math.max(30, Math.min(1800, parseInt(settings.robot_drowsy_idle_sec || '180', 10) || 180));
  const savedPublic = normalizePublicBase(settings.robot_public_base_url);
  const pageOrigin = robotBaseUrl();
  const publicBase = robotPublicOrigin(settings);
  const displayBase = publicBase || pageOrigin;
  const publicMissing = !publicBase;
  const endpoint = `${displayBase}/api/robot/chat`;
  const publicInputValue = savedPublic || (publicBase && !isLoopbackOrPrivateOrigin(pageOrigin) ? publicBase : '');

  const charOptions = (chars || []).map((c) => {
    const selected = String(c.id) === charId ? 'selected' : '';
    return `<option value="${c.id}" ${selected}>${escapeHtml(c.name || `角色 ${c.id}`)}</option>`;
  }).join('');

  const initTab = window._toyInitTab === 'bbtoy' ? 'bbtoy' : (_toyPageTab === 'bbtoy' ? 'bbtoy' : 'stackchan');
  window._toyInitTab = null;
  _toyPageTab = initTab;
  const nativeToy = !!isNativeShell?.();
  const toyEnabled = String(settings.toy_enabled || '0') === '1';
  const toyElectric = String(settings.toy_electric ?? '1') === '1';
  const toyHrFollow = String(settings.toy_hr_follow ?? '0') === '1';
  const toyGentle = settings.toy_feel_gentle || '20';
  const toyMedium = settings.toy_feel_medium || '45';
  const toyStrong = settings.toy_feel_strong || '70';

  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">toy</div>
      <button type="button" class="topbar-save" onclick="saveRobotSettings()">保存</button>
    </div>
    <div class="toy-tab-bar" role="tablist">
      <button type="button" class="toy-tab${initTab === 'stackchan' ? ' is-on' : ''}" id="toy-tab-stackchan" role="tab" aria-selected="${initTab === 'stackchan'}" onclick="switchToyTab('stackchan')">stackchan</button>
      <button type="button" class="toy-tab${initTab === 'bbtoy' ? ' is-on' : ''}" id="toy-tab-bbtoy" role="tab" aria-selected="${initTab === 'bbtoy'}" onclick="switchToyTab('bbtoy')">bbtoy</button>
    </div>
    <div class="scroll-area scroll-area-native" style="padding-bottom:40px">
      <div id="toy-panel-stackchan" class="toy-panel" role="tabpanel" ${initTab === 'stackchan' ? '' : 'hidden'}>
      <div class="settings-section" style="margin-top:12px">
        <div class="settings-group" style="padding:14px 16px">
          <div style="font-size:13px;line-height:1.65;color:var(--text-secondary)">
            <strong style="color:var(--text)">说明</strong>：stackchan 对接仍在完善中，公开版功能可能不完整。欢迎自托管试用，但请降低预期。
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">基础</div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row-label">启用 stackchan 通道</div>
            <label class="toggle">
              <input type="checkbox" id="robot-enabled" ${enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">绑定角色</div>
            <select class="input" id="robot-character-id">
              <option value="">请选择角色</option>
              ${charOptions}
            </select>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">设备显示名</div>
            <input class="input" id="robot-device-name" value="${escapeHtml(deviceName)}" placeholder="Stack-chan">
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">MCP 网关</div>
        <div class="settings-group">
          <div class="settings-row settings-row--stack">
            <div class="settings-row-sub" style="margin-bottom:8px">
              角色看/说直连网关，无需唤醒。
              小机 WebSocket 填 <code>wss://你的域名/stackchan/</code>；
              工具地址同机念填 <code>http://127.0.0.1:8766</code>。
              部署见 <code>stackchan/README-mcp-nian.md</code>。
              网关需 ffmpeg 才能播角色音色。
            </div>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">MCP 工具地址</div>
            <input class="input" id="robot-mcp-base" type="url" value="${escapeHtml(mcpBase)}"
              placeholder="http://127.0.0.1:8766">
            <div class="settings-row-sub">VPS 上与念同机时用 127.0.0.1:8766；念调 /tools/*</div>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">MCP Token（可空）</div>
            <input class="input" id="robot-mcp-token" type="text" value="${escapeHtml(mcpTokenSaved)}"
              placeholder="默认用上面的设备令牌 / STACKCHAN_TOKEN">
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">ParamFace 脸</div>
        <div class="settings-group">
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">导入 face.json</div>
            <div class="settings-row-sub" style="margin-bottom:8px">
              从 <a href="https://zziying.github.io/stackchan-face-editor/" target="_blank" rel="noopener">脸编辑器</a> 导出后点下方导入；MCP 网关连着机身时几秒内换脸，断电也保留。约 8000 字节以内。表情只靠 <code>[表情:…]</code> 关键字切换，不再推 PNG。
            </div>
            <input type="file" id="robot-face-file" accept=".json,application/json" style="display:none"
              onchange="onRobotFaceFilePicked(event)">
            <div style="display:flex;flex-wrap:wrap;gap:8px">
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('robot-face-file').click()">选择 JSON</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="resetRobotFace()">恢复内置脸</button>
            </div>
            <div id="robot-face-status" class="settings-row-sub" style="margin-top:8px;min-height:1.2em"></div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">喇叭与音质</div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row-label">回复后生成 TTS</div>
            <label class="toggle">
              <input type="checkbox" id="robot-tts" ${ttsOn ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">禁言</div>
            <label class="toggle">
              <input type="checkbox" id="robot-mute" ${muteOn ? 'checked' : ''}
                onchange="onRobotMuteToggle()">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row settings-row--stack" id="robot-volume-row">
            <div class="settings-row-label" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
              <span>小机音量</span>
              <span id="robot-volume-val" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">${robotVolume}</span>
            </div>
            <div class="settings-row-sub" style="margin-bottom:8px" id="robot-volume-hint">
              ${muteOn ? '禁言中为 0；关掉禁言后按此值。' : '机身喇叭 0–100，保存后几秒生效。'}
            </div>
            <div style="opacity:${muteOn ? '0.5' : '1'}" id="robot-volume-ctl">
              <input type="range" id="robot-volume" min="0" max="100" step="1" value="${robotVolume}"
                oninput="onRobotVolumeInput()">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">情绪灯光</div>
            <label class="toggle">
              <input type="checkbox" id="robot-led" ${ledOn ? 'checked' : ''}
                onchange="onRobotLedToggle()">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row settings-row--stack" id="robot-led-max-row">
            <div class="settings-row-label" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
              <span>灯光最亮</span>
              <span id="robot-led-max-val" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">${Math.round(ledMax * 100)}%</span>
            </div>
            <div class="settings-row-sub" style="margin-bottom:8px" id="robot-led-max-hint">
              ${ledOn ? '心情决定颜色，这里只压最亮能到多亮。夜里建议 30% 左右。' : '灯光已关，任何心情都不点灯。'}
            </div>
            <div style="opacity:${ledOn ? '1' : '0.5'}" id="robot-led-max-ctl">
              <input type="range" id="robot-led-max" min="0.05" max="1" step="0.05" value="${ledMax}"
                oninput="onRobotLedMaxInput()">
            </div>
          </div>
          <div class="settings-row settings-row--stack" id="robot-tts-quality-row">
            <div class="settings-row-label">合成采样率</div>
            <select class="input" id="robot-tts-rate">
              ${[16000, 24000, 32000].map((r) => (
    `<option value="${r}" ${ttsRate === r ? 'selected' : ''}>${r} Hz${r === 16000 ? '（默认）' : ''}</option>`
  )).join('')}
            </select>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
              <span>TTS 音量</span>
              <span id="robot-tts-volume-val" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">${ttsVolume}</span>
            </div>
            <input type="range" id="robot-tts-volume" min="0.3" max="2" step="0.05" value="${ttsVolume}"
              oninput="onRobotTtsVolumeInput()">
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
              <span>语速</span>
              <span id="robot-tts-speed-val" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">${ttsSpeed}</span>
            </div>
            <input type="range" id="robot-tts-speed" min="0.6" max="1.6" step="0.05" value="${ttsSpeed}"
              oninput="onRobotTtsSpeedInput()">
          </div>
          <div class="settings-row">
            <div class="settings-row-label">同步到聊天</div>
            <label class="toggle">
              <input type="checkbox" id="robot-sync-chat" ${syncChatOn ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">感知</div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row-label">在场感</div>
            <label class="toggle">
              <input type="checkbox" id="robot-presence" ${presenceOn ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">无人互动多久困倦（秒）</div>
            <input class="input" id="robot-drowsy-sec" type="number" min="30" max="1800" value="${drowsySec}">
          </div>
          <div class="settings-row">
            <div class="settings-row-label">表情衰减</div>
            <label class="toggle">
              <input type="checkbox" id="robot-decay-enabled" ${decaySec > 0 ? 'checked' : ''}
                onchange="document.getElementById('robot-decay-row').style.display=this.checked?'flex':'none'">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row settings-row--stack" id="robot-decay-row" style="${decaySec > 0 ? '' : 'display:none'}">
            <div class="settings-row-label">表情停留秒数</div>
            <input class="input" id="robot-decay-sec" type="number" min="3" max="120" value="${decaySec || 12}">
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <div>人脸追踪</div>
              <div class="settings-row-sub">总开关。角色写 [桌宠:找人] 会转头扫一圈找脸并对准（坐着不动也能找到）；开了「认出是不是你」会再判断是不是你。写 [桌宠:跟着] 才持续跟。看环境用 [桌宠:看一眼]，不扫视。</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="robot-face-track" ${faceTrackOn ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">
              <div>真机测试</div>
              <div class="settings-row-sub">测的是桌上小机摄像头。需 MCP 网关在线。</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm" onclick="testRobotDeviceCamera()">测机身摄像头</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="testRobotDeviceFaceTrack()">测人脸追踪</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="testRobotDeviceListen()">测点屏聆听</button>
            </div>
            <div id="robot-hw-test-out" class="settings-row-sub" style="min-height:1.2em"></div>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
              <span>舵机试转（机身原始角）</span>
              <span id="robot-head-val" style="font-variant-numeric:tabular-nums;color:var(--text-secondary)">左右 0 · 俯仰 ${pitchCenter}</span>
            </div>
            <div class="settings-row-sub" style="margin-bottom:8px">
              拖完点「转到这」。头平视你的时候再点「这就是平视」——角色写的 28 会映射到这个值。出厂多半在 45 附近。
            </div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <input type="range" id="robot-head-yaw" min="-70" max="70" step="1" value="0"
                oninput="onRobotHeadSlider()">
              <input type="range" id="robot-head-pitch" min="5" max="85" step="1" value="${pitchCenter}"
                oninput="onRobotHeadSlider()">
              <input type="hidden" id="robot-pitch-center" value="${pitchCenter}">
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button type="button" class="btn btn-ghost btn-sm" onclick="testRobotHeadMove()">转到这</button>
                <button type="button" class="btn btn-ghost btn-sm" onclick="saveRobotPitchCenterFromSlider()">这就是平视</button>
              </div>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">识别用户情绪</div>
            <label class="toggle">
              <input type="checkbox" id="robot-emotion-sense" ${emotionSenseOn ? 'checked' : ''} onchange="onRobotEmotionSenseToggle()">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">认出是不是你</div>
            <label class="toggle">
              <input type="checkbox" id="robot-faceprint" ${faceprintOn ? 'checked' : ''} onchange="onRobotFaceprintToggle()">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row settings-row--stack">
            <div id="robot-faceprint-status" class="settings-row-sub">${escapeHtml(faceprintStatusText(faceprintInfo))}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('robot-faceprint-file').click()">上传正脸</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="armRobotFaceprintEnroll()">下一眼算你</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="clearRobotFaceprint()">清除</button>
            </div>
            <input type="file" id="robot-faceprint-file" accept="image/*" style="display:none" onchange="uploadRobotFaceprint(event)">
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">连接</div>
        <div class="settings-group">
          <div class="settings-row settings-row--stack">
            <div id="robot-device-status" class="robot-connect-card">检测中…</div>
            <div class="robot-connect-actions">
              <button type="button" class="btn btn-primary" id="robot-connect-btn" onclick="connectRobotNow()">帮我连上</button>
              <button type="button" class="btn btn-ghost" id="robot-connect-recheck" onclick="recheckRobotConnection()">重新打招呼</button>
            </div>
            <div id="robot-command-out" class="settings-row-sub" style="margin-top:8px;min-height:1.2em;color:var(--text-primary)"></div>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">设备令牌</div>
            <input class="input" id="robot-token" type="text" readonly value="${escapeHtml(token)}"
              placeholder="尚未生成">
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm" onclick="copyRobotToken()">复制</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="regenerateRobotToken()">重新生成</button>
            </div>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">公网地址</div>
            <input class="input" id="robot-public-base" type="url" inputmode="url" autocomplete="off"
              placeholder="https://你的域名"
              value="${escapeHtml(publicInputValue)}">
            ${publicMissing ? `<div class="settings-row-sub" style="color:var(--danger, #c45c5c)">需填公网域名，不要用 localhost。</div>` : ''}
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">API</div>
            <code id="robot-endpoint" style="font-size:12px;word-break:break-all;color:var(--text-secondary)">${escapeHtml(endpoint)}</code>
            <button type="button" class="btn btn-ghost btn-sm" style="align-self:flex-start" onclick="copyRobotEndpoint()">复制</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">调试</div>
        <div class="settings-group">
          <div class="settings-row settings-row--stack">
            <div class="settings-row-label">
              <div>本机试抓拍</div>
              <div class="settings-row-sub">用手机/电脑相册上传一张图走识图流程（不经过小机摄像头）</div>
            </div>
            <input class="input" id="robot-snapshot-context" placeholder="抓拍备注（可选）">
            <button type="button" class="btn btn-ghost" onclick="document.getElementById('robot-snapshot-file').click()">试抓拍</button>
            <input type="file" id="robot-snapshot-file" accept="image/*" style="display:none" onchange="testRobotSnapshot(event)">
            <div id="robot-snapshot-out" style="font-size:13px;line-height:1.6;color:var(--text-secondary);min-height:1.2em"></div>
          </div>
          <div class="settings-row settings-row--stack">
            <textarea class="input" id="robot-test-input" rows="2" placeholder="对小机说一句…" style="resize:vertical;min-height:64px"></textarea>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-primary" onclick="testRobotChat()">试聊</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="triggerRobotOutreach()">试连小机</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="previewRobotOperating(true)">模拟操纵中</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="previewRobotOperating(false)">结束模拟</button>
            </div>
            <div id="robot-test-out" style="font-size:13px;line-height:1.6;color:var(--text-secondary);min-height:1.2em"></div>
          </div>
        </div>
      </div>
      </div>

      <div id="toy-panel-bbtoy" class="toy-panel" role="tabpanel" ${initTab === 'bbtoy' ? '' : 'hidden'}>
        <div class="settings-section" style="margin-top:12px">
          <div class="settings-section-title">啵啵贝</div>
          <div class="settings-group">
            <div class="settings-row settings-row--stack">
              <div class="settings-row-sub" style="line-height:1.55">
                安卓 App 用蓝牙连啵啵贝 Pro（常见名字 SOSEXY）。连上后角色能用 0～100 连续拧档，换档默认缓滑（可排时间线）。请先关掉官方 FUNF，手机别离太远。
              </div>
            </div>
            ${nativeToy ? `
            <div class="settings-row">
              <div>
                <div class="settings-row-label">允许角色控制</div>
                <div class="settings-row-sub">连上之后，聊天里角色能调吸、震、微电，或立刻停</div>
              </div>
              <label class="toggle"><input type="checkbox" id="toy-enabled" ${toyEnabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
            </div>
            <div class="settings-row">
              <div>
                <div class="settings-row-label">微电通道</div>
                <div class="settings-row-sub">角色可单独拧微电。不想过电就关掉</div>
              </div>
              <label class="toggle"><input type="checkbox" id="toy-electric" ${toyElectric ? 'checked' : ''}><span class="toggle-slider"></span></label>
            </div>
            <div class="settings-row">
              <div>
                <div class="settings-row-label">跟着心率走</div>
                <div class="settings-row-sub">默认关。打开后，心跳偏快时角色不会再往重里拧；多数手表几分钟才写一次，跟不上现场。角色主要听你话里的反应来调</div>
              </div>
              <label class="toggle"><input type="checkbox" id="toy-hr-follow" ${toyHrFollow ? 'checked' : ''}><span class="toggle-slider"></span></label>
            </div>
            <div class="settings-row settings-row--stack">
              <div class="settings-row-label">你的轻重</div>
              <div class="settings-row-sub" style="margin-bottom:8px">角色会按这三个数来理解轻/中/重，可按自己的感觉改</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <label style="flex:1;min-width:80px;font-size:12px;color:var(--text-secondary)">轻 <input class="input" id="toy-gentle" type="number" min="1" max="100" value="${escapeHtml(toyGentle)}" style="width:100%;margin-top:4px"></label>
                <label style="flex:1;min-width:80px;font-size:12px;color:var(--text-secondary)">中 <input class="input" id="toy-medium" type="number" min="1" max="100" value="${escapeHtml(toyMedium)}" style="width:100%;margin-top:4px"></label>
                <label style="flex:1;min-width:80px;font-size:12px;color:var(--text-secondary)">重 <input class="input" id="toy-strong" type="number" min="1" max="100" value="${escapeHtml(toyStrong)}" style="width:100%;margin-top:4px"></label>
              </div>
            </div>
            <div class="settings-row settings-row--stack">
              <div class="settings-row-label" id="toy-status">尚未连接</div>
              <div class="settings-row-sub" id="toy-status-sub">点扫描，选 SOSEXY</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
                <button class="btn btn-primary btn-sm" type="button" onclick="scanToyDevice()">扫描</button>
                <button class="btn btn-ghost btn-sm" type="button" onclick="disconnectToyDevice()">断开</button>
                <button class="btn btn-ghost btn-sm" type="button" onclick="testToyFeel('gentle')">试一下轻</button>
                <button class="btn btn-ghost btn-sm" type="button" onclick="testToyFeel('stop')">停</button>
              </div>
              <div id="toy-devices" style="margin-top:8px"></div>
            </div>
            ` : `
            <div class="settings-row settings-row--stack">
              <div class="settings-row-sub">啵啵贝蓝牙连接仅安卓 App 可用。请用念安卓版打开 toy → bbtoy。</div>
            </div>
            `}
          </div>
        </div>
      </div>
    </div>
  `;
  refreshRobotDeviceStatus();
  if (nativeToy) refreshToyStatus();
  if (_robotCmdPoll) clearInterval(_robotCmdPoll);
  _robotCmdPoll = setInterval(() => {
    refreshRobotDeviceStatus();
    pollRobotCommands();
  }, 5000);
}

window.switchToyTab = function(tab) {
  const next = tab === 'bbtoy' ? 'bbtoy' : 'stackchan';
  _toyPageTab = next;
  const scTab = document.getElementById('toy-tab-stackchan');
  const bbTab = document.getElementById('toy-tab-bbtoy');
  const scPanel = document.getElementById('toy-panel-stackchan');
  const bbPanel = document.getElementById('toy-panel-bbtoy');
  scTab?.classList.toggle('is-on', next === 'stackchan');
  bbTab?.classList.toggle('is-on', next === 'bbtoy');
  scTab?.setAttribute('aria-selected', next === 'stackchan' ? 'true' : 'false');
  bbTab?.setAttribute('aria-selected', next === 'bbtoy' ? 'true' : 'false');
  if (scPanel) scPanel.hidden = next !== 'stackchan';
  if (bbPanel) bbPanel.hidden = next !== 'bbtoy';
};

function toyPhaseText(st) {
  if (st?.ready) return '已连上，角色可以调';
  if (st?.connected) return '已连上，正在准备';
  if (st?.connecting) return '正在连接…';
  if (st?.scanning) return '正在扫描…';
  if (st?.error === 'bluetooth_off') return '请先打开手机蓝牙';
  if (st?.error === 'need_bt') return '需要蓝牙权限';
  if (st?.name) return `已记住 ${st.name}，还未连上`;
  return '尚未连接';
}

async function refreshToyStatus(st) {
  const el = document.getElementById('toy-status');
  const sub = document.getElementById('toy-status-sub');
  if (!el) return;
  try {
    st = st || await toyStatus();
  } catch {
    st = {};
  }
  el.textContent = toyPhaseText(st);
  const bits = [];
  if (st?.name) bits.push(st.name);
  if (st?.ready || st?.connected) {
    bits.push(`吮吸 ${st.suction || 0} · 震动 ${st.vibration || 0} · 微电 ${st.electric || 0}`);
  }
  if (sub) sub.textContent = bits.join(' · ') || '点扫描，选 SOSEXY';
}

window.scanToyDevice = async function() {
  const box = document.getElementById('toy-devices');
  if (box) box.innerHTML = '<div class="settings-row-sub">扫描中，大约 10 秒…</div>';
  window.showToast?.('正在扫描蓝牙…');
  try {
    const st = await toyScan();
    refreshToyStatus(st);
    const devices = Array.isArray(st?.devices) ? st.devices : [];
    if (!box) return;
    if (!devices.length) {
      box.innerHTML = '<div class="settings-row-sub">没扫到。确认玩具开着、官方 FUNF 已关掉。</div>';
      return;
    }
    box.innerHTML = devices.map((d) => {
      const addr = String(d.address || '').replace(/[^0-9A-Fa-f:]/g, '');
      const name = String(d.name || '').replace(/['"\\<>]/g, '');
      return `
      <div class="list-item" onclick="connectToyDevice('${addr}','${escapeHtml(name)}')">
        <div>
          <div>${escapeHtml(d.name || '(未命名)')}${d.target ? ' · 啵啵贝' : ''}</div>
          <div class="settings-row-sub">${escapeHtml(d.address || '')} · ${d.rssi || ''} dBm</div>
        </div>
        <span style="color:var(--text-secondary)">连接</span>
      </div>`;
    }).join('');
  } catch (e) {
    if (box) box.innerHTML = `<div class="settings-row-sub">${escapeHtml(e.message || '扫描失败')}</div>`;
    window.showToast?.(e.message || '扫描失败');
  }
};

window.connectToyDevice = async function(address, name) {
  window.showToast?.('正在连接…');
  try {
    const st = await toyConnect(address, name);
    refreshToyStatus(st);
    window.showToast?.(st?.ready || st?.connected ? '已连上' : (st?.error === 'not_bobobei' ? '这台不是啵啵贝' : '还没就绪，稍等再试'));
    try { window.refreshChatDeviceLinks?.(); } catch {}
  } catch (e) {
    window.showToast?.(e.message || '连接失败');
  }
};

window.disconnectToyDevice = async function() {
  try {
    const st = await toyDisconnect();
    refreshToyStatus(st);
    const box = document.getElementById('toy-devices');
    if (box) box.innerHTML = '';
    window.showToast?.('已断开');
    try { window.refreshChatDeviceLinks?.(); } catch {}
  } catch (e) {
    window.showToast?.(e.message || '断开失败');
  }
};

window.testToyFeel = async function(feel) {
  try {
    const gentle = Number(document.getElementById('toy-gentle')?.value) || 20;
    const st = feel === 'stop'
      ? await toyApply({ action: 'stop' })
      : await toyApply({ action: 'set', suction: gentle, vibration: gentle, duration: 3 });
    refreshToyStatus(st);
    window.showToast?.(feel === 'stop' ? '已停' : '已发轻档 3 秒');
  } catch (e) {
    window.showToast?.(e.message || '没发出去，先连上');
  }
};

async function refreshRobotDeviceStatus(opts = {}) {
  const el = document.getElementById('robot-device-status');
  const btn = document.getElementById('robot-connect-btn');
  try {
    const st = await api.getRobotStatus();
    if (!el) return st;
    const c = st.connect || {};
    const online = !!(c.online ?? st.deviceOnline);
    _deviceOnline = online;
    const pending = st.pendingCommands || 0;
    const hint = st.driveHint || st.characterMood || '';
    const missed = c.missedWill?.text || '';
    el.className = `robot-connect-card ${online ? 'is-online' : 'is-offline'}`;
    el.innerHTML = `
      <div class="robot-connect-title">
        <span class="robot-connect-dot" aria-hidden="true"></span>
        ${escapeHtml(c.title || (online ? '小机在线' : '桌上那台还没跟念说到话'))}
      </div>
      <div class="robot-connect-detail">${escapeHtml(c.detail || '')}</div>
      <div class="robot-connect-control">${escapeHtml(c.controlHint || '')}</div>
      ${pending ? `<div class="robot-connect-pending">还有 ${pending} 条动作等小机来取</div>` : ''}
      ${missed ? `<div class="robot-connect-pending">${escapeHtml(missed)}</div>` : ''}
      ${hint ? `<div class="robot-connect-mood">${escapeHtml(hint)}</div>` : ''}
    `;
    if (btn) btn.textContent = online ? '再确认一次' : '帮我连上';
    if (opts.fromConnect) {
      window.showToast?.(online
        ? '连上了。角色现在可以通过 MCP 网关自己动小机。'
        : '通道已打开。小机要自己连上网并跟 MCP 网关建连，念才看得到它。');
    }
    return st;
  } catch {
    _deviceOnline = false;
    if (el) {
      el.className = 'robot-connect-card is-offline';
      el.innerHTML = `
        <div class="robot-connect-title"><span class="robot-connect-dot"></span>还查不到小机</div>
        <div class="robot-connect-detail">请先保存并打开「启用 stackchan 通道」，再点「帮我连上」。</div>
      `;
    }
    return null;
  }
}

window.recheckRobotConnection = async function() {
  const btn = document.getElementById('robot-connect-recheck');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '在听…';
  }
  try {
    const st = await refreshRobotDeviceStatus();
    const online = !!(st?.connect?.online ?? st?.deviceOnline);
    window.showToast?.(online ? '还在，念听得到它' : '还没打到招呼。确认小机亮着、有猫脸。');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重新打招呼';
    }
  }
};

window.connectRobotNow = async function() {
  const btn = document.getElementById('robot-connect-btn');
  const charId = String(document.getElementById('robot-character-id')?.value || '');
  if (!charId) {
    window.showToast?.('先选一个角色，再让我帮你连');
    document.getElementById('robot-character-id')?.focus();
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在打招呼…';
  }
  try {
    const enabledEl = document.getElementById('robot-enabled');
    if (enabledEl && !enabledEl.checked) enabledEl.checked = true;
    await window.saveRobotSettings?.({ quiet: true });
    await new Promise((r) => setTimeout(r, 400));
    await refreshRobotDeviceStatus({ fromConnect: true });
  } catch (e) {
    window.showToast?.(e.message || '没连上');
  } finally {
    if (btn) btn.disabled = false;
  }
};

/**
 * 本页只是预览，不 ack 队列（真机指令由 MCP 桥拉走）。
 * 所以必须自己记住处理过哪些 id，否则同一条 glance 会每 9 秒重开一次摄像头。
 */
const _seenCmdIds = new Set();

function markCmdSeen(id) {
  if (!id) return false;
  if (_seenCmdIds.has(id)) return false;
  _seenCmdIds.add(id);
  if (_seenCmdIds.size > 400) {
    for (const v of _seenCmdIds) {
      _seenCmdIds.delete(v);
      if (_seenCmdIds.size <= 200) break;
    }
  }
  return true;
}

async function pollRobotCommands() {
  const on = document.getElementById('robot-enabled')?.checked;
  if (!on) return;
  try {
    const data = await api.getRobotCommands();
    const cmds = data.commands || [];
    for (const cmd of cmds) {
      if (!markCmdSeen(cmd?.id)) continue;
      await processRobotCommand(cmd);
    }
  } catch {}
}

async function processRobotCommand(cmd) {
  const type = cmd?.type;
  const p = cmd?.payload || {};
  if (type === 'glance') {
    // 「看一眼」只走小机自己的摄像头（MCP 网关拍照，图回 /mcp/vision/explain）。
    // 手机镜头不参与：这台机器本来就是给小机用的，用手机拍会让角色看到的是错的东西。
    setRobotSenseStatus(_deviceOnline
      ? '小机在用自己的摄像头看一眼…'
      : '小机不在线，这一眼没法看');
  } else if (type === 'display') {
    if (p.emotion || p.motion) {
      applyRobotFacePreview({ emotion: p.emotion, motion: p.motion });
    }
    if (p.motion === 'custom' && p.motionRaw) applyServoPreview({ raw: p.motionRaw, motion: 'custom' });
    else if (p.motion && p.motion !== 'idle') applyServoPreview({ motion: p.motion });
    if (p.led) applyLedPreview(p.led);
    if (p.servo) applyServoPreview(p.servo);
    const out = document.getElementById('robot-command-out');
    if (out && p.displayText) out.textContent = p.displayText;
    if (p.intent) {
      window.showToast?.(`角色通过小机：${p.intent}`);
    }
  } else if (type === 'led') {
    applyLedPreview(p);
    setRobotSenseStatus(
      p.off ? '灯光：关' : `灯光：${p.hex || 'on'} · ${p.frequencyHz || 0}Hz`
    );
  } else if (type === 'servo') {
    applyServoPreview(p);
  } else if (type === 'speak') {
    // 声音归小机的喇叭。这里只回显文字，避免手机和小机同时念同一句
    const out = document.getElementById('robot-command-out');
    if (out && p.text) out.textContent = `小机要说：${p.text}`;
    setRobotSenseStatus(p.muted
      ? '角色写了一句，但当前禁言，只上屏不出声'
      : (p.audioUrl ? '已把角色的语音交给小机播放' : '角色想说话，但没生成语音（检查角色音色）'));
  } else if (type === 'snapshot') {
    window.showToast?.('小机收到抓拍指令（真机执行；网页可用下方试抓拍）');
  } else if (type === 'refresh_settings') {
    await refreshRobotDeviceStatus();
  }
}

window.triggerRobotOutreach = async function() {
  const charId = document.getElementById('robot-character-id')?.value || '';
  if (!charId) {
    window.showToast?.('请先选择角色');
    return;
  }
  try {
    await window.saveRobotSettings?.();
    const data = await api.triggerRobotOutreach({ characterId: charId });
    window.showToast?.(data.speak ? `已触发：${data.speak.slice(0, 40)}` : '已触发靠近');
    await pollRobotCommands();
    refreshRobotDeviceStatus();
  } catch (e) {
    window.showToast?.(e.message || '触发失败');
  }
};

function setRobotSenseStatus(text) {
  const el = document.getElementById('robot-sense-status');
  if (el) el.textContent = text;
}

function setRobotFaceprintStatus(text) {
  const el = document.getElementById('robot-faceprint-status');
  if (el) el.textContent = text;
}

function faceprintStatusText(fp) {
  if (fp?.enrollNext) return '已待命：下一张小机自己拍到的画面会当成你的正脸参考。对着小机让它看你一眼。';
  if (!fp?.enrolled) return '尚未录入。请上传一张正脸，或点「下一眼小机拍的算你」。';
  const when = fp.enrolledAt ? String(fp.enrolledAt).slice(0, 10) : '';
  return `已有参考正脸${fp.photos ? `（${fp.photos} 张）` : ''}${when ? ` · ${when}` : ''}。小机看人时会比对。`;
}

function senseEnabled() {
  return !!document.getElementById('robot-emotion-sense')?.checked;
}

function glanceEnabled() {
  return senseEnabled();
}

function refreshRobotGlanceHint() {
  setRobotSenseStatus('真机看人用小机摄像头。这颗按钮只是电脑摄像头预览电子屏变脸');
}

/**
 * 角色扫一眼：短暂开摄 → 变脸 → 上报 → 关摄
 * @param {'chat'|'look_user'|'manual'} reason
 */
async function robotGlance(reason = 'chat') {
  if (_glanceBusy) return null;
  _glanceBusy = true;
  const video = document.getElementById('robot-sense-video');
  const why = reason === 'look_user' ? '角色看向你' : reason === 'manual' ? '试扫一眼' : '角色听你说话前';
  setRobotSenseStatus(`${why}，扫一眼…`);
  try {
    const result = await glanceUserEmotion({
      mirrorVideo: video,
      durationMs: reason === 'look_user' ? 1600 : 1800,
      onStatus: setRobotSenseStatus,
    });
    if (result?.busy) {
      setRobotSenseStatus('上一次扫一眼还在进行');
      return null;
    }
    _lastSensedUserEmotion = result.facePresent ? result.emotion : '';
    if (result.facePresent && senseEnabled()) {
      applyRobotFacePreview({ emotion: result.reaction });
    }
    try {
      await api.robotSense({
        emotion: result.emotion,
        reaction: result.reaction,
        confidence: result.confidence,
        facePresent: result.facePresent,
        characterId: document.getElementById('robot-character-id')?.value || undefined,
      });
    } catch {}
    if (result.facePresent) {
      setRobotSenseStatus(
        `${why}：看见你「${emotionLabelZh(result.emotion)}」→ 变脸「${emotionLabelZh(result.reaction)}」`
      );
    } else {
      setRobotSenseStatus(`${why}：没看清人脸，过会儿再说`);
    }
    return result;
  } catch (e) {
    setRobotSenseStatus(e.message || '扫一眼失败');
    return null;
  } finally {
    _glanceBusy = false;
  }
}

window.onRobotEmotionSenseToggle = async function() {
  const on = !!document.getElementById('robot-emotion-sense')?.checked;
  try {
    await api.saveSettings({ robot_emotion_sense_enabled: on ? '1' : '0' });
    const s = window.getAppSettings?.();
    if (s) s.robot_emotion_sense_enabled = on ? '1' : '0';
  } catch {}
  if (!on) _lastSensedUserEmotion = '';
  refreshRobotGlanceHint();
};

window.onRobotFaceprintToggle = async function() {
  const on = !!document.getElementById('robot-faceprint')?.checked;
  try {
    await api.saveSettings({ robot_faceprint_enabled: on ? '1' : '0' });
    const s = window.getAppSettings?.();
    if (s) s.robot_faceprint_enabled = on ? '1' : '0';
  } catch {}
  if (!on) _lastFaceIdentity = '';
  refreshRobotGlanceHint();
};

window.manualRobotGlance = async function() {
  await robotGlance('manual');
};

window.uploadRobotFaceprint = async function(ev) {
  const file = ev.target?.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    setRobotFaceprintStatus('正在保存参考正脸…');
    const status = await api.enrollFaceprintPhoto(file, { merge: true });
    setRobotFaceprintStatus(faceprintStatusText(status));
    const toggle = document.getElementById('robot-faceprint');
    if (toggle && !toggle.checked) {
      toggle.checked = true;
      await window.onRobotFaceprintToggle?.();
    }
    window.showToast?.('参考正脸已保存。让小机看人时会比对。');
  } catch (e) {
    setRobotFaceprintStatus(e.message || '上传失败');
    window.showToast?.(e.message || '上传失败');
  }
};

window.armRobotFaceprintEnroll = async function() {
  try {
    const status = await api.setFaceprintEnrollNext(true);
    const toggle = document.getElementById('robot-faceprint');
    if (toggle && !toggle.checked) {
      toggle.checked = true;
      await window.onRobotFaceprintToggle?.();
    }
    setRobotFaceprintStatus(faceprintStatusText({ ...status, enrollNext: true }));
    window.showToast?.('下一眼算你：对着小机让它看你一眼');
  } catch (e) {
    window.showToast?.(e.message || '设置失败');
  }
};

window.clearRobotFaceprint = async function() {
  if (!confirm('确定清除已录入的面容？')) return;
  try {
    const status = await api.clearFaceprint();
    setRobotFaceprintStatus(faceprintStatusText(status));
    _lastFaceIdentity = '';
    window.showToast?.('已清除面容');
  } catch (e) {
    window.showToast?.(e.message || '清除失败');
  }
};

window.onRobotVolumeInput = function() {
  const el = document.getElementById('robot-volume');
  const out = document.getElementById('robot-volume-val');
  if (el && out) out.textContent = String(el.value);
};

window.onRobotLedMaxInput = function() {
  const el = document.getElementById('robot-led-max');
  const out = document.getElementById('robot-led-max-val');
  if (el && out) {
    const n = Number(el.value);
    out.textContent = Number.isFinite(n) ? `${Math.round(n * 100)}%` : el.value;
  }
};

/** 关灯时滑块置灰但留着：不然重新开灯前没法先把亮度调低 */
window.onRobotLedToggle = function() {
  const on = !!document.getElementById('robot-led')?.checked;
  const ctl = document.getElementById('robot-led-max-ctl');
  const hint = document.getElementById('robot-led-max-hint');
  if (ctl) ctl.style.opacity = on ? '1' : '0.5';
  if (hint) {
    hint.textContent = on
      ? '心情决定颜色，这里只压最亮能到多亮。夜里建议 30% 左右。'
      : '灯光已关，任何心情都不点灯。';
  }
};

window.onRobotTtsVolumeInput = function() {
  const el = document.getElementById('robot-tts-volume');
  const out = document.getElementById('robot-tts-volume-val');
  if (el && out) {
    const n = Number(el.value);
    out.textContent = Number.isFinite(n) ? String(Math.round(n * 100) / 100) : el.value;
  }
};

window.onRobotTtsSpeedInput = function() {
  const el = document.getElementById('robot-tts-speed');
  const out = document.getElementById('robot-tts-speed-val');
  if (el && out) {
    const n = Number(el.value);
    out.textContent = Number.isFinite(n) ? String(Math.round(n * 100) / 100) : el.value;
  }
};

/**
 * 禁言时音量滑块置灰但保留：藏起来会让人以为压根没这个功能，
 * 而且关掉禁言之前也没法先把音量调好。
 */
window.onRobotMuteToggle = function() {
  const muted = !!document.getElementById('robot-mute')?.checked;
  const ctl = document.getElementById('robot-volume-ctl');
  const hint = document.getElementById('robot-volume-hint');
  if (ctl) ctl.style.opacity = muted ? '0.5' : '1';
  if (hint) {
    hint.textContent = muted
      ? '禁言中为 0；关掉禁言后按此值。'
      : '机身喇叭 0–100，保存后几秒生效。';
  }
};

function clampNum(raw, min, max, fallback) {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

window.saveRobotSettings = async function(opts = {}) {
  const quiet = !!opts.quiet;
  const enabled = document.getElementById('robot-enabled')?.checked ? '1' : '0';
  const characterId = String(document.getElementById('robot-character-id')?.value || '');
  const deviceName = String(document.getElementById('robot-device-name')?.value || 'Stack-chan').trim() || 'Stack-chan';
  const tts = document.getElementById('robot-tts')?.checked ? '1' : '0';
  const presence = document.getElementById('robot-presence')?.checked ? '1' : '0';
  const faceTrack = document.getElementById('robot-face-track')?.checked ? '1' : '0';
  const decayOn = document.getElementById('robot-decay-enabled')?.checked;
  let decaySec = Math.max(3, Math.min(120, parseInt(document.getElementById('robot-decay-sec')?.value || '12', 10) || 12));
  if (!decayOn) decaySec = 0;
  const drowsySec = Math.max(30, Math.min(1800, parseInt(document.getElementById('robot-drowsy-sec')?.value || '180', 10) || 180));
  try {
    let token = String(document.getElementById('robot-token')?.value || '').trim();
    if (enabled === '1' && !token) {
      const data = await api.regenerateRobotToken();
      token = data.token || '';
      const el = document.getElementById('robot-token');
      if (el) el.value = token;
    }
    const payload = {
      robot_enabled: enabled,
      robot_character_id: characterId,
      robot_device_name: deviceName,
      robot_tts: tts,
      robot_mute: document.getElementById('robot-mute')?.checked ? '1' : '0',
      robot_volume: String(Math.round(clampNum(document.getElementById('robot-volume')?.value, 0, 100, 70))),
      robot_screen_chat: '1',
      robot_sync_chat: document.getElementById('robot-sync-chat')?.checked ? '1' : '0',
      robot_presence_enabled: presence,
      robot_face_track_enabled: faceTrack,
      robot_led_enabled: document.getElementById('robot-led')?.checked ? '1' : '0',
      robot_led_max_brightness: String(clampNum(document.getElementById('robot-led-max')?.value, 0.05, 1, 1)),
      robot_pitch_center: String(Math.round(clampNum(document.getElementById('robot-pitch-center')?.value, 5, 85, 45))),
      robot_emotion_sense_enabled: document.getElementById('robot-emotion-sense')?.checked ? '1' : '0',
      robot_faceprint_enabled: document.getElementById('robot-faceprint')?.checked ? '1' : '0',
      robot_expression_decay_sec: String(decaySec),
      robot_drowsy_idle_sec: String(drowsySec),
      robot_tts_sample_rate: String(
        parseInt(document.getElementById('robot-tts-rate')?.value || '16000', 10) || 16000,
      ),
      robot_tts_volume: String(clampNum(document.getElementById('robot-tts-volume')?.value, 0.3, 2, 0.85)),
      robot_tts_speed: String(clampNum(document.getElementById('robot-tts-speed')?.value, 0.6, 1.6, 1)),
      robot_mcp_base_url: String(document.getElementById('robot-mcp-base')?.value || 'http://127.0.0.1:8766').trim().replace(/\/$/, '') || 'http://127.0.0.1:8766',
      robot_mcp_token: String(document.getElementById('robot-mcp-token')?.value || '').trim(),
      robot_control_mode: 'mcp',
    };
    const publicBase = normalizePublicBase(document.getElementById('robot-public-base')?.value);
    if (publicBase) {
      if (isLoopbackOrPrivateOrigin(publicBase)) {
        window.showToast?.('公网地址不要填 localhost 或局域网 IP，小机在别的网上连不上');
        return;
      }
      payload.robot_public_base_url = publicBase;
    } else {
      const cur = robotBaseUrl();
      payload.robot_public_base_url = (!isLoopbackOrPrivateOrigin(cur)) ? cur : '';
    }
    if (token) payload.robot_token = token;
    // bbtoy（啵啵贝）同页保存
    if (document.getElementById('toy-enabled')) {
      payload.toy_enabled = document.getElementById('toy-enabled')?.checked ? '1' : '0';
      payload.toy_electric = document.getElementById('toy-electric')?.checked ? '1' : '0';
      payload.toy_hr_follow = document.getElementById('toy-hr-follow')?.checked ? '1' : '0';
      payload.toy_feel_gentle = document.getElementById('toy-gentle')?.value || '20';
      payload.toy_feel_medium = document.getElementById('toy-medium')?.value || '45';
      payload.toy_feel_strong = document.getElementById('toy-strong')?.value || '70';
    }
    await api.saveSettings(payload);
    const s = window.getAppSettings?.();
    if (s) Object.assign(s, payload);
    if (!quiet) window.showToast?.('toy 设置已保存');
    window.syncOperatingBar?.();
    try { window.refreshChatDeviceLinks?.(); } catch {}
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.copyRobotToken = async function() {
  const token = String(document.getElementById('robot-token')?.value || '').trim();
  if (!token) {
    window.showToast?.('还没有令牌，请先生成');
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    window.showToast?.('已复制令牌');
  } catch {
    window.showToast?.('复制失败，请手动选中复制');
  }
};

window.copyRobotEndpoint = async function() {
  const text = String(document.getElementById('robot-endpoint')?.textContent || '').trim();
  try {
    await navigator.clipboard.writeText(text);
    window.showToast?.('已复制 API 地址');
  } catch {
    window.showToast?.('复制失败');
  }
};

function setRobotFaceStatus(msg) {
  const el = document.getElementById('robot-face-status');
  if (el) el.textContent = msg || '';
}

window.onRobotFaceFilePicked = async function(event) {
  const file = event?.target?.files?.[0];
  if (event?.target) event.target.value = '';
  if (!file) return;
  setRobotFaceStatus('读取中…');
  try {
    const text = await file.text();
    if (text.length > 8000) {
      setRobotFaceStatus(`太大：${text.length} 字节（上限约 8000）`);
      window.showToast?.('脸 JSON 太大');
      return;
    }
    JSON.parse(text);
    setRobotFaceStatus(`推送中（${text.length} 字节）…`);
    const data = await api.pushRobotFace(text);
    setRobotFaceStatus(`已入队 #${data.commandId || '?'}，${data.bytes || text.length} 字节。连着机身时会自动换。`);
    window.showToast?.('脸已排队推送');
  } catch (e) {
    setRobotFaceStatus(e.message || '导入失败');
    window.showToast?.(e.message || '导入失败');
  }
};

window.resetRobotFace = async function() {
  if (!confirm('恢复固件内置脸？机身上的自定义脸会被清掉。')) return;
  setRobotFaceStatus('恢复中…');
  try {
    const data = await api.resetRobotFace();
    setRobotFaceStatus(`已入队恢复 #${data.commandId || '?'}`);
    window.showToast?.('已排队恢复内置脸');
  } catch (e) {
    setRobotFaceStatus(e.message || '失败');
    window.showToast?.(e.message || '失败');
  }
};

window.regenerateRobotToken = async function() {
  if (!confirm('重新生成后，旧令牌立刻失效。设备里要改成新令牌。继续？')) return;
  try {
    const data = await api.regenerateRobotToken();
    const el = document.getElementById('robot-token');
    if (el) el.value = data.token || '';
    window.showToast?.('已生成新令牌，请点保存（令牌已写入服务器）');
  } catch (e) {
    window.showToast?.(e.message || '生成失败');
  }
};

window.testRobotChat = async function() {
  const out = document.getElementById('robot-test-out');
  const input = document.getElementById('robot-test-input');
  const text = String(input?.value || '').trim();
  if (!text) {
    window.showToast?.('先写一句试试');
    return;
  }
  if (out) out.textContent = '等待角色回复…';
  try {
    // 试聊前自动保存当前表单，避免忘开开关
    await window.saveRobotSettings?.();
    const data = await api.robotChat({
      text,
      withTts: false,
    });
    if (data.emotion || data.motion) applyRobotFacePreview(data);
    const bits = [
      data.reply || data.speak || '（空回复）',
      data.emotion ? `表情:${data.emotion}` : '',
      data.motion ? `动作:${data.motion}` : '',
    ].filter(Boolean);
    if (out) {
      out.innerHTML = `
        <div class="robot-test-result">
          <div>${escapeHtml(bits.join(' · '))}</div>
        </div>
      `;
    }
  } catch (e) {
    if (out) out.textContent = e.message || '试聊失败';
    window.showToast?.(e.message || '试聊失败');
  }
};

window.previewRobotOperating = async function(on) {
  const charId = document.getElementById('robot-character-id')?.value || '';
  if (!charId) {
    window.showToast?.('请先选择角色');
    return;
  }
  try {
    await api.setCharacterRobotOperating(charId, !!on);
    window.showToast?.(on ? '已进入操纵中，去聊天页看看' : '已结束操纵');
  } catch (e) {
    window.showToast?.(e.message || '切换失败');
  }
};

/* ===== 设置页 ===== */
import * as api from '../api.js';
import { resolveApiUrl, getSiteSessionToken, isNativeShell } from '../server-config.js';
import { escapeHtml } from '../memory.js';
import { ICON_IMPORT, ICON_EXPORT } from '../ui-icons.js';
import { promptAppUpdateIfNeeded, getNativeAppVersion } from '../app-update.js';
import { requestNativeMicrophone } from '../app-permissions.js';
import { getLocalArchiveStats, clearAllThreadCaches } from '../chat-thread-cache.js';
import { clearMediaCache } from '../chat-media-cache.js';
import { refreshCallSfxMix } from '../tts.js';

function sfxPct(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function sfxVolSlider(id, label, value, { min = 0, max = 100 } = {}) {
  const v = sfxPct(value, 0);
  return `
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
              <div class="settings-row-label">${label}</div>
              <span id="${id}-val" style="font-size:12px;color:var(--text-secondary);flex-shrink:0">${v}</span>
            </div>
            <input type="range" id="${id}" min="${min}" max="${max}" value="${v}"
              style="width:100%;accent-color:var(--theme)" oninput="previewSfxMix()">
          </div>`;
}

function readSfxMixFromForm() {
  return {
    sfx_vol_scene: String(sfxPct(document.getElementById('s-sfx-vol-scene')?.value, 100)),
    sfx_vol_oneshot: String(sfxPct(document.getElementById('s-sfx-vol-oneshot')?.value, 70)),
    sfx_vol_close: String(sfxPct(document.getElementById('s-sfx-vol-close')?.value, 32)),
    sfx_vol_duck: String(sfxPct(document.getElementById('s-sfx-vol-duck')?.value, 88)),
    sfx_vol_call_voice: String(sfxPct(document.getElementById('s-sfx-vol-call-voice')?.value, 115)),
  };
}

window.previewSfxMix = function() {
  const mix = readSfxMixFromForm();
  for (const [id, key] of [
    ['s-sfx-vol-scene', 'sfx_vol_scene'],
    ['s-sfx-vol-oneshot', 'sfx_vol_oneshot'],
    ['s-sfx-vol-close', 'sfx_vol_close'],
    ['s-sfx-vol-duck', 'sfx_vol_duck'],
    ['s-sfx-vol-call-voice', 'sfx_vol_call_voice'],
  ]) {
    const el = document.getElementById(`${id}-val`);
    if (el) el.textContent = mix[key];
  }
  const live = window.getAppSettings?.();
  if (live && typeof live === 'object') Object.assign(live, mix);
  try { refreshCallSfxMix(); } catch {}
};

let _settingsTab = 'settings';
let _beautifyEmbedded = false;

window.initSettingsPage = async function() {
  _beautifyEmbedded = false;
  const page = document.getElementById('settings-page');
  let settings = {};
  try { settings = await api.getSettings(); } catch {}

  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">⚙️ 设置</div>
      <button type="button" class="topbar-save" onclick="saveAllSettings()" title="保存"></button>
    </div>
    <div id="backend-health-banner" class="backend-health-banner" style="display:none"></div>

    <div class="settings-tab-bar">
      <div id="stab-settings" class="settings-tab" onclick="switchSettingsTab('settings')">⚙️ 设置</div>
      <div id="stab-beautify" class="settings-tab" onclick="switchSettingsTab('beautify')">🎨 美化</div>
    </div>

    <div id="settings-panel-settings" class="scroll-area scroll-area-native" style="padding:0 0 20px">
      <div class="settings-section" id="s-native-app-section" style="display:none">
        <div class="settings-section-title">App</div>
        <div class="settings-group">
          <div class="list-item" id="s-native-server-row" onclick="openServerConfigEditor()">
            <div>App 服务器地址</div>
            <span style="color:var(--text-secondary)">›</span>
          </div>
          <div class="list-item" id="s-native-update-row" onclick="checkNativeAppUpdate()">
            <div>
              <div>检查更新</div>
              <div class="settings-row-sub" id="s-native-update-ver" style="display:none">当前版本</div>
            </div>
            <span style="color:var(--text-secondary)">›</span>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">时间与时区</div>
        <div class="settings-group">
          <div class="settings-row" style="align-items:center;gap:10px">
            <div class="settings-row-label" style="flex:1">
              <div>全局时区</div>
              <div class="settings-row-sub">日记补齐、定时任务、备忘录等默认按这个算「今天」。单个角色可在通讯设置里单独改。</div>
            </div>
            <select class="input" id="s-timezone" style="width:170px">
              ${[
                ['Asia/Shanghai', '上海 UTC+8'],
                ['Asia/Tokyo', '东京 UTC+9'],
                ['Asia/Seoul', '首尔 UTC+9'],
                ['America/New_York', '纽约'],
                ['America/Los_Angeles', '洛杉矶'],
                ['Europe/London', '伦敦'],
                ['Europe/Paris', '巴黎'],
              ].map(([v, label]) =>
                `<option value="${v}" ${(settings.timezone || 'Asia/Shanghai') === v ? 'selected' : ''}>${label}</option>`
              ).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">API 配置方案</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:10px">
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.55">
              保存当前所有 API 填写的 URL / Key / 模型，方便多套配置一键切换（如国内中转 / 官方 OpenAI）。下拉框已选中某套、或名称与已有方案相同时，再点「保存当前配置」会覆盖原方案。
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <select class="input" id="s-api-preset-select" style="flex:1;min-width:140px" onchange="onApiPresetSelectChange(this.value)">
                <option value="">— 选择已保存方案 —</option>
              </select>
              <button class="btn btn-primary btn-sm" type="button" onclick="applySelectedApiPreset()">切换</button>
              <button class="btn btn-ghost btn-sm" type="button" onclick="deleteSelectedApiPreset()">删除</button>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <input class="input" id="s-api-preset-name" placeholder="方案名称，如：80ai 全套" style="flex:1;min-width:160px">
              <button class="btn btn-ghost btn-sm" type="button" onclick="saveNamedApiPreset()">保存当前配置</button>
            </div>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">聊天 API</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px;gap:8px">
            <label class="input-label">Base URL</label>
            <input class="input" id="s-chat-url" value="${escapeHtml(settings.chat_api_url||'')}" placeholder="https://api.openai.com/v1">
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px;gap:8px">
            <label class="input-label">API Key</label>
            <input class="input" id="s-chat-key" type="password" value="${escapeHtml(settings.chat_api_key||'')}" placeholder="sk-…">
          </div>
          <div class="settings-row" style="flex-wrap:wrap;gap:8px">
            <span class="settings-row-label">模型</span>
            <div style="display:flex;gap:6px;align-items:center;flex:1;min-width:180px">
              <input class="input" id="s-model" value="${escapeHtml(settings.chat_model||'gpt-4o')}" style="flex:1;min-width:120px" list="s-model-list">
              <datalist id="s-model-list"></datalist>
              <button class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="fetchModels()">获取模型</button>
              <button class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="checkApiBalance('chat')">查余额</button>
            </div>
          </div>
          <div class="settings-row">
            <span class="settings-row-label">Temperature</span>
            <input type="number" class="input" id="s-temp" value="${settings.chat_temperature||'0.8'}" min="0" max="2" step="0.1" style="width:80px">
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">后台任务 API（与聊天分离）</div>
        <div class="settings-group">
          <div class="settings-row" style="padding:12px 16px 4px">
            <span class="settings-row-label" style="font-size:12px;color:var(--text-secondary);line-height:1.6">
              记忆总结、情景捕获、日记生成等后台任务走这里，<strong>不会占用聊天 API 配额</strong>。填好后与聊天 API 完全分开；不填则继承聊天 API。
            </span>
          </div>
          ${['memory','diary','dream'].map(type => `
            <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
              <div style="display:flex;justify-content:space-between;align-items:center;width:100%;margin-bottom:2px">
                <label class="input-label" style="margin:0">${{memory:'🧠 记忆专用',diary:'📔 日记生成',dream:'🌙 梦境'}[type]}</label>
                <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="fetchModelsForType('${type}')">获取模型</button>
                <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="checkApiBalance('${type}')">查余额</button>
              </div>
              <input class="input" id="s-${type}-url" value="${escapeHtml(settings[type+'_api_url']||'')}" placeholder="Base URL（选填）" style="margin-bottom:4px">
              <input class="input" id="s-${type}-key" type="password" value="${escapeHtml(settings[type+'_api_key']||'')}" placeholder="API Key（选填）">
              <div style="display:flex;gap:6px;align-items:center;width:100%">
                <input class="input" id="s-${type}-model" value="${escapeHtml(settings[type+'_model']||'')}" placeholder="模型（选填，建议用小模型省 token）" list="s-${type}-model-list" style="flex:1">
                <datalist id="s-${type}-model-list"></datalist>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">向量 API（全项目）</div>
        <div class="settings-group">
          <div class="settings-row" style="padding:12px 16px 4px">
            <span class="settings-row-label" style="font-size:12px;color:var(--text-secondary);line-height:1.6">
              日常记忆检索、长期叙事卷、穿越剧情记忆<strong>共用这一套</strong> embeddings 接口。可与聊天走不同中转；留空则回退聊天 API。中转不支持 <code>/embeddings</code> 时自动用本地词法，不影响聊天。
            </span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <div style="display:flex;justify-content:space-between;align-items:center;width:100%;margin-bottom:2px">
              <label class="input-label" style="margin:0">🧬 向量模型</label>
              <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="fetchModelsForType('embed')">获取模型</button>
              <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="checkApiBalance('embed')">查余额</button>
            </div>
            <input class="input" id="s-embed-url" value="${escapeHtml(settings.embed_api_url || settings.series_embed_api_url || '')}" placeholder="Base URL（选填，留空用聊天 API）" style="margin-bottom:4px">
            <input class="input" id="s-embed-key" type="password" value="${escapeHtml(settings.embed_api_key || settings.series_embed_api_key || '')}" placeholder="API Key（选填）" style="margin-bottom:4px">
            <input class="input" id="s-embed-model" value="${escapeHtml(settings.embed_model || settings.series_embed_model || '')}" placeholder="向量模型名，如 text-embedding-3-small" list="s-embed-model-list">
            <datalist id="s-embed-model-list"></datalist>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">时空 API（独立）</div>
        <div class="settings-group">
          <div class="settings-row" style="padding:12px 16px 4px">
            <span class="settings-row-label" style="font-size:12px;color:var(--text-secondary);line-height:1.6">
              剧集与穿越<strong>只走这里</strong>，不回退聊天 API。可拆两个模型：大纲/总结走按量，游玩正文走按次；只填「通用模型」时两者都用它。向量检索请到上方「向量 API（全项目）」。
            </span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <div style="display:flex;justify-content:space-between;align-items:center;width:100%;margin-bottom:2px">
              <label class="input-label" style="margin:0">🌌 时空（剧集 / 穿越）</label>
              <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="fetchModelsForType('series')">获取模型</button>
              <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="checkApiBalance('series')">查余额</button>
            </div>
            <input class="input" id="s-series-url" value="${escapeHtml(settings.series_api_url||'')}" placeholder="Base URL（必填）" style="margin-bottom:4px">
            <input class="input" id="s-series-key" type="password" value="${escapeHtml(settings.series_api_key||'')}" placeholder="API Key（必填）">
            <div style="display:flex;gap:6px;align-items:center;width:100%">
              <input class="input" id="s-series-model" value="${escapeHtml(settings.series_model||'')}" placeholder="通用模型（必填其一）" list="s-series-model-list" style="flex:1">
              <datalist id="s-series-model-list"></datalist>
            </div>
            <div style="display:flex;gap:6px;align-items:center;width:100%;margin-top:4px">
              <input class="input" id="s-series-outline-model" value="${escapeHtml(settings.series_outline_model||'')}" placeholder="大纲槽（按量：大纲/定角/总结）" list="s-series-model-list" style="flex:1">
            </div>
            <div style="display:flex;gap:6px;align-items:center;width:100%">
              <input class="input" id="s-series-play-model" value="${escapeHtml(settings.series_play_model||'')}" placeholder="游玩槽（按次：开章与每回合正文）" list="s-series-model-list" style="flex:1">
            </div>
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">
              大纲槽空 → 用通用模型；游玩槽空 → 用通用模型。
            </span>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">MiniMax 语音</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">API Key</label>
            <input class="input" id="s-minimax-key" type="password" value="${escapeHtml(settings.minimax_api_key||'')}" placeholder="MiniMax API Key">
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">API Base URL（可选）</label>
            <input class="input" id="s-minimax-url" value="${escapeHtml(settings.minimax_api_url||'')}" placeholder="留空自动；断连时可试 https://api.minimaxi.com">
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">
              国内 Key（minimax.chat / minimaxi.com）与国际 Key（minimax.io）不通用。其他软件能用时，看它的 Base URL 填在这里。
            </span>
          </div>
          <div class="settings-row">
            <span class="settings-row-label">Group ID</span>
            <input class="input" id="s-minimax-group" value="${escapeHtml(settings.minimax_group_id||'')}" placeholder="国内账号必填，19 位数字" style="width:200px">
          </div>
          <div class="settings-row" style="flex-wrap:wrap;gap:8px">
            <span class="settings-row-label">语音合成模型</span>
            <div style="display:flex;gap:6px;align-items:center;flex:1;min-width:160px">
              <input class="input" id="s-minimax-model" value="${escapeHtml(settings.minimax_model||'speech-02-hd')}"
                style="flex:1;min-width:100px" list="s-minimax-model-list">
              <datalist id="s-minimax-model-list">
                <option value="speech-2.8-hd">
                <option value="speech-2.8-turbo">
                <option value="speech-2.6-hd">
                <option value="speech-2.6-turbo">
                <option value="speech-02-hd">
                <option value="speech-02-turbo">
                <option value="speech-01-hd">
                <option value="speech-01-turbo">
                <option value="speech-01-240228">
              </datalist>
              <button class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="fetchMinimaxModels()">获取模型</button>
            </div>
            <span style="font-size:11px;color:var(--text-secondary);padding:0 16px 8px;display:block">
              须填语音模型（speech- 开头），勿填聊天模型如 MiniMax-M2.1-highspeed
            </span>
          </div>
          <div class="settings-row" style="gap:8px;flex-wrap:wrap;padding:12px 16px">
            <input class="input" id="s-minimax-test-voice" placeholder="测试用声音 ID" style="flex:1;min-width:140px">
            <button class="btn btn-ghost btn-sm" onclick="testMinimaxTts()">测试语音</button>
            <span id="minimax-test-result" style="font-size:12px;color:var(--text-secondary);flex:1;min-width:120px"></span>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">ElevenLabs 环境音效</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">API Key</label>
            <input class="input" id="s-elevenlabs-key" type="password" value="${escapeHtml(settings.elevenlabs_api_key||'')}" placeholder="sk_… ElevenLabs API Key">
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">
              环境音和角色演奏共用此 Key。申请：
              <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener">elevenlabs.io/app/settings/api-keys</a>
              创建 Key 时若选了 Restrict，勾选 Sound Effects（Text to Sound Effects）；选 All 不用再点。
            </span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">API Base URL（可选）</label>
            <input class="input" id="s-elevenlabs-url" value="${escapeHtml(settings.elevenlabs_api_url||'')}" placeholder="留空即 https://api.elevenlabs.io">
          </div>
          <div class="settings-row" style="gap:8px;flex-wrap:wrap;padding:12px 16px">
            <input class="input" id="s-sfx-test-prompt" placeholder="测试描述，如 ocean wind and waves" style="flex:1;min-width:160px">
            <button class="btn btn-ghost btn-sm" type="button" onclick="testElevenlabsSfx()">测试音效</button>
            <span id="sfx-test-result" style="font-size:12px;color:var(--text-secondary);flex:1;min-width:120px"></span>
          </div>
          <div class="settings-row settings-row--stack">
            <div class="settings-row-sub" style="line-height:1.55">
              听筒里三类声音分开拧。0 即关掉。现场环境会按场合再分吵静（夜市比卧室响）；贴身声是黏液、布料那种贴近听筒的摩擦，通话里不出现气泡。
            </div>
          </div>
          ${sfxVolSlider('s-sfx-vol-scene', '现场环境', sfxPct(settings.sfx_vol_scene, 100))}
          ${sfxVolSlider('s-sfx-vol-oneshot', '一次性音效', sfxPct(settings.sfx_vol_oneshot, 70))}
          ${sfxVolSlider('s-sfx-vol-close', '贴身声', sfxPct(settings.sfx_vol_close, 32))}
          ${sfxVolSlider('s-sfx-vol-duck', '说话时还留多少', sfxPct(settings.sfx_vol_duck, 88))}
          ${sfxVolSlider('s-sfx-vol-call-voice', '通话角色声音（100=系统音量；觉得小就拉大，最大 200）', sfxPct(settings.sfx_vol_call_voice, 115), { min: 50, max: 200 })}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">用户声纹</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:8px">
            <span id="s-voiceprint-status" style="font-size:13px;color:var(--text-secondary);line-height:1.5">加载中…</span>
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">
              录入你的说话声后，手机发语音和桌上小机听声都会本地比对是不是你。比对上了角色才会认；对不上或不够确定不会假装是你。建议用自己的声音录 2～3 段、每段说几句话。
            </span>
          </div>
          <div class="settings-row" style="gap:8px;flex-wrap:wrap;padding:12px 16px">
            <button type="button" class="btn btn-ghost btn-sm" id="s-voiceprint-rec-btn" onclick="toggleVoiceprintRecord()">开始录音</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="enrollVoiceprintSamples()">录入声纹</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="clearVoiceprintLibrary()">清除</button>
            <span id="s-voiceprint-rec-hint" style="font-size:12px;color:var(--text-secondary);flex:1;min-width:120px"></span>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">图像生成（文生图）</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">Base URL</label>
            <input class="input" id="s-img-url" value="${escapeHtml(settings.image_api_url||'')}" placeholder="如：https://api.80ai.net 或 https://linkapi.ai/v1">
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">
              用于<strong>聊天配图 AI 生成</strong>、无参考图时的文生图。<strong>带形象参考图的自拍</strong>请用下方「图生图 API」。<br>
              聊天配图若本栏失败，会自动用下方「图生图」的 URL/Key 再试一轮纯文生图（不带参考图）。<br>
              朋友圈配图默认走 Unsplash、配视频默认走 Pexels，可在下方图库/视频库栏关闭开关改走 AI 生成。<br>
              <strong>80ai</strong> 填 <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">https://api.80ai.net</code>（无需 /v1）。网站名与 ID：Image 2 高质量 → <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">gptimage2_medium</code>。
            </span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">API Key</label>
            <div style="display:flex;gap:6px;align-items:center;width:100%">
              <input class="input" id="s-img-key" type="password" value="${escapeHtml(settings.image_api_key||'')}" placeholder="API Key" style="flex:1">
              <button class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="checkApiBalance('img')">查余额</button>
            </div>
          </div>
          <div class="settings-row" style="flex-wrap:wrap;gap:8px">
            <span class="settings-row-label">生图模型</span>
            <div style="display:flex;gap:6px;align-items:center;flex:1;min-width:180px">
              <input class="input" id="s-img-model" value="${escapeHtml(settings.image_model||'')}" placeholder="80ai: gptimage2_medium" style="flex:1" list="s-img-model-list">
              <datalist id="s-img-model-list"></datalist>
              <button class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="fetchModelsForImage()">获取模型</button>
            </div>
          </div>
          <div class="settings-row" style="flex-wrap:wrap;gap:8px">
            <span class="settings-row-label">生视频模型</span>
            <div style="display:flex;gap:6px;align-items:center;flex:1;min-width:180px">
              <input class="input" id="s-video-model" value="${escapeHtml(settings.video_model||'')}" placeholder="80ai: veo3_fast / kling-v2-master（留空自动尝试）" style="flex:1">
            </div>
          </div>
          <div class="settings-row" style="gap:8px;flex-wrap:wrap;padding:12px 16px">
            <button class="btn btn-ghost btn-sm" onclick="testImageApi()">测试文生图</button>
            <span id="img-test-result" style="font-size:12px;color:var(--text-secondary);flex:1;min-width:120px"></span>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">图生视频（角色形象参考）</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">Base URL</label>
            <input class="input" id="s-img2video-url" value="${escapeHtml(settings.img2video_api_url||'')}" placeholder="https://任意中转/v1">
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">
              聊天「配视频：」且角色有<strong>形象参考图</strong>时走这里。<br>
              流程：先用<strong>图生图</strong>按场景画一张新构图静图 → 再交给图生视频，这张静图作为<strong>起始帧</strong>。<br>
              填任意中转 Base URL 即可，系统会按地址和模型自动适配协议（对不上会换一种再试）：<br>
              · HiAPI 兼容：<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">/v1/tasks</code>，如 <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">https://api.hiapi.ai/v1</code>，模型 <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">kling-3.0-omni/image-to-video</code> / <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">veo-3.1/image-to-video</code><br>
              · OpenAI 兼容：<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">/v1/videos</code>（Sora / API易 等）<br>
              ⚠️ 请同时配好上方「图生图 API」。手机网页或局域网打开时，静图会内嵌 base64。换 Kling / Veo / Wan / Seedance / Sora 等会自动适配入参。
            </span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">API Key</label>
            <div style="display:flex;gap:6px;align-items:center;width:100%">
              <input class="input" id="s-img2video-key" type="password" value="${escapeHtml(settings.img2video_api_key||'')}" placeholder="中转站 API Key" style="flex:1">
              <button class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="checkApiBalance('img2video')">查余额</button>
            </div>
          </div>
          <div class="settings-row" style="flex-wrap:wrap;gap:8px">
            <span class="settings-row-label">图生视频模型</span>
            <div style="display:flex;gap:6px;align-items:center;flex:1;min-width:180px">
              <input class="input" id="s-img2video-model" value="${escapeHtml(settings.img2video_model||'kling-3.0-omni/image-to-video')}" placeholder="kling-3.0-omni/image-to-video" style="flex:1" list="s-img2video-model-list">
              <datalist id="s-img2video-model-list"></datalist>
              <button class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="fetchModelsForImg2Video()">获取模型</button>
            </div>
          </div>
          <div class="settings-row" style="flex-wrap:wrap;gap:8px">
            <span class="settings-row-label">时长（秒）</span>
            <select class="input" id="s-img2video-seconds" style="width:120px">
              ${['2','3','4','5','6','8','10','12','15'].map(s => `<option value="${s}" ${(settings.img2video_seconds||'5')===s?'selected':''}>${s}</option>`).join('')}
            </select>
            <span style="font-size:11px;color:var(--text-secondary)">可选 2–15 秒。会按模型自动对齐：Kling 最短 3，Veo 仅 4/6/8，Seedance 最短 4，Hera 仅 5/10/15，Zeus 仅 5/8。默认 5。</span>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <div>强制去掉全部音轨</div>
              <div class="settings-row-sub">默认关。平时靠提示词「只要环境音、不要人声」；若仍冒出怪嗓音再打开此项（ffmpeg 全静音）</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="s-img2video-strip-audio" ${settings.img2video_strip_audio === '1' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row" style="gap:8px;flex-wrap:wrap;padding:12px 16px">
            <button class="btn btn-ghost btn-sm" onclick="testImg2VideoApi()">测试图生视频</button>
            <span id="img2video-test-result" style="font-size:12px;color:var(--text-secondary);flex:1;min-width:120px"></span>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">图生图（自拍 / 形象参考）</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">Base URL</label>
            <input class="input" id="s-img2img-url" value="${escapeHtml(settings.img2img_api_url||'')}" placeholder="如：https://任意中转/v1">
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">
              角色上传「形象参考图」后发自拍走这里。填任意中转 Base URL，系统会自动识别协议（对不上会换一种再试）：<br>
              · OpenAI 兼容：<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">/v1/images/edits</code>，如 TinySnow <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">https://tinysnow.one/v1</code>，模型 <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">gpt-image-2</code><br>
              · HiAPI 兼容：<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">/v1/tasks</code>，如 <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">https://api.hiapi.ai/v1</code>。自拍可用 <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">Nano-Banana-2</code> / <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">gpt-image-2/image-to-image</code> / <code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">seedream-5.0-lite/image-to-image</code>。经典 Nano-Banana 不支持参考图。<br>
              · 80ai：<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px">https://api.80ai.net</code><br>
              本机/局域网时 OpenAI / HiAPI 会把参考图转成 base64 内嵌，无需公网域名。
            </span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">API Key</label>
            <div style="display:flex;gap:6px;align-items:center;width:100%">
              <input class="input" id="s-img2img-key" type="password" value="${escapeHtml(settings.img2img_api_key||'')}" placeholder="中转站 API Key" style="flex:1">
              <button class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="checkApiBalance('img2img')">查余额</button>
            </div>
          </div>
          <div class="settings-row" style="flex-wrap:wrap;gap:8px">
            <span class="settings-row-label">图生图模型</span>
            <div style="display:flex;gap:6px;align-items:center;flex:1;min-width:180px">
              <input class="input" id="s-img2img-model" value="${escapeHtml(settings.img2img_model||'gpt-image-2')}" placeholder="gpt-image-2 或 gpt-image-2/image-to-image" style="flex:1" list="s-img2img-model-list">
              <datalist id="s-img2img-model-list"></datalist>
              <button class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="fetchModelsForImg2Img()">获取模型</button>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <div>聊天自拍走图生图</div>
              <div class="settings-row-sub">开启：有形象参考图 → 本区图生图 API；无参考图 → 上方文生图。关闭：只从「相册·拍自己」取图</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="s-selfie-api" ${settings.selfie_api_enabled !== '0' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Unsplash 图库</div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row-label">
              <div>朋友圈配图用图库</div>
              <div class="settings-row-sub">开：配图从 Unsplash 图库搜图（本栏）。关：改走上方「图像生成（文生图）」AI 画一张</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="s-moments-image-gallery" ${settings.moments_image_gallery !== '0' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">Access Key</label>
            <input class="input" id="s-unsplash-key" type="password" value="${escapeHtml(settings.unsplash_api_key||'')}" placeholder="Unsplash API Access Key">
            <div style="font-size:12px;color:var(--text-secondary)">朋友圈发动态配图时自动搜图。聊天「配图：」走上方图像 API。免费注册：<a href="https://unsplash.com/developers" target="_blank" style="color:var(--theme)">unsplash.com/developers</a></div>
          </div>
          <div class="settings-row" style="gap:8px;flex-wrap:wrap;padding:12px 16px">
            <button class="btn btn-ghost btn-sm" onclick="testUnsplashApi()">测试 Unsplash</button>
            <span id="unsplash-test-result" style="font-size:12px;color:var(--text-secondary);flex:1"></span>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Pexels 视频库</div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row-label">
              <div>朋友圈配视频用视频库</div>
              <div class="settings-row-sub">开：配视频从 Pexels 视频库搜短视频（本栏）。关：先用上方「图像生成」文生图出一张静图，再用「图生视频」把它做成短片</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="s-moments-video-gallery" ${settings.moments_video_gallery !== '0' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">API Key</label>
            <input class="input" id="s-pexels-key" type="password" value="${escapeHtml(settings.pexels_api_key||'')}" placeholder="Pexels API Key">
            <div style="font-size:12px;color:var(--text-secondary)">朋友圈发动态配视频时自动搜短视频。聊天有形象参考时优先「图生视频」；否则走上方文生视频。免费注册：<a href="https://www.pexels.com/api/" target="_blank" style="color:var(--theme)">pexels.com/api</a></div>
          </div>
          <div class="settings-row" style="gap:8px;flex-wrap:wrap;padding:12px 16px">
            <button class="btn btn-ghost btn-sm" onclick="testPexelsApi()">测试 Pexels</button>
            <span id="pexels-test-result" style="font-size:12px;color:var(--text-secondary);flex:1"></span>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">数据管理</div>
        <div class="settings-group">
          <div class="list-item" onclick="doFullBackup()" style="background:var(--theme-light)">
            <span style="font-weight:500;color:var(--theme-dark)">📦 一键完整备份</span>
            <span style="color:var(--theme)">推荐</span>
          </div>
          <div style="padding:8px 16px 12px;font-size:12px;color:var(--text-secondary);line-height:1.6">
            卸载 App 不会丢掉 VPS 上的记忆、角色和聊天正文。过期语音/图片可能只留在这台手机，卸了就没了，重要的先做备份。完整备份含角色/聊天/记忆/圈子/群聊/贴吧/清单等 + 手机聊天归档；相册原图仍在服务器 <code style="font-size:11px">backend/uploads/</code>。
          </div>
          <div id="vps-store-status" style="padding:0 16px 12px;font-size:12px;color:var(--text-secondary);line-height:1.65">正在统计存储…</div>
          <div class="list-item" onclick="openExportPanel()">
            <span style="display:flex;align-items:center;gap:10px"><span class="list-item-icon">${ICON_EXPORT}</span>自定义导出</span>
            <span style="color:var(--text-secondary)">›</span>
          </div>
          <div class="list-item" onclick="importData()">
            <span style="display:flex;align-items:center;gap:10px"><span class="list-item-icon">${ICON_IMPORT}</span>导入数据</span>
            <span style="color:var(--text-secondary)">›</span>
          </div>
          <div class="list-item" onclick="clearDataPrompt('memories')"><span style="color:#e05555">清除记忆</span></div>
          <div class="list-item" onclick="clearDataPrompt('diaries')"><span style="color:#e05555">清除日记与信件</span></div>
          <div class="list-item" onclick="clearDataPrompt('cache')"><span style="color:#e05555">清除今日动态缓存</span></div>
          <div class="list-item" onclick="clearDataPrompt('all')"><span style="color:#e05555">清除全部内容</span></div>
          <div style="padding:0 16px 12px;font-size:11px;color:var(--text-secondary);line-height:1.55">
            「清除全部内容」会删角色、聊天、记忆、圈子、群聊、贴吧等，但保留 API 设置与预设。
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">GitHub 备份</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">GitHub Token</label>
            <input class="input" id="s-github-token" type="password" value="${escapeHtml(settings.github_token||'')}" placeholder="ghp_…">
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:6px">
            <label class="input-label">私有仓库（user/repo）</label>
            <input class="input" id="s-github-repo" value="${escapeHtml(settings.github_repo||'')}" placeholder="username/nian-backup">
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">Token 需要 <code>repo</code> 权限。在中国大陆服务器上需挂代理才能访问 GitHub。</div>
          </div>
          <div class="settings-row" style="gap:8px;flex-wrap:wrap;padding:12px 16px">
            <button class="btn btn-ghost btn-sm" onclick="doGithubBackup()">☁️ 立即备份到 GitHub</button>
            <span id="github-backup-result" style="font-size:12px;color:var(--text-secondary);flex:1;min-width:120px"></span>
          </div>
        </div>
      </div>

      <input type="file" id="import-file-input" accept=".json" style="display:none" onchange="handleImport(event)">
    </div>

    <div id="settings-panel-beautify" class="scroll-area" style="padding:0 0 24px;display:none"></div>
    <div id="export-overlay" class="overlay center" onclick="this.classList.remove('active')">
      <div class="modal" style="width:calc(100% - 32px);max-width:400px" onclick="event.stopPropagation()">
        <div class="modal-title">导出数据</div>
        <div class="modal-body">
          <div id="export-checkboxes">
            ${[
              ['characters', '角色 / 相册 / 衣橱 / 好友 / 清单'],
              ['messages', '聊天记录 / 通话'],
              ['memories', '记忆 / 人格 / 行程 / 情绪'],
              ['diaries', '日记 / 秘密 / 备忘录 / 信件'],
              ['moments', '朋友圈'],
              ['worldbook', '世界书'],
              ['presets', '预设'],
              ['settings', '设置'],
              ['series', '剧集'],
              ['emoji', '表情'],
              ['circles', '圈子 / NPC'],
              ['group_chats', '群聊'],
              ['tieba', '贴吧'],
              ['music', '一起听歌状态'],
            ].map(([t, label]) => `
              <label style="display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer">
                <input type="checkbox" checked data-export-type="${t}" style="width:16px;height:16px">
                <span style="font-size:14px">${label}</span>
              </label>
            `).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('export-overlay').classList.remove('active')">取消</button>
          <button class="btn btn-primary btn-sm" onclick="doExport()">导出</button>
        </div>
      </div>
    </div>
  `;

  const appSection = document.getElementById('s-native-app-section');
  if (appSection && window.isNativeShell?.()) {
    appSection.style.display = '';
    try {
      const v = await getNativeAppVersion();
      const el = document.getElementById('s-native-update-ver');
      if (el && v.versionName) {
        el.style.display = '';
        el.textContent = `当前 ${v.versionName}（${v.versionCode}）`;
      }
    } catch {}
  }
  const toySection = document.getElementById('s-toy-section');
  if (toySection) toySection.style.display = 'none';

  await updateBackendHealthBanner();
  _apiConfigPresets = parseApiPresets(settings.api_config_presets);
  renderApiPresetSelect(settings.active_api_preset || '');
  refreshVoiceprintStatusUi(settings.voiceprint);

  const initTab = window._settingsInitTab || 'settings';
  window._settingsInitTab = null;
  switchSettingsTab(initTab, true);
};

function formatStoreBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / (1024 * 1024)).toFixed(1)} MB`;
}

async function fillVpsStoreStatus() {
  const el = document.getElementById('vps-store-status');
  if (!el) return;
  try {
    const [remote, local] = await Promise.all([
      api.getStorePolicy().catch(() => null),
      getLocalArchiveStats().catch(() => ({ threads: 0, messages: 0 })),
    ]);
    if (!remote) {
      el.textContent = `手机已归档 ${local.messages || 0} 条聊天。暂时读不到 VPS 用量。`;
      return;
    }
    const p = remote.policy || {};
    const up = remote.uploads || {};
    el.innerHTML = `VPS 数据库 ${formatStoreBytes(remote.dbBytes)} · 上传文件 ${formatStoreBytes(up.bytes)}（${up.files || 0} 个）· 备份 ${formatStoreBytes(remote.backups?.bytes)}<br>`
      + `服务器还留着 ${remote.messages || 0} 条近窗聊天、${remote.memories || 0} 条记忆。手机已归档 ${local.messages || 0} 条（${local.threads || 0} 个会话）。<br>`
      + `聊天正文留在 VPS（卸载 App 也不会丢）。过期语音图片约 ${p.keepChatMediaDays || 12} 天后可从服务器删，请先备份。`;
  } catch {
    el.textContent = '存储统计失败';
  }
}

window.checkNativeAppUpdate = function() {
  promptAppUpdateIfNeeded({ force: true });
};

function encodePcmWav16(float32, sampleRate) {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function downsampleMono(input, inRate, outRate) {
  if (!input?.length) return new Float32Array(0);
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const frac = x - i0;
    const a = input[i0] || 0;
    const b = input[i0 + 1] || a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

async function recordingBlobToWavFile(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('当前环境无法转 WAV');
  const ctx = new Ctx();
  try {
    const raw = await blob.arrayBuffer();
    const audio = await ctx.decodeAudioData(raw.slice(0));
    const len = audio.length;
    const chs = Math.max(1, audio.numberOfChannels);
    const mono = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / chs;
    }
    const pcm = downsampleMono(mono, audio.sampleRate, 16000);
    const wav = encodePcmWav16(pcm, 16000);
    return new File([wav], `voiceprint-${Date.now()}.wav`, { type: 'audio/wav' });
  } finally {
    try { await ctx.close(); } catch {}
  }
}

function formatVoiceprintLast(last) {
  if (!last?.result) return '发语音或对小机说话后，这里会显示上次比对。';
  const label = last.result === 'match' ? '相符（是你）'
    : last.result === 'mismatch' && last.reason === 'pitch' ? '不像本人（音高差很多）'
      : last.result === 'mismatch' ? '不像本人'
        : last.result === 'uncertain' ? '不够确定'
          : last.result === 'music' ? '像歌曲/伴奏'
            : last.result === 'noise' ? '像环境声'
              : last.result;
  const score = Number.isFinite(Number(last.score)) ? ` · ${Number(last.score).toFixed(2)}` : '';
  const when = last.at ? ` · ${String(last.at).replace('T', ' ').slice(0, 19)}` : '';
  return `上次比对：${label}${score}${when}`;
}

function formatVoiceprintStatus(vp) {
  const ff = vp && vp.ffmpegOk === false
    ? ' 后端还不能转码（App 连的那台机器没装 ffmpeg）。VPS 执行 sudo apt install -y ffmpeg 后重启 node。'
    : '';
  if (!vp?.enrolled) return `尚未录入声纹。点「开始录音」说几句话，可多录几段后点「录入声纹」。${ff}`;
  if (vp.needsReenroll) {
    return `已有旧版声纹，比对会对不上。请先点「清除」，再用自己的声音重新录 2～3 段后录入。${ff}`;
  }
  const when = vp.enrolledAt ? String(vp.enrolledAt).replace('T', ' ').slice(0, 19) : '';
  const self = Number(vp.selfScore) > 0 ? ` 自检 ${Number(vp.selfScore).toFixed(2)}。` : '';
  return `已录入（${vp.samples || 1} 段样本${when ? ` · ${when}` : ''}）。${self}${formatVoiceprintLast(vp.last)} 继续录音再录入可合并加强；也可清除后重录。${ff}`;
}

function refreshVoiceprintStatusUi(vp) {
  const el = document.getElementById('s-voiceprint-status');
  if (el) el.textContent = formatVoiceprintStatus(vp);
}

let _vpRec = null;
let _vpChunks = [];
let _vpSamples = [];
let _vpRecording = false;

window.toggleVoiceprintRecord = async function() {
  const btn = document.getElementById('s-voiceprint-rec-btn');
  const hint = document.getElementById('s-voiceprint-rec-hint');
  if (_vpRecording && _vpRec) {
    _vpRec.stop();
    return;
  }
  try {
    if (window.isNativeShell?.()) await requestNativeMicrophone();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    _vpChunks = [];
    _vpRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    _vpRec.ondataavailable = (e) => { if (e.data?.size) _vpChunks.push(e.data); };
    _vpRec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      _vpRecording = false;
      if (btn) { btn.textContent = '开始录音'; btn.disabled = false; }
      const blob = new Blob(_vpChunks, { type: _vpRec?.mimeType || 'audio/webm' });
      _vpRec = null;
      if (blob.size < 800) {
        window.showToast?.('录音太短，请再说长一点');
        return;
      }
      const ext = /mp4|m4a/i.test(blob.type) ? 'm4a' : (/ogg/i.test(blob.type) ? 'ogg' : 'webm');
      const file = new File([blob], `voiceprint-${Date.now()}.${ext}`, { type: blob.type || 'audio/webm' });
      _vpSamples.push(file);
      if (hint) hint.textContent = `已录 ${_vpSamples.length} 段，可继续录或点「录入声纹」`;
      window.showToast?.(`已加入第 ${_vpSamples.length} 段`);
    };
    _vpRec.start(200);
    _vpRecording = true;
    if (btn) btn.textContent = '停止录音';
    if (hint) hint.textContent = '正在录音…请用正常说话的声音说几句话';
  } catch (e) {
    window.showToast?.(
      /NotAllowed|Permission|denied/i.test(String(e?.name || e?.message || ''))
        ? '麦克风打不开。请到系统设置确认念已获得麦克风权限，并关掉其他正在录音的应用'
        : ('无法使用麦克风: ' + (e.message || '未知错误'))
    );
  }
};

window.enrollVoiceprintSamples = async function() {
  if (_vpRecording) {
    window.showToast?.('请先停止录音');
    return;
  }
  if (!_vpSamples.length) {
    window.showToast?.('请先录至少一段说话');
    return;
  }
  try {
    const st = await api.enrollVoiceprint(_vpSamples.slice(0, 5), { merge: true });
    _vpSamples = [];
    const hint = document.getElementById('s-voiceprint-rec-hint');
    if (hint) hint.textContent = '';
    refreshVoiceprintStatusUi(st);
    const self = Number(st?.selfScore);
    window.showToast?.(self > 0 ? `声纹已保存，自检 ${self.toFixed(2)}` : '声纹已保存');
  } catch (e) {
    window.showToast?.('录入失败: ' + (e.message || '未知错误'));
  }
};

window.clearVoiceprintLibrary = async function() {
  if (!confirm('确定清除已录入的声纹？')) return;
  try {
    const st = await api.clearVoiceprint();
    _vpSamples = [];
    const hint = document.getElementById('s-voiceprint-rec-hint');
    if (hint) hint.textContent = '';
    refreshVoiceprintStatusUi(st);
    window.showToast?.('已清除声纹');
  } catch (e) {
    window.showToast?.('清除失败: ' + (e.message || ''));
  }
};

window.switchSettingsTab = async function(tab, skipLoad) {
  _settingsTab = tab;
  document.querySelectorAll('.settings-tab').forEach(el => el.classList.remove('active'));
  document.getElementById(`stab-${tab}`)?.classList.add('active');
  const settingsPanel = document.getElementById('settings-panel-settings');
  const beautifyPanel = document.getElementById('settings-panel-beautify');
  if (settingsPanel) settingsPanel.style.display = tab === 'settings' ? '' : 'none';
  if (beautifyPanel) beautifyPanel.style.display = tab === 'beautify' ? '' : 'none';
  const saveBtn = document.querySelector('#settings-page .topbar-save');
  if (saveBtn) saveBtn.onclick = tab === 'beautify'
    ? () => window.saveBeautifySettings?.()
    : () => window.saveAllSettings?.();
  const title = document.querySelector('#settings-page .topbar-title');
  if (title) title.textContent = tab === 'beautify' ? '🎨 美化' : '⚙️ 设置';
  if (tab === 'beautify' && !_beautifyEmbedded && beautifyPanel) {
    await import('./beautify-page.js');
    await window.initBeautifyPage?.({ container: beautifyPanel });
    _beautifyEmbedded = true;
  }
};

async function updateBackendHealthBanner() {
  const banner = document.getElementById('backend-health-banner');
  if (!banner) return;
  const ok = await api.checkBackendHealth();
  if (ok) {
    banner.style.display = 'none';
    return;
  }
  const origin = window.isNativeShell?.()
    ? (window.getServerBase?.() || '未设置服务器地址')
    : (window.location.origin || '未知地址');
  banner.style.display = 'block';
  banner.innerHTML = window.isNativeShell?.()
    ? `
    <strong>后端未连接</strong>
    <p>App 需要连到你电脑或 VPS 上运行的念后端。请确认 backend 已启动，并在设置里填写正确的服务器地址（VPS 用 <code>https://你的域名</code>）。</p>
    <p class="backend-health-origin">当前服务器：${escapeHtml(origin)}</p>
  `
    : `
    <strong>后端未连接</strong>
    <p>语音测试、图像测试、保存设置等都需要本地 Node 后端。请在 <code>backend</code> 目录运行 <code>node server.js</code>（或双击 <code>start.bat</code>），并用 <a href="http://localhost:3000">http://localhost:3000</a> 打开应用。</p>
    <p class="backend-health-origin">当前地址：${escapeHtml(origin)}</p>
  `;
}

const API_CONFIG_FIELD_MAP = {
  chat_api_url: 's-chat-url',
  chat_api_key: 's-chat-key',
  chat_model: 's-model',
  chat_temperature: 's-temp',
  diary_api_url: 's-diary-url',
  diary_api_key: 's-diary-key',
  diary_model: 's-diary-model',
  memory_api_url: 's-memory-url',
  memory_api_key: 's-memory-key',
  memory_model: 's-memory-model',
  dream_api_url: 's-dream-url',
  dream_api_key: 's-dream-key',
  dream_model: 's-dream-model',
  series_api_url: 's-series-url',
  series_api_key: 's-series-key',
  series_model: 's-series-model',
  series_outline_model: 's-series-outline-model',
  series_play_model: 's-series-play-model',
  embed_api_url: 's-embed-url',
  embed_api_key: 's-embed-key',
  embed_model: 's-embed-model',
  series_embed_api_url: 's-embed-url',
  series_embed_api_key: 's-embed-key',
  series_embed_model: 's-embed-model',
  minimax_api_key: 's-minimax-key',
  minimax_group_id: 's-minimax-group',
  minimax_api_url: 's-minimax-url',
  minimax_model: 's-minimax-model',
  elevenlabs_api_key: 's-elevenlabs-key',
  elevenlabs_api_url: 's-elevenlabs-url',
  image_api_url: 's-img-url',
  image_api_key: 's-img-key',
  image_model: 's-img-model',
  video_model: 's-video-model',
  img2img_api_url: 's-img2img-url',
  img2img_api_key: 's-img2img-key',
  img2img_model: 's-img2img-model',
  img2video_api_url: 's-img2video-url',
  img2video_api_key: 's-img2video-key',
  img2video_model: 's-img2video-model',
  img2video_seconds: 's-img2video-seconds',
  unsplash_api_key: 's-unsplash-key',
  pexels_api_key: 's-pexels-key',
};

let _apiConfigPresets = [];

function parseApiPresets(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function collectApiFormValues() {
  const data = {};
  for (const [key, elId] of Object.entries(API_CONFIG_FIELD_MAP)) {
    data[key] = document.getElementById(elId)?.value ?? '';
  }
  return data;
}

function applyApiFormValues(data = {}) {
  for (const [key, elId] of Object.entries(API_CONFIG_FIELD_MAP)) {
    const el = document.getElementById(elId);
    if (el && data[key] != null) el.value = data[key];
  }
}

function renderApiPresetSelect(activeId = '') {
  const sel = document.getElementById('s-api-preset-select');
  if (!sel) return;
  const cur = activeId || sel.value || '';
  sel.innerHTML = `<option value="">— 选择已保存方案 —</option>` +
    _apiConfigPresets.map(p =>
      `<option value="${p.id}"${String(p.id) === String(cur) ? ' selected' : ''}>${escapeHtml(p.name)}</option>`
    ).join('');
}

window.onApiPresetSelectChange = function(id) {
  const preset = _apiConfigPresets.find(p => String(p.id) === String(id));
  const nameEl = document.getElementById('s-api-preset-name');
  if (nameEl && preset) nameEl.value = preset.name;
};

window.applySelectedApiPreset = async function() {
  const id = document.getElementById('s-api-preset-select')?.value;
  if (!id) { window.showToast?.('请先选择一个方案'); return; }
  const preset = _apiConfigPresets.find(p => String(p.id) === String(id));
  if (!preset) { window.showToast?.('方案不存在'); return; }
  applyApiFormValues(preset.data);
  try {
    await api.saveSettings({ ...preset.data, active_api_preset: String(preset.id) });
    await window.refreshAppData?.();
    window.showToast?.(`已切换至「${preset.name}」`);
  } catch (e) {
    window.showToast?.('切换失败: ' + (e.message || '网络错误'));
  }
};

window.saveNamedApiPreset = async function() {
  const selectedId = document.getElementById('s-api-preset-select')?.value;
  const selected = selectedId
    ? _apiConfigPresets.find((p) => String(p.id) === String(selectedId))
    : null;
  const name = document.getElementById('s-api-preset-name')?.value?.trim()
    || selected?.name
    || prompt('给这套 API 配置起个名字');
  if (!name) return;

  const data = collectApiFormValues();
  let presetId;
  let overwritten = false;
  const selectedIdx = selected
    ? _apiConfigPresets.findIndex((p) => String(p.id) === String(selected.id))
    : -1;
  const nameIdx = _apiConfigPresets.findIndex((p) => p.name === name);

  if (selectedIdx >= 0) {
    _apiConfigPresets[selectedIdx] = {
      ..._apiConfigPresets[selectedIdx],
      name,
      data,
      updatedAt: new Date().toISOString(),
    };
    presetId = _apiConfigPresets[selectedIdx].id;
    overwritten = true;
  } else if (nameIdx >= 0) {
    _apiConfigPresets[nameIdx] = {
      ..._apiConfigPresets[nameIdx],
      name,
      data,
      updatedAt: new Date().toISOString(),
    };
    presetId = _apiConfigPresets[nameIdx].id;
    overwritten = true;
  } else {
    presetId = Date.now();
    _apiConfigPresets.push({ id: presetId, name, data, createdAt: new Date().toISOString() });
  }

  try {
    await api.saveSettings({
      api_config_presets: JSON.stringify(_apiConfigPresets),
      active_api_preset: String(presetId),
      ...data,
    });
    document.getElementById('s-api-preset-name').value = name;
    renderApiPresetSelect(presetId);
    window.showToast?.(overwritten ? `已覆盖方案「${name}」` : `已保存方案「${name}」`);
  } catch (e) {
    window.showToast?.('保存失败: ' + (e.message || '网络错误'));
  }
};

window.deleteSelectedApiPreset = async function() {
  const id = document.getElementById('s-api-preset-select')?.value;
  if (!id) { window.showToast?.('请先选择要删除的方案'); return; }
  const preset = _apiConfigPresets.find(p => String(p.id) === String(id));
  if (!preset) return;
  if (!confirm(`删除方案「${preset.name}」？`)) return;
  _apiConfigPresets = _apiConfigPresets.filter(p => String(p.id) !== String(id));
  try {
    await api.saveSettings({ api_config_presets: JSON.stringify(_apiConfigPresets), active_api_preset: '' });
    renderApiPresetSelect('');
    document.getElementById('s-api-preset-name').value = '';
    window.showToast?.('已删除');
  } catch (e) {
    window.showToast?.('删除失败: ' + (e.message || '网络错误'));
  }
};

window.saveAllSettings = async function() {
  const data = {
    timezone:         document.getElementById('s-timezone')?.value    || 'Asia/Shanghai',
    chat_api_url:     document.getElementById('s-chat-url')?.value    || '',
    chat_api_key:     document.getElementById('s-chat-key')?.value    || '',
    chat_model:       document.getElementById('s-model')?.value       || 'gpt-4o',
    chat_temperature: document.getElementById('s-temp')?.value        || '0.8',
    diary_api_url:    document.getElementById('s-diary-url')?.value   || '',
    diary_api_key:    document.getElementById('s-diary-key')?.value   || '',
    diary_model:      document.getElementById('s-diary-model')?.value || '',
    memory_api_url:   document.getElementById('s-memory-url')?.value  || '',
    memory_api_key:   document.getElementById('s-memory-key')?.value  || '',
    memory_model:     document.getElementById('s-memory-model')?.value|| '',
    dream_api_url:    document.getElementById('s-dream-url')?.value   || '',
    dream_api_key:    document.getElementById('s-dream-key')?.value   || '',
    dream_model:      document.getElementById('s-dream-model')?.value || '',
    series_api_url:   document.getElementById('s-series-url')?.value  || '',
    series_api_key:   document.getElementById('s-series-key')?.value  || '',
    series_model:     document.getElementById('s-series-model')?.value|| '',
    series_outline_model: document.getElementById('s-series-outline-model')?.value || '',
    series_play_model: document.getElementById('s-series-play-model')?.value || '',
    embed_api_url: document.getElementById('s-embed-url')?.value || '',
    embed_api_key: document.getElementById('s-embed-key')?.value || '',
    embed_model: document.getElementById('s-embed-model')?.value || '',
    // 兼容旧键：与全项目向量同步写入
    series_embed_api_url: document.getElementById('s-embed-url')?.value || '',
    series_embed_api_key: document.getElementById('s-embed-key')?.value || '',
    series_embed_model: document.getElementById('s-embed-model')?.value || '',
    minimax_api_key:  document.getElementById('s-minimax-key')?.value || '',
    minimax_group_id: document.getElementById('s-minimax-group')?.value || '',
    minimax_api_url:  document.getElementById('s-minimax-url')?.value || '',
    minimax_model:    document.getElementById('s-minimax-model')?.value || 'speech-02-hd',
    elevenlabs_api_key: document.getElementById('s-elevenlabs-key')?.value || '',
    elevenlabs_api_url: document.getElementById('s-elevenlabs-url')?.value || '',
    ...readSfxMixFromForm(),
    image_api_url:    document.getElementById('s-img-url')?.value     || '',
    image_api_key:    document.getElementById('s-img-key')?.value     || '',
    image_model:      document.getElementById('s-img-model')?.value   || '',
    video_model:      document.getElementById('s-video-model')?.value || '',
    img2img_api_url:  document.getElementById('s-img2img-url')?.value || '',
    img2img_api_key:  document.getElementById('s-img2img-key')?.value || '',
    img2img_model:    document.getElementById('s-img2img-model')?.value || 'gpt-image-2',
    img2video_api_url: document.getElementById('s-img2video-url')?.value || '',
    img2video_api_key: document.getElementById('s-img2video-key')?.value || '',
    img2video_model: document.getElementById('s-img2video-model')?.value || 'kling-3.0-omni/image-to-video',
    img2video_seconds: document.getElementById('s-img2video-seconds')?.value || '5',
    img2video_strip_audio: document.getElementById('s-img2video-strip-audio')?.checked ? '1' : '0',
    selfie_api_enabled: document.getElementById('s-selfie-api')?.checked ? '1' : '0',
    unsplash_api_key: document.getElementById('s-unsplash-key')?.value || '',
    moments_image_gallery: document.getElementById('s-moments-image-gallery')?.checked ? '1' : '0',
    pexels_api_key: document.getElementById('s-pexels-key')?.value || '',
    moments_video_gallery: document.getElementById('s-moments-video-gallery')?.checked ? '1' : '0',
    github_token:     document.getElementById('s-github-token')?.value || '',
    github_repo:      document.getElementById('s-github-repo')?.value  || '',
  };

  try {
    await api.saveSettings(data);
    await window.refreshAppData?.();
    try { refreshCallSfxMix(); } catch {}
    window.showToast?.('设置已保存');
    // Apply theme immediately
    if (data.theme_color) {
      document.documentElement.style.setProperty('--theme', data.theme_color);
    }
  } catch(e) { window.showToast?.(e.message); }
};

window.openExportPanel = function() {
  document.getElementById('export-overlay').classList.add('active');
};

window.doExport = async function() {
  const types = Array.from(document.querySelectorAll('[data-export-type]:checked')).map(el => el.dataset.exportType);
  try {
    window.showToast?.('正在导出…');
    const data = await buildClientBackup(types.length ? types : ['all']);
    const r = await downloadBackupFile(`nian-export-${new Date().toISOString().slice(0,10)}.json`, data);
    if (r.cancelled) return;
    document.getElementById('export-overlay')?.classList.remove('active');
    window.showToast?.(`导出成功${data.phone_archive_merged ? '（已合并手机聊天）' : ''}`);
  } catch(e) { window.showToast?.(e.message); }
};

window.doGithubBackup = async function() {
  const el = document.getElementById('github-backup-result');
  if (el) el.textContent = '备份中…';
  try {
    await window.saveAllSettings?.();
    const payload = await buildClientBackup(['all']);
    const data = await api.githubBackup(payload);
    if (!data.ok) {
      if (el) el.innerHTML = `<span style="color:#e53935">${escapeHtml(data.error || '备份失败')}</span>`;
    } else {
      if (el) el.innerHTML = `<span style="color:#43a047">✓ 备份成功</span> <a href="${escapeHtml(data.url)}" target="_blank" style="color:var(--theme);font-size:12px">查看仓库</a>`;
    }
  } catch(e) {
    if (el) el.innerHTML = `<span style="color:#e53935">${escapeHtml(e.message)}</span>`;
  }
};

window.doFullBackup = async function() {
  try {
    window.showToast?.('正在备份…');
    const data = await buildClientBackup(['all']);
    const r = await downloadBackupFile(`nian-backup-${new Date().toISOString().slice(0,10)}.json`, data);
    if (r.cancelled) return;
    window.showToast?.(data.phone_archive_merged ? '完整备份已保存（含手机聊天）' : '完整备份已保存');
  } catch(e) { window.showToast?.('备份失败: ' + e.message); }
};

window.testImageApi = async function() {
  const el = document.getElementById('img-test-result');
  if (el) el.textContent = '测试中…';
  try {
    await window.saveAllSettings?.();
    const r = await api.testImageApi();
    if (el) el.innerHTML = r.ok ? `<span style="color:#43a047">✓ 成功</span>` : `<span style="color:#e53935">${r.error}</span>`;
    if (r.url) window.open(r.url, '_blank');
  } catch(e) {
    if (el) el.innerHTML = `<span style="color:#e53935">${escapeHtml(e.message)}</span>`;
  }
};

window.testImg2VideoApi = async function() {
  const el = document.getElementById('img2video-test-result');
  if (el) el.textContent = '测试中（图生视频可能需数分钟）…';
  try {
    await window.saveAllSettings?.();
    const r = await api.testImg2VideoApi();
    if (el) {
      el.innerHTML = r.ok
        ? `<span style="color:#43a047">✓ 成功</span> ${escapeHtml(r.hint || '')}`
        : `<span style="color:#e53935">${escapeHtml(r.error || '失败')}</span>`;
    }
    if (r.url) window.open(r.url, '_blank');
  } catch (e) {
    if (el) el.innerHTML = `<span style="color:#e53935">${escapeHtml(e.message)}</span>`;
  }
};

window.fetchModelsForImg2Video = async function() {
  const url = document.getElementById('s-img2video-url')?.value?.trim();
  const key = document.getElementById('s-img2video-key')?.value?.trim();
  if (!url || !key) { window.showToast?.('请先填写图生视频 URL 和 API Key'); return; }

  const btn = event?.target;
  if (btn) {
    btn.textContent = '获取中…';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = '获取模型'; btn.disabled = false; }, 12000);
  }

  try {
    const r = await postJsonSafe('/api/img2video/models', { url, key });
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    const models = r.models || [];
    const list = document.getElementById('s-img2video-model-list');
    if (list) list.innerHTML = models.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
    if (!models.length) {
      window.showToast?.(r.error ? `获取失败: ${r.error}` : '未获取到模型');
      return;
    }
    const fromApi = r.source === 'api' || r.source === 'api-all';
    if (r.error && !fromApi) {
      window.showToast?.(`拉取失败，已用内置列表：${r.error}`);
    } else if (r.note) {
      window.showToast?.(r.note);
    } else {
      window.showToast?.(fromApi ? `已从 API 拉取 ${models.length} 个` : `内置列表 ${models.length} 个`);
    }
    showModelPickerFor(models, m => {
      const el = document.getElementById('s-img2video-model');
      if (el) el.value = m;
    });
  } catch (e) {
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    window.showToast?.('获取失败: ' + e.message);
  }
};

window.testUnsplashApi = async function() {
  const el = document.getElementById('unsplash-test-result');
  if (el) el.textContent = '测试中…';
  try {
    await window.saveAllSettings?.();
    const r = await api.testUnsplashApi();
    if (el) el.innerHTML = r.ok ? `<span style="color:#43a047">✓ 成功</span>` : `<span style="color:#e53935">${r.error}</span>`;
    if (r.url) window.open(r.url, '_blank');
  } catch(e) {
    if (el) el.innerHTML = `<span style="color:#e53935">${escapeHtml(e.message)}</span>`;
  }
};

window.testPexelsApi = async function() {
  const el = document.getElementById('pexels-test-result');
  if (el) el.textContent = '测试中…';
  try {
    await window.saveAllSettings?.();
    const r = await api.testPexelsApi();
    if (el) el.innerHTML = r.ok ? `<span style="color:#43a047">✓ 成功</span>` : `<span style="color:#e53935">${escapeHtml(r.error || '失败')}</span>`;
    if (r.url) window.open(r.url, '_blank');
  } catch(e) {
    if (el) el.innerHTML = `<span style="color:#e53935">${escapeHtml(e.message)}</span>`;
  }
};

window.importData = function() {
  document.getElementById('import-file-input')?.click();
};

window.handleImport = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!confirm(`确定导入数据？这将合并覆盖现有数据`)) return;
    await importBackupFile(data);
    await window.refreshAppData?.();
    window.showToast?.('导入成功');
  } catch(err) { window.showToast?.('导入失败: ' + err.message); }
  e.target.value = '';
};

// ===== 通用模型选择弹窗 =====
function showModelPickerFor(models, onSelect, modelOptions = null) {
  const existing = document.getElementById('model-picker-overlay');
  if (existing) existing.remove();

  const opts = Array.isArray(modelOptions) && modelOptions.length
    ? modelOptions.map(o => ({ key: o.key, label: o.label || '', sub: o.sceneType === 'image_edit' ? '局部重绘（API 未开放）' : (o.maxReferenceImages > 0 ? `最多 ${o.maxReferenceImages} 张参考图` : '纯文生图') }))
    : models.map(m => ({ key: m, label: '', sub: '' }));

  const overlay = document.createElement('div');
  overlay.id = 'model-picker-overlay';
  overlay.className = 'overlay active center';
  overlay.onclick = () => overlay.remove();

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.cssText = 'width:calc(100% - 32px);max-width:380px;max-height:70vh;overflow-y:auto';
  modal.onclick = e => e.stopPropagation();
  modal.innerHTML = `
    <div class="modal-title">选择模型（共${opts.length}个）</div>
    <div style="padding:8px 0">
      <input class="input" placeholder="搜索…" style="margin:0 16px 8px;width:calc(100% - 32px)"
        oninput="this.closest('.modal').querySelectorAll('.list-item').forEach(el=>el.style.display=el.dataset.search.includes(this.value.toLowerCase())?'':'none')">
      <div style="max-height:300px;overflow-y:auto">
        ${opts.map(o => `
          <div class="list-item" style="cursor:pointer" data-search="${escapeHtml((o.key + ' ' + o.label + ' ' + o.sub).toLowerCase())}">
            <div style="font-size:13px;font-family:monospace">${escapeHtml(o.key)}</div>
            ${o.label ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${escapeHtml(o.label)}</div>` : ''}
            ${o.sub ? `<div style="font-size:11px;color:var(--text-secondary);opacity:0.85">${escapeHtml(o.sub)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  modal.querySelectorAll('.list-item').forEach((el, i) => {
    el.addEventListener('click', () => { onSelect(opts[i].key); overlay.remove(); });
  });
}

// ===== 查询 API 余额 =====
const API_BALANCE_TARGETS = {
  chat: { urlId: 's-chat-url', keyId: 's-chat-key', label: '聊天 API' },
  memory: { urlId: 's-memory-url', keyId: 's-memory-key', label: '记忆 API', fallbackChat: true },
  diary: { urlId: 's-diary-url', keyId: 's-diary-key', label: '日记 API', fallbackChat: true },
  dream: { urlId: 's-dream-url', keyId: 's-dream-key', label: '梦境 API', fallbackChat: true },
  series: { urlId: 's-series-url', keyId: 's-series-key', label: '时空 API' },
  embed: { urlId: 's-embed-url', keyId: 's-embed-key', label: '向量 API', fallbackChat: true },
  series_embed: { urlId: 's-embed-url', keyId: 's-embed-key', label: '向量 API', fallbackChat: true },
  img: { urlId: 's-img-url', keyId: 's-img-key', label: '图像 API' },
  img2img: { urlId: 's-img2img-url', keyId: 's-img2img-key', label: '图生图 API' },
  img2video: { urlId: 's-img2video-url', keyId: 's-img2video-key', label: '图生视频 API' },
};

function resolveApiBalanceCreds(kind) {
  const cfg = API_BALANCE_TARGETS[kind];
  if (!cfg) return null;
  let url = document.getElementById(cfg.urlId)?.value?.trim() || '';
  let key = document.getElementById(cfg.keyId)?.value?.trim() || '';
  if (cfg.fallbackChat) {
    if (!url) url = document.getElementById('s-chat-url')?.value?.trim() || '';
    if (!key) key = document.getElementById('s-chat-key')?.value?.trim() || '';
  }
  if (cfg.fallbackSeries) {
    if (!url) url = document.getElementById('s-series-url')?.value?.trim() || '';
    if (!key) key = document.getElementById('s-series-key')?.value?.trim() || '';
  }
  return { ...cfg, url, key };
}

window.checkApiBalance = async function(kind) {
  const creds = resolveApiBalanceCreds(kind);
  if (!creds) return;
  if (!creds.url || !creds.key) {
    window.showToast?.(kind === 'series'
      ? '请先填写时空 API 的 URL 和 Key'
      : (kind === 'embed' || kind === 'series_embed'
        ? '请先填写向量 API（或聊天 API）的 URL 和 Key'
        : '请先填写 Base URL 和 API Key'));
    return;
  }

  const btn = event?.target;
  const prevText = btn?.textContent;
  if (btn) { btn.textContent = '查询中…'; btn.disabled = true; }

  try {
    const data = await api.checkApiBalance(creds.url, creds.key);
    const summary = data.summary || '查询成功';
    window.showToast?.(`${creds.label}：${summary}`);
  } catch (e) {
    window.showToast?.(`${creds.label}余额查询失败：${e.message || '未知错误'}`);
  } finally {
    if (btn) { btn.textContent = prevText || '查余额'; btn.disabled = false; }
  }
};

// ===== 可选API获取模型 =====
window.fetchModelsForType = async function(type) {
  const seriesOnly = type === 'series';
  const embedType = type === 'embed' || type === 'series_embed';
  const url = seriesOnly
    ? (document.getElementById('s-series-url')?.value?.trim() || '')
    : embedType
      ? (document.getElementById('s-embed-url')?.value?.trim()
        || document.getElementById('s-chat-url')?.value?.trim() || '')
      : (document.getElementById(`s-${type}-url`)?.value?.trim()
        || document.getElementById('s-chat-url')?.value?.trim());
  const key = seriesOnly
    ? (document.getElementById('s-series-key')?.value?.trim() || '')
    : embedType
      ? (document.getElementById('s-embed-key')?.value?.trim()
        || document.getElementById('s-chat-key')?.value?.trim() || '')
      : (document.getElementById(`s-${type}-key`)?.value?.trim()
        || document.getElementById('s-chat-key')?.value?.trim());
  if (!url || !key) {
    window.showToast?.(seriesOnly
      ? '请先填写剧集 API 的 URL 和 Key'
      : embedType
        ? '请先填写向量 API（或聊天 API）的 URL 和 Key'
        : '请先填写 URL 和 API Key');
    return;
  }

  const btn = event?.target;
  if (btn) { const t = btn.textContent; btn.textContent = '获取中…'; btn.disabled = true;
    setTimeout(() => { btn.textContent = t; btn.disabled = false; }, 8000); }

  try {
    const data = await postJsonSafe('/api/models/fetch', { url, key });
    if (data.error) { window.showToast?.(`获取失败: ${data.error}`); return; }
    showModelPickerFor(data.models, m => {
      const modelElId = embedType ? 's-embed-model'
        : (type === 'series' ? 's-series-model' : `s-${type}-model`);
      const el = document.getElementById(modelElId);
      if (el) el.value = m;
    });
  } catch(e) { window.showToast?.('获取失败: ' + e.message); }
};

// ===== 图像生成获取模型 =====
window.fetchModelsForImage = async function() {
  const url = document.getElementById('s-img-url')?.value?.trim();
  const key = document.getElementById('s-img-key')?.value?.trim();
  if (!url || !key) { window.showToast?.('请先填写 URL 和 API Key'); return; }

  const btn = event?.target;
  if (btn) { const t = btn.textContent; btn.textContent = '获取中…'; btn.disabled = true;
    setTimeout(() => { btn.textContent = t; btn.disabled = false; }, 8000); }

  try {
    const data = await postJsonSafe('/api/image/models', { url, key });
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    if (data.error) { window.showToast?.(`获取失败: ${data.error}`); return; }
    const list = data.models || [];
    if (!list.length) { window.showToast?.('未获取到模型，可手动输入 imagen-3.0-generate-001'); return; }
    if (data.note) window.showToast?.(data.note);
    const dl = document.getElementById('s-img-model-list');
    if (dl) dl.innerHTML = list.map(m => `<option value="${escapeHtml(m)}">`).join('');
    showModelPickerFor(list, m => {
      const el = document.getElementById('s-img-model');
      if (el) el.value = m;
    }, data.modelOptions);
  } catch(e) {
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    window.showToast?.('获取失败: ' + e.message);
  }
};

// ===== 图生图获取模型（用 URL + Key 拉取；HiAPI 优先 /v1/models） =====
window.fetchModelsForImg2Img = async function() {
  const url = document.getElementById('s-img2img-url')?.value?.trim();
  const key = document.getElementById('s-img2img-key')?.value?.trim();
  if (!url || !key) { window.showToast?.('请先填写图生图 URL 和 API Key'); return; }

  const btn = event?.target;
  if (btn) { const t = btn.textContent; btn.textContent = '获取中…'; btn.disabled = true;
    setTimeout(() => { btn.textContent = t; btn.disabled = false; }, 8000); }

  try {
    const data = await postJsonSafe('/api/image/models', { url, key, purpose: 'img2img' });
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    if (data.error && !(data.models || []).length) {
      window.showToast?.(`获取失败: ${data.error}`);
      return;
    }
    const list = data.models || [];
    if (!list.length) {
      window.showToast?.('未获取到模型，可手动输入 gpt-image-2、gpt-image-2/image-to-image 或 hera-1.0-image-edit');
      return;
    }
    if (data.note) window.showToast?.(data.note);
    else window.showToast?.(`已拉取 ${list.length} 个模型`);
    const dl = document.getElementById('s-img2img-model-list');
    if (dl) dl.innerHTML = list.map(m => `<option value="${escapeHtml(m)}">`).join('');
    showModelPickerFor(list, m => {
      const el = document.getElementById('s-img2img-model');
      if (el) el.value = m;
    }, data.modelOptions);
  } catch(e) {
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    window.showToast?.('获取失败: ' + e.message);
  }
};

// ===== 获取主聊天模型列表 =====
async function postJsonSafe(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getSiteSessionToken();
  if (token) headers['X-Nian-Session'] = token;
  const resp = await fetch(resolveApiUrl(path), {
    method: 'POST',
    credentials: isNativeShell() ? 'include' : 'same-origin',
    headers,
    body: JSON.stringify(body),
  });
  const data = await api.parseApiResponse(resp, path);
  if (!resp.ok) throw new Error(data.error || `请求失败 ${resp.status}`);
  return data;
}

// ===== MiniMax 拉取模型 =====
window.fetchMinimaxModels = async function() {
  const key = document.getElementById('s-minimax-key')?.value?.trim();
  if (!key) { window.showToast?.('请先填写 MiniMax API Key'); return; }

  const btn = event?.target;
  if (btn) { const t = btn.textContent; btn.textContent = '获取中…'; btn.disabled = true;
    setTimeout(() => { btn.textContent = t; btn.disabled = false; }, 8000); }

  try {
    const data = await postJsonSafe('/api/minimax/models', { key });
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    if (data.error) { window.showToast?.(`获取失败: ${data.error}`); return; }
    const ttsModels = (data.models || []).filter(m => /^speech-/i.test(m));
    if (!ttsModels.length) {
      window.showToast?.('未找到语音模型，请手动填写如 speech-02-hd');
      return;
    }
    showModelPickerFor(ttsModels, m => {
      const el = document.getElementById('s-minimax-model');
      if (el) el.value = m;
    });
    window.showToast?.('已加载 MiniMax 官方语音模型');
  } catch(e) {
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    window.showToast?.('获取失败: ' + e.message);
  }
};

window.testElevenlabsSfx = async function() {
  const resultEl = document.getElementById('sfx-test-result');
  const prompt = document.getElementById('s-sfx-test-prompt')?.value?.trim()
    || 'ocean waves on a rocky shore, light sea wind';
  if (resultEl) resultEl.textContent = '测试中…';
  try {
    await api.saveSettings({
      elevenlabs_api_key: document.getElementById('s-elevenlabs-key')?.value || '',
      elevenlabs_api_url: document.getElementById('s-elevenlabs-url')?.value || '',
    });
    const data = await postJsonSafe('/api/sfx/test', {
      prompt,
      key: document.getElementById('s-elevenlabs-key')?.value || '',
      url: document.getElementById('s-elevenlabs-url')?.value || '',
    });
    if (resultEl) {
      resultEl.innerHTML = data?.ok
        ? `<span style="color:#43a047">成功，音频 ${data.bytes} 字节</span>`
        : `<span style="color:#e57373">${escapeHtml(data?.error || '失败')}</span>`;
    }
    if (!data?.ok) window.showToast?.(data?.error || '音效测试失败');
    else window.showToast?.('音效 API 可用');
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<span style="color:#e57373">${escapeHtml(e.message || '失败')}</span>`;
    window.showToast?.(e.message || '音效测试失败');
  }
};

window.testMinimaxTts = async function() {
  const voiceId = document.getElementById('s-minimax-test-voice')?.value?.trim();
  const resultEl = document.getElementById('minimax-test-result');
  if (!voiceId) {
    window.showToast?.('请先填写测试用声音 ID');
    return;
  }
  if (resultEl) resultEl.textContent = '测试中…';
  try {
    await api.saveSettings({
      minimax_api_key: document.getElementById('s-minimax-key')?.value || '',
      minimax_group_id: document.getElementById('s-minimax-group')?.value || '',
      minimax_api_url: document.getElementById('s-minimax-url')?.value || '',
      minimax_model: document.getElementById('s-minimax-model')?.value || 'speech-02-hd',
    });
    const data = await postJsonSafe('/api/minimax/test', { voiceId });
    if (resultEl) resultEl.innerHTML = `<span style="color:#43a047">成功，音频 ${data.bytes} 字节</span>`;
    window.showToast?.('MiniMax 语音测试成功');
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<span style="color:#e53935">${escapeHtml(e.message)}</span>`;
    window.showToast?.('测试失败: ' + e.message);
  }
};

window.fetchModels = async function() {
  const url = document.getElementById('s-chat-url')?.value?.trim();
  const key = document.getElementById('s-chat-key')?.value?.trim();
  if (!url || !key) { window.showToast?.('请先填写 Base URL 和 API Key'); return; }

  const btn = document.querySelector('[onclick="fetchModels()"]');
  if (btn) { btn.textContent = '获取中…'; btn.disabled = true; }

  try {
    const data = await postJsonSafe('/api/models/fetch', { url, key });
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    if (data.error) { window.showToast?.(`获取失败: ${data.error}`); return; }

    showModelPickerFor(data.models, m => {
      const el = document.getElementById('s-model');
      if (el) el.value = m;
      const dl = document.getElementById('s-model-list');
      if (dl) dl.innerHTML = data.models.map(x => `<option value="${x}">`).join('');
    });
  } catch(e) {
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
    window.showToast?.('获取失败: ' + e.message);
  }
};

window.clearDataPrompt = async function(type) {
  const labels = {
    memories: '记忆（含叙事/印象/行程/情绪）',
    diaries: '日记与信件（含秘密、备忘录、相册任务）',
    cache: '今日动态缓存',
    all: '全部内容（角色/聊天/圈子/群聊等，保留 API 设置与预设）',
  };
  if (!confirm(`确定清除${labels[type] || type}？此操作不可恢复`)) return;
  if (type === 'all' && !confirm('再次确认：清除全部内容？设置与预设会保留。')) return;
  try {
    await api.clearData(type);
    if (type === 'all') {
      try { await clearAllThreadCaches(); } catch {}
      try { await clearMediaCache(); } catch {}
    }
    window.showToast?.('已清除');
  } catch(e) { window.showToast?.(e.message); }
};

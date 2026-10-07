/* ===== 外貌档案（含生图参考形象） ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { pickCropAndUpload } from '../media-crop.js';

const IMAGE_REF_LIMITS = { face: 3, body: 2, hands: 2, fullbody: 2, special: 3 };
const APPEARANCE_FIELDS = [
  { key: 'height', label: '身高', placeholder: '例：178cm' },
  { key: 'build', label: '体型', placeholder: '例：偏瘦、匀称' },
  { key: 'hair_color', label: '发色', placeholder: '例：深棕' },
  { key: 'hair_length', label: '发长', placeholder: '例：及肩、短发' },
  { key: 'eye_color', label: '瞳色', placeholder: '例：深褐' },
  { key: 'skin_tone', label: '肤色', placeholder: '例：偏白、小麦色' },
  { key: 'piercings', label: '耳洞/穿孔', placeholder: '例：左耳双耳洞' },
  { key: 'marks', label: '纹身/疤痕', placeholder: '例：右臂小纹身' },
];

let _charId = 0;

function normalizeImageRefs(raw) {
  if (Array.isArray(raw)) {
    return {
      face: raw.filter(Boolean).slice(0, 3),
      body: [],
      hands: [],
      fullbody: [],
      special: [],
      special_enabled: false,
      special_label: '',
    };
  }
  if (raw && typeof raw === 'object') {
    const enabled = raw.special_enabled === true
      || raw.special_enabled === 1
      || raw.special_enabled === '1'
      || raw.special_enabled === 'true';
    return {
      face: [].concat(raw.face || []).filter(Boolean).slice(0, 3),
      body: [].concat(raw.body || []).filter(Boolean).slice(0, 2),
      hands: [].concat(raw.hands || []).filter(Boolean).slice(0, 2),
      fullbody: [].concat(raw.fullbody || []).filter(Boolean).slice(0, 2),
      special: [].concat(raw.special || []).filter(Boolean).slice(0, 3),
      special_enabled: enabled,
      special_label: String(raw.special_label || '').trim().slice(0, 40),
    };
  }
  return {
    face: [], body: [], hands: [], fullbody: [],
    special: [], special_enabled: false, special_label: '',
  };
}

function renderImageRefGrids() {
  const g = window._appearanceImageRefs = normalizeImageRefs(window._appearanceImageRefs);
  for (const slot of ['face', 'body', 'hands', 'fullbody', 'special']) {
    const grid = document.getElementById(`ap-ref-${slot}-grid`);
    if (!grid) continue;
    grid.innerHTML = (g[slot] || []).map((url, i) => `
      <div style="position:relative;width:72px;height:72px">
        <img src="${escapeHtml(url)}" style="width:72px;height:72px;border-radius:10px;object-fit:cover;border:1px solid var(--border)">
        <div onclick="removeAppearanceImageRef('${slot}',${i})" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;
          background:#e53935;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;z-index:1">✕</div>
      </div>
    `).join('');
  }
  syncSpecialFormUi();
}

function syncSpecialFormUi() {
  const g = normalizeImageRefs(window._appearanceImageRefs);
  const enabled = !!g.special_enabled;
  const panel = document.getElementById('ap-special-panel');
  const toggle = document.getElementById('ap-special-enabled');
  const label = document.getElementById('ap-special-label');
  if (toggle) toggle.checked = enabled;
  if (panel) panel.style.display = enabled ? '' : 'none';
  if (label && document.activeElement !== label) label.value = g.special_label || '';
}

window.openAppearance = function(id) {
  window._appearanceCharId = Number(id || window.getActiveCharId?.() || 0);
  window._appearanceBack = 'wardrobe';
  window.navigateTo('appearance');
};

window.initAppearancePage = async function() {
  const page = document.getElementById('appearance-page');
  if (!page) return;
  _charId = Number(window._appearanceCharId || window.getActiveCharId?.() || 0);
  if (!_charId) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">未选择角色</div></div>`;
    return;
  }
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  let data;
  let char;
  try {
    [data, char] = await Promise.all([
      api.getAppearance(_charId),
      api.getCharacter(_charId),
    ]);
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
    return;
  }
  const profile = data.appearance_profile || {};
  window._appearanceImageRefs = normalizeImageRefs(data.image_ref);
  window._appearanceImageStyle = data.image_style || 'anime';
  window._appearanceImageRefSlot = 'face';
  window._appearanceCharMeta = {
    description: char?.description || '',
    intro: char?.intro || '',
    selfie_style_prompt: char?.selfie_style_prompt || '',
    home_environment: char?.home_environment || '',
    home_refs: char?.home_refs || [],
  };

  page.innerHTML = `
    <div class="appearance-shell">
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="appearanceGoBack()" title="返回"></button>
        <div class="topbar-title">外貌档案</div>
        <button type="button" class="btn btn-primary btn-sm" onclick="saveAppearanceProfile()">保存</button>
      </div>
      <div class="appearance-body scroll-area scroll-area-native">
        <div class="settings-section" style="margin-top:12px">
          <div class="settings-section-title">基础外貌</div>
          <div class="settings-group">
            ${APPEARANCE_FIELDS.map((f) => `
              <div class="appearance-field">
                <span class="appearance-field-label">${f.label}</span>
                <input class="input" id="ap-${f.key}" value="${escapeHtml(profile[f.key] || '')}" placeholder="${escapeHtml(f.placeholder)}">
              </div>
            `).join('')}
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">生图参考形象（自拍用）</div>
          <div class="settings-group">
            <div class="settings-row">
              <span class="settings-row-label">画风</span>
              <div style="display:flex;gap:8px">
                <div class="tag ${window._appearanceImageStyle === 'anime' ? 'active' : ''}" onclick="selectAppearanceImageStyle('anime')" style="cursor:pointer">虚拟（动漫）</div>
                <div class="tag ${window._appearanceImageStyle === 'real' ? 'active' : ''}" onclick="selectAppearanceImageStyle('real')" style="cursor:pointer">真实（写真）</div>
              </div>
            </div>
            <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px 16px;gap:12px">
              <div style="font-size:12px;color:var(--text-secondary);line-height:1.6">
                自拍走<strong>图生图 API</strong>。正脸用于认人；<strong>全身比例图</strong>用于锁身高/身材比例（站姿/穿搭场景必须用）；露腹肌等局部优先身体图；手部特写优先手部图。
              </div>
              <div style="width:100%">
                <div style="font-size:13px;font-weight:500;margin-bottom:6px">正脸 / 侧脸 <span style="font-weight:400;color:var(--text-secondary)">最多 3 张</span></div>
                <div id="ap-ref-face-grid" style="display:flex;flex-wrap:wrap;gap:8px"></div>
                <div class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addAppearanceImageRef('face')">＋ 添加正脸</div>
              </div>
              <div style="width:100%">
                <div style="font-size:13px;font-weight:500;margin-bottom:6px">身体 / 半身 <span style="font-weight:400;color:var(--text-secondary)">最多 2 张</span></div>
                <div id="ap-ref-body-grid" style="display:flex;flex-wrap:wrap;gap:8px"></div>
                <div class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addAppearanceImageRef('body')">＋ 添加身体</div>
              </div>
              <div style="width:100%">
                <div style="font-size:13px;font-weight:500;margin-bottom:6px">全身比例参考图 <span style="font-weight:400;color:var(--text-secondary)">最多 2 张，最好站直</span></div>
                <div id="ap-ref-fullbody-grid" style="display:flex;flex-wrap:wrap;gap:8px"></div>
                <div class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addAppearanceImageRef('fullbody')">＋ 添加全身比例</div>
              </div>
              <div style="width:100%">
                <div style="font-size:13px;font-weight:500;margin-bottom:6px">手部特写 <span style="font-weight:400;color:var(--text-secondary)">最多 2 张</span></div>
                <div id="ap-ref-hands-grid" style="display:flex;flex-wrap:wrap;gap:8px"></div>
                <div class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addAppearanceImageRef('hands')">＋ 添加手部</div>
              </div>

              <div style="width:100%;border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
                <div style="font-size:13px;font-weight:500;margin-bottom:8px">测试生图</div>
                <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px">
                  走设置里的图生图 API。先上传至少一张正脸。
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <button type="button" class="btn btn-ghost btn-sm" id="ap-test-selfie-btn" onclick="testAppearanceSelfieImage()">测试生成图</button>
                  <span id="ap-selfie-test-status" style="font-size:12px;color:var(--text-secondary);flex:1;min-width:120px"></span>
                </div>
                <div id="ap-selfie-test-wrap" style="display:none;margin-top:10px">
                  <img id="ap-selfie-test-img" alt="测试自拍" style="max-width:100%;max-height:360px;border-radius:12px;border:1px solid var(--border);object-fit:contain;background:rgba(0,0,0,0.04)">
                </div>
              </div>

              <div style="width:100%;border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
                <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer">
                  <span>
                    <div style="font-size:13px;font-weight:500">特殊形态（非人类）</div>
                    <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;line-height:1.5">兽形、原形等非人类外观。开启后可上传参考图；自拍文案写到该形态时改用这些图生图。</div>
                  </span>
                  <input type="checkbox" id="ap-special-enabled" onchange="toggleAppearanceSpecialForm(this.checked)" style="width:18px;height:18px;flex-shrink:0">
                </label>
                <div id="ap-special-panel" style="display:none;margin-top:12px">
                  <div class="appearance-field" style="margin-bottom:10px">
                    <span class="appearance-field-label">形态名称</span>
                    <input class="input" id="ap-special-label" placeholder="例：狐狸原形、龙形态" maxlength="40" oninput="updateAppearanceSpecialLabel(this.value)">
                  </div>
                  <div style="font-size:13px;font-weight:500;margin-bottom:6px">特殊形态参考图 <span style="font-weight:400;color:var(--text-secondary)">最多 3 张</span></div>
                  <div id="ap-ref-special-grid" style="display:flex;flex-wrap:wrap;gap:8px"></div>
                  <div class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addAppearanceImageRef('special')">＋ 添加特殊形态</div>
                </div>
              </div>

              <input type="file" id="ap-image-ref-input" accept="image/*" style="display:none" onchange="handleAppearanceImageRef(event)">
            </div>
          </div>
        </div>

        <div style="font-size:11px;color:var(--text-secondary);padding:0 16px;line-height:1.5">
          家装参考、自拍画风提示词等仍在「设置朋友资料 → 角色编辑」里。
        </div>
      </div>
    </div>
  `;
  renderImageRefGrids();
};

window.appearanceGoBack = function() {
  window.goBack?.();
};

window.selectAppearanceImageStyle = function(style) {
  window._appearanceImageStyle = style;
  document.querySelectorAll('#appearance-page .tag').forEach((el) => {
    const isAnime = el.textContent.includes('虚拟');
    el.classList.toggle('active', (style === 'anime' && isAnime) || (style === 'real' && !isAnime));
  });
};

window.toggleAppearanceSpecialForm = function(on) {
  const g = window._appearanceImageRefs = normalizeImageRefs(window._appearanceImageRefs);
  g.special_enabled = !!on;
  syncSpecialFormUi();
};

window.updateAppearanceSpecialLabel = function(value) {
  const g = window._appearanceImageRefs = normalizeImageRefs(window._appearanceImageRefs);
  g.special_label = String(value || '').trim().slice(0, 40);
};

window.addAppearanceImageRef = function(slot = 'face') {
  const g = window._appearanceImageRefs = normalizeImageRefs(window._appearanceImageRefs);
  if ((g[slot] || []).length >= IMAGE_REF_LIMITS[slot]) {
    window.showToast?.(`该栏最多 ${IMAGE_REF_LIMITS[slot]} 张`);
    return;
  }
  window._appearanceImageRefSlot = slot;
  document.getElementById('ap-image-ref-input')?.click();
};

window.handleAppearanceImageRef = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const slot = window._appearanceImageRefSlot || 'face';
  try {
    const result = await pickCropAndUpload(file, { title: '裁剪参考图', aspect: '3:4' });
    if (!result?.url) return;
    const g = window._appearanceImageRefs = normalizeImageRefs(window._appearanceImageRefs);
    if ((g[slot] || []).length >= IMAGE_REF_LIMITS[slot]) {
      window.showToast?.(`该栏最多 ${IMAGE_REF_LIMITS[slot]} 张`);
      return;
    }
    g[slot].push(result.url);
    if (slot === 'special') g.special_enabled = true;
    renderImageRefGrids();
  } catch {
    window.showToast?.('上传失败');
  }
  e.target.value = '';
};

window.removeAppearanceImageRef = function(slot, index) {
  const g = window._appearanceImageRefs = normalizeImageRefs(window._appearanceImageRefs);
  g[slot].splice(index, 1);
  renderImageRefGrids();
};

function flattenAppearanceImageRefs(groups) {
  const g = normalizeImageRefs(groups);
  return [...g.face, ...g.body, ...g.fullbody, ...g.hands].filter(Boolean).slice(0, 6);
}

window.testAppearanceSelfieImage = async function() {
  const groups = normalizeImageRefs(window._appearanceImageRefs);
  const refs = flattenAppearanceImageRefs(groups);
  if (!groups.face.length) {
    window.showToast?.('请先上传至少一张正脸参考图');
    return;
  }
  const meta = window._appearanceCharMeta || {};
  const btn = document.getElementById('ap-test-selfie-btn');
  const wrap = document.getElementById('ap-selfie-test-wrap');
  const img = document.getElementById('ap-selfie-test-img');
  const status = document.getElementById('ap-selfie-test-status');
  if (btn) { btn.textContent = '生成中…'; btn.style.pointerEvents = 'none'; }
  if (status) {
    status.dataset.busy = '1';
    status.textContent = '正在调用图生图（慢模型可能要几分钟）…';
  }
  if (wrap) wrap.style.display = 'block';
  try {
    const r = await api.testSelfieImage(refs, {
      imageRefGroups: groups,
      aspect: '3:4',
      provider: 'daily',
      imageStyle: window._appearanceImageStyle || 'anime',
      homeRefs: meta.home_refs || [],
      homeEnvironment: meta.home_environment || '',
      selfieStylePrompt: meta.selfie_style_prompt || '',
      description: meta.description || '',
      intro: meta.intro || '',
      sceneQuery: meta.home_refs?.length ? '在家自拍，背景与家装参考图一致' : '',
    });
    if (r.ok && r.url) {
      if (img) img.src = r.url;
      const hint = r.hint ? `<br><span style="color:#666;font-size:12px">${escapeHtml(r.hint)}</span>` : '';
      if (status) {
        status.innerHTML = r.usedReference
          ? `<span style="color:#43a047">✓ 生成成功</span>${hint}`
          : `<span style="color:#fb8c00">⚠ 已出图但未确认参考图生效</span>${hint}`;
      }
    } else {
      if (status) status.innerHTML = `<span style="color:#e53935">${escapeHtml(r.error || '生成失败')}</span>`;
    }
  } catch (e) {
    if (status) status.innerHTML = `<span style="color:#e53935">${escapeHtml(e.message || '请求失败')}</span>`;
  } finally {
    if (btn) { btn.textContent = '测试生成图'; btn.style.pointerEvents = ''; }
    if (status) delete status.dataset.busy;
  }
};

window.saveAppearanceProfile = async function() {
  const appearance_profile = {};
  for (const f of APPEARANCE_FIELDS) {
    appearance_profile[f.key] = document.getElementById(`ap-${f.key}`)?.value?.trim() || '';
  }
  const image_ref = normalizeImageRefs(window._appearanceImageRefs);
  image_ref.special_enabled = !!document.getElementById('ap-special-enabled')?.checked;
  image_ref.special_label = String(document.getElementById('ap-special-label')?.value || '').trim().slice(0, 40);
  try {
    await api.saveAppearance(_charId, {
      appearance_profile,
      image_ref,
      image_style: window._appearanceImageStyle || 'anime',
    });
    await window.refreshAppData?.();
    window.showToast?.('已保存');
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

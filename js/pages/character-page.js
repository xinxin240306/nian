/* ===== 角色管理页 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { ICON_IMPORT, ICON_PLUS } from '../ui-icons.js';
import { pickCropAndUpload, momentsCoverAspect } from '../media-crop.js';
import { downloadTextFile, downloadResultToast } from '../download-file.js';
import {
  DEFAULT_VIDEO_MOTION_PROMPT,
  getDefaultSelfieStylePrompt,
} from '../image-style-defaults.js';

const TRAIT_CATEGORY_BLOCKS = [
  { key: '喜欢', id: 'cf-trait-like', placeholder: '一行一条。例：深夜散步、爵士乐、猫' },
  { key: '不喜欢', id: 'cf-trait-dislike', placeholder: '讨厌、过敏、忌口都写这里。例：香菜、海鲜过敏、太甜' },
  { key: '擅长', id: 'cf-trait-good', placeholder: '例：调酒、弹钢琴（不爱在人前弹）、谈判' },
  { key: '不擅长', id: 'cf-trait-bad', placeholder: '例：做饭、认路、早起' },
];

const LEGACY_TRAIT_CATEGORY_MAP = {
  喜好: '喜欢',
  忌口: '不喜欢',
  习惯: '喜欢',
  擅长: '擅长',
};

function traitsToTextareas(traits) {
  const buckets = { 喜欢: [], 不喜欢: [], 擅长: [], 不擅长: [] };
  for (const t of traits || []) {
    const raw = String(t?.content || '').trim();
    if (!raw) continue;
    const cat = LEGACY_TRAIT_CATEGORY_MAP[t.category] || t.category;
    if (buckets[cat]) buckets[cat].push(raw);
  }
  return buckets;
}

function splitTraitLines(text) {
  return String(text || '')
    .split(/\n+/)
    .flatMap((line) => line.split(/[,，、;；]/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeTalkSel(v) {
  const s = String(v || 'normal').toLowerCase();
  if (['quiet', '少话', '沉闷', '0'].includes(s)) return 'quiet';
  if (['lively', '爱接话', '活跃', '2'].includes(s)) return 'lively';
  return 'normal';
}

function collectCharTraitsForSave() {
  const out = [];
  for (const block of TRAIT_CATEGORY_BLOCKS) {
    const text = document.getElementById(block.id)?.value || '';
    for (const line of splitTraitLines(text)) {
      out.push({
        category: block.key,
        content: line.slice(0, 120),
        enabled: true,
      });
    }
  }
  return out;
}

function fillTraitTextareas(traits) {
  const buckets = traitsToTextareas(traits);
  for (const block of TRAIT_CATEGORY_BLOCKS) {
    const el = document.getElementById(block.id);
    if (el) el.value = (buckets[block.key] || []).join('\n');
  }
}

function updateGeoHint() {
  const mapOn = !!document.getElementById('cf-real-world-map')?.checked;
  const namesOn = document.getElementById('cf-real-place-names')
    ? !!document.getElementById('cf-real-place-names').checked
    : true;
  const row = document.getElementById('cf-real-place-names-row');
  if (row) row.style.display = mapOn ? '' : 'none';
  const hint = document.getElementById('cf-geo-hint');
  if (!hint) return;
  if (!mapOn) {
    hint.textContent = '关上现实世界地图时，地理交给世界书补，不要套现实城市和真实路网。手填的所在地名仍按手填叫。';
  } else if (namesOn) {
    hint.textContent = '按真地图，城市、路、区、店用官方真名。手填的「角色所在地名」仍按手填叫；对应现实地区只用来查天气/路网。保存后会自动生成并绑定「地理对照」世界书。';
  } else {
    hint.textContent = '按真地图，只把城市改成化名（手填所在地名），区、路、店、地标仍用真名。保存后会自动生成「地理对照」世界书，并写上所在地和现实地区对照。';
  }
}

window.onRealWorldMapChange = function() {
  updateGeoHint();
};

window.onRealPlaceNamesChange = function() {
  updateGeoHint();
};

/* 人设文本框较小，字数一多不好改：点一下弹出放大编辑窗口，完成后同步回原文本框 */
let _textExpandOpenAt = 0;
window.openTextExpand = function(el, ev) {
  if (!el) return;
  // 部分 WebView 上 readonly+onclick 会丢点击；pointerup 再拦一次滚动误触
  if (ev) {
    if (ev.cancelable) ev.preventDefault?.();
    ev.stopPropagation?.();
    // 刚拖过滚动就别开编辑
    if (el.dataset?.expandMoved === '1') {
      delete el.dataset.expandMoved;
      return;
    }
  }
  // onclick + pointerup 双触发时只开一次
  const now = Date.now();
  if (now - _textExpandOpenAt < 400) return;
  _textExpandOpenAt = now;
  const label = el.closest('div')?.querySelector('.input-label, .settings-row-label')?.textContent?.trim() || '编辑';
  let overlay = document.getElementById('text-expand-overlay');
  if (!overlay) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="text-expand-overlay" class="overlay fullscreen" style="z-index:420">
        <div class="sheet-full">
          <div class="sheet-full-topbar">
            <span class="topbar-back" onclick="closeTextExpand()">‹</span>
            <div class="sheet-full-title" id="text-expand-title">编辑</div>
            <span style="color:var(--theme);font-weight:500;cursor:pointer;padding:4px 6px" onclick="closeTextExpand()">完成</span>
          </div>
          <div class="sheet-full-body" style="padding:16px;display:flex">
            <textarea id="text-expand-input" class="input" style="flex:1;width:100%;resize:none;font-size:15px;line-height:1.7"></textarea>
          </div>
        </div>
      </div>`);
    overlay = document.getElementById('text-expand-overlay');
    document.getElementById('text-expand-input').addEventListener('input', function () {
      if (window._textExpandTarget) window._textExpandTarget.value = this.value;
    });
  }
  const input = document.getElementById('text-expand-input');
  input.value = el.value;
  input.placeholder = el.placeholder || '';
  document.getElementById('text-expand-title').textContent = label;
  window._textExpandTarget = el;
  overlay.classList.add('active');
  setTimeout(() => input.focus(), 200);
};

/** 给可放大文本框补上触摸手势，避免偶发点了没反应 */
function bindTaExpandable(root = document) {
  root.querySelectorAll?.('textarea.ta-expandable').forEach((ta) => {
    if (ta.dataset.expandBound === '1') return;
    ta.dataset.expandBound = '1';
    let x0 = 0;
    let y0 = 0;
    let moved = false;
    ta.addEventListener('pointerdown', (e) => {
      x0 = e.clientX;
      y0 = e.clientY;
      moved = false;
      delete ta.dataset.expandMoved;
    }, { passive: true });
    ta.addEventListener('pointermove', (e) => {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) {
        moved = true;
        ta.dataset.expandMoved = '1';
      }
    }, { passive: true });
    ta.addEventListener('pointerup', (e) => {
      if (moved) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      window.openTextExpand?.(ta, e);
    });
  });
}
window.bindTaExpandable = bindTaExpandable;

window.closeTextExpand = function() {
  document.getElementById('text-expand-overlay')?.classList.remove('active');
  window._textExpandTarget = null;
};

let editingCharId = null;
let editFormData = {};

window.initCharacterPage = async function() {
  stopVocalPreview();
  if (window._skipCharListOnce) {
    window._skipCharListOnce = false;
    const id = window._pendingCharEditorId ?? null;
    window._pendingCharEditorId = undefined;
    await renderCharEditor(id);
    return;
  }

  const page = document.getElementById('character-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">🌸 角色</div>
      <div class="topbar-actions">
        <button type="button" class="topbar-action" onclick="importCharCard()" title="导入角色卡" aria-label="导入角色卡">${ICON_IMPORT}</button>
        <button type="button" class="topbar-action" onclick="openCharEditor(null)" title="添加角色">${ICON_PLUS}</button>
      </div>
    </div>
    <div class="scroll-area" id="char-list" style="padding:12px 0">
      <div class="loading"><div class="loading-spinner"></div></div>
    </div>
    <input type="file" id="char-card-import-input" accept=".json,application/json" style="display:none" onchange="handleCharCardImport(event)">
  `;
  await loadChars();
};

async function loadChars() {
  const list = document.getElementById('char-list');
  try {
    const allChars = await api.getCharacters();
    // 圈子 NPC 挂的轻量角色不进角色编辑列表（在通讯录里管）
    const chars = (allChars || []).filter((c) => !(
      c?.is_circle_npc || c?.source === 'circle_npc' || Number(c?.circle_npc_id) > 0
    ));
    const importBar = `
      <div style="display:flex;justify-content:flex-end;gap:6px;padding:0 12px 8px">
        <button type="button" class="btn btn-ghost btn-sm" onclick="importCharCard()">导入角色卡</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="openCharEditor(null)">＋ 新建</button>
      </div>`;
    if (!chars.length) {
      list.innerHTML = `
        ${importBar}
        <div class="empty-state">
          <div class="empty-icon">🌸</div>
          <div class="empty-text">还没有角色<br>点「＋ 新建」创建，或「导入角色卡」</div>
        </div>`;
      return;
    }
    list.innerHTML = importBar + chars.map(c => `
      <div class="char-card" onclick="openCharEditor(${c.id})">
        <div style="position:relative">
          ${c.avatar ? `<img class="avatar" src="${escapeHtml(c.avatar)}" alt="">` : `<div class="avatar" style="font-size:22px">👤</div>`}
          <div class="status-dot status-${Number(c.robot_operating) === 1 ? 'operating' : (c.status || 'online')}"></div>
        </div>
        <div class="char-info">
          <div class="char-name">${escapeHtml(c.name)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openImpression(${c.id})">用户画像</div>
          <div class="btn btn-ghost btn-sm" onclick="event.stopPropagation();setActiveAndChat(${c.id})">聊天</div>
        </div>
      </div>
    `).join('');
  } catch(e) {
    list.innerHTML = '<div class="empty-state"><div class="empty-text">加载失败</div></div>';
  }
}

window.setActiveAndChat = function(id) {
  window.setActiveChar?.(id);
  window.navigateTo?.('chat');
};

window.openImpression = function(charId) {
  window.setActiveChar?.(charId);
  window._memoryInitTab = 'portrait';
  window.navigateTo?.('memory');
};

window.openCharEditor = async function(charId) {
  const page = document.getElementById('character-page');
  if (!page?.classList.contains('active')) {
    window._skipCharListOnce = true;
    window._pendingCharEditorId = charId ?? null;
    if (!window._charEditorBackMode) window._charEditorBackMode = 'goback';
    window.navigateTo?.('character');
    return;
  }
  await renderCharEditor(charId);
};

window.charEditorGoBack = function() {
  stopVocalPreview();
  if (window._charEditorBackMode === 'goback') {
    window._charEditorBackMode = null;
    window.goBack?.();
    return;
  }
  window.initCharacterPage?.();
};

async function renderCharEditor(charId) {
  stopVocalPreview();
  editingCharId = charId;
  editFormData = {};
  window._editCharMomentsCover = undefined;

  let char = {};
  if (charId) {
    try {
      char = await api.getCharacter(charId);
      editFormData = { ...char };
      window._editCharMomentsCover = char.moments_cover || '';
      try {
        window._editCharTraits = await api.getCharTraits(charId);
      } catch {
        window._editCharTraits = [];
      }
    } catch {}
  } else {
    window._editCharTraits = [];
  }

  const worldbook = await api.getWorldbook().catch(() => []);
  const emojiCats = await api.getEmojiCategories().catch(() => []);
  const allChars = await api.getCharacters().catch(() => []);

  const legacyDesc = (!char.personality && !char.background && !char.behavior && char.description) ? char.description : '';
  const cfPersonality = char.personality || legacyDesc;
  const cfBehavior = char.behavior || '';

  const page = document.getElementById('character-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="charEditorGoBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">${charId ? '编辑角色' : '创建角色'}</div>
      <button type="button" class="topbar-save" onclick="saveChar()" title="保存"></button>
    </div>
    <div class="scroll-area" style="padding:0 0 20px">
      <!-- 基本信息 -->
      <div class="settings-section">
        <div class="settings-section-title">基本信息</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:10px;padding:16px">
            <div style="display:flex;gap:16px;align-items:center;width:100%">
              <div id="char-avatar-preview" style="width:70px;height:70px;border-radius:50%;background:var(--theme-light);display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;overflow:hidden;flex-shrink:0" onclick="pickCharAvatar()">
                ${char.avatar ? `<img src="${escapeHtml(char.avatar)}" style="width:100%;height:100%;object-fit:cover">` : '👤'}
              </div>
              <input type="file" id="char-avatar-input" accept="image/*" style="display:none" onchange="handleCharAvatar(event)">
              <div style="flex:1">
                <label class="input-label">名字</label>
                <input class="input" id="cf-name" value="${escapeHtml(char.name||'')}" placeholder="角色名字">
              </div>
            </div>
            <div style="width:100%">
              <label class="input-label">人物介绍</label>
              <textarea class="input ta-expandable" id="cf-intro" readonly onclick="openTextExpand(this)" style="min-height:80px" placeholder="对外展示的人物概览，含与用户的关系；会注入对话上下文…">${escapeHtml(char.intro||'')}</textarea>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <div>现实世界地图</div>
              <div class="settings-row-sub">打开按真地图；关上由世界书补地理</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="cf-real-world-map" ${char.real_world_map?'checked':''} onchange="onRealWorldMapChange()">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row" id="cf-real-place-names-row" style="${char.real_world_map?'':'display:none'}">
            <div class="settings-row-label">
              <div>用地名真名</div>
              <div class="settings-row-sub">打开城市也用真名；关上只化城市名，路/区/店仍用真名</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="cf-real-place-names" ${char.real_place_names===0||char.real_place_names==='0'?'':'checked'} onchange="onRealPlaceNamesChange()">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <span class="settings-row-label">角色所在地名</span>
            <input class="input" id="cf-location" value="${escapeHtml(char.location_name||'')}" placeholder="如：星河之城" style="width:150px">
          </div>
          <div class="settings-row">
            <span class="settings-row-label">对应现实地区</span>
            <input class="input" id="cf-real-loc" value="${escapeHtml(char.real_location||'')}" placeholder="如：上海" style="width:150px">
          </div>
          <div class="settings-row">
            <span class="settings-row-label">角色住址</span>
            <input class="input" id="cf-home-address" value="${escapeHtml(char.home_address||'')}" placeholder="如：星河之城海棠路88号" style="width:150px">
          </div>
          <div class="settings-row">
            <span class="settings-row-label">对应现实住址</span>
            <input class="input" id="cf-real-home-address" value="${escapeHtml(char.real_home_address||'')}" placeholder="如：上海市徐汇区某某路88号" style="width:150px">
          </div>
          <div id="cf-geo-hint" style="font-size:12px;color:var(--text-secondary);line-height:1.5;padding:0 16px 12px">${!char.real_world_map
            ? '关上现实世界地图时，地理交给世界书补，不要套现实城市和真实路网。手填的所在地名仍按手填叫。'
            : (char.real_place_names===0||char.real_place_names==='0'
              ? '按真地图，只把城市改成化名（手填所在地名），区、路、店、地标仍用真名。住址同理：聊天里用「角色住址」，定位/开地图用「对应现实住址」。保存后会自动生成「地理对照」世界书。'
              : '按真地图，城市、路、区、店用官方真名。手填的「角色所在地名」仍按手填叫；对应现实地区只用来查天气/路网。住址用于在家时定位：对外说「角色住址」，钉地图用「对应现实住址」。保存后会自动生成并绑定「地理对照」世界书。')}</div>
        </div>
      </div>

      <!-- 塑造人物 -->
      <div class="settings-section">
        <div class="settings-section-title">塑造人物</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px;gap:10px">
            <label class="input-label">性格</label>
            <textarea class="input ta-expandable" id="cf-personality" readonly onclick="openTextExpand(this)" style="min-height:88px" placeholder="底色与日常状态，也写清遇事怎么反应：慢热/直球、嘴硬心软、爱撒娇还是爱怼人；吃醋/生气/对方难过时大概会怎样（阴阳、冷暴力、损一句再问、不管…），不必另开「情绪反应」栏。">${escapeHtml(cfPersonality)}</textarea>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">经历写在人格 → 档案，一键消化后写回这里。有心智时，思考和开口都从心智出发；这里可再微调。</div>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px;gap:10px">
            <label class="input-label">行为模式</label>
            <textarea class="input ta-expandable" id="cf-behavior" readonly onclick="openTextExpand(this)" style="min-height:72px" placeholder="日常习惯与价值观：作息、社交方式、对用户的一般态度、遇到冲突先退还是先顶…">${escapeHtml(cfBehavior)}</textarea>
            <div style="font-size:12px;color:var(--text-secondary)">与性格一样，可由档案一键消化写回；日常活动会据此与当前时间推演。</div>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px;gap:10px">
            <label class="input-label">对自己的印象</label>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">角色后来怎么看自己。标了「自己写下」的是他从日子里添上的，不是上面的性格栏。</div>
            <div id="cf-self-read-list" style="width:100%"></div>
            <div id="cf-self-read-form" style="width:100%;display:none">
              <div class="brain-imp-cats" id="cf-self-read-cats"></div>
              <textarea class="input" id="cf-self-read-judgment" rows="2" maxlength="48" placeholder="一句判断，第一人称" style="margin-top:8px"></textarea>
              <textarea class="input" id="cf-self-read-reason" rows="3" maxlength="180" placeholder="当时为什么会这么认为（可选）" style="margin-top:8px"></textarea>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button type="button" class="btn btn-primary btn-sm" onclick="saveCharSelfRead()">保存这条</button>
                <button type="button" class="btn btn-ghost btn-sm" onclick="cancelCharSelfRead()">取消</button>
              </div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" id="cf-self-read-add" onclick="openCharSelfReadForm()">＋ 添加</button>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px">
            <label class="input-label">对话示例</label>
            <textarea class="input ta-expandable" id="cf-lang-style" readonly onclick="openTextExpand(this)" style="min-height:80px" placeholder="贴 4～6 句短对话：用户一句 + 角色一句。同一张嘴，换不同情绪；温柔就写你这个人的温柔，别写 AI 陪伴腔：

平静
你：今天回来好晚
我：路上堵了一会儿。你吃饭了吗

温柔（示例，按人设改）
你：今天好累
我：嗯，先歇会儿。要不要我陪你坐一下。

不爽
你：我忘了回你
我：……哦。下次直接说一声就行。

反例（空壳 AI，不要当模板）：「我在听」「我理解你的感受」「你的情绪是被允许的」「我陪着你」">${escapeHtml(char.language_style||'')}</textarea>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">学句长、软硬、口癖与标点；情绪只标温度，不另开一套腔。聊天时不会照抄原句。配合「性格」效果最好。</div>
          </div>
        </div>
      </div>

      <!-- 群聊与模型 -->
      <div class="settings-section">
        <div class="settings-section-title">群聊与模型</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px;gap:8px">
            <label class="input-label">聊天模型</label>
            <div style="display:flex;gap:8px;width:100%;align-items:center">
              <input class="input" id="cf-chat-model" list="cf-chat-model-list" value="${escapeHtml(char.chat_model||'')}" placeholder="留空=用总设置里的聊天模型" style="flex:1">
              <datalist id="cf-chat-model-list"></datalist>
              <button type="button" class="btn btn-ghost btn-sm" style="white-space:nowrap" onclick="fetchCharChatModels()">获取</button>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">走总设置里的聊天 API，只换模型名。一对一和群聊都生效。</div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <div>群聊话唠度</div>
              <div class="settings-row-sub">少话：没 @ 基本不回；爱接话：空闲时更爱插嘴</div>
            </div>
            <select class="input" id="cf-group-talk" style="width:110px">
              <option value="quiet" ${normalizeTalkSel(char.group_talkativeness)==='quiet'?'selected':''}>少话</option>
              <option value="normal" ${normalizeTalkSel(char.group_talkativeness)==='normal'?'selected':''}>正常</option>
              <option value="lively" ${normalizeTalkSel(char.group_talkativeness)==='lively'?'selected':''}>爱接话</option>
            </select>
          </div>
        </div>
      </div>

      <!-- 喜好与擅长 -->
      <div class="settings-section">
        <div class="settings-section-title">喜好与擅长</div>
        <div class="settings-group">
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.55;padding:12px 16px 4px">一行一条，点框可展开大写；聊到相关话题才注入。忌口、过敏归「不喜欢」。</div>
          ${TRAIT_CATEGORY_BLOCKS.map((block) => `
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px;gap:10px">
            <label class="input-label">${block.key}</label>
            <textarea class="input ta-expandable" id="${block.id}" readonly onclick="openTextExpand(this)" style="min-height:72px" placeholder="${escapeHtml(block.placeholder)}"></textarea>
          </div>`).join('')}
        </div>
      </div>

      <!-- 人设 -->
      <div class="settings-section">
        <div class="settings-section-title">人设</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px">
            <label class="input-label">挂载世界书条目</label>
            <div class="tag-list" id="cf-worldbook-tags">
              ${worldbook.map(w => `
                <div class="tag ${(char.worldbook_ids||[]).includes(w.id)?'active':''}" data-wb-id="${w.id}" onclick="this.classList.toggle('active')">${escapeHtml(w.title)}</div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>

      <!-- 权限设置 -->
      <div class="settings-section">
        <div class="settings-section-title">权限设置</div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row-label">
              <div>屏幕聊天优先显示</div>
              <div class="settings-row-sub">已改由桌面「TA」绑定角色控制识屏；此处开关仅作兼容显示，请到 TA 里绑定</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="cf-screen-chat-priority" ${char.screen_chat_priority?'checked':''} disabled>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <div>写日记</div>
              <div class="settings-row-sub">关闭后不再自动/手动生成该角色日记</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="cf-diary-enabled" ${char.diary_enabled!==0?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <div>日程</div>
              <div class="settings-row-sub">关闭后不再生成该角色每日行程</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="cf-schedule-enabled" ${char.schedule_enabled!==0?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <div>可偷看用户秘密</div>
              <div class="settings-row-sub">纸张颜色、纹样等在秘密簿内点「纸张」设置</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="cf-allow-diary" ${char.allow_diary?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <span class="settings-row-label">发朋友圈</span>
            <label class="toggle">
              <input type="checkbox" id="cf-post-moments" ${char.post_moments!==0?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:10px">
            <label class="input-label">角色朋友圈封面</label>
            <div id="cf-moments-cover-preview" class="me-moments-cover-preview" style="${char.moments_cover ? `background-image:${(window.cssMediaUrl?.(char.moments_cover) || `url('${escapeHtml(char.moments_cover)}'`)}` : ''}"></div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-ghost btn-sm" type="button" onclick="pickCharMomentsCover()">更换封面</button>
              ${char.moments_cover ? `<button class="btn btn-ghost btn-sm" type="button" style="color:var(--text-secondary)" onclick="clearCharMomentsCover()">清除</button>` : ''}
            </div>
          </div>
          <div class="settings-row">
            <span class="settings-row-label">梦境影响主线记忆</span>
            <label class="toggle">
              <input type="checkbox" id="cf-dream-mem" ${char.dream_affects_memory?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- 可互评角色 -->
      <div class="settings-section">
        <div class="settings-section-title">可互评朋友圈的角色</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:16px">
            <div class="tag-list" id="cf-mutual-chars">
              ${allChars.filter(c=>c.id!==charId).map(c=>`
                <div class="tag ${(char.mutual_characters||[]).includes(c.id)?'active':''}" data-char-id="${c.id}" onclick="this.classList.toggle('active')">${escapeHtml(c.name)}</div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>

      <!-- 特殊日期 -->
      <div class="settings-section">
        <div class="settings-section-title">特殊日期</div>
        <div class="settings-group">
          <div class="settings-row">
            <span class="settings-row-label">生日</span>
            <input type="date" class="input" id="cf-birthday" value="${char.birthday||''}" style="width:160px">
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:6px;padding:12px 16px">
            <div style="display:flex;align-items:center;gap:12px;width:100%;flex-wrap:wrap">
              <span class="settings-row-label">纪念日</span>
              <input type="date" class="input" id="cf-anniversary" value="${char.anniversary||''}" style="width:160px">
            </div>
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">你们第一次正式在一起的日期。聊到「在一起多久 / 纪念日」时会调出来；到纪念日当天也会更在意。</span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:6px;padding:12px 16px">
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">春节、元宵、清明、端午、七夕、中秋、国庆、除夕、劳动节、情人节、圣诞会按角色时区自动知道，不用填。当天对话里可能提一句；开了主动消息的话早上也可能来一句，不会因此打电话。</span>
          </div>
        </div>
      </div>

      <!-- 拟声库 -->
      <div class="settings-section">
        <div class="settings-section-title">拟声库</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px;padding:12px 16px">
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">上传短音频，按场景标类型。每条可单独开关：开着才会被抽到；关掉仍保留文件。喘息请分开：<strong>前戏喘</strong>（慢、不急）、<strong>急促喘</strong>、<strong>剧烈喘</strong>；忍着出声标<strong>哼唧</strong>；高潮后那口长气标<strong>余韵叹</strong>。布料摩擦、黏液摩擦不要放这里，那些走环境音。改完须点右上角<strong>保存</strong>。最多 36 条。</div>
            <div id="cf-vocal-clips-list"></div>
            <button type="button" class="btn btn-ghost btn-sm" style="align-self:flex-start" onclick="addCharVocalClip()">＋ 添加拟声</button>
            <input type="file" id="cf-vocal-clip-input" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm,.flac" multiple style="display:none" onchange="handleCharVocalClip(event)">
          </div>
        </div>
      </div>

      <!-- 视频通话画面 -->
      <div class="settings-section">
        <div class="settings-section-title">视频通话画面</div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row-label">
              <div>画面方式</div>
              <div class="settings-row-sub">视频：用上传短片；文字：旁白当地画面，引号里是台词（只朗读引号）</div>
            </div>
            <label class="toggle" title="开=上传视频，关=文字镜头">
              <input type="checkbox" id="cf-call-video-mode" ${String(char.call_video_mode||'video').toLowerCase()!=='text'?'checked':''} onchange="onCallVideoModeChange()">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div id="cf-call-video-mode-hint" style="font-size:12px;color:var(--text-secondary);line-height:1.5;padding:0 16px 8px">${String(char.call_video_mode||'video').toLowerCase()==='text' ? '当前：文字。视频电话时整段旁白当地画面，引号里的话才会被朗读。' : '当前：视频。视频电话时播放下方上传的循环短片。'}</div>
          <div id="cf-call-video-upload-block" class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px;padding:12px 16px;${String(char.call_video_mode||'video').toLowerCase()==='text'?'display:none':''}">
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">上传一段循环动画（mp4 / webm），作为视频通话时对方看到的你。建议竖屏短片，不超过 100MB。上传后须点右上角<strong>保存</strong>。截图识图时机在通讯设置里选。</div>
            <div id="cf-call-video-preview"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm" onclick="addCharCallVideo()">＋ 上传动画</button>
              <button type="button" class="btn btn-ghost btn-sm" id="cf-call-video-clear" onclick="clearCharCallVideo()" style="display:none">清除</button>
            </div>
            <input type="file" id="cf-call-video-input" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" style="display:none" onchange="handleCharCallVideo(event)">
          </div>
        </div>
      </div>

      <!-- 形象图 -->
      <div class="settings-section">
        <div class="settings-section-title">形象参考图（自拍用）</div>
        <div class="settings-group">
          <div class="settings-row">
            <span class="settings-row-label">画风</span>
            <div style="display:flex;gap:8px">
              <div class="tag ${(char.image_style||'anime')==='anime'?'active':''}" id="style-anime" onclick="selectImageStyle('anime')" style="cursor:pointer">虚拟（动漫）</div>
              <div class="tag ${char.image_style==='real'?'active':''}" id="style-real" onclick="selectImageStyle('real')" style="cursor:pointer">真实（写真）</div>
            </div>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:6px;padding:12px 16px">
            <span class="settings-row-label">居住环境 / 在家生图场景</span>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">仅「在家」自拍/配视频静图时注入。外出按日程地点与所在地生成，不会套家里装修。中英文均可；留空则从「背景故事」里自动推断（别墅、海景、落地窗等）。</div>
            <textarea class="input ta-expandable" id="cf-home-environment" readonly onclick="openTextExpand(this)" rows="4" style="min-height:88px;resize:vertical;font-size:12px;line-height:1.45" placeholder="例：海边半山豪宅客厅，整面落地窗对海，极简白沙发，傍晚金色天光">${escapeHtml((char.home_environment || '').trim())}</textarea>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
              <button type="button" class="btn btn-ghost btn-sm" id="cf-expand-home-env-btn" onclick="expandHomeEnvironmentPrompt()" title="用聊天 API 把上面的简短描述扩成详细英文提示词">⚡ 生成详细英文提示词</button>
              <button type="button" class="btn btn-ghost btn-sm" id="cf-fill-home-env-btn" onclick="fillHomeEnvironmentFromPrompt()" title="把英文提示词反向填回居住环境">↑ 反填回居住环境</button>
              <span id="cf-expand-home-env-status" style="font-size:12px;color:var(--text-secondary);align-self:center"></span>
            </div>
            <textarea class="input" id="cf-home-env-expanded" rows="3" placeholder="（生成的英文提示词显示在这里，可手工微调后点「反填回居住环境」）" style="display:none;font-size:12px;line-height:1.45;resize:vertical;margin-top:6px"></textarea>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px;padding:12px 16px">
            <span class="settings-row-label">家装参考图</span>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">上传家里实景/装修图，并写简短说明（如「卧室落地窗」「客厅沙发区」）。<strong>仅在家自拍</strong>时会按说明匹配；外出场景不会用。上传后须点页面底部<strong>保存</strong>。最多 6 张。</div>
            <div id="cf-home-refs-list" style="display:flex;flex-direction:column;gap:10px"></div>
            <button type="button" class="btn btn-ghost btn-sm" style="align-self:flex-start" onclick="addCharHomeRef()">＋ 添加家装图</button>
            <input type="file" id="cf-home-ref-input" accept="image/*" style="display:none" onchange="handleCharHomeRef(event)">
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:6px;padding:12px 16px">
            <span class="settings-row-label">自拍 / 场景静图画风提示词</span>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">英文；切换画风会填入对应默认。可自己改，保存后自拍与配视频静图都用这里。</div>
            <textarea class="input ta-expandable" id="cf-selfie-style-prompt" readonly onclick="openTextExpand(this)" rows="5" style="min-height:110px;resize:vertical;font-size:12px;line-height:1.45">${escapeHtml((char.selfie_style_prompt || '').trim() || getDefaultSelfieStylePrompt(char.image_style || 'anime'))}</textarea>
            <button type="button" class="btn btn-ghost btn-sm" style="align-self:flex-start" onclick="resetSelfieStylePrompt()">恢复当前画风默认</button>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:6px;padding:12px 16px">
            <span class="settings-row-label">视频动作气质提示词</span>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5">英文；控制运镜气质。场景静图会作为视频<strong>起始帧</strong>。表情跟聊天 / 「配视频：」场景走；默认禁止镜头畸变、禁止表情过载。</div>
            <textarea class="input ta-expandable" id="cf-video-motion-prompt" readonly onclick="openTextExpand(this)" rows="5" style="min-height:110px;resize:vertical;font-size:12px;line-height:1.45">${escapeHtml((char.video_motion_prompt || '').trim() || DEFAULT_VIDEO_MOTION_PROMPT)}</textarea>
            <button type="button" class="btn btn-ghost btn-sm" style="align-self:flex-start" onclick="resetVideoMotionPrompt()">恢复默认</button>
          </div>
          <div class="settings-row">
            <span class="settings-row-label">自拍比例</span>
            <select class="input" id="cf-image-aspect" style="width:160px">
              ${['3:4', '1:1', '9:16', '4:3', '16:9'].map(a =>
                `<option value="${a}" ${(char.image_aspect || '3:4') === a ? 'selected' : ''}>${a}${a === '3:4' ? '（竖图推荐）' : a === '1:1' ? '（方形）' : a === '9:16' ? '（全屏竖）' : a === '16:9' ? '（横屏）' : ''}</option>`
              ).join('')}
            </select>
          </div>
          <div style="font-size:11px;color:var(--text-secondary);padding:0 16px 8px;line-height:1.45">自拍用人像比例；风景/空镜会自动改横屏（16:9），美食静物等多用竖图，不必手改。</div>
          <div class="settings-row">
            <span class="settings-row-label">视频比例</span>
            <select class="input" id="cf-video-aspect" style="width:160px">
              ${['9:16', '3:4', '16:9', '4:3', '1:1'].map(a =>
                `<option value="${a}" ${(char.video_aspect || char.image_aspect || '9:16') === a ? 'selected' : ''}>${a}${a === '9:16' ? '（竖屏默认）' : a === '16:9' ? '（横屏）' : a === '1:1' ? '（无方屏→竖屏）' : ''}</option>`
              ).join('')}
            </select>
          </div>
          <div style="font-size:11px;color:var(--text-secondary);padding:0 16px 8px;line-height:1.45">人像/自拍向短视频用上面竖屏；风景类短视频会自动改横屏。</div>
          <button type="button" class="settings-row friend-settings-row" style="width:100%;border:none;background:transparent;text-align:left" onclick="openAppearanceFromCharEdit()">
            <span class="settings-row-label">外貌档案与参考图</span>
            <span class="friend-settings-row-chevron">›</span>
          </button>
          <div style="font-size:11px;color:var(--text-secondary);padding:0 16px 12px;line-height:1.45">正脸/身体/手部参考图、身高发色等已移至衣柜 → 外貌档案；此处保留家装与画风设置。</div>
        </div>
      </div>

      ${charId ? `
      <div style="padding:0 12px 12px;display:flex;gap:8px">
        <button class="btn btn-ghost" style="flex:1" onclick="exportCharCard(${charId})">导出角色卡</button>
        <button class="btn btn-ghost" style="flex:1" onclick="importCharCard()">导入角色卡</button>
      </div>
      <div style="padding:0 12px 20px">
        <button class="btn btn-danger" style="width:100%" onclick="deleteChar(${charId})">删除角色</button>
      </div>
      ` : `
      <div style="padding:0 12px 20px">
        <button class="btn btn-ghost" style="width:100%" onclick="importCharCard()">导入角色卡</button>
      </div>
      `}
    </div>
  `;

  window._editCharAvatarUrl = char.avatar || '';
  window._editCharImageRefs = normalizeEditImageRefs(char.image_ref);
  window._editCharHomeRefs = normalizeEditHomeRefs(char.home_refs);
  window._editCharVocalClips = normalizeEditVocalClips(char.vocal_clips);
  window._editCharCallVideo = String(char.call_video || '').trim();
  window._editCharCallVideoMode = String(char.call_video_mode || 'video').toLowerCase() === 'text' ? 'text' : 'video';
  window._editCharImageStyle = char.image_style || 'anime';
  fillTraitTextareas(window._editCharTraits || []);
  renderCharHomeRefs();
  renderCharVocalClips();
  renderCharCallVideo();
  syncCallVideoModeUi();
  renderCharSelfReads();
  bindTaExpandable(page);
};

window.openAppearanceFromCharEdit = function() {
  const id = editingCharId || window.getActiveCharId?.();
  if (!id) {
    window.showToast?.('请先保存角色');
    return;
  }
  window._appearanceCharId = id;
  window._appearanceBack = 'character';
  window.navigateTo('appearance');
};

const IMAGE_REF_LIMITS = { face: 3, body: 2, hands: 2, fullbody: 2, special: 3 };
const HOME_REF_MAX = 6;

function normalizeEditImageRefs(raw) {
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

function normalizeEditHomeRefs(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw || '[]'); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      if (typeof item === 'string' && item.trim()) return { url: item.trim(), label: '' };
      const url = String(item?.url || '').trim();
      if (!url) return null;
      return {
        url,
        label: String(item?.label || item?.desc || '').trim().slice(0, 40),
      };
    })
    .filter(Boolean)
    .slice(0, HOME_REF_MAX);
}

function renderCharHomeRefs() {
  const list = document.getElementById('cf-home-refs-list');
  if (!list) return;
  const refs = window._editCharHomeRefs = normalizeEditHomeRefs(window._editCharHomeRefs);
  if (!refs.length) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-secondary)">还没有家装图，点下方添加</div>`;
    return;
  }
  list.innerHTML = refs.map((r, i) => `
    <div style="display:flex;gap:10px;align-items:flex-start;padding:8px;border:1px solid var(--border);border-radius:12px;background:var(--bg-secondary,transparent)">
      <div style="position:relative;flex-shrink:0">
        <img src="${escapeHtml(r.url)}" alt="" style="width:72px;height:72px;border-radius:10px;object-fit:cover;border:1px solid var(--border);cursor:pointer" onclick="window.open(this.src,'_blank')">
        <div onclick="removeCharHomeRef(${i})" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;
          background:#e53935;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;z-index:1">✕</div>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">简短说明</div>
        <input class="input" type="text" maxlength="40" value="${escapeHtml(r.label || '')}"
          placeholder="例：卧室落地窗 / 客厅沙发区"
          oninput="updateCharHomeRefLabel(${i}, this.value)"
          style="width:100%;font-size:13px">
      </div>
    </div>
  `).join('');
}

window.addCharHomeRef = function() {
  const refs = window._editCharHomeRefs = normalizeEditHomeRefs(window._editCharHomeRefs);
  if (refs.length >= HOME_REF_MAX) {
    window.showToast?.(`家装图最多 ${HOME_REF_MAX} 张`);
    return;
  }
  document.getElementById('cf-home-ref-input')?.click();
};

window.handleCharHomeRef = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const result = await pickCropAndUpload(file, {
      title: '裁剪家装参考图',
      aspect: null,
    });
    if (!result) return;
    const refs = window._editCharHomeRefs = normalizeEditHomeRefs(window._editCharHomeRefs);
    if (refs.length >= HOME_REF_MAX) {
      window.showToast?.(`家装图最多 ${HOME_REF_MAX} 张`);
      return;
    }
    refs.push({ url: result.url, label: '' });
    renderCharHomeRefs();
  } catch {
    window.showToast?.('上传失败');
  }
  e.target.value = '';
};

window.updateCharHomeRefLabel = function(index, value) {
  const refs = window._editCharHomeRefs = normalizeEditHomeRefs(window._editCharHomeRefs);
  if (!refs[index]) return;
  refs[index].label = String(value || '').trim().slice(0, 40);
};

window.removeCharHomeRef = function(index) {
  const refs = window._editCharHomeRefs = normalizeEditHomeRefs(window._editCharHomeRefs);
  refs.splice(index, 1);
  renderCharHomeRefs();
};

const VOCAL_CLIP_MAX = 36;
const VOCAL_CLIP_MAX_BYTES = 8 * 1024 * 1024;
const VOCAL_KINDS = [
  { id: 'breath', label: '呼吸', group: '日常' },
  { id: 'pant', label: '喘息', group: '日常' },
  { id: 'sigh', label: '叹气', group: '日常' },
  { id: 'laugh', label: '轻笑', group: '日常' },
  { id: 'moan', label: '轻吟', group: '日常' },
  { id: 'hmm', label: '嗯哼', group: '日常' },
  { id: 'gulp', label: '吞咽', group: '日常' },
  { id: 'cough', label: '咳嗽', group: '日常' },
  { id: 'sob', label: '抽泣', group: '日常' },
  { id: 'kiss', label: '亲吻', group: '日常' },
  { id: 'nsfw_pant_soft', label: '前戏喘', group: '亲密' },
  { id: 'nsfw_pant', label: '急促喘', group: '亲密' },
  { id: 'nsfw_pant_hard', label: '剧烈喘', group: '亲密' },
  { id: 'nsfw_hum', label: '哼唧', group: '亲密' },
  { id: 'nsfw_moan', label: '娇吟', group: '亲密' },
  { id: 'nsfw_whimper', label: '呜咽', group: '亲密' },
  { id: 'nsfw_climax', label: '高潮', group: '亲密' },
  { id: 'nsfw_afterglow', label: '余韵叹', group: '亲密' },
  { id: 'custom', label: '自定义', group: '其他' },
];
const VOCAL_KIND_IDS = new Set(VOCAL_KINDS.map((k) => k.id));

function vocalKindLabel(kind) {
  return VOCAL_KINDS.find((k) => k.id === kind)?.label || '自定义';
}

function vocalClipUid() {
  return `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function guessVocalKind(filename) {
  const n = String(filename || '').toLowerCase();
  const pairs = [
    [/afterglow|余韵|事后叹|事后/, 'nsfw_afterglow'],
    [/climax|orgasm|高潮|去了|高潮喘/, 'nsfw_climax'],
    [/前戏|慢喘|轻喘|软喘|foreplay|soft.?pant/, 'nsfw_pant_soft'],
    [/剧烈|猛喘|狠喘|hard.?pant|rough.?pant|intense.?pant/, 'nsfw_pant_hard'],
    [/哼唧|nasal|hum(?:ming)?/, 'nsfw_hum'],
    [/急促喘|急喘|色喘|娇喘|浪喘|nsfw.?pant|erotic.?pant|hentai.?pant/, 'nsfw_pant'],
    [/娇吟|浪叫|ahegao|nsfw.?moan|erotic.?moan|hentai.?moan/, 'nsfw_moan'],
    [/呜咽|娇哼|nsfw.?whimper|erotic.?whimper/, 'nsfw_whimper'],
    [/pant|喘/, 'pant'],
    [/breath|呼吸|呼气|吸气/, 'breath'],
    [/sigh|叹气|唉声/, 'sigh'],
    [/laugh|chuckle|笑|哈哈/, 'laugh'],
    [/moan|吟|嗯啊/, 'moan'],
    [/gulp|吞|咽/, 'gulp'],
    [/cough|咳/, 'cough'],
    [/sob|抽泣|哽咽|哭腔/, 'sob'],
    [/hmm|哼|嗯哼/, 'hmm'],
    [/kiss|吻|亲亲/, 'kiss'],
  ];
  for (const [re, kind] of pairs) {
    if (re.test(n)) return kind;
  }
  return 'custom';
}

function normalizeEditVocalClips(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw || '[]'); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const url = String(item?.url || '').trim();
    if (!url) continue;
    const id = String(item?.id || vocalClipUid()).slice(0, 40);
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = VOCAL_KIND_IDS.has(item?.kind) ? item.kind : 'custom';
    let name = String(item?.name || item?.label || '').trim().slice(0, 24);
    if (name === '色喘' && kind === 'nsfw_pant') name = '急促喘';
    const enabled = !(item?.enabled === 0 || item?.enabled === false || item?.enabled === '0');
    out.push({
      id,
      url,
      kind,
      name: name || vocalKindLabel(kind),
      duration: Math.max(0, Math.min(120, Number(item?.duration) || 0)),
      enabled: enabled ? 1 : 0,
    });
    if (out.length >= VOCAL_CLIP_MAX) break;
  }
  return out;
}

function vocalMediaUrl(url) {
  return window.resolveMediaUrl?.(url) || url;
}

function probeVocalDuration(url) {
  return new Promise((resolve) => {
    const a = new Audio();
    const done = (d) => {
      a.src = '';
      resolve(Number.isFinite(d) && d > 0 ? Math.round(d * 10) / 10 : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = vocalMediaUrl(url);
  });
}

function formatVocalDuration(sec) {
  const n = Number(sec) || 0;
  if (n <= 0) return '';
  return n < 10 ? `${n.toFixed(1)}″` : `${Math.round(n)}″`;
}

function stopVocalPreview() {
  const a = window._vocalPreviewAudio;
  if (!a) return;
  try { a.pause(); } catch {}
  a.removeAttribute('src');
  try { a.load?.(); } catch {}
  window._vocalPreviewAudio = null;
  window._vocalPreviewId = null;
  document.querySelectorAll('.vocal-clip-play.is-playing').forEach((el) => {
    el.classList.remove('is-playing');
    el.textContent = '▶';
  });
}

function renderCharVocalClips() {
  const list = document.getElementById('cf-vocal-clips-list');
  if (!list) return;
  const clips = window._editCharVocalClips = normalizeEditVocalClips(window._editCharVocalClips);
  if (!clips.length) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-secondary)">还没有拟声，点下方添加</div>`;
    return;
  }
  const kindOpts = (cur) => {
    const groups = [];
    for (const k of VOCAL_KINDS) {
      const g = k.group || '其他';
      let bucket = groups.find((x) => x.label === g);
      if (!bucket) {
        bucket = { label: g, items: [] };
        groups.push(bucket);
      }
      bucket.items.push(k);
    }
    return groups.map((g) =>
      `<optgroup label="${g.label}">${g.items.map((k) =>
        `<option value="${k.id}" ${k.id === cur ? 'selected' : ''}>${k.label}</option>`
      ).join('')}</optgroup>`
    ).join('');
  };
  list.innerHTML = clips.map((c, i) => `
    <div class="vocal-clip-row${c.enabled ? '' : ' is-off'}" data-vocal-id="${escapeHtml(c.id)}">
      <button type="button" class="vocal-clip-play${window._vocalPreviewId === c.id ? ' is-playing' : ''}"
        onclick="toggleCharVocalPreview(${i})" title="试听">${window._vocalPreviewId === c.id ? '■' : '▶'}</button>
      <div class="vocal-clip-meta">
        <div class="vocal-clip-line">
          <select class="input" onchange="updateCharVocalClip(${i},'kind',this.value)" style="width:112px;flex-shrink:0">${kindOpts(c.kind)}</select>
          <input class="input" type="text" maxlength="24" value="${escapeHtml(c.name || '')}"
            placeholder="备注，如：急喘 / 睡醒时"
            oninput="updateCharVocalClip(${i},'name',this.value)"
            style="flex:1;min-width:0;font-size:13px">
        </div>
        <div class="vocal-clip-dur">${formatVocalDuration(c.duration) || '时长未知'}${c.enabled ? '' : ' · 已关闭'}</div>
      </div>
      <label class="toggle vocal-clip-toggle" title="${c.enabled ? '关闭这条拟声' : '开启这条拟声'}">
        <input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="updateCharVocalClip(${i},'enabled',this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <button type="button" class="vocal-clip-del" onclick="removeCharVocalClip(${i})" title="删除">✕</button>
    </div>
  `).join('');
}

window.addCharVocalClip = function() {
  const clips = window._editCharVocalClips = normalizeEditVocalClips(window._editCharVocalClips);
  if (clips.length >= VOCAL_CLIP_MAX) {
    window.showToast?.(`拟声最多 ${VOCAL_CLIP_MAX} 条`);
    return;
  }
  const el = document.getElementById('cf-vocal-clip-input');
  if (!el) return;
  el.value = '';
  el.click();
};

window.handleCharVocalClip = async function(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  const clips = window._editCharVocalClips = normalizeEditVocalClips(window._editCharVocalClips);
  let added = 0;
  let lastErr = '';
  for (const file of files) {
    if (clips.length >= VOCAL_CLIP_MAX) {
      lastErr = `拟声最多 ${VOCAL_CLIP_MAX} 条`;
      break;
    }
    const mime = String(file.type || '');
    const name = String(file.name || '');
    if (mime && !mime.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|ogg|webm|flac|mp4)$/i.test(name)) {
      lastErr = '请选择音频文件';
      continue;
    }
    if (file.size > VOCAL_CLIP_MAX_BYTES) {
      lastErr = '单条拟声不要超过 8MB';
      continue;
    }
    try {
      if (!added) window.showToast?.('上传中…');
      const result = await api.uploadFile(file);
      if (!result?.url) throw new Error('上传失败');
      const kind = guessVocalKind(name);
      const clip = {
        id: vocalClipUid(),
        url: result.url,
        kind,
        name: vocalKindLabel(kind),
        duration: 0,
        enabled: 1,
      };
      clip.duration = await probeVocalDuration(result.url);
      clips.push(clip);
      added++;
    } catch (err) {
      lastErr = err?.message || '上传失败';
    }
  }
  if (added) {
    renderCharVocalClips();
    window.showToast?.(added === 1 ? '已添加，记得保存' : `已添加 ${added} 条，记得保存`);
  } else if (lastErr) {
    window.showToast?.(lastErr);
  }
};

window.updateCharVocalClip = function(index, field, value) {
  const clips = window._editCharVocalClips = normalizeEditVocalClips(window._editCharVocalClips);
  if (!clips[index]) return;
  if (field === 'kind') {
    const next = VOCAL_KIND_IDS.has(value) ? value : 'custom';
    clips[index].kind = next;
    if (!clips[index].name || VOCAL_KINDS.some((k) => k.label === clips[index].name)) {
      clips[index].name = vocalKindLabel(next);
      renderCharVocalClips();
    }
    return;
  }
  if (field === 'name') {
    clips[index].name = String(value || '').trim().slice(0, 24);
    return;
  }
  if (field === 'enabled') {
    clips[index].enabled = value ? 1 : 0;
    renderCharVocalClips();
  }
};

window.toggleCharVocalPreview = function(index) {
  const clips = window._editCharVocalClips = normalizeEditVocalClips(window._editCharVocalClips);
  const clip = clips[index];
  if (!clip?.url) return;
  if (window._vocalPreviewId === clip.id) {
    stopVocalPreview();
    renderCharVocalClips();
    return;
  }
  stopVocalPreview();
  const a = new Audio();
  a.preload = 'auto';
  a.onended = () => {
    stopVocalPreview();
    renderCharVocalClips();
  };
  a.onerror = () => {
    stopVocalPreview();
    window.showToast?.('这条拟声播放失败');
    renderCharVocalClips();
  };
  window._vocalPreviewAudio = a;
  window._vocalPreviewId = clip.id;
  a.src = vocalMediaUrl(clip.url);
  a.play().catch((err) => {
    stopVocalPreview();
    window.showToast?.(err?.message || '无法播放');
    renderCharVocalClips();
  });
  renderCharVocalClips();
};

window.removeCharVocalClip = function(index) {
  const clips = window._editCharVocalClips = normalizeEditVocalClips(window._editCharVocalClips);
  const gone = clips[index];
  if (gone && window._vocalPreviewId === gone.id) stopVocalPreview();
  clips.splice(index, 1);
  renderCharVocalClips();
};

const CALL_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

function syncCallVideoModeUi() {
  const on = !!document.getElementById('cf-call-video-mode')?.checked;
  const hint = document.getElementById('cf-call-video-mode-hint');
  const block = document.getElementById('cf-call-video-upload-block');
  if (hint) {
    hint.textContent = on
      ? '当前：视频。视频电话时播放下方上传的循环短片。'
      : '当前：文字。视频电话时整段旁白当地画面，引号里的话才会被朗读。';
  }
  if (block) block.style.display = on ? '' : 'none';
}

window.onCallVideoModeChange = function() {
  syncCallVideoModeUi();
};

function renderCharCallVideo() {
  const preview = document.getElementById('cf-call-video-preview');
  const clearBtn = document.getElementById('cf-call-video-clear');
  const url = String(window._editCharCallVideo || '').trim();
  if (clearBtn) clearBtn.style.display = url ? '' : 'none';
  if (!preview) return;
  if (!url) {
    preview.innerHTML = '<div style="font-size:12px;color:var(--text-secondary)">还没有通话动画，切到视频模式且未上传时会用头像当画面。</div>';
    return;
  }
  const src = escapeHtml(vocalMediaUrl(url));
  preview.innerHTML = `<video src="${src}" muted loop playsinline controls style="width:100%;max-height:220px;border-radius:12px;background:#111;object-fit:contain"></video>`;
}

window.addCharCallVideo = function() {
  document.getElementById('cf-call-video-input')?.click();
};

window.clearCharCallVideo = function() {
  window._editCharCallVideo = '';
  renderCharCallVideo();
  window.showToast?.('已清除，记得保存');
};

window.handleCharCallVideo = async function(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const mime = String(file.type || '');
  const name = String(file.name || '');
  if (mime && !mime.startsWith('video/') && !/\.(mp4|webm|mov)$/i.test(name)) {
    window.showToast?.('请选择 mp4 / webm 视频');
    return;
  }
  if (file.size > CALL_VIDEO_MAX_BYTES) {
    window.showToast?.('视频不要超过 100MB，可压成短循环动画');
    return;
  }
  try {
    window.showToast?.('上传中…');
    const result = await api.uploadFile(file);
    if (!result?.url) throw new Error('上传失败');
    window._editCharCallVideo = result.url;
    renderCharCallVideo();
    window.showToast?.('已添加，记得保存');
  } catch (err) {
    window.showToast?.(err?.message || '上传失败');
  }
};

function flattenEditImageRefs(groups) {
  const g = normalizeEditImageRefs(groups);
  return [...g.face, ...g.body, ...g.fullbody, ...g.hands].filter(Boolean).slice(0, 6);
}

function renderCharImageRefGrid() {
  const g = window._editCharImageRefs = normalizeEditImageRefs(window._editCharImageRefs);
  for (const slot of ['face', 'body', 'fullbody', 'hands']) {
    const grid = document.getElementById(`cf-ref-${slot}-grid`);
    if (!grid) continue;
    const refs = g[slot] || [];
    grid.innerHTML = refs.map((url, i) => `
      <div style="position:relative;width:72px;height:72px">
        <img src="${escapeHtml(url)}" style="width:72px;height:72px;border-radius:10px;object-fit:cover;border:1px solid var(--border)">
        <div onclick="removeCharImageRef('${slot}',${i})" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;
          background:#e53935;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;z-index:1">✕</div>
      </div>
    `).join('');
  }
}

window.selectImageStyle = function(style) {
  const prev = window._editCharImageStyle || 'anime';
  const ta = document.getElementById('cf-selfie-style-prompt');
  if (ta) {
    const cur = ta.value.trim();
    const prevDefault = getDefaultSelfieStylePrompt(prev);
    if (!cur || cur === prevDefault) {
      ta.value = getDefaultSelfieStylePrompt(style);
    }
  }
  window._editCharImageStyle = style;
  document.getElementById('style-anime')?.classList.toggle('active', style === 'anime');
  document.getElementById('style-real')?.classList.toggle('active', style === 'real');
};

window.resetSelfieStylePrompt = function() {
  const style = window._editCharImageStyle || 'anime';
  const ta = document.getElementById('cf-selfie-style-prompt');
  if (ta) ta.value = getDefaultSelfieStylePrompt(style);
};

window.expandHomeEnvironmentPrompt = async function() {
  const charId = editingCharId || window.getActiveCharId?.();
  if (!charId) {
    window.showToast?.('请先保存角色，再生成提示词');
    return;
  }
  const raw = document.getElementById('cf-home-environment')?.value?.trim() || '';
  if (!raw) {
    window.showToast?.('请先在上方填写居住环境描述');
    return;
  }
  const btn = document.getElementById('cf-expand-home-env-btn');
  const status = document.getElementById('cf-expand-home-env-status');
  const out = document.getElementById('cf-home-env-expanded');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  if (status) status.textContent = '正在用聊天 API 扩写…';
  try {
    const r = await api.expandHomeEnvironment(charId, raw);
    if (r.ok && r.prompt) {
      if (out) { out.style.display = ''; out.value = r.prompt; }
      if (status) status.textContent = '✓ 已生成，可点击下方按钮反填回居住环境';
    } else {
      if (status) status.textContent = r.error || '生成失败';
      window.showToast?.(r.error || '生成失败');
    }
  } catch (e) {
    if (status) status.textContent = e.message || '请求失败';
    window.showToast?.(e.message || '请求失败');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ 生成详细英文提示词'; }
  }
};

window.fillHomeEnvironmentFromPrompt = function() {
  const out = document.getElementById('cf-home-env-expanded');
  const target = document.getElementById('cf-home-environment');
  if (!out || !target) return;
  const text = out.value?.trim();
  if (!text) {
    window.showToast?.('请先生成英文提示词');
    return;
  }
  target.value = text;
  window.showToast?.('已反填，记得点页面顶部「保存」');
};

window.resetVideoMotionPrompt = function() {
  const ta = document.getElementById('cf-video-motion-prompt');
  if (ta) ta.value = DEFAULT_VIDEO_MOTION_PROMPT;
};

window.addCharImageRef = function(slot = 'face') {
  const g = window._editCharImageRefs = normalizeEditImageRefs(window._editCharImageRefs);
  const limit = IMAGE_REF_LIMITS[slot] || 2;
  if ((g[slot] || []).length >= limit) {
    const labels = { face: '正脸', body: '身体', hands: '手部', fullbody: '全身比例' };
    window.showToast?.(`${labels[slot] || slot}最多 ${limit} 张`);
    return;
  }
  window._editImageRefSlot = slot;
  document.getElementById('cf-image-ref-input')?.click();
};

window.handleCharImageRef = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const slot = window._editImageRefSlot || 'face';
  try {
    let aspect;
    if (slot === 'hands') aspect = 1;
    else if (slot === 'fullbody') aspect = 9 / 16; // 全身比例图：竖版，全身完整可见
    else aspect = 3 / 4;
    const titles = {
      face: '裁剪正脸参考',
      body: '裁剪身体参考',
      hands: '裁剪手部参考',
      fullbody: '裁剪全身比例参考',
    };
    const result = await pickCropAndUpload(file, {
      title: titles[slot] || '裁剪参考图',
      aspect,
    });
    if (!result) return;
    const g = window._editCharImageRefs = normalizeEditImageRefs(window._editCharImageRefs);
    g[slot] = g[slot] || [];
    g[slot].push(result.url);
    renderCharImageRefGrid();
  } catch { window.showToast?.('上传失败'); }
  e.target.value = '';
};

window.removeCharImageRef = function(slot, index) {
  const g = window._editCharImageRefs = normalizeEditImageRefs(window._editCharImageRefs);
  g[slot]?.splice(index, 1);
  renderCharImageRefGrid();
};

window.testCharSelfieImage = async function() {
  const refs = flattenEditImageRefs(window._editCharImageRefs);
  if (!refs.length) {
    window.showToast?.('请先上传至少一张正脸参考图');
    return;
  }
  const homeRefs = normalizeEditHomeRefs(window._editCharHomeRefs);
  const btn = document.getElementById('cf-test-selfie-btn');
  const wrap = document.getElementById('cf-selfie-test-wrap');
  const img = document.getElementById('cf-selfie-test-img');
  const status = document.getElementById('cf-selfie-test-status');
  if (btn) { btn.textContent = '生成中…'; btn.style.pointerEvents = 'none'; }
  if (wrap) wrap.style.display = 'block';
  if (status) {
    status.textContent = homeRefs.length
      ? `正在调用图生图 API（含 ${homeRefs.length} 张家装参考图）…`
      : '正在调用图生图 API（慢模型可能要 8～15 分钟，请勿离开）…';
  }
  try {
    const aspect = document.getElementById('cf-image-aspect')?.value || '3:4';
    const r = await api.testSelfieImage(refs, {
      aspect,
      homeRefs,
      homeEnvironment: document.getElementById('cf-home-environment')?.value?.trim() || '',
      selfieStylePrompt: document.getElementById('cf-selfie-style-prompt')?.value?.trim() || '',
      imageStyle: window._editCharImageStyle || 'anime',
      sceneQuery: homeRefs.length ? '在家自拍，背景与家装参考图一致' : '',
    });
    if (r.ok && r.url) {
      if (img) img.src = r.url;
      const hint = r.hint ? `<br><span style="color:#666;font-size:12px">${escapeHtml(r.hint)}</span>` : '';
      if (status) {
        status.innerHTML = r.usedReference
          ? `<span style="color:#43a047">✓ 生成成功（已使用参考图）</span>${hint}`
          : `<span style="color:#fb8c00">⚠ 已出图但未确认参考图生效</span>${hint}`;
      }
    } else {
      if (status) status.innerHTML = `<span style="color:#e53935">${escapeHtml(r.error || '生成失败')}</span>`;
    }
  } catch (e) {
    if (status) status.innerHTML = `<span style="color:#e53935">${escapeHtml(e.message || '请求失败')}</span>`;
  } finally {
    if (btn) { btn.textContent = '测试生成图'; btn.style.pointerEvents = ''; }
  }
};

window.pickCharAvatar = function() { document.getElementById('char-avatar-input')?.click(); };

window.handleCharAvatar = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const result = await pickCropAndUpload(file, { title: '裁剪头像', aspect: 1 });
    if (!result) return;
    window._editCharAvatarUrl = result.url;
    document.getElementById('char-avatar-preview').innerHTML = `<img src="${escapeHtml(result.url)}" style="width:100%;height:100%;object-fit:cover">`;
  } catch { window.showToast?.('上传失败'); }
  e.target.value = '';
};

window.saveChar = async function() {
  stopVocalPreview();
  try {
    const data = {
      name: document.getElementById('cf-name')?.value || '新角色',
      avatar: window._editCharAvatarUrl || '',
      intro: document.getElementById('cf-intro')?.value || '',
      real_world_map: document.getElementById('cf-real-world-map')?.checked ? 1 : 0,
      real_place_names: document.getElementById('cf-real-place-names')?.checked ? 1 : 0,
      personality: document.getElementById('cf-personality')?.value || '',
      behavior: document.getElementById('cf-behavior')?.value || '',
      language_style: document.getElementById('cf-lang-style')?.value || '',
      location_name: document.getElementById('cf-location')?.value || '',
      real_location: document.getElementById('cf-real-loc')?.value || '',
      home_address: document.getElementById('cf-home-address')?.value?.trim() || '',
      real_home_address: document.getElementById('cf-real-home-address')?.value?.trim() || '',
      screen_chat_priority: document.getElementById('cf-screen-chat-priority')?.checked ? 1 : 0,
      diary_enabled: document.getElementById('cf-diary-enabled')?.checked ? 1 : 0,
      schedule_enabled: document.getElementById('cf-schedule-enabled')?.checked ? 1 : 0,
      allow_diary: document.getElementById('cf-allow-diary')?.checked ? 1 : 0,
      post_moments: document.getElementById('cf-post-moments')?.checked ? 1 : 0,
      moments_cover: window._editCharMomentsCover || '',
      dream_affects_memory: document.getElementById('cf-dream-mem')?.checked ? 1 : 0,
      birthday: document.getElementById('cf-birthday')?.value || '',
      anniversary: document.getElementById('cf-anniversary')?.value || '',
      worldbook_ids: Array.from(document.querySelectorAll('#cf-worldbook-tags .tag.active')).map(t => parseInt(t.dataset.wbId)),
      mutual_characters: Array.from(document.querySelectorAll('#cf-mutual-chars .tag.active')).map(t => parseInt(t.dataset.charId)),
      image_ref: normalizeEditImageRefs(window._editCharImageRefs),
      image_style: window._editCharImageStyle || 'anime',
      image_aspect: document.getElementById('cf-image-aspect')?.value || '3:4',
      video_aspect: document.getElementById('cf-video-aspect')?.value || '9:16',
      selfie_style_prompt: document.getElementById('cf-selfie-style-prompt')?.value?.trim() || '',
      home_environment: document.getElementById('cf-home-environment')?.value?.trim() || '',
      home_refs: normalizeEditHomeRefs(window._editCharHomeRefs),
      vocal_clips: normalizeEditVocalClips(window._editCharVocalClips),
      call_video: String(window._editCharCallVideo || '').trim(),
      call_video_mode: document.getElementById('cf-call-video-mode')?.checked ? 'video' : 'text',
      video_motion_prompt: document.getElementById('cf-video-motion-prompt')?.value?.trim() || '',
      chat_model: document.getElementById('cf-chat-model')?.value?.trim() || '',
      group_talkativeness: document.getElementById('cf-group-talk')?.value || 'normal',
    };

    const traitsPayload = collectCharTraitsForSave();
    let savedId = editingCharId;
    if (editingCharId) {
      await api.updateCharacter(editingCharId, data);
      await api.saveCharTraits(editingCharId, traitsPayload);
    } else {
      const result = await api.createCharacter(data);
      savedId = result.id;
      window.setActiveChar?.(result.id);
      if (traitsPayload.length) await api.saveCharTraits(result.id, traitsPayload);
    }
    await window.refreshAppData?.();
    window.showToast?.('已保存');
    if (window._charEditorBackMode === 'goback') {
      window._charEditorBackMode = null;
      window.goBack?.();
    } else {
      window.initCharacterPage();
    }
  } catch(e) { window.showToast?.(e.message); }
};

window.deleteChar = async function(id) {
  if (!confirm('确定删除这个角色？所有相关数据将被清除')) return;
  try {
    await api.deleteCharacter(id);
    await window.refreshAppData?.();
    window.showToast?.('已删除');
    window.initCharacterPage();
  } catch(e) { window.showToast?.(e.message); }
};

window.exportCharCard = async function(id) {
  try {
    const data = await api.exportCharacterCard(id);
    const safeName = String(data.character?.name || id).replace(/[\\/:*?"<>|]+/g, '_');
    const r = await downloadTextFile(
      `nian-char-${safeName}-${new Date().toISOString().slice(0,10)}.json`,
      JSON.stringify(data, null, 2),
    );
    if (r.cancelled) return;
    if (!r.ok || r.via === 'anchor-unreliable') {
      window.showToast?.(downloadResultToast(r) || '导出失败：无法写入文件');
      return;
    }
    window.showToast?.(downloadResultToast(r) || '角色卡已导出');
  } catch(e) { window.showToast?.('导出失败: ' + e.message); }
};

window.importCharCard = function() {
  let input = document.getElementById('char-card-import-input');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = 'char-card-import-input';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.onchange = (ev) => window.handleCharCardImport?.(ev);
    document.body.appendChild(input);
  }
  input.value = '';
  input.click();
};

window.handleCharCardImport = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await api.importCharacterCard(data);
    await window.refreshAppData?.();
    window.showToast?.(`已导入角色：${result.name}`);
    const activeId = document.querySelector('.page.active')?.id || '';
    if (activeId === 'character-page') {
      window.initCharacterPage?.();
    } else if (activeId === 'contacts-page') {
      window.switchContactsTab?.('contacts');
    }
  } catch(err) { window.showToast?.('导入失败: ' + err.message); }
  e.target.value = '';
};

window.pickCharMomentsCover = async function() {
  try {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const result = await pickCropAndUpload(file, {
        title: '角色朋友圈封面',
        aspect: momentsCoverAspect(),
      });
      if (!result?.url) return;
      window._editCharMomentsCover = result.url;
      const preview = document.getElementById('cf-moments-cover-preview');
      if (preview) preview.style.backgroundImage = window.cssMediaUrl?.(result.url) || `url('${result.url.replace(/'/g, "\\'")}')`;
    };
    input.click();
  } catch {
    window.showToast?.('封面上传失败');
  }
};

window.clearCharMomentsCover = function() {
  window._editCharMomentsCover = '';
  const preview = document.getElementById('cf-moments-cover-preview');
  if (preview) preview.style.backgroundImage = '';
};

window.fetchCharChatModels = async function() {
  try {
    const list = await api.fetchChatModels();
    const ids = Array.isArray(list) ? list : (list?.data || list?.models || []);
    const flat = (ids || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
    const dl = document.getElementById('cf-chat-model-list');
    if (dl) dl.innerHTML = flat.map((id) => `<option value="${escapeHtml(id)}"></option>`).join('');
    window.showToast?.(flat.length ? `已获取 ${flat.length} 个模型` : '没有拉到模型');
  } catch (e) {
    window.showToast?.(e.message || '获取模型失败');
  }
};

const CHAR_SELF_CATS = ['性格', '行为', '喜好', '习惯'];
let _charSelfReads = [];
let _charSelfEditId = null;

function renderCharSelfReadCats(active = '性格') {
  const box = document.getElementById('cf-self-read-cats');
  if (!box) return;
  box.innerHTML = CHAR_SELF_CATS.map((c) =>
    `<button type="button" class="brain-cat-pill${c === active ? ' active' : ''}" data-self-read="${escapeHtml(c)}" onclick="selectCharSelfReadCat(this)">${escapeHtml(c)}</button>`
  ).join('');
}

async function renderCharSelfReads() {
  const list = document.getElementById('cf-self-read-list');
  const addBtn = document.getElementById('cf-self-read-add');
  if (!list) return;
  if (!editingCharId) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-secondary)">先保存角色，再写对自己的印象</div>`;
    if (addBtn) addBtn.style.display = 'none';
    return;
  }
  if (addBtn) addBtn.style.display = '';
  try {
    const data = await api.getSelfReads(editingCharId);
    _charSelfReads = data?.items || [];
  } catch {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-secondary)">加载失败</div>`;
    return;
  }
  if (!_charSelfReads.length) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">还没有。消化一天后，他会自己添上。</div>`;
    return;
  }
  list.innerHTML = _charSelfReads.map((r) => `
    <div class="user-read-line">
      <button type="button" class="user-read-edit" onclick="openCharSelfReadForm(${r.id})">改</button>
      <details>
        <summary>${escapeHtml(r.judgment)}${r.source === 'self' ? '<span class="user-read-badge">自己写下</span>' : ''}</summary>
        <div class="user-read-reason">${r.reason ? escapeHtml(r.reason) : '还没有写下原因'}</div>
      </details>
    </div>`).join('');
}

window.selectCharSelfReadCat = function(el) {
  document.querySelectorAll('#cf-self-read-cats .brain-cat-pill').forEach((t) => t.classList.remove('active'));
  el?.classList.add('active');
};

window.openCharSelfReadForm = function(id) {
  const form = document.getElementById('cf-self-read-form');
  if (!form) return;
  if (!editingCharId) { window.showToast?.('请先保存角色'); return; }
  _charSelfEditId = id || null;
  let cat = '性格';
  document.getElementById('cf-self-read-judgment').value = '';
  document.getElementById('cf-self-read-reason').value = '';
  if (id) {
    const row = _charSelfReads.find((x) => x.id === id);
    if (row) {
      cat = row.category || '性格';
      document.getElementById('cf-self-read-judgment').value = row.judgment || '';
      document.getElementById('cf-self-read-reason').value = row.reason || '';
    }
  }
  renderCharSelfReadCats(cat);
  form.style.display = '';
};

window.cancelCharSelfRead = function() {
  _charSelfEditId = null;
  const form = document.getElementById('cf-self-read-form');
  if (form) form.style.display = 'none';
};

window.saveCharSelfRead = async function() {
  if (!editingCharId) return;
  const cat = document.querySelector('#cf-self-read-cats .brain-cat-pill.active')?.dataset?.selfRead || '性格';
  const judgment = document.getElementById('cf-self-read-judgment')?.value?.trim();
  const reason = document.getElementById('cf-self-read-reason')?.value?.trim() || '';
  if (!judgment) { window.showToast?.('请填写判断'); return; }
  try {
    if (_charSelfEditId) {
      await api.updateUserRead(_charSelfEditId, { category: cat, judgment, reason });
    } else {
      await api.createUserRead({ characterId: editingCharId, category: cat, judgment, reason, about: 'self', source: 'manual' });
    }
    window.cancelCharSelfRead();
    window.showToast?.('已保存');
    await renderCharSelfReads();
  } catch (e) { window.showToast?.(e.message || '保存失败'); }
};


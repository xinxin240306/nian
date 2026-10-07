/* ===== 管理页（世界书 + 预设） ===== */
import { mountWorldbookTo } from './worldbook-page.js';
import { mountPresetTo } from './preset-page.js';

let _manageMounted = '';

window.initManagePage = async function() {
  const tab = window._manageTab || 'worldbook';
  const page = document.getElementById('manage-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">管理</div>
    </div>
    <div class="settings-tab-bar">
      <div class="settings-tab manage-tab ${tab === 'worldbook' ? 'active' : ''}" data-tab="worldbook" onclick="switchManageTab('worldbook')">世界书</div>
      <div class="settings-tab manage-tab ${tab === 'preset' ? 'active' : ''}" data-tab="preset" onclick="switchManageTab('preset')">预设</div>
    </div>
    <div id="manage-panel" class="scroll-area" style="flex:1;overflow-y:auto"></div>
  `;
  await switchManageTab(tab);
};

window.switchManageTab = async function(tab) {
  window._manageTab = tab;
  document.querySelectorAll('.manage-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  const panel = document.getElementById('manage-panel');
  if (!panel) return;
  if (_manageMounted === tab) {
    if (tab === 'worldbook') await window.loadWB?.();
    else await window.loadPresets?.();
    return;
  }
  _manageMounted = tab;
  if (tab === 'worldbook') await mountWorldbookTo(panel);
  else await mountPresetTo(panel);
};

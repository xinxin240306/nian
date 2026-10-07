/* ===== 世界书页 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { ICON_IMPORT, ICON_EXPORT } from '../ui-icons.js';
import { downloadTextFile, downloadResultToast } from '../download-file.js';

let editingWBId = null;

window.initWorldbookPage = async function() {
  const page = document.getElementById('worldbook-page');
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">📖 世界书</div>
      <div style="display:flex;gap:4px">
        <button type="button" class="topbar-action" onclick="exportWB()" title="导出">${ICON_EXPORT}</button>
        <button type="button" class="topbar-action" onclick="importWB()" title="导入">${ICON_IMPORT}</button>
        <button type="button" class="topbar-action" onclick="openWBEditor(null)" title="添加">＋</button>
      </div>
    </div>
    <div id="wb-mount-root" class="scroll-area" style="flex:1;overflow-y:auto"></div>
  `;
  await mountWorldbookTo(document.getElementById('wb-mount-root'));
};

export async function mountWorldbookTo(container) {
  if (!container) return;
  container.innerHTML = `
    <div style="display:flex;justify-content:flex-end;gap:6px;padding:8px 12px 0">
      <button type="button" class="btn btn-ghost btn-sm" onclick="exportWB()">导出</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="importWB()">导入</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="openWBEditor(null)">＋ 新建</button>
    </div>
    <div id="wb-list" style="padding:12px 0"></div>

    <div id="wb-edit-overlay" class="overlay center" onclick="this.classList.remove('active')">
      <div class="modal" style="width:calc(100% - 32px);max-width:440px" onclick="event.stopPropagation()">
        <div class="modal-title" id="wb-modal-title">新建条目</div>
        <div class="modal-body">
          <div class="form-group">
            <label class="input-label">标题</label>
            <input class="input" id="wb-title" placeholder="条目标题">
          </div>
          <div class="form-group">
            <label class="input-label">内容</label>
            <textarea class="input" id="wb-content" style="min-height:120px" placeholder="世界设定内容…"></textarea>
          </div>
          <div class="form-group" style="display:flex;align-items:center;gap:12px">
            <label class="input-label" style="white-space:nowrap;margin:0">权重（1-5）</label>
            <input type="number" class="input" id="wb-weight" min="1" max="5" value="3" style="width:70px">
            <span style="font-size:12px;color:var(--text-secondary)">越高越靠前注入（W5 核心设定，W3 默认，W1 氛围补充）</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('wb-edit-overlay').classList.remove('active')">取消</button>
          <button class="btn btn-primary btn-sm" onclick="saveWBEntry()">保存</button>
        </div>
      </div>
    </div>
    <input type="file" id="wb-import-input" accept=".json" style="display:none" onchange="handleWBImport(event)">
  `;
  await loadWB();
}

async function loadWB() {
  const list = document.getElementById('wb-list');
  try {
    const entries = await api.getWorldbook();
    if (!entries.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">📖</div><div class="empty-text">还没有世界书条目<br>点右上角「＋」创建</div></div>`;
      return;
    }
    list.innerHTML = entries.map(e => `
      <div class="list-item" onclick="openWBEditor(${e.id})">
        <div style="flex:1">
          <div style="font-size:15px;font-weight:400;display:flex;align-items:center;gap:6px">
            ${escapeHtml(e.title)}
            <span style="font-size:11px;padding:1px 5px;border-radius:4px;background:var(--theme-light);color:var(--theme-dark)">W${e.weight||3}</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${escapeHtml(e.content.slice(0,50))}${e.content.length>50?'…':''}</div>
        </div>
        <label class="toggle" onclick="event.stopPropagation()">
          <input type="checkbox" ${e.enabled?'checked':''} onchange="toggleWBEntry(${e.id}, this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
    `).join('');
  } catch {}
}

window.loadWB = loadWB;

window.openWBEditor = async function(id) {
  editingWBId = id;
  document.getElementById('wb-modal-title').textContent = id ? '编辑条目' : '新建条目';
  document.getElementById('wb-title').value = '';
  document.getElementById('wb-content').value = '';
  document.getElementById('wb-weight').value = '3';
  if (id) {
    try {
      const entries = await api.getWorldbook();
      const e = entries.find(x => x.id === id);
      if (e) {
        document.getElementById('wb-title').value   = e.title;
        document.getElementById('wb-content').value = e.content;
        document.getElementById('wb-weight').value  = e.weight ?? 3;
      }
    } catch {}
  }
  document.getElementById('wb-edit-overlay').classList.add('active');
};

window.saveWBEntry = async function() {
  const title   = document.getElementById('wb-title').value.trim();
  const content = document.getElementById('wb-content').value.trim();
  const weight  = parseInt(document.getElementById('wb-weight')?.value || '3');
  if (!title || !content) { window.showToast?.('标题和内容不能为空'); return; }
  try {
    if (editingWBId) {
      await api.updateWorldEntry(editingWBId, { title, content, weight, enabled: 1 });
    } else {
      await api.createWorldEntry({ title, content, weight });
    }
    document.getElementById('wb-edit-overlay').classList.remove('active');
    loadWB();
    window.showToast?.('已保存');
  } catch(e) { window.showToast?.(e.message); }
};

window.toggleWBEntry = async function(id, enabled) {
  const entries = await api.getWorldbook();
  const e = entries.find(x => x.id === id);
  if (e) await api.updateWorldEntry(id, { title: e.title, content: e.content, enabled });
};

window.exportWB = async function() {
  try {
    const data = await api.exportWorldbook();
    const r = await downloadTextFile(
      `nian-worldbook-${new Date().toISOString().slice(0,10)}.json`,
      JSON.stringify(data, null, 2),
    );
    if (r.cancelled) return;
    if (!r.ok || r.via === 'anchor-unreliable') {
      window.showToast?.(downloadResultToast(r) || '导出失败：无法写入文件');
      return;
    }
    window.showToast?.(downloadResultToast(r) || '世界书已导出');
  } catch(e) { window.showToast?.('导出失败'); }
};

window.importWB = function() { document.getElementById('wb-import-input')?.click(); };

window.handleWBImport = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const result = await api.importWorldbook(data);
    loadWB();
    const nNew = Number(result.imported) || 0;
    const nUp = Number(result.updated) || 0;
    if (nNew || nUp) {
      const parts = [];
      if (nNew) parts.push(`新增 ${nNew}`);
      if (nUp) parts.push(`更新 ${nUp}`);
      window.showToast?.(`世界书已导入（${parts.join('，')}）`);
    } else {
      window.showToast?.('没有可导入的条目');
    }
  } catch(err) { window.showToast?.('导入失败: ' + err.message); }
  e.target.value = '';
};

window.loadWB = loadWB;

/* ===== 表情包管理页 — 分类列表 → 分类详情 ===== */
import * as api from '../api.js';
import { downloadTextFile, downloadResultToast } from '../download-file.js';

let _cats = [];
let _view = 'list';
let _activeCatId = null;

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function activeCat() {
  return _cats.find(c => Number(c.id) === Number(_activeCatId));
}

function renderPageShell() {
  const page = document.getElementById('emoji-manager-page');
  const isDetail = _view === 'detail';
  const cat = activeCat();
  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="${isDetail ? 'emojiMgrBackToList()' : 'goBack()'}" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">${isDetail ? escHtml(cat?.name || '分类') : '😂 表情包管理'}</div>
      ${isDetail
        ? `<div class="topbar-back" onclick="triggerEmojiUpload(${_activeCatId})" style="color:var(--theme);font-size:13px">上传</div>`
        : `<button type="button" class="topbar-action" onclick="showAddCategoryDialog()" title="添加" style="color:var(--theme)">＋</button>`}
    </div>
    <div class="scroll-area" id="emoji-manager-body" style="padding:12px">
      <div class="loading"><div class="loading-spinner"></div>加载中…</div>
    </div>
    <input type="file" id="emoji-pack-import-input" accept=".json,.txt,.zip,application/json,text/plain,application/zip" style="display:none" onchange="handleEmojiPackImport(event)">
  `;
}

window.initEmojiManagerPage = async function() {
  _view = 'list';
  _activeCatId = null;
  renderPageShell();
  await loadEmojiManager();
};

async function loadEmojiManager() {
  const body = document.getElementById('emoji-manager-body');
  if (!body) return;
  try {
    _cats = await api.getEmojiCategories();
    if (_view === 'detail' && _activeCatId) {
      renderCategoryDetail(body);
    } else {
      _view = 'list';
      renderCategoryList(body);
    }
  } catch (e) {
    body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-secondary)">${escHtml(e.message)}</div>`;
  }
}

function renderCategoryList(body) {
  if (!_cats.length) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">😂</div>
        <div class="empty-text">还没有表情包分类<br>点击右上角 ＋ 新建，或导入 JSON/ZIP 包</div>
        <button class="btn btn-primary btn-sm" style="margin-top:16px" onclick="triggerEmojiPackImport()">导入 JSON / ZIP 包</button>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">
      点进分类管理表情；支持单张上传，也支持导入打包好的 JSON / TXT（纯 base64）或 ZIP。
    </div>
    <button class="btn btn-ghost btn-sm" style="width:100%;margin-bottom:14px" onclick="triggerEmojiPackImport()">📦 导入 JSON / ZIP 包</button>
    ${_cats.map(cat => `
      <div class="emoji-cat-card" onclick="openEmojiCategory(${cat.id})">
        <div class="emoji-cat-card-main">
          <div class="emoji-cat-card-name">${escHtml(cat.name)}</div>
          <div class="emoji-cat-card-meta">${(cat.emojis || []).length} 张表情</div>
        </div>
        <div class="emoji-cat-card-arrow">›</div>
      </div>`).join('')}
    <div style="font-size:11px;color:var(--text-secondary);margin-top:16px;line-height:1.65;padding:0 4px">
      <b>带描述导入</b>（备注会同步进「念」）：<br>
      · 对象列表：<code style="font-size:10px">[{"description":"开心","data":"base64…"}]</code>（也认 remark/备注/描述/name）<br>
      · 键值对：<code style="font-size:10px">{"开心":"base64…","难过":"base64…"}</code><br>
      · 双列数组：<code style="font-size:10px">{"names":["开心"],"data":["base64…"]}</code><br>
      · TXT 每行：<code style="font-size:10px">开心|base64…</code> 或 <code style="font-size:10px">开心：base64…</code><br>
      仅纯 base64、无备注时才会自动命名「表情1、表情2…」
    </div>`;
}

function renderCategoryDetail(body) {
  const cat = activeCat();
  if (!cat) {
    _view = 'list';
    renderCategoryList(body);
    return;
  }

  const emojis = cat.emojis || [];
  body.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="triggerEmojiUpload(${cat.id})">＋ 上传图片</button>
      <button class="btn btn-ghost btn-sm" onclick="triggerEmojiPackImport(${cat.id})">📦 导入 JSON/ZIP</button>
      <button class="btn btn-ghost btn-sm" onclick="exportEmojiCategoryPack(${cat.id})">📤 导出 JSON</button>
      <button class="btn btn-ghost btn-sm" style="color:#e05555;border-color:rgba(224,85,85,0.3)" onclick="deleteCategoryConfirm(${cat.id},'${escHtml(cat.name)}')">删除分类</button>
    </div>
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">
      上传后请为每张表情填写描述并保存（支持 GIF）。角色发消息时会按描述识别并使用表情包。<br>
      若以前的图裂了：不要只当新图再传一张——点裂图上的「补图」，或给新图填<strong>和旧图相同的描述</strong>再保存，才会写回旧地址。
    </div>
    <input type="file" id="emoji-upload-${cat.id}" accept="image/*,image/gif,image/webp,image/apng" multiple style="display:none"
      onchange="handleEmojiUpload(event,${cat.id})">
    <div class="emoji-grid" id="emoji-grid-${cat.id}">
      ${emojis.length ? emojis.map(e => renderEmojiItem(e)).join('') : `<div style="font-size:13px;color:var(--text-secondary);padding:8px 0">暂无表情，点击「上传图片」或导入 JSON 包</div>`}
    </div>`;
}

window.openEmojiCategory = function(catId) {
  _activeCatId = catId;
  _view = 'detail';
  renderPageShell();
  loadEmojiManager();
};

window.emojiMgrBackToList = function() {
  _view = 'list';
  _activeCatId = null;
  renderPageShell();
  loadEmojiManager();
};

function renderEmojiItem(emoji) {
  const needsDesc = !(emoji.description || '').trim();
  const raw = emoji.url || `/uploads/${emoji.filename}`;
  const src = window.resolveMediaUrl?.(raw) || raw;
  const missing = !!emoji.missing;
  return `
    <div class="emoji-item${needsDesc ? ' emoji-item-needs-desc' : ''}${missing ? ' emoji-item-missing' : ''}" id="emoji-item-${emoji.id}">
      <div class="emoji-item-img-wrap">
        <img src="${escHtml(src)}" alt="${escHtml(emoji.description)}"
          style="width:100%;height:100%;object-fit:contain;display:block" loading="lazy"
          onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src=this.src.split('?')[0]+'?_r='+Date.now()}else{this.closest('.emoji-item')?.classList.add('emoji-item-missing')}">
        <div class="emoji-item-del" onclick="event.stopPropagation();deleteEmojiItem(${emoji.id})">×</div>
        <button type="button" class="emoji-item-replace" onclick="event.stopPropagation();triggerEmojiReplace(${emoji.id})">${missing ? '补图' : '替换'}</button>
      </div>
      <input type="file" id="emoji-replace-${emoji.id}" accept="image/*,image/gif,image/webp,image/apng" style="display:none"
        onchange="handleEmojiReplace(event,${emoji.id})">
      <div class="emoji-desc-row">
        <input class="input emoji-desc-input" id="emoji-desc-${emoji.id}"
          value="${escHtml(emoji.description || '')}"
          placeholder="描述（如：开心）"
          maxlength="30"
          onkeydown="if(event.key==='Enter')saveEmojiDesc(${emoji.id})">
        <button class="btn btn-primary btn-sm emoji-desc-save" onclick="saveEmojiDesc(${emoji.id})">保存</button>
      </div>
      ${missing ? '<div class="emoji-desc-hint">文件丢失，请点「补图」或填相同描述后用新图保存</div>' : (needsDesc ? '<div class="emoji-desc-hint">待填写描述</div>' : '')}
    </div>`;
}

window.showAddCategoryDialog = function() {
  const existing = document.getElementById('add-cat-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'add-cat-overlay';
  overlay.className = 'overlay active center';
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `
    <div class="modal" style="width:calc(100% - 32px);max-width:360px" onclick="event.stopPropagation()">
      <div class="modal-title">新建分类</div>
      <div class="modal-body">
        <input class="input" id="new-cat-name" placeholder="分类名称，如「可爱」「搞笑」" maxlength="20"
          onkeydown="if(event.key==='Enter')doAddCategory()">
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('add-cat-overlay').remove()">取消</button>
        <button class="btn btn-primary btn-sm" onclick="doAddCategory()">创建</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('new-cat-name')?.focus(), 100);
};

window.doAddCategory = async function() {
  const name = document.getElementById('new-cat-name')?.value?.trim();
  if (!name) { window.showToast?.('请输入分类名称'); return; }
  try {
    await api.createEmojiCategory(name);
    document.getElementById('add-cat-overlay')?.remove();
    await loadEmojiManager();
    window.showToast?.(`已创建分类「${name}」`);
  } catch (e) { window.showToast?.(e.message); }
};

window.triggerEmojiUpload = function(catId) {
  document.getElementById(`emoji-upload-${catId}`)?.click();
};

window.triggerEmojiPackImport = function(catId) {
  const input = document.getElementById('emoji-pack-import-input');
  if (!input) return;
  input.dataset.categoryId = catId != null ? String(catId) : '';
  input.value = '';
  input.click();
};

window.exportEmojiCategoryPack = async function(catId) {
  const id = Number(catId);
  if (!Number.isFinite(id) || id <= 0) return;
  window.showToast?.('正在导出…');
  try {
    const pack = await api.exportEmojiCategory(id);
    if (!pack?.stickers?.length) {
      window.showToast?.(pack?.errors?.length ? `导出失败：${pack.errors[0]}` : '该分类没有可导出的表情');
      return;
    }
    const name = String(pack.name || 'emoji').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
    const r = await downloadTextFile(
      `${name}-emoji-pack.json`,
      JSON.stringify(pack, null, 2),
      'application/json;charset=utf-8'
    );
    if (r.cancelled) return;
    if (!r.ok || r.via === 'anchor-unreliable') {
      window.showToast?.(downloadResultToast(r) || '导出失败');
      return;
    }
    let tip = downloadResultToast(r) || `已导出 ${pack.exported} 张`;
    if (pack.skipped) tip += `（跳过 ${pack.skipped}）`;
    window.showToast?.(tip);
  } catch (e) {
    window.showToast?.(e.message || '导出失败');
  }
};

window.handleEmojiPackImport = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const catIdRaw = e.target.dataset.categoryId;
  const categoryId = catIdRaw ? Number(catIdRaw) : null;

  window.showToast?.(`导入中…（${(file.size / 1024 / 1024).toFixed(1)} MB）`);
  try {
    const result = await api.importEmojiPackFile(categoryId || undefined, file);
    let msg = `成功导入 ${result.imported} 张`;
    if (result.skipped) msg += `，跳过 ${result.skipped} 张`;
    window.showToast?.(msg);
    if (result.errors?.length) {
      showImportErrorDialog('部分跳过', result.errors.join('\n'));
    }
    if (result.categoryId && !categoryId) {
      _activeCatId = result.categoryId;
      _view = 'detail';
      renderPageShell();
    }
    await loadEmojiManager();
  } catch (err) {
    showImportErrorDialog('导入失败', err.message || '未知错误');
  }
  e.target.value = '';
};

function showImportErrorDialog(title, message) {
  const existing = document.getElementById('emoji-import-error-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'emoji-import-error-overlay';
  overlay.className = 'overlay active center';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `
    <div class="modal" style="width:calc(100% - 32px);max-width:420px;max-height:70vh;display:flex;flex-direction:column" onclick="event.stopPropagation()">
      <div class="modal-title">${escHtml(title)}</div>
      <div class="modal-body" style="overflow-y:auto;white-space:pre-wrap;font-size:13px;line-height:1.6;color:var(--text-secondary)">${escHtml(message)}</div>
      <div class="modal-footer">
        <button class="btn btn-primary btn-sm" onclick="document.getElementById('emoji-import-error-overlay').remove()">知道了</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

window.handleEmojiUpload = async function(e, catId) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  const tooBig = files.filter(f => f.size > 8 * 1024 * 1024);
  if (tooBig.length) { window.showToast?.(`${tooBig.length} 个文件超过 8MB 限制`); e.target.value = ''; return; }

  window.showToast?.(`上传中…（${files.length} 张）`);
  try {
    const result = await api.uploadEmojiFiles(catId, files);
    const uploaded = result.files || [];
    for (const f of uploaded) {
      await api.createEmoji({ categoryId: catId, filename: f.filename, description: '' });
    }
    await loadEmojiManager();
    window.showToast?.(`成功上传 ${uploaded.length} 张，请填写描述并保存`);
    document.querySelector(`#emoji-grid-${catId} .emoji-item-needs-desc input`)?.focus();
  } catch (err) { window.showToast?.('上传失败: ' + err.message); }
  e.target.value = '';
};

window.saveEmojiDesc = async function(id) {
  const input = document.getElementById(`emoji-desc-${id}`);
  const description = input?.value?.trim();
  if (!description) { window.showToast?.('请填写描述'); input?.focus(); return; }
  try {
    const result = await api.updateEmoji(id, description);
    if (result?.merged) {
      window.showToast?.(`描述已保存，已用这张图补回 ${result.merged} 张裂开的旧表情`);
      await loadEmojiManager();
      return;
    }
    document.getElementById(`emoji-item-${id}`)?.classList.remove('emoji-item-needs-desc');
    document.getElementById(`emoji-item-${id}`)?.querySelector('.emoji-desc-hint')?.remove();
    window.showToast?.('描述已保存');
  } catch (e) { window.showToast?.(e.message); }
};

window.triggerEmojiReplace = function(id) {
  document.getElementById(`emoji-replace-${id}`)?.click();
};

window.handleEmojiReplace = async function(e, id) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { window.showToast?.('文件超过 8MB 限制'); return; }
  window.showToast?.('替换中…');
  try {
    await api.replaceEmojiFile(id, file);
    await loadEmojiManager();
    window.showToast?.('已补回原文件名，聊天里旧表情也会显示这张图');
  } catch (err) { window.showToast?.('替换失败: ' + (err.message || '')); }
};

window.deleteEmojiItem = async function(id) {
  try {
    await api.deleteEmoji(id);
    document.getElementById(`emoji-item-${id}`)?.remove();
    const cat = activeCat();
    if (cat) cat.emojis = (cat.emojis || []).filter(e => Number(e.id) !== Number(id));
  } catch (e) { window.showToast?.(e.message); }
};

window.deleteCategoryConfirm = async function(id, name) {
  if (!confirm(`删除分类「${name}」及其所有表情？此操作不可恢复`)) return;
  try {
    await api.deleteEmojiCategory(id);
    if (Number(_activeCatId) === Number(id)) {
      _view = 'list';
      _activeCatId = null;
      renderPageShell();
    }
    await loadEmojiManager();
    window.showToast?.(`已删除分类「${name}」`);
  } catch (e) { window.showToast?.(e.message); }
};

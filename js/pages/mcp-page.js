/* ===== MCP 插件（远程 URL） ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';

let _servers = [];
let _editingId = null;
let _testingId = null;

window.initMcpPage = async function () {
  const page = document.getElementById('mcp-page');
  if (!page) return;
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const data = await api.getMcpServers();
    _servers = Array.isArray(data?.servers) ? data.servers : [];
    renderMcpPage(page);
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
  }
};

function renderMcpPage(page) {
  const listHtml = _servers.length
    ? _servers.map((s) => renderServerCard(s)).join('')
    : `<div class="settings-row settings-row--stack">
         <div class="settings-row-sub">还没有 MCP 服务。添加远程地址后，聊天里角色就能调用对方提供的工具。</div>
       </div>`;

  const formOpen = _editingId !== null;
  const editing = _editingId && _editingId !== '__new__'
    ? _servers.find((s) => s.id === _editingId)
    : null;

  page.innerHTML = `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">MCP</div>
      <button type="button" class="topbar-save" onclick="mcpStartAdd()">${formOpen ? '取消' : '添加'}</button>
    </div>
    <div class="scroll-area scroll-area-native" style="padding-bottom:40px">
      <div class="settings-section" style="margin-top:12px">
        <div class="settings-section-title">远程服务</div>
        <div class="settings-group">
          <div class="settings-row settings-row--stack">
            <div class="settings-row-sub" style="margin-bottom:4px">
              念作为 MCP 客户端连接远程 URL（Streamable HTTP / SSE）。
              与桌宠小机网关是两回事。总开关以后再加；保存的服务聊天时直接可用。
            </div>
          </div>
          ${listHtml}
        </div>
      </div>
      ${formOpen ? renderEditForm(editing) : ''}
    </div>
  `;
}

function statusLine(s) {
  if (s.lastOk === true) {
    const n = (s.toolNames || []).length;
    return `上次连通 · ${n} 个工具`;
  }
  if (s.lastOk === false) {
    return `上次失败：${escapeHtml(String(s.lastError || '未知错误').slice(0, 80))}`;
  }
  return '尚未测试';
}

function renderServerCard(s) {
  const tools = (s.toolNames || []).slice(0, 8);
  const more = (s.toolNames || []).length - tools.length;
  const toolsHtml = tools.length
    ? `<div class="settings-row-sub" style="margin-top:6px">${tools.map((t) => `<code style="margin-right:6px">${escapeHtml(t)}</code>`).join('')}${more > 0 ? `…+${more}` : ''}</div>`
    : '';
  const busy = _testingId === s.id;
  return `
    <div class="settings-row settings-row--stack" style="border-top:1px solid var(--border,rgba(0,0,0,.06));padding-top:12px">
      <div class="settings-row-label">${escapeHtml(s.name || 'MCP')}</div>
      <div class="settings-row-sub">${escapeHtml(s.url || '')}</div>
      <div class="settings-row-sub">${statusLine(s)}${s.hasToken ? ' · 已设 Token' : ''}</div>
      ${toolsHtml}
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        <button type="button" class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="mcpTestServer('${escapeHtml(s.id)}')">${busy ? '测试中…' : '测试连接'}</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="mcpStartEdit('${escapeHtml(s.id)}')">编辑</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="mcpDeleteServer('${escapeHtml(s.id)}')">删除</button>
      </div>
    </div>
  `;
}

function renderEditForm(editing) {
  const isNew = !editing;
  return `
    <div class="settings-section">
      <div class="settings-section-title">${isNew ? '添加服务' : '编辑服务'}</div>
      <div class="settings-group">
        <div class="settings-row settings-row--stack">
          <div class="settings-row-label">名称</div>
          <input class="input" id="mcp-name" type="text" maxlength="40"
            value="${escapeHtml(editing?.name || '')}" placeholder="例如 搜索 / 日历">
        </div>
        <div class="settings-row settings-row--stack">
          <div class="settings-row-label">MCP URL</div>
          <input class="input" id="mcp-url" type="url"
            value="${escapeHtml(editing?.url || '')}" placeholder="https://example.com/mcp">
          <div class="settings-row-sub">远程 Streamable HTTP 或 SSE 端点</div>
        </div>
        <div class="settings-row settings-row--stack">
          <div class="settings-row-label">Token（可选）</div>
          <input class="input" id="mcp-token" type="text"
            value="" placeholder="${editing?.hasToken ? '已保存，留空不改' : 'Bearer Token，可空'}">
        </div>
        <div style="padding:12px 16px 4px;display:flex;gap:8px">
          <button type="button" class="btn btn-primary btn-sm" onclick="mcpSaveServer('${escapeHtml(editing?.id || '')}')">保存</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="mcpCancelEdit()">取消</button>
        </div>
      </div>
    </div>
  `;
}

function refreshPage() {
  const page = document.getElementById('mcp-page');
  if (page) renderMcpPage(page);
}

window.mcpStartAdd = function () {
  if (_editingId !== null) {
    _editingId = null;
  } else {
    _editingId = '__new__';
  }
  refreshPage();
};

window.mcpStartEdit = function (id) {
  _editingId = String(id || '');
  refreshPage();
};

window.mcpCancelEdit = function () {
  _editingId = null;
  refreshPage();
};

window.mcpSaveServer = async function (id) {
  const name = String(document.getElementById('mcp-name')?.value || '').trim();
  const url = String(document.getElementById('mcp-url')?.value || '').trim();
  const token = String(document.getElementById('mcp-token')?.value || '').trim();
  if (!url) {
    window.showToast?.('请填写 MCP URL');
    return;
  }
  try {
    const body = { name: name || 'MCP', url, enabled: true };
    if (id) body.id = id;
    if (token) body.token = token;
    const data = await api.saveMcpServer(body);
    _servers = Array.isArray(data?.servers) ? data.servers : _servers;
    _editingId = null;
    window.showToast?.('已保存');
    refreshPage();
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.mcpDeleteServer = async function (id) {
  if (!id || !confirm('删除这个 MCP 服务？')) return;
  try {
    const data = await api.deleteMcpServer(id);
    _servers = Array.isArray(data?.servers) ? data.servers : _servers.filter((s) => s.id !== id);
    if (_editingId === id) _editingId = null;
    window.showToast?.('已删除');
    refreshPage();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

window.mcpTestServer = async function (id) {
  if (!id || _testingId) return;
  _testingId = id;
  refreshPage();
  try {
    const data = await api.testMcpServer(id);
    if (Array.isArray(data?.servers)) _servers = data.servers;
    else if (data?.server) {
      const i = _servers.findIndex((s) => s.id === id);
      if (i >= 0) _servers[i] = data.server;
    }
    const n = (data?.tools || []).length;
    window.showToast?.(data?.ok ? `连通，${n} 个工具` : (data?.error || '失败'));
  } catch (e) {
    window.showToast?.(e.message || '连接失败');
    try {
      const data = await api.getMcpServers();
      _servers = Array.isArray(data?.servers) ? data.servers : _servers;
    } catch {}
  } finally {
    _testingId = null;
    refreshPage();
  }
};

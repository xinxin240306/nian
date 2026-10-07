/**
 * 通用 MCP 插件客户端（远程 URL：Streamable HTTP → SSE 回退）。
 * 与 robot-mcp-bridge（桌宠专用）分开。
 */

const SETTING_KEY = 'mcp_servers';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_TOOLS_TOTAL = 40;
const CLIENT_INFO = { name: 'nian', version: '1.0.0' };

/** @type {Map<string, { at:number, tools:any[], schemas:any[], nameMap:Map<string,{serverId:string,toolName:string}>, error?:string }>} */
const _cache = new Map();
/** @type {Map<string, { ok:boolean, at:number, error?:string, toolNames?:string[] }>} */
const _lastStatus = new Map();

function uid() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function sanitizeIdPart(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'x';
}

function maskToken(token) {
  const t = String(token || '');
  if (!t) return '';
  if (t.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, t.length - 4))}${t.slice(-4)}`;
}

function normalizeServer(raw, { keepToken = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim() || uid();
  const name = String(raw.name || '').trim().slice(0, 40) || 'MCP';
  const url = String(raw.url || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  const token = keepToken ? String(raw.token || '').trim() : '';
  const enabled = raw.enabled === false || raw.enabled === '0' || raw.enabled === 0 ? false : true;
  return { id, name, url, token, enabled };
}

function loadServers(getSettingsFn) {
  const s = typeof getSettingsFn === 'function' ? getSettingsFn() : getSettingsFn || {};
  const list = safeJsonParse(s?.[SETTING_KEY], []);
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const n = normalizeServer(item);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

function saveServers(setSettingFn, servers) {
  const list = (servers || []).map((s) => normalizeServer(s)).filter(Boolean);
  setSettingFn(SETTING_KEY, JSON.stringify(list));
  return list;
}

function publicServer(server) {
  const st = _lastStatus.get(server.id);
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    tokenMasked: maskToken(server.token),
    hasToken: !!server.token,
    enabled: server.enabled !== false,
    lastOk: st ? !!st.ok : null,
    lastError: st?.error || '',
    lastAt: st?.at || 0,
    toolNames: Array.isArray(st?.toolNames) ? st.toolNames : [],
  };
}

function authHeaders(server) {
  const h = {};
  if (server.token) h.Authorization = `Bearer ${server.token}`;
  return h;
}

async function connectClient(server) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

  const url = new URL(server.url);
  const requestInit = { headers: authHeaders(server) };
  const errors = [];

  // 1) Streamable HTTP
  try {
    const client = new Client(CLIENT_INFO);
    const transport = new StreamableHTTPClientTransport(url, { requestInit });
    await client.connect(transport);
    return { client, transport, mode: 'streamable-http' };
  } catch (e) {
    errors.push(`streamable-http: ${e.message || e}`);
  }

  // 2) SSE fallback
  try {
    const client = new Client(CLIENT_INFO);
    const transport = new SSEClientTransport(url, {
      requestInit,
      eventSourceInit: {
        fetch: async (input, init = {}) => {
          const headers = new Headers(init.headers || {});
          for (const [k, v] of Object.entries(authHeaders(server))) headers.set(k, v);
          return fetch(input, { ...init, headers });
        },
      },
    });
    await client.connect(transport);
    return { client, transport, mode: 'sse' };
  } catch (e) {
    errors.push(`sse: ${e.message || e}`);
  }

  throw new Error(errors.join(' | ') || 'MCP 连接失败');
}

async function withClient(server, fn) {
  const { client, transport } = await connectClient(server);
  try {
    return await fn(client);
  } finally {
    try { await client.close?.(); } catch {}
    try { await transport.close?.(); } catch {}
  }
}

function toolToOpenAISchema(mappedName, tool) {
  const desc = String(tool.description || tool.title || tool.name || mappedName).slice(0, 800);
  let parameters = tool.inputSchema;
  if (!parameters || typeof parameters !== 'object') {
    parameters = { type: 'object', properties: {} };
  }
  return {
    type: 'function',
    function: {
      name: mappedName,
      description: desc,
      parameters,
    },
  };
}

function buildMappedTools(server, tools) {
  const short = sanitizeIdPart(server.id.replace(/^m_/, '').slice(0, 10) || server.id);
  const schemas = [];
  const nameMap = new Map();
  const toolNames = [];
  for (const tool of tools || []) {
    const rawName = String(tool?.name || '').trim();
    if (!rawName) continue;
    const mapped = `mcp_${short}_${sanitizeIdPart(rawName)}`.slice(0, 64);
    if (nameMap.has(mapped)) continue;
    nameMap.set(mapped, { serverId: server.id, toolName: rawName });
    schemas.push(toolToOpenAISchema(mapped, tool));
    toolNames.push(rawName);
  }
  return { schemas, nameMap, toolNames, tools: tools || [] };
}

async function refreshServerTools(server, { force = false } = {}) {
  const cached = _cache.get(server.id);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS && !cached.error) {
    return cached;
  }
  try {
    const listed = await withClient(server, async (client) => client.listTools());
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    const mapped = buildMappedTools(server, tools);
    const entry = {
      at: Date.now(),
      tools: mapped.tools,
      schemas: mapped.schemas,
      nameMap: mapped.nameMap,
    };
    _cache.set(server.id, entry);
    _lastStatus.set(server.id, {
      ok: true,
      at: Date.now(),
      toolNames: mapped.toolNames,
    });
    return entry;
  } catch (e) {
    const msg = e.message || String(e);
    _cache.set(server.id, {
      at: Date.now(),
      tools: [],
      schemas: [],
      nameMap: new Map(),
      error: msg,
    });
    _lastStatus.set(server.id, { ok: false, at: Date.now(), error: msg, toolNames: [] });
    throw e;
  }
}

function invalidateServer(serverId) {
  if (serverId) {
    _cache.delete(serverId);
    return;
  }
  _cache.clear();
}

/**
 * 聊天用：合并所有已启用 MCP 的 OpenAI tools schema。
 */
async function schemasForChat(getSettingsFn, opts = {}) {
  if (opts.isDream || opts.forTheater || opts.forGame) return [];
  const servers = loadServers(getSettingsFn).filter((s) => s.enabled !== false);
  if (!servers.length) return [];

  const out = [];
  const nameMap = new Map();
  for (const server of servers) {
    if (out.length >= MAX_TOOLS_TOTAL) break;
    try {
      const entry = await refreshServerTools(server, { force: false });
      for (const schema of entry.schemas || []) {
        if (out.length >= MAX_TOOLS_TOTAL) {
          console.warn(`[mcp] 工具数已达上限 ${MAX_TOOLS_TOTAL}，截断`);
          break;
        }
        const n = schema?.function?.name;
        if (!n || nameMap.has(n)) continue;
        out.push(schema);
        const meta = entry.nameMap.get(n);
        if (meta) nameMap.set(n, meta);
      }
    } catch (e) {
      console.warn(`[mcp] list ${server.name}:`, e.message);
    }
  }
  // 挂在模块上供 call 反查（同轮内）
  schemasForChat._lastNameMap = nameMap;
  return out;
}

function isMcpToolName(name) {
  return /^mcp_[a-z0-9_]+_/i.test(String(name || ''));
}

function resolveMappedTool(name, getSettingsFn) {
  const n = String(name || '');
  const fromChat = schemasForChat._lastNameMap?.get(n);
  if (fromChat) return fromChat;
  for (const entry of _cache.values()) {
    const meta = entry.nameMap?.get(n);
    if (meta) return meta;
  }
  // 缓存未命中时按命名规则猜（短 id 可能碰撞，尽量从配置对）
  const m = n.match(/^mcp_([a-z0-9_]+)_(.+)$/i);
  if (!m) return null;
  const short = m[1];
  const toolPart = m[2];
  const servers = loadServers(getSettingsFn);
  for (const s of servers) {
    const sid = sanitizeIdPart(s.id.replace(/^m_/, '').slice(0, 10) || s.id);
    if (sid !== short) continue;
    const cached = _cache.get(s.id);
    if (cached?.nameMap) {
      for (const [mapped, meta] of cached.nameMap.entries()) {
        if (mapped === n) return meta;
      }
      for (const [mapped, meta] of cached.nameMap.entries()) {
        if (sanitizeIdPart(meta.toolName) === toolPart) return meta;
      }
    }
    return { serverId: s.id, toolName: toolPart.replace(/_/g, '-') };
  }
  return null;
}

function serializeToolResult(result) {
  if (result == null) return JSON.stringify({ ok: true });
  if (typeof result === 'string') return result;
  try {
    const content = result.content;
    if (Array.isArray(content)) {
      const texts = content
        .map((c) => {
          if (!c) return '';
          if (c.type === 'text') return String(c.text || '');
          if (c.type === 'resource' && c.resource) {
            return JSON.stringify(c.resource).slice(0, 4000);
          }
          return JSON.stringify(c).slice(0, 2000);
        })
        .filter(Boolean);
      const payload = {
        ok: !result.isError,
        text: texts.join('\n').slice(0, 8000),
      };
      if (result.structuredContent) payload.structured = result.structuredContent;
      return JSON.stringify(payload);
    }
    return JSON.stringify(result).slice(0, 8000);
  } catch {
    return JSON.stringify({ ok: false, error: 'serialize_failed' });
  }
}

async function executeToolCall(call, getSettingsFn) {
  const meta = resolveMappedTool(call?.name, getSettingsFn);
  if (!meta) {
    return { ok: false, error: `未知 MCP 工具: ${call?.name || ''}` };
  }
  const servers = loadServers(getSettingsFn);
  const server = servers.find((s) => s.id === meta.serverId);
  if (!server) return { ok: false, error: 'MCP 服务不存在' };
  if (server.enabled === false) return { ok: false, error: 'MCP 服务未启用' };

  try {
    // 确保有 nameMap；必要时刷新
    if (!_cache.get(server.id)?.nameMap?.size) {
      await refreshServerTools(server, { force: true });
    }
    const result = await withClient(server, async (client) =>
      client.callTool({
        name: meta.toolName,
        arguments: call.args && typeof call.args === 'object' ? call.args : {},
      })
    );
    console.log(`[mcp] call ${server.name}.${meta.toolName}`);
    return serializeToolResult(result);
  } catch (e) {
    console.warn(`[mcp] call ${server.name}.${meta.toolName}:`, e.message);
    return JSON.stringify({ ok: false, error: e.message || 'mcp_call_failed' });
  }
}

async function testServer(server) {
  const entry = await refreshServerTools(server, { force: true });
  return {
    ok: true,
    mode: 'connected',
    tools: (entry.tools || []).map((t) => ({
      name: t.name,
      description: String(t.description || '').slice(0, 200),
    })),
  };
}

function upsertServer(getSettingsFn, setSettingFn, body) {
  const servers = loadServers(getSettingsFn);
  const incoming = normalizeServer({
    ...body,
    token: body.token != null && body.token !== ''
      ? body.token
      : (servers.find((s) => s.id === body.id)?.token || ''),
  });
  if (!incoming) throw new Error('请填写有效的 URL');

  const idx = servers.findIndex((s) => s.id === incoming.id);
  if (idx >= 0) {
    // 编辑时若前端传空 token 且有掩码占位，保留原 token
    if (!String(body.token || '').trim() && servers[idx].token) {
      incoming.token = servers[idx].token;
    }
    servers[idx] = incoming;
  } else {
    servers.push(incoming);
  }
  saveServers(setSettingFn, servers);
  invalidateServer(incoming.id);
  return publicServer(incoming);
}

function deleteServer(getSettingsFn, setSettingFn, id) {
  const sid = String(id || '').trim();
  const next = loadServers(getSettingsFn).filter((s) => s.id !== sid);
  saveServers(setSettingFn, next);
  invalidateServer(sid);
  _lastStatus.delete(sid);
  return { ok: true };
}

function listPublicServers(getSettingsFn) {
  return loadServers(getSettingsFn).map(publicServer);
}

module.exports = {
  SETTING_KEY,
  MAX_TOOLS_TOTAL,
  loadServers,
  saveServers,
  listPublicServers,
  upsertServer,
  deleteServer,
  publicServer,
  testServer,
  refreshServerTools,
  schemasForChat,
  isMcpToolName,
  executeToolCall,
  invalidateServer,
  normalizeServer,
};

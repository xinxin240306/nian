/** 原生 APK 壳：前端在本地，API/WebSocket 指向用户自填的后端地址 */

const STORAGE_KEY = 'nian_server_url';
const SESSION_KEY = 'nian_site_session';

export function isNativeShell() {
  try {
    if (window.Capacitor?.isNativePlatform?.()) return true;
    const plat = window.Capacitor?.getPlatform?.();
    if (plat === 'android' || plat === 'ios') return true;
    // bridge 已注入但尚未 ready
    if (typeof window.Capacitor !== 'undefined') return true;
  } catch {}
  // Capacitor Android 常见：https://localhost 且无常规浏览器工具栏
  try {
    const host = location.hostname || '';
    if (
      (host === 'localhost' || host === '127.0.0.1')
      && location.protocol === 'https:'
      && !navigator.userAgent.includes('Edg/')
      && (
        navigator.userAgent.includes('Android')
        || /; wv\)/.test(navigator.userAgent)
      )
    ) {
      return true;
    }
  } catch {}
  return localStorage.getItem('nian_native_shell') === '1';
}

/** 等 Capacitor bridge（最多约 2s） */
export async function waitForNativeBridge(timeoutMs = 2000) {
  if (typeof window.Capacitor !== 'undefined') return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof window.Capacitor !== 'undefined') return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return typeof window.Capacitor !== 'undefined' || isNativeShell();
}

export function getServerBase() {
  return (localStorage.getItem(STORAGE_KEY) || '').trim().replace(/\/$/, '');
}

export function setServerBase(url) {
  const u = String(url || '').trim().replace(/\/$/, '');
  if (!u) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, u);
  }
  try {
    window.Capacitor?.Plugins?.AppPermissions?.setBridgeConfig?.({
      serverBase: u,
      sessionToken: getSiteSessionToken(),
    });
  } catch {}
}

/** 浏览器同源访问用 ''；APK 内用 http(s)://你的服务器 */
export function getApiBase() {
  if (!isNativeShell()) return '';
  return getServerBase();
}

export function resolveApiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBase()}${p}`;
}

/** 头像/表情/语音等媒体路径：APK 内拼到后端 */
export function resolveMediaUrl(url) {
  if (!url) return url;
  const s = String(url);
  if (/^(https?:|data:|blob:|capacitor:|file:)/i.test(s)) return s;
  if (s.startsWith('/') && isNativeShell() && getServerBase()) return resolveApiUrl(s);
  return s;
}

/** CSS background: url(...) — APK 里必须拼完整地址，DOM rewriter 只管 img/src */
export function cssMediaUrl(url) {
  const resolved = resolveMediaUrl(url);
  if (!resolved) return '';
  return `url("${String(resolved).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

export function getSiteSessionToken() {
  return (localStorage.getItem(SESSION_KEY) || '').trim();
}

export function setSiteSessionToken(token) {
  const t = String(token || '').trim();
  if (!t) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, t);
  try {
    window.Capacitor?.Plugins?.AppPermissions?.setBridgeConfig?.({
      serverBase: getServerBase(),
      sessionToken: t,
    });
  } catch {}
}

export function getWsUrl() {
  if (!isNativeShell()) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }
  const base = getServerBase();
  if (!base) return '';
  try {
    const u = new URL(base.includes('://') ? base : `http://${base}`);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}`;
  } catch {
    return '';
  }
}

function normalizeInput(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/$/, '');
}

function shouldRewriteMediaAttr(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  return (
    value.startsWith('/uploads/')
    || value.startsWith('/fonts/')
    || value.startsWith('/api/')
  );
}

/** 把 DOM 里写死的 /uploads/... 改成后端完整地址（innerHTML 也能覆盖） */
export function installNativeMediaRewriter() {
  if (!isNativeShell() || !getServerBase()) return;
  if (window.__nianMediaRewriterInstalled) return;
  window.__nianMediaRewriterInstalled = true;

  const MEDIA_ATTRS = ['src', 'href', 'poster', 'data-voice-src', 'data-media-url'];
  const fixEl = (el) => {
    if (!el || el.nodeType !== 1) return;
    for (const attr of MEDIA_ATTRS) {
      const v = el.getAttribute?.(attr);
      if (shouldRewriteMediaAttr(v)) el.setAttribute(attr, resolveApiUrl(v));
    }
  };

  const fixTree = (root) => {
    if (!root) return;
    if (root.nodeType === 1) fixEl(root);
    root.querySelectorAll?.('img[src],audio[src],video[src],video[poster],source[src],a[href],[data-voice-src],[data-media-url]').forEach(fixEl);
  };

  fixTree(document.documentElement);
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        fixEl(m.target);
        continue;
      }
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) fixTree(n);
      });
    }
  });
  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'poster', 'data-voice-src', 'data-media-url'],
  });
}

async function probeServer(url) {
  const health = `${url}/api/health`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(health, {
      cache: 'no-store',
      signal: ctrl.signal,
      // 探测阶段不要带 credentials，避免复杂预检
      mode: 'cors',
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}：服务器有响应但不是健康状态`);
    }
    if (!data?.ok) {
      throw new Error(`返回了非念后端内容（请确认地址指向念的 Node 服务，而不是别的网站）`);
    }
    return true;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('连接超时（8 秒无响应）');
    const msg = String(e.message || e);
    if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(msg)) {
      throw new Error('网络被拒或跨域失败。常见原因：地址写错、后端没开、防火墙拦了、填了 localhost');
    }
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

function showServerSetupOverlay({ preset = '', allowCancel = false, onDone, initialError = '' } = {}) {
  const old = document.getElementById('nian-server-setup');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'nian-server-setup';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div style="background:var(--card-bg,#fff);color:var(--text,#222);border-radius:16px;padding:22px;max-width:360px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.2)">
      <div style="font-size:18px;font-weight:600;margin-bottom:8px">连接你的「念」服务器</div>
      <p style="font-size:13px;color:var(--text-secondary,#666);line-height:1.6;margin:0 0 10px">
        App 只是界面壳，必须连到<strong>正在运行念后端</strong>的地址：
      </p>
      <ul style="font-size:12px;color:var(--text-secondary,#666);line-height:1.7;margin:0 0 12px;padding-left:18px">
        <li>VPS：填你平时用浏览器打开念的网址，如 <code>https://你的域名</code></li>
        <li>电脑调试：同一 WiFi，填 <code>http://电脑IP:3000</code>（不要填 localhost）</li>
      </ul>
      <input id="nian-server-input" class="input" placeholder="https://你的域名" value="${preset.replace(/"/g, '&quot;')}" style="width:100%;box-sizing:border-box;margin-bottom:10px" autocomplete="off">
      <div id="nian-server-err" style="color:${initialError ? '#e55' : 'inherit'};font-size:12px;line-height:1.5;min-height:18px;margin-bottom:8px;white-space:pre-wrap">${initialError.replace(/</g, '&lt;')}</div>
      <button type="button" id="nian-server-save" class="btn btn-primary" style="width:100%">连接并检测</button>
      ${allowCancel ? '<button type="button" id="nian-server-cancel" class="btn btn-ghost" style="width:100%;margin-top:8px">取消</button>' : ''}
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#nian-server-input');
  const errEl = overlay.querySelector('#nian-server-err');
  const save = async () => {
    const url = normalizeInput(input.value);
    if (!url) {
      errEl.textContent = '请填写服务器地址';
      return;
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) {
      errEl.textContent = '手机上的 localhost 是手机自己，不是你的电脑。请改成电脑局域网 IP 或 VPS 域名。';
      return;
    }
    errEl.style.color = 'var(--text-secondary,#666)';
    errEl.textContent = '正在连接…';
    try {
      await probeServer(url);
      setServerBase(url);
      installNativeMediaRewriter();
      overlay.remove();
      onDone?.(true, url);
    } catch (e) {
      errEl.style.color = '#e55';
      errEl.textContent = `连不上：${e.message || e}\n\n请确认：① 后端已启动 ② 地址含端口（本机常见 :3000）③ 手机能打开该网址`;
    }
  };
  overlay.querySelector('#nian-server-save').addEventListener('click', save);
  overlay.querySelector('#nian-server-cancel')?.addEventListener('click', () => {
    overlay.remove();
    onDone?.(false, getServerBase());
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  setTimeout(() => input.focus(), 50);
}

/** 首次打开 APK 时填写后端地址（电脑局域网 IP 或 VPS） */
export async function ensureServerConfigured() {
  await waitForNativeBridge();
  if (!isNativeShell()) return true;

  const existing = getServerBase();
  if (existing) {
    try {
      await probeServer(existing);
      installNativeMediaRewriter();
      return true;
    } catch (e) {
      // 已有地址时后端暂时挂了：允许取消进入，避免卡死在配置页
      return new Promise((resolve) => {
        showServerSetupOverlay({
          preset: existing,
          allowCancel: true,
          initialError: `暂时连不上服务器：${e.message || e}\n\n多半是 VPS 上的 Node 没在跑。可先取消进界面，去服务器重启后再试。`,
          onDone: () => resolve(true),
        });
      });
    }
  }

  return new Promise((resolve) => {
    showServerSetupOverlay({
      preset: '',
      allowCancel: false,
      onDone: () => resolve(true),
    });
  });
}

/** 设置里可重新填写服务器地址 */
export function openServerConfigEditor() {
  if (!isNativeShell()) {
    window.showToast?.('仅 App 内需要配置服务器地址');
    return;
  }
  const cur = getServerBase();
  showServerSetupOverlay({
    preset: cur || '',
    allowCancel: true,
    onDone: (ok, url) => {
      if (ok && url && url !== cur) {
        window.showToast?.('服务器已更新，正在刷新…');
        setTimeout(() => location.reload(), 400);
      }
    },
  });
}

if (typeof window !== 'undefined') {
  window.resolveMediaUrl = resolveMediaUrl;
  window.cssMediaUrl = cssMediaUrl;
  window.resolveApiUrl = resolveApiUrl;
  window.isNativeShell = isNativeShell;
  window.openServerConfigEditor = openServerConfigEditor;
  window.getServerBase = getServerBase;
  window.getSiteSessionToken = getSiteSessionToken;
}

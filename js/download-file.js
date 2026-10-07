/** 浏览器和下载体都能真正把文件交给用户，不靠 WebView 里经常失效的 <a download> */

function nativePlugin() {
  return window.Capacitor?.Plugins?.AppPermissions;
}

function isNativeShell() {
  return !!(window.Capacitor?.isNativePlatform?.() || window.isNativeShell?.());
}

/** 与 Android sanitizeFilename 对齐，避免 MediaStore 写入失败 */
function sanitizeDownloadFilename(name, fallback = 'nian-backup.json') {
  let n = String(name || fallback).trim();
  n = n.replace(/[\\/:*?"<>|\r\n]+/g, '_');
  if (!n) n = fallback;
  if (n.length > 80) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 ? n.slice(dot) : '';
    n = n.slice(0, Math.min(60, n.length - ext.length)) + ext;
  }
  return n;
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function guessMime(filename, mime, blob) {
  const fromBlob = blob?.type || '';
  if (fromBlob && fromBlob !== 'application/octet-stream') return fromBlob;
  if (mime && mime !== 'application/octet-stream') return mime;
  const name = String(filename || '').toLowerCase();
  if (/\.(jpe?g)$/i.test(name)) return 'image/jpeg';
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.gif$/i.test(name)) return 'image/gif';
  if (/\.(mp4|m4v)$/i.test(name)) return 'video/mp4';
  if (/\.webm$/i.test(name)) return 'video/webm';
  if (/\.mp3$/i.test(name)) return 'audio/mpeg';
  if (/\.m4a$/i.test(name)) return 'audio/mp4';
  if (/\.wav$/i.test(name)) return 'audio/wav';
  return fromBlob || mime || 'application/octet-stream';
}

/**
 * 原生端写入系统图库/下载目录。
 * opts.url：优先由原生直接拉取（大视频不受 Binder 限制）
 * opts.headers：可选请求头
 */
async function saveViaNativeGallery(filename, blob, mime, opts = {}) {
  const plugin = nativePlugin();
  if (!plugin?.saveToGallery || !isNativeShell()) return null;
  const type = guessMime(filename, mime, blob);
  const payload = { filename, mime: type };
  if (opts.url) {
    payload.url = opts.url;
    if (opts.headers && typeof opts.headers === 'object') payload.headers = opts.headers;
  } else if (blob) {
    // Binder 约 1MB，base64 膨胀后更小阈值
    if (blob.size > 550000) return null;
    payload.base64 = await blobToBase64(blob);
  } else {
    return null;
  }
  const r = await plugin.saveToGallery(payload);
  if (r?.ok === false) throw new Error('保存失败');
  return { ok: true, via: 'gallery', collection: r?.collection || '' };
}

export async function downloadTextFile(filename, text, mime = 'application/json') {
  const name = sanitizeDownloadFilename(filename);
  const body = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  const type = mime || 'application/json';
  const blob = new Blob([body], { type });
  const byteLen = blob.size;
  const plugin = nativePlugin();

  // 原生：优先写入系统「下载/念」；PluginCall 传大字符串易翻车，偏大就改走分享/图库通道
  if (plugin?.saveDownload && isNativeShell() && byteLen < 700000) {
    try {
      const r = await plugin.saveDownload({ filename: name, text: body, mime: type });
      if (r?.ok !== false) return { ok: true, via: 'native' };
    } catch { /* 再试分享 */ }
  }

  try {
    const file = new File([blob], name, { type });
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return { ok: true, via: 'share' };
    }
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, cancelled: true };
  }

  // 文本也可进 Download（saveToGallery 按 mime 分流）
  if (isNativeShell() && byteLen < 550000) {
    try {
      const native = await saveViaNativeGallery(name, blob, type);
      if (native) return native;
    } catch { /* continue */ }
  }

  // Capacitor WebView 里 <a download> 经常是假成功，原生端勿当成功
  if (isNativeShell()) {
    if (body.length < 180000 && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(body);
        return { ok: true, via: 'clipboard' };
      } catch { /* fallthrough */ }
    }
    return { ok: false, via: 'anchor-unreliable' };
  }

  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return { ok: true, via: 'anchor' };
}

/**
 * @param {string} filename
 * @param {Blob|ArrayBuffer|string} blob
 * @param {string} [mime]
 * @param {{ url?: string, headers?: Record<string,string> }} [opts]
 */
export async function downloadBlobFile(filename, blob, mime, opts = {}) {
  const name = String(filename || 'download');
  const fileBlob = blob instanceof Blob
    ? blob
    : (blob != null ? new Blob([blob], { type: mime || 'application/octet-stream' }) : null);
  const type = guessMime(name, mime, fileBlob);

  try {
    const native = await saveViaNativeGallery(name, fileBlob, type, opts);
    if (native) return native;
  } catch (e) {
    if (!opts.url && !fileBlob) throw e;
    // 原生失败再降级
  }

  // App 内：没有图库通道时用系统分享，让用户选「保存到相册」
  if (fileBlob && isNativeShell()) {
    try {
      const file = new File([fileBlob], name, { type });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return { ok: true, via: 'share' };
      }
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, cancelled: true };
    }
  }

  if (!fileBlob) {
    throw new Error('无法保存到系统相册，请更新 App 后重试');
  }

  try {
    const file = new File([fileBlob], name, { type });
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return { ok: true, via: 'share' };
    }
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, cancelled: true };
  }

  // 浏览器可用；Capacitor WebView 里常是假成功，原生路径应已覆盖
  const a = document.createElement('a');
  a.href = URL.createObjectURL(fileBlob);
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return { ok: true, via: isNativeShell() ? 'anchor-unreliable' : 'anchor' };
}

export function downloadResultToast(r) {
  if (!r || r.cancelled) return null;
  if (r.via === 'gallery') {
    if (r.collection === 'images' || r.collection === 'video') return '已保存到系统相册（文件夹「念」）';
    if (r.collection === 'audio') return '已保存到系统音乐（文件夹「念」）';
    return '已保存到系统下载（文件夹「念」）';
  }
  if (r.via === 'share') return '已打开系统分享，请选「保存到文件」或文件管理';
  if (r.via === 'native') return '已保存到系统下载（文件夹「念」）';
  if (r.via === 'clipboard') return '无法直接存文件，已复制到剪贴板，可粘贴到备忘录保存';
  if (r.via === 'anchor-unreliable' || r.ok === false) {
    return '无法直接保存文件，请用系统分享或更新 App 后重试';
  }
  return '已开始下载';
}

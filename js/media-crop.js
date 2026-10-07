/* ===== 图片/视频裁剪上传 ===== */
import { uploadFile } from './api.js';

let _cropResolve = null;
let _cropState = null;
let _cropAspect = null; // locked aspect ratio (w/h), null = free
let _cropObjectUrl = null;
let _cropLoadTimer = null;
const _activePointers = new Map(); // pointerId -> {x, y}
let _dragMode = null;
let _cropRaf = 0;
let _cropListenersBound = false;

/** 解析宽高比：1 | 1.5 | '3:4' | '16/9' */
export function parseAspect(aspect) {
  if (aspect == null || aspect === '') return null;
  if (typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0) return aspect;
  const s = String(aspect).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[:/×x]\s*(\d+(?:\.\d+)?)$/i);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 0 && b > 0) return a / b;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 朋友圈封面：横向铺满、高度约 240+刘海 */
export function momentsCoverAspect() {
  const w = Math.max(1, window.innerWidth || 390);
  let sat = 0;
  try {
    sat = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
  } catch {}
  const h = Math.max(1, 240 + sat);
  return w / h;
}

function ensureCropDOM() {
  const existing = document.getElementById('media-crop-overlay');
  if (existing && !document.getElementById('media-crop-dim')) {
    try { existing.remove(); } catch {}
  } else if (existing) {
    bindCropWindowListeners();
    return;
  }
  if (document.getElementById('media-crop-overlay')) {
    bindCropWindowListeners();
    return;
  }
  document.body.insertAdjacentHTML('beforeend', `
    <div id="media-crop-overlay" class="overlay center" style="z-index:10020;display:none">
      <div class="media-crop-modal" onclick="event.stopPropagation()">
        <div class="media-crop-title" id="media-crop-title">调整裁剪</div>
        <div class="media-crop-stage" id="media-crop-stage">
          <div class="media-crop-inner" id="media-crop-inner">
            <img id="media-crop-img" alt="" style="display:none">
            <video id="media-crop-video" playsinline muted style="display:none"></video>
          </div>
          <div class="media-crop-dim" id="media-crop-dim" aria-hidden="true"></div>
          <div class="media-crop-box" id="media-crop-box">
            <div class="crop-handle crop-nw" data-handle="nw"></div>
            <div class="crop-handle crop-ne" data-handle="ne"></div>
            <div class="crop-handle crop-sw" data-handle="sw"></div>
            <div class="crop-handle crop-se" data-handle="se"></div>
          </div>
        </div>
        <div class="media-crop-hint">拖动框选区域 · 拖边角缩放</div>
        <div class="media-crop-footer">
          <button type="button" class="btn btn-ghost btn-sm" id="media-crop-cancel">取消</button>
          <button type="button" class="btn btn-primary btn-sm" id="media-crop-confirm">确定</button>
        </div>
      </div>
    </div>
  `);

  document.getElementById('media-crop-cancel')?.addEventListener('click', () => closeCrop(null));
  document.getElementById('media-crop-confirm')?.addEventListener('click', confirmCrop);
  document.getElementById('media-crop-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'media-crop-overlay') closeCrop(null);
  });

  const stage = document.getElementById('media-crop-stage');
  stage?.addEventListener('pointerdown', onCropPointerDown);
  stage?.addEventListener('wheel', onCropWheel, { passive: false });
  bindCropWindowListeners();
}

function bindCropWindowListeners() {
  if (_cropListenersBound) return;
  _cropListenersBound = true;
  window.addEventListener('pointermove', onCropPointerMove, { passive: false });
  window.addEventListener('pointerup', onCropPointerEnd);
  window.addEventListener('pointercancel', onCropPointerEnd);
  window.addEventListener('blur', endCropDrag);
}

function clearCropLoadTimer() {
  if (_cropLoadTimer) {
    clearTimeout(_cropLoadTimer);
    _cropLoadTimer = null;
  }
}

function revokeCropObjectUrl() {
  if (_cropObjectUrl) {
    try { URL.revokeObjectURL(_cropObjectUrl); } catch {}
    _cropObjectUrl = null;
  }
}

function isFixedCrop() {
  return !!(_cropState?.fixed && _cropAspect != null);
}

function closeCrop(result) {
  clearCropLoadTimer();
  endCropDrag();
  if (_cropRaf) {
    cancelAnimationFrame(_cropRaf);
    _cropRaf = 0;
  }
  const overlay = document.getElementById('media-crop-overlay');
  if (overlay) overlay.style.display = 'none';
  const stage = document.getElementById('media-crop-stage');
  stage?.classList.remove('is-fixed-frame');
  const img = document.getElementById('media-crop-img');
  const video = document.getElementById('media-crop-video');
  resetMediaElLayout(img);
  resetMediaElLayout(video);
  if (img) {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
  }
  if (video) {
    video.onloadeddata = null;
    video.onseeked = null;
    video.onerror = null;
    video.pause();
    video.removeAttribute('src');
    video.load?.();
  }
  revokeCropObjectUrl();
  _cropState = null;
  _cropAspect = null;
  if (_cropResolve) {
    const resolve = _cropResolve;
    _cropResolve = null;
    resolve(result);
  }
}

function resetMediaElLayout(el) {
  if (!el) return;
  el.style.position = '';
  el.style.left = '';
  el.style.top = '';
  el.style.width = '';
  el.style.height = '';
  el.style.maxWidth = '';
  el.style.maxHeight = '';
  el.style.transform = '';
}

function getStageSize() {
  const stage = document.getElementById('media-crop-stage');
  if (!stage) return { iw: 0, ih: 0 };
  return { iw: stage.clientWidth, ih: stage.clientHeight };
}

function getNatSize() {
  const img = document.getElementById('media-crop-img');
  const video = document.getElementById('media-crop-video');
  const el = img?.style.display !== 'none' ? img : video;
  if (!el) return null;
  const natW = el.naturalWidth || el.videoWidth || 0;
  const natH = el.naturalHeight || el.videoHeight || 0;
  if (!natW || !natH) return null;
  return { el, natW, natH };
}

/** 自由裁剪：图片 contain 铺在舞台里 */
function getMediaMetrics() {
  const nat = getNatSize();
  const inner = document.getElementById('media-crop-inner');
  if (!nat || !inner) return null;
  const iw = inner.clientWidth;
  const ih = inner.clientHeight;
  const scale = Math.min(iw / nat.natW, ih / nat.natH);
  const dispW = nat.natW * scale;
  const dispH = nat.natH * scale;
  const offX = (iw - dispW) / 2;
  const offY = (ih - dispH) / 2;
  return { ...nat, scale, dispW, dispH, offX, offY, iw, ih };
}

function computeFixedFrame(iw, ih, aspect) {
  const pad = 12;
  const maxW = Math.max(1, iw - pad * 2);
  const maxH = Math.max(1, ih - pad * 2);
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return {
    left: (iw - w) / 2,
    top: (ih - h) / 2,
    w,
    h,
  };
}

function fixedCoverBaseScale(natW, natH, frame) {
  return Math.max(frame.w / natW, frame.h / natH);
}

function clampFixedImage() {
  if (!isFixedCrop()) return;
  const st = _cropState;
  const frame = st.frame;
  const scale = st.baseScale * st.zoom;
  const imgW = st.natW * scale;
  const imgH = st.natH * scale;
  // 画面必须盖住取景框
  const minLeft = frame.left + frame.w - imgW;
  const maxLeft = frame.left;
  const minTop = frame.top + frame.h - imgH;
  const maxTop = frame.top;
  st.imgLeft = Math.min(maxLeft, Math.max(minLeft, st.imgLeft));
  st.imgTop = Math.min(maxTop, Math.max(minTop, st.imgTop));
}

function setFixedZoom(nextZoom, pivotX, pivotY) {
  if (!isFixedCrop()) return;
  const st = _cropState;
  const z0 = st.zoom;
  const z1 = Math.min(6, Math.max(1, nextZoom));
  if (Math.abs(z1 - z0) < 1e-4) return;
  const px = pivotX ?? (st.frame.left + st.frame.w / 2);
  const py = pivotY ?? (st.frame.top + st.frame.h / 2);
  // 相对取景中心缩放：保持 pivot 下的图像点不动
  const scale0 = st.baseScale * z0;
  const scale1 = st.baseScale * z1;
  const imgX = (px - st.imgLeft) / scale0;
  const imgY = (py - st.imgTop) / scale0;
  st.zoom = z1;
  st.imgLeft = px - imgX * scale1;
  st.imgTop = py - imgY * scale1;
  clampFixedImage();
}

function syncBoxVisual() {
  if (isFixedCrop()) {
    syncFixedVisual();
    return;
  }
  const m = getMediaMetrics();
  const box = document.getElementById('media-crop-box');
  const dim = document.getElementById('media-crop-dim');
  if (!m || !box || !_cropState) return;
  const { crop } = _cropState;
  const left = m.offX + crop.x * m.dispW;
  const top = m.offY + crop.y * m.dispH;
  const w = crop.w * m.dispW;
  const h = crop.h * m.dispH;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
  box.style.aspectRatio = '';
  updateDimClip(dim, m.iw, m.ih, left, top, w, h);
}

function syncFixedVisual() {
  const st = _cropState;
  const box = document.getElementById('media-crop-box');
  const dim = document.getElementById('media-crop-dim');
  const nat = getNatSize();
  if (!st?.frame || !box || !nat) return;
  const { frame } = st;
  const scale = st.baseScale * st.zoom;
  const el = nat.el;
  el.style.position = 'absolute';
  el.style.maxWidth = 'none';
  el.style.maxHeight = 'none';
  el.style.width = `${st.natW * scale}px`;
  el.style.height = `${st.natH * scale}px`;
  el.style.left = `${st.imgLeft}px`;
  el.style.top = `${st.imgTop}px`;

  box.style.left = `${frame.left}px`;
  box.style.top = `${frame.top}px`;
  box.style.width = `${frame.w}px`;
  box.style.height = `${frame.h}px`;
  box.style.aspectRatio = '';

  const { iw, ih } = getStageSize();
  updateDimClip(dim, iw, ih, frame.left, frame.top, frame.w, frame.h);
}

function updateDimClip(dim, iw, ih, left, top, w, h) {
  if (!dim || !(iw > 0) || !(ih > 0)) return;
  const x0 = (left / iw) * 100;
  const y0 = (top / ih) * 100;
  const x1 = ((left + w) / iw) * 100;
  const y1 = ((top + h) / ih) * 100;
  dim.style.clipPath = `polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${x0}% ${y0}%, ${x0}% ${y1}%, ${x1}% ${y1}%, ${x1}% ${y0}%, ${x0}% ${y0}%)`;
}

function scheduleSyncBoxVisual() {
  if (_cropRaf) return;
  _cropRaf = requestAnimationFrame(() => {
    _cropRaf = 0;
    syncBoxVisual();
  });
}

function getAspectNorm(m) {
  if (_cropAspect == null || !m || !m.dispW) return null;
  return _cropAspect * m.dispH / m.dispW;
}

function clampCrop(crop, min = 0.08) {
  let { x, y, w, h } = crop;
  w = Math.max(min, Math.min(1, w));
  h = Math.max(min, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, w, h };
}

function enforceCropAspect(crop, m, min = 0.08) {
  if (_cropAspect == null || !m) return clampCrop(crop, min);
  const aspectNorm = getAspectNorm(m);
  if (!aspectNorm) return clampCrop(crop, min);
  let { x, y, w } = crop;
  w = Math.max(min, Math.min(1, w));
  let h = w / aspectNorm;
  if (h > 1) {
    h = 1;
    w = Math.max(min, h * aspectNorm);
  }
  if (h < min) {
    h = min;
    w = Math.min(1, h * aspectNorm);
  }
  x = Math.max(0, Math.min(1 - w, x ?? crop.x));
  y = Math.max(0, Math.min(1 - h, y ?? crop.y));
  return { x, y, w, h };
}

function setCropState(crop, m) {
  if (!_cropState || !m || isFixedCrop()) return;
  _cropState.crop = _cropAspect != null ? enforceCropAspect(crop, m) : clampCrop(crop);
  scheduleSyncBoxVisual();
}

function resizeCropWithAspect(start, handle, dx, dy, aspectNorm, m, min = 0.08) {
  let x = start.x;
  let y = start.y;
  let w = start.w;
  let h = start.h;

  if (handle === 'se') {
    w = start.w + dx;
    h = w / aspectNorm;
  } else if (handle === 'ne') {
    w = start.w + dx;
    h = w / aspectNorm;
    y = start.y + start.h - h;
  } else if (handle === 'sw') {
    w = start.w - dx;
    h = w / aspectNorm;
    x = start.x + start.w - w;
  } else if (handle === 'nw') {
    w = start.w - dx;
    h = w / aspectNorm;
    x = start.x + start.w - w;
    y = start.y + start.h - h;
  }

  if (w < min) { w = min; h = w / aspectNorm; }
  if (h < min) { h = min; w = h * aspectNorm; }
  return enforceCropAspect({ x, y, w, h }, m, min);
}

function getPinchDist() {
  const pts = [..._activePointers.values()];
  if (pts.length < 2) return null;
  return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
}

function getPinchCenter() {
  const pts = [..._activePointers.values()];
  if (pts.length < 2) return null;
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
}

function endCropDrag() {
  _activePointers.clear();
  _dragMode = null;
}

function onCropWheel(e) {
  if (!isFixedCrop()) return;
  e.preventDefault();
  const stage = document.getElementById('media-crop-stage');
  const rect = stage?.getBoundingClientRect();
  if (!rect) return;
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const factor = e.deltaY > 0 ? 0.92 : 1.08;
  setFixedZoom(_cropState.zoom * factor, px, py);
  scheduleSyncBoxVisual();
}

function onCropPointerDown(e) {
  if (!_cropState) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  const stage = document.getElementById('media-crop-stage');
  try { stage?.setPointerCapture?.(e.pointerId); } catch {}

  e.preventDefault();
  _activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (isFixedCrop()) {
    if (_activePointers.size >= 2) {
      const startDist = getPinchDist();
      const pinchCenter = getPinchCenter();
      if (!startDist || !pinchCenter) return;
      const rect = stage.getBoundingClientRect();
      _dragMode = {
        kind: 'fixed-pinch',
        startDist,
        startZoom: _cropState.zoom,
        pivotX: pinchCenter.x - rect.left,
        pivotY: pinchCenter.y - rect.top,
      };
      return;
    }
    _dragMode = {
      kind: 'fixed-pan',
      startX: e.clientX,
      startY: e.clientY,
      imgLeft: _cropState.imgLeft,
      imgTop: _cropState.imgTop,
    };
    return;
  }

  if (_activePointers.size >= 2) {
    const startDist = getPinchDist();
    const pinchCenter = getPinchCenter();
    const m = getMediaMetrics();
    if (!m || !startDist || !pinchCenter) return;
    const startCrop = { ..._cropState.crop };
    const cx = (pinchCenter.x - (m.offX + startCrop.x * m.dispW)) / Math.max(1e-6, startCrop.w * m.dispW);
    const cy = (pinchCenter.y - (m.offY + startCrop.y * m.dispH)) / Math.max(1e-6, startCrop.h * m.dispH);
    _dragMode = { kind: 'pinch', startDist, startCrop, cx, cy, metrics: m };
    return;
  }

  const handle = e.target?.dataset?.handle || 'move';
  const m = getMediaMetrics();
  if (!m || !m.dispW) return;
  _dragMode = {
    kind: handle === 'move' ? 'move' : 'resize',
    handle,
    startX: e.clientX,
    startY: e.clientY,
    startCrop: { ..._cropState.crop },
    metrics: m,
    aspectNorm: getAspectNorm(m),
  };
}

function onCropPointerMove(e) {
  if (!_cropState || !_dragMode || !_activePointers.has(e.pointerId)) return;
  e.preventDefault();
  _activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (_dragMode.kind === 'fixed-pan') {
    if (_activePointers.size >= 2) return;
    _cropState.imgLeft = _dragMode.imgLeft + (e.clientX - _dragMode.startX);
    _cropState.imgTop = _dragMode.imgTop + (e.clientY - _dragMode.startY);
    clampFixedImage();
    scheduleSyncBoxVisual();
    return;
  }

  if (_dragMode.kind === 'fixed-pinch') {
    if (_activePointers.size < 2) return;
    const newDist = getPinchDist();
    if (!newDist || !_dragMode.startDist) return;
    setFixedZoom(_dragMode.startZoom * (newDist / _dragMode.startDist), _dragMode.pivotX, _dragMode.pivotY);
    scheduleSyncBoxVisual();
    return;
  }

  if (_dragMode.kind === 'pinch') {
    if (_activePointers.size < 2) return;
    const m = _dragMode.metrics || getMediaMetrics();
    const newDist = getPinchDist();
    if (!m || !newDist || !_dragMode.startDist) return;
    const ratio = _dragMode.startDist / newDist;
    const { startCrop, cx, cy } = _dragMode;
    if (_cropAspect != null) {
      const aspectNorm = getAspectNorm(m);
      const min = 0.08;
      let newW = Math.max(min, Math.min(1, startCrop.w / ratio));
      let newH = newW / aspectNorm;
      if (newH > 1) { newH = 1; newW = newH * aspectNorm; }
      _cropState.crop = enforceCropAspect({
        x: startCrop.x + startCrop.w * cx - newW * cx,
        y: startCrop.y + startCrop.h * cy - newH * cy,
        w: newW,
        h: newH,
      }, m, min);
    } else {
      const newW = Math.max(0.08, Math.min(1, startCrop.w * ratio));
      const newH = Math.max(0.08, Math.min(1, startCrop.h * ratio));
      let newX = startCrop.x + startCrop.w * cx - newW * cx;
      let newY = startCrop.y + startCrop.h * cy - newH * cy;
      newX = Math.max(0, Math.min(1 - newW, newX));
      newY = Math.max(0, Math.min(1 - newH, newY));
      _cropState.crop = { x: newX, y: newY, w: newW, h: newH };
    }
    scheduleSyncBoxVisual();
    return;
  }

  if (_activePointers.size >= 2) return;

  const m = _dragMode.metrics;
  if (!m?.dispW) return;
  const dx = (e.clientX - _dragMode.startX) / m.dispW;
  const dy = (e.clientY - _dragMode.startY) / m.dispH;
  const startCrop = _dragMode.startCrop;
  const handle = _dragMode.handle || 'move';
  const min = 0.08;
  const aspectNorm = _dragMode.aspectNorm;

  if (_dragMode.kind === 'move' || handle === 'move') {
    setCropState({
      x: Math.max(0, Math.min(1 - startCrop.w, startCrop.x + dx)),
      y: Math.max(0, Math.min(1 - startCrop.h, startCrop.y + dy)),
      w: startCrop.w,
      h: startCrop.h,
    }, m);
    return;
  }

  if (aspectNorm != null && ['nw', 'ne', 'sw', 'se'].includes(handle)) {
    _cropState.crop = resizeCropWithAspect(startCrop, handle, dx, dy, aspectNorm, m, min);
    scheduleSyncBoxVisual();
    return;
  }
  if (aspectNorm != null) return;

  let { x, y, w, h } = startCrop;
  if (handle.includes('w')) { x = startCrop.x + dx; w = startCrop.w - dx; }
  if (handle.includes('e')) { w = startCrop.w + dx; }
  if (handle.includes('n')) { y = startCrop.y + dy; h = startCrop.h - dy; }
  if (handle.includes('s')) { h = startCrop.h + dy; }
  if (w < min) { x = startCrop.x + startCrop.w - min; w = min; }
  if (h < min) { y = startCrop.y + startCrop.h - min; h = min; }
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  _cropState.crop = { x, y, w, h };
  scheduleSyncBoxVisual();
}

function onCropPointerEnd(e) {
  if (!_activePointers.has(e.pointerId) && !_dragMode) return;
  _activePointers.delete(e.pointerId);
  try {
    const stage = document.getElementById('media-crop-stage');
    if (stage?.hasPointerCapture?.(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  } catch {}

  if (_activePointers.size === 0) {
    _dragMode = null;
    return;
  }

  if ((_dragMode?.kind === 'pinch' || _dragMode?.kind === 'fixed-pinch') && _activePointers.size === 1) {
    const [pt] = _activePointers.values();
    if (isFixedCrop()) {
      _dragMode = {
        kind: 'fixed-pan',
        startX: pt.x,
        startY: pt.y,
        imgLeft: _cropState.imgLeft,
        imgTop: _cropState.imgTop,
      };
    } else {
      const m = getMediaMetrics();
      _dragMode = {
        kind: 'move',
        handle: 'move',
        startX: pt.x,
        startY: pt.y,
        startCrop: { ...(_cropState?.crop || { x: 0, y: 0, w: 1, h: 1 }) },
        metrics: m,
        aspectNorm: getAspectNorm(m),
      };
    }
  }
}

function fixedCropToPixels() {
  const st = _cropState;
  if (!st?.frame) return null;
  const scale = st.baseScale * st.zoom;
  const x = (st.frame.left - st.imgLeft) / scale;
  const y = (st.frame.top - st.imgTop) / scale;
  const w = st.frame.w / scale;
  const h = st.frame.h / scale;
  return {
    x: Math.round(Math.max(0, Math.min(st.natW - 1, x))),
    y: Math.round(Math.max(0, Math.min(st.natH - 1, y))),
    w: Math.round(Math.max(1, Math.min(st.natW, w))),
    h: Math.round(Math.max(1, Math.min(st.natH, h))),
  };
}

async function confirmCrop() {
  if (!_cropState) return closeCrop(null);
  const confirmBtn = document.getElementById('media-crop-confirm');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '处理中…';
  }
  try {
    const { isVideo, file } = _cropState;
    let px;
    let el;
    let natW;
    let natH;

    if (isFixedCrop()) {
      px = fixedCropToPixels();
      const nat = getNatSize();
      if (!px || !nat) return closeCrop(null);
      el = nat.el;
      natW = nat.natW;
      natH = nat.natH;
      // 导出用归一化 crop（视频 / retainSource）
      _cropState.crop = {
        x: px.x / natW,
        y: px.y / natH,
        w: px.w / natW,
        h: px.h / natH,
      };
    } else {
      const m = getMediaMetrics();
      if (!m) return closeCrop(null);
      const { crop } = _cropState;
      natW = m.natW;
      natH = m.natH;
      el = m.el;
      px = {
        x: Math.round(crop.x * natW),
        y: Math.round(crop.y * natH),
        w: Math.round(crop.w * natW),
        h: Math.round(crop.h * natH),
      };
    }

    if (isVideo || _cropState.retainSource) {
      closeCrop({ file, crop: _cropState.crop, isVideo, retainSource: !!_cropState.retainSource });
      return;
    }

    const maxEdge = Math.max(720, Number(_cropState.maxEdge) || 1600);
    let outW = Math.max(1, px.w);
    let outH = Math.max(1, px.h);
    if (outW > maxEdge || outH > maxEdge) {
      const scale = Math.min(maxEdge / outW, maxEdge / outH);
      outW = Math.max(1, Math.round(outW * scale));
      outH = Math.max(1, Math.round(outH * scale));
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      window.showToast?.('裁剪失败，请换一张图');
      return closeCrop(null);
    }
    try {
      ctx.drawImage(el, px.x, px.y, px.w, px.h, 0, 0, outW, outH);
    } catch (err) {
      console.warn('[crop] drawImage failed', err);
      window.showToast?.('这张图无法裁剪，请换 JPG/PNG 再试');
      return closeCrop(null);
    }

    const blob = await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(null);
      }, 20000);
      try {
        canvas.toBlob((b) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(b || null);
        }, 'image/jpeg', 0.85);
      } catch {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
    if (!blob) {
      window.showToast?.('图片太大或处理超时，请换小一点的图');
      return closeCrop(null);
    }
    closeCrop({ blob, crop: null, isVideo: false, fileName: file.name.replace(/\.\w+$/, '') + '.jpg' });
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '确定';
    }
  }
}

/**
 * 打开裁剪框。返回 { blob, crop } 图片 | { file, crop, isVideo } 视频 | null 取消
 * aspect: 锁定宽高比时钉住取景框，只能拖动画布 / 双指缩放
 * maxEdge: 导出图片最长边（像素）
 */
export function openMediaCrop(file, { title = '调整裁剪', aspect = null, retainSource = false, maxEdge } = {}) {
  ensureCropDOM();
  if (_cropResolve) closeCrop(null);

  return new Promise((resolve) => {
    _cropResolve = resolve;
    _cropAspect = parseAspect(aspect);
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name || '');
    const isImage = file.type.startsWith('image/') || (!file.type && /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name || ''));
    if (!isVideo && !isImage) {
      window.showToast?.('请选择图片或视频');
      resolve(null);
      _cropResolve = null;
      return;
    }
    if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '')) {
      window.showToast?.('暂不支持 HEIC，请用系统相册导出为 JPG 后再传');
      resolve(null);
      _cropResolve = null;
      return;
    }

    document.getElementById('media-crop-title').textContent = title;
    const overlay = document.getElementById('media-crop-overlay');
    const stage = document.getElementById('media-crop-stage');
    const img = document.getElementById('media-crop-img');
    const video = document.getElementById('media-crop-video');
    const fixed = _cropAspect != null;
    stage?.classList.toggle('is-fixed-frame', fixed);

    const hint = overlay.querySelector('.media-crop-hint');
    if (hint) {
      hint.textContent = fixed
        ? '取景框固定 · 拖动移动画面 · 双指缩放'
        : '拖动框选区域 · 拖边角缩放';
    }

    revokeCropObjectUrl();
    const url = URL.createObjectURL(file);
    _cropObjectUrl = url;
    let readyOnce = false;

    const initCrop = () => {
      const nat = getNatSize();
      const { iw, ih } = getStageSize();
      if (!nat || !iw || !ih) return false;

      if (fixed) {
        const frame = computeFixedFrame(iw, ih, _cropAspect);
        const baseScale = fixedCoverBaseScale(nat.natW, nat.natH, frame);
        const imgW = nat.natW * baseScale;
        const imgH = nat.natH * baseScale;
        _cropState = {
          file,
          isVideo,
          retainSource: retainSource && isImage,
          maxEdge,
          fixed: true,
          natW: nat.natW,
          natH: nat.natH,
          frame,
          baseScale,
          zoom: 1,
          imgLeft: frame.left + (frame.w - imgW) / 2,
          imgTop: frame.top + (frame.h - imgH) / 2,
          crop: { x: 0, y: 0, w: 1, h: 1 },
        };
        clampFixedImage();
        syncBoxVisual();
        return true;
      }

      const m = getMediaMetrics();
      if (!m || (m.dispW === 0 && m.dispH === 0)) return false;
      const w = 0.85;
      const h = 0.85;
      const crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
      _cropState = { file, isVideo, retainSource: retainSource && isImage, crop, maxEdge, fixed: false };
      syncBoxVisual();
      return true;
    };

    const onReady = () => {
      if (readyOnce || !_cropResolve) return;
      readyOnce = true;
      clearCropLoadTimer();
      overlay.style.display = 'flex';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!_cropResolve) return;
        if (!initCrop()) {
          setTimeout(() => {
            if (!_cropResolve) return;
            if (!initCrop()) {
              window.showToast?.('图片加载异常，请重试');
              closeCrop(null);
            }
          }, 120);
        }
      }));
    };

    const onFail = (msg) => {
      clearCropLoadTimer();
      window.showToast?.(msg || '图片加载失败');
      closeCrop(null);
    };

    clearCropLoadTimer();
    _cropLoadTimer = setTimeout(() => {
      onFail('图片加载超时，请换一张或压缩后再传');
    }, 25000);

    resetMediaElLayout(img);
    resetMediaElLayout(video);

    if (isVideo) {
      img.style.display = 'none';
      video.style.display = 'block';
      video.onerror = () => onFail('视频加载失败');
      video.onloadeddata = () => { try { video.currentTime = 0.1; } catch { onReady(); } };
      video.onseeked = onReady;
      video.src = url;
    } else {
      video.style.display = 'none';
      img.style.display = 'block';
      img.onerror = () => onFail('图片加载失败，请换 JPG/PNG');
      img.onload = onReady;
      img.src = url;
      if (img.complete && img.naturalWidth > 0) onReady();
    }
  });
}

/** 裁剪后上传，返回 { url, crop? } */
export async function pickCropAndUpload(file, opts = {}) {
  const cropped = await openMediaCrop(file, opts);
  if (!cropped) return null;

  if (cropped.isVideo || cropped.retainSource) {
    const result = await uploadFile(cropped.file);
    return { ...result, crop: cropped.crop };
  }

  const name = cropped.fileName || 'cropped.jpg';
  const f = new File([cropped.blob], name, { type: 'image/jpeg' });
  const result = await uploadFile(f);
  return { ...result, crop: cropped.crop };
}

/** 将归一化 crop 应用到 img/video 元素（相对原图 0~1 区域） */
export function applyMediaCrop(el, crop) {
  if (!el) return;
  el.style.position = 'absolute';
  el.style.maxWidth = 'none';
  el.style.transform = 'none';
  el.style.transformOrigin = 'center center';

  if (!crop || crop.w <= 0 || crop.h <= 0) {
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.left = '0';
    el.style.top = '0';
    el.style.objectFit = 'cover';
    el.style.objectPosition = 'center center';
    return;
  }

  const { x, y, w, h } = crop;
  el.style.objectFit = 'cover';
  el.style.width = `${100 / w}%`;
  el.style.height = `${100 / h}%`;
  el.style.left = `${(-x / w) * 100}%`;
  el.style.top = `${(-y / h) * 100}%`;
}

export function resetBgMediaEl(el) {
  if (!el) return;
  el.onload = null;
  el.onloadeddata = null;
  el.onerror = null;
  el.onended = null;
  if (el.tagName === 'VIDEO') {
    el._bgPlayGen = (el._bgPlayGen || 0) + 1;
    el.pause?.();
  }
  applyMediaCrop(el, null);
}

export function setupBgImage(img, url, crop) {
  if (!img || !url) return;
  img.style.display = 'block';
  img.style.opacity = '1';

  const onReady = () => {
    try {
      applyMediaCrop(img, crop);
    } catch (e) {
      console.warn('[bg-image] crop failed', e);
    }
  };

  img.onerror = () => {
    console.warn('[bg-image] load failed:', url);
    img.style.display = 'none';
  };

  const sameSrc = img.dataset.bgSrc === url || (img.currentSrc || img.src || '').endsWith(url);
  img.dataset.bgSrc = url;

  if (sameSrc && img.complete && img.naturalWidth > 0) {
    onReady();
    return;
  }

  img.onload = onReady;
  img.src = url;
}

export function resetBgVideoEl(video) {
  resetBgMediaEl(video);
}

export function setupBgVideo(video, url, crop, opts = {}) {
  if (!video || !url) return;
  video.style.display = 'block';
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';

  const allowPlay = () => {
    const ap = opts.allowPlay;
    if (typeof ap === 'function') return !!ap();
    if (ap === false) return false;
    return true;
  };

  const gen = (video._bgPlayGen = (video._bgPlayGen || 0) + 1);

  const tryPlay = () => {
    if (gen !== video._bgPlayGen) return;
    if (!allowPlay()) return;
    video.play().catch(() => {});
  };

  const onReady = () => {
    if (gen !== video._bgPlayGen) return;
    try {
      applyMediaCrop(video, crop);
      tryPlay();
    } catch (e) {
      console.warn('[bg-video] crop/play failed', e);
      video.style.display = 'none';
    }
  };

  video.onerror = () => {
    if (gen !== video._bgPlayGen) return;
    console.warn('[bg-video] load failed:', url);
    video.style.display = 'none';
  };
  video.onended = () => {
    if (gen !== video._bgPlayGen) return;
    video.currentTime = 0;
    tryPlay();
  };

  let absUrl = url;
  try { absUrl = new URL(url, location.origin).href; } catch {}

  const current = video.currentSrc || video.src || '';
  const sameSrc = current === absUrl || current.endsWith(url) || video.dataset.bgSrc === url;
  video.dataset.bgSrc = url;

  if (sameSrc && video.readyState >= 2) {
    onReady();
    return;
  }

  video.onloadeddata = onReady;
  video.src = url;
  video.load();
}

window.openMediaCrop = openMediaCrop;
window.pickCropAndUpload = pickCropAndUpload;
window.applyMediaCrop = applyMediaCrop;
window.setupBgVideo = setupBgVideo;
window.setupBgImage = setupBgImage;
window.resetBgVideoEl = resetBgVideoEl;
window.resetBgMediaEl = resetBgMediaEl;
window.momentsCoverAspect = momentsCoverAspect;
window.parseAspect = parseAspect;

/* ===== 写真馆：选人 → 形象 → 更衣间 → 背景 → 拍摄 → 后台出片 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { pickCropAndUpload } from '../media-crop.js';

const STEPS = [
  { id: 'cast', label: '选人' },
  { id: 'user', label: '形象' },
  { id: 'wardrobe', label: '更衣间' },
  { id: 'backgrounds', label: '背景' },
  { id: 'shoot', label: '拍摄' },
  { id: 'jobs', label: '出片' },
];

let _meta = null;
let _chars = [];
let _session = null;
let _step = 'cast';
let _selected = new Set();
let _dressSubject = 'user';
let _pickedItems = [];
let _wardrobeItems = [];
let _vibe = '';
let _pollTimer = null;
let _pendingJobIds = new Set();

function media(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  return window.resolveMediaUrl?.(s) || s;
}

function toast(msg) {
  window.showToast?.(msg);
}

function charName(id) {
  const c = _chars.find((x) => Number(x.id) === Number(id));
  return c?.display_name || c?.name || `角色${id}`;
}

function lookKey(subject) {
  return subject === 'user' ? 'user' : String(subject);
}

function lookOf(subject) {
  return (_session?.looks || {})[lookKey(subject)] || {};
}

function stopPoll() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

function startPoll() {
  stopPoll();
  _pollTimer = setInterval(() => {
    pollJobs().catch(() => {});
  }, 3500);
}

async function refreshSession() {
  if (!_session?.id) return;
  const r = await api.getPhotostudioSession(_session.id);
  _session = r.session || r;
}

async function saveSession(patch) {
  if (!_session?.id) return;
  const r = await api.patchPhotostudioSession(_session.id, patch);
  _session = r.session || r;
}

window.initPhotostudioPage = async function initPhotostudioPage() {
  const page = document.getElementById('photostudio-page');
  if (!page) return;
  stopPoll();
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const [metaRes, chars] = await Promise.all([
      api.getPhotostudioMeta(),
      api.getCharacters(),
    ]);
    _meta = metaRes;
    const raw = Array.isArray(chars) ? chars : (chars?.characters || []);
    _chars = window.filterFullCharacters?.(raw) || raw;
    if (_session?.id) {
      await refreshSession();
      _selected = new Set(_session.characterIds || []);
    } else {
      _step = 'cast';
      _selected = new Set();
      _pickedItems = [];
      _vibe = '';
    }
    render();
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
  }
};

function setStep(step) {
  _step = step;
  if (step === 'jobs') startPoll();
  else stopPoll();
  render();
  if (step === 'jobs') pollJobs().catch(() => {});
}

function render() {
  const page = document.getElementById('photostudio-page');
  if (!page) return;
  page.innerHTML = `
    <div class="ps-shell">
      <div class="topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="psGoBack()" title="返回"></button>
        <div class="topbar-title">写真馆</div>
        <div class="topbar-actions"></div>
      </div>
      <div class="ps-steps">${STEPS.map((s) => `
        <button type="button" class="ps-step ${s.id === _step ? 'active' : ''}" onclick="psGotoStep('${s.id}')">${escapeHtml(s.label)}</button>
      `).join('')}</div>
      <div class="ps-body" id="ps-body">${renderStep()}</div>
    </div>
  `;
}

window.psGoBack = function() {
  if (_step !== 'cast' && _session) {
    const idx = STEPS.findIndex((s) => s.id === _step);
    if (idx > 0) {
      setStep(STEPS[idx - 1].id);
      return;
    }
  }
  stopPoll();
  window.goBack?.() || window.navigateTo?.('home');
};

window.psGotoStep = function(step) {
  if (!_session && step !== 'cast') {
    toast('请先选择角色并开始');
    return;
  }
  setStep(step);
};

function renderStep() {
  switch (_step) {
    case 'user': return renderUser();
    case 'wardrobe': return renderWardrobe();
    case 'backgrounds': return renderBackgrounds();
    case 'shoot': return renderShoot();
    case 'jobs': return renderJobs();
    default: return renderCast();
  }
}

function renderCast() {
  const max = _meta?.maxCast || 3;
  return `
    <div class="ps-card">
      <div class="ps-title">和谁合影？</div>
      <div class="ps-sub">最多选 ${max} 位角色，可多角色同框</div>
      <div class="ps-cast-grid">
        ${_chars.map((c) => {
          const on = _selected.has(Number(c.id));
          const av = media(c.avatar || '');
          return `
            <button type="button" class="ps-cast-item ${on ? 'on' : ''}" onclick="psToggleCast(${c.id})">
              ${av ? `<img src="${escapeHtml(av)}" alt="">` : `<div class="ps-cast-ph">${escapeHtml((c.name || '?').slice(0, 1))}</div>`}
              <span>${escapeHtml(c.display_name || c.name || '')}</span>
            </button>`;
        }).join('') || '<div class="ps-muted">还没有角色</div>'}
      </div>
      <button type="button" class="btn btn-primary ps-main-btn" onclick="psStartSession()">开始这场写真</button>
    </div>`;
}

window.psToggleCast = function(id) {
  const n = Number(id);
  const max = _meta?.maxCast || 3;
  if (_selected.has(n)) _selected.delete(n);
  else {
    if (_selected.size >= max) {
      toast(`最多选 ${max} 位`);
      return;
    }
    _selected.add(n);
  }
  render();
};

window.psStartSession = async function() {
  const ids = [..._selected];
  if (!ids.length) {
    toast('请先选角色');
    return;
  }
  try {
    if (_session?.id) {
      await saveSession({ characterIds: ids });
    } else {
      const r = await api.createPhotostudioSession(ids);
      _session = r.session || r;
    }
    setStep('user');
  } catch (e) {
    toast(e.message || '创建失败');
  }
};

function renderUser() {
  const u = _session?.user || {};
  const builds = _meta?.builds || ['偏瘦', '标准', '偏丰满'];
  const heightRels = _meta?.heightRels || [
    { id: 'same', label: '和角色差不多高' },
    { id: 'shorter_0_5', label: '比角色矮半个头' },
    { id: 'shorter_1', label: '比角色矮一个头' },
    { id: 'shorter_1_5', label: '比角色矮一个半头' },
    { id: 'shorter_2', label: '比角色矮两个头' },
    { id: 'taller_0_5', label: '比角色高半个头' },
    { id: 'taller_1', label: '比角色高一个头' },
  ];
  return `
    <div class="ps-card">
      <div class="ps-title">你的形象</div>
      <div class="ps-sub">脸部形象必传；全身可选，用来稳住身材比例。身高用和角色比「差几个头」来填。</div>
      <div class="ps-ref-row">
        <button type="button" class="ps-upload-tile" onclick="psUploadUserFace()">
          ${u.faceUrl ? `<img src="${escapeHtml(media(u.faceUrl))}" alt="">` : '<span>上传脸部</span>'}
        </button>
        <button type="button" class="ps-upload-tile" onclick="psUploadUserBody()">
          ${u.bodyUrl ? `<img src="${escapeHtml(media(u.bodyUrl))}" alt="">` : '<span>全身（可选）</span>'}
        </button>
      </div>
      <label class="ps-field">相对身高（比角色）
        <select class="input" id="ps-user-height-rel">
          <option value="">不指定</option>
          ${heightRels.map((h) => `<option value="${escapeHtml(h.id)}" ${u.heightRel === h.id ? 'selected' : ''}>${escapeHtml(h.label)}</option>`).join('')}
        </select>
      </label>
      <label class="ps-field">体型
        <select class="input" id="ps-user-build">
          <option value="">不填</option>
          ${builds.map((b) => `<option value="${escapeHtml(b)}" ${u.build === b ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>
      </label>
      <button type="button" class="btn btn-primary ps-main-btn" onclick="psSaveUser()">下一步：更衣间</button>
    </div>`;
}

window.psUploadUserFace = async function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const result = await pickCropAndUpload(file, { title: '裁剪脸部形象', aspect: 1 });
      if (!result?.url) return;
      await saveSession({ user: { ...(_session.user || {}), faceUrl: result.url } });
      render();
    } catch (e) {
      toast(e.message || '上传失败');
    }
  };
  input.click();
};

window.psUploadUserBody = async function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const result = await pickCropAndUpload(file, { title: '裁剪全身形象', aspect: '3:4' });
      if (!result?.url) return;
      await saveSession({ user: { ...(_session.user || {}), bodyUrl: result.url } });
      render();
    } catch (e) {
      toast(e.message || '上传失败');
    }
  };
  input.click();
};

window.psSaveUser = async function() {
  if (!_session?.user?.faceUrl) {
    toast('请先上传脸部形象图');
    return;
  }
  const heightRel = document.getElementById('ps-user-height-rel')?.value || '';
  const build = document.getElementById('ps-user-build')?.value || '';
  try {
    await saveSession({ user: { ...(_session.user || {}), heightRel, build, height: '' } });
    _dressSubject = String(_session.characterIds[0] || 'user');
    await loadWardrobeForSubject();
    setStep('wardrobe');
  } catch (e) {
    toast(e.message || '保存失败');
  }
};

async function loadWardrobeForSubject() {
  _wardrobeItems = [];
  if (_dressSubject === 'user') return;
  try {
    const r = await api.getWardrobe(_dressSubject);
    _wardrobeItems = r.items || [];
  } catch {
    _wardrobeItems = [];
  }
}

function catLabel(id) {
  return (_meta?.categories || []).find((c) => c.id === id)?.label || id || '';
}

function renderWardrobe() {
  const subjects = [
    ...(_session?.characterIds || []).map((id) => ({ id: String(id), label: charName(id) })),
    { id: 'user', label: '你' },
  ];
  const look = lookOf(_dressSubject);
  const cats = _meta?.categories || [];
  return `
    <div class="ps-card">
      <div class="ps-title">更衣间</div>
      <div class="ps-sub">确认后的定妆图会作为合影人物参考。试穿图仅供看效果，褶皱细节合影时会随姿势重绘。</div>
      <div class="ps-subject-tabs">
        ${subjects.map((s) => `
          <button type="button" class="ps-chip ${String(_dressSubject) === s.id ? 'on' : ''}"
            onclick="psDressSubject('${s.id}')">${escapeHtml(s.label)}
            ${lookOf(s.id).confirmedUrl ? ' ✓' : ''}
          </button>`).join('')}
      </div>
      ${_vibe ? `<div class="ps-vibe">${escapeHtml(_vibe)}</div>` : ''}
      <div class="ps-look-preview">
        ${look.previewUrl || look.confirmedUrl
          ? `<img src="${escapeHtml(media(look.confirmedUrl || look.previewUrl))}" alt="">`
          : '<div class="ps-muted">还没有定妆预览</div>'}
      </div>
      <div class="ps-section-label">本场穿着</div>
      <div class="ps-picked">
        ${_pickedItems.length
          ? _pickedItems.map((it, i) => `
            <div class="ps-picked-item">
              ${it.imageUrl ? `<img src="${escapeHtml(media(it.imageUrl))}" alt="">` : ''}
              <div>
                <div>${escapeHtml(it.name || '未命名')}</div>
                <div class="ps-muted">${escapeHtml(catLabel(it.category))}</div>
              </div>
              <button type="button" class="icon-btn" onclick="psRemovePicked(${i})">×</button>
            </div>`).join('')
          : '<div class="ps-muted">从衣柜选，或上传新服饰</div>'}
      </div>
      ${_dressSubject !== 'user' ? `
        <div class="ps-section-label">衣柜里选</div>
        <div class="ps-wardrobe-list">
          ${_wardrobeItems.slice(0, 40).map((it) => {
            const payload = encodeURIComponent(JSON.stringify({
              id: it.id, category: it.category, name: it.name, imageUrl: it.image_url || '',
            }));
            return `
            <button type="button" class="ps-ward-item" onclick="psPickWardrobeItemEncoded('${payload}')">
              ${it.image_url ? `<img src="${escapeHtml(media(it.image_url))}" alt="">` : ''}
              <span>${escapeHtml(it.name)}</span>
              <em>${escapeHtml(catLabel(it.category))}</em>
            </button>`;
          }).join('') || '<div class="ps-muted">衣柜还是空的</div>'}
        </div>` : ''}
      <div class="ps-row-btns">
        <button type="button" class="btn" onclick="psUploadCloth()">上传服饰</button>
        <button type="button" class="btn" onclick="psTryOn()">生成试穿图</button>
        <button type="button" class="btn btn-primary" onclick="psConfirmLook()">确认定妆</button>
      </div>
      <button type="button" class="btn ps-main-btn" onclick="psWardrobeNext()">下一步：挑选背景</button>
      <div class="ps-muted" style="margin-top:8px">类别含：${cats.map((c) => escapeHtml(c.label)).join('、')}</div>
    </div>`;
}

window.psDressSubject = async function(id) {
  _dressSubject = String(id);
  _pickedItems = [...(lookOf(_dressSubject).items || [])];
  _vibe = '';
  await loadWardrobeForSubject();
  render();
};

window.psPickWardrobeItemEncoded = function(encoded) {
  try {
    const item = JSON.parse(decodeURIComponent(encoded));
    _pickedItems = _pickedItems.filter((x) => !(x.category === item.category && x.id === item.id));
    _pickedItems.push(item);
    render();
  } catch (_) {}
};

window.psRemovePicked = function(i) {
  _pickedItems.splice(i, 1);
  render();
};

window.psUploadCloth = async function() {
  const cats = _meta?.categories || [];
  const catOpts = cats.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('');
  const wrap = document.createElement('div');
  wrap.className = 'ps-sheet-mask';
  wrap.innerHTML = `
    <div class="ps-sheet" onclick="event.stopPropagation()">
      <div class="ps-title">上传服饰</div>
      <label class="ps-field">类别<select class="input" id="ps-cloth-cat">${catOpts}</select></label>
      <label class="ps-field">名称<input class="input" id="ps-cloth-name" placeholder="例如 白色西装套装"></label>
      <label class="ps-check"><input type="checkbox" id="ps-cloth-save" ${_dressSubject !== 'user' ? 'checked' : ''} ${_dressSubject === 'user' ? 'disabled' : ''}> 存入角色衣柜</label>
      <div class="ps-row-btns">
        <button type="button" class="btn" id="ps-cloth-cancel">取消</button>
        <button type="button" class="btn btn-primary" id="ps-cloth-go">选图上传</button>
      </div>
    </div>`;
  wrap.onclick = () => wrap.remove();
  document.body.appendChild(wrap);
  wrap.querySelector('#ps-cloth-cancel').onclick = () => wrap.remove();
  wrap.querySelector('#ps-cloth-go').onclick = async () => {
    const category = wrap.querySelector('#ps-cloth-cat').value;
    const name = wrap.querySelector('#ps-cloth-name').value.trim() || catLabel(category);
    const save = !!wrap.querySelector('#ps-cloth-save')?.checked;
    wrap.remove();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const result = await pickCropAndUpload(file, { title: '裁剪服饰图', aspect: null });
        if (!result?.url) return;
        let item = { category, name, imageUrl: result.url };
        if (save && _dressSubject !== 'user') {
          const saved = await api.addWardrobeItem(_dressSubject, {
            category, name, description: name, image_url: result.url, source: 'studio',
          });
          item = {
            id: saved?.id || saved?.item?.id,
            category,
            name,
            imageUrl: result.url,
          };
          await loadWardrobeForSubject();
        }
        _pickedItems.push(item);
        render();
        toast('已加入本场穿着');
      } catch (e) {
        toast(e.message || '上传失败');
      }
    };
    input.click();
  };
};

window.psTryOn = async function() {
  if (!_pickedItems.length) {
    toast('请先选服饰');
    return;
  }
  try {
    toast('试穿图后台生成中…');
    const r = await api.queuePhotostudioTryon(_session.id, {
      subject: _dressSubject,
      items: _pickedItems,
    });
    const job = r.job;
    _pendingJobIds.add(job.id);
    setStep('jobs');
  } catch (e) {
    toast(e.message || '提交失败');
  }
};

window.psConfirmLook = async function() {
  const look = lookOf(_dressSubject);
  const url = look.previewUrl || look.confirmedUrl;
  if (!url && !_pickedItems.length && _dressSubject !== 'user') {
    toast('请先试穿或至少选择服饰后再确认');
    return;
  }
  try {
    const resultUrl = url || (_dressSubject === 'user' ? _session.user.faceUrl : '');
    const r = await api.confirmPhotostudioLook(_session.id, {
      subject: _dressSubject,
      resultUrl,
      items: _pickedItems,
    });
    _session = r.session || _session;
    _vibe = r.vibe || '';
    toast('已确认定妆');
    render();
  } catch (e) {
    toast(e.message || '确认失败');
  }
};

window.psWardrobeNext = async function() {
  for (const cid of _session.characterIds) {
    const look = lookOf(cid);
    if (!look.confirmedUrl && !look.previewUrl) {
      toast(`请先确认 ${charName(cid)} 的定妆`);
      return;
    }
  }
  const userLook = lookOf('user');
  if (!userLook.confirmedUrl && !userLook.previewUrl) {
    try {
      await api.confirmPhotostudioLook(_session.id, {
        subject: 'user',
        resultUrl: _session.user.faceUrl,
        items: userLook.items || [],
      });
      await refreshSession();
    } catch (e) {
      toast(e.message || '请先确认你的定妆');
      return;
    }
  }
  setStep('backgrounds');
};

function renderBackgrounds() {
  const list = _session?.backgrounds || [];
  return `
    <div class="ps-card">
      <div class="ps-title">挑选背景图</div>
      <div class="ps-sub">可上传多张，像婚纱外拍一样同一套妆造换景。背景可自由裁切取景；成片比例在下一步单独选，不必跟背景图一致。</div>
      <div class="ps-bg-list">
        ${list.map((bg) => `
          <div class="ps-bg-card">
            <img src="${escapeHtml(media(bg.url))}" alt="">
            <input class="input" value="${escapeHtml(bg.description || '')}"
              placeholder="例如：海边黄昏，不要路人"
              onchange="psBgDesc('${String(bg.id).replace(/'/g, '')}', this.value)">
            <button type="button" class="btn" onclick="psRemoveBg('${String(bg.id).replace(/'/g, '')}')">移除</button>
          </div>`).join('') || '<div class="ps-muted">还没有背景</div>'}
      </div>
      <button type="button" class="btn" onclick="psAddBg()">上传并裁切背景</button>
      <button type="button" class="btn btn-primary ps-main-btn" onclick="psBgNext()">下一步：和哆啦沟通拍摄</button>
    </div>`;
}

window.psAddBg = async function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const result = await pickCropAndUpload(file, { title: '裁切背景取景（成片比例下一步再选）', aspect: null });
      if (!result?.url) return;
      const backgrounds = [...(_session.backgrounds || []), {
        id: `bg_${Date.now()}`,
        url: result.url,
        description: '',
      }];
      await saveSession({ backgrounds });
      render();
    } catch (e) {
      toast(e.message || '上传失败');
    }
  };
  input.click();
};

window.psBgDesc = async function(id, value) {
  const backgrounds = (_session.backgrounds || []).map((b) =>
    String(b.id) === String(id) ? { ...b, description: value } : b
  );
  await saveSession({ backgrounds });
};

window.psRemoveBg = async function(id) {
  const backgrounds = (_session.backgrounds || []).filter((b) => String(b.id) !== String(id));
  const shoots = (_session.shoots || []).filter((s) => String(s.bgId) !== String(id));
  await saveSession({ backgrounds, shoots });
  render();
};

window.psBgNext = function() {
  if (!(_session.backgrounds || []).length) {
    toast('请至少上传一张背景');
    return;
  }
  const shoots = [...(_session.shoots || [])];
  for (const bg of _session.backgrounds) {
    if (!shoots.some((s) => String(s.bgId) === String(bg.id))) {
      shoots.push({
        bgId: bg.id,
        poseUrl: '',
        poseNote: '',
        lightMode: 'background',
        lightCustom: '',
        camera: 'fuji',
        aspect: '3:4',
        extra: '',
      });
    }
  }
  saveSession({ shoots }).then(() => setStep('shoot')).catch((e) => toast(e.message || '保存失败'));
};

function shootOf(bgId) {
  return (_session?.shoots || []).find((s) => String(s.bgId) === String(bgId)) || {
    bgId, poseUrl: '', poseNote: '', lightMode: 'background', lightCustom: '', camera: 'fuji', aspect: '3:4', extra: '',
  };
}

function renderShoot() {
  const cameras = _meta?.cameras || [];
  const lights = _meta?.lightModes || [];
  const aspects = _meta?.aspects || [
    { id: '3:4', label: '3:4 竖幅' },
    { id: '7:5', label: '7:5 横幅' },
  ];
  const target = _session?.albumTarget || 'nian';
  const imageStyle = _session?.imageStyle || 'real';
  return `
    <div class="ps-card">
      <div class="ps-title">哆啦摄像师</div>
      <div class="ps-sub">每张背景可单独定成片比例、姿势、光源和设备。背景是竖图也能出横幅成片。</div>
      <div class="ps-vibe">「今天想用哪台机器拍？姿势参考也可以给我哦。」</div>
      <div class="ps-section-label">成片画风</div>
      <div class="ps-subject-tabs">
        <button type="button" class="ps-chip ${imageStyle === 'real' ? 'on' : ''}" onclick="psImageStyle('real')">现实风</button>
        <button type="button" class="ps-chip ${imageStyle === 'anime' ? 'on' : ''}" onclick="psImageStyle('anime')">二次元风</button>
      </div>
      <div class="ps-muted" style="margin-top:8px">现实风会把 3D/二次元角色也拉成真人合影质感，并尽量避免「两个人贴在不同图层」的感觉。</div>
      ${(_session.backgrounds || []).map((bg) => {
        const s = shootOf(bg.id);
        const bid = String(bg.id).replace(/'/g, '');
        return `
          <div class="ps-shoot-block">
            <div class="ps-shoot-head">
              <img src="${escapeHtml(media(bg.url))}" alt="">
              <div>${escapeHtml(bg.description || '未命名背景')}</div>
            </div>
            <label class="ps-field">成片比例
              <select class="input" onchange="psShootField('${bid}','aspect',this.value)">
                ${aspects.map((a) => `<option value="${a.id}" ${s.aspect === a.id ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('')}
              </select>
            </label>
            <label class="ps-field">想拍的动作/姿势
              <input class="input" value="${escapeHtml(s.poseNote || '')}"
                onchange="psShootField('${bid}','poseNote',this.value)" placeholder="牵手回眸 / 坐在台阶上…">
            </label>
            <button type="button" class="btn" onclick="psShootPoseRef('${bid}')">
              ${s.poseUrl ? '已选姿势参考图 · 点击更换' : '上传姿势参考图（可选）'}
            </button>
            <label class="ps-field">光源
              <select class="input" onchange="psShootField('${bid}','lightMode',this.value)">
                ${lights.map((l) => `<option value="${l.id}" ${s.lightMode === l.id ? 'selected' : ''}>${escapeHtml(l.label)}</option>`).join('')}
              </select>
            </label>
            <label class="ps-field">光源微调（可与上面叠加）
              <input class="input" value="${escapeHtml(s.lightCustom || '')}"
                onchange="psShootField('${bid}','lightCustom',this.value)" placeholder="再暖一点 / 侧逆光…">
            </label>
            <label class="ps-field">拍摄设备
              <select class="input" onchange="psShootField('${bid}','camera',this.value)">
                ${cameras.map((c) => `<option value="${c.id}" ${s.camera === c.id ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
              </select>
            </label>
            <label class="ps-field">其他要求（生图提示词）
              <textarea class="input" rows="2" onchange="psShootField('${bid}','extra',this.value)"
                placeholder="氛围、构图、不要路人…">${escapeHtml(s.extra || '')}</textarea>
            </label>
          </div>`;
      }).join('')}
      <div class="ps-section-label">成片存到哪里？</div>
      <div class="ps-subject-tabs">
        <button type="button" class="ps-chip ${target === 'nian' ? 'on' : ''}" onclick="psAlbumTarget('nian')">念的相册</button>
        <button type="button" class="ps-chip ${target === 'ta' ? 'on' : ''}" onclick="psAlbumTarget('ta')">TA 写真集</button>
        <button type="button" class="ps-chip ${target === 'both' ? 'on' : ''}" onclick="psAlbumTarget('both')">两边都要</button>
      </div>
      <button type="button" class="btn btn-primary ps-main-btn" onclick="psStartShoot()">开始后台拍摄</button>
    </div>`;
}

window.psShootField = async function(bgId, field, value) {
  const shoots = [...(_session.shoots || [])];
  const idx = shoots.findIndex((s) => String(s.bgId) === String(bgId));
  const base = idx >= 0 ? shoots[idx] : shootOf(bgId);
  const next = { ...base, [field]: value };
  if (idx >= 0) shoots[idx] = next;
  else shoots.push(next);
  await saveSession({ shoots });
};

window.psShootPoseRef = async function(bgId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const result = await pickCropAndUpload(file, { title: '姿势参考', aspect: null });
      if (!result?.url) return;
      await window.psShootField(bgId, 'poseUrl', result.url);
      render();
    } catch (e) {
      toast(e.message || '上传失败');
    }
  };
  input.click();
};

window.psAlbumTarget = async function(target) {
  await saveSession({ albumTarget: target });
  render();
};

window.psImageStyle = async function(style) {
  await saveSession({ imageStyle: style === 'anime' ? 'anime' : 'real' });
  render();
};

window.psStartShoot = async function() {
  try {
    toast('已提交后台拍摄，可先去做别的事');
    const r = await api.queuePhotostudioShoot(_session.id, {
      albumTarget: _session.albumTarget || 'nian',
    });
    _session = r.session || _session;
    for (const j of r.jobs || []) _pendingJobIds.add(j.id);
    setStep('jobs');
  } catch (e) {
    toast(e.message || '提交失败');
  }
};

function renderJobs() {
  return `
    <div class="ps-card">
      <div class="ps-title">后台出片</div>
      <div class="ps-sub">生图较慢，任务在服务器排队执行。完成会提示你；也可在此刷新。</div>
      <div id="ps-jobs-list" class="ps-jobs-list"><div class="ps-muted">加载中…</div></div>
      <div class="ps-row-btns">
        <button type="button" class="btn" onclick="psRefreshJobs()">刷新</button>
        <button type="button" class="btn" onclick="psNewSession()">再开一场</button>
      </div>
    </div>`;
}

window.psRefreshJobs = async function() {
  await pollJobs();
};

async function pollJobs() {
  if (!_session?.id) return;
  try {
    await refreshSession();
    const r = await api.listPhotostudioJobs(_session.id);
    const jobs = r.jobs || [];
    const list = document.getElementById('ps-jobs-list');
    if (list) {
      list.innerHTML = jobs.length ? jobs.map((j) => `
        <div class="ps-job ${j.status}">
          <div class="ps-job-meta">
            <strong>${j.kind === 'tryon' ? '试穿' : '合影'}</strong>
            <span>${statusLabel(j.status)}</span>
          </div>
          ${j.error ? `<div class="ps-err">${escapeHtml(j.error)}</div>` : ''}
          ${j.payload?.vibe ? `<div class="ps-vibe">${escapeHtml(j.payload.vibe)}</div>` : ''}
          ${j.resultUrl ? `<img class="ps-job-img" src="${escapeHtml(media(j.resultUrl))}" alt="">` : ''}
          ${j.kind === 'tryon' && j.status === 'done' && j.resultUrl ? `
            <button type="button" class="btn btn-primary"
              onclick="psConfirmFromJob('${escapeHtml(String(j.payload?.subject || 'user'))}', '${escapeHtml(j.resultUrl)}')">用这张确认定妆</button>
          ` : ''}
        </div>`).join('') : '<div class="ps-muted">还没有任务</div>';
    }

    let still = false;
    for (const j of jobs) {
      if (j.status === 'queued' || j.status === 'running') still = true;
      if (_pendingJobIds.has(j.id) && (j.status === 'done' || j.status === 'error')) {
        _pendingJobIds.delete(j.id);
        if (j.status === 'done') {
          toast(j.kind === 'tryon' ? '试穿图好了' : '合影好了');
          if (j.payload?.vibe) _vibe = j.payload.vibe;
        } else toast(j.error || '生成失败');
      }
    }
    if (!still && !_pendingJobIds.size) stopPoll();
  } catch (_) { /* ignore */ }
}

window.psConfirmFromJob = async function(subject, resultUrl) {
  try {
    const r = await api.confirmPhotostudioLook(_session.id, {
      subject,
      resultUrl,
      items: _pickedItems,
    });
    _session = r.session || _session;
    _vibe = r.vibe || '';
    toast('已确认定妆');
    setStep('wardrobe');
  } catch (e) {
    toast(e.message || '确认失败');
  }
};

function statusLabel(s) {
  return ({ queued: '排队中', running: '生成中', done: '完成', error: '失败' })[s] || s;
}

window.psNewSession = function() {
  _session = null;
  _selected = new Set();
  _pickedItems = [];
  _vibe = '';
  _pendingJobIds.clear();
  stopPoll();
  setStep('cast');
};

window.onPhotostudioJob = function(data) {
  if (!data) return;
  if (_session?.id && Number(data.sessionId) === Number(_session.id) && _step === 'jobs') {
    pollJobs().catch(() => {});
  }
  if (data.status === 'done') {
    window.showToast?.(data.kind === 'tryon' ? '写真馆试穿图好了' : '写真馆合影好了');
  } else if (data.status === 'error') {
    window.showToast?.(data.error || '写真馆生成失败');
  }
};

/* ===== TA 的衣柜 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';

const CATEGORY_ORDER = ['tops', 'bottoms', 'outer', 'shoes', 'bags', 'accessories', 'hairstyle', 'suit', 'gown', 'pajamas'];
const CATEGORY_LABELS = {
  tops: '上装', bottoms: '下装', outer: '外套', shoes: '鞋履',
  bags: '包袋', accessories: '配饰', hairstyle: '发型', suit: '套装', gown: '礼服', pajamas: '睡衣',
};

function getCurrentSeasonLabel() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return '春';
  if (m >= 6 && m <= 8) return '夏';
  if (m >= 9 && m <= 11) return '秋';
  return '冬';
}

let _charId = 0;
let _char = null;
let _items = [];
let _outfitData = null;
let _activeCategory = 'tops';
let _activeSlot = 'home';
let _purchaseOpen = false;
let _addOpen = false;
let _editItem = null;
let _recommendations = null;
let _recLoading = false;

function charId() {
  return Number(window._wardrobeCharId || window.getActiveCharId?.() || 0);
}

function displayName() {
  return String(_char?.display_name || _char?.name || 'TA').trim();
}

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(Boolean).map(String) : [];
  } catch {
    return String(raw).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }
}

window.openWardrobe = function(id) {
  window._wardrobeCharId = Number(id || window.getActiveCharId?.() || 0);
  window.navigateTo('wardrobe');
};

window.closeWardrobe = function() {
  window.goBack?.();
};

window.initWardrobePage = async function() {
  const page = document.getElementById('wardrobe-page');
  if (!page) return;
  _charId = charId();
  if (!_charId) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">请先选择角色</div></div>`;
    return;
  }
  page.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    [_char, { items: _items }, _outfitData] = await Promise.all([
      api.getCharacter(_charId),
      api.getWardrobe(_charId),
      api.getTodayOutfits(_charId),
    ]);
    _items = _items || [];
    _activeSlot = _outfitData?.current_slot || 'home';
    renderWardrobePage();
  } catch (e) {
    page.innerHTML = `<div class="empty-state"><div class="empty-text">${escapeHtml(e.message || '加载失败')}</div></div>`;
  }
};

function renderWardrobePage() {
  const page = document.getElementById('wardrobe-page');
  if (!page) return;
  const slotOutfit = _outfitData?.outfits?.[_activeSlot];
  const summary = slotOutfit?.summary_zh || _outfitData?.current_summary || '尚未搭配';
  const slots = _outfitData?.slots || [];
  const filtered = _items.filter((it) => it.category === _activeCategory);

  page.innerHTML = `
    <div class="wardrobe-shell">
      <div class="topbar wardrobe-topbar">
        <button type="button" class="topbar-back topbar-nav-back" onclick="closeWardrobe()" title="返回"></button>
        <div class="topbar-title">${escapeHtml(displayName())} 的衣柜</div>
        <button type="button" class="wardrobe-avatar-btn" onclick="openAppearanceFromWardrobe()" title="外貌档案">
          ${_char?.avatar
            ? `<img src="${escapeHtml(_char.avatar)}" alt="" class="wardrobe-avatar-img">`
            : `<span>${escapeHtml(displayName().slice(0, 1))}</span>`}
        </button>
      </div>

      <div class="scroll-area scroll-area-native wardrobe-body">
        <div class="wardrobe-today-strip">
          <div class="wardrobe-today-label">今日穿搭</div>
          <div class="wardrobe-slot-row">
            ${slots.map((s) => `
              <button type="button" class="wardrobe-slot ${s.id === _activeSlot ? 'active' : ''}"
                onclick="selectWardrobeSlot('${s.id}')">${escapeHtml(s.label)}</button>
            `).join('')}
          </div>
          <div class="wardrobe-today-detail">${escapeHtml(summary)}</div>
          <div class="wardrobe-today-actions">
            <button type="button" class="btn btn-ghost btn-sm" onclick="regenerateTodayOutfits()">重新生成</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="loadOutfitRecommendations()">穿搭推荐</button>
          </div>
        </div>

        ${_recommendations ? `
        <div class="wardrobe-rec-panel">
          <div class="wardrobe-rec-header">
            <span class="wardrobe-rec-title">穿搭推荐 <span class="wardrobe-rec-season">${escapeHtml(_recommendations.season)}季</span></span>
            <button type="button" class="btn btn-ghost btn-sm" onclick="_recommendations=null;renderWardrobePage()">收起</button>
          </div>
          <div class="wardrobe-rec-list">
            ${(_recommendations.recommendations || []).map((rec) => `
              <div class="wardrobe-rec-card">
                <div class="wardrobe-rec-slot">${escapeHtml(rec.slotLabel)}</div>
                <div class="wardrobe-rec-summary">${escapeHtml(rec.summary || '暂无推荐')}</div>
                <div class="wardrobe-rec-actions">
                  <button type="button" class="btn btn-primary btn-xs" onclick="applyOutfitRecommendation('${rec.slot}', ${JSON.stringify(rec.outfit).replace(/"/g, '&quot;')})">应用这套</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}

        <div class="wardrobe-toolbar">
          <div class="wardrobe-cat-tabs">
            ${CATEGORY_ORDER.map((c) => `
              <button type="button" class="wardrobe-cat ${c === _activeCategory ? 'active' : ''}"
                onclick="selectWardrobeCategory('${c}')">${CATEGORY_LABELS[c]}</button>
            `).join('')}
          </div>
        </div>

        <div class="wardrobe-list">
          ${filtered.length
            ? filtered.map((it) => {
                const isGift = it.source === 'gift';
                const tags = parseTags(it.tags).filter((t) => {
                  if (it.category === 'bags' || it.category === 'accessories') {
                    return !/^(春|夏|秋|冬)$/.test(t);
                  }
                  return !/^(♥|❤|❤︎|礼物|邮局|邮局礼物)$/.test(t);
                });
                return `
              <div class="wardrobe-swipe" data-id="${it.id}">
                <div class="wardrobe-swipe-track">
                  <div class="wardrobe-swipe-front">
                    <div class="wardrobe-item">
                      <div class="wardrobe-item-accent"></div>
                      ${(it.image_url || isGift) ? `
                        <div class="wardrobe-item-thumb-wrap">
                          ${it.image_url
                            ? `<img class="wardrobe-item-thumb" src="${escapeHtml(it.image_url)}" alt="">`
                            : `<div class="wardrobe-item-thumb wardrobe-item-thumb--empty"></div>`}
                          ${isGift ? '<span class="wardrobe-heart-badge" title="寄来的礼物">♥</span>' : ''}
                        </div>` : ''}
                      <div class="wardrobe-item-main">
                        <div class="wardrobe-item-top">
                          <div class="wardrobe-item-name">${escapeHtml(it.name)}</div>
                        </div>
                        ${it.description ? `<div class="wardrobe-item-desc">${escapeHtml(it.description)}</div>` : ''}
                        <div class="wardrobe-item-tags">
                          <span class="wardrobe-chip">${escapeHtml(CATEGORY_LABELS[it.category] || it.category)}</span>
                          ${it.brand_style ? `<span class="wardrobe-chip">${escapeHtml(it.brand_style)}</span>` : ''}
                          ${isGift ? '<span class="wardrobe-chip is-heart">♥ 礼物</span>' : ''}
                          ${tags.map((t) => `<span class="wardrobe-chip">${escapeHtml(t)}</span>`).join('')}
                        </div>
                      </div>
                    </div>
                  </div>
                  <button type="button" class="wardrobe-swipe-edit" onclick="event.stopPropagation();openWardrobeEdit(${it.id})">编辑</button>
                  <button type="button" class="wardrobe-swipe-del" onclick="event.stopPropagation();deleteWardrobeItemUi(${it.id})">删除</button>
                </div>
              </div>`;
              }).join('')
            : `<div class="wardrobe-empty">${_items.length ? '该品类暂无单品' : '衣柜还是空的，用底栏购置或手动添加'}</div>`}
        </div>
      </div>

      <div class="wardrobe-fab-bar">
        <button type="button" class="btn btn-ghost" onclick="toggleWardrobeAdd(true)">手动添加</button>
        <button type="button" class="btn btn-primary" onclick="toggleWardrobePurchase(true)">购置服饰</button>
      </div>

      ${_purchaseOpen ? renderPurchaseSheet() : ''}
      ${_addOpen ? renderAddSheet() : ''}
      ${_editItem ? renderEditSheet(_editItem) : ''}
    </div>
  `;
  bindWardrobeSwipe();
}

function renderPurchaseSheet() {
  const season = getCurrentSeasonLabel();
  return `
    <div class="wardrobe-sheet-mask" onclick="toggleWardrobePurchase(false)"></div>
    <div class="wardrobe-sheet">
      <div class="wardrobe-sheet-title">购置服饰</div>
      <div class="wardrobe-sheet-hint">当前${season}季，将购置适合${season}季日常穿着的服饰；有钱则对标真实名奢，不自创奇怪风格</div>
      <div class="wardrobe-purchase-cats">
        ${CATEGORY_ORDER.map((c) => `
          <label class="wardrobe-purchase-cat">
            <input type="checkbox" class="wardrobe-purchase-check" value="${c}" checked>
            <span>${CATEGORY_LABELS[c]}</span>
          </label>
        `).join('')}
      </div>
      <div class="wardrobe-sheet-actions">
        <button type="button" class="btn btn-ghost" onclick="toggleWardrobePurchase(false)">取消</button>
        <button type="button" class="btn btn-primary" onclick="confirmWardrobePurchase()">确认购置</button>
      </div>
    </div>
  `;
}

function renderAddSheet() {
  return `
    <div class="wardrobe-sheet-mask" onclick="toggleWardrobeAdd(false)"></div>
    <div class="wardrobe-sheet">
      <div class="wardrobe-sheet-title">手动添加</div>
      <div class="wardrobe-sheet-hint">自己登记一件真实单品</div>
      <label class="wardrobe-add-field">
        <span>品类</span>
        <select id="wardrobe-add-cat" class="input">
          ${CATEGORY_ORDER.map((c) => `<option value="${c}">${CATEGORY_LABELS[c]}</option>`).join('')}
        </select>
      </label>
      <label class="wardrobe-add-field">
        <span>名称</span>
        <input id="wardrobe-add-name" class="input" placeholder="例如：驼色羊绒大衣">
      </label>
      <label class="wardrobe-add-field">
        <span>品牌风</span>
        <input id="wardrobe-add-brand" class="input" placeholder="例如：Max Mara 风，可空">
      </label>
      <label class="wardrobe-add-field">
        <span>我对这件的看法</span>
        <input id="wardrobe-add-desc" class="input" placeholder="用「我」写对这件衣服的看法，别写对用户的想法；可空">
      </label>
      <div class="wardrobe-sheet-actions">
        <button type="button" class="btn btn-ghost" onclick="toggleWardrobeAdd(false)">取消</button>
        <button type="button" class="btn btn-primary" onclick="confirmWardrobeAdd()">添加</button>
      </div>
    </div>
  `;
}

const KEEP_TAGS = /^(♥|❤|❤︎|礼物|邮局|邮局礼物)$/;

function editableTagText(it) {
  return parseTags(it?.tags).filter((t) => !KEEP_TAGS.test(t)).join('，');
}

function mergeEditedTags(text, originalTags) {
  const kept = parseTags(originalTags).filter((t) => KEEP_TAGS.test(t));
  const next = String(text || '').split(/[,，、]/).map((s) => s.trim()).filter((t) => t && !KEEP_TAGS.test(t));
  return [...kept, ...next];
}

function renderEditSheet(it) {
  return `
    <div class="wardrobe-sheet-mask" onclick="closeWardrobeEdit()"></div>
    <div class="wardrobe-sheet">
      <div class="wardrobe-sheet-title">编辑单品</div>
      <label class="wardrobe-add-field">
        <span>品类</span>
        <select id="wardrobe-edit-cat" class="input">
          ${CATEGORY_ORDER.map((c) => `<option value="${c}" ${c === it.category ? 'selected' : ''}>${CATEGORY_LABELS[c]}</option>`).join('')}
        </select>
      </label>
      <label class="wardrobe-add-field">
        <span>名称</span>
        <input id="wardrobe-edit-name" class="input" value="${escapeHtml(it.name || '')}">
      </label>
      <label class="wardrobe-add-field">
        <span>品牌风</span>
        <input id="wardrobe-edit-brand" class="input" value="${escapeHtml(it.brand_style || '')}" placeholder="可空">
      </label>
      <label class="wardrobe-add-field">
        <span>我对这件的看法</span>
        <input id="wardrobe-edit-desc" class="input" value="${escapeHtml(it.description || '')}" placeholder="用「我」写，可空">
      </label>
      <label class="wardrobe-add-field">
        <span>标签</span>
        <input id="wardrobe-edit-tags" class="input" value="${escapeHtml(editableTagText(it))}" placeholder="春、夏、通勤，用逗号分隔">
      </label>
      <div class="wardrobe-sheet-actions">
        <button type="button" class="btn btn-ghost" onclick="closeWardrobeEdit()">取消</button>
        <button type="button" class="btn btn-primary" onclick="confirmWardrobeEdit()">保存</button>
      </div>
    </div>
  `;
}

const SWIPE_OPEN_PX = 152;

function setSwipeTrackX(track, x, animate) {
  if (!track) return;
  track.style.transition = animate ? '' : 'none';
  track.style.transform = x ? `translateX(${x}px)` : '';
}

function closeAllSwipe(exceptRow) {
  document.querySelectorAll('.wardrobe-swipe.is-open').forEach((row) => {
    if (row === exceptRow) return;
    row.classList.remove('is-open');
    setSwipeTrackX(row.querySelector('.wardrobe-swipe-track'), 0, true);
  });
}

function openSwipeRow(row) {
  closeAllSwipe(row);
  row.classList.add('is-open');
  setSwipeTrackX(row.querySelector('.wardrobe-swipe-track'), -SWIPE_OPEN_PX, true);
}

function closeSwipeRow(row) {
  row.classList.remove('is-open');
  setSwipeTrackX(row.querySelector('.wardrobe-swipe-track'), 0, true);
}

function bindWardrobeSwipe() {
  document.querySelectorAll('.wardrobe-swipe').forEach((row) => {
    const track = row.querySelector('.wardrobe-swipe-track');
    if (!track) return;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let tracking = false;
    let axis = null;
    let swiped = false;

    const isOpen = () => row.classList.contains('is-open');
    const onStart = (x, y) => {
      startX = x;
      startY = y;
      dx = isOpen() ? -SWIPE_OPEN_PX : 0;
      tracking = true;
      axis = null;
      swiped = false;
      track.style.transition = 'none';
    };
    const onMove = (x, y, ev) => {
      if (!tracking) return;
      const adx = x - startX;
      const ady = y - startY;
      if (!axis) {
        if (Math.abs(adx) < 8 && Math.abs(ady) < 8) return;
        axis = Math.abs(adx) > Math.abs(ady) ? 'x' : 'y';
        if (axis === 'y') {
          tracking = false;
          setSwipeTrackX(track, isOpen() ? -SWIPE_OPEN_PX : 0, true);
          return;
        }
      }
      if (axis !== 'x') return;
      ev.preventDefault();
      swiped = true;
      const base = isOpen() ? -SWIPE_OPEN_PX : 0;
      dx = Math.min(0, Math.max(-SWIPE_OPEN_PX - 16, base + adx));
      setSwipeTrackX(track, dx, false);
    };
    const onEnd = () => {
      if (!tracking) {
        axis = null;
        return;
      }
      tracking = false;
      if (axis === 'x' && dx < -SWIPE_OPEN_PX * 0.4) openSwipeRow(row);
      else closeSwipeRow(row);
      axis = null;
    };

    row.addEventListener('touchstart', (e) => {
      if (e.target.closest('.wardrobe-swipe-del') || e.target.closest('.wardrobe-swipe-edit')) return;
      const t = e.changedTouches[0];
      if (t) onStart(t.clientX, t.clientY);
    }, { passive: true });
    row.addEventListener('touchmove', (e) => {
      const t = e.changedTouches[0];
      if (t) onMove(t.clientX, t.clientY, e);
    }, { passive: false });
    row.addEventListener('touchend', onEnd);
    row.addEventListener('touchcancel', onEnd);

    row.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('.wardrobe-swipe-del') || e.target.closest('.wardrobe-swipe-edit')) return;
      onStart(e.clientX, e.clientY);
      try { row.setPointerCapture(e.pointerId); } catch {}
    });
    row.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (!(e.buttons & 1) && e.pointerType === 'mouse') return;
      onMove(e.clientX, e.clientY, e);
    });
    row.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      onEnd();
    });
    row.addEventListener('pointercancel', (e) => {
      if (e.pointerType === 'touch') return;
      onEnd();
    });
    row.addEventListener('click', (e) => {
      if (swiped) {
        e.preventDefault();
        e.stopPropagation();
        swiped = false;
        return;
      }
      if (isOpen() && !e.target.closest('.wardrobe-swipe-del') && !e.target.closest('.wardrobe-swipe-edit')) {
        e.preventDefault();
        closeSwipeRow(row);
      }
    }, true);
  });
}

window.selectWardrobeCategory = function(cat) {
  _activeCategory = cat;
  renderWardrobePage();
};

window.selectWardrobeSlot = function(slot) {
  _activeSlot = slot;
  renderWardrobePage();
};

window.toggleWardrobePurchase = function(open) {
  _purchaseOpen = !!open;
  if (_purchaseOpen) _addOpen = false;
  renderWardrobePage();
};

window.toggleWardrobeAdd = function(open) {
  _addOpen = !!open;
  if (_addOpen) _purchaseOpen = false;
  renderWardrobePage();
};

window.openAppearanceFromWardrobe = function() {
  window._appearanceCharId = _charId;
  window._appearanceBack = 'wardrobe';
  window.navigateTo('appearance');
};

window.confirmWardrobePurchase = async function() {
  const cats = [...document.querySelectorAll('.wardrobe-purchase-check:checked')].map((el) => el.value);
  if (!cats.length) {
    window.showToast?.('请至少勾选一个品类');
    return;
  }
  try {
    window.showToast?.('正在添置…');
    const res = await api.purchaseWardrobe(_charId, cats);
    _items = [..._items, ...(res.items || [])];
    _purchaseOpen = false;
    if (!_outfitData?.outfits || !Object.keys(_outfitData.outfits).length) {
      await api.generateTodayOutfits(_charId);
      _outfitData = await api.getTodayOutfits(_charId);
    }
    window.showToast?.(`已添置 ${res.items?.length || 0} 件`);
    renderWardrobePage();
  } catch (e) {
    window.showToast?.(e.message || '购置失败');
  }
};

window.openWardrobeEdit = function(id) {
  const it = _items.find((x) => Number(x.id) === Number(id));
  if (!it) return;
  closeAllSwipe();
  _editItem = it;
  _addOpen = false;
  _purchaseOpen = false;
  renderWardrobePage();
};

window.closeWardrobeEdit = function() {
  _editItem = null;
  renderWardrobePage();
};

window.confirmWardrobeEdit = async function() {
  if (!_editItem) return;
  const category = document.getElementById('wardrobe-edit-cat')?.value;
  const name = document.getElementById('wardrobe-edit-name')?.value?.trim();
  const brand_style = document.getElementById('wardrobe-edit-brand')?.value?.trim() || '';
  const description = document.getElementById('wardrobe-edit-desc')?.value?.trim() || '';
  const tags = mergeEditedTags(document.getElementById('wardrobe-edit-tags')?.value, _editItem.tags);
  if (!name) {
    window.showToast?.('请填写名称');
    return;
  }
  try {
    await api.updateWardrobeItem(_charId, _editItem.id, { category, name, brand_style, description, tags });
    _items = _items.map((it) => (it.id === _editItem.id
      ? { ...it, category, name, brand_style, description, tags }
      : it));
    _activeCategory = category;
    _editItem = null;
    window.showToast?.('已保存');
    renderWardrobePage();
  } catch (e) {
    window.showToast?.(e.message || '保存失败');
  }
};

window.confirmWardrobeAdd = async function() {
  const category = document.getElementById('wardrobe-add-cat')?.value;
  const name = document.getElementById('wardrobe-add-name')?.value?.trim();
  const brand_style = document.getElementById('wardrobe-add-brand')?.value?.trim() || '';
  const description = document.getElementById('wardrobe-add-desc')?.value?.trim() || '';
  if (!name) {
    window.showToast?.('请填写名称');
    return;
  }
  try {
    const res = await api.addWardrobeItem(_charId, { category, name, brand_style, description, tags: [] });
    if (res?.item) _items = [..._items, res.item];
    _addOpen = false;
    _activeCategory = category;
    window.showToast?.('已添加');
    renderWardrobePage();
  } catch (e) {
    window.showToast?.(e.message || '添加失败');
  }
};

window.regenerateTodayOutfits = async function() {
  try {
    await api.generateTodayOutfits(_charId, { force: true });
    _outfitData = await api.getTodayOutfits(_charId);
    window.showToast?.('今日搭配已更新');
    renderWardrobePage();
  } catch (e) {
    window.showToast?.(e.message || '生成失败');
  }
};

window.loadOutfitRecommendations = async function() {
  if (_recLoading) return;
  _recLoading = true;
  try {
    _recommendations = await api.getOutfitRecommendations(_charId);
    renderWardrobePage();
  } catch (e) {
    window.showToast?.(e.message || '加载推荐失败');
  } finally {
    _recLoading = false;
  }
};

window.applyOutfitRecommendation = async function(slot, outfit) {
  try {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await api.saveTodayOutfit(_charId, slot, outfit, dateStr);
    _outfitData = await api.getTodayOutfits(_charId);
    _recommendations = null;
    window.showToast?.('已应用这套穿搭');
    renderWardrobePage();
  } catch (e) {
    window.showToast?.(e.message || '应用失败');
  }
};

window.deleteWardrobeItemUi = async function(itemId) {
  try {
    await api.deleteWardrobeItem(_charId, itemId);
    _items = _items.filter((it) => it.id !== itemId);
    renderWardrobePage();
  } catch (e) {
    window.showToast?.(e.message || '删除失败');
  }
};

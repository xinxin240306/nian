/* ===== 美化页 ===== */
import * as api from '../api.js';
import { escapeHtml } from '../memory.js';
import { GRADIENT_PRESETS, buildThemeGradient, resolveGradientPreset } from '../theme-gradients.js';
import { pickCropAndUpload } from '../media-crop.js';
import { playNotifySound, playCallRingtone, stopCallRingtone } from '../tts.js';
import { getPwaIcon, savePwaIcon } from '../storage.js';
import { applyPwaIcon, bumpPwaIconVersion } from '../pwa-icon.js';
import { canPinLauncherIcon, pinCustomLauncherIcon } from '../launcher-icon.js';
import {
  loadCustomFonts, getCustomFonts, getFontPreviewSample,
  uploadCustomFont, renameCustomFont, deleteCustomFont,
} from '../custom-fonts.js';
import { getPaperFonts, getAppFontId, applyAppFont } from '../diary-paper.js';
import { HOME_APPS } from '../home-desktop.js';

const DESKTOP_OVERLAYS = [
  { id: 'none', name: '无' },
  { id: 'mist', name: '雾气' },
  { id: 'glass', name: '玻璃' },
  { id: 'frosted', name: '浴室玻璃' },
  { id: 'particles', name: '粒子' },
];

const NAV_APPS = HOME_APPS.map((a) => ({
  key: a.key,
  icon: a.icon,
  defaultName: a.name,
}));

function appIconHtml(icon) {
  const s = String(icon || '');
  if (s.includes('<svg')) return s;
  return escapeHtml(s);
}

/* ─── 图标 localStorage 工具 ─── */
function getAppIcons() {
  try { return JSON.parse(localStorage.getItem('beautify_app_icons') || '{}'); } catch { return {}; }
}
function saveAppIcons(icons) { localStorage.setItem('beautify_app_icons', JSON.stringify(icons)); }

/* ─── localStorage 工具 ─── */
function getAppNames() {
  try { return JSON.parse(localStorage.getItem('beautify_app_names') || '{}'); } catch { return {}; }
}
function saveAppNames(names) { localStorage.setItem('beautify_app_names', JSON.stringify(names)); }

export function getHideLabels() {
  return localStorage.getItem('beautify_hide_labels') === '1';
}

function getNavTransparency() {
  const saved = localStorage.getItem('beautify_nav_transparency');
  if (saved != null) return saved;
  const legacy = parseInt(localStorage.getItem('beautify_nav_opacity') || '14', 10);
  return String(Math.max(0, Math.min(100, 100 - legacy)));
}

/** 获取应用的展示名（外部使用） */
window.getAppDisplayName = function(key) {
  return getAppNames()[key] || '';
};

/* ─── 初始化页面 ─── */
window.initBeautifyPage = async function(embedOpts) {
  const embedEl = embedOpts?.container || null;
  const page = embedEl || document.getElementById('beautify-page');
  if (!page) return;
  let settings = {};
  try { settings = await api.getSettings(); } catch {}

  const appNames  = getAppNames();
  const hideLabels = getHideLabels();
  const navTransparency = getNavTransparency();
  const navRadius = localStorage.getItem('beautify_nav_radius') || '28';
  const navGap = localStorage.getItem('beautify_nav_gap') || '10';
  const dockTransparency = localStorage.getItem('beautify_dock_transparency') || '20';
  const dockRadius = localStorage.getItem('beautify_dock_radius') || '36';
  const homeGrid = localStorage.getItem('beautify_home_grid') || '4';
  const pwaIcon = getPwaIcon();
  const themeBgType = settings.theme_bg_type || 'gradient';
  const themeGradientPreset = resolveGradientPreset(themeBgType, settings.theme_bg_value);
  const desktopBgType = settings.bg_type || 'particle';
  let desktopOverlay = settings.bg_overlay || 'none';
  if (!settings.bg_overlay && settings.bg_particles_enabled === '1') desktopOverlay = 'particles';
  const overlayAmount = settings.bg_overlay_amount || '50';
  const themeColor = settings.theme_color || '#c9a0dc';
  const colorScheme = settings.color_scheme || 'auto';

  const topbarHtml = embedEl ? '' : `
    <div class="topbar">
      <button type="button" class="topbar-back topbar-nav-back" onclick="goBack()" title="返回"></button>
      <div class="topbar-title" style="font-family:'Noto Serif SC',serif">🎨 美化</div>
      <button type="button" class="topbar-save" onclick="saveBeautifySettings()" title="保存"></button>
    </div>`;

  page.innerHTML = `${topbarHtml}
    <div ${embedEl ? 'style="padding:0 0 24px"' : 'class="scroll-area" style="padding:0 0 24px"'}>

      <!-- 主题色 -->
      <div class="settings-section">
        <div class="settings-section-title">主题色</div>
        <div class="settings-group">
          <div class="settings-row" style="padding:12px 16px 4px">
            <span class="settings-row-label" style="font-size:12px;color:var(--text-secondary);line-height:1.6">应用强调色：内页按钮、开关、选中标签、保存按钮等；主题背景为「渐变」时也参与配色（不是主页壁纸）</span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:8px">
            <div class="color-presets" id="b-color-presets">
              ${['#c9a0dc','#a0c9dc','#dcb0a0','#a0dcc0','#dca0b0','#b0a0dc','#dccc90'].map(c =>
                `<div class="color-preset ${themeColor===c?'active':''}" style="background:${c}" onclick="pickThemeColorB('${c}',this)"></div>`
              ).join('')}
              <div style="position:relative">
                <input type="color" id="b-custom-color" value="${themeColor}"
                  style="opacity:0;position:absolute;top:0;left:0;width:32px;height:32px;cursor:pointer"
                  onchange="pickThemeColorB(this.value)">
                <div class="color-preset ${!['#c9a0dc','#a0c9dc','#dcb0a0','#a0dcc0','#dca0b0','#b0a0dc','#dccc90'].includes(themeColor)?'active':''}"
                  style="background:conic-gradient(red,yellow,green,cyan,blue,magenta,red);border:2px dashed rgba(255,255,255,0.5)"
                  title="自定义" onclick="document.getElementById('b-custom-color').click()"></div>
              </div>
            </div>
          </div>
          <div class="settings-row" style="padding:12px 16px;gap:12px;align-items:center">
            <span class="settings-row-label">效果预览</span>
            <div id="b-theme-preview" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <div id="b-theme-swatch" style="width:36px;height:36px;border-radius:10px;background:${themeColor};border:1px solid var(--border);box-shadow:var(--shadow-sm)"></div>
              <button type="button" class="btn btn-primary btn-sm" style="pointer-events:none">按钮</button>
              <span style="font-size:12px;color:var(--theme-dark)" id="b-theme-hex">${themeColor}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 外观模式 -->
      <div class="settings-section">
        <div class="settings-section-title">外观模式</div>
        <div class="settings-group">
          <div class="settings-row" style="padding:12px 16px 4px">
            <span class="settings-row-label" style="font-size:12px;color:var(--text-secondary);line-height:1.6">浅色 / 深色影响内页文字与卡片对比度；「跟随系统」会随设备设置切换</span>
          </div>
          <div class="settings-row" style="padding:14px">
            <div class="tag-list" id="b-color-scheme">
              <div class="tag ${colorScheme === 'auto' ? 'active' : ''}" data-val="auto" onclick="setColorSchemeB('auto', this)">跟随系统</div>
              <div class="tag ${colorScheme === 'light' ? 'active' : ''}" data-val="light" onclick="setColorSchemeB('light', this)">浅色</div>
              <div class="tag ${colorScheme === 'dark' ? 'active' : ''}" data-val="dark" onclick="setColorSchemeB('dark', this)">深色</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 主题背景（应用内页面） -->
      <div class="settings-section">
        <div class="settings-section-title">主题背景</div>
        <div class="settings-group">
          <div class="settings-row" style="padding:12px 16px 4px">
            <span class="settings-row-label" style="font-size:12px;color:var(--text-secondary);line-height:1.6">从主页点进通讯、设置等应用后看到的背景，与主页壁纸无关</span>
          </div>
          <div class="settings-row">
            <span class="settings-row-label">背景类型</span>
            <div class="tag-list">
              <div class="tag ${themeBgType==='gradient'?'active':''}" onclick="setThemeBgTypeB('gradient',this)">渐变</div>
              <div class="tag ${themeBgType==='color'?'active':''}" onclick="setThemeBgTypeB('color',this)">纯色</div>
              <div class="tag ${themeBgType==='image'?'active':''}" onclick="setThemeBgTypeB('image',this)">图片</div>
            </div>
          </div>
          <div id="b-theme-gradient-row" class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:10px;display:${themeBgType==='gradient'?'flex':'none'}">
            <span class="settings-row-label">渐变风格</span>
            <div class="gradient-presets" id="b-gradient-presets">
              ${GRADIENT_PRESETS.map(p => `
                <div class="gradient-preset-wrap">
                  <div class="gradient-preset ${themeGradientPreset===p.id?'active':''}"
                    style="background:${buildThemeGradient(themeColor, p.id)}"
                    title="${p.name}" onclick="pickThemeGradientB('${p.id}',this)"></div>
                  <span class="gradient-preset-label">${p.name}</span>
                </div>`).join('')}
            </div>
          </div>
          <div id="b-theme-bg-color-row" class="settings-row" style="display:${themeBgType==='color'?'flex':'none'}">
            <span class="settings-row-label">背景颜色</span>
            <input type="color" id="b-theme-bg-color" value="${escapeHtml(settings.theme_bg_value||settings.theme_color||'#f5e6f8')}"
              style="width:44px;height:36px;border:none;border-radius:8px;cursor:pointer;background:none"
              oninput="pickThemeBgColorB(this.value)">
          </div>
          <div id="b-theme-bg-upload-row" class="settings-row" style="display:${themeBgType==='image'?'flex':'none'}">
            <span class="settings-row-label">背景图片</span>
            <div>
              <input type="file" id="b-theme-bg-file-input" accept="image/*" style="display:none" onchange="handleThemeBgUploadB(event)">
              <button class="btn btn-ghost btn-sm" onclick="document.getElementById('b-theme-bg-file-input').click()">选择图片</button>
              ${settings.theme_bg_value && themeBgType==='image' ? `<div style="font-size:11px;color:var(--theme);margin-top:4px">✓ 已设置</div>` : ''}
            </div>
          </div>
        </div>
      </div>

      <!-- 桌面背景（主页） -->
      <div class="settings-section">
        <div class="settings-section-title">桌面背景</div>
        <div class="settings-group">
          <div class="settings-row" style="padding:12px 16px 4px">
            <span class="settings-row-label" style="font-size:12px;color:var(--text-secondary);line-height:1.6">主页壁纸 + 可选叠加特效，两者独立组合</span>
          </div>
          <div class="settings-row">
            <span class="settings-row-label">壁纸</span>
            <div class="tag-list">
              <div class="tag ${!desktopBgType||desktopBgType==='particle'?'active':''}" onclick="setBgTypeB('particle',this)">粒子</div>
              <div class="tag ${desktopBgType==='image'?'active':''}" onclick="setBgTypeB('image',this)">图片</div>
              <div class="tag ${desktopBgType==='video'?'active':''}" onclick="setBgTypeB('video',this)">视频</div>
            </div>
          </div>
          <div id="b-bg-upload-row" class="settings-row" style="display:${desktopBgType==='image'||desktopBgType==='video'?'flex':'none'}">
            <span class="settings-row-label">壁纸文件</span>
            <div>
              <input type="file" id="b-bg-file-input"
                accept="${desktopBgType==='video'?'video/*':'image/*'}"
                style="display:none" onchange="handleBgUploadB(event)">
              <button class="btn btn-ghost btn-sm" onclick="document.getElementById('b-bg-file-input').click()">选择文件</button>
              ${settings.bg_value ? `<div style="font-size:11px;color:var(--theme);margin-top:4px">✓ 已设置</div>` : ''}
            </div>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;padding:14px;gap:8px">
            <span class="settings-row-label">叠加特效</span>
            <div class="tag-list" id="b-overlay-tags">
              ${DESKTOP_OVERLAYS.map(o => `
                <div class="tag ${desktopOverlay===o.id?'active':''}" onclick="setDesktopOverlayB('${o.id}',this)">${o.name}</div>
              `).join('')}
            </div>
            <span style="font-size:11px;color:var(--text-secondary);line-height:1.5">雾气/玻璃/浴室玻璃叠在壁纸上；浴室玻璃带水珠滑落动画</span>
          </div>
          <div id="b-overlay-amount-row" class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:8px;display:${['mist','glass','frosted'].includes(desktopOverlay)?'flex':'none'}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="settings-row-label" id="b-overlay-amount-label">${['glass','frosted'].includes(desktopOverlay)?'清晰度':'特效程度'}</span>
              <span id="b-overlay-amount-val" style="font-size:12px;color:var(--text-secondary)">${overlayAmount}%</span>
            </div>
            <input type="range" id="b-overlay-amount" min="0" max="100" value="${overlayAmount}"
              style="width:100%;accent-color:var(--theme)" oninput="previewOverlayAmountB()">
          </div>
        </div>
      </div>

      <!-- 主页桌面布局 -->
      <div class="settings-section">
        <div class="settings-section-title">主页桌面</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:10px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="settings-row-label">图标网格</span>
              <span id="b-home-grid-val" style="font-size:12px;color:var(--text-secondary)">${homeGrid}×${homeGrid}</span>
            </div>
            <div class="tag-list" id="b-home-grid">
              ${[4, 5, 6, 7].map(n =>
                `<div class="tag ${String(homeGrid) === String(n) ? 'active' : ''}" data-val="${n}" onclick="setHomeGridB('${n}', this)">${n}×${n}</div>`
              ).join('')}
            </div>
            <span style="font-size:11px;color:var(--text-secondary)">长按空白桌面可添加小组件；图标叠在一起会收进文件夹，可点开重命名；小组件长按移动，侧面按钮调大小</span>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">主页按钮</div>
        <div class="settings-section-desc" style="padding:0 16px 8px;font-size:12px;color:var(--text-secondary)">桌面图标玻璃质感。底栏应用可与桌面长按拖动互换。</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:10px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="settings-row-label">按钮透明度</span>
              <span id="b-nav-opacity-val" style="font-size:12px;color:var(--text-secondary)">${navTransparency}%</span>
            </div>
            <input type="range" id="b-nav-transparency" min="0" max="100" value="${navTransparency}"
              style="width:100%;accent-color:var(--theme)" oninput="previewNavStyleB()">
            <span style="font-size:11px;color:var(--text-secondary)">100% 为完全透明，可透出壁纸</span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:10px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="settings-row-label">图标圆角</span>
              <span id="b-nav-radius-val" style="font-size:12px;color:var(--text-secondary)">${navRadius}px</span>
            </div>
            <input type="range" id="b-nav-radius" min="0" max="28" value="${navRadius}"
              style="width:100%;accent-color:var(--theme)" oninput="previewNavStyleB()">
            <span style="font-size:11px;color:var(--text-secondary)">0 为方角，28 为圆形</span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:10px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="settings-row-label">按钮间距</span>
              <span id="b-nav-gap-val" style="font-size:12px;color:var(--text-secondary)">${navGap}px</span>
            </div>
            <input type="range" id="b-nav-gap" min="4" max="28" value="${navGap}"
              style="width:100%;accent-color:var(--theme)" oninput="previewNavStyleB()">
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">底栏样式</div>
        <div class="settings-section-desc" style="padding:0 16px 8px;font-size:12px;color:var(--text-secondary)">底部胶囊托盘的圆角与透明度，与上方图标样式分开调。</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:10px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="settings-row-label">底栏透明度</span>
              <span id="b-dock-opacity-val" style="font-size:12px;color:var(--text-secondary)">${dockTransparency}%</span>
            </div>
            <input type="range" id="b-dock-transparency" min="0" max="100" value="${dockTransparency}"
              style="width:100%;accent-color:var(--theme)" oninput="previewDockStyleB()">
            <span style="font-size:11px;color:var(--text-secondary)">100% 为完全透明（只剩图标）</span>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:10px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="settings-row-label">底栏圆角</span>
              <span id="b-dock-radius-val" style="font-size:12px;color:var(--text-secondary)">${dockRadius}px</span>
            </div>
            <input type="range" id="b-dock-radius" min="0" max="48" value="${dockRadius}"
              style="width:100%;accent-color:var(--theme)" oninput="previewDockStyleB()">
            <span style="font-size:11px;color:var(--text-secondary)">0 为方角，48 为更圆的胶囊</span>
          </div>
        </div>
      </div>

      <!-- 图标显示 -->
      <div class="settings-section">
        <div class="settings-section-title">图标显示</div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row-label">
              <div>隐藏桌面应用名称</div>
              <div class="settings-row-sub">主页图标下方不显示文字标签</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="b-hide-labels" ${hideLabels?'checked':''}
                onchange="previewHideLabels(this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- 主页文字颜色 -->
      <div class="settings-section">
        <div class="settings-section-title">主页文字颜色</div>
        <div class="settings-group">
          <div class="settings-row">
            <span class="settings-row-label">时钟 / 标签文字颜色</span>
            <div style="display:flex;align-items:center;gap:10px">
              <input type="color" id="b-home-text-color" value="${localStorage.getItem('beautify_home_text_color')||'#ffffff'}"
                style="width:36px;height:36px;border:none;border-radius:8px;cursor:pointer;background:none"
                oninput="previewHomeTextColor(this.value)">
              <button class="btn btn-ghost btn-sm" onclick="document.getElementById('b-home-text-color').value='#ffffff';previewHomeTextColor('#ffffff')">重置</button>
            </div>
          </div>
          <div class="settings-row">
            <span class="settings-row-label" style="font-size:12px;color:var(--text-secondary)">建议深色背景配白色，浅色背景配深色</span>
          </div>
        </div>
      </div>

      <!-- 保存到桌面图标 -->
      <div class="settings-section">
        <div class="settings-section-title">保存到桌面图标</div>
        <div class="settings-section-desc" style="padding:0 16px 8px;font-size:12px;color:var(--text-secondary);line-height:1.55">
          ${window.isNativeShell?.()
            ? '套壳 App 应用列表里的图标是打包时的「念」，网页换不了。更换后可点「放到系统桌面」，钉一枚用你这张图的快捷方式（系统会再确认一次）。'
            : '这项只管浏览器「添加到主屏幕」。更换后请先<strong>删除</strong>桌面上旧快捷方式，刷新确认预览已是新图，再重新添加。'}
        </div>
        <div class="settings-group">
          <div class="settings-row" style="padding:10px 16px">
            <div style="display:flex;align-items:center;gap:10px;flex:1">
              <div id="b-pwa-icon-preview" style="
                width:56px;height:56px;border-radius:14px;overflow:hidden;
                background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
                display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0;
              ">${pwaIcon
                ? `<img src="${escapeHtml(pwaIcon)}" style="width:100%;height:100%;object-fit:cover">`
                : '<img src="/assets/icons/apple-touch-icon.png" style="width:100%;height:100%;object-fit:cover" alt="">'}</div>
              <span style="font-size:13px;color:var(--text-secondary)">桌面 / 主屏幕</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <input type="file" id="b-pwa-icon-file" accept="image/*,image/gif,image/webp" style="display:none"
                onchange="handlePwaIconUpload(event)">
              <button class="btn btn-ghost btn-sm" onclick="document.getElementById('b-pwa-icon-file').click()">更换</button>
              ${pwaIcon ? `<button class="btn btn-ghost btn-sm" style="color:#e05555;border-color:rgba(224,85,85,0.3)" onclick="resetPwaIconB()">重置</button>` : ''}
              ${window.isNativeShell?.() ? '<button class="btn btn-ghost btn-sm" onclick="pinBeautifyLauncherIcon()">放到系统桌面</button>' : ''}
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">字体</div>
        <div class="settings-section-desc" style="padding:0 16px 8px;font-size:12px;color:var(--text-secondary)">界面字体影响全局文案；上传字体后也可选。随手记 / 聊天气泡仍可单独设字迹。</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:12px 14px;gap:10px">
            <div class="settings-row-label">界面字体</div>
            <div id="b-app-font-pills" class="b-app-font-pills"></div>
            <div id="b-app-font-preview" class="custom-font-preview" style="min-height:52px;font-size:17px">念 · 界面预览 春风又绿江南岸</div>
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:12px 14px;gap:8px">
            <div class="settings-row-label">上传自定义字体</div>
            <div id="b-font-preview" class="custom-font-preview">念 · 随手记 春风又绿江南岸 AaBb 123</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
              <input type="text" id="b-font-name" class="settings-input" placeholder="字体显示名（可选）" maxlength="40" style="flex:1;min-width:140px">
              <input type="file" id="b-font-file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" style="display:none" onchange="handleCustomFontUpload(event)">
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('b-font-file').click()">上传字体</button>
            </div>
          </div>
          <div id="b-font-list"></div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">自定义图标</div>
        <div class="settings-section-desc" style="padding:0 16px 8px;font-size:12px;color:var(--text-secondary)">支持 PNG / JPG / GIF / WEBP，透明底图效果最佳</div>
        <div class="settings-group" id="b-icon-list">
          ${NAV_APPS.map(app => {
            const iconUrl = getAppIcons()[app.key] || '';
            return `
            <div class="settings-row" style="padding:10px 14px">
              <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
                <div id="b-icon-preview-${app.key}" style="
                  width:44px;height:44px;border-radius:12px;overflow:hidden;
                  background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
                  display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;
                ">${iconUrl ? `<img src="${escapeHtml(iconUrl)}" style="width:100%;height:100%;object-fit:contain">` : `<span style="color:rgba(255,255,255,.9);display:flex">${appIconHtml(app.icon)}</span>`}</div>
                <span style="font-size:13px;color:var(--text-secondary)">${app.defaultName}</span>
              </div>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="file" id="b-icon-file-${app.key}" accept="image/*,image/gif,image/webp"
                  style="display:none" onchange="handleIconUpload(event,'${app.key}')">
                <button class="btn btn-ghost btn-sm" onclick="document.getElementById('b-icon-file-${app.key}').click()">更换</button>
                ${iconUrl ? `<button class="btn btn-ghost btn-sm" style="color:#e05555;border-color:rgba(224,85,85,0.3)" onclick="resetAppIcon('${app.key}')">重置</button>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <!-- 系统声音 -->
      <div class="settings-section">
        <div class="settings-section-title">系统声音</div>
        <div class="settings-section-desc" style="padding:0 16px 8px;font-size:12px;color:var(--text-secondary)">用自己的音频替换念里的提示音。留空则用默认。</div>
        <div class="settings-group">
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:8px">
            <div class="settings-row-label">
              <div>通知提示</div>
              <div class="settings-row-sub">新消息等短提示</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('b-sound-notify').click()">上传音频</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="previewBeautifySound('notify')">试听</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="clearBeautifySound('notify')">恢复默认</button>
              <span id="b-sound-notify-name" style="font-size:12px;color:var(--text-secondary)">${settings.sound_notify ? '已自定义' : '默认'}</span>
            </div>
            <input type="file" id="b-sound-notify" accept="audio/*" hidden onchange="uploadBeautifySound(event,'notify')">
          </div>
          <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:14px;gap:8px">
            <div class="settings-row" style="padding:0">
              <div class="settings-row-label">
                <div>来电铃声</div>
                <div class="settings-row-sub">角色打来电话时循环播放</div>
              </div>
              <label class="toggle" title="使用手机系统电话铃声">
                <input type="checkbox" id="b-sound-call-system" ${String(settings.sound_call_system)==='1'?'checked':''}
                  onchange="syncBeautifyCallSoundUi()">
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:-4px">打开：跟手机电话铃声一样。关掉：用下面上传的音频（没上传则是提示音）</div>
            <div id="b-sound-call-custom" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('b-sound-call').click()">上传音频</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="previewBeautifySound('call')">试听</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="clearBeautifySound('call')">恢复默认</button>
              <span id="b-sound-call-name" style="font-size:12px;color:var(--text-secondary)">${settings.sound_call ? '已自定义' : '默认'}</span>
            </div>
            <input type="file" id="b-sound-call" accept="audio/*" hidden onchange="uploadBeautifySound(event,'call')">
          </div>
        </div>
      </div>

      <!-- 自定义应用名称 -->
      <div class="settings-section">
        <div class="settings-section-title">自定义应用名称</div>
        <div class="settings-section-desc" style="padding:0 16px 8px;font-size:12px;color:var(--text-secondary)">留空则使用默认名称</div>
        <div class="settings-group" id="b-app-names-list">
          ${NAV_APPS.map(app => `
            <div class="settings-row" style="padding:10px 16px">
              <span class="settings-row-label" style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                <span style="width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;color:var(--text-secondary)">${appIconHtml(app.icon)}</span>
                <span style="color:var(--text-secondary);font-size:12px">${app.defaultName}</span>
              </span>
              <input class="input" data-app-key="${app.key}"
                value="${escapeHtml(appNames[app.key]||'')}"
                placeholder="${app.defaultName}"
                style="width:110px;padding:6px 10px;font-size:13px">
            </div>
          `).join('')}
        </div>
        <div style="padding:10px 16px 0;display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="resetAppNamesB()">恢复默认</button>
        </div>
      </div>

    </div>
  `;

  window._bPendingSoundNotify = settings.sound_notify || '';
  window._bPendingSoundCall = settings.sound_call || '';
  window._bPendingSoundCallSystem = String(settings.sound_call_system || '0') === '1' ? '1' : '0';
  window.syncBeautifyCallSoundUi?.();
  window._bPendingThemeColor = themeColor;
  window._bPendingColorScheme = colorScheme;
  window._bPendingThemeBgType = themeBgType;
  window._bPendingThemeBgValue = themeBgType === 'gradient' ? themeGradientPreset : (settings.theme_bg_value || '');
  window._bPendingBgType = desktopBgType;
  window._bPendingBgValue = settings.bg_value || '';
  window._bPendingOverlay = desktopOverlay;
  window._bPendingOverlayAmount = overlayAmount;
  window._bPendingBgCrop = null;
  if (desktopBgType === 'video') {
    try { if (settings.bg_crop) window._bPendingBgCrop = JSON.parse(settings.bg_crop); } catch {}
  }
  window.applyThemePreview?.(themeColor);
  window.applyColorSchemePreview?.(colorScheme);
  try {
    await loadCustomFonts();
  } catch {}
  renderAppFontPicker();
  renderCustomFontManager();
};

function renderAppFontPicker() {
  const host = document.getElementById('b-app-font-pills');
  const preview = document.getElementById('b-app-font-preview');
  if (!host) return;
  const cur = getAppFontId();
  const fonts = getPaperFonts();
  host.innerHTML = fonts.map((f) => `
    <button type="button" class="b-app-font-pill${f.id === cur ? ' active' : ''}"
      style="font-family:${f.family}"
      onclick="setBeautifyAppFont('${escapeHtml(f.id)}')">${escapeHtml(f.label)}</button>
  `).join('');
  const font = fonts.find((x) => x.id === cur) || fonts[0];
  if (preview && font) {
    preview.style.fontFamily = font.family;
    preview.textContent = '念 · 界面预览 春风又绿江南岸 AaBb 123';
  }
}

window.setBeautifyAppFont = function(id) {
  applyAppFont(id);
  renderAppFontPicker();
  window.showToast?.('界面字体已更换');
};

function renderCustomFontManager() {
  const listEl = document.getElementById('b-font-list');
  const previewEl = document.getElementById('b-font-preview');
  if (previewEl) previewEl.textContent = getFontPreviewSample();
  if (!listEl) return;
  const customs = getCustomFonts();
  const builtins = getPaperFonts().filter((f) => !f.custom);
  const preview = getFontPreviewSample();
  const browseOpen = localStorage.getItem('beautify_font_browse_open') === '1';

  const builtinHtml = `
    <button type="button" class="settings-row custom-font-browse-toggle" onclick="toggleBeautifyFontBrowse()"
      style="width:100%;border:none;background:transparent;text-align:left;cursor:pointer">
      <span class="settings-row-label">内置字体阅览</span>
      <span class="settings-row-value" id="b-font-browse-chevron">${browseOpen ? '收起' : '展开'}</span>
    </button>
    <div id="b-font-browse" class="custom-font-browse-wrap"${browseOpen ? '' : ' hidden'}>
      <div class="custom-font-browse" style="padding:0 14px 12px">
        ${builtins.map((f) => `
          <button type="button" class="custom-font-card" style="font-family:${f.family}"
            onclick="previewBeautifyFont('${f.id}', this)" title="${escapeHtml(f.label)}">
            <span class="custom-font-card-name">${escapeHtml(f.label)}</span>
            <span class="custom-font-card-sample">${escapeHtml(preview)}</span>
          </button>`).join('')}
      </div>
    </div>`;

  if (!customs.length) {
    listEl.innerHTML = builtinHtml + `
      <div class="settings-row" style="padding:12px 14px;color:var(--text-secondary);font-size:13px">还没有上传字体</div>`;
    return;
  }

  listEl.innerHTML = builtinHtml + customs.map((f) => `
    <div class="settings-row" style="flex-direction:column;align-items:stretch;padding:12px 14px;gap:8px">
      <button type="button" class="custom-font-card is-custom" style="font-family:'${escapeHtml(f.familyName)}',sans-serif;text-align:left"
        onclick="previewBeautifyFont('custom:${f.id}', this)">
        <span class="custom-font-card-name">${escapeHtml(f.name || '自定义')}</span>
        <span class="custom-font-card-sample">${escapeHtml(preview)}</span>
      </button>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="input" id="b-font-rename-${f.id}" value="${escapeHtml(f.name || '')}" maxlength="40"
          style="flex:1;min-width:120px;padding:6px 10px;font-size:13px" placeholder="显示名">
        <button type="button" class="btn btn-ghost btn-sm" onclick="saveCustomFontName('${f.id}')">保存名称</button>
        <button type="button" class="btn btn-ghost btn-sm" style="color:#e05555;border-color:rgba(224,85,85,0.3)"
          onclick="removeCustomFont('${f.id}')">删除</button>
      </div>
    </div>`).join('');
}

window.toggleBeautifyFontBrowse = function() {
  const wrap = document.getElementById('b-font-browse');
  const chev = document.getElementById('b-font-browse-chevron');
  if (!wrap) return;
  const open = wrap.classList.toggle('hidden') === false;
  localStorage.setItem('beautify_font_browse_open', open ? '1' : '0');
  if (chev) chev.textContent = open ? '收起' : '展开';
};

window.previewBeautifyFont = function(fontId, el) {
  const fonts = getPaperFonts();
  const f = fonts.find((x) => x.id === fontId) || fonts[0];
  const previewEl = document.getElementById('b-font-preview');
  if (previewEl && f) {
    previewEl.style.fontFamily = f.family;
    previewEl.textContent = getFontPreviewSample();
  }
  document.querySelectorAll('.custom-font-card').forEach((c) => c.classList.remove('active'));
  el?.classList.add('active');
};

window.handleCustomFontUpload = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    window.showToast?.('字体不能超过 8MB');
    e.target.value = '';
    return;
  }
  const name = document.getElementById('b-font-name')?.value?.trim() || '';
  try {
    const font = await uploadCustomFont(file, name);
    window.showToast?.(`已保存「${font?.name || '自定义字体'}」`);
    const nameInput = document.getElementById('b-font-name');
    if (nameInput) nameInput.value = '';
    renderAppFontPicker();
    renderCustomFontManager();
    if (font) previewBeautifyFont(`custom:${font.id}`);
  } catch (err) {
    window.showToast?.(err.message || '上传失败');
  }
  e.target.value = '';
};

window.saveCustomFontName = async function(id) {
  const input = document.getElementById(`b-font-rename-${id}`);
  const name = input?.value?.trim();
  if (!name) { window.showToast?.('名称不能为空'); return; }
  try {
    await renameCustomFont(id, name);
    window.showToast?.('名称已保存');
    renderCustomFontManager();
  } catch (err) {
    window.showToast?.(err.message || '保存失败');
  }
};

window.removeCustomFont = async function(id) {
  if (!confirm('确定删除这个字体？已选用它的地方会回退到默认字体。')) return;
  try {
    await deleteCustomFont(id);
    if (getAppFontId() === `custom:${id}`) applyAppFont('sans');
    window.showToast?.('已删除');
    renderAppFontPicker();
    renderCustomFontManager();
  } catch (err) {
    window.showToast?.(err.message || '删除失败');
  }
};

window.setColorSchemeB = function(val, el) {
  window._bPendingColorScheme = val;
  document.querySelectorAll('#b-color-scheme .tag').forEach(t =>
    t.classList.toggle('active', t.dataset.val === val));
  window.applyColorSchemePreview?.(val);
};

/* ─── 主题色 ─── */
window.pickThemeColorB = function(color, el) {
  window._bPendingThemeColor = color;
  document.querySelectorAll('#b-color-presets .color-preset').forEach(e => e.classList.remove('active'));
  el?.classList.add('active');
  window.applyThemePreview?.(color);
  document.getElementById('b-theme-swatch')?.style.setProperty('background', color);
  const hexEl = document.getElementById('b-theme-hex');
  if (hexEl) hexEl.textContent = color;
  const customInput = document.getElementById('b-custom-color');
  if (customInput) customInput.value = color;
  if ((window._bPendingThemeBgType || 'gradient') === 'gradient') {
    previewThemeBgB('gradient', window._bPendingThemeBgValue || 'dreamy');
    refreshGradientSwatches(color);
  }
};

function refreshGradientSwatches(themeColor) {
  const preset = window._bPendingThemeBgValue || 'dreamy';
  document.querySelectorAll('#b-gradient-presets .gradient-preset').forEach((el, i) => {
    const p = GRADIENT_PRESETS[i];
    if (p) el.style.background = buildThemeGradient(themeColor, p.id);
  });
}

window.pickThemeGradientB = function(presetId, el) {
  window._bPendingThemeBgValue = presetId;
  document.querySelectorAll('#b-gradient-presets .gradient-preset').forEach(e => e.classList.remove('active'));
  el?.classList.add('active');
  previewThemeBgB('gradient', presetId);
};

/* ─── 主题背景 ─── */
window.setThemeBgTypeB = function(type, el) {
  window._bPendingThemeBgType = type;
  document.querySelectorAll('[onclick^="setThemeBgTypeB"]').forEach(e => e.classList.remove('active'));
  el?.classList.add('active');
  const gradientRow = document.getElementById('b-theme-gradient-row');
  const colorRow = document.getElementById('b-theme-bg-color-row');
  const uploadRow = document.getElementById('b-theme-bg-upload-row');
  if (gradientRow) gradientRow.style.display = type === 'gradient' ? 'flex' : 'none';
  if (colorRow) colorRow.style.display = type === 'color' ? 'flex' : 'none';
  if (uploadRow) uploadRow.style.display = type === 'image' ? 'flex' : 'none';
  if (type === 'gradient') {
    previewThemeBgB('gradient', window._bPendingThemeBgValue || 'dreamy');
  } else {
    previewThemeBgB(type, window._bPendingThemeBgValue);
  }
};

window.pickThemeBgColorB = function(color) {
  window._bPendingThemeBgValue = color;
  previewThemeBgB('color', color);
};

window.handleThemeBgUploadB = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const result = await pickCropAndUpload(file, { title: '裁剪主题背景', aspect: window.innerWidth / window.innerHeight });
    if (!result) return;
    window._bPendingThemeBgType = 'image';
    window._bPendingThemeBgValue = result.url;
    document.querySelectorAll('[onclick^="setThemeBgTypeB"]').forEach(el => {
      el.classList.toggle('active', el.getAttribute('onclick')?.includes("'image'"));
    });
    const uploadRow = document.getElementById('b-theme-bg-upload-row');
    if (uploadRow) uploadRow.style.display = 'flex';
    previewThemeBgB('image', result.url);
    window.showToast?.('主题背景已选择，记得保存');
  } catch(err) { window.showToast?.('上传失败: ' + err.message); }
  e.target.value = '';
};

function previewThemeBgB(type, value) {
  window.setThemeBgPreview?.(type, value, window._bPendingThemeColor);
  document.getElementById('theme-bg')?.classList.add('visible');
}

window.previewNavStyleB = function() {
  const transparency = document.getElementById('b-nav-transparency')?.value || getNavTransparency();
  const radius = document.getElementById('b-nav-radius')?.value || '28';
  const gap = document.getElementById('b-nav-gap')?.value || '10';
  document.getElementById('b-nav-opacity-val').textContent = `${transparency}%`;
  document.getElementById('b-nav-radius-val').textContent = `${radius}px`;
  document.getElementById('b-nav-gap-val').textContent = `${gap}px`;
  localStorage.setItem('beautify_nav_transparency', transparency);
  localStorage.setItem('beautify_nav_radius', radius);
  localStorage.setItem('beautify_nav_gap', gap);
  window.applyNavButtonStyle?.();
};

window.previewDockStyleB = function() {
  const transparency = document.getElementById('b-dock-transparency')?.value || '20';
  const radius = document.getElementById('b-dock-radius')?.value || '36';
  const opEl = document.getElementById('b-dock-opacity-val');
  const rEl = document.getElementById('b-dock-radius-val');
  if (opEl) opEl.textContent = `${transparency}%`;
  if (rEl) rEl.textContent = `${radius}px`;
  localStorage.setItem('beautify_dock_transparency', transparency);
  localStorage.setItem('beautify_dock_radius', radius);
  window.applyNavButtonStyle?.();
};

window.setDesktopOverlayB = function(overlayId, el) {
  window._bPendingOverlay = overlayId;
  document.querySelectorAll('#b-overlay-tags .tag').forEach(e => e.classList.remove('active'));
  el?.classList.add('active');
  const row = document.getElementById('b-overlay-amount-row');
  const label = document.getElementById('b-overlay-amount-label');
  const show = ['mist', 'glass', 'frosted'].includes(overlayId);
  if (row) row.style.display = show ? 'flex' : 'none';
  if (label) label.textContent = ['glass', 'frosted'].includes(overlayId) ? '清晰度' : '特效程度';
  previewDesktopBg();
};

window.previewOverlayAmountB = function() {
  const v = document.getElementById('b-overlay-amount')?.value || '50';
  window._bPendingOverlayAmount = v;
  document.getElementById('b-overlay-amount-val').textContent = `${v}%`;
  previewDesktopBg();
};

function previewDesktopBg() {
  window.applyDesktopPreview?.(
    window._bPendingBgType || 'particle',
    window._bPendingBgValue || '',
    window._bPendingOverlay || 'none',
    window._bPendingOverlayAmount || '50'
  );
}

/* ─── 背景类型 ─── */
window.setBgTypeB = function(type, el) {
  window._bPendingBgType = type;
  document.querySelectorAll('[onclick^="setBgTypeB"]').forEach(e => e.classList.remove('active'));
  el?.classList.add('active');
  const row = document.getElementById('b-bg-upload-row');
  if (row) row.style.display = (type === 'image' || type === 'video') ? 'flex' : 'none';
  const fileInput = document.getElementById('b-bg-file-input');
  if (fileInput) fileInput.accept = type === 'video' ? 'video/*' : 'image/*';
  previewDesktopBg();
};

/* ─── 背景上传 ─── */
window.handleBgUploadB = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const isVideo = file.type.startsWith('video/');
    const result = await pickCropAndUpload(file, {
      title: isVideo ? '裁剪视频显示区域' : '裁剪桌面壁纸',
      aspect: window.innerWidth / window.innerHeight,
      // 视频保留原片+裁剪框；图片直接导出压缩图，避免原图像素拖垮内页
      retainSource: isVideo,
      maxEdge: isVideo ? undefined : Math.max(1280, Math.round(Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1))),
    });
    if (!result) return;
    window._bPendingBgType = isVideo ? 'video' : 'image';
    window._bPendingBgValue = result.url;
    // 图片已是裁切后的文件，不再需要 CSS 裁剪偏移
    window._bPendingBgCrop = isVideo ? (result.crop || null) : null;

    document.querySelectorAll('[onclick^="setBgTypeB"]').forEach(el => {
      el.classList.toggle('active', el.getAttribute('onclick')?.includes(`'${window._bPendingBgType}'`));
    });
    const row = document.getElementById('b-bg-upload-row');
    if (row) row.style.display = 'flex';

    previewDesktopBg();
    window.showToast?.('背景已选择，点右上角保存生效');
  } catch(err) { window.showToast?.('上传失败: ' + err.message); }
  e.target.value = '';
};

/* ─── 主页网格 ─── */
window.setHomeGridB = function(n, el) {
  const size = String(n);
  localStorage.setItem('beautify_home_grid', size);
  document.querySelectorAll('#b-home-grid .tag').forEach(t => t.classList.remove('active'));
  el?.classList.add('active');
  const val = document.getElementById('b-home-grid-val');
  if (val) val.textContent = `${size}×${size}`;
  window.setHomeGridSize?.(Number(size));
  window.showToast?.(`已切换为 ${size}×${size}`);
};

/* ─── 实时预览隐藏标签 ─── */
window.previewHideLabels = function(hide) {
  document.querySelectorAll('.home-icon-label').forEach(el => {
    el.style.display = hide ? 'none' : '';
  });
};

/* ─── 恢复默认名称 ─── */
window.resetAppNamesB = function() {
  if (!confirm('恢复所有应用名称为默认？')) return;
  document.querySelectorAll('#b-app-names-list [data-app-key]').forEach(input => {
    input.value = '';
  });
  window.showToast?.('已清除自定义名称（记得保存）');
};

/* ─── 图标上传 ─── */
window.handleIconUpload = async function(e, key) {
  const file = e.target.files?.[0];
  if (!file) return;

  // 前端大小检查（4MB）
  if (file.size > 4 * 1024 * 1024) { window.showToast?.('图片不能超过 4MB'); e.target.value = ''; return; }

  try {
    const result = await pickCropAndUpload(file, { title: '裁剪图标', aspect: 1 });
    if (!result) return;
    const url = result.url;
    const icons = getAppIcons();
    icons[key] = url;
    saveAppIcons(icons);

    // 更新预览
    const preview = document.getElementById(`b-icon-preview-${key}`);
    if (preview) preview.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:contain">`;

    // 立即应用到主页
    window.refreshHomeLabels?.();
    window.showToast?.('图标已更换');
  } catch(err) { window.showToast?.('上传失败: ' + err.message); }
  e.target.value = '';
};

window.resetAppIcon = function(key) {
  const icons = getAppIcons();
  delete icons[key];
  saveAppIcons(icons);

  // 更新预览（恢复 emoji）
  const app = NAV_APPS.find(a => a.key === key);
  const preview = document.getElementById(`b-icon-preview-${key}`);
  if (preview && app) preview.innerHTML = `<span style="color:rgba(255,255,255,.9);display:flex">${appIconHtml(app.icon)}</span>`;

  // 立即应用到主页
  window.refreshHomeLabels?.();
  window.showToast?.('已恢复默认图标');

  // 刷新整个页面区域（重置按钮消失）
  window.initBeautifyPage?.();
};

window.handlePwaIconUpload = async function(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { window.showToast?.('图片不能超过 4MB'); e.target.value = ''; return; }
  try {
    const result = await pickCropAndUpload(file, { title: '裁剪桌面图标', aspect: 1 });
    if (!result?.url) return;
    savePwaIcon(result.url);
    bumpPwaIconVersion();
    applyPwaIcon(result.url);
    try {
      const current = await api.getSettings();
      await api.saveSettings({ ...current, pwa_icon: result.url });
    } catch { /* 本地已生效，后端同步失败不阻断 */ }
    const preview = document.getElementById('b-pwa-icon-preview');
    if (preview) preview.innerHTML = `<img src="${result.url}" style="width:100%;height:100%;object-fit:cover">`;
    window.showToast?.(window.isNativeShell?.()
      ? '已保存。应用列表仍是默认「念」；可点「放到系统桌面」钉你这张图'
      : '桌面图标已更换，请删除旧快捷方式后重新添加');
    window.initBeautifyPage?.();
  } catch (err) { window.showToast?.('上传失败: ' + err.message); }
  e.target.value = '';
};

window.uploadBeautifySound = async function(e, kind) {
  const file = e.target?.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) {
    window.showToast?.('音频不能超过 6MB');
    return;
  }
  try {
    const up = await api.uploadFile(file);
    const url = up?.url || '';
    if (!url) throw new Error('上传未返回地址');
    if (kind === 'call') window._bPendingSoundCall = url;
    else window._bPendingSoundNotify = url;
    const nameEl = document.getElementById(kind === 'call' ? 'b-sound-call-name' : 'b-sound-notify-name');
    if (nameEl) nameEl.textContent = '已自定义（未保存）';
    window.showToast?.('已选音频，点右上角保存');
  } catch (err) {
    window.showToast?.('上传失败: ' + (err.message || ''));
  }
};

window.syncBeautifyCallSoundUi = function() {
  const on = !!document.getElementById('b-sound-call-system')?.checked;
  window._bPendingSoundCallSystem = on ? '1' : '0';
  const row = document.getElementById('b-sound-call-custom');
  if (row) {
    row.style.opacity = on ? '0.45' : '1';
    row.querySelectorAll('button').forEach((el) => { el.disabled = on && el.textContent !== '试听'; });
  }
};

window.clearBeautifySound = function(kind) {
  if (kind === 'call') window._bPendingSoundCall = '';
  else window._bPendingSoundNotify = '';
  const nameEl = document.getElementById(kind === 'call' ? 'b-sound-call-name' : 'b-sound-notify-name');
  if (nameEl) nameEl.textContent = '默认（未保存）';
  stopCallRingtone();
};

window.previewBeautifySound = function(kind) {
  if (kind === 'call') {
    const system = !!document.getElementById('b-sound-call-system')?.checked
      || window._bPendingSoundCallSystem === '1';
    playCallRingtone(window._bPendingSoundCall || '', { system });
    setTimeout(() => stopCallRingtone(), 4000);
    return;
  }
  const prev = window.getAppSettings;
  const snap = { ...(window.getAppSettings?.() || {}), sound_notify: window._bPendingSoundNotify || '' };
  window.getAppSettings = () => snap;
  try { playNotifySound(); } finally { window.getAppSettings = prev; }
};

window.resetPwaIconB = async function() {
  savePwaIcon('');
  applyPwaIcon('');
  try {
    const current = await api.getSettings();
    await api.saveSettings({ ...current, pwa_icon: '' });
  } catch { /* ignore */ }
  window.showToast?.('已恢复默认桌面图标');
  window.initBeautifyPage?.();
};

window.pinBeautifyLauncherIcon = async function() {
  if (!canPinLauncherIcon()) {
    window.showToast?.('当前不是套壳 App，或插件未加载');
    return;
  }
  const raw = getPwaIcon();
  const imageUrl = raw ? (window.resolveMediaUrl?.(raw) || raw) : '';
  try {
    const r = await pinCustomLauncherIcon({ imageUrl, label: '念' });
    if (r?.updated) window.showToast?.('已更新桌面上的自定义图标');
    else if (r?.prompted) window.showToast?.('请在系统弹窗里确认放到桌面');
    else if (r?.skipped) window.showToast?.('当前环境不能钉系统图标');
  } catch (e) {
    window.showToast?.(e?.message || '放到桌面失败');
  }
};

/* ─── 保存美化设置 ─── */
window.saveBeautifySettings = async function() {
  const themeColor = window._bPendingThemeColor || '#c9a0dc';
  const bgType     = window._bPendingBgType     || 'particle';
  const hideLabels = document.getElementById('b-hide-labels')?.checked ?? false;

  // 收集自定义应用名
  const names = {};
  document.querySelectorAll('#b-app-names-list [data-app-key]').forEach(input => {
    const val = input.value.trim();
    if (val) names[input.dataset.appKey] = val;
  });

  // 持久化 localStorage
  saveAppNames(names);
  localStorage.setItem('beautify_hide_labels', hideLabels ? '1' : '0');
  const homeTextColor = document.getElementById('b-home-text-color')?.value || '#ffffff';
  localStorage.setItem('beautify_home_text_color', homeTextColor);
  // 界面字体已在点选时写入 localStorage；保存时再确认应用一次
  try { applyAppFont(getAppFontId()); } catch {}

  try {
    const current = await api.getSettings();
    const bgValue = window._bPendingBgValue || (bgType !== 'particle' ? current.bg_value : '') || '';
    const themeBgType = window._bPendingThemeBgType || 'gradient';
    let themeBgValue = window._bPendingThemeBgValue
      || (themeBgType !== 'gradient' ? current.theme_bg_value : '') || '';
    if (themeBgType === 'gradient') {
      themeBgValue = window._bPendingThemeBgValue || resolveGradientPreset('gradient', current.theme_bg_value);
    }
    if (themeBgType === 'color' && !themeBgValue) {
      themeBgValue = document.getElementById('b-theme-bg-color')?.value || themeColor;
    }
    const bgOverlay = window._bPendingOverlay || 'none';
    if ((bgType === 'image' || bgType === 'video') && !bgValue) {
      window.showToast?.('请先上传桌面背景文件');
      return;
    }
    if (themeBgType === 'image' && !themeBgValue) {
      window.showToast?.('请先上传主题背景图片');
      return;
    }
    const navTransparency = document.getElementById('b-nav-transparency')?.value || getNavTransparency();
    const navRadius = document.getElementById('b-nav-radius')?.value || localStorage.getItem('beautify_nav_radius') || '28';
    const navGap = document.getElementById('b-nav-gap')?.value || localStorage.getItem('beautify_nav_gap') || '10';
    const dockTransparency = document.getElementById('b-dock-transparency')?.value || localStorage.getItem('beautify_dock_transparency') || '20';
    const dockRadius = document.getElementById('b-dock-radius')?.value || localStorage.getItem('beautify_dock_radius') || '36';
    const homeGrid = document.querySelector('#b-home-grid .tag.active')?.dataset?.val
      || localStorage.getItem('beautify_home_grid') || '4';
    localStorage.setItem('beautify_nav_transparency', navTransparency);
    localStorage.setItem('beautify_nav_radius', navRadius);
    localStorage.setItem('beautify_nav_gap', navGap);
    localStorage.setItem('beautify_dock_transparency', dockTransparency);
    localStorage.setItem('beautify_dock_radius', dockRadius);
    localStorage.setItem('beautify_home_grid', homeGrid);

    const overlayAmount = document.getElementById('b-overlay-amount')?.value || window._bPendingOverlayAmount || '50';
    const bgCrop = bgType === 'video'
      ? (window._bPendingBgCrop ? JSON.stringify(window._bPendingBgCrop) : (current.bg_crop || ''))
      : '';

    await api.saveSettings({
      ...current,
      sound_notify: window._bPendingSoundNotify ?? current.sound_notify ?? '',
      sound_call: window._bPendingSoundCall ?? current.sound_call ?? '',
      sound_call_system: window._bPendingSoundCallSystem ?? current.sound_call_system ?? '0',
      theme_color: themeColor,
      color_scheme: window._bPendingColorScheme || current.color_scheme || 'auto',
      theme_bg_type: themeBgType,
      theme_bg_value: themeBgValue,
      bg_type: bgType,
      bg_value: bgValue,
      bg_overlay: bgOverlay,
      bg_overlay_amount: overlayAmount,
      bg_crop: bgCrop,
      bg_particles_enabled: bgOverlay === 'particles' ? '1' : '0',
    });
    window._bPendingBgValue = bgValue;
    window._bPendingThemeBgValue = themeBgValue;
    window._bPendingOverlay = bgOverlay;
    window._bPendingOverlayAmount = overlayAmount;
    if (bgType === 'image' || bgType === 'video') {
      window._bPendingBgCrop = window._bPendingBgCrop || (bgCrop ? JSON.parse(bgCrop) : null);
    } else {
      window._bPendingBgCrop = null;
    }
    await window.refreshAppData?.();
    window.applyThemePreview?.(themeColor);
    window.applyBackground?.();
    window.applyThemeBackground?.();
    window.applyNavButtonStyle?.();
    window.refreshHomeLabels?.();
    window.refreshPeriodPageLabels?.();
    window.refreshChatAppearance?.();
    window.showToast?.('美化设置已保存');
  } catch(e) { window.showToast?.(e.message); }
};

/* 实时预览主页文字颜色 */
window.previewHomeTextColor = function(color) {
  document.querySelectorAll('.home-clock,.home-date,.home-header-clock,.home-char-corner,.home-icon-label,.home-brand').forEach(el => {
    el.style.color = color;
  });
};

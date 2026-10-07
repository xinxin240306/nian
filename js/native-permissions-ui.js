/* ===== 原生权限面板（通讯「我」› 权限） ===== */
import {
  getAppPermissionStatus,
  requestAppNotifications,
  requestBasicNativePermissions,
  requestNativeLocation,
  openNotificationListenerSettings,
  requestIgnoreBatteryOptimizations,
  openOverlaySettings,
  openAccessibilitySettings,
  openUsageAccessSettings,
  requestActivityRecognition,
  requestHealthConnect,
  openHealthConnectSettings,
  setForegroundKeepAlive,
  requestScreenCapture,
  openNativeAppSettings,
  requestShizuku,
  openShizukuApp,
  applyShizukuHelpers,
  openExactAlarmSettings,
} from './app-permissions.js';

let _nativePermBound = false;

export function nativePermissionsHtml() {
  return `
    <div class="settings-section" id="s-native-perms-section" style="display:none">
      <div class="settings-section-title">常见权限</div>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-label">系统通知</div>
          <label class="toggle"><input type="checkbox" id="s-perm-notify"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">相机</div>
          <label class="toggle"><input type="checkbox" id="s-perm-camera"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">麦克风</div>
          <label class="toggle"><input type="checkbox" id="s-perm-mic"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">位置</div>
          <label class="toggle"><input type="checkbox" id="s-perm-location"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">存储 / 相册</div>
          <label class="toggle"><input type="checkbox" id="s-perm-storage"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">电池优化</div>
          <label class="toggle"><input type="checkbox" id="s-perm-battery"><span class="toggle-slider"></span></label>
        </div>
        <div class="list-item" onclick="reaskBasicNativePermissions()">
          <span>重新询问常见权限</span>
          <span style="color:var(--text-secondary)">›</span>
        </div>
      </div>
    </div>

    <div class="settings-section" id="s-native-adv-section" style="display:none">
      <div class="settings-section-title">高阶权限</div>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-label">
            <div>Shizuku</div>
            <div class="settings-row-sub" id="s-perm-shizuku-sub" style="display:none"></div>
          </div>
          <label class="toggle"><input type="checkbox" id="s-perm-shizuku"><span class="toggle-slider"></span></label>
        </div>
        <div class="list-item" onclick="applyNativeShizukuHelpers()">
          <span>用 Shizuku 打开高阶项</span>
          <span style="color:var(--text-secondary)">›</span>
        </div>
        <div class="list-item" onclick="openNativeShizukuApp()">
          <span>打开 / 安装 Shizuku</span>
          <span style="color:var(--text-secondary)">›</span>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">通知监听 / 正在播放</div>
          <label class="toggle"><input type="checkbox" id="s-perm-listener"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">前台服务</div>
          <label class="toggle"><input type="checkbox" id="s-perm-foreground"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">悬浮窗</div>
          <label class="toggle"><input type="checkbox" id="s-perm-overlay"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <div>角色闹钟</div>
            <div class="settings-row-sub" id="s-perm-alarm-sub" style="display:none"></div>
          </div>
          <label class="toggle"><input type="checkbox" id="s-perm-alarm"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">无障碍</div>
          <label class="toggle"><input type="checkbox" id="s-perm-a11y"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">使用情况</div>
          <label class="toggle"><input type="checkbox" id="s-perm-usage"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">计步</div>
          <label class="toggle"><input type="checkbox" id="s-perm-activity"><span class="toggle-slider"></span></label>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <div>健康数据共享</div>
            <div class="settings-row-sub" id="s-perm-health-sub"></div>
          </div>
          <label class="toggle"><input type="checkbox" id="s-perm-health-connect"><span class="toggle-slider"></span></label>
        </div>
        <div class="list-item" onclick="askNativeScreenCapture()">
          <span>录屏授权</span>
          <span style="color:var(--text-secondary)">›</span>
        </div>
        <div class="list-item" onclick="openNativeAppSettingsPage()">
          <span>打开系统应用详情</span>
          <span style="color:var(--text-secondary)">›</span>
        </div>
      </div>
    </div>
  `;
}

function setToggle(id, on) {
  const el = document.getElementById(id);
  if (el) el.checked = !!on;
}

function shizukuStatusText(s) {
  const st = s.shizukuState;
  if (st === 'granted') {
    if (s.shizukuUid === 0) return '已授权（root / Sui）';
    return '已授权（ADB/shell）';
  }
  if (st === 'denied') return '已启动，点开关授权';
  if (st === 'stopped') return '已安装但未启动';
  if (st === 'pre_v11') return '版本过旧';
  if (st === 'unsupported') return '系统不支持';
  return '未安装';
}

export async function refreshNativePermissionToggles() {
  if (!window.isNativeShell?.()) return;
  const basic = document.getElementById('s-native-perms-section');
  const adv = document.getElementById('s-native-adv-section');
  if (basic) basic.style.display = '';
  if (adv) adv.style.display = '';
  const s = await getAppPermissionStatus();
  setToggle('s-perm-notify', s.notifications);
  setToggle('s-perm-camera', s.camera);
  setToggle('s-perm-mic', s.microphone);
  setToggle('s-perm-location', s.location);
  setToggle('s-perm-storage', s.storage);
  setToggle('s-perm-battery', s.batteryUnrestricted);
  setToggle('s-perm-listener', s.notificationListener);
  setToggle('s-perm-foreground', s.foreground);
  setToggle('s-perm-overlay', s.overlay);
  setToggle('s-perm-alarm', s.exactAlarm);
  setToggle('s-perm-a11y', s.accessibility);
  setToggle('s-perm-usage', s.usageStats);
  setToggle('s-perm-activity', s.activityRecognition);
  setToggle('s-perm-health-connect', s.healthConnectGranted);
  const healthSub = document.getElementById('s-perm-health-sub');
  if (healthSub) {
    // 状态文案先隐藏，仅写入便于以后恢复展示
    const h = s.health && typeof s.health === 'object' ? s.health : {};
    if (s.healthConnect === 'update') healthSub.textContent = '需要更新健康数据共享';
    else if (s.healthConnect === 'missing') healthSub.textContent = '系统里暂时没有健康数据共享';
    else if (s.healthConnectGranted) {
      const bits = [];
      const steps = h.connectSteps != null ? h.connectSteps : h.todaySteps;
      if (steps != null && steps !== '') bits.push(`步数 ${Math.round(Number(steps))}`);
      if (h.heartRateBpm != null && h.heartRateBpm !== '') bits.push(`心率 ${Math.round(Number(h.heartRateBpm))}`);
      else if (h.heartRateGranted === false) bits.push('未勾心率');
      else if (h.connectSteps != null || h.connectGranted) bits.push('暂无心率');
      healthSub.textContent = bits.join(' · ') || '已授权';
    }
    else healthSub.textContent = '未授权';
  }
  setToggle('s-perm-shizuku', s.shizukuPermission);
  const sub = document.getElementById('s-perm-shizuku-sub');
  if (sub) sub.textContent = shizukuStatusText(s);
}

export function bindNativePermissionToggles() {
  if (!window.isNativeShell?.()) return;
  const basic = document.getElementById('s-native-perms-section');
  const adv = document.getElementById('s-native-adv-section');
  if (basic) basic.style.display = '';
  if (adv) adv.style.display = '';

  const notify = document.getElementById('s-perm-notify');
  const camera = document.getElementById('s-perm-camera');
  const mic = document.getElementById('s-perm-mic');
  const locationPerm = document.getElementById('s-perm-location');
  const storage = document.getElementById('s-perm-storage');
  const battery = document.getElementById('s-perm-battery');
  const listener = document.getElementById('s-perm-listener');
  const foreground = document.getElementById('s-perm-foreground');
  const overlay = document.getElementById('s-perm-overlay');
  const alarm = document.getElementById('s-perm-alarm');
  const a11y = document.getElementById('s-perm-a11y');
  const usage = document.getElementById('s-perm-usage');
  const activity = document.getElementById('s-perm-activity');
  const healthConnect = document.getElementById('s-perm-health-connect');
  const shizuku = document.getElementById('s-perm-shizuku');

  // 避免每次进入权限页重复绑定
  if (basic?.dataset.permBound === '1') {
    refreshNativePermissionToggles();
    return;
  }
  if (basic) basic.dataset.permBound = '1';
  if (adv) adv.dataset.permBound = '1';

  async function reaskOrOpenSettings(checked) {
    if (checked) await requestBasicNativePermissions();
    else {
      window.showToast?.('关掉权限请到系统应用详情里操作');
      await openNativeAppSettings();
    }
    setTimeout(refreshNativePermissionToggles, 600);
  }

  notify?.addEventListener('change', async () => {
    if (notify.checked) {
      await requestAppNotifications();
      await window.requestNotificationPermission?.();
    } else {
      window.showToast?.('关闭通知请到系统应用详情里操作');
      await openNativeAppSettings();
    }
    setTimeout(refreshNativePermissionToggles, 600);
  });
  camera?.addEventListener('change', () => reaskOrOpenSettings(camera.checked));
  mic?.addEventListener('change', () => reaskOrOpenSettings(mic.checked));
  locationPerm?.addEventListener('change', async () => {
    if (locationPerm.checked) await requestNativeLocation();
    else {
      window.showToast?.('关掉权限请到系统应用详情里操作');
      await openNativeAppSettings();
    }
    setTimeout(refreshNativePermissionToggles, 600);
  });
  storage?.addEventListener('change', () => reaskOrOpenSettings(storage.checked));

  battery?.addEventListener('change', async () => {
    if (battery.checked) await requestIgnoreBatteryOptimizations();
    else {
      window.showToast?.('请在系统电池设置里取消无限制');
      await openNativeAppSettings();
    }
    setTimeout(refreshNativePermissionToggles, 800);
  });

  listener?.addEventListener('change', async () => {
    await openNotificationListenerSettings();
    setTimeout(refreshNativePermissionToggles, 800);
  });

  foreground?.addEventListener('change', async () => {
    await setForegroundKeepAlive(foreground.checked);
    setTimeout(refreshNativePermissionToggles, 400);
  });

  overlay?.addEventListener('change', async () => {
    await openOverlaySettings();
    setTimeout(refreshNativePermissionToggles, 800);
  });

  alarm?.addEventListener('change', async () => {
    await openExactAlarmSettings();
    setTimeout(refreshNativePermissionToggles, 800);
  });

  a11y?.addEventListener('change', async () => {
    await openAccessibilitySettings();
    setTimeout(refreshNativePermissionToggles, 800);
  });

  usage?.addEventListener('change', async () => {
    await openUsageAccessSettings();
    setTimeout(refreshNativePermissionToggles, 800);
  });

  activity?.addEventListener('change', async () => {
    if (activity.checked) await requestActivityRecognition();
    else {
      window.showToast?.('关掉请到系统应用详情里操作');
      await openNativeAppSettings();
    }
    setTimeout(refreshNativePermissionToggles, 800);
  });

  healthConnect?.addEventListener('change', async () => {
    if (healthConnect.checked) await requestHealthConnect();
    else await openHealthConnectSettings();
    setTimeout(refreshNativePermissionToggles, 800);
  });

  shizuku?.addEventListener('change', async () => {
    if (!shizuku.checked) {
      await openShizukuApp();
      setTimeout(refreshNativePermissionToggles, 800);
      return;
    }
    try {
      const r = await requestShizuku();
      window.showToast?.(r?.shizukuHint || (r?.shizukuPermission ? 'Shizuku 已授权' : '请按提示完成 Shizuku'));
    } catch (e) {
      window.showToast?.('Shizuku：' + (e?.message || e));
    }
    setTimeout(refreshNativePermissionToggles, 800);
  });

  if (!_nativePermBound) {
    _nativePermBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && document.getElementById('s-native-perms-section')) {
        refreshNativePermissionToggles();
      }
    });
  }
}

export function installNativePermissionGlobals() {
  window.openNativeAppSettingsPage = function() {
    openNativeAppSettings();
  };

  window.reaskBasicNativePermissions = async function() {
    try {
      await requestBasicNativePermissions();
      await requestIgnoreBatteryOptimizations();
      window.showToast?.('已弹出系统询问');
    } catch (e) {
      window.showToast?.('询问失败：' + (e?.message || e));
    }
    setTimeout(refreshNativePermissionToggles, 600);
  };

  window.askNativeScreenCapture = async function() {
    try {
      const r = await requestScreenCapture();
      window.showToast?.(r?.screenCaptureOk ? '录屏已授权（仅这一次）' : '未授权录屏');
    } catch (e) {
      window.showToast?.('录屏询问失败：' + (e?.message || e));
    }
  };

  window.openNativeShizukuApp = function() {
    openShizukuApp();
  };

  window.applyNativeShizukuHelpers = async function() {
    try {
      const r = await applyShizukuHelpers();
      window.showToast?.(r?.shizukuPermission ? '已用 Shizuku 打开高阶项' : '请先打开并授权 Shizuku');
      await refreshNativePermissionToggles();
    } catch (e) {
      window.showToast?.(e?.message || '请先安装、启动并授权 Shizuku');
    }
  };
}

installNativePermissionGlobals();

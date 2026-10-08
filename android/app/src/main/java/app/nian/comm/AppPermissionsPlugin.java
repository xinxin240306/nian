package app.nian.comm;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.KeyguardManager;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.MediaScannerConnection;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.BatteryManager;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

@CapacitorPlugin(
  name = "AppPermissions",
  permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
    @Permission(alias = "microphone", strings = {
      Manifest.permission.RECORD_AUDIO,
      Manifest.permission.MODIFY_AUDIO_SETTINGS
    }),
    @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }),
    @Permission(alias = "bluetoothScan", strings = {
      Manifest.permission.BLUETOOTH_SCAN,
      Manifest.permission.BLUETOOTH_CONNECT
    }),
    @Permission(alias = "photos", strings = {
      Manifest.permission.READ_MEDIA_IMAGES,
      Manifest.permission.READ_MEDIA_VIDEO
    }),
    @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
    @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION }),
    @Permission(alias = "locationFine", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
    @Permission(alias = "locationCoarse", strings = { Manifest.permission.ACCESS_COARSE_LOCATION })
  }
)
public class AppPermissionsPlugin extends Plugin {
  private boolean applyShizukuAfterGrant = false;
  private String pendingToyAction = "";
  private final rikka.shizuku.Shizuku.OnRequestPermissionResultListener shizukuPermListener =
    (requestCode, grantResult) -> {
      if (grantResult == PackageManager.PERMISSION_GRANTED && applyShizukuAfterGrant) {
        applyShizukuAfterGrant = false;
        new Thread(() -> {
          try {
            ShizukuBridge.applyHelpers(getContext());
          } catch (Exception ignored) {}
        }, "nian-shizuku").start();
      }
    };

  @Override
  public void load() {
    NativeCallEngine.setPlugin(this);
    try { StepCounter.start(getContext()); } catch (Exception ignored) {}
    rikka.shizuku.Shizuku.addRequestPermissionResultListener(shizukuPermListener);
    NianNotificationListener.setChangeHook(() -> {
      try {
        notifyListeners("notificationsChanged", new JSObject());
      } catch (Exception ignored) {}
    });
  }

  @Override
  protected void handleOnDestroy() {
    NativeCallEngine.setPlugin(null);
    NativeCallEngine.stop();
    NianNotificationListener.setChangeHook(null);
    rikka.shizuku.Shizuku.removeRequestPermissionResultListener(shizukuPermListener);
    super.handleOnDestroy();
  }

  @PluginMethod
  public void getStatus(PluginCall call) {
    call.resolve(statusObject());
  }

  @PluginMethod
  public void haptic(PluginCall call) {
    final String kind = String.valueOf(call.getString("kind", "press"));
    try {
      Context ctx = getContext();
      Vibrator vibrator;
      if (Build.VERSION.SDK_INT >= 31) {
        VibratorManager vm = ctx.getSystemService(VibratorManager.class);
        vibrator = vm != null ? vm.getDefaultVibrator() : null;
      } else {
        vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
      }
      if (vibrator == null || !vibrator.hasVibrator()) {
        call.resolve();
        return;
      }
      if (Build.VERSION.SDK_INT >= 29) {
        int effect = VibrationEffect.EFFECT_HEAVY_CLICK;
        if ("tick".equals(kind)) effect = VibrationEffect.EFFECT_TICK;
        else if ("click".equals(kind)) effect = VibrationEffect.EFFECT_CLICK;
        vibrator.vibrate(VibrationEffect.createPredefined(effect));
      } else if (Build.VERSION.SDK_INT >= 26) {
        long ms = "tick".equals(kind) ? 12L : 36L;
        vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
      } else {
        vibrator.vibrate("tick".equals(kind) ? 12L : 36L);
      }
    } catch (Exception ignored) {}
    call.resolve();
  }

  @PluginMethod
  public void requestBasic(PluginCall call) {
    List<String> aliases = new ArrayList<>();
    if (Build.VERSION.SDK_INT >= 33) aliases.add("notifications");
    aliases.add("camera");
    aliases.add("microphone");
    if (Build.VERSION.SDK_INT >= 31) aliases.add("bluetooth");
    if (Build.VERSION.SDK_INT >= 33) aliases.add("photos");
    else aliases.add("storage");

    boolean allGranted = true;
    for (String alias : aliases) {
      if (getPermissionState(alias) != PermissionState.GRANTED) {
        allGranted = false;
        break;
      }
    }
    if (allGranted) {
      call.resolve(statusObject());
      return;
    }
    requestPermissionForAliases(aliases.toArray(new String[0]), call, "onBasicPerm");
  }

  @PermissionCallback
  private void onBasicPerm(PluginCall call) {
    call.resolve(statusObject());
  }

  @PluginMethod
  public void requestMicrophone(PluginCall call) {
    boolean micOk = getPermissionState("microphone") == PermissionState.GRANTED;
    boolean btOk = Build.VERSION.SDK_INT < 31 || getPermissionState("bluetooth") == PermissionState.GRANTED;
    if (micOk && btOk) {
      call.resolve(statusObject());
      return;
    }
    if (!micOk && !btOk) {
      requestPermissionForAliases(new String[] { "microphone", "bluetooth" }, call, "onMicPerm");
    } else if (!micOk) {
      requestPermissionForAlias("microphone", call, "onMicPerm");
    } else {
      requestPermissionForAlias("bluetooth", call, "onMicPerm");
    }
  }

  @PermissionCallback
  private void onMicPerm(PluginCall call) {
    call.resolve(statusObject());
  }

  @PluginMethod
  public void requestCamera(PluginCall call) {
    if (getPermissionState("camera") == PermissionState.GRANTED) {
      call.resolve(statusObject());
      return;
    }
    requestPermissionForAlias("camera", call, "onCamPerm");
  }

  @PermissionCallback
  private void onCamPerm(PluginCall call) {
    call.resolve(statusObject());
  }

  @PluginMethod
  public void requestLocation(PluginCall call) {
    if (hasLocationPermission()) {
      call.resolve(statusObject());
      return;
    }
    requestPermissionForAliases(new String[] { "locationFine", "locationCoarse" }, call, "onLocPerm");
  }

  @PermissionCallback
  private void onLocPerm(PluginCall call) {
    call.resolve(statusObject());
  }

  @PluginMethod
  public void getCurrentLocation(PluginCall call) {
    if (!hasLocationPermission()) {
      requestPermissionForAliases(new String[] { "locationFine", "locationCoarse" }, call, "onLocThenGet");
      return;
    }
    fetchLocation(call);
  }

  @PermissionCallback
  private void onLocThenGet(PluginCall call) {
    if (!hasLocationPermission()) {
      call.reject("location_denied");
      return;
    }
    fetchLocation(call);
  }

  @PluginMethod
  public void requestNotifications(PluginCall call) {
    if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
      call.resolve(statusObject());
      return;
    }
    requestPermissionForAlias("notifications", call, "onNotifyPerm");
  }

  @PermissionCallback
  private void onNotifyPerm(PluginCall call) {
    call.resolve(statusObject());
  }

  @PluginMethod
  public void openNotificationListenerSettings(PluginCall call) {
    startSettings(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
    call.resolve(statusObject());
  }

  @PluginMethod
  public void listNotifications(PluginCall call) {
    JSObject o = new JSObject();
    boolean enabled = isNotificationListenerEnabled();
    boolean connected = NianNotificationListener.isConnected();
    o.put("listenerEnabled", enabled);
    o.put("connected", connected);
    o.put("items", NianNotificationListener.listJson(getContext()));
    call.resolve(o);
  }

  @PluginMethod
  public void getDeviceStatus(PluginCall call) {
    // Health Connect 不能在主线程读，放到后台线程再 snapshot
    call.setKeepAlive(true);
    new Thread(() -> {
      try {
        call.resolve(deviceStatusObject());
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "device_status_failed" : e.getMessage());
      }
    }, "nian-device-status").start();
  }

  @PluginMethod
  public void refreshHealth(PluginCall call) {
    call.setKeepAlive(true);
    Context ctx = getContext();
    new Thread(() -> {
      try { HealthConnectBridge.invalidate(); } catch (Exception ignored) {}
      try {
        call.resolve(deviceStatusObject());
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "health_refresh_failed" : e.getMessage());
      }
    }, "nian-health-refresh").start();
  }

  @PluginMethod
  public void dumpScreen(PluginCall call) {
    ScreenShareOverlay.runHidden(() -> {
      JSObject o = new JSObject();
      try {
        boolean enabled = isAccessibilityEnabled();
        boolean connected = NianAccessibilityService.isConnected();
        o.put("accessibilityEnabled", enabled);
        o.put("connected", connected);
        String pkg = NianAccessibilityService.foregroundPackage();
        o.put("package", pkg == null ? "" : pkg);
        o.put("app", appLabel(pkg));
        o.put("tree", connected ? NianAccessibilityService.dumpActiveWindow() : "");
        o.put("targets", connected ? NianAccessibilityService.dumpTargets() : "");
      } catch (Exception ignored) {}
      call.resolve(o);
    });
  }

  @PluginMethod
  public void captureScreen(PluginCall call) {
    if (ScreenShareOverlay.callUsesRearCam()) {
      new Thread(() -> {
        try {
          String data = ScreenShareOverlay.callPreviewDataUrl();
          JSObject o = new JSObject();
          o.put("source", "rear_cam");
          if (data == null || !data.startsWith("data:image") || data.indexOf(',') < 0) {
            o.put("ok", false);
            o.put("error", "rear_cam");
            call.resolve(o);
            return;
          }
          o.put("ok", true);
          o.put("mime", "image/jpeg");
          o.put("imageBase64", data.substring(data.indexOf(',') + 1));
          call.resolve(o);
        } catch (Exception e) {
          JSObject o = new JSObject();
          o.put("ok", false);
          o.put("error", e.getMessage() == null ? "capture_failed" : e.getMessage());
          call.resolve(o);
        }
      }, "nian-screencap").start();
      return;
    }
    if (!ShizukuBridge.hasPermission()) {
      JSObject o = new JSObject();
      o.put("ok", false);
      o.put("error", "no_shizuku");
      call.resolve(o);
      return;
    }
    new Thread(() -> {
      final byte[][] jpegBox = new byte[1][];
      ScreenShareOverlay.runHidden(() -> {
        try {
          jpegBox[0] = ShizukuBridge.captureScreenJpeg(getContext());
        } catch (Exception e) {
          jpegBox[0] = null;
        }
      });
      try {
        byte[] jpeg = jpegBox[0];
        JSObject o = new JSObject();
        if (jpeg == null || jpeg.length < 32) {
          o.put("ok", false);
          o.put("error", "empty");
          call.resolve(o);
          return;
        }
        o.put("ok", true);
        o.put("mime", "image/jpeg");
        o.put("imageBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP));
        call.resolve(o);
      } catch (Exception e) {
        JSObject o = new JSObject();
        o.put("ok", false);
        o.put("error", e.getMessage() == null ? "capture_failed" : e.getMessage());
        call.resolve(o);
      }
    }, "nian-screencap").start();
  }

  private JSObject deviceStatusObject() {
    JSObject o = new JSObject();
    Intent bat = null;
    try {
      IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
      if (Build.VERSION.SDK_INT >= 33) {
        bat = getContext().registerReceiver(null, filter, Context.RECEIVER_NOT_EXPORTED);
      } else {
        bat = getContext().registerReceiver(null, filter);
      }
    } catch (Exception ignored) {}
    int pct = -1;
    boolean charging = false;
    if (bat != null) {
      int level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
      int scale = bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
      if (level >= 0 && scale > 0) pct = Math.round(level * 100f / scale);
      int st = bat.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
      charging = st == BatteryManager.BATTERY_STATUS_CHARGING
        || st == BatteryManager.BATTERY_STATUS_FULL;
    }
    boolean screenOn = true;
    try {
      PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
      if (pm != null) screenOn = pm.isInteractive();
    } catch (Exception ignored) {}
    boolean locked = false;
    try {
      KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
      if (km != null) locked = km.isKeyguardLocked();
    } catch (Exception ignored) {}
    o.put("battery", pct);
    o.put("charging", charging);
    o.put("screenOn", screenOn);
    o.put("locked", locked);
    o.put("inApp", MainActivity.isResumed());
    String fg = NianAccessibilityService.foregroundPackage();
    o.put("package", fg == null ? "" : fg);
    o.put("app", PhoneSense.appLabel(getContext(), fg));
    putNested(o, "usage", PhoneUsage.snapshot(getContext()));
    putNested(o, "health", PhoneHealth.snapshot(getContext()));
    putNested(o, "apps", PhoneApps.snapshot(getContext()));
    return o;
  }

  private void putNested(JSObject o, String key, org.json.JSONObject raw) {
    if (raw == null) return;
    try {
      o.put(key, new JSObject(raw.toString()));
    } catch (Exception ignored) {}
  }

  private String appLabel(String pkg) {
    if (pkg == null || pkg.isEmpty()) return "";
    try {
      PackageManager pm = getContext().getPackageManager();
      return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
    } catch (Exception e) {
      return pkg;
    }
  }

  @PluginMethod
  public void requestIgnoreBatteryOptimizations(PluginCall call) {
    Context ctx = getContext();
    String pkg = ctx.getPackageName();
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isIgnoringBatteryOptimizations(pkg)) {
          call.resolve(statusObject());
          return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + pkg));
        startSettings(intent);
      }
    } catch (Exception e) {
      try {
        startSettings(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
      } catch (Exception ignored) {}
    }
    call.resolve(statusObject());
  }

  @PluginMethod
  public void openUsageAccessSettings(PluginCall call) {
    startSettings(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS));
    call.resolve(statusObject());
  }

  @PluginMethod
  public void requestActivityRecognition(PluginCall call) {
    if (Build.VERSION.SDK_INT < 29 || getPermissionState("activity") == PermissionState.GRANTED) {
      try { StepCounter.start(getContext()); } catch (Exception ignored) {}
      call.resolve(statusObject());
      return;
    }
    requestPermissionForAlias("activity", call, "onActivityPerm");
  }

  @PermissionCallback
  private void onActivityPerm(PluginCall call) {
    try { StepCounter.start(getContext()); } catch (Exception ignored) {}
    call.resolve(statusObject());
  }

  @PluginMethod
  public void requestHealthConnect(PluginCall call) {
    Context ctx = getContext();
    if (!HealthConnectBridge.available(ctx)) {
      String st = HealthConnectBridge.statusName(ctx);
      try {
        if ("update".equals(st)) {
          Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.apps.healthdata"));
          startSettings(market);
        } else {
          startSettings(HealthConnectBridge.settingsIntent());
        }
      } catch (Exception e) {
        try { startSettings(HealthConnectBridge.settingsIntent()); } catch (Exception ignored) {}
      }
      JSObject o = statusObject();
      o.put("healthConnect", st);
      call.resolve(o);
      return;
    }
    Activity act = getActivity();
    if (act == null) {
      call.reject("没有界面，无法申请健康权限");
      return;
    }
    Intent intent;
    try {
      intent = HealthConnectBridge.permissionIntent(act);
    } catch (Exception e) {
      call.reject(e.getMessage() == null ? "无法打开健康权限" : e.getMessage());
      return;
    }
    startActivityForResult(call, intent, "onHealthConnect");
  }

  @ActivityCallback
  private void onHealthConnect(PluginCall call, ActivityResult result) {
    call.setKeepAlive(true);
    Context ctx = getContext();
    new Thread(() -> {
      try { HealthConnectBridge.invalidate(); } catch (Exception ignored) {}
      try { HealthConnectBridge.snapshot(ctx); } catch (Exception ignored) {}
      call.resolve(statusObject());
    }, "nian-health-grant").start();
  }

  @PluginMethod
  public void openHealthConnectSettings(PluginCall call) {
    try {
      startSettings(HealthConnectBridge.settingsIntent());
    } catch (Exception e) {
      startSettings(new Intent(Settings.ACTION_SETTINGS));
    }
    call.resolve(statusObject());
  }

  @PluginMethod
  public void openOverlaySettings(PluginCall call) {
    Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
    intent.setData(Uri.parse("package:" + getContext().getPackageName()));
    startSettings(intent);
    call.resolve(statusObject());
  }

  @PluginMethod
  public void openAccessibilitySettings(PluginCall call) {
    startSettings(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
    call.resolve(statusObject());
  }

  @PluginMethod
  public void setForeground(PluginCall call) {
    boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
    NianBridgePrefs.saveForeground(getContext(), on);
    if (on) KeepAliveService.start(getContext());
    else KeepAliveService.stop(getContext());
    call.resolve(statusObject());
  }

  @PluginMethod
  public void requestScreenCapture(PluginCall call) {
    Activity act = getActivity();
    if (act == null) {
      call.reject("没有界面，无法申请录屏");
      return;
    }
    MediaProjectionManager mpm = (MediaProjectionManager) act.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
    if (mpm == null) {
      call.reject("系统不支持录屏授权");
      return;
    }
    startActivityForResult(call, mpm.createScreenCaptureIntent(), "onScreenCapture");
  }

  @ActivityCallback
  private void onScreenCapture(PluginCall call, ActivityResult result) {
    JSObject o = statusObject();
    o.put("screenCaptureOk", result != null && result.getResultCode() == Activity.RESULT_OK);
    call.resolve(o);
  }

  @PluginMethod
  public void requestShizuku(PluginCall call) {
    JSObject o = statusObject();
    if (Build.VERSION.SDK_INT < 23) {
      o.put("shizukuHint", "当前系统太旧，不支持 Shizuku");
      call.resolve(o);
      return;
    }
    if (!ShizukuBridge.isRunning()) {
      ShizukuBridge.openShizuku(getContext());
      o.put("shizukuHint", ShizukuBridge.isInstalled(getContext())
        ? "请先在 Shizuku 里启动服务（无线调试）"
        : "请先安装 Shizuku 并启动");
      call.resolve(o);
      return;
    }
    try {
      if (rikka.shizuku.Shizuku.isPreV11()) {
        call.reject("Shizuku 版本过旧，请升级到 13 以上");
        return;
      }
      if (ShizukuBridge.hasPermission()) {
        new Thread(() -> {
          try {
            String log = ShizukuBridge.applyHelpers(getContext());
            JSObject done = statusObject();
            done.put("shizukuLog", log);
            call.resolve(done);
          } catch (Exception e) {
            call.reject(e.getMessage() == null ? "提权失败" : e.getMessage());
          }
        }, "nian-shizuku").start();
        return;
      }
      applyShizukuAfterGrant = true;
      ShizukuBridge.requestPermission();
      o.put("shizukuHint", "请在弹出的窗口里允许「念」使用 Shizuku");
      call.resolve(o);
    } catch (Exception e) {
      call.reject(e.getMessage() == null ? "Shizuku 失败" : e.getMessage());
    }
  }

  @PluginMethod
  public void openShizuku(PluginCall call) {
    ShizukuBridge.openShizuku(getContext());
    call.resolve(statusObject());
  }

  @PluginMethod
  public void applyShizukuHelpers(PluginCall call) {
    new Thread(() -> {
      try {
        String log = ShizukuBridge.applyHelpers(getContext());
        JSObject o = statusObject();
        o.put("shizukuLog", log);
        call.resolve(o);
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "提权失败" : e.getMessage());
      }
    }, "nian-shizuku").start();
  }

  @PluginMethod
  public void setBridgeConfig(PluginCall call) {
    String base = call.getString("serverBase", "");
    String token = call.getString("sessionToken", "");
    NianBridgePrefs.save(getContext(), base, token);
    Integer cid = null;
    try { cid = call.getInt("characterId"); } catch (Exception ignored) {}
    if (cid != null && cid > 0) {
      NianBridgePrefs.saveHaloChar(getContext(), cid, call.getString("name", "TA"));
    }
    TogetherWidgetProvider.refreshFromNetwork(getContext(), false);
    call.resolve(statusObject());
  }

  @PluginMethod
  public void syncTogetherWidget(PluginCall call) {
    int characterId = 0;
    try {
      Integer n = call.getInt("characterId");
      if (n != null) characterId = n;
    } catch (Exception ignored) {}
    String name = call.getString("name", "TA");
    String togetherSince = call.getString("togetherSince", "");
    int daysTogether = 0;
    try {
      Integer n = call.getInt("daysTogether");
      if (n != null) daysTogether = n;
    } catch (Exception ignored) {}
    String moodPrimary = call.getString("moodPrimary", "");
    String moodLabel = call.getString("moodLabel", "");
    String moodEmoji = call.getString("moodEmoji", "");
    String activity = call.getString("activity", "");
    boolean asleep = false;
    try { asleep = call.getBoolean("asleep", false); } catch (Exception ignored) {}
    if (characterId <= 0) {
      NianBridgePrefs.clearTogetherSnapshot(getContext());
      TogetherWidgetProvider.updateAll(getContext());
    } else {
      TogetherWidgetProvider.applySnapshot(
        getContext(), characterId, name, togetherSince, daysTogether, moodPrimary, moodLabel, moodEmoji, activity, asleep
      );
      String beanCode = asleep
        ? "睡着"
        : OverlayBeans.resolveWidgetBean(moodPrimary, moodLabel, moodEmoji, activity);
      OverlayBeans.ensureWidgetBean(
        getContext(),
        beanCode,
        () -> {
          Context ctx = getContext();
          if (ctx == null) return;
          int px = Math.round(44f * ctx.getResources().getDisplayMetrics().density);
          if (OverlayBeans.widgetBean(ctx, beanCode, px) != null) {
            TogetherWidgetProvider.updateAll(ctx);
          }
        }
      );
    }
    JSObject o = statusObject();
    o.put("synced", true);
    call.resolve(o);
  }

  @PluginMethod
  public void refreshTogetherWidget(PluginCall call) {
    TogetherWidgetProvider.refreshFromNetwork(getContext(), true);
    call.resolve(statusObject());
  }

  @PluginMethod
  public void pinTogetherWidget(PluginCall call) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      call.reject("系统版本过低，无法添加小组件");
      return;
    }
    AppWidgetManager mgr = AppWidgetManager.getInstance(getContext());
    if (mgr == null || !mgr.isRequestPinAppWidgetSupported()) {
      call.reject("当前桌面不支持直接添加，请长按桌面空白处 → 小组件 → 念 → 在一起");
      return;
    }
    ComponentName provider = new ComponentName(getContext(), TogetherWidgetProvider.class);
    boolean ok = mgr.requestPinAppWidget(provider, null, null);
    JSObject o = statusObject();
    o.put("prompted", ok);
    call.resolve(o);
  }

  @PluginMethod
  public void setHaloCharacter(PluginCall call) {
    int characterId = 0;
    try {
      Integer n = call.getInt("characterId");
      if (n != null) characterId = n;
    } catch (Exception ignored) {}
    NianBridgePrefs.saveHaloChar(getContext(), characterId, call.getString("name", "TA"));
    call.resolve(statusObject());
  }

  @PluginMethod
  public void showIncomingCall(PluginCall call) {
    int characterId = 0;
    try {
      Integer n = call.getInt("characterId");
      if (n != null) characterId = n;
    } catch (Exception ignored) {}
    int logId = 0;
    long ringMs = 35000;
    try {
      Integer n = call.getInt("logId");
      if (n != null) logId = n;
    } catch (Exception ignored) {}
    try {
      Double ms = call.getDouble("ringMs");
      if (ms != null && ms > 0) ringMs = ms.longValue();
    } catch (Exception ignored) {}
    boolean systemRing = Boolean.TRUE.equals(call.getBoolean("systemRing"));
    boolean shown = IncomingCallService.show(
      getContext(),
      characterId,
      call.getString("name", "TA"),
      call.getString("avatar", ""),
      call.getString("content", ""),
      call.getString("ringtone", ""),
      logId,
      ringMs,
      systemRing
    );
    JSObject o = statusObject();
    o.put("shown", shown);
    call.resolve(o);
  }

  @PluginMethod
  public void playCallRing(PluginCall call) {
    boolean systemRing = Boolean.TRUE.equals(call.getBoolean("systemRing"));
    IncomingCallService.playStandaloneRing(getContext(), call.getString("url", ""), systemRing);
    JSObject o = new JSObject();
    o.put("ok", true);
    o.put("systemRing", systemRing);
    call.resolve(o);
  }

  @PluginMethod
  public void stopCallRing(PluginCall call) {
    IncomingCallService.stopStandaloneRing();
    call.resolve(new JSObject());
  }

  @PluginMethod
  public void dismissIncomingCall(PluginCall call) {
    IncomingCallService.dismiss(getContext());
    JSObject o = statusObject();
    o.put("shown", false);
    call.resolve(o);
  }

  @PluginMethod
  public void showCapsule(PluginCall call) {
    int characterId = 0;
    try {
      Integer n = call.getInt("characterId");
      if (n != null) characterId = n;
    } catch (Exception ignored) {}
    JSONArray bubbles = null;
    try {
      JSArray arr = call.getArray("bubbles");
      if (arr != null && arr.length() > 0) bubbles = arr;
    } catch (Exception ignored) {}
    boolean shown = CapsuleOverlay.show(
      getContext(),
      characterId,
      call.getString("name", "TA"),
      call.getString("text", ""),
      call.getString("avatar", ""),
      bubbles
    );
    JSObject o = statusObject();
    o.put("shown", shown);
    call.resolve(o);
  }

  @PluginMethod
  public void goHome(PluginCall call) {
    try {
      Intent home = new Intent(Intent.ACTION_MAIN);
      home.addCategory(Intent.CATEGORY_HOME);
      home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(home);
    } catch (Exception ignored) {}
    call.resolve(statusObject());
  }

  @PluginMethod
  public void openUrl(PluginCall call) {
    String url = call.getString("url", "");
    if (url == null || url.trim().isEmpty()) {
      call.reject("missing url");
      return;
    }
    if (tryStartView(url.trim())) {
      call.resolve();
    } else {
      call.reject("open_failed");
    }
  }

  /** 只打开对方那个点（标注），不走从我的位置出发的导航。 */
  @PluginMethod
  public void openMap(PluginCall call) {
    Double lat = call.getDouble("lat");
    Double lng = call.getDouble("lng");
    Double gcjLat = call.getDouble("gcjLat");
    Double gcjLng = call.getDouble("gcjLng");
    String title = decodeMaybe(call.getString("title", "位置"));
    if (title == null || title.trim().isEmpty() || title.startsWith("%")) title = "位置";
    String address = compactMapAddr(decodeMaybe(call.getString("address", "")));
    if (address.isEmpty()) address = compactMapAddr(title);
    boolean has = lat != null && lng != null
      && !lat.isNaN() && !lng.isNaN()
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    if (has && (gcjLat == null || gcjLng == null || gcjLat.isNaN() || gcjLng.isNaN())) {
      gcjLat = lat;
      gcjLng = lng;
    }

    if (has && gcjLat != null && gcjLng != null) {
      // 有坐标时绝不能走 POI/搜索（那会落在「我附近」）。
      // 优先 HTTPS 标注链：比 viewMap 更能落到具体点，后台高德也不容易停在「我的位置」。
      if (tryStartPin(amapHttpsMarker(title, gcjLat, gcjLng), "com.autonavi.minimap")) {
        call.resolve();
        return;
      }
      if (tryStartPin(amapHttpsMarker(title, gcjLat, gcjLng), null)) {
        call.resolve();
        return;
      }
      if (tryStartPin(amapViewMap("androidamap", title, gcjLat, gcjLng), "com.autonavi.minimap")) {
        call.resolve();
        return;
      }
      if (tryStartPin(amapViewMap("amapuri", title, gcjLat, gcjLng), "com.autonavi.minimap")) {
        call.resolve();
        return;
      }
      if (tryStartPin(amapViewReGeo(gcjLat, gcjLng), "com.autonavi.minimap")) {
        call.resolve();
        return;
      }
      if (tryStartPin(baiduMarker(lat, lng, title, address), "com.baidu.BaiduMap")) {
        call.resolve();
        return;
      }
      // 系统通用 geo: 也会落到坐标，而不是当前位置
      if (tryStartPin(geoMarker(gcjLat, gcjLng, title), null)) {
        call.resolve();
        return;
      }
      call.reject("no_map_app");
      return;
    }
    if (!address.isEmpty() && tryOpenPlace(address)) {
      call.resolve();
      return;
    }
    call.reject("no_map_app");
  }

  private static String decodeMaybe(String raw) {
    String s = raw == null ? "" : raw.trim();
    if (s.isEmpty()) return s;
    try {
      if (s.contains("%")) {
        String d = Uri.decode(s);
        if (d != null && !d.isEmpty()) return d;
      }
    } catch (Exception ignored) {}
    return s;
  }

  private static String compactMapAddr(String raw) {
    String s = raw == null ? "" : raw.trim();
    if (s.isEmpty()) return "";
    s = s.replaceAll("[·•|｜,，\\s]+", "");
    if (s.equals("位置") || s.equals("这里") || s.equals("当前位置")) return "";
    return s;
  }

  private boolean tryOpenPlace(String addr) {
    if (addr == null || addr.isEmpty()) return false;
    if (tryStartView(amapPoi(addr), "com.autonavi.minimap")) return true;
    if (tryStartView(amapHttpsSearch(addr), "com.autonavi.minimap")) return true;
    if (tryStartView(baiduGeocoder(addr), "com.baidu.BaiduMap")) return true;
    return tryStartView(amapHttpsSearch(addr), null);
  }

  private static String amapNonce() {
    return String.valueOf(System.currentTimeMillis());
  }

  private static Uri amapHttpsSearch(String keyword) {
    return Uri.parse("https://uri.amap.com/search").buildUpon()
      .appendQueryParameter("keyword", keyword)
      .appendQueryParameter("src", "nian")
      .appendQueryParameter("callnative", "1")
      .appendQueryParameter("n", amapNonce())
      .build();
  }

  private static Uri baiduGeocoder(String address) {
    return Uri.parse("baidumap://map/geocoder").buildUpon()
      .appendQueryParameter("src", "nian")
      .appendQueryParameter("address", address)
      .build();
  }

  private static Uri amapViewMap(String scheme, String title, double lat, double lng) {
    return Uri.parse(scheme + "://viewMap").buildUpon()
      .appendQueryParameter("sourceApplication", "nian")
      .appendQueryParameter("poiname", title)
      .appendQueryParameter("lat", String.valueOf(lat))
      .appendQueryParameter("lon", String.valueOf(lng))
      .appendQueryParameter("dev", "0")
      .appendQueryParameter("n", amapNonce())
      .build();
  }

  private static Uri amapViewReGeo(double lat, double lng) {
    return Uri.parse("androidamap://viewReGeo").buildUpon()
      .appendQueryParameter("sourceApplication", "nian")
      .appendQueryParameter("lat", String.valueOf(lat))
      .appendQueryParameter("lon", String.valueOf(lng))
      .appendQueryParameter("dev", "0")
      .appendQueryParameter("n", amapNonce())
      .build();
  }

  private static Uri amapPoi(String keyword) {
    return Uri.parse("androidamap://poi").buildUpon()
      .appendQueryParameter("sourceApplication", "nian")
      .appendQueryParameter("keywords", keyword)
      .appendQueryParameter("dev", "0")
      .appendQueryParameter("n", amapNonce())
      .build();
  }

  private static Uri baiduMarker(double lat, double lng, String title, String address) {
    return Uri.parse("baidumap://map/marker").buildUpon()
      .appendQueryParameter("location", lat + "," + lng)
      .appendQueryParameter("title", title)
      .appendQueryParameter("content", address == null || address.isEmpty() ? title : address)
      .appendQueryParameter("coord_type", "wgs84")
      .appendQueryParameter("src", "nian")
      .build();
  }

  private static Uri amapHttpsMarker(String title, double gcjLat, double gcjLng) {
    return Uri.parse("https://uri.amap.com/marker").buildUpon()
      .appendQueryParameter("position", gcjLng + "," + gcjLat)
      .appendQueryParameter("name", title)
      .appendQueryParameter("src", "nian")
      .appendQueryParameter("coordinate", "gaode")
      .appendQueryParameter("callnative", "1")
      .appendQueryParameter("n", amapNonce())
      .build();
  }

  private static Uri geoMarker(double lat, double lng, String title) {
    String label = title == null || title.isEmpty() ? "位置" : title;
    return Uri.parse("geo:" + lat + "," + lng + "?q=" + Uri.encode(lat + "," + lng + "(" + label + ")"));
  }

  private static boolean isAmapTarget(Uri uri, String pkg) {
    if ("com.autonavi.minimap".equals(pkg)) return true;
    if (uri == null) return false;
    String scheme = uri.getScheme();
    if ("androidamap".equals(scheme) || "amapuri".equals(scheme)) return true;
    String host = uri.getHost();
    return host != null && host.endsWith("amap.com");
  }

  private boolean tryStartView(String url) {
    try {
      return tryStartView(Uri.parse(url), null);
    } catch (Exception e) {
      return false;
    }
  }

  /** 打开「某个坐标点」。高德必须清任务，否则 startActivity 成功却仍停在旧的「我的位置」。 */
  private boolean tryStartPin(Uri uri, String pkg) {
    if (uri == null) return false;
    if (isAmapTarget(uri, pkg)) {
      int hard = Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK;
      if (tryStartViewWithFlags(uri, pkg, hard)) return true;
    }
    int soft = Intent.FLAG_ACTIVITY_NEW_TASK
      | Intent.FLAG_ACTIVITY_CLEAR_TOP
      | Intent.FLAG_ACTIVITY_SINGLE_TOP;
    return tryStartViewWithFlags(uri, pkg, soft);
  }

  private boolean tryStartView(Uri uri, String pkg) {
    if (uri == null) return false;
    boolean restartAmap = isAmapTarget(uri, pkg);
    int flags = Intent.FLAG_ACTIVITY_NEW_TASK;
    if (restartAmap) {
      flags |= Intent.FLAG_ACTIVITY_CLEAR_TASK;
    } else {
      flags |= Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP;
    }
    return tryStartViewWithFlags(uri, pkg, flags);
  }

  private boolean tryStartViewWithFlags(Uri uri, String pkg, int flags) {
    if (uri == null) return false;
    try {
      Intent intent = new Intent(Intent.ACTION_VIEW, uri);
      intent.addCategory(Intent.CATEGORY_DEFAULT);
      intent.addFlags(flags);
      if (pkg != null && !pkg.isEmpty()) intent.setPackage(pkg);
      getContext().startActivity(intent);
      return true;
    } catch (Exception e) {
      if (pkg != null) {
        try {
          Intent intent = new Intent(Intent.ACTION_VIEW, uri);
          intent.addCategory(Intent.CATEGORY_DEFAULT);
          intent.addFlags(flags);
          getContext().startActivity(intent);
          return true;
        } catch (Exception ignored) {}
      }
      return false;
    }
  }

  @PluginMethod
  public void showScreenShare(PluginCall call) {
    int characterId = 0;
    try {
      Integer n = call.getInt("characterId");
      if (n != null) characterId = n;
    } catch (Exception ignored) {}
    ScreenShareOverlay.show(getContext(), characterId, call.getString("name", "TA"));
    JSObject o = statusObject();
    o.put("shown", ScreenShareOverlay.isSessionOn());
    call.resolve(o);
  }

  @PluginMethod
  public void controlScreen(PluginCall call) {
    JSONObject cmd = new JSONObject();
    try {
      cmd.put("action", call.getString("action", ""));
      cmd.put("text", call.getString("text", ""));
      if (call.getDouble("x") != null) cmd.put("x", call.getDouble("x"));
      if (call.getDouble("y") != null) cmd.put("y", call.getDouble("y"));
      if (call.getDouble("x2") != null) cmd.put("x2", call.getDouble("x2"));
      if (call.getDouble("y2") != null) cmd.put("y2", call.getDouble("y2"));
      if (call.getInt("durationMs") != null) cmd.put("durationMs", call.getInt("durationMs"));
    } catch (Exception ignored) {}
    new Thread(() -> {
      final JSONObject[] box = new JSONObject[1];
      ScreenShareOverlay.runHidden(() -> box[0] = PhoneApps.control(getContext(), cmd));
      JSONObject r = box[0] != null ? box[0] : new JSONObject();
      try {
        call.resolve(new JSObject(r.toString()));
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "control_failed" : e.getMessage());
      }
    }, "nian-control").start();
  }

  @PluginMethod
  public void setCallOverlay(PluginCall call) {
    boolean on = Boolean.TRUE.equals(call.getBoolean("on"));
    boolean video = Boolean.TRUE.equals(call.getBoolean("video"));
    int characterId = 0;
    try {
      Integer n = call.getInt("characterId");
      if (n != null) characterId = n;
    } catch (Exception ignored) {}
    ScreenShareOverlay.setCallState(
      getContext(),
      on,
      video,
      call.getString("avatar", ""),
      call.getString("clip", ""),
      call.getString("facing", ""),
      characterId,
      call.getString("name", "TA")
    );
    String phase = call.getString("phase", "");
    if (phase != null && !phase.trim().isEmpty()) {
      ScreenShareOverlay.setCallPhase(phase);
    } else if (call.getBoolean("speaking") != null) {
      ScreenShareOverlay.setCallSpeaking(Boolean.TRUE.equals(call.getBoolean("speaking")));
    }
    JSObject o = statusObject();
    o.put("callOn", ScreenShareOverlay.isCallOn());
    call.resolve(o);
  }

  @PluginMethod
  public void setCallMediaAudio(PluginCall call) {
    boolean on = Boolean.TRUE.equals(call.getBoolean("on"));
    if (on && Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED) {
      requestPermissionForAlias("bluetooth", call, "onBtForCallAudio");
      return;
    }
    applyCallAudio(call, on);
  }

  @PermissionCallback
  private void onBtForCallAudio(PluginCall call) {
    applyCallAudio(call, true);
  }

  private void applyCallAudio(PluginCall call, boolean on) {
    Context ctx = getContext();
    if (on) {
      CallAudioRoute.preferCall(ctx, () -> call.resolve(callAudioStatus(ctx, true)));
      return;
    }
    if (!NativeCallEngine.isRunning()) {
      CallAudioRoute.release(ctx);
    }
    call.resolve(callAudioStatus(ctx, false));
  }

  private JSObject callAudioStatus(Context ctx, boolean on) {
    JSObject o = statusObject();
    o.put("mediaAudio", on);
    o.put("headsetInput", CallAudioRoute.hasHeadsetInput(ctx));
    o.put("scoOn", CallAudioRoute.isScoOn(ctx));
    o.put("route", CallAudioRoute.currentRoute());
    o.put("nativeCall", NativeCallEngine.isRunning());
    return o;
  }

  void emitCallLevel(double rms) {
    JSObject o = new JSObject();
    o.put("rms", rms);
    notifyListeners("callLevel", o);
  }

  @PluginMethod
  public void startNativeCall(PluginCall call) {
    if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED) {
      requestPermissionForAlias("bluetooth", call, "onBtForNativeCall");
      return;
    }
    bootNativeCall(call);
  }

  @PermissionCallback
  private void onBtForNativeCall(PluginCall call) {
    bootNativeCall(call);
  }

  private void bootNativeCall(PluginCall call) {
    Context ctx = getContext();
    NativeCallEngine.setPlugin(this);
    CallAudioRoute.preferCall(ctx, () -> {
      String err = NativeCallEngine.start(ctx);
      if (err != null) {
        call.reject(err);
        return;
      }
      // 首开时再绑一次耳机输入，避免 SCO 刚连上时 AudioRecord 仍落在手机麦
      if (CallAudioRoute.isHeadsetRouted() || CallAudioRoute.isScoOn(ctx)) {
        NativeCallEngine.rebindMic();
      }
      call.resolve(callAudioStatus(ctx, true));
    });
  }

  @PluginMethod
  public void stopNativeCall(PluginCall call) {
    NativeCallEngine.stop();
    CallAudioRoute.release(getContext());
    call.resolve(callAudioStatus(getContext(), false));
  }

  @PluginMethod
  public void setNativeCallListen(PluginCall call) {
    boolean on = Boolean.TRUE.equals(call.getBoolean("on"));
    boolean ambient = Boolean.TRUE.equals(call.getBoolean("ambient"));
    boolean bargeIn = Boolean.TRUE.equals(call.getBoolean("bargeIn"));
    boolean wantAmbient = on && ambient;
    // ambient 切换会换采集源 / AEC·NS，才需要重绑；否则每次 listen=true 重绑会清空正在录的一句
    boolean ambientChanged = NativeCallEngine.isAmbientListen() != wantAmbient;
    NativeCallEngine.setAmbientListen(wantAmbient);
    NativeCallEngine.setBargeInEnabled(on && bargeIn);
    if (!on) {
      NativeCallEngine.setBargeInEnabled(false);
      NativeCallEngine.setListen(false);
      NativeCallEngine.setAmbientSampleIntervalMs(0);
      JSObject o = new JSObject();
      o.put("listen", false);
      o.put("ambient", false);
      call.resolve(o);
      return;
    }
    Context ctx = getContext();
    CallAudioRoute.ensureMicRoute(ctx, () -> {
      if (!NativeCallEngine.hasHealthyRecord() || ambientChanged) {
        NativeCallEngine.rebindMic();
      }
      NativeCallEngine.setListen(true);
      JSObject o = new JSObject();
      o.put("listen", true);
      o.put("ambient", NativeCallEngine.isAmbientListen());
      o.put("route", CallAudioRoute.currentRoute());
      o.put("scoOn", CallAudioRoute.isScoOn(ctx));
      o.put("headsetInput", CallAudioRoute.hasHeadsetInput(ctx));
      call.resolve(o);
    });
  }

  @PluginMethod
  public void getNativeCallLevel(PluginCall call) {
    JSObject o = new JSObject();
    o.put("rms", NativeCallEngine.level());
    o.put("listen", NativeCallEngine.isRunning());
    call.resolve(o);
  }

  @PluginMethod
  public void noteCallListenTick(PluginCall call) {
    Double silenceBox = call.getDouble("silenceMs", 3000d);
    Double maxBox = call.getDouble("maxMs", 20000d);
    Double speechBox = call.getDouble("speechRms", 0.02d);
    int silenceMs = silenceBox != null ? silenceBox.intValue() : 3000;
    int maxMs = maxBox != null ? maxBox.intValue() : 20000;
    double speech = speechBox != null ? speechBox : 0.02d;
    NativeCallEngine.noteJsTick(silenceMs, maxMs, speech);
    NativeCallEngine.pumpAmbientSampleWatch();
    JSObject o = new JSObject();
    o.put("rms", NativeCallEngine.level());
    call.resolve(o);
  }

  /** 连麦周期环境采样间隔（毫秒）。锁屏后靠原生墙钟，不靠 WebView setTimeout。 */
  @PluginMethod
  public void setNativeCallAmbientSample(PluginCall call) {
    Double box = call.getDouble("intervalMs", 0d);
    long intervalMs = box != null ? Math.max(0L, box.longValue()) : 0L;
    NativeCallEngine.setAmbientSampleIntervalMs(intervalMs);
    JSObject o = new JSObject();
    o.put("intervalMs", intervalMs);
    call.resolve(o);
  }

  @PluginMethod
  public void ackNativeCallAmbientSample(PluginCall call) {
    NativeCallEngine.ackAmbientSample();
    call.resolve(new JSObject());
  }

  @PluginMethod
  public void beginNativeCallUtterance(PluginCall call) {
    NativeCallEngine.beginUtterance();
    call.resolve(new JSObject());
  }

  @PluginMethod
  public void abortNativeCallUtterance(PluginCall call) {
    NativeCallEngine.abortUtterance();
    call.resolve(new JSObject());
  }

  @PluginMethod
  public void commitNativeCallUtterance(PluginCall call) {
    byte[] wav = NativeCallEngine.commitUtterance();
    JSObject o = new JSObject();
    o.put("bytes", wav.length);
    o.put("mime", "audio/wav");
    o.put("durationSec", NativeCallEngine.wavDurationSec(wav, NativeCallEngine.currentRate()));
    o.put("base64", wav.length > 0 ? NativeCallEngine.wavBase64(wav) : "");
    call.resolve(o);
  }

  /** 聊天播角色语音前：闪避后台音乐（不独占掐停） */
  @PluginMethod
  public void duckMediaForSpeech(PluginCall call) {
    SpeechMediaDuck.duck(getContext());
    JSObject o = new JSObject();
    o.put("ok", true);
    call.resolve(o);
  }

  @PluginMethod
  public void unduckMediaAfterSpeech(PluginCall call) {
    SpeechMediaDuck.unduck(getContext());
    JSObject o = new JSObject();
    o.put("ok", true);
    call.resolve(o);
  }

  /** 聊天语音：原生播放；其它 App 音乐闪避，不改系统媒体音量 */
  @PluginMethod
  public void playSpeechUrl(PluginCall call) {
    String url = call.getString("url", "");
    float gain = playGainOf(call);
    SpeechMediaDuck.playUrl(getContext(), url, gain, ok -> {
      if (ok) {
        JSObject o = new JSObject();
        o.put("ok", true);
        call.resolve(o);
      } else {
        call.reject("play_failed");
      }
    });
  }

  @PluginMethod
  public void playSpeechData(PluginCall call) {
    String b64 = call.getString("base64", "");
    String mime = call.getString("mime", "audio/mpeg");
    if (b64 == null || b64.isEmpty()) {
      call.reject("empty_audio");
      return;
    }
    byte[] data;
    try {
      data = Base64.decode(b64, Base64.DEFAULT);
    } catch (Exception e) {
      call.reject("bad_base64");
      return;
    }
    float gain = playGainOf(call);
    SpeechMediaDuck.playBytes(getContext(), data, mime, gain, ok -> {
      if (ok) {
        JSObject o = new JSObject();
        o.put("ok", true);
        call.resolve(o);
      } else {
        call.reject("play_failed");
      }
    });
  }

  @PluginMethod
  public void stopSpeechPlay(PluginCall call) {
    SpeechMediaDuck.stopPlay();
    SpeechMediaDuck.reset(getContext());
    JSObject o = new JSObject();
    o.put("ok", true);
    call.resolve(o);
  }

  @PluginMethod
  public void playNativeCallUrl(PluginCall call) {
    String url = call.getString("url", "");
    float gain = playGainOf(call);
    NativeCallEngine.play(url, gain, ok -> {
      if (ok) {
        JSObject o = new JSObject();
        o.put("ok", true);
        call.resolve(o);
      } else {
        call.reject("play_failed");
      }
    });
  }

  @PluginMethod
  public void playNativeCallData(PluginCall call) {
    String b64 = call.getString("base64", "");
    String mime = call.getString("mime", "audio/mpeg");
    if (b64 == null || b64.isEmpty()) {
      call.reject("empty_audio");
      return;
    }
    byte[] data;
    try {
      data = Base64.decode(b64, Base64.DEFAULT);
    } catch (Exception e) {
      call.reject("bad_base64");
      return;
    }
    float gain = playGainOf(call);
    NativeCallEngine.playBytes(data, mime, gain, ok -> {
      if (ok) {
        JSObject o = new JSObject();
        o.put("ok", true);
        call.resolve(o);
      } else {
        call.reject("play_failed");
      }
    });
  }

  private static float playGainOf(PluginCall call) {
    Double v = call.getDouble("volume");
    if (v == null) return 1f;
    float g = v.floatValue();
    if (!(g > 0f)) return 1f;
    // 通话里角色声音容易觉得小：允许 0.05～2.0 的内部增益。
    // MediaPlayer.setVolume 接受 0~1（>1 在某些机型无效），超过 1 时
    // 走 adjustStreamVolume 临时把媒体音量推到合适的档位。
    return Math.max(0.05f, Math.min(2f, g));
  }

  @PluginMethod
  public void stopNativeCallPlay(PluginCall call) {
    NativeCallEngine.stopPlay();
    call.resolve(new JSObject());
  }

  @PluginMethod
  public void playNativeCallBed(PluginCall call) {
    String url = call.getString("url", "");
    Double v = call.getDouble("volume");
    float gain = v != null && v > 0 ? Math.max(0.02f, Math.min(1f, v.floatValue())) : 0.35f;
    NativeCallEngine.playBed(url, gain);
    JSObject o = new JSObject();
    o.put("ok", true);
    call.resolve(o);
  }

  @PluginMethod
  public void stopNativeCallBed(PluginCall call) {
    NativeCallEngine.stopBed();
    JSObject o = new JSObject();
    o.put("ok", true);
    call.resolve(o);
  }

  @PluginMethod
  public void setCallPreviewFrame(PluginCall call) {
    ScreenShareOverlay.setCallPreviewDataUrl(call.getString("imageDataUrl", ""));
    call.resolve(statusObject());
  }

  @PluginMethod
  public void hideScreenShare(PluginCall call) {
    ScreenShareOverlay.hide();
    call.resolve(statusObject());
  }

  @PluginMethod
  public void hideCapsule(PluginCall call) {
    CapsuleOverlay.hide();
    call.resolve(statusObject());
  }

  @PluginMethod
  public void openExactAlarmSettings(PluginCall call) {
    Intent i = NianAlarms.exactAlarmSettingsIntent(getContext());
    if (i != null) startSettings(i);
    call.resolve(statusObject());
  }

  @PluginMethod
  public void handleAlarm(PluginCall call) {
    JSONObject cmd = new JSONObject();
    try {
      cmd.put("action", call.getString("action", "set"));
      cmd.put("id", call.getInt("id") == null ? 0 : call.getInt("id"));
      cmd.put("hour", call.getInt("hour") == null ? -1 : call.getInt("hour"));
      cmd.put("minute", call.getInt("minute") == null ? -1 : call.getInt("minute"));
      cmd.put("dayOffset", call.getInt("dayOffset") == null ? 0 : call.getInt("dayOffset"));
      cmd.put("tomorrow", Boolean.TRUE.equals(call.getBoolean("tomorrow")));
      cmd.put("when", call.getString("when", ""));
      cmd.put("repeat", call.getString("repeat", "once"));
      cmd.put("label", call.getString("label", ""));
      cmd.put("speech", call.getString("speech", ""));
      cmd.put("audioUrl", call.getString("audioUrl", ""));
      cmd.put("name", call.getString("name", ""));
      cmd.put("characterId", call.getInt("characterId") == null ? 0 : call.getInt("characterId"));
    } catch (Exception ignored) {}
    new Thread(() -> {
      try {
        JSONObject r = NianAlarms.handle(getContext(), cmd);
        JSObject o = new JSObject();
        o.put("ok", r.optBoolean("ok", false));
        o.put("error", r.optString("error", ""));
        o.put("alarmId", r.optInt("alarmId", 0));
        o.put("when", r.optLong("when", 0));
        o.put("hasVoice", r.optBoolean("hasVoice", false));
        if (r.has("enabled")) o.put("enabled", r.optBoolean("enabled", false));
        JSONArray alarms = r.optJSONArray("alarms");
        if (alarms != null) o.put("alarms", alarms.toString());
        call.resolve(o);
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "alarm_failed" : e.getMessage());
      }
    }, "nian-alarm").start();
  }

  @PluginMethod
  public void saveDownload(PluginCall call) {
    final String filenameRaw = call.getString("filename", "nian-backup.json");
    final String text = call.getString("text", "");
    final String mime = call.getString("mime", "application/json");
    if (filenameRaw == null || filenameRaw.isEmpty()) {
      call.reject("no_filename");
      return;
    }
    new Thread(() -> {
      try {
        String filename = sanitizeFilename(filenameRaw);
        String mimeType = mime == null || mime.isEmpty() ? "application/json" : mime;
        byte[] bytes = (text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
        if (Build.VERSION.SDK_INT >= 29) {
          ContentValues values = new ContentValues();
          values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
          values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
          values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/念");
          values.put(MediaStore.Downloads.IS_PENDING, 1);
          Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
          if (uri == null) throw new Exception("downloads_insert_failed");
          try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
            if (os == null) throw new Exception("downloads_open_failed");
            os.write(bytes);
          }
          values.clear();
          values.put(MediaStore.Downloads.IS_PENDING, 0);
          getContext().getContentResolver().update(uri, values, null, null);
        } else {
          File root = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
          File dir = new File(root, "念");
          if (!dir.exists() && !dir.mkdirs()) throw new Exception("downloads_mkdir_failed");
          File dest = uniqueFile(dir, filename);
          try (FileOutputStream os = new FileOutputStream(dest)) {
            os.write(bytes);
          }
          MediaScannerConnection.scanFile(
            getContext(),
            new String[] { dest.getAbsolutePath() },
            new String[] { mimeType },
            null
          );
        }
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("filename", filename);
        call.resolve(o);
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "save_failed" : e.getMessage());
      }
    }, "nian-save").start();
  }

  /** 把图片/视频写入系统相册（Pictures/Movies·念），语音进 Download。WebView 假下载救不了。 */
  @PluginMethod
  public void saveToGallery(PluginCall call) {
    final String filenameRaw = call.getString("filename", "nian-media");
    final String mimeRaw = call.getString("mime", "");
    final String url = call.getString("url", "");
    final String base64 = call.getString("base64", "");
    final JSObject headers = call.getObject("headers");
    if (filenameRaw == null || filenameRaw.isEmpty()) {
      call.reject("no_filename");
      return;
    }
    if ((url == null || url.isEmpty()) && (base64 == null || base64.isEmpty())) {
      call.reject("no_data");
      return;
    }
    new Thread(() -> {
      try {
        String filename = sanitizeFilename(filenameRaw);
        String mime = resolveMime(mimeRaw, filename);
        String kind = mediaKind(mime);
        String collection = "downloads";
        if ("image".equals(kind)) collection = "images";
        else if ("video".equals(kind)) collection = "video";
        else if ("audio".equals(kind)) collection = "audio";

        if (Build.VERSION.SDK_INT >= 29) {
          ContentValues values = new ContentValues();
          values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
          values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
          values.put(MediaStore.MediaColumns.IS_PENDING, 1);
          Uri collectionUri;
          if ("image".equals(kind)) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/念");
            collectionUri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
          } else if ("video".equals(kind)) {
            values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/念");
            collectionUri = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
          } else if ("audio".equals(kind)) {
            values.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/念");
            collectionUri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
          } else {
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/念");
            collectionUri = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
          }
          Uri uri = getContext().getContentResolver().insert(collectionUri, values);
          if (uri == null) throw new Exception("gallery_insert_failed");
          try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
            if (os == null) throw new Exception("gallery_open_failed");
            writeGalleryBytes(os, url, base64, headers);
          }
          values.clear();
          values.put(MediaStore.MediaColumns.IS_PENDING, 0);
          getContext().getContentResolver().update(uri, values, null, null);
        } else {
          String dirType = Environment.DIRECTORY_DOWNLOADS;
          if ("image".equals(kind)) dirType = Environment.DIRECTORY_PICTURES;
          else if ("video".equals(kind)) dirType = Environment.DIRECTORY_MOVIES;
          else if ("audio".equals(kind)) dirType = Environment.DIRECTORY_MUSIC;
          File root = Environment.getExternalStoragePublicDirectory(dirType);
          File dir = new File(root, "念");
          if (!dir.exists() && !dir.mkdirs()) throw new Exception("gallery_mkdir_failed");
          File dest = uniqueFile(dir, filename);
          try (FileOutputStream os = new FileOutputStream(dest)) {
            writeGalleryBytes(os, url, base64, headers);
          }
          MediaScannerConnection.scanFile(
            getContext(),
            new String[] { dest.getAbsolutePath() },
            new String[] { mime },
            null
          );
        }
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("filename", filename);
        o.put("mime", mime);
        o.put("collection", collection);
        call.resolve(o);
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "gallery_save_failed" : e.getMessage());
      }
    }, "nian-gallery").start();
  }

  private static String sanitizeFilename(String name) {
    String n = name == null ? "nian-media" : name.trim();
    n = n.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_");
    if (n.isEmpty()) n = "nian-media";
    if (n.length() > 80) {
      int dot = n.lastIndexOf('.');
      String ext = dot > 0 ? n.substring(dot) : "";
      n = n.substring(0, Math.min(60, n.length())) + ext;
    }
    return n;
  }

  private static String resolveMime(String mime, String filename) {
    if (mime != null && !mime.isEmpty() && !"application/octet-stream".equals(mime)) return mime;
    String ext = "";
    int dot = filename.lastIndexOf('.');
    if (dot >= 0 && dot < filename.length() - 1) ext = filename.substring(dot + 1).toLowerCase();
    String fromExt = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
    if (fromExt != null && !fromExt.isEmpty()) return fromExt;
    if ("jpg".equals(ext) || "jpeg".equals(ext)) return "image/jpeg";
    if ("png".equals(ext)) return "image/png";
    if ("webp".equals(ext)) return "image/webp";
    if ("gif".equals(ext)) return "image/gif";
    if ("mp4".equals(ext) || "m4v".equals(ext)) return "video/mp4";
    if ("webm".equals(ext)) return "video/webm";
    if ("mp3".equals(ext)) return "audio/mpeg";
    if ("m4a".equals(ext)) return "audio/mp4";
    if ("wav".equals(ext)) return "audio/wav";
    return mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
  }

  private static String mediaKind(String mime) {
    String m = mime == null ? "" : mime.toLowerCase();
    if (m.startsWith("image/")) return "image";
    if (m.startsWith("video/")) return "video";
    if (m.startsWith("audio/")) return "audio";
    return "file";
  }

  private static File uniqueFile(File dir, String filename) {
    File dest = new File(dir, filename);
    if (!dest.exists()) return dest;
    int dot = filename.lastIndexOf('.');
    String stem = dot > 0 ? filename.substring(0, dot) : filename;
    String ext = dot > 0 ? filename.substring(dot) : "";
    for (int i = 2; i < 1000; i++) {
      File alt = new File(dir, stem + "-" + i + ext);
      if (!alt.exists()) return alt;
    }
    return new File(dir, stem + "-" + System.currentTimeMillis() + ext);
  }

  private void writeGalleryBytes(OutputStream os, String url, String base64, JSObject headers) throws Exception {
    if (url != null && !url.trim().isEmpty()) {
      streamUrlTo(os, url.trim(), headers);
      return;
    }
    String b64 = base64 == null ? "" : base64.trim();
    int comma = b64.indexOf(',');
    if (b64.startsWith("data:") && comma > 0) b64 = b64.substring(comma + 1);
    byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
    if (bytes == null || bytes.length == 0) throw new Exception("empty_base64");
    os.write(bytes);
  }

  private void streamUrlTo(OutputStream os, String urlStr, JSObject headers) throws Exception {
    URL url = new URL(urlStr);
    HttpURLConnection c = (HttpURLConnection) url.openConnection();
    try {
      c.setRequestMethod("GET");
      c.setConnectTimeout(15000);
      c.setReadTimeout(5 * 60 * 1000);
      c.setInstanceFollowRedirects(true);
      String token = NianBridgePrefs.sessionToken(getContext());
      if (token != null && !token.isEmpty()) {
        c.setRequestProperty("X-Nian-Session", token);
      }
      if (headers != null) {
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
          String k = keys.next();
          if (k == null || k.isEmpty()) continue;
          String v = headers.optString(k, null);
          if (v != null) c.setRequestProperty(k, v);
        }
      }
      int code = c.getResponseCode();
      if (code >= 400) throw new Exception("http_" + code);
      try (InputStream in = c.getInputStream()) {
        if (in == null) throw new Exception("empty_body");
        byte[] buf = new byte[8192];
        int n;
        long total = 0;
        while ((n = in.read(buf)) >= 0) {
          os.write(buf, 0, n);
          total += n;
        }
        if (total <= 0) throw new Exception("empty_download");
      }
    } finally {
      c.disconnect();
    }
  }

  @PluginMethod
  public void openAppSettings(PluginCall call) {
    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
    intent.setData(Uri.parse("package:" + getContext().getPackageName()));
    startSettings(intent);
    call.resolve(statusObject());
  }

  @PluginMethod
  public void toyStatus(PluginCall call) {
    call.resolve(jsFromJson(BobobeiBle.snapshotJson(getContext())));
  }

  @PluginMethod
  public void toyScan(PluginCall call) {
    if (!hasToyBt()) {
      pendingToyAction = "scan";
      requestToyBt(call);
      return;
    }
    runToyScan(call);
  }

  @PluginMethod
  public void toyConnect(PluginCall call) {
    if (!hasToyBt()) {
      pendingToyAction = "connect";
      requestToyBt(call);
      return;
    }
    runToyConnect(call);
  }

  @PluginMethod
  public void toyDisconnect(PluginCall call) {
    call.setKeepAlive(true);
    BobobeiBle.get(getContext()).disconnect();
    handler().postDelayed(() -> call.resolve(jsFromJson(BobobeiBle.snapshotJson(getContext()))), 400);
  }

  @PluginMethod
  public void toyApply(PluginCall call) {
    JSONObject cmd = new JSONObject();
    try {
      cmd.put("action", call.getString("action", "set"));
      if (call.getData().has("suction")) cmd.put("suction", call.getInt("suction", 0));
      if (call.getData().has("vibration")) cmd.put("vibration", call.getInt("vibration", 0));
      if (call.getData().has("electric")) cmd.put("electric", call.getInt("electric", 0));
      if (call.getData().has("duration")) cmd.put("duration", call.getDouble("duration", 0.0));
      if (call.getData().has("ramp")) cmd.put("ramp", call.getDouble("ramp", 0.0));
      if (call.getData().has("steps")) {
        JSArray arr = call.getArray("steps");
        if (arr != null) cmd.put("steps", arr);
      }
    } catch (Exception ignored) {}
    JSONObject r = BobobeiBle.get(getContext()).apply(cmd);
    call.resolve(jsFromJson(r));
  }

  private android.os.Handler handler() {
    return new android.os.Handler(android.os.Looper.getMainLooper());
  }

  private boolean hasToyBt() {
    if (Build.VERSION.SDK_INT >= 31) return granted("bluetoothScan");
    return hasLocationPermission();
  }

  private void requestToyBt(PluginCall call) {
    if (Build.VERSION.SDK_INT >= 31) {
      requestPermissionForAliases(new String[] { "bluetoothScan" }, call, "onToyBtPerm");
    } else {
      requestPermissionForAliases(new String[] { "locationFine" }, call, "onToyBtPerm");
    }
  }

  @PermissionCallback
  private void onToyBtPerm(PluginCall call) {
    if (!hasToyBt()) {
      JSObject o = new JSObject();
      o.put("ok", false);
      o.put("error", "need_bt");
      call.resolve(o);
      pendingToyAction = "";
      return;
    }
    if ("scan".equals(pendingToyAction)) runToyScan(call);
    else if ("connect".equals(pendingToyAction)) runToyConnect(call);
    else call.resolve(jsFromJson(BobobeiBle.snapshotJson(getContext())));
    pendingToyAction = "";
  }

  private void runToyScan(PluginCall call) {
    call.setKeepAlive(true);
    BobobeiBle.get(getContext()).scan(10000, devices -> {
      JSObject o = jsFromJson(BobobeiBle.snapshotJson(getContext()));
      o.put("ok", true);
      call.resolve(o);
    });
  }

  private void runToyConnect(PluginCall call) {
    call.setKeepAlive(true);
    String addr = call.getString("address", "");
    String name = call.getString("name", "");
    BobobeiBle.get(getContext()).connect(addr, name, status -> {
      JSObject o = jsFromJson(status);
      o.put("ok", status.optBoolean("ready") || status.optBoolean("connected"));
      call.resolve(o);
    });
  }

  private JSObject jsFromJson(JSONObject o) {
    try {
      return o == null ? new JSObject() : new JSObject(o.toString());
    } catch (Exception e) {
      return new JSObject();
    }
  }

  private void startSettings(Intent intent) {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(intent);
  }

  private JSObject statusObject() {
    JSObject o = new JSObject();
    Context ctx = getContext();
    o.put("notifications", Build.VERSION.SDK_INT < 33 || granted("notifications"));
    o.put("camera", granted("camera"));
    o.put("microphone", granted("microphone"));
    o.put("bluetooth", Build.VERSION.SDK_INT < 31 || granted("bluetooth"));
    o.put("storage", Build.VERSION.SDK_INT >= 33 ? granted("photos") : granted("storage"));
    o.put("location", hasLocationPermission());
    o.put("batteryUnrestricted", isIgnoringBattery());
    o.put("notificationListener", isNotificationListenerEnabled());
    o.put("notificationListenerConnected", NianNotificationListener.isConnected());
    o.put("overlay", Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(getContext()));
    o.put("usageStats", PhoneUsage.granted(getContext()));
    o.put("activityRecognition", StepCounter.activityGranted(getContext()));
    o.put("healthConnect", HealthConnectBridge.statusName(getContext()));
    o.put("healthConnectGranted", HealthConnectBridge.grantedLight(getContext()));
    putNested(o, "health", PhoneHealth.snapshot(getContext()));
    o.put("accessibility", isAccessibilityEnabled());
    o.put("accessibilityConnected", NianAccessibilityService.isConnected());
    o.put("foreground", KeepAliveService.running);
    putNested(o, "toy", BobobeiBle.snapshotJson(getContext()));
    o.put("exactAlarm", NianAlarms.canExact(getContext()));
    o.put("callOn", ScreenShareOverlay.isCallOn());
    o.put("activeCallCharId", NianBridgePrefs.activeCallCharId(ctx));
    o.put("activeCallName", NianBridgePrefs.activeCallName(ctx));
    o.put("activeCallVideo", NianBridgePrefs.activeCallVideo(ctx));
    o.put("activeCallStartedAt", NianBridgePrefs.activeCallStartedAt(ctx));
    ShizukuBridge.putStatus(o, getContext());
    return o;
  }

  private boolean granted(String alias) {
    return getPermissionState(alias) == PermissionState.GRANTED;
  }

  private boolean hasLocationPermission() {
    Context ctx = getContext();
    if (ctx == null) return false;
    return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
      || ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
  }

  @SuppressLint("MissingPermission")
  private Location pickLastKnown(LocationManager lm) {
    Location best = null;
    String[] providers = {
      LocationManager.GPS_PROVIDER,
      LocationManager.NETWORK_PROVIDER,
      LocationManager.PASSIVE_PROVIDER
    };
    for (String provider : providers) {
      try {
        Location loc = lm.getLastKnownLocation(provider);
        if (loc == null) continue;
        if (best == null || loc.getTime() > best.getTime()) best = loc;
      } catch (SecurityException ignored) {
      } catch (Exception ignored) {}
    }
    return best;
  }

  private void resolveLocation(PluginCall call, Location loc) {
    JSObject o = new JSObject();
    o.put("ok", true);
    o.put("latitude", loc.getLatitude());
    o.put("longitude", loc.getLongitude());
    o.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : 0);
    call.resolve(o);
  }

  @SuppressLint("MissingPermission")
  private void fetchLocation(PluginCall call) {
    Context ctx = getContext();
    LocationManager lm = ctx == null ? null : (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
    if (lm == null) {
      call.reject("no_location_service");
      return;
    }

    boolean gpsOn = false;
    boolean netOn = false;
    try {
      gpsOn = lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
    } catch (Exception ignored) {}
    try {
      netOn = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    } catch (Exception ignored) {}

    if (!gpsOn && !netOn) {
      call.reject("location_off");
      return;
    }

    Location cached = pickLastKnown(lm);
    if (cached != null && System.currentTimeMillis() - cached.getTime() < 90_000) {
      resolveLocation(call, cached);
      return;
    }

    Handler handler = new Handler(Looper.getMainLooper());
    final boolean[] done = { false };
    LocationListener listener = new LocationListener() {
      @Override
      public void onLocationChanged(Location location) {
        if (done[0] || location == null) return;
        done[0] = true;
        try { lm.removeUpdates(this); } catch (Exception ignored) {}
        handler.removeCallbacksAndMessages(null);
        resolveLocation(call, location);
      }

      @Override
      public void onStatusChanged(String provider, int status, android.os.Bundle extras) {}

      @Override
      public void onProviderEnabled(String provider) {}

      @Override
      public void onProviderDisabled(String provider) {}
    };

    Runnable timeout = () -> {
      if (done[0]) return;
      done[0] = true;
      try { lm.removeUpdates(listener); } catch (Exception ignored) {}
      if (cached != null) {
        resolveLocation(call, cached);
      } else {
        call.reject("location_timeout");
      }
    };

    try {
      if (gpsOn) {
        lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0, listener, Looper.getMainLooper());
      }
      if (netOn) {
        lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 0, 0, listener, Looper.getMainLooper());
      }
      handler.postDelayed(timeout, 18000);
    } catch (SecurityException e) {
      call.reject("location_denied");
    } catch (Exception e) {
      if (cached != null) resolveLocation(call, cached);
      else call.reject(e.getMessage() == null ? "location_failed" : e.getMessage());
    }
  }

  private boolean isNotificationListenerEnabled() {
    String pkg = getContext().getPackageName();
    String flat = Settings.Secure.getString(
      getContext().getContentResolver(),
      "enabled_notification_listeners"
    );
    return flat != null && flat.contains(pkg);
  }

  private boolean isAccessibilityEnabled() {
    String pkg = getContext().getPackageName();
    String enabled = Settings.Secure.getString(
      getContext().getContentResolver(),
      Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
    );
    return enabled != null && enabled.contains(pkg);
  }

  private boolean isIgnoringBattery() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
    PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
    return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
  }
}

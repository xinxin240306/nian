package app.nian.comm;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** 通知栏 / 电量 / 读屏 / 截屏，给保活服务和插件共用。 */
final class PhoneSense {
  private PhoneSense() {}

  static boolean overlayGranted(Context ctx) {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx);
  }

  static boolean isNotificationListenerEnabled(Context ctx) {
    String pkg = ctx.getPackageName();
    String flat = Settings.Secure.getString(ctx.getContentResolver(), "enabled_notification_listeners");
    return flat != null && flat.contains(pkg);
  }

  static boolean isAccessibilityEnabled(Context ctx) {
    String pkg = ctx.getPackageName();
    String enabled = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
    return enabled != null && enabled.contains(pkg);
  }

  static JSONObject deviceJson(Context ctx) {
    JSONObject o = new JSONObject();
    try {
      Intent bat;
      IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
      if (Build.VERSION.SDK_INT >= 33) {
        bat = ctx.registerReceiver(null, filter, Context.RECEIVER_NOT_EXPORTED);
      } else {
        bat = ctx.registerReceiver(null, filter);
      }
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
      PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
      if (pm != null) screenOn = pm.isInteractive();
      boolean locked = false;
      try {
        KeyguardManager km = (KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
        if (km != null) locked = km.isKeyguardLocked();
      } catch (Exception ignored) {}
      o.put("battery", pct);
      o.put("charging", charging);
      o.put("screenOn", screenOn);
      o.put("locked", locked);
      o.put("inApp", MainActivity.isResumed());
      o.put("call", ScreenShareOverlay.callJson());
      String fg = NianAccessibilityService.foregroundPackage();
      o.put("package", fg == null ? "" : fg);
      o.put("app", appLabel(ctx, fg));
    } catch (Exception ignored) {}
    return o;
  }

  static JSONObject notificationsBody(Context ctx) {
    JSONObject o = new JSONObject();
    try {
      o.put("listenerEnabled", isNotificationListenerEnabled(ctx));
      o.put("connected", NianNotificationListener.isConnected());
      JSONArray items = new JSONArray(NianNotificationListener.listJson(ctx).toString());
      o.put("items", items);
      o.put("device", deviceJson(ctx));
      o.put("usage", PhoneUsage.snapshot(ctx));
      o.put("health", PhoneHealth.snapshot(ctx));
      o.put("apps", PhoneApps.snapshot(ctx));
    } catch (Exception e) {
      try {
        o.put("listenerEnabled", isNotificationListenerEnabled(ctx));
        o.put("connected", NianNotificationListener.isConnected());
        o.put("items", new JSONArray());
        o.put("device", deviceJson(ctx));
        o.put("usage", PhoneUsage.snapshot(ctx));
        o.put("health", PhoneHealth.snapshot(ctx));
        o.put("apps", PhoneApps.snapshot(ctx));
      } catch (Exception ignored) {}
    }
    return o;
  }

  static JSONObject dumpWindow(Context ctx) {
    JSONObject o = new JSONObject();
    boolean enabled = isAccessibilityEnabled(ctx);
    boolean connected = NianAccessibilityService.isConnected();
    String pkg = NianAccessibilityService.foregroundPackage();
    try {
      o.put("accessibilityEnabled", enabled);
      o.put("connected", connected);
      o.put("package", pkg == null ? "" : pkg);
      o.put("app", appLabel(ctx, pkg));
      o.put("tree", connected ? NianAccessibilityService.dumpActiveWindow() : "");
      o.put("targets", connected ? NianAccessibilityService.dumpTargets() : "");
    } catch (Exception ignored) {}
    return o;
  }

  static String captureJpegDataUrl(Context ctx) {
    try {
      if (!ShizukuBridge.hasPermission()) return "";
      byte[] jpeg = ShizukuBridge.captureScreenJpeg(ctx);
      if (jpeg == null || jpeg.length < 32) return "";
      return "data:image/jpeg;base64," + Base64.encodeToString(jpeg, Base64.NO_WRAP);
    } catch (Exception e) {
      return "";
    }
  }

  static String appLabel(Context ctx, String pkg) {
    if (pkg == null || pkg.isEmpty()) return "";
    try {
      PackageManager pm = ctx.getPackageManager();
      return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
    } catch (Exception e) {
      return pkg;
    }
  }

  static JSONObject currentLocation(Context ctx) {
    JSONObject o = new JSONObject();
    try {
      if (ctx == null) {
        o.put("ok", false);
        o.put("error", "no_context");
        return o;
      }
      boolean fine = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
        == PackageManager.PERMISSION_GRANTED;
      boolean coarse = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
        == PackageManager.PERMISSION_GRANTED;
      if (!fine && !coarse) {
        o.put("ok", false);
        o.put("error", "location_denied");
        return o;
      }
      LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
      if (lm == null) {
        o.put("ok", false);
        o.put("error", "unavailable");
        return o;
      }
      boolean gpsOn = false;
      boolean netOn = false;
      try { gpsOn = lm.isProviderEnabled(LocationManager.GPS_PROVIDER); } catch (Exception ignored) {}
      try { netOn = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER); } catch (Exception ignored) {}
      if (!gpsOn && !netOn) {
        o.put("ok", false);
        o.put("error", "location_off");
        return o;
      }
      Location best = pickLastKnown(lm);
      long now = System.currentTimeMillis();
      boolean fresh = best != null && now - best.getTime() < 180_000;
      // 三分钟内的粗点（基站）常常把人从家里甩到隔壁街区，仍等一次更准的
      boolean tight = best != null && accuracyOf(best) <= 120f;
      if (fresh && tight) {
        putLocation(o, best, false);
        return o;
      }
      Location newer = waitForFix(lm, gpsOn, netOn);
      Location chosen = betterFix(newer, best) ? newer : best;
      if (chosen != null) {
        putLocation(o, chosen, chosen == best && !fresh);
        return o;
      }
      o.put("ok", false);
      o.put("error", "timeout");
    } catch (SecurityException e) {
      try { o.put("ok", false); o.put("error", "location_denied"); } catch (Exception ignored) {}
    } catch (Exception e) {
      try { o.put("ok", false); o.put("error", "unavailable"); } catch (Exception ignored) {}
    }
    return o;
  }

  private static float accuracyOf(Location loc) {
    if (loc == null || !loc.hasAccuracy()) return 5000f;
    float a = loc.getAccuracy();
    return a > 0f ? a : 5000f;
  }

  /** 同样新鲜时用更准的。基站点更新更勤，但不能盖过刚拿到的 GPS。 */
  private static boolean betterFix(Location cand, Location cur) {
    if (cand == null) return false;
    if (cur == null) return true;
    float accC = accuracyOf(cand);
    float accU = accuracyOf(cur);
    long now = System.currentTimeMillis();
    long ageC = now - cand.getTime();
    long ageU = now - cur.getTime();
    if (accC + 80f < accU && ageC < 15 * 60_000L) return true;
    if (accU + 80f < accC && ageU < 15 * 60_000L) return false;
    return cand.getTime() > cur.getTime();
  }

  @android.annotation.SuppressLint("MissingPermission")
  private static Location pickLastKnown(LocationManager lm) {
    Location best = null;
    String[] providers = {
      LocationManager.GPS_PROVIDER,
      LocationManager.NETWORK_PROVIDER,
      LocationManager.PASSIVE_PROVIDER
    };
    for (String provider : providers) {
      try {
        Location loc = lm.getLastKnownLocation(provider);
        if (betterFix(loc, best)) best = loc;
      } catch (Exception ignored) {}
    }
    return best;
  }

  @android.annotation.SuppressLint("MissingPermission")
  private static Location waitForFix(LocationManager lm, boolean gpsOn, boolean netOn) {
    final Location[] got = { null };
    final CountDownLatch latch = new CountDownLatch(1);
    final LocationListener listener = new LocationListener() {
      @Override public void onLocationChanged(Location location) {
        if (location == null) return;
        if (betterFix(location, got[0])) got[0] = location;
        // 楼里先到的往往是误差几百米的基站点，等到更准的或超时再用
        if (accuracyOf(location) <= 80f) latch.countDown();
      }
      @Override public void onStatusChanged(String provider, int status, android.os.Bundle extras) {}
      @Override public void onProviderEnabled(String provider) {}
      @Override public void onProviderDisabled(String provider) {}
    };
    Handler handler = new Handler(Looper.getMainLooper());
    handler.post(() -> {
      try {
        if (netOn) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 0, 0, listener, Looper.getMainLooper());
        if (gpsOn) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0, listener, Looper.getMainLooper());
      } catch (Exception e) {
        latch.countDown();
      }
    });
    try { latch.await(8, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
    try { lm.removeUpdates(listener); } catch (Exception ignored) {}
    return got[0];
  }

  private static void putLocation(JSONObject o, Location loc, boolean stale) throws Exception {
    o.put("ok", true);
    o.put("latitude", loc.getLatitude());
    o.put("longitude", loc.getLongitude());
    o.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : 0);
    o.put("stale", stale);
  }
}

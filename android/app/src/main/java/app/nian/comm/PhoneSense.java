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
      if (best != null && System.currentTimeMillis() - best.getTime() < 180_000) {
        putLocation(o, best, false);
        return o;
      }
      Location fresh = waitForFix(lm, gpsOn, netOn);
      if (fresh != null) {
        putLocation(o, fresh, false);
        return o;
      }
      if (best != null) {
        putLocation(o, best, true);
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
        if (loc == null) continue;
        if (best == null || loc.getTime() > best.getTime()) best = loc;
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
        got[0] = location;
        latch.countDown();
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

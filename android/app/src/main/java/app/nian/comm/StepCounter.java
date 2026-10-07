package app.nian.comm;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import org.json.JSONObject;
import java.util.Calendar;

/**
 * 手机硬件计步器（开机累计步数）。不是小米健康 / 微信运动。
 * 用当天 0 点的读数做差，得到「今天走了多少」。
 */
final class StepCounter {
  private static final String PREF = "nian_steps";
  private static final String KEY_DAY = "day";
  private static final String KEY_BASE = "base";
  private static SensorEventListener listener;
  private static volatile boolean supported;
  static volatile int sinceBoot = -1;

  private StepCounter() {}

  static synchronized void start(Context ctx) {
    Context app = ctx.getApplicationContext();
    SensorManager sm = (SensorManager) app.getSystemService(Context.SENSOR_SERVICE);
    if (sm == null) {
      supported = false;
      return;
    }
    Sensor sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
    if (sensor == null) {
      supported = false;
      return;
    }
    supported = true;
    if (listener != null) return;
    listener = new SensorEventListener() {
      @Override
      public void onSensorChanged(SensorEvent event) {
        if (event == null || event.values == null || event.values.length == 0) return;
        int n = Math.round(event.values[0]);
        if (n < 0) return;
        sinceBoot = n;
        rollBaseline(app, n);
      }

      @Override
      public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    };
    try {
      sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL);
    } catch (Exception e) {
      listener = null;
      supported = false;
    }
  }

  static boolean activityGranted(Context ctx) {
    if (Build.VERSION.SDK_INT < 29) return true;
    try {
      return ctx.checkSelfPermission(android.Manifest.permission.ACTIVITY_RECOGNITION)
        == PackageManager.PERMISSION_GRANTED;
    } catch (Exception e) {
      return false;
    }
  }

  static JSONObject snapshot(Context ctx) {
    JSONObject o = new JSONObject();
    try {
      boolean granted = activityGranted(ctx);
      o.put("supported", supported);
      o.put("granted", granted);
      if (!supported) {
        o.put("todaySteps", JSONObject.NULL);
        o.put("sinceBoot", JSONObject.NULL);
        return o;
      }
      if (!granted) {
        o.put("todaySteps", JSONObject.NULL);
        o.put("sinceBoot", JSONObject.NULL);
        return o;
      }
      int boot = sinceBoot;
      o.put("sinceBoot", boot >= 0 ? boot : JSONObject.NULL);
      Integer today = todaySteps(ctx, boot);
      o.put("todaySteps", today == null ? JSONObject.NULL : today);
    } catch (Exception ignored) {}
    return o;
  }

  private static synchronized void rollBaseline(Context ctx, int sinceBootNow) {
    SharedPreferences p = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    String today = dayKey();
    String stored = p.getString(KEY_DAY, "");
    if (!today.equals(stored)) {
      p.edit().putString(KEY_DAY, today).putInt(KEY_BASE, sinceBootNow).apply();
    }
  }

  private static Integer todaySteps(Context ctx, int boot) {
    if (boot < 0) return null;
    SharedPreferences p = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    String today = dayKey();
    String stored = p.getString(KEY_DAY, "");
    if (!today.equals(stored)) {
      p.edit().putString(KEY_DAY, today).putInt(KEY_BASE, boot).apply();
      return 0;
    }
    int base = p.getInt(KEY_BASE, boot);
    return Math.max(0, boot - base);
  }

  private static String dayKey() {
    Calendar c = Calendar.getInstance();
    return c.get(Calendar.YEAR) + "-" + (c.get(Calendar.MONTH) + 1) + "-" + c.get(Calendar.DAY_OF_MONTH);
  }
}

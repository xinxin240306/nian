package app.nian.comm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.util.Calendar;

/** 角色帮用户设的闹钟：存在本地，用 AlarmClock 准点响，铃声是事先下好的角色语音。 */
final class NianAlarms {
  private static final String TAG = "NianAlarms";
  private static final String PREF = "nian_alarms";
  private static final String KEY_ITEMS = "items";
  static final String EXTRA_ID = "nian_alarm_id";
  static final String EXTRA_SNOOZE = "nian_alarm_snooze";

  private NianAlarms() {}

  static JSONObject handle(Context ctx, JSONObject cmd) {
    JSONObject out = new JSONObject();
    try {
      String action = cmd.optString("action", "set");
      if ("list".equals(action)) {
        out.put("ok", true);
        out.put("alarms", listSummary(ctx));
        return out;
      }
      if ("enable".equals(action) || "disable".equals(action)) {
        int id = cmd.optInt("id", 0);
        if (id <= 0) {
          out.put("ok", false);
          out.put("error", "no_id");
          return out;
        }
        boolean on = "enable".equals(action);
        if (on && !canExact(ctx)) {
          out.put("ok", false);
          out.put("error", "exact_alarm_off");
          return out;
        }
        boolean ok = setEnabled(ctx, id, on);
        out.put("ok", ok);
        out.put("alarmId", id);
        out.put("enabled", on && ok);
        if (!ok) out.put("error", "not_found");
        return out;
      }
      if ("cancel".equals(action)) {
        int id = cmd.optInt("id", 0);
        if (id <= 0) {
          out.put("ok", false);
          out.put("error", "no_id");
          return out;
        }
        cancel(ctx, id);
        out.put("ok", true);
        out.put("alarmId", id);
        return out;
      }
      if (!canExact(ctx)) {
        out.put("ok", false);
        out.put("error", "exact_alarm_off");
        return out;
      }
      JSONObject item = buildItem(ctx, cmd);
      if (item == null) {
        out.put("ok", false);
        out.put("error", "bad_time");
        return out;
      }
      String audioUrl = cmd.optString("audioUrl", "");
      if (!audioUrl.isEmpty()) {
        File dest = audioFile(ctx, item.getInt("id"));
        try {
          PhoneHttp.download(ctx, audioUrl, dest);
          item.put("audioPath", dest.getAbsolutePath());
        } catch (Exception e) {
          Log.w(TAG, "download voice", e);
          try { dest.delete(); } catch (Exception ignored) {}
        }
      }
      saveItem(ctx, item);
      long when = schedule(ctx, item, 0);
      out.put("ok", true);
      out.put("alarmId", item.getInt("id"));
      out.put("when", when);
      out.put("hour", item.optInt("hour"));
      out.put("minute", item.optInt("minute"));
      out.put("repeat", item.optString("repeat", "once"));
      out.put("hasVoice", new File(item.optString("audioPath", "")).isFile());
      out.put("label", item.optString("label", ""));
      out.put("speech", item.optString("speech", ""));
      out.put("name", item.optString("name", ""));
      return out;
    } catch (Exception e) {
      try {
        out.put("ok", false);
        out.put("error", e.getMessage() == null ? "failed" : e.getMessage());
      } catch (Exception ignored) {}
      return out;
    }
  }

  static boolean canExact(Context ctx) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
    AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
    return am != null && am.canScheduleExactAlarms();
  }

  static Intent exactAlarmSettingsIntent(Context ctx) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null;
    Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
    i.setData(Uri.parse("package:" + ctx.getPackageName()));
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    return i;
  }

  static JSONArray listSummary(Context ctx) {
    JSONArray out = new JSONArray();
    JSONArray items = loadAll(ctx);
    long now = System.currentTimeMillis();
    for (int i = 0; i < items.length(); i++) {
      JSONObject it = items.optJSONObject(i);
      if (it == null) continue;
      try {
        JSONObject row = new JSONObject();
        boolean enabled = it.optBoolean("enabled", true);
        row.put("id", it.optInt("id"));
        row.put("hour", it.optInt("hour"));
        row.put("minute", it.optInt("minute"));
        row.put("repeat", it.optString("repeat", "once"));
        row.put("label", it.optString("label", ""));
        row.put("name", it.optString("name", ""));
        row.put("enabled", enabled);
        row.put("hasVoice", new File(it.optString("audioPath", "")).isFile());
        // 桌面闹钟列表不返回 speech，避免泄露角色台词
        if (enabled) {
          long next = nextTrigger(it, 0, false);
          if (next > now) row.put("when", next);
        }
        out.put(row);
      } catch (Exception ignored) {}
    }
    return out;
  }

  /** 开关闹钟：关掉保留语音文件，方便再次打开。 */
  static boolean setEnabled(Context ctx, int id, boolean enabled) {
    JSONObject item = get(ctx, id);
    if (item == null) return false;
    try { item.put("enabled", enabled); } catch (Exception ignored) {}
    if (enabled) {
      try {
        schedule(ctx, item, 0);
      } catch (Exception e) {
        Log.w(TAG, "enable", e);
        try { item.put("enabled", false); } catch (Exception ignored) {}
        saveItem(ctx, item);
        return false;
      }
    } else {
      saveItem(ctx, item);
      cancelPending(ctx, id);
    }
    return true;
  }

  static JSONObject get(Context ctx, int id) {
    JSONArray items = loadAll(ctx);
    for (int i = 0; i < items.length(); i++) {
      JSONObject it = items.optJSONObject(i);
      if (it != null && it.optInt("id") == id) return it;
    }
    return null;
  }

  static void onFired(Context ctx, int id, boolean snooze) {
    if (snooze) snooze(ctx, id);
  }

  static void dismiss(Context ctx, int id) {
    NianAlarmService.stop(ctx);
    JSONObject item = get(ctx, id);
    if (item == null) return;
    if ("daily".equals(item.optString("repeat", "once"))) {
      schedule(ctx, item, 0);
      return;
    }
    try { item.put("enabled", false); } catch (Exception ignored) {}
    saveItem(ctx, item);
    cancelPending(ctx, id);
  }

  static void snooze(Context ctx, int id) {
    NianAlarmService.stop(ctx);
    JSONObject item = get(ctx, id);
    if (item == null) return;
    schedule(ctx, item, 5 * 60 * 1000L);
  }

  static void rescheduleAll(Context ctx) {
    JSONArray items = loadAll(ctx);
    for (int i = 0; i < items.length(); i++) {
      JSONObject it = items.optJSONObject(i);
      if (it == null || !it.optBoolean("enabled", true)) continue;
      try {
        schedule(ctx, it, 0);
      } catch (Exception e) {
        Log.w(TAG, "reschedule", e);
      }
    }
  }

  static void cancel(Context ctx, int id) {
    JSONObject item = get(ctx, id);
    if (item != null) {
      try { item.put("enabled", false); } catch (Exception ignored) {}
      saveItem(ctx, item);
    }
    cancelPending(ctx, id);
    File f = audioFile(ctx, id);
    if (f.exists()) {
      // keep file in case a ringing instance still needs it; delete later
      try { f.delete(); } catch (Exception ignored) {}
    }
  }

  static File audioFile(Context ctx, int id) {
    File dir = new File(ctx.getFilesDir(), "alarms");
    if (!dir.exists()) dir.mkdirs();
    return new File(dir, id + ".mp3");
  }

  static Uri playUri(Context ctx, JSONObject item) {
    String path = item == null ? "" : item.optString("audioPath", "");
    if (!path.isEmpty()) {
      File f = new File(path);
      if (f.isFile() && f.length() > 80) return Uri.fromFile(f);
    }
    Uri alarm = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
    if (alarm != null) return alarm;
    return RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
  }

  private static JSONObject buildItem(Context ctx, JSONObject cmd) throws Exception {
    int hour = cmd.optInt("hour", -1);
    int minute = cmd.optInt("minute", -1);
    String whenStr = cmd.optString("when", "").trim();
    if ((hour < 0 || minute < 0) && whenStr.matches("\\d{1,2}:\\d{2}")) {
      String[] p = whenStr.split(":");
      hour = Integer.parseInt(p[0]);
      minute = Integer.parseInt(p[1]);
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    int id = cmd.optInt("id", 0);
    if (id <= 0) id = nextId(ctx);
    JSONObject item = new JSONObject();
    item.put("id", id);
    item.put("hour", hour);
    item.put("minute", minute);
    item.put("repeat", "daily".equals(cmd.optString("repeat")) ? "daily" : "once");
    item.put("label", cmd.optString("label", "").trim());
    item.put("speech", cmd.optString("speech", "").trim());
    item.put("name", cmd.optString("name", "").trim());
    item.put("characterId", cmd.optInt("characterId", 0));
    item.put("dayOffset", Math.max(0, cmd.optInt("dayOffset", cmd.optBoolean("tomorrow") ? 1 : 0)));
    item.put("enabled", true);
    item.put("audioPath", audioFile(ctx, id).getAbsolutePath());
    return item;
  }

  private static int nextId(Context ctx) {
    int id = (int) (System.currentTimeMillis() % 800000000L) + 20000;
    while (get(ctx, id) != null) id++;
    return id;
  }

  static long nextTrigger(JSONObject item, long snoozeMs) {
    return nextTrigger(item, snoozeMs, true);
  }

  static long nextTrigger(JSONObject item, long snoozeMs, boolean consumeOffset) {
    if (snoozeMs > 0) return System.currentTimeMillis() + snoozeMs;
    int hour = item.optInt("hour");
    int minute = item.optInt("minute");
    int dayOffset = item.optInt("dayOffset", 0);
    Calendar c = Calendar.getInstance();
    c.set(Calendar.HOUR_OF_DAY, hour);
    c.set(Calendar.MINUTE, minute);
    c.set(Calendar.SECOND, 0);
    c.set(Calendar.MILLISECOND, 0);
    if (dayOffset > 0) {
      c.add(Calendar.DAY_OF_YEAR, dayOffset);
      if (consumeOffset) {
        try { item.put("dayOffset", 0); } catch (Exception ignored) {}
      }
    } else if (c.getTimeInMillis() <= System.currentTimeMillis() + 8000) {
      c.add(Calendar.DAY_OF_YEAR, 1);
    }
    return c.getTimeInMillis();
  }

  static long schedule(Context ctx, JSONObject item, long snoozeMs) {
    int id = item.optInt("id");
    long when = nextTrigger(item, snoozeMs);
    try { item.put("nextAt", when); } catch (Exception ignored) {}
    if (snoozeMs == 0) saveItem(ctx, item);
    AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
    if (am == null) return when;
    PendingIntent show = pendingActivity(ctx, id);
    PendingIntent trigger = pendingBroadcast(ctx, id);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      am.setAlarmClock(new AlarmManager.AlarmClockInfo(when, show), trigger);
    } else {
      am.setExact(AlarmManager.RTC_WAKEUP, when, trigger);
    }
    return when;
  }

  private static void cancelPending(Context ctx, int id) {
    AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
    if (am != null) am.cancel(pendingBroadcast(ctx, id));
  }

  private static PendingIntent pendingBroadcast(Context ctx, int id) {
    Intent i = new Intent(ctx, NianAlarmReceiver.class);
    i.putExtra(EXTRA_ID, id);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
    return PendingIntent.getBroadcast(ctx, id, i, flags);
  }

  private static PendingIntent pendingActivity(Context ctx, int id) {
    Intent i = new Intent(ctx, NianAlarmActivity.class);
    i.putExtra(EXTRA_ID, id);
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
    return PendingIntent.getActivity(ctx, id, i, flags);
  }

  private static JSONArray loadAll(Context ctx) {
    try {
      String raw = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_ITEMS, "[]");
      return new JSONArray(raw);
    } catch (Exception e) {
      return new JSONArray();
    }
  }

  private static void saveAll(Context ctx, JSONArray items) {
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_ITEMS, items.toString())
      .apply();
  }

  private static void saveItem(Context ctx, JSONObject item) {
    int id = item.optInt("id");
    JSONArray items = loadAll(ctx);
    JSONArray next = new JSONArray();
    boolean replaced = false;
    for (int i = 0; i < items.length(); i++) {
      JSONObject it = items.optJSONObject(i);
      if (it != null && it.optInt("id") == id) {
        next.put(item);
        replaced = true;
      } else if (it != null) {
        next.put(it);
      }
    }
    if (!replaced) next.put(item);
    saveAll(ctx, next);
  }
}

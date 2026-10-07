package app.nian.comm;

import android.app.AppOpsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Process;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** 系统「使用情况访问」：各 App 今天/昨天/近 7 天前台时长。 */
final class PhoneUsage {
  private PhoneUsage() {}

  static boolean granted(Context ctx) {
    try {
      AppOpsManager ops = (AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
      if (ops == null) return false;
      int mode = ops.checkOpNoThrow(
        AppOpsManager.OPSTR_GET_USAGE_STATS,
        Process.myUid(),
        ctx.getPackageName()
      );
      return mode == AppOpsManager.MODE_ALLOWED;
    } catch (Exception e) {
      return false;
    }
  }

  static JSONObject snapshot(Context ctx) {
    JSONObject o = new JSONObject();
    boolean ok = granted(ctx);
    try {
      o.put("granted", ok);
      if (!ok) {
        o.put("todayMinutes", 0);
        o.put("yesterdayMinutes", 0);
        o.put("weekMinutes", 0);
        o.put("today", new JSONArray());
        o.put("yesterday", new JSONArray());
        o.put("week", new JSONArray());
        return o;
      }
      long now = System.currentTimeMillis();
      long todayStart = startOfDay(now, 0);
      long yStart = startOfDay(now, -1);
      long weekStart = startOfDay(now, -6);
      Range today = query(ctx, todayStart, now, 12);
      Range yest = query(ctx, yStart, todayStart, 8);
      Range week = query(ctx, weekStart, now, 8);
      o.put("todayMinutes", today.totalMin);
      o.put("yesterdayMinutes", yest.totalMin);
      o.put("weekMinutes", week.totalMin);
      o.put("today", today.apps);
      o.put("yesterday", yest.apps);
      o.put("week", week.apps);
    } catch (Exception ignored) {}
    return o;
  }

  private static long startOfDay(long now, int dayOffset) {
    Calendar c = Calendar.getInstance();
    c.setTimeInMillis(now);
    c.set(Calendar.HOUR_OF_DAY, 0);
    c.set(Calendar.MINUTE, 0);
    c.set(Calendar.SECOND, 0);
    c.set(Calendar.MILLISECOND, 0);
    c.add(Calendar.DAY_OF_YEAR, dayOffset);
    return c.getTimeInMillis();
  }

  private static Range query(Context ctx, long start, long end, int limit) {
    Range out = new Range();
    UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
    if (usm == null) return out;
    Map<String, UsageStats> map;
    try {
      map = usm.queryAndAggregateUsageStats(start, end);
    } catch (Exception e) {
      return out;
    }
    if (map == null || map.isEmpty()) return out;
    PackageManager pm = ctx.getPackageManager();
    String self = ctx.getPackageName();
    List<Row> rows = new ArrayList<>();
    long now = System.currentTimeMillis();
    for (UsageStats st : map.values()) {
      if (st == null) continue;
      String pkg = st.getPackageName();
      if (pkg == null || pkg.isEmpty()) continue;
      if (skipPackage(pkg, self)) continue;
      long ms = st.getTotalTimeInForeground();
      if (Build.VERSION.SDK_INT >= 29) {
        try {
          long vis = st.getTotalTimeVisible();
          if (vis > ms) ms = vis;
        } catch (Exception ignored) {}
      }
      if (ms < 30_000) continue;
      int min = Math.max(1, Math.round(ms / 60000f));
      long last = st.getLastTimeUsed();
      Integer lastAgo = last > 0 ? Math.max(0, (int) ((now - last) / 60000L)) : null;
      rows.add(new Row(label(pm, pkg), pkg, min, lastAgo));
      out.totalMin += min;
    }
    Collections.sort(rows, (a, b) -> Integer.compare(b.minutes, a.minutes));
    int n = Math.min(limit, rows.size());
    for (int i = 0; i < n; i++) {
      Row r = rows.get(i);
      try {
        JSONObject item = new JSONObject();
        item.put("app", r.app);
        item.put("package", r.pkg);
        item.put("minutes", r.minutes);
        if (r.lastAgoMin != null) item.put("lastAgoMin", r.lastAgoMin);
        out.apps.put(item);
      } catch (Exception ignored) {}
    }
    return out;
  }

  private static boolean skipPackage(String pkg, String self) {
    if (pkg.equals("android") || pkg.equals("com.android.systemui")) return true;
    if (pkg.startsWith("com.android.providers.")) return true;
    if (pkg.equals("com.google.android.gms") || pkg.equals("com.google.android.gsf")) return true;
    if (pkg.equals("com.miui.securitycenter") || pkg.equals("com.samsung.android.lool")) return true;
    return false;
  }

  private static String label(PackageManager pm, String pkg) {
    try {
      ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
      CharSequence name = pm.getApplicationLabel(ai);
      if (name != null && name.length() > 0) {
        String s = name.toString().trim();
        if (s.length() > 40) s = s.substring(0, 40);
        return s;
      }
    } catch (Exception ignored) {}
    return pkg;
  }

  private static final class Range {
    int totalMin;
    final JSONArray apps = new JSONArray();
  }

  private static final class Row {
    final String app;
    final String pkg;
    final int minutes;
    final Integer lastAgoMin;
    Row(String app, String pkg, int minutes, Integer lastAgoMin) {
      this.app = app;
      this.pkg = pkg;
      this.minutes = minutes;
      this.lastAgoMin = lastAgoMin;
    }
  }
}

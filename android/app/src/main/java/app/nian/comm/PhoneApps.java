package app.nian.comm;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/** 桌面上能打开的应用：列表 + 按名字拉起。不需要无障碍。 */
final class PhoneApps {
  private static final long CACHE_MS = 10 * 60 * 1000;
  private static volatile long cacheAt;
  private static volatile JSONArray cacheItems = new JSONArray();

  private PhoneApps() {}

  static JSONObject control(Context ctx, JSONObject cmd) {
    JSONObject r;
    String action = cmd == null ? "" : cmd.optString("action", "").trim();
    if ("open".equals(action) || "launch".equals(action)) {
      r = launch(ctx, cmd.optString("text", ""));
      if (r.optBoolean("ok", false)) {
        try { Thread.sleep(700); } catch (InterruptedException ignored) {}
      }
      try {
        r.put("accessibility", NianAccessibilityService.isConnected());
        if (NianAccessibilityService.isConnected()) {
          String pkg = NianAccessibilityService.foregroundPackage();
          if (pkg != null && !pkg.isEmpty()) r.put("package", pkg);
          r.put("tree", NianAccessibilityService.dumpActiveWindow());
          r.put("targets", NianAccessibilityService.dumpTargets());
        }
      } catch (Exception ignored) {}
      return r;
    }
    return NianAccessibilityService.control(cmd);
  }

  static JSONObject snapshot(Context ctx) {
    JSONObject o = new JSONObject();
    try {
      o.put("items", listLauncher(ctx));
    } catch (Exception ignored) {}
    return o;
  }

  static JSONArray listLauncher(Context ctx) {
    long now = System.currentTimeMillis();
    JSONArray hit = cacheItems;
    if (hit != null && hit.length() > 0 && now - cacheAt < CACHE_MS) return hit;
    JSONArray items = new JSONArray();
    try {
      PackageManager pm = ctx.getPackageManager();
      Intent intent = new Intent(Intent.ACTION_MAIN);
      intent.addCategory(Intent.CATEGORY_LAUNCHER);
      List<ResolveInfo> resolved;
      if (Build.VERSION.SDK_INT >= 33) {
        resolved = pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0));
      } else {
        resolved = pm.queryIntentActivities(intent, 0);
      }
      if (resolved == null) resolved = Collections.emptyList();
      String self = ctx.getPackageName();
      List<JSONObject> rows = new ArrayList<>();
      for (ResolveInfo ri : resolved) {
        if (ri == null || ri.activityInfo == null) continue;
        String pkg = ri.activityInfo.packageName;
        if (pkg == null || pkg.isEmpty() || pkg.equals(self)) continue;
        String app = label(pm, ri);
        if (app.isEmpty()) continue;
        JSONObject row = new JSONObject();
        row.put("app", app.length() > 40 ? app.substring(0, 40) : app);
        row.put("package", pkg.length() > 120 ? pkg.substring(0, 120) : pkg);
        rows.add(row);
      }
      Collections.sort(rows, new Comparator<JSONObject>() {
        @Override
        public int compare(JSONObject a, JSONObject b) {
          return a.optString("app").compareToIgnoreCase(b.optString("app"));
        }
      });
      int n = Math.min(120, rows.size());
      for (int i = 0; i < n; i++) items.put(rows.get(i));
      cacheItems = items;
      cacheAt = now;
    } catch (Exception ignored) {}
    return items;
  }

  static JSONObject launch(Context ctx, String query) {
    JSONObject o = new JSONObject();
    try {
      String q = query == null ? "" : query.trim();
      if (q.isEmpty()) {
        o.put("ok", false);
        o.put("error", "no_name");
        return o;
      }
      if (isLocked(ctx)) {
        o.put("ok", false);
        o.put("error", "locked");
        return o;
      }
      JSONArray items = listLauncher(ctx);
      JSONObject best = pick(items, q);
      if (best == null) {
        o.put("ok", false);
        o.put("error", "not_found");
        o.put("query", q);
        return o;
      }
      if ("ambiguous".equals(best.optString("error"))) {
        o.put("ok", false);
        o.put("error", "ambiguous");
        o.put("query", q);
        o.put("matches", best.opt("matches"));
        return o;
      }
      String pkg = best.optString("package", "");
      String app = best.optString("app", pkg);
      PackageManager pm = ctx.getPackageManager();
      Intent launch = pm.getLaunchIntentForPackage(pkg);
      if (launch == null) {
        o.put("ok", false);
        o.put("error", "no_intent");
        o.put("app", app);
        o.put("package", pkg);
        return o;
      }
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
      if (!NianAccessibilityService.startExternal(launch)) {
        ctx.startActivity(launch);
      }
      o.put("ok", true);
      o.put("app", app);
      o.put("package", pkg);
    } catch (Exception e) {
      try {
        o.put("ok", false);
        o.put("error", e.getMessage() == null ? "failed" : e.getMessage());
      } catch (Exception ignored) {}
    }
    return o;
  }

  private static boolean isLocked(Context ctx) {
    try {
      KeyguardManager km = (KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
      return km != null && km.isKeyguardLocked();
    } catch (Exception e) {
      return false;
    }
  }

  private static JSONObject pick(JSONArray items, String query) {
    String q = query.toLowerCase(Locale.ROOT).replace("打开", "").replace("帮我", "").trim();
    if (q.isEmpty()) q = query.toLowerCase(Locale.ROOT);
    JSONObject top = null;
    int topScore = 0;
    JSONObject second = null;
    int secondScore = 0;
    JSONArray close = new JSONArray();
    for (int i = 0; i < items.length(); i++) {
      JSONObject it = items.optJSONObject(i);
      if (it == null) continue;
      String app = it.optString("app", "");
      String pkg = it.optString("package", "");
      int score = score(q, app, pkg);
      if (score < 40) continue;
      try { close.put(app); } catch (Exception ignored) {}
      if (score > topScore) {
        second = top;
        secondScore = topScore;
        top = it;
        topScore = score;
      } else if (score > secondScore) {
        second = it;
        secondScore = score;
      }
    }
    if (top == null) return null;
    if (second != null && topScore < 95 && topScore - secondScore < 12) {
      JSONObject amb = new JSONObject();
      try {
        amb.put("error", "ambiguous");
        JSONArray names = new JSONArray();
        names.put(top.optString("app"));
        names.put(second.optString("app"));
        for (int i = 0; i < close.length() && names.length() < 6; i++) {
          String n = close.optString(i);
          boolean dup = false;
          for (int j = 0; j < names.length(); j++) {
            if (n.equals(names.optString(j))) { dup = true; break; }
          }
          if (!dup) names.put(n);
        }
        amb.put("matches", names);
      } catch (Exception ignored) {}
      return amb;
    }
    return top;
  }

  private static int score(String q, String app, String pkg) {
    String a = app.toLowerCase(Locale.ROOT);
    String p = pkg.toLowerCase(Locale.ROOT);
    if (a.equals(q) || p.equals(q)) return 100;
    int alias = aliasScore(q, a, p);
    if (alias > 0) return alias;
    if (a.startsWith(q) || q.startsWith(a)) return 80;
    if (a.contains(q) || (q.contains(a) && a.length() >= 2)) return 60;
    if (p.contains(q) && q.length() >= 3) return 45;
    return 0;
  }

  private static int aliasScore(String q, String app, String pkg) {
    String[][] rows = {
      { "微信", "wechat", "weixin", "com.tencent.mm" },
      { "企业微信", "wework", "com.tencent.wework" },
      { "qq", "手机qq", "com.tencent.mobileqq" },
      { "抖音", "douyin", "aweme", "com.ss.android.ugc.aweme" },
      { "快手", "kwai", "com.smile.gifmaker" },
      { "支付宝", "alipay", "com.eg.android.alipaygphone" },
      { "淘宝", "taobao", "com.taobao.taobao" },
      { "拼多多", "pinduoduo", "com.xunmeng.pinduoduo" },
      { "微博", "weibo", "com.sina.weibo" },
      { "小红书", "xiaohongshu", "com.xingin.xhs" },
      { "b站", "bilibili", "哔哩哔哩", "tv.danmaku.bili" },
      { "网易云", "netease", "cloudmusic", "com.netease.cloudmusic" },
      { "qq音乐", "qqmusic", "com.tencent.qqmusic" },
      { "酷狗", "kugou", "com.kugou.android" },
      { "设置", "settings", "com.android.settings" },
      { "相机", "camera" },
      { "短信", "信息", "mms", "messaging" },
      { "电话", "拨号", "contacts" },
      { "图库", "相册", "gallery", "photos" },
      { "浏览器", "chrome", "browser" },
    };
    for (String[] row : rows) {
      boolean qHit = false;
      boolean appHit = false;
      for (String token : row) {
        String t = token.toLowerCase(Locale.ROOT);
        if (q.equals(t) || (t.length() >= 2 && q.contains(t))) qHit = true;
        if (app.equals(t) || app.contains(t) || pkg.contains(t)) appHit = true;
      }
      if (qHit && appHit) {
        if (app.equals(q) || app.equals(row[0])) return 95;
        return 85;
      }
    }
    return 0;
  }

  private static String label(PackageManager pm, ResolveInfo ri) {
    try {
      CharSequence name = ri.loadLabel(pm);
      if (name != null && name.length() > 0) return name.toString().trim();
    } catch (Exception ignored) {}
    return ri.activityInfo != null ? ri.activityInfo.packageName : "";
  }
}

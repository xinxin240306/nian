package app.nian.comm;

import android.app.Notification;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

/**
 * 读通知栏当前条目（标题/摘要），给角色 tools 用。
 * 不点开 App、不改通知、不主动展开微信会话。
 */
public class NianNotificationListener extends NotificationListenerService {
  public interface ChangeHook {
    void onNotificationsChanged();
  }

  private static volatile NianNotificationListener instance;
  private static volatile ChangeHook changeHook;

  public static void setChangeHook(ChangeHook hook) {
    changeHook = hook;
  }

  public static boolean isConnected() {
    return instance != null;
  }

  public static JSArray listJson(Context ctx) {
    NianNotificationListener svc = instance;
    StatusBarNotification[] raw = null;
    if (svc != null) {
      try {
        raw = svc.getActiveNotifications();
      } catch (Exception ignored) {}
    }
    JSArray arr = new JSArray();
    if (raw == null || raw.length == 0) return arr;
    PackageManager pm = ctx != null ? ctx.getPackageManager() : null;
    String self = ctx != null ? ctx.getPackageName() : "app.nian.comm";
    int n = 0;
    for (StatusBarNotification sbn : raw) {
      if (sbn == null) continue;
      JSObject item = toItem(sbn, pm, self);
      if (item == null) continue;
      arr.put(item);
      if (++n >= 40) break;
    }
    return arr;
  }

  private static JSObject toItem(StatusBarNotification sbn, PackageManager pm, String selfPkg) {
    String pkg = String.valueOf(sbn.getPackageName() == null ? "" : sbn.getPackageName());
    if (pkg.isEmpty()) return null;
    if (selfPkg != null && selfPkg.equals(pkg)) return null;
    Notification n = sbn.getNotification();
    if (n == null) return null;
    if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return null;

    Bundle extras = n.extras != null ? n.extras : Bundle.EMPTY;
    String title = firstNonEmpty(
      cs(extras.getCharSequence(Notification.EXTRA_TITLE)),
      cs(extras.getCharSequence(Notification.EXTRA_TITLE_BIG))
    );
    String text = firstNonEmpty(
      cs(extras.getCharSequence(Notification.EXTRA_TEXT)),
      cs(extras.getCharSequence(Notification.EXTRA_BIG_TEXT)),
      cs(extras.getCharSequence(Notification.EXTRA_SUB_TEXT)),
      joinLines(extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)),
      cs(extras.getCharSequence(Notification.EXTRA_INFO_TEXT))
    );
    if (title.isEmpty() && text.isEmpty()) return null;

    JSObject o = new JSObject();
    o.put("package", pkg);
    o.put("app", appLabel(pm, pkg, extras));
    o.put("title", clip(title, 120));
    o.put("text", clip(text, 240));
    o.put("when", sbn.getPostTime());
    o.put("ongoing", (n.flags & Notification.FLAG_ONGOING_EVENT) != 0);
    o.put("category", n.category != null ? n.category : "");
    return o;
  }

  private static String appLabel(PackageManager pm, String pkg, Bundle extras) {
    String sub = extras.getString("android.substName");
    if (sub != null && !sub.trim().isEmpty()) return clip(sub.trim(), 40);
    if (pm != null) {
      try {
        ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
        CharSequence label = pm.getApplicationLabel(ai);
        if (label != null && label.length() > 0) return clip(label.toString(), 40);
      } catch (Exception ignored) {}
    }
    return pkg;
  }

  private static String joinLines(CharSequence[] lines) {
    if (lines == null || lines.length == 0) return "";
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < lines.length && i < 6; i++) {
      String s = cs(lines[i]);
      if (s.isEmpty()) continue;
      if (sb.length() > 0) sb.append('\n');
      sb.append(s);
    }
    return sb.toString();
  }

  private static String cs(CharSequence c) {
    if (c == null) return "";
    return c.toString().replace('\u0000', ' ').trim();
  }

  private static String firstNonEmpty(String... parts) {
    if (parts == null) return "";
    for (String p : parts) {
      if (p != null && !p.isEmpty()) return p;
    }
    return "";
  }

  /** 通知栏媒体按钮：next / prev / play / pause。切歌比在 App 里点更稳。 */
  public static boolean mediaControl(String want) {
    NianNotificationListener svc = instance;
    if (svc == null || want == null) return false;
    StatusBarNotification[] raw;
    try {
      raw = svc.getActiveNotifications();
    } catch (Exception e) {
      return false;
    }
    if (raw == null) return false;
    String key = want.trim().toLowerCase();
    for (StatusBarNotification sbn : raw) {
      if (sbn == null) continue;
      Notification n = sbn.getNotification();
      if (n == null || n.actions == null) continue;
      for (Notification.Action a : n.actions) {
        if (a == null || a.actionIntent == null) continue;
        String title = a.title == null ? "" : a.title.toString().toLowerCase();
        if (!mediaActionMatches(key, title)) continue;
        try {
          a.actionIntent.send();
          return true;
        } catch (Exception ignored) {}
      }
    }
    return false;
  }

  private static boolean mediaActionMatches(String want, String title) {
    if (title.isEmpty()) return false;
    if ("next".equals(want)) {
      return title.contains("next") || title.contains("skip") || title.contains("下一") || title.contains("后一")
        || title.contains("forward") || title.contains("快进");
    }
    if ("prev".equals(want) || "previous".equals(want)) {
      return title.contains("prev") || title.contains("previous") || title.contains("上一") || title.contains("前一")
        || title.contains("rewind") || title.contains("快退");
    }
    if ("pause".equals(want)) {
      return title.contains("pause") || title.contains("暂停");
    }
    if ("play".equals(want)) {
      return title.contains("play") || title.contains("播放") || title.contains("继续");
    }
    return title.contains(want);
  }

  private static String clip(String s, int max) {
    if (s == null) return "";
    String t = s.trim();
    if (t.length() <= max) return t;
    return t.substring(0, max);
  }

  private void emitChanged() {
    ChangeHook hook = changeHook;
    if (hook != null) {
      try {
        hook.onNotificationsChanged();
      } catch (Exception ignored) {}
    }
  }

  @Override
  public void onListenerConnected() {
    instance = this;
    emitChanged();
  }

  @Override
  public void onListenerDisconnected() {
    if (instance == this) instance = null;
    emitChanged();
  }

  @Override
  public void onNotificationPosted(StatusBarNotification sbn) {
    emitChanged();
  }

  @Override
  public void onNotificationRemoved(StatusBarNotification sbn) {
    emitChanged();
  }
}

package app.nian.comm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONObject;
import java.util.Calendar;
import java.util.TimeZone;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 系统桌面小组件（默认 2×2）：在一起天数 + 随心情变化的小黄豆。
 * 桌面 RemoteViews 无法做复杂动画，用轻量呼吸（透明度轻闪）模拟动态。
 */
public class TogetherWidgetProvider extends AppWidgetProvider {
  private static final String TAG = "NianTogetherWidget";
  static final String ACTION_REFRESH = "app.nian.comm.action.REFRESH_TOGETHER_WIDGET";
  static final String ACTION_PULSE = "app.nian.comm.action.PULSE_TOGETHER_WIDGET";
  private static final long PULSE_MS = 2800L;
  private static final AtomicBoolean refreshing = new AtomicBoolean(false);
  private static final AtomicInteger pulsePhase = new AtomicInteger(0);

  @Override
  public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
    for (int id : appWidgetIds) {
      updateAppWidget(context, appWidgetManager, id);
    }
    schedulePulse(context);
    refreshFromNetwork(context, false);
  }

  @Override
  public void onEnabled(Context context) {
    schedulePulse(context);
    refreshFromNetwork(context, true);
  }

  @Override
  public void onDisabled(Context context) {
    cancelPulse(context);
  }

  @Override
  public void onReceive(Context context, Intent intent) {
    super.onReceive(context, intent);
    if (intent == null) return;
    String action = intent.getAction();
    if (ACTION_PULSE.equals(action)) {
      pulsePhase.incrementAndGet();
      updateAll(context);
      return;
    }
    if (ACTION_REFRESH.equals(action)
        || Intent.ACTION_DATE_CHANGED.equals(action)
        || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
        || Intent.ACTION_TIME_CHANGED.equals(action)) {
      if (Intent.ACTION_DATE_CHANGED.equals(action)
          || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
          || Intent.ACTION_TIME_CHANGED.equals(action)) {
        updateAll(context);
      }
      refreshFromNetwork(context, true);
    }
  }

  static void updateAll(Context context) {
    if (context == null) return;
    AppWidgetManager mgr = AppWidgetManager.getInstance(context);
    int[] ids = mgr.getAppWidgetIds(new ComponentName(context, TogetherWidgetProvider.class));
    if (ids == null || ids.length == 0) return;
    for (int id : ids) updateAppWidget(context, mgr, id);
  }

  static boolean hasWidgets(Context context) {
    if (context == null) return false;
    AppWidgetManager mgr = AppWidgetManager.getInstance(context);
    int[] ids = mgr.getAppWidgetIds(new ComponentName(context, TogetherWidgetProvider.class));
    return ids != null && ids.length > 0;
  }

  static void updateAppWidget(Context context, AppWidgetManager manager, int appWidgetId) {
    RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_together);
    String name = NianBridgePrefs.togetherCharName(context);
    String since = NianBridgePrefs.togetherSince(context);
    int days = resolveDays(context, since);
    String moodLabel = NianBridgePrefs.togetherMoodLabel(context);
    String moodEmoji = NianBridgePrefs.togetherMoodEmoji(context);
    String moodPrimary = NianBridgePrefs.togetherMoodPrimary(context);
    String activity = NianBridgePrefs.togetherActivity(context);
    boolean asleep = NianBridgePrefs.togetherAsleep(context);
    String beanCode = asleep
      ? "睡着"
      : OverlayBeans.resolveWidgetBean(moodPrimary, moodLabel, moodEmoji, activity);
    boolean inhale = (pulsePhase.get() & 1) == 0;

    views.setTextViewText(R.id.widget_together_title, "与 " + name);

    if (days > 0) {
      views.setTextViewText(R.id.widget_together_days, String.valueOf(days));
      views.setTextViewText(R.id.widget_together_unit, "天");
    } else if (NianBridgePrefs.togetherCharId(context) > 0) {
      views.setTextViewText(R.id.widget_together_days, "♡");
      views.setTextViewText(R.id.widget_together_unit, "在一起");
    } else {
      views.setTextViewText(R.id.widget_together_days, "—");
      views.setTextViewText(R.id.widget_together_unit, "天");
    }

    // 不展示纪念日日期；睡着优先显示「睡觉」，否则有心情就亮心情
    String sub = asleep
      ? "睡觉"
      : (moodLabel == null ? "" : moodLabel.trim());
    if (sub.isEmpty() && "睡着".equals(beanCode)) sub = "睡觉";
    if (sub.isEmpty() && NianBridgePrefs.togetherCharId(context) <= 0) {
      sub = "打开念，绑定 TA";
    } else if (sub.isEmpty() && days <= 0) {
      sub = "在角色资料里填纪念日";
    }
    if (sub.isEmpty()) {
      views.setViewVisibility(R.id.widget_together_sub, View.GONE);
      views.setTextViewText(R.id.widget_together_sub, "");
    } else {
      views.setViewVisibility(R.id.widget_together_sub, View.VISIBLE);
      views.setTextViewText(R.id.widget_together_sub, sub);
    }

    float moodDp = 44f;
    int moodPx = Math.round(moodDp * context.getResources().getDisplayMetrics().density);
    Bitmap bean = NianBridgePrefs.togetherCharId(context) > 0
      ? OverlayBeans.widgetBean(context, beanCode, moodPx)
      : null;
    if (bean != null) {
      views.setImageViewBitmap(R.id.widget_together_mood, bean);
      views.setViewVisibility(R.id.widget_together_mood, View.VISIBLE);
      views.setViewVisibility(R.id.widget_together_mood_emoji, View.GONE);
      int padPx = Math.round((inhale ? 0f : 3.5f) * context.getResources().getDisplayMetrics().density);
      views.setViewPadding(R.id.widget_together_mood, padPx, padPx, padPx, padPx);
      try {
        views.setFloat(R.id.widget_together_mood, "setAlpha", inhale ? 1f : 0.78f);
      } catch (Exception ignored) {}
    } else if (NianBridgePrefs.togetherCharId(context) > 0) {
      views.setViewVisibility(R.id.widget_together_mood, View.GONE);
      views.setViewVisibility(R.id.widget_together_mood_emoji, View.VISIBLE);
      views.setTextViewText(
        R.id.widget_together_mood_emoji,
        "睡着".equals(beanCode) ? "😴" : (moodEmoji.isEmpty() ? "😌" : moodEmoji)
      );
      try {
        views.setFloat(R.id.widget_together_mood_emoji, "setAlpha", inhale ? 1f : 0.78f);
      } catch (Exception ignored) {}
      final int px = moodPx;
      final String code = beanCode;
      OverlayBeans.ensureWidgetBean(context, code, () -> {
        if (OverlayBeans.widgetBean(context, code, px) != null) updateAll(context);
      });
    } else {
      views.setViewVisibility(R.id.widget_together_mood, View.GONE);
      views.setViewVisibility(R.id.widget_together_mood_emoji, View.GONE);
    }

    Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    if (launch == null) {
      launch = new Intent(context, MainActivity.class);
    }
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      flags |= PendingIntent.FLAG_IMMUTABLE;
    }
    views.setOnClickPendingIntent(
      R.id.widget_together_root,
      PendingIntent.getActivity(context, appWidgetId, launch, flags)
    );

    manager.updateAppWidget(appWidgetId, views);
  }

  private static PendingIntent pulseIntent(Context context) {
    Intent i = new Intent(context, TogetherWidgetProvider.class).setAction(ACTION_PULSE);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      flags |= PendingIntent.FLAG_IMMUTABLE;
    }
    return PendingIntent.getBroadcast(context, 77, i, flags);
  }

  static void schedulePulse(Context context) {
    if (context == null) return;
    try {
      AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
      if (am == null) return;
      PendingIntent pi = pulseIntent(context);
      am.cancel(pi);
      am.setInexactRepeating(
        AlarmManager.ELAPSED_REALTIME,
        SystemClock.elapsedRealtime() + PULSE_MS,
        PULSE_MS,
        pi
      );
    } catch (Exception e) {
      Log.w(TAG, "schedulePulse", e);
    }
  }

  static void cancelPulse(Context context) {
    if (context == null) return;
    try {
      AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
      if (am == null) return;
      am.cancel(pulseIntent(context));
    } catch (Exception e) {
      Log.w(TAG, "cancelPulse", e);
    }
  }

  static int resolveDays(Context context, String since) {
    String s = since == null ? "" : since.trim();
    if (!s.isEmpty()) {
      int computed = daysBetweenYmd(s, todayYmd());
      if (computed >= 0) return computed;
    }
    return Math.max(0, NianBridgePrefs.togetherDays(context));
  }

  static String todayYmd() {
    Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
    int y = cal.get(Calendar.YEAR);
    int m = cal.get(Calendar.MONTH) + 1;
    int d = cal.get(Calendar.DAY_OF_MONTH);
    return String.format("%04d-%02d-%02d", y, m, d);
  }

  static int daysBetweenYmd(String a, String b) {
    try {
      String[] pa = a.split("-");
      String[] pb = b.split("-");
      if (pa.length < 3 || pb.length < 3) return -1;
      Calendar ca = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
      ca.clear();
      ca.set(Integer.parseInt(pa[0]), Integer.parseInt(pa[1]) - 1, Integer.parseInt(pa[2]));
      Calendar cb = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
      cb.clear();
      cb.set(Integer.parseInt(pb[0]), Integer.parseInt(pb[1]) - 1, Integer.parseInt(pb[2]));
      long ms = cb.getTimeInMillis() - ca.getTimeInMillis();
      return (int) Math.round(ms / 86400000.0);
    } catch (Exception e) {
      return -1;
    }
  }

  static void applySnapshot(
    Context context,
    int characterId,
    String name,
    String togetherSince,
    int daysTogether,
    String moodPrimary,
    String moodLabel,
    String moodEmoji,
    String activity,
    boolean asleep
  ) {
    NianBridgePrefs.saveTogetherSnapshot(
      context, characterId, name, togetherSince, daysTogether, moodPrimary, moodLabel, moodEmoji, activity, asleep
    );
    updateAll(context);
    schedulePulse(context);
  }

  static void refreshFromNetwork(Context context, boolean force) {
    if (context == null) return;
    if (!force && !hasWidgets(context)) return;
    if (!refreshing.compareAndSet(false, true)) return;
    final Context app = context.getApplicationContext();
    new Thread(() -> {
      try {
        String base = NianBridgePrefs.serverBase(app);
        if (base == null || base.isEmpty()) return;
        String raw = PhoneHttp.get(app, "/api/ta");
        JSONObject snap = new JSONObject(raw);
        int cid = snap.optInt("characterId", 0);
        JSONObject character = snap.optJSONObject("character");
        JSONObject affection = snap.optJSONObject("affection");
        JSONObject mood = snap.optJSONObject("mood");
        String name = character != null ? character.optString("name", "TA") : "TA";
        String since = "";
        int days = 0;
        if (affection != null) {
          since = affection.optString("togetherSince", "");
          days = affection.optInt("daysTogether", 0);
        }
        if (since == null || since.isEmpty()) {
          since = snap.optString("anniversary", "");
        }
        String moodPrimary = "";
        String moodLabel = "";
        String moodEmoji = "";
        String activity = "";
        boolean asleep = false;
        if (mood != null) {
          moodPrimary = mood.optString("primary", "");
          moodLabel = mood.optString("label", "");
          moodEmoji = mood.optString("display", "");
          if (moodEmoji == null || moodEmoji.isEmpty()) {
            moodEmoji = mood.optString("emoji", "");
          }
          asleep = mood.optBoolean("asleep", false);
          activity = mood.optString("activity", "");
          if (asleep || "睡着".equals(mood.optString("bean", ""))) {
            moodPrimary = "tired";
            if (moodLabel == null || moodLabel.isEmpty()) moodLabel = "睡觉";
            if (moodEmoji == null || moodEmoji.isEmpty()) moodEmoji = "😴";
          }
        }
        JSONObject presence = snap.optJSONObject("presence");
        if (presence != null) {
          if (presence.optBoolean("asleep", false)) asleep = true;
          String act = presence.optString("activity", "");
          if (act != null && !act.isEmpty()) activity = act;
        }
        if (cid <= 0) {
          NianBridgePrefs.clearTogetherSnapshot(app);
        } else {
          NianBridgePrefs.saveTogetherSnapshot(
            app, cid, name, since, days, moodPrimary, moodLabel, moodEmoji, activity, asleep
          );
          final String beanCode = asleep
            ? "睡着"
            : OverlayBeans.resolveWidgetBean(moodPrimary, moodLabel, moodEmoji, activity);
          OverlayBeans.ensureWidgetBean(
            app,
            beanCode,
            () -> {
              int px = Math.round(44f * app.getResources().getDisplayMetrics().density);
              if (OverlayBeans.widgetBean(app, beanCode, px) != null) {
                updateAll(app);
              }
            }
          );
        }
        updateAll(app);
        schedulePulse(app);
      } catch (Exception e) {
        Log.w(TAG, "refresh", e);
        updateAll(app);
      } finally {
        refreshing.set(false);
      }
    }, "nian-together-widget").start();
  }
}

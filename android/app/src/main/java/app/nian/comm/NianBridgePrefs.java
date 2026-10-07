package app.nian.comm;

import android.content.Context;
import android.content.SharedPreferences;

/** 原生保活轮询要用的后端地址。由网页在连上服务器后写入。 */
final class NianBridgePrefs {
  private static final String PREF = "nian_bridge";
  private static final String KEY_BASE = "server_base";
  private static final String KEY_TOKEN = "session_token";
  private static final String KEY_FOREGROUND = "foreground";
  private static final String KEY_HALO_CHAR_ID = "halo_char_id";
  private static final String KEY_HALO_CHAR_NAME = "halo_char_name";
  private static final String KEY_CALL_CHAR_ID = "active_call_char_id";
  private static final String KEY_CALL_CHAR_NAME = "active_call_char_name";
  private static final String KEY_CALL_VIDEO = "active_call_video";
  private static final String KEY_CALL_STARTED_AT = "active_call_started_at";
  private static final String KEY_TOGETHER_CHAR_ID = "together_char_id";
  private static final String KEY_TOGETHER_CHAR_NAME = "together_char_name";
  private static final String KEY_TOGETHER_SINCE = "together_since";
  private static final String KEY_TOGETHER_DAYS = "together_days";
  private static final String KEY_TOGETHER_MOOD_PRIMARY = "together_mood_primary";
  private static final String KEY_TOGETHER_MOOD_LABEL = "together_mood_label";
  private static final String KEY_TOGETHER_MOOD_EMOJI = "together_mood_emoji";
  private static final String KEY_TOGETHER_ACTIVITY = "together_activity";
  private static final String KEY_TOGETHER_ASLEEP = "together_asleep";

  private NianBridgePrefs() {}

  static void save(Context ctx, String serverBase, String sessionToken) {
    SharedPreferences p = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    p.edit()
      .putString(KEY_BASE, serverBase == null ? "" : serverBase.trim().replaceAll("/+$", ""))
      .putString(KEY_TOKEN, sessionToken == null ? "" : sessionToken.trim())
      .apply();
  }

  static void saveForeground(Context ctx, boolean on) {
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_FOREGROUND, on)
      .apply();
  }

  static boolean wantForeground(Context ctx) {
    return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean(KEY_FOREGROUND, false);
  }

  static String serverBase(Context ctx) {
    return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_BASE, "");
  }

  static String sessionToken(Context ctx) {
    return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_TOKEN, "");
  }

  static void saveHaloChar(Context ctx, int characterId, String name) {
    if (ctx == null || characterId <= 0) return;
    String n = name == null ? "" : name.trim();
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
      .putInt(KEY_HALO_CHAR_ID, characterId)
      .putString(KEY_HALO_CHAR_NAME, n.isEmpty() ? "TA" : n)
      .apply();
  }

  static int haloCharId(Context ctx) {
    if (ctx == null) return 0;
    return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getInt(KEY_HALO_CHAR_ID, 0);
  }

  static String haloCharName(Context ctx) {
    if (ctx == null) return "TA";
    String n = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_HALO_CHAR_NAME, "TA");
    return n == null || n.trim().isEmpty() ? "TA" : n.trim();
  }

  /** 通话进行中：供 WebView 挂掉后写「通话结束」并清悬浮窗。 */
  static void saveActiveCall(Context ctx, int characterId, String name, boolean video, long startedAt) {
    if (ctx == null || characterId <= 0) return;
    String n = name == null ? "" : name.trim();
    long at = startedAt > 0 ? startedAt : System.currentTimeMillis();
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
      .putInt(KEY_CALL_CHAR_ID, characterId)
      .putString(KEY_CALL_CHAR_NAME, n.isEmpty() ? "TA" : n)
      .putBoolean(KEY_CALL_VIDEO, video)
      .putLong(KEY_CALL_STARTED_AT, at)
      .apply();
  }

  static void clearActiveCall(Context ctx) {
    if (ctx == null) return;
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
      .remove(KEY_CALL_CHAR_ID)
      .remove(KEY_CALL_CHAR_NAME)
      .remove(KEY_CALL_VIDEO)
      .remove(KEY_CALL_STARTED_AT)
      .apply();
  }

  static int activeCallCharId(Context ctx) {
    if (ctx == null) return 0;
    return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getInt(KEY_CALL_CHAR_ID, 0);
  }

  static String activeCallName(Context ctx) {
    if (ctx == null) return "TA";
    String n = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_CALL_CHAR_NAME, "TA");
    return n == null || n.trim().isEmpty() ? "TA" : n.trim();
  }

  static boolean activeCallVideo(Context ctx) {
    if (ctx == null) return false;
    return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean(KEY_CALL_VIDEO, false);
  }

  static long activeCallStartedAt(Context ctx) {
    if (ctx == null) return 0L;
    return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getLong(KEY_CALL_STARTED_AT, 0L);
  }

  static void saveTogetherSnapshot(
    Context ctx,
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
    if (ctx == null) return;
    String n = name == null ? "" : name.trim();
    String since = togetherSince == null ? "" : togetherSince.trim();
    if (since.length() > 10) since = since.substring(0, 10);
    String primary = moodPrimary == null ? "" : moodPrimary.trim().toLowerCase();
    String label = moodLabel == null ? "" : moodLabel.trim();
    String emoji = moodEmoji == null ? "" : moodEmoji.trim();
    String act = activity == null ? "" : activity.trim();
    if (label.length() > 24) label = label.substring(0, 24);
    if (emoji.length() > 8) emoji = emoji.substring(0, 8);
    if (act.length() > 40) act = act.substring(0, 40);
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
      .putInt(KEY_TOGETHER_CHAR_ID, Math.max(0, characterId))
      .putString(KEY_TOGETHER_CHAR_NAME, n.isEmpty() ? "TA" : n)
      .putString(KEY_TOGETHER_SINCE, since)
      .putInt(KEY_TOGETHER_DAYS, Math.max(0, daysTogether))
      .putString(KEY_TOGETHER_MOOD_PRIMARY, primary)
      .putString(KEY_TOGETHER_MOOD_LABEL, label)
      .putString(KEY_TOGETHER_MOOD_EMOJI, emoji)
      .putString(KEY_TOGETHER_ACTIVITY, act)
      .putBoolean(KEY_TOGETHER_ASLEEP, asleep)
      .apply();
  }

  static void clearTogetherSnapshot(Context ctx) {
    if (ctx == null) return;
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
      .remove(KEY_TOGETHER_CHAR_ID)
      .remove(KEY_TOGETHER_CHAR_NAME)
      .remove(KEY_TOGETHER_SINCE)
      .remove(KEY_TOGETHER_DAYS)
      .remove(KEY_TOGETHER_MOOD_PRIMARY)
      .remove(KEY_TOGETHER_MOOD_LABEL)
      .remove(KEY_TOGETHER_MOOD_EMOJI)
      .remove(KEY_TOGETHER_ACTIVITY)
      .remove(KEY_TOGETHER_ASLEEP)
      .apply();
  }

  static int togetherCharId(Context ctx) {
    if (ctx == null) return 0;
    return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getInt(KEY_TOGETHER_CHAR_ID, 0);
  }

  static String togetherCharName(Context ctx) {
    if (ctx == null) return "TA";
    String n = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_TOGETHER_CHAR_NAME, "TA");
    return n == null || n.trim().isEmpty() ? "TA" : n.trim();
  }

  static String togetherSince(Context ctx) {
    if (ctx == null) return "";
    String s = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_TOGETHER_SINCE, "");
    return s == null ? "" : s.trim();
  }

  static int togetherDays(Context ctx) {
    if (ctx == null) return 0;
    return Math.max(0, ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getInt(KEY_TOGETHER_DAYS, 0));
  }

  static String togetherMoodPrimary(Context ctx) {
    if (ctx == null) return "";
    String s = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_TOGETHER_MOOD_PRIMARY, "");
    return s == null ? "" : s.trim();
  }

  static String togetherMoodLabel(Context ctx) {
    if (ctx == null) return "";
    String s = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_TOGETHER_MOOD_LABEL, "");
    return s == null ? "" : s.trim();
  }

  static String togetherMoodEmoji(Context ctx) {
    if (ctx == null) return "";
    String s = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_TOGETHER_MOOD_EMOJI, "");
    return s == null ? "" : s.trim();
  }

  static String togetherActivity(Context ctx) {
    if (ctx == null) return "";
    String s = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_TOGETHER_ACTIVITY, "");
    return s == null ? "" : s.trim();
  }

  static boolean togetherAsleep(Context ctx) {
    if (ctx == null) return false;
    return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getBoolean(KEY_TOGETHER_ASLEEP, false);
  }
}

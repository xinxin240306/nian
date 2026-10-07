package app.nian.comm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;

/** 角色来电：锁屏全屏 + 媒体铃声，不走通话 SCO。 */
public class IncomingCallService extends Service {
  public static final String CHANNEL_ID = "nian.incoming_call.v2";
  public static final String EXTRA_CHAR_ID = "char_id";
  public static final String EXTRA_NAME = "char_name";
  public static final String EXTRA_AVATAR = "char_avatar";
  public static final String EXTRA_CONTENT = "char_content";
  public static final String EXTRA_RINGTONE = "ringtone";
  public static final String EXTRA_SYSTEM_RING = "system_ring";
  public static final String EXTRA_LOG_ID = "log_id";
  public static final String EXTRA_RING_MS = "ring_ms";
  private static final int NOTIF_ID = 2208;
  private static volatile boolean running;
  private static final JSONObject pending = new JSONObject();
  private static final Handler timeoutHandler = new Handler(Looper.getMainLooper());
  private static Runnable timeoutTask;
  private MediaPlayer player;
  private static MediaPlayer standalonePlayer;
  private PowerManager.WakeLock wakeLock;
  private Vibrator vibrator;

  public static boolean show(Context ctx, int characterId, String name, String avatar, String content, String ringtone, int logId, long ringMs) {
    return show(ctx, characterId, name, avatar, content, ringtone, logId, ringMs, false);
  }

  public static boolean show(Context ctx, int characterId, String name, String avatar, String content, String ringtone, int logId, long ringMs, boolean systemRing) {
    if (ctx == null || characterId <= 0) return false;
    if (MainActivity.isResumed()) return false;
    synchronized (pending) {
      try {
        pending.put("characterId", characterId);
        pending.put("name", name == null ? "TA" : name);
        pending.put("avatar", avatar == null ? "" : avatar);
        pending.put("content", content == null ? "" : content);
        pending.put("ringtone", ringtone == null ? "" : ringtone);
        pending.put("systemRing", systemRing);
        pending.put("logId", logId);
      } catch (Exception ignored) {}
    }
    Intent i = new Intent(ctx, IncomingCallService.class);
    i.putExtra(EXTRA_CHAR_ID, characterId);
    i.putExtra(EXTRA_NAME, name);
    i.putExtra(EXTRA_AVATAR, avatar);
    i.putExtra(EXTRA_CONTENT, content);
    i.putExtra(EXTRA_RINGTONE, ringtone);
    i.putExtra(EXTRA_SYSTEM_RING, systemRing);
    i.putExtra(EXTRA_LOG_ID, logId);
    i.putExtra(EXTRA_RING_MS, ringMs > 0 ? ringMs : 35000L);
    if (running) return true;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ctx.startForegroundService(i);
    } else {
      ctx.startService(i);
    }
    return true;
  }

  public static void dismiss(Context ctx) {
    cancelTimeout();
    stopStandaloneRing();
    if (ctx != null) ctx.stopService(new Intent(ctx, IncomingCallService.class));
  }

  public static void reportOutcome(Context ctx, String outcome) {
    final JSONObject p = pendingCall();
    final int logId = p.optInt("logId", 0);
    final int charId = p.optInt("characterId", 0);
    if (ctx == null || charId <= 0) return;
    final String status = outcome == null ? "" : outcome.trim();
    new Thread(() -> {
      try {
        JSONObject body = new JSONObject();
        body.put("logId", logId);
        body.put("characterId", charId);
        body.put("outcome", status);
        PhoneHttp.post(ctx.getApplicationContext(), "/api/calls/incoming-result", body.toString());
      } catch (Exception ignored) {}
    }, "nian-call-result").start();
  }

  private static void cancelTimeout() {
    if (timeoutTask != null) {
      timeoutHandler.removeCallbacks(timeoutTask);
      timeoutTask = null;
    }
  }

  public static boolean isRunning() {
    return running;
  }

  public static JSONObject pendingCall() {
    synchronized (pending) {
      try {
        return new JSONObject(pending.toString());
      } catch (Exception e) {
        return new JSONObject();
      }
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    running = true;
    int charId = intent != null ? intent.getIntExtra(EXTRA_CHAR_ID, 0) : 0;
    String name = intent != null ? intent.getStringExtra(EXTRA_NAME) : "TA";
    if (name == null || name.trim().isEmpty()) name = "TA";
    String content = intent != null ? intent.getStringExtra(EXTRA_CONTENT) : "";
    String ringtone = intent != null ? intent.getStringExtra(EXTRA_RINGTONE) : "";
    boolean systemRing = intent != null && intent.getBooleanExtra(EXTRA_SYSTEM_RING, false);
    int logId = intent != null ? intent.getIntExtra(EXTRA_LOG_ID, 0) : 0;
    long ringMs = intent != null ? intent.getLongExtra(EXTRA_RING_MS, 35000L) : 35000L;
    if (ringMs < 8000) ringMs = 35000L;
    IncomingCallActivity.show(this, charId, name, content, logId);
    cancelTimeout();
    timeoutTask = () -> {
      reportOutcome(getApplicationContext(), "missed");
      stopSelf();
    };
    timeoutHandler.postDelayed(timeoutTask, ringMs);
    ensureChannel();
    Intent open = new Intent(this, IncomingCallActivity.class);
    open.putExtra(EXTRA_CHAR_ID, charId);
    open.putExtra(EXTRA_NAME, name);
    open.putExtra(EXTRA_CONTENT, content);
    open.putExtra(EXTRA_LOG_ID, logId);
    open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent full = PendingIntent.getActivity(this, charId, open, piFlags);

    NotificationCompat.Builder nb = new NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(name)
      .setContentText("邀请你语音通话")
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(full)
      .setFullScreenIntent(full, true);
    Notification notif = nb.build();
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIF_ID, notif, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
    } else {
      startForeground(NOTIF_ID, notif);
    }
    acquireWake();
    startRing(ringtone, systemRing);
    vibrate();
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    running = false;
    cancelTimeout();
    stopRing();
    stopVibrate();
    releaseWake();
    try {
      NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
      if (nm != null) nm.cancel(NOTIF_ID);
    } catch (Exception ignored) {}
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  public static void playStandaloneRing(Context ctx, String ringtone, boolean systemRing) {
    if (ctx == null) return;
    final Context app = ctx.getApplicationContext();
    timeoutHandler.post(() -> startPlayer(app, ringtone, systemRing, true));
  }

  public static void stopStandaloneRing() {
    timeoutHandler.post(() -> releasePlayer(standalonePlayer, true));
  }

  private void startRing(String ringtone, boolean systemRing) {
    stopRing();
    stopStandaloneRing();
    startPlayer(this, ringtone, systemRing, false);
  }

  private static void startPlayer(Context ctx, String ringtone, boolean systemRing, boolean standalone) {
    if (ctx == null) return;
    releasePlayer(standalone ? standalonePlayer : null, standalone);
    Uri uri = resolveRingtone(ctx, ringtone, systemRing);
    if (uri == null) return;
    try {
      MediaPlayer mp = new MediaPlayer();
      AudioAttributes.Builder ab = new AudioAttributes.Builder()
        .setContentType(systemRing ? AudioAttributes.CONTENT_TYPE_SONIFICATION : AudioAttributes.CONTENT_TYPE_MUSIC);
      if (Build.VERSION.SDK_INT >= 21) {
        ab.setUsage(systemRing ? AudioAttributes.USAGE_NOTIFICATION_RINGTONE : AudioAttributes.USAGE_MEDIA);
      }
      mp.setAudioAttributes(ab.build());
      mp.setDataSource(ctx, uri);
      mp.setLooping(true);
      mp.prepare();
      mp.start();
      if (standalone) standalonePlayer = mp;
      else if (ctx instanceof IncomingCallService) ((IncomingCallService) ctx).player = mp;
    } catch (Exception e) {
      /* 自定义铃声失败时不要偷偷改播系统电话铃 */
    }
  }

  private static Uri resolveRingtone(Context ctx, String raw, boolean systemRing) {
    if (systemRing) return systemRingtoneUri();
    String s = raw == null ? "" : raw.trim();
    if (s.isEmpty()) return null;
    if (s.startsWith("/")) {
      String base = NianBridgePrefs.serverBase(ctx);
      if (base != null && !base.isEmpty()) s = base + s;
    }
    try {
      Uri uri = Uri.parse(s);
      if (uri != null && uri.getScheme() != null && !uri.getScheme().isEmpty()) return uri;
    } catch (Exception ignored) {}
    return null;
  }

  private static Uri systemRingtoneUri() {
    Uri def = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
    return def != null ? def : Settings.System.DEFAULT_RINGTONE_URI;
  }

  private static void releasePlayer(MediaPlayer mp, boolean standalone) {
    MediaPlayer target = standalone ? standalonePlayer : mp;
    if (standalone) standalonePlayer = null;
    if (target == null) return;
    try { target.stop(); } catch (Exception ignored) {}
    try { target.release(); } catch (Exception ignored) {}
  }

  private void stopRing() {
    if (player == null) return;
    try { player.stop(); } catch (Exception ignored) {}
    try { player.release(); } catch (Exception ignored) {}
    player = null;
  }

  private void vibrate() {
    try {
      if (Build.VERSION.SDK_INT >= 31) {
        VibratorManager vm = (VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
        vibrator = vm != null ? vm.getDefaultVibrator() : null;
      } else {
        vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
      }
      if (vibrator == null) return;
      long[] pattern = {0, 600, 400, 600, 800};
      if (Build.VERSION.SDK_INT >= 26) {
        vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
      } else {
        vibrator.vibrate(pattern, 0);
      }
    } catch (Exception ignored) {}
  }

  private void stopVibrate() {
    try { if (vibrator != null) vibrator.cancel(); } catch (Exception ignored) {}
    vibrator = null;
  }

  private void acquireWake() {
    try {
      PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
      if (pm == null) return;
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nian:incoming-call");
      wakeLock.acquire(90_000);
    } catch (Exception ignored) {}
  }

  private void releaseWake() {
    try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
    wakeLock = null;
  }

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
    NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "来电", NotificationManager.IMPORTANCE_HIGH);
    ch.setDescription("角色打来的电话");
    ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    ch.enableVibration(true);
    ch.setSound(null, null);
    nm.createNotificationChannel(ch);
  }
}

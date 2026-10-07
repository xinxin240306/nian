package app.nian.comm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;

/** 闹钟响铃：循环播放角色语音（没有语音文件时用系统闹钟铃）。 */
public class NianAlarmService extends Service {
  public static final String CHANNEL_ID = "nian.alarm";
  private static final int NOTIF_ID = 2101;
  private static volatile boolean running;
  private MediaPlayer player;
  private PowerManager.WakeLock wakeLock;
  private Vibrator vibrator;
  private int alarmId;

  public static void start(Context ctx, int id) {
    Intent i = new Intent(ctx, NianAlarmService.class);
    i.putExtra(NianAlarms.EXTRA_ID, id);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ctx.startForegroundService(i);
    } else {
      ctx.startService(i);
    }
  }

  public static void stop(Context ctx) {
    ctx.stopService(new Intent(ctx, NianAlarmService.class));
  }

  public static boolean isRunning() {
    return running;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    running = true;
    alarmId = intent != null ? intent.getIntExtra(NianAlarms.EXTRA_ID, 0) : 0;
    JSONObject item = NianAlarms.get(this, alarmId);
    String name = item != null ? item.optString("name", "念") : "念";
    String speech = item != null ? item.optString("speech", "") : "";
    String label = item != null ? item.optString("label", "") : "";
    String title = name.isEmpty() ? "闹钟" : name + " 的闹钟";
    String text = !speech.isEmpty() ? speech : (!label.isEmpty() ? label : "该起床了");

    ensureChannel();
    Intent open = new Intent(this, NianAlarmActivity.class);
    open.putExtra(NianAlarms.EXTRA_ID, alarmId);
    open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent content = PendingIntent.getActivity(this, alarmId, open, piFlags);

    NotificationCompat.Builder nb = new NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setContentIntent(content)
      .setFullScreenIntent(content, true);
    Notification notif = nb.build();
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
    } else {
      startForeground(NOTIF_ID, notif);
    }
    acquireWakeLock();
    startPlayback(item);
    vibrate();
    return START_REDELIVER_INTENT;
  }

  @Override
  public void onDestroy() {
    running = false;
    stopPlayback();
    stopVibrate();
    releaseWakeLock();
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void startPlayback(JSONObject item) {
    stopPlayback();
    try {
      player = new MediaPlayer();
      player.setAudioAttributes(new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .build());
      String path = item != null ? item.optString("audioPath", "") : "";
      java.io.File f = path.isEmpty() ? null : new java.io.File(path);
      if (f != null && f.isFile() && f.length() > 80) {
        player.setDataSource(f.getAbsolutePath());
      } else {
        Uri uri = NianAlarms.playUri(this, item);
        player.setDataSource(this, uri);
      }
      player.setLooping(true);
      player.setVolume(1f, 1f);
      player.prepare();
      player.start();
      try {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am != null) {
          int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
          if (max > 0 && am.getStreamVolume(AudioManager.STREAM_ALARM) == 0) {
            am.setStreamVolume(AudioManager.STREAM_ALARM, Math.max(1, max / 2), 0);
          }
        }
      } catch (Exception ignored) {}
    } catch (Exception e) {
      player = null;
    }
  }

  private void stopPlayback() {
    if (player != null) {
      try { player.stop(); } catch (Exception ignored) {}
      try { player.release(); } catch (Exception ignored) {}
      player = null;
    }
  }

  private void vibrate() {
    try {
      Vibrator v;
      if (Build.VERSION.SDK_INT >= 31) {
        VibratorManager vm = (VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
        v = vm != null ? vm.getDefaultVibrator() : null;
      } else {
        v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
      }
      if (v == null) return;
      vibrator = v;
      long[] pattern = { 0, 600, 400, 600, 400, 800 };
      if (Build.VERSION.SDK_INT >= 26) {
        v.vibrate(VibrationEffect.createWaveform(pattern, 0));
      } else {
        v.vibrate(pattern, 0);
      }
    } catch (Exception ignored) {}
  }

  private void stopVibrate() {
    if (vibrator != null) {
      try { vibrator.cancel(); } catch (Exception ignored) {}
      vibrator = null;
    }
  }

  private void acquireWakeLock() {
    try {
      PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
      if (pm == null) return;
      wakeLock = pm.newWakeLock(
        PowerManager.PARTIAL_WAKE_LOCK,
        "nian:alarm"
      );
      wakeLock.setReferenceCounted(false);
      wakeLock.acquire(30 * 60 * 1000L);
    } catch (Exception ignored) {}
  }

  private void releaseWakeLock() {
    if (wakeLock != null && wakeLock.isHeld()) {
      try { wakeLock.release(); } catch (Exception ignored) {}
    }
    wakeLock = null;
  }

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
    NotificationChannel ch = new NotificationChannel(
      CHANNEL_ID, "角色闹钟", NotificationManager.IMPORTANCE_HIGH
    );
    ch.setDescription("角色用自己的声音叫你起床");
    ch.setBypassDnd(true);
    ch.enableVibration(true);
    nm.createNotificationChannel(ch);
  }
}

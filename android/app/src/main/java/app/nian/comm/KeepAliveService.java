package app.nian.comm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;

public class KeepAliveService extends Service {
  public static final String CHANNEL_ID = "nian.keepalive";
  private static final int NOTIF_ID = 1001;
  private static final long TICK_MS = 3500;
  public static volatile boolean running = false;
  private static volatile boolean callMedia;
  private static volatile boolean callVideo;
  private static volatile KeepAliveService instance;

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Runnable tick = new Runnable() {
    @Override
    public void run() {
      if (!running) return;
      new Thread(() -> PhoneBridgeTick.run(KeepAliveService.this), "nian-phone-tick").start();
      // 通话连麦：泵一下原生周期采样（锁屏后 WebView 定时器不可靠）
      if (callMedia) {
        try { NativeCallEngine.pumpAmbientSampleWatch(); } catch (Exception ignored) {}
      }
      handler.postDelayed(this, TICK_MS);
    }
  };

  public static void start(Context ctx) {
    Intent i = new Intent(ctx, KeepAliveService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ctx.startForegroundService(i);
    } else {
      ctx.startService(i);
    }
  }

  public static void stop(Context ctx) {
    ctx.stopService(new Intent(ctx, KeepAliveService.class));
  }

  public static void refreshForeground(Context ctx) {
    KeepAliveService s = instance;
    if (s != null) s.applyForeground();
    else if (ctx != null && BobobeiBle.wantsConnectedDevice()) start(ctx);
  }

  public static void setCallMedia(Context ctx, boolean on, boolean video) {
    callMedia = on;
    callVideo = on && video;
    if (on && ctx != null) start(ctx);
    KeepAliveService s = instance;
    if (s != null) s.applyForeground();
    if (!on && ctx != null && !NianBridgePrefs.wantForeground(ctx) && !BobobeiBle.wantsConnectedDevice()) {
      stop(ctx);
    }
  }

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
    running = true;
    ensureChannel();
    applyForeground();
    try { StepCounter.start(this); } catch (Exception ignored) {}
    handler.post(tick);
    try { BobobeiBle.warmStart(this); } catch (Exception ignored) {}
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    running = false;
    if (instance == this) instance = null;
    handler.removeCallbacks(tick);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void applyForeground() {
    Notification notif = buildNotif();
    int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
    if (Build.VERSION.SDK_INT >= 29 && callMedia) {
      type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
      type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
      if (callVideo) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
    }
    if (Build.VERSION.SDK_INT >= 34 && BobobeiBle.wantsConnectedDevice()) {
      type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
    }
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIF_ID, notif, type);
      } else {
        startForeground(NOTIF_ID, notif);
      }
    } catch (Exception e) {
      try { startForeground(NOTIF_ID, notif); } catch (Exception ignored) {}
    }
  }

  private Notification buildNotif() {
    NotificationCompat.Builder nb = new NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("念")
      .setContentText(callMedia ? "正在通话，可在其他应用继续聊" : "正在后台保持连接")
      .setOngoing(true);
    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
    if (launch != null) {
      nb.setContentIntent(PendingIntent.getActivity(
        this, 0, launch,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
      ));
    }
    return nb.build();
  }

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
    NotificationChannel ch = new NotificationChannel(
      CHANNEL_ID, "后台保持", NotificationManager.IMPORTANCE_LOW
    );
    ch.setDescription("前台服务常驻通知，减少被系统杀掉");
    nm.createNotificationChannel(ch);
  }
}

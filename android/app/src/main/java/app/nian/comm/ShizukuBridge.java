package app.nian.comm;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import com.getcapacitor.JSObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import rikka.shizuku.Shizuku;

final class ShizukuBridge {
  static final String SHIZUKU_PKG = "moe.shizuku.privileged.api";
  private static final String TAG = "NianShizuku";
  private static final int REQ = 4101;

  private ShizukuBridge() {}

  static boolean isInstalled(Context ctx) {
    try {
      ctx.getPackageManager().getPackageInfo(SHIZUKU_PKG, 0);
      return true;
    } catch (Exception e) {
      return false;
    }
  }

  static boolean isRunning() {
    try {
      return Build.VERSION.SDK_INT >= 23 && Shizuku.pingBinder();
    } catch (Throwable t) {
      return false;
    }
  }

  static boolean hasPermission() {
    try {
      return isRunning()
        && !Shizuku.isPreV11()
        && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
    } catch (Throwable t) {
      return false;
    }
  }

  static String state(Context ctx) {
    if (Build.VERSION.SDK_INT < 23) return "unsupported";
    boolean running = isRunning();
    if (!running) return isInstalled(ctx) ? "stopped" : "missing";
    try {
      if (Shizuku.isPreV11()) return "pre_v11";
      if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) return "granted";
      return "denied";
    } catch (Throwable t) {
      return "stopped";
    }
  }

  static void putStatus(JSObject o, Context ctx) {
    String st = state(ctx);
    o.put("shizukuInstalled", isInstalled(ctx) || isRunning());
    o.put("shizukuRunning", isRunning());
    o.put("shizukuPermission", "granted".equals(st));
    o.put("shizukuState", st);
    int uid = -1;
    try {
      if (isRunning()) uid = Shizuku.getUid();
    } catch (Throwable ignored) {}
    o.put("shizukuUid", uid);
  }

  static void requestPermission() {
    Shizuku.requestPermission(REQ);
  }

  static void openShizuku(Context ctx) {
    Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(SHIZUKU_PKG);
    if (launch != null) {
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(launch);
      return;
    }
    Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse("https://shizuku.rikka.app/download/"));
    web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    ctx.startActivity(web);
  }

  static String applyHelpers(Context ctx) throws Exception {
    if (!hasPermission()) throw new IllegalStateException("还没有 Shizuku 授权");
    CountDownLatch latch = new CountDownLatch(1);
    AtomicReference<INianShizukuService> svc = new AtomicReference<>();
    AtomicReference<String> err = new AtomicReference<>();

    Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(
      new ComponentName(ctx.getPackageName(), ShizukuUserService.class.getName())
    )
      .daemon(false)
      .processNameSuffix("shizuku")
      .debuggable(false)
      .version(BuildConfig.VERSION_CODE);

    ServiceConnection conn = new ServiceConnection() {
      @Override
      public void onServiceConnected(ComponentName name, IBinder binder) {
        if (binder != null && binder.pingBinder()) {
          svc.set(INianShizukuService.Stub.asInterface(binder));
        } else {
          err.set("Shizuku 服务连接失败");
        }
        latch.countDown();
      }

      @Override
      public void onServiceDisconnected(ComponentName name) {
        svc.set(null);
      }
    };

    Handler main = new Handler(Looper.getMainLooper());
    main.post(() -> Shizuku.bindUserService(args, conn));
    boolean ok = latch.await(12, TimeUnit.SECONDS);
    try {
      if (!ok) throw new IllegalStateException("连接 Shizuku 超时");
      if (err.get() != null) throw new IllegalStateException(err.get());
      INianShizukuService s = svc.get();
      if (s == null) throw new IllegalStateException("没有拿到 Shizuku 服务");
      String listener = ctx.getPackageName() + "/" + NianNotificationListener.class.getName();
      return s.applyHelpers(ctx.getPackageName(), listener);
    } finally {
      main.post(() -> {
        try {
          Shizuku.unbindUserService(args, conn, true);
        } catch (Throwable t) {
          Log.w(TAG, "unbind", t);
        }
      });
    }
  }

  static byte[] captureScreenJpeg(Context ctx) throws Exception {
    if (!hasPermission()) throw new IllegalStateException("还没有 Shizuku 授权");
    CountDownLatch latch = new CountDownLatch(1);
    AtomicReference<INianShizukuService> svc = new AtomicReference<>();
    AtomicReference<String> err = new AtomicReference<>();

    Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(
      new ComponentName(ctx.getPackageName(), ShizukuUserService.class.getName())
    )
      .daemon(false)
      .processNameSuffix("shizuku")
      .debuggable(false)
      .version(BuildConfig.VERSION_CODE);

    ServiceConnection conn = new ServiceConnection() {
      @Override
      public void onServiceConnected(ComponentName name, IBinder binder) {
        if (binder != null && binder.pingBinder()) {
          svc.set(INianShizukuService.Stub.asInterface(binder));
        } else {
          err.set("Shizuku 服务连接失败");
        }
        latch.countDown();
      }

      @Override
      public void onServiceDisconnected(ComponentName name) {
        svc.set(null);
      }
    };

    Handler main = new Handler(Looper.getMainLooper());
    main.post(() -> Shizuku.bindUserService(args, conn));
    boolean ok = latch.await(12, TimeUnit.SECONDS);
    try {
      if (!ok) throw new IllegalStateException("连接 Shizuku 超时");
      if (err.get() != null) throw new IllegalStateException(err.get());
      INianShizukuService s = svc.get();
      if (s == null) throw new IllegalStateException("没有拿到 Shizuku 服务");
      byte[] jpeg = s.captureScreen();
      return jpeg == null ? new byte[0] : jpeg;
    } finally {
      main.post(() -> {
        try {
          Shizuku.unbindUserService(args, conn, true);
        } catch (Throwable t) {
          Log.w(TAG, "unbind", t);
        }
      });
    }
  }

  /**
   * 获取当前媒体会话信息（音乐播放状态）
   */
  static JSObject getCurrentMediaSession(Context ctx) throws Exception {
    if (!hasPermission()) throw new IllegalStateException("还没有 Shizuku 授权");
    CountDownLatch latch = new CountDownLatch(1);
    AtomicReference<INianShizukuService> svc = new AtomicReference<>();
    AtomicReference<String> err = new AtomicReference<>();

    Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(
      new ComponentName(ctx.getPackageName(), ShizukuUserService.class.getName())
    )
      .daemon(false)
      .processNameSuffix("shizuku")
      .debuggable(false)
      .version(BuildConfig.VERSION_CODE);

    ServiceConnection conn = new ServiceConnection() {
      @Override
      public void onServiceConnected(ComponentName name, IBinder binder) {
        if (binder != null && binder.pingBinder()) {
          svc.set(INianShizukuService.Stub.asInterface(binder));
        } else {
          err.set("Shizuku 服务连接失败");
        }
        latch.countDown();
      }

      @Override
      public void onServiceDisconnected(ComponentName name) {
        svc.set(null);
      }
    };

    Handler main = new Handler(Looper.getMainLooper());
    main.post(() -> Shizuku.bindUserService(args, conn));
    boolean ok = latch.await(12, TimeUnit.SECONDS);
    try {
      if (!ok) throw new IllegalStateException("连接 Shizuku 超时");
      if (err.get() != null) throw new IllegalStateException(err.get());
      INianShizukuService s = svc.get();
      if (s == null) throw new IllegalStateException("没有拿到 Shizuku 服务");
      
      String json = s.getCurrentMediaSession();
      if (json == null || json.isEmpty()) {
        return null;
      }
      
      return new JSObject(json);
    } finally {
      main.post(() -> {
        try {
          Shizuku.unbindUserService(args, conn, true);
        } catch (Throwable t) {
          Log.w(TAG, "unbind", t);
        }
      });
    }
  }

  /**
   * 发送媒体控制命令（播放/暂停/下一首等）
   */
  static boolean sendMediaControl(Context ctx, String action) throws Exception {
    if (!hasPermission()) throw new IllegalStateException("还没有 Shizuku 授权");
    CountDownLatch latch = new CountDownLatch(1);
    AtomicReference<INianShizukuService> svc = new AtomicReference<>();
    AtomicReference<String> err = new AtomicReference<>();

    Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(
      new ComponentName(ctx.getPackageName(), ShizukuUserService.class.getName())
    )
      .daemon(false)
      .processNameSuffix("shizuku")
      .debuggable(false)
      .version(BuildConfig.VERSION_CODE);

    ServiceConnection conn = new ServiceConnection() {
      @Override
      public void onServiceConnected(ComponentName name, IBinder binder) {
        if (binder != null && binder.pingBinder()) {
          svc.set(INianShizukuService.Stub.asInterface(binder));
        } else {
          err.set("Shizuku 服务连接失败");
        }
        latch.countDown();
      }

      @Override
      public void onServiceDisconnected(ComponentName name) {
        svc.set(null);
      }
    };

    Handler main = new Handler(Looper.getMainLooper());
    main.post(() -> Shizuku.bindUserService(args, conn));
    boolean ok = latch.await(12, TimeUnit.SECONDS);
    try {
      if (!ok) throw new IllegalStateException("连接 Shizuku 超时");
      if (err.get() != null) throw new IllegalStateException(err.get());
      INianShizukuService s = svc.get();
      if (s == null) throw new IllegalStateException("没有拿到 Shizuku 服务");
      
      return s.sendMediaControl(action);
    } finally {
      main.post(() -> {
        try {
          Shizuku.unbindUserService(args, conn, true);
        } catch (Throwable t) {
          Log.w(TAG, "unbind", t);
        }
      });
    }
  }
}


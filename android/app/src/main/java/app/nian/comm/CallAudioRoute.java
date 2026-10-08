package app.nian.comm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;

/**
 * 戴蓝牙耳机打电话时，麦只挂在 HFP/SCO（或 LE Audio 通信设备）上。
 * 播 TTS 时可短暂切到 A2DP 媒体声道；听麦前必须再连回 SCO，并等连上再开麦。
 */
final class CallAudioRoute {
  private static final String TAG = "NianCallAudio";
  private static final long SCO_WAIT_MS = 8000;
  private static final Handler MAIN = new Handler(Looper.getMainLooper());

  private static int routeGen;
  private static boolean routed;
  private static boolean waitingSco;
  private static String routeName = "none";
  private static BroadcastReceiver scoReceiver;
  private static Runnable scoTimeout;
  private static final List<Runnable> pending = new ArrayList<>();
  private static boolean scoHeldForMedia;
  /** 正在为 TTS 走 A2DP：此期间禁止 preferCall 再抢 SCO。 */
  private static boolean mediaSuspended;

  private CallAudioRoute() {}

  static String currentRoute() {
    return routeName;
  }

  static void preferCall(Context ctx, Runnable done) {
    if (ctx == null) {
      finish(done);
      return;
    }
    Context app = ctx.getApplicationContext();
    AudioManager am = manager(app);
    if (am == null) {
      finish(done);
      return;
    }

    // TTS 播媒体时不要抢回 SCO，否则耳机出声又闷又断
    if (mediaSuspended) {
      finish(done);
      return;
    }

    if (waitingSco) {
      if (done != null) {
        synchronized (pending) {
          pending.add(done);
        }
      }
      return;
    }
    if (routed && isHeadsetRoute()) {
      finish(done);
      return;
    }
    if (routed && "builtin".equals(routeName) && !hasBtOutput(am) && findWired(am) == null) {
      finish(done);
      return;
    }
    // a2dp 回退或路由过期：允许再抢一次 SCO，否则耳机麦一直用不了
    routed = false;

    AudioDeviceInfo ble = findBle(am);
    AudioDeviceInfo sco = findType(am, AudioDeviceInfo.TYPE_BLUETOOTH_SCO);
    AudioDeviceInfo wired = findWired(am);
    boolean btOut = hasBtOutput(am);

    if (ble != null && Build.VERSION.SDK_INT >= 31) {
      beginRoute("ble");
      stopScoQuiet(am);
      setModeComm(am);
      setSpeakerOff(am);
      try {
        am.setCommunicationDevice(ble);
      } catch (Exception ignored) {}
      routed = true;
      requestFocus(am, false);
      finish(done);
      return;
    }

    if (sco != null || btOut) {
      int gen = beginRoute("sco");
      setModeComm(am);
      setSpeakerOff(am);
      if (Build.VERSION.SDK_INT >= 31 && sco != null) {
        try {
          am.setCommunicationDevice(sco);
        } catch (Exception ignored) {}
      }
      if (am.isBluetoothScoOn()) {
        routed = true;
        requestFocus(am, false);
        finish(done);
        return;
      }
      waitSco(app, am, gen, done);
      return;
    }

    if (wired != null) {
      beginRoute("wired");
      stopScoQuiet(am);
      setModeComm(am);
      setSpeakerOff(am);
      if (Build.VERSION.SDK_INT >= 31) {
        try {
          am.setCommunicationDevice(wired);
        } catch (Exception ignored) {}
      }
      routed = true;
      requestFocus(am, false);
      finish(done);
      return;
    }

    routeBuiltinSpeaker(am);
    finish(done);
  }

  /** 听麦前：有蓝牙就尽量回到 SCO/BLE，连上后再回调。 */
  static void ensureMicRoute(Context ctx, Runnable done) {
    Context app = ctx != null ? ctx.getApplicationContext() : null;
    AudioManager am = manager(app);
    if (am == null) {
      finish(done);
      return;
    }
    // 正在播 TTS：不要抢 SCO，等 resumeAfterMedia
    if (mediaSuspended) {
      finish(done);
      return;
    }
    if (isHeadsetRoute() && (am.isBluetoothScoOn() || "ble".equals(routeName) || "wired".equals(routeName))) {
      finish(done);
      return;
    }
    if (!hasBtOutput(am) && findWired(am) == null && !hasHeadsetInput(app)) {
      finish(done);
      return;
    }
    routed = false;
    preferCall(app, done);
  }

  private static void routeBuiltinSpeaker(AudioManager am) {
    beginRoute("builtin");
    stopScoQuiet(am);
    setModeComm(am);
    setSpeakerOn(am);
    routed = true;
    requestFocus(am, true);
  }

  /** SCO 没连上时不要改走手机扬声器：戴着蓝牙耳机只会听见一片安静。 */
  private static void routeBtMedia(AudioManager am) {
    beginRoute("a2dp");
    stopScoQuiet(am);
    try {
      am.setMode(AudioManager.MODE_NORMAL);
    } catch (Exception ignored) {}
    setSpeakerOff(am);
    if (Build.VERSION.SDK_INT >= 31) {
      try {
        am.clearCommunicationDevice();
      } catch (Exception ignored) {}
    }
    routed = true;
    requestFocus(am, true);
  }

  static void release(Context ctx) {
    routeGen++;
    routed = false;
    waitingSco = false;
    scoHeldForMedia = false;
    mediaSuspended = false;
    routeName = "none";
    List<Runnable> dropped;
    synchronized (pending) {
      dropped = new ArrayList<>(pending);
      pending.clear();
    }
    for (Runnable r : dropped) finish(r);
    Context app = ctx != null ? ctx.getApplicationContext() : null;
    cleanupScoWait(app);
    if (app == null) return;
    AudioManager am = manager(app);
    if (am == null) return;
    stopScoQuiet(am);
    try {
      am.setSpeakerphoneOn(false);
    } catch (Exception ignored) {}
    try {
      am.setMode(AudioManager.MODE_NORMAL);
    } catch (Exception ignored) {}
    if (Build.VERSION.SDK_INT >= 31) {
      try {
        am.clearCommunicationDevice();
      } catch (Exception ignored) {}
    }
    abandonFocus(am);
  }

  static boolean hasHeadsetInput(Context ctx) {
    if (ctx == null || Build.VERSION.SDK_INT < 23) return false;
    AudioManager am = manager(ctx);
    if (am == null) return false;
    try {
      AudioDeviceInfo[] devices = am.getDevices(AudioManager.GET_DEVICES_INPUTS);
      for (AudioDeviceInfo d : devices) {
        if (isHeadsetInputType(d.getType())) return true;
      }
    } catch (Exception ignored) {}
    if (Build.VERSION.SDK_INT >= 31) {
      try {
        List<AudioDeviceInfo> comm = am.getAvailableCommunicationDevices();
        for (AudioDeviceInfo d : comm) {
          if (isHeadsetInputType(d.getType())) return true;
        }
      } catch (Exception ignored) {}
    }
    return false;
  }

  static boolean isScoOn(Context ctx) {
    AudioManager am = manager(ctx);
    return am != null && am.isBluetoothScoOn();
  }

  static boolean isHeadsetRouted() {
    return isHeadsetRoute();
  }

  /** TTS 正在走 A2DP/媒体通路（SCO 已卸）。 */
  static boolean isMediaSuspended() {
    return mediaSuspended;
  }

  /** 播媒体前先卸 SCO；播完用 {@link #resumeAfterMedia} 等 SCO 再开麦。 */
  static void suspendScoForMedia(Context ctx, Runnable done) {
    Context app = ctx != null ? ctx.getApplicationContext() : null;
    AudioManager am = manager(app);
    boolean waitA2dp = false;
    routeGen++;
    waitingSco = false;
    cleanupScoWait(app);
    if (am != null) {
      boolean wasSco = am.isBluetoothScoOn() || "sco".equals(routeName) || "ble".equals(routeName);
      if (wasSco) {
        scoHeldForMedia = true;
        mediaSuspended = true;
      }
      stopScoQuiet(am);
      try {
        am.setMode(AudioManager.MODE_NORMAL);
      } catch (Exception ignored) {}
      AudioDeviceInfo wired = findWired(am);
      routed = false;
      if (hasBtOutput(am)) {
        setSpeakerOff(am);
        routeName = "a2dp";
        waitA2dp = wasSco;
        requestFocus(am, true);
      } else if (wired != null) {
        setSpeakerOff(am);
        routeName = "wired";
        routed = true;
        requestFocus(am, true);
      } else {
        setSpeakerOn(am);
        routeName = "builtin";
        routed = true;
        requestFocus(am, true);
      }
    }
    if (waitA2dp) {
      // SCO→A2DP 太急会让首句前半截发闷/发小；等 SCO 真正卸掉再播
      waitA2dpReady(app, done, 1100);
    } else {
      finish(done);
    }
  }

  private static void waitA2dpReady(Context app, Runnable done, long maxMs) {
    final long start = android.os.SystemClock.uptimeMillis();
    final int gen = routeGen;
    Runnable poll = new Runnable() {
      @Override
      public void run() {
        if (gen != routeGen) return;
        AudioManager am = manager(app);
        boolean scoOff = am == null || !am.isBluetoothScoOn();
        boolean hasOut = am != null && hasBtOutput(am);
        long elapsed = android.os.SystemClock.uptimeMillis() - start;
        // 至少缓 280ms，再等 SCO 掉或超时
        if ((elapsed >= 280 && scoOff && hasOut) || elapsed >= maxMs) {
          finish(done);
          return;
        }
        MAIN.postDelayed(this, 70);
      }
    };
    MAIN.postDelayed(poll, 200);
  }

  static void resumeAfterMedia(Context ctx, Runnable done) {
    mediaSuspended = false;
    if (!scoHeldForMedia) {
      finish(done);
      return;
    }
    scoHeldForMedia = false;
    routed = false;
    preferCall(ctx, done);
  }

  /** AudioRecord 应绑到的输入设备（SCO / BLE / 有线）。 */
  static AudioDeviceInfo preferredInputDevice(AudioManager am) {
    if (am == null || Build.VERSION.SDK_INT < 23) return null;
    AudioDeviceInfo ble = findBle(am);
    if (ble != null) return ble;
    AudioDeviceInfo sco = findType(am, AudioDeviceInfo.TYPE_BLUETOOTH_SCO);
    if (sco != null) return sco;
    return findWired(am);
  }

  private static boolean isHeadsetRoute() {
    return "sco".equals(routeName) || "ble".equals(routeName) || "wired".equals(routeName);
  }

  private static int beginRoute(String name) {
    routeGen++;
    routeName = name;
    Log.i(TAG, "route " + name);
    return routeGen;
  }

  private static void finish(Runnable done) {
    if (done != null) MAIN.post(done);
  }

  private static void flushPending(Runnable done) {
    List<Runnable> extra;
    synchronized (pending) {
      extra = new ArrayList<>(pending);
      pending.clear();
    }
    finish(done);
    for (Runnable r : extra) finish(r);
  }

  private static void waitSco(Context app, AudioManager am, int gen, Runnable done) {
    cleanupScoWait(app);
    waitingSco = true;
    final boolean[] finished = { false };
    Runnable complete = () -> {
      if (finished[0]) return;
      finished[0] = true;
      waitingSco = false;
      cleanupScoWait(app);
      if (gen != routeGen) return;
      if (am.isBluetoothScoOn()) {
        routed = true;
        requestFocus(am, false);
        Log.i(TAG, "SCO connected");
      } else if (hasBtOutput(am)) {
        Log.w(TAG, "SCO timeout, keep A2DP so headphones still play");
        routeBtMedia(am);
      } else {
        Log.w(TAG, "SCO timeout, fallback speaker");
        routeBuiltinSpeaker(am);
      }
      flushPending(done);
    };
    scoReceiver = new BroadcastReceiver() {
      @Override
      public void onReceive(Context c, Intent intent) {
        int state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1);
        if (state == AudioManager.SCO_AUDIO_STATE_CONNECTED) {
          MAIN.post(complete);
        }
      }
    };
    IntentFilter filter = new IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED);
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        app.registerReceiver(scoReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
      } else {
        app.registerReceiver(scoReceiver, filter);
      }
    } catch (Exception e) {
      scoReceiver = null;
    }
    try {
      am.startBluetoothSco();
      am.setBluetoothScoOn(true);
    } catch (Exception ignored) {}
    scoTimeout = complete;
    MAIN.postDelayed(complete, SCO_WAIT_MS);
  }

  private static void cleanupScoWait(Context app) {
    if (scoTimeout != null) {
      MAIN.removeCallbacks(scoTimeout);
      scoTimeout = null;
    }
    if (scoReceiver != null && app != null) {
      try {
        app.unregisterReceiver(scoReceiver);
      } catch (Exception ignored) {}
    }
    scoReceiver = null;
  }

  private static void setModeComm(AudioManager am) {
    try {
      am.setMode(AudioManager.MODE_IN_COMMUNICATION);
    } catch (Exception ignored) {}
  }

  private static void setSpeakerOff(AudioManager am) {
    try {
      am.setSpeakerphoneOn(false);
    } catch (Exception ignored) {}
  }

  private static void setSpeakerOn(AudioManager am) {
    try {
      am.setSpeakerphoneOn(true);
    } catch (Exception ignored) {}
    if (Build.VERSION.SDK_INT >= 31) {
      try {
        AudioDeviceInfo spk = findType(am, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
        if (spk != null) am.setCommunicationDevice(spk);
      } catch (Exception ignored) {}
    }
  }

  @SuppressWarnings("deprecation")
  private static void requestFocus(AudioManager am, boolean speaker) {
    if (am == null) return;
    try {
      // 通话内播角色声时用 MAY_DUCK：不要 AUDIOFOCUS_GAIN 把 WebView/垫音整段停掉
      // （现场环境音要和人声同时出）
      int dur = speaker
        ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        : AudioManager.AUDIOFOCUS_GAIN;
      am.requestAudioFocus(
        null,
        speaker ? AudioManager.STREAM_MUSIC : AudioManager.STREAM_VOICE_CALL,
        dur
      );
    } catch (Exception ignored) {}
  }

  @SuppressWarnings("deprecation")
  private static void abandonFocus(AudioManager am) {
    if (am == null) return;
    try {
      am.abandonAudioFocus(null);
    } catch (Exception ignored) {}
  }

  private static void stopScoQuiet(AudioManager am) {
    try {
      am.stopBluetoothSco();
    } catch (Exception ignored) {}
    try {
      am.setBluetoothScoOn(false);
    } catch (Exception ignored) {}
    if (Build.VERSION.SDK_INT >= 31) {
      try {
        am.clearCommunicationDevice();
      } catch (Exception ignored) {}
    }
  }

  private static AudioDeviceInfo findBle(AudioManager am) {
    if (Build.VERSION.SDK_INT < 31) return null;
    return findType(am, AudioDeviceInfo.TYPE_BLE_HEADSET);
  }

  private static AudioDeviceInfo findWired(AudioManager am) {
    AudioDeviceInfo usbHeadset = null;
    if (Build.VERSION.SDK_INT >= 26) {
      usbHeadset = findType(am, AudioDeviceInfo.TYPE_USB_HEADSET);
    }
    if (usbHeadset != null) return usbHeadset;
    AudioDeviceInfo wired = findType(am, AudioDeviceInfo.TYPE_WIRED_HEADSET);
    if (wired != null) return wired;
    return findType(am, AudioDeviceInfo.TYPE_USB_DEVICE);
  }

  private static AudioDeviceInfo findType(AudioManager am, int type) {
    if (am == null || Build.VERSION.SDK_INT < 23) return null;
    if (Build.VERSION.SDK_INT >= 31) {
      try {
        for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
          if (d.getType() == type) return d;
        }
      } catch (Exception ignored) {}
    }
    try {
      for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
        if (d.getType() == type) return d;
      }
    } catch (Exception ignored) {}
    try {
      for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
        if (d.getType() == type) return d;
      }
    } catch (Exception ignored) {}
    return null;
  }

  private static boolean hasBtOutput(AudioManager am) {
    if (am == null || Build.VERSION.SDK_INT < 23) return false;
    try {
      for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
        int t = d.getType();
        if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
          return true;
        }
        if (Build.VERSION.SDK_INT >= 31 && t == AudioDeviceInfo.TYPE_BLE_HEADSET) {
          return true;
        }
      }
    } catch (Exception ignored) {}
    return false;
  }

  private static boolean isHeadsetInputType(int t) {
    if (t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
      || t == AudioDeviceInfo.TYPE_USB_HEADSET
      || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
      || t == AudioDeviceInfo.TYPE_USB_DEVICE) {
      return true;
    }
    return Build.VERSION.SDK_INT >= 31 && t == AudioDeviceInfo.TYPE_BLE_HEADSET;
  }

  private static AudioManager manager(Context ctx) {
    if (ctx == null) return null;
    return (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
  }
}

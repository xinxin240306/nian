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
  /** 刚把外放切回通话扬声器时，播放端要等这一时刻再 start，避免开头被吃掉。 */
  private static long speakerPrerollUntil;

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
      if (headsetRouteAlive(am)) {
        finish(done);
        return;
      }
      routed = false;
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
    // 外放不要进通话模式、也不要开 speakerphone。那条通路的音量锁在通话流上，
    // 系统音量面板调的是媒体，听起来就是很大而且怎么拧都不变。
    // 媒体流在普通模式下默认就从扬声器出来。
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
    speakerPrerollUntil = 0;
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

  /** 外放刚切过通话模式时，还要等多少毫秒再出声。 */
  static long speakerPrerollDelayMs() {
    long d = speakerPrerollUntil - android.os.SystemClock.uptimeMillis();
    return d > 0 ? d : 0;
  }

  /** 播媒体前先卸 SCO；播完用 {@link #resumeAfterMedia} 等 SCO 再开麦。 */
  static void suspendScoForMedia(Context ctx, Runnable done) {
    Context app = ctx != null ? ctx.getApplicationContext() : null;
    AudioManager am = manager(app);
    if (am == null) {
      finish(done);
      return;
    }
    // 这一轮已经在媒体路上、SCO 也没再连上：不要每次开口都 stopSco/setMode。
    // 重复切一次，首句前半截就会噎住，说到一半还会空一段。
    boolean scoOn = am.isBluetoothScoOn();
    boolean bt = hasBtOutput(am);
    AudioDeviceInfo wiredNow = findWired(am);
    if (mediaSuspended && !scoOn && !waitingSco) {
      if (bt && "a2dp".equals(routeName)) {
        finish(done);
        return;
      }
      if (!bt && wiredNow != null && "wired".equals(routeName)) {
        finish(done);
        return;
      }
      if (!bt && wiredNow == null && "builtin".equals(routeName)) {
        finish(done);
        return;
      }
    }

    routeGen++;
    waitingSco = false;
    cleanupScoWait(app);
    boolean wasSco = scoOn || "sco".equals(routeName) || "ble".equals(routeName);
    // 先占住，避免设备回调在 SCO 卸掉的空档里又把通话路由抢回来
    mediaSuspended = true;
    if (wasSco) scoHeldForMedia = true;
    if (wasSco || scoOn) stopScoQuiet(am);
    routed = false;
    if (bt) {
      // 耳机走媒体声道，必须离开通话模式，否则会卡在 SCO 上断断续续
      try {
        am.setMode(AudioManager.MODE_NORMAL);
      } catch (Exception ignored) {}
      setSpeakerOff(am);
      routeName = "a2dp";
      speakerPrerollUntil = 0;
      requestFocus(am, true);
      // 等 SCO 真正灭掉并稳住，再放行开播。旗标一掉就开播，后半段路由提交会把正在读的话掐掉。
      waitA2dpReady(app, done, 1800);
      return;
    }
    if (wiredNow != null) {
      try {
        am.setMode(AudioManager.MODE_NORMAL);
      } catch (Exception ignored) {}
      setSpeakerOff(am);
      routeName = "wired";
      routed = true;
      requestFocus(am, true);
      speakerPrerollUntil = android.os.SystemClock.uptimeMillis() + 420;
      finish(done);
      return;
    }
    // 外放跟耳机一样走媒体流，音量跟系统媒体键。
    // 通话模式 + 扬声器会把声音锁在通话音量上，面板里的媒体滑条完全没用。
    try {
      am.setMode(AudioManager.MODE_NORMAL);
    } catch (Exception ignored) {}
    setSpeakerOff(am);
    if (Build.VERSION.SDK_INT >= 31) {
      try {
        am.clearCommunicationDevice();
      } catch (Exception ignored) {}
    }
    routeName = "builtin";
    routed = true;
    requestFocus(am, true);
    // 模式本来就是普通模式时也要等。setPreferredDevice 落到扬声器之前开播，前半句会进听筒。
    speakerPrerollUntil = android.os.SystemClock.uptimeMillis() + 420;
    finish(done);
  }

  private static void waitA2dpReady(Context app, Runnable done, long maxMs) {
    final long start = android.os.SystemClock.uptimeMillis();
    final int gen = routeGen;
    final long[] scoQuietSince = { -1 };
    Runnable poll = new Runnable() {
      @Override
      public void run() {
        if (gen != routeGen) return;
        AudioManager am = manager(app);
        boolean scoOff = am == null || !am.isBluetoothScoOn();
        boolean hasOut = am != null && hasBtOutput(am);
        long now = android.os.SystemClock.uptimeMillis();
        long elapsed = now - start;
        if (scoOff && hasOut) {
          if (scoQuietSince[0] < 0) scoQuietSince[0] = now;
        } else {
          scoQuietSince[0] = -1;
        }
        boolean stable = scoQuietSince[0] > 0 && now - scoQuietSince[0] >= 700;
        if (stable || elapsed >= maxMs) {
          Log.i(TAG, "a2dp ready elapsed=" + elapsed + " stable=" + stable);
          finish(done);
          return;
        }
        MAIN.postDelayed(this, 80);
      }
    };
    MAIN.post(poll);
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

  /** 外放播放钉在手机扬声器上，避免普通模式仍把开头送进听筒。 */
  static AudioDeviceInfo builtinSpeaker(Context ctx) {
    return findType(manager(ctx), AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
  }

  /** AudioRecord 应绑到的输入设备。耳机路由或已经连上的耳机麦优先，否则用手机麦。 */
  static AudioDeviceInfo preferredInputDevice(AudioManager am) {
    if (am == null || Build.VERSION.SDK_INT < 23) return null;
    AudioDeviceInfo wired = findWired(am);
    AudioDeviceInfo ble = findBle(am);
    AudioDeviceInfo sco = findType(am, AudioDeviceInfo.TYPE_BLUETOOTH_SCO);
    if ("wired".equals(routeName) && wired != null) return wired;
    if ("ble".equals(routeName)) {
      if (ble != null) return ble;
      if (sco != null) return sco;
    }
    if ("sco".equals(routeName) || am.isBluetoothScoOn()) {
      if (sco != null) return sco;
      if (ble != null) return ble;
    }
    // 有线耳机自带麦，不依赖 SCO。蓝牙只有 HFP/SCO 或 LE 耳机才有麦，纯 A2DP 仍用手机麦。
    if (wired != null) return wired;
    if (ble != null) return ble;
    return null;
  }

  /** 当前耳机路由对应的设备还在不在。拔掉后要重新选路，不能一直停在 sco。 */
  private static boolean headsetRouteAlive(AudioManager am) {
    if (am == null) return false;
    if ("wired".equals(routeName)) return findWired(am) != null;
    if ("ble".equals(routeName)) return findBle(am) != null;
    if ("sco".equals(routeName)) {
      return findType(am, AudioDeviceInfo.TYPE_BLUETOOTH_SCO) != null || hasBtOutput(am);
    }
    return false;
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
      // 现场环境音走媒体流。AUDIOFOCUS_GAIN 会把这条垫音整段停掉，
      // 听筒和扬声器都只用 MAY_DUCK，让人声和环境音同时出。
      am.requestAudioFocus(
        null,
        speaker ? AudioManager.STREAM_MUSIC : AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
      );
      // 播放走媒体流。音量键也钉在媒体上，避免面板在调通话音量。
      MainActivity.useMediaVolumeKeys(true);
    } catch (Exception ignored) {}
  }

  @SuppressWarnings("deprecation")
  private static void abandonFocus(AudioManager am) {
    if (am == null) return;
    try {
      am.abandonAudioFocus(null);
    } catch (Exception ignored) {}
    MainActivity.useMediaVolumeKeys(false);
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

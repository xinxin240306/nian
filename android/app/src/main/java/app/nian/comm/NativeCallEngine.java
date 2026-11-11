package app.nian.comm;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * 通话麦和对方声音走原生 AudioRecord / MediaPlayer，
 * 不经过 WebView getUserMedia，蓝牙 SCO 才能真正用上耳机麦。
 */
final class NativeCallEngine {
  interface PlayCallback {
    void onDone(boolean ok);
  }

  private static final String TAG = "NianCallEngine";
  private static final int[] RATES = { 16000, 8000, 44100 };
  private static final int[] TALK_SOURCES = {
    MediaRecorder.AudioSource.VOICE_COMMUNICATION,
    MediaRecorder.AudioSource.MIC
  };
  private static final Handler MAIN = new Handler(Looper.getMainLooper());
  private static final long LEVEL_EMIT_MS = 50;
  private static final int PREROLL_MS = 900;

  private static AppPermissionsPlugin plugin;
  private static Context appCtx;
  private static AudioRecord record;
  private static Thread recThread;
  private static MediaPlayer player;
  private static PlayCallback playDone;
  private static File playFile;
  private static int playGen;
  /** 通话现场循环垫音：与角色 TTS 分轨，走媒体流（跟媒体音量），角色开口时不停 */
  private static MediaPlayer bedPlayer;
  private static File bedFile;
  private static int bedGen;
  private static String bedUrl = "";
  private static float bedGain = 0.35f;
  /** 挂断或新一通开始时递增，丢掉上一通还在排队的垫音。 */
  private static int callEpoch;
  private static volatile boolean running;
  private static volatile boolean listen;
  private static volatile boolean capturing;
  private static volatile boolean paused;
  /**
   * 可选「原始环境麦」：关 AEC/NS、优先 UNPROCESSED。
   * 连麦默认不用——戴耳机时应和普通电话一样开通话降噪；
   * 环境感由多模态模型听录音内容，而不是关硬件降噪硬收。
   */
  private static volatile boolean ambientListen;
  /** 实时通话：角色说话时不断麦，只暂停写入，供前端 VAD 打断 */
  private static volatile boolean bargeInEnabled;
  private static AcousticEchoCanceler aecFx;
  private static NoiseSuppressor nsFx;
  private static AutomaticGainControl agcFx;
  private static volatile double lastRms;
  private static volatile long lastJsTickAt;
  private static volatile int bgSilenceMs = 3000;
  private static volatile int bgMaxMs = 20000;
  private static volatile double bgSpeechRms = 0.02;
  private static volatile boolean bgOwned;
  private static volatile boolean bgHeard;
  private static volatile int bgLoud;
  private static volatile long bgSilentAt;
  private static volatile long bgStart;
  private static volatile int bgGen;
  /** 连麦周期环境采样：走原生墙钟，不靠 WebView setTimeout（锁屏会冻） */
  private static volatile long ambientSampleIntervalMs;
  private static volatile long nextAmbientSampleAt;
  private static volatile boolean ambientSampleBusy;
  private static volatile int ambientSampleGen;
  private static String pendingAmbientB64;
  private static long pendingAmbientWallMs;
  private static final long AMBIENT_SAMPLE_CAPTURE_MS = 2500L;
  private static final long AMBIENT_SAMPLE_WATCH_MS = 12_000L;
  private static final Runnable ambientSampleWatch = new Runnable() {
    @Override public void run() {
      MAIN.removeCallbacks(this);
      if (!running || ambientSampleIntervalMs <= 0) return;
      MAIN.postDelayed(this, AMBIENT_SAMPLE_WATCH_MS);
      maybeFireAmbientSample();
      flushPendingAmbientSample();
    }
  };
  private static int sampleRate = 16000;
  private static final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
  private static byte[] ring = new byte[0];
  private static int ringPos;
  private static int ringLen;
  private static long lastLevelEmit;
  private static float playGain = 1f;
  private static int resumeGen;
  private static final long RESUME_SCO_HOLD_MS = 900;
  private static AudioDeviceCallback inputRouteCallback;
  private static int routeRefreshTries;

  private NativeCallEngine() {}

  static void setPlugin(AppPermissionsPlugin p) {
    plugin = p;
    if (p == null) return;
    try {
      Context ctx = p.getContext();
      if (ctx != null) appCtx = ctx.getApplicationContext();
    } catch (Exception ignored) {}
  }

  static synchronized String start(Context ctx) {
    if (ctx != null) appCtx = ctx.getApplicationContext();
    if (running && record != null) {
      try {
        KeepAliveService.setCallMedia(appCtx, true, ScreenShareOverlay.isCallVideo());
      } catch (Exception ignored) {}
      MainActivity.setKeepWebAlive(true);
      return null;
    }
    boolean fresh = !running;
    if (fresh) {
      callEpoch++;
      final int epoch = callEpoch;
      // 新一通开始时丢掉上一通还没停干净的循环垫音
      MAIN.post(() -> {
        if (epoch == callEpoch) stopBedLocked();
      });
    }
    stopRecordLocked();
    String err = openRecord();
    if (err != null) return err;
    running = true;
    listen = false;
    capturing = false;
    paused = false;
    lastRms = 0;
    inCallMode = true;
    resetRing();
    recThread = new Thread(NativeCallEngine::loop, "nian-call-mic");
    recThread.start();
    try {
      KeepAliveService.setCallMedia(appCtx, true, ScreenShareOverlay.isCallVideo());
    } catch (Exception ignored) {}
    MainActivity.setKeepWebAlive(true);
    CallLockTurn.attach(appCtx);
    watchInputRoute();
    Log.i(TAG, "started rate=" + sampleRate);
    return null;
  }

  static void stop() {
    callEpoch++;
    CallLockTurn.cancel();
    unwatchInputRoute();
    running = false;
    listen = false;
    bgGen++;
    resetBackgroundVad();
    capturing = false;
    ambientListen = false;
    bargeInEnabled = false;
    setAmbientSampleIntervalMs(0);
    ambientSampleBusy = false;
    pendingAmbientB64 = null;
    pendingAmbientWallMs = 0;
    inCallMode = false; // stop() = 退出通话模式
    resumeGen++;
    MAIN.post(() -> {
      stopPlayLocked(true, true, false);
      stopBedLocked();
    });
    synchronized (NativeCallEngine.class) {
      stopRecordLocked();
    }
    lastRms = 0;
    MainActivity.setKeepWebAlive(false);
    try {
      KeepAliveService.setCallMedia(appCtx, false, false);
    } catch (Exception ignored) {}
  }

  static void setListen(boolean on) {
    listen = on;
    if (!on) {
      bgGen++;
      resetBackgroundVad();
      capturing = false;
      synchronized (pcm) {
        pcm.reset();
      }
      resetRing();
    }
  }

  /** 前端还在跑 VAD 时打卡。页面被系统停掉后，由这里按同一套停顿把一句收走。 */
  static void noteJsTick(int silenceMs, int maxMs, double speechRms) {
    lastJsTickAt = System.currentTimeMillis();
    if (silenceMs >= 400 && silenceMs <= 60000) bgSilenceMs = silenceMs;
    if (maxMs >= 1000 && maxMs <= 120000) bgMaxMs = maxMs;
    if (speechRms >= 0.004 && speechRms <= 0.25) bgSpeechRms = speechRms;
    // 锁屏/切走后 WebView 偶尔还能打卡，但不能当真在跑 VAD：不要因此把原生正在收的一句丢掉
  }

  /** 亮屏回前台：麦常被系统掐死，重新绑一次。播 TTS 时别抢。 */
  static void onForeground() {
    if (!running) return;
    paused = false;
    flushPendingAmbientSample();
    MAIN.postDelayed(() -> {
      if (!running || player != null) return;
      try { rebindMic(); } catch (Exception ignored) {}
    }, 280);
  }

  static double level() {
    return lastRms;
  }

  static void setAmbientListen(boolean on) {
    ambientListen = on;
  }

  static boolean isAmbientListen() {
    return ambientListen;
  }

  /**
   * 连麦周期采环境动静。intervalMs<=0 关闭。
   * 用原生 Handler 墙钟，锁屏后 WebView 定时器冻住也能继续。
   */
  static void setAmbientSampleIntervalMs(long intervalMs) {
    long ms = Math.max(0L, intervalMs);
    ambientSampleIntervalMs = ms;
    MAIN.removeCallbacks(ambientSampleWatch);
    if (ms <= 0L || !running) {
      nextAmbientSampleAt = 0L;
      return;
    }
    // 从现在起算下一枪，避免一进连麦立刻再采一段
    nextAmbientSampleAt = System.currentTimeMillis() + ms;
    MAIN.post(ambientSampleWatch);
    Log.i(TAG, "ambient sample interval=" + ms + "ms");
  }

  /** 保活服务偶发泵一下，防止 OEM 把主线程延迟任务饿死 */
  static void pumpAmbientSampleWatch() {
    if (!running || ambientSampleIntervalMs <= 0L) return;
    maybeFireAmbientSample();
    flushPendingAmbientSample();
  }

  private static void maybeFireAmbientSample() {
    if (!running || !ambientListen || !listen || ambientSampleIntervalMs <= 0L) return;
    if (ambientSampleBusy || player != null || paused) return;
    long now = System.currentTimeMillis();
    if (nextAmbientSampleAt <= 0L || now < nextAmbientSampleAt) return;
    // 正在收用户那句：顺延半分钟，别打断
    if (capturing) {
      nextAmbientSampleAt = now + 30_000L;
      return;
    }
    nextAmbientSampleAt = now + ambientSampleIntervalMs;
    ambientSampleBusy = true;
    final int gen = ++ambientSampleGen;
    try {
      beginUtterance();
    } catch (Exception e) {
      ambientSampleBusy = false;
      Log.w(TAG, "ambient sample begin fail", e);
      return;
    }
    MAIN.postDelayed(() -> {
      if (gen != ambientSampleGen || !running) {
        ambientSampleBusy = false;
        return;
      }
      byte[] wav;
      try {
        wav = commitUtterance();
      } catch (Exception e) {
        ambientSampleBusy = false;
        Log.w(TAG, "ambient sample commit fail", e);
        return;
      }
      ambientSampleBusy = false;
      if (wav == null || wav.length < 800) {
        Log.i(TAG, "ambient sample empty, skip");
        return;
      }
      // 灭屏时页面冻住，环境采样也走原生一轮，不要等亮屏再交给 JS
      if (!MainActivity.isResumed()) {
        CallLockTurn.submit(wav, AMBIENT_SAMPLE_CAPTURE_MS, true);
        return;
      }
      deliverAmbientSample(wavBase64(wav), AMBIENT_SAMPLE_CAPTURE_MS);
    }, AMBIENT_SAMPLE_CAPTURE_MS);
  }

  private static void deliverAmbientSample(String b64, long wallMs) {
    if (b64 == null || b64.isEmpty()) return;
    pendingAmbientB64 = b64;
    pendingAmbientWallMs = wallMs;
    MAIN.post(NativeCallEngine::flushPendingAmbientSample);
  }

  private static void flushPendingAmbientSample() {
    final String b64 = pendingAmbientB64;
    final long wall = pendingAmbientWallMs;
    if (b64 == null || b64.isEmpty()) return;
    try {
      MainActivity.runJs(
        "try{window.__nianIngestNativeUtterance&&window.__nianIngestNativeUtterance("
          + JSONObject.quote(b64) + "," + wall + ",{periodic:true})}catch(e){}"
      );
    } catch (Exception ignored) {}
  }

  /** 前端成功吞下周期采样后清掉挂起，避免重复投递 */
  static void ackAmbientSample() {
    pendingAmbientB64 = null;
    pendingAmbientWallMs = 0;
  }

  static void setBargeInEnabled(boolean on) {
    bargeInEnabled = on;
  }

  static boolean isBargeInEnabled() {
    return bargeInEnabled;
  }

  /** AudioRecord 已开且线程在跑：听麦开着时不必每次 setListen(true) 都重绑。 */
  static boolean hasHealthyRecord() {
    return running && record != null;
  }

  /**
   * SCO/A2DP 切换后必须重开 AudioRecord，否则仍绑在手机麦上。
   * 在路由回调线程调用即可。
   */
  static synchronized void rebindMic() {
    if (!running) return;
    boolean keepListen = listen;
    // 角色说完 900ms 后会再绑一次麦。若前端已经开始录下一句，这里不能把 capturing 清掉，
    // 否则 commit 拿到空 WAV，连麦看起来像「从没把声音发出去」。
    boolean keepCapturing = capturing;
    // 重绑会停掉 AudioRecord；正在收的一句必须带走 PCM，否则 UI 已「停顿发送」却上传空音
    byte[] keptPcm = null;
    if (keepCapturing) {
      synchronized (pcm) {
        keptPcm = pcm.toByteArray();
      }
    }
    stopRecordOnlyLocked();
    String err = null;
    for (int attempt = 0; attempt < 3; attempt++) {
      err = openRecord();
      if (err == null) break;
      Log.w(TAG, "rebindMic open fail attempt=" + attempt + ": " + err);
      try { Thread.sleep(80L * (attempt + 1)); } catch (InterruptedException ignored) {}
    }
    if (err != null) {
      Log.w(TAG, "rebindMic failed: " + err);
      // 保留 running，稍后 loop/前端还可再试；不要永久听死
      listen = false;
      capturing = false;
      lastRms = 0;
      MAIN.postDelayed(() -> {
        if (!running || record != null) return;
        try { rebindMic(); } catch (Exception ignored) {}
      }, 900);
      return;
    }
    listen = keepListen;
    capturing = keepCapturing;
    if (keptPcm != null && keptPcm.length > 0) {
      synchronized (pcm) {
        pcm.reset();
        try { pcm.write(keptPcm); } catch (IOException ignored) {}
      }
    }
    paused = false;
    lastRms = 0;
    // 正在录一句时别清环缓：preroll 已在 begin 时写入 PCM；清环缓无害但避免多余抖动
    if (!keepCapturing) resetRing();
    recThread = new Thread(NativeCallEngine::loop, "nian-call-mic");
    recThread.start();
    Log.i(TAG, "rebindMic ok rate=" + sampleRate + " capturing=" + capturing
      + " keptPcm=" + (keptPcm != null ? keptPcm.length : 0));
  }

  /** 通话中途戴上或摘下耳机时改收音设备。角色正在说话时先等媒体通路让开。 */
  private static void watchInputRoute() {
    if (Build.VERSION.SDK_INT < 23 || appCtx == null || inputRouteCallback != null) return;
    AudioManager am = (AudioManager) appCtx.getSystemService(Context.AUDIO_SERVICE);
    if (am == null) return;
    inputRouteCallback = new AudioDeviceCallback() {
      @Override
      public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
        scheduleRouteRefresh();
      }

      @Override
      public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
        scheduleRouteRefresh();
      }
    };
    try {
      am.registerAudioDeviceCallback(inputRouteCallback, MAIN);
    } catch (Exception e) {
      inputRouteCallback = null;
      Log.w(TAG, "watch input route", e);
    }
  }

  private static void unwatchInputRoute() {
    MAIN.removeCallbacks(routeRefresh);
    if (Build.VERSION.SDK_INT < 23 || appCtx == null || inputRouteCallback == null) {
      inputRouteCallback = null;
      return;
    }
    try {
      AudioManager am = (AudioManager) appCtx.getSystemService(Context.AUDIO_SERVICE);
      if (am != null) am.unregisterAudioDeviceCallback(inputRouteCallback);
    } catch (Exception ignored) {}
    inputRouteCallback = null;
  }

  private static void scheduleRouteRefresh() {
    routeRefreshTries = 0;
    MAIN.removeCallbacks(routeRefresh);
    MAIN.postDelayed(routeRefresh, 350);
  }

  private static final Runnable routeRefresh = new Runnable() {
    @Override
    public void run() {
      if (!running) return;
      // 角色还在说时不要抢回 SCO。次数只在真正空闲时累加，避免长句把重试次数耗尽。
      if (CallAudioRoute.isMediaSuspended() || player != null) {
        if (routeRefreshTries++ < 40) MAIN.postDelayed(this, 500);
        return;
      }
      final String before = CallAudioRoute.currentRoute();
      final boolean scoBefore = CallAudioRoute.isScoOn(appCtx);
      CallAudioRoute.preferCall(appCtx, () -> {
        if (!running) return;
        String after = CallAudioRoute.currentRoute();
        boolean scoAfter = CallAudioRoute.isScoOn(appCtx);
        if (!before.equals(after) || scoBefore != scoAfter) rebindMic();
      });
    }
  };

  static void setPaused(boolean on) {
    paused = on;
    if (on) {
      lastRms = 0;
    } else {
      // 对方说完再开口：丢掉播放期间攒下的环缓，避免把角色声叠进你的气泡
      resetRing();
    }
  }

  static boolean isRunning() {
    return running;
  }

  static synchronized void beginUtterance() {
    byte[] pre = takeRing();
    synchronized (pcm) {
      pcm.reset();
      if (pre.length > 0) {
        try { pcm.write(pre); } catch (IOException ignored) {}
      }
    }
    capturing = true;
  }

  static synchronized byte[] commitUtterance() {
    capturing = false;
    byte[] raw;
    synchronized (pcm) {
      raw = pcm.toByteArray();
      pcm.reset();
    }
    if (raw.length < 800) return new byte[0];
    return pcmToWav(raw, sampleRate, 1);
  }

  static synchronized void abortUtterance() {
    capturing = false;
    synchronized (pcm) {
      pcm.reset();
    }
  }

  static void play(String url, PlayCallback done) {
    play(url, 1f, done);
  }

  static void play(String url, float gain, PlayCallback done) {
    MAIN.post(() -> {
      playGain = clampGain(gain);
      playOnMain(url, null, null, done);
    });
  }

  static void playBytes(byte[] data, String mime, PlayCallback done) {
    playBytes(data, mime, 1f, done);
  }

  static void playBytes(byte[] data, String mime, float gain, PlayCallback done) {
    MAIN.post(() -> {
      playGain = clampGain(gain);
      playOnMain(null, data, mime, done);
    });
  }

  private static float clampGain(float g) {
    if (!(g > 0f)) return 1f;
    // 只在播放器内部变轻，不超过 1。超过 1 以前会去抬系统媒体音量。
    return Math.max(0.05f, Math.min(1f, g));
  }

  static void stopPlay() {
    MAIN.post(() -> {
      playGen++;
      // 主动停 = 未播完，勿当 success，否则前端会立刻播下一段造成「跳句」
      stopPlayLocked(true, false, true);
    });
  }

  /** 通话现场循环垫音：与角色说话同时出声，不因 TTS 启停而掐断 */
  static void playBed(String url, float gain) {
    final int epoch = callEpoch;
    MAIN.post(() -> {
      if (epoch != callEpoch || !running) return;
      playBedOnMain(url, gain, epoch);
    });
  }

  static void stopBed() {
    MAIN.post(NativeCallEngine::stopBedLocked);
  }

  private static void playBedOnMain(String url, float gain, int epoch) {
    String src = url != null ? url.trim() : "";
    if (epoch != callEpoch || !running || src.isEmpty()) {
      if (src.isEmpty()) stopBedLocked();
      return;
    }
    bedGain = gain > 0f ? Math.max(0.02f, Math.min(1f, gain)) : 0.35f;
    if (src.equals(bedUrl) && bedPlayer != null) {
      try { bedPlayer.setVolume(bedGain, bedGain); } catch (Exception ignored) {}
      try {
        if (!bedPlayer.isPlaying()) bedPlayer.start();
      } catch (Exception ignored) {}
      return;
    }
    stopBedLocked();
    bedUrl = src;
    final int gen = ++bedGen;
    MediaPlayer mp = new MediaPlayer();
    bedPlayer = mp;
    try {
      if (Build.VERSION.SDK_INT >= 21) {
        // 现场环境音跟系统媒体音量。绑到 USAGE_VOICE_COMMUNICATION 时，
        // 音量面板里的「媒体」调不到它，只会跟着通话音量变。
        try {
          mp.setAudioAttributes(buildBedAttrs());
        } catch (Exception e) {
          Log.w(TAG, "bed media attr refused", e);
          try { mp.setAudioAttributes(buildPlayAttrs(false)); } catch (Exception ignored) {}
        }
      }
      if (src.startsWith("blob:") || src.startsWith("data:")) {
        throw new IOException("webview blob");
      }
      mp.setDataSource(src);
      mp.setLooping(true);
      pinBuiltinSpeaker(mp);
      mp.setOnPreparedListener(p -> {
        if (epoch != callEpoch || !running || gen != bedGen || bedPlayer != p) {
          try { p.release(); } catch (Exception ignored) {}
          if (bedPlayer == p) bedPlayer = null;
          return;
        }
        try {
          p.setVolume(bedGain, bedGain);
          p.start();
          Log.i(TAG, "bed started vol=" + bedGain);
        } catch (Exception e) {
          Log.w(TAG, "bed start failed", e);
          stopBedLocked();
        }
      });
      mp.setOnErrorListener((p, what, extra) -> {
        Log.w(TAG, "bed error " + what + "/" + extra);
        if (gen == bedGen) stopBedLocked();
        return true;
      });
      mp.prepareAsync();
    } catch (Exception e) {
      Log.w(TAG, "bed play failed", e);
      stopBedLocked();
    }
  }

  private static void stopBedLocked() {
    bedGen++;
    bedUrl = "";
    MediaPlayer mp = bedPlayer;
    bedPlayer = null;
    if (mp != null) {
      try { mp.stop(); } catch (Exception ignored) {}
      try { mp.release(); } catch (Exception ignored) {}
    }
    File f = bedFile;
    bedFile = null;
    if (f != null) {
      try { f.delete(); } catch (Exception ignored) {}
    }
  }

  private static void playOnMain(String url, byte[] data, String mime, PlayCallback done) {
    // 打断上一句必须 ok=false：若报 success，JS 会以为本段播完并立刻开下一段 → 听感像跳字/跳句
    stopPlayLocked(true, false, false);
    resumeGen++; // 取消上一句播完后挂起的 SCO 恢复，同轮连播保持媒体通路
    final int gen = ++playGen;
    boolean hasUrl = url != null && !url.trim().isEmpty();
    boolean hasData = data != null && data.length > 0;
    if (!hasUrl && !hasData) {
      if (done != null) done.onDone(false);
      return;
    }
    playDone = done;
    // 实时打断：麦不断，只停写入；否则释放麦（系统「正在使用麦克风」提示会消失）
    synchronized (NativeCallEngine.class) {
      if (running && record != null) {
        if (bargeInEnabled) {
          capturing = false;
          synchronized (pcm) {
            pcm.reset();
          }
          resetRing();
        } else {
          stopRecordOnlyLocked();
        }
      }
    }
    paused = true;
    CallAudioRoute.suspendScoForMedia(appCtx, () -> {
      if (gen != playGen) return;
      // 抢焦点时系统可能把媒体轨垫音暂停，开播前拉回来
      reviveBedLocked();
      // 路由切稳后直接满音量开播，把切换毛刺顶过去；不做淡入（淡入会让短句整句发虚）
      beginPlayer(url, data, mime, gen);
    });
  }

  private static void beginPlayer(String url, byte[] data, String mime, int gen) {
    boolean hasUrl = url != null && !url.trim().isEmpty();
    boolean hasData = data != null && data.length > 0;
    MediaPlayer mp = new MediaPlayer();
    player = mp;
    try {
      if (Build.VERSION.SDK_INT >= 21) {
        // 角色声一律走媒体流，音量跟系统「媒体」键。
        // 外放若标 USAGE_VOICE_COMMUNICATION，会锁在通话音量上，面板怎么调都不变，而且扬声器特别响。
        try {
          mp.setAudioAttributes(buildPlayAttrs(false));
        } catch (Exception e) {
          Log.w(TAG, "media attr refused", e);
        }
      }
      pinBuiltinSpeaker(mp);
      if (hasData) {
        File f = writePlayFile(data, mime, gen);
        mp.setDataSource(f.getAbsolutePath());
      } else {
        String src = url.trim();
        if (src.startsWith("blob:") || src.startsWith("data:")) {
          throw new IOException("webview blob");
        }
        mp.setDataSource(src);
      }
      mp.setOnPreparedListener(p -> {
        if (gen != playGen || player != p) return;
        paused = true;
        try {
          float target = playGain > 0f ? playGain : 1f;
          // 音量只跟系统媒体键。不改 STREAM_MUSIC，也不在耳机上再抬一档。
          final float speakTarget = Math.min(1f, target);
          // 外放/有线刚钉过输出设备时，这里把开播推迟到路由落稳。耳机的等待在开播前已经做完。
          long preroll = CallAudioRoute.speakerPrerollDelayMs();
          Runnable start = () -> {
            if (gen != playGen || player != p) return;
            try {
              p.setVolume(speakTarget, speakTarget);
              p.start();
              reviveBedLocked();
            } catch (Exception e) {
              Log.w(TAG, "start failed", e);
              if (gen == playGen && player == p) stopPlayLocked(true, false, true);
            }
          };
          if (preroll > 0) MAIN.postDelayed(start, preroll);
          else start.run();
        } catch (Exception e) {
          Log.w(TAG, "start failed", e);
          if (gen == playGen && player == p) stopPlayLocked(true, false, true);
        }
      });
      mp.setOnCompletionListener(p -> {
        if (gen != playGen || player != p) return;
        stopPlayLocked(true, true, true);
      });
      mp.setOnErrorListener((p, what, extra) -> {
        if (gen != playGen || player != p) return true;
        Log.w(TAG, "play error " + what + "/" + extra);
        stopPlayLocked(true, false, true);
        return true;
      });
      mp.prepareAsync();
    } catch (Exception e) {
      Log.w(TAG, "play failed", e);
      if (gen == playGen) stopPlayLocked(true, false, true);
    }
  }

  private static volatile boolean inCallMode = false;
  static void setInCallMode(boolean on) { inCallMode = !!on; }
  static boolean isInCallMode() { return inCallMode; }

  /** 垫音固定媒体流，音量跟 STREAM_MUSIC，不跟通话音量。 */
  private static AudioAttributes buildBedAttrs() {
    return new AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
      .build();
  }

  private static void reviveBedLocked() {
    MediaPlayer mp = bedPlayer;
    if (mp == null) return;
    try { mp.setVolume(bedGain, bedGain); } catch (Exception ignored) {}
    try {
      if (!mp.isPlaying()) mp.start();
    } catch (Exception ignored) {}
  }

  private static void pinBuiltinSpeaker(MediaPlayer mp) {
    if (mp == null || !"builtin".equals(CallAudioRoute.currentRoute())) return;
    if (Build.VERSION.SDK_INT < 28) return;
    try {
      AudioDeviceInfo spk = CallAudioRoute.builtinSpeaker(appCtx);
      if (spk != null) mp.setPreferredDevice(spk);
    } catch (Exception ignored) {}
  }

  private static AudioAttributes buildPlayAttrs(boolean voiceComm) {
    AudioAttributes.Builder ab = new AudioAttributes.Builder()
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .setUsage(voiceComm ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_MEDIA);
    // 通话流 + 内容是 speech 时，AOSP 仍允许第三方 App 使用；
    // 部分定制 ROM 可能拒绝，回退由 setAudioAttributes 的 catch 处理。
    return ab.build();
  }

  private static File writePlayFile(byte[] data, String mime, int gen) throws IOException {
    Context ctx = appCtx;
    if (ctx == null) throw new IOException("no context");
    deletePlayFile();
    String ext = ".mp3";
    String m = mime == null ? "" : mime.toLowerCase();
    if (m.contains("wav")) ext = ".wav";
    else if (m.contains("ogg")) ext = ".ogg";
    else if (m.contains("mp4") || m.contains("m4a") || m.contains("aac")) ext = ".m4a";
    else if (m.contains("webm")) ext = ".webm";
    // 按 playGen 命名，避免并发/抢播时覆盖同一文件导致听感跳句
    File f = new File(ctx.getCacheDir(), "nian-call-play-" + gen + ext);
    try (FileOutputStream out = new FileOutputStream(f)) {
      out.write(data);
    }
    playFile = f;
    return f;
  }

  private static void deletePlayFile() {
    File f = playFile;
    playFile = null;
    if (f != null) {
      try { f.delete(); } catch (Exception ignored) {}
    }
  }

  private static void stopPlayLocked(boolean fireDone, boolean ok, boolean resume) {
    MediaPlayer mp = player;
    player = null;
    if (mp != null) {
      try { mp.stop(); } catch (Exception ignored) {}
      try { mp.release(); } catch (Exception ignored) {}
    }
    paused = false;
    resetRing();
    PlayCallback cb = playDone;
    playDone = null;
    reviveBedLocked();
    // 先回调前端，别把同轮下一句卡在 SCO 恢复上
    if (fireDone && cb != null) cb.onDone(ok);
    if (resume) {
      if (bargeInEnabled && running && record != null) {
        paused = false;
        resetRing();
      } else {
        // 同轮多句之间先别立刻抢回 SCO，否则下一句又要 SCO→媒体淡入
        final int gen = ++resumeGen;
        MAIN.postDelayed(() -> {
          if (gen != resumeGen || player != null) return;
          CallAudioRoute.resumeAfterMedia(appCtx, NativeCallEngine::rebindMic);
        }, RESUME_SCO_HOLD_MS);
      }
      // 锁屏/切到后台时 WebView 常冻住：前端 setCallSpeaking(false)/开麦到不了。
      // 播完后若页面仍未打卡，由原生自己重开 listen，并把 speaking 态清掉。
      scheduleBackgroundListenRearm();
    }
  }

  /**
   * TTS 播完后：锁屏或 WebView 冻住时前端 setCallSpeaking(false) 到不了，
   * 强制 listen=true 并注入 __nianCallPlayIdle，否则用户说话永远进不来 / 听起来像没声音。
   */
  private static void scheduleBackgroundListenRearm() {
    if (!running) return;
    final int gen = playGen;
    MAIN.postDelayed(() -> {
      if (gen != playGen || !running || player != null) return;
      long sinceTick = System.currentTimeMillis() - lastJsTickAt;
      // 亮屏但 JS 已停打卡（>2.5s）也当作冻住；仅在明确前台且 VAD 还活着时跳过
      boolean jsAlive = MainActivity.isResumed() && sinceTick >= 0 && sinceTick < 2500;
      if (jsAlive) return;
      if (!listen) {
        Log.i(TAG, "rearm listen after TTS (jsStuckOrBg sinceTick=" + sinceTick + ")");
        setListen(true);
      }
      if (record == null) {
        try { rebindMic(); } catch (Exception ignored) {}
      }
      try {
        MainActivity.runJs(
          "try{window.__nianCallPlayIdle&&window.__nianCallPlayIdle()}catch(e){}"
        );
      } catch (Exception ignored) {}
    }, RESUME_SCO_HOLD_MS + 400);
  }

  private static int[] recordSources() {
    if (ambientListen) {
      // 连麦睡觉要听到翻身/被单：UNPROCESSED/MIC 不带通话降噪。
      if (Build.VERSION.SDK_INT >= 24) {
        return new int[] {
          MediaRecorder.AudioSource.UNPROCESSED,
          MediaRecorder.AudioSource.MIC,
          MediaRecorder.AudioSource.VOICE_RECOGNITION,
          MediaRecorder.AudioSource.VOICE_COMMUNICATION
        };
      }
      return new int[] {
        MediaRecorder.AudioSource.MIC,
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        MediaRecorder.AudioSource.VOICE_COMMUNICATION
      };
    }
    return TALK_SOURCES;
  }

  private static void releaseCaptureFx() {
    try { if (aecFx != null) aecFx.release(); } catch (Exception ignored) {}
    aecFx = null;
    try { if (nsFx != null) nsFx.release(); } catch (Exception ignored) {}
    nsFx = null;
    try { if (agcFx != null) agcFx.release(); } catch (Exception ignored) {}
    agcFx = null;
  }

  private static void applyCaptureFx(AudioRecord ar) {
    releaseCaptureFx();
    if (ar == null) return;
    int session = ar.getAudioSessionId();
    try {
      if (AcousticEchoCanceler.isAvailable()) {
        aecFx = AcousticEchoCanceler.create(session);
        if (aecFx != null) aecFx.setEnabled(!ambientListen);
      }
    } catch (Exception ignored) {}
    try {
      if (NoiseSuppressor.isAvailable()) {
        nsFx = NoiseSuppressor.create(session);
        if (nsFx != null) nsFx.setEnabled(!ambientListen);
      }
    } catch (Exception ignored) {}
    try {
      if (AutomaticGainControl.isAvailable()) {
        agcFx = AutomaticGainControl.create(session);
        if (agcFx != null) agcFx.setEnabled(true);
      }
    } catch (Exception ignored) {}
  }

  private static String openRecord() {
    AudioManager am = appCtx != null
      ? (AudioManager) appCtx.getSystemService(Context.AUDIO_SERVICE)
      : null;
    AudioDeviceInfo prefer = CallAudioRoute.preferredInputDevice(am);
    for (int src : recordSources()) {
      for (int rate : RATES) {
        int min = AudioRecord.getMinBufferSize(
          rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) continue;
        int buf = Math.max(min, rate / 5 * 2);
        try {
          AudioRecord ar = new AudioRecord(
            src, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buf);
          if (ar.getState() != AudioRecord.STATE_INITIALIZED) {
            ar.release();
            continue;
          }
          if (prefer != null && Build.VERSION.SDK_INT >= 23) {
            try {
              boolean ok = ar.setPreferredDevice(prefer);
              Log.i(TAG, "preferred input type=" + prefer.getType() + " ok=" + ok);
            } catch (Exception e) {
              Log.w(TAG, "setPreferredDevice", e);
            }
          }
          ar.startRecording();
          if (ar.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
            ar.release();
            continue;
          }
          record = ar;
          sampleRate = rate;
          applyCaptureFx(ar);
          resetRing();
          Log.i(TAG, "openRecord src=" + src + " rate=" + rate + " ambient=" + ambientListen);
          return null;
        } catch (Exception e) {
          Log.w(TAG, "openRecord " + src + "/" + rate, e);
        }
      }
    }
    return "无法打开通话麦克风";
  }

  /** 只停录音线程与 AudioRecord，保留 running / listen 状态供重绑。 */
  private static void stopRecordOnlyLocked() {
    Thread t = recThread;
    recThread = null;
    AudioRecord ar = record;
    record = null;
    // 先让 loop 退出：临时关掉 running，停完再恢复
    boolean wasRunning = running;
    running = false;
    releaseCaptureFx();
    if (ar != null) {
      try { ar.stop(); } catch (Exception ignored) {}
      try { ar.release(); } catch (Exception ignored) {}
    }
    if (t != null && t != Thread.currentThread()) {
      try { t.join(500); } catch (Exception ignored) {}
    }
    running = wasRunning;
    // 不在这里 pcm.reset()：rebindMic 可能正在收一句，由调用方决定是否保留/清空
  }

  private static void stopRecordLocked() {
    running = false;
    listen = false;
    capturing = false;
    stopRecordOnlyLocked();
    synchronized (pcm) {
      pcm.reset();
    }
    resetRing();
    deletePlayFile();
  }

  private static int prerollBytes() {
    return Math.max(3200, sampleRate * 2 * PREROLL_MS / 1000);
  }

  private static void resetRing() {
    int n = prerollBytes();
    ring = new byte[n];
    ringPos = 0;
    ringLen = 0;
  }

  private static void pushRing(byte[] bytes) {
    if (ring == null || ring.length == 0 || bytes == null || bytes.length == 0) return;
    int n = bytes.length;
    if (n >= ring.length) {
      System.arraycopy(bytes, n - ring.length, ring, 0, ring.length);
      ringPos = 0;
      ringLen = ring.length;
      return;
    }
    int first = Math.min(n, ring.length - ringPos);
    System.arraycopy(bytes, 0, ring, ringPos, first);
    if (first < n) System.arraycopy(bytes, first, ring, 0, n - first);
    ringPos = (ringPos + n) % ring.length;
    ringLen = Math.min(ring.length, ringLen + n);
  }

  private static byte[] takeRing() {
    if (ring == null || ringLen <= 0) return new byte[0];
    byte[] out = new byte[ringLen];
    int start = (ringPos - ringLen + ring.length) % ring.length;
    int first = Math.min(ringLen, ring.length - start);
    System.arraycopy(ring, start, out, 0, first);
    if (first < ringLen) System.arraycopy(ring, 0, out, first, ringLen - first);
    return out;
  }

  private static void resetBackgroundVad() {
    boolean drop = bgOwned;
    bgOwned = false;
    bgHeard = false;
    bgLoud = 0;
    bgSilentAt = 0;
    bgStart = 0;
    if (drop) abortUtterance();
  }

  /**
   * 切到别的应用后 WebView 计时可能停住，前端 VAD 不再打卡。
   * 这时由录音线程按上次同步的停顿，把用户那一句收完交回页面发出去。
   */
  private static void maybeDriveBackgroundUtterance(double rms) {
    if (MainActivity.isResumed() || !listen || paused) {
      resetBackgroundVad();
      return;
    }
    // 不在前台就由原生收句。WebView 保活心跳不算 VAD 还活着。
    long now = System.currentTimeMillis();
    if (capturing && !bgOwned) {
      bgOwned = true;
      bgHeard = true;
      if (bgStart <= 0) bgStart = now;
    }
    double speech = bgSpeechRms;
    double silence = Math.max(0.004, speech * 0.6);
    if (rms >= (bgHeard ? silence : speech)) {
      bgLoud++;
      bgSilentAt = 0;
      if (!bgHeard && bgLoud >= 4) {
        bgHeard = true;
        bgStart = now;
        if (!capturing) {
          beginUtterance();
          bgOwned = true;
        }
      }
    } else {
      bgLoud = 0;
      if (bgHeard && bgOwned && capturing) {
        if (bgSilentAt <= 0) bgSilentAt = now;
        long silent = now - bgSilentAt;
        long elapsed = bgStart > 0 ? now - bgStart : 0;
        if (elapsed >= bgMaxMs || (silent >= bgSilenceMs && elapsed >= 550)) {
          finishBackgroundUtterance();
        }
      }
    }
  }

  private static void finishBackgroundUtterance() {
    long wall = bgStart > 0 ? System.currentTimeMillis() - bgStart : 0;
    bgOwned = false;
    bgHeard = false;
    bgLoud = 0;
    bgSilentAt = 0;
    bgStart = 0;
    byte[] wav = commitUtterance();
    if (wav == null || wav.length < 800) return;
    // 页面在锁屏时冻住，不能把这句塞回 JS 干等。原生自己上传、请求模型、播回复。
    CallLockTurn.submit(wav, Math.max(0, wall), false);
  }

  private static void loop() {
    AudioRecord ar = record;
    if (ar == null) return;
    short[] buf = new short[Math.max(320, sampleRate / 20)];
    int zeroStreak = 0;
    while (running) {
      int n;
      try {
        n = ar.read(buf, 0, buf.length);
      } catch (Exception e) {
        Log.w(TAG, "AudioRecord.read threw", e);
        break;
      }
      if (!running) break;
      // ERROR_* 为负；死对象/非法状态时旧逻辑会空转，前端看起来像「不收音」
      if (n == AudioRecord.ERROR_DEAD_OBJECT
          || n == AudioRecord.ERROR_INVALID_OPERATION
          || n == AudioRecord.ERROR_BAD_VALUE) {
        Log.w(TAG, "AudioRecord.read error=" + n + ", will rebind");
        break;
      }
      if (n <= 0) {
        zeroStreak++;
        if (zeroStreak > 80) { // ~4s @20ms
          Log.w(TAG, "AudioRecord.read empty streak, will rebind");
          break;
        }
        continue;
      }
      zeroStreak = 0;
      if (!listen) {
        lastRms = 0;
        continue;
      }
      double sum = 0;
      for (int i = 0; i < n; i++) {
        double v = buf[i] / 32768.0;
        sum += v * v;
      }
      lastRms = Math.sqrt(sum / n);
      long now = System.currentTimeMillis();
      if (now - lastLevelEmit >= LEVEL_EMIT_MS) {
        lastLevelEmit = now;
        emitLevel(lastRms);
      }
      if (paused) continue;
      maybeDriveBackgroundUtterance(lastRms);
      byte[] bytes = new byte[n * 2];
      for (int i = 0; i < n; i++) {
        int s = buf[i];
        bytes[i * 2] = (byte) (s & 0xff);
        bytes[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
      }
      pushRing(bytes);
      if (capturing) {
        synchronized (pcm) {
          if (pcm.size() < sampleRate * 2 * 30) {
            try { pcm.write(bytes); } catch (IOException ignored) {}
          }
        }
      }
    }
    // 线程异常退出但通话还在：自动重绑，避免麦死透
    if (running) {
      Log.w(TAG, "mic loop ended while running, schedule rebind");
      MAIN.postDelayed(() -> {
        if (!running) return;
        try {
          rebindMic();
        } catch (Exception e) {
          Log.w(TAG, "auto rebind failed", e);
        }
      }, 220);
    }
  }

  private static void emitLevel(double rms) {
    AppPermissionsPlugin p = plugin;
    if (p == null) return;
    MAIN.post(() -> p.emitCallLevel(rms));
  }

  private static byte[] pcmToWav(byte[] pcmData, int rate, int channels) {
    int dataLen = pcmData.length;
    byte[] wav = new byte[44 + dataLen];
    writeAscii(wav, 0, "RIFF");
    writeInt(wav, 4, 36 + dataLen);
    writeAscii(wav, 8, "WAVE");
    writeAscii(wav, 12, "fmt ");
    writeInt(wav, 16, 16);
    writeShort(wav, 20, 1);
    writeShort(wav, 22, channels);
    writeInt(wav, 24, rate);
    writeInt(wav, 28, rate * channels * 2);
    writeShort(wav, 32, channels * 2);
    writeShort(wav, 34, 16);
    writeAscii(wav, 36, "data");
    writeInt(wav, 40, dataLen);
    System.arraycopy(pcmData, 0, wav, 44, dataLen);
    return wav;
  }

  static String wavBase64(byte[] wav) {
    return Base64.encodeToString(wav, Base64.NO_WRAP);
  }

  static double wavDurationSec(byte[] wav, int rate) {
    if (wav == null || wav.length <= 44 || rate <= 0) return 0;
    return (wav.length - 44) / 2.0 / rate;
  }

  static int currentRate() {
    return sampleRate;
  }

  private static void writeAscii(byte[] b, int off, String s) {
    for (int i = 0; i < s.length(); i++) b[off + i] = (byte) s.charAt(i);
  }

  private static void writeInt(byte[] b, int off, int v) {
    b[off] = (byte) (v & 0xff);
    b[off + 1] = (byte) ((v >> 8) & 0xff);
    b[off + 2] = (byte) ((v >> 16) & 0xff);
    b[off + 3] = (byte) ((v >> 24) & 0xff);
  }

  private static void writeShort(byte[] b, int off, int v) {
    b[off] = (byte) (v & 0xff);
    b[off + 1] = (byte) ((v >> 8) & 0xff);
  }
}

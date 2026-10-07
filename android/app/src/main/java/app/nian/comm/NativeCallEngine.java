package app.nian.comm;

import android.content.Context;
import android.media.AudioAttributes;
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
  private static int boostedVolume = -1; // 仅本句期间被推高的媒体音量；-1 = 未推高
  private static int boostedVoiceVolume = -1; // 文字视频台词：临时抬高的通话音量
  private static final Object boostLock = new Object();

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
    stopRecordLocked();
    String err = openRecord();
    if (err != null) return err;
    running = true;
    listen = false;
    capturing = false;
    paused = false;
    lastRms = 0;
    inCallMode = true; // start() = 进入通话模式，角色声音走通话流
    resetRing();
    recThread = new Thread(NativeCallEngine::loop, "nian-call-mic");
    recThread.start();
    try {
      KeepAliveService.setCallMedia(appCtx, true, ScreenShareOverlay.isCallVideo());
    } catch (Exception ignored) {}
    MainActivity.setKeepWebAlive(true);
    Log.i(TAG, "started rate=" + sampleRate);
    return null;
  }

  static void stop() {
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
    MAIN.post(() -> stopPlayLocked(true, true, false));
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
    paused = false;
    lastRms = 0;
    resetRing();
    recThread = new Thread(NativeCallEngine::loop, "nian-call-mic");
    recThread.start();
    Log.i(TAG, "rebindMic ok rate=" + sampleRate + " capturing=" + capturing);
  }

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
    return Math.max(0.05f, Math.min(2f, g));
  }

  static void stopPlay() {
    MAIN.post(() -> {
      playGen++;
      stopPlayLocked(true, true, true);
    });
  }

  private static void playOnMain(String url, byte[] data, String mime, PlayCallback done) {
    stopPlayLocked(true, true, false);
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
      // 路由切稳后直接满音量开播，把切换毛刺顶过去；不做淡入（淡入会让短句整句发虚）
      beginPlayer(url, data, mime);
    });
  }

  private static void beginPlayer(String url, byte[] data, String mime) {
    boolean hasUrl = url != null && !url.trim().isEmpty();
    boolean hasData = data != null && data.length > 0;
    MediaPlayer mp = new MediaPlayer();
    player = mp;
    try {
      ensurePlayVolume(false);
      if (Build.VERSION.SDK_INT >= 21) {
        // 通话里角色声音走「通话流」(VOICE_COMMUNICATION)，
        // 蓝牙耳机/有线耳机在通话模式下不再主动把输出压低，
        // 也能用系统独立的「通话音量」调大小。
        // 极少数系统会拒绝第三方 App 使用通话流，失败时回退到媒体流。
        AudioAttributes attrs = buildPlayAttrs(inCallMode);
        try {
          mp.setAudioAttributes(attrs);
        } catch (Exception e) {
          Log.w(TAG, "voice-comm attr refused, fallback to media", e);
          mp.setAudioAttributes(buildPlayAttrs(false));
        }
      }
      if (hasData) {
        File f = writePlayFile(data, mime);
        mp.setDataSource(f.getAbsolutePath());
      } else {
        String src = url.trim();
        if (src.startsWith("blob:") || src.startsWith("data:")) {
          throw new IOException("webview blob");
        }
        mp.setDataSource(src);
      }
      mp.setOnPreparedListener(p -> {
        paused = true;
        try {
          float target = playGain > 0f ? playGain : 1f;
          // 外放场景：扬声器功率大、桌面/手心反射会让 1.0 听起来过响，
          // 把内部增益压到 0.7，既能保证清晰也不至于「震」；
          // 耳机/SCO/A2DP 走原值，以免小声听不清
          String route = CallAudioRoute.currentRoute();
          boolean isBuiltin = "builtin".equals(route);
          // 普通通话外放乘 0.7，避免贴脸太响。显式增益 >1.15（文字视频台词）不再压，否则听筒里只剩很小一声
          boolean loudLine = target > 1.15f;
          if (isBuiltin && !loudLine) {
            target = target * 0.7f;
          }
          // MediaPlayer.setVolume 上限 1.0；超过 1 的部分用 AudioManager
          // 把媒体音量推到合适的档位（不持久化，仅本句期间）
          float mediaVol = Math.min(1f, target);
          p.setVolume(mediaVol, mediaVol);
          if (isBuiltin && loudLine) {
            // 外放走通话流，系统「通话音量」经常比媒体音量低很多，台词会小得听不清
            boostVoiceCallStream();
          } else if (!isBuiltin) {
            applyMediaBoost(target);
          }
          p.start();
        } catch (Exception e) {
          Log.w(TAG, "start failed", e);
          stopPlayLocked(true, false, true);
        }
      });
      mp.setOnCompletionListener(p -> {
        restoreMediaBoost();
        stopPlayLocked(true, true, true);
      });
      mp.setOnErrorListener((p, what, extra) -> {
        Log.w(TAG, "play error " + what + "/" + extra);
        restoreMediaBoost();
        stopPlayLocked(true, false, true);
        return true;
      });
      mp.prepareAsync();
    } catch (Exception e) {
      Log.w(TAG, "play failed", e);
      stopPlayLocked(true, false, true);
    }
  }

  private static volatile boolean inCallMode = false;
  static void setInCallMode(boolean on) { inCallMode = !!on; }
  static boolean isInCallMode() { return inCallMode; }

  private static AudioAttributes buildPlayAttrs(boolean voiceComm) {
    AudioAttributes.Builder ab = new AudioAttributes.Builder()
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .setUsage(voiceComm ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_MEDIA);
    // 通话流 + 内容是 speech 时，AOSP 仍允许第三方 App 使用；
    // 部分定制 ROM 可能拒绝，回退由 setAudioAttributes 的 catch 处理。
    return ab.build();
  }

  private static File writePlayFile(byte[] data, String mime) throws IOException {
    Context ctx = appCtx;
    if (ctx == null) throw new IOException("no context");
    deletePlayFile();
    String ext = ".mp3";
    String m = mime == null ? "" : mime.toLowerCase();
    if (m.contains("wav")) ext = ".wav";
    else if (m.contains("ogg")) ext = ".ogg";
    else if (m.contains("mp4") || m.contains("m4a") || m.contains("aac")) ext = ".m4a";
    else if (m.contains("webm")) ext = ".webm";
    File f = new File(ctx.getCacheDir(), "nian-call-play" + ext);
    try (FileOutputStream out = new FileOutputStream(f)) {
      out.write(data);
    }
    playFile = f;
    return f;
  }

  @SuppressWarnings("deprecation")
  private static void ensurePlayVolume(boolean callStream) {
    Context ctx = appCtx;
    if (ctx == null) return;
    AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
    if (am == null) return;
    int stream = callStream ? AudioManager.STREAM_VOICE_CALL : AudioManager.STREAM_MUSIC;
    try {
      int max = am.getStreamMaxVolume(stream);
      int cur = am.getStreamVolume(stream);
      if (max > 0 && cur <= 0) {
        am.setStreamVolume(stream, Math.max(1, max * 2 / 3), 0);
      }
    } catch (Exception ignored) {}
  }

  /**
   * 通话里角色声音增益 > 1 时：临时把媒体音量往上推一档，让本句响起来；
   * 同时记录原值，结束后恢复，避免每次通话都把系统媒体音量永久改大。
   */
  private static void applyMediaBoost(float target) {
    if (target <= 1f) return;
    Context ctx = appCtx;
    if (ctx == null) return;
    AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
    if (am == null) return;
    int stream = AudioManager.STREAM_MUSIC;
    synchronized (boostLock) {
      if (boostedVolume >= 0) return; // 已经有一次推高在进行，不重复
      try {
        int max = am.getStreamMaxVolume(stream);
        int cur = am.getStreamVolume(stream);
        if (max <= 0) return;
        // target=1.3 -> 推 +20%；target=1.6 -> +45%；上限到 max
        int want = (int) Math.min(max, Math.round(cur + (max - cur) * Math.min(0.7f, (target - 1f) * 0.9f)));
        if (want > cur) {
          boostedVolume = cur;
          am.setStreamVolume(stream, want, 0);
          Log.i(TAG, "media boost " + cur + " -> " + want + " (target=" + target + ")");
        }
      } catch (Exception ignored) {}
    }
  }

  /** 文字视频外放：通话音量若低于约七成，本句临时抬到七成，播完还原 */
  private static void boostVoiceCallStream() {
    Context ctx = appCtx;
    if (ctx == null) return;
    AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
    if (am == null) return;
    int stream = AudioManager.STREAM_VOICE_CALL;
    synchronized (boostLock) {
      if (boostedVoiceVolume >= 0) return;
      try {
        int max = am.getStreamMaxVolume(stream);
        int cur = am.getStreamVolume(stream);
        if (max <= 0) return;
        int floor = Math.max(1, (int) Math.round(max * 0.7f));
        if (cur < floor) {
          boostedVoiceVolume = cur;
          am.setStreamVolume(stream, floor, 0);
          Log.i(TAG, "voice-call boost " + cur + " -> " + floor);
        }
      } catch (Exception ignored) {}
    }
  }

  private static void restoreVoiceCallBoost() {
    synchronized (boostLock) {
      if (boostedVoiceVolume < 0) return;
      Context ctx = appCtx;
      int back = boostedVoiceVolume;
      boostedVoiceVolume = -1;
      if (ctx == null) return;
      try {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, back, 0);
      } catch (Exception ignored) {}
      Log.i(TAG, "voice-call boost restored -> " + back);
    }
  }

  private static void restoreMediaBoost() {
    synchronized (boostLock) {
      if (boostedVolume < 0) return;
      Context ctx = appCtx;
      if (ctx == null) { boostedVolume = -1; return; }
      try {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) am.setStreamVolume(AudioManager.STREAM_MUSIC, boostedVolume, 0);
      } catch (Exception ignored) {}
      Log.i(TAG, "media boost restored -> " + boostedVolume);
      boostedVolume = -1;
    }
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
    // 任何结束路径都要把媒体音量 / 临时通话音量恢复回去
    restoreMediaBoost();
    restoreVoiceCallBoost();
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
   * TTS 播完后：若 Activity 不在前台且 JS VAD 已停（>2s 无打卡），
   * 强制 listen=true，否则后台 VAD / 用户说话永远进不来。
   */
  private static void scheduleBackgroundListenRearm() {
    if (!running) return;
    final int gen = playGen;
    MAIN.postDelayed(() -> {
      if (gen != playGen || !running || player != null) return;
      if (MainActivity.isResumed()) return;
      if (!listen) {
        Log.i(TAG, "bg rearm listen after TTS");
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
    synchronized (pcm) {
      pcm.reset();
    }
  }

  private static void stopRecordLocked() {
    running = false;
    listen = false;
    capturing = false;
    stopRecordOnlyLocked();
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
    final int gen = bgGen;
    long wall = bgStart > 0 ? System.currentTimeMillis() - bgStart : 0;
    bgOwned = false;
    bgHeard = false;
    bgLoud = 0;
    bgSilentAt = 0;
    bgStart = 0;
    byte[] wav = commitUtterance();
    if (wav == null || wav.length < 800) return;
    final String b64 = wavBase64(wav);
    final long wallMs = Math.max(0, wall);
    MAIN.post(() -> {
      if (gen != bgGen || !running) return;
      try {
        MainActivity.runJs(
          "try{window.__nianIngestNativeUtterance&&window.__nianIngestNativeUtterance("
            + JSONObject.quote(b64) + "," + wallMs + ")}catch(e){}"
        );
      } catch (Exception ignored) {}
    });
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

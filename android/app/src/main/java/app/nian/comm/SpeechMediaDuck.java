package app.nian.comm;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * 聊天播角色语音：AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK 让其它 App 的音乐闪避；
 * 角色声走 STREAM_MUSIC / USAGE_MEDIA，跟随用户媒体音量，不再手动软压系统音量
 *（旧实现会把 STREAM_MUSIC 压到 40%，连自己的语音一起变小声）。
 */
final class SpeechMediaDuck {
  private static final String TAG = "NianSpeechDuck";
  private static final Handler MAIN = new Handler(Looper.getMainLooper());

  private static Context appCtx;
  private static int duckDepth;
  private static AudioFocusRequest focusRequest;
  private static AudioManager.OnAudioFocusChangeListener focusListener;

  private static MediaPlayer player;
  private static File playFile;
  private static int playGen;
  private static PlayCallback playDone;

  interface PlayCallback {
    void onDone(boolean ok);
  }

  private SpeechMediaDuck() {}

  /** 仅抢闪避焦点（WebView HTML Audio 播语音时调用） */
  static synchronized void duck(Context ctx) {
    ensureCtx(ctx);
    AudioManager am = manager();
    if (am == null) return;
    duckDepth++;
    if (duckDepth == 1) requestDuckFocus(am);
  }

  static synchronized void unduck(Context ctx) {
    ensureCtx(ctx);
    if (duckDepth > 0) duckDepth--;
    if (duckDepth > 0) return;
    AudioManager am = manager();
    if (am != null) abandonDuckFocus(am);
  }

  /** 原生播角色语音：焦点闪避其它媒体；本机音量不改 */
  static void playUrl(Context ctx, String url, float gain, PlayCallback done) {
    MAIN.post(() -> playOnMain(ctx, url, null, null, gain, done));
  }

  static void playBytes(Context ctx, byte[] data, String mime, float gain, PlayCallback done) {
    MAIN.post(() -> playOnMain(ctx, null, data, mime, gain, done));
  }

  static void stopPlay() {
    MAIN.post(() -> stopPlayLocked(true, false));
  }

  static synchronized void reset(Context ctx) {
    ensureCtx(ctx);
    duckDepth = 0;
    stopPlayLocked(false, false);
    AudioManager am = manager();
    if (am != null) abandonDuckFocus(am);
  }

  private static void playOnMain(
    Context ctx,
    String url,
    byte[] data,
    String mime,
    float gain,
    PlayCallback done
  ) {
    ensureCtx(ctx);
    stopPlayLocked(false, false);
    final int gen = ++playGen;
    boolean hasUrl = url != null && !url.trim().isEmpty();
    boolean hasData = data != null && data.length > 0;
    if (appCtx == null || (!hasUrl && !hasData)) {
      if (done != null) done.onDone(false);
      return;
    }
    playDone = done;
    duck(appCtx);
    MediaPlayer mp = new MediaPlayer();
    player = mp;
    float vol = gain > 0f ? Math.max(0.05f, Math.min(1f, gain)) : 1f;
    try {
      if (Build.VERSION.SDK_INT >= 21) {
        // 与通话侧一致：走媒体声道，音量跟手机媒体键一致
        mp.setAudioAttributes(new AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build());
      }
      if (hasData) {
        File f = writePlayFile(data, mime);
        mp.setDataSource(f.getAbsolutePath());
      } else {
        mp.setDataSource(url.trim());
      }
      mp.setOnPreparedListener(p -> {
        if (gen != playGen || player != p) return;
        try {
          p.setVolume(vol, vol);
          p.start();
        } catch (Exception e) {
          Log.w(TAG, "start failed", e);
          stopPlayLocked(true, false);
        }
      });
      mp.setOnCompletionListener(p -> stopPlayLocked(true, true));
      mp.setOnErrorListener((p, what, extra) -> {
        Log.w(TAG, "play error " + what + "/" + extra);
        stopPlayLocked(true, false);
        return true;
      });
      mp.prepareAsync();
    } catch (Exception e) {
      Log.w(TAG, "play failed", e);
      stopPlayLocked(true, false);
    }
  }

  private static void stopPlayLocked(boolean fireDone, boolean ok) {
    MediaPlayer mp = player;
    player = null;
    if (mp != null) {
      try { mp.stop(); } catch (Exception ignored) {}
      try { mp.release(); } catch (Exception ignored) {}
    }
    deletePlayFile();
    PlayCallback cb = playDone;
    playDone = null;
    unduck(appCtx);
    if (fireDone && cb != null) cb.onDone(ok);
  }

  private static File writePlayFile(byte[] data, String mime) throws IOException {
    deletePlayFile();
    String ext = ".mp3";
    String m = mime == null ? "" : mime.toLowerCase();
    if (m.contains("wav")) ext = ".wav";
    else if (m.contains("ogg")) ext = ".ogg";
    else if (m.contains("mp4") || m.contains("m4a") || m.contains("aac")) ext = ".m4a";
    else if (m.contains("webm")) ext = ".webm";
    File f = new File(appCtx.getCacheDir(), "nian-speech-play" + ext);
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

  @SuppressWarnings("deprecation")
  private static void requestDuckFocus(AudioManager am) {
    if (am == null) return;
    try {
      if (Build.VERSION.SDK_INT >= 26) {
        if (focusListener == null) {
          focusListener = focusChange -> { };
        }
        AudioAttributes attrs = new AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build();
        focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
          .setAudioAttributes(attrs)
          .setOnAudioFocusChangeListener(focusListener, MAIN)
          .setWillPauseWhenDucked(false)
          .build();
        am.requestAudioFocus(focusRequest);
      } else {
        am.requestAudioFocus(
          null,
          AudioManager.STREAM_MUSIC,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        );
      }
    } catch (Exception e) {
      Log.w(TAG, "requestDuckFocus", e);
    }
  }

  @SuppressWarnings("deprecation")
  private static void abandonDuckFocus(AudioManager am) {
    if (am == null) return;
    try {
      if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) {
        am.abandonAudioFocusRequest(focusRequest);
        focusRequest = null;
      } else {
        am.abandonAudioFocus(null);
      }
    } catch (Exception ignored) {}
  }

  private static void ensureCtx(Context ctx) {
    if (ctx != null) appCtx = ctx.getApplicationContext();
  }

  private static AudioManager manager() {
    if (appCtx == null) return null;
    try {
      return (AudioManager) appCtx.getSystemService(Context.AUDIO_SERVICE);
    } catch (Exception e) {
      return null;
    }
  }
}

package app.nian.comm;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
  public static final String EXTRA_OPEN_CHAR = "nian_char_id";
  public static final String EXTRA_EXPAND_CALL = "nian_expand_call";
  public static final String EXTRA_ANSWER_INCOMING = "nian_answer_incoming";
  private static volatile boolean resumed;
  private static volatile boolean keepWebAlive;
  private static volatile MainActivity current;
  private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
  private int insetTopPx;
  private int insetBottomPx;
  private int insetLeftPx;
  private int insetRightPx;
  private int pendingCharId;
  private boolean pendingExpandCall;
  private boolean pendingAnswerIncoming;
  private boolean statusBarBridgeAttached;
  private boolean mediaChromeInstalled;
  private boolean shareBridgeAttached;
  private boolean musicSyncBridgeAttached;
  private MusicSyncMonitor musicSyncMonitor;
  private org.json.JSONObject pendingShare;
  private long pausedAtMs;
  private boolean keptAliveWhilePaused;
  private final Runnable keepCallWebTick = new Runnable() {
    @Override
    public void run() {
      if (resumed) return;
      if (!keepWebAlive && !ScreenShareOverlay.isCallOn() && !NativeCallEngine.isRunning()) return;
      resumeCallWebView();
      MAIN_HANDLER.postDelayed(this, 1000);
    }
  };

  public static boolean isResumed() {
    return resumed;
  }

  public static void setKeepWebAlive(boolean on) {
    keepWebAlive = on;
  }

  public static void openAnswerIncoming(Context ctx, int characterId) {
    if (ctx == null) return;
    try {
      Intent i = new Intent(ctx, MainActivity.class);
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
      if (characterId > 0) i.putExtra(EXTRA_OPEN_CHAR, characterId);
      i.putExtra(EXTRA_ANSWER_INCOMING, true);
      ctx.startActivity(i);
    } catch (Exception ignored) {}
  }

  public static void openFromOverlay(Context ctx, int characterId, boolean expandCall) {
    if (ctx == null) return;
    try {
      Intent i = new Intent(ctx, MainActivity.class);
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
      if (characterId > 0) i.putExtra(EXTRA_OPEN_CHAR, characterId);
      if (expandCall) i.putExtra(EXTRA_EXPAND_CALL, true);
      ctx.startActivity(i);
    } catch (Exception ignored) {}
  }

  public static void hangupCallFromNative() {
    evalJs("(function(){try{if(window.hangupCallFromNative){window.hangupCallFromNative();return true;}if(window.endCall){window.endCall();return true;}return false;}catch(e){return false;}})()");
    // JS 若已挂（白屏/重载），上面是空操作；延迟再清一次原生通话球，避免悬浮窗一直显示打电话
    MAIN_HANDLER.postDelayed(() -> {
      if (!ScreenShareOverlay.isCallOn()) return;
      Context ctx = current != null ? current : null;
      ScreenShareOverlay.abandonCallRuntime(ctx);
    }, 1000);
  }

  static void runJs(String js) {
    evalJs(js);
  }

  private static void evalJs(String js) {
    MainActivity a = current;
    if (a == null) return;
    a.runOnUiThread(() -> {
      try {
        Bridge bridge = a.getBridge();
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) webView.evaluateJavascript(js, null);
      } catch (Exception ignored) {}
    });
  }

  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(LauncherIconPlugin.class);
    registerPlugin(AppPermissionsPlugin.class);
    registerPlugin(AppUpdatePlugin.class);
    super.onCreate(savedInstanceState);
    current = this;
    installWebViewMediaPermissions();
    clearWebViewCacheIfUpdated();
    setupEdgeToEdge();
    installInAppBackGesture();
    if (NianBridgePrefs.wantForeground(this)) {
      try {
        KeepAliveService.start(this);
      } catch (Exception e) {
        NianBridgePrefs.saveForeground(this, false);
      }
    }
    try { StepCounter.start(this); } catch (Exception ignored) {}
    try { NianAlarms.rescheduleAll(this); } catch (Exception ignored) {}
    try { BobobeiBle.warmStart(this); } catch (Exception ignored) {}
    captureOpenChar(getIntent());
    captureExpandCall(getIntent());
    captureAnswerIncoming(getIntent());
    captureShare(getIntent());
    deliverOpenChar(400);
    deliverOpenChar(1400);
    deliverExpandCall(500);
    deliverExpandCall(1600);
    deliverAnswerIncoming(700);
    deliverAnswerIncoming(1800);
    deliverShare(500);
    deliverShare(1600);
    deliverShare(3200);
  }

  /** 升级后清 WebView 资源缓存，避免仍吃到旧的 js/css（不动 localStorage） */
  private void clearWebViewCacheIfUpdated() {
    try {
      android.content.SharedPreferences p =
        getSharedPreferences("nian_webview_cache", MODE_PRIVATE);
      int prev = p.getInt("assets_version", 0);
      int now = BuildConfig.VERSION_CODE;
      if (prev == now) return;
      Bridge bridge = getBridge();
      WebView webView = bridge != null ? bridge.getWebView() : null;
      if (webView != null) {
        webView.clearCache(true);
      }
      p.edit().putInt("assets_version", now).apply();
      android.util.Log.i("NianMain", "cleared WebView cache for version " + now);
    } catch (Exception e) {
      android.util.Log.w("NianMain", "clear WebView cache failed", e);
    }
  }

  @Override
  public void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    captureOpenChar(intent);
    captureExpandCall(intent);
    captureAnswerIncoming(intent);
    captureShare(intent);
    deliverOpenChar(120);
    deliverOpenChar(600);
    deliverExpandCall(180);
    deliverExpandCall(700);
    deliverAnswerIncoming(220);
    deliverAnswerIncoming(800);
    deliverShare(160);
    deliverShare(700);
    deliverShare(1800);
  }

  @Override
  public void onStart() {
    super.onStart();
    attachStatusBarBridge();
    attachShareBridge();
    attachMusicSyncBridge();
    WebView webView = getBridge() != null ? getBridge().getWebView() : null;
    if (webView != null) {
      webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
    }
  }

  /** 必须在 onCreate 里换 ChromeClient（ActivityResult 要在 STARTED 之前注册） */
  private void installWebViewMediaPermissions() {
    Bridge bridge = getBridge();
    WebView webView = bridge != null ? bridge.getWebView() : null;
    if (webView == null || mediaChromeInstalled) {
      if (webView != null) {
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
      }
      return;
    }
    webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
    webView.setWebChromeClient(new NianWebChromeClient(bridge));
    mediaChromeInstalled = true;
  }

  @Override
  public void onResume() {
    MAIN_HANDLER.removeCallbacks(keepCallWebTick);
    super.onResume();
    resumed = true;
    CapsuleOverlay.hide();
    ScreenShareOverlay.onAppForeground();
    reportPhonePresence();
    captureOpenChar(getIntent());
    captureExpandCall(getIntent());
    captureAnswerIncoming(getIntent());
    captureShare(getIntent());
    deliverOpenChar(80);
    deliverExpandCall(120);
    deliverAnswerIncoming(160);
    deliverShare(200);
    deliverShare(900);
    evalJs("(function(){try{if(window.__nianResetKeyboardLayout)window.__nianResetKeyboardLayout();}catch(e){}})()");
    View decor = getWindow() != null ? getWindow().getDecorView() : null;
    if (decor != null) {
      decor.postDelayed(() -> evalJs("(function(){try{if(window.__nianResetKeyboardLayout)window.__nianResetKeyboardLayout();}catch(e){}})()"), 280);
    }
    if (keptAliveWhilePaused && pausedAtMs > 0 && System.currentTimeMillis() - pausedAtMs > 45_000L) {
      checkWebAliveAfterLongKeep();
    } else {
      evalJs("(function(){try{if(window.__nianReconcileCall)window.__nianReconcileCall();}catch(e){}})()");
    }
    if (keepWebAlive || ScreenShareOverlay.isCallOn() || NativeCallEngine.isRunning()) {
      NativeCallEngine.onForeground();
    }
    keptAliveWhilePaused = false;
    pausedAtMs = 0;
  }

  @Override
  public void onPause() {
    hideSoftKeyboard();
    resumed = false;
    ScreenShareOverlay.onAppBackground(this);
    reportPhonePresence();
    pausedAtMs = System.currentTimeMillis();
    keptAliveWhilePaused = keepWebAlive || ScreenShareOverlay.isCallOn() || NativeCallEngine.isRunning();
    super.onPause();
    if (keptAliveWhilePaused) resumeCallWebView();
    armCallWebKeepAlive();
  }

  @Override
  public void onStop() {
    super.onStop();
    armCallWebKeepAlive();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (!hasFocus) armCallWebKeepAlive();
  }

  private void armCallWebKeepAlive() {
    if (resumed) return;
    if (!keepWebAlive && !ScreenShareOverlay.isCallOn() && !NativeCallEngine.isRunning()) return;
    MAIN_HANDLER.removeCallbacks(keepCallWebTick);
    MAIN_HANDLER.post(keepCallWebTick);
  }

  private void resumeCallWebView() {
    if (resumed) return;
    if (!keepWebAlive && !ScreenShareOverlay.isCallOn() && !NativeCallEngine.isRunning()) return;
    try {
      WebView wv = getBridge() != null ? getBridge().getWebView() : null;
      if (wv == null) return;
      wv.onResume();
      wv.resumeTimers();
    } catch (Exception ignored) {}
  }

  private void hideSoftKeyboard() {
    try {
      InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
      View focus = getCurrentFocus();
      if (focus == null && getBridge() != null) focus = getBridge().getWebView();
      if (imm != null && focus != null) {
        imm.hideSoftInputFromWindow(focus.getWindowToken(), 0);
      }
      if (focus != null) focus.clearFocus();
    } catch (Exception ignored) {}
    try {
      evalJs("(function(){try{if(window.__nianResetKeyboardLayout)window.__nianResetKeyboardLayout();}catch(e){}})()");
    } catch (Exception ignored) {}
  }

  /** 隔夜保活后 WebView 偶发白屏：探活失败则放弃通话运行态并 reload。 */
  private void checkWebAliveAfterLongKeep() {
    Bridge bridge = getBridge();
    WebView wv = bridge != null ? bridge.getWebView() : null;
    if (wv == null) {
      ScreenShareOverlay.abandonCallRuntime(this);
      return;
    }
    try {
      wv.evaluateJavascript(
        "(function(){try{var b=document.body;return !!(window.__nianBootOk&&b&&b.childElementCount>0);}catch(e){return false;}})()",
        value -> {
          boolean ok = "true".equals(value);
          if (!ok) {
            if (ScreenShareOverlay.isCallOn() || keepWebAlive) {
              ScreenShareOverlay.abandonCallRuntime(MainActivity.this);
            }
            try { wv.reload(); } catch (Exception ignored) {}
          } else {
            evalJs("(function(){try{if(window.__nianReconcileCall)window.__nianReconcileCall();}catch(e){}})()");
          }
        }
      );
    } catch (Exception e) {
      ScreenShareOverlay.abandonCallRuntime(this);
      try { wv.reload(); } catch (Exception ignored) {}
    }
  }

  @Override
  public void onDestroy() {
    if (current == this) current = null;
    // Activity 销毁时 WebView 已死：清通话运行态，保留 prefs 给下次启动写结束记录
    if (keepWebAlive || ScreenShareOverlay.isCallOn()) {
      ScreenShareOverlay.abandonCallRuntime(this);
    }
    keepWebAlive = false;
    super.onDestroy();
  }

  private void reportPhonePresence() {
    final android.content.Context app = getApplicationContext();
    new Thread(() -> {
      try {
        PhoneHttp.post(app, "/api/phone/notifications", PhoneSense.notificationsBody(app).toString());
      } catch (Exception ignored) {}
    }, "nian-presence").start();
  }

  private void captureShare(Intent intent) {
    if (intent == null) return;
    org.json.JSONObject payload = ShareReceiveHelper.capture(this, intent);
    if (payload != null) pendingShare = payload;
  }

  private void deliverShare(int delayMs) {
    if (pendingShare == null) return;
    final org.json.JSONObject payload = pendingShare;
    View decor = getWindow() != null ? getWindow().getDecorView() : null;
    if (decor == null) return;
    decor.postDelayed(() -> {
      if (pendingShare != payload) return;
      Bridge bridge = getBridge();
      WebView webView = bridge != null ? bridge.getWebView() : null;
      if (webView == null) return;
      String json = payload.toString();
      String js = "(function(){try{if(window.__nianReceiveShare){return !!window.__nianReceiveShare("
        + json + ");}return false;}catch(e){return false;}})()";
      webView.evaluateJavascript(js, value -> {
        String v = value == null ? "false" : value.replace("\"", "");
        if ("true".equalsIgnoreCase(v) && pendingShare == payload) pendingShare = null;
      });
    }, delayMs);
  }

  private void attachShareBridge() {
    if (shareBridgeAttached) return;
    Bridge bridge = getBridge();
    WebView webView = bridge != null ? bridge.getWebView() : null;
    if (webView == null) return;
    webView.addJavascriptInterface(new ShareBridge(this), "NianShare");
    shareBridgeAttached = true;
  }

  static final class ShareBridge {
    private final MainActivity activity;

    ShareBridge(MainActivity activity) {
      this.activity = activity;
    }

    @JavascriptInterface
    public String readFileBase64(String absPath) {
      return ShareReceiveHelper.readCacheFileBase64(activity, absPath);
    }
  }

  private void captureAnswerIncoming(Intent intent) {
    if (intent == null) return;
    if (intent.getBooleanExtra(EXTRA_ANSWER_INCOMING, false)) {
      pendingAnswerIncoming = true;
      intent.removeExtra(EXTRA_ANSWER_INCOMING);
    }
  }

  private void deliverAnswerIncoming(int delayMs) {
    if (!pendingAnswerIncoming) return;
    View decor = getWindow() != null ? getWindow().getDecorView() : null;
    if (decor == null) return;
    decor.postDelayed(() -> {
      Bridge bridge = getBridge();
      WebView webView = bridge != null ? bridge.getWebView() : null;
      if (webView == null) return;
      org.json.JSONObject p = IncomingCallService.pendingCall();
      int id = p.optInt("characterId", pendingCharId);
      int logId = p.optInt("logId", 0);
      String name = p.optString("name", "").replace("\\", "\\\\").replace("'", "\\'");
      String content = p.optString("content", "").replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n");
      String avatar = p.optString("avatar", "").replace("\\", "\\\\").replace("'", "\\'");
      String js = "(function(){try{if(window.answerIncomingCallFromNative){window.answerIncomingCallFromNative({"
        + "characterId:" + id
        + ",logId:" + logId
        + ",charName:'" + name + "'"
        + ",charAvatar:'" + avatar + "'"
        + ",content:'" + content + "'"
        + "});return true;}return false;}catch(e){return false;}})()";
      webView.evaluateJavascript(js, value -> {
        String v = value == null ? "false" : value.replace("\"", "");
        if ("true".equalsIgnoreCase(v)) pendingAnswerIncoming = false;
      });
    }, delayMs);
  }

  private void captureExpandCall(Intent intent) {
    if (intent == null) return;
    if (intent.getBooleanExtra(EXTRA_EXPAND_CALL, false)) {
      pendingExpandCall = true;
      intent.removeExtra(EXTRA_EXPAND_CALL);
    }
  }

  private void deliverExpandCall(int delayMs) {
    if (!pendingExpandCall) return;
    View decor = getWindow() != null ? getWindow().getDecorView() : null;
    if (decor == null) return;
    decor.postDelayed(() -> {
      Bridge bridge = getBridge();
      WebView webView = bridge != null ? bridge.getWebView() : null;
      if (webView == null) return;
      webView.evaluateJavascript(
        "(function(){try{if(window.expandCallFromNative){window.expandCallFromNative();return true;}if(window.expandCall){window.expandCall();return true;}return false;}catch(e){return false;}})()",
        value -> {
          String v = value == null ? "false" : value.replace("\"", "");
          if ("true".equalsIgnoreCase(v)) pendingExpandCall = false;
        }
      );
    }, delayMs);
  }

  private void captureOpenChar(Intent intent) {
    if (intent == null) return;
    int id = intent.getIntExtra(EXTRA_OPEN_CHAR, 0);
    if (id > 0) {
      pendingCharId = id;
      intent.removeExtra(EXTRA_OPEN_CHAR);
    }
  }

  private void deliverOpenChar(int delayMs) {
    if (pendingCharId <= 0) return;
    final int id = pendingCharId;
    View decor = getWindow() != null ? getWindow().getDecorView() : null;
    if (decor == null) return;
    decor.postDelayed(() -> {
      Bridge bridge = getBridge();
      WebView webView = bridge != null ? bridge.getWebView() : null;
      if (webView == null) return;
      webView.evaluateJavascript(
        "(function(){try{if(window.openCharacterFromNative){window.openCharacterFromNative("
          + id + ");return true;}return false;}catch(e){return false;}})()",
        value -> {
          String v = value == null ? "false" : value.replace("\"", "");
          if ("true".equalsIgnoreCase(v) && pendingCharId == id) pendingCharId = 0;
        }
      );
    }, delayMs);
  }

  /** 网页铺到屏幕边缘，状态栏/导航栏浮在内容上 */
  private void setupEdgeToEdge() {
    Window window = getWindow();
    WindowCompat.setDecorFitsSystemWindows(window, false);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      WindowManager.LayoutParams lp = window.getAttributes();
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      window.setAttributes(lp);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      window.setStatusBarColor(Color.TRANSPARENT);
      window.setNavigationBarColor(Color.TRANSPARENT);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.setNavigationBarContrastEnforced(false);
    }
    View decor = window.getDecorView();
    WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
    if (controller != null) {
      // true = 深色状态栏字（浅色顶栏）；启动默认内页浅灰顶栏
      controller.setAppearanceLightStatusBars(true);
      controller.setAppearanceLightNavigationBars(true);
    }

    ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
      Insets bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
      );
      insetTopPx = bars.top;
      insetBottomPx = bars.bottom;
      insetLeftPx = bars.left;
      insetRightPx = bars.right;
      pushSafeAreaInsets();
      return insets;
    });
    decor.post(this::pushSafeAreaInsets);
    decor.postDelayed(this::pushSafeAreaInsets, 120);
    decor.postDelayed(this::pushSafeAreaInsets, 480);
  }

  private void pushSafeAreaInsets() {
    if (insetTopPx <= 0) return;
    Bridge bridge = getBridge();
    WebView webView = bridge != null ? bridge.getWebView() : null;
    if (webView == null) return;
    float d = getResources().getDisplayMetrics().density;
    if (d <= 0f) d = 1f;
    final String js = String.format(
      Locale.US,
      "(function(){var r=document.documentElement;if(!r)return;"
        + "r.style.setProperty('--sat','%.1fpx');"
        + "r.style.setProperty('--sab','%.1fpx');"
        + "r.style.setProperty('--sal','%.1fpx');"
        + "r.style.setProperty('--sar','%.1fpx');"
        + "})()",
      insetTopPx / d,
      insetBottomPx / d,
      insetLeftPx / d,
      insetRightPx / d
    );
    webView.evaluateJavascript(js, null);
  }

  private void attachStatusBarBridge() {
    if (statusBarBridgeAttached) return;
    Bridge bridge = getBridge();
    WebView webView = bridge != null ? bridge.getWebView() : null;
    if (webView == null) return;
    webView.addJavascriptInterface(new StatusBarBridge(this), "NianStatusBar");
    statusBarBridgeAttached = true;
  }

  void applyStatusBarIconAppearance(boolean lightIcons) {
    Window window = getWindow();
    if (window == null) return;
    View decor = window.getDecorView();
    WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
    if (controller == null) return;
    controller.setAppearanceLightStatusBars(!lightIcons);
    controller.setAppearanceLightNavigationBars(!lightIcons);
  }

  static final class StatusBarBridge {
    private final MainActivity activity;

    StatusBarBridge(MainActivity activity) {
      this.activity = activity;
    }

    @JavascriptInterface
    public void setLightIcons(boolean lightIcons) {
      activity.runOnUiThread(() -> activity.applyStatusBarIconAppearance(lightIcons));
    }
  }

  static final class MusicSyncBridge {
    private final MainActivity activity;

    MusicSyncBridge(MainActivity activity) {
      this.activity = activity;
    }

    @JavascriptInterface
    public void start(int characterId) {
      activity.runOnUiThread(() -> activity.startMusicSync(characterId));
    }

    @JavascriptInterface
    public void stop() {
      activity.runOnUiThread(() -> activity.stopMusicSync());
    }

    @JavascriptInterface
    public String getCurrentTrack() {
      if (activity.musicSyncMonitor == null) return "{}";
      MusicSyncMonitor.MusicTrackInfo track = activity.musicSyncMonitor.getCurrentTrack();
      if (track == null) return "{}";
      
      try {
        org.json.JSONObject json = new org.json.JSONObject();
        json.put("title", track.title != null ? track.title : "");
        json.put("artist", track.artist != null ? track.artist : "");
        json.put("album", track.album != null ? track.album : "");
        json.put("position", track.position);
        json.put("duration", track.duration);
        json.put("isPlaying", track.isPlaying);
        json.put("songIndex", track.songIndex);
        return json.toString();
      } catch (Exception e) {
        return "{}";
      }
    }
  }

  private void attachMusicSyncBridge() {
    if (musicSyncBridgeAttached) return;
    Bridge bridge = getBridge();
    WebView webView = bridge != null ? bridge.getWebView() : null;
    if (webView == null) return;
    webView.addJavascriptInterface(new MusicSyncBridge(this), "MusicSync");
    musicSyncBridgeAttached = true;
  }

  private void startMusicSync(int characterId) {
    if (musicSyncMonitor != null) {
      android.util.Log.w("MusicSync", "Already started");
      return;
    }

    musicSyncMonitor = new MusicSyncMonitor(this, new MusicSyncMonitor.MusicSyncCallback() {
      @Override
      public void onTrackChanged(MusicSyncMonitor.MusicTrackInfo track) {
        notifyWebViewTrackChanged(track);
      }

      @Override
      public void onPlaybackStateChanged(boolean isPlaying) {
        android.util.Log.i("MusicSync", "Playback state: " + isPlaying);
      }
    });

    musicSyncMonitor.start();
    android.util.Log.i("MusicSync", "Started for character " + characterId);
  }

  private void stopMusicSync() {
    if (musicSyncMonitor != null) {
      musicSyncMonitor.stop();
      musicSyncMonitor = null;
      android.util.Log.i("MusicSync", "Stopped");
    }
  }

  private void notifyWebViewTrackChanged(MusicSyncMonitor.MusicTrackInfo track) {
    Bridge bridge = getBridge();
    WebView webView = bridge != null ? bridge.getWebView() : null;
    if (webView == null) return;

    try {
      org.json.JSONObject json = new org.json.JSONObject();
      json.put("title", track.title != null ? track.title : "");
      json.put("artist", track.artist != null ? track.artist : "");
      json.put("album", track.album != null ? track.album : "");
      json.put("position", track.position);
      json.put("duration", track.duration);
      json.put("isPlaying", track.isPlaying);
      json.put("songIndex", track.songIndex);

      String jsonStr = json.toString()
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n");

      String js = "(function(){try{if(window.onMusicTrackChanged){window.onMusicTrackChanged('"
        + jsonStr + "');return true;}return false;}catch(e){console.error(e);return false;}})()";

      webView.evaluateJavascript(js, null);
    } catch (Exception e) {
      android.util.Log.e("MusicSync", "Failed to notify track change", e);
    }
  }

  /** 侧滑/返回键：有子页面则 App 内返回，桌面页才退到系统桌面（不杀掉 App） */
  private void installInAppBackGesture() {
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override
      public void handleOnBackPressed() {
        Bridge bridge = getBridge();
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null) {
          moveTaskToBack(true);
          return;
        }
        webView.evaluateJavascript(
          "(function(){try{return !!(window.handleNativeBack&&window.handleNativeBack());}catch(e){return false;}})()",
          value -> {
            String v = value == null ? "false" : value.replace("\"", "");
            if ("true".equalsIgnoreCase(v)) return;
            moveTaskToBack(true);
          }
        );
      }
    });
  }
}

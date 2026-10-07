package app.nian.comm;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.SweepGradient;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.hardware.display.DisplayManager;
import android.graphics.Rect;
import android.view.Display;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewTreeObserver;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.Movie;
import android.graphics.Outline;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.Animatable;
import android.graphics.drawable.Drawable;
import android.media.MediaPlayer;
import android.view.Surface;
import android.view.TextureView;
import android.view.ViewOutlineProvider;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.content.SharedPreferences;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.LinearInterpolator;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 离开念之后的光环：默认半圈贴边。角色来的文字/表情包直接铺在屏幕上，不自动消失。
 * 光环不因来消息自己展开；点一下才展开输入框。
 * 连点三下收起屏幕聊天并贴边，不关光环。系统行和语音条只进聊天页。滑动不算点。
 */
final class ScreenShareOverlay {
  static final String IGNORE = "nian-share-ignore";
  private static final Handler MAIN = new Handler(Looper.getMainLooper());
  /** HTTP 回包和胶囊推送会各送一轮同一条回复，按文案短时去重 */
  private static final int REPLY_DEDUP_MS = 120_000;
  private static final int SEND_DEDUP_MS = 1500;
  /** 识屏/控屏多轮可能超过 90s；跟后端 completeChatTurn 对齐并留余量 */
  private static final int SEND_TIMEOUT_MS = 180_000;
  private static final int EMPTY_WAIT_MS = 40_000;
  private static final int SLIDE_MS = 420;
  private static final int TRIPLE_WINDOW_MS = 600;
  private static final int SINGLE_TAP_DELAY_MS = 280;
  private static final Object BUBBLE_LOCK = new Object();
  private static final int RING_BOX_DP = 56;
  private static final int CALL_AVATAR_DP = 40;
  private static final int CALL_HALO_PAD_DP = 8;
  private static final int CALL_VIDEO_W_DP = 96;
  private static final int CALL_VIDEO_H_DP = 72;
  private static final int CALL_VIDEO_RADIUS_DP = 12;
  private static final int RING_RADIUS_DP = 18;
  private static final int RING_PEEK_INSET_DP = 10;
  private static final int CALL_HALO_BLUE = 0xFF4C8DFF;
  private static final int CALL_HALO_PINK = 0xFFFF7EB0;
  private static final int LONG_PRESS_MS = 450;
  private static final int TAG_BUBBLE_KEY = 0x4E49414E;
  private static final String PREF = "nian_bridge";
  private static final String KEY_RING_X = "share_ring_x";
  private static final String KEY_RING_Y = "share_ring_y";
  private static final String KEY_RING_RIGHT = "share_ring_right";
  private static final String KEY_RING_FREE = "share_ring_free";

  private static final class Bubble {
    final boolean mine;
    final String text;
    final String kind;
    final String url;
    Bubble(boolean mine, String text) {
      this(mine, text, "text", "");
    }
    Bubble(boolean mine, String text, String kind, String url) {
      this.mine = mine;
      this.text = text == null ? "" : text;
      this.kind = kind == null || kind.isEmpty() ? "text" : kind;
      this.url = url == null ? "" : url;
    }
  }

  private static View ringView;
  private static View bubbleView;
  private static LinearLayout bubbleCol;
  private static View inputView;
  private static View removeZone;
  private static WindowManager wm;
  private static boolean sessionOn;
  private static boolean captureHidden;
  private static boolean inputOpen;
  /** 悬浮输入条相对屏幕底边抬起的高度（系统键盘），收起为 0 */
  private static int inputImeBottom;
  private static boolean bubblesHidden;
  private static int characterId;
  private static String charName = "TA";
  private static Context appCtx;
  private static EditText input;
  private static final List<Bubble> bubbles = new ArrayList<>();
  private static final List<String> recentReplyKeys = new ArrayList<>();
  private static final List<Long> recentReplyAt = new ArrayList<>();
  /** 新一轮角色气泡会作废上一轮还没弹出的延迟，避免叠两波 */
  private static int bubbleWave;
  private static String lastSentText = "";
  private static long lastSentAt;
  private static final AtomicInteger sendSeq = new AtomicInteger();
  private static volatile int sendInFlight;
  private static int ringX = -1;
  private static int ringY = -1;
  private static boolean ringOnRight = true;
  private static boolean ringPeeking;
  private static boolean ringPosLoaded;
  private static boolean ringFree;
  private static boolean ringDragging;
  private static boolean ringDragArmed;
  private static boolean ringMoved;
  private static boolean removeHot;
  private static float ringDownRawX;
  private static float ringDownRawY;
  private static float lastRawX;
  private static float lastRawY;
  private static int ringDownX;
  private static int ringDownY;
  private static ValueAnimator ringMoveAnim;
  private static Runnable ringPeekTask;
  private static Runnable longPressTask;
  private static Runnable ringTapTask;
  private static boolean resumePeeked;
  private static int ringTapCount;
  private static long ringTapAt;
  private static boolean callOn;
  private static boolean callVideo;
  private static boolean callSpeaking;
  private static String callPhase = "idle";
  private static String callFacing = "";
  private static String callAvatarUrl = "";
  private static String callClipUrl = "";
  private static String callPreviewDataUrl = "";
  private static Bitmap callAvatarBmp;
  private static MediaPlayer callPlayer;
  private static ValueAnimator callHaloAnim;
  private static String orbKindInstalled = "";
  private static int clipVideoW;
  private static int clipVideoH;
  private static int lastDispW;
  private static int lastDispH;
  private static boolean displayWatchOn;
  private static DisplayManager displayManager;
  private static final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
    @Override public void onDisplayAdded(int displayId) {}
    @Override public void onDisplayRemoved(int displayId) {}
    @Override public void onDisplayChanged(int displayId) {
      MAIN.post(ScreenShareOverlay::relayoutForDisplay);
    }
  };
  private static final android.content.ComponentCallbacks configWatch = new android.content.ComponentCallbacks() {
    @Override public void onConfigurationChanged(android.content.res.Configuration newConfig) {
      MAIN.post(ScreenShareOverlay::relayoutForDisplay);
    }
    @Override public void onLowMemory() {}
  };

  private ScreenShareOverlay() {}

  static boolean isSessionOn() {
    return sessionOn;
  }

  static boolean isAttached() {
    return ringView != null || bubbleView != null || inputView != null;
  }

  static boolean isCallOn() {
    return callOn;
  }

  static boolean callUsesRearCam() {
    return callOn && "environment".equals(callFacing);
  }

  static boolean callUsesFrontCam() {
    return callOn && !"environment".equals(callFacing);
  }

  static boolean isCallVideo() {
    return callOn && callVideo;
  }

  static String callPreviewDataUrl() {
    return callPreviewDataUrl == null ? "" : callPreviewDataUrl;
  }

  static org.json.JSONObject callJson() {
    org.json.JSONObject o = new org.json.JSONObject();
    try {
      o.put("on", callOn);
      o.put("video", callVideo);
      o.put("facing", callFacing == null ? "" : callFacing);
    } catch (Exception ignored) {}
    return o;
  }

  static void setCallPreviewDataUrl(String dataUrl) {
    callPreviewDataUrl = dataUrl == null ? "" : dataUrl.trim();
  }

  static void setCallSpeaking(boolean on) {
    setCallPhase(on ? "speaking" : "idle");
  }

  static void setCallPhase(String phase) {
    String p = phase == null ? "idle" : phase.trim().toLowerCase();
    if (!"speaking".equals(p) && !"thinking".equals(p) && !"listening".equals(p)) p = "idle";
    callPhase = p;
    callSpeaking = "speaking".equals(p);
    MAIN.post(ScreenShareOverlay::applyCallHalo);
  }

  private static void applyCallHalo() {
    if (!(ringView instanceof FrameLayout)) return;
    View halo = ((FrameLayout) ringView).findViewWithTag("speak");
    if (halo == null) return;
    boolean show = callOn && ("speaking".equals(callPhase) || "thinking".equals(callPhase) || "listening".equals(callPhase));
    if (callHaloAnim != null) {
      callHaloAnim.cancel();
      callHaloAnim = null;
    }
    if (!show) {
      halo.setVisibility(View.GONE);
      halo.setAlpha(1f);
      halo.setScaleX(1f);
      halo.setScaleY(1f);
      return;
    }
    boolean pink = "listening".equals(callPhase);
    halo.setBackground(callHaloDrawable(halo.getContext(), callVideo, pink));
    halo.setVisibility(View.VISIBLE);
    halo.setAlpha(0.95f);
    halo.setScaleX(0.94f);
    halo.setScaleY(0.94f);
    ValueAnimator a = ValueAnimator.ofFloat(0f, 1f);
    a.setDuration(1200);
    a.setRepeatCount(ValueAnimator.INFINITE);
    a.setInterpolator(new LinearInterpolator());
    a.addUpdateListener(an -> {
      float t = (float) an.getAnimatedValue();
      float s = 0.94f + 0.28f * t;
      halo.setScaleX(s);
      halo.setScaleY(s);
      halo.setAlpha(0.95f * (1f - t));
    });
    callHaloAnim = a;
    a.start();
  }

  static void setCallState(Context ctx, boolean on, boolean video, String avatar, String clip,
                           String facing, int cid, String name) {
    boolean wasOn = callOn;
    callOn = on;
    callVideo = on && video;
    callAvatarUrl = avatar == null ? "" : avatar.trim();
    callClipUrl = (on && video && clip != null) ? clip.trim() : "";
    String face = facing == null ? "" : facing.trim();
    callFacing = "environment".equals(face) ? "environment" : (callVideo ? "user" : "");
    if (cid > 0) {
      characterId = cid;
      if (ctx != null) NianBridgePrefs.saveHaloChar(ctx, cid, name);
    }
    if (name != null && !name.trim().isEmpty()) charName = name.trim();
    if (on) {
      long started = 0L;
      if (ctx != null) {
        if (NianBridgePrefs.activeCallCharId(ctx) == (cid > 0 ? cid : characterId)) {
          started = NianBridgePrefs.activeCallStartedAt(ctx);
        }
      }
      if (started <= 0) started = System.currentTimeMillis();
      if (ctx != null) {
        NianBridgePrefs.saveActiveCall(
          ctx,
          cid > 0 ? cid : characterId,
          charName,
          callVideo,
          started
        );
      }
    } else if (ctx != null) {
      NianBridgePrefs.clearActiveCall(ctx);
    }
    if (!on) {
      callPreviewDataUrl = "";
      callSpeaking = false;
      callPhase = "idle";
      callAvatarBmp = null;
      if (callHaloAnim != null) {
        callHaloAnim.cancel();
        callHaloAnim = null;
      }
    }
    MainActivity.setKeepWebAlive(on);
    KeepAliveService.setCallMedia(ctx, on, callVideo);
    if (on && ctx != null) {
      sessionOn = true;
      appCtx = ctx.getApplicationContext();
    }
    final Context app = ctx != null ? ctx.getApplicationContext() : appCtx;
    MAIN.post(() -> {
      if (app == null) return;
      if (MainActivity.isResumed()) return;
      if (callOn || sessionOn) attach(app);
      else if (wasOn) detach();
    });
  }

  /**
   * WebView/Activity 挂了但进程还在：清通话运行态与悬浮窗通话球，保留 activeCall prefs
   * 给网页写「通话结束」；光环会话可继续。
   */
  static void abandonCallRuntime(Context ctx) {
    Context app = ctx != null ? ctx.getApplicationContext() : appCtx;
    boolean wasOn = callOn;
    callOn = false;
    callVideo = false;
    callSpeaking = false;
    callPhase = "idle";
    callFacing = "";
    callPreviewDataUrl = "";
    callAvatarBmp = null;
    if (callHaloAnim != null) {
      callHaloAnim.cancel();
      callHaloAnim = null;
    }
    MainActivity.setKeepWebAlive(false);
    KeepAliveService.setCallMedia(app, false, false);
    try { NativeCallEngine.stop(); } catch (Exception ignored) {}
    if (!wasOn && (ringView == null || !sessionOn)) return;
    MAIN.post(() -> {
      if (app == null) return;
      if (MainActivity.isResumed()) {
        detach();
        return;
      }
      if (sessionOn) {
        detach();
        attach(app);
      } else {
        detach();
      }
    });
  }

  static void show(Context ctx, int cid, String name) {
    if (ctx == null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(ctx)) return;
    final Context app = ctx.getApplicationContext();
    characterId = cid;
    if (name != null && !name.trim().isEmpty()) charName = name.trim();
    sessionOn = true;
    appCtx = app;
    NianBridgePrefs.saveHaloChar(app, cid, charName);
    if (!ringPosLoaded) {
      loadRingPos(app);
      ringPosLoaded = true;
    }
    notifyServer(true);
    MAIN.post(() -> {
      if (MainActivity.isResumed()) return;
      attach(app);
    });
  }

  static void hide() {
    sessionOn = false;
    resumePeeked = false;
    inputOpen = false;
    inputImeBottom = 0;
    bubblesHidden = true;
    ringTapCount = 0;
    cancelPendingSingleTap();
    callOn = false;
    callVideo = false;
    callSpeaking = false;
    callPhase = "idle";
    callFacing = "";
    callPreviewDataUrl = "";
    callAvatarBmp = null;
    if (callHaloAnim != null) {
      callHaloAnim.cancel();
      callHaloAnim = null;
    }
    MainActivity.setKeepWebAlive(false);
    KeepAliveService.setCallMedia(appCtx, false, false);
    synchronized (BUBBLE_LOCK) {
      bubbles.clear();
      recentReplyKeys.clear();
      recentReplyAt.clear();
    }
    bubbleWave++;
    lastSentText = "";
    lastSentAt = 0;
    sendInFlight = 0;
    saveRingPos(appCtx);
    MAIN.post(ScreenShareOverlay::detach);
    notifyServer(false);
  }

  static void onAppForeground() {
    resumePeeked = sessionOn || callOn;
    inputOpen = false;
    inputImeBottom = 0;
    bubblesHidden = true;
    ringTapCount = 0;
    cancelPendingSingleTap();
    synchronized (BUBBLE_LOCK) {
      bubbles.clear();
    }
    bubbleWave++;
    lastSentText = "";
    lastSentAt = 0;
    sendInFlight = 0;
    MAIN.post(ScreenShareOverlay::detach);
    notifyServer(false);
  }

  static void onAppBackground(Context ctx) {
    if (ctx == null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(ctx)) return;
    int cid = characterId > 0 ? characterId : NianBridgePrefs.haloCharId(ctx);
    if (cid <= 0) return;
    String name = charName;
    if (name == null || name.trim().isEmpty() || "TA".equals(name)) {
      name = NianBridgePrefs.haloCharName(ctx);
    }
    show(ctx, cid, name);
  }

  static void showReply(String text) {
    addReplyParts(Collections.singletonList(text));
  }

  static void showReplies(List<String> texts) {
    addReplyParts(texts);
  }

  static void showReplyPayloads(JSONArray arr) {
    if (arr == null || arr.length() == 0) return;
    List<Bubble> incoming = new ArrayList<>();
    for (int i = 0; i < arr.length(); i++) {
      JSONObject o = arr.optJSONObject(i);
      if (o != null) {
        String type = o.optString("type", "text").trim();
        if ("system".equals(type) || "voice".equals(type)) continue;
        if ("emoji".equals(type)) {
          String url = o.optString("url", o.optString("content", "")).trim();
          if (!url.isEmpty()) incoming.add(new Bubble(false, "", "emoji", url));
          continue;
        }
        String part = cleanLine(o.optString("text", o.optString("content", "")));
        if (!part.isEmpty()) incoming.add(new Bubble(false, part));
        continue;
      }
      String part = cleanLine(arr.optString(i, ""));
      if (!part.isEmpty()) incoming.add(new Bubble(false, part));
    }
    addReplyBubbles(incoming);
  }

  static void runHidden(Runnable work) {
    if (!isAttached() || captureHidden) {
      work.run();
      return;
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      setCaptureHidden(true);
      try {
        work.run();
      } finally {
        setCaptureHidden(false);
      }
      return;
    }
    CountDownLatch hidden = new CountDownLatch(1);
    MAIN.post(() -> {
      setCaptureHidden(true);
      hidden.countDown();
    });
    try {
      hidden.await(400, TimeUnit.MILLISECONDS);
    } catch (InterruptedException ignored) {}
    try { Thread.sleep(90); } catch (InterruptedException ignored) {}
    try {
      work.run();
    } finally {
      MAIN.post(() -> setCaptureHidden(false));
    }
  }

  static String stripFromDump(String tree) {
    if (tree == null || tree.isEmpty()) return "";
    StringBuilder out = new StringBuilder(tree.length());
    for (String line : tree.split("\n")) {
      if (line.contains(IGNORE)) continue;
      if (line.contains("跟") && line.contains("说")) continue;
      if (line.equals("发送") || line.equals("×") || line.equals("✕") || line.contains("拖到这里移除")) continue;
      out.append(line).append('\n');
    }
    return out.toString().trim();
  }

  private static String bubbleKey(Bubble b) {
    if (b == null) return "";
    if ("wait".equals(b.kind)) return "w:pending";
    if ("emoji".equals(b.kind)) {
      String url = b.url == null ? "" : b.url.trim();
      return url.isEmpty() ? "" : "e:" + url;
    }
    String t = b.text == null ? "" : b.text;
    return t.isEmpty() ? "" : "t:" + t;
  }

  private static void addReplyParts(List<String> texts) {
    if (texts == null || texts.isEmpty()) return;
    List<Bubble> incoming = new ArrayList<>();
    for (String raw : texts) {
      String part = cleanLine(raw);
      if (!part.isEmpty()) incoming.add(new Bubble(false, part));
    }
    addReplyBubbles(incoming);
  }

  private static void addReplyBubbles(List<Bubble> incoming) {
    if (incoming == null || incoming.isEmpty()) return;
    if (!sessionOn || MainActivity.isResumed()) return;
    List<Bubble> accepted = new ArrayList<>();
    synchronized (BUBBLE_LOCK) {
      long now = System.currentTimeMillis();
      pruneRecentReplies(now);
      for (Bubble raw : incoming) {
        if (raw == null) continue;
        String key = bubbleKey(raw);
        if (key.isEmpty() || seenRecentReply(key)) continue;
        rememberReply(key, now);
        accepted.add(raw);
      }
      if (accepted.isEmpty()) return;
      // 先从数据里拿掉上一轮角色气泡；真正上屏时再写入，避免 attach/rebuild 把未弹出的先画一遍
      for (int i = bubbles.size() - 1; i >= 0; i--) {
        if (!bubbles.get(i).mine) bubbles.remove(i);
      }
    }
    MAIN.post(() -> applyIncomingBubbles(accepted, false, true));
  }

  private static void addMineBubble(String raw) {
    if (!sessionOn || MainActivity.isResumed()) return;
    String t = cleanLine(raw);
    if (t.isEmpty()) return;
    Bubble mine = new Bubble(true, t);
    synchronized (BUBBLE_LOCK) {
      // 只换掉上一轮自己的气泡；角色气泡等新回复出来再划走
      for (int i = bubbles.size() - 1; i >= 0; i--) {
        if (bubbles.get(i).mine) bubbles.remove(i);
      }
    }
    MAIN.post(() -> applyIncomingBubbles(Collections.singletonList(mine), true, false));
  }

  private static void showWaitBubble() {
    if (!sessionOn || MainActivity.isResumed() || callOn) return;
    MAIN.post(() -> applyIncomingBubbles(
      Collections.singletonList(new Bubble(false, "…", "wait", "")),
      false,
      true
    ));
  }

  private static boolean hasCharReplyBubble() {
    synchronized (BUBBLE_LOCK) {
      for (Bubble b : bubbles) {
        if (b != null && !b.mine && !"wait".equals(b.kind)) return true;
      }
    }
    return false;
  }

  private static String stripAutoReplyPrefix(String raw) {
    String t = raw == null ? "" : raw.trim();
    if (t.startsWith("【自动回复】")) t = t.substring("【自动回复】".length()).trim();
    return t;
  }

  private static List<Bubble> parseReplyBubbles(JSONObject res) {
    List<Bubble> replyBubbles = new ArrayList<>();
    if (res == null) return replyBubbles;
    JSONArray arr = res.optJSONArray("aiMessages");
    if (arr != null) {
      for (int i = 0; i < arr.length(); i++) {
        JSONObject m = arr.optJSONObject(i);
        if (m == null) continue;
        String type = m.optString("type", "text");
        if ("system".equals(type) || "voice".equals(type)) continue;
        if ("emoji".equals(type)) {
          String url = m.optString("content", "").trim();
          if (!url.isEmpty()) replyBubbles.add(new Bubble(false, "", "emoji", url));
          continue;
        }
        if (!"text".equals(type)) continue;
        String c = cleanLine(m.optString("content", ""));
        if (!c.isEmpty()) replyBubbles.add(new Bubble(false, c));
      }
    }
    if (replyBubbles.isEmpty()) {
      String reply = cleanLine(res.optString("content", ""));
      if (reply.isEmpty()) reply = cleanLine(stripAutoReplyPrefix(res.optString("autoReply", "")));
      if (!reply.isEmpty()) replyBubbles.add(new Bubble(false, reply));
    }
    return replyBubbles;
  }

  private static JSONObject postOverlaySend(Context app, int cid, String text, boolean hideChat) throws Exception {
    JSONObject body = new JSONObject();
    body.put("characterId", cid);
    body.put("content", text);
    body.put("source", "overlay");
    if (hideChat) body.put("hideChat", true);
    String raw = PhoneHttp.post(app, "/api/messages/send", body.toString(), SEND_TIMEOUT_MS);
    return new JSONObject(raw);
  }

  private static void pruneRecentReplies(long now) {
    for (int i = recentReplyAt.size() - 1; i >= 0; i--) {
      if (now - recentReplyAt.get(i) <= REPLY_DEDUP_MS) continue;
      recentReplyKeys.remove(i);
      recentReplyAt.remove(i);
    }
  }

  private static boolean seenRecentReply(String part) {
    for (int i = 0; i < recentReplyKeys.size(); i++) {
      if (part.equals(recentReplyKeys.get(i))) return true;
    }
    return false;
  }

  private static void rememberReply(String part, long now) {
    recentReplyKeys.add(part);
    recentReplyAt.add(now);
    while (recentReplyKeys.size() > 40) {
      recentReplyKeys.remove(0);
      recentReplyAt.remove(0);
    }
  }

  private static void applyIncomingBubbles(List<Bubble> incoming, boolean slideMine, boolean slideChar) {
    if (appCtx == null || !sessionOn || MainActivity.isResumed()) return;
    if (incoming == null || incoming.isEmpty()) return;
    if (callOn) return;
    bubblesHidden = false;
    slideOutRows(slideMine, slideChar);
    ensureBubbleHost(appCtx);
    if (bubbleView != null) bubbleView.setVisibility(View.VISIBLE);
    if (slideChar) bubbleWave++;
    final int wave = bubbleWave;
    int delay = 0;
    Bubble prev = null;
    for (Bubble b : incoming) {
      if (prev != null) delay += bubbleHoldMs(prev);
      final Bubble bubble = b;
      final int wait = delay;
      MAIN.postDelayed(() -> {
        if (appCtx == null || !sessionOn || MainActivity.isResumed()) return;
        if (callOn || bubblesHidden) return;
        if (slideChar && wave != bubbleWave) return;
        appendBubbleAnimated(appCtx, bubble);
      }, wait);
      prev = b;
    }
  }

  /** 上一条在屏幕上停留多久再出下一条：按字数估阅读时间，短句也至少约 4 秒 */
  private static int bubbleHoldMs(Bubble b) {
    if (b == null) return 4000;
    if ("wait".equals(b.kind)) return 0;
    if ("emoji".equals(b.kind)) return 2400 + (int) (Math.random() * 800);
    int len = b.text == null ? 0 : b.text.length();
    if (len < 1) len = 1;
    int hold = 1800 + len * 320;
    if (hold < 4000) hold = 4000;
    if (hold > 12000) hold = 12000;
    return hold + (int) (Math.random() * 1000);
  }

  private static String displayText(String raw) {
    if (raw == null) return "";
    String t = raw.trim();
    if (t.startsWith("{")) {
      try {
        JSONObject j = new JSONObject(t);
        if (j.has("voice") || j.has("album") || j.has("transcript")) return "";
      } catch (Exception ignored) {}
    }
    return t.replaceAll("\\[(桌宠|舵机|灯光|动作|表情):[^\\]]*\\]", "")
      .replaceAll("<[^>]+>", "")
      .trim();
  }

  private static String stripPeriod(String s) {
    if (s == null) return "";
    return s.replaceAll("[。．]+$", "").trim();
  }

  private static String cleanLine(String raw) {
    String t = stripPeriod(displayText(raw).replaceAll("[ \\t]{2,}", " ").trim());
    if (isOverlaySystemText(t) || isBarePokeSuffix(t)) return "";
    if (t.length() > 240) t = t.substring(0, 240) + "…";
    return t;
  }

  /** 拍一拍、占位提示等系统行只进聊天页，不铺屏幕 */
  private static boolean isOverlaySystemText(String raw) {
    if (raw == null) return true;
    String t = raw.trim();
    if (t.isEmpty()) return true;
    if (t.contains("拍了拍")) return true;
    if (t.startsWith("[拍一拍提示]")) return true;
    if ("新消息".equals(t) || "[新消息]".equals(t)) return true;
    return false;
  }

  /** 拍一拍部位被模型单独吐出来时不当气泡 */
  private static boolean isBarePokeSuffix(String raw) {
    if (raw == null) return true;
    String t = raw.trim();
    if (t.startsWith("的") && t.length() > 1) t = t.substring(1);
    if (t.isEmpty()) return true;
    switch (t) {
      case "脑袋":
      case "脑袋瓜":
      case "头":
      case "头顶":
      case "脑门":
      case "后脑勺":
      case "肩膀":
      case "肩":
      case "脸颊":
      case "脸":
      case "脸蛋":
      case "狗头":
      case "发梢":
      case "头发":
      case "额头":
      case "鼻子":
      case "耳朵":
      case "胳膊":
      case "手臂":
      case "手":
      case "背":
      case "腰":
      case "屁股":
        return true;
      default:
        return false;
    }
  }

  /** 一条消息就是一条气泡；句末「。」不显示。 */

  private static void setCaptureHidden(boolean hide) {
    captureHidden = hide;
    int vis = hide ? View.GONE : View.VISIBLE;
    if (ringView != null) ringView.setVisibility(vis);
    if (removeZone != null) removeZone.setVisibility(vis);
    if (bubbleView != null) {
      boolean showChat = !hide && !callOn && !bubblesHidden;
      bubbleView.setVisibility(showChat ? View.VISIBLE : View.GONE);
    }
    if (inputView != null) {
      boolean showInputBar = !hide && inputOpen && !ringPeeking && !callOn;
      inputView.setVisibility(showInputBar ? View.VISIBLE : View.GONE);
    }
  }

  private static void attach(Context ctx) {
    if (!sessionOn || MainActivity.isResumed()) return;
    WindowManager mgr = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
    if (mgr == null) return;
    wm = mgr;
    watchDisplay(ctx);
    Disp now = disp(ctx);
    lastDispW = now.w;
    lastDispH = now.h;
    boolean startPeeked = resumePeeked;
    resumePeeked = false;
    // 第一次挂上默认贴边，等用户点开；通话或已经展开的保持展开
    if (ringView == null && !callOn) startPeeked = true;
    if (startPeeked) {
      inputOpen = false;
    }
    String wantKind = orbKind();
    if (ringView == null || !wantKind.equals(orbKindInstalled)) {
      ringFree = false;
      ringPeeking = startPeeked;
      ensureRingPos(ctx);
      ringX = dockedX(ctx, ringOnRight, ringPeeking);
      installRingView(ctx);
    } else {
      if (startPeeked) ringPeeking = true;
      placeRing(ctx);
    }
    if (ringPeeking) closeInputBar();
    if (bubbleView != null && bubbleCol != null && bubbleView.getParent() != null) {
      updateBubblePad(ctx);
    } else {
      rebuildBubbles(ctx);
    }
    if (inputOpen && !callOn && !ringPeeking) showInput(ctx);
  }

  private static void detach() {
    inputOpen = false;
    inputImeBottom = 0;
    input = null;
    bubbleCol = null;
    cancelPeek();
    cancelLongPress();
    cancelPendingSingleTap();
    hideRemoveZone();
    if (ringMoveAnim != null) {
      ringMoveAnim.cancel();
      ringMoveAnim = null;
    }
    if (wm == null) return;
    remove(ringView);
    if (ringView instanceof RippleRingView) ((RippleRingView) ringView).stop();
    if (callHaloAnim != null) {
      callHaloAnim.cancel();
      callHaloAnim = null;
    }
    releaseCallPlayer();
    ringView = null;
    orbKindInstalled = "";
    remove(bubbleView);
    bubbleView = null;
    remove(inputView);
    inputView = null;
  }

  private static void installRingView(Context ctx) {
    if (wm == null || ctx == null) return;
    remove(ringView);
    if (ringView instanceof RippleRingView) ((RippleRingView) ringView).stop();
    releaseCallPlayer();
    ringView = null;
    View orb = callOn ? buildCallOrb(ctx) : new RippleRingView(ctx);
    if (!callOn) orb.setTag("halo");
    markIgnore(orb);
    orb.setOnTouchListener((v, ev) -> onRingTouch(ctx, v, ev));
    try {
      wm.addView(orb, ringOrbParams(ctx));
      ringView = orb;
      orbKindInstalled = orbKind();
      if (captureHidden) orb.setVisibility(View.GONE);
    } catch (Exception ignored) {}
  }

  private static String orbKind() {
    if (!callOn) return "halo";
    if (!callVideo) return "call";
    return "call-video|" + (callClipUrl == null ? "" : callClipUrl);
  }

  private static boolean isVideoCallOrb() {
    return callOn && callVideo;
  }

  private static int orbW(Context ctx) {
    return dp(ctx, isVideoCallOrb() ? CALL_VIDEO_W_DP : RING_BOX_DP);
  }

  private static int orbH(Context ctx) {
    return dp(ctx, isVideoCallOrb() ? CALL_VIDEO_H_DP : RING_BOX_DP);
  }

  private static int callAvatarSize(Context ctx) {
    return dp(ctx, isVideoCallOrb() ? Math.min(CALL_VIDEO_H_DP, CALL_AVATAR_DP + 8) : CALL_AVATAR_DP);
  }

  private static View buildCallOrb(Context ctx) {
    boolean video = callVideo;
    boolean hasClip = video && callClipUrl != null && !callClipUrl.isEmpty();
    int boxW = orbW(ctx);
    int boxH = orbH(ctx);
    int av = callAvatarSize(ctx);
    int radius = dp(ctx, video ? CALL_VIDEO_RADIUS_DP : CALL_AVATAR_DP / 2);
    FrameLayout box = new FrameLayout(ctx);
    box.setTag(video ? "call-video" : "call");
    if (video) {
      box.setBackgroundColor(Color.parseColor("#0C0D12"));
      roundRectClip(box, radius);
    }

    if (!hasClip) {
      ImageView avView = new ImageView(ctx);
      avView.setScaleType(ImageView.ScaleType.CENTER_CROP);
      avView.setBackground(roundBg(Color.parseColor("#C48BBE"), radius));
      if (video) roundRectClip(avView, radius);
      else ovalClip(avView);
      if (callAvatarBmp != null && !callAvatarBmp.isRecycled()) {
        avView.setImageBitmap(callAvatarBmp);
      } else {
        avView.setImageDrawable(roundBg(Color.parseColor("#C48BBE"), radius));
        loadCallAvatar(ctx, avView);
      }
      box.addView(avView, new FrameLayout.LayoutParams(av, av, Gravity.CENTER));
    }

    if (hasClip) {
      TextureView tv = new TextureView(ctx);
      tv.setOpaque(false);
      tv.setTag("clip");
      roundRectClip(tv, radius);
      box.addView(tv, new FrameLayout.LayoutParams(
        video ? boxW : av, video ? boxH : av, Gravity.CENTER));
      tv.addOnLayoutChangeListener((view, a, b, c, d, e, f, g, hh) -> {
        if (view instanceof TextureView) applyCallClipContain((TextureView) view, 0, 0);
      });
      bindCallClip(tv, callClipUrl);
    }

    View speak = new View(ctx);
    speak.setTag("speak");
    boolean pink = "listening".equals(callPhase);
    speak.setBackground(callHaloDrawable(ctx, video, pink));
    boolean showHalo = "speaking".equals(callPhase) || "thinking".equals(callPhase) || "listening".equals(callPhase);
    speak.setVisibility(showHalo ? View.VISIBLE : View.GONE);
    box.addView(speak, new FrameLayout.LayoutParams(boxW, boxH, Gravity.CENTER));

    TextView hang = new TextView(ctx);
    hang.setTag("hangup");
    hang.setText("✕");
    hang.setGravity(Gravity.CENTER);
    hang.setTextColor(Color.WHITE);
    hang.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
    hang.setBackground(roundBg(Color.parseColor("#E05555"), dp(ctx, 9)));
    hang.setOnClickListener(v -> MainActivity.hangupCallFromNative());
    int hs = dp(ctx, 18);
    FrameLayout.LayoutParams hlp = new FrameLayout.LayoutParams(hs, hs);
    hlp.gravity = Gravity.TOP | Gravity.END;
    int inset = video ? 0 : dp(ctx, Math.max(0, CALL_HALO_PAD_DP - 2));
    hlp.topMargin = inset;
    hlp.rightMargin = inset;
    box.addView(hang, hlp);
    MAIN.post(ScreenShareOverlay::applyCallHalo);
    return box;
  }

  private static void ovalClip(View v) {
    v.setClipToOutline(true);
    v.setOutlineProvider(new ViewOutlineProvider() {
      @Override
      public void getOutline(View view, Outline outline) {
        int w = Math.max(1, view.getWidth());
        int h = Math.max(1, view.getHeight());
        outline.setOval(0, 0, w, h);
      }
    });
    v.addOnLayoutChangeListener((view, a, b, c, d, e, f, g, h) -> view.invalidateOutline());
  }

  private static void roundRectClip(View v, int radiusPx) {
    final int r = Math.max(1, radiusPx);
    v.setClipToOutline(true);
    v.setOutlineProvider(new ViewOutlineProvider() {
      @Override
      public void getOutline(View view, Outline outline) {
        int w = Math.max(1, view.getWidth());
        int h = Math.max(1, view.getHeight());
        outline.setRoundRect(0, 0, w, h, r);
      }
    });
    v.addOnLayoutChangeListener((view, a, b, c, d, e, f, g, h) -> view.invalidateOutline());
  }

  private static android.graphics.drawable.GradientDrawable callHaloDrawable(Context ctx, boolean video, boolean pink) {
    android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
    if (video) {
      g.setShape(android.graphics.drawable.GradientDrawable.RECTANGLE);
      g.setCornerRadius(dp(ctx, CALL_VIDEO_RADIUS_DP + 4));
    } else {
      g.setShape(android.graphics.drawable.GradientDrawable.OVAL);
    }
    g.setColor(Color.TRANSPARENT);
    int color = pink ? CALL_HALO_PINK : CALL_HALO_BLUE;
    g.setStroke(dp(ctx, 2), color);
    return g;
  }

  private static android.graphics.drawable.GradientDrawable speakRingDrawable(Context ctx, boolean video) {
    return callHaloDrawable(ctx, video, false);
  }

  private static void applyCallClipContain(TextureView tv, int videoW, int videoH) {
    if (tv == null) return;
    if (videoW > 0 && videoH > 0) {
      clipVideoW = videoW;
      clipVideoH = videoH;
    }
    int vw = clipVideoW;
    int vh = clipVideoH;
    int viewW = tv.getWidth();
    int viewH = tv.getHeight();
    if (viewW <= 0 || viewH <= 0 || vw <= 0 || vh <= 0) return;
    float viewAspect = viewW / (float) viewH;
    float videoAspect = vw / (float) vh;
    Matrix matrix = new Matrix();
    if (videoAspect > viewAspect) {
      float scaleY = viewAspect / videoAspect;
      matrix.setScale(1f, scaleY, viewW / 2f, viewH / 2f);
    } else {
      float scaleX = videoAspect / viewAspect;
      matrix.setScale(scaleX, 1f, viewW / 2f, viewH / 2f);
    }
    tv.setTransform(matrix);
  }

  private static void loadCallAvatar(Context ctx, ImageView av) {
    String url = resolveHttpUrl(ctx, callAvatarUrl);
    if (url.isEmpty()) return;
    final Context app = ctx.getApplicationContext();
    new Thread(() -> {
      Bitmap bmp = decodeBitmap(url, dp(app, CALL_AVATAR_DP));
      if (bmp == null) return;
      callAvatarBmp = bmp;
      MAIN.post(() -> {
        if (av.getWindowToken() == null) return;
        av.setImageBitmap(bmp);
      });
    }, "nian-call-av").start();
  }

  private static String resolveHttpUrl(Context ctx, String raw) {
    if (raw == null) return "";
    String s = raw.trim();
    if (s.isEmpty() || s.startsWith("data:")) return "";
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
    if (s.startsWith("/")) {
      String base = NianBridgePrefs.serverBase(ctx);
      if (base != null && !base.isEmpty()) return base + s;
    }
    return "";
  }

  private static void bindSticker(ImageView iv, String rawUrl) {
    if (iv == null) return;
    String url = resolveHttpUrl(iv.getContext(), rawUrl);
    if (url.isEmpty()) return;
    int max = dp(iv.getContext(), 100);
    new Thread(() -> {
      byte[] bytes = downloadBytes(url, 2 * 1024 * 1024);
      if (bytes == null || bytes.length == 0) return;
      MAIN.post(() -> {
        if (iv.getWindowToken() == null) return;
        if (applyAnimatedSticker(iv, bytes)) return;
        Bitmap bmp = decodeBitmapFitBytes(bytes, max);
        if (bmp != null) iv.setImageBitmap(bmp);
      });
    }, "nian-sticker").start();
  }

  private static byte[] downloadBytes(String url, int maxBytes) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(5000);
      c.setReadTimeout(8000);
      c.setInstanceFollowRedirects(true);
      InputStream in = c.getInputStream();
      java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
      byte[] buf = new byte[8192];
      int n;
      int total = 0;
      while ((n = in.read(buf)) >= 0) {
        total += n;
        if (total > maxBytes) return null;
        bos.write(buf, 0, n);
      }
      return bos.toByteArray();
    } catch (Exception e) {
      return null;
    } finally {
      if (c != null) c.disconnect();
    }
  }

  /** GIF / 动态 WebP：能播就播，否则退回静帧 */
  private static boolean applyAnimatedSticker(ImageView iv, byte[] bytes) {
    if (iv == null || bytes == null || bytes.length < 6) return false;
    try {
      if (Build.VERSION.SDK_INT >= 28) {
        ImageDecoder.Source src = ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes));
        Drawable d = ImageDecoder.decodeDrawable(src, (decoder, info, source) -> {
          decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
        });
        iv.setImageDrawable(d);
        if (d instanceof Animatable) ((Animatable) d).start();
        return true;
      }
    } catch (Exception ignored) {}
    try {
      Movie movie = Movie.decodeByteArray(bytes, 0, bytes.length);
      if (movie != null && movie.duration() > 0) {
        MovieGifDrawable d = new MovieGifDrawable(movie);
        iv.setImageDrawable(d);
        d.start();
        return true;
      }
    } catch (Exception ignored) {}
    return false;
  }

  private static Bitmap decodeBitmapFitBytes(byte[] bytes, int maxPx) {
    try {
      Bitmap raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
      if (raw == null) return null;
      int w = raw.getWidth();
      int h = raw.getHeight();
      if (w <= 0 || h <= 0) return raw;
      float scale = Math.min(1f, maxPx / (float) Math.max(w, h));
      int nw = Math.max(1, Math.round(w * scale));
      int nh = Math.max(1, Math.round(h * scale));
      if (nw == w && nh == h) return raw;
      return Bitmap.createScaledBitmap(raw, nw, nh, true);
    } catch (Exception e) {
      return null;
    }
  }

  /** API 24–27：用 Movie 播 GIF */
  private static final class MovieGifDrawable extends Drawable implements Animatable, Runnable {
    private final Movie movie;
    private final int duration;
    private long startAt;
    private boolean running;

    MovieGifDrawable(Movie movie) {
      this.movie = movie;
      int d = movie.duration();
      this.duration = d > 0 ? d : 1000;
    }

    @Override public void start() {
      if (running) return;
      running = true;
      startAt = System.currentTimeMillis();
      invalidateSelf();
      scheduleSelf(this, System.currentTimeMillis() + 16);
    }

    @Override public void stop() {
      running = false;
      unscheduleSelf(this);
    }

    @Override public boolean isRunning() { return running; }

    @Override public void run() {
      if (!running) return;
      invalidateSelf();
      scheduleSelf(this, System.currentTimeMillis() + 16);
    }

    @Override public void draw(Canvas canvas) {
      long now = System.currentTimeMillis();
      if (startAt == 0) startAt = now;
      int t = (int) ((now - startAt) % duration);
      movie.setTime(t);
      android.graphics.Rect b = getBounds();
      float sx = b.width() / (float) Math.max(1, movie.width());
      float sy = b.height() / (float) Math.max(1, movie.height());
      float s = Math.min(sx, sy);
      canvas.save();
      canvas.translate(
        b.left + (b.width() - movie.width() * s) / 2f,
        b.top + (b.height() - movie.height() * s) / 2f
      );
      canvas.scale(s, s);
      movie.draw(canvas, 0, 0);
      canvas.restore();
    }

    @Override public void setAlpha(int alpha) {}
    @Override public void setColorFilter(android.graphics.ColorFilter colorFilter) {}
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    @Override public int getIntrinsicWidth() { return Math.max(1, movie.width()); }
    @Override public int getIntrinsicHeight() { return Math.max(1, movie.height()); }

    @Override public boolean setVisible(boolean visible, boolean restart) {
      boolean changed = super.setVisible(visible, restart);
      if (visible) start();
      else stop();
      return changed;
    }
  }

  private static Bitmap decodeBitmapFit(String url, int maxPx) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(5000);
      c.setReadTimeout(8000);
      c.setInstanceFollowRedirects(true);
      InputStream in = c.getInputStream();
      Bitmap raw = BitmapFactory.decodeStream(in);
      if (raw == null) return null;
      int w = raw.getWidth();
      int h = raw.getHeight();
      if (w <= 0 || h <= 0) return raw;
      float scale = Math.min(1f, maxPx / (float) Math.max(w, h));
      int nw = Math.max(1, Math.round(w * scale));
      int nh = Math.max(1, Math.round(h * scale));
      if (nw == w && nh == h) return raw;
      return Bitmap.createScaledBitmap(raw, nw, nh, true);
    } catch (Exception e) {
      return null;
    } finally {
      if (c != null) c.disconnect();
    }
  }

  private static Bitmap decodeBitmap(String url, int sizePx) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(5000);
      c.setReadTimeout(8000);
      c.setInstanceFollowRedirects(true);
      InputStream in = c.getInputStream();
      Bitmap raw = BitmapFactory.decodeStream(in);
      if (raw == null) return null;
      return Bitmap.createScaledBitmap(raw, sizePx, sizePx, true);
    } catch (Exception e) {
      return null;
    } finally {
      if (c != null) c.disconnect();
    }
  }

  private static void bindCallClip(TextureView tv, String url) {
    String src = url == null ? "" : url.trim();
    if (src.isEmpty()) return;
    tv.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
      @Override
      public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
        try {
          releaseCallPlayer();
          MediaPlayer mp = new MediaPlayer();
          callPlayer = mp;
          mp.setDataSource(src);
          mp.setSurface(new Surface(surface));
          mp.setLooping(true);
          mp.setVolume(0f, 0f);
          mp.setOnVideoSizeChangedListener((player, vw, vh) ->
            MAIN.post(() -> applyCallClipContain(tv, vw, vh)));
          mp.setOnPreparedListener(p -> MAIN.post(() -> {
            if (callPlayer != p) return;
            applyCallClipContain(tv, p.getVideoWidth(), p.getVideoHeight());
            try { p.start(); } catch (Exception ignored) {}
          }));
          mp.setOnErrorListener((player, what, extra) -> {
            MAIN.post(() -> {
              try {
                android.view.ViewParent parent = tv.getParent();
                if (parent instanceof FrameLayout) ((FrameLayout) parent).removeView(tv);
              } catch (Exception ignored) {}
            });
            return true;
          });
          mp.prepareAsync();
        } catch (Exception ignored) {}
      }

      @Override
      public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {
        MAIN.post(() -> applyCallClipContain(tv, 0, 0));
      }

      @Override
      public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
        releaseCallPlayer();
        return true;
      }

      @Override
      public void onSurfaceTextureUpdated(SurfaceTexture surface) {}
    });
  }

  private static void releaseCallPlayer() {
    MediaPlayer mp = callPlayer;
    callPlayer = null;
    clipVideoW = 0;
    clipVideoH = 0;
    if (mp == null) return;
    try { mp.stop(); } catch (Exception ignored) {}
    try { mp.release(); } catch (Exception ignored) {}
  }

  private static void syncCallChrome() {
    if (!(ringView instanceof FrameLayout)) return;
    View hang = ((FrameLayout) ringView).findViewWithTag("hangup");
    if (hang != null) hang.setVisibility(ringPeeking ? View.GONE : View.VISIBLE);
  }

  private static void remove(View v) {
    if (v == null || wm == null) return;
    try { wm.removeView(v); } catch (Exception ignored) {}
  }

  private static void toggleInput(Context ctx) {
    showInput(ctx);
  }

  private static void showInput(Context ctx) {
    if (callOn) return;
    if (wm == null) return;
    bubblesHidden = false;
    inputOpen = true;
    inputImeBottom = 0;
    ringPeeking = false;
    if (inputView != null) {
      try { wm.removeView(inputView); } catch (Exception ignored) {}
      inputView = null;
      input = null;
    }
    View bar = buildInputBar(ctx);
    markIgnore(bar);
    try {
      wm.addView(bar, inputParams(ctx));
      inputView = bar;
      if (captureHidden) bar.setVisibility(View.GONE);
    } catch (Exception ignored) {}
    expandRing(ctx);
    showExistingBubbles(ctx);
    // 文本框打开时不自动收起吸附
    cancelPeek();
  }

  private static void hideKeyboard() {
    if (input == null) return;
    try {
      InputMethodManager imm = (InputMethodManager) input.getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
      if (imm != null) imm.hideSoftInputFromWindow(input.getWindowToken(), 0);
    } catch (Exception ignored) {}
  }

  private static void closeInputBar() {
    inputOpen = false;
    hideKeyboard();
    remove(inputView);
    inputView = null;
    input = null;
    inputImeBottom = 0;
    if (appCtx != null) updateBubblePad(appCtx);
  }

  private static void dismissChatForPeek() {
    closeInputBar();
  }

  private static void hideScreenChat() {
    closeInputBar();
    bubblesHidden = true;
    if (bubbleCol != null && bubbleCol.getChildCount() > 0) {
      slideOutRows(true, true);
      MAIN.postDelayed(() -> {
        if (!bubblesHidden) return;
        if (bubbleView != null) bubbleView.setVisibility(View.GONE);
      }, SLIDE_MS + 80);
      return;
    }
    if (bubbleView != null) bubbleView.setVisibility(View.GONE);
  }

  private static void hideInput() {
    closeInputBar();
    if (appCtx == null || ringPeeking) return;
    bubblesHidden = false;
    placeRing(appCtx);
    showExistingBubbles(appCtx);
  }

  private static void ensureBubbleHost(Context ctx) {
    if (ctx == null || wm == null) return;
    if (bubbleView != null && bubbleCol != null && bubbleView.getParent() != null) {
      updateBubblePad(ctx);
      return;
    }
    remove(bubbleView);
    bubbleView = null;
    bubbleCol = null;
    ScrollView sc = new ScrollView(ctx);
    sc.setFillViewport(false);
    sc.setBackgroundColor(Color.TRANSPARENT);
    sc.setVerticalScrollBarEnabled(false);
    sc.setClipChildren(false);
    sc.setClipToPadding(false);
    LinearLayout col = new LinearLayout(ctx);
    col.setOrientation(LinearLayout.VERTICAL);
    col.setBackgroundColor(Color.TRANSPARENT);
    col.setClipChildren(false);
    col.setClipToPadding(false);
    updateBubblePad(ctx, col);
    sc.addView(col, new ScrollView.LayoutParams(-1, -2));
    markIgnore(sc);
    WindowManager.LayoutParams lp = ringVisualParams();
    lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
    try {
      wm.addView(sc, lp);
      bubbleView = sc;
      bubbleCol = col;
      if (captureHidden || bubblesHidden) sc.setVisibility(View.GONE);
    } catch (Exception ignored) {}
  }

  private static void updateBubblePad(Context ctx) {
    updateBubblePad(ctx, bubbleCol);
  }

  private static void updateBubblePad(Context ctx, LinearLayout col) {
    if (ctx == null || col == null) return;
    int pad = dp(ctx, 16);
    int bottomPad = (inputOpen ? dp(ctx, 86) : dp(ctx, 24)) + navBar(ctx) + Math.max(0, inputImeBottom);
    col.setPadding(pad, statusBarHeight(ctx) + dp(ctx, 16), pad, bottomPad);
  }

  private static boolean columnHasKey(String key) {
    if (bubbleCol == null || key == null || key.isEmpty()) return false;
    for (int i = 0; i < bubbleCol.getChildCount(); i++) {
      Object existing = bubbleCol.getChildAt(i).getTag(TAG_BUBBLE_KEY);
      if (key.equals(existing)) return true;
    }
    return false;
  }

  private static void rememberDisplayed(Bubble b) {
    if (b == null) return;
    synchronized (BUBBLE_LOCK) {
      String key = bubbleKey(b);
      if (key.isEmpty()) return;
      for (Bubble cur : bubbles) {
        if (key.equals(bubbleKey(cur))) return;
      }
      bubbles.add(b);
    }
  }

  private static void appendBubbleAnimated(Context ctx, Bubble b) {
    ensureBubbleHost(ctx);
    if (bubbleCol == null || bubbleView == null || b == null) return;
    String key = bubbleKey(b);
    if (key.isEmpty() || columnHasKey(key)) return;
    bubbleView.setVisibility(View.VISIBLE);
    updateBubblePad(ctx);
    rememberDisplayed(b);
    View row = buildBubble(ctx, b);
    row.setAlpha(0f);
    row.setTranslationY(dp(ctx, 12));
    bubbleCol.addView(row);
    row.animate().alpha(1f).translationY(0f).setDuration(280).start();
    bubbleView.post(() -> {
      if (bubbleView instanceof ScrollView) ((ScrollView) bubbleView).fullScroll(View.FOCUS_DOWN);
    });
  }

  private static void slideOutRows(boolean mine, boolean other) {
    if (bubbleCol == null) return;
    int delay = 0;
    int n = bubbleCol.getChildCount();
    for (int i = 0; i < n; i++) {
      View child = bubbleCol.getChildAt(i);
      boolean isMine = Boolean.TRUE.equals(child.getTag());
      if (!(mine && isMine) && !(other && !isMine)) continue;
      child.setTag(TAG_BUBBLE_KEY, null);
      final View v = child;
      final boolean slideMine = isMine;
      MAIN.postDelayed(() -> slideOutRow(v, slideMine), delay);
      delay += 70;
    }
  }

  private static void slideOutRow(View v, boolean mine) {
    if (v == null) return;
    int w = v.getResources().getDisplayMetrics().widthPixels;
    int h = v.getHeight();
    v.animate().cancel();
    v.animate()
      .translationX(mine ? w : -w)
      .alpha(0f)
      .setDuration(SLIDE_MS)
      .setInterpolator(new DecelerateInterpolator())
      .withEndAction(() -> {
        if (bubbleCol != null) bubbleCol.removeView(v);
      })
      .start();
    if (h > 0 && v.getLayoutParams() instanceof LinearLayout.LayoutParams) {
      LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) v.getLayoutParams();
      ValueAnimator ha = ValueAnimator.ofInt(h, 0);
      ha.setDuration(SLIDE_MS);
      ha.setInterpolator(new DecelerateInterpolator());
      ha.addUpdateListener(a -> {
        lp.height = (int) a.getAnimatedValue();
        lp.topMargin = 0;
        v.setLayoutParams(lp);
      });
      ha.start();
    }
  }

  private static void showExistingBubbles(Context ctx) {
    if (ctx == null || callOn) return;
    bubblesHidden = false;
    ensureBubbleHost(ctx);
    updateBubblePad(ctx);
    if (bubbleView == null) return;
    synchronized (BUBBLE_LOCK) {
      if (bubbles.isEmpty() && (bubbleCol == null || bubbleCol.getChildCount() == 0)) {
        bubbleView.setVisibility(View.GONE);
        return;
      }
    }
    bubbleView.setVisibility(View.VISIBLE);
  }

  private static void rebuildBubbles(Context ctx) {
    if (wm == null || ctx == null) return;
    if (callOn || bubblesHidden) {
      if (bubbleView != null) bubbleView.setVisibility(View.GONE);
      return;
    }
    List<Bubble> snapshot;
    synchronized (BUBBLE_LOCK) {
      snapshot = new ArrayList<>(bubbles);
    }
    if (snapshot.isEmpty()) {
      if (bubbleView != null) bubbleView.setVisibility(View.GONE);
      return;
    }
    ensureBubbleHost(ctx);
    if (bubbleView == null || bubbleCol == null) return;
    bubbleView.setVisibility(View.VISIBLE);
    updateBubblePad(ctx);
    bubbleCol.removeAllViews();
    for (Bubble b : snapshot) bubbleCol.addView(buildBubble(ctx, b));
    if (captureHidden) bubbleView.setVisibility(View.GONE);
    bubbleView.post(() -> {
      if (bubbleView instanceof ScrollView) ((ScrollView) bubbleView).fullScroll(View.FOCUS_DOWN);
    });
  }

  private static View buildBubble(Context ctx, Bubble b) {
    FrameLayout row = new FrameLayout(ctx);
    row.setTag(b.mine);
    row.setTag(TAG_BUBBLE_KEY, bubbleKey(b));
    row.setBackgroundColor(Color.TRANSPARENT);
    LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(-1, -2);
    rowLp.topMargin = dp(ctx, 6);
    row.setLayoutParams(rowLp);

    if ("emoji".equals(b.kind) && !b.url.isEmpty()) {
      ImageView iv = new ImageView(ctx);
      int size = dp(ctx, 100);
      iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
      iv.setAdjustViewBounds(true);
      iv.setBackground(null);
      FrameLayout.LayoutParams ilp = new FrameLayout.LayoutParams(size, size);
      ilp.gravity = b.mine ? (Gravity.END | Gravity.BOTTOM) : (Gravity.START | Gravity.BOTTOM);
      row.addView(iv, ilp);
      bindSticker(iv, b.url);
      return row;
    }

    TextView tv = new TextView(ctx);
    OverlayBeans.bind(tv, b.text);
    tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
    tv.setMaxWidth((int) (ctx.getResources().getDisplayMetrics().widthPixels * 0.72f));
    int padH = dp(ctx, 12);
    int padV = dp(ctx, 8);
    tv.setPadding(padH, padV, padH, padV);
    if (b.mine) {
      tv.setTextColor(Color.parseColor("#1A1224"));
      tv.setBackground(roundBg(Color.parseColor("#E6FFFFFF"), dp(ctx, 16)));
    } else if ("wait".equals(b.kind)) {
      tv.setTextColor(Color.parseColor("#991A1224"));
      tv.setBackground(roundBg(Color.parseColor("#99FFE6F4"), dp(ctx, 16)));
    } else {
      tv.setTextColor(Color.parseColor("#1A1224"));
      tv.setBackground(roundBg(Color.parseColor("#E6FFE6F4"), dp(ctx, 16)));
    }
    FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(-2, -2);
    tlp.gravity = b.mine ? (Gravity.END | Gravity.BOTTOM) : (Gravity.START | Gravity.BOTTOM);
    row.addView(tv, tlp);
    return row;
  }

  private static View buildInputBar(Context ctx) {
    LinearLayout row = new LinearLayout(ctx);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setGravity(Gravity.CENTER_VERTICAL);
    row.setBackgroundColor(Color.TRANSPARENT);
    applyInputBarPadding(row, ctx, 0);

    LinearLayout field = new LinearLayout(ctx);
    field.setOrientation(LinearLayout.HORIZONTAL);
    field.setGravity(Gravity.CENTER_VERTICAL);
    field.setPadding(dp(ctx, 12), dp(ctx, 6), dp(ctx, 6), dp(ctx, 6));
    field.setBackground(roundBg(Color.parseColor("#DFFFFFFF"), dp(ctx, 22)));

    EditText ed = new EditText(ctx);
    ed.setHint("跟" + charName + "说…");
    ed.setHintTextColor(Color.parseColor("#88000000"));
    ed.setTextColor(Color.parseColor("#1A1224"));
    ed.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
    ed.setBackground(null);
    ed.setSingleLine(true);
    ed.setImeOptions(EditorInfo.IME_ACTION_SEND);
    ed.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
    ed.setOnEditorActionListener((v, actionId, event) -> {
      boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
        && event.getAction() == KeyEvent.ACTION_DOWN;
      if (actionId == EditorInfo.IME_ACTION_SEND
        || actionId == EditorInfo.IME_ACTION_DONE
        || actionId == EditorInfo.IME_ACTION_GO
        || enter) {
        sendNow(ctx, ed);
        return true;
      }
      return false;
    });
    input = ed;
    ed.addTextChangedListener(new TextWatcher() {
      @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
      @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
      @Override public void afterTextChanged(Editable s) {}
    });
    field.addView(ed, new LinearLayout.LayoutParams(0, -2, 1f));

    TextView send = new TextView(ctx);
    send.setText("发送");
    send.setTextColor(Color.parseColor("#C48BBE"));
    send.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
    send.setTypeface(Typeface.DEFAULT_BOLD);
    send.setPadding(dp(ctx, 10), dp(ctx, 8), dp(ctx, 10), dp(ctx, 8));
    send.setMinWidth(dp(ctx, 48));
    send.setMinHeight(dp(ctx, 40));
    send.setClickable(true);
    send.setFocusable(true);
    send.setOnClickListener(v -> sendNow(ctx, ed));
    send.setOnTouchListener((v, ev) -> {
      if (ev.getAction() == MotionEvent.ACTION_UP) {
        sendNow(ctx, ed);
        return true;
      }
      return ev.getAction() == MotionEvent.ACTION_DOWN;
    });
    field.addView(send);
    row.addView(field, new LinearLayout.LayoutParams(-1, -2));

    attachInputImeLift(row);
    ed.post(() -> {
      ed.requestFocus();
      InputMethodManager imm = (InputMethodManager) ctx.getSystemService(Context.INPUT_METHOD_SERVICE);
      if (imm != null) imm.showSoftInput(ed, InputMethodManager.SHOW_IMPLICIT);
    });
    return row;
  }

  private static void applyInputBarPadding(View bar, Context ctx, int imeBottom) {
    if (bar == null || ctx == null) return;
    int bottom = dp(ctx, 8) + (imeBottom > 0 ? 0 : navBar(ctx));
    bar.setPadding(dp(ctx, 12), dp(ctx, 6), dp(ctx, 12), bottom);
  }

  /**
   * Overlay 窗口的 SOFT_INPUT_ADJUST_RESIZE 经常无效；按 IME 高度改 LayoutParams.y，
   * 把底部胶囊顶到键盘上方，收起后再沉回底边。
   */
  private static void attachInputImeLift(View bar) {
    if (bar == null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      bar.setOnApplyWindowInsetsListener((v, insets) -> {
        applyInputImeLift(v.getContext(), readImeBottom(v.getContext(), v, insets));
        return insets;
      });
      bar.setWindowInsetsAnimationCallback(new WindowInsetsAnimation.Callback(
        WindowInsetsAnimation.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        @Override
        public WindowInsets onProgress(WindowInsets insets,
            java.util.List<WindowInsetsAnimation> runningAnims) {
          applyInputImeLift(bar.getContext(), readImeBottom(bar.getContext(), bar, insets));
          return insets;
        }
      });
    }
    ViewTreeObserver.OnGlobalLayoutListener gl = new ViewTreeObserver.OnGlobalLayoutListener() {
      @Override public void onGlobalLayout() {
        if (inputView != bar) {
          try { bar.getViewTreeObserver().removeOnGlobalLayoutListener(this); } catch (Exception ignored) {}
          return;
        }
        applyInputImeLift(bar.getContext(), readImeBottom(bar.getContext(), bar, null));
      }
    };
    bar.getViewTreeObserver().addOnGlobalLayoutListener(gl);
  }

  /** 取整屏级键盘高度；小条 Overlay 自身 inset 往往只有控件高，不能当抬起量。 */
  private static int readImeBottom(Context ctx, View bar, WindowInsets viewInsets) {
    if (ctx == null) return 0;
    int best = 0;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      try {
        if (wm != null) {
          best = Math.max(best, wm.getCurrentWindowMetrics().getWindowInsets()
            .getInsets(WindowInsets.Type.ime()).bottom);
        }
      } catch (Exception ignored) {}
      int minTrusted = bar != null
        ? Math.max(bar.getHeight() * 2, dp(ctx, 120))
        : dp(ctx, 120);
      if (viewInsets != null) {
        int ime = viewInsets.getInsets(WindowInsets.Type.ime()).bottom;
        if (ime > minTrusted) best = Math.max(best, ime);
      }
      try {
        if (bar != null) {
          WindowInsets root = bar.getRootWindowInsets();
          if (root != null) {
            int ime = root.getInsets(WindowInsets.Type.ime()).bottom;
            if (ime > minTrusted) best = Math.max(best, ime);
          }
        }
      } catch (Exception ignored) {}
    }
    if (bar != null && ctx != null) {
      Rect r = new Rect();
      bar.getWindowVisibleDisplayFrame(r);
      Disp d = disp(ctx);
      int nav = navBar(ctx);
      int raw = Math.max(0, d.h - r.bottom);
      if (raw > nav + dp(ctx, 24)) best = Math.max(best, raw);
    }
    return best;
  }

  private static void applyInputImeLift(Context ctx, int imeBottom) {
    if (ctx == null) return;
    imeBottom = Math.max(0, imeBottom);
    if (imeBottom == inputImeBottom) return;
    inputImeBottom = imeBottom;
    if (inputView != null && wm != null) {
      applyInputBarPadding(inputView, ctx, imeBottom);
      try {
        WindowManager.LayoutParams lp = (WindowManager.LayoutParams) inputView.getLayoutParams();
        if (lp != null && lp.y != imeBottom) {
          lp.y = imeBottom;
          wm.updateViewLayout(inputView, lp);
        }
      } catch (Exception ignored) {}
    }
    updateBubblePad(ctx);
    if (ringView != null && !ringDragging && !ringDragArmed) {
      int clamped = clampRingY(ctx, ringY, false);
      if (clamped != ringY) {
        ringY = clamped;
        updateRingLayout(ctx);
      }
    }
  }

  private static void sendNow(Context ctx, EditText ed) {
    if (ed == null) return;
    String text = ed.getText() == null ? "" : ed.getText().toString().trim();
    if (text.isEmpty()) return;
    int cid = characterId > 0 ? characterId : NianBridgePrefs.haloCharId(ctx);
    if (cid <= 0) {
      addReplyParts(Collections.singletonList("还没连上，过一会儿再发"));
      return;
    }
    characterId = cid;
    long now = System.currentTimeMillis();
    if (text.equals(lastSentText) && now - lastSentAt < SEND_DEDUP_MS) return;
    lastSentText = text;
    lastSentAt = now;
    ed.setText("");
    addMineBubble(text);
    showWaitBubble();
    closeInputBar();
    if (appCtx != null) {
      bubblesHidden = false;
      placeRing(appCtx);
    }
    final int seq = sendSeq.incrementAndGet();
    sendInFlight = seq;
    final Context app = ctx.getApplicationContext();
    new Thread(() -> {
      try {
        JSONObject res = postOverlaySend(app, cid, text, false);
        List<Bubble> replyBubbles = parseReplyBubbles(res);
        boolean looking = res.optBoolean("robotLooking", false) || res.optBoolean("robotInvoke", false);
        boolean silentBusy = res.optBoolean("isBusy", false) && res.optBoolean("silent", false);
        boolean empty = replyBubbles.isEmpty();
        if (silentBusy && replyBubbles.isEmpty()) {
          replyBubbles.add(new Bubble(false, "好像在忙"));
          empty = false;
        }
        if (empty && !looking && !res.optBoolean("noReply", false)) {
          try {
            JSONObject nudged = postOverlaySend(app, cid, "嗯", true);
            List<Bubble> extra = parseReplyBubbles(nudged);
            if (!extra.isEmpty()) {
              replyBubbles = extra;
              empty = false;
            }
          } catch (Exception ignored) {}
        }
        if (sendInFlight != seq) return;
        if (!replyBubbles.isEmpty()) {
          addReplyBubbles(replyBubbles);
          return;
        }
        if (looking || empty) {
          MAIN.postDelayed(() -> {
            if (sendInFlight != seq) return;
            if (hasCharReplyBubble()) return;
            addReplyParts(Collections.singletonList("这句没回上来"));
          }, EMPTY_WAIT_MS);
        }
      } catch (Exception e) {
        if (sendInFlight != seq) return;
        addReplyParts(Collections.singletonList("没发出去"));
      }
    }, "nian-share-send").start();
  }

  private static void notifyServer(boolean on) {
    try {
      Context ctx = appCtx;
      if (ctx == null) return;
      JSONObject body = new JSONObject();
      body.put("on", on);
      body.put("characterId", characterId);
      new Thread(() -> {
        try { PhoneHttp.post(ctx.getApplicationContext(), "/api/phone/share", body.toString()); } catch (Exception ignored) {}
      }, "nian-share-flag").start();
    } catch (Exception ignored) {}
  }

  private static WindowManager.LayoutParams ringVisualParams() {
    WindowManager.LayoutParams lp = baseLp();
    lp.width = WindowManager.LayoutParams.MATCH_PARENT;
    lp.height = WindowManager.LayoutParams.MATCH_PARENT;
    lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
    lp.gravity = Gravity.TOP | Gravity.START;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
    }
    return lp;
  }

  private static WindowManager.LayoutParams ringOrbParams(Context ctx) {
    WindowManager.LayoutParams lp = baseLp();
    lp.width = orbW(ctx);
    lp.height = orbH(ctx);
    lp.gravity = Gravity.TOP | Gravity.START;
    lp.x = ringX;
    lp.y = ringY;
    lp.flags |= WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;
    lp.flags &= ~WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
    }
    return lp;
  }

  private static int peekHidePx(Context ctx) {
    int size = orbW(ctx);
    int inset = dp(ctx, RING_PEEK_INSET_DP);
    int hide = size / 2 - inset;
    int minHide = dp(ctx, 8);
    if (hide < minHide) hide = minHide;
    return hide;
  }

  private static boolean fingerOnRing(View v, MotionEvent ev) {
    if (v == null) return false;
    float d = v.getResources().getDisplayMetrics().density;
    if (callOn && callVideo) {
      float pad = 2f * d;
      return ev.getX() >= pad && ev.getX() <= v.getWidth() - pad
        && ev.getY() >= pad && ev.getY() <= v.getHeight() - pad;
    }
    float r = callOn
      ? Math.max(dp(v.getContext(), CALL_AVATAR_DP) / 2f + 4f * d, (RING_RADIUS_DP + 8) * d * 0.55f)
      : (RING_RADIUS_DP + 8) * d;
    float cx = v.getWidth() / 2f;
    float cy = v.getHeight() / 2f;
    float dx = ev.getX() - cx;
    float dy = ev.getY() - cy;
    return dx * dx + dy * dy <= r * r;
  }

  private static void placeRing(Context ctx) {
    if (ctx == null) return;
    ensureRingPos(ctx);
    if (inputOpen) {
      ringPeeking = false;
    }
    if (ringDragging || ringDragArmed) {
      ringX = clampRingX(ctx, ringX);
    } else {
      ringFree = false;
      ringX = dockedX(ctx, ringOnRight, ringPeeking && !inputOpen);
    }
    ringY = clampRingY(ctx, ringY, false);
    updateRingLayout(ctx);
  }

  private static void expandRing(Context ctx) {
    cancelPeek();
    ringPeeking = false;
    ringFree = false;
    ensureRingPos(ctx);
    animateRingTo(ctx, dockedX(ctx, ringOnRight, false), clampRingY(ctx, ringY, false), () -> syncCallChrome());
  }

  private static boolean onRingTouch(Context ctx, View v, MotionEvent ev) {
    int slop = ViewConfiguration.get(ctx).getScaledTouchSlop();
    switch (ev.getActionMasked()) {
      case MotionEvent.ACTION_DOWN:
        ringDragging = false;
        ringDragArmed = false;
        ringMoved = false;
        removeHot = false;
        lastRawX = ringDownRawX = ev.getRawX();
        lastRawY = ringDownRawY = ev.getRawY();
        ringDownX = ringX;
        ringDownY = ringY;
        if (!fingerOnRing(v, ev)) {
          ringMoved = true;
          return true;
        }
        cancelPeek();
        cancelLongPress();
        cancelPendingSingleTap();
        if (ringMoveAnim != null) {
          ringMoveAnim.cancel();
          ringMoveAnim = null;
        }
        longPressTask = () -> {
          if (!sessionOn || ringView == null) return;
          ringTapCount = 0;
          cancelPendingSingleTap();
          ringDragArmed = true;
          ringPeeking = false;
          ringFree = true;
          int boxW = orbW(ctx);
          int boxH = orbH(ctx);
          ringX = clampRingX(ctx, Math.round(lastRawX - boxW / 2f));
          ringY = clampRingY(ctx, Math.round(lastRawY - boxH / 2f), true);
          ringDownX = ringX;
          ringDownY = ringY;
          ringDownRawX = lastRawX;
          ringDownRawY = lastRawY;
          updateRingLayout(ctx);
          try { v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS); } catch (Exception ignored) {}
          v.animate().scaleX(1.08f).scaleY(1.08f).setDuration(90).start();
          showRemoveZone(ctx);
        };
        MAIN.postDelayed(longPressTask, LONG_PRESS_MS);
        return true;
      case MotionEvent.ACTION_MOVE: {
        lastRawX = ev.getRawX();
        lastRawY = ev.getRawY();
        float dx = lastRawX - ringDownRawX;
        float dy = lastRawY - ringDownRawY;
        if (!ringDragArmed) {
          if (dx * dx + dy * dy > slop * slop) {
            ringMoved = true;
            cancelLongPress();
          }
          return true;
        }
        ringDragging = true;
        ringFree = true;
        ringPeeking = false;
        ringX = clampRingX(ctx, ringDownX + Math.round(dx));
        ringY = clampRingY(ctx, ringDownY + Math.round(dy), true);
        updateRingLayout(ctx);
        setRemoveHot(ctx, overRemoveZone(ctx, lastRawX, lastRawY));
        return true;
      }
      case MotionEvent.ACTION_UP:
      case MotionEvent.ACTION_CANCEL:
        cancelLongPress();
        v.animate().scaleX(1f).scaleY(1f).setDuration(120).start();
        if (ringDragging) {
          boolean dropRemove = overRemoveZone(ctx, ev.getRawX(), ev.getRawY());
          hideRemoveZone();
          if (dropRemove) {
            if (callOn) MainActivity.hangupCallFromNative();
            resetRingPos(ctx);
            hide();
            ringDragging = false;
            ringDragArmed = false;
            ringMoved = false;
            return true;
          }
          snapRingToEdge(ctx);
        } else if (ringDragArmed) {
          hideRemoveZone();
          snapRingToEdge(ctx);
        } else if (ev.getActionMasked() == MotionEvent.ACTION_UP && !ringMoved) {
          hideRemoveZone();
          onRingTap(ctx);
        } else {
          hideRemoveZone();
        }
        ringDragging = false;
        ringDragArmed = false;
        ringMoved = false;
        return true;
      default:
        return false;
    }
  }

  private static void onRingTap(Context ctx) {
    long now = System.currentTimeMillis();
    if (now - ringTapAt > TRIPLE_WINDOW_MS) ringTapCount = 0;
    ringTapAt = now;
    ringTapCount++;
    cancelPendingSingleTap();
    if (ringTapCount >= 3) {
      ringTapCount = 0;
      try {
        if (ringView != null) ringView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
      } catch (Exception ignored) {}
      if (callOn) {
        MainActivity.hangupCallFromNative();
        hide();
        return;
      }
      hideScreenChat();
      collapseToPeek(ctx);
      return;
    }
    final int taps = ringTapCount;
    ringTapTask = () -> {
      if (taps != ringTapCount) return;
      ringTapCount = 0;
      handleRingSingleTap(ctx);
    };
    MAIN.postDelayed(ringTapTask, SINGLE_TAP_DELAY_MS);
  }

  private static void cancelPendingSingleTap() {
    if (ringTapTask != null) {
      MAIN.removeCallbacks(ringTapTask);
      ringTapTask = null;
    }
  }

  private static void handleRingSingleTap(Context ctx) {
    if (callOn) {
      if (ringPeeking) {
        expandRing(ctx);
        return;
      }
      MainActivity.openFromOverlay(ctx, characterId, true);
      return;
    }
    if (ringPeeking) {
      bubblesHidden = false;
      showInput(ctx);
      try {
        if (ringView != null) ringView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
      } catch (Exception ignored) {}
      return;
    }
    if (inputOpen) {
      hideInput();
      return;
    }
    showInput(ctx);
  }

  private static void snapRingToEdge(Context ctx) {
    ringFree = false;
    int cx = ringX + orbW(ctx) / 2;
    ringOnRight = cx >= screenW(ctx) / 2;
    ringPeeking = false;
    int toX = dockedX(ctx, ringOnRight, false);
    int toY = clampRingY(ctx, ringY, false);
    saveRingPos(ctx);
    animateRingTo(ctx, toX, toY, null);
  }

  private static void cancelLongPress() {
    if (longPressTask != null) {
      MAIN.removeCallbacks(longPressTask);
      longPressTask = null;
    }
  }

  private static void showRemoveZone(Context ctx) {
    if (ctx == null || wm == null || removeZone != null) return;
    TextView tv = new TextView(ctx);
    tv.setText("拖到这里移除");
    tv.setGravity(Gravity.CENTER);
    tv.setTextColor(Color.WHITE);
    tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
    tv.setPadding(dp(ctx, 18), dp(ctx, 10), dp(ctx, 18), dp(ctx, 10));
    tv.setBackground(roundBg(Color.parseColor("#99000000"), dp(ctx, 22)));
    markIgnore(tv);
    WindowManager.LayoutParams lp = baseLp();
    lp.width = WindowManager.LayoutParams.WRAP_CONTENT;
    lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
    lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
    lp.y = statusBarHeight(ctx) + dp(ctx, 10);
    lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
    try {
      wm.addView(tv, lp);
      removeZone = tv;
      if (captureHidden) tv.setVisibility(View.GONE);
    } catch (Exception ignored) {}
  }

  private static void hideRemoveZone() {
    removeHot = false;
    remove(removeZone);
    removeZone = null;
  }

  private static void setRemoveHot(Context ctx, boolean hot) {
    if (removeHot == hot || removeZone == null) return;
    removeHot = hot;
    try {
      removeZone.setBackground(roundBg(
        Color.parseColor(hot ? "#CCE85A5A" : "#99000000"),
        dp(ctx, 22)
      ));
      if (removeZone instanceof TextView) {
        ((TextView) removeZone).setText(hot ? "松手移除" : "拖到这里移除");
      }
    } catch (Exception ignored) {}
  }

  private static boolean overRemoveZone(Context ctx, float rawX, float rawY) {
    if (removeZone == null) return false;
    int[] loc = new int[2];
    try { removeZone.getLocationOnScreen(loc); } catch (Exception e) { return false; }
    int pad = dp(ctx, 20);
    int w = Math.max(removeZone.getWidth(), dp(ctx, 160));
    int h = Math.max(removeZone.getHeight(), dp(ctx, 48));
    return rawX >= loc[0] - pad && rawX <= loc[0] + w + pad
      && rawY >= loc[1] - pad && rawY <= loc[1] + h + pad;
  }

  private static void updateRingLayout(Context ctx) {
    if (ringView == null || wm == null || ctx == null) return;
    try { wm.updateViewLayout(ringView, ringOrbParams(ctx)); } catch (Exception ignored) {}
  }

  private static void animateRingTo(Context ctx, int toX, int toY, Runnable done) {
    if (ringMoveAnim != null) ringMoveAnim.cancel();
    if (ringView == null) {
      ringX = toX;
      ringY = toY;
      if (done != null) done.run();
      return;
    }
    final int fromX = ringX;
    final int fromY = ringY;
    ValueAnimator a = ValueAnimator.ofFloat(0f, 1f);
    a.setDuration(240);
    a.setInterpolator(new DecelerateInterpolator());
    a.addUpdateListener(an -> {
      float t = (float) an.getAnimatedValue();
      ringX = fromX + Math.round((toX - fromX) * t);
      ringY = fromY + Math.round((toY - fromY) * t);
      updateRingLayout(ctx);
    });
    a.addListener(new AnimatorListenerAdapter() {
      private boolean cancelled;

      @Override
      public void onAnimationCancel(Animator animation) {
        cancelled = true;
      }

      @Override
      public void onAnimationEnd(Animator animation) {
        if (cancelled) return;
        ringX = toX;
        ringY = toY;
        updateRingLayout(ctx);
        if (done != null) done.run();
      }
    });
    ringMoveAnim = a;
    a.start();
  }

  private static void collapseToPeek(Context ctx) {
    if (ctx == null || ringDragging || ringDragArmed) return;
    dismissChatForPeek();
    ringFree = false;
    ringPeeking = true;
    syncCallChrome();
    animateRingTo(ctx, dockedX(ctx, ringOnRight, true), clampRingY(ctx, ringY, false), null);
  }

  private static void cancelPeek() {
    if (ringPeekTask != null) {
      MAIN.removeCallbacks(ringPeekTask);
      ringPeekTask = null;
    }
  }

  private static void resetRingPos(Context ctx) {
    ringFree = false;
    ringX = -1;
    ringY = -1;
    ringOnRight = true;
    if (ctx == null) return;
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
      .putBoolean(KEY_RING_FREE, false)
      .putBoolean(KEY_RING_RIGHT, true)
      .putInt(KEY_RING_X, -1)
      .putInt(KEY_RING_Y, -1)
      .apply();
  }

  private static void loadRingPos(Context ctx) {
    if (ctx == null) return;
    SharedPreferences p = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    ringOnRight = p.getBoolean(KEY_RING_RIGHT, true);
    ringFree = false;
    ringY = p.getInt(KEY_RING_Y, -1);
    ringX = p.getInt(KEY_RING_X, -1);
  }

  private static void saveRingPos(Context ctx) {
    if (ctx == null || ringY < 0) return;
    ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
      .putBoolean(KEY_RING_RIGHT, ringOnRight)
      .putBoolean(KEY_RING_FREE, false)
      .putInt(KEY_RING_X, ringX)
      .putInt(KEY_RING_Y, ringY)
      .apply();
  }

  private static void ensureRingPos(Context ctx) {
    if (ringY < 0) ringY = (int) (screenH(ctx) * 0.42f);
    ringY = clampRingY(ctx, ringY, false);
    if (ringDragging || ringDragArmed) {
      ringX = clampRingX(ctx, ringX);
    } else {
      ringX = dockedX(ctx, ringOnRight, ringPeeking && !inputOpen);
    }
  }

  private static int dockedX(Context ctx, boolean right, boolean peek) {
    Disp d = disp(ctx);
    int size = orbW(ctx);
    if (peek) {
      int hide = peekHidePx(ctx);
      if (right) return d.w - size + hide;
      return -hide;
    }
    int pad = dp(ctx, 4);
    if (right) return d.w - size - Math.max(pad, d.right);
    return Math.max(pad, d.left);
  }

  private static int clampRingX(Context ctx, int x) {
    Disp d = disp(ctx);
    int size = orbW(ctx);
    int min = Math.max(dp(ctx, 4), d.left);
    int max = d.w - size - Math.max(dp(ctx, 4), d.right);
    if (max < min) max = min;
    return Math.max(min, Math.min(max, x));
  }

  private static int clampRingY(Context ctx, int y, boolean dragging) {
    Disp d = disp(ctx);
    int size = orbH(ctx);
    int min = dragging ? dp(ctx, 4) : Math.max(d.top, statusBarHeight(ctx));
    int max = d.h - size - Math.max(d.bottom, navBar(ctx));
    if (inputOpen) max -= dp(ctx, 72) + Math.max(0, inputImeBottom);
    if (max < min) max = min;
    return Math.max(min, Math.min(max, y));
  }

  private static final class Disp {
    int w, h, left, top, right, bottom;
  }

  /** 用默认屏真实宽高，不用 Application 里可能还停在竖屏的 DisplayMetrics。 */
  private static Disp disp(Context ctx) {
    Disp d = new Disp();
    android.util.DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
    d.w = dm.widthPixels;
    d.h = dm.heightPixels;
    d.top = statusBarHeight(ctx);
    d.bottom = navBar(ctx);
    try {
      Display display = null;
      DisplayManager dmgr = displayManager;
      if (dmgr == null) {
        dmgr = (DisplayManager) ctx.getSystemService(Context.DISPLAY_SERVICE);
      }
      if (dmgr != null) display = dmgr.getDisplay(Display.DEFAULT_DISPLAY);
      WindowManager mgr = wm != null ? wm : (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
      if (display == null && mgr != null) display = mgr.getDefaultDisplay();
      if (display != null) {
        android.util.DisplayMetrics real = new android.util.DisplayMetrics();
        display.getRealMetrics(real);
        if (real.widthPixels > 0 && real.heightPixels > 0) {
          d.w = real.widthPixels;
          d.h = real.heightPixels;
        }
      }
      if (Build.VERSION.SDK_INT >= 30 && mgr != null) {
        android.view.WindowMetrics cur = mgr.getCurrentWindowMetrics();
        android.graphics.Rect b = cur.getBounds();
        android.graphics.Insets bars = null;
        if (b.width() == d.w && b.height() == d.h) {
          bars = cur.getWindowInsets().getInsetsIgnoringVisibility(
            WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        } else {
          android.view.WindowMetrics max = mgr.getMaximumWindowMetrics();
          android.graphics.Rect mb = max.getBounds();
          if (mb.width() == d.w && mb.height() == d.h) {
            bars = max.getWindowInsets().getInsetsIgnoringVisibility(
              WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
          }
        }
        if (bars != null) {
          d.left = bars.left;
          d.top = Math.max(d.top, bars.top);
          d.right = bars.right;
          d.bottom = Math.max(d.bottom, bars.bottom);
        }
      }
    } catch (Exception ignored) {}
    if (d.w <= 0) d.w = Math.max(1, dm.widthPixels);
    if (d.h <= 0) d.h = Math.max(1, dm.heightPixels);
    return d;
  }

  private static int screenW(Context ctx) {
    return disp(ctx).w;
  }

  private static int screenH(Context ctx) {
    return disp(ctx).h;
  }

  private static void watchDisplay(Context ctx) {
    if (ctx == null || displayWatchOn) return;
    try {
      Context app = ctx.getApplicationContext();
      displayManager = (DisplayManager) app.getSystemService(Context.DISPLAY_SERVICE);
      if (displayManager != null) {
        displayManager.registerDisplayListener(displayListener, MAIN);
      }
      app.registerComponentCallbacks(configWatch);
      displayWatchOn = true;
    } catch (Exception ignored) {}
  }

  private static void relayoutForDisplay() {
    Context ctx = appCtx;
    if (ctx == null || !sessionOn || ringView == null) return;
    if (ringDragging || ringDragArmed) return;
    Disp d = disp(ctx);
    if (d.w == lastDispW && d.h == lastDispH) return;
    lastDispW = d.w;
    lastDispH = d.h;
    ringFree = false;
    placeRing(ctx);
    if (ringPeeking) {
      collapseToPeek(ctx);
    }
  }

  private static WindowManager.LayoutParams inputParams(Context ctx) {
    WindowManager.LayoutParams lp = baseLp();
    lp.width = WindowManager.LayoutParams.MATCH_PARENT;
    lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
    lp.gravity = Gravity.BOTTOM | Gravity.FILL_HORIZONTAL;
    lp.y = Math.max(0, inputImeBottom);
    lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
    // Overlay 上 ADJUST_RESIZE 常不生效，改按 IME 高度手动抬 y
    lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      | WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE;
    return lp;
  }

  private static WindowManager.LayoutParams baseLp() {
    WindowManager.LayoutParams lp = new WindowManager.LayoutParams();
    lp.format = PixelFormat.TRANSLUCENT;
    lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
      | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
      | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
      | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      lp.type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
    } else {
      lp.type = WindowManager.LayoutParams.TYPE_PHONE;
    }
    return lp;
  }

  private static void markIgnore(View v) {
    v.setContentDescription(IGNORE);
    v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    if (v instanceof android.view.ViewGroup) {
      android.view.ViewGroup g = (android.view.ViewGroup) v;
      for (int i = 0; i < g.getChildCount(); i++) markIgnore(g.getChildAt(i));
    }
  }

  private static android.graphics.drawable.GradientDrawable roundBg(int color, int radius) {
    android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
    g.setColor(color);
    g.setCornerRadius(radius);
    return g;
  }

  private static int statusBarHeight(Context ctx) {
    int id = ctx.getResources().getIdentifier("status_bar_height", "dimen", "android");
    if (id > 0) return ctx.getResources().getDimensionPixelSize(id);
    return dp(ctx, 28);
  }

  private static int navBar(Context ctx) {
    int id = ctx.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
    if (id > 0) return ctx.getResources().getDimensionPixelSize(id);
    return dp(ctx, 16);
  }

  private static int dp(Context ctx, int v) {
    return Math.round(v * ctx.getResources().getDisplayMetrics().density);
  }

  static final class RippleRingView extends View {
    private static final int[] FLOW = {
      Color.argb(0, 255, 255, 255),
      Color.argb(200, 255, 150, 215),
      Color.argb(220, 255, 220, 160),
      Color.argb(220, 90, 230, 215),
      Color.argb(210, 120, 195, 255),
      Color.argb(200, 190, 155, 255),
      Color.argb(200, 255, 150, 215),
      Color.argb(0, 255, 255, 255),
    };
    private static final int[] COMET = {
      Color.TRANSPARENT,
      Color.TRANSPARENT,
      Color.argb(230, 255, 255, 255),
      Color.argb(120, 255, 250, 255),
      Color.TRANSPARENT,
    };
    private static final float[] COMET_POS = { 0f, 0.58f, 0.72f, 0.84f, 1f };

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Matrix matrix = new Matrix();
    private ValueAnimator anim;
    private float phase;

    RippleRingView(Context ctx) {
      super(ctx);
      setWillNotDraw(false);
      setLayerType(LAYER_TYPE_SOFTWARE, null);
      setBackgroundColor(Color.TRANSPARENT);
      paint.setStrokeCap(Paint.Cap.ROUND);
      paint.setStrokeJoin(Paint.Join.ROUND);
      anim = ValueAnimator.ofFloat(0f, 360f);
      anim.setDuration(3800);
      anim.setRepeatCount(ValueAnimator.INFINITE);
      anim.setInterpolator(new LinearInterpolator());
      anim.addUpdateListener(a -> {
        phase = (float) a.getAnimatedValue();
        invalidate();
      });
      anim.start();
    }

    void stop() {
      if (anim != null) anim.cancel();
    }

    @Override
    protected void onDetachedFromWindow() {
      stop();
      super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas canvas) {
      float d = getResources().getDisplayMetrics().density;
      float cx = getWidth() / 2f;
      float cy = getHeight() / 2f;
      float r = RING_RADIUS_DP * d;

      paint.setStyle(Paint.Style.FILL);
      paint.setShader(new RadialGradient(
        cx, cy, r,
        new int[]{ Color.argb(55, 255, 255, 255), Color.argb(22, 255, 220, 245), Color.TRANSPARENT },
        new float[]{ 0f, 0.62f, 1f },
        Shader.TileMode.CLAMP
      ));
      canvas.drawCircle(cx, cy, r - 1.2f * d, paint);
      paint.setShader(null);

      paint.setStyle(Paint.Style.STROKE);
      paint.setStrokeWidth(4.6f * d);
      paint.setColor(Color.argb(50, 255, 230, 250));
      canvas.drawCircle(cx, cy, r, paint);
      paint.setStrokeWidth(2.6f * d);
      paint.setColor(Color.argb(160, 255, 170, 220));
      canvas.drawCircle(cx, cy, r, paint);

      SweepGradient flow = new SweepGradient(cx, cy, FLOW, null);
      matrix.reset();
      matrix.setRotate(phase, cx, cy);
      flow.setLocalMatrix(matrix);
      paint.setShader(flow);
      paint.setStrokeWidth(2.4f * d);
      canvas.drawCircle(cx, cy, r, paint);

      SweepGradient inner = new SweepGradient(cx, cy, FLOW, null);
      matrix.reset();
      matrix.setRotate(-phase * 0.55f + 120f, cx, cy);
      inner.setLocalMatrix(matrix);
      paint.setShader(inner);
      paint.setStrokeWidth(1.2f * d);
      canvas.drawCircle(cx, cy, r - 2.2f * d, paint);

      SweepGradient comet = new SweepGradient(cx, cy, COMET, COMET_POS);
      matrix.reset();
      matrix.setRotate(phase, cx, cy);
      comet.setLocalMatrix(matrix);
      paint.setShader(comet);
      paint.setStrokeWidth(1.8f * d);
      canvas.drawCircle(cx, cy, r, paint);
      paint.setShader(null);
    }
  }
}

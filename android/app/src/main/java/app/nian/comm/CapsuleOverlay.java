package app.nian.comm;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** 贴在其他 App 上层的胶囊弹窗；常驻直到用户回到念。点一下打开对应角色的聊天。 */
final class CapsuleOverlay {
  private static final Handler MAIN = new Handler(Looper.getMainLooper());
  private static View currentView;
  private static WindowManager currentWm;
  private static Runnable hideTask;
  private static String lastKey = "";
  private static long lastAt;

  private CapsuleOverlay() {}

  static boolean show(Context ctx, int characterId, String name, String text, String avatarUrl) {
    return show(ctx, characterId, name, text, avatarUrl, null);
  }

  static boolean show(Context ctx, int characterId, String name, String text, String avatarUrl, JSONArray bubbles) {
    if (ctx == null) return false;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(ctx)) return false;
    if (MainActivity.isResumed()) return false;
    String n = name == null || name.trim().isEmpty() ? "TA" : name.trim();
    ScreenShareOverlay.show(ctx, characterId, n);
    if (bubbles != null && bubbles.length() > 0) {
      ScreenShareOverlay.showReplyPayloads(bubbles);
      return true;
    }
    String full = text == null ? "" : text.trim();
    if (!full.isEmpty()) ScreenShareOverlay.showReply(full);
    return true;
  }

  static void hide() {
    MAIN.post(CapsuleOverlay::detach);
  }

  private static String resolveAvatarUrl(Context ctx, String raw) {
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

  private static void attach(Context ctx, int characterId, String name, String text, Bitmap avatar) {
    if (MainActivity.isResumed()) {
      detach();
      return;
    }
    WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
    if (wm == null) return;
    if (currentView != null && currentWm != null) {
      try { currentWm.removeView(currentView); } catch (Exception ignored) {}
      currentView = null;
      currentWm = null;
    }
    LinearLayout pill = buildPill(ctx, characterId, name, text, avatar);
    WindowManager.LayoutParams lp = new WindowManager.LayoutParams();
    lp.width = WindowManager.LayoutParams.WRAP_CONTENT;
    lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
    lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
    lp.y = statusBarHeight(ctx) + dp(ctx, 8);
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
    pill.setAlpha(0f);
    pill.setTranslationY(-dp(ctx, 24));
    try {
      wm.addView(pill, lp);
    } catch (Exception e) {
      return;
    }
    currentView = pill;
    currentWm = wm;
    pill.animate().alpha(1f).translationY(0).setDuration(280).start();
    if (hideTask != null) MAIN.removeCallbacks(hideTask);
    hideTask = null;
  }

  private static void detach() {
    if (hideTask != null) {
      MAIN.removeCallbacks(hideTask);
      hideTask = null;
    }
    if (currentView == null || currentWm == null) return;
    View v = currentView;
    WindowManager wm = currentWm;
    currentView = null;
    currentWm = null;
    v.animate().alpha(0f).translationY(-dp(v.getContext(), 18)).setDuration(220)
      .withEndAction(() -> {
        try { wm.removeView(v); } catch (Exception ignored) {}
      })
      .start();
  }

  private static LinearLayout buildPill(Context ctx, int characterId, String name, String text, Bitmap avatar) {
    LinearLayout pill = new LinearLayout(ctx);
    pill.setOrientation(LinearLayout.HORIZONTAL);
    pill.setGravity(Gravity.CENTER_VERTICAL);
    int padH = dp(ctx, 10);
    int padV = dp(ctx, 8);
    pill.setPadding(padH, padV, dp(ctx, 14), padV);
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(Color.parseColor("#FFFFFF"));
    bg.setCornerRadius(dp(ctx, 28));
    bg.setStroke(dp(ctx, 1), Color.parseColor("#1A000000"));
    pill.setBackground(bg);
    pill.setElevation(dp(ctx, 12));

    ImageView av = new ImageView(ctx);
    int avSize = dp(ctx, 36);
    LinearLayout.LayoutParams avLp = new LinearLayout.LayoutParams(avSize, avSize);
    avLp.rightMargin = dp(ctx, 8);
    av.setLayoutParams(avLp);
    av.setScaleType(ImageView.ScaleType.CENTER_CROP);
    GradientDrawable circle = new GradientDrawable();
    circle.setShape(GradientDrawable.OVAL);
    circle.setColor(Color.parseColor("#C48BBE"));
    av.setBackground(circle);
    av.setClipToOutline(true);
    av.setOutlineProvider(new android.view.ViewOutlineProvider() {
      @Override
      public void getOutline(View view, android.graphics.Outline outline) {
        outline.setOval(0, 0, view.getWidth(), view.getHeight());
      }
    });
    if (avatar != null) {
      av.setImageBitmap(avatar);
    } else {
      av.setImageDrawable(letterDrawable(name));
    }
    pill.addView(av);

    LinearLayout col = new LinearLayout(ctx);
    col.setOrientation(LinearLayout.VERTICAL);
    int maxW = (int) (ctx.getResources().getDisplayMetrics().widthPixels * 0.62f);
    col.setLayoutParams(new LinearLayout.LayoutParams(Math.min(maxW, dp(ctx, 240)), LinearLayout.LayoutParams.WRAP_CONTENT));

    TextView nameTv = new TextView(ctx);
    nameTv.setText(name);
    nameTv.setTextColor(Color.parseColor("#1A1224"));
    nameTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
    nameTv.setTypeface(Typeface.DEFAULT_BOLD);
    nameTv.setMaxLines(1);
    nameTv.setEllipsize(android.text.TextUtils.TruncateAt.END);

    TextView textTv = new TextView(ctx);
    textTv.setText(text);
    textTv.setTextColor(Color.parseColor("#5C4A6A"));
    textTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    textTv.setMaxLines(2);
    textTv.setEllipsize(android.text.TextUtils.TruncateAt.END);
    LinearLayout.LayoutParams tLp = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    tLp.topMargin = dp(ctx, 1);
    textTv.setLayoutParams(tLp);

    col.addView(nameTv);
    col.addView(textTv);
    pill.addView(col);

    pill.setOnClickListener(v -> {
      detach();
      try {
        Intent i = new Intent(ctx, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        i.putExtra(MainActivity.EXTRA_OPEN_CHAR, characterId);
        ctx.startActivity(i);
      } catch (Exception ignored) {}
    });
    return pill;
  }

  private static android.graphics.drawable.Drawable letterDrawable(String name) {
    android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
    g.setShape(GradientDrawable.OVAL);
    g.setColor(Color.parseColor("#C48BBE"));
    return g;
  }

  private static Bitmap decodeAvatar(String url, int sizePx) {
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

  private static int statusBarHeight(Context ctx) {
    int id = ctx.getResources().getIdentifier("status_bar_height", "dimen", "android");
    if (id > 0) return ctx.getResources().getDimensionPixelSize(id);
    return dp(ctx, 28);
  }

  private static int dp(Context ctx, int v) {
    return Math.round(v * ctx.getResources().getDisplayMetrics().density);
  }
}

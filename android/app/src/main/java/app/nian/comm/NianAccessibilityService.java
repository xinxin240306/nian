package app.nian.comm;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/** 读当前窗口；角色可自主点/滑/切歌。不代支付、不填密码。 */
public class NianAccessibilityService extends AccessibilityService {
  private static final Handler MAIN = new Handler(Looper.getMainLooper());
  private static final Pattern DANGER = Pattern.compile(
    "支付|付款|转账|立即购买|确认购买|确认付款|立即支付|开通会员|开通超级|密码|付款码|指纹|面容支付|提交订单|绑卡|充值"
  );
  private static volatile NianAccessibilityService instance;

  public static boolean isConnected() {
    return instance != null;
  }

  public static boolean startExternal(Intent intent) {
    NianAccessibilityService svc = instance;
    if (svc == null || intent == null) return false;
    try {
      svc.startActivity(intent);
      return true;
    } catch (Exception e) {
      return false;
    }
  }

  public static String dumpActiveWindow() {
    NianAccessibilityService svc = instance;
    if (svc == null) return "";
    AccessibilityNodeInfo root = null;
    try {
      root = svc.getRootInActiveWindow();
      if (root == null) return "";
      StringBuilder sb = new StringBuilder();
      String pkg = String.valueOf(root.getPackageName() == null ? "" : root.getPackageName());
      if (!pkg.isEmpty()) sb.append('[').append(pkg).append("]\n");
      dumpNode(root, sb, 0, new HashSet<Integer>(), 0);
      return ScreenShareOverlay.stripFromDump(sb.toString().trim());
    } catch (Exception e) {
      return "";
    } finally {
      recycleQuiet(root);
    }
  }

  public static String dumpTargets() {
    NianAccessibilityService svc = instance;
    if (svc == null) return "";
    AccessibilityNodeInfo root = null;
    try {
      root = svc.getRootInActiveWindow();
      if (root == null) return "";
      int[] size = screenSize(svc);
      List<String> lines = new ArrayList<>();
      collectTargets(root, size[0], size[1], new HashSet<Integer>(), lines, 0);
      StringBuilder sb = new StringBuilder();
      for (String line : lines) {
        if (sb.length() > 0) sb.append('\n');
        sb.append(line);
      }
      return ScreenShareOverlay.stripFromDump(sb.toString());
    } catch (Exception e) {
      return "";
    } finally {
      recycleQuiet(root);
    }
  }

  public static String foregroundPackage() {
    NianAccessibilityService svc = instance;
    if (svc == null) return "";
    AccessibilityNodeInfo root = null;
    try {
      root = svc.getRootInActiveWindow();
      if (root == null || root.getPackageName() == null) return "";
      return root.getPackageName().toString();
    } catch (Exception e) {
      return "";
    } finally {
      recycleQuiet(root);
    }
  }

  /** 执行一次控屏。坐标是 0~1。点按前会整层藏起看屏浮层。 */
  public static JSONObject control(JSONObject cmd) {
    JSONObject o = new JSONObject();
    NianAccessibilityService svc = instance;
    try {
      if (svc == null) {
        o.put("ok", false);
        o.put("error", "a11y_off");
        return o;
      }
      String action = cmd == null ? "" : cmd.optString("action", "").trim();
      String text = cmd == null ? "" : cmd.optString("text", "").trim();
      if (isDanger(text)) {
        o.put("ok", false);
        o.put("error", "blocked");
        return o;
      }
      boolean done = false;
      if ("media_next".equals(action) || "next".equals(action)) {
        done = NianNotificationListener.mediaControl("next");
        if (!done) done = tapText(svc, "下一首");
      } else if ("media_prev".equals(action) || "prev".equals(action)) {
        done = NianNotificationListener.mediaControl("prev");
        if (!done) done = tapText(svc, "上一首");
      } else if ("media_play".equals(action) || "play".equals(action)) {
        done = NianNotificationListener.mediaControl("play");
        if (!done) done = tapText(svc, "播放");
      } else if ("media_pause".equals(action) || "pause".equals(action)) {
        done = NianNotificationListener.mediaControl("pause");
        if (!done) done = tapText(svc, "暂停");
      } else if ("back".equals(action)) {
        done = svc.performGlobalAction(GLOBAL_ACTION_BACK);
      } else if ("home".equals(action)) {
        done = svc.performGlobalAction(GLOBAL_ACTION_HOME);
      } else if ("recents".equals(action)) {
        done = svc.performGlobalAction(GLOBAL_ACTION_RECENTS);
      } else if ("tap_text".equals(action) || "click_text".equals(action)) {
        done = tapText(svc, text);
      } else if ("type".equals(action)) {
        done = typeText(svc, text);
      } else if ("swipe".equals(action)) {
        done = swipe(
          svc,
          (float) cmd.optDouble("x", 0.5),
          (float) cmd.optDouble("y", 0.72),
          (float) cmd.optDouble("x2", 0.5),
          (float) cmd.optDouble("y2", 0.28),
          cmd.optInt("durationMs", 280)
        );
      } else if ("tap".equals(action) || "click".equals(action)) {
        done = tapPoint(svc, (float) cmd.optDouble("x", -1), (float) cmd.optDouble("y", -1));
      } else {
        o.put("ok", false);
        o.put("error", "bad_action");
        return o;
      }
      try { Thread.sleep(450); } catch (InterruptedException ignored) {}
      o.put("ok", done);
      if (!done) o.put("error", "failed");
      o.put("package", foregroundPackage());
      o.put("tree", dumpActiveWindow());
      o.put("targets", dumpTargets());
    } catch (Exception e) {
      try {
        o.put("ok", false);
        o.put("error", e.getMessage() == null ? "failed" : e.getMessage());
      } catch (Exception ignored) {}
    }
    return o;
  }

  private static boolean tapText(NianAccessibilityService svc, String q) {
    if (q == null || q.trim().isEmpty()) return false;
    String needle = q.trim();
    AccessibilityNodeInfo root = svc.getRootInActiveWindow();
    if (root == null) return false;
    try {
      AccessibilityNodeInfo hit = findLabel(root, needle, new HashSet<Integer>());
      if (hit == null) return false;
      if (hit.isPassword() || isDanger(cs(hit.getText()) + cs(hit.getContentDescription()))) {
        return false;
      }
      AccessibilityNodeInfo clickable = hit;
      while (clickable != null && !clickable.isClickable()) {
        AccessibilityNodeInfo p = clickable.getParent();
        if (clickable != hit) recycleQuiet(clickable);
        clickable = p;
      }
      if (clickable != null && clickable.isClickable()) {
        boolean ok = clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        if (clickable != hit) recycleQuiet(clickable);
        recycleQuiet(hit);
        if (ok) return true;
      } else {
        recycleQuiet(clickable);
      }
      Rect b = new Rect();
      hit.getBoundsInScreen(b);
      recycleQuiet(hit);
      int[] size = screenSize(svc);
      if (b.width() <= 0 || b.height() <= 0 || size[0] <= 0) return false;
      return tapPoint(svc, (b.exactCenterX()) / size[0], (b.exactCenterY()) / size[1]);
    } finally {
      recycleQuiet(root);
    }
  }

  private static AccessibilityNodeInfo findLabel(AccessibilityNodeInfo node, String needle, Set<Integer> seen) {
    if (node == null || seen.size() > 800) return null;
    int id = System.identityHashCode(node);
    if (!seen.add(id)) return null;
    String blob = (cs(node.getText()) + " " + cs(node.getContentDescription()) + " " + cs(node.getViewIdResourceName())).toLowerCase(Locale.ROOT);
    if (blob.contains(needle.toLowerCase(Locale.ROOT))) {
      return AccessibilityNodeInfo.obtain(node);
    }
    int n = node.getChildCount();
    for (int i = 0; i < n; i++) {
      AccessibilityNodeInfo child = null;
      try {
        child = node.getChild(i);
        AccessibilityNodeInfo hit = findLabel(child, needle, seen);
        if (hit != null) return hit;
      } catch (Exception ignored) {
      } finally {
        recycleQuiet(child);
      }
    }
    return null;
  }

  private static boolean typeText(NianAccessibilityService svc, String text) {
    if (text == null) return false;
    AccessibilityNodeInfo root = svc.getRootInActiveWindow();
    if (root == null) return false;
    try {
      AccessibilityNodeInfo focus = svc.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
      if (focus == null) focus = findEditable(root, new HashSet<Integer>());
      if (focus == null) return false;
      if (focus.isPassword()) {
        recycleQuiet(focus);
        return false;
      }
      Bundle args = new Bundle();
      args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
      boolean ok = focus.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
      recycleQuiet(focus);
      return ok;
    } finally {
      recycleQuiet(root);
    }
  }

  private static AccessibilityNodeInfo findEditable(AccessibilityNodeInfo node, Set<Integer> seen) {
    if (node == null || seen.size() > 800) return null;
    if (!seen.add(System.identityHashCode(node))) return null;
    if (node.isEditable() && !node.isPassword()) return AccessibilityNodeInfo.obtain(node);
    int n = node.getChildCount();
    for (int i = 0; i < n; i++) {
      AccessibilityNodeInfo child = null;
      try {
        child = node.getChild(i);
        AccessibilityNodeInfo hit = findEditable(child, seen);
        if (hit != null) return hit;
      } catch (Exception ignored) {
      } finally {
        recycleQuiet(child);
      }
    }
    return null;
  }

  private static boolean tapPoint(NianAccessibilityService svc, float nx, float ny) {
    if (nx < 0f || ny < 0f || nx > 1f || ny > 1f) return false;
    int[] size = screenSize(svc);
    if (size[0] <= 0 || size[1] <= 0) return false;
    float x = nx * size[0];
    float y = ny * size[1];
    Path path = new Path();
    path.moveTo(x, y);
    GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, 80);
    GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();
    return dispatchSync(svc, gesture);
  }

  private static boolean swipe(NianAccessibilityService svc, float x1, float y1, float x2, float y2, int ms) {
    int[] size = screenSize(svc);
    if (size[0] <= 0 || size[1] <= 0) return false;
    x1 = clamp01(x1);
    y1 = clamp01(y1);
    x2 = clamp01(x2);
    y2 = clamp01(y2);
    int dur = Math.max(80, Math.min(800, ms <= 0 ? 280 : ms));
    Path path = new Path();
    path.moveTo(x1 * size[0], y1 * size[1]);
    path.lineTo(x2 * size[0], y2 * size[1]);
    GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, dur);
    GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();
    return dispatchSync(svc, gesture);
  }

  private static boolean dispatchSync(NianAccessibilityService svc, GestureDescription gesture) {
    CountDownLatch latch = new CountDownLatch(1);
    final boolean[] ok = { false };
    Runnable run = () -> svc.dispatchGesture(gesture, new GestureResultCallback() {
      @Override
      public void onCompleted(GestureDescription g) {
        ok[0] = true;
        latch.countDown();
      }

      @Override
      public void onCancelled(GestureDescription g) {
        latch.countDown();
      }
    }, null);
    if (Looper.myLooper() == Looper.getMainLooper()) {
      run.run();
    } else {
      MAIN.post(run);
    }
    try {
      latch.await(2, TimeUnit.SECONDS);
    } catch (InterruptedException ignored) {}
    return ok[0];
  }

  private static int[] screenSize(NianAccessibilityService svc) {
    int[] out = new int[] { 1080, 1920 };
    try {
      WindowManager wm = (WindowManager) svc.getSystemService(WINDOW_SERVICE);
      DisplayMetrics dm = new DisplayMetrics();
      if (wm != null) wm.getDefaultDisplay().getRealMetrics(dm);
      if (dm.widthPixels > 0) out[0] = dm.widthPixels;
      if (dm.heightPixels > 0) out[1] = dm.heightPixels;
    } catch (Exception ignored) {}
    return out;
  }

  private static void collectTargets(
    AccessibilityNodeInfo node,
    int sw,
    int sh,
    Set<Integer> seen,
    List<String> lines,
    int count
  ) {
    if (node == null || count > 80 || lines.size() > 40) return;
    if (!seen.add(System.identityHashCode(node))) return;
    boolean useful = node.isClickable() || node.isEditable() || node.isCheckable();
    String label = !cs(node.getText()).isEmpty() ? cs(node.getText()) : cs(node.getContentDescription());
    if (useful && !label.isEmpty() && !label.contains(ScreenShareOverlay.IGNORE)) {
      Rect b = new Rect();
      node.getBoundsInScreen(b);
      if (b.width() > 4 && b.height() > 4 && sw > 0 && sh > 0) {
        lines.add(String.format(
          Locale.US,
          "%s %.2f,%.2f",
          label.length() > 24 ? label.substring(0, 24) : label,
          b.exactCenterX() / sw,
          b.exactCenterY() / sh
        ));
      }
    }
    int n = node.getChildCount();
    for (int i = 0; i < n; i++) {
      AccessibilityNodeInfo child = null;
      try {
        child = node.getChild(i);
        collectTargets(child, sw, sh, seen, lines, count + 1);
      } catch (Exception ignored) {
      } finally {
        recycleQuiet(child);
      }
    }
  }

  private static int dumpNode(
    AccessibilityNodeInfo node,
    StringBuilder sb,
    int depth,
    Set<Integer> seen,
    int count
  ) {
    if (node == null || count > 450 || sb.length() > 5000) return count;
    int id = System.identityHashCode(node);
    if (!seen.add(id)) return count;
    if (node.isPassword()) {
      if (sb.length() < 5000) sb.append("[密码]\n");
      return count + 1;
    }
    String text = cs(node.getText());
    String desc = cs(node.getContentDescription());
    String line = !text.isEmpty() ? text : desc;
    if (line.contains(ScreenShareOverlay.IGNORE)) return count;
    if (!line.isEmpty()) {
      sb.append(line).append('\n');
      count++;
    }
    int n = node.getChildCount();
    for (int i = 0; i < n; i++) {
      AccessibilityNodeInfo child = null;
      try {
        child = node.getChild(i);
        count = dumpNode(child, sb, depth + 1, seen, count);
      } catch (Exception ignored) {
      } finally {
        recycleQuiet(child);
      }
      if (count > 450 || sb.length() > 5000) break;
    }
    return count;
  }

  private static float clamp01(float v) {
    return Math.max(0f, Math.min(1f, v));
  }

  private static boolean isDanger(String s) {
    return s != null && !s.isEmpty() && DANGER.matcher(s).find();
  }

  private static void recycleQuiet(AccessibilityNodeInfo n) {
    if (n == null) return;
    try { n.recycle(); } catch (Exception ignored) {}
  }

  private static String cs(CharSequence c) {
    if (c == null) return "";
    return c.toString().replace('\u0000', ' ').trim();
  }

  @Override
  public void onServiceConnected() {
    instance = this;
  }

  @Override
  public void onDestroy() {
    if (instance == this) instance = null;
    super.onDestroy();
  }

  @Override
  public void onAccessibilityEvent(AccessibilityEvent event) {}

  @Override
  public void onInterrupt() {}
}

package app.nian.comm;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.BitmapDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.SpannableStringBuilder;
import android.text.style.ImageSpan;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 共享屏幕气泡里渲染 [微笑] 小黄豆，和聊天页同一套码。 */
final class OverlayBeans {
  private static final Handler MAIN = new Handler(Looper.getMainLooper());
  private static final Pattern TOKEN = Pattern.compile("\\[([^\\[\\]\\n]{1,20})\\]");
  private static final Map<String, String> CODE_FILE = new HashMap<>();
  private static final ConcurrentHashMap<String, Bitmap> CACHE = new ConcurrentHashMap<>();
  private static final Set<String> FETCHING = ConcurrentHashMap.newKeySet();
  private static boolean loaded;

  private OverlayBeans() {}

  static void bind(TextView tv, String raw) {
    if (tv == null) return;
    final String text = raw == null ? "" : raw;
    tv.setTag(text);
    ensureIndex(tv.getContext());
    tv.setText(spannable(tv.getContext(), text));
    List<String> missing = missingFiles(tv.getContext(), text);
    if (missing.isEmpty()) return;
    Context app = tv.getContext().getApplicationContext();
    fetch(app, missing, () -> {
      Object tag = tv.getTag();
      if (!(tag instanceof String) || !text.equals(tag)) return;
      tv.setText(spannable(tv.getContext(), text));
    });
  }

  private static CharSequence spannable(Context ctx, String text) {
    if (text.isEmpty() || CODE_FILE.isEmpty()) return text;
    SpannableStringBuilder sb = new SpannableStringBuilder(text);
    Matcher m = TOKEN.matcher(text);
    List<int[]> spans = new ArrayList<>();
    List<String> files = new ArrayList<>();
    while (m.find()) {
      String file = fileFor(m.group(1));
      if (file == null) continue;
      Bitmap bmp = bitmap(ctx, file);
      if (bmp == null) continue;
      spans.add(new int[]{ m.start(), m.end() });
      files.add(file);
    }
    for (int i = spans.size() - 1; i >= 0; i--) {
      Bitmap bmp = CACHE.get(files.get(i));
      if (bmp == null || bmp.isRecycled()) continue;
      int[] r = spans.get(i);
      BitmapDrawable d = new BitmapDrawable(ctx.getResources(), bmp);
      d.setBounds(0, 0, bmp.getWidth(), bmp.getHeight());
      sb.setSpan(new ImageSpan(d, ImageSpan.ALIGN_BOTTOM), r[0], r[1], SpannableStringBuilder.SPAN_EXCLUSIVE_EXCLUSIVE);
    }
    return sb;
  }

  private static List<String> missingFiles(Context ctx, String text) {
    List<String> out = new ArrayList<>();
    if (text == null || CODE_FILE.isEmpty()) return out;
    Matcher m = TOKEN.matcher(text);
    Set<String> seen = new HashSet<>();
    while (m.find()) {
      String file = fileFor(m.group(1));
      if (file == null || !seen.add(file)) continue;
      if (bitmap(ctx, file) == null) out.add(file);
    }
    return out;
  }

  private static String fileFor(String code) {
    String key = code == null ? "" : code.trim();
    if (key.isEmpty()) return null;
    String file = CODE_FILE.get(key);
    if (file != null) return file;
    return CODE_FILE.get(key.toLowerCase());
  }

  private static Bitmap bitmap(Context ctx, String file) {
    Bitmap hit = CACHE.get(file);
    if (hit != null && !hit.isRecycled()) return hit;
    Bitmap loadedBmp = decodeLocal(ctx, file);
    if (loadedBmp != null) {
      CACHE.put(file, loadedBmp);
      return loadedBmp;
    }
    return null;
  }

  private static Bitmap decodeLocal(Context ctx, String file) {
    int size = Math.round(18f * ctx.getResources().getDisplayMetrics().density);
    return decodeLocalSized(ctx, file, size);
  }

  private static Bitmap decodeLocalSized(Context ctx, String file, int size) {
    int px = Math.max(16, size);
    String[] assetPaths = {
      "inline-emoji/" + file,
      "public/assets/inline-emoji/out/" + file,
    };
    for (String path : assetPaths) {
      try {
        InputStream in = ctx.getAssets().open(path);
        try {
          Bitmap raw = BitmapFactory.decodeStream(in);
          if (raw != null) return Bitmap.createScaledBitmap(raw, px, px, true);
        } finally {
          in.close();
        }
      } catch (Exception ignored) {}
    }
    File cached = new File(new File(ctx.getFilesDir(), "inline-emoji"), file);
    if (cached.isFile() && cached.length() > 32) {
      Bitmap raw = BitmapFactory.decodeFile(cached.getAbsolutePath());
      if (raw != null) return Bitmap.createScaledBitmap(raw, px, px, true);
    }
    return null;
  }

  /** 桌面小组件：按心情码取小黄豆图；本地没有则异步下载后回调。 */
  static Bitmap widgetBean(Context ctx, String code, int sizePx) {
    if (ctx == null) return null;
    ensureIndex(ctx);
    String file = fileFor(code);
    if (file == null) return null;
    return decodeLocalSized(ctx, file, sizePx);
  }

  static void ensureWidgetBean(Context ctx, String code, Runnable done) {
    if (ctx == null) {
      if (done != null) done.run();
      return;
    }
    ensureIndex(ctx);
    String file = fileFor(code);
    if (file == null) {
      if (done != null) MAIN.post(done);
      return;
    }
    if (decodeLocalSized(ctx, file, 8) != null) {
      if (done != null) MAIN.post(done);
      return;
    }
    List<String> missing = new ArrayList<>();
    missing.add(file);
    fetch(ctx, missing, done == null ? () -> {} : done);
  }

  static String beanCodeForMood(String primary) {
    String raw = primary == null ? "" : primary.trim();
    if (raw.isEmpty()) return "微笑";
    String key = raw.toLowerCase(Locale.ROOT);
    // 行程「睡觉」/疲惫/emoji：跟状态对齐，不要落到默认微笑
    if (raw.contains("睡") || key.contains("sleep") || key.equals("tired") || key.equals("asleep")
        || key.equals("疲惫") || "😴".equals(raw) || "💤".equals(raw)) {
      return "睡着";
    }
    switch (key) {
      case "happy":
      case "开心":
      case "愉快":
        return "愉快";
      case "warm":
      case "暖洋洋":
        return "给心";
      case "low":
      case "有点低落":
      case "低落":
        return "委屈";
      case "hurt":
      case "委屈":
        return "落泪";
      case "angry":
      case "生气":
        return "生气";
      case "anxious":
      case "忐忑":
        return "汗";
      case "lonely":
      case "longing":
      case "孤单":
      case "思念":
        return "月亮";
      case "excited":
      case "兴奋":
        return "呲牙";
      case "bitter":
      case "别扭":
        return "嫌弃";
      case "desire":
      case "欲念":
        return "色";
      case "intimate":
      case "亲近":
        return "亲";
      case "calm":
      case "平静":
        return "微笑";
      default:
        return "微笑";
    }
  }

  /** primary / label / emoji / 行程文案里任一命中睡觉，都用睡着豆 */
  static String resolveWidgetBean(String primary, String label, String emoji, String activity) {
    String[] hints = { activity, primary, label, emoji };
    for (String s : hints) {
      if (s == null || s.trim().isEmpty()) continue;
      String code = beanCodeForMood(s);
      if ("睡着".equals(code)) return "睡着";
    }
    if (primary != null && !primary.trim().isEmpty()) return beanCodeForMood(primary);
    if (label != null && !label.trim().isEmpty()) return beanCodeForMood(label);
    if (emoji != null && !emoji.trim().isEmpty()) return beanCodeForMood(emoji);
    return "微笑";
  }

  private static void fetch(Context ctx, List<String> files, Runnable done) {
    final int[] left = { files.size() };
    for (String file : files) {
      if (!FETCHING.add(file)) {
        MAIN.postDelayed(done, 900);
        if (--left[0] <= 0) MAIN.post(done);
        continue;
      }
      new Thread(() -> {
        try {
          download(ctx, file);
        } catch (Exception ignored) {
        } finally {
          FETCHING.remove(file);
          if (--left[0] <= 0) MAIN.post(done);
        }
      }, "nian-bean").start();
    }
  }

  private static void download(Context ctx, String file) throws Exception {
    if (bitmap(ctx, file) != null) return;
    String base = NianBridgePrefs.serverBase(ctx);
    if (base == null || base.isEmpty()) return;
    String encoded = URLEncoder.encode(file, "UTF-8").replace("+", "%20");
    URL url = new URL(base + "/assets/inline-emoji/out/" + encoded);
    HttpURLConnection c = (HttpURLConnection) url.openConnection();
    try {
      c.setConnectTimeout(6000);
      c.setReadTimeout(12000);
      c.setInstanceFollowRedirects(true);
      String token = NianBridgePrefs.sessionToken(ctx);
      if (token != null && !token.isEmpty()) c.setRequestProperty("X-Nian-Session", token);
      if (c.getResponseCode() >= 400) return;
      InputStream in = c.getInputStream();
      File dir = new File(ctx.getFilesDir(), "inline-emoji");
      if (!dir.exists()) dir.mkdirs();
      File dest = new File(dir, file);
      File tmp = new File(dir, file + ".part");
      FileOutputStream os = new FileOutputStream(tmp);
      try {
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) >= 0) os.write(buf, 0, n);
        os.flush();
      } finally {
        os.close();
      }
      if (tmp.length() < 32) {
        tmp.delete();
        return;
      }
      if (dest.exists()) dest.delete();
      tmp.renameTo(dest);
      CACHE.remove(file);
      bitmap(ctx, file);
    } finally {
      c.disconnect();
    }
  }

  private static synchronized void ensureIndex(Context ctx) {
    if (loaded) return;
    loaded = true;
    String[] paths = { "inline-emoji/manifest.json", "public/assets/inline-emoji/out/manifest.json" };
    for (String path : paths) {
      try {
        InputStream in = ctx.getAssets().open(path);
        byte[] buf = new byte[in.available()];
        int n = in.read(buf);
        in.close();
        if (n <= 0) continue;
        JSONObject json = new JSONObject(new String(buf, 0, n, "UTF-8"));
        JSONArray arr = json.optJSONArray("emojis");
        if (arr == null) continue;
        for (int i = 0; i < arr.length(); i++) {
          JSONObject e = arr.optJSONObject(i);
          if (e == null) continue;
          String code = e.optString("code", "").trim();
          String file = e.optString("file", "").trim();
          if (code.isEmpty()) continue;
          if (file.isEmpty()) file = code + ".png";
          CODE_FILE.put(code, file);
          CODE_FILE.put(code.toLowerCase(), file);
          JSONArray aliases = e.optJSONArray("aliases");
          if (aliases == null) continue;
          for (int a = 0; a < aliases.length(); a++) {
            String al = aliases.optString(a, "").trim();
            if (!al.isEmpty()) CODE_FILE.put(al.toLowerCase(), file);
          }
        }
        if (!CODE_FILE.isEmpty()) return;
      } catch (Exception ignored) {}
    }
  }
}

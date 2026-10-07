package app.nian.comm;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** 系统「分享到念」：从 ACTION_SEND 取出文案/图片，拷到缓存供 WebView 上传。 */
final class ShareReceiveHelper {
  private static final long MAX_IMAGE_BYTES = 12L * 1024L * 1024L;
  private static final int MAX_IMAGES = 9;

  private ShareReceiveHelper() {}

  static JSONObject capture(Context ctx, Intent intent) {
    if (ctx == null || intent == null) return null;
    String action = intent.getAction();
    if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
      return null;
    }

    String type = intent.getType() != null ? intent.getType() : "";
    String subject = safeExtra(intent, Intent.EXTRA_SUBJECT);
    String text = safeExtra(intent, Intent.EXTRA_TEXT);
    if (text.isEmpty()) text = safeExtra(intent, Intent.EXTRA_HTML_TEXT);

    List<Uri> uris = new ArrayList<>();
    if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
      ArrayList<Uri> list = null;
      try {
        if (Build.VERSION.SDK_INT >= 33) {
          list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        } else {
          @SuppressWarnings("deprecation")
          ArrayList<Uri> legacy = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
          list = legacy;
        }
      } catch (Exception ignored) {}
      if (list != null) {
        for (Uri u : list) {
          if (u != null) uris.add(u);
        }
      }
    } else {
      Uri one = null;
      try {
        if (Build.VERSION.SDK_INT >= 33) {
          one = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        } else {
          @SuppressWarnings("deprecation")
          Uri legacy = intent.getParcelableExtra(Intent.EXTRA_STREAM);
          one = legacy;
        }
      } catch (Exception ignored) {}
      if (one != null) uris.add(one);
    }

    JSONArray files = new JSONArray();
    ContentResolver cr = ctx.getContentResolver();
    File dir = new File(ctx.getCacheDir(), "share");
    if (!dir.exists()) dir.mkdirs();
    int copied = 0;
    for (Uri uri : uris) {
      if (copied >= MAX_IMAGES) break;
      JSONObject file = copyUriToCache(cr, dir, uri, type);
      if (file != null) {
        files.put(file);
        copied++;
      }
    }

    if (text.isEmpty() && subject.isEmpty() && files.length() == 0) return null;

    JSONObject out = new JSONObject();
    try {
      out.put("text", text);
      out.put("subject", subject);
      out.put("mime", type);
      out.put("files", files);
      out.put("hint", guessHint(text, subject, type));
      out.put("at", System.currentTimeMillis());
    } catch (Exception e) {
      return null;
    }
    neutralize(intent);
    return out;
  }

  /** 仅允许读 share 缓存，给 JS 兜底拉图。 */
  static String readCacheFileBase64(Context ctx, String absPath) {
    if (ctx == null || absPath == null || absPath.isEmpty()) return "";
    try {
      File shareRoot = new File(ctx.getCacheDir(), "share").getCanonicalFile();
      File target = new File(absPath).getCanonicalFile();
      String rootPath = shareRoot.getPath();
      if (!target.getPath().startsWith(rootPath + File.separator) && !target.getPath().equals(rootPath)) {
        return "";
      }
      if (!target.isFile() || target.length() <= 0 || target.length() > MAX_IMAGE_BYTES) return "";
      byte[] buf = new byte[(int) target.length()];
      try (FileInputStream in = new FileInputStream(target)) {
        int off = 0;
        while (off < buf.length) {
          int n = in.read(buf, off, buf.length - off);
          if (n < 0) break;
          off += n;
        }
        if (off != buf.length) return "";
      }
      return Base64.encodeToString(buf, Base64.NO_WRAP);
    } catch (Exception e) {
      return "";
    }
  }

  private static void neutralize(Intent intent) {
    try {
      intent.removeExtra(Intent.EXTRA_TEXT);
      intent.removeExtra(Intent.EXTRA_HTML_TEXT);
      intent.removeExtra(Intent.EXTRA_SUBJECT);
      intent.removeExtra(Intent.EXTRA_STREAM);
      intent.setAction(Intent.ACTION_MAIN);
      intent.setData(null);
      intent.setClipData(null);
    } catch (Exception ignored) {}
  }

  private static String safeExtra(Intent intent, String key) {
    try {
      CharSequence cs = intent.getCharSequenceExtra(key);
      if (cs != null) return cs.toString().trim();
      String s = intent.getStringExtra(key);
      return s != null ? s.trim() : "";
    } catch (Exception e) {
      return "";
    }
  }

  private static String guessHint(String text, String subject, String mime) {
    String blob = (text + "\n" + subject).toLowerCase(Locale.US);
    if (blob.contains("x.com/") || blob.contains("twitter.com/") || blob.contains("t.co/")) {
      return "x";
    }
    if (blob.contains("xhslink.com") || blob.contains("xiaohongshu.com")) {
      return "xhs";
    }
    if (mime != null && mime.startsWith("image/")) return "image";
    return "share";
  }

  private static JSONObject copyUriToCache(ContentResolver cr, File dir, Uri uri, String fallbackMime) {
    if (cr == null || dir == null || uri == null) return null;
    String mime = null;
    try { mime = cr.getType(uri); } catch (Exception ignored) {}
    if (mime == null || mime.isEmpty()) mime = fallbackMime;
    if (mime == null) mime = "application/octet-stream";
    // 先只收图片；视频以后再说
    if (!mime.startsWith("image/") && !isProbablyImageUri(uri, mime)) return null;

    String display = queryDisplayName(cr, uri);
    String ext = extensionFor(mime, display);
    File out = new File(dir, "s_" + UUID.randomUUID().toString().replace("-", "") + ext);

    long total = 0;
    try (InputStream in = cr.openInputStream(uri);
         FileOutputStream fos = new FileOutputStream(out)) {
      if (in == null) return null;
      byte[] buf = new byte[8192];
      int n;
      while ((n = in.read(buf)) >= 0) {
        total += n;
        if (total > MAX_IMAGE_BYTES) {
          try { out.delete(); } catch (Exception ignored) {}
          return null;
        }
        fos.write(buf, 0, n);
      }
      fos.flush();
    } catch (Exception e) {
      try { out.delete(); } catch (Exception ignored) {}
      return null;
    }
    if (total <= 0 || !out.isFile()) {
      try { out.delete(); } catch (Exception ignored) {}
      return null;
    }

    JSONObject file = new JSONObject();
    try {
      file.put("path", out.getAbsolutePath());
      file.put("mime", mime.startsWith("image/") ? mime : "image/jpeg");
      file.put("name", display.isEmpty() ? out.getName() : display);
      file.put("size", total);
    } catch (Exception e) {
      try { out.delete(); } catch (Exception ignored) {}
      return null;
    }
    return file;
  }

  private static boolean isProbablyImageUri(Uri uri, String mime) {
    if ("*/*".equals(mime) || "application/octet-stream".equals(mime)) {
      String p = uri.toString().toLowerCase(Locale.US);
      return p.contains(".jpg") || p.contains(".jpeg") || p.contains(".png")
        || p.contains(".webp") || p.contains(".gif") || p.contains("image");
    }
    return false;
  }

  private static String queryDisplayName(ContentResolver cr, Uri uri) {
    try (Cursor c = cr.query(uri, new String[]{ OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
        if (idx >= 0) {
          String name = c.getString(idx);
          if (name != null && !name.trim().isEmpty()) return name.trim();
        }
      }
    } catch (Exception ignored) {}
    return "";
  }

  private static String extensionFor(String mime, String display) {
    if (display != null) {
      int dot = display.lastIndexOf('.');
      if (dot > 0 && dot < display.length() - 1) {
        String e = display.substring(dot).toLowerCase(Locale.US);
        if (e.matches("\\.(jpe?g|png|webp|gif|heic|heif|bmp)")) return e.equals(".jpeg") ? ".jpg" : e;
      }
    }
    String sub = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
    if (sub != null && !sub.isEmpty()) return "." + sub;
    if (mime != null) {
      if (mime.contains("png")) return ".png";
      if (mime.contains("webp")) return ".webp";
      if (mime.contains("gif")) return ".gif";
    }
    return ".jpg";
  }
}

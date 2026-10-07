package app.nian.comm;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class PhoneHttp {
  private PhoneHttp() {}

  static String get(Context ctx, String path) throws Exception {
    return request(ctx, "GET", path, null, 0);
  }

  static String post(Context ctx, String path, String jsonBody) throws Exception {
    return request(ctx, "POST", path, jsonBody, 0);
  }

  static String post(Context ctx, String path, String jsonBody, int readTimeoutMs) throws Exception {
    return request(ctx, "POST", path, jsonBody, readTimeoutMs);
  }

  static void download(Context ctx, String pathOrUrl, java.io.File dest) throws Exception {
    String base = NianBridgePrefs.serverBase(ctx);
    String src = pathOrUrl == null ? "" : pathOrUrl.trim();
    if (src.isEmpty()) throw new IllegalStateException("no_url");
    URL url;
    if (src.startsWith("http://") || src.startsWith("https://")) {
      url = new URL(src);
    } else {
      if (base == null || base.isEmpty()) throw new IllegalStateException("no_server");
      url = new URL(base + (src.startsWith("/") ? src : "/" + src));
    }
    HttpURLConnection c = (HttpURLConnection) url.openConnection();
    try {
      c.setRequestMethod("GET");
      c.setConnectTimeout(8000);
      c.setReadTimeout(30000);
      String token = NianBridgePrefs.sessionToken(ctx);
      if (token != null && !token.isEmpty()) {
        c.setRequestProperty("X-Nian-Session", token);
      }
      int code = c.getResponseCode();
      if (code >= 400) throw new IllegalStateException("http_" + code);
      InputStream in = c.getInputStream();
      java.io.File parent = dest.getParentFile();
      if (parent != null && !parent.exists()) parent.mkdirs();
      java.io.FileOutputStream os = new java.io.FileOutputStream(dest);
      try {
        byte[] buf = new byte[8192];
        int n;
        long total = 0;
        while ((n = in.read(buf)) >= 0) {
          os.write(buf, 0, n);
          total += n;
        }
        os.flush();
        if (total < 80) throw new IllegalStateException("audio_empty");
      } finally {
        os.close();
      }
    } finally {
      c.disconnect();
    }
  }

  private static String request(Context ctx, String method, String path, String jsonBody, int readTimeoutMs) throws Exception {
    String base = NianBridgePrefs.serverBase(ctx);
    if (base == null || base.isEmpty()) throw new IllegalStateException("no_server");
    String p = path == null ? "/" : (path.startsWith("/") ? path : "/" + path);
    URL url = new URL(base + p);
    HttpURLConnection c = (HttpURLConnection) url.openConnection();
    try {
      c.setRequestMethod(method);
      c.setConnectTimeout(8000);
      int readMs = readTimeoutMs > 0
        ? readTimeoutMs
        : (jsonBody != null && jsonBody.length() > 8000 ? 25000 : 12000);
      c.setReadTimeout(readMs);
      c.setRequestProperty("Accept", "application/json");
      String token = NianBridgePrefs.sessionToken(ctx);
      if (token != null && !token.isEmpty()) {
        c.setRequestProperty("X-Nian-Session", token);
      }
      if (jsonBody != null) {
        byte[] raw = jsonBody.getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        c.setFixedLengthStreamingMode(raw.length);
        OutputStream os = c.getOutputStream();
        os.write(raw);
        os.flush();
      }
      int code = c.getResponseCode();
      InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
      String body = readAll(in);
      if (code >= 400) {
        throw new IllegalStateException("http_" + code + " " + body);
      }
      return body;
    } finally {
      c.disconnect();
    }
  }

  private static String readAll(InputStream in) throws Exception {
    if (in == null) return "";
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    byte[] buf = new byte[4096];
    int n;
    while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
    return bos.toString("UTF-8");
  }
}

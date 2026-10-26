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

  /** 上传通话录音。fields 里放 duration 等表单字段。 */
  static String postMultipart(
    Context ctx,
    String path,
    String fileField,
    String filename,
    byte[] file,
    String mime,
    java.util.Map<String, String> fields,
    int readTimeoutMs
  ) throws Exception {
    String base = NianBridgePrefs.serverBase(ctx);
    if (base == null || base.isEmpty()) throw new IllegalStateException("no_server");
    String p = path == null ? "/" : (path.startsWith("/") ? path : "/" + path);
    String boundary = "----NianCall" + System.currentTimeMillis();
    HttpURLConnection c = (HttpURLConnection) new URL(base + p).openConnection();
    try {
      c.setRequestMethod("POST");
      c.setConnectTimeout(8000);
      c.setReadTimeout(readTimeoutMs > 0 ? readTimeoutMs : 30000);
      c.setDoOutput(true);
      c.setRequestProperty("Accept", "application/json");
      c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
      String token = NianBridgePrefs.sessionToken(ctx);
      if (token != null && !token.isEmpty()) {
        c.setRequestProperty("X-Nian-Session", token);
      }
      OutputStream os = c.getOutputStream();
      if (fields != null) {
        for (java.util.Map.Entry<String, String> e : fields.entrySet()) {
          writePart(os, boundary, e.getKey(), e.getValue() == null ? "" : e.getValue());
        }
      }
      writeFilePart(os, boundary, fileField, filename, mime, file);
      os.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
      os.flush();
      int code = c.getResponseCode();
      InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
      String body = readAll(in);
      if (code >= 400) throw new IllegalStateException("http_" + code + " " + body);
      return body;
    } finally {
      c.disconnect();
    }
  }

  /** POST JSON，把响应体原样拿回来（TTS 是 mp3，不是 JSON）。 */
  static byte[] postForBytes(Context ctx, String path, String jsonBody, int readTimeoutMs) throws Exception {
    String base = NianBridgePrefs.serverBase(ctx);
    if (base == null || base.isEmpty()) throw new IllegalStateException("no_server");
    String p = path == null ? "/" : (path.startsWith("/") ? path : "/" + path);
    HttpURLConnection c = (HttpURLConnection) new URL(base + p).openConnection();
    try {
      c.setRequestMethod("POST");
      c.setConnectTimeout(8000);
      c.setReadTimeout(readTimeoutMs > 0 ? readTimeoutMs : 60000);
      c.setRequestProperty("Accept", "*/*");
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
      byte[] body = readBytes(in);
      if (code >= 400) {
        throw new IllegalStateException("http_" + code + " " + new String(body, StandardCharsets.UTF_8));
      }
      return body;
    } finally {
      c.disconnect();
    }
  }

  private static void writePart(OutputStream os, String boundary, String name, String value) throws Exception {
    String head = "--" + boundary + "\r\n"
      + "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n"
      + value + "\r\n";
    os.write(head.getBytes(StandardCharsets.UTF_8));
  }

  private static void writeFilePart(
    OutputStream os, String boundary, String name, String filename, String mime, byte[] file
  ) throws Exception {
    String head = "--" + boundary + "\r\n"
      + "Content-Disposition: form-data; name=\"" + name + "\"; filename=\"" + filename + "\"\r\n"
      + "Content-Type: " + (mime == null || mime.isEmpty() ? "application/octet-stream" : mime) + "\r\n\r\n";
    os.write(head.getBytes(StandardCharsets.UTF_8));
    if (file != null && file.length > 0) os.write(file);
    os.write("\r\n".getBytes(StandardCharsets.UTF_8));
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
    return new String(readBytes(in), StandardCharsets.UTF_8);
  }

  private static byte[] readBytes(InputStream in) throws Exception {
    if (in == null) return new byte[0];
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    byte[] buf = new byte[4096];
    int n;
    while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
    return bos.toByteArray();
  }
}

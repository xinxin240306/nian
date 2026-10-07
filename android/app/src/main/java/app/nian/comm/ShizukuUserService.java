package app.nian.comm;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.media.MediaMetadata;
import android.os.RemoteException;
import androidx.annotation.Keep;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.List;

/**
 * 跑在 Shizuku 的 shell/root 进程里。只允许给「念」自己提权，不执行网页传来的任意命令。
 */
public class ShizukuUserService extends INianShizukuService.Stub {
  public ShizukuUserService() {}

  @Keep
  public ShizukuUserService(Context context) {}

  @Override
  public void destroy() {
    System.exit(0);
  }

  @Override
  public void exit() {
    destroy();
  }

  @Override
  public String applyHelpers(String pkg, String listenerComponent) throws RemoteException {
    if (pkg == null || !pkg.matches("^[a-zA-Z0-9._]+$")) return "拒绝：包名不合法";
    if (listenerComponent == null || !listenerComponent.startsWith(pkg + "/")) {
      return "拒绝：组件名不匹配";
    }

    StringBuilder out = new StringBuilder();
    String[][] cmds = {
      { "pm", "grant", pkg, "android.permission.POST_NOTIFICATIONS" },
      { "pm", "grant", pkg, "android.permission.CAMERA" },
      { "pm", "grant", pkg, "android.permission.RECORD_AUDIO" },
      { "pm", "grant", pkg, "android.permission.READ_MEDIA_IMAGES" },
      { "pm", "grant", pkg, "android.permission.READ_MEDIA_VIDEO" },
      { "pm", "grant", pkg, "android.permission.READ_EXTERNAL_STORAGE" },
      { "pm", "grant", pkg, "android.permission.WRITE_SECURE_SETTINGS" },
      { "pm", "grant", pkg, "android.permission.PACKAGE_USAGE_STATS" },
      { "pm", "grant", pkg, "android.permission.ACTIVITY_RECOGNITION" },
      { "appops", "set", pkg, "GET_USAGE_STATS", "allow" },
      { "cmd", "notification", "allow_listener", listenerComponent },
      { "appops", "set", pkg, "SYSTEM_ALERT_WINDOW", "allow" },
      { "cmd", "appops", "set", pkg, "RUN_ANY_IN_BACKGROUND", "allow" },
      { "dumpsys", "deviceidle", "whitelist", "+" + pkg },
    };
    for (String[] cmd : cmds) {
      out.append(android.text.TextUtils.join(" ", cmd)).append(" → ").append(run(cmd)).append('\n');
    }
    return out.toString().trim();
  }

  @Override
  public byte[] captureScreen() throws RemoteException {
    Process p = null;
    try {
      p = new ProcessBuilder("screencap", "-p").redirectErrorStream(true).start();
      byte[] png = readAll(p.getInputStream());
      p.waitFor();
      if (png == null || png.length < 32) return new byte[0];
      return toJpeg(png);
    } catch (Exception e) {
      return new byte[0];
    } finally {
      if (p != null) p.destroy();
    }
  }

  private static byte[] toJpeg(byte[] png) {
    Bitmap bmp = BitmapFactory.decodeByteArray(png, 0, png.length);
    if (bmp == null) return new byte[0];
    Bitmap scaled = bmp;
    try {
      int w = bmp.getWidth();
      int h = bmp.getHeight();
      int maxW = 720;
      if (w > maxW && w > 0) {
        int nh = Math.max(1, Math.round(h * (maxW / (float) w)));
        scaled = Bitmap.createScaledBitmap(bmp, maxW, nh, true);
      }
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      scaled.compress(Bitmap.CompressFormat.JPEG, 55, out);
      return out.toByteArray();
    } catch (Exception e) {
      return new byte[0];
    } finally {
      try {
        if (scaled != null && scaled != bmp) scaled.recycle();
      } catch (Exception ignored) {}
      try { bmp.recycle(); } catch (Exception ignored) {}
    }
  }

  private static byte[] readAll(InputStream in) throws Exception {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
    return out.toByteArray();
  }

  private static String run(String[] cmd) {
    try {
      Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
      p.waitFor();
      BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
      StringBuilder sb = new StringBuilder();
      String line;
      while ((line = r.readLine()) != null) {
        if (sb.length() > 0) sb.append(' ');
        sb.append(line);
      }
      r.close();
      int code = p.exitValue();
      String text = sb.toString().trim();
      if (code == 0 && text.isEmpty()) return "ok";
      if (code == 0) return text;
      return "失败(" + code + ")" + (text.isEmpty() ? "" : " " + text);
    } catch (Exception e) {
      return "异常 " + e.getMessage();
    }
  }

  @Override
  public String getCurrentMediaSession() throws RemoteException {
    try {
      // 通过 dumpsys media_session 获取当前播放信息
      Process p = new ProcessBuilder("dumpsys", "media_session").redirectErrorStream(true).start();
      BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream()));
      
      String title = null;
      String artist = null;
      String album = null;
      boolean isPlaying = false;
      long position = 0;
      long duration = 0;
      
      String line;
      boolean inActiveSession = false;
      
      while ((line = reader.readLine()) != null) {
        line = line.trim();
        
        // 检测是否进入活动会话
        if (line.contains("state=PlaybackState")) {
          inActiveSession = true;
        }
        
        if (inActiveSession) {
          // 解析播放状态
          if (line.contains("state=") && line.contains("PLAYING")) {
            isPlaying = true;
          }
          
          // 解析歌曲信息
          if (line.contains("title=")) {
            title = extractValue(line, "title=");
          } else if (line.contains("artist=")) {
            artist = extractValue(line, "artist=");
          } else if (line.contains("album=")) {
            album = extractValue(line, "album=");
          } else if (line.contains("position=")) {
            try {
              position = Long.parseLong(extractValue(line, "position="));
            } catch (Exception ignored) {}
          } else if (line.contains("duration=")) {
            try {
              duration = Long.parseLong(extractValue(line, "duration="));
            } catch (Exception ignored) {}
          }
          
          // 如果找到完整信息就退出
          if (title != null && artist != null) {
            break;
          }
        }
      }
      
      reader.close();
      p.waitFor();
      
      // 如果没有找到信息，返回 null
      if (title == null || title.isEmpty()) {
        return null;
      }
      
      // 构建 JSON
      JSONObject json = new JSONObject();
      json.put("title", title);
      json.put("artist", artist != null ? artist : "未知艺术家");
      json.put("album", album != null ? album : "");
      json.put("isPlaying", isPlaying);
      json.put("position", position);
      json.put("duration", duration);
      json.put("timestamp", System.currentTimeMillis());
      
      return json.toString();
      
    } catch (Exception e) {
      return null;
    }
  }

  @Override
  public boolean sendMediaControl(String action) throws RemoteException {
    try {
      // 使用 input keyevent 发送媒体控制命令
      String keycode = null;
      
      switch (action) {
        case "play":
        case "pause":
        case "toggle":
          keycode = "KEYCODE_MEDIA_PLAY_PAUSE";
          break;
        case "next":
          keycode = "KEYCODE_MEDIA_NEXT";
          break;
        case "previous":
        case "prev":
          keycode = "KEYCODE_MEDIA_PREVIOUS";
          break;
        case "stop":
          keycode = "KEYCODE_MEDIA_STOP";
          break;
      }
      
      if (keycode == null) {
        return false;
      }
      
      Process p = new ProcessBuilder("input", "keyevent", keycode).start();
      p.waitFor();
      
      return p.exitValue() == 0;
      
    } catch (Exception e) {
      return false;
    }
  }

  private String extractValue(String line, String key) {
    int start = line.indexOf(key);
    if (start < 0) return null;
    
    start += key.length();
    
    // 处理引号包裹的值
    if (start < line.length() && line.charAt(start) == '"') {
      start++;
      int end = line.indexOf('"', start);
      if (end > start) {
        return line.substring(start, end);
      }
    }
    
    // 处理空格分隔的值
    int end = line.indexOf(' ', start);
    if (end < 0) {
      end = line.indexOf(',', start);
    }
    if (end < 0) {
      return line.substring(start).trim();
    }
    
    return line.substring(start, end).trim();
  }
}

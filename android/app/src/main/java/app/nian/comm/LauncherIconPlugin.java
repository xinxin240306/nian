package app.nian.comm;

import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;

@CapacitorPlugin(name = "LauncherIcon")
public class LauncherIconPlugin extends Plugin {
  private static final String SHORTCUT_ID = "nian.custom.launcher";

  @PluginMethod
  public void pin(PluginCall call) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      call.reject("系统版本过低，无法钉自定义桌面图标");
      return;
    }
    final ShortcutManager sm = getContext().getSystemService(ShortcutManager.class);
    if (sm == null || !sm.isRequestPinShortcutSupported()) {
      call.reject("当前桌面不支持钉快捷方式，应用列表里仍是默认「念」图标");
      return;
    }

    final String imageUrl = call.getString("imageUrl", "");
    final String label = call.getString("label", "念");

    new Thread(() -> {
      Bitmap bmp = decodeIcon(imageUrl);
      getActivity().runOnUiThread(() -> finishPin(call, sm, bmp, label));
    }, "nian-pin-icon").start();
  }

  private void finishPin(PluginCall call, ShortcutManager sm, Bitmap bmp, String label) {
    try {
      Intent launch = getContext().getPackageManager()
        .getLaunchIntentForPackage(getContext().getPackageName());
      if (launch == null) {
        call.reject("无法启动应用");
        return;
      }
      launch.setAction(Intent.ACTION_MAIN);

      ShortcutInfo.Builder builder = new ShortcutInfo.Builder(getContext(), SHORTCUT_ID)
        .setShortLabel(label)
        .setLongLabel(label)
        .setIntent(launch);
      if (bmp != null) builder.setIcon(Icon.createWithBitmap(bmp));
      ShortcutInfo info = builder.build();

      boolean exists = false;
      for (ShortcutInfo s : sm.getPinnedShortcuts()) {
        if (SHORTCUT_ID.equals(s.getId())) {
          exists = true;
          break;
        }
      }

      JSObject ret = new JSObject();
      if (exists) {
        sm.updateShortcuts(Collections.singletonList(info));
        ret.put("updated", true);
      } else {
        sm.requestPinShortcut(info, null);
        ret.put("prompted", true);
      }
      call.resolve(ret);
    } catch (Exception e) {
      call.reject(e.getMessage() != null ? e.getMessage() : "钉图标失败");
    }
  }

  private Bitmap decodeIcon(String imageUrl) {
    if (imageUrl == null || imageUrl.isEmpty()) return null;
    HttpURLConnection conn = null;
    try {
      URL url = new URL(imageUrl);
      conn = (HttpURLConnection) url.openConnection();
      conn.setConnectTimeout(8000);
      conn.setReadTimeout(8000);
      conn.connect();
      try (InputStream in = conn.getInputStream()) {
        Bitmap raw = BitmapFactory.decodeStream(in);
        if (raw == null) return null;
        return Bitmap.createScaledBitmap(raw, 192, 192, true);
      }
    } catch (Exception e) {
      return null;
    } finally {
      if (conn != null) conn.disconnect();
    }
  }
}

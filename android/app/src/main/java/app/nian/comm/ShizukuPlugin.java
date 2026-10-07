package app.nian.comm;

import android.content.Context;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Shizuku")
public class ShizukuPlugin extends Plugin {

  @PluginMethod
  public void getStatus(PluginCall call) {
    JSObject result = new JSObject();
    ShizukuBridge.putStatus(result, getContext());
    call.resolve(result);
  }

  @PluginMethod
  public void requestPermission(PluginCall call) {
    ShizukuBridge.requestPermission();
    call.resolve();
  }

  @PluginMethod
  public void openShizuku(PluginCall call) {
    ShizukuBridge.openShizuku(getContext());
    call.resolve();
  }

  @PluginMethod
  public void applyHelpers(PluginCall call) {
    new Thread(() -> {
      try {
        String result = ShizukuBridge.applyHelpers(getContext());
        JSObject ret = new JSObject();
        ret.put("result", result);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "操作失败");
      }
    }, "shizuku-apply").start();
  }

  @PluginMethod
  public void captureScreen(PluginCall call) {
    new Thread(() -> {
      try {
        byte[] jpeg = ShizukuBridge.captureScreenJpeg(getContext());
        if (jpeg == null || jpeg.length == 0) {
          call.reject("截屏失败");
          return;
        }
        String b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP);
        JSObject ret = new JSObject();
        ret.put("base64", b64);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "截屏失败");
      }
    }, "shizuku-screenshot").start();
  }

  @PluginMethod
  public void getCurrentMediaSession(PluginCall call) {
    new Thread(() -> {
      try {
        JSObject mediaInfo = ShizukuBridge.getCurrentMediaSession(getContext());
        if (mediaInfo == null) {
          JSObject ret = new JSObject();
          ret.put("playing", false);
          call.resolve(ret);
          return;
        }
        call.resolve(mediaInfo);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "获取媒体信息失败");
      }
    }, "shizuku-media").start();
  }

  @PluginMethod
  public void sendMediaControl(PluginCall call) {
    String action = call.getString("action");
    if (action == null || action.isEmpty()) {
      call.reject("缺少 action 参数");
      return;
    }

    new Thread(() -> {
      try {
        boolean success = ShizukuBridge.sendMediaControl(getContext(), action);
        JSObject ret = new JSObject();
        ret.put("success", success);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject(e.getMessage() != null ? e.getMessage() : "媒体控制失败");
      }
    }, "shizuku-media-control").start();
  }
}

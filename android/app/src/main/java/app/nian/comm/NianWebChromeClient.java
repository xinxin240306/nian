package app.nian.comm;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Capacitor 默认会把 RECORD_AUDIO 和 MODIFY_AUDIO_SETTINGS 绑在一起申请。
 * 后者未写入 Manifest 时，整次 WebView 授权会失败，表现为「系统麦克风已开仍提示要权限」。
 * 系统权限已给时直接 grant，避免这条误伤。
 */
public class NianWebChromeClient extends BridgeWebChromeClient {
  private final Bridge bridge;

  public NianWebChromeClient(Bridge bridge) {
    super(bridge);
    this.bridge = bridge;
  }

  @Override
  public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
    Activity activity = bridge.getActivity();
    if (activity == null || callback == null) {
      if (callback != null) callback.invoke(origin, false, false);
      return;
    }
    boolean fine = ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION)
      == PackageManager.PERMISSION_GRANTED;
    boolean coarse = ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_COARSE_LOCATION)
      == PackageManager.PERMISSION_GRANTED;
    if (fine || coarse) {
      callback.invoke(origin, true, false);
      return;
    }
    super.onGeolocationPermissionsShowPrompt(origin, callback);
  }

  @Override
  public void onPermissionRequest(final PermissionRequest request) {
    if (request == null) return;
    Activity activity = bridge.getActivity();
    if (activity == null) {
      request.deny();
      return;
    }
    activity.runOnUiThread(() -> {
      boolean needAudio = false;
      boolean needVideo = false;
      for (String res : request.getResources()) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) needAudio = true;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) needVideo = true;
      }
      boolean audioOk = !needAudio || ContextCompat.checkSelfPermission(
        activity, Manifest.permission.RECORD_AUDIO
      ) == PackageManager.PERMISSION_GRANTED;
      boolean videoOk = !needVideo || ContextCompat.checkSelfPermission(
        activity, Manifest.permission.CAMERA
      ) == PackageManager.PERMISSION_GRANTED;
      if (audioOk && videoOk) {
        request.grant(request.getResources());
        return;
      }
      super.onPermissionRequest(request);
    });
  }
}

package app.nian.comm;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.List;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
  private volatile boolean downloading = false;

  @PluginMethod
  public void getVersion(PluginCall call) {
    JSObject o = new JSObject();
    o.put("versionCode", BuildConfig.VERSION_CODE);
    o.put("versionName", BuildConfig.VERSION_NAME);
    o.put("canInstall", canInstallPackages());
    call.resolve(o);
  }

  @PluginMethod
  public void openInstallPermission(PluginCall call) {
    Context ctx = getContext();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
      intent.setData(Uri.parse("package:" + ctx.getPackageName()));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(intent);
    }
    call.resolve();
  }

  @PluginMethod
  public void installFromUrl(PluginCall call) {
    String url = call.getString("url");
    if (url == null || url.isEmpty()) {
      call.reject("没有下载地址");
      return;
    }
    if (downloading) {
      call.reject("正在下载安装包");
      return;
    }
    if (!canInstallPackages()) {
      openInstallPermission(call);
      call.reject("请先允许「念」安装未知应用，然后再点更新");
      return;
    }
    JSObject headers = call.getObject("headers", new JSObject());
    downloading = true;
    new Thread(() -> {
      File apk = null;
      try {
        apk = downloadApk(url, headers);
        launchInstaller(apk);
        JSObject o = new JSObject();
        o.put("ok", true);
        call.resolve(o);
      } catch (Exception e) {
        if (apk != null) {
          try { apk.delete(); } catch (Exception ignored) {}
        }
        call.reject(e.getMessage() == null ? "下载或安装失败" : e.getMessage());
      } finally {
        downloading = false;
      }
    }, "nian-apk-update").start();
  }

  private boolean canInstallPackages() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
    return getContext().getPackageManager().canRequestPackageInstalls();
  }

  private File downloadApk(String urlStr, JSObject headers) throws Exception {
    Context ctx = getContext();
    File dir = ctx.getCacheDir();
    File out = new File(dir, "nian-update.apk");
    if (out.exists()) out.delete();

    HttpURLConnection conn = open(urlStr, headers);
    int code = conn.getResponseCode();
    if (code >= 400) {
      throw new IllegalStateException("下载失败 HTTP " + code);
    }
    int total = conn.getContentLength();
    InputStream in = conn.getInputStream();
    FileOutputStream fos = new FileOutputStream(out);
    byte[] buf = new byte[65536];
    long got = 0;
    int n;
    int lastPct = -1;
    while ((n = in.read(buf)) > 0) {
      fos.write(buf, 0, n);
      got += n;
      if (total > 0) {
        int pct = (int) (got * 100 / total);
        if (pct != lastPct && (pct == 100 || pct - lastPct >= 5)) {
          lastPct = pct;
          JSObject p = new JSObject();
          p.put("percent", pct);
          notifyListeners("downloadProgress", p);
        }
      }
    }
    fos.close();
    in.close();
    conn.disconnect();
    if (out.length() < 1000) {
      out.delete();
      throw new IllegalStateException("安装包太小，可能不是 APK");
    }
    java.io.FileInputStream peek = new java.io.FileInputStream(out);
    int b1 = peek.read();
    int b2 = peek.read();
    peek.close();
    if (b1 != 'P' || b2 != 'K') {
      out.delete();
      throw new IllegalStateException("下载到的不是安装包");
    }
    return out;
  }

  private HttpURLConnection open(String urlStr, JSObject headers) throws Exception {
    URL url = new URL(urlStr);
    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
    conn.setInstanceFollowRedirects(true);
    conn.setConnectTimeout(20000);
    conn.setReadTimeout(120000);
    conn.setRequestMethod("GET");
    if (headers != null) {
      Iterator<String> keys = headers.keys();
      while (keys.hasNext()) {
        String k = keys.next();
        String v = headers.getString(k);
        if (v != null && !v.isEmpty()) conn.setRequestProperty(k, v);
      }
    }
    int code = conn.getResponseCode();
    if (code == HttpURLConnection.HTTP_MOVED_PERM || code == HttpURLConnection.HTTP_MOVED_TEMP
      || code == HttpURLConnection.HTTP_SEE_OTHER || code == 307 || code == 308) {
      String loc = conn.getHeaderField("Location");
      conn.disconnect();
      if (loc != null && !loc.isEmpty()) return open(loc, headers);
    }
    return conn;
  }

  private void launchInstaller(File apk) {
    Context ctx = getContext();
    Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setDataAndType(uri, "application/vnd.android.package-archive");
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    Activity act = getActivity();
    PackageManager pm = ctx.getPackageManager();
    List<ResolveInfo> res = pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
    for (ResolveInfo ri : res) {
      ctx.grantUriPermission(ri.activityInfo.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
    if (act != null) act.startActivity(intent);
    else ctx.startActivity(intent);
  }
}

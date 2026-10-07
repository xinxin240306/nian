package app.nian.comm;

import android.content.Context;
import org.json.JSONObject;

/** 计步器 + 健康数据共享，合成一份给后端。 */
final class PhoneHealth {
  private PhoneHealth() {}

  static JSONObject snapshot(Context ctx) {
    JSONObject o = StepCounter.snapshot(ctx);
    try {
      HealthConnectBridge.merge(ctx, o);
    } catch (Throwable ignored) {}
    return o;
  }
}

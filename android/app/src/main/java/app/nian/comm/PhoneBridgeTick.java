package app.nian.comm;

import android.content.Context;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.atomic.AtomicBoolean;

/** 前台服务里轮询后端：上报通知/电量、看屏、弹出胶囊。网页被暂停时也能用。 */
final class PhoneBridgeTick {
  private static final String TAG = "NianPhoneTick";
  private static final AtomicBoolean busy = new AtomicBoolean(false);
  private static int tickCount;

  private PhoneBridgeTick() {}

  static void run(Context ctx) {
    if (ctx == null) return;
    String base = NianBridgePrefs.serverBase(ctx);
    if (base == null || base.isEmpty()) return;
    if (!busy.compareAndSet(false, true)) return;
    try {
      tickCount++;
      if (tickCount % 3 == 1) {
        try {
          PhoneHttp.post(ctx, "/api/phone/notifications", PhoneSense.notificationsBody(ctx).toString());
        } catch (Exception e) {
          Log.w(TAG, "notify sync", e);
        }
      }
      try {
        JSONObject toy = BobobeiBle.snapshotJson(ctx);
        if (toy.optBoolean("connected") || toy.optBoolean("ready") || toy.optString("address", "").length() > 0) {
          PhoneHttp.post(ctx, "/api/phone/toy", toy.toString());
        }
      } catch (Exception e) {
        Log.w(TAG, "toy sync", e);
      }
      if (tickCount % 10 == 1) {
        try {
          TogetherWidgetProvider.refreshFromNetwork(ctx, false);
        } catch (Exception e) {
          Log.w(TAG, "together widget", e);
        }
      }
      String raw;
      try {
        raw = PhoneHttp.get(ctx, "/api/phone/pull");
      } catch (Exception e) {
        Log.w(TAG, "pull", e);
        return;
      }
      JSONArray cmds;
      try {
        cmds = new JSONObject(raw).optJSONArray("commands");
      } catch (Exception e) {
        return;
      }
      if (cmds == null) return;
      for (int i = 0; i < cmds.length(); i++) {
        JSONObject cmd = cmds.optJSONObject(i);
        if (cmd == null) continue;
        String type = cmd.optString("type", "");
        if ("capsule".equals(type)) {
          CapsuleOverlay.show(
            ctx,
            cmd.optInt("characterId", 0),
            cmd.optString("name", "TA"),
            cmd.optString("text", ""),
            cmd.optString("avatar", ""),
            cmd.optJSONArray("bubbles")
          );
        } else if ("screen_share".equals(type)) {
          if (cmd.optBoolean("on", true)) {
            ScreenShareOverlay.show(ctx, cmd.optInt("characterId", 0), cmd.optString("name", "TA"));
          } else {
            ScreenShareOverlay.hide();
          }
        } else if ("screen".equals(type)) {
          handleScreen(ctx, cmd.optString("requestId", ""), cmd.optString("mode", "read"));
        } else if ("control".equals(type)) {
          handleControl(ctx, cmd);
        } else if ("alarm".equals(type)) {
          handleAlarm(ctx, cmd);
        } else if ("incoming_call".equals(type)) {
          IncomingCallService.show(
            ctx,
            cmd.optInt("characterId", 0),
            cmd.optString("name", "TA"),
            cmd.optString("avatar", ""),
            cmd.optString("content", ""),
            cmd.optString("ringtone", ""),
            cmd.optInt("logId", 0),
            cmd.optLong("ringMs", 35000),
            cmd.optBoolean("systemRing", false)
          );
        } else if ("dismiss_incoming_call".equals(type)) {
          IncomingCallService.dismiss(ctx);
        } else if ("toy".equals(type)) {
          handleToy(ctx, cmd);
        } else if ("health".equals(type)) {
          handleHealth(ctx, cmd.optString("requestId", ""));
        } else if ("location".equals(type)) {
          handleLocation(ctx, cmd.optString("requestId", ""));
        }
      }
    } finally {
      busy.set(false);
    }
  }

  private static void handleScreen(Context ctx, String requestId, String mode) {
    if (requestId == null || requestId.isEmpty()) return;
    final JSONObject[] out = new JSONObject[1];
    if (ScreenShareOverlay.callUsesRearCam()) {
      JSONObject body = new JSONObject();
      try {
        String img = ScreenShareOverlay.callPreviewDataUrl();
        body.put("requestId", requestId);
        body.put("source", "rear_cam");
        if (img == null || img.isEmpty()) {
          body.put("ok", false);
          body.put("error", "rear_cam");
        } else {
          body.put("ok", true);
          body.put("screenshot", true);
          body.put("imageDataUrl", img);
          body.put("accessibility", NianAccessibilityService.isConnected());
        }
      } catch (Exception e) {
        try {
          body.put("requestId", requestId);
          body.put("ok", false);
          body.put("error", e.getMessage() == null ? "failed" : e.getMessage());
        } catch (Exception ignored) {}
      }
      out[0] = body;
    } else {
      ScreenShareOverlay.runHidden(() -> {
        JSONObject body = new JSONObject();
        try {
          JSONObject d = PhoneSense.dumpWindow(ctx);
          boolean on = d.optBoolean("accessibilityEnabled") && d.optBoolean("connected");
          String img = "";
          if ("look".equals(mode)) img = PhoneSense.captureJpegDataUrl(ctx);
          body.put("requestId", requestId);
          if (!on && img.isEmpty()) {
            body.put("ok", false);
            body.put("error", "a11y_off");
          } else {
            body.put("ok", true);
            body.put("accessibility", on);
            body.put("screenshot", !img.isEmpty());
            body.put("package", d.optString("package", ""));
            body.put("app", d.optString("app", ""));
            body.put("tree", ScreenShareOverlay.stripFromDump(d.optString("tree", "")));
            body.put("targets", d.optString("targets", ""));
            if (!img.isEmpty()) body.put("imageDataUrl", img);
            if (ScreenShareOverlay.isCallVideo() && ScreenShareOverlay.callUsesFrontCam()) {
              String selfie = ScreenShareOverlay.callPreviewDataUrl();
              if (selfie != null && !selfie.isEmpty()) {
                body.put("selfieDataUrl", selfie);
                body.put("source", "screen_plus_selfie");
              } else {
                body.put("source", "screen");
              }
            } else {
              body.put("source", "screen");
            }
          }
        } catch (Exception e) {
          try {
            body.put("requestId", requestId);
            body.put("ok", false);
            body.put("error", e.getMessage() == null ? "failed" : e.getMessage());
          } catch (Exception ignored) {}
        }
        out[0] = body;
      });
    }
    JSONObject body = out[0];
    if (body == null) return;
    try {
      PhoneHttp.post(ctx, "/api/phone/screen", body.toString());
    } catch (Exception e) {
      Log.w(TAG, "screen post", e);
    }
  }

  private static void handleControl(Context ctx, JSONObject cmd) {
    String requestId = cmd.optString("requestId", "");
    if (requestId.isEmpty()) return;
    final JSONObject[] out = new JSONObject[1];
    ScreenShareOverlay.runHidden(() -> {
      JSONObject body = new JSONObject();
      try {
        JSONObject r = PhoneApps.control(ctx, cmd);
        body.put("requestId", requestId);
        body.put("ok", r.optBoolean("ok", false));
        body.put("error", r.optString("error", ""));
        body.put("package", r.optString("package", ""));
        body.put("app", r.optString("app", ""));
        body.put("tree", r.optString("tree", ""));
        body.put("targets", r.optString("targets", ""));
        body.put("accessibility", r.optBoolean("accessibility", NianAccessibilityService.isConnected()));
        if (r.has("matches")) body.put("matches", r.opt("matches"));
      } catch (Exception e) {
        try {
          body.put("requestId", requestId);
          body.put("ok", false);
          body.put("error", e.getMessage() == null ? "failed" : e.getMessage());
        } catch (Exception ignored) {}
      }
      out[0] = body;
    });
    JSONObject body = out[0];
    if (body == null) return;
    try {
      PhoneHttp.post(ctx, "/api/phone/screen", body.toString());
    } catch (Exception e) {
      Log.w(TAG, "control post", e);
    }
  }

  private static void handleAlarm(Context ctx, JSONObject cmd) {
    String requestId = cmd.optString("requestId", "");
    if (requestId.isEmpty()) return;
    JSONObject r = NianAlarms.handle(ctx, cmd);
    JSONObject body = new JSONObject();
    try {
      body.put("requestId", requestId);
      body.put("ok", r.optBoolean("ok", false));
      body.put("error", r.optString("error", ""));
      body.put("alarmId", r.optInt("alarmId", 0));
      body.put("when", r.optLong("when", 0));
      body.put("hasVoice", r.optBoolean("hasVoice", false));
      body.put("hour", r.optInt("hour", -1));
      body.put("minute", r.optInt("minute", -1));
      body.put("repeat", r.optString("repeat", ""));
      body.put("label", r.optString("label", ""));
      body.put("speech", r.optString("speech", ""));
      body.put("name", r.optString("name", ""));
      if (r.has("alarms")) body.put("alarms", r.opt("alarms"));
    } catch (Exception ignored) {}
    try {
      PhoneHttp.post(ctx, "/api/phone/screen", body.toString());
    } catch (Exception e) {
      Log.w(TAG, "alarm post", e);
    }
  }

  private static void handleToy(Context ctx, JSONObject cmd) {
    String requestId = cmd.optString("requestId", "");
    JSONObject r = BobobeiBle.get(ctx).apply(cmd);
    JSONObject body = new JSONObject();
    try {
      body.put("requestId", requestId);
      body.put("ok", r.optBoolean("ready") || r.optBoolean("connected") || "status".equals(cmd.optString("action")));
      if (!r.optBoolean("ready") && !r.optBoolean("connected") && !"status".equals(cmd.optString("action"))) {
        body.put("ok", false);
        String err = r.optString("error", "");
        body.put("error", err.isEmpty() ? "not_connected" : err);
      }
      body.put("connected", r.optBoolean("connected"));
      body.put("ready", r.optBoolean("ready"));
      body.put("suction", r.optInt("suction"));
      body.put("vibration", r.optInt("vibration"));
      body.put("electric", r.optInt("electric"));
      body.put("name", r.optString("name"));
      body.put("address", r.optString("address"));
      body.put("phase", r.optString("phase"));
      body.put("error", r.optString("error"));
    } catch (Exception ignored) {}
    if (requestId.isEmpty()) return;
    try {
      PhoneHttp.post(ctx, "/api/phone/screen", body.toString());
    } catch (Exception e) {
      Log.w(TAG, "toy post", e);
    }
  }

  private static void handleLocation(Context ctx, String requestId) {
    JSONObject loc = PhoneSense.currentLocation(ctx);
    JSONObject body = new JSONObject();
    try {
      if (requestId != null && !requestId.isEmpty()) body.put("requestId", requestId);
      body.put("ok", loc.optBoolean("ok", false));
      if (loc.optBoolean("ok", false)) {
        body.put("lat", loc.optDouble("latitude"));
        body.put("lng", loc.optDouble("longitude"));
        body.put("accuracy", loc.optDouble("accuracy"));
        body.put("stale", loc.optBoolean("stale", false));
      } else {
        body.put("error", loc.optString("error", "unavailable"));
      }
    } catch (Exception ignored) {}
    try {
      PhoneHttp.post(ctx, "/api/phone/location", body.toString());
    } catch (Exception e) {
      Log.w(TAG, "location sync", e);
    }
  }

  private static void handleHealth(Context ctx, String requestId) {
    try { HealthConnectBridge.invalidate(); } catch (Exception ignored) {}
    JSONObject body = PhoneSense.notificationsBody(ctx);
    if (requestId != null && !requestId.isEmpty()) {
      try { body.put("healthRequestId", requestId); } catch (Exception ignored) {}
    }
    try {
      PhoneHttp.post(ctx, "/api/phone/notifications", body.toString());
    } catch (Exception e) {
      Log.w(TAG, "health sync", e);
    }
  }
}

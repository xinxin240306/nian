package app.nian.comm;

import android.content.Context;
import android.util.Log;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 锁屏 / 切后台时 WebView 会冻住，页面里的上传和模型请求要等亮屏才跑。
 * 这时由通话线程自己把一句录音发出去、等模型、再原生播出来。
 */
final class CallLockTurn {
  private static final String TAG = "NianCallTurn";
  private static final ExecutorService EXEC = Executors.newSingleThreadExecutor(r -> {
    Thread t = new Thread(r, "nian-call-turn");
    t.setDaemon(true);
    return t;
  });
  private static final ArrayDeque<Job> QUEUE = new ArrayDeque<>();
  private static final LinkedHashSet<String> PLAYED = new LinkedHashSet<>();

  private static final String CLIP = "\u0001";
  private static volatile int epoch = 1;
  private static volatile boolean busy;
  private static volatile Context appCtx;
  private static volatile int characterId;
  private static volatile boolean video;
  private static volatile String presenceMode = "talk";
  private static volatile boolean hangoutSleeping;
  private static volatile int hangoutWakeStep;
  private static volatile String inputMode = "voice";

  private CallLockTurn() {}

  static final class Job {
    final int epoch;
    final byte[] wav;
    final long wallMs;
    final boolean periodic;

    Job(int epoch, byte[] wav, long wallMs, boolean periodic) {
      this.epoch = epoch;
      this.wav = wav;
      this.wallMs = wallMs;
      this.periodic = periodic;
    }
  }

  static void attach(Context ctx) {
    if (ctx != null) appCtx = ctx.getApplicationContext();
  }

  static void updateContext(
    Context ctx,
    int charId,
    boolean isVideo,
    String presence,
    boolean sleeping,
    int wakeStep,
    String input
  ) {
    if (ctx != null) appCtx = ctx.getApplicationContext();
    if (charId > 0) characterId = charId;
    video = isVideo;
    String mode = presence == null ? "" : presence.trim();
    if ("hangout".equals(mode) || "watch".equals(mode) || "talk".equals(mode)) {
      presenceMode = mode;
    }
    hangoutSleeping = sleeping;
    hangoutWakeStep = Math.max(0, wakeStep);
    String in = input == null ? "" : input.trim();
    if ("voice".equals(in) || "keyboard".equals(in)) inputMode = in;
  }

  static void cancel() {
    epoch++;
    synchronized (QUEUE) {
      QUEUE.clear();
    }
    synchronized (PLAYED) {
      PLAYED.clear();
    }
    characterId = 0;
  }

  static void submit(byte[] wav, long wallMs, boolean periodic) {
    if (wav == null || wav.length < 800) return;
    if (!NativeCallEngine.isRunning()) return;
    Job job = new Job(epoch, wav, Math.max(0, wallMs), periodic);
    synchronized (QUEUE) {
      while (QUEUE.size() >= 2) QUEUE.removeLast();
      QUEUE.addLast(job);
    }
    busy = true;
    EXEC.execute(CallLockTurn::drain);
  }

  static boolean isBusy() {
    return busy;
  }

  static List<String> playedIdList() {
    synchronized (PLAYED) {
      return new ArrayList<>(PLAYED);
    }
  }

  private static void rememberPlayed(JSONArray ids) {
    if (ids == null) return;
    synchronized (PLAYED) {
      for (int i = 0; i < ids.length(); i++) {
        String id = String.valueOf(ids.opt(i));
        if (id.isEmpty() || "null".equals(id)) continue;
        PLAYED.add(id);
        while (PLAYED.size() > 40) {
          String first = PLAYED.iterator().next();
          PLAYED.remove(first);
        }
      }
    }
  }

  private static void forgetPlayed(JSONArray ids) {
    if (ids == null) return;
    synchronized (PLAYED) {
      for (int i = 0; i < ids.length(); i++) {
        PLAYED.remove(String.valueOf(ids.opt(i)));
      }
    }
  }

  private static void drain() {
    try {
      while (true) {
        Job job;
        synchronized (QUEUE) {
          job = QUEUE.pollFirst();
        }
        if (job == null) return;
        if (job.epoch != epoch || !NativeCallEngine.isRunning()) continue;
        try {
          runJob(job);
        } catch (Exception e) {
          Log.w(TAG, "turn failed", e);
          setPhase("listening");
          notifyJs("idle", null, "");
        }
      }
    } finally {
      synchronized (QUEUE) {
        if (QUEUE.isEmpty()) busy = false;
        else EXEC.execute(CallLockTurn::drain);
      }
    }
  }

  private static void runJob(Job job) throws Exception {
    Context ctx = appCtx;
    int cid = characterId;
    if (ctx != null && cid <= 0) cid = NianBridgePrefs.activeCallCharId(ctx);
    if (ctx == null || cid <= 0) {
      Log.w(TAG, "skip turn: no server/character");
      return;
    }
    if (!stillCurrent(job)) return;
    setPhase("thinking");
    notifyJs("thinking", null, "");

    int duration = (int) Math.max(1, Math.min(60, Math.round(job.wallMs / 1000.0)));
    java.util.HashMap<String, String> fields = new java.util.HashMap<>();
    fields.put("duration", String.valueOf(duration));
    String uploadedRaw = PhoneHttp.postMultipart(
      ctx, "/api/chat/voice-upload", "file", "call-live.wav", job.wav, "audio/wav", fields, 30000
    );
    if (!stillCurrent(job)) return;
    JSONObject uploaded = new JSONObject(uploadedRaw);
    String url = uploaded.optString("url", "");
    if (url.isEmpty()) throw new IllegalStateException("upload_no_url");
    if (uploaded.has("duration")) {
      int d = uploaded.optInt("duration", duration);
      if (d > 0) duration = d;
    }

    JSONObject voice = new JSONObject();
    voice.put("voice", true);
    voice.put("url", url);
    voice.put("duration", duration);
    voice.put("transcript", job.periodic ? "[连麦环境收音]" : "");
    JSONObject vp = uploaded.optJSONObject("voiceprint");
    if (vp != null) {
      String result = vp.optString("result", "");
      if (!result.isEmpty() && !"none".equals(result)) {
        voice.put("voiceprint", result);
        if (vp.has("score")) voice.put("voiceprintScore", vp.optDouble("score"));
      }
    }

    JSONObject send = baseCallBody(cid);
    send.put("content", voice.toString());
    send.put("type", "voice");
    send.put("isDream", false);
    send.put("noReply", true);
    String sentRaw = PhoneHttp.post(ctx, "/api/messages/send", send.toString(), 20000);
    if (!stillCurrent(job)) return;
    JSONObject sent = new JSONObject(sentRaw);
    String delivery = sent.optString("delivery_status", "");
    if ("blocked_by_peer".equals(delivery) || "deleted_by_peer".equals(delivery)) {
      Log.i(TAG, "peer blocked delivery");
      setPhase("listening");
      notifyJs("idle", null, "");
      return;
    }

    JSONObject trigger = baseCallBody(cid);
    trigger.put("isDream", false);
    trigger.put("mode", "retry");
    String aiRaw = PhoneHttp.post(ctx, "/api/messages/trigger-ai", trigger.toString(), 130000);
    if (!stillCurrent(job)) return;
    JSONObject ai = new JSONObject(aiRaw);
    Speech speech = extractSpeech(ai);
    if ((speech.text == null || speech.text.isEmpty()) && (speech.clipUrl == null || speech.clipUrl.isEmpty())) {
      Log.i(TAG, "model replied with no speech");
      setPhase("listening");
      notifyJs("idle", speech.ids, "");
      return;
    }

    rememberPlayed(speech.ids);
    setPhase("speaking");
    boolean ok = playSpeech(ctx, job, speech, cid);
    if (!ok && job.epoch == epoch) forgetPlayed(speech.ids);
    if (!stillCurrent(job)) return;
    setPhase("listening");
    notifyJs(ok ? "played" : "idle", speech.ids, ok ? speech.text : "");
  }

  private static boolean stillCurrent(Job job) {
    return job != null && job.epoch == epoch && NativeCallEngine.isRunning();
  }

  private static JSONObject baseCallBody(int cid) throws Exception {
    JSONObject o = new JSONObject();
    o.put("characterId", cid);
    o.put("isVoiceCall", true);
    o.put("isVideoCall", video);
    o.put("callPresenceMode", presenceMode == null ? "talk" : presenceMode);
    o.put("callInputMode", inputMode == null ? "voice" : inputMode);
    if (hangoutSleeping) {
      o.put("callHangoutSleeping", true);
      o.put("callHangoutWakeStep", Math.max(1, hangoutWakeStep));
    }
    return o;
  }

  private static boolean playSpeech(Context ctx, Job job, Speech speech, int cid) {
    if (!stillCurrent(job)) return false;
    String clip = speech.clipUrl == null ? "" : speech.clipUrl.trim();
    if (!clip.isEmpty() && (speech.text == null || speech.text.isEmpty())) {
      String abs = absoluteUrl(ctx, clip);
      return awaitPlay(null, abs);
    }
    String text = speech.text == null ? "" : speech.text.trim();
    if (text.length() > 1200) text = text.substring(0, 1200);
    if (text.isEmpty()) return false;
    try {
      JSONObject body = new JSONObject();
      body.put("text", text);
      body.put("characterId", cid);
      body.put("inCall", true);
      if (speech.emotion != null && !speech.emotion.isEmpty()) body.put("emotion", speech.emotion);
      if (speech.tone != null && !speech.tone.isEmpty()) body.put("tone", speech.tone);
      byte[] mp3 = PhoneHttp.postForBytes(ctx, "/api/tts", body.toString(), 60000);
      if (!stillCurrent(job)) return false;
      if (mp3 == null || mp3.length < 80) return false;
      return awaitPlay(mp3, null);
    } catch (Exception e) {
      Log.w(TAG, "tts failed", e);
      return false;
    }
  }

  private static boolean awaitPlay(byte[] mp3, String url) {
    CountDownLatch latch = new CountDownLatch(1);
    boolean[] ok = new boolean[] { false };
    NativeCallEngine.PlayCallback done = success -> {
      ok[0] = success;
      latch.countDown();
    };
    if (mp3 != null) NativeCallEngine.playBytes(mp3, "audio/mpeg", 1f, done);
    else NativeCallEngine.play(url, 1f, done);
    try {
      if (!latch.await(3, TimeUnit.MINUTES)) return false;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return false;
    }
    return ok[0];
  }

  private static String absoluteUrl(Context ctx, String url) {
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    String base = NianBridgePrefs.serverBase(ctx);
    if (base == null) base = "";
    if (url.startsWith("/")) return base + url;
    return base + "/" + url;
  }

  private static void setPhase(String phase) {
    if (!NativeCallEngine.isRunning()) return;
    try { ScreenShareOverlay.setCallPhase(phase); } catch (Exception ignored) {}
  }

  private static void notifyJs(String phase, JSONArray ids, String text) {
    try {
      JSONObject o = new JSONObject();
      o.put("phase", phase);
      o.put("ids", ids == null ? new JSONArray() : ids);
      o.put("text", text == null ? "" : text);
      MainActivity.runJs(
        "try{window.__nianCallLockTurn&&window.__nianCallLockTurn(" + o.toString() + ")}catch(e){}"
      );
    } catch (Exception ignored) {}
  }

  private static final class Speech {
    String text = "";
    String clipUrl = "";
    String emotion = "";
    String tone = "";
    JSONArray ids = new JSONArray();
  }

  private static Speech extractSpeech(JSONObject ai) {
    Speech out = new Speech();
    JSONArray msgs = ai.optJSONArray("aiMessages");
    StringBuilder text = new StringBuilder();
    if (msgs != null) {
      for (int i = 0; i < msgs.length(); i++) {
        JSONObject m = msgs.optJSONObject(i);
        if (m == null) continue;
        String role = m.optString("role", "assistant");
        if (!"assistant".equals(role)) continue;
        if (isSkippable(m)) continue;
        String raw = m.optString("content", "").trim();
        String piece = speakPiece(raw);
        if (piece == null) continue;
        if (piece.startsWith(CLIP)) {
          if (out.clipUrl.isEmpty()) out.clipUrl = piece.substring(CLIP.length());
        } else if (!piece.isEmpty()) {
          if (text.length() > 0) text.append('\n');
          text.append(piece);
        }
        if (m.has("id")) out.ids.put(m.opt("id"));
        if (out.emotion.isEmpty()) out.emotion = m.optString("tts_emotion", "").trim();
        if (out.tone.isEmpty()) out.tone = m.optString("tts_tone", "").trim();
      }
    }
    out.text = text.toString().trim();
    if (out.text.isEmpty() && out.clipUrl.isEmpty()) {
      String fallback = speakPiece(ai.optString("content", "").trim());
      if (fallback != null && fallback.startsWith(CLIP)) {
        out.clipUrl = fallback.substring(CLIP.length());
      } else if (fallback != null) {
        out.text = fallback.trim();
      }
      if (out.ids.length() == 0 && ai.has("aiMsgId") && !ai.isNull("aiMsgId")) {
        out.ids.put(ai.opt("aiMsgId"));
      }
    }
    return out;
  }

  private static boolean isSkippable(JSONObject m) {
    String metaRaw = m.optString("media_meta", "");
    if (metaRaw.startsWith("{")) {
      try {
        JSONObject meta = new JSONObject(metaRaw);
        if (meta.optBoolean("hideChat") || meta.optBoolean("hiddenChat") || meta.optBoolean("robotMic")) {
          return true;
        }
      } catch (Exception ignored) {}
    }
    return false;
  }

  /** null = 音效/垫音，不要念。空串 = 安静。CLIP 前缀 = 已有音频地址。 */
  private static String speakPiece(String raw) {
    String t = raw == null ? "" : raw.trim();
    if (t.isEmpty()) return "";
    if (t.startsWith("{")) {
      try {
        JSONObject j = new JSONObject(t);
        if (j.optBoolean("sfx") || j.optBoolean("vocal") || j.optBoolean("ambience")
          || j.optBoolean("breathBed") || j.has("texture") || j.has("score")) {
          return null;
        }
        if (j.optBoolean("voice")) {
          String said = j.optString("transcript", "").trim();
          String url = j.optString("url", "").trim();
          if (!said.isEmpty()) t = said;
          else if (!url.isEmpty()) return CLIP + url;
          else return "";
        }
      } catch (Exception ignored) {}
    }
    if (t.startsWith("【自动回复】")) t = t.substring("【自动回复】".length()).trim();
    t = t.replaceAll("(?s)\\[\\s*镜头\\s*\\].*?\\[\\s*/\\s*镜头\\s*\\]", "");
    t = t.replaceAll("(?i)\\[\\s*语速\\s*[:：]\\s*[0-9.]+\\s*\\]", "");
    t = t.replaceAll("(?m)^(?:环境|音效|SFX|SOUND|AMB|AMBIENCE)\\s*[:：].*$", "");
    t = t.trim();
    if (t.matches("\\s*\\[安静\\]\\s*") || t.matches("\\s*（安静）\\s*")) return "";
    return t;
  }
}

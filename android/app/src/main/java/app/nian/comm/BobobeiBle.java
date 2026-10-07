package app.nian.comm;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 啵啵贝 Pro（广播名 SOSEXY）BLE 网关。
 * 帧格式与社区公开协议一致：吮吸 07/08、震动 01/02、微电 03/04。
 */
final class BobobeiBle {
  private static final String TAG = "NianToy";
  private static final String PREF = "nian_toy";
  private static final String KEY_ADDR = "last_addr";
  private static final String KEY_NAME = "last_name";

  private static final UUID SVC = UUID.fromString("0000ee01-0000-1000-8000-00805f9b34fb");
  private static final UUID WRITE = UUID.fromString("0000ee03-0000-1000-8000-00805f9b34fb");
  private static final UUID NOTIFY = UUID.fromString("0000ee02-0000-1000-8000-00805f9b34fb");
  private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
  private static final UUID BAT_SVC = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb");
  private static final UUID BAT_CHAR = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb");

  private static final String[] TARGET_NAMES = { "SOSEXY", "SOSEXY Pro", "Bubblebei", "啵啵贝" };

  private static volatile BobobeiBle inst;

  static BobobeiBle get(Context ctx) {
    if (inst == null) {
      synchronized (BobobeiBle.class) {
        if (inst == null) inst = new BobobeiBle(ctx.getApplicationContext());
      }
    }
    return inst;
  }

  static void warmStart(Context ctx) {
    if (ctx == null) return;
    BobobeiBle b = get(ctx);
    if (!b.hasSavedAddress()) return;
    try { KeepAliveService.start(ctx); } catch (Exception ignored) {}
    b.connectSaved();
  }

  static boolean wantsConnectedDevice() {
    BobobeiBle b = inst;
    return b != null && (b.connected || b.ready || b.hasSavedAddress());
  }

  static JSONObject snapshotJson(Context ctx) {
    try {
      return get(ctx).snapshot();
    } catch (Exception e) {
      JSONObject o = new JSONObject();
      try { o.put("ok", false); o.put("error", e.getMessage()); } catch (Exception ignored) {}
      return o;
    }
  }

  interface ScanDone {
    void onDone(JSONArray devices);
  }

  interface Done {
    void onDone(JSONObject status);
  }

  private final Context app;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final SharedPreferences prefs;
  private final BluetoothAdapter adapter;

  private volatile BluetoothGatt gatt;
  private volatile BluetoothGattCharacteristic writeChar;
  private volatile boolean connected;
  private volatile boolean connecting;
  private volatile boolean ready;
  private volatile boolean scanning;
  private volatile String phase = "idle";
  private volatile String error = "";
  private volatile int suction;
  private volatile int vibration;
  private volatile int electric;
  private volatile int battery = -1;
  private volatile String lastAddr = "";
  private volatile String lastName = "";

  private final ConcurrentHashMap<String, JSONObject> found = new ConcurrentHashMap<>();
  private final ConcurrentLinkedQueue<byte[]> writeQ = new ConcurrentLinkedQueue<>();
  private volatile boolean writeBusy;
  private Runnable writeTimeout;
  private Runnable scanTimeout;
  private Runnable durationTask;
  private Runnable rampTask;
  private static final int RAMP_TICK_MS = 100;
  private static final double DEFAULT_RAMP_SEC = 2.0;
  private Runnable keepaliveTask;
  private ScanCallback scanCb;
  private final List<ScanDone> scanWaiters = new CopyOnWriteArrayList<>();

  private BobobeiBle(Context ctx) {
    app = ctx.getApplicationContext();
    prefs = app.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    lastAddr = prefs.getString(KEY_ADDR, "");
    lastName = prefs.getString(KEY_NAME, "");
    BluetoothManager bm = (BluetoothManager) app.getSystemService(Context.BLUETOOTH_SERVICE);
    adapter = bm != null ? bm.getAdapter() : BluetoothAdapter.getDefaultAdapter();
  }

  boolean hasSavedAddress() {
    return lastAddr != null && !lastAddr.isEmpty();
  }

  JSONObject snapshot() {
    JSONObject o = new JSONObject();
    try {
      o.put("ok", true);
      o.put("connected", connected);
      o.put("ready", ready);
      o.put("connecting", connecting);
      o.put("scanning", scanning);
      o.put("phase", phase == null ? "" : phase);
      o.put("error", error == null ? "" : error);
      o.put("name", lastName == null ? "" : lastName);
      o.put("address", lastAddr == null ? "" : lastAddr);
      o.put("suction", suction);
      o.put("vibration", vibration);
      o.put("electric", electric);
      o.put("battery", battery);
      JSONArray arr = new JSONArray();
      for (JSONObject d : found.values()) arr.put(d);
      o.put("devices", arr);
    } catch (Exception ignored) {}
    return o;
  }

  void scan(int ms, ScanDone cb) {
    if (cb != null) scanWaiters.add(cb);
    handler.post(() -> startScan(ms));
  }

  void connect(String address, String name, Done cb) {
    handler.post(() -> {
      connectAddr(address, name);
      if (cb == null) return;
      handler.postDelayed(() -> cb.onDone(snapshot()), 7000);
    });
  }

  void connectSaved() {
    if (!hasSavedAddress()) return;
    handler.post(() -> connectAddr(lastAddr, lastName));
  }

  void disconnect() {
    handler.post(this::disconnectNow);
  }

  JSONObject apply(JSONObject cmd) {
    final String action = cmd != null ? cmd.optString("action", "set") : "status";
    if ("status".equals(action)) return snapshot();
    final JSONArray steps = cmd != null ? cmd.optJSONArray("steps") : null;
    if (steps != null && steps.length() > 0) {
      final JSONArray seq = steps;
      handler.post(() -> startSequence(seq));
      try { Thread.sleep(280); } catch (InterruptedException ignored) {}
      return snapshot();
    }
    final int[] next = mergeLevels(cmd, "stop".equals(action));
    final int durMs = (int) Math.round(Math.max(0, cmd != null ? cmd.optDouble("duration", 0) : 0) * 1000);
    final int rampMs = rampMsOf(cmd, "stop".equals(action) ? 0 : DEFAULT_RAMP_SEC);
    handler.post(() -> {
      cancelTimed();
      goToLevels(next[0], next[1], next[2], rampMs, () -> {
        if (durMs > 0 && !"stop".equals(action)) {
          durationTask = () -> goToLevels(0, 0, 0, 0, null);
          handler.postDelayed(durationTask, durMs);
        }
      });
    });
    try { Thread.sleep(280); } catch (InterruptedException ignored) {}
    return snapshot();
  }

  private void cancelTimed() {
    if (durationTask != null) handler.removeCallbacks(durationTask);
    durationTask = null;
    if (rampTask != null) handler.removeCallbacks(rampTask);
    rampTask = null;
  }

  private int rampMsOf(JSONObject o, double fallbackSec) {
    if (o == null) return (int) Math.round(Math.max(0, fallbackSec) * 1000);
    double sec = o.has("ramp") ? o.optDouble("ramp", fallbackSec) : fallbackSec;
    if (!Double.isFinite(sec) || sec < 0) sec = fallbackSec;
    if (sec > 30) sec = 30;
    return (int) Math.round(sec * 1000);
  }

  /** 线性缓滑到目标档；rampMs=0 立刻到位。到位后跑 afterArrive（可为 null）。 */
  private void goToLevels(int s, int v, int e, int rampMs, Runnable afterArrive) {
    final int toS = clamp(s);
    final int toV = clamp(v);
    final int toE = clamp(e);
    final boolean allOff = toS <= 0 && toV <= 0 && toE <= 0;
    if (rampMs <= 0) {
      setLevels(toS, toV, toE, allOff);
      if (afterArrive != null) afterArrive.run();
      return;
    }
    final int fromS = suction;
    final int fromV = vibration;
    final int fromE = electric;
    if (fromS == toS && fromV == toV && fromE == toE) {
      if (afterArrive != null) afterArrive.run();
      return;
    }
    if (rampTask != null) handler.removeCallbacks(rampTask);
    final long start = SystemClock.uptimeMillis();
    final int total = Math.max(RAMP_TICK_MS, rampMs);
    rampTask = new Runnable() {
      @Override
      public void run() {
        long elapsed = SystemClock.uptimeMillis() - start;
        float t = Math.min(1f, elapsed / (float) total);
        int ns = Math.round(fromS + (toS - fromS) * t);
        int nv = Math.round(fromV + (toV - fromV) * t);
        int ne = Math.round(fromE + (toE - fromE) * t);
        setLevels(ns, nv, ne, false);
        if (t >= 1f) {
          rampTask = null;
          setLevels(toS, toV, toE, allOff);
          if (afterArrive != null) afterArrive.run();
        } else {
          handler.postDelayed(this, RAMP_TICK_MS);
        }
      }
    };
    handler.post(rampTask);
  }

  /** 按 steps 时间线：先缓滑到本段，稳住 duration，再下一段；末段 duration 后全停。 */
  private void startSequence(JSONArray steps) {
    cancelTimed();
    if (steps == null || steps.length() == 0) return;
    runSequenceStep(steps, 0, suction, vibration, electric);
  }

  private void runSequenceStep(JSONArray steps, int index, int baseS, int baseV, int baseE) {
    if (steps == null || index < 0 || index >= steps.length()) return;
    JSONObject step = steps.optJSONObject(index);
    if (step == null) {
      runSequenceStep(steps, index + 1, baseS, baseV, baseE);
      return;
    }
    final int s = step.has("suction") ? clamp(step.optInt("suction", baseS)) : baseS;
    final int v = step.has("vibration") ? clamp(step.optInt("vibration", baseV)) : baseV;
    final int e = step.has("electric") ? clamp(step.optInt("electric", baseE)) : baseE;
    final int rampMs = rampMsOf(step, DEFAULT_RAMP_SEC);
    final int durMs = (int) Math.round(Math.min(120, Math.max(0, step.optDouble("duration", 0))) * 1000);
    final boolean last = index >= steps.length() - 1;
    goToLevels(s, v, e, rampMs, () -> {
      if (!last) {
        final int nextIndex = index + 1;
        final Runnable next = () -> runSequenceStep(steps, nextIndex, s, v, e);
        if (durMs > 0) {
          durationTask = next;
          handler.postDelayed(durationTask, durMs);
        } else {
          handler.post(next);
        }
        return;
      }
      if (durMs > 0 && !(s <= 0 && v <= 0 && e <= 0)) {
        durationTask = () -> goToLevels(0, 0, 0, 0, null);
        handler.postDelayed(durationTask, durMs);
      }
    });
  }

  private int[] mergeLevels(JSONObject cmd, boolean stop) {
    if (stop || cmd == null) return new int[] { 0, 0, 0 };
    int s = cmd.has("suction") ? clamp(cmd.optInt("suction", suction)) : suction;
    int v = cmd.has("vibration") ? clamp(cmd.optInt("vibration", vibration)) : vibration;
    int e = cmd.has("electric") ? clamp(cmd.optInt("electric", electric)) : electric;
    return new int[] { s, v, e };
  }

  @SuppressLint("MissingPermission")
  private void startScan(int ms) {
    if (adapter == null || !adapter.isEnabled()) {
      phase = "bt_off";
      error = "bluetooth_off";
      finishScan();
      return;
    }
    if (scanning) return;
    found.clear();
    scanning = true;
    phase = "scanning";
    error = "";
    BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
    if (scanner == null) {
      scanning = false;
      phase = "no_scanner";
      error = "no_scanner";
      finishScan();
      return;
    }
    scanCb = new ScanCallback() {
      @Override
      public void onScanResult(int callbackType, ScanResult result) {
        if (result == null || result.getDevice() == null) return;
        BluetoothDevice d = result.getDevice();
        String addr = d.getAddress();
        if (addr == null || addr.isEmpty()) return;
        String name = d.getName();
        if ((name == null || name.isEmpty()) && result.getScanRecord() != null) {
          name = result.getScanRecord().getDeviceName();
        }
        if (name == null) name = "";
        boolean target = isTargetName(name);
        try {
          JSONObject o = new JSONObject();
          o.put("name", name.isEmpty() ? "(未命名)" : name);
          o.put("address", addr);
          o.put("rssi", result.getRssi());
          o.put("target", target);
          found.put(addr, o);
        } catch (Exception ignored) {}
      }

      @Override
      public void onScanFailed(int errorCode) {
        scanning = false;
        error = "scan_" + errorCode;
        phase = "scan_failed";
        finishScan();
      }
    };
    try {
      scanner.startScan(scanCb);
    } catch (Exception e) {
      scanning = false;
      error = e.getMessage() == null ? "scan_failed" : e.getMessage();
      phase = "scan_failed";
      finishScan();
      return;
    }
    if (scanTimeout != null) handler.removeCallbacks(scanTimeout);
    scanTimeout = this::stopScan;
    handler.postDelayed(scanTimeout, Math.max(3000, ms));
  }

  @SuppressLint("MissingPermission")
  private void stopScan() {
    if (scanTimeout != null) {
      handler.removeCallbacks(scanTimeout);
      scanTimeout = null;
    }
    if (!scanning) {
      finishScan();
      return;
    }
    scanning = false;
    try {
      BluetoothLeScanner scanner = adapter != null ? adapter.getBluetoothLeScanner() : null;
      if (scanner != null && scanCb != null) scanner.stopScan(scanCb);
    } catch (Exception ignored) {}
    if ("scanning".equals(phase)) phase = found.isEmpty() ? "no_devices" : "scanned";
    finishScan();
  }

  private void finishScan() {
    JSONArray arr = new JSONArray();
    List<JSONObject> list = new ArrayList<>(found.values());
    list.sort((a, b) -> {
      boolean ta = a.optBoolean("target");
      boolean tb = b.optBoolean("target");
      if (ta != tb) return ta ? -1 : 1;
      return b.optInt("rssi") - a.optInt("rssi");
    });
    for (JSONObject d : list) arr.put(d);
    for (ScanDone cb : scanWaiters) {
      try { cb.onDone(arr); } catch (Exception ignored) {}
    }
    scanWaiters.clear();
  }

  @SuppressLint("MissingPermission")
  private void connectAddr(String address, String name) {
    String addr = address == null ? "" : address.trim();
    if (addr.isEmpty()) {
      error = "no_address";
      phase = "idle";
      return;
    }
    if (adapter == null || !adapter.isEnabled()) {
      error = "bluetooth_off";
      phase = "bt_off";
      return;
    }
    lastAddr = addr;
    if (name != null && !name.trim().isEmpty()) lastName = name.trim();
    prefs.edit().putString(KEY_ADDR, lastAddr).putString(KEY_NAME, lastName).apply();
    try { KeepAliveService.start(app); } catch (Exception ignored) {}
    stopScan();
    disconnectGattOnly();
    connecting = true;
    connected = false;
    ready = false;
    phase = "connecting";
    error = "";
    BluetoothDevice device;
    try {
      device = adapter.getRemoteDevice(addr);
    } catch (Exception e) {
      connecting = false;
      error = "bad_address";
      phase = "idle";
      return;
    }
    BluetoothGattCallback cb = new BluetoothGattCallback() {
      @Override
      public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
        if (newState == BluetoothProfile.STATE_CONNECTED) {
          connected = true;
          connecting = false;
          phase = "discovering";
          handler.post(() -> {
            try { g.discoverServices(); } catch (Exception ignored) {}
          });
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
          connected = false;
          connecting = false;
          ready = false;
          writeChar = null;
          phase = "disconnected";
          KeepAliveService.refreshForeground(app);
          handler.postDelayed(() -> {
            if (!connected && hasSavedAddress()) connectSaved();
          }, 4000);
        }
      }

      @Override
      public void onServicesDiscovered(BluetoothGatt g, int status) {
        if (status != BluetoothGatt.GATT_SUCCESS) {
          error = "discover_failed";
          phase = "discover_failed";
          return;
        }
        BluetoothGattService svc = g.getService(SVC);
        if (svc == null) {
          error = "not_bobobei";
          phase = "wrong_device";
          return;
        }
        writeChar = svc.getCharacteristic(WRITE);
        BluetoothGattCharacteristic notify = svc.getCharacteristic(NOTIFY);
        if (writeChar == null) {
          error = "no_write";
          phase = "wrong_device";
          return;
        }
        if (notify != null) enableNotify(g, notify);
        BluetoothGattService batSvc = g.getService(BAT_SVC);
        if (batSvc != null) {
          BluetoothGattCharacteristic bat = batSvc.getCharacteristic(BAT_CHAR);
          if (bat != null) {
            try { g.readCharacteristic(bat); } catch (Exception ignored) {}
            enableNotify(g, bat);
          }
        }
        handler.postDelayed(() -> {
          enqueueFrame(initFrame());
          handler.postDelayed(() -> {
            ready = connected && writeChar != null;
            phase = ready ? "ready" : "not_ready";
            KeepAliveService.refreshForeground(app);
            startKeepalive();
            new Thread(() -> {
              try { PhoneHttp.post(app, "/api/phone/toy", snapshot().toString()); } catch (Exception ignored) {}
            }, "nian-toy-up").start();
          }, 1800);
        }, 400);
      }

      @Override
      public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
        byte[] v = c.getValue();
        if (v != null && v.length > 0 && BAT_CHAR.equals(c.getUuid())) {
          battery = v[0] & 0xFF;
        }
      }

      @Override
      public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
        if (value != null && value.length > 0 && BAT_CHAR.equals(c.getUuid())) {
          battery = value[0] & 0xFF;
        }
      }

      @Override
      public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
        if (status == BluetoothGatt.GATT_SUCCESS && BAT_CHAR.equals(c.getUuid())) {
          byte[] v = c.getValue();
          if (v != null && v.length > 0) battery = v[0] & 0xFF;
        }
      }

      @Override
      public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
        onWriteDone();
      }
    };
    try {
      if (Build.VERSION.SDK_INT >= 23) {
        gatt = device.connectGatt(app, true, cb, BluetoothDevice.TRANSPORT_LE);
      } else {
        gatt = device.connectGatt(app, true, cb);
      }
    } catch (Exception e) {
      connecting = false;
      error = e.getMessage() == null ? "connect_failed" : e.getMessage();
      phase = "connect_failed";
    }
  }

  @SuppressLint("MissingPermission")
  private void enableNotify(BluetoothGatt g, BluetoothGattCharacteristic c) {
    try {
      g.setCharacteristicNotification(c, true);
      BluetoothGattDescriptor d = c.getDescriptor(CCCD);
      if (d != null) {
        d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        g.writeDescriptor(d);
      }
    } catch (Exception ignored) {}
  }

  private void setLevels(int s, int v, int e, boolean all) {
    int ns = clamp(s);
    int nv = clamp(v);
    int ne = clamp(e);
    boolean sendS = all || ns != suction;
    boolean sendV = all || nv != vibration;
    boolean sendE = all || ne != electric;
    suction = ns;
    vibration = nv;
    electric = ne;
    if (!ready || writeChar == null) {
      error = connected ? "not_ready" : "not_connected";
      return;
    }
    error = "";
    if (sendS) enqueueFrame(ctrlFrame(0x07, ns, 0x08));
    if (sendV) enqueueFrame(ctrlFrame(0x01, nv, 0x02));
    if (sendE) enqueueFrame(ctrlFrame(0x03, ne, 0x04));
  }

  private void startKeepalive() {
    if (keepaliveTask != null) handler.removeCallbacks(keepaliveTask);
    keepaliveTask = new Runnable() {
      @Override
      public void run() {
        if (!connected || gatt == null) return;
        try { gatt.readRemoteRssi(); } catch (Exception ignored) {}
        handler.postDelayed(this, 30000);
      }
    };
    handler.postDelayed(keepaliveTask, 30000);
  }

  private void disconnectNow() {
    lastAddr = "";
    lastName = "";
    prefs.edit().remove(KEY_ADDR).remove(KEY_NAME).apply();
    suction = 0;
    vibration = 0;
    electric = 0;
    if (ready) setLevels(0, 0, 0, true);
    handler.postDelayed(this::disconnectGattOnly, 200);
    phase = "idle";
    error = "";
    KeepAliveService.refreshForeground(app);
  }

  @SuppressLint("MissingPermission")
  private void disconnectGattOnly() {
    if (keepaliveTask != null) handler.removeCallbacks(keepaliveTask);
    keepaliveTask = null;
    if (durationTask != null) handler.removeCallbacks(durationTask);
    durationTask = null;
    if (rampTask != null) handler.removeCallbacks(rampTask);
    rampTask = null;
    writeQ.clear();
    writeBusy = false;
    ready = false;
    connected = false;
    connecting = false;
    writeChar = null;
    try {
      if (gatt != null) {
        gatt.disconnect();
        gatt.close();
      }
    } catch (Exception ignored) {}
    gatt = null;
  }

  private void enqueueFrame(byte[] frame) {
    if (frame == null) return;
    writeQ.offer(frame);
    if (!writeBusy) dequeueWrite();
  }

  @SuppressLint("MissingPermission")
  private void dequeueWrite() {
    if (!connected || writeChar == null || gatt == null) {
      writeQ.clear();
      writeBusy = false;
      return;
    }
    byte[] frame = writeQ.poll();
    if (frame == null) {
      writeBusy = false;
      return;
    }
    writeBusy = true;
    boolean ok = false;
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        int r = gatt.writeCharacteristic(writeChar, frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        ok = r == BluetoothGatt.GATT_SUCCESS;
      } else {
        writeChar.setValue(frame);
        writeChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        ok = gatt.writeCharacteristic(writeChar);
      }
    } catch (Exception e) {
      Log.w(TAG, "write", e);
    }
    if (!ok) {
      writeQ.offer(frame);
      writeBusy = false;
      handler.postDelayed(this::dequeueWrite, 80);
      return;
    }
    if (writeTimeout != null) handler.removeCallbacks(writeTimeout);
    writeTimeout = this::onWriteDone;
    handler.postDelayed(writeTimeout, 2500);
  }

  private void onWriteDone() {
    if (writeTimeout != null) handler.removeCallbacks(writeTimeout);
    writeTimeout = null;
    writeBusy = false;
    handler.postDelayed(this::dequeueWrite, 60);
  }

  private static byte[] initFrame() {
    return new byte[] {
      (byte) rnd(), 0x01, 0x00, 0x01, 0x00, (byte) 0xC8, 0x11, 0x01
    };
  }

  private static byte[] ctrlFrame(int mode1, int intensity, int mode2) {
    return new byte[] {
      (byte) rnd(), 0x01, 0x00, 0x02, 0x00,
      (byte) mode1, 0x11, (byte) clamp(intensity), 0x00,
      (byte) mode2, 0x11, 0x01
    };
  }

  private static int rnd() {
    return (int) (Math.random() * 256);
  }

  private static int clamp(int v) {
    if (v < 0) return 0;
    if (v > 100) return 100;
    return v;
  }

  private static boolean isTargetName(String name) {
    if (name == null || name.isEmpty()) return false;
    String n = name.toUpperCase(Locale.ROOT);
    for (String t : TARGET_NAMES) {
      if (n.contains(t.toUpperCase(Locale.ROOT))) return true;
    }
    return false;
  }
}

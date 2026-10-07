package app.nian.comm

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Looper
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.feature.ExperimentalFeatureAvailabilityApi
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

/** 系统「健康数据共享」。三星健康等 App 写入后，念才能读到步数/睡眠/心率。 */
object HealthConnectBridge {
  private const val TIMEOUT_MS = 12000L
  private const val CACHE_MS = 45_000L
  private const val TYPE_MS = 3500L
  private var cache: JSONObject? = null
  private var cacheAt = 0L

  @JvmStatic
  fun permissions(): Set<String> = permissions(null)

  @JvmStatic
  fun permissions(ctx: Context?): Set<String> {
    val set = corePermissions()
    addFeaturePerms(ctx, set)
    return set
  }

  private fun corePermissions(): MutableSet<String> = linkedSetOf(
    HealthPermission.getReadPermission(StepsRecord::class),
    HealthPermission.getReadPermission(SleepSessionRecord::class),
    HealthPermission.getReadPermission(HeartRateRecord::class),
    HealthPermission.getReadPermission(RestingHeartRateRecord::class),
    HealthPermission.getReadPermission(DistanceRecord::class),
    HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
    HealthPermission.getReadPermission(OxygenSaturationRecord::class),
    HealthPermission.getReadPermission(ExerciseSessionRecord::class),
  )

  @OptIn(ExperimentalFeatureAvailabilityApi::class)
  private fun addFeaturePerms(ctx: Context?, set: MutableSet<String>) {
    if (ctx == null || !available(ctx)) return
    try {
      val features = HealthConnectClient.getOrCreate(ctx).features
      if (features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND)
        == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
      ) {
        set.add(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
      }
      if (features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY)
        == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
      ) {
        set.add(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
      }
    } catch (_: Throwable) {}
  }

  @JvmStatic
  fun sdkCode(ctx: Context): Int {
    if (Build.VERSION.SDK_INT < 26) return HealthConnectClient.SDK_UNAVAILABLE
    return try {
      HealthConnectClient.getSdkStatus(ctx)
    } catch (_: Throwable) {
      HealthConnectClient.SDK_UNAVAILABLE
    }
  }

  @JvmStatic
  fun statusName(ctx: Context): String {
    return when (sdkCode(ctx)) {
      HealthConnectClient.SDK_AVAILABLE -> "available"
      HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update"
      else -> "missing"
    }
  }

  @JvmStatic
  fun available(ctx: Context): Boolean = sdkCode(ctx) == HealthConnectClient.SDK_AVAILABLE

  @JvmStatic
  fun permissionIntent(ctx: Context): Intent {
    val contract = androidx.health.connect.client.PermissionController
      .createRequestPermissionResultContract()
    return try {
      contract.createIntent(ctx, permissions(ctx))
    } catch (_: Throwable) {
      contract.createIntent(ctx, corePermissions())
    }
  }

  @JvmStatic
  fun invalidate() {
    cache = null
    cacheAt = 0L
  }

  @JvmStatic
  fun settingsIntent(): Intent {
    return Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  @JvmStatic
  fun merge(ctx: Context, into: JSONObject) {
    try {
      val extra = snapshot(ctx)
      val keys = extra.keys()
      while (keys.hasNext()) {
        val k = keys.next()
        into.put(k, extra.get(k))
      }
    } catch (_: Throwable) {
      try {
        into.put("connectAvailable", false)
        into.put("connectStatus", "missing")
        into.put("connectGranted", false)
      } catch (_: Throwable) {}
    }
  }

  @JvmStatic
  fun snapshot(ctx: Context): JSONObject {
    val now = System.currentTimeMillis()
    val hit = cache
    if (hit != null && now - cacheAt < CACHE_MS) return copy(hit)
    if (Looper.myLooper() == Looper.getMainLooper()) {
      Thread({ snapshot(ctx.applicationContext) }, "nian-health").start()
      // 主线程不能 runBlocking。没缓存时不要回「未授权」空壳，免得把后端刚写上的心率冲掉。
      return if (hit != null) copy(hit) else JSONObject()
    }
    val fresh = readNow(ctx)
    val kept = preserveVitals(hit, fresh)
    cache = kept
    cacheAt = now
    return copy(kept)
  }

  @Volatile private var lastGranted = false

  @JvmStatic
  fun grantedLight(ctx: Context): Boolean {
    val hit = cache
    if (hit != null) {
      lastGranted = hit.optBoolean("connectGranted")
      return lastGranted
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      Thread({ snapshot(ctx.applicationContext) }, "nian-health").start()
      return lastGranted
    }
    if (!available(ctx)) return false
    return try {
      runBlocking {
        withTimeout(2500) {
          val client = HealthConnectClient.getOrCreate(ctx)
          val got = client.permissionController.getGrantedPermissions()
          val ok = permissions(ctx).any { it in got }
          lastGranted = ok
          ok
        }
      }
    } catch (_: Throwable) {
      false
    }
  }

  private fun readNow(ctx: Context): JSONObject {
    val o = JSONObject()
    val status = statusName(ctx)
    o.put("connectStatus", status)
    o.put("connectAvailable", status == "available")
    o.put("connectGranted", false)
    if (status != "available") return o
    return try {
      runBlocking {
        withTimeout(TIMEOUT_MS) {
          fill(ctx, o)
          o
        }
      }
    } catch (e: Throwable) {
      try { o.put("connectError", e.message ?: "read_failed") } catch (_: Throwable) {}
      o
    }
  }

  /** 新读失败时不要把上一份心率/睡眠冲掉。 */
  private fun preserveVitals(old: JSONObject?, fresh: JSONObject): JSONObject {
    if (old == null) return fresh
    if (!fresh.optBoolean("connectGranted") && old.optBoolean("connectGranted")) {
      if (!fresh.has("connectError")) return fresh
      val kept = copy(old)
      try { kept.put("connectError", fresh.optString("connectError")) } catch (_: Throwable) {}
      return kept
    }
    val keys = arrayOf(
      "heartRateBpm", "heartRateMin", "heartRateMax", "heartRateAtMs", "heartRateSource",
      "sleepMinutes", "spo2Percent", "distanceMeters", "caloriesKcal",
      "exerciseCount", "exerciseMinutes", "exerciseTitle", "connectSteps",
    )
    for (k in keys) {
      if (!fresh.has(k) && old.has(k)) {
        if (k.startsWith("heartRate") && fresh.has("heartRateGranted") && !fresh.optBoolean("heartRateGranted")) continue
        try { fresh.put(k, old.get(k)) } catch (_: Throwable) {}
      }
    }
    return fresh
  }

  private suspend fun fill(ctx: Context, o: JSONObject) {
    val client = HealthConnectClient.getOrCreate(ctx)
    val granted = client.permissionController.getGrantedPermissions()
    val want = permissions(ctx)
    val any = want.any { it in granted }
    val hrPerm = HealthPermission.getReadPermission(HeartRateRecord::class) in granted
      || HealthPermission.getReadPermission(RestingHeartRateRecord::class) in granted
    lastGranted = any
    o.put("connectGranted", any)
    o.put("heartRateGranted", hrPerm)
    val bgWanted = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in want
    o.put(
      "backgroundGranted",
      !bgWanted || HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in granted
    )
    if (!any) return

    val zone = ZoneId.systemDefault()
    val todayStart = ZonedDateTime.now(zone).toLocalDate().atStartOfDay(zone).toInstant()
    val end = Instant.now()
    val sleepStart = todayStart.minus(Duration.ofHours(36))

    quietly {
      if (HealthPermission.getReadPermission(StepsRecord::class) in granted) {
        putLong(
          o, "connectSteps",
          aggregateLong(client, setOf(StepsRecord.COUNT_TOTAL), todayStart, end, StepsRecord.COUNT_TOTAL)
        )
      }
    }
    quietly {
      if (hrPerm) fillHeartRate(client, o, end, granted)
    }
    quietly {
      if (HealthPermission.getReadPermission(SleepSessionRecord::class) in granted) {
        val sleepMin = sleepMinutes(client, sleepStart, end)
        if (sleepMin != null) o.put("sleepMinutes", sleepMin)
      }
    }
    quietly {
      if (HealthPermission.getReadPermission(DistanceRecord::class) in granted) {
        val meters = aggregateDistance(client, todayStart, end)
        if (meters != null) o.put("distanceMeters", Math.round(meters))
      }
    }
    quietly {
      if (HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class) in granted) {
        val kcal = aggregateCalories(client, todayStart, end)
        if (kcal != null) o.put("caloriesKcal", Math.round(kcal))
      }
    }
    quietly {
      if (HealthPermission.getReadPermission(OxygenSaturationRecord::class) in granted) {
        fillSpo2(client, o, end.minus(Duration.ofDays(2)), end)
      }
    }
    quietly {
      if (HealthPermission.getReadPermission(ExerciseSessionRecord::class) in granted) {
        fillExercise(client, o, todayStart, end)
      }
    }
  }

  private suspend fun quietly(block: suspend () -> Unit) {
    try {
      withTimeout(TYPE_MS) { block() }
    } catch (e: CancellationException) {
      if (e is TimeoutCancellationException) return
      throw e
    } catch (_: Throwable) {}
  }

  private suspend fun fillHeartRate(
    client: HealthConnectClient,
    o: JSONObject,
    end: Instant,
    granted: Set<String>,
  ) {
    var bpm: Long? = null
    var min: Long? = null
    var max: Long? = null
    var source = ""
    var atMs = 0L
    if (HealthPermission.getReadPermission(HeartRateRecord::class) in granted) {
      // 手表常把一整天心率塞进一条记录，readRecords(80) 会超时，只剩计步。
      // 短窗口聚合不搬原始采样，三星上更稳。
      val windows = arrayOf(
        Duration.ofMinutes(10) to "latest",
        Duration.ofHours(2) to "avg",
        Duration.ofHours(24) to "avg",
      )
      for ((dur, src) in windows) {
        val start = end.minus(dur)
        val avg = aggregateLong(
          client, setOf(HeartRateRecord.BPM_AVG), start, end, HeartRateRecord.BPM_AVG
        )
        if (avg != null && avg in 20..250) {
          bpm = avg
          min = aggregateLong(client, setOf(HeartRateRecord.BPM_MIN), start, end, HeartRateRecord.BPM_MIN)
          max = aggregateLong(client, setOf(HeartRateRecord.BPM_MAX), start, end, HeartRateRecord.BPM_MAX)
          source = src
          if (src == "latest") atMs = end.toEpochMilli()
          break
        }
      }
      if (bpm == null) {
        val sample = latestHeartRateSamples(client, end.minus(Duration.ofHours(6)), end)
        if (sample != null) {
          bpm = sample[0]
          min = sample[1]
          max = sample[2]
          source = "latest"
          if (sample.size >= 4 && sample[3] > 0) atMs = sample[3]
        }
      }
    }
    if (bpm == null && HealthPermission.getReadPermission(RestingHeartRateRecord::class) in granted) {
      val rest = latestRestingBpm(client, end.minus(Duration.ofDays(7)), end)
      if (rest != null) {
        bpm = rest
        source = "resting"
      }
    }
    putLong(o, "heartRateBpm", bpm)
    putLong(o, "heartRateMin", min)
    putLong(o, "heartRateMax", max)
    if (atMs > 0) o.put("heartRateAtMs", atMs)
    if (source.isNotEmpty()) o.put("heartRateSource", source)
  }

  private suspend fun latestHeartRateSamples(
    client: HealthConnectClient,
    start: Instant,
    end: Instant,
  ): LongArray? {
    return try {
      val res = client.readRecords(
        ReadRecordsRequest(
          recordType = HeartRateRecord::class,
          timeRangeFilter = TimeRangeFilter.between(start, end),
          ascendingOrder = false,
          pageSize = 1,
        )
      )
      val rec = res.records.firstOrNull() ?: return null
      // 整天一条记录时只看末尾，避免扫几万个采样。
      val slice = rec.samples.takeLast(40)
      var last: Long? = null
      var lastTime = Instant.EPOCH
      var lo = Long.MAX_VALUE
      var hi = Long.MIN_VALUE
      for (s in slice) {
        val v = s.beatsPerMinute
        if (v < 20 || v > 250) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
        if (s.time.isAfter(lastTime)) {
          lastTime = s.time
          last = v
        }
      }
      val bpm = last ?: return null
      longArrayOf(
        bpm,
        if (lo == Long.MAX_VALUE) bpm else lo,
        if (hi == Long.MIN_VALUE) bpm else hi,
        lastTime.toEpochMilli(),
      )
    } catch (_: Throwable) {
      null
    }
  }

  private suspend fun fillSpo2(
    client: HealthConnectClient,
    o: JSONObject,
    start: Instant,
    end: Instant,
  ) {
    try {
      val res = client.readRecords(
        ReadRecordsRequest(
          recordType = OxygenSaturationRecord::class,
          timeRangeFilter = TimeRangeFilter.between(start, end),
          ascendingOrder = false,
          pageSize = 8,
        )
      )
      val last = res.records.maxByOrNull { it.time } ?: return
      val pct = last.percentage.value
      if (pct >= 50 && pct <= 100) o.put("spo2Percent", Math.round(pct))
    } catch (_: Throwable) {}
  }

  private suspend fun fillExercise(
    client: HealthConnectClient,
    o: JSONObject,
    start: Instant,
    end: Instant,
  ) {
    try {
      val res = client.readRecords(
        ReadRecordsRequest(
          recordType = ExerciseSessionRecord::class,
          timeRangeFilter = TimeRangeFilter.between(start, end),
          ascendingOrder = false,
          pageSize = 12,
        )
      )
      if (res.records.isEmpty()) return
      o.put("exerciseCount", res.records.size)
      var ms = 0L
      var title = ""
      var latest = Instant.EPOCH
      for (rec in res.records) {
        val a = rec.startTime.toEpochMilli()
        val b = rec.endTime.toEpochMilli()
        if (b > a) ms += (b - a)
        if (rec.startTime.isAfter(latest)) {
          latest = rec.startTime
          val t = rec.title?.trim().orEmpty()
          title = t.ifEmpty { "运动" }
        }
      }
      if (ms > 0) o.put("exerciseMinutes", Math.max(1, Math.round(ms / 60000.0).toInt()))
      if (title.isNotEmpty()) o.put("exerciseTitle", title.take(40))
    } catch (_: Throwable) {}
  }

  private suspend fun latestRestingBpm(
    client: HealthConnectClient,
    start: Instant,
    end: Instant,
  ): Long? {
    return try {
      val res = client.readRecords(
        ReadRecordsRequest(
          recordType = RestingHeartRateRecord::class,
          timeRangeFilter = TimeRangeFilter.between(start, end),
          ascendingOrder = false,
          pageSize = 8,
        )
      )
      res.records.maxByOrNull { it.time }?.beatsPerMinute
    } catch (_: Throwable) {
      null
    }
  }

  private suspend fun aggregateLong(
    client: HealthConnectClient,
    metrics: Set<androidx.health.connect.client.aggregate.AggregateMetric<Long>>,
    start: Instant,
    end: Instant,
    metric: androidx.health.connect.client.aggregate.AggregateMetric<Long>,
  ): Long? {
    return try {
      val res = client.aggregate(
        AggregateRequest(
          metrics = metrics,
          timeRangeFilter = TimeRangeFilter.between(start, end),
        )
      )
      res[metric]
    } catch (_: Throwable) {
      null
    }
  }

  private suspend fun aggregateDistance(
    client: HealthConnectClient,
    start: Instant,
    end: Instant,
  ): Double? {
    return try {
      val res = client.aggregate(
        AggregateRequest(
          metrics = setOf(DistanceRecord.DISTANCE_TOTAL),
          timeRangeFilter = TimeRangeFilter.between(start, end),
        )
      )
      res[DistanceRecord.DISTANCE_TOTAL]?.inMeters
    } catch (_: Throwable) {
      null
    }
  }

  private suspend fun aggregateCalories(
    client: HealthConnectClient,
    start: Instant,
    end: Instant,
  ): Double? {
    return try {
      val res = client.aggregate(
        AggregateRequest(
          metrics = setOf(TotalCaloriesBurnedRecord.ENERGY_TOTAL),
          timeRangeFilter = TimeRangeFilter.between(start, end),
        )
      )
      res[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.inKilocalories
    } catch (_: Throwable) {
      null
    }
  }

  private suspend fun sleepMinutes(
    client: HealthConnectClient,
    start: Instant,
    end: Instant,
  ): Int? {
    return try {
      val res = client.readRecords(
        ReadRecordsRequest(
          recordType = SleepSessionRecord::class,
          timeRangeFilter = TimeRangeFilter.between(start, end),
          pageSize = 20,
        )
      )
      var ms = 0L
      for (rec in res.records) {
        val a = rec.startTime.toEpochMilli()
        val b = rec.endTime.toEpochMilli()
        if (b > a) ms += (b - a)
      }
      if (ms <= 0) null else Math.max(1, Math.round(ms / 60000.0).toInt())
    } catch (_: Throwable) {
      null
    }
  }

  private fun putLong(o: JSONObject, key: String, value: Long?) {
    if (value == null) return
    o.put(key, value)
  }

  private fun copy(src: JSONObject): JSONObject {
    return try {
      JSONObject(src.toString())
    } catch (_: Throwable) {
      JSONObject()
    }
  }
}

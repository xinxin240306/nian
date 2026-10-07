"""Nian mic uplink: device listen start → buffer Opus → silence end → WAV → NIAN.

Triggered by:
  1. Device screen tap → firmware ToggleChatState → ``type:listen state:start``
  2. NIAN ``POST /tools/listen`` (phone / command queue)

Silence: after speech is detected, ``silence_ms`` (default 3000) of low energy
ends the capture; if never spoken, same silence window cancels without upload.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import struct
import wave
from typing import Any, Optional

logger = logging.getLogger(__name__)

SILENCE_MS_DEFAULT = 3000
MAX_DURATION_MS_DEFAULT = 30000
MIN_SPEECH_MS = 400
ENERGY_THRESHOLD = 350  # PCM16 RMS; quiet room ~50–150, speech much higher
POLL_S = 0.12
FRAME_MS = 60

_session_lock = asyncio.Lock()
_active: Optional["NianListenSession"] = None


def _nian_audio_endpoints() -> tuple[str, str, str]:
    vision = (os.getenv("VISION_URL") or "").strip().rstrip("/")
    base = ""
    if "/mcp/" in vision:
        base = vision.split("/mcp/", 1)[0]
    if not base:
        base = (os.getenv("NIAN_PUBLIC_URL") or os.getenv("PUBLIC_BASE_URL") or "").strip().rstrip("/")
    if not base:
        # Same host as vision fallback — operator should set VISION_URL
        base = "http://127.0.0.1:3000"
    return (
        f"{base}/mcp/audio/listening",
        f"{base}/mcp/audio/utterance",
        f"{base}/mcp/audio/listen-end",
    )


def _auth_headers() -> dict[str, str]:
    token = (
        os.getenv("VISION_TOKEN")
        or os.getenv("STACKCHAN_TOKEN")
        or os.getenv("BEARER_TOKEN")
        or ""
    ).strip()
    h = {"Accept": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
        h["X-Nian-Robot-Token"] = token
    return h


def _pcm_rms(pcm: bytes) -> float:
    if len(pcm) < 4:
        return 0.0
    n = len(pcm) // 2
    if n <= 0:
        return 0.0
    # Unpack as signed 16-bit little-endian
    fmt = "<" + "h" * n
    try:
        samples = struct.unpack(fmt, pcm[: n * 2])
    except struct.error:
        return 0.0
    acc = 0.0
    for s in samples:
        acc += float(s) * float(s)
    return (acc / n) ** 0.5


def _pcm_to_wav_bytes(pcm: bytes, sample_rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return buf.getvalue()


async def _post_json(url: str, payload: dict) -> None:
    import aiohttp

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                json=payload,
                headers=_auth_headers(),
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status >= 400:
                    text = await resp.text()
                    logger.warning("nian listen post %s -> %s %s", url, resp.status, text[:200])
    except Exception as e:
        logger.warning("nian listen post %s failed: %s", url, e)


async def _post_wav(url: str, wav_bytes: bytes, duration_ms: int) -> None:
    import aiohttp

    form = aiohttp.FormData()
    form.add_field(
        "file",
        wav_bytes,
        filename="robot-mic.wav",
        content_type="audio/wav",
    )
    form.add_field("duration", str(max(1, int(round(duration_ms / 1000.0)))))
    form.add_field("duration_ms", str(int(duration_ms)))
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                data=form,
                headers=_auth_headers(),
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status >= 400:
                    text = await resp.text()
                    logger.warning("nian utterance %s -> %s %s", url, resp.status, text[:200])
                else:
                    logger.info("nian utterance uploaded %d B duration_ms=%d", len(wav_bytes), duration_ms)
    except Exception as e:
        logger.warning("nian utterance upload failed: %s", e)


def _esp32_connection(gateway: Any) -> Any:
    esp = getattr(gateway, "esp32", None)
    if esp is None:
        return None
    return getattr(esp, "_connection", None) or getattr(esp, "connection", None)


async def _send_listen_state(gateway: Any, state: str, mode: str = "manual") -> None:
    esp = gateway.esp32
    if hasattr(esp, "send_listen_state"):
        await esp.send_listen_state(state, mode=mode)
        return
    conn = _esp32_connection(gateway)
    if conn is not None and hasattr(conn, "send_listen_state"):
        await conn.send_listen_state(state, mode=mode)
        return
    raise RuntimeError("esp32 send_listen_state missing")
    def __init__(
        self,
        gateway: Any,
        *,
        silence_ms: int = SILENCE_MS_DEFAULT,
        max_duration_ms: int = MAX_DURATION_MS_DEFAULT,
        device_already_listening: bool = False,
        source: str = "device",
    ):
        self.gateway = gateway
        self.silence_ms = max(500, min(10000, int(silence_ms)))
        self.max_duration_ms = max(3000, min(30000, int(max_duration_ms)))
        self.device_already_listening = device_already_listening
        self.source = source
        self._frames: list[bytes] = []
        self._task: Optional[asyncio.Task] = None
        self._stop_evt = asyncio.Event()
        self._notified = False
        self._end_reason = "ended"
        self._uploaded = False

    def on_opus_frame(self, data: bytes) -> None:
        if data:
            self._frames.append(data)

    async def _notify_listening(self, force: bool = False) -> None:
        if self._notified and not force:
            return
        listening_url, _, _ = _nian_audio_endpoints()
        self._notified = True
        asyncio.create_task(_post_json(listening_url, {"source": self.source}))

    async def _notify_ended(self) -> None:
        _, _, end_url = _nian_audio_endpoints()
        asyncio.create_task(
            _post_json(
                end_url,
                {
                    "source": self.source,
                    "reason": self._end_reason,
                    "uploaded": self._uploaded,
                },
            )
        )

    async def start(self) -> None:
        from stackchan_mcp.audio_stream import start_recording, stop_recording

        if not self.device_already_listening:
            connection = _esp32_connection(self.gateway)
            session_id = getattr(connection, "session_id", "") if connection else ""
            start_recording(session_id or "nian-listen")
            try:
                await _send_listen_state(self.gateway, "start", mode="manual")
            except Exception as e:
                stop_recording()
                raise RuntimeError(f"listen.start failed: {e}") from e

        # 机身已在听（点屏）或刚发出 listen.start：立刻写聊天旁白
        await self._notify_listening()
        self._task = asyncio.create_task(self._run_capture())

    async def _run_capture(self) -> dict[str, Any]:
        from stackchan_mcp.audio_stream import stop_recording

        result: dict[str, Any] = {"ok": False, "error": "capture"}
        try:
            decode = None
            try:
                from stackchan_mcp.stt.audio_utils import decode_opus_frames

                decode = decode_opus_frames
            except Exception as e:
                logger.warning("opus decode unavailable: %s — silence detect will use packet size", e)

            spoken = False
            silence_acc = 0
            elapsed = 0
            decoded_upto = 0
            speech_frame_min = 20  # Opus DTX/silence packets are typically tiny

            while elapsed < self.max_duration_ms and not self._stop_evt.is_set():
                await asyncio.sleep(POLL_S)
                elapsed += int(POLL_S * 1000)

                new_frames = self._frames[decoded_upto:]
                if new_frames and decode:
                    try:
                        pcm = decode(new_frames)
                        rms = _pcm_rms(pcm)
                        decoded_upto = len(self._frames)
                        if rms >= ENERGY_THRESHOLD:
                            spoken = True
                            silence_acc = 0
                        else:
                            silence_acc += len(new_frames) * FRAME_MS
                    except Exception as e:
                        logger.debug("decode chunk: %s", e)
                        decoded_upto = len(self._frames)
                elif new_frames:
                    # No decoder: large opus packets ≈ speech, tiny packets ≈ silence/DTX
                    activity = any(len(f) >= speech_frame_min for f in new_frames)
                    decoded_upto = len(self._frames)
                    if activity:
                        spoken = True
                        silence_acc = 0
                    else:
                        silence_acc += len(new_frames) * FRAME_MS
                else:
                    silence_acc += int(POLL_S * 1000)

                if spoken and silence_acc >= self.silence_ms:
                    logger.info(
                        "nian listen silence end silence_ms=%d frames=%d",
                        silence_acc,
                        len(self._frames),
                    )
                    break
                if (not spoken) and silence_acc >= self.silence_ms and elapsed >= self.silence_ms:
                    logger.info("nian listen cancel: no speech within %d ms", silence_acc)
                    break

            try:
                await _send_listen_state(self.gateway, "stop")
            except Exception as e:
                logger.warning("listen.stop: %s", e)

            stream_frames = stop_recording()
            frames = self._frames or stream_frames
            if not frames:
                result = {"ok": True, "uploaded": False, "reason": "empty"}
                return result

            if not spoken and len(frames) * FRAME_MS < MIN_SPEECH_MS:
                result = {"ok": True, "uploaded": False, "reason": "no_speech"}
                return result

            if not decode:
                result = {"ok": False, "error": "opuslib missing"}
                return result

            pcm = decode(frames)
            if not pcm or _pcm_rms(pcm) < ENERGY_THRESHOLD * 0.5:
                if not spoken:
                    result = {"ok": True, "uploaded": False, "reason": "too_quiet"}
                    return result

            wav_bytes = _pcm_to_wav_bytes(pcm)
            duration_ms = len(frames) * FRAME_MS
            _, utterance_url, _ = _nian_audio_endpoints()
            await _post_wav(utterance_url, wav_bytes, duration_ms)
            result = {
                "ok": True,
                "uploaded": True,
                "duration_ms": duration_ms,
                "frame_count": len(frames),
            }
            return result
        except Exception as e:
            logger.exception("nian listen capture")
            try:
                from stackchan_mcp.audio_stream import stop_recording

                stop_recording()
            except Exception:
                pass
            try:
                await _send_listen_state(self.gateway, "stop")
            except Exception:
                pass
            result = {"ok": False, "error": str(e)}
            return result
        finally:
            self._uploaded = bool(result.get("uploaded"))
            if result.get("uploaded"):
                self._end_reason = "uploaded"
            elif result.get("reason"):
                self._end_reason = str(result.get("reason"))
            elif result.get("error"):
                self._end_reason = "error"
            else:
                self._end_reason = "ended"
            global _active
            async with _session_lock:
                if _active is self:
                    _active = None
            try:
                await self._notify_ended()
            except Exception as e:
                logger.warning("nian listen-end notify: %s", e)

    async def wait_done(self) -> dict[str, Any]:
        if not self._task:
            return {"ok": False, "error": "not started"}
        return await self._task


async def begin_device_listen(gateway: Any, data: dict) -> None:
    """Called when ESP32 sends type=listen state=start (screen tap)."""
    state = str(data.get("state") or "").strip().lower()
    if state == "start":
        # 固件已经开麦：先通知念写「用户正对小机讲话」，再开会话
        listening_url, _, _ = _nian_audio_endpoints()
        asyncio.create_task(_post_json(listening_url, {"source": "screen_tap"}))
        async with _session_lock:
            global _active
            if _active is not None:
                logger.info("nian listen already active; aside already notified")
                return
            sess = NianListenSession(
                gateway,
                silence_ms=SILENCE_MS_DEFAULT,
                max_duration_ms=MAX_DURATION_MS_DEFAULT,
                device_already_listening=True,
                source="screen_tap",
            )
            sess._notified = True
            _active = sess
        try:
            await sess.start()
        except Exception:
            async with _session_lock:
                if _active is sess:
                    _active = None
            raise
    elif state == "stop":
        async with _session_lock:
            sess = _active
        if sess:
            sess._stop_evt.set()


async def run_tools_listen(gateway: Any, arguments: dict | None = None) -> dict[str, Any]:
    """HTTP /tools/listen — start capture from NIAN (device may be idle)."""
    args = arguments if isinstance(arguments, dict) else {}
    silence_ms = int(args.get("silence_ms") or SILENCE_MS_DEFAULT)
    max_duration_ms = int(args.get("max_duration_ms") or MAX_DURATION_MS_DEFAULT)

    if not gateway.esp32.device_connected:
        raise RuntimeError("No ESP32 device connected")

    async with _session_lock:
        global _active
        if _active is not None:
            raise RuntimeError("Listen already in progress")
        sess = NianListenSession(
            gateway,
            silence_ms=silence_ms,
            max_duration_ms=max_duration_ms,
            device_already_listening=False,
            source=str(args.get("source") or "tools"),
        )
        _active = sess

    try:
        await sess.start()
    except Exception:
        async with _session_lock:
            if _active is sess:
                _active = None
        raise
    return await sess.wait_done()


_HOOKS_INSTALLED = False


def install_nian_listen_hooks(gateway: Any) -> None:
    """Wire device listen JSON + Opus frame tap into the active session.

    Official stackchan-mcp ignores screen-tap ``listen start`` unless
    ``STACKCHAN_AUDIO_HOOK_URL`` is set, and never calls ``on_device_listen``.
    We turn on the hook slot and start a Nian session when that recording
    slot opens, so 点屏 actually captures.
    """
    global _HOOKS_INSTALLED
    import stackchan_mcp.audio_stream as audio_stream

    if not _HOOKS_INSTALLED:
        orig_handle = audio_stream.handle_audio_frame

        async def wrapped_handle(data: bytes, session_id: str):
            await orig_handle(data, session_id)
            sess = _active
            if sess is not None:
                sess.on_opus_frame(data)

        audio_stream.handle_audio_frame = wrapped_handle  # type: ignore[assignment]

        orig_start = audio_stream.start_recording

        def wrapped_start(session_id: str, *args, **kwargs):
            orig_start(session_id, *args, **kwargs)
            if _active is not None:
                return
            # Official device-driven path just opened the slot (screen tap)
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                logger.warning("start_recording wrap: no running loop")
                return
            loop.create_task(begin_device_listen(gateway, {"state": "start"}))

        audio_stream.start_recording = wrapped_start  # type: ignore[assignment]

        try:
            import stackchan_mcp.audio_input_hook as audio_hook

            orig_push = audio_hook.push_audio_capture

            async def wrapped_push(hook_url, token, frames, **kwargs):
                if str(hook_url or "").startswith("nian:"):
                    return False
                return await orig_push(hook_url, token, frames, **kwargs)

            audio_hook.push_audio_capture = wrapped_push  # type: ignore[assignment]
        except Exception as e:
            logger.debug("audio_input_hook wrap skipped: %s", e)

        _HOOKS_INSTALLED = True

    def _on_device_listen(data):
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.warning("on_device_listen: no running loop")
            return None
        task = loop.create_task(begin_device_listen(gateway, data))

        def _log_listen_err(t: asyncio.Task) -> None:
            try:
                exc = t.exception()
            except (asyncio.CancelledError, Exception):
                return
            if exc:
                logger.warning("nian device listen: %s", exc)

        task.add_done_callback(_log_listen_err)
        return task

    gateway.esp32.on_device_listen = _on_device_listen

    # Official handler silently drops screen-tap listen.start when this is empty
    if not getattr(gateway.esp32, "_audio_hook_url", None):
        gateway.esp32._audio_hook_url = "nian://device-listen"
        gateway.esp32._audio_hook_token = getattr(gateway.esp32, "_audio_hook_token", "") or ""
        logger.info("nian listen: enabled device-driven capture hook (official client was ignoring 点屏)")

    logger.info(
        "nian listen hooks installed (listening→%s)",
        _nian_audio_endpoints()[0],
    )

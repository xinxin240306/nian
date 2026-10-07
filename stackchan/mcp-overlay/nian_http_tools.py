"""HTTP tool API for nian (and other non-MCP clients).

Mounted on the same aiohttp app as /capture (CAPTURE_PORT, default 8766).

  GET  /tools/status
  POST /tools/call          {"name":"take_photo","arguments":{"question":"…"}}
  POST /tools/play_audio    {"url":"https://…/robot_say_….mp3","text":"…"}
  POST /tools/listen        {"silence_ms":3000,"max_duration_ms":30000}

Auth: Authorization: Bearer <STACKCHAN_TOKEN> (same as capture), unless token empty.
"""

from __future__ import annotations

import logging
from typing import Any

from aiohttp import web

from .capture_server import CAPTURE_TOKEN_KEY
from .tts import play_audio_url, synthesize_and_send

logger = logging.getLogger(__name__)

GATEWAY_KEY = web.AppKey("nian_gateway", object)


def _authorized(request: web.Request) -> bool:
    expected = request.app.get(CAPTURE_TOKEN_KEY) or ""
    if not expected:
        return True
    return request.headers.get("Authorization", "") == f"Bearer {expected}"


def _json_ok(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


def _json_err(message: str, status: int = 400) -> web.Response:
    return web.json_response({"ok": False, "error": message}, status=status)


async def handle_tools_status(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _json_err("Unauthorized", 401)
    gw = request.app[GATEWAY_KEY]
    status = gw.esp32.get_status()
    return _json_ok({"ok": True, **status})


async def _dispatch_device_tool(gw: Any, name: str, arguments: dict) -> dict:
    """Map clean tool names → ESP32 self.* (same as stdio_server)."""
    if not gw.esp32.device_connected:
        raise RuntimeError("No ESP32 device connected")

    tool_map = {
        "get_device_info": ("self.get_device_status", {}),
        "take_photo": ("self.camera.take_photo", arguments),
        "set_volume": ("self.audio_speaker.set_volume", arguments),
        "set_brightness": ("self.screen.set_brightness", arguments),
        "move_head": ("self.robot.set_head_angles", arguments),
        "get_head_angles": ("self.robot.get_head_angles", {}),
        "set_avatar": ("self.display.set_avatar", arguments),
        "set_led": ("self.led.set_color", arguments),
        "set_all_leds": ("self.led.set_all", arguments),
        "clear_leds": ("self.led.clear", {}),
    }
    if name not in tool_map:
        raise ValueError(f"Unknown tool: {name}")
    esp_name, args = tool_map[name]
    result, error = await gw.esp32.call_tool(esp_name, args)
    if error:
        raise RuntimeError(error.get("message", str(error)))
    if isinstance(result, dict):
        return result
    return {"result": result}


async def handle_tools_call(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _json_err("Unauthorized", 401)
    gw = request.app[GATEWAY_KEY]
    try:
        body = await request.json()
    except Exception:
        return _json_err("Invalid JSON")
    name = str(body.get("name") or "").strip()
    arguments = body.get("arguments") if isinstance(body.get("arguments"), dict) else {}
    if not name:
        return _json_err("'name' required")

    try:
        if name == "get_status":
            return _json_ok({"ok": True, **gw.esp32.get_status()})
        if name == "say":
            result = await synthesize_and_send(arguments, gateway=gw)
            return _json_ok({"ok": True, "result": result})
        if name == "play_audio":
            result = await play_audio_url(arguments, gateway=gw)
            return _json_ok({"ok": True, "result": result})
        if name == "listen":
            from .nian_listen_session import run_tools_listen

            result = await run_tools_listen(gw, arguments)
            return _json_ok({"ok": True, "result": result})
        if name == "move_head":
            yaw = arguments.get("yaw")
            pitch = arguments.get("pitch")
            if not isinstance(yaw, int) or isinstance(yaw, bool) or not (-90 <= yaw <= 90):
                return _json_err(f"yaw must be int -90..90 (got {yaw!r})")
            if not isinstance(pitch, int) or isinstance(pitch, bool) or not (5 <= pitch <= 85):
                return _json_err(f"pitch must be int 5..85 (got {pitch!r})")
        result = await _dispatch_device_tool(gw, name, arguments)
        return _json_ok({"ok": True, "result": result})
    except (ValueError, NotImplementedError) as e:
        return _json_err(str(e), 400)
    except RuntimeError as e:
        return _json_err(str(e), 503)
    except Exception as e:
        logger.exception("tools/call %s", name)
        return _json_err(str(e), 500)


async def handle_play_audio(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _json_err("Unauthorized", 401)
    gw = request.app[GATEWAY_KEY]
    try:
        body = await request.json()
    except Exception:
        return _json_err("Invalid JSON")
    try:
        result = await play_audio_url(body if isinstance(body, dict) else {}, gateway=gw)
        return _json_ok({"ok": True, "result": result})
    except ValueError as e:
        return _json_err(str(e), 400)
    except RuntimeError as e:
        return _json_err(str(e), 503)
    except Exception as e:
        logger.exception("play_audio")
        return _json_err(str(e), 500)


async def handle_listen(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _json_err("Unauthorized", 401)
    gw = request.app[GATEWAY_KEY]
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        from .nian_listen_session import run_tools_listen

        result = await run_tools_listen(gw, body if isinstance(body, dict) else {})
        return _json_ok({"ok": True, "result": result})
    except ValueError as e:
        return _json_err(str(e), 400)
    except RuntimeError as e:
        return _json_err(str(e), 503)
    except Exception as e:
        logger.exception("listen")
        return _json_err(str(e), 500)


def mount_nian_http_tools(app: web.Application, gateway: Any) -> None:
    app[GATEWAY_KEY] = gateway
    app.router.add_get("/tools/status", handle_tools_status)
    app.router.add_post("/tools/call", handle_tools_call)
    app.router.add_post("/tools/play_audio", handle_play_audio)
    app.router.add_post("/tools/listen", handle_listen)
    try:
        from .nian_listen_session import install_nian_listen_hooks

        install_nian_listen_hooks(gateway)
    except Exception as e:
        logger.warning("nian listen hooks not installed: %s", e)

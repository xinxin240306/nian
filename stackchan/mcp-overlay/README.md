# 若 VPS 上的 gateway 还没有 /tools 补丁，把本目录文件拷进官方包：
#
#   cp nian_http_tools.py  /opt/stackchan-mcp/gateway/stackchan_mcp/
#   cp nian_listen_session.py /opt/stackchan-mcp/gateway/stackchan_mcp/
#   cp capture_server.py   /opt/stackchan-mcp/gateway/stackchan_mcp/
#   cp gateway.py          /opt/stackchan-mcp/gateway/stackchan_mcp/
#   cp orchestrator.py     /opt/stackchan-mcp/gateway/stackchan_mcp/tts/
#   cp tts__init__.py      /opt/stackchan-mcp/gateway/stackchan_mcp/tts/__init__.py
#
# 麦克风上行还需要 gateway 里 esp32_client.py 的 listen 分支（on_device_listen）。
# 更省事：直接 scp 整份 D:\stackchan-mcp\gateway（已打好补丁）。
#
# 点屏聆听：固件短触屏幕 → ToggleChatState → listen start
#   → 网关缓冲 Opus → 静音约 3s → WAV POST 念 /mcp/audio/utterance
#   → 隐藏 robotMic 多模态 → 角色回复（可经喇叭）

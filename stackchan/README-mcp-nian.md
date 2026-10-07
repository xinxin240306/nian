# �?MCP 网关 · VPS 部署（推荐）

小机 �?VPS 上的 `stackchan-mcp` �?同机念�?*不必开着家里电脑�?*

固件用已�?KEEP_GATEWAY 即可，只改设备里�?WebSocket 地址�?

## 架构

```
小机 ──wss://域名/stackchan/──�?Nginx ──�?127.0.0.1:8765（MCP 网关�?
�?PM2 ──http://127.0.0.1:8766/tools/*──�?同网�?
拍照 ──HTTPS──�?�?/mcp/vision/explain（存截图�?
点屏开�?──listen start──�?网关缓冲 Opus ──静音�?s──�?/mcp/audio/utterance
下一轮角色聊�?──把截�?音频塞进角色模型──�?角色识图/听音后回�?
```

小智 Docker 可停掉（对讲改走 MCP 麦克风上行）；角色主动只靠这条�?
「看一�?/ 找人 / 跟着」：聊天提示词只挂短状态；用意�?`robot-toolbook-helper` 匹配后执行（也可�?`[桌宠:…]`）�?

### 点屏对小机说�?

1. 短触小机屏幕 �?固件开麦（`ToggleChatState`�?
2. 网关立刻通知�?�?聊天页「小�?· 用户正对小机讲话」（角色可见、不回复�?
3. 说完后静音约 3 �?�?WAV 上传 `/mcp/audio/utterance`（聊天页不显示语音条�?
4. 模型多模态听音后回复，可经小机喇叭播�?

桌宠页也可点「测点屏聆听」走同一条链路�?
---

## 1. 把网关代码弄�?VPS

在你这台 Windows 上（已含 `/tools` 补丁）：

```powershell
# �?PowerShell，按实际改用户名/IP
scp -r D:\stackchan-mcp\gateway root@你的VPSIP:/opt/stackchan-mcp-gateway
```

或在 VPS �?`git clone` 官方仓库后再覆盖念仓库里的补丁：

```bash
# VPS
mkdir -p /opt/stackchan-mcp
# 把本目录 mcp-overlay/ 拷到 gateway 包内（见下节 docker 也可用）
```

念仓库补丁文件：

- `stackchan/mcp-overlay/nian_http_tools.py`
- 以及需改过�?`capture_server.py` / `gateway.py` / `tts/orchestrator.py` / `tts/__init__.py`  
  （若�?scp 的是完整 `D:\stackchan-mcp\gateway`，这些已在里面，可跳过覆盖。）

---

## 2. Docker 一键（推荐�?

```bash
mkdir -p /opt/stackchan-mcp
cd /opt/stackchan-mcp

# 上传 gateway 源码�?/opt/stackchan-mcp/gateway 后：
cp /root/nian/stackchan/mcp-vps/docker-compose.yml .
cp /root/nian/stackchan/mcp-vps/Dockerfile .
cp /root/nian/stackchan/mcp-vps/.env.example .env
nano .env   # �?STACKCHAN_TOKEN、VISION_URL
```

`.env` 最少：

```bash
STACKCHAN_TOKEN=粘贴念桌宠「设备令牌�?
HOST=0.0.0.0
WS_PORT=8765
CAPTURE_PORT=8766
STACKCHAN_MODE=nian
VISION_URL=https://�������/mcp/vision/explain
VISION_TOKEN=
```

`STACKCHAN_MODE=nian` 很重要：只跑小机要用�?WebSocket + `/tools`�?*不启**�?Codex 用的 stdio MCP（会和容器里�?`mcp` 库版本打架，一启动�?`list_tools` 报错退出）�?

`VISION_URL` 指向念视觉；拍照不再经网关本�?/capture 落盘，直接进念�?

```bash
cd /opt/stackchan-mcp
docker compose up -d --build
docker logs -f stackchan-mcp --tail 50
# 应看到：Gateway started: WS on �?capture+tools on �?
```

自检（VPS 本机）：

```bash
curl -s http://127.0.0.1:8766/tools/status \
  -H "Authorization: Bearer $STACKCHAN_TOKEN"
# 未连小机�?connected:false 也正常；连上后应�?true
```

---

## 3. Nginx：给小机一�?WSS

�?`�������` �?`server { listen 443 �?}` 里加�?
（文件也可直接参�?`stackchan/mcp-vps/nginx-stackchan.conf`）：

```nginx
# StackChan MCP 网关（角色主动控制，无需小智�?
location /stackchan/ {
    proxy_pass http://127.0.0.1:8765/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

```bash
nginx -t && systemctl reload nginx
```

小机配网�?WebSocket 填：

```text
wss://�������/stackchan/
```

Token = �?`.env` �?`STACKCHAN_TOKEN` / 念设备令牌相同�?

---

## 4. 念桌宠页

1. 控制通道�?*MCP 网关**
2. MCP 工具地址：`http://127.0.0.1:8766`（念与网关同 VPS�?
3. MCP Token：可空（会用设备令牌）；�?`.env` 用了别的 token 就填那个
4. 保存 �?`pm2 restart nian`

日志�?

```bash
pm2 logs nian --lines 30
# [robot-mcp] 已启动，�?4000ms 拉取指令 �?stackchan-mcp /tools
```

---

## 5. 联调

1. 小机上电，串口或桌宠页应在约 1�? 分钟内变「在线�?
2. `curl` `/tools/status` �?`connected: true`
3. 桌宠「测机身摄像头」→ 有回�?
4. 聊天 `[桌宠:看一眼]` / 触发靠近 �?**不用唤醒**

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 一直不在线 | 小机 WSS 是否 `/stackchan/`；token 是否一致；`docker ps` 看网�?|
| 能连但不能拍�?| `VISION_URL` 是否念的 `/mcp/vision/explain`；桌宠已启用 |
| 能拍不能出声 | 容器里要�?`ffmpeg`（本 Dockerfile 已装）；�?TTS 是否生成�?mp3 |
| 旧小智容器占内存 | 执行 `docker compose down` 停掉 `/opt/xiaozhi-server` |

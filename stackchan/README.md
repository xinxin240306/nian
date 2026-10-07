# Stack-chan 对接念（MCP�?

让量�?Stack-chan 通过 **stackchan-mcp 网关** 使用念里绑定的角色�?

**域名示例�?* https://�������

👉 **VPS 部署清单�?* [DEPLOY-VPS.md](./DEPLOY-VPS.md)  
👉 **MCP 网关详细步骤�?* [README-mcp-nian.md](./README-mcp-nian.md)

---

## 架构

```
Stack-chan（Wi‑Fi�?
    �?wss://域名/stackchan/
stackchan-mcp 网关（VPS Docker :8765/:8766�?
    �?/tools/* + /mcp/*
�?PM2 :3000
    �?
/api/robot/chat �?角色 / 表情 / 记忆
```

角色主动�?�?转头直连 MCP 网关�?*无需唤醒**。点屏开麦走网关 �?�?`/mcp/audio/utterance`�?

---

## 念侧（网页配置）

1. 打开 **桌宠** �?启用、选角色�?*生成并复制令�?*
2. MCP 工具地址�?`http://127.0.0.1:8766`（与念同机）
3. 公网地址�?`https://你的域名`
4. 保存后在网页 **试聊** 确认正常

---

## 小机�?

1. 固件 WebSocket 改连 `wss://你的域名/stackchan/`（Nginx 反代�?8765�?
2. 令牌与桌宠页「设备令牌」一�?
3. 不必再连小智 `/xiaozhi/v1/`

---

## Nginx 要点

```nginx
# MCP WebSocket
location /stackchan/ {
    proxy_pass http://127.0.0.1:8765/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}

# 念主�?+ MCP 视觉/音频
location / {
    proxy_pass http://127.0.0.1:3000;
    # …常规反代头�?
}
```

`/mcp/vision/explain`、`/mcp/audio/*` 随主站反代到�?3000 即可�?

---

## 省内存（2G VPS�?

| 组件 | 建议 |
|------|------|
| 小智 Docker | **停掉**（`docker stop xiaozhi-esp32-server` 或删 compose�?|
| stackchan-mcp | 保留，约 100�?00MB |
| �?PM2 | `--max-memory-restart 512M` |
| swap | 1G（见 DEPLOY-VPS.md�?|

# �?PM2 + MCP 网关 · VPS 部署清单

适用�?*2 �?2G**（后期可�?4G），域名 **https://�������**

架构：念（PM2 :3000�? stackchan-mcp（Docker :8765/:8766�? Nginx�?43�?

> 已弃用小�?Docker。若 VPS 上还在跑 `xiaozhi-esp32-server`，请停掉以释放约 1GB 内存�?

---

## 0. 登录 VPS

```bash
ssh root@你的服务器IP
```

念项目路径示�?**`/root/nian`**�?

---

## 1. 系统准备�?G 内存推荐�?

```bash
# 1G swap
fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git nginx docker.io docker-compose-plugin
npm install -g pm2
```

---

## 2. 念（PM2�?

```bash
cd /root/nian/backend
npm install --production
pm2 delete nian 2>/dev/null
pm2 start server.js --name nian --max-memory-restart 512M
pm2 save && pm2 startup
```

确认�?

```bash
curl -s http://127.0.0.1:3000/api/health
```

网页 **桌宠** �?启用 �?绑定角色 �?生成令牌 �?MCP 地址 `http://127.0.0.1:8766` �?保存�?

---

## 3. stackchan-mcp（Docker�?

详见 [README-mcp-nian.md](./README-mcp-nian.md)。概要：

```bash
mkdir -p /opt/stackchan-mcp/gateway
# 上传 gateway 源码后：
cp /root/nian/stackchan/mcp-vps/docker-compose.yml /opt/stackchan-mcp/
cp /root/nian/stackchan/mcp-vps/Dockerfile /opt/stackchan-mcp/
cp /root/nian/stackchan/mcp-vps/.env.example /opt/stackchan-mcp/.env
nano /opt/stackchan-mcp/.env   # STACKCHAN_TOKEN、VISION_URL
cd /opt/stackchan-mcp && docker compose up -d --build
```

`.env` 最少：

```bash
STACKCHAN_TOKEN=桌宠令牌
STACKCHAN_MODE=nian
VISION_URL=https://�������/mcp/vision/explain
WS_PORT=8765
CAPTURE_PORT=8766
```

验证�?

```bash
curl -s http://127.0.0.1:8766/tools/status
```

---

## 4. 停掉小智（若还在跑）

```bash
docker ps | grep xiaozhi
cd /opt/xiaozhi-server 2>/dev/null && docker compose down
# 可选：删镜像省磁盘
# docker rmi $(docker images -q '*xiaozhi*') 2>/dev/null
```

Nginx �?`/xiaozhi/v1/`、`/xiaozhi/ota/`、`/v1/`（小�?LLM 兼容层）可删掉�?

---

## 5. Nginx

```nginx
location /stackchan/ {
    proxy_pass http://127.0.0.1:8765/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
}
```

```bash
nginx -t && systemctl reload nginx
```

---

## 6. 内存排查

```bash
free -h
ps aux --sort=-%mem | head -12
docker stats --no-stream
pm2 monit
```

正常占用（约）：

| 进程 | RSS |
|------|-----|
| nian (PM2) | 150�?50MB |
| stackchan-mcp | 100�?00MB |
| nginx | &lt;50MB |

�?nian 持续上涨不回落，�?MCP 内存排查指南做堆快照对比；常见原因是未清理的 Map 缓存�?MCP fetch 超时�?abort（念�?`robot-mcp-bridge` 已用 AbortController）�?

---

## 7. 日常维护

```bash
cd /root/nian && git pull
cd backend && npm install --production
pm2 restart nian

cd /opt/stackchan-mcp && docker compose up -d --build
```

备份：`/root/nian/backend/data`（SQLite）、`/opt/stackchan-mcp/.env`

#!/usr/bin/env bash
# 念 · 后端健康检查：/api/health 失败时自动 pm2 restart
# 用法（VPS 上）：chmod +x watchdog.sh && crontab -e 添加：
# * * * * * /root/NIAN/backend/watchdog.sh >> /var/log/nian-watchdog.log 2>&1

set -u

URL="${NIAN_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
PM2_NAME="${NIAN_PM2_NAME:-nian}"
TIMEOUT="${NIAN_HEALTH_TIMEOUT:-12}"

if curl -sf --max-time "$TIMEOUT" "$URL" >/dev/null 2>&1; then
  exit 0
fi

echo "$(date -Iseconds 2>/dev/null || date) health check failed → pm2 restart $PM2_NAME"
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME"
else
  echo "pm2 not found"
  exit 1
fi

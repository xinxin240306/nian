# 念 · 跨世界通讯软件

> 你们分别身处不同的世界，「念」是唯一连接你们的方式。

本仓库为**个人非商业自托管**源码发布。允许个人使用与自用修改；**禁止商业使用**，**禁止将修改后再公开分发（禁止二改）**。详见 [LICENSE](./LICENSE) 与应用内「使用声明与免责协议」。

> **说明**：每人自行部署一份。本项目是单机单用户（一份 SQLite），不是多人共用的 SaaS。

**不会写代码？** 请先看小白部署文档（复制粘贴即可）：  
👉 [docs/部署指南-小白版.md](./docs/部署指南-小白版.md)  
（含本机启动 → 云服务器 → Stack-chan 小机进阶）

---

## 环境要求

- Node.js 18+（建议 LTS）
- 自备兼容 OpenAI Chat Completions 格式的聊天 API Key（以及你需要的 TTS / 生图等）

---

## 快速启动

### 方式一：双击启动（Windows）

运行 `start.bat`，首次会自动安装依赖。

### 方式二：手动启动

```bash
cd backend
npm install
node server.js
```

启动后访问：**http://localhost:3000**

首次进入应用：打开 **设置** → 填写聊天 API 的 Base URL 与 API Key → 创建角色 → 开始聊天。

---

## 功能一览

| 功能 | 说明 |
|------|------|
| 通讯 | 与 AI 角色聊天（文字 / 语音 / 图片等） |
| 梦境 | 独立对话空间 |
| 日记 / 日历 | 日记与行程 |
| 角色 | 人设、声音、记忆参数 |
| 世界书 / 预设 | 世界观与 System Prompt |
| 朋友圈 / 圈子 | 动态与 NPC 人际关系 |
| 记忆 | 自动总结与分类 |
| 设置 | API、主题、站点相关配置 |

---

## 部署到服务器（VPS）

```bash
cd backend
npm install
npm install -g pm2
pm2 start server.js --name nian
pm2 save && pm2 startup
```

建议前面加 Nginx / Caddy 反代 HTTPS。

### 站点访问锁（公网强烈建议开启）

复制 `backend/.env.example` 为 `backend/.env`（**不要提交到 Git**）：

```env
SITE_LOCK_ENABLED=1
SITE_LOCK_USER=你的用户名
SITE_LOCK_PASS=你的密码
SITE_LOCK_SECRET=请换成足够长的随机字符串
```

账号密码可自行修改。默认同一浏览器会话内换网络也不必反复登录；若希望换 IP 必须重登，设 `SITE_LOCK_BIND_IP=1`。

可选健康检查脚本：`backend/watchdog.sh`（配合 cron + pm2）。

---

## Android App（Capacitor 壳）

手机安装包主要是前端壳；聊天与 AI 仍跑在你电脑或 VPS 上的 Node 后端。

```bash
npm install
npm run android:debug
```

产物一般在：

`android/app/build/outputs/apk/debug/app-debug.apk`

首次打开填写后端地址：VPS 用 `https://你的域名`；同一 Wi‑Fi 连电脑用 `http://电脑IP:3000`（不要填 localhost）。

正式签名请自行生成 keystore，勿使用来历不明的共享证书。

---

## 桌宠 / 硬件

- **bbtoy**：配置页可用。
- **stackchan**：对接仍在完善中，公开版可能不完整；部署说明见 `stackchan/`。请使用你自己的域名与设备令牌，不要照抄他人的公网地址。

---

## 数据

- 运行时数据在 `backend/nian.db`（首次启动自动创建空库）
- 上传文件在 `backend/uploads/`
- 以上均不应提交到 Git；公开仓库不包含作者的私人角色、密钥或聊天记录

---

## 技术栈

- 前端：HTML + CSS + JS（PWA）
- 后端：Node.js + Express + SQLite（sql.js）
- 实时：WebSocket
- 定时：node-cron

---

## 许可

见 [LICENSE](./LICENSE)。继续使用即表示你同意应用内声明：生成内容与后果由使用者自行负责。

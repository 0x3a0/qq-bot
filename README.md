# QQ 行情 Bot

基于 NapCatQQ 和 OneBot 11 正向 WebSocket 的 QQ 群机器人。群内收到 `@机器人 a股` 或 `@机器人 美股` 后，Bot 会直接请求百度财经页面，按固定顺序截图并依次发送对应市场的行情图片到当前群聊，不再自渲染行情 HTML，也不依赖旧行情数据。A 股发送 7 张，美股发送 4 张。

## 本地运行

1. 安装 Node.js 24 和依赖：`npm install`。
2. 安装截图浏览器：`npx playwright install chromium`。Windows 本机已有 Chrome/Edge 时也可跳过，程序会自动查找。
3. 将 `.env.example` 复制为 `.env`，配置 NapCat WebSocket 地址、Token 和机器人 QQ 号。
4. 运行 `npm run dev`，Node.js 会自动读取 `.env`。
5. 在群内明确 `@机器人` 后发送 `a股` 或 `美股`，机器人会依次发送对应市场的截图结果。

截图流程和图片顺序见 [A 股行情截图功能文档](docs/features/a-share-screenshots.md) 与 [美股行情截图功能文档](docs/features/us-share-screenshots.md)。页面截图脚本位于 [demo/baidu-finance-market-screenshot.mjs](demo/baidu-finance-market-screenshot.mjs)，生产运行和手工运行使用同一份脚本。

## 配置

- `ONEBOT_WS_URL`：必填，NapCat 的 OneBot 11 WebSocket 服务端地址，例如 `ws://your-napcat-host:11451`。不要将实际公网 IP 写入示例文件、源码或文档。
- `ONEBOT_WS_TOKEN`：NapCat 配置的访问 Token；未启用 Token 时留空。
- `BOT_QQ`：可选。机器人 QQ 号；事件不包含 `self_id` 时用于识别 `@机器人`。
- `ONEBOT_RECONNECT_MIN_MS`、`ONEBOT_RECONNECT_MAX_MS`：断线重连退避范围。
- `ONEBOT_REQUEST_TIMEOUT_MS`：OneBot API 请求超时。
- `PLAYWRIGHT_EXECUTABLE_PATH`：可选，指定截图浏览器可执行文件路径。
- `BAIDU_FINANCE_URL`、`BAIDU_FINANCE_HEATMAP_URL`：可选，覆盖百度财经首页和热力图页面地址，主要用于调试。
- `BAIDU_FINANCE_US_URL`：可选，覆盖美股页面地址，默认使用 `https://finance.baidu.com/?quotationMarket=us`。
- `BAIDU_FINANCE_US_HEATMAP_URL`：可选，覆盖美股板块热力图页面地址，默认使用 `https://finance.baidu.com/heat-treemap/home/us?tab=HY&value=amount&financeType=block`。

## 验证

运行 `npm test`。测试覆盖 `@bot a股`、`@bot 美股` 触发、截图顺序、临时图片清理、OneBot API 请求和失败提示。需要真实验证截图时运行：

```powershell
node demo/baidu-finance-market-screenshot.mjs
node demo/baidu-finance-market-screenshot.mjs --market us
```

百度财经页面必须能够从 Bot 运行环境访问；页面请求、截图或发送失败时，Bot 会在群内发送明确的错误提示。

## Docker 部署

项目通过 GitHub Container Registry（GHCR）发布镜像。向 `main` 推送代码后，[`.github/workflows/publish-image.yml`](.github/workflows/publish-image.yml) 会构建并推送以下标签：

- `ghcr.io/0x3a0/qq-bot:latest`：当前 `main` 的最新版本。
- `ghcr.io/0x3a0/qq-bot:<commit-sha>`：不可变版本，生产部署和回滚应优先使用此标签。

镜像构建会包含截图脚本和 Playwright Chromium；运行时配置仅保存在服务器的 `/home/ubuntu/qq-market-bot/.env`。不要将 `.env` 提交、复制进镜像或上传到镜像仓库。

首次发布 GHCR 镜像后，请在 GitHub Packages 中决定其可见性：公开镜像可被服务器直接拉取；私有镜像需要在服务器以带 `read:packages` 权限的 GitHub PAT 登录一次：

```bash
read -rsp "GitHub PAT: " GHCR_TOKEN
printf '%s' "$GHCR_TOKEN" | sudo docker login ghcr.io -u <github-user> --password-stdin
unset GHCR_TOKEN
```

服务器首次部署时，保留现有的 `.env`，至少配置：

```env
ONEBOT_WS_URL=ws://napcat:11451
```

在服务器项目目录执行一次以下脚本即可拉取、替换并验证容器。新容器在启动阶段退出时，脚本会自动恢复上一个镜像：

```bash
cd /home/ubuntu/qq-market-bot
chmod +x scripts/deploy-image.sh
sudo ./scripts/deploy-image.sh ghcr.io/0x3a0/qq-bot:<commit-sha>
```

后续更新仅需选择新的 commit SHA 标签并再次运行该命令；`.env` 不会被改写。若服务器已安装 Docker Compose 插件，也可通过下面的方式更新：

```bash
QQ_MARKET_BOT_IMAGE=ghcr.io/0x3a0/qq-bot:<commit-sha> sudo -E docker compose pull
QQ_MARKET_BOT_IMAGE=ghcr.io/0x3a0/qq-bot:<commit-sha> sudo -E docker compose up -d
```

本地需要临时验证镜像时，`Dockerfile` 会自行编译 TypeScript：

```powershell
docker build -t qq-market-bot:latest .
docker run --rm --env-file .env qq-market-bot:latest
```

网络无法直连 Docker Hub 的服务器可以仅在构建时覆盖基础镜像，不需要修改 Dockerfile：

```powershell
docker build --build-arg NODE_IMAGE=docker.1ms.run/library/node:24-bookworm-slim -t qq-market-bot:latest .
```

服务器使用名为 `qq-market-network` 的用户定义网络，将 NapCat 和 Bot 接入同一网络。`docker-compose.yml` 是仅拉取镜像的部署清单；当前服务器没有 Compose 插件时，使用 `scripts/deploy-image.sh`。不要上传 `node_modules`、`.env` 或 `ssh.pem`。

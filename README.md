# QQ 行情 Bot

基于 NapCatQQ 和 OneBot 11 正向 WebSocket 的 QQ 群机器人。群内收到 `@机器人 板块涨跌` 后，Bot 会实时请求行情数据，并在同一条回复中发送一张行业与概念板块总览图。总览图按上下分类区块展示行业、概念的独立排行，每类均包含涨幅 Top 10 与跌幅 Top 10，共 40 个板块卡片，并以 2 倍像素密度输出。

## 本地运行

1. 安装 Node.js 24 和依赖：`npm install`。
2. 安装截图浏览器：`npx playwright install chromium`。Windows 本机已有 Chrome 时也可跳过，程序会自动使用 Chrome。
3. 将 `.env.example` 复制为 `.env`，配置 NapCat WebSocket 地址、Token 和同花顺 API Key。
4. 运行 `npm run dev`，Node.js 会自动读取 `.env`。
5. 在群内手动 `@机器人` 后发送 `板块涨跌`，机器人会实时生成并回复一张总览图片。

行情数据源为同花顺金融数据 API（REST，`X-api-key` 认证）。板块涨跌 Provider 已于 2026-09-17 完成迁移并通过真实 API Key 联调，东方财富实现与回退链路已删除，失败时不回退旧数据源。接口调研与联调记录见 [docs/ths-financial-data-api.md](docs/ths-financial-data-api.md)。

## 配置

- `ONEBOT_WS_URL`：必填，NapCat 的 OneBot 11 WebSocket 服务端地址，例如 `ws://your-napcat-host:11451`。不要将实际公网 IP 写入示例文件、源码或文档。
- `ONEBOT_WS_TOKEN`：NapCat 配置的访问 Token；未启用 Token 时留空。
- `BOT_QQ`：可选。机器人 QQ 号；事件不包含 `self_id` 时用于识别 `@机器人`。
- `ONEBOT_RECONNECT_MIN_MS`、`ONEBOT_RECONNECT_MAX_MS`：断线重连退避范围。
- `ONEBOT_REQUEST_TIMEOUT_MS`：OneBot API 请求超时。
- `MARKET_REQUEST_TIMEOUT_MS`：单次行情请求超时。
- `MARKET_REQUEST_RETRIES`：行情请求失败后的重试次数；仅对同花顺契约允许重试的失败（HTTP 429、`code=4001` 限流与上游 `5xxx`）生效，认证、权限和其他业务错误不重试。
- `THS_API_KEY`：必填，同花顺金融数据 API Key，通过请求头 `X-api-key` 携带。属于敏感信息，只能写在 `.env` 或部署密钥管理中，不得提交到仓库或写入日志。
- `THS_SNAPSHOT_BATCH_SIZE`：可选，默认 `100`。单次批量行情快照请求携带的 `thscodes` 数量上限，已用真实 Key 验证 100 与 200 均可用。

## 验证

运行 `npm test`。测试覆盖板块涨跌指令触发、OneBot API 请求、行情数据请求及校验、请求失败处理、无分时请求链路、临时文件清理，以及单张总览 PNG 渲染。

联通远程 NapCat 前，请确认服务仅向必要的来源地址开放端口 `11451`，且 Token 与本地配置一致；不要将实际地址和 Token 提交到仓库。

## Docker 部署

项目通过 GitHub Container Registry（GHCR）发布镜像。向 `main` 推送代码后，[`.github/workflows/publish-image.yml`](.github/workflows/publish-image.yml) 会构建并推送以下标签：

- `ghcr.io/0x3a0/qq-bot:latest`：当前 `main` 的最新版本。
- `ghcr.io/0x3a0/qq-bot:<commit-sha>`：不可变版本，生产部署和回滚应优先使用此标签。

镜像构建不包含 `.env`；运行时配置仅保存在服务器的 `/home/ubuntu/qq-market-bot/.env`。不要将该文件提交、复制进镜像或上传到镜像仓库。

首次发布 GHCR 镜像后，请在 GitHub Packages 中决定其可见性：公开镜像可被服务器直接拉取；私有镜像需要在服务器以带 `read:packages` 权限的 GitHub PAT 登录一次：

```bash
read -rsp "GitHub PAT: " GHCR_TOKEN
printf '%s' "$GHCR_TOKEN" | sudo docker login ghcr.io -u <github-user> --password-stdin
unset GHCR_TOKEN
```

服务器首次部署时，保留现有的 `.env`，补齐当前版本所需的 `THS_API_KEY`，并将 OneBot 地址配置为 Docker 网络内的 NapCat 服务：

```env
ONEBOT_WS_URL=ws://napcat:11451
THS_API_KEY=<同花顺 API Key>
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

Dockerfile 默认使用 USTC Debian 镜像安装 Playwright 的系统依赖和 Noto CJK 中文字体；slim 基础镜像安装 CA 证书前无法验证 HTTPS，因此默认使用 HTTP 传输，但 APT 仍会校验 Debian Release 和软件包签名。Chromium 默认从 npm 国内镜像下载。需要切换时可追加 `--build-arg APT_MIRROR=http://<镜像站>` 或 `--build-arg PLAYWRIGHT_DOWNLOAD_HOST=https://<镜像站>`。

服务器使用名为 `qq-market-network` 的用户定义网络，将 NapCat 和 Bot 接入该网络。`docker-compose.yml` 是仅拉取镜像的部署清单；当前服务器没有 Compose 插件时，使用 `scripts/deploy-image.sh`。不要上传 `node_modules`、`.env` 或 `ssh.pem`。行情数据接入规则和同花顺文档索引见 [AGENTS.md](AGENTS.md)。

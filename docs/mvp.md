# QQ 行情 Bot MVP

## 1. 目标

开发一个基于 NapCatQQ 和 OneBot 11 的 QQ 群机器人：

- 仅在用户 `@bot 板块涨跌` 时被动回复；
- 回复 A 股行业板块和概念板块的涨跌速览；
- 支持本地开发连接远程 NapCat；
- 后续可以部署到远程服务器 Docker 中；
- 暂不做定时推送、后台管理、多群订阅和复杂指令系统。

### 数据源可行性

当前数据源调研见 [同花顺金融数据 API 接入调研](ths-financial-data-api.md)。`板块涨跌` 已于 2026-09-17 迁移到同花顺指数目录、指数快照、成分股和股票快照链路并通过真实 API Key 联调；行业和概念分类独立处理，东方财富实现与回退链路已删除。

## 2. 连接方式

NapCat 已配置 WebSocket 服务端，因此 Bot 使用 OneBot 11 正向 WebSocket 客户端连接：

```text
本地开发：Bot  -- WebSocket 客户端 -->  <远程 NapCat 主机>:11451 NapCat WS 服务端

后续部署：Bot 容器 -- WebSocket 客户端 --> NapCat 容器的服务名/IP:11451
```

这条连接同时承担两类通信：

- 接收群消息事件；
- 调用 `send_group_msg` 回复群消息。

Bot 不实现 QQ 协议，只实现 OneBot 11 WebSocket 客户端。NapCat 负责 QQ 登录、群消息收发和协议转换。

## 3. MVP 交互

### 触发条件

机器人只处理群聊中明确 `@bot` 的消息，文本内容去除空格后等于以下独立指令：

```text
板块涨跌
```

以下内容暂不处理：

- 私聊消息；
- 未 `@bot` 的“ 板块涨跌 ”；
- 其他股票查询、帮助、订阅等指令。

### 回复内容

在同一条 QQ 回复中返回一张板块涨跌总览图：

- 上半部分为行业板块、下半部分为概念板块；
- 每个分类均展示涨幅 Top 10、跌幅 Top 10；
- 板块涨跌幅、关联股票及其涨跌幅；
- 数据来源及“仅供参考”提示。

行业板块和概念板块属于不同分类体系，不混合计算或展示排行。总览图作为一个图片消息段发送，确保它们对应同一次指令回复。

如果行情数据获取失败，回复明确的失败提示，不发送未经确认的旧数据。

## 4. 技术方案

第一版采用轻量实现，不引入完整机器人框架：

- Node.js 24；
- TypeScript；
- `ws`：OneBot WebSocket 连接；
- HTML/CSS 模板：渲染行情卡片；
- Playwright：将 HTML 页面截图为 PNG；
- 一个行情数据 Provider：封装真实数据源，便于后续替换；
- 内置定时器或简单重试逻辑：只用于连接重连和请求重试，不做定时推送。

暂不使用 Koishi、NoneBot 等完整框架。当前需求只有一个轻量行情指令和对应回复流程，轻量实现更容易调试；当后续需要多插件、权限、持久化配置或大量指令时，再评估迁移框架。

## 5. 建议模块

```text
src/
  config/          环境变量和配置加载
  onebot/          WebSocket 客户端、OneBot 类型和 API 调用
  market/          行情 Provider、数据校验和消息格式化
  renderer/        HTML/CSS 行情卡片模板、数据填充和 Playwright 截图
  bot/             @bot 识别和“板块涨跌”命令处理
  main.ts          启动并组装各模块

tests/
  onebot/          连接与 API 请求测试
  bot/             触发条件和命令处理测试
  market/          数据校验和文本格式化测试
```

核心流程：

```text
OneBot message 事件
        |
        v
判断群聊 -> 判断是否 @bot -> 解析“板块涨跌”
        |
        v
获取并校验行业、概念板块行情
        |
        v
一份 HTML/CSS 总览渲染 -> Playwright 截图为一张 PNG
        |
        v
一个图片消息段 -> send_group_msg 回复原群
```

### 图片渲染

行情回复采用 HTML/CSS 卡片，而不是在 QQ 客户端中拼接文本。Bot 获取 JSON 数据后，先转换并校验为模板所需的数据结构，再填充 HTML 模板，使用 Playwright 截图生成 PNG，最后通过 OneBot 图片消息发送。

渲染过程在 Bot 所在环境执行：本地开发时由本地进程生成，部署到 Docker 后由 Bot 容器生成。发送时优先将 PNG 转为 Base64 放入 OneBot 图片消息，避免 NapCat 访问不到 Bot 主机本地文件路径。

图片模板生成一张内容高度自适应的板块涨跌总览图，上方展示行业板块、下方展示概念板块；每个分类均展示涨幅 Top 10、跌幅 Top 10、板块涨跌幅、关联股票及其涨跌幅，并显示数据来源说明。截图采用 2 倍像素密度，以兼顾 QQ 内展示比例和服务器渲染清晰度。接入真实行情时必须保持“行业/概念独立排行、Top 10”的数据结构。

开发时应参考 `demo/board-performance-card/` 中的布局、层级和样式；以 `metric-demo.html`、`metric-demo.css` 为视觉基准。

## 6. 环境配置

配置放在环境变量或未提交的本地配置文件中，不写死在业务代码里：

```env
ONEBOT_WS_URL=ws://your-napcat-host:11451
ONEBOT_WS_TOKEN=替换为NapCat中配置的Token
MARKET_REQUEST_TIMEOUT_MS=10000
MARKET_REQUEST_RETRIES=1
```

本地开发阶段使用远程 NapCat 地址。部署到远程 Docker 后，将 `ONEBOT_WS_URL` 改为 NapCat 容器可达的地址，例如 Docker 网络中的服务名：

```env
ONEBOT_WS_URL=ws://napcat:11451
```

具体地址以 NapCat 容器实际监听地址、Docker 网络和端口暴露方式为准。若 Bot 与 NapCat 在同一容器网络中，优先使用容器服务名，不依赖公网 IP。

Token、行情数据源密钥、SSH 私钥等敏感信息不得提交到 Git。应提供 `.env.example`，实际 `.env` 加入 `.gitignore`。

## 7. MVP 验收标准

1. Bot 能连接 `.env` 配置的 OneBot WebSocket 地址，断线后自动重连。
2. 群内 `@bot 板块涨跌` 能在同一条回复中收到一张涨跌总览图片，其中包含行业和概念板块区块。
3. 未 `@bot` 或非群聊消息不会触发回复。
4. Bot 能使用 HTML/CSS 和 Playwright 生成可发送的 PNG 图片。
5. 回复图片展示行业、概念各自的涨幅 Top 10、跌幅 Top 10、板块涨跌幅和关联股票；行业板块与概念板块不混合排行。
6. OneBot 图片发送失败、行情源失败或数据不完整时有清晰错误提示。
7. 核心触发判断、行情格式化、图片渲染和 WebSocket API 调用有测试。
8. 本地地址和 Docker 部署地址只通过配置切换，不修改业务代码。

## 8. 暂不纳入 MVP

- 定时发送；
- 任意股票代码查询；
- 多群独立配置；
- 用户权限和管理员系统；
- 数据库存储；
- Web 管理后台；
- 除板块涨跌卡片以外的行情走势图、复杂图片渲染和历史数据分析；
- 投资建议或自动交易功能。

## 9. 待开发时确认的事项

- 部署 API Key 对同花顺指数目录、指数快照、成分股和 A 股快照的实际权限、稳定性、延迟、批量上限和使用条款；已确认的字段与限流口径见 [同花顺金融数据 API 接入调研](ths-financial-data-api.md)；
- 同花顺是否开放通用 A 股财经新闻 capability；
- `@bot` 消息在 NapCat/OneBot 事件中的实际消息段格式；
- 行业板块和概念板块的清单、数据源及展示格式；
- NapCat WebSocket Token 是否已启用；
- 远程服务器的 Docker 网络名称和 NapCat 容器监听配置。

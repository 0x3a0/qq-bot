# QQ Bot 行情图片 MVP 技术方案

## 1. MVP 目标

群成员在 QQ 群中 `@机器人 大盘`，机器人被动回复：

- 一张 A 股行业板块 Treemap 热力图
- 一张美股行业板块 Treemap 热力图

第一版不做定时推送、个股查询、自选股、订阅和管理后台。

## 2. 接入方向

- 使用 QQ 机器人 API v2。
- 通过 QQ Gateway WebSocket 接收 `GROUP_AT_MESSAGE_CREATE` 事件，只处理被 @ 的消息。
- 使用 `group_openid` 作为群标识。
- 通过 `POST /v2/groups/{group_openid}/messages` 回复群消息。
- 图片按富媒体消息发送：先上传图片获取 `file_info`，再使用 `msg_type=7` 发送。
- 被动群消息需要携带 `msg_id`，并在 5 分钟内完成回复。

官方文档：

- [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [群 @ 机器人事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)
- [发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
- [富媒体消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)
- [WebSocket 接入](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)

## 3. 技术选型

- Node.js 20+
- TypeScript
- `fetch`/`undici`：调用 QQ API 和行情接口
- `ws`：常驻部署时维护 QQ Gateway WebSocket
- `d3-hierarchy`：计算 Treemap 布局
- `@resvg/resvg-js` + `sharp`：SVG 转 PNG 和图片处理
- `zod`：校验外部行情与事件数据
- `vitest`：单元测试

MVP 直接使用 `fetch + ws` 封装 QQ API，明确控制 Token 刷新、重连、去重和富媒体上传；不依赖浏览器截图。

建议目录：

```text
src/
  qq/          # Token、WebSocket、消息上传
  market/      # A 股/美股数据源与统一模型
  render/      # Treemap 布局与 PNG 渲染
  commands/    # 大盘指令路由
```

## 4. 数据与图片

### A 股

第一版使用东方财富行业板块数据，取行业名称、涨跌幅和成交额。行情接口封装在独立的数据源模块中，图片上标注数据源和更新时间。

#### 百度股市通板块接口（备选源，规格见 `docs/API_BAIDU_BLOCKS.md`）

用户提供的浏览器请求对应接口如下，MVP 阶段作为**交叉校验/备选源**接入（主源仍为东方财富）：

- **接口**：`GET https://finance.pae.baidu.com/vapi/v2/blocks`
- **必要 Query 参数**：`market=ab`（A 股）、`typeCode=HY`（行业板块）、`sortKey=amount`、`sortType=desc`、`style=heatmap`、`pn=0`（0-based 页码）、`rn=100`（每页条数，实测 `rn=200` 可一次取全 131 个板块）、`finClientType=pc`
- **必要 Header**：`acs-token`、`Cookie`（至少 `BAIDUID`）、`accept: application/vnd.finance-web.v1+json`、`origin`、`referer`、`user-agent`
- **取数**：面积用 `rawData.amount`（元），颜色用 `rawData.pxChangeRate`（百分数）；**必须用 `rawData.*` 数值字段**，不要解析 `amount: "2093亿"` 这类中文格式化串
- **响应无行情时间字段**，需另取 `/vapi/v1/blocks/overview`（实测无需 `acs-token`）的 `minuteData.priceinfo[].time` 作为行情时间

⚠️ **两个硬约束**（均已实测，详见规格文档 §6）：

1. `acs-token` 由百度 ACS SDK（`https://dlswbr.baidu.com/heicha/mm/2108/acs-2108.js`）在**浏览器内**生成，重度混淆、无法在 Node 服务端复现；且疑似**不足 24 小时即失效**，需人工注入或 Playwright 供给。
2. 风控严格：约 **10–14 次/分钟**即返回 `403 {"Result":{"code":403,"msg":"hit risk","isCaptchaEnabled":true}}`，且冷却 **≥13 分钟未自动恢复**，保守按「会话级永久失效」处理（告警 + 换凭据，不可重试兜底）。因此必须 `rn=200` 一次取全 + 长缓存，禁止重试风暴。注意 403 时 `ResultCode` 仍为 `0`，**不能只看 `ResultCode` 判成功**。

### 美股

第一版使用 11 个 SPDR 行业 ETF 作为行业代理，例如科技 `XLK`、金融 `XLF`、能源 `XLE`。图片中明确标注“行业 ETF 代理”，后续再评估 Finnhub 等真正的行业聚合数据源。

### 图片

- 使用 Treemap 展示板块。
- 面积表示成交额或成交量权重。
- 颜色表示涨跌幅。
- 输出固定尺寸 PNG，目标小于 5 MB。
- 图片中显示市场、数据源和行情时间。

## 5. 处理流程

```text
WebSocket 事件
  -> 解析 @机器人 指令
  -> 查询缓存或行情数据
  -> 生成 A 股/美股图片
  -> 群聊富媒体上传
  -> 携带 msg_id 被动回复
```

需要具备：

- Access Token 自动刷新
- WebSocket 心跳、断线重连和 Resume
- `msg_id + msg_seq` 去重
- 行情短时缓存和失败兜底
- 数据源限流保护：行情缓存 TTL ≥ 5 分钟，同一数据源请求串行化并加最小间隔，**禁止失败重试风暴**（百度源 403 判定见 §4）
- 凭据注入：`acs-token` / `BAIDUID` 等会话级凭据从环境变量读取，不入库、不落日志

## 6. 部署方案：Railway + WebSocket

使用 Railway 部署一个常驻 Node.js 服务，程序启动后主动连接 QQ Gateway。

```text
Railway Node.js 服务
  -> QQ Gateway WebSocket：接收事件、心跳、重连
  -> QQ HTTP API：获取 Token、上传图片、发送群消息
```

Railway 配置要点：

- 使用常驻 Service，不使用一次性任务。
- 将 `APP_ID`、`CLIENT_SECRET` 等敏感配置放入 Railway Variables。
- 程序必须持续运行，并处理平台重启和部署重启。
- 记录 Gateway 连接、心跳、重连和消息发送日志。
- 不依赖本地磁盘保存重要数据；MVP 的短期缓存和去重状态可先放在进程内。
- 关注 Railway 当前套餐的运行时长、休眠和费用规则。

本 MVP 暂不实现 Webhook，也不部署到 Vercel。后续如需要 Serverless 再单独设计 Webhook + 队列架构。

## 7. 里程碑

1. 测试群中完成机器人注册和 `@` 事件接收。
2. 完成 Token、WebSocket 和文本回复。
3. 完成 A 股数据与 Treemap 图片。
4. 完成富媒体上传并发送 A 股图片。
5. 接入美股 ETF 数据并发送第二张图片。
6. 补齐缓存、重连、错误处理和单元测试。
7. （可选）按 `docs/API_BAIDU_BLOCKS.md` 接入百度股市通板块接口，作为 A 股数据的交叉校验或备选源；需先解决 `acs-token` 供给与限流保护。

## 8. MVP 验收标准

在测试群中发送 `@机器人 大盘`，能够在 5 分钟内收到两张带有更新时间和数据源标记的行情图片；重复事件不会重复发图；数据源或图片生成失败时能够返回文字错误提示。

数据源相关补充验收项（对应 §4 百度源）：

- 单次会话内不因请求过密触发 `403 hit risk`；命中风控时降级到缓存或主源，不重试。
- 判定成功必须同时校验 HTTP 状态码与业务码，不能只看 `ResultCode == 0`。
- 图片上的「行情时间」来源明确：若数据源无时间戳，则标注为采集时间并写明与行情时间的差异。

# QQ Bot 行情图片 MVP 技术方案

## 1. MVP 目标

群成员在 QQ 群中 `@机器人 大盘`，机器人被动回复：

- 一张 A 股行业板块 Treemap 热力图

第一版只做 A 股行业板块，不做美股、定时推送、个股查询、自选股、订阅和管理后台。

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
  market/      # 东方财富 A 股行业数据源
  render/      # Treemap 布局与 PNG 渲染
  commands/    # 大盘指令路由
```

## 4. 数据与图片

### A 股

第一版只使用东方财富行业板块数据，接口方向如下：

```text
GET https://push2delay.eastmoney.com/api/qt/clist/get
```

使用 `fs=m:90+t:2` 获取行业板块，并读取以下字段：

| 字段 | 用途 |
|---|---|
| `f12` | 板块代码 |
| `f14` | 板块名称 |
| `f3` | 涨跌幅（%） |
| `f6` | 成交额（元） |
| `f124` | 行情时间戳 |

处理规则：

- 接口单页最多返回约 100 条，分页获取全部行业板块。
- 不依赖接口的排序结果，在 TypeScript 中按 `f6` 成交额降序排序。
- 过滤成交额缺失、非数字或小于等于零的数据。
- 排序后只取前 20 个行业板块用于生成图片。
- 对行情结果设置短时缓存，图片上标注“东方财富”和 `f124` 对应的行情时间。
- 东方财富接口属于公开网页行情接口，没有稳定性保证；MVP 暂不接入备用数据源。

### 图片

- 使用 Treemap 展示板块。
- 每张图展示成交额排名前 20 的行业板块。
- 矩形面积使用成交额 `f6`。
- 矩形颜色使用涨跌幅 `f3`。
- 输出固定尺寸 PNG，目标小于 5 MB。
- 图片中显示市场、数据源和行情时间。

## 5. 处理流程

```text
WebSocket 事件
  -> 解析 @机器人 指令
  -> 查询缓存或行情数据
  -> 按成交额降序取前 20 个行业
  -> 生成 A 股 Treemap 图片
  -> 群聊富媒体上传
  -> 携带 msg_id 被动回复
```

需要具备：

- Access Token 自动刷新
- WebSocket 心跳、断线重连和 Resume
- `msg_id + msg_seq` 去重
- 行情短时缓存和失败兜底

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
3. 完成东方财富全量行业取数、成交额排序和前 20 筛选。
4. 完成富媒体上传并发送 A 股图片。
5. 补齐缓存、重连、错误处理和单元测试。

## 8. 本地运行与验证

第一版本地实现在 `src/` 下，按以下步骤验证「能否正常收到 QQ 群用户的消息」：

```bash
npm install
copy .env.example .env       # 填入 APP_ID / CLIENT_SECRET
npm run verify:market        # 行情取数（无需凭据）
npm run render:sample        # 本地出图（无需凭据）
npm run verify:qq            # Token + Gateway 接入点自检
npm run verify:inbound       # ★ 监听并打印 GROUP_AT_MESSAGE_CREATE 事件
npm start                    # 启动机器人，群内 @机器人 大盘 出图
```

实现要点与 MVP 方案的对应关系：

| 方案要求 | 实现位置 |
|---|---|
| Access Token 自动刷新 | `src/qq/token.ts`（提前 5 分钟刷新，合并并发请求） |
| WebSocket 心跳、断线重连与 Resume | `src/qq/gateway.ts`（按官方错误码决定 resume 或 identify） |
| `msg_id + msg_seq` 去重 | `src/qq/dedupe.ts` |
| 会话持久化（重启后 Resume） | `src/qq/session-store.ts`（缓存绑定 AppID 与接入点，换账号自动失效） |
| 行情短时缓存和失败兜底 | `src/market/eastmoney.ts`、`src/market/cache.ts`、`src/commands/bot.ts` |
| 全量行业取数、成交额排序与前 20 筛选 | `src/market/eastmoney.ts` |
| 富媒体分片上传（本地开发无需公网 URL） | `src/qq/api-client.ts` |
| Treemap 布局与 PNG 渲染 | `src/render/treemap.ts`、`src/render/image.ts` |

待验证事项（需要真实机器人凭据与测试群）：

1. Gateway 能否收到 `GROUP_AT_MESSAGE_CREATE`（`npm run verify:inbound`）。
2. 群聊富媒体分片上传接口在真实环境的字段与分片行为。
3. 被动回复 5 分钟时效与 5 次回复上限的实际表现。

## 9. MVP 验收标准

在测试群中发送 `@机器人 大盘`，能够在 5 分钟内收到一张 A 股行业板块图片；图片包含按成交额降序筛选的前 20 个行业，并标注东方财富数据源和行情时间；重复事件不会重复发图；数据源或图片生成失败时能够返回文字错误提示。

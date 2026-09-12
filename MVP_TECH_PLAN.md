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

第一版使用东方财富**行业板块资金流**与**概念板块资金流**数据，两者是同一接口换用 `fs` 参数。

#### 行业板块

```text
GET https://push2delay.eastmoney.com/api/qt/clist/get
    ?fs=m:90 t:2
    &fid=f62
    &pn=1
    &pz=100
    &po=1
    &np=1
    &fltt=2
    &invt=2
    &ut=b2884a393a59ad64002292a3e90d46a5
    &fields=f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,
            f164,f165,f166,f167,f168,f169,f170,f171,f172,f173,
            f174,f175,f176,f177,f178,f179,f180,f181,f182,f183,
            f124,f104,f105,f106,f204,f205
```

请求参数：

| 参数 | 值 | 用途 |
|---|---|---|
| `fs` | `m:90 t:2` | **行业板块**筛选（`m:90` 为板块市场，`t:2` 为行业；实测 496 个） |
| `fid` | `f62`（今日）/ `f164`（5日）/ `f174`（10日） | 排序字段：主力净流入额降序 |
| `pn` | 页码，从 `1` 开始 | 分页取全量 |
| `pz` | 每页条数，`100` | 接口上限为 100，传更大值仍只返回 100 条 |
| `po` | `1` | 排序方向：1 降序 |
| `np` | `1` | 响应中 `diff` 返回为数组（否则为以序号为键的对象） |
| `fltt` | `2` | 数值不做缩放（保留原始「元」） |
| `invt` | `2` | 数值不做反色处理 |
| `ut` | `b2884a393a59ad64002292a3e90d46a5` | 网页端固定 token，可省略 |
| `fields` | 见下方字段表 | 逗号分隔的字段白名单 |

读取字段：

| 字段 | 用途 |
|---|---|
| `f12` | 板块代码（如 `BK0448`） |
| `f14` | 板块名称 |
| `f3` | 涨跌幅（%） |
| `f2` | 板块指数点位 |
| `f62` | **主力净流入额（元）**，今日 |
| `f184` | 主力净流入占比（%），今日 |
| `f66` / `f69` | 超大单净流入额（元）/ 占比（%） |
| `f72` / `f75` | 大单净流入额（元）/ 占比（%） |
| `f78` / `f81` | 中单净流入额（元）/ 占比（%） |
| `f84` / `f87` | 小单净流入额（元）/ 占比（%） |
| `f164`~`f173` | 同上五项净额与占比，**5 日**口径 |
| `f174`~`f183` | 同上五项净额与占比，**10 日**口径 |
| `f124` | 行情时间戳（秒） |
| `f104` / `f105` / `f106` | 板块内上涨 / 下跌 / 平盘家数 |
| `f204` / `f205` | 领涨股名称 / 代码 |

#### 概念板块

```text
GET https://push2delay.eastmoney.com/api/qt/clist/get
    ?fs=m:90 t:3
    &fid=f62
    &pn=1
    &pz=100
    &po=1
    &np=1
    &fltt=2
    &invt=2
    &ut=b2884a393a59ad64002292a3e90d46a5
    &fields=f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,
            f164,f165,f166,f167,f168,f169,f170,f171,f172,f173,
            f174,f175,f176,f177,f178,f179,f180,f181,f182,f183,
            f124,f104,f105,f106,f204,f205
```

请求参数：

| 参数 | 值 | 用途 |
|---|---|---|
| `fs` | `m:90 t:3` | **概念板块**筛选（`t:3` 为概念；实测 504 个） |
| `fid` | `f62`（今日）/ `f164`（5日）/ `f174`（10日） | 同行业板块 |
| 其余参数 | 与行业板块完全一致 | `pn` / `pz` / `po` / `np` / `fltt` / `invt` / `ut` / `fields` |

读取字段：与行业板块**完全一致**（同一套 `f*` 字段号）。

> `fs` 中的空格是字面空格，URL 编码后为 `m%3A90+t%3A2` / `m%3A90+t%3A3`；写成 `+` 亦可被接受。

#### 单板块资金流明细（分钟 / 日线）

```text
GET https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get
    ?secid=90.BK0448
    &klt=1
    &lmt=0
    &fields1=f1,f2,f3,f7
    &fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65
    &ut=b2884a393a59ad64002292a3e90d46a5
```

| 参数 | 值 | 用途 |
|---|---|---|
| `secid` | `90.BKxxxx` | 板块标识，**前缀固定为 `90`**（个股为 `0.` / `1.`） |
| `klt` | `1` / `101` | `1` 分钟级（实测 240 个点位）/ `101` 日线 |
| `lmt` | `0` | `0` 表示不限条数 |
| `fields2` | `f51..f56` | 决定 `klines` 每行的字段顺序 |

`klines` 每行为逗号分隔字符串，实测字段顺序为 **时间 → 主力 → 小单 → 中单 → 大单 → 超大单**：

```text
"2026-09-11 15:00, 4741400325, 776177089, -5434456943, 650211015, 4091189310"
   f51 时间       f52 主力     f53 小单     f54 中单     f55 大单     f56 超大单
```

处理规则：

- 接口单页最多返回 100 条，按 `pn` 分页获取全部板块（行业 5 页 / 概念 6 页）。
- 接口已按 `fid` 降序返回，但不依赖该顺序，在 TypeScript 中统一按 `f62`（主力净流入额）重新降序排序。
- 过滤板块代码或名称缺失、主力净额缺失或非数字的数据，并按板块代码去重。
- 排序后只取前 25 个板块用于生成图片。
- 对资金流结果设置短时缓存（默认 60 秒，按「板块类型 + 周期」分键），图片上标注“东方财富”和 `f124` 对应的行情时间。
- 请求带浏览器 `User-Agent` 与 `Referer: https://data.eastmoney.com/bkzj/hy.html`。
- 金额字段单位统一为「**元**」，展示时再换算成亿 / 万。
- 主接口用 `push2delay.eastmoney.com`（实测稳定），`push2.eastmoney.com` 数据一致但实测易 `ECONNRESET`，作备用主机；网络类错误需读 `error.cause.code` 后退避重试。
- 东方财富接口属于公开网页行情接口，无鉴权、无稳定性保证；MVP 暂不接入别的数据源。

已实测校验（`npm run verify -- fundflow [today|5d|10d]`，三个周期均通过）：

- 分页取回条数与 `data.total` 完全一致：行业 `496 = 496`，概念 `504 = 504`（无遗漏、无重复）。
- `f62 = f66 + f72`（主力 = 超大单 + 大单）在 496/496、504/504 个板块上**严格成立**，5 日 / 10 日同样成立。
- 接口返回顺序确为按 `fid` 降序；`f62 + f78 + f84 ≈ 0`（资金守恒，偏差来自服务端四舍五入）。

完整字段表、主机可用性对比与全部踩坑记录见 [README](./README.md#东方财富资金流接口行业--概念)；
代码入口为 `src/market/fundflow.ts`。

### 图片

- 使用 Treemap 展示板块。
- 每张图展示主力净流入额排名前 25 的板块。
- 矩形面积使用主力净流入额 `f62`（今日口径）。
- 矩形颜色使用涨跌幅 `f3`。
- 输出固定尺寸 PNG（1200x900），目标小于 5 MB。
- 头部显示板块类型、周期、数据源与 `f124` 对应的行情时间，例如：
  `东方财富 · 行业板块今日主力净流入 TOP25 · 行情时间 09-11 15:39`。

## 5. 处理流程

```text
WebSocket 事件
  -> 解析 @机器人 指令
  -> 并发查询缓存或资金流数据（行业 / 概念）
  -> 各自按主力净流入额降序取前 25 个板块
  -> 各自生成 A 股 Treemap 图片
  -> 各自由群聊富媒体上传
  -> 渲染完成即发送（msg_type=7），不等另一张
```

两张图**并发且互不阻塞**：先渲染完的先发，`msg_seq` 按实际发送顺序分配。
`大盘` 不发送文字数据，仅在两张图都失败时回一条错误说明。

需要具备：

- Access Token 自动刷新
- WebSocket 心跳、断线重连和 Resume
- `msg_id + msg_seq` 去重
- 资金流短时缓存和失败兜底

## 6. 部署方案：Render + WebSocket

部署一个常驻 Node.js 服务，程序启动后主动连接 QQ Gateway。

```text
Render 服务（Web Service 或 Background Worker）
  -> QQ Gateway WebSocket：接收事件、心跳、重连
  -> QQ HTTP API：获取 Token、上传图片、发送群消息
```

部署配置要点：

- 使用常驻服务，不使用一次性任务 / Cron Job。
- 仓库提供 `render.yaml` 蓝图，Blueprint 部署时自动识别。
- 将 `APP_ID`、`CLIENT_SECRET` 放入控制台的 Environment Variables
  （`.env` 不提交仓库，蓝图里标记 `sync: false`）。
- 构建：`npm run build`（`tsconfig.build.json`）产出 `dist/`，
  启动命令 `node dist/index.js`（运行时不依赖 tsx）。
- **实例数必须为 1**：WebSocket 长连接 + 进程内去重，多实例会让同一条群消息被回复多次。
- **必须关闭 Zero-Downtime Deploy**：否则新实例起来后旧实例还会存活约 60 秒，
  两个实例同时连着 Gateway，同一条消息被回复两次。
- **Web Service 必须绑定 `PORT`**：程序仅在检测到 `PORT` 时监听一个 `/health`
  （就绪状态跟随 Gateway），本地运行不开监听。若用 Background Worker
  （更贴合常驻任务，但仅付费实例）则无需端口。
- **免费实例 15 分钟无流量会休眠**，群内长时间无人 @ 机器人时收不到消息；
  要稳定常驻需付费实例或 Background Worker。
- **必须确保运行环境有中文字体**：resvg 缺字体时静默不画文字（图只剩色块），
  启动时的字体探针会明确告警；可靠做法是把字体文件放进仓库并设 `FONT_FILES`。
- 程序处理平台重启与部署重启（已处理 SIGTERM 优雅退出）。
- 记录 Gateway 连接、心跳、重连和消息发送日志。
- 不依赖本地磁盘保存重要数据；MVP 的短期缓存和去重状态放在进程内。

完整步骤与排查见 [README](./README.md#部署到-render)。

本 MVP 暂不实现 Webhook，也不部署到 Vercel。后续如需要 Serverless 再单独设计 Webhook + 队列架构。

## 7. 里程碑

1. 测试群中完成机器人注册和 `@` 事件接收。
2. 完成 Token、WebSocket 和文本回复。
3. 完成东方财富全量行业 / 概念板块资金流取数、主力净额排序和前 25 筛选。
4. 完成富媒体上传并发送两张 A 股图片（行业 + 概念）。
5. 补齐缓存、重连、错误处理和单元测试。

## 8. 本地运行与验证

第一版本地实现在 `src/` 下，按以下步骤验证「能否正常收到 QQ 群用户的消息」：

```bash
npm install
copy .env.example .env       # 填入 APP_ID / CLIENT_SECRET
npm run verify -- fundflow   # 资金流取数与自校验（无需凭据）
npm run verify -- render     # 本地出两张图（无需凭据）
npm run verify -- qq         # Token + Gateway 接入点自检
npm run verify -- inbound    # ★ 监听并打印 GROUP_AT_MESSAGE_CREATE 事件
npm start                    # 启动机器人，群内 @机器人 大盘 出图
```

实现要点与 MVP 方案的对应关系：

| 方案要求 | 实现位置 |
|---|---|
| Access Token 自动刷新 | `src/qq/token.ts`（提前 5 分钟刷新，合并并发请求） |
| WebSocket 心跳、断线重连与 Resume | `src/qq/gateway.ts`（按官方错误码决定 resume 或 identify，含 Resume 看门狗） |
| `msg_id + msg_seq` 去重 | `src/qq/dedupe.ts`、`src/commands/bot.ts`（并发链路下按发送顺序分配 seq） |
| 会话持久化（可选 Resume） | `src/qq/session-store.ts`（缓存绑定 AppID 与接入点，换账号自动失效；默认不 Resume） |
| 资金流短时缓存和失败兜底 | `src/market/fundflow.ts`、`src/market/cache.ts`、`src/commands/bot.ts` |
| 全量行业/概念取数、主力净额排序与前 25 筛选 | `src/market/fundflow.ts`、`src/market/sectors.ts` |
| 富媒体分片上传（本地开发无需公网 URL） | `src/qq/api-client.ts` |
| Treemap 布局与 PNG 渲染 | `src/render/treemap.ts`、`src/render/image.ts` |

已在测试群实测确认：

1. ✅ Gateway 能收到 `GROUP_AT_MESSAGE_CREATE`，`@机器人 ping` 与 `@机器人 大盘` 均正常回复。
2. ✅ 群聊富媒体分片上传链路已跑通（`upload_prepare` → PUT → `upload_part_finish` → 合并），
   群内成功收到 1200x900 热力图。**注意服务端下发的 `parts[].index` 是 1-based**，
   与文档示例的 0-based 不一致，分片偏移必须按 `(index - 1) * blockSize` 计算。
3. ⏳ 被动回复 5 分钟时效与 5 次回复上限尚未测试（需构造超时/重复场景）。

## 9. MVP 验收标准

在测试群中发送 `@机器人 大盘`，能够在 5 分钟内收到**两张图片**：
行业板块与概念板块各一张主力净流入 TOP25 热力图。两张图先渲染完的先送达；
图片标注数据源、板块类型、周期与行情时间；重复事件不会重复回复；
数据源或图片生成失败时能够返回文字错误提示。

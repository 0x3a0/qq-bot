# 单聊（C2C）指令支持 · 技术方向文档

> 目标读者：维护者本人 / 后续接手的人。
> 定位：在现有「群 @ 机器人」实现之上，**增量**支持 QQ 单聊（私聊）场景，
> 复用同一套取数、渲染与指令语义，只给出方向与关键决策，不含逐行实现。
> 现状基线见 [MVP_TECH_PLAN.md](./MVP_TECH_PLAN.md)，字段与踩坑见
> [API_EASTMONEY_FUNDFLOW.md](./API_EASTMONEY_FUNDFLOW.md)、[DEPLOYMENT.md](./DEPLOYMENT.md)。

## 1. 目标与非目标

### 目标

用户在 **QQ 单聊**里直接对机器人发消息（不需要 @），机器人回复：

| 用户消息 | 机器人回复 |
|---|---|
| `大盘` | 两张图：行业板块 + 概念板块主力净流入 TOP25 热力图（各自渲染完即发） |
| `ping` | `pong · 机器人在线 · 时间` 文本 |
| `帮助` | 指令说明 |
| 其它 | 忽略，不回复 |

验收口径与群聊完全一致：**同一句话、同一套图、同一套兜底**，区别只在消息通道。

### 非目标

- 不做主动推送 / 定时推送到单聊（受频控 + 用户开关限制，另立需求）。
- 不做互动召回（`is_wakeup`）、订阅消息、内嵌键盘按钮。
- 不做流式消息（`/v2/users/{user_openid}/stream_messages`）。
- 不改动行情数据源、Treemap 渲染与排版逻辑。

## 2. 关键结论（先看这段）

1. **不需要改 Intent**。`GROUP_AND_C2C_EVENT (1<<25)` 同时覆盖群聊与单聊事件，
   当前 `DEFAULT_INTENTS = 1 << 25` 已经正确，单聊事件本来就会推过来，
   只是代码里没监听 `C2C_MESSAGE_CREATE`，被静默丢弃。
   → 这既是好消息（改动小），也是排查线索（"收不到单聊消息"先看事件监听，而不是订阅）。
2. **事件体与群聊高度同构**：同样是 `id`（用于被动回复）+ `author` + `content` +
   `message_scene.ext` 里的 `msg_idx`，只是没有 `group_openid`，改为 `author.user_openid`。
3. **发送与上传的路径不同，且文件不互通**：
   单聊要用 `/v2/users/{user_openid}/...` 三个接口，
   群聊上传得到的 `file_info` **不能**用于单聊发送（官方明确：单聊和群聊的文件上传接口不互通）。
4. **限制参数与群聊不同**，代码里写死的常量必须按通道取值（见第 4 节表格）。
5. **主要风险不在代码，而在平台侧**：机器人是否具备单聊能力、是否需要加好友、
   沙箱是否支持单聊、是否需要认证/上线，属于外部依赖，**必须先手工验证再动手**（见第 8 节）。

## 3. 当前实现盘点（复用面）

现有链路：`Gateway WebSocket → GROUP_AT_MESSAGE_CREATE → 指令解析 → 去重 → 并发取数/渲染/上传 → msg_type=7 回复`。
单聊要做的，本质上是把这条链路的**两端**换掉，中间全部复用。

| 环节 | 现状 | 单聊改造 |
|---|---|---|
| 事件订阅 | `GROUP_AT_MESSAGE_CREATE` | 新增 `C2C_MESSAGE_CREATE`，**平级**监听 |
| 指令解析 | 关键词匹配 `大盘/ping/帮助` | 逻辑可原样复用（群事件已去掉 @ 前缀，单聊本来就没有前缀） |
| 事件去重 | `msg_id` 级去重 | 复用，键里带上通道与目标，避免群/单聊撞键 |
| 行情取数 | 进程内 60s 缓存 + 请求合并 | **完全复用**（多用户同时问不放大请求量） |
| 渲染 | Treemap → PNG（含内容级缓存） | **完全复用**，同一张图可发多人 |
| 富媒体上传 | 群聊分片上传 | 新增单聊版（三接口同构，仅路径不同） |
| 发送 | 群聊 `msg_type=0 / 7` | 新增单聊版（请求体字段与群聊一致） |
| 兜底 | 单张失败照发、两张全败发文字、`msg_seq` 用尽停发 | 复用，但**次数上限按通道取值** |
| 部署 / 单实例 / 健康检查 / 字体探针 | 与通道无关 | **完全不动** |

结论：**约七成代码零改动**，新增集中在 `src/qq/`（客户端与事件）与 `src/commands/`（回复目标抽象）。

## 4. 平台约束对照（必须按通道区分）

| 维度 | 群聊 | 单聊 | 对代码的影响 |
|---|---|---|---|
| 事件名 | `GROUP_AT_MESSAGE_CREATE` | `C2C_MESSAGE_CREATE` | 新增监听分支 |
| 目标标识 | `group_openid` | `author.user_openid` | 引入统一的「回复目标」 |
| 发消息 | `POST /v2/groups/{group_openid}/messages` | `POST /v2/users/{user_openid}/messages` | 新增客户端方法 |
| 预上传 | `/v2/groups/{group_openid}/upload_prepare` | `/v2/users/{user_openid}/upload_prepare` | 新增 |
| 分片完成 | `/v2/groups/{group_openid}/upload_part_finish` | `/v2/users/{user_openid}/upload_part_finish` | 新增 |
| 合并 | `/v2/groups/{group_openid}/files` | `/v2/users/{user_openid}/files` | 新增 |
| **被动回复有效期** | 5 分钟 | **60 分钟** | 常量按通道取值 |
| **单条消息可回复次数** | 5 次 | **4 次** | 写死的 5 要变成按通道取值 |
| 引用回复 | `message_reference.message_id = msg_idx` | 同左 | 复用 |
| 去重错误码 | `40054005` | 同左 | 复用重试逻辑 |
| 长度 / 内容错误 | — | `40054007` 超长、`40054013` 用户拒收、`40054004` 无好友关系 | 错误提示需能区分"不是我们的 bug" |

> 两处易踩的坑：
> - 群聊 5 次 × 2 张图刚好用满 `msg_seq 1..5`；**单聊只有 4 次**，两张图 + 一条兜底文字正好是 3 次，
>   余量更小，`msg_seq` 判重重试要更保守，用尽后必须干净地停手（不要退化成主动消息硬发）。
> - 官网页面对被动回复时效的表述在"发送单聊消息"页与"消息收发概述"页曾出现口径差异，
>   实现按 **60 分钟 / 4 次**（概述页表格，较新）取值，但把上限做成配置项便于现场调整。

## 5. 目标架构

一个 `GroupMessageHandler` 泛化为 **`MessageHandler`**，输入是「回复目标」，而不是硬编码的 `group_openid`。

```text
                   ┌──────────────────────────────┐
Gateway ──┬──────► │ GROUP_AT_MESSAGE_CREATE       │──┐
          │        └──────────────────────────────┘  │
          │        ┌──────────────────────────────┐  │   统一入参
          └──────► │ C2C_MESSAGE_CREATE           │──┼──► MessageTarget
                   └──────────────────────────────┘  │    { channel, targetId, messageId,
                                                      │      content, username, messageReference }
                                                      ▼
                                        ┌───────────────────────────────┐
                                        │ MessageHandler                │
                                        │ 去重 → 指令解析 → 取数 → 渲染  │  ← 与通道无关，
                                        │ → 上传 → 发送 → 兜底           │     群聊代码原样保留
                                        └───────────┬───────────────────┘
                                                    ▼
                                        ┌───────────────────────────────┐
                                        │ ReplyTransport（按通道分派）   │
                                        │  group: /v2/groups/...        │
                                        │  c2c  : /v2/users/...         │
                                        └───────────────────────────────┘
```

设计取舍：

- **不用继承做两套 Handler**（`GroupHandler` / `C2cHandler`）：两条链路的 90% 完全一致，
  分叉点只有「路径前缀」和「回复次数上限」，用策略（目标 + 通道参数表）比复制一份实现更好维护。
- **不在 Handler 里散落 `if (channel === 'c2c')`**：通道差异集中到两处——发送客户端与通道参数表，
  其余代码不应感知通道存在。
- 保留现有 `GroupMessageHandler` 作为薄壳或直接改名都可以，但对外只暴露一个 `handle(target)`。

## 6. 改动清单（按文件）

方向级说明，不逐行展开。

### 6.1 `src/qq/types.ts` — 类型

- 新增 `C2cMessageCreateData`（`id` / `author` / `content` / `message_scene` / `message_type` / `timestamp`）。
- 抽出与群聊事件共用的基类：`id` + `author` + `content` + `message_scene` + `timestamp`。
- `extractMessageIndex()` 已按 `msg_idx=` 解析，单聊事件同样是这个 key，**直接复用**。
- 单聊事件 `author.user_openid` 才是发送目标；`author.id` 与之同值但语义上优先用 `user_openid`。

### 6.2 `src/qq/gateway.ts` — 事件

- 在 dispatch 分支里平级新增 `C2C_MESSAGE_CREATE`：
  校验 `data.id && data.author?.user_openid`，缺字段时打印告警并丢弃（与群聊分支对称）。
- 新增事件：`c2cMessage(data, event)`，挂在现有 `GatewayEvents` 接口上。
- 心跳、重连、Resume、看门狗等**一律不动**。

### 6.3 `src/qq/api-client.ts` — 客户端（本次改动最集中的地方）

- 抽出内部私有方法 `sendMessageByPath({ path, ... })`，群聊 / 单聊两个公开方法共用请求体拼装
  （`msg_type` / `content` / `media` / `msg_id` / `msg_seq` / `message_reference` 字段完全一致）。
- 新增公开方法：
  - `sendC2cText({ userOpenid, content, msgId?, msgSeq?, messageReference? })`
  - `sendC2cImage({ userOpenid, fileInfo, msgId?, msgSeq?, messageReference? })`
  - `uploadC2cFileFromBuffer({ userOpenid, buffer, fileName, fileType })`
- 群聊的四个上传步骤（`upload_prepare` → PUT 分片 → `upload_part_finish` → 合并）逻辑完全同构，
  内部方法参数化「路径前缀」即可，**分片偏移按 `(index - 1) * blockSize` 的既有结论必须保留**
  （服务端下发 `index` 实测为 1-based）。
- 显式在日志里标注"群聊上传 / 单聊上传"，避免排查时把两种 `file_info` 搞混。

### 6.4 `src/commands/` — 指令与处理

- 新增 `MessageTarget` 类型（通道 + 目标 ID + 消息 ID + 内容 + 昵称 + 引用 ID）。
- `MessageHandler`（原 `GroupMessageHandler`）：
  - 入参换成 `MessageTarget`；
  - `MAX_REPLY_SEQ` 由常量改为**按通道取值**（群聊 5 / 单聊 4）；
  - 上传与发送改为调用「按通道分派」的方法；
  - 其余流程（并发两图、先渲染完先发、`msg_seq` 认领、判重重试、部分失败、全败兜底）保持不变。
- `parser.ts`：关键词表原样复用。可加一层防御——若内容里仍带 `<@!...>` 形式的提及则先剥离
  （个别客户端把 @ 文本带进单聊内容时更稳）。
- `HELP_TEXT` 增加单聊说明（同一条帮助文案要能同时适配群内 @ 和私聊两个场景）。

### 6.5 `src/config.ts` + `.env.example` — 配置

- `ALLOWED_GROUPS`（已有概念）之外新增 `ALLOWED_USERS`：单聊用户白名单，空 = 不限制。
- 新增 `C2C_ENABLED`（默认 `true`）：一键关闭单聊通道，用于出问题时快速回退。
- 新增 `C2C_MAX_REPLY_SEQ`（默认 `4`）：把平台口径做成可调，避免硬编码过期。
- 日志脱敏：`openid` 只打印前 8 位 + 省略号（单聊是私人会话，日志里不必留全量 ID）。

### 6.6 `src/index.ts` — 装配

- 新增 `gateway.on('c2cMessage', ...)`：抽取 `author.user_openid` 与 `msg_idx`，
  组装 `MessageTarget` 后交给同一个 `MessageHandler`。
- 去重键形如 `${channel}:${targetId}:${messageId}#event`，与群聊键不冲突。
- 启动日志补一句："现在也可以在 QQ 单聊里直接对机器人发「大盘」或「ping」"。

### 6.7 不需要动的部分（明确写出来，避免改动扩散）

`market/`（取数、缓存、格式化）、`render/`（Treemap、配色、字体探针、渲染缓存）、
`health-server.ts`、`instance-lock.ts`、`session-store.ts`、`token.ts`、`render.yaml`、
以及 `DEPLOYMENT.md` 描述的部署形态（仍是单实例常驻 WebSocket）。

## 7. 测试方向

沿用现有 vitest 体系，重点补三类：

1. **Handler 级（参数化通道）**：把现有 `bot-handler.test.ts` 的用例改成对
   `group` / `c2c` 两个通道各跑一遍，断言：两图发送、`msg_seq` 递增、引用字段、
   单张失败照发、两张全败发文字、判重重试、**单聊用满 4 次即停**（而不是 5 次）。
   → 参数化改造能让同一套断言同时守住两条链路，避免"群聊改了单聊回归"。
2. **API 客户端级（防串通道）**：
   - 单聊方法必须打到 `/v2/users/{id}/...`，群聊方法必须打到 `/v2/groups/{id}/...`；
   - 单聊分片上传的三步路径均不得出现 `groups`；
   - 请求体字段与现有群聊一致（`msg_type` / `msg_seq` / `message_reference`）。
3. **Gateway 级**：投递 `C2C_MESSAGE_CREATE` 报文时触发 `c2cMessage`；
   缺 `user_openid` 时只告警不崩；群聊事件行为不回归。
4. **不做**：行情取数与渲染无需新增测试（未改动）。

交付前照旧跑通 `npm run typecheck`、`npm test`、`npm run check`，
并按 `AGENTS.md` 要求提交 commit 与推送。

## 8. 落地顺序与前置验证（★ 先做这一步）

代码量不大，**风险几乎全在平台侧**。建议顺序：

1. **前置手工验证（不写代码）**
   - 在 QQ 开放平台确认机器人是否具备单聊能力、是否需要认证/上线；
   - 用测试 QQ 号**添加机器人为好友**，直接私聊发一句话；
   - 用现有代码 + `LOG_EVENTS=true` 跑一次 `npm start` 或 `npm run verify -- inbound`，
     看是否打印出 `C2C_MESSAGE_CREATE` 事件。
   - 若这一步收不到事件 → 属于平台配置问题（未加好友 / 沙箱不支持单聊 / 未开通），
     **改代码无用**，先解决平台侧。
2. 新增事件类型 + Gateway 监听 + `index.ts` 装配，做到"能收到并打印单聊事件"。
3. 客户端补单聊发送与上传方法（含"防串通道"测试），先用 `ping` 打通**文本**闭环。
4. 接入 `大盘` 图片链路（复用现有渲染与兜底），确认单聊能收到两张图与引用回复。
5. 补齐参数化测试、README / 帮助文案、`.env.example`，最后提交。

### 验证命令的扩展方向

- `npm run verify -- inbound [秒]` 升级为**同时监听群与单聊**，并在事件里区分打印通道；
  或在不动现有子命令语义的前提下新增 `inbound-c2c`。
- `npm run verify -- upload <group_openid>` 旁边补一个单聊版（`upload-c2c <user_openid>`），
  用于独立诊断单聊分片上传，避免和发送逻辑混在一起排查。
- 新增 `npm run verify -- send-c2c <user_openid> ping`：只发一条被动文本，
  用于验证"平台是否允许我们回复这个用户"（好友关系、拒收、频控）。

## 9. 验收标准

在测试 QQ 号与机器人的**单聊**会话中：

1. 发送 `大盘`，5 分钟内收到**两张**热力图（行业 + 概念，先渲染完的先送达），
   图片标注数据源 / 板块类型 / 周期 / 行情时间；
2. 发送 `ping` 收到 `pong` 文本；发送 `帮助` 收到指令说明；
3. 图片以**引用回复**形式挂在用户消息下（事件带 `msg_idx` 时）；
4. 重复推送的同一事件不会重复回复；单聊 `msg_seq` 不越过 4 次上限；
5. 数据源或渲染失败时收到文字错误提示（而不是静默无响应）；
6. **群聊行为零回归**：原群内 `@机器人 大盘` 仍返回两张图，
   且多用户并发问单聊时，行情接口请求量不随人数线性放大（缓存命中）。

## 10. 开放问题

- 单聊与群聊事件在同一 Intent 下，是否需要按通道做**独立开关**（`C2C_ENABLED` 已预留）？
- 冷启动时若有多个用户几乎同时提问，是否需要为"图片上传"也加一层按内容去重
  （同一张 PNG 对多用户重复上传会放大 QQ 侧 QPS）？先观察，不预优化。
- 是否需要单聊错误指标（按通道统计失败原因）？先只打日志，有真实故障再考虑。
- 单聊是否要限制"仅白名单用户可用"（防陌生人刷图 + 省 QQ 侧额度）？
  `ALLOWED_USERS` 已预留，默认不限制以便测试。

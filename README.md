# QQ 群机器人 · A 股板块资金流热力图（MVP）

群成员在 QQ 群里 `@机器人 大盘`，机器人被动回复**两张** Treemap 热力图：
行业板块 TOP25 与概念板块 TOP25（按主力净流入额排序）。

技术方案见 [MVP_TECH_PLAN.md](./MVP_TECH_PLAN.md)。

- 事件接入：QQ 机器人 API v2 · Gateway WebSocket · `GROUP_AT_MESSAGE_CREATE`
- 数据源：东方财富板块资金流接口（行业 `fs=m:90 t:2` / 概念 `fs=m:90 t:3`，按 `f62` 主力净流入排序）
- 出图：d3-hierarchy squarified Treemap → SVG → PNG（`@resvg/resvg-js`）
- 回复：群聊富媒体上传拿 `file_info` → `msg_type=7` 被动回复，两张图各自渲染完即发

## 快速开始（本地运行）

### 1. 准备 QQ 机器人

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，拿到 `AppID` 与 `AppSecret`（ClientSecret）。
2. 在「开发设置」中把**机器人加入测试群**（沙箱环境需要单独配置沙箱群）。
3. 群内 @ 机器人发送消息，事件类型为 `GROUP_AT_MESSAGE_CREATE`（Intent `1<<25`）。

### 2. 安装依赖并配置凭据

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

编辑 `.env`：

```dotenv
APP_ID=你的AppID
CLIENT_SECRET=你的AppSecret
QQ_ENV=production          # 沙箱群改成 sandbox
LOG_EVENTS=true            # 排查问题时打开，会打印收到的全部事件
```

### 3. 分步验证

所有自检统一走 `npm run verify -- <子命令>`：

```bash
# 行业 / 概念板块资金流取数与自校验（不需要 QQ 凭据）
npm run verify -- fundflow           # 今日，fid=f62
npm run verify -- fundflow 5d        # 5 日，fid=f164
npm run verify -- fundflow 10d       # 10 日，fid=f174

# 本地渲染两张真实数据的 PNG（不需要 QQ 凭据）
npm run verify -- render        # 输出 .tmp-probe/preview/fundflow-{industry,concept}.png

# 校验 APP_ID / CLIENT_SECRET 与 Gateway 接入点（不发送消息）
npm run verify -- qq

# ★ 验证能否正常收到 QQ 群用户的消息（只监听，不回复）
npm run verify -- inbound                # 默认等待 5 分钟
npm run verify -- inbound 60             # 等待 60 秒
npm run verify -- inbound 60 --reset     # 更换过机器人账号时，先清理会话缓存

# 富媒体分片上传诊断（打印 prepare/PUT/part_finish/merge 各步骤原始结果）
npm run verify -- upload <group_openid> [图片路径]

# 一次跑完 fundflow + render + qq
npm run verify
```

`verify -- inbound` 会先打印当前 APP_ID、接入点、凭据对应的机器人昵称与 ID，
再等待群 @ 事件。成功时会打印完整的 `GROUP_AT_MESSAGE_CREATE` 事件体
（`msg_id`、`group_openid`、`member_openid`、`content` 等）。

> 会话缓存说明：`.tmp-probe/gateway-session.json` 保存 Gateway 的 `session_id` 与 `seq`，
> 仅在 `SESSION_RESUME=true` 时用于 Resume。缓存**绑定 AppID 与接入点**，更换账号时会自动丢弃；
> 如需强制清理可加 `--reset` 或直接删除该文件。

### 4. 启动机器人

```bash
npm start        # 或 npm run dev（文件变更自动重启）
```

启动后到测试群发送：

| 群消息 | 机器人的回复 |
|---|---|
| `@机器人 ping` | `pong · 机器人在线 · 时间` 文本 |
| `@机器人 大盘` | **两张图片**：行业板块 TOP25 + 概念板块 TOP25 主力净额热力图（先渲染完的先发，均为**引用回复**） |
| `@机器人 帮助` | 指令说明 |
| 其它内容 | 忽略（不回复） |

> `大盘` **不再发送文字榜单**，数据全部通过图片呈现；
> 只有在两张图都失败时，才发一条错误说明文字。

### 关于「@ 发言人」

群聊接口**不支持**机器人在消息里 @ 群成员 —— 发送群消息的请求体只有
`msg_type / content / markdown / keyboard / msg_id / msg_seq / media / message_reference`，
没有 `mentions` 之类的字段（[@ 是主消息的属性，而图片是另一条消息，无法跟随](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)）。

替代方案：**引用回复**。事件体的 `message_scene.ext` 里有 `msg_idx`（即被引用消息 ID），
把它填进请求的 `message_reference.message_id`，QQ 客户端就会把图片渲染成引用用户那条消息的卡片，
视觉上紧挂在发言人下面，`@` 反而多余。

## 处理流程

```text
Gateway WebSocket
  → GROUP_AT_MESSAGE_CREATE（@机器人）
  → 指令解析（大盘 / ping / 帮助）
  → 事件去重（msg_id）
  → 取用户消息索引 msg_idx（message_scene.ext）
  → 并发两条链路（互不等待）：
       行业板块：取数(496) → 按 f62 降序取 TOP25 → 渲染 PNG → 分片上传 → msg_type=7 发送
       概念板块：取数(504) → 按 f62 降序取 TOP25 → 渲染 PNG → 分片上传 → msg_type=7 发送
  → 每条链路渲染完成即发送，msg_seq 按实际发送顺序分配（1、2）
```

两条链路**并发且互不阻塞**：先渲染完的那张先发出去，用户不必等两张都好。
两张图都带 `message_reference`，以引用用户消息的形式展示。

兜底策略：

- 两张图使用**递增的 `msg_seq`**（平台要求相同 `msg_id` 的不同回复必须换序号）
- 单张失败 → 另一张照常发送，日志记录失败原因（结果记为 `partial`）
- 两张都失败 → 发一条错误说明文字
- 事件里没有 `msg_idx` 时自动降级为普通回复（不引用）
- 数据失败的具体原因会带上板块类型（行业 / 概念）便于定位
- `msg_seq` 用尽（平台上限 5 次）→ 停止回复并记录日志

## 东方财富资金流接口（行业 / 概念）

> 以下结论均为**本机实测**（2026-09-12，非交易日取到 2026-09-11 收盘数据），
> 可用 `npm run verify -- fundflow [today|5d|10d]` 一键复验。

### 1. 排行榜主接口

```http
GET https://push2delay.eastmoney.com/api/qt/clist/get
```

| 参数 | 值 | 说明 |
|---|---|---|
| `fs` | `m:90 t:2` | **行业板块**，实测 496 个 |
| `fs` | `m:90 t:3` | **概念板块**，实测 504 个 |
| `fid` | `f62` / `f164` / `f174` | 按「今日 / 5日 / 10日」主力净额降序 |
| `pn` | 页码，从 1 开始 | 需要分页取全量 |
| `pz` | 每页条数，默认 100 | **接口上限就是 100**：传 200/500 仍只回 100 条 |
| `po` | `1` | 降序 |
| `np` | `1` | 返回 `diff` 为数组形式 |
| `fltt` / `invt` | `2` | 返回原始数值（不缩放、不反色） |
| `ut` | `b2884a393a59ad64002292a3e90d46a5` | 网页端固定值，缺省也能用 |
| `fields` | 见下表 | 逗号分隔字段白名单 |

> `fs` 里的空格是**字面空格**（URL 编码后为 `m%3A90+t%3A2`），写成 `+` 也能被接受。
> 用 `URL` + `searchParams` 构造成 `m%3A90+t%3A2` 时服务端正常返回，无需特殊处理。

**字段表**（今日 / 5日 / 10日 三套字段整段平移）：

| 含义 | 今日 | 5日 | 10日 | 备注 |
|---|---|---|---|---|
| 板块代码 | `f12` | — | — | 如 `BK0448` |
| 板块名称 | `f14` | — | — | |
| 涨跌幅 % | `f3` | — | — | |
| 最新价 | `f2` | — | — | 板块指数点位 |
| 行情时间 | `f124` | — | — | **秒**级时间戳 |
| 主力净额 | `f62` | `f164` | `f174` | 单位「元」 |
| 主力净额占比 % | `f184` | `f165` | `f175` | 占成交额 |
| 超大单净额 | `f66` | `f166` | `f176` | |
| 超大单占比 % | `f69` | `f167` | `f177` | |
| 大单净额 | `f72` | `f168` | `f178` | |
| 大单占比 % | `f75` | `f169` | `f179` | |
| 中单净额 | `f78` | `f170` | `f180` | |
| 中单占比 % | `f81` | `f171` | `f181` | |
| 小单净额 | `f84` | `f172` | `f182` | |
| 小单占比 % | `f87` | `f173` | `f183` | |
| 上涨/下跌/平盘家数 | `f104`/`f105`/`f106` | — | — | |
| 领涨股名称 / 代码 | `f204` / `f205` | — | — | |

**实测校验结论**（`npm run verify -- fundflow` 每次都会重跑）：

- ✅ 分页取回的板块数与 `data.total` 完全一致：行业 `496 = 496`，概念 `504 = 504`（无遗漏、无重复）
- ✅ `f62 = f66 + f72` 在 496/496、504/504 个板块上**严格成立**，5 日 / 10 日同样成立 → 主力 = 超大单 + 大单
- ✅ 接口返回顺序确实按 `fid` 降序，无需本地重排
- ℹ️ `f62 + f78 + f84 ≈ 0`（资金守恒，主力+中单+小单互为对手盘），偏差来自服务端四舍五入
- ℹ️ 净流入 / 净流出的板块都大量存在（当日行业 94 涨 / 402 跌），可确认字段未取反

**响应结构**：

```jsonc
{
  "rc": 0,
  "data": {
    "total": 496,
    "diff": [
      { "f12": "BK0448", "f14": "通信设备", "f3": 0.52, "f62": 4741400064, "f66": 4091189248, "f72": 650210816,
        "f184": 2.67, "f124": 1789112372, "f204": "中际旭创", "f205": "300308" }
    ]
  }
}
```

> 当 `np` 不为 1 时 `diff` 可能是「以序号为键的对象」，实现里已统一归一化成数组。

### 2. 单板块分钟 / 日线资金流

```http
GET https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get
```

| 参数 | 值 | 说明 |
|---|---|---|
| `secid` | `90.BKxxxx` | **板块前缀固定为 `90`**（个股为 `0.`/`1.`） |
| `klt` | `1` / `101` | `1` = 分钟级（实测 240 个点位），`101` = 日线 |
| `lmt` | `0` | `0` = 不限条数 |
| `fields1` | `f1,f2,f3,f7` | |
| `fields2` | `f51,f52,f53,f54,f55,f56,...` | 见下 |

`klines` 每行是逗号分隔字符串，**实测字段顺序**以 `fields2=f51..f56` 为准：

```text
"2026-09-11 15:00, 4741400325, 776177089, -5434456943, 650211015, 4091189310"
   f51 时间        f52 主力      f53 小单     f54 中单      f55 大单     f56 超大单
```

即顺序为 **主力 → 小单 → 中单 → 大单 → 超大单**（不是「超大单在前」）。
实测末点位满足 `f52 = f55 + f56`（4741400325 = 650211015 + 4091189310），与榜单接口同一口径。

### 3. 主机选择（实测踩坑）

| 主机 | 实测结果 |
|---|---|
| `push2delay.eastmoney.com` | ✅ 稳定可用，本模块默认主机 |
| `push2.eastmoney.com` | ⚠️ 数据完全一致，但本机实测**连续 0/6 次 ECONNRESET**（疑似限流/线路问题） |

因此实现里以 `push2delay` 为主、`push2` 为备份，**并对网络类错误做退避重试**：
`ECONNRESET` 会表现为 undici 的 `UND_ERR_SOCKET`（真正的 code 在 `error.cause.code` 上），
只判 `error.code` 会漏判，重试逻辑必须看 `cause`。

### 4. 代码入口

```ts
import { EastmoneyFundFlowProvider } from './src/market/fundflow.js';

const provider = new EastmoneyFundFlowProvider({ logger, cacheTtlMs: 60_000 });

// 行业板块「今日」资金流（全量 496 个，按主力净额降序）
const snapshot = await provider.getSectorFundFlow('industry', 'today');
// period 可选 'today' | '5d' | '10d'；kind 可选 'industry' | 'concept'

// 单板块分钟级资金流
const detail = await provider.getSectorFundFlowDetail('BK0448');
```

- 金额字段单位统一为「**元**」，字段名与东财口径一致（`mainNet` = `superNet` + `bigNet`）。
- 结果默认缓存 60 秒（`cacheTtlMs`，按 `kind + period` 分键），传 `0` 关闭。
- 失败时抛错而不是返回脏数据；`tryLoadFundFlow()` 提供不抛错的包装。

## 目录结构

```text
src/
  config.ts            运行配置（环境变量 + zod 校验）
  env.ts               .env 加载（不覆盖已有环境变量）
  logger.ts            统一日志
  index.ts             机器人入口（npm start）
  qq/
    token.ts           Access Token 自动刷新
    api-client.ts      QQ HTTP API（发消息、富媒体分片上传）
    gateway.ts         Gateway WebSocket（心跳、重连、Resume 看门狗）
    dedupe.ts          msg_id + msg_seq 去重
    session-store.ts   会话持久化（绑定 AppID，重启后可选 Resume）
    types.ts           事件与 opcode 类型
  market/
    fundflow.ts        东方财富行业/概念板块资金流取数（分页+重试+缓存）
    fundflow-types.ts  资金流领域模型（周期、板块类型、快照）
    sectors.ts         资金流 → Treemap 渲染块（取主力净流入前 25）
    cache.ts           短时缓存（含请求合并）
    format.ts          金额/涨跌幅/行情时间格式化、图片头部文案
    types.ts           渲染块领域模型（MarketBlock）
  render/
    treemap.ts         squarified Treemap 布局
    color.ts           涨跌幅 → 颜色映射
    image.ts           SVG/PNG 渲染
  commands/
    parser.ts          @ 消息内容 → 指令
    bot.ts             指令路由、两图并发发送、被动回复、兜底
scripts/
  verify.ts            统一自检入口（fundflow / render / qq / inbound / upload）
tests/                 vitest 单元测试
```

## 开发命令

```bash
npm start           # 启动机器人
npm run dev         # 启动并监听文件变更
npm run verify      # 自检（fundflow + render + qq）
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run check       # 类型检查 + 测试
```

## 部署到 Render

仓库里已提供 `render.yaml` 蓝图：Dashboard → New → **Blueprint** → 选本仓库即可。
部署前需要了解 Render 的三条约束，程序已针对前两条做了适配。

### 1. Web Service 必须绑定 `PORT`

Render 的 Web Service 如果没在限期内监听 `PORT`，会被判定部署失败。
但本服务业务上只**主动连出** QQ Gateway，并不需要端口。

程序的做法：**只有平台注入 `PORT` 时才监听**，且只暴露一个 `/health`
（就绪状态跟着 Gateway 走，未连上返回 503）。本地不注入 `PORT`，所以不开监听。

若用付费的 Background Worker（本就更贴合这种常驻任务），
删掉 `healthCheckPath` 与 `PORT` 即可——检测不到 `PORT` 就不会开监听。

### 2. ⚠️ 必须关闭 Zero-Downtime Deploy

Render 默认的部署流程是「先起新实例 → 切换流量 → **60 秒后**才停旧实例」。
这 60 秒内两个实例**同时连着 QQ Gateway**，平台会把同一条群消息投递给两个连接，
于是每个指令被回复两遍。

这个开关在 **Settings → Deploy** 里手动关闭（Blueprint 无法配置）。
关掉后是「停旧起新」，会有几十秒不可用，但不会重复回复。

同时确认**实例数为 1**（蓝图里 `numInstances: 1`）。本项目用 WebSocket 长连接、
去重状态在进程内存里，不能水平扩容。

### 3. 免费实例 15 分钟会休眠

Render 免费 Web 实例在 **15 分钟**内既没有 HTTP 请求、也没有收到 WebSocket 消息时
会休眠（[2026-02 更新](https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages)：
现在收到 WebSocket 消息也会续命）。对本服务的实际影响：

- QQ Gateway 由我们主动连出，其下行流量属于 WebSocket 消息，能续命；
- 但群里如果**连续 15 分钟没人 @ 机器人**，就没有下行消息，实例会被休眠，
  此时机器人收不到任何消息；
- 因此免费实例**不适合真正当服务用**。要稳定运行请用付费实例或 Background Worker。

### 部署步骤

1. Render → New → Blueprint → 选择本仓库（读取 `render.yaml`）
2. 在控制台填 `APP_ID`、`CLIENT_SECRET`（蓝图里标了 `sync: false`，不会进仓库）
3. Settings → Deploy → **关闭 Zero-Downtime Deploy**
4. 确认实例数为 1、`healthCheckPath` 为 `/health`（蓝图已配好）

### 部署后验证

日志应出现：

```text
[INFO] [app] 未找到 .env，使用进程内环境变量
[INFO] [app] 字体检查通过（探针 …B），使用系统字体
[INFO] [app] 已监听 PORT=10000，仅提供 /health 健康检查（平台就绪判据）
[INFO] [app:gateway] Gateway 鉴权成功 READY，session_id=…，机器人=…
```

再访问 `https://<你的服务>.onrender.com/health`，应返回 `ok`（Gateway 未就绪时返回 503）。

### 中文字体

Render 的原生 Node 运行时不保证带 CJK 字体。**缺少时 resvg 不会报错，只会画不出文字**
（图片变成只有色块），因此启动时会做字体探针并明确告警。处理方式：

```bash
# Render Dashboard → Shell
fc-list :lang=zh | head        # 有输出说明系统已有中文字体
find / -name "*NotoSansCJK*" 2>/dev/null | head
```

若系统完全没有中文字体，最可靠的办法是**把字体文件放进仓库**随代码部署：

```bash
# 例如放一份思源黑体子集
fonts/NotoSansSC-Regular.otf
# 然后设 Variables：FONT_FILES=fonts/NotoSansSC-Regular.otf
```

## 常见问题

| 现象 | 排查方向 |
|---|---|
| **同一个指令被回复了两遍 / 收到重复图片** | 多半是两个实例同时连着同一机器人（平台会把同一条消息投递给每个连接）。可能有三种原因：① 本地开了两个进程（程序有单实例保护会直接拒绝启动，锁文件在 `.tmp-probe/bot.lock`）；② 平台副本数 > 1；③ **Render 等平台的零停机部署**——新旧实例会并存约 60 秒，需在平台设置里关闭 |
| **图片有色块但没有文字** | 容器缺中文字体（resvg 静默失败）。看启动日志的字体检查告警，按部署章节的字体部分处理 |
| **部署一段时间后机器人不响应，日志也停了** | Render 免费实例 15 分钟无流量会休眠。改用付费实例或 Background Worker |
| 部署后立刻退出 | 多半是没配 `APP_ID` / `CLIENT_SECRET`（`.env` 不在仓库里）。日志会打印「配置校验失败」 |
| Render 部署失败并提示未绑定端口 | Web Service 必须监听 `PORT`。程序会在检测到 `PORT` 时自动开一个仅含 `/health` 的监听；若日志报了端口监听失败，检查 `PORT` 是否被其他进程占用 |
| `verify -- inbound` 超时收不到事件 | 机器人是否已加入该群；群里 @ 的是否是这个机器人；沙箱群需 `QQ_ENV=sandbox` |
| 换了 APP_ID 却仍连上上一个机器人 | 会话缓存绑定 AppID 会自动失效；必要时 `npm run verify -- inbound 60 --reset` 清理 `.tmp-probe/gateway-session.json` |
| 错误码 `40034024` / `40034005` | `msg_id` 无效或已过期（被动回复必须在 5 分钟内） |
| 错误码 `40054005` | 消息被去重，检查 `msg_seq` 是否重复 |
| 错误码 `850031` | 上传文件超过大小限制 |
| 错误码 `850019` | 富媒体文件格式不支持：分片上传了空内容（多为分片偏移算错，见下方「已知实现要点」） |
| 错误码 `850026` | URL 上传时 platform 下载失败（本地开发请用分片上传，本项目已默认使用） |
| 错误码 `11251` / `100016` | `APP_ID` / `CLIENT_SECRET` 不正确 |
| 图片中文显示为方块 | 系统缺少中文字体，用 `FONT_FILES=C:\Windows\Fonts\msyh.ttc` 显式指定 |
| 关闭码 4914 | 机器人已下架 / 环境不匹配，需确认沙箱与正式环境配置 |

## 说明

- 图片按**主力净额**降序展示 TOP25 板块，矩形面积＝主力净额，颜色＝涨跌幅（红涨绿跌）。
- 头部两行：**主标题**「板块类型 + 主力 + Top数量」（如 `行业板块主力Top25`），
  **副标题**「数据源 · 行情时间」；右上角显示涨跌家数。
  主标题不写「主力流入」——榜单按主力净额降序，尾部板块可能是净流出。
- 资金流结果默认缓存 60 秒（`MARKET_CACHE_TTL_MS`），按「板块类型 + 周期」分键。
- 东方财富接口是公开网页行情接口，无稳定性保证，MVP 未接入备用数据源。
- **行情时间说明**：图片标注的是数据源返回的 `f124`（行情时间）。
  - 交易日盘中：随行情刷新；
  - 收盘后：定格在当日收盘数据；
  - 周末/节假日：定格在**上一个交易日**的收盘数据，此时时间前会带完整日期
    （如 `2026-09-11 15:39`）以便识别。
- **GateWay 会话**：默认每次启动都新建会话（`SESSION_RESUME=false`）。
  平台对已失效会话也会回 `RESUMED` 但不再推送事件，因此不建议默认开启 Resume；
  若确实需要补发断线事件，可设 `SESSION_RESUME=true`，此时 `RESUME_GRACE_MS`
  看门狗会在窗口内无事件时自动重新鉴权。
- 调试用图片落盘在 `.tmp-probe/images`，Gateway 会话状态在 `.tmp-probe/gateway-session.json`（均已被 git 忽略）。

## 性能实测（1200x900 热力图）

`@机器人 大盘` 的端到端耗时构成（本机实测）：

| 阶段 | 耗时 | 说明 |
|---|---|---|
| 资金流取数（行业 496 条 / 概念 504 条） | 1.8s / 5.7s | 各自 5~6 页串行请求，**单页延迟波动很大**（实测 110ms ~ 1.8s，取决于服务端） |
| treemap 布局 + 拼接 SVG | ~0ms | 纯计算，可忽略 |
| PNG 渲染（每张） | 1.5 ~ 2.4s | 几乎全部是**中文字形处理**，见下 |
| 分片上传（约 105KB） | ~1.6s | 4 次 HTTPS 往返：prepare → PUT → part_finish → merge |
| 发送富媒体消息 | ~1.2s | 平台侧转存图片 |

两条链路**并发**，所以总耗时接近「较慢的那条」，而不是两者相加。
第一张图在自身链路完成后立即发出，不必等第二张。

### 渲染为什么慢

`@resvg/resvg-js` 处理 **CJK 字形**的开销远高于拉丁字符（实测约 140ms/中文文本节点
vs 约 7ms/英文节点），且字体库无法跨 `Resvg` 实例复用。相关实测结论：

- 光栅化本身只要 ~10ms、PNG 编码 ~20ms，开销都在文本处理
- 把所有文本合并成单个 `<text>` + `<tspan>` **没有改善**（1324ms vs 1379ms，在噪声内）
- 用 `<defs>` + `<use>` 复用文本节点 **没有改善**（每个行业名都不同，无法复用）
- 显式用 `FONT_FILES` 指定字体（跳过系统字体扫描）约省 15%

因此实现里采用**内容级 PNG 缓存**：同一份行情数据只渲染一次，重复请求 0ms 命中
（实测 `2238ms → 1ms`）。行情每 60 秒刷新，所以通常只有每个行情周期的首个请求付渲染成本。

要进一步压缩，最彻底的办法是把文字预先转成 SVG `<path>`（需字体子集化，如 `opentype.js`），
让 resvg 完全不处理文本；MVP 暂未采用。

## 已知实现要点（实测踩坑记录）

| 项 | 说明 |
|---|---|
| 分片上传的 `index` 是 1-based | 官方文档示例写 0-based，实测服务端下发首个分片为 `index: 1`。偏移必须按 `(index - 1) * blockSize` 计算，否则会从文件末尾开始上传 **0 字节**（COS 仍返回 200），合并时报 `850019 富媒体文件格式不支持` |
| 本地开发必须用分片上传 | URL 上传要求平台能访问到图片地址，`localhost` 不可用 |
| 被动回复的 `msg_seq` 必须动态分配 | 平台对相同 `msg_id + msg_seq` 直接判重（`40054005`）。硬编码固定序号、或失败后沿用原序号重试，都会踩坑；本项目每次发送前认领未被占用的序号，命中判重则换号重试 |
| 认领过的 `msg_seq` 不能归还 | 两条图片链路并发发送，归还序号会让两个发送撞到同一个 seq（实测出现 `[1,1,2]`）；且平台已把该 seq 记为用过，复用必被判重 |
| 图片上传走内存而非临时文件 | 曾用「渲染落盘 → 按路径读取上传」，两个进程/并发任务在同一毫秒会写出**同名文件**互相覆盖，导致 A 图被上传成 B 图（实测出现行业图与概念图都被上传成概念图）。现在 `uploadGroupFileFromBuffer` 直接吃 Buffer，调试图文件名也带 `pid` + 随机串 |
| 两个进程连同一机器人会重复回复 | 平台把同一条群消息投递给每个 Gateway 连接，于是每个指令被回复两遍。`src/instance-lock.ts` 用锁文件 + 存活探测在启动阶段拦截 |
| 被动回复时效 | `msg_id` 5 分钟内有效，同一 `msg_id` 最多回复 5 次（`msg_seq` 1..5），用尽后平台报 `40034128` |
| 平台可能对同一事件重复投递 | 需按 `msg_id` 去重；注意重投时 `msg_id` 通常不变，但内容相同的两条真实消息 `msg_id` 是不同的 |



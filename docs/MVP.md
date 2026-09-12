# MVP 范围定义：群内按需推送金融大盘数据图片

> 状态：范围已确认，待进入实现
> 最后更新：2026-06（依据官方文档当前版本核实）

## 1. 一句话定义

群成员 **@机器人 发送「大盘」** → 机器人回复**两张行业板块 Treemap 热力图**（A股一张、美股一张）。

- 数据口径：**行业板块**，不含指数、不含个股。
- 图形：**矩形树图（treemap heatmap）**，面积权重 = 成交额。
- 渲染方案详见 [`RENDER_DESIGN.md`](./RENDER_DESIGN.md)。

## 2. 平台硬约束（决定了 MVP 形态）

以下三条来自官方文档，是实现前必须接受的前提：

| # | 约束 | 出处 | 影响 |
|---|---|---|---|
| 1 | **主动推送能力已于 2025-04-21 起不再提供**，接口调用会收到错误信息 | [发送消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html) | **不能实现定时主动播报**，MVP 只能走被动回复 |
| 2 | 群聊被动回复有效期 **5 分钟**，每条消息最多回复 **5 次** | [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html) | 回复必须携带前置 `msg_id`；`msg_id + msg_seq` 需自增去重 |
| 3 | 富媒体上传的 `file_data` **暂未支持**，只接受 `url` 或分片上传 | [富媒体消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/rich-media.md) | 本地渲染的图片必须走**分片上传**（推荐）或自建公网 URL |

其他已核实的接口事实：

- 接口域名统一为 `api.bot.qq.com`（2026-08-10 变更）。
- 鉴权：`POST /app/getAppAccessToken`（appId + clientSecret），返回 `access_token` 有效 **7200s**；过期前 **60s** 内重复获取会返回新 token。请求头格式 `Authorization: QQBot <ACCESS_TOKEN>`。
- 发群消息：`POST /v2/groups/{group_openid}/messages`，图片用 `msg_type=7` + `media.file_info`。
- **官方已知 bug**：`msg_type=7` 时 `content` 字段仍必须填值（如一个空格），否则发送失败。
- 分片上传四步：`upload_prepare` → 分片 `PUT` 预签名 URL → `upload_part_finish` → `POST /v2/groups/{group_openid}/files` 携带 `upload_id` 换 `file_info`。
- 单聊与群聊上传接口**互相隔离**，群聊文件只能发到群聊。
- 图片格式：文档两处口径不一致（[富媒体消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/rich-media.md) 写 png/jpg，[富媒体概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html) 写 jpg/png/gif/webp/bmp）。**MVP 统一输出 PNG**，取最保守口径。
- 图片软限制 20MB / 硬限制 200MB，超软限制会降级为文件消息。
- `md5_10m`（文件前 10002432 字节的 MD5）可用于秒传判断。
- 消息内容含 URL 需提前在 q.qq.com 后台配置「消息URL配置」，否则发送失败。**MVP 图内不输出任何 URL。**

## 3. 数据源可行性（已实测）

### 3.1 A股板块 — ✅ 实测通过（主源 push2delay）

```
GET https://push2delay.eastmoney.com/api/qt/clist/get
    ?pn={1..5}&pz=100&po=1&np=1&fltt=2&invt=2
    &fs=m:90+t:2&fields=f2,f3,f5,f6,f12,f14,f104,f105,f124,f128,f140
```

实测返回 `total: 496` 个行业板块。字段：

| 字段 | 含义 | 实测确认 |
|---|---|---|
| `f14` | 板块名称（如「通信线缆及配套」） | ✅ |
| `f3` | 涨跌幅 % | ✅ |
| **`f6`** | **成交额，单位「元」** | ✅ `fltt=2` 下**仍是整型元值**，不转「亿」 |
| `f5` | 成交量，单位「股」 | ✅ |
| `f12` | 板块代码（如 `BK1592`） | ✅ |
| `f104` / `f105` | 上涨家数 / 下跌家数 | ✅ |
| `f124` | 行情时间戳（Unix 秒） | ✅ |
| `f128` / `f140` | 领涨股名称 / 代码 | ✅ |

`m:90 t:2` 为行业板块，`m:90 t:3` 为概念板块。

**交叉校验**：496 个板块 `f6` 合计 = **5.96 万亿元**，与 A 股单日成交额量级吻合 → 确认 `f6` 语义正确。

#### 三个必须避开的坑（全部实测）

1. **`pn` 参数不能省**：省略 `pn` 时同一 URL 返回 0 行（`total=undefined`）。必须显式 `pn=1..5`。
2. **`fid` 排序参数被服务端忽略**：`fid=f3` / `f6` / `f12` / `f14` / `f104` 返回顺序**完全相同**（始终按 `f3` 降序）。
   → **要按成交额排 treemap，必须在客户端自己排序。**
3. **`push2test.eastmoney.com` 是陷阱**：HTTP/HTTPS 都返回 200 且结构正常，但**所有数值字段是字符串 `"-"`** 的占位假数据。**不可用作容灾源。**

#### 限流实测（比预期宽松）

`push2delay` 30 次连发 + 20 并发 = **50/50 全部成功**，p50 延迟 92ms。

> ⚠️ 该域名含 `delay`，**极可能是 15 分钟延时行情**（已取到 `f124` 时间戳为上周五 15:39:32 收盘后快照）。
> 周末无法确认延时特性，**需在交易时段复测**。若确认延时 15 分钟，对「收盘复盘」场景无影响，对盘中实时性有影响。

### 3.1b A股备选源 — 腾讯（仅展示级容灾）

```
GET http://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&count=100
```

一次请求返回**全部 31 个申万一级行业**（`total=31`），字段：`zdf`（涨跌幅%）、`turnover`（成交额，**万元**）、`zsz`（总市值，亿）、`lzg`（领涨股）、`zgb`（涨跌家数）。

> ❗ **重要更正**：曾有结论称腾讯 `zdf` 与东财 `f3` 同板块「完全一致」，**该结论错误**（比较时东财侧取错了行）。
> 正确复测后两者**普遍不一致**：电子 EM -1.1% vs TX -0.81%、通信 EM -0.04% vs TX +1.41%、食品饮料 EM -2.61% vs TX -1.06%。
>
> **根因：东财 BK 板块与腾讯申万一级的「成分股口径不同」，数值本就不应一致。**
>
> **结论：腾讯只能作为「展示级容灾」（东财挂掉时顶上，图仍然出得来），绝不能用来校验东财数值。**
> 且两者分类体系不同，**切换源会导致同一张图的板块集合变化**——需在图上或日志中标注当前数据源。

### 3.2 A股指数 — 仅作辅助信息，非 MVP 必需

```
GET https://push2.eastmoney.com/api/qt/ulist.np/get
    ?fltt=2&invt=2&fields=f2,f3,f4,f12,f13,f14&secids=1.000001,0.399001,0.399006
```

覆盖上证指数 / 深证成指 / 创业板指。当前需求只做**板块**，此接口保留备用。

### 3.3 美股指数 — ✅ 实测通过（同上，非 MVP 必需）

```
GET https://push2.eastmoney.com/api/qt/ulist.np/get
    ?fltt=2&invt=2&fields=f2,f3,f4,f12,f13,f14&secids=100.DJIA,100.NDX,100.SPX
```

实测返回：道琼斯 52573.29 (+0.98%)、纳斯达克 26333.04 (+0.96%)、标普500 7656.98 (+0.86%)。

### 3.4 美股板块 — ⚠️ MVP 最大缺口，待子代理核查结果

东财 `m:100 t:3` 与 `m:105 t:3` 均返回 `rc:102` / `data:null`，**不提供美股行业板块分类**。

已排除的源（实测）：

| 源 | 结果 |
|---|---|
| Yahoo Finance | 中国大陆 IP 返回 **403**，官方声明停止大陆服务 |
| Finviz `/api/v1/groups/industry` | **404**，官方无免费 API |
| Finviz `map.ashx?t=sec` | 返回**空壳 HTML**，内容由 JS 动态渲染 |
| anysite.io 等封装 | 付费 |
| 百度股市通 `finance.baidu.com` | 重定向至 `seccaptcha.baidu.com` **验证码**，有反爬 |

候选方案（优先级从高到低）：

1. **行业 ETF 代理**：用 SPDR 十一大行业 ETF（`XLK` 科技、`XLF` 金融、`XLE` 能源、`XLV` 医疗、`XLI` 工业、`XLY` 可选消费、`XLP` 必需消费、`XLU` 公用事业、`XLB` 材料、`XLRE` 房地产、`XLC` 通信）作为板块代理，经东财美股个股接口（市场前缀 `105.`）取涨跌幅与成交额。这是美股板块的通行口径，**且恰好是 11 个板块，treemap 密度合适**。
2. Stooq 免费 CSV 接口。
3. 腾讯 / 新浪美股接口。
4. 付费源：Tushare Pro / Financial Modeling Prep 等。

### 3.5 数据源的已知风险

- **`push2.eastmoney.com` 不可用**：本机实测该域名（含 `1.push2.*`、`82.push2.*`、`push2his.*`）**全部连接失败**，仅 `push2delay.eastmoney.com` 可通。非官方公开接口，无稳定性承诺。
- **东财与腾讯分类口径不同**，切换数据源会改变板块集合与数值。需：
  - 数据源抽象层，便于替换；
  - **在图上或日志中记录当前数据源**，避免同一群里两张图口径混淆；
  - 结果缓存（同一交易日内板块快照复用）。
- **`push2delay` 可能是延时行情**（域名含 `delay`），需交易时段复测确认。
- 建议显式设置 `Referer: https://quote.eastmoney.com/` 与常见 UA，降低被拒概率。

## 4. MVP 功能范围

### 4.1 做

| # | 功能 | 验收标准 |
|---|---|---|
| 1 | access_token 获取与自动刷新 | 启动即获取；剩余有效期 < 300s 时自动续期；并发调用只触发一次刷新 |
| 2 | 事件接收层 | **WebSocket 长连接**（常驻容器）或 **Webhook**（serverless，含 Ed25519 签名校验）二选一，见 §6 |
| 3 | `group_openid` 持久化 | 入群事件与消息事件中的 group_openid 落地到本地存储 |
| 4 | 指令路由 | 群内消息含「大盘」→ 依次发 A股、美股两张图；其它 → 帮助文本 |
| 5 | 板块取数 | A股 + 美股行业板块快照（名称/涨跌幅/成交额），带超时、重试、缓存 |
| 6 | Treemap 渲染 | 手写 SVG → resvg 转 PNG；面积守恒、无重叠、长宽比受控；中文正常 |
| 7 | 分片上传 | 四步流程完整实现，支持 `md5_10m` 秒传判断 |
| 8 | 发图 | `msg_type=7` + 空格 `content` + `msg_id`；两张图用递增 `msg_seq` |
| 9 | 幂等与频控 | `msg_seq` 递增；识别 `22009 msg limit exceed`（同一 msg_id 最多回 5 次） |
| 10 | 失败兜底 | 任一环节失败均回**文字**说明；A股图失败不应导致美股图也不发 |

### 4.2 不做（明确砍掉）

定时推送、多群广播、K线/分时图、个股查询、自选股订阅、数据库、Web 管理后台、多数据源冗余、Markdown 卡片消息、按钮交互、指数行情展示。

## 5. 技术选型（已确认）

- **接入层自研轻量客户端**：`httpx` + `websockets`，不引入 botpy / NoneBot。
- **渲染**：手写 SVG + `resvg-py` 转 PNG，**不用 matplotlib / Chromium**；中文字体 base64 子集内嵌。
- **数据源**：东财公开接口为主，封装在数据源抽象层之后。
- **Python**：3.13（`.python-version`），依赖用 `uv` 管理。

> ⚠️ 本机沙箱限制：`uv` 需要写工作区外的共享解释器与包缓存，**依赖安装需在受限环境外手动执行**（`uv add httpx websockets matplotlib ...`）。

## 6. 里程碑

| 里程碑 | 内容 | 可独立验证 |
|---|---|---|
| M0 | 数据源探测脚本：确认 A股板块备选源与美股板块缺口，输出样本数据 | `python scripts/probe_data.py` |
| M1 | 板块取数 + 缓存 + 数据源抽象 | 单测覆盖解析与降级 |
| M2 | Treemap 渲染（SVG → PNG） | 单测校验 PNG 尺寸与字体，产物可人工查看 |
| M3 | 接入层：token / 事件接收 / 分片上传 / 发消息 | 单测覆盖 payload 组装与刷新逻辑 |
| M4 | 指令路由 + 端到端真机联调 | 测试群内实测 |

## 7. 部署方案（待定，见下方对比）

**已排除：Vercel 跑 WebSocket 长连接模式**——serverless 函数执行完即销毁，长连接无法维持。

| 方案 | 事件接收 | 优点 | 缺点 |
|---|---|---|---|
| **A. 常驻容器平台**（Hugging Face Spaces / Railway / Render / Fly.io 免费额度） | WebSocket | 代码最简单，只依赖官方 API，无队列、无签名校验 | 免费平台可能有休眠策略 |
| **B. Vercel + 异步队列**（Upstash QStash / Inngest） | Webhook | 可白嫖 Vercel；回调地址仅允许 80/443/8080/8443，Vercel 443 合规 | 引入第二个依赖；需实现 Ed25519 签名校验；必须 5s 内响应后异步处理 |
| **C. 国内轻量云服务器**（约 ¥50-100/月） | WebSocket | 网络最稳，访问国内数据源最快 | 需要付费 |

> Webhook 模式的三个硬约束：回调端口仅允许 **80/443/8080/8443**；配置时需通过 **Ed25519 签名校验**；**必须 5 秒内响应**，因此「渲染 + 上传 + 发消息」必须异步化。
> 被动回复窗口为 **5 分钟**，异步处理时间充裕。

## 8. 测试策略

以下均可**脱离真实 QQ 环境**用 mock/fixture 覆盖：token 刷新时序、事件 JSON 解析（WebSocket 与 Webhook 两种形态）、Ed25519 签名校验、`msg_seq` 去重、分片上传状态机（含秒传）、发消息 payload 组装（含 `msg_type=7` 空格 bug）、Treemap 布局不变量（面积守恒/无重叠）、渲染产物尺寸与字体、以及各类失败兜底路径。

仅 M4 的真机联调需要真实测试群。

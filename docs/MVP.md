# MVP 范围定义：群内按需推送金融大盘数据图片

> 状态：范围已确认，待进入实现
> 最后更新：2026-06（依据官方文档当前版本核实）

## 1. 一句话定义

群成员 **@机器人 发送指令** → 机器人回复一张**当日 A股 / 美股大盘数据图**（指数行情 + 板块涨跌）。

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

### 3.1 A股板块 — ✅ 实测通过

```
GET https://push2.eastmoney.com/api/qt/clist/get
    ?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f2,f3,f12,f14,f104,f105,f128,f140
```

实测返回 `total: 496` 个行业板块，按涨跌幅 `f3` 降序。字段：

| 字段 | 含义 |
|---|---|
| `f14` | 板块名称（如「通信线缆及配套」） |
| `f3` | 涨跌幅 % |
| `f2` | 板块指数点位 |
| `f104` / `f105` | 上涨家数 / 下跌家数 |
| `f128` / `f140` | 领涨股名称 / 代码 |

`m:90 t:2` 为行业板块，`m:90 t:3` 为概念板块（**待实测确认**）。

### 3.2 A股指数 — 待实测

```
GET https://push2.eastmoney.com/api/qt/ulist.np/get
    ?fltt=2&invt=2&fields=f2,f3,f4,f12,f13,f14&secids=1.000001,0.399001,0.399006
```

覆盖上证指数 / 深证成指 / 创业板指。

### 3.3 美股指数 — ✅ 实测通过

```
GET https://push2.eastmoney.com/api/qt/ulist.np/get
    ?fltt=2&invt=2&fields=f2,f3,f4,f12,f13,f14&secids=100.DJIA,100.NDX,100.SPX
```

实测返回：道琼斯 52573.29 (+0.98%)、纳斯达克 26333.04 (+0.96%)、标普500 7656.98 (+0.86%)。

### 3.4 美股板块 — ⚠️ 未确认，需替代方案

东财 `m:100 t:3` 与 `m:105 t:3` 均返回 `rc:102` / `data:null`，**不提供美股行业板块分类**。

备选方案（需在 M1 阶段定稿，优先级从高到低）：

1. **行业 ETF 代理**：用 SPDR 十一大行业 ETF（`XLK` 科技、`XLF` 金融、`XLE` 能源、`XLV` 医疗、`XLI` 工业、`XLY` 可选消费、`XLP` 必需消费、`XLU` 公用事业、`XLB` 材料、`XLRE` 房地产、`XLC` 通信）通过个股行情接口取涨跌幅作为板块代理。这是美股板块的通行口径。
2. **中概/美股热门股排行**：`fs=m:100`（东财热门美股列表，按涨跌幅排序），偏个股而非板块。
3. **付费源**：Tushare Pro / 其他。

### 3.5 数据源的已知风险

- `push2.eastmoney.com` 为**非官方公开接口，无稳定性承诺**。实测过程中该域名在多次请求后**出现整域限流**（连先前成功的 URL 也返回网络错误），需要：
  - 请求间隔控制 + 有限重试；
  - **结果缓存**（同一交易日内指数/板块快照复用）；
  - 数据源抽象层，便于后续替换（akshare / Tushare / 付费源）。
- 建议显式设置 `Referer: https://quote.eastmoney.com/` 与常见 UA，降低被拒概率。

## 4. MVP 功能范围

### 4.1 做

| # | 功能 | 验收标准 |
|---|---|---|
| 1 | access_token 获取与自动刷新 | 启动即获取；剩余有效期 < 300s 时自动续期；并发调用只触发一次刷新 |
| 2 | WebSocket 长连接 | 订阅 `GROUP_AT_MESSAGE_CREATE`、`GROUP_ADD_ROBOT`；HELLO/心跳/断线重连正常 |
| 3 | `group_openid` 持久化 | 入群事件与消息事件中的 group_openid 落地到本地存储 |
| 4 | 指令路由 | `大盘` / `A股` → A股图；`美股` → 美股图；`帮助` → 用法文本 |
| 5 | 行情取数 | 指数 + 板块快照，带超时、重试、交易日/缓存策略 |
| 6 | 图片渲染 | PNG，暖色涨/冷色跌，中文正常显示，宽度适配手机 |
| 7 | 分片上传 | 四步流程完整实现，支持秒传判断 |
| 8 | 发图 | `msg_type=7` + 空格 `content` + `msg_id` 被动回复 |
| 9 | 幂等与频控 | `msg_seq` 递增；识别 `22009 msg limit exceed` |
| 10 | 失败兜底 | 取数失败 / 上传失败 / 发送失败均回**文字**说明，绝不静默 |

### 4.2 不做（明确砍掉）

定时推送、多群广播、K线/分时图、个股查询、自选股订阅、数据库、Web 管理后台、多数据源冗余、图片结果复用缓存、Markdown 卡片消息、按钮交互。

## 5. 技术选型（已确认）

- **接入层自研轻量客户端**：`httpx` + `websockets`，不引入 botpy / NoneBot。
- **渲染**：`matplotlib`，**必须显式指定中文字体**（Linux 容器下缺字是首要坑）。
- **数据源**：东财公开接口为主，封装在数据源抽象层之后。
- **Python**：3.13（`.python-version`），依赖用 `uv` 管理。

> ⚠️ 本机沙箱限制：`uv` 需要写工作区外的共享解释器与包缓存，**依赖安装需在受限环境外手动执行**（`uv add httpx websockets matplotlib ...`）。

## 6. 里程碑

| 里程碑 | 内容 | 可独立验证 |
|---|---|---|
| M0 | 数据源探测脚本：确认 §3.2 / §3.4 待定项，输出样本数据 | `python scripts/probe_data.py` |
| M1 | 行情取数 + 缓存 + 数据源抽象 | 单测覆盖解析与降级 |
| M2 | 图片渲染 | 单测校验 PNG 尺寸与字体，产物可人工查看 |
| M3 | 接入层：token / WS / 分片上传 / 发消息 | 单测覆盖 payload 组装与刷新逻辑 |
| M4 | 指令路由 + 端到端真机联调 | 测试群内实测 |

## 7. 测试策略

以下均可**脱离真实 QQ 环境**用 mock/fixture 覆盖：token 刷新时序、事件 JSON 解析、`msg_seq` 去重、分片上传状态机（含秒传）、发消息 payload 组装（含 `msg_type=7` 空格 bug）、渲染产物尺寸与字体、以及各类失败兜底路径。

仅 M4 的真机联调需要真实测试群。

# QQ 群机器人 · A 股行业板块热力图（MVP）

群成员在 QQ 群里 `@机器人 大盘`，机器人被动回复一张 A 股行业板块 Treemap 热力图。

技术方案见 [MVP_TECH_PLAN.md](./MVP_TECH_PLAN.md)，接口规格见 [docs/API_BAIDU_BLOCKS.md](./docs/API_BAIDU_BLOCKS.md)（历史调研）。

- 事件接入：QQ 机器人 API v2 · Gateway WebSocket · `GROUP_AT_MESSAGE_CREATE`
- 行情数据：东方财富行业板块接口 `fs=m:90+t:2`
- 出图：d3-hierarchy squarified Treemap → SVG → PNG（`@resvg/resvg-js`）
- 回复：群聊富媒体上传拿 `file_info` → `msg_type=7` 被动回复

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

```bash
# 只验证行情取数与排序（不需要 QQ 凭据）
npm run verify:market

# 本地渲染一张真实数据的 PNG（不需要 QQ 凭据）
npm run render:sample      # 输出 .tmp-probe/preview/market-sample.png

# 排查富媒体上传问题：逐步打印 prepare/PUT/part_finish/merge 的原始响应
npx tsx scripts/diag-upload.ts <group_openid> [图片路径]

# 验证 APP_ID / CLIENT_SECRET 与 Gateway 接入点（不发送消息）
npm run verify:qq

# ★ 验证能否正常收到 QQ 群用户的消息（只监听，不回复）
npm run verify:inbound                # 默认等待 5 分钟
npm run verify:inbound -- 60          # 等待 60 秒
npm run verify:inbound -- 60 --reset  # 更换过机器人账号时，先清理会话缓存
```

`verify:inbound` 会先打印当前 APP_ID、接入点、凭据对应的机器人昵称与 ID，
再等待群 @ 事件。成功时会打印完整的 `GROUP_AT_MESSAGE_CREATE` 事件体
（`msg_id`、`group_openid`、`member_openid`、`content` 等）。

> 会话缓存说明：`.tmp-probe/gateway-session.json` 保存 Gateway 的 `session_id` 与 `seq`，
> 用于进程重启后 Resume。缓存**绑定 AppID 与接入点**，更换账号时会自动丢弃并重新鉴权；
> 如需强制清理可加 `--reset` 或直接删除该文件。

### 4. 启动机器人

```bash
npm start        # 或 npm run dev（文件变更自动重启）
```

启动后到测试群发送：

| 群消息 | 机器人的回复 |
|---|---|
| `@机器人 ping` | `pong · 机器人在线 · 时间` 文本 |
| `@机器人 大盘` | A 股行业板块成交额 TOP20 热力图 |
| `@机器人 帮助` | 指令说明 |
| 其它内容 | 忽略（不回复） |

## 处理流程

```text
Gateway WebSocket
  → GROUP_AT_MESSAGE_CREATE（@机器人）
  → 指令解析（大盘 / ping / 帮助）
  → 事件去重（msg_id + msg_seq）
  → 行情取数（东方财富全量行业板块，短时缓存）
  → 按成交额 f6 降序取 TOP20
  → Treemap 渲染 PNG
  → 群聊分片上传拿 file_info
  → msg_type=7 携带 msg_id 被动回复
```

兜底策略：行情取数或渲染失败时，改为发送文字版成交额 TOP10；图片上传或发送失败时释放去重标记，允许同一事件重试。

## 目录结构

```text
src/
  config.ts            运行配置（环境变量 + zod 校验）
  env.ts               .env 加载（不覆盖已有环境变量）
  logger.ts            统一日志
  index.ts             本地运行入口
  qq/
    token.ts           Access Token 自动刷新
    api-client.ts      QQ HTTP API（发消息、富媒体分片上传）
    gateway.ts         Gateway WebSocket（心跳、重连、Resume）
    dedupe.ts          msg_id + msg_seq 去重
    session-store.ts   会话持久化（重启后 Resume）
    types.ts           事件与 opcode 类型
  market/
    eastmoney.ts       东方财富行业板块取数、过滤、排序
    cache.ts           短时缓存（含请求合并）
    format.ts          成交额/涨跌幅/行情时间格式化
  render/
    treemap.ts         squarified Treemap 布局
    color.ts           涨跌幅 → 颜色映射
    image.ts           SVG/PNG 渲染
  commands/
    parser.ts          @ 消息内容 → 指令
    bot.ts             指令路由、上传、被动回复、兜底
scripts/
  verify-market.ts     行情取数自检
  verify-qq-access.ts  QQ 凭据与接入点自检
  verify-inbound.ts    收消息自检（里程碑 1）
  render-sample.ts     本地出图自检
tests/                 vitest 单元测试
```

## 开发命令

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run check       # 类型检查 + 测试
```

## 常见问题

| 现象 | 排查方向 |
|---|---|
| `verify:inbound` 超时收不到事件 | 机器人是否已加入该群；群里 @ 的是否是这个机器人；沙箱群需 `QQ_ENV=sandbox` |
| 换了 APP_ID 却仍连上上一个机器人 | 已修复：会话缓存绑定 AppID 会自动失效；必要时 `npm run verify:inbound -- 60 --reset` 清理 `.tmp-probe/gateway-session.json` |
| 错误码 `40034024` / `40034005` | `msg_id` 无效或已过期（被动回复必须在 5 分钟内） |
| 错误码 `40054005` | 消息被去重，检查 `msg_seq` 是否重复 |
| 错误码 `850031` | 上传文件超过大小限制 |
| 错误码 `850019` | 富媒体文件格式不支持：分片上传了空内容（多为分片偏移算错，见下方「已知实现要点」） |
| 错误码 `850026` | URL 上传时 platform 下载失败（本地开发请用分片上传，本项目已默认使用） |
| 错误码 `11251` / `100016` | `APP_ID` / `CLIENT_SECRET` 不正确 |
| 图片中文显示为方块 | 系统缺少中文字体，用 `FONT_FILES=C:\Windows\Fonts\msyh.ttc` 显式指定 |
| 关闭码 4914 | 机器人已下架 / 环境不匹配，需确认沙箱与正式环境配置 |

## 说明

- 图片按成交额降序展示 TOP20 行业板块，矩形面积＝成交额，颜色＝涨跌幅（红涨绿跌）。
- 行情结果默认缓存 60 秒（`MARKET_CACHE_TTL_MS`）。
- 东方财富接口是公开网页行情接口，无稳定性保证，MVP 未接入备用数据源。
- **行情时间说明**：图片标注的是数据源返回的 `f124`（行情时间）。
  - 交易日盘中：随行情刷新；
  - 收盘后：定格在当日收盘数据；
  - 周末/节假日：定格在**上一个交易日**的收盘数据，此时图片会额外标注
    「（非今日，上一交易日数据）」以免误读成实时行情。
- **GateWay 会话**：默认每次启动都新建会话（`SESSION_RESUME=false`）。
  平台对已失效会话也会回 `RESUMED` 但不再推送事件，因此不建议默认开启 Resume；
  若确实需要补发断线事件，可设 `SESSION_RESUME=true`，此时 `RESUME_GRACE_MS`
  看门狗会在窗口内无事件时自动重新鉴权。
- 调试用图片落盘在 `.tmp-probe/images`，Gateway 会话状态在 `.tmp-probe/gateway-session.json`（均已被 git 忽略）。

## 已知实现要点（实测踩坑记录）

| 项 | 说明 |
|---|---|
| 分片上传的 `index` 是 1-based | 官方文档示例写 0-based，实测服务端下发首个分片为 `index: 1`。偏移必须按 `(index - 1) * blockSize` 计算，否则会从文件末尾开始上传 **0 字节**（COS 仍返回 200），合并时报 `850019 富媒体文件格式不支持` |
| 本地开发必须用分片上传 | URL 上传要求平台能访问到图片地址，`localhost` 不可用 |
| 被动回复时效 | `msg_id` 5 分钟内有效，同一 `msg_id` 最多回复 5 次，需配合 `msg_seq` |


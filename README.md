# QQ 群机器人 · A 股板块资金流热力图（MVP）

群成员在 QQ 群里 `@机器人 大盘`，机器人被动回复**两张** Treemap 热力图：
行业板块 TOP25 与概念板块 TOP25（按主力净流入额排序）。

技术方案见 [MVP_TECH_PLAN.md](./MVP_TECH_PLAN.md)。

- 事件接入：QQ 机器人 API v2 · Gateway WebSocket · `GROUP_AT_MESSAGE_CREATE`
- 数据源：东方财富板块资金流接口（行业 `fs=m:90 t:2` / 概念 `fs=m:90 t:3`，按 `f62` 主力净流入排序）
- 出图：d3-hierarchy squarified Treemap → SVG → PNG（`@resvg/resvg-js`）
- 回复：群聊富媒体上传拿 `file_info` → `msg_type=7` 被动回复，两张图各自渲染完即发

相关文档：

- [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) —— 部署、字体、故障排查、踩坑记录、性能实测
- [docs/API_EASTMONEY_FUNDFLOW.md](./docs/API_EASTMONEY_FUNDFLOW.md) —— 东方财富资金流接口字段与实测校验

## 快速开始（本地运行）

### 1. 准备 QQ 机器人

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，拿到 `AppID` 与 `AppSecret`（ClientSecret）。
2. 在「开发设置」中把**机器人加入测试群**（沙箱环境需要单独配置沙箱群）。
3. 群内 @ 机器人发送消息，事件类型为 `GROUP_AT_MESSAGE_CREATE`（Intent `1<<25`）。

### 2. 安装依赖与凭证

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

依赖一览（Node 20.12+）：

| 包 | 用途 |
|---|---|
| `ws` | Gateway WebSocket 长连接 |
| `zod` | 环境变量与外部接口响应校验 |
| `d3-hierarchy` | Treemap squarified 布局 |
| `@resvg/resvg-js` | SVG → PNG 渲染 |

> 中文字体：程序会自动使用 `assets/fonts/` 下的自带字体（构建阶段由
> `scripts/fetch-font.mjs` 下载 Noto Sans SC 的 **Regular + Bold 静态字重**并校验 SHA-256）。
> 也可用 `FONT_FILES` 指向任意已有中文字体。
>
> ⚠️ 不要改回可变字体（VF）：resvg 不支持 `wght` 轴，只会用默认实例，
> `font-weight` 会被静默忽略，字迹会变得极细（看起来像「模糊」）。
> 详见 [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) 第四节。

## 验证与启动

### 分步验证

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

> 会话缓存：`.tmp-probe/gateway-session.json` 保存 Gateway 的 `session_id` 与 `seq`，
> 仅在 `SESSION_RESUME=true` 时用于 Resume。缓存**绑定 AppID 与接入点**，更换账号时会自动丢弃；
> 如需强制清理可加 `--reset` 或直接删除该文件。

### 启动机器人

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

> `大盘` **不发送文字榜单**，数据全部通过图片呈现；只有在两张图都失败时，才发一条错误说明文字。

### 其它命令

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run check       # 类型检查 + 测试
npm run fetch-font  # 手动补下中文字体
```

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

### 为什么用引用回复而不是 @ 发言人

群聊接口**不支持**机器人在消息里 @ 群成员——发送群消息的请求体只有
`msg_type / content / markdown / keyboard / msg_id / msg_seq / media / message_reference`，
没有 `mentions` 之类的字段（[@ 是主消息的属性，而图片是另一条消息，无法跟随](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)）。

替代方案：**引用回复**。事件体的 `message_scene.ext` 里有 `msg_idx`（即被引用消息 ID），
把它填进请求的 `message_reference.message_id`，QQ 客户端就会把图片渲染成引用用户那条消息的卡片，
视觉上紧挂在发言人下面。

## 目录结构

```text
src/
  config.ts            运行配置（环境变量 + zod 校验）
  env.ts               .env 加载（不覆盖已有环境变量）
  logger.ts            统一日志
  index.ts             机器人入口（npm start）
  health-server.ts     平台注入 PORT 时的 /health 监听（本地不启用）
  instance-lock.ts     单实例保护（避免两个进程重复回复）
  qq/
    token.ts           Access Token 自动刷新
    api-client.ts      QQ HTTP API（发消息、富媒体分片上传）
    gateway.ts         Gateway WebSocket（心跳、重连、Resume 看门狗）
    dedupe.ts          msg_id 去重
    session-store.ts   会话持久化（绑定 AppID，重启后可选 Resume）
    types.ts           事件与 opcode 类型
  market/
    fundflow.ts        东方财富行业/概念板块资金流取数（分页+重试+缓存）
    fundflow-types.ts  资金流领域模型（周期、板块类型、快照）
    sectors.ts         资金流 → Treemap 渲染块（取主力净额前 25）
    cache.ts           短时缓存（含请求合并）
    format.ts          金额/涨跌幅/行情时间格式化、图片文案
    types.ts           渲染块领域模型（MarketBlock）
  render/
    treemap.ts         squarified Treemap 布局
    color.ts           涨跌幅 → 颜色映射
    image.ts           SVG/PNG 渲染（含内容级缓存）
    font-check.ts      启动时的中文字体探针
  commands/
    parser.ts          @ 消息内容 → 指令
    bot.ts             指令路由、两图并发发送、被动回复、兜底
scripts/
  verify.ts            统一自检入口（fundflow / render / qq / inbound / upload）
  fetch-font.mjs       构建阶段下载中文字体
tests/                 vitest 单元测试
```

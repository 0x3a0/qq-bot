# 部署与运维

本项目是常驻 Node.js 服务：启动后主动连出 QQ Gateway WebSocket 接收群消息，
通过 QQ HTTP API 上传图片并被动回复。**不监听端口、不需要公网域名**。

仓库提供 `render.yaml` 蓝图，Dashboard → New → **Blueprint** → 选本仓库即可开始。
下面是与平台交互中容易踩坑的地方，以及线上故障的排查表。

## 一、Render 部署约束

### 1. Web Service 必须绑定 `PORT`

Render 的 Web Service 如果没在限期内监听 `PORT`，会被判定部署失败。
但本服务业务上只主动连出，并不需要端口。

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

> 该行为对 Web Service、Private Service、**Background Worker** 都适用，
> 因此换成 Worker 并不能绕过，仍须手动关闭。

### 3. 实例数必须为 1

本项目用 WebSocket 长连接、去重状态在进程内存里，**不能水平扩容**：
两个实例会各自建立 Gateway 连接，同一条消息被回复两次。

### 4. 免费实例 15 分钟会休眠

Render 免费 Web 实例在 15 分钟内既没有 HTTP 请求、也没有收到 WebSocket 消息时会休眠
（[2026-02 更新](https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages)：
现在收到 WebSocket 消息也会续命）。对本服务的实际影响：

- QQ Gateway 由我们主动连出，其下行流量属于 WebSocket 消息，能续命；
- 但群里如果**连续 15 分钟没人 @ 机器人**，就没有下行消息，实例会被休眠，
  此时机器人收不到任何消息；
- 因此免费实例**不适合真正当服务用**。要稳定运行请用付费实例或 Background Worker。

## 二、部署步骤

1. Render → New → Blueprint → 选择本仓库（读取 `render.yaml`）
2. 在控制台填 `APP_ID`、`CLIENT_SECRET`（蓝图里标了 `sync: false`，不会进仓库）
3. Settings → Deploy → **关闭 Zero-Downtime Deploy**
4. 确认实例数为 1、`healthCheckPath` 为 `/health`

## 三、部署后验证

日志应出现：

```text
[INFO] [app] 未找到 .env，使用进程内环境变量      ← 容器里正常
[INFO] [app] 字体检查通过（探针 2531B），使用自带字体（1 个文件）
[INFO] [app] 已监听 PORT=10000，仅提供 /health 健康检查（平台就绪判据）
[INFO] [app:gateway] Gateway 鉴权成功 READY，session_id=…，机器人=…
[INFO] [app] 现在可以在测试群里 @机器人 发送「大盘」或「ping」
```

再访问 `https://<你的服务>.onrender.com/health`，应返回 `ok`（Gateway 未就绪时返回 503）。

## 四、中文字体（已自动处理）

Render 的原生运行时是 **Debian 12，不带任何中文字体**（官方工具清单里没有字体包），
而 resvg 缺字形时**不会报错**——只会画成一排「框框」。

现已自动化，通常无需任何配置：

1. **构建阶段**自动下载 Noto Sans SC（OFL-1.1）到 `assets/fonts/` 并校验 SHA-256
   （`scripts/fetch-font.mjs`，由 `prebuild` 触发）。字体 17MB，因此不入库。
2. **运行时**自动发现并使用它（`detectBundledFonts()`），无需手动设 `FONT_FILES`。

若构建日志出现 `[fetch-font] ⚠️ 字体下载失败`：

```bash
# 换个更快的镜像重下（国内访问 GitHub 可能很慢，实测本机 17MB 用了 2 分钟）
FONT_DOWNLOAD_URL=https://mirror.example.com/NotoSansSC-VF.ttf npm run fetch-font

# 或直接把字体文件放进 assets/fonts/，程序会自动识别
# 或用 FONT_FILES 指向任意已有的中文字体
FONT_FILES=/path/to/NotoSansSC-Regular.otf
```

> 上游字体若更新，SHA-256 校验会失败并给出明确提示（需同步改脚本里的期望值）。
> **想要离线可构建**，可把字体文件提交进仓库（把 `assets/fonts/` 从 `.gitignore`
> 移除），代价是仓库体积增加约 17MB。

## 五、故障排查

| 现象 | 排查方向 |
|---|---|
| **同一个指令被回复了两遍 / 收到重复图片** | 多半是两个实例同时连着同一机器人（平台会把同一条消息投递给每个连接）。三种可能：① 本地开了两个进程（程序有单实例保护会直接拒绝启动，锁文件在 `.tmp-probe/bot.lock`）；② 平台副本数 > 1；③ **零停机部署**——新旧实例会并存约 60 秒，需在平台设置里关闭 |
| **图片中文显示为「框框」/ 有色块没文字** | 环境缺中文字体（resvg 静默失败，不报错）。看构建日志有无 `[fetch-font] ⚠️`；也可 `npm run fetch-font` 手动补下，或用 `FONT_FILES` 指向已有中文字体 |
| **部署一段时间后机器人不响应，日志也停了** | Render 免费实例 15 分钟无流量会休眠。改用付费实例或 Background Worker |
| 部署后立刻退出 | 多半是没配 `APP_ID` / `CLIENT_SECRET`（`.env` 不在仓库里）。日志会打印「配置校验失败」 |
| Render 部署失败并提示未绑定端口 | Web Service 必须监听 `PORT`。程序会在检测到 `PORT` 时自动开一个仅含 `/health` 的监听；若日志报了端口监听失败，检查 `PORT` 是否被其他进程占用 |
| `verify -- inbound` 超时收不到事件 | 机器人是否已加入该群；群里 @ 的是否是这个机器人；沙箱群需 `QQ_ENV=sandbox` |
| 换了 APP_ID 却仍连上上一个机器人 | 会话缓存绑定 AppID 会自动失效；必要时 `npm run verify -- inbound 60 --reset` 清理 `.tmp-probe/gateway-session.json` |
| 错误码 `40034024` / `40034005` | `msg_id` 无效或已过期（被动回复必须在 5 分钟内） |
| 错误码 `40054005` | 消息被去重，检查 `msg_seq` 是否重复 |
| 错误码 `850031` | 上传文件超过大小限制 |
| 错误码 `850019` | 富媒体文件格式不支持：分片上传了空内容（多为分片偏移算错，见下） |
| 错误码 `850026` | URL 上传时平台下载失败（本地开发请用分片上传，本项目已默认使用） |
| 错误码 `11251` / `100016` | `APP_ID` / `CLIENT_SECRET` 不正确 |
| 关闭码 4914 | 机器人已下架 / 环境不匹配，需确认沙箱与正式环境配置 |

## 六、实机踩坑记录

这些结论都来自真实调试，写在这里避免重复踩：

| 项 | 说明 |
|---|---|
| 分片上传的 `index` 是 **1-based** | 官方文档示例写 0-based，实测服务端下发首个分片为 `index: 1`。偏移必须按 `(index - 1) * blockSize` 计算，否则会从文件末尾开始上传 **0 字节**（COS 仍返回 200），合并时报 `850019 富媒体文件格式不支持` |
| 本地开发必须用分片上传 | URL 上传要求平台能访问到图片地址，`localhost` 不可用 |
| 被动回复的 `msg_seq` 必须动态分配 | 平台对相同 `msg_id + msg_seq` 直接判重（`40054005`）。硬编码固定序号、或失败后沿用原序号重试都会踩坑；本项目每次发送前认领未被占用的序号 |
| 认领过的 `msg_seq` 不能归还 | 两条图片链路并发发送，归还序号会让两个发送撞到同一个 seq（实测出现 `[1,1,2]`）；且平台已把该 seq 记为用过，复用必被判重 |
| 图片上传走内存而非临时文件 | 曾用「渲染落盘 → 按路径读取上传」，两个进程/并发任务在同一毫秒会写出**同名文件**互相覆盖，导致 A 图被上传成 B 图（实测行业图与概念图都变成了概念图）。现在 `uploadGroupFileFromBuffer` 直接吃 Buffer |
| 两个进程连同一机器人会重复回复 | 平台把同一条群消息投递给每个 Gateway 连接。`src/instance-lock.ts` 用锁文件 + 存活探测在启动阶段拦截（跨容器看不到彼此的文件，需靠实例数=1） |
| 被动回复时效 | `msg_id` 5 分钟内有效，同一 `msg_id` 最多回复 5 次（`msg_seq` 1..5），用尽后平台报 `40034128` |
| 平台可能对同一事件重复投递 | 需按 `msg_id` 去重；重投时 `msg_id` 通常不变，但**内容相同的两条真实消息 `msg_id` 是不同的** |
| 群聊不支持机器人 @ 群成员 | 请求体没有 `mentions` 字段；用 `message_reference` 做引用回复替代 |

## 七、性能实测（1200x900 热力图）

`@机器人 大盘` 的端到端耗时构成（本机实测）：

| 阶段 | 耗时 | 说明 |
|---|---|---|
| 资金流取数（行业 496 条 / 概念 504 条） | 1.8s / 5.7s | 各自 5~6 页串行请求，**单页延迟波动很大**（实测 110ms ~ 1.8s） |
| treemap 布局 + 拼接 SVG | ~0ms | 纯计算，可忽略 |
| PNG 渲染（每张） | 1.5 ~ 2.4s | 几乎全部是**中文字形处理**，见下 |
| 分片上传（约 105KB） | ~1.6s | 4 次 HTTPS 往返：prepare → PUT → part_finish → merge |
| 发送富媒体消息 | ~1.2s | 平台侧转存图片 |

两条链路**并发**，总耗时接近「较慢的那条」而非两者相加；第一张图在自身链路完成后立即发出。

### 渲染为什么慢

`@resvg/resvg-js` 处理 **CJK 字形**的开销远高于拉丁字符（实测约 140ms/中文文本节点
vs 约 7ms/英文节点），且字体库无法跨 `Resvg` 实例复用。已排除的优化方向：

- 光栅化本身只要 ~10ms、PNG 编码 ~20ms，开销都在文本处理
- 把全部文本合并成单个 `<text>` + `<tspan>` **没有改善**（1324ms vs 1379ms，在噪声内）
- 用 `<defs>` + `<use>` 复用文本节点 **没有改善**（每个板块名都不同，无法复用）
- 显式用 `FONT_FILES` 指定字体（跳过系统字体扫描）约省 15%

因此实现采用**内容级 PNG 缓存**：同一份行情数据只渲染一次，重复请求 0ms 命中
（实测 `2238ms → 1ms`）。行情每 60 秒刷新，通常只有每个行情周期的首个请求付渲染成本。

要进一步压缩，最彻底的办法是把文字预先转成 SVG `<path>`（需字体子集化，如 `opentype.js`），
让 resvg 完全不处理文本；MVP 暂未采用。

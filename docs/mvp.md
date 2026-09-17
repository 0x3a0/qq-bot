# QQ 行情 Bot MVP

## 1. 目标

开发一个基于 NapCatQQ 和 OneBot 11 的 QQ 群机器人：

- 仅在用户明确 `@bot a股` 或 `@bot 美股` 时回复；
- 直接请求百度财经现有页面并截图；
- 按固定顺序向当前 QQ 群依次发送对应市场行情图片；
- 支持本地开发连接远程 NapCat，并可部署到 Docker；
- 不再维护本地行情数据 Provider、HTML/CSS 行情模板或自渲染总览图。

## 2. 连接方式

NapCat 提供 OneBot 11 正向 WebSocket 服务，Bot 负责接收群消息和调用 `send_group_msg`：

```text
本地开发：Bot  -- WebSocket 客户端 -->  <远程 NapCat 主机>:11451 NapCat WS 服务端
后续部署：Bot 容器 -- WebSocket 客户端 --> NapCat 容器的服务名/IP:11451
```

Bot 不实现 QQ 协议，也不保存行情数据。截图脚本在 Bot 运行环境中执行，页面必须能访问百度财经。

## 3. 交互流程

### 触发条件

机器人只处理群聊中明确 `@bot` 的消息，文本内容去除空格后等于 `a股` 或 `美股`，大小写不影响匹配。

以下内容不处理：

- 私聊消息；
- 未 `@bot` 的 `a股`、`美股`；
- 旧的 `板块涨跌`、`板块资金` 和其他命令。

### 截图与回复

每次触发执行 [百度财经截图脚本](../demo/baidu-finance-market-screenshot.mjs)，生成并按顺序发送以下图片：

1. A 股涨跌分布；
2. A 股热门板块：行业板块，包含最新异动；
3. A 股热门板块：概念板块，包含最新异动；
4. 热力图：行业板块；
5. 热力图：概念板块；
6. A 股主力净流入：行业；
7. A 股主力净流入：概念。

图片先写入一次性临时目录，再按脚本输出顺序逐张转为 Base64 图片消息发送；全部发送完成后删除临时目录。截图失败、图片缺失或 OneBot 发送失败时，回复 `A股行情截图获取或发送失败，请稍后重试。`。

`@bot 美股` 使用同一截图脚本的 `--market us` 模式，请求 `https://finance.baidu.com/?quotationMarket=us` 获取美股涨跌分布、主力净流入和热门板块，再请求 `https://finance.baidu.com/heat-treemap/home/us?tab=HY&value=amount&financeType=block` 获取板块热力图，共发送 4 张图片。失败时回复 `美股行情截图获取或发送失败，请稍后重试。`。

## 4. 技术方案

- Node.js 24 和 TypeScript；
- `ws`：OneBot 正向 WebSocket 客户端；
- `playwright`：运行现有百度财经页面截图脚本；
- `demo/baidu-finance-market-screenshot.mjs`：截图流程唯一实现；
- `src/capture/baidu-finance-screenshots.ts`：调用脚本并按市场校验 A 股 7 个或美股 4 个输出文件；
- `src/bot/market-reply.ts`：管理临时目录、图片读取和群消息发送；
- `src/bot/a-share-reply.ts`、`src/bot/us-share-reply.ts`：分别处理两个市场的失败提示和截图流程。

不使用同花顺 API、旧行情缓存、HTML/CSS 自渲染、模拟数据或旧命令兼容分支。每次回复都是实时访问页面和实时截图，不做定时推送。

## 5. 配置

```env
ONEBOT_WS_URL=ws://your-napcat-host:11451
ONEBOT_WS_TOKEN=替换为NapCat中配置的Token
BOT_QQ=机器人QQ号
```

截图浏览器可通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定；页面地址可通过 `BAIDU_FINANCE_URL` 和 `BAIDU_FINANCE_HEATMAP_URL` 覆盖。
美股页面地址可通过 `BAIDU_FINANCE_US_URL` 覆盖，默认值为 `https://finance.baidu.com/?quotationMarket=us`。

## 6. 验收标准

1. Bot 能连接 `.env` 配置的 OneBot WebSocket 地址，断线后自动重连。
2. 群内 `@bot a股` 能按固定顺序收到 7 张百度财经截图。
3. 群内 `@bot 美股` 能请求 `quotationMarket=us` 页面及美股板块热力图页面，并按固定顺序收到 4 张百度财经截图。
4. 美股热力图截图为板块内部数据，且默认选中行业板块。
5. 热门板块截图包含行业/概念切换结果和下方最新异动区域。
6. 热力图截图保持横向布局，输出高度为 756px。
7. 未 `@bot`、私聊和旧命令不会触发回复。
8. 截图失败、图片缺失或发送失败时有清晰错误提示。
9. 临时图片发送完成后会被删除。
10. `npm test` 通过，且文档与当前命令、配置和截图顺序一致。

## 7. 暂不纳入

- 定时推送或后台循环发送；
- 任意股票代码查询；
- 多群独立配置；
- 数据库存储和 Web 管理后台；
- 自定义 HTML/CSS 行情渲染。

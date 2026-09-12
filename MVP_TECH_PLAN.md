# QQ Bot 行情图片 MVP 技术方案

## 1. MVP 目标

群成员在 QQ 群中 `@机器人 大盘`，机器人被动回复：

- 一张 A 股行业板块 Treemap 热力图
- 一张美股行业板块 Treemap 热力图

第一版不做定时推送、个股查询、自选股、订阅和管理后台。

## 2. 接入方向

- 使用 QQ 机器人 API v2。
- 通过 WebSocket 接收 `GROUP_AT_MESSAGE_CREATE` 事件，只处理被 @ 的消息。
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

- Python 3.13
- `httpx`：调用 QQ API 和行情接口
- `websockets`：维护 QQ Gateway 长连接
- SVG + `resvg` 或 Pillow：生成 PNG 图片
- `pytest`：单元测试
- 一台常驻运行的 Linux VPS 或 Docker 容器

可以使用腾讯官方 `botpy` SDK；如果需要完全控制重连、去重和富媒体上传，则使用 `httpx + websockets` 实现轻量接入层。

## 4. 数据与图片

### A 股

第一版使用东方财富行业板块数据，取行业名称、涨跌幅和成交额。行情接口封装在独立的数据源模块中，图片上标注数据源和更新时间。

### 美股

第一版使用 11 个 SPDR 行业 ETF 作为行业代理，例如科技 `XLK`、金融 `XLF`、能源 `XLE`。图片中明确标注“行业 ETF 代理”，后续再评估 Finnhub 等真正的行业聚合数据源。

### 图片

- 使用 Treemap 展示板块。
- 面积表示成交额或成交量权重。
- 颜色表示涨跌幅。
- 输出固定尺寸 PNG，目标小于 5 MB。
- 图片中显示市场、数据源和行情时间。

## 5. 处理流程

```text
WebSocket 事件
  -> 解析 @机器人 指令
  -> 查询缓存或行情数据
  -> 生成 A 股/美股图片
  -> 群聊富媒体上传
  -> 携带 msg_id 被动回复
```

需要具备：

- Access Token 自动刷新
- WebSocket 心跳、断线重连和 Resume
- `msg_id + msg_seq` 去重
- 行情短时缓存和失败兜底

## 6. 里程碑

1. 测试群中完成机器人注册和 `@` 事件接收。
2. 完成 Token、WebSocket 和文本回复。
3. 完成 A 股数据与 Treemap 图片。
4. 完成富媒体上传并发送 A 股图片。
5. 接入美股 ETF 数据并发送第二张图片。
6. 补齐缓存、重连、错误处理和单元测试。

## 7. MVP 验收标准

在测试群中发送 `@机器人 大盘`，能够在 5 分钟内收到两张带有更新时间和数据源标记的行情图片；重复事件不会重复发图；数据源或图片生成失败时能够返回文字错误提示。

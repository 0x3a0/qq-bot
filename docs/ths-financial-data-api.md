# 同花顺金融数据 API 接入调研

调研日期：2026-09-17
权威契约：[同花顺完整接口契约](https://fuyao.aicubes.cn/llms-full.txt)；在线 API 文档：[接口总览](https://fuyao.aicubes.cn/docs/api-reference/overview/)。

本文记录当前 QQ Bot 所需功能的 REST 接口可行性和迁移约束。板块涨跌已于 2026-09-17 完成迁移并通过真实 Key 联调，本文保留的契约约束继续作为实现与测试的口径。Bot 必须使用 REST API，不使用 MCP Tool。

## 结论

| 当前能力 | 结论 | 同花顺链路 | 接入决定 |
|---|---|---|---|
| `@bot 板块涨跌` | 可实现 | 指数目录 + 指数行情快照；关联股票再用指数成分股 + A 股行情快照计算 | 可迁移到同花顺，前提是部署 API Key 已获对应 capability 权限并完成联调。 |
| 财经新闻转发 | 当前无匹配接口 | 当前契约只列出单只基金资讯列表 | 该接口不能代替通用 A 股财经新闻。等待同花顺提供通用新闻 capability 后再设计此功能。 |

2026-09-17 已使用部署环境的真实 API Key 完成四个 capability 的联调验证（Key 本身不落入任何文件或输出）：

- 指数目录：`tag=industry` 返回 320 条、`tag=cn_concept` 返回 390 条，`code=0`，无重复 `thscode`，字段为 `thscode` + `name`。
- 指数快照：批量 100（约 2.4s）与 200（约 5.1s）个代码均正常返回，字段与契约一致；`price_change_ratio_pct` 为百分比数值。
- 成分股：单个指数一次返回全部成分股（行业 `881101.TI` 30 只，概念 `885431.TI` 达 1060 只），含 `thscode`、`ticker`、`name`。
- 股票快照：批量 100 个代码正常返回，无 `name` 字段，名称须取自成分股接口。
- Provider 全链路实测（当时的 Top 6 展示规格）：约 41 个请求、总耗时约 7.5s，受限并发 3 下未触发 429/4001。当前 Top 10 规格会额外查询展示板块的成分股；上线前应以部署 Key 重新记录请求数和耗时，不将该历史数据当作当前性能承诺。

## 通用 REST 契约

- Base URL：`https://fuyao.aicubes.cn`。
- 每个 `/api/**` 请求都通过 `X-api-key: <your-api-key>` 鉴权。Key 只能来自本地环境变量或部署密钥管理，不能写入源码、测试夹具、日志、示例或文档。
- 正常进入业务处理的响应使用 `ApiResponse` 信封；客户端必须同时校验 HTTP 状态和响应 `code === 0`，不能只检查 HTTP 200。
- 标的使用带交易所后缀的完整 `thscode`；时间戳是 Asia/Shanghai 语义下的毫秒 Unix 时间戳。
- `HTTP 429` 或业务 `code=4001` 都表示限流。官方未承诺固定 QPS，遇限流不得立即连续重试，应降低并发并采用带抖动的退避。
- `2001`、`2003`、`3001`、`3002`、`3004` 不应盲目重试；`5001`、`5002`、`5003` 才可在有限次数内重试。所有失败均不能转向东方财富或旧缓存数据。

## 板块涨跌接口

### 所需端点

| 用途 | REST 端点和参数 | 关键输出 | 使用规则 |
|---|---|---|---|
| 行业目录 | `GET /api/a-share-index/catalog/ths-index-list?tag=industry` | `data.item[].thscode`、`name` | 单个 tag 全量返回，无分页。 |
| 概念目录 | `GET /api/a-share-index/catalog/ths-index-list?tag=cn_concept` | `data.item[].thscode`、`name` | 只用这一分类；不得混入 `region` 或 `tszs`。 |
| 板块行情 | `GET /api/a-share-index/prices/snapshot?thscodes=<逗号分隔的指数代码>` | `thscode`、`last_price`、`price_change_ratio_pct`、`volume`、`turnover`、`data.timestamp` | 必须显式传入指数代码；目录结果中的名称用于展示，因为快照不返回名称。 |
| 板块成分股 | `GET /api/a-share-index/constituents/ths-stock-list?thscode=<指数代码>` | `thscode`、`ticker`、`name` | 每次只支持一个指数；用于计算卡片内的关联股票。 |
| 成分股行情 | `GET /api/a-share/prices/snapshot?thscodes=<逗号分隔的股票代码>` | `thscode`、`price_change_ratio_pct`、`last_price`、`volume`、`turnover` | 批量查询；快照不返回中文名，名称必须使用成分股接口结果。 |

指数快照和 A 股快照的涨跌幅字段 `price_change_ratio_pct` 均为百分比数值，例如 `1.74` 表示 `+1.74%`，不能再除以 100。

### 数据流和字段映射

    industry 目录 ─┐
                    ├─> 指数快照 ─> 各分类独立排序 ─> 涨幅 Top 10 / 跌幅 Top 10
    cn_concept 目录 ─┘                                      │
                                                           v
                                                选中板块的成分股目录
                                                           │
                                                           v
                                             去重后的成分股行情快照
                                                           │
                                                           v
                                               计算每张卡片的关联股票

| Bot 领域字段 | 同花顺来源 | 计算或校验规则 |
|---|---|---|
| `MarketCategory = "industry"` | 目录 `tag=industry` | 只与行业目录对应。 |
| `MarketCategory = "concept"` | 目录 `tag=cn_concept` | 领域类型名称保持兼容，但请求 tag 必须是 `cn_concept`。 |
| `BoardPerformanceSector.code` | 目录和指数快照的 `thscode` | 两者必须一一匹配。 |
| `BoardPerformanceSector.name` | 指数目录 `name` | 不能从指数快照推断。 |
| `changePercent` | 指数快照 `price_change_ratio_pct` | 按数值降序取涨幅榜、升序取跌幅榜；两个分类分别排序。 |
| `leader` | 选中板块成分股的 `name` | API 没有直接的领涨/领跌股字段。涨幅榜取成分股涨跌幅最大者，跌幅榜取最小者。 |
| `leaderChangePercent` | 该成分股快照的 `price_change_ratio_pct` | 同上述关联股票一起取得；同值时按完整 `thscode` 升序打破平局，保证测试可重复。 |
| `fetchedAt` | 指数快照 `data.timestamp` | 使用上游数据时间，不得用本地请求完成时间伪装为数据时间。若分批时间戳不一致，必须按明确的容差策略重试或报错，不能静默拼接为同一时点快照。 |

每个分类必须有完整、无重复且涨跌幅为有限数值的指数快照后才能排序；不足 20 条、目录条目缺快照或关联股票无法确定时，应令整次回复失败。这样不会把部分数据包装成完整的 Top 10。

### 请求策略

1. 每次指令分别拉取 `industry` 与 `cn_concept` 目录，再用对应的指数快照形成板块排行。
2. 从两个排行榜去重后，只为实际展示的板块拉取成分股；汇总、去重成分股代码后批量取股票快照。
3. 文档没有声明显式 `thscodes` 模式的最大批量数或 URL 长度上限。上线前应使用真实 Key 做探测，并将分块大小做成可配置项；不能把全市场分页默认值 `limit=100` 误认为批量上限。
4. 所有分块请求应有受限并发。遇 `429` 或 `4001` 时暂停并退避；不要用四个或更多不受控的并发批次冲击服务。
5. 不缓存或回退使用旧的行情、关联股票或排行结果。若未来需要缓存目录，目录缓存也不能成为行情请求失败时的旧排行回退。

## 当前未匹配能力

### 通用财经新闻

完整契约当前只包含 `GET /api/fund/news/article-list`。它要求单只基金 `thscode`，返回的是该基金的游标分页资讯，不能查询或订阅 A 股市场通用新闻。当前没有发现可满足金融新闻转发需求的通用 A 股新闻端点。

## 迁移准入与测试

2026-09-17 已用部署环境 Key 验证目录、指数快照、成分股和 A 股快照四个 capability 的权限与真实返回字段（见上文联调记录），迁移已同步完成 Provider、配置、测试、卡片页脚数据来源和用户文档更新；东方财富实现及其回退链路已删除，未并行保留。

至少覆盖以下测试：

- 每个请求发送 `X-api-key`，且错误日志、断言失败信息和测试夹具均不包含 Key。
- 只请求 `industry`、`cn_concept`，绝不请求或混入 `region`、`tszs`。
- 正确校验 HTTP、`ApiResponse.code`、`data.timestamp`、重复代码、缺失条目和非有限涨跌幅。
- 行业、概念独立按 `price_change_ratio_pct` 排出各自涨幅 Top 10 和跌幅 Top 10。
- 关联股票来自已选板块的当前成分股和股票快照，并锁定最大/最小值及平局规则。
- `2001`、`2003`、`4001`、HTTP 429 和上游 `5xxx` 的行为符合上文策略；失败时不发送旧数据。
- 不存在东方财富端点或分时走势请求。

## 参考

- [完整接口契约](https://fuyao.aicubes.cn/llms-full.txt)
- [指数数据](https://fuyao.aicubes.cn/docs/api-reference/a-share-index/)
- [A 股行情快照](https://fuyao.aicubes.cn/docs/api-reference/prices/)
- [基金资讯列表](https://fuyao.aicubes.cn/docs/api-reference/fund-news/)

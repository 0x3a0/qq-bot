# 百度股市通 板块列表接口（`/vapi/v2/blocks`）规格

> 来源：用户提供的浏览器 curl 请求（Chrome 152 / Windows，Referer `https://finance.baidu.com/`）
> 实测时间：**2026-09-12 15:53–15:58 CST**（周六，最近交易日为 2026-09-11）
> 实测环境：Node.js v24 `fetch`（本机 pwsh 5.x 的 `Invoke-WebRequest` 同样可用）
> 实测方式：直接复用一个已签发的浏览器会话（`acs-token` + `BAIDUID` Cookie），逐参数枚举

---

## 1. 请求接口

| 项目 | 值 |
|---|---|
| 方法 | **`GET`** |
| 完整 URL | `https://finance.pae.baidu.com/vapi/v2/blocks` |
| 用途 | 板块（行业/概念）列表，供前端 Treemap 热力图与板块列表页使用 |
| 前端调用点 | `index.14c6dceb.js` 中的 `getBlocksListData`（`v2/blocks`）；页面路由标记 `heat-treemap-home` / `blocklist` |
| 响应类型 | `application/json; charset=utf-8` |
| 实测延迟 | 78–848 ms（同一会话内） |

URL 中**没有路径参数**，所有条件都通过 Query String 传递。

---

## 2. 必要参数

### 2.1 Query 参数

| 参数 | 必需 | 实测值 | 含义与实测结论 |
|---|---|---|---|
| `market` | ✅ | `ab` | 市场。`ab` = A 股（含沪 SH / 深 SZ / 北 BJ，见 `exchange` 字段）。**改任何其他值直接 403**（实测 `sh`/`sz`/`bj`/`hk`/`us`/`hs`/`all`/`unknown` 全部 403，非风险控制） |
| `typeCode` | ✅ | `HY` | 板块类型代码，`HY` = 行业板块。前端另有 `HY2`（二级行业）/`GN`（概念）等取值，但**本次未验证通过**（见 §7） |
| `sortKey` | ✅ | `amount` | 排序字段。取值为**响应中的字段名**：`amount`（成交额）/`pxChangeRate`/`marketValue`/`volume`/`lastPx`/`name`/`code` |
| `sortType` | ✅ | `desc` | 排序方向，`desc` / `asc` |
| `style` | ✅ | `heatmap` | 数据形态。`heatmap` 返回适合热力图渲染的精简结构（含 `rawData`） |
| `pn` | ✅ | `0` | **页码，0-based**。实测 `pn=0`→半导体,通信设备…；`pn=1`→通信设备,元件…；`pn=2`→元件,工业金属…，相邻页恒定重叠 1 条，故 `offset = pn × rn`（**不是** offset 本身） |
| `rn` | ✅ | `100` | 每页条数。实测生效：`rn=10`→10 条，`rn=200`→131 条，`rn=1000`→仍 131 条。**该分类下全量为 131 个板块**（`rn≥131` 一次取全） |
| `finClientType` | ✅ | `pc` | 客户端标识。前端 PC 端固定传 `pc` |

**可省略项实测**：`pn` 省略 → 等同 `pn=0`；`rn` 省略 → 默认 10 条。但**不建议省略**，显式传参更可控。

### 2.2 必要 Header

| Header | 必需 | 实测值 | 说明 |
|---|---|---|---|
| `acs-token` | ✅ **强必需** | `1789128006009_1789197997774_IFeZr44k…`（约 400 字符） | 百度 ACS 风控签名，**服务端校验**。不带或伪造 → 403 `hit risk`。见 §6 |
| `Cookie` | ✅ | `BAIDUID=…; BIDUPSID=…; …` | 至少需要 `BAIDUID`（`acs-token` 与 Cookie 中的设备标识绑定）。见 §6 |
| `accept` | ✅ | `application/vnd.finance-web.v1+json` | 服务端按此协商版本；缺失/改写会触发风控 |
| `referer` | ✅ | `https://finance.baidu.com/` | 站点校验 |
| `origin` | ✅ | `https://finance.baidu.com` | 跨域校验 |
| `user-agent` | ✅ | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/152.0.0.0 Safari/537.36` | 需为常见浏览器 UA |
| `accept-language` | ⭕ 建议 | `zh-CN,zh;q=0.9` | 跟随浏览器 |
| `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` / `sec-fetch-*` / `priority` | ⭕ 可选 | 见原 curl | 属浏览器自动头，**实测非必需**，缺失不影响 |

> ⚠️ 以上「必需」是**整体风险控制**的表现：实测不带 `acs-token`、不带 Cookie、改 `accept`、去掉 `referer`/`origin`/`user-agent` **全部返回 403**。因此这不是「参数校验」，而是百度 ACS 的统一拦截，无法通过补参数绕过。

### 2.3 可直接复现的 curl（占位符形式）

凭据是**会话级临时值**，请运行时注入，切勿硬编码入库：

```bash
curl -sS --compressed \
  --url 'https://finance.pae.baidu.com/vapi/v2/blocks?style=heatmap&market=ab&typeCode=HY&sortKey=amount&sortType=desc&pn=0&rn=100&finClientType=pc' \
  -H "accept: application/vnd.finance-web.v1+json" \
  -H "accept-language: zh-CN,zh;q=0.9" \
  -H "acs-token: $BAIDU_ACS_TOKEN" \
  -b "$BAIDU_COOKIE" \
  -H "origin: https://finance.baidu.com" \
  -H "referer: https://finance.baidu.com/" \
  -H "user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
```

PowerShell（`Invoke-RestMethod`）等价写法：

```powershell
$headers = @{
  accept           = 'application/vnd.finance-web.v1+json'
  'accept-language'= 'zh-CN,zh;q=0.9'
  'acs-token'      = $env:BAIDU_ACS_TOKEN
  cookie           = $env:BAIDU_COOKIE
  origin           = 'https://finance.baidu.com'
  referer          = 'https://finance.baidu.com/'
  'user-agent'     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
}
$uri = 'https://finance.pae.baidu.com/vapi/v2/blocks?style=heatmap&market=ab&typeCode=HY&sortKey=amount&sortType=desc&pn=0&rn=100&finClientType=pc'
(Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 15).Result.list.body
```

---

## 3. 响应结构

### 3.1 外层信封

```json
{
  "ResultCode": 0,
  "ResultNum": 0,
  "QueryID": "6031299151271127512",
  "Result": {
    "list": {
      "body": [ /* 板块数组，长度 = rn */ ]
    }
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `ResultCode` | number | `0` = 成功。**注意是数字 0**，不是字符串 |
| `ResultNum` | number | 实测恒为 `0` |
| `QueryID` | string | 请求追踪 ID，用于排查 |
| `Result.list.body` | array | 板块数组。**没有 `total` 字段**，全量条数需靠 `rn` 试探或分页直到空页 |

### 3.2 板块记录（实测首条原文）

```json
{
  "amount": "2093亿",
  "code": "270100",
  "financeType": "block",
  "lastPx": "13434.05",
  "logo": { "type": "img", "logo": "https://baidu-finance.cdn.bcebos.com/imgs/logo/block/半导体_47896.png" },
  "market": "ab",
  "marketValue": "14.30万亿",
  "name": "半导体",
  "pxChange": "-277.92",
  "pxChangeRate": "-2.03%",
  "rawData": {
    "amount": 209260095000,
    "lastPx": 13434.05,
    "marketValue": 14297712060272,
    "pxChange": -277.92,
    "pxChangeRate": -2.03,
    "volume": 26408623.43
  },
  "volume": "2641万手"
}
```

100 条记录**字段覆盖率 100%**，无缺字段；`market` 恒为 `ab`，`financeType` 恒为 `block`，`code` 恒为 6 位字符串。

### 3.3 Treemap 字段映射（已实测校验）

| 需求 | 取值路径 | 单位 | 实测校验 |
|---|---|---|---|
| **板块名称** | `name` | — | `半导体` |
| **涨跌幅（颜色）** | **`rawData.pxChangeRate`** | 百分数（`-2.03` = -2.03%） | 与展示串 `pxChangeRate`（`"-2.03%"`）**100/100 条一致** |
| **成交额权重（面积）** | **`rawData.amount`** | **元** | `209260095000` = 2092.60 亿；格式化串 `"2093亿"` 为四舍五入 |
| 成交量（辅助） | `rawData.volume` | **手** | `26408623.43` / 1e4 = 2640.86 万手，与串 `"2641万手"` 吻合 |
| 总市值（辅助） | `rawData.marketValue` | 元 | `14297712060272` = 14.30 万亿，与串 `"14.30万亿"` 吻合 |
| 板块点位 | `rawData.lastPx` | 点 | `13434.05` |
| 板块代码 | `code` | — | `270100`，可用于跳转 `https://finance.baidu.com/block/ab-{code}` |
| 涨跌额 | `rawData.pxChange` | 点 | `-277.92` |
| 板块图标 | `logo.logo` | URL | 百度 CDN PNG |

**关键结论：一律使用 `rawData.*` 数值字段，不要解析 `amount`/`volume`/`marketValue` 这类中文格式化串。** 后者已做四舍五入（2092.60 亿 → `"2093亿"`），会带来精度损失。

### 3.4 排序行为

`sortKey=amount&sortType=desc` 实测：`rawData.amount` 在本页 100 条内**严格降序**（无相等、无逆序）。

### 3.5 数据校验锚点（实测）

- 本页 100 个板块 `rawData.amount` 合计 = **1.93 万亿元**（A 股单日成交额量级吻合）。
- 首条 `半导体` 2092.60 亿元，与东方财富同板块口径处于同一量级。

### 3.6 ⚠️ 响应缺失 `行情时间戳`

对整个响应体做全文检索，`time`/`date`/`update`/`timestamp`/`tradeTime`/`marketTime` **命中数均为 0**。

因此：

- 本接口**无法给出行情时间**，无法满足 MVP「图片上标注行情时间」的要求。
- 兜底方案（择一）：
  1. 用**请求时刻**标注为「采集时间」，并明确区别于行情时间；
  2. 从 `/vapi/v1/blocks/overview?hasTrend=1&market=ab` 的 `minuteData.priceinfo[].time`（Unix 秒）取真实行情时间——该接口实测**无需 `acs-token` 即可 200**（见 §5）。

---

## 4. 建议的领域模型与校验（zod）

```ts
import { z } from 'zod';

const BlockRawData = z.object({
  amount: z.number().nonnegative(),        // 元
  lastPx: z.number(),
  marketValue: z.number().nonnegative(),   // 元
  pxChange: z.number(),
  pxChangeRate: z.number(),                // 百分数，-2.03 = -2.03%
  volume: z.number().nonnegative(),        // 手
});

const BlockRecord = z.object({
  code: z.string().length(6),
  name: z.string().min(1),
  market: z.literal('ab'),
  financeType: z.literal('block'),
  amount: z.string(),
  lastPx: z.string(),
  marketValue: z.string(),
  pxChange: z.string(),
  pxChangeRate: z.string(),
  volume: z.string(),
  logo: z.object({ type: z.string(), logo: z.string().url() }).partial().optional(),
  rawData: BlockRawData,
});

export const BlocksResponse = z.object({
  ResultCode: z.number(),                  // 0 = 成功（数字，非字符串）
  QueryID: z.string().optional(),
  Result: z.object({ list: z.object({ body: z.array(BlockRecord) }) }),
});

/** 转换为渲染层统一模型 */
export interface SectorNode {
  code: string;
  name: string;
  /** 面积权重：成交额，单位「元」 */
  weight: number;
  /** 颜色：涨跌幅，单位 % */
  changePct: number;
}
export const toSectorNodes = (body: z.infer<typeof BlockRecord>[]): SectorNode[] =>
  body.map((b) => ({ code: b.code, name: b.name, weight: b.rawData.amount, changePct: b.rawData.pxChangeRate }));
```

---

## 5. 关联接口（同域，实测/推论）

| 接口 | 用途 | 关键参数 | 实测状态 |
|---|---|---|---|
| `GET /vapi/v1/blocks/overview` | 板块总览 + 分时走势，含**真实行情时间戳** | `hasTrend=1&market=ab` | ✅ **200，且无需 `acs-token`**（已实测回到 200 并拿到完整数据） |
| `GET /vapi/v2/blocks` | **本文件主接口**：板块列表（热力图数据源） | 见 §2.1 | ⚠️ 需要 `acs-token`，且已触发风控 |
| `GET /vapi/v3/blocks` | 主力净流入板块列表 | `market`、`type_code`、`pn`、`rn`；固定 `sort_key=exmainIn&sort_type=down` | 未实测（前端 `tradeOwnerIncome` 调用） |
| `GET /vapi/v1/ranks` | 个股排行（首页个股热力图 `heat-treemap-home`） | 见前端 `v1/ranks` | 未实测 |

> 注意 `/vapi/v3/blocks` 用的是 **snake_case**（`type_code`/`sort_key`/`sort_type`），与 v2 的 camelCase 不同，接入时不要混用。

---

## 6. 风险与运维代价（★★★ 接入前必须评估）

### 6.1 `acs-token` 无法在服务端简单复现

前端源码实证（`index.14c6dceb.js`）：

```js
// 每个请求前取一次签名，失败返回 600，且 600 不写入 header
function p(e){const t=window.paris_2108;return t?new Promise((e=>{
  t.getAcsInstance(((t,n)=>{t?e(t.code||600):n.getSign(((t,n)=>{e(t?t.code||600:n)}))}))})):Promise.resolve(600)}
// axios 请求拦截器
interceptors.request.use(async e=>{const t=await p(); /^\d+$/.test(t)||(e.headers["Acs-Token"]=t); ...})
```

- 签名由百度 ACS SDK 在**浏览器环境内**生成，SDK 由 `ParisFactory.create()` 动态加载：
  - 主源：`https://dlswbr.baidu.com/heicha/mm/2108/acs-2108.js`（实测 200，84 KB）
  - 容灾：`https://miaowu.baidu.com/sdk/heicha/mm/2108/acs-2108.js`
  - 伴随 `abclite`：`https://dlswbr.baidu.com/heicha/mw/abclite-2108-s.js`
- `acs-2108.js` 为**重度混淆**代码（关键标识符全部改名，无 `getSign`/`navigator`/`canvas` 等明文），依赖浏览器 DOM / 定时器 / 存储等能力；**无法在 Node 里直接 require 调用**。
- `acs-token` 实测形如 `1789128006009_1789197997774_<base64>`，前两段是 13 位毫秒时间戳：
  - `1789128006009` → 2026-09-11 20:00:06 CST
  - `1789197997774` → 2026-09-12 15:26:37 CST
  - 两段相差约 19.4 小时，**高度疑似「签发时间_失效时间」**，即 token 生命周期不足一天。此推断未做失效点验证。
- 已公开的第三方逆向分析（百度翻译 / 某度 Acs-Token、`ab_sr` 逆向）表明该算法可被还原，但属于**持续对抗**性质：百度随时可改混淆与算法，维护成本不可控。参考：[某度 Acs-Token、ab_sr 逆向分析](https://cloud.tencent.cn/developer/article/2606384)、[百度翻译 Acs-Token 生成算法解析](https://blog.csdn.net/m0_37890059/article/details/157509578)、[fanyi.baidu.com 页面扫描（可见 acs 相关脚本加载）](https://urlscan.io/result/019b7352-c34a-716b-bc44-89d18de7924b)。

**可选获取方式（按可行性排序）：**

1. **人工/半自动注入**：运维人员在浏览器登录百度股市通，从 DevTools 复制 `acs-token` 与 Cookie 写入环境变量；`403 hit risk` 时告警并提示更换。**MVP 阶段最省事，但不可长期无人值守。**
2. **无头浏览器**：Playwright/Puppeteer 打开 `https://finance.baidu.com/`，等 `window.paris_2108` 就绪后调用 `getAcsInstance → getSign` 取签名，并导出 Cookie。可自动化，代价是常驻内存 + 浏览器依赖，且仍受风控与验证码约束（响应里带 `isCaptchaEnabled: true`）。
3. **自行实现签名算法**：可行但脆弱，不建议作为 MVP 方案。

### 6.2 风控：突发请求会被封（实测）

| 实验 | 请求数 | 结果 |
|---|---|---|
| 第 1 次（基线） | 1 | ✅ 200，100 条，848 ms |
| 分页/参数枚举（约 1 分钟内连发） | 第 2–14 次 | ✅ 200（`rn=10/200/1000`、`pn=0/1/2`、省略 `pn`/`rn` 均正常） |
| 同一会话继续连发 | 第 15 次起 | ❌ **403**，此后**全部** 403 |

403 响应体（**HTTP 403 + 业务码**，注意 `ResultCode` 仍是 `0`，不要只看它）：

```json
{"QueryID":"5569724773836573166","Result":{"code":403,"isCaptchaEnabled":true,"msg":"hit risk"},"ResultCode":0}
```

- 触发后冷却时间**至少 13 分钟**（实测在 0/2/5/10/15/30/60/180 s 以及约 13 分钟后共 4 轮重试，全部 `hit risk`）。
- **未能观察到自动恢复**，因此无法断定是「时间窗冷却」还是「该会话永久失效」；保守按后者设计。
- 前后对照证明：**不是参数错误、不是增量风控**——同一 URL、同一 Header，仅因请求频率从 200 变 403。
- 连发规模仅约 **10–14 次/分钟** 即触发，说明限制相当严格。

**结论：单次会话内务必低频，并把 `hit risk` 当作会话级失效处理（告警 + 换凭据），而不是可重试的临时错误。** MVP 的采集策略建议：**一次 `rn=200` 取全 131 个板块**（1 请求 / N 分钟），配合进程内缓存，绝不重试风暴。

### 6.3 无 `total`、无时间戳

见 §3.1、§3.6：需自行判定全量完成条件与行情时间。

### 6.4 凭据泄露风险

`acs-token` 与 `BAIDUID` Cookie **等价于该浏览器会话的身份**，必须放 Railway Variables / 本地 `.env`（仓库已忽略），**严禁写进文档、日志、提交历史或错误信息**。本文档中的所有凭据示例均已脱敏。

---

## 7. 未验证事项（后续需在可用会话下补测）

1. `typeCode` 的完整取值域：`HY2`（二级行业）/`GN`（概念）/`DY`（地域）/`ZS`（指数）**均未验证成功**——枚举到这些值时已进入 403 风控，属「未验证」而非「不可用」。
2. `sortType=asc` 是否真正反转顺序；`sortKey` 各取值是否全部生效（同样被风控打断）。
3. `market` 其他取值是否真的不支持（当前证据：均 403，但在风控窗口内测出，**需在干净会话中复核**）。
4. `acs-token` 的精确失效时间点与续签方式。
5. 交易时段（9:30–15:00）的实时性：本次为周六盘后快照，**未能确认是否为实时行情**。
6. 是否存在更宽松的替代域名/路径（如 `wap`/`app` 版 `finClientType`）。

---

## 8. 实测证据

| 编号 | 命令 | 观察 |
|---|---|---|
| E1 | 原 curl 参数，Node `fetch` | `200`，`ResultCode=0`，100 条，848 ms，`Result.list.body` 为数组 |
| E2 | `pn=0/1/2` 各 `rn=100` | 各 100 条，相邻页首条恒定重叠 1 条 → `offset = pn × rn` |
| E3 | `rn=10` / `rn=200` / `rn=1000` | 10 条 / 131 条 / 131 条 → 该分类全量 131，`rn` 上限 ≥131 且有效 |
| E4 | 省略 `pn` / 省略 `rn` | 等同 `pn=0` / 默认 10 条 |
| E5 | 逐条改 `market`、`typeCode`、`sortKey`、`style`、`finClientType` | 前 14 次 200，第 15 次起全部 403 → 已进入风控，该组枚举**结论不可用** |
| E6 | 403 后 0/2/5/10/15/30/60/180 s 重试，及约 13 分钟后复测 | 全部 `403 hit risk` → **冷却 ≥13 分钟且未观察到自动恢复** |
| E7 | `GET /vapi/v1/blocks/overview?hasTrend=1&market=ab`（无 `acs-token`） | `200`，含 `minuteData.priceinfo[].time` 真实时间戳与 `riseCount`/`memberCount` |
| E8 | 字段一致性校验（100 条） | `rawData.pxChangeRate` 与 `×.pxChangeRate` 字符串 100/100 一致；`amount` 严格降序；字段覆盖率 100% |
| E9 | 响应全文检索时间字段 | `time`/`date`/`timestamp` 等命中 0 → **无行情时间** |
| E10 | 前端 bundle 静态分析 | 确认 `acs-token` 来自 `window.paris_2108.getSign()`；`acsUrl = https://dlswbr.baidu.com/heicha/mm/2108/acs-2108.js`；`acs-2108.js` 实测 200 / 84 KB / 重度混淆 |

---

## 9. 对 MVP 的结论

**该接口可作为「辅助/备选」数据源，不建议作为 A 股行业板块的唯一来源。**

- 优势：一次请求即可拿到全部 131 个板块的成交额 + 涨跌幅，字段自带数值型 `rawData`，非常适合 Treemap。
- 劣势：**强制 `acs-token`（不可服务端复现）+ 严格风控（约 10 次/分钟即封）**，在 Railway 无人值守场景下需要额外的 token 供给与告警机制。
- 建议：MVP 的 A 股主源仍走东方财富 `push2delay`（无需任何凭据）；本接口用于**交叉校验**或**在拿到稳定 token 供给后升级为主源**，两条路径都由统一的 `market/` 数据源接口屏蔽差异。

# Demo 目录

| Demo | 功能 | 状态 |
| --- | --- | --- |
| [baidu-finance-market-screenshot.mjs](./baidu-finance-market-screenshot.mjs) | 百度财经 A 股、美股行情截图 | 生产和手工运行共用 |

## 百度财经行情截图

脚本请求百度财经首页和热力图页面，依次输出 7 张图片：

1. `baidu-finance-market.png`：A 股涨跌分布；
2. `baidu-finance-hot-blocks-industry.png`：A 股热门板块行业，包含最新异动；
3. `baidu-finance-hot-blocks-concept.png`：A 股热门板块概念，包含最新异动；
4. `baidu-finance-heatmap-industry.png`：行业板块热力图，约 `1740x756`；
5. `baidu-finance-heatmap-concept.png`：概念板块热力图，约 `1740x756`；
6. `baidu-finance-main-inflow-industry.png`：A 股主力净流入行业；
7. `baidu-finance-main-inflow-concept.png`：A 股主力净流入概念。

每张图四周保留白边。热门板块使用宽视口保证 6 张卡片完整显示；热力图保持原网页横向矩形布局。

从项目根目录运行：

```powershell
node demo/baidu-finance-market-screenshot.mjs
node demo/baidu-finance-market-screenshot.mjs ./tmp/baidu-finance-market.png
```

脚本使用 `PLAYWRIGHT_EXECUTABLE_PATH` 指定浏览器时优先使用该路径；未指定时在 Windows 上自动查找 Chrome/Edge，在 Linux/Docker 中使用 Playwright Chromium。页面地址也可以通过 `BAIDU_FINANCE_URL` 和 `BAIDU_FINANCE_HEATMAP_URL` 覆盖。

## 百度财经美股行情截图

使用 `--market us` 请求 `https://finance.baidu.com/?quotationMarket=us`，依次输出 4 张图片：

1. `baidu-finance-us-market.png`：美股涨跌分布；
2. `baidu-finance-us-heatmap.png`：美股板块热力图；
3. `baidu-finance-us-main-inflow.png`：美股主力净流入；
4. `baidu-finance-us-hot-blocks.png`：美股热门板块。

从项目根目录运行：

```powershell
node demo/baidu-finance-market-screenshot.mjs --market us
node demo/baidu-finance-market-screenshot.mjs ./tmp/baidu-finance-us-market.png --market us
```

美股页面地址可以通过 `BAIDU_FINANCE_US_URL` 覆盖，板块热力图页面地址可以通过 `BAIDU_FINANCE_US_HEATMAP_URL` 覆盖。

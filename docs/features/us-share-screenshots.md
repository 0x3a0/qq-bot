# 美股行情截图

## 指令

群聊中明确 `@bot 美股` 后，Bot 请求百度财经美股页面 `https://finance.baidu.com/?quotationMarket=us`，并单独请求美股板块热力图页面 `https://finance.baidu.com/heat-treemap/home/us?tab=HY&value=amount&financeType=block`，按照截图脚本的固定顺序生成 4 张图片，然后依次发送到当前群聊。

## 图片顺序

1. 美股涨跌分布
2. 美股板块热力图
3. 美股主力净流入
4. 美股热门板块

图片均由 `demo/baidu-finance-market-screenshot.mjs` 直接请求百度财经后截图。美股页面使用 `--market us` 选择，板块热力图页面会显式切换到“板块”和“行业板块”，Bot 不拼接 HTML、不生成模拟行情，也不保存旧数据作为失败回退。

## 运行要求

- 运行环境需要 Node.js 24 和 Playwright Chromium；Windows 本机已有 Chrome/Edge 时脚本会自动查找。
- 百度财经美股页面必须能够从 Bot 运行环境访问。
- 页面地址可通过 `BAIDU_FINANCE_US_URL` 覆盖，默认地址为 `https://finance.baidu.com/?quotationMarket=us`。
- 板块热力图地址可通过 `BAIDU_FINANCE_US_HEATMAP_URL` 覆盖，默认地址为 `https://finance.baidu.com/heat-treemap/home/us?tab=HY&value=amount&financeType=block`。
- 截图期间生成的 PNG 保存在临时目录，图片发送完成后立即删除。

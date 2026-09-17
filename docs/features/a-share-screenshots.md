# A 股行情截图

## 指令

群聊中明确 `@bot a股` 后，Bot 请求百度财经页面并按照截图脚本的固定顺序生成图片，然后依次发送到当前群聊。

旧的 `@bot 板块涨跌` 指令、同花顺板块数据 Provider 和本地 HTML/CSS 行情卡片渲染已经移除。

## 图片顺序

1. A 股涨跌分布
2. A 股热门板块：行业板块，包含最新异动
3. A 股热门板块：概念板块，包含最新异动
4. 热力图：行业板块
5. 热力图：概念板块
6. A 股主力净流入：行业
7. A 股主力净流入：概念

图片均由 `demo/baidu-finance-market-screenshot.mjs` 直接请求百度财经后截图。Bot 不拼接 HTML、不生成模拟行情，也不保存旧数据作为失败回退。

## 运行要求

- 运行环境需要 Node.js 24 和 Playwright Chromium；Windows 本机已有 Chrome/Edge 时脚本会自动查找。
- 百度财经页面必须能够从 Bot 运行环境访问。
- OneBot 正向 WebSocket 地址通过 `ONEBOT_WS_URL` 配置。
- 截图期间生成的 PNG 保存在临时目录，图片发送完成后立即删除。

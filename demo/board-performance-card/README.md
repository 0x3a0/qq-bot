# 板块涨跌速览卡片 Demo

实际开发以 [metric-demo.html](./metric-demo.html) 为唯一新版设计基准，要求见 [功能文档](../../docs/features/board-performance.md)。

## 新版文件

- `render-metric-demo.mjs`：HTML 生成器与示例数据。
- `metric-demo.css`：白底圆角指标卡、红涨绿跌、灰色平盘及响应式布局。
- `metric-demo.html`：生成的设计预览，明确标注为示例数据。
- `metric-demo.png`：设计截图。

项目根目录执行 `node demo/board-performance-card/render-metric-demo.mjs` 重新生成预览。

卡片显示板块名称、大号涨跌幅、股票名称与浅色涨跌标签。股票名前不显示“领涨／领跌”。不展示走势图；正式接入时应取消走势请求。

正式行情 Provider 将在同花顺接口契约确认后接入 `src/market`；渲染器直接使用本目录的 `metric-demo.css` 作为样式基准。是否需要目录、快照和成分股请求取决于确认后的接口契约，但不请求分时走势。

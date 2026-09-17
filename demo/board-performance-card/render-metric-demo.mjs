import { writeFile } from "node:fs/promises";

// Design-only fixture: these values are examples, not a live market response.
const boards = [
  ["林业Ⅱ", 5.97, "平潭发展", 9.97],
  ["半导体", 4.82, "中晶科技", 10.01],
  ["电子化学品Ⅱ", 4.06, "西陇科学", 10.02],
  ["其他电子Ⅱ", 3.96, "盈方微", 9.94],
  ["贵金属", 3.83, "盛达资源", 6.88],
  ["光学光电子", 3.45, "实益达", 10.07],
  ["商用车", -1.72, "安凯客车", -7.75],
  ["养殖业", -1.47, "天康生物", -4.51],
  ["焦炭Ⅱ", -1.20, "云煤能源", -8.32],
  ["乘用车", -0.97, "海马汽车", -3.12],
  ["航海装备Ⅱ", -0.95, "松发股份", -5.03],
  ["白色家电", -0.89, "TCL智家", -4.21]
];
const percent = (value) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const direction = (value) => value > 0 ? "up" : value < 0 ? "down" : "flat";
const tiles = boards.map(([name, change, stock, stockChange]) => `
  <li class="metric-card">
    <h2>${name}</h2>
    <div class="metric-value ${direction(change)}">${percent(change)}</div>
    <div class="stock-row">
      <span class="stock-name">${stock}</span>
      <span class="badge ${direction(stockChange)}">${percent(stockChange)} <span aria-hidden="true">${stockChange > 0 ? "↗" : stockChange < 0 ? "↘" : "—"}</span></span>
    </div>
  </li>`).join("");
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>板块涨跌 · 指标卡片设计 Demo</title><link rel="stylesheet" href="./metric-demo.css"></head>
<body><main>
  <header><div><p class="eyebrow">市场速览 / MARKET OVERVIEW</p><h1>行业板块涨跌<span>09-16</span></h1><p class="subtitle">今日涨幅 Top 6 · 今日跌幅 Top 6</p></div><span class="demo-label">布局示例</span></header>
  <ol>${tiles}</ol>
  <footer><span>示例数据 · 非实时行情</span><span>仅供参考</span></footer>
</main></body></html>`;
await writeFile(new URL("./metric-demo.html", import.meta.url), html);
console.log("Generated metric-demo.html");

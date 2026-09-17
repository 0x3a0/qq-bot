import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import {
  BOARD_PERFORMANCE_TOP_COUNT,
  type BoardPerformanceData,
  type BoardPerformanceSector,
  type BoardPerformanceSnapshot
} from "../market/types.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stylesPath = resolve(projectRoot, "demo/board-performance-card/metric-demo.css");
const cardViewport = { width: 1160, height: 1200 };

type PercentageDirection = "up" | "down" | "flat";
let browserPromise: Promise<Browser> | undefined;

export async function warmBoardPerformanceCardRenderer(): Promise<void> {
  await getBrowser();
}

export async function closeBoardPerformanceCardRenderer(): Promise<void> {
  const activeBrowserPromise = browserPromise;
  browserPromise = undefined;
  if (activeBrowserPromise) await (await activeBrowserPromise).close();
}

export async function renderBoardPerformanceCards(data: BoardPerformanceData, outputDirectory: string): Promise<string[]> {
  validateData(data);
  await mkdir(outputDirectory, { recursive: true });
  const styles = await readFile(stylesPath, "utf8");
  const browser = await getBrowser();
  return [await renderBoardPerformanceOverview(
    browser,
    styles,
    data,
    join(outputDirectory, "board-performance.png")
  )];
}

async function renderBoardPerformanceOverview(
  browser: Browser,
  styles: string,
  data: BoardPerformanceData,
  outputPath: string
): Promise<string> {
  const page = await browser.newPage({ viewport: cardViewport, deviceScaleFactor: 2 });
  try {
    await page.setContent(createBoardPerformanceOverviewHtml(styles, data), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.locator("main").screenshot({ path: outputPath, type: "png" });
    return outputPath;
  } finally {
    await page.close();
  }
}

export function createBoardPerformanceOverviewHtml(styles: string, data: BoardPerformanceData): string {
  validateData(data);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>行业与概念板块涨跌速览</title><style>${styles}${compactRankingStyles}</style></head>
<body><main>
  <header class="board-overview-header"><div><p class="eyebrow">市场速览 / MARKET OVERVIEW</p><h1>行业与概念板块涨跌<span>${formatSnapshotDates(data)}</span></h1><p class="subtitle">行业、概念各显示涨幅 Top ${BOARD_PERFORMANCE_TOP_COUNT} · 跌幅 Top ${BOARD_PERFORMANCE_TOP_COUNT}</p></div></header>
  <div class="board-performance-categories">
    ${renderCategorySection(data.industry)}
    ${renderCategorySection(data.concept)}
  </div>
  <footer><span>数据来源：同花顺 · 仅供参考</span></footer>
</main></body></html>`;
}

export function createBoardPerformanceCardHtml(styles: string, snapshot: BoardPerformanceSnapshot): string {
  validateSnapshot(snapshot);
  const categoryLabel = snapshot.category === "industry" ? "行业板块" : "概念板块";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${categoryLabel}涨跌速览</title><style>${styles}${compactRankingStyles}</style></head>
<body><main>
  <header><div><p class="eyebrow">市场速览 / MARKET OVERVIEW</p><h1>${categoryLabel}涨跌<span>${formatDate(snapshot.fetchedAt)}</span></h1><p class="subtitle">今日涨幅 Top ${BOARD_PERFORMANCE_TOP_COUNT} · 今日跌幅 Top ${BOARD_PERFORMANCE_TOP_COUNT} · 更新 ${formatTime(snapshot.fetchedAt)}</p></div></header>
  <div class="board-rankings">
    ${renderRankingColumn("gain", "涨幅榜", snapshot.rankings.gain)}
    ${renderRankingColumn("loss", "跌幅榜", snapshot.rankings.loss)}
  </div>
  <footer><span>数据来源：同花顺 · 仅供参考</span></footer>
</main></body></html>`;
}

function renderCategorySection(snapshot: BoardPerformanceSnapshot): string {
  const categoryLabel = snapshot.category === "industry" ? "行业板块" : "概念板块";
  const categoryId = `${snapshot.category}-category-title`;
  return `<section class="board-performance-category" aria-labelledby="${categoryId}">
    <div class="board-category-heading"><h2 id="${categoryId}">${categoryLabel}</h2><span>涨幅、跌幅各 Top ${BOARD_PERFORMANCE_TOP_COUNT} · 更新 ${formatTime(snapshot.fetchedAt)}</span></div>
    <div class="board-rankings">
      ${renderRankingColumn("gain", "涨幅榜", snapshot.rankings.gain, snapshot.category)}
      ${renderRankingColumn("loss", "跌幅榜", snapshot.rankings.loss, snapshot.category)}
    </div>
  </section>`;
}

function renderRankingColumn(
  direction: "gain" | "loss",
  label: string,
  boards: BoardPerformanceSector[],
  category?: BoardPerformanceSnapshot["category"]
): string {
  const rankingId = `${category ? `${category}-` : ""}${direction}-ranking-title`;
  const categoryLabel = category === "industry" ? "行业" : category === "concept" ? "概念" : "";
  return `<section class="board-ranking ${direction}" aria-labelledby="${rankingId}">
    <div class="board-ranking-heading"><h2 id="${rankingId}">${label}</h2><span>Top ${BOARD_PERFORMANCE_TOP_COUNT}</span></div>
    <ol class="board-ranking-list" aria-label="${categoryLabel}${label}板块排行">${boards.map((board) => renderBoardTile(board)).join("")}</ol>
  </section>`;
}

function renderBoardTile(board: BoardPerformanceSector): string {
  return `<li class="metric-card">
    <h2>${escapeHtml(board.name)}</h2>
    <div class="metric-value ${valueClass(board.changePercent)}">${formatPercent(board.changePercent)}</div>
    <div class="stock-row">
      <span class="stock-name">${escapeHtml(board.leader)}</span>
      <span class="badge ${valueClass(board.leaderChangePercent)}">${formatPercent(board.leaderChangePercent)} <span aria-hidden="true">${trendArrow(board.leaderChangePercent)}</span></span>
    </div>
  </li>`;
}

function formatPercent(value: number): string {
  return value > 0 ? `+${value.toFixed(2)}%` : `${value.toFixed(2)}%`;
}

function valueClass(value: number): PercentageDirection {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

function trendArrow(value: number): string {
  if (value > 0) return "↗";
  if (value < 0) return "↘";
  return "—";
}

function formatDate(date: Date): string {
  return formatDateParts(date, { month: "2-digit", day: "2-digit" }).join("-");
}

function formatTime(date: Date): string {
  return formatDateParts(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).join(":");
}

function formatSnapshotDates(data: BoardPerformanceData): string {
  return [...new Set([formatDate(data.industry.fetchedAt), formatDate(data.concept.fetchedAt)])].join(" / ");
}

function formatDateParts(date: Date, options: Intl.DateTimeFormatOptions): string[] {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ...options })
    .formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => part.value);
}

function validateData(data: BoardPerformanceData): void {
  if (data.industry.category !== "industry" || data.concept.category !== "concept") {
    throw new Error("Invalid board performance category data");
  }
  validateSnapshot(data.industry);
  validateSnapshot(data.concept);
}

function validateSnapshot(snapshot: BoardPerformanceSnapshot): void {
  if (!(snapshot.fetchedAt instanceof Date) || Number.isNaN(snapshot.fetchedAt.getTime())) {
    throw new Error("Invalid board performance fetch time");
  }
  validateRanking(snapshot.rankings.gain, "gain");
  validateRanking(snapshot.rankings.loss, "loss");
}

function validateRanking(boards: BoardPerformanceSector[], direction: "gain" | "loss"): void {
  if (!Array.isArray(boards) || boards.length !== BOARD_PERFORMANCE_TOP_COUNT) {
    throw new Error(`Board performance ${direction} ranking must contain ${BOARD_PERFORMANCE_TOP_COUNT} sectors`);
  }
  boards.forEach((board, index) => validateBoard(board, `${direction} ranking item ${index + 1}`));
}

function validateBoard(board: BoardPerformanceSector, label: string): void {
  if (!isNonEmptyString(board.name) || !isNonEmptyString(board.leader)) {
    throw new Error(`Invalid ${label} identity`);
  }
  if (!Number.isFinite(board.changePercent) || !Number.isFinite(board.leaderChangePercent)) {
    throw new Error(`Invalid ${label} percentage`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const compactRankingStyles = `
h1, .metric-value { letter-spacing: 0; }
.board-overview-header { margin-bottom: 28px; }
.board-performance-categories { display: grid; gap: 30px; }
.board-performance-category { border-top: 1px solid #e6e9ee; padding-top: 26px; }
.board-performance-category:first-child { border-top: 0; padding-top: 0; }
.board-category-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 0 0 12px; padding: 0 2px; }
.board-category-heading h2 { margin: 0; color: #252c37; font-size: 20px; font-weight: 650; }
.board-category-heading span { color: #89919e; font-size: 12px; white-space: nowrap; }
.board-rankings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; }
.board-ranking { min-width: 0; }
.board-ranking-heading { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 10px; padding: 0 2px; }
.board-ranking-heading h2 { margin: 0; font-size: 16px; font-weight: 650; color: #252c37; }
.board-ranking-heading span { color: #89919e; font-size: 11px; }
.board-ranking-list { display: grid; grid-template-columns: 1fr; gap: 10px; padding: 0; margin: 0; list-style: none; }
.board-ranking-list .metric-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto auto; column-gap: 10px; row-gap: 5px; border-radius: 8px; padding: 13px 14px 12px; }
.board-ranking-list .metric-card h2 { grid-column: 1; grid-row: 1; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.board-ranking-list .metric-card .metric-value { grid-column: 1; grid-row: 2; margin: 0; font-size: 25px; line-height: 1; }
.board-ranking-list .metric-card .stock-row { grid-column: 2; grid-row: 1 / span 2; min-width: 0; flex-direction: column; align-items: flex-end; justify-content: center; gap: 4px; }
.board-ranking-list .metric-card .stock-name { max-width: 145px; overflow: hidden; text-overflow: ellipsis; }
@media(max-width: 700px) { .board-category-heading { align-items: flex-start; flex-direction: column; gap: 4px; } .board-rankings { grid-template-columns: 1fr; } }
`;

function findLocalBrowser(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? findLocalBrowser();
    browserPromise = chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  }
  try {
    return await browserPromise;
  } catch (error) {
    browserPromise = undefined;
    throw error;
  }
}

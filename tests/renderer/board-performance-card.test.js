import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  closeBoardPerformanceCardRenderer,
  createBoardPerformanceCardHtml,
  createBoardPerformanceOverviewHtml,
  renderBoardPerformanceCards
} from "../../dist/renderer/board-performance-card.js";
import { BOARD_PERFORMANCE_TOP_COUNT } from "../../dist/market/types.js";

function createBoards(prefix, direction) {
  return Array.from({ length: BOARD_PERFORMANCE_TOP_COUNT }, (_, index) => ({
    code: `${prefix}-${index + 1}`,
    name: `${prefix}板块名称${index + 1}`,
    changePercent: direction === "gain"
      ? BOARD_PERFORMANCE_TOP_COUNT - index * 0.5
      : -BOARD_PERFORMANCE_TOP_COUNT + index * 0.5,
    leader: index === 0 ? `${prefix}<关联股票>` : `${prefix}关联股票${index + 1}`,
    leaderChangePercent: index === 0 ? 1.25 : index === 1 ? -0.75 : 0
  }));
}

function createBoardPerformanceData() {
  const fetchedAt = new Date("2026-09-16T01:02:03.000Z");
  return {
    industry: {
      category: "industry",
      fetchedAt,
      rankings: { gain: createBoards("行业涨幅", "gain"), loss: createBoards("行业跌幅", "loss") }
    },
    concept: {
      category: "concept",
      fetchedAt,
      rankings: { gain: createBoards("概念涨幅", "gain"), loss: createBoards("概念跌幅", "loss") }
    }
  };
}

function pngDimensions(image) {
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

test("renders one content-height 40-card board performance overview image", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-bot-board-performance-render-"));
  context.after(async () => {
    await closeBoardPerformanceCardRenderer();
    await rm(directory, { recursive: true, force: true });
  });
  const imagePaths = await renderBoardPerformanceCards(createBoardPerformanceData(), directory);

  assert.deepEqual(imagePaths.map((path) => basename(path)), ["board-performance.png"]);
  const image = await readFile(imagePaths[0]);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dimensions = pngDimensions(image);
  assert.equal(dimensions.width, 2320);
  assert.ok(dimensions.height > 1800 && dimensions.height < 5000);
});

test("renders industry and concept rankings in one overview without trends or related-stock prefixes", async () => {
  const styles = await readFile(new URL("../../demo/board-performance-card/metric-demo.css", import.meta.url), "utf8");
  const html = createBoardPerformanceOverviewHtml(styles, createBoardPerformanceData());

  assert.match(html, /行业与概念板块涨跌/);
  assert.match(html, new RegExp(`行业、概念各显示涨幅 Top ${BOARD_PERFORMANCE_TOP_COUNT} · 跌幅 Top ${BOARD_PERFORMANCE_TOP_COUNT}`));
  assert.match(html, /行业板块/);
  assert.match(html, /概念板块/);
  assert.equal((html.match(/class="metric-card"/g) ?? []).length, BOARD_PERFORMANCE_TOP_COUNT * 4);
  assert.equal((html.match(/class="metric-value up"/g) ?? []).length, BOARD_PERFORMANCE_TOP_COUNT * 2);
  assert.equal((html.match(/class="metric-value down"/g) ?? []).length, BOARD_PERFORMANCE_TOP_COUNT * 2);
  assert.match(html, /class="badge up">\+1\.25% <span aria-hidden="true">↗/);
  assert.match(html, /class="badge down">-0\.75% <span aria-hidden="true">↘/);
  assert.match(html, /class="badge flat">0\.00% <span aria-hidden="true">—/);
  assert.match(html, /行业涨幅&lt;关联股票&gt;/);
  assert.doesNotMatch(html, /<关联股票>/);
  assert.doesNotMatch(html, /领涨股|领跌股|tile-trend|trend-line/);
  assert.match(html, /数据来源：同花顺 · 仅供参考/);
  assert.doesNotMatch(html, /东方财富/);
  assert.ok(html.indexOf("行业涨幅板块名称1") < html.indexOf("行业跌幅板块名称1"));
  assert.ok(html.indexOf("行业跌幅板块名称1") < html.indexOf("概念涨幅板块名称1"));
});

test("keeps the individual category HTML export compatible", async () => {
  const styles = await readFile(new URL("../../demo/board-performance-card/metric-demo.css", import.meta.url), "utf8");
  const html = createBoardPerformanceCardHtml(styles, createBoardPerformanceData().industry);

  assert.match(html, /行业板块涨跌/);
  assert.match(html, /id="gain-ranking-title"/);
  assert.match(html, /aria-label="涨幅榜板块排行"/);
  assert.equal((html.match(/class="metric-card"/g) ?? []).length, BOARD_PERFORMANCE_TOP_COUNT * 2);
});

test("uses metric-demo responsive layout without a card minimum height", async () => {
  const styles = await readFile(new URL("../../demo/board-performance-card/metric-demo.css", import.meta.url), "utf8");
  const rules = [...styles.matchAll(/\.metric-card\s*\{([\s\S]*?)\}/gu)];

  assert.ok(rules.length > 0);
  assert.match(styles, /@media\(max-width: 900px\).*repeat\(3, minmax\(0, 1fr\)\)/su);
  assert.match(styles, /@media\(max-width: 700px\).*repeat\(2, minmax\(0, 1fr\)/su);
  assert.match(styles, /@media\(max-width: 370px\).*grid-template-columns: 1fr/su);
  for (const rule of rules) assert.doesNotMatch(rule[1], /\bmin-height\s*:/u);
});

test("rejects rankings that cannot produce the complete demo layout", () => {
  const data = createBoardPerformanceData();
  data.industry.rankings.gain.pop();

  assert.throws(
    () => createBoardPerformanceOverviewHtml("", data),
    new RegExp(`gain ranking must contain ${BOARD_PERFORMANCE_TOP_COUNT} sectors`)
  );
});

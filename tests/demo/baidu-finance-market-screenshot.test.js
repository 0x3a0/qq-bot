import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  getUnionClip,
  translateBoxToDocument,
  getPaddedClip,
  marketModuleTitles,
  hotBlocksViewport,
  heatmapModes,
  heatmapViewport,
  mainInflowModes,
  hotBlockModes,
  resolveModeOptionLabel,
  parseCaptureArguments,
  usMarketModuleTitles,
  usHeatmapMarketTab,
  usHeatmapBlockTab,
  usShareHeatmapPageUrl,
  usShareViewport
} from "../../demo/baidu-finance-market-screenshot.mjs";

test("targets the requested distribution and heatmap modes", () => {
  assert.deepEqual(marketModuleTitles, ["A股涨跌分布"]);
  assert.deepEqual(heatmapModes, [
    { key: "industry", tabLabel: "行业板块" },
    { key: "concept", tabLabel: "概念板块" }
  ]);
  assert.deepEqual(heatmapViewport, { width: 1756, height: 760 });
  assert.deepEqual(hotBlocksViewport, { width: 1800, height: 1600 });
  assert.deepEqual(hotBlockModes, [
    { key: "industry", tabLabel: "行业板块" },
    { key: "concept", tabLabel: "概念板块" }
  ]);
});

test("maps the concept screenshot to Baidu's current 概念 option", () => {
  assert.deepEqual(mainInflowModes.map((mode) => mode.key), ["industry", "concept"]);
  assert.equal(resolveModeOptionLabel(["行业", "概念", "地域"], mainInflowModes[0]), "行业");
  assert.equal(resolveModeOptionLabel(["行业", "概念", "地域"], mainInflowModes[1]), "概念");
});

test("targets the U.S. distribution and sector heatmap tabs", () => {
  assert.deepEqual(usMarketModuleTitles, ["美股涨跌分布"]);
  assert.equal(usHeatmapMarketTab, "板块");
  assert.equal(usHeatmapBlockTab, "行业板块");
  assert.equal(usShareHeatmapPageUrl, "https://finance.baidu.com/heat-treemap/home/us?tab=HY&value=amount&financeType=block");
  assert.deepEqual(usShareViewport, { width: 1800, height: 1600 });
});

test("parses the requested market before selecting its default output", () => {
  const demoDirectory = fileURLToPath(new URL("../../demo/", import.meta.url));
  assert.deepEqual(parseCaptureArguments(["--market", "us"]), {
    market: "us",
    outputPath: resolve(demoDirectory, "baidu-finance-us-market.png")
  });
  assert.deepEqual(parseCaptureArguments(["custom.png", "--market=a"]), {
    market: "a",
    outputPath: resolve("custom.png")
  });
  assert.throws(() => parseCaptureArguments(["--market", "jp"]), /must be either a or us/);
});

test("calculates one screenshot clip around both market modules", () => {
  assert.deepEqual(getUnionClip([
    { x: 32, y: 713, width: 656, height: 288 },
    { x: 752, y: 713, width: 656, height: 288 }
  ]), {
    x: 32,
    y: 713,
    width: 1376,
    height: 288
  });
});

test("rejects missing module bounds", () => {
  assert.throws(
    () => getUnionClip([{ x: 32, y: 713, width: 656, height: 288 }, null]),
    /module bounds are unavailable/
  );
});

test("translates viewport bounds to document coordinates after scrolling", () => {
  assert.deepEqual(translateBoxToDocument(
    { x: 32, y: 120, width: 656, height: 288 },
    { x: 4, y: 655 }
  ), {
    x: 36,
    y: 775,
    width: 656,
    height: 288
  });
});

test("adds white-space padding without exceeding the viewport", () => {
  assert.deepEqual(getPaddedClip(
    { x: 32, y: 713, width: 1376, height: 288 },
    24,
    { width: 1440, height: 1600 }
  ), {
    x: 8,
    y: 689,
    width: 1424,
    height: 336
  });

  assert.deepEqual(getPaddedClip(
    { x: 4, y: 8, width: 100, height: 80 },
    24,
    { width: 1440, height: 1600 }
  ), {
    x: 0,
    y: 0,
    width: 128,
    height: 112
  });
});

import assert from "node:assert/strict";
import { basename, join } from "node:path";
import test from "node:test";
import {
  BAIDU_FINANCE_US_SCREENSHOT_FILES,
  BAIDU_FINANCE_SCREENSHOT_FILES,
  getBaiduFinanceScreenshotPaths
} from "../../dist/capture/baidu-finance-screenshots.js";

test("keeps the Baidu Finance screenshot sequence aligned with the capture script", () => {
  assert.deepEqual([...BAIDU_FINANCE_SCREENSHOT_FILES], [
    "baidu-finance-market.png",
    "baidu-finance-hot-blocks-industry.png",
    "baidu-finance-hot-blocks-concept.png",
    "baidu-finance-heatmap-industry.png",
    "baidu-finance-heatmap-concept.png",
    "baidu-finance-main-inflow-industry.png",
    "baidu-finance-main-inflow-concept.png"
  ]);
  assert.deepEqual(
    getBaiduFinanceScreenshotPaths("C:/tmp/a-share").map((path) => basename(path)),
    [...BAIDU_FINANCE_SCREENSHOT_FILES]
  );
  assert.equal(getBaiduFinanceScreenshotPaths("C:/tmp/a-share")[0], join("C:/tmp/a-share", "baidu-finance-market.png"));
});

test("keeps the U.S. market screenshot sequence aligned with the capture script", () => {
  assert.deepEqual([...BAIDU_FINANCE_US_SCREENSHOT_FILES], [
    "baidu-finance-us-market.png",
    "baidu-finance-us-heatmap.png",
    "baidu-finance-us-main-inflow.png",
    "baidu-finance-us-hot-blocks.png"
  ]);
  assert.deepEqual(
    getBaiduFinanceScreenshotPaths("C:/tmp/us-share", "us").map((path) => basename(path)),
    [...BAIDU_FINANCE_US_SCREENSHOT_FILES]
  );
  assert.equal(
    getBaiduFinanceScreenshotPaths("C:/tmp/us-share", "us")[0],
    join("C:/tmp/us-share", "baidu-finance-us-market.png")
  );
});

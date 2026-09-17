import { access, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const screenshotScriptPath = resolve(projectRoot, "demo/baidu-finance-market-screenshot.mjs");

export type BaiduFinanceMarket = "a" | "us";

export const BAIDU_FINANCE_SCREENSHOT_FILES = [
  "baidu-finance-market.png",
  "baidu-finance-hot-blocks-industry.png",
  "baidu-finance-hot-blocks-concept.png",
  "baidu-finance-heatmap-industry.png",
  "baidu-finance-heatmap-concept.png",
  "baidu-finance-main-inflow-industry.png",
  "baidu-finance-main-inflow-concept.png"
] as const;

export const BAIDU_FINANCE_US_SCREENSHOT_FILES = [
  "baidu-finance-us-market.png",
  "baidu-finance-us-heatmap.png",
  "baidu-finance-us-main-inflow.png",
  "baidu-finance-us-hot-blocks.png"
] as const;

export function getBaiduFinanceScreenshotPaths(
  outputDirectory: string,
  market: BaiduFinanceMarket = "a"
): string[] {
  const fileNames = market === "us" ? BAIDU_FINANCE_US_SCREENSHOT_FILES : BAIDU_FINANCE_SCREENSHOT_FILES;
  return fileNames.map((fileName) => join(outputDirectory, fileName));
}

export async function captureBaiduFinanceScreenshots(
  outputDirectory: string,
  market: BaiduFinanceMarket = "a"
): Promise<string[]> {
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = getBaiduFinanceScreenshotPaths(outputDirectory, market)[0];
  await execFileAsync(process.execPath, [screenshotScriptPath, outputPath, "--market", market], {
    cwd: projectRoot,
    env: process.env,
    maxBuffer: 2 * 1024 * 1024
  });

  const screenshotPaths = getBaiduFinanceScreenshotPaths(outputDirectory, market);
  await Promise.all(screenshotPaths.map((screenshotPath) => access(screenshotPath)));
  return screenshotPaths;
}

export function captureBaiduFinanceUSScreenshots(outputDirectory: string): Promise<string[]> {
  return captureBaiduFinanceScreenshots(outputDirectory, "us");
}

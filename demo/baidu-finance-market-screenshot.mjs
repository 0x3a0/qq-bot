import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const aSharePageUrl = process.env.BAIDU_FINANCE_URL ?? "https://finance.baidu.com/";
const aShareHeatmapPageUrl = process.env.BAIDU_FINANCE_HEATMAP_URL ?? "https://finance.baidu.com/heat-treemap/home/ab?tab=HY&value=amount&financeType=block";
const usSharePageUrl = process.env.BAIDU_FINANCE_US_URL ?? "https://finance.baidu.com/?quotationMarket=us";
export const usShareHeatmapPageUrl = process.env.BAIDU_FINANCE_US_HEATMAP_URL ?? "https://finance.baidu.com/heat-treemap/home/us?tab=HY&value=amount&financeType=block";
const waitTimeoutMs = 30_000;
const viewport = { width: 1440, height: 1600 };
export const hotBlocksViewport = { width: 1800, height: 1600 };
export const heatmapViewport = { width: 1756, height: 760 };
export const usShareViewport = { width: 1800, height: 1600 };
const screenshotPadding = 24;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultAShareOutputPath = resolve(scriptDirectory, "baidu-finance-market.png");
const defaultUSShareOutputPath = resolve(scriptDirectory, "baidu-finance-us-market.png");

export const marketModuleTitles = ["A股涨跌分布"];
export const heatmapModes = [
  { key: "industry", tabLabel: "行业板块" },
  { key: "concept", tabLabel: "概念板块" }
];
export const mainInflowModes = [
  { key: "industry", optionLabels: ["行业"] },
  { key: "concept", optionLabels: ["概念"] }
];
export const hotBlockModes = [
  { key: "industry", tabLabel: "行业板块" },
  { key: "concept", tabLabel: "概念板块" }
];
export const usMarketModuleTitles = ["美股涨跌分布"];
export const usHeatmapMarketTab = "板块";
export const usHeatmapBlockTab = "行业板块";

export function parseCaptureArguments(argumentsList) {
  let market = "a";
  let outputPathArgument;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--market") {
      const selectedMarket = argumentsList[index + 1];
      if (selectedMarket !== "a" && selectedMarket !== "us") {
        throw new Error("--market must be either a or us");
      }
      market = selectedMarket;
      index += 1;
    } else if (argument.startsWith("--market=")) {
      const selectedMarket = argument.slice("--market=".length);
      if (selectedMarket !== "a" && selectedMarket !== "us") {
        throw new Error("--market must be either a or us");
      }
      market = selectedMarket;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (outputPathArgument === undefined) {
      outputPathArgument = argument;
    } else {
      throw new Error("Only one output path may be specified");
    }
  }

  return {
    market,
    outputPath: resolve(outputPathArgument ?? (market === "us" ? defaultUSShareOutputPath : defaultAShareOutputPath))
  };
}

async function main() {
  const { market, outputPath } = parseCaptureArguments(process.argv.slice(2));
  await mkdir(dirname(outputPath), { recursive: true });

  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim() || findLocalBrowser();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });

  try {
    if (market === "us") {
      await captureUSShareScreenshots(browser, outputPath);
    } else {
      await captureAShareScreenshots(browser, outputPath);
    }
  } finally {
    await browser.close();
  }
}

async function captureAShareScreenshots(browser, outputPath) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  const response = await page.goto(aSharePageUrl, {
    waitUntil: "domcontentloaded",
    timeout: waitTimeoutMs
  });
  if (!response || response.status() >= 400) {
    throw new Error(`Baidu Finance page request failed with HTTP ${response?.status() ?? "unknown"}`);
  }

  const cards = await Promise.all(marketModuleTitles.map((title) => findMarketModule(page, title)));
  const mainInflowCard = await findMarketModule(page, "A股主力净流入");
  await mainInflowCard.evaluate((element) => {
    element.setAttribute("data-qq-main-inflow-card", "true");
  });
  const hotBlocksCard = await findHotBlocksCard(page);
  const latestAnomalyCard = await findLatestAnomalyCard(page);
  await hotBlocksCard.evaluate((element) => {
    element.setAttribute("data-qq-hot-blocks-card", "true");
  });
  await latestAnomalyCard.evaluate((element) => {
    element.setAttribute("data-qq-latest-anomaly-card", "true");
  });
  await captureCards(page, cards, outputPath);
  console.log(`Saved Baidu Finance A-share distribution screenshot to ${outputPath}`);

  await page.setViewportSize(hotBlocksViewport);
  for (const mode of hotBlockModes) {
    await prepareScreenshotStage(page, [hotBlocksCard]);
    await selectHotBlocksMode(page, hotBlocksCard, mode);
    const hotBlocksOutputPath = resolve(dirname(outputPath), `baidu-finance-hot-blocks-${mode.key}.png`);
    const clip = await captureCards(page, [hotBlocksCard, latestAnomalyCard], hotBlocksOutputPath);
    console.log(`Saved Baidu Finance hot blocks screenshot (${mode.key}) to ${hotBlocksOutputPath}`);
    console.log(`Clip: ${clip.width}x${clip.height} at (${clip.x}, ${clip.y})`);
  }
  await page.setViewportSize(viewport);

  const heatmapPage = await browser.newPage({ viewport: heatmapViewport, deviceScaleFactor: 1 });
  const heatmapResponse = await heatmapPage.goto(aShareHeatmapPageUrl, {
    waitUntil: "domcontentloaded",
    timeout: waitTimeoutMs
  });
  if (!heatmapResponse || heatmapResponse.status() >= 400) {
    throw new Error(`Baidu Finance heatmap page request failed with HTTP ${heatmapResponse?.status() ?? "unknown"}`);
  }
  const heatmapCard = await findMarketModule(heatmapPage, "热力图");
  await heatmapCard.evaluate((element) => {
    element.setAttribute("data-qq-heatmap-card", "true");
  });
  for (const mode of heatmapModes) {
    await selectHeatmapMode(heatmapPage, heatmapCard, mode);
    const heatmapOutputPath = resolve(dirname(outputPath), `baidu-finance-heatmap-${mode.key}.png`);
    const clip = await captureCards(heatmapPage, [heatmapCard], heatmapOutputPath);
    console.log(`Saved Baidu Finance heatmap screenshot (${mode.key}) to ${heatmapOutputPath}`);
    console.log(`Clip: ${clip.width}x${clip.height} at (${clip.x}, ${clip.y})`);
  }

  for (const mode of mainInflowModes) {
    await prepareScreenshotStage(page, [mainInflowCard]);
    const selectedOptionLabel = await selectMainInflowMode(page, mainInflowCard, mode);
    const mainInflowOutputPath = resolve(dirname(outputPath), `baidu-finance-main-inflow-${mode.key}.png`);
    const clip = await captureCards(page, [mainInflowCard], mainInflowOutputPath);
    console.log(
      `Saved Baidu Finance main inflow screenshot (${mode.key}, option ${selectedOptionLabel}) to ${mainInflowOutputPath}`
    );
    console.log(`Clip: ${clip.width}x${clip.height} at (${clip.x}, ${clip.y})`);
  }
}

async function captureUSShareScreenshots(browser, outputPath) {
  const page = await browser.newPage({ viewport: usShareViewport, deviceScaleFactor: 2 });
  const response = await page.goto(usSharePageUrl, {
    waitUntil: "domcontentloaded",
    timeout: waitTimeoutMs
  });
  if (!response || response.status() >= 400) {
    throw new Error(`Baidu Finance U.S. market page request failed with HTTP ${response?.status() ?? "unknown"}`);
  }

  const distributionCards = await Promise.all(usMarketModuleTitles.map((title) => findMarketModule(page, title)));
  const mainInflowCard = await findMarketModule(page, "美股主力净流入");
  await mainInflowCard.evaluate((element) => {
    element.setAttribute("data-qq-main-inflow-card", "true");
  });
  const hotBlocksCard = await findUSHotBlocksCard(page);
  await hotBlocksCard.evaluate((element) => {
    element.setAttribute("data-qq-hot-blocks-card", "true");
  });

  await captureCards(page, distributionCards, outputPath);
  console.log(`Saved Baidu Finance U.S. distribution screenshot to ${outputPath}`);

  const heatmapPage = await browser.newPage({ viewport: heatmapViewport, deviceScaleFactor: 1 });
  const heatmapResponse = await heatmapPage.goto(usShareHeatmapPageUrl, {
    waitUntil: "domcontentloaded",
    timeout: waitTimeoutMs
  });
  if (!heatmapResponse || heatmapResponse.status() >= 400) {
    throw new Error(`Baidu Finance U.S. heatmap page request failed with HTTP ${heatmapResponse?.status() ?? "unknown"}`);
  }
  const heatmapCard = await findMarketModule(heatmapPage, "热力图");
  await heatmapCard.evaluate((element) => {
    element.setAttribute("data-qq-us-heatmap-card", "true");
  });
  await selectUSHeatmapBlocks(heatmapPage, heatmapCard);
  const heatmapOutputPath = resolve(dirname(outputPath), "baidu-finance-us-heatmap.png");
  const heatmapClip = await captureCards(heatmapPage, [heatmapCard], heatmapOutputPath);
  console.log(`Saved Baidu Finance U.S. heatmap screenshot to ${heatmapOutputPath}`);
  console.log(`Clip: ${heatmapClip.width}x${heatmapClip.height} at (${heatmapClip.x}, ${heatmapClip.y})`);

  const mainInflowOutputPath = resolve(dirname(outputPath), "baidu-finance-us-main-inflow.png");
  const mainInflowClip = await captureCards(page, [mainInflowCard], mainInflowOutputPath);
  console.log(`Saved Baidu Finance U.S. main inflow screenshot to ${mainInflowOutputPath}`);
  console.log(`Clip: ${mainInflowClip.width}x${mainInflowClip.height} at (${mainInflowClip.x}, ${mainInflowClip.y})`);

  const hotBlocksOutputPath = resolve(dirname(outputPath), "baidu-finance-us-hot-blocks.png");
  const hotBlocksClip = await captureCards(page, [hotBlocksCard], hotBlocksOutputPath);
  console.log(`Saved Baidu Finance U.S. hot blocks screenshot to ${hotBlocksOutputPath}`);
  console.log(`Clip: ${hotBlocksClip.width}x${hotBlocksClip.height} at (${hotBlocksClip.x}, ${hotBlocksClip.y})`);
}

async function captureCards(page, cards, outputPath) {
  await prepareScreenshotStage(page, cards);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);

  const scrollPosition = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY
  }));
  const boxes = await Promise.all(cards.map((card) => card.boundingBox()));
  const documentBoxes = boxes.map((box) => box && translateBoxToDocument(box, scrollPosition));
  const marketClip = getUnionClip(documentBoxes);
  const pageSize = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight
  }));
  const clip = getPaddedClip(marketClip, screenshotPadding, pageSize);
  await page.screenshot({ path: outputPath, type: "png", fullPage: true, clip });
  return clip;
}

async function findMarketModule(page, title) {
  const heading = page.getByText(title, { exact: true });
  await heading.waitFor({ state: "visible", timeout: waitTimeoutMs });

  const moduleItem = page.locator(".module-item").filter({ has: heading });
  const moduleCard = page.locator(".module-card").filter({ has: heading });
  const card = await moduleItem.count() === 1 ? moduleItem : moduleCard;
  if (await card.count() !== 1) {
    throw new Error(`Expected one Baidu Finance module for ${title}, found ${await card.count()}`);
  }
  await card.waitFor({ state: "visible", timeout: waitTimeoutMs });

  const canvas = card.locator("canvas").first();
  await canvas.waitFor({ state: "visible", timeout: waitTimeoutMs });
  return card;
}

async function findHotBlocksCard(page) {
  const card = page.locator('.module-card[data-name="hotBlocks"]');
  await card.waitFor({ state: "visible", timeout: waitTimeoutMs });
  await card.scrollIntoViewIfNeeded();
  await card.locator(".cos-tab").first().waitFor({ state: "visible", timeout: waitTimeoutMs });
  await card.locator(".block-module-container").first().waitFor({ state: "visible", timeout: waitTimeoutMs });
  return card;
}

async function findUSHotBlocksCard(page) {
  const card = page.locator('.module-card[data-name="hotBlocks"]');
  await card.waitFor({ state: "visible", timeout: waitTimeoutMs });
  await card.scrollIntoViewIfNeeded();
  await card.locator(".block-module-container").first().waitFor({ state: "visible", timeout: waitTimeoutMs });
  return card;
}

async function findLatestAnomalyCard(page) {
  const anomalyContent = page.locator('[class*="anomaly-container"]');
  await anomalyContent.waitFor({ state: "visible", timeout: waitTimeoutMs });
  const card = anomalyContent.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' module-card ')][1]");
  await card.waitFor({ state: "visible", timeout: waitTimeoutMs });
  return card;
}

async function selectHeatmapMode(page, card, mode) {
  await selectCardTab(page, card, mode, '[data-qq-heatmap-card="true"]');
  await waitForCanvasToSettle(page, card.locator("canvas").first());
}

async function selectHotBlocksMode(page, card, mode) {
  await selectCardTab(page, card, mode, '[data-qq-hot-blocks-card="true"]');
  await page.waitForTimeout(500);
}

async function selectUSHeatmapBlocks(page, card) {
  await selectCardTab(page, card, { tabLabel: "股票" }, '[data-qq-us-heatmap-card="true"]');
  await selectCardTab(page, card, { tabLabel: usHeatmapMarketTab }, '[data-qq-us-heatmap-card="true"]');
  const blockTab = card.locator(".cos-tab").filter({ hasText: usHeatmapBlockTab });
  await blockTab.waitFor({ state: "visible", timeout: waitTimeoutMs });
  await selectCardTab(page, card, { tabLabel: usHeatmapBlockTab }, '[data-qq-us-heatmap-card="true"]');
  await waitForCanvasToSettle(page, card.locator("canvas").first());
}

async function selectCardTab(page, card, mode, cardSelector) {
  const tabs = card.locator(".cos-tab");
  const tabLabels = (await tabs.allTextContents()).map(normalizeLabel);
  const tabIndex = tabLabels.indexOf(mode.tabLabel);
  if (tabIndex < 0) {
    throw new Error(`Baidu Finance heatmap tab ${mode.tabLabel} is unavailable; found ${tabLabels.join(", ")}`);
  }

  await tabs.nth(tabIndex).click();
  await page.waitForFunction(
    ({ cardSelector: selector, expectedLabel }) => [...document.querySelectorAll(`${selector} .cos-tab`)]
      .some((element) => element.textContent?.trim() === expectedLabel && element.classList.contains("cos-tab-active")),
    { cardSelector, expectedLabel: mode.tabLabel },
    { timeout: waitTimeoutMs }
  );
}

async function selectMainInflowMode(page, card, mode) {
  const modeButton = card.locator(".entry-btn");
  const currentOptionLabel = normalizeLabel(await modeButton.innerText());
  if (mode.optionLabels.includes(currentOptionLabel)) return currentOptionLabel;

  await modeButton.click();
  const menu = card.locator(".dropdown-menu-list");
  await menu.waitFor({ state: "visible", timeout: waitTimeoutMs });
  const options = menu.locator(".dropdown-menu-item");
  const optionLabels = (await options.allTextContents()).map(normalizeLabel);
  const selectedOptionLabel = resolveModeOptionLabel(optionLabels, mode);
  if (!selectedOptionLabel) {
    throw new Error(
      `Baidu Finance main inflow mode ${mode.key} is unavailable; expected ${mode.optionLabels.join(" or ")}, found ${optionLabels.join(", ")}`
    );
  }

  await options.nth(optionLabels.indexOf(selectedOptionLabel)).click();
  await page.waitForFunction(
    ({ cardSelector, expectedLabel }) => document.querySelector(cardSelector)?.querySelector(".entry-btn")?.textContent?.trim() === expectedLabel,
    { cardSelector: '[data-qq-main-inflow-card="true"]', expectedLabel: selectedOptionLabel },
    { timeout: waitTimeoutMs }
  );
  await page.waitForTimeout(500);
  return selectedOptionLabel;
}

async function waitForCanvasToSettle(page, canvas) {
  let previousImage = await canvas.screenshot();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(200);
    const currentImage = await canvas.screenshot();
    if (currentImage.equals(previousImage)) return;
    previousImage = currentImage;
  }
}

function normalizeLabel(value) {
  return value.replace(/\s+/g, " ").trim();
}

async function prepareScreenshotStage(page, cards) {
  await page.locator("[data-qq-market-screenshot-target]").evaluateAll((elements) => {
    elements.forEach((element) => element.removeAttribute("data-qq-market-screenshot-target"));
  });
  await Promise.all(cards.map((card) => card.evaluate((element) => {
    element.setAttribute("data-qq-market-screenshot-target", "true");
  })));
  await page.addStyleTag({
    content: `
      html, body { background: #fff !important; }
      body * { visibility: hidden !important; }
      [data-qq-market-screenshot-target],
      [data-qq-market-screenshot-target] * { visibility: visible !important; }
    `
  });
}

function findLocalBrowser() {
  if (process.platform !== "win32") return undefined;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function getUnionClip(boxes) {
  if (boxes.length === 0 || boxes.some((box) => box === null)) {
    throw new Error("Baidu Finance market module bounds are unavailable");
  }

  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function translateBoxToDocument(box, scrollPosition) {
  return {
    ...box,
    x: box.x + scrollPosition.x,
    y: box.y + scrollPosition.y
  };
}

export function getPaddedClip(clip, padding, viewportSize) {
  if (!Number.isFinite(padding) || padding < 0) throw new Error("Screenshot padding must be non-negative");

  const x = Math.max(0, clip.x - padding);
  const y = Math.max(0, clip.y - padding);
  const right = Math.min(viewportSize.width, clip.x + clip.width + padding);
  const bottom = Math.min(viewportSize.height, clip.y + clip.height + padding);
  return { x, y, width: right - x, height: bottom - y };
}

export function resolveModeOptionLabel(optionLabels, mode) {
  return mode.optionLabels.find((optionLabel) => optionLabels.includes(optionLabel));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Failed to capture Baidu Finance market screenshot", error);
    process.exitCode = 1;
  });
}

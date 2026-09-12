/**
 * 本地渲染自检：抓取真实行业板块数据并生成 PNG，不需要 QQ 凭据。
 * 用法：npm run render:sample
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadDotEnv } from '../src/env.js';
import { createLogger, describeError, setLogLevel } from '../src/logger.js';
import { EastmoneyIndustryProvider, MAX_TOP_BLOCKS, takeTopBlocks } from '../src/market/eastmoney.js';
import { formatChangePercent, formatQuoteTime, formatTurnover, summarizeBlocks } from '../src/market/format.js';
import { renderPng } from '../src/render/image.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig({
    ...process.env,
    // 渲染自检不需要 QQ 凭据，这里补占位值以便复用配置加载
    APP_ID: process.env.APP_ID ?? 'render-sample',
    CLIENT_SECRET: process.env.CLIENT_SECRET ?? 'render-sample',
  });
  setLogLevel(config.logLevel === 'debug' ? 'debug' : 'info');
  const logger = createLogger('render-sample');

  const provider = new EastmoneyIndustryProvider({ logger, cacheTtlMs: 0 });
  const snapshot = await provider.getIndustrySnapshot();
  const top = takeTopBlocks(snapshot.blocks, MAX_TOP_BLOCKS);

  const image = renderPng({
    blocks: top,
    source: snapshot.source,
    quoteTime: snapshot.quoteTime,
    fetchedAt: snapshot.fetchedAt,
    fontFiles: config.fontFiles,
  });

  const dir = join(process.cwd(), '.tmp-probe', 'preview');
  await mkdir(dir, { recursive: true });
  const pngPath = join(dir, 'market-sample.png');
  const svgPath = join(dir, 'market-sample.svg');
  await writeFile(pngPath, image.png);
  await writeFile(svgPath, image.svg, 'utf8');

  const stats = summarizeBlocks(top);
  logger.info(`PNG：${pngPath}（${image.width}x${image.height}，${(image.png.length / 1024).toFixed(0)}KB）`);
  logger.info(`SVG：${svgPath}`);
  logger.info(`行情时间：${formatQuoteTime(snapshot.quoteTime)}，来源：${snapshot.source}`);
  logger.info(`涨跌统计：上涨 ${stats.up} / 下跌 ${stats.down} / 平盘 ${stats.flat}`);
  for (const [index, block] of top.slice(0, 5).entries()) {
    logger.info(
      `${index + 1}. ${block.name} ${formatChangePercent(block.changePercent)} 成交额 ${formatTurnover(block.turnover)}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error('渲染自检失败：', describeError(error));
  process.exitCode = 1;
});

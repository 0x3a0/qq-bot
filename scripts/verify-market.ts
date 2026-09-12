/**
 * 行情取数自检：只验证东方财富行业板块接口与排序逻辑，不需要 QQ 凭据。
 * 用法：npm run verify:market
 */
import { createLogger, describeError } from '../src/logger.js';
import { EastmoneyIndustryProvider, MAX_TOP_BLOCKS, takeTopBlocks } from '../src/market/eastmoney.js';
import { formatChangePercent, formatQuoteTime, formatTurnover } from '../src/market/format.js';

async function main(): Promise<void> {
  const logger = createLogger('verify-market');
  const provider = new EastmoneyIndustryProvider({ logger, cacheTtlMs: 0 });

  const snapshot = await provider.getIndustrySnapshot();
  const top = takeTopBlocks(snapshot.blocks, MAX_TOP_BLOCKS);

  console.log(`\n来源：${snapshot.source}`);
  console.log(`行情时间：${formatQuoteTime(snapshot.quoteTime)}`);
  console.log(`行业板块总数：${snapshot.blocks.length}`);
  console.log(`成交额 TOP${MAX_TOP_BLOCKS}：`);
  for (const [index, block] of top.entries()) {
    console.log(
      `${String(index + 1).padStart(2, ' ')}. ${block.name.padEnd(8, '　')} ` +
        `${formatChangePercent(block.changePercent).padStart(8)} ${formatTurnover(block.turnover).padStart(9)}`,
    );
  }

  const sorted = top.every((block, index) => index === 0 || (top[index - 1]?.turnover ?? 0) >= block.turnover);
  console.log(`\n按成交额降序：${sorted ? '通过' : '失败'}`);
  if (!sorted) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('行情自检失败：', describeError(error));
  process.exitCode = 1;
});

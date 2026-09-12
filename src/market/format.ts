/** 行情展示格式化工具（图片与文字回复共用）。 */
import type { MarketBlock } from './types.js';

const PAD = (value: number, size = 2): string => String(value).padStart(size, '0');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 取某个时刻在东八区的日期字符串 YYYY-MM-DD。 */
export function shanghaiDateKey(date: Date): string {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${PAD(shifted.getUTCMonth() + 1)}-${PAD(shifted.getUTCDate())}`;
}

/** 判断行情时间是否来自更早的交易日（周末/节假日/休市时会出现）。 */
export function isPreviousTradingDay(quoteTime: Date | null, now: Date = new Date()): boolean {
  if (!quoteTime) return false;
  return shanghaiDateKey(quoteTime) !== shanghaiDateKey(now);
}

/** 格式化为 MM-DD HH:mm（行情时间/抓取时间均按东八区展示）。 */
export function formatQuoteTime(date: Date | null): string {
  if (!date) return '时间未知';
  // 服务器可能运行在任意时区，这里显式按东八区输出
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return `${PAD(shifted.getUTCMonth() + 1)}-${PAD(shifted.getUTCDate())} ${PAD(shifted.getUTCHours())}:${PAD(
    shifted.getUTCMinutes(),
  )}`;
}

/** 成交额格式化为「亿元 / 万元」。 */
export function formatTurnover(turnover: number): string {
  if (!Number.isFinite(turnover) || turnover <= 0) return '-';
  if (turnover >= 1e8) {
    const yi = turnover / 1e8;
    if (yi >= 1000) return `${yi.toFixed(0)}亿`;
    // 整数时不留 `.0`，文字榜单里更紧凑易读
    return `${Number.isInteger(Number(yi.toFixed(1))) ? yi.toFixed(0) : yi.toFixed(1)}亿`;
  }
  if (turnover >= 1e4) return `${(turnover / 1e4).toFixed(0)}万`;
  return turnover.toFixed(0);
}

/** 涨跌幅格式化为带符号百分数。 */
export function formatChangePercent(changePercent: number): string {
  if (!Number.isFinite(changePercent)) return '-';
  const sign = changePercent > 0 ? '+' : '';
  return `${sign}${changePercent.toFixed(2)}%`;
}

export interface MarketSummaryOptions {
  /** 生成时间（用于兜底展示与判断是否上一交易日） */
  now?: Date;
}

/**
 * 生成图片头部的数据说明文字，例如：
 * 东方财富 · 行业板块成交额 TOP25 · 行情时间 15:00
 *
 * 当行情时间不是今天时（周末/节假日/休市），在时间前带上完整日期（YYYY-MM-DD），
 * 避免把上一交易日的收盘数据误读成实时行情。
 */
export function formatSnapshotSubtitle(
  params: { source: string; quoteTime: Date | null; fetchedAt: Date; blockCount: number },
  options: MarketSummaryOptions = {},
): string {
  const now = options.now ?? new Date();
  const time = params.quoteTime ?? now;
  const label = params.quoteTime ? '行情时间' : '抓取时间';

  let timeText = formatQuoteTime(time);
  if (params.quoteTime && isPreviousTradingDay(params.quoteTime, now)) {
    const shifted = new Date(params.quoteTime.getTime() + SHANGHAI_OFFSET_MS);
    timeText = `${shifted.getUTCFullYear()}-${timeText}`;
  }

  return `${params.source} · 行业板块成交额 TOP${params.blockCount} · ${label} ${timeText}`;
}

/** 生成涨跌幅概览，例如「上涨 12 / 下跌 7」。 */
export function summarizeBlocks(blocks: MarketBlock[]): { up: number; down: number; flat: number } {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const block of blocks) {
    if (block.changePercent > 0) up += 1;
    else if (block.changePercent < 0) down += 1;
    else flat += 1;
  }
  return { up, down, flat };
}

/**
 * 生成成交额 TOP N 的文字榜单，用于在图片之前先发一条文本数据。
 * 单行格式：`序号. 板块名 涨跌幅 成交额`，例如：
 * ` 1. 电子 -1.10% 4886亿`
 * 每行约占 20 个字符，30 行总额远小于平台文本上限。
 */
export function formatBlockRanking(
  blocks: MarketBlock[],
  options: { title?: string; footer?: string } = {},
): string {
  const lines = blocks.map((block, index) => {
    const rank = String(index + 1).padStart(2, ' ');
    return `${rank}. ${block.name} ${formatChangePercent(block.changePercent)} ${formatTurnover(block.turnover)}`;
  });

  const content = [options.title, ...lines, options.footer].filter(
    (line): line is string => typeof line === 'string' && line.length > 0,
  );
  return content.join('\n');
}

/** 文字榜单的标题，例如「行业板块成交额 TOP25」。 */
export function formatRankingTitle(blockCount: number): string {
  return `行业板块成交额 TOP${blockCount}`;
}

/** 文字榜单的落款，例如「东方财富 · 行情时间 09-11 15:39」。 */
export function formatRankingFooter(params: {
  source: string;
  quoteTime: Date | null;
  fetchedAt: Date;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const time = params.quoteTime ?? now;
  const label = params.quoteTime ? '行情时间' : '抓取时间';
  let timeText = formatQuoteTime(time);
  if (params.quoteTime && isPreviousTradingDay(params.quoteTime, now)) {
    const shifted = new Date(params.quoteTime.getTime() + SHANGHAI_OFFSET_MS);
    timeText = `${shifted.getUTCFullYear()}-${timeText}`;
  }
  return `${params.source} · ${label} ${timeText}`;
}

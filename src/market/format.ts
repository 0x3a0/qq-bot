/** 行情展示格式化工具（图片与文字回复共用）。 */
import type { MarketBlock } from './types.js';

const PAD = (value: number, size = 2): string => String(value).padStart(size, '0');

/** 格式化为 MM-DD HH:mm（行情时间/抓取时间均按东八区展示）。 */
export function formatQuoteTime(date: Date | null): string {
  if (!date) return '时间未知';
  // 服务器可能运行在任意时区，这里显式按东八区输出
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${PAD(shifted.getUTCMonth() + 1)}-${PAD(shifted.getUTCDate())} ${PAD(shifted.getUTCHours())}:${PAD(
    shifted.getUTCMinutes(),
  )}`;
}

/** 成交额格式化为「亿元 / 万元」。 */
export function formatTurnover(turnover: number): string {
  if (!Number.isFinite(turnover) || turnover <= 0) return '-';
  if (turnover >= 1e8) {
    const yi = turnover / 1e8;
    return `${yi >= 1000 ? yi.toFixed(0) : yi.toFixed(1)}亿`;
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
  /** 生成时间（用于兜底展示） */
  now?: Date;
}

/**
 * 生成图片下方的数据说明文字，例如：
 * 东方财富 · 行业板块成交额 TOP20 · 行情时间 07-21 15:00
 */
export function formatSnapshotSubtitle(
  params: { source: string; quoteTime: Date | null; fetchedAt: Date; blockCount: number },
  options: MarketSummaryOptions = {},
): string {
  const time = params.quoteTime ?? options.now ?? params.fetchedAt;
  const label = params.quoteTime ? '行情时间' : '抓取时间';
  return `${params.source} · 行业板块成交额 TOP${params.blockCount} · ${label} ${formatQuoteTime(time)}`;
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

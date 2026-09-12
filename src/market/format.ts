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
  /** 生成时间（用于兜底展示与判断是否上一交易日） */
  now?: Date;
}

/**
 * 生成图片下方的数据说明文字，例如：
 * 东方财富 · 行业板块成交额 TOP20 · 行情时间 07-21 15:00
 *
 * 当行情时间不是今天时（周末/节假日/休市），额外标注日期，
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
    // 带上年月日，明确这是历史（上一交易日）数据
    const shifted = new Date(params.quoteTime.getTime() + SHANGHAI_OFFSET_MS);
    timeText = `${shifted.getUTCFullYear()}-${timeText}（非今日，上一交易日数据）`;
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

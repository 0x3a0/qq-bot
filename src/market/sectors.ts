/**
 * 把板块资金流数据适配成 Treemap 可渲染的块。
 *
 * MVP 数据方案（见 MVP_TECH_PLAN.md 第 4 节）：
 * - 数据源：东方财富行业 / 概念板块资金流
 * - 排序：主力净流入额 f62 降序
 * - 取前 25 个板块出图
 *
 * 矩形面积使用主力净流入额（亿元），颜色使用涨跌幅 f3。
 */
import type { MarketBlock } from './types.js';
import { takeTopByMainNet, type FundFlowSnapshot, type SectorFundFlow } from './fundflow-types.js';

/** 出图取前 N 个板块。 */
export const MAX_TOP_SECTORS = 25;

/** 单个板块资金流 → Treemap 块；area 即主力净流入额。 */
export function fundFlowToBlock(sector: SectorFundFlow): MarketBlock {
  return {
    code: sector.code,
    name: sector.name,
    changePercent: sector.changePercent,
    // 复用 MarketBlock.turnover 字段承载「矩形面积」的数值，此处为主力净流入额（元）
    turnover: sector.mainNet,
    quoteTimestamp: null,
  };
}

/**
 * 取主力净流入额前 N 的板块并转成渲染块。
 * 负值（净流出）不参与面积计算，会被 treemap 过滤掉。
 */
export function takeTopBlocks(snapshot: FundFlowSnapshot, limit: number = MAX_TOP_SECTORS): MarketBlock[] {
  if (limit <= 0) return [];
  return takeTopByMainNet(snapshot.sectors, limit).map(fundFlowToBlock);
}

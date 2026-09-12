/** 资金流领域模型（东方财富行业 / 概念板块资金流）。 */

/** 统计周期：今日 / 5 日 / 10 日。 */
export type FundFlowPeriod = 'today' | '5d' | '10d';

export const FUND_FLOW_PERIODS: readonly FundFlowPeriod[] = ['today', '5d', '10d'];

export const FUND_FLOW_PERIOD_LABEL: Record<FundFlowPeriod, string> = {
  today: '今日',
  '5d': '5日',
  '10d': '10日',
};

/** 板块类型：行业 / 概念。 */
export type SectorKind = 'industry' | 'concept';

export const SECTOR_KIND_LABEL: Record<SectorKind, string> = {
  industry: '行业板块',
  concept: '概念板块',
};

/**
 * 单个板块在某个周期下的资金流。
 * 金额单位统一为「元」，字段名与东方财富口径一致：
 * 主力 = 超大单 + 大单（接口层面严格相等）。
 */
export interface SectorFundFlow {
  /** 板块代码 f12，如 BK0448 */
  code: string;
  /** 板块名称 f14 */
  name: string;
  /** 板块涨跌幅 % f3 */
  changePercent: number;
  /** 主力净流入额（元） */
  mainNet: number;
  /** 主力净流入占比 %（占成交额） */
  mainNetRatio: number;
  /** 超大单净流入额（元） */
  superNet: number;
  /** 超大单净流入占比 % */
  superNetRatio: number;
  /** 大单净流入额（元） */
  bigNet: number;
  /** 大单净流入占比 % */
  bigNetRatio: number;
  /** 中单净流入额（元） */
  midNet: number;
  /** 中单净流入占比 % */
  midNetRatio: number;
  /** 小单净流入额（元） */
  smallNet: number;
  /** 小单净流入占比 % */
  smallNetRatio: number;
}

/** 某类板块在某个周期下的资金流快照。 */
export interface FundFlowSnapshot {
  /** 板块类型 */
  kind: SectorKind;
  /** 统计周期 */
  period: FundFlowPeriod;
  /** 数据来源 */
  source: string;
  /** 行情时间（取数据中最新的 f124），秒级时间戳转成 Date */
  quoteTime: Date | null;
  /** 抓取时间 */
  fetchedAt: Date;
  /** 该周期下资金流数据完整的板块（按接口排序，默认主力净额降序） */
  sectors: SectorFundFlow[];
}

/** 单板块分钟级资金流点位（用于画分时资金流曲线）。 */
export interface FundFlowMinutePoint {
  /** 时间，格式 "YYYY-MM-DD HH:mm" */
  time: string;
  /** 主力净流入额（元） */
  mainNet: number;
  /** 小单净流入额（元） */
  smallNet: number;
  /** 中单净流入额（元） */
  midNet: number;
  /** 大单净流入额（元） */
  bigNet: number;
  /** 超大单净流入额（元） */
  superNet: number;
}

/** 单板块分钟级资金流。 */
export interface SectorFundFlowDetail {
  /** 板块代码 */
  code: string;
  /** 板块名称（接口返回的真实名称） */
  name: string;
  /** 按时间升序的分钟级点位 */
  points: FundFlowMinutePoint[];
}

/** 资金流数据源。 */
export interface FundFlowProvider {
  /**
   * 取某类板块在指定周期下的资金流全量快照。
   * @param kind 行业 / 概念
   * @param period 统计周期，默认 today
   */
  getSectorFundFlow(kind: SectorKind, period?: FundFlowPeriod): Promise<FundFlowSnapshot>;

  /** 取单个板块的分钟级资金流明细。 */
  getSectorFundFlowDetail(code: string): Promise<SectorFundFlowDetail>;
}

/** 按主力净流入额取前 n 名。 */
export function takeTopByMainNet(sectors: SectorFundFlow[], limit: number): SectorFundFlow[] {
  if (limit <= 0) return [];
  return [...sectors].sort((a, b) => b.mainNet - a.mainNet).slice(0, limit);
}

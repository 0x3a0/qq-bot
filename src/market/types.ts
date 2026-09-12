/** 行情领域模型。 */
export interface MarketBlock {
  /** 板块代码 f12 */
  code: string;
  /** 板块名称 f14 */
  name: string;
  /** 涨跌幅 % f3 */
  changePercent: number;
  /** 成交额（元） f6 */
  turnover: number;
  /** 行情时间戳（秒） f124 */
  quoteTimestamp: number | null;
}

export interface MarketSnapshot {
  market: 'A股';
  source: string;
  /** 快照对应的行情时间（取数据中的最新 f124） */
  quoteTime: Date | null;
  /** 抓取时间 */
  fetchedAt: Date;
  /** 按成交额降序、已过滤的板块（全量） */
  blocks: MarketBlock[];
}

export interface MarketProvider {
  getIndustrySnapshot(): Promise<MarketSnapshot>;
}

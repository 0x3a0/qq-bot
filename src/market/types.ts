/**
 * 渲染块领域模型。
 *
 * Treemap 只关心「面积数值 + 颜色数值 + 文案」，与具体数据源解耦：
 * 面积由 `turnover` 承载（当前语义为板块主力净流入额，单位元），
 * 颜色由 `changePercent` 承载（涨跌幅 %）。
 */
export interface MarketBlock {
  /** 板块代码 f12 */
  code: string;
  /** 板块名称 f14 */
  name: string;
  /** 涨跌幅 % f3（决定矩形颜色） */
  changePercent: number;
  /** 矩形面积数值（当前为主力净流入额，单位「元」） */
  turnover: number;
  /** 行情时间戳（秒） f124 */
  quoteTimestamp: number | null;
}

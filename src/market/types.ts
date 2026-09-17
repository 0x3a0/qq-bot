export type MarketCategory = "industry" | "concept";

export const BOARD_PERFORMANCE_TOP_COUNT = 10;

export interface BoardPerformanceSector {
  code: string;
  name: string;
  changePercent: number;
  leader: string;
  leaderChangePercent: number;
}

export interface BoardPerformanceRankings {
  gain: BoardPerformanceSector[];
  loss: BoardPerformanceSector[];
}

export interface BoardPerformanceSnapshot {
  category: MarketCategory;
  rankings: BoardPerformanceRankings;
  fetchedAt: Date;
}

export interface BoardPerformanceData {
  industry: BoardPerformanceSnapshot;
  concept: BoardPerformanceSnapshot;
}

export interface BoardPerformanceDataProvider {
  getBoardPerformanceData(): Promise<BoardPerformanceData>;
}

import {
  BOARD_PERFORMANCE_TOP_COUNT,
  type BoardPerformanceData,
  type BoardPerformanceDataProvider,
  type BoardPerformanceSector,
  type BoardPerformanceSnapshot,
  type MarketCategory
} from "./types.js";

const DEFAULT_BASE_URL = "https://fuyao.aicubes.cn";
const INDEX_CATALOG_PATH = "/api/a-share-index/catalog/ths-index-list";
const INDEX_SNAPSHOT_PATH = "/api/a-share-index/prices/snapshot";
const CONSTITUENTS_PATH = "/api/a-share-index/constituents/ths-stock-list";
const STOCK_SNAPSHOT_PATH = "/api/a-share/prices/snapshot";
const INDUSTRY_INDEX_TAG = "industry";
const CONCEPT_INDEX_TAG = "cn_concept";
const DEFAULT_SNAPSHOT_BATCH_SIZE = 100;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_SNAPSHOT_TIMESTAMP_TOLERANCE_MS = 60_000;

const AUTH_FAILURE_CODES = new Set([2001, 2003]);
const RATE_LIMIT_CODE = 4001;
const RETRYABLE_BUSINESS_CODES = new Set([5001, 5002, 5003]);

type SortDirection = "gain" | "loss";
type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface CatalogRecord {
  thscode: string;
  name: string;
}

interface SnapshotRecord {
  thscode: string;
  changePercent: number | null;
}

interface SnapshotBatch {
  timestamp: number | null;
  records: SnapshotRecord[];
}

interface BatchedSnapshots {
  timestamps: Array<number | null>;
  changePercentByCode: Map<string, number | null>;
}

interface ConstituentRecord {
  thscode: string;
  name: string;
}

interface RankedSectors {
  gain: CatalogRecord[];
  loss: CatalogRecord[];
}

export interface ThsBoardPerformanceProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImplementation?: FetchImplementation;
  requestTimeoutMs?: number;
  retries?: number;
  retryBackoffMs?: number;
  snapshotBatchSize?: number;
  maxConcurrentRequests?: number;
  snapshotTimestampToleranceMs?: number;
}

class ThsApiError extends Error {}

class RequestLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error("Request limiter concurrency must be at least 1");
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

export class ThsBoardPerformanceProvider implements BoardPerformanceDataProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly requestTimeoutMs: number;
  private readonly retries: number;
  private readonly retryBackoffMs: number;
  private readonly snapshotBatchSize: number;
  private readonly maxConcurrentRequests: number;
  private readonly snapshotTimestampToleranceMs: number;

  constructor(options: ThsBoardPerformanceProviderOptions) {
    if (!options.apiKey) throw new Error("THS API key must be configured");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.retries = options.retries ?? 1;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.snapshotBatchSize = options.snapshotBatchSize ?? DEFAULT_SNAPSHOT_BATCH_SIZE;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.snapshotTimestampToleranceMs =
      options.snapshotTimestampToleranceMs ?? DEFAULT_SNAPSHOT_TIMESTAMP_TOLERANCE_MS;
  }

  async getBoardPerformanceData(): Promise<BoardPerformanceData> {
    const limiter = new RequestLimiter(this.maxConcurrentRequests);
    const [industry, concept] = await Promise.all([
      this.getCategorySnapshot(limiter, "industry", INDUSTRY_INDEX_TAG),
      this.getCategorySnapshot(limiter, "concept", CONCEPT_INDEX_TAG)
    ]);
    return { industry, concept };
  }

  private async getCategorySnapshot(
    limiter: RequestLimiter,
    category: MarketCategory,
    indexTag: string
  ): Promise<BoardPerformanceSnapshot> {
    const catalog = await this.fetchCatalog(limiter, category, indexTag);
    const indexSnapshots = await this.fetchBatchedSnapshots(
      limiter,
      INDEX_SNAPSHOT_PATH,
      `${category} index`,
      catalog.map((record) => record.thscode)
    );
    const fetchedAt = this.requireConsistentSnapshotTimestamp(indexSnapshots.timestamps, category);
    const changePercentByCode = this.requireCompleteIndexCoverage(category, catalog, indexSnapshots.changePercentByCode);
    const ranked = rankCatalogEntries(category, catalog, changePercentByCode);

    const selectedBoards = [...ranked.gain, ...ranked.loss];
    const constituentsByBoard = new Map(await Promise.all(selectedBoards.map(async (board) =>
      [board.thscode, await this.fetchBoardConstituents(limiter, category, board.thscode)] as const
    )));

    const constituentCodes = [...new Set(selectedBoards.flatMap((board) =>
      (constituentsByBoard.get(board.thscode) ?? []).map((constituent) => constituent.thscode)
    ))];
    const stockSnapshots = await this.fetchBatchedSnapshots(
      limiter,
      STOCK_SNAPSHOT_PATH,
      `${category} stock`,
      constituentCodes
    );
    this.rejectUnknownSnapshotCodes(category, "stock", constituentCodes, stockSnapshots.changePercentByCode);

    const buildSector = (board: CatalogRecord, direction: SortDirection): BoardPerformanceSector =>
      this.buildSector(
        board,
        direction,
        changePercentByCode.get(board.thscode) ?? 0,
        constituentsByBoard.get(board.thscode) ?? [],
        stockSnapshots.changePercentByCode
      );

    return {
      category,
      rankings: {
        gain: ranked.gain.map((board) => buildSector(board, "gain")),
        loss: ranked.loss.map((board) => buildSector(board, "loss"))
      },
      fetchedAt
    };
  }

  private async fetchCatalog(limiter: RequestLimiter, category: MarketCategory, indexTag: string): Promise<CatalogRecord[]> {
    const data = await this.requestLimited(limiter, INDEX_CATALOG_PATH, { tag: indexTag });
    const items = requireArrayField(data, "item", `THS ${category} catalog`);
    const catalog = items.map((item, index) => {
      const record = requireRecord(item, `THS ${category} catalog entry ${index}`);
      return {
        thscode: requireNonEmptyText(record.thscode, `THS ${category} catalog entry ${index} thscode`),
        name: requireNonEmptyText(record.name, `THS ${category} catalog entry ${index} name`)
      };
    });
    if (catalog.length === 0) throw new Error(`THS ${category} catalog is empty`);
    const seen = new Set<string>();
    for (const record of catalog) {
      if (seen.has(record.thscode)) throw new Error(`THS ${category} catalog contains duplicate thscode ${record.thscode}`);
      seen.add(record.thscode);
    }
    return catalog;
  }

  private async fetchBoardConstituents(
    limiter: RequestLimiter,
    category: MarketCategory,
    boardCode: string
  ): Promise<ConstituentRecord[]> {
    const data = await this.requestLimited(limiter, CONSTITUENTS_PATH, { thscode: boardCode });
    const items = requireArrayField(data, "item", `THS ${category} board ${boardCode} constituents`);
    const constituents: ConstituentRecord[] = [];
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const record = requireRecord(item, `THS ${category} board ${boardCode} constituent ${index}`);
      const thscode = requireNonEmptyText(record.thscode, `THS ${category} board ${boardCode} constituent ${index} thscode`);
      if (seen.has(thscode)) continue;
      seen.add(thscode);
      constituents.push({
        thscode,
        name: requireNonEmptyText(record.name, `THS ${category} board ${boardCode} constituent ${thscode} name`)
      });
    }
    if (constituents.length === 0) throw new Error(`THS ${category} board ${boardCode} returned no constituents`);
    return constituents;
  }

  private async fetchBatchedSnapshots(
    limiter: RequestLimiter,
    path: string,
    label: string,
    codes: string[]
  ): Promise<BatchedSnapshots> {
    const batches = await Promise.all(chunk(codes, this.snapshotBatchSize).map(async (batchCodes) => {
      const data = await this.requestLimited(limiter, path, { thscodes: batchCodes.join(",") });
      return parseSnapshotBatch(data, label);
    }));
    const changePercentByCode = new Map<string, number | null>();
    for (const batch of batches) {
      for (const record of batch.records) {
        if (changePercentByCode.has(record.thscode)) {
          throw new Error(`THS ${label} snapshot returned duplicate thscode ${record.thscode}`);
        }
        changePercentByCode.set(record.thscode, record.changePercent);
      }
    }
    return { timestamps: batches.map((batch) => batch.timestamp), changePercentByCode };
  }

  private requireConsistentSnapshotTimestamp(timestamps: Array<number | null>, category: MarketCategory): Date {
    if (timestamps.length === 0 || timestamps.some((timestamp) => timestamp === null)) {
      throw new Error(`THS ${category} index snapshot batch is missing data.timestamp`);
    }
    const numericTimestamps = timestamps as number[];
    const oldest = Math.min(...numericTimestamps);
    const newest = Math.max(...numericTimestamps);
    if (newest - oldest > this.snapshotTimestampToleranceMs) {
      throw new Error(
        `THS ${category} index snapshot batches span ${newest - oldest}ms, beyond the ${this.snapshotTimestampToleranceMs}ms tolerance`
      );
    }
    return new Date(newest);
  }

  private requireCompleteIndexCoverage(
    category: MarketCategory,
    catalog: CatalogRecord[],
    changePercentByCode: Map<string, number | null>
  ): Map<string, number> {
    const catalogCodes = new Set(catalog.map((record) => record.thscode));
    for (const code of changePercentByCode.keys()) {
      if (!catalogCodes.has(code)) throw new Error(`THS ${category} index snapshot returned unexpected thscode ${code}`);
    }
    const resolved = new Map<string, number>();
    for (const record of catalog) {
      const changePercent = changePercentByCode.get(record.thscode);
      if (changePercent === undefined) {
        throw new Error(`THS ${category} index snapshot is missing catalog entry ${record.thscode}`);
      }
      if (changePercent === null) {
        throw new Error(`THS ${category} index snapshot has a non-finite change percent for ${record.thscode}`);
      }
      resolved.set(record.thscode, changePercent);
    }
    return resolved;
  }

  private rejectUnknownSnapshotCodes(
    category: MarketCategory,
    label: string,
    requestedCodes: string[],
    changePercentByCode: Map<string, number | null>
  ): void {
    const requested = new Set(requestedCodes);
    for (const code of changePercentByCode.keys()) {
      if (!requested.has(code)) throw new Error(`THS ${category} ${label} snapshot returned unexpected thscode ${code}`);
    }
  }

  private buildSector(
    board: CatalogRecord,
    direction: SortDirection,
    changePercent: number,
    constituents: ConstituentRecord[],
    stockChangePercentByCode: Map<string, number | null>
  ): BoardPerformanceSector {
    let best: { thscode: string; name: string; changePercent: number } | undefined;
    for (const constituent of constituents) {
      const candidateChangePercent = stockChangePercentByCode.get(constituent.thscode);
      if (candidateChangePercent === undefined || candidateChangePercent === null) continue;
      const improves =
        best === undefined ||
        (direction === "gain"
          ? candidateChangePercent > best.changePercent
          : candidateChangePercent < best.changePercent) ||
        (candidateChangePercent === best.changePercent && constituent.thscode < best.thscode);
      if (improves) {
        best = { thscode: constituent.thscode, name: constituent.name, changePercent: candidateChangePercent };
      }
    }
    if (!best) {
      throw new Error(`THS board ${board.name} (${board.thscode}) has no constituent with a usable ${direction} change percent`);
    }
    return {
      code: board.thscode,
      name: board.name,
      changePercent,
      leader: best.name,
      leaderChangePercent: best.changePercent
    };
  }

  private async requestLimited(limiter: RequestLimiter, path: string, params: Record<string, string>): Promise<unknown> {
    await limiter.acquire();
    try {
      return await this.requestApi(path, params);
    } finally {
      limiter.release();
    }
  }

  private async requestApi(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.search = new URLSearchParams(params).toString();
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) await this.waitForRetryBackoff();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          headers: { "X-api-key": this.apiKey, "User-Agent": "qq-market-bot/0.1" },
          signal: controller.signal
        });
        if (response.status === 429) {
          lastError = new Error(`THS ${path} was rate limited with HTTP 429`);
          continue;
        }
        if (!response.ok) {
          if (response.status >= 500) {
            lastError = new Error(`THS ${path} failed with HTTP ${response.status}`);
            continue;
          }
          throw new ThsApiError(`THS ${path} failed with HTTP ${response.status}`);
        }
        const payload: unknown = await response.json();
        const interpreted = interpretEnvelope(path, payload);
        if (interpreted.retryable) {
          lastError = new Error(`THS ${path} returned a retryable response: ${interpreted.reason}`);
          continue;
        }
        return interpreted.data;
      } catch (error) {
        if (error instanceof ThsApiError) throw error;
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`THS ${path} failed after ${this.retries + 1} attempts`, { cause: lastError });
  }

  private async waitForRetryBackoff(): Promise<void> {
    if (this.retryBackoffMs <= 0) return;
    const delayMs = this.retryBackoffMs + Math.random() * this.retryBackoffMs;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function interpretEnvelope(
  path: string,
  payload: unknown
): { retryable: true; reason: string } | { retryable: false; data: unknown } {
  if (!isRecord(payload) || typeof payload.code !== "number") {
    return { retryable: true, reason: "malformed response envelope" };
  }
  if (payload.code === 0) return { retryable: false, data: payload.data };
  const requestId = typeof payload.request_id === "string" ? payload.request_id : "unknown";
  const upstreamMessage = typeof payload.message === "string" ? payload.message : "no message";
  if (AUTH_FAILURE_CODES.has(payload.code)) {
    throw new ThsApiError(`THS ${path} rejected the API key (code=${payload.code}, request_id=${requestId})`);
  }
  if (payload.code === RATE_LIMIT_CODE || RETRYABLE_BUSINESS_CODES.has(payload.code)) {
    return { retryable: true, reason: `code=${payload.code} (${upstreamMessage}, request_id=${requestId})` };
  }
  throw new ThsApiError(`THS ${path} returned business error code=${payload.code}: ${upstreamMessage} (request_id=${requestId})`);
}

function parseSnapshotBatch(data: unknown, label: string): SnapshotBatch {
  const record = requireRecord(data, `THS ${label} snapshot data`);
  const timestamp =
    record.timestamp === null
      ? null
      : requireFiniteNumber(record.timestamp, `THS ${label} snapshot timestamp`);
  const items = requireArrayField(record, "item", `THS ${label} snapshot`);
  const records = items.map((item, index) => {
    const snapshot = requireRecord(item, `THS ${label} snapshot record ${index}`);
    return {
      thscode: requireNonEmptyText(snapshot.thscode, `THS ${label} snapshot record ${index} thscode`),
      changePercent:
        snapshot.price_change_ratio_pct === null
          ? null
          : requireFiniteNumber(snapshot.price_change_ratio_pct, `THS ${label} snapshot record ${index} change percent`)
    };
  });
  return { timestamp, records };
}

function rankCatalogEntries(
  category: MarketCategory,
  catalog: CatalogRecord[],
  changePercentByCode: Map<string, number>
): RankedSectors {
  if (catalog.length < BOARD_PERFORMANCE_TOP_COUNT * 2) {
    throw new Error(
      `THS ${category} catalog has only ${catalog.length} indices, ${BOARD_PERFORMANCE_TOP_COUNT * 2} are required`
    );
  }
  const entries = catalog.map((record) => ({ ...record, changePercent: changePercentByCode.get(record.thscode) ?? 0 }));
  const gain = [...entries]
    .sort((a, b) => b.changePercent - a.changePercent || compareThscodes(a.thscode, b.thscode))
    .slice(0, BOARD_PERFORMANCE_TOP_COUNT);
  const loss = [...entries]
    .sort((a, b) => a.changePercent - b.changePercent || compareThscodes(a.thscode, b.thscode))
    .slice(0, BOARD_PERFORMANCE_TOP_COUNT);
  const gainCodes = new Set(gain.map((record) => record.thscode));
  if (loss.some((record) => gainCodes.has(record.thscode))) {
    throw new Error(`THS ${category} gain and loss rankings overlap`);
  }
  return {
    gain: gain.map(({ thscode, name }) => ({ thscode, name })),
    loss: loss.map(({ thscode, name }) => ({ thscode, name }))
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function compareThscodes(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function requireArrayField(value: unknown, field: string, label: string): unknown[] {
  const record = requireRecord(value, label);
  const fieldValue = record[field];
  if (!Array.isArray(fieldValue)) throw new Error(`Invalid ${label} ${field}`);
  return fieldValue;
}

function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
}

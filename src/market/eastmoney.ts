/**
 * 东方财富 A 股行业板块数据源。
 *
 * 接口：GET https://push2delay.eastmoney.com/api/qt/clist/get
 * 参数：fs=m:90+t:2 为行业板块；字段 f12 代码 / f14 名称 / f3 涨跌幅 / f6 成交额 / f124 行情时间戳。
 *
 * 说明：
 * - 接口属于公开网页行情接口，无稳定性保证；MVP 不接备用数据源。
 * - 单页最多约 100 条，需要分页取全量。
 * - 不依赖接口排序，统一在本地按成交额降序排序。
 */
import { z } from 'zod';
import { describeError, type Logger } from '../logger.js';
import { MemoryCache } from './cache.js';
import type { MarketBlock, MarketProvider, MarketSnapshot } from './types.js';

export const EASTMONEY_SOURCE = '东方财富';
export const EASTMONEY_CLIST_URL = 'https://push2delay.eastmoney.com/api/qt/clist/get';
export const INDUSTRY_FS = 'm:90+t:2';
export const MAX_TOP_BLOCKS = 25;

const FIELDS = 'f12,f14,f3,f6,f124';

const diffSchema = z.object({
  f12: z.union([z.string(), z.number()]),
  f14: z.string(),
  f3: z.union([z.number(), z.string()]).optional(),
  f6: z.union([z.number(), z.string()]).optional(),
  f124: z.union([z.number(), z.string()]).optional(),
});

const responseSchema = z.object({
  rc: z.number().optional(),
  data: z
    .object({
      total: z.number().optional(),
      diff: z.union([z.array(diffSchema), z.record(z.string(), diffSchema)]).optional(),
    })
    .nullable()
    .optional(),
});

export type RawIndustryRow = z.infer<typeof diffSchema>;

export interface EastmoneyProviderOptions {
  logger: Logger;
  /** 短时缓存 TTL，默认 60 秒；传 0 关闭缓存 */
  cacheTtlMs?: number;
  /** 每页条数，默认 100 */
  pageSize?: number;
  /** 最大页数保护，默认 10 */
  maxPages?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  baseUrl?: string;
}

export class EastmoneyIndustryProvider implements MarketProvider {
  private readonly logger: Logger;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly cache: MemoryCache<MarketSnapshot> | null;

  constructor(options: EastmoneyProviderOptions) {
    this.logger = options.logger.child('eastmoney');
    this.pageSize = options.pageSize ?? 100;
    this.maxPages = options.maxPages ?? 10;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.baseUrl = options.baseUrl ?? EASTMONEY_CLIST_URL;
    const ttl = options.cacheTtlMs ?? 60_000;
    this.cache =
      ttl > 0
        ? new MemoryCache<MarketSnapshot>({ ttlMs: ttl, ...(options.now ? { now: options.now } : {}) })
        : null;
  }

  async getIndustrySnapshot(): Promise<MarketSnapshot> {
    if (this.cache) {
      return this.cache.getOrLoad('industry', () => this.loadSnapshot());
    }
    return this.loadSnapshot();
  }

  /** 拉取全量行业板块并按成交额降序排序。 */
  async loadSnapshot(): Promise<MarketSnapshot> {
    const rows: RawIndustryRow[] = [];
    let total: number | null = null;

    for (let page = 1; page <= this.maxPages; page += 1) {
      const response = await this.fetchPage(page);
      const parsed = responseSchema.safeParse(response);
      if (!parsed.success) {
        throw new Error(`东方财富接口响应结构异常：${JSON.stringify(response).slice(0, 300)}`);
      }
      const data = parsed.data.data;
      if (!data) {
        throw new Error('东方财富接口未返回 data 字段（可能是接口变更或限流）');
      }
      total = data.total ?? total;
      const pageRows = normalizeDiff(data.diff);
      rows.push(...pageRows);
      if (pageRows.length === 0) break;
      if (total !== null && rows.length >= total) break;
      if (pageRows.length < this.pageSize) break;
    }

    if (rows.length === 0) {
      throw new Error('东方财富行业板块返回空数据');
    }

    const blocks = normalizeIndustryRows(rows);
    if (blocks.length === 0) {
      throw new Error('东方财富行业板块数据全部无效（成交额缺失或非正数）');
    }

    const quoteTimestamp = blocks.reduce<number | null>((acc, block) => {
      if (block.quoteTimestamp === null) return acc;
      if (acc === null || block.quoteTimestamp > acc) return block.quoteTimestamp;
      return acc;
    }, null);

    const snapshot: MarketSnapshot = {
      market: 'A股',
      source: EASTMONEY_SOURCE,
      quoteTime: quoteTimestamp === null ? null : new Date(quoteTimestamp * 1000),
      fetchedAt: new Date(),
      blocks,
    };

    this.logger.info(
      `获取行业板块 ${blocks.length} 个（原始 ${rows.length} 条，total=${total ?? '未知'}），` +
        `最高成交额=${blocks[0]?.name ?? '-'}`,
    );
    return snapshot;
  }

  private async fetchPage(page: number): Promise<unknown> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('pn', String(page));
    url.searchParams.set('pz', String(this.pageSize));
    url.searchParams.set('po', '1');
    url.searchParams.set('np', '1');
    url.searchParams.set('fltt', '2');
    url.searchParams.set('invt', '2');
    url.searchParams.set('fid', 'f6');
    url.searchParams.set('fs', INDUSTRY_FS);
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('_', String(Date.now()));

    this.logger.debug(`请求第 ${page} 页：${url.toString()}`);
    const response = await this.fetchImpl(url.toString(), {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://quote.eastmoney.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`东方财富接口 HTTP ${response.status}`);
    }
    return response.json();
  }
}

/** diff 可能是数组，也可能是以序号为键的对象，统一转成数组。 */
export function normalizeDiff(
  diff: RawIndustryRow[] | Record<string, RawIndustryRow> | undefined,
): RawIndustryRow[] {
  if (!diff) return [];
  if (Array.isArray(diff)) return diff;
  return Object.values(diff);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === '-') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 归一化并过滤：
 * - 过滤成交额缺失、非数字或 <= 0 的板块
 * - 过滤名称为空
 * - 按成交额 f6 降序排序
 */
export function normalizeIndustryRows(rows: RawIndustryRow[]): MarketBlock[] {
  const blocks: MarketBlock[] = [];
  for (const row of rows) {
    const name = typeof row.f14 === 'string' ? row.f14.trim() : '';
    if (name.length === 0) continue;
    const code = String(row.f12 ?? '').trim();
    if (code.length === 0) continue;

    const turnover = toFiniteNumber(row.f6);
    if (turnover === null || turnover <= 0) continue;

    const changePercent = toFiniteNumber(row.f3) ?? 0;
    const quoteTimestamp = toFiniteNumber(row.f124);

    blocks.push({ code, name, changePercent, turnover, quoteTimestamp });
  }
  blocks.sort((a, b) => b.turnover - a.turnover);
  return blocks;
}

/** 取成交额排名前 n 的板块。 */
export function takeTopBlocks(blocks: MarketBlock[], limit = MAX_TOP_BLOCKS): MarketBlock[] {
  if (limit <= 0) return [];
  return blocks.slice(0, limit);
}

/** 安全包装：数据源失败时返回错误信息而不是抛出。 */
export async function tryLoadSnapshot(
  provider: MarketProvider,
  logger: Logger,
): Promise<{ ok: true; snapshot: MarketSnapshot } | { ok: false; error: string }> {
  try {
    return { ok: true, snapshot: await provider.getIndustrySnapshot() };
  } catch (error) {
    logger.error(`行情数据获取失败：${describeError(error)}`);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

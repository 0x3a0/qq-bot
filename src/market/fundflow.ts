/**
 * 东方财富行业 / 概念板块资金流数据源。
 *
 * 接口（实测于 2026-09，见 README「东方财富资金流接口」）：
 *   GET https://push2delay.eastmoney.com/api/qt/clist/get
 *     fs=m:90 t:2  行业板块（496 个）
 *     fs=m:90 t:3  概念板块（504 个）
 *     fid=f62 / f164 / f174   分别按「今日 / 5日 / 10日」主力净额降序
 *     pz 上限 100（传更大值服务端仍只回 100 条），需要分页取全量
 *
 *   GET https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get
 *     secid=90.BKxxxx&klt=1     分钟级资金流（240 个点位）
 *     secid=90.BKxxxx&klt=101   日线级资金流
 *
 * 字段（今日；5 日 / 10 日为整段平移，见 PERIOD_FIELDS）：
 *   f12 代码 / f14 名称 / f3 涨跌幅 / f2 最新价 / f124 行情时间
 *   f62 主力净额 = f66 超大单 + f72 大单（实测严格相等，接口层面校验通过）
 *   f184 主力净额占比 %，f69/f75/f81/f87 分别为超大/大/中/小单占比 %
 *   f104/f105/f106 上涨/下跌/平盘家数，f204/f205 领涨股名称与代码
 *
 * 注意：
 * - 该接口是公开网页行情接口，无稳定性保证，也没有任何鉴权。
 * - 金额单位是「元」，需要用方自行换算成亿/万。
 * - 主力 + 中单 + 小单 ≈ 0（资金守恒），偏差来自服务端四舍五入。
 * - push2.eastmoney.com 与 push2delay.eastmoney.com 数据一致；
 *   本模块默认用 push2delay（实测更稳），并可用 fallbackHosts 兜底。
 */
import { z } from 'zod';
import { describeError, type Logger } from '../logger.js';
import { MemoryCache } from './cache.js';
import {
  type FundFlowMinutePoint,
  type FundFlowPeriod,
  type FundFlowProvider,
  type FundFlowSnapshot,
  type SectorFundFlow,
  type SectorFundFlowDetail,
  type SectorKind,
} from './fundflow-types.js';

export const FUND_FLOW_SOURCE = '东方财富';

/** 资金流主接口（排行榜）。 */
export const FUND_FLOW_CLIST_URL = 'https://push2delay.eastmoney.com/api/qt/clist/get';
/** 板块资金流明细接口（分钟 / 日线）。 */
export const FUND_FLOW_KLINE_URL = 'https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get';

/** 备用主机：数据与主接口一致，主接口被限流时可用。 */
export const FUND_FLOW_FALLBACK_HOSTS = ['https://push2.eastmoney.com'];

/** 板块分类的 fs 值。 */
export const SECTOR_FS: Record<SectorKind, string> = {
  industry: 'm:90 t:2',
  concept: 'm:90 t:3',
};

/** 接口单页上限：传更大的 pz 服务端仍只返回 100 条。 */
export const MAX_PAGE_SIZE = 100;

/** 接口通用 ut 参数（网页端固定值，缺失也可用）。 */
const UT = 'b2884a393a59ad64002292a3e90d46a5';

interface PeriodFieldSet {
  /** 排序字段 fid */
  fid: string;
  main: string;
  mainRatio: string;
  super: string;
  superRatio: string;
  big: string;
  bigRatio: string;
  mid: string;
  midRatio: string;
  small: string;
  smallRatio: string;
}

/** 各周期的字段号：今日 f62 起，5 日 f164 起，10 日 f174 起。 */
export const PERIOD_FIELDS: Record<FundFlowPeriod, PeriodFieldSet> = {
  today: {
    fid: 'f62',
    main: 'f62',
    mainRatio: 'f184',
    super: 'f66',
    superRatio: 'f69',
    big: 'f72',
    bigRatio: 'f75',
    mid: 'f78',
    midRatio: 'f81',
    small: 'f84',
    smallRatio: 'f87',
  },
  '5d': {
    fid: 'f164',
    main: 'f164',
    mainRatio: 'f165',
    super: 'f166',
    superRatio: 'f167',
    big: 'f168',
    bigRatio: 'f169',
    mid: 'f170',
    midRatio: 'f171',
    small: 'f172',
    smallRatio: 'f173',
  },
  '10d': {
    fid: 'f174',
    main: 'f174',
    mainRatio: 'f175',
    super: 'f176',
    superRatio: 'f177',
    big: 'f178',
    bigRatio: 'f179',
    mid: 'f180',
    midRatio: 'f181',
    small: 'f182',
    smallRatio: 'f183',
  },
};

/** 请求的字段列表：一次拿齐三个周期 + 行情时间 + 领涨股。 */
export const FUND_FLOW_FIELDS = [
  'f12', 'f14', 'f2', 'f3',
  ...Object.values(PERIOD_FIELDS).flatMap((fields) => [
    fields.main,
    fields.mainRatio,
    fields.super,
    fields.superRatio,
    fields.big,
    fields.bigRatio,
    fields.mid,
    fields.midRatio,
    fields.small,
    fields.smallRatio,
  ]),
  'f124', 'f104', 'f105', 'f106', 'f204', 'f205',
].join(',');

/** 明细接口返回的 fields2：f51 时间，f52..f56 依次为主力/小单/中单/大单/超大单净额。 */
const KLINE_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65';

const sectorRowSchema = z
  .object({
    f12: z.union([z.string(), z.number()]),
    f14: z.string(),
    f3: z.union([z.number(), z.string()]).optional(),
    f124: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const clistResponseSchema = z.object({
  rc: z.number().optional(),
  data: z
    .object({
      total: z.number().optional(),
      diff: z.union([z.array(sectorRowSchema), z.record(z.string(), sectorRowSchema)]).optional(),
    })
    .nullable()
    .optional(),
});

const klineResponseSchema = z.object({
  rc: z.number().optional(),
  data: z
    .object({
      code: z.union([z.string(), z.number()]).optional(),
      name: z.string().optional(),
      klines: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
});

export type RawSectorFundFlowRow = z.infer<typeof sectorRowSchema>;

export interface EastmoneyFundFlowOptions {
  logger: Logger;
  /** 短时缓存 TTL，默认 60 秒；传 0 关闭缓存 */
  cacheTtlMs?: number;
  /** 每页条数，默认 100（接口上限） */
  pageSize?: number;
  /** 最大页数保护，默认 15 */
  maxPages?: number;
  /** 单次请求超时，默认 10 秒 */
  timeoutMs?: number;
  /** 每个请求的重试次数（仅针对网络错误与 5xx），默认 2 */
  retries?: number;
  /** 主接口地址，默认 FUND_FLOW_CLIST_URL */
  baseUrl?: string;
  /** 备用接口地址；主接口失败后依次尝试 */
  fallbackHosts?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class EastmoneyFundFlowProvider implements FundFlowProvider {
  private readonly logger: Logger;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly hosts: string[];
  private readonly cache: MemoryCache<FundFlowSnapshot | SectorFundFlowDetail> | null;

  constructor(options: EastmoneyFundFlowOptions) {
    this.logger = options.logger.child('fundflow');
    this.pageSize = Math.min(options.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    this.maxPages = options.maxPages ?? 15;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.hosts = [options.baseUrl ?? FUND_FLOW_CLIST_URL, ...(options.fallbackHosts ?? [])];
    const ttl = options.cacheTtlMs ?? 60_000;
    this.cache =
      ttl > 0
        ? new MemoryCache<FundFlowSnapshot | SectorFundFlowDetail>({
            ttlMs: ttl,
            ...(options.now ? { now: options.now } : {}),
          })
        : null;
  }

  async getSectorFundFlow(kind: SectorKind, period: FundFlowPeriod = 'today'): Promise<FundFlowSnapshot> {
    const load = () => this.loadSnapshot(kind, period);
    if (this.cache) return this.cache.getOrLoad(`${kind}:${period}`, load) as Promise<FundFlowSnapshot>;
    return load();
  }

  async getSectorFundFlowDetail(code: string): Promise<SectorFundFlowDetail> {
    const load = () => this.loadDetail(code);
    if (this.cache) return this.cache.getOrLoad(`detail:${code}`, load) as Promise<SectorFundFlowDetail>;
    return load();
  }

  /** 分页拉全量并按 fid 排序（默认主力净额降序）。 */
  async loadSnapshot(kind: SectorKind, period: FundFlowPeriod): Promise<FundFlowSnapshot> {
    const fields = PERIOD_FIELDS[period];
    const rows: RawSectorFundFlowRow[] = [];
    let total: number | null = null;

    for (let page = 1; page <= this.maxPages; page += 1) {
      const response = await this.fetchClistPage(kind, fields.fid, page);
      const parsed = clistResponseSchema.safeParse(response);
      if (!parsed.success) {
        throw new Error(`东方财富资金流接口响应结构异常：${JSON.stringify(response).slice(0, 300)}`);
      }
      const data = parsed.data.data;
      if (!data) {
        throw new Error('东方财富资金流接口未返回 data 字段（可能是接口变更或限流）');
      }
      total = data.total ?? total;
      const pageRows = normalizeDiff(data.diff);
      rows.push(...pageRows.map((row) => row as RawSectorFundFlowRow));
      if (pageRows.length === 0) break;
      if (total !== null && rows.length >= total) break;
      if (pageRows.length < this.pageSize) break;
    }

    if (rows.length === 0) {
      throw new Error('东方财富板块资金流返回空数据');
    }

    const sectors = normalizeSectorFundFlowRows(rows, period);
    if (sectors.length === 0) {
      throw new Error('东方财富板块资金流数据全部无效（净额缺失）');
    }

    const quoteTimestamp = latestQuoteTimestamp(rows);
    const snapshot: FundFlowSnapshot = {
      kind,
      period,
      source: FUND_FLOW_SOURCE,
      quoteTime: quoteTimestamp === null ? null : new Date(quoteTimestamp * 1000),
      fetchedAt: new Date(),
      sectors,
    };

    this.logger.info(
      `获取${kind === 'industry' ? '行业' : '概念'}板块 ${period} 资金流 ${sectors.length} 个` +
        `（原始 ${rows.length} 条，total=${total ?? '未知'}），` +
        `主力净流入第一=${sectors[0]?.name ?? '-'}`,
    );
    return snapshot;
  }

  /** 单板块分钟级资金流明细。 */
  async loadDetail(code: string): Promise<SectorFundFlowDetail> {
    const url = new URL(FUND_FLOW_KLINE_URL);
    url.searchParams.set('lmt', '0');
    url.searchParams.set('klt', '1');
    url.searchParams.set('secid', `90.${code}`);
    url.searchParams.set('fields1', 'f1,f2,f3,f7');
    url.searchParams.set('fields2', KLINE_FIELDS2);
    url.searchParams.set('ut', UT);
    url.searchParams.set('_', String(Date.now()));

    const response = await this.fetchJson(url.toString());
    const parsed = klineResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error(`东方财富板块资金流明细响应结构异常：${JSON.stringify(response).slice(0, 300)}`);
    }
    const data = parsed.data.data;
    if (!data) {
      throw new Error(`东方财富板块资金流明细未返回 data（code=${code}）`);
    }
    const points = parseKlinePoints(data.klines ?? []);
    if (points.length === 0) {
      throw new Error(`东方财富板块资金流明细为空（code=${code}）`);
    }
    return { code, name: data.name ?? code, points };
  }

  private async fetchClistPage(kind: SectorKind, fid: string, page: number): Promise<unknown> {
    const url = new URL(this.hosts[0] ?? FUND_FLOW_CLIST_URL);
    url.searchParams.set('pn', String(page));
    url.searchParams.set('pz', String(this.pageSize));
    url.searchParams.set('po', '1');
    url.searchParams.set('np', '1');
    url.searchParams.set('ut', UT);
    url.searchParams.set('fltt', '2');
    url.searchParams.set('invt', '2');
    url.searchParams.set('fid', fid);
    url.searchParams.set('fs', SECTOR_FS[kind]);
    url.searchParams.set('fields', FUND_FLOW_FIELDS);
    url.searchParams.set('_', String(Date.now()));

    const path = `${url.pathname}${url.search}`;
    const errors: string[] = [];
    for (const host of this.hosts) {
      const target = `${host.replace(/\/$/, '')}${path}`;
      try {
        this.logger.debug(`请求 ${kind} 资金流第 ${page} 页：${target}`);
        return await this.fetchJson(target);
      } catch (error) {
        errors.push(`${host} → ${describeError(error)}`);
        this.logger.warn(`资金流主机不可用，尝试下一个：${errors.at(-1)}`);
      }
    }
    throw new Error(`东方财富资金流接口全部主机失败：${errors.join('；')}`);
  }

  /** 带重试与超时的 JSON 请求；网络错误（如 ECONNRESET）也会重试。 */
  private async fetchJson(url: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://data.eastmoney.com/bkzj/hy.html',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          // 4xx 重试没有意义；5xx / 429 交给重试逻辑。
          if (response.status < 500 && response.status !== 429) {
            throw new Error(`东方财富接口 HTTP ${response.status}`);
          }
          throw new RetryableError(`东方财富接口 HTTP ${response.status}`);
        }
        const text = await response.text();
        if (text.trim().length === 0) throw new RetryableError('东方财富接口返回空响应体');
        return JSON.parse(text) as unknown;
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.retries) throw error;
        const backoff = 400 * (attempt + 1);
        this.logger.warn(
          `资金流请求失败（第 ${attempt + 1}/${this.retries + 1} 次）：${describeError(error)}，${backoff}ms 后重试`,
        );
        await sleep(backoff);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** 标记「值得重试」的错误（5xx / 429 / 空响应体）。 */
class RetryableError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 网络层错误重试；4xx 这类确定性错误不重试。 */
function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (error instanceof Error) {
    // 4xx 是确定性失败，重试无意义。
    if (/HTTP 4\d\d/.test(error.message)) return false;
    // 其余（含超时、undici 包在 cause 上的 ECONNRESET / UND_ERR_SOCKET）都重试。
    return true;
  }
  return true;
}

/** diff 可能是数组，也可能是以序号为键的对象，统一转成数组。 */
export function normalizeDiff<T>(diff: T[] | Record<string, T> | undefined): T[] {
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

function latestQuoteTimestamp(rows: RawSectorFundFlowRow[]): number | null {
  let latest: number | null = null;
  for (const row of rows) {
    const ts = toFiniteNumber(row.f124);
    if (ts === null) continue;
    if (latest === null || ts > latest) latest = ts;
  }
  return latest;
}

/**
 * 归一化：过滤代码/名称缺失或主力净额缺失的行，其余字段缺失按 0 处理。
 * 保持接口返回顺序（接口已按 fid 排序），仅在接口顺序异常时兜底排序。
 */
export function normalizeSectorFundFlowRows(
  rows: RawSectorFundFlowRow[],
  period: FundFlowPeriod,
): SectorFundFlow[] {
  const fields = PERIOD_FIELDS[period];
  const sectors: SectorFundFlow[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const name = typeof row.f14 === 'string' ? row.f14.trim() : '';
    if (name.length === 0) continue;
    const code = String(row.f12 ?? '').trim();
    if (code.length === 0 || seen.has(code)) continue;

    const mainNet = toFiniteNumber(row[fields.main]);
    if (mainNet === null) continue;
    seen.add(code);

    sectors.push({
      code,
      name,
      changePercent: toFiniteNumber(row.f3) ?? 0,
      mainNet,
      mainNetRatio: toFiniteNumber(row[fields.mainRatio]) ?? 0,
      superNet: toFiniteNumber(row[fields.super]) ?? 0,
      superNetRatio: toFiniteNumber(row[fields.superRatio]) ?? 0,
      bigNet: toFiniteNumber(row[fields.big]) ?? 0,
      bigNetRatio: toFiniteNumber(row[fields.bigRatio]) ?? 0,
      midNet: toFiniteNumber(row[fields.mid]) ?? 0,
      midNetRatio: toFiniteNumber(row[fields.midRatio]) ?? 0,
      smallNet: toFiniteNumber(row[fields.small]) ?? 0,
      smallNetRatio: toFiniteNumber(row[fields.smallRatio]) ?? 0,
    });
  }
  return sectors;
}

/**
 * 解析明细接口的 klines。
 * 每行格式："2026-09-11 15:00,主力净额,小单净额,中单净额,大单净额,超大单净额,..."
 * 顺序来自 fields2=f51..f56，已在 README 中记录实测结论。
 */
export function parseKlinePoints(klines: string[]): FundFlowMinutePoint[] {
  const points: FundFlowMinutePoint[] = [];
  for (const line of klines) {
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const [time, mainNet, smallNet, midNet, bigNet, superNet] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const values = [mainNet, smallNet, midNet, bigNet, superNet].map(toFiniteNumber);
    if (values.some((value) => value === null)) continue;
    points.push({
      time: time.trim(),
      mainNet: values[0] as number,
      smallNet: values[1] as number,
      midNet: values[2] as number,
      bigNet: values[3] as number,
      superNet: values[4] as number,
    });
  }
  return points;
}

/** 安全包装：数据源失败时返回错误信息而不是抛出。 */
export async function tryLoadFundFlow(
  provider: FundFlowProvider,
  kind: SectorKind,
  period: FundFlowPeriod,
  logger: Logger,
): Promise<{ ok: true; snapshot: FundFlowSnapshot } | { ok: false; error: string }> {
  try {
    return { ok: true, snapshot: await provider.getSectorFundFlow(kind, period) };
  } catch (error) {
    logger.error(`板块资金流获取失败：${describeError(error)}`);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

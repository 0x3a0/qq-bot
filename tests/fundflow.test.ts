import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import {
  EastmoneyFundFlowProvider,
  FUND_FLOW_FIELDS,
  MAX_PAGE_SIZE,
  PERIOD_FIELDS,
  SECTOR_FS,
  normalizeDiff,
  normalizeSectorFundFlowRows,
  parseKlinePoints,
} from '../src/market/fundflow.js';
import { takeTopByMainNet } from '../src/market/fundflow-types.js';

const logger = createLogger('test:fundflow');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

/** 构造一行「今日」资金流原始数据。 */
function row(
  code: string,
  name: string,
  mainNet: number,
  {
    changePercent = 1,
    quoteTs = 1_789_112_372,
    superNet = mainNet * 0.8,
    bigNet = mainNet * 0.2,
  }: { changePercent?: number; quoteTs?: number; superNet?: number; bigNet?: number } = {},
) {
  const mid = -mainNet * 0.5;
  const small = -(mainNet + mid);
  return {
    f12: code,
    f14: name,
    f2: 1000,
    f3: changePercent,
    f124: quoteTs,
    // 今日
    f62: mainNet,
    f184: 1.5,
    f66: superNet,
    f69: 1.2,
    f72: bigNet,
    f75: 0.3,
    f78: mid,
    f81: -0.8,
    f84: small,
    f87: -0.7,
    // 5 日：净额 = 今日的 5 倍，便于断言周期切换真的换了字段
    f164: mainNet * 5,
    f165: 2.5,
    f166: superNet * 5,
    f167: 2.2,
    f168: bigNet * 5,
    f169: 0.3,
    f170: mid * 5,
    f171: -1.8,
    f172: small * 5,
    f173: -0.7,
    // 10 日：净额 = 今日的 10 倍
    f174: mainNet * 10,
    f175: 3.5,
    f176: superNet * 10,
    f177: 3.2,
    f178: bigNet * 10,
    f179: 0.3,
    f180: mid * 10,
    f181: -2.8,
    f182: small * 10,
    f183: -0.7,
    f104: 38,
    f105: 52,
    f106: 1,
    f204: '中际旭创',
    f205: '300308',
  };
}

function clistResponse(rows: unknown[], total = rows.length): Response {
  return new Response(JSON.stringify({ rc: 0, data: { total, diff: rows } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function klineResponse(name: string, klines: string[]): Response {
  return new Response(JSON.stringify({ rc: 0, data: { code: 'BK0448', name, klines } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('normalizeDiff', () => {
  it('支持数组形式', () => {
    expect(normalizeDiff([row('BK1', 'A', 1)])).toHaveLength(1);
  });

  it('支持以序号为键的对象形式', () => {
    expect(normalizeDiff({ '0': row('BK1', 'A', 1), '1': row('BK2', 'B', 1) })).toHaveLength(2);
  });

  it('undefined 返回空数组', () => {
    expect(normalizeDiff(undefined)).toEqual([]);
  });
});

describe('normalizeSectorFundFlowRows', () => {
  it('按周期取对应字段（今日 / 5日 / 10日）', () => {
    const rows = [row('BK0448', '通信设备', 4_741_400_064)];
    const today = normalizeSectorFundFlowRows(rows, 'today')[0];
    const five = normalizeSectorFundFlowRows(rows, '5d')[0];
    const ten = normalizeSectorFundFlowRows(rows, '10d')[0];

    expect(today?.mainNet).toBe(4_741_400_064);
    expect(today?.mainNetRatio).toBe(1.5);
    expect(five?.mainNet).toBe(4_741_400_064 * 5);
    expect(five?.mainNetRatio).toBe(2.5);
    expect(ten?.mainNet).toBe(4_741_400_064 * 10);
    expect(ten?.mainNetRatio).toBe(3.5);
  });

  it('主力 = 超大单 + 大单', () => {
    const sector = normalizeSectorFundFlowRows([row('BK1', '板块', 1e8)], 'today')[0];
    expect(sector?.mainNet).toBe((sector?.superNet ?? 0) + (sector?.bigNet ?? 0));
  });

  it('过滤代码/名称缺失或主力净额缺失的行', () => {
    const sectors = normalizeSectorFundFlowRows(
      [
        row('BK1', '正常', 1e8),
        { ...row('BK2', '主力缺失', 0), f62: '-' },
        { ...row('BK3', '主力非数字', 0), f62: 'abc' },
        { ...row('', '代码为空', 1e8) },
        { ...row('BK4', '', 1e8) },
      ],
      'today',
    );
    expect(sectors.map((sector) => sector.code)).toEqual(['BK1']);
  });

  it('按代码去重，保留首次出现', () => {
    const sectors = normalizeSectorFundFlowRows(
      [row('BK1', '第一次', 1e8), row('BK1', '重复', 9e8)],
      'today',
    );
    expect(sectors).toHaveLength(1);
    expect(sectors[0]?.name).toBe('第一次');
  });

  it('涨跌幅与占比缺失时按 0 处理，字符串数值可解析', () => {
    const sectors = normalizeSectorFundFlowRows(
      [{ f12: 'BK1', f14: '板块', f62: '12345678' }],
      'today',
    );
    expect(sectors[0]?.mainNet).toBe(12_345_678);
    expect(sectors[0]?.changePercent).toBe(0);
    expect(sectors[0]?.mainNetRatio).toBe(0);
    expect(sectors[0]?.superNet).toBe(0);
  });

  it('保留接口顺序，不重排（接口已按 fid 排序）', () => {
    const sectors = normalizeSectorFundFlowRows(
      [row('BK1', '小', 1e8), row('BK2', '大', 9e8), row('BK3', '中', 5e8)],
      'today',
    );
    expect(sectors.map((sector) => sector.code)).toEqual(['BK1', 'BK2', 'BK3']);
  });
});

describe('takeTopByMainNet', () => {
  const sectors = normalizeSectorFundFlowRows(
    [row('BK1', '小', 1e8), row('BK2', '大', 9e8), row('BK3', '中', 5e8)],
    'today',
  );

  it('按主力净额降序取前 n 名', () => {
    expect(takeTopByMainNet(sectors, 2).map((sector) => sector.name)).toEqual(['大', '中']);
  });

  it('limit 非正数返回空数组', () => {
    expect(takeTopByMainNet(sectors, 0)).toEqual([]);
    expect(takeTopByMainNet(sectors, -1)).toEqual([]);
  });

  it('不修改原数组', () => {
    const before = sectors.map((sector) => sector.code);
    takeTopByMainNet(sectors, 3);
    expect(sectors.map((sector) => sector.code)).toEqual(before);
  });
});

describe('parseKlinePoints', () => {
  it('按 f51..f56 顺序解析出主力/小单/中单/大单/超大单', () => {
    const points = parseKlinePoints([
      '2026-09-11 09:31,1000,100,-300,-200,900',
      '2026-09-11 15:00,4741400325.0,776177089.0,-5434456943.0,650211015.0,4091189310.0',
    ]);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      time: '2026-09-11 09:31',
      mainNet: 1000,
      smallNet: 100,
      midNet: -300,
      bigNet: -200,
      superNet: 900,
    });
    expect(points[1]?.mainNet).toBe(4_741_400_325);
    expect(points[1]?.superNet).toBe(4_091_189_310);
  });

  it('跳过字段不足或非法数值的行', () => {
    const points = parseKlinePoints(['2026-09-11 09:31,1,2', 'bad', '2026-09-11 09:32,-,-,-,-,-']);
    expect(points).toEqual([]);
  });

  it('空数组返回空结果', () => {
    expect(parseKlinePoints([])).toEqual([]);
  });
});

describe('EastmoneyFundFlowProvider', () => {
  it('行业 / 概念使用不同的 fs，参数符合接口约定', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      seen.push(parsed.searchParams.get('fs') ?? '');
      expect(parsed.searchParams.get('pz')).toBe('100');
      expect(parsed.searchParams.get('po')).toBe('1');
      expect(parsed.searchParams.get('fltt')).toBe('2');
      expect(parsed.searchParams.get('invt')).toBe('2');
      expect(parsed.searchParams.get('ut')).toBe('b2884a393a59ad64002292a3e90d46a5');
      return clistResponse([row('BK1', '板块', 1e8)]);
    });
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.getSectorFundFlow('industry');
    await provider.getSectorFundFlow('concept');
    expect(seen).toEqual([SECTOR_FS.industry, SECTOR_FS.concept]);
    expect(seen[0]).toBe('m:90 t:2');
    expect(seen[1]).toBe('m:90 t:3');
  });

  it('排序字段随周期切换：fid = f62 / f164 / f174', async () => {
    const fids: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      fids.push(new URL(String(url)).searchParams.get('fid') ?? '');
      return clistResponse([row('BK1', '板块', 1e8)]);
    });
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.getSectorFundFlow('industry', 'today');
    await provider.getSectorFundFlow('industry', '5d');
    await provider.getSectorFundFlow('industry', '10d');
    expect(fids).toEqual(['f62', 'f164', 'f174']);
  });

  it('请求字段包含三个周期的净额与占比（f62/f164/f174 及占比）', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => clistResponse([row('BK1', '板块', 1e8)]));
    const fields = FUND_FLOW_FIELDS.split(',');
    expect(fields).toContain('f12');
    expect(fields).toContain('f14');
    expect(fields).toContain('f3');
    expect(fields).toContain('f124');
    expect(fields).toContain('f204');
    for (const period of ['today', '5d', '10d'] as const) {
      const set = PERIOD_FIELDS[period];
      for (const key of ['main', 'mainRatio', 'super', 'superRatio', 'big', 'bigRatio', 'mid', 'midRatio', 'small', 'smallRatio'] as const) {
        expect(fields, `${period}.${key}`).toContain(set[key]);
      }
    }

    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.getSectorFundFlow('industry');
    const requested = new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get('fields');
    expect(requested).toBe(FUND_FLOW_FIELDS);
  });

  it('分页取全量直到 total', async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => row(`P1-${index}`, `板块${index}`, (100 - index) * 1e7));
    const page2 = Array.from({ length: 20 }, (_, index) => row(`P2-${index}`, `次页${index}`, (20 - index) * 1e7));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      return parsed.searchParams.get('pn') === '1' ? clistResponse(page1, 120) : clistResponse(page2, 120);
    });

    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snapshot = await provider.getSectorFundFlow('industry');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(snapshot.sectors).toHaveLength(120);
    expect(snapshot.kind).toBe('industry');
    expect(snapshot.period).toBe('today');
    expect(snapshot.source).toBe('东方财富');
  });

  it('不足一页时只请求一次', async () => {
    const fetchImpl = vi.fn(async () => clistResponse([row('BK1', '板块', 1e8)], 1));
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.getSectorFundFlow('concept');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('行情时间取最新的 f124', async () => {
    const fetchImpl = vi.fn(async () =>
      clistResponse([row('BK1', 'A', 1e8, { quoteTs: 1_700_000_000 }), row('BK2', 'B', 1e8, { quoteTs: 1_800_000_000 })]),
    );
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snapshot = await provider.getSectorFundFlow('industry');
    expect(snapshot.quoteTime?.getTime()).toBe(1_800_000_000 * 1000);
  });

  it('缓存命中时不重复请求（按 kind + period 分键）', async () => {
    const fetchImpl = vi.fn(async () => clistResponse([row('BK1', '板块', 1e8)]));
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const first = await provider.getSectorFundFlow('industry', 'today');
    const second = await provider.getSectorFundFlow('industry', 'today');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    // 不同周期 / 不同类型是不同缓存键
    await provider.getSectorFundFlow('industry', '5d');
    await provider.getSectorFundFlow('concept', 'today');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('网络错误（ECONNRESET）会重试并最终成功', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('fetch failed') as Error & { cause?: unknown };
        error.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        throw error;
      }
      return clistResponse([row('BK1', '板块', 1e8)], 1);
    });
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      retries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snapshot = await provider.getSectorFundFlow('industry');
    expect(calls).toBe(2);
    expect(snapshot.sectors).toHaveLength(1);
  });

  it('5xx 会重试，4xx 不重试', async () => {
    const server = vi.fn(async () => new Response('boom', { status: 502 }));
    const provider5xx = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      retries: 1,
      fetchImpl: server as unknown as typeof fetch,
    });
    await expect(provider5xx.getSectorFundFlow('industry')).rejects.toThrow(/HTTP 502/);
    expect(server).toHaveBeenCalledTimes(2);

    const client = vi.fn(async () => new Response('nope', { status: 404 }));
    const provider4xx = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      retries: 3,
      fetchImpl: client as unknown as typeof fetch,
    });
    await expect(provider4xx.getSectorFundFlow('industry')).rejects.toThrow(/HTTP 404/);
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('主接口不可用时自动切换备用主机', async () => {
    const tried: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const host = new URL(String(url)).host;
      tried.push(host);
      if (host === 'down.example.com') throw new Error('fetch failed');
      return clistResponse([row('BK1', '板块', 1e8)], 1);
    });
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      retries: 0,
      baseUrl: 'https://down.example.com/api/qt/clist/get',
      fallbackHosts: ['https://up.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snapshot = await provider.getSectorFundFlow('industry');
    expect(snapshot.sectors).toHaveLength(1);
    expect(tried).toEqual(['down.example.com', 'up.example.com']);
  });

  it('所有主机都失败时抛出汇总错误', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      retries: 0,
      baseUrl: 'https://a.example.com/api/qt/clist/get',
      fallbackHosts: ['https://b.example.com'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getSectorFundFlow('industry')).rejects.toThrow(/全部主机失败/);
  });

  it('空数据时抛出错误', async () => {
    const fetchImpl = vi.fn(async () => clistResponse([], 0));
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getSectorFundFlow('industry')).rejects.toThrow(/空数据/);
  });

  it('缺少 data 字段时抛出错误', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ rc: -1 }), { status: 200 }));
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getSectorFundFlow('industry')).rejects.toThrow(/未返回 data/);
  });

  it('全体数据无效时抛出错误', async () => {
    const fetchImpl = vi.fn(async () => clistResponse([{ f12: 'BK1', f14: '无净额' }], 1));
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getSectorFundFlow('industry')).rejects.toThrow(/全部无效/);
  });

  it('pz 超过接口上限时自动收敛到 100', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(new URL(String(url)).searchParams.get('pz')).toBe('100');
      return clistResponse([row('BK1', '板块', 1e8)], 1);
    });
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      pageSize: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.getSectorFundFlow('industry');
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});

describe('EastmoneyFundFlowProvider.getSectorFundFlowDetail', () => {
  it('解析分钟级明细，secid 使用 90.<code>', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/qt/stock/fflow/kline/get');
      expect(parsed.searchParams.get('secid')).toBe('90.BK0448');
      expect(parsed.searchParams.get('klt')).toBe('1');
      expect(parsed.searchParams.get('lmt')).toBe('0');
      return klineResponse('通信设备', ['2026-09-11 09:31,1000,100,-300,-200,900']);
    });
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const detail = await provider.getSectorFundFlowDetail('BK0448');
    expect(detail.name).toBe('通信设备');
    expect(detail.code).toBe('BK0448');
    expect(detail.points).toHaveLength(1);
    expect(detail.points[0]?.mainNet).toBe(1000);
  });

  it('明细为空时抛出错误', async () => {
    const fetchImpl = vi.fn(async () => klineResponse('通信设备', []));
    const provider = new EastmoneyFundFlowProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getSectorFundFlowDetail('BK0448')).rejects.toThrow(/明细为空/);
  });
});

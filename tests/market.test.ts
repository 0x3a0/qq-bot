import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { MemoryCache } from '../src/market/cache.js';
import {
  EastmoneyIndustryProvider,
  normalizeDiff,
  normalizeIndustryRows,
  takeTopBlocks,
} from '../src/market/eastmoney.js';
import {
  formatChangePercent,
  formatQuoteTime,
  formatSnapshotSubtitle,
  formatTurnover,
  isPreviousTradingDay,
  summarizeBlocks,
} from '../src/market/format.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};

function clistResponse(rows: unknown[], total = rows.length): Response {
  return new Response(JSON.stringify({ rc: 0, data: { total, diff: rows } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function row(code: string, name: string, change: number | string, turnover: number | string, ts = 1_752_000_000) {
  return { f12: code, f14: name, f3: change, f6: turnover, f124: ts };
}

describe('normalizeIndustryRows', () => {
  it('过滤成交额缺失、非数字或非正数的板块', () => {
    const blocks = normalizeIndustryRows([
      row('BK1', '半导体', 1.5, 9e10),
      row('BK2', '空成交额', 1.5, '-'),
      row('BK3', '零成交额', 1.5, 0),
      row('BK4', '负成交额', 1.5, -100),
      row('BK5', '非数字', 1.5, 'abc'),
      { f12: 'BK6', f14: '缺字段' },
      row('BK7', '', 1.5, 1e9),
    ]);
    expect(blocks.map((block) => block.code)).toEqual(['BK1']);
  });

  it('按成交额降序排序，不依赖接口顺序', () => {
    const blocks = normalizeIndustryRows([
      row('BK1', '小', 1, 1e8),
      row('BK2', '大', 1, 9e10),
      row('BK3', '中', 1, 5e9),
    ]);
    expect(blocks.map((block) => block.code)).toEqual(['BK2', 'BK3', 'BK1']);
  });

  it('涨跌幅缺失时按 0 处理，成交额字符串可解析', () => {
    const blocks = normalizeIndustryRows([
      { f12: 'BK1', f14: '银行', f6: '12345678' },
      row('BK2', '证券', '2.5', '20000000'),
    ]);
    expect(blocks[0]?.changePercent).toBe(2.5);
    expect(blocks[1]?.changePercent).toBe(0);
    expect(blocks.every((block) => Number.isFinite(block.turnover))).toBe(true);
  });

  it('解析行情时间戳', () => {
    const blocks = normalizeIndustryRows([row('BK1', '半导体', 1, 1e9, 1_752_345_678)]);
    expect(blocks[0]?.quoteTimestamp).toBe(1_752_345_678);
  });
});

describe('normalizeDiff', () => {
  it('支持数组形式', () => {
    expect(normalizeDiff([row('BK1', 'A', 1, 1)])).toHaveLength(1);
  });

  it('支持以序号为键的对象形式', () => {
    const diff = { '0': row('BK1', 'A', 1, 1), '1': row('BK2', 'B', 1, 2) };
    expect(normalizeDiff(diff)).toHaveLength(2);
  });

  it('undefined 返回空数组', () => {
    expect(normalizeDiff(undefined)).toEqual([]);
  });
});

describe('takeTopBlocks', () => {
  it('最多返回 20 个板块', () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(`BK${index}`, `板块${index}`, 1, (30 - index) * 1e9));
    const blocks = normalizeIndustryRows(rows);
    expect(blocks).toHaveLength(30);
    expect(takeTopBlocks(blocks)).toHaveLength(20);
    expect(takeTopBlocks(blocks)[0]?.code).toBe('BK0');
  });

  it('不足 20 个时返回全部', () => {
    const blocks = normalizeIndustryRows([row('BK1', 'A', 1, 1e9)]);
    expect(takeTopBlocks(blocks)).toHaveLength(1);
  });
});

describe('EastmoneyIndustryProvider', () => {
  it('分页抓取并在本地排序', async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => row(`P1-${index}`, `板块${index}`, 1, (100 - index) * 1e8));
    const page2 = [row('P2-0', '超大板块', 3, 9e10)];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      return parsed.searchParams.get('pn') === '1' ? clistResponse(page1, 101) : clistResponse(page2, 101);
    });

    const provider = new EastmoneyIndustryProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snapshot = await provider.getIndustrySnapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(snapshot.blocks).toHaveLength(101);
    expect(snapshot.blocks[0]?.name).toBe('超大板块');
    expect(snapshot.source).toBe('东方财富');
    expect(snapshot.market).toBe('A股');
    expect(takeTopBlocks(snapshot.blocks)).toHaveLength(20);
  });

  it('请求参数符合接口约定', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('fs')).toBe('m:90+t:2');
      expect(parsed.searchParams.get('fields')).toBe('f12,f14,f3,f6,f124');
      expect(parsed.searchParams.get('pz')).toBe('100');
      expect(parsed.searchParams.get('fid')).toBe('f6');
      return clistResponse([row('BK1', '半导体', 1, 1e9)]);
    });
    const provider = new EastmoneyIndustryProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.getIndustrySnapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('缓存命中时不重复请求', async () => {
    const fetchImpl = vi.fn(async () => clistResponse([row('BK1', '半导体', 1, 1e9)]));
    const provider = new EastmoneyIndustryProvider({
      logger,
      cacheTtlMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const first = await provider.getIndustrySnapshot();
    const second = await provider.getIndustrySnapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('空数据时抛出错误', async () => {
    const fetchImpl = vi.fn(async () => clistResponse([], 0));
    const provider = new EastmoneyIndustryProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getIndustrySnapshot()).rejects.toThrow(/空数据/);
  });

  it('缺少 data 字段时抛出错误', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ rc: -1 }), { status: 200 }));
    const provider = new EastmoneyIndustryProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getIndustrySnapshot()).rejects.toThrow(/未返回 data/);
  });

  it('HTTP 失败时抛出错误', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 502 }));
    const provider = new EastmoneyIndustryProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getIndustrySnapshot()).rejects.toThrow(/HTTP 502/);
  });

  it('行情时间取最新的 f124', async () => {
    const fetchImpl = vi.fn(async () =>
      clistResponse([row('BK1', 'A', 1, 1e9, 1_700_000_000), row('BK2', 'B', 1, 1e9, 1_800_000_000)]),
    );
    const provider = new EastmoneyIndustryProvider({
      logger,
      cacheTtlMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snapshot = await provider.getIndustrySnapshot();
    expect(snapshot.quoteTime?.getTime()).toBe(1_800_000_000 * 1000);
  });
});

describe('MemoryCache', () => {
  it('并发 getOrLoad 只执行一次 loader', async () => {
    const cache = new MemoryCache<number>({ ttlMs: 1000 });
    const loader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 42;
    });
    const results = await Promise.all([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)]);
    expect(results).toEqual([42, 42]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('TTL 过期后重新加载', async () => {
    let now = 0;
    const cache = new MemoryCache<string>({ ttlMs: 100, now: () => now });
    const loader = vi.fn(async () => `v${now}`);
    expect(await cache.getOrLoad('k', loader)).toBe('v0');
    now = 150;
    expect(await cache.getOrLoad('k', loader)).toBe('v150');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('format 工具', () => {
  it('成交额格式化', () => {
    expect(formatTurnover(9.87e10)).toBe('987.0亿');
    expect(formatTurnover(1.5e12)).toBe('15000亿');
    expect(formatTurnover(3.2e7)).toBe('3200万');
    expect(formatTurnover(0)).toBe('-');
  });

  it('涨跌幅格式化带符号', () => {
    expect(formatChangePercent(2.345)).toBe('+2.35%');
    expect(formatChangePercent(-1.2)).toBe('-1.20%');
    expect(formatChangePercent(0)).toBe('0.00%');
  });

  it('行情时间按东八区格式化', () => {
    // 2025-08-01T02:30:00Z == 北京时间 10:30
    expect(formatQuoteTime(new Date('2025-08-01T02:30:00Z'))).toBe('08-01 10:30');
    expect(formatQuoteTime(null)).toBe('时间未知');
  });

  it('★ 非今日行情标注为上一交易日数据，避免误读成实时行情', () => {
    // 周六 16:00（北京时间）查看周五收盘数据
    const saturday = new Date('2026-09-12T08:00:00Z'); // 北京 16:00
    const fridayQuote = new Date(1789112372 * 1000); // 北京 2026-09-11 15:39
    const subtitle = formatSnapshotSubtitle(
      { source: '东方财富', quoteTime: fridayQuote, fetchedAt: saturday, blockCount: 20 },
      { now: saturday },
    );
    expect(subtitle).toContain('2026-09-11 15:39');
    expect(subtitle).toContain('上一交易日数据');
    expect(isPreviousTradingDay(fridayQuote, saturday)).toBe(true);
  });

  it('当日行情不添加上一交易日标注', () => {
    const now = new Date('2026-09-11T07:00:00Z'); // 北京 15:00
    const quote = new Date('2026-09-11T07:00:00Z');
    const subtitle = formatSnapshotSubtitle(
      { source: '东方财富', quoteTime: quote, fetchedAt: now, blockCount: 20 },
      { now },
    );
    expect(subtitle).toContain('行情时间 09-11 15:00');
    expect(subtitle).not.toContain('上一交易日');
    expect(isPreviousTradingDay(quote, now)).toBe(false);
  });

  it('行情时间缺失时回退为抓取时间，不做交易日判断', () => {
    const now = new Date('2026-09-12T08:00:00Z');
    const subtitle = formatSnapshotSubtitle(
      { source: '东方财富', quoteTime: null, fetchedAt: now, blockCount: 20 },
      { now },
    );
    expect(subtitle).toContain('抓取时间');
    expect(subtitle).not.toContain('上一交易日');
    expect(isPreviousTradingDay(null, now)).toBe(false);
  });

  it('涨跌家数统计', () => {
    const stats = summarizeBlocks([
      { code: 'a', name: 'a', changePercent: 1, turnover: 1, quoteTimestamp: null },
      { code: 'b', name: 'b', changePercent: -1, turnover: 1, quoteTimestamp: null },
      { code: 'c', name: 'c', changePercent: 0, turnover: 1, quoteTimestamp: null },
      { code: 'd', name: 'd', changePercent: 2, turnover: 1, quoteTimestamp: null },
    ]);
    expect(stats).toEqual({ up: 2, down: 1, flat: 1 });
  });
});

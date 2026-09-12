import { describe, expect, it } from 'vitest';
import { clearRenderCache, renderCacheSize, renderPng } from '../src/render/image.js';
import type { MarketBlock } from '../src/market/types.js';

const blocks: MarketBlock[] = [
  { code: 'BK1', name: '半导体', changePercent: 3.2, turnover: 9e10, quoteTimestamp: 1_752_000_000 },
  { code: 'BK2', name: '证券', changePercent: -2.1, turnover: 6e10, quoteTimestamp: 1_752_000_000 },
];

const base = {
  blocks,
  source: '东方财富',
  quoteTime: new Date(1_752_000_000 * 1000),
  fetchedAt: new Date(),
};

describe('PNG 内容缓存', () => {
  it('相同内容命中缓存，返回同一份 Buffer', () => {
    clearRenderCache();
    const first = renderPng(base);
    const second = renderPng(base);
    expect(renderCacheSize()).toBe(1);
    expect(second.png).toBe(first.png);
  });

  it('行情变化后重新渲染（缓存不返回旧图）', () => {
    clearRenderCache();
    const first = renderPng(base);
    const changed = renderPng({
      ...base,
      blocks: [{ ...blocks[0]!, changePercent: 9.9 }, blocks[1]!],
    });
    expect(changed.png).not.toBe(first.png);
    expect(renderCacheSize()).toBe(2);
  });

  it('行情时间变化后重新渲染（图上会显示时间）', () => {
    clearRenderCache();
    const first = renderPng(base);
    const later = renderPng({ ...base, quoteTime: new Date(1_752_000_000_000 + 60_000) });
    expect(later.png).not.toBe(first.png);
  });

  it('缓存容量有上限（LRU 淘汰）', () => {
    clearRenderCache();
    for (let i = 0; i < 6; i += 1) {
      renderPng({ ...base, fetchedAt: new Date(), blocks: [{ ...blocks[0]!, turnover: 1e10 + i * 1e9 }, blocks[1]!] });
    }
    expect(renderCacheSize()).toBeLessThanOrEqual(4);
  });

  it('缓存命中不会改变 PNG 内容正确性', () => {
    clearRenderCache();
    const first = renderPng(base);
    const cached = renderPng(base);
    expect(cached.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(cached.png.length).toBe(first.png.length);
    expect(cached.tiles).toHaveLength(first.tiles.length);
  });
});

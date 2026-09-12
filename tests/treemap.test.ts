import { describe, expect, it } from 'vitest';
import { layoutTreemap, layoutBlocks } from '../src/render/treemap.js';
import type { MarketBlock } from '../src/market/types.js';

const blocks: MarketBlock[] = [
  { code: 'BK1', name: '半导体', changePercent: 2.5, turnover: 9e10, quoteTimestamp: 1 },
  { code: 'BK2', name: '证券', changePercent: -1.2, turnover: 5e10, quoteTimestamp: 1 },
  { code: 'BK3', name: '银行', changePercent: 0.4, turnover: 3e10, quoteTimestamp: 1 },
  { code: 'BK4', name: '酿酒行业', changePercent: -2.8, turnover: 1e10, quoteTimestamp: 1 },
];

describe('layoutTreemap', () => {
  it('每个板块生成一个矩形', () => {
    const tiles = layoutTreemap(blocks, { width: 800, height: 600, padding: 4 });
    expect(tiles).toHaveLength(blocks.length);
  });

  it('矩形总面积不超过容器面积，且总面积接近容器面积', () => {
    const width = 800;
    const height = 600;
    const padding = 4;
    const tiles = layoutTreemap(blocks, { width, height, padding });
    const totalArea = tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0);
    expect(totalArea).toBeLessThanOrEqual(width * height);
    expect(totalArea).toBeGreaterThan(width * height * 0.7);
  });

  it('矩形都在容器边界内且不重叠', () => {
    const width = 640;
    const height = 480;
    const tiles = layoutTreemap(blocks, { width, height, padding: 3 });
    for (const tile of tiles) {
      expect(tile.x0).toBeGreaterThanOrEqual(0);
      expect(tile.y0).toBeGreaterThanOrEqual(0);
      expect(tile.x1).toBeLessThanOrEqual(width);
      expect(tile.y1).toBeLessThanOrEqual(height);
      expect(tile.x1).toBeGreaterThan(tile.x0);
      expect(tile.y1).toBeGreaterThan(tile.y0);
    }
    for (let i = 0; i < tiles.length; i += 1) {
      for (let j = i + 1; j < tiles.length; j += 1) {
        const a = tiles[i]!;
        const b = tiles[j]!;
        const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        expect(overlapX > 0 && overlapY > 0).toBe(false);
      }
    }
  });

  it('面积与成交额成正比（最大板块面积最大）', () => {
    const tiles = layoutTreemap(blocks, { width: 800, height: 600, padding: 0 });
    const areas = tiles.map((tile) => ({ area: tile.width * tile.height, turnover: tile.turnover }));
    const maxTurnover = Math.max(...areas.map((item) => item.turnover));
    const maxArea = Math.max(...areas.map((item) => item.area));
    const biggest = areas.find((item) => item.area === maxArea);
    expect(biggest?.turnover).toBe(maxTurnover);
  });

  it('outerPadding 会为标题留出空间', () => {
    const tiles = layoutTreemap(blocks, { width: 800, height: 600, padding: 2, outerPadding: 40 });
    const minY = Math.min(...tiles.map((tile) => tile.y0));
    const maxX = Math.max(...tiles.map((tile) => tile.x1));
    expect(minY).toBeGreaterThanOrEqual(40);
    expect(maxX).toBeLessThanOrEqual(800 - 40);
  });

  it('过滤掉成交额非正数或非有限的板块', () => {
    const tiles = layoutBlocks(
      [
        ...blocks,
        { code: 'BKX', name: '无效A', changePercent: 0, turnover: 0, quoteTimestamp: null },
        { code: 'BKY', name: '无效B', changePercent: 0, turnover: Number.NaN, quoteTimestamp: null },
      ],
      { width: 400, height: 300 },
    );
    expect(tiles.map((tile) => tile.code).sort()).toEqual(['BK1', 'BK2', 'BK3', 'BK4']);
  });

  it('空输入返回空数组', () => {
    expect(layoutTreemap([], { width: 400, height: 300 })).toEqual([]);
  });

  it('保留名称与涨跌幅等业务字段', () => {
    const tiles = layoutTreemap(blocks, { width: 500, height: 400 });
    const semiconductor = tiles.find((tile) => tile.code === 'BK1');
    expect(semiconductor?.name).toBe('半导体');
    expect(semiconductor?.changePercent).toBe(2.5);
    expect(semiconductor?.turnover).toBe(9e10);
  });
});

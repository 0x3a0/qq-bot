import { describe, expect, it } from 'vitest';
import { renderPng, renderSvg } from '../src/render/image.js';
import { colorForChange, estimateTextWidth, readableTextColor, truncateToWidth } from '../src/render/color.js';
import type { MarketBlock } from '../src/market/types.js';

const blocks: MarketBlock[] = [
  { code: 'BK1', name: '半导体', changePercent: 3.2, turnover: 9e10, quoteTimestamp: 1_752_000_000 },
  { code: 'BK2', name: '证券', changePercent: -2.1, turnover: 6e10, quoteTimestamp: 1_752_000_000 },
  { code: 'BK3', name: '银行', changePercent: 0.3, turnover: 4e10, quoteTimestamp: 1_752_000_000 },
  { code: 'BK4', name: '酿酒行业', changePercent: 0, turnover: 2e10, quoteTimestamp: 1_752_000_000 },
  { code: 'BK5', name: '汽车整车', changePercent: -0.8, turnover: 1e10, quoteTimestamp: 1_752_000_000 },
];

const baseOptions = {
  blocks,
  source: '东方财富',
  quoteTime: new Date(1_752_000_000 * 1000),
  fetchedAt: new Date(),
};

describe('renderSvg', () => {
  it('生成包含数据源与行情时间的 SVG（不含大标题）', () => {
    const { svg, width, height } = renderSvg(baseOptions);
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('东方财富');
    expect(svg).toContain('行情时间');
    // 大标题已移除
    expect(svg).not.toContain('A 股行业板块热力图');
    expect(width).toBe(1200);
    expect(height).toBe(900);
  });

  it('非今日行情只带完整日期，不含「上一交易日数据」后缀', () => {
    // 周六查看周五收盘数据
    const saturday = new Date('2026-09-12T08:00:00Z');
    const fridayQuote = new Date('2026-09-11T07:39:00Z');
    const { svg } = renderSvg({
      ...baseOptions,
      quoteTime: fridayQuote,
      blocks: blocks.map((block) => ({ ...block, quoteTimestamp: Math.floor(fridayQuote.getTime() / 1000) })),
      now: saturday,
    });
    expect(svg).toContain('2026-09-1');
    expect(svg).not.toContain('上一交易日');
    expect(svg).not.toContain('非今日');
  });

  it('每个板块生成一个矩形', () => {
    const { svg, tiles } = renderSvg(baseOptions);
    expect(tiles).toHaveLength(blocks.length);
    const rects = svg.match(/<rect /g) ?? [];
    // 背景 + 标题栏 + 页脚 + 图例 + 板块
    expect(rects.length).toBeGreaterThanOrEqual(blocks.length + 4);
  });

  it('矩形颜色反映涨跌幅（红涨绿跌）', () => {
    const { svg } = renderSvg(baseOptions);
    expect(svg).toContain(colorForChange(3.2));
    expect(svg).toContain(colorForChange(-2.1));
  });

  it('转义 XML 特殊字符', () => {
    const { svg } = renderSvg({
      ...baseOptions,
      blocks: [{ code: 'BKX', name: 'A&B<测试>', changePercent: 1, turnover: 1e10, quoteTimestamp: null }],
    });
    expect(svg).toContain('A&amp;B&lt;测试&gt;');
  });

  it('行情时间缺失时回退为抓取时间', () => {
    const { svg } = renderSvg({ ...baseOptions, quoteTime: null });
    expect(svg).toContain('抓取时间');
  });

  it('显示涨跌家数统计', () => {
    const { svg } = renderSvg(baseOptions);
    expect(svg).toContain('上涨 2');
    expect(svg).toContain('下跌 2');
    expect(svg).toContain('平盘 1');
  });
});

describe('renderPng', () => {
  it('输出合法 PNG 且尺寸正确', () => {
    const image = renderPng(baseOptions);
    expect(image.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(image.png.length).toBeGreaterThan(5000);
    // PNG IHDR 中的宽高
    expect(image.png.readUInt32BE(16)).toBe(1200);
    expect(image.png.readUInt32BE(20)).toBe(900);
    expect(image.png.length).toBeLessThan(5 * 1024 * 1024);
  });

  it('支持自定义尺寸', () => {
    const image = renderPng({ ...baseOptions, width: 800, height: 600 });
    expect(image.png.readUInt32BE(16)).toBe(800);
    expect(image.png.readUInt32BE(20)).toBe(600);
  });

  it('空板块列表也能渲染（只有头部与页脚）', () => {
    const image = renderPng({ ...baseOptions, blocks: [] });
    expect(image.tiles).toHaveLength(0);
    expect(image.png.length).toBeGreaterThan(1000);
  });
});

describe('color 工具', () => {
  it('上涨为红色系，下跌为绿色系', () => {
    const up = colorForChange(5);
    const down = colorForChange(-5);
    const upRgb = { r: Number.parseInt(up.slice(1, 3), 16), g: Number.parseInt(up.slice(3, 5), 16) };
    const downRgb = { r: Number.parseInt(down.slice(1, 3), 16), g: Number.parseInt(down.slice(3, 5), 16) };
    expect(upRgb.r).toBeGreaterThan(upRgb.g);
    expect(downRgb.g).toBeGreaterThan(downRgb.r);
  });

  it('零涨跌幅为灰色', () => {
    expect(colorForChange(0)).toBe('#8a94a6');
  });

  it('深色背景使用白色文字', () => {
    expect(readableTextColor('#e8443a')).toBe('#ffffff');
    expect(readableTextColor('#ffffff')).toBe('#1f2430');
  });

  it('文本宽度估算：中文比英文宽', () => {
    expect(estimateTextWidth('半导体', 20)).toBeGreaterThan(estimateTextWidth('abc', 20));
  });

  it('超宽文本被截断并添加省略号', () => {
    const text = truncateToWidth('半导体及元件制造业', 20, 60);
    expect(text.endsWith('…')).toBe(true);
    expect(estimateTextWidth(text, 20)).toBeLessThanOrEqual(60);
  });

  it('宽度足够时不截断', () => {
    expect(truncateToWidth('半导体', 20, 200)).toBe('半导体');
  });
});

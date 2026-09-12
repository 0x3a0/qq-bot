/**
 * Treemap 布局：使用 d3-hierarchy 的 squarified 算法。
 * 矩形面积对应成交额，颜色对应涨跌幅。
 */
import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from 'd3-hierarchy';
import type { MarketBlock } from '../market/types.js';

export interface TreemapInput {
  code: string;
  name: string;
  changePercent: number;
  turnover: number;
}

export interface TreemapTile {
  code: string;
  name: string;
  changePercent: number;
  turnover: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
}

export interface TreemapLayoutOptions {
  width: number;
  height: number;
  /** 矩形之间的内边距，默认 3 */
  padding?: number;
  /** 顶部标题区域留白，不参与布局，默认 0 */
  outerPadding?: number;
}

interface TreeNode {
  children?: TreemapInput[];
}

type RectNode = HierarchyRectangularNode<TreeNode | TreemapInput>;

/**
 * 计算 Treemap 布局。
 * 成交额 <= 0 或非有限的板块会被过滤，避免面积计算出 NaN。
 */
export function layoutTreemap(blocks: TreemapInput[], options: TreemapLayoutOptions): TreemapTile[] {
  const usable = blocks.filter((block) => Number.isFinite(block.turnover) && block.turnover > 0);
  if (usable.length === 0) return [];

  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  const padding = Math.max(0, Math.floor(options.padding ?? 3));
  const outer = Math.max(0, Math.floor(options.outerPadding ?? 0));

  // 布局区域：y 从 outer 开始，为标题留白
  const layoutWidth = Math.max(1, width - outer * 2);
  const layoutHeight = Math.max(1, height - outer * 2);

  const root = hierarchy<TreeNode | TreemapInput>({ children: usable })
    .sum((node) => ('turnover' in node ? node.turnover : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const layout = treemap<TreeNode | TreemapInput>()
    .tile(treemapSquarify)
    .size([layoutWidth, layoutHeight])
    .paddingInner(padding)
    .paddingOuter(0)
    .round(true);

  layout(root);

  const tiles: TreemapTile[] = [];
  for (const leaf of root.leaves() as RectNode[]) {
    const datum = leaf.data as TreemapInput;
    if (!('turnover' in datum)) continue;
    const tileWidth = leaf.x1 - leaf.x0;
    const tileHeight = leaf.y1 - leaf.y0;
    if (tileWidth <= 0 || tileHeight <= 0) continue;
    tiles.push({
      code: datum.code,
      name: datum.name,
      changePercent: datum.changePercent,
      turnover: datum.turnover,
      x0: leaf.x0 + outer,
      y0: leaf.y0 + outer,
      x1: leaf.x1 + outer,
      y1: leaf.y1 + outer,
      width: tileWidth,
      height: tileHeight,
    });
  }
  return tiles;
}

/** 便捷封装：从行情板块直接布局。 */
export function layoutBlocks(blocks: MarketBlock[], options: TreemapLayoutOptions): TreemapTile[] {
  return layoutTreemap(
    blocks.map((block) => ({
      code: block.code,
      name: block.name,
      changePercent: block.changePercent,
      turnover: block.turnover,
    })),
    options,
  );
}

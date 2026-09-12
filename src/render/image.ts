/**
 * PNG 渲染：SVG 由 renderSvg 生成，再由 @resvg/resvg-js 转 PNG。
 * 字体：优先使用显式配置的字体文件；未配置时由 resvg 扫描系统字体，
 * 以便在中文 Windows / Linux 上都能渲染行业名称。
 */
import { Resvg } from '@resvg/resvg-js';
import { colorForChange, escapeXml, readableTextColor, truncateToWidth } from './color.js';
import { layoutTreemap, type TreemapTile } from './treemap.js';
import type { MarketBlock } from '../market/types.js';
import { formatChangePercent, formatSnapshotSubtitle, summarizeBlocks } from '../market/format.js';

export const DEFAULT_WIDTH = 1200;
export const DEFAULT_HEIGHT = 900;

export interface RenderImageOptions {
  blocks: MarketBlock[];
  source: string;
  quoteTime: Date | null;
  fetchedAt: Date;
  /** 图片标题，默认「A 股行业板块热力图」 */
  title?: string;
  width?: number;
  height?: number;
  fontFiles?: string[];
  /** 生成时刻，用于判断行情是否为上一交易日（测试注入用） */
  now?: Date;
}

export interface RenderedImage {
  png: Buffer;
  svg: string;
  width: number;
  height: number;
  tiles: TreemapTile[];
}

interface Theme {
  background: string;
  headerBackground: string;
  headerText: string;
  headerSubText: string;
  footerBackground: string;
  footerText: string;
}

const THEME: Theme = {
  background: '#12161f',
  headerBackground: '#1b2030',
  headerText: '#f5f7fa',
  headerSubText: '#9aa4b8',
  footerBackground: '#1b2030',
  footerText: '#9aa4b8',
};

const HEADER_HEIGHT = 116;
const FOOTER_HEIGHT = 56;
const MARGIN = 20;
const TILE_PADDING = 4;
const LEGEND_WIDTH = 168;

/** 生成 Treemap 热力图 SVG。 */
export function renderSvg(options: RenderImageOptions): { svg: string; tiles: TreemapTile[]; width: number; height: number } {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? 'A 股行业板块热力图';

  const chartWidth = width - MARGIN * 2;
  const chartHeight = height - HEADER_HEIGHT - FOOTER_HEIGHT - MARGIN;

  const tiles = layoutTreemap(
    options.blocks.map((block) => ({
      code: block.code,
      name: block.name,
      changePercent: block.changePercent,
      turnover: block.turnover,
    })),
    { width: chartWidth, height: chartHeight, padding: TILE_PADDING, outerPadding: 0 },
  );

  const subtitle = formatSnapshotSubtitle(
    {
      source: options.source,
      quoteTime: options.quoteTime,
      fetchedAt: options.fetchedAt,
      blockCount: tiles.length,
    },
    options.now ? { now: options.now } : {},
  );

  const stats = summarizeBlocks(options.blocks.slice(0, tiles.length));
  const tileMarkup = tiles.map((tile) => renderTile(tile)).join('\n');
  const legend = renderLegend({ x: MARGIN, y: height - FOOTER_HEIGHT + 14, width: LEGEND_WIDTH });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="headerBg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#1b2030"/>
      <stop offset="100%" stop-color="#232b40"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="${THEME.background}"/>
  <rect x="0" y="0" width="${width}" height="${HEADER_HEIGHT}" fill="url(#headerBg)"/>
  <text x="${MARGIN}" y="52" font-family="sans-serif" font-size="34" font-weight="700" fill="${THEME.headerText}">${escapeXml(
    title,
  )}</text>
  <text x="${MARGIN}" y="88" font-family="sans-serif" font-size="19" fill="${THEME.headerSubText}">${escapeXml(
    subtitle,
  )}</text>
  <text x="${width - MARGIN}" y="52" text-anchor="end" font-family="sans-serif" font-size="20" fill="${THEME.headerSubText}">${escapeXml(
    `上涨 ${stats.up} · 下跌 ${stats.down}${stats.flat > 0 ? ` · 平盘 ${stats.flat}` : ''}`,
  )}</text>
  <g transform="translate(${MARGIN}, ${HEADER_HEIGHT})">
${tileMarkup}
  </g>
  <rect x="0" y="${height - FOOTER_HEIGHT}" width="${width}" height="${FOOTER_HEIGHT}" fill="${THEME.footerBackground}"/>
  ${legend}
  <text x="${width - MARGIN}" y="${height - FOOTER_HEIGHT + 34}" text-anchor="end" font-family="sans-serif" font-size="17" fill="${
    THEME.footerText
  }">矩形面积＝成交额，颜色＝涨跌幅</text>
</svg>`;

  return { svg, tiles, width, height };
}

function renderTile(tile: TreemapTile): string {
  const fill = colorForChange(tile.changePercent);
  const textColor = readableTextColor(fill);
  const innerWidth = tile.width - 12;
  const innerHeight = tile.height - 8;

  if (innerWidth < 26 || innerHeight < 20) {
    return `    <rect x="${tile.x0}" y="${tile.y0}" width="${tile.width}" height="${tile.height}" fill="${fill}"/>`;
  }

  const parts: string[] = [
    `    <rect x="${tile.x0}" y="${tile.y0}" width="${tile.width}" height="${tile.height}" rx="3" fill="${fill}"/>`,
  ];

  const pctText = formatChangePercent(tile.changePercent);
  let nameFontSize = Math.min(26, Math.max(12, Math.floor(Math.min(innerWidth / 5.2, innerHeight / 3.4))));
  let pctFontSize = Math.min(24, Math.max(11, Math.floor(nameFontSize * 0.95)));

  if (innerHeight < 34) {
    // 高度不足时只画一行：名称 + 涨跌幅
    const text = `${tile.name} ${pctText}`;
    const fontSize = Math.max(11, Math.min(nameFontSize, 18));
    const clipped = truncateToWidth(text, fontSize, innerWidth);
    if (clipped.length > 0) {
      parts.push(
        `    <text x="${tile.x0 + 6}" y="${tile.y0 + tile.height / 2 + fontSize * 0.35}" font-family="sans-serif" font-size="${fontSize}" font-weight="600" fill="${textColor}">${escapeXml(
          clipped,
        )}</text>`,
      );
    }
    return parts.join('\n');
  }

  nameFontSize = Math.min(nameFontSize, 26);
  pctFontSize = Math.min(pctFontSize, nameFontSize);

  const name = truncateToWidth(tile.name, nameFontSize, innerWidth) || tile.name.slice(0, 1);
  const baselineName = tile.y0 + 6 + nameFontSize;

  parts.push(
    `    <text x="${tile.x0 + 6}" y="${baselineName}" font-family="sans-serif" font-size="${nameFontSize}" font-weight="600" fill="${textColor}">${escapeXml(
      name,
    )}</text>`,
  );

  const showPercent = innerHeight >= nameFontSize + pctFontSize + 12;
  if (showPercent) {
    parts.push(
      `    <text x="${tile.x0 + 6}" y="${baselineName + pctFontSize + 6}" font-family="sans-serif" font-size="${pctFontSize}" fill="${textColor}" opacity="0.92">${escapeXml(
        pctText,
      )}</text>`,
    );
  }

  return parts.join('\n');
}

function renderLegend(params: { x: number; y: number; width: number }): string {
  const { x, y, width } = params;
  const stops = [-5, -2.5, 0, 2.5, 5];
  const cellWidth = width / stops.length;
  const cells = stops
    .map((stop, index) => {
      const fill = colorForChange(stop);
      return `  <rect x="${x + index * cellWidth}" y="${y}" width="${cellWidth}" height="16" fill="${fill}"/>`;
    })
    .join('\n');

  return `${cells}
  <text x="${x}" y="${y + 34}" font-family="sans-serif" font-size="15" fill="${THEME.footerText}">-5%</text>
  <text x="${x + width}" y="${y + 34}" text-anchor="end" font-family="sans-serif" font-size="15" fill="${
    THEME.footerText
  }">+5%</text>`;
}

/** 渲染 PNG。失败会抛出异常，由调用方决定兜底文案。 */
export function renderPng(options: RenderImageOptions): RenderedImage {
  const { svg, tiles, width, height } = renderSvg(options);
  const resvg = new Resvg(svg, {
    background: THEME.background,
    fitTo: { mode: 'width', value: width },
    font: {
      loadSystemFonts: true,
      ...(options.fontFiles && options.fontFiles.length > 0 ? { fontFiles: options.fontFiles } : {}),
      defaultFontFamily: 'sans-serif',
    },
  });
  const png = Buffer.from(resvg.render().asPng());
  return { png, svg, width, height, tiles };
}

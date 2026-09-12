/** 颜色与文本工具（渲染与测试共用）。 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace('#', '');
  const normalized =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

export function rgbToHex(rgb: Rgb): string {
  const toHex = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const ratio = Math.max(0, Math.min(1, t));
  return {
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  };
}

const UP_HEX = '#e8443a';
const DOWN_HEX = '#1aa260';
const FLAT_HEX = '#8a94a6';

export interface ColorScaleOptions {
  /** 涨跌幅绝对值达到该值时颜色饱和，默认 3% */
  saturationPercent?: number;
}

/**
 * 按涨跌幅映射颜色：红涨绿跌（A 股习惯）。
 * ±saturationPercent 时为满色，0 附近为灰色。
 */
export function colorForChange(changePercent: number, options: ColorScaleOptions = {}): string {
  const saturation = options.saturationPercent && options.saturationPercent > 0 ? options.saturationPercent : 3;
  if (!Number.isFinite(changePercent)) return FLAT_HEX;
  const t = Math.min(Math.abs(changePercent) / saturation, 1);
  if (Math.abs(changePercent) < 0.005) return FLAT_HEX;
  const base = changePercent > 0 ? hexToRgb(UP_HEX) : hexToRgb(DOWN_HEX);
  const neutral = hexToRgb(FLAT_HEX);
  return rgbToHex(mixRgb(neutral, base, 0.25 + 0.75 * t));
}

/** 依据背景亮度选择文字颜色，保证对比度。 */
export function readableTextColor(backgroundHex: string): string {
  const { r, g, b } = hexToRgb(backgroundHex);
  // 相对亮度（sRGB 近似）
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#1f2430' : '#ffffff';
}

/** 粗略估计文本像素宽度（中文按 1em，其它字符按 0.55em）。 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) {
    units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(char) ? 1 : 0.55;
  }
  return units * fontSize;
}

/** 按可用宽度截断文本，超出部分用「…」表示。 */
export function truncateToWidth(text: string, fontSize: number, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  let result = '';
  for (const char of chars) {
    const candidate = `${result}${char}`;
    if (estimateTextWidth(`${candidate}…`, fontSize) > maxWidth) break;
    result = candidate;
  }
  return result.length > 0 ? `${result}…` : '';
}

/** 转义 SVG 文本中的特殊字符。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

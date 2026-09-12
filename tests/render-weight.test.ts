import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { BUNDLED_FONT_CANDIDATES, BUNDLED_FONT_PAIR, detectBundledFonts } from '../src/config.js';
import { readFontMeta } from '../src/render/font-meta.js';

/**
 * 回归背景（线上真实故障）：
 *
 * 自带字体原本是 `NotoSansSC-VF.ttf`（可变字体），而 resvg 不支持 fvar/wght 轴，
 * 只会使用该文件的**默认实例**——这个子集可变字体的默认实例恰好是 Thin
 * （OS/2 usWeightClass=100）。于是：
 *   1. SVG 里的 font-weight（标题 700、板块名 600）全部被静默忽略；
 *   2. 全图文字退化成发丝一样的极细笔画，在深色底上看起来「模糊」。
 * 修复方式：改用静态 Regular + Bold 两个文件（resvg 只有拿到多个字面时
 * 才会按 font-weight 选字重）。本文件把这些约束固化成测试。
 */

const ROOT = process.cwd();
const REGULAR = join(ROOT, BUNDLED_FONT_PAIR[0]);
const BOLD = join(ROOT, BUNDLED_FONT_PAIR[1]);

const TEXT = '行业板块主力Top25';

let fontsReady = false;

beforeAll(() => {
  // 字体不入库，靠构建阶段下载。尝试补下，失败则跳过依赖真实字体的用例。
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'fetch-font.mjs')], {
      stdio: 'ignore',
      timeout: 300_000,
    });
  } catch {
    // 忽略：下面按 existsSync 判断
  }
  fontsReady = existsSync(REGULAR) && existsSync(BOLD);
}, 300_000);

/** 统计接近白色的像素数，作为「墨迹量」的代理指标。 */
function inkPixels(png: Buffer): number {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = 4;
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const x = line[i] as number;
      const a = i >= channels ? (current[i - channels] as number) : 0;
      const b = previous ? (previous[i] as number) : 0;
      const c = previous && i >= channels ? (previous[i - channels] as number) : 0;
      let value: number;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else value = x + paeth(a, b, c);
      current[i] = value & 0xff;
    }
  }

  let ink = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i] as number) > 200) ink += 1;
  }
  return ink;
}

function renderText(fontFiles: string[], weight: number): { png: Buffer; ink: number } {
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120">` +
    `<rect width="600" height="120" fill="#12161f"/>` +
    `<text x="20" y="80" font-family="sans-serif" font-size="44" font-weight="${weight}" fill="#ffffff">${TEXT}</text>` +
    `</svg>`;
  const resvg = new Resvg(svg, {
    background: '#12161f',
    font: { loadSystemFonts: false, fontFiles, defaultFontFamily: 'sans-serif' },
  });
  const png = Buffer.from(resvg.render().asPng());
  return { png, ink: inkPixels(png) };
}

describe('字体元数据解析', () => {
  it('★ 内置字体就位时，Regular/Bold 是静态字重且字重正确', () => {
    if (!fontsReady) return; // 无网络且未下载时不误报

    const regular = readFontMeta(readFileSync(REGULAR));
    const bold = readFontMeta(readFileSync(BOLD));

    expect(regular.family).toBe('Noto Sans SC');
    expect(bold.family).toBe('Noto Sans SC');

    // 关键：必须是静态字体。可变字体会让 resvg 只使用默认实例，忽略 font-weight。
    expect(regular.isVariable).toBe(false);
    expect(bold.isVariable).toBe(false);

    expect(regular.weightClass).toBe(400);
    expect(bold.weightClass).toBe(700);
  });

  it('★ 反例：旧的可变字体默认实例是 Thin（正是线上字迹极细的原因）', () => {
    const legacy = join(ROOT, 'assets', 'fonts', 'NotoSansSC-VF.ttf');
    if (!existsSync(legacy)) return; // 修复后该文件已被 fetch-font 清理

    const meta = readFontMeta(readFileSync(legacy));
    expect(meta.isVariable).toBe(true);
    expect(meta.variableDefaultWeight).toBe(100);
    // 默认字重这么低，又只有一个文件 —— font-weight 必然失效
    expect(meta.weightClass).toBeLessThan(300);
  });

  it('★ 自带字体探测优先返回静态 Regular+Bold 组合', () => {
    if (!fontsReady) return;
    expect(detectBundledFonts(ROOT)).toEqual([REGULAR, BOLD]);
  });

  it('★ 自带字体组合不是旧的单个可变字体', () => {
    if (!fontsReady) return;
    const detected = detectBundledFonts(ROOT);
    expect(detected).toHaveLength(2);
    for (const legacy of BUNDLED_FONT_CANDIDATES) {
      expect(detected).not.toContain(join(ROOT, legacy));
    }
  });
});

describe('font-weight 必须真的改变字形（防「极细体」回归）', () => {
  it('★ 同一段文字，weight 700 的墨迹显著多于 400', () => {
    if (!fontsReady) return;

    const regular = renderText([REGULAR, BOLD], 400);
    const bold = renderText([REGULAR, BOLD], 700);

    expect(regular.ink).toBeGreaterThan(0);
    // 粗体笔画更宽 —— 墨迹量应有可见增长（实测约 +67%）
    expect(bold.ink).toBeGreaterThan(regular.ink * 1.2);
  });

  it('★ 只给单个字体文件时 font-weight 会被忽略（解释为何必须两个文件）', () => {
    if (!fontsReady) return;

    // 这是 resvg 的行为：单字体时不做字重匹配，永远用该字体自己的字面。
    const atRegular = renderText([REGULAR], 700);
    const atDefault = renderText([REGULAR], 400);
    expect(atRegular.png.equals(atDefault.png)).toBe(true);
  });

  it('★ 自带字体渲染出来的中文不是「框框」', () => {
    if (!fontsReady) return;
    // 缺字形时 resvg 不报错，只是画不出字 —— 墨迹量会接近 0
    const { ink } = renderText([REGULAR, BOLD], 400);
    expect(ink).toBeGreaterThan(1000);
  });
});

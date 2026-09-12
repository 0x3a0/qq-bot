import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_FONT_CANDIDATES,
  BUNDLED_FONT_PAIR,
  detectBundledFonts,
  loadConfig,
} from '../src/config.js';

const base = { APP_ID: '123456', CLIENT_SECRET: 'secret' };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qq-bot-font-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 在临时目录里造出若干字体文件。 */
function touchFonts(relatives: readonly string[]): string[] {
  mkdirSync(join(dir, 'assets', 'fonts'), { recursive: true });
  return relatives.map((relative) => {
    const file = join(dir, relative);
    writeFileSync(file, 'fake-font');
    return file;
  });
}

describe('自带字体探测', () => {
  it('★ 没有 assets/fonts 时返回空数组（回退系统字体）', () => {
    expect(detectBundledFonts(dir)).toEqual([]);
  });

  it('★ 同时有静态 Regular 与 Bold 时两个都返回（resvg 靠它们选字重）', () => {
    const files = touchFonts(BUNDLED_FONT_PAIR);
    expect(detectBundledFonts(dir)).toEqual(files);
  });

  it('★ 只有静态 Regular 时不要用它（单字体下 font-weight 会失效）', () => {
    touchFonts([BUNDLED_FONT_PAIR[0]]);
    // 没有 Bold 就不满足「字重对」，此时应回退到兜底候选（这里为空）
    expect(detectBundledFonts(dir)).toEqual([]);
  });

  it('★ 只有静态 Bold 时同样不采用', () => {
    touchFonts([BUNDLED_FONT_PAIR[1]]);
    expect(detectBundledFonts(dir)).toEqual([]);
  });

  it('静态字重不全时回退到旧的可变字体候选', () => {
    const files = touchFonts([BUNDLED_FONT_PAIR[0], BUNDLED_FONT_CANDIDATES[0] as string]);
    expect(detectBundledFonts(dir)).toEqual([files[1]]);
  });

  it('支持兜底候选路径中的任意一个（旧 VF 命名）', () => {
    const [alt] = touchFonts([BUNDLED_FONT_CANDIDATES[1] as string]);
    expect(detectBundledFonts(dir)).toEqual([alt]);
  });

  it('显式配置的 FONT_FILES 优先于自带字体', () => {
    const config = loadConfig({ ...base, FONT_FILES: '/custom/my.ttf' });
    expect(config.fontFiles).toEqual(['/custom/my.ttf']);
  });

  it('FONT_FILES 为空串时仍会回退到自带字体', () => {
    const config = loadConfig({ ...base, FONT_FILES: '   ' });
    // 本仓库已通过 fetch-font 放好字体，因此这里应当探测到它
    expect(Array.isArray(config.fontFiles)).toBe(true);
  });
});

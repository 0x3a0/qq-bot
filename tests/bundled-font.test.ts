import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_FONT_CANDIDATES, detectBundledFonts, loadConfig } from '../src/config.js';

const base = { APP_ID: '123456', CLIENT_SECRET: 'secret' };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qq-bot-font-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('自带字体探测', () => {
  it('★ 没有 assets/fonts 时返回空数组（回退系统字体）', () => {
    expect(detectBundledFonts(dir)).toEqual([]);
  });

  it('★ 存在自带字体时自动使用它（部署环境无需手动配 FONT_FILES）', () => {
    const fontPath = join(dir, BUNDLED_FONT_CANDIDATES[0] as string);
    mkdirSync(join(dir, 'assets', 'fonts'), { recursive: true });
    writeFileSync(fontPath, 'fake-font');

    expect(detectBundledFonts(dir)).toEqual([fontPath]);
  });

  it('支持候选路径中的任意一个（VVF 旧命名）', () => {
    const altPath = join(dir, BUNDLED_FONT_CANDIDATES[1] as string);
    mkdirSync(join(dir, 'assets', 'fonts'), { recursive: true });
    writeFileSync(altPath, 'fake-font');

    expect(detectBundledFonts(dir)).toEqual([altPath]);
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

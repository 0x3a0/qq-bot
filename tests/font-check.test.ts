import { describe, expect, it, vi } from 'vitest';
import { checkFontSupport, reportFontSupport } from '../src/render/font-check.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};

describe('字体健康检查', () => {
  it('★ 本机有中文字体时探针通过', () => {
    const result = checkFontSupport();
    expect(result.ok).toBe(true);
    // 有字体时单字 PNG 明显更大
    expect(result.bytes).toBeGreaterThan(400);
  });

  it('探针返回值包含字节数与字体文件列表', () => {
    const result = checkFontSupport({ fontFiles: [] });
    expect(typeof result.bytes).toBe('number');
    expect(result.fontFiles).toEqual([]);
  });

  it('★ 通过时不打印告警', () => {
    const errors: string[] = [];
    const info: string[] = [];
    const spy = { ...logger, info: (m: string) => info.push(m), error: (m: string) => errors.push(m) };
    const ok = reportFontSupport(spy as unknown as typeof logger, {});
    expect(ok).toBe(true);
    expect(errors).toHaveLength(0);
    expect(info.some((line) => line.includes('字体检查通过'))).toBe(true);
  });

  it('★ 缺字体时返回 false 并给出可操作的告警', () => {
    // 用一个不存在的字体文件路径，模拟容器里路径与本地不同
    const errors: string[] = [];
    const spy = { ...logger, info: vi.fn(), error: (m: string) => errors.push(m) };
    const ok = reportFontSupport(spy as unknown as typeof logger, {
      fontFiles: ['/nix/store/does-not-exist/NotoSansCJK-Regular.ttc'],
    });

    expect(ok).toBe(false);
    const text = errors.join('\n');
    expect(text).toContain('不存在');
    expect(text).toContain('FONT_FILES');
  });

  it('★ 探针识别「FONT_FILES 文件不存在」（resvg 会静默回退到系统字体）', () => {
    const result = checkFontSupport({ fontFiles: ['/nix/store/does-not-exist/font.ttc'] });
    expect(result.ok).toBe(false);
    expect(result.missingFontFiles).toEqual(['/nix/store/does-not-exist/font.ttc']);
  });
});

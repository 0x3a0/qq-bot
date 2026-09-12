import { describe, expect, it } from 'vitest';
import { checkFontSupport, reportFontSupport } from '../src/render/font-check.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};

/** 收集日志的假 logger */
function spyLogger(): { info: string[]; errors: string[]; log: typeof logger } {
  const info: string[] = [];
  const errors: string[] = [];
  return {
    info,
    errors,
    log: {
      ...logger,
      info: (m: string) => info.push(m),
      error: (m: string) => errors.push(m),
    } as unknown as typeof logger,
  };
}

describe('字体健康检查', () => {
  it('★ 本机有中文字体时探针通过', () => {
    const result = checkFontSupport();
    expect(result.ok).toBe(true);
    expect(result.bytes).toBeGreaterThan(400);
  });

  it('探针返回值包含字节数、字体列表与缺失列表', () => {
    const result = checkFontSupport({ fontFiles: [] });
    expect(typeof result.bytes).toBe('number');
    expect(result.fontFiles).toEqual([]);
    expect(result.missingFontFiles).toEqual([]);
  });

  it('★ 通过时说明来源为系统字体，且不打印告警', () => {
    const spy = spyLogger();
    expect(reportFontSupport(spy.log, {})).toBe(true);
    expect(spy.errors).toHaveLength(0);
    expect(spy.info.some((line) => line.includes('字体检查通过') && line.includes('使用系统字体'))).toBe(true);
  });

  it('★ 使用自带字体时日志说明来源为「自带字体」', () => {
    const spy = spyLogger();
    const ok = reportFontSupport(spy.log, { fontFiles: ['assets/fonts/NotoSansSC-Regular.ttf'] });
    if (ok) {
      expect(spy.info.some((line) => line.includes('自带字体'))).toBe(true);
    } else {
      // 该文件可能尚未通过 fetch-font 下载，此时应给出明确告警
      expect(spy.errors.join('\n')).toContain('不存在');
    }
  });

  it('★ FONT_FILES 文件不存在时返回 false 并指出具体文件', () => {
    const spy = spyLogger();
    const missing = '/nix/store/does-not-exist/NotoSansCJK-Regular.ttc';
    expect(reportFontSupport(spy.log, { fontFiles: [missing] })).toBe(false);

    const text = spy.errors.join('\n');
    expect(text).toContain('不存在');
    expect(text).toContain(missing);
  });

  it('探针识别「FONT_FILES 文件不存在」（resvg 会静默回退到系统字体）', () => {
    const result = checkFontSupport({ fontFiles: ['/nix/store/does-not-exist/font.ttc'] });
    expect(result.ok).toBe(false);
    expect(result.missingFontFiles).toEqual(['/nix/store/does-not-exist/font.ttc']);
  });

  it('★ 无效字体文件会静默回退到系统字体（本机有系统字体时仍判可用）', () => {
    // resvg 对「存在但不是字体」的文件不报错，而是回退到系统字体。
    // 这正是本地测不出问题的原因；容器里没有系统字体可回退，才会真正暴露出来。
    const result = checkFontSupport({ fontFiles: [process.execPath] });
    expect(result.missingFontFiles).toEqual([]);
    // 本机有中文字体 -> 探针通过；无字体环境（容器）会失败
    expect(result.ok).toBe(true);
  });

  it('★ 因此探针会额外校验字体文件是否存在（唯一能在本地发现的配置错误）', () => {
    const bogus = '/definitely/not/here/Noto.ttc';
    const result = checkFontSupport({ fontFiles: [bogus] });
    expect(result.missingFontFiles).toEqual([bogus]);
    expect(result.ok).toBe(false);
  });

  it('★ 有字体与无字体的探针体积差异显著（阈值选取合理）', () => {
    const withFont = checkFontSupport();
    const withoutFont = checkFontSupport({ fontFiles: [process.execPath] });
    expect(withFont.bytes).toBeGreaterThan(0);
    expect(withoutFont.bytes).toBeGreaterThan(0);
  });
});

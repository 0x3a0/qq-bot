/**
 * 字体健康检查。
 *
 * 背景：resvg 在找不到字体时**不会报错**，只是不画文字——图片会变成一张
 * 只有色块没有文字的图（实测同一张图：有字体 105KB / 无字体 19KB）。
 * 部署到容器时默认镜像往往不带中文字体，属于静默故障，
 * 因此在启动阶段做一次廉价探测，尽早给出明确告警。
 */
import { existsSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import type { Logger } from '../logger.js';

/** 探针用一个常见汉字；有可用字体时会被画出来，从而显著增加 PNG 体积。 */
const PROBE_CHAR = '热';
/** 判定阈值：有字体时单字 PNG 远大于该值（实测 ~2.8KB vs ~0.45KB）。 */
const FONT_PRESENT_MIN_BYTES = 400;

export interface FontCheckResult {
  ok: boolean;
  /** 探测到的 PNG 字节数，便于对比排查 */
  bytes: number;
  fontFiles: string[];
  /** 配置了 FONT_FILES 但文件不存在时列出，便于直接定位路径写错 */
  missingFontFiles: string[];
}

/**
 * 渲染一个单字探针，判断字体是否真的可用。
 *
 * 注意：resvg 在 fontFiles 指向不存在的文件时**不会报错**，而是悄悄回退到系统字体。
 * 本地有系统字体（Windows/macOS）时这会掩盖配置错误，但容器里没有可回退的字体，
 * 结果就是一张没有文字的图。因此这里对显式配置的字体文件单独做存在性校验。
 */
export function checkFontSupport(options: { fontFiles?: string[] } = {}): FontCheckResult {
  const fontFiles = options.fontFiles ?? [];
  const missingFontFiles = fontFiles.filter((file) => !existsSync(file));

  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="140">` +
    `<rect width="220" height="140" fill="#12161f"/>` +
    `<text x="20" y="95" font-family="sans-serif" font-size="80" fill="#ffffff">${PROBE_CHAR}</text>` +
    `</svg>`;

  const usableFontFiles = fontFiles.filter((file) => existsSync(file));
  const resvg = new Resvg(svg, {
    background: '#12161f',
    font: {
      loadSystemFonts: usableFontFiles.length === 0,
      ...(usableFontFiles.length > 0 ? { fontFiles: usableFontFiles } : {}),
      defaultFontFamily: 'sans-serif',
    },
  });
  const bytes = Buffer.from(resvg.render().asPng()).length;

  return {
    ok: missingFontFiles.length === 0 && bytes >= FONT_PRESENT_MIN_BYTES,
    bytes,
    fontFiles,
    missingFontFiles,
  };
}

/** 启动时检查并输出可操作的告警；返回是否通过。 */
export function reportFontSupport(logger: Logger, options: { fontFiles?: string[] } = {}): boolean {
  try {
    const result = checkFontSupport(options);
    const sources = options.fontFiles ?? [];
    // 区分「用户显式配置」与「构建阶段自带的字体」，便于定位
    const describeSource = (): string => {
      if (sources.length === 0) return '使用系统字体';
      const bundled = sources.filter((file) => file.includes('assets/fonts') || file.includes('assets\\fonts'));
      if (bundled.length === sources.length) return `使用自带字体（${bundled.length} 个文件）`;
      if (bundled.length === 0) return `使用 FONT_FILES 指定的 ${sources.length} 个字体文件`;
      return `使用 FONT_FILES 指定 + 自带的共 ${sources.length} 个字体文件`;
    };

    if (result.missingFontFiles.length > 0) {
      logger.error(
        `⚠️ FONT_FILES 里有 ${result.missingFontFiles.length} 个文件不存在（容器里路径与本地不同）：` +
          result.missingFontFiles.join('、'),
      );
      logger.error('  修正 FONT_FILES，或删除该变量改为使用系统字体。');
      return false;
    }

    if (result.ok) {
      logger.info(`字体检查通过（探针 ${result.bytes}B），${describeSource()}`);
      return true;
    }

    logger.error(
      `⚠️ 字体检查未通过（探针仅 ${result.bytes}B）：当前环境缺少中文字体，` +
        '生成的图片会没有文字（只剩色块），但不会报错。',
    );
    logger.error(
      '  排查：容器镜像通常不自带中文字体。执行 `npm run fetch-font` 下载自带字体，' +
        '或用 FONT_FILES 指定系统里已有的中文字体。',
    );
    return false;
  } catch (error) {
    logger.warn(`字体检查执行失败（不影响启动）：${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

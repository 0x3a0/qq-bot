/**
 * 拉取中文字体（构建时执行）。
 *
 * 背景：部署环境（Render 的 Debian 12 原生运行时、多数容器镜像）**不带中文字体**，
 * 而 resvg 缺字形时不会报错，只会画成一排「框框」。字体每个约 8MB，
 * 不适合提交进仓库，因此在构建阶段下载到 assets/fonts/ 并做 SHA-256 校验。
 *
 * ⚠️ 必须下载 **静态字重**（Regular + Bold），不能用可变字体（VF）：
 *   - resvg 不支持 fvar/wght 轴，单个可变字体永远只会用它的 **默认实例**；
 *   - `NotoSansSC-VF.ttf` 的默认实例是 Thin（OS/2 usWeightClass=100），
 *     于是 SVG 里所有 font-weight（标题 700、板块名 600）都被静默忽略，
 *     整张图的字都变成发丝一样的极细体——在深色底上看起来就是「模糊」。
 *   - 实测：只给一个字体文件时，weight 100/400/600/700/900 渲染结果**逐字节相同**；
 *     给了 Regular+Bold 两个静态字体后，resvg 才会按 font-weight 选取字面。
 * 因此这里同时下载 Regular 与 Bold，缺一不可。
 *
 * 用法：
 *   node scripts/fetch-font.mjs            # 已存在且校验通过则跳过
 *   node scripts/fetch-font.mjs --force    # 强制重新下载
 *
 * 环境变量：
 *   FONT_DOWNLOAD_URL      覆盖 Regular 的下载地址（例如改用更快的镜像/CDN）
 *   FONT_DOWNLOAD_URL_BOLD 覆盖 Bold 的下载地址
 *
 * 失败策略：只告警不中断构建。字体缺失属于运行时可检测问题——
 * 启动时的字体探针会明确报错，比让整个部署失败更容易定位。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 仓库内字体目录（已加入 .gitignore，不入库） */
const TARGET_DIR = join(process.cwd(), 'assets', 'fonts');

/** 旧版可变字体文件名。默认实例是 Thin，会让整张图变成极细体，必须清理掉。 */
const LEGACY_VARIABLE_FONTS = ['NotoSansSC-Regular.ttf', 'NotoSansSC-VF.ttf'];

/** 需要下载的静态字重。顺序即 fontFiles 顺序，Regular 在前。 */
const FONTS = [
  {
    file: 'NotoSansSC-Regular.otf',
    envKey: 'FONT_DOWNLOAD_URL',
    url: 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf',
    sha256: 'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9',
  },
  {
    file: 'NotoSansSC-Bold.otf',
    envKey: 'FONT_DOWNLOAD_URL_BOLD',
    url: 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Bold.otf',
    sha256: 'c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0',
  },
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 已存在且校验通过的文件直接复用，避免重复下载 16MB。 */
function reuseExisting(target, expected) {
  if (!existsSync(target)) return false;
  return sha256(readFileSync(target)) === expected;
}

async function download(target, url, expected) {
  console.log(`[fetch-font] 下载中：${url}`);
  const startedAt = Date.now();
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = sha256(buffer);
  if (digest !== expected) {
    throw new Error(
      `校验失败：期望 ${expected}，实际 ${digest}。` +
        '若上游已更新，请同步修改本脚本里的 sha256',
    );
  }

  // 先写临时文件再改名，避免中断留下半截文件
  const tempFile = `${target}.part`;
  writeFileSync(tempFile, buffer);

  // 顺序很关键：Regular 校验通过后才允许替换，且只有两个都成功才保留
  renameSync(tempFile, target);
  console.log(
    `[fetch-font] 完成：${target}（${(buffer.length / 1024 / 1024).toFixed(2)} MB，` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
  );
}

/**
 * 删除旧的可变字体。
 *
 * 只在新的静态字体已经就位时才删——否则一旦下载失败，会把唯一可用的字体删掉，
 * 让图片从「字太细」退化成「完全没有字」。
 */
function removeLegacyVariableFonts() {
  const staticReady = FONTS.every(({ file, sha256: expected }) =>
    reuseExisting(join(TARGET_DIR, file), expected),
  );
  if (!staticReady) return;

  for (const name of LEGACY_VARIABLE_FONTS) {
    const legacy = join(TARGET_DIR, name);
    if (!existsSync(legacy)) continue;
    rmSync(legacy, { force: true });
    console.log(`[fetch-font] 已删除旧的可变字体（默认字重是 Thin，会导致字迹过细）：${legacy}`);
  }
}

async function main() {
  const force = process.argv.includes('--force');
  mkdirSync(TARGET_DIR, { recursive: true });

  const failed = [];

  for (const font of FONTS) {
    const target = join(TARGET_DIR, font.file);
    const url = process.env[font.envKey] || font.url;

    if (!force && reuseExisting(target, font.sha256)) {
      console.log(`[fetch-font] 已存在且校验通过，跳过：${target}`);
      continue;
    }
    if (existsSync(target) && !force) {
      console.warn(`[fetch-font] 已存在的字体校验不通过，将重新下载：${target}`);
    }

    try {
      await download(target, url, font.sha256);
    } catch (error) {
      rmSync(`${target}.part`, { force: true });
      failed.push(`${font.file}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  removeLegacyVariableFonts();

  if (failed.length > 0) {
    console.warn(`[fetch-font] ⚠️ 有 ${failed.length} 个字体下载失败：\n  - ${failed.join('\n  - ')}`);
    console.warn('[fetch-font]   构建继续，但图片可能没有中文或字重不正常：');
    console.warn('[fetch-font]   - 缺 Regular：中文会变成「框框」；');
    console.warn('[fetch-font]   - 缺 Bold：标题/板块名会退回细体（resvg 按 font-weight 选字面，需要两个静态字重）。');
    console.warn('[fetch-font]   可重跑该脚本、或用 FONT_DOWNLOAD_URL(_BOLD) 指定更快的镜像，');
    console.warn('[fetch-font]   也可直接把字体文件放到 assets/fonts/ 并设 FONT_FILES 指向它。');
    process.exitCode = 0;
  }
}

await main();

/**
 * 拉取中文字体（构建时执行）。
 *
 * 背景：部署环境（Render 的 Debian 12 原生运行时、多数容器镜像）**不带中文字体**，
 * 而 resvg 缺字形时不会报错，只会画成一排「框框」。字体文件有 17MB，
 * 不适合提交进仓库，因此在构建阶段下载到 assets/fonts/ 并做 SHA-256 校验。
 *
 * 用法：
 *   node scripts/fetch-font.mjs            # 已存在且校验通过则跳过
 *   node scripts/fetch-font.mjs --force    # 强制重新下载
 *
 * 环境变量：
 *   FONT_DOWNLOAD_URL  覆盖下载地址（例如改用更快的镜像/CDN）
 *
 * 失败策略：只告警不中断构建。字体缺失属于运行时可检测问题——
 * 启动时的字体探针会明确报错，比让整个部署失败更容易定位。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 仓库内字体目录（已加入 .gitignore，不入库） */
const TARGET_DIR = join(process.cwd(), 'assets', 'fonts');
const TARGET_FILE = join(TARGET_DIR, 'NotoSansSC-Regular.ttf');

/** 官方 Noto Sans SC（简体子集，可变字体），OFL-1.1 许可 */
const DEFAULT_URL =
  'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf';

/** 期望的 SHA-256（上游内容变化时会校验失败，届时需更新此值） */
const EXPECTED_SHA256 = 'd68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function verify(buffer) {
  const digest = sha256(buffer);
  return { ok: digest === EXPECTED_SHA256, digest };
}

async function main() {
  const force = process.argv.includes('--force');
  const url = process.env.FONT_DOWNLOAD_URL || DEFAULT_URL;

  if (existsSync(TARGET_FILE) && !force) {
    const existing = readFileSync(TARGET_FILE);
    const { ok } = verify(existing);
    if (ok) {
      console.log(`[fetch-font] 已存在且校验通过，跳过：${TARGET_FILE}`);
      return;
    }
    console.warn('[fetch-font] 已存在的字体校验不通过，将重新下载');
  }

  console.log(`[fetch-font] 下载中：${url}`);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const { ok, digest } = verify(buffer);
    if (!ok) {
      throw new Error(
        `校验失败：期望 ${EXPECTED_SHA256}，实际 ${digest}。` +
          '若上游已更新，请同步修改本脚本里的 EXPECTED_SHA256',
      );
    }

    mkdirSync(dirname(TARGET_FILE), { recursive: true });
    // 先写临时文件再改名，避免中断留下半截文件
    const tempFile = `${TARGET_FILE}.part`;
    writeFileSync(tempFile, buffer);
    renameSync(tempFile, TARGET_FILE);

    console.log(
      `[fetch-font] 完成：${TARGET_FILE}（${(buffer.length / 1024 / 1024).toFixed(2)} MB，` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
    );
  } catch (error) {
    rmSync(`${TARGET_FILE}.part`, { force: true });
    console.warn(`[fetch-font] ⚠️ 字体下载失败：${error instanceof Error ? error.message : String(error)}`);
    console.warn('[fetch-font]   构建继续。若运行时图片中文显示为「框框」，说明该环境没有中文字体：');
    console.warn('[fetch-font]   可重跑该脚本、或用 FONT_DOWNLOAD_URL 指定更快的镜像，');
    console.warn('[fetch-font]   也可直接把字体文件放到 assets/fonts/ 并设 FONT_FILES 指向它。');
  }
}

await main();

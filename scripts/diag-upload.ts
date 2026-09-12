/**
 * 富媒体分片上传诊断：逐步打印 upload_prepare / PUT / part_finish / merge 的原始响应。
 *
 * 用法：
 *   npx tsx scripts/diag-upload.ts <group_openid> [图片路径]
 * 默认使用 .tmp-probe/preview/market-sample.png。
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadDotEnv } from '../src/env.js';
import { createLogger, describeError, setLogLevel } from '../src/logger.js';
import { QqApiClient, md5, MD5_10M_BYTES } from '../src/qq/api-client.js';
import { TokenManager } from '../src/qq/token.js';
import { createHash } from 'node:crypto';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  setLogLevel('debug');

  const groupOpenid = process.argv[2];
  if (!groupOpenid) {
    console.error('用法：npx tsx scripts/diag-upload.ts <group_openid> [图片路径]');
    process.exitCode = 2;
    return;
  }
  const filePath = process.argv[3] ?? join(process.cwd(), '.tmp-probe', 'preview', 'market-sample.png');

  const logger = createLogger('diag-upload');
  const tokens = new TokenManager({ appId: config.appId, clientSecret: config.clientSecret, logger });
  const api = new QqApiClient({ apiBase: config.apiBase, tokens, logger });

  const buffer = await readFile(filePath);
  const fileSize = (await stat(filePath)).size;
  const fileName = filePath.split(/[\\/]/).pop() ?? 'image.png';

  console.log(`\n文件：${filePath}`);
  console.log(`大小：${fileSize} 字节，文件名：${fileName}`);
  console.log(`md5=${md5(buffer)}`);
  console.log(`sha1=${createHash('sha1').update(buffer).digest('hex')}`);
  console.log(`md5_10m=${md5(buffer.subarray(0, MD5_10M_BYTES))}`);

  console.log('\n--- [1/4] upload_prepare ---');
  const prepare = await api.uploadPrepare({
    groupOpenid,
    fileType: 1,
    fileSize,
    fileName,
    md5: md5(buffer),
    sha1: createHash('sha1').update(buffer).digest('hex'),
    md5_10m: md5(buffer.subarray(0, MD5_10M_BYTES)),
  });
  console.log(JSON.stringify(prepare, null, 2));

  console.log('\n--- [2/4] PUT 分片 ---');
  // 服务端 index 实测为 1-based，偏移按 (index - 1) * blockSize 计算
  const sortedParts = [...prepare.parts].sort((a, b) => a.index - b.index);
  for (const part of sortedParts) {
    const partSize = part.blockSize > 0 ? part.blockSize : prepare.blockSize;
    const start = (part.index - 1) * partSize;
    const end = Math.min(start + partSize, buffer.length);
    const chunk = buffer.subarray(start, end);
    console.log(`分片 ${part.index}: bytes ${start}..${end}（${chunk.length} 字节）`);
    const put = await fetch(part.presignedUrl, {
      method: 'PUT',
      body: new Uint8Array(chunk),
      headers: { 'Content-Length': String(chunk.length) },
    });
    console.log(`  PUT 状态：${put.status} ${put.statusText}`);
    const text = await put.text().catch(() => '');
    if (text) console.log(`  PUT 响应：${text.slice(0, 300)}`);
    if (!put.ok) throw new Error(`分片 ${part.index} PUT 失败`);

    console.log('\n--- [3/4] upload_part_finish ---');
    await api.uploadPartFinish({
      groupOpenid,
      uploadId: prepare.uploadId,
      partIndex: part.index,
      blockSize: chunk.length,
      md5: md5(chunk),
    });
    console.log(`  分片 ${part.index} 完成确认 OK`);
  }

  console.log('\n--- [4/4] merge（携带 upload_id 调 /files）---');
  try {
    const merged = await api.uploadMerge({ groupOpenid, uploadId: prepare.uploadId, fileType: 1, fileName });
    console.log('合并成功：', JSON.stringify(merged));
  } catch (error) {
    console.error('合并失败：', describeError(error));
    if (error instanceof Error && 'body' in error) {
      console.error('响应体：', (error as { body: string }).body);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('诊断失败：', describeError(error));
  process.exitCode = 1;
});

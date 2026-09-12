import { describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QqApiClient, QqApiError, MD5_10M_BYTES, md5 } from '../src/qq/api-client.js';
import { createLogger } from '../src/logger.js';
import type { TokenManager } from '../src/qq/token.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};

const tokens = {
  getToken: async () => 'tok',
  get: async () => ({ token: 'tok', expiresAt: Date.now() + 3600_000 }),
  getAuthorizationHeader: async () => 'QQBot tok',
  refresh: async () => ({ token: 'tok', expiresAt: Date.now() + 3600_000 }),
  invalidate: () => {},
} as unknown as TokenManager;

function createClient(fetchImpl: typeof fetch): QqApiClient {
  return new QqApiClient({ apiBase: 'https://api.bot.qq.com', tokens, logger, fetchImpl });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('QqApiClient', () => {
  it('携带 Authorization 头并以 apiBase 拼接路径', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bot.qq.com/gateway');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('QQBot tok');
      return json({ url: 'wss://api.bot.qq.com/websocket/' });
    });
    const client = createClient(fetchImpl as unknown as typeof fetch);
    expect(await client.getGatewayUrl()).toBe('wss://api.bot.qq.com/websocket/');
  });

  it('getGatewayUrl 缺少 url 字段时抛错', async () => {
    const client = createClient((async () => json({ ok: true })) as unknown as typeof fetch);
    await expect(client.getGatewayUrl()).rejects.toThrow(/缺少 url/);
  });

  it('sendGroupText 使用 msg_type=0 并携带 msg_id/msg_seq', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bot.qq.com/v2/groups/GROUP/messages');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        msg_type: 0,
        content: 'pong',
        msg_id: 'MSG1',
        msg_seq: 1,
      });
      return json({ id: 'ROBOT1.0_reply', timestamp: '2026-01-01T00:00:00+08:00' });
    });
    const client = createClient(fetchImpl as unknown as typeof fetch);
    const result = await client.sendGroupText({
      groupOpenid: 'GROUP',
      content: 'pong',
      msgId: 'MSG1',
      msgSeq: 1,
    });
    expect(result.id).toBe('ROBOT1.0_reply');
  });

  it('sendGroupImage 使用 msg_type=7 与 media.file_info', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.msg_type).toBe(7);
      expect(body.media).toEqual({ file_info: 'FILE_INFO' });
      expect(body.msg_id).toBe('MSG1');
      expect(body.msg_seq).toBe(1);
      return json({ id: 'ROBOT1.0_img', ext_info: { ref_idx: 'REFIDX_1' } });
    });
    const client = createClient(fetchImpl as unknown as typeof fetch);
    const result = await client.sendGroupImage({
      groupOpenid: 'GROUP',
      fileInfo: 'FILE_INFO',
      msgId: 'MSG1',
      msgSeq: 1,
    });
    expect(result.refIdx).toBe('REFIDX_1');
  });

  it('uploadPrepare 转换字符串数值并映射字段名', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body.file_size).toBe('1024');
      expect(body.md5_10m).toBe('abc');
      expect(body.file_type).toBe(1);
      return json({
        upload_id: 'upload_1',
        block_size: '1048576',
        parts: [{ index: 0, presigned_url: 'https://cos.example/p0', block_size: '1048576' }],
        upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
      });
    });
    const client = createClient(fetchImpl as unknown as typeof fetch);
    const prepare = await client.uploadPrepare({
      groupOpenid: 'GROUP',
      fileType: 1,
      fileSize: 1024,
      fileName: 'a.png',
      md5: 'md5',
      sha1: 'sha1',
      md5_10m: 'abc',
    });
    expect(prepare.uploadId).toBe('upload_1');
    expect(prepare.blockSize).toBe(1_048_576);
    expect(prepare.parts).toEqual([{ index: 0, presignedUrl: 'https://cos.example/p0', blockSize: 1_048_576 }]);
  });

  it('错误响应抛出 QqApiError 并保留 err_code 与 trace id', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ err_code: 40034005, message: '回复消息msg_id已过期' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'x-tps-trace-id': 'trace-123' },
        }),
    );
    const client = createClient(fetchImpl as unknown as typeof fetch);
    await expect(client.sendGroupText({ groupOpenid: 'G', content: 'x', msgId: 'M' })).rejects.toMatchObject({
      name: 'QqApiError',
      code: 40034005,
      status: 400,
      traceId: 'trace-123',
    });
  });

  it('上传响应缺少 file_info 时抛错', async () => {
    const client = createClient((async () => json({ file_uuid: 'u' })) as unknown as typeof fetch);
    await expect(
      client.uploadGroupFileByUrl({ groupOpenid: 'G', url: 'https://example.com/a.png' }),
    ).rejects.toThrow(/file_info/);
  });

  it('204 空响应返回 undefined 且不抛错', async () => {
    const client = createClient((async () => new Response(null, { status: 204 })) as unknown as typeof fetch);
    await expect(client.uploadPartFinish({ groupOpenid: 'G', uploadId: 'u', partIndex: 0, blockSize: 1, md5: 'm' })).resolves.toBeUndefined();
  });
});

describe('分片上传（1-based index 回归）', () => {
  /** 记录每个分片实际 PUT 的字节数，以及 part_finish 上报的 part_index。 */
  function createUploadFetch(sizes: number[], firstIndex: number) {
    const puts: { index: number; bytes: number }[] = [];
    const finishes: number[] = [];
    let partCursor = 0;

    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/upload_prepare')) {
        return json({
          upload_id: 'upload_test',
          block_size: String(sizes[0]),
          parts: sizes.map((size, offset) => ({
            index: firstIndex + offset,
            presigned_url: `https://cos.example/part-${firstIndex + offset}`,
            block_size: String(size),
          })),
          upload_config: { concurrency: 1, retry_timeout: 30, retry_delay: 1 },
        });
      }
      if (target.includes('/upload_part_finish')) {
        const body = JSON.parse(String(init?.body)) as { part_index: number };
        finishes.push(body.part_index);
        return json({});
      }
      if (target.startsWith('https://cos.example/')) {
        const bytes = (init?.body as Uint8Array).length;
        puts.push({ index: Number(target.split('-').pop()), bytes });
        partCursor += 1;
        return new Response(null, { status: 200 });
      }
      // merge
      return json({ file_info: 'FILE_INFO_OK', ttl: 86400 });
    });

    return { fetchImpl, puts, finishes, expectedParts: partCursor };
  }

  it('★ 服务端 index 为 1-based 时，每个分片都上传真实字节（不再上传 0 字节）', async () => {
    // 模拟实测场景：单分片、index=1
    const { fetchImpl, puts, finishes } = createUploadFetch([1024], 1);
    const client = createClient(fetchImpl as unknown as typeof fetch);
    const filePath = join(tmpdir(), `qq-bot-upload-${Date.now()}.bin`);
    await writeFile(filePath, Buffer.alloc(1024, 7));

    try {
      const uploaded = await client.uploadGroupFileFromPath({
        groupOpenid: 'G',
        filePath,
        fileName: 'a.png',
        fileType: 1,
      });
      expect(uploaded.fileInfo).toBe('FILE_INFO_OK');
      expect(puts).toEqual([{ index: 1, bytes: 1024 }]);
      expect(finishes).toEqual([1]);
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it('★ 多分片：偏移按 (index - 1) * blockSize 计算，总字节数等于文件大小', async () => {
    const { fetchImpl, puts, finishes } = createUploadFetch([500, 300, 200], 1);
    const client = createClient(fetchImpl as unknown as typeof fetch);
    const filePath = join(tmpdir(), `qq-bot-upload-multi-${Date.now()}.bin`);
    await writeFile(filePath, Buffer.alloc(1000, 3));

    try {
      await client.uploadGroupFileFromPath({ groupOpenid: 'G', filePath, fileName: 'big.png', fileType: 1 });
      expect(puts.map((item) => item.bytes)).toEqual([500, 300, 200]);
      expect(puts.reduce((sum, item) => sum + item.bytes, 0)).toBe(1000);
      expect(finishes).toEqual([1, 2, 3]);
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it('分片偏移越界时立即报错，不再发起无用上传', async () => {
    // 文件只有 100 字节，但服务端声称第一片 200 字节、第二片从偏移 200 开始 -> 越界
    const { fetchImpl, puts } = createUploadFetch([200, 200], 1);
    const client = createClient(fetchImpl as unknown as typeof fetch);
    const filePath = join(tmpdir(), `qq-bot-upload-oob-${Date.now()}.bin`);
    await writeFile(filePath, Buffer.alloc(100, 1));

    try {
      await expect(
        client.uploadGroupFileFromPath({ groupOpenid: 'G', filePath, fileName: 'x.png', fileType: 1 }),
      ).rejects.toThrow(/超出文件大小/);
      expect(puts).toHaveLength(1);
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it('总上传字节数与文件大小不符时报错（防止合并空文件）', async () => {
    // 服务端只下发到偏移 100 之前的分片，文件却有 300 字节
    const { fetchImpl } = createUploadFetch([100], 1);
    const client = createClient(fetchImpl as unknown as typeof fetch);
    const filePath = join(tmpdir(), `qq-bot-upload-short-${Date.now()}.bin`);
    await writeFile(filePath, Buffer.alloc(300, 1));

    try {
      await expect(
        client.uploadGroupFileFromPath({ groupOpenid: 'G', filePath, fileName: 'x.png', fileType: 1 }),
      ).rejects.toThrow(/字节数不匹配/);
    } finally {
      await rm(filePath, { force: true });
    }
  });
});

describe('md5 工具', () => {
  it('与已知摘要一致', () => {
    expect(md5(Buffer.from('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('MD5_10M_BYTES 为文档规定的 10002432', () => {
    expect(MD5_10M_BYTES).toBe(10_002_432);
  });
});

describe('QqApiError', () => {
  it('保留错误字段', () => {
    const error = new QqApiError({ status: 500, code: 1, message: 'boom', body: '{}' });
    expect(error.message).toBe('boom');
    expect(error.name).toBe('QqApiError');
  });
});

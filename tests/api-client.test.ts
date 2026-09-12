import { describe, expect, it, vi } from 'vitest';
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

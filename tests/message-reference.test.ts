import { describe, expect, it, vi } from 'vitest';
import { extractMessageIndex, type QqMessageScene } from '../src/qq/types.js';
import { QqApiClient } from '../src/qq/api-client.js';
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

describe('extractMessageIndex', () => {
  it('★ 从 message_scene.ext 取出 msg_idx（引用回复要用它）', () => {
    const scene: QqMessageScene = {
      source: 'default',
      ext: ['msg_idx=REFIDX_xxxxxxxxxxxxxxx==', 'auth_token=abcdef'],
    };
    expect(extractMessageIndex(scene)).toBe('REFIDX_xxxxxxxxxxxxxxx==');
  });

  it('ext 顺序变化也能取到', () => {
    const scene: QqMessageScene = {
      ext: ['auth_token=abcdef', 'msg_idx=REFIDX_yyyy==', 'ref_msg_idx=TMP_zzz'],
    };
    expect(extractMessageIndex(scene)).toBe('REFIDX_yyyy==');
  });

  it('没有 msg_idx 时返回 null', () => {
    expect(extractMessageIndex({ ext: ['auth_token=abc'] })).toBeNull();
    expect(extractMessageIndex({ ext: [] })).toBeNull();
    expect(extractMessageIndex({})).toBeNull();
    expect(extractMessageIndex(undefined)).toBeNull();
  });

  it('非法 ext 内容不会抛错', () => {
    expect(extractMessageIndex({ ext: ['', 'msg_idx=', '=x'] })).toBeNull();
    expect(extractMessageIndex({ ext: [undefined as unknown as string] })).toBeNull();
  });
});

describe('引用回复的请求体', () => {
  function createClient(): { client: QqApiClient; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'ROBOT1.0_x' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return {
      client: new QqApiClient({
        apiBase: 'https://api.bot.qq.com',
        tokens,
        logger,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      bodies,
    };
  }

  it('★ 发送图片时带 message_reference', async () => {
    const { client, bodies } = createClient();
    await client.sendGroupImage({
      groupOpenid: 'G',
      fileInfo: 'FILE_INFO',
      msgId: 'MSG1',
      msgSeq: 1,
      messageReference: 'REFIDX_abc==',
    });
    expect(bodies[0]).toMatchObject({
      msg_type: 7,
      media: { file_info: 'FILE_INFO' },
      msg_id: 'MSG1',
      msg_seq: 1,
      message_reference: { message_id: 'REFIDX_abc==' },
    });
  });

  it('★ 发送文本时带 message_reference', async () => {
    const { client, bodies } = createClient();
    await client.sendGroupText({
      groupOpenid: 'G',
      content: 'pong',
      msgId: 'MSG1',
      msgSeq: 1,
      messageReference: 'REFIDX_abc==',
    });
    expect(bodies[0]).toMatchObject({
      msg_type: 0,
      content: 'pong',
      message_reference: { message_id: 'REFIDX_abc==' },
    });
  });

  it('未提供引用时不带 message_reference 字段', async () => {
    const { client, bodies } = createClient();
    await client.sendGroupImage({ groupOpenid: 'G', fileInfo: 'F', msgId: 'MSG1', msgSeq: 1 });
    expect(bodies[0]).not.toHaveProperty('message_reference');
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupMessageHandler, SEQ_FALLBACK, SEQ_PRIMARY, type MessageHandlingDeps } from '../src/commands/bot.js';
import { createLogger } from '../src/logger.js';
import { MessageDeduplicator } from '../src/qq/dedupe.js';
import type { MarketBlock, MarketSnapshot } from '../src/market/types.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};

const blocks: MarketBlock[] = Array.from({ length: 25 }, (_, index) => ({
  code: `BK${index}`,
  name: `板块${index}`,
  changePercent: index % 2 === 0 ? 1.5 : -1.2,
  turnover: (25 - index) * 1e9,
  quoteTimestamp: 1_752_000_000,
}));

const snapshot: MarketSnapshot = {
  market: 'A股',
  source: '东方财富',
  quoteTime: new Date(1_752_000_000 * 1000),
  fetchedAt: new Date(),
  blocks,
};

interface RecordedCalls {
  uploads: unknown[];
  images: unknown[];
  texts: { content: string; msgSeq?: number }[];
}

function createHarness(overrides: Partial<MessageHandlingDeps> = {}): {
  handler: GroupMessageHandler;
  calls: RecordedCalls;
  deps: MessageHandlingDeps;
} {
  const calls: RecordedCalls = { uploads: [], images: [], texts: [] };

  const api = {
    uploadGroupFileFromPath: vi.fn(async (params: unknown) => {
      calls.uploads.push(params);
      return { fileInfo: 'FILE_INFO_1' };
    }),
    sendGroupImage: vi.fn(async (params: unknown) => {
      calls.images.push(params);
      return { id: 'ROBOT1.0_sent' };
    }),
    sendGroupText: vi.fn(async (params: { content: string; msgSeq?: number }) => {
      calls.texts.push(params);
      return { id: 'ROBOT1.0_text' };
    }),
  };

  const deps: MessageHandlingDeps = {
    api: api as unknown as MessageHandlingDeps['api'],
    market: { getIndustrySnapshot: async () => snapshot },
    logger,
    dedupe: new MessageDeduplicator(),
    imageOutputDir: undefined,
    renderer: (() => ({
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      svg: '<svg/>',
      width: 1200,
      height: 900,
      tiles: [],
    })) as unknown as MessageHandlingDeps['renderer'],
    ...overrides,
  };

  return { handler: new GroupMessageHandler(deps), calls, deps };
}

const message = {
  messageId: 'ROBOT1.0_msg',
  groupOpenid: 'GROUP_OPENID',
  content: '大盘',
  username: '小明',
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'qq-bot-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('GroupMessageHandler', () => {
  it('大盘指令：上传图片并以 msg_type=7 被动回复（msg_seq=1）', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    const outcome = await handler.handle(message);

    expect(outcome).toBe('image-sent');
    expect(calls.uploads).toHaveLength(1);
    expect(calls.images).toHaveLength(1);
    expect(calls.texts).toHaveLength(0);

    const imageCall = calls.images[0] as { fileInfo: string; msgId: string; msgSeq: number; groupOpenid: string };
    expect(imageCall.fileInfo).toBe('FILE_INFO_1');
    expect(imageCall.msgId).toBe('ROBOT1.0_msg');
    expect(imageCall.msgSeq).toBe(SEQ_PRIMARY);
    expect(imageCall.groupOpenid).toBe('GROUP_OPENID');
  });

  it('上传时使用 file_type=1（图片）', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    await handler.handle(message);
    const uploadCall = calls.uploads[0] as { fileType: number; fileName: string };
    expect(uploadCall.fileType).toBe(1);
    expect(uploadCall.fileName).toMatch(/\.png$/);
  });

  it('渲染时只取成交额前 20 个板块', async () => {
    const renderer = vi.fn((_options: unknown) => ({
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      svg: '<svg/>',
      width: 1200,
      height: 900,
      tiles: [],
    }));
    const { handler } = createHarness({
      imageOutputDir: tempDir,
      renderer: renderer as unknown as MessageHandlingDeps['renderer'],
    });
    await handler.handle(message);
    const options = renderer.mock.calls[0]?.[0] as unknown as { blocks: MarketBlock[]; source: string };
    expect(options.blocks).toHaveLength(20);
    expect(options.source).toBe('东方财富');
  });

  it('重复事件不会重复发图', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    expect(await handler.handle(message)).toBe('image-sent');
    expect(await handler.handle(message)).toBe('duplicate');
    expect(calls.images).toHaveLength(1);
  });

  it('ping 指令回复文本且不调用图片接口', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    const outcome = await handler.handle({ ...message, content: 'ping' });
    expect(outcome).toBe('text-sent');
    expect(calls.texts).toHaveLength(1);
    expect(calls.texts[0]?.content).toContain('pong');
    expect(calls.images).toHaveLength(0);
    expect(calls.uploads).toHaveLength(0);
  });

  it('帮助指令返回指令说明', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    await handler.handle({ ...message, content: '帮助' });
    expect(calls.texts[0]?.content).toContain('大盘');
  });

  it('无法识别的消息被忽略且不回复', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    expect(await handler.handle({ ...message, content: '今天天气不错' })).toBe('ignored');
    expect(calls.texts).toHaveLength(0);
    expect(calls.images).toHaveLength(0);
  });

  it('不在白名单的群被忽略', async () => {
    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      allowedGroups: new Set(['OTHER_GROUP']),
    });
    expect(await handler.handle(message)).toBe('forbidden');
    expect(calls.images).toHaveLength(0);
  });

  it('行情数据失败时返回文字兜底', async () => {
    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      market: {
        getIndustrySnapshot: async () => {
          throw new Error('东方财富接口 HTTP 502');
        },
      },
    });
    const outcome = await handler.handle(message);
    expect(outcome).toBe('fallback-sent');
    expect(calls.images).toHaveLength(0);
    expect(calls.texts).toHaveLength(1);
    expect(calls.texts[0]?.content).toContain('图片生成失败');
    expect(calls.texts[0]?.msgSeq).toBe(SEQ_FALLBACK);
  });

  it('渲染失败时降级为文字 TOP10', async () => {
    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      renderer: (() => {
        throw new Error('resvg 渲染失败');
      }) as unknown as MessageHandlingDeps['renderer'],
    });
    const outcome = await handler.handle(message);
    expect(outcome).toBe('fallback-sent');
    expect(calls.texts[0]?.content).toContain('TOP10');
    expect(calls.texts[0]?.content).toContain('板块0');
  });

  it('上传失败时降级为文字兜底，且允许后续重试', async () => {
    const uploadMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('分片上传失败'))
      .mockResolvedValue({ fileInfo: 'FILE_INFO_RETRY' });
    const { calls } = createHarness({ imageOutputDir: tempDir });

    const handler = createHarness({
      imageOutputDir: tempDir,
      api: {
        uploadGroupFileFromPath: uploadMock,
        sendGroupImage: vi.fn(async (params: unknown) => {
          calls.images.push(params);
          return {};
        }),
        sendGroupText: vi.fn(async (params: { content: string; msgSeq?: number }) => {
          calls.texts.push(params);
          return {};
        }),
      } as unknown as MessageHandlingDeps['api'],
    }).handler;

    expect(await handler.handle(message)).toBe('fallback-sent');
    // 图片发送失败后释放去重标记，第二次相同事件可以重试成功
    expect(await handler.handle(message)).toBe('image-sent');
    expect(calls.images).toHaveLength(1);
  });

  it('文字回复也失败时不抛出致命异常', async () => {
    const { handler } = createHarness({
      imageOutputDir: tempDir,
      api: {
        uploadGroupFileFromPath: vi.fn(async () => ({ fileInfo: 'F' })),
        sendGroupImage: vi.fn(async () => ({})),
        sendGroupText: vi.fn(async () => {
          throw new Error('发送失败');
        }),
      } as unknown as MessageHandlingDeps['api'],
    });
    expect(await handler.handle({ ...message, content: 'ping' })).toBe('ignored');
  });
});

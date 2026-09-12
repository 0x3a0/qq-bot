import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupMessageHandler, type MessageHandlingDeps } from '../src/commands/bot.js';
import { createLogger } from '../src/logger.js';
import { QqApiError } from '../src/qq/api-client.js';
import { MessageDeduplicator } from '../src/qq/dedupe.js';
import type { MarketBlock, MarketSnapshot } from '../src/market/types.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};

const blocks: MarketBlock[] = Array.from({ length: 35 }, (_, index) => ({
  code: `BK${index}`,
  name: `板块${index}`,
  changePercent: index % 2 === 0 ? 1.5 : -1.2,
  turnover: (35 - index) * 1e9,
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
  it('★ 大盘指令：先发文字 TOP30 榜单，再发图片（msg_seq 递增）', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    const outcome = await handler.handle(message);

    expect(outcome).toBe('image-sent');
    expect(calls.uploads).toHaveLength(1);
    expect(calls.images).toHaveLength(1);
    // 先文字、后图片
    expect(calls.texts).toHaveLength(1);

    const textCall = calls.texts[0] as { content: string; msgSeq: number };
    expect(textCall.msgSeq).toBe(1);
    expect(textCall.content).toContain('行业板块成交额 TOP30');
    expect(textCall.content).toContain(' 1. 板块0 +1.50%');
    expect(textCall.content).toContain('30. 板块29');
    expect(textCall.content.split('\n').filter((line) => /^\s*\d+\. /.test(line))).toHaveLength(30);

    const imageCall = calls.images[0] as { fileInfo: string; msgId: string; msgSeq: number; groupOpenid: string };
    expect(imageCall.fileInfo).toBe('FILE_INFO_1');
    expect(imageCall.msgId).toBe('ROBOT1.0_msg');
    expect(imageCall.msgSeq).toBe(2);
    expect(imageCall.groupOpenid).toBe('GROUP_OPENID');
  });

  it('文字榜单内容按成交额降序且带涨跌幅与成交额', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    await handler.handle(message);
    const lines = (calls.texts[0] as { content: string }).content.split('\n');
    // 第 1 名成交额 35e9 = 350亿，第 2 名 34e9 = 340亿
    expect(lines.find((line) => line.startsWith(' 1. '))).toBe(' 1. 板块0 +1.50% 350亿');
    expect(lines.find((line) => line.startsWith(' 2. '))).toBe(' 2. 板块1 -1.20% 340亿');
    expect(lines.find((line) => line.startsWith('30. '))).toBe('30. 板块29 -1.20% 60亿');
  });

  it('上传时使用 file_type=1（图片）', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    await handler.handle(message);
    const uploadCall = calls.uploads[0] as { fileType: number; fileName: string };
    expect(uploadCall.fileType).toBe(1);
    expect(uploadCall.fileName).toMatch(/\.png$/);
  });

  it('渲染时只取成交额前 30 个板块', async () => {
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
    expect(options.blocks).toHaveLength(30);
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
    // 兜底文案使用认领到的第 1 个序号（全局按 msg_id 递增，不再硬编码）
    expect(calls.texts[0]?.msgSeq).toBe(1);
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

  it('★ 发图被判重（40054005）时换 msg_seq 重试，最终发图成功', async () => {
    const sendGroupImage = vi
      .fn()
      .mockRejectedValueOnce(new QqApiError({ status: 400, code: 40054005, message: '消息被去重', body: '{}' }))
      .mockResolvedValue({ id: 'ROBOT1.0_sent' });

    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      api: {
        uploadGroupFileFromPath: vi.fn(async (params: unknown) => {
          calls.uploads.push(params);
          return { fileInfo: 'FILE_INFO_1' };
        }),
        sendGroupImage,
        sendGroupText: vi.fn(async (params: { content: string; msgSeq?: number }) => {
          calls.texts.push(params);
          return {};
        }),
      } as unknown as MessageHandlingDeps['api'],
    });

    expect(await handler.handle(message)).toBe('image-sent');
    expect(sendGroupImage).toHaveBeenCalledTimes(2);
    const seqs = sendGroupImage.mock.calls.map((call) => (call[0] as { msgSeq: number }).msgSeq);
    // 文字榜单占用 seq=1，图片从 seq=2 开始；重试必须换 seq，不能沿用被平台判重的那个
    expect(seqs).toEqual([2, 3]);
    // 只发了文字榜单（seq=1），没有额外的兜底文案
    expect(calls.texts).toHaveLength(1);
  });

  it('★ 连续判重时持续换 seq，用尽后放弃且不再补发文字', async () => {
    const sendGroupImage = vi
      .fn()
      .mockRejectedValue(new QqApiError({ status: 400, code: 40054005, message: '消息被去重', body: '{}' }));

    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      api: {
        uploadGroupFileFromPath: vi.fn(async () => ({ fileInfo: 'F' })),
        sendGroupImage,
        sendGroupText: vi.fn(async (params: { content: string; msgSeq?: number }) => {
          calls.texts.push(params);
          return {};
        }),
      } as unknown as MessageHandlingDeps['api'],
    });

    expect(await handler.handle(message)).toBe('reply-limit');
    const seqs = sendGroupImage.mock.calls.map((call) => (call[0] as { msgSeq: number }).msgSeq);
    // seq=1 被文字榜单占用，图片可用 2..5，用尽后放弃
    expect(seqs).toEqual([2, 3, 4, 5]);
    // 序号用尽后不能再发文字，否则会撞上平台「被动回复次数超限」
    expect(calls.texts).toHaveLength(1);
  });

  it('★ 上传失败时用文字兜底，且不重复占用同一 msg_seq', async () => {
    const uploadMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('分片上传失败'))
      .mockResolvedValue({ fileInfo: 'FILE_INFO_RETRY' });
    const { handler, calls } = createHarness({
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
    });

    expect(await handler.handle(message)).toBe('fallback-sent');
    // 同一 msg_id 的重投事件不再重复处理（避免重复回复）
    expect(await handler.handle(message)).toBe('duplicate');
    expect(calls.texts).toHaveLength(1);
    expect(calls.texts[0]?.msgSeq).toBe(1);
  });

  it('★ 同一 msg_id 被重投时使用不同的 msg_seq，不再撞平台判重', async () => {
    // 模拟平台对同一 msg_id 重投：绕过事件级去重，直接重复处理同一事件
    const dedupe = new MessageDeduplicator();
    const { handler, calls } = createHarness({ imageOutputDir: tempDir, dedupe });
    const sameId = { ...message, messageId: 'SAME_ID' };

    expect(await handler.handle(sameId)).toBe('image-sent');
    // 手动清掉事件级标记，等价于平台把同一 msg_id 又推了一次
    dedupe.delete(`${sameId.groupOpenid}:${sameId.messageId}#event`);
    expect(await handler.handle(sameId)).toBe('image-sent');

    const seqs = calls.images.map((call) => (call as { msgSeq: number }).msgSeq);
    // 每次回复两条（文字+图片）：第 1 次用 1/2，第 2 次用 3/4
    expect(seqs).toEqual([2, 4]);
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

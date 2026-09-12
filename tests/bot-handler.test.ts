import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupMessageHandler, type MessageHandlingDeps } from '../src/commands/bot.js';
import { createLogger } from '../src/logger.js';
import { QqApiError } from '../src/qq/api-client.js';
import { MessageDeduplicator } from '../src/qq/dedupe.js';
import type { FundFlowSnapshot, SectorFundFlow, SectorKind } from '../src/market/fundflow-types.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

/** 构造一个板块资金流快照；主力净额从 35e8 递减，保证前 25 名都为正。 */
function makeSectors(prefix: string): SectorFundFlow[] {
  return Array.from({ length: 35 }, (_, index) => ({
    code: `${prefix}${index}`,
    name: `${prefix}板块${index}`,
    changePercent: index % 2 === 0 ? 1.5 : -1.2,
    mainNet: (35 - index) * 1e8,
    mainNetRatio: 2.5,
    superNet: (35 - index) * 0.8e8,
    superNetRatio: 2,
    bigNet: (35 - index) * 0.2e8,
    bigNetRatio: 0.5,
    midNet: -(35 - index) * 0.6e8,
    midNetRatio: -1.5,
    smallNet: -(35 - index) * 0.4e8,
    smallNetRatio: -1,
  }));
}

function makeSnapshot(kind: SectorKind): FundFlowSnapshot {
  return {
    kind,
    period: 'today',
    source: '东方财富',
    quoteTime: new Date(1_752_000_000 * 1000),
    fetchedAt: new Date(),
    sectors: makeSectors(kind === 'industry' ? 'HY' : 'GN'),
  };
}

interface RecordedCalls {
  uploads: { fileName?: string }[];
  images: { fileInfo: string; msgSeq: number; msgId: string }[];
  texts: { content: string; msgSeq?: number }[];
  /** 各事件的相对顺序，用于断言「先渲染完先发」 */
  order: string[];
}

function createHarness(overrides: Partial<MessageHandlingDeps> = {}): {
  handler: GroupMessageHandler;
  calls: RecordedCalls;
  deps: MessageHandlingDeps;
} {
  const calls: RecordedCalls = { uploads: [], images: [], texts: [], order: [] };

  const api = {
    uploadGroupFileFromBuffer: vi.fn(async (params: { fileName?: string }) => {
      calls.uploads.push(params);
      calls.order.push(`upload:${params.fileName ?? ''}`);
      return { fileInfo: `FILE_INFO_${params.fileName ?? ''}` };
    }),
    sendGroupImage: vi.fn(async (params: { fileInfo: string; msgSeq: number; msgId: string }) => {
      calls.images.push(params);
      calls.order.push(`send:${params.fileInfo}`);
      return { id: 'ROBOT1.0_sent' };
    }),
    sendGroupText: vi.fn(async (params: { content: string; msgSeq?: number }) => {
      calls.texts.push(params);
      calls.order.push('sendText');
      return { id: 'ROBOT1.0_text' };
    }),
  };

  const deps: MessageHandlingDeps = {
    api: api as unknown as MessageHandlingDeps['api'],
    fundflow: { getSectorFundFlow: async (kind: SectorKind) => makeSnapshot(kind) },
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
  it('★ 带 messageReference 时，两张图都以引用形式发送', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    const outcome = await handler.handle({
      ...message,
      messageReference: 'REFIDX_user_msg==',
    });

    expect(outcome).toBe('images-sent');
    expect(calls.images).toHaveLength(2);
    const refs = calls.images.map(
      (call) => (call as unknown as { messageReference?: string }).messageReference,
    );
    expect(refs).toEqual(['REFIDX_user_msg==', 'REFIDX_user_msg==']);
  });

  it('不带 messageReference 时请求里不出现引用字段', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    await handler.handle(message);
    const refs = calls.images.map(
      (call) => (call as unknown as { messageReference?: string }).messageReference,
    );
    expect(refs.every((ref) => ref === undefined)).toBe(true);
  });

  it('★ 大盘：发送两张图片（行业 + 概念），各用递增的 msg_seq', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    const outcome = await handler.handle(message);

    expect(outcome).toBe('images-sent');
    expect(calls.images).toHaveLength(2);
    expect(calls.uploads).toHaveLength(2);
    // 不再发送任何文字（数据全部通过图片传达）
    expect(calls.texts).toHaveLength(0);

    const seqs = calls.images.map((call) => call.msgSeq);
    expect(seqs).toEqual([1, 2]);
    expect(calls.images.every((call) => call.msgId === 'ROBOT1.0_msg')).toBe(true);
  });

  it('★ 两张图的渲染参数分别标注行业 / 概念板块', async () => {
    const options: { title: string; metricLabel: string; blocks: unknown[] }[] = [];
    const renderer = vi.fn((opts: unknown) => {
      options.push(opts as (typeof options)[number]);
      return {
        png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        svg: '<svg/>',
        width: 1200,
        height: 900,
        tiles: [],
      };
    });

    const { handler } = createHarness({
      imageOutputDir: tempDir,
      renderer: renderer as unknown as MessageHandlingDeps['renderer'],
    });
    await handler.handle(message);

    expect(options).toHaveLength(2);
    const titles = options.map((opt) => opt.title).sort();
    expect(titles).toEqual(['概念板块主力Top25', '行业板块主力Top25']);
    // 页脚说明用更完整的口径名（榜单含净流出板块，主标题不写「流入」）
    expect(options.every((opt) => opt.metricLabel === '主力净额')).toBe(true);
    // 每个板块共 35 个，取前 25
    expect(options.every((opt) => opt.blocks.length === 25)).toBe(true);
  });

  it('★ 两条链路并发：先渲染完的那张先发（不等待另一张）', async () => {
    const events: string[] = [];
    const kinds: string[] = [];

    // 用真实异步延迟控制完成顺序：概念链路快，行业链路慢
    const { handler } = createHarness({
      imageOutputDir: tempDir,
      fundflow: {
        getSectorFundFlow: async (kind: SectorKind) => {
          await new Promise((resolve) => setTimeout(resolve, kind === 'industry' ? 60 : 0));
          return makeSnapshot(kind);
        },
      },
      renderer: ((opts: { title: string }) => {
        kinds.push(opts.title);
        return {
          png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          svg: '<svg/>',
          width: 1200,
          height: 900,
          tiles: [],
        };
      }) as unknown as MessageHandlingDeps['renderer'],
      api: {
        uploadGroupFileFromBuffer: vi.fn(async () => ({ fileInfo: 'F' })),
        sendGroupImage: vi.fn(async (params: { fileInfo: string; msgSeq: number; msgId: string }) => {
          events.push(`send@${params.msgSeq}`);
          return {};
        }),
        sendGroupText: vi.fn(async () => ({})),
      } as unknown as MessageHandlingDeps['api'],
    });

    expect(await handler.handle(message)).toBe('images-sent');
    // 概念（快）先渲染完成并先发，拿到 seq=1；行业（慢）随后用 seq=2
    expect(kinds).toEqual(['概念板块主力Top25', '行业板块主力Top25']);
    expect(events).toEqual(['send@1', 'send@2']);
  });

  it('重复事件不会重复发图', async () => {
    const { handler, calls } = createHarness({ imageOutputDir: tempDir });
    expect(await handler.handle(message)).toBe('images-sent');
    expect(await handler.handle(message)).toBe('duplicate');
    expect(calls.images).toHaveLength(1 * 2);
  });

  it('ping 指令仍回复文本且不调用图片接口', async () => {
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

  it('两类数据都失败时给一条错误说明', async () => {
    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      fundflow: {
        getSectorFundFlow: async () => {
          throw new Error('东方财富接口 HTTP 502');
        },
      },
    });
    const outcome = await handler.handle(message);
    expect(outcome).toBe('fallback-sent');
    expect(calls.images).toHaveLength(0);
    expect(calls.texts).toHaveLength(1);
    expect(calls.texts[0]?.content).toContain('板块资金流数据获取失败');
    expect(calls.texts[0]?.content).toContain('行业板块');
    expect(calls.texts[0]?.content).toContain('概念板块');
  });

  it('★ 只有一类失败时仍然发送成功的那张（partial）', async () => {
    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      fundflow: {
        getSectorFundFlow: async (kind: SectorKind) => {
          if (kind === 'concept') throw new Error('概念接口超时');
          return makeSnapshot(kind);
        },
      },
    });

    expect(await handler.handle(message)).toBe('partial');
    expect(calls.images).toHaveLength(1);
    expect(calls.images[0]?.fileInfo).toContain('industry');
    // 有图送达就不发文字
    expect(calls.texts).toHaveLength(0);
  });

  it('渲染失败时另一张仍能发出', async () => {
    const renderer = vi.fn((opts: { title: string }) => {
      if (opts.title.includes('概念')) throw new Error('resvg 渲染失败');
      return {
        png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        svg: '<svg/>',
        width: 1200,
        height: 900,
        tiles: [],
      };
    });

    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      renderer: renderer as unknown as MessageHandlingDeps['renderer'],
    });

    expect(await handler.handle(message)).toBe('partial');
    expect(calls.images).toHaveLength(1);
    expect(calls.images[0]?.fileInfo).toContain('industry');
  });

  it('★ 发图被判重（40054005）时换 msg_seq 重试，最终发图成功', async () => {
    const sendGroupImage = vi
      .fn()
      .mockRejectedValueOnce(new QqApiError({ status: 400, code: 40054005, message: '消息被去重', body: '{}' }))
      .mockResolvedValue({ id: 'ROBOT1.0_sent' });

    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      api: {
        uploadGroupFileFromBuffer: vi.fn(async (params: { fileName?: string }) => {
          calls.uploads.push(params);
          return { fileInfo: `F_${params.fileName ?? ''}` };
        }),
        sendGroupImage,
        sendGroupText: vi.fn(async (params: { content: string; msgSeq?: number }) => {
          calls.texts.push(params);
          return {};
        }),
      } as unknown as MessageHandlingDeps['api'],
    });

    expect(await handler.handle(message)).toBe('images-sent');
    // 第一张图先被判重（seq=1），换 seq=2 成功；第二张接着用 seq=3
    const seqs = sendGroupImage.mock.calls.map((call) => (call[0] as { msgSeq: number }).msgSeq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('★ 判重持续失败时始终换新 seq，直到用完 5 次上限', async () => {
    const sendGroupImage = vi
      .fn()
      .mockRejectedValue(new QqApiError({ status: 400, code: 40054005, message: '消息被去重', body: '{}' }));

    const { handler } = createHarness({
      imageOutputDir: tempDir,
      api: {
        uploadGroupFileFromBuffer: vi.fn(async () => ({ fileInfo: 'F' })),
        sendGroupImage,
        sendGroupText: vi.fn(async () => ({})),
      } as unknown as MessageHandlingDeps['api'],
    });

    expect(await handler.handle(message)).toBe('reply-limit');
    const seqs = sendGroupImage.mock.calls.map((call) => (call[0] as { msgSeq: number }).msgSeq);
    // 从不复用已认领的序号（复用必被判重），因此都是全新的 seq
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.max(...seqs)).toBeLessThanOrEqual(5);
  });

  it('上传失败时另一张仍能发出', async () => {
    const uploadMock = vi.fn(async (params: { fileName?: string }) => {
      if (params.fileName?.includes('concept')) throw new Error('分片上传失败');
      return { fileInfo: 'FILE_INFO_OK' };
    });

    const { handler, calls } = createHarness({
      imageOutputDir: tempDir,
      api: {
        uploadGroupFileFromBuffer: uploadMock,
        sendGroupImage: vi.fn(async (params: { fileInfo: string; msgSeq: number; msgId: string }) => {
          calls.images.push(params);
          return {};
        }),
        sendGroupText: vi.fn(async (params: { content: string; msgSeq?: number }) => {
          calls.texts.push(params);
          return {};
        }),
      } as unknown as MessageHandlingDeps['api'],
    });

    expect(await handler.handle(message)).toBe('partial');
    expect(calls.images).toHaveLength(1);
    expect(calls.texts).toHaveLength(0);
  });

  it('文字回复也失败时不抛出致命异常', async () => {
    const { handler } = createHarness({
      imageOutputDir: tempDir,
      api: {
        uploadGroupFileFromBuffer: vi.fn(async () => ({ fileInfo: 'F' })),
        sendGroupImage: vi.fn(async () => ({})),
        sendGroupText: vi.fn(async () => {
          throw new Error('发送失败');
        }),
      } as unknown as MessageHandlingDeps['api'],
    });
    expect(await handler.handle({ ...message, content: 'ping' })).toBe('ignored');
  });
});

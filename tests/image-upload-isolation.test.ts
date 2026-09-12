import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { GroupMessageHandler, type MessageHandlingDeps } from '../src/commands/bot.js';
import { MessageDeduplicator } from '../src/qq/dedupe.js';
import type { FundFlowSnapshot, SectorKind } from '../src/market/fundflow-types.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

/** 两类板块的数据刻意做成不同大小，便于区分上传的到底是哪张图。 */
function snapshotOf(kind: SectorKind): FundFlowSnapshot {
  return {
    kind,
    period: 'today',
    source: '东方财富',
    quoteTime: new Date(1_752_000_000 * 1000),
    fetchedAt: new Date(),
    sectors: Array.from({ length: 30 }, (_, index) => ({
      code: `${kind}-${index}`,
      name: `${kind}板块${index}`,
      changePercent: 1,
      mainNet: (30 - index) * 1e8,
      mainNetRatio: 1,
      superNet: 0,
      superNetRatio: 0,
      bigNet: 0,
      bigNetRatio: 0,
      midNet: 0,
      midNetRatio: 0,
      smallNet: 0,
      smallNetRatio: 0,
    })),
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'qq-bot-img-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('两张图片互不串图（回归：临时文件同名导致读到别人的图）', () => {
  it('★ 上传的是各自渲染出的 PNG，而不是磁盘上的文件', async () => {
    // 行业图 4 字节、概念图 8 字节，用长度区分
    const industryPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const conceptPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const uploaded: { fileName: string; length: number }[] = [];
    const images: { size: string }[] = [];

    const renderer = vi.fn((opts: { title: string }) => ({
      png: opts.title.includes('行业') ? industryPng : conceptPng,
      svg: '<svg/>',
      width: 1200,
      height: 900,
      tiles: [],
    }));

    const handler = new GroupMessageHandler({
      api: {
        uploadGroupFileFromBuffer: vi.fn(async (params: { buffer: Buffer; fileName: string }) => {
          uploaded.push({ fileName: params.fileName, length: params.buffer.length });
          return { fileInfo: `F_${params.fileName}` };
        }),
        sendGroupImage: vi.fn(async (params: { fileInfo: string }) => {
          images.push({ size: params.fileInfo });
          return {};
        }),
        sendGroupText: vi.fn(async () => ({})),
      } as unknown as MessageHandlingDeps['api'],
      fundflow: { getSectorFundFlow: async (kind: SectorKind) => snapshotOf(kind) },
      logger,
      dedupe: new MessageDeduplicator(),
      imageOutputDir: tempDir,
      renderer: renderer as unknown as MessageHandlingDeps['renderer'],
    });

    const outcome = await handler.handle({
      messageId: 'MSG1',
      groupOpenid: 'G',
      content: '大盘',
    });
    expect(outcome).toBe('images-sent');

    // 两次上传的字节数必须不同（分别对应各自的 PNG）
    const byKind = new Map(uploaded.map((item) => [item.fileName.includes('industry') ? 'industry' : 'concept', item]));
    expect(byKind.get('industry')?.length).toBe(industryPng.length);
    expect(byKind.get('concept')?.length).toBe(conceptPng.length);
    expect(images).toHaveLength(2);
  });

  it('★ 调试图片文件名带 pid 与随机串，同一毫秒并发也不会互相覆盖', async () => {
    const dir = join(tempDir, 'images');
    await mkdir(dir, { recursive: true });

    const handler = new GroupMessageHandler({
      api: {
        uploadGroupFileFromBuffer: vi.fn(async () => ({ fileInfo: 'F' })),
        sendGroupImage: vi.fn(async () => ({})),
        sendGroupText: vi.fn(async () => ({})),
      } as unknown as MessageHandlingDeps['api'],
      fundflow: { getSectorFundFlow: async (kind: SectorKind) => snapshotOf(kind) },
      logger,
      dedupe: new MessageDeduplicator(),
      imageOutputDir: dir,
      renderer: (() => ({
        png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        svg: '<svg/>',
        width: 1200,
        height: 900,
        tiles: [],
      })) as unknown as MessageHandlingDeps['renderer'],
    });

    // 同一 msg_id 下两张图几乎同时落盘
    await handler.handle({ messageId: 'SAME', groupOpenid: 'G', content: '大盘' });

    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    // 文件名互不相同（含 pid + 随机串），不会出现覆盖
    expect(new Set(files).size).toBe(2);
    for (const file of files) {
      expect(file).toMatch(new RegExp(`-${process.pid}-[0-9a-f]{8}\\.png$`));
    }
  });
});

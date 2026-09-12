import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { SessionStore } from '../src/qq/session-store.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.warn = () => {};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qq-bot-session-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('保存后可以读回 session_id 与 seq', () => {
    const store = new SessionStore({ filePath: join(dir, 'nested', 'session.json'), logger });
    store.save({ sessionId: 'sess-1', lastSeq: 42 });
    expect(store.load()).toEqual({ sessionId: 'sess-1', lastSeq: 42 });
  });

  it('文件不存在时返回 null', () => {
    const store = new SessionStore({ filePath: join(dir, 'missing.json'), logger });
    expect(store.load()).toBeNull();
  });

  it('文件内容损坏时返回 null 而不抛错', async () => {
    const filePath = join(dir, 'broken.json');
    await writeFile(filePath, '{not json', 'utf8');
    const store = new SessionStore({ filePath, logger });
    expect(store.load()).toBeNull();
  });

  it('缺少字段时返回 null', async () => {
    const filePath = join(dir, 'partial.json');
    await writeFile(filePath, JSON.stringify({ sessionId: 'only-id' }), 'utf8');
    const store = new SessionStore({ filePath, logger });
    expect(store.load()).toBeNull();
  });
});

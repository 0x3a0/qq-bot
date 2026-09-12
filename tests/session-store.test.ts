import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { SessionStore } from '../src/qq/session-store.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.warn = () => {};
logger.info = () => {};

const owner = { appId: '102077451', apiBase: 'https://api.bot.qq.com' };

let dir: string;
let filePath: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qq-bot-session-'));
  filePath = join(dir, 'nested', 'session.json');
  store = new SessionStore({ filePath, logger });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('保存后可以读回 session_id、seq 与归属信息', () => {
    store.save({ sessionId: 'sess-1', lastSeq: 42 }, owner);
    expect(store.loadFor(owner)).toEqual({
      status: 'found',
      session: expect.objectContaining({ sessionId: 'sess-1', lastSeq: 42, appId: '102077451' }),
    });
  });

  it('没有缓存文件时返回 empty', () => {
    expect(store.loadFor(owner)).toEqual({ status: 'empty' });
  });

  it('★ 更换 APP_ID 后不会复用上一个机器人的会话', () => {
    store.save({ sessionId: 'old-bot-session', lastSeq: 7 }, { appId: '111111111', apiBase: owner.apiBase });

    const result = store.loadFor(owner);
    expect(result.status).toBe('stale-app');
    expect(result.status === 'stale-app' && result.previous.sessionId).toBe('old-bot-session');
  });

  it('★ 更换接入点（正式/沙箱）后同样丢弃会话', () => {
    store.save({ sessionId: 'prod-session', lastSeq: 3 }, owner);
    const sandbox = { appId: owner.appId, apiBase: 'https://sandbox.api.sgroup.qq.com' };
    expect(store.loadFor(sandbox).status).toBe('stale-app');
  });

  it('旧版本缓存缺少 appId 时视为过期，避免串号', async () => {
    const legacyPath = join(dir, 'legacy.json');
    await writeFile(legacyPath, JSON.stringify({ sessionId: 'legacy', lastSeq: 1 }), 'utf8');
    const legacyStore = new SessionStore({ filePath: legacyPath, logger });
    expect(legacyStore.loadFor(owner).status).toBe('stale-app');
  });

  it('clear 删除缓存文件', () => {
    store.save({ sessionId: 'sess-1', lastSeq: 1 }, owner);
    expect(existsSync(filePath)).toBe(true);
    store.clear();
    expect(existsSync(filePath)).toBe(false);
    expect(store.loadFor(owner)).toEqual({ status: 'empty' });
  });

  it('save(null) 也会清理缓存文件', () => {
    store.save({ sessionId: 'sess-1', lastSeq: 1 }, owner);
    store.save(null);
    expect(existsSync(filePath)).toBe(false);
  });

  it('文件内容损坏时返回 empty 而不抛错', async () => {
    const brokenPath = join(dir, 'broken.json');
    await writeFile(brokenPath, '{not json', 'utf8');
    const brokenStore = new SessionStore({ filePath: brokenPath, logger });
    expect(brokenStore.loadFor(owner)).toEqual({ status: 'empty' });
  });

  it('缺少字段时返回 empty', async () => {
    const partialPath = join(dir, 'partial.json');
    await writeFile(partialPath, JSON.stringify({ sessionId: 'only-id' }), 'utf8');
    const partialStore = new SessionStore({ filePath: partialPath, logger });
    expect(partialStore.loadFor(owner)).toEqual({ status: 'empty' });
  });

  it('read 返回原始缓存内容（含 savedAt）', () => {
    store.save({ sessionId: 'sess-9', lastSeq: 9 }, owner);
    const raw = store.read();
    expect(raw?.sessionId).toBe('sess-9');
    expect(raw?.appId).toBe('102077451');
    expect(typeof raw?.savedAt).toBe('string');
  });
});

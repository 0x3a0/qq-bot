import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, isProcessAlive, readLock, releaseLock } from '../src/instance-lock.js';
import { createLogger } from '../src/logger.js';
import { writeFileSync } from 'node:fs';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qq-bot-lock-'));
  lockPath = join(dir, 'nested', 'bot.lock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('单实例保护', () => {
  it('★ 已有存活进程持锁时拒绝启动（避免同一消息被回复两次）', () => {
    expect(acquireLock(lockPath, logger).ok).toBe(true);
    const second = acquireLock(lockPath, logger);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.holder.pid).toBe(process.pid);
  });

  it('锁文件记录当前 pid 与启动时间', () => {
    acquireLock(lockPath, logger);
    const lock = readLock(lockPath);
    expect(lock?.pid).toBe(process.pid);
    expect(typeof lock?.startedAt).toBe('string');
  });

  it('残留锁（进程已不存在）会被覆盖', () => {
    // 用一个几乎不可能存在的 pid
    const stalePath = join(dir, 'stale.lock');
    writeFileSync(stalePath, JSON.stringify({ pid: 999_999_999, startedAt: '2020-01-01T00:00:00Z' }), 'utf8');

    const result = acquireLock(stalePath, logger);
    expect(result.ok).toBe(true);
    expect(readLock(stalePath)?.pid).toBe(process.pid);
  });

  it('releaseLock 后可以重新获取', () => {
    expect(acquireLock(lockPath, logger).ok).toBe(true);
    expect(acquireLock(lockPath, logger).ok).toBe(false);
    releaseLock(lockPath, logger);
    expect(acquireLock(lockPath, logger).ok).toBe(true);
  });

  it('锁文件内容损坏时视为无锁', () => {
    const brokenPath = join(dir, 'broken.lock');
    writeFileSync(brokenPath, 'not json', 'utf8');
    expect(readLock(brokenPath)).toBeNull();
    expect(acquireLock(brokenPath, logger).ok).toBe(true);
  });

  it('isProcessAlive：当前进程存活，非法 pid 与不存在进程为 false', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999_999_999)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, currentEnvKey, isProcessAlive, readLock, releaseLock } from '../src/instance-lock.js';
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

const acquire = (path = lockPath, envKey?: string) =>
  acquireLock({ filePath: path, logger, ...(envKey ? { envKey } : {}) });

describe('单实例保护', () => {
  it('★ 已有存活进程持锁时拒绝启动（避免同一消息被回复两次）', () => {
    expect(acquire().ok).toBe(true);
    const second = acquire();
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.holder.pid).toBe(process.pid);
  });

  it('锁文件记录 pid、启动时间与运行环境标识', () => {
    acquire();
    const lock = readLock(lockPath);
    expect(lock?.pid).toBe(process.pid);
    expect(typeof lock?.startedAt).toBe('string');
    expect(lock?.envKey).toBe(currentEnvKey());
  });

  it('enabled=false 时完全跳过检查', () => {
    expect(acquire().ok).toBe(true);
    expect(acquireLock({ filePath: lockPath, logger, enabled: false }).ok).toBe(true);
  });

  it('★ 其它运行环境留下的锁不影响启动（容器跨部署 pid 会重复）', () => {
    // 模拟上一次部署留下的锁：同样的 pid（容器里常常都是 1），但环境标识不同
    const stalePath = join(dir, 'deploy-old.lock');
    writeFileSync(
      stalePath,
      JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z', envKey: 'railway:old-deploy:host-1' }),
      'utf8',
    );

    const result = acquire(stalePath, 'railway:new-deploy:host-2');
    expect(result.ok).toBe(true);
    expect(readLock(stalePath)?.envKey).toBe('railway:new-deploy:host-2');
  });

  it('残留锁（同环境但进程已不存在）会被覆盖', () => {
    const stalePath = join(dir, 'stale.lock');
    writeFileSync(
      stalePath,
      JSON.stringify({ pid: 999_999_999, startedAt: '2020-01-01T00:00:00Z', envKey: currentEnvKey() }),
      'utf8',
    );

    expect(acquire(stalePath).ok).toBe(true);
    expect(readLock(stalePath)?.pid).toBe(process.pid);
  });

  it('旧版锁（没有 envKey 字段）视为残留', () => {
    const legacyPath = join(dir, 'legacy.lock');
    writeFileSync(legacyPath, JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z' }), 'utf8');
    expect(acquire(legacyPath).ok).toBe(true);
  });

  it('releaseLock 后可以重新获取', () => {
    expect(acquire().ok).toBe(true);
    expect(acquire().ok).toBe(false);
    releaseLock(lockPath, logger);
    expect(acquire().ok).toBe(true);
  });

  it('锁文件内容损坏时视为无锁', () => {
    const brokenPath = join(dir, 'broken.lock');
    writeFileSync(brokenPath, 'not json', 'utf8');
    expect(readLock(brokenPath)).toBeNull();
    expect(acquire(brokenPath).ok).toBe(true);
  });

  it('isProcessAlive：当前进程存活，非法 pid 与不存在进程为 false', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999_999_999)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe('currentEnvKey', () => {
  it('★ 本地环境标识包含主机名与系统启动时刻', () => {
    const key = currentEnvKey({}, 1234);
    expect(key.startsWith('local:')).toBe(true);
    expect(key).toContain(`:${Math.round(Date.now() / 1000 - 1234)}`);
  });

  it('★ Railway 环境标识包含平台环境名与主机名', () => {
    const key = currentEnvKey({ RAILWAY_ENVIRONMENT_NAME: 'production' } as NodeJS.ProcessEnv, 0);
    expect(key.startsWith('railway:production:')).toBe(true);
  });

  it('没有 RAILWAY_ENVIRONMENT_NAME 时回退到其它注入变量', () => {
    const key = currentEnvKey({ RAILWAY_PROJECT_ID: 'proj-1' } as NodeJS.ProcessEnv, 0);
    expect(key.startsWith('railway:proj-1:')).toBe(true);
  });
});

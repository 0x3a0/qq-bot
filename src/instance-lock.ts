/**
 * 单实例保护。
 *
 * 两个进程同时连接同一个机器人账号时，QQ Gateway 会把同一条群消息
 * 投递给两个连接，于是每个指令被回复两遍（用户看到"重复的一张图/两条消息"）。
 * 这里用锁文件 + 存活探测在启动阶段拦掉这种误操作。
 *
 * 注意：仅用于本地单机；Railway 等平台容器内 pid 不跨实例，不会误判。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from './logger.js';

export interface InstanceLock {
  pid: number;
  startedAt: string;
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; holder: InstanceLock };

/** 判断进程是否存活（signal 0 只做权限/存在性检查）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH：进程不存在；EPERM：存在但无权限（同样视为存活）
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(filePath: string): InstanceLock | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<InstanceLock>;
    if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
      return { pid: parsed.pid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '' };
    }
    return null;
  } catch {
    return null;
  }
}

export function releaseLock(filePath: string, logger?: Logger): void {
  try {
    rmSync(filePath, { force: true });
  } catch (error) {
    logger?.warn(`清理进程锁失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 尝试获取单实例锁。
 * 已有存活进程持锁时返回 ok=false，由调用方决定是退出还是仅告警。
 */
export function acquireLock(filePath: string, logger: Logger): AcquireResult {
  const existing = readLock(filePath);
  if (existing && isProcessAlive(existing.pid)) {
    return { ok: false, holder: existing };
  }
  if (existing) {
    logger.warn(`发现残留进程锁（pid=${existing.pid} 已不存在），将覆盖`);
  }

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (error) {
    logger.warn(`写入进程锁失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true };
}

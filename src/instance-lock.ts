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
import os from 'node:os';
import type { Logger } from './logger.js';

export interface InstanceLock {
  pid: number;
  startedAt: string;
  /**
   * 运行环境标识。用于区分「同一容器内的另一个进程」与「另一次部署/另一台机器」：
   * 容器里 pid 会跨部署重复（例如都是 1），只看 pid 会把死的锁误判成活的。
   */
  envKey?: string;
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; holder: InstanceLock };

/**
 * 当前进程所属的「运行环境」标识。
 * - 本地：主机名 + 系统启动时间的近似值（每次开机不同）
 * - 容器（Railway 等）：平台注入的变量，跨部署会变化
 * 只用于判断锁是否属于当前这次运行环境，不参与安全决策。
 */
export function currentEnvKey(env: NodeJS.ProcessEnv = process.env, uptimeSec = os.uptime()): string {
  const platform = env.RAILWAY_ENVIRONMENT_NAME ?? env.RAILWAY_ENVIRONMENT_ID ?? env.RAILWAY_PROJECT_ID;
  const host = os.hostname();
  if (platform) return `railway:${platform}:${host}`;
  // 本地：用「当前时间 - uptime」近似系统启动时刻，重启后必然不同
  const bootApprox = Math.round(Date.now() / 1000 - uptimeSec);
  return `local:${host}:${bootApprox}`;
}

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
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        ...(typeof parsed.envKey === 'string' ? { envKey: parsed.envKey } : {}),
      };
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

export interface AcquireOptions {
  filePath: string;
  logger: Logger;
  /** 是否启用单实例检查，默认启用 */
  enabled?: boolean;
  /** 覆盖环境标识（测试用） */
  envKey?: string;
}

/**
 * 尝试获取单实例锁。
 *
 * 判定「已被占用」需要同时满足：
 * 1. 锁属于当前运行环境（envKey 一致）——否则视为其它部署/机器留下的残留锁
 * 2. 锁里的 pid 仍然存活
 *
 * 这样容器里 pid 复用导致的误判（上一次部署的 pid=1 vs 本次的 pid=1）不会发生。
 */
export function acquireLock(options: AcquireOptions): AcquireResult {
  const { filePath, logger, enabled = true, envKey = currentEnvKey() } = options;
  if (!enabled) return { ok: true };

  const existing = readLock(filePath);
  if (existing && existing.envKey === envKey && isProcessAlive(existing.pid)) {
    return { ok: false, holder: existing };
  }
  if (existing) {
    const reason =
      existing.envKey === envKey
        ? `pid=${existing.pid} 已不存在`
        : `属于其它运行环境（${existing.envKey ?? '未记录'}）`;
    logger.warn(`忽略残留进程锁（${reason}）`);
  }

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), envKey }, null, 2),
      'utf8',
    );
  } catch (error) {
    logger.warn(`写入进程锁失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true };
}

/**
 * 会话持久化：把 Gateway 的 session_id 与最新 seq 落盘，
 * 重启后可以走 Resume 补发断线期间的事件（官方文档：恢复登录态 Session）。
 *
 * 重要：session_id 是绑定机器人（AppID）的。如果换了 APP_ID / 接入点，
 * 必须丢弃旧会话并重新 Identify，否则会出现“换了账号仍然连上上一个 bot”的现象。
 * 因此缓存里同时记录 appId 与 apiBase，读取时做一致性校验。
 *
 * 落盘失败不会影响主流程；MVP 只用于本地/单实例部署。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';

export interface PersistedSession {
  sessionId: string;
  lastSeq: number;
  /** 会话所属机器人 AppID */
  appId?: string;
  /** 会话所属接入点（区分正式/沙箱、自建域名） */
  apiBase?: string;
  /** 会话所属机器人身份（用于日志确认"连上的是哪个 bot"） */
  botId?: string;
  botName?: string;
  /** 写入时间（ISO 字符串） */
  savedAt?: string;
}

export interface SessionStoreOptions {
  filePath: string;
  logger: Logger;
}

export type LoadSessionResult =
  | { status: 'found'; session: PersistedSession }
  /** 已有缓存但属于其它机器人/接入点，已丢弃并清理文件 */
  | { status: 'stale-app'; previous: PersistedSession }
  | { status: 'empty' };

export class SessionStore {
  private readonly filePath: string;
  private readonly logger: Logger;

  constructor(options: SessionStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger.child('session');
  }

  get path(): string {
    return this.filePath;
  }

  /** 只读取原始缓存，不做归属校验（调试用）。 */
  read(): PersistedSession | null {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedSession>;
      if (typeof parsed.sessionId === 'string' && Number.isFinite(parsed.lastSeq)) {
        return {
          sessionId: parsed.sessionId,
          lastSeq: Number(parsed.lastSeq),
          appId: typeof parsed.appId === 'string' ? parsed.appId : undefined,
          apiBase: typeof parsed.apiBase === 'string' ? parsed.apiBase : undefined,
          botId: typeof parsed.botId === 'string' ? parsed.botId : undefined,
          botName: typeof parsed.botName === 'string' ? parsed.botName : undefined,
          savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 读取可用于 Resume 的会话。
   * 只有 appId 与 apiBase 都与当前配置一致时才返回 found，
   * 否则视为过期缓存（stale-app）并删除文件，强制重新 Identify。
   */
  loadFor(expected: { appId: string; apiBase: string }): LoadSessionResult {
    const cached = this.read();
    if (!cached) return { status: 'empty' };

    if (cached.appId && cached.appId !== expected.appId) return { status: 'stale-app', previous: cached };
    if (cached.apiBase && cached.apiBase !== expected.apiBase) return { status: 'stale-app', previous: cached };

    if (!cached.appId) {
      // 旧版本写入的缓存没有 appId，无法确认归属，同样丢弃以免串号
      this.logger.warn('缓存会话缺少 appId 记录，无法确认归属，已丢弃并重新鉴权');
      return { status: 'stale-app', previous: cached };
    }

    return { status: 'found', session: cached };
  }

  save(session: PersistedSession | null, owner?: { appId: string; apiBase: string }): void {
    try {
      if (session === null) {
        rmSync(this.filePath, { force: true });
        return;
      }
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            sessionId: session.sessionId,
            lastSeq: session.lastSeq,
            appId: owner?.appId ?? session.appId,
            apiBase: owner?.apiBase ?? session.apiBase,
            botId: session.botId,
            botName: session.botName,
            savedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch (error) {
      this.logger.warn(`保存会话状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 删除缓存（更换账号或排查问题时使用）。 */
  clear(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch (error) {
      this.logger.warn(`清理会话状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 会话持久化：把 Gateway 的 session_id 与最新 seq 落盘，
 * 重启后可以走 Resume 补发断线期间的事件（官方文档：恢复登录态 Session）。
 *
 * 落盘失败不会影响主流程；MVP 只用于本地/单实例部署。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';

export interface PersistedSession {
  sessionId: string;
  lastSeq: number;
}

export interface SessionStoreOptions {
  filePath: string;
  logger: Logger;
}

export class SessionStore {
  private readonly filePath: string;
  private readonly logger: Logger;

  constructor(options: SessionStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger.child('session');
  }

  load(): PersistedSession | null {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedSession>;
      if (typeof parsed.sessionId === 'string' && Number.isFinite(parsed.lastSeq)) {
        return { sessionId: parsed.sessionId, lastSeq: Number(parsed.lastSeq) };
      }
      return null;
    } catch {
      return null;
    }
  }

  save(session: PersistedSession | null): void {
    try {
      if (session === null) {
        writeFileSync(this.filePath, JSON.stringify({ session: null }), 'utf8');
        return;
      }
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        this.filePath,
        JSON.stringify({ sessionId: session.sessionId, lastSeq: session.lastSeq }, null, 2),
        'utf8',
      );
    } catch (error) {
      this.logger.warn(`保存会话状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

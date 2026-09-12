/**
 * 事件去重：QQ 平台为保证可达性，相同 msg_id 可能重复推送。
 * 文档明确要求结合 msg_seq 做去重，因此这里以 `${msgId}#${msgSeq}` 作为键。
 */
export interface MessageDeduplicatorOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class MessageDeduplicator {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>();

  constructor(options: MessageDeduplicatorOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 5000;
    this.now = options.now ?? (() => Date.now());
  }

  static key(msgId: string, msgSeq = 1): string {
    return `${msgId}#${msgSeq}`;
  }

  /** 标记为已处理；返回 true 表示首次出现（应当处理），false 表示重复（应忽略）。 */
  mark(key: string): boolean {
    this.evictExpired();
    if (this.seen.has(key)) {
      this.evictOverflow();
      return false;
    }
    this.seen.set(key, this.now() + this.ttlMs);
    this.evictOverflow();
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  /** 删除某个键（例如图片发送失败后允许重试）。 */
  delete(key: string): void {
    this.seen.delete(key);
  }

  /**
   * 认领一次回复序号：同一个 msg_id 依次分配 1..maxSeq。
   * 平台允许对同一条被动消息最多回复 5 次，超过返回 null。
   */
  claimSeq(msgId: string, maxSeq = 5): number | null {
    for (let seq = 1; seq <= maxSeq; seq += 1) {
      if (!this.has(MessageDeduplicator.key(msgId, seq))) {
        this.mark(MessageDeduplicator.key(msgId, seq));
        return seq;
      }
    }
    return null;
  }

  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }

  /** 超出容量上限时按插入顺序淘汰最旧条目，保证 size <= maxEntries。 */
  private evictOverflow(): void {
    if (this.seen.size <= this.maxEntries) return;
    const overflow = this.seen.size - this.maxEntries;
    let removed = 0;
    // Map 保持插入顺序
    for (const key of this.seen.keys()) {
      this.seen.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }
}

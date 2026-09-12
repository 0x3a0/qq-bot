/**
 * 内存缓存：为行情结果提供短时缓存与请求合并。
 * 键 -> { value, expiresAt }。
 */
export interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class MemoryCache<V> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(options: { ttlMs: number; now?: () => number }) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * 取缓存或调用 loader；并发调用同一个 key 时只执行一次 loader。
   */
  async getOrLoad(key: string, loader: () => Promise<V>, ttlMs = this.ttlMs): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const task = (async () => {
      const value = await loader();
      this.set(key, value, ttlMs);
      return value;
    })();

    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }
}

import { describe, expect, it } from 'vitest';
import { MessageDeduplicator } from '../src/qq/dedupe.js';

describe('MessageDeduplicator', () => {
  it('首次出现返回 true，重复返回 false', () => {
    const dedupe = new MessageDeduplicator();
    expect(dedupe.mark('msg-1#1')).toBe(true);
    expect(dedupe.mark('msg-1#1')).toBe(false);
  });

  it('key 由 msg_id 与 msg_seq 组成', () => {
    expect(MessageDeduplicator.key('abc', 2)).toBe('abc#2');
    expect(MessageDeduplicator.key('abc')).toBe('abc#1');
  });

  it('同一 msg_id 不同 msg_seq 视为不同消息', () => {
    const dedupe = new MessageDeduplicator();
    expect(dedupe.mark(MessageDeduplicator.key('m', 1))).toBe(true);
    expect(dedupe.mark(MessageDeduplicator.key('m', 2))).toBe(true);
  });

  it('claimNextSeq 依次分配 1..maxSeq，用尽后返回 null', () => {
    const dedupe = new MessageDeduplicator();
    expect(dedupe.claimSeq('m')).toBe(1);
    expect(dedupe.claimSeq('m')).toBe(2);
    expect(dedupe.claimSeq('m', 3)).toBe(3);
    expect(dedupe.claimSeq('m', 3)).toBeNull();
  });

  it('TTL 过期后可以重新处理（模拟缓存淘汰）', () => {
    let now = 1000;
    const dedupe = new MessageDeduplicator({ ttlMs: 500, now: () => now });
    expect(dedupe.mark('k')).toBe(true);
    expect(dedupe.mark('k')).toBe(false);
    now += 501;
    expect(dedupe.mark('k')).toBe(true);
  });

  it('超过 maxEntries 时淘汰最旧条目', () => {
    const dedupe = new MessageDeduplicator({ maxEntries: 2, ttlMs: 60_000 });
    dedupe.mark('a');
    dedupe.mark('a2');
    dedupe.mark('a3');
    expect(dedupe.size).toBeLessThanOrEqual(2);
    expect(dedupe.has('a')).toBe(false);
    expect(dedupe.has('a2')).toBe(true);
  });

  it('clear 清空所有状态', () => {
    const dedupe = new MessageDeduplicator();
    dedupe.mark('a');
    dedupe.clear();
    expect(dedupe.size).toBe(0);
    expect(dedupe.mark('a')).toBe(true);
  });
});

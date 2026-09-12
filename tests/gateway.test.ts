import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { GatewayClient } from '../src/qq/gateway.js';
import type { TokenManager } from '../src/qq/token.js';
import { OpCode, canIdentifyOnClose, canResumeOnClose, isFatalCloseCode } from '../src/qq/types.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};

type WebSocketCtor = NonNullable<ConstructorParameters<typeof GatewayClient>[0]['webSocketImpl']>;

class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', code ?? 1000, Buffer.from(reason ?? '')));
  }

  terminate(): void {
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', 1006, Buffer.from('terminated')));
  }

  /** 模拟服务端下发报文 */
  serverSend(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  lastPayload(): { op: number; d?: unknown } | null {
    const last = this.sent.at(-1);
    return last ? (JSON.parse(last) as { op: number; d?: unknown }) : null;
  }

  payloads(): { op: number; d?: unknown }[] {
    return this.sent.map((item) => JSON.parse(item) as { op: number; d?: unknown });
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }
}

/** 等待条件成立（避免依赖固定 sleep）。 */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const tokens = {
  getToken: async () => 'fake-token',
  get: async () => ({ token: 'fake-token', expiresAt: Date.now() + 3600_000 }),
  getAuthorizationHeader: async () => 'QQBot fake-token',
  refresh: async () => ({ token: 'fake-token', expiresAt: Date.now() + 3600_000 }),
  invalidate: () => {},
} as unknown as TokenManager;

function createClient(overrides: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}): GatewayClient {
  return new GatewayClient({
    tokens,
    intents: 1 << 25,
    logger,
    gatewayUrl: 'wss://example.invalid/websocket/',
    reconnectBaseDelayMs: 5,
    handshakeTimeoutMs: 400,
    webSocketImpl: FakeWebSocket as unknown as WebSocketCtor,
    ...overrides,
  });
}

describe('GatewayClient', () => {
  it('收到 Hello 后发送 Identify，包含 token/intents/shard', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0]!;

    ws.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    await waitFor(() => ws.sent.length > 0);

    const payload = ws.lastPayload();
    expect(payload?.op).toBe(OpCode.Identify);
    const data = payload?.d as { token: string; intents: number; shard: number[] };
    expect(data.token).toBe('QQBot fake-token');
    expect(data.intents).toBe(1 << 25);
    expect(data.shard).toEqual([0, 1]);
    client.stop();
  });

  it('READY 后进入 ready 状态并记录 session', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    const ready = vi.fn();
    client.on('ready', ready);
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0]!;

    ws.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    ws.serverSend({
      op: OpCode.Dispatch,
      s: 1,
      t: 'READY',
      d: { session_id: 'sess-1', user: { id: '1', username: '测试机器人' } },
    });

    await waitFor(() => client.isReady);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(client.session.sessionId).toBe('sess-1');
    expect(client.session.lastSeq).toBe(1);
    client.stop();
  });

  it('GROUP_AT_MESSAGE_CREATE 触发 groupAtMessage 事件', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    const received = vi.fn();
    client.on('groupAtMessage', received);
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0]!;

    ws.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    ws.serverSend({
      op: OpCode.Dispatch,
      s: 2,
      t: 'GROUP_AT_MESSAGE_CREATE',
      id: 'event-1',
      d: {
        id: 'ROBOT1.0_msg',
        content: ' 大盘 ',
        group_openid: 'GROUP_OPENID',
        author: { member_openid: 'MEMBER', username: '小明' },
      },
    });

    await waitFor(() => received.mock.calls.length === 1);
    const [data, event] = received.mock.calls[0] as [
      { id: string; group_openid: string; content: string },
      { type: string; seq: number },
    ];
    expect(data.id).toBe('ROBOT1.0_msg');
    expect(data.group_openid).toBe('GROUP_OPENID');
    expect(data.content).toBe(' 大盘 ');
    expect(event.type).toBe('GROUP_AT_MESSAGE_CREATE');
    expect(event.seq).toBe(2);
    client.stop();
  });

  it('缺少必要字段的群事件不会触发回调', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    const received = vi.fn();
    client.on('groupAtMessage', received);
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0]!;
    ws.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    ws.serverSend({ op: OpCode.Dispatch, s: 3, t: 'GROUP_AT_MESSAGE_CREATE', d: { content: '大盘' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).not.toHaveBeenCalled();
    client.stop();
  });

  it('心跳携带最新 seq，且收到 ACK 后不主动断开', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0]!;
    ws.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 20 } });
    await waitFor(() => ws.payloads().some((item) => item.op === OpCode.Identify));
    ws.serverSend({ op: OpCode.Dispatch, s: 5, t: 'READY', d: { session_id: 's' } });
    await waitFor(() => ws.payloads().some((item) => item.op === OpCode.Heartbeat));
    const heartbeat = ws.payloads().find((item) => item.op === OpCode.Heartbeat);
    expect(heartbeat?.d).toBe(5);
    ws.serverSend({ op: OpCode.HeartbeatAck });
    await waitFor(() => client.isReady);
    expect(ws.closed).toBeNull();
    client.stop();
  });

  it('断线后保留 session 并发送 Resume', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const first = FakeWebSocket.instances[0]!;
    first.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    first.serverSend({ op: OpCode.Dispatch, s: 7, t: 'READY', d: { session_id: 'sess-7' } });
    await waitFor(() => client.isReady);

    // 4009 允许 resume
    first.close(4009, 'expired');
    await waitFor(() => FakeWebSocket.instances.length === 2);
    const second = FakeWebSocket.instances[1]!;
    second.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    await waitFor(() => second.sent.length > 0);

    const payload = second.lastPayload();
    expect(payload?.op).toBe(OpCode.Resume);
    expect(payload?.d).toMatchObject({ session_id: 'sess-7', seq: 7 });
    client.stop();
  });

  it('4006 会清空 session，重连后重新 Identify', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const first = FakeWebSocket.instances[0]!;
    first.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    first.serverSend({ op: OpCode.Dispatch, s: 3, t: 'READY', d: { session_id: 'sess-3' } });
    await waitFor(() => client.isReady);

    first.close(4006, 'invalid session');
    await waitFor(() => FakeWebSocket.instances.length === 2);
    const second = FakeWebSocket.instances[1]!;
    second.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    await waitFor(() => second.sent.length > 0);
    expect(second.lastPayload()?.op).toBe(OpCode.Identify);
    client.stop();
  });

  it('op=9 会话无效时清空 session', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0]!;
    ws.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    ws.serverSend({ op: OpCode.Dispatch, s: 4, t: 'READY', d: { session_id: 'sess-4' } });
    await waitFor(() => client.isReady);

    ws.serverSend({ op: OpCode.InvalidSession, d: false });
    await waitFor(() => client.session.sessionId === null);
    expect(ws.closed?.code).toBe(4006);
    client.stop();
  });

  it('致命关闭码停止重连并触发 fatal', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    const fatal = vi.fn();
    client.on('fatal', fatal);
    const running = client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    FakeWebSocket.instances[0]!.close(4914, 'bot offline');
    await running;
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('stop() 主动停止后不再重连', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    const running = client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0]!;
    client.stop();
    await running;
    expect(ws.closed?.code).toBe(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('通过 onSessionChange 暴露会话状态，便于重启后 Resume', async () => {
    FakeWebSocket.reset();
    const changes: ({ sessionId: string; lastSeq: number } | null)[] = [];
    const client = createClient({ onSessionChange: (session) => changes.push(session) });
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0]!;
    ws.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    ws.serverSend({ op: OpCode.Dispatch, s: 11, t: 'READY', d: { session_id: 'sess-11' } });
    await waitFor(() => client.isReady);
    expect(changes.at(-1)).toEqual({ sessionId: 'sess-11', lastSeq: 11 });

    ws.serverSend({ op: OpCode.Dispatch, s: 12, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'x', group_openid: 'g' } });
    await waitFor(() => changes.at(-1)?.lastSeq === 12);
    client.stop();
  });

  it('构造时传入已保存的会话，Hello 后直接 Resume', async () => {
    FakeWebSocket.reset();
    const client = createClient({ session: { sessionId: 'saved-session', lastSeq: 99 } });
    void client.run();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0]!;
    ws.serverSend({ op: OpCode.Hello, d: { heartbeat_interval: 45_000 } });
    await waitFor(() => ws.sent.length > 0);
    expect(ws.lastPayload()?.op).toBe(OpCode.Resume);
    expect(ws.lastPayload()?.d).toMatchObject({ session_id: 'saved-session', seq: 99 });
    client.stop();
  });

  it('连接前调用 stop() 不会建立连接', async () => {
    FakeWebSocket.reset();
    const client = createClient();
    client.stop();
    await client.run();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('标识位判断符合官方错误码表', () => {
    expect(canResumeOnClose(4009)).toBe(true);
    expect(canResumeOnClose(4008)).toBe(true);
    expect(canResumeOnClose(4006)).toBe(false);
    expect(canIdentifyOnClose(4006)).toBe(true);
    expect(canIdentifyOnClose(4007)).toBe(true);
    expect(canIdentifyOnClose(4001)).toBe(false);
    expect(canIdentifyOnClose(4013)).toBe(false);
    expect(canIdentifyOnClose(4900)).toBe(true);
    expect(isFatalCloseCode(4914)).toBe(true);
    expect(isFatalCloseCode(4915)).toBe(true);
    expect(isFatalCloseCode(4009)).toBe(false);
  });
});

/**
 * QQ Gateway WebSocket 客户端。
 *
 * 负责：获取接入点、Identify 鉴权、心跳、断线重连与 Resume、事件分发。
 * 文档：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { describeError, type Logger } from '../logger.js';
import type { TokenManager } from './token.js';
import {
  CLOSE_CODE_MEANING,
  OpCode,
  canIdentifyOnClose,
  canResumeOnClose,
  isFatalCloseCode,
  type GatewayPayload,
  type GroupAtMessageCreateData,
  type ReadyData,
} from './types.js';

export interface GatewayClientOptions {
  tokens: TokenManager;
  intents: number;
  logger: Logger;
  /** 接入点覆盖；为空时通过 API 的 /gateway 获取 */
  gatewayUrl?: string | null;
  /** 获取接入点的函数（注入便于测试） */
  fetchGatewayUrl?: () => Promise<string>;
  /** 最大重连尝试次数（-1 表示无限），默认无限 */
  maxReconnectAttempts?: number;
  /** 基础重连延迟，默认 1000ms，指数退避 */
  reconnectBaseDelayMs?: number;
  /** 握手超时（等待 READY/RESUMED），默认 15 秒 */
  handshakeTimeoutMs?: number;
  /** 初始会话（用于进程重启后 Resume），seq 必须是最后处理过的 s */
  session?: { sessionId: string; lastSeq: number } | null;
  /**
   * Resume 观察窗口（毫秒）。平台对已失效的会话仍会回 RESUMED，
   * 但之后不会再推任何事件；超过该窗口没收到事件就判定会话失效并重新 Identify。
   * 传 0 关闭看门狗。
   */
  resumeGraceMs?: number;
  /** 会话变化回调（READY 后写入、会话失效时置空），可用于持久化 */
  onSessionChange?: (
    session: { sessionId: string; lastSeq: number; botId?: string; botName?: string } | null,
    info?: { reason: 'ready' | 'resumed' | 'event' | 'invalidated' },
  ) => void;
  /** 测试用 WebSocket 实现 */
  webSocketImpl?: typeof WebSocket;
}

export interface GatewayEvent {
  type: string;
  data: unknown;
  /** 下行序号 s，用于 Resume */
  seq: number | undefined;
  /** 事件 id */
  id: string | undefined;
}

export interface GatewayEvents {
  ready: (data: ReadyData) => void;
  resumed: () => void;
  event: (event: GatewayEvent) => void;
  groupAtMessage: (data: GroupAtMessageCreateData, event: GatewayEvent) => void;
  error: (error: Error) => void;
  /** 重连调度中（attempt 从 1 开始） */
  reconnecting: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /** 连接关闭 */
  closed: (info: { code: number; reason: string }) => void;
  /** 致命关闭（不可恢复，需要人工处理） */
  fatal: (info: { code: number; reason: string }) => void;
}

type HandshakeState = 'idle' | 'connecting' | 'identifying' | 'resuming' | 'ready';

export class GatewayClient extends EventEmitter {
  private readonly options: Required<Pick<GatewayClientOptions, 'intents' | 'maxReconnectAttempts' | 'reconnectBaseDelayMs' | 'handshakeTimeoutMs'>> &
    GatewayClientOptions;
  private readonly logger: Logger;
  private readonly tokens: TokenManager;

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private botId: string | null = null;
  private botName: string | null = null;
  private state: HandshakeState = 'idle';
  private reconnectAttempts = 0;
  private stopped = false;
  private awaitingPongFor: number | null = null;
  private resumeWatchdog: NodeJS.Timeout | null = null;
  private resumeEpoch = 0;

  constructor(options: GatewayClientOptions) {
    super();
    this.options = {
      maxReconnectAttempts: -1,
      reconnectBaseDelayMs: 1000,
      handshakeTimeoutMs: 15_000,
      ...options,
    };
    this.logger = options.logger.child('gateway');
    this.tokens = options.tokens;
    if (options.session) {
      this.sessionId = options.session.sessionId;
      this.lastSeq = options.session.lastSeq;
      this.logger.info(`载入已保存的会话：session_id=${this.sessionId} seq=${this.lastSeq}`);
    }
  }

  /** 强制放弃当前会话，下次连接重新 Identify。 */
  private invalidateSession(reason: string): void {
    if (this.sessionId === null) return;
    this.logger.warn(`放弃当前会话（${reason}），将重新 Identify`);
    this.sessionId = null;
    this.lastSeq = null;
    this.clearResumeWatchdog();
    this.notifySessionChange('invalidated');
  }

  override on<K extends keyof GatewayEvents>(event: K, listener: GatewayEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof GatewayEvents>(event: K, ...args: Parameters<GatewayEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  get session(): { sessionId: string | null; lastSeq: number | null } {
    return { sessionId: this.sessionId, lastSeq: this.lastSeq };
  }

  /** 当前连接的机器人身份（READY 之后才有值）。 */
  get botInfo(): { id: string | null; name: string | null } {
    return { id: this.botId, name: this.botName };
  }

  /**
   * 启动连接循环：连接失败会按退避策略自动重连，直到 stop() 被调用
   * 或遇到致命关闭码。Promise 在完全停止后 resolve。
   * 注意：stop() 之后再次调用 run() 不会重新建立连接。
   */
  async run(): Promise<void> {
    while (!this.stopped) {
      const shouldRetry = await this.connectOnce();
      if (this.stopped || !shouldRetry) break;

      this.reconnectAttempts += 1;
      if (this.options.maxReconnectAttempts >= 0 && this.reconnectAttempts > this.options.maxReconnectAttempts) {
        this.logger.error(`重连次数已达上限（${this.options.maxReconnectAttempts}），停止重连`);
        break;
      }
      const delayMs = this.backoffDelay(this.reconnectAttempts);
      this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs, reason: 'connect-once-returned' });
      await this.sleep(delayMs);
    }
    this.logger.info('Gateway 客户端已停止');
  }

  /** 主动停止：清理定时器与连接，不再重连。 */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.clearResumeWatchdog();
    const ws = this.ws;
    if (ws) {
      // 注意：不能先移除监听器，否则 close 回调无法 resolve connectOnce。
      // close 回调里会检查 this.stopped，主动停止时直接结束循环。
      this.ws = null;
      try {
        ws.close(1000, 'client-stop');
      } catch {
        /* 忽略关闭异常 */
      }
    }
    this.state = 'idle';
  }

  /** 单次连接：返回 true 表示可以重连，false 表示应停止（致命错误或主动停止）。 */
  private connectOnce(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      void (async () => {
        if (this.stopped) {
          resolve(false);
          return;
        }

        let url: string;
        try {
          url = await this.resolveGatewayUrl();
        } catch (error) {
          this.logger.error(`获取 Gateway 接入点失败：${describeError(error)}`);
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
          resolve(true);
          return;
        }

        const token = await this.tokens.getToken().catch((error: unknown) => {
          this.logger.error(`获取 Access Token 失败：${describeError(error)}`);
          return null;
        });
        if (!token) {
          resolve(true);
          return;
        }

        this.state = 'connecting';
        this.logger.info(`正在连接 Gateway：${url}`);
        const WebSocketImpl = this.options.webSocketImpl ?? WebSocket;
        const ws = new WebSocketImpl(url);
        this.ws = ws;
        if (this.stopped) {
          // stop() 在建立连接期间被调用：立即关闭并结束
          try {
            ws.close(1000, 'client-stop');
          } catch {
            /* 忽略 */
          }
          resolve(false);
          return;
        }
        let settled = false;

        const finish = (retry: boolean): void => {
          if (settled) return;
          settled = true;
          this.clearHandshakeTimer();
          resolve(retry);
        };

        this.armHandshakeTimer(() => {
          this.logger.warn('Gateway 握手超时，准备重连');
          try {
            ws.terminate();
          } catch {
            /* 忽略 */
          }
          finish(true);
        });

        ws.on('open', () => {
          this.logger.debug('WebSocket 已建立，等待 Hello (op=10)');
        });

        ws.on('message', (raw: WebSocket.RawData) => {
          // handleMessage 是 async：acknowledge 之外必须显式 catch，
          // 避免处理事件时的异常变成 unhandledRejection。
          void this.handleMessage(raw, { ws, finish, token }).catch((error: unknown) => {
            this.logger.error(`处理 Gateway 报文异常：${describeError(error)}`);
          });
        });

        ws.on('error', (error: Error) => {
          this.logger.error(`WebSocket 错误：${describeError(error)}`);
          this.emit('error', error);
        });

        ws.on('close', (code: number, reason: Buffer) => {
          this.clearHeartbeatTimer();
          const reasonText = reason.toString() || CLOSE_CODE_MEANING[code] || '';
          this.logger.warn(`WebSocket 关闭：code=${code} reason=${reasonText}`);
          this.emit('closed', { code, reason: reasonText });

          if (this.stopped) {
            finish(false);
            return;
          }
          if (isFatalCloseCode(code)) {
            this.logger.error(`致命关闭码 ${code}（${CLOSE_CODE_MEANING[code] ?? '未知'}），停止重连`);
            this.emit('fatal', { code, reason: reasonText });
            finish(false);
            return;
          }
          if (!canIdentifyOnClose(code) && !canResumeOnClose(code)) {
            this.logger.error(`关闭码 ${code} 不允许重试，停止重连`);
            finish(false);
            return;
          }
          if (canResumeOnClose(code) && this.sessionId) {
            this.logger.info(`关闭码 ${code}，重连后将尝试 Resume`);
          } else {
            this.logger.info(`关闭码 ${code}，重连后将重新 Identify`);
            this.sessionId = null;
            this.notifySessionChange('invalidated');
          }
          this.clearResumeWatchdog();
          finish(true);
        });
      })();
    });
  }

  private async handleMessage(
    raw: WebSocket.RawData,
    ctx: { ws: WebSocket; finish: (retry: boolean) => void; token: string },
  ): Promise<void> {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw.toString()) as GatewayPayload;
    } catch {
      this.logger.warn(`无法解析 Gateway 报文：${raw.toString().slice(0, 200)}`);
      return;
    }

    switch (payload.op) {
      case OpCode.Hello: {
        const interval = Number((payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 45_000);
        this.startHeartbeat(ctx.ws, interval);
        if (this.canResume()) {
          this.sendIdentify(ctx.ws, 'resume', ctx.token);
        } else {
          this.sendIdentify(ctx.ws, 'identify', ctx.token);
        }
        return;
      }
      case OpCode.Dispatch: {
        this.handleDispatch(payload);
        return;
      }
      case OpCode.HeartbeatAck: {
        this.awaitingPongFor = null;
        this.logger.debug('收到心跳 ACK (op=11)');
        return;
      }
      case OpCode.Reconnect: {
        this.logger.warn('服务端要求重连 (op=7)');
        ctx.ws.close(4009, 'server-reconnect');
        return;
      }
      case OpCode.InvalidSession: {
        const resumable = payload.d === true;
        this.logger.warn(`会话无效 (op=9)，resumable=${String(resumable)}`);
        this.invalidateSession('服务端返回 op=9');
        ctx.ws.close(resumable ? 4009 : 4006, 'invalid-session');
        return;
      }
      default: {
        this.logger.debug(`收到未处理的 opcode=${payload.op}`);
      }
    }
  }

  private handleDispatch(payload: GatewayPayload): void {
    if (typeof payload.s === 'number') this.lastSeq = payload.s;
    const type = payload.t ?? 'UNKNOWN';

    // 收到任何事件都说明当前连接是活的：撤销 Resume 看门狗
    this.clearResumeWatchdog();

    if (type === 'READY') {
      const data = payload.d as ReadyData | undefined;
      this.sessionId = data?.session_id ?? null;
      this.botId = data?.user?.id ?? null;
      this.botName = data?.user?.username ?? null;
      this.state = 'ready';
      this.reconnectAttempts = 0;
      this.clearHandshakeTimer();
      this.logger.info(
        `Gateway 鉴权成功 READY，session_id=${this.sessionId ?? '(空)'}，` +
          `机器人=${this.botName ?? '未知'}（id=${this.botId ?? '-'}）`,
      );
      this.notifySessionChange('ready');
      this.emit('ready', data ?? {});
      return;
    }

    if (type === 'RESUMED') {
      this.state = 'ready';
      this.reconnectAttempts = 0;
      this.clearHandshakeTimer();
      this.logger.info(
        `Gateway 会话已恢复 RESUMED（复用 session_id=${this.sessionId ?? '-'}）。` +
          '注意：平台对已失效的会话也会返回 RESUMED 但不再推送事件，已启动观察窗口。',
      );
      this.notifySessionChange('resumed');
      this.armResumeWatchdog();
      this.emit('resumed');
      return;
    }

    const event: GatewayEvent = { type, data: payload.d, seq: payload.s, id: payload.id };
    this.notifySessionChange('event');
    this.emit('event', event);

    if (type === 'GROUP_AT_MESSAGE_CREATE') {
      const data = payload.d as GroupAtMessageCreateData | undefined;
      if (!data?.id || !data.group_openid) {
        this.logger.warn(`GROUP_AT_MESSAGE_CREATE 事件缺少必要字段：${JSON.stringify(payload.d).slice(0, 300)}`);
        return;
      }
      this.emit('groupAtMessage', data, event);
    }
  }

  /**
   * Resume 成功后启动观察窗口：窗口内没有收到任何事件，
   * 说明这个会话在平台侧已经失效（Resume 假成功），强制重新 Identify。
   */
  private armResumeWatchdog(): void {
    this.clearResumeWatchdog();
    const graceMs = this.options.resumeGraceMs ?? 0;
    if (graceMs <= 0 || this.ws === null) return;

    this.resumeEpoch += 1;
    const epoch = this.resumeEpoch;
    this.logger.info(`Resume 观察窗口 ${graceMs}ms：窗口内无事件则重新鉴权`);
    this.resumeWatchdog = setTimeout(() => {
      if (this.stopped || epoch !== this.resumeEpoch) return;
      if (this.state !== 'ready' || this.sessionId === null) return;
      this.logger.warn(
        `Resume 后 ${graceMs}ms 内没有收到任何事件，判定会话已失效，重新建立连接并 Identify`,
      );
      this.sessionId = null;
      this.lastSeq = null;
      this.notifySessionChange('invalidated');
      const ws = this.ws;
      if (ws) {
        try {
          ws.close(4006, 'resume-grace-expired');
        } catch {
          /* 忽略 */
        }
      }
    }, graceMs);
    this.resumeWatchdog.unref?.();
  }

  private clearResumeWatchdog(): void {
    if (this.resumeWatchdog) {
      clearTimeout(this.resumeWatchdog);
      this.resumeWatchdog = null;
    }
  }

  /** 是否具备 Resume 条件：需要同时有 session_id 与已收到的 seq。 */
  private canResume(): boolean {
    return this.sessionId !== null && this.lastSeq !== null;
  }

  /** 通知外部持久化当前会话状态。 */
  private notifySessionChange(reason: 'ready' | 'resumed' | 'event' | 'invalidated'): void {
    const handler = this.options.onSessionChange;
    if (!handler) return;
    if (!this.canResume()) {
      handler(null, { reason });
      return;
    }
    handler(
      {
        sessionId: this.sessionId as string,
        lastSeq: this.lastSeq as number,
        ...(this.botId ? { botId: this.botId } : {}),
        ...(this.botName ? { botName: this.botName } : {}),
      },
      { reason },
    );
  }

  private sendIdentify(ws: WebSocket, mode: 'identify' | 'resume', token: string): void {
    if (mode === 'resume' && this.sessionId !== null && this.lastSeq !== null) {
      this.state = 'resuming';
      this.logger.info(`发送 Resume (op=6) session_id=${this.sessionId} seq=${this.lastSeq}`);
      this.send(ws, {
        op: OpCode.Resume,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
      });
      return;
    }

    this.state = 'identifying';
    this.logger.info(`发送 Identify (op=2) intents=${this.options.intents} shard=[0,1]`);
    this.send(ws, {
      op: OpCode.Identify,
      d: {
        token: `QQBot ${token}`,
        intents: this.options.intents,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: 'qq-bot-mvp',
          $device: 'qq-bot-mvp',
        },
      },
    });
  }

  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    this.clearHeartbeatTimer();
    this.logger.debug(`心跳周期 ${intervalMs}ms`);
    const tick = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPongFor !== null) {
        this.logger.warn('上一次心跳未收到 ACK，主动重连');
        try {
          ws.close(4009, 'heartbeat-timeout');
        } catch {
          /* 忽略 */
        }
        return;
      }
      this.awaitingPongFor = Date.now();
      this.send(ws, { op: OpCode.Heartbeat, d: this.lastSeq });
    };
    // 首次心跳稍作延迟，避免与 Identify 抢跑
    this.heartbeatTimer = setInterval(tick, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('WebSocket 未处于 OPEN 状态，跳过发送');
      return;
    }
    const json = JSON.stringify(payload);
    this.logger.debug(`>>> ${json.length > 500 ? `${json.slice(0, 500)}...` : json}`);
    ws.send(json);
  }

  /** 返回 true 表示需要重连，false 表示应停止。 */
  private async resolveGatewayUrl(): Promise<string> {
    if (this.options.gatewayUrl && this.options.gatewayUrl.length > 0) return this.options.gatewayUrl;
    if (this.options.fetchGatewayUrl) return this.options.fetchGatewayUrl();
    throw new Error('未配置 Gateway 接入点，且未提供 fetchGatewayUrl');
  }

  private backoffDelay(attempt: number): number {
    const base = this.options.reconnectBaseDelayMs * 2 ** Math.min(attempt - 1, 5);
    const jitter = Math.floor(Math.random() * 250);
    return Math.min(base + jitter, 60_000);
  }

  private armHandshakeTimer(onTimeout: () => void): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(onTimeout, this.options.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingPongFor = null;
  }

  private clearTimers(): void {
    this.clearHeartbeatTimer();
    this.clearHandshakeTimer();
    this.clearResumeWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, ms);
      this.reconnectTimer.unref?.();
    });
  }
}

import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { OneBotApiRequest, OneBotApiResponse } from "./types.js";

export interface OneBotClientOptions {
  url: string;
  token?: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

type EventHandler = (event: Record<string, unknown>) => void;
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class OneBotClient {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private closed = false;
  private reconnectDelay: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers = new Set<EventHandler>();
  private readonly options: Required<Pick<OneBotClientOptions, "reconnectMinMs" | "reconnectMaxMs" | "requestTimeoutMs">> & OneBotClientOptions;

  constructor(options: OneBotClientOptions) {
    this.options = {
      reconnectMinMs: 1_000,
      reconnectMaxMs: 30_000,
      requestTimeoutMs: 10_000,
      ...options
    };
    this.reconnectDelay = this.options.reconnectMinMs;
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  connect(): Promise<void> {
    this.closed = false;
    this.clearReconnectTimer();
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.socket?.readyState === WebSocket.CONNECTING) return this.waitForOpen(this.socket);
    const headers = this.options.token ? { Authorization: `Bearer ${this.options.token}` } : undefined;
    const socket = new WebSocket(this.options.url, { headers });
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectDelay = this.options.reconnectMinMs;
      this.options.logger?.info(`OneBot WebSocket connected: ${this.options.url}`);
    });
    socket.on("message", (payload) => this.handleMessage(payload.toString()));
    socket.on("error", (error) => this.options.logger?.error("OneBot WebSocket error", error));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.rejectPending(new Error("OneBot WebSocket closed"));
      if (!this.closed) this.scheduleReconnect();
    });
    return this.waitForOpen(socket);
  }

  close(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.rejectPending(new Error("OneBot client closed"));
    this.socket?.close();
    this.socket = undefined;
  }

  async sendGroupMessage(groupId: number, message: Record<string, unknown>[]): Promise<unknown> {
    return this.request("send_group_msg", { group_id: groupId, message });
  }

  request<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("OneBot WebSocket is not connected"));
    const echo = randomUUID();
    const request: OneBotApiRequest = { action, params, echo };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot request timed out: ${action}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(echo, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify(request), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(echo);
          reject(error);
        }
      });
    });
  }

  private handleMessage(raw: string): void {
    let payload: OneBotApiResponse | Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as OneBotApiResponse;
    } catch {
      this.options.logger?.warn("Ignoring invalid OneBot message");
      return;
    }
    if (typeof payload.echo === "string") {
      const pending = this.pending.get(payload.echo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(payload.echo);
        if (payload.status === "failed") pending.reject(new Error(`OneBot API failed (${payload.retcode})`));
        else pending.resolve(payload.data);
        return;
      }
    }
    for (const handler of this.handlers) handler(payload as unknown as Record<string, unknown>);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.options.logger?.warn(`OneBot disconnected; reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.reconnectMaxMs);
    }, this.reconnectDelay);
  }

  private waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("open", handleOpen);
        socket.off("error", handleError);
      };
      const handleOpen = (): void => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        socket.terminate();
        reject(new Error(`OneBot connection timed out: ${this.options.url}`));
      }, this.options.requestTimeoutMs);
      socket.once("open", handleOpen);
      socket.once("error", handleError);
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private rejectPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(echo);
    }
  }
}

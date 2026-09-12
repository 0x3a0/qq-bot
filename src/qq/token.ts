/**
 * Access Token 管理：自动获取与提前刷新。
 *
 * 官方文档：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 * - POST https://api.bot.qq.com/app/getAppAccessToken  body: { appId, clientSecret }
 * - 返回 access_token / expires_in（秒，通常 7200）
 * - 有效期内重复获取返回同一个 token；临近过期 60 秒内会下发新 token
 * 因此这里提前 SAFETY_WINDOW_MS 刷新，并合并并发请求。
 */
import { z } from 'zod';
import type { Logger } from '../logger.js';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.union([z.string(), z.number()]).optional(),
});

/** 失败响应体，用于把平台的错误码/错误信息透出到日志。 */
const tokenErrorSchema = z.object({
  code: z.union([z.number(), z.string()]).optional(),
  err_code: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
  msg: z.string().optional(),
});

function describeTokenFailure(text: string): string {
  try {
    const parsed = tokenErrorSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      const code = parsed.data.code ?? parsed.data.err_code;
      const message = parsed.data.message ?? parsed.data.msg;
      if (code !== undefined || message) {
        return `错误码 ${code ?? '未知'}${message ? `：${message}` : ''}`;
      }
    }
  } catch {
    /* 非 JSON 响应，回退到原始文本 */
  }
  return text.slice(0, 300);
}

export interface AccessToken {
  token: string;
  /** 绝对过期时间戳（毫秒） */
  expiresAt: number;
}

export interface TokenManagerOptions {
  appId: string;
  clientSecret: string;
  logger: Logger;
  /** Token 接口地址，默认 https://api.bot.qq.com/app/getAppAccessToken */
  tokenUrl?: string;
  /** 提前刷新窗口，默认 5 分钟 */
  safetyWindowMs?: number;
  /** 测试用时钟 */
  now?: () => number;
  /** 测试用 fetch */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';
const DEFAULT_SAFETY_WINDOW_MS = 5 * 60 * 1000;

export class TokenManager {
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly logger: Logger;
  private readonly tokenUrl: string;
  private readonly safetyWindowMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

  constructor(options: TokenManagerOptions) {
    this.appId = options.appId;
    this.clientSecret = options.clientSecret;
    this.logger = options.logger.child('token');
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.safetyWindowMs = options.safetyWindowMs ?? DEFAULT_SAFETY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 强制刷新并返回新的 token。 */
  async refresh(): Promise<AccessToken> {
    if (this.inflight) return this.inflight;

    const task = (async (): Promise<AccessToken> => {
      const response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`获取 Access Token 失败：HTTP ${response.status} ${describeTokenFailure(text)}`);
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`获取 Access Token 失败：响应不是合法 JSON：${text.slice(0, 500)}`);
      }

      const parsed = tokenResponseSchema.safeParse(json);
      if (!parsed.success) {
        // 平台会以 HTTP 200 + 错误码返回失败，例如 100007 appid invalid
        throw new Error(`获取 Access Token 失败：${describeTokenFailure(text)}`);
      }

      const expiresInSec = Number(parsed.data.expires_in ?? 7200);
      const effectiveTtlSec = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 7200;
      const accessToken: AccessToken = {
        token: parsed.data.access_token,
        expiresAt: this.now() + effectiveTtlSec * 1000,
      };

      this.cached = accessToken;
      this.logger.info(`Access Token 已刷新，有效期 ${effectiveTtlSec} 秒`);
      return accessToken;
    })();

    this.inflight = task;
    try {
      return await task;
    } finally {
      this.inflight = null;
    }
  }

  /** 获取可用 token：命中缓存直接返回，否则刷新。 */
  async get(): Promise<AccessToken> {
    const cached = this.cached;
    if (cached && cached.expiresAt - this.safetyWindowMs > this.now()) {
      return cached;
    }
    return this.refresh();
  }

  /** 返回可用的 token 字符串。 */
  async getToken(): Promise<string> {
    return (await this.get()).token;
  }

  /** 返回 Authorization 头的值：QQBot {ACCESS_TOKEN} */
  async getAuthorizationHeader(): Promise<string> {
    return `QQBot ${await this.getToken()}`;
  }

  /** 清除缓存（例如收到 401 后可主动失效）。 */
  invalidate(): void {
    this.cached = null;
  }
}

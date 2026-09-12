import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { TokenManager } from '../src/qq/token.js';

const logger = createLogger('test');
logger.debug = () => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TokenManager', () => {
  it('获取 token 并缓存，第二次调用不再请求', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'tok-1', expires_in: '7200' }));
    const manager = new TokenManager({
      appId: 'app',
      clientSecret: 'secret',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await manager.getToken()).toBe('tok-1');
    expect(await manager.getToken()).toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('请求体包含 appId 与 clientSecret', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body).toEqual({ appId: 'my-app', clientSecret: 'my-secret' });
      expect(init?.method).toBe('POST');
      return jsonResponse({ access_token: 'tok', expires_in: 7200 });
    });
    const manager = new TokenManager({
      appId: 'my-app',
      clientSecret: 'my-secret',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await manager.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('临近过期时提前刷新', async () => {
    let now = 0;
    let counter = 0;
    const fetchImpl = vi.fn(async () => {
      counter += 1;
      return jsonResponse({ access_token: `tok-${counter}`, expires_in: 7200 });
    });
    const manager = new TokenManager({
      appId: 'app',
      clientSecret: 'secret',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      safetyWindowMs: 5 * 60 * 1000,
    });

    expect(await manager.getToken()).toBe('tok-1');
    // 仍在安全窗口内 -> 不刷新
    now = 7200_000 - 6 * 60 * 1000;
    expect(await manager.getToken()).toBe('tok-1');
    // 进入安全窗口 -> 刷新
    now = 7200_000 - 4 * 60 * 1000;
    expect(await manager.getToken()).toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('并发调用只触发一次请求', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const manager = new TokenManager({
      appId: 'app',
      clientSecret: 'secret',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const pending = [manager.getToken(), manager.getToken(), manager.getToken()];
    await Promise.resolve();
    resolveFetch?.(jsonResponse({ access_token: 'tok', expires_in: 7200 }));
    expect(await Promise.all(pending)).toEqual(['tok', 'tok', 'tok']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP 失败时抛出可读错误', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"code":100016,"message":"invalid appid or secret"}', { status: 401 }));
    const manager = new TokenManager({
      appId: 'app',
      clientSecret: 'bad',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(manager.getToken()).rejects.toThrow(/Access Token 失败/);
  });

  it('HTTP 200 但带错误码时透出平台错误信息', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 100007, message: 'appid invalid' }));
    const manager = new TokenManager({
      appId: 'app',
      clientSecret: 'secret',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(manager.getToken()).rejects.toThrow(/100007：appid invalid/);
  });

  it('响应缺少 access_token 时抛出错误', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'ok' }));
    const manager = new TokenManager({
      appId: 'app',
      clientSecret: 'secret',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(manager.getToken()).rejects.toThrow(/Access Token 失败/);
  });

  it('invalidate 后重新请求', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: `tok-${Math.random()}`, expires_in: 7200 }));
    const manager = new TokenManager({
      appId: 'app',
      clientSecret: 'secret',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await manager.getToken();
    manager.invalidate();
    await manager.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('getAuthorizationHeader 返回 QQBot 前缀', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'abc', expires_in: 7200 }));
    const manager = new TokenManager({
      appId: 'app',
      clientSecret: 'secret',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await manager.getAuthorizationHeader()).toBe('QQBot abc');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { startHealthServer, type HealthServer } from '../src/health-server.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('test');
logger.debug = () => {};
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

let server: HealthServer | null = null;

/** 断言非空并返回，避免测试里到处写可选链 */
function required(value: HealthServer | null): HealthServer {
  if (!value) throw new Error('期望健康检查服务已启动，但得到 null');
  return value;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('健康检查监听（平台就绪判据）', () => {
  it('★ 未提供 PORT 时不监听任何端口（本地默认行为）', async () => {
    const started = await startHealthServer({ logger });
    expect(started).toBeNull();
  });

  it('★ 提供 PORT 时监听并响应 /health（默认就绪）', async () => {
    const health = required(await startHealthServer({ port: 39_191, logger }));
    try {
      const res = await fetch('http://127.0.0.1:39191/health');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      await health.close();
    }
  }, 20_000);

  it('★ Gateway 未就绪时健康检查返回 503（避免平台过早判定就绪）', async () => {
    const health = required(await startHealthServer({ port: 39_192, logger, isReady: () => false }));
    try {
      const res = await fetch('http://127.0.0.1:39192/health');
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('gateway not ready');
    } finally {
      await health.close();
    }
  }, 20_000);

  it('根路径同样返回健康状态', async () => {
    const health = required(await startHealthServer({ port: 39_195, logger }));
    try {
      const res = await fetch('http://127.0.0.1:39195/');
      expect(res.status).toBe(200);
    } finally {
      await health.close();
    }
  }, 20_000);

  it('未知路径返回 404', async () => {
    const health = required(await startHealthServer({ port: 39_193, logger }));
    try {
      const res = await fetch('http://127.0.0.1:39193/whatever');
      expect(res.status).toBe(404);
    } finally {
      await health.close();
    }
  }, 20_000);

  it('端口被占用时抛出错误，由调用方决定是否继续', async () => {
    const first = required(await startHealthServer({ port: 39_194, logger }));
    try {
      await expect(startHealthServer({ port: 39_194, logger })).rejects.toThrow();
    } finally {
      await first.close();
    }
  }, 20_000);
});

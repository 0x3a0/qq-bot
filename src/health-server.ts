/**
 * 可选的 HTTP 端口监听。
 *
 * 本项目本身只「主动连出」QQ Gateway，不需要监听端口。
 * 但部分平台把「绑定端口」作为服务就绪的判据（例如 Render 的 Web Service：
 * 未在限期内绑定 PORT 会被判定部署失败，免费实例还会因无流量而休眠），
 * 因此这里做一层可选适配：**只有平台注入了 PORT 时才监听**，本地运行不受影响。
 *
 * 该端口只暴露一个极简健康检查，不承载任何业务逻辑，也不需要公网访问。
 */
import { createServer, type Server } from 'node:http';
import type { Logger } from './logger.js';

export interface HealthServerOptions {
  /** 监听端口；为空则不启动（本地默认） */
  port?: number;
  logger: Logger;
  /** 返回当前是否已连上 Gateway，用于让健康检查反映真实就绪状态 */
  isReady?: () => boolean;
}

export interface HealthServer {
  port: number;
  close: () => Promise<void>;
}

/** 启动健康检查监听；未提供端口时返回 null。 */
export function startHealthServer(options: HealthServerOptions): Promise<HealthServer | null> {
  const { port, logger } = options;
  if (port === undefined) return Promise.resolve(null);

  return new Promise<HealthServer>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const ready = options.isReady?.() ?? true;
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(ready ? 'ok' : 'gateway not ready');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    server.on('error', (error) => {
      logger.error(`健康检查端口监听失败（port=${port}）：${error.message}`);
      reject(error);
    });

    server.listen(port, () => {
      logger.info(`已监听 PORT=${port}，仅提供 /health 健康检查（平台就绪判据）`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

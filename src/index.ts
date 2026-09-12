/**
 * 本地运行入口：连上 QQ Gateway 接收 @机器人 消息并回复。
 *
 * 里程碑 1/2 验收：能在测试群收到 @ 事件，并返回 ping 文本与行情图片。
 *
 * 运行方式：
 *   1. 复制 .env.example 为 .env，填入 APP_ID / CLIENT_SECRET
 *   2. npm start
 */
import { loadConfig } from './config.js';
import { loadDotEnv } from './env.js';
import { createLogger, describeError, setLogLevel } from './logger.js';
import { GroupMessageHandler } from './commands/bot.js';
import { EastmoneyIndustryProvider } from './market/eastmoney.js';
import { QqApiClient } from './qq/api-client.js';
import { MessageDeduplicator } from './qq/dedupe.js';
import { GatewayClient, type GatewayEvent } from './qq/gateway.js';
import { SessionStore } from './qq/session-store.js';
import { TokenManager } from './qq/token.js';
import { CLOSE_CODE_MEANING, type GroupAtMessageCreateData } from './qq/types.js';
import { join } from 'node:path';

async function main(): Promise<void> {
  const env = loadDotEnv();
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const logger = createLogger('app');
  logger.info(`QQ Bot MVP 启动中（env=${config.qqEnv}，apiBase=${config.apiBase}）`);
  logger.info(env.loaded ? `已加载环境变量文件：${env.path}` : '未找到 .env，使用进程内环境变量');
  if (!config.logEvents) {
    logger.info('提示：排查 @ 事件时可设置 LOG_EVENTS=true 打印全部事件');
  }

  const tokens = new TokenManager({
    appId: config.appId,
    clientSecret: config.clientSecret,
    logger,
  });

  const api = new QqApiClient({ apiBase: config.apiBase, tokens, logger });
  const market = new EastmoneyIndustryProvider({ logger, cacheTtlMs: config.marketCacheTtlMs });

  const handler = new GroupMessageHandler({
    api,
    market,
    logger,
    dedupe: new MessageDeduplicator(),
    imageOutputDir: config.imageOutputDir,
    fontFiles: config.fontFiles,
  });

  const sessionStore = new SessionStore({
    filePath: join(process.cwd(), '.tmp-probe', 'gateway-session.json'),
    logger,
  });

  const gateway = new GatewayClient({
    tokens,
    intents: config.intents,
    logger,
    gatewayUrl: config.gatewayUrl,
    fetchGatewayUrl: () => api.getGatewayUrl(),
    session: sessionStore.load(),
    onSessionChange: (session) => {
      // 保存最新 seq，进程重启后可以 Resume 补发漏掉的事件
      if (session) sessionStore.save(session);
    },
  });

  gateway.on('ready', (data) => {
    logger.info(`已连接 QQ Gateway，机器人：${data.user?.username ?? '未知'}（${data.user?.id ?? '-'}）`);
    logger.info('现在可以在测试群里 @机器人 发送「大盘」或「ping」');
  });

  gateway.on('resumed', () => {
    logger.info('会话已恢复，继续接收事件');
  });

  if (config.logEvents) {
    gateway.on('event', (event: GatewayEvent) => {
      logger.debug(`事件 ${event.type}：${JSON.stringify(event.data).slice(0, 800)}`);
    });
  }

  gateway.on('groupAtMessage', (data: GroupAtMessageCreateData) => {
    logger.info(
      `收到群 @ 消息：group=${data.group_openid} user=${data.author?.username ?? '未知'} ` +
        `content="${(data.content ?? '').replace(/\s+/g, ' ').slice(0, 80)}"`,
    );
    void handler
      .handle({
        messageId: data.id,
        groupOpenid: data.group_openid,
        content: data.content,
        username: data.author?.username,
      })
      .then((outcome) => {
        logger.debug(`处理结果：${outcome}`);
      })
      .catch((error: unknown) => {
        logger.error(`处理群消息异常：${describeError(error)}`);
      });
  });

  gateway.on('error', (error) => {
    logger.warn(`Gateway 错误：${error.message}`);
  });

  gateway.on('reconnecting', (info) => {
    logger.warn(`将在 ${info.delayMs}ms 后重连（第 ${info.attempt} 次）`);
  });

  gateway.on('fatal', (info) => {
    logger.error(`Gateway 致命错误 code=${info.code}（${CLOSE_CODE_MEANING[info.code] ?? info.reason}），请检查机器人状态`);
  });

  const shutdown = (signal: string): void => {
    logger.info(`收到 ${signal}，正在退出...`);
    gateway.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await gateway.run();
  logger.info('程序退出');
}

main().catch((error: unknown) => {
  console.error('启动失败：', describeError(error));
  process.exitCode = 1;
});

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
import { acquireLock, releaseLock } from './instance-lock.js';
import { createLogger, describeError, setLogLevel } from './logger.js';
import { GroupMessageHandler } from './commands/bot.js';
import { EastmoneyFundFlowProvider } from './market/fundflow.js';
import { QqApiClient } from './qq/api-client.js';
import { MessageDeduplicator } from './qq/dedupe.js';
import { GatewayClient, type GatewayEvent } from './qq/gateway.js';
import { SessionStore } from './qq/session-store.js';
import { TokenManager } from './qq/token.js';
import { CLOSE_CODE_MEANING, extractMessageIndex, type GroupAtMessageCreateData } from './qq/types.js';
import { join } from 'node:path';

async function main(): Promise<void> {
  const env = loadDotEnv();
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const logger = createLogger('app');
  logger.info(`QQ Bot MVP 启动中（env=${config.qqEnv}，apiBase=${config.apiBase}）`);
  logger.info(env.loaded ? `已加载环境变量文件：${env.path}` : '未找到 .env，使用进程内环境变量');

  // 单实例保护：两个进程连同一机器人时，平台会把同一条群消息投递给两个连接，
  // 于是每个指令被回复两遍。这里在连接前直接拒绝启动。
  const lockPath = join(process.cwd(), '.tmp-probe', 'bot.lock');
  const lock = acquireLock(lockPath, logger);
  if (!lock.ok) {
    logger.error(
      `已有另一个机器人在运行（pid=${lock.holder.pid}，启动于 ${lock.holder.startedAt}），` +
        '拒绝启动以免同一消息被回复两次。',
    );
    logger.error(`如果确认该进程已退出，可删除锁文件后重试：${lockPath}`);
    process.exitCode = 1;
    return;
  }
  const releaseLockOnExit = (): void => releaseLock(lockPath, logger);
  process.on('exit', releaseLockOnExit);

  if (!config.logEvents) {
    logger.info('提示：排查 @ 事件时可设置 LOG_EVENTS=true 打印全部事件');
  }

  const tokens = new TokenManager({
    appId: config.appId,
    clientSecret: config.clientSecret,
    logger,
  });

  const api = new QqApiClient({ apiBase: config.apiBase, tokens, logger });
  const fundflow = new EastmoneyFundFlowProvider({ logger, cacheTtlMs: config.marketCacheTtlMs });

  const handler = new GroupMessageHandler({
    api,
    fundflow,
    logger,
    dedupe: new MessageDeduplicator(),
    imageOutputDir: config.imageOutputDir,
    fontFiles: config.fontFiles,
  });

  const sessionStore = new SessionStore({
    filePath: join(process.cwd(), '.tmp-probe', 'gateway-session.json'),
    logger,
  });

  // 会话缓存绑定 AppID：更换机器人账号后不会复用上一个 bot 的会话。
  // 默认不启用 Resume（SESSION_RESUME=true 才启用）：平台对已失效的会话也会返回
  // RESUMED 但不再推送事件，直接新建会话最可靠；启用后由看门狗兜底。
  const sessionOwner = { appId: config.appId, apiBase: config.apiBase };
  let resumeSession: { sessionId: string; lastSeq: number } | null = null;
  if (config.sessionResume) {
    const loaded = sessionStore.loadFor(sessionOwner);
    if (loaded.status === 'stale-app') {
      logger.warn(
        `已丢弃不属于当前机器人的会话缓存（缓存 AppID=${loaded.previous.appId ?? '未记录'}，当前=${config.appId}），将重新鉴权`,
      );
      sessionStore.clear();
    } else if (loaded.status === 'found') {
      resumeSession = { sessionId: loaded.session.sessionId, lastSeq: loaded.session.lastSeq };
      logger.info(
        `找到历史会话，将尝试 Resume：session_id=${loaded.session.sessionId} seq=${loaded.session.lastSeq} ` +
          `机器人=${loaded.session.botName ?? '未知'}（${loaded.session.botId ?? '-'}）`,
      );
    }
  } else if (sessionStore.read()) {
    logger.info('SESSION_RESUME 未启用，忽略本地会话缓存并新建会话（避免复用已失效会话收不到事件）');
  }

  const gateway = new GatewayClient({
    tokens,
    intents: config.intents,
    logger,
    gatewayUrl: config.gatewayUrl,
    fetchGatewayUrl: () => api.getGatewayUrl(),
    session: resumeSession,
    resumeGraceMs: config.sessionResume ? config.resumeGraceMs : 0,
    onSessionChange: (session) => {
      // 保存最新 seq，SESSION_RESUME=true 时可在进程重启后 Resume
      if (session) sessionStore.save(session, sessionOwner);
    },
  });

  gateway.on('ready', (data) => {
    logger.info(`已连接 QQ Gateway，机器人：${data.user?.username ?? '未知'}（${data.user?.id ?? '-'}）`);
    logger.info('现在可以在测试群里 @机器人 发送「大盘」或「ping」');
  });

  gateway.on('resumed', () => {
    logger.info('会话已恢复，继续接收事件（若长时间无事件会自动重新鉴权）');
  });

  if (config.logEvents) {
    gateway.on('event', (event: GatewayEvent) => {
      logger.debug(`事件 ${event.type}：${JSON.stringify(event.data).slice(0, 800)}`);
    });
  }

  gateway.on('groupAtMessage', (data: GroupAtMessageCreateData) => {
    // 引用回复：把用户那条消息的索引带上，图片会以引用形式挂在它下面
    const messageReference = extractMessageIndex(data.message_scene);
    logger.info(
      `收到群 @ 消息：group=${data.group_openid} user=${data.author?.username ?? '未知'} ` +
        `content="${(data.content ?? '').replace(/\s+/g, ' ').slice(0, 80)}"` +
        (messageReference ? ` msg_idx=${messageReference.slice(0, 16)}…` : '（无 msg_idx，将不引用）'),
    );
    void handler
      .handle({
        messageId: data.id,
        groupOpenid: data.group_openid,
        content: data.content,
        username: data.author?.username,
        ...(messageReference ? { messageReference } : {}),
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

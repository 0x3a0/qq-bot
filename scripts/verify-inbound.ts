/**
 * 收消息自检：连上 Gateway 后等待用户在测试群 @机器人，
 * 打印收到的 GROUP_AT_MESSAGE_CREATE 事件（不回复任何消息）。
 *
 * 用于里程碑 1：确认能正常收到 QQ 群用户的消息。
 *
 * 用法：
 *   npm run verify:inbound            # 最多等待 5 分钟
 *   npm run verify:inbound -- 60      # 最多等待 60 秒
 */
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadDotEnv } from '../src/env.js';
import { createLogger, describeError, setLogLevel } from '../src/logger.js';
import { QqApiClient } from '../src/qq/api-client.js';
import { GatewayClient } from '../src/qq/gateway.js';
import { SessionStore } from '../src/qq/session-store.js';
import { TokenManager } from '../src/qq/token.js';
import { CLOSE_CODE_MEANING, type GroupAtMessageCreateData } from '../src/qq/types.js';

const DEFAULT_WAIT_SECONDS = 300;

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  setLogLevel(config.logLevel === 'debug' ? 'debug' : 'info');
  const logger = createLogger('verify-inbound');

  const waitSeconds = Number(process.argv[2] ?? DEFAULT_WAIT_SECONDS);
  const waitMs = (Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : DEFAULT_WAIT_SECONDS) * 1000;

  const tokens = new TokenManager({ appId: config.appId, clientSecret: config.clientSecret, logger });
  const api = new QqApiClient({ apiBase: config.apiBase, tokens, logger });
  const sessionStore = new SessionStore({
    filePath: join(process.cwd(), '.tmp-probe', 'gateway-session.json'),
    logger,
  });
  const savedSession = sessionStore.load();

  const gateway = new GatewayClient({
    tokens,
    intents: config.intents,
    logger,
    gatewayUrl: config.gatewayUrl,
    fetchGatewayUrl: () => api.getGatewayUrl(),
    session: savedSession,
    onSessionChange: (session) => {
      if (session) sessionStore.save(session);
    },
  });

  console.log('等待 QQ 群 @ 消息中……请在测试群里发送「@机器人 大盘」或「@机器人 ping」');
  console.log(`最多等待 ${waitMs / 1000} 秒，收到任意 @ 事件即结束。\n`);

  let received = 0;
  const startedAt = Date.now();

  const finish = (code: number): void => {
    gateway.stop();
    setTimeout(() => process.exit(code), 200);
  };

  gateway.on('ready', (data) => {
    console.log(`[已连接] 机器人：${data.user?.username ?? '未知'}，session_id=${data.session_id ?? '-'}`);
  });

  gateway.on('resumed', () => {
    console.log('[会话已恢复]');
  });

  gateway.on('event', (event) => {
    if (event.type !== 'GROUP_AT_MESSAGE_CREATE') {
      console.log(`[其他事件] ${event.type}`);
    }
  });

  gateway.on('groupAtMessage', (data: GroupAtMessageCreateData) => {
    received += 1;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n✅ 收到群 @ 消息（第 ${received} 条，用时 ${elapsed}s）`);
    console.log(`   msg_id      : ${data.id}`);
    console.log(`   group_openid: ${data.group_openid}`);
    console.log(`   member_openid: ${data.author?.member_openid ?? '-'}`);
    console.log(`   昵称         : ${data.author?.username ?? '-'}`);
    console.log(`   内容         : ${JSON.stringify(data.content ?? '')}`);
    console.log(`   时间         : ${data.timestamp ?? '-'}`);
    console.log('\n原始事件体：');
    console.log(JSON.stringify(data, null, 2));
    finish(0);
  });

  gateway.on('error', (error) => {
    console.log(`[错误] ${error.message}`);
  });

  gateway.on('closed', (info) => {
    console.log(`[连接关闭] code=${info.code} ${CLOSE_CODE_MEANING[info.code] ?? info.reason}`);
  });

  gateway.on('fatal', (info) => {
    console.error(`\n[致命错误] code=${info.code} ${CLOSE_CODE_MEANING[info.code] ?? info.reason}`);
    finish(2);
  });

  const timeout = setTimeout(() => {
    console.error(`\n❌ ${waitMs / 1000} 秒内没有收到任何群 @ 消息。`);
    console.error('排查清单：');
    console.error('1) APP_ID / CLIENT_SECRET 是否与开放平台一致（npm run verify:qq）');
    console.error('2) 机器人是否已加入该测试群，且群里 @ 的是这个机器人');
    console.error('3) 开放平台的「沙箱环境」是否与 QQ_ENV 配置一致（沙箱群只能用 sandbox 接入点）');
    console.error('4) 群消息列表是否已把机器人加入白名单/发送权限');
    finish(1);
  }, waitMs);
  timeout.unref?.();

  await gateway.run();
  clearTimeout(timeout);
}

main().catch((error: unknown) => {
  console.error('收消息自检失败：', describeError(error));
  process.exitCode = 1;
});

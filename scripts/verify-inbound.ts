/**
 * 收消息自检：连上 Gateway 后等待用户在测试群 @机器人，
 * 打印收到的 GROUP_AT_MESSAGE_CREATE 事件（不回复任何消息）。
 *
 * 用于里程碑 1：确认能正常收到 QQ 群用户的消息。
 *
 * 用法：
 *   npm run verify:inbound              # 最多等待 5 分钟
 *   npm run verify:inbound -- 60        # 最多等待 60 秒
 *   npm run verify:inbound -- 60 --reset  # 忽略并清理上次的会话缓存
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

  const args = process.argv.slice(2);
  const resetSession = args.includes('--reset');
  const rawWait = args.find((arg) => !arg.startsWith('--'));
  const waitSeconds = Number(rawWait ?? DEFAULT_WAIT_SECONDS);
  const waitMs = (Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : DEFAULT_WAIT_SECONDS) * 1000;

  const tokens = new TokenManager({ appId: config.appId, clientSecret: config.clientSecret, logger });
  const api = new QqApiClient({ apiBase: config.apiBase, tokens, logger });

  // 会话缓存绑定 AppID：换机器人后不会复用旧会话
  const sessionStore = new SessionStore({
    filePath: join(process.cwd(), '.tmp-probe', 'gateway-session.json'),
    logger,
  });
  if (resetSession) {
    sessionStore.clear();
    console.log('[--reset] 已清理上次的会话缓存');
  }
  const loaded = sessionStore.loadFor({ appId: config.appId, apiBase: config.apiBase });
  if (loaded.status === 'stale-app') {
    console.log(
      `[会话缓存已丢弃] 缓存属于 AppID ${loaded.previous.appId ?? '(未记录)'}` +
        ` / ${loaded.previous.apiBase ?? '(未记录)'}，当前为 ${config.appId} / ${config.apiBase}`,
    );
    sessionStore.clear();
  }

  const gateway = new GatewayClient({
    tokens,
    intents: config.intents,
    logger,
    gatewayUrl: config.gatewayUrl,
    fetchGatewayUrl: () => api.getGatewayUrl(),
    session: loaded.status === 'found' ? loaded.session : null,
    onSessionChange: (session) => {
      if (session) sessionStore.save(session, { appId: config.appId, apiBase: config.apiBase });
    },
  });

  console.log('当前运行配置：');
  console.log(`  APP_ID     : ${config.appId}`);
  console.log(`  QQ_ENV     : ${config.qqEnv}（${config.apiBase}）`);
  console.log(`  intents    : ${config.intents}`);
  console.log(`  会话缓存   : ${loaded.status === 'found' ? '命中（将尝试 Resume）' : '未使用（将重新鉴权）'}`);
  console.log(`  缓存文件   : ${sessionStore.path}`);

  // 先确认凭据对应的到底是哪个机器人，避免"换了账号还是上一个 bot"的困惑
  const bot = await api.getBotInfo();
  console.log(`  凭据对应机器人: ${bot.username ?? '(未知昵称)'}（id=${bot.id ?? '-'}）`);
  console.log('\n等待 QQ 群 @ 消息中……请在测试群里发送「@机器人 大盘」或「@机器人 ping」');
  console.log(`最多等待 ${waitMs / 1000} 秒，收到任意 @ 事件即结束。\n`);

  let received = 0;
  const startedAt = Date.now();

  const finish = (code: number): void => {
    gateway.stop();
    setTimeout(() => process.exit(code), 200);
  };

  gateway.on('ready', (data) => {
    console.log(`[已连接] 机器人：${data.user?.username ?? '未知'}（id=${data.user?.id ?? '-'}）session_id=${data.session_id ?? '-'}`);
  });

  gateway.on('resumed', () => {
    console.log(`[会话已恢复] 复用的是本 AppID（${config.appId}）上次的会话，事件可能在此期间被补发`);
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
    console.error(`1) 上面「凭据对应机器人」是否是你要测的机器人（当前 APP_ID=${config.appId}）`);
    console.error('2) 机器人是否已加入该测试群，且群里 @ 的是这个机器人');
    console.error('3) 开放平台的「沙箱环境」是否与 QQ_ENV 配置一致（沙箱群只能用 sandbox 接入点）');
    console.error('4) 群消息列表是否已把机器人加入白名单/发送权限');
    console.error('5) 更换过账号时用 --reset 清理旧会话缓存：npm run verify:inbound -- 60 --reset');
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

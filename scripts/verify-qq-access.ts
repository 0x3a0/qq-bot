/**
 * QQ 接入自检：验证 APP_ID / CLIENT_SECRET 是否可用，以及 Gateway 接入点能否获取。
 * 只读取 token 与网关地址，不发送任何消息。
 * 用法：npm run verify:qq
 */
import { loadConfig } from '../src/config.js';
import { loadDotEnv } from '../src/env.js';
import { createLogger, describeError, setLogLevel } from '../src/logger.js';
import { QqApiClient } from '../src/qq/api-client.js';
import { TokenManager } from '../src/qq/token.js';
import { DEFAULT_INTENTS } from '../src/config.js';

async function main(): Promise<void> {
  const env = loadDotEnv();
  const config = loadConfig();
  setLogLevel(config.logLevel === 'error' ? 'error' : 'info');
  const logger = createLogger('verify-qq');

  console.log(`环境变量文件：${env.loaded ? env.path : '(未找到 .env)'}`);
  console.log(`APP_ID：${config.appId.slice(0, 4)}****`);
  console.log(`QQ_ENV：${config.qqEnv}`);
  console.log(`apiBase：${config.apiBase}`);
  console.log(`intents：${config.intents}（默认群聊 ${DEFAULT_INTENTS}）`);

  const tokens = new TokenManager({
    appId: config.appId,
    clientSecret: config.clientSecret,
    logger,
  });

  const accessToken = await tokens.get();
  const remainingSec = Math.round((accessToken.expiresAt - Date.now()) / 1000);
  console.log(`\n[1/3] Access Token 获取成功，剩余有效期约 ${remainingSec} 秒`);

  const api = new QqApiClient({ apiBase: config.apiBase, tokens, logger });
  const bot = await api.getBotInfo();
  console.log(`[2/3] /users/@me 成功：${bot.username ?? '(未知昵称)'} id=${bot.id ?? '-'}`);

  const gatewayUrl = config.gatewayUrl ?? (await api.getGatewayUrl());
  console.log(`[3/3] Gateway 接入点：${gatewayUrl}`);
  console.log('\n自检通过，可以运行 npm start 接收群 @ 消息。');
}

main().catch((error: unknown) => {
  console.error('\nQQ 自检失败：', describeError(error));
  console.error('排查建议：确认 .env 中 APP_ID / CLIENT_SECRET 正确，且机器人已加入测试群。');
  process.exitCode = 1;
});

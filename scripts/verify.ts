/**
 * 自检入口：按子命令执行各类验证。
 *
 *   npm run verify                 # 等价于 verify all（不含 upload）
 *   npm run verify -- market       # 行情取数与排序（无需 QQ 凭据）
 *   npm run verify -- render       # 本地渲染一张真实数据的 PNG（无需 QQ 凭据）
 *   npm run verify -- qq           # Access Token + Gateway 接入点
 *   npm run verify -- inbound 60   # ★ 监听并打印群 @ 事件，最多等 60 秒
 *   npm run verify -- inbound 60 --reset   # 同上，先清理会话缓存
 *   npm run verify -- upload <group_openid> [图片路径]   # 富媒体分片上传诊断
 *
 * 退出码：0 成功；1 失败/超时；2 用法错误。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_INTENTS, loadConfig, type AppConfig } from '../src/config.js';
import { loadDotEnv } from '../src/env.js';
import { createLogger, describeError, setLogLevel } from '../src/logger.js';
import { EastmoneyIndustryProvider, MAX_TOP_BLOCKS, takeTopBlocks } from '../src/market/eastmoney.js';
import { formatChangePercent, formatQuoteTime, formatTurnover, summarizeBlocks } from '../src/market/format.js';
import { QqApiClient, MD5_10M_BYTES, md5 } from '../src/qq/api-client.js';
import { GatewayClient } from '../src/qq/gateway.js';
import { SessionStore } from '../src/qq/session-store.js';
import { TokenManager } from '../src/qq/token.js';
import { CLOSE_CODE_MEANING, type GroupAtMessageCreateData } from '../src/qq/types.js';
import { renderPng } from '../src/render/image.js';

type SubCommand = 'all' | 'market' | 'render' | 'qq' | 'inbound' | 'upload';

const USAGE = [
  '用法：npm run verify -- <子命令> [参数]',
  '',
  '  all               依次执行 market + render + qq（默认）',
  '  market            行情取数与成交额排序自检',
  '  render            渲染一张真实数据的 PNG',
  '  qq                校验 Access Token 与 Gateway 接入点',
  '  inbound [秒数]    监听群 @ 事件（默认 300 秒），可加 --reset 清理会话缓存',
  '  upload <group_openid> [图片路径]   富媒体分片上传诊断',
].join('\n');

/** 加载配置；渲染/行情自检不需要 QQ 凭据，缺失时使用占位值。 */
function loadAppConfig(options: { requireCredentials: boolean }): AppConfig {
  if (options.requireCredentials) return loadConfig();
  return loadConfig({
    ...process.env,
    APP_ID: process.env.APP_ID ?? 'verify-placeholder',
    CLIENT_SECRET: process.env.CLIENT_SECRET ?? 'verify-placeholder',
  });
}

function createProvider(logger: ReturnType<typeof createLogger>) {
  return new EastmoneyIndustryProvider({ logger, cacheTtlMs: 0 });
}

// ---------------------------------------------------------------------------
// market：行情取数与排序
// ---------------------------------------------------------------------------
async function runMarket(): Promise<void> {
  const logger = createLogger('verify:market');
  const provider = createProvider(logger);
  const snapshot = await provider.getIndustrySnapshot();
  const top = takeTopBlocks(snapshot.blocks, MAX_TOP_BLOCKS);

  console.log(`\n来源：${snapshot.source}`);
  console.log(`行情时间：${formatQuoteTime(snapshot.quoteTime)}`);
  console.log(`行业板块总数：${snapshot.blocks.length}`);
  console.log(`成交额 TOP${MAX_TOP_BLOCKS}：`);
  for (const [index, block] of top.entries()) {
    console.log(
      `${String(index + 1).padStart(2, ' ')}. ${block.name.padEnd(8, '　')} ` +
        `${formatChangePercent(block.changePercent).padStart(8)} ${formatTurnover(block.turnover).padStart(9)}`,
    );
  }

  const sorted = top.every((block, index) => index === 0 || (top[index - 1]?.turnover ?? 0) >= block.turnover);
  const stats = summarizeBlocks(top);
  console.log(`\n按成交额降序：${sorted ? '通过' : '失败'}`);
  console.log(`涨跌统计：上涨 ${stats.up} / 下跌 ${stats.down} / 平盘 ${stats.flat}`);
  if (!sorted) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// render：本地渲染 PNG
// ---------------------------------------------------------------------------
async function runRender(): Promise<void> {
  const config = loadAppConfig({ requireCredentials: false });
  setLogLevel(config.logLevel === 'debug' ? 'debug' : 'info');
  const logger = createLogger('verify:render');

  const provider = createProvider(logger);
  const snapshot = await provider.getIndustrySnapshot();
  const top = takeTopBlocks(snapshot.blocks, MAX_TOP_BLOCKS);

  const image = renderPng({
    blocks: top,
    source: snapshot.source,
    quoteTime: snapshot.quoteTime,
    fetchedAt: snapshot.fetchedAt,
    fontFiles: config.fontFiles,
  });

  const dir = join(process.cwd(), '.tmp-probe', 'preview');
  await mkdir(dir, { recursive: true });
  const pngPath = join(dir, 'market-sample.png');
  const svgPath = join(dir, 'market-sample.svg');
  await writeFile(pngPath, image.png);
  await writeFile(svgPath, image.svg, 'utf8');

  const stats = summarizeBlocks(top);
  logger.info(`PNG：${pngPath}（${image.width}x${image.height}，${(image.png.length / 1024).toFixed(0)}KB）`);
  logger.info(`SVG：${svgPath}`);
  logger.info(`行情时间：${formatQuoteTime(snapshot.quoteTime)}，来源：${snapshot.source}`);
  logger.info(`涨跌统计：上涨 ${stats.up} / 下跌 ${stats.down} / 平盘 ${stats.flat}`);
}

// ---------------------------------------------------------------------------
// qq：凭据与接入点
// ---------------------------------------------------------------------------
async function runQq(): Promise<void> {
  const config = loadAppConfig({ requireCredentials: true });
  setLogLevel(config.logLevel === 'error' ? 'error' : 'info');
  const logger = createLogger('verify:qq');
  const env = loadDotEnv();

  console.log(`环境变量文件：${env.loaded ? env.path : '(未找到 .env)'}`);
  console.log(`APP_ID：${config.appId.slice(0, 4)}****`);
  console.log(`QQ_ENV：${config.qqEnv}`);
  console.log(`apiBase：${config.apiBase}`);
  console.log(`intents：${config.intents}（默认群聊 ${DEFAULT_INTENTS}）`);

  const tokens = new TokenManager({ appId: config.appId, clientSecret: config.clientSecret, logger });
  const accessToken = await tokens.get();
  console.log(`\n[1/3] Access Token 获取成功，剩余有效期约 ${Math.round((accessToken.expiresAt - Date.now()) / 1000)} 秒`);

  const api = new QqApiClient({ apiBase: config.apiBase, tokens, logger });
  const bot = await api.getBotInfo();
  console.log(`[2/3] /users/@me 成功：${bot.username ?? '(未知昵称)'} id=${bot.id ?? '-'}`);

  const gatewayUrl = config.gatewayUrl ?? (await api.getGatewayUrl());
  console.log(`[3/3] Gateway 接入点：${gatewayUrl}`);
  console.log('\n自检通过，可以运行 npm run verify -- inbound 接收群 @ 消息。');
}

// ---------------------------------------------------------------------------
// inbound：监听群 @ 事件
// ---------------------------------------------------------------------------
async function runInbound(args: string[]): Promise<void> {
  const config = loadAppConfig({ requireCredentials: true });
  setLogLevel(config.logLevel === 'debug' ? 'debug' : 'info');
  const logger = createLogger('verify:inbound');

  const resetSession = args.includes('--reset');
  const rawWait = args.find((arg) => !arg.startsWith('--'));
  const parsedWait = Number(rawWait ?? 300);
  const waitMs = (Number.isFinite(parsedWait) && parsedWait > 0 ? parsedWait : 300) * 1000;

  const tokens = new TokenManager({ appId: config.appId, clientSecret: config.clientSecret, logger });
  const api = new QqApiClient({ apiBase: config.apiBase, tokens, logger });

  const sessionStore = new SessionStore({
    filePath: join(process.cwd(), '.tmp-probe', 'gateway-session.json'),
    logger,
  });
  if (resetSession) {
    sessionStore.clear();
    console.log('[--reset] 已清理上次的会话缓存');
  }

  const sessionOwner = { appId: config.appId, apiBase: config.apiBase };
  let resumeSession: { sessionId: string; lastSeq: number } | null = null;
  let sessionLabel = '未使用（将重新鉴权）';
  if (config.sessionResume) {
    const loaded = sessionStore.loadFor(sessionOwner);
    if (loaded.status === 'stale-app') {
      console.log(
        `[会话缓存已丢弃] 缓存属于 AppID ${loaded.previous.appId ?? '(未记录)'}` +
          ` / ${loaded.previous.apiBase ?? '(未记录)'}，当前为 ${config.appId} / ${config.apiBase}`,
      );
      sessionStore.clear();
    } else if (loaded.status === 'found') {
      resumeSession = { sessionId: loaded.session.sessionId, lastSeq: loaded.session.lastSeq };
      sessionLabel = `命中（尝试 Resume，seq=${loaded.session.lastSeq}）`;
    }
  } else if (sessionStore.read()) {
    sessionLabel = '已忽略（SESSION_RESUME=false，新建会话）';
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
      if (session) sessionStore.save(session, sessionOwner);
    },
  });

  console.log('当前运行配置：');
  console.log(`  APP_ID     : ${config.appId}`);
  console.log(`  QQ_ENV     : ${config.qqEnv}（${config.apiBase}）`);
  console.log(`  intents    : ${config.intents}`);
  console.log(`  会话缓存   : ${sessionLabel}`);
  console.log(`  缓存文件   : ${sessionStore.path}`);

  const bot = await api.getBotInfo();
  console.log(`  凭据对应机器人: ${bot.username ?? '(未知昵称)'}（id=${bot.id ?? '-'}）`);
  console.log('\n等待 QQ 群 @ 消息中……请在测试群里发送「@机器人 大盘」或「@机器人 ping」');
  console.log(`最多等待 ${waitMs / 1000} 秒，收到任意 @ 事件即结束。\n`);

  const startedAt = Date.now();
  let received = 0;

  const finish = (code: number): void => {
    gateway.stop();
    setTimeout(() => process.exit(code), 200);
  };

  gateway.on('ready', (data) => {
    console.log(
      `[已连接] 机器人：${data.user?.username ?? '未知'}（id=${data.user?.id ?? '-'}）session_id=${data.session_id ?? '-'}`,
    );
  });

  gateway.on('resumed', () => {
    console.log(`[会话已恢复] 复用的是本 AppID（${config.appId}）上次的会话`);
  });

  gateway.on('event', (event) => {
    if (event.type !== 'GROUP_AT_MESSAGE_CREATE') console.log(`[其他事件] ${event.type}`);
  });

  gateway.on('groupAtMessage', (data: GroupAtMessageCreateData) => {
    received += 1;
    console.log(`\n✅ 收到群 @ 消息（第 ${received} 条，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
    console.log(`   msg_id       : ${data.id}`);
    console.log(`   group_openid : ${data.group_openid}`);
    console.log(`   member_openid: ${data.author?.member_openid ?? '-'}`);
    console.log(`   昵称         : ${data.author?.username ?? '-'}`);
    console.log(`   内容         : ${JSON.stringify(data.content ?? '')}`);
    console.log(`   时间         : ${data.timestamp ?? '-'}`);
    console.log('\n原始事件体：');
    console.log(JSON.stringify(data, null, 2));
    finish(0);
  });

  gateway.on('error', (error) => console.log(`[错误] ${error.message}`));
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
    console.error('3) 开放平台的沙箱环境是否与 QQ_ENV 配置一致（沙箱群只能用 sandbox 接入点）');
    console.error('4) 群消息列表是否已把机器人加入白名单/发送权限');
    console.error('5) 更换过账号时清理会话缓存：npm run verify -- inbound 60 --reset');
    finish(1);
  }, waitMs);
  timeout.unref?.();

  await gateway.run();
  clearTimeout(timeout);
}

// ---------------------------------------------------------------------------
// upload：富媒体分片上传诊断
// ---------------------------------------------------------------------------
async function runUpload(args: string[]): Promise<void> {
  const groupOpenid = args[0];
  if (!groupOpenid) {
    console.error('用法：npm run verify -- upload <group_openid> [图片路径]');
    process.exitCode = 2;
    return;
  }
  const filePath = args[1] ?? join(process.cwd(), '.tmp-probe', 'preview', 'market-sample.png');
  const config = loadAppConfig({ requireCredentials: true });
  setLogLevel('debug');

  const logger = createLogger('verify:upload');
  const tokens = new TokenManager({ appId: config.appId, clientSecret: config.clientSecret, logger });
  const api = new QqApiClient({ apiBase: config.apiBase, tokens, logger });

  const buffer = await readFile(filePath);
  const fileSize = (await stat(filePath)).size;
  const fileName = filePath.split(/[\\/]/).pop() ?? 'image.png';
  const sha1 = createHash('sha1').update(buffer).digest('hex');
  const md5_10m = md5(buffer.subarray(0, MD5_10M_BYTES));

  console.log(`\n文件：${filePath}`);
  console.log(`大小：${fileSize} 字节，文件名：${fileName}`);
  console.log(`md5=${md5(buffer)} sha1=${sha1} md5_10m=${md5_10m}`);

  console.log('\n--- [1/4] upload_prepare ---');
  const prepare = await api.uploadPrepare({
    groupOpenid,
    fileType: 1,
    fileSize,
    fileName,
    md5: md5(buffer),
    sha1,
    md5_10m,
  });
  console.log(`upload_id=${prepare.uploadId} block_size=${prepare.blockSize}`);
  console.log(`分片序号：${prepare.parts.map((part) => part.index).join(',')}（注意服务端为 1-based）`);

  console.log('\n--- [2/4] PUT 分片 ---');
  const parts = [...prepare.parts].sort((a, b) => a.index - b.index);
  for (const part of parts) {
    const partSize = part.blockSize > 0 ? part.blockSize : prepare.blockSize;
    const start = (part.index - 1) * partSize;
    const end = Math.min(start + partSize, buffer.length);
    const chunk = buffer.subarray(start, end);
    console.log(`分片 ${part.index}: bytes ${start}..${end}（${chunk.length} 字节）`);

    const put = await fetch(part.presignedUrl, {
      method: 'PUT',
      body: new Uint8Array(chunk),
      headers: { 'Content-Length': String(chunk.length) },
    });
    console.log(`  PUT 状态：${put.status} ${put.statusText}`);
    if (!put.ok) throw new Error(`分片 ${part.index} PUT 失败`);

    console.log('--- [3/4] upload_part_finish ---');
    await api.uploadPartFinish({
      groupOpenid,
      uploadId: prepare.uploadId,
      partIndex: part.index,
      blockSize: chunk.length,
      md5: md5(chunk),
    });
    console.log(`  分片 ${part.index} 完成确认 OK`);
  }

  console.log('\n--- [4/4] merge ---');
  const merged = await api.uploadMerge({ groupOpenid, uploadId: prepare.uploadId, fileType: 1, fileName });
  console.log(`合并成功：file_info 长度 ${merged.fileInfo.length}，ttl=${merged.ttl ?? '-'}`);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  loadDotEnv();
  const [rawCommand = 'all', ...args] = process.argv.slice(2);
  const command = rawCommand as SubCommand;

  switch (command) {
    case 'all':
      await runMarket();
      await runRender();
      await runQq();
      return;
    case 'market':
      await runMarket();
      return;
    case 'render':
      await runRender();
      return;
    case 'qq':
      await runQq();
      return;
    case 'inbound':
      await runInbound(args);
      return;
    case 'upload':
      await runUpload(args);
      return;
    default:
      console.error(`未知子命令：${rawCommand}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error('\n自检失败：', describeError(error));
  console.error('排查建议：确认 .env 中 APP_ID / CLIENT_SECRET 正确，且机器人已加入测试群。');
  process.exitCode = 1;
});

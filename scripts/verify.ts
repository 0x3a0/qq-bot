/**
 * 自检入口：按子命令执行各类验证。
 *
 *   npm run verify                 # 等价于 verify all（不含 upload）
 *   npm run verify -- fundflow     # 行业 / 概念板块资金流取数与校验（无需 QQ 凭据）
 *   npm run verify -- render       # 本地渲染两张 PNG（行业 + 概念，无需 QQ 凭据）
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
import { formatChangePercent, formatAmount, formatImageTitle, formatQuoteTime, summarizeBlocks } from '../src/market/format.js';
import { EastmoneyFundFlowProvider } from '../src/market/fundflow.js';
import {
  FUND_FLOW_PERIOD_LABEL,
  SECTOR_KIND_LABEL,
  takeTopByMainNet,
  type FundFlowPeriod,
  type SectorKind,
} from '../src/market/fundflow-types.js';
import { MAX_TOP_SECTORS, takeTopBlocks } from '../src/market/sectors.js';
import { METRIC_FOOTER_LABEL, METRIC_LABEL } from '../src/commands/bot.js';
import { QqApiClient, MD5_10M_BYTES, md5 } from '../src/qq/api-client.js';
import { GatewayClient } from '../src/qq/gateway.js';
import { SessionStore } from '../src/qq/session-store.js';
import { TokenManager } from '../src/qq/token.js';
import { CLOSE_CODE_MEANING, type GroupAtMessageCreateData } from '../src/qq/types.js';
import { renderPng } from '../src/render/image.js';

type SubCommand = 'all' | 'fundflow' | 'render' | 'qq' | 'inbound' | 'upload';

const USAGE = [
  '用法：npm run verify -- <子命令> [参数]',
  '',
  '  all               依次执行 fundflow + render + qq（默认）',
  '  fundflow [周期]   行业 / 概念板块资金流自检（周期 today|5d|10d，默认 today）',
  '  render            渲染两张真实数据的 PNG（行业 + 概念）',
  '  qq                校验 Access Token 与 Gateway 接入点',
  '  inbound [秒数]    监听群 @ 事件（默认 300 秒），可加 --reset 清理会话缓存',
  '  upload <group_openid> [图片路径]   富媒体分片上传诊断',
].join('\n');

/** 加载配置；渲染/资金流自检不需要 QQ 凭据，缺失时使用占位值。 */
function loadAppConfig(options: { requireCredentials: boolean }): AppConfig {
  if (options.requireCredentials) return loadConfig();
  return loadConfig({
    ...process.env,
    APP_ID: process.env.APP_ID ?? 'verify-placeholder',
    CLIENT_SECRET: process.env.CLIENT_SECRET ?? 'verify-placeholder',
  });
}

// ---------------------------------------------------------------------------
// fundflow：行业 / 概念板块资金流
// ---------------------------------------------------------------------------
const FUND_FLOW_TOP = 10;

async function runFundFlow(args: string[]): Promise<void> {
  const period = (args[0] ?? 'today') as FundFlowPeriod;
  if (!(period in FUND_FLOW_PERIOD_LABEL)) {
    console.error(`未知周期：${args[0]}（可选 today | 5d | 10d）`);
    process.exitCode = 2;
    return;
  }

  const logger = createLogger('verify:fundflow');
  const provider = new EastmoneyFundFlowProvider({ logger, cacheTtlMs: 0 });

  console.log(`\n统计周期：${FUND_FLOW_PERIOD_LABEL[period]}（fid=${period === 'today' ? 'f62' : period === '5d' ? 'f164' : 'f174'}）`);

  let failures = 0;

  for (const kind of ['industry', 'concept'] as SectorKind[]) {
    const started = Date.now();
    let snapshot;
    try {
      snapshot = await provider.getSectorFundFlow(kind, period);
    } catch (error) {
      failures += 1;
      console.error(`\n❌ ${SECTOR_KIND_LABEL[kind]} 资金流获取失败：${describeError(error)}`);
      continue;
    }

    const top = takeTopByMainNet(snapshot.sectors, FUND_FLOW_TOP);
    const elapsed = Date.now() - started;

    console.log(`\n${'='.repeat(74)}`);
    console.log(`${SECTOR_KIND_LABEL[kind]} · ${FUND_FLOW_PERIOD_LABEL[period]}主力净流入 TOP${FUND_FLOW_TOP}`);
    console.log(`来源：${snapshot.source}  板块总数：${snapshot.sectors.length}  行情时间：${formatQuoteTime(snapshot.quoteTime)}  耗时：${elapsed}ms`);
    console.log(`${'='.repeat(74)}`);
    console.log('  #  板块                 涨跌幅     主力净额      占比     超大单       大单');
    for (const [index, sector] of top.entries()) {
      console.log(
        `${String(index + 1).padStart(3)}. ${sector.name.padEnd(12, '　')} ` +
          `${formatChangePercent(sector.changePercent).padStart(8)} ` +
          `${formatAmount(sector.mainNet).padStart(12)} ` +
          `${`${sector.mainNetRatio.toFixed(2)}%`.padStart(8)} ` +
          `${formatAmount(sector.superNet).padStart(12)} ${formatAmount(sector.bigNet).padStart(12)}`,
      );
    }

    // 校验 1：主力净额 = 超大单 + 大单（接口口径）
    const consistent = snapshot.sectors.filter((sector) =>
      Math.abs(sector.mainNet - (sector.superNet + sector.bigNet)) < 1,
    ).length;
    const driftOk = consistent === snapshot.sectors.length;

    // 校验 2：排序确为降序
    const sortedOk = snapshot.sectors.every(
      (sector, index) => index === 0 || (snapshot.sectors[index - 1]?.mainNet ?? 0) >= sector.mainNet,
    );

    // 校验 3：资金守恒（主力 + 中单 + 小单 ≈ 0，误差来自服务端四舍五入）
    const conserved = snapshot.sectors.filter(
      (sector) => Math.abs(sector.mainNet + sector.midNet + sector.smallNet) <= Math.max(2, Math.abs(sector.mainNet) * 0.001),
    ).length;

    // 校验 4：净流入 / 净流出都应有数据（全为同号说明字段取错）
    const inflow = snapshot.sectors.filter((sector) => sector.mainNet > 0).length;
    const outflow = snapshot.sectors.filter((sector) => sector.mainNet < 0).length;

    console.log(`\n校验：`);
    console.log(`  ${driftOk ? '✅' : '❌'} 主力净额 = 超大单 + 大单：${consistent}/${snapshot.sectors.length}`);
    console.log(`  ${sortedOk ? '✅' : '❌'} 按主力净额降序返回：${sortedOk ? '通过' : '失败'}`);
    console.log(`  ℹ️ 资金守恒（主力+中单+小单≈0）：${conserved}/${snapshot.sectors.length}`);
    console.log(`  ℹ️ 净流入 ${inflow} 个 / 净流出 ${outflow} 个`);
    if (!driftOk || !sortedOk) failures += 1;
  }

  // 明细接口自检：取当前行业第一名的分钟级资金流
  try {
    const industry = await provider.getSectorFundFlow('industry', period);
    const leader = takeTopByMainNet(industry.sectors, 1)[0];
    if (leader) {
      const detail = await provider.getSectorFundFlowDetail(leader.code);
      const last = detail.points.at(-1);
      console.log(`\n明细接口：${detail.code} ${detail.name} 分钟级点位 ${detail.points.length} 个`);
      console.log(
        `  最新点位 ${last?.time ?? '-'}：主力 ${formatAmount(last?.mainNet ?? 0)}` +
          ` / 超大单 ${formatAmount(last?.superNet ?? 0)} / 大单 ${formatAmount(last?.bigNet ?? 0)}`,
      );
      const detailOk =
        detail.points.length > 0 &&
        (last ? Math.abs(last.mainNet - (last.superNet + last.bigNet)) < 1 : false);
      console.log(`  ${detailOk ? '✅' : '❌'} 分钟级明细主力净额与超大单+大单一致`);
      if (!detailOk) failures += 1;
    }
  } catch (error) {
    failures += 1;
    console.error(`\n❌ 明细分接口自检失败：${describeError(error)}`);
  }

  console.log(`\n资金流自检结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  if (failures > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// render：本地渲染两张 PNG（行业 + 概念）
// ---------------------------------------------------------------------------
async function runRender(): Promise<void> {
  const config = loadAppConfig({ requireCredentials: false });
  setLogLevel(config.logLevel === 'debug' ? 'debug' : 'info');
  const logger = createLogger('verify:render');

  const provider = new EastmoneyFundFlowProvider({ logger, cacheTtlMs: 0 });
  const dir = join(process.cwd(), '.tmp-probe', 'preview');
  await mkdir(dir, { recursive: true });

  for (const kind of ['industry', 'concept'] as SectorKind[]) {
    const snapshot = await provider.getSectorFundFlow(kind, 'today');
    const blocks = takeTopBlocks(snapshot, MAX_TOP_SECTORS);
    const kindLabel = SECTOR_KIND_LABEL[kind];

    const image = renderPng({
      blocks,
      source: snapshot.source,
      quoteTime: snapshot.quoteTime,
      fetchedAt: snapshot.fetchedAt,
      title: formatImageTitle({
        kindLabel,
        metricLabel: METRIC_LABEL,
        blockCount: blocks.length,
      }),
      metricLabel: METRIC_FOOTER_LABEL,
      fontFiles: config.fontFiles,
    });

    const pngPath = join(dir, `fundflow-${kind}.png`);
    const svgPath = join(dir, `fundflow-${kind}.svg`);
    await writeFile(pngPath, image.png);
    await writeFile(svgPath, image.svg, 'utf8');

    const stats = summarizeBlocks(blocks);
    logger.info(
      `${kindLabel} PNG：${pngPath}（${image.width}x${image.height}，${(image.png.length / 1024).toFixed(0)}KB）`,
    );
    logger.info(
      `  板块=${blocks.length} 行情时间=${formatQuoteTime(snapshot.quoteTime)} ` +
        `涨跌：上涨 ${stats.up} / 下跌 ${stats.down} / 平盘 ${stats.flat}`,
    );
    logger.info(`  主力净流入第一：${blocks[0]?.name ?? '-'} ${formatAmount(blocks[0]?.turnover ?? 0)}`);
  }
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
      await runFundFlow([]);
      await runRender();
      await runQq();
      return;
    case 'fundflow':
      await runFundFlow(args);
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

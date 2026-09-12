/**
 * 群消息处理：指令路由、板块资金流取数、图片渲染、富媒体上传与被动回复。
 *
 * 大盘指令的回复形态：两张图片（行业板块 + 概念板块），
 * 各自「渲染完成即发送」，不等待另一张，最大化感知速度。
 *
 * 关键约束（官方文档）：
 * - 被动回复需携带 msg_id，5 分钟内有效，同一 msg_id 最多回复 5 次；
 * - 相同的 msg_id + msg_seq 重复发送会失败（错误码 40054005「消息被去重」），
 *   因此每条回复都必须认领一个未被占用的 msg_seq；
 * - 相同 msg_id 可能重复推送，需要做事件级去重；
 * - 富媒体消息需先上传拿到 file_info，再用 msg_type=7 发送。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describeError, type Logger } from '../logger.js';
import { formatImageTitle, formatQuoteTime } from '../market/format.js';
import { MAX_TOP_SECTORS, takeTopBlocks } from '../market/sectors.js';
import {
  FUND_FLOW_PERIOD_LABEL,
  SECTOR_KIND_LABEL,
  type FundFlowPeriod,
  type FundFlowProvider,
  type FundFlowSnapshot,
  type SectorKind,
} from '../market/fundflow-types.js';
import { renderPng } from '../render/image.js';
import { QqApiError, type QqApiClient } from '../qq/api-client.js';
import type { MessageDeduplicator } from '../qq/dedupe.js';
import { HELP_TEXT, parseCommand } from './parser.js';

/** 平台限制：同一 msg_id 最多回复 5 次，对应 msg_seq 1..5。 */
export const MAX_REPLY_SEQ = 5;
/** 命中「消息被去重」时的最大重试次数。 */
export const MAX_DEDUPE_RETRIES = 3;

/** 平台错误码：消息被去重 / 被动回复时间或次数超限。 */
export const ERR_MESSAGE_DEDUPED = 40054005;
export const ERR_PASSIVE_REPLY_LIMIT = 40034128;

/**
 * 出图指标名（用于图片主标题与页脚说明）。
 * 主标题用「主力」而非「主力流入」：榜单按主力净额降序，但尾部板块可能是净流出，
 * 写成「流入」会与实际数据矛盾。
 */
export const METRIC_LABEL = '主力';

/** 页脚说明用语（比主标题更完整，说明矩形面积的口径）。 */
export const METRIC_FOOTER_LABEL = '主力净额';

export interface GroupMessage {
  /** 事件体 d.id，用于被动回复 */
  messageId: string;
  groupOpenid: string;
  content?: string;
  /** 发送者昵称，仅用于日志 */
  username?: string;
  /**
   * 被引用消息 ID（事件的 message_scene.ext 里的 msg_idx）。
   * 填写后回复以「引用」形式挂在用户那条消息下，效果上接近「跟在发言人后面」。
   */
  messageReference?: string;
}

export interface MessageHandlingDeps {
  api: Pick<QqApiClient, 'sendGroupText' | 'sendGroupImage' | 'uploadGroupFileFromBuffer'>;
  /** 板块资金流数据源（行业 / 概念） */
  fundflow: Pick<FundFlowProvider, 'getSectorFundFlow'>;
  logger: Logger;
  dedupe: MessageDeduplicator;
  /** 出图的统计周期，默认 today */
  period?: FundFlowPeriod;
  /** 允许回复的群 openid 白名单；为空表示不限制（本地测试用） */
  allowedGroups?: Set<string>;
  /** 图片输出目录；设置后会把 PNG 落盘便于排查 */
  imageOutputDir?: string;
  /** 是否落盘调试图片；false 时完全不写磁盘（线上推荐） */
  debugImages?: boolean;
  /** 图片中文字体 */
  fontFiles?: string[];
  renderer?: typeof renderPng;
  now?: () => Date;
}

export type MessageHandlingOutcome =
  /** 大盘：两张图都发出去了 */
  | 'images-sent'
  /** 大盘：只发出去一张（另一张失败） */
  | 'partial'
  /** ping / 帮助 的文字回复 */
  | 'text-sent'
  /** 数据或图片失败，改用文字说明 */
  | 'fallback-sent'
  | 'duplicate'
  | 'ignored'
  | 'forbidden'
  | 'reply-limit';

export class GroupMessageHandler {
  private readonly deps: MessageHandlingDeps;
  private readonly logger: Logger;

  constructor(deps: MessageHandlingDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('handler');
  }

  async handle(message: GroupMessage): Promise<MessageHandlingOutcome> {
    const { messageId, groupOpenid } = message;

    // 事件级去重：平台可能重复推送同一 msg_id。
    // 注意：命中重复后不释放该标记，重投事件由平台侧与被动回复上限共同兜底；
    // 释放标记会让同一 msg_seq 被重复占用，反而触发 40054005。
    if (!this.deps.dedupe.mark(`${this.eventKey(message)}`)) {
      this.logger.warn(`忽略重复事件：group=${groupOpenid} msg_id=${messageId}`);
      return 'duplicate';
    }

    if (this.deps.allowedGroups && this.deps.allowedGroups.size > 0 && !this.deps.allowedGroups.has(groupOpenid)) {
      this.logger.warn(`群 ${groupOpenid} 不在白名单中，忽略消息`);
      return 'forbidden';
    }

    const command = parseCommand(message.content);
    const preview = (message.content ?? '').replace(/\s+/g, ' ').slice(0, 60);
    if (!command) {
      this.logger.info(
        `收到群消息但未匹配指令：group=${groupOpenid} user=${message.username ?? '未知'} content="${preview}"`,
      );
      return 'ignored';
    }

    this.logger.info(
      `处理指令 ${command.kind}：group=${groupOpenid} msg_id=${messageId} user=${message.username ?? '未知'} content="${preview}"`,
    );

    switch (command.kind) {
      case 'ping':
        return this.replyPing(message);
      case 'help':
        return this.replyText(message, HELP_TEXT);
      case 'market':
        return this.replyMarket(message);
      default:
        return 'ignored';
    }
  }

  private eventKey(message: GroupMessage): string {
    return `${message.groupOpenid}:${message.messageId}#event`;
  }

  private async replyPing(message: GroupMessage): Promise<MessageHandlingOutcome> {
    const now = this.deps.now?.() ?? new Date();
    return this.replyText(message, `pong · 机器人在线 · ${formatQuoteTime(now)}`);
  }

  /**
   * 发送文字回复：自动认领未被占用的 msg_seq，命中平台判重时换序号重试。
   */
  private async replyText(message: GroupMessage, content: string): Promise<MessageHandlingOutcome> {
    const result = await this.sendWithSeq(message, (seq) =>
      this.deps.api.sendGroupText({
        groupOpenid: message.groupOpenid,
        content,
        msgId: message.messageId,
        msgSeq: seq,
        ...(message.messageReference ? { messageReference: message.messageReference } : {}),
      }),
    );

    if (result.ok) {
      this.logger.info(
        `已发送文字回复：group=${message.groupOpenid} seq=${result.seq} 长度=${content.length}`,
      );
      return 'text-sent';
    }
    return result.seq === null ? 'reply-limit' : 'ignored';
  }

  /**
   * 大盘：并发取「行业 + 概念」资金流，两张图各自渲染完成即发送。
   *
   * 并发而非串行：两个数据源彼此独立（各自 5~6 页请求），
   * 串行会把耗时叠加；并发后总耗时接近较慢的那一个。
   * 渲染同样是「谁先好谁先发」，用户先拿到第一张，不必等第二张。
   */
  private async replyMarket(message: GroupMessage): Promise<MessageHandlingOutcome> {
    const kinds: SectorKind[] = ['industry', 'concept'];
    // 两条链路并发启动（渲染完就各自发送），这里只是按固定顺序收集结果；
    // 先完成的那张图片会在自己的链路里立刻发出，不必等另一张。
    const pending = kinds.map((kind) =>
      this.renderSectorImage(message, kind).then(
        (value) => ({ status: 'fulfilled' as const, kind, value }),
        (reason: unknown) => ({ status: 'rejected' as const, kind, reason }),
      ),
    );

    let sent = 0;
    let limitReached = false;
    const failures: { kind: SectorKind; error: string }[] = [];

    for (const settled of pending) {
      const result = await settled;
      if (result.status === 'fulfilled') {
        if (result.value.sent) sent += 1;
        else if (result.value.reason === 'reply-limit') limitReached = true;
        else failures.push({ kind: result.kind, error: result.value.error ?? '未知错误' });
      } else {
        failures.push({ kind: result.kind, error: describeError(result.reason).split('\n')[0] ?? '未知错误' });
      }
    }

    // 两张都没发出去：至少给用户一个文字说明（属于错误提示，不是数据回复）
    if (sent === 0) {
      if (limitReached) {
        this.logger.error('被动回复次数已用尽，两张图片都未能发送');
        return 'reply-limit';
      }
      const detail = failures.map((item) => `${SECTOR_KIND_LABEL[item.kind]}：${item.error}`).join('；');
      const textOutcome = await this.replyText(
        message,
        `板块资金流数据获取失败，请稍后重试。\n原因：${detail || '未知错误'}`,
      );
      return textOutcome === 'text-sent' ? 'fallback-sent' : textOutcome;
    }

    if (failures.length > 0) {
      this.logger.warn(
        `部分图片未发送：${failures.map((item) => `${SECTOR_KIND_LABEL[item.kind]}(${item.error})`).join('；')}`,
      );
    }
    return sent === 2 ? 'images-sent' : 'partial';
  }

  /**
   * 当前消息下一个可用的 msg_seq。
   * 认领后不再归还：平台已把该 seq 记为「用过」，复用只会再次判重；
   * 且两条图片链路并发发送，归还会让两个发送拿到同一个序号。
   */
  private readonly nextSeq = new Map<string, number>();

  private claimReplySeq(msgId: string): number | null {
    const seq = this.nextSeq.get(msgId) ?? 1;
    if (seq > MAX_REPLY_SEQ) return null;
    this.nextSeq.set(msgId, seq + 1);
    return seq;
  }

  /**
   * 取一类板块的资金流并出图发送。
   * 返回是否发送成功；失败时把原因交给上层统一汇报。
   */
  private async renderSectorImage(
    message: GroupMessage,
    kind: SectorKind,
  ): Promise<{ sent: boolean; reason?: 'send-failed' | 'reply-limit'; error?: string }> {
    const { api, fundflow, logger } = this.deps;
    const kindLabel = SECTOR_KIND_LABEL[kind];
    const period = this.deps.period ?? 'today';
    const periodLabel = FUND_FLOW_PERIOD_LABEL[period];

    let snapshot: FundFlowSnapshot;
    let blocks;
    try {
      const startedAt = Date.now();
      snapshot = await fundflow.getSectorFundFlow(kind, period);
      blocks = takeTopBlocks(snapshot, MAX_TOP_SECTORS);
      logger.info(
        `取到${kindLabel}${periodLabel}资金流 ${snapshot.sectors.length} 个，` +
          `取前 ${blocks.length} 个出图（耗时 ${Date.now() - startedAt}ms）`,
      );
      if (blocks.length === 0) throw new Error('没有可用的板块数据');
    } catch (error) {
      logger.error(`${kindLabel}资金流获取失败：${describeError(error)}`);
      return { sent: false, reason: 'send-failed', error: describeError(error).split('\n')[0] ?? '未知错误' };
    }

    let png: Buffer;
    try {
      const renderer = this.deps.renderer ?? renderPng;
      const image = renderer({
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
        fontFiles: this.deps.fontFiles,
      });
      png = image.png;
      // 调试图仅用于排查，落盘失败不影响发送
      await this.saveDebugImage(`${message.messageId}-${kind}`, png);    } catch (error) {
      logger.error(`${kindLabel}图片渲染失败：${describeError(error)}`);
      return { sent: false, reason: 'send-failed', error: describeError(error).split('\n')[0] ?? '未知错误' };
    }

    try {
      // 直接从内存上传：不经过临时文件，避免并发/多进程下读到别人的图
      const uploaded = await api.uploadGroupFileFromBuffer({
        groupOpenid: message.groupOpenid,
        buffer: png,
        fileName: `fundflow-${kind}-${Date.now()}.png`,
        fileType: 1,
      });
      const sent = await this.sendWithSeq(message, (seq) =>
        api.sendGroupImage({
          groupOpenid: message.groupOpenid,
          fileInfo: uploaded.fileInfo,
          msgId: message.messageId,
          msgSeq: seq,
          ...(message.messageReference ? { messageReference: message.messageReference } : {}),
        }),
      );

      if (sent.ok) {
        logger.info(
          `已发送${kindLabel}图片：group=${message.groupOpenid} seq=${sent.seq} ` +
            `板块=${blocks.length} 行情时间=${formatQuoteTime(snapshot.quoteTime)}`,
        );
        return { sent: true };
      }
      if (sent.seq === null) return { sent: false, reason: 'reply-limit' };
      return {
        sent: false,
        reason: 'send-failed',
        error: describeError(sent.error).split('\n')[0] ?? '未知错误',
      };
    } catch (error) {
      logger.error(`${kindLabel}图片上传或发送失败：${describeError(error)}`);
      return { sent: false, reason: 'send-failed', error: describeError(error).split('\n')[0] ?? '未知错误' };
    }
  }

  /**
   * 通用被动回复：认领未被占用的 msg_seq，命中平台判重时换序号重试。
   * 平台对相同 msg_id + msg_seq 会直接判重（40054005），
   * 因此失败后必须换序号重试，不能沿用同一个 seq。
   */
  private async sendWithSeq(
    message: GroupMessage,
    sender: (seq: number) => Promise<unknown>,
  ): Promise<{ ok: boolean; seq: number | null; error?: unknown }> {
    const { logger } = this.deps;
    const msgId = message.messageId;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_DEDUPE_RETRIES; attempt += 1) {
      // 认领与发送在同一个同步步骤内完成，保证并发链路的 seq 顺序与发送顺序一致
      const seq = this.claimReplySeq(msgId);
      if (seq === null) {
        logger.error(`${msgId} 的被动回复次数已用尽（上限 ${MAX_REPLY_SEQ} 次），放弃回复`);
        return { ok: false, seq: null, ...(lastError === undefined ? {} : { error: lastError }) };
      }

      try {
        await sender(seq);
        return { ok: true, seq };
      } catch (error) {
        lastError = error;
        if (!this.isRetryableSendError(error)) {
          return { ok: false, seq, error };
        }
        logger.warn(
          `msg_seq=${seq} 被平台判为重复（${describeError(error).split('\n')[0] ?? ''}），` +
            `改用下一个 msg_seq 重试（第 ${attempt + 1} 次）`,
        );
      }
    }

    return { ok: false, seq: null, ...(lastError === undefined ? {} : { error: lastError }) };
  }

  /** 换 msg_seq 重试是否有意义：只有「消息被去重」这类错误值得换序号重试。 */
  private isRetryableSendError(error: unknown): boolean {
    return error instanceof QqApiError && error.code === ERR_MESSAGE_DEDUPED;
  }

  /**
   * 落盘调试图片，便于排查渲染问题。
   * 文件名带 pid 与随机串：并发任务或多个进程同时运行时不会互相覆盖。
   * 线上可设 DEBUG_IMAGES=false 关闭，避免往容器磁盘反复写图。
   */
  private async saveDebugImage(tag: string, png: Buffer): Promise<string | null> {
    if (this.deps.debugImages === false) return null;
    try {
      const dir = this.deps.imageOutputDir ?? join(process.cwd(), '.tmp-probe', 'images');
      await mkdir(dir, { recursive: true });
      const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
      const filePath = join(dir, `market-${sanitize(tag)}-${Date.now()}-${suffix}.png`);
      await writeFile(filePath, png);
      this.logger.debug(`调试图片已保存：${filePath}`);
      return filePath;
    } catch (error) {
      // 调试图只是排查手段，写不进去不能影响正常发送
      this.logger.warn(`保存调试图片失败（忽略）：${describeError(error)}`);
      return null;
    }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'msg';
}

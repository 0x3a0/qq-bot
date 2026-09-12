/**
 * 群消息处理：指令路由、行情取数、图片渲染、富媒体上传与被动回复。
 *
 * 关键约束（官方文档）：
 * - 被动回复需携带 msg_id，5 分钟内有效，同一 msg_id 最多回复 5 次；
 * - 相同的 msg_id + msg_seq 重复发送会失败（错误码 40054005「消息被去重」），
 *   因此每条回复都必须认领一个未被占用的 msg_seq；
 * - 相同 msg_id 可能重复推送，需要做事件级去重；
 * - 富媒体消息需先上传拿到 file_info，再用 msg_type=7 发送。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError, type Logger } from '../logger.js';
import {
  formatBlockRanking,
  formatQuoteTime,
  formatRankingFooter,
  formatRankingTitle,
  formatTurnover,
} from '../market/format.js';
import type { MarketProvider } from '../market/types.js';
import { MAX_TOP_BLOCKS, takeTopBlocks } from '../market/eastmoney.js';
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

export interface GroupMessage {
  /** 事件体 d.id，用于被动回复 */
  messageId: string;
  groupOpenid: string;
  content?: string;
  /** 发送者昵称，仅用于日志 */
  username?: string;
}

export interface MessageHandlingDeps {
  api: Pick<QqApiClient, 'sendGroupText' | 'sendGroupImage' | 'uploadGroupFileFromPath'>;
  market: MarketProvider;
  logger: Logger;
  dedupe: MessageDeduplicator;
  /** 允许回复的群 openid 白名单；为空表示不限制（本地测试用） */
  allowedGroups?: Set<string>;
  /** 图片输出目录；设置后会把 PNG 落盘便于排查 */
  imageOutputDir?: string;
  /** 图片中文字体 */
  fontFiles?: string[];
  renderer?: typeof renderPng;
  now?: () => Date;
}

export type MessageHandlingOutcome =
  | 'image-sent'
  | 'text-sent'
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
        return this.replyHelp(message);
      case 'market':
        return this.replyMarket(message);
      default:
        return 'ignored';
    }
  }

  private eventKey(message: GroupMessage): string {
    return `${message.groupOpenid}:${message.messageId}#event`;
  }

  /**
   * 通用被动回复：每次尝试前认领一个未被占用的 msg_seq。
   * 平台对相同 msg_id + msg_seq 会直接判重（40054005），
   * 因此失败后必须换序号重试，不能沿用同一个 seq。
   */
  private async sendWithSeq(
    message: GroupMessage,
    sender: (seq: number) => Promise<unknown>,
  ): Promise<{ ok: boolean; seq: number | null; error?: unknown }> {
    const { dedupe, logger } = this.deps;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_DEDUPE_RETRIES; attempt += 1) {
      const seq = dedupe.claimSeq(message.messageId, MAX_REPLY_SEQ);
      if (seq === null) {
        logger.error(
          `msg_id=${message.messageId} 的被动回复次数已用尽（上限 ${MAX_REPLY_SEQ} 次），放弃回复`,
        );
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

  private async replyPing(message: GroupMessage): Promise<MessageHandlingOutcome> {
    const now = this.deps.now?.() ?? new Date();
    return this.replyText(message, `pong · 机器人在线 · ${formatQuoteTime(now)}`);
  }

  private async replyHelp(message: GroupMessage): Promise<MessageHandlingOutcome> {
    return this.replyText(message, HELP_TEXT);
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

  private async replyMarket(message: GroupMessage): Promise<MessageHandlingOutcome> {
    const { api, market, logger } = this.deps;

    try {
      const snapshot = await market.getIndustrySnapshot();
      const top = takeTopBlocks(snapshot.blocks, MAX_TOP_BLOCKS);
      if (top.length === 0) throw new Error('没有可用的行业板块数据');

      const renderer = this.deps.renderer ?? renderPng;
      const image = renderer({
        blocks: top,
        source: snapshot.source,
        quoteTime: snapshot.quoteTime,
        fetchedAt: snapshot.fetchedAt,
        fontFiles: this.deps.fontFiles,
      });

      const filePath = await this.saveDebugImage(message.messageId, image.png);
      const uploaded = await api.uploadGroupFileFromPath({
        groupOpenid: message.groupOpenid,
        filePath,
        fileName: `market-${Date.now()}.png`,
        fileType: 1,
      });

      // 先发文字榜单，再发图片：两次回复使用递增的 msg_seq（平台要求不同序号）
      const ranking = formatBlockRanking(top, {
        title: formatRankingTitle(top.length),
        footer: formatRankingFooter({
          source: snapshot.source,
          quoteTime: snapshot.quoteTime,
          fetchedAt: snapshot.fetchedAt,
          ...(this.deps.now ? { now: this.deps.now() } : {}),
        }),
      });

      const textSent = await this.replyText(message, ranking);
      if (textSent === 'reply-limit') {
        logger.error('被动回复次数已用尽，文字榜单未发送，跳过图片发送');
        return 'reply-limit';
      }
      if (textSent !== 'text-sent') {
        logger.warn('文字榜单发送失败，继续尝试发送图片');
      }

      const sent = await this.sendWithSeq(message, (seq) =>
        api.sendGroupImage({
          groupOpenid: message.groupOpenid,
          fileInfo: uploaded.fileInfo,
          msgId: message.messageId,
          msgSeq: seq,
        }),
      );

      if (sent.ok) {
        logger.info(
          `已发送行情图片：group=${message.groupOpenid} seq=${sent.seq} 板块=${top.length} ` +
            `尺寸=${image.width}x${image.height} 大小=${(image.png.length / 1024).toFixed(0)}KB ` +
            `行情时间=${formatQuoteTime(snapshot.quoteTime)}`,
        );
        return 'image-sent';
      }

      if (sent.seq === null) {
        // 被动回复次数已用尽：文字榜单已发出，用户至少能看到数据
        logger.error('被动回复次数已用尽，图片未发送（文字榜单已送达）');
        return 'reply-limit';
      }

      // 文字榜单已经在前面发过了，这里只补一句失败说明
      await this.replyText(message, await this.buildFallbackText(sent.error));
      return 'fallback-sent';
    } catch (error) {
      logger.error(`生成或发送行情图片失败：${describeError(error)}`);
      const textOutcome = await this.replyText(message, await this.buildFallbackText(error));
      return textOutcome === 'text-sent' ? 'fallback-sent' : textOutcome;
    }
  }

  private async buildFallbackText(error: unknown): Promise<string> {
    let hint = '图片生成失败，请稍后重试。';
    try {
      const snapshot = await this.deps.market.getIndustrySnapshot();
      const top = takeTopBlocks(snapshot.blocks, MAX_TOP_BLOCKS);
      if (top.length > 0) {
        const lines = top.slice(0, 10).map(
          (block, index) =>
            `${index + 1}. ${block.name} ${block.changePercent >= 0 ? '+' : ''}${block.changePercent.toFixed(2)}% ` +
            `${formatTurnover(block.turnover)}`,
        );
        hint = [
          '图片生成失败，先返回文字版行业板块成交额 TOP10：',
          ...lines,
          `数据源：${snapshot.source} · 行情时间：${formatQuoteTime(snapshot.quoteTime)}`,
        ].join('\n');
      }
    } catch (fallbackError) {
      this.logger.warn(`文字兜底取数同样失败：${describeError(fallbackError)}`);
      hint = `图片生成失败，行情数据也不可用：${describeError(error).split('\n')[0] ?? '未知错误'}`;
    }
    return hint;
  }

  /** 落盘调试图片，便于排查渲染问题；返回文件路径。 */
  private async saveDebugImage(messageId: string, png: Buffer): Promise<string> {
    const dir = this.deps.imageOutputDir ?? join(process.cwd(), '.tmp-probe', 'images');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `market-${sanitize(messageId)}-${Date.now()}.png`);
    await writeFile(filePath, png);
    this.logger.debug(`调试图片已保存：${filePath}`);
    return filePath;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'msg';
}

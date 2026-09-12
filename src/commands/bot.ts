/**
 * 群消息处理：指令路由、行情取数、图片渲染、富媒体上传与被动回复。
 *
 * 关键约束（官方文档）：
 * - 被动回复需携带 msg_id，5 分钟内有效，同一 msg_id 最多回复 5 次；
 * - 相同 msg_id 可能重复推送，需要按 msg_id/msg_seq 去重；
 * - 富媒体消息需先上传拿到 file_info，再用 msg_type=7 发送。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError, type Logger } from '../logger.js';
import { formatQuoteTime, formatTurnover } from '../market/format.js';
import type { MarketProvider } from '../market/types.js';
import { MAX_TOP_BLOCKS, takeTopBlocks } from '../market/eastmoney.js';
import { renderPng } from '../render/image.js';
import type { QqApiClient } from '../qq/api-client.js';
import type { MessageDeduplicator } from '../qq/dedupe.js';
import { HELP_TEXT, parseCommand } from './parser.js';

/** 同一 msg_id 最多回复 5 次（平台限制），首次回复用 1，兜底文案用 2。 */
export const SEQ_PRIMARY = 1;
export const SEQ_FALLBACK = 2;

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

export type MessageHandlingOutcome = 'image-sent' | 'text-sent' | 'fallback-sent' | 'duplicate' | 'ignored' | 'forbidden';

export class GroupMessageHandler {
  private readonly deps: MessageHandlingDeps;
  private readonly logger: Logger;

  constructor(deps: MessageHandlingDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('handler');
  }

  async handle(message: GroupMessage): Promise<MessageHandlingOutcome> {
    const { messageId, groupOpenid } = message;
    const dedupeKey = `${groupOpenid}:${messageId}`;

    if (!this.deps.dedupe.mark(`${dedupeKey}#event`)) {
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
        return this.replyText(message, HELP_TEXT, SEQ_PRIMARY);
      case 'market':
        return this.replyMarket(message);
      default:
        return 'ignored';
    }
  }

  private async replyPing(message: GroupMessage): Promise<MessageHandlingOutcome> {
    const now = this.deps.now?.() ?? new Date();
    const text = `pong · 机器人在线 · ${formatQuoteTime(now)}`;
    return this.replyText(message, text, SEQ_PRIMARY);
  }

  private async replyMarket(message: GroupMessage): Promise<MessageHandlingOutcome> {
    const { api, market, logger, dedupe } = this.deps;
    // 事件级的去重键在 handle() 里已经占用；处理失败时释放它，允许同一事件重试。
    const attemptKey = `${message.groupOpenid}:${message.messageId}#event`;

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

      await api.sendGroupImage({
        groupOpenid: message.groupOpenid,
        fileInfo: uploaded.fileInfo,
        msgId: message.messageId,
        msgSeq: SEQ_PRIMARY,
      });

      logger.info(
        `已发送行情图片：group=${message.groupOpenid} 板块=${top.length} 尺寸=${image.width}x${image.height} ` +
          `大小=${(image.png.length / 1024).toFixed(0)}KB 行情时间=${formatQuoteTime(snapshot.quoteTime)}`,
      );
      return 'image-sent';
    } catch (error) {
      logger.error(`生成或发送行情图片失败：${describeError(error)}`);
      dedupe.delete(attemptKey);
      const fallback = await this.buildFallbackText(error);
      return this.replyText(message, fallback, SEQ_FALLBACK, 'fallback-sent', true);
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

  private async replyText(
    message: GroupMessage,
    content: string,
    seq: number,
    outcome: MessageHandlingOutcome = 'text-sent',
    throwOnError = false,
  ): Promise<MessageHandlingOutcome> {
    try {
      await this.deps.api.sendGroupText({
        groupOpenid: message.groupOpenid,
        content,
        msgId: message.messageId,
        msgSeq: seq,
      });
      this.logger.info(`已发送文字回复：group=${message.groupOpenid} seq=${seq} 长度=${content.length}`);
      return outcome;
    } catch (error) {
      this.logger.error(`发送文字回复失败：${describeError(error)}`);
      if (throwOnError) throw error;
      return 'ignored';
    }
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

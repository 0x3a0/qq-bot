/**
 * QQ 开放平台 v2 HTTP API 客户端。
 *
 * 统一请求地址：https://api.bot.qq.com
 * 鉴权头：Authorization: QQBot {ACCESS_TOKEN}
 * 文档：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { TokenManager } from './token.js';

/** 分片校验值需要使用文件前 10002432 字节（约 9.54MB）。 */
export const MD5_10M_BYTES = 10_002_432;

export class QqApiError extends Error {
  readonly status: number;
  readonly code: number | string | undefined;
  readonly traceId: string | undefined;
  readonly body: string;

  constructor(params: { status: number; code?: number | string; message: string; traceId?: string; body: string }) {
    super(params.message);
    this.name = 'QqApiError';
    this.status = params.status;
    this.code = params.code;
    this.traceId = params.traceId;
    this.body = params.body;
  }
}

const gatewaySchema = z.object({ url: z.string().min(1) });

const uploadPrepareSchema = z.object({
  upload_id: z.string().min(1),
  block_size: z.union([z.string(), z.number()]),
  parts: z
    .array(
      z.object({
        index: z.number(),
        presigned_url: z.string().min(1),
        block_size: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .min(1),
  upload_config: z
    .object({
      concurrency: z.number().optional(),
      retry_timeout: z.number().optional(),
      retry_delay: z.number().optional(),
    })
    .partial()
    .optional(),
});

const uploadFileSchema = z.object({
  file_uuid: z.string().optional(),
  file_info: z.string().min(1),
  ttl: z.number().optional(),
  id: z.string().optional(),
  raw_url: z.string().optional(),
});

const sendMessageSchema = z.object({
  id: z.string().optional(),
  timestamp: z.string().optional(),
  ext_info: z.object({ ref_idx: z.string().optional() }).partial().optional(),
});

export interface UploadPreparePart {
  index: number;
  presignedUrl: string;
  blockSize: number;
}

export interface UploadPrepareResult {
  uploadId: string;
  blockSize: number;
  parts: UploadPreparePart[];
  config: { concurrency: number; retryTimeoutSec: number; retryDelaySec: number };
}

export interface UploadedFile {
  fileInfo: string;
  fileUuid?: string;
  ttl?: number;
}

export interface SendGroupMessageResult {
  id?: string;
  timestamp?: string;
  refIdx?: string;
}

export interface QqApiClientOptions {
  apiBase: string;
  tokens: TokenManager;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** 单次请求超时（毫秒），默认 15 秒；上传类接口建议更长 */
  timeoutMs?: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

export class QqApiClient {
  private readonly apiBase: string;
  private readonly tokens: TokenManager;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: QqApiClientOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, '');
    this.tokens = options.tokens;
    this.logger = options.logger.child('api');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** 通用请求：自动附带 token，失败时抛出 QqApiError。 */
  async request<T>(options: RequestOptions): Promise<T> {
    const url = options.path.startsWith('http') ? options.path : `${this.apiBase}${options.path}`;
    const authorization = await this.tokens.getAuthorizationHeader();
    const timeout = options.timeoutMs ?? this.timeoutMs;

    const response = await this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'qq-bot-mvp/0.1.0',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(timeout),
    });

    const text = await response.text();
    const traceId = response.headers.get('x-tps-trace-id') ?? undefined;

    if (!response.ok) {
      let code: number | string | undefined;
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { err_code?: number; code?: number; message?: string };
        code = parsed.err_code ?? parsed.code;
        if (parsed.message) message = parsed.message;
      } catch {
        message = text.slice(0, 300) || message;
      }
      throw new QqApiError({ status: response.status, code, message, traceId, body: text });
    }

    // 204 或空响应体
    if (text.trim().length === 0) return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`响应不是合法 JSON：${text.slice(0, 300)}`);
    }
  }

  /** GET /gateway：获取通用 WSS 接入点。 */
  async getGatewayUrl(): Promise<string> {
    const json = await this.request<unknown>({ path: '/gateway' });
    const parsed = gatewaySchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`/gateway 响应缺少 url 字段：${JSON.stringify(json).slice(0, 300)}`);
    }
    return parsed.data.url;
  }

  /** GET /users/@me：校验 token 是否有效（本地自检用）。 */
  async getBotInfo(): Promise<{ id?: string; username?: string }> {
    return this.request<{ id?: string; username?: string }>({ path: '/users/@me' });
  }

  /** POST /v2/groups/{group_openid}/messages：发送文本消息（msg_type=0）。 */
  async sendGroupText(params: {
    groupOpenid: string;
    content: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<SendGroupMessageResult> {
    const body: Record<string, unknown> = { msg_type: 0, content: params.content };
    if (params.msgId) {
      body.msg_id = params.msgId;
      body.msg_seq = params.msgSeq ?? 1;
    }
    const json = await this.request<unknown>({
      method: 'POST',
      path: `/v2/groups/${encodeURIComponent(params.groupOpenid)}/messages`,
      body,
    });
    return parseSendResult(json);
  }

  /** POST /v2/groups/{group_openid}/messages：发送富媒体消息（msg_type=7）。 */
  async sendGroupImage(params: {
    groupOpenid: string;
    fileInfo: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<SendGroupMessageResult> {
    const body: Record<string, unknown> = { msg_type: 7, media: { file_info: params.fileInfo } };
    if (params.msgId) {
      body.msg_id = params.msgId;
      body.msg_seq = params.msgSeq ?? 1;
    }
    const json = await this.request<unknown>({
      method: 'POST',
      path: `/v2/groups/${encodeURIComponent(params.groupOpenid)}/messages`,
      body,
      timeoutMs: 20_000,
    });
    return parseSendResult(json);
  }

  /** POST /v2/groups/{group_openid}/files：URL 上传（平台下载转存）。 */
  async uploadGroupFileByUrl(params: {
    groupOpenid: string;
    url: string;
    fileType?: number;
    fileName?: string;
  }): Promise<UploadedFile> {
    const json = await this.request<unknown>({
      method: 'POST',
      path: `/v2/groups/${encodeURIComponent(params.groupOpenid)}/files`,
      body: {
        file_type: params.fileType ?? 1,
        url: params.url,
        srv_send_msg: false,
        ...(params.fileName ? { file_name: params.fileName } : {}),
      },
      timeoutMs: 30_000,
    });
    return parseUploadedFile(json);
  }

  /** POST /v2/groups/{group_openid}/upload_prepare：分片上传第一步。 */
  async uploadPrepare(params: {
    groupOpenid: string;
    fileType: number;
    fileSize: number;
    fileName: string;
    md5: string;
    sha1: string;
    md5_10m: string;
  }): Promise<UploadPrepareResult> {
    const json = await this.request<unknown>({
      method: 'POST',
      path: `/v2/groups/${encodeURIComponent(params.groupOpenid)}/upload_prepare`,
      body: {
        file_type: params.fileType,
        file_size: String(params.fileSize),
        file_name: params.fileName,
        md5: params.md5,
        sha1: params.sha1,
        md5_10m: params.md5_10m,
      },
      timeoutMs: 30_000,
    });

    const parsed = uploadPrepareSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`upload_prepare 响应结构不符合预期：${JSON.stringify(json).slice(0, 500)}`);
    }
    const config = parsed.data.upload_config ?? {};
    return {
      uploadId: parsed.data.upload_id,
      blockSize: Number(parsed.data.block_size),
      parts: parsed.data.parts.map((part) => ({
        index: part.index,
        presignedUrl: part.presigned_url,
        blockSize: Number(part.block_size ?? parsed.data.block_size),
      })),
      config: {
        concurrency: config.concurrency ?? 1,
        retryTimeoutSec: config.retry_timeout ?? 300,
        retryDelaySec: config.retry_delay ?? 1,
      },
    };
  }

  /** POST /v2/groups/{group_openid}/upload_part_finish：通知某个分片上传完成。 */
  async uploadPartFinish(params: {
    groupOpenid: string;
    uploadId: string;
    partIndex: number;
    blockSize: number;
    md5: string;
  }): Promise<void> {
    await this.request<unknown>({
      method: 'POST',
      path: `/v2/groups/${encodeURIComponent(params.groupOpenid)}/upload_part_finish`,
      body: {
        upload_id: params.uploadId,
        part_index: params.partIndex,
        block_size: String(params.blockSize),
        md5: params.md5,
      },
      timeoutMs: 30_000,
    });
  }

  /** POST /v2/groups/{group_openid}/files：携带 upload_id 完成分片合并。 */
  async uploadMerge(params: {
    groupOpenid: string;
    uploadId: string;
    fileType: number;
    fileName?: string;
  }): Promise<UploadedFile> {
    const json = await this.request<unknown>({
      method: 'POST',
      path: `/v2/groups/${encodeURIComponent(params.groupOpenid)}/files`,
      body: {
        file_type: params.fileType,
        srv_send_msg: false,
        upload_id: params.uploadId,
        ...(params.fileName ? { file_name: params.fileName } : {}),
      },
      timeoutMs: 60_000,
    });
    return parseUploadedFile(json);
  }

  /**
   * 分片上传本地文件到群聊，返回 file_info。
   * 用于本地开发：QQ 平台无法访问 localhost，URL 上传不可用时的默认方案。
   */
  async uploadGroupFileFromPath(params: {
    groupOpenid: string;
    filePath: string;
    fileName?: string;
    fileType?: number;
  }): Promise<UploadedFile> {
    const buffer = await readFile(params.filePath);
    const fileSize = (await stat(params.filePath)).size;
    const fileName = params.fileName ?? params.filePath.split(/[\\/]/).pop() ?? 'image.png';
    const fileType = params.fileType ?? 1;

    const prepare = await this.uploadPrepare({
      groupOpenid: params.groupOpenid,
      fileType,
      fileSize,
      fileName,
      md5: md5(buffer),
      sha1: createHash('sha1').update(buffer).digest('hex'),
      md5_10m: md5(buffer.subarray(0, MD5_10M_BYTES)),
    });

    this.logger.info(`分片上传开始：${fileName}，${prepare.parts.length} 个分片，block_size=${prepare.blockSize}`);

    for (const part of prepare.parts) {
      const start = part.index * prepare.blockSize;
      const end = Math.min(start + prepare.blockSize, buffer.length);
      const chunk = buffer.subarray(start, end);

      const putResponse = await this.fetchImpl(part.presignedUrl, {
        method: 'PUT',
        body: new Uint8Array(chunk),
        headers: { 'Content-Length': String(chunk.length) },
        signal: AbortSignal.timeout(prepare.config.retryTimeoutSec * 1000),
      });
      if (!putResponse.ok) {
        const detail = await putResponse.text().catch(() => '');
        throw new Error(`分片 ${part.index} 上传失败：HTTP ${putResponse.status} ${detail.slice(0, 200)}`);
      }

      await this.uploadPartFinish({
        groupOpenid: params.groupOpenid,
        uploadId: prepare.uploadId,
        partIndex: part.index,
        blockSize: chunk.length,
        md5: md5(chunk),
      });
    }

    const uploaded = await this.uploadMerge({
      groupOpenid: params.groupOpenid,
      uploadId: prepare.uploadId,
      fileType,
      fileName,
    });
    this.logger.info(`分片上传完成：${fileName}，file_info 长度 ${uploaded.fileInfo.length}`);
    return uploaded;
  }

  /**
   * 优先分片上传本地文件；失败时抛出异常由上层决定兜底。
   */
  async uploadGroupImage(params: {
    groupOpenid: string;
    filePath: string;
    fileName?: string;
  }): Promise<UploadedFile> {
    return this.uploadGroupFileFromPath({ ...params, fileType: 1 });
  }
}

function parseSendResult(json: unknown): SendGroupMessageResult {
  const parsed = sendMessageSchema.safeParse(json);
  if (!parsed.success) return {};
  return { id: parsed.data.id, timestamp: parsed.data.timestamp, refIdx: parsed.data.ext_info?.ref_idx };
}

function parseUploadedFile(json: unknown): UploadedFile {
  const parsed = uploadFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`文件上传响应缺少 file_info：${JSON.stringify(json).slice(0, 500)}`);
  }
  return { fileInfo: parsed.data.file_info, fileUuid: parsed.data.file_uuid, ttl: parsed.data.ttl };
}

export function md5(buffer: Buffer | Uint8Array): string {
  return createHash('md5').update(buffer).digest('hex');
}

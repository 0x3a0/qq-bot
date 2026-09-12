/**
 * 运行配置：从环境变量读取，集中校验，避免散落的 process.env 访问。
 * 本地开发使用 .env 文件（由 src/env.ts 加载，不覆盖已存在的环境变量）。
 */
import { z } from 'zod';

/** 事件订阅 Intents 位。官方文档：GROUP_AND_C2C_EVENT = 1 << 25。 */
export const INTENT_GROUP_AND_C2C_EVENT = 1 << 25;
export const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;
export const DEFAULT_INTENTS = INTENT_GROUP_AND_C2C_EVENT;

export const QQ_PRODUCTION_API_BASE = 'https://api.bot.qq.com';
export const QQ_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';

export type QqEnv = 'production' | 'sandbox';

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
const boolSchema = z
  .string()
  .optional()
  .transform((value) => (value ?? '').trim().toLowerCase() === 'true');

const rawSchema = z.object({
  APP_ID: z
    .string({ required_error: 'APP_ID 不能为空（请复制 .env.example 为 .env 并填写）' })
    .trim()
    .min(1, 'APP_ID 不能为空（请复制 .env.example 为 .env 并填写）')
    .default(''),
  CLIENT_SECRET: z
    .string({ required_error: 'CLIENT_SECRET 不能为空（请复制 .env.example 为 .env 并填写）' })
    .trim()
    .min(1, 'CLIENT_SECRET 不能为空（请复制 .env.example 为 .env 并填写）')
    .default(''),
  QQ_ENV: z.enum(['production', 'sandbox']).default('production'),
  QQ_INTENTS: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return DEFAULT_INTENTS;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `QQ_INTENTS 必须是正整数，当前为 ${value}` });
        return z.NEVER;
      }
      return parsed;
    }),
  QQ_API_BASE: z.string().trim().optional(),
  QQ_GATEWAY_URL: z.string().trim().optional(),
  LOG_LEVEL: logLevelSchema.default('info'),
  LOG_EVENTS: boolSchema,
  /** 是否允许用持久化会话 Resume。默认 false：始终新建会话，避免复用"死会话"后收不到事件。 */
  SESSION_RESUME: boolSchema,
  /** 单实例保护：默认开启；容器平台跨部署 pid 会重复，已按运行环境判定 */
  INSTANCE_LOCK: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ?? '').trim().toLowerCase() !== 'false'),
  /** 是否把渲染出的图片落盘到 .tmp-probe/images（仅供本地排查）；默认开启，线上建议关闭 */
  DEBUG_IMAGES: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ?? '').trim().toLowerCase() !== 'false'),
  /** Resume 后的观察窗口（毫秒）：窗口内没收到任何事件则判定会话已失效并重新 Identify */
  RESUME_GRACE_MS: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return 10_000;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 1000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `RESUME_GRACE_MS 必须是不小于 1000 的数字，当前为 ${value}` });
        return z.NEVER;
      }
      return parsed;
    }),
  MARKET_CACHE_TTL_MS: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return 60_000;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `MARKET_CACHE_TTL_MS 必须是非负数字，当前为 ${value}` });
        return z.NEVER;
      }
      return parsed;
    }),
  FONT_FILES: z.string().trim().optional(),
  IMAGE_OUTPUT_DIR: z.string().trim().optional(),
});

export interface AppConfig {
  appId: string;
  clientSecret: string;
  qqEnv: QqEnv;
  intents: number;
  apiBase: string;
  gatewayUrl: string | null;
  logLevel: z.infer<typeof logLevelSchema>;
  logEvents: boolean;
  sessionResume: boolean;
  instanceLock: boolean;
  debugImages: boolean;
  resumeGraceMs: number;
  marketCacheTtlMs: number;
  fontFiles: string[];
  imageOutputDir: string;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function defaultApiBase(env: QqEnv): string {
  return env === 'sandbox' ? QQ_SANDBOX_API_BASE : QQ_PRODUCTION_API_BASE;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`配置校验失败：\n${details.join('\n')}`);
  }

  const raw = parsed.data;
  return {
    appId: raw.APP_ID,
    clientSecret: raw.CLIENT_SECRET,
    qqEnv: raw.QQ_ENV,
    intents: raw.QQ_INTENTS,
    apiBase: raw.QQ_API_BASE && raw.QQ_API_BASE.length > 0 ? raw.QQ_API_BASE : defaultApiBase(raw.QQ_ENV),
    gatewayUrl: raw.QQ_GATEWAY_URL && raw.QQ_GATEWAY_URL.length > 0 ? raw.QQ_GATEWAY_URL : null,
    logLevel: raw.LOG_LEVEL,
    logEvents: raw.LOG_EVENTS,
    sessionResume: raw.SESSION_RESUME,
    instanceLock: raw.INSTANCE_LOCK,
    debugImages: raw.DEBUG_IMAGES,
    resumeGraceMs: raw.RESUME_GRACE_MS,
    marketCacheTtlMs: raw.MARKET_CACHE_TTL_MS,
    fontFiles: splitList(raw.FONT_FILES),
    imageOutputDir: raw.IMAGE_OUTPUT_DIR && raw.IMAGE_OUTPUT_DIR.length > 0 ? raw.IMAGE_OUTPUT_DIR : '.tmp-probe/images',
  };
}

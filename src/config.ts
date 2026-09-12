/**
 * 运行配置：从环境变量读取，集中校验，避免散落的 process.env 访问。
 * 本地开发使用 .env 文件（由 src/env.ts 加载，不覆盖已存在的环境变量）。
 */
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
  /** 平台注入的监听端口（Render 等以「绑定端口」判定就绪）；未注入则不监听 */
  PORT: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return null;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `PORT 必须是 1..65535 的整数，当前为 ${value}` });
        return z.NEVER;
      }
      return parsed;
    }),
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
  /** 监听端口；null 表示不监听（本地默认） */
  port: number | null;
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
  const configuredFonts = splitList(raw.FONT_FILES);
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
    // 未显式配置时，使用构建阶段下载到仓库里的字体（部署环境通常没有中文字体）
    fontFiles: configuredFonts.length > 0 ? configuredFonts : detectBundledFonts(),
    imageOutputDir: raw.IMAGE_OUTPUT_DIR && raw.IMAGE_OUTPUT_DIR.length > 0 ? raw.IMAGE_OUTPUT_DIR : '.tmp-probe/images',
    port: raw.PORT,
  };
}

/**
 * 探测构建阶段放好的自带字体。
 *
 * 部署环境（Render 的 Debian 12 原生运行时、多数容器镜像）没有中文字体，
 * 而 resvg 缺字形时只会画「框框」且不报错。`scripts/fetch-font.mjs` 会在
 * 构建时把 Noto Sans SC 放到 assets/fonts/，这里自动使用它，
 * 免去手动配置 FONT_FILES。
 *
 * ⚠️ 返回的字体必须是**静态字重**（Regular + Bold）。resvg 不支持可变字体的
 * wght 轴：只给一个字体文件时，SVG 里的 font-weight（标题 700、板块名 600）
 * 会被**静默忽略**，整张图退化成该文件默认实例的字重。
 * 历史坑：`NotoSansSC-VF.ttf` 的默认实例是 Thin（usWeightClass=100），
 * 于是所有文字都变成发丝一样的极细体，在深色底上看起来就是「模糊」。
 */
export function detectBundledFonts(baseDir: string = process.cwd()): string[] {
  const resolveAll = (relatives: readonly string[]): string[] =>
    relatives.map((relative) => resolve(baseDir, relative)).filter((file) => existsSync(file));

  // 首选：静态 Regular + Bold（resvg 才会按 font-weight 选到粗体）
  const pair = resolveAll(BUNDLED_FONT_PAIR);
  // 两个都在才采用；只有一个时不要用——resvg 单字体时忽略 font-weight，
  // 会出现「标题和正文一样粗细」，不如走下面的兜底。
  if (pair.length === BUNDLED_FONT_PAIR.length) return pair;

  // 兜底：旧的可变字体（默认字重非 Regular，属于已知的次优解）
  return resolveAll(BUNDLED_FONT_CANDIDATES);
}

/**
 * 自带字体的首选组合：静态 Regular + Bold。
 *
 * 两个都必须存在才会被采用——只加载其中一个会让 font-weight 失效
 * （resvg 单字体时忽略字重），所以宁可退回下一组候选。
 */
export const BUNDLED_FONT_PAIR = [
  'assets/fonts/NotoSansSC-Regular.otf',
  'assets/fonts/NotoSansSC-Bold.otf',
] as const;

/** 兜底候选（旧命名，可变字体；按优先级排列） */
export const BUNDLED_FONT_CANDIDATES = [
  'assets/fonts/NotoSansSC-Regular.ttf',
  'assets/fonts/NotoSansSC-VF.ttf',
];

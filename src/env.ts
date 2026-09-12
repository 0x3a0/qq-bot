/**
 * 加载项目根目录下的 .env（如果存在）。
 *
 * 设计要点：不覆盖进程里已经存在的环境变量，这样 `APP_ID=xxx npm start`
 * 或 Railway / CI 注入的变量优先级始终高于本地文件。
 * 使用 Node 内置的 loadEnvFile（Node 20.12+ / 21.7+），不引入 dotenv 依赖。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

export interface LoadEnvResult {
  path: string;
  loaded: boolean;
}

function isMissing(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

export function loadDotEnv(
  filePath: string = resolve(process.cwd(), '.env'),
  env: NodeJS.ProcessEnv = process.env,
): LoadEnvResult {
  if (!existsSync(filePath)) return { path: filePath, loaded: false };

  const snapshot = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) snapshot.set(key, env[key]);

  loadEnvFile(filePath);

  for (const [key, value] of snapshot) {
    // loadEnvFile 会覆盖已有变量，这里恢复原有值（进程内已存在即优先）。
    if (!isMissing(value)) env[key] = value;
  }
  return { path: filePath, loaded: true };
}

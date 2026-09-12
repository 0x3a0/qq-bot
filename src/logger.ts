/** 简单日志工具：统一带时间戳与前缀，级别由 LOG_LEVEL 控制。 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[currentLevel];
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  );
}

export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string, rest: unknown[]): void => {
    if (!enabled(level)) return;
    const line = `${stamp()} [${level.toUpperCase()}] [${scope}] ${message}`;
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line, ...rest);
  };

  return {
    debug: (message, ...rest) => write('debug', message, rest),
    info: (message, ...rest) => write('info', message, rest),
    warn: (message, ...rest) => write('warn', message, rest),
    error: (message, ...rest) => write('error', message, rest),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

/** 把任意异常转成可读字符串，避免日志里出现 [object Object]。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

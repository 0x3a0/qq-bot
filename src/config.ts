function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function onebotWebSocketUrl(value: string | undefined): string {
  if (!value) throw new Error("ONEBOT_WS_URL must be configured");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ONEBOT_WS_URL must be a valid WebSocket URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("ONEBOT_WS_URL must use ws:// or wss://");
  }
  return value;
}

export interface AppConfig {
  onebotWsUrl: string;
  onebotWsToken?: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  requestTimeoutMs: number;
  botQq?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    onebotWsUrl: onebotWebSocketUrl(env.ONEBOT_WS_URL),
    onebotWsToken: env.ONEBOT_WS_TOKEN || undefined,
    reconnectMinMs: positiveInteger(env.ONEBOT_RECONNECT_MIN_MS, 1_000),
    reconnectMaxMs: positiveInteger(env.ONEBOT_RECONNECT_MAX_MS, 30_000),
    requestTimeoutMs: positiveInteger(env.ONEBOT_REQUEST_TIMEOUT_MS, 10_000),
    botQq: env.BOT_QQ || undefined
  };
}

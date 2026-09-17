import { loadConfig } from "./config.js";
import { isBoardPerformanceCommand } from "./bot/trigger.js";
import { replyWithBoardPerformanceCards } from "./bot/board-performance-reply.js";
import { ThsBoardPerformanceProvider } from "./market/ths-board-performance-provider.js";
import { OneBotClient } from "./onebot/client.js";
import type { GroupMessageEvent } from "./onebot/types.js";
import {
  closeBoardPerformanceCardRenderer,
  renderBoardPerformanceCards,
  warmBoardPerformanceCardRenderer
} from "./renderer/board-performance-card.js";

const config = loadConfig();
const client = new OneBotClient({
  url: config.onebotWsUrl,
  token: config.onebotWsToken,
  reconnectMinMs: config.reconnectMinMs,
  reconnectMaxMs: config.reconnectMaxMs,
  requestTimeoutMs: config.requestTimeoutMs,
  logger: console
});
const boardPerformanceDataProvider = new ThsBoardPerformanceProvider({
  apiKey: config.thsApiKey,
  requestTimeoutMs: config.marketRequestTimeoutMs,
  retries: config.marketRequestRetries,
  snapshotBatchSize: config.thsSnapshotBatchSize
});

void warmBoardPerformanceCardRenderer().catch((error: unknown) => {
  console.error("Board performance renderer warmup failed", error);
});

client.onEvent((event) => {
  const message = event as unknown as GroupMessageEvent;
  if (isBoardPerformanceCommand(message, config.botQq)) {
    void replyWithBoardPerformanceCards(message, {
      boardPerformanceDataProvider,
      renderBoardPerformanceCards,
      sendGroupMessage: (groupId, content) => client.sendGroupMessage(groupId, content),
      logger: console
    });
  }
});

void client.connect().catch((error: unknown) => console.error("Initial OneBot connection failed", error));

const shutdown = (): void => {
  client.close();
  void closeBoardPerformanceCardRenderer().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

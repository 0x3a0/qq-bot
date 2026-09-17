import { loadConfig } from "./config.js";
import { isAShareCommand, isUSShareCommand } from "./bot/trigger.js";
import { replyWithAShareScreenshots } from "./bot/a-share-reply.js";
import { replyWithUSShareScreenshots } from "./bot/us-share-reply.js";
import {
  captureBaiduFinanceScreenshots,
  captureBaiduFinanceUSScreenshots
} from "./capture/baidu-finance-screenshots.js";
import { OneBotClient } from "./onebot/client.js";
import type { GroupMessageEvent } from "./onebot/types.js";

const config = loadConfig();
const client = new OneBotClient({
  url: config.onebotWsUrl,
  token: config.onebotWsToken,
  reconnectMinMs: config.reconnectMinMs,
  reconnectMaxMs: config.reconnectMaxMs,
  requestTimeoutMs: config.requestTimeoutMs,
  logger: console
});
client.onEvent((event) => {
  const message = event as unknown as GroupMessageEvent;
  if (isAShareCommand(message, config.botQq)) {
    void replyWithAShareScreenshots(message, {
      captureScreenshots: captureBaiduFinanceScreenshots,
      sendGroupMessage: (groupId, content) => client.sendGroupMessage(groupId, content),
      logger: console
    });
  } else if (isUSShareCommand(message, config.botQq)) {
    void replyWithUSShareScreenshots(message, {
      captureScreenshots: captureBaiduFinanceUSScreenshots,
      sendGroupMessage: (groupId, content) => client.sendGroupMessage(groupId, content),
      logger: console
    });
  }
});

void client.connect().catch((error: unknown) => console.error("Initial OneBot connection failed", error));

const shutdown = (): void => {
  client.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

import { replyWithMarketScreenshots, type MarketReplyDependencies } from "./market-reply.js";
import type { GroupMessageEvent } from "../onebot/types.js";

export type USShareReplyDependencies = MarketReplyDependencies;

export async function replyWithUSShareScreenshots(
  event: GroupMessageEvent,
  dependencies: USShareReplyDependencies
): Promise<void> {
  await replyWithMarketScreenshots(event, dependencies, "U.S.-share", "美股行情截图获取或发送失败，请稍后重试。");
}

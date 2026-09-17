import { replyWithMarketScreenshots, type MarketReplyDependencies } from "./market-reply.js";
import type { GroupMessageEvent } from "../onebot/types.js";

export type AShareReplyDependencies = MarketReplyDependencies;

export async function replyWithAShareScreenshots(
  event: GroupMessageEvent,
  dependencies: AShareReplyDependencies
): Promise<void> {
  await replyWithMarketScreenshots(event, dependencies, "A-share", "A股行情截图获取或发送失败，请稍后重试。");
}

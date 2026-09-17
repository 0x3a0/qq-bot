import { replyWithCards } from "./card-reply.js";
import type { BoardPerformanceDataProvider } from "../market/types.js";
import type { GroupMessageEvent } from "../onebot/types.js";

export interface BoardPerformanceReplyDependencies {
  boardPerformanceDataProvider: BoardPerformanceDataProvider;
  renderBoardPerformanceCards: (
    data: Awaited<ReturnType<BoardPerformanceDataProvider["getBoardPerformanceData"]>>,
    outputDirectory: string
  ) => Promise<string[]>;
  sendGroupMessage: (groupId: number, message: Record<string, unknown>[]) => Promise<unknown>;
  logger: Pick<Console, "error" | "info">;
}

export async function replyWithBoardPerformanceCards(
  event: GroupMessageEvent,
  dependencies: BoardPerformanceReplyDependencies
): Promise<void> {
  await replyWithCards(event, {
    getData: () => dependencies.boardPerformanceDataProvider.getBoardPerformanceData(),
    renderCards: dependencies.renderBoardPerformanceCards,
    sendGroupMessage: dependencies.sendGroupMessage,
    logger: dependencies.logger,
    successLogMessage: "Board performance cards sent",
    failureLogMessage: "fetch or send board performance cards",
    failureMessage: "板块涨跌数据获取或图片发送失败，请稍后重试。"
  });
}

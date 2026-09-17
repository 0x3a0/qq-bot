import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroupMessageEvent } from "../onebot/types.js";

export interface CardReplyDependencies<T> {
  getData: () => Promise<T>;
  renderCards: (data: T, outputDirectory: string) => Promise<string[]>;
  sendGroupMessage: (groupId: number, message: Record<string, unknown>[]) => Promise<unknown>;
  logger: Pick<Console, "error" | "info">;
  successLogMessage: string;
  failureLogMessage: string;
  failureMessage: string;
}

export async function replyWithCards<T>(event: GroupMessageEvent, dependencies: CardReplyDependencies<T>): Promise<void> {
  let temporaryDirectory: string | undefined;
  try {
    const fetchStartedAt = Date.now();
    const data = await dependencies.getData();
    dependencies.logger.info(`Card data fetched in ${Date.now() - fetchStartedAt}ms`);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "qq-market-bot-"));
    const renderStartedAt = Date.now();
    const imagePaths = await dependencies.renderCards(data, temporaryDirectory);
    dependencies.logger.info(`Cards rendered in ${Date.now() - renderStartedAt}ms`);
    const sendStartedAt = Date.now();
    await dependencies.sendGroupMessage(event.group_id, await createImageMessage(imagePaths));
    dependencies.logger.info(`${dependencies.successLogMessage} to group ${event.group_id} in ${Date.now() - sendStartedAt}ms`);
  } catch (error) {
    dependencies.logger.error(`Failed to ${dependencies.failureLogMessage}`, error);
    try {
      await dependencies.sendGroupMessage(event.group_id, [{ type: "text", data: { text: dependencies.failureMessage } }]);
    } catch (fallbackError) {
      dependencies.logger.error("Failed to send card error message", fallbackError);
    }
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function createImageMessage(imagePaths: string[]): Promise<Record<string, unknown>[]> {
  if (imagePaths.length === 0) throw new Error("Expected at least one card image");
  const images = await Promise.all(imagePaths.map((imagePath) => readFile(imagePath)));
  return images.map((image) => ({ type: "image", data: { file: `base64://${image.toString("base64")}` } }));
}

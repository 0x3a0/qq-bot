import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroupMessageEvent } from "../onebot/types.js";

export interface MarketReplyDependencies {
  captureScreenshots: (outputDirectory: string) => Promise<string[]>;
  sendGroupMessage: (groupId: number, message: Record<string, unknown>[]) => Promise<unknown>;
  logger: Pick<Console, "error" | "info">;
}

export async function replyWithMarketScreenshots(
  event: GroupMessageEvent,
  dependencies: MarketReplyDependencies,
  marketLabel: string,
  failureMessage: string
): Promise<void> {
  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "qq-market-bot-"));
    const captureStartedAt = Date.now();
    const imagePaths = await dependencies.captureScreenshots(temporaryDirectory);
    if (imagePaths.length === 0) throw new Error("Baidu Finance screenshot script returned no images");
    dependencies.logger.info(`${marketLabel} screenshots captured in ${Date.now() - captureStartedAt}ms`);

    const sendStartedAt = Date.now();
    for (const imagePath of imagePaths) {
      const image = await readFile(imagePath);
      await dependencies.sendGroupMessage(event.group_id, [
        { type: "image", data: { file: `base64://${image.toString("base64")}` } }
      ]);
    }
    dependencies.logger.info(`${marketLabel} screenshots sent to group ${event.group_id} in ${Date.now() - sendStartedAt}ms`);
  } catch (error) {
    dependencies.logger.error(`Failed to capture or send ${marketLabel} screenshots`, error);
    try {
      await dependencies.sendGroupMessage(event.group_id, [{
        type: "text",
        data: { text: failureMessage }
      }]);
    } catch (fallbackError) {
      dependencies.logger.error(`Failed to send ${marketLabel} screenshot error message`, fallbackError);
    }
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

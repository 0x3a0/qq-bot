import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replyWithBoardPerformanceCards } from "../../dist/bot/board-performance-reply.js";

const event = {
  post_type: "message",
  message_type: "group",
  group_id: 10001,
  user_id: 20001,
  message: []
};

const boardPerformanceData = {
  industry: { category: "industry", fetchedAt: new Date(), rankings: { gain: [], loss: [] } },
  concept: { category: "concept", fetchedAt: new Date(), rankings: { gain: [], loss: [] } }
};

test("sends one combined board performance image and removes temporary card files", async () => {
  let outputDirectory;
  let sentMessage;
  await replyWithBoardPerformanceCards(event, {
    boardPerformanceDataProvider: { getBoardPerformanceData: async () => boardPerformanceData },
    renderBoardPerformanceCards: async (_, directory) => {
      outputDirectory = directory;
      const overviewPath = join(directory, "board-performance.png");
      await writeFile(overviewPath, "combined-board-performance-card");
      return [overviewPath];
    },
    sendGroupMessage: async (_, message) => { sentMessage = message; },
    logger: { info() {}, error() {} }
  });

  assert.equal(sentMessage.length, 1);
  assert.equal(sentMessage[0].type, "image");
  assert.equal(sentMessage[0].data.file, `base64://${Buffer.from("combined-board-performance-card").toString("base64")}`);
  await assert.rejects(access(outputDirectory));
});

test("sends a clear text failure message when board performance data fails", async () => {
  let sentMessage;
  await replyWithBoardPerformanceCards(event, {
    boardPerformanceDataProvider: { getBoardPerformanceData: async () => { throw new Error("source unavailable"); } },
    renderBoardPerformanceCards: async () => [],
    sendGroupMessage: async (_, message) => { sentMessage = message; },
    logger: { info() {}, error() {} }
  });

  assert.deepEqual(sentMessage, [{ type: "text", data: { text: "板块涨跌数据获取或图片发送失败，请稍后重试。" } }]);
});

test("sends a clear text failure message when the renderer produces no image", async () => {
  let sentMessage;
  await replyWithBoardPerformanceCards(event, {
    boardPerformanceDataProvider: { getBoardPerformanceData: async () => boardPerformanceData },
    renderBoardPerformanceCards: async () => [],
    sendGroupMessage: async (_, message) => { sentMessage = message; },
    logger: { info() {}, error() {} }
  });

  assert.deepEqual(sentMessage, [{ type: "text", data: { text: "板块涨跌数据获取或图片发送失败，请稍后重试。" } }]);
});

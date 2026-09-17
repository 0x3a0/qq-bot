import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replyWithAShareScreenshots } from "../../dist/bot/a-share-reply.js";

const event = {
  post_type: "message",
  message_type: "group",
  group_id: 10001,
  user_id: 20001,
  message: []
};

test("sends captured screenshots in order and removes temporary files", async () => {
  let outputDirectory;
  const sentMessages = [];
  await replyWithAShareScreenshots(event, {
    captureScreenshots: async (directory) => {
      outputDirectory = directory;
      const firstPath = join(directory, "first.png");
      const secondPath = join(directory, "second.png");
      await writeFile(firstPath, "first-image");
      await writeFile(secondPath, "second-image");
      return [firstPath, secondPath];
    },
    sendGroupMessage: async (_, message) => { sentMessages.push(message); },
    logger: { info() {}, error() {} }
  });

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0][0].type, "image");
  assert.equal(sentMessages[0][0].data.file, `base64://${Buffer.from("first-image").toString("base64")}`);
  assert.equal(sentMessages[1][0].data.file, `base64://${Buffer.from("second-image").toString("base64")}`);
  await assert.rejects(access(outputDirectory));
});

test("sends a clear text failure message when screenshot capture fails", async () => {
  let sentMessage;
  await replyWithAShareScreenshots(event, {
    captureScreenshots: async () => { throw new Error("Baidu Finance unavailable"); },
    sendGroupMessage: async (_, message) => { sentMessage = message; },
    logger: { info() {}, error() {} }
  });

  assert.deepEqual(sentMessage, [{ type: "text", data: { text: "A股行情截图获取或发送失败，请稍后重试。" } }]);
});

test("sends a clear text failure message when screenshot capture returns no images", async () => {
  let sentMessage;
  await replyWithAShareScreenshots(event, {
    captureScreenshots: async () => [],
    sendGroupMessage: async (_, message) => { sentMessage = message; },
    logger: { info() {}, error() {} }
  });

  assert.deepEqual(sentMessage, [{ type: "text", data: { text: "A股行情截图获取或发送失败，请稍后重试。" } }]);
});

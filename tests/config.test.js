import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../dist/config.js";

test("requires an explicitly configured OneBot WebSocket URL", () => {
  assert.throws(() => loadConfig({}), /ONEBOT_WS_URL must be configured/);
});

test("accepts ws and wss OneBot WebSocket URLs", () => {
  assert.equal(loadConfig({ ONEBOT_WS_URL: "ws://napcat.example.test:11451" }).onebotWsUrl, "ws://napcat.example.test:11451");
  assert.equal(loadConfig({ ONEBOT_WS_URL: "wss://napcat.example.test/onebot" }).onebotWsUrl, "wss://napcat.example.test/onebot");
});

test("rejects malformed or non-WebSocket OneBot URLs", () => {
  assert.throws(() => loadConfig({ ONEBOT_WS_URL: "not a url" }), /valid WebSocket URL/);
  assert.throws(() => loadConfig({ ONEBOT_WS_URL: "https://napcat.example.test" }), /must use ws:\/\/ or wss:\/\//);
});

test("loads only OneBot and bot identity settings", () => {
  const config = loadConfig({
    ONEBOT_WS_URL: "ws://napcat.example.test:11451",
    BOT_QQ: "10001"
  });
  assert.equal(config.botQq, "10001");
  assert.deepEqual(Object.keys(config).sort(), [
    "botQq",
    "onebotWsToken",
    "onebotWsUrl",
    "reconnectMaxMs",
    "reconnectMinMs",
    "requestTimeoutMs"
  ]);
});

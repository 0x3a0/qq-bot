import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../dist/config.js";

test("requires an explicitly configured OneBot WebSocket URL", () => {
  assert.throws(() => loadConfig({}), /ONEBOT_WS_URL must be configured/);
});

test("accepts ws and wss OneBot WebSocket URLs", () => {
  assert.equal(loadConfig({ ONEBOT_WS_URL: "ws://napcat.example.test:11451", THS_API_KEY: "secret" }).onebotWsUrl, "ws://napcat.example.test:11451");
  assert.equal(loadConfig({ ONEBOT_WS_URL: "wss://napcat.example.test/onebot", THS_API_KEY: "secret" }).onebotWsUrl, "wss://napcat.example.test/onebot");
});

test("rejects malformed or non-WebSocket OneBot URLs", () => {
  assert.throws(() => loadConfig({ ONEBOT_WS_URL: "not a url" }), /valid WebSocket URL/);
  assert.throws(() => loadConfig({ ONEBOT_WS_URL: "https://napcat.example.test" }), /must use ws:\/\/ or wss:\/\//);
});

test("requires a THS API key", () => {
  assert.throws(() => loadConfig({ ONEBOT_WS_URL: "ws://napcat.example.test:11451" }), /THS_API_KEY must be configured/);
  assert.throws(() => loadConfig({ ONEBOT_WS_URL: "ws://napcat.example.test:11451", THS_API_KEY: "   " }), /THS_API_KEY must be configured/);
});

test("loads the THS API key and snapshot batch size from the environment", () => {
  const config = loadConfig({
    ONEBOT_WS_URL: "ws://napcat.example.test:11451",
    THS_API_KEY: "secret",
    THS_SNAPSHOT_BATCH_SIZE: "50"
  });
  assert.equal(config.thsApiKey, "secret");
  assert.equal(config.thsSnapshotBatchSize, 50);
  const defaults = loadConfig({ ONEBOT_WS_URL: "ws://napcat.example.test:11451", THS_API_KEY: "secret" });
  assert.equal(defaults.thsSnapshotBatchSize, 100);
});

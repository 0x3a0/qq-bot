import assert from "node:assert/strict";
import test from "node:test";
import { commandText, isBoardPerformanceCommand, isMentioned } from "../../dist/bot/trigger.js";

const event = (message, overrides = {}) => ({
  post_type: "message",
  message_type: "group",
  self_id: 10001,
  group_id: 20001,
  user_id: 30001,
  message,
  ...overrides
});

test("does not recognize removed @bot 板块资金 from message segments", () => {
  const message = event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: "  板 块 资 金\n" } }
  ]);
  assert.equal(isMentioned(message), true);
  assert.equal(commandText(message), "板块资金");
  assert.equal(isBoardPerformanceCommand(message), false);
});

test("recognizes @bot 板块涨跌 from message segments", () => {
  const message = event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: " 板 块 涨 跌 " } }
  ]);

  assert.equal(isMentioned(message), true);
  assert.equal(commandText(message), "板块涨跌");
  assert.equal(isBoardPerformanceCommand(message), true);
});

test("ignores a command without a bot mention", () => {
  assert.equal(isBoardPerformanceCommand(event([{ type: "text", data: { text: "板块涨跌" } }])), false);
});

test("ignores unsupported commands", () => {
  assert.equal(isBoardPerformanceCommand(event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: "板块" } }
  ])), false);
  assert.equal(isBoardPerformanceCommand(event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: "板块资金" } }
  ])), false);
});

test("ignores private messages and other commands", () => {
  const message = [{ type: "at", data: { qq: "10001" } }, { type: "text", data: { text: "帮助" } }];
  assert.equal(isBoardPerformanceCommand(event(message)), false);
  assert.equal(isBoardPerformanceCommand(event(message, { message_type: "private" })), false);
});

test("uses BOT_QQ when self_id is not present", () => {
  const message = event([{ type: "at", data: { qq: "10002" } }, { type: "text", data: { text: "板块涨跌" } }], { self_id: undefined });
  assert.equal(isBoardPerformanceCommand(message, "10002"), true);
});

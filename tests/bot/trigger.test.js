import assert from "node:assert/strict";
import test from "node:test";
import { commandText, isAShareCommand, isMentioned, isUSShareCommand } from "../../dist/bot/trigger.js";

const event = (message, overrides = {}) => ({
  post_type: "message",
  message_type: "group",
  self_id: 10001,
  group_id: 20001,
  user_id: 30001,
  message,
  ...overrides
});

test("does not recognize the removed board commands", () => {
  const message = event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: "  板 块 资 金\n" } }
  ]);
  assert.equal(isMentioned(message), true);
  assert.equal(commandText(message), "板块资金");
  assert.equal(isAShareCommand(message), false);
  assert.equal(isAShareCommand(event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: "板块涨跌" } }
  ])), false);
});

test("recognizes @bot a股 from message segments", () => {
  const message = event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: " a 股 " } }
  ]);

  assert.equal(isMentioned(message), true);
  assert.equal(commandText(message), "a股");
  assert.equal(isAShareCommand(message), true);
  assert.equal(isAShareCommand(event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: " A股 " } }
  ])), true);
});

test("recognizes @bot 美股 from message segments", () => {
  const message = event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: " 美 股 " } }
  ]);

  assert.equal(isMentioned(message), true);
  assert.equal(commandText(message), "美股");
  assert.equal(isUSShareCommand(message), true);
  assert.equal(isUSShareCommand(event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: "美股" } }
  ])), true);
  assert.equal(isAShareCommand(message), false);
});

test("ignores a command without a bot mention", () => {
  assert.equal(isAShareCommand(event([{ type: "text", data: { text: "a股" } }])), false);
});

test("ignores unsupported commands", () => {
  assert.equal(isAShareCommand(event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: "板块" } }
  ])), false);
  assert.equal(isUSShareCommand(event([
    { type: "at", data: { qq: "10001" } },
    { type: "text", data: { text: "板块" } }
  ])), false);
});

test("ignores private messages and other commands", () => {
  const message = [{ type: "at", data: { qq: "10001" } }, { type: "text", data: { text: "帮助" } }];
  assert.equal(isAShareCommand(event(message)), false);
  assert.equal(isAShareCommand(event(message, { message_type: "private" })), false);
});

test("uses BOT_QQ when self_id is not present", () => {
  const message = event([{ type: "at", data: { qq: "10002" } }, { type: "text", data: { text: "a股" } }], { self_id: undefined });
  assert.equal(isAShareCommand(message, "10002"), true);
});

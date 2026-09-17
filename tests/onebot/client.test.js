import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import { OneBotClient } from "../../dist/onebot/client.js";

test("sends a group image API request and resolves its response", async (context) => {
  const server = new WebSocketServer({ port: 0 });
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");

  const requestReceived = new Promise((resolve) => {
    server.once("connection", (socket, request) => {
      assert.equal(request.headers.authorization, "Bearer secret");
      socket.once("message", (raw) => {
        const requestPayload = JSON.parse(raw.toString());
        resolve(requestPayload);
        socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 42 }, echo: requestPayload.echo }));
      });
    });
  });

  const client = new OneBotClient({ url: `ws://127.0.0.1:${address.port}`, token: "secret" });
  context.after(() => client.close());
  await client.connect();
  const result = await client.sendGroupMessage(123, [{ type: "image", data: { file: "base64://cG5n" } }]);
  const payload = await requestReceived;

  assert.deepEqual(result, { message_id: 42 });
  assert.equal(payload.action, "send_group_msg");
  assert.equal(payload.params.group_id, 123);
  assert.equal(payload.params.message[0].data.file, "base64://cG5n");
});

test("rejects an API failure response", async (context) => {
  const server = new WebSocketServer({ port: 0 });
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  server.once("connection", (socket) => socket.once("message", (raw) => {
    const requestPayload = JSON.parse(raw.toString());
    socket.send(JSON.stringify({ status: "failed", retcode: 1404, data: null, echo: requestPayload.echo }));
  }));
  const client = new OneBotClient({ url: `ws://127.0.0.1:${address.port}` });
  context.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request("missing_action"), /OneBot API failed \(1404\)/);
});

test("times out when the server does not complete the WebSocket handshake", async (context) => {
  const server = createServer(() => undefined);
  context.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const client = new OneBotClient({ url: `ws://127.0.0.1:${address.port}`, requestTimeoutMs: 30 });
  context.after(() => client.close());
  await assert.rejects(client.connect(), /OneBot connection timed out/);
});

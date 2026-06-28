import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  createFireAndForgetEventHandler,
  createTimeoutSignal,
  createOutboundMessageKey,
  isAdminUser,
  isSafeHttpUrl,
  resolveFeishuLoggerLevel,
  shouldSendProgressMessages,
  withTimeout,
} from "../src/stability.js";

test("event handler returns before slow message processing finishes", async () => {
  let completed = false;
  const handler = createFireAndForgetEventHandler(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    completed = true;
  });

  await handler({ message: { message_id: "m1" } });

  assert.equal(completed, false);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(completed, true);
});

test("outbound message keys are stable and scoped by chat and text", () => {
  assert.equal(
    createOutboundMessageKey("chat-a", "收到，我想一下。"),
    createOutboundMessageKey("chat-a", "收到，我想一下。")
  );
  assert.notEqual(
    createOutboundMessageKey("chat-a", "收到，我想一下。"),
    createOutboundMessageKey("chat-b", "收到，我想一下。")
  );
});

test("admin check allows open id or user id only when configured", () => {
  assert.equal(
    isAdminUser({ openId: "ou_1", userId: "u_1" }, "ou_1,u_2"),
    true
  );
  assert.equal(
    isAdminUser({ openId: "ou_1", userId: "u_1" }, "ou_2,u_1"),
    true
  );
  assert.equal(
    isAdminUser({ openId: "ou_1", userId: "u_1" }, "ou_2,u_2"),
    false
  );
  assert.equal(
    isAdminUser({ openId: "ou_1", userId: "u_1" }, ""),
    true
  );
});

test("safe URL validation blocks local and private network targets", async () => {
  assert.equal(await isSafeHttpUrl("https://example.com/page"), true);
  assert.equal(await isSafeHttpUrl("ftp://example.com/file"), false);
  assert.equal(await isSafeHttpUrl("http://localhost:3000"), false);
  assert.equal(await isSafeHttpUrl("http://127.0.0.1:3000"), false);
  assert.equal(await isSafeHttpUrl("http://10.0.0.1/status"), false);
  assert.equal(await isSafeHttpUrl("http://169.254.169.254/latest/meta-data"), false);
});

test("withTimeout rejects slow operations", async () => {
  await assert.rejects(
    () => withTimeout(
      new Promise(resolve => setTimeout(() => resolve("late"), 50)),
      10,
      "Slow operation"
    ),
    /Slow operation timed out/
  );
});

test("createTimeoutSignal aborts after timeout", async () => {
  const signal = createTimeoutSignal(5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal.aborted, true);
});

test("progress messages are disabled by default and explicit when enabled", () => {
  assert.equal(shouldSendProgressMessages(undefined), false);
  assert.equal(shouldSendProgressMessages(""), false);
  assert.equal(shouldSendProgressMessages("false"), false);
  assert.equal(shouldSendProgressMessages("true"), true);
  assert.equal(shouldSendProgressMessages("1"), true);
  assert.equal(shouldSendProgressMessages("yes"), true);
});

test("normal chat does not contain the old web-search progress prompt", async () => {
  const source = await fs.readFile(new URL("../index.js", import.meta.url), "utf8");

  assert.equal(source.includes("这个问题可能需要最新信息，我先查一下。"), false);
});

test("logger level never falls back to debug unless explicitly requested", () => {
  assert.equal(resolveFeishuLoggerLevel({ debug: "debug" }, ""), undefined);
  assert.equal(resolveFeishuLoggerLevel({ debug: "debug", info: "info" }, ""), "info");
  assert.equal(resolveFeishuLoggerLevel({ debug: "debug", info: "info" }, "debug"), "debug");
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLearningChangeGate,
  buildAutoSearchQuery,
  extractTextFromFeishuMessage,
  extractHttpUrls,
  normalizeFeishuMessagesForLearning,
  parseLearningHours,
  shouldAutoSearchLearn,
  shouldCommitLearningChange,
} from "../src/learning.js";

test("extracts plain text from Feishu message body content", () => {
  const message = {
    message_id: "om_1",
    msg_type: "text",
    create_time: "1780000000000",
    sender: { id: "ou_user" },
    body: {
      content: JSON.stringify({ text: "  这是一条群聊内容  " }),
    },
  };

  assert.deepEqual(extractTextFromFeishuMessage(message), {
    messageId: "om_1",
    senderId: "ou_user",
    createTime: "1780000000000",
    text: "这是一条群聊内容",
  });
});

test("normalizes messages and filters non-text, bot echoes, duplicates, and empty text", () => {
  const messages = [
    {
      message_id: "om_1",
      msg_type: "text",
      sender: { id: "ou_user" },
      body: { content: JSON.stringify({ text: "有效内容" }) },
    },
    {
      message_id: "om_1",
      msg_type: "text",
      sender: { id: "ou_user" },
      body: { content: JSON.stringify({ text: "重复内容" }) },
    },
    {
      message_id: "om_2",
      msg_type: "image",
      sender: { id: "ou_user" },
      body: { content: "{}" },
    },
    {
      message_id: "om_3",
      msg_type: "text",
      sender: { id: "ou_bot" },
      body: { content: JSON.stringify({ text: "机器人消息" }) },
    },
    {
      message_id: "om_4",
      msg_type: "text",
      sender: { id: "ou_user" },
      body: { content: JSON.stringify({ text: "   " }) },
    },
  ];

  assert.deepEqual(
    normalizeFeishuMessagesForLearning(messages, { botOpenId: "ou_bot" }),
    [
      {
        messageId: "om_1",
        senderId: "ou_user",
        createTime: "",
        text: "有效内容",
      },
    ]
  );
});

test("parseLearningHours defaults and clamps to safe range", () => {
  assert.equal(parseLearningHours(""), 24);
  assert.equal(parseLearningHours("2小时"), 2);
  assert.equal(parseLearningHours("999"), 168);
  assert.equal(parseLearningHours("-1"), 1);
});

test("extractHttpUrls returns unique public URL-looking links without trailing punctuation", () => {
  assert.deepEqual(
    extractHttpUrls("看这两篇：https://example.com/a，https://example.com/a 以及 http://docs.example.org/book?x=1。"),
    [
      "https://example.com/a",
      "http://docs.example.org/book?x=1",
    ]
  );
});

test("auto search learning triggers only for explicit learning topics", () => {
  assert.equal(shouldAutoSearchLearn("帮我研究一下长期主义的学习方法"), true);
  assert.equal(shouldAutoSearchLearn("有没有关于注意力训练的文章或书籍资料"), true);
  assert.equal(shouldAutoSearchLearn("你好，今天吃什么"), false);
  assert.equal(shouldAutoSearchLearn("/学习网页 https://example.com/a"), false);
});

test("auto search query removes command noise and keeps useful topic", () => {
  assert.equal(
    buildAutoSearchQuery("帮我研究一下长期主义的学习方法"),
    "长期主义的学习方法"
  );
});

test("learning change gate rejects protected core changes", () => {
  const gate = buildLearningChangeGate({
    target: "prompt",
    touchesProtectedCore: true,
    sourced: true,
    compounds: true,
    focused: true,
    calm: true,
    redlineSafe: true,
    reversible: true,
  });

  assert.equal(gate.outcome, "REJECT");
  assert.equal(shouldCommitLearningChange(gate), false);
});

test("learning change gate commits only fully safe reversible changes", () => {
  const gate = buildLearningChangeGate({
    target: "skill",
    touchesProtectedCore: false,
    sourced: true,
    compounds: true,
    focused: true,
    calm: true,
    redlineSafe: true,
    reversible: true,
  });

  assert.equal(gate.outcome, "COMMIT");
  assert.equal(shouldCommitLearningChange(gate), true);
});

import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimeCapabilitySummary } from "../src/capabilities.js";

test("runtime capability summary tells the model it has learning and search features", () => {
  const summary = buildRuntimeCapabilitySummary({
    tavilyApiKey: "tvly-test",
    enableAutoGroupLearning: "false",
    enableAutoWebLearning: "true",
    enableAutoSearchLearning: "true",
    autoSearchLearningDailyLimit: "5",
  });

  assert.match(summary, /自动搜索学习/);
  assert.match(summary, /自动网页学习/);
  assert.match(summary, /\/搜索学习 主题/);
  assert.match(summary, /\/学习群聊 24小时/);
  assert.match(summary, /\/开启Agent/);
  assert.match(summary, /自主 Agent 模式/);
  assert.match(summary, /不要回答自己没有这些功能/);
});

test("runtime capability summary distinguishes unavailable search credentials from missing capability", () => {
  const summary = buildRuntimeCapabilitySummary({
    tavilyApiKey: "",
    enableAutoWebLearning: "true",
    enableAutoSearchLearning: "true",
  });

  assert.match(summary, /TAVILY_API_KEY 未配置/);
  assert.match(summary, /不是代码没有搜索功能/);
});

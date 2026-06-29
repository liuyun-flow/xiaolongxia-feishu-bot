import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentActionNotice,
  buildAgentStatusText,
  classifyAgentLearningResult,
  chooseAgentAction,
  formatAgentLogs,
  normalizeAgentGoals,
  parseAgentGoals,
  shouldEnableAgent,
} from "../src/agent.js";

test("agent mode only enables for explicit truthy values", () => {
  assert.equal(shouldEnableAgent("true"), true);
  assert.equal(shouldEnableAgent("1"), true);
  assert.equal(shouldEnableAgent("yes"), true);
  assert.equal(shouldEnableAgent("on"), true);
  assert.equal(shouldEnableAgent("false"), false);
  assert.equal(shouldEnableAgent(""), false);
  assert.equal(shouldEnableAgent(undefined), false);
});

test("parses agent goals into stable prioritized goal objects", () => {
  assert.deepEqual(parseAgentGoals("学习 AI Agent\n沉淀心理学 Skill"), [
    { id: "goal_1", text: "学习 AI Agent", priority: 1 },
    { id: "goal_2", text: "沉淀心理学 Skill", priority: 2 },
  ]);

  assert.deepEqual(parseAgentGoals("学习 AI Agent;学习 AI Agent； 每天总结"), [
    { id: "goal_1", text: "学习 AI Agent", priority: 1 },
    { id: "goal_2", text: "每天总结", priority: 2 },
  ]);
});

test("normalizes empty agent goals with fallback goals", () => {
  assert.deepEqual(
    normalizeAgentGoals([], ["持续学习用户关注的主题", "自动沉淀 Skill"]),
    [
      { id: "goal_1", text: "持续学习用户关注的主题", priority: 1 },
      { id: "goal_2", text: "自动沉淀 Skill", priority: 2 },
    ]
  );
});

test("chooses skip actions for disabled agent, missing owner, or exhausted quota", () => {
  assert.deepEqual(chooseAgentAction({ enabled: false }), {
    type: "skip",
    reason: "agent_disabled",
  });

  assert.deepEqual(chooseAgentAction({ enabled: true, ownerChatId: "" }), {
    type: "skip",
    reason: "missing_owner_chat",
  });

  assert.deepEqual(chooseAgentAction({
    enabled: true,
    ownerChatId: "oc_1",
    dailyRuns: 3,
    dailyLimit: 3,
  }), {
    type: "skip",
    reason: "daily_quota_exhausted",
  });
});

test("daily report wins before search learning when report is due", () => {
  assert.deepEqual(chooseAgentAction({
    enabled: true,
    ownerChatId: "oc_1",
    dailyRuns: 0,
    dailyLimit: 3,
    reportDue: true,
    goals: [{ id: "goal_1", text: "学习 AI Agent", priority: 1 }],
  }), {
    type: "daily_report",
    reason: "daily_report_due",
  });
});

test("search learning is selected from the highest priority available goal", () => {
  assert.deepEqual(chooseAgentAction({
    enabled: true,
    ownerChatId: "oc_1",
    dailyRuns: 0,
    dailyLimit: 3,
    reportDue: false,
    recentlySearchedGoalIds: new Set(["goal_1"]),
    goals: [
      { id: "goal_1", text: "学习 AI Agent", priority: 1 },
      { id: "goal_2", text: "沉淀心理学 Skill", priority: 2 },
    ],
  }), {
    type: "search_learning",
    reason: "goal_ready",
    goal: { id: "goal_2", text: "沉淀心理学 Skill", priority: 2 },
  });
});

test("agent status text exposes enabled state, goals, quota, and last run", () => {
  const text = buildAgentStatusText({
    enabled: true,
    goals: [{ id: "goal_1", text: "学习 AI Agent", priority: 1 }],
    dailyRuns: 1,
    dailyLimit: 3,
    lastRun: "2026-06-28T10:00:00.000Z",
    searchConfigured: true,
    notifyOnAction: true,
  });

  assert.match(text, /Agent 状态：已开启/);
  assert.match(text, /今日自主运行：1\/3/);
  assert.match(text, /搜索密钥：已配置/);
  assert.match(text, /自主动作通知：已开启/);
  assert.match(text, /学习 AI Agent/);
  assert.match(text, /2026-06-28T10:00:00.000Z/);
});

test("agent log formatter summarizes recent logs", () => {
  const text = formatAgentLogs([
    {
      action: "search_learning",
      status: "success",
      reason: "goal_ready",
      goal: "学习 AI Agent",
      summary: "搜索学习完成。",
      createdAt: "2026-06-28T10:00:00.000Z",
    },
  ]);

  assert.match(text, /最近 Agent 工作日志/);
  assert.match(text, /search_learning/);
  assert.match(text, /学习 AI Agent/);
  assert.match(text, /搜索学习完成/);
});

test("agent learning results classify failure, skip, and success distinctly", () => {
  assert.equal(classifyAgentLearningResult("搜索学习失败：未配置 TAVILY_API_KEY。"), "failed");
  assert.equal(classifyAgentLearningResult("这个主题近期已搜索学习过，跳过重复学习。"), "skipped");
  assert.equal(classifyAgentLearningResult("搜索学习完成。\n新增学习笔记：1 条"), "success");
});

test("agent action notice makes autonomous learning visible to the owner", () => {
  const notice = buildAgentActionNotice({
    action: "search_learning",
    status: "success",
    goal: "学习 AI Agent",
    summary: "搜索学习完成。\n新增学习笔记：1 条",
  });

  assert.match(notice, /Agent 自主学习完成/);
  assert.match(notice, /学习 AI Agent/);
  assert.match(notice, /新增学习笔记：1 条/);
});

export function shouldEnableAgent(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function parseAgentGoals(text, fallbackGoals = []) {
  const rawGoals = String(text || "")
    .split(/[\n;；]+/)
    .map(item => item.trim())
    .filter(Boolean);

  return normalizeAgentGoals(rawGoals, fallbackGoals);
}

export function normalizeAgentGoals(goals, fallbackGoals = []) {
  const source = Array.isArray(goals) && goals.length ? goals : fallbackGoals;
  const seen = new Set();
  const result = [];

  for (const item of Array.isArray(source) ? source : []) {
    const text = typeof item === "string" ? item : item?.text;
    const cleanText = String(text || "").replace(/\s+/g, " ").trim();
    if (!cleanText || seen.has(cleanText)) continue;

    seen.add(cleanText);
    result.push({
      id: `goal_${result.length + 1}`,
      text: cleanText.slice(0, 160),
      priority: result.length + 1,
    });
  }

  return result.slice(0, 10);
}

export function chooseAgentAction(state = {}) {
  if (!state.enabled) {
    return { type: "skip", reason: "agent_disabled" };
  }

  if (!state.ownerChatId) {
    return { type: "skip", reason: "missing_owner_chat" };
  }

  const dailyRuns = Number(state.dailyRuns || 0);
  const dailyLimit = Math.max(0, Number(state.dailyLimit || 0));
  if (dailyLimit <= 0 || dailyRuns >= dailyLimit) {
    return { type: "skip", reason: "daily_quota_exhausted" };
  }

  if (state.reportDue) {
    return { type: "daily_report", reason: "daily_report_due" };
  }

  const recentlySearched = state.recentlySearchedGoalIds || new Set();
  const goals = [...(state.goals || [])].sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
  const goal = goals.find(item => !recentlySearched.has(item.id));
  if (goal) {
    return { type: "search_learning", reason: "goal_ready", goal };
  }

  return { type: "skip", reason: "no_goal_ready" };
}

export function buildAgentStatusText(state = {}) {
  const enabled = state.enabled ? "已开启" : "已关闭";
  const dailyRuns = Number(state.dailyRuns || 0);
  const dailyLimit = Number(state.dailyLimit || 0);
  const goals = normalizeAgentGoals(state.goals || [], []);
  const goalRows = goals.length
    ? goals.map(goal => `${goal.priority}. ${goal.text}`)
    : ["暂无目标"];

  return [
    `Agent 状态：${enabled}`,
    `今日自主运行：${dailyRuns}/${dailyLimit}`,
    `上次运行：${state.lastRun || "暂无"}`,
    "",
    "当前目标：",
    ...goalRows,
  ].join("\n");
}

export function formatAgentLogs(logs = []) {
  const rows = (Array.isArray(logs) ? logs : []).slice(0, 10).map((log, index) => {
    const goal = log.goal ? `｜目标：${log.goal}` : "";
    return `${index + 1}. ${log.createdAt || ""}｜${log.action || "unknown"}｜${log.status || "unknown"}｜${log.reason || ""}${goal}\n${log.summary || ""}`;
  });

  if (!rows.length) {
    return "最近 Agent 工作日志：\n\n暂无日志。";
  }

  return ["最近 Agent 工作日志：", "", ...rows].join("\n\n").slice(0, 6000);
}

# Agent Kernel V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded autonomous Agent mode that can keep goals, wake up periodically, select safe learning work, log actions, and send a daily owner report.

**Architecture:** Add a focused `src/agent.js` pure-logic module for goal parsing, enable flags, quotas, action selection, and log formatting. Keep side effects in `index.js`, reusing existing search learning, group learning, memory, and Feishu send functions. Add tests around pure logic first, then wire commands and scheduled execution.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing JSON/PostgreSQL memory abstraction, existing Feishu SDK send path.

---

### Task 1: Agent Core Logic

**Files:**
- Create: `src/agent.js`
- Test: `test/agent.test.js`

- [ ] **Step 1: Write failing tests**

Cover these behaviors:

```js
import {
  buildAgentStatusText,
  chooseAgentAction,
  normalizeAgentGoals,
  parseAgentGoals,
  shouldEnableAgent,
} from "../src/agent.js";
```

Tests must assert:

- agent mode only enables for `true`, `1`, `yes`, or `on`;
- goal text becomes stable goal objects;
- empty goal text falls back to default goals;
- daily report is selected when due;
- search learning is selected when report is not due and goals exist;
- quota exhaustion returns a skip action;
- status text includes enabled state, goals, daily quota, and last run.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
node --test test/agent.test.js
```

Expected: fail because `src/agent.js` does not exist.

- [ ] **Step 3: Implement minimal agent pure logic**

Create exported helpers:

- `shouldEnableAgent(value)`
- `parseAgentGoals(text, fallbackGoals)`
- `normalizeAgentGoals(goals, fallbackGoals)`
- `chooseAgentAction(state)`
- `buildAgentStatusText(state)`
- `formatAgentLogs(logs)`

- [ ] **Step 4: Run tests and confirm pass**

Run:

```bash
node --test test/agent.test.js
```

Expected: all agent tests pass.

### Task 2: Wire Agent Settings And Scheduler

**Files:**
- Modify: `index.js`
- Test: `test/stability.test.js` or `test/agent.test.js`

- [ ] **Step 1: Add env defaults**

Add:

```js
ENABLE_AGENT_MODE = "false"
AGENT_INTERVAL_MS = String(60 * 60 * 1000)
AGENT_DAILY_RUN_LIMIT = "3"
AGENT_REPORT_HOUR = "21"
AGENT_DEFAULT_GOALS = "持续学习用户关注的主题;自动沉淀可复用 Skill;每天总结自主学习成果"
```

- [ ] **Step 2: Add scheduler**

After group learning scheduler, add an Agent scheduler that calls `runAgentCycle({ manual: false })` when `AGENT_INTERVAL_MS > 0`.

- [ ] **Step 3: Implement `isAgentEnabled` and daily quota helpers**

Use memory `agent:enabled` first, then env fallback.

### Task 3: Add Agent Commands

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add admin commands**

Add command handling:

- `/开启Agent`
- `/关闭Agent`
- `/Agent状态`
- `/Agent目标 ...`
- `/Agent日志`
- `/Agent运行`

- [ ] **Step 2: Update help text**

Add the new commands to `helpText()`.

### Task 4: Implement Agent Cycle Side Effects

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Implement `runAgentCycle(options)`**

The cycle should:

1. read owner chat from `admin:chat_id`;
2. read enabled state and goals;
3. check daily quota;
4. call `chooseAgentAction`;
5. execute `daily_report` or `search_learning`;
6. save a work log;
7. send a concise owner report only for manual runs and daily reports.

- [ ] **Step 2: Reuse existing learning functions**

Use `learnFromSearchQuery(goal.text, "agent", { manual: false, force: false })` for search learning.

- [ ] **Step 3: Add `buildAgentDailyReport`**

Summarize recent agent logs and recent learning notes with DeepSeek. If DeepSeek fails, send a deterministic fallback report.

### Task 5: Docs, Verification, And Push

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document Agent mode**

Add env variables, commands, safety limits, and activation steps.

- [ ] **Step 2: Run verification**

Run:

```bash
node --check index.js
node --test
```

Expected: all tests pass.

- [ ] **Step 3: Commit and push**

Commit:

```bash
git add index.js src/agent.js test/agent.test.js README.md docs/superpowers
git commit -m "Add autonomous agent kernel"
git push origin main
```

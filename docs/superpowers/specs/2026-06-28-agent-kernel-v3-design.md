# Agent Kernel V3 Design

## Goal

Turn Xiaolongxia from a reactive Feishu bot into a small, bounded agent that can periodically wake up, choose useful learning work, execute safe actions, record what it did, and report back to the owner.

## Current State

The bot already supports normal chat, web search, webpage learning, group chat learning, learning notes, skill creation, dynamic prompt evolution, and scheduled review. These capabilities are mostly reactive. The bot can respond to user messages or periodic jobs, but it does not yet maintain its own active goals, choose the next action, or leave an agent work log.

## V3 Scope

V3.1 and V3.2 will add the smallest useful autonomous loop:

1. Agent mode can be enabled or disabled by an admin command.
2. The bot keeps a simple goal list in memory.
3. A periodic agent loop wakes up on a configurable interval.
4. Each run chooses one safe action from the goal list and current state.
5. The first action set is intentionally narrow: search learning, group chat learning, and daily report.
6. Each run records a structured work log.
7. The owner can ask for agent status, goals, logs, and can trigger one agent run manually.

## Non-Goals

V3 will not let the bot modify protected global MD rules. It will not send unlimited proactive messages. It will not click private websites, operate desktop apps, or make purchases. It will not claim a task is complete unless the executed action produced a concrete result.

## Commands

- `/开启Agent`: enable autonomous agent mode.
- `/关闭Agent`: disable autonomous agent mode.
- `/Agent状态`: show whether agent mode is enabled, current goals, daily quota, and last run.
- `/Agent目标 目标文本`: replace the current goal list with one or more goal lines.
- `/Agent日志`: show recent agent work logs.
- `/Agent运行`: manually trigger one agent cycle.

## Runtime Settings

- `ENABLE_AGENT_MODE=false`: default agent mode if memory has no explicit value.
- `AGENT_INTERVAL_MS=3600000`: periodic wakeup interval.
- `AGENT_DAILY_RUN_LIMIT=3`: max autonomous runs per day.
- `AGENT_REPORT_HOUR=21`: local hour for one daily owner report.
- `AGENT_DEFAULT_GOALS`: optional newline or semicolon separated default goals.

## Agent Decision Model

The first version uses deterministic rules, not open-ended tool selection:

1. If no owner chat is bound, skip and log the reason.
2. If daily quota is exhausted, skip and log the reason.
3. If a daily report is due, generate and send the report.
4. Otherwise, pick the highest-priority goal that has not been searched recently and run search learning.
5. If group learning is enabled and registered group chats exist, use existing group learning on schedule.

This keeps the agent reliable while still making it autonomous.

## Data Model

Memory keys:

- `agent:enabled`: `"true"` or `"false"`.
- `agent:goals`: JSON array of goal objects.
- `agent:last_run`: ISO timestamp.
- `agent:daily_runs:YYYY-MM-DD`: count.
- `agent:daily_report:YYYY-MM-DD`: marker.
- `agent:logs:index`: recent log IDs.
- `agent:log:<id>`: full work log.

## Work Log Shape

Each log records:

- action: `search_learning`, `group_learning`, `daily_report`, or `skip`.
- reason: why this action was selected.
- goal: related goal text.
- status: `success`, `skipped`, or `failed`.
- summary: short result.
- createdAt: ISO timestamp.

## Safety

Agent mode is admin controlled. Autonomous work has a daily quota. Proactive owner reports are limited to one per day. Search learning still requires `TAVILY_API_KEY`. Prompt and skill evolution continue to use the existing learning change gate.

## Success Criteria

After V3 deploys, the owner can enable Agent mode, set goals, and see Xiaolongxia periodically perform bounded learning work without direct commands. The bot can explain what it did through `/Agent日志` and can produce one daily summary report.

# 小龙虾 AI - Railway + 飞书官方 SDK长连接 + PostgreSQL 记忆版

这个版本把原来的 `memory.json` 换成了 Railway PostgreSQL。

## Railway 添加 PostgreSQL

在 Railway 项目中：

1. 点击 `New`
2. 选择 `Database`
3. 选择 `Add PostgreSQL`
4. 回到你的 Bot 服务
5. 打开 `Variables`
6. 添加或引用 `DATABASE_URL`

Railway 的 PostgreSQL 文档说明，很多库会自动寻找 `DATABASE_URL` 变量来连接 PostgreSQL。

## 环境变量

在 Railway → Bot 服务 → Variables 添加：

```env
FEISHU_APP_ID=你的飞书 App ID
FEISHU_APP_SECRET=你的飞书 App Secret
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-pro
DATABASE_URL=${{Postgres.DATABASE_URL}}
TAVILY_API_KEY=你的 Tavily API Key，可选
SCHEDULE_INTERVAL_MS=86400000
ADMIN_USER_IDS=你的飞书 open_id 或 user_id，多个用英文逗号分隔，可选
REQUEST_TIMEOUT_MS=30000
FEISHU_LOG_LEVEL=info
SEND_PROGRESS_MESSAGES=false
GLOBAL_SKILL_FILES=./global-skills/树林准则_AI版.md;./global-skills/小龙虾成长准则.md
ENABLE_AUTO_GROUP_LEARNING=false
ENABLE_AUTO_WEB_LEARNING=true
ENABLE_AUTO_SEARCH_LEARNING=true
AUTO_WEB_LEARNING_MAX_URLS=2
AUTO_SEARCH_LEARNING_DAILY_LIMIT=5
GROUP_LEARNING_INTERVAL_MS=3600000
GROUP_LEARNING_LOOKBACK_HOURS=24
ENABLE_AGENT_MODE=false
AGENT_INTERVAL_MS=3600000
AGENT_DAILY_RUN_LIMIT=3
AGENT_REPORT_HOUR=21
AGENT_DEFAULT_GOALS=持续学习用户关注的主题;自动沉淀可复用 Skill;每天总结自主学习成果
BOT_OPEN_ID=机器人 open_id，可选
```

如果你没有配置 `DATABASE_URL`，程序会自动退回到 `memory.json` 文件存储。

建议生产环境配置 `ADMIN_USER_IDS`。如果不配置，`/绑定主人` 会保持兼容旧版本，任何人都可以绑定当前会话。

## 启动

```bash
npm start
```

## 稳定版 V1

这个版本优先解决稳定性和安全边界：

1. 飞书长连接事件收到后立即交给后台处理，避免等待 DeepSeek 太久导致飞书重推。
2. 机器人发送消息前会记录文本指纹，如果飞书把机器人自己的消息回流回来，会自动忽略。
3. `/绑定主人` 支持 `ADMIN_USER_IDS` 白名单。
4. DeepSeek、Tavily、网页读取、飞书发送都有超时保护。
5. `/爬取` 会拒绝 localhost、内网 IP、云元数据地址等不安全 URL。
6. 默认降低飞书 SDK 日志级别；需要排错时设置 `FEISHU_LOG_LEVEL=debug`。
7. 默认不发送“我先查一下/我想一下”等中间提示；需要时设置 `SEND_PROGRESS_MESSAGES=true`。

## 自学习 V2

这个版本新增了小龙虾自学习能力：

1. `global-skills/树林准则_AI版.md` 和 `global-skills/小龙虾成长准则.md` 会作为全局只读准则加载进系统提示词。
2. 小龙虾可以从群聊中提炼学习笔记、长期自我记忆、候选 Skill。
3. 小龙虾可以在通过进化闸门后改写自己的动态提示词。
4. 每次动态提示词改动都会写入进化日志，便于回看和回滚。
5. 受保护内核不能由小龙虾自己修改，只能由你修改准则文件。

新增命令：

```text
/学习群聊 24小时
/学习网页 URL
/搜索学习 主题
/学习笔记
/进化日志
/开启自动学习
/关闭自动学习
/开启Agent
/关闭Agent
/Agent状态
/Agent目标 目标1；目标2
/Agent日志
/Agent运行
```

自动学习默认关闭。你可以在飞书里发送 `/开启自动学习`，或在 Railway 设置：

```env
ENABLE_AUTO_GROUP_LEARNING=true
```

网页自动学习默认开启。正常聊天里出现公开 `http://` 或 `https://` 链接时，小龙虾会在后台读取网页、提炼学习笔记，并自动沉淀高置信度 Skill。每个链接默认 30 天内只学习一次，避免重复爬取。

如果你想关闭网页自动学习：

```env
ENABLE_AUTO_WEB_LEARNING=false
```

搜索自动学习默认开启，但需要配置 `TAVILY_API_KEY`。当群聊里出现明确的学习/研究/找资料意图时，小龙虾会在后台生成搜索词、联网搜索、提炼学习笔记，并自动沉淀高置信度 Skill。它不会对普通闲聊触发搜索，默认每天最多自动搜索学习 5 次。

如果你想关闭自动搜索学习：

```env
ENABLE_AUTO_SEARCH_LEARNING=false
```

如果想调整每天自动搜索次数：

```env
AUTO_SEARCH_LEARNING_DAILY_LIMIT=5
```

## Agent Kernel V3

V3 新增了一个受限的自主 Agent 模式。它不是无限制乱跑，而是按目标池定时醒来，选择一个安全动作，记录工作日志，并在每天合适的时候给主人发一份简短报告。

启用方式：

```text
/绑定主人
/开启Agent
```

常用命令：

```text
/Agent状态
/Agent目标 持续学习 AI Agent；沉淀心理学 Skill；每天总结学习成果
/Agent日志
/Agent运行
/关闭Agent
```

Agent 当前能自主做的事：

1. 根据目标池做搜索学习。
2. 复用现有网页/搜索学习链路，沉淀学习笔记和候选 Skill。
3. 记录每次自主行动的原因、目标、状态和结果。
4. 每天最多主动运行 `AGENT_DAILY_RUN_LIMIT` 次。
5. 每天最多主动发一次 Agent 日报。

安全边界：

1. 默认 `ENABLE_AGENT_MODE=false`，需要 `/开启Agent` 或环境变量开启。
2. 修改核心 MD 准则仍然禁止。
3. 搜索学习仍然依赖 `TAVILY_API_KEY`。
4. 主动运行有每日额度，避免无限循环和刷屏。

本地检查：

```bash
npm run check
npm test
```

如果本机没有 npm，也可以直接使用 Node：

```bash
node --check index.js
node --test
```

## 飞书后台

1. 企业自建应用
2. 应用能力开启：机器人
3. 事件订阅：使用长连接接收事件
4. 订阅：`im.message.receive_v1`
5. 权限管理：开启消息接收/发送相关权限
6. 如果要读取群聊历史消息，还需要开启“获取群组中所有消息”或“读取消息历史”相关权限，并重新发布应用版本
7. 发布版本
8. Railway 日志看到 `wsClient.start 已执行` 后，点击“验证连接状态”

## 验证记忆

飞书里发送：

```text
/绑定主人
```

然后发送：

```text
/沉淀skill 以后做动漫角色海报时，先分析角色性格，再决定动作、构图、光影和材质。
```

再发送：

```text
/技能
```

能看到刚才的 Skill，就说明 PostgreSQL 记忆已经生效。

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
```

如果你没有配置 `DATABASE_URL`，程序会自动退回到 `memory.json` 文件存储。

## 启动

```bash
npm start
```

## 飞书后台

1. 企业自建应用
2. 应用能力开启：机器人
3. 事件订阅：使用长连接接收事件
4. 订阅：`im.message.receive_v1`
5. 权限管理：开启消息接收/发送相关权限
6. 发布版本
7. Railway 日志看到 `wsClient.start 已执行` 后，点击“验证连接状态”

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

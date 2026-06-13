# 小龙虾 AI - Railway + 飞书官方 SDK 长连接版

这个项目把原来的 Cloudflare Worker Webhook 框架换成了：

- Railway Node.js 常驻进程
- 飞书官方 SDK `WSClient` 长连接
- DeepSeek API
- JSON 文件记忆层，模拟原来的 Cloudflare KV

## 环境变量

在 Railway → Variables 添加：

```env
FEISHU_APP_ID=你的飞书 App ID
FEISHU_APP_SECRET=你的飞书 App Secret
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-pro
TAVILY_API_KEY=你的 Tavily API Key，可选
MEMORY_FILE=./memory.json
SCHEDULE_INTERVAL_MS=86400000
```

## 启动

Railway Start Command：

```bash
npm start
```

## 飞书后台

进入飞书开放平台：

1. 企业自建应用
2. 应用能力开启：机器人
3. 事件订阅：选择“使用长连接接收事件”
4. 订阅事件：`im.message.receive_v1`
5. 权限管理：开启消息接收/发送相关权限
6. 发布版本
7. Railway 日志看到 `wsClient.start 已执行` 后，再点击“验证连接状态”

## 可用命令

- `/帮助`
- `/搜索 关键词`
- `/爬取 URL`
- `/复盘`
- `/沉淀skill 经验内容`
- `/技能`
- `/忘记`
- `/绑定主人`

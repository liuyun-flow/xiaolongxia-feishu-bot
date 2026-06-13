import "dotenv/config";
import pg from "pg";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";

/**
 * Xiaolongxia AI - Railway Node.js + Feishu Official SDK Long Connection
 *
 * 迁移说明：
 * - 原 Cloudflare Worker 的 fetch/event/scheduled 框架已替换为 Node.js 常驻进程。
 * - 飞书入口改为官方 SDK WSClient 长连接。
 * - 原 env.MEMORY KV 改为本地 JSON 文件存储，保留 get/put/delete + expirationTtl 接口。
 * - 原命令、DeepSeek、Tavily、Skill、复盘逻辑尽量保持不变。
 */

const {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL = "deepseek-v4-pro",
  TAVILY_API_KEY,
  DATABASE_URL,
  PORT = "3000",
  MEMORY_FILE = "./memory.json",
  SCHEDULE_INTERVAL_MS = String(24 * 60 * 60 * 1000),
} = process.env;

console.log("========== 小龙虾 AI 启动 ==========");
console.log("FEISHU_APP_ID 存在：", Boolean(FEISHU_APP_ID));
console.log("FEISHU_APP_SECRET 存在：", Boolean(FEISHU_APP_SECRET));
console.log("DEEPSEEK_API_KEY 存在：", Boolean(DEEPSEEK_API_KEY));
console.log("TAVILY_API_KEY 存在：", Boolean(TAVILY_API_KEY));
console.log("DATABASE_URL 存在：", Boolean(DATABASE_URL));
console.log("DEEPSEEK_MODEL：", DEEPSEEK_MODEL);
console.log("MEMORY_FILE：", MEMORY_FILE);

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error("启动失败：缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET");
  process.exit(1);
}

if (!DEEPSEEK_API_KEY) {
  console.warn("警告：未配置 DEEPSEEK_API_KEY。飞书长连接可启动，但正常聊天会失败。");
}

// Railway 健康检查服务：让 Railway 知道服务还活着
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Xiaolongxia Feishu Long Connection Bot is running.");
  })
  .listen(Number(PORT), () => {
    console.log(`Health server listening on port ${PORT}`);
  });

// 用 JSON 文件模拟 Cloudflare KV，保留 put/get/delete 和 expirationTtl 语义
class JsonMemoryStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.data = {};
    this.loaded = false;
    this.writeTimer = null;
  }

  async load() {
    if (this.loaded) return;

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw || "{}");
    } catch {
      this.data = {};
    }

    this.loaded = true;
    this.cleanupExpired();
  }

  cleanupExpired() {
    const now = Date.now();

    for (const [key, item] of Object.entries(this.data)) {
      if (item && item.expiresAt && item.expiresAt <= now) {
        delete this.data[key];
      }
    }
  }

  async persistSoon() {
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(async () => {
      try {
        await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
      } catch (error) {
        console.error("Memory persist failed:", error);
      }
    }, 200);
  }

  async get(key) {
    await this.load();
    this.cleanupExpired();

    const item = this.data[key];
    if (!item) return null;

    if (item.expiresAt && item.expiresAt <= Date.now()) {
      delete this.data[key];
      await this.persistSoon();
      return null;
    }

    return item.value ?? null;
  }

  async put(key, value, options = {}) {
    await this.load();

    const ttl = Number(options.expirationTtl || 0);
    const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : null;

    this.data[key] = {
      value: String(value),
      expiresAt,
      updatedAt: new Date().toISOString(),
    };

    await this.persistSoon();
  }

  async delete(key) {
    await this.load();
    delete this.data[key];
    await this.persistSoon();
  }
}

class PostgresMemoryStore {
  constructor(databaseUrl) {
    const { Pool } = pg;
    this.pool = new Pool({
      connectionString: databaseUrl,
      // Railway 的内部 DATABASE_URL 通常不需要 SSL。
      // 如果你使用外部 Postgres 且要求 SSL，可设置 PGSSLMODE=require。
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
    });
    this.ready = false;
  }

  async init() {
    if (this.ready) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memory_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at TIMESTAMPTZ NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_store_expires_at
      ON memory_store (expires_at);
    `);

    this.ready = true;
    await this.cleanupExpired();

    console.log("PostgreSQL memory store is ready.");
  }

  async cleanupExpired() {
    await this.pool.query(
      `DELETE FROM memory_store WHERE expires_at IS NOT NULL AND expires_at <= NOW();`
    );
  }

  async get(key) {
    await this.init();

    const res = await this.pool.query(
      `SELECT value FROM memory_store
       WHERE key = $1
       AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1;`,
      [key]
    );

    return res.rows[0]?.value ?? null;
  }

  async put(key, value, options = {}) {
    await this.init();

    const ttl = Number(options.expirationTtl || 0);
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;

    await this.pool.query(
      `INSERT INTO memory_store (key, value, expires_at, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key)
       DO UPDATE SET
         value = EXCLUDED.value,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW();`,
      [key, String(value), expiresAt]
    );
  }

  async delete(key) {
    await this.init();

    await this.pool.query(
      `DELETE FROM memory_store WHERE key = $1;`,
      [key]
    );
  }
}

const MEMORY = DATABASE_URL
  ? new PostgresMemoryStore(DATABASE_URL)
  : new JsonMemoryStore(MEMORY_FILE);

console.log(DATABASE_URL ? "记忆存储：PostgreSQL" : "记忆存储：memory.json 文件");

const baseConfig = {
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
};

const feishuClient = new Lark.Client(baseConfig);

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    await handleFeishuMessage(data);
  },
});

const wsClient = new Lark.WSClient({
  ...baseConfig,
  loggerLevel: Lark.LoggerLevel.debug,
});

console.log("正在使用官方 SDK 启动飞书长连接客户端 WSClient...");
wsClient.start({ eventDispatcher });
console.log("wsClient.start 已执行。现在可以去飞书后台验证长连接。");

// Node 常驻进程版“定时复盘”
// 原 Cloudflare scheduled 改为 setInterval。
const scheduleInterval = Number(SCHEDULE_INTERVAL_MS);
if (scheduleInterval > 0) {
  setInterval(() => {
    runScheduledReview().catch((error) => {
      console.error("Scheduled review failed:", error);
    });
  }, scheduleInterval);

  console.log(`定时复盘已启用，间隔 ${scheduleInterval}ms`);
}

async function handleFeishuMessage(data) {
  try {
    const message = data.message || {};
    const sender = data.sender || {};

    const chatId = message.chat_id;
    const messageType = message.message_type;

    const userId =
      sender.sender_id?.open_id ||
      sender.sender_id?.user_id ||
      "unknown_user";

    if (!chatId) return;

    if (messageType !== "text") {
      await sendFeishuText(chatId, "我现在先支持文字。图片、文件、飞书文档读取可以后面再加。");
      return;
    }

    let userText = "";
    try {
      const content = JSON.parse(message.content || "{}");
      userText = content.text || "";
    } catch {
      userText = message.content || "";
    }

    userText = cleanFeishuText(userText);

    if (!userText.trim()) return;

    console.log(`收到消息 chat=${chatId} user=${userId}:`, userText);

    // 命令入口：保留原逻辑
    if (userText === "/帮助") {
      await sendFeishuText(chatId, helpText());
      return;
    }

    if (userText === "/绑定主人") {
      await MEMORY.put("admin:chat_id", chatId);
      await sendFeishuText(chatId, "已绑定。以后定时复盘会发到这个会话。");
      return;
    }

    if (userText === "/忘记") {
      await MEMORY.delete(memoryKey(chatId, userId));
      await sendFeishuText(chatId, "已清空当前会话的短期上下文。长期偏好和 Skill 不会删除。");
      return;
    }

    if (userText === "/技能") {
      const skills = await listSkills();
      await sendFeishuText(chatId, skills);
      return;
    }

    if (userText.startsWith("/搜索 ")) {
      const query = userText.replace("/搜索 ", "").trim();
      await sendFeishuText(chatId, "我去网上查一下。");
      const searchContext = await webSearch(query, { force: true });
      const answer = await answerWithSearch(query, searchContext);
      await sendFeishuText(chatId, answer);
      return;
    }

    if (userText.startsWith("/爬取 ")) {
      const url = userText.replace("/爬取 ", "").trim();
      await sendFeishuText(chatId, "我尝试读取这个网页。");
      const page = await fetchPageText(url);
      const summary = await summarizePage(url, page);
      await sendFeishuText(chatId, summary);
      return;
    }

    if (userText.startsWith("/沉淀skill ")) {
      const raw = userText.replace("/沉淀skill ", "").trim();
      await sendFeishuText(chatId, "我会把这段经验整理成一个 Skill。");
      const saved = await createSkillFromText(raw, userId);
      await sendFeishuText(chatId, saved);
      return;
    }

    if (userText === "/复盘") {
      await sendFeishuText(chatId, "我开始复盘最近对话，并更新长期偏好/Skill。");
      const result = await reflectAndLearn(chatId, userId, { manual: true });
      await sendFeishuText(chatId, result);
      return;
    }

    // 正常聊天
    await handleNormalChat(chatId, userId, userText);
  } catch (err) {
    console.error("handleFeishuMessage error:", err);
  }
}

async function handleNormalChat(chatId, userId, userText) {
  const mKey = memoryKey(chatId, userId);
  const profileKey = `profile:${userId}`;

  const history = await getJson(mKey, []);
  const profile = await MEMORY.get(profileKey) || "";
  const skills = await getRelevantSkills(userText);

  const needWeb = shouldUseWeb(userText);
  let webContext = "";

  if (needWeb) {
    await sendFeishuText(chatId, "这个问题可能需要最新信息，我先查一下。");
    webContext = await webSearch(userText, { force: false });
  } else {
    await sendFeishuText(chatId, "收到，我想一下。");
  }

  const recentHistory = history.slice(-24);

  const reply = await callDeepSeek([
    {
      role: "system",
      content: buildSystemPrompt(profile, skills, webContext),
    },
    ...recentHistory,
    {
      role: "user",
      content: userText,
    },
  ], {
    thinking: "disabled",
    maxTokens: 2200,
  });

  await sendFeishuText(chatId, reply);

  recentHistory.push({ role: "user", content: userText });
  recentHistory.push({ role: "assistant", content: reply });

  await MEMORY.put(mKey, JSON.stringify(recentHistory.slice(-24)), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  // 对话计数：每 6 轮自动小复盘一次，后台做，不打扰用户
  const countKey = `turn_count:${chatId}:${userId}`;
  const count = Number(await MEMORY.get(countKey) || "0") + 1;
  await MEMORY.put(countKey, String(count), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  if (count % 6 === 0) {
    await reflectAndLearn(chatId, userId, { manual: false });
  }
}

function buildSystemPrompt(profile, skills, webContext) {
  return `你是“小龙虾AI”，一个在飞书里工作的中文个人 Agent。

你的目标：
1. 帮用户高质量完成方案、提示词、流程、复盘、资料整理、判断和执行建议。
2. 不是只聊天，而是帮助用户沉淀方法。
3. 遇到最新信息、价格、政策、API、产品、新闻、资料查证时，要结合联网资料。
4. 回答要直接、清楚、可执行。
5. 用户要求写东西时，直接给可用版本。
6. 用户说“继续、上一版、再优化”时，结合上下文。
7. 不要编造来源；如果信息来自搜索资料，要说明依据来自搜索结果。
8. 不要把不确定的内容说死。

用户长期偏好：
${profile || "暂无"}

可调用的内部 Skill：
${skills || "暂无"}

联网资料：
${webContext || "本轮没有联网资料"}

回答格式：
- 默认中文
- 先给结论
- 再给步骤或方案
- 必要时指出风险
- 不要过度啰嗦`;
}

function shouldUseWeb(text) {
  const t = text.toLowerCase();

  const keywords = [
    "最新",
    "现在",
    "今天",
    "昨天",
    "今年",
    "2026",
    "新闻",
    "价格",
    "多少钱",
    "政策",
    "法规",
    "官网",
    "api",
    "接口",
    "模型",
    "版本",
    "发布",
    "搜索",
    "查一下",
    "网上",
    "资料",
    "爬取",
    "链接",
    "http://",
    "https://",
    "github",
    "cloudflare",
    "飞书",
    "deepseek",
  ];

  return keywords.some(k => t.includes(k));
}

async function webSearch(query, options = {}) {
  if (!TAVILY_API_KEY) {
    return "未配置 TAVILY_API_KEY，无法联网搜索。";
  }

  const cacheKey = `search_cache:${simpleHash(query)}`;
  if (!options.force) {
    const cached = await MEMORY.get(cacheKey);
    if (cached) return cached;
  }

  const isNews = /新闻|今天|昨天|最新|发布|突发|政策|财经|股价|体育/.test(query);

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TAVILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      topic: isNews ? "news" : "general",
      max_results: 5,
      include_answer: true,
      include_raw_content: false,
      include_favicon: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return `联网搜索失败：${res.status} ${err}`;
  }

  const data = await res.json();

  const parts = [];

  if (data.answer) {
    parts.push(`搜索摘要：${data.answer}`);
  }

  if (Array.isArray(data.results)) {
    parts.push("搜索结果：");
    data.results.slice(0, 5).forEach((r, idx) => {
      parts.push(`${idx + 1}. ${r.title}\nURL: ${r.url}\n摘要: ${r.content || ""}`);
    });
  }

  const result = parts.join("\n\n").slice(0, 8000);

  await MEMORY.put(cacheKey, result, {
    expirationTtl: 60 * 60 * 12,
  });

  return result;
}

async function answerWithSearch(query, searchContext) {
  return await callDeepSeek([
    {
      role: "system",
      content: `你是中文研究助手。请只基于给定搜索资料回答。不要编造。回答要有结论、要点、风险。`,
    },
    {
      role: "user",
      content: `用户问题：${query}

搜索资料：
${searchContext}

请回答。`,
    },
  ], {
    thinking: "disabled",
    maxTokens: 2200,
  });
}

async function fetchPageText(url) {
  try {
    if (!/^https?:\/\//i.test(url)) {
      return "URL 格式不正确，必须以 http:// 或 https:// 开头。";
    }

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 XiaolongxiaAI/1.0",
      },
    });

    if (!res.ok) {
      return `网页读取失败：${res.status}`;
    }

    const html = await res.text();

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();

    return text.slice(0, 12000);
  } catch (e) {
    return `网页读取异常：${String(e.message || e)}`;
  }
}

async function summarizePage(url, pageText) {
  return await callDeepSeek([
    {
      role: "system",
      content: "你是网页资料整理助手。请总结网页核心内容，提炼可行动信息。不要编造网页中没有的内容。",
    },
    {
      role: "user",
      content: `URL：${url}

网页文本：
${pageText}

请输出：
1. 这页讲什么
2. 关键要点
3. 对用户可能有用的地方
4. 是否值得沉淀为 Skill`,
    },
  ], {
    thinking: "disabled",
    maxTokens: 1800,
  });
}

async function reflectAndLearn(chatId, userId, options = {}) {
  const mKey = memoryKey(chatId, userId);
  const profileKey = `profile:${userId}`;

  const history = await getJson(mKey, []);
  const oldProfile = await MEMORY.get(profileKey) || "";

  if (!history.length) {
    return "当前没有足够对话可以复盘。";
  }

  const jsonText = await callDeepSeek([
    {
      role: "system",
      content: `你是“小龙虾AI”的复盘与学习模块。
你要从最近对话中提炼长期偏好、反复出现的问题、可沉淀的 Skill。
必须输出 JSON，不要输出 JSON 以外的内容。

JSON 格式：
{
  "updated_profile": "更新后的长期偏好总结，保留旧偏好，新增明确可靠的新偏好，避免乱记",
  "review": "本次复盘总结",
  "new_skills": [
    {
      "name": "Skill 名称",
      "trigger": "什么时候触发",
      "instruction": "执行方法",
      "example": "简短示例",
      "confidence": 0.0
    }
  ]
}`,
    },
    {
      role: "user",
      content: `旧长期偏好：
${oldProfile || "暂无"}

最近对话：
${JSON.stringify(history.slice(-24), null, 2)}

请复盘并输出 JSON。`,
    },
  ], {
    thinking: "disabled",
    json: true,
    maxTokens: 2500,
  });

  const data = safeJsonParse(jsonText);

  if (!data) {
    return "复盘失败：模型没有返回可解析 JSON。";
  }

  if (data.updated_profile) {
    await MEMORY.put(profileKey, String(data.updated_profile).slice(0, 6000));
  }

  let savedSkillCount = 0;

  if (Array.isArray(data.new_skills)) {
    for (const skill of data.new_skills) {
      if (Number(skill.confidence || 0) >= 0.72 && skill.name && skill.instruction) {
        await saveSkill({
          name: skill.name,
          trigger: skill.trigger || "",
          instruction: skill.instruction,
          example: skill.example || "",
          source: "auto_reflection",
          createdBy: userId,
        });
        savedSkillCount++;
      }
    }
  }

  const report = [
    "复盘完成。",
    "",
    `本次总结：${data.review || "无"}`,
    "",
    `已更新长期偏好：${data.updated_profile ? "是" : "否"}`,
    `新增 Skill：${savedSkillCount} 个`,
  ].join("\n");

  if (options.manual) {
    return report;
  }

  await MEMORY.put(`last_auto_review:${chatId}:${userId}`, report, {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  return report;
}

async function createSkillFromText(raw, userId) {
  const jsonText = await callDeepSeek([
    {
      role: "system",
      content: `你是 Skill 设计器。
你要把用户给的经验整理成可复用 Skill。
必须输出 JSON，不要输出其他内容。

JSON 格式：
{
  "name": "Skill 名称",
  "trigger": "什么时候使用这个 Skill",
  "instruction": "具体执行步骤",
  "example": "简短示例"
}`,
    },
    {
      role: "user",
      content: raw,
    },
  ], {
    thinking: "disabled",
    json: true,
    maxTokens: 1500,
  });

  const data = safeJsonParse(jsonText);

  if (!data || !data.name || !data.instruction) {
    return "沉淀失败：没有整理出有效 Skill。";
  }

  const saved = await saveSkill({
    name: data.name,
    trigger: data.trigger || "",
    instruction: data.instruction,
    example: data.example || "",
    source: "manual",
    createdBy: userId,
  });

  return `已沉淀 Skill：${saved.name}

触发场景：
${saved.trigger}

执行方法：
${saved.instruction}`;
}

async function saveSkill(skill) {
  const id = `skill_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  const full = {
    id,
    name: String(skill.name || "").slice(0, 80),
    trigger: String(skill.trigger || "").slice(0, 500),
    instruction: String(skill.instruction || "").slice(0, 3000),
    example: String(skill.example || "").slice(0, 1000),
    source: skill.source || "unknown",
    createdBy: skill.createdBy || "unknown",
    createdAt: new Date().toISOString(),
    usageCount: 0,
  };

  await MEMORY.put(`skill:${id}`, JSON.stringify(full));

  const index = await getJson("skills:index", []);

  index.unshift({
    id,
    name: full.name,
    trigger: full.trigger,
    createdAt: full.createdAt,
    usageCount: 0,
  });

  await MEMORY.put("skills:index", JSON.stringify(index.slice(0, 80)));

  return full;
}

async function listSkills() {
  const index = await getJson("skills:index", []);

  if (!index.length) {
    return "当前还没有沉淀 Skill。你可以发送：/沉淀skill 你的经验内容";
  }

  return [
    `当前 Skill 数量：${index.length}`,
    "",
    ...index.slice(0, 20).map((s, i) => {
      return `${i + 1}. ${s.name}\n触发：${s.trigger || "未填写"}`;
    }),
  ].join("\n\n");
}

async function getRelevantSkills(userText) {
  const index = await getJson("skills:index", []);

  if (!index.length) return "";

  const text = userText.toLowerCase();

  const matched = index
    .map(s => {
      const hay = `${s.name} ${s.trigger}`.toLowerCase();
      const score = overlapScore(text, hay);
      return { ...s, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const skills = [];

  for (const item of matched) {
    const full = await getJson(`skill:${item.id}`, null);
    if (full) {
      skills.push(`Skill：${full.name}
触发：${full.trigger}
方法：${full.instruction}
示例：${full.example}`);
    }
  }

  return skills.join("\n\n---\n\n").slice(0, 6000);
}

function overlapScore(a, b) {
  const chars = Array.from(new Set(a.replace(/\s+/g, "").split("")));
  let score = 0;
  for (const c of chars) {
    if (b.includes(c)) score++;
  }
  return score;
}

async function runScheduledReview() {
  const adminChatId = await MEMORY.get("admin:chat_id");

  if (!adminChatId) {
    console.log("No admin chat bound. Use /绑定主人 first.");
    return;
  }

  const skills = await getJson("skills:index", []);
  const report = await callDeepSeek([
    {
      role: "system",
      content: "你是小龙虾AI的定时复盘模块。请根据已有 Skill 概况输出简短周报，指出下一步优化方向。",
    },
    {
      role: "user",
      content: `当前 Skill 索引：
${JSON.stringify(skills.slice(0, 50), null, 2)}

请输出：
1. 当前能力概况
2. 可能缺失的 Skill
3. 建议用户下周喂哪些案例
4. 需要清理的风险`,
    },
  ], {
    thinking: "disabled",
    maxTokens: 1800,
  });

  await sendFeishuText(adminChatId, `小龙虾AI定时复盘：\n\n${report}`);
}

async function callDeepSeek(messages, options = {}) {
  const body = {
    model: DEEPSEEK_MODEL || "deepseek-v4-pro",
    messages,
    thinking: {
      type: options.thinking === "enabled" ? "enabled" : "disabled",
    },
    stream: false,
    temperature: options.temperature ?? 0.9,
    max_tokens: options.maxTokens || 2000,
  };

  if (options.thinking === "enabled") {
    body.reasoning_effort = options.reasoningEffort || "high";
  }

  if (options.json) {
    body.response_format = { type: "json_object" };
    body.temperature = 0.2;
  }

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("DeepSeek HTTP error:", response.status, errorText);
    return `DeepSeek 调用失败：${response.status}

请检查：
1. DEEPSEEK_API_KEY 是否正确
2. DEEPSEEK_MODEL 是否可用
3. 账户余额是否充足
4. Railway 环境变量是否保存并重新部署`;
  }

  const data = await response.json();

  if (data.error) {
    console.error("DeepSeek API error:", data.error);
    return `DeepSeek 返回错误：${data.error.message || "未知错误"}`;
  }

  return data.choices?.[0]?.message?.content?.trim() || "DeepSeek 返回为空。";
}

async function sendFeishuText(chatId, text) {
  const chunks = splitText(String(text || ""), 2800);

  for (const chunk of chunks) {
    try {
      await feishuClient.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({
            text: chunk,
          }),
        },
      });
    } catch (error) {
      console.error("Feishu send message error:", error);
    }
  }
}

function splitText(text, size) {
  const chunks = [];
  let rest = text;

  while (rest.length > size) {
    chunks.push(rest.slice(0, size));
    rest = rest.slice(size);
  }

  if (rest.length) chunks.push(rest);

  return chunks;
}

function cleanFeishuText(text) {
  return String(text)
    .replace(/<at[^>]*>.*?<\/at>/g, "")
    .replace(/@\S+/g, "")
    .trim();
}

function memoryKey(chatId, userId) {
  return `memory:${chatId}:${userId}`;
}

async function getJson(key, fallback) {
  const raw = await MEMORY.get(key);

  if (!raw) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function simpleHash(input) {
  let h = 0;
  const s = String(input);

  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  }

  return Math.abs(h).toString(16);
}

function helpText() {
  return `小龙虾AI可用命令：

/帮助
查看命令

/搜索 关键词
联网搜索资料

/爬取 URL
尝试读取并总结网页

/复盘
复盘最近对话，更新长期偏好和 Skill

/沉淀skill 经验内容
把一段经验整理成可复用 Skill

/技能
查看已沉淀的 Skill

/忘记
清空当前会话短期上下文

/绑定主人
把当前会话设为定时复盘接收地

正常聊天时，我会自动判断是否需要联网搜索，并调用长期偏好和 Skill。`;
}

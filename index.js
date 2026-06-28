import "dotenv/config";
import pg from "pg";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { buildRuntimeCapabilitySummary } from "./src/capabilities.js";
import {
  createFireAndForgetEventHandler,
  createOutboundMessageKey,
  createTimeoutSignal,
  isAdminUser,
  isSafeHttpUrl,
  resolveFeishuLoggerLevel,
  shouldSendProgressMessages,
  withTimeout,
} from "./src/stability.js";
import {
  buildAutoSearchQuery,
  buildLearningChangeGate,
  extractHttpUrls,
  normalizeFeishuMessagesForLearning,
  parseLearningHours,
  shouldAutoSearchLearn,
  shouldCommitLearningChange,
} from "./src/learning.js";

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
  ADMIN_USER_IDS = "",
  REQUEST_TIMEOUT_MS = "30000",
  SEND_PROGRESS_MESSAGES = "false",
  GLOBAL_SKILL_FILES = "./global-skills/树林准则_AI版.md;./global-skills/小龙虾成长准则.md",
  ENABLE_AUTO_GROUP_LEARNING = "false",
  ENABLE_AUTO_WEB_LEARNING = "true",
  ENABLE_AUTO_SEARCH_LEARNING = "true",
  AUTO_WEB_LEARNING_MAX_URLS = "2",
  AUTO_SEARCH_LEARNING_DAILY_LIMIT = "5",
  GROUP_LEARNING_INTERVAL_MS = String(60 * 60 * 1000),
  GROUP_LEARNING_LOOKBACK_HOURS = "24",
  BOT_OPEN_ID = "",
} = process.env;

console.log("========== 小龙虾 AI 启动 ==========");
console.log("FEISHU_APP_ID 存在：", Boolean(FEISHU_APP_ID));
console.log("FEISHU_APP_SECRET 存在：", Boolean(FEISHU_APP_SECRET));
console.log("DEEPSEEK_API_KEY 存在：", Boolean(DEEPSEEK_API_KEY));
console.log("TAVILY_API_KEY 存在：", Boolean(TAVILY_API_KEY));
console.log("DATABASE_URL 存在：", Boolean(DATABASE_URL));
console.log("DEEPSEEK_MODEL：", DEEPSEEK_MODEL);
console.log("MEMORY_FILE：", MEMORY_FILE);
console.log("ADMIN_USER_IDS 已配置：", Boolean(ADMIN_USER_IDS));
console.log("SEND_PROGRESS_MESSAGES：", shouldSendProgressMessages(SEND_PROGRESS_MESSAGES));
console.log("ENABLE_AUTO_GROUP_LEARNING：", ENABLE_AUTO_GROUP_LEARNING);
console.log("ENABLE_AUTO_WEB_LEARNING：", ENABLE_AUTO_WEB_LEARNING);
console.log("ENABLE_AUTO_SEARCH_LEARNING：", ENABLE_AUTO_SEARCH_LEARNING);

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
  "im.message.receive_v1": createFireAndForgetEventHandler(handleFeishuMessage),
});

const wsClient = new Lark.WSClient({
  ...baseConfig,
  loggerLevel: resolveFeishuLoggerLevel(Lark.LoggerLevel, process.env.FEISHU_LOG_LEVEL),
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

const learningInterval = Number(GROUP_LEARNING_INTERVAL_MS);
if (learningInterval > 0) {
  setInterval(() => {
    runAutoGroupLearning().catch((error) => {
      console.error("Auto group learning failed:", error);
    });
  }, learningInterval);

  console.log(`群聊自动学习检查已启用，间隔 ${learningInterval}ms`);
}

async function handleFeishuMessage(data) {
  try {
    const message = data.message || {};
    const sender = data.sender || {};

    // 防循环 1：忽略机器人/应用自己发出的消息，避免自己回复自己
    if (sender.sender_type && sender.sender_type !== "user") {
      console.log("忽略非用户消息，避免自我循环：", sender.sender_type);
      return;
    }

    const chatId = message.chat_id;
    const messageType = message.message_type;
    const chatType = message.chat_type || "";

    const userId =
      sender.sender_id?.open_id ||
      sender.sender_id?.user_id ||
      "unknown_user";
    const openId = sender.sender_id?.open_id || "";
    const feishuUserId = sender.sender_id?.user_id || "";

    if (!chatId) return;
    await rememberLearningChat(chatId, chatType);

    // 防循环 2：用 message_id 去重，避免飞书事件重推导致重复回复
    const messageId = message.message_id;
    if (messageId) {
      const dedupeKey = `event:${messageId}`;
      const existed = await MEMORY.get(dedupeKey);
      if (existed) {
        console.log("忽略重复消息事件：", messageId);
        return;
      }
      await MEMORY.put(dedupeKey, "1", { expirationTtl: 600 });
    }

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

    const outboundKey = createOutboundMessageKey(chatId, userText);
    const isBotEcho = await MEMORY.get(outboundKey);
    if (isBotEcho) {
      console.log("忽略机器人自己发出的消息回流：", userText.slice(0, 80));
      return;
    }

    // 防循环 3：兜底忽略机器人自己常发的提示语
    const selfMessages = new Set([
      "收到，我想一下。",
      "我去网上查一下。",
      "我尝试读取这个网页。",
      "我开始复盘最近对话，并更新长期偏好/Skill。",
      "我会把这段经验整理成一个 Skill。",
    ]);

    if (selfMessages.has(userText)) {
      console.log("忽略疑似机器人自发提示语：", userText);
      return;
    }

    console.log(`收到消息 chat=${chatId} user=${userId}:`, userText);

    // 命令入口：保留原逻辑
    if (userText === "/帮助") {
      await sendFeishuText(chatId, helpText());
      return;
    }

    if (userText === "/绑定主人") {
      if (!isAdminUser({ openId, userId: feishuUserId }, ADMIN_USER_IDS)) {
        await sendFeishuText(chatId, "这个命令只有管理员可以使用。请在 Railway 配置 ADMIN_USER_IDS。");
        return;
      }

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
      await sendProgressText(chatId, "我去网上查一下。");
      const searchContext = await webSearch(query, { force: true });
      const answer = await answerWithSearch(query, searchContext);
      await sendFeishuText(chatId, answer);
      return;
    }

    if (userText.startsWith("/爬取 ")) {
      const url = userText.replace("/爬取 ", "").trim();
      await sendProgressText(chatId, "我尝试读取这个网页。");
      const page = await fetchPageText(url);
      const summary = await summarizePage(url, page);
      await sendFeishuText(chatId, summary);
      return;
    }

    if (userText.startsWith("/学习网页 ")) {
      const url = userText.replace("/学习网页 ", "").trim();
      const result = await learnFromWebPage(url, userId, {
        manual: true,
        force: true,
      });
      await sendFeishuText(chatId, result);
      return;
    }

    if (userText.startsWith("/搜索学习 ")) {
      const query = userText.replace("/搜索学习 ", "").trim();
      await sendProgressText(chatId, "我去搜索并学习。");
      const result = await learnFromSearchQuery(query, userId, {
        manual: true,
        force: true,
      });
      await sendFeishuText(chatId, result);
      return;
    }

    if (userText.startsWith("/沉淀skill ")) {
      const raw = userText.replace("/沉淀skill ", "").trim();
      await sendProgressText(chatId, "我会把这段经验整理成一个 Skill。");
      const saved = await createSkillFromText(raw, userId);
      await sendFeishuText(chatId, saved);
      return;
    }

    if (userText === "/复盘") {
      await sendProgressText(chatId, "我开始复盘最近对话，并更新长期偏好/Skill。");
      const result = await reflectAndLearn(chatId, userId, { manual: true });
      await sendFeishuText(chatId, result);
      return;
    }

    if (userText.startsWith("/学习群聊")) {
      if (!isAdminUser({ openId, userId: feishuUserId }, ADMIN_USER_IDS)) {
        await sendFeishuText(chatId, "这个命令只有管理员可以使用。请在 Railway 配置 ADMIN_USER_IDS。");
        return;
      }

      const hours = parseLearningHours(userText.replace("/学习群聊", ""));
      const result = await learnFromChat(chatId, userId, hours, { manual: true });
      await sendFeishuText(chatId, result);
      return;
    }

    if (userText === "/学习笔记") {
      const notes = await listLearningNotes();
      await sendFeishuText(chatId, notes);
      return;
    }

    if (userText === "/进化日志") {
      const logs = await listEvolutionLogs();
      await sendFeishuText(chatId, logs);
      return;
    }

    if (userText === "/开启自动学习") {
      if (!isAdminUser({ openId, userId: feishuUserId }, ADMIN_USER_IDS)) {
        await sendFeishuText(chatId, "这个命令只有管理员可以使用。请在 Railway 配置 ADMIN_USER_IDS。");
        return;
      }

      await MEMORY.put("learning:auto_enabled", "true");
      await sendFeishuText(chatId, "已开启自动群聊学习。小龙虾会定期读取已登记群聊的最近消息，提炼长期记忆和候选 Skill。");
      return;
    }

    if (userText === "/关闭自动学习") {
      if (!isAdminUser({ openId, userId: feishuUserId }, ADMIN_USER_IDS)) {
        await sendFeishuText(chatId, "这个命令只有管理员可以使用。请在 Railway 配置 ADMIN_USER_IDS。");
        return;
      }

      await MEMORY.put("learning:auto_enabled", "false");
      await sendFeishuText(chatId, "已关闭自动群聊学习。");
      return;
    }

    scheduleAutoWebLearningFromText(userText, userId);
    scheduleAutoSearchLearningFromText(userText, userId);

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
  const selfProfile = await MEMORY.get("self:learned_profile") || "";
  const dynamicPrompt = await MEMORY.get("self:dynamic_prompt") || "";
  const skills = await getRelevantSkills(userText);
  const globalSkills = await getGlobalSkillsText();
  const capabilitySummary = buildRuntimeCapabilitySummary({
    tavilyApiKey: TAVILY_API_KEY,
    enableAutoGroupLearning: ENABLE_AUTO_GROUP_LEARNING,
    enableAutoWebLearning: ENABLE_AUTO_WEB_LEARNING,
    enableAutoSearchLearning: ENABLE_AUTO_SEARCH_LEARNING,
    autoSearchLearningDailyLimit: AUTO_SEARCH_LEARNING_DAILY_LIMIT,
  });

  const needWeb = shouldUseWeb(userText);
  let webContext = "";

  if (needWeb) {
    webContext = await webSearch(userText, { force: false });
  }

  const recentHistory = history.slice(-24);

  const reply = await callDeepSeek([
    {
      role: "system",
      content: buildSystemPrompt(profile, skills, webContext, {
        globalSkills,
        selfProfile,
        dynamicPrompt,
        capabilitySummary,
      }),
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

function buildSystemPrompt(profile, skills, webContext, options = {}) {
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

小龙虾自我学习记忆：
${options.selfProfile || "暂无"}

受保护的全局准则：
${options.globalSkills || "暂无"}

小龙虾动态进化提示：
${options.dynamicPrompt || "暂无"}

小龙虾当前可用功能：
${options.capabilitySummary || "暂无"}

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

let globalSkillsCache = null;

async function getGlobalSkillsText() {
  if (globalSkillsCache) return globalSkillsCache;

  const files = String(GLOBAL_SKILL_FILES || "")
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(Boolean);

  const parts = [];

  for (const file of files) {
    try {
      const fullPath = path.resolve(file);
      const content = await fs.readFile(fullPath, "utf8");
      parts.push(`文件：${path.basename(file)}\n${content.trim()}`);
    } catch (error) {
      console.warn("Global skill file load failed:", file, error.message);
    }
  }

  globalSkillsCache = parts.join("\n\n---\n\n").slice(0, 26000);
  return globalSkillsCache;
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

  try {
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
      signal: createTimeoutSignal(requestTimeoutMs()),
    });

    if (!res.ok) {
      const err = await res.text();
      return `联网搜索失败：${res.status} ${err.slice(0, 1000)}`;
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
  } catch (error) {
    console.error("webSearch error:", error);
    return `联网搜索异常：${formatExternalError(error)}`;
  }
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

    const safe = await isSafeHttpUrl(url, { resolveDns: true });
    if (!safe) {
      return "URL 不安全或不可访问，已拒绝读取。请使用公开网站的 http/https 链接。";
    }

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 XiaolongxiaAI/1.0",
      },
      signal: createTimeoutSignal(requestTimeoutMs()),
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
    return `网页读取异常：${formatExternalError(e)}`;
  }
}

function isAutoWebLearningEnabled() {
  return ["1", "true", "yes", "on"].includes(String(ENABLE_AUTO_WEB_LEARNING || "").toLowerCase());
}

function isAutoSearchLearningEnabled() {
  return ["1", "true", "yes", "on"].includes(String(ENABLE_AUTO_SEARCH_LEARNING || "").toLowerCase());
}

function autoSearchDailyLimit() {
  const limit = Number(AUTO_SEARCH_LEARNING_DAILY_LIMIT);
  if (!Number.isFinite(limit)) return 5;
  return Math.max(0, Math.min(50, Math.floor(limit)));
}

function scheduleAutoWebLearningFromText(text, userId) {
  if (!isAutoWebLearningEnabled()) return;

  const limit = Math.max(1, Math.min(5, Number(AUTO_WEB_LEARNING_MAX_URLS) || 2));
  const urls = extractHttpUrls(text, limit);

  for (const url of urls) {
    learnFromWebPage(url, userId, {
      manual: false,
      force: false,
    }).catch(error => {
      console.error("Auto web learning failed:", error);
    });
  }
}

function scheduleAutoSearchLearningFromText(text, userId) {
  if (!isAutoSearchLearningEnabled() || !TAVILY_API_KEY) return;
  if (!shouldAutoSearchLearn(text)) return;

  const query = buildAutoSearchQuery(text);
  if (!query) return;

  learnFromSearchQuery(query, userId, {
    manual: false,
    force: false,
  }).catch(error => {
    console.error("Auto search learning failed:", error);
  });
}

async function learnFromWebPage(url, userId, options = {}) {
  const safe = await isSafeHttpUrl(url, { resolveDns: true });
  if (!safe) {
    return "网页学习失败：URL 不安全或不可访问。请使用公开网站的 http/https 链接。";
  }

  const learningKey = `learning:web:${simpleHash(url)}`;
  if (!options.force) {
    const learned = await MEMORY.get(learningKey);
    if (learned) {
      return "网页已学习过，跳过重复学习。";
    }
  }

  const pageText = await fetchPageText(url);
  if (!pageText || pageText.startsWith("URL ") || pageText.startsWith("网页读取") || pageText.startsWith("URL 不安全")) {
    return `网页学习失败：${pageText || "没有读取到内容"}`;
  }

  const result = await analyzeAndApplyLearning({
    source: "web_page",
    url,
    userId,
    messages: [
      {
        messageId: `web:${simpleHash(url)}`,
        senderId: userId,
        createTime: new Date().toISOString(),
        text: `URL：${url}\n\n网页内容：${pageText.slice(0, 12000)}`,
      },
    ],
  });

  await MEMORY.put(learningKey, new Date().toISOString(), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  return options.manual ? result : "web learning complete";
}

async function learnFromSearchQuery(rawQuery, userId, options = {}) {
  const query = buildAutoSearchQuery(rawQuery);
  if (!query) {
    return "搜索学习失败：没有可搜索的主题。";
  }

  if (!TAVILY_API_KEY) {
    return "搜索学习失败：未配置 TAVILY_API_KEY。自动网页链接学习可以继续，但主动搜索网页需要 Tavily。";
  }

  const learningKey = `learning:search:${simpleHash(query.toLowerCase())}`;
  if (!options.force) {
    const learned = await MEMORY.get(learningKey);
    if (learned) {
      return "这个主题近期已搜索学习过，跳过重复学习。";
    }
  }

  if (!options.manual) {
    const quotaOk = await consumeAutoSearchLearningQuota();
    if (!quotaOk) {
      return "自动搜索学习今日额度已用完，跳过。";
    }
  }

  const searchContext = await webSearch(query, { force: true });
  if (!searchContext || /^(未配置|联网搜索失败|联网搜索异常)/.test(searchContext)) {
    return `搜索学习失败：${searchContext || "没有搜索结果"}`;
  }

  const result = await analyzeAndApplyLearning({
    source: "web_search",
    query,
    userId,
    messages: [
      {
        messageId: `search:${simpleHash(query)}`,
        senderId: userId,
        createTime: new Date().toISOString(),
        text: `搜索主题：${query}\n\n联网搜索资料：${searchContext.slice(0, 10000)}`,
      },
    ],
  });

  await MEMORY.put(learningKey, new Date().toISOString(), {
    expirationTtl: 60 * 60 * 24 * 14,
  });

  return options.manual ? result : "search learning complete";
}

async function consumeAutoSearchLearningQuota() {
  const limit = autoSearchDailyLimit();
  if (limit <= 0) return false;

  const day = new Date().toISOString().slice(0, 10);
  const key = `learning:search:daily:${day}`;
  const used = Number(await MEMORY.get(key) || "0");

  if (used >= limit) return false;

  await MEMORY.put(key, String(used + 1), {
    expirationTtl: 60 * 60 * 48,
  });

  return true;
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

async function rememberLearningChat(chatId, chatType = "") {
  const index = await getJson("learning:chats:index", []);
  const next = [
    {
      chatId,
      chatType,
      updatedAt: new Date().toISOString(),
    },
    ...index.filter(item => item.chatId !== chatId),
  ].slice(0, 50);

  await MEMORY.put("learning:chats:index", JSON.stringify(next), {
    expirationTtl: 60 * 60 * 24 * 180,
  });
}

async function isAutoLearningEnabled() {
  const stored = await MEMORY.get("learning:auto_enabled");
  if (stored === "true") return true;
  if (stored === "false") return false;
  return ["1", "true", "yes", "on"].includes(String(ENABLE_AUTO_GROUP_LEARNING || "").toLowerCase());
}

async function runAutoGroupLearning() {
  if (!await isAutoLearningEnabled()) return;

  const index = await getJson("learning:chats:index", []);
  const groupChats = index.filter(item => item.chatType === "group");

  if (!groupChats.length) {
    console.log("Auto learning skipped: no group chats registered.");
    return;
  }

  const hours = parseLearningHours(GROUP_LEARNING_LOOKBACK_HOURS);

  for (const item of groupChats.slice(0, 10)) {
    const lastKey = `learning:last_run:${item.chatId}`;
    const lastRun = Number(await MEMORY.get(lastKey) || "0");
    if (Date.now() - lastRun < Math.max(learningInterval, 60 * 60 * 1000) * 0.8) {
      continue;
    }

    await learnFromChat(item.chatId, "auto_group_learning", hours, { manual: false });
    await MEMORY.put(lastKey, String(Date.now()), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
  }
}

async function learnFromChat(chatId, userId, hours, options = {}) {
  try {
    const messages = await fetchFeishuChatMessages(chatId, hours);
    const normalized = normalizeFeishuMessagesForLearning(messages, {
      botOpenId: BOT_OPEN_ID,
    });

    if (!normalized.length) {
      return `没有读到可学习的群聊文本。请确认机器人在群里，并已开通读取群历史消息相关权限。`;
    }

    const result = await analyzeAndApplyLearning({
      source: "feishu_group_chat",
      chatId,
      userId,
      hours,
      messages: normalized,
    });

    return options.manual ? result : "auto learning complete";
  } catch (error) {
    console.error("learnFromChat error:", error);
    return `群聊学习失败：${formatExternalError(error)}`;
  }
}

async function fetchFeishuChatMessages(chatId, hours) {
  const token = await getTenantAccessToken();
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - parseLearningHours(hours) * 60 * 60;
  const all = [];
  let pageToken = "";

  for (let i = 0; i < 5; i++) {
    const params = new URLSearchParams({
      container_id_type: "chat",
      container_id: chatId,
      start_time: String(startTime),
      end_time: String(endTime),
      page_size: "50",
      sort_type: "ByCreateTimeAsc",
    });

    if (pageToken) params.set("page_token", pageToken);

    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?${params.toString()}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
      },
      signal: createTimeoutSignal(requestTimeoutMs()),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text || "{}");
    } catch {
      throw new Error(`飞书历史消息接口返回非 JSON：${text.slice(0, 300)}`);
    }

    if (!res.ok || data.code !== 0) {
      throw new Error(`飞书历史消息读取失败：${res.status} ${data.msg || text.slice(0, 500)}`);
    }

    all.push(...(data.data?.items || []));
    if (!data.data?.has_more) break;
    pageToken = data.data?.page_token || "";
    if (!pageToken) break;
  }

  return all;
}

async function getTenantAccessToken() {
  const cached = await MEMORY.get("feishu:tenant_access_token");
  if (cached) return cached;

  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    }),
    signal: createTimeoutSignal(requestTimeoutMs()),
  });

  const data = await res.json();
  if (!res.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`tenant_access_token 获取失败：${data.msg || res.status}`);
  }

  await MEMORY.put("feishu:tenant_access_token", data.tenant_access_token, {
    expirationTtl: Math.max(60, Number(data.expire || 7200) - 300),
  });

  return data.tenant_access_token;
}

async function analyzeAndApplyLearning(context) {
  const globalSkills = await getGlobalSkillsText();
  const oldSelfProfile = await MEMORY.get("self:learned_profile") || "";
  const oldDynamicPrompt = await MEMORY.get("self:dynamic_prompt") || "";

  const jsonText = await callDeepSeek([
    {
      role: "system",
      content: `你是小龙虾的自我学习模块。
你可以更新小龙虾的长期记忆、候选 Skill、动态提示词，但必须遵守全局准则和成长宪法。

硬规则：
1. 只吸收结构、判断标准、可复用方法、反例，不吸收一次性情绪和低质叙事。
2. 不允许修改受保护内核：目的、北极星、成长红线、自我进化协议。
3. 动态提示词只能补充执行细节，不能覆盖全局准则。
4. 必须输出 JSON，不要输出 JSON 以外内容。

输出格式：
{
  "updated_self_profile": "更新后的小龙虾长期自我学习记忆，保留旧内容，压缩到可靠结构",
  "learning_notes": [
    {
      "title": "学习笔记标题",
      "summary": "学到了什么结构",
      "evidence": "依据来自哪类群聊内容，不要大段引用原文",
      "confidence": 0.0
    }
  ],
  "new_skills": [
    {
      "name": "Skill 名称",
      "trigger": "什么时候触发",
      "instruction": "执行方法",
      "example": "简短示例",
      "confidence": 0.0
    }
  ],
  "dynamic_prompt_patch": {
    "content": "如果确实需要改动态提示词，给出完整替换文本；否则为空字符串",
    "reason": "为什么这次改动三年后仍然有用",
    "confidence": 0.0,
    "change_gate": {
      "target": "prompt",
      "touchesProtectedCore": false,
      "compounds": true,
      "focused": true,
      "calm": true,
      "redlineSafe": true,
      "sourced": true,
      "reversible": true
    }
  }
}

全局准则：
${globalSkills}`,
    },
    {
      role: "user",
      content: `旧自我学习记忆：
${oldSelfProfile || "暂无"}

旧动态提示词：
${oldDynamicPrompt || "暂无"}

学习来源：${context.source}
${context.chatId ? `群聊 ID：${context.chatId}` : ""}
${context.url ? `网页 URL：${context.url}` : ""}
${context.query ? `搜索主题：${context.query}` : ""}
${context.hours ? `时间范围：最近 ${context.hours} 小时` : ""}

学习材料：
${JSON.stringify(context.messages.slice(-120), null, 2)}

请学习并输出 JSON。`,
    },
  ], {
    thinking: "disabled",
    json: true,
    maxTokens: 3000,
  });

  const data = safeJsonParse(jsonText);
  if (!data) {
    return "学习失败：模型没有返回可解析 JSON。";
  }

  let savedNotes = 0;
  let savedSkills = 0;
  let promptUpdated = false;

  if (data.updated_self_profile) {
    await MEMORY.put("self:learned_profile", String(data.updated_self_profile).slice(0, 8000));
  }

  if (Array.isArray(data.learning_notes)) {
    for (const note of data.learning_notes) {
      if (Number(note.confidence || 0) >= 0.65 && note.title && note.summary) {
        await saveLearningNote(note, context);
        savedNotes++;
      }
    }
  }

  if (Array.isArray(data.new_skills)) {
    for (const skill of data.new_skills) {
      if (Number(skill.confidence || 0) >= 0.72 && skill.name && skill.instruction) {
        await saveSkill({
          name: skill.name,
          trigger: skill.trigger || "",
          instruction: skill.instruction,
          example: skill.example || "",
          source: context.source || "learning",
          createdBy: context.userId,
        });
        savedSkills++;
      }
    }
  }

  const patch = data.dynamic_prompt_patch || {};
  if (patch.content && Number(patch.confidence || 0) >= 0.75) {
    const gate = buildLearningChangeGate(patch.change_gate || {});
    if (shouldCommitLearningChange(gate)) {
      await MEMORY.put("self:dynamic_prompt", String(patch.content).slice(0, 5000));
      await saveEvolutionLog({
        target: "prompt",
        reason: patch.reason || "",
        previous: oldDynamicPrompt,
        next: String(patch.content).slice(0, 5000),
        gate,
        source: context.source,
      });
      promptUpdated = true;
    } else {
      await saveEvolutionLog({
        target: "prompt",
        reason: patch.reason || "未通过进化闸门",
        previous: oldDynamicPrompt,
        next: String(patch.content).slice(0, 5000),
        gate,
        source: context.source,
        outcome: "not_committed",
      });
    }
  }

  const sourceTitle = {
    feishu_group_chat: "群聊学习完成。",
    web_page: "网页学习完成。",
    web_search: "搜索学习完成。",
  }[context.source] || "学习完成。";

  return [
    sourceTitle,
    "",
    `读取材料：${context.messages.length} 条`,
    `新增学习笔记：${savedNotes} 条`,
    `新增 Skill：${savedSkills} 个`,
    `动态提示词更新：${promptUpdated ? "是" : "否"}`,
  ].join("\n");
}

async function saveLearningNote(note, context) {
  const id = `note_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const full = {
    id,
    title: String(note.title || "").slice(0, 120),
    summary: String(note.summary || "").slice(0, 2000),
    evidence: String(note.evidence || "").slice(0, 1000),
    confidence: Number(note.confidence || 0),
    source: context.source,
    chatId: context.chatId || "",
    url: context.url || "",
    query: context.query || "",
    createdAt: new Date().toISOString(),
  };

  await MEMORY.put(`learning_note:${id}`, JSON.stringify(full));

  const index = await getJson("learning:notes:index", []);
  index.unshift({
    id,
    title: full.title,
    confidence: full.confidence,
    createdAt: full.createdAt,
  });
  await MEMORY.put("learning:notes:index", JSON.stringify(index.slice(0, 80)));

  return full;
}

async function listLearningNotes() {
  const index = await getJson("learning:notes:index", []);

  if (!index.length) {
    return "当前还没有学习笔记。你可以发送：/学习群聊 24小时";
  }

  const rows = [];
  for (const item of index.slice(0, 10)) {
    const full = await getJson(`learning_note:${item.id}`, null);
    if (!full) continue;
    rows.push(`${rows.length + 1}. ${full.title}\n${full.summary}`);
  }

  return ["最近学习笔记：", "", ...rows].join("\n\n").slice(0, 6000);
}

async function saveEvolutionLog(log) {
  const id = `evolution_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const full = {
    id,
    target: log.target,
    reason: String(log.reason || "").slice(0, 1000),
    previous: String(log.previous || "").slice(0, 2000),
    next: String(log.next || "").slice(0, 2000),
    gate: log.gate || null,
    source: log.source || "unknown",
    outcome: log.outcome || log.gate?.outcome || "unknown",
    createdAt: new Date().toISOString(),
  };

  await MEMORY.put(`evolution_log:${id}`, JSON.stringify(full));
  const index = await getJson("evolution:logs:index", []);
  index.unshift({
    id,
    target: full.target,
    outcome: full.outcome,
    createdAt: full.createdAt,
  });
  await MEMORY.put("evolution:logs:index", JSON.stringify(index.slice(0, 50)));
}

async function listEvolutionLogs() {
  const index = await getJson("evolution:logs:index", []);

  if (!index.length) {
    return "当前还没有进化日志。";
  }

  const rows = [];
  for (const item of index.slice(0, 10)) {
    const full = await getJson(`evolution_log:${item.id}`, null);
    if (!full) continue;
    rows.push(`${rows.length + 1}. ${full.createdAt}｜${full.target}｜${full.outcome}\n原因：${full.reason || "无"}`);
  }

  return ["最近进化日志：", "", ...rows].join("\n\n").slice(0, 6000);
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
  if (!DEEPSEEK_API_KEY) {
    return "未配置 DEEPSEEK_API_KEY，无法调用 DeepSeek。";
  }

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

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: createTimeoutSignal(requestTimeoutMs()),
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
  } catch (error) {
    console.error("DeepSeek request error:", error);
    return `DeepSeek 调用异常：${formatExternalError(error)}`;
  }
}

async function sendFeishuText(chatId, text) {
  const chunks = splitText(String(text || ""), 2800);

  for (const chunk of chunks) {
    try {
      await MEMORY.put(createOutboundMessageKey(chatId, chunk), "1", {
        expirationTtl: 60 * 60,
      });

      await withTimeout(
        feishuClient.im.v1.message.create({
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
        }),
        requestTimeoutMs(),
        "Feishu send message"
      );
    } catch (error) {
      console.error("Feishu send message error:", error);
    }
  }
}

async function sendProgressText(chatId, text) {
  if (!shouldSendProgressMessages(SEND_PROGRESS_MESSAGES)) return;
  await sendFeishuText(chatId, text);
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

function requestTimeoutMs() {
  const timeout = Number(REQUEST_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 30000;
}

function formatExternalError(error) {
  if (error?.name === "AbortError") {
    return `请求超时，请稍后重试或缩小问题范围。`;
  }

  return String(error?.message || error || "未知错误").slice(0, 500);
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

/学习网页 URL
读取网页文章，自动提炼学习笔记和 Skill

/搜索学习 主题
搜索网页资料并自动提炼学习笔记和 Skill

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

/学习群聊 24小时
读取当前群最近一段时间的消息，提炼学习笔记、Skill 和动态提示词

/学习笔记
查看最近沉淀的学习笔记

/进化日志
查看小龙虾最近对自己提示词/记忆的改动记录

/开启自动学习
定期读取已登记群聊并自动学习

/关闭自动学习
停止自动读取群聊学习

正常聊天时，我会自动判断是否需要联网搜索，并调用长期偏好和 Skill。`;
}

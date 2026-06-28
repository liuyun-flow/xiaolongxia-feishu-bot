export function extractTextFromFeishuMessage(message) {
  if (!message || message.msg_type !== "text") return null;

  const content = message.body?.content ?? message.content ?? "";
  let text = "";

  try {
    const parsed = typeof content === "string" ? JSON.parse(content || "{}") : content;
    text = parsed.text || "";
  } catch {
    text = String(content || "");
  }

  text = cleanFeishuText(text);
  if (!text) return null;

  return {
    messageId: message.message_id || "",
    senderId: message.sender?.id || message.sender?.sender_id?.open_id || message.sender?.sender_id?.user_id || "",
    createTime: String(message.create_time || ""),
    text,
  };
}

export function normalizeFeishuMessagesForLearning(messages, options = {}) {
  const seen = new Set();
  const botOpenId = options.botOpenId || "";
  const result = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const item = extractTextFromFeishuMessage(message);
    if (!item) continue;
    if (botOpenId && item.senderId === botOpenId) continue;
    if (seen.has(item.messageId)) continue;

    seen.add(item.messageId);
    result.push(item);
  }

  return result;
}

export function parseLearningHours(input, fallback = 24) {
  const match = String(input || "").match(/\d+/);
  const raw = match ? Number(match[0]) : fallback;

  if (!Number.isFinite(raw)) return fallback;
  return Math.min(168, Math.max(1, raw));
}

export function extractHttpUrls(text, limit = 5) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'，。！？、；）)\]}]+/gi) || [];
  const seen = new Set();
  const result = [];

  for (const match of matches) {
    const url = match.replace(/[.,!?;:，。！？；：]+$/g, "");
    if (seen.has(url)) continue;

    seen.add(url);
    result.push(url);
    if (result.length >= limit) break;
  }

  return result;
}

export function shouldAutoSearchLearn(text) {
  const raw = cleanFeishuText(text);
  if (!raw || raw.startsWith("/") || raw.length < 8) return false;
  if (extractHttpUrls(raw, 1).length) return false;

  const asksForLearningMaterial = /有没有.*(?:资料|文章|书|书籍|书单|论文|报告|教程|指南|方法|案例|资源)/.test(raw);
  const asksForImprovement = /(?:如何|怎么).*(?:学习|提升|训练|建立|理解|掌握|研究)/.test(raw);
  const hasResearchIntent = /(?:研究|学习|了解|查一下|查找|搜索|搜一下|找一下|整理|总结|分析)/.test(raw);
  const hasReusableTopic = /(?:资料|文章|书籍|书单|论文|报告|教程|指南|方法|框架|案例|原理|模型|工具|资源|训练|知识)/.test(raw);

  return asksForLearningMaterial || asksForImprovement || (hasResearchIntent && hasReusableTopic);
}

export function buildAutoSearchQuery(text) {
  let query = cleanFeishuText(text)
    .replace(/https?:\/\/[^\s<>"'，。！？、；）)\]}]+/gi, " ")
    .replace(/^[/#]\S+\s*/, " ")
    .replace(/[？?！!。；;，,]+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  query = query
    .replace(/^(?:请|麻烦|劳烦|可以)?(?:你)?(?:帮我|帮忙|给我|替我|为我)?(?:去)?(?:研究|学习|了解|查一下|查找|搜索|搜一下|找一下|整理|总结|分析)(?:一下|下)?(?:关于|有关)?/, "")
    .replace(/^有没有(?:关于|有关)?/, "")
    .replace(/^(?:请|麻烦|劳烦|可以)?(?:给我|帮我)?推荐(?:一下|下)?/, "")
    .replace(/[？?！!。；;，,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return query.slice(0, 120);
}

export function buildLearningChangeGate(change = {}) {
  const gate = {
    target: change.target || "memory",
    touchesProtectedCore: Boolean(change.touchesProtectedCore),
    G1_compounds: Boolean(change.compounds),
    G2_focused: Boolean(change.focused),
    G3_calm: Boolean(change.calm),
    G4_redline: Boolean(change.redlineSafe),
    G5_sourced: Boolean(change.sourced),
    reversible: Boolean(change.reversible),
    outcome: "DEFER",
  };

  if (gate.touchesProtectedCore || !gate.G4_redline) {
    gate.outcome = "REJECT";
    return gate;
  }

  const canCommit = gate.G1_compounds &&
    gate.G2_focused &&
    gate.G3_calm &&
    gate.G5_sourced &&
    gate.reversible;

  gate.outcome = canCommit ? "COMMIT" : "DEFER";
  return gate;
}

export function shouldCommitLearningChange(gate) {
  return gate?.outcome === "COMMIT";
}

function cleanFeishuText(text) {
  return String(text)
    .replace(/<at[^>]*>.*?<\/at>/g, "")
    .replace(/@\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

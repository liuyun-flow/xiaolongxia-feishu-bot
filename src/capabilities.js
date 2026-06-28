export function buildRuntimeCapabilitySummary(config = {}) {
  const hasTavily = Boolean(config.tavilyApiKey);
  const autoGroup = isEnabled(config.enableAutoGroupLearning);
  const autoWeb = isEnabled(config.enableAutoWebLearning);
  const autoSearch = isEnabled(config.enableAutoSearchLearning);
  const dailyLimit = Number(config.autoSearchLearningDailyLimit);
  const safeDailyLimit = Number.isFinite(dailyLimit) ? Math.max(0, Math.floor(dailyLimit)) : 5;

  return `当前运行能力说明：
1. 你有联网搜索能力：/搜索 关键词。${hasTavily ? "TAVILY_API_KEY 已配置，可以搜索。" : "TAVILY_API_KEY 未配置时会无法实际搜索；这不是代码没有搜索功能，而是运行环境缺少搜索密钥。"}
2. 你有网页读取能力：/爬取 URL，可以读取公开网页并总结。
3. 你有网页学习能力：/学习网页 URL，可以读取网页文章，提炼学习笔记和候选 Skill。
4. 你有搜索学习能力：/搜索学习 主题，可以搜索网页资料并提炼学习笔记和候选 Skill。
5. 自动网页学习：${autoWeb ? "已开启。普通聊天里出现公开 http/https 链接时，会在后台学习网页内容。" : "已关闭，需要 ENABLE_AUTO_WEB_LEARNING=true 才会自动学习链接。"}
6. 自动搜索学习：${autoSearch ? `已开启。普通聊天里出现明确学习、研究、找资料意图时，会在后台搜索并学习；默认每日上限 ${safeDailyLimit} 次。` : "已关闭，需要 ENABLE_AUTO_SEARCH_LEARNING=true 才会自动搜索学习。"}
7. 群聊学习：支持 /学习群聊 24小时 手动读取群聊历史。自动群聊学习${autoGroup ? "已开启" : "默认关闭，可用 /开启自动学习 或 ENABLE_AUTO_GROUP_LEARNING=true 开启"}。
8. 自我学习结果会沉淀为长期自我记忆、学习笔记、候选 Skill、动态提示词；动态提示词改动必须通过进化闸门。
9. 当用户问“你有什么功能/能不能自动学习/能不能搜索”时，要基于这份能力说明回答；不要回答自己没有这些功能，只能说明某项功能是否缺少配置或需要开启。`;
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

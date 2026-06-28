import dns from "node:dns/promises";
import net from "node:net";

export function createFireAndForgetEventHandler(processMessage, onError = console.error) {
  return async function fireAndForgetEventHandler(data) {
    Promise.resolve()
      .then(() => processMessage(data))
      .catch(error => {
        onError("handleFeishuMessage async error:", error);
      });
  };
}

export function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = Number(timeoutMs);

  if (!Number.isFinite(timeout) || timeout <= 0) {
    return controller.signal;
  }

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);
  timer.unref?.();

  return controller.signal;
}

export async function withTimeout(promise, timeoutMs, label = "Operation") {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

export function createOutboundMessageKey(chatId, text) {
  return `outbound:${simpleHash(`${chatId}\n${String(text || "").trim()}`)}`;
}

export function isAdminUser(user, adminIds) {
  const configured = String(adminIds || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);

  if (!configured.length) return true;

  const ids = new Set([
    user?.openId,
    user?.userId,
  ].filter(Boolean));

  return configured.some(id => ids.has(id));
}

export function shouldSendProgressMessages(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function resolveFeishuLoggerLevel(loggerLevels = {}, configured = "") {
  const wanted = String(configured || "").trim().toLowerCase();
  if (wanted === "debug") return pickLoggerLevel(loggerLevels, ["debug", "Debug", "DEBUG"]);

  return pickLoggerLevel(loggerLevels, ["info", "Info", "INFO", "warn", "Warn", "WARN"]);
}

export async function isSafeHttpUrl(input, options = {}) {
  let parsed;

  try {
    parsed = new URL(input);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isUnsafeHostname(hostname)) {
    return false;
  }

  if (net.isIP(hostname)) {
    return !isPrivateIp(hostname);
  }

  if (options.resolveDns) {
    try {
      const records = await dns.lookup(hostname, { all: true, verbatim: true });
      if (!records.length) return false;
      return records.every(record => !isPrivateIp(record.address));
    } catch {
      return false;
    }
  }

  return true;
}

function pickLoggerLevel(loggerLevels, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(loggerLevels, name)) {
      return loggerLevels[name];
    }
  }

  return undefined;
}

function isUnsafeHostname(hostname) {
  return hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal";
}

function isPrivateIp(address) {
  if (address.includes(":")) {
    return isPrivateIpv6(address);
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;

  return a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 198 && (b === 18 || b === 19) ||
    a >= 224;
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();

  return normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.");
}

function simpleHash(input) {
  let h = 0;
  const s = String(input);

  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  }

  return Math.abs(h).toString(16);
}

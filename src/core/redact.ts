/** 日志与响应脱敏。 */

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "xapikey",
  "apikey",
  "api_key",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "keyhash",
  "pepper",
  "encryptionkey",
  "apikeyenc",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***"],
  [/fufu_sk_[A-Za-z0-9_-]+/g, "fufu_sk_***"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza***"],
  [/\bgsk_[A-Za-z0-9]{20,}/g, "gsk_***"],
];

export const REDACTED = "[redacted]";

export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** 递归脱敏任意可序列化值；限制深度以避免恶意嵌套。 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redact(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(normalizeKey(key))) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redact(item, depth + 1);
  }
  return result;
}

/** 脱敏请求头，仅用于日志与调试。 */
export function redactHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key] = SENSITIVE_KEYS.has(normalizeKey(key)) ? REDACTED : redactText(value);
  }
  return result;
}

/** 展示用密钥掩码：只保留安全前缀。 */
export function maskSecret(secret: string | null | undefined, visible = 6): string {
  if (!secret) return "";
  if (secret.length <= visible) return "***";
  return `${secret.slice(0, visible)}***`;
}

/** 判断字符串中是否疑似包含密钥，用于提交前检查。 */
export function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

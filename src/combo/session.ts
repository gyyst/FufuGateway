import type { UnifiedRequest } from "../ir";

const SESSION_HEADERS = ["x-fufu-session-id", "x-session-id"] as const;

function isValidSession(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && !/[\r\n\0]/.test(trimmed);
}

function firstUserText(request: UnifiedRequest): string | undefined {
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    if (text !== "") return text;
  }
  return undefined;
}

/**
 * 统一的会话标识提取策略。
 *
 * 顺序：网关会话头 → 协议元数据 → prompt cache key → 用户标识 →
 * （显式开启时）首条 user 消息哈希。禁止只依赖某一个协议字段。
 */
export async function extractSessionId(
  request: UnifiedRequest,
  headers: Headers,
  allowFirstMessageHash: boolean,
): Promise<string | undefined> {
  for (const name of SESSION_HEADERS) {
    const value = headers.get(name) ?? undefined;
    if (isValidSession(value)) return value.trim();
  }
  const metadata = request.metadata;
  for (const candidate of [metadata.sessionId, metadata.promptCacheKey, metadata.userId]) {
    if (isValidSession(candidate)) return candidate.trim();
  }
  if (allowFirstMessageHash) {
    const text = firstUserText(request);
    if (text !== undefined) return await hashSession(`first-message:${text}`);
  }
  return undefined;
}

export async function hashSession(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

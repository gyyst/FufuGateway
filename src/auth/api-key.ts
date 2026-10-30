import type { ProtocolId } from "../ir/common";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBase64Url(bytes: Uint8Array): string {
  let result = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += BASE64URL.charAt((buffer >> bits) & 0x3f);
    }
  }
  if (bits > 0) {
    result += BASE64URL.charAt((buffer << (6 - bits)) & 0x3f);
  }
  return result;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** 下游 API Key：`fufu_sk_` + 32 字节随机值（base64url）。 */
export async function generateApiKey(pepper: string): Promise<{
  plaintext: string;
  prefix: string;
  hash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = `fufu_sk_${encodeBase64Url(bytes)}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: await hashApiKey(pepper, plaintext),
  };
}

/** 高熵 Key 使用带 pepper 的 SHA-256 即可安全存储。 */
export async function hashApiKey(pepper: string, apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(`${pepper}:${apiKey}`);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export function parseBearer(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function plausible(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 512) return undefined;
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * 按下游协议提取 API Key。
 * 支持 Authorization、x-api-key、x-goog-api-key 与 Gemini 的 ?key=。
 */
export function extractInferenceCredential(
  headers: Headers,
  url: URL,
  protocol: ProtocolId,
): string | undefined {
  const authorization = plausible(parseBearer(headers.get("authorization")));
  const xApiKey = plausible(headers.get("x-api-key") ?? undefined);
  const googleKey = plausible(headers.get("x-goog-api-key") ?? undefined);
  const queryKey = plausible(url.searchParams.get("key") ?? undefined);

  if (protocol === "anthropic") {
    return xApiKey ?? authorization;
  }
  if (protocol === "gemini") {
    return googleKey ?? queryKey ?? authorization ?? xApiKey;
  }
  return authorization ?? xApiKey;
}

export function protocolForPath(path: string): ProtocolId {
  if (path.startsWith("/v1/messages")) return "anthropic";
  if (path.startsWith("/v1beta/")) return "gemini";
  if (path.startsWith("/v1/responses")) return "openai-responses";
  return "openai-chat";
}

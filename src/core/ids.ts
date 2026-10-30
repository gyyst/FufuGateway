/** 请求 ID、Trace ID 与通用标识生成。 */

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: number, length: number): string {
  let remaining = Math.max(0, Math.floor(value));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out = ULID_CHARS.charAt(remaining % 32) + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function randomBase32(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += ULID_CHARS.charAt(byte % 32);
  }
  return out;
}

/** 时间有序的 26 字符 ULID。 */
export function ulid(): string {
  return encodeBase32(Date.now(), 10) + randomBase32(16);
}

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function newRequestId(): string {
  return newId("req");
}

export function newTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function newSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** 从 W3C traceparent 头提取 trace id；非法或全零返回 undefined。 */
export function parseTraceparent(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const match = TRACEPARENT_PATTERN.exec(header.trim().toLowerCase());
  if (!match) return undefined;
  const traceId = match[1];
  if (!traceId || /^0+$/.test(traceId)) return undefined;
  return traceId;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** 只接受格式安全的客户端 request id，避免注入日志或响应头。 */
export function sanitizeRequestId(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const value = header.trim();
  return REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

/** 常量时间字符串比较，用于令牌校验。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

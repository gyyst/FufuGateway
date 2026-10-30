/** 与协议无关的 JSON 读取工具，避免在各处写不安全的类型断言。 */

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function getRecord(value: unknown, key: string): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return isRecord(found) ? found : undefined;
}

export function getArray(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return Array.isArray(found) ? found : undefined;
}

export function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  return asString(value[key]);
}

export function getNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  return asNumber(value[key]);
}

export function getBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  return asBoolean(value[key]);
}

/** 解析 JSON 文本；调用方负责把异常转换为 GatewayError。 */
export function parseJsonText(text: string): unknown {
  if (text.trim() === "") {
    throw new SyntaxError("Empty JSON body");
  }
  return JSON.parse(text) as unknown;
}

export function parseJsonObject(text: string): JsonObject | undefined {
  const value = parseJsonText(text);
  return isRecord(value) ? value : undefined;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

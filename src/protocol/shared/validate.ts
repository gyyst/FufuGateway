import { GatewayError } from "../../core/errors";
import { asBoolean, asNumber, asString, isRecord, type JsonObject } from "../../core/json";
import type { CacheControl } from "../../ir/common";

function invalid(path: string, expected: string): never {
  throw new GatewayError({
    code: "INVALID_REQUEST",
    message: `${path} ${expected}`,
  });
}

export function requireObject(value: unknown, path: string): JsonObject {
  if (!isRecord(value)) invalid(path, "must be an object");
  return value;
}

export function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  return value;
}

export function requireString(value: unknown, path: string): string {
  const parsed = asString(value);
  if (parsed === undefined || parsed.trim() === "") invalid(path, "must be a non-empty string");
  return parsed;
}

export function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = asString(value);
  if (parsed === undefined) invalid(path, "must be a string");
  return parsed;
}

export function optionalNumber(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = asNumber(value);
  if (parsed === undefined) invalid(path, "must be a number");
  if (options.min !== undefined && parsed < options.min) invalid(path, `must be >= ${options.min}`);
  if (options.max !== undefined && parsed > options.max) invalid(path, `must be <= ${options.max}`);
  return parsed;
}

export function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = asBoolean(value);
  if (parsed === undefined) invalid(path, "must be a boolean");
  return parsed;
}

export function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) invalid(path, "must be a string or string array");
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") invalid(path, "must contain only strings");
    result.push(item);
  }
  return result;
}

export interface ParsedToolArguments {
  arguments: JsonObject;
  rawArguments?: string;
}

/** 解析工具参数。非法 JSON 不会抛出，而是保留原文供同协议回放。 */
export function parseToolArguments(value: unknown): ParsedToolArguments {
  if (isRecord(value)) {
    return { arguments: value };
  }
  if (typeof value !== "string") {
    return { arguments: {} };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { arguments: {}, rawArguments: value };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      return { arguments: parsed, rawArguments: value };
    }
    return { arguments: {}, rawArguments: value };
  } catch {
    return { arguments: {}, rawArguments: value };
  }
}

export function stringifyToolArguments(argumentsValue: JsonObject, raw?: string): string {
  if (raw !== undefined) return raw;
  return JSON.stringify(argumentsValue);
}

/** 生成稳定的工具调用 ID（部分厂商不返回 ID）。 */
export function syntheticToolCallId(prefix: string, index: number): string {
  return `${prefix}_${index.toString(36)}`;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 解析 Anthropic 风格 cache_control；未知结构视为未设置。 */
export function parseCacheControl(value: unknown): CacheControl | undefined {
  if (!isRecord(value)) return undefined;
  const type = asString(value["type"]);
  if (type !== "ephemeral" && type !== "persistent") return undefined;
  const ttl = asString(value["ttl"]);
  return ttl === undefined ? { type } : { type, ttl };
}

export function serializeCacheControl(control: CacheControl | undefined): JsonObject | undefined {
  if (!control) return undefined;
  return { type: control.type, ...(control.ttl === undefined ? {} : { ttl: control.ttl }) };
}

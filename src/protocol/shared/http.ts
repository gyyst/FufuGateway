import type { JsonObject } from "../../core/json";
import { isRecord, stringifyJson } from "../../core/json";
import type { UnifiedImageSource } from "../../ir/content";

export function jsonHttpResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): { status: number; headers: Record<string, string>; body: string } {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
    body: stringifyJson(body),
  };
}

/** 深拷贝 JSON 对象，用于同协议直通路径，避免修改原始请求体。 */
export function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

const DATA_URL_PATTERN = /^data:([A-Za-z0-9.+/-]+)?(;base64)?,([\s\S]*)$/;

export function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = DATA_URL_PATTERN.exec(url);
  if (!match) return undefined;
  const mediaType = match[1] ?? "application/octet-stream";
  const isBase64 = match[2] === ";base64";
  const data = match[3] ?? "";
  if (!isBase64) return undefined;
  return { mediaType, data };
}

export function buildDataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

/** 将 OpenAI 风格 image_url 转换为 IR 图片来源。 */
export function imageSourceFromUrl(url: string): UnifiedImageSource {
  const dataUrl = parseDataUrl(url);
  if (dataUrl) {
    return { kind: "base64", mediaType: dataUrl.mediaType, data: dataUrl.data };
  }
  return { kind: "url", url };
}

export function imageSourceToUrl(source: UnifiedImageSource): string | undefined {
  if (source.kind === "base64") return buildDataUrl(source.mediaType, source.data);
  if (source.kind === "url") return source.url;
  return undefined;
}

/** 收集未映射字段，仅在 PASSTHROUGH 策略下可能被使用。 */
export function pickExtensions(body: JsonObject, knownKeys: readonly string[]): JsonObject {
  const known = new Set(knownKeys);
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (!known.has(key)) result[key] = value;
  }
  return result;
}

export function isObjectArray(value: unknown): value is JsonObject[] {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

import type { CacheControl } from "./common";
import type { JsonObject } from "../core/json";

/** 图片输入来源。禁止让客户端通过 URL 让网关自行抓取内网资源。 */
export type UnifiedImageSource =
  | { kind: "base64"; mediaType: string; data: string }
  | { kind: "url"; url: string }
  | { kind: "file"; fileId: string; mediaType?: string };

export interface UnifiedTextPart {
  type: "text";
  text: string;
  cacheControl?: CacheControl;
}

export interface UnifiedImagePart {
  type: "image";
  source: UnifiedImageSource;
  detail?: "auto" | "low" | "high";
  cacheControl?: CacheControl;
}

export interface UnifiedToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  /** 已解析的参数对象；解析失败时为空对象，并保留 rawArguments。 */
  arguments: JsonObject;
  rawArguments?: string;
  /** 部分厂商（Gemini）的 thought signature。 */
  signature?: string;
}

export interface UnifiedToolResultPart {
  type: "tool_result";
  toolCallId: string;
  content: UnifiedContentPart[];
  isError?: boolean;
  /** Gemini functionResponse 的结构化对象。 */
  structured?: unknown;
}

export interface UnifiedThinkingPart {
  type: "thinking";
  text: string;
  signature?: string;
  redacted?: boolean;
  redactedData?: string;
}

export interface UnifiedRefusalPart {
  type: "refusal";
  text: string;
}

export type UnifiedContentPart =
  | UnifiedTextPart
  | UnifiedImagePart
  | UnifiedToolCallPart
  | UnifiedToolResultPart
  | UnifiedThinkingPart
  | UnifiedRefusalPart;

export function textPart(text: string): UnifiedTextPart {
  return { type: "text", text };
}

/** 拼接内容块中的纯文本，用于不支持富内容的协议降级。 */
export function contentToText(content: readonly UnifiedContentPart[]): string {
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === "text") chunks.push(part.text);
    else if (part.type === "thinking") chunks.push(part.text);
    else if (part.type === "refusal") chunks.push(part.text);
    else if (part.type === "tool_result") chunks.push(contentToText(part.content));
    else if (part.type === "tool_call") chunks.push(JSON.stringify(part.arguments));
  }
  return chunks.join("");
}

export function hasImagePart(content: readonly UnifiedContentPart[]): boolean {
  return content.some((part) => part.type === "image");
}

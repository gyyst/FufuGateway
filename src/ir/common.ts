import type { JsonObject } from "../core/json";

/** 网关支持的协议标识。OpenAI Chat 与 Responses 是两个独立协议。 */
export type ProtocolId = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

export const PROTOCOL_IDS: readonly ProtocolId[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];

export function isProtocolId(value: string): value is ProtocolId {
  return (PROTOCOL_IDS as readonly string[]).includes(value);
}

export type JsonSchema = JsonObject;

export interface CacheControl {
  type: "ephemeral" | "persistent";
  ttl?: string;
}

export type Modality = "text" | "image" | "audio" | "video" | "file";

export const PROTOCOL_DISPLAY_NAMES: Record<ProtocolId, string> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
  gemini: "Google Gemini",
};

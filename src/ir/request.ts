import type { JsonObject } from "../core/json";
import type { CacheControl, JsonSchema, Modality, ProtocolId } from "./common";
import type { UnifiedContentPart } from "./content";

export type UnifiedToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; name: string };

export interface UnifiedTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  strict?: boolean;
  cacheControl?: CacheControl;
}

export type UnifiedResponseFormat =
  | { type: "text" }
  | { type: "json_object"; schema?: JsonSchema }
  | {
      type: "json_schema";
      name: string;
      description?: string;
      schema: JsonSchema;
      strict?: boolean;
    };

export interface UnifiedReasoningConfig {
  effort?: "minimal" | "low" | "medium" | "high";
  budgetTokens?: number;
  includeInOutput?: boolean;
}

export interface UnifiedRequestMetadata {
  userId?: string;
  sessionId?: string;
  promptCacheKey?: string;
}

/** 未映射到 IR 的厂商扩展参数，仅在 PASSTHROUGH 策略下保留。 */
export interface ProtocolExtensions {
  source: ProtocolId;
  values: JsonObject;
}

export interface UnifiedSystemInstruction {
  role: "system" | "developer";
  content: UnifiedContentPart[];
}

export interface UnifiedMessage {
  role: "user" | "assistant" | "tool";
  content: UnifiedContentPart[];
}

export interface UnifiedRequest {
  model: string;
  system: UnifiedSystemInstruction[];
  messages: UnifiedMessage[];
  tools: UnifiedTool[];
  toolChoice: UnifiedToolChoice;
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stopSequences: string[];
  stream: boolean;
  responseFormat?: UnifiedResponseFormat;
  reasoning?: UnifiedReasoningConfig;
  metadata: UnifiedRequestMetadata;
  extensions: ProtocolExtensions;
  /** 原始请求体（已解析为对象），用于同协议直通优化。 */
  raw: { protocol: ProtocolId; body: JsonObject };
}

export interface UnifiedRequestDraft extends Partial<Omit<UnifiedRequest, "raw" | "extensions">> {
  model: string;
  extensions?: ProtocolExtensions;
  raw?: { protocol: ProtocolId; body: JsonObject };
  /** 源协议，用于填充 extensions.source 与 raw。 */
  sourceProtocol: ProtocolId;
  sourceBody: JsonObject;
}

/** 用默认值补全请求，避免各适配器重复填充。 */
export function finalizeRequest(draft: UnifiedRequestDraft): UnifiedRequest {
  return {
    model: draft.model,
    system: draft.system ?? [],
    messages: draft.messages ?? [],
    tools: draft.tools ?? [],
    toolChoice: draft.toolChoice ?? { type: "auto" },
    parallelToolCalls: draft.parallelToolCalls,
    maxOutputTokens: draft.maxOutputTokens,
    temperature: draft.temperature,
    topP: draft.topP,
    topK: draft.topK,
    frequencyPenalty: draft.frequencyPenalty,
    presencePenalty: draft.presencePenalty,
    seed: draft.seed,
    stopSequences: draft.stopSequences ?? [],
    stream: draft.stream ?? false,
    responseFormat: draft.responseFormat,
    reasoning: draft.reasoning,
    metadata: draft.metadata ?? {},
    extensions: draft.extensions ?? { source: draft.sourceProtocol, values: {} },
    raw: draft.raw ?? { protocol: draft.sourceProtocol, body: draft.sourceBody },
  };
}

export type OutputModality = "text" | "image" | "audio" | "embedding";

export interface ModelCapabilities {
  inputModalities: Modality[];
  outputModalities: OutputModality[];
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStream: boolean;
  supportsTools: boolean;
  supportsParallelTools: boolean;
  supportsJsonSchema: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsPromptCache: boolean;
}

export function defaultCapabilities(partial: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsStream: true,
    supportsTools: false,
    supportsParallelTools: false,
    supportsJsonSchema: false,
    supportsReasoning: false,
    supportsVision: false,
    supportsAudio: false,
    supportsVideo: false,
    supportsPromptCache: false,
    ...partial,
  };
}

export function capabilitiesFromFlags(flags: {
  vision?: boolean;
  tools?: boolean;
  parallelTools?: boolean;
  jsonSchema?: boolean;
  reasoning?: boolean;
  promptCache?: boolean;
  audio?: boolean;
  stream?: boolean;
}): ModelCapabilities {
  return defaultCapabilities({
    inputModalities: flags.vision ? ["text", "image"] : ["text"],
    outputModalities: ["text"],
    supportsStream: flags.stream ?? true,
    supportsTools: flags.tools ?? false,
    supportsParallelTools: flags.parallelTools ?? false,
    supportsJsonSchema: flags.jsonSchema ?? false,
    supportsReasoning: flags.reasoning ?? false,
    supportsVision: flags.vision ?? false,
    supportsAudio: flags.audio ?? false,
    supportsPromptCache: flags.promptCache ?? false,
  });
}

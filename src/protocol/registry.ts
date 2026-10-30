import { GatewayError } from "../core/errors";
import type { ProtocolId } from "../ir/common";
import type { ProtocolAdapter } from "./types";
import { anthropicProtocol } from "./anthropic";
import { geminiProtocol } from "./gemini";
import { openAIChatProtocol } from "./openai-chat";
import { openAIResponsesProtocol } from "./openai-responses";

const DEFAULT_ADAPTERS: readonly ProtocolAdapter[] = [
  openAIChatProtocol,
  openAIResponsesProtocol,
  anthropicProtocol,
  geminiProtocol,
];

/** 协议适配器注册表。新增协议只需实现 ProtocolAdapter 并注册。 */
export class ProtocolRegistry {
  private readonly adapters = new Map<ProtocolId, ProtocolAdapter>();

  constructor(adapters: readonly ProtocolAdapter[] = DEFAULT_ADAPTERS) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) {
        throw new Error(`Duplicate protocol adapter for ${adapter.id}`);
      }
      this.adapters.set(adapter.id, adapter);
    }
  }

  get(id: ProtocolId): ProtocolAdapter {
    const adapter = this.adapters.get(id);
    if (adapter === undefined) {
      throw new GatewayError({
        code: "PROTOCOL_CONVERSION_ERROR",
        message: `No adapter registered for protocol "${id}"`,
        details: { protocol: id },
      });
    }
    return adapter;
  }

  has(id: ProtocolId): boolean {
    return this.adapters.has(id);
  }

  list(): ProtocolAdapter[] {
    return [...this.adapters.values()];
  }
}

export const protocolRegistry = new ProtocolRegistry();

/** 协议能力矩阵：声明源能力在目标协议中的支持级别。 */
export type CompatibilityLevel = "native" | "emulated" | "unsupported";

export interface CapabilityMatrixEntry {
  feature: string;
  support: Record<ProtocolId, CompatibilityLevel>;
}

export const CAPABILITY_MATRIX: readonly CapabilityMatrixEntry[] = [
  {
    feature: "thinking",
    support: {
      "openai-chat": "emulated",
      "openai-responses": "emulated",
      anthropic: "native",
      gemini: "native",
    },
  },
  {
    feature: "json_schema",
    support: {
      "openai-chat": "native",
      "openai-responses": "native",
      anthropic: "unsupported",
      gemini: "native",
    },
  },
  {
    feature: "parallel_tool_calls",
    support: {
      "openai-chat": "native",
      "openai-responses": "native",
      anthropic: "native",
      gemini: "native",
    },
  },
  {
    feature: "prompt_cache_control",
    support: {
      "openai-chat": "unsupported",
      "openai-responses": "unsupported",
      anthropic: "native",
      gemini: "unsupported",
    },
  },
  {
    feature: "safety_settings",
    support: {
      "openai-chat": "unsupported",
      "openai-responses": "unsupported",
      anthropic: "unsupported",
      gemini: "native",
    },
  },
  {
    feature: "reasoning_budget_tokens",
    support: {
      "openai-chat": "unsupported",
      "openai-responses": "unsupported",
      anthropic: "native",
      gemini: "native",
    },
  },
];

export function lookupCompatibility(feature: string, target: ProtocolId): CompatibilityLevel | undefined {
  const entry = CAPABILITY_MATRIX.find((item) => item.feature === feature);
  return entry?.support[target];
}

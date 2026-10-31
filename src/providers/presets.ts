import type { ProviderType } from "../config/types";
import type { ProtocolId } from "../ir/common";

/**
 * Provider 预设只用于管理台表单预填。
 * 不包含密钥，不自动创建账户，也不推断模型能力。
 */
export interface ProviderPreset {
  id: string;
  label: string;
  suggestedName: string;
  description: string;
  type: ProviderType;
  protocol: ProtocolId;
  baseUrl: string;
  /** 直接写入 provider.extraConfig 的字段，例如 CUSTOM 的 authMode。 */
  extraConfig?: Record<string, unknown>;
  docsUrl?: string;
  notes?: string;
}

const PRESETS: readonly ProviderPreset[] = [
  {
    id: "volcengine-ark-openai",
    label: "火山方舟（OpenAI 兼容）",
    suggestedName: "volcengine-ark",
    description: "火山引擎方舟数据面 API，兼容 OpenAI Chat Completions。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    docsUrl: "https://ark.volcengine.com/region:cn-beijing/docs/base-url-and-authentication",
    notes: "模型 ID 使用方舟模型 ID 或推理接入点 ID；Base URL 不要漏掉 /api/v3。",
  },
  {
    id: "volcengine-ark-anthropic",
    label: "火山方舟（Anthropic 兼容）",
    suggestedName: "volcengine-ark-anthropic",
    description: "火山方舟的 Anthropic Messages 兼容入口，适合 Claude Code 等客户端。",
    type: "CUSTOM",
    protocol: "anthropic",
    baseUrl: "https://ark.cn-beijing.volces.com/api/compatible",
    extraConfig: { authMode: "bearer" },
    docsUrl: "https://docs.volcengine.com/docs/ark/integrate-third-party-tools?lang=zh",
    notes: "Anthropic 兼容 Base URL 是 /api/compatible，与 OpenAI 兼容的 /api/v3 不同。",
  },
  {
    id: "huawei-maas-openai",
    label: "华为云 MaaS（OpenAI 兼容）",
    suggestedName: "huawei-maas",
    description: "华为云 MaaS 的 OpenAI 兼容接口。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.modelarts-maas.com/openai/v1",
    docsUrl: "https://support.huaweicloud.com/model-call-maas/model-call-021.html",
    notes: "OpenAI 兼容接口受区域限制，Base URL 可能因区域不同；请以控制台和厂商文档为准。",
  },
  {
    id: "openai",
    label: "OpenAI",
    suggestedName: "openai",
    description: "OpenAI Chat Completions API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    suggestedName: "anthropic",
    description: "Anthropic Messages API。",
    type: "ANTHROPIC",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    docsUrl: "https://docs.anthropic.com/en/api/messages",
  },
  {
    id: "google-gemini",
    label: "Google Gemini",
    suggestedName: "google-gemini",
    description: "Google Gemini generateContent API。",
    type: "GOOGLE_GEMINI",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    docsUrl: "https://ai.google.dev/api/generate-content",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    suggestedName: "deepseek",
    description: "DeepSeek OpenAI 兼容 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    docsUrl: "https://api-docs.deepseek.com/",
  },
  {
    id: "moonshot-kimi",
    label: "Moonshot Kimi",
    suggestedName: "moonshot",
    description: "月之暗面 Kimi OpenAI 兼容 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
    docsUrl: "https://platform.moonshot.cn/docs/",
  },
  {
    id: "zhipu-glm",
    label: "智谱 GLM",
    suggestedName: "zhipu",
    description: "智谱开放平台 OpenAI 兼容 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docsUrl: "https://docs.bigmodel.cn/",
  },
  {
    id: "qwen-dashscope",
    label: "阿里云百炼 / Qwen",
    suggestedName: "qwen",
    description: "阿里云百炼 OpenAI 兼容模式。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docsUrl: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    suggestedName: "openrouter",
    description: "OpenRouter 聚合 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    docsUrl: "https://openrouter.ai/docs",
  },
  {
    id: "groq",
    label: "Groq",
    suggestedName: "groq",
    description: "Groq OpenAI 兼容 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.groq.com/openai/v1",
    docsUrl: "https://console.groq.com/docs/openai",
  },
  {
    id: "mistral",
    label: "Mistral",
    suggestedName: "mistral",
    description: "Mistral OpenAI 兼容 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.mistral.ai/v1",
    docsUrl: "https://docs.mistral.ai/api/",
  },
  {
    id: "xai",
    label: "xAI",
    suggestedName: "xai",
    description: "xAI OpenAI 兼容 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    docsUrl: "https://docs.x.ai/docs/overview",
  },
  {
    id: "together",
    label: "Together AI",
    suggestedName: "together",
    description: "Together OpenAI 兼容 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.together.xyz/v1",
    docsUrl: "https://docs.together.ai/docs/openai-api-compatibility",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    suggestedName: "fireworks",
    description: "Fireworks OpenAI 兼容推理 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    docsUrl: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    suggestedName: "siliconflow",
    description: "硅基流动 OpenAI 兼容 API。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.siliconflow.cn/v1",
    docsUrl: "https://docs.siliconflow.cn/",
  },
  {
    id: "custom-openai",
    label: "自定义 OpenAI 兼容端点",
    suggestedName: "custom-openai",
    description: "任意兼容 OpenAI Chat Completions 的上游。",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "",
    notes: "填写完整 Base URL；若上游路径不是 /v1，请在扩展配置中设置 endpointPath 或使用带版本段的 Base URL。",
  },
  {
    id: "custom-anthropic",
    label: "自定义 Anthropic 兼容端点",
    suggestedName: "custom-anthropic",
    description: "任意兼容 Anthropic Messages 的上游。",
    type: "ANTHROPIC",
    protocol: "anthropic",
    baseUrl: "",
    notes: "填写完整 Base URL；网关默认追加 /v1/messages。",
  },
];

export function listProviderPresets(): readonly ProviderPreset[] {
  return PRESETS;
}

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

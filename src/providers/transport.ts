import { GatewayError } from "../core/errors";
import { asBoolean, asNumber, asString, getArray, isRecord } from "../core/json";
import type { Modality, ProtocolId } from "../ir/common";
import type { OutputModality } from "../ir/request";
import type { ProviderRecord } from "../config/types";

export interface EndpointOptions {
  stream: boolean;
  upstreamModel: string;
}

export interface AuthSpec {
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface RemoteModelPricing {
  inputPrice?: number;
  outputPrice?: number;
  cachedInputPrice?: number;
  reasoningPrice?: number;
}

export interface RemoteModel {
  id: string;
  displayName?: string;
  createdAt?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: Modality[];
  outputModalities?: OutputModality[];
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  pricing?: RemoteModelPricing;
}

export interface ProviderTransport {
  readonly type: string;
  supports(protocol: ProtocolId): boolean;
  buildEndpoint(provider: ProviderRecord, protocol: ProtocolId, options: EndpointOptions): URL;
  buildModelsEndpoint(provider: ProviderRecord, protocol: ProtocolId): URL;
  buildAuth(provider: ProviderRecord, apiKey: string): AuthSpec;
  parseModels(payload: unknown): RemoteModel[];
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function joinPath(base: URL, path: string): URL {
  const url = new URL(base.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${path.replace(/^\/+/, "")}`;
  return url;
}

export function hasVersionSuffix(path: string): boolean {
  return /\/v\d+(?:beta\d*)?$/i.test(path);
}

export function ensureVersionedPath(base: URL, suffix: string): URL {
  const url = new URL(base.toString());
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(suffix)) return url;
  if (path === "") url.pathname = `/v1${suffix}`;
  else if (hasVersionSuffix(path)) url.pathname = `${path}${suffix}`;
  else url.pathname = `${path}/v1${suffix}`;
  return url;
}

function endpointOverride(provider: ProviderRecord, options: EndpointOptions): string | undefined {
  const override = asString(provider.extraConfig["endpointPath"]);
  if (override === undefined || override.trim() === "") return undefined;
  return override
    .replaceAll("{model}", encodeURIComponent(options.upstreamModel))
    .replaceAll("{action}", options.stream ? "streamGenerateContent" : "generateContent");
}

/** 按协议生成上游请求地址。所有地址来自管理员配置的 baseUrl。 */
export function buildProtocolEndpoint(
  provider: ProviderRecord,
  protocol: ProtocolId,
  options: EndpointOptions,
): URL {
  const override = endpointOverride(provider, options);
  if (override !== undefined) {
    const url = joinPath(new URL(provider.baseUrl), override);
    if (protocol === "gemini" && options.stream) url.searchParams.set("alt", "sse");
    return url;
  }

  const base = new URL(provider.baseUrl);
  switch (protocol) {
    case "openai-chat": {
      const url = ensureVersionedPath(base, "/chat/completions");
      return url;
    }
    case "openai-responses": {
      return ensureVersionedPath(base, "/responses");
    }
    case "anthropic": {
      return ensureVersionedPath(base, "/messages");
    }
    case "gemini": {
      const path = base.pathname.replace(/\/+$/, "");
      let url: URL;
      if (path.includes(":generateContent") || path.includes(":streamGenerateContent")) {
        url = new URL(base.toString());
      } else {
        url = new URL(base.toString());
        const prefix = path === "" ? "/v1beta" : path.endsWith("/v1beta") ? path : `${path}/v1beta`;
        url.pathname = `${prefix}/models/${encodeURIComponent(options.upstreamModel)}${
          options.stream ? ":streamGenerateContent" : ":generateContent"
        }`;
      }
      if (options.stream) url.searchParams.set("alt", "sse");
      return url;
    }
  }
}

export function buildProtocolModelsEndpoint(provider: ProviderRecord, protocol: ProtocolId): URL {
  const base = new URL(provider.baseUrl);
  if (protocol === "gemini") {
    const path = base.pathname.replace(/\/+$/, "");
    const url = new URL(base.toString());
    if (!path.endsWith("/models")) {
      url.pathname = path === "" ? "/v1beta/models" : path.endsWith("/v1beta") ? `${path}/models` : `${path}/v1beta/models`;
    }
    url.searchParams.set("pageSize", "1000");
    return url;
  }
  return ensureVersionedPath(base, "/models");
}

function assertHeaderName(name: string): string {
  if (!HEADER_NAME.test(name)) {
    throw new GatewayError({ code: "CONFIG_INVALID", message: `Invalid authentication header name "${name}"` });
  }
  return name.toLowerCase();
}

function customAuthMode(provider: ProviderRecord): string {
  return asString(provider.extraConfig["authMode"]) ?? "default";
}

export function buildProviderAuth(provider: ProviderRecord, apiKey: string): AuthSpec {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  const mode = provider.type === "CUSTOM" ? customAuthMode(provider) : "default";

  if (mode === "default") {
    if (provider.type === "ANTHROPIC" || provider.protocol === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] =
        asString(provider.extraConfig["anthropicVersion"]) ?? "2023-06-01";
    } else if (provider.type === "GOOGLE_GEMINI" || provider.protocol === "gemini") {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers["authorization"] = `Bearer ${apiKey}`;
    }
    return { headers, query };
  }

  if (mode === "bearer") {
    headers["authorization"] = `Bearer ${apiKey}`;
  } else if (mode === "x-api-key") {
    headers["x-api-key"] = apiKey;
  } else if (mode === "x-goog-api-key") {
    headers["x-goog-api-key"] = apiKey;
  } else if (mode === "header") {
    const name = assertHeaderName(asString(provider.extraConfig["authHeader"]) ?? "x-api-key");
    headers[name] = apiKey;
  } else if (mode === "query") {
    const name = asString(provider.extraConfig["authQueryParam"]) ?? "key";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      throw new GatewayError({ code: "CONFIG_INVALID", message: "Invalid authentication query parameter name" });
    }
    query[name] = apiKey;
  } else if (mode === "none") {
    // 明确配置为无认证的上游。
  } else {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Unsupported authMode "${mode}" for provider "${provider.name}"`,
    });
  }
  if (
    (provider.type === "ANTHROPIC" || provider.protocol === "anthropic") &&
    headers["anthropic-version"] === undefined
  ) {
    headers["anthropic-version"] =
      asString(provider.extraConfig["anthropicVersion"]) ?? "2023-06-01";
  }
  return { headers, query };
}

const INPUT_MODALITIES = new Set<Modality>(["text", "image", "audio", "video", "file"]);
const OUTPUT_MODALITIES = new Set<OutputModality>(["text", "image", "audio", "embedding"]);

function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(record: Record<string, unknown>, paths: readonly string[]): number | undefined {
  for (const path of paths) {
    const value = numberValue(readPath(record, path));
    if (value !== undefined && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

function firstBoolean(
  record: Record<string, unknown>,
  paths: readonly string[],
): boolean | undefined {
  for (const path of paths) {
    const value = asBoolean(readPath(record, path));
    if (value !== undefined) return value;
  }
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  const raw =
    typeof value === "string"
      ? value.split(/[,+]/)
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : undefined;
  if (raw === undefined) return undefined;
  const result = raw
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  return result.length === 0 ? undefined : result;
}

function mapInputModalities(values: string[] | undefined): Modality[] | undefined {
  if (values === undefined) return undefined;
  const result: Modality[] = [];
  for (const value of values) {
    const normalized: Modality | undefined =
      value === "pdf" || value === "document"
        ? "file"
        : INPUT_MODALITIES.has(value as Modality)
          ? (value as Modality)
          : undefined;
    if (normalized !== undefined && !result.includes(normalized)) result.push(normalized);
  }
  return result.length === 0 ? undefined : result;
}

function mapOutputModalities(values: string[] | undefined): OutputModality[] | undefined {
  if (values === undefined) return undefined;
  const result: OutputModality[] = [];
  for (const value of values) {
    if (OUTPUT_MODALITIES.has(value as OutputModality) && !result.includes(value as OutputModality)) {
      result.push(value as OutputModality);
    }
  }
  return result.length === 0 ? undefined : result;
}

interface ParsedModelMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: Modality[];
  outputModalities?: OutputModality[];
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  pricing?: RemoteModelPricing;
}

const CONTEXT_PATHS = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_model_len",
  "input_token_limit",
  "inputTokenLimit",
  "top_provider.context_length",
] as const;

const MAX_OUTPUT_PATHS = [
  "max_output_tokens",
  "max_completion_tokens",
  "output_token_limit",
  "outputTokenLimit",
  "top_provider.max_completion_tokens",
] as const;

const TOOL_PATHS = ["supports_tools", "tool_call", "supportsTools"] as const;
const JSON_SCHEMA_PATHS = ["structured_output", "supports_json_schema", "supportsJsonSchema"] as const;
const REASONING_PATHS = ["reasoning", "supports_reasoning", "supportsReasoning"] as const;
const VISION_PATHS = ["supports_vision", "vision", "supportsVision"] as const;

/** 解析 OpenAI 兼容端点常见的模型元数据扩展；未知或非法字段直接忽略。 */
function parseModelMetadata(entry: Record<string, unknown>): ParsedModelMetadata {
  const architecture = isRecord(entry["architecture"]) ? entry["architecture"] : undefined;
  const modalities = isRecord(entry["modalities"]) ? entry["modalities"] : undefined;
  const supportedParameters = stringList(entry["supported_parameters"]) ?? [];
  const architectureMode = asString(architecture?.["modality"]);
  const modeParts = architectureMode?.includes("->") === true
    ? architectureMode.split("->").map((part) => part.trim())
    : undefined;

  const inputValues =
    stringList(architecture?.["input_modalities"]) ??
    stringList(entry["input_modalities"]) ??
    stringList(modalities?.["input"]) ??
    stringList(modeParts?.[0]);
  const outputValues =
    stringList(architecture?.["output_modalities"]) ??
    stringList(entry["output_modalities"]) ??
    stringList(modalities?.["output"]) ??
    stringList(modeParts?.[1]);

  const inputModalities = mapInputModalities(inputValues);
  const outputModalities = mapOutputModalities(outputValues);
  const supportsTools =
    firstBoolean(entry, TOOL_PATHS) ??
    (supportedParameters.includes("tools") || supportedParameters.includes("tool_choice")
      ? true
      : undefined);
  const supportsJsonSchema =
    firstBoolean(entry, JSON_SCHEMA_PATHS) ??
    (supportedParameters.includes("structured_outputs") ? true : undefined);
  const supportsReasoning =
    firstBoolean(entry, REASONING_PATHS) ?? (supportedParameters.includes("reasoning") ? true : undefined);
  const supportsVision =
    firstBoolean(entry, VISION_PATHS) ??
    (inputModalities?.includes("image") === true ? true : undefined);

  const pricingRecord = isRecord(entry["pricing"]) ? entry["pricing"] : undefined;
  const perMillion = (value: unknown): number | undefined => {
    const parsed = numberValue(value);
    if (parsed === undefined || parsed < 0) return undefined;
    return parsed * 1_000_000;
  };
  const inputPrice = perMillion(pricingRecord?.["prompt"]);
  const outputPrice = perMillion(pricingRecord?.["completion"]);
  const cachedInputPrice = perMillion(pricingRecord?.["input_cache_read"]);
  const reasoningPrice = perMillion(pricingRecord?.["internal_reasoning"]);
  const pricing: RemoteModelPricing = {
    ...(inputPrice === undefined ? {} : { inputPrice }),
    ...(outputPrice === undefined ? {} : { outputPrice }),
    ...(cachedInputPrice === undefined ? {} : { cachedInputPrice }),
    ...(reasoningPrice === undefined ? {} : { reasoningPrice }),
  };

  const contextWindow = positiveInteger(entry, CONTEXT_PATHS);
  const maxOutputTokens = positiveInteger(entry, MAX_OUTPUT_PATHS);

  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(outputModalities === undefined ? {} : { outputModalities }),
    ...(supportsTools === undefined ? {} : { supportsTools }),
    ...(supportsJsonSchema === undefined ? {} : { supportsJsonSchema }),
    ...(supportsReasoning === undefined ? {} : { supportsReasoning }),
    ...(supportsVision === undefined ? {} : { supportsVision }),
    ...(Object.keys(pricing).length === 0 ? {} : { pricing }),
  };
}

function parseOpenAIModels(payload: unknown): RemoteModel[] {
  const data = getArray(payload, "data");
  if (!data) return [];
  const models: RemoteModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const id = asString(entry["id"]);
    if (!id) continue;
    const created = asNumber(entry["created"]);
    const displayName = asString(entry["display_name"]) ?? asString(entry["name"]);
    models.push({
      id,
      ...(created === undefined ? {} : { createdAt: created * 1000 }),
      ...(displayName === undefined ? {} : { displayName }),
      ...parseModelMetadata(entry),
    });
  }
  return models;
}

function parseAnthropicModels(payload: unknown): RemoteModel[] {
  const data = getArray(payload, "data");
  if (!data) return [];
  const models: RemoteModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const id = asString(entry["id"]);
    if (!id) continue;
    const displayName = asString(entry["display_name"]);
    const createdAt = asString(entry["created_at"]);
    const parsedTime = createdAt === undefined ? undefined : Date.parse(createdAt);
    models.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(parsedTime === undefined || Number.isNaN(parsedTime) ? {} : { createdAt: parsedTime }),
    });
  }
  return models;
}

function parseGeminiModels(payload: unknown): RemoteModel[] {
  const data = getArray(payload, "models");
  if (!data) return [];
  const models: RemoteModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const rawName = asString(entry["name"]);
    if (!rawName) continue;
    const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
    const displayName = asString(entry["displayName"]);
    models.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...parseModelMetadata(entry),
    });
  }
  return models;
}

function parseCustomModels(payload: unknown): RemoteModel[] {
  return isRecord(payload) && Array.isArray(payload["models"])
    ? parseGeminiModels(payload)
    : isRecord(payload) && Array.isArray(payload["data"])
      ? parseOpenAIModels(payload)
      : [];
}

/** 端点构造、认证与地址规则由协议决定，类型只负责支持哪些协议与如何解析模型列表。 */
class StandardTransport implements ProviderTransport {
  constructor(
    readonly type: string,
    private readonly protocols: readonly ProtocolId[] | null,
    private readonly parser: (payload: unknown) => RemoteModel[],
  ) {}

  supports(protocol: ProtocolId): boolean {
    return this.protocols === null || this.protocols.includes(protocol);
  }
  buildEndpoint(provider: ProviderRecord, protocol: ProtocolId, options: EndpointOptions): URL {
    return buildProtocolEndpoint(provider, protocol, options);
  }
  buildModelsEndpoint(provider: ProviderRecord, protocol: ProtocolId): URL {
    return buildProtocolModelsEndpoint(provider, protocol);
  }
  buildAuth(provider: ProviderRecord, apiKey: string): AuthSpec {
    return buildProviderAuth(provider, apiKey);
  }
  parseModels(payload: unknown): RemoteModel[] {
    return this.parser(payload);
  }
}

export class ProviderTransportRegistry {
  private readonly transports = new Map<string, ProviderTransport>();

  constructor(transports: readonly ProviderTransport[]) {
    for (const transport of transports) this.transports.set(transport.type, transport);
  }

  get(type: string): ProviderTransport {
    const transport = this.transports.get(type);
    if (!transport) {
      throw new GatewayError({ code: "CONFIG_INVALID", message: `No provider transport for type "${type}"` });
    }
    return transport;
  }
}

export const providerTransports = new ProviderTransportRegistry([
  new StandardTransport(
    "OPENAI_COMPATIBLE",
    ["openai-chat", "openai-responses"],
    parseOpenAIModels,
  ),
  new StandardTransport("ANTHROPIC", ["anthropic"], parseAnthropicModels),
  new StandardTransport("GOOGLE_GEMINI", ["gemini"], parseGeminiModels),
  new StandardTransport("CUSTOM", null, parseCustomModels),
]);

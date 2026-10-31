import { GatewayError } from "../core/errors";
import { asNumber, asString, getArray, isRecord } from "../core/json";
import type { ProtocolId } from "../ir/common";
import type { ProviderRecord } from "../config/types";

export interface EndpointOptions {
  stream: boolean;
  upstreamModel: string;
}

export interface AuthSpec {
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface RemoteModel {
  id: string;
  displayName?: string;
  createdAt?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
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

function parseOpenAIModels(payload: unknown): RemoteModel[] {
  const data = getArray(payload, "data");
  if (!data) return [];
  const models: RemoteModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const id = asString(entry["id"]);
    if (!id) continue;
    const created = asNumber(entry["created"]);
    models.push({
      id,
      ...(created === undefined ? {} : { createdAt: created * 1000 }),
      ...(asString(entry["display_name"]) === undefined ? {} : { displayName: asString(entry["display_name"]) }),
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
    const context = asNumber(entry["inputTokenLimit"]);
    const maxOutput = asNumber(entry["outputTokenLimit"]);
    models.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(context === undefined ? {} : { contextWindow: context }),
      ...(maxOutput === undefined ? {} : { maxOutputTokens: maxOutput }),
    });
  }
  return models;
}

export class OpenAITransport implements ProviderTransport {
  readonly type = "OPENAI_COMPATIBLE";
  supports(protocol: ProtocolId): boolean {
    return protocol === "openai-chat" || protocol === "openai-responses";
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
    return parseOpenAIModels(payload);
  }
}

export class AnthropicTransport implements ProviderTransport {
  readonly type = "ANTHROPIC";
  supports(protocol: ProtocolId): boolean {
    return protocol === "anthropic";
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
    return parseAnthropicModels(payload);
  }
}

export class GeminiTransport implements ProviderTransport {
  readonly type = "GOOGLE_GEMINI";
  supports(protocol: ProtocolId): boolean {
    return protocol === "gemini";
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
    return parseGeminiModels(payload);
  }
}

export class CustomTransport implements ProviderTransport {
  readonly type = "CUSTOM";
  supports(_protocol: ProtocolId): boolean {
    return true;
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
    return isRecord(payload) && Array.isArray(payload["models"])
      ? parseGeminiModels(payload)
      : isRecord(payload) && Array.isArray(payload["data"])
        ? parseOpenAIModels(payload)
        : [];
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
  new OpenAITransport(),
  new AnthropicTransport(),
  new GeminiTransport(),
  new CustomTransport(),
]);

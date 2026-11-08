import { GatewayError } from "../core/errors";
import { GATEWAY_VERSION } from "../core/version";
import type { CompatibilityIssue, CompatibilityPolicy, UnifiedRequest } from "../ir";
import type { ResolvedTarget } from "../combo/types";
import type { ProviderRecord } from "../config/types";
import { protocolRegistry } from "../protocol/registry";
import { providerTransports, type ProviderTransport, type RemoteModel } from "./transport";
import type { FetchLike } from "./types";

/** 取 Provider 类型对应的传输实现，并确认它支持当前协议。 */
function requireTransport(provider: ProviderRecord): ProviderTransport {
  const transport = providerTransports.get(provider.type);
  if (!transport.supports(provider.protocol)) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Provider type ${provider.type} cannot speak protocol ${provider.protocol}`,
    });
  }
  return transport;
}

export interface BuiltProviderRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  issues: CompatibilityIssue[];
}

export interface BuildProviderRequestArgs {
  provider: ProviderRecord;
  target: ResolvedTarget;
  apiKey: string;
  request: UnifiedRequest;
  policy: CompatibilityPolicy;
}

/** 将 IR 请求转换为上游 HTTP 请求（协议体 + 地址 + 认证）。 */
export function buildProviderRequest(args: BuildProviderRequestArgs): BuiltProviderRequest {
  const { provider, target, apiKey, request, policy } = args;
  const transport = requireTransport(provider);
  const protocol = protocolRegistry.get(provider.protocol);
  const issues: CompatibilityIssue[] = [];
  const body = protocol.buildUpstreamRequest(request, {
    upstreamModel: target.upstreamModelId,
    policy,
    capabilities: target.capabilities,
    issues,
    providerConfig: provider.extraConfig,
  });

  const url = transport.buildEndpoint(provider, provider.protocol, {
    stream: request.stream,
    upstreamModel: target.upstreamModelId,
  });
  const auth = transport.buildAuth(provider, apiKey);
  for (const [name, value] of Object.entries(auth.query)) {
    url.searchParams.set(name, value);
  }

  const headers: Record<string, string> = {
    ...provider.customHeaders,
    "content-type": "application/json",
    accept: request.stream ? "text/event-stream" : "application/json",
    "user-agent": `fufu-gateway/${GATEWAY_VERSION}`,
    ...auth.headers,
  };

  return {
    url: url.toString(),
    method: "POST",
    headers,
    body: JSON.stringify(body),
    issues,
  };
}

export interface FetchModelsArgs {
  provider: ProviderRecord;
  apiKey: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 拉取上游模型列表（用于管理端测试与同步）。 */
export async function fetchProviderModels(args: FetchModelsArgs): Promise<RemoteModel[]> {
  const { provider, apiKey, fetchImpl } = args;
  const transport = requireTransport(provider);
  const url = transport.buildModelsEndpoint(provider, provider.protocol);
  const auth = transport.buildAuth(provider, apiKey);
  for (const [name, value] of Object.entries(auth.query)) url.searchParams.set(name, value);

  const controller = new AbortController();
  const timeoutMs = args.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort(args.signal?.reason);
  args.signal?.addEventListener("abort", onAbort, { once: true });

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        ...provider.customHeaders,
        accept: "application/json",
        "user-agent": `fufu-gateway/${GATEWAY_VERSION}`,
        ...auth.headers,
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (args.signal?.aborted === true) {
      throw new GatewayError({ code: "REQUEST_CANCELLED", message: "Request cancelled", cause: error });
    }
    if (controller.signal.aborted) {
      throw new GatewayError({ code: "UPSTREAM_TIMEOUT", message: "Provider model list timed out", cause: error });
    }
    throw new GatewayError({ code: "UPSTREAM_ERROR", message: "Failed to reach provider", retriable: true, cause: error });
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new GatewayError({ code: "UPSTREAM_ERROR", message: "Upstream redirects are not allowed" });
  }
  if (!response.ok) {
    throw new GatewayError({
      code: "UPSTREAM_ERROR",
      message: `Provider returned HTTP ${response.status} while listing models`,
      retriable: response.status === 429 || response.status >= 500,
      details: { upstream_status: response.status },
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GatewayError({ code: "PROTOCOL_CONVERSION_ERROR", message: "Provider returned invalid JSON for model list" });
  }
  return transport.parseModels(payload);
}

import type { GatewayError } from "../core/errors";
import type { JsonObject } from "../core/json";
import type {
  CompatibilityIssue,
  CompatibilityPolicy,
  ModelCapabilities,
  ProtocolId,
  PublicModel,
  UnifiedError,
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamEvent,
} from "../ir";
import type { SseMessage } from "../stream/sse";

export interface ParseRequestContext {
  requestId?: string;
  /** Gemini 等从 URL 路径获取模型的协议使用。 */
  model?: string;
}

export interface BuildRequestContext {
  /** 目标上游真实模型 ID。 */
  upstreamModel: string;
  policy: CompatibilityPolicy;
  capabilities?: ModelCapabilities;
  issues: CompatibilityIssue[];
  /** Provider 级扩展配置（例如是否发送 stream_options）。 */
  providerConfig?: JsonObject;
}

export interface ParseResponseContext {
  requestId?: string;
  model?: string;
}

export interface RenderContext {
  requestId: string;
  model: string;
  created: number;
  policy: CompatibilityPolicy;
  issues: CompatibilityIssue[];
}

export interface ProtocolHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | ReadableStream<Uint8Array>;
}

/**
 * 单个协议的完整适配器：同时负责客户端方向（parseRequest/render*）
 * 与上游方向（buildUpstreamRequest/parse*）。
 */
export interface ProtocolAdapter {
  readonly id: ProtocolId;
  parseRequest(body: JsonObject, ctx?: ParseRequestContext): UnifiedRequest;
  buildUpstreamRequest(request: UnifiedRequest, ctx: BuildRequestContext): JsonObject;
  parseResponse(body: JsonObject, ctx?: ParseResponseContext): UnifiedResponse;
  renderResponse(response: UnifiedResponse, ctx: RenderContext): ProtocolHttpResponse;
  /** 解析上游 SSE 流为统一事件。 */
  parseStream(events: AsyncIterable<SseMessage>, ctx?: ParseResponseContext): AsyncIterable<UnifiedStreamEvent>;
  /** 将统一事件渲染为下游 SSE 响应。 */
  renderStream(events: AsyncIterable<UnifiedStreamEvent>, ctx: RenderContext): ProtocolHttpResponse;
  parseUpstreamError(status: number, body: unknown, retryAfterMs?: number): UnifiedError;
  renderError(error: GatewayError, ctx: RenderContext): ProtocolHttpResponse;
  renderModels(models: PublicModel[], ctx: RenderContext): ProtocolHttpResponse;
}

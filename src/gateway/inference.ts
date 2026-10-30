import type { Context, Hono } from "hono";
import type { AppEnv } from "../app";
import { authenticateInference } from "../auth/middleware";
import { inferenceCors } from "./cors";
import { loadRuntimeConfig } from "../config/cache";
import type { RuntimeConfig } from "../config/types";
import { GatewayError, toGatewayError } from "../core/errors";
import { stringifyJson } from "../core/json";
import type { UnifiedRequest } from "../ir";
import type { ProtocolId } from "../ir/common";
import { protocolRegistry } from "../protocol/registry";
import type { ProtocolHttpResponse, RenderContext } from "../protocol/types";
import { ModelRouter } from "../router/resolver";
import type { ModelExecutionResult } from "../execution/executor";
import { executeRoutePlan } from "../combo/executor";
import type { RouteResolution } from "../combo/types";
import { CoordinationClient } from "../combo/coordination";
import { extractSessionId, hashSession } from "../combo/session";
import type { ComboTraceNode } from "../combo/strategies/types";
import { findPublicModel, listPublicModels } from "../models/registry";
import { constraintsForPrincipal } from "./principal";
import { handleStreamingProtocol } from "./streaming";
import { readJsonObjectBody } from "./body";
import { acquireQuota, releaseQuota, settleQuota } from "./quota";
import { buildErrorUsageMessage, buildUsageMessage } from "./usage";
import { estimateAnthropicInputTokens } from "./token-count";
import { recordUsage } from "../usage/recorder";

function renderContext(
  c: Context<AppEnv>,
  model: string,
  config: RuntimeConfig,
  issues: RenderContext["issues"],
): RenderContext {
  return {
    requestId: c.get("requestId"),
    model,
    created: Date.now(),
    policy: config.settings.compatPolicy,
    issues,
  };
}

function protocolResponse(
  c: Context<AppEnv>,
  rendered: ProtocolHttpResponse,
  result?: ModelExecutionResult,
): Response {
  const headers = new Headers(rendered.headers);
  headers.set("x-request-id", c.get("requestId"));
  headers.set("x-trace-id", c.get("traceId"));
  if (result !== undefined) {
    headers.set("x-fufu-model", result.target.modelId);
    headers.set("x-fufu-provider", result.provider.name);
    headers.set("x-fufu-usage-source", result.response.usage.source);
    if (result.issues.length > 0) {
      headers.set(
        "x-fufu-warnings",
        result.issues
          .slice(0, 8)
          .map((issue) => `${issue.feature}:${issue.action}`)
          .join(","),
      );
    }
  }
  return new Response(rendered.body, { status: rendered.status, headers });
}

interface PlannedExecution {
  result: ModelExecutionResult;
  trace: string[];
  executionTrace: ComboTraceNode;
  resolution: RouteResolution;
}

async function runPlan(
  c: Context<AppEnv>,
  request: UnifiedRequest,
  config: RuntimeConfig,
  router: ModelRouter,
): Promise<PlannedExecution> {
  const constraints = constraintsForPrincipal(c.get("principal"));
  const resolution = router.resolve(request.model, constraints);
  const allowMessageHash =
    resolution.plan.kind === "combo" && resolution.plan.combo.sticky?.hashFirstUserMessage === true;
  const sessionId = await extractSessionId(request, c.req.raw.headers, allowMessageHash);
  const sessionHash = sessionId === undefined ? undefined : await hashSession(sessionId);

  const outcome = await executeRoutePlan(resolution.plan, {
    env: c.env,
    config,
    router,
    ...(constraints === undefined ? {} : { constraints }),
    fetchImpl: c.get("fetchImpl"),
    requestId: c.get("requestId"),
    policy: config.settings.compatPolicy,
    request,
    signal: c.req.raw.signal,
    ...(sessionHash === undefined ? {} : { sessionHash }),
    coordination: new CoordinationClient(c.env),
    deadline: Date.now() + config.settings.requestTimeoutMs,
    isStream: false,
  });

  const success = outcome.success;
  if (success === undefined || success.response === undefined) {
    throw (
      outcome.error ??
      new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "Combo produced no response" })
    );
  }

  return {
    result: {
      response: success.response,
      target: success.target,
      provider: success.provider,
      account: success.account,
      httpStatus: success.httpStatus ?? 200,
      issues: success.issues,
      latencyMs: success.latencyMs,
      retryCount: success.retryCount ?? 0,
    },
    trace: resolution.trace,
    executionTrace: outcome.trace,
    resolution,
  };
}

function logCompletion(
  c: Context<AppEnv>,
  config: RuntimeConfig,
  sourceProtocol: ProtocolId,
  targetProtocol: ProtocolId,
  request: UnifiedRequest,
  result: ModelExecutionResult,
  trace: string[],
  executionTrace: ComboTraceNode,
): void {
  c.get("logger").info("inference.completed", {
    sourceProtocol,
    targetProtocol,
    requestedModel: request.model,
    actualModel: result.target.modelId,
    provider: result.provider.name,
    accountId: result.account.id,
    stream: false,
    usage: result.response.usage,
    usageSource: result.response.usage.source,
    stopReason: result.response.stopReason,
    latencyMs: result.latencyMs,
    compatibilityIssues: result.issues.map((issue) => `${issue.feature}:${issue.action}`),
    route: trace,
    executionTrace,
    configVersion: config.version,
  });
}

async function handleNonStreaming(
  c: Context<AppEnv>,
  protocol: ProtocolId,
  adapter: ReturnType<typeof protocolRegistry.get>,
  config: RuntimeConfig,
  request: UnifiedRequest,
  router: ModelRouter,
): Promise<Response> {
  const startedAt = Date.now();
  const lease = await acquireQuota(c, request);
  try {
    const { result, trace, executionTrace, resolution } = await runPlan(c, request, config, router);
    const rendered = protocolResponse(
      c,
      adapter.renderResponse(result.response, renderContext(c, request.model, config, result.issues)),
      result,
    );
    const { message, cost } = buildUsageMessage({
      c,
      sourceProtocol: protocol,
      request,
      resolution,
      info: {
        target: result.target,
        provider: result.provider,
        account: result.account,
        httpStatus: result.httpStatus,
        retryCount: result.retryCount,
      },
      usage: result.response.usage,
      timing: { startedAt, firstTokenAt: null, finishedAt: Date.now() },
      stream: false,
      status: "success",
      errorCode: null,
      trace: executionTrace,
    });
    await settleQuota(c, lease, result.response.usage.totalTokens, cost);
    recordUsage(c.env, c.executionCtx, message);
    logCompletion(c, config, protocol, result.provider.protocol, request, result, trace, executionTrace);
    return rendered;
  } catch (error) {
    const gatewayError = toGatewayError(error);
    recordUsage(
      c.env,
      c.executionCtx,
      buildErrorUsageMessage({
        c,
        sourceProtocol: protocol,
        request,
        errorCode: gatewayError.code,
        httpStatus: gatewayError.status,
        startedAt,
        stream: false,
      }),
    );
    throw gatewayError;
  } finally {
    await releaseQuota(c, lease);
  }
}

async function handleProtocolRequest(
  c: Context<AppEnv>,
  protocol: ProtocolId,
): Promise<Response> {
  const config = await loadRuntimeConfig(c.env);
  const adapter = protocolRegistry.get(protocol);
  const body = await readJsonObjectBody(c, config.settings.maxBodyBytes);
  const request = adapter.parseRequest(body, { requestId: c.get("requestId") });
  const router = new ModelRouter(config);
  if (request.stream) {
    return handleStreamingProtocol(c, protocol, adapter, config, request, router);
  }
  return handleNonStreaming(c, protocol, adapter, config, request, router);
}

async function handleGeminiRequest(c: Context<AppEnv>): Promise<Response> {
  const config = await loadRuntimeConfig(c.env);
  const adapter = protocolRegistry.get("gemini");
  const prefix = "/v1beta/models/";
  const rawParam = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawParam);
  } catch {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Invalid model path" });
  }
  const separator = decoded.lastIndexOf(":");
  if (separator <= 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Gemini path must be {model}:{action}" });
  }
  let model = decoded.slice(0, separator);
  if (model.startsWith("models/")) model = model.slice("models/".length);
  const action = decoded.slice(separator + 1);
  if (action !== "generateContent" && action !== "streamGenerateContent") {
    throw new GatewayError({ code: "NOT_FOUND", message: `Unsupported Gemini action "${action}"` });
  }

  const body = await readJsonObjectBody(c, config.settings.maxBodyBytes);
  const request = adapter.parseRequest(body, { requestId: c.get("requestId"), model });
  request.stream = action === "streamGenerateContent";
  const router = new ModelRouter(config);
  if (request.stream) {
    return handleStreamingProtocol(c, "gemini", adapter, config, request, router);
  }
  return handleNonStreaming(c, "gemini", adapter, config, request, router);
}

async function handleModelList(c: Context<AppEnv>, protocol: ProtocolId): Promise<Response> {
  const config = await loadRuntimeConfig(c.env);
  const adapter = protocolRegistry.get(protocol);
  const models = listPublicModels(config, constraintsForPrincipal(c.get("principal")));
  return protocolResponse(
    c,
    adapter.renderModels(models, renderContext(c, "", config, [])),
  );
}

async function handleModelRetrieve(c: Context<AppEnv>, protocol: ProtocolId): Promise<Response> {
  const config = await loadRuntimeConfig(c.env);
  const raw = c.req.param("model") ?? "";
  const modelId = raw.startsWith("models/") ? raw.slice("models/".length) : raw;
  const model = findPublicModel(config, modelId, constraintsForPrincipal(c.get("principal")));
  if (model === undefined) {
    throw new GatewayError({ code: "MODEL_NOT_FOUND", message: `Model "${modelId}" is not available` });
  }
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": c.get("requestId"),
    "x-trace-id": c.get("traceId"),
  });
  const body =
    protocol === "gemini"
      ? {
          name: `models/${model.id}`,
          displayName: model.displayName ?? model.id,
          ...(model.contextWindow === undefined ? {} : { inputTokenLimit: model.contextWindow }),
          ...(model.maxOutputTokens === undefined ? {} : { outputTokenLimit: model.maxOutputTokens }),
          supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
        }
      : {
          id: model.id,
          object: "model",
          created: Math.floor((model.createdAt ?? Date.now()) / 1000),
          owned_by: model.providerName,
        };
  return new Response(stringifyJson(body), { status: 200, headers });
}

export function registerInferenceRoutes(app: Hono<AppEnv>): void {
  app.use("/v1/*", inferenceCors);
  app.use("/v1beta/*", inferenceCors);
  app.use("/v1/*", authenticateInference);
  app.use("/v1beta/*", authenticateInference);

  app.post("/v1/chat/completions", (c) => handleProtocolRequest(c, "openai-chat"));
  app.post("/v1/responses", (c) => handleProtocolRequest(c, "openai-responses"));
  app.post("/v1/messages", (c) => handleProtocolRequest(c, "anthropic"));
  app.post("/v1/messages/count_tokens", async (c) => {
    const config = await loadRuntimeConfig(c.env);
    const body = await readJsonObjectBody(c, config.settings.maxBodyBytes);
    c.header("x-fufu-usage-source", "estimated");
    return c.json({ input_tokens: estimateAnthropicInputTokens(body) });
  });
  app.post("/v1beta/models/*", handleGeminiRequest);

  app.get("/v1/models", (c) => handleModelList(c, "openai-chat"));
  app.get("/v1/models/:model", (c) => handleModelRetrieve(c, "openai-chat"));
  app.get("/v1beta/models", (c) => handleModelList(c, "gemini"));
  app.get("/v1beta/models/:model", (c) => handleModelRetrieve(c, "gemini"));
}

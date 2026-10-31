import type { Context } from "hono";
import type { AppEnv } from "../../app";
import type { RuntimeConfig } from "../../config/types";
import { loadRuntimeConfig } from "../../config/cache";
import { buildResolvedRoute } from "../../combo/normalize";
import { executeRoutePlan } from "../../combo/executor";
import { CoordinationClient } from "../../combo/coordination";
import type {
  ResolvedComboNode,
  ResolvedTarget,
  RouteResolution,
} from "../../combo/types";
import { GatewayError, toGatewayError } from "../../core/errors";
import { protocolRegistry } from "../../protocol/registry";
import { ModelRouter } from "../../router/resolver";
import { gatewayTestSchema, routingExplainSchema } from "../schemas";
import { parseAdminBody, recordAudit } from "../shared";

function summarizeTarget(
  target: ResolvedTarget,
  config: RuntimeConfig,
): Record<string, unknown> {
  const provider = config.providersById.get(target.providerId);
  const accounts = config.accountsByProvider.get(target.providerId) ?? [];
  return {
    providerId: target.providerId,
    providerName: target.providerName,
    modelId: target.modelId,
    upstreamModelId: target.upstreamModelId,
    providerEnabled: provider?.enabled === true,
    hasEnabledAccount: accounts.some((account) => account.enabled),
    weight: target.weight,
    priority: target.priority,
  };
}

function summarizeNode(
  node: ResolvedComboNode,
  config: RuntimeConfig,
  depth = 0,
): Record<string, unknown> {
  if (depth > 32) return { kind: "truncated" };
  if (node.kind === "model") {
    return {
      kind: "model",
      target: summarizeTarget(node.target, config),
      weight: node.weight,
      priority: node.priority,
      timeoutMs: node.timeoutMs ?? null,
    };
  }
  if (node.kind === "combo") {
    return {
      kind: "combo",
      name: node.combo.name,
      strategy: node.combo.strategy,
      weight: node.weight,
      priority: node.priority,
      timeoutMs: node.timeoutMs ?? null,
      nodes: node.combo.nodes.map((child) => summarizeNode(child, config, depth + 1)),
    };
  }
  return {
    kind: "inline",
    name: node.name,
    strategy: node.strategy,
    weight: node.weight,
    priority: node.priority,
    timeoutMs: node.timeoutMs ?? null,
    nodes: node.nodes.map((child) => summarizeNode(child, config, depth + 1)),
  };
}

function summarizePlan(
  resolution: RouteResolution,
  config: RuntimeConfig,
  router: ModelRouter,
): Record<string, unknown> {
  const root = buildResolvedRoute(resolution.plan, config, router, {
    maxDepth: config.settings.maxComboDepth,
    maxNodes: config.settings.maxComboNodes,
  });
  return {
    kind: resolution.plan.kind,
    name: root.name,
    strategy: root.strategy,
    nodes: root.nodes.map((node) => summarizeNode(node, config)),
  };
}

async function writeTestAudit(
  c: Context<AppEnv>,
  action: "gateway.test.success" | "gateway.test.failure",
  model: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await recordAudit(c, action, "gateway", model, details);
  } catch (error) {
    c.get("logger").warn("gateway.test.audit_failed", {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function routingExplainHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, routingExplainSchema);
  const config = await loadRuntimeConfig(c.env);
  const router = new ModelRouter(config);
  try {
    const resolution = router.resolve(input.model);
    return c.json({
      data: {
        ok: true,
        requestedModel: input.model,
        configVersion: config.version,
        match: resolution.match,
        trace: resolution.trace,
        plan: summarizePlan(resolution, config, router),
      },
    });
  } catch (error) {
    const gatewayError = toGatewayError(error, {
      code: "CONFIG_INVALID",
      message: "Failed to resolve model route",
    });
    return c.json({
      data: {
        ok: false,
        requestedModel: input.model,
        configVersion: config.version,
        error: {
          code: gatewayError.code,
          message: gatewayError.publicMessage,
          ...(gatewayError.details === undefined ? {} : { details: gatewayError.details }),
        },
      },
    });
  }
}

export async function gatewayTestHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, gatewayTestSchema);
  const config = await loadRuntimeConfig(c.env);
  const router = new ModelRouter(config);
  const adapter = protocolRegistry.get("openai-chat");
  const request = adapter.parseRequest(
    {
      model: input.model,
      messages: [{ role: "user", content: input.prompt ?? "Reply with OK." }],
      max_tokens: input.maxOutputTokens ?? 16,
      stream: false,
    },
    { requestId: c.get("requestId") },
  );

  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 30_000);

  try {
    const resolution = router.resolve(request.model);
    const outcome = await executeRoutePlan(resolution.plan, {
      env: c.env,
      config,
      router,
      fetchImpl: c.get("fetchImpl"),
      requestId: c.get("requestId"),
      policy: config.settings.compatPolicy,
      request,
      signal: controller.signal,
      coordination: new CoordinationClient(c.env),
      deadline: startedAt + 30_000,
      isStream: false,
    });
    if (outcome.success === undefined || outcome.success.response === undefined) {
      throw (
        outcome.error ??
        new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "Gateway test produced no response" })
      );
    }
    const success = outcome.success;
    const response = success.response;
    if (response === undefined) {
      throw new GatewayError({
        code: "COMBO_EXECUTION_FAILED",
        message: "Gateway test produced no response",
      });
    }
    let text = "";
    for (const part of response.content) {
      if (part.type === "text") text += part.text;
    }
    const usage = response.usage;
    await writeTestAudit(c, "gateway.test.success", input.model, {
      provider: success.provider.name,
      accountId: success.account.id,
      modelId: success.target.modelId,
      latencyMs: success.latencyMs,
      totalTokens: usage.totalTokens,
    });
    return c.json({
      data: {
        ok: true,
        requestedModel: input.model,
        provider: success.provider.name,
        accountId: success.account.id,
        modelId: success.target.modelId,
        httpStatus: success.httpStatus,
        latencyMs: success.latencyMs,
        retryCount: success.retryCount ?? 0,
        text,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
          reasoningTokens: usage.reasoningTokens ?? 0,
          source: usage.source,
        },
        routeTrace: resolution.trace,
        executionTrace: outcome.trace,
      },
    });
  } catch (error) {
    let gatewayError = toGatewayError(error, {
      code: "INTERNAL_ERROR",
      message: "Gateway test failed",
    });
    if (timedOut && gatewayError.code === "REQUEST_CANCELLED") {
      gatewayError = new GatewayError({
        code: "UPSTREAM_TIMEOUT",
        message: "Gateway test timed out",
        retriable: true,
      });
    }
    await writeTestAudit(c, "gateway.test.failure", input.model, {
      errorCode: gatewayError.code,
      latencyMs: Date.now() - startedAt,
    });
    return c.json({
      data: {
        ok: false,
        requestedModel: input.model,
        latencyMs: Date.now() - startedAt,
        error: {
          code: gatewayError.code,
          message: gatewayError.publicMessage,
          ...(gatewayError.details === undefined ? {} : { details: gatewayError.details }),
        },
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

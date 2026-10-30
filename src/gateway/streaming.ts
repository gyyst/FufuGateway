import type { Context } from "hono";
import type { AppEnv } from "../app";
import type { RuntimeConfig } from "../config/types";
import { GatewayError, toGatewayError } from "../core/errors";
import type { UnifiedRequest, UnifiedStreamEvent } from "../ir";
import type { ProtocolId } from "../ir/common";
import type { ProtocolAdapter, RenderContext } from "../protocol/types";
import { ModelRouter } from "../router/resolver";
import { CoordinationClient } from "../combo/coordination";
import { executeRoutePlan } from "../combo/executor";
import { hashSession, extractSessionId } from "../combo/session";
import type { ComboTraceNode } from "../combo/strategies/types";
import type { NodeSuccess } from "../combo/strategies/types";
import { recordUsage } from "../usage/recorder";
import { constraintsForPrincipal } from "./principal";
import { acquireQuota, releaseQuota, settleQuota, type QuotaLease } from "./quota";
import { buildErrorUsageMessage, buildUsageMessage } from "./usage";

function warningsHeader(issues: NodeSuccess["issues"]): string | undefined {
  if (issues.length === 0) return undefined;
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.feature}:${issue.action}`)
    .join(",");
}

function logStreamCompletion(
  c: Context<AppEnv>,
  sourceProtocol: ProtocolId,
  request: UnifiedRequest,
  success: NodeSuccess,
  routeTrace: string[],
  executionTrace: ComboTraceNode,
  config: RuntimeConfig,
): void {
  const stream = success.stream;
  if (stream === undefined) return;
  const stats = stream.stats;
  c.get("logger").info("inference.stream_completed", {
    sourceProtocol,
    targetProtocol: success.provider.protocol,
    requestedModel: request.model,
    actualModel: success.target.modelId,
    provider: success.provider.name,
    accountId: success.account.id,
    stream: true,
    status: stats.status,
    errorCode: stats.errorCode,
    usage: stats.usage,
    usageSource: stats.usage.source,
    stopReason: stats.stopReason,
    firstTokenMs: stats.firstTokenAt === null ? null : stats.firstTokenAt - stats.startedAt,
    durationMs: (stats.finishedAt ?? Date.now()) - stats.startedAt,
    compatibilityIssues: success.issues.map((issue) => `${issue.feature}:${issue.action}`),
    route: routeTrace,
    executionTrace,
    configVersion: config.version,
  });
}

/**
 * 处理流式推理请求（包括 Combo 与通配符多目标）。
 *
 * 在向下游提交任何字节之前完成节点选择与故障转移；提交后只通过
 * 协议错误事件结束，不会拼接其他上游的内容。
 */
export async function handleStreamingProtocol(
  c: Context<AppEnv>,
  sourceProtocol: ProtocolId,
  adapter: ProtocolAdapter,
  config: RuntimeConfig,
  request: UnifiedRequest,
  router: ModelRouter,
): Promise<Response> {
  const constraints = constraintsForPrincipal(c.get("principal"));
  const resolution = router.resolve(request.model, constraints);
  const allowMessageHash =
    resolution.plan.kind === "combo" && resolution.plan.combo.sticky?.hashFirstUserMessage === true;
  const sessionId = await extractSessionId(request, c.req.raw.headers, allowMessageHash);
  const sessionHash = sessionId === undefined ? undefined : await hashSession(sessionId);

  const startedAt = Date.now();
  const lease: QuotaLease | undefined = await acquireQuota(c, request);

  let outcome;
  try {
    outcome = await executeRoutePlan(resolution.plan, {
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
      isStream: true,
    });
  } catch (error) {
    const gatewayError = toGatewayError(error);
    recordUsage(
      c.env,
      c.executionCtx,
      buildErrorUsageMessage({
        c,
        sourceProtocol,
        request,
        errorCode: gatewayError.code,
        httpStatus: gatewayError.status,
        startedAt,
        stream: true,
      }),
    );
    await releaseQuota(c, lease);
    throw gatewayError;
  }

  const success = outcome.success;
  if (success === undefined || success.stream === undefined) {
    const gatewayError =
      outcome.error ??
      new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "Combo produced no stream" });
    recordUsage(
      c.env,
      c.executionCtx,
      buildErrorUsageMessage({
        c,
        sourceProtocol,
        request,
        errorCode: gatewayError.code,
        httpStatus: gatewayError.status,
        startedAt,
        stream: true,
      }),
    );
    await releaseQuota(c, lease);
    throw gatewayError;
  }

  const observed = (async function* (): AsyncGenerator<UnifiedStreamEvent> {
    try {
      for await (const event of success.stream!.events) {
        yield event;
      }
    } finally {
      const stats = success.stream!.stats;
      const status =
        stats.status === "success"
          ? "success"
          : stats.status === "cancelled"
            ? "cancelled"
            : "error";
      const { message, cost } = buildUsageMessage({
        c,
        sourceProtocol,
        request,
        resolution,
        info: {
          target: success.target,
          provider: success.provider,
          account: success.account,
          httpStatus: success.httpStatus ?? 200,
          retryCount: success.retryCount ?? stats.retryCount,
        },
        usage: stats.usage,
        timing: {
          startedAt,
          firstTokenAt: stats.firstTokenAt,
          finishedAt: stats.finishedAt ?? Date.now(),
        },
        stream: true,
        status,
        errorCode: stats.errorCode,
        trace: outcome.trace,
      });
      try {
        await settleQuota(c, lease, stats.usage.totalTokens, cost);
        recordUsage(c.env, c.executionCtx, message);
        logStreamCompletion(c, sourceProtocol, request, success, resolution.trace, outcome.trace, config);
      } finally {
        await releaseQuota(c, lease);
      }
    }
  })();

  const renderContext: RenderContext = {
    requestId: c.get("requestId"),
    model: request.model,
    created: Date.now(),
    policy: config.settings.compatPolicy,
    issues: success.issues,
  };

  let rendered;
  try {
    rendered = adapter.renderStream(observed, renderContext);
  } catch (error) {
    await observed.return?.(undefined);
    await releaseQuota(c, lease);
    throw toGatewayError(error);
  }

  const headers = new Headers(rendered.headers);
  headers.set("x-request-id", c.get("requestId"));
  headers.set("x-trace-id", c.get("traceId"));
  headers.set("x-fufu-model", success.target.modelId);
  headers.set("x-fufu-provider", success.provider.name);
  headers.set("x-fufu-stream", "1");
  const warnings = warningsHeader(success.issues);
  if (warnings !== undefined) headers.set("x-fufu-warnings", warnings);

  return new Response(rendered.body, { status: rendered.status, headers });
}

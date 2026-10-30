import { GatewayError, toGatewayError } from "../core/errors";
import { newId } from "../core/ids";
import type { CompatibilityPolicy, UnifiedRequest, UnifiedResponse } from "../ir";
import { textPart } from "../ir/content";
import type { GatewayEnv } from "../env";
import type { RuntimeConfig } from "../config/types";
import type { FetchLike } from "../providers/types";
import { ModelRouter } from "../router/resolver";
import type { RouteConstraints } from "../router/resolver";
import type { StreamExecutionHandle } from "../execution/stream-executor";
import { openModelStreamWithRetry } from "../execution/stream-executor";
import { executeModelOnce, type ModelExecutionResult } from "../execution/executor";
import { resolveRetryPolicy, type RetryPolicy } from "../execution/retry";
import type { CoordinationClient } from "./coordination";
import { buildResolvedRoute } from "./normalize";
import { getComboStrategy } from "./strategies/registry";
import type {
  ComboTraceNode,
  EvaluateOptions,
  NodeEvaluation,
  NodeSuccess,
  StrategyContext,
} from "./strategies/types";
import { failureTrace, nodeKey } from "./strategies/types";
import type {
  ResolvedCombo,
  ResolvedComboNode,
  RoutePlan,
} from "./types";

export interface ComboExecutionDependencies {
  env: GatewayEnv;
  config: RuntimeConfig;
  router: ModelRouter;
  fetchImpl: FetchLike;
  requestId: string;
  policy: CompatibilityPolicy;
  /** 原始请求，Fusion 的 Judge 需要复用消息上下文。 */
  request: UnifiedRequest;
  signal?: AbortSignal;
  sessionHash?: string;
  constraints?: RouteConstraints;
  coordination: CoordinationClient;
  deadline: number;
  isStream: boolean;
}

export interface ComboRouteResult {
  success?: NodeSuccess;
  error?: GatewayError;
  trace: ComboTraceNode;
}

interface LinkedSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  cancel: (keepParentLink?: boolean, keepTimer?: boolean) => void;
}

function createLinkedSignal(parent: AbortSignal | undefined, timeoutMs?: number): LinkedSignal {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted === true) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancel: (keepParentLink = false, keepTimer = false) => {
      if (timer !== undefined && !keepTimer) clearTimeout(timer);
      if (!keepParentLink) parent?.removeEventListener("abort", onAbort);
    },
  };
}

function traceForNode(node: ResolvedComboNode): ComboTraceNode {
  const startedAt = Date.now();
  if (node.kind === "model") {
    return {
      id: newId("trc"),
      kind: "model",
      label: `${node.target.providerName}/${node.target.modelId}`,
      providerId: node.target.providerId,
      modelId: node.target.modelId,
      status: "failed",
      startedAt,
      attempts: [],
      children: [],
    };
  }
  if (node.kind === "combo") {
    return {
      id: newId("trc"),
      kind: "combo",
      label: node.combo.name,
      status: "failed",
      startedAt,
      attempts: [],
      children: [],
    };
  }
  return {
    id: newId("trc"),
    kind: "inline",
    label: node.name,
    status: "failed",
    startedAt,
    attempts: [],
    children: [],
  };
}

function lastUserText(request: UnifiedRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    if (text !== "") return text;
  }
  return "";
}

function responseText(response: UnifiedResponse): string {
  const text = response.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return text === "" ? JSON.stringify(response.content) : text;
}

function buildJudgeRequest(
  request: UnifiedRequest,
  candidates: NodeSuccess[],
): UnifiedRequest {
  const candidateText = candidates
    .map(
      (candidate, index) =>
        `[${index + 1}] ${candidate.provider.name}/${candidate.target.modelId}:\n${
          candidate.response === undefined ? "" : responseText(candidate.response)
        }`,
    )
    .join("\n\n");

  const prompt = `User request:\n${lastUserText(request)}\n\nCandidate responses:\n${candidateText}\n\nSelect or synthesize the single best final answer. Return only the final answer.`;

  return {
    ...request,
    stream: false,
    system: [
      {
        role: "system",
        content: [textPart("You are an impartial judge. Compare candidate answers and produce the best final answer.")],
      },
    ],
    messages: [{ role: "user", content: [textPart(prompt)] }],
    tools: [],
    toolChoice: { type: "auto" },
    parallelToolCalls: undefined,
    responseFormat: undefined,
    reasoning: undefined,
    metadata: {},
    extensions: { source: request.raw.protocol, values: {} },
    raw: { protocol: request.raw.protocol, body: {} },
  };
}

async function executeComboRoot(
  combo: ResolvedCombo,
  deps: ComboExecutionDependencies,
  depth: number,
): Promise<ComboRouteResult> {
  const trace: ComboTraceNode = {
    id: newId("cmbtrc"),
    kind: "combo",
    label: combo.name,
    status: "failed",
    startedAt: Date.now(),
    attempts: [],
    children: [],
  };

  if (depth > deps.config.settings.maxComboDepth) {
    return {
      error: new GatewayError({
        code: "COMBO_EXECUTION_FAILED",
        message: `Combo nesting exceeds ${deps.config.settings.maxComboDepth} levels`,
      }),
      trace: { ...trace, finishedAt: Date.now() },
    };
  }

  const strategy = getComboStrategy(combo.strategy);
  if (deps.isStream && !strategy.supportsStreaming) {
    throw new GatewayError({
      code: "UNSUPPORTED_FEATURE",
      message: `Combo strategy "${combo.strategy}" does not support streaming`,
      details: { combo: combo.name, strategy: combo.strategy },
    });
  }

  const comboDeadline =
    combo.timeoutMs === undefined
      ? deps.deadline
      : Math.min(deps.deadline, Date.now() + combo.timeoutMs);
  const linked = createLinkedSignal(deps.signal, combo.timeoutMs);
  const signal = linked.signal;

  const stickyEnabled = combo.sticky?.enabled === true && deps.sessionHash !== undefined;
  let preferredKey: string | undefined;
  if (stickyEnabled && deps.sessionHash !== undefined) {
    preferredKey = await deps.coordination.getSticky(deps.sessionHash, combo.id);
    if (preferredKey !== undefined && !combo.nodes.some((node) => nodeKey(node) === preferredKey)) {
      preferredKey = undefined;
    }
  }

  const maxConcurrency = Math.max(
    1,
    Math.min(
      combo.maxConcurrency ?? deps.config.settings.maxComboConcurrency,
      deps.config.settings.maxComboConcurrency,
    ),
  );

  const traceChildren: ComboTraceNode[] = [];
  let evaluation: NodeEvaluation | undefined;

  const evaluate = async (
    node: ResolvedComboNode,
    options: EvaluateOptions,
  ): Promise<NodeEvaluation> => {
    const nodeTrace = traceForNode(node);
    const startedAt = Date.now();
    const nodeDeadline =
      node.timeoutMs === undefined ? options.deadline : Math.min(options.deadline, startedAt + node.timeoutMs);
    if (nodeDeadline <= Date.now()) {
      nodeTrace.status = "failed";
      nodeTrace.finishedAt = Date.now();
      nodeTrace.attempts.push({ index: 0, status: "UPSTREAM_TIMEOUT", durationMs: 0, errorCode: "UPSTREAM_TIMEOUT" });
      return {
        error: new GatewayError({ code: "UPSTREAM_TIMEOUT", message: "Combo node exceeded its time budget" }),
        trace: nodeTrace,
        ...(node.kind === "inline" ? {} : { node }),
      };
    }

    const nodeLinked = createLinkedSignal(options.signal, nodeDeadline - Date.now());
    let keepStreamLink = false;
    try {
      if (node.kind === "model") {
        ModelRouter.assertTargetAllowed(node.target, deps.constraints, deps.request.model);
        let retryPolicy: RetryPolicy | undefined;
        if (node.maxRetries !== undefined) {
          const nodeProvider = deps.config.providersById.get(node.target.providerId);
          if (nodeProvider !== undefined) {
            const basePolicy = resolveRetryPolicy(nodeProvider);
            retryPolicy = {
              ...basePolicy,
              maxAttempts: Math.max(1, Math.min(1 + node.maxRetries, 10)),
            };
          }
        }
        const result: ModelExecutionResult | StreamExecutionHandle = deps.isStream
          ? await openModelStreamWithRetry(deps.request, node.target, {
              env: deps.env,
              config: deps.config,
              fetchImpl: deps.fetchImpl,
              requestId: deps.requestId,
              policy: deps.policy,
              signal: nodeLinked.signal,
              deadline: nodeDeadline,
              ...(retryPolicy === undefined ? {} : { retryPolicy }),
            })
          : await executeModelOnce(deps.request, node.target, {
              env: deps.env,
              config: deps.config,
              fetchImpl: deps.fetchImpl,
              requestId: deps.requestId,
              policy: deps.policy,
              signal: nodeLinked.signal,
              deadline: nodeDeadline,
              ...(retryPolicy === undefined ? {} : { retryPolicy }),
            });

        const latencyMs = Date.now() - startedAt;
        const isStream = "events" in result;
        const success: NodeSuccess = isStream
          ? {
              target: node.target,
              provider: result.provider,
              account: result.account,
              stream: result,
              latencyMs,
              issues: result.issues,
              httpStatus: 200,
              retryCount: result.stats.retryCount,
            }
          : {
              target: node.target,
              provider: result.provider,
              account: result.account,
              response: result.response,
              latencyMs,
              issues: result.issues,
              httpStatus: result.httpStatus,
              retryCount: result.retryCount,
            };

        keepStreamLink = isStream;
        nodeTrace.status = "ok";
        nodeTrace.finishedAt = Date.now();
        nodeTrace.providerId = success.provider.id;
        nodeTrace.modelId = node.target.modelId;
        nodeTrace.attempts.push({
          index: 0,
          providerId: success.provider.id,
          accountId: success.account.id,
          status: success.httpStatus ?? 200,
          durationMs: latencyMs,
        });
        const recordedLatency = isStream
          ? (() => {
              const stream = result as StreamExecutionHandle;
              return stream.stats.firstTokenAt === null
                ? latencyMs
                : Math.max(0, stream.stats.firstTokenAt - stream.stats.startedAt);
            })()
          : latencyMs;
        await deps.coordination.recordLatency(
          combo.id,
          `${node.target.providerId}:${node.target.modelRecordId}`,
          recordedLatency,
        );
        return { success, trace: nodeTrace, node };
      }

      const nested: ResolvedCombo =
        node.kind === "combo"
          ? node.combo
          : {
              id: `inline:${node.name}`,
              name: node.name,
              strategy: node.strategy,
              nodes: node.nodes,
            };
      const nestedResult = await executeComboRoot(nested, {
        ...deps,
        signal: nodeLinked.signal,
        deadline: nodeDeadline,
      }, depth + 1);
      nodeTrace.finishedAt = Date.now();
      nodeTrace.children.push(nestedResult.trace);
      if (nestedResult.success === undefined) {
        nodeTrace.status = nestedResult.error?.code === "REQUEST_CANCELLED" ? "cancelled" : "failed";
        return {
          error:
            nestedResult.error ??
            new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "Nested combo failed" }),
          trace: nodeTrace,
          node,
        };
      }
      nodeTrace.status = "ok";
      keepStreamLink = nestedResult.success.stream !== undefined;
      return { success: nestedResult.success, trace: nodeTrace, node };
    } catch (error) {
      let gatewayError = toGatewayError(error, { code: "COMBO_EXECUTION_FAILED", message: "Combo node failed" });
      if (nodeLinked.timedOut() && gatewayError.code === "REQUEST_CANCELLED") {
        gatewayError = new GatewayError({
          code: "UPSTREAM_TIMEOUT",
          message: "Combo node timed out",
          retriable: true,
        });
      }
      nodeTrace.status = gatewayError.code === "REQUEST_CANCELLED" ? "cancelled" : "failed";
      nodeTrace.finishedAt = Date.now();
      nodeTrace.attempts.push({
        index: 0,
        status: gatewayError.code,
        durationMs: Date.now() - startedAt,
        errorCode: gatewayError.code,
      });
      if (
        preferredKey !== undefined &&
        deps.sessionHash !== undefined &&
        nodeKey(node) === preferredKey
      ) {
        await deps.coordination.clearSticky(deps.sessionHash, combo.id);
      }
      return { error: gatewayError, trace: nodeTrace, node };
    } finally {
      nodeLinked.cancel(keepStreamLink, keepStreamLink);
    }
  };

  const judge = async (successes: NodeSuccess[]): Promise<NodeEvaluation> => {
    const judgeTrace: ComboTraceNode = {
      id: newId("trc"),
      kind: "model",
      label: `judge:${combo.judgeTarget?.modelId ?? "unconfigured"}`,
      status: "failed",
      startedAt: Date.now(),
      attempts: [],
      children: [],
    };
    const target = combo.judgeTarget;
    if (target === undefined) {
      return {
        error: new GatewayError({
          code: "COMBO_EXECUTION_FAILED",
          message: `Combo "${combo.name}" uses fusion but has no judgeModel`,
        }),
        trace: { ...judgeTrace, finishedAt: Date.now() },
      };
    }
    const judgeRequest = buildJudgeRequest(deps.request, successes);
    try {
      const result = await executeModelOnce(judgeRequest, target, {
        env: deps.env,
        config: deps.config,
        fetchImpl: deps.fetchImpl,
        requestId: deps.requestId,
        policy: "warn",
        signal,
      });
      judgeTrace.status = "ok";
      judgeTrace.finishedAt = Date.now();
      judgeTrace.providerId = result.provider.id;
      judgeTrace.modelId = target.modelId;
      judgeTrace.attempts.push({
        index: 0,
        providerId: result.provider.id,
        accountId: result.account.id,
        status: result.httpStatus,
        durationMs: result.latencyMs,
      });
      return {
        success: {
          target,
          provider: result.provider,
          account: result.account,
          response: result.response,
          latencyMs: result.latencyMs,
          issues: result.issues,
          httpStatus: result.httpStatus,
          retryCount: result.retryCount,
        },
        trace: judgeTrace,
      };
    } catch (error) {
      const gatewayError = toGatewayError(error, {
        code: "COMBO_EXECUTION_FAILED",
        message: "Judge model failed",
      });
      judgeTrace.finishedAt = Date.now();
      judgeTrace.attempts.push({
        index: 0,
        status: gatewayError.code,
        durationMs: Date.now() - judgeTrace.startedAt,
        errorCode: gatewayError.code,
      });
      return { error: gatewayError, trace: judgeTrace };
    }
  };

  const context: StrategyContext = {
    combo,
    nodes: combo.nodes,
    signal,
    deadline: comboDeadline,
    isStream: deps.isStream,
    ...(deps.sessionHash === undefined ? {} : { sessionHash: deps.sessionHash }),
    ...(preferredKey === undefined ? {} : { preferredKey }),
    coordination: deps.coordination,
    maxConcurrency,
    traceChildren,
    evaluate,
    judge,
  };

  try {
    evaluation = await strategy.run(context);
  } catch (error) {
    const gatewayError = toGatewayError(error, {
      code: "COMBO_EXECUTION_FAILED",
      message: "Combo strategy failed",
    });
    traceChildren.push(failureTrace(combo.name));
    linked.cancel();
    return {
      error: gatewayError,
      trace: {
        ...trace,
        status: gatewayError.code === "REQUEST_CANCELLED" ? "cancelled" : "failed",
        finishedAt: Date.now(),
        children: traceChildren,
      },
    };
  } finally {
    const keepComboLink = evaluation?.success?.stream !== undefined;
    linked.cancel(keepComboLink, keepComboLink);
  }

  if (evaluation === undefined) {
    return {
      error: new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "Combo produced no result" }),
      trace: { ...trace, finishedAt: Date.now(), children: traceChildren },
    };
  }

  if (evaluation.success !== undefined) {
    trace.status = "ok";
    trace.finishedAt = Date.now();
    trace.children = traceChildren;
    if (
      stickyEnabled &&
      deps.sessionHash !== undefined &&
      combo.sticky !== undefined &&
      evaluation.node !== undefined &&
      combo.strategy !== "race" &&
      combo.strategy !== "fusion"
    ) {
      const key = nodeKey(evaluation.node);
      if (key !== undefined) {
        await deps.coordination.setSticky(
          deps.sessionHash,
          combo.id,
          key,
          combo.sticky.ttlSeconds * 1000,
        );
      }
    }
    return { success: evaluation.success, trace };
  }

  let finalError =
    evaluation.error ?? new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "Combo failed" });
  if (finalError.code === "REQUEST_CANCELLED" && linked.timedOut()) {
    finalError = new GatewayError({
      code: "UPSTREAM_TIMEOUT",
      message: `Combo "${combo.name}" exceeded its time budget`,
      retriable: true,
    });
  }
  trace.status = finalError.code === "REQUEST_CANCELLED" ? "cancelled" : "failed";
  trace.finishedAt = Date.now();
  trace.children = traceChildren;
  return { error: finalError, trace };
}

/** 执行路由计划（单模型、通配符多目标或 Combo）。 */
export async function executeRoutePlan(
  plan: RoutePlan,
  deps: ComboExecutionDependencies,
): Promise<ComboRouteResult> {
  const root = buildResolvedRoute(plan, deps.config, deps.router, {
    maxDepth: deps.config.settings.maxComboDepth,
    maxNodes: deps.config.settings.maxComboNodes,
  });
  return executeComboRoot(root, deps, 0);
}

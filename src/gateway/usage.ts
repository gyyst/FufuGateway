import type { Context } from "hono";
import type { AppEnv } from "../app";
import type { UnifiedRequest, UnifiedUsage } from "../ir";
import type { ProtocolId } from "../ir/common";
import type { ProviderAccountRecord, ProviderRecord } from "../config/types";
import type { RouteResolution, ResolvedTarget } from "../combo/types";
import type { ComboTraceNode } from "../combo/strategies/types";
import { emptyUsage } from "../ir/usage";
import type { UsageQueueMessage } from "../usage/events";
import { computeCost } from "../usage/pricing";

export interface UsageInfo {
  target: ResolvedTarget;
  provider: ProviderRecord;
  account?: ProviderAccountRecord;
  httpStatus?: number;
  retryCount?: number;
}

export interface UsageTiming {
  startedAt: number;
  firstTokenAt: number | null;
  finishedAt: number;
}

function comboIdOf(resolution: RouteResolution): string | null {
  if (resolution.match.type === "combo") return resolution.match.comboName;
  if (resolution.plan.kind === "inline_combo") return resolution.plan.name;
  return null;
}

export function buildUsageMessage(args: {
  c: Context<AppEnv>;
  sourceProtocol: ProtocolId;
  request: UnifiedRequest;
  resolution: RouteResolution;
  info: UsageInfo;
  usage: UnifiedUsage;
  timing: UsageTiming;
  stream: boolean;
  status: "success" | "error" | "cancelled";
  errorCode: string | null;
  trace: ComboTraceNode;
}): { message: UsageQueueMessage; cost: number } {
  const { c, info, usage, timing } = args;
  const principal = c.get("principal");
  const cost = computeCost(info.target.pricing, usage);
  const actual = usage.source === "upstream";
  const message: UsageQueueMessage = {
    requestId: c.get("requestId"),
    traceId: c.get("traceId"),
    userId: principal?.user?.id ?? null,
    apiKeyId: principal?.apiKey?.id ?? null,
    providerId: info.provider.id,
    providerAccountId: info.account?.id ?? null,
    requestedModel: args.request.model,
    actualModel: info.target.modelId,
    comboId: comboIdOf(args.resolution),
    sourceProtocol: args.sourceProtocol,
    targetProtocol: info.provider.protocol,
    stream: args.stream,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedInputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    totalTokens: usage.totalTokens,
    usageSource: usage.source,
    estimatedCost: actual ? 0 : cost,
    actualCost: actual ? cost : 0,
    startedAt: timing.startedAt,
    firstTokenAt: timing.firstTokenAt,
    finishedAt: timing.finishedAt,
    status: args.status,
    errorCode: args.errorCode,
    httpStatus: info.httpStatus ?? 200,
    retryCount: info.retryCount ?? 0,
    routeTrace: { route: args.resolution.trace, execution: args.trace },
  };
  return { message, cost };
}

export function buildErrorUsageMessage(args: {
  c: Context<AppEnv>;
  sourceProtocol: ProtocolId;
  request: UnifiedRequest;
  errorCode: string;
  httpStatus: number;
  startedAt: number;
  stream: boolean;
}): UsageQueueMessage {
  const principal = args.c.get("principal");
  const usage = emptyUsage("none");
  return {
    requestId: args.c.get("requestId"),
    traceId: args.c.get("traceId"),
    userId: principal?.user?.id ?? null,
    apiKeyId: principal?.apiKey?.id ?? null,
    providerId: null,
    providerAccountId: null,
    requestedModel: args.request.model,
    actualModel: null,
    comboId: null,
    sourceProtocol: args.sourceProtocol,
    targetProtocol: null,
    stream: args.stream,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    usageSource: "none",
    estimatedCost: 0,
    actualCost: 0,
    startedAt: args.startedAt,
    firstTokenAt: null,
    finishedAt: Date.now(),
    status: "error",
    errorCode: args.errorCode,
    httpStatus: args.httpStatus,
    retryCount: 0,
    routeTrace: null,
  };
}

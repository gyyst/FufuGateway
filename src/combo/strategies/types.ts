import type { GatewayError } from "../../core/errors";
import type { CompatibilityIssue, UnifiedResponse } from "../../ir";
import type { ProviderAccountRecord, ProviderRecord } from "../../config/types";
import type { StreamExecutionHandle } from "../../execution/stream-executor";
import type { CoordinationClient } from "../coordination";
import type {
  ResolvedCombo,
  ResolvedComboNode,
  ResolvedTarget,
  StrategyId,
} from "../types";

export interface NodeSuccess {
  target: ResolvedTarget;
  provider: ProviderRecord;
  account: ProviderAccountRecord;
  response?: UnifiedResponse;
  stream?: StreamExecutionHandle;
  latencyMs: number;
  issues: CompatibilityIssue[];
  httpStatus?: number;
  retryCount?: number;
}

export interface ComboTraceAttempt {
  index: number;
  providerId?: string;
  accountId?: string;
  status: number | string;
  durationMs: number;
  errorCode?: string;
}

export interface ComboTraceNode {
  id: string;
  kind: "combo" | "model" | "inline";
  label: string;
  providerId?: string;
  modelId?: string;
  status: "ok" | "failed" | "skipped" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  attempts: ComboTraceAttempt[];
  children: ComboTraceNode[];
}

export interface NodeEvaluation {
  success?: NodeSuccess;
  error?: GatewayError;
  trace: ComboTraceNode;
  node?: import("../types").ResolvedComboNode;
}

export interface EvaluateOptions {
  signal: AbortSignal;
  deadline: number;
}

export interface StrategyContext {
  combo: ResolvedCombo;
  nodes: ResolvedComboNode[];
  signal: AbortSignal;
  deadline: number;
  isStream: boolean;
  sessionHash?: string;
  preferredKey?: string;
  coordination: CoordinationClient;
  maxConcurrency: number;
  traceChildren: ComboTraceNode[];
  evaluate(node: ResolvedComboNode, options: EvaluateOptions): Promise<NodeEvaluation>;
  judge(successes: NodeSuccess[]): Promise<NodeEvaluation>;
}

export interface ComboStrategy {
  readonly id: StrategyId;
  readonly supportsStreaming: boolean;
  run(ctx: StrategyContext): Promise<NodeEvaluation>;
}

export function nodeKey(node: ResolvedComboNode): string | undefined {
  if (node.kind === "model") {
    return `model:${node.target.providerId}:${node.target.modelRecordId}`;
  }
  if (node.kind === "combo") return `combo:${node.combo.name}`;
  return undefined;
}

/** 把粘性会话偏好的节点移动到最前。 */
export function orderWithPreferred(
  nodes: ResolvedComboNode[],
  preferredKey: string | undefined,
): ResolvedComboNode[] {
  if (preferredKey === undefined) return nodes;
  const index = nodes.findIndex((node) => nodeKey(node) === preferredKey);
  if (index <= 0) return nodes;
  const preferred = nodes[index];
  if (preferred === undefined) return nodes;
  return [preferred, ...nodes.slice(0, index), ...nodes.slice(index + 1)];
}

export function circularOrder(
  nodes: ResolvedComboNode[],
  startIndex: number,
): ResolvedComboNode[] {
  if (nodes.length === 0) return nodes;
  const start = ((startIndex % nodes.length) + nodes.length) % nodes.length;
  return [...nodes.slice(start), ...nodes.slice(0, start)];
}

export function failureTrace(label: string, reason: "cancelled" | "failed" = "failed"): ComboTraceNode {
  const now = Date.now();
  return {
    id: `trace_${now.toString(36)}`,
    kind: "model",
    label,
    status: reason,
    startedAt: now,
    finishedAt: now,
    attempts: [],
    children: [],
  };
}

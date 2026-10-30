import type { GatewayEnv } from "../env";
import { dayKey, monthKey } from "../core/time";
import type { UsageQueueMessage } from "./events";

const MAX_TRACE_CHARS = 64 * 1024;

function serializeTrace(trace: unknown): string | null {
  if (trace === undefined) return null;
  try {
    const serialized = JSON.stringify(trace);
    if (serialized.length <= MAX_TRACE_CHARS) return serialized;
    return JSON.stringify({ truncated: true, preview: serialized.slice(0, MAX_TRACE_CHARS - 100) });
  } catch {
    return null;
  }
}

function totalCost(message: UsageQueueMessage): number {
  if (message.actualCost > 0) return message.actualCost;
  return message.estimatedCost;
}

/**
 * 幂等写入请求日志、日汇总与预算计数器。
 * 返回 false 表示该 request_id 已处理过。
 */
export async function persistUsage(db: D1Database, message: UsageQueueMessage): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO request_logs
        (request_id, trace_id, user_id, api_key_id, provider_id, provider_account_id,
         requested_model, actual_model, combo_id, source_protocol, target_protocol, stream,
         input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, usage_source,
         estimated_cost, actual_cost, started_at, first_token_at, finished_at, duration_ms,
         status, error_code, http_status, retry_count, route_trace, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      message.requestId,
      message.traceId,
      message.userId,
      message.apiKeyId,
      message.providerId,
      message.providerAccountId,
      message.requestedModel,
      message.actualModel,
      message.comboId,
      message.sourceProtocol,
      message.targetProtocol,
      message.stream ? 1 : 0,
      message.inputTokens,
      message.outputTokens,
      message.cachedTokens,
      message.reasoningTokens,
      message.totalTokens,
      message.usageSource,
      message.estimatedCost,
      message.actualCost,
      message.startedAt,
      message.firstTokenAt,
      message.finishedAt,
      Math.max(0, message.finishedAt - message.startedAt),
      message.status,
      message.errorCode,
      message.httpStatus,
      message.retryCount,
      serializeTrace(message.routeTrace),
      message.finishedAt,
    )
    .run();

  if ((inserted.meta.changes ?? 0) === 0) return false;

  const day = dayKey(message.startedAt);
  const month = monthKey(message.startedAt);
  const model = message.actualModel ?? message.requestedModel;
  const isError = message.status === "success" ? 0 : 1;
  const cost = totalCost(message);
  const now = Date.now();

  const statements = [
    db
      .prepare(
        `INSERT INTO usage_rollups
          (day, user_id, api_key_id, provider_id, model, combo_id, requests, errors,
           input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, cost_usd, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, user_id, api_key_id, provider_id, model, combo_id) DO UPDATE SET
           requests = requests + 1,
           errors = errors + excluded.errors,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cached_tokens = cached_tokens + excluded.cached_tokens,
           reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
           total_tokens = total_tokens + excluded.total_tokens,
           cost_usd = cost_usd + excluded.cost_usd,
           updated_at = excluded.updated_at`,
      )
      .bind(
        day,
        message.userId ?? "",
        message.apiKeyId ?? "",
        message.providerId ?? "",
        model,
        message.comboId ?? "",
        isError,
        message.inputTokens,
        message.outputTokens,
        message.cachedTokens,
        message.reasoningTokens,
        message.totalTokens,
        cost,
        now,
      ),
  ];

  const addBudget = (scope: "day" | "month", period: string, subjectType: "user" | "api_key", subjectId: string) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO budget_counters (scope, subject_type, subject_id, period, spend_usd, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, subject_type, subject_id, period) DO UPDATE SET
             spend_usd = spend_usd + excluded.spend_usd,
             updated_at = excluded.updated_at`,
        )
        .bind(scope, subjectType, subjectId, period, cost, now),
    );
  };

  if (cost > 0) {
    if (message.apiKeyId !== null) {
      addBudget("day", day, "api_key", message.apiKeyId);
      addBudget("month", month, "api_key", message.apiKeyId);
    }
    if (message.userId !== null) {
      addBudget("day", day, "user", message.userId);
      addBudget("month", month, "user", message.userId);
    }
  }

  await db.batch(statements);
  return true;
}

/** 将事件投递到队列；未绑定队列或投递失败时降级为直写 D1。 */
export async function sendUsage(env: GatewayEnv, message: UsageQueueMessage): Promise<void> {
  if (env.USAGE_MODE !== "direct" && env.USAGE_QUEUE !== undefined) {
    try {
      await env.USAGE_QUEUE.send(message);
      return;
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "usage.queue_send_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  await persistUsage(env.DB, message);
}

/** 兼容 Hono 与 Workers 的 ExecutionContext 类型。 */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** 异步记录 Usage，不阻塞响应；失败仅记录日志。 */
export function recordUsage(
  env: GatewayEnv,
  ctx: WaitUntilContext,
  message: UsageQueueMessage,
): void {
  ctx.waitUntil(
    sendUsage(env, message).catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "usage.record_failed",
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }),
  );
}

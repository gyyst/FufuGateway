import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError } from "../../core/errors";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultFrom(): string {
  return new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
}

function dateParam(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (!DAY_PATTERN.test(value)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Dates must use YYYY-MM-DD" });
  }
  return value;
}

function weekKey(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

interface SummaryRow {
  day: string;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export async function usageSummaryHandler(c: Context<AppEnv>): Promise<Response> {
  const from = dateParam(c.req.query("from"), defaultFrom());
  const to = dateParam(c.req.query("to"), today());
  const groupBy = c.req.query("groupBy") ?? "day";
  if (groupBy !== "day" && groupBy !== "week" && groupBy !== "month") {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "groupBy must be day, week or month" });
  }

  const conditions = ["day >= ?", "day <= ?"];
  const params: Array<string | number> = [from, to];
  const filters: Array<[string, string | undefined]> = [
    ["user_id", c.req.query("userId")],
    ["api_key_id", c.req.query("apiKeyId")],
    ["provider_id", c.req.query("providerId")],
    ["model", c.req.query("model")],
    ["combo_id", c.req.query("comboId")],
  ];
  for (const [column, value] of filters) {
    if (value !== undefined && value !== "") {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  }

  const rows = await c.env.DB.prepare(
    `SELECT day, SUM(requests) AS requests, SUM(errors) AS errors,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cached_tokens) AS cached_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
            SUM(total_tokens) AS total_tokens, SUM(cost_usd) AS cost_usd
     FROM usage_rollups
     WHERE ${conditions.join(" AND ")}
     GROUP BY day ORDER BY day ASC`,
  )
    .bind(...params)
    .all<SummaryRow>();

  const buckets = new Map<string, SummaryRow>();
  for (const row of rows.results) {
    const period = groupBy === "day" ? row.day : groupBy === "week" ? weekKey(row.day) : row.day.slice(0, 7);
    const existing = buckets.get(period);
    if (existing === undefined) {
      buckets.set(period, { ...row, day: period });
      continue;
    }
    existing.requests += row.requests;
    existing.errors += row.errors;
    existing.input_tokens += row.input_tokens;
    existing.output_tokens += row.output_tokens;
    existing.cached_tokens += row.cached_tokens;
    existing.reasoning_tokens += row.reasoning_tokens;
    existing.total_tokens += row.total_tokens;
    existing.cost_usd += row.cost_usd;
  }

  const data = [...buckets.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((row) => ({
      period: row.day,
      requests: row.requests,
      errors: row.errors,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
      reasoningTokens: row.reasoning_tokens,
      totalTokens: row.total_tokens,
      costUsd: Math.round(row.cost_usd * 1e8) / 1e8,
    }));

  const totals = data.reduce(
    (acc, bucket) => ({
      requests: acc.requests + bucket.requests,
      errors: acc.errors + bucket.errors,
      inputTokens: acc.inputTokens + bucket.inputTokens,
      outputTokens: acc.outputTokens + bucket.outputTokens,
      cachedTokens: acc.cachedTokens + bucket.cachedTokens,
      reasoningTokens: acc.reasoningTokens + bucket.reasoningTokens,
      totalTokens: acc.totalTokens + bucket.totalTokens,
      costUsd: Math.round((acc.costUsd + bucket.costUsd) * 1e8) / 1e8,
    }),
    {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  );

  return c.json({ data: { from, to, groupBy, buckets: data, totals } });
}

interface RequestLogRow {
  request_id: string;
  trace_id: string;
  user_id: string | null;
  api_key_id: string | null;
  provider_id: string | null;
  provider_account_id: string | null;
  requested_model: string;
  actual_model: string | null;
  combo_id: string | null;
  source_protocol: string;
  target_protocol: string | null;
  stream: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  usage_source: string;
  estimated_cost: number;
  actual_cost: number;
  started_at: number;
  first_token_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  status: string;
  error_code: string | null;
  http_status: number | null;
  retry_count: number;
  created_at: number;
}

interface RequestLogDetailRow extends RequestLogRow {
  route_trace: string | null;
}

function mapRequest(row: RequestLogRow): Record<string, unknown> {
  return {
    requestId: row.request_id,
    traceId: row.trace_id,
    userId: row.user_id,
    apiKeyId: row.api_key_id,
    providerId: row.provider_id,
    providerAccountId: row.provider_account_id,
    requestedModel: row.requested_model,
    actualModel: row.actual_model,
    comboId: row.combo_id,
    sourceProtocol: row.source_protocol,
    targetProtocol: row.target_protocol,
    stream: row.stream === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    usageSource: row.usage_source,
    estimatedCost: row.estimated_cost,
    actualCost: row.actual_cost,
    startedAt: row.started_at,
    firstTokenAt: row.first_token_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    status: row.status,
    errorCode: row.error_code,
    httpStatus: row.http_status,
    retryCount: row.retry_count,
    createdAt: row.created_at,
  };
}

export async function listRequestsHandler(c: Context<AppEnv>): Promise<Response> {
  const from = dateParam(c.req.query("from"), defaultFrom());
  const to = dateParam(c.req.query("to"), today());
  const rawLimit = Number(c.req.query("limit") ?? "50");
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50, 1), 200);
  const before = Number(c.req.query("before") ?? "0");

  const conditions = ["created_at >= ?", "created_at <= ?"];
  const params: Array<string | number> = [
    Date.parse(`${from}T00:00:00Z`),
    Date.parse(`${to}T23:59:59.999Z`),
  ];
  if (Number.isFinite(before) && before > 0) {
    conditions.push("created_at < ?");
    params.push(before);
  }
  const filters: Array<[string, string | undefined]> = [
    ["user_id", c.req.query("userId")],
    ["api_key_id", c.req.query("apiKeyId")],
    ["provider_id", c.req.query("providerId")],
    ["actual_model", c.req.query("model")],
    ["status", c.req.query("status")],
    ["combo_id", c.req.query("comboId")],
  ];
  for (const [column, value] of filters) {
    if (value !== undefined && value !== "") {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  }

  params.push(limit);
  const rows = await c.env.DB.prepare(
    `SELECT request_id, trace_id, user_id, api_key_id, provider_id, provider_account_id,
            requested_model, actual_model, combo_id, source_protocol, target_protocol, stream,
            input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, usage_source,
            estimated_cost, actual_cost, started_at, first_token_at, finished_at, duration_ms,
            status, error_code, http_status, retry_count, created_at
     FROM request_logs
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC, request_id DESC
     LIMIT ?`,
  )
    .bind(...params)
    .all<RequestLogRow>();

  const data = rows.results.map(mapRequest);
  const last = data[data.length - 1];
  return c.json({
    data,
    nextCursor: data.length === limit && typeof last?.["createdAt"] === "number" ? last["createdAt"] : null,
  });
}

export async function getRequestHandler(c: Context<AppEnv>): Promise<Response> {
  const id = c.req.param("id");
  if (!id) throw new GatewayError({ code: "INVALID_REQUEST", message: "Request id is required" });
  const row = await c.env.DB.prepare("SELECT * FROM request_logs WHERE request_id = ?")
    .bind(id)
    .first<RequestLogDetailRow>();
  if (row === null) throw new GatewayError({ code: "NOT_FOUND", message: "Request not found" });
  return c.json({
    data: {
      ...mapRequest(row),
      routeTrace: (() => {
        if (row.route_trace === null) return null;
        try {
          return JSON.parse(row.route_trace) as unknown;
        } catch {
          return null;
        }
      })(),
    },
  });
}

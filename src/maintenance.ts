import type { GatewayEnv } from "./env";
import { listProviders } from "./config/repository";
import { selectAnyProviderAccount } from "./execution/accounts";
import { syncProviderModels } from "./models/sync";

const DAY_MS = 86_400_000;

interface RetentionRow {
  value: string;
}

interface LogRow {
  request_id: string;
  [key: string]: unknown;
}

async function retentionDays(env: GatewayEnv): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'logging.retention_days'",
  ).first<RetentionRow>();
  if (row === null) return 30;
  try {
    const value = JSON.parse(row.value) as unknown;
    return typeof value === "number" && Number.isFinite(value) && value >= 1
      ? Math.min(Math.trunc(value), 3650)
      : 30;
  } catch {
    return 30;
  }
}

async function deleteByIds(env: GatewayEnv, ids: string[]): Promise<void> {
  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM request_logs WHERE request_id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
}

/** 归档并删除过期请求日志；R2 未绑定时直接删除。 */
async function pruneRequestLogs(env: GatewayEnv, cutoff: number): Promise<number> {
  if (env.ARCHIVE_BUCKET === undefined) {
    const result = await env.DB.prepare("DELETE FROM request_logs WHERE created_at < ?")
      .bind(cutoff)
      .run();
    return result.meta.changes ?? 0;
  }

  let deleted = 0;
  for (let batch = 0; batch < 20; batch += 1) {
    const rows = await env.DB.prepare(
      "SELECT * FROM request_logs WHERE created_at < ? ORDER BY created_at ASC LIMIT 1000",
    )
      .bind(cutoff)
      .all<LogRow>();
    if (rows.results.length === 0) break;

    const body = rows.results.map((row) => JSON.stringify(row)).join("\n");
    const key = `archive/requests/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${batch}.jsonl`;
    await env.ARCHIVE_BUCKET.put(key, body, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });

    const ids = rows.results.map((row) => row.request_id);
    await deleteByIds(env, ids);
    deleted += ids.length;
    if (rows.results.length < 1000) break;
  }
  return deleted;
}

/**
 * 可选的定时模型同步：仅处理 extraConfig.autoSyncModels=true 的 Provider。
 * 新模型默认禁用，需管理员确认能力。
 */
async function autoSyncModels(env: GatewayEnv): Promise<void> {
  const providers = (await listProviders(env.DB))
    .filter((provider) => provider.enabled && provider.extraConfig["autoSyncModels"] === true)
    .slice(0, 20);
  for (const provider of providers) {
    try {
      const { apiKey } = await selectAnyProviderAccount(env, provider.id);
      const result = await syncProviderModels(env, provider, apiKey, (input, init) => fetch(input, init));
      console.log(
        JSON.stringify({
          level: "info",
          msg: "maintenance.models_synced",
          provider: provider.name,
          total: result.total,
          created: result.created,
          skipped: result.skipped,
          autoEnabled: result.autoEnabled,
          catalog: result.metadata.catalog,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "maintenance.model_sync_failed",
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/**
 * 定时维护：可选模型同步、按保留期清理请求日志（可归档到 R2），并裁剪过旧汇总。
 */
export async function handleScheduled(
  _controller: ScheduledController,
  env: GatewayEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const days = await retentionDays(env);
  const cutoff = Date.now() - days * DAY_MS;
  try {
    await autoSyncModels(env);
    const deleted = await pruneRequestLogs(env, cutoff);
    await env.DB.prepare("DELETE FROM usage_rollups WHERE day < date('now', '-365 days')").run();
    console.log(
      JSON.stringify({
        level: "info",
        msg: "maintenance.completed",
        retentionDays: days,
        deletedRequests: deleted,
        archived: env.ARCHIVE_BUCKET !== undefined,
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "maintenance.failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

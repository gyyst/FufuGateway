import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError } from "../../core/errors";
import { loadConfigData } from "../../config/repository";
import {
  getConfigStatus,
  listConfigVersions,
  publishConfig,
  rollbackConfig,
} from "../../config/snapshot";
import { validateSnapshot } from "../../config/validate";
import { isPrivateUpstreamAllowed } from "../../security/ssrf";
import { configPublishSchema, configRollbackSchema } from "../schemas";
import { currentActorId, parseAdminBody, recordAudit } from "../shared";

export async function currentConfigHandler(c: Context<AppEnv>): Promise<Response> {
  return c.json({ data: await getConfigStatus(c.env) });
}

export async function validateConfigHandler(c: Context<AppEnv>): Promise<Response> {
  const data = await loadConfigData(c.env.DB);
  const issues = validateSnapshot(data, {
    allowPrivateUpstreams: isPrivateUpstreamAllowed(c.env),
  });
  return c.json({
    data: {
      valid: !issues.some((issue) => issue.severity === "error"),
      errorCount: issues.filter((issue) => issue.severity === "error").length,
      warningCount: issues.filter((issue) => issue.severity === "warning").length,
      issues,
    },
  });
}

export async function publishConfigHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, configPublishSchema);
  const result = await publishConfig(c.env, {
    createdBy: currentActorId(c),
    note: input.note,
  });
  await recordAudit(c, "config.publish", "config", String(result.version), {
    checksum: result.checksum,
    unchanged: result.unchanged,
  });
  return c.json({ data: result }, result.unchanged ? 200 : 201);
}

export async function listConfigVersionsHandler(c: Context<AppEnv>): Promise<Response> {
  const raw = Number(c.req.query("limit") ?? "50");
  const limit = Number.isFinite(raw) ? raw : 50;
  return c.json({ data: await listConfigVersions(c.env.DB, limit) });
}

export async function rollbackConfigHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, configRollbackSchema);
  const result = await rollbackConfig(c.env, input.version, { createdBy: currentActorId(c) });
  await recordAudit(c, "config.rollback", "config", String(result.version), {
    checksum: result.checksum,
  });
  return c.json({ data: result });
}

interface AuditRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  created_at: number;
}

export async function listAuditLogsHandler(c: Context<AppEnv>): Promise<Response> {
  const raw = Number(c.req.query("limit") ?? "50");
  const limit = Math.min(Math.max(Number.isFinite(raw) ? Math.trunc(raw) : 50, 1), 200);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?",
  )
    .bind(limit)
    .all<AuditRow>();
  return c.json({
    data: rows.results.map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: (() => {
        if (row.details === null) return null;
        try {
          return JSON.parse(row.details) as unknown;
        } catch {
          return null;
        }
      })(),
      createdAt: row.created_at,
    })),
  });
}

export async function adminHealthHandler(c: Context<AppEnv>): Promise<Response> {
  const startedAt = Date.now();
  let dbOk = true;
  try {
    await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  } catch {
    dbOk = false;
  }
  let configStatus;
  try {
    configStatus = await getConfigStatus(c.env);
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    configStatus = { error: error.publicMessage };
  }
  return c.json({
    status: dbOk ? "ok" : "degraded",
    db: dbOk,
    config: configStatus,
    latencyMs: Date.now() - startedAt,
  });
}

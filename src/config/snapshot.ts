import { GatewayError } from "../core/errors";
import type { GatewayEnv } from "../env";
import { isPrivateUpstreamAllowed } from "../security/ssrf";
import { clearConfigCache } from "./cache";
import { CONFIG_CURRENT_KEY, CONFIG_PREVIOUS_KEY, configSnapshotKey } from "./keys";
import { loadConfigData } from "./repository";
import { computeChecksum } from "./runtime";
import type { ConfigSnapshot, ConfigValidationIssue } from "./types";
import { configErrorFromIssues, validateSnapshot } from "./validate";

interface ConfigVersionRow {
  version: number;
  checksum: string;
  payload: string;
  status: string;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

export interface PublishOptions {
  createdBy?: string;
  note?: string;
  allowPrivateUpstreams?: boolean;
}

export interface PublishResult {
  version: number;
  checksum: string;
  issues: ConfigValidationIssue[];
  unchanged: boolean;
}

export interface ConfigVersionSummary {
  version: number;
  checksum: string;
  status: string;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
  sizeBytes: number;
}

export async function readActiveVersion(env: GatewayEnv): Promise<number | undefined> {
  const raw = await env.CONFIG_KV.get(CONFIG_CURRENT_KEY);
  if (raw === null) return undefined;
  const version = Number(raw);
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

async function getVersionRow(db: D1Database, version: number): Promise<ConfigVersionRow | undefined> {
  const row = await db
    .prepare("SELECT * FROM config_versions WHERE version = ?")
    .bind(version)
    .first<ConfigVersionRow>();
  return row === null ? undefined : row;
}

/**
 * 校验 D1 中的当前配置并发布新版本。
 * 写入顺序：D1 版本记录 → KV 快照 → KV 当前指针（原子切换）。
 */
export async function publishConfig(env: GatewayEnv, options: PublishOptions = {}): Promise<PublishResult> {
  const data = await loadConfigData(env.DB);
  const issues = validateSnapshot(data, {
    allowPrivateUpstreams: options.allowPrivateUpstreams ?? isPrivateUpstreamAllowed(env),
  });
  if (issues.some((entry) => entry.severity === "error")) {
    throw configErrorFromIssues(issues);
  }

  const checksum = await computeChecksum(data);
  const activeVersion = await readActiveVersion(env);
  if (activeVersion !== undefined) {
    const activeRow = await getVersionRow(env.DB, activeVersion);
    if (activeRow?.checksum === checksum) {
      return { version: activeVersion, checksum, issues, unchanged: true };
    }
  }

  const nextRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM config_versions",
  ).first<{ next: number }>();
  const version = nextRow?.next ?? 1;
  const snapshot: ConfigSnapshot = {
    version,
    checksum,
    createdAt: Date.now(),
    ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
    data,
  };
  const payload = JSON.stringify(snapshot);

  await env.DB.prepare(
    `INSERT INTO config_versions (version, checksum, payload, status, note, created_by, created_at)
     VALUES (?, ?, ?, 'published', ?, ?, ?)`,
  )
    .bind(version, checksum, payload, options.note ?? null, options.createdBy ?? null, snapshot.createdAt)
    .run();

  try {
    await env.CONFIG_KV.put(configSnapshotKey(version), payload);
    if (activeVersion !== undefined) {
      await env.CONFIG_KV.put(CONFIG_PREVIOUS_KEY, String(activeVersion));
    }
    await env.CONFIG_KV.put(CONFIG_CURRENT_KEY, String(version));
  } catch (error) {
    await env.DB.prepare("UPDATE config_versions SET status = 'failed' WHERE version = ?").bind(version).run();
    throw new GatewayError({
      code: "INTERNAL_ERROR",
      message: "Failed to publish configuration snapshot",
      retriable: true,
      cause: error,
    });
  }

  await env.DB.prepare(
    "UPDATE config_versions SET status = 'superseded' WHERE status = 'published' AND version <> ?",
  )
    .bind(version)
    .run();

  clearConfigCache();
  return { version, checksum, issues, unchanged: false };
}

/** 回滚到历史版本（重新校验并原子切换指针）。 */
export async function rollbackConfig(
  env: GatewayEnv,
  version: number,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const row = await getVersionRow(env.DB, version);
  if (row === undefined) {
    throw new GatewayError({ code: "NOT_FOUND", message: `Config version ${version} not found` });
  }
  let snapshot: ConfigSnapshot;
  try {
    snapshot = JSON.parse(row.payload) as ConfigSnapshot;
  } catch {
    throw new GatewayError({ code: "CONFIG_INVALID", message: `Config version ${version} payload is corrupted` });
  }
  const issues = validateSnapshot(snapshot.data, {
    allowPrivateUpstreams: options.allowPrivateUpstreams ?? isPrivateUpstreamAllowed(env),
  });
  if (issues.some((entry) => entry.severity === "error")) {
    throw configErrorFromIssues(issues);
  }

  const activeVersion = await readActiveVersion(env);
  await env.CONFIG_KV.put(configSnapshotKey(version), row.payload);
  if (activeVersion !== undefined) {
    await env.CONFIG_KV.put(CONFIG_PREVIOUS_KEY, String(activeVersion));
  }
  await env.CONFIG_KV.put(CONFIG_CURRENT_KEY, String(version));

  if (activeVersion !== undefined && activeVersion !== version) {
    await env.DB.prepare(
      "UPDATE config_versions SET status = 'rolled_back' WHERE version = ? AND status = 'published'",
    )
      .bind(activeVersion)
      .run();
  }
  await env.DB.prepare("UPDATE config_versions SET status = 'published' WHERE version = ?")
    .bind(version)
    .run();

  clearConfigCache();
  return { version, checksum: snapshot.checksum, issues, unchanged: false };
}

export async function listConfigVersions(db: D1Database, limit = 50): Promise<ConfigVersionSummary[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const rows = await db
    .prepare(
      `SELECT version, checksum, status, note, created_by, created_at, length(payload) AS size_bytes
       FROM config_versions ORDER BY version DESC LIMIT ?`,
    )
    .bind(safeLimit)
    .all<{
      version: number;
      checksum: string;
      status: string;
      note: string | null;
      created_by: string | null;
      created_at: number;
      size_bytes: number;
    }>();
  return rows.results.map((row) => ({
    version: row.version,
    checksum: row.checksum,
    status: row.status,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    sizeBytes: row.size_bytes,
  }));
}

export interface ConfigStatus {
  activeVersion: number | null;
  activeChecksum: string | null;
  activeCreatedAt: number | null;
  pendingChecksum: string | null;
  pendingChanges: boolean;
  validation: { valid: boolean; issues: ConfigValidationIssue[] } | null;
}

/** 管理端：查看当前生效版本与 D1 草稿是否存在待发布变更。 */
export async function getConfigStatus(env: GatewayEnv): Promise<ConfigStatus> {
  const activeVersion = await readActiveVersion(env);
  const activeRow = activeVersion === undefined ? undefined : await getVersionRow(env.DB, activeVersion);

  let pendingChecksum: string | null = null;
  let validation: ConfigStatus["validation"] = null;
  try {
    const data = await loadConfigData(env.DB);
    const issues = validateSnapshot(data, {
      allowPrivateUpstreams: isPrivateUpstreamAllowed(env),
    });
    pendingChecksum = await computeChecksum(data);
    validation = { valid: !issues.some((entry) => entry.severity === "error"), issues };
  } catch (error) {
    validation = {
      valid: false,
      issues: [
        {
          severity: "error",
          code: error instanceof GatewayError ? error.code : "CONFIG_INVALID",
          message: error instanceof Error ? error.message : "Failed to load configuration",
        },
      ],
    };
  }

  return {
    activeVersion: activeVersion ?? null,
    activeChecksum: activeRow?.checksum ?? null,
    activeCreatedAt: activeRow?.created_at ?? null,
    pendingChecksum,
    pendingChanges: activeRow === undefined || pendingChecksum !== activeRow.checksum,
    validation,
  };
}

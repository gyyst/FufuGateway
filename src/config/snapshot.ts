import { GatewayError } from "../core/errors";
import type { GatewayEnv } from "../env";
import { isPrivateUpstreamAllowed } from "../security/ssrf";
import { clearConfigCache } from "./cache";
import { CONFIG_CURRENT_KEY, CONFIG_PREVIOUS_KEY, configSnapshotKey } from "./keys";
import { loadConfigData, restoreConfigData } from "./repository";
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

export interface AutoPublishOptions {
  createdBy?: string;
  /** 触发自动发布的操作名，写入版本 note：`auto:<reason>`。 */
  reason: string;
}

/** 配置写入后的自动发布结果，作为响应顶层 `config` 字段返回。 */
export interface AutoPublishResult {
  applied: boolean;
  unchanged: boolean;
  version: number | null;
  checksum: string | null;
  issues: ConfigValidationIssue[];
  error?: { code: string; message: string };
}

const MAX_AUTO_PUBLISH_ISSUES = 50;

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

function capIssues(issues: ConfigValidationIssue[]): ConfigValidationIssue[] {
  return issues.slice(0, MAX_AUTO_PUBLISH_ISSUES);
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof GatewayError) return { code: error.code, message: error.publicMessage };
  return { code: "INTERNAL_ERROR", message: "Failed to publish configuration" };
}

function issuesFromError(error: unknown): ConfigValidationIssue[] {
  if (!(error instanceof GatewayError)) return [];
  const issues = error.details?.["issues"];
  return Array.isArray(issues) ? capIssues(issues as ConfigValidationIssue[]) : [];
}

async function activeVersionOrNull(env: GatewayEnv): Promise<number | null> {
  try {
    return (await readActiveVersion(env)) ?? null;
  } catch {
    return null;
  }
}

function logAutoPublishFailure(reason: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "config.auto_publish_failed",
      reason,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * 配置写入后自动发布：先校验 D1 当前配置，存在 error 时保留旧生效版本，
 * 不生成新版本；合法时复用 publishConfig 完成版本、KV 与缓存切换。
 * 任何失败都不会抛给调用方，而是通过返回值暴露给管理端。
 */
export async function autoPublish(env: GatewayEnv, options: AutoPublishOptions): Promise<AutoPublishResult> {
  let issues: ConfigValidationIssue[];
  try {
    const data = await loadConfigData(env.DB);
    issues = validateSnapshot(data, {
      allowPrivateUpstreams: isPrivateUpstreamAllowed(env),
    });
  } catch (error) {
    logAutoPublishFailure(options.reason, error);
    return {
      applied: false,
      unchanged: false,
      version: await activeVersionOrNull(env),
      checksum: null,
      issues: [],
      error: describeError(error),
    };
  }

  const capped = capIssues(issues);
  if (issues.some((entry) => entry.severity === "error")) {
    return {
      applied: false,
      unchanged: false,
      version: await activeVersionOrNull(env),
      checksum: null,
      issues: capped,
    };
  }

  try {
    const result = await publishConfig(env, {
      createdBy: options.createdBy,
      note: `auto:${options.reason}`,
    });
    return {
      applied: true,
      unchanged: result.unchanged,
      version: result.version,
      checksum: result.checksum,
      issues: capIssues(result.issues),
    };
  } catch (error) {
    logAutoPublishFailure(options.reason, error);
    const errorIssues = issuesFromError(error);
    return {
      applied: false,
      unchanged: false,
      version: await activeVersionOrNull(env),
      checksum: null,
      issues: errorIssues.length === 0 ? capped : errorIssues,
      error: describeError(error),
    };
  }
}

/**
 * 回滚到历史版本：先恢复 D1 配置表，再切换 KV 快照与当前指针。
 * 自动发布后 D1 是配置源，只切 KV 会在下一次保存时被覆盖，因此必须同时恢复 D1。
 */
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
  if ((snapshot.data.aliases?.length ?? 0) > 0 || (snapshot.data.wildcards?.length ?? 0) > 0) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Config version ${version} contains legacy aliases or wildcards that cannot be restored`,
    });
  }
  const issues = validateSnapshot(snapshot.data, {
    allowPrivateUpstreams: options.allowPrivateUpstreams ?? isPrivateUpstreamAllowed(env),
  });
  if (issues.some((entry) => entry.severity === "error")) {
    throw configErrorFromIssues(issues);
  }

  try {
    await restoreConfigData(env.DB, snapshot.data);
  } catch (error) {
    throw new GatewayError({
      code: "INTERNAL_ERROR",
      message: "Failed to restore configuration data",
      retriable: true,
      cause: error,
    });
  }

  let activeVersion: number | undefined;
  try {
    activeVersion = await readActiveVersion(env);
    await env.CONFIG_KV.put(configSnapshotKey(version), row.payload);
    if (activeVersion !== undefined && activeVersion !== version) {
      await env.CONFIG_KV.put(CONFIG_PREVIOUS_KEY, String(activeVersion));
    }
    await env.CONFIG_KV.put(CONFIG_CURRENT_KEY, String(version));
  } catch (error) {
    throw new GatewayError({
      code: "INTERNAL_ERROR",
      message: "Failed to switch the active configuration snapshot",
      retriable: true,
      cause: error,
    });
  }

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
  return { version, checksum: snapshot.checksum, issues, unchanged: activeVersion === version };
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

/** 管理端：查看当前生效版本与 D1 当前数据是否存在未同步变更。 */
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
